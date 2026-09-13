// The resume DOC LANE end to end — POST /generate-ai with saveTo:'employer_doc', the generation gate, home-cards
// ?doc=, preview-templates / generate-pdf / generate-docx with a docId — driven through the REAL
// resumeBuilderController handlers against a stubbed database, a stubbed AI and a stubbed renderer.
// Every AI call, research call, charge and stored document is counted.
//   node server/scripts/test-employer-doc-lane.js
//
// ⚠️ WHY: this lane spends money. A cache hit must touch no billing; coveredOnly must refuse before research
// (a grounded AI call) and again at the moment of payment; a document is stored only for a build that was
// actually charged; and the lane must never read or write user_resumes (Home keeps one document PER EMPLOYER).
// Writes (and removes) thumbnails under uploads/.thumb_cache/987654 and preview files in temp/ for a
// user id no real account has.
'use strict';
const path = require('path');
const fsSync = require('fs');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (n, c, x) => {
  if (c) pass++;
  else { fail++; failures.push(n); console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 400) : '')); }
};

process.env.GEMINI_API_KEY = 'test-key-not-used';
const UID = 987654;                          // not a real account
const THUMB_DIR = path.join(ROOT, 'uploads', '.thumb_cache', String(UID));
const STARTED = Date.now();

// ── counters ─────────────────────────────────────────────────────────────────────────────────────
const ai = { calls: 0, prompts: [], queue: [] };          // queue: functions (prompt) => text
const research = { calls: 0 };
const render = { previews: 0, pdf: 0, docx: 0 };
const stages = [];
const refunds = [];
const historyRows = [];

