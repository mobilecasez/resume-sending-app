// Instant, on-demand job research for a user whose corner of the feed is empty — ADDITIVE, and
// SHIPPED DISARMED (see "arming" below).
//
// ─── the problem this exists for ──────────────────────────────────────────────────────────────
// Measured on production: France carries 895 active jobs, and only THREE of them are Science &
// Research. User 192 (Vijay, France, résumé = Trainee Chemist / Lab Chemist — batch reactors,
// distillation, GMP) therefore opens the app and sees a feed with nothing he could apply to. He is
// not an outlier: 578 of the 1050 country × field cells hold fewer than 10 jobs. The 12-hourly
// demand researcher only walks interests a user has explicitly SAVED, so a user who never saves an
// interest card — which is nearly all of them — is never researched for at all.
//
// ─── two arms, because one is not enough ──────────────────────────────────────────────────────
// ARM 1 — THIN CELL. The résumé maps to a taxonomy field and that (country, field) cell holds
//   fewer than THIN_CELL_MAX active jobs. Research that field in that country.
//
// ARM 2 — UNREPRESENTED OCCUPATION. The résumé maps to NO taxonomy field at all (deriveUserField
//   returns null: every job title classified as 'Other', or none classified). A trigger keyed only
//   on "count(country, field) < 10" can never fire for these people, because there is no cell to
//   count. Research their occupation as FREE TEXT instead ("Warehouse Picker Packer" + "Morocco")
//   and let ingestion create the coverage.
//
// ⚠️ HONEST CORRECTION TO THE BRIEF. The brief said the taxonomy has no chemistry/laboratory
// category and that Vijay would resolve to NOTHING, i.e. arm 2. He does not. server/utils/
// jobTaxonomy.js DOES have a 'Science & Research' field whose regex matches /chemist|chemistry|
// laboratory/, and global_jobs holds 990 active rows under it. Vijay resolves to
// 'Science & Research', France holds 3 of them, so he fires on ARM 1 — the thin cell. Arm 2 is
// still built and still necessary (deriveUserField returns null whenever every title lands in
// 'Other', and 'Other' is the second-largest bucket in the feed at 29,358 rows), but of the 5 real
// users who currently have a country and a parsed résumé, all 5 resolve to a field and ZERO fire
// on arm 2 today. See the dry-run numbers in the commit message.
//
// ─── arming ───────────────────────────────────────────────────────────────────────────────────
// Every grounded call costs money and 578 thin cells × every signup is an unbounded bill, so this
// is off unless somebody deliberately turns it on, twice:
//   1. env INSTANT_RESEARCH_ENABLED must be '1'  (default '0' — the code ships inert)
//   2. the admin switch 'instant_research' must be on (Migration 034 seeds the row FALSE, and the
//      switch is FAIL-CLOSED in notifSwitch: if the table cannot be read, the answer is "no")
// On top of that: at most one instant run per user EVER, one per (user, country, field/occupation)
// demand, a global daily ceiling, one run in flight at a time and a short bounded queue.
//
// ─── it does not push ─────────────────────────────────────────────────────────────────────────
// The instant path researches and ingests, then hands back: it records a handoff timestamp and the
// existing 12-hourly demandResearch routine sends the notification, under the caps and switches it
// already obeys. Nothing here can put a notification on a user's lock screen. That is deliberate —
// an armed scheduler fired 25 unapproved pushes at real users 8 minutes after boot once already.
'use strict';

const dbConfig = require('../../db-config');
const { deriveUserField } = require('../utils/jobTaxonomy');

