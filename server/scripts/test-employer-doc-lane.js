// The resume DOC LANE end to end — POST /generate-ai with saveTo:'employer_doc', the generation gate, home-cards
// ?doc=, preview-templates / generate-pdf / generate-docx with a docId — driven through the REAL
// resumeBuilderController handlers against a stubbed database, a stubbed AI and a stubbed renderer.
// Every AI call, research call, charge and stored document is counted.
//   node server/scripts/test-employer-doc-lane.js
//
// Since 2026-09-14 it also covers what Home's confirm sheet reads from the gate (usage + pass — display only, never
// on a cache hit) and the employer's hiring CONVENTIONS (research.conventions): the prompt's facts and FORMATTING
// rules, personal details blanked in code, the page mode, and the stored design's aiFamilies / conventionsSummary.
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
const ai = { calls: 0, prompts: [], queue: [], temps: [] };   // queue: functions (prompt) => text; temps: generationConfig.temperature per model
const research = { calls: 0 };
// previewOpts / pdfOpts / docxOpts: the opts each render was handed — the brand a doc-mode render paints in is asserted
// from these (contract 4: EVERY doc-mode render passes design.brand; the base paths pass none).
const render = { previews: 0, pdf: 0, docx: 0, previewOpts: [], pdfOpts: null, docxOpts: null };
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
  // usageFor (contract 3): what the sheet says is left. usageCalls records every read; usageThrows makes it throw.
  usage: { kind: 'resume', pool: 'plan', planLabel: 'Plus', remaining: 12, allowance: 15, used: 3, oneTime: false },
  usageCalls: [],
  usageThrows: false,
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
  usageFor: async (u, kind) => {
    ent.usageCalls.push(kind);
    if (ent.usageThrows) throw new Error('ledger unreadable');
    return { ...ent.usage, kind };
  },
} );

