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
  const RIDS = require(path.join(ROOT, 'server/utils/resumeTemplates.js')).TEMPLATE_IDS;
  const LIDS = require(path.join(ROOT, 'server/utils/coverLetterTemplates.js')).TEMPLATE_IDS;
  const invariant = (d, ids, kind) => {
    if (!d || d.v !== 1 || d.kind !== kind || !Array.isArray(d.ranked)) return 'shape';
    if (d.ranked.length !== ids.length) return 'length ' + d.ranked.length + ' vs ' + ids.length;
    const seen = new Set(d.ranked.map((r) => r.id));
    if (seen.size !== ids.length || ids.some((id) => !seen.has(id))) return 'not every id exactly once';
    for (let i = 0; i < d.ranked.length; i++) {
      const r = d.ranked[i];
      if (!Number.isInteger(r.score) || r.score < 0 || r.score > 100) return 'score ' + JSON.stringify(r);
      if (typeof r.reason !== 'string' || r.reason.length > 90) return 'reason ' + JSON.stringify(r);
      if (i && d.ranked[i - 1].score < r.score) return 'not sorted at ' + i;
      // ties keep catalogue order
      if (i && d.ranked[i - 1].score === r.score && ids.indexOf(d.ranked[i - 1].id) > ids.indexOf(r.id)) return 'tie order at ' + i;
    }
    if (!['a4', 'onepage'].includes(d.mode)) return 'mode';
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
    ok(`resume ranking #${i}: every id once, integer 0..100, sorted desc, ties in catalogue order`, invariant(d, RIDS, 'resume') === null, invariant(d, RIDS, 'resume'));
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
  const lFirstPaid = Math.min(...['canConsumeMany(', 'passCoversGeneration(', 'claimGeneration(', 'consumeOnSuccess(', 'getEmployerResearch(', 'callLetterModel('].map((t) => build.indexOf(t)).filter((i) => i >= 0));
  ok('⚠️ the cache hit returns BEFORE any gate, research, AI or charge', lHit > 0 && lHitReturn > lHit && lHitReturn < lFirstPaid, { lHit, lHitReturn, lFirstPaid });
  const lCovered = build.indexOf('if (coveredOnly && !viaPass && !quotaCovers)');
  ok('⚠️ the coveredOnly refusal precedes research AND the AI', lCovered > 0 && lCovered < build.indexOf('getEmployerResearch(') && lCovered < build.indexOf('callLetterModel('));
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
    ok('⚠️ fence 1: pages are created with javaScriptEnabled FALSE',
      /newPage\(\{ viewport: \{ width: A4_W, height: A4_H \}, javaScriptEnabled: false \}\)/.test(fnBody(rndC, 'preparePage')));
    ok('⚠️ fence 2: a route installed BEFORE any content aborts everything the allowlist does not name',
      /await page\.route\('\*\*\/\*', \(route\) => \(isAllowedRequest\(route\.request\(\)\.url\(\)\)\s*\? route\.continue\(\)\s*: route\.abort\('blockedbyclient'\)\)/.test(fnBody(rndC, 'preparePage')));
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

  console.log(`\nemployer docs: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