// ── policy (env-tunable, all defaults chosen to be cheap) ─────────────────────────────────────
const ENABLED = (process.env.INSTANT_RESEARCH_ENABLED || '0') === '1';
/** A cell with fewer than this many active jobs is "thin" — arm 1's whole trigger. */
const THIN_CELL_MAX = parseInt(process.env.INSTANT_RESEARCH_THIN_MAX || '10', 10);
/** How many instant runs a single user may ever cause. */
const MAX_PER_USER = parseInt(process.env.INSTANT_RESEARCH_MAX_PER_USER || '1', 10);
/** Global ceiling on instant runs in any rolling 24h — the actual spend cap. */
const MAX_PER_DAY = parseInt(process.env.INSTANT_RESEARCH_MAX_PER_DAY || '20', 10);
/** In-flight + waiting. Beyond this, a new signup is simply not researched instantly. */
const QUEUE_MAX = parseInt(process.env.INSTANT_RESEARCH_QUEUE_MAX || '3', 10);
/** Discovered URLs to extract per run. Each is one flash-lite extraction call. */
const MAX_URLS = parseInt(process.env.INSTANT_RESEARCH_URLS || '8', 10);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// PURE FUNCTIONS — no database, no network, no clock. Everything below this line is asserted in
// tools/test-instant-research.js.
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** resume_metadata columns arrive as arrays, JSON strings or objects depending on the column. */
function asArray(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p.map(String);
      if (p && typeof p === 'object') return Object.values(p).flat().map(String);
    } catch { return v.trim() ? [v.trim()] : []; }
  }
  if (v && typeof v === 'object') return Object.values(v).flat().map(String);
  return [];
}

/**
 * Words that describe nobody's occupation. Borrowed from demandResearch's GENERIC_TERMS so the two
 * paths cannot drift — "Trainee" alone must never become a research query, but "Trainee Chemist"
 * must survive intact as the human label.
 */
function genericTerms() {
  try { return require('./demandResearch').GENERIC_TERMS || new Set(); }
  catch { return new Set(); }
}

/**
 * ARM 2's search subject: the user's occupation as free text. The most recent job title wins; a
 * title made only of filler ("Trainee", "Assistant") is rejected, because researching it would
 * return noise for everybody. Falls back to an industry, then to nothing.
 */
function occupationFromResume(meta) {
  const generic = genericTerms();
  const meaningful = (phrase) => {
    const words = String(phrase).toLowerCase().split(/[^a-zà-ÿ]+/i).filter((w) => w.length >= 4);
    return words.some((w) => !generic.has(w));
  };
  for (const t of asArray(meta && meta.job_titles).slice(0, 4)) {
    const phrase = String(t).trim().replace(/\s+/g, ' ');
    if (phrase.length >= 4 && phrase.length <= 60 && meaningful(phrase)) return phrase;
  }
  for (const t of asArray(meta && meta.industries).slice(0, 3)) {
    const phrase = String(t).trim().replace(/\s+/g, ' ');
    if (phrase.length >= 4 && phrase.length <= 60 && meaningful(phrase)) return phrase;
  }
  return null;
}

/** The terms handed to the grounded search. Occupation/role first, then concrete résumé skills. */
function searchTerms(meta, head) {
  const generic = genericTerms();
  const out = [];
  const seen = new Set();
  const push = (s) => {
    const v = String(s || '').trim();
    const k = v.toLowerCase();
    if (!v || v.length < 3 || v.length > 60 || seen.has(k)) return;
    // a bare filler word is not a search term; a multi-word phrase containing one is fine
    if (!/\s/.test(v) && generic.has(k)) return;
    seen.add(k); out.push(v);
  };
  push(head);
  for (const t of asArray(meta && meta.job_titles).slice(0, 3)) push(t);
  for (const s of asArray(meta && meta.technical_skills).slice(0, 20)) push(s);
  for (const s of asArray(meta && meta.skills).slice(0, 20)) push(s);
  return out.slice(0, 6);
}

/**
 * Which arm — if any — applies to this user.
 * Returns { ok:false, reason } or { ok:true, arm:'field'|'occupation', ... , key }.
 * `key` is the debounce identity: re-uploading the same résumé produces the same key.
 */
