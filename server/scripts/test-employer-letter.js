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
// ⚠️ AND (2026-09-18, the owner's decision): "we have a prompt/api that is already written on the jobs section and that
// used to generate good cover letters with project details and clients and hence we finalized that… we need to use the
// same one… and not the new one". Home's letter is WRITTEN by the Jobs section's generation now — ai-cover-letter-v2's
// buildPrompt through coverLetterController's own functions (the metadata loader, the research subject, the posting,
// Google Search grounding, v2's config, the letter chain, the parsing, the mapping), called and never copied. The pins
// that matter most: the prompt the two lanes send for the same job is IDENTICAL, and the Home lane builds none of its own.
// Everything around the words (the gate, the cache, the flights, the money, the stored document, the design ranking,
// the brand, the thumbnails, the 503 answers) is pinned exactly as before.
// ⚠️ THE CHAIN IS THE LETTER CHAIN (reverted 2026-09-18, the same day): [coverLetterController.LEGACY_LETTER_MODEL
// (gemini-2.5-flash), ...letterFallbacks()], v2's config on every model, no per-model config. For one afternoon the
// letter lanes spread aiText.writing(); that chain was measured on Home's OLD prompt, never on v2's grounded one. Every
// scenario reads the chain from the modules the lane calls (P, F1, F2 below) — a model id hard-coded here would script a
// storm on a model the lane does not ask first, and the storm would simply never happen.
// ⚠️ RETARGETED 2026-09-18 (the measured letter backups): the backups are the controller's OWN letterFallbacks() —
// gemini-3.1-flash-lite first, then gemini-2.5-flash-lite — no longer aiText.fallbackModels() (2.5-flash-lite first).
// Measured on v2's grounded prompt: 2.5-flash-lite broke 2 of 3 letters, 3.1-flash-lite gave 3/3 usable. The literal
// order is pinned ONCE (LETTER_CHAIN_PINNED); every other assertion reads it through CL._internals.
'use strict';
const path = require('path');
const os = require('os');
const fsSync = require('fs');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const THUMBS = fsSync.mkdtempSync(path.join(os.tmpdir(), 'cva-letter-thumbs-'));
process.env.DOC_THUMB_CACHE_DIR = THUMBS;   // ⚠️ before the controller is required — it reads this at load
process.env.GEMINI_API_KEY = 'test-key-not-used';
// The MEASURED letter fallbacks (coverLetterController LETTER_FALLBACKS) the letter chain walks after its primary,
// whatever the shell exports: an operator's AI_TEXT_FALLBACK_MODELS wins over them (letterFallbacks()), so a list would
// replace them and "none" would leave a one-model chain with no fallback for any storm below to reach. The scenarios
// that pin the operator's switch set it themselves, and put it back.
delete process.env.AI_TEXT_FALLBACK_MODELS;
process.env.USE_ASYNC_JOBS = 'false';   // the Jobs lane (POST /generate-cover-letter-details) answers synchronously here

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
  // The Jobs lane's brand cache (employer_brand_profiles). null = no row; the Jobs-lane comparison sets one, so that lane
  // never reaches its own researcher (stubbed below to throw).
  brandProfile: null,
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
  if (/SELECT brand_color, font_name FROM employer_brand_profiles/.test(q)) return world.brandProfile;
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
// ⚠️ Each paragraph DIFFERENT, as a letter's are (review round 3, 2026-09-20): they used to differ only by their number — one
// paragraph written four times, which the writer's near-copy rule (letterText.isNearDuplicate) now rightly refuses.
const PARA_WORK = [
  'on the payments ledger: I rebuilt the settlement pipeline for card and bank payouts, cut reconciliation from two days to four hours, and wrote the runbooks the finance team still follows at every month-end close across both European entities.',
  'on search, moving product lookup from nightly batch jobs to streaming indexes, so merchants saw their price changes within seconds and a whole class of stale-catalogue support tickets simply disappeared from the queue that spring.',
  'on reliability: I led the incident review programme, set service-level objectives for eleven services, and paired with on-call engineers until paging volume fell by half within one quarter, without adding a single new hire.',
  'on people, mentoring six junior developers through their first production launches, running weekly design clinics, and helping two of them grow into leads who now own the fraud and identity services end to end.',
  'on cost: an audit of storage tiers, connection pooling and query plans trimmed the monthly database bill by thirty percent, while the busiest customer dashboards actually got faster during the same eight-week effort.',
  'on migrations, retiring a fragile monolith schema in eleven reversible steps, shadow-writing every table and comparing results daily, so not one customer noticed the switch to partitioned storage over that long winter.',
  'on security: I introduced secret rotation, least-privilege roles and audit trails for administrative queries, which passed an external penetration test and a PCI assessment on the first attempt, ahead of the regulator\'s deadline.',
  'on analytics, designing event pipelines that feed near-real-time funnels for marketing, while the same warehouse models now drive demand forecasting for inventory planners in three regions and the quarterly board pack.',
  'on mobile: a lean GraphQL gateway in front of legacy endpoints halved payload sizes for the iOS and Android apps and let designers ship offline-friendly screens for travelling sales staff in rural areas.',
  'on hiring, rewriting our interview loop around realistic pairing exercises, training twelve interviewers, and shortening time-to-offer from five weeks to under three without lowering the bar for any of the senior roles.',
];
const PARA = (n) => `Paragraph ${n} about **Node.js** and **PostgreSQL** work ${PARA_WORK[(n - 1) % PARA_WORK.length]}`;
// ai-cover-letter-v2's answer, in its own shape (to, employer_name, position, addresses, subject, cover_letter). A key set
// to undefined is left out of the JSON — how a scenario says "the model did not give one".
const GOOD = (over = {}) => JSON.stringify({ to: 'Hiring Manager', employer_name: 'Acme Corporation', position: 'Senior Backend Engineer', addresses: [], subject: 'Application for Senior Backend Engineer — Jane Doe', cover_letter: [PARA(1), PARA(2), PARA(3), PARA(4)].join('\n\n'), ...over });
/** The prompt TEXT a call carried (the letter is a grounded request: { contents, tools }), and the tools on it. */
const textOf = (c) => (c && c.prompt && Array.isArray(c.prompt.contents) ? c.prompt.contents[0].parts[0].text : String((c && c.prompt) || ''));
const toolsOf = (c) => (c && c.prompt && c.prompt.tools) || null;

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

// ⚠️ THE REAL ai-cover-letter-v2 (read-only — the finalized prompt): its buildPrompt is what both lanes must send. Loaded
// after the SDK stub above (it takes the SDK at load); its own callGemini is never reached — the call is aiText's.
const V2 = require(path.join(ROOT, 'ai-cover-letter-v2.js'));
const realBuildPrompt = V2.buildPrompt;
const v2Calls = [];   // every buildPrompt call, with its arguments — from EITHER lane
V2.buildPrompt = (...a) => { v2Calls.push(a); return realBuildPrompt(...a); };
V2.generateCoverLetter = async () => { throw new Error("v2's own model call must never run: the letter goes through aiText"); };
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
  // PREVIEW_REV: the renderer's name for its preview resolution/format — every page/card key carries it (the contract).
  PREVIEW_REV: 'test-rev-1',
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
const CL = require(path.join(ROOT, 'server/controllers/coverLetterController.js'));
// ⚠️ THE CHAIN THE LANE WALKS — the letter chain, read from the module the writer lives in: P = LEGACY_LETTER_MODEL, F1 /
// F2 = the controller's own letterFallbacks() (its measured LETTER_FALLBACKS while AI_TEXT_FALLBACK_MODELS is unset — it
// is, above). The storm scenarios wrap AT.generateText and see the lane's call on exactly this chain, which proves it.
// Never written out as ids — except ONCE, in LETTER_CHAIN_PINNED.
const [P, F1, F2] = [CL.LEGACY_LETTER_MODEL, ...CL._internals.letterFallbacks()];
/** The ONE literal pin of the letter chain's order. Why this order: on v2's grounded prompt (2026-09-18, three letters per
 *  model, judged blind) 3.1-flash-lite gave 3/3 usable letters and 2.5-flash-lite broke 2 of 3 — so it goes last. */
const LETTER_CHAIN_PINNED = Object.freeze(['gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite']);
/** v2's generationConfig — what EVERY model of the letter chain is asked with (no per-model config, no thinkingConfig). */
const LETTER_CFG = CL._internals.legacyLetterConfig();
const routes = require(path.join(ROOT, 'server/routes/coverLetterRoutes.js'));

