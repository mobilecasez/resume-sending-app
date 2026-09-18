// The employer COVER LETTER lanes end to end — POST /cover-letter/employer-gate, /employer-build and GET
// /employer-cards, plus generate-template-pdf/docx with a docId — driven through the REAL
// employerLetterController / coverLetterController handlers against a stubbed database and a stubbed AI.
// No network, no production anything.
//   node server/scripts/test-employer-letter.js
//
// ⚠️ WHY: the letters auto-regen incident drained users. A cache hit must be free; the gate must be a true dry
// run (no reservation, no binding); coveredOnly must refuse before research and the AI and again at the
// moment of payment; a letter is stored only when the charge is confirmed; and a download with a docId renders
// the SAVED letter and bills the document's employer, whatever the body says.
// ⚠️ AND (2026-09-18, Amazon's letter on a 503 "high demand" day): a busy Google must never cost a user a letter
// or a charge. The lane asks through aiText — a pause, the primary once more, the rest of the chain, one AI window —
// a fallback's letter is stored as ITS letter under the same fingerprint, and when no model answers, nothing is
// charged or stored and the answer says so (503 ai_busy / ai_down).
// ⚠️ THE CHAIN IS aiText.writing() (2026-09-18, the blind evaluation — see aiText WRITING_PRIMARY): the measured
// DOCUMENT chain, gemini-3.1-flash-lite first, then gemini-2.5-flash with thinking OFF, then gemini-2.5-flash-lite. It
// is no longer [LETTER_MODEL, …fallbackModels()]. Every scenario below reads the chain from the aiText the lane
// calls (P, F1, F2 = aiText.writingChain()) — a model id hard-coded here would script a storm on a model the lane no
// longer asks first, and the storm would simply never happen.
'use strict';
const path = require('path');
const os = require('os');
const fsSync = require('fs');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const THUMBS = fsSync.mkdtempSync(path.join(os.tmpdir(), 'cva-letter-thumbs-'));
process.env.DOC_THUMB_CACHE_DIR = THUMBS;   // ⚠️ before the controller is required — it reads this at load
process.env.GEMINI_API_KEY = 'test-key-not-used';
delete process.env.AI_TEXT_FALLBACK_MODELS;   // the VERIFIED chain (aiText's default), whatever the shell exports
// …and the MEASURED writing chain the letter lane walks (aiText.writing()), whatever the shell exports: an operator's
// AI_WRITING_FALLBACK_MODELS=none would leave a one-model chain and no fallback for any storm below to reach.
delete process.env.AI_WRITING_MODEL;
delete process.env.AI_WRITING_FALLBACK_MODELS;

let pass = 0, fail = 0; const failures = [];
// ⚠️ A build left waiting on a flight nobody settles holds no timer, so node would simply exit — code 0, no summary.
let finished = false;
process.on('exit', () => { if (!finished) { console.log('TEST ERROR: the suite never reached its summary (a build was left hanging)'); process.exitCode = 2; } });
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 400) : '')); } };