// ── the database ─────────────────────────────────────────────────────────────────────────────────
const db = {
  docs: [],                   // user_employer_documents
  nextDocId: 100,
  userResumesTouched: [],     // any SQL that names user_resumes
  passes: [],
  nextPassId: 1,
  ledgerMax: 0, historyMax: 0,
  ledger: [],                 // { id, user_id, kind, source }
  creditHistory: [],          // { id, user_id, action_type, credits_used }
  sql: [],
};
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
async function dbGet(sql, params = []) {
  const q = norm(sql);
  db.sql.push(q.slice(0, 100));
  if (/user_resumes/.test(q)) {
    db.userResumesTouched.push(q.slice(0, 80));
    // db.noBuilderRow: an UPLOAD-ONLY account — a résumé we hold and can build from, but no builder row.
    if (db.noBuilderRow) return null;
    return { resume_data: { personal_info: { full_name: 'Base' } }, updated_at: new Date('2026-01-01T00:00:00Z'), tailored_for: null };
  }
  if (/FROM resume_metadata/.test(q)) return { id: 1, user_id: params[0], parse_status: 'done', skills: 'Node, Postgres', job_titles: 'Backend Engineer' };
  if (/SELECT photo_path FROM users/.test(q)) return null;
  // credit marks
  if (/SELECT COALESCE\(MAX\(id\), 0\) AS id FROM credit_usage_history/.test(q)) return { id: db.creditHistory.filter((r) => r.user_id === params[0]).reduce((m, r) => Math.max(m, r.id), 0) };
  if (/SELECT COALESCE\(MAX\(id\), 0\) AS id FROM usage_ledger/.test(q)) return { id: db.ledger.filter((r) => r.user_id === params[0]).reduce((m, r) => Math.max(m, r.id), 0) };
  if (/FROM credit_usage_history WHERE user_id = \$1 AND id > \$2/.test(q)) {
    const rows = db.creditHistory.filter((r) => r.user_id === params[0] && r.id > params[1] && r.action_type === 'resume_ai_generate' && r.credits_used > 0);
    return { n: rows.length, cost: rows.reduce((m, r) => Math.max(m, r.credits_used), 0) };
  }
  if (/FROM usage_ledger WHERE user_id = \$1 AND id > \$2/.test(q)) {
    return { n: db.ledger.filter((r) => r.user_id === params[0] && r.id > params[1] && r.kind === 'resume' && r.source === 'credits').length };
  }
  // promoteServedDoc: is there a newer row the chip lookup would pick?
  if (/^SELECT id FROM user_employer_documents WHERE user_id = \$1 AND kind = 'resume' AND environment = \$2 AND job_url = \$3/.test(q)) {
    const [uid, env, url, none, id, at, key, empId] = params;
    db.promoteChecks = (db.promoteChecks || 0) + 1;
    return db.docs.find((d) => d.user_id === uid && d.kind === 'resume' && d.environment === env && d.job_url === url
      && d.employer_key !== none && d.id !== id && d.updated_at > at && (d.employer_key === key || (empId && d.employer_id === empId))) || null;
  }
  if (/^SELECT id FROM download_passes WHERE user_id = \$1 AND environment = \$2 AND resume_generated_at IS NULL/.test(q)) {
    const [uid, env, none] = params;
    return db.passes.find((p) => p.user_id === uid && p.environment === env && !p.resume_generated_at && (!p.bound_at || p.employer_key === none)) || null;
  }
  // the served-doc touch / pre-render read
  if (/^UPDATE user_employer_documents SET updated_at = NOW\(\) WHERE id = \$1 AND user_id = \$2/.test(q)) {
    const d = db.docs.find((x) => x.id === params[0] && x.user_id === params[1]);
    if (d) d.updated_at = new Date(Math.max(Date.now(), ...db.docs.map((x) => x.updated_at.getTime())) + 1);   // NOW(), later than every row
    return null;
  }
  if (/^SELECT updated_at FROM user_employer_documents WHERE id = \$1 AND user_id = \$2/.test(q)) {
    const d = db.docs.find((x) => x.id === params[0] && x.user_id === params[1]);
    return d ? { updated_at: d.updated_at } : null;
  }
  // ⚠️ THE UNDO (giveBackDocCharges). A build that charged and then could not deliver gives back what it
  // took — by the ids its OWN claim and consume returned, never "the newest row". Applied here, so the
  // tests can assert the pass is spendable again and the plan unit really came back.
  if (/^UPDATE download_passes SET resume_generated_at = NULL WHERE id = \$1 AND user_id = \$2/.test(q)) {
    const row = db.passes.find((p) => p.id === params[0] && p.user_id === params[1]);
    if (row) row.resume_generated_at = null;
    return row ? { id: row.id } : null;
  }
  if (/^DELETE FROM usage_ledger WHERE id = \$1 AND user_id = \$2/.test(q)) {
    const i = db.ledger.findIndex((r) => r.id === params[0] && r.user_id === params[1]);
    if (i >= 0) db.ledger.splice(i, 1);
    return null;
  }
  // download_passes (copied from test-single-purchase-flow.js)
  const takeable = (p, uid, env) => p.user_id === uid && p.environment === env && (!p.bound_at || p.employer_key === '(none)');
  if (/SELECT id, employer_name, employer_key FROM download_passes WHERE user_id = \$1 AND employer_key = \$2/.test(q)) {
    const [uid, key, env] = params;
    return db.passes.find((p) => p.user_id === uid && p.employer_key === key && p.environment === env && p.bound_at) || null;
  }
  if (/SELECT id, employer_name, employer_key FROM download_passes WHERE user_id = \$1 AND environment = \$2 AND bound_at IS NOT NULL/.test(q)) {
    const [uid, env, none] = params;
    return db.passes.filter((p) => p.user_id === uid && p.environment === env && p.bound_at && p.employer_key !== none);
  }
  if (/^SELECT id FROM download_passes WHERE id = \$1 AND \w+ IS NULL/.test(q)) {
    const col = q.match(/AND (\w+) IS NULL/)[1];
    const row = db.passes.find((p) => p.id === params[0]);
    return row && !row[col] ? { id: row.id } : null;
  }
  if (/^UPDATE download_passes SET \w+ = NOW\(\) WHERE id = \( SELECT id FROM download_passes WHERE id = \$1/.test(q)) {
    const col = q.match(/SET (\w+) = NOW/)[1];
    const row = db.passes.find((p) => p.id === params[0]);
    if (!row || row[col]) return null;
    row[col] = Date.now();
    return { id: row.id };
  }
  if (/^UPDATE download_passes SET \w+ = NOW\(\), employer_key = \$3/.test(q)) {
    const col = q.match(/SET (\w+) = NOW/)[1];
    const [uid, env, key, name] = params;
    const row = db.passes.filter((p) => takeable(p, uid, env) && !p[col])[0];
    if (!row) return null;
    row[col] = Date.now(); row.employer_key = key; row.employer_name = name; row.bound_at = Date.now();
    return { id: row.id };
  }
  if (/^UPDATE download_passes SET employer_key = \$3, employer_name = \$4, bound_at = NOW\(\)/.test(q)) {
    const col = (q.match(/AND (\w+) IS NULL/) || [])[1];
    const [uid, env, key, name] = params;
    const row = db.passes.filter((p) => takeable(p, uid, env) && (!col || !p[col]))[0];
    if (!row) return null;
    row.employer_key = key; row.employer_name = name; row.bound_at = Date.now();
    return { id: row.id };
  }
  if (/^UPDATE download_passes SET employer_key = \$2, employer_name = \$3, bound_at = NOW\(\)/.test(q)) {
    const [uid, key, name, env] = params;
    const row = db.passes.filter((p) => takeable(p, uid, env))[0];
    if (!row) return null;
    row.employer_key = key; row.employer_name = name; row.bound_at = Date.now();
    return { id: row.id };
  }
  if (/SELECT COUNT\(\*\)::int AS n FROM download_passes/.test(q)) {
    const [uid, env] = params;
    return { n: db.passes.filter((p) => takeable(p, uid, env)).length };
  }
  return null;
}
const dbPath = require.resolve(path.join(ROOT, 'db-config.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  get: dbGet,
  query: async (sql, params) => { const r = await dbGet(sql, params); return Array.isArray(r) ? r : []; },
  run: async (sql, params) => { await dbGet(sql, params); return {}; },
  withTransaction: async (fn) => fn({ get: dbGet, run: async () => ({}) }), isUniqueViolation: () => false, getDbType: () => 'postgres',
} };

const stub = (rel, exports) => {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

// ── entitlements: configurable plan answers ──────────────────────────────────────────────────────
const ent = {
  sub: null,
  gateSeq: [],                         // answers popped per canConsumeMany call; falls back to `gate`
  gate: { allowed: true, via: 'plan', remaining: 5 },
  canCalls: 0,
  consumeVia: 'plan',                  // what consumeOnSuccess reports
  deductOnCredits: true,               // does the credits lane really deduct (history row)?
  consumed: [],
};
stub('server/services/entitlements.js', {
  activeSubscription: async () => ent.sub,
  canConsumeMany: async () => { ent.canCalls++; return ent.gateSeq.length ? ent.gateSeq.shift() : ent.gate; },
  // ⚠️ THE REAL SHAPE (contract 1): { via, charge, ledgerId }. `charge` is chargeCredits' own answer on
  // the credits lane and null on plan/trial; `ledgerId` is the usage_ledger row this call inserted.
  // The lane decides "was this build paid for?" from THIS request's own answers — a history-window read
  // could see ANOTHER build's deduction and throw away a resume the user had really paid for.
  consumeOnSuccess: async (u, kind, detail) => {
    ent.consumed.push({ u, kind, detail, via: ent.consumeVia });
    let charge = null;
    if (ent.consumeVia === 'credits') {
      charge = ent.deductOnCredits ? { charged: true, cost: 2, remaining: 8 } : { charged: false, cost: 2, insufficient: true, remaining: 0 };
      if (ent.deductOnCredits) db.creditHistory.push({ id: ++db.historyMax, user_id: u, action_type: 'resume_ai_generate', credits_used: 2 });
    }
    let ledgerId = null;
    // 'none' (2026-09-13): nothing left that may pay — the real consumeOnSuccess writes no row for it.
    if (ent.consumeVia !== 'error' && ent.consumeVia !== 'none') {
      ledgerId = ++db.ledgerMax;
      db.ledger.push({ id: ledgerId, user_id: u, kind, source: ent.consumeVia === 'plan' ? 'plan' : ent.consumeVia });
    }
    return { via: ent.consumeVia, charge, ledgerId };
  },
  usageSnapshot: async () => ({}),
} );

// ── the AI ───────────────────────────────────────────────────────────────────────────────────────
const RESUME = (over = {}) => ({
  personal_info: { full_name: '', email: '', phone: '', location: '', title: 'Backend Engineer', linkedin_url: '', portfolio_url: '', nationality: '', date_of_birth: '' },
  summary: 'Backend engineer with **8 years** building payment systems.\n• Built ledgers\n• Scaled APIs\n• Led migrations',
  experience: [{ company: 'PayCo', role: 'Senior Engineer', location: 'Pune', start_date: 'January 2018', end_date: 'Present', highlights: ['Built the ledger service', 'Scaled the payments API'] }],
  education: [{ institution: 'COEP', degree: 'B.Tech', field_of_study: 'CS', end_date: '2017', grade: '' }],
  projects: [], skills: { technical: ['Node.js', 'PostgreSQL'], soft: ['Mentoring'] },
  certifications: [], languages: [], achievements: [],
  design: { families: { mono: { score: 95, reason: 'Engineering look for an engineering employer' }, ats: { score: 90, reason: 'ATS-safe' } }, mode: 'onepage', tone: 'Engineering-first', headline: 'Tech Mono suits a builder culture' },
  ...over,
});
const genaiPath = require.resolve(path.join(ROOT, 'node_modules/@google/generative-ai'));
require.cache[genaiPath] = { id: genaiPath, filename: genaiPath, loaded: true, exports: {
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent: async (prompt) => {
        ai.calls++;
        ai.prompts.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
        const next = ai.queue.length ? ai.queue.shift() : (() => JSON.stringify(RESUME()));
        const text = next(prompt);
        return { response: { text: () => text, candidates: [{ finishReason: 'STOP' }] } };
      } };
    }
  },
} };

