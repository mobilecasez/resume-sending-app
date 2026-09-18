// The per-employer documents round (Migration 046) — the storage, identity and ranking pieces that can be
// exercised WITHOUT a database: a stubbed db-config records every statement, and the pure modules
// (designFit, employerResearch, findPlaceholders) are required as they are.
//   node server/scripts/test-employer-docs.js
//
// Why these exist: Home now shows each employer's OWN resume and letter straight from the database, and a
// document id arrives from the phone. Every read and write here must be scoped by the user AND the store
// environment in the SQL itself; the base snapshot ('(none)') must never be pruned, listed or edited; and
// the name a user picked for an employer must win for that user (the "Souq.com for E-Commerce LLC" chip).
// The money lanes themselves are exercised in test-employer-doc-lane.js and test-employer-letter.js.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const R = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Assertions about CODE run on comment-stripped source: these files explain their rules in prose that
// repeats the very tokens being tested, and matching your own explanation proves nothing.
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
// The body of one top-level `async function name(` / `function name(`, up to the next top-level function.
const fnBody = (src, name) => {
  const start = src.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  if (start < 0) return '';
  const rest = src.slice(start + 1);
  const next = rest.search(/^(?:async )?function \w+\(|^module\.exports/m);
  return src.slice(start, next < 0 ? undefined : start + 1 + next);
};

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 300) : '')); } };

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// ── a recording database ───────────────────────────────────────────────────────────────────────────
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const db = { log: [], answer: () => null, throwOn: null };
const record = (verb) => async (sql, params = []) => {
  const q = norm(sql);
  db.log.push({ verb, sql: q, params });
  if (db.throwOn && db.throwOn.test(q)) throw Object.assign(new Error('boom'), { code: '08006' });
  const a = db.answer(q, params, verb);
  if (verb === 'query') return Array.isArray(a) ? a : [];
  if (verb === 'run') return a || { changes: 0 };
  return a === undefined ? null : a;
};
const txLog = [];
const tx = { answer: () => null };
const txVerb = (verb) => async (sql, params = []) => {
  const q = norm(sql);
  txLog.push({ verb, sql: q, params });
  const a = tx.answer(q, params, verb);
  if (verb === 'run') return a || { rows: [], changes: 0 };
  if (verb === 'query') return a || { rows: [] };
  return a === undefined ? null : a;
};
const dbPath = require.resolve(path.join(ROOT, 'db-config.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  get: record('get'), query: record('query'), run: record('run'),
  withTransaction: async (fn) => fn({ get: txVerb('get'), run: txVerb('run'), query: txVerb('query') }),
  isUniqueViolation: () => false, getDbType: () => 'postgres',
} };
const last = (re) => [...db.log].reverse().find((e) => re.test(e.sql)) || null;
const reset = () => { db.log.length = 0; db.answer = () => null; db.throwOn = null; };