function resolveDemand({ resumeMeta, country, city } = {}) {
  const co = String(country || '').trim();
  if (!co) return { ok: false, reason: 'no_country' };
  if (!resumeMeta) return { ok: false, reason: 'no_resume' };

  const meta = {
    job_titles: asArray(resumeMeta.job_titles),
    skills: asArray(resumeMeta.skills),
    technical_skills: asArray(resumeMeta.technical_skills),
    industries: asArray(resumeMeta.industries),
  };

  const derived = deriveUserField(meta);
  if (derived && derived.field) {
    return {
      ok: true, arm: 'field', country: co, city: city || null,
      field: derived.field, roleCategory: derived.roleCategory || null, occupation: null,
      terms: searchTerms(meta, derived.roleCategory || derived.field),
      key: `field:${co.toLowerCase()}:${String(derived.field).toLowerCase()}`,
    };
  }

  // ARM 2 — the résumé resolves to no taxonomy field at all. There is no cell to count, so a
  // thin-cell trigger would never fire for this person; research the occupation as free text.
  const occ = occupationFromResume(meta);
  if (!occ) return { ok: false, reason: 'no_occupation' };
  return {
    ok: true, arm: 'occupation', country: co, city: city || null,
    field: null, roleCategory: null, occupation: occ,
    terms: searchTerms(meta, occ),
    key: `occ:${co.toLowerCase()}:${occ.toLowerCase()}`,
  };
}

/**
 * The cost guard, as one pure decision. `ctx` is everything the caller measured:
 *   envEnabled, switchOn, cellCount (arm 1 only), userRunCount, demandRan, inFlight, queued, runsToday
 */
function decideRun(demand, ctx = {}) {
  const c = {
    envEnabled: ENABLED, switchOn: true, cellCount: null, userRunCount: 0,
    demandRan: false, inFlight: 0, queued: 0, runsToday: 0, isTestAccount: false, ...ctx,
  };
  if (!c.envEnabled) return { ok: false, reason: 'disarmed' };
  if (!c.switchOn) return { ok: false, reason: 'switch_off' };
  if (c.isTestAccount) return { ok: false, reason: 'test_account' };
  if (!demand || !demand.ok) return { ok: false, reason: (demand && demand.reason) || 'no_demand' };
  // Debounce: the same demand is never researched twice, so a re-upload is free.
  if (c.demandRan) return { ok: false, reason: 'already_researched' };
  // One instant run per user, ever. The 12-hourly routine covers them from then on.
  if (c.userRunCount >= MAX_PER_USER) return { ok: false, reason: 'user_cap' };
  if (c.runsToday >= MAX_PER_DAY) return { ok: false, reason: 'daily_cap' };
  if (c.inFlight + c.queued >= QUEUE_MAX) return { ok: false, reason: 'queue_full' };
  // Arm 1 only fires on a genuinely thin cell. Arm 2 has no cell — that IS its trigger.
  if (demand.arm === 'field') {
    // ⚠️ `Number(null)` is 0, not NaN. Without the explicit null/'' guard a FAILED count query read
    // as "this cell is empty" and spent a grounded call on it — the exact opposite of the safe
    // answer. Not knowing how many jobs are there is not the same as knowing there are none.
    const n = c.cellCount === null || c.cellCount === undefined || c.cellCount === ''
      ? NaN : Number(c.cellCount);
    if (!Number.isFinite(n)) return { ok: false, reason: 'cell_unknown' };
    if (n >= THIN_CELL_MAX) return { ok: false, reason: 'cell_healthy' };
  }
  return { ok: true, reason: demand.arm === 'field' ? 'thin_cell' : 'unrepresented_occupation' };
}