stub('ai-employer-researcher.js', { researchEmployer: async (url) => { research.calls++; return { employer_name: 'Amazon', industry: 'E-commerce and cloud computing', company_size: '10,001+ employees', brand_color: '#ff9900', font_name: 'Amazon Ember', technologies: [{ name: 'AWS' }], clients: [], recent_activity: [], key_contacts: [{ name: 'Jane' }] }; } });
stub('server/services/resumeScorer.js', {
  narrativeFor: async () => ({ text: BASE_TEXT, source: 'builder' }),
  BASE_SNAPSHOT_FP: 'base-resume-before-tailoring:v1',
});
stub('server/services/jobService.js', {
  updateJobProgress: async () => {}, updateJobPartialResult: async (id, r) => { stages.push(r); },
  createJob: async () => 'job1', failJob: async () => {}, completeJob: async () => {},
});
stub('server/services/eventCosts.js', { getEventCost: async () => 2, refundCredits: async (u, key, charge) => { refunds.push({ u, key, charge }); } });
stub('server/services/downloadHistory.js', { record: async (u, entry) => { historyRows.push(entry); }, list: async () => ({ items: [] }) });
stub('server/utils/resumeRenderer.js', {
  renderPdf: async () => { render.pdf++; return Buffer.from('%PDF-1.4 fake'); },
  renderPreviews: async (data, opts, tpls) => { render.previews += tpls.length; return tpls.map((t) => ({ id: t.id, name: t.name, accent: t.accent, ats: t.ats || null, image: 'data:image/jpeg;base64,' + Buffer.from('JPEG:' + t.id + ':' + (data && data.personal_info && data.personal_info.title)).toString('base64'), width: 794, height: 1123 })); },
  warmPreviews: async () => {},
});
stub('server/utils/docxBuilder.js', { buildResumeDocx: async () => { render.docx++; return Buffer.from('PK fake'); } });

// employerDocs: in-memory, faithful to the contract (exact key get, upsert put, owner/env/kind getById)
const realDocs = require(path.join(ROOT, 'server/services/employerDocs.js'));   // loads against the stubbed db
const D = require(path.join(ROOT, 'server/services/downloads.js'));
const docsCtl = { putFailures: 0 };
stub('server/services/employerDocs.js', {
  fingerprint: realDocs.fingerprint,
  FP_VERSION: realDocs.FP_VERSION,
  get: async (userId, kind, employer, fp, env) => {
    const key = D.employerKeyOf(String(employer || '').trim().slice(0, 160));
    const r = db.docs.find((d) => d.user_id === userId && d.kind === kind && d.employer_key === key && d.input_fingerprint === fp && d.environment === D.envOf(env));
    return r ? { ...r, payload: JSON.parse(JSON.stringify(r.payload)) } : null;
  },
  put: async (p) => {
    if (docsCtl.putFailures > 0) { docsCtl.putFailures--; return null; }
    const key = D.employerKeyOf(String(p.employer || '').trim().slice(0, 160));
    const env = D.envOf(p.env);
    let r = db.docs.find((d) => d.user_id === p.userId && d.kind === p.kind && d.employer_key === key && d.input_fingerprint === p.fingerprint && d.environment === env);
    if (r) { Object.assign(r, { payload: JSON.parse(JSON.stringify(p.payload)), design: p.design || r.design, updated_at: new Date(), times: r.times + 1 }); return r.id; }
    r = { id: db.nextDocId++, user_id: p.userId, kind: p.kind, employer_key: key, employer_name: String(p.employer || '').trim().slice(0, 160),
      job_url: String(p.jobUrl || ''), job_title: String(p.jobTitle || ''), input_fingerprint: p.fingerprint, model: p.model,
      payload: JSON.parse(JSON.stringify(p.payload)), research: p.research, environment: env, employer_id: p.employerId || null,
      // Migration 046: the exact job the fingerprint was hashed from, so /current can re-ask the stale
      // question with the SAME job instead of whatever listing the phone still happens to hold.
      job_input: realDocs.jobInputOf(p.jobInput),
      design: p.design || null, updated_at: new Date(), created_at: new Date(), times: 1 };
    db.docs.push(r);
    return r.id;
  },
  getById: async (userId, id, env, { kind } = {}) => {
    const r = db.docs.find((d) => String(d.id) === String(id) && d.user_id === userId && d.environment === D.envOf(env) && (!kind || d.kind === kind) && d.employer_key !== '(none)');
    return r ? { ...r, payload: JSON.parse(JSON.stringify(r.payload)) } : null;
  },
});

const BASE_TEXT = 'Current title: Backend Engineer\n\nEXPERIENCE\nSenior Engineer at PayCo | Pune | January 2018 – Present\n- Built the ledger service\n- Scaled the payments API\n\nEDUCATION\nB.Tech, CS | COEP | 2017';

const RB = require(path.join(ROOT, 'server/controllers/resumeBuilderController.js'));

// ── fake express ─────────────────────────────────────────────────────────────────────────────────
const written = [];
function mkRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; if (b && b.downloadUrl) written.push(decodeURIComponent(String(b.downloadUrl).split('/').pop())); return r; };
  return r;
}
const mkReq = (body, query) => ({ user: { id: UID }, body, query: query || {}, headers: {}, ip: '1.1.1.1', __jobId: 'job-harness' });
const call = async (fn, body, query) => { const res = mkRes(); await fn(mkReq(body, query), res); return res; };

const buildBody = (over = {}) => ({
  __async: false, clientBuildId: 'cb-1', coveredOnly: true, saveTo: 'employer_doc',
  employerId: '3f2a9c1e-1111-4222-8333-444455556666', country: 'India',
  rawText: BASE_TEXT, name: 'Harness User', email: 'h@u.test', phone: '+91 1', location: 'Pune',
  includeUploadedResume: true,
  job: { company: 'Amazon', website: 'https://amazon.jobs' },
  ...over,
});
const snapshot = () => ({ ai: ai.calls, research: research.calls, consumed: ent.consumed.length, docs: db.docs.length, can: ent.canCalls, refunds: refunds.length });

