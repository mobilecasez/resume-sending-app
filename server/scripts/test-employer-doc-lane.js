// The resume DOC LANE end to end — POST /generate-ai with saveTo:'employer_doc', the generation gate, home-cards
// ?doc=, preview-templates / generate-pdf / generate-docx with a docId — driven through the REAL
// resumeBuilderController handlers against a stubbed database, a stubbed AI and a stubbed renderer.
// Every AI call, research call, charge and stored document is counted.
//   node server/scripts/test-employer-doc-lane.js
//
// Since 2026-09-14 it also covers what Home's confirm sheet reads from the gate (usage + pass — display only, never
// on a cache hit) and the employer's hiring CONVENTIONS (research.conventions): the prompt's facts and FORMATTING
// rules, personal details blanked in code, the page mode, and the stored design's aiFamilies / conventionsSummary.
// Since 2026-09-18 (S30) it covers Google's AI being BUSY, for both résumé lanes: a 503 storm is waited for and fallen back
// from (aiText), the model that actually answered is stored, and a build no model can write is a 503 ai_busy / ai_down
// that charged, stored and locked nothing — the Amazon "didn't finish" incident, in the résumé lanes.
// ⚠️ RETARGETED 2026-09-18 (the same day, later): both résumé lanes now walk aiText.writing() — the MEASURED document chain
// (primary gemini-3.1-flash-lite, then gemini-2.5-flash with thinking OFF, then gemini-2.5-flash-lite) — not
// [RESUME_MODEL, ...fallbackModels()]. S30 reads PRIMARY / FB1 / FB2 from aiText.writingChain() and never types an id, so a
// storm "on the primary" is scripted on whatever the lanes really ask first.
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
// queue: functions (prompt) => text; temps: generationConfig.temperature per model.
// ⚠️ SINCE 2026-09-18 A CALL NAMES ITS MODEL (S30): aiText walks a fallback chain, so `models` / `at` record which model
// each call went to and when, and `down` makes a model fail EVERY call it gets ({ [model]: () => Error }) — a 503 storm
// on the primary, a quota wall on all of them — before the queue is consulted, so the queue feeds whoever answers.
// A `down` entry answering 'hang' never answers at all (gemini-flash-latest took 257 s): only a real cap ends that call.
// A `down` entry is handed the model it failed for, so the error it builds names THAT model (as Google's URL would).
// `configs` (2026-09-18, the writing chain) is the generationConfig OBJECT each model was handed — by reference, so "the
// lane's own config, untouched" is checked as identity, and "gemini-2.5-flash with thinking OFF" as its merged copy.
const ai = { calls: 0, prompts: [], queue: [], temps: [], configs: [], models: [], at: [], down: {} };
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
  // asJob's failJobWithReason (S30): the job a poller is waiting on, failed WITH the handler's reason in one write.
  if (/^UPDATE async_jobs SET status = 'failed', error = \$1, result = \$2/.test(q)) {
    db.failedJobs = db.failedJobs || [];
    db.failedJobs.push({ id: params[2], error: params[0], result: JSON.parse(params[1]) });
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
      const model = cfg && cfg.model;
      return { generateContent: async (prompt) => {
        ai.calls++;
        ai.models.push(model); ai.at.push(Date.now());
        ai.configs.push(cfg ? cfg.generationConfig : undefined);   // beside `models`, so the two slice together
        ai.prompts.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
        if (ai.down[model]) {
          const e = ai.down[model](model);
          if (e === 'hang') await new Promise(() => {});   // no timer: an abandoned call holds nothing open
          throw e;
        }
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
// research.size: the free text the researcher gives for the headcount. ⚠️ It is HALF of the employer-size reading
// (cvPlaybook.tierFor): a 'giant' is only ever an employer whose conventions DECLARE employerType 'enterprise' and
// whose size says household name or ≥ 20,000 people — the default below is a large employer, never a giant (S29c).
research.size = '10,001+ employees';
// research.delayMs: how long "the research" takes (S30 — so the build's AI clock has visibly run before the first AI call).
research.delayMs = 0;
stub('ai-employer-researcher.js', { researchEmployer: async (url) => { research.calls++; if (research.delayMs) await new Promise((r) => setTimeout(r, research.delayMs)); return { employer_name: 'Amazon', industry: research.industry, company_size: research.size, brand_color: '#ff9900', font_name: 'Amazon Ember', technologies: [{ name: 'AWS' }], clients: [], recent_activity: [], key_contacts: [{ name: 'Jane' }] }; } });
stub('server/services/resumeScorer.js', {
  narrativeFor: async () => ({ text: BASE_TEXT, source: 'builder' }),
  BASE_SNAPSHOT_FP: 'base-resume-before-tailoring:v1',
});
// startJob / failJob / completeJob are what the REAL asJob wrapper calls (S30 drives one build through it); `jobs` counts them.
const jobs = { started: [], failed: [], completed: [] };
stub('server/services/jobService.js', {
  updateJobProgress: async () => {}, updateJobPartialResult: async (id, r) => { stages.push(r); },
  createJob: async () => 'job1', startJob: async (id) => { jobs.started.push(id); },
  failJob: async (id, msg) => { jobs.failed.push({ id, msg }); }, completeJob: async (id, body) => { jobs.completed.push({ id, body }); },
});
// ⚠️ THE OPERATOR'S PAGER (S30): aiText reports a quota / auth wall through the REAL aiHealth, which lazily requires
// adminNotifier — unstubbed that is the push service and the database. `pages` counts what would have been sent.
const pages = [];
stub('server/services/adminNotifier.js', { notifyAdmins: async (category, title, body, data) => { pages.push({ title, data }); } });
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
    // ⚠️ RETARGETED 2026-09-18: the pass now runs inside the build's AI context (withResumeAi — its provider retries report
    // on the bar and share the build's one clock), so it is counted as that call, still exactly one.
    const passCalls = (src28.match(/await withResumeAi\(docAi, \(\) => correctDocDraft\(/g) || []).length;
    ok('⚠️ the guard\'s four lines, the two temperatures, and ONE pass in code: correctDocDraft is called once in the lane, inside the correction budget',
      /DOC_SUMMARY_SAME_MAX = 0\.6\b/.test(src28) && /DOC_OPENING_SAME_MAX = 0\.5\b/.test(src28) && /DOC_HIGHLIGHT_SAME_MIN = 0\.9\b/.test(src28) && /DOC_HIGHLIGHTS_SAME_SHARE = 0\.6\b/.test(src28)
      && /DOC_LANE_TEMPERATURE = 0\.55\b/.test(src28) && /async function callGemini\(prompt, \{ temperature = 0\.4 \} = \{\}\)/.test(src28)
      && (src28.match(/await callGemini\((?:prompt|fixPrompt), \{ temperature: DOC_LANE_TEMPERATURE \}\)/g) || []).length === 2
      && (src28.match(/await callGemini\(prompt\);/g) || []).length === 1 && (src28.match(/await callGemini\(/g) || []).length === 3
      && passCalls === 1 && (src28.match(/correctDocDraft\(/g) || []).length === 2   // its definition, and that one call
      && /Date\.now\(\) - startedAt < DOC_LANE_CORRECTION_BUDGET_MS/.test(src28),
      { passes: passCalls, calls: (src28.match(/await callGemini\(/g) || []).length });
  }

  console.log('── S29 · ⚠️ THE COUNTRY WRITES THE DOCUMENT: one playbook for the prompt, the page and the design (2026-09-16) ──');
  {
    // The owner's ask, in his words: "for India all the projects should be mentioned along with the experience …
    // research for all the countries and put it in the prompts dynamically based on the country, and if it is a
    // major/giant company then get more details". Until now `country` reached the prompt as a LABEL ("Applying in:
    // India") and nothing else, and when the research found no conventions the prompt carried no formatting rule at
    // all — so every country on earth got the Anglo habits the prompt never names out loud. cvPlaybook answers it for
    // all ~200 of them; docPlaybookOf merges that answer UNDER this employer's own researched conventions and hands
    // the one object to the prompt, the personal-details backstop and the design ranking.
    // ⚠️ AND IT IS FREE. Every scenario below asserts its own AI call and charge, and (e) proves the new wording never
    // reaches the fingerprint — no stored document turns stale, nobody is re-billed for a better prompt.
    ent.consumeVia = 'plan'; ent.gate = { allowed: true, via: 'plan', remaining: 5 }; ent.gateSeq = []; conv.answer = null;
    // The country block alone (the prompt also talks about photos in the DESIGN brief, which is not a writing rule).
    const blockOf = (p) => { const i = p.indexOf('=== HOW A CV IS WRITTEN'); const j = p.indexOf('=== WRITTEN FOR'); return i < 0 ? '' : p.slice(i, j > i ? j : i + 3000); };

    // (a) INDIA, with no researched conventions at all — the exact hole the playbook exists to fill.
    s0 = snapshot();
    const bIN = await call(RB.generateAI, buildBody({ country: 'India', job: { company: 'Infosys', website: 'https://infosys.com' } }));
    const dIN = db.docs.find((d) => d.id === bIN.body.docId);
    const pIN = ai.prompts[ai.prompts.length - 1];
    ok('200 stored, ONE AI call, ONE charge — knowing the country costs nothing',
      bIN.statusCode === 200 && !!dIN && ai.calls - s0.ai === 1 && ent.consumed.length - s0.consumed === 1,
      { status: bIN.statusCode, ai: ai.calls - s0.ai, charged: ent.consumed.length - s0.consumed });
    ok('⚠️ the research found no conventions, so there is no FORMATTING block — and the COUNTRY block carries the rules instead',
      !/=== FORMATTING FOR Infosys/.test(pIN) && /=== HOW A CV IS WRITTEN IN INDIA ===/.test(pIN), pIN.slice(pIN.indexOf('=== HOW A CV'), pIN.indexOf('=== HOW A CV') + 240));
    ok('⚠️ THE ASK ITSELF: an Indian résumé lists EVERY project — one entry each, with the client it ran for, the role and the stack',
      /list EVERY project the material contains/.test(pIN) && /none merged, none summarised away, none left out/.test(pIN)
      && /Nine projects in the material means nine entries/.test(pIN) && /the technology stack the material states for it/.test(pIN), blockOf(pIN).slice(0, 700));
    ok('…and the SCHEMA and the ZERO-MISS rule widen to honour it instead of fighting it',
      /"title": "the project's own name"/.test(pIN) && /"about": "1-2 sentences: what it is, and the technology stack the material states for it"/.test(pIN)
      && /nine projects in the material means nine entries in `projects`/.test(pIN) && /Two PROJECTS are never merged into one/.test(pIN)
      && /ONE entry per project in the material, in the order of importance the material gives them/.test(pIN),
      pIN.slice(pIN.indexOf('"projects": ['), pIN.indexOf('"projects": [') + 500));
    ok('…with the depth, the dates and the order India reads: full experience entries, MMM YYYY, skills above experience',
      /Experience: full depth\./.test(pIN) && /Recent roles carry 4-8 highlights, older ones 3-5/.test(pIN)
      && /write every start and end date as MMM YYYY/.test(pIN) && /- Dates: MMM YYYY, as the rules above say,/.test(pIN)
      && /Section order read here: contact → summary → skills → experience → projects → education/.test(pIN)
      && /categorised technical-skills block sits ABOVE experience/.test(pIN), blockOf(pIN));
    const photoLines = blockOf(pIN).split('\n').filter((l) => /photo/i.test(l));
    ok('⚠️ NOTHING IS INVENTED: the country block states no fact, asks for no photo, and never names the employer in the résumé',
      photoLines.length === 1 && /NEVER add a fact/.test(photoLines[0])
      && /They NEVER add a fact — no photo, no date of birth, no nationality, no project, no client, no technology, no date and no number/.test(pIN)
      && /Never mention Infosys, this guidance or these conventions anywhere in the resume\./.test(pIN), photoLines);
    ok('⚠️ "up to two pages is normal" is ROOM, not an order: the stored mode is still the model\'s own reading of the material',
      dIN && dIN.design && dIN.design.mode === 'onepage'
      && /"mode": "onepage" where one page is the norm or the real material is concise/.test(pIN), dIN && dIN.design && dIN.design.mode);

    // (b) GERMANY: the same lane, a different document — the tabular Lebenslauf, not an Indian project inventory.
    s0 = snapshot();
    const bDE = await call(RB.generateAI, buildBody({ country: 'Germany', job: { company: 'Siemens', website: 'https://siemens.de' } }));
    const pDE = ai.prompts[ai.prompts.length - 1];
    ok('⚠️ a German build is written as a LEBENSLAUF: gapless MM/YYYY stations, duties under each role, personal details kept, read as a table',
      bDE.statusCode === 200 && /=== HOW A CV IS WRITTEN IN GERMANY ===/.test(pDE) && /Antichronological and GAPLESS/.test(pDE)
      && /write every start and end date as MM\/YYYY/.test(pDE) && /Duties carry the entry/.test(pDE)
      && /Personal details: employers here expect them/.test(pDE) && /Tabular CV:/.test(pDE), blockOf(pDE));
    ok('…and the schema follows the same answer: nationality and date of birth stay the material\'s to state',
      /"nationality": "ONLY if the material states it, else empty string"/.test(pDE) && !/always an empty string for this employer/.test(pDE),
      pDE.slice(pDE.indexOf('"nationality"'), pDE.indexOf('"nationality"') + 200));
    ok('…and India\'s rule does NOT travel: a German CV keeps its projects inside the role that ran them',
      !/list EVERY project the material contains/.test(pDE) && /name the projects that matter inside the experience entry that ran them/.test(pDE)
      && !/nine entries in `projects`/.test(pDE), blockOf(pDE));
    ok('ONE AI call and ONE charge for that one too', ai.calls - s0.ai === 1 && ent.consumed.length - s0.consumed === 1, { ai: ai.calls - s0.ai, charged: ent.consumed.length - s0.consumed });

    // (b2) THE UNITED STATES, still with no researched conventions: the two decisions the prompt does NOT own.
    // ⚠️ A one-page country wrote one page of content; a document stored as 'a4' would be a two-page shell around it.
    // ⚠️ And 'avoid' has to be enforced in CODE — a prompt is advice, and the model here answers a date of birth anyway.
    s0 = snapshot();
    ai.queue.push(() => JSON.stringify(RESUME({
      personal_info: { ...RESUME().personal_info, nationality: 'American', date_of_birth: '1988-04-02' },
      design: { families: { exec_pro: { score: 95, reason: 'Senior look' } }, mode: 'a4', tone: 'Executive', headline: 'Executive Professional suits a senior career' },
    })));
    const bUS = await call(RB.generateAI, buildBody({ country: 'United States', job: { company: 'Acme US', website: 'https://acme-us-test.com' } }));
    const dUS = db.docs.find((d) => d.id === bUS.body.docId);
    const pUS = ai.prompts[ai.prompts.length - 1];
    ok('⚠️ a US build with no research is a ONE-PAGE résumé with no personal details — from the country alone',
      bUS.statusCode === 200 && !/=== FORMATTING FOR Acme US/.test(pUS) && /=== HOW A CV IS WRITTEN IN UNITED STATES ===/.test(pUS)
      && /Length: ONE page\./.test(pUS) && /Personal details: leave the date of birth and nationality empty/.test(pUS)
      && /"nationality": "always an empty string for this employer"/.test(pUS)
      && /"mode": "onepage" — one page is the norm where this application is going\./.test(pUS), blockOf(pUS));
    ok('⚠️ …and both reach the DOCUMENT, not just the prompt: stored as onepage (the model said a4), the date of birth blanked in code',
      dUS && dUS.design && dUS.design.mode === 'onepage' && dUS.payload.personal_info.date_of_birth === '' && dUS.payload.personal_info.nationality === '',
      dUS && { mode: dUS.design && dUS.design.mode, pi: dUS.payload.personal_info });
    ok('one AI call, one charge for it', ai.calls - s0.ai === 1 && ent.consumed.length - s0.consumed === 1, { ai: ai.calls - s0.ai, charged: ent.consumed.length - s0.consumed });

    // (c) THE EMPLOYER'S SIZE, read once (cvPlaybook.tierFor): a giant is parsed before it is read, an SME is read by
    // the person the candidate would report to. ⚠️ 'giant' is never guessed from headcount alone — the conventions must
    // DECLARE an enterprise and the size must say household name or ≥ 20,000 people.
    conv.answer = { hq_country: 'India', role_country: 'India', employer_type: 'enterprise', sector: 'IT services' };
    research.size = 'A Fortune 500 multinational with 300,000 employees worldwide';
    s0 = snapshot();
    const bBig = await call(RB.generateAI, buildBody({ country: 'India', job: { company: 'Giant Corp', website: 'https://giant-corp-test.com' } }));
    const pBig = ai.prompts[ai.prompts.length - 1];
    conv.answer = { hq_country: 'India', role_country: 'India', employer_type: 'sme', sector: 'IT services' };
    research.size = 'A 60-person consultancy';
    const bSme = await call(RB.generateAI, buildBody({ country: 'India', job: { company: 'Kleinwerk', website: 'https://kleinwerk-test.com' } }));
    const pSme = ai.prompts[ai.prompts.length - 1];
    ok('⚠️ a GIANT employer earns the deeper rules — the figure leads the bullet, one plain column for the parser, scope and scale first',
      bBig.statusCode === 200 && /Numbers: lead the bullet with the figure the material already states/.test(pBig)
      && /Plain single column for screening software/.test(pBig) && /Emphasis \(a large employer\)/.test(pBig), blockOf(pBig));
    ok('…and an SME does NOT: no parser rules, and the emphasis is breadth and hands-on ownership',
      bSme.statusCode === 200 && !/Plain single column for screening software/.test(pSme) && !/Numbers: lead the bullet with the figure/.test(pSme)
      && /Numbers: keep every figure the material states and put it early/.test(pSme) && /Emphasis \(a smaller employer\)/.test(pSme), blockOf(pSme));
    ok('⚠️ and the size never overrides the country: both are still Indian résumés, every project and all',
      /=== HOW A CV IS WRITTEN IN INDIA ===/.test(pBig) && /=== HOW A CV IS WRITTEN IN INDIA ===/.test(pSme)
      && /list EVERY project the material contains/.test(pBig) && /list EVERY project the material contains/.test(pSme),
      [blockOf(pBig).slice(0, 120), blockOf(pSme).slice(0, 120)]);
    ok('two builds, two AI calls, two charges — the size reading adds neither', ai.calls - s0.ai === 2 && ent.consumed.length - s0.consumed === 2, { ai: ai.calls - s0.ai, charged: ent.consumed.length - s0.consumed });
    research.size = '10,001+ employees';

    // (d) A FACT RESEARCHED ABOUT THIS EMPLOYER BEATS THE COUNTRY — and is said exactly once.
    conv.answer = {
      hq_country: 'India', role_country: 'India', employer_type: 'startup', sector: 'Fintech',
      cv: { length: 'one page', personal_details: 'avoid', date_format: 'MM.YYYY' },
    };
    s0 = snapshot();
    ai.queue.push(() => JSON.stringify(RESUME({
      personal_info: { ...RESUME().personal_info, nationality: 'Indian', date_of_birth: '1990-01-01' },
      design: { families: { exec_pro: { score: 95, reason: 'Senior look' } }, mode: 'a4', tone: 'Executive', headline: 'Executive Professional suits a senior career' },
    })));
    const bR = await call(RB.generateAI, buildBody({ country: 'India', job: { company: 'Zeta Pay', website: 'https://zeta-pay-test.com' } }));
    const dR = db.docs.find((d) => d.id === bR.body.docId);
    const pR = ai.prompts[ai.prompts.length - 1];
    ok('⚠️ one page, MM.YYYY and no personal details — even though India says two pages, MMM YYYY and says nothing about them',
      /=== FORMATTING FOR Zeta Pay \(from its hiring conventions\) ===/.test(pR) && /at most 3 highlights/.test(pR) && /as MM\.YYYY/.test(pR)
      && /leave personal_info\.date_of_birth and personal_info\.nationality as ""/.test(pR)
      && !/up to two pages is normal here/.test(pR) && !/write every start and end date as MMM YYYY/.test(pR),
      pR.slice(pR.indexOf('=== FORMATTING FOR'), pR.indexOf('=== FORMATTING FOR') + 700));
    ok('…and each rule is stated ONCE: the country block stays silent on every value the research supplied, and speaks on the rest',
      !/\n- Length: /.test(blockOf(pR)) && !/\n- Dates: write every start and end date/.test(blockOf(pR)) && !/\n- Personal details: /.test(blockOf(pR))
      && /list EVERY project the material contains/.test(blockOf(pR)), blockOf(pR));
    ok('⚠️ the merged answer drives the CODE as well as the prose: the page mode is onepage (the model said a4) and the details are blanked',
      dR && dR.design && dR.design.mode === 'onepage' && dR.payload.personal_info.date_of_birth === '' && dR.payload.personal_info.nationality === '',
      dR && { mode: dR.design && dR.design.mode, pi: dR.payload.personal_info });
    ok('one AI call, one charge', ai.calls - s0.ai === 1 && ent.consumed.length - s0.consumed === 1, { ai: ai.calls - s0.ai, charged: ent.consumed.length - s0.consumed });
    conv.answer = null;

    // (e) ⚠️ THE MONEY QUESTION. The prompt was rewritten for every country on earth. Not one stored document may
    // become stale for it: the fingerprint hashes the base text, the four job fields and the research revision —
    // never a prompt string, never the country. So a REBUILD of the same job for the same country is still free.
    s0 = snapshot();
    const bSame = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-29e1', country: 'India', job: { company: 'Infosys', website: 'https://infosys.com' } }));
    ok('⚠️ the same job, the same country: a FREE hit on the SAME document — the wording is not a fingerprint input',
      bSame.body.cached === true && bSame.body.docId === bIN.body.docId && JSON.stringify(snapshot()) === JSON.stringify(s0), { body: bSame.body, before: s0, after: snapshot() });
    const src29 = fsSync.readFileSync(path.join(ROOT, 'server/controllers/resumeBuilderController.js'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const fp29 = src29.slice(src29.indexOf('async function generationFingerprint'), src29.indexOf('function docResearchRev'));
    ok('⚠️ …and in the source: the fingerprint hashes the base text, the job and the research revision — no prompt, no country, no playbook',
      /employerDocs\.fingerprint\(\{/.test(fp29) && /baseText: \[baseText, uploaded\]/.test(fp29) && /researchRev,/.test(fp29)
      && !/playbook|docPlaybookOf|country/.test(fp29), fp29.slice(-320));
    ok('⚠️ ONE resolution per build: docPlaybookOf is called once and the SAME object reaches the prompt, the backstop and the design ranking',
      (src29.match(/const plan = docPlaybookOf\(\{ country, website: researchSite \|\| job\.website, conventions, research \}\);/g) || []).length === 1
      && /conventions, playbook: plan,$/m.test(src29) && /applyPersonalDetailsConvention\(resumeData, plan\.conv\);/.test(src29)
      && /brand, playbook: plan \}\);/.test(src29) && !/const mode = conv && conv\.cv\.length === 'one_page'/.test(src29),
      { resolved: (src29.match(/docPlaybookOf\(\{/g) || []).length });

    // (f) ⚠️ AND THE OTHER HALF OF THE SAME MONEY QUESTION: the country is not hashed, so it must not be able to
    // hand back the WRONG COUNTRY'S DOCUMENT for free. (a) built Infosys while the chip said India — one entry per
    // project, MMM YYYY, skills above experience. Correct the chip to Germany and every input the fingerprint sees
    // is identical, so the row is found; before the marker it was RETURNED, labelled fresh, with no Refresh to
    // offer and no way to ever get a Lebenslauf. Now the document records the country it was written for
    // (design.writtenFor) and is not a free hit for another one: a MISS, which is a path this lane already has.
    s0 = snapshot();
    const dInfosys = db.docs.find((d) => d.id === bIN.body.docId);
    ok('the India document records the country it was written for, and nothing else about the build changed',
      dInfosys && dInfosys.design && dInfosys.design.writtenFor === 'in' && dInfosys.design.mode === 'onepage',
      dInfosys && dInfosys.design && { writtenFor: dInfosys.design.writtenFor, mode: dInfosys.design.mode });
    // ⚠️ THE APP CONFIRMED IT AS FREE (contract C2, expectVia 'cache'): the refusal must come BEFORE every gate —
    // 409 cache_miss, nothing bound, nothing charged, nothing stored — and Home asks on its sheet.
    const bWrong = await call(RB.generateAI, buildBody({
      clientBuildId: 'cb-29f', country: 'Germany', expectVia: 'cache', job: { company: 'Infosys', website: 'https://infosys.com' },
    }));
    ok('⚠️ the SAME job under a DIFFERENT country is NOT the India document served free — 409 cache_miss, nothing charged',
      bWrong.statusCode === 409 && bWrong.body.reason === 'cache_miss' && !bWrong.body.docId
      && JSON.stringify(snapshot()) === JSON.stringify(s0), { body: bWrong.body, before: s0, after: snapshot() });
    // Answered on the sheet, the build runs for real: a GERMAN document, and the India one is replaced on its own
    // row (the identity is the employer, not the country) — one document per employer, as Home has always held.
    s0 = snapshot();
    const bDE2 = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-29f2', country: 'Germany', job: { company: 'Infosys', website: 'https://infosys.com' } }));
    const pDE2 = ai.prompts[ai.prompts.length - 1];
    const dDE2 = db.docs.find((d) => d.id === bDE2.body.docId);
    ok('…and the rebuild the user agreed to writes the GERMAN document, on the same row, for one charge',
      bDE2.statusCode === 200 && !bDE2.body.cached && bDE2.body.docId === bIN.body.docId
      && /=== HOW A CV IS WRITTEN IN GERMANY ===/.test(pDE2) && !/list EVERY project the material contains/.test(pDE2)
      && dDE2 && dDE2.design.writtenFor === 'de' && db.docs.length === s0.docs
      && ai.calls - s0.ai === 1 && ent.consumed.length - s0.consumed === 1,
      { docId: bDE2.body.docId, writtenFor: dDE2 && dDE2.design.writtenFor, ai: ai.calls - s0.ai, charged: ent.consumed.length - s0.consumed });
    ok('…and THAT one is now the free hit for Germany', (await call(RB.generateAI, buildBody({ clientBuildId: 'cb-29f3', country: 'Germany', job: { company: 'Infosys', website: 'https://infosys.com' } }))).body.cached === true);
    // ⚠️ NOBODY IS RE-BILLED FOR THE MARKER. Every document stored before it exists has none, and a document with
    // none is served for ANY country — exactly as it was yesterday. Proved on the row itself.
    s0 = snapshot();
    delete dDE2.design.writtenFor;
    const bOld = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-29f4', country: 'United States', expectVia: 'cache', job: { company: 'Infosys', website: 'https://infosys.com' } }));
    ok('⚠️ a document from BEFORE the marker is still a free hit for every country — no user is re-billed for this',
      bOld.statusCode === 200 && bOld.body.cached === true && bOld.body.docId === bDE2.body.docId
      && JSON.stringify(snapshot()) === JSON.stringify(s0), { body: bOld.body, before: s0, after: snapshot() });
    // And a build that resolves NO country cannot tell whether the document suits it — "cannot tell" is never a
    // reason to charge someone, so it is served.
    dDE2.design.writtenFor = 'de';
    const bBlank = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-29f5', country: '', expectVia: 'cache', job: { company: 'Infosys', website: 'https://infosys.com' } }));
    ok('…and a build that names no country at all is served it too, rather than charged on an unanswerable question',
      bBlank.statusCode === 200 && bBlank.body.cached === true && JSON.stringify(snapshot()) === JSON.stringify(s0), { body: bBlank.body, after: snapshot() });
    ok('⚠️ and the gate answers the SAME question, so it cannot promise a free document the build would refuse',
      (await call(RB.generationGate, { employer: 'Infosys', saveTo: 'employer_doc', country: 'Germany', job: { website: 'https://infosys.com' } })).body.via === 'cache'
      && (await call(RB.generationGate, { employer: 'Infosys', saveTo: 'employer_doc', country: 'India', job: { website: 'https://infosys.com' } })).body.via !== 'cache'
      && (await call(RB.generationGate, { employer: 'Infosys', saveTo: 'employer_doc', job: { website: 'https://infosys.com' } })).body.via === 'cache');
    // ⚠️ AND THE SCREEN HAS TO BE ABLE TO SAY SO, or the refusal is the whole of what the user ever gets. Home
    // draws its Refresh pill on `stale` and its Tailor button only on a chip with NO document, and the Add door
    // stands down once one is saved — so a document that is no longer served for this chip and is still labelled
    // fresh is a résumé the user can neither use nor replace. The fingerprint cannot light that pill: it is
    // IDENTICAL for both countries, which is exactly why nobody is re-billed. So /api/employer-docs/current asks
    // the MARKER beside it (docWrittenElsewhere), and this is that answer — the build's own, not a second copy.
    const dNow = db.docs.find((d) => d.id === bDE2.body.docId);
    const askedIn = (country) => ({ employer: 'Infosys', country, job: { website: 'https://infosys.com' } });
    const fpNow = await RB.currentResumeFingerprint(UID, { job: { company: 'Infosys', ...dNow.job_input }, env: 'Production' });
    ok('⚠️ the fingerprint alone calls the GERMAN document fresh for an India chip — identical, because the country is not hashed',
      typeof fpNow === 'string' && fpNow !== '' && fpNow === dNow.input_fingerprint, { fp: fpNow, stored: dNow.input_fingerprint });
    ok('⚠️ …so the label asks the marker: written for Germany, read for India → written ELSEWHERE (stale), and the row\'s fingerprint is untouched by the question',
      RB.docWrittenElsewhere(dNow, askedIn('India')) === true && dNow.input_fingerprint === fpNow,
      { writtenFor: dNow.design && dNow.design.writtenFor, fp: dNow.input_fingerprint });
    ok('…and never stale for the country it WAS written for, nor for a chip that names none (the same "cannot tell" the cache keeps free)',
      RB.docWrittenElsewhere(dNow, askedIn('Germany')) === false && RB.docWrittenElsewhere(dNow, askedIn('')) === false
      && RB.docWrittenElsewhere(dNow, { employer: 'Infosys', job: { website: 'https://infosys.com' } }) === false);
    ok('⚠️ …and a row from BEFORE the marker is never labelled stale by it — a pill on a document the build still serves free is a paid rebuild nobody needed',
      RB.docWrittenElsewhere({ ...dNow, design: { ...dNow.design, writtenFor: null } }, askedIn('India')) === false
      && RB.docWrittenElsewhere({ ...dNow, design: null }, askedIn('India')) === false
      && RB.docWrittenElsewhere(null, askedIn('India')) === false);
    // ⚠️ THE INVARIANT BETWEEN THEM: the label and the build answer the SAME question for the same chip. A pill
    // that nags where the gate still says 'cache' charges for nothing; a chip the gate refuses and the pill
    // leaves alone is the wrong-country document with no way out. Asked over the three chips that matter.
    const agree = [];
    for (const country of ['Germany', 'India', '']) {
      const via = (await call(RB.generationGate, { employer: 'Infosys', saveTo: 'employer_doc', country, job: { website: 'https://infosys.com' } })).body.via;
      agree.push({ country, free: via === 'cache', stale: RB.docWrittenElsewhere(dNow, askedIn(country)) });
    }
    ok('⚠️ the LABEL and the BUILD never disagree: every chip the gate still serves free is one the pill leaves alone, and the one it refuses is the one the pill offers',
      agree.every((a) => a.free === !a.stale) && agree.filter((a) => a.stale).length === 1, agree);
    // ⚠️ IN THE SOURCE TOO: the country is a test applied at EVERY place a stored document is handed over free —
    // the cache step, the race read under the usage lock, and the gate that promises the hit — and at NONE of the
    // places money is hashed. A reader added later that skips the test is the wrong-country document back again.
    ok('⚠️ …and none of it is hashed: the country tests the cache READ, never the fingerprint',
      !/country|writtenFor|placeKey/.test(fp29)
      && /const placeKey = docPlaceKeyOf\(\{ country, website: researchSite \|\| job\.website \}\);/.test(src29)
      && /const hit = await employerDocs\.get\(userId, 'resume', company, cacheFp, env\);\s*\n\s*if \(hit && hit\.id && hit\.payload && hit\.payload\.personal_info && docServesPlace\(hit, placeKey\)\)/.test(src29)
      && /const landed = await employerDocs\.get\(userId, 'resume', company, cacheFp, env\);\s*\n\s*if \(landed && landed\.id && landed\.payload && landed\.payload\.personal_info && docServesPlace\(landed, placeKey\)\)/.test(src29)
      && /if \(hit && hit\.payload && hit\.payload\.personal_info && docServesPlace\(hit, placeKey\)\) return answer\(true, 'cache'/.test(src29)
      // …and the label is that same test EXPORTED, not a second reading of the marker living in the routes.
      && /function docWrittenElsewhere\([\s\S]{0,500}?return !docServesPlace\(doc, docPlaceKeyOf\(/.test(src29)
      && /^\s*docWrittenElsewhere,$/m.test(src29),
      { fp: fp29.slice(-200) });

    // (g) ⚠️ TWO BLOCKS, NEVER TWO ANSWERS. conventionsPromptBlock does not only LIST what the research found —
    // under "HOW TO USE THESE CONVENTIONS" it turns personal details, length, dates and CV format into orders. Fed
    // the raw conventions it gave them for the employer's HOME country while the country block gave the opposite
    // ones for the country being applied to: a US-headquartered employer hiring in Germany was told "leave date of
    // birth and nationality out" AND "keep the date of birth and nationality exactly as the material states them",
    // "fit one page" AND "up to two pages is normal here", in one prompt. hqCountry alone triggers it, which makes
    // every US multinational posting a European role the ordinary case.
    conv.answer = {
      hq_country: 'United States', employer_type: 'enterprise', sector: 'Cloud infrastructure',
      cv: { length: 'one page', personal_details: 'avoid', photo: 'avoid', date_format: 'MM/YYYY', format: 'ats_plain' },
    };
    s0 = snapshot();
    // A draft that ANSWERS a date of birth and a nationality, so "the code did not blank them" is a real answer
    // and not the fixture's own empty strings.
    const withPersonal = () => JSON.stringify(RESUME({ personal_info: { ...RESUME().personal_info, nationality: 'Indian', date_of_birth: '1990-01-01' } }));
    ai.queue.push(withPersonal);
    const bX = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-29g', country: 'Germany', job: { company: 'Cloudspan', website: 'https://cloudspan-test.com' } }));
    const pX = ai.prompts[ai.prompts.length - 1];
    const facts = (p) => { const i = p.indexOf('=== HOW Cloudspan HIRES'); return i < 0 ? '' : p.slice(i, p.indexOf('=== END OF HIRING CONVENTIONS ===') + 33); };
    ok('⚠️ a US-headquartered employer hiring in GERMANY: not one rule in the prompt contradicts another',
      bX.statusCode === 200
      && !/leave date of birth, nationality and marital status out/.test(pX) && /Personal details: employers here expect them/.test(pX)
      && !/Length: fit one page by keeping the most relevant roles/.test(pX) && /up to two pages is normal here/.test(pX)
      && !/Plain ATS CV: standard section headings/.test(pX) && /Tabular CV: each entry is crisp and factual/.test(pX),
      [facts(pX).slice(0, 400), blockOf(pX).split('\n').filter((l) => /^- (Length|Personal details|Tabular|Plain)/.test(l))]);
    const dX = db.docs.find((d) => d.id === bX.body.docId);
    ok('…and the code backstop agrees with the prompt it enforces: Germany expects them, so the draft\'s are KEPT',
      dX && dX.payload.personal_info.date_of_birth === '1990-01-01' && dX.payload.personal_info.nationality === 'Indian'
      && !/always an empty string for this employer/.test(pX) && /"nationality": "ONLY if the material states it, else empty string"/.test(pX),
      dX && dX.payload.personal_info);
    ok('⚠️ the FACTS the research found are untouched — only the cv rules it researched for ANOTHER country are dropped',
      /Headquarters: United States/.test(pX) && /Employer type: large enterprise/.test(pX) && /Sector: Cloud infrastructure/.test(pX)
      && !/CV conventions:/.test(facts(pX)), facts(pX));
    ok('one AI call, one charge for it', ai.calls - s0.ai === 1 && ent.consumed.length - s0.consumed === 1, { ai: ai.calls - s0.ai, charged: ent.consumed.length - s0.consumed });
    // The SAME research, for the country it was researched for: every rule stands, said by FORMATTING, and the
    // country block stays silent on all three. The demotion must never cost a local employer its own conventions.
    s0 = snapshot();
    ai.queue.push(withPersonal);
    const bLocal = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-29g2', country: 'United States', job: { company: 'Cloudspan US', website: 'https://cloudspan-us-test.com' } }));
    const pLocal = ai.prompts[ai.prompts.length - 1];
    ok('⚠️ …while the same employer hiring at HOME keeps every researched rule, stated once, by FORMATTING',
      bLocal.statusCode === 200 && /leave date of birth, nationality and marital status out/.test(pLocal)
      && /Length: ONE page of content/.test(pLocal) && /Plain text for screening software/.test(pLocal)
      && !/\n- Length: /.test(blockOf(pLocal)) && !/\n- Personal details: /.test(blockOf(pLocal)) && !/\n- Dates: write every start and end date/.test(blockOf(pLocal)),
      blockOf(pLocal));
    ok('…and it is enforced in code there: the date of birth and the nationality are blanked on that document',
      (db.docs.find((d) => d.id === bLocal.body.docId) || {}).payload.personal_info.date_of_birth === '', bLocal.body);
    conv.answer = null;
  }

  console.log('── S30 · ⚠️ GOOGLE\'S AI IS BUSY: the build waits, falls back, and a build it still beats charges NOTHING (2026-09-18) ──');
  {
    // The incident, in the letter lane, and the same shape in both of these: user 1 built Amazon from Home and got
    // "That cover letter didn't finish". gemini-2.5-flash (the primary THEN) answered 503 "This model is currently
    // experiencing high demand" twice, back to back, and the lane gave up — the résumé lanes asked THREE times with no
    // pause, on one model, and a hang (AI_TIMEOUT) failed the build outright. Since then every callGemini goes through
    // aiText: ~2 s, the primary once more, then each fallback in turn, all inside the build's ONE clock (withResumeAi),
    // and a build no model can write answers 503 ai_busy / ai_down BEFORE the charge.
    // ⚠️ THE CHAIN IS aiText.writing() (retargeted later on 2026-09-18): a blind evaluation put gemini-3.1-flash-lite first,
    // gemini-2.5-flash with THINKING OFF second, gemini-2.5-flash-lite last. PRIMARY / FB1 / FB2 below are READ from
    // aiText.writingChain() — the very module instance the controller calls, never retyped — so every storm lands on the
    // model the lanes really ask first, and the old ids can never quietly make a scenario not happen.
    // ⚠️ RESUME_MODEL ('gemini-2.5-flash', the id stored only if an answer ever came without one) is now FB1's id, so a
    // document FB1 wrote cannot, by its stored id alone, prove the ANSWERING model was stored: (a2) makes FB2 write one.
    // ⚠️ WHAT MUST HOLD, and what each block below pins:
    //   a  a 503 storm on the primary → the document all the same, from a fallback, charged ONCE, the fallback stored
    //      (a2: the primary AND the first fallback storming → the second fallback writes it, and ITS id is stored)
    //   b  the fingerprint does not know who wrote it → an identical request later is a FREE hit (no re-bill, ever)
    //   c  every model busy → 503 ai_busy, nothing charged / stored / locked, and the job's poller released at once
    //   d  quota / a missing key → 503 ai_down, one call at most, not retryable, the operator paged
    //   e  a HUNG primary is capped and fallen back from — no longer a 504 after 90 s
    //   i  the lane's OWN retry with no clock left is still the lane's failure (500), never blamed on Google
    //   f  the corrective pass: a busy primary falls back; every model busy keeps the first draft (as before)
    //   g  the builder lane (no saveTo) — the same, on user_resumes and its cached copy
    //   h  the money constants and the order in code: AI before the lock, the model outside every fingerprint
    // ⚠️ THE SAME aiText INSTANCE THE CONTROLLER CALLS: resumeBuilderController requires '../services/aiText', which
    // resolves to this very file and this require.cache entry (nothing in this suite stubs or reloads aiText).
    const aiText = require(path.join(ROOT, 'server/services/aiText.js'));
    const { asJob } = require(path.join(ROOT, 'server/middleware/asyncJob.js'));
    // The operator's knobs for the writing chain are cleared for the section (and put back at its end), so the chain
    // read below is the measured default — the one production runs when nobody has turned a knob.
    const envWritingModel = process.env.AI_WRITING_MODEL, envWritingFallbacks = process.env.AI_WRITING_FALLBACK_MODELS;
    delete process.env.AI_WRITING_MODEL; delete process.env.AI_WRITING_FALLBACK_MODELS;
    const CHAIN = aiText.writingChain();
    const [PRIMARY, FB1, FB2] = CHAIN;
    ok('the résumé lanes\' writing chain, read from aiText: three DISTINCT models, and the thinking-off entry is the first fallback\'s only',
      CHAIN.length === 3 && new Set(CHAIN).size === 3 && CHAIN.every((m) => typeof m === 'string' && m)
      && JSON.stringify(Object.keys(aiText.writing().modelConfig)) === JSON.stringify([FB1]), { chain: CHAIN, modelConfig: aiText.writing().modelConfig });
    // The fixtures name the model they failed for, as Google's error URL does (the stub hands each `down` entry its model).
    const HIGH_DEMAND = (model = PRIMARY) => Object.assign(new Error(`[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent: [503 Service Unavailable] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.`), { status: 503, statusText: 'Service Unavailable' });
    const DEPLETED = (model = PRIMARY) => Object.assign(new Error(`[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent: [429 Too Many Requests] Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing. RESOURCE_EXHAUSTED`), { status: 429, statusText: 'Too Many Requests' });
    const stormOn = (...models) => { ai.down = {}; for (const m of models) ai.down[m] = HIGH_DEMAND; };
    // ⚠️ THE PER-MODEL CONFIG (aiText.writing().modelConfig): FB1 (gemini-2.5-flash) is called with thinking OFF —
    // thinkingConfig { thinkingBudget: 0 } merged over the lane's own config — and every other model gets the lane's
    // config OBJECT untouched, no thinkingConfig at all. `laneConfig` is the config the lane handed aiText for that call;
    // `models` / `configs` are the slices of ai.models / ai.configs that call produced.
    const configsRight = (laneConfig, models, configs) => models.length === configs.length && models.every((m, i) => (m === FB1
      ? configs[i] !== laneConfig && JSON.stringify(configs[i]) === JSON.stringify({ ...laneConfig, thinkingConfig: { thinkingBudget: 0 } })
      : configs[i] === laneConfig && !('thinkingConfig' in configs[i])));
    // The pause before the primary's second try is ~2 s in production: asserted, then shrunk so the suite stays fast —
    // and still MEASURED below, because "not back to back" is the whole bug.
    ok('the pause before the primary is asked again is ~2 s in production (2000 ms + ≤ 800 ms jitter)',
      aiText._internals.settings.retryWaitMs === 2000 && aiText._internals.settings.retryJitterMs === 800, aiText._internals.settings);
    const WAIT = 40;
    // ⚠️ Node's setTimeout can fire a millisecond EARLY by Date.now (measured: 4 of 300 40 ms sleeps landed under 40),
    // which failed this suite once in six runs while aiText had paused correctly. "Paused" is proven with a few ms of
    // slack — the same margin test-ai-text.js allows (>= 28 for its 30 ms wait) — never an exact equality with a timer.
    const PAUSED = WAIT - 3;
    aiText._internals.settings.retryWaitMs = WAIT; aiText._internals.settings.retryJitterMs = 0;
    const envFallbacks = process.env.AI_TEXT_FALLBACK_MODELS;
    delete process.env.AI_TEXT_FALLBACK_MODELS;
    // What each build ASKED aiText for (its lane, its clock, its caps, its config) — the lane calls aiText.generateText
    // through the module on every use, so it is wrapped here. `shrinkCaps` stands in for the 90 s / 45 s caps in (e) only;
    // `spentFrom` is the aiText call (1-based, suite-wide) from which the build's clock reads as spent, in (i) only.
    const asked = [];
    let shrinkCaps = null, spentFrom = Infinity;
    const realGenerate = aiText.generateText;
    aiText.generateText = (o) => {
      asked.push({ ...o, at: Date.now() });
      let sent = shrinkCaps ? { ...o, attemptCapsMs: shrinkCaps } : o;
      if (asked.length >= spentFrom) sent = { ...sent, budgetMs: 0 };
      return realGenerate(sent);
    };
    ent.consumeVia = 'plan'; ent.gate = { allowed: true, via: 'plan', remaining: 5 }; ent.gateSeq = []; conv.answer = null; brandSite.answer = null;
    // The research takes RESEARCH_MS here, so every doc build has spent that much of its clock before its first AI call —
    // a lane that handed aiText a FRESH 4.5 min per call (not the build's) is then visible in the budget it passed.
    const RESEARCH_MS = 80;
    research.delayMs = RESEARCH_MS;
    const lockCount = () => db.sql.filter((s) => /pg_advisory_xact_lock\(hashtext\('usage:'/.test(s)).length;
    const retryTicks = () => stages.filter((s) => s.stage === 'retry').map((s) => `${s.label}@${s.pct}`);
    const BUSY_WORDS = 'Google\'s AI is overloaded right now, so your resume could not be written. Nothing was charged — please try again in a minute.';
    const DOWN_WORDS = 'Our AI provider is unavailable right now. Nothing was charged.';
    const docFor = (company) => db.docs.find((d) => d.kind === 'resume' && d.employer_key === D.employerKeyOf(company));

    // (a) the storm on the primary: the fallback writes it.
    stormOn(PRIMARY);
    let s0 = snapshot(); let m0 = ai.models.length; let lock0 = lockCount(); let a0 = asked.length; stages.length = 0;
    const bA = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-30a', job: { company: 'Storm Co', website: 'https://storm-test.com' } }));
    const dA = docFor('Storm Co');
    ok(`⚠️ (a) a 503 storm on the primary (${PRIMARY}) → 200 all the same, the document written by the first fallback (${FB1})`,
      bA.statusCode === 200 && bA.body.cached === false && !!dA && dA.id === bA.body.docId && dA.model === FB1, { status: bA.statusCode, body: bA.body, model: dA && dA.model });
    ok('⚠️ …the primary asked TWICE with a real pause between (never back to back), then the first fallback: three calls',
      JSON.stringify(ai.models.slice(m0)) === JSON.stringify([PRIMARY, PRIMARY, FB1]) && ai.at[m0 + 1] - ai.at[m0] >= PAUSED,
      { models: ai.models.slice(m0), gapMs: ai.at[m0 + 1] - ai.at[m0] });
    ok('⚠️ …charged EXACTLY once and stored exactly once — the AI\'s retries cost nothing extra',
      ent.consumed.length - s0.consumed === 1 && db.docs.length - s0.docs === 1 && lockCount() - lock0 === 1 && refunds.length === s0.refunds,
      { consumed: ent.consumed.length - s0.consumed, docs: db.docs.length - s0.docs, locks: lockCount() - lock0 });
    ok('…every model was asked at the doc lane\'s 0.55, the fallback included', ai.temps.slice(-3).every((t) => t === 0.55), ai.temps.slice(-3));
    ok('⚠️ the bar said so in plain words, at the writing stage, never walking backwards: busy → trying again, then switching',
      JSON.stringify(retryTicks()) === JSON.stringify(['Google\'s AI is busy — trying again@40', 'Switching to a backup model@42'])
      && stages.map((s) => s.stage).join() === 'reading,researching,writing,retry,retry,designing,saving,pages', { ticks: retryTicks(), stages: stages.map((s) => s.stage) });
    const askA = asked.slice(a0);
    // ⚠️ REWRITTEN BY DESIGN (2026-09-18): this said "the lane's own chain" = [RESUME_MODEL, ...fallbackModels()]. The lane now
    // spreads aiText.writing(), so it must hand aiText EXACTLY that: the writing chain as `models` AND the per-model config
    // object as `modelConfig` (without it FB1 would think, at 3x the cost and lower judged quality). Its own `config` stays
    // the lane's — no thinkingConfig in it: thinking off is FB1's alone, laid over per model by aiText.
    ok('⚠️ one aiText call for the draft: lane resume_doc, aiText.writing()\'s chain AND its modelConfig, 90 s / 90 s / 45 s caps, JSON at 0.55',
      askA.length === 1 && askA[0].lane === 'resume_doc' && JSON.stringify(askA[0].models) === JSON.stringify([PRIMARY, FB1, FB2])
      && askA[0].modelConfig === aiText._internals.WRITING_MODEL_CONFIG
      && JSON.stringify(askA[0].attemptCapsMs) === JSON.stringify([90000, 90000, 45000]) && typeof askA[0].onRetry === 'function'
      && askA[0].config.temperature === 0.55 && askA[0].config.responseMimeType === 'application/json' && askA[0].config.maxOutputTokens === 32768
      && !('thinkingConfig' in askA[0].config),
      askA.map((o) => ({ lane: o.lane, models: o.models, modelConfig: o.modelConfig, caps: o.attemptCapsMs, config: o.config })));
    ok(`⚠️ …and each model got the RIGHT config: ${FB1} thinking OFF (thinkingBudget 0) over the lane's own, the primary the lane's config untouched`,
      askA.length === 1 && ai.models.slice(m0).includes(PRIMARY) && ai.models.slice(m0).includes(FB1)
      && configsRight(askA[0].config, ai.models.slice(m0), ai.configs.slice(m0)),
      { models: ai.models.slice(m0), configs: ai.configs.slice(m0) });
    ok('⚠️ …on the BUILD\'s clock: 4.5 min from the build\'s START, less the research it already waited for — not a fresh 4.5 min per call',
      askA.length === 1 && askA[0].budgetMs <= 270000 - RESEARCH_MS + 5 && askA[0].budgetMs > 240000, { budget: askA.map((o) => o.budgetMs), research: RESEARCH_MS });

    // (a2) the storm on the primary AND the first fallback: the SECOND fallback writes it. ⚠️ Added with the writing chain:
    // FB1's id is also RESUME_MODEL (the id a lane stores only when an answer comes back without one), so (a)'s stored id
    // alone cannot tell "the model that answered was stored" from "the default was stored". FB2's id is neither.
    stormOn(PRIMARY, FB1);
    s0 = snapshot(); m0 = ai.models.length; lock0 = lockCount(); a0 = asked.length; stages.length = 0;
    const bA3 = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-30a3', job: { company: 'Squall Co', website: 'https://squall-test.com' } }));
    const dA3 = docFor('Squall Co');
    ok(`⚠️ (a2) the primary AND ${FB1} storming → 200, written by the second fallback (${FB2}) and stored under ITS id, charged once`,
      bA3.statusCode === 200 && bA3.body.cached === false && !!dA3 && dA3.id === bA3.body.docId && dA3.model === FB2
      && ent.consumed.length - s0.consumed === 1 && db.docs.length - s0.docs === 1 && lockCount() - lock0 === 1,
      { status: bA3.statusCode, model: dA3 && dA3.model, consumed: ent.consumed.length - s0.consumed });
    ok('…the primary twice, then each fallback once, in chain order — and the second fallback, too, got the lane\'s config untouched',
      JSON.stringify(ai.models.slice(m0)) === JSON.stringify([PRIMARY, PRIMARY, FB1, FB2]) && asked.length - a0 === 1
      && configsRight(asked[a0].config, ai.models.slice(m0), ai.configs.slice(m0)),
      { models: ai.models.slice(m0), configs: ai.configs.slice(m0) });

    // (b) the fingerprint cannot see who wrote the document.
    stormOn();
    s0 = snapshot(); m0 = ai.models.length;
    const bB = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-30b', job: { company: 'Calm Co', website: 'https://storm-test.com' } }));
    const dB = docFor('Calm Co');
    ok('the same inputs with no storm: one call, written by the primary', bB.statusCode === 200 && !!dB && dB.model === PRIMARY && JSON.stringify(ai.models.slice(m0)) === JSON.stringify([PRIMARY]), { model: dB && dB.model, models: ai.models.slice(m0) });
    ok('⚠️ (b) the fallback-written document\'s fingerprint EQUALS the primary-written one (the model is in no fingerprint)',
      !!dA && !!dB && dA.input_fingerprint === dB.input_fingerprint, { a: dA && dA.input_fingerprint.slice(0, 12), b: dB && dB.input_fingerprint.slice(0, 12) });
    ok('…and it is the fingerprint the gate and /employer-docs/current compute for that job',
      !!dA && dA.input_fingerprint === await RB.currentResumeFingerprint(UID, { job: { title: '', url: '', description: '', website: 'https://storm-test.com' }, env: 'Production' }));
    stormOn(PRIMARY);   // still storming — a hit must not care
    s0 = snapshot();
    const bA2 = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-30a2', job: { company: 'Storm Co', website: 'https://storm-test.com' } }));
    ok('⚠️ …so the identical request later is a FREE cache hit: the same document, no AI, no gate, no charge, no store',
      bA2.statusCode === 200 && bA2.body.cached === true && !!dA && bA2.body.docId === dA.id && JSON.stringify(snapshot()) === JSON.stringify(s0), { body: bA2.body, before: s0, after: snapshot() });

    // (c) every model busy: 503 ai_busy, and nothing moved.
    stormOn(PRIMARY, FB1, FB2);
    s0 = snapshot(); m0 = ai.models.length; lock0 = lockCount(); stages.length = 0;
    const passes0 = JSON.stringify(db.passes), ledger0 = db.ledger.length, pages0 = pages.length;
    const bC = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-30c', job: { company: 'Gridlock Co', website: 'https://gridlock-test.com' } }));
    ok('⚠️ (c) every model busy → HTTP 503 { success:false, reason:\'ai_busy\', retryable:true } saying nothing was charged',
      bC.statusCode === 503 && JSON.stringify(bC.body) === JSON.stringify({ success: false, reason: 'ai_busy', retryable: true, error: BUSY_WORDS }), { status: bC.statusCode, body: bC.body });
    ok('…after the whole chain: the primary twice, then each fallback once — four calls, then it stops',
      JSON.stringify(ai.models.slice(m0)) === JSON.stringify([PRIMARY, PRIMARY, FB1, FB2]), ai.models.slice(m0));
    ok('⚠️ …NOTHING charged, NOTHING stored, NO usage lock taken, no pass stamped, no ledger row, nothing given back (nothing was taken)',
      ent.consumed.length === s0.consumed && db.docs.length === s0.docs && lockCount() === lock0 && JSON.stringify(db.passes) === passes0
      && db.ledger.length === ledger0 && refunds.length === s0.refunds && !docFor('Gridlock Co'),
      { consumed: ent.consumed.length - s0.consumed, docs: db.docs.length - s0.docs, locks: lockCount() - lock0 });
    ok('…a busy provider is not an outage: nobody paged', pages.length === pages0, pages.slice(pages0));
    ok('…and the bar said what was happening, three times, before the answer', JSON.stringify(retryTicks()) === JSON.stringify(['Google\'s AI is busy — trying again@40', 'Switching to a backup model@42', 'Switching to a backup model@44']), retryTicks());
    // The waiters. The résumé lanes keep no in-process FLIGHTS map (that is the letter lane's): what waits on a build is
    // the job the app polls (asJob) and the usage lock's queue. The lock was never taken (above); the job must end NOW,
    // failed WITH its reason, so the poller stops at once and the app can say what happened — not spin for six minutes.
    const wrapped = asJob('resume_generate_ai')(RB.generateAI);
    const failed0 = (db.failedJobs || []).length;
    s0 = snapshot();
    const accepted = await call(wrapped, buildBody({ __async: true, clientBuildId: 'cb-30c-async', job: { company: 'Gridlock Co', website: 'https://gridlock-test.com' } }));
    const until = async (cond, ms = 5000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); return cond(); };
    const settled = await until(() => (db.failedJobs || []).length > failed0);
    const fj = settled ? db.failedJobs[db.failedJobs.length - 1] : null;
    ok('⚠️ through the real asJob: 202 at once, then the job FAILED with reason ai_busy and the same sentence — its poller released',
      accepted.statusCode === 202 && accepted.body.jobId === 'job1' && !!fj && fj.id === 'job1' && fj.result.reason === 'ai_busy' && fj.error === BUSY_WORDS && fj.result.error === BUSY_WORDS,
      { accepted: accepted.body, failed: fj });
    ok('…and nothing charged or stored on that path either', ent.consumed.length === s0.consumed && db.docs.length === s0.docs && jobs.completed.length === 0, { consumed: ent.consumed.length - s0.consumed });

    // (d) the key: out of credit, or missing. Every model shares it, so one call is all it takes to know.
    ai.down = { [PRIMARY]: DEPLETED, [FB1]: DEPLETED, [FB2]: DEPLETED };
    s0 = snapshot(); m0 = ai.models.length; lock0 = lockCount();
    const pagesQ = pages.length;
    const bD = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-30d', job: { company: 'Depleted Co', website: 'https://depleted-test.com' } }));
    ok('⚠️ (d) quota → 503 { reason:\'ai_down\', retryable:false } — Try again cannot work until the operator acts',
      bD.statusCode === 503 && JSON.stringify(bD.body) === JSON.stringify({ success: false, reason: 'ai_down', retryable: false, error: DOWN_WORDS }), { status: bD.statusCode, body: bD.body });
    ok('…FAIL FAST: ONE call (no second model, no retry), nothing charged, stored or locked',
      JSON.stringify(ai.models.slice(m0)) === JSON.stringify([PRIMARY]) && ent.consumed.length === s0.consumed && db.docs.length === s0.docs && lockCount() === lock0,
      { models: ai.models.slice(m0), consumed: ent.consumed.length - s0.consumed });
    ok('…and the operator is PAGED (aiHealth → adminNotifier), kind quota', pages.length === pagesQ + 1 && pages[pages.length - 1].data && pages[pages.length - 1].data.kind === 'quota', pages.slice(pagesQ));
    ai.down = {};
    const realKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    s0 = snapshot();
    let bKey;
    try { bKey = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-30d2', job: { company: 'Keyless Co', website: 'https://keyless-test.com' } })); }
    finally { process.env.GEMINI_API_KEY = realKey; }
    ok('a missing GEMINI_API_KEY is ai_down too — before any call, nothing charged or stored',
      bKey.statusCode === 503 && bKey.body.reason === 'ai_down' && bKey.body.retryable === false && ai.calls === s0.ai && ent.consumed.length === s0.consumed && db.docs.length === s0.docs, bKey.body);

    // (e) a model that HANGS: the cap aborts it and the next model answers (the caps shrunk from 90 s / 45 s to 60 ms).
    ai.down = { [PRIMARY]: () => 'hang' };
    shrinkCaps = [60, 60, 60];
    s0 = snapshot(); m0 = ai.models.length;
    const tE = Date.now();
    const bE = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-30e', job: { company: 'Hung Co', website: 'https://hung-test.com' } }));
    shrinkCaps = null;
    ok('⚠️ (e) a hung primary no longer fails the build (it was a 504 after 90 s): capped twice, the fallback writes it, charged once',
      bE.statusCode === 200 && (docFor('Hung Co') || {}).model === FB1 && JSON.stringify(ai.models.slice(m0)) === JSON.stringify([PRIMARY, PRIMARY, FB1])
      && ent.consumed.length - s0.consumed === 1 && Date.now() - tE < 3000, { status: bE.statusCode, models: ai.models.slice(m0), ms: Date.now() - tE });

    // (i) the lane's OWN retry (an answer that was not a résumé) finds the build's clock spent: aiText makes no call and
    // throws busy with no attempts. What failed is the answer the lane rejected — so it is today's 500 'failed', never an
    // "overloaded" story about a provider nobody asked.
    ai.down = {};
    ai.queue.push(() => JSON.stringify({ not: 'a resume' }));
    spentFrom = asked.length + 2;
    s0 = snapshot(); m0 = ai.models.length;
    const bI = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-30i', job: { company: 'Late Co', website: 'https://late-test.com' } }));
    spentFrom = Infinity;
    ok('(i) a rejected answer, then no clock left for the lane\'s own retry → 500 failed (the answer failed, not Google), nothing charged',
      bI.statusCode === 500 && bI.body.reason === 'failed' && ai.models.length - m0 === 1 && ent.consumed.length === s0.consumed && db.docs.length === s0.docs,
      { status: bI.statusCode, body: bI.body, calls: ai.models.length - m0 });

    // (f) the corrective pass. A generic draft (the title unchanged, the sector known) earns the one pass; the storm starts
    // as the draft is answered, so it is the PASS that meets it.
    const GENERIC = () => JSON.stringify(RESUME({ personal_info: { ...RESUME().personal_info, title: 'Backend Engineer' } }));
    ai.down = {};
    ai.queue.push(() => { stormOn(PRIMARY); return GENERIC(); });
    ai.queue.push(() => JSON.stringify(RESUME({ personal_info: { ...RESUME().personal_info, title: 'Backend Engineer — Retail Platforms' } })));
    s0 = snapshot(); m0 = ai.models.length; a0 = asked.length; stages.length = 0;
    const bF = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-30f', job: { company: 'Polish Co', website: 'https://polish-test.com' } }));
    const dF = docFor('Polish Co');
    ok('⚠️ (f) the pass meets the storm, falls back, and its answer is taken: stored as written BY THE FALLBACK, charged once',
      bF.statusCode === 200 && !!dF && dF.payload.personal_info.title === 'Backend Engineer — Retail Platforms' && dF.model === FB1
      && JSON.stringify(ai.models.slice(m0)) === JSON.stringify([PRIMARY, PRIMARY, PRIMARY, FB1]) && ent.consumed.length - s0.consumed === 1,
      { title: dF && dF.payload.personal_info.title, model: dF && dF.model, models: ai.models.slice(m0) });
    const askF = asked.slice(a0);
    ok('⚠️ …the draft and the pass share ONE clock: the pass\'s budget is what the draft\'s had left',
      askF.length === 2 && askF[1].budgetMs <= askF[0].budgetMs - (askF[1].at - askF[0].at) + 5 && askF[1].budgetMs <= 270000 - RESEARCH_MS + 5 && askF[1].lane === 'resume_doc',
      askF.map((o) => ({ lane: o.lane, budget: o.budgetMs, at: o.at - askF[0].at })));
    ok('…and the bar re-labelled the POLISHING stage, never behind it', JSON.stringify(retryTicks()) === JSON.stringify(['Google\'s AI is busy — trying again@72', 'Switching to a backup model@74'])
      && stages.map((s) => s.stage).join() === 'reading,researching,writing,polishing,retry,retry,designing,saving,pages', { ticks: retryTicks(), stages: stages.map((s) => s.stage) });
    ai.down = {};
    ai.queue.push(() => { stormOn(PRIMARY, FB1, FB2); return GENERIC(); });
    s0 = snapshot(); m0 = ai.models.length;
    const bF2 = await call(RB.generateAI, buildBody({ clientBuildId: 'cb-30f2', job: { company: 'Keepsake Co', website: 'https://keepsake-test.com' } }));
    const dF2 = docFor('Keepsake Co');
    ok('⚠️ …and when EVERY model is busy for the pass, the first draft is delivered as before: 200, stored as the primary wrote it, charged once',
      bF2.statusCode === 200 && !!dF2 && dF2.payload.personal_info.title === 'Backend Engineer' && dF2.model === PRIMARY
      && JSON.stringify(ai.models.slice(m0)) === JSON.stringify([PRIMARY, PRIMARY, PRIMARY, FB1, FB2]) && ent.consumed.length - s0.consumed === 1,
      { status: bF2.statusCode, model: dF2 && dF2.model, models: ai.models.slice(m0) });
    ai.down = {};

    // (g) the builder lane — POST /generate-ai with no saveTo: the user's one resume row, and its cached copy per employer.
    const builderBody = (company, over = {}) => ({ __async: false, coveredOnly: true, rawText: BASE_TEXT, name: 'Harness User', email: 'h@u.test', phone: '+91 1', location: 'Pune', includeUploadedResume: true, job: { company, website: 'https://builder-storm-test.com' }, ...over });
    const savedRows = () => db.userResumesTouched.filter((q) => /^INSERT INTO user_resumes/.test(q)).length;
    stormOn(PRIMARY);
    s0 = snapshot(); m0 = ai.models.length; a0 = asked.length; lock0 = lockCount(); let saved0 = savedRows(); stages.length = 0;
    const gA = await call(RB.generateAI, builderBody('Builder Storm Co'));
    const gDoc = docFor('Builder Storm Co');
    ok('⚠️ (g) builder lane, a 503 storm on the primary → 200 with the resume, saved, cached with the FALLBACK named, charged once',
      gA.statusCode === 200 && gA.body.success === true && gA.body.cached === false && !!(gA.body.resumeData && gA.body.resumeData.personal_info)
      && savedRows() - saved0 === 1 && !!gDoc && gDoc.model === FB1 && ent.consumed.length - s0.consumed === 1 && lockCount() - lock0 === 1,
      { status: gA.statusCode, model: gDoc && gDoc.model, consumed: ent.consumed.length - s0.consumed, saved: savedRows() - saved0 });
    ok(`…the primary twice (a real pause), then the first fallback (${FB1}), at the builder's own 0.4, reported as the builder's own retries`,
      JSON.stringify(ai.models.slice(m0)) === JSON.stringify([PRIMARY, PRIMARY, FB1]) && ai.at[m0 + 1] - ai.at[m0] >= PAUSED && ai.temps.slice(-3).every((t) => t === 0.4)
      && JSON.stringify(retryTicks()) === JSON.stringify(['Google\'s AI is busy — trying again@40', 'Switching to a backup model@42'])
      && asked.length - a0 === 1 && asked[a0].lane === 'resume_builder' && asked[a0].budgetMs <= 270000, { models: ai.models.slice(m0), ticks: retryTicks(), lane: asked[a0] && asked[a0].lane });
    // ⚠️ Added with the writing chain: the builder lane shares callGemini with the doc lane, so it too must hand aiText the
    // writing chain AND its modelConfig — and FB1 must meet the builder's 0.4 config with thinking OFF laid over it.
    ok(`⚠️ …the builder lane hands aiText aiText.writing()'s chain AND modelConfig: ${FB1} thinking OFF over the builder's own 0.4 config, the primary that config untouched`,
      asked.length - a0 === 1 && JSON.stringify(asked[a0].models) === JSON.stringify([PRIMARY, FB1, FB2]) && asked[a0].modelConfig === aiText._internals.WRITING_MODEL_CONFIG
      && asked[a0].config.temperature === 0.4 && !('thinkingConfig' in asked[a0].config)
      && configsRight(asked[a0].config, ai.models.slice(m0), ai.configs.slice(m0)),
      { asked: asked[a0] && { models: asked[a0].models, modelConfig: asked[a0].modelConfig, config: asked[a0].config }, configs: ai.configs.slice(m0) });
    stormOn();
    s0 = snapshot(); m0 = ai.models.length;
    const gB = await call(RB.generateAI, builderBody('Builder Calm Co'));
    ok('⚠️ …its cached copy\'s fingerprint equals the primary-written one, and the identical request is then a FREE hit',
      gB.statusCode === 200 && (docFor('Builder Calm Co') || {}).model === PRIMARY && !!gDoc && (docFor('Builder Calm Co') || {}).input_fingerprint === gDoc.input_fingerprint, { model: (docFor('Builder Calm Co') || {}).model });
    s0 = snapshot();
    const gA2 = await call(RB.generateAI, builderBody('Builder Storm Co'));
    ok('…(the hit: no AI, no charge, no new document)', gA2.statusCode === 200 && gA2.body.cached === true && ai.calls === s0.ai && ent.consumed.length === s0.consumed && db.docs.length === s0.docs, gA2.body);
    stormOn(PRIMARY, FB1, FB2);
    s0 = snapshot(); m0 = ai.models.length; lock0 = lockCount(); saved0 = savedRows();
    const gC = await call(RB.generateAI, builderBody('Builder Gridlock Co'));
    ok('⚠️ …every model busy → 503 ai_busy with the same sentence; NOTHING charged, NOTHING saved or cached, no lock taken',
      gC.statusCode === 503 && JSON.stringify(gC.body) === JSON.stringify({ success: false, reason: 'ai_busy', retryable: true, error: BUSY_WORDS })
      && JSON.stringify(ai.models.slice(m0)) === JSON.stringify([PRIMARY, PRIMARY, FB1, FB2])
      && ent.consumed.length === s0.consumed && savedRows() === saved0 && !docFor('Builder Gridlock Co') && lockCount() === lock0,
      { status: gC.statusCode, body: gC.body, consumed: ent.consumed.length - s0.consumed, saved: savedRows() - saved0 });
    // The operator's switch: "primary only" again, without a deploy — honoured by the lane.
    // ⚠️ REWRITTEN BY DESIGN (2026-09-18): the switch was AI_TEXT_FALLBACK_MODELS=none while the lanes walked
    // [RESUME_MODEL, ...fallbackModels()]. The writing chain has its OWN knobs (aiText.writingChain): the switch for the
    // document lanes is AI_WRITING_FALLBACK_MODELS=none, and AI_TEXT_FALLBACK_MODELS (the research lanes' list) no longer
    // reaches them — so it is asserted both ways: the writing switch cuts the chain, the research switch leaves it whole.
    process.env.AI_WRITING_FALLBACK_MODELS = 'none';
    stormOn(PRIMARY);
    m0 = ai.models.length;
    let gOff;
    try { gOff = await call(RB.generateAI, builderBody('Builder Switch Co')); }
    finally { delete process.env.AI_WRITING_FALLBACK_MODELS; }
    ok('…and AI_WRITING_FALLBACK_MODELS=none leaves the primary alone: asked twice, then 503 ai_busy', gOff.statusCode === 503 && gOff.body.reason === 'ai_busy' && JSON.stringify(ai.models.slice(m0)) === JSON.stringify([PRIMARY, PRIMARY]), ai.models.slice(m0));
    process.env.AI_TEXT_FALLBACK_MODELS = 'none';
    stormOn(PRIMARY);
    m0 = ai.models.length; s0 = snapshot();
    let gText;
    try { gText = await call(RB.generateAI, builderBody('Builder Research Switch Co')); }
    finally { delete process.env.AI_TEXT_FALLBACK_MODELS; }
    ok(`…while AI_TEXT_FALLBACK_MODELS=none (the research lanes' switch) no longer cuts the writing chain: the primary twice, then ${FB1} writes it, charged once`,
      gText.statusCode === 200 && (docFor('Builder Research Switch Co') || {}).model === FB1
      && JSON.stringify(ai.models.slice(m0)) === JSON.stringify([PRIMARY, PRIMARY, FB1]) && ent.consumed.length - s0.consumed === 1,
      { status: gText.statusCode, models: ai.models.slice(m0), model: (docFor('Builder Research Switch Co') || {}).model });
    ai.down = {};

    // (h) the money, in code. ⚠️ A bump of any of these re-bills every saved document: the model id must not need one.
    const letterSrc = fsSync.readFileSync(path.join(ROOT, 'server/controllers/employerLetterController.js'), 'utf8');
    ok('⚠️ (h) RESEARCH_REV r1, FP_VERSION v1, LETTER_REV letter-v1 — none moved (a fallback costs nobody a re-bill)',
      ER.RESEARCH_REV === 'r1' && realDocs.FP_VERSION === 'v1' && /const LETTER_REV = 'letter-v1';/.test(letterSrc), { research: ER.RESEARCH_REV, fp: realDocs.FP_VERSION });
    const src30 = fsSync.readFileSync(path.join(ROOT, 'server/controllers/resumeBuilderController.js'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const fpFn = src30.slice(src30.indexOf('async function generationFingerprint'), src30.indexOf('function docResearchRev'));
    ok('⚠️ …the fingerprint function names no model (builder RESEARCH_REV still \'none\')',
      fpFn.length > 200 && !/model|RESUME_MODEL|writtenBy/i.test(fpFn) && /const RESEARCH_REV = 'none';/.test(src30), fpFn.length);
    const docLane = src30.slice(src30.indexOf('async function generateEmployerDoc'), src30.indexOf('async function passWouldCoverResume'));
    const builderLane = src30.slice(src30.indexOf('async function generateAI'), src30.indexOf('async function generateEmployerDoc'));
    ok('⚠️ …every AI call sits BEFORE the usage lock and the charge, in both lanes, and the model that answered is what is stored',
      docLane.indexOf('await withResumeAi(docAi, () => writeDocDraft(') > 0 && docLane.indexOf('await withResumeAi(docAi, () => correctDocDraft(') > 0
      && docLane.indexOf('await withResumeAi(docAi, () => correctDocDraft(') < docLane.indexOf('await withUsageLock(')
      && builderLane.indexOf("await withResumeAi({ lane: 'resume_builder'") > 0 && builderLane.indexOf("await withResumeAi({ lane: 'resume_builder'") < builderLane.indexOf('await withUsageLock(')
      && /model: writtenBy \|\| RESUME_MODEL, payload: resumeData, research/.test(docLane) && /model: writtenBy \|\| RESUME_MODEL, payload: resumeData, env/.test(builderLane)
      && !/model: RESUME_MODEL/.test(src30));
    ok('⚠️ …and no résumé call reaches the SDK except through aiText (no getGenerativeModel of its own, no bare 90 s race)',
      !/getGenerativeModel|generativelanguage|require\('@google\/generative-ai'\)/.test(src30) && /aiText\.generateText\(\{/.test(src30));
    // "Nothing was charged" is a promise the catch makes. It holds because every AI call runs before the charge — and
    // the catch now CHECKS that (paymentBegun, set as the payment step begins) instead of trusting it: an AI call
    // someone later adds after the charge would fall to the plain 500, never to a sentence that is no longer true.
    ok('⚠️ …and each lane\'s catch promises "Nothing was charged" ONLY while no payment step has begun (checked, not assumed)',
      [builderLane, docLane].every((lane) => /let paymentBegun = false;/.test(lane)
        && lane.indexOf('paymentBegun = true;') > 0 && lane.indexOf('paymentBegun = true;') < lane.indexOf('await withUsageLock(')
        && /const unavailable = paymentBegun \? null : resumeAiUnavailableAnswer\(e\);/.test(lane)));

    aiText.generateText = realGenerate;
    research.delayMs = 0;
    aiText._internals.settings.retryWaitMs = 2000; aiText._internals.settings.retryJitterMs = 800;
    if (envFallbacks === undefined) delete process.env.AI_TEXT_FALLBACK_MODELS; else process.env.AI_TEXT_FALLBACK_MODELS = envFallbacks;
    if (envWritingModel === undefined) delete process.env.AI_WRITING_MODEL; else process.env.AI_WRITING_MODEL = envWritingModel;
    if (envWritingFallbacks === undefined) delete process.env.AI_WRITING_FALLBACK_MODELS; else process.env.AI_WRITING_FALLBACK_MODELS = envWritingFallbacks;
    ai.down = {};
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
