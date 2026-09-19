// The letter's Send page — server half (2026-09-19): routes/letterSendRoutes + controllers/letterSendController +
// services/letterEmail + emailController's connected-account helpers. No database, no model, no mailbox: every
// dependency is swapped through require.cache, and the provider send is a spy that builds the REAL MIME message.
//   node server/scripts/test-letter-send.js
//
// THE OWNER'S ASK: "a button Send … auto generated subject, auto generated body for that employer, Attachments of that
// cover letter … the resume … use the connected gmail or microsoft account to send the email … add email id and send".
// What these scenarios hold the server to:
//   • the Download's money rule EXACTLY: gate every attachment we render BEFORE rendering, claim only AFTER the provider
//     accepted the message, nothing charged on any failure;
//   • the user's own mailbox or nothing (no SMTP fallback), and a failure that says what to do;
//   • owner + store environment in every read; a résumé for another employer is refused;
//   • recipients validated (CR/LF, >5, junk), the subject UTF-8 encoded in the message, real file names and types;
//   • the email body is FREE — never a credit, never a unit — and never JSON;
//   • the message (to / subject / body) never reaches async_jobs.input, and never reaches a log line.
// And the review's findings (2026-09-19, sections 15–18): a connection dropped AFTER the hand-over is 'unknown_outcome'
// (never "nothing was sent"); the message says only what is attached; a metered two-file send falls through to an
// unspent pass exactly as two Downloads would; a letter stored with a model's JSON is read repaired.
// Each of those fixes, reverted alone in memory (node -r a source-rewriting hook), fails this suite — checked 2026-09-19.
// Source-level assertions run on COMMENT-STRIPPED text (matching your own explanation proves nothing).
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const R = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 400) : '')); } };

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cva-letter-send-')));
// users.resume_path is relative to the app, and uploadedResumeOf refuses any path outside it — so the "uploaded CV"
// fixtures live in a throwaway folder under temp/ (gitignored), removed at the end.
const APP_TMP = path.join(ROOT, 'temp', `test-letter-send-${process.pid}`);
fs.mkdirSync(APP_TMP, { recursive: true });
const writeUploaded = (name, buf) => { const p = path.join(APP_TMP, name); fs.writeFileSync(p, buf); return path.relative(ROOT, p); };
const stub = (rel, exportsObj) => {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return exportsObj;
};

/* ── the world ──────────────────────────────────────────────────────────────────────────────────── */
const events = [];            // ordered: render / send / claim / canDownload — the money order is asserted on this
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const db = { log: [], users: {}, audit: {}, contacts: [], builder: true };
const dbStub = stub('db-config.js', {
  get: async (sql, params = []) => {
    const q = norm(sql); db.log.push({ verb: 'get', sql: q, params });
    if (/FROM users WHERE id/.test(q)) return db.users[params[0]] || null;
    if (/FROM security_audit_log/.test(q)) return db.audit[`${params[0]}|${params[1]}`] ? { email: db.audit[`${params[0]}|${params[1]}`] } : null;
    if (/FROM user_resumes/.test(q)) return db.builder ? { ok: 1 } : null;
    return null;
  },
  query: async (sql, params = []) => {
    const q = norm(sql); db.log.push({ verb: 'query', sql: q, params });
    if (/FROM job_contacts/.test(q)) return db.contacts;
    return [];
  },
  run: async (sql, params = []) => { db.log.push({ verb: 'run', sql: norm(sql), params }); return { changes: 1 }; },
});
void dbStub;

// The store documents — scoped by (user, env, kind) exactly as employerDocs.getById does in its SQL.
const DOCS = [];
const envOfReq = (req) => (req && req.headers && /sandbox/i.test(req.headers['x-store-env'] || '') ? 'Sandbox' : 'Production');
const docsCalls = [];
stub('server/services/employerDocs.js', {
  getById: async (userId, id, reqOrEnv, { kind } = {}) => {
    docsCalls.push({ fn: 'getById', userId, id, kind, env: envOfReq(reqOrEnv) });
    return DOCS.find((d) => d.id === Number(id) && d.user_id === userId && d.environment === envOfReq(reqOrEnv) && (!kind || d.kind === kind)) || null;
  },
  slimById: async (userId, id, reqOrEnv) => DOCS.find((d) => d.id === Number(id) && d.user_id === userId && d.environment === envOfReq(reqOrEnv)) || null,
  currentFor: async (userId, kind, { employer, jobUrl }, reqOrEnv) => {
    docsCalls.push({ fn: 'currentFor', userId, kind, employer, jobUrl, env: envOfReq(reqOrEnv) });
    return DOCS.find((d) => d.user_id === userId && d.kind === kind && d.environment === envOfReq(reqOrEnv)
      && d.employer_name === employer && (d.job_url || '') === (jobUrl || '')) || null;
  },
});

const gate = { allow: true, reason: 'paid_required', via: 'plan_unlimited' };
const claims = [];
const passes = { unbound: 0, ownedSpelling: null };
const resolves = [];          // the candidate lists resolveEmployer was asked (the classic lane, section 20)
const dls = stub('server/services/downloads.js', {
  METERED: false,
  // The real rule's shape: a spelling that already owns a pass wins, else the first non-empty candidate.
  resolveEmployer: async (userId, cands) => {
    const list = (Array.isArray(cands) ? cands : [cands]).map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean);
    resolves.push(list);
    return passes.ownedSpelling && list.some((c) => dls.sameEmployer(c, passes.ownedSpelling)) ? passes.ownedSpelling : (list[0] || null);
  },
  NONE: '(none)',
  envOf: envOfReq,
  unboundPassCount: async () => passes.unbound,
  sameEmployer: (a, b) => String(a || '').toLowerCase().replace(/\s+(se|ag|gmbh)$/, '') === String(b || '').toLowerCase().replace(/\s+(se|ag|gmbh)$/, ''),
  canDownload: async (userId, { employer }) => {
    events.push(`gate:${employer}`);
    return gate.allow ? { allowed: true, via: gate.via } : { allowed: false, reason: gate.reason, message: 'no' };
  },
  claimDownload: async (userId, { employer }) => { events.push(`claim:${employer}`); claims.push(employer); return { via: gate.via, charged: gate.via === 'pass' }; },
});
const histories = [];
stub('server/services/downloadHistory.js', { record: async (u, entry) => { histories.push(entry); return 1; } });
const notices = [];
stub('server/controllers/notificationsController.js', {
  notifyEmailSent: async (...a) => { notices.push(a); },
  notifyError: async () => {}, notifyEmailReply: async () => {},
});
const emits = [];
stub('server/services/track.js', { emit: (req, event, props) => emits.push({ event, props }) });
const ai = { calls: 0, answer: null, throws: null };
stub('server/services/aiText.js', {
  generateText: async (o) => { ai.calls++; ai.last = o; if (ai.throws) throw ai.throws; return { text: ai.answer, model: 'gemini-3.1-flash-lite' }; },
  writing: () => ({ models: ['gemini-3.1-flash-lite'], modelConfig: {} }),
});
const ent = { many: { allowed: true } };
stub('server/services/entitlements.js', { canConsumeMany: async () => ent.many, activeSubscription: async () => null });
const jobs = { created: [], completed: [], failed: [] };
stub('server/services/jobService.js', {
  createJob: async (userId, type, input) => { jobs.created.push({ userId, type, input }); return 'job-1'; },
  startJob: async () => {}, completeJob: async (id, body) => { jobs.completed.push(body); },
  failJob: async (id, msg) => { jobs.failed.push(msg); },
  updateJobProgress: async () => {}, updateJobPartialResult: async () => {},
});

// The renders write REAL files (so cleanup can be asserted) — tagged so the send spy can see which is which.
const render = { letterFails: false, builderNone: false, bigBytes: 0 };
const PDF = (tag, extra = 0) => Buffer.concat([Buffer.from(`%PDF-1.4 ${tag}\n`), Buffer.alloc(extra, 0x20)]);
const written = [];
const writeTemp = (name, buf) => { const p = path.join(TMP, name); fs.writeFileSync(p, buf); written.push(p); return p; };
const letterRecords = [];
const senderPayloads = [];    // every payload senderForLetter was handed (a classic letter must never name a sender)
const classicRenders = [];    // what the classic lane asked the classic Download's render for
stub('server/controllers/coverLetterController.js', {
  withSharedLetterBrand: async (doc) => doc,
  senderForLetter: async (userId, payload) => { senderPayloads.push(payload); return { name: 'Rishi Samadhiya', title: 'Engineer', email: 'rishi@example.com', phone: '+91 99', location: 'Pune, India' }; },
  renderClassicLetterPdf: async (userId, input) => {
    events.push('render:classic');
    classicRenders.push(input);
    if (render.letterFails) throw new Error('chromium died');
    const fileName = `Cover_Letter_classic_${Date.now()}.pdf`;
    const filePath = writeTemp(fileName, PDF('classic letter', render.bigBytes));
    return { fileName, filePath, tplId: input.template || 'standard', mode: input.mode, input: { coverLetterHtml: input.coverLetterHtml, companyName: input.companyName, companyAddress: input.companyAddress, brandColor: null } };
  },
  renderSavedLetterPdf: async (userId, doc, { template, mode }) => {
    events.push('render:letter');
    if (render.letterFails) throw new Error('chromium died');
    const fileName = `Cover_Letter_${doc.id}_${Date.now()}.pdf`;
    const filePath = writeTemp(fileName, PDF('letter', render.bigBytes));
    return { fileName, filePath, tplId: template || 'standard', mode: mode || 'onepage', input: { coverLetterHtml: doc.payload.coverLetterHtml, companyName: doc.payload.companyName, companyAddress: '', brandColor: null } };
  },
  recordLetter: async (userId, req, entry) => { letterRecords.push(entry); },
});
stub('server/controllers/resumeBuilderController.js', {
  loadResumeDoc: async (userId, id, reqOrEnv) => {
    const d = DOCS.find((x) => x.id === Number(id) && x.user_id === userId && x.environment === envOfReq(reqOrEnv) && x.kind === 'resume');
    return d || null;
  },
  renderResumeDocPdf: async (userId, doc) => {
    events.push('render:resume');
    const fileName = `Resume_${doc.id}_${Date.now()}.pdf`;
    return { fileName, filePath: writeTemp(fileName, PDF('resume', render.bigBytes)), template: 'azure', mode: 'onepage' };
  },
  buildResumePdfForRegion: async () => {
    events.push('render:builder');
    if (render.builderNone) return null;
    const fileName = `Builder_${Date.now()}.pdf`;
    return { fileName, filePath: writeTemp(fileName, PDF('builder')), template: 'minimal' };
  },
  resumeDocDefaultsOf: () => ({ template: 'azure', templateName: 'Azure', mode: 'onepage' }),
});

