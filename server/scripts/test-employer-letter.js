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
'use strict';
const path = require('path');
const os = require('os');
const fsSync = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const THUMBS = fsSync.mkdtempSync(path.join(os.tmpdir(), 'cva-letter-thumbs-'));
process.env.DOC_THUMB_CACHE_DIR = THUMBS;   // ⚠️ before the controller is required — it reads this at load
process.env.GEMINI_API_KEY = 'test-key-not-used';

let pass = 0, fail = 0; const failures = [];
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
const ent = { quota: { allowed: true, via: 'plan', remaining: 5 }, quotaSeq: null, used: { via: 'plan' }, consumed: [], gateCalls: 0, sub: { plan_key: 'plus' }, legacyEntitlements: false };
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
});

// the AI
const ai = { queue: [], calls: [] };
const genaiPath = require.resolve('@google/generative-ai', { paths: [ROOT] });
require.cache[genaiPath] = { id: genaiPath, filename: genaiPath, loaded: true, exports: {
  GoogleGenerativeAI: class { getGenerativeModel(cfg) { return { generateContent: async (prompt) => {
    ai.calls.push({ prompt, cfg });
    const next = ai.queue.length ? ai.queue.shift() : GOOD();
    if (next instanceof Error) throw next;
    if (next && next.slow) { await new Promise((r) => setTimeout(r, next.slow)); return { response: { text: () => next.text, candidates: [{ finishReason: 'STOP' }] } }; }
    return { response: { text: () => next, candidates: [{ finishReason: 'STOP' }] } };
  } }; } },
} };
const PARA = (n) => `Paragraph ${n} about **Node.js** and **PostgreSQL** work the candidate did across payment systems, reliability, observability and careful delivery for teams that ship every week without drama or heroics, with clear ownership of services from design review through production support and steady mentoring.`;
const GOOD = (over = {}) => JSON.stringify({ position: 'Senior Backend Engineer', to: 'Hiring Manager', addresses: [], cover_letter: [PARA(1), PARA(2), PARA(3), PARA(4)].join('\n\n'), ...over });

stub('ai-cover-letter-v2.js', { generateCoverLetter: async () => { throw new Error('legacy v2 must not be called'); } });
stub('ai-employer-researcher.js', { researchEmployer: async () => { throw new Error('researcher must not be called directly'); } });
stub('server/controllers/notificationsController.js', { notifyCoverLetterGenerated: async () => {}, notifyError: async () => {} });
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
research.getEmployerResearch = async (a) => { researchCalls.push(a); return { domain: 'acme.test', employerName: 'Acme', industry: 'Fintech payments', companySize: '10,001+ employees', mission: 'Move money safely', technologies: ['Kafka'], clients: [], recentActivity: [], brandColor: '#1a73e8', fontName: 'Inter', fetchedAt: new Date().toISOString() }; };
const scorer = require(path.join(ROOT, 'server/services/resumeScorer.js'));
const narr = { value: { text: 'Current title: Senior Backend Engineer\n\nEXPERIENCE\nSenior Backend Engineer at Payly | Jan 2016 – Present\n- Built the ledger service', source: 'builder' }, throwIt: null };
scorer.narrativeFor = async () => { if (narr.throwIt) throw narr.throwIt; return narr.value; };

const D = require(path.join(ROOT, 'server/services/downloads.js'));
const passSpy = { cover: false, coverCalls: [], claim: { charged: false }, claimCalls: [] };
D.passCoversGeneration = async (...a) => { passSpy.coverCalls.push(a); return passSpy.cover; };
D.claimGeneration = async (...a) => { passSpy.claimCalls.push(a); return passSpy.claim; };
const dlSpy = { can: [], claim: [] };
const realCan = D.canDownload, realClaim = D.claimDownload;
D.canDownload = async (u, o, r) => { dlSpy.can.push(o && o.employer); return realCan(u, o, r); };
D.claimDownload = async (u, o, r) => { dlSpy.claim.push(o && o.employer); return realClaim(u, o, r); };

const EL = require(path.join(ROOT, 'server/controllers/employerLetterController.js'));
const CL = require(path.join(ROOT, 'server/controllers/coverLetterController.js'));
const routes = require(path.join(ROOT, 'server/routes/coverLetterRoutes.js'));

function mkRes() { const r = { statusCode: 200, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; }
const mkReq = (userId, body, extra = {}) => ({ user: { id: userId }, body, query: {}, headers: {}, ...extra });
const call = async (fn, userId, body, extra) => { const res = mkRes(); await fn(mkReq(userId, body, extra), res); return res; };
const reset = () => { ai.queue = []; ai.calls = []; ent.consumed = []; ent.gateCalls = 0; ent.quota = { allowed: true, via: 'plan', remaining: 5 }; ent.quotaSeq = null; ent.used = { via: 'plan' }; ent.legacyEntitlements = false; passSpy.cover = false; passSpy.coverCalls = []; passSpy.claim = { charged: false }; passSpy.claimCalls = []; store.puts = []; store.failPut = false; researchCalls.length = 0; stages.length = 0; narr.throwIt = null; world.metaThrow = null; world.creditHistory = { n: 0, cost: 0 }; world.ledgerCredits = { n: 0 }; world.refunds = []; rendered.previews = []; resumeDocs.doc = null; rbFp.value = null; };
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
  ok('country does not move it (letter text is region-neutral)', curOtherCountry === buildFp);
  const curTitle = await EL.currentLetterFingerprint(7, { job: { company: 'Acme', website: 'acme.test', title: 'Staff Engineer' }, env: 'Production' });
  ok('a posting title moves it', curTitle !== buildFp);
  const curSandbox = await EL.currentLetterFingerprint(7, { job: { website: 'acme.test' }, env: 'Sandbox' });
  ok('env is accepted as a string', typeof curSandbox === 'string');
  narr.throwIt = new Error('db down');
  ok('unreadable → null, never a throw', (await EL.currentLetterFingerprint(7, { job: JOB, env: 'Production' })) === null);
  narr.throwIt = null;

  console.log('── gate ──');
  reset();
  r = await call(EL.employerLetterGate, 7, { employer: 'Acme', employerId: 'x', country: 'United States', job: { website: 'acme.test' } });
  ok('the stored letter → covered via cache', r.body.covered === true && r.body.via === 'cache' && r.body.credits === null && r.body.reason === null, r.body);
  ok('⚠️ …without asking the quota', ent.gateCalls === 0);
  reset();
  r = await call(EL.employerLetterGate, 7, { employer: 'Acme', job: { website: 'acme.test', title: 'Staff Engineer' } });
  ok('plan covers → via plan', r.body.covered === true && r.body.via === 'plan', r.body);
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
  reset(); ai.queue = ['not json', '{"cover_letter":"too short"}'];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'QA Lead' } }));
  ok('two bad outputs → 500 failed', r.statusCode === 500 && r.body.reason === 'failed', r.body);
  ok('⚠️ no consume, no put', ent.consumed.length === 0 && store.puts.length === 0);
  reset(); ai.queue = [new Error('AI_TIMEOUT'), new Error('AI_TIMEOUT')];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'QA Lead' } }));
  ok('two timeouts → 504', r.statusCode === 504 && r.body.isTimeout === true, r.body);

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
  console.log(`\nemployer letter lane: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e); fsSync.rmSync(THUMBS, { recursive: true, force: true }); process.exit(2); });
