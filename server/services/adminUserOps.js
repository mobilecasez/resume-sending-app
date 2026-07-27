// Admin USER OPS — ADDITIVE, read-mostly. Everything the admin user-detail page and the segment
// notifier need: a 360° view of one user (profile, files, credits, résumé, activity, push state),
// the jobs that actually match their résumé, and a safe way to send them (or a whole segment) a
// push notification.
//
// SAFETY RAILS baked in here, not in the controller — so no caller can skip them:
//   • notification_preferences opt-outs are honoured (per-template category column)
//   • the same template is never sent to the same user twice inside DEDUPE_HOURS
//   • bulk sends require confirm:true; without it only a dry-run preview is produced
//   • bulk sends are hard-capped (default 500, ceiling 2000) and NEVER silently truncated —
//     every response says what was capped and what the true total was
//   • soft-deleted users (users.deleted_at IS NOT NULL) are excluded everywhere
//   • every send is written to admin_notification_log (Migration 026)
//
// Schema defensiveness: several tables this reads are created lazily elsewhere (user_saved_jobs,
// notification_preferences) or arrived in later migrations (app_events, global_jobs, resume_metadata).
// Missing tables degrade to a null/zero section instead of 500-ing the whole page.
'use strict';

const path = require('path');
const fs = require('fs');
const dbConfig = require('../../db-config');
const notifPrefs = require('./notificationPrefs');
const expoPush = require('./expoPushService');
const templates = require('./notifyTemplates');
const { deriveUserField } = require('../utils/jobTaxonomy');

const DEDUPE_HOURS = 72;              // never repeat a template to the same user inside this window
const DEFAULT_MAX_RECIPIENTS = 500;   // bulk-send default cap
const ABSOLUTE_MAX_RECIPIENTS = 2000; // bulk-send hard ceiling
const BASE_CAP = 1500;                // same candidate pool the user's own Explore feed ranks
const MIN_MATCH = 10;                 // same floor the user's default feed applies
const SEND_CONCURRENCY = 4;
// A reservation row (push_ok IS NULL) that is older than this was abandoned by a crashed process —
// it must stop blocking its (user, template) pair, because the partial unique index that makes the
// reservation atomic has no time component (index predicates must be IMMUTABLE).
const RESERVATION_TTL_MIN = 10;
// getSegmentUsers is also the bulk-send selector, so its own ceiling must never sit BELOW the
// bulk-send ceiling — otherwise a maxRecipients of 1001-2000 would be silently clamped twice.
const SEGMENT_LIST_CEILING = Math.max(1000, ABSOLUTE_MAX_RECIPIENTS);

const GJ_FIELDS = `job_url, title, employer_name, employer_domain, location, work_mode, job_type,
  salary, experience, skills, field, role_category, seniority, country, last_seen`;

// ─────────────────────────────────────────────────────────────────────────────
// schema probes (cached; negatives re-checked so lazily-created tables are picked up)
// ─────────────────────────────────────────────────────────────────────────────
const _tbl = new Map();
async function tableExists(name) {
  const hit = _tbl.get(name);
  if (hit && (hit.ok || Date.now() - hit.at < 60000)) return hit.ok;
  let ok = false;
  try {
    const r = await dbConfig.get(`SELECT to_regclass($1) AS t`, ['public.' + name]);
    ok = !!(r && r.t);
  } catch (e) { ok = false; }
  _tbl.set(name, { ok, at: Date.now() });
  return ok;
}

// The partial unique index the send reservation relies on to decide a race. Cached like tableExists:
// a positive result is permanent, a negative is re-checked, so a database that gets the index later
// (Migration 026 running after boot) starts benefiting without a restart.
const INFLIGHT_INDEX = 'uq_admin_notif_log_inflight';
async function inflightIndexExists() {
  return tableExistsRaw(INFLIGHT_INDEX);
}
async function tableExistsRaw(name) {
  const hit = _tbl.get('idx:' + name);
  if (hit && (hit.ok || Date.now() - hit.at < 60000)) return hit.ok;
  let ok = false;
  try {
    const r = await dbConfig.get(`SELECT to_regclass($1) AS t`, ['public.' + name]);
    ok = !!(r && r.t);
  } catch (e) { ok = false; }
  _tbl.set('idx:' + name, { ok, at: Date.now() });
  return ok;
}
const _col = new Map();
async function columnExists(table, column) {
  const k = table + '.' + column;
  const hit = _col.get(k);
  if (hit && (hit.ok || Date.now() - hit.at < 60000)) return hit.ok;
  let ok = false;
  try {
    const r = await dbConfig.get(
      `SELECT 1 AS x FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
      [table, column]);
    ok = !!r;
  } catch (e) { ok = false; }
  _col.set(k, { ok, at: Date.now() });
  return ok;
}
// "u.deleted_at IS NULL" when the column exists, else a harmless TRUE.
async function liveUsersSql(alias = 'u') {
  return (await columnExists('users', 'deleted_at')) ? `${alias}.deleted_at IS NULL` : 'TRUE';
}

const q = async (sql, params = []) => { try { return (await dbConfig.query(sql, params)) || []; } catch (e) { return null; } };
const g = async (sql, params = []) => { try { return await dbConfig.get(sql, params); } catch (e) { return null; } };
// int(v, d): d is returned for anything that is not a real number-ish value.
// ⚠️ Number() coerces null / '' / '   ' / false / [] to 0, all of which are finite — so a naive
// Number.isFinite(Number(v)) test NEVER reaches the default and turns "unset" into 0. That is how a
// JSON body of { maxRecipients: null } used to collapse the bulk-send cap to 1 recipient.
const int = (v, d = 0) => {
  if (v === null || v === undefined) return d;
  if (typeof v === 'boolean' || Array.isArray(v)) return d;
  if (typeof v === 'string' && !v.trim()) return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const daysSince = (ts) => (ts ? Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 86400000)) : null);
// TEXT[] / JSONB / json-string / object → a plain array (resume_metadata mixes all of these).
const arr = (v) => {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null);
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    try { const p = JSON.parse(s); return Array.isArray(p) ? p : [p]; } catch (e) { return [s]; }
  }
  if (typeof v === 'object') return Object.values(v);
  return [v];
};

// ─────────────────────────────────────────────────────────────────────────────
// user row (SELECT * + JS allowlist, so a DB missing a late-migration column still works)
// ─────────────────────────────────────────────────────────────────────────────
const PUBLIC_USER_FIELDS = ['id', 'full_name', 'email', 'phone_number', 'date_of_birth', 'address', 'city',
  'country', 'gender', 'nationality', 'oauth_provider', 'role', 'created_at', 'last_seen_at',
  'registration_ip', 'last_login_ip'];

async function loadUser(userId) {
  const id = int(userId, 0);
  if (!id) return null;
  const u = await g(`SELECT * FROM users WHERE id = $1`, [id]);
  if (!u) return null;
  if (u.deleted_at) return null;   // soft-deleted users are invisible to every endpoint here
  return u;
}
function publicUser(u) {
  const out = {};
  for (const f of PUBLIC_USER_FIELDS) out[f] = u[f] === undefined ? null : u[f];
  return out;
}
const hasToken = (u) => /^Expo(nent)?PushToken\[/.test(String((u && u.expo_push_token) || ''));

// ─────────────────────────────────────────────────────────────────────────────
// completeness — 7 slots, identical definition to the SQL version used in segment lists
// ─────────────────────────────────────────────────────────────────────────────
const COMPLETENESS_SLOTS = [
  ['full_name', (u) => !!String(u.full_name || '').trim()],
  ['phone_number', (u) => !!String(u.phone_number || '').trim()],
  ['address', (u) => !!String(u.address || '').trim()],
  ['date_of_birth', (u) => !!u.date_of_birth],
  ['resume', (u) => !!String(u.resume_path || '').trim()],
  ['photo', (u) => !!String(u.photo_path || '').trim()],
  ['signature', (u) => !!String(u.signature_path || '').trim()],
];
function completenessOf(u) {
  const missing = COMPLETENESS_SLOTS.filter(([, has]) => !has(u)).map(([k]) => k);
  const have = COMPLETENESS_SLOTS.length - missing.length;
  return { percent: Math.round((100 * have) / COMPLETENESS_SLOTS.length), missing };
}
const COMPLETENESS_SQL = `round(100.0 * (
  (CASE WHEN u.full_name IS NOT NULL AND u.full_name <> '' THEN 1 ELSE 0 END) +
  (CASE WHEN u.phone_number IS NOT NULL AND u.phone_number <> '' THEN 1 ELSE 0 END) +
  (CASE WHEN u.address IS NOT NULL AND u.address <> '' THEN 1 ELSE 0 END) +
  (CASE WHEN u.date_of_birth IS NOT NULL THEN 1 ELSE 0 END) +
  (CASE WHEN u.resume_path IS NOT NULL AND u.resume_path <> '' THEN 1 ELSE 0 END) +
  (CASE WHEN u.photo_path IS NOT NULL AND u.photo_path <> '' THEN 1 ELSE 0 END) +
  (CASE WHEN u.signature_path IS NOT NULL AND u.signature_path <> '' THEN 1 ELSE 0 END)
) / 7.0)::int`;

// ─────────────────────────────────────────────────────────────────────────────
// gj_ synthetic job ids
// ⚠️ Byte-identical to aiHubController.hashJobUrlId and the three MobileApp copies
// (SavedJobsList.tsx, (discover)/index.tsx hashId, (ai-hub)/index.tsx savedHashId).
// Re-implemented (not imported) because aiHubController does not export it.
// ─────────────────────────────────────────────────────────────────────────────
function hashJobUrlId(u) {
  const k = String(u || '') || 'x';
  let h = 0;
  for (let i = 0; i < k.length; i += 1) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return 'gj_' + h.toString(36);
}
function urlAliasIds(rawUrl) {
  const raw = String(rawUrl || '');
  let clean = raw;
  try { const x = new URL(raw); clean = (x.origin + x.pathname).replace(/\/+$/, ''); }
  catch (e) { clean = raw.split('?')[0].split('#')[0].replace(/\/+$/, ''); }
  return [...new Set([hashJobUrlId(raw), hashJobUrlId(clean)])];
}

// global_jobs has no gj_ column and cannot index one, so a gj_ id is resolved by:
//   1. an exact hit in admin_notification_log.params->>'jobUrl' (we store the URL when we send), then
//   2. a cached hash of the freshest GJ_SCAN_LIMIT job_urls.
// Never silently gives up: `truncated` says when the scan hit its ceiling without a hit.
const GJ_SCAN_LIMIT = 60000;
let _hashCache = { at: 0, map: new Map(), scanned: 0 };
async function hashIndex() {
  if (Date.now() - _hashCache.at < 10 * 60 * 1000 && _hashCache.map.size) return _hashCache;
  if (!(await tableExists('global_jobs'))) return { at: Date.now(), map: new Map(), scanned: 0 };
  const rows = await q(`SELECT job_url FROM global_jobs ORDER BY last_seen DESC LIMIT ${GJ_SCAN_LIMIT}`);
  const map = new Map();
  for (const r of rows || []) for (const a of urlAliasIds(r.job_url)) if (!map.has(a)) map.set(a, r.job_url);
  _hashCache = { at: Date.now(), map, scanned: (rows || []).length };
  return _hashCache;
}
async function resolveGlobalJobHash(gjId) {
  const id = String(gjId || '').trim();
  if (!/^gj_/i.test(id)) return { job_url: null, truncated: false, via: null };
  if (await tableExists('admin_notification_log')) {
    const r = await g(
      `SELECT params->>'jobUrl' AS job_url FROM admin_notification_log
        WHERE params->>'jobId' = $1 AND params->>'jobUrl' IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`, [id]);
    if (r && r.job_url) return { job_url: r.job_url, truncated: false, via: 'notification_log' };
  }
  const idx = await hashIndex();
  const hit = idx.map.get(id);
  return {
    job_url: hit || null,
    truncated: !hit && idx.scanned >= GJ_SCAN_LIMIT,
    via: hit ? 'hash_scan' : null,
    scanned: idx.scanned,
  };
}

function mapGlobalJob(r) {
  return {
    id: hashJobUrlId(r.job_url),
    job_url: r.job_url,
    url: r.job_url,
    title: r.title,
    employer_name: r.employer_name,
    company: r.employer_name,
    employer_domain: r.employer_domain,
    location: r.location,
    work_mode: r.work_mode,
    job_type: r.job_type,
    salary: r.salary,
    experience: r.experience,
    skills: Array.isArray(r.skills) ? r.skills : arr(r.skills),
    field: r.field,
    role_category: r.role_category,
    seniority: r.seniority,
    country: r.country,
    last_seen: r.last_seen,
    match: r.match == null ? null : Number(r.match),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// résumé match — reuses discoverController.matchExprSql VERBATIM so an admin-visible
// score is the same number the user sees in Explore. Lazy require avoids a cycle
// (discoverController.getGlobalJobById requires this module back).
// ─────────────────────────────────────────────────────────────────────────────
function disc() { return require('../controllers/discoverController'); }

async function resumeContext(userId) {
  const d = disc();
  const resume = await d.getResume(userId);
  const skills = d.skillsOf(resume);
  const fieldObj = deriveUserField(resume);
  return { resume, skills, field: fieldObj ? fieldObj.field : null, roleCategory: fieldObj ? fieldObj.roleCategory : null };
}

// Ranked global_jobs for a user's skills. Mirrors the user's own default Explore view:
// freshest BASE_CAP candidates → per-employer diversity → min-match floor → best match first.
async function rankedJobs(userSkills, { field = null, limit = 20, minMatch = MIN_MATCH } = {}) {
  if (!userSkills || !userSkills.length) return { jobs: [], total: 0, strong: 0 };
  if (!(await tableExists('global_jobs'))) return { jobs: [], total: 0, strong: 0, unavailable: 'global_jobs table missing' };
  const params = [];
  const P = (v) => { params.push(v); return '$' + params.length; };
  const matchExpr = disc().matchExprSql(P(userSkills));   // pushes the skills array ONCE, reused 3×
  const where = ['is_active'];
  if (field) where.push(`field = ${P(field)}`);
  const lim = Math.min(Math.max(int(limit, 20), 1), 100);
  const floor = Math.min(Math.max(int(minMatch, 0), 0), 100);
  const sql = `
    WITH base AS (
      SELECT ${GJ_FIELDS}, ${matchExpr} AS match
      FROM global_jobs WHERE ${where.join(' AND ')}
      ORDER BY last_seen DESC LIMIT ${BASE_CAP}
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY employer_name ORDER BY match DESC NULLS LAST, last_seen DESC) AS rn
      FROM base
    ), filtered AS (
      SELECT * FROM ranked WHERE match >= ${floor}
    )
    SELECT ${GJ_FIELDS}, match,
           COUNT(*) OVER ()::int AS total_filtered,
           (COUNT(*) FILTER (WHERE match >= 50) OVER ())::int AS strong_total
    FROM filtered
    ORDER BY match DESC NULLS LAST, rn ASC, last_seen DESC
    LIMIT ${P(lim)}`;
  const rows = await q(sql, params);
  if (!rows) return { jobs: [], total: 0, strong: 0, unavailable: 'match query failed' };
  return {
    jobs: rows.map(mapGlobalJob),
    total: rows.length ? int(rows[0].total_filtered) : 0,
    strong: rows.length ? int(rows[0].strong_total) : 0,
  };
}

// Best jobs for a résumé context, in three stages:
//   1. field-scoped, MIN_MATCH floor — that IS the user's own default Explore view;
//   2. unscoped, SAME floor — a résumé field like "IT & Software" only matches jobs the taxonomy
//      classified the same way, and an empty scope must not read as "no matches";
//   3. unscoped with NO floor — an admin-only "show me anything" view, flagged advertisable:false.
// ⚠️ Stage 3 can return a job scoring 0%. Nothing user-facing may quote that number, so callers must
// check `advertisable` before putting a match % (or a "top match") in a notification. Stage 3 used to
// be stage 2, which is how best_matches could advertise a 0% "top match".
async function bestJobsFor(rc, limit) {
  let out = await rankedJobs(rc.skills, { field: rc.field, limit });
  let scope = rc.field || 'all';
  if (!out.jobs.length && rc.field) {
    out = await rankedJobs(rc.skills, { field: null, limit });
    scope = `all (no jobs in the "${rc.field}" scope)`;
  }
  if (out.jobs.length) return { ...out, scope, floor: MIN_MATCH, advertisable: true };
  const any = await rankedJobs(rc.skills, { field: null, limit, minMatch: 0 });
  return {
    ...any,
    scope: `all, unfiltered (nothing reaches the ${MIN_MATCH}% floor)`,
    floor: 0,
    advertisable: false,
  };
}

// GET /api/admin/users/:id/matched-jobs
async function getMatchedJobs(userId, limit = 20) {
  const u = await loadUser(userId);
  if (!u) return { notFound: true };
  const rc = await resumeContext(u.id);
  if (!rc.skills.length) return { noProfile: true, jobs: [], reason: 'No parsed résumé skills — the app shows this user no match scores either.' };
  const out = await bestJobsFor(rc, limit);
  const scope = out.scope;
  return {
    noProfile: false,
    jobs: out.jobs,
    total: out.total,
    strongMatches: out.strong,
    scope,
    matchFloor: out.floor,
    advertisable: out.advertisable,
    userField: rc.field,
    candidatePool: BASE_CAP,
    note: `Ranked over the freshest ${BASE_CAP} active jobs — the same pool and formula the user's Explore feed uses.`
      + (out.advertisable ? '' : ` ⚠️ Nothing clears the ${MIN_MATCH}% floor — these are shown unfiltered for inspection and must NOT be quoted in a notification.`),
    unavailable: out.unavailable || undefined,
  };
}