// emailController: its REAL helpers (loaded against the stubs above), with only the provider send swapped for a spy.
const realEmail = require(path.join(ROOT, 'server/controllers/emailController.js'));
const sends = [];
const provider = { throws: null };
stub('server/controllers/emailController.js', {
  ...realEmail,
  sendWithConnectedAccount: async (user, msg) => {
    events.push('send');
    const acct = realEmail.mailAccountOf(user);
    if (!acct.ready) { const e = new Error('No connected mail account'); e.mailReason = acct.provider ? 'reconnect' : 'no_mail_account'; throw e; }
    if (provider.throws) throw provider.throws;
    const mime = (await realEmail.buildMimeMessage(msg)).toString('latin1');
    sends.push({ user, msg, mime, provider: acct.provider });
    return { provider: acct.provider, id: 'm1' };
  },
});

const C = require(path.join(ROOT, 'server/controllers/letterSendController.js'));
const routes = require(path.join(ROOT, 'server/routes/letterSendRoutes.js'));
const mail = require(path.join(ROOT, 'server/services/letterEmail.js'));
const { authenticateToken } = require(path.join(ROOT, 'server/middleware/auth.js'));

/* ── plumbing ───────────────────────────────────────────────────────────────────────────────────── */
const LETTER_HTML = '<p>Dear Hiring Team,</p><p>I build <strong>resilient payment systems</strong> and cut settlement time by 40%.</p><p>Kind regards</p>';
function resetWorld() {
  events.length = 0; sends.length = 0; claims.length = 0; histories.length = 0; notices.length = 0; emits.length = 0;
  letterRecords.length = 0; docsCalls.length = 0; db.log.length = 0; written.length = 0;
  jobs.created.length = 0; jobs.completed.length = 0; jobs.failed.length = 0;
  gate.allow = true; gate.via = 'plan_unlimited'; gate.reason = 'paid_required';
  render.letterFails = false; render.builderNone = false; render.bigBytes = 0;
  provider.throws = null; ai.calls = 0; ai.answer = null; ai.throws = null; ent.many = { allowed: true };
  dls.METERED = false; passes.unbound = 0; passes.ownedSpelling = null; resolves.length = 0;
  senderPayloads.length = 0; classicRenders.length = 0;
  C._internals.sendCalls.clear(); C._internals.bodyCalls.clear();
  db.builder = true; db.contacts = [];
  db.users = {
    1: { id: 1, email: 'rishi@gmail.com', full_name: 'Rishi Samadhiya', oauth_provider: 'google', google_access_token: 'enc-a', google_refresh_token: 'enc-r', resume_path: null },
    2: { id: 2, email: 'apple@privaterelay.appleid.com', full_name: 'Apple User', oauth_provider: 'apple', resume_path: null },
    3: { id: 3, email: 'x@outlook.com', full_name: 'Ms Outlook', oauth_provider: 'microsoft', microsoft_access_token: 'enc', microsoft_refresh_token: 'enc-r' },
    4: { id: 4, email: 'lost@gmail.com', full_name: 'Lost Token', oauth_provider: 'google', google_access_token: null, google_refresh_token: null },
  };
  db.audit = { '1|google': 'rishi.work@gmail.com' };
  DOCS.length = 0;
  DOCS.push(
    { id: 12, user_id: 1, kind: 'cover_letter', environment: 'Production', employer_name: 'Nordex', employer_id: '622a766e-afba-4ff8-8d97-34116d272835', job_url: '', job_title: '',
      updated_at: new Date('2026-09-19T10:00:00Z'), payload: { coverLetterHtml: LETTER_HTML, subject: 'Application for Inspecteur Qualité A350 — Rishi Samadhiya', companyName: 'Nordex SE', position: 'Inspecteur Qualité A350' } },
    { id: 13, user_id: 1, kind: 'cover_letter', environment: 'Sandbox', employer_name: 'Airbus', employer_id: null, job_url: 'https://jobs.airbus.com/1', job_title: 'Cyber Security Manager',
      updated_at: new Date(), payload: { coverLetterHtml: LETTER_HTML, subject: '', companyName: 'Airbus', position: 'Cyber Security Manager' } },
    { id: 30, user_id: 1, kind: 'resume', environment: 'Production', employer_name: 'Nordex', job_url: '', payload: { personal_info: { full_name: 'Rishi' } } },
    { id: 31, user_id: 1, kind: 'resume', environment: 'Production', employer_name: 'Siemens', job_url: '', payload: { personal_info: { full_name: 'Rishi' } } },
    { id: 40, user_id: 3, kind: 'cover_letter', environment: 'Production', employer_name: 'Nordex', job_url: '', updated_at: new Date(), payload: { coverLetterHtml: LETTER_HTML, subject: 'Hi', companyName: 'Nordex', position: 'Engineer' } },
    { id: 41, user_id: 4, kind: 'cover_letter', environment: 'Production', employer_name: 'Nordex', job_url: '', updated_at: new Date(), payload: { coverLetterHtml: LETTER_HTML, subject: 'Hi', companyName: 'Nordex', position: 'Engineer' } },
    { id: 42, user_id: 2, kind: 'cover_letter', environment: 'Production', employer_name: 'Nordex', job_url: '', updated_at: new Date(), payload: { coverLetterHtml: LETTER_HTML, subject: 'Hi', companyName: 'Nordex', position: 'Engineer' } },
  );
}
function mkRes() {
  const r = { statusCode: 200, body: undefined };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.set = () => r; r.setHeader = () => r; r.header = () => r; r.type = () => r;
  return r;
}
const reqOf = (userId, id, body = {}, headers = {}) => ({ user: { id: userId }, params: { id: String(id) }, body, headers, query: {} });
/** The send route as mounted: holdMailFields → asJob('letter_email')(sendLetterEmail). */
const sendLayer = routes.stack.find((l) => l.route && l.route.path === '/:id/send');
async function send(userId, id, body, headers) {
  const req = reqOf(userId, id, { ...body }, headers);
  const res = mkRes();
  // Every layer after authenticateToken, in order, each awaited (holdMailFields calls next() synchronously).
  for (const h of sendLayer.route.stack.map((s) => s.handle).slice(1)) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return { req, res };
}
const BASE = { to: ['recruiter@nordex-online.com'], subject: 'Application for Inspecteur Qualité A350 — Rishi Samadhiya', body: 'Dear Hiring Team,\n\nPlease find my letter attached.\n\nBest regards,\nRishi', template: 'exec_leader', mode: 'onepage', letter: { source: 'doc' }, resume: { source: 'tailored', docId: 30 } };
const liveTemps = () => written.filter((p) => fs.existsSync(p));
const settle = () => new Promise((r) => setTimeout(r, 30));
/**
 * ⚠️ WAIT FOR THE JOB, NOT FOR A CLOCK (2026-09-20). The async lane answers 202 and runs the send DETACHED (asJob), and
 * its first run pays for lazy requires (the MIME builder, letterText) — a fixed 30 ms lost that race on every run here,
 * and the late job then pushed its send into the NEXT section's world (section 3 read the job's recipient as its own).
 * So: poll until the job settled — completeJob / failJob, or asJob's own failJobWithReason UPDATE — then one settle()
 * for the handler's `finally` (the temp-file unlinks). Resolves false after `ms` so a hung job fails its assertions.
 */
const jobSettled = () => jobs.completed.length > 0 || jobs.failed.length > 0
  || db.log.some((x) => /UPDATE async_jobs SET status = 'failed'/.test(x.sql));