(async () => {
  const docs = require(path.join(ROOT, 'server/services/employerDocs.js'));
  const downloads = require(path.join(ROOT, 'server/services/downloads.js'));
  const docsC = strip(R('server/services/employerDocs.js'));

  console.log('── employerDocs: the constants that decide money ──');
  // ⚠️ FP_VERSION IS SHARED BY EVERY LANE, SO BUMPING IT IS A BILL. 'v2' threw away every paid
  // builder-lane row whose prompt had not changed a word: going back to an employer the user already
  // built charged them a second time. It stays 'v1'; a lane that needs its own revision folds it into
  // ITS OWN researchRev (the doc lane's docResearchRev, the letter lane's LETTER_REV), which is what
  // already keeps the three lanes from ever reading each other's rows.
  ok('⚠️ FP_VERSION is v1 — bumping the SHARED version re-bills every lane\'s paid cache', docs.FP_VERSION === 'v1');
  {
    // Same inputs, three lanes: the researchRev each lane passes is the only thing that separates
    // them, so they must land on three different fingerprints with no help from FP_VERSION.
    const same = { baseText: 'my resume', jobText: 'a role at Acme' };
    const builder = docs.fingerprint({ ...same, researchRev: 'none' });   // RESEARCH_REV, builder lane
    const docLane = docs.fingerprint({ ...same, researchRev: 'r1' });     // docResearchRev(), Home lane
    const letter = docs.fingerprint({ ...same, researchRev: 'letter-v1|r1' });
    ok('⚠️ …and the builder, doc and letter lanes still fingerprint the same inputs apart',
      builder !== docLane && docLane !== letter && builder !== letter,
      { builder: builder.slice(0, 8), docLane: docLane.slice(0, 8), letter: letter.slice(0, 8) });
  }
  ok('KEEP_PER_KIND is 120 (a pruned row is a chip whose resume vanished)', docs.KEEP_PER_KIND === 120);
  ok('the design cap is 64 KB', docs.MAX_DESIGN_BYTES === 64 * 1024);
  ok('the fingerprint folds the version in', /\[FP_VERSION, norm\(baseText\)/.test(docsC));
  ok('the fingerprint is deterministic and whitespace-insensitive',
    docs.fingerprint({ baseText: 'a  b', jobText: 'x' }) === docs.fingerprint({ baseText: 'a b', jobText: ' x ' }));

  console.log('── ⚠️ getById is scoped by user AND environment IN THE SQL, and never returns the base ──');
  reset();
  db.answer = (q) => (/^SELECT \* FROM user_employer_documents WHERE id = \$1/.test(q) ? { id: 5, kind: 'resume', payload: '{"personal_info":{}}', design: '{"v":1}' } : null);
  const g1 = await docs.getById(7, '5', 'Sandbox', { kind: 'resume' });
  const e1 = last(/FROM user_employer_documents WHERE id = \$1/);
  ok('the SQL names user_id, environment, the base exclusion and the kind',
    e1 && /id = \$1 AND user_id = \$2 AND environment = \$3 AND employer_key <> \$4/.test(e1.sql) && /AND kind = \$5/.test(e1.sql), e1 && e1.sql);
  ok('…bound to this user, this environment, (none) and the kind', e1 && JSON.stringify(e1.params) === JSON.stringify([5, 7, 'Sandbox', '(none)', 'resume']), e1 && e1.params);
  ok('the shaped row parses payload AND design', g1 && g1.payload.personal_info && g1.design && g1.design.v === 1, g1);
  reset();
  ok('a malformed id is null with NO query', (await docs.getById(7, '12abc', 'Production')) === null && db.log.length === 0);
  ok('an out-of-range id is null with NO query', (await docs.getById(7, '99999999999', 'Production')) === null && db.log.length === 0);
  ok('an unknown kind is null with NO query', (await docs.getById(7, 5, 'Production', { kind: 'letter' })) === null && db.log.length === 0);
  db.throwOn = /./;
  ok('a database error is null, never a throw', (await docs.getById(7, 5, 'Production')) === null);

  console.log('── ⚠️ currentFor: newest non-base row for this user/kind/env/job_url and this employer ──');
  reset();
  const EMP = '3f2a9c1e-1111-4222-8333-444455556666';
  db.answer = () => null;
  await docs.currentFor(7, 'resume', { employer: 'Amazon', employerId: EMP.toUpperCase(), jobUrl: '  https://amazon.jobs/1  ' }, 'Production');
  const c1 = db.log[0];
  ok('the exact read scopes user, kind, environment and job_url, and excludes the base',
    c1 && /WHERE user_id = \$1 AND kind = \$2 AND environment = \$3 AND job_url = \$4 AND employer_key <> \$5/.test(c1.sql), c1 && c1.sql);
  ok('…matching the employer by key OR the tracked employer id', c1 && /employer_key = \$6 OR \(\$7::uuid IS NOT NULL AND employer_id = \$7::uuid\)/.test(c1.sql));
  ok('…with the job URL trimmed the way put() stores it, and the id lower-cased',
    c1 && c1.params[3] === 'https://amazon.jobs/1' && c1.params[5] === 'amazon' && c1.params[6] === EMP && c1.params[2] === 'Production', c1 && c1.params);
  ok('…newest first', c1 && /ORDER BY updated_at DESC LIMIT 1/.test(c1.sql));
  const c2 = db.log[1];
  ok('the bounded name pass is slim (no payload) and scoped the same way',
    c2 && /^SELECT id, employer_key, employer_name FROM user_employer_documents WHERE user_id = \$1 AND kind = \$2 AND environment = \$3 AND job_url = \$4 AND employer_key <> \$5/.test(c2.sql), c2 && c2.sql);
  reset();
  db.answer = (q) => {
    if (/^SELECT id, employer_key, employer_name FROM/.test(q)) return [{ id: 41, employer_key: 'amazon com', employer_name: 'Amazon.com, Inc.' }];
    if (/^SELECT \* FROM user_employer_documents WHERE id = \$1 AND user_id = \$2/.test(q)) return { id: 41, payload: '{}' };
    return null;
  };
  const c3 = await docs.currentFor(7, 'resume', { employer: 'Amazon.com Inc', jobUrl: '' }, 'Production');
  const c3fetch = last(/WHERE id = \$1 AND user_id = \$2/);
  ok('a sameEmployer spelling is found, and the winner is re-read BY id AND user_id',
    c3 && c3.id === 41 && c3fetch && JSON.stringify(c3fetch.params) === JSON.stringify([41, 7]), { c3, p: c3fetch && c3fetch.params });
  reset();
  ok('no employer and no id → null, no query (the base snapshot is not a document)',
    (await docs.currentFor(7, 'resume', { employer: '', jobUrl: '' }, 'Production')) === null && db.log.length === 0);
  // Pre-046 database: the employer_id column does not exist yet — the key alone must still find the doc.
  reset();
  let firstThrew = false;
  db.answer = (q) => {
    if (/employer_id = \$7::uuid/.test(q) && !firstThrew) { firstThrew = true; throw Object.assign(new Error('column "employer_id" does not exist'), { code: '42703' }); }
    if (/employer_key <> \$5 AND employer_key = \$6/.test(q)) return { id: 9, payload: '{}' };
    return null;
  };
  const c4 = await docs.currentFor(7, 'resume', { employer: 'Nordex', employerId: EMP, jobUrl: '' }, 'Production');
  ok('before Migration 046 lands, the key-only read still finds the document', c4 && c4.id === 9, c4);

  console.log('── ⚠️ updatePayload: refuse, never truncate; scoped; a blip is not "gone" ──');
  reset();
  db.answer = (q) => (/^UPDATE user_employer_documents SET payload = \$1/.test(q) ? { updated_at: new Date('2026-09-11T10:00:00Z') } : null);
  const u1 = await docs.updatePayload(7, 5, { personal_info: { full_name: 'A' } }, 'Production', { kind: 'resume' });
  const ue = last(/^UPDATE user_employer_documents/);
  ok('ok with an ISO updatedAt', u1.ok === true && u1.updatedAt === '2026-09-11T10:00:00.000Z', u1);
  ok('the UPDATE sets edited_at and updated_at', ue && /SET payload = \$1, edited_at = NOW\(\), updated_at = NOW\(\)/.test(ue.sql), ue && ue.sql);
  ok('…scoped by id, user, environment, the base exclusion and the kind',
    ue && /WHERE id = \$2 AND user_id = \$3 AND environment = \$4 AND employer_key <> \$5 AND kind = \$6/.test(ue.sql)
    && JSON.stringify(ue.params.slice(1)) === JSON.stringify([5, 7, 'Production', '(none)', 'resume']), ue && ue.params);
  reset();
  const big = { personal_info: {}, blob: 'x'.repeat(docs.MAX_PAYLOAD_BYTES + 10) };
  const u2 = await docs.updatePayload(7, 5, big, 'Production');
  ok('over 512 KB → too_big, with NO write', u2.ok === false && u2.reason === 'too_big' && db.log.length === 0, u2);
  ok('an array payload → invalid', (await docs.updatePayload(7, 5, [1], 'Production')).reason === 'invalid');
  ok('a malformed id → gone, with NO write', (await docs.updatePayload(7, 'x', {}, 'Production')).reason === 'gone' && db.log.length === 0);
  reset();
  ok('no row matched → gone', (await docs.updatePayload(7, 5, {}, 'Production')).reason === 'gone');
  db.throwOn = /^UPDATE/;
  ok('⚠️ a database error → failed, NEVER gone (gone makes the client drop the user\'s edits)',
    (await docs.updatePayload(7, 5, {}, 'Production')).reason === 'failed');

  console.log('── listSlim: no payloads, no research, never the base ──');
  reset();
  db.answer = (q) => (/^SELECT id, employer_name, employer_id/.test(q)
    ? [{ id: '12', employer_name: 'Airbus', employer_id: EMP, job_url: '', job_title: '', updated_at: new Date('2026-09-10T00:00:00Z'), top: { id: 'banner', score: 91.4 } }]
    : []);
  const ls = await docs.listSlim(7, 'resume', 'Production');
  const le = last(/FROM user_employer_documents/);
  ok('reads no payload or research column', le && !/payload|research|SELECT \*/.test(le.sql), le && le.sql);
  ok('the top design comes from the design column in SQL', le && /design->'ranked'->0 AS top/.test(le.sql));
  ok('scoped and base-excluded, newest first, capped', le && /WHERE user_id = \$1 AND kind = \$2 AND environment = \$3 AND employer_key <> \$4 ORDER BY updated_at DESC LIMIT \$5/.test(le.sql)
    && le.params[3] === '(none)' && le.params[4] === 120, le && le.params);
  ok('the contract shape', ls.length === 1 && JSON.stringify(ls[0]) === JSON.stringify({ docId: 12, employer: 'Airbus', employerId: EMP, jobUrl: '', jobTitle: '', updatedAt: '2026-09-10T00:00:00.000Z', topId: 'banner', topScore: 91 }), ls);

  console.log('── ⚠️ put(): hints are hints; prune never counts or deletes the base snapshot ──');
  reset();
  db.answer = (q) => (/^INSERT INTO user_employer_documents/.test(q) ? { id: 77 } : null);
  const p1 = await docs.put({ userId: 7, kind: 'resume', employer: 'Amazon', jobUrl: '', jobTitle: '', fingerprint: 'f'.repeat(64), model: 'gemini-2.5-flash', payload: { personal_info: {} }, env: 'Production', employerId: 'name_amazon', design: { v: 1, ranked: [] } });
  await new Promise((r) => setImmediate(r));
  const pe = last(/^INSERT INTO user_employer_documents/);
  ok('returns the id', p1 === 77);
  ok('a non-UUID employerId is stored as NULL (a uuid column REJECTS it, after the user paid)', pe && pe.params[11] === null, pe && pe.params[11]);
  ok('the upsert keeps design and employer_id when a rebuild omits them, and clears edited_at',
    pe && /design = COALESCE\(EXCLUDED\.design, user_employer_documents\.design\)/.test(pe.sql)
    && /employer_id = COALESCE\(EXCLUDED\.employer_id, user_employer_documents\.employer_id\)/.test(pe.sql)
    && /edited_at = NULL/.test(pe.sql), pe && pe.sql);
  const pr = last(/^DELETE FROM user_employer_documents/);
  ok('put() prunes, and the prune sub-select excludes the base row from the count AND the delete',
    pr && /SELECT id FROM user_employer_documents WHERE user_id = \$1 AND kind = \$2 AND environment = \$3 AND employer_key <> \$5 ORDER BY updated_at DESC OFFSET \$4/.test(pr.sql)
    && pr.params[4] === '(none)' && pr.params[3] === 120, pr);
  reset();
  db.answer = (q) => (/^INSERT/.test(q) ? { id: 78 } : null);
  await docs.put({ userId: 7, kind: 'resume', employer: 'Amazon', fingerprint: 'e'.repeat(64), payload: {}, env: 'Production', employerId: EMP, design: { v: 1, junk: 'x'.repeat(70 * 1024) } });
  const pe2 = last(/^INSERT/);
  ok('a real UUID is stored lower-cased; a design over 64 KB is stored as NULL (the row is kept)',
    pe2 && pe2.params[11] === EMP && pe2.params[12] === null, pe2 && [pe2.params[11], pe2.params[12] && pe2.params[12].length]);
  reset();
  ok('an unknown kind is never stored, and never prunes', (await docs.put({ userId: 7, kind: 'letter', employer: 'A', fingerprint: 'a', payload: {} })) === null && db.log.length === 0);
  await docs.prune(7, 'letter', 'Production');
  ok('⚠️ prune with an unknown kind never runs a DELETE', !db.log.some((e) => /^DELETE/.test(e.sql)));

  console.log('── Migration 046 is in db-init, additive and outside the unique key ──');
  const dbInit = R('db-init.js');
  for (const stmt of [
    /ALTER TABLE user_employer_documents ADD COLUMN IF NOT EXISTS design JSONB/,
    /ALTER TABLE user_employer_documents ADD COLUMN IF NOT EXISTS employer_id UUID/,
    /ALTER TABLE user_employer_documents ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ/,
    /CREATE INDEX IF NOT EXISTS idx_user_employer_docs_empid\s+ON user_employer_documents \(user_id, kind, employer_id, updated_at DESC\)/,
    /ALTER TABLE user_employer_documents ADD COLUMN IF NOT EXISTS job_input JSONB/,
    /ALTER TABLE user_tracked_employers ADD COLUMN IF NOT EXISTS display_name VARCHAR\(255\)/,
    /CREATE TABLE IF NOT EXISTS user_home_hidden_targets/,
    /CREATE TABLE IF NOT EXISTS employer_research_cache/,
  ]) ok('migration 046: ' + stmt.source.slice(0, 70), stmt.test(dbInit));
  // ⚠️ FREEZE EVERY EXISTING CHIP'S NAME ON THE WAY IN. A NULL display_name follows the SHARED employers
  // row, and that row is renamed by whichever job ingest reaches the domain: without this backfill a
  // scrape (or another user's add, before that was removed) silently changed an existing user's chip name
  // AND the employer key their passes and cached documents bill under. Idempotent — only NULL rows.
  ok('⚠️ migration 046 FREEZES today\'s name into every existing chip (or a rename re-bills them)',
    /UPDATE user_tracked_employers ute\s+SET display_name = LEFT\(e\.name, 255\)\s+FROM employers e\s+WHERE e\.id = ute\.employer_id\s+AND ute\.display_name IS NULL/.test(dbInit)
    && /AND e\.name IS NOT NULL AND btrim\(e\.name\) <> ''/.test(dbInit));
  ok('⚠️ the unique key is still exactly the five NOT NULL members',
    /uq_user_employer_docs[\s\S]{0,200}\(user_id, kind, employer_key, input_fingerprint, environment\)/.test(strip(dbInit))
    && !/uq_user_employer_docs[^;]{0,200}employer_id/.test(strip(dbInit)));

  console.log('── designFit: the ranking invariants, for every catalogue ──');
  const fit = require(path.join(ROOT, 'server/services/designFit.js'));
  const RT = require(path.join(ROOT, 'server/utils/resumeTemplates.js'));
  const RIDS = RT.TEMPLATE_IDS;
  const LIDS = require(path.join(ROOT, 'server/utils/coverLetterTemplates.js')).TEMPLATE_IDS;
  // ⚠️ RETARGETED 2026-09-15 — RESUME ORDER IS FAMILY-FIRST. Prod ranked Deutsche Bahn's top three as germany_warm 86 /
  // germany 84 / germany_blue 83: three colour variants of ONE family, three identical pages once the brand colour was
  // painted over them. A resume `ranked` is now two runs: ONE card per family (its best member) in family-score order,
  // ties in FAMILY catalogue order; then every remaining variant, score desc, ties in catalogue order. Scores descend
  // within each run, NOT across the seam (the tail's first variant outscores the last family card by design), so
  // "sorted desc over the whole list" is no longer the invariant for a resume. Letters keep plain score order.
  const FAMS = RT.FAMILIES.map((f) => f.id);
  const famOfId = (id) => (RT.TEMPLATES.find((t) => t.id === id) || {}).family || id;
  const sortedRun = (run, ids, tieIndex) => {
    for (let i = 1; i < run.length; i++) {
      if (run[i - 1].score < run[i].score) return 'not sorted at ' + i;
      if (run[i - 1].score === run[i].score && tieIndex(run[i - 1].id) > tieIndex(run[i].id)) return 'tie order at ' + i;
    }
    return null;
  };
  const invariant = (d, ids, kind) => {
    if (!d || d.v !== 1 || d.kind !== kind || !Array.isArray(d.ranked)) return 'shape';
    if (d.ranked.length !== ids.length) return 'length ' + d.ranked.length + ' vs ' + ids.length;
    const seen = new Set(d.ranked.map((r) => r.id));
    if (seen.size !== ids.length || ids.some((id) => !seen.has(id))) return 'not every id exactly once';
    for (let i = 0; i < d.ranked.length; i++) {
      const r = d.ranked[i];
      if (!Number.isInteger(r.score) || r.score < 0 || r.score > 100) return 'score ' + JSON.stringify(r);
      if (typeof r.reason !== 'string' || r.reason.length > 90) return 'reason ' + JSON.stringify(r);
    }
    if (!['a4', 'onepage'].includes(d.mode)) return 'mode';
    if (kind !== 'resume') return sortedRun(d.ranked, ids, (id) => ids.indexOf(id));   // letters: one run, ties in catalogue order
    const cards = d.ranked.slice(0, FAMS.length);
    const tail = d.ranked.slice(FAMS.length);
    if (new Set(cards.map((r) => famOfId(r.id))).size !== FAMS.length) return 'two cards of one family among the first ' + FAMS.length;
    for (const c of cards) {
      const best = Math.max(...d.ranked.filter((r) => famOfId(r.id) === famOfId(c.id)).map((r) => r.score));
      if (c.score !== best) return 'card ' + c.id + ' is not its family\'s best (' + c.score + ' vs ' + best + ')';
    }
    const cardsErr = sortedRun(cards, ids, (id) => FAMS.indexOf(famOfId(id)));
    if (cardsErr) return 'cards: ' + cardsErr;
    const tailErr = sortedRun(tail, ids, (id) => ids.indexOf(id));
    if (tailErr) return 'variants: ' + tailErr;
    return null;
  };
  const resumeCases = [
    {},
    { region: 'us_ca', companySize: '10,001+ employees', industry: 'Banking', seniorityYears: 15 },
    { region: 'dach', brandColor: '#e30613', industry: 'Design agency', seniorityYears: 2 },
    { region: 'india', aiFamilyScores: { mono: { score: 140, reason: 'x'.repeat(200) }, banner_teal: { score: '92%', reason: 'variant key' }, ats: { score: -5 }, bogus: { score: 99 } }, mode: 'onepage', tone: ' Engineering-first ', headline: 'h' },
    { region: 'not_a_region', brandColor: 'orange', seniorityYears: NaN, mode: 'letter' },
  ];
  for (const [i, c] of resumeCases.entries()) {
    const d = fit.rankResumeDesigns(c);
    ok(`resume ranking #${i}: every id once, integer 0..100, family-first (one card per family, then the variants), each run sorted desc`, invariant(d, RIDS, 'resume') === null, invariant(d, RIDS, 'resume'));
  }
  const dAi = fit.rankResumeDesigns(resumeCases[3]);
  ok('an AI score over 100 is clamped, and the AI\'s mode wins when valid', dAi.ranked.every((r) => r.score <= 100) && dAi.mode === 'onepage');
  ok('an invalid brand colour is null, an invalid region is generic', fit.rankResumeDesigns(resumeCases[4]).brandColor === null && fit.rankResumeDesigns(resumeCases[4]).region === 'generic');
  ok('mode: onepage under 8 years in us_ca, a4 in dach', fit.rankResumeDesigns({ region: 'us_ca', seniorityYears: 4 }).mode === 'onepage' && fit.rankResumeDesigns({ region: 'dach', seniorityYears: 4 }).mode === 'a4');
  ok('the family brief is a table with the contract header', /id \| name \| layout \| photo slot \| ats 1-5 \| visual tone/.test(fit.resumeFamilyBrief()));
  const letterCases = [{}, { region: 'dach', seniorityYears: 14 }, { region: 'uk_au', isTechnicalRole: true, companySize: '10,001+', brandColor: '#123456' }, { seniorityYears: 1 }];
  for (const [i, c] of letterCases.entries()) {
    const d = fit.rankLetterDesigns(c);
    ok(`letter ranking #${i}: every id once, integer 0..100, sorted desc, ties in catalogue order`, invariant(d, LIDS, 'cover_letter') === null, invariant(d, LIDS, 'cover_letter'));
  }
  ok('the region\'s own letter format leads (dach → german)', fit.rankLetterDesigns({ region: 'dach' }).ranked[0].id === 'german');
  ok('rankLetterDesigns is deterministic', JSON.stringify(fit.rankLetterDesigns(letterCases[2])) === JSON.stringify(fit.rankLetterDesigns(letterCases[2])));
  const repaired = fit.normaliseDesign({ v: 1, kind: 'resume', ranked: [{ id: 'mono', score: 101.6 }, { id: 'gone_design', score: 99 }, { id: 'mono', score: 3 }, { id: 'ats', score: '70' }], mode: 'weird' }, 'resume');
  ok('normaliseDesign repairs a stored design to the invariants', invariant(repaired, RIDS, 'resume') === null && repaired.ranked[0].id === 'mono' && repaired.ranked[0].score === 100 && !repaired.ranked.some((r) => r.id === 'gone_design') && repaired.mode === 'a4', invariant(repaired, RIDS, 'resume'));
  ok('…and null only for a non-object', fit.normaliseDesign(null, 'resume') === null && fit.normaliseDesign(42, 'resume') === null);
  const good = fit.rankLetterDesigns({ region: 'eu' });
  ok('…a valid design round-trips unchanged', JSON.stringify(fit.normaliseDesign(good, 'cover_letter')) === JSON.stringify(good));
  ok('regionFor: country first, then the TLD, then generic',
    fit.regionFor({ country: 'Germany', website: 'acme.co.uk' }) === 'dach' && fit.regionFor({ website: 'https://acme.co.uk' }) === 'uk_au' && fit.regionFor({}) === 'generic',
    [fit.regionFor({ country: 'Germany', website: 'acme.co.uk' }), fit.regionFor({ website: 'https://acme.co.uk' }), fit.regionFor({})]);
  ok('seniorityYearsOf never throws and is 0 when unknown', fit.seniorityYearsOf(null) === 0 && fit.seniorityYearsOf({ experience: [{ start_date: 'soon' }] }) === 0);

  console.log('── ⚠️ RESUME ORDER IS FAMILY-FIRST (2026-09-15): one card per family, then the variants ──');
  {
    // Deutsche Bahn-like: brand #ec0016, DACH, an enterprise, 14 years. Prod's first three cards were germany_warm /
    // germany / germany_blue — one family three times, three identical pages under the brand colour.
    const DB = { region: 'dach', brandColor: '#ec0016', industry: 'Rail and logistics', companySize: '10,001+ employees', seniorityYears: 14, employerType: 'enterprise' };
    const dDb = fit.rankResumeDesigns(DB);
    const cards = dDb.ranked.slice(0, FAMS.length);
    ok('⚠️ no two of the first 15 cards share a family (15 families, 15 cards)', new Set(cards.map((r) => famOfId(r.id))).size === FAMS.length && cards.length === FAMS.length, cards.map((r) => `${r.id}:${r.score}`));
    ok('every id appears exactly once (73)', dDb.ranked.length === RIDS.length && new Set(dDb.ranked.map((r) => r.id)).size === RIDS.length);
    ok('every score an integer 0..100', dDb.ranked.every((r) => Number.isInteger(r.score) && r.score >= 0 && r.score <= 100));
    ok('the German CV leads for a German employer, and its ONE card is the variant closest to the brand red (germany_warm — the prod winner), not the base',
      famOfId(dDb.ranked[0].id) === 'germany' && dDb.ranked[0].id === 'germany_warm' && !cards.slice(1).some((r) => famOfId(r.id) === 'germany'), dDb.ranked.slice(0, 3));
    ok('each card is its family\'s best score; the other variants follow after ALL the families, keeping their family score minus the step',
      invariant(dDb, RIDS, 'resume') === null && dDb.ranked.slice(FAMS.length).every((r) => r.score <= cards.find((c) => famOfId(c.id) === famOfId(r.id)).score), invariant(dDb, RIDS, 'resume'));
    ok('⚠️ the seam: the tail\'s first variant outscores the last family card — why "sorted desc over the whole list" is no longer the invariant',
      dDb.ranked[FAMS.length].score > dDb.ranked[FAMS.length - 1].score, [dDb.ranked[FAMS.length - 1], dDb.ranked[FAMS.length]]);
    ok('a variant\'s reason / fit is its family\'s', dDb.ranked.slice(FAMS.length).every((r) => r.reason === cards.find((c) => famOfId(c.id) === famOfId(r.id)).reason));
    ok('familyFirst is idempotent: a family-first list is its own fixed point', JSON.stringify(fit.familyFirst(dDb.ranked)) === JSON.stringify(dDb.ranked));
    const oldOrder = dDb.ranked.slice().sort((a, b) => (b.score - a.score) || (RIDS.indexOf(a.id) - RIDS.indexOf(b.id)));
    ok('(the old score-sorted order DID stack the germany variants up front)', oldOrder.slice(0, 3).every((r) => famOfId(r.id) === 'germany'), oldOrder.slice(0, 3).map((r) => r.id));
    const frozen = JSON.stringify(oldOrder);
    ok('familyFirst is pure: the old-order input is not mutated, and its answer is the family-first list', fit.familyFirst(oldOrder).length === RIDS.length && JSON.stringify(oldOrder) === frozen && JSON.stringify(fit.familyFirst(oldOrder)) === JSON.stringify(dDb.ranked));
    const storedOld = fit.normaliseDesign({ ...dDb, ranked: oldOrder }, 'resume');
    ok('⚠️ normaliseDesign applies it on read: a document STORED in the old order comes back family-first, brandColor / aiFamilies / region kept',
      JSON.stringify(storedOld.ranked) === JSON.stringify(dDb.ranked) && storedOld.brandColor === '#ec0016' && storedOld.region === 'dach' && invariant(storedOld, RIDS, 'resume') === null, invariant(storedOld, RIDS, 'resume'));
    ok('…and rerankDesign produces the same shape', invariant(fit.rerankDesign({ ...dDb, ranked: oldOrder }, { kind: 'resume', region: 'dach', brandColor: '#ec0016', seniorityYears: 14 }), RIDS, 'resume') === null);
    const plain = fit.rankResumeDesigns({});
    ok('without a brand every card is the family\'s BASE design (catalogue order within the family)', plain.ranked.slice(0, FAMS.length).every((r) => r.id === famOfId(r.id)), plain.ranked.slice(0, FAMS.length).map((r) => r.id));
    const nx = fit.rankResumeDesigns({ region: 'dach', brandColor: '#0078d4', industry: 'IT services', companySize: '51-200 employees', seniorityYears: 14, employerType: 'sme' });
    ok('the Nexplore-like case (#0078d4, Swiss SME): 15 distinct families up front too', new Set(nx.ranked.slice(0, FAMS.length).map((r) => famOfId(r.id))).size === FAMS.length && invariant(nx, RIDS, 'resume') === null, invariant(nx, RIDS, 'resume'));
    ok('familyFirst never throws: not an array → [], a stray / retired id is a family of its own after the catalogue ones',
      JSON.stringify(fit.familyFirst(null)) === '[]' && JSON.stringify(fit.familyFirst([])) === '[]'
      && (() => { const r = fit.familyFirst([{ id: 'gone_design', score: 99 }, { id: 'mono', score: 50 }, null, { id: 'ats', score: 'x' }]); return r.length === 4 && r[0].id === 'gone_design' && r[1].id === 'mono' && r[2].id === 'ats' && r[3] === null; })());
    ok('ranked[0] is still the global best (headline / tone / the pre-rendered top card are unmoved)', dDb.ranked[0].score === Math.max(...dDb.ranked.map((r) => r.score)) && /German/.test(dDb.headline || '') === /German/.test(dDb.headline || ''));
    const lDb = fit.rankLetterDesigns(DB);
    ok('letters are untouched: seven distinct designs in plain score order, the German letter first for DACH', invariant(lDb, LIDS, 'cover_letter') === null && lDb.ranked[0].id === 'german' && lDb.ranked.every((r, i, a) => i === 0 || a[i - 1].score >= r.score));
  }

  console.log('── employerResearch: sanitised before it is cached or prompted ──');
  const er = require(path.join(ROOT, 'server/services/employerResearch.js'));
  ok('RESEARCH_REV is r1', er.RESEARCH_REV === 'r1');
  ok('domainKeyOf: lower-case host, no www, no port; null for a non-host',
    er.domainKeyOf('https://www.Amazon.jobs:443/en/x') === 'amazon.jobs' && er.domainKeyOf('localhost') === null && er.domainKeyOf('a@b.com') === null && er.domainKeyOf('') === null);
  const san = er.sanitiseResearch({
    employer_name: 'Amazon', industry: 'Retail', key_contacts: [{ name: 'Jane Private', email: 'jane@x.test' }],
    technologies: Array.from({ length: 30 }, (_, i) => ({ name: 'Tech' + i })),
    clients: Array.from({ length: 14 }, (_, i) => ({ name: 'Client' + i, contract_value: '$9M' })),
    recent_activity: Array.from({ length: 9 }, (_, i) => ({ description: i + ' ' + 'd'.repeat(300) })),
    mission: 'm'.repeat(900), brand_color: 'orange',
  }, 'amazon.jobs', 'Amazon');
  ok('key contacts are dropped entirely', !/Jane Private|jane@x\.test/.test(JSON.stringify(san)) && !('key_contacts' in san) && !('keyContacts' in san));
  ok('≤ 20 technologies, ≤ 10 clients (names only), ≤ 5 activities ≤ 200 chars',
    san.technologies.length === 20 && san.clients.length === 10 && !/contract_value|\$9M/.test(JSON.stringify(san.clients))
    && san.recentActivity.length === 5 && san.recentActivity.every((a) => a.length <= 200), [san.technologies.length, san.clients.length, san.recentActivity.length]);
  ok('every string ≤ 400 chars; an invalid brand colour is null', san.mission.length <= 400 && san.brandColor === null);
  ok('researchPromptBlock: empty for null', er.researchPromptBlock(null, 'Amazon') === '');
  const blk = er.researchPromptBlock(san, 'Amazon');
  ok('…headed as the contract says, and forbids inventing facts', blk.startsWith('=== WHAT WE KNOW ABOUT Amazon (web research — may be incomplete or wrong) ===') && /NEVER add a skill, tool/.test(blk), blk.slice(0, 200));
  ok('…a letter may cite public facts, a resume may not', blk !== er.researchPromptBlock(san, 'Amazon', { forLetter: true }) && /never state facts about the employer|Never state facts about/i.test(blk), blk);
  ok('getEmployerResearch never throws on garbage', (await er.getEmployerResearch({ website: 'not a host' }).catch(() => 'threw')) === null);
  // ⚠️ THE CACHE IS KEYED BY DOMAIN AND READ BY EVERY USER. One requester's typed company name stored as
  // employerName would be served to everybody else as the "Official name" for 30 days — a typo, a joke,
  // or somebody's private note in other people's AI prompts. The requester's name is a DISPLAY fallback,
  // laid over a per-request copy and never written back.
  {
    const erC = strip(R('server/services/employerResearch.js'));
    const body = fnBody(erC, 'getEmployerResearch') + fnBody(erC, 'researchNow') + fnBody(erC, 'readCache');
    ok('⚠️ nothing that writes the shared cache ever passes a fallback name to sanitiseResearch',
      /sanitiseResearch\(raw, domain\);/.test(erC) && !/sanitiseResearch\([^)]*,\s*domain\s*,\s*(name|fallbackName|displayName|company)/.test(body)
      && /writeCache\(domain, research\)/.test(erC));
    const named = er.sanitiseResearch({ industry: 'Retail' }, 'amazon.jobs', 'My Old Boss\'s Shop');
    ok('⚠️ …and the fallback only ever reaches a COPY, so the cached object keeps the empty name',
      named.employerName === 'My Old Boss\'s Shop'
      && er.sanitiseResearch({ industry: 'Retail' }, 'amazon.jobs').employerName === ''
      && /if \(research\.employerName \|\| !displayName\) return \{ \.\.\.research \};/.test(fnBody(erC, 'withDisplayName')), named.employerName);
  }
  ok('⚠️ the shared researcher is not modified by this round (the letter lane still uses it)', !/key_contacts[\s\S]{0,40}delete/.test(R('ai-employer-researcher.js')) && typeof require(path.join(ROOT, 'ai-employer-researcher.js')).researchEmployer === 'function');

  console.log('── ⚠️ ASK C (2026-09-14): hiring CONVENTIONS — sanitised before they are cached or prompted ──');
  {
    ok('⚠️ RESEARCH_REV stays r1 and FP_VERSION stays v1 — the conventions round must not turn every paid document stale',
      er.RESEARCH_REV === 'r1' && docs.FP_VERSION === 'v1');
    const c = er.sanitiseConventions({
      hq_country: 'Remote', role_country: 'Deutschland', employer_type: 'Government agency', sector: 'Contact Hans Muster for details',
      ats_vendor: 'in-house', tone: 'formal',
      cv: {
        photo: 'yes, expected', length: '1-2 pages', personal_details: 'not expected', date_format: 'MM/YYYY', format: 'Lebenslauf',
        notes: ['Email hr@acme.com to apply now please', 'short', 'A'.repeat(300) + ' tail', 'Contact Jane Doe for questions about roles',
          'CVs in Germany are usually tabular with dates first.', 'CVs in Germany are usually tabular with dates first.',
          'note three is long enough', 'note four is long enough', 'note five is long enough', 'note six is long enough'],
      },
      sources: ['http://insecure.example/x', 'https://ok.example/a#frag', 'https://user:pw@ok.example/', 'javascript:alert(1)',
        'https://vertexaisearch.cloud.google.com/redirect/x', 'https://a.example', 'https://b.example', 'https://c.example', 'https://d.example'],
    });
    const TYPES = ['public_sector', 'enterprise', 'sme', 'startup', 'agency', 'ngo', 'academia', 'other', null];
    ok('the contract shape, every enum from its closed list', c && TYPES.includes(c.employerType)
      && ['expected', 'optional', 'avoid', null].includes(c.cv.photo) && ['one_page', 'two_pages', 'flexible', null].includes(c.cv.length)
      && ['include', 'avoid', null].includes(c.cv.personalDetails) && ['tabular', 'narrative', 'europass', 'ats_plain', null].includes(c.cv.format)
      && JSON.stringify(Object.keys(c).sort()) === JSON.stringify(['atsVendor', 'cv', 'employerType', 'hqCountry', 'roleCountry', 'sector', 'sources', 'tone'])
      && JSON.stringify(Object.keys(c.cv).sort()) === JSON.stringify(['dateFormat', 'format', 'length', 'notes', 'personalDetails', 'photo']), c);
    ok('synonyms map to the enum ("Government agency" → public_sector, "not expected" → avoid, "Lebenslauf" → tabular)',
      c.employerType === 'public_sector' && c.cv.photo === 'expected' && c.cv.personalDetails === 'avoid' && c.cv.format === 'tabular' && c.cv.dateFormat === 'MM/YYYY', c);
    ok('⚠️ …and a PR agency is still an agency, a recruiter is an agency', er.sanitiseConventions({ employer_type: 'Public relations agency' }).employerType === 'agency'
      && er.sanitiseConventions({ employer_type: 'Recruitment agency' }).employerType === 'agency');
    ok('countries only when real ("Remote" → null, "Deutschland" → Germany)', c.hqCountry === null && c.roleCountry === 'Germany', [c.hqCountry, c.roleCountry]);
    ok('⚠️ person- and contact-shaped text never survives (sector naming a person, an "in-house" ATS)', c.sector === null && c.atsVendor === null, [c.sector, c.atsVendor]);
    ok('⚠️ notes: ≤ 5, each ≤ 160 chars, no email / named person / too-short / duplicate',
      c.cv.notes.length === 5 && c.cv.notes.every((n) => n.length <= 160 && n.length >= 12) && !c.cv.notes.some((n) => /@|Jane Doe/.test(n))
      && new Set(c.cv.notes.map((n) => n.toLowerCase())).size === c.cv.notes.length, c.cv.notes);
    ok('⚠️ sources: ≤ 5, https only, no credentials, no fragment, no Google redirect',
      c.sources.length === 5 && c.sources.every((u) => /^https:\/\//.test(u) && !/@|#|vertexaisearch|javascript/.test(u)) && c.sources[0] === 'https://ok.example/a', c.sources);
    const g = er.sanitiseConventions({ employer_type: 'startup', sources: ['https://evil.example/x', 'https://grounded.example/p'] },
      { groundedHosts: new Set(['grounded.example', 'other-grounded.example']), domain: 'acme.com' });
    ok('⚠️ with grounding: only hosts the search really returned, plus the grounded ones it did not list',
      JSON.stringify(g.sources) === JSON.stringify(['https://grounded.example/p', 'https://other-grounded.example/']), g.sources);
    ok('sources alone are not knowledge → null; garbage → null', er.sanitiseConventions({ sources: ['https://a.example'] }) === null
      && er.sanitiseConventions(null) === null && er.sanitiseConventions([1, 2]) === null && er.sanitiseConventions('x') === null);
    ok('a cached research row keeps its conventions through sanitiseResearch', (er.sanitiseResearch({ industry: 'Retail', conventions: { employer_type: 'sme' } }, 'x.com') || {}).conventions?.employerType === 'sme');

    console.log('── conventionsPromptBlock: facts + "never invent", resume vs letter ──');
    const full = { hqCountry: 'Switzerland', employerType: 'sme', sector: 'Precision engineering', atsVendor: 'Workday', tone: 'formal',
      cv: { photo: 'expected', length: 'two_pages', personalDetails: 'include', dateFormat: 'MM.YYYY', format: 'tabular', notes: ['Swiss CVs list dates first for every role.', 'Write to hr@acme.ch for a call'] } };
    const rb = er.conventionsPromptBlock(full, 'Acme AG');
    const lb = er.conventionsPromptBlock(full, 'Acme AG', { forLetter: true });
    ok("'' for null, and '' for countries alone (nothing to act on)", er.conventionsPromptBlock(null, 'Acme') === ''
      && er.conventionsPromptBlock({ hqCountry: 'Germany', roleCountry: 'Germany' }, 'Acme') === '');
    ok('⚠️ resume block: headed as research, CV conventions stated, and conventions never invent a candidate fact',
      rb.startsWith('=== HOW Acme AG HIRES (web research — may be incomplete or wrong) ===') && /CV conventions: /.test(rb)
      && /never change what is true about the candidate/.test(rb) && /NEVER invent anything to satisfy a convention/.test(rb)
      && /Never mention Acme AG, these conventions or this research anywhere in the resume/.test(rb) && rb.endsWith('=== END OF HIRING CONVENTIONS ==='), rb);
    ok('⚠️ letter block: no CV habits (photo, length, personal details belong to the resume), still never invents',
      /=== HOW Acme AG HIRES/.test(lb) && !/CV conventions: /.test(lb) && /never mention them in the letter/.test(lb) && /Never state or imply a fact/.test(lb), lb);
    ok('⚠️ a contact-shaped note is never prompted', !/hr@acme\.ch/.test(rb + lb) && /Swiss CVs list dates first/.test(rb));

    console.log('── regionForConventions / regionFromCountry: every country, one chain ──');
    ok('the chain: the caller\'s country → research roleCountry → website ccTLD → research hqCountry → region word → generic',
      er.regionForConventions({ hqCountry: 'Germany', roleCountry: 'Austria' }, { country: 'India', website: 'https://x.co.uk' }) === 'india'
      && er.regionForConventions({ hqCountry: 'Germany', roleCountry: 'Austria' }, { website: 'https://x.co.uk' }) === 'dach'
      && er.regionForConventions({ hqCountry: 'Germany' }, { website: 'https://x.co.uk' }) === 'uk_au'
      && er.regionForConventions({ hqCountry: 'Germany' }, { website: 'https://x.com' }) === 'dach'
      && er.regionForConventions(null, { country: 'Europe' }) === 'eu'
      && er.regionForConventions(null, {}) === 'generic' && er.regionForConventions('garbage', { country: 42 }) === 'generic');
    const RC = require(path.join(ROOT, 'server/utils/regionFromCountry.js'));
    const want = {
      Morocco: 'eu', Tunisia: 'eu', Algeria: 'eu', 'United Arab Emirates': 'eu', 'Saudi Arabia': 'eu', Qatar: 'eu',
      Nigeria: 'uk_au', Ghana: 'uk_au', Kenya: 'uk_au', 'South Africa': 'uk_au', Brazil: 'eu', Mexico: 'eu', Argentina: 'eu',
      Switzerland: 'dach', Austria: 'dach', Germany: 'dach', India: 'india', Singapore: 'sg', Japan: 'sg', Canada: 'us_ca',
      'United States': 'us_ca', Australia: 'uk_au', 'Casablanca, Morocco': 'eu', Remote: 'generic',
    };
    const wrong = Object.entries(want).filter(([k, v]) => fit.regionFor({ country: k }) !== v || RC.regionFromCountry(k) !== v);
    ok('the contract\'s mappings (Maghreb → eu, Gulf → eu, West/East/South Africa → uk_au, LatAm → eu, …)', wrong.length === 0, wrong.map(([k, v]) => [k, v, fit.regionFor({ country: k })]));
    const gulf = RC.cvDefaultsFor(RC.placeFor({ country: 'Qatar' }));
    ok('…and the Gulf is a photo + personal-details profile inside eu', gulf && gulf.photo === 'expected' && gulf.personalDetails === 'include', gulf);
    ok('⚠️ THE PROD BUG: a .ma host and a .com.gh host are no longer "generic"',
      fit.regionFor({ website: 'https://anapec.ma' }) === 'eu' && fit.regionFor({ website: 'https://jobberman.com.gh' }) === 'uk_au');
    ok('regionFromTld falls back through conventions.hqCountry (a German enterprise on .com); a vanity .io is no country',
      RC.regionFromTld('https://siemens-energy.com', { hqCountry: 'Germany' }) === 'dach' && fit.regionFor({ website: 'https://acme.io' }) === 'generic'
      && RC.regionFromTld('https://siemens-energy.com') === 'generic');

    console.log('── ⚠️ the ranking now differs BY EMPLOYER (the prod bug: every employer got exec_pro first) ──');
    const T = require(path.join(ROOT, 'server/utils/resumeTemplates.js'));
    const famOf = (id) => (T.TEMPLATES.find((t) => t.id === id) || {}).family;
    const conv = (o) => ({ roleCountry: o.hqCountry, sources: [], tone: null, sector: null, atsVendor: null, ...o, cv: { dateFormat: null, notes: [], ...o.cv } });
    const S = {
      swissSme: { website: 'https://acme-ag.ch', industry: 'Precision engineering', companySize: '51-200 employees',
        conventions: conv({ hqCountry: 'Switzerland', employerType: 'sme', sector: 'Precision engineering', tone: 'formal', cv: { photo: 'expected', length: 'two_pages', personalDetails: 'include', format: 'tabular' } }) },
      moroccanAgency: { website: 'https://anapec.ma', industry: 'Government agency',
        conventions: conv({ hqCountry: 'Morocco', employerType: 'public_sector', sector: 'Public employment services', tone: 'formal', cv: { photo: 'optional', length: 'one_page', personalDetails: 'include', format: 'narrative' } }) },
      ghanaianSite: { website: 'https://jobberman.com.gh', industry: 'Recruitment job site',
        conventions: conv({ hqCountry: 'Ghana', employerType: 'agency', sector: 'Online job board / recruitment', cv: { photo: 'avoid', length: 'two_pages', personalDetails: null, format: 'narrative' } }) },
      usStartup: { website: 'https://acme.io', industry: 'Software', companySize: '11-50 employees',
        conventions: conv({ hqCountry: 'United States', employerType: 'startup', sector: 'SaaS', atsVendor: 'Ashby', tone: 'casual', cv: { photo: 'avoid', length: 'one_page', personalDetails: 'avoid', format: 'ats_plain' } }) },
      germanEnterpriseDotCom: { website: 'https://siemens-energy.com', industry: 'Energy', companySize: '10,001+ employees',
        conventions: conv({ hqCountry: 'Germany', employerType: 'enterprise', sector: 'Energy technology', atsVendor: 'SAP SuccessFactors', tone: 'formal', cv: { photo: 'optional', length: 'two_pages', personalDetails: 'include', format: 'tabular' } }) },
      londonStudio: { website: 'https://pentagram.co.uk', industry: 'Graphic design studio', companySize: '51-200 employees',
        conventions: conv({ hqCountry: 'United Kingdom', employerType: 'agency', sector: 'Design studio', tone: 'creative', cv: { photo: 'avoid', length: 'two_pages', personalDetails: 'avoid', format: 'narrative' } }) },
    };
    const EXEC_BIAS = { exec_pro: { score: 80, reason: 'Senior look' }, executive: { score: 72 }, mono: { score: 60 } };
    const rank = (s, o = {}) => fit.rankResumeDesigns({ website: s.website, conventions: s.conventions, employerType: s.conventions.employerType,
      industry: s.industry, companySize: s.companySize || null, seniorityYears: 2, ...o });
    const top = {};
    for (const [k, s] of Object.entries(S)) {
      const d = rank(s);
      top[k] = { region: d.region, fam: famOf(d.ranked[0].id), senior: famOf(rank(s, { seniorityYears: 20 }).ranked[0].id), biased: famOf(rank(s, { seniorityYears: 20, aiFamilyScores: EXEC_BIAS }).ranked[0].id), d };
      ok(`${k}: every id once, family-first, each run sorted (invariants)`, invariant(d, RIDS, 'resume') === null, invariant(d, RIDS, 'resume'));
    }
    const view = Object.fromEntries(Object.entries(top).map(([k, v]) => [k, [v.region, v.fam, v.senior, v.biased]]));
    ok('regions: Swiss dach, Moroccan eu, Ghanaian uk_au, US us_ca, German-on-.com dach (hqCountry), London uk_au',
      top.swissSme.region === 'dach' && top.moroccanAgency.region === 'eu' && top.ghanaianSite.region === 'uk_au' && top.usStartup.region === 'us_ca'
      && top.germanEnterpriseDotCom.region === 'dach' && top.londonStudio.region === 'uk_au', view);
    ok('a Swiss SME and a German enterprise on .com lead with the tabular German CV', top.swissSme.fam === 'germany' && top.germanEnterpriseDotCom.fam === 'germany', view);
    ok('a US startup leads with a startup / engineering single column, never exec_pro', ['startup', 'mono'].includes(top.usStartup.fam), view);
    ok('a London design studio leads with a visual layout', ['banner', 'rightrail', 'timeline'].includes(top.londonStudio.fam), view);
    ok('a Moroccan public agency leads with a formal, plain family; a Ghanaian job site with an ATS-first single column',
      ['ats', 'exec_pro', 'elegant'].includes(top.moroccanAgency.fam) && ['ats', 'exec_pro'].includes(top.ghanaianSite.fam), view);
    const distinct = new Set(Object.values(top).map((v) => v.fam));
    ok('⚠️ six employers no longer share one top family (≥ 4 different leaders)', distinct.size >= 4, [...distinct]);
    ok('⚠️ seniority is a minor factor: 2 vs 20 years never changes the leader for the Swiss, German, London or US employer',
      ['swissSme', 'germanEnterpriseDotCom', 'londonStudio', 'usStartup'].every((k) => top[k].fam === top[k].senior), view);
    ok('⚠️ an exec_pro-biased model + a 20-year career still does not move the Swiss, London or US leader',
      ['swissSme', 'londonStudio'].every((k) => top[k].biased === top[k].fam) && top.usStartup.biased !== 'exec_pro' && new Set(Object.values(top).map((v) => v.biased)).size >= 4, view);
    ok('the design says why, in the employer\'s terms: conventionsSummary (≤ 120) names the country, the reason names it too',
      top.swissSme.d.conventionsSummary && top.swissSme.d.conventionsSummary.length <= 120 && /Switzerland/.test(top.swissSme.d.conventionsSummary)
      && /Switzerland/.test(top.swissSme.d.ranked[0].reason), [top.swissSme.d.conventionsSummary, top.swissSme.d.ranked[0].reason]);
    const L = (s) => fit.rankLetterDesigns({ website: s.website, conventions: s.conventions, employerType: s.conventions.employerType, industry: s.industry });
    ok('letters too: the German-speaking employers lead with the German letter, the others never do',
      L(S.swissSme).ranked[0].id === 'german' && L(S.germanEnterpriseDotCom).ranked[0].id === 'german'
      && ['usStartup', 'londonStudio', 'ghanaianSite', 'moroccanAgency'].every((k) => L(S[k]).ranked[0].id !== 'german')
      && invariant(L(S.moroccanAgency), LIDS, 'cover_letter') === null);

    console.log('── rerankDesign: a stored design re-ranked for FREE (no AI), and normaliseDesign keeps what that needs ──');
    const prodLike = fit.rankResumeDesigns({ aiFamilyScores: EXEC_BIAS, region: 'generic', seniorityYears: 20, mode: 'a4' });
    ok('(the prod-like stored design leads with an exec family)', ['exec_pro', 'executive'].includes(famOf(prodLike.ranked[0].id)), prodLike.ranked.slice(0, 3));
    const stored = JSON.parse(JSON.stringify(prodLike));
    const rr = fit.rerankDesign(stored, { conventions: S.swissSme.conventions, website: S.swissSme.website, seniorityYears: 20, kind: 'resume',
      companySize: S.swissSme.companySize, industry: S.swissSme.industry, employerType: 'sme' });
    ok('⚠️ with Swiss conventions the stored exec design re-ranks to the German CV, region dach, invariants intact',
      famOf(rr.ranked[0].id) === 'germany' && rr.region === 'dach' && invariant(rr, RIDS, 'resume') === null, rr.ranked.slice(0, 3));
    ok('…the stored aiFamilies stand in for the model (kept), the input is never mutated, and it is deterministic',
      rr.aiFamilies && rr.aiFamilies.exec_pro && JSON.stringify(stored) === JSON.stringify(prodLike)
      && JSON.stringify(fit.rerankDesign(stored, { conventions: S.swissSme.conventions, website: S.swissSme.website, seniorityYears: 20, kind: 'resume', companySize: S.swissSme.companySize, industry: S.swissSme.industry, employerType: 'sme' })) === JSON.stringify(rr));
    ok('…a headline about a design that no longer leads is not kept', rr.headline !== prodLike.headline || famOf(rr.ranked[0].id) === famOf(prodLike.ranked[0].id), [rr.headline, prodLike.headline]);
    const lStored = fit.rankLetterDesigns({ region: 'generic', seniorityYears: 20 });
    const lr = fit.rerankDesign(lStored, { kind: 'cover_letter', conventions: S.germanEnterpriseDotCom.conventions, website: S.germanEnterpriseDotCom.website });
    ok('a stored letter design re-ranks to the German letter for the German enterprise', lr.ranked[0].id === 'german' && invariant(lr, LIDS, 'cover_letter') === null, lr.ranked.slice(0, 3));
    const nd = fit.normaliseDesign({ ...prodLike, aiFamilies: { exec_pro: { score: 140, reason: 'x' }, not_a_family: { score: 50 } }, conventionsSummary: 'y'.repeat(300) }, 'resume');
    ok('normaliseDesign keeps aiFamilies (clamped, catalogue families only) and conventionsSummary (≤ 120)',
      nd.aiFamilies && nd.aiFamilies.exec_pro && nd.aiFamilies.exec_pro.score <= 100 && !('not_a_family' in nd.aiFamilies)
      && typeof nd.conventionsSummary === 'string' && nd.conventionsSummary.length <= 120, { ai: nd.aiFamilies, len: nd.conventionsSummary && nd.conventionsSummary.length });

    console.log('── ⚠️ getEmployerResearch: the conventions call in flight — base on time, conventions later, ONE call per domain ──');
    {
      const researcher = require(path.join(ROOT, 'ai-employer-researcher.js'));
      const realRE = researcher.researchEmployer;
      const realRC = er.researchConventions;
      const realRB = er.researchBrand, realGF = er.googleFontCheck;
      // ⚠️ NO NETWORK: the website read (employerResearch.researchBrand → brandExtract) and the Google Fonts check are stubbed —
      // unstubbed, every fake domain here cost a real NXDOMAIN lookup (~1 s), and a resolver that hijacks NXDOMAIN could feed a page.
      er.researchBrand = async () => null; er.googleFontCheck = async () => false;
      reset();
      // ⚠️ KEEP THE PROCESS ALIVE: employerResearch unref()s every timer it sets (a server must not be held open by a
      // research wait), so with the conventions call parked on a promise nothing else would keep node running — the
      // script would exit 0 in the middle of this block, silently skipping everything after it.
      const keepAlive = setInterval(() => {}, 1000);
      let rcCalls = 0, reCalls = 0, releaseConv = null;
      researcher.researchEmployer = async () => { reCalls++; return { employer_name: 'Flight Co', industry: 'Logistics' }; };
      er.researchConventions = () => { rcCalls++; return new Promise((r) => { releaseConv = () => r({ answered: true, conventions: er.sanitiseConventions({ employer_type: 'sme', hq_country: 'Austria' }) }); }); };
      try {
        const r1 = await er.getEmployerResearch({ website: 'https://flight-co-test.com', name: 'My Typed Name' }, { timeoutMs: 60 });
        ok('⚠️ a caller whose timeout fires first still gets the base research (conventions null), not null',
          r1 && r1.industry === 'Logistics' && r1.conventions === null, r1);
        const r2 = await er.getEmployerResearch({ website: 'https://www.flight-co-test.com/jobs' }, { timeoutMs: 30 });
        ok('⚠️ a concurrent caller joins the same flight: ONE researcher call, ONE conventions call', r2 && r2.industry === 'Logistics' && reCalls === 1 && rcCalls === 1, { reCalls, rcCalls });
        releaseConv();
        await new Promise((r) => setTimeout(r, 30));
        const writes = db.log.filter((e) => /^INSERT INTO employer_research_cache/.test(e.sql));
        const patchW = writes.find((e) => /DO UPDATE SET research = employer_research_cache\.research \|\| EXCLUDED\.research$/.test(e.sql));
        ok('⚠️ the late conventions answer persists itself, MERGED into the row (||), without touching fetched_at',
          !!patchW && JSON.parse(patchW.params[1]).conventions && JSON.parse(patchW.params[1]).conventions.employerType === 'sme', writes.map((w) => w.sql.slice(-80)));
        ok('…the base write merges too (|| and a fresh fetched_at) and carries the answered conventions',
          writes.some((e) => /research = employer_research_cache\.research \|\| EXCLUDED\.research, fetched_at = NOW\(\)$/.test(e.sql)), writes.map((w) => w.sql.slice(-80)));
        ok('⚠️ the requester\'s typed name never reaches the shared cache', writes.length >= 2 && !writes.some((e) => /My Typed Name/.test(String(e.params[1]))));
        ok('…and no second conventions call was made for it', rcCalls === 1);

        reset(); rcCalls = 0; reCalls = 0;
        db.answer = (q) => (/FROM employer_research_cache/.test(q) ? { research: { domain: 'old-row-test.com', employerName: 'Old Row', industry: 'Retail' }, fetched_at: new Date() } : null);
        er.researchConventions = async () => { rcCalls++; return { answered: true, conventions: er.sanitiseConventions({ employer_type: 'enterprise' }) }; };
        const r3 = await er.getEmployerResearch({ website: 'https://old-row-test.com' }, { timeoutMs: 2000 });
        ok('⚠️ an old cache row without conventions gets them on read: no researcher call, ONE conventions call',
          r3 && r3.industry === 'Retail' && r3.conventions && r3.conventions.employerType === 'enterprise' && reCalls === 0 && rcCalls === 1, { r3, reCalls, rcCalls });
        const w3 = db.log.filter((e) => /^INSERT INTO employer_research_cache/.test(e.sql));
        ok('…merged into that row with its fetched_at unchanged (no base write)', w3.length === 1 && !/fetched_at = NOW\(\)$/.test(w3[0].sql), w3.map((w) => w.sql.slice(-80)));
        ok('getEmployerResearch accepts a country and never lets it into the flight', /void country;/.test(strip(R('server/services/employerResearch.js'))));
      } finally {
        clearInterval(keepAlive);
        researcher.researchEmployer = realRE;
        er.researchConventions = realRC;
        er.researchBrand = realRB; er.googleFontCheck = realGF;
        reset();
      }
    }

    console.log('── ⚠️ conventions (2026-09-15): an EMPTY answer is remembered, the grounded call has room to answer, unverifiable sources are none ──');
    {
      const researcher = require(path.join(ROOT, 'ai-employer-researcher.js'));
      const realRE = researcher.researchEmployer;
      const realRC = er.researchConventions;
      const realRB = er.researchBrand, realGF = er.googleFontCheck;
      // ⚠️ NO NETWORK: the website read (employerResearch.researchBrand → brandExtract) and the Google Fonts check are stubbed —
      // unstubbed, every fake domain here cost a real NXDOMAIN lookup (~1 s), and a resolver that hijacks NXDOMAIN could feed a page.
      er.researchBrand = async () => null; er.googleFontCheck = async () => false;
      const keepAlive = setInterval(() => {}, 1000);   // see above: every timer in employerResearch is unref()'d
      let rcCalls = 0, reCalls = 0;
      researcher.researchEmployer = async () => { reCalls++; return { employer_name: 'Empty Co', industry: 'Logistics' }; };
      try {
        // ⚠️ A ROW THAT IS ONLY "CHECKED, NOTHING FOUND" IS STILL A ROW. It sanitises to null (no fact at all), and readCache
        // used to answer null for it = "never checked" — so the grounded (PAID) conventions call repeated on EVERY build
        // for that domain, for the whole TTL.
        reset();
        db.answer = (q) => (/FROM employer_research_cache/.test(q) ? { research: { conventions: null, conventionsAt: new Date().toISOString() }, fetched_at: new Date() } : null);
        const rc = await er._internals.readCache('empty-conv-test.com');
        ok('⚠️ readCache: a checked-but-empty row reads as { research:null, hasBase:false, conventionsChecked:true }, not null',
          JSON.stringify(rc) === JSON.stringify({ research: null, hasBase: false, conventionsChecked: true }), rc);
        er.researchConventions = async () => { rcCalls++; return { answered: true, conventions: null }; };
        const r1 = await er.getEmployerResearch({ website: 'https://empty-conv-test.com' }, { timeoutMs: 2000 });
        ok('⚠️ …so a build for that domain researches the BASE (one researcher call) and makes NO grounded conventions call',
          reCalls === 1 && rcCalls === 0 && r1 && r1.industry === 'Logistics' && r1.conventions === null, { reCalls, rcCalls, r1 });
        // A stale check (past the TTL) is no check at all: the conventions are asked again.
        reset(); rcCalls = 0; reCalls = 0;
        const stale = new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString();
        db.answer = (q) => (/FROM employer_research_cache/.test(q) ? { research: { conventions: null, conventionsAt: stale }, fetched_at: new Date() } : null);
        ok('a stale "checked" stamp is no row at all', (await er._internals.readCache('stale-conv-test.com')) === null);
        await er.getEmployerResearch({ website: 'https://stale-conv-test.com' }, { timeoutMs: 2000 });
        ok('…and that domain asks for its conventions again (one call)', rcCalls === 1, rcCalls);
        // ⚠️ IN MEMORY TOO: with no row to read back (no DB, a failed write) an empty answer must still stop the repeat.
        reset(); rcCalls = 0; reCalls = 0;
        db.answer = () => null;
        await er.getEmployerResearch({ website: 'https://nodb-conv-test.com' }, { timeoutMs: 2000 });
        await er.getEmployerResearch({ website: 'https://nodb-conv-test.com' }, { timeoutMs: 2000 });
        ok('⚠️ two builds, no cache row, an EMPTY answer: ONE grounded call, not two (the empty answer is remembered in memory)', rcCalls === 1, rcCalls);
        ok('⚠️ …by the failure memory on the conventions key (a source rule, so a refactor cannot drop it silently)',
          /if \(!answer\.conventions\) rememberFailure\(conventionsKey\(domain\)\);/.test(strip(R('server/services/employerResearch.js'))));

        // The REAL researchConventions against a fake SDK: the request it makes, and what it keeps from the answer.
        const genaiPath = require.resolve('@google/generative-ai', { paths: [ROOT] });
        const hadGenai = require.cache[genaiPath];
        const seen = [];
        let reply = null;
        require.cache[genaiPath] = { id: genaiPath, filename: genaiPath, loaded: true, exports: {
          GoogleGenerativeAI: class { getGenerativeModel(cfg) { const e = { cfg }; seen.push(e); return { generateContent: async (req, opts) => { e.req = req; e.opts = opts; return reply; } }; } },
        } };
        try {
          const CONV = JSON.stringify({ employer_type: 'sme', hq_country: 'Austria', sources: ['https://acme-src-test.com/careers', 'https://elsewhere.test/cv-tips'] });
          reply = { response: { text: () => CONV, candidates: [{ groundingMetadata: {} }] } };
          let a = await realRC('acme-src-test.com', 'Acme');
          const cfg = (seen[0] && seen[0].cfg && seen[0].cfg.generationConfig) || {};
          // ⚠️ gemini-2.5-flash THINKS out of the same budget: at 4096 the thoughts ate it all and the JSON arrived cut off —
          // a paid call that taught us nothing. The ceiling is doubled and the thinking is capped BELOW it.
          ok('⚠️ the grounded call has room to answer: maxOutputTokens ≥ 8192, thinkingBudget a positive integer below it',
            cfg.maxOutputTokens >= 8192 && cfg.thinkingConfig && Number.isInteger(cfg.thinkingConfig.thinkingBudget) && cfg.thinkingConfig.thinkingBudget > 0 && cfg.thinkingConfig.thinkingBudget < cfg.maxOutputTokens, cfg);
          // ⚠️ RETARGETED 2026-09-18: the hard stop used to be the SDK's own { timeout } (whose timer the SDK never
          // clears). The call now goes through aiText, whose per-attempt cap aborts the request through { signal }.
          ok('…it is a Google Search grounded call with a real abort (aiText\'s per-attempt signal)',
            seen[0] && JSON.stringify(seen[0].req.tools) === JSON.stringify([{ googleSearch: {} }]) && seen[0].opts && seen[0].opts.signal && typeof seen[0].opts.signal.aborted === 'boolean',
            seen[0] && { tools: seen[0].req && seen[0].req.tools, opts: seen[0].opts && Object.keys(seen[0].opts) });
          ok('⚠️ grounding metadata with NO chunks → answered, and sources: [] (nothing verifiable is stored as a source)',
            a.answered === true && a.conventions && Array.isArray(a.conventions.sources) && a.conventions.sources.length === 0 && a.conventions.employerType === 'sme', a);
          reply = { response: { text: () => CONV, candidates: 'not-an-array' } };
          a = await realRC('acme-src-test.com', 'Acme');
          ok('…a changed metadata shape is the same: sources [] and never a throw', a.answered === true && a.conventions && a.conventions.sources.length === 0, a);
          reply = { response: { text: () => CONV, candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/x', title: 'acme-src-test.com' } }] } }] } };
          a = await realRC('acme-src-test.com', 'Acme');
          ok('…while a grounded host keeps the source on that host, and drops the one the search never touched',
            a.answered === true && JSON.stringify(a.conventions.sources) === JSON.stringify(['https://acme-src-test.com/careers']), a.conventions && a.conventions.sources);
          reply = { response: { text: () => 'I could not find anything.', candidates: [] } };
          a = await realRC('acme-src-test.com', 'Acme');
          ok('prose is not an answer (never cached as checked)', a.answered === false && /no JSON/.test(a.why), a);
        } finally {
          if (hadGenai) require.cache[genaiPath] = hadGenai; else delete require.cache[genaiPath];
        }
      } finally {
        clearInterval(keepAlive);
        researcher.researchEmployer = realRE;
        er.researchConventions = realRC;
        er.researchBrand = realRB; er.googleFontCheck = realGF;
        reset();
      }
    }
  }

  console.log('── ⚠️ the BRAND (2026-09-15): the flight\'s THIRD stage — never gates a build, cached as research.brand + brandAt on a 30-day clock ──');
  {
    // Contract 1/2: the employer's website colour + font (brandExtract) ride beside the researcher and the conventions,
    // bounded on their own clock; the full flight never waits for them; the caller's copy gets whatever settled in its
    // time; ONLY a found brand is written (its own labelled patch, merged with ||, fetched_at untouched); a null is
    // remembered in memory for an hour; the researcher's fontName is folded in as brand.font when the website named no
    // font. brandOf(research) is what every renderer paints with. No network, no AI: every call is stubbed and counted.
    const researcher = require(path.join(ROOT, 'ai-employer-researcher.js'));
    const realRE = researcher.researchEmployer, realRB = er.researchBrand, realRC = er.researchConventions, realGF = er.googleFontCheck;
    const keepAlive = setInterval(() => {}, 1000);   // every timer in employerResearch is unref()'d — see the flight block above
    const brandWrites = () => db.log.filter((e) => /\/\* brand \*\/$/.test(e.sql));
    const BRAND = { primary: '#e30613', secondary: '#00857c', font: { family: 'Space Grotesk', google: true }, from: { primary: 'theme-color', font: 'body' }, fetchedAt: new Date().toISOString() };
    let reCalls = 0, rbCalls = 0, gfCalls = 0, brandDelay = 50, brandAnswer = BRAND;
    researcher.researchEmployer = async () => { reCalls++; return { employer_name: 'Brand Co', industry: 'Logistics', font_name: 'Inter' }; };
    er.researchConventions = async () => ({ answered: true, conventions: er.sanitiseConventions({ employer_type: 'sme' }) });
    er.researchBrand = () => { rbCalls++; return new Promise((r) => setTimeout(() => r(brandAnswer), brandDelay)); };
    er.googleFontCheck = async (f) => { gfCalls++; return f === 'Inter'; };
    const again = () => { er._reset(); reset(); reCalls = 0; rbCalls = 0; gfCalls = 0; };
    try {
      // 1. the first build for a new employer
      again();
      const r1 = await er.getEmployerResearch({ website: 'https://brand-co-test.com', name: 'Typed' }, { timeoutMs: 2000 });
      ok('the brand is in the caller\'s copy (website primary + font) beside the conventions; brandAt is stripped',
        r1 && r1.brand && r1.brand.primary === '#e30613' && r1.brand.font.family === 'Space Grotesk' && r1.conventions && r1.conventions.employerType === 'sme' && !('brandAt' in r1), r1);
      ok('brandOf → the website accent and the website font', JSON.stringify(er.brandOf(r1)) === JSON.stringify({ accent: '#e30613', font: { family: 'Space Grotesk', google: true } }), er.brandOf(r1));
      ok('the researcher\'s fontName stays beside it (Inter) and no Google check was needed', r1.fontName === 'Inter' && gfCalls === 0, { fontName: r1.fontName, gfCalls });
      ok('ONE researcher call, ONE website read', reCalls === 1 && rbCalls === 1, { reCalls, rbCalls });
      const writes = db.log.filter((e) => /^INSERT INTO employer_research_cache/.test(e.sql));
      const brandW = brandWrites()[0];
      ok('⚠️ the brand patch is its own labelled statement (merge ||, no fetched_at) carrying brand + brandAt',
        !!brandW && !/fetched_at = NOW\(\)/.test(brandW.sql.slice(-80)) && JSON.parse(brandW.params[1]).brand.primary === '#e30613' && !!JSON.parse(brandW.params[1]).brandAt, writes.map((w) => w.sql.slice(-70)));
      const convW = writes.find((e) => /DO UPDATE SET research = employer_research_cache\.research \|\| EXCLUDED\.research$/.test(e.sql));
      ok('the conventions patch still matches its pinned tail exactly (the label keeps the two apart)', !!convW && !!JSON.parse(convW.params[1]).conventions, writes.map((w) => w.sql.slice(-70)));
      const baseW = writes.find((e) => /fetched_at = NOW\(\)$/.test(e.sql));
      ok('⚠️ the base write carries no brand key at all (a brand: null must never blank the patched one)', !!baseW && !('brand' in JSON.parse(baseW.params[1])) && !('brandAt' in JSON.parse(baseW.params[1])), baseW && baseW.params[1]);
      ok('the requester\'s typed name never reaches a write', !writes.some((e) => /Typed/.test(String(e.params[1]))));
      ok('publicResearch handed out a COPY of the brand, not the flight\'s object', r1.brand !== BRAND && JSON.stringify(r1.brand) === JSON.stringify(er.sanitiseBrand(BRAND)));

      // 2. a cached row that already carries a fresh brand
      again();
      const row = { domain: 'cached-brand-test.com', employerName: 'Cached', industry: 'Retail', fontName: 'Inter', brand: BRAND, brandAt: new Date().toISOString(), conventions: { employerType: 'sme' }, conventionsAt: new Date().toISOString() };
      db.answer = (q) => (/FROM employer_research_cache/.test(q) ? { research: row, fetched_at: new Date() } : null);
      const r2 = await er.getEmployerResearch({ website: 'https://cached-brand-test.com' }, { timeoutMs: 2000 });
      ok('served as-is: brand in, NO website read, NO researcher, NO write', r2 && r2.brand && r2.brand.primary === '#e30613' && rbCalls === 0 && reCalls === 0 && db.log.filter((e) => /^INSERT/.test(e.sql)).length === 0, { rbCalls, reCalls, r2 });

      // 3. a brand past its own 30-day clock
      again();
      const stale = new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString();
      db.answer = (q) => (/FROM employer_research_cache/.test(q) ? { research: { ...row, domain: 'stale-brand-test.com', brandAt: stale }, fetched_at: new Date() } : null);
      const r3 = await er.getEmployerResearch({ website: 'https://stale-brand-test.com' }, { timeoutMs: 2000 });
      ok('read again (one website read, re-patched) while the base facts stay cached (no researcher)', r3 && r3.brand && r3.brand.primary === '#e30613' && rbCalls === 1 && reCalls === 0 && brandWrites().length === 1, { rbCalls, reCalls, writes: brandWrites().length });

      // 4. the website gives nothing
      again();
      brandAnswer = null;
      const r4 = await er.getEmployerResearch({ website: 'https://no-brand-test.com' }, { timeoutMs: 2000 });
      ok('NO brand write; the researcher\'s Inter becomes brand.font through the Google check (from.font "researcher")',
        brandWrites().length === 0 && r4 && r4.brand && r4.brand.primary === null && r4.brand.font.family === 'Inter' && r4.brand.font.google === true && r4.brand.from.font === 'researcher' && gfCalls === 1, { writes: brandWrites().length, brand: r4 && r4.brand, gfCalls });
      ok('brandOf → no accent (the researcher gave no colour), Inter as a Google font', JSON.stringify(er.brandOf(r4)) === JSON.stringify({ accent: null, font: { family: 'Inter', google: true } }), er.brandOf(r4));
      const r4b = await er.getEmployerResearch({ website: 'https://no-brand-test.com' }, { timeoutMs: 2000 });
      ok('a second build within the hour makes NO second website read (the failure memory) and still folds the font', rbCalls === 1 && r4b && r4b.brand && r4b.brand.font.family === 'Inter', { rbCalls });

      // 5. a slow website read never gates the build
      again();
      brandAnswer = BRAND; brandDelay = 900;
      const t0 = Date.now();
      const r5 = await er.getEmployerResearch({ website: 'https://slow-brand-test.com' }, { timeoutMs: 300 });
      const dt = Date.now() - t0;
      ok('⚠️ a caller whose time is up leaves at ~300 ms with base + conventions and no website brand', r5 && r5.industry === 'Logistics' && r5.conventions && (!r5.brand || r5.brand.primary === null) && dt >= 250 && dt < 700, { dt, brand: r5 && r5.brand });
      ok('…the base write did NOT wait for the website read', db.log.some((e) => /fetched_at = NOW\(\)$/.test(e.sql)), db.log.map((e) => e.sql.slice(-60)));
      ok('…and no brand write yet', brandWrites().length === 0);
      await new Promise((r) => setTimeout(r, 1100));
      ok('…the read finished on its own and persisted the brand (one labelled write, one read)', brandWrites().length === 1 && rbCalls === 1, { writes: brandWrites().length, rbCalls });
      brandDelay = 50;

      // 6. readCache shapes
      db.answer = (q) => (/FROM employer_research_cache/.test(q) ? { research: { conventions: null, conventionsAt: new Date().toISOString() }, fetched_at: new Date() } : null);
      ok('the checked-but-empty row still reads EXACTLY { research:null, hasBase:false, conventionsChecked:true }', JSON.stringify(await er._internals.readCache('empty-x.com')) === JSON.stringify({ research: null, hasBase: false, conventionsChecked: true }));
      db.answer = (q) => (/FROM employer_research_cache/.test(q) ? { research: { brand: BRAND, brandAt: new Date().toISOString() }, fetched_at: new Date() } : null);
      const rc = await er._internals.readCache('brand-only.com');
      ok('a brand-only row is a row: the brand in research, hasBase false (the researcher still runs), conventions unchecked', rc && rc.research && rc.research.brand.primary === '#e30613' && rc.hasBase === false && rc.conventionsChecked === false, rc);

      // 7. sanitising and brandOf
      const s1 = er.sanitiseBrand({ primary: '#ABCDEF', secondary: '#abcdef', font: { family: 'Inter; x', google: 'yes' }, from: { primary: 'made-up', font: 'body' }, fetchedAt: 'garbage' });
      ok('sanitiseBrand: hex lower-cased, a secondary equal to the primary dropped, a family with junk rejected, a made-up provenance nulled, a bad stamp replaced',
        er.sanitiseBrand('x') === null && er.sanitiseBrand({ primary: 'red' }) === null && s1.primary === '#abcdef' && s1.secondary === null && s1.font === null && s1.from.primary === null && s1.from.font === null && Number.isFinite(Date.parse(s1.fetchedAt)), s1);
      ok('sanitiseBrand: a font alone is a brand; google is a strict boolean', JSON.stringify(er.sanitiseBrand({ font: { family: 'Inter', google: 1 }, from: { font: 'google-link' } }).font) === JSON.stringify({ family: 'Inter', google: false }));
      ok('brandOf: null-safe; the researcher\'s invented defaults never leak; the researcher\'s real colour stands in',
        JSON.stringify(er.brandOf(null)) === JSON.stringify({ accent: null, font: null }) && er.brandOf({ brandColor: '#262633', fontName: 'Lato' }).accent === null && er.brandOf({ brandColor: '#262633', fontName: 'Lato' }).font === null && er.brandOf({ brandColor: '#1a73e8' }).accent === '#1a73e8');
      ok('researchPromptBlock: the effective colour rides along after real facts, never alone',
        /Brand colour: #e30613/.test(er.researchPromptBlock(r1, 'Brand Co')) && er.researchPromptBlock({ domain: 'x.com', brandColor: '#1a73e8' }, 'X') === '');

      // 8. the switch
      again();
      process.env.EMPLOYER_BRAND_EXTRACT = 'off';
      const r8 = await er.getEmployerResearch({ website: 'https://switched-off-test.com' }, { timeoutMs: 2000 });
      ok('EMPLOYER_BRAND_EXTRACT=off: no website read; the research is otherwise unchanged', rbCalls === 0 && r8 && r8.industry === 'Logistics', { rbCalls, r8 });
      delete process.env.EMPLOYER_BRAND_EXTRACT;

      // 9. the money line: no revision moved, no AI call added (the website read is a deterministic fetch)
      const erC = strip(R('server/services/employerResearch.js'));
      ok('⚠️ RESEARCH_REV stays r1 with the brand round (a bump re-bills every saved document)', er.RESEARCH_REV === 'r1' && /const RESEARCH_REV = 'r1';/.test(erC));
      ok('brandExtract is deterministic (no Gemini / generative-ai import)', !/generative-ai|GoogleGenerativeAI|callGemini/.test(strip(R('server/services/brandExtract.js'))));
      const erRaw = R('server/services/employerResearch.js');   // the label IS a comment — strip() would remove it
      ok('the brand patch never touches fetched_at and is labelled apart from the conventions patch',
        /EXCLUDED\.research \/\* brand \*\/`/.test(erRaw) && !/\|\| EXCLUDED\.research \/\* brand \*\/, fetched_at/.test(erRaw));
    } finally {
      clearInterval(keepAlive);
      researcher.researchEmployer = realRE; er.researchBrand = realRB; er.researchConventions = realRC; er.googleFontCheck = realGF;
      er._reset(); reset();
    }
  }

  console.log('── ⚠️ a STORED document\'s brand is a function of the ROW; a brand-less one catches up with the shared row READ-ONLY (2026-09-15) ──');
  {
    // Two defects. (1) employerResearch.brandOf consulted brandExtract.googleFontKnown — a per-process 24 h memory —
    // for a research snapshot's bare fontName, so a document stored before design.brand existed rendered in Lato after
    // a deploy, in Montserrat once ANY user's build had checked that family (a new brandKeyOf → every thumb and
    // preview re-rendered), and in Lato again a day later. (2) a build whose website read missed its deadline stored
    // design.brand = null over a brand-less snapshot and never gained the employer's colour, even after patchBrand
    // had written it to employer_research_cache for everyone. Now: brandOf reads only the row; withSharedBrand lays
    // the shared row's brand over such a document with ONE read-only SELECT (never the researcher, never the
    // website, never a write — a render can bill nobody).
    const RBX = require(path.join(ROOT, 'server/controllers/resumeBuilderController.js'));
    const BX = require(path.join(ROOT, 'server/services/brandExtract.js'));
    const oldDoc = { id: 1, design: JSON.stringify({ ranked: [], mode: 'a4' }), research: { domain: 'mont-brand-test.com', industry: 'Design', fontName: 'Montserrat', brandColor: '#123456' } };
    const before = RBX.docBrandOf(oldDoc), keyBefore = RBX.brandKeyOf(before);
    // ⚠️ RETARGETED 2026-09-15: a bare researcher fontName is read through brandExtract's STATIC alternative table
    // (googleAlternativeFor — Montserrat → itself, google:true; a face the table does not know stays google:false).
    // As deterministic as the row: the same answer on every process, no memory, no network — what the pins below hold.
    ok('cold process: a pre-brand snapshot\'s bare researcher fontName reads through the static table (Montserrat → itself, google:true), its colour the accent',
      JSON.stringify(before) === JSON.stringify({ accent: '#123456', font: { family: 'Montserrat', google: true } }), before);
    const emberDoc = { ...oldDoc, research: { ...oldDoc.research, fontName: 'Amazon Ember' } };
    const emberBefore = RBX.docBrandOf(emberDoc);
    ok('…and a face the table does not know is google:false (the renderer keeps the design\'s stack)', JSON.stringify(emberBefore) === JSON.stringify({ accent: '#123456', font: { family: 'Amazon Ember', google: false } }), emberBefore);
    const realKnown = BX.googleFontKnown;
    BX.googleFontKnown = (f) => (['montserrat', 'amazon ember'].includes(String(f).toLowerCase()) ? true : realKnown(f));
    try {
      const fresh = await er._internals.withResearcherFont({ domain: 'mont-brand-test.com', fontName: 'Montserrat' }, 5000);
      ok('(the memory IS live, and withResearcherFont is its ONE consumer: a fresh build\'s research gets brand.font google:true from it)', !!fresh && !!fresh.brand && fresh.brand.font.google === true && fresh.brand.from.font === 'researcher', fresh && fresh.brand);
      const after = RBX.docBrandOf(oldDoc);
      ok('⚠️ the stored document\'s brand is byte-identical after the memory learned Montserrat', JSON.stringify(after) === JSON.stringify(before), { before, after });
      ok('⚠️ …and so is its cache key (no thumb or preview re-render on a deploy)', RBX.brandKeyOf(after) === keyBefore && keyBefore !== 'plain', { keyBefore, keyAfter: RBX.brandKeyOf(after) });
      ok('⚠️ brandOf ignores the memory for a bare fontName: Amazon Ember stays google:false after the memory learned it; Montserrat is google:true from the TABLE; the verified answer the build wrote on brand.font is honoured',
        er.brandOf({ fontName: 'Amazon Ember' }).font.google === false && JSON.stringify(RBX.docBrandOf(emberDoc)) === JSON.stringify(emberBefore)
        && er.brandOf({ fontName: 'Montserrat' }).font.google === true && er.brandOf({ fontName: 'Montserrat' }).font.from === 'alternative' && er.brandOf(fresh).font.google === true,
        { ember: er.brandOf({ fontName: 'Amazon Ember' }).font, mont: er.brandOf({ fontName: 'Montserrat' }).font });
    } finally { BX.googleFontKnown = realKnown; }
    const erC = strip(R('server/services/employerResearch.js'));
    const brandOfSrc = (erC.match(/function brandOf\(research\) \{[\s\S]*?\n\}/) || [''])[0];
    ok('the source: brandOf never reads googleFontKnown (withResearcherFont alone does)', brandOfSrc.length > 100 && !/googleFontKnown/.test(brandOfSrc) && (erC.match(/googleFontKnown/g) || []).length === 1);

    console.log('── ⚠️ A SITE FONT GOOGLE DOES NOT HOST RENDERS IN ITS CLOSEST GOOGLE FACE (2026-09-15) ──');
    {
      // Prod doc 9 (Deutsche Bahn): brand font "DB Neo Screen Sans Regular" — not on Google Fonts, so the renderer fell
      // back to Lato and the brand's typography was lost. brandExtract.googleAlternativeFor is a STATIC table of
      // well-known corporate / system faces → a visually close Google-hosted face; employerResearch.brandOf answers it
      // for a non-hosted font (deterministic: no memory, no network), and the stored-document readers apply it too.
      const alt = BX.googleAlternativeFor;
      ok('googleAlternativeFor: DB Neo Screen Sans Regular → Barlow (the weight suffix stripped, the longest leading key wins)',
        JSON.stringify(alt('DB Neo Screen Sans Regular')) === JSON.stringify({ family: 'Barlow', google: true, from: 'alternative' }), alt('DB Neo Screen Sans Regular'));
      const table = { 'DIN': 'Barlow', 'FF DIN': 'Barlow', 'Frutiger': 'Open Sans', 'Myriad Pro': 'Open Sans', 'Segoe UI': 'Open Sans', 'Verdana': 'Open Sans', 'Helvetica Neue': 'Inter', 'Arial': 'Inter', 'SF Pro Display': 'Inter',
        'Gotham': 'Montserrat', 'Proxima Nova': 'Montserrat', 'Avenir Next': 'Montserrat', 'Avenir': 'Nunito Sans', 'Futura': 'Jost', 'Univers': 'Roboto Condensed', 'Calibri': 'Carlito', 'Trebuchet MS': 'Fira Sans',
        'Georgia': 'Lora', 'Times New Roman': 'EB Garamond', 'Times': 'EB Garamond', 'Garamond': 'EB Garamond', 'Cambria': 'Merriweather', 'serif': 'Merriweather', 'sans': 'Inter',
        'Roboto': 'Roboto', 'Lato': 'Lato', 'Open Sans': 'Open Sans', 'Montserrat': 'Montserrat', 'Inter': 'Inter', 'Poppins': 'Poppins' };
      const wrong = Object.entries(table).filter(([k, v]) => !(alt(k) && alt(k).family === v && alt(k).google === true && alt(k).from === 'alternative'));
      ok('the contract\'s table cases all answer (DIN family → Barlow, humanist → Open Sans, neo-grotesque → Inter, geometric → Montserrat, office and serif faces, Google faces → themselves)', wrong.length === 0, wrong.map(([k]) => [k, alt(k)]));
      ok('matching is case-insensitive and blind to weight / style suffixes: "HELVETICA NEUE LT Std Bold Italic" → Inter, "avenir-next-w01-medium" → Montserrat',
        alt('HELVETICA NEUE LT Std Bold Italic').family === 'Inter' && alt('avenir-next-w01-medium').family === 'Montserrat' && alt('  "Gotham" ').family === 'Montserrat', [alt('HELVETICA NEUE LT Std Bold Italic'), alt('avenir-next-w01-medium')]);
      ok('an unknown face is null — never a guess (Comic Sans MS, Amazon Ember, junk, nothing)', alt('Comic Sans MS') === null && alt('Amazon Ember') === null && alt('') === null && alt(null) === null && alt({}) === null && alt('x'.repeat(200)) === null);
      ok('pure and deterministic: the same answer twice, a new object each time', JSON.stringify(alt('Segoe UI')) === JSON.stringify(alt('Segoe UI')) && alt('Segoe UI') !== alt('Segoe UI'));
      const dbResearch = { domain: 'deutschebahn.com', brandColor: '#ec0016', fontName: 'DB Neo Screen Sans Regular', brand: { primary: '#ec0016', font: { family: 'DB Neo Screen Sans Regular', google: false }, from: { primary: 'css-var', font: 'body' }, fetchedAt: new Date().toISOString() } };
      const dbBrand = er.brandOf(dbResearch);
      ok('⚠️ brandOf: a site font Google does not host answers the alternative, with the site\'s family kept as `original`',
        JSON.stringify(dbBrand) === JSON.stringify({ accent: '#ec0016', font: { family: 'Barlow', google: true, from: 'alternative', original: 'DB Neo Screen Sans Regular' } }), dbBrand);
      ok('…deterministically (no memory, no network): byte-identical on a second read', JSON.stringify(er.brandOf(dbResearch)) === JSON.stringify(dbBrand));
      ok('the researcher\'s bare fontName too (Nexplore: Segoe UI → Open Sans)', JSON.stringify(er.brandOf({ brandColor: '#0078d4', fontName: 'Segoe UI' })) === JSON.stringify({ accent: '#0078d4', font: { family: 'Open Sans', google: true, from: 'alternative', original: 'Segoe UI' } }), er.brandOf({ brandColor: '#0078d4', fontName: 'Segoe UI' }));
      ok('a Google-hosted site font keeps its exact shape (no from / original)', JSON.stringify(er.brandOf({ brand: { primary: '#112231', font: { family: 'Space Grotesk', google: true } } }).font) === JSON.stringify({ family: 'Space Grotesk', google: true }));
      ok('a face the table does not know stays google:false, no from', JSON.stringify(er.brandOf({ brandColor: '#ff9900', fontName: 'Amazon Ember' }).font) === JSON.stringify({ family: 'Amazon Ember', google: false }));
      ok('effectiveFont is exported and null-safe', typeof er.effectiveFont === 'function' && er.effectiveFont(null) === null && er.effectiveFont({ family: '' }) === null && JSON.stringify(er.effectiveFont({ family: 'Segoe UI', google: false })) === JSON.stringify({ family: 'Open Sans', google: true, from: 'alternative', original: 'Segoe UI' }));
      // The stored-document readers: docBrandOf / letterBrandOf read design.brand straight off the row (never brandOf), so
      // prod doc 9 — its raw face stored google:false at build time — needed the table applied there as well.
      const doc9 = { id: 9, design: { ranked: [], mode: 'a4', brand: { accent: '#ec0016', font: { family: 'DB Neo Screen Sans Regular', google: false } } }, research: dbResearch };
      ok('⚠️ docBrandOf: a stored raw face renders in the alternative (doc 9 → Barlow, reduced to { family, google } for the renderer and the cache key)',
        JSON.stringify(RBX.docBrandOf(doc9)) === JSON.stringify({ accent: '#ec0016', font: { family: 'Barlow', google: true } }), RBX.docBrandOf(doc9));
      ok('…the design path and the research path key the cache identically for that row', RBX.brandKeyOf(RBX.docBrandOf(doc9)) === RBX.brandKeyOf(RBX.docBrandOf({ ...doc9, design: { ranked: [], mode: 'a4' } })));
      const CLX = require(path.join(ROOT, 'server/controllers/coverLetterController.js'));
      ok('letterBrandOf too: a stored raw Segoe UI letter renders in Open Sans; an unknown face stays as stored',
        JSON.stringify(CLX.letterBrandOf({ design: { brand: { accent: '#0078d4', font: { family: 'Segoe UI', google: false } } } })) === JSON.stringify({ accent: '#0078d4', font: { family: 'Open Sans', google: true } })
        && JSON.stringify(CLX.letterBrandOf({ design: { brand: { accent: '#ff9900', font: { family: 'Amazon Ember', google: false } } } })) === JSON.stringify({ accent: '#ff9900', font: { family: 'Amazon Ember', google: false } }));
      ok('⚠️ RESEARCH_REV / LETTER_REV / FP_VERSION are untouched by the font change (a bump would re-bill every saved document)',
        er.RESEARCH_REV === 'r1' && /const LETTER_REV = 'letter-v1';/.test(R('server/controllers/employerLetterController.js')) && /const FP_VERSION = 'v1';/.test(R('server/services/employerDocs.js')));
    }

    reset();
    const rows = new Map();
    db.answer = (q, params) => (/^SELECT research FROM employer_research_cache WHERE domain = \?$/.test(q) && rows.has(params[0]) ? { research: JSON.stringify(rows.get(params[0])) } : null);
    const writes = () => db.log.filter((e) => /^(INSERT|UPDATE|DELETE)/i.test(e.sql)).length;
    const nullDoc = () => ({ id: 3, design: { ranked: [{ id: 'modern' }], mode: 'a4', brand: null }, research: { domain: 'acme-brand-test.com', industry: 'Widgets', employerName: 'Acme' }, payload: { personal_info: { full_name: 'A' } } });
    ok('before the row has a brand: docBrandOf null (design.brand null, a snapshot without brand / colour / font)', RBX.docBrandOf(nullDoc()) === null);
    let d = await RBX.withSharedBrand(nullDoc());
    ok('withSharedBrand with no row: one SELECT, still null, the snapshot untouched', db.log.length === 1 && RBX.docBrandOf(d) === null && !('brand' in d.research), db.log.map((e) => e.sql));
    const ROW_BRAND = { primary: '#e30613', secondary: '#00857c', font: { family: 'Space Grotesk', google: true }, from: { primary: 'theme-color', font: 'body' }, fetchedAt: new Date().toISOString() };
    rows.set('acme-brand-test.com', { domain: 'acme-brand-test.com', industry: 'Widgets', brand: ROW_BRAND, brandAt: new Date().toISOString() });
    db.log.length = 0;
    d = await RBX.withSharedBrand(nullDoc());
    const got = RBX.docBrandOf(d);
    ok('⚠️ after patchBrand wrote the row: docBrandOf = the row\'s brand, laid over research.brand (the same doc object back)',
      JSON.stringify(got) === JSON.stringify({ accent: '#e30613', font: { family: 'Space Grotesk', google: true } }) && JSON.stringify(d.research.brand) === JSON.stringify(ROW_BRAND) && d.research.domain === 'acme-brand-test.com', { got, research: d.research });
    ok('…the design\'s ranking sees it too (rerankStoredResumeDesign attaches design.brand) and brandKeyOf is no longer "plain"',
      (() => { const r = RBX.rerankStoredResumeDesign(d); return (!r || JSON.stringify(r.brand) === JSON.stringify(got)) && RBX.brandKeyOf(got) !== 'plain'; })());
    ok('⚠️ exactly ONE read-only SELECT on the domain, ZERO inserts / updates / deletes',
      db.log.length === 1 && /^SELECT research FROM employer_research_cache WHERE domain = \?$/.test(db.log[0].sql) && db.log[0].params[0] === 'acme-brand-test.com' && writes() === 0, db.log.map((e) => e.sql));
    db.log.length = 0;
    const own = await RBX.withSharedBrand({ ...nullDoc(), design: { ranked: [], brand: { accent: '#111111', font: null } } });
    ok('a document WITH its own brand never asks the row', db.log.length === 0 && RBX.docBrandOf(own).accent === '#111111');
    const noResearch = await RBX.withSharedBrand({ id: 5, design: { brand: null }, research: null, payload: {} });
    ok('a document with no research snapshot is left alone (no domain of record; no SQL)', db.log.length === 0 && noResearch.research === null);
    const fromResearch = await RBX.withSharedBrand({ ...nullDoc(), research: { domain: 'acme-brand-test.com', brandColor: '#0e7490', fontName: 'Inter' } });
    ok('a snapshot that already carries the researcher\'s colour is a brand of its own: no SQL, that colour', db.log.length === 0 && RBX.docBrandOf(fromResearch).accent === '#0e7490');
    rows.set('stale-brand-test.com', { domain: 'stale-brand-test.com', brand: ROW_BRAND, brandAt: new Date(Date.now() - 40 * 864e5).toISOString() });
    ok('cachedBrandFor: a brand past its OWN 30-day clock (brandAt, not fetched_at) is null', (await er.cachedBrandFor('stale-brand-test.com')) === null);
    db.log.length = 0;
    ok('cachedBrandFor: a non-domain asks nothing', (await er.cachedBrandFor('not a domain')) === null && (await er.cachedBrandFor(null)) === null && db.log.length === 0);
    const viaUrl = await er.cachedBrandFor('https://www.ACME-brand-test.com/jobs');
    ok('cachedBrandFor normalises the domain (scheme, www., case, a path) to the row\'s key', !!viaUrl && viaUrl.primary === '#e30613' && db.log[db.log.length - 1].params[0] === 'acme-brand-test.com', { viaUrl, key: db.log[db.log.length - 1] && db.log[db.log.length - 1].params });
    ok('cachedBrandFor: the whole sanitised Brand comes back (primary, secondary, font, from, fetchedAt)', (() => { const b = rows.get('acme-brand-test.com').brand; return !!b && b.secondary === '#00857c' && b.font.google === true; })() && JSON.stringify(Object.keys((await er.cachedBrandFor('acme-brand-test.com')) || {}).sort()) === JSON.stringify(['fetchedAt', 'font', 'from', 'primary', 'secondary']));
    db.throwOn = /^SELECT research FROM employer_research_cache/;
    ok('cachedBrandFor degrades to null on a DB error', (await er.cachedBrandFor('acme-brand-test.com')) === null);
    const errDoc = await RBX.withSharedBrand(nullDoc());
    ok('…and withSharedBrand leaves the document untouched then (never throws)', RBX.docBrandOf(errDoc) === null && !('brand' in errDoc.research));
    reset();
    const rbC = strip(R('server/controllers/resumeBuilderController.js'));
    ok('⚠️ loadResumeDoc — the ONE loader every docId render path uses — lays the shared brand on (withSharedBrand), before any cache key',
      /withSharedBrand\(doc\)/.test((rbC.match(/async function loadResumeDoc\([\s\S]*?\n\}/) || [''])[0]) && /withSharedBrand,/.test(rbC));
    ok('withSharedBrand reads through employerResearch.cachedBrandFor and never the researcher / the website / a write',
      (() => { const b = (rbC.match(/async function withSharedBrand\(doc\) \{[\s\S]*?\n\}/) || [''])[0]; return b.length > 100 && /cachedBrandFor\(domain\)/.test(b) && !/getEmployerResearch|researchBrand|brandCallFor|INSERT|UPDATE/.test(b); })());
  }

  console.log('── findPlaceholders: brackets are never stored ──');
  const RB = require(path.join(ROOT, 'server/controllers/resumeBuilderController.js'));
  const found = RB.findPlaceholders({ summary: 'Cut costs by [X%].', experience: [{ highlights: ['Built [Insert Key Functionality] for payments', 'Grew revenue XX%', 'Led 12 engineers', 'Shipped Next.js [React Native]'] }] });
  ok('catches [X%]', found.includes('[X%]'), found);
  ok('catches [Insert Key Functionality]', found.includes('[Insert Key Functionality]'), found);
  ok('catches a bare XX%', found.includes('XX%'), found);
  ok('leaves real numbers and a real bracket alone', !found.some((t) => /12|React Native/.test(t)), found);
  const cleaned = RB.stripPlaceholders({ summary: 'Cut costs by [X%] across teams.', h: ['[Insert Key Functionality]', 'Kept'] });
  ok('stripPlaceholders removes the token with its dangling "by", and drops an emptied item',
    cleaned.summary === 'Cut costs across teams.' && JSON.stringify(cleaned.h) === JSON.stringify(['Kept']), cleaned);
  ok('the exports promised by the contract exist', ['currentResumeFingerprint', 'buildEmployerDocPrompt', 'findPlaceholders'].every((k) => typeof RB[k] === 'function'));
  // ⚠️ THE GUARD DELETED REAL RESUME FACTS. "any bracket containing %" took out "reduced costs [by 30%]";
  // "lone X or N" took out "[C#]" and "[N/A]"; a slot WORD anywhere took out "Python [advanced]" and
  // "[Add-ons]". A stripped fact is a lie on a document the user paid for, so the guard is anchored now:
  // a '%' counts only with no digit beside it, an X/N only as the WHOLE inside, a slot word only when it
  // IS the bracket or opens an instruction. Every KEEP below must survive byte-for-byte.
  {
    const keeps = ['[C#]', 'reduced costs [by 30%]', 'Python [advanced]', '[2019]', '[100% remote]', '[C++, N-Tier]',
      '[company-wide]', '[React Native]', '[N/A]', '[XML]', '[Xamarin]', '[AWS]', '[Add-ons]', '[Enterprise]',
      '[Insertion sort]', '[Nordics]', '[85.40%]', 'see [GitHub](https://x.test)'];
    const keptWhole = keeps.filter((t) => RB.findPlaceholders({ summary: t }).length === 0 && RB.stripPlaceholders({ summary: t }).summary === t);
    ok('⚠️ real facts in brackets are KEPT, and kept byte-for-byte', keptWhole.length === keeps.length,
      keeps.filter((t) => !keptWhole.includes(t)));
    const catches = ['[X%]', '[Insert Key Functionality]', 'Grew revenue XX%', '[X]', '[$X]', '[XK]', '[$XX,XXX]',
      '[N+]', '[N users]', '[Date]', '[Company Name]', '[Key Metric]', '[Number of users]', '[Your Name]',
      '[Add metric]', '[% growth]', 'raised $XM'];
    const caught = catches.filter((t) => RB.findPlaceholders({ summary: t }).length > 0);
    ok('⚠️ …and every real slot is still caught', caught.length === catches.length, catches.filter((t) => !caught.includes(t)));
  }

  console.log('── ⚠️ the resume doc lane: never user_resumes, and a hit returns before billing ──');
  const ctl = strip(R('server/controllers/resumeBuilderController.js'));
  const lane = fnBody(ctl, 'generateEmployerDoc');
  ok('generate-ai hands saveTo:employer_doc to the doc lane at its first line', /if \(req\.body && req\.body\.saveTo === 'employer_doc'\) return generateEmployerDoc\(req, res\);/.test(ctl));
  ok('the doc lane exists and is substantial', lane.length > 3000, lane.length);
  ok('⚠️ it never calls saveResumeRow, snapshotBaseBeforeTailoring, or touches regen_count / user_resumes',
    !/saveResumeRow\(|snapshotBaseBeforeTailoring\(|regen_count|user_resumes/.test(lane));
  const hitAt = lane.indexOf("employerDocs.get(userId, 'resume', company, cacheFp, env)");
  const hitReturn = lane.indexOf('cached: true', hitAt);
  const firstBilling = Math.min(...['canConsumeMany(', 'passCoversGeneration(', 'claimGeneration(', 'consumeOnSuccess(', 'researchForDoc(', 'writeDocDraft(']
    .map((t) => lane.indexOf(t)).filter((i) => i >= 0));
  ok('⚠️ the cache hit returns BEFORE any gate, research, AI or charge', hitAt > 0 && hitReturn > hitAt && hitReturn < firstBilling, { hitAt, hitReturn, firstBilling });
  ok('⚠️ coveredOnly refuses before research (research is paid work)',
    lane.indexOf('if (coveredOnly && !viaPass && !quotaCovers)') > 0 && lane.indexOf('if (coveredOnly && !viaPass && !quotaCovers)') < lane.indexOf('researchForDoc('));
  ok('…and is re-asked at the moment of payment', /lost its cover during the run/.test(lane) && lane.indexOf('lost its cover during the run') < lane.indexOf('consumeOnSuccess('));
  ok('⚠️ a document is stored only after the charge is confirmed', lane.indexOf('if (!charged)') > 0 && lane.indexOf('if (!charged)') < lane.indexOf('employerDocs.put('));
  ok('the free-regeneration lane does not exist here', !/isRegenerate|freeRegen/.test(lane));
  const gate = fnBody(ctl, 'generationGate');
  ok('the gate computes the SAME fingerprint for the doc lane', /const fp = docLane\s*\? await currentResumeFingerprint\(userId, \{ job, env \}\)/.test(gate));
  const cards = fnBody(ctl, 'docHomeCards');
  ok('home-cards ?doc= dispatches to the doc mode first', /if \(req\.query && req\.query\.doc !== undefined\) return docHomeCards\(req, res\);/.test(ctl));
  ok('⚠️ doc mode 404s doc_gone and has NO fallback padding', /reason: 'doc_gone'/.test(cards) && !/fallback|FALLBACK|sampleResumeFor|user_resumes/.test(cards) && /sample: false/.test(cards));
  ok('doc thumbs live in a DOT directory on the uploads volume', /const DOC_THUMB_ROOT = path\.join\(__dirname, '\.\.\/\.\.\/uploads\/\.thumb_cache'\)/.test(ctl) && /const DOC_THUMB_KEEP = 240;/.test(ctl));
  // ⚠️ ONE CACHE FOR THE GALLERY AND THE CARDS (2026-09-15): the file is the FULL 794-px page keyed by (user, doc, updated_at,
  // photo version, template, brand hash); Home's 480-px card is derived from it with sharp and stored beside it (.w480).
  ok('the stored file is the full page, keyed with the brand hash (resume-doc-page:v3 … brandKeyOf)', /'resume-doc-page:v3', userId, doc\.id, ms, pver, tplId, brandKeyOf\(brand\)/.test(ctl));
  ok('the card is derived with sharp at THUMB_W and stored alongside under the page\'s name suffixed .w480', /const DOC_CARD_SUFFIX = `\.w\$\{THUMB_W\}`/.test(ctl) && /const THUMB_W = 480\b/.test(ctl) && /require\('sharp'\)\(full\)\.resize\(\{ width: THUMB_W \}\)/.test(fnBody(ctl, 'docThumb')));
  ok('the gallery\'s doc-mode path and Home\'s cards both go through docPages (one render per file, in-flight requests deduped)',
    /await docPages\(/.test(fnBody(ctl, 'previewTemplates')) && /await docPages\(/.test(fnBody(ctl, 'docThumb')) && /await docPages\(/.test(fnBody(ctl, 'prerenderDocPages')) && /docThumbFlights/.test(fnBody(ctl, 'docPages')));
  ok('…the doc-mode gallery path writes no temp/ JSON (writePreviewCache is the BASE gallery\'s alone)', !/writePreviewCache\([^)]*docId/.test(fnBody(ctl, 'previewTemplates')) && (fnBody(ctl, 'previewTemplates').indexOf('await docPages(') < fnBody(ctl, 'previewTemplates').indexOf('writePreviewCache(')));
  ok('the LRU counts pages and cards alike, never the letters\' cl_ files', /new RegExp\(`\^\[0-9a-f\]\{64\}\(\?:\\\\\$\{DOC_CARD_SUFFIX\}\)\?\\\\\.jpg\$`\)/.test(ctl) || /DOC_THUMB_NAME = new RegExp/.test(ctl));
  ok('⚠️ the doc lane samples at 0.55 and the builder lane keeps its 0.4 (the default nobody else overrides)',
    /const DOC_LANE_TEMPERATURE = 0\.55;/.test(ctl) && /async function callGemini\(prompt, \{ temperature = 0\.4 \} = \{\}\)/.test(ctl)
    && (strip(ctl).match(/await callGemini\((?:prompt|fixPrompt), \{ temperature: DOC_LANE_TEMPERATURE \}\)/g) || []).length === 2 && (strip(ctl).match(/await callGemini\(/g) || []).length === 3);
  ok('the base preview path selects updated_at, so its cache key is stable', /SELECT resume_data, updated_at FROM user_resumes/.test(fnBody(ctl, 'previewTemplates')));
  ok('generate-pdf/docx bill a doc download to the DOCUMENT\'s employer (body.employer ignored)',
    /const billingEmployerOf = \(doc, body\) => \(doc \? doc\.employer_name \|\| null :/.test(ctl)
    && /const employer = billingEmployerOf\(doc, req\.body\)/.test(fnBody(ctl, 'generatePDF'))
    && /const employer = billingEmployerOf\(doc, req\.body\)/.test(fnBody(ctl, 'generateDocx'))
    && /reason: 'payload_gone'/.test(ctl));

  console.log('── ⚠️ the letter lane: a hit returns before billing, coveredOnly before research ──');
  const lctl = strip(R('server/controllers/employerLetterController.js'));
  const build = fnBody(lctl, 'buildEmployerLetter');
  const lHit = build.indexOf("employerDocs.get(userId, 'cover_letter', company, fp, env)");
  const lHitReturn = build.indexOf('cached: true', lHit);
  // The lane's AI call: callLetterModel until 2026-09-18, writeLetterText (through aiText) since. One of them must be there.
  const lAi = Math.min(...['writeLetterText(', 'callLetterModel('].map((t) => build.indexOf(t)).filter((i) => i >= 0));
  const lFirstPaid = Math.min(...['canConsumeMany(', 'passCoversGeneration(', 'claimGeneration(', 'consumeOnSuccess(', 'getEmployerResearch(', 'writeLetterText(', 'callLetterModel('].map((t) => build.indexOf(t)).filter((i) => i >= 0));
  ok('⚠️ the cache hit returns BEFORE any gate, research, AI or charge', lHit > 0 && lHitReturn > lHit && lHitReturn < lFirstPaid, { lHit, lHitReturn, lFirstPaid });
  const lCovered = build.indexOf('if (coveredOnly && !viaPass && !quotaCovers)');
  ok('⚠️ the coveredOnly refusal precedes research AND the AI', lCovered > 0 && Number.isFinite(lAi) && lCovered < build.indexOf('getEmployerResearch(') && lCovered < lAi, { lCovered, lAi });
  // The refunds moved out of the build body into ONE helper, because a refused build now has three
  // things to give back (credits, the pass's generation, the plan/trial ledger row), not just credits.
  ok('…re-asked at payment, and a credits slip gives THIS build\'s charge back',
    /lost its cover during the run/.test(build)
    && /giveBackLetterCharge\(userId, took, 'a coveredOnly build slipped into credits'\)/.test(build));
  {
    // ⚠️ EVERY CHARGE, BY THE IDS THIS BUILD'S OWN CLAIM AND CONSUME RETURNED. Clearing a column another
    // letter spent, or deleting another build's ledger row, hands out a free letter.
    const give = fnBody(lctl, 'giveBackLetterCharge');
    ok('⚠️ …and the give-back undoes credits, the pass generation AND the usage row',
      /refundCredits\(userId, 'cover_letter_generate', \{ charged: true, cost \}\)/.test(give)
      && /UPDATE download_passes SET letter_generated_at = NULL WHERE id = \$1 AND user_id = \$2/.test(give)
      && /DELETE FROM usage_ledger WHERE id = \$1 AND user_id = \$2/.test(give));
    ok('⚠️ …exactly once: each leg is cleared off `took` before it runs, so a second call is a no-op',
      /took\.credits = null;/.test(give) && /took\.passId = null;/.test(give) && /took\.ledgerId = null;/.test(give));
  }
  {
    // ⚠️ A STORED LETTER IS A FREE HIT FOR EVER AFTER, so an unconfirmed charge must never reach put().
    // Pinned as the ORDER (guard, then store), not as one line's spelling — the store gained a retry.
    const guard = build.indexOf('if (!charged) {');
    const put = build.indexOf('employerDocs.put(letterDoc)');
    ok('⚠️ stored only when charged', guard > 0 && put > guard && /return;\s*\}/.test(build.slice(guard, put)), { guard, put });
    ok('⚠️ …and a paid letter that cannot be stored is retried once, then given back in full',
      /docId = \(await employerDocs\.put\(letterDoc\)\) \|\| \(await employerDocs\.put\(letterDoc\)\);/.test(build)
      && /if \(!docId\) \{[\s\S]{0,600}?giveBackLetterCharge\(userId, took, 'the paid letter could not be stored'\)/.test(build)
      && /reason: 'failed'/.test(build.slice(put)));
  }
  // ⚠️ canConsumeMany CHECKS AND NEVER RESERVES: two covered letters landing together both read
  // "1 unit left" and both spent it. One payment decision at a time per (user, kind) — and the key is
  // spelled exactly as the resume lane spells it, or the two lanes do not serialise against each other.
  ok('⚠️ the whole payment decision runs under the shared per-(user, kind) usage lock',
    /SELECT pg_advisory_xact_lock\(hashtext\('usage:' \|\| \$1::text\), \$2::int\)/.test(fnBody(lctl, 'withUsageLock'))
    && /SET LOCAL lock_timeout/.test(fnBody(lctl, 'withUsageLock'))
    && /await withUsageLock\(userId, 'cover_letter', async \(\) => \{/.test(build));
  ok('never the legacy generator (its prompt researches and names clients live)', !/generateCoverLetter\(/.test(lctl) && !/googleSearch/.test(lctl));
  const routesSrc = strip(R('server/routes/coverLetterRoutes.js'));
  ok('the three letter routes are behind auth, and the build runs as an async job',
    /router\.post\('\/cover-letter\/employer-gate',\s+authenticateToken, employerLetterGate\)/.test(routesSrc)
    && /router\.post\('\/cover-letter\/employer-build',\s+authenticateToken, asJob\('cover_letter_employer'\)\(buildEmployerLetter\)\)/.test(routesSrc)
    && /router\.get\('\/cover-letter\/employer-cards',\s+authenticateToken, employerLetterCards\)/.test(routesSrc));

  // ⚠️ THE LETTER HTML IS NOT OURS, AND THIS CHROMIUM RUNS INSIDE OUR NETWORK. A stored letter reaches
  // the renderer for the PDF and for the Home thumbnail; with scripts on and the network open, an
  // <iframe src="http://127.0.0.1:…">, an <img> at a metadata address or a <link rel="prefetch"> made
  // OUR server fetch internal pages and the thumbnail showed the user what came back. Three fences.
  {
    const rnd = require(path.join(ROOT, 'server/utils/coverLetterRenderer.js'));
    const rndC = strip(R('server/utils/coverLetterRenderer.js'));
    // ⚠️ Since the preview loop reuses ONE page (see the renderPreviews block below) the fences live in
    // newRoutedPage, and EVERY page in the file must come from it — a second newPage( anywhere would be a
    // page with scripts on and the network open.
    const routed = fnBody(rndC, 'newRoutedPage');
    ok('⚠️ fence 1: pages are created with javaScriptEnabled FALSE',
      /newPage\(\{ viewport: \{ width: A4_W, height: A4_H \}, javaScriptEnabled: false \}\)/.test(routed));
    ok('⚠️ fence 2: a route installed BEFORE any content aborts everything the allowlist does not name',
      /await page\.route\('\*\*\/\*', \(route\) => \(isAllowedRequest\(route\.request\(\)\.url\(\)\)\s*\? route\.continue\(\)\s*: route\.abort\('blockedbyclient'\)\)/.test(routed)
      && routed.indexOf('page.route(') < routed.indexOf('return page'));
    ok('⚠️ …and newRoutedPage is the ONLY place a page is made: the PDF path and the preview loop both go through it',
      (rndC.match(/\.newPage\(/g) || []).length === 1
      && /await newRoutedPage\(browser\)/.test(fnBody(rndC, 'preparePage'))
      && /await preparePage\(browser, html\)/.test(fnBody(rndC, 'renderPdf'))
      && /page = await newRoutedPage\(browser\)/.test(fnBody(rndC, 'renderPreviews')));
    const allowed = ['data:image/png;base64,AAAA', 'https://fonts.googleapis.com/css2?family=Lato', 'https://fonts.gstatic.com/s/lato/x.woff2'];
    const blocked = ['http://127.0.0.1:9/admin', 'http://169.254.169.254/latest/meta-data/', 'http://fonts.googleapis.com/css2', 'https://evil.example.com/fonts.googleapis.com/x',
      'https://localhost/x', 'file:///etc/passwd', 'https://fonts.googleapis.com.evil.example.com/x', '', 'not a url'];
    ok('⚠️ …and the allowlist is data: URIs plus the two font hosts over https, nothing else',
      allowed.every((u) => rnd.isAllowedRequest(u) === true) && blocked.every((u) => rnd.isAllowedRequest(u) === false),
      { letIn: blocked.filter((u) => rnd.isAllowedRequest(u)), keptOut: allowed.filter((u) => !rnd.isAllowedRequest(u)) });
    // ⚠️ page.route does NOT see what the network service fetches on the page's behalf — a
    // <link rel="prefetch"> walked past route AND context.route and reached a local probe server.
    ok('⚠️ fence 3: the whole browser is pointed at a dead proxy, with only the font hosts bypassing it',
      /const BLACKHOLE_PROXY = \{ server: 'http:\/\/127\.0\.0\.1:9', bypass: \[\.\.\.ALLOWED_HOSTS, '<-loopback>'\]\.join\(','\) \}/.test(rndC)
      && /proxy: BLACKHOLE_PROXY/.test(fnBody(rndC, 'launchBrowser')));
  }

  // ⚠️ SINGLE-PROCESS CHROMIUM EXITS WHEN A PAGE CLOSES, AND CANNOT HOLD A SECOND PAGE. The preview loop
  // used to open + close a page per template, so the SECOND template always met "Target page, context or
  // browser has been closed" and the whole call threw away the pages already rendered (prod 2026-09-13:
  // any 2+ uncached letter designs → 500). A fake browser that behaves exactly that way drives the REAL
  // renderPreviews: one page for the batch, never closed, and a failed template retried on a fresh browser.
  {
    const blPath = require.resolve(path.join(ROOT, 'server/utils/browserLimit.js'));
    const realBl = require.cache[blPath];
    const fx = { launches: [], failMain: new Map() };   // failMain: main-screenshot ordinal → how many times to throw
    let mainShots = 0;
    const fakeBrowser = (opts) => {
      const b = { opts, pages: 0, closed: 0, connected: true, openPages: 0 };
      b.isConnected = () => b.connected;
      b.close = async () => { b.connected = false; };
      b.newPage = async (pageOpts) => {
        if (!b.connected) throw new Error('Target page, context or browser has been closed');
        if (b.openPages > 0) throw new Error('single-process chromium cannot hold a second page');
        b.pages++; b.openPages++;
        const pg = { pageOpts, routed: false, contentBeforeRoute: false, html: '' };
        pg.route = async () => { pg.routed = true; };
        pg.setContent = async (html) => { if (!pg.routed) pg.contentBeforeRoute = true; if (!b.connected) throw new Error('closed'); pg.html = html; };
        pg.setViewportSize = async () => { if (!b.connected) throw new Error('closed'); };
        pg.evaluate = async (fn, arg) => (arg === undefined ? true : 1300);
        pg.screenshot = async (o) => {
          if (!b.connected) throw new Error('Target page, context or browser has been closed');
          if (o && o.quality === 82) {
            const n = ++mainShots;
            const left = fx.failMain.get(n) || 0;
            if (left > 0) { fx.failMain.set(n, left - 1); mainShots--; b.connected = false; throw new Error('Target crashed'); }
          }
          return Buffer.from('jpeg');
        };
        // single-process: closing the only page takes the browser down with it
        pg.close = async () => { b.closed++; b.openPages--; b.connected = false; };
        b.lastPage = pg;
        return pg;
      };
      fx.launches.push(b);
      return b;
    };
    require.cache[blPath] = { id: blPath, filename: blPath, loaded: true, exports: { launchChromium: async (_c, opts) => fakeBrowser(opts) } };
    const rnd = require(path.join(ROOT, 'server/utils/coverLetterRenderer.js'));
    const tpls = require(path.join(ROOT, 'server/utils/coverLetterTemplates.js')).TEMPLATES.slice(0, 3);
    const data = { personal_info: { full_name: 'Test Person' }, coverLetterHtml: '<p>Hello</p>' };
    const quiet = console.warn; console.warn = () => {};
    try {
      let out = await rnd.renderPreviews(data, {}, tpls);
      const b0 = fx.launches[0];
      ok('⚠️ renderPreviews: 3 uncached designs on single-process chromium → all 3 pages come back, in order',
        out.length === 3 && out.map((x) => x.id).join() === tpls.map((t) => t.id).join() && out.every((x) => /^data:image\/jpeg;base64,/.test(x.image)),
        out.map((x) => x.id));
      ok('⚠️ …from ONE browser and ONE page, never closed mid-batch (no per-template newPage/close)',
        fx.launches.length === 1 && b0.pages === 1 && b0.closed === 0, { launches: fx.launches.length, pages: b0.pages, closed: b0.closed });
      ok('…that page is the fenced one (JS off, routed before any content) and the browser the proxied one',
        b0.lastPage.pageOpts.javaScriptEnabled === false && b0.lastPage.routed && !b0.lastPage.contentBeforeRoute
        && b0.opts && b0.opts.proxy && b0.opts.proxy.server === 'http://127.0.0.1:9');
      ok('…and the browser is closed once, at the end', b0.connected === false);

      fx.launches.length = 0; mainShots = 0; fx.failMain = new Map([[2, 1]]);
      out = await rnd.renderPreviews(data, {}, tpls);
      ok('⚠️ a template that fails once is retried on a FRESH browser, and every page still comes back',
        out.length === 3 && out.map((x) => x.id).join() === tpls.map((t) => t.id).join() && fx.launches.length === 2
        && fx.launches.every((b) => b.pages === 1 && b.closed === 0), { ids: out.map((x) => x.id), launches: fx.launches.length });

      fx.launches.length = 0; mainShots = 0; fx.failMain = new Map([[2, 2]]);
      out = await rnd.renderPreviews(data, {}, tpls);
      ok('⚠️ a template that fails twice is skipped — the call does NOT throw away the pages that did render',
        out.map((x) => x.id).join() === [tpls[0].id, tpls[2].id].join() && fx.launches.length <= 3, { ids: out.map((x) => x.id), launches: fx.launches.length });
      ok('…and no browser is left running', fx.launches.every((b) => b.connected === false));
    } catch (e) {
      ok('renderPreviews ran against the fake single-process browser', false, String(e && e.stack || e));
    } finally {
      console.warn = quiet;
      if (realBl) require.cache[blPath] = realBl; else delete require.cache[blPath];
    }
  }

  console.log('── /api/employer-docs: every route authenticated; reads never generate ──');
  const auth = require(path.join(ROOT, 'server/middleware/auth.js'));
  const edr = require(path.join(ROOT, 'server/routes/employerDocsRoutes.js'));
  const layers = edr.stack.filter((l) => l.route).map((l) => ({ m: Object.keys(l.route.methods)[0], p: l.route.path, s: l.route.stack.map((x) => x.handle) }));
  for (const [m, p] of [['get', '/'], ['post', '/current'], ['get', '/:id'], ['put', '/:id']]) {
    const l = layers.find((x) => x.m === m && x.p === p);
    ok(`${m.toUpperCase()} ${p} exists behind authenticateToken`, l && l.s[0] === auth.authenticateToken && l.s.length === 2, layers.map((x) => x.m + ' ' + x.p));
  }
  const edrC = strip(R('server/routes/employerDocsRoutes.js'));
  ok('⚠️ the routes never generate or charge', !/generate|consumeOnSuccess|claimGeneration|canConsumeMany|put\(\{/.test(edrC.replace(/docs\.updatePayload/g, '')));
  ok('mounted next to /api/resume-builder', /app\.use\('\/api\/employer-docs', require\('\.\/server\/routes\/employerDocsRoutes'\)\)/.test(R('server.js')));
  // Contract 4/6 (2026-09-15): every read answers design.brand — through the controller's docBrandOf (ONE answer with
  // home-cards, the gallery and the downloads), with a shape-checked stored-design fallback when the controller cannot load.
  ok('⚠️ /current and GET /:id attach design.brand through resumeBuilderController.docBrandOf, on the repaired AND the rule-only paths',
    /require\('\.\.\/controllers\/resumeBuilderController'\)\.docBrandOf/.test(edrC) && /const brand = brandFor\(doc\);/.test(edrC)
    && /return \{ \.\.\.repaired, brand \};/.test(edrC) && (edrC.match(/\}\), brand \};/g) || []).length >= 2, (edrC.match(/\}\), brand \};/g) || []).length);
  const handler = (m, p) => layers.find((x) => x.m === m && x.p === p).s[1];
  const mkRes = () => { const r = { statusCode: 200, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  const callRoute = async (m, p, req) => { const res = mkRes(); await handler(m, p)({ user: { id: 7 }, headers: {}, query: {}, params: {}, body: {}, ...req }, res); return res; };
  const realDocs = { ...docs };
  let r = await callRoute('get', '/', { query: { kind: 'letters' } });
  ok('GET / with a bad kind → 400 bad_kind', r.statusCode === 400 && r.body.reason === 'bad_kind', r.body);
  docs.getById = async () => null;
  r = await callRoute('get', '/:id', { params: { id: '9' } });
  ok('GET /:id not found → 404 gone', r.statusCode === 404 && r.body.reason === 'gone', r.body);
  docs.getById = async (uid, id) => ({ id: 9, kind: 'resume', employer_name: 'Airbus', employer_id: null, job_url: '', job_title: '', created_at: new Date(), updated_at: new Date(), edited_at: null, input_fingerprint: 'x', payload: { personal_info: { title: 'Engineer' } }, research: { key: 'internal' }, design: null });
  r = await callRoute('get', '/:id', { params: { id: '9' } });
  ok('GET /:id → DocMeta + payload, stale false, a computed rule-only design, never the research',
    r.statusCode === 200 && r.body.doc.docId === 9 && r.body.doc.stale === false && r.body.doc.summary.title === 'Engineer'
    && r.body.doc.design && r.body.doc.design.ranked.length === RIDS.length && !('research' in r.body.doc) && r.body.doc.payload.personal_info, r.body);
  docs.slimById = async () => ({ id: 9, kind: 'resume' });
  let updated = 0;
  docs.updatePayload = async () => { updated++; return { ok: true, updatedAt: 'now' }; };
  r = await callRoute('put', '/:id', { params: { id: '9' }, body: { payload: { summary: 'no personal_info' } } });
  ok('PUT a resume without personal_info → 400 invalid, nothing written', r.statusCode === 400 && r.body.reason === 'invalid' && updated === 0, r.body);
  docs.slimById = async () => ({ id: 9, kind: 'cover_letter' });
  r = await callRoute('put', '/:id', { params: { id: '9' }, body: { payload: { coverLetterHtml: 'x'.repeat(61 * 1024) } } });
  ok('PUT a letter over 60 KB → 413 too_big', r.statusCode === 413 && r.body.reason === 'too_big' && updated === 0, r.body);
  docs.slimById = async () => { throw new Error('db down'); };
  r = await callRoute('put', '/:id', { params: { id: '9' }, body: { payload: { personal_info: {} } } });
  ok('⚠️ PUT during a database blip → 500, never 404 gone', r.statusCode === 500, r.body);
  Object.assign(docs, realDocs);

  // ⚠️ "STALE" MUST MEAN "THE USER'S MATERIAL MOVED", NOT "THE PHONE FORGOT THE POSTING". The listing
  // lived in an evicting device cache: once it aged out the phone sent different job fields, the
  // recomputed fingerprint could never match again, and the document read stale FOR EVER — and a
  // Refresh rebuilt it without the posting. The row now carries the job it was hashed from (job_input).
  {
    const RBC = require(path.join(ROOT, 'server/controllers/resumeBuilderController.js'));
    const realFp = RBC.currentResumeFingerprint;
    let hashed = null;
    RBC.currentResumeFingerprint = async (uid, { job }) => { hashed = job; return 'fp-of-' + JSON.stringify(job); };
    const ji = { title: 'Backend Engineer', url: 'https://amazon.jobs/en/jobs/1', description: 'the posting', website: 'https://amazon.com' };
    docs.currentFor = async () => ({
      id: 9, kind: 'resume', employer_name: 'Amazon', employer_id: null, job_url: '', job_title: '',
      created_at: new Date(), updated_at: new Date(), edited_at: null, input_fingerprint: 'fp-of-' + JSON.stringify({ company: 'Amazon', ...ji }),
      payload: {}, research: null, design: null, job_input: ji,
    });
    // The phone has forgotten the listing entirely — jobTitle/jobText/website are all gone.
    r = await callRoute('post', '/current', { body: { kind: 'resume', employer: 'Amazon', jobUrl: '' } });
    ok('⚠️ /current re-hashes the job the DOCUMENT was built for, so a forgotten listing is not "stale"',
      r.statusCode === 200 && r.body.doc.stale === false && hashed && hashed.url === ji.url && hashed.description === ji.description, { hashed, stale: r.body && r.body.doc && r.body.doc.stale });
    ok('⚠️ …and DocMeta hands that job back, so the client can rebuild against the same posting',
      r.body.doc.jobInput && r.body.doc.jobInput.url === ji.url && r.body.doc.jobInput.title === ji.title, r.body.doc.jobInput);
    // A row written before job_input existed still falls back to what the client sends — postingUrl first
    // (an employer-level doc may be written against a pasted posting), else the identity jobUrl.
    hashed = null;
    docs.currentFor = async () => ({
      id: 9, kind: 'resume', employer_name: 'Amazon', employer_id: null, job_url: '', job_title: '',
      created_at: new Date(), updated_at: new Date(), edited_at: null, input_fingerprint: 'old', payload: {}, research: null, design: null,
    });
    r = await callRoute('post', '/current', { body: { kind: 'resume', employer: 'Amazon', jobUrl: '', postingUrl: 'https://amazon.jobs/en/jobs/1', jobTitle: 'Backend Engineer' } });
    ok('⚠️ a pre-046 row falls back to the client\'s fields, postingUrl before the identity jobUrl',
      hashed && hashed.url === 'https://amazon.jobs/en/jobs/1' && hashed.title === 'Backend Engineer' && r.body.doc.stale === true && r.body.doc.jobInput === null,
      { hashed, jobInput: r.body.doc.jobInput });
    RBC.currentResumeFingerprint = realFp;
    Object.assign(docs, realDocs);
  }

  // ⚠️ THE COUNTRY IS NOT IN THE FINGERPRINT — AND `stale` IS THE ONLY DOOR TO A REBUILD.
  // The country must never be hashed (it would turn every stored document stale and re-bill its owner), so an
  // American résumé asked about from a German chip re-hashes to a PERFECT match and reports fresh. The build
  // already refuses to serve that row as a free hit; before 2026-09-17 nothing told the SCREEN, so the Refresh
  // pill (drawn on `stale`) never appeared and the Tailor button (drawn only with no document at all) never did
  // either — the user saw the wrong country's résumé and could not even pay to replace it. The route asks the
  // document's own marker beside the hash: written elsewhere ⇒ stale.
  {
    const RBC = require(path.join(ROOT, 'server/controllers/resumeBuilderController.js'));
    const realFp = RBC.currentResumeFingerprint;
    RBC.currentResumeFingerprint = async () => 'fp-SAME';        // the hash ALWAYS matches: only the marker can speak
    const rowFor = (writtenFor) => ({
      id: 44, kind: 'resume', employer_name: 'Acme', employer_id: null, job_url: '', job_title: '',
      created_at: new Date(), updated_at: new Date(), edited_at: null, input_fingerprint: 'fp-SAME',
      payload: { personal_info: { title: 'Engineer' } }, research: null,
      design: writtenFor ? { v: 1, kind: 'resume', ranked: [], writtenFor } : null, job_input: null,
    });
    const currentWith = async (writtenFor, body) => {
      docs.currentFor = async () => rowFor(writtenFor);
      const res = await callRoute('post', '/current', { body: { kind: 'resume', employer: 'Acme', jobUrl: '', ...body } });
      return res.body && res.body.doc ? res.body.doc.stale : null;
    };
    ok('⚠️ a résumé written for the US, asked about from a German chip, is STALE — the hash alone says fresh',
      (await currentWith('us', { country: 'Germany' })) === true);
    ok('…the same document for its OWN country is not stale (no nag, no paid rebuild nobody needed)',
      (await currentWith('us', { country: 'United States' })) === false);
    ok('⚠️ a row with NO marker (every document built before this existed) is never stale on country grounds',
      (await currentWith(null, { country: 'Germany' })) === false);
    ok('⚠️ a request that names no country cannot tell, and "cannot tell" never bills anyone',
      (await currentWith('us', {})) === false);
    ok('…the website stands in for a missing country the same way the BUILD reads it (.de ⇒ Germany)',
      (await currentWith('us', { website: 'https://acme.de' })) === true);
    // The label must give the answer the BUILD gives — one implementation, one place (docWrittenElsewhere).
    ok('⚠️ the route asks the controller\'s own predicate, never a second copy of the rule',
      RBC.docWrittenElsewhere(rowFor('us'), { employer: 'Acme', country: 'Germany', job: {} }) === true
      && RBC.docWrittenElsewhere(rowFor('us'), { employer: 'Acme', country: 'United States', job: {} }) === false);
    {
      const realPredicate = RBC.docWrittenElsewhere;
      RBC.docWrittenElsewhere = () => { throw new Error('boom'); };
      ok('⚠️ a throw in the marker check costs nothing — the fingerprint compare underneath it still answers',
        (await currentWith('us', { country: 'Germany' })) === false);
      RBC.docWrittenElsewhere = realPredicate;
    }
    RBC.currentResumeFingerprint = realFp;
    Object.assign(docs, realDocs);
  }

  // ⚠️ A STORED DESIGN IS RE-RANKED ON READ (rerankStoredDesign → designFit.rerankDesign), and that NEVER TOUCHES
  // `stale`. A document built when every employer got exec_pro first gets the employer-first order for free — never a
  // paid Refresh just to fix an ordering — and a better order is not a changed document.
  {
    const RBC = require(path.join(ROOT, 'server/controllers/resumeBuilderController.js'));
    const T = require(path.join(ROOT, 'server/utils/resumeTemplates.js'));
    const famOf = (id) => (T.TEMPLATES.find((t) => t.id === id) || {}).family;
    const realFp = RBC.currentResumeFingerprint;
    let fpNow = 'fp-X';
    RBC.currentResumeFingerprint = async () => fpNow;
    const swiss = { hqCountry: 'Switzerland', roleCountry: 'Switzerland', employerType: 'sme', sector: 'Precision engineering', atsVendor: null, tone: 'formal',
      cv: { photo: 'expected', length: 'two_pages', personalDetails: 'include', dateFormat: null, format: 'tabular', notes: [] }, sources: [] };
    const storedDesign = fit.rankResumeDesigns({ aiFamilyScores: { exec_pro: { score: 80 }, executive: { score: 72 } }, region: 'generic', seniorityYears: 20, mode: 'a4' });
    const row = {
      id: 31, kind: 'resume', employer_name: 'Acme AG', employer_id: null, job_url: '', job_title: '', created_at: new Date(), updated_at: new Date(), edited_at: null,
      input_fingerprint: 'fp-X', job_input: { title: '', url: '', description: '', website: 'https://acme-ag.ch' },
      payload: { personal_info: { title: 'Engineer' }, experience: [{ role: 'Lead', company: 'X', start_date: 'January 2005', end_date: 'Present' }] },
      research: { domain: 'acme-ag.ch', employerName: 'Acme AG', industry: 'Precision engineering', companySize: '51-200 employees', conventions: swiss },
      design: JSON.parse(JSON.stringify(storedDesign)),
    };
    const before = JSON.stringify(row.design);
    docs.currentFor = async () => row;
    docs.getById = async () => row;
    r = await callRoute('post', '/current', { body: { kind: 'resume', employer: 'Acme AG', jobUrl: '' } });
    const cur = r.body && r.body.doc;
    ok('(the stored design is the prod-like exec order)', ['exec_pro', 'executive'].includes(famOf(storedDesign.ranked[0].id)));
    ok('⚠️ /current shows the stored design RE-RANKED for the employer (Swiss conventions → the German CV)',
      r.statusCode === 200 && cur && cur.design && famOf(cur.design.ranked[0].id) === 'germany' && cur.design.ranked.length === RIDS.length, cur && cur.design && cur.design.ranked.slice(0, 3));
    ok('⚠️ …and stale is still the fingerprint\'s answer alone (false), with the build\'s page mode kept', cur && cur.stale === false && cur.design.mode === 'a4', cur && { stale: cur.stale, mode: cur.design.mode });
    ok('⚠️ …nothing is written back: the row\'s design is untouched, no UPDATE went out',
      JSON.stringify(row.design) === before && !db.log.some((e) => /^UPDATE user_employer_documents SET design/.test(e.sql)));
    ok('…it is the controller\'s one answer (home-cards ?doc= reads the same)', JSON.stringify(cur.design) === JSON.stringify(RBC.rerankStoredResumeDesign(row)));
    fpNow = 'fp-Y';
    r = await callRoute('post', '/current', { body: { kind: 'resume', employer: 'Acme AG', jobUrl: '', country: 'United States', website: 'https://acme.com' } });
    ok('⚠️ a changed input is stale — and the re-rank does not decide that either way', r.body.doc.stale === true, r.body.doc.stale);
    ok('⚠️ the order comes from the ROW, never the client\'s country/website (one document, one order on every screen)',
      JSON.stringify(r.body.doc.design) === JSON.stringify(cur.design));
    r = await callRoute('get', '/:id', { params: { id: '31' } });
    ok('GET /:id gives the same re-ranked design', r.statusCode === 200 && JSON.stringify(r.body.doc.design) === JSON.stringify(cur.design));
    const realRerank = fit.rerankDesign;
    fit.rerankDesign = () => { throw new Error('boom'); };
    fpNow = 'fp-X';
    r = await callRoute('post', '/current', { body: { kind: 'resume', employer: 'Acme AG', jobUrl: '' } });
    ok('a re-rank that throws → the stored design stands (repaired), never a failed /current',
      r.statusCode === 200 && r.body.doc.design && r.body.doc.design.ranked[0].id === storedDesign.ranked[0].id && r.body.doc.stale === false, r.body);
    fit.rerankDesign = realRerank;
    const edrSrc = strip(R('server/routes/employerDocsRoutes.js'));
    ok('the routes\' staleFor never reads the design', fnBody(edrSrc, 'staleFor').length > 200 && !/design|rerank/i.test(fnBody(edrSrc, 'staleFor')));
    RBC.currentResumeFingerprint = realFp;
    Object.assign(docs, realDocs);
  }

  // ⚠️ THE STORED LETTER IS LOADED INTO THE SERVER'S CHROMIUM (the PDF, and the Home thumbnail). The
  // renderer's old blacklist let an <iframe src="http://169.254.169.254/…">, an <img>, a <link> and a
  // <meta refresh> straight through, and the thumbnail then showed the user an internal page. The PUT
  // normalises to a CLOSED grammar instead: escaped text plus nine attribute-free tags, nothing else.
  {
    const cleanLetter = edr.normaliseLetterHtml;
    const attacks = [
      ['<script>fetch("http://169.254.169.254/")</script>', 'script'],
      ['<script>x</script >', 'a space before the closing > (the old regex missed this one)'],
      ['<iframe src="http://127.0.0.1:9/admin"></iframe>', 'iframe'],
      ['<img src="http://127.0.0.1:9/pixel.png">', 'img'],
      ['<link rel="prefetch" href="http://127.0.0.1:9/x">', 'link'],
      ['<meta http-equiv="refresh" content="0;url=http://127.0.0.1:9/">', 'meta refresh'],
      ['<object data="http://127.0.0.1:9/x"></object>', 'object'],
      ['<svg><image href="http://127.0.0.1:9/x"/></svg>', 'svg'],
      ['<style>body{background:url(http://127.0.0.1:9/x)}</style>', 'style'],
      ['<p onclick="alert(1)" style="background:url(http://127.0.0.1:9/x)">Dear team</p>', 'an attribute on an allowed tag'],
      ['<a href="javascript:alert(1)">click</a>', 'javascript: href'],
    ];
    const leaks = attacks.filter(([html]) => {
      const outHtml = cleanLetter(html);
      return /<(script|iframe|img|link|meta|object|svg|style|a|frame|embed|video|audio)\b/i.test(outHtml)
        || /127\.0\.0\.1|169\.254|javascript:|on[a-z]+\s*=|url\(/i.test(outHtml);
    });
    ok('⚠️ the letter PUT allowlist keeps NO script, iframe, img, link, meta, url or attribute',
      leaks.length === 0, leaks.map(([h, why]) => why + ' → ' + cleanLetter(h)));
    ok('⚠️ …and the letter itself survives: text, paragraphs, bold, italics and lists',
      cleanLetter('<p>Dear <strong>Amazon</strong>,</p><ul><li>I built <em>ledgers</em></li></ul>')
        === '<p>Dear <strong>Amazon</strong>,</p><ul><li>I built <em>ledgers</em></li></ul>'
      && cleanLetter('<div><span>Kind regards</span></div>') === 'Kind regards'
      && cleanLetter('A & B < C') === 'A &amp; B &lt; C' && cleanLetter('caf&eacute;') === 'caf&eacute;',
      [cleanLetter('<div><span>Kind regards</span></div>'), cleanLetter('A & B < C')]);
    ok('⚠️ …and a letter left with no text at all is refused, never stored empty',
      edr.letterHasText('<p>&nbsp;</p>') === false && edr.letterHasText('<p>Dear team</p>') === true);
  }

  console.log('── ⚠️ the doc thumbs are NOT served by express.static(\'uploads\') ──');
  {
    const express = require(path.join(ROOT, 'node_modules/express'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cva-dotdir-'));
    fs.mkdirSync(path.join(tmp, 'uploads', '.thumb_cache', '5'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'uploads', 'user_5'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'uploads', '.thumb_cache', '5', 'abc.jpg'), 'SECRET-THUMB');
    fs.writeFileSync(path.join(tmp, 'uploads', 'user_5', 'photo.jpg'), 'PUBLIC-PHOTO');
    const app = express();
    // server.js: app.use('/uploads', express.static('uploads', …)) — resolved against the cwd.
    app.use('/uploads', express.static(path.join(tmp, 'uploads'), { maxAge: '7d', etag: true }));
    app.use((req, res) => res.status(404).send('fallthrough'));
    const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const port = srv.address().port;
    const get = (p) => new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', (e) => resolve({ status: 'ERR', body: e.message })));
    const pub = await get('/uploads/user_5/photo.jpg');
    ok('control: a normal upload IS served', pub.status === 200 && /PUBLIC/.test(pub.body), pub.status);
    for (const p of ['/uploads/.thumb_cache/5/abc.jpg', '/uploads/%2Ethumb_cache/5/abc.jpg', '/uploads/user_5/../.thumb_cache/5/abc.jpg', '/uploads/user_5/..%2F.thumb_cache%2F5%2Fabc.jpg']) {
      const got = await get(p);
      ok('⚠️ not served: ' + p, got.status !== 200 && !/SECRET/.test(got.body), got.status);
    }
    srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ⚠️ express.static ANSWERS THE TRAVERSAL 403 AND FALLS THROUGH TO OUR OWN ROUTE, which used to
  // path.join the DECODED param — so /uploads/user_5/..%2F..%2Fserver.js arrived as "../../server.js"
  // and served the app's own source (or another user's uploads) to any authenticated caller. The guard
  // is run here EXACTLY as server.js writes it, against what express really hands a route.
  {
    const srvSrc = R('server.js');
    const guardSrc = (srvSrc.match(/const userDir = path\.resolve\(__dirname, 'uploads', `user_\$\{req\.user\.id\}`\);[\s\S]{0,700}?return res\.status\(404\)\.json\(\{ error: 'File not found' \}\);\s*\}/) || [])[0];
    ok('⚠️ the uploads route builds the directory from the VERIFIED id and refuses a non-bare name',
      !!guardSrc && /const filename = path\.basename\(String\(req\.params\.filename \|\| ''\)\)/.test(guardSrc)
      && /path\.dirname\(filePath\) !== userDir/.test(guardSrc), guardSrc && guardSrc.slice(0, 120));
    // What express ACTUALLY puts in req.params for each of these (it decodes), fed through that guard.
    const express = require(path.join(ROOT, 'node_modules/express'));
    const app = express();
    const run = guardSrc ? new Function('path', '__dirname', 'req', 'res', `${guardSrc}\n return { served: filePath };`) : null;
    const served = [];
    app.get('/uploads/:userId/:filename', (req, res) => {
      const stub = { status: () => ({ json: () => ({ refused: true }) }) };
      let out;
      try { out = run(path, ROOT, { ...req, user: { id: 5 } }, stub); } catch (e) { out = { threw: e.message }; }
      served.push({ raw: req.params.filename, out });
      res.end('ok');
    });
    app.use((req, res) => { served.push({ raw: null, out: { unrouted: true } }); res.end('nf'); });
    const srv2 = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const port2 = srv2.address().port;
    const hit = (p) => new Promise((resolve) => http.get({ host: '127.0.0.1', port: port2, path: p }, (res) => { res.resume(); res.on('end', resolve); }).on('error', resolve));
    for (const p of ['/uploads/user_5/..%2F..%2Fserver.js', '/uploads/user_5/..%2F..%2F.env', '/uploads/user_5/%2e%2e%2fuser_6%2fphoto.jpg', '/uploads/user_5/photo.jpg']) await hit(p);
    srv2.close();
    // basename() throws the directory half away and the containment check catches whatever it cannot:
    // either way the path READ is inside this user's own folder, so the worst case is a 404 for a file
    // that is not there — never server.js, never .env, never user_6's photo.
    const own = path.resolve(ROOT, 'uploads', 'user_5');
    const escapes = served.slice(0, 3);
    ok('⚠️ no encoded traversal can read outside the signed-in user\'s own folder, though express decoded it',
      escapes.length === 3 && escapes.every((e) => /\.\./.test(String(e.raw))
        && e.out && (e.out.refused === true || path.dirname(String(e.out.served)) === own)),
      served.map((e) => [e.raw, e.out]));
    ok('…so the app\'s own source, its .env and another user\'s folder are never the path that gets read',
      escapes.every((e) => e.out.refused === true
        || ![path.join(ROOT, 'server.js'), path.join(ROOT, '.env'), path.resolve(ROOT, 'uploads', 'user_6', 'photo.jpg')].includes(String(e.out.served))),
      escapes.map((e) => e.out));
    const normal = served[3];
    ok('…while a real file name still resolves to that same folder', normal && typeof normal.out.served === 'string' && path.dirname(normal.out.served) === own, normal);
    // The cover-letter download takes the stricter road (it can afford to: every legitimate name there
    // is one we generated), and refuses a name that is not already bare rather than silently reducing it.
    ok('⚠️ the cover-letter download REFUSES a non-bare name outright',
      /const filename = path\.basename\(req\.params\.filename \|\| ''\);\s*if \(!filename \|\| filename !== req\.params\.filename\) \{\s*return res\.status\(400\)/.test(srvSrc));
  }

  // ⚠️ EVERY DOC THUMBNAIL IS A RENDERED PAGE OF THIS USER'S RESUME — photo, name, email, phone — and
  // they live OUTSIDE uploads/user_N, so deleting the account left all of them on the volume.
  {
    const srvSrc = R('server.js');
    const del = srvSrc.slice(srvSrc.indexOf('[ACCOUNT DELETE] Soft-deleted cover letters'), srvSrc.indexOf('ACCOUNT_DELETED'));
    ok('⚠️ account deletion also removes the employer-document thumbnails, under both roots',
      /const thumbRoots = \[path\.join\(__dirname, 'uploads', '\.thumb_cache'\)\]/.test(del)
      && /if \(process\.env\.DOC_THUMB_CACHE_DIR\) thumbRoots\.push\(path\.resolve\(process\.env\.DOC_THUMB_CACHE_DIR\)\)/.test(del)
      && /await fs\.rm\(path\.join\(root, thumbUserDir\), \{ recursive: true, force: true \}\)/.test(del));
    ok('⚠️ …and the directory name comes from the token\'s integer id, so it cannot leave the cache root',
      /const thumbUserDir = String\(parseInt\(userId, 10\)\)/.test(del) && /\/\^\\d\+\$\/\.test\(thumbUserDir\) && thumbUserDir !== '0'/.test(del));
  }

  console.log('── ⚠️ re-download of a document re-renders THAT document ──');
  const dl = strip(R('server/routes/downloads.js'));
  ok('a resume history row forwards its docId', /employer: row\.employer_name \|\| null,\s*docId: p\.docId \|\| undefined,/.test(dl));
  ok('a letter with a docId goes to the handler by id, the frozen html only when the doc is gone',
    /if \(p\.docId\) \{[\s\S]{0,300}getById\(req\.user\.id, p\.docId, req, \{ kind: 'cover_letter' \}\)[\s\S]{0,200}if \(doc \|\| !p\.coverLetterHtml\)/.test(dl));

  console.log('── ⚠️ THE NAME THE USER PICKED WINS (Amazon, not "Souq.com for E-Commerce LLC") ──');
  const jobService = require(path.join(ROOT, 'server/services/jobService.js'));
  const shared = { id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'Souq.com for E-Commerce LLC', sub_info: null, logo_color: null };
  const runTrack = async (row, args) => {
    txLog.length = 0;
    tx.answer = (q) => {
      if (/^SELECT id, name, sub_info, logo_color FROM employers WHERE domain = \$1/.test(q)) return row;
      if (/^SELECT COUNT\(\*\)::int AS n, COALESCE\(bool_or/.test(q)) return { n: 0, already: false };
      if (/^SELECT COUNT\(\*\)::int AS n FROM user_tracked_employers ute/.test(q)) return { n: 0 };
      if (/^INSERT INTO employers/.test(q)) return { rows: [{ id: 'new-id', name: args.name, sub_info: null, logo_color: null }] };
      return null;
    };
    return jobService.trackEmployerForUser(7, args, { maxWatching: 60, maxInsertsPerDay: 20 });
  };
  const t1 = await runTrack({ ...shared }, { domain: 'amazon.jobs', name: 'Amazon', displayName: 'Amazon', logoColor: ['#000', '#111'], logoInitial: 'A' });
  const ute = txLog.find((e) => /^INSERT INTO user_tracked_employers/.test(e.sql));
  ok('the per-user row writes display_name on insert AND on conflict (never wiped by a nameless call)',
    ute && /\(user_id, employer_id, status, display_name, created_at\)/.test(ute.sql)
    && /display_name = COALESCE\(EXCLUDED\.display_name, user_tracked_employers\.display_name\)/.test(ute.sql)
    && ute.params[2] === 'Amazon', ute);
  ok('…and a re-add sets it watching again (Undo restores an archived employer)', ute && /DO UPDATE SET status = 'watching'/.test(ute.sql));
  // ⚠️ ADDING AN EMPLOYER ON HOME NEVER RENAMES THE SHARED ROW — NOT EVEN A "GUARDED REPAIR".
  // The repair let ANY signed-in user set a shared name for everyone (a URL-shaped "amazon.jobs/…"
  // passes the alias test and nobody could change it back), and every other user whose chip still fell
  // back to employers.name got a new chip name AND a new pass/cache key from someone else's add.
  // The pick lives in THIS user's display_name; the scrape side is guarded by keepStoredEmployerName.
  ok('⚠️ Home\'s Add renames the SHARED employers row for NOBODY',
    !txLog.some((e) => /^UPDATE employers SET name/.test(e.sql)), txLog.map((e) => e.sql.slice(0, 60)));
  ok('⚠️ …not even in the source: trackEmployerForUser holds no employers rename at all',
    !/UPDATE employers SET name/.test(fnBody(strip(R('server/services/jobService.js')), 'trackEmployerForUser')));
  ok('returns { row, inserted, displayName } — the pick as the display name, the STORED row untouched',
    t1 && t1.displayName === 'Amazon' && t1.row.name === shared.name && t1.inserted === false, t1);
  ok('re-adding un-hides the employer\'s Home chip in the same transaction',
    txLog.some((e) => /^DELETE FROM user_home_hidden_targets WHERE user_id = \$1 AND target_key = 'emp_' \|\| \$2::text/.test(e.sql) && e.params[1] === shared.id));
  ok('the watching cap is still enforced under the advisory lock', /pg_advisory_xact_lock/.test(txLog[0].sql));
  await runTrack({ id: 'b0000000-0000-4000-8000-000000000002', name: 'Tata Consultancy Services', sub_info: null, logo_color: null }, { domain: 'tcs.com', name: 'TCS', displayName: 'TCS', logoColor: ['#0', '#1'], logoInitial: 'T' });
  ok('⚠️ an abbreviation never renames a correctly named shared row (TCS on tcs.com)', !txLog.some((e) => /^UPDATE employers SET name/.test(e.sql)));
  await runTrack({ id: 'c0000000-0000-4000-8000-000000000003', name: 'Nordex SE', sub_info: null, logo_color: null }, { domain: 'nordex-online.com', name: 'Totally Other', displayName: 'Totally Other', logoColor: ['#0', '#1'], logoInitial: 'T' });
  ok('a picked name that does not own the host renames nothing (it is only this user\'s display name)', !txLog.some((e) => /^UPDATE employers SET name/.test(e.sql)));
  const jsC = strip(R('server/services/jobService.js'));
  ok('the insert path is still insert-if-absent and never looks scraped', /ON CONFLICT \(domain\) DO NOTHING/.test(jsC) && /last_scraped_at, created_at\)\s*VALUES \(\$1, \$2, NULL, \$3, \$4, NULL/.test(jsC));
  const dash = fnBody(jsC, 'getUserDashboard');
  ok('the dashboard reads ute.display_name and shows it first', /ute\.display_name/.test(dash) && /\(emp\.display_name && String\(emp\.display_name\)\.trim\(\)\) \|\| emp\.name/.test(dash));
  ok('…while websiteOf still vets the domain with the STORED name', /websiteOf\(emp\.domain, emp\.name\)/.test(dash));
  ok('getJobFull prefers this user\'s display name', /LEFT JOIN user_tracked_employers ute ON ute\.employer_id = j\.employer_id AND ute\.user_id = \$2/.test(fnBody(jsC, 'getJobFull')) && /emp_display_name/.test(fnBody(jsC, 'getJobFull')));

  // ⚠️ A RENAME MOVES THIS USER'S PASS WITH IT, OR THEY PAY TWICE. A pass binds to employerKeyOf(the
  // chip's name): renaming the chip made the pass bought under the old name invisible to the new one.
  {
    txLog.length = 0;
    tx.answer = (q) => {
      if (/^SELECT id, name, sub_info, logo_color FROM employers WHERE domain = \$1/.test(q)) return { ...shared };
      if (/^SELECT COUNT\(\*\)::int AS n, COALESCE\(bool_or/.test(q)) return { n: 1, already: true };
      if (/^SELECT display_name FROM user_tracked_employers WHERE user_id/.test(q)) return { display_name: 'Souq.com for E-Commerce LLC' };
      if (/^SELECT COALESCE\(NULLIF\(BTRIM\(ute\.display_name/.test(q)) return [];   // no other chip shows the old name
      if (/^UPDATE download_passes SET employer_key/.test(q)) return { changes: 2 };
      return null;
    };
    await jobService.trackEmployerForUser(7, { domain: 'amazon.jobs', name: 'Amazon', displayName: 'Amazon', logoColor: ['#0', '#1'], logoInitial: 'A' }, { maxWatching: 60, maxInsertsPerDay: 20 });
    const moved = txLog.find((e) => /^UPDATE download_passes SET employer_key = \$1, employer_name = \$2/.test(e.sql));
    ok('⚠️ renaming a chip rebinds the passes bound under the old name, in the SAME transaction',
      !!moved && moved.params[1] === 'Amazon' && moved.params[2] === 7
      && moved.params[3] === downloads.employerKeyOf('Souq.com for E-Commerce LLC')
      && /bound_at IS NOT NULL/.test(moved.sql), moved && moved.params);
    ok('…under its own SAVEPOINT, so a pre-046 database still completes the add',
      txLog.some((e) => /^SAVEPOINT track_pass_rebind/.test(e.sql)));
  }
  {
    const reb = fnBody(jsC, 'rebindPassesForRename');
    ok('⚠️ nothing moves when the two names are the same company, or another watched chip still shows the old one',
      /sameEmployer\(oldName, newName\)\) return 0;/.test(reb) && /oldKey === dl\.NONE \|\| newKey === dl\.NONE \|\| oldKey === newKey/.test(reb)
      && /some\(\(r\) => r && r\.shown && dl\.sameEmployer\(r\.shown, oldName\)\)/.test(reb));
  }

  // ⚠️ MIGRATION 046 RUNS WHILE THE SERVER IS ALREADY TAKING TRAFFIC. Every read and write that needs
  // its columns has a pre-046 fallback on 42703/42P01, or the first minute of a deploy 500s.
  ok('⚠️ a missing display_name column is survivable everywhere it is read or written',
    /const isMissingSchema = \(e\) => !!e && \(e\.code === '42703' \|\| e\.code === '42P01'\);/.test(jsC)
    && /if \(!isMissingSchema\(e\)\) throw e;/.test(fnBody(jsC, 'trackUserEmployer'))
    && /if \(!e \|\| e\.code !== '42703'\) throw e;/.test(dash)
    && /if \(!e \|\| e\.code !== '42703'\) throw e;/.test(fnBody(jsC, 'getJobFull'))
    && /if \(!isMissingSchema\(e\)\) throw e;/.test(fnBody(jsC, 'withSavepoint'))
    && /ROLLBACK TO SAVEPOINT/.test(fnBody(jsC, 'withSavepoint')));
  ok('⚠️ …and each 046 statement in the add sits in its own SAVEPOINT, so one missing column is not a failed add',
    ['track_display_name', 'track_pass_rebind', 'track_unhide'].every((n) => new RegExp(`withSavepoint\\(tx, '${n}'`).test(fnBody(jsC, 'trackEmployerForUser'))));

  // ⚠️ THE FROZEN NAME IS WHAT KEEPS ANOTHER USER'S ADD OFF THIS USER'S CHIP (and their billing key).
  // A search-tracked row freezes employers.name into display_name at track time, and COALESCE keeps a
  // name the USER picked: EXCLUDED must never overwrite an existing pick.
  {
    const track = fnBody(jsC, 'trackUserEmployer');
    ok('⚠️ trackUserEmployer freezes the stored name into display_name, and never overwrites a pick',
      /display_name\)\s*VALUES \(\$1, \$2, 'watching', \(SELECT e\.name FROM employers e WHERE e\.id = \$2::uuid\)\)/.test(track)
      && /display_name = COALESCE\(user_tracked_employers\.display_name, EXCLUDED\.display_name\)/.test(track));
  }

  // ⚠️ THE SOUQ.COM BUG WAS A SCRAPE, AND THE SCRAPE PATH IS WHERE IT COMES BACK. Any Job Hub search of
  // amazon.jobs read a posting's legal entity and wrote it over "Amazon" for every user, on every search,
  // undoing any hand repair. A stored name that OWNS the host is kept against one that does not.
  ok('⚠️ keepStoredEmployerName: the owning stored name wins, junk is still replaceable',
    jobService.keepStoredEmployerName('Amazon', 'Souq.com for E-Commerce LLC', 'amazon.jobs') === true
    && jobService.keepStoredEmployerName('Back ButtonSearch Icon', 'Nordex SE', 'nordex-online.com') === false
    && jobService.keepStoredEmployerName('Amazon', 'Amazon', 'amazon.jobs') === false
    && jobService.keepStoredEmployerName('https://amazon.jobs/x', 'Amazon', 'amazon.jobs') === false);
  ok('⚠️ …and BOTH scrape writers consult it: upsertEmployer\'s ON CONFLICT and processJobSearch\'s AI override',
    /keepStoredEmployerName\(cur\.name, name, domain\)/.test(fnBody(jsC, 'upsertEmployerWithName'))
    && /name = CASE WHEN employers\.name = \$6::text THEN employers\.name ELSE EXCLUDED\.name END/.test(fnBody(jsC, 'upsertEmployerWithName'))
    && /keepStoredEmployerName\(cur\.name, aiName, domain\)/.test(fnBody(jsC, 'applyScrapedEmployerName'))
    && /return cur\.name;/.test(fnBody(jsC, 'applyScrapedEmployerName')));
  ok('⚠️ …and an AI override that DOES apply moves only THIS user\'s frozen name, and their passes with it',
    /UPDATE user_tracked_employers SET display_name = \$1\s*WHERE user_id = \$2 AND employer_id = \$3 AND display_name = \$4/.test(fnBody(jsC, 'applyScrapedEmployerName'))
    && /rebindPassesForRename\(tx, userId, employerId, cur\.name, aiName\)/.test(fnBody(jsC, 'applyScrapedEmployerName')));

  console.log('── the add/untrack/hide handlers ──');
  const hub = require(path.join(ROOT, 'server/controllers/aiHubController.js'));
  const realTrack = jobService.trackEmployerForUser;
  const realArchive = jobService.archiveUserEmployer;
  jobService.trackEmployerForUser = async (uid, args) => ({ row: { id: shared.id, name: 'Souq.com for E-Commerce LLC', sub_info: '', logo_color: null }, inserted: false, displayName: args.displayName });
  reset();
  db.answer = (q) => (/SELECT role FROM users/.test(q) ? { role: 'user' } : null);
  let res = mkRes();
  await hub.trackEmployer({ user: { id: 7001 }, body: { name: 'Amazon', website: 'https://amazon.jobs' }, headers: {}, ip: '1.1.1.1' }, res);
  ok('⚠️ trackEmployer answers with the name the user picked, and its initial', res.statusCode === 200 && res.body.employer.name === 'Amazon' && res.body.employer.logoInitial === 'A', res.body);
  let archived = [];
  jobService.archiveUserEmployer = async (uid, eid) => { archived.push([uid, eid]); return true; };
  reset();
  res = mkRes();
  await hub.untrackEmployer({ user: { id: 7 }, params: { employerId: shared.id }, headers: {} }, res);
  ok('untrack archives this user\'s row → { success, archived }', res.statusCode === 200 && res.body.success === true && res.body.archived === true && archived.length === 1 && archived[0][1] === shared.id, res.body);
  ok('⚠️ …and never deletes anything', !db.log.some((e) => /^DELETE/.test(e.sql)));
  res = mkRes();
  await hub.untrackEmployer({ user: { id: 7 }, params: { employerId: 'emp_1' }, headers: {} }, res);
  ok('a non-UUID is refused before any query', res.statusCode === 400 && archived.length === 1, res.body);
  jobService.archiveUserEmployer = realArchive;
  jobService.trackEmployerForUser = realTrack;
  reset();
  db.answer = (q) => (/^UPDATE user_tracked_employers SET status = 'archived'/.test(q) ? { changes: 1 } : null);
  ok('archiveUserEmployer is an UPDATE to archived that stamps updated_at', (await jobService.archiveUserEmployer(7, shared.id)) === true
    && /^UPDATE user_tracked_employers SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE user_id = \$1 AND employer_id = \$2/.test(db.log[0].sql));
  reset();
  db.answer = (q) => (/^SELECT target_key FROM user_home_hidden_targets/.test(q) ? [{ target_key: 'job_https://x.test/1' }] : null);
  res = mkRes(); await hub.getHiddenTargets({ user: { id: 7 }, headers: {} }, res);
  ok('GET hidden-targets → { success, keys }, scoped to the user', res.body.success === true && res.body.keys[0] === 'job_https://x.test/1' && db.log[0].params[0] === 7, res.body);
  reset();
  res = mkRes(); await hub.hideHomeTarget({ user: { id: 7 }, body: { key: 'job_https://x.test/1' }, headers: {}, query: {} }, res);
  ok('POST hides with an upsert and trims to the newest 500', res.body.success === true
    && /ON CONFLICT \(user_id, target_key\) DO UPDATE SET hidden_at = NOW\(\)/.test(db.log[0].sql) && /OFFSET 500/.test(db.log[1].sql), db.log.map((e) => e.sql));
  reset();
  res = mkRes(); await hub.hideHomeTarget({ user: { id: 7 }, body: { key: 'x'.repeat(301) }, headers: {}, query: {} }, res);
  ok('a key over 300 chars is refused with no write', res.statusCode === 400 && db.log.length === 0, res.body);
  res = mkRes(); await hub.unhideHomeTarget({ user: { id: 7 }, body: { key: 'job_https://x.test/1' }, headers: {}, query: {} }, res);
  ok('DELETE un-hides exactly that key for that user', res.body.success === true && /^DELETE FROM user_home_hidden_targets WHERE user_id = \$1 AND target_key = \$2/.test(db.log[0].sql) && db.log[0].params[1] === 'job_https://x.test/1');
  const hubRoutes = require(path.join(ROOT, 'server/routes/aiHub.js'));
  const hubLayers = hubRoutes.stack.filter((l) => l.route).map((l) => ({ m: Object.keys(l.route.methods)[0], p: l.route.path, auth: l.route.stack[0].handle === auth.authenticateToken }));
  for (const [m, p] of [['post', '/employers/:employerId/untrack'], ['get', '/home/hidden-targets'], ['post', '/home/hidden-targets'], ['delete', '/home/hidden-targets']]) {
    ok(`router: ${m.toUpperCase()} ${p} behind auth`, hubLayers.some((l) => l.m === m && l.p === p && l.auth));
  }
  const hubC = strip(R('server/controllers/aiHubController.js'));
  const trackFn = fnBody(hubC, 'trackEmployer');
  ok('⚠️ trackEmployer still never renames a shared row itself or starts the paid pipeline', !/upsertEmployer|processJobSearch|createJob/.test(trackFn));
  ok('discoverController exports ownsHost', typeof require(path.join(ROOT, 'server/controllers/discoverController.js')).ownsHost === 'function');

  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  // ⚠️ 2026-09-18 — A BUSY MODEL. User 1 built Amazon's letter from Home → Cover letters and production logged two
  // 503 "This model is currently experiencing high demand" from gemini-2.5-flash, 0 ms apart, then "That cover
  // letter didn't finish". Every lane asked ONE model, back to back. The research and the LEGACY letter lanes (the
  // Letters screen, Job Hub, batch-process, bulk) now go through aiText.generateText: a paused second try, the
  // verified fallback chain, a per-attempt cap that aborts, one budget. What is pinned here:
  //   - a 503 storm on the primary still produces the letter / the conventions, via a FALLBACK, charged once;
  //   - every model busy → HTTP 503 ai_busy, NOTHING charged, nothing handed over, the job and the flight released;
  //   - quota → ai_down, nothing charged, one call (every model shares the key), the operator paged;
  //   - what a fallback wrote is the same cache row as what the primary wrote (a later build reads it for free),
  //     and no model id reaches anything stored; RESEARCH_REV / LETTER_REV / FP_VERSION unchanged;
  //   - a research failure is still "no research", never a failed build — and BUSY is remembered for minutes.
  // TWO CHAINS (since the measured writing chain, 2026-09-18 — aiText WRITING_PRIMARY):
  //   - RESEARCH (conventions, base facts) keeps its own model + aiText.fallbackModels():
  //     gemini-2.5-flash → gemini-2.5-flash-lite → gemini-3.1-flash-lite (PRIMARY / LITE / LITE3 below).
  //   - the LEGACY LETTER is a document lane: it walks aiText.writing() — models aiText.writingChain() (W_PRIMARY /
  //     W_FB1 / W_FB2 below, read from the module, never re-typed here) plus modelConfig, which turns thinking OFF
  //     for gemini-2.5-flash only. LEGACY_LETTER_MODEL (gemini-2.5-flash) is no longer that lane's first model.
  // No network: the SDK is a fake keyed on the MODEL (require.cache, which aiText reads on every call), the
  // researcher, the website read, the push and the admin pager are stubbed, and aiText's pause is shrunk to 0.
  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log('── ⚠️ 2026-09-18: a BUSY model — research and the LEGACY letter lanes survive it through aiText ──');
  {
    const aiText = require(path.join(ROOT, 'server/services/aiText.js'));
    const CL = require(path.join(ROOT, 'server/controllers/coverLetterController.js'));
    const v2 = require(path.join(ROOT, 'ai-cover-letter-v2.js'));
    const researcher = require(path.join(ROOT, 'ai-employer-researcher.js'));
    const entM = require(path.join(ROOT, 'server/services/entitlements.js'));
    const jobM = require(path.join(ROOT, 'server/services/jobService.js'));
    const pushM = require(path.join(ROOT, 'server/services/expoPushService.js'));
    const CLI = CL._internals || {};
    const PRIMARY = 'gemini-2.5-flash', LITE = 'gemini-2.5-flash-lite', LITE3 = 'gemini-3.1-flash-lite';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ── the world, saved so every stub can be put back ──
    const saved = {
      settings: { ...aiText._internals.settings }, fallbackEnv: process.env.AI_TEXT_FALLBACK_MODELS, asyncEnv: process.env.USE_ASYNC_JOBS,
      writingEnv: process.env.AI_WRITING_MODEL, writingFbEnv: process.env.AI_WRITING_FALLBACK_MODELS, gen: aiText.generateText,
      rc: er.researchConventions, rb: er.researchBrand, gf: er.googleFontCheck, re: researcher.researchEmployer,
      canConsumeMany: entM.canConsumeMany, consumeOnSuccess: entM.consumeOnSuccess,
      resolveEmployer: downloads.resolveEmployer, passCoversGeneration: downloads.passCoversGeneration, claimGeneration: downloads.claimGeneration,
      job: { createJob: jobM.createJob, startJob: jobM.startJob, updateJobProgress: jobM.updateJobProgress, updateJobPartialResult: jobM.updateJobPartialResult, completeJob: jobM.completeJob, failJob: jobM.failJob },
      push: pushM.sendPushNotification,
    };
    const genaiPath = require.resolve('@google/generative-ai', { paths: [ROOT] });
    const hadGenai = require.cache[genaiPath];
    const anPath = require.resolve(path.join(ROOT, 'server/services/adminNotifier.js'));
    const hadAn = require.cache[anPath];
    const keepAlive = setInterval(() => {}, 1000);   // employerResearch unref()s its timers (see the flight blocks above)

    // ── THE FAKE SDK, keyed on the model. plan[model] = answers in order (an Error is thrown; a string is the text;
    // an object is a whole { response }); `busy` = models that answer 503 for ever; otherwise the model writes. ──
    const E503 = () => Object.assign(new Error('[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: [503 Service Unavailable] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'), { status: 503, statusText: 'Service Unavailable' });
    const E503_TEXT_ONLY = () => new Error('[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: [503 Service Unavailable] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.');
    const E429 = () => Object.assign(new Error('[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: [429 Too Many Requests] Your prepayment credits are depleted. RESOURCE_EXHAUSTED'), { status: 429, statusText: 'Too Many Requests' });
    const LETTER = (who) => JSON.stringify({ to: 'Hiring Manager', employer_name: 'Acme Legacy GmbH', position: 'Backend Engineer', addresses: ['Hauptstraße 12, 45128 Essen, Germany'], subject: 'Application for Backend Engineer — Ada', cover_letter: `With **8 Years** in payments, this letter was written by ${who}.\n\nParagraph two about **Node.js**.\n\nParagraph three about **PostgreSQL**.\n\nParagraph four, thank you.` });
    const fake = { calls: [], plan: {}, busy: new Set(), answer: (model) => LETTER(model) };
    class FakeGenAI {
      constructor(key) { this.key = key; }
      getGenerativeModel(params) {
        return { generateContent: async (req, opts) => {
          fake.calls.push({ model: params.model, cfg: params.generationConfig, req, opts });
          const q = fake.plan[params.model];
          const a = q && q.length ? q.shift() : (fake.busy.has(params.model) ? E503() : fake.answer(params.model));
          if (a instanceof Error) throw a;
          if (typeof a === 'string') return { response: { text: () => a, candidates: [{ finishReason: 'STOP' }] } };
          return a;
        } };
      }
    }
    const pages = [];
    const pushes = [];
    const money = { gates: 0, consumed: [], claims: 0 };
    const jobs = { partials: [], completed: [], failed: [] };
    const world = () => { fake.calls.length = 0; fake.plan = {}; fake.busy = new Set(); fake.answer = (m) => LETTER(m); money.gates = 0; money.consumed.length = 0; money.claims = 0; jobs.partials.length = 0; jobs.completed.length = 0; jobs.failed.length = 0; txLog.length = 0; reset(); er._reset(); };
    const models = () => fake.calls.map((c) => c.model);
    const locks = () => txLog.filter((e) => /pg_advisory_xact_lock/.test(e.sql)).length;
    const mkR = () => { const r = { statusCode: 200, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

    try {
      require.cache[genaiPath] = { id: genaiPath, filename: genaiPath, loaded: true, exports: { GoogleGenerativeAI: FakeGenAI } };
      require.cache[anPath] = { id: anPath, filename: anPath, loaded: true, exports: { notifyAdmins: async (...a) => { pages.push(a); } } };
      // The ~2 s pause before the primary's second try is aiText's (its own suite pins it); 0 here keeps this fast.
      aiText._internals.settings.retryWaitMs = 0; aiText._internals.settings.retryJitterMs = 0;
      delete process.env.AI_TEXT_FALLBACK_MODELS;   // the VERIFIED default chain
      delete process.env.AI_WRITING_MODEL; delete process.env.AI_WRITING_FALLBACK_MODELS;   // the MEASURED writing chain
      er.researchBrand = async () => null; er.googleFontCheck = async () => false;
      pushM.sendPushNotification = async (...a) => { pushes.push(a); return false; };
      ok('the RESEARCH chain under test is the verified default: gemini-2.5-flash → gemini-2.5-flash-lite → gemini-3.1-flash-lite',
        JSON.stringify(aiText.fallbackModels()) === JSON.stringify([LITE, LITE3]), aiText.fallbackModels());

      // ── RESEARCH: the conventions call ─────────────────────────────────────────────────────────────────
      const CONV = JSON.stringify({ employer_type: 'enterprise', hq_country: 'Germany', ats_vendor: 'Workday', cv: { photo: 'optional', length: 'two_pages' }, sources: ['https://acme-conv-test.com/careers', 'https://elsewhere.test/cv-tips'] });
      const grounded = (text) => ({ response: { text: () => text, candidates: [{ finishReason: 'STOP', groundingMetadata: { groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/x', title: 'acme-conv-test.com' } }] } }] } });
      // The REAL researchConventions (every block above put it back). It must never throw; if it ever does, that is a
      // clean ✗ below ({ threw }), not a crash of the whole suite.
      const rc = async (...args) => { try { return await saved.rc(...args); } catch (e) { return { threw: (e && e.message) || String(e) }; } };

      world();
      fake.plan[PRIMARY] = [E503(), E503_TEXT_ONLY()];
      fake.answer = () => grounded(CONV);
      let a = await rc('acme-conv-test.com', 'Acme');
      ok('⚠️ research: a 503 storm on the primary (twice, as in prod) → the conventions come from the FIRST FALLBACK',
        a.answered === true && a.model === LITE && a.conventions && a.conventions.employerType === 'enterprise', a);
      ok('…asking the primary twice (the paused second try) and then gemini-2.5-flash-lite, nothing more',
        JSON.stringify(models()) === JSON.stringify([PRIMARY, PRIMARY, LITE]), models());
      ok('…with the SAME grounded request and config on every model (thinkingBudget, 8192, Google Search) and a real abort signal on each',
        fake.calls.every((c) => c.cfg && c.cfg.maxOutputTokens === 8192 && c.cfg.thinkingConfig && c.cfg.thinkingConfig.thinkingBudget === 1024 && c.cfg.temperature === 0.2
          && JSON.stringify(c.req.tools) === JSON.stringify([{ googleSearch: {} }]) && c.req.contents[0].parts[0].text === fake.calls[0].req.contents[0].parts[0].text
          && c.opts && c.opts.signal && typeof c.opts.signal.aborted === 'boolean'), fake.calls.map((c) => ({ m: c.model, cfg: c.cfg })));
      ok('⚠️ …and its sources are verified against the FALLBACK\'s own grounding (the response is kept, not only the text)',
        !!a.conventions && JSON.stringify(a.conventions.sources) === JSON.stringify(['https://acme-conv-test.com/careers']), a.conventions && a.conventions.sources);
      const fromFallback = a.conventions;
      world();
      fake.answer = () => grounded(CONV);
      a = await rc('acme-conv-test.com', 'Acme');
      ok('⚠️ what a fallback wrote is byte-for-byte what the primary writes for the same answer (no model id inside)',
        a.answered === true && a.model === PRIMARY && models().length === 1 && !!fromFallback && JSON.stringify(a.conventions) === JSON.stringify(fromFallback) && !/gemini/i.test(JSON.stringify(fromFallback)), { primary: a.conventions, fromFallback });

      // Through the flight: the fallback's conventions are PERSISTED to the same cache row, and a later build reads them free.
      world();
      let reCalls = 0;
      researcher.researchEmployer = async () => { reCalls++; return { employer_name: 'Acme Conv', industry: 'Logistics' }; };
      fake.plan[PRIMARY] = [E503(), E503()];
      fake.answer = () => grounded(CONV);
      const f1 = await er.getEmployerResearch({ website: 'https://acme-conv-test.com' }, { timeoutMs: 2000 });
      ok('⚠️ getEmployerResearch during a 503 storm: base + the FALLBACK\'s conventions, on time',
        f1 && f1.industry === 'Logistics' && f1.conventions && f1.conventions.employerType === 'enterprise' && JSON.stringify(models()) === JSON.stringify([PRIMARY, PRIMARY, LITE]), { f1, models: models() });
      const rowWrites = db.log.filter((e) => /^INSERT INTO employer_research_cache/.test(e.sql));
      const stored = rowWrites.length ? JSON.parse(rowWrites[rowWrites.length - 1].params[1]) : { domain: 'acme-conv-test.com' };
      ok('…persisted under the DOMAIN (the one cache key) with the conventions in it, and no model id anywhere in what was written',
        !!stored && stored.conventions && stored.conventions.employerType === 'enterprise' && rowWrites.every((e) => e.params[0] === 'acme-conv-test.com' && !/gemini/i.test(String(e.params[1]))), rowWrites.map((e) => [e.params[0], String(e.params[1]).slice(0, 120)]));
      world(); reCalls = 0;
      db.answer = (q) => (/FROM employer_research_cache/.test(q) ? { research: stored, fetched_at: new Date() } : null);
      const f2 = await er.getEmployerResearch({ website: 'https://www.acme-conv-test.com/jobs' }, { timeoutMs: 2000 });
      ok('⚠️ …so the NEXT build for that employer is a FREE cache hit: zero AI calls, zero researcher calls, the same conventions',
        f2 && f1 && f1.conventions && fake.calls.length === 0 && reCalls === 0 && JSON.stringify(f2.conventions) === JSON.stringify(f1.conventions), { calls: models(), reCalls });

      // Every model busy: "no research", never a failed build — and remembered for MINUTES, not the hour.
      world(); reCalls = 0;
      fake.busy = new Set([PRIMARY, LITE, LITE3]);
      a = await rc('busy-conv-test.com', 'Busy');
      ok('⚠️ research: every model busy → { answered: false, busy: true } (never a throw), after the primary twice and each fallback once',
        a.answered === false && a.busy === true && JSON.stringify(models()) === JSON.stringify([PRIMARY, PRIMARY, LITE, LITE3]), { a, models: models() });
      world(); reCalls = 0;
      fake.busy = new Set([PRIMARY, LITE, LITE3]);
      const b1 = await er.getEmployerResearch({ website: 'https://busy-conv-test.com' }, { timeoutMs: 2000 });
      const convKey = er._internals.conventionsKey ? er._internals.conventionsKey('busy-conv-test.com') : 'conventions:busy-conv-test.com';
      const mem = er._internals.failureMemoryOf ? er._internals.failureMemoryOf(convKey) : undefined;
      ok('⚠️ …getEmployerResearch still answers the base facts with conventions null — a research failure never fails a build',
        b1 && b1.industry === 'Logistics' && b1.conventions === null && reCalls === 1, b1);
      ok('⚠️ …and the BUSY failure is remembered for BUSY_FAIL_MEMORY_MS (2 min), not the hour an hour of builds used to lose',
        er._internals.BUSY_FAIL_MEMORY_MS === 2 * 60 * 1000 && mem === er._internals.BUSY_FAIL_MEMORY_MS && mem < er._internals.FAIL_MEMORY_MS, { mem });
      const callsBefore = fake.calls.length;
      const b2 = await er.getEmployerResearch({ website: 'https://busy-conv-test.com' }, { timeoutMs: 2000 });
      ok('…inside that window a second build walks no chain again (the flight was released: a NEW flight ran, base researched again, no conventions call)',
        b2 && b2.conventions === null && fake.calls.length === callsBefore && reCalls === 2, { calls: fake.calls.length - callsBefore, reCalls });

      // Quota: fail fast, page, and remembered for the hour (a key out of credit is not a spike).
      world(); pages.length = 0;
      fake.plan[PRIMARY] = [E429()];
      a = await rc('quota-conv-test.com', 'Quota');
      ok('⚠️ research: quota → ONE call (every model shares the key), answered false, NOT busy', a.answered === false && a.busy === false && fake.calls.length === 1, { a, models: models() });
      ok('…and the operator is paged through aiHealth (ai_outage, quota)', pages.length === 1 && pages[0][3] && pages[0][3].type === 'ai_outage' && pages[0][3].kind === 'quota', pages);
      world();
      fake.plan[PRIMARY] = [E429()];
      await er.getEmployerResearch({ website: 'https://quota-conv-test.com' }, { timeoutMs: 2000 });
      ok('…remembered for the full hour', er._internals.failureMemoryOf && er._internals.failureMemoryOf('conventions:quota-conv-test.com') === er._internals.FAIL_MEMORY_MS);

      // ── RESEARCH: the BASE facts (2026-09-18, review) ──────────────────────────────────────────────────────
      // ⚠️ THE FINDING: ai-employer-researcher.js asks gemini-2.5-flash ONCE and answers null for a 503, and that null
      // was the domain's verdict for an HOUR — while the doc lanes, carried through the spike by aiText, SUCCEEDED and
      // were charged for documents written without the employer's facts, and cached like that (research is not in
      // their fingerprint). Driven with the REAL researcher module, loaded fresh against this block's fake Google, so
      // "the researcher answers null for a 503" is that module's own behaviour here, not a stub's claim about it.
      {
        const rePath = require.resolve(path.join(ROOT, 'ai-employer-researcher.js'));
        const hadRe = require.cache[rePath];
        const aiH = require(path.join(ROOT, 'server/services/aiHealth.js'));
        const realNote = aiH.noteAiFailure, realGen = aiText.generateText, realRC = er.researchConventions;
        const T = er._internals.baseTiming || {};
        const savedT = { ...T };
        const notes = [], asks = [];
        const I = er._internals;
        const mem = (d) => (I.failureMemoryOf ? I.failureMemoryOf(d) : undefined);
        const BASE = JSON.stringify({ employer_name: 'Amazon', industry: 'E-commerce and cloud computing', company_size: '10,001+ employees', technologies: [{ name: 'AWS' }], key_contacts: [{ name: 'Jane Doe', role: 'CEO' }] });
        const baseWrites = () => db.log.filter((e) => /^INSERT INTO employer_research_cache/.test(e.sql) && /fetched_at = NOW\(\)$/.test(e.sql));
        const fresh = () => { world(); asks.length = 0; notes.length = 0; };
        try {
          ok('the rescue\'s timing is inside the 25 s a build waits for its research, and one attempt cannot spend all of it',
            savedT.researcherWaitMs === 45000 && savedT.rescueBudgetMs > 0 && savedT.rescueBudgetMs < 25000 && savedT.rescueCapsMs < savedT.rescueBudgetMs
              && /async function getEmployerResearch\(\{ website, name, country \} = \{\}, \{ timeoutMs = 25000 \} = \{\}\)/.test(R('server/services/employerResearch.js')), savedT);
          delete require.cache[rePath];
          require(rePath);   // the real researcher, bound to FakeGenAI (it takes the SDK class at load)
          aiH.noteAiFailure = (e, where) => { notes.push(where); return realNote(e, where); };
          aiText.generateText = (o) => { asks.push(o); return realGen(o); };
          er.researchConventions = async () => ({ answered: true, conventions: null });   // this part is about the base facts only

          // 1. A normal day: the researcher answers, and that is the whole call — exactly as before the rescue existed.
          fresh();
          fake.answer = () => BASE;
          const n1 = await er.getEmployerResearch({ website: 'https://amazon-normal-test.com' }, { timeoutMs: 2000 });
          ok('base facts on a normal day: the researcher answers → ONE call (its own request, gemini-2.5-flash), no rescue, no aiText',
            n1 && n1.industry === 'E-commerce and cloud computing' && JSON.stringify(models()) === JSON.stringify([PRIMARY]) && asks.length === 0
              && /Visit the company website/.test(fake.calls[0].req.contents[0].parts[0].text), { n1, models: models(), asks: asks.length });

          // 2. The 2026-09-18 spike: gemini-2.5-flash 503s every call; the fallbacks answer.
          fresh();
          fake.busy = new Set([PRIMARY]);
          fake.answer = () => BASE;
          const s1 = await er.getEmployerResearch({ website: 'https://amazon-spike-test.com' }, { timeoutMs: 2000 });
          ok('⚠️ base facts during the spike: the researcher\'s 503 → the facts come from the FIRST FALLBACK, in the SAME build',
            s1 && s1.employerName === 'Amazon' && s1.industry === 'E-commerce and cloud computing' && JSON.stringify(models()) === JSON.stringify([PRIMARY, LITE]), { s1, models: models() });
          const ask = asks[0] || {};
          ok('⚠️ …ONE aiText call: lane research_base, the FALLBACKS only (never the model that just failed), inside the build\'s window',
            asks.length === 1 && ask.lane === 'research_base' && JSON.stringify(ask.models) === JSON.stringify([LITE, LITE3])
              && ask.budgetMs === savedT.rescueBudgetMs && ask.attemptCapsMs === savedT.rescueCapsMs, asks.map((o) => ({ lane: o.lane, models: o.models, budgetMs: o.budgetMs, caps: o.attemptCapsMs })));
          const rescueCall = fake.calls[1] || {};
          const rescueText = rescueCall.req && rescueCall.req.contents ? rescueCall.req.contents[0].parts[0].text : '';
          ok('…a Google Search grounded request with the researcher\'s own config, and a real abort signal',
            JSON.stringify(rescueCall.req && rescueCall.req.tools) === JSON.stringify([{ googleSearch: {} }]) && JSON.stringify(rescueCall.cfg) === JSON.stringify({ temperature: 1, topP: 0.95, maxOutputTokens: 8192 })
              && rescueCall.opts && rescueCall.opts.signal && typeof rescueCall.opts.signal.aborted === 'boolean', { cfg: rescueCall.cfg, tools: rescueCall.req && rescueCall.req.tools });
          ok('…whose question names the DOMAIN only, asks for no people and asks for null instead of invented defaults',
            /Employer website: https:\/\/amazon-spike-test\.com\n/.test(rescueText) && /Never include the name, email address or phone number of any person/.test(rescueText)
              && !/key_contacts|KEY CONTACTS|#262633|"Lato"/.test(rescueText), rescueText.slice(0, 200));
          const sw = baseWrites();
          ok('⚠️ …written to the domain\'s row exactly like the researcher\'s facts (no people, no model id), and NO failure remembered',
            sw.length === 1 && sw[0].params[0] === 'amazon-spike-test.com' && JSON.parse(sw[0].params[1]).industry === 'E-commerce and cloud computing'
              && !/gemini|Jane/i.test(String(sw[0].params[1])) && mem('amazon-spike-test.com') === null, { writes: sw.map((e) => String(e.params[1]).slice(0, 160)), mem: mem('amazon-spike-test.com') });
          const spikeRow = sw.length ? JSON.parse(sw[0].params[1]) : {};
          fresh();
          db.answer = (q) => (/FROM employer_research_cache/.test(q) ? { research: { ...spikeRow, conventions: null, conventionsAt: new Date().toISOString() }, fetched_at: new Date() } : null);
          const s2 = await er.getEmployerResearch({ website: 'https://www.amazon-spike-test.com/jobs' }, { timeoutMs: 2000 });
          ok('…so the NEXT build reads them for free: zero AI calls, the same facts',
            s2 && s1 && s2.industry === s1.industry && s2.employerName === 'Amazon' && fake.calls.length === 0 && asks.length === 0, { calls: models(), s2 });

          // 3. Every model busy: no base facts (never a failed build), remembered for MINUTES.
          fresh();
          fake.busy = new Set([PRIMARY, LITE, LITE3]);
          const b1 = await er.getEmployerResearch({ website: 'https://amazon-allbusy-test.com' }, { timeoutMs: 2000 });
          // aiText's paused second try belongs to the first model it is handed — the first fallback here, never the
          // researcher's model again (its call already was that model's try).
          ok('⚠️ every model busy → no base facts (null, never a throw), after the researcher once, the first fallback twice (the paused try) and the last once',
            b1 === null && JSON.stringify(models()) === JSON.stringify([PRIMARY, LITE, LITE, LITE3]), { b1, models: models() });
          ok('⚠️ …and remembered for BUSY_FAIL_MEMORY_MS (2 min), NOT the hour that cost Amazon its facts',
            mem('amazon-allbusy-test.com') === I.BUSY_FAIL_MEMORY_MS && I.BUSY_FAIL_MEMORY_MS < I.FAIL_MEMORY_MS, { mem: mem('amazon-allbusy-test.com') });
          const before = fake.calls.length;
          await er.getEmployerResearch({ website: 'https://amazon-allbusy-test.com' }, { timeoutMs: 2000 });
          ok('…inside that window a second build asks nobody (no researcher call, no chain): one walk per domain per window',
            fake.calls.length === before, { calls: fake.calls.length - before });

          // 4. Prose from both: nothing to learn is not busy.
          fresh();
          fake.answer = () => 'I could not find anything about this company.';
          const p1 = await er.getEmployerResearch({ website: 'https://prose-base-test.com' }, { timeoutMs: 2000 });
          ok('prose from the researcher AND the rescue → no facts, the hour; two calls — the rescue never re-walks the chain for an answer IT rejected',
            p1 === null && JSON.stringify(models()) === JSON.stringify([PRIMARY, LITE]) && mem('prose-base-test.com') === I.FAIL_MEMORY_MS, { models: models(), mem: mem('prose-base-test.com') });

          // 5. Quota: fail fast, the hour, the operator paged (aiHealth throttles the push itself; the report is what is pinned).
          fresh();
          fake.plan[PRIMARY] = [E429()];
          fake.plan[LITE] = [E429()];
          await er.getEmployerResearch({ website: 'https://quota-base-test.com' }, { timeoutMs: 2000 });
          ok('quota: the researcher\'s 429, then ONE rescue call (every model shares the key), the hour, reported to aiHealth',
            JSON.stringify(models()) === JSON.stringify([PRIMARY, LITE]) && mem('quota-base-test.com') === I.FAIL_MEMORY_MS && notes.includes('aiText.research_base'), { models: models(), mem: mem('quota-base-test.com'), notes });

          // 6. A researcher that HANGS (no abort of its own): stopped being waited for, and the fallback answers.
          fresh();
          T.researcherWaitMs = 60;
          fake.plan[PRIMARY] = [new Promise(() => {})];   // never settles; holds no handle
          fake.answer = () => BASE;
          const t0 = Date.now();
          const h1 = await er.getEmployerResearch({ website: 'https://hang-base-test.com' }, { timeoutMs: 2000 });
          ok('⚠️ a HUNG researcher is left after researcherWaitMs and the first fallback answers the same build',
            h1 && h1.industry === 'E-commerce and cloud computing' && JSON.stringify(models()) === JSON.stringify([PRIMARY, LITE]) && Date.now() - t0 < 1500, { h1, models: models(), ms: Date.now() - t0 });
          T.researcherWaitMs = savedT.researcherWaitMs;

          // 7. The operator's "primary only" switch: the rescue is the researcher's model once more (aiText's paused retry).
          fresh();
          process.env.AI_TEXT_FALLBACK_MODELS = 'none';
          fake.busy = new Set([PRIMARY]);
          await er.getEmployerResearch({ website: 'https://nofallback-base-test.com' }, { timeoutMs: 2000 });
          ok('AI_TEXT_FALLBACK_MODELS=none: the rescue asks gemini-2.5-flash alone (its one paused retry), busy → minutes',
            asks.length === 1 && JSON.stringify(asks[0].models) === JSON.stringify([PRIMARY]) && JSON.stringify(models()) === JSON.stringify([PRIMARY, PRIMARY, PRIMARY])
              && mem('nofallback-base-test.com') === I.BUSY_FAIL_MEMORY_MS, { asks: asks.map((o) => o.models), models: models() });
          delete process.env.AI_TEXT_FALLBACK_MODELS;

          // The code rules behind it.
          const erNow = strip(R('server/services/employerResearch.js'));
          ok('⚠️ flightFor asks researchBase through module.exports and never calls the researcher bare any more',
            /module\.exports\.researchBase\(domain\)/.test(fnBody(erNow, 'flightFor')) && !/researchEmployer\(/.test(fnBody(erNow, 'flightFor')));
          ok('⚠️ …researchBase\'s rescue goes through aiText.generateText (lane research_base) and makes no SDK call of its own',
            /aiText\.generateText\(\{[\s\S]{0,120}lane: 'research_base'/.test(fnBody(erNow, 'researchBase')) && !/getGenerativeModel|GoogleGenerativeAI/.test(fnBody(erNow, 'researchBase')));
          ok('…and the busy-vs-broken rule is the flight\'s, on the DOMAIN key',
            /rememberFailure\(domain, busy \? BUSY_FAIL_MEMORY_MS : FAIL_MEMORY_MS\)/.test(fnBody(erNow, 'flightFor')));
        } finally {
          if (hadRe) require.cache[rePath] = hadRe; else delete require.cache[rePath];
          aiH.noteAiFailure = realNote; aiText.generateText = realGen; er.researchConventions = realRC;
          Object.assign(T, savedT);
          delete process.env.AI_TEXT_FALLBACK_MODELS;
          er._reset(); reset();
        }
      }
      researcher.researchEmployer = saved.re;

      // ── THE LEGACY LETTER (Letters screen / Job Hub → POST /generate-cover-letter-details) ──────────────────
      // ⚠️ RETARGETED 2026-09-18: this lane walks aiText.writing() now, not [LEGACY_LETTER_MODEL, ...fallbackModels()].
      // Its models are read from the SAME aiText instance the controller calls (coverLetterController requires
      // '../services/aiText' lazily, per call — the file this block required above; the spy below proves it), so a
      // storm "on the primary" is scripted on W_PRIMARY, "the first fallback wrote it" expects W_FB1, and "every
      // model busy" scripts the whole writing chain. The research scenarios above stay on PRIMARY / LITE / LITE3.
      const WCHAIN = aiText.writingChain();
      const [W_PRIMARY, W_FB1, W_FB2] = WCHAIN;
      const LANE_CFG = { temperature: 1, topP: 0.95, maxOutputTokens: 32768 };   // v2's config, the lane's own
      const LANE_CFG_THINKING_OFF = { ...LANE_CFG, thinkingConfig: { thinkingBudget: 0 } };   // what W_FB1 must receive
      // The config one call must have received: thinking OFF (merged over the lane's config) for W_FB1 only; every
      // other model gets the lane's config untouched — NO thinkingConfig at all.
      const expectedCfg = (model) => (model === W_FB1 ? LANE_CFG_THINKING_OFF : LANE_CFG);
      const cfgRight = (c) => !!c.cfg && JSON.stringify(c.cfg) === JSON.stringify(expectedCfg(c.model))
        && (c.model === W_FB1 ? c.cfg.thinkingConfig.thinkingBudget === 0 : !('thinkingConfig' in c.cfg));
      ok('the LEGACY letter chain under test is aiText\'s measured writing default: three distinct models, and the FIRST FALLBACK is the one model with a config of its own (thinking off)',
        WCHAIN.length === 3 && new Set(WCHAIN).size === 3 && JSON.stringify(WCHAIN) === JSON.stringify([aiText._internals.WRITING_PRIMARY, ...aiText._internals.WRITING_FALLBACKS])
          && JSON.stringify(Object.keys(aiText._internals.WRITING_MODEL_CONFIG)) === JSON.stringify([W_FB1]), { chain: WCHAIN, modelConfig: aiText._internals.WRITING_MODEL_CONFIG });
      ok('…and it is NOT the research chain, nor headed by LEGACY_LETTER_MODEL any more (a storm scripted on either would never reach this lane\'s first model)',
        W_PRIMARY !== PRIMARY && JSON.stringify(WCHAIN) !== JSON.stringify([PRIMARY, LITE, LITE3]) && typeof CLI.LEGACY_LETTER_MODEL === 'string' && CLI.LEGACY_LETTER_MODEL !== W_PRIMARY,
        { writing: WCHAIN, research: [PRIMARY, LITE, LITE3], LEGACY_LETTER_MODEL: CLI.LEGACY_LETTER_MODEL });
      // Every aiText.generateText call the lane makes, recorded (the real call still runs). Put back in the finally.
      const legacyAsks = [];
      aiText.generateText = (o) => { legacyAsks.push(o); return saved.gen(o); };
      const USER ={ id: 77, full_name: 'Ada Lovelace', email: 'ada@example.test', resume_path: 'uploads/user_77/resume.pdf' };
      const META = { user_id: 77, parse_status: 'done', full_name: 'Ada Lovelace', skills: '["Node.js","PostgreSQL"]' };
      const legacyWorld = () => {
        world();
        db.answer = (q) => {
          if (/^SELECT \* FROM users WHERE id = \?/.test(q)) return { ...USER };
          if (/^SELECT \* FROM resume_metadata WHERE user_id = \?/.test(q)) return { ...META };
          if (/^SELECT brand_color, font_name FROM employer_brand_profiles/.test(q)) return { brand_color: '#123456', font_name: 'Lato' };   // a brand-cache HIT: no researcher call
          return null;
        };
      };
      entM.canConsumeMany = async () => { money.gates++; return { allowed: true, remaining: 5 }; };
      entM.consumeOnSuccess = async (u, kind, detail) => { money.consumed.push({ u, kind, detail }); return { via: 'plan', ledgerId: 900 + money.consumed.length }; };
      downloads.resolveEmployer = async (u, cands) => (cands.find((c) => c && String(c).trim()) || null);
      downloads.passCoversGeneration = async () => false;
      downloads.claimGeneration = async () => { money.claims++; return { charged: false }; };
      jobM.createJob = async () => 'job-legacy-1';
      jobM.startJob = async () => {}; jobM.updateJobProgress = async () => {};
      jobM.updateJobPartialResult = async (id, r) => { jobs.partials.push(r); };
      jobM.completeJob = async (id, r) => { jobs.completed.push({ id, r }); };
      jobM.failJob = async (id, msg) => { jobs.failed.push({ id, msg }); };
      const BODY = { recipientEmail: 'hr@acme-legacy.test', websiteUrl: 'https://acme-legacy.test', position: 'Backend Engineer' };
      const details = async (body, { asyncMode = false } = {}) => {
        process.env.USE_ASYNC_JOBS = asyncMode ? 'true' : 'false';
        const res = mkR();
        await CL.generateCoverLetterDetails({ user: { id: 77 }, body, headers: {}, ip: '1.1.1.1' }, res);
        return res;
      };
      const failedJobRow = () => db.log.find((e) => /^UPDATE async_jobs SET status = 'failed'/.test(e.sql)) || null;
      const settled = async () => { for (let i = 0; i < 300 && !jobs.completed.length && !jobs.failed.length && !failedJobRow(); i++) await sleep(10); };
      const EXPECTED_PROMPT = v2.buildPrompt({ ...META }, 'Backend Engineer', 'https://acme-legacy.test', null, null, null);

      legacyWorld(); legacyAsks.length = 0;
      fake.plan[W_PRIMARY] = [E503(), E503_TEXT_ONLY()];
      let r = await details(BODY);
      ok('⚠️ LEGACY letter (sync): the prod 503 storm on the primary → 200, the letter written by the FALLBACK',
        r.statusCode === 200 && r.body && r.body.success === true && String(r.body.coverLetterHtml || '').includes(`written by ${W_FB1}.`), { status: r.statusCode, want: W_FB1, body: r.body && (r.body.error || String(r.body.coverLetterHtml).slice(0, 120)) });
      ok('…after the primary twice (the paused retry) and then the first fallback — not three blind tries on one model',
        JSON.stringify(models()) === JSON.stringify([W_PRIMARY, W_PRIMARY, W_FB1]), models());
      ok('⚠️ …charged EXACTLY ONCE, under the usage lock, after the letter existed', money.consumed.length === 1 && locks() === 1 && money.consumed[0].kind === 'cover_letter', { consumed: money.consumed.length, locks: locks() });
      // ⚠️ RETARGETED 2026-09-18: "v2's config on every model" is no longer the design. The first fallback
      // (gemini-2.5-flash) gets thinking OFF laid over v2's config; every other model gets v2's config exactly.
      ok('…every model got v2\'s prompt byte for byte, Google Search grounding, an abort signal and v2\'s config (temperature 1, topP 0.95, 32768) — with thinkingConfig { thinkingBudget: 0 } merged in for the first fallback ONLY',
        fake.calls.some((c) => c.model === W_PRIMARY) && fake.calls.some((c) => c.model === W_FB1)
          && fake.calls.every((c) => c.req.contents[0].parts[0].text === EXPECTED_PROMPT && cfgRight(c)
          && JSON.stringify(c.req.tools) === JSON.stringify([{ googleSearch: {} }]) && c.opts && c.opts.signal), fake.calls.map((c) => ({ m: c.model, cfg: c.cfg, want: expectedCfg(c.model), same: c.req.contents[0].parts[0].text === EXPECTED_PROMPT })));
      // ⚠️ REWRITTEN BY DESIGN 2026-09-18: the lane used to pass models: [LEGACY_LETTER_MODEL, ...fallbackModels()].
      // It now spreads aiText.writing(): the measured chain AND its per-model config — both, from THIS aiText.
      const la = legacyAsks[0] || {};
      ok('⚠️ …ONE aiText call, lane letter_legacy, carrying aiText.writing()\'s models AND its modelConfig (the same object), v2\'s config as the lane config',
        legacyAsks.length === 1 && la.lane === 'letter_legacy' && JSON.stringify(la.models) === JSON.stringify(aiText.writing().models) && JSON.stringify(la.models) === JSON.stringify(WCHAIN)
          && la.modelConfig === aiText._internals.WRITING_MODEL_CONFIG && la.modelConfig === aiText.writing().modelConfig && JSON.stringify(la.config) === JSON.stringify(LANE_CFG),
        legacyAsks.map((o) => ({ lane: o.lane, models: o.models, modelConfig: o.modelConfig, config: o.config })));
      ok('the lane\'s own parsing is kept: the addresses and the employer name come from the fallback\'s JSON',
        !!r.body && r.body.companyName === 'Acme Legacy GmbH' && Array.isArray(r.body.locations) && r.body.locations[0].address === 'Hauptstraße 12, 45128 Essen, Germany', r.body && { companyName: r.body.companyName, locations: r.body.locations });

      legacyWorld();
      fake.plan[W_PRIMARY] = [E503(), E503()];
      r = await details(BODY, { asyncMode: true });
      await settled();
      const labels = jobs.partials.filter((p) => p && p.stage === 'retry').map((p) => p.label);
      ok('⚠️ LEGACY letter (async job): the storm still completes the job, charged once',
        r.statusCode === 202 && jobs.completed.length === 1 && String(jobs.completed[0].r.coverLetterHtml || '').includes(`written by ${W_FB1}.`) && money.consumed.length === 1 && !failedJobRow()
          && JSON.stringify(models()) === JSON.stringify([W_PRIMARY, W_PRIMARY, W_FB1]),
        { status: r.statusCode, completed: jobs.completed.length, consumed: money.consumed.length, models: models(), failed: failedJobRow() && failedJobRow().params });
      ok('…and each retry was put on the job in plain words ("Google\'s AI is busy — trying again", "Switching to a backup model")',
        JSON.stringify(labels) === JSON.stringify(["Google's AI is busy — trying again", 'Switching to a backup model']), labels);

      legacyWorld();
      fake.busy = new Set(WCHAIN);   // every model of the WRITING chain
      r = await details(BODY);
      ok('⚠️ LEGACY letter: EVERY model busy → HTTP 503 { success:false, reason:"ai_busy", retryable:true } saying nothing was charged',
        r.statusCode === 503 && r.body && r.body.success === false && r.body.reason === 'ai_busy' && r.body.retryable === true
          && r.body.error === "Google's AI is overloaded right now, so your cover letter could not be written. Nothing was charged — please try again in a minute.", { status: r.statusCode, body: r.body });
      ok('⚠️ …NOTHING charged: no usage lock taken, no consumeOnSuccess, no pass claimed, no notification written',
        money.consumed.length === 0 && locks() === 0 && money.claims === 0 && !db.log.some((e) => /INSERT INTO notifications/.test(e.sql)), { consumed: money.consumed.length, locks: locks(), claims: money.claims });
      ok('…after exactly one walk of the chain (primary twice, each fallback once) — the lane never re-walks a refusal',
        JSON.stringify(models()) === JSON.stringify([W_PRIMARY, W_PRIMARY, W_FB1, W_FB2]), models());
      ok('…and on that walk thinking was OFF for the first fallback only: the primary and the last fallback got v2\'s config with NO thinkingConfig',
        fake.calls.length === 4 && fake.calls.every(cfgRight), fake.calls.map((c) => ({ m: c.model, cfg: c.cfg, want: expectedCfg(c.model) })));

      legacyWorld();
      fake.busy = new Set(WCHAIN);
      r = await details(BODY, { asyncMode: true });
      await settled();
      const fr = failedJobRow();
      const frResult = fr ? JSON.parse(fr.params[1]) : null;
      ok('⚠️ LEGACY letter (async job): every model busy → the job FAILS (the poller is released) in ONE UPDATE carrying reason ai_busy + retryable',
        !!fr && fr.params[2] === 'job-legacy-1' && frResult && frResult.reason === 'ai_busy' && frResult.retryable === true && /Nothing was charged/.test(fr.params[0]) && fr.params[0] === frResult.error,
        { row: fr && fr.params, failJob: jobs.failed });
      ok('…never completed, never charged', jobs.completed.length === 0 && money.consumed.length === 0 && locks() === 0, { completed: jobs.completed.length, consumed: money.consumed.length });

      legacyWorld(); pages.length = 0;
      fake.plan[W_PRIMARY] = [E429()];
      r = await details(BODY);
      ok('⚠️ LEGACY letter: quota → HTTP 503 { reason:"ai_down", retryable:false }, "Nothing was charged"',
        r.statusCode === 503 && r.body && r.body.success === false && r.body.reason === 'ai_down' && r.body.retryable === false && r.body.error === 'Our AI provider is unavailable right now. Nothing was charged.', { status: r.statusCode, body: r.body });
      ok('…after ONE call (fail fast: every model shares the key) — the primary\'s — nothing charged, no lock',
        fake.calls.length === 1 && models()[0] === W_PRIMARY && money.consumed.length === 0 && locks() === 0, { calls: models(), consumed: money.consumed.length });

      legacyWorld();
      fake.plan[W_PRIMARY] = ['I could not find enough about this company to write a letter.'];
      r = await details(BODY, { asyncMode: true });
      await settled();
      ok('the lane\'s OWN bad-output retry is kept: prose, then a letter → completed, two answers from the SAME model (not a model switch), charged once',
        jobs.completed.length === 1 && JSON.stringify(models()) === JSON.stringify([W_PRIMARY, W_PRIMARY]) && money.consumed.length === 1
          && JSON.stringify(jobs.partials.filter((p) => p && p.stage === 'retry').map((p) => p.label)) === JSON.stringify(['Taking another pass at it']),
        { models: models(), partials: jobs.partials, consumed: money.consumed.length });

      legacyWorld();
      fake.busy = new Set(WCHAIN);
      let thrown = null;
      try { await CL.executeGenerationWork(77, { ...USER }, { recipientEmail: 'a@x.test', websiteUrl: 'acme-legacy.test', position: 'Backend Engineer' }); } catch (e) { thrown = e; }
      ok('batch-process (executeGenerationWork): every model busy → a user-facing refusal with reason ai_busy, nothing charged',
        !!thrown && thrown.userFacing === true && thrown.reason === 'ai_busy' && thrown.retryable === true && /Nothing was charged/.test(thrown.message) && money.consumed.length === 0 && locks() === 0, thrown && { m: thrown.message, reason: thrown.reason });

      legacyWorld();
      fake.busy = new Set(WCHAIN);
      process.env.USE_ASYNC_JOBS = 'false';
      r = mkR();
      await CL.generateCoverLetters({ user: { id: 77 }, body: { recipients: [{ email: 'one@a.test', website: 'a-legacy.test', position: 'Dev' }, { email: 'two@b.test', website: 'b-legacy.test', position: 'Dev' }] }, headers: {} }, r);
      ok('⚠️ LEGACY bulk: the first letter meets a busy chain → HTTP 503 ai_busy, both letters failed with that reason, nothing charged',
        r.statusCode === 503 && r.body && r.body.reason === 'ai_busy' && r.body.retryable === true && r.body.creditsUsed === 0 && money.consumed.length === 0
          && Array.isArray(r.body.results) && r.body.results.length === 2 && r.body.results.every((x) => x.status === 'failed' && x.reason === 'ai_busy'), { status: r.statusCode, body: r.body });
      ok('…and the second recipient was NOT asked (one refusal ends the run: the same answer, minutes later)',
        JSON.stringify(models()) === JSON.stringify([W_PRIMARY, W_PRIMARY, W_FB1, W_FB2]), models());

      // The lane's parsing, ported from ai-cover-letter-v2 stage for stage.
      const P = CLI.parseLegacyLetterJson;
      ok('parseLegacyLetterJson is exposed for this suite', typeof P === 'function');
      if (typeof P === 'function') {
        const rawNl = '```json\n{"to":"HR","employer_name":"Acme","position":"Dev","addresses":["1 Road"],"subject":"S","cover_letter":"Para one.\n\nPara two."}\n```';
        ok('…fences off, raw newlines inside a string repaired (stage 2)', P(rawNl).cover_letter === 'Para one.\n\nPara two.' && P(rawNl).employer_name === 'Acme');
        const quoted = '{"to": "HR", "employer_name": "Acme", "position": "Dev", "addresses": ["1 Road"], "subject": "S", "cover_letter": "He said "ship it" and we did.\\n\\nPara two."}';
        ok('…a literal double quote no parser can repair → the field extractor (stage 3)', P(quoted).cover_letter === 'He said "ship it" and we did.\n\nPara two.' && P(quoted).employer_name === 'Acme', P(quoted));
        let e1 = null; try { P('Sorry, I cannot help.'); } catch (e) { e1 = e; }
        let e2 = null; try { P('{"to":"HR","cover_letter":"   "}'); } catch (e) { e2 = e; }
        ok('…prose is a throw (the retry), and so is an answer with NO letter in it (v2 used to hand that on and charge for it)',
          !!e1 && /did not contain a JSON object/.test(e1.message) && !!e2 && /no cover_letter/.test(e2.message), { e1: e1 && e1.message, e2: e2 && e2.message });
      }

      // ── the code rules behind all of that ──
      const clSrc = strip(R('server/controllers/coverLetterController.js'));
      const erSrc = strip(R('server/services/employerResearch.js'));
      const work = fnBody(clSrc, 'executeGenerationWork');
      const bulk = (clSrc.match(/const generateCoverLetters = async[\s\S]*?\nconst generateCoverLetterDetails = async/) || [''])[0];
      ok('⚠️ coverLetterController makes NO direct model call any more (no getGenerativeModel / generateContent / GoogleGenerativeAI)',
        !/getGenerativeModel|generateContent\(|GoogleGenerativeAI/.test(clSrc));
      // ⚠️ REWRITTEN BY DESIGN 2026-09-18: it used to pin models: [LEGACY_LETTER_MODEL, ...aiText.fallbackModels()].
      // The lane now spreads aiText.writing() (the measured chain + its per-model config), and must name no models /
      // modelConfig of its own in that call — either key would override (or be overridden by) the spread.
      const wll = fnBody(clSrc, 'writeLegacyLetter');
      const genCall = (wll.match(/aiText\.generateText\(\{[\s\S]*?\n\s*\}\);/) || [''])[0];
      ok('⚠️ …its letter goes through aiText.generateText spreading aiText.writing() (models AND modelConfig), with no chain or model config of its own',
        /lane: 'letter_legacy'/.test(genCall) && /\.\.\.aiText\.writing\(\)/.test(genCall) && !/\bmodels\s*:|\bmodelConfig\s*:/.test(genCall)
          && !/LEGACY_LETTER_MODEL|fallbackModels\(/.test(genCall), genCall.slice(0, 600));
      ok('⚠️ …and the AI runs BEFORE the charge in the worker and in bulk (writeLegacyLetter before withUsageLock)',
        work.indexOf('writeLegacyLetter(') > 0 && work.indexOf('writeLegacyLetter(') < work.indexOf('withUsageLock(')
          && bulk.indexOf('writeLegacyLetter(') > 0 && bulk.indexOf('writeLegacyLetter(') < bulk.indexOf('withUsageLock('), { work: [work.indexOf('writeLegacyLetter('), work.indexOf('withUsageLock(')], bulk: [bulk.indexOf('writeLegacyLetter('), bulk.indexOf('withUsageLock(')] });
      ok('⚠️ researchConventions goes through aiText (CONVENTIONS_MODEL first, then the fallbacks) and makes no SDK call of its own',
        /aiText\.generateText\(\{[\s\S]{0,500}models: \[CONVENTIONS_MODEL, \.\.\.aiText\.fallbackModels\(\)\]/.test(fnBody(erSrc, 'researchConventions')) && !/getGenerativeModel|timeout: CONVENTIONS_HARD_TIMEOUT_MS/.test(fnBody(erSrc, 'researchConventions')));
      ok('⚠️ RESEARCH_REV / LETTER_REV / FP_VERSION are untouched by the fallback round (a bump would re-bill every saved document)',
        er.RESEARCH_REV === 'r1' && /const RESEARCH_REV = 'r1';/.test(erSrc) && /const LETTER_REV = 'letter-v1';/.test(R('server/controllers/employerLetterController.js')) && docs.FP_VERSION === 'v1' && /const FP_VERSION = 'v1';/.test(R('server/services/employerDocs.js')));
      ok('…and no model id is folded into the research the doc lanes fingerprint (docResearchRev stays the bare RESEARCH_REV)',
        !/CONVENTIONS_MODEL|model/.test((erSrc.match(/const RESEARCH_REV = [^;]*;/) || [''])[0]));
      ok('no push was sent and nothing reached the network', pushes.length === 0);
    } finally {
      clearInterval(keepAlive);
      Object.assign(aiText._internals.settings, saved.settings);
      aiText.generateText = saved.gen;
      if (saved.fallbackEnv === undefined) delete process.env.AI_TEXT_FALLBACK_MODELS; else process.env.AI_TEXT_FALLBACK_MODELS = saved.fallbackEnv;
      if (saved.writingEnv === undefined) delete process.env.AI_WRITING_MODEL; else process.env.AI_WRITING_MODEL = saved.writingEnv;
      if (saved.writingFbEnv === undefined) delete process.env.AI_WRITING_FALLBACK_MODELS; else process.env.AI_WRITING_FALLBACK_MODELS = saved.writingFbEnv;
      if (saved.asyncEnv === undefined) delete process.env.USE_ASYNC_JOBS; else process.env.USE_ASYNC_JOBS = saved.asyncEnv;
      if (hadGenai) require.cache[genaiPath] = hadGenai; else delete require.cache[genaiPath];
      if (hadAn) require.cache[anPath] = hadAn; else delete require.cache[anPath];
      er.researchConventions = saved.rc; er.researchBrand = saved.rb; er.googleFontCheck = saved.gf; researcher.researchEmployer = saved.re;
      entM.canConsumeMany = saved.canConsumeMany; entM.consumeOnSuccess = saved.consumeOnSuccess;
      downloads.resolveEmployer = saved.resolveEmployer; downloads.passCoversGeneration = saved.passCoversGeneration; downloads.claimGeneration = saved.claimGeneration;
      Object.assign(jobM, saved.job);
      pushM.sendPushNotification = saved.push;
      er._reset(); reset(); txLog.length = 0;
    }
  }

  console.log(`\nemployer docs: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