(async () => {
  try { fsSync.rmSync(THUMB_DIR, { recursive: true, force: true }); } catch {}

  console.log('── S18 · bad requests are refused before anything ──');
  let s0 = snapshot();
  const noResume = await call(RB.generateAI, buildBody({ rawText: 'short' }));
  ok('short rawText → 400 no_resume', noResume.statusCode === 400 && noResume.body.reason === 'no_resume', noResume.body);
  const noCompany = await call(RB.generateAI, buildBody({ job: { company: '  ' } }));
  ok('no company → 400', noCompany.statusCode === 400, noCompany.body);
  ok('…and neither touched the AI, research, the gates or the store', JSON.stringify(snapshot()) === JSON.stringify(s0), snapshot());

  console.log('── S1 · a fresh build, covered by the plan ──');
  stages.length = 0; s0 = snapshot();
  const b1 = await call(RB.generateAI, buildBody());
  ok('200 with a numeric docId, cached:false', b1.statusCode === 200 && b1.body.success === true && b1.body.cached === false && typeof b1.body.docId === 'number', b1.body);
  ok('tailoredFor is the company', b1.body.tailoredFor === 'Amazon');
  ok('ONE AI call, ONE research call', ai.calls - s0.ai === 1 && research.calls - s0.research === 1, { ai: ai.calls - s0.ai, research: research.calls - s0.research });
  ok('ONE charge', ent.consumed.length - s0.consumed === 1, ent.consumed);
  ok('ONE stored document', db.docs.length - s0.docs === 1);
  const d1 = db.docs.find((d) => d.id === b1.body.docId);
  ok('the stored payload has no design block', d1 && !('design' in d1.payload), d1 && Object.keys(d1.payload));
  ok('…carries the contact details the build was sent', d1 && d1.payload.personal_info.full_name === 'Harness User' && d1.payload.personal_info.email === 'h@u.test');
  ok('the design ranks EVERY template id exactly once', d1 && d1.design && d1.design.ranked.length === require(path.join(ROOT, 'server/utils/resumeTemplates')).TEMPLATE_IDS.length && new Set(d1.design.ranked.map((r) => r.id)).size === d1.design.ranked.length, d1 && d1.design && d1.design.ranked.length);
  ok('…sorted by integer score desc', d1 && d1.design.ranked.every((r, i, a) => Number.isInteger(r.score) && (i === 0 || a[i - 1].score >= r.score)));
  ok('…the AI-favoured family leads (mono)', d1 && /^mono/.test(d1.design.ranked[0].id), d1 && d1.design.ranked.slice(0, 3));
  ok('…mode from the AI, brand colour from the research', d1 && d1.design.mode === 'onepage' && d1.design.brandColor === '#ff9900', d1 && d1.design);
  ok('employer id stored, research stored without key_contacts', d1 && d1.employer_id === '3f2a9c1e-1111-4222-8333-444455556666' && d1.research && !('key_contacts' in d1.research) && !('keyContacts' in d1.research), d1 && d1.research);
  ok('⚠️ user_resumes was never read or written', db.userResumesTouched.length === 0, db.userResumesTouched);
  const order = stages.map((s) => s.stage);
  ok('stages in order: reading → researching → writing → designing → saving → pages', JSON.stringify(order) === JSON.stringify(['reading', 'researching', 'writing', 'designing', 'saving', 'pages']), order);
  ok('stage labels name the company', stages.find((s) => s.stage === 'researching').label === 'Researching Amazon' && stages.find((s) => s.stage === 'writing').label === 'Rewriting your resume for Amazon');
  ok('pcts ascend (16 / 38 / 86 / 92 / 96)', JSON.stringify(stages.map((s) => s.pct)) === JSON.stringify([8, 16, 38, 86, 92, 96]), stages.map((s) => s.pct));
  const thumbs1 = fsSync.existsSync(THUMB_DIR) ? fsSync.readdirSync(THUMB_DIR) : [];
  ok('the top 3 designs were pre-rendered into the dot-directory cache', thumbs1.length === 3 && thumbs1.every((n) => /^[0-9a-f]{64}\.jpg$/.test(n)), thumbs1);
  const prompt1 = ai.prompts[ai.prompts.length - 1];
  ok('the prompt carries the research block and the family brief', /=== WHAT WE KNOW ABOUT Amazon/.test(prompt1) && /mono \| Tech Mono/.test(prompt1));
  ok('…and the country', /Applying in: India/.test(prompt1));
  const r1before = render.previews;
  const c0 = await call(RB.homeCards, {}, { doc: String(b1.body.docId) });
  ok('opening the carousel right after renders only the 2 of the top 5 not pre-rendered', c0.statusCode === 200 && c0.body.cards.length === 5 && render.previews - r1before === 2, { status: c0.statusCode, rendered: render.previews - r1before });

  console.log('── S3 · the gate agrees with the build ──');
  s0 = snapshot();
  const g1 = await call(RB.generationGate, { employer: 'Amazon', job: { website: 'https://amazon.jobs' }, saveTo: 'employer_doc', employerId: '3f2a9c1e-1111-4222-8333-444455556666' });
  ok('⚠️ saveTo gate → covered via cache (identical fingerprint)', g1.body.covered === true && g1.body.via === 'cache', g1.body);
  ok('…consulting no quota on the way', ent.canCalls === s0.can);
  const gB = await call(RB.generationGate, { employer: 'Amazon', job: { website: 'https://amazon.jobs' } });
  ok('the builder-lane gate does NOT promise the doc-lane document', gB.body.via !== 'cache', gB.body);
  const cur = await RB.currentResumeFingerprint(UID, { job: { company: 'Amazon', website: 'https://amazon.jobs', title: undefined, url: undefined, description: undefined }, env: mkReq({}) });
  ok('⚠️ currentResumeFingerprint === the stored fingerprint', cur === d1.input_fingerprint, { cur, stored: d1.input_fingerprint });
  const curOther = await RB.currentResumeFingerprint(UID, { job: { company: 'Amazon', website: 'https://amazon.jobs', title: 'SDE II' }, env: 'Production' });
  ok('…and a different posting title is a different fingerprint', curOther !== d1.input_fingerprint);
  const gRegen = await call(RB.generationGate, { employer: 'Nobody Inc', regenerate: true, saveTo: 'employer_doc' });
  ok('the doc-lane gate never promises a free regeneration', gRegen.body.via !== 'free', gRegen.body);

  console.log('── S2 · the same build again is a FREE hit ──');
  stages.length = 0; s0 = snapshot();
  const beforeTouch = d1.updated_at.getTime();
  const b2 = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-2' }));
  ok('200 cached:true with the SAME docId', b2.statusCode === 200 && b2.body.cached === true && b2.body.docId === b1.body.docId, b2.body);
  ok('⚠️ no AI, no research, no gate, no charge, no store', JSON.stringify(snapshot()) === JSON.stringify(s0), { before: s0, after: snapshot() });
  ok('one "cached" stage at 90', stages.length === 1 && stages[0].stage === 'cached' && stages[0].pct === 90 && stages[0].label === 'Found your Amazon resume', stages);
  ok('already the newest → updated_at NOT bumped (its thumbnails stay valid)', db.docs.find((d) => d.id === b1.body.docId).updated_at.getTime() === beforeTouch);

  console.log('── S2b · a hit on an OLDER row (the user reverted an edit) is promoted ──');
  db.docs.push({ ...db.docs.find((d) => d.id === b1.body.docId), id: db.nextDocId++, input_fingerprint: 'f'.repeat(64), updated_at: new Date(Date.now() + 60000) });
  s0 = snapshot();
  const b2b = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-2b' }));
  ok('still a free hit on the old row', b2b.body.cached === true && b2b.body.docId === b1.body.docId && JSON.stringify(snapshot()) === JSON.stringify({ ...s0 }), b2b.body);
  const injected = db.docs.find((d) => d.input_fingerprint === 'f'.repeat(64));
  ok('⚠️ …now the newest, so /current shows it', db.docs.find((d) => d.id === b1.body.docId).updated_at.getTime() > injected.updated_at.getTime(), db.docs.map((d) => [d.id, d.updated_at]));
  db.docs.splice(db.docs.findIndex((d) => d.input_fingerprint === 'f'.repeat(64)), 1);

  console.log('── S4 · coveredOnly, only credits could pay → refused BEFORE paid work ──');
  s0 = snapshot();
  ent.gate = { allowed: true, via: 'credits', remaining: 3 };
  const b4 = await call(RB.generateAI, buildBody({ job: { company: 'Nordex', website: 'https://nordex-online.com' } }));
  ok('402 quota_exhausted', b4.statusCode === 402 && b4.body.reason === 'quota_exhausted', b4.body);
  ok('⚠️ no research, no AI, no charge, no store', ai.calls === s0.ai && research.calls === s0.research && ent.consumed.length === s0.consumed && db.docs.length === s0.docs, snapshot());
  const g4 = await call(RB.generationGate, { employer: 'Nordex', job: { website: 'https://nordex-online.com' }, saveTo: 'employer_doc' });
  ok('the gate says credits with a price (the app asks first)', g4.body.covered === false && g4.body.via === 'credits' && g4.body.credits === 2, g4.body);

  console.log('── S5 · the user CONFIRMED credits, and the deduction is verified ──');
  s0 = snapshot();
  ent.consumeVia = 'credits'; ent.deductOnCredits = true;
  const b5 = await call(RB.generateAI, buildBody({ coveredOnly: false, job: { company: 'Nordex', website: 'https://nordex-online.com' } }));
  ok('200 stored', b5.statusCode === 200 && b5.body.cached === false && db.docs.length === s0.docs + 1, b5.body);
  ok('charged once, nothing refunded', ent.consumed.length === s0.consumed + 1 && refunds.length === s0.refunds);

  console.log('── S6 · credits attempted but NOT deducted → nothing stored ──');
  s0 = snapshot();
  ent.deductOnCredits = false;
  const b6 = await call(RB.generateAI, buildBody({ coveredOnly: false, job: { company: 'Siemens', website: 'https://siemens.com' } }));
  ok('402 quota_exhausted', b6.statusCode === 402 && b6.body.reason === 'quota_exhausted', b6.body);
  ok('⚠️ NOT stored (an unpaid document would be a permanent free hit)', db.docs.length === s0.docs);
  ent.deductOnCredits = true;

  console.log('── S7 · coveredOnly: the plan covered at the gate, but not at payment ──');
  s0 = snapshot();
  ent.consumeVia = 'plan';
  ent.gateSeq = [{ allowed: true, via: 'plan', remaining: 1 }, { allowed: true, via: 'credits', remaining: 1 }];
  const b7 = await call(RB.generateAI, buildBody({ job: { company: 'Airbus', website: 'https://airbus.com' } }));
  ok('402 "lost its cover"', b7.statusCode === 402 && b7.body.reason === 'quota_exhausted' && /used up while/.test(b7.body.error), b7.body);
  ok('⚠️ nothing charged, nothing stored', ent.consumed.length === s0.consumed && db.docs.length === s0.docs);
  ent.gateSeq = []; ent.gate = { allowed: true, via: 'plan', remaining: 5 };

  console.log('── S8 · coveredOnly: consumeOnSuccess slipped into credits anyway → refunded ──');
  s0 = snapshot();
  ent.consumeVia = 'credits'; ent.deductOnCredits = true;
  const b8 = await call(RB.generateAI, buildBody({ job: { company: 'Bosch', website: 'https://bosch.com' } }));
  ok('402', b8.statusCode === 402 && b8.body.reason === 'quota_exhausted', b8.body);
  ok('⚠️ the deduction was refunded', refunds.length === s0.refunds + 1 && refunds[refunds.length - 1].charge.cost === 2, refunds);
  ok('…and nothing stored', db.docs.length === s0.docs);
  ent.consumeVia = 'plan';

  console.log('── S9 · placeholders → ONE corrective pass fixes them ──');
  s0 = snapshot();
  ai.queue.push(() => JSON.stringify(RESUME({ experience: [{ company: 'PayCo', role: 'Senior Engineer', start_date: '2018', end_date: 'Present', highlights: ['Reduced latency by [X%] across services', 'Grew revenue by **XX%**'] }] })));
  ai.queue.push(() => JSON.stringify(RESUME()));
  const b9 = await call(RB.generateAI, buildBody({ job: { company: 'Zalando', website: 'https://zalando.de' } }));
  ok('200 stored', b9.statusCode === 200 && !b9.body.cached, b9.body);
  ok('TWO AI calls (draft + correction)', ai.calls - s0.ai === 2, ai.calls - s0.ai);
  ok('the correction prompt names the placeholders', /CORRECTION/.test(ai.prompts[ai.prompts.length - 1]) && ai.prompts[ai.prompts.length - 1].includes('[X%]'));
  const d9 = db.docs.find((d) => d.id === b9.body.docId);
  ok('the stored document is clean', d9 && RB.findPlaceholders(d9.payload).length === 0, d9 && d9.payload.experience);

  console.log('── S10 · placeholders survive the correction → removed, never stored ──');
  s0 = snapshot();
  const dirty = () => JSON.stringify(RESUME({ summary: 'Engineer who cut costs by [X%].\n• Led [N] engineers\n• Built things', experience: [{ company: 'PayCo', role: 'Engineer', start_date: '2018', end_date: 'Present', highlights: ['Improved uptime by **[X%]** through monitoring', '[Insert key metric]', 'Saved $XM in cloud spend'] }] }));
  ai.queue.push(dirty, dirty);
  const b10 = await call(RB.generateAI, buildBody({ job: { company: 'Delivery Hero', website: 'https://deliveryhero.com' } }));
  const d10 = db.docs.find((d) => d.id === b10.body.docId);
  ok('200 stored', b10.statusCode === 200 && !!d10, b10.body);
  const strings10 = []; (function walk(v) { if (typeof v === 'string') strings10.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); })(d10 && d10.payload);
  ok('⚠️ no bracket and no bare X% / $X in the stored payload', d10 && RB.findPlaceholders(d10.payload).length === 0 && !strings10.some((t) => /\[[^\]]*\]|X%|\$X/.test(t)), strings10);
  ok('the dangling "by" went with the token', d10 && d10.payload.summary.startsWith('Engineer who cut costs.') && d10.payload.experience[0].highlights[0] === 'Improved uptime through monitoring', d10 && [d10.payload.summary, d10.payload.experience[0].highlights]);
  ok('a highlight that WAS a placeholder is dropped, not left blank', d10 && d10.payload.experience[0].highlights.length === 2, d10 && d10.payload.experience[0].highlights);

  console.log('── S11 · the employer\'s name in the summary triggers the corrective pass ──');
  s0 = snapshot();
  ai.queue.push(() => JSON.stringify(RESUME({ summary: 'Backend engineer eager to bring payments expertise to Spotify.\n• a\n• b\n• c' })));
  ai.queue.push(() => JSON.stringify(RESUME()));
  const b11 = await call(RB.generateAI, buildBody({ job: { company: 'Spotify AB', website: 'https://spotify.com' } }));
  ok('two AI calls', b11.statusCode === 200 && ai.calls - s0.ai === 2, { status: b11.statusCode, calls: ai.calls - s0.ai });
  ok('the stored summary no longer names Spotify', !/Spotify/.test(db.docs.find((d) => d.id === b11.body.docId).payload.summary));
  s0 = snapshot();
  ai.queue.push(() => JSON.stringify(RESUME({ skills: { technical: ['Amazon Web Services', 'Node.js'], soft: [] }, summary: 'Engineer fluent in **Amazon Web Services**.\n• a\n• b\n• c' })));
  const b11b = await call(RB.generateAI, buildBody({ job: { company: 'Amazon', website: 'https://amazon.jobs', title: 'SDE II' } }));
  ok('a PRODUCT name ("Amazon Web Services") is not a leak — one AI call', b11b.statusCode === 200 && ai.calls - s0.ai === 1, { calls: ai.calls - s0.ai });

  console.log('── S8b · consumeOnSuccess answers \'none\' (the last unit went to an overlapping build) → nothing stored ──');
  {
    // ⚠️ SINCE 2026-09-13 THERE IS NO CREDITS POOL TO FALL INTO. When the gate said yes but the allowance
    // was spent by the time the work finished, consumeOnSuccess answers via:'none' with no ledger row. That
    // is NOT a payment: a document stored now would be a free hit for ever after.
    s0 = snapshot();
    const hist0 = db.creditHistory.length;
    ent.consumeVia = 'none';
    const b8b = await call(RB.generateAI, buildBody({ coveredOnly: false, job: { company: 'Continental', website: 'https://continental.com' } }));
    // ⚠️ TIGHTENED 2026-09-14: the plans state (402 quota_exhausted), not a 500 "could not finish" — a Try again
    // there only meets the same empty allowance.
    ok('\'none\' is refused with 402 quota_exhausted (never a 200 with a document, never a 500)',
      b8b.statusCode === 402 && b8b.body && b8b.body.reason === 'quota_exhausted' && !b8b.body.resumeData && !b8b.body.docId, b8b.body);
    ok('⚠️ …and nothing stored, no credits moved', db.docs.length === s0.docs && refunds.length === s0.refunds
      && db.creditHistory.length === hist0, { docs: db.docs.length - s0.docs });
    ent.consumeVia = 'plan';
  }

  console.log('── S12 · a paid document that cannot be stored → 500 failed, credits refunded ──');
  s0 = snapshot();
  ent.consumeVia = 'credits'; ent.deductOnCredits = true; ent.gate = { allowed: true, via: 'credits', remaining: 3 };
  docsCtl.putFailures = 2;
  const b12 = await call(RB.generateAI, buildBody({ coveredOnly: false, job: { company: 'SAP', website: 'https://sap.com' } }));
  ok('500 reason failed', b12.statusCode === 500 && b12.body.reason === 'failed', b12.body);
  ok('⚠️ the credits were given back', refunds.length === s0.refunds + 1, refunds.slice(-1));
  docsCtl.putFailures = 1;
  s0 = snapshot();
  const b12b = await call(RB.generateAI, buildBody({ coveredOnly: false, job: { company: 'SAP', website: 'https://sap.com' } }));
  ok('one failed write is retried and stored', b12b.statusCode === 200 && db.docs.length === s0.docs + 1 && refunds.length === s0.refunds, b12b.body);
  ent.consumeVia = 'plan'; ent.gate = { allowed: true, via: 'plan', remaining: 5 };

  console.log('── S17 · a racing identical build landed during the AI minute → served free ──');
  s0 = snapshot();
  ai.queue.push(() => {
    // while "the AI runs", another device stores the identical document
    const fp = db.lastFp;
    return JSON.stringify(RESUME());
  });
  // pre-compute the fingerprint the build will use and inject a doc right before the AI returns
  const raceBody = buildBody({ job: { company: 'Adyen', website: 'https://adyen.com' } });
  const origQueue = ai.queue.pop();
  ai.queue.push((prompt) => {
    db.docs.push({ id: db.nextDocId++, user_id: UID, kind: 'resume', employer_key: 'adyen', employer_name: 'Adyen', job_url: '', job_title: '',
      input_fingerprint: '__FILL__', model: 'x', payload: RESUME(), research: null, environment: 'Production', employer_id: null, design: null, updated_at: new Date(), created_at: new Date(), times: 1 });
    return origQueue(prompt);
  });
  // the fingerprint is only known inside; resolve it the same way the gate does
  const raceFp = await RB.currentResumeFingerprint(UID, { job: raceBody.job, env: 'Production' });
  const realPush = db.docs.push.bind(db.docs);
  db.docs.push = (row) => { if (row.input_fingerprint === '__FILL__') row.input_fingerprint = raceFp; return realPush(row); };
  const b17 = await call(RB.generateAI, raceBody);
  db.docs.push = realPush;
  ok('served cached:true', b17.statusCode === 200 && b17.body.cached === true, b17.body);
  ok('⚠️ nothing charged for it', ent.consumed.length === s0.consumed, ent.consumed.slice(-1));

  console.log('── S19 · a pass holder with no quota: the pass pays ──');
  s0 = snapshot();
  db.passes.push({ id: db.nextPassId++, user_id: UID, store: 'apple', environment: 'Production', store_txn_id: 'T1', employer_key: null, employer_name: null, bound_at: null, created_at: Date.now() });
  ent.gate = { allowed: false, via: null, reason: 'quota_exhausted', message: 'no quota' };
  const g19 = await call(RB.generationGate, { employer: 'Klarna', job: { website: 'https://klarna.com' }, saveTo: 'employer_doc' });
  ok('the gate says pass', g19.body.covered === true && g19.body.via === 'pass', g19.body);
  ok('…and the dry run bound nothing', !db.passes[0].bound_at);
  const b19 = await call(RB.generateAI, buildBody({ job: { company: 'Klarna', website: 'https://klarna.com' } }));
  ok('200 stored', b19.statusCode === 200 && !b19.body.cached && db.docs.length === s0.docs + 1, b19.body);
  ok('⚠️ the pass paid: bound to klarna, resume generation stamped, no plan consumption', db.passes[0].employer_key === 'klarna' && !!db.passes[0].resume_generated_at && ent.consumed.length === s0.consumed, db.passes[0]);
  ent.gate = { allowed: true, via: 'plan', remaining: 5 };

  console.log('── S13 · home-cards?doc= ──');
  const r404 = await call(RB.homeCards, {}, { doc: '999999' });
  ok('an unknown doc → 404 doc_gone', r404.statusCode === 404 && r404.body.reason === 'doc_gone', r404.body);
  const rBad = await call(RB.homeCards, {}, { doc: 'abc' });
  ok('a malformed doc id → 404 doc_gone (never the base resume)', rBad.statusCode === 404 && rBad.body.reason === 'doc_gone', rBad.body);
  const before13 = render.previews;
  const c1 = await call(RB.homeCards, {}, { doc: String(b1.body.docId) });
  const top5 = d1.design.ranked.slice(0, 5).map((r) => r.id);
  ok('no ids → the design\'s top 5, in ranked order', c1.statusCode === 200 && JSON.stringify(c1.body.cards.map((c) => c.id)) === JSON.stringify(top5), { got: c1.body.cards && c1.body.cards.map((c) => c.id), top5 });
  ok('preferred = ranked[0], sample:false', c1.body.preferred === top5[0] && c1.body.sample === false, c1.body.preferred);
  ok('each card carries fit (the score) and reason', c1.body.cards.every((c, i) => c.fit === d1.design.ranked[i].score && 'reason' in c && c.image && c.name && c.accent && 'ats' in c), c1.body.cards.map((c) => ({ id: c.id, fit: c.fit })));
  ok('the promoted row (S2b moved updated_at) re-renders under its new key', render.previews - before13 === 5, render.previews - before13);
  const c2 = await call(RB.homeCards, {}, { doc: String(b1.body.docId) });
  ok('a second open renders nothing', render.previews - before13 === 5 && c2.body.cards.length === 5);
  const c3 = await call(RB.homeCards, {}, { doc: String(b1.body.docId), ids: 'azure,not_a_design,azure,mono' });
  ok('asked ids ∩ catalogue, de-duped, NO padding', JSON.stringify(c3.body.cards.map((c) => c.id)) === JSON.stringify(['azure', 'mono']), c3.body.cards.map((c) => c.id));
  const c4 = await call(RB.homeCards, {}, { doc: String(b1.body.docId), ids: 'nope' });
  ok('nothing valid asked → 200 with no cards (not a 500)', c4.statusCode === 200 && c4.body.cards.length === 0, c4.body);
  const names = fsSync.readdirSync(THUMB_DIR);
  ok('thumbs live under uploads/.thumb_cache/<uid>/ as 64-hex .jpg', names.length >= 5 && names.every((n) => /^[0-9a-f]{64}\.jpg$/.test(n)), names);

  console.log('── S14 · preview-templates with a docId ──');
  const p404 = await call(RB.previewTemplates, { ids: ['azure'], docId: 424242 });
  ok('an unknown doc → 404 doc_gone', p404.statusCode === 404 && p404.body.reason === 'doc_gone', p404.body);
  db.sql.length = 0;
  const p1 = await call(RB.previewTemplates, { ids: ['azure', 'mono'], docId: b1.body.docId });
  ok('200 previews for the asked ids', p1.statusCode === 200 && p1.body.previews.map((p) => p.id).join() === 'azure,mono', p1.body);
  ok('…rendered from the DOCUMENT (not user_resumes)', p1.body.previews[0] && Buffer.from(p1.body.previews[0].image.split(',')[1], 'base64').toString().includes('Backend Engineer') && !db.sql.some((q) => /user_resumes/.test(q)), db.sql);
  const pBase = await call(RB.previewTemplates, { ids: ['azure'] });
  ok('the base path now selects updated_at (a stable cache key)', pBase.statusCode === 200 && db.userResumesTouched.some((q) => /SELECT resume_data, updated_at FROM user_resumes/.test(q)), db.userResumesTouched.slice(-2));
  const beforeBase = render.previews;
  await call(RB.previewTemplates, { ids: ['azure'] });
  ok('…so a second base request is a cache hit', render.previews === beforeBase, render.previews - beforeBase);
  const beforeDoc = render.previews;
  await call(RB.previewTemplates, { ids: ['azure'], docId: b1.body.docId });
  ok('…and so is a second doc request, under its own key', render.previews === beforeDoc, render.previews - beforeDoc);

  console.log('── S15 · generate-pdf with a docId ──');
  ent.sub = { plan_key: 'pro' };      // a plan: downloads unlimited (DOWNLOADS_METERED off)
  const pdf410 = await call(RB.generatePDF, { template: 'azure', docId: 5555 });
  ok('missing doc → 410 payload_gone', pdf410.statusCode === 410 && pdf410.body.reason === 'payload_gone', pdf410.body);
  historyRows.length = 0; db.userResumesTouched.length = 0;
  const pdf1 = await call(RB.generatePDF, { template: 'mono', employer: 'Totally Different Co', docId: b1.body.docId });
  ok('200 with a download url', pdf1.statusCode === 200 && !!pdf1.body.downloadUrl, pdf1.body);
  const h1 = historyRows[historyRows.length - 1];
  ok('⚠️ billed + recorded to the DOCUMENT\'s employer, not body.employer', h1 && h1.employer === 'Amazon', h1);
  ok('mode defaulted to the design\'s (onepage)', h1 && h1.mode === 'onepage' && h1.payload.mode === 'onepage', h1);
  ok('history payload carries docId', h1 && h1.payload.docId === b1.body.docId && h1.payload.template === 'mono', h1 && h1.payload);
  ok('user_resumes untouched', db.userResumesTouched.length === 0, db.userResumesTouched);
  const pdf2 = await call(RB.generatePDF, { template: 'mono', mode: 'a4', docId: b1.body.docId });
  ok('an explicit mode wins', historyRows[historyRows.length - 1].mode === 'a4');
  ent.sub = null;
  const pdfNo = await call(RB.generatePDF, { template: 'mono', docId: b1.body.docId });
  ok('no plan, no pass → still 403 paid_required', pdfNo.statusCode === 403 && pdfNo.body.reason === 'paid_required', pdfNo.body);

  console.log('── S16 · generate-docx with a docId ──');
  ent.sub = { plan_key: 'pro' };
  const docx410 = await call(RB.generateDocx, { template: 'azure', docId: '77777' });
  ok('missing doc → 410 payload_gone', docx410.statusCode === 410 && docx410.body.reason === 'payload_gone', docx410.body);
  historyRows.length = 0;
  const docx1 = await call(RB.generateDocx, { template: 'ats', employer: 'Other', docId: b1.body.docId });
  const h2 = historyRows[historyRows.length - 1];
  ok('200', docx1.statusCode === 200 && !!docx1.body.downloadUrl, docx1.body);
  ok('⚠️ billed to the document\'s employer; docId + design mode in history', h2 && h2.employer === 'Amazon' && h2.payload.docId === b1.body.docId && h2.mode === 'onepage', h2);
  const docxBase = await call(RB.generateDocx, { template: 'ats', employer: 'Acme' });
  const h3 = historyRows[historyRows.length - 1];
  ok('the base path is unchanged (body.employer, no docId)', docxBase.statusCode === 200 && h3.employer === 'Acme' && !('docId' in h3.payload) && h3.mode === '', h3);
  ent.sub = null;

  console.log('── S20 · the build\'s INPUT and the document\'s IDENTITY are two different urls ──');
  {
    // ⚠️ job.url may be a posting link pasted on the Add sheet for an EMPLOYER chip: it is build input
    // (hashed, scraped), but the chip Home looks the document up by is the employer itself (job_url '').
    // Stored under job.url, that build became a posting document no chip ever asks for — and the chip
    // went on offering a paid build for a resume the user had already bought.
    s0 = snapshot();
    const posting = 'https://jobs.zalando.com/en/jobs/9911';
    const b20 = await call(RB.generateAI, buildBody({ docJobUrl: '', job: { company: 'Zalando', website: 'https://zalando.com', url: posting, title: 'Backend Engineer' } }));
    const d20 = db.docs.find((d) => d.id === b20.body.docId);
    ok('200, and the document is stored under the EMPLOYER (job_url \'\'), not the posting',
      b20.statusCode === 200 && d20 && d20.job_url === '', d20 && { job_url: d20.job_url });
    ok('⚠️ …while the posting still reached the build: job_input carries the exact hashed job',
      d20 && d20.job_input && d20.job_input.url === posting && d20.job_input.title === 'Backend Engineer'
      && d20.job_input.website === 'https://zalando.com', d20 && d20.job_input);
    ok('⚠️ …and /current re-hashing that stored job reproduces the SAME fingerprint (never "stale" for ever)',
      (await RB.currentResumeFingerprint(UID, { job: { company: 'Zalando', ...d20.job_input }, env: 'Production' })) === d20.input_fingerprint,
      { stored: d20 && d20.input_fingerprint });
    // An old client sends no docJobUrl at all: the old behaviour, job.url, so nothing it stored moves.
    const b20b = await call(RB.generateAI, buildBody({ job: { company: 'Bolt', website: 'https://bolt.eu', url: 'https://bolt.eu/careers/7' } }));
    const d20b = db.docs.find((d) => d.id === b20b.body.docId);
    ok('an old client with no docJobUrl still stores under job.url', d20b && d20b.job_url === 'https://bolt.eu/careers/7', d20b && d20b.job_url);
  }

  console.log('── S21 · "(none)" is no employer — refused before any work, by the build AND the gate ──');
  {
    // ⚠️ '(none)' is the BASE SNAPSHOT's key: a document stored under it is never listed and never
    // returned by getById or /current, so the user would pay for a resume nobody can ever open.
    s0 = snapshot();
    for (const company of ['(None)', '(none)', ' (NONE) ']) {
      const r = await call(RB.generateAI, buildBody({ coveredOnly: false, job: { company, website: 'https://x.test' } }));
      ok(`build refuses "${company}" → 400 no_employer`, r.statusCode === 400 && r.body.reason === 'no_employer', r.body);
    }
    const gNone = await call(RB.generationGate, { employer: '(None)', job: { website: 'https://x.test' }, saveTo: 'employer_doc' });
    ok('⚠️ the gate refuses it too, so an auto-start is never told "covered" for a build that only 400s',
      gNone.statusCode === 400 && gNone.body.reason === 'no_employer' && gNone.body.covered === false, gNone.body);
    ok('⚠️ …and none of it touched the AI, research, the gates, the store or a charge',
      JSON.stringify(snapshot()) === JSON.stringify(s0), snapshot());
  }

  console.log('── S22 · a paid build that cannot be stored gives back EVERY kind of charge ──');
  {
    // A store failure used to keep the money on the PASS and PLAN lanes (only credits were refunded),
    // so the user had paid and Try again charged a second time.
    ent.consumeVia = 'plan'; ent.gate = { allowed: true, via: 'plan', remaining: 5 };
    const ledgerBefore = db.ledger.length;
    docsCtl.putFailures = 2;
    const b22 = await call(RB.generateAI, buildBody({ job: { company: 'Monzo Bank', website: 'https://monzo.com' } }));
    ok('500 reason failed', b22.statusCode === 500 && b22.body.reason === 'failed', b22.body);
    ok('⚠️ the plan unit came back: the usage_ledger row this build inserted is gone',
      db.ledger.length === ledgerBefore, db.ledger.slice(-2));
    // The pass lane: the generation this build stamped is un-stamped, so the pass can pay again.
    ent.gate = { allowed: false, via: null, reason: 'quota_exhausted', message: 'no quota' };
    db.passes.push({ id: db.nextPassId++, user_id: UID, store: 'apple', environment: 'Production', store_txn_id: 'T2', employer_key: null, employer_name: null, bound_at: null, created_at: Date.now() });
    const thePass = db.passes[db.passes.length - 1];
    docsCtl.putFailures = 2;
    const b22b = await call(RB.generateAI, buildBody({ job: { company: 'Wolt', website: 'https://wolt.com' } }));
    ok('500 reason failed on the pass lane too', b22b.statusCode === 500 && b22b.body.reason === 'failed', b22b.body);
    ok('⚠️ the pass\'s resume generation was given back, so it can pay for the retry',
      !thePass.resume_generated_at, thePass);
    docsCtl.putFailures = 0;
    ent.gate = { allowed: true, via: 'plan', remaining: 5 };
  }

  console.log('── S23 · one payment decision at a time, and only this request\'s own answers decide it ──');
  {
    // ⚠️ canConsumeMany CHECKS AND NEVER RESERVES: two covered builds landing together both read
    // "1 unit left" and both spent it. The whole decision (re-check, claim, consume, store) is serialised.
    const lockCalls = db.sql.filter((s) => /pg_advisory_xact_lock\(hashtext\('usage:'/.test(s));
    ok('⚠️ every paid build took the per-(user, kind) usage lock', lockCalls.length > 0, lockCalls.slice(0, 2));
    const ctlSrc = fsSync.readFileSync(path.join(ROOT, 'server/controllers/resumeBuilderController.js'), 'utf8');
    ok('⚠️ …spelled exactly as the letter lane spells it, or the two lanes never serialise against each other',
      /SELECT pg_advisory_xact_lock\(hashtext\('usage:' \|\| \$1::text\), \$2::int\)/.test(ctlSrc)
      && /SELECT pg_advisory_xact_lock\(hashtext\('usage:' \|\| \$1::text\), \$2::int\)/.test(fsSync.readFileSync(path.join(ROOT, 'server/controllers/employerLetterController.js'), 'utf8')));
    // ⚠️ NEVER A HISTORY-WINDOW READ. "Did credits move since I started?" sees ANOTHER build's deduction
    // (or misses this one), and the lane threw away a resume the user had really paid for.
    const laneSrc = ctlSrc.slice(ctlSrc.indexOf('async function generateEmployerDoc'), ctlSrc.indexOf('async function generationGate'));
    ok('⚠️ the doc lane decides "charged" from consumeOnSuccess\'s own answer, never from a credits window',
      /used\.charge/.test(laneSrc) && !/await creditsDeductedSince\(/.test(laneSrc), laneSrc.match(/await creditsDeductedSince\(/g));
    // And the contract that answer comes from (contract 1) is what entitlements really returns.
    const entSrc = fsSync.readFileSync(path.join(ROOT, 'server/services/entitlements.js'), 'utf8');
    const cos = entSrc.slice(entSrc.indexOf('async function consumeOnSuccess'), entSrc.indexOf('// ── usage screen data'));
    // ⚠️ SINCE 2026-09-13 NOTHING IN IT DEDUCTS: credits no longer pay for generation, so `charge` is always
    // null and there is no credits pool to fall into. The KEY stays — the lanes read hasOwnProperty('charge')
    // as "this answer is authoritative" — and no allowance left is via:'none' with no ledger row.
    const cosCode = cos.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    ok('⚠️ consumeOnSuccess answers { via, charge, ledgerId } — charge always null, never a credits pool',
      /const charge = null;/.test(cosCode) && !/chargeCredits|getEventCost|'credits'/.test(cosCode)
      && /RETURNING id/.test(cosCode) && /return \{ via, charge, ledgerId:/.test(cosCode)
      && /return \{ via: 'none', charge, ledgerId: null \}/.test(cosCode)
      && /return \{ via: 'error', charge, ledgerId: null \}/.test(cosCode));
  }

  console.log('── S24 · home-cards tells Home whether there is a résumé to build FROM ──');
  {
    // ⚠️ `sample` ONLY SAYS "NO BUILDER ROW". A user who UPLOADED a résumé and never opened the builder
    // has no builder row, and Home keyed on sample offered them "Build your resume first" instead of
    // "Write my cover letter" — for a résumé we hold and can build from.
    const withRow = await call(RB.homeCards, {}, {});
    ok('a builder row → hasResume true, sample false', withRow.statusCode === 200 && withRow.body.hasResume === true && withRow.body.sample === false, withRow.body && { hasResume: withRow.body.hasResume, sample: withRow.body.sample });
    db.noBuilderRow = true;
    const uploadOnly = await call(RB.homeCards, {}, {});
    ok('⚠️ an UPLOAD-ONLY account → sample true, but hasResume STILL true',
      uploadOnly.statusCode === 200 && uploadOnly.body.sample === true && uploadOnly.body.hasResume === true,
      uploadOnly.body && { hasResume: uploadOnly.body.hasResume, sample: uploadOnly.body.sample });
    // ⚠️ A FAILED READ IS NOT "NO RÉSUMÉ" — it must never take the CTA away from someone who has one.
    const scorer = require(path.join(ROOT, 'server/services/resumeScorer.js'));
    const realNarr = scorer.narrativeFor;
    scorer.narrativeFor = async () => { throw new Error('parse service down'); };
    const blip = await call(RB.homeCards, {}, {});
    ok('a narrative read that throws degrades to the builder-row answer, never to a false no', blip.statusCode === 200 && blip.body.hasResume === false, blip.body && blip.body.hasResume);
    db.noBuilderRow = false;
    const blipWithRow = await call(RB.homeCards, {}, {});
    ok('…and with a builder row it never even asks', blipWithRow.body.hasResume === true, blipWithRow.body.hasResume);
    scorer.narrativeFor = realNarr;
  }

  // ── tidy ─────────────────────────────────────────────────────────────────────────────────────
  try { fsSync.rmSync(THUMB_DIR, { recursive: true, force: true }); } catch {}
  let removed = 0;
  const tempDir = path.join(ROOT, 'temp');
  for (const f of fsSync.readdirSync(tempDir)) {
    const mine = written.includes(f) || new RegExp(`^resume_prev_${UID}_`).test(f) || /^Harness_User_Resume_/.test(f);
    if (!mine) continue;
    try { if (fsSync.statSync(path.join(tempDir, f)).mtimeMs >= STARTED) { fsSync.unlinkSync(path.join(tempDir, f)); removed++; } } catch {}
  }
  console.log(`  · removed ${removed} temp files and ${THUMB_DIR}`);
  console.log(`\nemployer doc lane: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); try { fsSync.rmSync(THUMB_DIR, { recursive: true, force: true }); } catch {} process.exit(2); });