// ── the world ───────────────────────────────────────────────────────────────────────────────────
const world = {
  meta: { id: 1, user_id: 7, parse_status: 'done', parsed_at: new Date(), raw_text: 'Backend engineer, Node, Postgres', job_titles: ['Backend Engineer'], experience_years: '9.0' },
  metaThrow: null,
  resumeRow: { resume_data: { personal_info: { title: 'Senior Backend Engineer' }, experience: [{ role: 'Senior Backend Engineer', company: 'Payly', start_date: 'Jan 2016', end_date: 'Present' }] } },
  user: { full_name: 'Jane Doe', email: 'jane@x.test', phone_number: '+1 555', city: 'Pune', country: 'India', photo_path: null, resume_path: '/uploads/r.pdf' },
  marks: { h: 10, l: 20 }, creditHistory: { n: 0, cost: 0 }, ledgerCredits: { n: 0 },
  sql: [],
};
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
async function dbGet(sql, params = []) {
  const q = norm(sql); world.sql.push(q);
  if (/FROM resume_metadata/.test(q)) { if (world.metaThrow) throw world.metaThrow; return world.meta; }
  if (/SELECT resume_data FROM user_resumes/.test(q)) return world.resumeRow;
  if (/SELECT full_name, email, phone_number, city, country FROM users/.test(q)) return world.user;
  if (/SELECT photo_path FROM users/.test(q)) return { photo_path: null };
  if (/SELECT \* FROM users/.test(q)) return world.user;
  if (/MAX\(id\), 0\) AS id FROM credit_usage_history/.test(q)) return { id: world.marks.h };
  if (/MAX\(id\), 0\) AS id FROM usage_ledger/.test(q)) return { id: world.marks.l };
  if (/COUNT\(\*\)::int AS n, COALESCE\(MAX\(credits_used\)/.test(q)) return world.creditHistory;
  if (/COUNT\(\*\)::int AS n FROM usage_ledger/.test(q)) return world.ledgerCredits;
  if (/FROM download_passes/.test(q)) return null;
  return null;
}
const stubAt = (abs, exports) => { const p = require.resolve(abs); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const stub = (rel, exports) => stubAt(path.join(ROOT, rel), exports);
stub('db-config.js', { get: dbGet, query: async (s, p) => { const r = await dbGet(s, p); return Array.isArray(r) ? r : []; }, run: async (s) => { world.sql.push('RUN ' + norm(s)); return {}; } });

/** The usage_ledger row consumeOnSuccess reports writing — the row a refused build must delete again. */
const LEDGER_ID = 90210;
const ent = { usageCalls: [], usageThrows: false, quota: { allowed: true, via: 'plan', remaining: 5 }, quotaSeq: null, used: { via: 'plan' }, consumed: [], gateCalls: 0, sub: { plan_key: 'plus' }, legacyEntitlements: false };
stub('server/services/entitlements.js', {
  canConsumeMany: async () => { ent.gateCalls++; return ent.quotaSeq && ent.quotaSeq.length ? ent.quotaSeq.shift() : ent.quota; },
  // ⚠️ THE REAL SHAPE (contract 1): { via, charge, ledgerId }. `charge` is chargeCredits' OWN answer for
  // this call — the only honest source for "was this letter paid for?". The credits-history window is a
  // fallback for an older entitlements (ent.legacyEntitlements), and it is what used to throw a paid
  // letter away when another build's deduction overlapped the window.
  consumeOnSuccess: async (u, kind, detail) => {
    ent.consumed.push({ u, kind, detail });
    const used = ent.used || {};
    if (ent.legacyEntitlements) return { via: used.via };
    const has = (k) => Object.prototype.hasOwnProperty.call(used, k);
    const charge = has('charge') ? used.charge
      : (used.via === 'credits' ? { charged: world.creditHistory.n > 0, cost: world.creditHistory.cost || 1 } : null);
    const ledgerId = has('ledgerId') ? used.ledgerId : (used.via === 'error' ? null : LEDGER_ID);
    return { via: used.via, charge, ledgerId };
  },
  activeSubscription: async () => ent.sub,
  // usageFor (contract 3): the confirm sheet's count. ent.usageCalls records the kind asked; ent.usageThrows breaks it.
  usageFor: async (u, kind) => {
    ent.usageCalls.push(kind);
    if (ent.usageThrows) throw new Error('ledger unreadable');
    return { kind, pool: 'free', planLabel: null, remaining: 2, allowance: 3, used: 1, oneTime: true };
  },
});

// the AI
// ai.fail(cfg, prompt) → an Error for THIS model (what Google answers it today), or null to fall through to the
// queue. ⚠️ The queue is model-agnostic, so a scenario about WHICH model answered (2026-09-18: a busy primary, a
// fallback that writes the letter) is written with ai.fail, keyed on cfg.model — never by queue position.
const ai = { queue: [], calls: [], fail: null };
const genaiPath = require.resolve('@google/generative-ai', { paths: [ROOT] });
require.cache[genaiPath] = { id: genaiPath, filename: genaiPath, loaded: true, exports: {
  GoogleGenerativeAI: class { getGenerativeModel(cfg) { return { generateContent: async (prompt, opts) => {
    ai.calls.push({ prompt, cfg, opts, t: Date.now() });
    const down = typeof ai.fail === 'function' ? ai.fail(cfg, prompt) : null;
    if (down) throw down;
    const next = ai.queue.length ? ai.queue.shift() : GOOD();
    if (next instanceof Error) throw next;
    if (next && next.slow) { await new Promise((r) => setTimeout(r, next.slow)); return { response: { text: () => next.text, candidates: [{ finishReason: 'STOP' }] } }; }
    return { response: { text: () => next, candidates: [{ finishReason: 'STOP' }] } };
  } }; } },
} };
const PARA = (n) => `Paragraph ${n} about **Node.js** and **PostgreSQL** work the candidate did across payment systems, reliability, observability and careful delivery for teams that ship every week without drama or heroics, with clear ownership of services from design review through production support and steady mentoring.`;
const GOOD = (over = {}) => JSON.stringify({ position: 'Senior Backend Engineer', to: 'Hiring Manager', addresses: [], cover_letter: [PARA(1), PARA(2), PARA(3), PARA(4)].join('\n\n'), ...over });

// ⚠️ 2026-09-18 — what Google answered for Amazon's letter, and the answers around it. The SDK's fetch errors carry the
// HTTP status as a number; the incident's own line is replayed message-only too, exactly as production logged it
// (production logged it for gemini-2.5-flash, the head of the chain that day; the replay speaks for whichever model
// heads the chain now, so the storm still lands on the model the lane asks FIRST).
// The chain itself — P (the primary), F1 (the first fallback), F2 (the last resort) — is read from aiText right after
// it is required below, never written out here.
const sdkErr = (model, status, statusText, text) => Object.assign(
  new Error(`[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent: [${status} ${statusText}] ${text}`),
  { status, statusText });
const E503 = (m) => sdkErr(m, 503, 'Service Unavailable', 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.');
const E429 = (m) => sdkErr(m, 429, 'Too Many Requests', 'Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing. [RESOURCE_EXHAUSTED]');
const INCIDENT_503 = (m) => new Error(`[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent: [503 Service Unavailable] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.`);

stub('ai-cover-letter-v2.js', { generateCoverLetter: async () => { throw new Error('legacy v2 must not be called'); } });
stub('ai-employer-researcher.js', { researchEmployer: async () => { throw new Error('researcher must not be called directly'); } });
stub('server/controllers/notificationsController.js', { notifyCoverLetterGenerated: async () => {}, notifyError: async () => {} });
// The operator's pager under the REAL aiHealth: a dead key (quota / auth) must page, and no push may leave this suite.
const pages = [];
stub('server/services/adminNotifier.js', { notifyAdmins: async (category, title, text, data) => { pages.push({ category, title, data }); } });
const stages = [];
stub('server/services/jobService.js', {
  createJob: async () => 'job1', failJob: async () => {}, completeJob: async () => {},
  updateJobProgress: async () => {}, updateJobPartialResult: async (id, r) => { stages.push(r); },
});
const rendered = { previews: [], pdf: 0, rich: 0, docx: 0 };
stub('server/controllers/emailController.js', { generateCoverLetterPDF: async (...a) => { rendered.rich++; rendered.richArgs = a; return { fileName: 'generic.pdf', filePath: '/tmp/generic.pdf' }; } });
stub('server/services/eventCosts.js', { getEventCost: async () => 1, refundCredits: async (...a) => { world.refunds = (world.refunds || []).concat([a]); }, chargeCredits: async () => ({}) });
stub('server/services/track.js', { emit: () => {} });
stub('server/utils/coverLetterRenderer.js', {
  renderPdf: async (id, data, opts) => { rendered.pdf++; rendered.pdfArgs = { id, data, opts }; return Buffer.from('%PDF fake'); },
  renderPreviews: async (data, opts, tpls) => { rendered.previews.push({ data, opts, ids: tpls.map((t) => t.id) }); return tpls.map((t) => ({ id: t.id, name: t.name, accent: t.accent, image: 'data:image/jpeg;base64,' + Buffer.from('img-' + t.id).toString('base64'), width: 794, height: 1123 })); },
});
stub('server/utils/docxBuilder.js', { buildCoverLetterDocx: async (data, opts) => { rendered.docx++; rendered.docxArgs = { data, opts }; return Buffer.from('PK'); } });
const hist = [];
stub('server/services/downloadHistory.js', { record: async (u, entry) => { hist.push(entry); return 1; } });
stub('server/controllers/discoverController.js', {
  websiteOf: (raw, name) => { const h = String(raw || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase(); if (!h || !h.includes('.')) return null; if (/linkedin|indeed|greenhouse\.io|myworkdayjobs/.test(h)) return null; return h; },
  ownsHost: (name, host) => String(host).split('.').slice(-2)[0] === String(name).toLowerCase(),
});
const rbFp = { value: null, calls: 0 };
stub('server/controllers/resumeBuilderController.js', { currentResumeFingerprint: async () => { rbFp.calls++; return rbFp.value; } });

// real modules under test (+ monkeypatched I/O)
const docs = require(path.join(ROOT, 'server/services/employerDocs.js'));
const store = { rows: [], nextId: 100, puts: [] };
docs.get = async (userId, kind, employer, fp, env) => store.rows.find((r) => r.user_id === userId && r.kind === kind && r.employer_key === String(employer).trim().toLowerCase().replace(/\s+/g, ' ') && r.input_fingerprint === fp && r.environment === env) || null;
docs.put = async (o) => { store.puts.push(o); if (store.failPut) return null; const row = { id: store.nextId++, user_id: o.userId, kind: o.kind, employer_key: String(o.employer).trim().toLowerCase().replace(/\s+/g, ' '), employer_name: o.employer, job_url: o.jobUrl, job_title: o.jobTitle, input_fingerprint: o.fingerprint, environment: o.env, payload: o.payload, research: o.research, design: o.design, employer_id: o.employerId, updated_at: new Date('2026-09-11T10:00:00Z') }; store.rows.push(row); return row.id; };
docs.getById = async (userId, id, reqOrEnv, { kind } = {}) => store.rows.find((r) => String(r.id) === String(id) && r.user_id === userId && (!kind || r.kind === kind)) || null;
const resumeDocs = { doc: null };
docs.currentFor = async (userId, kind) => (kind === 'resume' ? resumeDocs.doc : null);

const research = require(path.join(ROOT, 'server/services/employerResearch.js'));
const researchCalls = [];
// researchConv: the hiring conventions the research carries for the next builds (null = none known).
let researchConv = null;
research.getEmployerResearch = async (a) => { researchCalls.push(a); return { conventions: researchConv, ...{ domain: 'acme.test', employerName: 'Acme', industry: 'Fintech payments', companySize: '10,001+ employees', mission: 'Move money safely', technologies: ['Kafka'], clients: [], recentActivity: [], brandColor: '#1a73e8', fontName: 'Inter', fetchedAt: new Date().toISOString() } }; };
const scorer = require(path.join(ROOT, 'server/services/resumeScorer.js'));
const narr = { value: { text: 'Current title: Senior Backend Engineer\n\nEXPERIENCE\nSenior Backend Engineer at Payly | Jan 2016 – Present\n- Built the ledger service', source: 'builder' }, throwIt: null };
scorer.narrativeFor = async () => { if (narr.throwIt) throw narr.throwIt; return narr.value; };

const D = require(path.join(ROOT, 'server/services/downloads.js'));
const passSpy = { cover: false, coverCalls: [], claim: { charged: false }, claimCalls: [] };
D.passCoversGeneration = async (...a) => { passSpy.coverCalls.push(a); return passSpy.cover; };
D.claimGeneration = async (...a) => { passSpy.claimCalls.push(a); return passSpy.claim; };
// passStateFor (contract 3): READ-ONLY pass state for the sheet. Spied so the gate's kind and its answer are visible.
const passState = { calls: [], answer: { available: false, forThisEmployer: false } };
D.passStateFor = async (...a) => { passState.calls.push(a); return passState.answer; };
const dlSpy = { can: [], claim: [] };
const realCan = D.canDownload, realClaim = D.claimDownload;
D.canDownload = async (u, o, r) => { dlSpy.can.push(o && o.employer); return realCan(u, o, r); };
D.claimDownload = async (u, o, r) => { dlSpy.claim.push(o && o.employer); return realClaim(u, o, r); };

const EL = require(path.join(ROOT, 'server/controllers/employerLetterController.js'));
// aiText, the one Gemini call the lane makes. Its ~2 s pause before the primary's second try is shrunk to 25 ms (no
// jitter), so a scenario can still SEE the pause the incident lacked (the two 503s were 0 ms apart) without the
// suite spending seconds on it. Its own suite (test-ai-text.js) pins the real 2 s and the rest of the policy.
const AT = require(path.join(ROOT, 'server/services/aiText.js'));
AT._internals.settings.retryWaitMs = 25;
AT._internals.settings.retryJitterMs = 0;
// ⚠️ THE CHAIN THE LANE WALKS, read from the SAME aiText instance the controller requires (lazily, by the same
// resolved path — the storm scenarios wrap AT.generateText and see the lane's call through it, which proves it):
// P = the writing chain's primary, F1 = its first fallback, F2 = its last resort. Never written out as ids here.
const [P, F1, F2] = AT.writingChain();
/** The per-model config the writing chain lays over the lane's own config (only F1 has one: thinking OFF). */
const WRITING_CFG = AT.writing().modelConfig;
const CL = require(path.join(ROOT, 'server/controllers/coverLetterController.js'));
const routes = require(path.join(ROOT, 'server/routes/coverLetterRoutes.js'));

function mkRes() { const r = { statusCode: 200, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; }
const mkReq = (userId, body, extra = {}) => ({ user: { id: userId }, body, query: {}, headers: {}, ...extra });
const call = async (fn, userId, body, extra) => { const res = mkRes(); await fn(mkReq(userId, body, extra), res); return res; };
const reset = () => { ent.usageCalls = []; ent.usageThrows = false; passState.calls = []; passState.answer = { available: false, forThisEmployer: false }; researchConv = null; ai.queue = []; ai.calls = []; ai.fail = null; ent.consumed = []; ent.gateCalls = 0; ent.quota = { allowed: true, via: 'plan', remaining: 5 }; ent.quotaSeq = null; ent.used = { via: 'plan' }; ent.legacyEntitlements = false; passSpy.cover = false; passSpy.coverCalls = []; passSpy.claim = { charged: false }; passSpy.claimCalls = []; store.puts = []; store.failPut = false; researchCalls.length = 0; stages.length = 0; narr.throwIt = null; world.metaThrow = null; world.creditHistory = { n: 0, cost: 0 }; world.ledgerCredits = { n: 0 }; world.refunds = []; rendered.previews = []; resumeDocs.doc = null; rbFp.value = null; };
const JOB = { company: 'Acme', title: '', url: '', description: '', website: 'acme.test' };
const buildBody = (over = {}) => ({ coveredOnly: true, employer: 'Acme', employerId: '0f8fad5b-d9cb-469f-a165-70867728950e', country: 'United States', job: { ...JOB }, ...over });

(async () => {
  console.log('── routes ──');
  const stack = routes.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path} (${l.route.stack.length})`);
  ok('employer-gate registered (POST, auth + handler)', stack.includes('POST /cover-letter/employer-gate (2)'), stack);
  ok('employer-build registered (POST, auth + asJob)', stack.includes('POST /cover-letter/employer-build (2)'), stack);
  ok('employer-cards registered (GET, auth + handler)', stack.includes('GET /cover-letter/employer-cards (2)'), stack);
  ok('legacy routes still registered', stack.includes('POST /cover-letter/generate-template-pdf (2)') && stack.includes('POST /generate-cover-letter-details (2)'), stack);
  ok('exports', ['employerLetterGate', 'buildEmployerLetter', 'employerLetterCards', 'currentLetterFingerprint'].every((k) => typeof EL[k] === 'function'));
  ok('coverLetterController helper exports', ['formatCoverLetterWithHTML', 'buildCLSender', 'loadCLPhotoDataUri', 'lookupBrandColor'].every((k) => typeof CL[k] === 'function'));

  console.log('── build: refusals before any paid work ──');
  reset();
  let r = await call(EL.buildEmployerLetter, 7, buildBody({ employer: '', job: { ...JOB, company: '' } }));
  ok('no employer → 400 invalid_employer', r.statusCode === 400 && r.body.reason === 'invalid_employer', r.body);
  reset(); narr.value = null;
  r = await call(EL.buildEmployerLetter, 7, buildBody());
  ok('no résumé → 400 no_resume', r.statusCode === 400 && r.body.reason === 'no_resume', r.body);
  ok('…no AI, no gate, no charge', ai.calls.length === 0 && ent.gateCalls === 0 && ent.consumed.length === 0);
  narr.value = { text: 'Current title: Senior Backend Engineer\n\nEXPERIENCE\nSenior Backend Engineer at Payly | Jan 2016 – Present\n- Built the ledger service', source: 'builder' };
  reset(); narr.throwIt = new Error('connection terminated');
  r = await call(EL.buildEmployerLetter, 7, buildBody());
  ok('unreadable résumé → 500 failed (not no_resume)', r.statusCode === 500 && r.body.reason === 'failed', r.body);
  ok('…no AI, no charge', ai.calls.length === 0 && ent.consumed.length === 0);
  reset(); world.metaThrow = Object.assign(new Error('boom'), { code: '08006' });
  r = await call(EL.buildEmployerLetter, 7, buildBody());
  ok('unreadable upload → 500 failed', r.statusCode === 500 && r.body.reason === 'failed', r.body);
  reset(); world.metaThrow = Object.assign(new Error('no table'), { code: '42P01' });
  const fpNoTable = await EL.currentLetterFingerprint(7, { job: JOB, env: 'Production' });
  ok('missing resume_metadata table = no upload, fingerprint still computed', typeof fpNoTable === 'string' && fpNoTable.length === 64);
  world.metaThrow = null;

  reset(); ent.quota = { allowed: true, via: 'credits', remaining: 3 };
  r = await call(EL.buildEmployerLetter, 7, buildBody({ coveredOnly: true }));
  ok('coveredOnly + only credits could pay → 402 quota_exhausted', r.statusCode === 402 && r.body.reason === 'quota_exhausted', r.body);
  ok('⚠️ …before research and before any AI call', researchCalls.length === 0 && ai.calls.length === 0, { research: researchCalls.length, ai: ai.calls.length });
  ok('…the pass was consulted in full (boundOnly false)', passSpy.coverCalls.length === 1 && passSpy.coverCalls[0][4].boundOnly === false, passSpy.coverCalls);
  ok('…nothing consumed, nothing stored', ent.consumed.length === 0 && store.puts.length === 0);

  reset(); ent.quota = { allowed: false, via: null, message: "You've used your free cover letters." };
  r = await call(EL.buildEmployerLetter, 7, buildBody({ coveredOnly: false }));
  ok('no quota, no pass → 402 with the gate message', r.statusCode === 402 && r.body.reason === 'quota_exhausted' && /free cover letters/.test(r.body.error), r.body);

  console.log('── build: the happy path (plan) ──');
  reset();
  r = await call(EL.buildEmployerLetter, 7, buildBody(), { __jobId: 'job-7' });
  ok('200 success, not cached, a docId', r.statusCode === 200 && r.body.success === true && r.body.cached === false && Number.isInteger(r.body.docId), r.body);
  ok('tailoredFor = the company', r.body.tailoredFor === 'Acme');
  ok('exactly ONE AI call', ai.calls.length === 1, ai.calls.length);
  ok('no search tool, JSON mime + schema on the call', ai.calls[0].cfg.generationConfig.responseMimeType === 'application/json' && !!ai.calls[0].cfg.generationConfig.responseSchema);
  // ADDED 2026-09-18 (the writing chain): a healthy Google answers from the writing chain's HEAD, called with the
  // lane's own config exactly — the thinking-off entry belongs to F1 alone and must never ride along on the primary.
  ok('…written by the writing chain\'s primary, with the lane\'s config untouched (no thinkingConfig)',
    ai.calls[0].cfg.model === P && !('thinkingConfig' in ai.calls[0].cfg.generationConfig), { model: ai.calls[0].cfg.model, cfg: Object.keys(ai.calls[0].cfg.generationConfig) });
  ok('exactly ONE consume, kind cover_letter', ent.consumed.length === 1 && ent.consumed[0].kind === 'cover_letter', ent.consumed);
  ok('research called with the vetted website', researchCalls.length === 1 && researchCalls[0].website === 'acme.test' && researchCalls[0].name === 'Acme', researchCalls);
  const put = store.puts[0] || {};
  ok('put kind cover_letter + employerId + research + design', put.kind === 'cover_letter' && put.employerId === '0f8fad5b-d9cb-469f-a165-70867728950e' && put.research && put.research.domain === 'acme.test' && put.design && put.design.kind === 'cover_letter', { kind: put.kind, eid: put.employerId });
  ok('design ranks all 7 letter templates, sorted desc', put.design && put.design.ranked.length === 7 && put.design.ranked.every((x, i, a) => i === 0 || a[i - 1].score >= x.score), put.design && put.design.ranked);
  ok('region from country (us_ca)', put.design && put.design.region === 'us_ca', put.design && put.design.region);
  const pl = put.payload || {};
  ok('payload keys exactly as the contract', JSON.stringify(Object.keys(pl).sort()) === JSON.stringify(['brandColor', 'companyAddress', 'companyName', 'coverLetterHtml', 'fontName', 'hiringManager', 'locations', 'position', 'subject'].sort()), Object.keys(pl));
  ok('coverLetterHtml is <p> html with <strong>', /<p [^>]*>/.test(pl.coverLetterHtml) && /<strong>Node\.js<\/strong>/.test(pl.coverLetterHtml), pl.coverLetterHtml && pl.coverLetterHtml.slice(0, 120));
  ok('companyName is the picked name', pl.companyName === 'Acme');
  ok('open application: position from the résumé title, subject has no artefact', pl.position === 'Senior Backend Engineer' && pl.subject === 'Application for Senior Backend Engineer — Jane Doe', { position: pl.position, subject: pl.subject });
  ok('no address invented, hiring manager default', pl.companyAddress === '' && pl.locations.length === 0 && pl.hiringManager === 'Hiring Manager', pl);
  ok('brandColor/fontName from research', pl.brandColor === '#1a73e8' && pl.fontName === 'Inter', pl);
  ok('model column ≤ 48', String(put.model).length <= 48);
  const st = stages.map((s) => s.stage);
  ok('stages in order', JSON.stringify(st) === JSON.stringify(['reading', 'researching', 'writing', 'designing', 'saving', 'pages']), st);
  ok('stage labels per contract', stages.find((s) => s.stage === 'writing').label === 'Writing your Acme cover letter' && stages.find((s) => s.stage === 'researching').label === 'Researching Acme' && stages.find((s) => s.stage === 'designing').label === 'Ranking letter designs', stages);
  ok('stage pcts monotonic', stages.every((s, i, a) => i === 0 || a[i - 1].pct <= s.pct), stages.map((s) => s.pct));
  ok('thumbs pre-rendered for the top 2 designs in one batch', rendered.previews.length === 1 && rendered.previews[0].ids.length === 2 && rendered.previews[0].ids[0] === put.design.ranked[0].id, rendered.previews.map((p) => p.ids));
  const thumbFiles = fsSync.readdirSync(path.join(THUMBS, '7')).filter((n) => n.startsWith('cl_'));
  ok('thumb files written under <root>/<userId>/cl_*.jpg', thumbFiles.length === 2 && thumbFiles.every((n) => /^cl_[0-9a-f]{64}\.jpg$/.test(n)), thumbFiles);
  const prompt1 = ai.calls[0].prompt;
  ok('prompt carries the research block with letter rules', /=== WHAT WE KNOW ABOUT Acme/.test(prompt1) && /You may reference clearly public facts/.test(prompt1));
  ok('prompt: open application instructions, no "(open application)" artefact asked', /no job posting was given/.test(prompt1) && /Never call it an "open"/.test(prompt1));
  ok('prompt carries the upload context minus bookkeeping', /Backend engineer, Node, Postgres/.test(prompt1) && !/parsed_at/.test(prompt1) && !/"id"/.test(prompt1));

  console.log('── fingerprints agree: gate == build == stale label ──');
  const buildFp = put.fingerprint;
  const cur = await EL.currentLetterFingerprint(7, { job: { company: 'Acme', website: 'acme.test' }, country: 'United States', env: mkReq(7, {}) });
  ok('currentLetterFingerprint equals the stored fingerprint', cur === buildFp, { cur, buildFp });
  const curOtherCountry = await EL.currentLetterFingerprint(7, { job: { company: 'Acme', website: 'acme.test', title: undefined }, country: 'Germany', env: 'Production' });
  // RENAMED 2026-09-14 (letter-v2): the country and the conventions DO set the letter's tone and length now — they are
  // just never hashed, so a change of tone is never a billed Refresh.
  ok('⚠️ country is not a fingerprint input (it shapes tone, and a tone change must never bill a Refresh)', curOtherCountry === buildFp);
  const curTitle = await EL.currentLetterFingerprint(7, { job: { company: 'Acme', website: 'acme.test', title: 'Staff Engineer' }, env: 'Production' });
  ok('a posting title moves it', curTitle !== buildFp);
  const curSandbox = await EL.currentLetterFingerprint(7, { job: { website: 'acme.test' }, env: 'Sandbox' });
  ok('env is accepted as a string', typeof curSandbox === 'string');
  narr.throwIt = new Error('db down');
  ok('unreadable → null, never a throw', (await EL.currentLetterFingerprint(7, { job: JOB, env: 'Production' })) === null);
  narr.throwIt = null;

  console.log('── ⚠️ contract C2: `expectVia` — the payer the user CONFIRMED, refused with 409 before anything binds or charges ──');
  {
    // Home's sheet names a payer; the build the user confirms sends it back. A letter this lane would now pay for some
    // OTHER way is refused with 409 payer_changed — nothing bound, charged or stored — and one confirmed as a free cache
    // hit that misses is 409 cache_miss before every gate. No expectVia = the lane decides alone, as in every scenario above.
    const stripC2 = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const dbExports = require.cache[require.resolve(path.join(ROOT, 'db-config.js'))].exports;
    const origGetC2 = dbExports.get;
    const c2 = (title, over = {}) => buildBody({ job: { ...JOB, title }, ...over });
    reset();
    r = await call(EL.buildEmployerLetter, 7, c2('C2 cache role', { expectVia: 'cache' }));
    ok('confirmed as a saved letter that is not there → 409 cache_miss', r.statusCode === 409 && r.body.reason === 'cache_miss' && r.body.success === false && !r.body.docId, r.body);
    ok('⚠️ …before every gate: no quota read, no reservation, no research, no AI, nothing stored',
      ent.gateCalls === 0 && passSpy.coverCalls.length === 0 && researchCalls.length === 0 && ai.calls.length === 0 && store.puts.length === 0 && ent.consumed.length === 0);

    reset(); ent.quota = { allowed: true, via: 'free', remaining: 2 };
    r = await call(EL.buildEmployerLetter, 7, c2('C2 plan-vs-free role', { expectVia: 'plan' }));
    ok('confirmed as the plan while the FREE allowance would pay → 409 payer_changed', r.statusCode === 409 && r.body.reason === 'payer_changed' && r.body.success === false, r.body);
    ok('⚠️ …after the quota read and before the reservation: passCoversGeneration never called, no research, no AI, no charge',
      ent.gateCalls === 1 && passSpy.coverCalls.length === 0 && researchCalls.length === 0 && ai.calls.length === 0 && ent.consumed.length === 0 && store.puts.length === 0, { gates: ent.gateCalls, cover: passSpy.coverCalls.length });

    reset();
    r = await call(EL.buildEmployerLetter, 7, c2('C2 unreadable role', { expectVia: { via: 'plan' } }));
    ok('⚠️ a payer word we cannot read is a confirmation we cannot honour → 409 payer_changed, never a charge on a guess',
      r.statusCode === 409 && r.body.reason === 'payer_changed' && ai.calls.length === 0 && ent.consumed.length === 0, r.body);

    reset(); ent.quota = { allowed: false, via: null, message: 'no quota' };
    r = await call(EL.buildEmployerLetter, 7, c2('C2 pass-gone role', { expectVia: 'pass' }));
    ok('confirmed as the pass, and no pass would pay → 409 payer_changed (not 402), BEFORE the reservation',
      r.statusCode === 409 && r.body.reason === 'payer_changed' && passSpy.coverCalls.length === 0 && ai.calls.length === 0, r.body);
    r = await call(EL.buildEmployerLetter, 7, c2('C2 plan-gone role', { expectVia: 'plan' }));
    ok('confirmed as the plan, and the plan is gone → 409 payer_changed, not the 402 an unconfirmed build gets', r.statusCode === 409 && r.body.reason === 'payer_changed' && store.puts.length === 0, r.body);
    r = await call(EL.buildEmployerLetter, 7, c2('C2 plan-gone role'));
    ok('…while the SAME build with no expectVia is the plain 402 it always was', r.statusCode === 402 && r.body.reason === 'quota_exhausted', r.body);

    // 'pass' confirmed and a takeable pass really is there (the read-only twin sees it): the reservation runs and pays.
    dbExports.get = async (sql, params) => {
      const q = norm(sql); world.sql.push(q);
      if (/letter_generated_at IS NULL AND \(bound_at IS NULL OR employer_key = \$3\)/.test(q)) return { id: 5 };
      return origGetC2(sql, params);
    };
    reset(); ent.quota = { allowed: false, via: null, message: 'no quota' }; passSpy.cover = true; passSpy.claim = { charged: true, passId: 5 };
    r = await call(EL.buildEmployerLetter, 7, c2('C2 pass-pays role', { expectVia: 'pass' }));
    ok('confirmed as the pass, with a takeable pass → 200, stored, claimed on the pass, the plan NOT consumed',
      r.statusCode === 200 && store.puts.length === 1 && passSpy.coverCalls.length === 1 && passSpy.coverCalls[0][4].boundOnly === false && passSpy.claimCalls.length === 1 && ent.consumed.length === 0, { status: r.statusCode, body: r.body });
    dbExports.get = origGetC2;

    reset();
    r = await call(EL.buildEmployerLetter, 7, c2('C2 plan-pays role', { expectVia: 'plan' }));
    ok('confirmed as the plan, and the plan pays → 200, one AI call, one plan consumption, stored', r.statusCode === 200 && ai.calls.length === 1 && ent.consumed.length === 1 && store.puts.length === 1, r.body);
    reset();
    r = await call(EL.buildEmployerLetter, 7, c2('C2 plan-pays role', { expectVia: 'cache' }));
    ok('…and confirmed as a saved letter that IS there → the free hit, as always', r.statusCode === 200 && r.body.cached === true && ent.gateCalls === 0 && ai.calls.length === 0, r.body);

    // ⚠️ AT THE MOMENT OF PAYMENT: the gate said plan; the re-check says the FREE allowance would pay now.
    reset(); ent.quotaSeq = [{ allowed: true, via: 'plan', remaining: 1 }, { allowed: true, via: 'trial', remaining: 2 }];
    r = await call(EL.buildEmployerLetter, 7, c2('C2 plan-ended role', { expectVia: 'plan' }));
    ok('⚠️ the plan ended mid-write and the FREE allowance would pay → 409 payer_changed after the AI, nothing consumed, nothing stored',
      r.statusCode === 409 && r.body.reason === 'payer_changed' && ai.calls.length === 1 && ent.consumed.length === 0 && store.puts.length === 0, { status: r.statusCode, body: r.body, gates: ent.gateCalls });

    // ⚠️ ON WHAT ACTUALLY PAID: consumeOnSuccess picked the free pool where the plan was confirmed → given back, refused.
    reset(); ent.used = { via: 'trial' };
    const sqlC2 = world.sql.length;
    r = await call(EL.buildEmployerLetter, 7, c2('C2 trial-paid role', { expectVia: 'plan' }));
    ok('⚠️ consumeOnSuccess paid from the free pool where the plan was confirmed → 409 payer_changed, the usage row given back by its own id, nothing stored',
      r.statusCode === 409 && r.body.reason === 'payer_changed' && ent.consumed.length === 1 && store.puts.length === 0
      && world.sql.slice(sqlC2).includes('RUN DELETE FROM usage_ledger WHERE id = $1 AND user_id = $2'), { status: r.statusCode, body: r.body });
    reset(); ent.used = { via: 'trial' };
    r = await call(EL.buildEmployerLetter, 7, c2('C2 trial-paid role'));
    ok('…the same build with NO expectVia is stored on the free pool (an older app keeps today\'s behaviour)', r.statusCode === 200 && r.body.cached === false && store.puts.length === 1, r.body);
    reset();
    {
      const src = stripC2(fsSync.readFileSync(path.join(ROOT, 'server/controllers/employerLetterController.js'), 'utf8'));
      const iWould = src.indexOf('passWouldCoverLetter(userId, company, req, { boundOnly })');
      const iBind = src.indexOf(".passCoversGeneration(userId, 'cover_letter', company, req, { boundOnly })");
      ok('⚠️ the confirmed payer is compared BEFORE passCoversGeneration (the reservation that BINDS), and both refusals are frozen 409s',
        iWould > 0 && iBind > iWould && /const PAYER_CHANGED = Object\.freeze\(\{\s*status: 409/.test(src) && /const CACHE_MISS = Object\.freeze\(\{\s*status: 409/.test(src), { iWould, iBind });
      ok('…one vocabulary, read through downloads (expectedPayerOf / quotaPayerOf / payerWordOf) — never the raw strings',
        /const expectVia = downloads\.expectedPayerOf\(body\);/.test(src) && /downloads\.quotaPayerOf\(now\) !== expectVia/.test(src) && /downloads\.namesPayer\(via\) && downloads\.payerWordOf\(via\) !== expectVia/.test(src));
      // ⚠️ THE MONEY CONSTANT: a bump re-bills every saved letter (the fingerprint carries it). The 2026-09-14 round bumped it
      // to letter-v2 for a tone change that is not a fingerprint input; it is back, and it stays.
      ok('⚠️ LETTER_REV stays letter-v1 — a bump re-bills every saved letter', /const LETTER_REV = 'letter-v1';/.test(src));
    }
  }

  console.log('── gate ──');
  reset();
  r = await call(EL.employerLetterGate, 7, { employer: 'Acme', employerId: 'x', country: 'United States', job: { website: 'acme.test' } });
  ok('the stored letter → covered via cache', r.body.covered === true && r.body.via === 'cache' && r.body.credits === null && r.body.reason === null, r.body);
  ok('⚠️ …without asking the quota', ent.gateCalls === 0);
  ok('⚠️ a cache hit carries usage:null, pass:null and reads neither (no sheet on a free path)',
    r.body.usage === null && r.body.pass === null && ent.usageCalls.length === 0 && passState.calls.length === 0, r.body);
  reset();
  r = await call(EL.employerLetterGate, 7, { employer: 'Acme', job: { website: 'acme.test', title: 'Staff Engineer' } });
  ok('plan covers → via plan', r.body.covered === true && r.body.via === 'plan', r.body);
  ok('⚠️ a non-cache answer carries usage (usageFor for the COVER LETTER) and pass { available, forThisEmployer }',
    r.body.usage && r.body.usage.kind === 'cover_letter' && r.body.usage.remaining === 2 && JSON.stringify(ent.usageCalls) === JSON.stringify(['cover_letter'])
    && JSON.stringify(r.body.pass) === JSON.stringify({ available: false, forThisEmployer: false }), r.body);
  ok('⚠️ …the pass state is asked for the cover_letter kind (never the resume\'s unused generation), for this employer',
    passState.calls.length === 1 && passState.calls[0][1] === 'Acme' && passState.calls[0][3] && passState.calls[0][3].kind === 'cover_letter', passState.calls);
  ok('…and never through passCoversGeneration (a reservation)', passSpy.coverCalls.every((c) => c[4] && c[4].boundOnly === true), passSpy.coverCalls);
  reset(); ent.usageThrows = true; passState.answer = { available: true, forThisEmployer: true, extra: 'dropped' };
  r = await call(EL.employerLetterGate, 7, { employer: 'Acme', job: { website: 'acme.test', title: 'Staff Engineer' } });
  ok('an unreadable count → usage:null, the gate unchanged; pass trimmed to its two fields',
    r.statusCode === 200 && r.body.via === 'plan' && r.body.usage === null && JSON.stringify(r.body.pass) === JSON.stringify({ available: true, forThisEmployer: true }), r.body);
  reset(); ent.quota = { allowed: true, via: 'free', remaining: 2 };
  r = await call(EL.employerLetterGate, 7, { employer: 'Beta', job: {} });
  ok('free covers → via free', r.body.covered === true && r.body.via === 'free', r.body);
  reset(); ent.quota = { allowed: true, via: 'credits', remaining: 9 };
  const sqlBefore = world.sql.length;
  r = await call(EL.employerLetterGate, 7, { employer: 'Beta', job: {} });
  ok('credits → covered false via credits with the price', r.body.covered === false && r.body.via === 'credits' && r.body.credits === 1 && r.body.reason === null, r.body);
  ok('⚠️ dry run: no UPDATE / INSERT / RUN executed', !world.sql.slice(sqlBefore).some((q) => /^(UPDATE|INSERT|DELETE|RUN)/i.test(q)), world.sql.slice(sqlBefore));
  ok('…and no reservation (passCoversGeneration never called)', passSpy.coverCalls.length === 0);
  reset(); ent.quota = { allowed: false, via: null };
  r = await call(EL.employerLetterGate, 7, { employer: 'Beta', job: {} });
  ok('nothing → reason quota_exhausted', r.body.covered === false && r.body.via === null && r.body.reason === 'quota_exhausted', r.body);
  // read-only pass twin
  {
    const realGet = world.passHook;
    const passRows = { owned: null, free: null, takeable: { id: 5 } };
    const origGet = require.cache[require.resolve(path.join(ROOT, 'db-config.js'))].exports.get;
    require.cache[require.resolve(path.join(ROOT, 'db-config.js'))].exports.get = async (sql, params) => {
      const q = norm(sql); world.sql.push(q);
      if (/letter_generated_at IS NULL AND \(bound_at IS NULL OR employer_key = \$3\)/.test(q)) return passRows.takeable;
      return origGet(sql, params);
    };
    reset(); ent.quota = { allowed: true, via: 'credits', remaining: 9 };
    const before = world.sql.length;
    r = await call(EL.employerLetterGate, 7, { employer: 'Beta', job: {} });
    ok('credits-only + a takeable pass → covered via pass', r.body.covered === true && r.body.via === 'pass', r.body);
    ok('⚠️ …still read-only', !world.sql.slice(before).some((q) => /^(UPDATE|INSERT|DELETE|RUN)/i.test(q)));
    reset(); ent.quota = { allowed: true, via: 'plan', remaining: 9 };
    r = await call(EL.employerLetterGate, 7, { employer: 'Beta', job: {} });
    ok('plan covers → an UNBOUND pass is left alone (via plan)', r.body.via === 'plan', r.body);
    require.cache[require.resolve(path.join(ROOT, 'db-config.js'))].exports.get = origGet;
    void realGet;
  }

  console.log('── build: cache hit is free ──');
  reset();
  r = await call(EL.buildEmployerLetter, 7, buildBody(), { __jobId: 'job-8' });
  ok('same inputs → cached:true with the stored docId', r.statusCode === 200 && r.body.cached === true && r.body.docId === put.id || r.body.docId === store.rows[0].id, r.body);
  ok('⚠️ no AI, no quota, no pass, no consume, no put', ai.calls.length === 0 && ent.gateCalls === 0 && passSpy.coverCalls.length === 0 && ent.consumed.length === 0 && store.puts.length === 0);
  ok('reports cached 90 with the contract label', stages.some((s) => s.stage === 'cached' && s.pct === 90 && s.label === 'Found your Acme letter'), stages);

  console.log('── build: placeholder guard ──');
  reset();
  ai.queue = [GOOD({ cover_letter: [PARA(1), 'Improved settlement speed by [X%] for merchants and reduced disputes by XX% across regions over two years of steady work on the platform and its tooling.', PARA(3), PARA(4)].join('\n\n') }), GOOD()];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'Staff Engineer' } }));
  ok('one corrective pass (2 AI calls), then stored', r.statusCode === 200 && ai.calls.length === 2, { status: r.statusCode, calls: ai.calls.length });
  ok('corrective prompt lists the tokens', /CORRECTION/.test(ai.calls[1].prompt) && ai.calls[1].prompt.includes('[X%]'));
  ok('stored html has no placeholder', !/\[X%\]|XX%/.test(store.puts[0].payload.coverLetterHtml));
  ok('posting title used exactly', store.puts[0].payload.position === 'Staff Engineer' && store.puts[0].payload.subject === 'Application for Staff Engineer — Jane Doe', store.puts[0].payload);
  reset();
  const BAD = GOOD({ cover_letter: [PARA(1), 'Improved settlement speed by [X%] for merchants and reduced disputes by XX% across regions over two years of steady work on the platform and its tooling.', PARA(3), PARA(4)].join('\n\n') });
  ai.queue = [BAD, BAD];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'Principal Engineer' } }));
  const html2 = (store.puts[0] || { payload: {} }).payload.coverLetterHtml || '';
  ok('still present after the corrective pass → stripped, stored', r.statusCode === 200 && !/\[|XX%/.test(html2), html2.slice(0, 400));
  ok('"by [X%]" removed with its dangling by', /Improved settlement speed for merchants and reduced disputes across regions/.test(html2), html2.match(/Improved[^<]*/));

  console.log('── build: salutation / sign-off never doubled ──');
  reset();
  ai.queue = [GOOD({ cover_letter: ['Dear Hiring Manager,', PARA(1), PARA(2), PARA(3), PARA(4) + '\nSincerely,\nJane Doe'].join('\n\n') })];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'Lead Engineer' } }));
  const html3 = store.puts[0].payload.coverLetterHtml;
  ok('no "Dear", no "Sincerely", no trailing name', !/Dear Hiring/i.test(html3) && !/Sincerely/i.test(html3) && !/Jane Doe/.test(html3), html3.slice(-300));

  console.log('── build: AI failures charge nothing ──');
  // Every "which model" scenario below needs a real three-model chain: with a repeated or missing id, "the primary
  // twice, then the first fallback" would not describe a fallback at all.
  ok('the writing chain the lane walks has three distinct models (P, F1, F2)',
    [P, F1, F2].every((m) => typeof m === 'string' && m) && new Set([P, F1, F2]).size === 3 && AT.writingChain().length === 3, AT.writingChain());
  reset(); ai.queue = ['not json', '{"cover_letter":"too short"}'];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'QA Lead' } }));
  ok('two bad outputs → 500 failed', r.statusCode === 500 && r.body.reason === 'failed', r.body);
  ok('⚠️ no consume, no put', ent.consumed.length === 0 && store.puts.length === 0);
  // ADDED 2026-09-18: output the LANE rejects is the lane's own retry — never a provider failure. The second draft is
  // asked of the same primary; the fallback chain is for a BUSY model and is never walked for bad output.
  ok('⚠️ …both drafts asked of the primary: bad output is not an overload, so no fallback is walked for it',
    ai.calls.length === 2 && ai.calls.every((c) => c.cfg.model === P), ai.calls.map((c) => c.cfg.model));
  // ⚠️ RETARGETED 2026-09-18 (was "two timeouts → 504"): a timeout is a hung model, and a hung model is exactly what the
  // fallback chain is for. The primary is tried twice, with a pause, and then the next model writes the letter.
  reset(); ai.queue = [new Error('AI_TIMEOUT'), new Error('AI_TIMEOUT')];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'QA Lead' } }));
  ok('two timeouts on the primary → the first fallback writes it: 200, charged once, the fallback stored as its writer',
    r.statusCode === 200 && ai.calls.map((c) => c.cfg.model).join() === [P, P, F1].join() && ent.consumed.length === 1 && store.puts.length === 1 && store.puts[0].model === F1,
    { status: r.statusCode, models: ai.calls.map((c) => c.cfg.model), model: store.puts[0] && store.puts[0].model });

  console.log('── ⚠️ 2026-09-18: GOOGLE BUSY (Amazon\'s letter: two 503s, 0 ms apart, "That cover letter didn\'t finish") ──');
  {
    // Production, user 1, Home → Cover letters → Amazon: gemini-2.5-flash (the head of the chain that day) answered 503
    // "high demand" twice, back to back, and the letter died. The lane now asks through aiText — a pause, the primary
    // once more, then the rest of the WRITING chain (aiText.writing(): P, then F1, then F2 — the head is no longer
    // gemini-2.5-flash, so every storm here is scripted on P, the model the lane asks first today)
    // — all inside ONE AI window, all before the charge. A fallback's letter is stored as ITS letter, under the same
    // fingerprint (a later identical request is a free hit); when no model can answer, nothing is charged or stored,
    // the answer is an honest 503 ai_busy / ai_down, and any build waiting on this one is released.
    const LA = EL.LETTER_AI || {};   // the lane's AI window (its absence is a failure below, not a crash here)
    const modelsOf = () => ai.calls.map((c) => c.cfg.model);
    // The config one call received, as JSON; { dropThinking } leaves out thinkingConfig, to compare F1's call with the rest.
    const cfgOf = (c, { dropThinking = false } = {}) => {
      const g = { ...(c.cfg.generationConfig || {}) };
      if (dropThinking) delete g.thinkingConfig;
      return JSON.stringify(g);
    };
    const runsSince = (mark) => world.sql.slice(mark).filter((q) => /^RUN /.test(q));
    const labelsOf = (stage) => stages.filter((s) => s.stage === stage).map((s) => s.label);
    const gt = [];   // every generateText call the lane makes, exactly as it made it
    const realGT = AT.generateText;
    AT.generateText = (o) => { gt.push(o); return realGT(o); };
    const STORM_JOB = { company: 'Amazon', title: 'Storm Role', url: '', description: '', website: 'amazon.test' };
    const storm = (title) => buildBody({ employer: 'Amazon', job: { ...STORM_JOB, title } });
    const PLACEHOLDER_DRAFT = GOOD({ cover_letter: [PARA(1), 'Improved settlement speed by [X%] for merchants and reduced disputes by XX% across regions over two years of steady work on the platform and its tooling.', PARA(3), PARA(4)].join('\n\n') });

    // 1. the incident, replayed: the primary answers exactly what production logged, every time it is asked
    reset(); gt.length = 0; ai.fail = (cfg) => (cfg.model === P ? INCIDENT_503(P) : null);
    r = await call(EL.buildEmployerLetter, 7, storm('Storm Role'), { __jobId: 'job-storm' });
    const putS = store.puts[0] || {};
    const stormDocId = r.body && r.body.docId;
    ok('⚠️ a 503 storm on the primary still writes the letter: 200, a docId', r.statusCode === 200 && r.body.success === true && r.body.cached === false && Number.isInteger(stormDocId), r.body);
    ok('…the primary twice, then the first fallback — three calls, and never a second chain on top', modelsOf().join() === [P, P, F1].join(), modelsOf());
    ok('⚠️ …with a PAUSE before the primary\'s second try (the incident\'s two 503s were 0 ms apart)',
      ai.calls.length >= 2 && ai.calls[1].t - ai.calls[0].t >= 20, ai.calls.map((c) => c.t - ai.calls[0].t));
    // ⚠️ REWRITTEN 2026-09-18 (the writing chain): "identical on every call" is no longer true BY DESIGN. F1
    // (gemini-2.5-flash) is called with thinking OFF — aiText lays WRITING_MODEL_CONFIG[F1] over the lane's config for
    // that model only — so the claim now is: the lane's OWN config on every call, and on F1's call that config plus
    // thinkingConfig { thinkingBudget: 0 } and NOTHING else; the primary's calls carry no thinkingConfig at all.
    const gcF1 = (ai.calls[2] || { cfg: { generationConfig: {} } }).cfg.generationConfig;
    ok('…the fallback asked with the lane\'s OWN config — JSON mime + schema, 0.7, 32768 tokens — the same as the primary\'s but for F1\'s thinking switch',
      ai.calls.length === 3 && cfgOf(ai.calls[1]) === cfgOf(ai.calls[0]) && cfgOf(ai.calls[2], { dropThinking: true }) === cfgOf(ai.calls[0])
      && gcF1.responseMimeType === 'application/json' && !!gcF1.responseSchema && gcF1.temperature === 0.7 && gcF1.maxOutputTokens === 32768,
      ai.calls.map((c) => cfgOf(c)));
    ok('⚠️ …F1 is called with thinkingConfig { thinkingBudget: 0 } merged over the lane\'s config, and the primary\'s calls carry NO thinkingConfig',
      ai.calls.length === 3 && ai.calls[2].cfg.model === F1 && JSON.stringify(gcF1.thinkingConfig) === JSON.stringify({ thinkingBudget: 0 })
      && ai.calls.slice(0, 2).every((c) => c.cfg.model === P && !('thinkingConfig' in c.cfg.generationConfig)),
      ai.calls.map((c) => ({ model: c.cfg.model, thinking: c.cfg.generationConfig.thinkingConfig })));
    ok('…every attempt carries an abort signal: a hung model is CANCELLED at its cap, not merely stopped waiting for',
      ai.calls.every((c) => c.opts && c.opts.signal && typeof c.opts.signal.aborted === 'boolean'));
    ok('⚠️ charged EXACTLY once, stored once', ent.consumed.length === 1 && store.puts.length === 1, { consumed: ent.consumed.length, puts: store.puts.length });
    ok('⚠️ the stored letter records the model that WROTE it (the fallback), not the lane\'s first choice', putS.model === F1, putS.model);
    ok('the user is told in plain words: "busy — trying again", then "switching to a backup model"',
      JSON.stringify(labelsOf('retry')) === JSON.stringify(["Google's AI is busy — trying again", 'Switching to a backup model']), stages);
    // ⚠️ REWRITTEN 2026-09-18 (the writing chain): the old claim — the lane passes [LETTER_MODEL, …fallbackModels()] — is
    // no longer true BY DESIGN. The letter is a DOCUMENT lane: it spreads aiText.writing() into the call, so it passes that
    // chain AND its per-model config. Without the modelConfig, F1 would think: 3x the cost per letter, and the letters the
    // blind evaluation scored lower (aiText WRITING_PRIMARY).
    ok('the lane asks through aiText ONCE, as "letter", with aiText.writing()\'s chain AND its modelConfig, and a budget inside its AI window',
      gt.length === 1 && gt[0].lane === 'letter'
      && JSON.stringify(gt[0].models) === JSON.stringify(AT.writing().models) && JSON.stringify(gt[0].models) === JSON.stringify([P, F1, F2])
      && !!gt[0].modelConfig && JSON.stringify(gt[0].modelConfig) === JSON.stringify(AT.writing().modelConfig)
      && gt[0].budgetMs > 0 && gt[0].budgetMs <= LA.draftBudgetMs && typeof gt[0].onRetry === 'function',
      gt.map((g) => ({ lane: g.lane, models: g.models, modelConfig: g.modelConfig, budgetMs: g.budgetMs })));
    ok('…not the old [LETTER_MODEL, …fallbackModels()] chain, and the lane\'s own config carries no thinking setting of its own',
      gt.length === 1 && JSON.stringify(gt[0].models) !== JSON.stringify([EL.LETTER_MODEL, ...AT.fallbackModels()])
      && !!gt[0].config && !('thinkingConfig' in gt[0].config), gt.map((g) => ({ models: g.models, config: g.config && Object.keys(g.config) })));
    ok('…a modelConfig that switches thinking OFF for F1 and for no other model of the chain',
      JSON.stringify(WRITING_CFG[F1]) === JSON.stringify({ thinkingConfig: { thinkingBudget: 0 } }) && !WRITING_CFG[P] && !WRITING_CFG[F2], WRITING_CFG);

    // 2. ⚠️ THE MONEY LINE: who wrote a letter is not an input. The fallback's letter carries the fingerprint the gate, the
    // build and the stale label compute, so the next identical request is FREE — exactly as a primary-written one is.
    ok('⚠️ the fallback-written letter\'s fingerprint is the one the gate and the stale label compute',
      !!putS.fingerprint && putS.fingerprint === await EL.currentLetterFingerprint(7, { job: STORM_JOB, env: mkReq(7, {}) }), putS.fingerprint);
    reset(); gt.length = 0;   // Google is healthy again
    r = await call(EL.buildEmployerLetter, 7, storm('Storm Role'));
    ok('⚠️ the same request again is a FREE cache hit on the fallback\'s letter: no AI, no gate, no charge, no new row',
      r.statusCode === 200 && r.body.cached === true && r.body.docId === stormDocId && ai.calls.length === 0 && gt.length === 0
      && ent.gateCalls === 0 && ent.consumed.length === 0 && store.puts.length === 0, r.body);
    r = await call(EL.employerLetterGate, 7, { employer: 'Amazon', job: { ...STORM_JOB } });
    ok('…and the confirm-sheet gate calls it a saved letter too (via cache)', r.body.covered === true && r.body.via === 'cache', r.body);
    reset();
    r = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Storm Primary Co', job: { ...STORM_JOB, company: 'Storm Primary Co' } }));
    const putP = store.puts[0] || {};
    ok('⚠️ the same inputs written by the PRIMARY hash to the SAME fingerprint as the fallback\'s letter',
      r.statusCode === 200 && putP.model === P && putP.fingerprint === putS.fingerprint, { status: r.statusCode, model: putP.model, same: putP.fingerprint === putS.fingerprint });

    // 3. every model busy: NOTHING charged, NOTHING stored — and an answer that says so
    reset(); gt.length = 0; ai.fail = (cfg) => E503(cfg.model);
    const sqlBusy = world.sql.length;
    r = await call(EL.buildEmployerLetter, 7, storm('Storm Role B'), { __jobId: 'job-busy' });
    ok('⚠️ every model busy → 503 ai_busy, retryable', r.statusCode === 503 && r.body.success === false && r.body.reason === 'ai_busy' && r.body.retryable === true, r.body);
    ok('…in a sentence that names the cover letter and says NOTHING was charged', /cover letter/.test(r.body.error || '') && /Nothing was charged/.test(r.body.error || ''), r.body.error);
    ok('…after the chain ran ONCE: the primary twice, then each fallback — four calls, never a second chain from the lane',
      modelsOf().join() === [P, P, F1, F2].join() && gt.length === 1, { models: modelsOf(), chains: gt.length });
    // ADDED 2026-09-18 (the writing chain): the whole chain, each model with the config it is owed — only F1 thinks less.
    ok('⚠️ …F1 asked with thinkingConfig { thinkingBudget: 0 }; the primary and F2 with the lane\'s config exactly, NO thinkingConfig',
      ai.calls.length === 4 && JSON.stringify(ai.calls[2].cfg.generationConfig.thinkingConfig) === JSON.stringify({ thinkingBudget: 0 })
      && cfgOf(ai.calls[2], { dropThinking: true }) === cfgOf(ai.calls[0])
      && [0, 1, 3].every((i) => !('thinkingConfig' in ai.calls[i].cfg.generationConfig) && cfgOf(ai.calls[i]) === cfgOf(ai.calls[0])),
      ai.calls.map((c) => ({ model: c.cfg.model, thinking: c.cfg.generationConfig.thinkingConfig })));
    ok('⚠️ NOTHING consumed, stored, claimed, refunded or written',
      ent.consumed.length === 0 && store.puts.length === 0 && passSpy.claimCalls.length === 0 && (world.refunds || []).length === 0 && runsSince(sqlBusy).length === 0,
      { consumed: ent.consumed.length, puts: store.puts.length, runs: runsSince(sqlBusy) });
    ok('…and it never reached the payment stages', !stages.some((s) => ['designing', 'saving', 'pages'].includes(s.stage)), stages.map((s) => s.stage));
    reset(); ai.fail = () => new Error('AI_TIMEOUT');
    r = await call(EL.buildEmployerLetter, 7, storm('Storm Role F'));
    ok('every model hung (timed out) is the same overload → 503 ai_busy, no longer a 504', r.statusCode === 503 && r.body.reason === 'ai_busy' && !r.body.isTimeout
      && modelsOf().join() === [P, P, F1, F2].join() && ent.consumed.length === 0 && store.puts.length === 0, { status: r.statusCode, body: r.body, models: modelsOf() });

    // 4. ⚠️ THE WAITERS. A second identical build that joined the first is RELEASED when the first ends ai_busy (the
    // finally), then runs its own gates and its own chain and gets its own honest answer. Nobody waits on a build that
    // will never land; the calls come in two whole chains, one after the other, because the second WAITED.
    reset(); ai.fail = (cfg) => E503(cfg.model);
    const bodyW = storm('Storm Role C');
    let wd = null;
    const hung = new Promise((resolve) => { wd = setTimeout(() => resolve('HUNG'), 5000); });
    const both = await Promise.race([Promise.all([call(EL.buildEmployerLetter, 7, bodyW), call(EL.buildEmployerLetter, 7, bodyW)]), hung]);
    clearTimeout(wd);
    ok('⚠️ a build waiting on this one is RELEASED when it ends ai_busy (no hang)', Array.isArray(both), both);
    const [wa, wb] = Array.isArray(both) ? both : [{ body: {} }, { body: {} }];
    ok('…both answered 503 ai_busy, the joiner after running every gate itself', wa.statusCode === 503 && wb.statusCode === 503 && wa.body.reason === 'ai_busy' && wb.body.reason === 'ai_busy' && ent.gateCalls === 2,
      { a: wa.body, b: wb.body, gates: ent.gateCalls });
    ok('…the joiner really waited: two whole chains, one AFTER the other', modelsOf().join() === [P, P, F1, F2, P, P, F1, F2].join(), modelsOf());
    ok('…nothing charged or stored for either', ent.consumed.length === 0 && store.puts.length === 0);
    ai.fail = null; ai.calls = [];
    // (Only when nothing hung: a flight that was never settled would swallow this build too, and the suite with it.)
    if (Array.isArray(both)) r = await call(EL.buildEmployerLetter, 7, bodyW);
    ok('…and the flight is gone: the next identical build runs at once, charged once', Array.isArray(both) && r.statusCode === 200 && r.body.cached === false && ai.calls.length === 1 && ent.consumed.length === 1 && store.puts.length === 1,
      { status: r.statusCode, ai: ai.calls.length });

    // 5. a dead key: quota fails FAST (one call — every model shares the key) and pages the operator
    reset(); ai.fail = (cfg) => E429(cfg.model);
    const pages0 = pages.length;
    r = await call(EL.buildEmployerLetter, 7, storm('Storm Role D'));
    ok('⚠️ quota → 503 ai_down, NOT retryable, and it says nothing was charged', r.statusCode === 503 && r.body.success === false && r.body.reason === 'ai_down' && r.body.retryable === false && /Nothing was charged/.test(r.body.error || ''), r.body);
    ok('…after ONE call: every model shares the key, so a second one is wasted time', ai.calls.length === 1, modelsOf());
    ok('⚠️ …nothing charged, nothing stored', ent.consumed.length === 0 && store.puts.length === 0);
    ok('…and the operator is paged (aiHealth: category null, an alarm no toggle can silence)',
      pages.length === pages0 + 1 && pages[pages.length - 1].category === null && pages[pages.length - 1].data && pages[pages.length - 1].data.kind === 'quota', pages.slice(pages0));
    reset();
    const key = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try { r = await call(EL.buildEmployerLetter, 7, storm('Storm Role E')); } finally { process.env.GEMINI_API_KEY = key; }
    ok('no key on the server → 503 ai_down before any AI call, nothing charged or stored (was a 500 "failed")',
      r.statusCode === 503 && r.body.reason === 'ai_down' && ai.calls.length === 0 && ent.consumed.length === 0 && store.puts.length === 0, r.body);

    // 6. the corrective pass rides the same chain — and NOTHING it meets may cost the user the letter they already have
    reset(); ai.queue = [PLACEHOLDER_DRAFT]; ai.fail = (cfg, prompt) => (/CORRECTION/.test(prompt) && cfg.model === P ? E503(P) : null);
    r = await call(EL.buildEmployerLetter, 7, storm('Storm Role G'), { __jobId: 'job-fix' });
    ok('the corrective pass goes through the chain too: the primary busy → the fallback rewrites it',
      r.statusCode === 200 && modelsOf().join() === [P, P, P, F1].join() && /CORRECTION/.test((ai.calls[3] || {}).prompt || ''), modelsOf());
    ok('⚠️ …and the stored letter records the model whose draft was KEPT (the fallback\'s rewrite), placeholders gone',
      !!store.puts[0] && store.puts[0].model === F1 && !/\[X%\]|XX%/.test(store.puts[0].payload.coverLetterHtml), store.puts[0] && store.puts[0].model);
    ok('…its retries reported after "Polishing the wording", never behind it on the bar',
      (() => { const i = stages.findIndex((s) => s.stage === 'polishing'); return i >= 0 && stages.slice(i + 1).some((s) => s.stage === 'retry' && s.pct >= 70); })(), stages.map((s) => `${s.stage}:${s.pct}`));
    ok('…charged once', ent.consumed.length === 1 && store.puts.length === 1);
    reset(); ai.queue = [PLACEHOLDER_DRAFT]; ai.fail = (cfg, prompt) => (/CORRECTION/.test(prompt) ? E503(cfg.model) : null);
    r = await call(EL.buildEmployerLetter, 7, storm('Storm Role H'));
    const htmlH = (store.puts[0] || { payload: {} }).payload.coverLetterHtml || '';
    ok('⚠️ every model busy on the CORRECTIVE pass: the first draft is kept (placeholders stripped), stored and charged once',
      r.statusCode === 200 && ent.consumed.length === 1 && store.puts.length === 1 && store.puts[0].model === P && !/\[X%\]|XX%/.test(htmlH) && /Improved settlement speed for merchants/.test(htmlH),
      { status: r.statusCode, body: r.body, model: store.puts[0] && store.puts[0].model });
    ok('…after one draft and ONE corrective chain (primary twice, each fallback)', modelsOf().join() === [P, P, P, F1, F2].join(), modelsOf());

    // 7. bad output is the LANE's retry: a second draft from the primary, told as a second pass — not as Google being busy
    reset(); ai.queue = ['not json'];
    r = await call(EL.buildEmployerLetter, 7, storm('Storm Role I'), { __jobId: 'job-bad' });
    ok('bad output → the lane\'s own second draft, from the primary (200, two calls, both the primary)',
      r.statusCode === 200 && modelsOf().join() === [P, P].join() && !!store.puts[0] && store.puts[0].model === P, modelsOf());
    ok('…reported as "Taking another pass at it", never as a busy provider', JSON.stringify(labelsOf('retry')) === JSON.stringify(['Taking another pass at it']), labelsOf('retry'));

    // 8. ⚠️ ONE AI WINDOW (LETTER_AI): no second draft and no corrective pass is STARTED without room to finish it.
    const realWindow = { ...LA };
    try {
      LA.windowMs = 30 * 1000; LA.minCallMs = 60 * 1000;   // room for one draft, none for another call
      reset(); gt.length = 0; ai.queue = ['not json'];
      r = await call(EL.buildEmployerLetter, 7, storm('Storm Role J'));
      ok('⚠️ bad output with no room left → 500 failed after ONE call — never an "AI is busy" the provider never said',
        r.statusCode === 500 && r.body.reason === 'failed' && ai.calls.length === 1 && ent.consumed.length === 0 && store.puts.length === 0, { status: r.statusCode, body: r.body, calls: ai.calls.length });
      ok('…and its one chain was given what was LEFT of the window, not a budget of its own', gt.length === 1 && gt[0].budgetMs > 0 && gt[0].budgetMs <= 30 * 1000, gt.map((g) => g.budgetMs));
      reset(); ai.queue = [PLACEHOLDER_DRAFT];
      r = await call(EL.buildEmployerLetter, 7, storm('Storm Role K'));
      ok('placeholders with no room for the corrective pass → the first draft kept (stripped) after ONE call, charged once',
        r.statusCode === 200 && ai.calls.length === 1 && ent.consumed.length === 1 && store.puts.length === 1 && !/\[X%\]|XX%/.test(store.puts[0].payload.coverLetterHtml),
        { status: r.statusCode, calls: ai.calls.length });
    } finally { Object.assign(LA, realWindow); }
    // 240 s of research + AI, + ≤ 15 s of lock + ≤ 20 s of thumbs, inside the app's 6 minutes with room for the queue.
    ok('the production window: 4 min for research + every AI call, 3 min a draft, 90 s a correction, 20 s the least a call starts with',
      LA.windowMs === 240000 && LA.draftBudgetMs === 180000 && LA.correctionBudgetMs === 90000 && LA.minCallMs === 20000
      && LA.windowMs + 35 * 1000 < 6 * 60 * 1000, EL.LETTER_AI);

    // 9. ⚠️ THE MONEY CONSTANTS. A bump of any of them re-bills every saved document; a fallback model moves none of them.
    const elSrc = fsSync.readFileSync(path.join(ROOT, 'server/controllers/employerLetterController.js'), 'utf8');
    ok('⚠️ LETTER_REV stays letter-v1 through the fallback round', /const LETTER_REV = 'letter-v1';/.test(elSrc) && !/LETTER_REV = 'letter-v[2-9]'/.test(elSrc));
    ok('⚠️ RESEARCH_REV stays r1', research.RESEARCH_REV === 'r1', research.RESEARCH_REV);
    ok('⚠️ FP_VERSION stays v1 (the hash of a known input is exactly what it was)',
      docs.fingerprint({ baseText: 'a', jobText: 'b', researchRev: 'c' }) === crypto.createHash('sha256').update(['v1', 'a', 'b', 'c'].join('\0')).digest('hex'));
    ok('⚠️ no model id anywhere in the letter\'s fingerprint', (() => { const b = (elSrc.match(/function letterFingerprintOf\([\s\S]*?\n\}/) || [''])[0]; return b.length > 50 && !/model/i.test(b); })());
    AT.generateText = realGT;
  }

  console.log('── build: money at the moment of payment ──');
  reset(); ent.quotaSeq = [{ allowed: true, via: 'plan' }, { allowed: true, via: 'credits' }];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'Data Engineer' } }));
  ok('coveredOnly and the plan unit vanished mid-run → 402', r.statusCode === 402 && r.body.reason === 'quota_exhausted', r.body);
  ok('⚠️ …nothing consumed or stored', ent.consumed.length === 0 && store.puts.length === 0);
  reset(); ent.quota = { allowed: true, via: 'credits' }; ent.used = { via: 'credits' }; world.creditHistory = { n: 0, cost: 0 }; world.ledgerCredits = { n: 1 };
  r = await call(EL.buildEmployerLetter, 7, buildBody({ coveredOnly: false, job: { ...JOB, title: 'Data Engineer' } }));
  ok('confirmed credits but nothing deducted → 402, not stored', r.statusCode === 402 && store.puts.length === 0, r.body);
  reset(); ent.quota = { allowed: true, via: 'credits' }; ent.used = { via: 'credits' }; world.creditHistory = { n: 1, cost: 1 }; world.ledgerCredits = { n: 1 };
  r = await call(EL.buildEmployerLetter, 7, buildBody({ coveredOnly: false, job: { ...JOB, title: 'Data Engineer' } }));
  ok('confirmed credits, really deducted → stored', r.statusCode === 200 && store.puts.length === 1, r.body);
  reset(); ent.quotaSeq = [{ allowed: true, via: 'plan' }, { allowed: true, via: 'plan' }]; ent.used = { via: 'credits' }; world.creditHistory = { n: 1, cost: 1 }; world.ledgerCredits = { n: 1 };
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'ML Engineer' } }));
  ok('coveredOnly residual race: credits taken anyway → refunded + 402', r.statusCode === 402 && world.refunds.length === 1 && world.refunds[0][1] === 'cover_letter_generate' && store.puts.length === 0, { status: r.statusCode, refunds: world.refunds });
  reset(); ent.used = { via: 'error' };
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'SRE' } }));
  ok('usage not recorded → 500, not stored', r.statusCode === 500 && store.puts.length === 0, r.body);
  // ⚠️ 2026-09-13: no credits pool to fall into. The gate said yes, the last unit went to an overlapping build,
  // and consumeOnSuccess answers via:'none' with NO ledger row — that is not a payment, so nothing is stored.
  reset(); ent.used = { via: 'none', charge: null, ledgerId: null };
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'Data Platform Engineer' } }));
  // ⚠️ TIGHTENED 2026-09-14: exactly the refusal every lane answers — 402 quota_exhausted, which Home turns into
  // the plans state — never a 500 "try again" that would meet the same wall (and never a 200 with a letter).
  ok("⚠️ consumeOnSuccess 'none' → 402 quota_exhausted, not stored, no letter handed over",
    r.statusCode === 402 && r.body && r.body.reason === 'quota_exhausted' && store.puts.length === 0
    && !(r.body.coverLetterHtml || r.body.payload || r.body.docId), { status: r.statusCode, body: r.body });
  reset(); passSpy.cover = true; passSpy.claim = { charged: true };
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'Platform Engineer' } }));
  ok('pass covered + claimed → stored, plan NOT consumed', r.statusCode === 200 && ent.consumed.length === 0 && store.puts.length === 1 && passSpy.claimCalls.length === 1 && passSpy.claimCalls[0][1] === 'cover_letter', { consumed: ent.consumed.length, claims: passSpy.claimCalls });
  reset(); passSpy.cover = true; passSpy.claim = { charged: false };
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'Security Engineer' } }));
  ok('pass claim lost the race → the plan pays (never free)', r.statusCode === 200 && ent.consumed.length === 1, { consumed: ent.consumed.length });
  // world.sql is cumulative across scenarios, so a give-back assertion names the writes since a mark.
  const ranSince = (mark) => world.sql.slice(mark).filter((q) => /^RUN /.test(q)).map((q) => q.slice(4));
  reset(); store.failPut = true;
  const sql0 = world.sql.length;
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'Cloud Engineer' } }));
  ok('charged but put failed → 500 failed', r.statusCode === 500 && r.body.reason === 'failed', r.body);
  ok('⚠️ …and one failed write is RETRIED before the letter is given up on', store.puts.length === 2, store.puts.length);
  ok('⚠️ …then every charge goes back — the plan\'s usage row included, by its own id',
    ranSince(sql0).includes('DELETE FROM usage_ledger WHERE id = $1 AND user_id = $2'), ranSince(sql0));
  // The PASS lane pays with a stamp on the pass, not with credits: its generation must be un-stamped too,
  // or the user paid and Try again asks them to pay again.
  let sqlMark = world.sql.length;
  reset(); store.failPut = true; passSpy.cover = true; passSpy.claim = { charged: true, passId: 4242 };
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'Cloud Architect' } }));
  ok('⚠️ a pass that paid for a letter that could not be stored gets its generation back',
    r.statusCode === 500 && ranSince(sqlMark).includes('UPDATE download_passes SET letter_generated_at = NULL WHERE id = $1 AND user_id = $2'),
    ranSince(sqlMark));

  console.log('── ⚠️ A LETTER THE USER REALLY PAID FOR IS NEVER THROWN AWAY ──');
  // The credits-history window answers "did ANY credits move since I started?" — so another build's
  // deduction overlapping the window (or this one landing outside it) decided this letter's fate. It was
  // discarded with no refund, and Try again charged again. The charge THIS call made is what decides now.
  reset();
  ent.quota = { allowed: true, via: 'credits' };
  ent.used = { via: 'credits', charge: { charged: true, cost: 1 } };
  world.creditHistory = { n: 0, cost: 0 };          // the window sees nothing — it is not the answer
  r = await call(EL.buildEmployerLetter, 7, buildBody({ coveredOnly: false, job: { ...JOB, title: 'Payments Engineer' } }));
  ok('⚠️ a credits charge this build really made is honoured, whatever the history window says',
    r.statusCode === 200 && store.puts.length === 1 && (world.refunds || []).length === 0, { status: r.statusCode, puts: store.puts.length, refunds: world.refunds });
  // …and the converse: a lane that reports credits but took nothing may not store, and gives its row back.
  reset();
  ent.quota = { allowed: true, via: 'credits' };
  ent.used = { via: 'credits', charge: { charged: false, cost: 1, insufficient: true } };
  world.creditHistory = { n: 1, cost: 1 };          // the window sees SOMEBODY's deduction — still not the answer
  r = await call(EL.buildEmployerLetter, 7, buildBody({ coveredOnly: false, job: { ...JOB, title: 'Payments Lead' } }));
  ok('⚠️ …and a charge that took nothing stores nothing, whatever the window says',
    r.statusCode === 402 && store.puts.length === 0, { status: r.statusCode, puts: store.puts.length });
  // ⚠️ 'error' CAN STILL CARRY A DEDUCTION that landed before consumeOnSuccess failed: it goes back.
  reset();
  ent.quota = { allowed: true, via: 'credits' };
  ent.used = { via: 'error', charge: { charged: true, cost: 1 }, ledgerId: null };
  r = await call(EL.buildEmployerLetter, 7, buildBody({ coveredOnly: false, job: { ...JOB, title: 'Payments Architect' } }));
  ok('⚠️ a deduction that landed before consumeOnSuccess failed is refunded, and nothing is stored',
    r.statusCode === 500 && store.puts.length === 0 && (world.refunds || []).length === 1 && world.refunds[0][1] === 'cover_letter_generate',
    { status: r.statusCode, refunds: world.refunds });
  // An entitlements from before contract 1 (no `charge` key at all) still works — the window is the
  // documented FALLBACK, never the primary answer.
  reset(); ent.legacyEntitlements = true;
  ent.quota = { allowed: true, via: 'credits' }; ent.used = { via: 'credits' };
  world.creditHistory = { n: 1, cost: 1 }; world.ledgerCredits = { n: 1 };
  r = await call(EL.buildEmployerLetter, 7, buildBody({ coveredOnly: false, job: { ...JOB, title: 'Payments Manager' } }));
  ok('an older entitlements falls back to the history window and still stores a paid letter',
    r.statusCode === 200 && store.puts.length === 1, { status: r.statusCode, puts: store.puts.length });
  ent.legacyEntitlements = false;

  console.log('── build: single flight ──');
  reset();
  ai.queue = [{ slow: 150, text: GOOD() }];
  const body17 = buildBody({ job: { ...JOB, title: 'Head of Payments' } });
  const [a17, b17] = await Promise.all([call(EL.buildEmployerLetter, 7, body17), call(EL.buildEmployerLetter, 7, body17)]);
  ok('two identical concurrent builds → ONE AI call, ONE consume', ai.calls.length === 1 && ent.consumed.length === 1, { ai: ai.calls.length, consumed: ent.consumed.length });
  ok('…both answered with the same docId, one as cached', a17.body.docId === b17.body.docId && [a17.body.cached, b17.body.cached].sort().join() === 'false,true', [a17.body, b17.body]);

  console.log('── build: tailored resume only when current; job boards never researched ──');
  reset(); resumeDocs.doc = { input_fingerprint: 'fp-old', payload: { personal_info: { title: 'Tailored Title' }, summary: 'TAILORED SUMMARY MARK', experience: [] } }; rbFp.value = 'fp-new';
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'Engineer A' } }));
  ok('stale tailored resume is NOT in the prompt', !/TAILORED SUMMARY MARK/.test(ai.calls[0].prompt));
  reset(); resumeDocs.doc = { input_fingerprint: 'fp-same', payload: { personal_info: { title: 'Tailored Title', email: 'secret@x.test' }, summary: 'TAILORED SUMMARY MARK', experience: [] } }; rbFp.value = 'fp-same';
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'Engineer B' } }));
  ok('current tailored resume IS in the prompt, without contact details', /TAILORED SUMMARY MARK/.test(ai.calls[0].prompt) && !/secret@x\.test/.test(ai.calls[0].prompt));
  reset();
  r = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Zeta', job: { company: 'Zeta', title: 'Engineer', website: 'https://www.linkedin.com/company/zeta', url: 'https://boards.greenhouse.io/zeta/jobs/1' } }));
  ok('a job-board website is never researched', r.statusCode === 200 && researchCalls.length === 0, researchCalls);
  ok('…and the stage list skips researching', !stages.some((s) => s.stage === 'researching'));
  reset();
  r = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Amazon', job: { company: 'Amazon', title: 'SDE', website: '', url: 'https://amazon.jobs/en/jobs/123' } }));
  ok('a posting host the employer owns is researched (amazon.jobs)', researchCalls.length === 1 && researchCalls[0].website === 'amazon.jobs', researchCalls);

  console.log('── build: named contact / address only with evidence ──');
  reset(); ai.queue = [GOOD({ to: 'Maria Lopez', addresses: ['1 Invented Road, Nowhere'] })];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'Engineer C', description: 'Reach out to Maria Lopez. Office: 500 Market Street, San Francisco.' } }));
  ok('contact named in the posting is kept', store.puts[0].payload.hiringManager === 'Maria Lopez', store.puts[0].payload.hiringManager);
  ok('address not in the posting is dropped', store.puts[0].payload.companyAddress === '', store.puts[0].payload);
  reset(); ai.queue = [GOOD({ to: 'Bob Smith', addresses: ['500 Market Street, San Francisco'] })];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'Engineer D', description: 'Office: 500 Market Street, San Francisco.' } }));
  ok('contact NOT in the posting → Hiring Manager', store.puts[0].payload.hiringManager === 'Hiring Manager');
  ok('address written in the posting → kept', store.puts[0].payload.companyAddress === '500 Market Street, San Francisco', store.puts[0].payload);
  reset(); ai.queue = [GOOD({ position: 'Backend Engineer (open application)' })];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Omega', job: { company: 'Omega', website: 'omega.test' } }));
  ok('"(open application)" never reaches position/subject', store.puts[0].payload.position === 'Backend Engineer' && !/open application/i.test(store.puts[0].payload.subject), store.puts[0].payload);

  console.log('── ⚠️ conventions shape the letter\'s tone and length — never its facts, never its price ──');
  {
    reset();
    researchConv = { hqCountry: 'Germany', roleCountry: 'Germany', employerType: 'startup', sector: 'Fintech', atsVendor: 'Personio', tone: 'direct',
      cv: { photo: 'expected', length: 'two_pages', personalDetails: 'include', dateFormat: 'MM/YYYY', format: 'tabular', notes: ['Berlin startups read short, direct letters.'] }, sources: [] };
    r = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Conv GmbH', country: '', job: { ...JOB, company: 'Conv GmbH', website: 'conv.test' } }), { __jobId: 'job-conv' });
    const pc = String((ai.calls[0] || {}).prompt || '');
    ok('200, ONE AI call, ONE consume', r.statusCode === 200 && ai.calls.length === 1 && ent.consumed.length === 1, { status: r.statusCode, ai: ai.calls.length, consumed: ent.consumed.length });
    ok('the letter prompt carries the conventions block, letter version (no CV habits)',
      /=== HOW Conv GmbH HIRES/.test(pc) && /Personio/.test(pc) && /never mention them in the letter/.test(pc) && !/CV conventions: /.test(pc), pc.slice(pc.indexOf('=== HOW'), pc.indexOf('=== HOW') + 400));
    // ⚠️ CHANGED 2026-09-16 (the country playbook): the research names Germany, so GERMANY's own letter habit
    // speaks and the six-region line stands down — one voice about where this letter is going, never two that
    // could disagree. The startup's band is untouched: the employer type still leads, as it always has.
    ok('…a startup\'s shorter band (230-320 words), and Germany\'s own letter habit in place of the region\'s',
      /230-320/.test(pc) && /discuss the role in person/.test(pc) && !/German-speaking employers expect a formal, structured letter/.test(pc), pc.slice(pc.indexOf('FOR THIS EMPLOYER'), pc.indexOf('FOR THIS EMPLOYER') + 400));
    ok('⚠️ …and the absolute rule: conventions never add facts', /never (add|state|imply)[^.]*fact/i.test(pc));
    const putC = store.puts[store.puts.length - 1] || {};
    ok('region from the research (Germany → dach) when the chip names no country', putC.design && putC.design.region === 'dach', putC.design && putC.design.region);
    ok('the stored letter design keeps conventionsSummary (≤120) and the aiFamilies key', putC.design && 'aiFamilies' in putC.design
      && typeof putC.design.conventionsSummary === 'string' && putC.design.conventionsSummary.length <= 120, putC.design && { ai: putC.design.aiFamilies, s: putC.design.conventionsSummary });
    const style = EL.letterStyleFor(null, 'generic');
    ok('no conventions + generic region → v1\'s 300-450 words, no extra notes', style && /300-450/.test(JSON.stringify(style)) && (!style.notes || style.notes.length === 0), style);
    researchConv = null;
  }

  console.log('── ⚠️ the country reaches the LETTER too: register and structure only — never a CV habit, never a charge ──');
  {
    // The playbook (cvPlaybook) answers "how is a document written where this application is going" for every
    // country regionFromCountry knows. A LETTER takes only the half a letter can honour — how formal it reads,
    // how long it runs, how it opens and how it closes. Photos, dates of birth, personal details, page counts,
    // date patterns and section orders are the résumé's, and one of them in a letter is a defect, not a
    // convention. None of it is hashed, so none of it can bill anyone for a letter they already have.
    const toneOf = (p) => (String(p).match(/^TONE: (.+)$/m) || [])[1] || '';
    const bandOf = (p) => (String(p).match(/(\d{3}-\d{3}) words in total/) || [])[1] || '';
    const blockOf = (p) => {
      const i = String(p).indexOf('=== HOW A COVER LETTER READS');
      if (i < 0) return '';
      const rest = String(p).slice(i);
      const end = rest.indexOf('\n\n');
      return end < 0 ? rest : rest.slice(0, end);
    };
    const notesOf = (p) => (String(p).match(/\nFOR THIS EMPLOYER:\n([\s\S]*?)\nNever use:/) || [])[1] || '';
    // Every CV habit, spelled the way a CV prompt spells it. NOT ONE of these may reach a letter.
    const CV_HABIT = /photo|date of birth|marital|nationality|personal details|\bpages?\b|\bcvs?\b|r[eé]sum[eé]|section order|MM\/YYYY|\bbullets?\b|skills block/i;
    const PB = require(path.join(ROOT, 'server/services/cvPlaybook.js'));
    const realFor = PB.playbookFor, realBlock = PB.playbookPromptBlock;

    // ── a formal country and a direct one must not read the same ──
    reset();
    let rp = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Chateau SA', country: 'France', job: { ...JOB, company: 'Chateau SA', website: 'chateau.test', title: 'Backend Engineer' } }));
    const pFr = String((ai.calls[0] || {}).prompt || '');
    const fpFr = (store.puts[0] || {}).fingerprint;
    ok('a French employer → 200, ONE AI call, ONE consume, ONE research call: the country costs nothing extra',
      rp.statusCode === 200 && ai.calls.length === 1 && ent.consumed.length === 1 && researchCalls.length === 1 && store.puts.length === 1,
      { status: rp.statusCode, ai: ai.calls.length, consumed: ent.consumed.length, research: researchCalls.length });
    ok('…France\'s own letter block, headed by the country', /=== HOW A COVER LETTER READS IN FRANCE ===/.test(pFr), blockOf(pFr));
    ok('…a formal register and the French arc in the notes', /^formal and courteous/.test(toneOf(pFr)) && /what the employer needs/.test(notesOf(pFr)), { tone: toneOf(pFr), notes: notesOf(pFr) });

    // ⚠️ THE MONEY LINE: the country changes how a letter READS, never what it costs. The same employer and the
    // same job fields are the same fingerprint whatever country the chip names — so the letter just written is
    // still the free cache hit it would have been before any of this existed.
    reset();
    rp = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Chateau SA', country: 'Japan', job: { ...JOB, company: 'Chateau SA', website: 'chateau.test', title: 'Backend Engineer' } }));
    ok('⚠️ the same letter under a different country is the SAME free cache hit — no AI, no gate, no charge',
      rp.statusCode === 200 && rp.body.cached === true && ai.calls.length === 0 && ent.gateCalls === 0 && ent.consumed.length === 0 && store.puts.length === 0,
      { status: rp.statusCode, body: rp.body, ai: ai.calls.length });
    ok('…because the country was never a fingerprint input', (await EL.currentLetterFingerprint(7, { job: { company: 'Chateau SA', website: 'chateau.test', title: 'Backend Engineer' }, country: 'Japan', env: 'Production' })) === fpFr);

    reset();
    rp = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Statewide Inc', country: 'United States', job: { ...JOB, company: 'Statewide Inc', website: 'statewide.test', title: 'Backend Engineer' } }));
    const pUs = String((ai.calls[0] || {}).prompt || '');
    ok('an American employer reads direct, at the shorter band', rp.statusCode === 200 && /^direct and specific/.test(toneOf(pUs)) && bandOf(pUs) === '250-350', { tone: toneOf(pUs), band: bandOf(pUs) });
    ok('⚠️ a country with a formal convention really does read differently from one without',
      toneOf(pFr) !== toneOf(pUs) && bandOf(pFr) !== bandOf(pUs) && blockOf(pFr) !== blockOf(pUs), { fr: [toneOf(pFr), bandOf(pFr)], us: [toneOf(pUs), bandOf(pUs)] });

    // ── ⚠️ NEVER A CV HABIT, IN ANY COUNTRY ──
    // Swept over the prompt itself (block + TONE + notes), for a country from every corner of the table. The
    // prompt is built directly here: the register, the band and the block are pure functions of the country, so
    // this costs nothing and can afford to ask the question everywhere rather than in one place.
    const promptFor = (country) => {
      const pb = EL.letterPlaybookFor({ country, website: '', conventions: null, research: null });
      return EL.buildEmployerLetterPrompt({
        company: 'Acme', website: '', job: { title: 'Backend Engineer', url: '', description: '', website: '' },
        material: { baseText: 'Current title: Backend Engineer', uploadText: '' }, tailored: null,
        researchBlock: '', conventionsBlock: '', playbookBlock: EL.letterPlaybookBlockFor(pb, 'Acme'),
        style: EL.letterStyleFor(null, pb ? pb.region : 'generic', pb), sector: '',
      });
    };
    const SWEEP = ['United States', 'United Kingdom', 'Germany', 'France', 'Switzerland', 'Netherlands', 'Italy',
      'Poland', 'Russia', 'India', 'Japan', 'Singapore', 'Indonesia', 'Brazil', 'Nigeria', 'Saudi Arabia', 'Morocco'];
    const leaks = SWEEP.filter((c) => { const p = promptFor(c); return CV_HABIT.test(blockOf(p)) || CV_HABIT.test(notesOf(p)) || CV_HABIT.test(toneOf(p)); });
    ok('⚠️ NOT ONE CV habit in any country\'s letter guidance (17 countries, block + tone + notes)', leaks.length === 0, leaks);
    const mute = SWEEP.filter((c) => { const p = promptFor(c); return !toneOf(p) || toneOf(p) === EL.letterStyleFor(null, 'generic').register; });
    ok('…and every one of them is actually answered: a register of its own, not the generic one', mute.length === 0, mute);
    const bands = new Set(SWEEP.map((c) => bandOf(promptFor(c))));
    ok('…with more than one length band across the table (how long a letter runs is part of the answer)', bands.size >= 2, [...bands]);

    // ── every country regionFromCountry knows is answered, and answered safely ──
    const RF = require(path.join(ROOT, 'server/utils/regionFromCountry.js'));
    const unanswered = RF._internals.COUNTRY_ROWS.map((row) => row[1])
      .filter((c) => !EL.countryLetterRowOf(EL.letterPlaybookFor({ country: c })));
    ok('every country in the table has a letter register of its own — none falls through to the generic one', unanswered.length === 0, unanswered.slice(0, 8));
    ok('…one row per CV profile the country table uses, no more and no fewer',
      JSON.stringify(Object.keys(EL.LETTER_PROFILES).sort()) === JSON.stringify(Object.keys(RF._internals.CV_PROFILES).sort()),
      Object.keys(EL.LETTER_PROFILES).sort());
    const badRow = Object.entries(EL.LETTER_PROFILES).filter(([, row]) => {
      const band = String(row.words || '').match(/^(\d{3})-(\d{3})$/);
      // ⚠️ THE ~230-WORD FLOOR: parseLetterOutput refuses a letter under 120 words and the placeholder guard
      // under 80, so a band that let a letter start short would throw away work the user paid for.
      return !row.register || !band || Number(band[1]) < 230 || Number(band[2]) > 450 || Number(band[1]) >= Number(band[2])
        || CV_HABIT.test(row.register) || (row.structure && CV_HABIT.test(row.structure));
    });
    ok('…and every row is well formed: a register, a band inside the 230-450 floor, and no CV habit in either', badRow.length === 0, badRow.map(([k]) => k));

    // ── ⚠️ THE GUARD IS THE POINT: a CV line that ever appears in cvPlaybook's letter block is dropped HERE ──
    const gPb = EL.letterPlaybookFor({ country: 'Germany' });
    PB.playbookPromptBlock = () => ['=== HOW A COVER LETTER READS IN GERMANY ===',
      '- A photo belongs top right, and the date of birth under it.',
      '- Length: up to two pages is normal here.',
      '- Dates: write every start and end date as MM/YYYY.',
      '- Section order read here: contact → summary → experience.',
      '- Name the exact post applied for in the opening line.',
      '- These are habits of the place, not facts about the candidate: never add anything their material does not contain.'].join('\n');
    const guarded = EL.letterPlaybookBlockFor(gPb, 'Acme');
    ok('⚠️ the CV lines are dropped and the letter-safe one survives', !CV_HABIT.test(guarded) && /Name the exact post applied for/.test(guarded), guarded);
    PB.playbookPromptBlock = () => '=== HOW A COVER LETTER READS IN GERMANY ===\n- A photo belongs top right.\n- Length: one page.';
    ok('…and a block of nothing but CV lines is no block at all (a header with no rule is tokens, not guidance)', EL.letterPlaybookBlockFor(gPb, 'Acme') === '');
    PB.playbookPromptBlock = () => ['=== HOW A COVER LETTER READS IN GERMANY ===', '- one', '- two', '- three', '- four', '- five', '- six', '- seven',
      '- These are habits of the place, not facts about the candidate: never add anything their material does not contain.'].join('\n');
    const capped = EL.letterPlaybookBlockFor(gPb, 'Acme');
    ok('…a long block is capped — and what survives the cap is the guard rail, never the seventh rule (the corrective pass pays for every line twice)',
      capped.split('\n').length === 7 && /habits of the place/.test(capped) && !/- seven/.test(capped), capped);
    PB.playbookPromptBlock = realBlock;

    // ⚠️ THE OTHER HALF OF THE GUARANTEE: the letter lane never READS the playbook's cv half — there is no path
    // from a photo or a page count into a letter, not merely a filter in front of one. (cvPlaybook reads its own
    // cv half when it builds a block; what comes back is what letterSafeBlock above answers for.)
    const seen = new Set();
    const spy = new Proxy(EL.letterPlaybookFor({ country: 'Germany' }), { get(t, k) { if (typeof k === 'string') seen.add(k); return t[k]; } });
    const spied = EL.letterStyleFor({ employerType: 'startup', tone: 'direct' }, 'dach', spy);
    ok('⚠️ the letter lane never even LOOKS at the playbook\'s CV half', !seen.has('cv') && !seen.has('content') && seen.has('profile') && seen.has('source'), [...seen]);

    // ── country beats region, and the region still speaks when no country does ──
    const deReg = EL.letterStyleFor(null, 'dach', null);
    const deCty = EL.letterStyleFor(null, 'dach', EL.letterPlaybookFor({ country: 'Germany' }));
    ok('a caller with no playbook keeps exactly the style it had before (the six region notes)',
      deReg.words === '300-450' && deReg.notes.length === 1 && /German-speaking employers expect/.test(deReg.notes[0]), deReg);
    ok('⚠️ …and with the country resolved it is the COUNTRY that speaks, never both',
      /^formal and impersonal/.test(deCty.register) && deCty.notes.length === 1 && !deCty.notes.some((n) => /German-speaking employers expect/.test(n)), deCty);
    const euWord = EL.letterStyleFor(null, 'eu', EL.letterPlaybookFor({ country: 'Europe' }));
    ok('a region WORD knows less than the region switch — so the switch keeps it', euWord.notes.some((n) => /European motivation-letter habit/.test(n)), euWord);
    ok('…and a country nobody can place is the letter we always wrote', JSON.stringify(EL.letterStyleFor(null, 'generic', EL.letterPlaybookFor({ country: 'Atlantis' }))) === JSON.stringify(EL.letterStyleFor(null, 'generic')));

    // ── the employer still leads: a country fills a silence, it never overrules the employer type ──
    const jp = EL.letterPlaybookFor({ country: 'Japan' });
    const TYPE_BANDS = { public_sector: '350-450', academia: '350-450', enterprise: '300-400', sme: '280-380', startup: '230-320', agency: '250-350', ngo: '300-400' };
    const overruled = Object.keys(TYPE_BANDS).filter((t) => EL.letterStyleFor({ employerType: t }, 'generic', jp).words !== TYPE_BANDS[t]
      || EL.letterStyleFor({ employerType: t }, 'generic', jp).register !== EL.letterStyleFor({ employerType: t }, 'generic').register);
    ok('⚠️ every employer type keeps its own band and register under a country playbook', overruled.length === 0, overruled);
    ok('…while the country still adds its structure line on top', spied.notes.some((n) => /discuss the role in person/.test(n)) && spied.words === '230-320', spied);

    // ── deterministic, and free ──
    const twice = [1, 2].map(() => JSON.stringify(EL.letterStyleFor({ employerType: 'sme' }, 'eu', EL.letterPlaybookFor({ country: 'Italy' }))));
    ok('the same inputs give the same style, every time', twice[0] === twice[1]);
    ok('…and the resolution is synchronous: a Promise would mean something was fetched', !(EL.letterPlaybookFor({ country: 'Italy' }) instanceof Promise));

    // ── an unavailable / broken cvPlaybook writes the letter exactly as this lane wrote it before ──
    PB.playbookFor = () => { throw new Error('module half-deployed'); };
    reset();
    rp = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Fallback Ltd', country: 'France', job: { ...JOB, company: 'Fallback Ltd', website: 'fallback.test', title: 'Backend Engineer' } }));
    const pFb = String((ai.calls[0] || {}).prompt || '');
    ok('⚠️ a cvPlaybook that throws costs the user nothing: 200, one AI call, the letter written as it always was',
      rp.statusCode === 200 && ai.calls.length === 1 && ent.consumed.length === 1 && !blockOf(pFb) && bandOf(pFb) === '300-450' && toneOf(pFb) === EL.letterStyleFor(null, 'generic').register,
      { status: rp.statusCode, band: bandOf(pFb), tone: toneOf(pFb) });
    PB.playbookFor = realFor;

    {
      const elP = fsSync.readFileSync(path.join(ROOT, 'server/controllers/employerLetterController.js'), 'utf8');
      // ⚠️ THE MONEY CONSTANT, through the country round too. Register and structure are not facts: a stored
      // letter written before this slice is still a true letter, so nobody pays for ours having improved.
      ok('⚠️ LETTER_REV stays letter-v1 through the country round (a bump re-bills every saved letter)',
        /const LETTER_REV = 'letter-v1';/.test(elP) && !/LETTER_REV = 'letter-v[2-9]'/.test(elP));
      ok('…cvPlaybook is resolved lazily, like every other module the paid half needs', /const playbookMod = \(\) => require\('\.\.\/services\/cvPlaybook'\);/.test(elP));
      ok('…and the playbook is resolved ONCE per build, then handed to the style and the block',
        (elP.match(/letterPlaybookFor\(\{ country, website: site/g) || []).length === 1
        && /playbookBlock: letterPlaybookBlockFor\(playbook, company\)/.test(elP) && /style: letterStyleFor\(conventions, region, playbook\)/.test(elP));
    }
    reset();
  }

  console.log('── cards ──');
  reset();
  const letterDoc = store.rows.find((x) => x.kind === 'cover_letter' && x.employer_name === 'Acme');
  let res = mkRes(); await EL.employerLetterCards(mkReq(7, {}, { query: { doc: '999999' } }), res);
  ok('unknown doc → 404 doc_gone', res.statusCode === 404 && res.body.reason === 'doc_gone', res.body);
  res = mkRes(); await EL.employerLetterCards(mkReq(8, {}, { query: { doc: String(letterDoc.id) } }), res);
  ok('another user\'s doc → 404', res.statusCode === 404);
  res = mkRes(); await EL.employerLetterCards(mkReq(7, {}, { query: { doc: String(letterDoc.id) } }), res);
  ok('no ids → top 3 of the design, with fit + reason', res.statusCode === 200 && res.body.cards.length === 3 && res.body.cards[0].id === letterDoc.design.ranked[0].id && typeof res.body.cards[0].fit === 'number', res.body.cards && res.body.cards.map((c) => [c.id, c.fit, c.reason]));
  ok('card shape', res.body.cards.every((c) => ['id', 'name', 'accent', 'image', 'fit', 'reason'].every((k) => k in c) && /^data:image\/jpeg;base64,/.test(c.image)));
  ok('the 2 pre-rendered were cache hits; only 1 rendered', rendered.previews.length === 1 && rendered.previews[0].ids.length === 1, rendered.previews.map((p) => p.ids));
  rendered.previews = [];
  res = mkRes(); await EL.employerLetterCards(mkReq(7, {}, { query: { doc: String(letterDoc.id), ids: 'german,nope,technical,graduate,ats_pro' } }), res);
  ok('asked ∩ catalogue, capped at 3, in asked order', res.body.cards.map((c) => c.id).join() === 'german,technical,graduate', res.body.cards.map((c) => c.id));
  res = mkRes(); rendered.previews = []; await EL.employerLetterCards(mkReq(7, {}, { query: { doc: String(letterDoc.id), ids: 'german,technical' } }), res);
  ok('second request for the same ids renders nothing', rendered.previews.length === 0 && res.body.cards.length === 2);
  letterDoc.updated_at = new Date('2026-09-12T10:00:00Z');
  res = mkRes(); rendered.previews = []; await EL.employerLetterCards(mkReq(7, {}, { query: { doc: String(letterDoc.id), ids: 'german' } }), res);
  ok('an edited letter (updated_at moved) re-renders', rendered.previews.length === 1, rendered.previews);
  res = mkRes(); await EL.employerLetterCards(mkReq(7, {}, { query: { doc: String(letterDoc.id), ids: 'nope' } }), res);
  ok('only unknown ids → empty cards, no padding', res.statusCode === 200 && res.body.cards.length === 0, res.body);

  console.log('── downloads with docId ──');
  hist.length = 0; dlSpy.can.length = 0; dlSpy.claim.length = 0; rendered.pdf = 0; rendered.rich = 0; rendered.docx = 0;
  r = await call(CL.generateCoverLetterTemplatePdf, 7, { template: 'ats_pro', docId: 999999 });
  ok('unknown docId → 410 payload_gone, nothing rendered or claimed', r.statusCode === 410 && r.body.reason === 'payload_gone' && rendered.pdf === 0 && dlSpy.claim.length === 0, r.body);
  r = await call(CL.generateCoverLetterTemplatePdf, 8, { template: 'ats_pro', docId: letterDoc.id });
  ok('another user\'s docId → 410', r.statusCode === 410);
  r = await call(CL.generateCoverLetterTemplatePdf, 7, { template: 'ats_pro', docId: letterDoc.id, coverLetterHtml: '<p>SPOOFED</p>', employer: 'Someone Else', companyName: 'Spoof' });
  ok('docId → 200, rendered from the SAVED letter (body html ignored)', r.statusCode === 200 && rendered.pdf === 1 && rendered.pdfArgs.data.bodyHtml === letterDoc.payload.coverLetterHtml && rendered.pdfArgs.data.company.name === 'Acme', { status: r.statusCode, body: r.body });
  ok('billing employer = doc.employer_name on gate AND claim', dlSpy.can[dlSpy.can.length - 1] === 'Acme' && dlSpy.claim[dlSpy.claim.length - 1] === 'Acme', dlSpy);
  ok('mode defaults to the design mode (a4)', rendered.pdfArgs.opts.mode === 'a4', rendered.pdfArgs.opts);
  ok('history payload carries docId + the frozen text', hist.length === 1 && hist[0].payload.docId === letterDoc.id && hist[0].payload.coverLetterHtml === letterDoc.payload.coverLetterHtml && hist[0].employer === 'Acme', hist[0]);
  r = await call(CL.generateCoverLetterTemplatePdf, 7, { template: 'standard', docId: letterDoc.id, mode: 'onepage' });
  ok('branded standard path uses the doc brand colour', r.statusCode === 200 && rendered.rich === 1 && rendered.richArgs[4] === '#1a73e8', rendered.richArgs && rendered.richArgs.slice(2));
  ok('an explicit mode wins', hist[hist.length - 1].mode === 'onepage', hist[hist.length - 1]);
  r = await call(CL.generateCoverLetterTemplateDocx, 7, { template: 'german', docId: String(letterDoc.id) });
  ok('docx with docId (string id) → 200 from the saved letter', r.statusCode === 200 && rendered.docx === 1 && rendered.docxArgs.data.bodyHtml === letterDoc.payload.coverLetterHtml, r.body);
  ok('docx history carries docId and the doc brand colour', hist[hist.length - 1].payload.docId === letterDoc.id && hist[hist.length - 1].payload.brandColor === '#1a73e8', hist[hist.length - 1]);
  r = await call(CL.generateCoverLetterTemplateDocx, 7, { template: 'german', docId: 'abc' });
  ok('malformed docId → 410', r.statusCode === 410);
  r = await call(CL.generateCoverLetterTemplatePdf, 7, { template: 'ats_pro', coverLetterHtml: '<p>Classic</p>', companyName: 'Classic Co' });
  ok('no docId → the classic lane, unchanged (html from the body)', r.statusCode === 200 && rendered.pdfArgs.data.bodyHtml === '<p>Classic</p>' && !('docId' in hist[hist.length - 1].payload), hist[hist.length - 1]);
  r = await call(CL.generateCoverLetterTemplatePdf, 7, { template: 'ats_pro', companyName: 'Classic Co' });
  ok('classic lane without html is still 400', r.statusCode === 400);

  console.log('── ⚠️ THE EMPLOYER\'S BRAND ON A LETTER (2026-09-15): design.brand stored, in EVERY doc-mode render, the sector-led opening ──');
  {
    // Contracts 4 (letter side) + 5 (letters): the website's colour and font (research.brand, contract 1) beat the
    // researcher's brandColor/fontName; the effective pair is stored as design.brand and reaches employer-cards (hashed into
    // the thumb key for EVERY design, so a changed brand is never served in yesterday's colour), generate-template-pdf/docx
    // with a docId, and the generic PDFKit path; the classic lanes stay byte-for-byte as they were; paragraph 1 opens with
    // the candidate's fit for the employer's sector. The money guards (gate, C2, consume, store-only-when-charged) are the
    // scenarios above — nothing here spends differently.
    const realGER = research.getEmployerResearch;
    ent.sub = { plan_key: 'plus' };
    // 1. the two readings
    const rb = CL.researchBrandOf({ brandColor: '#1a73e8', fontName: 'Inter', brand: { primary: '#ff0000', font: { family: 'Poppins', google: true } } });
    ok('researchBrandOf: brand.primary / brand.font beat the researcher\'s colour and font', rb && rb.accent === '#ff0000' && rb.font.family === 'Poppins' && rb.font.google === true, rb);
    const rb2 = CL.researchBrandOf({ brandColor: '#1A73E8', fontName: 'Inter' });
    // ⚠️ RETARGETED 2026-09-15: a bare researcher fontName reads through brandExtract's STATIC alternative table (Inter →
    // itself, google:true; Segoe UI → Open Sans) — deterministic, no memory, no network; a face the table does not know
    // stays google:false. brandPairOf reduces the font to { family, google } (from / original never reach the renderer).
    ok('researchBrandOf: the researcher\'s pair stands in (lower-cased; a Google-hosted family name reads google:true from the static table)', rb2 && rb2.accent === '#1a73e8' && rb2.font.family === 'Inter' && rb2.font.google === true && !('from' in rb2.font), rb2);
    const rb2b = CL.researchBrandOf({ brandColor: '#1A73E8', fontName: 'Amazon Ember' });
    ok('…a face the table does not know is not google; a non-hosted face it knows renders in its alternative (Segoe UI → Open Sans)',
      rb2b && rb2b.font.family === 'Amazon Ember' && rb2b.font.google === false && JSON.stringify(CL.researchBrandOf({ brandColor: '#0078d4', fontName: 'Segoe UI' }).font) === JSON.stringify({ family: 'Open Sans', google: true }), rb2b);
    ok('researchBrandOf: nothing usable → null, null-safe', CL.researchBrandOf({ industry: 'x' }) === null && CL.researchBrandOf(null) === null);
    const lb = CL.letterBrandOf({ design: { brand: { accent: '#00ff00', font: null } }, research: { brandColor: '#1a73e8' }, payload: { brandColor: '#123456' } });
    ok('letterBrandOf: the stored design.brand first', lb && lb.accent === '#00ff00' && lb.font === null, lb);
    const lb2 = CL.letterBrandOf({ design: JSON.stringify({ ranked: [] }), research: JSON.stringify({ brandColor: '#1a73e8', fontName: 'Inter' }), payload: { brandColor: '#123456' } });
    ok('letterBrandOf: the stored research next (string columns parsed)', lb2 && lb2.accent === '#1a73e8' && lb2.font.family === 'Inter', lb2);
    const lb3 = CL.letterBrandOf({ design: null, research: null, payload: { brandColor: '#123456', fontName: 'Lato' } });
    ok('letterBrandOf: the payload last; nothing → null', lb3 && lb3.accent === '#123456' && lb3.font.family === 'Lato' && CL.letterBrandOf({ payload: {} }) === null, lb3);
    // 2. the prompt and the style (contract 5)
    const pSec = EL.buildEmployerLetterPrompt({ company: 'Acme', website: '', job: { title: '', url: '', description: '', website: '' }, material: { baseText: 'x', uploadText: '' }, tailored: null, researchBlock: '', conventionsBlock: '', style: EL.letterStyleFor(null, 'generic'), sector: 'Fintech payments' });
    ok('prompt: paragraph 1\'s FIRST sentence states the fit for the sector, never a sentence that could open a letter to anyone',
      /FIRST sentence states the candidate's fit for Fintech payments/.test(pSec) && /never a sentence that could open a letter to any employer/.test(pSec));
    const pNo = EL.buildEmployerLetterPrompt({ company: 'Acme', website: '', job: { title: '', url: '', description: '', website: '' }, material: { baseText: 'x', uploadText: '' }, tailored: null, researchBlock: '', conventionsBlock: '', style: EL.letterStyleFor(null, 'generic') });
    ok('prompt: no sector → the factual opener, still employer-specific', /One factual opening sentence/.test(pNo) && !/FIRST sentence states/.test(pNo));
    const st = EL.letterStyleFor({ employerType: 'startup', tone: 'direct' }, 'generic');
    ok('style: the conventions\' tone folded as a note, the startup band kept; no conventions → no notes', st.words === '230-320' && st.notes.some((n) => /"direct"/.test(n)) && EL.letterStyleFor(null, 'generic').notes.length === 0, st);
    // 3. the build stores design.brand from the research (the website's brand wins)
    reset();
    research.getEmployerResearch = async (a) => { researchCalls.push(a); return { conventions: { sector: 'Fintech', employerType: 'enterprise' }, domain: 'acme.test', employerName: 'Acme', industry: 'Fintech payments', companySize: '10,001+', mission: 'Move money', technologies: ['Kafka'], clients: [], recentActivity: [], brandColor: '#1a73e8', fontName: 'Inter', brand: { primary: '#c0392b', secondary: null, font: { family: 'Poppins', google: true }, from: {}, fetchedAt: new Date().toISOString() }, fetchedAt: new Date().toISOString() }; };
    // Its own employer: an Acme build here would be the free cache hit the scenarios above already stored.
    r = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Brandwerk', job: { ...JOB, company: 'Brandwerk', website: 'brandwerk.test' } }), { __jobId: 'job-brand' });
    const putB = store.puts[0];
    ok('build 200, ONE AI call, ONE consume', r.statusCode === 200 && ai.calls.length === 1 && ent.consumed.length === 1, r.body);
    ok('⚠️ design.brand stored = { accent, font } from the research (the website\'s #c0392b / Poppins, not the researcher\'s #1a73e8 / Inter)',
      putB && putB.design && putB.design.brand && putB.design.brand.accent === '#c0392b' && putB.design.brand.font.family === 'Poppins' && putB.design.brand.font.google === true, putB && putB.design && putB.design.brand);
    ok('the payload keeps its exact keys, brandColor/fontName now the EFFECTIVE pair',
      JSON.stringify(Object.keys(putB.payload).sort()) === JSON.stringify(['brandColor', 'companyAddress', 'companyName', 'coverLetterHtml', 'fontName', 'hiringManager', 'locations', 'position', 'subject'].sort()) && putB.payload.brandColor === '#c0392b' && putB.payload.fontName === 'Poppins', putB.payload && Object.keys(putB.payload));
    ok('the prompt opened for the conventions\' sector', /fit for Fintech:/.test(ai.calls[0].prompt));
    ok('the pre-rendered thumbs were painted with brandColor + brandFont', rendered.previews.length === 1 && rendered.previews[0].opts.brandColor === '#c0392b' && rendered.previews[0].opts.brandFont.family === 'Poppins', rendered.previews[0] && rendered.previews[0].opts);
    // 4. cards: the same brand is a cache hit; a changed brand re-renders in the new colour
    const bdoc = store.rows.find((x) => x.id === r.body.docId);
    rendered.previews = [];
    res = mkRes(); await EL.employerLetterCards(mkReq(7, {}, { query: { doc: String(bdoc.id), ids: bdoc.design.ranked[0].id } }), res);
    ok('cards: a cache hit for the pre-rendered top design', res.statusCode === 200 && rendered.previews.length === 0 && res.body.cards.length === 1, res.body);
    bdoc.design = { ...bdoc.design, brand: { accent: '#111111', font: null } };
    rendered.previews = []; res = mkRes(); await EL.employerLetterCards(mkReq(7, {}, { query: { doc: String(bdoc.id), ids: bdoc.design.ranked[0].id } }), res);
    ok('⚠️ cards: a changed brand misses the thumb cache and renders in the new colour (the brand is in the key for EVERY design)',
      rendered.previews.length === 1 && rendered.previews[0].opts.brandColor === '#111111' && rendered.previews[0].opts.brandFont === null, rendered.previews[0] && rendered.previews[0].opts);
    bdoc.design = { ...bdoc.design, brand: { accent: '#c0392b', font: { family: 'Poppins', google: true } } };
    ok('/current re-attaches the brand to the re-ranked design', (() => { const d = EL.designOfLetterDoc ? EL.designOfLetterDoc(bdoc) : null; return !EL.designOfLetterDoc || (d && d.brand && d.brand.accent === '#c0392b'); })());
    // 5. downloads by docId carry the brand; the classic lanes do not
    rendered.pdf = 0; rendered.docx = 0; rendered.rich = 0;
    r = await call(CL.generateCoverLetterTemplatePdf, 7, { template: 'ats_pro', docId: bdoc.id });
    ok('pdf docId: renderPdf gets brandColor + brandFont beside the mode', r.statusCode === 200 && rendered.pdfArgs.opts.brandColor === '#c0392b' && rendered.pdfArgs.opts.brandFont.family === 'Poppins' && rendered.pdfArgs.opts.mode === 'a4', rendered.pdfArgs && rendered.pdfArgs.opts);
    r = await call(CL.generateCoverLetterTemplatePdf, 7, { template: 'standard', docId: bdoc.id });
    ok('pdf docId generic: the brand colour and the Google font family reach the PDFKit generator', r.statusCode === 200 && rendered.richArgs[4] === '#c0392b' && rendered.richArgs[5] === 'Poppins', rendered.richArgs && rendered.richArgs.slice(4));
    r = await call(CL.generateCoverLetterTemplateDocx, 7, { template: 'german', docId: bdoc.id });
    ok('docx docId: buildCoverLetterDocx gets opts.brand = { accent, font }', r.statusCode === 200 && rendered.docxArgs.opts.brand.accent === '#c0392b' && rendered.docxArgs.opts.brand.font.family === 'Poppins' && rendered.docxArgs.opts.template === 'german', rendered.docxArgs && rendered.docxArgs.opts);
    ok('docx history brandColor = the effective accent', hist[hist.length - 1].payload.brandColor === '#c0392b', hist[hist.length - 1].payload.brandColor);
    r = await call(CL.generateCoverLetterTemplatePdf, 7, { template: 'ats_pro', coverLetterHtml: '<p>Classic</p>', companyName: 'Classic Co' });
    ok('⚠️ the classic pdf lane: opts stay { mode } only', r.statusCode === 200 && JSON.stringify(Object.keys(rendered.pdfArgs.opts)) === JSON.stringify(['mode']), rendered.pdfArgs.opts);
    r = await call(CL.generateCoverLetterTemplateDocx, 7, { template: 'german', coverLetterHtml: '<p>Classic</p>', companyName: 'Classic Co' });
    ok('⚠️ the classic docx lane: no brand key', r.statusCode === 200 && !('brand' in rendered.docxArgs.opts), rendered.docxArgs.opts);
    // 6. a letter stored before design.brand existed renders from its research
    const oldRow = { ...bdoc, id: 9901, design: { ...bdoc.design }, research: { brandColor: '#0e7490', fontName: 'Inter' } };
    delete oldRow.design.brand; store.rows.push(oldRow);
    rendered.previews = []; res = mkRes(); await EL.employerLetterCards(mkReq(7, {}, { query: { doc: '9901', ids: 'technical' } }), res);
    ok('an older row: the research\'s colour and font are used', rendered.previews.length === 1 && rendered.previews[0].opts.brandColor === '#0e7490' && rendered.previews[0].opts.brandFont.family === 'Inter', rendered.previews[0] && rendered.previews[0].opts);
    research.getEmployerResearch = realGER;
    // 6b. ⚠️ (2026-09-15) letterBrandOf is a function of the ROW: brandOf used to consult brandExtract's per-process font
    // memory for a bare researcher fontName, so the same stored letter changed brand (and thumb key) after a deploy.
    {
      const BX = require(path.join(ROOT, 'server/services/brandExtract.js'));
      const oldLetter = { id: 2, design: { ranked: [] }, research: { domain: 'mont-letter-test.com', fontName: 'Montserrat', brandColor: '#123456' }, payload: { coverLetterHtml: '<p>x</p>' } };
      const lBefore = CL.letterBrandOf(oldLetter);
      // ⚠️ RETARGETED 2026-09-15: Montserrat is google:true from the STATIC table on every process; the memory-independence
      // the pin protects is held by a face the table does not know (Amazon Ember), which the memory is then taught.
      ok('cold process: the bare researcher fontName reads through the static table (Montserrat → itself, google:true)', !!lBefore && lBefore.font.family === 'Montserrat' && lBefore.font.google === true && lBefore.accent === '#123456', lBefore);
      const emberLetter = { ...oldLetter, id: 3, research: { ...oldLetter.research, fontName: 'Amazon Ember' } };
      const eBefore = CL.letterBrandOf(emberLetter);
      ok('…a face the table does not know is google:false', !!eBefore && eBefore.font.family === 'Amazon Ember' && eBefore.font.google === false, eBefore);
      const realKnown = BX.googleFontKnown;
      BX.googleFontKnown = (f) => (['montserrat', 'amazon ember'].includes(String(f).toLowerCase()) ? true : realKnown(f));
      try {
        const fresh = await research._internals.withResearcherFont({ domain: 'mont-letter-test.com', fontName: 'Montserrat' }, 5000);
        ok('(the memory is live: a fresh build writes google:true onto brand.font)', !!fresh && !!fresh.brand && fresh.brand.font.google === true);
        ok('⚠️ the stored letter\'s brand is byte-identical after the memory learned the family — the table-known one AND the unknown one (still google:false)',
          JSON.stringify(CL.letterBrandOf(oldLetter)) === JSON.stringify(lBefore) && JSON.stringify(CL.letterBrandOf(emberLetter)) === JSON.stringify(eBefore) && CL.letterBrandOf(emberLetter).font.google === false, [CL.letterBrandOf(oldLetter), CL.letterBrandOf(emberLetter)]);
        // ⚠️ PROD DOC 9's letter-side twin: a letter whose design.brand STORED the raw site face at build time is read straight
        // off the row, never through brandOf — so the table is applied there too (brandFontOf), one reading of one row.
        ok('⚠️ a stored raw site face on design.brand renders in its Google alternative (DB Neo → Barlow); a stored unknown face stays as stored',
          JSON.stringify(CL.letterBrandOf({ id: 9, design: { ranked: [], brand: { accent: '#EC0016', font: { family: 'DB Neo Screen Sans Regular', google: false } } } })) === JSON.stringify({ accent: '#ec0016', font: { family: 'Barlow', google: true } })
          && JSON.stringify(CL.letterBrandOf({ id: 9, design: { ranked: [], brand: { accent: '#ff9900', font: { family: 'Amazon Ember', google: false } } } })) === JSON.stringify({ accent: '#ff9900', font: { family: 'Amazon Ember', google: false } }));
        ok('…while a research carrying the verified answer reads google:true', CL.researchBrandOf(fresh).font.google === true);
      } finally { BX.googleFontKnown = realKnown; }
    }
    // 6c. ⚠️ a letter with NO brand of its own catches up with the shared row, read-only (withSharedLetterBrand)
    {
      const ROW_BRAND = { primary: '#e30613', secondary: '#00857c', font: { family: 'Space Grotesk', google: true }, from: { primary: 'theme-color', font: 'body' }, fetchedAt: new Date().toISOString() };
      const asked = [];
      const realCBF = research.cachedBrandFor;
      research.cachedBrandFor = async (domain) => { asked.push(domain); return domain === 'acme-letter-test.com' ? ROW_BRAND : null; };
      try {
        const nullLetter = () => ({ id: 4, design: { ranked: [], brand: null }, research: { domain: 'acme-letter-test.com', industry: 'Widgets' }, payload: { coverLetterHtml: '<p>x</p>' } });
        ok('before: letterBrandOf null (design.brand null, nothing on the research, nothing in the payload)', CL.letterBrandOf(nullLetter()) === null);
        const l = await CL.withSharedLetterBrand(nullLetter());
        const lg = CL.letterBrandOf(l);
        ok('⚠️ withSharedLetterBrand: the row\'s brand becomes research.brand — letterBrandOf = its accent + font; ONE read of the snapshot\'s domain',
          JSON.stringify(lg) === JSON.stringify({ accent: '#e30613', font: { family: 'Space Grotesk', google: true } }) && asked.length === 1 && asked[0] === 'acme-letter-test.com', { lg, asked });
        asked.length = 0;
        const own = await CL.withSharedLetterBrand({ ...nullLetter(), design: { ranked: [], brand: { accent: '#111111', font: null } } });
        ok('a letter WITH its own brand never asks the row', asked.length === 0 && CL.letterBrandOf(own).accent === '#111111');
        const payloadBrand = await CL.withSharedLetterBrand({ ...nullLetter(), payload: { coverLetterHtml: '<p>x</p>', brandColor: '#123456' } });
        ok('a payload brandColor is a brand of its own: no read', asked.length === 0 && CL.letterBrandOf(payloadBrand).accent === '#123456');
        const noResearch = await CL.withSharedLetterBrand({ id: 5, design: { brand: null }, research: null, payload: { coverLetterHtml: '<p>x</p>' } });
        ok('no research snapshot → left alone (no domain of record), no read', asked.length === 0 && noResearch.research === null);
        const strRow = await CL.withSharedLetterBrand({ ...nullLetter(), research: JSON.stringify({ domain: 'acme-letter-test.com' }) });
        ok('a stringified research column is parsed, and the brand laid over the parsed object', asked.length === 1 && CL.letterBrandOf(strRow) !== null && strRow.research.brand === ROW_BRAND);
        research.cachedBrandFor = async () => { throw new Error('boom'); };
        const errL = await CL.withSharedLetterBrand(nullLetter());
        ok('a failing read leaves the letter untouched (never throws)', CL.letterBrandOf(errL) === null);
      } finally { research.cachedBrandFor = realCBF; }
    }
    // 7. the source rules behind it
    const stripL = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const elC = stripL(fsSync.readFileSync(path.join(ROOT, 'server/controllers/employerLetterController.js'), 'utf8'));
    ok('⚠️ the thumb key hashes the brand pair for every design, and the cards render with it',
      /const brandHash = sha\(JSON\.stringify\(\{ accent: accent \|\| null, font: brandFont \}\)\)\.slice\(0, 16\);/.test(elC)
      && /clRenderer\.renderPreviews\(data, \{ photo, brandColor: accent, brandFont \}, missing\)/.test(elC));
    ok('⚠️ LETTER_REV stays letter-v1 through the brand round (a bump re-bills every saved letter)', /const LETTER_REV = 'letter-v1';/.test(elC) && !/LETTER_REV = 'letter-v2'/.test(elC));
    ok('the brand readings live in the core controller (docId downloads never depend on the feature file)',
      typeof CL.researchBrandOf === 'function' && typeof CL.letterBrandOf === 'function' && typeof CL.withSharedLetterBrand === 'function');
    const clC = stripL(fsSync.readFileSync(path.join(ROOT, 'server/controllers/coverLetterController.js'), 'utf8'));
    ok('⚠️ employerLetterDocFor (docId PDF / DOCX) lays the shared brand on before savedLetterInput reads it; the read is cachedBrandFor and nothing that bills or writes',
      /withSharedLetterBrand\(doc\) : LETTER_DOC_GONE/.test(clC)
      && (() => { const b = (clC.match(/async function withSharedLetterBrand\(doc\) \{[\s\S]*?\n\}/) || [''])[0]; return b.length > 100 && /cachedBrandFor\(domain\)/.test(b) && !/getEmployerResearch|researchBrand\(|brandCallFor|INSERT|UPDATE/.test(b); })());   // researchBrandOf is the READER; researchBrand( is the website call
    ok('⚠️ the feature file adopts it at BOTH of its loads (the post-build thumb prerender and employerLetterCards) — before letterCardsFor hashes the brand, so a thumb is the file the download would produce',
      (elC.match(/await withSharedLetterBrand\((cl|clMod\(\)), await employerDocs(Mod\(\))?\.getById\(/g) || []).length === 2 && /async function withSharedLetterBrand\(cl, doc\)/.test(elC));
  }

  console.log('── helpers ──');
  ok('findLetterPlaceholders', JSON.stringify(EL.findLetterPlaceholders('by [X%] and [Insert metric] for {Company Name} XX% $X and N years [Next.js stays]')) === JSON.stringify(['[X%]', '[Insert metric]', '{Company Name}', 'XX%', '$X', 'N years']), EL.findLetterPlaceholders('by [X%] and [Insert metric] for {Company Name} XX% $X and N years [Next.js stays]'));
  ok('cleanPosition keeps real parentheses', EL.cleanPosition('Software Engineer (m/w/d)') === 'Software Engineer (m/w/d)' && EL.cleanPosition('Engineer (Open Application)') === 'Engineer' && EL.cleanPosition('[Position]') === '' && EL.cleanPosition('Open application') === '');
  // ⚠️ A BRACKET IS NOT A PLACEHOLDER FOR BEING A BRACKET. Whatever is found here is DELETED from a letter
  // the user paid for, and the old rule called any bracket a slot when a %, a lone X/N or a slot word
  // appeared ANYWHERE inside it: "[top 5%]", "[CGPA 8.4 / 85%]", "[Class X]", "[C#]", "[Team Lead]" and
  // "[Name Service]" were all cut out of finished letters. A bracket is a slot only when it IS one.
  {
    const keeps = ['[top 5%]', '[CGPA 8.4 / 85%]', '[Class X]', '[C#]', '[Team Lead]', '[Name Service]',
      '[Add-on]', '[Insertion sort]', '[Next.js stays]', '[2019]', '[85.40%]'];
    const kept = keeps.filter((t) => EL.findLetterPlaceholders(t).length === 0);
    ok('⚠️ a letter\'s real brackets survive the guard', kept.length === keeps.length, keeps.filter((t) => !kept.includes(t)));
    const slots = ['[X%]', '[Insert metric]', '[Company Name]', '{your name}', '[$XX,XXX]', 'XX%', '[Hiring Manager\'s Name]',
      '[Job Title]', '[N years]', '[Your Name]', '[Number of employees]'];
    const caught = slots.filter((t) => EL.findLetterPlaceholders(t).length > 0);
    ok('⚠️ …and every real slot is still caught', caught.length === slots.length, slots.filter((t) => !caught.includes(t)));
    // One bracket token counts ONCE: the bare-marker sweep must not find "X%" again inside "[X%]".
    ok('⚠️ a bracket token is one token, never counted twice',
      JSON.stringify(EL.findLetterPlaceholders('by [X%] alone')) === JSON.stringify(['[X%]']), EL.findLetterPlaceholders('by [X%] alone'));
    // …but a bare marker inside a bracket that is NOT a slot is still a marker.
    ok('…while a bare marker inside a real bracket is still removed',
      EL.findLetterPlaceholders('[5 years, X%]').includes('X%'), EL.findLetterPlaceholders('[5 years, X%]'));
  }

  fsSync.rmSync(THUMBS, { recursive: true, force: true });
  finished = true;
  console.log(`\nemployer letter lane: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { finished = true; console.error('TEST ERROR:', e); fsSync.rmSync(THUMBS, { recursive: true, force: true }); process.exit(2); });
