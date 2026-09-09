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
const ai = { resumeCalls: 0, letterCalls: 0, researchCalls: 0, letterFailOn: null };

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
  resumeRow: { resume_data: { personal_info: { full_name: 'Test User', email: 't@e.st' }, experience: [], _buildMethod: 'ai' }, regen_count: 0 },
};
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function dbGet(sql, params = []) {
  const q = norm(sql);
  db.log.push(q.slice(0, 90));

  // ── download_passes: the money table ──────────────────────────────────────────────────────────
  if (/SELECT COUNT\(\*\)::int AS n FROM download_passes/.test(q)) {
    const [uid, env] = params;
    return { n: db.passes.filter((p) => p.user_id === uid && p.environment === env && !p.bound_at).length };
  }
  if (/SELECT id, employer_name FROM download_passes/.test(q)) {
    const [uid, key, env] = params;
    return db.passes.find((p) => p.user_id === uid && p.employer_key === key && p.environment === env && p.bound_at) || null;
  }
  if (/UPDATE download_passes SET employer_key/.test(q)) {
    db.claimUpdates++;
    const [uid, key, name, env] = params;
    const row = db.passes
      .filter((p) => p.user_id === uid && !p.bound_at && p.environment === env)
      .sort((a, b) => a.created_at - b.created_at)[0];
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
  if (/FROM user_credits/.test(q)) return { credits_remaining: 0, expiry_date: null };
  if (/FROM users/.test(q)) return { id: params[0], full_name: 'Test User', email: 't@e.st', phone_number: '1', city: 'Pune', country: 'IN', photo_path: null, resume_path: '/uploads/r.pdf', total_generated: 0 };
  if (/FROM employer_brand_profiles/.test(q)) return null;
  if (/FROM jobs/.test(q)) return null;
  return null;
}
const dbPath = require.resolve(path.join(ROOT, 'db-config.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  get: dbGet, query: async () => [], run: async (sql) => { db.log.push('RUN ' + norm(sql).slice(0, 70)); return {}; },
  withTransaction: async (fn) => fn({ get: dbGet, run: async () => ({}) }), isUniqueViolation: () => false, getDbType: () => 'postgres',
} };

// ── entitlements: the PLAN side of the money. `sub` null = no plan; the free allowance is a gate. ─
const ent = { sub: null, gate: { allowed: true, remaining: 5 }, consumed: [] };
const entPath = require.resolve(path.join(ROOT, 'server', 'services', 'entitlements.js'));
require.cache[entPath] = { id: entPath, filename: entPath, loaded: true, exports: {
  activeSubscription: async () => ent.sub,
  canConsumeMany: async () => ent.gate,
  consumeOnSuccess: async (u, kind, detail) => { ent.consumed.push({ u, kind, detail }); return { via: 'plan' }; },
  usageSnapshot: async () => ({}),
} };

// ── the AI. Never a network call; just a counter and a canned answer. ──────────────────────────
const genaiPath = require.resolve('@google/generative-ai');
require.cache[genaiPath] = { id: genaiPath, filename: genaiPath, loaded: true, exports: {
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent: async () => {
        ai.resumeCalls++;
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
  if (ai.letterFailOn && String(subject).includes(ai.letterFailOn)) throw new Error('AI provider exploded');
  return { employer_name: String(subject).replace(/^https?:\/\//, ''), cover_letter: 'Dear Hiring Manager,\n\nPlease hire me.\n\nRegards', to: 'Hiring Manager', subject: 'Application', addresses: ['1 Road'] };
} });
stub('ai-employer-researcher.js', { researchEmployer: async () => { ai.researchCalls++; return { employer_name: 'Acme Corp', brand_color: '#123456', font_name: 'Lato' }; } });
stub('server/controllers/notificationsController.js', { notifyCoverLetterGenerated: async () => {}, notifyError: async () => {}, notifySuccess: async () => {} });
stub('server/services/jobService.js', { createJob: async () => 'job1', failJob: async () => {}, completeJob: async () => {} });
stub('server/controllers/emailController.js', { generateCoverLetterPDF: async () => { rendered.clPdf++; return { fileName: 'generic.pdf', filePath: '/tmp/generic.pdf' }; } });
stub('server/services/eventCosts.js', { getEventCost: async () => 1 });
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
  const r = { statusCode: 200, body: null, sent: false };
  r.status = (c) => { r.statusCode = c; return r; };
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

  // The raw service cannot bridge the two spellings — it is only ever given one string, and
  // "https://acme.test" is not "acme corp". Asserted so the reason resolveEmployer exists stays
  // visible: without it, this is precisely where the second charge came from.
  const rawGate = await D.canDownload(4, { employer: aiEmployerName }, mkReq(4, {}));
  ok('the raw service alone does NOT bridge the two spellings (why resolveEmployer exists)',
     rawGate.allowed === false, { rawGate });

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

  // ── tidy: the handlers are real, so they wrote real files. Remove everything THIS RUN created
  // (name pattern + created after we started); nothing older is touched.
  const fsSync = require('fs');
  const tempDir = path.join(ROOT, 'temp');
  const MINE = /^(Test_User_Resume_|Cover_Letter_(Acme_Corp|acme_test|beta_test)_)/;
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