async function settleJob(ms = 10000) {
  const until = Date.now() + ms;
  while (!jobSettled() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  await settle();
  return jobSettled();
}

(async () => {
  resetWorld();

  console.log('── 1. the routes: all eight behind sign-in; Send is a minimise-safe job that never stores the message ──');
  {
    const layers = routes.stack.filter((l) => l.route);
    const paths = layers.map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
    // The four for a saved letter, and (2026-09-20) the same four for a classic one — registered FIRST (section 20).
    ok('exactly the eight routes, the classic ones first', JSON.stringify(paths) === JSON.stringify([
      'post /classic/email-draft', 'post /classic/email-body', 'post /classic/send-files', 'post /classic/send',
      'get /:id/email-draft', 'post /:id/email-body', 'post /:id/send-files', 'post /:id/send']), paths);
    ok('⚠️ every route runs authenticateToken FIRST', layers.every((l) => l.route.stack[0].handle === authenticateToken));
    const sendHandlers = sendLayer.route.stack.map((s) => s.handle);
    ok('Send: holdMailFields, then the asJob wrapper', sendHandlers[1] === routes.holdMailFields && sendHandlers[2].name === 'asJobHandler', sendHandlers.map((h) => h.name));
    ok('server.js mounts it beside the (charge-free) employer-docs router',
      /app\.use\('\/api\/employer-docs', require\('\.\/server\/routes\/letterSendRoutes'\)\)/.test(strip(R('server.js'))));
    ok('⚠️ employerDocsRoutes stays read/edit only — no gate, no claim, no mail in it',
      !/claimDownload|canDownload|letterSend|sendWithConnectedAccount|asJob\(/.test(strip(R('server/routes/employerDocsRoutes.js'))));
  }
  {
    // The async lane: the job row's input must not carry the recipients, the subject or the body.
    const { res } = await send(1, 12, { ...BASE, __async: true, clientBuildId: 'ls-abc' });
    const settled = await settleJob();
    const input = jobs.created[0] && jobs.created[0].input;
    ok('the async lane answers 202 with a job id', res.statusCode === 202 && res.body.jobId === 'job-1', res.body);
    ok('…and the detached job settles (waited for, not timed)', settled);
    ok('⚠️ async_jobs.input has NO to / subject / body', !!input && !('to' in input) && !('subject' in input) && !('body' in input), input);
    ok('…but keeps clientBuildId, which is what dedupes a retried Send', input && input.clientBuildId === 'ls-abc');
    ok('…and the job still sent the message it was given (held on the request)', sends.length === 1 && sends[0].msg.to[0] === 'recruiter@nordex-online.com');
    ok('the job completed with the success body', jobs.completed.length === 1 && jobs.completed[0].success === true, jobs.completed);
    ok('⚠️ …and that stored result names no recipient address (a count only)', jobs.completed[0] && jobs.completed[0].recipients === 1
      && !JSON.stringify(jobs.completed[0]).includes('recruiter@'), jobs.completed[0]);
  }

  console.log('── 2. owner + store environment: a letter from another env, user or kind is "gone" ──');
  resetWorld();
  {
    const a = await send(1, 13, BASE);                                   // a Sandbox letter asked for from Production
    ok('⚠️ a Sandbox letter is not found from a Production request → 404 gone', a.res.statusCode === 404 && a.res.body.reason === 'gone', a.res.body);
    const b = await send(1, 13, { ...BASE, resume: { source: 'none' } }, { 'x-store-env': 'Sandbox' });
    ok('…and found from a Sandbox (TestFlight) request', b.res.statusCode === 200, b.res.body);
    const c = await send(1, 40, BASE);                                   // user 3's letter
    ok('⚠️ another user\'s letter id → 404 gone', c.res.statusCode === 404 && c.res.body.reason === 'gone');
    const d = await send(1, 30, BASE);                                   // a résumé id
    ok('a résumé id is not a letter → 404 gone', d.res.statusCode === 404);
    ok('every letter read asked for kind cover_letter, scoped by user', docsCalls.filter((x) => x.fn === 'getById').every((x) => x.kind === 'cover_letter' && x.userId === 1));
  }

  console.log('── 3. recipients: validated, refused whole, never split or trimmed into something else ──');
  resetWorld();
  for (const [name, to] of [
    ['junk', ['not-an-email']],
    ['⚠️ a header injection (CR/LF + Bcc)', ['a@b.com\r\nBcc: spy@evil.com']],
    ['a pasted list inside one entry', ['a@b.com, c@d.com']],
    ['six addresses', ['a@a.com', 'b@b.com', 'c@c.com', 'd@d.com', 'e@e.com', 'f@f.com']],
    ['nothing', []],
    ['not a list of strings', [42]],
  ]) {
    const { res } = await send(1, 12, { ...BASE, to });
    ok(`${name} → 400 bad_recipients`, res.statusCode === 400 && res.body.reason === 'bad_recipients', res.body);
  }
  ok('⚠️ …and none of them rendered, sent or charged anything', events.length === 0 && sends.length === 0 && claims.length === 0, events);
  {
    const { res } = await send(1, 12, { ...BASE, to: ['HR@nordex.com', 'hr@nordex.com', ' boss@nordex.com '] });
    ok('duplicates (any case) collapse and spaces are trimmed', res.statusCode === 200 && JSON.stringify(sends[0].msg.to) === JSON.stringify(['HR@nordex.com', 'boss@nordex.com']), sends[0] && sends[0].msg.to);
    ok('the MIME To line carries both addresses', /^To: HR@nordex\.com, boss@nordex\.com/m.test(sends[0].mime));
  }
  {
    resetWorld();
    const s1 = await send(1, 12, { ...BASE, subject: '   ' });
    ok('an empty subject → 400 bad_subject', s1.res.statusCode === 400 && s1.res.body.reason === 'bad_subject');
    const s2 = await send(1, 12, { ...BASE, subject: 'x'.repeat(301) });
    ok('⚠️ a subject over 300 characters is refused, not cut', s2.res.statusCode === 400 && s2.res.body.reason === 'bad_subject');
    const s3 = await send(1, 12, { ...BASE, body: '' });
    ok('an empty message → 400 bad_body', s3.res.statusCode === 400 && s3.res.body.reason === 'bad_body');
    const s4 = await send(1, 12, { ...BASE, resume: { source: 'somewhere' } });
    ok('an attachment shape we do not know → 400 bad_request', s4.res.statusCode === 400 && s4.res.body.reason === 'bad_request');
    ok('…nothing rendered for any of them', events.length === 0);
  }

  console.log('── 4. ⚠️ the user\'s OWN mailbox, or nothing ──');
  resetWorld();
  {
    const { res } = await send(2, 42, BASE);
    ok('an Apple-only account → 409 no_mail_account', res.statusCode === 409 && res.body.reason === 'no_mail_account', res.body);
    ok('…telling them to connect, and that nothing was sent or charged', /Connect Gmail or Outlook/.test(res.body.error) && /Nothing was sent and nothing was charged/.test(res.body.error));
    ok('⚠️ …before any render, gate, send or claim', events.length === 0 && claims.length === 0);
    const r4 = await send(4, 41, BASE);
    ok('a Google account whose tokens were cleared → 409 reconnect (not "connected")', r4.res.statusCode === 409 && r4.res.body.reason === 'reconnect' && r4.res.body.provider === 'google', r4.res.body);
    ok('⚠️ the controller has no SMTP / ZeptoMail fallback', !/sendEmailViaZeptoMail|createTransporter|smtp_/i.test(strip(R('server/controllers/letterSendController.js'))));
  }

  console.log('── 5. ⚠️ the Download rule: gated BEFORE rendering, refused → nothing happens ──');
  resetWorld();
  {
    gate.allow = false;
    const { res } = await send(1, 12, BASE);
    ok('a locked account → 403 paid_required, naming the attachment', res.statusCode === 403 && res.body.reason === 'paid_required' && res.body.which === 'letter', res.body);
    ok('⚠️ nothing was rendered, sent or claimed', !events.some((e) => /^render|^send|^claim/.test(e)) && sends.length === 0 && claims.length === 0, events);
    ok('…and the error says so', /Nothing was sent and nothing was charged/.test(res.body.error));
    gate.allow = false; gate.reason = 'quota_exhausted';
    const q = await send(1, 12, BASE);
    ok('a metered plan out of downloads → 403 quota_exhausted (the paywall opens on the phone)', q.res.statusCode === 403 && q.res.body.reason === 'quota_exhausted');
  }
  resetWorld();
  {
    await send(1, 12, BASE);
    ok('⚠️ the letter is gated against ITS employer, the tailored résumé against its own — before any render',
      events.slice(0, 2).join(',') === 'gate:Nordex,gate:Nordex' && events.indexOf('render:letter') > 1, events);
    resetWorld();
    await send(1, 12, { ...BASE, resume: { source: 'builder' } });
    ok('the Builder résumé (which we render) is gated against the letter\'s employer', events.filter((e) => e.startsWith('gate:')).length === 2 && events.includes('render:builder'), events);
    resetWorld();
    db.users[1].resume_path = writeUploaded('uploaded_cv.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
    const up = await send(1, 12, { ...BASE, resume: { source: 'uploaded' } });
    ok('⚠️ the user\'s OWN uploaded CV is their bytes — not gated, not claimed', up.res.statusCode === 200
      && events.filter((e) => e.startsWith('gate:')).length === 1 && claims.length === 1, events);
    const cv = sends[0] && sends[0].msg.attachments.find((a) => /Resume/.test(a.filename));
    ok('…and it goes out as a WORD file, named and typed as one', !!cv && cv.filename === 'Rishi_Samadhiya_Resume.docx'
      && cv.contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', cv && { f: cv.filename, t: cv.contentType });
    db.users[1].resume_path = null;
  }

  console.log('── 6. a render that fails charges nothing and sends nothing ──');
  resetWorld();
  {
    render.letterFails = true;
    const { res } = await send(1, 12, BASE);
    ok('→ 502 render_failed', res.statusCode === 502 && res.body.reason === 'render_failed', res.body);
    ok('⚠️ no send, no claim', sends.length === 0 && claims.length === 0 && !events.includes('send'), events);
    ok('…and it says nothing was sent or charged', /Nothing was sent and nothing was charged/.test(res.body.error));
    resetWorld();
    render.builderNone = true;
    const b = await send(1, 12, { ...BASE, resume: { source: 'builder' } });
    ok('a Builder résumé that no longer exists → 409 resume_gone, nothing sent', b.res.statusCode === 409 && b.res.body.reason === 'resume_gone' && sends.length === 0 && claims.length === 0);
    await settle();
    ok('…and the letter PDF it had already made is deleted', liveTemps().length === 0, liveTemps());
  }

  console.log('── 7. provider refusals: each says what to do, none is charged ──');
  for (const [name, err, reason, status] of [
    ['an expired / revoked Google sign-in', Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } }), 'reconnect', 409],
    ['a 401 from Gmail', Object.assign(new Error('Login Required'), { code: 401, response: { status: 401, data: {} } }), 'reconnect', 409],
    ['no gmail.send permission', Object.assign(new Error('Request had insufficient authentication scopes.'), { code: 403, response: { status: 403, data: { error: { errors: [{ reason: 'insufficientPermissions' }] } } } }), 'scope', 409],
    ['Gmail rate limit', Object.assign(new Error('User-rate limit exceeded'), { code: 429, response: { status: 429, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } }), 'provider_busy', 503],
    ['a refused address', Object.assign(new Error('Invalid To header'), { code: 400, response: { status: 400, data: {} } }), 'bad_recipient', 400],
    ['Graph: message too large', Object.assign(new Error('Microsoft Graph 413 ErrorMessageSizeExceeded'), { status: 413, graphCode: 'ErrorMessageSizeExceeded' }), 'too_big', 413],
    ['something else', new Error('weird'), 'send_failed', 502],
  ]) {
    resetWorld();
    provider.throws = err;
    const { res } = await send(1, 12, BASE);
    ok(`${name} → ${status} ${reason}`, res.statusCode === status && res.body.reason === reason, res.body);
    ok(`⚠️ …${name}: nothing claimed, nothing recorded`, claims.length === 0 && histories.length === 0 && letterRecords.length === 0
      && !db.log.some((x) => /application_history|total_sent/.test(x.sql)));
  }
  ok('the reconnect message names the provider and the fix', /Gmail needs you to sign in again\. Tap Reconnect/.test(C._internals.mailFailure('reconnect', 'google').error));

  console.log('── 8. the happy path: one message, the right files, charged AFTER it left ──');
  resetWorld();
  {
    const logs = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a) => logs.push(a.join(' ')); console.warn = console.log; console.error = console.log;
    let res;
    try { ({ res } = await send(1, 12, { ...BASE, to: ['recruiter@nordex-online.com', 'hm@nordex-online.com'] })); }
    finally { Object.assign(console, orig); }
    await settle();
    ok('200 success from gmail', res.statusCode === 200 && res.body.success === true && res.body.provider === 'google', res.body);
    ok('⚠️ exactly ONE message', sends.length === 1);
    const m = sends[0] && sends[0].msg;
    ok('to both recipients', m && m.to.length === 2);
    ok('the letter and the tailored résumé, as named PDFs', m && JSON.stringify(m.attachments.map((a) => [a.filename, a.contentType]))
      === JSON.stringify([['Rishi_Samadhiya_Cover_Letter.pdf', 'application/pdf'], ['Rishi_Samadhiya_Resume.pdf', 'application/pdf']]), m && m.attachments.map((a) => a.filename));
    ok('…carrying the rendered bytes (the letter PDF the Download makes)', m && m.attachments[0].content.slice(0, 5).toString() === '%PDF-' && /letter/.test(m.attachments[0].content.toString()));
    const mime = sends[0] && sends[0].mime;
    ok('⚠️ the subject is RFC 2047 encoded — no raw "—" or "é" in the headers', /^Subject: =\?UTF-8\?/m.test(mime) && !/^Subject:.*[—é]/m.test(mime), mime && mime.split('\n').find((l) => /^Subject/.test(l)));
    ok('the body is a quoted-printable text part with an HTML twin', /Content-Type: text\/plain; charset=utf-8/i.test(mime) && /Content-Type: text\/html; charset=utf-8/i.test(mime));
    ok('From is the LINKED address with the letter\'s name, and the Message-ID is on its domain', /^From: Rishi Samadhiya <rishi\.work@gmail\.com>/m.test(mime) && /^Message-ID: <[^>]+@gmail\.com>/m.test(mime));
    const iSend = events.indexOf('send');
    ok('⚠️ claimed AFTER the send, once per gated attachment', iSend > 0 && events.slice(iSend + 1).filter((e) => e.startsWith('claim:')).length === 2
      && !events.slice(0, iSend).some((e) => e.startsWith('claim:')), events);
    ok('recorded like the Download: the letter (with its docId) and the résumé', letterRecords.length === 1 && letterRecords[0].docId === 12 && letterRecords[0].tplId === 'exec_leader'
      && histories.length === 1 && histories[0].kind === 'resume' && histories[0].payload.docId === 30, { letterRecords, histories });
    const apps = db.log.filter((x) => /INSERT INTO application_history/.test(x.sql));
    ok('⚠️ one application_history row per recipient (replies, follow-ups, the journey read it)', apps.length === 2 && apps[0].params[3] === 'recruiter@nordex-online.com' && apps[0].params[1] === 'Nordex SE');
    ok('users.total_sent counted once, the in-app notice sent, the event tracked', db.log.filter((x) => /total_sent/.test(x.sql)).length === 1
      && notices.length === 1 && emits.length === 1 && emits[0].event === 'letter_emailed');
    ok('⚠️ the rendered PDFs are deleted after the send', written.length === 2 && liveTemps().length === 0, liveTemps());
    const all = logs.join('\n');
    ok('⚠️ no log line carries the subject, the body, an address or a token', !/Inspecteur|Qualit|Please find my letter|recruiter@|hm@|enc-a|enc-r/.test(all), all.slice(0, 400));
    ok('…but the log does say provider, counts, sizes and recipient DOMAINS', /→ google: 2 recipient\(s\) \(nordex-online\.com, nordex-online\.com\), 2 file\(s\)/.test(all), all.slice(0, 300));
    ok('the answer says whether anything was charged', res.body.charged === false);
    resetWorld();
    gate.via = 'pass';
    const p = await send(1, 12, BASE);
    ok('a pass-covered send reports charged:true', p.res.body.charged === true);
  }

  console.log('── 9. a tailored résumé must be THIS employer\'s, and the provider\'s size ceiling is checked first ──');
  resetWorld();
  {
    const other = await send(1, 12, { ...BASE, resume: { source: 'tailored', docId: 31 } });
    ok('⚠️ a résumé tailored for ANOTHER employer → 409 resume_gone, nothing rendered', other.res.statusCode === 409 && other.res.body.reason === 'resume_gone' && !events.some((e) => e.startsWith('render')), other.res.body);
    const theirs = await send(1, 12, { ...BASE, resume: { source: 'tailored', docId: 999 } });
    ok('a résumé id that is not theirs → 409 resume_gone', theirs.res.statusCode === 409 && theirs.res.body.reason === 'resume_gone');
    resetWorld();
    render.bigBytes = 3 * 1024 * 1024;                                     // a 3 MB letter PDF
    const big = await send(3, 40, { ...BASE, resume: { source: 'builder' } });
    ok('⚠️ Outlook over its inline ceiling → 413 too_big BEFORE the provider is asked', big.res.statusCode === 413 && big.res.body.reason === 'too_big' && sends.length === 0 && claims.length === 0, big.res.body);
    resetWorld();
    render.bigBytes = 1.6 * 1024 * 1024;
    const gm = await send(1, 12, BASE);
    ok('…while the same files go through Gmail (15 MB)', gm.res.statusCode === 200 && sends.length === 1);
  }

  console.log('── 10. files from the phone: PDF / Word only, checked by their bytes, owned by their uploader ──');
  resetWorld();
  {
    const up = async (userId, name, buf, id = 12) => { const req = reqOf(userId, id); req.file = { originalname: name, buffer: buf }; const res = mkRes(); await C.uploadSendFile(req, res); return res; };
    const img = await up(1, 'cv.pdf', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
    ok('⚠️ a JPEG named cv.pdf → 400 bad_file', img.statusCode === 400 && img.body.reason === 'bad_file', img.body);
    const exe = await up(1, 'cv.exe', PDF('x'));
    ok('an extension we do not attach → 400 bad_file', exe.statusCode === 400 && exe.body.reason === 'bad_file');
    const huge = await up(1, 'cv.pdf', PDF('x', 5 * 1024 * 1024));
    ok('over 5 MB → 413 too_big', huge.statusCode === 413 && huge.body.reason === 'too_big');
    const good = await up(1, 'My CV (final).docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 9, 9, 9]));
    ok('a real .docx is held and named back', good.statusCode === 200 && typeof good.body.fileId === 'string' && good.body.name === 'My CV (final).docx', good.body);
    const held = C._internals.uploads.get(good.body.fileId);
    ok('⚠️ held OUTSIDE temp/ (the download routes serve temp/)', !!held && held.path.startsWith(C._internals.SEND_DIR) && !held.path.includes(`${path.sep}temp${path.sep}`), held && held.path);
    const wrongDoc = await up(1, 'cv.pdf', PDF('x'), 40);
    ok('an upload against someone else\'s letter → 404 gone', wrongDoc.statusCode === 404);
    const stolen = await send(3, 40, { ...BASE, resume: { source: 'file', fileId: good.body.fileId } });
    ok('⚠️ another user sending with that fileId → 409 file_gone', stolen.res.statusCode === 409 && stolen.res.body.reason === 'file_gone', stolen.res.body);
    const mine = await send(1, 12, { ...BASE, resume: { source: 'file', fileId: good.body.fileId } });
    const a = sends[0] && sends[0].msg.attachments[1];
    ok('the owner\'s send attaches it under its own name and Word type', mine.res.statusCode === 200 && !!a && a.filename === 'My CV (final).docx'
      && a.contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', a && a.filename);
    ok('…not gated or claimed (their own file) — only the letter was', claims.length === 1 && events.filter((e) => e.startsWith('gate:')).length === 1);
    ok('…and deleted once sent', !C._internals.uploads.has(good.body.fileId) && (await settle(), !fs.existsSync(held.path)));
    const letterFile = await up(1, 'letter.pdf', PDF('mine'));
    resetWorld();
    const own = await send(1, 12, { ...BASE, letter: { source: 'file', fileId: letterFile.body.fileId }, resume: { source: 'none' } });
    ok('⚠️ a letter file of their own: no gate, no render, no claim', own.res.statusCode === 200 && claims.length === 0 && !events.some((e) => /^(gate|render)/.test(e)), events);
  }

  console.log('── 11. the email draft: read-only, the known contact prefilled, the résumé order ──');
  resetWorld();
  {
    db.contacts = [
      { name: 'Anna', role: 'Engineering Manager', email: 'anna@nordex.com', job_url: 'https://other' },
      { name: 'Tom', role: 'Talent Acquisition', email: 'tom@nordex.com', job_url: 'https://other' },
      { name: 'Bad', role: 'x', email: 'not an email', job_url: '' },
      { name: 'Tom again', role: 'HR', email: 'TOM@nordex.com', job_url: '' },
    ];
    db.users[1].resume_path = writeUploaded('cv.pdf', PDF('cv'));
    const req = reqOf(1, 12); const res = mkRes();
    await C.getEmailDraft(req, res);
    const b = res.body;
    ok('200 with the letter\'s own subject', res.statusCode === 200 && b.subject === 'Application for Inspecteur Qualité A350 — Rishi Samadhiya', b && b.subject);
    ok('an employer-level letter prefills its best contact — the RECRUITER, only one', b.recipients.prefill.length === 1 && b.recipients.prefill[0].email === 'tom@nordex.com', b.recipients);
    ok('…the rest are suggestions, deduped, valid only', JSON.stringify(b.recipients.suggestions.map((c) => c.email)) === JSON.stringify(['anna@nordex.com']), b.recipients.suggestions);
    ok('the résumé order: tailored > Builder > uploaded, tailored first by default', JSON.stringify(b.resume.options.map((o) => o.id)) === JSON.stringify(['tailored', 'builder', 'uploaded'])
      && b.resume.default === 'tailored' && b.resume.options[0].docId === 30, b.resume);
    ok('the account: google, ready, the LINKED address', b.account.provider === 'google' && b.account.ready === true && b.account.address === 'rishi.work@gmail.com', b.account);
    ok('a deterministic body that names the role and the attachments', /Inspecteur Qualité A350/.test(b.body) && /cover letter and résumé are attached/.test(b.body) && /Best regards,\nRishi Samadhiya/.test(b.body));
    ok('⚠️ opening the page: no AI, no render, no gate, no claim, no write', ai.calls === 0 && events.length === 0 && !db.log.some((x) => x.verb === 'run'), { ai: ai.calls, events });
    db.users[1].resume_path = null;
    docsCalls.length = 0;
    const r2 = mkRes(); await C.getEmailDraft(reqOf(1, 13, {}, { 'x-store-env': 'Sandbox' }), r2);
    ok('a POSTING letter with no contact on that posting prefills nobody', r2.body.recipients.prefill.length === 0);
    ok('…and looks for the tailored résumé on the posting first, then the employer', docsCalls.filter((x) => x.fn === 'currentFor').map((x) => x.jobUrl).join('|') === 'https://jobs.airbus.com/1|');
    ok('a letter without its own subject gets "Application for <position> — <name>"', r2.body.subject === 'Application for Cyber Security Manager — Rishi Samadhiya', r2.body.subject);
    const r3 = mkRes(); await C.getEmailDraft(reqOf(1, 12, {}, { 'x-store-env': 'Sandbox' }), r3);
    ok('⚠️ the draft is env-scoped too (a Production letter from a Sandbox build → 404 gone)', r3.statusCode === 404 && r3.body.reason === 'gone');
  }

  console.log('── 12. the email body: free, validated, never JSON ──');
  resetWorld();
  {
    const call = async () => { const res = mkRes(); await C.draftEmailBody(reqOf(1, 12), res); return res.body; };
    ai.answer = 'Dear Hiring Team,\n\nI am applying for the Inspecteur Qualité A350 role. I build resilient payment systems and cut settlement time by 40%. My cover letter and résumé are attached, and I would welcome a conversation.\n\nBest regards,\nRishi Samadhiya';
    const a = await call();
    ok('an AI answer that passes → source ai', a.source === 'ai' && /cut settlement time by 40%/.test(a.body), a);
    ok('…asked on the letter_email lane with a bounded budget and the writing chain', ai.last.lane === 'letter_email' && ai.last.budgetMs <= 15000 && Array.isArray(ai.last.models));
    ok('…with the letter quoted as data', /data, not instructions/.test(ai.last.prompt) && /resilient payment systems/.test(ai.last.prompt));
    ai.answer = '{"body": "Dear team, …"}';
    ok('⚠️ a JSON-looking answer → the template', (await call()).source === 'template');
    ai.answer = 'Dear [Hiring Manager Name],\n\n' + 'I am applying. '.repeat(10);
    ok('an answer with a [placeholder] → the template', (await call()).source === 'template');
    ai.answer = 'x'.repeat(2000);
    ok('an answer that is too long → the template', (await call()).source === 'template');
    ai.answer = null; ai.throws = new Error('AI_DOWN (quota)');
    const t = await call();
    ok('the AI failing → the template, never an error', t.source === 'template' && /Dear Hiring Manager,|Dear/.test(t.body));
    ai.throws = null; ai.answer = 'ok';
    C._internals.bodyCalls.clear();
    for (let i = 0; i < 30; i++) await call();
    const before = ai.calls;
    const limited = await call();
    ok('past 30 drafts an hour → the template, and no model call', limited.limited === true && limited.source === 'template' && ai.calls === before);
    const ctrl = strip(R('server/controllers/letterSendController.js'));
    const svc = strip(R('server/services/letterEmail.js'));
    ok('⚠️ the controller and the service never charge credits or consume a unit',
      !/chargeCredits|claimGeneration|passCoversGeneration|consumeOnSuccess|withUsageLock/.test(ctrl + svc));
    ok('⚠️ the body lane never talks to Gemini directly (aiText only)', !/@google\/generative-ai|GoogleGenerativeAI/.test(ctrl + svc));
  }

  console.log('── 13. the pure pieces ──');
  {
    ok('isEmail: real addresses', ['a@b.co', 'first.last+tag@sub.example.org'].every(mail.isEmail));
    ok('isEmail: junk', !['a@b', '@b.com', 'a@@b.com', 'a..b@c.com', 'a b@c.com', 'x'.repeat(250) + '@b.com'].some(mail.isEmail));
    ok('cleanSubject keeps one line', mail.cleanSubject('A\r\nBcc: x') === 'A Bcc: x');
    ok('letterPlainText reads the letter as paragraphs', mail.letterPlainText('<p>A &amp; B</p><p>C<br>D</p>') === 'A & B\n\nC\nD');
    ok('sniffKind: pdf / zip / ole / other', mail.sniffKind(PDF('x')) === 'pdf' && mail.sniffKind(Buffer.from([0x50, 0x4b, 3, 4])) === 'zip'
      && mail.sniffKind(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) === 'ole' && mail.sniffKind(Buffer.from('hello')) === null);
    ok('attachment names keep any script (José Müller → José_Müller)', mail.attachmentName('letter', 'José Müller', 'pdf') === 'José_Müller_Cover_Letter.pdf');
    const acct = realEmail.mailAccountOf;
    ok('mailAccountOf: google tokens → google ready', JSON.stringify(acct({ oauth_provider: 'google', google_refresh_token: 'x' })) === JSON.stringify({ provider: 'google', ready: true }));
    ok('mailAccountOf: prefers oauth_provider when both are linked', acct({ oauth_provider: 'microsoft', google_refresh_token: 'x', microsoft_refresh_token: 'y' }).provider === 'microsoft');
    ok('mailAccountOf: an Apple user with a linked Gmail sends from Gmail', acct({ oauth_provider: 'apple', google_access_token: 'x' }).provider === 'google');
    ok('⚠️ mailAccountOf: a provider with its tokens cleared is NOT ready', acct({ oauth_provider: 'google' }).ready === false && acct({ oauth_provider: 'google' }).reconnect === true);
    ok('mailAccountOf: nothing → no provider', acct({ oauth_provider: 'apple' }).provider === null && acct(null).ready === false);
    const cls = realEmail.classifyMailError;
    ok('classifyMailError: Graph InvalidAuthenticationToken → reconnect', cls(Object.assign(new Error('Microsoft Graph 401 InvalidAuthenticationToken'), { status: 401 })) === 'reconnect');
    ok('classifyMailError: Graph ErrorAccessDenied → scope', cls(Object.assign(new Error('Microsoft Graph 403 ErrorAccessDenied'), { status: 403, graphCode: 'ErrorAccessDenied' })) === 'scope');
    ok('classifyMailError: a refresh that failed on every client → reconnect', cls(new Error('Token refresh failed with all clients: invalid_grant')) === 'reconnect');
    ok('classifyMailError: ECONNRESET → provider_busy', cls(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })) === 'provider_busy');
  }

  console.log('── 14. hardening that rode along ──');
  {
    const src = strip(R('server/controllers/emailController.js'));
    ok('⚠️ decryptOAuthToken no longer logs any characters of a token or of ENCRYPTION_KEY',
      !/decrypted\.substring|ENCRYPTION_KEY\.substring|encryptedToken\.substring/.test(src));
    ok('the old senders are untouched for the older flows (still exported, still used by executeSendWork)',
      typeof realEmail.executeSendWork === 'function' && /sendEmailViaGmail\(/.test(src) && /sendEmailViaMicrosoft\(/.test(src));
    const cl = strip(R('server/controllers/coverLetterController.js'));
    ok('⚠️ the Download and the Send render the letter through ONE function (renderLetterPdfFile)',
      /await renderLetterPdfFile\(userId, doc, \{/.test(cl) && (cl.match(/generateRichCoverLetterPDF\(rich\.user/g) || []).length === 1);
    const rbSrc = strip(R('server/controllers/resumeBuilderController.js'));
    ok('⚠️ …and the résumé through ONE function (renderResumePdfFile)', /await renderResumePdfFile\(resume, \{ tplId, mode, brand: doc \? docBrandOf\(doc\) : null, photoPath \}\)/.test(rbSrc)
      && /renderResumePdfFile\(doc\.payload,/.test(rbSrc));
  }

  // ── The review's findings (2026-09-19) ────────────────────────────────────────────────────────────────────────────
  console.log('── 15. ⚠️ a dropped connection AFTER the hand-over is "unknown", never "nothing was sent" ──');
  {
    const cls = realEmail.classifyMailError;
    const issued = (e) => Object.assign(e, { sendIssued: true });
    ok('⚠️ ECONNRESET after the send request went out → unknown_outcome', cls(issued(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))) === 'unknown_outcome');
    ok('⚠️ a 5xx to the send request → unknown_outcome', cls(issued(Object.assign(new Error('Backend Error'), { code: 500, response: { status: 500, data: { error: { errors: [{ reason: 'backendError' }] } } } }))) === 'unknown_outcome'
      && cls(issued(Object.assign(new Error('Microsoft Graph 504'), { status: 504 }))) === 'unknown_outcome');
    ok('Node fetch "fetch failed" with a socket error after the hand-over → unknown_outcome',
      cls(issued(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } }))) === 'unknown_outcome');
    ok('…but a request that never CONNECTED cannot have been sent → provider_busy',
      cls(issued(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))) === 'provider_busy'
        && cls(issued(Object.assign(new Error('getaddrinfo ENOTFOUND gmail.googleapis.com'), { code: 'ENOTFOUND' }))) === 'provider_busy');
    ok('…and a rate limit is a refusal, even mid-send → provider_busy', cls(issued(Object.assign(new Error('Rate'), { code: 429, response: { status: 429, data: {} } }))) === 'provider_busy'
      && cls(issued(Object.assign(new Error('User-rate limit exceeded'), { code: 403, response: { status: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } }))) === 'provider_busy');
    ok('…and the token refresh failing (before any send) stays provider_busy', cls(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })) === 'provider_busy');
    ok('4xx answers keep their reasons after the hand-over', cls(issued(Object.assign(new Error('Invalid To header'), { code: 400, response: { status: 400, data: {} } }))) === 'bad_recipient'
      && cls(issued(Object.assign(new Error('Microsoft Graph 401 InvalidAuthenticationToken'), { status: 401 }))) === 'reconnect');
    const src = strip(R('server/controllers/emailController.js'));
    ok('⚠️ both providers mark the SEND request\'s errors (and only that request\'s)', (src.match(/catch \(e\) \{ throw markSendIssued\(e\); \}/g) || []).length === 2
      && /throw markSendIssued\(e\);\n\s*\}\n\s*return \{ provider: 'microsoft'/.test(src), (src.match(/markSendIssued\(/g) || []).length);
    resetWorld();
    provider.throws = issued(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const { res } = await send(1, 12, BASE);
    ok('the send route → 502 unknown_outcome', res.statusCode === 502 && res.body.reason === 'unknown_outcome', res.body);
    ok('⚠️ …which does NOT say nothing was sent — it sends them to the Sent folder, and says nothing was charged',
      !/Nothing was sent/.test(res.body.error) && /Sent folder/.test(res.body.error) && /Nothing was charged/.test(res.body.error), res.body.error);
    ok('…nothing claimed, nothing recorded', claims.length === 0 && histories.length === 0 && !db.log.some((x) => /application_history|total_sent/.test(x.sql)));
  }

  console.log('── 16. ⚠️ the message says what is attached ──');
  resetWorld();
  {
    const r1 = mkRes(); await C.getEmailDraft(reqOf(1, 12), r1);
    ok('the draft carries both standard notes', /cover letter and résumé are attached/.test(r1.body.bodies.withResume) && /My cover letter is attached to this email\./.test(r1.body.bodies.letterOnly)
      && !mail.saysResumeAttached(r1.body.bodies.letterOnly), r1.body.bodies);
    ok('…and `body` is the one for the default choice (a résumé exists → with it)', r1.body.body === r1.body.bodies.withResume);
    db.builder = false;
    DOCS.splice(DOCS.findIndex((d) => d.id === 30), 1);
    const r2 = mkRes(); await C.getEmailDraft(reqOf(1, 12), r2);
    ok('⚠️ no résumé to attach → the default note does not promise one', r2.body.resume.options.length === 0 && r2.body.body === r2.body.bodies.letterOnly && !/résumé/.test(r2.body.body), r2.body.body);
    resetWorld();
    const body = async (b) => { const res = mkRes(); const req = reqOf(1, 12, b); await C.draftEmailBody(req, res); return res.body; };
    ai.answer = 'Dear Hiring Team,\n\nI am applying for the Inspecteur Qualité A350 role. I build resilient payment systems and cut settlement time by 40%. My cover letter is attached, and I would welcome a conversation.\n\nBest regards,\nRishi Samadhiya';
    const lo = await body({ resume: false });
    ok('{ resume: false } → the model is told only the letter is attached, and not to mention a résumé',
      lo.source === 'ai' && /no résumé is attached/.test(ai.last.prompt) && /Do not mention a résumé or CV/.test(ai.last.prompt) && !/cover letter and the résumé are ATTACHED/.test(ai.last.prompt));
    ai.answer = 'Dear Hiring Team,\n\nI am applying for the Inspecteur Qualité A350 role. I build resilient payment systems. My cover letter and résumé are attached, and I would welcome a conversation.\n\nBest regards,\nRishi Samadhiya';
    const liar = await body({ resume: false });
    ok('⚠️ …a model answer that still claims a résumé → the letter-only template', liar.source === 'template' && /My cover letter is attached/.test(liar.body) && !mail.saysResumeAttached(liar.body), liar);
    const both = await body({});
    ok('…while the first app build\'s call (no flag) still gets the letter + résumé note', both.source === 'ai' && /cover letter and the résumé are ATTACHED/.test(ai.last.prompt));
    ok('saysResumeAttached: the phrasings', ['My cover letter and résumé are attached.', 'Please find attached my CV.', 'I have enclosed my resume.'].every(mail.saysResumeAttached)
      && !['My cover letter is attached.', 'Sent via CVApplyr, attached.'].some(mail.saysResumeAttached));
  }

  console.log('── 17. ⚠️ metered: two files, one plan download left — a pass covers the rest, exactly as two Downloads ──');
  resetWorld();
  {
    dls.METERED = true; gate.via = 'plan'; ent.many = { allowed: false, remaining: 1 };
    const none = await send(1, 12, BASE);
    ok('no unspent pass → 403 quota_exhausted, naming the file count', none.res.statusCode === 403 && none.res.body.reason === 'quota_exhausted' && none.res.body.units === 2, none.res.body);
    ok('…telling them what to change, and that nothing was sent or charged', /Remove the résumé or attach a file of your own/.test(none.res.body.error) && /Nothing was sent and nothing was charged/.test(none.res.body.error));
    ok('…before anything was rendered', !events.some((e) => /^render|^send|^claim/.test(e)), events);
    resetWorld();
    dls.METERED = true; gate.via = 'plan'; ent.many = { allowed: false, remaining: 1 }; passes.unbound = 1;
    const withPass = await send(1, 12, BASE);
    ok('⚠️ an unspent pass → the send goes through (the second Download would have taken the pass)', withPass.res.statusCode === 200 && sends.length === 1, withPass.res.body);
    ok('…and each file is claimed once, after the send', claims.length === 2 && events.indexOf('send') < events.indexOf(`claim:${claims[0]}`));
  }

  console.log('── 18. a letter stored with a model\'s JSON is read REPAIRED, like the Download reads it ──');
  resetWorld();
  {
    const JUNK = /Here is the JSON|```|"employer_name"/;
    const dirty = '<p>Dear Hiring Team,</p><p>I build resilient payment systems and cut settlement time by 40% across three regions for a large bank.</p><p>I would welcome the chance to talk about the role and how I can help your team deliver.</p><p>Kind regards</p><p>Here is the JSON output:</p><p>```json<br>{<br>"cover_letter": "Dear Hiring Team",<br>"employer_name": "Nordex"<br>}<br>```</p>';
    DOCS.find((d) => d.id === 12).payload.coverLetterHtml = dirty;
    const { res } = await send(1, 12, BASE);
    ok('the send goes through', res.statusCode === 200, res.body);
    ok('⚠️ the history row freezes the REPAIRED letter, not the junk', letterRecords.length === 1 && !JUNK.test(letterRecords[0].coverLetterHtml) && /resilient payment systems/.test(letterRecords[0].coverLetterHtml), letterRecords[0] && letterRecords[0].coverLetterHtml.slice(-160));
    ai.answer = 'x';
    const r = mkRes(); await C.draftEmailBody(reqOf(1, 12), r);
    ok('⚠️ the AI note is drafted from the repaired letter', ai.calls === 1 && !JUNK.test(ai.last.prompt) && /resilient payment systems/.test(ai.last.prompt));
    ok('…and the stored row is not written (a copy)', DOCS.find((d) => d.id === 12).payload.coverLetterHtml === dirty && !db.log.some((x) => /user_employer_documents/.test(x.sql)));
  }

  console.log('── 19. ⚠️ the uploaded CV in EVERY format the upload stores (odt / rtf / txt too), named and typed as itself ──');
  // 2026-09-20 (cross-track): the wizard's upload now keeps .odt, .rtf and .txt CVs (services/resumeText), but
  // uploadedResumeOf filtered with letterEmail.FILE_KINDS (pdf / doc / docx — the PHONE-pick table), so such a user had
  // no résumé on this page and nothing said why. Real files from server/scripts/fixtures/cv.
  {
    const FIX = path.join(ROOT, 'server', 'scripts', 'fixtures', 'cv');
    const rt = require(path.join(ROOT, 'services', 'resumeText.js'));
    const draftOf = async () => { const r = mkRes(); await C.getEmailDraft(reqOf(1, 12), r); return r.body; };
    const uploadedOpt = (b) => b && b.resume && b.resume.options.find((o) => o.id === 'uploaded');
    for (const kind of ['odt', 'rtf', 'txt', 'doc', 'docx']) {
      resetWorld();
      db.users[1].resume_path = writeUploaded(`stored_cv.${kind}`, fs.readFileSync(path.join(FIX, `cv.${kind}`)));
      const b = await draftOf();
      const opt = uploadedOpt(b);
      ok(`a stored .${kind} CV is offered on the Send page, labelled ${rt.FORMATS[kind].label}`, !!opt && opt.detail.startsWith(`${rt.FORMATS[kind].label} · `) && opt.gated === false, b && b.resume);
      const { res } = await send(1, 12, { ...BASE, resume: { source: 'uploaded' } });
      const cv = sends[0] && sends[0].msg.attachments.find((a) => /Resume/.test(a.filename));
      ok(`…and goes out as Rishi_Samadhiya_Resume.${kind}, typed ${rt.FORMATS[kind].mime}`, res.statusCode === 200 && !!cv
        && cv.filename === `Rishi_Samadhiya_Resume.${kind}` && cv.contentType === rt.FORMATS[kind].mime, cv ? { f: cv.filename, t: cv.contentType } : res.body);
      ok('…ungated and unclaimed (their own bytes) — only the letter PDF is', claims.length === 1 && events.filter((e) => e.startsWith('gate:')).length === 1, events);
    }
    resetWorld();
    // multer's bare name from before 2026-09-19 (one such row in production): read and sniffed, never assumed.
    db.users[1].resume_path = writeUploaded('1726000000063-87091077', PDF('legacy cv'));
    let opt = uploadedOpt(await draftOf());
    ok('⚠️ an extensionless stored CV that IS a PDF is sniffed and offered as one', !!opt && /^PDF · /.test(opt.detail), opt);
    let s = await send(1, 12, { ...BASE, resume: { source: 'uploaded' } });
    let cv = sends[0] && sends[0].msg.attachments.find((a) => /Resume/.test(a.filename));
    ok('…and attached as Rishi_Samadhiya_Resume.pdf, application/pdf', s.res.statusCode === 200 && !!cv && cv.filename === 'Rishi_Samadhiya_Resume.pdf' && cv.contentType === 'application/pdf', cv && cv.filename);
    resetWorld();
    db.users[1].resume_path = writeUploaded('1726000000064-11111111', fs.readFileSync(path.join(FIX, 'cv.docx')));
    s = await send(1, 12, { ...BASE, resume: { source: 'uploaded' } });
    cv = sends[0] && sends[0].msg.attachments.find((a) => /Resume/.test(a.filename));
    ok('⚠️ an extensionless Word file goes out as .docx — NOT a ".pdf" that opens broken', !!cv && cv.filename === 'Rishi_Samadhiya_Resume.docx' && /wordprocessingml/.test(cv.contentType), cv && { f: cv.filename, t: cv.contentType });
    for (const [name, bytes, why] of [
      ['1726000000065-22222222', Buffer.from([0x00, 0x9f, 0x92, 0x96, 0x00, 0x01, 0xfe, 0xff, 0x00, 0x00, 0x13, 0x37]), 'unreadable bytes with no extension'],
      ['stored_cv.exe', Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), 'a .exe'],
    ]) {
      resetWorld();
      db.users[1].resume_path = writeUploaded(name, bytes);
      opt = uploadedOpt(await draftOf());
      ok(`${why} is never offered as a CV`, !opt, opt);
      s = await send(1, 12, { ...BASE, resume: { source: 'uploaded' } });
      ok('…and a send that asks for it is refused (409 resume_gone) — nothing sent, nothing charged', s.res.statusCode === 409 && s.res.body.reason === 'resume_gone'
        && sends.length === 0 && claims.length === 0 && /Nothing was sent and nothing was charged/.test(s.res.body.error), s.res.body);
    }
    resetWorld();
    ok('a file picked on the PHONE is still PDF / Word only (FILE_KINDS is that table, and only that)', !mail.checkDeviceFile('cv.odt', fs.readFileSync(path.join(FIX, 'cv.odt'))).ok
      && mail.checkDeviceFile('cv.docx', fs.readFileSync(path.join(FIX, 'cv.docx'))).ok, Object.keys(mail.FILE_KINDS));
    ok('attachmentName: a stored kind keeps its extension, anything unknown is .pdf',
      mail.attachmentName('resume', 'A B', 'odt') === 'A_B_Resume.odt' && mail.attachmentName('resume', 'A B', 'jpg') === 'A_B_Resume.jpg'
      && mail.attachmentName('letter', 'A B', 'exe') === 'A_B_Cover_Letter.pdf');
    const fnSrc = strip(R('server/controllers/letterSendController.js')).split('async function uploadedResumeOf')[1].split('\nasync function ')[0];
    ok('⚠️ uploadedResumeOf reads the upload\'s table (resumeText), not the phone-pick table', /resumeText/.test(fnSrc) && !/FILE_KINDS|mimeOfExt/.test(fnSrc));
    db.users[1].resume_path = null;
  }

  console.log('── 20. ⚠️ the CLASSIC lane: a letter the preview holds without a saved document (Job Hub, Review, old Home) ──');
  // 2026-09-20 (the completeness review): Send was on the doc-mode preview only, but the Job Hub's and the Review screen's
  // letters open the SAME preview with the SAME Download. They carry the letter itself; every rule above holds for it.
  const CLASSIC = {
    coverLetterHtml: LETTER_HTML, companyName: 'Nordex SE', companyAddress: 'Langenhorner Chaussee 600\n22419 Hamburg',
    employer: 'Nordex', position: 'Service Technician', jobUrl: 'https://jobs.nordex.com/9',
  };
  /** The cap the controller puts on a classic letter's text, read from its own source (the app mirrors it). */
  const CLASSIC_MAX = Number((/const CLASSIC_HTML_MAX = (\d+);/.exec(strip(R('server/controllers/letterSendController.js'))) || [])[1]);
  const layerOf = (p) => routes.stack.find((l) => l.route && l.route.path === p);
  /** A classic route as mounted: every layer after authenticateToken, in order (the send() helper's walk). */
  async function runClassic(p, userId, body, headers = {}) {
    const req = { user: { id: userId }, params: {}, body, headers, query: {} };
    const res = mkRes();
    for (const h of layerOf(p).route.stack.map((s) => s.handle).slice(1)) {
      let advanced = false;
      await h(req, res, () => { advanced = true; });
      if (!advanced) break;
    }
    return res;
  }
  const runSend = (userId, body) => runClassic('/classic/send', userId, body);
  {
    const CLASSIC_PATHS = ['/classic/email-draft', '/classic/email-body', '/classic/send-files', '/classic/send'];
    ok('the classic routes are POSTs (the letter travels with them)', CLASSIC_PATHS.every((p) => layerOf(p) && layerOf(p).route.methods.post));
    ok('⚠️ each runs authenticateToken, then classicLane', CLASSIC_PATHS.every((p) => {
      const hs = layerOf(p).route.stack.map((s) => s.handle);
      return hs[0] === authenticateToken && hs[1] === routes.classicLane;
    }));
    const cs = layerOf('/classic/send').route.stack.map((s) => s.handle);
    ok('classic Send: classicLane, holdMailFields, then the asJob wrapper', cs[2] === routes.holdMailFields && cs[3].name === 'asJobHandler', cs.map((h) => h.name));
    const idx = (p) => routes.stack.findIndex((l) => l.route && l.route.path === p);
    ok('⚠️ registered BEFORE /:id/send (else POST /classic/send is /:id/send with id "classic")', idx('/classic/send') < idx('/:id/send') && idx('/classic/email-body') < idx('/:id/email-body'));

    resetWorld();
    db.contacts = [
      { name: 'Anna', role: 'Engineering Manager', email: 'anna@nordex.com', job_url: CLASSIC.jobUrl },
      { name: 'Tom', role: 'Talent Acquisition', email: 'tom@nordex.com', job_url: CLASSIC.jobUrl },
    ];
    const d = await runClassic('/classic/email-draft', 1, { classic: { ...CLASSIC, subject: 'INJECTED', senderName: 'Mallory', sender: { name: 'Mallory' } } });
    const L = d.body && d.body.letter;
    ok('the draft: 200, no doc id, marked classic, the employer the Download resolves', d.statusCode === 200 && L.docId === null && L.classic === true && L.employer === 'Nordex', L);
    ok('…resolved from [employer, companyName], the Download\'s order', JSON.stringify(resolves[0]) === JSON.stringify(['Nordex', 'Nordex SE']), resolves);
    ok('⚠️ the subject is ours (from the position) — the client cannot name it', d.body.subject === 'Application for Service Technician — Rishi Samadhiya', d.body.subject);
    ok('⚠️ the payload senderForLetter is handed carries only the letter and the company lines — never a sender',
      senderPayloads.length > 0 && senderPayloads.every((pl) => Object.keys(pl).sort().join() === 'companyAddress,companyName,coverLetterHtml,position'), senderPayloads.map((pl) => Object.keys(pl)));
    ok('the posting\'s recruiter is prefilled, the rest suggested', d.body.recipients.prefill.length === 1 && d.body.recipients.prefill[0].email === 'tom@nordex.com'
      && d.body.recipients.suggestions.map((c) => c.email).join() === 'anna@nordex.com', d.body.recipients);
    const cq = db.log.find((x) => /FROM job_contacts/.test(x.sql));
    ok('⚠️ …looked up on THAT posting only — never employer-wide on a client\'s word', !!cq && cq.params[0] === CLASSIC.jobUrl && cq.params[1] === null, cq && cq.params);
    ok('the tailored résumé for that employer comes first', d.body.resume.default === 'tailored' && d.body.resume.options[0].docId === 30, d.body.resume);
    ok('…found in the request\'s store environment', docsCalls.filter((x) => x.fn === 'currentFor').every((x) => x.env === 'Production' && x.userId === 1));
    ok('⚠️ opening it: no AI, no render, no gate, no claim, no write', ai.calls === 0 && events.length === 0 && !db.log.some((x) => x.verb === 'run'), { ai: ai.calls, events });

    resetWorld();
    const d2 = await runClassic('/classic/email-draft', 1, { classic: { coverLetterHtml: LETTER_HTML, companyName: 'Nordex SE', jobUrl: 'javascript:alert(1)' } });
    ok('no real posting URL → no contact lookup at all, nobody prefilled', d2.statusCode === 200 && d2.body.recipients.prefill.length === 0
      && !db.log.some((x) => /job_contacts/.test(x.sql)) && d2.body.letter.jobUrl === '', d2.body);
    ok('…the employer is the company name (the Download\'s fallback), and no position → "Job application — <name>"',
      d2.body.letter.employer === 'Nordex SE' && d2.body.subject === 'Job application — Rishi Samadhiya', { e: d2.body.letter.employer, s: d2.body.subject });
    for (const [why, classic] of [['no letter', undefined], ['an empty letter', { coverLetterHtml: '   ' }],
      ['a letter over the cap', { coverLetterHtml: 'x'.repeat(CLASSIC_MAX + 1) }], ['a string, not a letter', 'hello']]) {
      const r = await runClassic('/classic/email-draft', 1, { classic });
      ok(`${why} → 400 no_letter (never 404 "gone": nothing was deleted)`, r.statusCode === 400 && r.body.reason === 'no_letter', r.body);
    }
  }
  {
    resetWorld();
    passes.ownedSpelling = 'Nordex SE';
    const r = await runSend(1, { ...BASE, resume: { source: 'none' }, classic: { coverLetterHtml: LETTER_HTML, companyName: 'Nordex SE', employer: 'Nordex' } });
    ok('⚠️ a pass already owned as "Nordex SE" is the one gated and claimed — as the classic Download resolves it',
      r.statusCode === 200 && events[0] === 'gate:Nordex SE' && claims.join() === 'Nordex SE', { status: r.statusCode, events, claims });
  }
  {
    resetWorld();
    const logs = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a) => logs.push(a.join(' ')); console.warn = console.log; console.error = console.log;
    let r;
    try { r = await runSend(1, { ...BASE, classic: { ...CLASSIC }, resume: { source: 'tailored', docId: 30 } }); }
    finally { Object.assign(console, orig); }
    await settle();
    ok('the classic happy path: 200 from gmail, ONE message', r.statusCode === 200 && r.body.success === true && sends.length === 1, r.body);
    ok('⚠️ the letter is rendered by the CLASSIC Download\'s render, in the page\'s design and layout', events.includes('render:classic') && !events.includes('render:letter')
      && classicRenders[0].template === 'exec_leader' && classicRenders[0].mode === 'onepage' && classicRenders[0].coverLetterHtml === LETTER_HTML
      && classicRenders[0].companyName === 'Nordex SE' && classicRenders[0].companyAddress === CLASSIC.companyAddress, classicRenders[0]);
    ok('⚠️ gated BEFORE any render, claimed AFTER the send — the letter and the tailored résumé, both for Nordex',
      events.slice(0, 2).join() === 'gate:Nordex,gate:Nordex' && events.indexOf('render:classic') > 1
        && events.indexOf('send') < events.indexOf('claim:Nordex') && claims.join() === 'Nordex,Nordex', events);
    ok('the letter and the tailored résumé, as named PDFs', JSON.stringify(sends[0].msg.attachments.map((a) => a.filename)) === JSON.stringify(['Rishi_Samadhiya_Cover_Letter.pdf', 'Rishi_Samadhiya_Resume.pdf']));
    ok('recorded like the classic Download: no docId, the letter as sent', letterRecords.length === 1 && letterRecords[0].docId === undefined
      && letterRecords[0].coverLetterHtml === LETTER_HTML && letterRecords[0].employer === 'Nordex', letterRecords[0]);
    const apps = db.log.filter((x) => /INSERT INTO application_history/.test(x.sql));
    ok('application_history names the company and the position', apps.length === 1 && apps[0].params[1] === 'Nordex SE' && apps[0].params[2] === 'Service Technician', apps.map((a) => a.params));
    const all = logs.join('\n');
    ok('⚠️ no log line carries the letter, the subject, the body or an address', !/resilient payment|Inspecteur|Please find my letter|recruiter@|Langenhorner/.test(all), all.slice(0, 300));
    ok('…and it names a "classic letter", never "doc null"', /classic letter → google/.test(all) && !/doc null/.test(all), all.slice(0, 300));
    ok('the rendered PDFs are deleted after the send', written.length === 2 && liveTemps().length === 0, liveTemps());

    resetWorld();
    const a = await runSend(1, { ...BASE, classic: { ...CLASSIC }, __async: true, clientBuildId: 'ls-classic' });
    const settled = await settleJob();
    const input = jobs.created[0] && jobs.created[0].input;
    ok('the classic async lane answers 202 with a job id', a.statusCode === 202 && a.body.jobId === 'job-1', a.body);
    ok('⚠️ async_jobs.input has NO letter, recipients, subject or body', !!input && !('classic' in input) && !('to' in input) && !('subject' in input) && !('body' in input)
      && !/resilient payment|recruiter@/.test(JSON.stringify(input)), input);
    ok('…and the job still sent THAT letter', settled && sends.length === 1 && classicRenders.length === 1 && classicRenders[0].coverLetterHtml === LETTER_HTML, { settled, n: sends.length });

    resetWorld();
    gate.allow = false;
    const locked = await runSend(1, { ...BASE, classic: { ...CLASSIC } });
    ok('⚠️ a locked account → 403 paid_required before any render, send or claim', locked.statusCode === 403 && locked.body.reason === 'paid_required'
      && !events.some((e) => /^render|^send|^claim/.test(e)) && sends.length === 0 && claims.length === 0, events);
    resetWorld();
    const none = await runSend(1, { ...BASE });
    ok('a classic Send with no letter → 400 no_letter, nothing rendered or sent', none.statusCode === 400 && none.body.reason === 'no_letter'
      && events.length === 0 && sends.length === 0 && /Nothing was sent and nothing was charged/.test(none.body.error), none.body);
    resetWorld();
    render.letterFails = true;
    const broke = await runSend(1, { ...BASE, classic: { ...CLASSIC }, resume: { source: 'none' } });
    ok('a classic render that fails → 502 render_failed, nothing sent or claimed', broke.statusCode === 502 && broke.body.reason === 'render_failed' && sends.length === 0 && claims.length === 0);

    // The AI note and the attachment, from a classic letter carrying a model's JSON: both read it REPAIRED.
    resetWorld();
    const JUNK = /Here is the JSON|```|"employer_name"/;
    const dirty = '<p>Dear Hiring Team,</p><p>I build resilient payment systems and cut settlement time by 40% across three regions for a large bank.</p><p>I would welcome the chance to talk about the role and how I can help your team deliver.</p><p>Kind regards</p><p>Here is the JSON output:</p><p>```json<br>{<br>"cover_letter": "Dear Hiring Team",<br>"employer_name": "Nordex"<br>}<br>```</p>';
    ai.answer = 'x';
    const b = await runClassic('/classic/email-body', 1, { classic: { ...CLASSIC, coverLetterHtml: dirty }, resume: false });
    ok('the note is drafted from the classic letter — repaired, never its JSON', b.statusCode === 200 && ai.calls === 1 && !JUNK.test(ai.last.prompt) && /resilient payment systems/.test(ai.last.prompt), b.body);
    ok('…free: no gate, no render, no claim', events.length === 0 && claims.length === 0);
    const s2 = await runSend(1, { ...BASE, classic: { ...CLASSIC, coverLetterHtml: dirty }, resume: { source: 'none' } });
    ok('⚠️ the attached PDF is rendered from the REPAIRED letter', s2.statusCode === 200 && !JUNK.test(classicRenders[0].coverLetterHtml) && /resilient payment systems/.test(classicRenders[0].coverLetterHtml));

    // A file from the phone for a classic letter: no saved letter to check, and only its uploader can send it.
    resetWorld();
    const req = { user: { id: 1 }, params: {}, headers: {}, query: {}, body: {}, file: { originalname: 'My CV.pdf', buffer: PDF('mine') } };
    routes.classicLane(req, null, () => {});
    const upRes = mkRes(); await C.uploadSendFile(req, upRes);
    ok('a classic upload needs no saved letter', upRes.statusCode === 200 && typeof upRes.body.fileId === 'string', upRes.body);
    const stolen = await runSend(3, { ...BASE, classic: { ...CLASSIC }, resume: { source: 'file', fileId: upRes.body.fileId } });
    ok('⚠️ …another user sending that fileId → 409 file_gone', stolen.statusCode === 409 && stolen.body.reason === 'file_gone', stolen.body);
    const mine = await runSend(1, { ...BASE, classic: { ...CLASSIC }, resume: { source: 'file', fileId: upRes.body.fileId } });
    ok('…the uploader\'s send attaches it, ungated — only the letter is claimed', mine.statusCode === 200 && claims.length === 1 && sends[0].msg.attachments[1].filename === 'My CV.pdf', mine.body);

    const cl = strip(R('server/controllers/coverLetterController.js'));
    ok('⚠️ the classic render IS the classic Download\'s: renderLetterPdfFile with no doc',
      /async function renderClassicLetterPdf\([\s\S]*?await renderLetterPdfFile\(userId, null, \{/.test(cl) && /renderClassicLetterPdf,/.test(cl));
  }

  console.log('── 21. ⚠️ the classic lane is BOUNDED: a client\'s letter cannot hold the one thread, and the caps are real ──');
  // 2026-09-20 (review). The classic routes are the first place a SINGLE request can hand the server a letter, and that
  // text goes straight through the repair (utils/letterText) and the email draft (letterEmail.letterPlainText) on Node's
  // one thread. Both were written with `<[^>]*>`-shaped patterns that rescan to the end of the text from every unclosed
  // '<' — 60,000 characters of '<' froze the whole process for a minute, so ten requests were a ten-minute outage.
  {
    const lt = require(path.join(ROOT, 'server/utils/letterText.js'));
    const N = CLASSIC_MAX;
    ok('the cap is a letter\'s size, not a page\'s (production\'s longest letter is 7,373 characters)', N >= 8000 && N <= 25000, N);
    const appSrc = R('MobileApp/services/letterSend.ts');
    ok('⚠️ …and the app refuses the same size, so a Send page that would only be refused never opens',
      new RegExp(`export const CLASSIC_HTML_MAX = ${N};`).test(appSrc), (/CLASSIC_HTML_MAX = \d+/.exec(appSrc) || [])[0]);
    // Every shape that used to be quadratic somewhere in the chain, at exactly the size the routes accept.
    const ADVERSARIAL = {
      'unclosed <': '<'.repeat(N),
      'unclosed <p ': '<p '.repeat(Math.floor(N / 3)),
      'a fence, then unclosed <': '<p>```</p>' + '<'.repeat(N - 10),
      'a fence, a <br> and a page of spaces': '<p>```</p><br>' + ' '.repeat(N - 15) + 'x',
      'unclosed <p> tags': '<p>```</p>' + '<p>'.repeat(Math.floor((N - 10) / 3)),
      'unclosed <script tags': '< script'.repeat(Math.floor(N / 8)),
      'open <script> tags with no closer': '<script>'.repeat(Math.floor(N / 8)),
      'a stray quote and a page of spaces': '<p>```<br>"' + ' '.repeat(N - 20) + 'x</p>',
      'two paragraphs of punctuation': '<p>```</p><p>a' + '!'.repeat(Math.floor(N / 2) - 20) + 'a</p><p>b' + '!'.repeat(Math.floor(N / 2) - 20) + 'b</p>',
      'a page of chatter lines': 'Sure!\n'.repeat(Math.floor(N / 6)),
      'a page of code fences': '```\n'.repeat(Math.floor(N / 4)),
    };
    // A deliberately generous budget: each of these reads in 1–90 ms now, and took 0.4–5 SECONDS at this same size
    // before (20–60 s at the 60,000 the routes used to take — the cost grows with the square of the input). So a loaded
    // machine cannot fail it, and the quadratic shapes cannot pass it.
    const BUDGET_MS = 1000;
    const slow = [];
    for (const [name, html] of Object.entries(ADVERSARIAL)) {
      let best = Infinity;
      for (let r = 0; r < 3; r++) {
        const t = Date.now();
        lt.repairedLetterPayload({ coverLetterHtml: html });
        mail.letterPlainText(html);
        lt.letterProblem(html);
        best = Math.min(best, Date.now() - t);
      }
      if (best > BUDGET_MS) slow.push(`${name}: ${best}ms`);
    }
    ok(`⚠️ every adversarial letter is read in well under ${BUDGET_MS}ms (linear, not quadratic)`, slow.length === 0, slow);
    resetWorld();
    routes._classicReads.clear();
    const t0 = Date.now();
    const worst = await runClassic('/classic/email-draft', 1, { classic: { coverLetterHtml: ADVERSARIAL['unclosed <'], companyName: 'Nordex SE' } });
    const ms = Date.now() - t0;
    ok(`⚠️ …and the whole classic draft route answers in under ${BUDGET_MS}ms for one`, ms < BUDGET_MS, ms);
    ok('…with a real answer (the letter is read, not refused for its shape)', worst.statusCode === 200, worst.body && worst.body.reason);
  }
  {
    // The reads are counted per user: nothing else on /api/employer-docs is (apiLimiter is not mounted there).
    resetWorld();
    routes._classicReads.clear();
    const MAX = routes.CLASSIC_READS_MAX;
    const one = () => runClassic('/classic/email-draft', 1, { classic: { coverLetterHtml: LETTER_HTML, companyName: 'Nordex SE' } });
    let last = null;
    for (let i = 0; i < MAX; i++) last = await one();
    ok(`the first ${MAX} classic reads in ten minutes go through`, last.statusCode === 200, last.body && last.body.reason);
    const over = await one();
    ok('⚠️ past that → 429 too_many (a reason the app knows), nothing rendered or charged', over.statusCode === 429 && over.body.reason === 'too_many'
      && events.length === 0 && claims.length === 0, over.body);
    const other = await runClassic('/classic/email-draft', 3, { classic: { coverLetterHtml: LETTER_HTML, companyName: 'Nordex SE' } });
    ok('…counted per USER, not for everyone', other.statusCode === 200, other.body && other.body.reason);
    const bodyLayer = layerOf('/classic/email-body').route.stack.map((s) => s.handle);
    ok('the AI-note route is counted too', bodyLayer.includes(routes.classicReadLimit));
    const sendStack = layerOf('/classic/send').route.stack.map((s) => s.handle);
    ok('⚠️ …but the classic SEND is not: a retried Send must reach asJob to JOIN its job, never a 429 the phone reads as final',
      !sendStack.includes(routes.classicReadLimit));
    routes._classicReads.clear();
  }
  {
    // ⚠️ THE HOURLY SEND CAP IS TAKEN AT THE CHECK (review, 2026-09-20). It used to be read at step 1 and written at
    // step 8 — after the letter, the gate and the render had all awaited — so parallel sends all passed it. The classic
    // lane makes that easy: every request carries its own letter, and asJob answers 202 and runs them detached.
    resetWorld();
    C._internals.sendCalls.clear();
    const PER_HOUR = Number((/const SENDS_PER_HOUR = (\d+);/.exec(strip(R('server/controllers/letterSendController.js'))) || [])[1]);
    const burst = await Promise.all(Array.from({ length: PER_HOUR + 5 }, (_, i) => runSend(1, {
      ...BASE, resume: { source: 'none' }, clientBuildId: `ls-burst-${i}`,
      classic: { coverLetterHtml: LETTER_HTML, companyName: 'Nordex SE', employer: 'Nordex' },
    })));
    const okd = burst.filter((r) => r.statusCode === 200).length;
    const tooMany = burst.filter((r) => r.statusCode === 429 && r.body.reason === 'too_many').length;
    ok(`⚠️ ${PER_HOUR + 5} sends fired at once → exactly ${PER_HOUR} messages leave, the other 5 are 429 too_many`,
      sends.length === PER_HOUR && okd === PER_HOUR && tooMany === 5, { messages: sends.length, ok: okd, tooMany });
    await settle();
  }
  {
    // A send refused before the provider is asked gives its slot back: a locked account, a bad address or a render that
    // failed must not use up someone's hour.
    resetWorld();
    C._internals.sendCalls.clear();
    gate.allow = false;
    for (let i = 0; i < 25; i++) await runSend(1, { ...BASE, resume: { source: 'none' }, classic: { coverLetterHtml: LETTER_HTML, companyName: 'Nordex SE', employer: 'Nordex' } });
    gate.allow = true;
    const after = await runSend(1, { ...BASE, resume: { source: 'none' }, classic: { coverLetterHtml: LETTER_HTML, companyName: 'Nordex SE', employer: 'Nordex' } });
    ok('⚠️ 25 refused sends (a locked account) do not use up the hour — the next real one goes through',
      after.statusCode === 200 && sends.length === 1, { status: after.statusCode, reason: after.body && after.body.reason });
    const ctrl = strip(R('server/controllers/letterSendController.js'));
    ok('…because the slot is taken before the first await and given back on a refusal', /slot = reserveSend\(userId\)/.test(ctrl)
      && /if \(slot !== null && !slotSpent\) releaseSend\(userId, slot\);/.test(ctrl) && !/noteSend/.test(ctrl));
    await settle();
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* the OS cleans tmp */ }
  try { fs.rmSync(APP_TMP, { recursive: true, force: true }); } catch { /* gitignored either way */ }
  console.log(`\nletter send (server): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('SUITE THREW', e); process.exit(2); });