function mkRes() { const r = { statusCode: 200, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; }
const mkReq = (userId, body, extra = {}) => ({ user: { id: userId }, body, query: {}, headers: {}, ...extra });
const call = async (fn, userId, body, extra) => { const res = mkRes(); await fn(mkReq(userId, body, extra), res); return res; };
const reset = () => { v2Calls.length = 0; world.brandProfile = null; ent.usageCalls = []; ent.usageThrows = false; passState.calls = []; passState.answer = { available: false, forThisEmployer: false }; researchConv = null; ai.queue = []; ai.calls = []; ai.fail = null; ent.consumed = []; ent.gateCalls = 0; ent.quota = { allowed: true, via: 'plan', remaining: 5 }; ent.quotaSeq = null; ent.used = { via: 'plan' }; ent.legacyEntitlements = false; passSpy.cover = false; passSpy.coverCalls = []; passSpy.claim = { charged: false }; passSpy.claimCalls = []; store.puts = []; store.failPut = false; researchCalls.length = 0; stages.length = 0; narr.throwIt = null; world.metaThrow = null; world.creditHistory = { n: 0, cost: 0 }; world.ledgerCredits = { n: 0 }; world.refunds = []; rendered.previews = []; resumeDocs.doc = null; rbFp.value = null; };
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
  ok('⚠️ …and the ONE letter writer\'s pieces, exported for the Home lane to call (never copy)',
    ['writeLegacyLetter', 'letterResumeMetadataFor', 'mergeBuilderResume', 'letterResearchSubjectOf', 'letterListingOf', 'letterDetailsOf'].every((k) => typeof CL[k] === 'function')
    && CL.ADDRESS_NOT_AVAILABLE === 'Address not available' && CL.LEGACY_LETTER_MODEL === 'gemini-2.5-flash', Object.keys(CL));
  ok('⚠️ the Home lane\'s own prompt machinery is GONE (no prompt builder, no output parser, no style, no playbook, no placeholder strip)',
    ['buildEmployerLetterPrompt', 'parseLetterOutput', 'letterStyleFor', 'letterPlaybookFor', 'letterPlaybookBlockFor', 'countryLetterRowOf', 'LETTER_PROFILES', 'stripLetterPlaceholders', 'LETTER_MODEL'].every((k) => !(k in EL)), Object.keys(EL));

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
  // ⚠️ REVERSED BY DESIGN 2026-09-18 (the owner's decision): this was "no search tool, JSON mime + schema" — the Home
  // lane's own ungrounded prompt. The letter is v2's now: Google Search grounding ON, v2's config (no JSON mode — the
  // API refuses JSON mode and grounding together; the parser digs the JSON out).
  ok('⚠️ Google Search grounding on the call, and v2\'s config exactly (temperature 1, topP 0.95, 32768 — no JSON mime, no schema)',
    JSON.stringify(toolsOf(ai.calls[0])) === JSON.stringify([{ googleSearch: {} }])
    && JSON.stringify(ai.calls[0].cfg.generationConfig) === JSON.stringify(LETTER_CFG) && JSON.stringify(LETTER_CFG) === JSON.stringify({ temperature: 1, topP: 0.95, maxOutputTokens: 32768 }),
    { tools: toolsOf(ai.calls[0]), cfg: ai.calls[0].cfg.generationConfig });
  // RETARGETED 2026-09-18 (the letter chain): a healthy Google answers from the letter chain's HEAD, gemini-2.5-flash.
  ok('…written by the letter chain\'s primary (gemini-2.5-flash), with no thinkingConfig',
    ai.calls[0].cfg.model === P && P === 'gemini-2.5-flash' && !('thinkingConfig' in ai.calls[0].cfg.generationConfig), { model: ai.calls[0].cfg.model });
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
  ok('open application: position from the résumé title; the subject is v2\'s own', pl.position === 'Senior Backend Engineer' && pl.subject === 'Application for Senior Backend Engineer — Jane Doe', { position: pl.position, subject: pl.subject });
  // ⚠️ RETARGETED TWICE 2026-09-18: the offices are the Jobs lane's mapping now — but only the ones v2 RESEARCHED. v2
  // found none here, and this used to assert companyAddress 'United States': the Jobs picker's stand-in row (the chip's
  // country, a default the user can change there) stored as Home's address block, where nobody can. HEAD's Home stored ''.
  ok('⚠️ no researched office → no address at all: neither the chip\'s country (the Jobs picker\'s stand-in) nor "Address not available"; hiring manager default',
    pl.companyAddress === '' && pl.locations.length === 0
    && !JSON.stringify(pl).includes('Address not available') && pl.hiringManager === 'Hiring Manager', pl);
  ok('…and the rendered letter\'s address block is empty, not "United States"',
    rendered.previews.length === 1 && rendered.previews[0].data.company.address === '' && rendered.previews[0].data.company.name === 'Acme', rendered.previews[0] && rendered.previews[0].data.company);
  ok('brandColor/fontName from research', pl.brandColor === '#1a73e8' && pl.fontName === 'Inter', pl);
  ok('model column ≤ 48, and it names the model that wrote it', String(put.model).length <= 48 && put.model === P, put.model);
  const st = stages.map((s) => s.stage);
  ok('stages in order', JSON.stringify(st) === JSON.stringify(['reading', 'researching', 'writing', 'designing', 'saving', 'pages']), st);
  ok('stage labels per contract', stages.find((s) => s.stage === 'writing').label === 'Writing your Acme cover letter' && stages.find((s) => s.stage === 'researching').label === 'Researching Acme' && stages.find((s) => s.stage === 'designing').label === 'Ranking letter designs', stages);
  ok('stage pcts monotonic', stages.every((s, i, a) => i === 0 || a[i - 1].pct <= s.pct), stages.map((s) => s.pct));
  ok('thumbs pre-rendered for the top 2 designs in one batch', rendered.previews.length === 1 && rendered.previews[0].ids.length === 2 && rendered.previews[0].ids[0] === put.design.ranked[0].id, rendered.previews.map((p) => p.ids));
  // The stub's page bytes are not an image sharp can read, so no card is cut: the PAGE is stored (and served as the card).
  const thumbFiles = fsSync.readdirSync(path.join(THUMBS, '7')).filter((n) => n.startsWith('cl_'));
  ok('thumb files written under <root>/<userId>/cl_*.jpg', thumbFiles.length === 2 && thumbFiles.every((n) => /^cl_[0-9a-f]{64}\.jpg$/.test(n)), thumbFiles);
  // ⚠️ REVERSED BY DESIGN 2026-09-18: these pinned the Home lane's OWN prompt (a research block, "no job posting was
  // given", the upload minus its bookkeeping). The prompt is v2's now, built from the Jobs lane's inputs in their shapes.
  const prompt1 = textOf(ai.calls[0]);
  const META1 = { ...world.meta, builder_resume: world.resumeRow.resume_data };   // the Jobs loader: the upload row + the Builder résumé
  ok('⚠️ the prompt IS ai-cover-letter-v2\'s buildPrompt for these inputs, byte for byte (the Jobs lane\'s metadata, the résumé title, the website, the chip\'s country as the job location)',
    prompt1 === realBuildPrompt(META1, 'Senior Backend Engineer', 'https://acme.test', null, 'United States', null) && prompt1.length > 5000, prompt1.slice(0, 200));
  ok('…built ONCE, through v2\'s buildPrompt itself (the spy saw it), with those arguments',
    v2Calls.length === 1 && JSON.stringify(v2Calls[0]) === JSON.stringify([META1, 'Senior Backend Engineer', 'https://acme.test', null, 'United States', null]), v2Calls.map((a) => a.slice(1)));
  ok('⚠️ …and none of the Home lane\'s old prompt is in it (no research block, no "no job posting was given", no JSON schema talk)',
    !/=== WHAT WE KNOW ABOUT/.test(prompt1) && !/no job posting was given/.test(prompt1) && !/=== ABSOLUTE RULES ===/.test(prompt1) && /Google Search/.test(prompt1));

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

  console.log('── build: the Jobs lane\'s parsing and mapping — no clean-up pass of the lane\'s own ──');
  // ⚠️ REPLACED 2026-09-18: the placeholder guard (one corrective pass that re-sent the OLD prompt, then a strip) and the
  // salutation / sign-off strip answered the old prompt's failure modes. Both screens share the Jobs lane's parsing now:
  // the stored letter is exactly what the Jobs lane hands over for the same answer — one call, never a second pass.
  reset();
  const DRAFT = [PARA(1), 'Improved settlement speed by 40% for merchants across regions over two years of steady work on the platform and its tooling.', PARA(3), PARA(4)].join('\n\n');
  ai.queue = [GOOD({ cover_letter: DRAFT, subject: undefined })];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'Staff Engineer' } }));
  const plJ = (store.puts[0] || { payload: {} }).payload;
  ok('ONE call, stored, charged once — no corrective pass', r.statusCode === 200 && ai.calls.length === 1 && store.puts.length === 1 && ent.consumed.length === 1, { status: r.statusCode, calls: ai.calls.length });
  ok('⚠️ the stored HTML is EXACTLY the Jobs lane\'s conversion of the same answer (formatCoverLetterWithHTML, unescaped, as there)',
    plJ.coverLetterHtml === CL.formatCoverLetterWithHTML(DRAFT, {}) && plJ.coverLetterHtml === CL.letterDetailsOf(JSON.parse(GOOD({ cover_letter: DRAFT })), { position: 'Staff Engineer' }).coverLetterHtml, plJ.coverLetterHtml && plJ.coverLetterHtml.slice(0, 160));
  ok('posting title used exactly; no subject from the model → the Jobs lane\'s own "Application for <position>"',
    plJ.position === 'Staff Engineer' && plJ.subject === 'Application for Staff Engineer', { position: plJ.position, subject: plJ.subject });
  ok('…and the prompt carried that title as v2\'s Target Position', v2Calls.length === 1 && v2Calls[0][1] === 'Staff Engineer', v2Calls.map((a) => a[1]));

  console.log('── build: AI failures charge nothing ──');
  // Every "which model" scenario below needs a real three-model chain: with a repeated or missing id, "the primary
  // twice, then the first fallback" would not describe a fallback at all.
  // RETARGETED 2026-09-18 (the measured letter backups): the two fallbacks are letterFallbacks()'s, not aiText's.
  ok('the letter chain the lane walks has three distinct models (P, F1, F2): gemini-2.5-flash, then the measured letter fallbacks',
    [P, F1, F2].every((m) => typeof m === 'string' && m) && new Set([P, F1, F2]).size === 3 && CL._internals.letterFallbacks().length === 2 && P === LETTER_CHAIN_PINNED[0], [P, F1, F2]);
  // ⚠️ THE ONE LITERAL PIN (see LETTER_CHAIN_PINNED): a busy 2.5-flash hands the letter to 3.1-flash-lite (3/3 usable on v2's
  // grounded prompt), and 2.5-flash-lite (2 of 3 broken) is the last resort. Swapping the two backups fails HERE.
  ok('⚠️ the letter chain\'s order, pinned: gemini-2.5-flash → gemini-3.1-flash-lite → gemini-2.5-flash-lite (LETTER_FALLBACKS, frozen)',
    JSON.stringify([P, F1, F2]) === JSON.stringify(LETTER_CHAIN_PINNED)
    && JSON.stringify([CL._internals.LEGACY_LETTER_MODEL, ...CL._internals.LETTER_FALLBACKS]) === JSON.stringify(LETTER_CHAIN_PINNED)
    && Object.isFrozen(CL._internals.LETTER_FALLBACKS), { chain: [P, F1, F2], LETTER_FALLBACKS: CL._internals.LETTER_FALLBACKS });
  {
    // letterFallbacks() is read at CALL time and is always a FRESH array: no caller can reorder or empty the measured
    // backups for every later letter. And the operator's AI_TEXT_FALLBACK_MODELS still wins, exactly as it did through
    // aiText.fallbackModels() — a list replaces the backups, "none" / "off" removes them; unset or blank is the measured pair.
    const LF = CL._internals.letterFallbacks;
    const a = LF(), b = LF();
    let mutated = true;
    try { a.reverse(); a.push('gemini-mutated'); a.length = 0; } catch (_) { mutated = false; }
    ok('⚠️ letterFallbacks() returns a FRESH, writable array each call — never LETTER_FALLBACKS itself — and editing one changes nothing',
      mutated && a !== b && a !== CL._internals.LETTER_FALLBACKS && b !== CL._internals.LETTER_FALLBACKS && a.length === 0
      && JSON.stringify(LF()) === JSON.stringify(LETTER_CHAIN_PINNED.slice(1)) && JSON.stringify([...CL._internals.LETTER_FALLBACKS]) === JSON.stringify(LETTER_CHAIN_PINNED.slice(1)),
      { mutated, after: LF() });
    const envWas = process.env.AI_TEXT_FALLBACK_MODELS;
    try {
      process.env.AI_TEXT_FALLBACK_MODELS = ' Models/Gemini-Op-One , gemini-op-two,gemini-op-one ';
      const op = LF();
      ok('⚠️ AI_TEXT_FALLBACK_MODELS as a list → the OPERATOR\'s list wins (aiText.fallbackModels()\'s own reading: trimmed, lower-cased, "models/" off, deduped)',
        JSON.stringify(op) === JSON.stringify(['gemini-op-one', 'gemini-op-two']) && JSON.stringify(op) === JSON.stringify(AT.fallbackModels()), op);
      const op2 = LF(); op2.push('x');
      ok('…and that list is a fresh array too', LF().length === 2 && op !== LF(), LF());
      process.env.AI_TEXT_FALLBACK_MODELS = 'none';
      const none = LF();
      process.env.AI_TEXT_FALLBACK_MODELS = ' OFF ';
      const off = LF();
      ok('⚠️ AI_TEXT_FALLBACK_MODELS=none (or off) → NO letter fallbacks: the operator\'s "primary only" switch still works for letters',
        Array.isArray(none) && none.length === 0 && Array.isArray(off) && off.length === 0, { none, off });
      process.env.AI_TEXT_FALLBACK_MODELS = '   ';
      const blank = LF();
      delete process.env.AI_TEXT_FALLBACK_MODELS;
      const unset = LF();
      ok('…while unset or blank is the MEASURED pair — never aiText\'s generic default order',
        JSON.stringify(blank) === JSON.stringify(LETTER_CHAIN_PINNED.slice(1)) && JSON.stringify(unset) === JSON.stringify(LETTER_CHAIN_PINNED.slice(1)), { blank, unset });
      // ⚠️ A value that names NOTHING usable ("???", a stray comma) is not an operator's list. Handed to fallbackModels() it
      // fell back to aiText's DEFAULT order — 2.5-flash-lite first, the order measured to break grounded letters.
      process.env.AI_TEXT_FALLBACK_MODELS = '???, ,!!';
      const junk = LF();
      delete process.env.AI_TEXT_FALLBACK_MODELS;
      ok('⚠️ an all-junk AI_TEXT_FALLBACK_MODELS is the MEASURED pair too — never aiText\'s default (2.5-flash-lite first)',
        JSON.stringify(junk) === JSON.stringify(LETTER_CHAIN_PINNED.slice(1)) && junk[0] !== 'gemini-2.5-flash-lite', junk);
    } finally {
      if (envWas === undefined) delete process.env.AI_TEXT_FALLBACK_MODELS; else process.env.AI_TEXT_FALLBACK_MODELS = envWas;
    }
    // Job Hub's per-job letter is its OWN prompt (plain text, no grounding) and was never measured on the letter backups:
    // it stays on [GEMINI_FLASH_MODEL, ...aiText.fallbackModels()]. Comment-stripped source, the job_hub_letter call only.
    const stripH = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const hub = stripH(fsSync.readFileSync(path.join(ROOT, 'server/controllers/aiHubController.js'), 'utf8'));
    const hubCall = (hub.match(/aiText\.generateText\(\{\s*lane: 'job_hub_letter',[\s\S]*?\}\);/) || [''])[0];
    ok('⚠️ the Job Hub letter is untouched: still [GEMINI_FLASH_MODEL, ...aiText.fallbackModels()], never letterFallbacks() / LETTER_FALLBACKS',
      hubCall.length > 0 && /models: \[GEMINI_FLASH_MODEL, \.\.\.aiText\.fallbackModels\(\)\],/.test(hubCall)
      && !/letterFallbacks|LETTER_FALLBACKS/.test(hub), hubCall || 'no job_hub_letter generateText call found');
  }
  // RETARGETED 2026-09-18 (the Jobs writer): an unusable answer is the WRITER's retry now — v2's parsing, up to three
  // answers (it was the Home lane's own two-draft loop). Three unusable answers end as its "could not finish": 500.
  reset(); ai.queue = ['not json', '{"to":"HR","cover_letter":"   "}', 'Sorry, I cannot help with that.'];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'QA Lead' } }));
  ok('three unusable answers → 500 failed', r.statusCode === 500 && r.body.reason === 'failed', r.body);
  ok('⚠️ no consume, no put', ent.consumed.length === 0 && store.puts.length === 0);
  // Output the WRITER rejects is its own retry — never a provider failure. Each answer is asked of the same primary; the
  // fallback chain is for a BUSY model and is never walked for bad output.
  ok('⚠️ …every answer asked of the primary: bad output is not an overload, so no fallback is walked for it',
    ai.calls.length === 3 && ai.calls.every((c) => c.cfg.model === P), ai.calls.map((c) => c.cfg.model));
  // ⚠️ RETARGETED 2026-09-18 (was "two timeouts → 504"): a timeout is a hung model, and a hung model is exactly what the
  // fallback chain is for. The primary is tried twice, with a pause, and then the next model writes the letter.
  reset(); ai.queue = [new Error('AI_TIMEOUT'), new Error('AI_TIMEOUT')];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'QA Lead' } }));
  ok('two timeouts on the primary → the first fallback writes it: 200, charged once, the fallback stored as its writer',
    r.statusCode === 200 && ai.calls.map((c) => c.cfg.model).join() === [P, P, F1].join() && ent.consumed.length === 1 && store.puts.length === 1 && store.puts[0].model === F1,
    { status: r.statusCode, models: ai.calls.map((c) => c.cfg.model), model: store.puts[0] && store.puts[0].model });

  console.log('── ⚠️ 2026-09-18: GOOGLE BUSY (Amazon\'s letter: two 503s, 0 ms apart, "That cover letter didn\'t finish") ──');
  {
    // Production, user 1, Home → Cover letters → Amazon: gemini-2.5-flash answered 503 "high demand" twice, back to back,
    // and the letter died. The letter is written through aiText — a pause, the primary once more, then the rest of the
    // LETTER chain (P = gemini-2.5-flash, then F1, then F2) — all inside ONE AI window, all before the charge. A fallback's
    // letter is stored as ITS letter, under the same fingerprint (a later identical request is a free hit); when no model
    // can answer, nothing is charged or stored, the answer is an honest 503 ai_busy / ai_down, and any build waiting on
    // this one is released. (Since the owner's decision the writer is the Jobs section's — the rules did not move.)
    const LA = EL.LETTER_AI || {};   // the lane's AI window (its absence is a failure below, not a crash here)
    const modelsOf = () => ai.calls.map((c) => c.cfg.model);
    const cfgOf = (c) => JSON.stringify(c.cfg.generationConfig || {});
    const runsSince = (mark) => world.sql.slice(mark).filter((q) => /^RUN /.test(q));
    const labelsOf = (stage) => stages.filter((s) => s.stage === stage).map((s) => s.label);
    const gt = [];   // every generateText call the lane makes, exactly as it made it
    const realGT = AT.generateText;
    AT.generateText = (o) => { gt.push(o); return realGT(o); };
    const STORM_JOB = { company: 'Amazon', title: 'Storm Role', url: '', description: '', website: 'amazon.test' };
    const storm = (title) => buildBody({ employer: 'Amazon', job: { ...STORM_JOB, title } });
    // "Every model busy" scripts EVERY model of the LETTER chain — and only those: a model outside it (aiText's generic
    // fallbacks, say) would answer, and the 503 below would turn into a letter the lane should never have asked for.
    const LETTER_CHAIN = () => [CL.LEGACY_LETTER_MODEL, ...CL._internals.letterFallbacks()];
    const onLetterChain = (mk) => (cfg) => (LETTER_CHAIN().includes(cfg.model) ? mk(cfg.model) : null);

    // 1. the incident, replayed: the primary answers exactly what production logged, every time it is asked. The FIRST
    // fallback that writes it is the letter chain's F1 — gemini-3.1-flash-lite since the measured backups (it was
    // gemini-2.5-flash-lite through aiText.fallbackModels()).
    reset(); gt.length = 0; ai.fail = (cfg) => (cfg.model === P ? INCIDENT_503(P) : null);
    r = await call(EL.buildEmployerLetter, 7, storm('Storm Role'), { __jobId: 'job-storm' });
    const putS = store.puts[0] || {};
    const stormDocId = r.body && r.body.docId;
    ok('⚠️ a 503 storm on the primary still writes the letter: 200, a docId', r.statusCode === 200 && r.body.success === true && r.body.cached === false && Number.isInteger(stormDocId), r.body);
    ok('…the primary twice, then the first fallback — three calls, and never a second chain on top', modelsOf().join() === [P, P, F1].join(), modelsOf());
    ok('⚠️ …with a PAUSE before the primary\'s second try (the incident\'s two 503s were 0 ms apart)',
      ai.calls.length >= 2 && ai.calls[1].t - ai.calls[0].t >= 20, ai.calls.map((c) => c.t - ai.calls[0].t));
    // ⚠️ REWRITTEN BACK 2026-09-18 (the letter chain): the fallback is asked EXACTLY as the primary was — v2's config, the
    // same grounded prompt — and no call carries a thinkingConfig (that per-model switch belonged to the writing chain).
    ok('…the fallback asked exactly as the primary was: v2\'s config (1, 0.95, 32768), the same grounded prompt, NO thinkingConfig on any call',
      ai.calls.length === 3 && ai.calls.every((c) => cfgOf(c) === JSON.stringify(LETTER_CFG) && !('thinkingConfig' in c.cfg.generationConfig)
        && textOf(c) === textOf(ai.calls[0]) && JSON.stringify(toolsOf(c)) === JSON.stringify([{ googleSearch: {} }])),
      ai.calls.map((c) => ({ model: c.cfg.model, cfg: c.cfg.generationConfig })));
    ok('…every attempt carries an abort signal: a hung model is CANCELLED at its cap, not merely stopped waiting for',
      ai.calls.every((c) => c.opts && c.opts.signal && typeof c.opts.signal.aborted === 'boolean'));
    ok('⚠️ charged EXACTLY once, stored once', ent.consumed.length === 1 && store.puts.length === 1, { consumed: ent.consumed.length, puts: store.puts.length });
    ok('⚠️ the stored letter records the model that WROTE it (the fallback), not the lane\'s first choice', putS.model === F1, putS.model);
    // ⚠️ RETARGETED BACK 2026-09-18: "faster" is TRUE again — the flash-lites follow gemini-2.5-flash on this chain.
    ok('the user is told in plain words: "busy — trying again", then "switching to a faster model"',
      JSON.stringify(labelsOf('retry')) === JSON.stringify(["Google's AI is busy — trying again", 'Switching to a faster model']), stages);
    // ⚠️ REWRITTEN 2026-09-18 (three times in a day): the lane's ONE aiText call is the Jobs writer's — lane letter_legacy,
    // the letter chain [LEGACY_LETTER_MODEL, ...letterFallbacks()] (the measured backups, no longer aiText's
    // fallbackModels()), v2's config, NO modelConfig, the grounding tool — and its budget is what was LEFT of the build's AI
    // window (never the writer's own four minutes on top of it).
    ok('the lane asks through aiText ONCE, as the Jobs writer ("letter_legacy"), on [LEGACY_LETTER_MODEL, ...letterFallbacks()] with NO modelConfig, grounded, inside its AI window',
      gt.length === 1 && gt[0].lane === 'letter_legacy'
      && JSON.stringify(gt[0].models) === JSON.stringify([CL.LEGACY_LETTER_MODEL, ...CL._internals.letterFallbacks()]) && JSON.stringify(gt[0].models) === JSON.stringify([P, F1, F2])
      && !('modelConfig' in gt[0]) && JSON.stringify(gt[0].config) === JSON.stringify(LETTER_CFG)
      && JSON.stringify(gt[0].prompt && gt[0].prompt.tools) === JSON.stringify([{ googleSearch: {} }])
      && gt[0].budgetMs > 0 && gt[0].budgetMs <= LA.windowMs && typeof gt[0].onRetry === 'function',
      gt.map((g) => ({ lane: g.lane, models: g.models, modelConfig: g.modelConfig, budgetMs: g.budgetMs })));
    ok('…and never aiText.writing()\'s chain (measured for the résumés, never for a grounded letter)',
      gt.length === 1 && JSON.stringify(gt[0].models) !== JSON.stringify(AT.writingChain()), gt.map((g) => g.models));

    // 2. ⚠️ THE MONEY LINE: who wrote a letter is not an input. The fallback's letter carries the fingerprint the gate, the
    // build and the stale label compute, so the next identical request is FREE — exactly as a primary-written one is.
    ok('⚠️ the fallback-written letter\'s fingerprint is the one the gate and the stale label compute',
      !!putS.fingerprint && putS.fingerprint === await EL.currentLetterFingerprint(7, { job: STORM_JOB, env: mkReq(7, {}) }), putS.fingerprint);
    reset(); gt.length = 0;   // Google is healthy again
    r = await call(EL.buildEmployerLetter, 7, storm('Storm Role'));
    ok('⚠️ the same request again is a FREE cache hit on the fallback\'s letter: no AI, no gate, no charge, no new row',
      r.statusCode === 200 && r.body.cached === true && r.body.docId === stormDocId && ai.calls.length === 0 && gt.length === 0
      && ent.gateCalls === 0 && ent.consumed.length === 0 && store.puts.length === 0 && v2Calls.length === 0, r.body);
    r = await call(EL.employerLetterGate, 7, { employer: 'Amazon', job: { ...STORM_JOB } });
    ok('…and the confirm-sheet gate calls it a saved letter too (via cache)', r.body.covered === true && r.body.via === 'cache', r.body);
    reset();
    r = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Storm Primary Co', job: { ...STORM_JOB, company: 'Storm Primary Co' } }));
    const putP = store.puts[0] || {};
    ok('⚠️ the same inputs written by the PRIMARY hash to the SAME fingerprint as the fallback\'s letter',
      r.statusCode === 200 && putP.model === P && putP.fingerprint === putS.fingerprint, { status: r.statusCode, model: putP.model, same: putP.fingerprint === putS.fingerprint });

    // 3. every model busy: NOTHING charged, NOTHING stored — and an answer that says so
    reset(); gt.length = 0; ai.fail = onLetterChain(E503);
    const sqlBusy = world.sql.length;
    r = await call(EL.buildEmployerLetter, 7, storm('Storm Role B'), { __jobId: 'job-busy' });
    ok('⚠️ every model busy → 503 ai_busy, retryable', r.statusCode === 503 && r.body.success === false && r.body.reason === 'ai_busy' && r.body.retryable === true, r.body);
    ok('…in a sentence that names the cover letter and says NOTHING was charged — the Jobs lane\'s own words, letter for letter',
      /cover letter/.test(r.body.error || '') && /Nothing was charged/.test(r.body.error || '')
      && r.body.error === "Google's AI is overloaded right now, so your cover letter could not be written. Nothing was charged — please try again in a minute.", r.body.error);
    ok('…after the chain ran ONCE: the primary twice, then each fallback — four calls, never a second chain from the lane',
      modelsOf().join() === [P, P, F1, F2].join() && gt.length === 1, { models: modelsOf(), chains: gt.length });
    ok('…every model of the LETTER chain was asked (the measured backups included), and no model outside it',
      LETTER_CHAIN().every((m) => modelsOf().includes(m)) && modelsOf().every((m) => LETTER_CHAIN().includes(m)), { asked: modelsOf(), chain: LETTER_CHAIN() });
    ok('⚠️ …every one of the four asked with v2\'s config exactly, NO thinkingConfig',
      ai.calls.length === 4 && ai.calls.every((c) => cfgOf(c) === JSON.stringify(LETTER_CFG)), ai.calls.map((c) => ({ model: c.cfg.model, cfg: c.cfg.generationConfig })));
    ok('⚠️ NOTHING consumed, stored, claimed, refunded or written',
      ent.consumed.length === 0 && store.puts.length === 0 && passSpy.claimCalls.length === 0 && (world.refunds || []).length === 0 && runsSince(sqlBusy).length === 0,
      { consumed: ent.consumed.length, puts: store.puts.length, runs: runsSince(sqlBusy) });
    ok('…and it never reached the payment stages', !stages.some((s) => ['designing', 'saving', 'pages'].includes(s.stage)), stages.map((s) => s.stage));
    reset(); ai.fail = onLetterChain(() => new Error('AI_TIMEOUT'));
    r = await call(EL.buildEmployerLetter, 7, storm('Storm Role F'));
    ok('every model hung (timed out) is the same overload → 503 ai_busy, no longer a 504', r.statusCode === 503 && r.body.reason === 'ai_busy' && !r.body.isTimeout
      && modelsOf().join() === [P, P, F1, F2].join() && ent.consumed.length === 0 && store.puts.length === 0, { status: r.statusCode, body: r.body, models: modelsOf() });

    // 4. ⚠️ THE WAITERS. A second identical build that joined the first is RELEASED when the first ends ai_busy (the
    // finally), then runs its own gates and its own chain and gets its own honest answer. Nobody waits on a build that
    // will never land; the calls come in two whole chains, one after the other, because the second WAITED.
    reset(); ai.fail = onLetterChain(E503);
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

    // 4b. ⚠️ THE OPERATOR'S SWITCH, end to end through the lane (2026-09-18, the measured letter backups): the letter's
    // backups are the controller's own now, but AI_TEXT_FALLBACK_MODELS still wins over them — "none" is "primary only",
    // a list replaces them. Read at call time, so no restart and no code change.
    {
      const envWas = process.env.AI_TEXT_FALLBACK_MODELS;
      try {
        process.env.AI_TEXT_FALLBACK_MODELS = 'none';
        reset(); gt.length = 0; ai.fail = onLetterChain(E503);
        r = await call(EL.buildEmployerLetter, 7, storm('Storm Role N'));
        ok('⚠️ AI_TEXT_FALLBACK_MODELS=none → the letter walks the primary ALONE: tried twice, then 503 ai_busy — no fallback asked, nothing charged or stored',
          r.statusCode === 503 && r.body.reason === 'ai_busy' && modelsOf().join() === [P, P].join()
          && gt.length === 1 && JSON.stringify(gt[0].models) === JSON.stringify([P]) && ent.consumed.length === 0 && store.puts.length === 0,
          { status: r.statusCode, body: r.body, models: modelsOf(), chain: gt.map((g) => g.models) });
        process.env.AI_TEXT_FALLBACK_MODELS = 'gemini-op-backup';
        reset(); gt.length = 0; ai.fail = (cfg) => (cfg.model === P ? E503(P) : null);
        r = await call(EL.buildEmployerLetter, 7, storm('Storm Role O'));
        ok('⚠️ AI_TEXT_FALLBACK_MODELS=<a list> → the OPERATOR\'s model writes the letter a busy primary could not: stored as its writer, charged once',
          r.statusCode === 200 && modelsOf().join() === [P, P, 'gemini-op-backup'].join() && JSON.stringify(gt[0].models) === JSON.stringify([P, 'gemini-op-backup'])
          && store.puts.length === 1 && store.puts[0].model === 'gemini-op-backup' && ent.consumed.length === 1,
          { status: r.statusCode, models: modelsOf(), chain: gt.map((g) => g.models), model: store.puts[0] && store.puts[0].model });
      } finally {
        if (envWas === undefined) delete process.env.AI_TEXT_FALLBACK_MODELS; else process.env.AI_TEXT_FALLBACK_MODELS = envWas;
      }
      ok('…and with the switch put back, the lane\'s chain is the measured letter chain again', JSON.stringify(LETTER_CHAIN()) === JSON.stringify(LETTER_CHAIN_PINNED), LETTER_CHAIN());
    }

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

    // 6. (the corrective pass that rode this chain is gone: it re-sent the Home lane's own prompt — see "the Jobs lane's
    // parsing" above.)

    // 7. bad output is the WRITER's retry: a second answer from the primary, told as a second pass — not as Google being busy
    reset(); ai.queue = ['not json'];
    r = await call(EL.buildEmployerLetter, 7, storm('Storm Role I'), { __jobId: 'job-bad' });
    ok('bad output → the writer asks again, of the primary (200, two calls, both the primary)',
      r.statusCode === 200 && modelsOf().join() === [P, P].join() && !!store.puts[0] && store.puts[0].model === P, modelsOf());
    ok('…reported as "Taking another pass at it", never as a busy provider', JSON.stringify(labelsOf('retry')) === JSON.stringify(['Taking another pass at it']), labelsOf('retry'));

    // 8. ⚠️ ONE AI WINDOW (LETTER_AI): the writer's budget is what is LEFT of it, and no answer is STARTED without room
    // to finish (the writer never starts one with less than 20 s left).
    const realWindow = { ...LA };
    try {
      LA.windowMs = 15 * 1000;   // less than the writer's least try: no answer may even start
      reset(); gt.length = 0;
      r = await call(EL.buildEmployerLetter, 7, storm('Storm Role J'));
      ok('⚠️ a window with no room for one answer → 500 failed after ZERO calls — never started, never an "AI is busy" the provider never said',
        r.statusCode === 500 && r.body.reason === 'failed' && ai.calls.length === 0 && gt.length === 0 && ent.consumed.length === 0 && store.puts.length === 0, { status: r.statusCode, body: r.body, calls: ai.calls.length });
      LA.windowMs = 30 * 1000;   // room for two answers, and not one more second of the writer's own four minutes
      reset(); gt.length = 0; ai.queue = ['not json'];
      r = await call(EL.buildEmployerLetter, 7, storm('Storm Role K'));
      ok('…with 30 s, each answer is given what is LEFT of the window, never a budget of its own',
        r.statusCode === 200 && gt.length === 2 && gt.every((g) => g.budgetMs > 0 && g.budgetMs <= 30 * 1000) && gt[1].budgetMs <= gt[0].budgetMs, gt.map((g) => g.budgetMs));
    } finally { Object.assign(LA, realWindow); }
    // 240 s of AI (the research runs beside it), + ≤ 15 s of lock + ≤ 20 s of thumbs, inside the app's 6 minutes.
    ok('the production window: 4 min for every AI call, the writer\'s own budget no longer than it, room for the lock and the thumbs inside the app\'s 6 minutes',
      LA.windowMs === 240000 && CL._internals.LEGACY_LETTER_BUDGET_MS === 240000 && Object.keys(LA).join() === 'windowMs'
      && LA.windowMs + 35 * 1000 < 6 * 60 * 1000, EL.LETTER_AI);

    // 9. ⚠️ THE MONEY CONSTANTS. A bump of any of them re-bills every saved document; neither a fallback model nor the
    // switch to the Jobs section's writer moves any of them.
    const elSrc = fsSync.readFileSync(path.join(ROOT, 'server/controllers/employerLetterController.js'), 'utf8');
    ok('⚠️ LETTER_REV stays letter-v1 through the fallback round and the writer switch', /const LETTER_REV = 'letter-v1';/.test(elSrc) && !/LETTER_REV = 'letter-v[2-9]'/.test(elSrc));
    ok('⚠️ RESEARCH_REV stays r1', research.RESEARCH_REV === 'r1', research.RESEARCH_REV);
    ok('⚠️ FP_VERSION stays v1 (the hash of a known input is exactly what it was)',
      docs.fingerprint({ baseText: 'a', jobText: 'b', researchRev: 'c' }) === crypto.createHash('sha256').update(['v1', 'a', 'b', 'c'].join('\0')).digest('hex'));
    ok('⚠️ no model id — and no prompt text — anywhere in the letter\'s fingerprint', (() => { const b = (elSrc.match(/function letterFingerprintOf\([\s\S]*?\n\}/) || [''])[0]; return b.length > 50 && !/model|prompt|buildPrompt|v2/i.test(b); })());
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

  console.log('── build: the tailored resume is not an input any more; job boards never researched ──');
  // ⚠️ RETARGETED 2026-09-18: the Home lane used to hand its OWN prompt this employer's tailored resume (when current).
  // v2's prompt takes the Jobs lane's résumé metadata and nothing else, so the tailored resume is not read at all — not
  // even its fingerprint (the resume lane's currentResumeFingerprint is never asked).
  reset(); resumeDocs.doc = { input_fingerprint: 'fp-same', payload: { personal_info: { title: 'Tailored Title', email: 'secret@x.test' }, summary: 'TAILORED SUMMARY MARK', experience: [] } }; rbFp.value = 'fp-same';
  const rbCalls0 = rbFp.calls;
  r = await call(EL.buildEmployerLetter, 7, buildBody({ job: { ...JOB, title: 'Engineer B' } }));
  ok('a current tailored resume is NOT in the prompt, and its fingerprint is never even asked for',
    r.statusCode === 200 && !/TAILORED SUMMARY MARK|secret@x\.test/.test(textOf(ai.calls[0])) && rbFp.calls === rbCalls0, { status: r.statusCode, rb: rbFp.calls - rbCalls0 });
  reset();
  r = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Zeta', job: { company: 'Zeta', title: 'Engineer', website: 'https://www.linkedin.com/company/zeta', url: 'https://boards.greenhouse.io/zeta/jobs/1' } }));
  ok('a job-board website is never researched', r.statusCode === 200 && researchCalls.length === 0, researchCalls);
  ok('…and the stage list skips researching', !stages.some((s) => s.stage === 'researching'));
  // No website of the employer's own → the letter researches the employer's NAME — what the Jobs lane researches when all
  // it has is a job board (letterResearchSubjectOf; v2 then asks for it as https://<name>, as it always has).
  ok('⚠️ …and the letter researches the employer\'s NAME, exactly as the Jobs lane does with a job board',
    v2Calls.length === 1 && v2Calls[0][2] === 'https://Zeta' && /Employer Website URL: https:\/\/Zeta\n/.test(textOf(ai.calls[0]))
    && CL.letterResearchSubjectOf('https://www.linkedin.com/company/zeta', 'Zeta').researchSubject === 'Zeta', v2Calls.map((a) => a[2]));
  ok('…with the pasted posting as v2\'s listing (the Jobs lane\'s shape: url, text, title, company)',
    v2Calls.length === 1 && JSON.stringify(v2Calls[0][5]) === JSON.stringify({ url: 'https://boards.greenhouse.io/zeta/jobs/1', text: '', title: 'Engineer', company: 'Zeta' }), v2Calls[0] && v2Calls[0][5]);
  reset();
  r = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Amazon', job: { company: 'Amazon', title: 'SDE', website: '', url: 'https://amazon.jobs/en/jobs/123' } }));
  ok('a posting host the employer owns is researched (amazon.jobs)', researchCalls.length === 1 && researchCalls[0].website === 'amazon.jobs', researchCalls);
  ok('…and it is the site the letter researches too', v2Calls.length === 1 && v2Calls[0][2] === 'https://amazon.jobs', v2Calls.map((a) => a[2]));

  console.log('── build: the addressee and the offices — the Jobs lane\'s mapping ──');
  // ⚠️ RETARGETED 2026-09-18: the Home lane kept a named contact or an address only when the posting or the cached research
  // spelled it — its prompt had no live search, so anything else was invented. v2 researches the employer through Google
  // Search grounding (the addresses are the prompt's REQUIRED research), so the answer is mapped the way the Jobs lane maps
  // it: the model's addressee, and its offices HQ first — the job location's own office moved to the front.
  reset(); ai.queue = [GOOD({ to: 'Maria Lopez', addresses: ['1 Main Street, 62701 Springfield, USA', 'Hauptstraße 12, 45128 Essen, Germany'] })];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ country: 'Germany', job: { ...JOB, title: 'Engineer C' } }));
  const plC = (store.puts[0] || { payload: {} }).payload;
  ok('the researched addressee is kept (what the Jobs lane prints)', plC.hiringManager === 'Maria Lopez', plC.hiringManager);
  ok('⚠️ the office in the job\'s country leads (matchesJobLocation), the HQ after it — the Jobs lane\'s order',
    plC.companyAddress === 'Hauptstraße 12, 45128 Essen, Germany' && plC.locations.length === 2 && plC.locations[0].matchesJobLocation === true
    && plC.locations[1].address === '1 Main Street, 62701 Springfield, USA', plC.locations);
  const jobsMap = CL.letterDetailsOf(JSON.parse(GOOD({ to: 'Maria Lopez', addresses: ['1 Main Street, 62701 Springfield, USA', 'Hauptstraße 12, 45128 Essen, Germany'] })),
    { position: 'Engineer C', companyNameHint: 'Acme', researchSubject: 'https://acme.test', jobLocation: 'Germany' });
  ok('…exactly the Jobs lane\'s own answer for the same model output (addressee, subject, offices, HTML)',
    JSON.stringify(plC.locations) === JSON.stringify(jobsMap.locations) && plC.hiringManager === jobsMap.hiringManager && plC.subject === jobsMap.subject && plC.coverLetterHtml === jobsMap.coverLetterHtml, { home: plC.locations, jobs: jobsMap.locations });
  // ⚠️ The review's case: v2 returns addresses VERBATIM (its prompt: never translated), so a German office ends in
  // "Deutschland" — which the chip's "Germany" never matches. letterDetailsOf then puts the job location ITSELF first (the
  // Jobs picker's default, a row the user sees and can change); Home has no picker and stored it as the address block:
  // "Germany", instead of the Munich street address the research found. Home keeps only the offices v2 returned.
  const MUC = 'Werner-von-Siemens-Straße 1, 80333 München, Deutschland';
  reset(); ai.queue = [GOOD({ addresses: [MUC] })];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Siemens', country: 'Germany', job: { company: 'Siemens', title: 'Engineer M', website: 'siemens.test' } }));
  const plM = (store.puts[0] || { payload: {} }).payload;
  ok('⚠️ an office spelled "Deutschland" under the chip "Germany" → the researched street address, never the country alone',
    r.statusCode === 200 && plM.companyAddress === MUC && plM.locations.length === 1 && plM.locations[0].address === MUC
    && !plM.locations.some((l) => l.address === 'Germany'), plM.locations);
  ok('…and it is the address block the letter is rendered with',
    rendered.previews.length === 1 && rendered.previews[0].data.company.address === MUC, rendered.previews[0] && rendered.previews[0].data.company);
  const jobsMuc = CL.letterDetailsOf(JSON.parse(GOOD({ addresses: [MUC] })), { position: 'Engineer M', companyNameHint: 'Siemens', researchSubject: 'https://siemens.test', jobLocation: 'Germany' });
  ok('…while the Jobs mapping is untouched: its picker still leads with the job location, the researched office after it',
    jobsMuc.locations.length === 2 && jobsMuc.locations[0].address === 'Germany' && jobsMuc.locations[0].matchesJobLocation === true
    && jobsMuc.locations[1].address === MUC, jobsMuc.locations);
  // "Schweiz", "USA": none names the chip's country either → the first researched office (v2's HQ), in the Jobs order.
  reset(); ai.queue = [GOOD({ addresses: ['Bahnhofstrasse 1, 8001 Zürich, Schweiz', '1 Main St, Austin, TX 78701, USA'] })];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Helvet', country: 'Germany', job: { company: 'Helvet', title: 'Engineer H', website: 'helvet.test' } }));
  const plH = (store.puts[0] || { payload: {} }).payload;
  ok('no researched office in the chip\'s country → the first researched office (the HQ), and only researched offices stored',
    plH.companyAddress === 'Bahnhofstrasse 1, 8001 Zürich, Schweiz' && JSON.stringify(plH.locations.map((l) => l.address)) === JSON.stringify(['Bahnhofstrasse 1, 8001 Zürich, Schweiz', '1 Main St, Austin, TX 78701, USA']), plH.locations);
  reset(); ai.queue = [GOOD({ addresses: [] })];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Nullco', country: 'Germany', job: { company: 'Nullco', title: 'Engineer N', website: 'nullco.test' } }));
  const plN = (store.puts[0] || { payload: {} }).payload;
  ok('⚠️ no office found under a chip country → \'\' (HEAD\'s Home), never "Germany" and never "Address not available"',
    r.statusCode === 200 && plN.companyAddress === '' && plN.locations.length === 0 && rendered.previews.length === 1 && rendered.previews[0].data.company.address === '', { payload: plN, render: rendered.previews[0] && rendered.previews[0].data.company });
  reset(); ai.queue = [GOOD({ to: undefined, addresses: [] })];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ country: '', job: { ...JOB, title: 'Engineer D' } }));
  const plD = (store.puts[0] || { payload: {} }).payload;
  ok('no addressee → "Hiring Manager"; no office and no country → no address at all ("Address not available" is never a line on a letter)',
    plD.hiringManager === 'Hiring Manager' && plD.companyAddress === '' && plD.locations.length === 0, plD);
  reset(); ai.queue = [GOOD({ position: 'Backend Engineer (open application)' })];
  r = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Omega', job: { company: 'Omega', website: 'omega.test' } }));
  ok('the model\'s echo of the position never becomes the stored one (the lane decided it before the call)',
    store.puts[0].payload.position === 'Senior Backend Engineer' && v2Calls.length === 1 && v2Calls[0][1] === 'Senior Backend Engineer', store.puts[0].payload);
  ok('…and the employer the user picked stays the letter\'s companyName (the model\'s official name is in its words)',
    store.puts[0].payload.companyName === 'Omega', store.puts[0].payload.companyName);

  console.log('── ⚠️ the research ranks the DESIGNS — it writes no word of the letter any more ──');
  {
    reset();
    researchConv = { hqCountry: 'Germany', roleCountry: 'Germany', employerType: 'startup', sector: 'Fintech', atsVendor: 'Personio', tone: 'direct',
      cv: { photo: 'expected', length: 'two_pages', personalDetails: 'include', dateFormat: 'MM/YYYY', format: 'tabular', notes: ['Berlin startups read short, direct letters.'] }, sources: [] };
    r = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Conv GmbH', country: '', job: { ...JOB, company: 'Conv GmbH', website: 'conv.test' } }), { __jobId: 'job-conv' });
    const pc = textOf(ai.calls[0]);
    ok('200, ONE AI call, ONE consume, ONE research call', r.statusCode === 200 && ai.calls.length === 1 && ent.consumed.length === 1 && researchCalls.length === 1, { status: r.statusCode, ai: ai.calls.length, consumed: ent.consumed.length });
    // ⚠️ REVERSED BY DESIGN 2026-09-18: the conventions block, the startup's length band and the country's letter habits
    // were the Home lane's OWN prompt. v2's prompt is the Jobs lane's — none of that is in it; it researches live.
    ok('⚠️ the prompt carries NO conventions block, NO research block and NO register or length band of the lane\'s own',
      !/=== HOW Conv GmbH HIRES/.test(pc) && !/Personio/.test(pc) && !/230-320/.test(pc) && !/FOR THIS EMPLOYER:/.test(pc) && v2Calls.length === 1 && pc === realBuildPrompt(...v2Calls[0]), pc.slice(0, 120));
    const putC = store.puts[store.puts.length - 1] || {};
    ok('…while the conventions still RANK the designs: region from the research (Germany → dach) when the chip names no country', putC.design && putC.design.region === 'dach', putC.design && putC.design.region);
    ok('the stored letter design keeps conventionsSummary (≤120) and the aiFamilies key', putC.design && 'aiFamilies' in putC.design
      && typeof putC.design.conventionsSummary === 'string' && putC.design.conventionsSummary.length <= 120, putC.design && { ai: putC.design.aiFamilies, s: putC.design.conventionsSummary });
    ok('…and the research ran BESIDE the letter, not before it: both asked, the stages in their order', researchCalls.length === 1
      && JSON.stringify(stages.map((x) => x.stage).filter((x) => ['researching', 'writing'].includes(x))) === JSON.stringify(['researching', 'writing']), stages.map((x) => x.stage));
    researchConv = null;
  }

  console.log('── ⚠️ the chip\'s country is the letter\'s JOB LOCATION — never a fingerprint input, never a charge ──');
  {
    // ⚠️ RETARGETED 2026-09-18: the country used to reach the Home lane's own prompt as a register and a length band (the
    // country playbook). The Jobs lane's prompt takes a JOB LOCATION instead — which office leads the addresses, and the
    // closing's relocation line — so that is where the chip's country goes. It is still NOT hashed: a chip whose country
    // changes never makes a finished letter stale, and never bills a Refresh.
    reset();
    let rp = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Chateau SA', country: 'France', job: { ...JOB, company: 'Chateau SA', website: 'chateau.test', title: 'Backend Engineer' } }));
    const pFr = textOf(ai.calls[0]);
    const fpFr = (store.puts[0] || {}).fingerprint;
    ok('a French chip → 200, ONE AI call, ONE consume, ONE research call: the country costs nothing extra',
      rp.statusCode === 200 && ai.calls.length === 1 && ent.consumed.length === 1 && researchCalls.length === 1 && store.puts.length === 1,
      { status: rp.statusCode, ai: ai.calls.length, consumed: ent.consumed.length, research: researchCalls.length });
    ok('…France is v2\'s JOB LOCATION (its office first, the relocation line) — and no CV habit, register or band of the lane\'s own',
      /JOB LOCATION: France/.test(pFr) && v2Calls.length === 1 && v2Calls[0][4] === 'France' && !/=== HOW A COVER LETTER READS/.test(pFr) && !/^TONE: /m.test(pFr), v2Calls.map((a) => a[4]));
    reset();
    rp = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Chateau SA', country: 'Japan', job: { ...JOB, company: 'Chateau SA', website: 'chateau.test', title: 'Backend Engineer' } }));
    ok('⚠️ the same letter under a different country is the SAME free cache hit — no AI, no gate, no charge',
      rp.statusCode === 200 && rp.body.cached === true && ai.calls.length === 0 && ent.gateCalls === 0 && ent.consumed.length === 0 && store.puts.length === 0,
      { status: rp.statusCode, body: rp.body, ai: ai.calls.length });
    ok('…because the country was never a fingerprint input', (await EL.currentLetterFingerprint(7, { job: { company: 'Chateau SA', website: 'chateau.test', title: 'Backend Engineer' }, country: 'Japan', env: 'Production' })) === fpFr);
    reset();
    rp = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Nowhere Ltd', country: '', job: { ...JOB, company: 'Nowhere Ltd', website: 'nowhere.test', title: 'Backend Engineer' } }));
    ok('no country → no JOB LOCATION block at all (v2\'s prompt as the Jobs lane sends it without one)',
      rp.statusCode === 200 && v2Calls.length === 1 && v2Calls[0][4] === null && !/JOB LOCATION:/.test(textOf(ai.calls[0])), v2Calls.map((a) => a[4]));
    const elP = fsSync.readFileSync(path.join(ROOT, 'server/controllers/employerLetterController.js'), 'utf8');
    ok('⚠️ LETTER_REV stays letter-v1 (a bump re-bills every saved letter), and the lane reads no country playbook any more',
      /const LETTER_REV = 'letter-v1';/.test(elP) && !/LETTER_REV = 'letter-v[2-9]'/.test(elP) && !/cvPlaybook|playbookFor|playbookPromptBlock/.test(elP.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
  }

  console.log('── ⚠️ THE OWNER\'S DECISION: Home\'s letter is written by EXACTLY the Jobs section\'s generation ──');
  {
    // "we have a prompt/api that is already written on the jobs section… we need to use the same one… and not the new
    // one." The same job, written from Home (POST /cover-letter/employer-build) and from the Jobs section (POST
    // /generate-cover-letter-details): the SAME v2 buildPrompt call, the same bytes to Google, the same grounding, config
    // and chain — and the same model answer mapped into the same letter. If the two ever drift, this is where it shows.
    const gtP = [];
    const realGT = AT.generateText;
    AT.generateText = (o) => { gtP.push(o); return realGT(o); };
    const PJOB = { company: 'Nordwerk', title: 'Platform Engineer', url: 'https://nordwerk.test/jobs/7', description: 'Build the payments platform on Kafka and Postgres. Own services end to end.', website: 'nordwerk.test' };
    const ANSWER = GOOD({ employer_name: 'Nordwerk GmbH', to: 'Head of Engineering', addresses: ['Hauptstraße 12, 45128 Essen, Germany'], subject: 'Application for Platform Engineer — Jane Doe' });
    reset(); ai.queue = [ANSWER];
    const homeR = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Nordwerk', country: 'Germany', job: { ...PJOB } }));
    const home = { v2: v2Calls.slice(), calls: ai.calls.slice(), gt: gtP.slice(), put: store.puts[0] || { payload: {} } };
    reset(); gtP.length = 0; ai.queue = [ANSWER]; world.brandProfile = { brand_color: '#123456', font_name: 'Lato' };   // the Jobs lane's brand cache: a hit
    const jobsR = await call(CL.generateCoverLetterDetails, 7, {
      recipientEmail: 'hr@nordwerk.test', websiteUrl: 'nordwerk.test', position: 'Platform Engineer', jobLocation: 'Germany',
      companyName: 'Nordwerk', jobUrl: PJOB.url, jobText: PJOB.description,
    });
    const jobs = { v2: v2Calls.slice(), calls: ai.calls.slice(), gt: gtP.slice() };
    AT.generateText = realGT;
    ok('both lanes wrote the letter: Home 200 with a docId, the Jobs section 200 with the letter', homeR.statusCode === 200 && Number.isInteger(homeR.body.docId)
      && jobsR.statusCode === 200 && jobsR.body && jobsR.body.success === true, { home: homeR.body, jobs: jobsR.body && (jobsR.body.error || jobsR.body.companyName) });
    ok('⚠️ each built its prompt ONCE, through ai-cover-letter-v2\'s buildPrompt, with IDENTICAL arguments (metadata, position, research subject, responsibilities, job location, posting)',
      home.v2.length === 1 && jobs.v2.length === 1 && JSON.stringify(home.v2[0]) === JSON.stringify(jobs.v2[0]), { home: home.v2.map((a) => a.slice(1)), jobs: jobs.v2.map((a) => a.slice(1)) });
    ok('⚠️ …so Google received the SAME prompt, byte for byte, from both screens', home.calls.length === 1 && jobs.calls.length === 1
      && jobs.v2.length === 1 && textOf(home.calls[0]) === textOf(jobs.calls[0]) && textOf(home.calls[0]) === realBuildPrompt(...jobs.v2[0]) && textOf(home.calls[0]).length > 5000,
      { home: textOf(home.calls[0]).length, jobs: textOf(jobs.calls[0]).length });
    ok('⚠️ …with the same grounding tool, the same config and the same model',
      JSON.stringify(toolsOf(home.calls[0])) === JSON.stringify([{ googleSearch: {} }]) && JSON.stringify(toolsOf(home.calls[0])) === JSON.stringify(toolsOf(jobs.calls[0]))
      && JSON.stringify(home.calls[0].cfg) === JSON.stringify(jobs.calls[0].cfg) && home.calls[0].cfg.model === P, { home: home.calls[0].cfg, jobs: jobs.calls[0].cfg });
    const sameAsk = (g) => g && JSON.stringify({ lane: g.lane, prompt: g.prompt, config: g.config, models: g.models, modelConfig: g.modelConfig, caps: g.attemptCapsMs });
    ok('⚠️ …through ONE identical aiText request (lane, prompt, config, the letter chain, no modelConfig, the caps) — only the budget is each lane\'s own',
      home.gt.length === 1 && jobs.gt.length === 1 && sameAsk(home.gt[0]) === sameAsk(jobs.gt[0]) && home.gt[0].lane === 'letter_legacy'
      && JSON.stringify(home.gt[0].models) === JSON.stringify([P, F1, F2]) && !('modelConfig' in home.gt[0]), { home: home.gt.map((g) => g.models), jobs: jobs.gt.map((g) => g.models) });
    const hp = home.put.payload || {};
    ok('⚠️ the same answer became the same letter: the Home payload\'s HTML, subject, addressee and first office are the Jobs response\'s',
      hp.coverLetterHtml === jobsR.body.coverLetterHtml && hp.subject === jobsR.body.subject && hp.hiringManager === jobsR.body.hiringManager
      && Array.isArray(jobsR.body.locations) && hp.companyAddress === jobsR.body.locations[0].address && JSON.stringify(hp.locations) === JSON.stringify(jobsR.body.locations),
      { home: { subject: hp.subject, to: hp.hiringManager, address: hp.companyAddress }, jobs: { subject: jobsR.body.subject, to: jobsR.body.hiringManager, locations: jobsR.body.locations } });
    ok('…stored in the payload shape Home\'s readers expect (the same nine keys), the employer as the user picked it',
      JSON.stringify(Object.keys(hp).sort()) === JSON.stringify(['brandColor', 'companyAddress', 'companyName', 'coverLetterHtml', 'fontName', 'hiringManager', 'locations', 'position', 'subject'].sort())
      && hp.companyName === 'Nordwerk' && hp.position === 'Platform Engineer', Object.keys(hp));
    // Money, unchanged by the new writer: charged once above; the same request again is free; AI refusals charge nothing
    // (the storm block above, on this same writer).
    reset();
    const again = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Nordwerk', country: 'Germany', job: { ...PJOB } }));
    ok('⚠️ the same Home request again is the FREE cache hit: no v2 prompt built, no AI, no gate, no charge',
      again.statusCode === 200 && again.body.cached === true && again.body.docId === homeR.body.docId && v2Calls.length === 0 && ai.calls.length === 0 && ent.gateCalls === 0 && ent.consumed.length === 0, again.body);

    // A Builder-only résumé (no upload at all): the Jobs lane refuses one; Home never did, and still writes — from the same
    // merge over no upload row, { builder_resume }.
    const savedMeta = world.meta;
    world.meta = null;
    reset();
    const builderOnly = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Builderco', job: { ...JOB, company: 'Builderco', website: 'builderco.test' } }));
    ok('a Builder-only résumé still writes a letter: v2\'s metadata is { builder_resume } (mergeBuilderResume over no upload row)',
      builderOnly.statusCode === 200 && v2Calls.length === 1 && JSON.stringify(v2Calls[0][0]) === JSON.stringify({ builder_resume: world.resumeRow.resume_data })
      && /ADDITIONAL DETAILED RESUME/.test(textOf(ai.calls[0])), { status: builderOnly.statusCode, meta: v2Calls[0] && Object.keys(v2Calls[0][0]) });
    const savedRow = world.resumeRow;
    world.resumeRow = null;
    reset();
    // The writer's résumé read sits AFTER the cache: a saved letter is served free even while that read would come back empty.
    const hitAnyway = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Builderco', job: { ...JOB, company: 'Builderco', website: 'builderco.test' } }));
    ok('…and its saved letter is still the free cache hit while the résumé read-back is empty (that read comes after the cache)',
      hitAnyway.statusCode === 200 && hitAnyway.body.cached === true && hitAnyway.body.docId === builderOnly.body.docId && ai.calls.length === 0 && ent.gateCalls === 0, hitAnyway.body);
    reset();
    const nothing = await call(EL.buildEmployerLetter, 7, buildBody({ employer: 'Emptyco', job: { ...JOB, company: 'Emptyco', website: 'emptyco.test' } }));
    // (The material read says they HAVE a résumé — the stubbed narrative — so an empty read-back is a blip, not "no résumé".)
    ok('⚠️ …and a résumé the writer could not read back is a 500 "try again", never "upload one" — before any gate, research or AI',
      nothing.statusCode === 500 && nothing.body.reason === 'failed' && /couldn't read your resume/.test(nothing.body.error || '')
      && ent.gateCalls === 0 && researchCalls.length === 0 && ai.calls.length === 0 && v2Calls.length === 0 && ent.consumed.length === 0, nothing.body);
    world.meta = savedMeta; world.resumeRow = savedRow;

    // The code rules behind it (comment-stripped): the Home lane CALLS the Jobs lane's pieces and builds nothing of its own;
    // the Jobs lanes use the very same pieces.
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const el = strip(fsSync.readFileSync(path.join(ROOT, 'server/controllers/employerLetterController.js'), 'utf8'));
    const cl = strip(fsSync.readFileSync(path.join(ROOT, 'server/controllers/coverLetterController.js'), 'utf8'));
    const bodyOf = (src, name) => (src.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`)) || [''])[0];
    const build = bodyOf(el, 'buildEmployerLetter');
    ok('⚠️ Home calls the Jobs lane\'s pieces — the loader, the subject rule, the posting, the writer, the mapping — and nothing of its own',
      /cl\.letterResumeMetadataFor\(userId, \{ tries: 1 \}\)/.test(build) && /cl\.mergeBuilderResume\(userId, \{\}\)/.test(build) && /cl\.letterResearchSubjectOf\(site, company\)/.test(build)
      && /cl\.letterListingOf\(\{/.test(build) && /cl\.writeLegacyLetter\(/.test(build) && /cl\.letterDetailsOf\(written\.letter,/.test(build));
    ok('⚠️ …and the lane holds no prompt, schema, grounding or model call of its own',
      !/buildEmployerLetterPrompt|LETTER_SCHEMA|responseSchema|responseMimeType|googleSearch|generateText|getGenerativeModel|writing\(\)|buildPrompt\(/.test(el), el.length);
    const work = bodyOf(cl, 'executeGenerationWork');
    const details = (cl.match(/const generateCoverLetterDetails = async[\s\S]*?\n\};/) || [''])[0];
    const bulk = (cl.match(/const generateCoverLetters = async[\s\S]*?\n\};/) || [''])[0];
    ok('⚠️ the Jobs lanes use the SAME pieces (so the two screens cannot drift): the worker, the details route and bulk',
      /letterResearchSubjectOf\(websiteUrl, companyNameHint\)/.test(work) && /await letterResumeMetadataFor\(userId\)/.test(work) && /letterDetailsOf\(aiResult, \{/.test(work)
      && /letterListingOf\(\{ jobUrl, jobText, position, companyNameHint \}\)/.test(details) && /await letterResumeMetadataFor\(userId\)/.test(bulk)
      && !/AGGREGATOR_HOST\.test|'Address not available'|SELECT \* FROM resume_metadata/.test(work + details + bulk), { work: work.length, details: details.length, bulk: bulk.length });
    ok('⚠️ …and v2\'s prompt is built in ONE place in the whole server (writeLegacyLetter)', (cl.match(/letterV2\.buildPrompt\(/g) || []).length === 1 && /letterV2\.buildPrompt\(/.test(bodyOf(cl, 'writeLegacyLetter')));
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

  console.log('── ⚠️ pages AND cards: the gallery zooms the FULL page, Home keeps its 480-px card; PREVIEW_REV in every key ──');
  {
    // 2026-09-18: "the preview is not crystal clear and looks very blurry on zoom… specially for cover letter". The letter
    // gallery showed — and let the user pinch to 3x — the 480-px CARD, the only thing this lane stored. It stores the
    // renderer's page now, and cuts the card from it: size=page is the page, untouched; anything else is the card.
    const sharp = require('sharp');
    const rStub = require.cache[require.resolve(path.join(ROOT, 'server/utils/coverLetterRenderer.js'))].exports;
    const realRP = rStub.renderPreviews;
    // A REAL page, as the renderer draws one since PREVIEW_REV hd1: a WebP, far wider than a card.
    const PAGE = await sharp({ create: { width: 1588, height: 2246, channels: 3, background: '#ffffff' } }).webp({ quality: 80 }).toBuffer();
    rStub.renderPreviews = async (data, opts, tpls) => {
      rendered.previews.push({ data, opts, ids: tpls.map((t) => t.id) });
      return tpls.map((t) => ({ id: t.id, name: t.name, accent: t.accent, image: 'data:image/webp;base64,' + PAGE.toString('base64'), width: 1588, height: 2246 }));
    };
    const meta = async (uri) => { const m = await sharp(Buffer.from(String(uri).split(',')[1] || '', 'base64')).metadata(); return { format: m.format, width: m.width }; };
    const cardsOf = async (query) => { const out = mkRes(); await EL.employerLetterCards(mkReq(7, {}, { query: { doc: String(letterDoc.id), ...query } }), out); return out; };
    try {
      letterDoc.updated_at = new Date('2026-09-18T10:00:00Z');   // a new version of the letter: nothing of it is cached
      rendered.previews = [];
      res = await cardsOf({ ids: 'german', size: 'page' });
      const pg = res.body.cards && res.body.cards[0];
      const pgMeta = pg ? await meta(pg.image) : {};
      ok('⚠️ size=page → the renderer\'s FULL page, untouched: a 1588-px WebP, labelled as the WebP it is',
        res.statusCode === 200 && !!pg && /^data:image\/webp;base64,/.test(pg.image) && pgMeta.format === 'webp' && pgMeta.width === 1588 && rendered.previews.length === 1, { status: res.statusCode, meta: pgMeta });
      rendered.previews = [];
      res = await cardsOf({ ids: 'german' });
      const cd = res.body.cards && res.body.cards[0];
      const cdMeta = cd ? await meta(cd.image) : {};
      ok('…Home\'s card (no size: the default) is cut from that same page — a 480-px JPEG — with NO second render',
        res.statusCode === 200 && !!cd && /^data:image\/jpeg;base64,/.test(cd.image) && cdMeta.format === 'jpeg' && cdMeta.width === 480 && rendered.previews.length === 0, { meta: cdMeta, renders: rendered.previews.length });
      const names = fsSync.readdirSync(path.join(THUMBS, '7'));
      ok('…both on disk: the page under its key, its card beside it (.w480)',
        names.some((n) => /^cl_[0-9a-f]{64}\.w480\.jpg$/.test(n) && names.includes(n.replace(/\.w480\.jpg$/, '.jpg'))), names.filter((n) => n.startsWith('cl_')).slice(0, 6));
      res = await cardsOf({ ids: 'german', size: 'huge' });
      ok('…and a size the route does not know is the card, never the page', res.statusCode === 200 && !!(res.body.cards && res.body.cards[0]) && (await meta(res.body.cards[0].image)).width === 480);
      // A render asked for as a CARD (the build's pre-render, Home) writes the page too: the gallery's first page is a hit.
      letterDoc.updated_at = new Date('2026-09-18T11:00:00Z');
      rendered.previews = [];
      res = await cardsOf({ ids: 'technical' });
      const firstAsCard = rendered.previews.length;
      res = await cardsOf({ ids: 'technical', size: 'page' });
      ok('⚠️ a page first rendered for a card is the gallery\'s next page — no second render, the full page served',
        firstAsCard === 1 && rendered.previews.length === 1 && !!(res.body.cards && res.body.cards[0]) && (await meta(res.body.cards[0].image)).width === 1588, { renders: rendered.previews.length });
      // ⚠️ THE CONTRACT: PREVIEW_REV is in every key. A renderer that changes resolution changes it, and nothing rendered
      // under the old one is served again — page or card.
      rStub.PREVIEW_REV = 'test-rev-2';
      rendered.previews = [];
      res = await cardsOf({ ids: 'technical', size: 'page' });
      const pageAfter = rendered.previews.length;
      res = await cardsOf({ ids: 'technical' });
      ok('⚠️ a new PREVIEW_REV is a new key: the page is rendered again, and the card is cut from the NEW page (one render for both)',
        pageAfter === 1 && rendered.previews.length === 1 && res.statusCode === 200, { renders: rendered.previews.length });
    } finally {
      rStub.PREVIEW_REV = 'test-rev-1';
      rStub.renderPreviews = realRP;
    }
    const elK = fsSync.readFileSync(path.join(ROOT, 'server/controllers/employerLetterController.js'), 'utf8');
    // RETARGETED 2026-09-22 (the unsigned Nordex letter): the key also ends with the signature's version, ONLY for a user
    // who has one — an unsigned user's keys are exactly what they were (server/scripts/test-sign-and-open.js).
    // RETARGETED 2026-09-19 (the Airbus letter): the key ends with LETTER_REPAIR_REV for a REPAIRED letter only — a clean
    // letter's parts are exactly what they were (pinned by value in "── ⚠️ A LETTER STORED WITH JSON IN IT ──" below).
    ok('⚠️ the page key carries coverLetterRenderer.PREVIEW_REV, read per call, and the card\'s name is the page\'s',
      /const previewRev = String\(clRenderer\.PREVIEW_REV \|\| ''\);/.test(elK) && /t\.generic \? photoVer : '-', previewRev, \.\.\.\(body\.repaired \? \[letterText\.LETTER_REPAIR_REV\] : \[\]\),\s*\.\.\.\(sigVer \? \[sigVer\] : \[\]\)\]\.join\('\|'\)/.test(elK)
      && /const cardOf = \(page\) => page\.replace\(\/\\\.jpg\$\/, `\.w\$\{THUMB_W\}\.jpg`\);/.test(elK));
  }

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

  console.log('── ⚠️ THE EMPLOYER\'S BRAND ON A LETTER (2026-09-15): design.brand stored, in EVERY doc-mode render ──');
  {
    // Contracts 4 (letter side) + 5 (letters): the website's colour and font (research.brand, contract 1) beat the
    // researcher's brandColor/fontName; the effective pair is stored as design.brand and reaches employer-cards (hashed into
    // the thumb key for EVERY design, so a changed brand is never served in yesterday's colour), generate-template-pdf/docx
    // with a docId, and the generic PDFKit path; the classic lanes stay byte-for-byte as they were. (The sector-led opening
    // went with the Home lane's own prompt on 2026-09-18 — the brand is rendering, and it never reaches the words.) The
    // money guards (gate, C2, consume, store-only-when-charged) are the scenarios above — nothing here spends differently.
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
    // 2. (the sector-led opening and the conventions' style were the Home lane's OWN prompt — gone with it on 2026-09-18,
    // when the letter became the Jobs section's. The brand is RENDERING, not writing, and stays exactly as it was.)
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
    ok('…and the brand never reached the words: the prompt is v2\'s, with no colour, font or sector of the research in it',
      !/#c0392b|Poppins|fit for Fintech/.test(textOf(ai.calls[0])) && v2Calls.length === 1 && textOf(ai.calls[0]) === realBuildPrompt(...v2Calls[0]));
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
    r = await call(CL.generateCoverLetterTemplatePdf, 7, { template: 'standard', docId: bdoc.id, mode: 'onepage' });
    ok('pdf docId generic at One Page: the brand colour and the Google font family reach the PDFKit generator', r.statusCode === 200 && rendered.richArgs[4] === '#c0392b' && rendered.richArgs[5] === 'Poppins', rendered.richArgs && rendered.richArgs.slice(4));
    // ⚠️ AND AT A4 THE SAME BRAND REACHES THE HTML TWIN INSTEAD (2026-09-20). The PDFKit generator can only build one
    // page sized to the letter's content, so it cannot answer A4 at all; the twin — the markup this design's own
    // gallery card is a picture of — is what renders the pages, in the same brand, with the same profile photo its
    // free preview uses (renderLetterPdfFile's `genericA4`).
    rendered.pdfArgs = null; rendered.rich = 0;
    r = await call(CL.generateCoverLetterTemplatePdf, 7, { template: 'standard', docId: bdoc.id, mode: 'a4' });
    ok('⚠️ pdf docId generic at A4: the brand + the photo go to the HTML twin, and the PDFKit generator is not called at all',
      r.statusCode === 200 && rendered.rich === 0 && rendered.pdfArgs && rendered.pdfArgs.id === 'standard'
      && rendered.pdfArgs.opts.mode === 'a4' && rendered.pdfArgs.opts.brandColor === '#c0392b'
      && rendered.pdfArgs.opts.brandFont.family === 'Poppins' && 'photo' in rendered.pdfArgs.opts,
      rendered.pdfArgs && rendered.pdfArgs.opts);
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
      && /clRenderer\.renderPreviews\(data, \{ photo, signature, brandColor: accent, brandFont \}, missing\)/.test(elC));
    ok('⚠️ LETTER_REV stays letter-v1 through the brand round (a bump re-bills every saved letter)', /const LETTER_REV = 'letter-v1';/.test(elC) && !/LETTER_REV = 'letter-v2'/.test(elC));
    ok('the brand readings live in the core controller (docId downloads never depend on the feature file)',
      typeof CL.researchBrandOf === 'function' && typeof CL.letterBrandOf === 'function' && typeof CL.withSharedLetterBrand === 'function');
    const clC = stripL(fsSync.readFileSync(path.join(ROOT, 'server/controllers/coverLetterController.js'), 'utf8'));
    // RETARGETED 2026-09-19 (the Airbus letter): the brand is laid on, THEN the stored letter is repaired (a copy).
    ok('⚠️ employerLetterDocFor (docId PDF / DOCX) lays the shared brand on before savedLetterInput reads it; the read is cachedBrandFor and nothing that bills or writes',
      /return LETTER_DOC_GONE;\s*const branded = await withSharedLetterBrand\(doc\);\s*const payload = letterText\.repairedLetterPayload\(branded\.payload\);/.test(clC)
      && (() => { const b = (clC.match(/async function withSharedLetterBrand\(doc\) \{[\s\S]*?\n\}/) || [''])[0]; return b.length > 100 && /cachedBrandFor\(domain\)/.test(b) && !/getEmployerResearch|researchBrand\(|brandCallFor|INSERT|UPDATE/.test(b); })());   // researchBrandOf is the READER; researchBrand( is the website call
    ok('⚠️ the feature file adopts it at BOTH of its loads (the post-build thumb prerender and employerLetterCards) — before letterCardsFor hashes the brand, so a thumb is the file the download would produce',
      (elC.match(/await withSharedLetterBrand\((cl|clMod\(\)), await employerDocs(Mod\(\))?\.getById\(/g) || []).length === 2 && /async function withSharedLetterBrand\(cl, doc\)/.test(elC));
  }

  console.log('── ⚠️ A LETTER STORED WITH JSON IN IT (2026-09-19: "it started showing some json in paragraph 5,6") ──');
  {
    // Production, user 1, Home → Airbus (user_employer_documents 15, gemini-2.5-flash, grounded): the answer was TWO JSON
    // objects with the model's chatter between them. The parser read one span from the first "{" to the last "}", and the
    // stored (and charged) letter was nine paragraphs: the real four, then '"', "}", "Rishi, I have completed the cover
    // letter …", "Here is the JSON output:", a ```json block, and the letter again. fixtures/letter-doc15-raw.txt is that
    // answer (test-letter-json.js proves it reproduces the stored letter byte for byte through the old parser);
    // fixtures/letter-doc15-stored.html is what production stored.
    const LT = require(path.join(ROOT, 'server/utils/letterText.js'));
    const DOC15_RAW = fsSync.readFileSync(path.join(ROOT, 'server/scripts/fixtures/letter-doc15-raw.txt'), 'utf8');
    const DOC15_STORED = fsSync.readFileSync(path.join(ROOT, 'server/scripts/fixtures/letter-doc15-stored.html'), 'utf8');
    const DOC15_CLEAN = LT.repairLetterHtml(DOC15_STORED).html;   // the four real paragraphs, as the read side repairs them
    const JUNK = /```|"cover_letter"|"employer_name"|Here is the JSON|I have completed the cover letter|<br>\}/;
    const paras = (h) => (String(h).match(/<\/p>/g) || []).length;
    const unstyled = (h) => String(h).replace(/<p style="[^"]*">/g, '<p>');
    const AIRBUS = (title) => buildBody({ employer: 'Airbus', country: 'United Kingdom', job: { ...JOB, company: 'Airbus', title, website: 'airbus.test' } });
    // Answers that PARSE but are not a letter even after the cleaning: nine distinct paragraphs, and a JSON object inline.
    const NINE = GOOD({ cover_letter: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(PARA).join('\n\n') });
    const INLINE = GOOD({ cover_letter: `${PARA(1)} {"to": "HR", "subject": "S"}\n\n${PARA(2)}` });

    // 1. the Airbus answer itself → the four paragraphs, first try, charged once.
    reset(); ai.queue = [DOC15_RAW];
    r = await call(EL.buildEmployerLetter, 7, AIRBUS('Cyber Security Manager'));
    const pA = (store.puts[0] || { payload: {} }).payload;
    ok('⚠️ the Airbus answer (two JSON objects + chatter) → 200, ONE AI call, charged once, stored once',
      r.statusCode === 200 && ai.calls.length === 1 && ent.consumed.length === 1 && store.puts.length === 1, { status: r.statusCode, calls: ai.calls.length, body: r.body });
    ok('⚠️ …and the stored letter is FOUR paragraphs with no fence, no JSON key, no chatter, nothing twice (it was nine)',
      paras(pA.coverLetterHtml) === 4 && !JUNK.test(pA.coverLetterHtml) && !LT.looksContaminatedHtml(pA.coverLetterHtml), pA.coverLetterHtml && pA.coverLetterHtml.slice(-300));
    ok('…exactly the four real paragraphs production stored first (the write side and the read-side repair agree)',
      unstyled(pA.coverLetterHtml) === DOC15_CLEAN, { stored: unstyled(pA.coverLetterHtml).slice(-160), repaired: DOC15_CLEAN.slice(-160) });
    ok('…with the FIRST object\'s one-line fields: the addressee, the subject and all nine researched offices',
      pA.hiringManager === 'Head of Cybersecurity' && pA.subject === 'Application for Cyber Security Manager — Rishi Samadhiya' && pA.locations.length === 9, { to: pA.hiringManager, subject: pA.subject, n: pA.locations && pA.locations.length });
    ok('…and the thumbnails were rendered from that clean letter', rendered.previews.length === 1 && rendered.previews[0].data.bodyHtml === pA.coverLetterHtml);

    // 1b. ⚠️ (review round 3, 2026-09-20) the same answer with ONE literal " in its first copy ("14+ years 27""). That quote
    // flipped the escaper's in-string parity, the extractor found no end of copy 1, ran on into copy 2, and the second copy's
    // first paragraph (without the quote) passed every exact-copy test: five paragraphs, stored and charged.
    const DOC15_ODD = DOC15_RAW.replace('**14+ years**', '**14+ years 27"**');
    reset(); ai.queue = [DOC15_ODD];
    r = await call(EL.buildEmployerLetter, 7, AIRBUS('Cyber Defence Manager'));
    const pO = (store.puts[0] || { payload: {} }).payload;
    const oddText = LT.repairLetterHtml(pO.coverLetterHtml || '').html.replace(/<[^>]+>/g, ' ');
    ok('⚠️ the Airbus answer with one literal " in its first copy → 200, ONE AI call, charged once, FOUR paragraphs (it was five)',
      r.statusCode === 200 && ai.calls.length === 1 && ent.consumed.length === 1 && store.puts.length === 1 && paras(pO.coverLetterHtml) === 4
        && !JUNK.test(pO.coverLetterHtml) && !LT.looksContaminatedHtml(pO.coverLetterHtml), { status: r.statusCode, calls: ai.calls.length, paras: paras(pO.coverLetterHtml) });
    ok('…copy 1\'s words (its quote kept, "14+ years" once, "consideration" once) and copy 1\'s fields',
      (oddText.match(/14\+ years/g) || []).length === 1 && /14\+ years 27(?:"|&quot;)/.test(pO.coverLetterHtml) && (oddText.match(/Thank you for your consideration/g) || []).length === 1
        && pO.hiringManager === 'Head of Cybersecurity' && pO.subject === 'Application for Cyber Security Manager — Rishi Samadhiya' && pO.locations.length === 9,
      { subject: pO.subject, n: pO.locations && pO.locations.length });
    reset(); ai.queue = [DOC15_ODD];
    r = await call(CL.generateCoverLetterDetails, 7, { recipientEmail: 'hr@airbus.test', websiteUrl: 'airbus.test', position: 'Cyber Security Manager', companyName: 'Airbus' });
    ok('⚠️ …and the Jobs lane (Letters page / Job Hub) reads it the same: four paragraphs, charged once',
      r.statusCode === 200 && r.body.success === true && paras(r.body.coverLetterHtml) === 4 && !JUNK.test(r.body.coverLetterHtml) && ent.consumed.length === 1,
      { status: r.statusCode, paras: r.body && paras(r.body.coverLetterHtml) });
    // A paragraph written NEARLY twice inside the letter itself: the near-copy goes before anything is stored or charged.
    const P1x = PARA(1).replace('two days', 'two full days');
    reset(); ai.queue = [GOOD({ cover_letter: [PARA(1), PARA(2), PARA(3), PARA(4), P1x].join('\n\n') })];
    r = await call(EL.buildEmployerLetter, 7, AIRBUS('Security Operations Analyst'));
    const pN = (store.puts[0] || { payload: {} }).payload;
    ok('⚠️ a letter with a near-copy of its first paragraph → stored as its 4 paragraphs, one call, charged once',
      r.statusCode === 200 && ai.calls.length === 1 && ent.consumed.length === 1 && paras(pN.coverLetterHtml) === 4 && !/two full days/.test(pN.coverLetterHtml),
      { status: r.statusCode, paras: paras(pN.coverLetterHtml) });

    // 2. an answer that is not a letter → asked ONCE more, on the same primary; the second answer is stored and charged.
    reset(); ai.queue = [NINE, GOOD()];
    r = await call(EL.buildEmployerLetter, 7, AIRBUS('Security Architect'), { __jobId: 'job-airbus-retry' });
    ok('⚠️ an answer that fails the letter check (nine paragraphs) → asked once more: 2 calls, the second letter stored, charged ONCE',
      r.statusCode === 200 && ai.calls.length === 2 && ai.calls.every((c) => c.cfg.model === P) && ent.consumed.length === 1 && store.puts.length === 1
        && paras(store.puts[0].payload.coverLetterHtml) === 4, { status: r.statusCode, calls: ai.calls.map((c) => c.cfg.model), consumed: ent.consumed.length });
    ok('…and the retry is on the bar in plain words', stages.some((s) => s.stage === 'retry' && s.label === 'Taking another pass at it'), stages.map((s) => s.label));

    // 3. two answers that are not letters → the honest ending: nothing charged, nothing stored, never a third ask.
    reset(); ai.queue = [NINE, INLINE, GOOD()];
    r = await call(EL.buildEmployerLetter, 7, AIRBUS('Security Engineer'));
    ok('⚠️ two answers that fail the letter check → 500 failed, and the answer SAYS nothing was charged',
      r.statusCode === 500 && r.body.success === false && r.body.reason === 'failed' && /Nothing was charged/.test(r.body.error), r.body);
    ok('⚠️ …exactly TWO AI calls (the third answer was never asked for), no consume, no put, no charge to give back',
      ai.calls.length === 2 && ai.queue.length === 1 && ent.consumed.length === 0 && store.puts.length === 0 && passSpy.claimCalls.length === 0 && (world.refunds || []).length === 0,
      { calls: ai.calls.length, left: ai.queue.length, consumed: ent.consumed.length, puts: store.puts.length });
    // The writer's own ending, straight: its words, its reason code, and no err.reason (the lanes' 402 / 503 mapping untouched).
    let wErr = null;
    reset(); ai.queue = [INLINE, NINE];
    try { await CL.writeLegacyLetter({ raw_text: 'x' }, 'airbus.test', 'Security Engineer'); } catch (e) { wErr = e; }
    ok('the writer\'s ending: LEGACY_LETTER_UNUSABLE, userFacing, err.letterCheck set, no err.reason',
      !!wErr && wErr.message === CL._internals.LEGACY_LETTER_UNUSABLE && wErr.userFacing === true && wErr.letterCheck === 'too_many_paragraphs' && !('reason' in wErr) && ai.calls.length === 2,
      wErr && { message: wErr.message, check: wErr.letterCheck, calls: ai.calls.length });
    // Answers that do not PARSE keep v2's three tries (above, "three unusable answers"); one of each still stops at three.
    reset(); ai.queue = ['not json', NINE, 'Sorry, I cannot help with that.'];
    r = await call(EL.buildEmployerLetter, 7, AIRBUS('Security Lead'));
    ok('a mix (no JSON, not a letter, no JSON) → still three answers at most, then 500 failed, nothing charged',
      r.statusCode === 500 && r.body.reason === 'failed' && ai.calls.length === 3 && ent.consumed.length === 0 && store.puts.length === 0, { status: r.statusCode, calls: ai.calls.length });

    // 4. the Jobs section's letter (POST /generate-cover-letter-details → the Letters page and the Job Hub) shares the
    // writer: the Airbus answer is its four paragraphs there too.
    reset(); ai.queue = [DOC15_RAW]; world.brandProfile = { brand_color: '#00205b', font_name: 'Lato' };
    r = await call(CL.generateCoverLetterDetails, 7, { recipientEmail: 'hr@airbus.test', websiteUrl: 'airbus.test', position: 'Cyber Security Manager', companyName: 'Airbus' });
    ok('⚠️ the Jobs lane (Letters page / Job Hub) hands back the same four clean paragraphs, charged once',
      r.statusCode === 200 && r.body.success === true && paras(r.body.coverLetterHtml) === 4 && !JUNK.test(r.body.coverLetterHtml)
        && unstyled(r.body.coverLetterHtml) === DOC15_CLEAN && ent.consumed.length === 1, { status: r.statusCode, error: r.body && r.body.error });

    // 4b. ⚠️ (review, 2026-09-19) a closing that only SOUNDS like the model is the letter's own: stored with it, first try.
    // And the prompt's own template, or a stub, is never stored or charged in place of the letter.
    const SOUNDS = 'I hope this cover letter shows why I am prepared to relocate to **Berlin, Germany** to join **Acme GmbH**. Thank you for your consideration.';
    reset(); ai.queue = [GOOD({ cover_letter: [PARA(1), PARA(2), PARA(3), SOUNDS].join('\n\n') })];
    r = await call(EL.buildEmployerLetter, 7, AIRBUS('Platform Engineer'));
    const pS = (store.puts[0] || { payload: {} }).payload;
    ok('⚠️ a letter closing "I hope this cover letter shows why I am prepared to relocate …" → stored WITH that closing (4 paragraphs), one call, charged once',
      r.statusCode === 200 && ai.calls.length === 1 && ent.consumed.length === 1 && paras(pS.coverLetterHtml) === 4
        && /I hope this cover letter shows why I am prepared to relocate to <strong>Berlin, Germany<\/strong>/.test(pS.coverLetterHtml),
      { status: r.statusCode, calls: ai.calls.length, paras: paras(pS.coverLetterHtml), tail: String(pS.coverLetterHtml || '').slice(-160) });
    const TEMPLATE = JSON.stringify({ to: 'Hiring manager name if found, otherwise most relevant title e.g. Head of Engineering', employer_name: 'Full official company name',
      position: 'Target position exactly as provided', addresses: ['HQ full street address, postal code, city, country'],
      subject: 'Application for [Target Position] — [User Full Name from metadata]', cover_letter: 'PARAGRAPH 1 text\n\nPARAGRAPH 2 text\n\nPARAGRAPH 3 text\n\nPARAGRAPH 4 text' }, null, 2);
    reset(); ai.queue = [GOOD() + '\n\nThe output follows this format:\n\n' + TEMPLATE];
    r = await call(EL.buildEmployerLetter, 7, AIRBUS('Data Engineer'));
    const pT = (store.puts[0] || { payload: {} }).payload;
    ok('⚠️ the letter, then the prompt\'s template echoed back → the LETTER is stored with its own subject (not "PARAGRAPH 1 text"), one call, charged once',
      r.statusCode === 200 && ai.calls.length === 1 && ent.consumed.length === 1 && paras(pT.coverLetterHtml) === 4
        && !/PARAGRAPH \d text|\[Target Position\]/.test(JSON.stringify(pT)) && pT.subject === 'Application for Senior Backend Engineer — Jane Doe',
      { status: r.statusCode, subject: pT.subject, letter: String(pT.coverLetterHtml || '').slice(0, 80) });
    reset(); ai.queue = [TEMPLATE, GOOD()];
    r = await call(EL.buildEmployerLetter, 7, AIRBUS('Data Architect'));
    ok('⚠️ the template ALONE → refused before any charge, asked once more: 2 calls, the real letter stored, charged ONCE',
      r.statusCode === 200 && ai.calls.length === 2 && ent.consumed.length === 1 && store.puts.length === 1
        && !/PARAGRAPH \d text/.test(store.puts[0].payload.coverLetterHtml), { status: r.statusCode, calls: ai.calls.length, consumed: ent.consumed.length });
    reset(); ai.queue = [GOOD({ cover_letter: 'Please see the letter below.' }), GOOD({ cover_letter: PARA(1) }), GOOD()];
    r = await call(EL.buildEmployerLetter, 7, AIRBUS('Data Scientist'));
    ok('⚠️ two stubs ("Please see the letter below.", one paragraph) → 500 "Nothing was charged", 2 calls, nothing consumed or stored',
      r.statusCode === 500 && /Nothing was charged/.test(r.body.error) && ai.calls.length === 2 && ent.consumed.length === 0 && store.puts.length === 0,
      { status: r.statusCode, calls: ai.calls.length, consumed: ent.consumed.length, body: r.body });

    // 4c. ⚠️ ROUND 2 (review, 2026-09-19), through the Home lane: the model's WRAPPER inside cover_letter ("Sure! Here is the
    // cover letter you asked for." first, "I hope this helps!" last) used to be stored — and charged — as a card; a closing
    // that NAMES A FORMAT with no JSON anywhere ("… in the requested format.") used to be cut out of the letter silently.
    const WRAPPED = ['Sure! Here is the cover letter you asked for.', PARA(1), PARA(2), PARA(3), PARA(4), 'I hope this helps!'].join('\n\n');
    reset(); ai.queue = [GOOD({ cover_letter: WRAPPED })];
    r = await call(EL.buildEmployerLetter, 7, AIRBUS('Security Analyst'));
    const pW = (store.puts[0] || { payload: {} }).payload;
    ok('⚠️ "Sure! Here is the cover letter …" first + "I hope this helps!" last → stored WITHOUT them (the 4 paragraphs), one call, charged once',
      r.statusCode === 200 && ai.calls.length === 1 && ent.consumed.length === 1 && store.puts.length === 1 && paras(pW.coverLetterHtml) === 4
        && !/Sure!|Here is the cover letter|hope this helps/i.test(pW.coverLetterHtml) && !LT.looksContaminatedHtml(pW.coverLetterHtml),
      { status: r.statusCode, calls: ai.calls.length, paras: paras(pW.coverLetterHtml), head: String(pW.coverLetterHtml || '').slice(0, 120) });
    const FORMAT_CLOSING = 'Please let me know if you would like my certificates in the requested format.';
    reset(); ai.queue = [GOOD({ cover_letter: [PARA(1), PARA(2), PARA(3), PARA(4), FORMAT_CLOSING].join('\n\n') })];
    r = await call(EL.buildEmployerLetter, 7, AIRBUS('Security Consultant'));
    const pF = (store.puts[0] || { payload: {} }).payload;
    ok('⚠️ a letter closing "… my certificates in the requested format." → stored WITH that closing (5 paragraphs), one call, charged once',
      r.statusCode === 200 && ai.calls.length === 1 && ent.consumed.length === 1 && paras(pF.coverLetterHtml) === 5
        && pF.coverLetterHtml.includes(FORMAT_CLOSING) && LT.repairLetterHtml(pF.coverLetterHtml).repaired === false,
      { status: r.statusCode, calls: ai.calls.length, paras: paras(pF.coverLetterHtml), tail: String(pF.coverLetterHtml || '').slice(-120) });

    // 5. the letter ALREADY stored with the junk: every read repairs it — the cards, the PDF designs, the Original, the Word
    // file and the history row — and the row itself is never written.
    reset();
    const bad = { id: store.nextId++, user_id: 7, kind: 'cover_letter', employer_key: 'airbus stored', employer_name: 'Airbus Stored', job_url: '', job_title: 'Cyber Security Manager',
      input_fingerprint: 'fp-doc15', environment: 'Production', payload: { coverLetterHtml: DOC15_STORED, subject: 'Application for Cyber Security Manager — Rishi Samadhiya', companyName: 'Airbus', companyAddress: 'Floor 2, Wellington House, 125-30 Strand, UK', hiringManager: 'Head of Cybersecurity', position: 'Cyber Security Manager', locations: [] },
      research: null, design: { kind: 'cover_letter', mode: 'a4', ranked: [{ id: 'ats_pro', score: 90 }, { id: 'standard', score: 80 }] }, updated_at: new Date('2026-09-19T16:42:39Z') };
    store.rows.push(bad);
    const clean = { ...bad, id: store.nextId++, employer_key: 'airbus clean', employer_name: 'Airbus Clean', payload: { ...bad.payload, coverLetterHtml: DOC15_CLEAN } };
    store.rows.push(clean);
    const thumbsOf = () => new Set(fsSync.readdirSync(path.join(THUMBS, '7')).filter((n) => n.startsWith('cl_')));
    let res5 = mkRes(); await EL.employerLetterCards(mkReq(7, {}, { query: { doc: String(bad.id), ids: 'ats_pro' } }), res5);
    ok('⚠️ the cards of the stored Airbus letter are rendered from the REPAIRED letter',
      res5.statusCode === 200 && rendered.previews.length === 1 && rendered.previews[0].data.bodyHtml === DOC15_CLEAN && !JUNK.test(rendered.previews[0].data.bodyHtml), rendered.previews.map((p) => p.data.bodyHtml.slice(-80)));
    ok('…and the stored row is untouched (a read never writes)', bad.payload.coverLetterHtml === DOC15_STORED && store.puts.length === 0);
    const before = thumbsOf(); rendered.previews = [];
    res5 = mkRes(); await EL.employerLetterCards(mkReq(7, {}, { query: { doc: String(bad.id), ids: 'ats_pro' } }), res5);
    ok('…a second look is a cache hit (the repaired key is stable)', res5.statusCode === 200 && rendered.previews.length === 0);
    // The same doc, its payload healed by a save (same id, same updated_at): a clean letter's key has no repair mark, so its
    // card is NOT the repaired one's file — the mark is in the key of a repaired letter only.
    bad.payload = { ...bad.payload, coverLetterHtml: DOC15_CLEAN }; rendered.previews = [];
    res5 = mkRes(); await EL.employerLetterCards(mkReq(7, {}, { query: { doc: String(bad.id), ids: 'ats_pro' } }), res5);
    const after = thumbsOf();
    ok('⚠️ LETTER_REPAIR_REV is in a REPAIRED letter\'s thumb key only: the healed letter (same id, same updated_at) is a new key',
      rendered.previews.length === 1 && [...after].filter((n) => !before.has(n)).length >= 1, { renders: rendered.previews.length });
    bad.payload = { ...bad.payload, coverLetterHtml: DOC15_STORED };
    rendered.previews = [];
    res5 = mkRes(); await EL.employerLetterCards(mkReq(7, {}, { query: { doc: String(clean.id), ids: 'ats_pro' } }), res5);
    rendered.previews = [];
    res5 = mkRes(); await EL.employerLetterCards(mkReq(7, {}, { query: { doc: String(clean.id), ids: 'ats_pro' } }), res5);
    ok('a clean letter\'s cards cache exactly as before (second look renders nothing)', res5.statusCode === 200 && rendered.previews.length === 0);

    hist.length = 0; rendered.pdf = 0; rendered.rich = 0; rendered.docx = 0;
    r = await call(CL.generateCoverLetterTemplatePdf, 7, { template: 'ats_pro', docId: bad.id });
    ok('⚠️ the PDF of the stored Airbus letter (docId) prints the repaired letter, and the history row freezes the repaired text',
      r.statusCode === 200 && rendered.pdfArgs.data.bodyHtml === DOC15_CLEAN && hist.length === 1 && hist[0].payload.coverLetterHtml === DOC15_CLEAN, { status: r.statusCode, body: r.body });
    r = await call(CL.generateCoverLetterTemplatePdf, 7, { template: 'standard', docId: bad.id, mode: 'onepage' });
    ok('⚠️ …the Original (PDFKit) too', r.statusCode === 200 && rendered.rich === 1 && rendered.richArgs[1] === DOC15_CLEAN, rendered.richArgs && String(rendered.richArgs[1]).slice(-80));
    // …and the same letter at A4, which renders through the twin, is repaired on that road too.
    rendered.pdf = 0;
    r = await call(CL.generateCoverLetterTemplatePdf, 7, { template: 'standard', docId: bad.id, mode: 'a4' });
    ok('⚠️ …and the Original at A4 (the HTML twin) prints the repaired letter as well',
      r.statusCode === 200 && rendered.pdf === 1 && rendered.pdfArgs.data.bodyHtml === DOC15_CLEAN, rendered.pdfArgs && String(rendered.pdfArgs.data.bodyHtml).slice(-80));
    r = await call(CL.generateCoverLetterTemplateDocx, 7, { template: 'german', docId: String(bad.id) });
    ok('⚠️ …and the Word file', r.statusCode === 200 && rendered.docx === 1 && rendered.docxArgs.data.bodyHtml === DOC15_CLEAN, r.body);
    r = await call(CL.generateCoverLetterTemplatePdf, 7, { template: 'standard', coverLetterHtml: DOC15_STORED, companyName: 'Airbus' });
    ok('⚠️ a frozen copy re-downloaded through the classic lane (download_history 13 is one) reaches the Original repaired',
      r.statusCode === 200 && rendered.rich === 2 && rendered.richArgs[1] === DOC15_CLEAN, r.body);
    rendered.rich = 0;
    r = await call(CL.generateCoverLetterTemplatePdf, 7, { template: 'standard', docId: clean.id, mode: 'onepage' });
    ok('a clean letter reaches the Original as the very same string', r.statusCode === 200 && rendered.rich === 1 && rendered.richArgs[1] === clean.payload.coverLetterHtml);
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