// ── the AI ───────────────────────────────────────────────────────────────────────────────────────
// ⚠️ THE TITLE IS PHRASED FOR THE SECTOR (2026-09-15). The stubbed researcher always names an industry, and contract 5's
// sameness guard reads "sector known AND the title unchanged" as a generic draft that earns ONE corrective pass. The
// base résumé (BASE_TEXT) says "Current title: Backend Engineer", so a fixture answering that same title made every
// one-call scenario a two-call one. The guard itself is exercised on purpose in S28 below.
// ⚠️ THE HIGHLIGHTS ARE REPHRASED TOO (2026-09-15): the guard now counts experience highlights that are a base bullet
// near-verbatim (> 0.9 each; ≥ 60% of them = generic), and the fixture used to answer BASE_TEXT's own two bullets word
// for word — which would earn every one-call scenario a corrective pass. These two describe the same work in other words.
const RESUME = (over = {}) => ({
  personal_info: { full_name: '', email: '', phone: '', location: '', title: 'Backend Engineer — Payment Systems', linkedin_url: '', portfolio_url: '', nationality: '', date_of_birth: '' },
  summary: 'Backend engineer with **8 years** building payment systems.\n• Built ledgers\n• Scaled APIs\n• Led migrations',
  experience: [{ company: 'PayCo', role: 'Senior Engineer', location: 'Pune', start_date: 'January 2018', end_date: 'Present', highlights: ['Designed the payments ledger service for high-volume settlement', 'Scaled the checkout API for peak traffic'] }],
  education: [{ institution: 'COEP', degree: 'B.Tech', field_of_study: 'CS', end_date: '2017', grade: '' }],
  projects: [], skills: { technical: ['Node.js', 'PostgreSQL'], soft: ['Mentoring'] },
  certifications: [], languages: [], achievements: [],
  design: { families: { mono: { score: 95, reason: 'Engineering look for an engineering employer' }, ats: { score: 90, reason: 'ATS-safe' } }, mode: 'onepage', tone: 'Engineering-first', headline: 'Tech Mono suits a builder culture' },
  ...over,
});
const genaiPath = require.resolve(path.join(ROOT, 'node_modules/@google/generative-ai'));
require.cache[genaiPath] = { id: genaiPath, filename: genaiPath, loaded: true, exports: {
  GoogleGenerativeAI: class {
    getGenerativeModel(cfg) {
      ai.temps.push(cfg && cfg.generationConfig ? cfg.generationConfig.temperature : null);
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

// research.industry: what the researcher names as the sector (null = it names none — the sameness guard then has
// nothing to phrase a title for, S28).
research.industry = 'E-commerce and cloud computing';
stub('ai-employer-researcher.js', { researchEmployer: async (url) => { research.calls++; return { employer_name: 'Amazon', industry: research.industry, company_size: '10,001+ employees', brand_color: '#ff9900', font_name: 'Amazon Ember', technologies: [{ name: 'AWS' }], clients: [], recent_activity: [], key_contacts: [{ name: 'Jane' }] }; } });
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
// ⚠️ A REAL JPEG (2026-09-15). The shared page cache stores the renderer's 794-px page and DERIVES Home's 480-px card
// from it with sharp, so the stub's bytes must be an image sharp can read: one 794×1123 page, built once, with the old
// 'JPEG:<id>:<title>' tag carried in a COM segment right after SOI — the "rendered from the DOCUMENT" pins still read the
// title out of the bytes, and jpegSizeOf (the size of a cache hit) still finds the frame header behind it.
const sharp = require(path.join(ROOT, 'node_modules/sharp'));
let pageJpeg = null;
const pageBytesFor = async (tag) => {
  if (!pageJpeg) pageJpeg = await sharp({ create: { width: 794, height: 1123, channels: 3, background: '#dfe6ee' } }).jpeg({ quality: 30 }).toBuffer();
  const com = Buffer.from(tag, 'utf8');
  const seg = Buffer.concat([Buffer.from([0xff, 0xfe, (com.length + 2) >> 8, (com.length + 2) & 0xff]), com]);
  return Buffer.concat([pageJpeg.subarray(0, 2), seg, pageJpeg.subarray(2)]);
};
stub('server/utils/resumeRenderer.js', {
  renderPdf: async (id, data, opts) => { render.pdf++; render.pdfOpts = opts || {}; return Buffer.from('%PDF-1.4 fake'); },
  renderPreviews: async (data, opts, tpls) => {
    render.previews += tpls.length; render.previewOpts.push({ opts: opts || {}, ids: tpls.map((t) => t.id) });
    const out = [];
    for (const t of tpls) out.push({ id: t.id, name: t.name, accent: t.accent, ats: t.ats || null, image: 'data:image/jpeg;base64,' + (await pageBytesFor('JPEG:' + t.id + ':' + (data && data.personal_info && data.personal_info.title))).toString('base64'), width: 794, height: 1123 });
    return out;
  },
  warmPreviews: async () => {},
});
stub('server/utils/docxBuilder.js', { buildResumeDocx: async (data, opts) => { render.docx++; render.docxOpts = opts || {}; return Buffer.from('PK fake'); } });

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

// ⚠️ THE CONVENTIONS CALL (employerResearch.researchConventions) is a grounded Gemini call of its own. Unstubbed it
// would go through the @google/generative-ai stub above, count as a SECOND resume AI call and eat the resume's
// queued answers. It is looked up through module.exports on every use, so it is replaced here: conv.answer is the
// conventions the "search" found (null = answered, nothing usable), and every call is counted per domain.
const conv = { calls: 0, domains: [], answer: null };
const ER = require(path.join(ROOT, 'server/services/employerResearch.js'));
ER.researchConventions = async (domain) => {
  conv.calls++; conv.domains.push(domain);
  return { answered: true, conventions: conv.answer ? ER.sanitiseConventions(conv.answer) : null };
};
// ⚠️ THE WEBSITE READ (employerResearch.researchBrand → brandExtract.extractBrand) is a REAL network read of the employer's
// homepage, bounded at 8 s, and googleFontCheck a real Google Fonts request. Unstubbed, this suite read ~12 real domains
// (abb.com, monzo.com, wolt.com, …) and spent ~35 s on the wire — and a page that happened to answer would have coloured
// the assertions. Both are looked up through module.exports on every use, so they are replaced here: brandSite.answer is
// what "the website" gave (null = nothing usable; a function is asked per domain), brandSite.google the Fonts yes/no,
// and every read is counted per domain.
const brandSite = { calls: 0, domains: [], answer: null, google: false };
ER.researchBrand = async (domain) => { brandSite.calls++; brandSite.domains.push(domain); return typeof brandSite.answer === 'function' ? brandSite.answer(domain) : brandSite.answer; };
ER.googleFontCheck = async () => brandSite.google;

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
  // ⚠️ 2026-09-15: the doc lane samples at 0.55 (at the builder's 0.4 the Deutsche Bahn rewrite kept the base's opening and
  // bullets word for word); the builder lane's own 0.4 is pinned in code in S28.
  ok('⚠️ the doc lane asked the model at temperature 0.55', ai.temps.length >= 1 && ai.temps[ai.temps.length - 1] === 0.55, ai.temps.slice(-2));
  ok('ONE charge', ent.consumed.length - s0.consumed === 1, ent.consumed);
  ok('ONE stored document', db.docs.length - s0.docs === 1);
  const d1 = db.docs.find((d) => d.id === b1.body.docId);
  ok('the stored payload has no design block', d1 && !('design' in d1.payload), d1 && Object.keys(d1.payload));
  ok('…carries the contact details the build was sent', d1 && d1.payload.personal_info.full_name === 'Harness User' && d1.payload.personal_info.email === 'h@u.test');
  ok('the design ranks EVERY template id exactly once', d1 && d1.design && d1.design.ranked.length === require(path.join(ROOT, 'server/utils/resumeTemplates')).TEMPLATE_IDS.length && new Set(d1.design.ranked.map((r) => r.id)).size === d1.design.ranked.length, d1 && d1.design && d1.design.ranked.length);
  // ⚠️ RETARGETED 2026-09-15: a resume `ranked` is FAMILY-FIRST (designFit.familyFirst) — one card per family in family-score
  // order, then the variants — not "sorted desc over the whole list" (prod showed three germany variants as the top three).
  const FAM_COUNT = require(path.join(ROOT, 'server/utils/resumeTemplates')).FAMILIES.length;
  const famOf1 = (id) => (require(path.join(ROOT, 'server/utils/resumeTemplates')).TEMPLATES.find((t) => t.id === id) || {}).family || id;
  ok('…integer scores; the first 15 cards are 15 DIFFERENT families, each run sorted desc (family-first)',
    d1 && d1.design.ranked.every((r) => Number.isInteger(r.score))
    && new Set(d1.design.ranked.slice(0, FAM_COUNT).map((r) => famOf1(r.id))).size === FAM_COUNT
    && d1.design.ranked.slice(0, FAM_COUNT).every((r, i, a) => i === 0 || a[i - 1].score >= r.score)
    && d1.design.ranked.slice(FAM_COUNT).every((r, i, a) => i === 0 || a[i - 1].score >= r.score), d1 && d1.design.ranked.slice(0, 16).map((r) => `${r.id}:${r.score}`));
  ok('…the AI-favoured family leads (mono)', d1 && /^mono/.test(d1.design.ranked[0].id), d1 && d1.design.ranked.slice(0, 3));
  ok('…mode from the AI, brand colour from the research', d1 && d1.design.mode === 'onepage' && d1.design.brandColor === '#ff9900', d1 && d1.design);
  ok('employer id stored, research stored without key_contacts', d1 && d1.employer_id === '3f2a9c1e-1111-4222-8333-444455556666' && d1.research && !('key_contacts' in d1.research) && !('keyContacts' in d1.research), d1 && d1.research);
  ok('⚠️ user_resumes was never read or written', db.userResumesTouched.length === 0, db.userResumesTouched);
  const order = stages.map((s) => s.stage);
  ok('stages in order: reading → researching → writing → designing → saving → pages', JSON.stringify(order) === JSON.stringify(['reading', 'researching', 'writing', 'designing', 'saving', 'pages']), order);
  ok('stage labels name the company', stages.find((s) => s.stage === 'researching').label === 'Researching Amazon' && stages.find((s) => s.stage === 'writing').label === 'Rewriting your resume for Amazon');
  ok('pcts ascend (16 / 38 / 86 / 92 / 96)', JSON.stringify(stages.map((s) => s.pct)) === JSON.stringify([8, 16, 38, 86, 92, 96]), stages.map((s) => s.pct));
  const thumbs1 = fsSync.existsSync(THUMB_DIR) ? fsSync.readdirSync(THUMB_DIR) : [];
  // ⚠️ ONE CACHE (2026-09-15): the pre-render stores the FULL 794-px PAGES (the gallery's first previews); Home's 480-px
  // cards are derived from them on the first home-cards read (below), never a second render.
  ok('the top 3 designs were pre-rendered into the dot-directory cache as full PAGES (64-hex .jpg, no card yet)', thumbs1.length === 3 && thumbs1.every((n) => /^[0-9a-f]{64}\.jpg$/.test(n)), thumbs1);
  ok('…each a real 794-px JPEG (what the gallery serves)', thumbs1.every((n) => { const b = fsSync.readFileSync(path.join(THUMB_DIR, n)); return b[0] === 0xff && b[1] === 0xd8 && b.toString('latin1').includes('Backend Engineer'); }));
  const prompt1 = ai.prompts[ai.prompts.length - 1];
  ok('the prompt carries the research block and the family brief', /=== WHAT WE KNOW ABOUT Amazon/.test(prompt1) && /mono \| Tech Mono/.test(prompt1));
  ok('…and the country', /Applying in: India/.test(prompt1));
  ok('no conventions → no HIRING CONVENTIONS facts and no FORMATTING rules in the prompt',
    !/=== HOW Amazon HIRES/.test(prompt1) && !/=== FORMATTING FOR/.test(prompt1));
  ok('the conventions were asked once, for the employer\'s domain', conv.calls === 1 && conv.domains[0] === 'amazon.jobs', conv.domains);
  // Contract 5: the prompt is WRITTEN FOR this employer — the sector in its own words, the title from the real roles,
  // the summary's first sentence as the fit, the bullets in the employer's vocabulary, and the never-invent rule again.
  ok('the prompt carries the WRITTEN FOR block, phrased for the researcher\'s sector',
    /=== WRITTEN FOR Amazon: THE TOP LINES ===/.test(prompt1) && /E-commerce and cloud computing/.test(prompt1)
    && /personal_info\.title/.test(prompt1) && /first sentence/i.test(prompt1), prompt1.slice(prompt1.indexOf('=== WRITTEN FOR'), prompt1.indexOf('=== WRITTEN FOR') + 400));
  ok('…gives the opening SHAPE with a worked example about someone else (SHAPE only), and says a word-swapped base opening is not a rewrite',
    /"<their real role> for [^"]+ — <the two or three real strengths of theirs that matter most here>"/.test(prompt1)
    && /Data Engineer for healthcare providers — clinical-data pipelines, HL7 integrations and audit-ready reporting/.test(prompt1)
    && /SHAPE only/.test(prompt1) && /with a word or two swapped is not a rewrite/.test(prompt1), prompt1.slice(prompt1.indexOf('summary, first sentence'), prompt1.indexOf('summary, first sentence') + 300));
  // Contract 2/4: the website gave nothing (brandSite.answer null), so the researcher's colour and font stand in — the
  // font NOT a Google font (the check said no), so the renderer will leave the design's own face.
  ok('the website read was asked ONCE, for the employer\'s domain, beside the researcher and the conventions',
    brandSite.calls === 1 && brandSite.domains[0] === 'amazon.jobs', brandSite.domains);
  ok('⚠️ design.brand is stored: the researcher\'s colour as the accent, its font marked google:false',
    d1 && d1.design && JSON.stringify(d1.design.brand) === JSON.stringify({ accent: '#ff9900', font: { family: 'Amazon Ember', google: false } }), d1 && d1.design && d1.design.brand);
  ok('…and the pre-rendered thumbs were painted with THAT brand (the files home-cards reads back)',
    render.previewOpts.length >= 1 && render.previewOpts.slice(-1).every((p) => JSON.stringify(p.opts.brand) === JSON.stringify(d1.design.brand)), render.previewOpts.slice(-1).map((p) => p.opts.brand));
  const r1before = render.previews;
  const c0 = await call(RB.homeCards, {}, { doc: String(b1.body.docId) });
  ok('opening the carousel right after renders only the 2 of the top 5 not pre-rendered', c0.statusCode === 200 && c0.body.cards.length === 5 && render.previews - r1before === 2, { status: c0.statusCode, rendered: render.previews - r1before });
  const files2 = fsSync.readdirSync(THUMB_DIR);
  const cards2 = files2.filter((n) => /\.w480\.jpg$/.test(n));
  ok('⚠️ Home\'s 5 cards are DERIVED .w480.jpg files, each beside its page — 5 pages + 5 cards, nothing else',
    cards2.length === 5 && files2.length === 10 && cards2.every((c) => files2.includes(c.replace('.w480', ''))) && files2.every((n) => /^[0-9a-f]{64}(?:\.w480)?\.jpg$/.test(n)), files2);
  const cardMeta0 = await sharp(Buffer.from(c0.body.cards[0].image.split(',')[1], 'base64')).metadata();
  ok('…and the card served is the 480-px JPEG (sharp-derived), not the page', cardMeta0.width === 480 && cardMeta0.format === 'jpeg', cardMeta0);

  console.log('── S3 · the gate agrees with the build ──');
  s0 = snapshot();
  const g1 = await call(RB.generationGate, { employer: 'Amazon', job: { website: 'https://amazon.jobs' }, saveTo: 'employer_doc', employerId: '3f2a9c1e-1111-4222-8333-444455556666' });
  ok('⚠️ saveTo gate → covered via cache (identical fingerprint)', g1.body.covered === true && g1.body.via === 'cache', g1.body);
  ok('…consulting no quota on the way', ent.canCalls === s0.can);
  ok('⚠️ a cache hit carries usage:null, pass:null (no sheet; a free path reads no billing)',
    'usage' in g1.body && g1.body.usage === null && 'pass' in g1.body && g1.body.pass === null && ent.usageCalls.length === 0, g1.body);
  const gB = await call(RB.generationGate, { employer: 'Amazon', job: { website: 'https://amazon.jobs' } });
  ok('the builder-lane gate does NOT promise the doc-lane document', gB.body.via !== 'cache', gB.body);
  ok('…and keeps its old shape: no usage / pass keys (Home\'s sheet is their only reader)', !('usage' in gB.body) && !('pass' in gB.body), gB.body);
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
  ok('⚠️ a non-cache answer carries usage (usageFor\'s own numbers, for the resume) and pass { available, forThisEmployer }',
    g4.body.usage && g4.body.usage.kind === 'resume' && g4.body.usage.remaining === 12 && g4.body.usage.allowance === 15
    && ent.usageCalls[ent.usageCalls.length - 1] === 'resume'
    && JSON.stringify(g4.body.pass) === JSON.stringify({ available: false, forThisEmployer: false }), g4.body);
  ent.usageThrows = true;
  const g4b = await call(RB.generationGate, { employer: 'Nordex', job: { website: 'https://nordex-online.com' }, saveTo: 'employer_doc' });
  ok('⚠️ an unreadable count is a sheet that says less, never a failed gate (usage:null, same covered/via)',
    g4b.statusCode === 200 && g4b.body.usage === null && g4b.body.via === g4.body.via && g4b.body.covered === g4.body.covered, g4b.body);
  ent.usageThrows = false;

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
  ok('⚠️ pass: available (an unbound pass could pay), not yet this employer\'s — and reading it bound nothing',
    g19.body.pass && g19.body.pass.available === true && g19.body.pass.forThisEmployer === false && !db.passes[0].bound_at && g19.body.usage, g19.body);
  const b19 = await call(RB.generateAI, buildBody({ job: { company: 'Klarna', website: 'https://klarna.com' } }));
  ok('200 stored', b19.statusCode === 200 && !b19.body.cached && db.docs.length === s0.docs + 1, b19.body);
  ok('⚠️ the pass paid: bound to klarna, resume generation stamped, no plan consumption', db.passes[0].employer_key === 'klarna' && !!db.passes[0].resume_generated_at && ent.consumed.length === s0.consumed, db.passes[0]);
  const g19b = await call(RB.generationGate, { employer: 'Klarna', job: { website: 'https://klarna.com', title: 'Another role' }, saveTo: 'employer_doc' });
  // ⚠️ RETARGETED 2026-09-15: this expected forThisEmployer:true on the SPENT pass. The sheet read that as "Covered by
  // your one-time pass for Klarna — nothing more to pay" and Continue then bound a SECOND pass. A pass that cannot pay for
  // what is being asked covers nothing, whoever owns it (downloads.passStateFor).
  ok('…afterwards Klarna\'s pass has spent its resume generation → the empty sheet with NO pass to lean on ({ false, false })',
    g19b.body.reason === 'quota_exhausted' && g19b.body.pass && g19b.body.pass.forThisEmployer === false && g19b.body.pass.available === false, g19b.body);
  db.passes.push({ id: db.nextPassId++, user_id: UID, store: 'apple', environment: 'Production', store_txn_id: 'T2', employer_key: null, employer_name: null, bound_at: null, created_at: Date.now() });
  const g19c = await call(RB.generationGate, { employer: 'Klarna', job: { website: 'https://klarna.com', title: 'Another role' }, saveTo: 'employer_doc' });
  ok('⚠️ …a SECOND unbound pass beside it: covered via pass, available, and NOT Klarna\'s — Continue would bind that one, which the sheet must offer, never call "nothing more to pay"',
    g19c.body.covered === true && g19c.body.via === 'pass' && g19c.body.pass && g19c.body.pass.available === true && g19c.body.pass.forThisEmployer === false, g19c.body);
  ok('…and the read bound nothing', !db.passes[1].bound_at && db.passes[1].employer_key === null, db.passes[1]);
  db.passes.pop();
  ent.gate = { allowed: true, via: 'plan', remaining: 5 };

  console.log('── S26 · ⚠️ contract C2: `expectVia` — the payer the user CONFIRMED, refused with 409 before anything binds or charges ──');
  {
    // The sheet names a payer ('plan' | 'free' | 'pass' | 'cache'); the build the user confirms sends it back. A build
    // this lane would now pay for some OTHER way is refused with 409 payer_changed — nothing bound, charged or stored —
    // and one confirmed as a free cache hit that misses is 409 cache_miss before every gate. A build that sends no
    // expectVia behaves exactly as every scenario above: the lane decides alone.
    const strip26 = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    ent.gate = { allowed: true, via: 'plan', remaining: 5 }; ent.gateSeq = []; ent.consumeVia = 'plan';
    let cb26 = 0;
    const c26 = (over = {}) => buildBody({ clientBuildId: 'cb-26-' + (++cb26), job: { company: 'Wise', website: 'https://wise.com', title: 'C2 role' }, ...over });
    s0 = snapshot();
    let b = await call(RB.generateAI, c26({ expectVia: 'cache' }));
    ok('confirmed as a saved document that is not there → 409 cache_miss', b.statusCode === 409 && b.body.reason === 'cache_miss' && b.body.success === false && !b.body.docId, b.body);
    ok('⚠️ …before every gate: no quota read, no research, no AI, no charge, nothing stored', JSON.stringify(snapshot()) === JSON.stringify(s0), { s0, now: snapshot() });

    s0 = snapshot();
    b = await call(RB.generateAI, c26({ expectVia: 'free' }));
    ok('confirmed as free while the PLAN would pay → 409 payer_changed', b.statusCode === 409 && b.body.reason === 'payer_changed' && b.body.success === false, b.body);
    ok('⚠️ …after the quota read and before anything else: no research, no AI, no charge, nothing stored',
      ent.canCalls === s0.can + 1 && ai.calls === s0.ai && research.calls === s0.research && ent.consumed.length === s0.consumed && db.docs.length === s0.docs, { s0, now: snapshot() });

    s0 = snapshot();
    b = await call(RB.generateAI, c26({ expectVia: 42 }));
    ok('⚠️ a payer word we cannot read is a confirmation we cannot honour → 409 payer_changed, never a charge on a guess',
      b.statusCode === 409 && b.body.reason === 'payer_changed' && ai.calls === s0.ai && ent.consumed.length === s0.consumed && db.docs.length === s0.docs, b.body);

    // 'pass' confirmed, but no pass exists: refused BEFORE passCoversGeneration could bind anything.
    const passes0 = JSON.stringify(db.passes);
    ent.gate = { allowed: false, via: null, reason: 'quota_exhausted', message: 'no quota' };
    s0 = snapshot();
    b = await call(RB.generateAI, c26({ expectVia: 'pass' }));
    ok('confirmed as the pass, and nothing would pay now → 409 payer_changed (not 402: "ask again", not "you are out")', b.statusCode === 409 && b.body.reason === 'payer_changed', b.body);
    ok('⚠️ …no pass bound, nothing charged, nothing stored', JSON.stringify(db.passes) === passes0 && ent.consumed.length === s0.consumed && db.docs.length === s0.docs && ai.calls === s0.ai);
    b = await call(RB.generateAI, c26({ expectVia: 'plan' }));
    ok('confirmed as the plan, and the plan is gone → 409 payer_changed, not the 402 an unconfirmed build gets', b.statusCode === 409 && b.body.reason === 'payer_changed' && db.docs.length === s0.docs, b.body);
    b = await call(RB.generateAI, c26());
    ok('…while the SAME build with no expectVia is the plain 402 quota_exhausted it always was', b.statusCode === 402 && b.body.reason === 'quota_exhausted' && db.docs.length === s0.docs, b.body);

    // 'pass' confirmed and a takeable pass is there: it binds and pays, exactly as S19 — expectVia never blocks the truth.
    db.passes.push({ id: db.nextPassId++, user_id: UID, store: 'apple', environment: 'Production', store_txn_id: 'T26', employer_key: null, employer_name: null, bound_at: null, created_at: Date.now() });
    const p26 = db.passes[db.passes.length - 1];
    s0 = snapshot();
    b = await call(RB.generateAI, c26({ expectVia: 'pass' }));
    ok('confirmed as the pass, with a takeable pass → 200, stored, the pass bound to wise and its resume generation stamped, no plan consumption',
      b.statusCode === 200 && !b.body.cached && db.docs.length === s0.docs + 1 && p26.employer_key === 'wise' && !!p26.resume_generated_at && ent.consumed.length === s0.consumed, { body: b.body, pass: p26 });
    ent.gate = { allowed: true, via: 'plan', remaining: 5 };

    // 'plan' confirmed and the plan pays: the ordinary build, with expectVia along for the ride.
    s0 = snapshot();
    b = await call(RB.generateAI, c26({ expectVia: 'plan', job: { company: 'Monzo', website: 'https://monzo.com' } }));
    ok('confirmed as the plan, and the plan pays → 200, one AI call, one plan consumption, stored',
      b.statusCode === 200 && !b.body.cached && ai.calls === s0.ai + 1 && ent.consumed.length === s0.consumed + 1 && db.docs.length === s0.docs + 1, b.body);
    s0 = snapshot();
    b = await call(RB.generateAI, c26({ expectVia: 'cache', job: { company: 'Monzo', website: 'https://monzo.com' } }));
    ok('…and confirmed as a saved document that IS there → the free hit, as always', b.statusCode === 200 && b.body.cached === true && JSON.stringify(snapshot()) === JSON.stringify(s0), b.body);

    // ⚠️ AT THE MOMENT OF PAYMENT: the gate said plan; the re-check under the lock says the FREE allowance would pay now.
    ent.gateSeq = [{ allowed: true, via: 'plan', remaining: 1 }, { allowed: true, via: 'trial', remaining: 2 }];
    s0 = snapshot(); const ledger0 = db.ledger.length;
    b = await call(RB.generateAI, c26({ expectVia: 'plan', job: { company: 'Revolut', website: 'https://revolut.com' } }));
    ok('⚠️ the plan ended mid-build and the FREE allowance would pay → 409 payer_changed after the AI, nothing consumed, nothing stored',
      b.statusCode === 409 && b.body.reason === 'payer_changed' && ai.calls === s0.ai + 1 && ent.consumed.length === s0.consumed && db.docs.length === s0.docs && db.ledger.length === ledger0, { body: b.body, ai: ai.calls - s0.ai });
    ent.gateSeq = [];

    // ⚠️ ON WHAT ACTUALLY PAID: consumeOnSuccess picked the free pool where the plan was confirmed → given back, refused.
    ent.consumeVia = 'trial';
    s0 = snapshot(); const ledger1 = db.ledger.length;
    b = await call(RB.generateAI, c26({ expectVia: 'plan', job: { company: 'N26', website: 'https://n26.com' } }));
    ok('⚠️ consumeOnSuccess paid from the free pool where the plan was confirmed → 409 payer_changed, the usage row given back by its own id, nothing stored',
      b.statusCode === 409 && b.body.reason === 'payer_changed' && db.docs.length === s0.docs && db.ledger.length === ledger1 && ent.consumed.length === s0.consumed + 1, { body: b.body, ledger: db.ledger.length - ledger1 });
    s0 = snapshot();
    b = await call(RB.generateAI, c26({ job: { company: 'N26', website: 'https://n26.com' } }));
    ok('…the same build with NO expectVia is stored on the free pool (an older app keeps today\'s behaviour)', b.statusCode === 200 && !b.body.cached && db.docs.length === s0.docs + 1 && db.ledger.length === ledger1 + 1, b.body);
    ent.consumeVia = 'plan';

    const rbSrc = strip26(fsSync.readFileSync(path.join(ROOT, 'server/controllers/resumeBuilderController.js'), 'utf8'));
    const iWould = rbSrc.indexOf('passWouldCoverResume(userId, company, req, { boundOnly })');
    const iBind = rbSrc.indexOf("passCoversGeneration(userId, 'resume', company, req, { boundOnly })");
    ok('⚠️ the confirmed payer is compared BEFORE passCoversGeneration (the reservation that BINDS), and both refusals are frozen 409s',
      iWould > 0 && iBind > iWould && /const PAYER_CHANGED = Object\.freeze\(\{\s*status: 409/.test(rbSrc) && /const CACHE_MISS = Object\.freeze\(\{\s*status: 409/.test(rbSrc), { iWould, iBind });
    ok('…one vocabulary: the lane reads expectVia through downloads.expectedPayerOf and compares through quotaPayerOf / payerWordOf (entitlements says trial, the sheet says free)',
      /const expectVia = downloads\.expectedPayerOf\(body\);/.test(rbSrc) && /downloads\.quotaPayerOf\(now\) !== expectVia/.test(rbSrc)
      && /downloads\.namesPayer\(via\) && downloads\.payerWordOf\(via\) !== expectVia/.test(rbSrc)
      && D.payerWordOf('trial') === 'free' && D.quotaPayerOf({ allowed: false, via: 'plan' }) === null && D.expectedPayerOf({ expectVia: 42 }) === 'unreadable' && D.expectedPayerOf({}) === null);
  }

  console.log('── S13 · home-cards?doc= ──');
  const r404 = await call(RB.homeCards, {}, { doc: '999999' });
  ok('an unknown doc → 404 doc_gone', r404.statusCode === 404 && r404.body.reason === 'doc_gone', r404.body);
  const rBad = await call(RB.homeCards, {}, { doc: 'abc' });
  ok('a malformed doc id → 404 doc_gone (never the base resume)', rBad.statusCode === 404 && rBad.body.reason === 'doc_gone', rBad.body);
  const before13 = render.previews;
  // ⚠️ RETARGETED 2026-09-14: home-cards shows a researched row's design RE-RANKED on read (rerankStoredResumeDesign —
  // the same answer /api/employer-docs/current gives), not the design as stored. It held only by coincidence while
  // the re-rank reproduced the build's order from the same inputs.
  const storedDesign13 = JSON.stringify(d1.design);
  const shown13 = RB.rerankStoredResumeDesign(db.docs.find((d) => d.id === b1.body.docId));
  const c1 = await call(RB.homeCards, {}, { doc: String(b1.body.docId) });
  const top5 = shown13.ranked.slice(0, 5).map((r) => r.id);
  ok('no ids → the (re-ranked) design\'s top 5, in ranked order', c1.statusCode === 200 && JSON.stringify(c1.body.cards.map((c) => c.id)) === JSON.stringify(top5), { got: c1.body.cards && c1.body.cards.map((c) => c.id), top5 });
  ok('preferred = ranked[0], sample:false', c1.body.preferred === top5[0] && c1.body.sample === false, c1.body.preferred);
  ok('each card carries fit (the score) and reason', c1.body.cards.every((c, i) => c.fit === shown13.ranked[i].score && 'reason' in c && c.image && c.name && c.accent && 'ats' in c), c1.body.cards.map((c) => ({ id: c.id, fit: c.fit })));
  ok('⚠️ the re-rank is one answer for every read (rerankStoredDesign kind resume), and is never written back',
    JSON.stringify(RB.rerankStoredDesign(db.docs.find((d) => d.id === b1.body.docId), { kind: 'resume' })) === JSON.stringify(shown13)
    && JSON.stringify(db.docs.find((d) => d.id === b1.body.docId).design) === storedDesign13);
  ok('the promoted row (S2b moved updated_at) re-renders under its new key', render.previews - before13 === 5, render.previews - before13);
  const c2 = await call(RB.homeCards, {}, { doc: String(b1.body.docId) });
  ok('a second open renders nothing', render.previews - before13 === 5 && c2.body.cards.length === 5);
  const c3 = await call(RB.homeCards, {}, { doc: String(b1.body.docId), ids: 'azure,not_a_design,azure,mono' });
  ok('asked ids ∩ catalogue, de-duped, NO padding', JSON.stringify(c3.body.cards.map((c) => c.id)) === JSON.stringify(['azure', 'mono']), c3.body.cards.map((c) => c.id));
  const c4 = await call(RB.homeCards, {}, { doc: String(b1.body.docId), ids: 'nope' });
  ok('nothing valid asked → 200 with no cards (not a 500)', c4.statusCode === 200 && c4.body.cards.length === 0, c4.body);
  const names = fsSync.readdirSync(THUMB_DIR);
  ok('the cache under uploads/.thumb_cache/<uid>/ holds 64-hex .jpg pages and their .w480.jpg cards, every card beside its page, nothing else',
    names.length >= 5 && names.every((n) => /^[0-9a-f]{64}(?:\.w480)?\.jpg$/.test(n)) && names.filter((n) => /\.w480\.jpg$/.test(n)).every((c) => names.includes(c.replace('.w480', ''))), names);

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
  // ⚠️ ONE CACHE FOR THE GALLERY AND THE CARDS (2026-09-15). Prod: the build's pre-render warmed Home's cards while the
  // gallery's FIRST preview still paid a cold render. Now the pre-rendered page IS the gallery's preview, and a page
  // the gallery rendered is Home's next card (derived, no render).
  ok('a hit answers the FULL page with its size read from the JPEG header (794 × 1123)', p1.body.previews.every((p) => p.width === 794 && p.height === 1123), p1.body.previews.map((p) => [p.id, p.width, p.height]));
  const top1 = d1.design.ranked[0].id;
  const beforeTop = render.previews;
  const pTop = await call(RB.previewTemplates, { ids: [top1], docId: b1.body.docId });
  ok('⚠️ the gallery\'s FIRST design (ranked[0], pre-rendered by the build) is a hit — no render', pTop.statusCode === 200 && pTop.body.previews.length === 1 && pTop.body.previews[0].id === top1 && render.previews === beforeTop, { top1, rendered: render.previews - beforeTop });
  // A design nobody has asked for yet (a variant: never a family card, never in S13's asked ids): the gallery renders it
  // and stores the page; Home's card for it is then derived, not rendered.
  const files0 = fsSync.readdirSync(THUMB_DIR);
  const r0 = render.previews;
  const pFresh = await call(RB.previewTemplates, { ids: ['timeline_orchid'], docId: b1.body.docId });
  const filesBefore14 = fsSync.readdirSync(THUMB_DIR);
  ok('a gallery request for an uncached design renders it ONCE and stores the full page in the shared cache', pFresh.statusCode === 200 && pFresh.body.previews.length === 1 && render.previews - r0 === 1
    && filesBefore14.length === files0.length + 1 && /^[0-9a-f]{64}\.jpg$/.test(filesBefore14.find((n) => !files0.includes(n)) || ''), { rendered: render.previews - r0, added: filesBefore14.filter((n) => !files0.includes(n)) });
  const rBefore14 = render.previews;
  const hcAz = await call(RB.homeCards, {}, { doc: String(b1.body.docId), ids: 'timeline_orchid' });
  const filesAfter14 = fsSync.readdirSync(THUMB_DIR);
  const newFiles14 = filesAfter14.filter((n) => !filesBefore14.includes(n));
  ok('⚠️ a design the GALLERY rendered is Home\'s next card with NO render: one .w480 card derived beside the stored page',
    hcAz.statusCode === 200 && hcAz.body.cards.length === 1 && hcAz.body.cards[0].id === 'timeline_orchid' && render.previews === rBefore14
    && newFiles14.length === 1 && /\.w480\.jpg$/.test(newFiles14[0]) && filesBefore14.includes(newFiles14[0].replace('.w480', '')), { rendered: render.previews - rBefore14, newFiles14 });
  const azMeta = await sharp(Buffer.from(hcAz.body.cards[0].image.split(',')[1], 'base64')).metadata();
  ok('…a 480-px JPEG derived from the 794-px page', azMeta.width === 480 && azMeta.format === 'jpeg', azMeta);
  const azBefore = render.previews;
  const hcAz2 = await call(RB.homeCards, {}, { doc: String(b1.body.docId), ids: 'timeline_orchid' });
  ok('…and the card file is read back next time (no derive, no render)', hcAz2.body.cards[0].image === hcAz.body.cards[0].image && render.previews === azBefore && fsSync.readdirSync(THUMB_DIR).length === filesAfter14.length);
  ok('the gallery path writes NO temp/ JSON for a document (the base gallery keeps temp/)', !fsSync.readdirSync(path.join(ROOT, 'temp')).some((f) => new RegExp(`^resume_prev_${UID}_.*doc`).test(f)));

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
      gNone.statusCode === 400 && gNone.body.reason === 'no_employer' && gNone.body.covered === false
      && gNone.body.usage === null && gNone.body.pass === null, gNone.body);
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

  console.log('── S25 · ⚠️ the employer\'s hiring conventions shape format and emphasis — and nothing about money ──');
  {
    ent.consumeVia = 'plan'; ent.gate = { allowed: true, via: 'plan', remaining: 5 };
    conv.answer = {
      hq_country: 'Switzerland', role_country: 'Switzerland', employer_type: 'enterprise', sector: 'Industrial automation',
      ats_vendor: 'Workday', tone: 'formal',
      cv: { photo: 'expected', length: 'one page', personal_details: 'avoid', date_format: 'MM.YYYY', format: 'ats_plain', notes: ['Swiss employers expect a concise, factual CV with dates for every role.'] },
      sources: ['https://www.abb.com/careers'],
    };
    s0 = snapshot();
    const convBefore = conv.calls;
    ai.queue.push(() => JSON.stringify(RESUME({
      // A sector-phrased title (the conventions name 'Industrial automation'): an unchanged one is the guard's business (S28).
      personal_info: { full_name: '', email: '', phone: '', location: '', title: 'Backend Engineer — Automation Platforms', linkedin_url: '', portfolio_url: '', nationality: 'Indian', date_of_birth: '1990-01-01' },
      design: { families: { exec_pro: { score: 95, reason: 'Senior look' }, ats: { score: 70 } }, mode: 'a4', tone: 'Executive', headline: 'Executive Professional suits a senior career' },
    })));
    const b25 = await call(RB.generateAI, buildBody({ country: '', job: { company: 'ABB', website: 'https://abb.com' } }));
    const d25 = db.docs.find((d) => d.id === b25.body.docId);
    ok('200 stored, ONE resume AI call, ONE conventions call, ONE charge',
      b25.statusCode === 200 && !!d25 && ai.calls - s0.ai === 1 && conv.calls - convBefore === 1 && ent.consumed.length - s0.consumed === 1,
      { status: b25.statusCode, ai: ai.calls - s0.ai, conv: conv.calls - convBefore, charged: ent.consumed.length - s0.consumed });
    const p25 = ai.prompts[ai.prompts.length - 1];
    ok('the prompt carries the HIRING CONVENTIONS facts and their never-invent rule',
      /=== HOW ABB HIRES \(web research — may be incomplete or wrong\) ===/.test(p25) && /NEVER invent anything to satisfy a convention/.test(p25) && /Workday/.test(p25), p25.slice(p25.indexOf('=== HOW'), p25.indexOf('=== HOW') + 300));
    ok('…and the FORMATTING rules: no personal details, one page without dropping an entry, dates, plain ATS text',
      /=== FORMATTING FOR ABB \(from its hiring conventions\) ===/.test(p25) && /leave personal_info\.date_of_birth and personal_info\.nationality as ""/.test(p25)
      && /Never drop an entry/.test(p25) && /as MM\.YYYY/.test(p25) && /ABB is known to screen applications with Workday/.test(p25)
      && /never add, infer or embellish a fact/.test(p25));
    // Contract 5: the detail level comes from the conventions — one page = at most 3 highlights per role and a summary of
    // at most 3 sentences; and the WRITTEN FOR block names the conventions' sector, not the researcher's industry.
    ok('…and the WRITTEN FOR block takes the conventions\' sector and the one-page detail level',
      /=== WRITTEN FOR ABB: THE TOP LINES ===/.test(p25) && /industrial automation/.test(p25) && !/e-commerce and cloud computing/.test(p25)
      && /at most 3 highlights per role/.test(p25) && /a summary of at most 3 sentences/.test(p25), p25.slice(p25.indexOf('=== WRITTEN FOR'), p25.indexOf('=== WRITTEN FOR') + 700));
    ok('⚠️ personalDetails "avoid" is ENFORCED in code: the stored payload has no date of birth or nationality',
      d25 && d25.payload.personal_info.date_of_birth === '' && d25.payload.personal_info.nationality === '', d25 && d25.payload.personal_info);
    ok('⚠️ a one-page convention decides the page mode (the AI said a4)', d25 && d25.design && d25.design.mode === 'onepage', d25 && d25.design && d25.design.mode);
    ok('the design leads with an ATS-safe single column for a Workday employer, not the AI\'s exec_pro favourite',
      d25 && d25.design && !/^exec_pro/.test(d25.design.ranked[0].id) && ['ats', 'mono', 'startup'].some((f) => d25.design.ranked[0].id.startsWith(f)), d25 && d25.design.ranked.slice(0, 4));
    ok('the stored design can be re-ranked later for free: aiFamilies + conventionsSummary (≤120)',
      d25 && d25.design.aiFamilies && typeof d25.design.aiFamilies === 'object' && d25.design.aiFamilies.exec_pro && Number.isFinite(d25.design.aiFamilies.exec_pro.score)
      && typeof d25.design.conventionsSummary === 'string' && d25.design.conventionsSummary.length > 0 && d25.design.conventionsSummary.length <= 120, d25 && d25.design && { ai: d25.design.aiFamilies, sum: d25.design.conventionsSummary });
    ok('⚠️ the headline never praises a design that does not lead', d25 && !/Executive Professional/.test(String(d25.design.headline)), d25 && d25.design.headline);
    ok('the stored research carries the conventions (so a read re-ranks from the row alone)', d25 && d25.research && d25.research.conventions && d25.research.conventions.atsVendor === 'Workday', d25 && d25.research);
    // The same inputs again: a free hit — conventions are not a fingerprint input, so they can never bill a Refresh.
    s0 = snapshot();
    const b25b = await call(RB.generateAI, buildBody({ country: '', clientBuildId: 'cb-25b', job: { company: 'ABB', website: 'https://abb.com' } }));
    ok('⚠️ the same build again is a FREE hit (no AI, no research, no charge)', b25b.body.cached === true && JSON.stringify(snapshot()) === JSON.stringify(s0), b25b.body);
    conv.answer = null;
  }

  console.log('── S27 · ⚠️ THE EMPLOYER\'S BRAND: stored on the document, and in EVERY doc-mode render (2026-09-15) ──');
  {
    // The product owner's ask: a resume that looks the same for every employer is not employer-specific. The website's
    // own colour and font (brandExtract, contract 1) win over the researcher's; the effective pair is stored as
    // design.brand (contract 4) and handed to home-cards ?doc, preview-templates docId, generate-pdf docId and
    // generate-docx docId — with the brand hashed into every thumb cache key, so a changed brand is never served in
    // yesterday's colour. The base (non-doc) paths pass no brand at all. Nothing here touches money.
    ent.consumeVia = 'plan'; ent.gate = { allowed: true, via: 'plan', remaining: 5 }; ent.gateSeq = [];
    const SITE = { primary: '#112231', secondary: '#ff4f40', font: { family: 'Space Grotesk', google: true }, from: { primary: 'theme-color', font: 'body' }, fetchedAt: new Date().toISOString() };
    const WEB_BRAND = { accent: '#112231', font: { family: 'Space Grotesk', google: true } };
    brandSite.answer = (domain) => (domain === 'brandco-test.com' ? SITE : null);
    const site0 = brandSite.calls;
    s0 = snapshot(); render.previewOpts.length = 0;
    const b27 = await call(RB.generateAI, buildBody({ job: { company: 'BrandCo', website: 'https://brandco-test.com' } }));
    const d27 = db.docs.find((d) => d.id === b27.body.docId);
    ok('200 stored, one AI call, one charge', b27.statusCode === 200 && !!d27 && ai.calls - s0.ai === 1 && ent.consumed.length - s0.consumed === 1, b27.body);
    ok('the website was read ONCE for the employer\'s domain', brandSite.calls - site0 === 1 && brandSite.domains[brandSite.domains.length - 1] === 'brandco-test.com', brandSite.domains.slice(-2));
    ok('⚠️ design.brand = the WEBSITE\'s colour and font — over the researcher\'s #ff9900 / Amazon Ember',
      d27 && d27.design && JSON.stringify(d27.design.brand) === JSON.stringify(WEB_BRAND), d27 && d27.design && d27.design.brand);
    ok('…the stored research carries the brand it came from, without the row\'s brandAt bookkeeping',
      d27 && d27.research && d27.research.brand && d27.research.brand.primary === '#112231' && d27.research.brand.font.family === 'Space Grotesk' && !('brandAt' in d27.research), d27 && d27.research && d27.research.brand);
    ok('…and the design\'s legacy brandColor is the same accent (one colour for the tint and the pages)', d27 && d27.design.brandColor === '#112231', d27 && d27.design.brandColor);
    ok('the pre-render painted the top designs with that brand', render.previewOpts.length >= 1 && render.previewOpts.every((p) => JSON.stringify(p.opts.brand) === JSON.stringify(WEB_BRAND)), render.previewOpts.map((p) => p.opts.brand));
    ok('docBrandOf reads the stored brand back as one answer; brandKeyOf is stable, case-blind and never "plain" for it',
      JSON.stringify(RB.docBrandOf(d27)) === JSON.stringify(WEB_BRAND) && RB.brandKeyOf(WEB_BRAND) === RB.brandKeyOf({ accent: '#112231', font: { family: 'SPACE GROTESK', google: true } })
      && /^[0-9a-f]{12}$/.test(RB.brandKeyOf(WEB_BRAND)) && RB.brandKeyOf(null) === 'plain' && RB.brandKeyOf({}) === 'plain'
      && RB.brandKeyOf(WEB_BRAND) !== RB.brandKeyOf({ accent: '#112231', font: null }) && RB.brandKeyOf(WEB_BRAND) !== RB.brandKeyOf({ accent: '#ff4f40', font: WEB_BRAND.font }),
      { key: RB.brandKeyOf(WEB_BRAND), read: RB.docBrandOf(d27) });
    ok('/current and GET /:id answer the same brand on the re-ranked design (rerankStoredDesign attaches it)',
      JSON.stringify(RB.rerankStoredDesign(d27, { kind: 'resume' }).brand) === JSON.stringify(WEB_BRAND) && JSON.stringify(RB.rerankStoredResumeDesign(d27).brand) === JSON.stringify(WEB_BRAND));
    // The same build again: a free hit, and no second website read.
    s0 = snapshot(); const site1 = brandSite.calls;
    const b27b = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-27b', job: { company: 'BrandCo', website: 'https://brandco-test.com' } }));
    ok('the same build again is a FREE hit with no website read', b27b.body.cached === true && JSON.stringify(snapshot()) === JSON.stringify(s0) && brandSite.calls === site1, b27b.body);

    // home-cards ?doc=: every render carries the brand; every card's accent IS the brand accent (the pages are recoloured
    // to it, so the catalogue swatch would promise a colour that never arrives); a changed brand misses the cache.
    render.previewOpts.length = 0;
    const hc = await call(RB.homeCards, {}, { doc: String(d27.id) });
    ok('home-cards ?doc: the un-pre-rendered cards are rendered WITH the brand', hc.statusCode === 200 && hc.body.cards.length === 5 && render.previewOpts.length >= 1 && render.previewOpts.every((p) => JSON.stringify(p.opts.brand) === JSON.stringify(WEB_BRAND)), render.previewOpts.map((p) => p.opts.brand));
    ok('⚠️ …and every card wears the brand accent, not the catalogue swatch', hc.body.cards.every((c) => c.accent === '#112231'), hc.body.cards.map((c) => c.accent));
    const cardsBefore = render.previews;
    await call(RB.homeCards, {}, { doc: String(d27.id) });
    ok('a second open renders nothing (cache hit under the brand key)', render.previews === cardsBefore, render.previews - cardsBefore);
    const namesBefore = new Set(fsSync.readdirSync(THUMB_DIR));
    const brandWas = d27.design.brand;
    d27.design = { ...d27.design, brand: { accent: '#00857c', font: null } };
    render.previewOpts.length = 0;
    const hc2 = await call(RB.homeCards, {}, { doc: String(d27.id) });
    const namesAfter = fsSync.readdirSync(THUMB_DIR).filter((n) => !namesBefore.has(n));
    ok('⚠️ a CHANGED brand misses the thumb cache: all 5 re-rendered in the new colour, under NEW cache names',
      hc2.statusCode === 200 && render.previewOpts.length >= 1 && render.previewOpts.every((p) => JSON.stringify(p.opts.brand) === JSON.stringify({ accent: '#00857c', font: null }))
      && hc2.body.cards.every((c) => c.accent === '#00857c') && namesAfter.filter((n) => /^[0-9a-f]{64}\.jpg$/.test(n)).length === 5 && namesAfter.filter((n) => /\.w480\.jpg$/.test(n)).length === 5,
      { rendered: render.previewOpts.map((p) => p.ids), fresh: namesAfter.length });
    d27.design = { ...d27.design, brand: brandWas };

    // preview-templates docId: the brand in the opts and in the cache key.
    render.previewOpts.length = 0;
    const pt = await call(RB.previewTemplates, { ids: ['azure', 'mono'], docId: d27.id });
    ok('preview-templates docId: rendered WITH the brand', pt.statusCode === 200 && pt.body.previews.length === 2 && render.previewOpts.length === 1 && JSON.stringify(render.previewOpts[0].opts.brand) === JSON.stringify(WEB_BRAND), render.previewOpts.map((p) => p.opts.brand));
    const ptBefore = render.previews;
    await call(RB.previewTemplates, { ids: ['azure', 'mono'], docId: d27.id });
    ok('…a second request is a cache hit', render.previews === ptBefore);
    d27.design = { ...d27.design, brand: { accent: '#00857c', font: null } };
    render.previewOpts.length = 0;
    await call(RB.previewTemplates, { ids: ['azure', 'mono'], docId: d27.id });
    ok('⚠️ …and a changed brand misses it (the brand is part of the preview key)', render.previewOpts.length === 1 && render.previewOpts[0].opts.brand.accent === '#00857c', render.previewOpts.map((p) => p.opts.brand));
    d27.design = { ...d27.design, brand: brandWas };
    render.previewOpts.length = 0;
    await call(RB.previewTemplates, { ids: ['azure'] });
    ok('the BASE preview path passes no brand', render.previewOpts.length === 0 || render.previewOpts.every((p) => p.opts.brand == null), render.previewOpts.map((p) => p.opts.brand));

    // generate-pdf / generate-docx with a docId: the brand in the opts; the base paths pass none.
    ent.sub = { plan_key: 'pro' };
    render.pdfOpts = null; render.docxOpts = null;
    const pdf27 = await call(RB.generatePDF, { template: 'azure', docId: d27.id });
    ok('generate-pdf docId: renderPdf gets opts.brand = the document\'s brand', pdf27.statusCode === 200 && render.pdfOpts && JSON.stringify(render.pdfOpts.brand) === JSON.stringify(WEB_BRAND), render.pdfOpts && render.pdfOpts.brand);
    const docx27 = await call(RB.generateDocx, { template: 'azure', docId: d27.id });
    ok('generate-docx docId: buildResumeDocx gets opts.brand = the document\'s brand', docx27.statusCode === 200 && render.docxOpts && JSON.stringify(render.docxOpts.brand) === JSON.stringify(WEB_BRAND), render.docxOpts && render.docxOpts.brand);
    render.pdfOpts = null; render.docxOpts = null;
    await call(RB.generatePDF, { template: 'azure', employer: 'Acme' });
    await call(RB.generateDocx, { template: 'ats', employer: 'Acme' });
    ok('the base pdf/docx paths pass no brand', render.pdfOpts && render.pdfOpts.brand == null && render.docxOpts && render.docxOpts.brand == null, { pdf: render.pdfOpts && render.pdfOpts.brand, docx: render.docxOpts && render.docxOpts.brand });
    ent.sub = null;

    // A document stored BEFORE brands existed: no design.brand — the research's researcher colour/font stand in, and a
    // stringified design column is read as well as an object.
    const old = { ...d27, id: 990027, design: JSON.stringify({ ...d27.design, brand: undefined }), research: { brandColor: '#0e7490', fontName: 'Inter' } };
    // ⚠️ RETARGETED 2026-09-15: a bare researcher fontName is read through brandExtract's STATIC alternative table (Inter →
    // itself, google:true; Segoe UI → Open Sans) — deterministic on every process, no memory, no network. A face the
    // table does not know stays google:false, as before.
    ok('an older document renders in its research\'s colour; its bare researcher font reads through the static table (Inter → itself, google:true)',
      JSON.stringify(RB.docBrandOf(old)) === JSON.stringify({ accent: '#0e7490', font: { family: 'Inter', google: true } }), RB.docBrandOf(old));
    ok('…a face the table does not know stays google:false (the renderer keeps the design\'s stack)',
      JSON.stringify(RB.docBrandOf({ ...old, research: { brandColor: '#0e7490', fontName: 'Amazon Ember' } })) === JSON.stringify({ accent: '#0e7490', font: { family: 'Amazon Ember', google: false } }));
    // ⚠️ PROD DOC 9 (2026-09-15): design.brand stored the site's raw "DB Neo Screen Sans Regular" google:false at build time
    // and rendered in Lato. A STORED brand is read straight off the design, never through brandOf — so the table applies
    // there too (docBrandShapeOf), and the cache key is the alternative's: one reading of one row on every path.
    const db9 = { ...d27, id: 990009, design: { ...d27.design, brand: { accent: '#EC0016', font: { family: 'DB Neo Screen Sans Regular', google: false } } } };
    ok('⚠️ a stored raw site face renders in its Google alternative (doc 9: DB Neo → Barlow) and keys the cache as Barlow',
      JSON.stringify(RB.docBrandOf(db9)) === JSON.stringify({ accent: '#ec0016', font: { family: 'Barlow', google: true } })
      && RB.brandKeyOf(db9.design.brand) === RB.brandKeyOf({ accent: '#ec0016', font: { family: 'Barlow', google: true } })
      && JSON.stringify(RB.rerankStoredResumeDesign(db9).brand) === JSON.stringify({ accent: '#ec0016', font: { family: 'Barlow', google: true } }), RB.docBrandOf(db9));
    ok('…a stored Google-hosted face keeps its exact shape (Space Grotesk stays Space Grotesk)', JSON.stringify(RB.docBrandOf(d27)) === JSON.stringify(WEB_BRAND));
    ok('…the researcher\'s invented default (#262633 / Lato) is never a brand', RB.docBrandOf({ design: null, research: { brandColor: '#262633', fontName: 'Lato' } }) === null);
    ok('docBrandOf is null-safe and shape-checked', RB.docBrandOf(null) === null && RB.docBrandOf({ design: { brand: { accent: 'red', font: { family: '' } } }, research: null }) === null);
    brandSite.answer = null;
  }

  console.log('── S28 · ⚠️ THE SAMENESS GUARD: a generic draft earns ONE corrective pass, never a third call (2026-09-15) ──');
  {
    // Contract 5: after the model answers, the summary's token-Jaccard similarity to the base summary and the title are
    // compared; summary similarity > 0.8 OR (sector known AND title unchanged) = generic → ONE corrective pass with an
    // explicit "rewrite the title and the summary opening for <sector>" instruction, the similarity logged before and
    // after. It is folded into the existing single pass (placeholders, leaks), so a build never pays for more than one
    // extra model call. The FIRST draft's design stands across the pass.
    ent.consumeVia = 'plan'; ent.gate = { allowed: true, via: 'plan', remaining: 5 }; ent.gateSeq = []; conv.answer = null;
    const logs = [];
    const realLog = console.log;
    const capture = async (fn) => { logs.length = 0; console.log = (...a) => { logs.push(a.map(String).join(' ')); }; try { return await fn(); } finally { console.log = realLog; } };

    // tokenJaccard itself.
    const base = 'Backend engineer with **8 years** building payment systems, ledgers and high-throughput APIs for fintech products. Led migrations of monolith services to event-driven microservices on AWS. Mentors engineers and owns reliability for the payments platform.';
    const moved = 'Led migrations of monolith services to event-driven microservices on AWS. Backend engineer with 8 years building payment systems, ledgers and high-throughput APIs for fintech products. Owns reliability for the payments platform and mentors engineers.';
    const rewritten = 'Payments-platform engineer suited to e-commerce and cloud computing: eight years designing ledger services, scalable checkout APIs and event-driven AWS infrastructure that keeps transactions consistent at peak volume. Reduced incident load through ownership of reliability across the platform.';
    ok('tokenJaccard: identical = 1; the base with a sentence moved > 0.9; a sector rewrite < 0.6; unrelated ≈ 0',
      RB.tokenJaccard(base, base) === 1 && RB.tokenJaccard(base, moved) > 0.9 && RB.tokenJaccard(base, rewritten) < 0.6
      && RB.tokenJaccard(base, 'Registered nurse specialising in paediatric intensive care.') < 0.05,
      { moved: RB.tokenJaccard(base, moved), rewritten: RB.tokenJaccard(base, rewritten) });
    ok('tokenJaccard: empty vs empty is 1, empty vs text 0; case, punctuation, bold and ≤3-char tokens do not count',
      RB.tokenJaccard('', '') === 1 && RB.tokenJaccard('', base) === 0 && RB.tokenJaccard(base, '') === 0
      && RB.tokenJaccard('**Payments** engineer, AWS.', 'payments ENGINEER (aws)') === 1 && RB.tokenJaccard('ledger the', 'ledger for') === 1);

    // ⚠️ THE PROD PAIR (2026-09-15). Deutsche Bahn's document changed its title, kept the base's opening ("Accomplished
    // Project Manager with 14+ years…"), scored 0.73 on the whole summary — UNDER the old 0.8 line — and its bullets were
    // the base's with a verb swapped ("Led" → "Directed"). The guard now reads four lines (docSamenessOf): the whole summary
    // at 0.6, the FIRST SENTENCE at 0.5, an unchanged title with a known sector, and ≥ 60% of the highlights a base bullet
    // near-verbatim (> 0.9 each). A draft written for the sector passes all four.
    const dbRaw = 'Current title: Project Manager\n\nSUMMARY\nAccomplished Project Manager with 14+ years of experience in software development and delivery leadership, specializing in enterprise platforms, agile transformation and stakeholder management. Proven record of delivering complex programmes on time and within budget for banking and logistics clients.\n\nEXPERIENCE\nProject Manager at Northwind Systems | Vienna | 2016 – Present\n- Led a team of 12 engineers delivering an enterprise ticketing platform for a logistics client\n- Managed a €4M budget across three concurrent software delivery streams\n- Introduced agile ceremonies that cut release cycle time from 8 weeks to 2\n\nPROJECTS\nTimetable viewer\n- Built a viewer for timetable data\n\nEDUCATION\nMSc | TU Wien | 2011';
    const dbBase = RB.baseTopLinesOf(dbRaw, null);
    ok('baseTopLinesOf reads the narrative\'s title, SUMMARY and the EXPERIENCE "- " bullets (three) — never a project\'s',
      dbBase.title === 'Project Manager' && dbBase.summary.startsWith('Accomplished Project Manager') && dbBase.highlights.length === 3 && dbBase.highlights[0].startsWith('Led a team'), dbBase);
    const prodDraft = {
      personal_info: { title: 'Project Manager — Enterprise Software Delivery (Rail & Logistics)' },
      summary: 'Accomplished Project Manager with 14+ years of experience in software development and delivery leadership, specializing in enterprise platforms, agile transformation and stakeholder management for rail and logistics operators. Trusted by programme sponsors to bring multi-vendor rail platforms into service on schedule.\n• Enterprise delivery\n• Agile transformation\n• Stakeholder management',
      experience: [{ company: 'Northwind Systems', role: 'Project Manager', highlights: ['Directed a team of 12 engineers delivering an enterprise ticketing platform for a logistics client', 'Managed a €4M budget across three concurrent software delivery streams', 'Introduced agile ceremonies that cut release cycle time from 8 weeks to 2'] }],
    };
    const sProd = RB.docSamenessOf(prodDraft, dbBase, 'Rail and logistics');
    ok('⚠️ the prod pair is GENERIC: the first sentence is the base\'s (> 0.5) and 2 of 3 highlights are base bullets with a verb swapped (≥ 60%) — a rewritten title did not save it, and the whole-summary reading alone would have (0.46)',
      sProd.generic === true && sProd.openingSim > 0.5 && sProd.highlights.unchanged === 2 && sProd.highlights.total === 3 && sProd.highlights.share >= 0.6 && sProd.titleUnchanged === false && sProd.summarySim < 0.6,
      { summary: sProd.summarySim, opening: sProd.openingSim, highlights: sProd.highlights });
    ok('…openings carries both first sentences for the pass to quote back', sProd.openings.base.startsWith('Accomplished Project Manager with 14+ years') && sProd.openings.draft.startsWith('Accomplished Project Manager with 14+ years') && /operators\.$/.test(sProd.openings.draft), sProd.openings);
    ok('…and the log phrase names every reading over its line, and only those', /^summary similarity 0\.4\d, title rewritten, opening similarity 0\.8\d, 2\/3 highlights unchanged$/.test(RB.docSamenessText(sProd)), RB.docSamenessText(sProd));
    const midDraft = { personal_info: { title: 'Project Manager — Rail Delivery' }, summary: 'Delivery lead for rail and logistics operators bringing ticketing platforms into service. Proven record of delivering complex programmes on time and within budget for banking and logistics clients, with 14+ years of experience in software development and delivery leadership across enterprise platforms, agile transformation and stakeholder management.' };
    const sMid = RB.docSamenessOf(midDraft, dbBase, 'Rail and logistics');
    ok('⚠️ a whole summary between the OLD 0.8 line and the NEW 0.6 one is generic by the summary reading alone (no highlights, a new opening)',
      sMid.generic === true && sMid.summarySim > 0.6 && sMid.summarySim < 0.8 && sMid.openingSim <= 0.5 && sMid.highlights === null, { summary: sMid.summarySim, opening: sMid.openingSim, openings: sMid.openings });
    const stubOpen = RB.docSamenessOf({ summary: 'Project Manager. Accomplished Project Manager with 14+ years of experience in software development and delivery leadership.' }, dbBase, 'x');
    ok('…a stub first sentence ("Project Manager.") takes the next sentence with it, so a stub never stands in for the opening — and that opening is the base\'s',
      /^Project Manager\. Accomplished Project Manager with 14\+ years/.test(stubOpen.openings.draft) && stubOpen.openingSim > 0.5 && stubOpen.generic === true, stubOpen.openings.draft);
    const rewrittenDraft = {
      personal_info: { title: 'Project Manager — Enterprise Software Delivery (Rail & Logistics)' },
      summary: 'Project Manager for rail and logistics operators — enterprise ticketing platforms, multi-stream delivery governance and agile release management for operations that run to a timetable. Fourteen years leading software delivery, most recently for banking and logistics clients.\n• Ticketing platforms\n• Delivery governance\n• Release management',
      experience: [{ company: 'Northwind Systems', role: 'Project Manager', highlights: ['Steered a 12-engineer delivery team through the rollout of an enterprise ticketing platform for a logistics operator', 'Governed a €4M programme budget spanning three parallel software delivery streams', 'Brought release cycles down from eight weeks to two by introducing agile ceremonies across the delivery teams'] }],
    };
    const sRe = RB.docSamenessOf(rewrittenDraft, dbBase, 'Rail and logistics');
    ok('a draft written for the sector — a sector-led opening, the bullets rephrased in its language — is NOT generic on any reading',
      sRe.generic === false && sRe.summarySim < 0.6 && sRe.openingSim <= 0.5 && sRe.highlights.unchanged === 0 && sRe.titleUnchanged === false, { summary: sRe.summarySim, opening: sRe.openingSim, highlights: sRe.highlights });
    ok('…logged as "summary similarity 0.29, title rewritten" — nothing else was over its line', RB.docSamenessText(sRe) === 'summary similarity 0.29, title rewritten', RB.docSamenessText(sRe));
    const bare = { personal_info: { title: 'Project Manager' } };
    ok('null readings never count: no summary and no highlights on either side leave only the title rule (generic with a sector, not without)',
      RB.docSamenessOf(bare, dbBase, 'Rail and logistics').generic === true && RB.docSamenessOf(bare, dbBase, null).generic === false
      && RB.docSamenessOf(bare, dbBase, 'x').summarySim === null && RB.docSamenessOf(bare, dbBase, 'x').openingSim === null && RB.docSamenessOf(bare, dbBase, 'x').highlights === null
      && RB.docSamenessOf(prodDraft, { title: null, titles: [], summary: null, highlights: [] }, 'x').generic === false);
    ok('docSamenessOf / baseTopLinesOf / docSamenessText never throw on junk', (() => { try { return RB.docSamenessOf(null, null, null).generic === false && RB.baseTopLinesOf(null, '{bad json').title === null && RB.docSamenessText(null) === 'not measured'; } catch { return false; } })());

    // (a) sector known (the researcher's industry), the title unchanged → generic → the pass, logged before and after.
    s0 = snapshot(); stages.length = 0;
    ai.queue.push(() => JSON.stringify(RESUME({ personal_info: { ...RESUME().personal_info, title: 'Backend Engineer' }, design: { families: { elegant: { score: 97, reason: 'first' } }, mode: 'onepage', tone: 'x', headline: 'first' } })));
    ai.queue.push(() => JSON.stringify(RESUME({ personal_info: { ...RESUME().personal_info, title: 'Backend Engineer — Cloud Payment Platforms' }, design: { families: { compact: { score: 97, reason: 'second' } }, mode: 'a4', tone: 'y', headline: 'second' } })));
    const b28 = await capture(() => call(RB.generateAI, buildBody({ job: { company: 'Sameness Co', website: 'https://sameness-test.com' } })));
    const d28 = db.docs.find((d) => d.id === b28.body.docId);
    ok('200 stored, exactly TWO AI calls (draft + the one pass), ONE charge', b28.statusCode === 200 && !!d28 && ai.calls - s0.ai === 2 && ent.consumed.length - s0.consumed === 1, { status: b28.statusCode, ai: ai.calls - s0.ai });
    ok('…both at the doc lane\'s 0.55 (the corrective pass too)', ai.temps.slice(-2).every((t) => t === 0.55), ai.temps.slice(-2));
    const fix28 = ai.prompts[ai.prompts.length - 1];
    ok('the correction names the rule: the unchanged title, and "Rewrite the title and the summary opening for <sector>"',
      /=== ⚠️ CORRECTION/.test(fix28) && /the title is the candidate's current title, unchanged/.test(fix28)
      && /Rewrite the title and the summary opening for E-commerce and cloud computing/.test(fix28) && /Sameness Co's name stays out/.test(fix28),
      fix28.slice(fix28.indexOf('CORRECTION'), fix28.indexOf('CORRECTION') + 500));
    ok('the stored title is the corrected one', d28 && d28.payload.personal_info.title === 'Backend Engineer — Cloud Payment Platforms', d28 && d28.payload.personal_info.title);
    ok('⚠️ the FIRST draft\'s design stands across the pass (the pass corrects wording, not the employer reading)',
      d28 && d28.design && d28.design.aiFamilies && d28.design.aiFamilies.elegant && !d28.design.aiFamilies.compact && d28.design.mode === 'onepage', d28 && d28.design && { ai: d28.design.aiFamilies, mode: d28.design.mode });
    const polish = stages.find((s) => s.stage === 'polishing');
    ok('a "polishing" stage at 70, labelled for the employer when sameness is the only problem, between writing and designing',
      polish && polish.pct === 70 && polish.label === 'Sharpening it for Sameness Co'
      && stages.map((s) => s.stage).join() === 'reading,researching,writing,polishing,designing,saving,pages', stages.map((s) => [s.stage, s.pct, s.label]));
    ok('the similarity is logged BEFORE the pass (title unchanged) and AFTER it (title rewritten)',
      logs.some((l) => /employer doc for "Sameness Co" came back generic \(summary similarity n\/a, title unchanged\) — one corrective pass for E-commerce and cloud computing/.test(l))
      && logs.some((l) => /after the corrective pass: summary similarity n\/a, title rewritten$/.test(l)), logs.filter((l) => /Sameness Co/.test(l)));

    // (b) a SUMMARY in the base material, echoed back with a sentence moved → similarity > 0.8 → generic by similarity alone.
    const withSummary = BASE_TEXT.replace('\n\nEXPERIENCE', `\n\nSUMMARY\n${base}\n\nEXPERIENCE`);
    s0 = snapshot(); stages.length = 0;
    ai.queue.push(() => JSON.stringify(RESUME({ summary: `${moved}\n• Built ledgers\n• Scaled APIs\n• Led migrations` })));
    ai.queue.push(() => JSON.stringify(RESUME({ summary: `${rewritten}\n• Built ledgers\n• Scaled APIs\n• Led migrations` })));
    const b28b = await capture(() => call(RB.generateAI, buildBody({ rawText: withSummary, job: { company: 'Echo Co', website: 'https://echo-test.com' } })));
    const d28b = db.docs.find((d) => d.id === b28b.body.docId);
    ok('an echoed summary (> 0.8 similar) with a rewritten title is still generic → two AI calls, stored corrected',
      b28b.statusCode === 200 && ai.calls - s0.ai === 2 && d28b && d28b.payload.summary.startsWith('Payments-platform engineer suited to'), { ai: ai.calls - s0.ai, summary: d28b && d28b.payload.summary.slice(0, 60) });
    const fix28b = ai.prompts[ai.prompts.length - 1];
    // (the moved summary keeps every token — 8 is a ≤3-char token and drops on both sides — so it scores 1.00)
    ok('the correction quotes the similarity as a percentage, not the title', /the summary is (9\d|100)% the same as the base resume's/.test(fix28b) && !/current title, unchanged/.test(fix28b), fix28b.slice(fix28b.indexOf('CORRECTION'), fix28b.indexOf('CORRECTION') + 400));
    // ⚠️ 2026-09-15: the model cannot see its own sameness, so the pass quotes the base opening and the draft's back, demands
    // the sector-led SHAPE for the first sentence, the bullets rephrased (relevant ones first), and again: no fact added.
    ok('⚠️ the pass quotes BOTH openings back, demands the sector-led shape, the bullets rephrased, and that NO fact is added',
      /The base resume opens: "Backend engineer with 8 years building payment systems/.test(fix28b) && /your answer opens: "Led migrations of monolith services/.test(fix28b)
      && /in the shape "<real role> for E-commerce and cloud computing — <the two or three real strengths that matter here>"/.test(fix28b)
      && /rephrase the experience highlights in the language of E-commerce and cloud computing[^.]*the ones that matter to Echo Co first — a bullet with one verb swapped is not rephrased/.test(fix28b)
      && /NO fact may be added \(no skill, tool, number, client or achievement the material does not state\)/.test(fix28b), fix28b.slice(fix28b.indexOf('The base resume opens'), fix28b.indexOf('The base resume opens') + 600));
    ok('logged: similarity ≥ 0.9 before, well under 0.8 after',
      logs.some((l) => /"Echo Co" came back generic \(summary similarity (0\.9\d|1\.00), title rewritten\)/.test(l))
      && logs.some((l) => /"Echo Co" after the corrective pass: summary similarity 0\.[0-5]\d, title rewritten$/.test(l)), logs.filter((l) => /Echo Co/.test(l)));

    // (c) the pass answers still generic → delivered as written, still ONE pass, never a third call.
    s0 = snapshot();
    ai.queue.push(() => JSON.stringify(RESUME({ personal_info: { ...RESUME().personal_info, title: 'Backend Engineer' } })));
    ai.queue.push(() => JSON.stringify(RESUME({ personal_info: { ...RESUME().personal_info, title: 'Backend Engineer' } })));
    const b28c = await capture(() => call(RB.generateAI, buildBody({ job: { company: 'Stubborn Co', website: 'https://stubborn-test.com' } })));
    const d28c = db.docs.find((d) => d.id === b28c.body.docId);
    ok('⚠️ still generic after the pass → 200, stored as written, EXACTLY two AI calls (never a third)',
      b28c.statusCode === 200 && !!d28c && ai.calls - s0.ai === 2 && d28c.payload.personal_info.title === 'Backend Engineer', { ai: ai.calls - s0.ai, title: d28c && d28c.payload.personal_info.title });
    ok('…and says so in the log', logs.some((l) => /"Stubborn Co" after the corrective pass: summary similarity n\/a, title unchanged — still generic, delivered as written/.test(l)), logs.filter((l) => /Stubborn Co/.test(l)));

    // (d) no sector known (the researcher names no industry, no conventions): an unchanged title is NOT evidence.
    research.industry = null;
    s0 = snapshot(); stages.length = 0;
    ai.queue.push(() => JSON.stringify(RESUME({ personal_info: { ...RESUME().personal_info, title: 'Backend Engineer' } })));
    const b28d = await capture(() => call(RB.generateAI, buildBody({ job: { company: 'Blank Sector Co', website: 'https://blank-sector-test.com' } })));
    ok('no sector → an unchanged title is not generic: ONE AI call, no polishing stage',
      b28d.statusCode === 200 && ai.calls - s0.ai === 1 && !stages.some((s) => s.stage === 'polishing') && !logs.some((l) => /came back generic/.test(l)), { ai: ai.calls - s0.ai, stages: stages.map((s) => s.stage) });
    research.industry = 'E-commerce and cloud computing';

    // (e) the conventions' sector beats the researcher's industry in the correction.
    conv.answer = { employer_type: 'enterprise', sector: 'Industrial automation', cv: { length: 'flexible' } };
    s0 = snapshot();
    ai.queue.push(() => JSON.stringify(RESUME({ personal_info: { ...RESUME().personal_info, title: 'Backend Engineer' } })));
    ai.queue.push(() => JSON.stringify(RESUME()));
    const b28e = await capture(() => call(RB.generateAI, buildBody({ job: { company: 'Conv Sector Co', website: 'https://conv-sector-test.com' } })));
    ok('the correction is phrased for the conventions\' sector', b28e.statusCode === 200 && ai.calls - s0.ai === 2 && /Rewrite the title and the summary opening for industrial automation/.test(ai.prompts[ai.prompts.length - 1]), ai.calls - s0.ai);
    conv.answer = null;

    // (f) placeholders AND a generic title: still ONE pass for both (folded), the label the generic one loses.
    s0 = snapshot(); stages.length = 0;
    ai.queue.push(() => JSON.stringify(RESUME({ personal_info: { ...RESUME().personal_info, title: 'Backend Engineer' }, experience: [{ company: 'PayCo', role: 'Senior Engineer', start_date: '2018', end_date: 'Present', highlights: ['Cut latency by [X%]'] }] })));
    ai.queue.push(() => JSON.stringify(RESUME()));
    const b28f = await capture(() => call(RB.generateAI, buildBody({ job: { company: 'Folded Co', website: 'https://folded-test.com' } })));
    const fix28f = ai.prompts[ai.prompts.length - 1];
    ok('⚠️ placeholders + generic = ONE pass naming both, labelled "Polishing the wording"',
      b28f.statusCode === 200 && ai.calls - s0.ai === 2 && /placeholder text/.test(fix28f) && /Rewrite the title and the summary opening/.test(fix28f)
      && stages.find((s) => s.stage === 'polishing').label === 'Polishing the wording', { ai: ai.calls - s0.ai, label: (stages.find((s) => s.stage === 'polishing') || {}).label });
    const src28 = fsSync.readFileSync(path.join(ROOT, 'server/controllers/resumeBuilderController.js'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    // ⚠️ RETARGETED 2026-09-15: four lines (summary 0.6, opening 0.5, a highlight 0.9, 60% of them) and the doc lane's 0.55
    // over the builder's default 0.4 — the builder's one call passes no temperature, the doc lane's two pass the constant.
    ok('⚠️ the guard\'s four lines, the two temperatures, and ONE pass in code: correctDocDraft is called once in the lane, inside the correction budget',
      /DOC_SUMMARY_SAME_MAX = 0\.6\b/.test(src28) && /DOC_OPENING_SAME_MAX = 0\.5\b/.test(src28) && /DOC_HIGHLIGHT_SAME_MIN = 0\.9\b/.test(src28) && /DOC_HIGHLIGHTS_SAME_SHARE = 0\.6\b/.test(src28)
      && /DOC_LANE_TEMPERATURE = 0\.55\b/.test(src28) && /async function callGemini\(prompt, \{ temperature = 0\.4 \} = \{\}\)/.test(src28)
      && (src28.match(/await callGemini\((?:prompt|fixPrompt), \{ temperature: DOC_LANE_TEMPERATURE \}\)/g) || []).length === 2
      && (src28.match(/await callGemini\(prompt\);/g) || []).length === 1 && (src28.match(/await callGemini\(/g) || []).length === 3
      && (src28.match(/await correctDocDraft\(/g) || []).length === 1 && /Date\.now\(\) - startedAt < DOC_LANE_CORRECTION_BUDGET_MS/.test(src28),
      { passes: (src28.match(/await correctDocDraft\(/g) || []).length, calls: (src28.match(/await callGemini\(/g) || []).length });
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