// One job, for the specific_job template / the deep link.
async function resolveJob(userId, jobId) {
  const raw = String(jobId || '').trim();
  if (!raw) return null;
  let url = null;
  let truncated = false;
  if (/^https?:\/\//i.test(raw)) url = raw;
  else if (/^gj_/i.test(raw)) { const r = await resolveGlobalJobHash(raw); url = r.job_url; truncated = r.truncated; }
  else url = raw;   // tolerate a bare url without scheme
  if (!url) return { notFound: true, truncated };
  if (!(await tableExists('global_jobs'))) return { notFound: true, truncated: false };
  const rc = userId ? await resumeContext(userId) : { skills: [] };
  const params = [];
  const P = (v) => { params.push(v); return '$' + params.length; };
  const matchExpr = rc.skills.length ? disc().matchExprSql(P(rc.skills)) : 'NULL::int';
  const row = await g(
    `SELECT ${GJ_FIELDS}, is_active, ${matchExpr} AS match FROM global_jobs WHERE job_url = ${P(url)} LIMIT 1`, params);
  if (!row) return { notFound: true, truncated };
  return { ...mapGlobalJob(row), is_active: row.is_active };
}

// ─────────────────────────────────────────────────────────────────────────────
// per-user state — powers template relevance AND the overview page
// ─────────────────────────────────────────────────────────────────────────────
// The fields a state can carry using NOTHING but the users row already in hand (zero queries).
// Everything else costs at least one round trip — see stateTierFor().
const LIGHT_STATE_FIELDS = ['userId', 'fullName', 'firstName', 'email', 'createdAt', 'daysSinceSignup',
  'hasResume', 'hasPhoto', 'hasSignature', 'completeness', 'hasPushToken'];
// Needs the expensive ranked-match query (a correlated skill-overlap scan of BASE_CAP jobs).
const MATCH_STATE_FIELDS = ['strongMatches', 'matchedJobCount', 'topMatch'];
// Needs cheap-but-real queries (counts, résumé metadata, credits, the field's weekly job count).
const DB_STATE_FIELDS = ['hasParsedResume', 'parseStatus', 'resumeSkillCount', 'field', 'roleCategory',
  'credits', 'creditsExpireInDays', 'platform', 'savedJobs', 'coverLetters', 'coverLetters7d',
  'appliedCoverLetters', 'applications', 'applications7d', 'searches', 'events30d', 'firstEvent',
  'lastEvent', 'daysSinceLastSeen', 'newJobsThisWeek', 'pendingApplication'];

// A state built from the user row alone. Every DB-backed field is present with a neutral value so a
// template that reads one cannot crash — but stateTierFor() only hands this to templates that read
// NONE of them, and exercise.js asserts light copy === full copy for every such template.
function lightUserState(u) {
  return {
    userId: u.id,
    fullName: u.full_name || '',
    firstName: String(u.full_name || '').trim().split(/\s+/)[0] || '',
    email: u.email,
    createdAt: u.created_at,
    daysSinceSignup: daysSince(u.created_at),
    hasResume: !!String(u.resume_path || '').trim(),
    hasPhoto: !!String(u.photo_path || '').trim(),
    hasSignature: !!String(u.signature_path || '').trim(),
    completeness: completenessOf(u),
    hasPushToken: hasToken(u),
    hasParsedResume: false, parseStatus: null, resumeSkillCount: 0, field: null, roleCategory: null,
    credits: 0, creditsExpireInDays: null, platform: null, savedJobs: 0, coverLetters: 0,
    coverLetters7d: 0, appliedCoverLetters: 0, applications: 0, applications7d: 0, searches: 0,
    events30d: 0, firstEvent: null, lastEvent: null, daysSinceLastSeen: null,
    strongMatches: 0, matchedJobCount: 0, topMatch: null, newJobsThisWeek: 0, pendingApplication: null,
    light: true,
  };
}

// How much state does rendering THIS template actually require? templates.render() only calls
// title/body/params, so only those three decide the tier. A template may also declare
// `stateTier`/`needsMatchData` explicitly; anything unreadable falls back to the full (safe) tier —
// a bulk send must never quietly render worse copy than a single send.
const _tier = new Map();
function stateTierFor(tpl) {
  if (!tpl) return 'full';
  if (_tier.has(tpl.key)) return _tier.get(tpl.key);
  let tier = 'full';
  try {
    if (typeof tpl.stateTier === 'string' && ['light', 'basic', 'full'].includes(tpl.stateTier)) {
      tier = tpl.stateTier;
    } else if (tpl.needsJob || tpl.needsMatchData === true) {
      tier = 'full';
    } else {
      const parts = [tpl.title, tpl.body, tpl.params].filter((f) => typeof f === 'function' || typeof f === 'string');
      if (!parts.length) throw new Error('template exposes no readable title/body/params');
      const src = parts.map((f) => (typeof f === 'function' ? Function.prototype.toString.call(f) : String(f))).join('\n');
      const uses = (list) => list.some((k) => new RegExp('\\b' + k + '\\b').test(src));
      if (uses(MATCH_STATE_FIELDS)) tier = 'full';
      else if (uses(DB_STATE_FIELDS)) tier = 'basic';
      else tier = 'light';
    }
  } catch (e) { tier = 'full'; }
  _tier.set(tpl.key, tier);
  return tier;
}

// Build exactly as much state as the template will read — the whole point of the tiers is that a
// 500-recipient blast of a "add your photo" reminder costs 500 cheap user lookups, not 500 correlated
// skill-overlap scans. `shared` memoises everything that is NOT per-user (currently the per-field
// weekly job count) across a batch.
async function stateForTemplate(tpl, u, shared) {
  const tier = stateTierFor(tpl);
  if (tier === 'light') return lightUserState(u);
  return buildUserState(u, { withMatches: tier === 'full', shared });
}

async function buildUserState(userIdOrRow, opts = {}) {
  const u = typeof userIdOrRow === 'object' && userIdOrRow ? userIdOrRow : await loadUser(userIdOrRow);
  if (!u) return null;
  const id = u.id;
  const withMatches = opts.withMatches !== false;
  const shared = opts.shared || null;

  const [meta, credits, saved, letters, apps, searches, lastEvent, pending] = await Promise.all([
    (await tableExists('resume_metadata')) ? g(`SELECT * FROM resume_metadata WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [id]) : null,
    g(`SELECT credits_remaining, credits_total, expiry_date, last_purchase_date FROM user_credits WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [id]),
    (await tableExists('user_saved_jobs')) ? g(`SELECT COUNT(*)::int n FROM user_saved_jobs WHERE user_id = $1`, [id]) : null,
    (await tableExists('job_cover_letters'))
      ? g(`SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE status = 'applied')::int applied,
                  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int n7
             FROM job_cover_letters WHERE user_id = $1`, [id]) : null,
    (await tableExists('application_history'))
      ? g(`SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE sent_date > NOW() - INTERVAL '7 days')::int n7
             FROM application_history WHERE user_id = $1 AND deleted_at IS NULL`, [id]) : null,
    (await tableExists('app_events')) ? g(`SELECT COUNT(*)::int n FROM app_events WHERE user_id = $1 AND event = 'job_search'`, [id]) : null,
    (await tableExists('app_events')) ? g(`SELECT MAX(created_at) AS last, MIN(created_at) AS first,
             COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int n30,
             (SELECT platform FROM app_events WHERE user_id = $1 AND platform IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS platform
             FROM app_events WHERE user_id = $1`, [id]) : null,
    (await tableExists('application_history'))
      ? g(`SELECT company_name, GREATEST(0, EXTRACT(DAY FROM (NOW() - sent_date))::int) AS days
             FROM application_history
            WHERE user_id = $1 AND deleted_at IS NULL AND COALESCE(reply_received, 0) = 0
              AND sent_date IS NOT NULL AND sent_date < NOW() - INTERVAL '7 days'
            ORDER BY sent_date DESC LIMIT 1`, [id]) : null,
  ]);

  const parseStatus = meta ? meta.parse_status : null;
  const rc = await resumeContext(id);
  const applicationsFromLetters = letters ? int(letters.applied) : 0;
  const applications = Math.max(apps ? int(apps.n) : 0, applicationsFromLetters);

  let strongMatches = 0;
  let matchedJobCount = 0;
  let topMatch = null;
  if (withMatches && rc.skills.length) {
    const r = await bestJobsFor(rc, 1);
    // ⚠️ Every one of these three is ADVERTISED to the user ("4 strong matches waiting", "72% match
    // — Senior Python Engineer"), so all three must come from a result that cleared a real floor.
    // The unfiltered stage-3 fallback exists for the admin's eyes only.
    strongMatches = r.advertisable ? r.strong : 0;
    matchedJobCount = r.advertisable ? r.total : 0;
    const best = r.jobs[0] || null;
    topMatch = (r.advertisable && best && int(best.match, 0) >= MIN_MATCH) ? best : null;
  }
  let newJobsThisWeek = 0;
  if (rc.field && (await tableExists('global_jobs'))) {
    const cache = shared && shared.newJobsByField instanceof Map ? shared.newJobsByField : null;
    if (cache && cache.has(rc.field)) {
      newJobsThisWeek = cache.get(rc.field);
    } else {
      const r = await g(`SELECT COUNT(*)::int n FROM global_jobs WHERE is_active AND field = $1 AND first_seen > NOW() - INTERVAL '7 days'`, [rc.field]);
      newJobsThisWeek = r ? int(r.n) : 0;
      if (cache) cache.set(rc.field, newJobsThisWeek);
    }
  }

  const expiry = credits && credits.expiry_date ? credits.expiry_date : null;
  const expireInDays = expiry ? Math.max(0, Math.ceil((new Date(expiry).getTime() - Date.now()) / 86400000)) : null;

  return {
    userId: id,
    fullName: u.full_name || '',
    firstName: String(u.full_name || '').trim().split(/\s+/)[0] || '',
    email: u.email,
    createdAt: u.created_at,
    daysSinceSignup: daysSince(u.created_at),
    hasResume: !!String(u.resume_path || '').trim(),
    hasParsedResume: rc.skills.length > 0,
    parseStatus,
    resumeSkillCount: rc.skills.length,
    field: rc.field,
    roleCategory: rc.roleCategory,
    hasPhoto: !!String(u.photo_path || '').trim(),
    hasSignature: !!String(u.signature_path || '').trim(),
    completeness: completenessOf(u),
    credits: credits ? int(credits.credits_remaining) : 0,
    creditsExpireInDays: expireInDays,
    hasPushToken: hasToken(u),
    platform: lastEvent ? lastEvent.platform || null : null,
    savedJobs: saved ? int(saved.n) : 0,
    coverLetters: letters ? int(letters.n) : 0,
    coverLetters7d: letters ? int(letters.n7) : 0,
    appliedCoverLetters: applicationsFromLetters,
    applications,
    applications7d: apps ? int(apps.n7) : 0,
    searches: searches ? int(searches.n) : 0,
    events30d: lastEvent ? int(lastEvent.n30) : 0,
    firstEvent: lastEvent ? lastEvent.first : null,
    lastEvent: lastEvent ? lastEvent.last : null,
    daysSinceLastSeen: lastEvent ? daysSince(lastEvent.last) : null,
    strongMatches,
    matchedJobCount,
    topMatch,
    newJobsThisWeek,
    pendingApplication: pending ? { company: pending.company_name, days: int(pending.days) } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) GET /api/admin/users/:id/overview
// ─────────────────────────────────────────────────────────────────────────────
async function getUserOverview(userId) {
  const u = await loadUser(userId);
  if (!u) return { notFound: true };
  const id = u.id;
  const state = await buildUserState(u);

  const [meta, creditRow, txns, notes, sends, prefs] = await Promise.all([
    (await tableExists('resume_metadata')) ? g(`SELECT * FROM resume_metadata WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [id]) : null,
    g(`SELECT credits_remaining, credits_total, expiry_date, last_purchase_date FROM user_credits WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [id]),
    q(`SELECT * FROM credit_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [id]),
    q(`SELECT type, title, message, created_at, is_read FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [id]),
    (await tableExists('admin_notification_log'))
      ? q(`SELECT l.template_key, l.title, l.created_at, l.sent_by, l.push_ok, l.push_error, l.batch_id,
                  a.email AS sent_by_email
             FROM admin_notification_log l LEFT JOIN users a ON a.id = l.sent_by
            WHERE l.user_id = $1 ORDER BY l.created_at DESC LIMIT 10`, [id])
      : [],
    notifPrefs.getPrefs(id),
  ]);

  const fileUrl = (kind) => `/api/admin/users/${id}/files/${kind}`;
  const assets = {
    resume: { has: !!u.resume_path, url: u.resume_path ? fileUrl('resume') : null, filename: u.resume_path ? path.basename(String(u.resume_path)) : null },
    photo: { has: !!u.photo_path, url: u.photo_path ? fileUrl('photo') : null, filename: u.photo_path ? path.basename(String(u.photo_path)) : null },
    signature: { has: !!u.signature_path, url: u.signature_path ? fileUrl('signature') : null, filename: u.signature_path ? path.basename(String(u.signature_path)) : null },
  };

  // credit_transactions has two historical shapes in this codebase
  // (transaction_type/credits_change vs action_type/credits_used) — normalise both.
  const recent = (txns || []).map((t) => ({
    amount: t.credits_change != null ? int(t.credits_change) : (t.credits_used != null ? int(t.credits_used) : null),
    type: t.transaction_type || t.action_type || t.type || null,
    created_at: t.created_at,
    description: t.description || null,
  }));

  return {
    user: publicUser(u),
    assets,
    credits: {
      remaining: creditRow ? int(creditRow.credits_remaining) : 0,
      total: creditRow ? int(creditRow.credits_total) : 0,
      expiry_date: creditRow ? creditRow.expiry_date || null : null,
      last_purchase_date: creditRow ? creditRow.last_purchase_date || null : null,
      recent,
    },
    resume: meta ? {
      parse_status: meta.parse_status || null,
      summary: meta.summary || null,
      skills: arr(meta.skills),
      technical_skills: arr(meta.technical_skills),
      soft_skills: arr(meta.soft_skills),
      experience_years: meta.experience_years == null ? null : Number(meta.experience_years),
      job_titles: arr(meta.job_titles),
      industries: arr(meta.industries),
      education: arr(meta.education),
      languages: arr(meta.languages),
      parsed_at: meta.parsed_at || null,
    } : {
      parse_status: null, summary: null, skills: [], technical_skills: [], soft_skills: [],
      experience_years: null, job_titles: [], industries: [], education: [], languages: [], parsed_at: null,
    },
    activity: {
      saved_jobs: state.savedJobs,
      applications: state.applications,
      cover_letters: state.coverLetters,
      searches: state.searches,
      events_30d: state.events30d,
      first_event: state.firstEvent,
      last_event: state.lastEvent,
    },
    push: {
      has_token: state.hasPushToken,
      platform: state.platform,
      preferences: prefs,
    },
    completeness: state.completeness,
    recent_notifications: (notes || []).map((n) => ({
      type: n.type, title: n.title, message: n.message, created_at: n.created_at, is_read: !!n.is_read,
    })),
    admin_sends: (sends || []).map((s) => ({
      template_key: s.template_key, title: s.title, created_at: s.created_at,
      sent_by: s.sent_by, sent_by_email: s.sent_by_email || null,
      push_ok: s.push_ok === true, push_error: s.push_error || null, batch_id: s.batch_id || null,
    })),
    // derived signals the admin UI can show without a second round-trip
    insights: {
      field: state.field,
      role_category: state.roleCategory,
      strong_matches: state.strongMatches,
      top_match: state.topMatch,
      days_since_last_seen: state.daysSinceLastSeen,
      days_since_signup: state.daysSinceSignup,
      has_parsed_resume: state.hasParsedResume,
    },
    notes: [
      'users.last_seen_at is never written by the server — last_event (app_events) is the real "last seen".',
      'app_events only goes back to 2026-06-29, so absence of events for an older account is not proof of inactivity.',
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) GET /api/admin/users/:id/files/:kind — resolve a stored path to a real file
// ─────────────────────────────────────────────────────────────────────────────
const FILE_KINDS = { resume: 'resume_path', photo: 'photo_path', signature: 'signature_path' };
const MIME = {
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.txt': 'text/plain', '.rtf': 'application/rtf',
};
async function getUserFile(userId, kind) {
  const col = FILE_KINDS[String(kind || '').toLowerCase()];
  if (!col) return { error: 'bad_kind' };
  const u = await loadUser(userId);
  if (!u) return { error: 'user_not_found' };
  const rel = String(u[col] || '').trim();
  if (!rel) return { error: 'not_set' };
  const root = path.resolve(process.cwd(), 'uploads');
  const abs = path.resolve(process.cwd(), rel);
  // Never serve anything outside uploads/ — the DB value is user-influenced at upload time.
  if (abs !== root && !abs.startsWith(root + path.sep)) return { error: 'outside_uploads', stored: rel };
  if (!fs.existsSync(abs)) return { error: 'missing_on_disk', stored: rel };
  const ext = path.extname(abs).toLowerCase();
  return { path: abs, filename: path.basename(abs), mime: MIME[ext] || 'application/octet-stream' };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2b) GET /api/admin/users/:id/activity?kind=...   — the ITEMS, not the counts
//
// getUserOverview already answers "how many cover letters does this user have".
// This answers "WHAT do they say" / "WHICH jobs did they save" / "WHAT did they spend
// credits on" — one paged list per kind, so the admin can actually read the work
// the user produced instead of staring at a number.
//
// ⚠️ db-config rewrites EVERY '?' in a statement into a positional placeholder
// (db-config.js:72/91/110 — `sql.replace(/\?/g, ...)`). A '?' inside a SQL string
// literal, a SQL regex, or a jsonb '?' operator therefore becomes a phantom $1 and
// silently shifts every real parameter after it. There is not a single '?' in any
// SQL below, and there must never be. (JS regexes in this file never reach the DB,
// so non-greedy quantifiers in JS-side helpers are safe.)
// ═════════════════════════════════════════════════════════════════════════════
const ACTIVITY_KINDS = ['cover_letters', 'saved_jobs', 'applications', 'credits', 'searches'];
const ACTIVITY_DEFAULT_LIMIT = 25;
const ACTIVITY_MAX_LIMIT = 100;   // hard ceiling; a bigger ask is clamped and reported
const PREVIEW_CHARS = 220;

// ── HTML → plain text (cover-letter previews) ────────────────────────────────
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
};
function decodeEntities(input) {
  return String(input).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g) => {
    const k = String(g).toLowerCase();
    if (k[0] === '#') {
      const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch (e) { return m; }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m;
  });
}
function htmlToText(html) {
  let s = String(html == null ? '' : html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/\s*(p|div|li|tr|h[1-6]|section|article|blockquote|table)\s*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/\r/g, '').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
// First ~n characters as one line, cut on a word boundary when that leaves something.
// GUARANTEE: the returned string contains no '<' or '>' — htmlToText strips tags but then DECODES
// entities, so a letter containing "&lt;script&gt;" would otherwise hand a live tag back to a page
// that renders the preview with innerHTML. Angle brackets are dropped rather than re-escaped so the
// contract holds however the consumer inserts it.
function previewOf(html, n = PREVIEW_CHARS) {
  const t = htmlToText(html).replace(/[<>]/g, ' ')
    .replace(/\n+/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const onWord = cut.replace(/\s+\S*$/, '');
  return (onWord.length >= n * 0.6 ? onWord : cut).trimEnd() + '…';
}
// The stored letter is AI-generated text that lands in an admin page's innerHTML, so strip the
// script-ish surface before it ever leaves the server. Admin-only, but stored XSS is stored XSS.
function sanitizeLetterHtml(html) {
  const before = String(html == null ? '' : html);
  let out = before;
  out = out.replace(/<(script|iframe|object|embed|form|link|meta|base|svg)\b[\s\S]*?<\/\1\s*>/gi, '');
  out = out.replace(/<(script|iframe|object|embed|form|link|meta|base)\b[^>]*>/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, ' ');
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, ' ');
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, ' ');
  out = out.replace(/\s(href|src|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, ' $1="#"');
  return { html: out, sanitized: out !== before };
}

// ── saved-job card JSON (jsonb, but be paranoid: string / double-encoded / array / null) ──
function parseCard(card) {
  let v = card;
  for (let i = 0; i < 2 && typeof v === 'string'; i += 1) {
    const s = v.trim();
    if (!s) return {};
    try { v = JSON.parse(s); } catch (e) { return {}; }
  }
  if (Array.isArray(v)) v = v.find((x) => x && typeof x === 'object' && !Array.isArray(x)) || {};
  return v && typeof v === 'object' ? v : {};
}
// First non-empty string among `keys`. Tolerates the three shapes a scraped card actually uses for
// one logical value: a plain string, {name|city|…}, and ["Munich", "Berlin"]. Depth-capped, so a
// deeply nested blob costs nothing and can never recurse away.
const NESTED_KEYS = ['name', 'label', 'title', 'city', 'text', 'value'];
function cardStr(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 2) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    if (typeof v === 'string') { const s = v.trim(); if (s) return s; }
    else if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    else if (Array.isArray(v)) {
      for (const e of v) {
        if (typeof e === 'string' && e.trim()) return e.trim();
        if (typeof e === 'number' && Number.isFinite(e)) return String(e);
        if (e && typeof e === 'object') {
          const s = cardStr(e, NESTED_KEYS, depth + 1);
          if (s) return s;
        }
      }
    } else if (typeof v === 'object') {
      const s = cardStr(v, NESTED_KEYS, depth + 1);
      if (s) return s;
    }
  }
  return null;
}
const CARD_TITLE_KEYS = ['title', 'job_title', 'jobTitle', 'position', 'role', 'name'];
const CARD_EMPLOYER_KEYS = ['employer_name', 'employerName', 'company', 'company_name', 'companyName',
  'employer', 'organization', 'org'];
const CARD_LOCATION_KEYS = ['location', 'job_location', 'city', 'place', 'where', 'country'];
// Last resort so a card with no title is not a blank row: "…/senior-backend-engineer" → that phrase.
function titleFromUrl(u) {
  const raw = String(u || '').trim();
  if (!raw) return null;
  let seg = '';
  try { seg = new URL(raw).pathname.split('/').filter(Boolean).pop() || ''; }
  catch (e) { seg = raw.split('#')[0].split('/').filter(Boolean).pop() || ''; }
  seg = seg.split('#')[0];
  let s;
  try { s = decodeURIComponent(seg); } catch (e) { s = seg; }
  s = s.replace(/\.(html?|aspx|php|jsp)$/i, '').replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 3 || /^\d+$/.test(s)) return null;
  return s.slice(0, 120);
}

