// ONE PURCHASE, ONE EMPLOYER — the integration test.
//
//   node server/scripts/test-single-purchase-flow.js
//
// test-download-passes.js proves services/downloads.js in isolation. It says nothing about whether
// the CONTROLLERS actually call it — which is where a customer's money is really spent. This drives
// the real route handlers (resumeBuilderController.generateAI / generatePDF / generateDocx, and
// coverLetterController.generateCoverLetters / generateCoverLetterTemplatePdf) against a stubbed
// database and a stubbed AI, with fake req/res, and counts what each one costs.
//
// Same stubbing technique as test-download-passes.js: require.cache is pre-populated BEFORE the
// module under test is loaded, so nothing opens a socket and no real AI call is ever made.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; failures.push(n); console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 300) : '')); }
};
const note = (n, x) => console.log('  · ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 300) : ''));

process.env.GEMINI_API_KEY = 'test-key-not-used';   // callGemini refuses without one; the SDK is stubbed
process.env.USE_ASYNC_JOBS = 'false';               // drive the synchronous lane

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE FAKE WORLD
// ══════════════════════════════════════════════════════════════════════════════════════════════════

// What the AI was asked to do. Every counter here must stay flat across downloads.
// `holds` (T17+): a letter whose subject contains `match` waits inside the model call until released — the moment a
// user taps Cancel, or a second copy of the request arrives. `researchHang`: the researcher never answers (T19).
const ai = { resumeCalls: 0, letterCalls: 0, researchCalls: 0, letterFailOn: null, models: [], configs: [], failModel: null, holds: [], researchHang: false };
const holdLetter = (match) => { const h = { match, entered: false }; h.promise = new Promise((r) => { h.release = r; }); ai.holds.push(h); return h; };
// T17: the worker paused AFTER the charge (inside the notification that follows it), for user `u`.
const notifyHolds = [];
const holdNotify = (u) => { const h = { u, entered: false }; h.promise = new Promise((r) => { h.release = r; }); notifyHolds.push(h); return h; };

// What was actually rendered — "bytes exist" is asserted with these, not with the HTTP status.
const rendered = { pdf: 0, docx: 0, clPdf: 0, clDocx: 0 };

// The database. Only the tables these paths touch, and download_passes behaves like the real one:
// one conditional UPDATE binds the OLDEST unbound row, and only if there is one.
const db = {
  passes: [],            // { id, user_id, environment, employer_key, employer_name, bound_at, created_at }
  nextPassId: 1,
  claimUpdates: 0,       // how many times the binding UPDATE actually ran
  boundWrites: [],       // every successful bind: { user_id, employer_key }
  log: [],
  runs: [],              // every run(): { sql, params } — the writes a refusal must not make
  hubJob: null,          // the one jobs row the Job Hub letter lane (T16) reads
  resumeRow: { resume_data: { personal_info: { full_name: 'Test User', email: 't@e.st' }, experience: [], _buildMethod: 'ai' }, regen_count: 0 },
  asyncJobs: new Map(),  // T17+: async_jobs, as the REAL jobService writes it (see asyncJobsSql)
  nextAsyncJob: 1,
  creditsThrow: false,   // T20: the credit balance read fails (a dropped connection) — after the charge
};
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ── async_jobs, honouring EXACTLY the clauses it is sent (T17+) ──────────────────────────────────────────
// The REAL jobService / coverLetterController SQL runs against this. Every guard is honoured only when the statement
// carries it — so a guard dropped from the code is a guard dropped here too, and the test that relies on it fails.
// Rows made by the stub createJob ('jobN') are not in here, and every statement on them is a no-op.
function asyncJobsSql(q, p = []) {
  if (!/async_jobs/.test(q)) return undefined;
  const J = db.asyncJobs;
  const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return v; } };
  const guardCancel = / AND status <> 'cancelled'/.test(q);
  if (/^INSERT INTO async_jobs \(user_id, type, status, progress, input\) VALUES \(\$1, \$2, 'pending', 0, \$3\) RETURNING id$/.test(q)) {
    const id = 'aj-' + (db.nextAsyncJob++);
    J.set(id, { id, user_id: p[0], type: p[1], status: 'pending', progress: 0, input: parse(p[2]), result: null, error: null, created_at: new Date() });
    return [{ id }];
  }
  if (/^SELECT id, user_id, type, status, progress, result, error, created_at, updated_at FROM async_jobs WHERE id = \$1 AND user_id = \$2$/.test(q)) {
    const r = J.get(p[0]); return r && r.user_id === p[1] ? { ...r } : null;
  }
  if (/^SELECT status FROM async_jobs WHERE id = \$1$/.test(q)) { const r = J.get(p[0]); return r ? { status: r.status } : null; }
  if (/^SELECT id FROM async_jobs WHERE user_id = \$1 AND type = 'generate_cover_letter' AND input->>'clientBuildId' = \$2/.test(q)) {
    const skipDead = /status NOT IN \('failed', 'cancelled'\)/.test(q);
    const hit = [...J.values()].filter((r) => r.user_id === p[0] && r.type === 'generate_cover_letter' && r.input && r.input.clientBuildId === p[1]
      && Date.now() - r.created_at.getTime() < 15 * 60 * 1000 && (!skipDead || (r.status !== 'failed' && r.status !== 'cancelled'))).pop();
    return hit ? { id: hit.id } : null;
  }
  const row = (id) => J.get(id);
  let m;
  if (/^UPDATE async_jobs SET status = 'processing'/.test(q)) { const r = row(p[0]); if (r && !(guardCancel && r.status === 'cancelled')) r.status = 'processing'; return null; }
  if (/^UPDATE async_jobs SET progress = \$1/.test(q)) { const r = row(p[1]); if (r) r.progress = p[0]; return null; }
  if (/^UPDATE async_jobs SET result = \$1, updated_at/.test(q)) { const r = row(p[1]); if (r) r.result = parse(p[0]); return null; }
  if ((m = /^UPDATE async_jobs SET status = (CASE WHEN status = 'cancelled' THEN status ELSE 'completed' END|'completed'), progress = 100, result = \$1/.exec(q))) {
    const r = row(p[1]); if (r) { r.status = (m[1].startsWith('CASE') && r.status === 'cancelled') ? 'cancelled' : 'completed'; r.result = parse(p[0]); } return null;
  }
  if (/^UPDATE async_jobs SET status = 'failed', error = \$1, result = \$2/.test(q)) {
    const r = row(p[2]); if (r && !(guardCancel && r.status === 'cancelled')) { r.status = 'failed'; r.error = p[0]; r.result = parse(p[1]); } return null;
  }
  if (/^UPDATE async_jobs SET status = 'failed', error = \$1, updated_at = CURRENT_TIMESTAMP WHERE id = \$2/.test(q)) {
    const r = row(p[1]); if (r && !(guardCancel && r.status === 'cancelled')) { r.status = 'failed'; r.error = p[0]; } return null;
  }
  if (/^UPDATE async_jobs SET status = 'cancelled'/.test(q)) {
    const r = row(p[0]);
    const chargedGuard = /COALESCE\(result->>'stage', ''\) <> 'charged'/.test(q);
    const types = Array.isArray(p[3]) ? p[3] : null;
    if (!r || r.user_id !== p[1] || !['pending', 'processing'].includes(r.status) || (types && !types.includes(r.type))
      || (chargedGuard && r.result && r.result.stage === 'charged')) return [];
    r.status = 'cancelled'; r.error = p[2];
    return [{ id: r.id }];
  }
  return undefined;
}