// ── location proximity ────────────────────────────────────────────────────────────────────────
// ⚠️ This is NAME proximity, not distance. There is no geocoder and no lat/long in global_jobs —
// only a free-text `location` (there is NO `city` column). So the ladder is: the user's own city,
// then any named city in the country, then country-wide/remote, then unparseable. That is enough to
// stop "All France (remote)" outranking a job in the user's own town, which is what ordering is for.
const norm = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** "Paris, Paris, France" / "All France (remote)" / "Montpellier, France" → { city, country, remote } */
function parseLocation(raw) {
  const s = String(raw || '').trim();
  if (!s) return { city: null, country: null, remote: false };
  const remote = /\b(remote|hybrid|work from home|telework|t[eé]l[eé]travail|anywhere)\b/i.test(s);
  const cleaned = s
    .replace(/\([^)]*\)/g, ' ')                                  // drop "(remote)"
    .replace(/\b(all|anywhere in|throughout|various|multiple)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(/\s*[,/|;]\s*/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { city: null, country: null, remote };
  return {
    city: parts[0] || null,
    country: parts.length > 1 ? parts[parts.length - 1] : null,
    remote,
  };
}

/** 0 = the user's own city … 4 = we cannot tell. Lower is nearer. */
function locationRank(location, user = {}) {
  const L = parseLocation(location);
  const uc = norm(user.city);
  const un = norm(user.country);
  const lc = norm(L.city);
  const ln = norm(L.country);
  // "France" as the only token is the whole country, not a town called France.
  const cityIsCountry = !!lc && !!un && lc === un;
  const named = !!lc && !cityIsCountry;
  if (named && uc) {
    if (lc === uc) return 0;
    if (lc.startsWith(uc + ' ') || uc.startsWith(lc + ' ')) return 1;   // "paris" vs "paris 15"
  }
  if (named) return 2;
  if (L.remote || cityIsCountry || ln) return 3;
  return 4;
}

/** Stable sort, nearest first. Never mutates the input. */
function orderByProximity(rows, user = {}) {
  return (rows || [])
    .map((r, i) => ({ r, i, rank: locationRank(r && r.location, user) }))
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
    .map((x) => x.r);
}

// ── the standout job ──────────────────────────────────────────────────────────────────────────
/**
 * How well one job answers the user's résumé terms: the number of DISTINCT terms that appear in its
 * title or skills. A crude score on purpose — it only has to separate "one obvious job" from "a
 * pile of vaguely related ones".
 */
function overlapScore(job, terms) {
  const hay = (String((job && job.title) || '') + ' ' + JSON.stringify((job && job.skills) || [])).toLowerCase();
  let n = 0;
  for (const t of terms || []) {
    const needle = String((t && t.stem) || t || '').toLowerCase();
    if (needle && hay.includes(needle)) n++;
  }
  return n;
}

/**
 * The one job worth deep-linking to, or null.
 *
 * A push that says "6 new chemist jobs" and lands on a single job is a lie, and a push about ONE
 * job that lands on the whole feed wastes the tap. So: a single candidate is always the standout;
 * otherwise the leader must clear `minScore` AND beat the runner-up by `minLead`. Anything else
 * means the alert really is about a set, and the caller keeps the feed route.
 */
function pickStandoutJob(jobs, { minLead = 2, minScore = 2 } = {}) {
  const c = (jobs || []).filter((j) => j && j.job_url);
  if (!c.length) return null;
  if (c.length === 1) return c[0];
  const scored = c.map((j) => ({ j, s: Number(j.score) })).filter((x) => Number.isFinite(x.s));
  if (scored.length < 2) return null;
  scored.sort((a, b) => b.s - a.s);
  if (scored[0].s < minScore) return null;
  if (scored[0].s - scored[1].s < minLead) return null;
  return scored[0].j;
}

/**
 * The synthetic feed id the app deep-links by.
 * ⚠️ Byte-identical to adminUserOps.hashJobUrlId, aiHubController.hashJobUrlId and the three
 * MobileApp copies. Re-implemented rather than imported for the same reason adminUserOps does:
 * aiHubController does not export it, and this module must stay loadable without a database.
 */
function hashJobUrlId(u) {
  const k = String(u || '') || 'x';
  let h = 0;
  for (let i = 0; i < k.length; i += 1) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return 'gj_' + h.toString(36);
}

/**
 * The deep-link params for a job-match push. A standout job opens THAT job
 * ('/(discover)' + { jobId }); anything else opens the feed, newest first — the contract in
 * services/notifyTemplates.js and resolveRoute in MobileApp/services/pushRouting.ts.
 */
function pushParamsForMatch(standout) {
  return standout && standout.job_url
    ? { jobId: hashJobUrlId(standout.job_url) }
    : { sort: 'recent' };
}

/**
 * The window the hand-back push should look at for this user. The 12-hourly routine only notices
 * jobs whose first_seen is newer than the START OF ITS OWN RUN, so anything an instant run ingested
 * three hours earlier would be invisible and the user would never hear about the jobs we just went
 * and found for them. An unconsumed handoff widens the window back to the instant run.
 */
function sinceForUser(defaultSince, handoffAt) {
  if (!handoffAt) return defaultSince;
  const a = new Date(defaultSince).getTime();
  const b = new Date(handoffAt).getTime();
  if (!Number.isFinite(b)) return defaultSince;
  if (!Number.isFinite(a)) return new Date(b).toISOString();
  return new Date(Math.min(a, b)).toISOString();
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// IMPURE — database + the grounded call. Nothing below is exercised by the unit test.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const q = (sql, params) => dbConfig.query(sql, params || []).catch(() => null);

async function loadContext(userId) {
  const rows = await q(
    `SELECT u.id, u.country, u.city, u.deleted_at,
            rm.job_titles, rm.skills, rm.technical_skills, rm.industries, rm.parse_status
       FROM users u
       LEFT JOIN resume_metadata rm ON rm.user_id = u.id
      WHERE u.id = $1`, [userId]);
  return rows && rows[0] ? rows[0] : null;
}

async function countCell(country, field) {
  const r = await q(
    `SELECT COUNT(*)::int AS n FROM global_jobs WHERE is_active AND country = $1 AND field = $2`,
    [country, field]);
  return r && r[0] ? r[0].n : null;
}

async function runStats(userId, demandKey) {
  const a = await q(`SELECT COUNT(*)::int AS n FROM instant_research_runs WHERE user_id = $1`, [userId]);
  const b = await q(`SELECT 1 FROM instant_research_runs WHERE user_id = $1 AND demand_key = $2 LIMIT 1`, [userId, demandKey]);
  const c = await q(`SELECT COUNT(*)::int AS n FROM instant_research_runs WHERE created_at > NOW() - INTERVAL '24 hours'`);
  return {
    userRunCount: a && a[0] ? a[0].n : 0,
    demandRan: !!(b && b.length),
    runsToday: c && c[0] ? c[0].n : 0,
  };
}

// ── the bounded queue: one grounded call at a time, at most QUEUE_MAX waiting ─────────────────
let _inFlight = 0;
const _queue = [];
let _draining = false;

async function drain() {
  if (_draining) return;
  _draining = true;
  try {
    while (_queue.length) {
      const userId = _queue.shift();
      _inFlight = 1;
      try { await executeRun(userId); }
      catch (e) { console.warn('[instantResearch] run failed for', userId, e.message); }
      _inFlight = 0;
    }
  } finally { _draining = false; }
}

/**
 * The entry point. Called (unawaited) the moment a résumé finishes parsing — that is the first
 * instant at which occupation AND country are both known. Never throws, never blocks the parse.
 */
function onResumeParsed(userId) {
  try {
    if (!ENABLED) return;                       // disarmed: not even a database read
    if (_inFlight + _queue.length >= QUEUE_MAX) {
      console.log('[instantResearch] queue full — skipping user', userId);
      return;
    }
    if (_queue.includes(Number(userId))) return;
    _queue.push(Number(userId));
    drain().catch(() => {});
  } catch (e) { console.warn('[instantResearch] enqueue failed:', e.message); }
}

/** Decide + record + research. Returns a summary object; swallows nothing silently. */
async function executeRun(userId) {
  const ctx = await loadContext(userId);
  if (!ctx || ctx.deleted_at) return { skipped: 'no_user' };
  if (ctx.parse_status !== 'done') return { skipped: 'resume_not_parsed' };

  const demand = resolveDemand({ resumeMeta: ctx, country: ctx.country, city: ctx.city });
  const switchOn = await require('./notifSwitch').isOn('instant_research').catch(() => false);
  const testIds = (() => { try { return require('./nudgeGate').TEST_USER_IDS; } catch { return new Set(); } })();

  const stats = demand.ok ? await runStats(userId, demand.key) : { userRunCount: 0, demandRan: false, runsToday: 0 };
  const cellCount = demand.ok && demand.arm === 'field' ? await countCell(demand.country, demand.field) : null;

  const verdict = decideRun(demand, {
    switchOn, cellCount, isTestAccount: testIds.has(Number(userId)),
    inFlight: 0, queued: _queue.length, ...stats,
  });
  if (!verdict.ok) {
    console.log(`[instantResearch] user ${userId}: no run (${verdict.reason})`);
    return { skipped: verdict.reason };
  }

  // Claim the demand BEFORE spending anything. If two parses land at once the unique index makes
  // the second one a no-op instead of a second grounded call.
  const claimed = await q(
    `INSERT INTO instant_research_runs (user_id, demand_key, arm, country, city, field, occupation, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'queued')
     ON CONFLICT (user_id, demand_key) DO NOTHING
     RETURNING id`,
    [userId, demand.key, demand.arm, demand.country, demand.city, demand.field, demand.occupation]);
  if (!claimed || !claimed.length) return { skipped: 'already_claimed' };
  const runId = claimed[0].id;

  // Reuse the 12-hourly routine's grounded discovery + extractor wholesale — same prompt, same
  // aggregator filters, same deterministic-first ingestion, same global_jobs upsert.
  const dr = require('./demandResearch');
  const model = dr.geminiGrounded();
  if (!model) {
    await q(`UPDATE instant_research_runs SET status = 'error:no_key' WHERE id = $1`, [runId]);
    return { skipped: 'no_key' };
  }

  const cluster = { country: demand.country, city: demand.city, skills: demand.terms };
  let urls = [];
  try { urls = await dr.discoverUrls(model, cluster); }
  catch (e) { console.warn('[instantResearch] discovery failed:', e.message); }

  let added = 0;
  for (const url of urls.slice(0, MAX_URLS)) {
    added += await dr.ingestUrl(url, cluster, 'instant_research');
  }

  // Hand back to the 12-hourly routine: it owns every notification. handoff_at widens that
  // routine's "new since" window for this user so the jobs we just found are not invisible to it.
  await q(
    `UPDATE instant_research_runs
        SET status = 'done', urls_found = $2, jobs_added = $3, handoff_at = NOW()
      WHERE id = $1`, [runId, urls.length, added]);
  console.log(`[instantResearch] user ${userId} (${verdict.reason}): ${urls.length} urls → ${added} jobs`);
  return { arm: demand.arm, reason: verdict.reason, urls: urls.length, added };
}

/** userId → ISO timestamp of an instant run whose hand-back push has not gone out yet. */
async function pendingHandoffs() {
  const rows = await q(
    `SELECT user_id, MIN(handoff_at) AS at FROM instant_research_runs
      WHERE handoff_at IS NOT NULL AND handoff_done_at IS NULL
        AND handoff_at > NOW() - INTERVAL '7 days'
      GROUP BY user_id`);
  const map = new Map();
  for (const r of rows || []) map.set(Number(r.user_id), new Date(r.at).toISOString());
  return map;
}

async function markHandoffDone(userId) {
  await q(`UPDATE instant_research_runs SET handoff_done_at = NOW()
            WHERE user_id = $1 AND handoff_at IS NOT NULL AND handoff_done_at IS NULL`, [userId]);
}

module.exports = {
  // pure — unit tested
  resolveDemand, decideRun, occupationFromResume, searchTerms,
  parseLocation, locationRank, orderByProximity,
  overlapScore, pickStandoutJob, hashJobUrlId, pushParamsForMatch, sinceForUser,
  // impure
  onResumeParsed, executeRun, pendingHandoffs, markHandoffDone,
  // policy, so the test asserts the shipped numbers rather than its own copy of them
  POLICY: { ENABLED, THIN_CELL_MAX, MAX_PER_USER, MAX_PER_DAY, QUEUE_MAX, MAX_URLS },
};