// ── per-kind fetchers ────────────────────────────────────────────────────────
// q()/g() swallow SQL errors and hand back null. For a COUNT (which always yields a row) and for
// q() (which yields [] when there is simply nothing) a null is therefore a REAL FAILURE, never
// "no data" — so it is escalated to a 500 rather than being drawn as an honest-looking empty list.
const FAILED = (what) => ({ failed: what });

async function activityCoverLetters(id, limit, offset) {
  if (!(await tableExists('job_cover_letters'))) {
    return { total: 0, items: [], unavailable: 'job_cover_letters table is not present' };
  }
  const [c, rows] = await Promise.all([
    g(`SELECT COUNT(*)::int AS n FROM job_cover_letters WHERE user_id = $1`, [id]),
    q(`SELECT id, company_name, position, website_url, status, created_at, cover_letter_html
         FROM job_cover_letters
        WHERE user_id = $1
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT $2 OFFSET $3`, [id, limit, offset]),
  ]);
  if (!c || rows === null) return FAILED('cover_letters query failed');
  return {
    total: int(c.n),
    items: rows.map((r) => ({
      id: r.id,
      company_name: r.company_name || null,
      position: r.position || null,
      website_url: r.website_url || null,
      status: r.status || null,
      created_at: r.created_at,
      preview: previewOf(r.cover_letter_html),
    })),
  };
}