async function dbGet(sql, params = []) {
  const q = norm(sql);
  db.log.push(q.slice(0, 90));
  const aj = asyncJobsSql(q, params);
  if (aj !== undefined) return aj;

  // ── download_passes: the money table ──────────────────────────────────────────────────────────
  // ⚠️ "unspent" now includes a pass bound to the '(none)' scope: a download that named no company
  // is CHARGED (or the gate would be saying yes to something the claim declines to bill) but into a
  // scope no employer occupies, so the first named download or generation takes it over.
  const takeable = (p, uid, env) => p.user_id === uid && p.environment === env && (!p.bound_at || p.employer_key === '(none)');
  const oldestTakeable = (uid, env) => db.passes
    .filter((p) => takeable(p, uid, env))
    .sort((a, b) => (b.bound_at ? 1 : 0) - (a.bound_at ? 1 : 0) || a.created_at - b.created_at)[0];

  if (/SELECT COUNT\(\*\)::int AS n FROM download_passes/.test(q)) {
    const [uid, env] = params;
    return { n: db.passes.filter((p) => takeable(p, uid, env)).length };
  }
  // boundPassFor, exact key.
  if (/SELECT id, employer_name, employer_key FROM download_passes WHERE user_id = \$1 AND employer_key = \$2/.test(q)) {
    const [uid, key, env] = params;
    return db.passes.find((p) => p.user_id === uid && p.employer_key === key && p.environment === env && p.bound_at) || null;
  }
  // boundPassFor, the alias scan (a query(), so it is served through dbQuery below).
  if (/SELECT id, employer_name, employer_key FROM download_passes WHERE user_id = \$1 AND environment = \$2 AND bound_at IS NOT NULL/.test(q)) {
    const [uid, env, none] = params;
    return db.passes.filter((p) => p.user_id === uid && p.environment === env && p.bound_at && p.employer_key !== none);
  }
  // passCoversGeneration: is this specific pass's generation still unused?
  if (/^SELECT id FROM download_passes WHERE id = \$1 AND \w+ IS NULL/.test(q)) {
    const col = q.match(/AND (\w+) IS NULL/)[1];
    const row = db.passes.find((p) => p.id === params[0]);
    return row && !row[col] ? { id: row.id } : null;
  }
  // claimGeneration, on a pass already bound to this employer: stamp only.
  if (/^UPDATE download_passes SET \w+ = NOW\(\) WHERE id = \( SELECT id FROM download_passes WHERE id = \$1/.test(q)) {
    const col = q.match(/SET (\w+) = NOW/)[1];
    const row = db.passes.find((p) => p.id === params[0]);
    if (!row || row[col]) return null;
    row[col] = Date.now();
    return { id: row.id };
  }
  // claimGeneration, taking an unspent pass: stamp AND bind, in one update.
  if (/^UPDATE download_passes SET \w+ = NOW\(\), employer_key = \$3/.test(q)) {
    const col = q.match(/SET (\w+) = NOW/)[1];
    const [uid, env, key, name] = params;
    const row = db.passes
      .filter((p) => takeable(p, uid, env) && !p[col])
      .sort((a, b) => (b.bound_at ? 1 : 0) - (a.bound_at ? 1 : 0) || a.created_at - b.created_at)[0];
    if (!row) return null;
    row[col] = Date.now(); row.employer_key = key; row.employer_name = name; row.bound_at = Date.now();
    db.boundWrites.push({ user_id: uid, employer_key: key });
    return { id: row.id };
  }
  // passCoversGeneration: RESERVE — bind an unspent pass at the gate, without stamping anything.
  if (/^UPDATE download_passes SET employer_key = \$3, employer_name = \$4, bound_at = NOW\(\)/.test(q)) {
    const col = (q.match(/AND (\w+) IS NULL/) || [])[1];
    const [uid, env, key, name] = params;
    const row = db.passes
      .filter((p) => takeable(p, uid, env) && (!col || !p[col]))
      .sort((a, b) => (b.bound_at ? 1 : 0) - (a.bound_at ? 1 : 0) || a.created_at - b.created_at)[0];
    if (!row) return null;
    row.employer_key = key; row.employer_name = name; row.bound_at = Date.now();
    db.boundWrites.push({ user_id: uid, employer_key: key });
    return { id: row.id };
  }
  // claimDownload: bind an unspent pass to this employer.
  if (/^UPDATE download_passes SET employer_key = \$2, employer_name = \$3, bound_at = NOW\(\)/.test(q)) {
    db.claimUpdates++;
    const [uid, key, name, env] = params;
    const row = oldestTakeable(uid, env);
    if (!row) return null;
    row.employer_key = key; row.employer_name = name; row.bound_at = Date.now();
    db.boundWrites.push({ user_id: uid, employer_key: key });
    return { id: row.id };
  }
  if (/INSERT INTO download_passes/.test(q)) {
    const [uid, store, env, txn, product] = params;
    if (db.passes.some((p) => p.store === store && p.environment === env && p.store_txn_id === txn)) return null;
    const row = { id: db.nextPassId++, user_id: uid, store, environment: env, store_txn_id: txn, product_id: product, employer_key: null, employer_name: null, bound_at: null, created_at: Date.now() + db.nextPassId };
    db.passes.push(row);
    return { id: row.id };
  }

  // ── everything else the handlers read ─────────────────────────────────────────────────────────
  if (/FROM user_resumes/.test(q)) return db.resumeRow;
  if (/FROM resume_metadata/.test(q)) return { id: 1, user_id: params[0], parse_status: 'done', full_name: 'Test User', skills: '["node"]' };
  if (/FROM user_credits/.test(q)) {
    if (db.creditsThrow) throw new Error('Connection terminated unexpectedly');
    return { credits_remaining: 0, expiry_date: null };
  }
  if (/FROM users/.test(q)) return { id: params[0], full_name: 'Test User', email: 't@e.st', phone_number: '1', city: 'Pune', country: 'IN', photo_path: null, resume_path: '/uploads/r.pdf', total_generated: 0 };
  if (/FROM employer_brand_profiles/.test(q)) return null;
  if (/FROM jobs WHERE id = \$1/.test(q) && db.hubJob && String(params[0]) === String(db.hubJob.id)) return db.hubJob;
  if (/FROM jobs/.test(q)) return null;
  return null;
}
const advisoryLocks = new Map();   // key → the promise the next holder waits on (see withTransaction)
const dbPath = require.resolve(path.join(ROOT, 'db-config.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  get: dbGet,
  // The alias scan is the one query() the money path makes; everything else reads nothing.
  query: async (sql, params) => { const r = await dbGet(sql, params); return Array.isArray(r) ? r : []; },
  run: async (sql, params) => { db.log.push('RUN ' + norm(sql).slice(0, 70)); db.runs.push({ sql: norm(sql), params }); asyncJobsSql(norm(sql), params || []); return {}; },
  // T17: with db.serialiseLocks on, pg_advisory_xact_lock really serialises (per key, until the transaction ends) —
  // what a cancel racing a charge needs to be tested against. Off, the transaction is the plain pass-through it was.
  withTransaction: async (fn) => {
    let release = null;
    const tx = { get: async (sql, params) => {
      if (db.serialiseLocks && /pg_advisory_xact_lock/.test(norm(sql))) {
        const key = JSON.stringify(params || []);
        const prev = advisoryLocks.get(key) || Promise.resolve();
        let rel; const mine = new Promise((r) => { rel = r; });
        advisoryLocks.set(key, prev.then(() => mine));
        await prev;
        release = rel;
      }
      return dbGet(sql, params);
    }, run: async () => ({}) };
    try { return await fn(tx); } finally { if (release) release(); }
  },
  isUniqueViolation: () => false, getDbType: () => 'postgres',
} };

// ── entitlements: the PLAN side of the money. `sub` null = no plan; the free allowance is a gate. ─
// ⚠️ consumeFor (2026-09-14): what consumeOnSuccess answers, per call. Unset = { via: 'plan' }, as before. The real
// shapes: 'none' (nothing left that may pay — NO usage row) and 'error' are { via, charge: null, ledgerId: null }.
// Only a payment lands in `consumed`; every call, paid or not, lands in `attempts` with the options it was given.
const ent = { sub: null, gate: { allowed: true, remaining: 5 }, consumed: [], attempts: [], consumeFor: null, ledgerMax: 0, consumeHolds: [] };
// T17: user `u`'s charge pauses inside consumeOnSuccess — the worker is then INSIDE the usage lock, past its cancel read.
const holdConsume = (u) => { const h = { u, entered: false }; h.promise = new Promise((r) => { h.release = r; }); ent.consumeHolds.push(h); return h; };
const entPath = require.resolve(path.join(ROOT, 'server', 'services', 'entitlements.js'));
require.cache[entPath] = { id: entPath, filename: entPath, loaded: true, exports: {
  activeSubscription: async () => ent.sub,
  canConsumeMany: async () => ent.gate,
  consumeOnSuccess: async (u, kind, detail, opts) => {
    const hold = ent.consumeHolds.find((h) => h.u === u);
    if (hold) { hold.entered = true; await hold.promise; }
    const via = ent.consumeFor ? ent.consumeFor(u, kind, detail || {}) : 'plan';
    ent.attempts.push({ u, kind, detail, opts, via, at: db.log.length });
    if (via === 'none' || via === 'error') return { via, charge: null, ledgerId: null };
    // 'error' that still wrote its usage row first — the give-back must delete exactly that row.
    if (via === 'error+row') return { via: 'error', charge: null, ledgerId: ++ent.ledgerMax };
    ent.consumed.push({ u, kind, detail, opts });
    return ent.consumeFor ? { via, charge: null, ledgerId: ++ent.ledgerMax } : { via: 'plan' };
  },
  usageSnapshot: async () => ({}),
  requestEnvironment: () => ent.env || 'Production',
} };

// ── the AI. Never a network call; just a counter and a canned answer. ──────────────────────────
const genaiPath = require.resolve('@google/generative-ai');
require.cache[genaiPath] = { id: genaiPath, filename: genaiPath, loaded: true, exports: {
  GoogleGenerativeAI: class {
    getGenerativeModel(params) {
      return { generateContent: async () => {
        ai.resumeCalls++;
        // T16b: which model was asked, with which generationConfig (index-aligned with ai.models), and a scripted
        // failure for it (a 503 storm, a depleted key).
        ai.models.push(params && params.model);
        ai.configs.push(params && params.generationConfig);
        const scripted = ai.failModel ? ai.failModel(params && params.model) : null;
        if (scripted) throw scripted;
        if (ai.onModelCall) ai.onModelCall();   // T12: the phone gives up while the model is still writing
        const text = JSON.stringify({ personal_info: { full_name: '', email: '', phone: '', location: '' }, summary: 'x', experience: [], education: [], skills: [], projects: [], certifications: [], languages: [], achievements: [] });
        return { response: { text: () => text, candidates: [{ finishReason: 'STOP' }] } };
      } };
    }
  },
} };

const stub = (rel, exports) => {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

stub('ai-cover-letter-v2.js', { generateCoverLetter: async (meta, subject) => {
  ai.letterCalls++;
  const hold = ai.holds.find((h) => String(subject).includes(h.match));
  if (hold) { hold.entered = true; await hold.promise; }
  if (ai.letterFailOn && String(subject).includes(ai.letterFailOn)) throw new Error('AI provider exploded');
  return { employer_name: String(subject).replace(/^https?:\/\//, ''), cover_letter: 'Dear Hiring Manager,\n\nPlease hire me.\n\nRegards', to: 'Hiring Manager', subject: 'Application', addresses: ['1 Road'] };
} });
stub('ai-employer-researcher.js', { researchEmployer: async () => {
  ai.researchCalls++;
  if (ai.researchHang) return new Promise(() => {});   // T19: a research call that never answers
  return { employer_name: 'Acme Corp', brand_color: '#123456', font_name: 'Lato' };
} });
stub('server/controllers/notificationsController.js', {
  notifyCoverLetterGenerated: async (u) => { const h = notifyHolds.find((x) => x.u === u); if (h) { h.entered = true; await h.promise; } },
  notifyError: async () => {}, notifySuccess: async () => {},
});
const jobs = { created: 0, failed: [], completed: [] };
stub('server/services/jobService.js', {
  createJob: async () => 'job' + (++jobs.created), startJob: async () => {}, updateJobProgress: async () => {}, updateJobPartialResult: async () => {},
  failJob: async (id, msg) => { jobs.failed.push({ id, msg }); }, completeJob: async (id, result) => { jobs.completed.push({ id, result }); },
  // The stub's jobs are never cancelled and never found (a repeat of a stub job is therefore never joined).
  getJob: async () => null, isCancelled: async () => false,
});
const sends = [];
stub('server/controllers/emailController.js', {
  generateCoverLetterPDF: async () => { rendered.clPdf++; return { fileName: 'generic.pdf', filePath: '/tmp/generic.pdf' }; },
  executeSendWork: async (u, o) => { sends.push({ u, email: o.recipientEmail }); return { sent: true }; },
});
// The credit functions are SPIES: since 2026-09-13 no generation lane may price or move a credit (T16 pins it).
const credits = { priced: [], charged: [], refunded: [] };
stub('server/services/eventCosts.js', {
  getEventCost: async (key) => { credits.priced.push(key); return 1; },
  chargeCredits: async (...a) => { credits.charged.push(a); return { charged: true, cost: 1 }; },
  refundCredits: async (...a) => { credits.refunded.push(a); },
});
stub('server/services/track.js', { emit: () => {} });
stub('server/utils/resumeRenderer.js', {
  renderPdf: async () => { rendered.pdf++; return Buffer.from('%PDF-1.4 fake'); },
  renderPreviews: async () => [], warmPreviews: async () => {},
});
stub('server/utils/coverLetterRenderer.js', {
  renderPdf: async () => { rendered.clPdf++; return Buffer.from('%PDF-1.4 fake letter'); },
  renderPreviews: async () => [],
});
stub('server/utils/docxBuilder.js', {
  buildResumeDocx: async () => { rendered.docx++; return Buffer.from('PK fake docx'); },
  buildCoverLetterDocx: async () => { rendered.clDocx++; return Buffer.from('PK fake cl docx'); },
});

// ── the modules under test, loaded only now that the world is fake ─────────────────────────────
const D  = require(path.join(ROOT, 'server', 'services', 'downloads.js'));
const RB = require(path.join(ROOT, 'server', 'controllers', 'resumeBuilderController.js'));
const CL = require(path.join(ROOT, 'server', 'controllers', 'coverLetterController.js'));

// ── fake express ──────────────────────────────────────────────────────────────────────────────
const written = [];
const STARTED = Date.now();
function mkRes() {
  const r = { statusCode: 200, body: null, sent: false, writableEnded: false, listeners: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  // A socket that can close: generateAI listens on res 'close' for its support log (T12 closes it mid-AI).
  r.on = (ev, fn) => { (r.listeners[ev] = r.listeners[ev] || []).push(fn); return r; };
  r.emit = (ev) => { (r.listeners[ev] || []).forEach((fn) => fn()); };
  r.json = (b) => { r.body = b; r.sent = true; if (b && b.downloadUrl) written.push(decodeURIComponent(String(b.downloadUrl).split('/').pop())); return r; };
  return r;
}
const mkReq = (userId, body) => ({ user: { id: userId }, body, headers: {}, ip: '1.1.1.1' });
const call = async (fn, userId, body) => { const res = mkRes(); await fn(mkReq(userId, body), res); return res; };

const grant = async (userId, txn) => D.grantPass(userId, { store: 'apple', environment: 'Production', storeTxnId: txn, productId: D.PASS_PRODUCT_ID });
const unbound = (uid) => db.passes.filter((p) => p.user_id === uid && !p.bound_at).length;
const boundKeys = (uid) => db.passes.filter((p) => p.user_id === uid && p.bound_at).map((p) => p.employer_key);

// ══════════════════════════════════════════════════════════════════════════════════════════════════
(async () => {
  console.log('\n══ ONE PURCHASE, ONE EMPLOYER — integration ══');
  ok('the plan meter is OFF in this environment (a plan = unlimited downloads)', D.METERED === false);

  // ── T1 ───────────────────────────────────────────────────────────────────────────────────────
  console.log('\n── T1 · generating the resume costs exactly ONE AI call ──');
  ai.resumeCalls = 0; ent.consumed.length = 0;
  const gen = await call(RB.generateAI, 1, {
    name: 'Test User', email: 't@e.st', phone: '1', location: 'Pune',
    rawText: 'I have eight years of backend engineering experience building payment systems in Node and Postgres for fintech companies.',
  });
  ok('the resume was generated', gen.statusCode === 200 && gen.body && gen.body.success === true, gen.body);
  ok('⚠️ the AI generator ran EXACTLY once', ai.resumeCalls === 1, { calls: ai.resumeCalls });
  ok('…and exactly one resume was deducted', ent.consumed.filter((c) => c.kind === 'resume').length === 1, ent.consumed);

  // ── T2 / T3 ──────────────────────────────────────────────────────────────────────────────────
  console.log('\n── T2/T3 · one pass, one employer: PDF → DOCX → PDF again ──');
  await grant(1, 'TXN-1');
  ok('the purchase minted exactly one unbound pass', unbound(1) === 1, db.passes);
  const aiBefore = ai.resumeCalls;
  db.claimUpdates = 0; db.boundWrites.length = 0;

  const p1 = await call(RB.generatePDF, 1, { template: 'azure', mode: 'a4', employer: 'Acme Corp' });
  ok('download #1 (PDF) succeeded', p1.statusCode === 200 && !!(p1.body && p1.body.downloadUrl), p1.body);
  ok('T2 · the PDF download made ZERO extra AI calls', ai.resumeCalls === aiBefore, { before: aiBefore, after: ai.resumeCalls });
  ok('T3 · ⚠️ download #1 BINDS the pass to Acme Corp', boundKeys(1).includes('acme corp'), { unbound: unbound(1), bound: boundKeys(1), claimUpdatesRun: db.claimUpdates });

  const d1 = await call(RB.generateDocx, 1, { template: 'azure', employer: 'Acme Corp' });
  ok('download #2 (DOCX, same employer) succeeded', d1.statusCode === 200 && !!(d1.body && d1.body.downloadUrl), d1.body);
  ok('T2 · the DOCX download made ZERO extra AI calls', ai.resumeCalls === aiBefore, { after: ai.resumeCalls });

  const p2 = await call(RB.generatePDF, 1, { template: 'executive', mode: 'a4', employer: 'Acme Corp' });
  ok('download #3 (PDF again, different design) succeeded', p2.statusCode === 200 && !!(p2.body && p2.body.downloadUrl), p2.body);
  ok('T2 · the third download made ZERO extra AI calls', ai.resumeCalls === aiBefore, { after: ai.resumeCalls });

  ok('T3 · ⚠️ exactly ONE pass was ever bound for this user', boundKeys(1).length === 1, { bound: boundKeys(1) });
  ok('T3 · …all of it to the same employer', boundKeys(1).every((k) => k === 'acme corp'), boundKeys(1));
  ok('T3 · the pass count never went below zero', unbound(1) >= 0, { unbound: unbound(1) });
  ok('T3 · no SECOND row was bound by the 2nd/3rd download', db.boundWrites.length <= 1, db.boundWrites);
  note('binding UPDATEs actually executed across the 3 downloads', db.claimUpdates);
  note('pass ledger after 3 downloads', db.passes.filter((p) => p.user_id === 1).map((p) => ({ id: p.id, key: p.employer_key, bound: !!p.bound_at })));

  // ── T3b · what the un-claimed PDF path actually costs the buyer ─────────────────────────────
  // If the PDF download does not bind the pass, the pass is still floating when the user opens a
  // DIFFERENT employer — and the first download THERE takes it. The company they actually paid for
  // is then locked.
  console.log('\n── T3b · does an unbound-on-PDF pass get stolen by the next employer? ──');
  await grant(5, 'TXN-5');
  const a5 = await call(RB.generatePDF, 5, { template: 'azure', mode: 'a4', employer: 'Acme Corp' });
  ok('user 5 pays once and downloads the Acme PDF', a5.statusCode === 200);
  note('after the Acme PDF, the pass is bound to', boundKeys(5).length ? boundKeys(5) : '(still unbound)');
  const b5 = await call(RB.generateDocx, 5, { template: 'azure', employer: 'Beta Ltd' });
  note('…then a Beta Ltd download binds it to', boundKeys(5));
  void b5;
  const back5 = await call(RB.generatePDF, 5, { template: 'azure', mode: 'a4', employer: 'Acme Corp' });
  ok('⚠️ the employer they PAID for is still downloadable afterwards', back5.statusCode === 200,
     { status: back5.statusCode, body: back5.body, bound: boundKeys(5), unbound: unbound(5) });

  // ── T4 ───────────────────────────────────────────────────────────────────────────────────────
  console.log('\n── T4 · the SAME employer\'s cover letter rides the SAME pass ──');
  const passesBefore = JSON.stringify(db.passes.filter((p) => p.user_id === 1));
  const clState = await D.canDownload(1, { employer: 'Acme Corp' }, mkReq(1, {}));
  const cl1 = await call(CL.generateCoverLetterTemplatePdf, 1, { template: 'ats_pro', mode: 'a4', coverLetterHtml: '<p>Dear Hiring Manager</p>', companyName: 'Acme Corp', companyAddress: '1 Road' });
  ok('the letter PDF downloaded', cl1.statusCode === 200 && !!(cl1.body && cl1.body.downloadUrl), cl1.body);
  ok('⚠️ it was allowed because the employer is already OWNED, not by spending again', clState.via === 'pass_owned', clState);
  const cl2 = await call(CL.generateCoverLetterTemplateDocx, 1, { template: 'ats_pro', coverLetterHtml: '<p>Dear Hiring Manager</p>', companyName: 'Acme Corp' });
  ok('the letter Word file downloaded too', cl2.statusCode === 200 && !!(cl2.body && cl2.body.downloadUrl), cl2.body);
  ok('⚠️ neither letter download changed the pass ledger', JSON.stringify(db.passes.filter((p) => p.user_id === 1)) === passesBefore, db.passes.filter((p) => p.user_id === 1));
  ok('the letter downloads made no AI calls', ai.letterCalls === 0, { letterCalls: ai.letterCalls });

  // ── T5 ───────────────────────────────────────────────────────────────────────────────────────
  console.log('\n── T5 · one AI call per recipient, and nothing charged for a letter never produced ──');
  ai.letterCalls = 0; ent.consumed.length = 0; ai.letterFailOn = null;
  const bulkOk = await call(CL.generateCoverLetters, 1, { recipients: [
    { email: 'a@acme.test', website: 'acme.test', position: 'Engineer' },
    { email: 'b@beta.test', website: 'beta.test', position: 'Engineer' },
  ] });
  ok('two letters generated', bulkOk.statusCode === 200 && bulkOk.body.results.filter((r) => r.status === 'generated').length === 2, bulkOk.body && bulkOk.body.message);
  ok('⚠️ exactly one AI call per recipient', ai.letterCalls === 2, { calls: ai.letterCalls });
  ok('…and exactly two deductions', ent.consumed.filter((c) => c.kind === 'cover_letter').length === 2, ent.consumed.length);

  ai.letterCalls = 0; ent.consumed.length = 0; ai.letterFailOn = 'beta.test';
  const bulkPartial = await call(CL.generateCoverLetters, 1, { recipients: [
    { email: 'a@acme.test', website: 'acme.test', position: 'Engineer' },
    { email: 'b@beta.test', website: 'beta.test', position: 'Engineer' },
  ] });
  const producedCount = bulkPartial.body.results.filter((r) => r.status === 'generated').length;
  ok('the failure is reported, not swallowed', producedCount === 1 && bulkPartial.body.results.some((r) => r.status === 'failed'), bulkPartial.body.results);
  ok('⚠️ the letter that never existed was NOT deducted', ent.consumed.filter((c) => c.kind === 'cover_letter').length === 1, ent.consumed);
  ai.letterFailOn = null;

  // ── T6 ───────────────────────────────────────────────────────────────────────────────────────
  console.log('\n── T6 · no pass, no plan → refused, with no bytes and no AI ──');
  ent.sub = null;
  const rBefore = { ...rendered }; const aiB = ai.resumeCalls;
  const denied = await call(RB.generatePDF, 99, { template: 'azure', employer: 'Acme Corp' });
  ok('the PDF is refused with 403', denied.statusCode === 403, denied.body);
  ok('…for the reason the app knows how to handle', denied.body && denied.body.reason === 'paid_required', denied.body);
  const deniedDocx = await call(RB.generateDocx, 99, { template: 'azure', employer: 'Acme Corp' });
  ok('the Word file is refused too', deniedDocx.statusCode === 403 && deniedDocx.body.reason === 'paid_required', deniedDocx.body);
  const deniedCl = await call(CL.generateCoverLetterTemplatePdf, 99, { template: 'ats_pro', coverLetterHtml: '<p>x</p>', companyName: 'Acme Corp' });
  ok('and so is the letter', deniedCl.statusCode === 403 && deniedCl.body.reason === 'paid_required', deniedCl.body);
  ok('⚠️ NO bytes were produced for any of them', rendered.pdf === rBefore.pdf && rendered.docx === rBefore.docx && rendered.clPdf === rBefore.clPdf && rendered.clDocx === rBefore.clDocx, { before: rBefore, after: rendered });
  ok('⚠️ and no AI call was made', ai.resumeCalls === aiB, { before: aiB, after: ai.resumeCalls });
  ok('a refused user still holds no pass', unbound(99) === 0 && boundKeys(99).length === 0);

  // ── T7 ───────────────────────────────────────────────────────────────────────────────────────
  console.log('\n── T7 · the employer key must be the SAME string on every path ──');
  await grant(3, 'TXN-3');
  const b1 = await call(RB.generateDocx, 3, { template: 'azure', employer: 'Acme Corp' });
  ok('user 3 buys once and downloads for "Acme Corp"', b1.statusCode === 200 && boundKeys(3).length === 1, { bound: boundKeys(3) });
  for (const variant of ['  acme corp  ', 'ACME CORP', 'Acme  Corp']) {
    const g = await D.canDownload(3, { employer: variant }, mkReq(3, {}));
    ok(`"${variant}" is the same employer (owned, not re-charged)`, g.allowed === true && g.via === 'pass_owned', g);
    const again = await call(RB.generateDocx, 3, { template: 'azure', employer: variant });
    ok(`…and downloading as "${variant}" spends nothing`, again.statusCode === 200 && boundKeys(3).length === 1, { bound: boundKeys(3), unbound: unbound(3) });
  }
  const dot = await D.canDownload(3, { employer: 'Acme Corp.' }, mkReq(3, {}));
  note('OBSERVED — trailing dot "Acme Corp." resolves to key', D.employerKeyOf('Acme Corp.'));
  note('OBSERVED — is "Acme Corp." covered by the pass bought for "Acme Corp"?', dot);
  if (!dot.allowed) note('⚠️ FINDING: punctuation creates a SECOND employer — a user typing the legal name pays twice.');
  const suffix = D.employerKeyOf('Acme Corp') !== D.employerKeyOf('Acme Corporation');
  if (suffix) note('⚠️ FINDING: "Acme Corp" and "Acme Corporation" are different employers — the resume screen sends the Home target\'s company, the letter screen sends the AI\'s employer_name.');

  // ── the two screens, side by side, with the strings they really send ─────────────────────────
  console.log('\n── the cross-screen key: resume screen vs letter screen ──');
  await grant(4, 'TXN-4');
  const homeTarget = 'Acme Corp';                                   // EmployerHome → target.company
  const rDl = await call(RB.generateDocx, 4, { template: 'azure', employer: homeTarget });
  ok('resume download binds the pass to the Home target\'s company', rDl.statusCode === 200 && boundKeys(4).includes(D.employerKeyOf(homeTarget)), { bound: boundKeys(4) });
  // What the LETTER screen sends is coverLetterController's `companyName`, and that is
  // `aiResult.employer_name || companyNameHint || researchSubject` (line 900; the bulk path's
  // line 623 is `aiResult.employer_name || recipient.website`). When the AI omits employer_name
  // and there is no hint, it is the URL — a string the resume screen would never produce.
  const aiEmployerName = 'https://acme.test';

  // ⚠️ THIS ASSERTION USED TO SAY THE OPPOSITE, AND THE OPPOSITE WAS THE BUG.
  // The service matched employer keys as exact strings, so "https://acme.test" was simply not
  // "acme corp" and the same customer was charged a second time for the same company — and it was
  // only ever bridged when a caller happened to remember to send BOTH spellings. Now the identity
  // is the company, not the string: a URL, a legal suffix and a case difference are the same
  // employer, so a single spelling from any screen finds the pass that was already bought.
  const rawGate = await D.canDownload(4, { employer: aiEmployerName }, mkReq(4, {}));
  ok('⚠️ ONE spelling is enough — the service itself bridges the URL to the company',
     rawGate.allowed === true && rawGate.via === 'pass_owned', { rawGate });
  const strangerGate = await D.canDownload(4, { employer: 'https://boeing.test' }, mkReq(4, {}));
  ok('…but a DIFFERENT company is still refused, so the bridge is not a skeleton key',
     strangerGate.allowed === false, { strangerGate });

  // What the fixed client sends: BOTH spellings. The controller resolves them, finds the pass the
  // resume download already bound to the Home target's company, and honours it — one payment, one
  // company, the letter included.
  const lDl = await call(CL.generateCoverLetterTemplatePdf, 4, {
    template: 'ats_pro', mode: 'a4', coverLetterHtml: '<p>Dear Hiring Manager</p>',
    companyName: aiEmployerName,          // the AI's reading — a bare URL here
    employer: homeTarget,                 // the identity the resume screen used
  });
  ok('⚠️ the letter for the SAME company is covered by that pass', lDl.statusCode === 200,
     { homeTarget, aiEmployerName, status: lDl.statusCode, body: lDl.body });
  ok('…and it did NOT bind or spend a second pass', boundKeys(4).filter((k) => k === D.employerKeyOf(homeTarget)).length === 1 && !boundKeys(4).includes(D.employerKeyOf(aiEmployerName)),
     { bound: boundKeys(4) });

  // And an OLD client, sending only the AI's name, is still refused — the server is not guessing
  // which company an unrecognised string belongs to.
  const oldClient = await call(CL.generateCoverLetterTemplatePdf, 4, {
    template: 'ats_pro', mode: 'a4', coverLetterHtml: '<p>x</p>', companyName: 'Totally Other Ltd',
  });
  ok('an unknown company is still refused rather than guessed', oldClient.statusCode === 403,
     { status: oldClient.statusCode });

  // ── T9 ───────────────────────────────────────────────────────────────────────────────────────
  // ⚠️ THE APP'S MAIN LETTERS SCREEN SENDS NO COMPANY AT ALL — App.js posts exactly
  // { recipientEmail, websiteUrl, position }. The gate used to take the employer from
  // `body.employer || companyNameHint`, so it was null on that screen, the pass was never
  // consulted, and a pass holder with no quota left was told to buy a PLAN to get the letter their
  // pass explicitly includes. The employer is now derived from the website they did send.
  console.log('\n── T9 · the letter the pass includes, from the screen that names no company ──');
  ent.gate = { allowed: false, message: "You've used your free cover letters." };
  await grant(9, 'TXN-9');
  ai.letterCalls = 0; ent.consumed.length = 0;
  const nameless = await call(CL.generateCoverLetterDetails, 9, {
    recipientEmail: 'jobs@acme.test', websiteUrl: 'https://www.acme.test/careers', position: 'Backend Engineer',
  });
  ok('the letter was generated, not refused with a 402', nameless.statusCode === 200, { status: nameless.statusCode, body: nameless.body });
  ok('⚠️ …paid for by the PASS, not by a quota the user does not have',
     ent.consumed.filter((c) => c.kind === 'cover_letter').length === 0, ent.consumed);
  ok('…and the pass now records its one letter as spent',
     db.passes.some((p) => p.user_id === 9 && p.letter_generated_at), db.passes.filter((p) => p.user_id === 9));
  ok('⚠️ the AI ran exactly once for it', ai.letterCalls === 1, { calls: ai.letterCalls });

  const secondLetter = await call(CL.generateCoverLetterDetails, 9, {
    recipientEmail: 'jobs@acme.test', websiteUrl: 'https://www.acme.test/careers', position: 'Staff Engineer',
  });
  ok('⚠️ a SECOND letter on the same pass is refused — one AI letter, not unlimited',
     secondLetter.statusCode === 402, { status: secondLetter.statusCode });

  // …but every DOWNLOAD for that employer stays free, which is the rest of the promise.
  const nDl = await call(CL.generateCoverLetterTemplatePdf, 9, {
    template: 'ats_pro', mode: 'a4', coverLetterHtml: '<p>Dear Hiring Manager</p>', companyName: 'Acme',
  });
  ok('…while downloading it in any format is still free for that employer — the pass bound to the '
     + 'site it was generated from, and "Acme" is the same company as "acme.test"',
     nDl.statusCode === 200, { status: nDl.statusCode, bound: boundKeys(9) });

  // ── T10 ──────────────────────────────────────────────────────────────────────────────────────
  // ⚠️ Burning the one-off while the plan could have paid destroys what they bought for nothing.
  console.log('\n── T10 · a plan that can pay must not eat the one-off ──');
  ent.gate = { allowed: true, remaining: 5 };
  await grant(10, 'TXN-10');
  ent.consumed.length = 0;
  const withQuota = await call(CL.generateCoverLetterDetails, 10, {
    recipientEmail: 'jobs@beta.test', websiteUrl: 'https://beta.test', position: 'Engineer',
  });
  ok('the letter was generated', withQuota.statusCode === 200, { status: withQuota.statusCode });
  ok('⚠️ …charged to the allowance the user already had', ent.consumed.filter((c) => c.kind === 'cover_letter').length === 1, ent.consumed);
  ok('⚠️ …and the pass is untouched, still unspent and still unbound',
     unbound(10) === 1 && !db.passes.some((p) => p.user_id === 10 && p.letter_generated_at), db.passes.filter((p) => p.user_id === 10));

  // ── T11 ──────────────────────────────────────────────────────────────────────────────────────
  // The legacy /generate-cover-letter-pdf renders the SAME branded file as the paid template path
  // and asked for nothing at all — one tap away from the 403 the other route returns.
  console.log('\n── T11 · the legacy cover-letter PDF is a paid download too ──');
  ent.gate = { allowed: false, message: 'no' }; ent.sub = null;
  const freeRide = await call(CL.generateCoverLetterPdf, 11, {
    coverLetterHtml: '<p>Dear Hiring Manager</p>', companyName: 'Gamma Test', websiteUrl: 'https://gamma.test',
  });
  ok('⚠️ a user with no plan and no pass is refused', freeRide.statusCode === 403, { status: freeRide.statusCode, body: freeRide.body });
  await grant(11, 'TXN-11');
  const paidRide = await call(CL.generateCoverLetterPdf, 11, {
    coverLetterHtml: '<p>Dear Hiring Manager</p>', companyName: 'Gamma Test', websiteUrl: 'https://gamma.test',
  });
  ok('…and allowed once they hold a pass', paidRide.statusCode === 200, { status: paidRide.statusCode });
  ok('…which it then actually SPENDS on that employer',
     boundKeys(11).includes('gamma test'), { bound: boundKeys(11) });
  ent.gate = { allowed: true, remaining: 5 };

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // 2026-09-14 — A GENERATION NOTHING WILL PAY FOR IS REFUSED, ON EVERY LANE, AND NOTHING IS SAVED
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // canConsumeMany CHECKS AND NEVER RESERVES. The gate says yes, the model writes for a minute, and by the time
  // consumeOnSuccess runs an overlapping request may have spent the last unit: it answers via 'none' and writes
  // no usage row. Each lane used to hand that result over anyway — a free resume or letter per parallel tap, on
  // an allowance that is one-time. These drive the REAL handlers with consumeOnSuccess answering 'none'.
  const lockTakenSince = (mark) => db.log.slice(mark).filter((q) => /pg_advisory_xact_lock\(hashtext\('usage:' \|\| \$1::text\), \$2::int\)/.test(q)).length;
  const runsSince = (mark) => db.runs.slice(mark);
  const savedResumeSince = (mark) => runsSince(mark).some((r) => /^INSERT INTO user_resumes/.test(r.sql));
  const waitFor = async (cond, ms = 3000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); return cond(); };
  const RESUME_BODY = {
    name: 'Test User', email: 't@e.st', phone: '1', location: 'Pune',
    rawText: 'I have eight years of backend engineering experience building payment systems in Node and Postgres for fintech companies.',
  };

  // ── T12 ──────────────────────────────────────────────────────────────────────────────────────
  console.log('\n── T12 · the builder lane: \'none\' is a 402 with nothing saved; a phone that gave up is still charged ──');
  {
    ent.sub = null; ent.gate = { allowed: true, remaining: 1 };
    ent.consumeFor = () => 'none';
    let logMark = db.log.length, runMark = db.runs.length, att0 = ent.attempts.length;
    const none = await call(RB.generateAI, 12, RESUME_BODY);
    ok('⚠️ via \'none\' → 402 quota_exhausted', none.statusCode === 402 && none.body && none.body.reason === 'quota_exhausted', { status: none.statusCode, body: none.body });
    ok('⚠️ …no resume in the answer, and NOTHING saved to user_resumes',
      !none.body.resumeData && !savedResumeSince(runMark), runsSince(runMark).map((r) => r.sql.slice(0, 60)));
    ok('…the decision was made under the usage lock, after asking consumeOnSuccess once',
      lockTakenSince(logMark) >= 1 && ent.attempts.length === att0 + 1 && ent.attempts[att0].via === 'none');

    ent.consumeFor = () => 'error';
    runMark = db.runs.length;
    const unconfirmed = await call(RB.generateAI, 12, RESUME_BODY);
    ok('an unconfirmed charge (\'error\') → 500 failed, nothing saved, no resume handed over',
      unconfirmed.statusCode === 500 && unconfirmed.body.reason === 'failed' && !unconfirmed.body.resumeData && !savedResumeSince(runMark), unconfirmed.body);

    // ⚠️ THE WAIVER IS GONE. A client that disconnected mid-AI used to get its resume SAVED and NOT charged:
    // kill the app, reopen the builder, find it saved — an endless one-time allowance. Now it is charged.
    ent.consumeFor = null;
    const warned = []; const realWarn = console.warn;
    console.warn = (...a) => { warned.push(a.join(' ')); };
    const res = mkRes();
    ai.onModelCall = () => { res.emit('close'); };
    const c0 = ent.consumed.filter((c) => c.kind === 'resume').length;
    runMark = db.runs.length;
    try { await RB.generateAI(mkReq(12, RESUME_BODY), res); } finally { ai.onModelCall = null; console.warn = realWarn; }
    ok('the handler really listened for the disconnect, and saw it', (res.listeners.close || []).length >= 1
      && warned.some((w) => /client disconnected before delivery/.test(w)), warned);
    ok('⚠️ a client that gave up mid-AI is STILL charged for the resume that was saved',
      res.statusCode === 200 && ent.consumed.filter((c) => c.kind === 'resume').length === c0 + 1 && savedResumeSince(runMark),
      { status: res.statusCode, consumed: ent.consumed.filter((c) => c.kind === 'resume').length - c0, saved: savedResumeSince(runMark) });
  }

  // ── T13 ──────────────────────────────────────────────────────────────────────────────────────
  console.log('\n── T13 · generate-cover-letter-details: \'none\' is refused, sync AND async ──');
  {
    ent.sub = null; ent.gate = { allowed: true, remaining: 1 };
    ent.consumeFor = () => 'none';
    let logMark = db.log.length, runMark = db.runs.length;
    const att0 = ent.attempts.length;
    const LETTER = { recipientEmail: 'jobs@delta.test', websiteUrl: 'https://delta.test', position: 'Engineer' };
    const sync = await call(CL.generateCoverLetterDetails, 13, LETTER);
    ok('⚠️ sync: 402 quota_exhausted', sync.statusCode === 402 && sync.body && sync.body.reason === 'quota_exhausted', { status: sync.statusCode, body: sync.body });
    ok('⚠️ …and the letter is NOT delivered', !sync.body.coverLetterHtml && !sync.body.success, sync.body);
    ok('…decided under the shared usage lock, BEFORE consumeOnSuccess answered',
      lockTakenSince(logMark) >= 1 && ent.attempts.length === att0 + 1
      && db.log.slice(logMark).findIndex((q) => /pg_advisory_xact_lock/.test(q)) + logMark < ent.attempts[att0].at);
    ok('…no counter bumped for a letter that was not handed over', !runsSince(runMark).some((r) => /total_generated/.test(r.sql)), runsSince(runMark).map((r) => r.sql.slice(0, 60)));

    // ASYNC: the 202 has gone, so the refusal must survive as the JOB's reason — job-status returns it, and the
    // app opens Plans instead of offering a Try again that meets the same wall.
    process.env.USE_ASYNC_JOBS = 'true';
    runMark = db.runs.length;
    const completed0 = jobs.completed.length;
    let accepted;
    try { accepted = await call(CL.generateCoverLetterDetails, 13, LETTER); } finally { process.env.USE_ASYNC_JOBS = 'false'; }
    ok('async: 202 with a job id', accepted.statusCode === 202 && !!accepted.body.jobId, accepted.body);
    const failedRow = () => runsSince(runMark).find((r) => /^UPDATE async_jobs SET status = 'failed'/.test(r.sql) && r.params && r.params[2] === accepted.body.jobId);
    await waitFor(() => !!failedRow() || jobs.failed.some((f) => f.id === accepted.body.jobId) || jobs.completed.length > completed0);
    const fr = failedRow();
    let frResult = null; try { frResult = fr && JSON.parse(fr.params[1]); } catch {}
    ok('⚠️ async: the job FAILED with reason quota_exhausted (one UPDATE, reason in result)',
      !!fr && frResult && frResult.reason === 'quota_exhausted' && /allowance was used up/.test(fr.params[0]), { fr, failJob: jobs.failed.slice(-1) });
    ok('⚠️ …and it was never completed with a letter', jobs.completed.length === completed0, jobs.completed.slice(completed0));

    ent.consumeFor = () => 'error+row';
    runMark = db.runs.length;
    const err = await call(CL.generateCoverLetterDetails, 13, LETTER);
    const lastLedger = ent.ledgerMax;
    ok('an unconfirmed charge → 500, no letter', err.statusCode === 500 && !err.body.coverLetterHtml, err.body);
    ok('⚠️ …and the usage row it wrote first goes back, by its own id',
      runsSince(runMark).some((r) => /^DELETE FROM usage_ledger WHERE id = \$1 AND user_id = \$2/.test(r.sql) && r.params[0] === lastLedger && r.params[1] === 13), runsSince(runMark));
    ent.consumeFor = null;
  }

  // ── T14 ──────────────────────────────────────────────────────────────────────────────────────
  console.log('\n── T14 · bulk /generate-cover-letters: a letter nothing pays for is refused; paid ones are kept ──');
  {
    ent.sub = null; ent.gate = { allowed: true, remaining: 2 };
    ent.consumeFor = () => 'none';
    let logMark = db.log.length, runMark = db.runs.length;
    const TWO = [{ email: 'a@eps.test', website: 'eps.test', position: 'Engineer' }, { email: 'b@zeta.test', website: 'zeta.test', position: 'Engineer' }];
    const allNone = await call(CL.generateCoverLetters, 14, { recipients: TWO });
    ok('⚠️ every letter refused → 402 quota_exhausted', allNone.statusCode === 402 && allNone.body.reason === 'quota_exhausted', { status: allNone.statusCode, body: allNone.body && allNone.body.error });
    ok('⚠️ …each one named, none with a file', (allNone.body.results || []).length === 2
      && allNone.body.results.every((r) => r.status === 'failed' && r.reason === 'quota_exhausted' && !r.downloadUrl && !r.fileName), allNone.body.results);
    ok('…one lock per letter, and no counter bumped', lockTakenSince(logMark) === 2 && !runsSince(runMark).some((r) => /total_generated/.test(r.sql)));

    ent.consumeFor = (u, k, d) => (d.recipientEmail === 'a@eps.test' ? 'plan' : 'none');
    const c0 = ent.consumed.length;
    const partial = await call(CL.generateCoverLetters, 14, { recipients: TWO });
    const got = (partial.body.results || []);
    ok('a partial run stays a 200 with quotaRefused counted', partial.statusCode === 200 && partial.body.quotaRefused === 1, { status: partial.statusCode, q: partial.body.quotaRefused });
    ok('⚠️ the paid letter is delivered; the refused one has no file',
      got.some((r) => r.email === 'a@eps.test' && r.status === 'generated' && r.downloadUrl)
      && got.some((r) => r.email === 'b@zeta.test' && r.status === 'failed' && r.reason === 'quota_exhausted' && !r.downloadUrl), got);
    ok('…exactly one unit spent', ent.consumed.length === c0 + 1, ent.consumed.slice(c0));
    ent.consumeFor = null;
  }

  // ── T15 ──────────────────────────────────────────────────────────────────────────────────────
  console.log('\n── T15 · /batch-process: the refusal is PER LETTER, carries the gate\'s environment, and is never sent ──');
  {
    const batchRouter = require(path.join(ROOT, 'server', 'routes', 'batchRoutes.js'));
    const layer = batchRouter.stack.find((l) => l.route && l.route.path === '/batch-process');
    const batchHandler = layer && layer.route.stack[layer.route.stack.length - 1].handle;
    ok('the batch handler is reachable', typeof batchHandler === 'function');
    if (batchHandler) {
      ent.sub = null; ent.gate = { allowed: true, remaining: 2 }; ent.env = 'Sandbox';
      ent.consumeFor = (u, k, d) => (d.recipientEmail === 'paid@eta.test' ? 'plan' : 'none');
      const att0 = ent.attempts.length, sends0 = sends.length, done0 = jobs.completed.length;
      const res = mkRes();
      await batchHandler({ user: { id: 15 }, body: { mode: 'generate-and-send', recipients: [
        { email: 'paid@eta.test', website: 'eta.test', position: 'Engineer' },
        { email: 'late@theta.test', website: 'theta.test', position: 'Engineer' },
      ] }, headers: {}, ip: '1.1.1.1' }, res);
      ok('202 accepted', res.statusCode === 202 && !!res.body.jobId, res.body);
      await waitFor(() => jobs.completed.length > done0);
      const summary = (jobs.completed.slice(done0).find((j) => j.id === res.body.jobId) || {}).result || {};
      const r0 = (summary.results || {})[0] || {}, r1 = (summary.results || {})[1] || {};
      ok('⚠️ the late letter is refused on its own: generated:false, reason quota_exhausted',
        r1.generated === false && r1.reason === 'quota_exhausted' && !r1.generationData, r1);
      ok('…while the paid letter is kept', r0.generated === true && !!(r0.generationData && r0.generationData.coverLetterHtml), { generated: r0.generated });
      ok('the summary counts it for the app', summary.generatedCount === 1 && summary.quotaExhaustedCount === 1, { g: summary.generatedCount, q: summary.quotaExhaustedCount });
      ok('⚠️ a refused letter is NEVER sent; the paid one is',
        r1.sent === false && sends.slice(sends0).every((x) => x.email !== 'late@theta.test') && sends.slice(sends0).some((x) => x.email === 'paid@eta.test'), sends.slice(sends0));
      const mine = ent.attempts.slice(att0).filter((a) => a.u === 15);
      ok('⚠️ every per-letter charge carried the environment the GATE read (not a Production default)',
        mine.length === 2 && mine.every((a) => a.opts && a.opts.storeEnv === 'Sandbox'), mine.map((a) => a.opts));
      ent.env = null; ent.consumeFor = null;
    }
  }

  // ── T16 ──────────────────────────────────────────────────────────────────────────────────────
  console.log('\n── T16 · the Job Hub letter: the allowance pays, never a credit, and \'none\' is refused ──');
  {
    const AH = require(path.join(ROOT, 'server', 'controllers', 'aiHubController.js'));
    db.hubJob = { id: 'hub-1', title: 'Backend Engineer', employer_id: null, location: 'Pune', responsibilities: 'Build APIs' };
    const hub = async (userId, over = {}) => {
      const res = mkRes();
      await AH.generateJobCoverLetter({ user: { id: userId }, params: { jobId: 'hub-1' }, body: {}, headers: {}, ip: '1.1.1.1', ...over }, res);
      return res;
    };
    const credit0 = { priced: credits.priced.length, charged: credits.charged.length, refunded: credits.refunded.length };
    const logMark0 = db.log.length;
    ent.sub = null;

    ent.gate = { allowed: false, message: "You've used your 3 free cover letters." };
    let aiB = ai.resumeCalls, att0 = ent.attempts.length;
    const refused = await hub(16);
    ok('no allowance → 402 quota_exhausted BEFORE the model runs', refused.statusCode === 402 && refused.body.reason === 'quota_exhausted'
      && ai.resumeCalls === aiB && ent.attempts.length === att0, { status: refused.statusCode, body: refused.body });

    ent.gate = { allowed: true, remaining: 1 };
    ent.consumeFor = () => 'none';
    let logMark = db.log.length; aiB = ai.resumeCalls; att0 = ent.attempts.length;
    const none = await hub(16);
    ok('⚠️ via \'none\' → 402 quota_exhausted, and the letter is NOT handed over',
      none.statusCode === 402 && none.body.reason === 'quota_exhausted' && !none.body.coverLetter && ai.resumeCalls === aiB + 1, { status: none.statusCode, body: none.body });
    ok('…decided under the shared usage lock', lockTakenSince(logMark) >= 1 && ent.attempts.length === att0 + 1);

    ent.consumeFor = () => 'plan';
    const c0 = ent.consumed.length;
    const paid = await hub(16);
    ok('the allowance pays → 200 with the letter, creditsUsed 0', paid.statusCode === 200 && !!paid.body.coverLetter && paid.body.creditsUsed === 0, { status: paid.statusCode, body: paid.body && { ...paid.body, coverLetter: undefined } });
    ok('…one cover_letter unit, from this screen', ent.consumed.length === c0 + 1 && ent.consumed[c0].kind === 'cover_letter' && ent.consumed[c0].detail.screen === 'job_hub_cover_letter', ent.consumed.slice(c0));

    ent.consumeFor = () => 'error+row';
    const runMark = db.runs.length;
    const err = await hub(16);
    ok('an unconfirmed charge → 500, and its usage row goes back by id',
      err.statusCode === 500 && !err.body.coverLetter
      && runsSince(runMark).some((r) => /^DELETE FROM usage_ledger WHERE id = \$1 AND user_id = \$2/.test(r.sql) && r.params[0] === ent.ledgerMax && r.params[1] === 16), runsSince(runMark));
    ent.consumeFor = null;

    ent.gate = { allowed: false, message: 'no' }; att0 = ent.attempts.length;
    const admin = await hub(16, { adminTest: true });
    ok('the admin test stays free: no gate, no charge', admin.statusCode === 200 && admin.body.adminTest === true && ent.attempts.length === att0, { status: admin.statusCode });
    // The live check an operator uses after a model switch: the admin test names the model that wrote the letter.
    // ⚠️ RETARGETED 2026-09-18 (the letter chain reverted the same day): the letter lanes walk [gemini-2.5-flash,
    // ...fallbackModels()] again, not aiText.writing() — so on a quiet day it is the LETTER primary, GEMINI_FLASH_MODEL.
    const LETTER_P0 = process.env.GEMINI_FLASH_MODEL || 'gemini-2.5-flash';
    ok('…and it names the model that WROTE it (the letter chain\'s primary on a quiet day, gemini-2.5-flash)',
      admin.body.inputs && admin.body.inputs.model === LETTER_P0, admin.body.inputs && admin.body.inputs.model);
    ent.gate = { allowed: true, remaining: 5 };

    ok('⚠️ NO CREDIT was priced, charged or refunded anywhere in the Job Hub lane',
      credits.priced.length === credit0.priced && credits.charged.length === credit0.charged && credits.refunded.length === credit0.refunded
      && !db.log.slice(logMark0).some((q) => /user_credits/.test(q)), { priced: credits.priced.slice(credit0.priced), charged: credits.charged.slice(credit0.charged) });
    const fs2 = require('fs');
    const stripC = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const ahSrc = stripC(fs2.readFileSync(path.join(ROOT, 'server', 'controllers', 'aiHubController.js'), 'utf8'));
    const body = (ahSrc.match(/async function generateJobCoverLetter\([\s\S]*?\n\}/) || [''])[0];
    ok('⚠️ …and its source names no credit machinery at all (comment-stripped)',
      body.length > 500 && !/user_credits|job_cover_letter'|chargeCredits|refundCredits|getEventCost|deductCredits/.test(body)
      && /entitlements\.canConsumeMany\(userId, 'cover_letter', 1, req\)/.test(body) && /withUsageLock\(userId, 'cover_letter'/.test(body), body.length);
    const clSrc = fs2.readFileSync(path.join(ROOT, 'server', 'controllers', 'coverLetterController.js'), 'utf8');
    ok('⚠️ coverLetterController exports withUsageLock, keyed exactly as the resume and Home letter lanes key theirs',
      typeof CL.withUsageLock === 'function'
      && [clSrc, fs2.readFileSync(path.join(ROOT, 'server', 'controllers', 'resumeBuilderController.js'), 'utf8'), fs2.readFileSync(path.join(ROOT, 'server', 'controllers', 'employerLetterController.js'), 'utf8')]
        .every((src) => /SELECT pg_advisory_xact_lock\(hashtext\('usage:' \|\| \$1::text\), \$2::int\)/.test(src)));
    const brSrc = stripC(fs2.readFileSync(path.join(ROOT, 'server', 'routes', 'batchRoutes.js'), 'utf8'));
    ok('batch-process hands the gate\'s environment to every letter', /const passEnv = entitlements\.requestEnvironment\(req\)/.test(brSrc)
      && /executeGenerationWork\(userId, user, \{[\s\S]{0,200}passEnv,/.test(brSrc));
  }

  // ── T16b ─────────────────────────────────────────────────────────────────────────────────────
  console.log('\n── T16b · ⚠️ the Job Hub letter rides out a Gemini 503 spike — and says so honestly when it cannot ──');
  {
    // 2026-09-18: Home's Amazon letter died on two back-to-back 503 "high demand" answers from ONE model. This lane
    // made ONE call to ONE model — the same failure, with nothing to fall back on. It now goes through aiText, on the
    // LETTER chain: GEMINI_FLASH_MODEL (gemini-2.5-flash), then aiText.fallbackModels() (the flash-lites).
    // ⚠️ REVERTED 2026-09-18, the same day: for one afternoon this lane spread aiText.writing() (gemini-3.1-flash-lite
    // first, 2.5-flash with thinking off behind it). That chain was measured on Home's OLD letter prompt only, so every
    // letter lane is back on the chain it was written with — and none of them may pass a per-model config (no model
    // gets thinkingConfig from the lane). The résumé lanes keep writing(); that is pinned below too.
    const AH = require(path.join(ROOT, 'server', 'controllers', 'aiHubController.js'));
    // The SAME aiText instance the controller calls: both resolve to this one file in require.cache (nothing in this
    // suite stubs or reloads it), so the chain read below is the chain the lane walks.
    const AT = require(path.join(ROOT, 'server', 'services', 'aiText.js'));
    const saved = { wait: AT._internals.settings.retryWaitMs, jitter: AT._internals.settings.retryJitterMs };
    AT._internals.settings.retryWaitMs = 20; AT._internals.settings.retryJitterMs = 0;   // the 2 s pause, shrunk
    // Model ids come from the module and the env, never re-hard-coded past the lane's own default: P = the letter
    // primary, then the verified fallbacks in order.
    const CHAIN = [process.env.GEMINI_FLASH_MODEL || 'gemini-2.5-flash', ...AT.fallbackModels()];
    const [P, F1] = CHAIN;
    // What generateJobCoverLetter passes as its own generationConfig (`config: {}` in aiHubController) — and EVERY
    // model of the letter chain gets exactly this: no thinkingConfig from anywhere.
    const LANE_CONFIG = {};
    const noThinking = (c) => !!c && typeof c === 'object' && !('thinkingConfig' in c);
    ok('the letter chain under test: gemini-2.5-flash first, then the verified fallbacks (not the writing chain)',
      CHAIN.length >= 3 && new Set(CHAIN).size === CHAIN.length && JSON.stringify(CHAIN) !== JSON.stringify(AT.writingChain()), { letter: CHAIN, writing: AT.writingChain() });
    const e503 = () => Object.assign(new Error('[GoogleGenerativeAI Error]: [503 Service Unavailable] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'), { status: 503 });
    const eDry = () => Object.assign(new Error('[GoogleGenerativeAI Error]: [429 Too Many Requests] Your prepayment credits are depleted. [RESOURCE_EXHAUSTED]'), { status: 429 });
    db.hubJob = { id: 'hub-1', title: 'Backend Engineer', employer_id: null, location: 'Pune', responsibilities: 'Build APIs' };
    const hub = async (userId) => {
      const res = mkRes();
      await AH.generateJobCoverLetter({ user: { id: userId }, params: { jobId: 'hub-1' }, body: {}, headers: {}, ip: '1.1.1.1' }, res);
      return res;
    };
    ent.sub = null; ent.gate = { allowed: true, remaining: 3 }; ent.consumeFor = () => 'plan';

    ai.models.length = 0; ai.configs.length = 0; ai.failModel = (m) => (m === P ? e503() : null);
    let c0 = ent.consumed.length;
    const rode = await hub(16);
    ok('the primary 503s twice → the first fallback writes it → 200 with the letter',
      rode.statusCode === 200 && !!rode.body.coverLetter && JSON.stringify(ai.models) === JSON.stringify([P, P, F1]), { status: rode.statusCode, models: ai.models });
    // ⚠️ REWRITTEN 2026-09-18 (the revert): every model — the primary twice, then the fallback — was asked with the
    // lane's config exactly, and NO thinkingConfig. The writing chain's per-model config is not this lane's any more.
    ok('⚠️ …every model was asked with the lane\'s config exactly — NO thinkingConfig, on the primary or the fallback',
      ai.configs.length === 3 && ai.configs.every((c) => JSON.stringify(c) === JSON.stringify(LANE_CONFIG) && noThinking(c)), { models: ai.models, configs: ai.configs });
    ok('…charged exactly ONE unit, once the letter existed', ent.consumed.length === c0 + 1, ent.consumed.slice(c0));

    ai.models.length = 0; ai.configs.length = 0; ai.failModel = () => e503();
    c0 = ent.consumed.length; let att0 = ent.attempts.length; let logMark = db.log.length;
    const busy = await hub(16);
    ok('⚠️ every model busy → 503 reason ai_busy, retryable, and the sentence says nothing was charged',
      busy.statusCode === 503 && busy.body.reason === 'ai_busy' && busy.body.retryable === true && /Nothing was charged/.test(busy.body.error || ''), { status: busy.statusCode, body: busy.body });
    ok('…and it is TRUE: no unit consumed, no charge attempted, no usage lock taken',
      ent.consumed.length === c0 && ent.attempts.length === att0 && lockTakenSince(logMark) === 0, { consumed: ent.consumed.slice(c0), attempts: ent.attempts.slice(att0) });
    // Retargeted again 2026-09-18 (the revert): the chain walked is the LETTER chain, [gemini-2.5-flash,
    // ...fallbackModels()] — primary twice, then every verified fallback once, in order.
    ok('…after the whole letter chain was tried (primary twice, then every fallback)',
      CHAIN.length >= 3 && JSON.stringify(ai.models) === JSON.stringify([P, P, ...CHAIN.slice(1)]), { chain: CHAIN, models: ai.models });
    ok('⚠️ …and on the way down NO model ran with a config of its own: the lane\'s config, no thinkingConfig, every time',
      ai.configs.length === ai.models.length && ai.configs.every((c) => JSON.stringify(c) === JSON.stringify(LANE_CONFIG) && noThinking(c)), { models: ai.models, configs: ai.configs });

    ai.models.length = 0; ai.configs.length = 0; ai.failModel = () => eDry();
    c0 = ent.consumed.length;
    const down = await hub(16);
    ok('a key with no credit left → 503 ai_down, NOT retryable, after ONE call to the primary (every model shares the key)',
      down.statusCode === 503 && down.body.reason === 'ai_down' && down.body.retryable === false && ai.models.length === 1 && ai.models[0] === P, { status: down.statusCode, body: down.body, models: ai.models });
    ok('…and nothing was charged', ent.consumed.length === c0);

    // ⚠️ The client LEAVES while the model is still writing (an older build with a shorter timeout, during a spike).
    // This lane stores nothing, so the letter would be thrown away: it must not be charged for.
    ai.failModel = null; ai.models.length = 0; ai.configs.length = 0; ent.consumeFor = () => 'plan';
    const gone = mkRes();
    ai.onModelCall = () => { gone.emit('close'); };
    c0 = ent.consumed.length; att0 = ent.attempts.length; logMark = db.log.length;
    await AH.generateJobCoverLetter({ user: { id: 16 }, params: { jobId: 'hub-1' }, body: {}, headers: {}, ip: '1.1.1.1' }, gone);
    ai.onModelCall = null;
    ok('⚠️ the client left before the letter existed → NOT charged: no unit, no charge attempt, no lock',
      ent.consumed.length === c0 && ent.attempts.length === att0 && lockTakenSince(logMark) === 0, { consumed: ent.consumed.slice(c0), attempts: ent.attempts.slice(att0) });
    ok('…and nothing was sent to a socket that is gone', gone.sent === false, { status: gone.statusCode, body: gone.body });
    const stayed = await hub(16);
    ok('…while a client that stays is served and charged as before', stayed.statusCode === 200 && !!stayed.body.coverLetter && ent.consumed.length === c0 + 1);

    ai.failModel = null; ai.models.length = 0; ai.configs.length = 0; ent.consumeFor = null;
    AT._internals.settings.retryWaitMs = saved.wait; AT._internals.settings.retryJitterMs = saved.jitter;

    // ⚠️ THE TWO CHAINS, IN THE SOURCE (comment-stripped). Letters: [their gemini-2.5-flash, ...fallbackModels()] with no
    // per-model config — this lane, the Jobs-section letter (which Home's employer letter now writes through). Résumés:
    // still aiText.writing(), the chain that WAS measured for them. A letter lane that spread writing() again, or a
    // résumé lane that lost it, fails here before it ships.
    const fsC = require('fs');
    const stripS = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const ahS = stripS(fsC.readFileSync(path.join(ROOT, 'server', 'controllers', 'aiHubController.js'), 'utf8'));
    const hubCall = ((ahS.match(/async function generateJobCoverLetter\([\s\S]*?\n\}/) || [''])[0].match(/aiText\.generateText\(\{[\s\S]*?\}\);/) || [''])[0];
    ok('⚠️ the Job Hub letter asks [GEMINI_FLASH_MODEL, ...aiText.fallbackModels()], with no writing() and no modelConfig',
      /lane: 'job_hub_letter'/.test(hubCall) && /models: \[GEMINI_FLASH_MODEL, \.\.\.aiText\.fallbackModels\(\)\]/.test(hubCall) && !/writing\(\)|modelConfig/.test(hubCall), hubCall);
    const rbS = stripS(fsC.readFileSync(path.join(ROOT, 'server', 'controllers', 'resumeBuilderController.js'), 'utf8'));
    ok('…while the résumé lanes still spread aiText.writing() (the measured chain stays theirs)', (rbS.match(/\.\.\.aiText\.writing\(\)/g) || []).length >= 1);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // 2026-09-19 — "IT WAS 3 COVER LETTERS, I GENERATED 2, AND ALL 3 WERE USED": NO UNIT WITHOUT A LETTER
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // The quota audit proved four ways a unit left the allowance with no letter to show for it: a Cancel that only
  // stopped the phone, a lost 202 resent automatically (and the Job Hub's retry), a research call with no timeout
  // outliving the phone's patience, and a failure AFTER the charge. These drive the real handlers against the REAL
  // jobService SQL — the fake async_jobs table (asyncJobsSql) honours exactly the WHERE clauses it is sent.
  const JOBS = require(path.join(ROOT, 'server', 'services', 'jobService.js'));   // the stub object the controllers hold
  const jsPath = require.resolve(path.join(ROOT, 'server', 'services', 'jobService.js'));
  const REAL_JOBS = (() => { const had = require.cache[jsPath]; delete require.cache[jsPath]; try { return require(jsPath); } finally { require.cache[jsPath] = had; } })();
  const STUB_JOBS = { ...JOBS };
  const REAL_KEYS = ['createJob', 'getJob', 'startJob', 'updateJobProgress', 'updateJobPartialResult', 'completeJob', 'failJob', 'cancelJob', 'isCancelled', 'CANCELLABLE_JOB_TYPES'];
  const useRealJobs = () => { for (const k of REAL_KEYS) JOBS[k] = REAL_JOBS[k]; };
  const useStubJobs = () => { for (const k of Object.keys(JOBS)) delete JOBS[k]; Object.assign(JOBS, STUB_JOBS); };
  const jobRouter = require(path.join(ROOT, 'server', 'routes', 'jobRoutes.js'));
  const routeOf = (p, m) => { const l = jobRouter.stack.find((x) => x.route && x.route.path === p && x.route.methods[m]); return l && l.route.stack[l.route.stack.length - 1].handle; };
  const cancelRoute = routeOf('/job-cancel/:jobId', 'post');
  const statusRoute = routeOf('/job-status/:jobId', 'get');
  const cancelAs = async (userId, jobId) => { const res = mkRes(); await cancelRoute({ user: { id: userId }, params: { jobId }, body: {}, headers: {} }, res); return res; };
  const statusAs = async (userId, jobId) => { const res = mkRes(); await statusRoute({ user: { id: userId }, params: { jobId }, headers: {} }, res); return res; };
  const jobRow = (id) => db.asyncJobs.get(id) || null;
  const letterAttempts = (uid) => ent.attempts.filter((a) => a.u === uid && a.kind === 'cover_letter');
  // A job has settled when its worker ended: completed (with a letter or a batch summary), or failed — or, for a
  // cancelled job, when the worker's own refusal was written against it (a no-op on the row, visible in db.runs).
  const refusedRun = (id) => db.runs.some((r) => /^UPDATE async_jobs SET status = 'failed'/.test(r.sql) && (r.params || []).includes(id));
  const settled = (id) => () => { const r = jobRow(id); return !!r && (r.status === 'failed' || !!(r.result && (r.result.success || r.result.results)) || refusedRun(id)); };
  const batchRouter = require(path.join(ROOT, 'server', 'routes', 'batchRoutes.js'));
  const batchLayer = batchRouter.stack.find((l) => l.route && l.route.path === '/batch-process');
  const batchRoute = batchLayer && batchLayer.route.stack[batchLayer.route.stack.length - 1].handle;
  const savedAsync = process.env.USE_ASYNC_JOBS, savedConc = process.env.BATCH_GENERATE_CONCURRENCY;
  const keepAlive = setInterval(() => {}, 1000);   // T19's research timer is unref()'d, and its hung call holds nothing open

  try {
    useRealJobs();
    process.env.USE_ASYNC_JOBS = 'true';
    ent.sub = null; ent.gate = { allowed: true, remaining: 3 }; ent.consumeFor = () => 'trial';
    ok('the cancel and status routes are reachable', typeof cancelRoute === 'function' && typeof statusRoute === 'function' && typeof batchRoute === 'function');

    // ── T17 ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── T17 · ⚠️ a CANCELLED letter is not charged — the Letters page\'s Cancel, the Job Hub\'s deadline ──');
    {
      const hold = holdLetter('cancel-me.test');
      const acc = await call(CL.generateCoverLetterDetails, 170, { recipientEmail: 'hr@cancel-me.test', websiteUrl: 'https://cancel-me.test', position: 'Engineer' });
      ok('202 with a real job row', acc.statusCode === 202 && !!jobRow(acc.body.jobId), acc.body);
      await waitFor(() => hold.entered);
      const c = await cancelAs(170, acc.body.jobId);
      ok('POST /job-cancel while the letter is being written → cancelled:true', c.statusCode === 200 && c.body && c.body.cancelled === true, { status: c.statusCode, body: c.body });
      hold.release();
      await waitFor(settled(acc.body.jobId));
      ok('⚠️ NOTHING was charged: the worker finished the letter but never asked consumeOnSuccess — no usage row',
        letterAttempts(170).length === 0, letterAttempts(170));
      const row = jobRow(acc.body.jobId);
      ok('⚠️ …the job stays CANCELLED (the worker\'s own refusal did not overwrite it) and holds no letter',
        !!row && row.status === 'cancelled' && !(row.result && row.result.coverLetterHtml), row && { status: row.status, result: row.result });
      const st = await statusAs(170, acc.body.jobId);
      ok('…job-status reads it as failed, reason cancelled, saying nothing was charged (every poller in the field settles)',
        st.body && st.body.status === 'failed' && st.body.reason === 'cancelled' && st.body.cancelled === true && /nothing was charged/i.test(st.body.error || ''), st.body);

      // Cancelled after the charge landed (the worker is past it, notifying): refused — the letter is delivered.
      const hn = holdNotify(171);
      const paid = await call(CL.generateCoverLetterDetails, 171, { recipientEmail: 'hr@charged-first.test', websiteUrl: 'https://charged-first.test', position: 'Engineer' });
      await waitFor(() => hn.entered);
      const late = await cancelAs(171, paid.body.jobId);
      ok('⚠️ a cancel AFTER the charge is refused (cancelled:false, still processing) — "nothing was charged" would be a lie',
        late.body && late.body.cancelled === false && late.body.status === 'processing', late.body);
      hn.release();
      await waitFor(settled(paid.body.jobId));
      const prow = jobRow(paid.body.jobId);
      ok('…and the letter it paid for is delivered: the job completes WITH it, charged exactly once',
        !!prow && prow.status === 'completed' && prow.result && /Please hire me/.test(prow.result.coverLetterHtml || '') && letterAttempts(171).length === 1,
        prow && { status: prow.status, attempts: letterAttempts(171).length });
      // A cancel that arrives WHILE the charge is being decided (the worker inside the usage lock, past its cancel read):
      // it takes the same lock, so it waits for that decision — and then finds the job paid for, and refuses.
      db.serialiseLocks = true;
      const hc = holdConsume(173);
      const race = await call(CL.generateCoverLetterDetails, 173, { recipientEmail: 'hr@race.test', websiteUrl: 'https://race.test', position: 'Engineer' });
      await waitFor(() => hc.entered);
      const racing = cancelAs(173, race.body.jobId);
      await new Promise((r) => setTimeout(r, 40));
      hc.release();
      const rc = await racing;
      await waitFor(settled(race.body.jobId));
      db.serialiseLocks = false;
      ok('⚠️ a cancel racing the charge waits for it (the SAME usage lock): refused, and the paid letter is delivered — never "cancelled" over a charge',
        rc.body && rc.body.cancelled === false && jobRow(race.body.jobId).status === 'completed' && letterAttempts(173).length === 1,
        { cancel: rc.body, status: jobRow(race.body.jobId).status, attempts: letterAttempts(173).length });
      // ⚠️ THE LOCK IS UNAVAILABLE (lock_timeout, a dead connection): the cancel is NOT written without it. The worker marks
      // 'charged' only after its charge returns, so a cancel landing outside the lock could say "nothing was charged" about
      // a unit already spent. The honest answer is "still running" — and the letter it pays for is delivered.
      {
        const hl = holdLetter('no-lock.test');
        const nl = await call(CL.generateCoverLetterDetails, 174, { recipientEmail: 'hr@no-lock.test', websiteUrl: 'https://no-lock.test', position: 'Engineer' });
        await waitFor(() => hl.entered);
        const realLock = CL.withUsageLock;
        CL.withUsageLock = async () => { throw new Error('canceling statement due to lock timeout'); };
        const nc = await cancelAs(174, nl.body.jobId);
        CL.withUsageLock = realLock;
        ok('⚠️ lock unavailable → the cancel is REFUSED (cancelled:false, still processing) — never written outside the lock',
          nc.body && nc.body.cancelled === false && nc.body.status === 'processing' && jobRow(nl.body.jobId).status === 'processing', { cancel: nc.body, row: jobRow(nl.body.jobId) && jobRow(nl.body.jobId).status });
        hl.release();
        await waitFor(settled(nl.body.jobId));
        ok('…and the letter finishes and is delivered, charged exactly once', jobRow(nl.body.jobId).status === 'completed' && letterAttempts(174).length === 1,
          { status: jobRow(nl.body.jobId).status, attempts: letterAttempts(174).length });
      }
      // ⚠️ THE 'charged' MARK IS RETRIED. It is what makes a later cancel refuse a PAID letter; a mark that failed once used
      // to be logged and dropped, and the next cancel would then succeed against a unit already spent.
      {
        const realMark = JOBS.updateJobPartialResult;
        let failed = 0;
        JOBS.updateJobPartialResult = async (id, partial) => {
          if (partial && partial.stage === 'charged' && failed < 2) { failed++; throw new Error('connection reset'); }
          return realMark(id, partial);
        };
        const hm = holdNotify(175);
        const mk = await call(CL.generateCoverLetterDetails, 175, { recipientEmail: 'hr@mark-retry.test', websiteUrl: 'https://mark-retry.test', position: 'Engineer' });
        await waitFor(() => hm.entered);
        const markedRow = jobRow(mk.body.jobId);
        JOBS.updateJobPartialResult = realMark;
        ok('⚠️ the mark failed twice and was RETRIED: the paid job reads stage "charged"',
          failed === 2 && !!markedRow && markedRow.result && markedRow.result.stage === 'charged', { failed, result: markedRow && markedRow.result });
        const mc = await cancelAs(175, mk.body.jobId);
        ok('…so a cancel after the charge is refused — never "nothing was charged" over a spent unit', mc.body && mc.body.cancelled === false, mc.body);
        hm.release();
        await waitFor(settled(mk.body.jobId));
        ok('…and the letter is delivered, charged once', jobRow(mk.body.jobId).status === 'completed' && letterAttempts(175).length === 1,
          { status: jobRow(mk.body.jobId).status, attempts: letterAttempts(175).length });
      }
      const after = await cancelAs(171, paid.body.jobId);
      ok('a cancel of a finished job changes nothing (cancelled:false, completed)', after.body && after.body.cancelled === false && after.body.status === 'completed', after.body);
      ok('another user\'s job → 404, and it is not touched', (await cancelAs(999, paid.body.jobId)).statusCode === 404 && jobRow(paid.body.jobId).status === 'completed');
      const other = await REAL_JOBS.createJob(171, 'resume_generate_ai', {});
      const refused = await cancelAs(171, other);
      ok('a job type whose worker cannot honour a cancel → 409, left running', refused.statusCode === 409 && jobRow(other).status === 'pending', { status: refused.statusCode, row: jobRow(other) });

      // Generate All: cancelled half-way — the letter already paid for is kept, the rest are skipped UNCHARGED, and
      // nothing at all is SENT after the user said stop.
      process.env.BATCH_GENERATE_CONCURRENCY = '1';
      const hb = holdLetter('b2-batch.test');
      const sends0 = sends.length;
      const bres = mkRes();
      await batchRoute({ user: { id: 172 }, body: { mode: 'generate-and-send', recipients: [
        { email: 'a@b1-batch.test', website: 'b1-batch.test', position: 'Engineer' },
        { email: 'b@b2-batch.test', website: 'b2-batch.test', position: 'Engineer' },
        { email: 'c@b3-batch.test', website: 'b3-batch.test', position: 'Engineer' },
      ] }, headers: {}, ip: '1.1.1.1' }, bres);
      ok('batch: 202 with a real job row', bres.statusCode === 202 && !!jobRow(bres.body.jobId), bres.body);
      await waitFor(() => hb.entered);
      const bc = await cancelAs(172, bres.body.jobId);
      ok('batch: cancelled while its SECOND letter is being written', bc.body && bc.body.cancelled === true, bc.body);
      hb.release();
      await waitFor(settled(bres.body.jobId));
      const brow = jobRow(bres.body.jobId) || {};
      const sum = brow.result || {};
      const rr = sum.results || {};
      ok('⚠️ batch: exactly ONE unit — the letter finished before the cancel; the one being written and the one not started are free',
        letterAttempts(172).length === 1 && letterAttempts(172)[0].detail.recipientEmail === 'a@b1-batch.test', letterAttempts(172).map((a) => a.detail.recipientEmail));
      ok('…the two are recorded as cancelled, not generated (cancelledCount 2), and the paid letter is KEPT in the result',
        rr[0] && rr[0].generated === true && !!(rr[0].generationData && rr[0].generationData.coverLetterHtml)
          && rr[1] && rr[1].generated === false && rr[1].reason === 'cancelled' && rr[2] && rr[2].generated === false && rr[2].reason === 'cancelled'
          && sum.cancelledCount === 2, { rr, cancelledCount: sum.cancelledCount });
      ok('⚠️ …NOTHING was sent after the cancel (not even the paid letter), and the batch still reads cancelled',
        sends.length === sends0 && brow.status === 'cancelled' && rr[0].sent === false, { sent: sends.slice(sends0), status: brow.status });
      ok('the batch\'s letters are labelled on their usage row (lane letters_batch)', letterAttempts(172)[0].detail.lane === 'letters_batch' && letterAttempts(172)[0].detail.screen === 'job_cover_letter', letterAttempts(172)[0].detail);
      process.env.BATCH_GENERATE_CONCURRENCY = savedConc === undefined ? '' : savedConc;
      if (savedConc === undefined) delete process.env.BATCH_GENERATE_CONCURRENCY;
    }

    // ── T18 ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── T18 · ⚠️ one tap, one letter job: a resend of the same request never runs (or charges) twice ──');
    {
      const hold = holdLetter('dupe.test');
      const B = { recipientEmail: 'hr@dupe.test', websiteUrl: 'https://dupe.test', position: 'Engineer', clientBuildId: 'tap-180-a' };
      const size0 = db.asyncJobs.size;
      const [r1, r2] = await Promise.all([call(CL.generateCoverLetterDetails, 180, B), call(CL.generateCoverLetterDetails, 180, B)]);
      ok('two copies of one tap at once → both 202 with the SAME job id, one of them marked deduped',
        r1.statusCode === 202 && r2.statusCode === 202 && r1.body.jobId === r2.body.jobId && (!!r1.body.deduped !== !!r2.body.deduped), { r1: r1.body, r2: r2.body });
      ok('⚠️ …and exactly ONE job was created', db.asyncJobs.size === size0 + 1, db.asyncJobs.size - size0);
      await waitFor(() => hold.entered);
      hold.release();
      await waitFor(settled(r1.body.jobId));
      const r3 = await call(CL.generateCoverLetterDetails, 180, B);
      ok('the SAME tap retried after the letter finished (the 202 was lost) joins the finished job — no new job',
        r3.statusCode === 202 && r3.body.jobId === r1.body.jobId && r3.body.deduped === true && db.asyncJobs.size === size0 + 1, r3.body);
      CL._internals.letterClaims.clear();   // a restart between the lost 202 and the retry: memory is empty
      const r4 = await call(CL.generateCoverLetterDetails, 180, B);
      ok('⚠️ …and after a RESTART async_jobs still finds it (input->>clientBuildId) — no new job',
        r4.statusCode === 202 && r4.body.jobId === r1.body.jobId && r4.body.deduped === true && db.asyncJobs.size === size0 + 1, r4.body);
      ok('⚠️ ONE unit for the four requests', letterAttempts(180).length === 1, letterAttempts(180).length);
      ok('the Letters page\'s letter is labelled on its usage row (lane letters_page)', letterAttempts(180)[0].detail.lane === 'letters_page', letterAttempts(180)[0].detail);

      // The Letters page as installed sends NO clientBuildId: its automatic resend joins the job still being written.
      const hold2 = holdLetter('resend.test');
      const L = { recipientEmail: 'hr@resend.test', websiteUrl: 'https://resend.test', position: 'Engineer' };
      const f1 = await call(CL.generateCoverLetterDetails, 181, L);
      await waitFor(() => hold2.entered);
      const f2 = await call(CL.generateCoverLetterDetails, 181, L);
      ok('⚠️ the automatic resend (no clientBuildId) while the letter is being written joins that job — no second job',
        f2.statusCode === 202 && f2.body.jobId === f1.body.jobId && f2.body.deduped === true, { f1: f1.body, f2: f2.body });
      hold2.release();
      await waitFor(settled(f1.body.jobId));
      ok('…one unit', letterAttempts(181).length === 1, letterAttempts(181).length);
      const f3 = await call(CL.generateCoverLetterDetails, 181, L);
      await waitFor(settled(f3.body.jobId));
      ok('…while the same request AFTER that letter finished is a new letter (a deliberate tap), not a join',
        f3.statusCode === 202 && f3.body.jobId !== f1.body.jobId && !f3.body.deduped && letterAttempts(181).length === 2, f3.body);

      // A tap whose job FAILED is not joined: its retry really runs again.
      ai.letterFailOn = 'fail-once.test';
      const F = { recipientEmail: 'hr@fail-once.test', websiteUrl: 'https://fail-once.test', position: 'Engineer', clientBuildId: 'tap-182' };
      const g1 = await call(CL.generateCoverLetterDetails, 182, F);
      await waitFor(settled(g1.body.jobId));
      ai.letterFailOn = null;
      const g2 = await call(CL.generateCoverLetterDetails, 182, F);
      await waitFor(settled(g2.body.jobId));
      ok('a clientBuildId whose job FAILED is not joined — the retry runs a new job, and only that one is charged',
        jobRow(g1.body.jobId).status === 'failed' && g2.body.jobId !== g1.body.jobId && !g2.body.deduped && jobRow(g2.body.jobId).status === 'completed' && letterAttempts(182).length === 1,
        { g1: jobRow(g1.body.jobId) && jobRow(g1.body.jobId).status, g2: g2.body });
    }

    // ── T19 ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── T19 · ⚠️ the employer research next to the letter is bounded — a hung call cannot hold a paid letter ──');
    {
      const t0budget = CL._internals.letterTiming.researchBudgetMs;
      ok('the research budget is 60 s — inside the letter\'s own budget, so the job cannot outlive the phone\'s wait',
        CL._internals.LETTER_RESEARCH_BUDGET_MS === 60 * 1000 && CL._internals.LETTER_RESEARCH_BUDGET_MS < CL._internals.LEGACY_LETTER_BUDGET_MS);
      CL._internals.letterTiming.researchBudgetMs = 60;
      ai.researchHang = true;
      process.env.USE_ASYNC_JOBS = 'false';
      const t0 = Date.now();
      const r = await Promise.race([
        call(CL.generateCoverLetterDetails, 190, { recipientEmail: 'hr@hang-research.test', websiteUrl: 'https://hang-research.test', position: 'Engineer' }),
        new Promise((res) => setTimeout(() => res('STILL WAITING'), 3000)),
      ]);
      const took = Date.now() - t0;
      ai.researchHang = false; CL._internals.letterTiming.researchBudgetMs = t0budget; process.env.USE_ASYNC_JOBS = 'true';
      ok('⚠️ a research call that NEVER answers: the letter is delivered anyway, with the default brand',
        r !== 'STILL WAITING' && r.statusCode === 200 && /Please hire me/.test(r.body.coverLetterHtml || '') && r.body.brandColor === '#262633' && r.body.fontName === 'Lato',
        r === 'STILL WAITING' ? r : { status: r.statusCode, brand: r.body && r.body.brandColor });
      ok('…after the research budget, not the research\'s own time', r !== 'STILL WAITING' && took < 2000, took);
    }

    // ── T20 ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── T20 · ⚠️ a failure AFTER the charge does not throw a paid letter away ──');
    {
      db.creditsThrow = true;
      process.env.USE_ASYNC_JOBS = 'false';
      let runMark = db.runs.length;
      const s = await call(CL.generateCoverLetterDetails, 200, { recipientEmail: 'hr@after-charge.test', websiteUrl: 'https://after-charge.test', position: 'Engineer' });
      ok('⚠️ the (display-only) credit balance cannot be read after the charge → still 200 WITH the letter, creditsRemaining 0',
        s.statusCode === 200 && /Please hire me/.test(s.body.coverLetterHtml || '') && s.body.creditsRemaining === 0, { status: s.statusCode, body: s.body && (s.body.error || s.body.creditsRemaining) });
      ok('…charged once, and nothing given back (the letter WAS delivered)',
        letterAttempts(200).length === 1 && !db.runs.slice(runMark).some((r) => /^DELETE FROM usage_ledger/.test(r.sql)));
      process.env.USE_ASYNC_JOBS = 'true';
      const a = await call(CL.generateCoverLetterDetails, 201, { recipientEmail: 'hr@after-charge-async.test', websiteUrl: 'https://after-charge-async.test', position: 'Engineer' });
      await waitFor(settled(a.body.jobId));
      ok('…and the async job COMPLETES with it (it used to fail as "Failed to generate the cover letter")',
        jobRow(a.body.jobId).status === 'completed' && /Please hire me/.test((jobRow(a.body.jobId).result || {}).coverLetterHtml || '') && letterAttempts(201).length === 1, jobRow(a.body.jobId));
      db.creditsThrow = false;

      // completeJob throwing once (a dropped connection at the worst moment) is asked again, not failed.
      let throwsLeft = 1;
      JOBS.completeJob = async (id, result) => { if (throwsLeft-- > 0) throw new Error('Connection terminated unexpectedly'); return REAL_JOBS.completeJob(id, result); };
      const b = await call(CL.generateCoverLetterDetails, 202, { recipientEmail: 'hr@complete-once.test', websiteUrl: 'https://complete-once.test', position: 'Engineer' });
      await waitFor(settled(b.body.jobId));
      JOBS.completeJob = REAL_JOBS.completeJob;
      ok('⚠️ a completeJob that throws once is asked again: the paid letter COMPLETES, it is not failed',
        jobRow(b.body.jobId).status === 'completed' && /Please hire me/.test((jobRow(b.body.jobId).result || {}).coverLetterHtml || '') && letterAttempts(202).length === 1, jobRow(b.body.jobId));
    }

    // ── T21 ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── T21 · ⚠️ a paid Job Hub letter is stored by the SERVER — leaving the screen no longer loses it ──');
    {
      const runMark = db.runs.length;
      const acc = await call(CL.generateCoverLetterDetails, 210, { recipientEmail: '', websiteUrl: 'https://hub-store.test', position: 'Backend Engineer', jobId: 'job-uuid-210', clientBuildId: 'hub-210' });
      await waitFor(settled(acc.body.jobId));
      const later = db.runs.slice(runMark);
      const insAt = later.findIndex((r) => /^INSERT INTO job_cover_letters/.test(r.sql) && r.params && r.params[0] === 210);
      const doneAt = later.findIndex((r) => /^UPDATE async_jobs SET status = CASE WHEN status = 'cancelled'/.test(r.sql) && r.params && r.params[1] === acc.body.jobId);
      const ins = insAt >= 0 ? later[insAt] : null;
      ok('⚠️ the letter is written to the job\'s job_cover_letters row by the server, for THIS job',
        !!ins && ins.params[1] === 'job-uuid-210' && /Please hire me/.test(ins.params[2] || '') && ins.params[5] === 'Backend Engineer', ins && ins.params.slice(0, 6));
      ok('…BEFORE the job reads completed — the phone\'s own save (with the office it picked) always lands after it', insAt >= 0 && doneAt > insAt, { insAt, doneAt });
      ok('…and its usage row names the Job Hub (lane job_hub_letter), screen unchanged',
        letterAttempts(210).length === 1 && letterAttempts(210)[0].detail.lane === 'job_hub_letter' && letterAttempts(210)[0].detail.screen === 'job_cover_letter', letterAttempts(210).map((a) => a.detail));

      const hold = holdLetter('hub-cancel.test');
      const runMark2 = db.runs.length;
      const c = await call(CL.generateCoverLetterDetails, 211, { recipientEmail: '', websiteUrl: 'https://hub-cancel.test', position: 'Engineer', jobId: 'job-uuid-211', clientBuildId: 'hub-211' });
      await waitFor(() => hold.entered);
      await cancelAs(211, c.body.jobId);
      hold.release();
      await waitFor(settled(c.body.jobId));
      ok('a Job Hub letter cancelled before its charge (the user left the job) is neither charged nor stored',
        letterAttempts(211).length === 0 && !db.runs.slice(runMark2).some((r) => /^INSERT INTO job_cover_letters/.test(r.sql)), letterAttempts(211));
    }

    // ── T22 · the code rules behind T17–T21 (comment-stripped) ────────────────────────────────────
    {
      const fsx = require('fs');
      const stripX = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
      const clX = stripX(fsx.readFileSync(path.join(ROOT, 'server', 'controllers', 'coverLetterController.js'), 'utf8'));
      const work = (clX.match(/async function executeGenerationWork\([\s\S]*?\n\}/) || [''])[0];
      const lockAt = work.indexOf('withUsageLock(');
      ok('⚠️ the cancel is read INSIDE the usage lock, before the pass claim and the charge',
        lockAt > 0 && /withUsageLock\(userId, 'cover_letter', async \(\) => \{\s*if \(await letterJobCancelled\(jobId\)\) \{ cancelled = true; return; \}/.test(work.slice(lockAt))
          && work.indexOf('letterJobCancelled(jobId)', lockAt) < work.indexOf('claimGeneration(', lockAt) && work.indexOf('claimGeneration(', lockAt) < work.indexOf('consumeOnSuccess(', lockAt));
      ok('…and the AI still runs BEFORE the lock (a cancel costs the model call, never the unit)', work.indexOf('writeLegacyLetter(') > 0 && work.indexOf('writeLegacyLetter(') < lockAt);
    }
  } finally {
    clearInterval(keepAlive);
    useStubJobs();
    ent.consumeFor = null; ent.gate = { allowed: true, remaining: 5 };
    if (savedAsync === undefined) delete process.env.USE_ASYNC_JOBS; else process.env.USE_ASYNC_JOBS = savedAsync;
    if (savedConc === undefined) delete process.env.BATCH_GENERATE_CONCURRENCY; else process.env.BATCH_GENERATE_CONCURRENCY = savedConc;
  }

  // ── T23 ──────────────────────────────────────────────────────────────────────────────────────
  // THE PHONE'S HALF. The server can refuse to charge a cancelled letter only if the phone says so, and can dedupe a
  // retry only if the phone sends the same id. The REAL client code, transpiled (MobileApp's own typescript) and run in
  // a sandbox on a virtual clock (every timer fires at once and moves the clock by its delay) — the pattern of
  // MobileApp/scripts/test-home-builds.js.
  console.log('\n── T23 · the phone\'s half: the Job Hub waits 6 min and then CANCELS; the builder follows ONE build ──');
  {
    const vm = require('vm');
    const fsT = require('fs');
    const tsc = require(path.join(ROOT, 'MobileApp', 'node_modules', 'typescript'));
    const tjs = (src, name) => tsc.transpileModule(src, { compilerOptions: { module: tsc.ModuleKind.CommonJS, target: tsc.ScriptTarget.ES2020, esModuleInterop: true }, fileName: name }).outputText;
    const clock = { now: 1_700_000_000_000 };
    const VDate = class extends Date { static now() { return clock.now; } };
    const vTimeout = (fn, ms) => { clock.now += Number(ms) || 0; setImmediate(fn); return 0; };
    const sandboxOf = (extra) => vm.createContext({ console: { log() {}, warn() {}, error() {} }, setTimeout: vTimeout, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, Date: VDate, JSON, Math, Promise, String, Number, Array, Object, Error, encodeURIComponent, ...extra });

    // ── the Job Hub letter client (services/aiHubService.ts) ──
    const net = { calls: [], answer: () => ({ status: 'processing' }), cancel: { cancelled: true, status: 'cancelled' } };
    const axiosErr = (status) => Object.assign(new Error('Request failed ' + status), { isAxiosError: true, response: { status } });
    const fakeAxios = {
      isAxiosError: (e) => !!(e && e.isAxiosError),
      get: async (url) => { net.calls.push(['GET', url]); const a = net.answer(url); if (a instanceof Error) throw a; return { data: a }; },
      post: async (url, body) => {
        net.calls.push(['POST', url, body]);
        if (/\/job-cancel\//.test(url)) { net.cancelled = true; return { data: net.cancel }; }
        if (/\/generate-cover-letter-details$/.test(url)) return { data: { jobId: 'hub-job-1', status: 'pending' } };
        return { data: {} };
      },
    };
    const MOCKS = {
      axios: { __esModule: true, default: fakeAxios, ...fakeAxios },
      'react-native': { AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
      'expo-secure-store': { getItemAsync: async () => JSON.stringify({ token: 'tok' }) },
      '@react-native-async-storage/async-storage': { __esModule: true, default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } },
      '../config': { API_BASE: 'https://api.test/api' },
      './employerHomeService': { loadJobListing: async () => null },
      './deviceId': { deviceHeader: async () => ({}) },
    };
    const hubJs = tjs(fsT.readFileSync(path.join(ROOT, 'MobileApp', 'services', 'aiHubService.ts'), 'utf8'), 'aiHubService.ts');
    const hubMod = { exports: {} };
    const hubReq = (id) => { if (id in MOCKS) return MOCKS[id]; throw new Error('unmocked require: ' + id); };
    vm.runInContext(`(function (module, exports, require) {\n${hubJs}\n})`, sandboxOf({}))(hubMod, hubMod.exports, hubReq);
    const HUB = hubMod.exports;
    const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

    net.calls.length = 0;
    const started = await HUB.startJobCoverLetter('https://acme.test', 'Engineer', undefined, undefined, 'job-uuid-1', 'Acme', 'cl-tap-1');
    const sent = net.calls.find((c) => c[0] === 'POST' && /generate-cover-letter-details/.test(c[1]));
    ok('⚠️ the Job Hub sends the tap\'s clientBuildId with the letter request', started === 'hub-job-1' && !!sent && sent[2].clientBuildId === 'cl-tap-1' && sent[2].jobId === 'job-uuid-1', sent && sent[2]);

    net.calls.length = 0; net.cancelled = false; net.answer = () => ({ status: 'processing' }); net.cancel = { cancelled: true, status: 'cancelled' };
    let t0 = clock.now;
    const r1 = await settle(HUB.pollJobCoverLetter('hub-job-1'));
    const cancelPosts = net.calls.filter((c) => c[0] === 'POST' && /\/job-cancel\/hub-job-1$/.test(c[1]));
    ok('⚠️ it waits SIX minutes (not five) — longer than the server\'s own bound on a letter job', clock.now - t0 >= 6 * 60 * 1000, (clock.now - t0) / 60000);
    ok('⚠️ …then CANCELS the job, and says truthfully that nothing was charged (code TIMED_OUT)',
      !r1.ok && r1.e.code === 'TIMED_OUT' && /nothing was charged/.test(r1.e.message) && cancelPosts.length === 1, { e: r1.e && r1.e.message, cancels: cancelPosts.length });

    net.calls.length = 0; net.cancelled = false;
    net.cancel = { cancelled: false, status: 'processing' };
    net.answer = () => (net.cancelled ? { status: 'completed', data: { coverLetterHtml: '<p>Paid letter</p>', companyName: 'Acme', subject: 's' } } : { status: 'processing' });
    const r2 = await settle(HUB.pollJobCoverLetter('hub-job-1'));
    ok('⚠️ a cancel REFUSED at the deadline (the letter is paid for, being finished) → it keeps waiting and hands the letter over',
      r2.ok && r2.v.coverLetterHtml === '<p>Paid letter</p>', r2.ok ? r2.v : r2.e && r2.e.message);

    net.answer = () => ({ status: 'failed', reason: 'cancelled', error: 'Cancelled — nothing was charged for this letter.' });
    const r3 = await settle(HUB.pollJobCoverLetter('hub-job-1'));
    net.answer = () => ({ status: 'failed', reason: 'quota_exhausted', error: 'Your plan allowance was used up.' });
    const r4 = await settle(HUB.pollJobCoverLetter('hub-job-1'));
    ok('a cancelled job settles as CANCELLED; a quota refusal carries its reason (the screen opens Plans)',
      !r3.ok && r3.e.code === 'CANCELLED' && !r4.ok && r4.e.reason === 'quota_exhausted', { r3: r3.e && r3.e.code, r4: r4.e && r4.e.reason });
    net.calls.length = 0; net.answer = () => ({ status: 'processing' });
    const r5 = await settle(HUB.pollJobCoverLetter('hub-job-1', undefined, () => true));
    ok('the screen that asked is gone → it stops at once (ABANDONED), not a single status read more', !r5.ok && r5.e.code === 'ABANDONED' && net.calls.length === 0, net.calls);

    const jd = fsT.readFileSync(path.join(ROOT, 'MobileApp', 'app', '(ai-hub)', 'job-detail.tsx'), 'utf8');
    ok('⚠️ job-detail: one build id per tap, kept for a retry only after no answer, and the job in flight cancelled when the user leaves',
      /const buildId = clBuildRef\.current\?\.reuse \? clBuildRef\.current\.id : newClientBuildId\(\);/.test(jd)
        && /startJobCoverLetter\([\s\S]{0,400}?buildId,\s*\);/.test(jd)
        && /if \(inFlight\) cancelLetterJob\(inFlight\);/.test(jd)
        && /pollJobCoverLetter\(jobId, \(\) => \{[\s\S]{0,200}?\}, \(\) => clLeftRef\.current\);/.test(jd));

    // ── the Resume Builder (app/(resume-builder)/index.tsx): its build client, cut out and run as it is ──
    const rbSrc = fsT.readFileSync(path.join(ROOT, 'MobileApp', 'app', '(resume-builder)', 'index.tsx'), 'utf8');
    const from = rbSrc.indexOf('// ── THE BUILD RUNS AS A BACKGROUND JOB');
    const to = rbSrc.indexOf('// A ready-to-edit starter resume');
    ok('the builder\'s build client is where this test expects it', from > 0 && to > from);
    const rbJs = tjs(rbSrc.slice(from, to), 'rbClient.ts');
    const web = { calls: [], saved: [], post: null, status: () => ({ status: 'processing' }) };
    const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    const fakeFetch = async (url, init = {}) => {
      web.calls.push([init.method || 'GET', url, init.body ? JSON.parse(init.body) : null]);
      if (/\/resume-builder\/generate-ai$/.test(url)) {
        if (typeof web.post === 'function') return web.post(JSON.parse(init.body));
        if (web.post instanceof Error) throw web.post; return web.post;
      }
      if (/\/resume-builder$/.test(url)) { const s = web.saved.length > 1 ? web.saved.shift() : web.saved[0]; return resp(200, { resumeData: s }); }
      if (/\/job-status\//.test(url)) { const a = web.status(decodeURIComponent(url.split('/job-status/')[1])); return a && a.__http ? resp(a.__http, {}) : resp(200, a); }
      return resp(404, {});
    };
    const RB = vm.runInContext(`(function () {\n${rbJs}\nreturn { runResumeBuild, newBuildId, BUILD_DEADLINE_MS, rerunOf };\n})`,
      sandboxOf({ fetch: fakeFetch, API_BASE: 'https://api.test/api' }))();
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer tok' };
    const PAY = { name: 'N', rawText: 'story' };

    web.calls.length = 0; web.saved = [{ v: 'old' }]; web.post = resp(202, { jobId: 'rb-job-1', status: 'pending' });
    let polls = 0; web.status = () => (++polls < 4 ? { status: 'processing' } : { status: 'completed', data: { resumeData: { v: 'new' } } });
    const b1 = await RB.runResumeBuild(PAY, 'rb-tap-1', H, () => false);
    const post1 = web.calls.find((c) => c[0] === 'POST');
    ok('⚠️ the builder sends the build as a JOB (__async) carrying the tap\'s clientBuildId, and follows that job to its resume',
      b1.kind === 'done' && b1.resumeData.v === 'new' && post1 && post1[2].__async === true && post1[2].clientBuildId === 'rb-tap-1' && post1[2].rawText === 'story', { b1, body: post1 && post1[2] });

    web.saved = [{ v: 'old' }, { v: 'landed' }]; web.status = () => ({ status: 'processing' });
    t0 = clock.now;
    const b2 = await RB.runResumeBuild(PAY, 'rb-tap-2', H, () => false);
    ok('⚠️ no 120-second give-up: it follows the build for 5½ minutes', RB.BUILD_DEADLINE_MS === 5.5 * 60 * 1000 && clock.now - t0 >= RB.BUILD_DEADLINE_MS, (clock.now - t0) / 60000);
    ok('⚠️ …and at the deadline it LOOKS before it speaks: the build already saved → it opens that resume, no regenerate', b2.kind === 'done' && b2.resumeData.v === 'landed', b2);
    web.saved = [{ v: 'same' }];
    const b3 = await RB.runResumeBuild(PAY, 'rb-tap-3', H, () => false);
    ok('…not saved yet → "late" (still building: Keep waiting re-joins it), never "failed"', b3.kind === 'late', b3);

    web.post = resp(202, { jobId: 'rb-job-4' }); web.status = () => ({ status: 'failed', reason: 'quota_exhausted', error: 'You have used your 3 free resume generations.' });
    const b4 = await RB.runResumeBuild(PAY, 'rb-tap-4', H, () => false);
    web.post = new Error('Network request failed');
    const b5 = await RB.runResumeBuild(PAY, 'rb-tap-5', H, () => false);
    web.post = resp(202, { jobId: 'rb-job-6' }); web.status = () => ({ status: 'failed', error: 'We could not finish building your resume.' });
    const b6 = await RB.runResumeBuild(PAY, 'rb-tap-6', H, () => false);
    web.post = resp(200, { success: true, resumeData: { v: 'sync' } });
    const b7 = await RB.runResumeBuild(PAY, 'rb-tap-7', H, () => false);
    ok('a job refused for quota → Plans; no answer to the POST → a retry of the SAME build; a failed job → a new build; asJob\'s sync fallback → done',
      b4.kind === 'quota' && b5.kind === 'failed' && b5.retrySame === true && b6.kind === 'failed' && b6.retrySame === false && b7.kind === 'done' && b7.resumeData.v === 'sync',
      { b4: b4.kind, b5, b6, b7: b7.kind });
    web.post = resp(403, { reason: 'regen_limit', error: 'Your free plan includes one regeneration.' });
    const b8 = await RB.runResumeBuild(PAY, 'rb-tap-8', H, () => false);
    web.post = resp(202, { jobId: 'rb-job-9' }); web.status = () => ({ status: 'failed', reason: 'regen_limit', error: 'Your free plan includes one regeneration.' });
    const b9 = await RB.runResumeBuild(PAY, 'rb-tap-9', H, () => false);
    ok('the free plan\'s one regeneration used — refused at the POST (403) or by the job — is regen_limit (Plans), never a Try again',
      b8.kind === 'regen_limit' && b9.kind === 'regen_limit' && /outcome\.kind === 'regen_limit'[\s\S]{0,300}\/\(subscription\)\/plans/.test(rbSrc), { b8, b9 });
    ok('⚠️ the builder\'s Try again / Keep waiting repeat the SAME build — its id AND its track — (a fresh one only after a real failure), and nothing says "tap Generate again"',
      /autoGenerate\(v, \.\.\.rerunOf\(outcome, buildId\)\)/.test(rbSrc)
        && /generateFromStory\(\.\.\.rerunOf\(outcome, buildId\)\)/.test(rbSrc)
        && (rbSrc.match(/\(\) => leftRef\.current, track,\n/g) || []).length === 2
        && !/controller\.abort\(\), 120_000|tap "Generate" again/.test(rbSrc));

    // ── ⚠️ KEEP WAITING, TAPPED LATE, WAS A SECOND CHARGE ──
    // The server side, modelled as asJob really is: one clientBuildId is ONE job for 15 minutes from its FIRST POST
    // (IDEMPOTENCY_TTL_MS, and findDurableJob's `created_at > NOW() - INTERVAL '15 minutes'`) — after that the same id
    // is a brand-new job; and every job that finishes is charged once (consumeOnSuccess) and saved. The old rerun
    // re-POSTed the same id and re-read `before`: past the window, a second job and a second unit for one resume.
    const TTL = 15 * 60 * 1000;
    const srv = { seen: {}, jobs: {}, made: 0, charges: 0, lose202: false };
    srv.post = (body) => {
      const id = body.clientBuildId; const prior = srv.seen[id];
      if (prior && clock.now - prior.at < TTL) return resp(202, { jobId: prior.jobId, status: 'pending', deduped: true });
      const jobId = 'rb-srv-' + (++srv.made);
      srv.seen[id] = { at: clock.now, jobId }; srv.jobs[jobId] = { status: 'processing' };
      if (srv.lose202) throw new Error('Network request failed');   // it reached the server; the answer never came back
      return resp(202, { jobId, status: 'pending' });
    };
    srv.finish = (jobId, v) => { srv.jobs[jobId] = { status: 'completed', data: { resumeData: { v } } }; srv.charges++; web.saved = [{ v }]; };
    srv.status = (jobId) => srv.jobs[jobId] || { __http: 404 };
    const reset = () => { srv.seen = {}; srv.jobs = {}; srv.made = 0; srv.charges = 0; srv.lose202 = false; web.calls.length = 0; web.post = srv.post; web.status = srv.status; };
    const postsIn = (from) => web.calls.slice(from).filter((c) => c[0] === 'POST').length;
    const MIN = 60 * 1000;

    // (a) the reviewer's scenario, exactly: late at 5½ min, the build finishes and is charged, Keep waiting 10 min later.
    reset(); web.saved = [{ v: 'old' }];
    const l1 = await RB.runResumeBuild(PAY, 'rb-late-1', H, () => false);
    ok('a build still running at the deadline → "late", carrying its job id and the resume from BEFORE its first POST',
      l1.kind === 'late' && l1.track && l1.track.jobId === 'rb-srv-1' && l1.track.before === JSON.stringify({ v: 'old' }) && srv.made === 1, l1);
    srv.finish('rb-srv-1', 'finished');
    clock.now += 10 * MIN;                                        // the phone put down: now >15 min past the first POST
    const [id1, tr1] = RB.rerunOf(l1, 'rb-late-1');
    ok('Keep waiting repeats THIS build: the same id and the same track', id1 === 'rb-late-1' && tr1 === l1.track, { id1, tr1 });
    let mark = web.calls.length;
    const k1 = await RB.runResumeBuild(PAY, id1, H, () => false, tr1);
    ok('⚠️ Keep waiting past asJob\'s 15 minutes FOLLOWS the job it has — no second POST, no second job, ONE charge — and opens the resume',
      k1.kind === 'done' && k1.resumeData.v === 'finished' && postsIn(mark) === 0 && srv.made === 1 && srv.charges === 1,
      { k1, posts: postsIn(mark), made: srv.made, charges: srv.charges });
    // …and that is not luck of the model: the same id POSTed now IS a new job (what the old rerun did).
    const probe = await RB.runResumeBuild(PAY, 'rb-late-1', H, () => false);
    ok('(control) the SAME id POSTed past 15 minutes is a brand-new job — the second charge this closes', srv.made === 2, { made: srv.made, probe: probe.kind });

    // (b) Keep waiting while the job is STILL running: late again, same track, never a POST; then it lands.
    reset(); web.saved = [{ v: 'old' }];
    const l2 = await RB.runResumeBuild(PAY, 'rb-late-2', H, () => false);
    clock.now += 20 * MIN;
    mark = web.calls.length;
    const [id2, tr2] = RB.rerunOf(l2, 'rb-late-2');
    const k2 = await RB.runResumeBuild(PAY, id2, H, () => false, tr2);
    const [id2b, tr2b] = RB.rerunOf(k2, id2);
    const k2b = await RB.runResumeBuild(PAY, id2b, H, () => false, tr2b);
    ok('…still running → "late" again with the SAME track, and not one POST however often Keep waiting is tapped',
      k2b.kind === 'late' && k2.kind === 'late' && k2.track.jobId === 'rb-srv-1' && k2.track.before === l2.track.before && postsIn(mark) === 0 && srv.made === 1,
      { k2, posts: postsIn(mark) });

    // (c) the job row is gone (cleaned up after 24 h) but the resume landed: the CARRIED snapshot still recognises it.
    reset(); web.saved = [{ v: 'old' }];
    const l3 = await RB.runResumeBuild(PAY, 'rb-late-3', H, () => false);
    srv.finish('rb-srv-1', 'landed-then-cleaned'); delete srv.jobs['rb-srv-1'];
    clock.now += 25 * 60 * MIN;
    mark = web.calls.length;
    const [id3, tr3] = RB.rerunOf(l3, 'rb-late-3');
    const k3 = await RB.runResumeBuild(PAY, id3, H, () => false, tr3);
    ok('⚠️ …its job row gone a day later: the snapshot from before the FIRST POST (carried, not re-read) finds the resume that landed — no POST',
      k3.kind === 'done' && k3.resumeData.v === 'landed-then-cleaned' && postsIn(mark) === 0 && srv.made === 1 && srv.charges === 1, { k3, posts: postsIn(mark) });

    // (d) the lost 202: the POST reached the server and the build ran, but no answer came back — Try again 20 min later.
    reset(); web.saved = [{ v: 'old' }]; srv.lose202 = true;
    const f4 = await RB.runResumeBuild(PAY, 'rb-lost-4', H, () => false);
    srv.lose202 = false; srv.finish('rb-srv-1', 'ran-unseen');
    clock.now += 20 * MIN;
    const [id4, tr4] = RB.rerunOf(f4, 'rb-lost-4');
    mark = web.calls.length;
    const k4 = await RB.runResumeBuild(PAY, id4, H, () => false, tr4);
    ok('⚠️ a lost 202 retried past the window: the saved resume differs from the CARRIED snapshot → opened, not POSTed again',
      f4.kind === 'failed' && f4.retrySame === true && id4 === 'rb-lost-4' && tr4 && tr4.jobId === null && tr4.before === JSON.stringify({ v: 'old' })
        && k4.kind === 'done' && k4.resumeData.v === 'ran-unseen' && postsIn(mark) === 0 && srv.made === 1 && srv.charges === 1,
      { f4, k4, posts: postsIn(mark), made: srv.made });

    // (e) the POST never reached the server: nothing landed → the SAME id is POSTed once, and that build is the one charge.
    reset(); web.saved = [{ v: 'old' }];
    web.post = () => { throw new Error('Network request failed'); };
    const f5 = await RB.runResumeBuild(PAY, 'rb-offline-5', H, () => false);
    web.post = srv.post;
    let polls5 = 0; web.status = (j) => (++polls5 < 3 ? srv.status(j) : (srv.jobs[j].status === 'processing' && srv.finish(j, 'first-and-only'), srv.status(j)));
    mark = web.calls.length;
    const [id5, tr5] = RB.rerunOf(f5, 'rb-offline-5');
    const k5 = await RB.runResumeBuild(PAY, id5, H, () => false, tr5);
    const post5 = web.calls.slice(mark).filter((c) => c[0] === 'POST');
    ok('…and a POST that never arrived: nothing landed → the SAME id POSTed exactly once, one job, one charge',
      k5.kind === 'done' && k5.resumeData.v === 'first-and-only' && post5.length === 1 && post5[0][2].clientBuildId === 'rb-offline-5' && srv.made === 1 && srv.charges === 1,
      { k5, posts: post5.length, made: srv.made });

    // (f) a real failure is a NEW build: fresh id, no track (a fresh snapshot is read).
    const [id6, tr6] = RB.rerunOf({ kind: 'failed', message: 'x', retrySame: false }, 'rb-dead-6');
    ok('a real failure → Try again is a NEW build: a fresh id and no carried track', id6 !== 'rb-dead-6' && /^rb-/.test(id6) && tr6 === undefined, { id6, tr6 });
  }

  // ── tidy: the handlers are real, so they wrote real files. Remove everything THIS RUN created
  // (name pattern + created after we started); nothing older is touched.
  const fsSync = require('fs');
  const tempDir = path.join(ROOT, 'temp');
  const MINE = /^(Test_User_Resume_|Cover_Letter_)/;
  let removed = 0;
  try {
    for (const f of fsSync.readdirSync(tempDir)) {
      if (!MINE.test(f) && !written.includes(f)) continue;
      try { if (fsSync.statSync(path.join(tempDir, f)).mtimeMs >= STARTED) { fsSync.unlinkSync(path.join(tempDir, f)); removed++; } } catch {}
    }
  } catch {}
  note('temp files written by the real handlers and cleaned up', removed);

  console.log('\n' + '─'.repeat(78));
  if (failures.length) { console.log('FAILED assertions:'); failures.forEach((f) => console.log('   ✗ ' + f)); }
  console.log(`single-purchase flow: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nHARNESS ERROR:', e); process.exit(2); });