async function activitySavedJobs(id, limit, offset) {
  if (!(await tableExists('user_saved_jobs'))) {
    return { total: 0, items: [], unavailable: 'user_saved_jobs table is not present' };
  }
  const [c, rows] = await Promise.all([
    g(`SELECT COUNT(*)::int AS n FROM user_saved_jobs WHERE user_id = $1`, [id]),
    q(`SELECT id, job_url, card, saved_at
         FROM user_saved_jobs
        WHERE user_id = $1
        ORDER BY saved_at DESC NULLS LAST, id DESC
        LIMIT $2 OFFSET $3`, [id, limit, offset]),
  ]);
  if (!c || rows === null) return FAILED('saved_jobs query failed');
  return {
    total: int(c.n),
    items: rows.map((r) => {
      // A malformed / null / string card must degrade to nulls, never throw.
      let card = {};
      try { card = parseCard(r.card); } catch (e) { card = {}; }
      const url = r.job_url || cardStr(card, ['job_url', 'jobUrl', 'url', 'link', 'id']) || null;
      return {
        job_url: url,
        title: cardStr(card, CARD_TITLE_KEYS) || titleFromUrl(url),
        employer_name: cardStr(card, CARD_EMPLOYER_KEYS),
        location: cardStr(card, CARD_LOCATION_KEYS),
        saved_at: r.saved_at,
      };
    }),
  };
}

// ⚠️ VERIFIED ON PROD 2026-07-27: user_job_matches.status has exactly ONE distinct value across the
// whole table — 'new' (4844/4844 rows) — and no server code ever writes it (it is a DEFAULT that is
// never updated; jobService.js only ever upserts user_id/job_id/match_score/scored_at). So
// "user_job_matches rows whose status marks an application" is an empty set today and would render
// this tab permanently blank. The application record actually lives in:
//   • application_history  — a real emailed application (72 rows for user 1), with reply tracking
//   • job_cover_letters.status = 'applied' — the in-app "I applied" mark (15 rows for user 1)
// Both are unioned below, each row tagged with its `source`. The user_job_matches branch is kept
// and driven by the statuses ACTUALLY present at runtime, so the day the app starts writing
// status='applied' those rows appear here on their own, with no code change.
const APPLIED_MATCH_STATUS = /^(applied|apply|applied_external|application_sent|application_submitted|submitted)$/i;

async function activityApplications(id, limit, offset) {
  const [hasAH, hasJCL, hasUJM, hasEmployers] = await Promise.all([
    tableExists('application_history'), tableExists('job_cover_letters'),
    tableExists('user_job_matches'), tableExists('employers'),
  ]);

  // Which user_job_matches statuses (if any) really mark an application, for THIS user, right now.
  let statusesSeen = [];
  let statusesCounted = [];
  if (hasUJM) {
    const rows = await q(`SELECT DISTINCT status FROM user_job_matches WHERE user_id = $1`, [id]);
    if (rows === null) return FAILED('user_job_matches status probe failed');
    statusesSeen = rows.map((r) => r.status).filter((s) => s != null).map(String);
    statusesCounted = statusesSeen.filter((s) => APPLIED_MATCH_STATUS.test(s.trim()));
  }

  const params = [];
  const P = (v) => { params.push(v); return '$' + params.length; };
  const branches = [];

  if (hasAH) {
    branches.push(
      `SELECT 'email'::text AS source,
              ah.id::text AS ref_id,
              ah.company_name::text AS company_name,
              ah.position::text AS position,
              NULL::text AS job_url,
              'sent'::text AS status,
              ah.sent_date AS occurred_at,
              (COALESCE(ah.reply_received, 0) > 0) AS reply_received
         FROM application_history ah
        WHERE ah.user_id = ${P(id)} AND ah.deleted_at IS NULL`);
  }
  if (hasJCL) {
    branches.push(
      `SELECT 'cover_letter'::text AS source,
              jcl.id::text AS ref_id,
              jcl.company_name::text AS company_name,
              jcl.position::text AS position,
              jcl.website_url::text AS job_url,
              jcl.status::text AS status,
              COALESCE(jcl.updated_at, jcl.created_at) AS occurred_at,
              NULL::boolean AS reply_received
         FROM job_cover_letters jcl
        WHERE jcl.user_id = ${P(id)} AND jcl.status = 'applied'`);
  }
  if (hasUJM && statusesCounted.length) {
    // LEFT JOINs: a match whose job row was hard-deleted still shows up, just without a title.
    branches.push(
      `SELECT 'job_match'::text AS source,
              m.job_id::text AS ref_id,
              ${hasEmployers ? 'e.name::text' : 'NULL::text'} AS company_name,
              j.title::text AS position,
              j.job_url::text AS job_url,
              m.status::text AS status,
              COALESCE(m.updated_at, m.created_at) AS occurred_at,
              NULL::boolean AS reply_received
         FROM user_job_matches m
         LEFT JOIN jobs j ON j.id = m.job_id
         ${hasEmployers ? 'LEFT JOIN employers e ON e.id = j.employer_id' : ''}
        WHERE m.user_id = ${P(id)} AND m.status = ANY(${P(statusesCounted)}::text[])`);
  }

  const note = 'user_job_matches.status is a DEFAULT \'new\' column that no code ever updates, so it '
    + 'records no applications. These rows come from application_history (a sent application) and '
    + 'job_cover_letters marked \'applied\'. One real application can appear under BOTH sources — '
    + 'see meta.sources for the per-source split rather than reading `total` as "applications made".';

  if (!branches.length) {
    return {
      total: 0, items: [],
      unavailable: 'no application source table is present',
      meta: { sources: {}, match_statuses_seen: statusesSeen, match_statuses_counted: statusesCounted, note },
    };
  }

  const union = branches.join('\n       UNION ALL\n');
  const branchParams = params.slice();
  const [bySource, rows] = await Promise.all([
    q(`SELECT source, COUNT(*)::int AS n FROM (${union}) t GROUP BY source`, branchParams),
    q(`SELECT * FROM (${union}) t
        ORDER BY t.occurred_at DESC NULLS LAST, t.source ASC, t.ref_id DESC
        LIMIT $${branchParams.length + 1} OFFSET $${branchParams.length + 2}`,
      branchParams.concat([limit, offset])),
  ]);
  if (bySource === null || rows === null) return FAILED('applications union query failed');

  const sources = {};
  let total = 0;
  for (const r of bySource) { sources[r.source] = int(r.n); total += int(r.n); }

  return {
    total,
    items: rows.map((r) => ({
      id: r.ref_id,
      source: r.source,
      company_name: r.company_name || null,
      position: r.position || null,
      title: r.position || null,          // alias: the spec calls this "the title"
      job_url: r.job_url || null,
      status: r.status || null,
      created_at: r.occurred_at,
      reply_received: r.reply_received == null ? null : !!r.reply_received,
    })),
    meta: { sources, match_statuses_seen: statusesSeen, match_statuses_counted: statusesCounted, note },
  };
}

async function activityCredits(id, limit, offset) {
  if (!(await tableExists('credit_usage_history'))) {
    return { total: 0, items: [], unavailable: 'credit_usage_history table is not present' };
  }
  const [c, rows] = await Promise.all([
    g(`SELECT COUNT(*)::int AS n, COALESCE(SUM(credits_used), 0)::int AS spent
         FROM credit_usage_history WHERE user_id = $1`, [id]),
    q(`SELECT id, credits_used, action_type, company_name, position, created_at
         FROM credit_usage_history
        WHERE user_id = $1
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT $2 OFFSET $3`, [id, limit, offset]),
  ]);
  if (!c || rows === null) return FAILED('credits query failed');
  return {
    total: int(c.n),
    meta: { total_credits_used: int(c.spent) },
    items: rows.map((r) => ({
      id: r.id,
      credits_used: int(r.credits_used),
      action_type: r.action_type || null,
      company_name: r.company_name || null,
      position: r.position || null,
      created_at: r.created_at,
    })),
  };
}

async function activitySearches(id, limit, offset) {
  if (!(await tableExists('app_events'))) {
    return { total: 0, items: [], unavailable: 'app_events table is not present' };
  }
  const [c, rows] = await Promise.all([
    g(`SELECT COUNT(*)::int AS n FROM app_events WHERE user_id = $1 AND event = 'job_search'`, [id]),
    q(`SELECT id, props, platform, app_version, country, created_at
         FROM app_events
        WHERE user_id = $1 AND event = 'job_search'
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT $2 OFFSET $3`, [id, limit, offset]),
  ]);
  if (!c || rows === null) return FAILED('searches query failed');
  return {
    total: int(c.n),
    meta: { note: 'app_events only goes back to 2026-06-29 — older searches were never recorded.' },
    items: rows.map((r) => {
      let props = {};
      try { props = parseCard(r.props); } catch (e) { props = {}; }
      return {
        id: r.id == null ? null : String(r.id),   // bigint: pg hands this back as a string
        created_at: r.created_at,
        platform: r.platform || null,
        app_version: r.app_version || null,
        country: r.country || null,
        query: cardStr(props, ['query', 'q', 'keyword', 'keywords', 'search', 'term', 'title', 'role']),
        location: cardStr(props, CARD_LOCATION_KEYS),
        company: cardStr(props, ['company', 'employer', 'employer_name', 'url', 'website']),
        props,
      };
    }),
  };
}

// GET /api/admin/users/:id/activity?kind=&limit=&offset=
async function getUserActivity(userId, kind, opts = {}) {
  const u = await loadUser(userId);                 // excludes soft-deleted, exactly like the rest
  if (!u) return { notFound: true };
  const k = String(kind || '').trim().toLowerCase();
  if (!ACTIVITY_KINDS.includes(k)) return { badKind: true, kinds: ACTIVITY_KINDS };

  const asked = Math.floor(int(opts.limit, ACTIVITY_DEFAULT_LIMIT)) || ACTIVITY_DEFAULT_LIMIT;
  const limit = Math.min(Math.max(asked, 1), ACTIVITY_MAX_LIMIT);
  const offset = Math.max(Math.floor(int(opts.offset, 0)), 0);

  let out;
  if (k === 'cover_letters') out = await activityCoverLetters(u.id, limit, offset);
  else if (k === 'saved_jobs') out = await activitySavedJobs(u.id, limit, offset);
  else if (k === 'applications') out = await activityApplications(u.id, limit, offset);
  else if (k === 'credits') out = await activityCredits(u.id, limit, offset);
  else out = await activitySearches(u.id, limit, offset);

  if (out.failed) return { dbError: out.failed };

  const items = out.items || [];
  const total = int(out.total, 0);
  return {
    kind: k,
    total,
    offset,
    limit,
    items,
    // Honest: true whenever this response does NOT contain everything there is.
    truncated: offset + items.length < total,
    limit_capped: asked > ACTIVITY_MAX_LIMIT,
    max_limit: ACTIVITY_MAX_LIMIT,
    ...(out.meta ? { meta: out.meta } : {}),
    ...(out.unavailable ? { unavailable: out.unavailable } : {}),
  };
}

// GET /api/admin/users/:id/cover-letters/:letterId — the full letter, scoped to its owner.
// The user_id predicate is what makes this safe: an admin cannot walk letter ids across accounts
// by accident, and a wrong-owner id is a plain 404 that leaks nothing about the real owner.
async function getUserCoverLetter(userId, letterId) {
  const u = await loadUser(userId);
  if (!u) return { notFound: true };
  const lid = Math.floor(int(letterId, 0));
  if (!Number.isInteger(lid) || lid <= 0) return { notFound: true };
  if (!(await tableExists('job_cover_letters'))) return { notFound: true };
  const r = await g(
    `SELECT id, company_name, position, website_url, status, created_at, updated_at, cover_letter_html
       FROM job_cover_letters
      WHERE id = $1 AND user_id = $2
      LIMIT 1`, [lid, u.id]);
  if (!r) return { notFound: true };
  const clean = sanitizeLetterHtml(r.cover_letter_html);
  return {
    letter: {
      id: r.id,
      company_name: r.company_name || null,
      position: r.position || null,
      website_url: r.website_url || null,
      status: r.status || null,
      created_at: r.created_at,
      updated_at: r.updated_at || null,
      html: clean.html,
      text: htmlToText(r.cover_letter_html),   // for copy-paste / plain rendering
      sanitized: clean.sanitized,              // true when script-ish markup was stripped
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) GET /api/admin/notify/templates?userId=N
// ─────────────────────────────────────────────────────────────────────────────
async function listTemplates(userId, jobId) {
  const state = userId ? await buildUserState(userId) : null;
  const job = jobId ? await resolveJob(userId, jobId) : (state && state.topMatch) || null;
  const ctx = {
    firstName: state ? state.firstName : '',
    fullName: state ? state.fullName : '',
    state: state || {},
    job: job && !job.notFound ? job : null,
  };
  const list = templates.all().map((t) => templates.describe(t, state, ctx));
  const order = { suggested: 0, available: 1, not_applicable: 2 };
  list.sort((a, b) => (order[a.relevance] - order[b.relevance]) || a.key.localeCompare(b.key));
  const bad = templates.invalidCategories();
  return {
    templates: list,
    userId: state ? state.userId : null,
    userKnown: !!state,
    categories: templates.PREF_CATEGORIES,
    warning: bad.length ? `Templates with a category that is NOT a notification_preferences column (opt-outs would be bypassed): ${bad.join(', ')}` : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// send pipeline
// ─────────────────────────────────────────────────────────────────────────────
// The 72h dedupe is a RESERVATION, not a check-then-act. A row blocks a repeat when it either
// already succeeded (push_ok IS TRUE) or is still in flight (push_ok IS NULL and young enough to be
// a live attempt rather than the debris of a crashed one). Skips and failures (push_ok IS FALSE)
// never block — a send that did not reach the phone must stay retryable.
// This exact predicate is used in THREE places (the reservation, the segment list flag and the
// segment counts) so the admin preview can never disagree with what the sender will do.
const dedupeBlockSql = (alias = '') => {
  const a = alias ? alias + '.' : '';
  return `(${a}push_ok IS TRUE OR (${a}push_ok IS NULL AND ${a}created_at > NOW() - INTERVAL '${RESERVATION_TTL_MIN} minutes'))`;
};

// Claim the right to send (user, template) — ATOMICALLY.
//
// ⚠️ Reading the log and then sending is a race: two overlapping requests (an impatient double-click
// on the admin Send button, or two admins at once) both read "nothing sent yet" and both push. So the
// log row is written FIRST, as a reservation with push_ok NULL, and the DATABASE picks the winner:
//   • the INSERT ... WHERE NOT EXISTS body rejects a repeat inside the dedupe window, and
//   • the partial unique index uq_admin_notif_log_inflight (Migration 026) — UNIQUE(user_id,
//     template_key) WHERE push_ok IS NULL — rejects a SIMULTANEOUS second inserter with 23505,
//     which WHERE NOT EXISTS alone cannot do (two READ COMMITTED snapshots can both see nothing).
// Returns { won:false } when somebody else got there first; the caller must then not send.
// If the log table (or the index) is missing the send still proceeds — the audit trail must never be
// the reason a real notification is withheld — but `degraded` says the guarantee was weaker.
async function reserveSend({ userId, templateKey, sentBy, batchId, hours = DEDUPE_HOURS }) {
  if (!(await tableExists('admin_notification_log'))) return { won: true, logId: null, degraded: 'no_log_table' };
  // ⚠️ The atomicity guarantee lives in the INDEX, not the table: WHERE NOT EXISTS alone cannot
  // decide a race. Probing only the table would let us claim a guarantee we do not have on a database
  // where Migration 026's index failed to create. Check the thing we actually depend on.
  if (!(await inflightIndexExists())) return { won: true, logId: null, degraded: 'no_inflight_index' };

  // Free a reservation whose process died between reserve and finalize: the unique index has no time
  // component, so without this a crash would block this (user, template) pair forever.
  try {
    await dbConfig.run(
      `UPDATE admin_notification_log SET push_ok = FALSE, push_error = 'reservation_abandoned'
        WHERE user_id = $1 AND template_key = $2 AND push_ok IS NULL
          AND created_at < NOW() - INTERVAL '${RESERVATION_TTL_MIN} minutes'`,
      [userId, templateKey]);
  } catch (e) { /* best-effort */ }

  try {
    const rows = await dbConfig.query(
      `INSERT INTO admin_notification_log (user_id, template_key, sent_by, batch_id, push_ok)
       SELECT $1::int, $2::varchar, $3::int, $4::varchar, NULL::boolean
        WHERE NOT EXISTS (
          SELECT 1 FROM admin_notification_log l
           WHERE l.user_id = $1::int AND l.template_key = $2::varchar
             AND ${dedupeBlockSql('l')}
             AND l.created_at > NOW() - ($5 || ' hours')::interval)
       RETURNING id`,
      [userId, templateKey, sentBy == null ? null : sentBy, batchId || null, String(hours)]);
    const id = rows && rows[0] ? rows[0].id : null;
    return id ? { won: true, logId: id } : { won: false, logId: null };
  } catch (e) {
    // 23505 = the partial unique index fired: a concurrent sender holds the reservation.
    if (e && e.code === '23505') return { won: false, logId: null, concurrent: true };
    console.warn('[adminUserOps] reservation failed:', e.message);
    return { won: true, logId: null, degraded: e.message };
  }
}

// Write the real outcome onto the reservation row. Falls back to a fresh INSERT only when the
// reservation could not be written at all (degraded path), so an audit row still exists.
async function finalizeSend(logId, row) {
  if (!logId) return logSend(row);
  try {
    await dbConfig.run(
      `UPDATE admin_notification_log
          SET title = $2, body = $3, route = $4, params = $5, push_ok = $6, push_error = $7
        WHERE id = $1`,
      [logId, row.title || null, row.body || null, row.route || null,
        JSON.stringify(row.params || {}), row.pushOk === true, row.pushError || null]);
  } catch (e) { console.warn('[adminUserOps] log finalize failed:', e.message); }
  return logId;
}

async function logSend(row) {
  if (!(await tableExists('admin_notification_log'))) return null;
  try {
    const r = await dbConfig.run(
      `INSERT INTO admin_notification_log
         (user_id, template_key, title, body, route, params, sent_by, batch_id, push_ok, push_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.userId, row.templateKey, row.title || null, row.body || null, row.route || null,
        JSON.stringify(row.params || {}), row.sentBy || null, row.batchId || null,
        row.pushOk === true, row.pushError || null]);
    return r ? r.lastID : null;
  } catch (e) { console.warn('[adminUserOps] log write failed:', e.message); return null; }
}

// Send ONE template to ONE user. Returns a fully explained outcome — never throws.
async function sendToUser({ userId, templateKey, jobId, overrides, adminId, batchId, state, user, shared }) {
  const tpl = templates.get(templateKey);
  if (!tpl) return { ok: false, skipped: 'unknown_template', error: `No template '${templateKey}'` };
  // The SAME gate for a single send as for a bulk send: notificationPrefs.isEnabled fails OPEN on a
  // category it does not recognise, so a template whose category is not a real preferences column
  // would be unstoppable by any opt-out. Refuse it here rather than deliver an ungated push.
  if (!templates.PREF_CATEGORIES.includes(tpl.category)) {
    return { ok: false, skipped: 'bad_template_category',
      error: `Template '${tpl.key}' has category '${tpl.category}', which is not a notification_preferences column — opt-outs could not be honoured, so nothing was sent.` };
  }

  const u = user || await loadUser(userId);
  if (!u) return { ok: false, skipped: 'user_not_found' };

  // Reserve FIRST — this is the dedupe, and it is atomic (see reserveSend).
  const claim = await reserveSend({ userId: u.id, templateKey: tpl.key, sentBy: adminId, batchId });
  if (!claim.won) {
    return { ok: false, skipped: 'recently_sent',
      error: claim.concurrent
        ? `Another send of '${tpl.key}' to this user is already in flight — this duplicate was dropped.`
        : `Already sent '${tpl.key}' to this user in the last ${DEDUPE_HOURS}h.` };
  }
  const release = (pushError) => finalizeSend(claim.logId,
    { userId: u.id, templateKey: tpl.key, sentBy: adminId, batchId, pushOk: false, pushError });

  if (!(await notifPrefs.isEnabled(u.id, tpl.category))) {
    const logId = await release('opted_out');
    return { ok: false, skipped: 'opted_out', error: `User opted out of '${tpl.category}' notifications.`, logId };
  }
  if (!hasToken(u)) {
    const logId = await release('no_token');
    return { ok: false, skipped: 'no_token', error: 'No Expo push token on file for this user.', logId };
  }

  const st = state || await stateForTemplate(tpl, u, shared);
  let job = null;
  if (jobId) job = await resolveJob(u.id, jobId);
  else if (tpl.needsJob && st && st.topMatch) job = st.topMatch;
  if (tpl.needsJob && (!job || job.notFound)) {
    const logId = await release('job_not_found');
    return { ok: false, skipped: 'job_not_found', logId, error: `Template '${tpl.key}' needs a jobId and it could not be resolved${job && job.truncated ? ' (gj_ hash scan hit its 60k-row ceiling)' : ''}.` };
  }

  const ctx = { firstName: st ? st.firstName : '', fullName: st ? st.fullName : '', state: st || {}, job };
  const r = templates.render(tpl, ctx, overrides || {});
  const pushParams = { ...r.params };
  const logParams = { ...r.params };
  if (job && job.job_url) logParams.jobUrl = job.job_url;   // lets the deep link resolve the gj_ id cheaply

  // In-app row first, so a tapped push always has something behind it. push:false — we fire the push
  // ourselves so the real delivery result can be reported and logged.
  try {
    const { createNotification } = require('../controllers/notificationsController');
    await createNotification(u.id, r.notifType, r.title, r.body, null,
      { route: r.route, params: pushParams, templateKey: tpl.key, action: 'admin_' + tpl.key });
  } catch (e) { /* in-app row is best-effort; the push is the deliverable */ }

  let pushOk = false;
  let pushError = null;
  try {
    const res = await expoPush.sendPushNotification(u.expo_push_token, r.title, r.body,
      { type: r.notifType, route: r.route, params: pushParams, templateKey: tpl.key });
    if (res === true) pushOk = true;
    else if (res === 'stale') {
      pushError = 'stale_token';
      try { await require('./uninstallDetection').handleStaleToken(Number(u.id)); } catch (e) { /* best-effort */ }
    } else pushError = 'send_failed';
  } catch (e) { pushError = e.message || 'send_failed'; }

  const logId = await finalizeSend(claim.logId, {
    userId: u.id, templateKey: tpl.key, title: r.title, body: r.body, route: r.route,
    params: logParams, sentBy: adminId, batchId, pushOk, pushError,
  });

  return { ok: pushOk, error: pushError, logId, title: r.title, body: r.body, route: r.route, params: pushParams };
}

// ─────────────────────────────────────────────────────────────────────────────
// segments
// ─────────────────────────────────────────────────────────────────────────────
let _segCache = null;
async function segmentDefs() {
  if (_segCache && Date.now() - _segCache.at < 60000) return _segCache.defs;
  const has = {};
  for (const t of ['resume_metadata', 'user_resumes', 'app_events', 'user_saved_jobs', 'job_cover_letters', 'application_history', 'user_credits']) {
    has[t] = await tableExists(t);
  }
  const creditsDeleted = await columnExists('user_credits', 'deleted_at');

  const HAS_RESUME = `((u.resume_path IS NOT NULL AND u.resume_path <> '')
    ${has.resume_metadata ? "OR EXISTS (SELECT 1 FROM resume_metadata m WHERE m.user_id = u.id)" : ''}
    ${has.user_resumes ? "OR EXISTS (SELECT 1 FROM user_resumes r WHERE r.user_id = u.id)" : ''})`;
  const APPLIED = `(FALSE
    ${has.job_cover_letters ? "OR EXISTS (SELECT 1 FROM job_cover_letters j WHERE j.user_id = u.id AND j.status = 'applied')" : ''}
    ${has.application_history ? "OR EXISTS (SELECT 1 FROM application_history a WHERE a.user_id = u.id AND a.deleted_at IS NULL)" : ''}
    ${has.app_events ? "OR EXISTS (SELECT 1 FROM app_events e WHERE e.user_id = u.id AND e.event = 'apply_complete')" : ''})`;
  const SEARCHED = has.app_events
    ? `EXISTS (SELECT 1 FROM app_events e WHERE e.user_id = u.id AND e.event = 'job_search')` : 'FALSE';
  const CREDITS = `COALESCE((SELECT c.credits_remaining FROM user_credits c
      WHERE c.user_id = u.id ${creditsDeleted ? 'AND c.deleted_at IS NULL' : ''} ORDER BY c.id DESC LIMIT 1), 0)`;
  // ⚠️ COALESCE(...,0) makes "no user_credits row at all" indistinguishable from "spent down to 0",
  // and users with no row are most of the base — so a low-credits segment MUST require the row.
  const HAS_CREDIT_ROW = has.user_credits
    ? `EXISTS (SELECT 1 FROM user_credits c WHERE c.user_id = u.id ${creditsDeleted ? 'AND c.deleted_at IS NULL' : ''})`
    : 'FALSE';

  const defs = [
    { key: 'registered_no_resume', label: 'No résumé yet', suggests: ['upload_resume', 'how_it_works'],
      description: 'Registered but has no uploaded résumé, no parsed résumé and no builder résumé. The #1 activation blocker.',
      where: `NOT ${HAS_RESUME}`, needs: ['resume_metadata', 'user_resumes'] },
    { key: 'no_profile_details', label: 'Missing profile details', suggests: ['complete_profile'],
      description: 'Missing at least one of phone number, address or date of birth.',
      where: `(u.phone_number IS NULL OR u.phone_number = '' OR u.address IS NULL OR u.address = '' OR u.date_of_birth IS NULL)` },
    { key: 'no_photo', label: 'No profile photo', suggests: ['add_photo'],
      description: 'No profile picture uploaded.', where: `(u.photo_path IS NULL OR u.photo_path = '')` },
    { key: 'no_signature', label: 'No signature', suggests: ['add_signature'],
      description: 'No signature uploaded — generated cover letters go out unsigned.',
      where: `(u.signature_path IS NULL OR u.signature_path = '')` },
    { key: 'resume_no_search', label: 'Résumé but never searched', suggests: ['best_matches', 'how_it_works'],
      description: 'Has a résumé but has never run a job search. ⚠️ job_search only fires for the company/career-page search, not the Google browser.',
      where: `${HAS_RESUME} AND NOT ${SEARCHED}`, needs: ['app_events'] },
    { key: 'searched_not_applied', label: 'Searched but never applied', suggests: ['saved_not_applied', 'best_matches', 'generate_cover_letter'],
      description: 'Ran a search and never applied. The highest-intent reachable segment in the database.',
      where: `${SEARCHED} AND NOT ${APPLIED}`, needs: ['app_events'] },
    { key: 'saved_not_applied', label: 'Saved a job, never applied', suggests: ['saved_not_applied', 'generate_cover_letter'],
      description: 'Saved at least one job and never applied to anything.',
      where: `${has.user_saved_jobs ? 'EXISTS (SELECT 1 FROM user_saved_jobs s WHERE s.user_id = u.id)' : 'FALSE'} AND NOT ${APPLIED}`,
      needs: ['user_saved_jobs'] },
    { key: 'cover_letter_no_apply', label: 'Cover letter, no application', suggests: ['finish_first_application'],
      description: 'Generated a cover letter and never sent an application — one tap from activation.',
      where: `${has.job_cover_letters ? 'EXISTS (SELECT 1 FROM job_cover_letters j WHERE j.user_id = u.id)' : 'FALSE'} AND NOT ${APPLIED}`,
      needs: ['job_cover_letters'] },
    { key: 'low_credits', label: 'Low on credits (<5)', suggests: ['low_credits'],
      description: 'Has a credit balance on record and fewer than 5 credits left. 5 is the free signup grant, so this means they have spent something. Users with NO user_credits row are excluded — a missing row is "never granted", not "spent down to zero".',
      where: `${HAS_CREDIT_ROW} AND ${CREDITS} < 5`, needs: ['user_credits'] },
    { key: 'dormant_7', label: 'Dormant 7+ days', suggests: ['welcome_back_dormant', 'best_matches'],
      description: 'Opened the app at least once but nothing in the last 7 days.',
      where: has.app_events
        ? `EXISTS (SELECT 1 FROM app_events e WHERE e.user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM app_events e WHERE e.user_id = u.id AND e.created_at >= NOW() - INTERVAL '7 days')`
        : 'FALSE',
      needs: ['app_events'] },
    { key: 'never_opened', label: 'Never opened (post-telemetry)', suggests: ['how_it_works', 'upload_resume'],
      description: 'Registered after telemetry started and has never produced an app event. Accounts older than the telemetry table are deliberately excluded — for them "no events" only means "signed up before we measured".',
      where: has.app_events
        ? `NOT EXISTS (SELECT 1 FROM app_events e WHERE e.user_id = u.id)
           AND u.created_at >= (SELECT MIN(created_at) FROM app_events)`
        : 'FALSE',
      needs: ['app_events'] },
    { key: 'no_push_token', label: 'No push token (unreachable)', suggests: [],
      description: 'Cannot be reached by push at all. Useful as a denominator, not as a send target — every send to this segment is skipped.',
      where: `(u.expo_push_token IS NULL OR u.expo_push_token = '')` },
    { key: 'active_appliers', label: 'Has applied', suggests: ['stalled_application', 'weekly_digest'],
      description: 'Applied at least once (cover letter marked applied, an emailed application, or an apply_complete event).',
      where: APPLIED },
    // ⚠️ Must stay identical to COMPLETENESS_SLOTS / COMPLETENESS_SQL (7 slots, full_name included),
    // or this segment claims "complete" for a profile the same page scores at 86%.
    { key: 'complete_profile', label: 'Complete profile', suggests: ['profile_complete_celebrate', 'best_matches'],
      description: 'All 7 completeness slots filled: name, résumé, photo, signature, phone, address and date of birth.',
      where: `u.full_name IS NOT NULL AND u.full_name <> ''
        AND u.resume_path IS NOT NULL AND u.resume_path <> ''
        AND u.photo_path IS NOT NULL AND u.photo_path <> ''
        AND u.signature_path IS NOT NULL AND u.signature_path <> ''
        AND u.phone_number IS NOT NULL AND u.phone_number <> ''
        AND u.address IS NOT NULL AND u.address <> ''
        AND u.date_of_birth IS NOT NULL` },
    { key: 'ready_not_applied', label: 'Fully set up, never applied', suggests: ['profile_complete_celebrate', 'best_matches', 'saved_not_applied'],
      description: 'Everything is configured and they still have not applied — the clearest "we lost them at the last step" group.',
      where: `u.resume_path IS NOT NULL AND u.resume_path <> ''
        AND u.phone_number IS NOT NULL AND u.phone_number <> ''
        AND NOT ${APPLIED}` },
  ];
  for (const d of defs) d.available = (d.needs || []).every((t) => has[t]);
  _segCache = { at: Date.now(), defs };
  return defs;
}

async function getSegment(key) {
  const defs = await segmentDefs();
  return defs.find((d) => d.key === String(key || '')) || null;
}

// 6) GET /api/admin/segments
async function listSegments() {
  const defs = await segmentDefs();
  const live = await liveUsersSql('u');
  const out = [];
  for (const d of defs) {
    let count = null;
    let error;
    const row = await g(`SELECT COUNT(*)::int n FROM users u WHERE ${live} AND (${d.where})`);
    if (row) count = int(row.n); else error = 'count query failed (schema mismatch?)';
    out.push({
      key: d.key, label: d.label, description: d.description, count,
      available: d.available !== false, suggests: d.suggests || [],
      error,
    });
  }
  return { segments: out };
}

// 7) GET /api/admin/segments/:key/users
//
// opts.sendableOnly pushes the three exclusions (no push token / opted out / already sent inside the
// dedupe window) into the WHERE clause instead of leaving them as flags on rows the LIMIT already
// took. ⚠️ That distinction is the whole bug: with the exclusions in the SELECT list, "the newest
// `cap` users" is computed BEFORE anyone is excluded, so a capped send can never reach the users past
// the cap — every re-run selects the same newest N and finds them all already-sent.
async function getSegmentUsers(key, limit = 200, templateKey = null, opts = {}) {
  const seg = await getSegment(key);
  if (!seg) return { notFound: true };
  const lim = Math.min(Math.max(int(limit, 200), 1), SEGMENT_LIST_CEILING);
  const sendableOnly = opts.sendableOnly === true;
  const live = await liveUsersSql('u');
  const hasEvents = await tableExists('app_events');
  const hasPrefs = await tableExists('notification_preferences');
  const hasLog = await tableExists('admin_notification_log');
  const tpl = templateKey ? templates.get(templateKey) : null;
  const cat = tpl && templates.PREF_CATEGORIES.includes(tpl.category) ? tpl.category : null;

  const params = [];
  const P = (v) => { params.push(v); return '$' + params.length; };
  // ⚠️ Must match hasToken() above EXACTLY. "not empty" is looser than "is an Expo token": a legacy
  // FCM/APNs string left in the column would pass here, be counted as sendable, consume a slot in the
  // capped batch, and then be rejected by the sender — so the cap silently under-delivers and the
  // preview overstates the reach. Same predicate on both sides or the two disagree.
  // ⚠️ Written as an alternation, NOT `^Expo(nent)?PushToken\[`, because db-config rewrites EVERY `?`
  // in a statement into a positional placeholder (db-config.js:72). A `?` inside a regex literal is
  // silently turned into `$n`, which both corrupts the pattern and shifts every real parameter after
  // it. The suite caught this as "no_token: 2" for users holding perfectly valid tokens.
  // ⚠️ COALESCE is load-bearing: `NULL ~ regex` yields NULL, not FALSE, and NULL then poisons every
  // aggregate below — `COUNT(*) FILTER (WHERE NOT has_push)` skips a NULL, so users with no token at
  // all silently vanished from BOTH the excluded buckets and the sendable count. The preview reported
  // "72 in segment, 24 sendable, 0 excluded", which is self-contradictory and understates who cannot
  // be reached. Verified on live data: 51 tokenless users were being counted as nothing at all.
  const hasPush = `(COALESCE(u.expo_push_token, '') ~ '^(ExpoPushToken|ExponentPushToken)\\[')`;
  const optedOut = cat && hasPrefs ? `COALESCE(p.${cat} = FALSE, FALSE)` : 'FALSE';
  const recently = tpl && hasLog
    ? `EXISTS (SELECT 1 FROM admin_notification_log l WHERE l.user_id = u.id AND l.template_key = ${P(tpl.key)}
         AND ${dedupeBlockSql('l')} AND l.created_at > NOW() - INTERVAL '${DEDUPE_HOURS} hours')`
    : 'FALSE';
  const lastSeen = hasEvents ? `(SELECT MAX(e.created_at) FROM app_events e WHERE e.user_id = u.id)` : 'NULL::timestamp';
  const join = cat && hasPrefs ? 'LEFT JOIN notification_preferences p ON p.user_id = u.id' : '';
  const sendable = `${hasPush} AND NOT (${optedOut}) AND NOT (${recently})`;

  // One aggregate gives the segment total AND why each excluded user is excluded AND how many are
  // actually sendable — so the caller never has to infer any of it from a capped page of rows.
  const countRow = await g(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE NOT has_push)::int AS no_token,
            COUNT(*) FILTER (WHERE has_push AND opted_out)::int AS opted_out,
            COUNT(*) FILTER (WHERE has_push AND NOT opted_out AND recently_sent)::int AS recently_sent,
            COUNT(*) FILTER (WHERE has_push AND NOT opted_out AND NOT recently_sent)::int AS sendable
       FROM (SELECT ${hasPush} AS has_push, ${optedOut} AS opted_out, ${recently} AS recently_sent
               FROM users u ${join} WHERE ${live} AND (${seg.where})) t`, params);

  const rows = await q(
    `SELECT u.id, u.full_name, u.email, u.created_at,
            ${lastSeen} AS last_seen_at,
            ${hasPush} AS has_push,
            ${COMPLETENESS_SQL} AS completeness,
            ${optedOut} AS opted_out,
            ${recently} AS recently_sent
       FROM users u
       ${join}
      WHERE ${live} AND (${seg.where})
        ${sendableOnly ? `AND ${sendable}` : ''}
      ORDER BY u.created_at DESC
      LIMIT ${P(lim)}`, params);

  const total = countRow ? int(countRow.total) : 0;
  const excluded = {
    no_token: countRow ? int(countRow.no_token) : 0,
    opted_out: countRow ? int(countRow.opted_out) : 0,
    recently_sent: countRow ? int(countRow.recently_sent) : 0,
  };
  const sendableTotal = countRow ? int(countRow.sendable) : 0;
  if (!rows) return { key: seg.key, total, sendableTotal, excluded, users: [], error: 'segment query failed' };

  // What the LIMIT is measured against depends on what the LIMIT selected from.
  const pool = sendableOnly ? sendableTotal : total;
  const poolLabel = sendableOnly ? 'sendable' : 'matching';
  return {
    key: seg.key,
    label: seg.label,
    total,
    sendableTotal,
    excluded,
    sendableOnly,
    templateKey: tpl ? tpl.key : null,
    users: rows.map((r) => ({
      id: r.id, full_name: r.full_name, email: r.email, created_at: r.created_at,
      last_seen_at: r.last_seen_at, has_push: r.has_push === true,
      completeness: int(r.completeness),
      opted_out: r.opted_out === true, recently_sent: r.recently_sent === true,
    })),
    limit: lim,
    truncated: pool > rows.length,
    truncation_note: pool > rows.length ? `Showing ${rows.length} of ${pool} ${poolLabel} users (limit=${lim}).` : undefined,
    exclusion_note: tpl
      ? `Exclusions are counted over the WHOLE segment, not just this page: ${excluded.no_token} unreachable (no push token), ${excluded.opted_out} opted out of '${tpl.category}', ${excluded.recently_sent} already sent '${tpl.key}' inside ${DEDUPE_HOURS}h → ${sendableTotal} sendable.`
      : 'Pass templateKey to see per-template opt-out / dedupe exclusions.',
    last_seen_note: hasEvents ? 'last_seen_at is derived from app_events (users.last_seen_at is never written).' : 'app_events is unavailable — last_seen_at is null.',
  };
}

// 8) POST /api/admin/segments/:key/notify
async function notifySegment({ key, templateKey, overrides, confirm, maxRecipients, adminId }) {
  const seg = await getSegment(key);
  if (!seg) return { error: 'unknown_segment' };
  const tpl = templates.get(templateKey);
  if (!tpl) return { error: 'unknown_template' };
  if (tpl.needsJob) return { error: 'template_needs_job', message: `'${tpl.key}' targets one specific job and cannot be sent to a segment.` };
  if (!templates.PREF_CATEGORIES.includes(tpl.category)) {
    return { error: 'bad_template_category', message: `Template '${tpl.key}' has category '${tpl.category}', which is not a notification_preferences column — opt-outs could not be honoured.` };
  }

  const cap = Math.min(Math.max(int(maxRecipients, DEFAULT_MAX_RECIPIENTS), 1), ABSOLUTE_MAX_RECIPIENTS);
  // sendableOnly:true → the LIMIT selects `cap` users who can ACTUALLY be sent to, instead of `cap`
  // rows that then shrink. (SEGMENT_LIST_CEILING ≥ ABSOLUTE_MAX_RECIPIENTS, so `cap` survives intact.)
  const listed = await getSegmentUsers(seg.key, cap, tpl.key, { sendableOnly: true });
  if (listed.notFound || listed.error) return { error: listed.error || 'segment_query_failed' };

  const candidates = listed.users;             // every one of these is sendable as of this SELECT
  const reachableIds = candidates.map((c) => c.id);
  // Segment-wide exclusion breakdown; runtime skips (a user who opts out between the SELECT and the
  // send, or whose reservation is lost to a concurrent sender) are added to it as they happen.
  const skipped = { ...listed.excluded };
  const runtimeSkipped = { no_token: 0, opted_out: 0, recently_sent: 0 };

  const sendableTotal = listed.sendableTotal;
  const truncated = sendableTotal > candidates.length;
  const remaining = Math.max(0, sendableTotal - candidates.length);
  const capNote = (isDryRun) => {
    if (!truncated) return undefined;
    const head = `HARD CAP: ${sendableTotal} sendable users match '${seg.key}' (of ${listed.total} in the segment) but only the ${candidates.length} newest were taken (maxRecipients=${cap}, ceiling ${ABSOLUTE_MAX_RECIPIENTS}).`;
    return isDryRun
      ? `${head} Re-running this PREVIEW selects the same ${candidates.length} again — the remaining ${remaining} are only reachable after a confirmed send moves this batch into the ${DEDUPE_HOURS}h dedupe window.`
      : `${head} ${remaining} still to go: a re-run now selects the NEXT ${Math.min(remaining, cap)} because the users just sent to are excluded by the ${DEDUPE_HOURS}h dedupe. Anyone whose push FAILED stays in the pool and will be retried.`;
  };
  const base = {
    segment: seg.key,
    templateKey: tpl.key,
    category: tpl.category,
    totalMatching: listed.total,
    sendableTotal,
    remainingAfterThisRun: remaining,
    recipients: candidates.length,
    reachable: reachableIds.length,   // identical to recipients now: unsendable users are never selected
    skipped,
    runtimeSkipped,
    cap,
    selectionLimit: listed.limit,
    truncated,
    exclusion_note: listed.exclusion_note,
  };

  // One shared cache for everything that is NOT per-user, reused by every recipient in this run.
  const shared = { newJobsByField: new Map() };

  if (!confirm) {
    // Preview copy, rendered against the first reachable user so the admin sees the real thing.
    let preview = null;
    if (reachableIds.length) {
      const pu = await loadUser(reachableIds[0]);
      const st = pu ? await stateForTemplate(tpl, pu, shared) : null;
      preview = templates.render(tpl, { firstName: st ? st.firstName : '', state: st || {} }, overrides || {});
    } else {
      preview = templates.render(tpl, { state: {} }, overrides || {});
    }
    return { ...base, dryRun: true, preview, truncation_note: capNote(true),
      note: 'Nothing was sent. Re-post with confirm:true to send.' };
  }

  const batchId = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let sent = 0;
  let failed = 0;
  const failures = [];
  const queue = reachableIds.slice();
  // Per-recipient work is bounded by the template's state tier: a reminder that reads nothing but the
  // users row costs ONE lookup per user, not a full buildUserState with a correlated match scan.
  const worker = async () => {
    while (queue.length) {
      const uid = queue.shift();
      const u = await loadUser(uid);
      const st = u ? await stateForTemplate(tpl, u, shared) : null;
      const r = await sendToUser({ userId: uid, user: u || undefined, state: st || undefined,
        templateKey: tpl.key, overrides, adminId, batchId, shared });
      if (r.ok) sent++;
      else {
        failed++;
        if (runtimeSkipped[r.skipped] !== undefined) { runtimeSkipped[r.skipped]++; skipped[r.skipped]++; }
        if (failures.length < 20) failures.push({ userId: uid, reason: r.skipped || r.error || 'send_failed' });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, Math.max(1, reachableIds.length)) }, worker));

  return { ...base, dryRun: false, batchId, sent, failed, failures,
    stateTier: stateTierFor(tpl), truncation_note: capNote(false) };
}

module.exports = {
  DEDUPE_HOURS, DEFAULT_MAX_RECIPIENTS, ABSOLUTE_MAX_RECIPIENTS, MIN_MATCH,
  SEGMENT_LIST_CEILING, RESERVATION_TTL_MIN,
  ACTIVITY_KINDS, ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT,
  hashJobUrlId, urlAliasIds, resolveGlobalJobHash,
  loadUser, buildUserState, completenessOf,
  // exported for the test suite: the pure helpers whose edge cases are the bugs
  _int: int, stateTierFor, lightUserState, stateForTemplate, bestJobsFor, resumeContext,
  htmlToText, previewOf, sanitizeLetterHtml, parseCard, cardStr, titleFromUrl,
  getUserActivity, getUserCoverLetter,
  getUserOverview, getUserFile, getMatchedJobs, resolveJob,
  listTemplates, sendToUser,
  listSegments, getSegmentUsers, getSegment, notifySegment,
};
