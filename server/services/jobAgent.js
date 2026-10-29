// The Job Agent — "find the best jobs for me, tailor everything, and apply" (2026-10-29, the owner's request).
//
// What it does for one user, once a day (or when they tap "Find jobs now"):
//   1. FIND    — searches global_jobs with their saved criteria (roles, places, countries, remote) and ranks by
//                résumé-skill overlap (discoverController.matchExprSql), skipping anything already in their queue.
//   2. SCORE   — fitScorer: eligibility + language gates, then skills/experience/career fit. Gated or weak jobs
//                are dropped; the rest land in the queue as 'matched', each with its honest strengths and gaps.
//   3. PREPARE — for the best few: a tailored résumé and cover letter through the SAME employer-doc lanes Home
//                uses (resumeBuilderController.generateAI saveTo:'employer_doc', employerLetterController
//                .buildEmployerLetter), called with coveredOnly so they spend only what the user's plan, free
//                day or pass already covers — never a surprise charge. → 'ready'.
//   4. APPLY   — a job whose posting gives an application EMAIL can be sent from the user's own connected
//                Gmail/Outlook with both PDFs (letterSendController.sendLetterEmail: download-gated, so it needs a
//                plan or a pass). With send_mode 'auto_email' the agent sends it by itself; otherwise the user
//                taps Send. Every other job (company forms on Greenhouse, Lever, Workday… — 43% of our jobs)
//                stays 'ready' for the user to open and submit in the app with Auto Fill: a company form cannot
//                be submitted from our servers on the user's behalf (CAPTCHAs, their legal answers, account bans).
//
// ⚠️ THE METER IS PREPARATION, not sending: the AI cost is spent when the documents are written, so a plan's
// monthly allowance counts PREPARED applications (prepared_at in the plan's period). A skipped job still used its
// documents, which stay in the user's library. Free users get a small preview allowance and cannot send.
// ⚠️ SHIPS DISARMED: the daily sweep starts only with JOB_AGENT_SWEEP=1 AND the admin switch 'job_agent' ON
// (seeded OFF, fail-closed). A manual "Find jobs now" works for a user who turned their agent on, whatever the switch.
'use strict';

const dbConfig = require('../../db-config');
const entitlements = require('./entitlements');
const fitScorer = require('./fitScorer');
const { PRODUCTION, SANDBOX } = require('./storeEnvironment');

// ── schema (Migration 053) ──────────────────────────────────────────────────────────────────────
const AGENT_SQL = [
  `CREATE TABLE IF NOT EXISTS job_agent_settings (
     user_id      INTEGER PRIMARY KEY,
     enabled      BOOLEAN NOT NULL DEFAULT FALSE,
     criteria     JSONB   NOT NULL DEFAULT '{}'::jsonb,
     send_mode    TEXT    NOT NULL DEFAULT 'review',
     daily_cap    INTEGER NOT NULL DEFAULT 5,
     env          TEXT    NOT NULL DEFAULT 'Production',
     device_id    TEXT,
     last_run_at  TIMESTAMPTZ,
     last_summary JSONB,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS job_agent_queue (
     id            BIGSERIAL PRIMARY KEY,
     user_id       INTEGER NOT NULL,
     job_url       TEXT    NOT NULL,
     global_job_id UUID,
     title         TEXT,
     employer      TEXT,
     location      TEXT,
     country       TEXT,
     channel       TEXT    NOT NULL DEFAULT 'form',
     apply_email   TEXT,
     fit           JSONB,
     status        TEXT    NOT NULL DEFAULT 'matched',
     resume_doc_id TEXT,
     letter_doc_id TEXT,
     error         TEXT,
     env           TEXT    NOT NULL DEFAULT 'Production',
     prepared_at   TIMESTAMPTZ,
     applied_at    TIMESTAMPTZ,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (user_id, job_url)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_job_agent_queue_user_status ON job_agent_queue (user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_job_agent_queue_prepared ON job_agent_queue (user_id, prepared_at)`,
  `CREATE TABLE IF NOT EXISTS job_agent_fit_cache (
     user_id    INTEGER NOT NULL,
     job_url    TEXT    NOT NULL,
     resume_fp  TEXT    NOT NULL,
     fit        JSONB   NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (user_id, job_url, resume_fp)
   )`,
  // Per-plan monthly allowance overrides — the owner changes a limit here, no release (PLANS[].autoApplies is the default).
  `CREATE TABLE IF NOT EXISTS job_agent_limits (
     plan_key   TEXT PRIMARY KEY,
     monthly    INTEGER NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
];

const STATUSES = ['matched', 'preparing', 'ready', 'sending', 'sent', 'applied', 'skipped', 'failed', 'blocked'];
const PREPARED = ['ready', 'sending', 'sent', 'applied'];  // statuses whose documents exist
const FREE_PREVIEW_PREPARES = 3;   // a free user sees the agent work: 3 prepared applications per rolling 30 days, no sending
const MAX_DAILY_CAP = 10;          // never more than 10 a day — human pace, so employers' systems do not flag it
const MIN_FIT_DEFAULT = 60;
const SCORE_PER_RUN = 20;          // at most 20 jobs scored per run (2 AI calls, ≈ $0.016)
const CANDIDATES_PER_RUN = 40;
const SAME_EMPLOYER_DAYS = 30;     // never two applications to one employer inside 30 days

// ── small helpers ───────────────────────────────────────────────────────────────────────────────
const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const strList = (v, n, max) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((x) => str(x, max)).filter(Boolean).slice(0, n);
const envOf = (v) => (v === SANDBOX ? SANDBOX : PRODUCTION);
const asJson = (v, d) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };

/** The criteria a user may save, cleaned. Nothing else is stored. */
function cleanCriteria(c = {}) {
  const remote = ['any', 'remote', 'onsite', 'hybrid'].includes(c.remote) ? c.remote : 'any';
  return {
    roles: strList(c.roles, 6, 60),
    locations: strList(c.locations, 6, 60),
    countries: strList(c.countries, 6, 40),
    remote,
    minFit: Math.min(90, Math.max(40, int(c.minFit, MIN_FIT_DEFAULT))),
    excludeEmployers: strList(c.excludeEmployers, 30, 80),
  };
}

// ── the meter ───────────────────────────────────────────────────────────────────────────────────
async function limitOverride(planKey) {
  try {
    const r = await dbConfig.get('SELECT monthly FROM job_agent_limits WHERE plan_key = $1', [planKey]);
    return r && Number.isFinite(Number(r.monthly)) ? Math.max(0, Number(r.monthly)) : null;
  } catch { return null; }
}

/**
 * What this user may prepare: { planKey, monthly, used, remaining, since, canSend, preview }.
 * A subscriber counts prepared applications since their plan's period_start against PLANS[].autoApplies (or the
 * admin override); a free user gets FREE_PREVIEW_PREPARES per rolling 30 days and canSend false (sending attaches
 * the PDFs, and downloads are paid). Environment-scoped like every entitlement read.
 */
async function allowanceFor(userId, env = PRODUCTION) {
  const sub = await entitlements.activeSubscription(userId, env).catch(() => null);
  const plan = sub ? entitlements.planByKey(sub.plan_key) : null;
  let planKey = 'free', monthly = FREE_PREVIEW_PREPARES, since = new Date(Date.now() - 30 * 86400000), canSend = false;
  if (sub && plan) {
    planKey = plan.key;
    const over = await limitOverride(plan.key);
    monthly = over != null ? over : (Number(plan.autoApplies) || 0);
    since = new Date(sub.period_start);
    canSend = true;
  } else {
    const over = await limitOverride('free');
    if (over != null) monthly = over;
  }
  const row = await dbConfig.get(
    `SELECT COUNT(*)::int AS n FROM job_agent_queue WHERE user_id = $1 AND prepared_at IS NOT NULL AND prepared_at >= $2`,
    [userId, since]);
  const used = row ? Number(row.n) || 0 : 0;
  return { planKey, monthly, used, remaining: Math.max(0, monthly - used), since: since.toISOString(), canSend, preview: !canSend };
}

async function preparedToday(userId) {
  const row = await dbConfig.get(
    `SELECT COUNT(*)::int AS n FROM job_agent_queue WHERE user_id = $1 AND prepared_at >= $2`,
    [userId, new Date(Date.now() - 86400000)]);
  return row ? Number(row.n) || 0 : 0;
}

// ── settings ────────────────────────────────────────────────────────────────────────────────────
async function getSettings(userId) {
  const r = await dbConfig.get('SELECT * FROM job_agent_settings WHERE user_id = $1', [userId]);
  if (!r) return { userId, enabled: false, criteria: cleanCriteria({}), sendMode: 'review', dailyCap: 5, env: PRODUCTION, lastRunAt: null, lastSummary: null };
  return {
    userId, enabled: !!r.enabled, criteria: cleanCriteria(asJson(r.criteria, {})),
    sendMode: r.send_mode === 'auto_email' ? 'auto_email' : 'review',
    dailyCap: Math.min(MAX_DAILY_CAP, Math.max(1, int(r.daily_cap, 5))),
    env: envOf(r.env), deviceId: r.device_id || null, lastRunAt: r.last_run_at || null, lastSummary: asJson(r.last_summary, null),
  };
}

async function saveSettings(userId, patch = {}, { env, deviceId } = {}) {
  const cur = await getSettings(userId);
  const next = {
    enabled: patch.enabled != null ? !!patch.enabled : cur.enabled,
    criteria: patch.criteria ? cleanCriteria(patch.criteria) : cur.criteria,
    sendMode: patch.sendMode === 'auto_email' ? 'auto_email' : patch.sendMode === 'review' ? 'review' : cur.sendMode,
    dailyCap: patch.dailyCap != null ? Math.min(MAX_DAILY_CAP, Math.max(1, int(patch.dailyCap, cur.dailyCap))) : cur.dailyCap,
  };
  // An agent cannot be switched on with nothing to look for — it would search everything and score noise.
  if (next.enabled && !next.criteria.roles.length) return { error: 'roles_required' };
  await dbConfig.run(
    `INSERT INTO job_agent_settings (user_id, enabled, criteria, send_mode, daily_cap, env, device_id, updated_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,NOW())
     ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, criteria = EXCLUDED.criteria,
       send_mode = EXCLUDED.send_mode, daily_cap = EXCLUDED.daily_cap, env = EXCLUDED.env,
       device_id = COALESCE(EXCLUDED.device_id, job_agent_settings.device_id), updated_at = NOW()`,
    [userId, next.enabled, JSON.stringify(next.criteria), next.sendMode, next.dailyCap, envOf(env), deviceId || null]);
  return { ok: true, settings: await getSettings(userId) };
}

// ── FIND ────────────────────────────────────────────────────────────────────────────────────────
const FORM_HOSTS = /(greenhouse\.io|lever\.co|myworkdayjobs|workday|ashbyhq|smartrecruiters|workable|personio|recruitee|teamtailor|bamboohr|jobvite|icims|successfactors|taleo)/i;
const BOARD_HOSTS = /(greenhouse|lever\.co|workday|ashbyhq|smartrecruiters|workable|personio|recruitee|linkedin|indeed|glassdoor|arbetsformedlingen|jobtech|naukri|monster|stepstone|teamtailor|bamboohr|jobvite|icims)/i;

// An address is an APPLICATION address only when the words right before it say so ("send your CV to …",
// "applications to …"). A posting also names recruiters for questions, accommodations desks and privacy officers —
// emailing a résumé there in the user's name is exactly the unwanted send this agent must never make.
const APPLY_CONTEXT = /(apply|application|applications|send (us )?(your )?(cv|resume|résumé|application|profile|details)|email (us )?(your )?(cv|resume|résumé|application)|submit (your )?(cv|resume|résumé|application)|forward (your )?(cv|resume|résumé)|mail (your )?(cv|resume|résumé)|interested candidates)[^.@\n]{0,60}$/i;
const EMAIL_RE_G = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
const NOT_APPLY_LOCAL = /^(no-?reply|noreply|donotreply|privacy|gdpr|dpo|abuse|support|accommodation|accommodations|accessibility|ada|reasonable|disability|legal|compliance|security|press|media|sales|billing|info@example)/i;

/** How a job is applied to: an application email the POSTING asks for (never a guessed contact), else a form. */
function channelOf(job) {
  const url = String(job.job_url || '');
  // A job on a company's application system is applied to THERE, whatever address its text mentions.
  if (FORM_HOSTS.test(url)) return { channel: 'form', email: null };
  const texts = [];
  const resp = asJson(job.responsibilities, []);
  if (Array.isArray(resp)) for (const r of resp) texts.push(typeof r === 'string' ? r : JSON.stringify(r));
  const text = texts.join('\n');
  let m;
  EMAIL_RE_G.lastIndex = 0;
  while ((m = EMAIL_RE_G.exec(text))) {
    const addr = m[0].toLowerCase();
    if (NOT_APPLY_LOCAL.test(addr)) continue;
    const before = text.slice(Math.max(0, m.index - 90), m.index);
    if (APPLY_CONTEXT.test(before)) return { channel: 'email', email: addr };
  }
  return { channel: 'web', email: null };
}

/** The job as the document lanes want it. The website only when employer_domain is the employer's own site. */
function jobForDocs(job) {
  const resp = asJson(job.responsibilities, []);
  const skills = asJson(job.skills, []);
  const lines = [];
  if (Array.isArray(resp)) for (const r of resp.slice(0, 20)) lines.push(typeof r === 'string' ? r : (r && (r.text || r.title)) || '');
  if (Array.isArray(skills) && skills.length) lines.push('Skills: ' + skills.slice(0, 20).map((s) => (typeof s === 'string' ? s : (s && s.name) || '')).join(', '));
  const domain = String(job.employer_domain || '').trim().toLowerCase();
  return {
    company: str(job.employer_name, 120),
    title: str(job.title, 160),
    url: job.job_url,
    description: lines.filter(Boolean).join('\n').slice(0, 6000),
    // ⚠️ 73% of employer_domain values are job-board hosts, not websites — and a fabricated www.{slug}.com is worse
    // than none (memory: employer search is website-first). The lanes research the employer themselves.
    website: domain && !BOARD_HOSTS.test(domain) ? `https://${domain}` : '',
  };
}

/** Candidate jobs for the criteria, best résumé overlap first. Plain SQL, no AI, no paid side effects. */
async function searchCandidates(userId, criteria, { limit = CANDIDATES_PER_RUN } = {}) {
  const { getResume, skillsOf, matchExprSql } = require('../controllers/discoverController');
  const { expandForSql } = require('../utils/searchSynonyms');
  const skills = skillsOf(await getResume(userId));
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const where = ['g.is_active = TRUE', `g.last_seen > NOW() - INTERVAL '30 days'`];

  // Roles: any role matches; within a role every word must appear (with its synonyms) in title or skills.
  const roleClauses = [];
  for (const role of criteria.roles) {
    const words = role.toLowerCase().split(/\s+/).filter((w) => w.length >= 2).slice(0, 4);
    if (!words.length) continue;
    const ands = words.map((w) => {
      const alts = expandForSql(w).slice(0, 8);
      return '(' + alts.map((a) => `(lower(g.title) LIKE ${p('%' + a + '%')} OR lower(COALESCE(g.skills::text,'')) LIKE ${p('%' + a + '%')})`).join(' OR ') + ')';
    });
    roleClauses.push('(' + ands.join(' AND ') + ')');
  }
  if (roleClauses.length) where.push('(' + roleClauses.join(' OR ') + ')');
  if (criteria.locations.length) where.push('(' + criteria.locations.map((l) => `lower(COALESCE(g.location,'')) LIKE ${p('%' + l.toLowerCase() + '%')}`).join(' OR ') + ')');
  if (criteria.countries.length) where.push(`lower(COALESCE(g.country,'')) = ANY(${p(criteria.countries.map((c) => c.toLowerCase()))}::text[])`);
  if (criteria.remote === 'remote') where.push(`lower(COALESCE(g.work_mode,'') || ' ' || COALESCE(g.location,'')) LIKE '%remote%'`);
  if (criteria.remote === 'onsite') where.push(`lower(COALESCE(g.work_mode,'')) NOT LIKE '%remote%'`);
  if (criteria.remote === 'hybrid') where.push(`lower(COALESCE(g.work_mode,'')) LIKE '%hybrid%'`);
  if (criteria.excludeEmployers.length) where.push(`lower(COALESCE(g.employer_name,'')) <> ALL(${p(criteria.excludeEmployers.map((e) => e.toLowerCase()))}::text[])`);
  // Never a job already in the queue, and never an employer applied to (or prepared for) in the last 30 days.
  where.push(`NOT EXISTS (SELECT 1 FROM job_agent_queue q WHERE q.user_id = ${p(userId)} AND (q.job_url = g.job_url
      OR (lower(q.employer) = lower(g.employer_name) AND q.prepared_at > NOW() - INTERVAL '${SAME_EMPLOYER_DAYS} days')))`);
  const skillsParam = p(skills);
  // The freshest 1500 matches first (the feed's own BASE_CAP), THEN the résumé-overlap ranking over them: the match
  // expression runs sub-selects per row, and a broad role ("sales") must not make it run over a hundred thousand.
  const sql = `SELECT g.*, ${matchExprSql(skillsParam)} AS match FROM (
                 SELECT g.id, g.job_url, g.title, g.employer_name, g.employer_domain, g.location, g.country, g.work_mode,
                        g.job_type, g.salary, g.experience, g.skills, g.responsibilities, g.first_seen
                   FROM global_jobs g
                  WHERE ${where.join(' AND ')}
                  ORDER BY g.first_seen DESC
                  LIMIT 1500) g
                ORDER BY match DESC NULLS LAST, g.first_seen DESC
                LIMIT ${Math.max(1, Math.min(100, limit))}`;
  return (await dbConfig.query(sql, params)) || [];
}

// ── SCORE ───────────────────────────────────────────────────────────────────────────────────────
async function scoreWithCache(userId, resumeText, jobs) {
  const fp = fitScorer.resumeFingerprint(resumeText);
  const out = new Map();
  const urls = jobs.map((j) => j.job_url);
  const cached = urls.length ? await dbConfig.query(
    'SELECT job_url, fit FROM job_agent_fit_cache WHERE user_id = $1 AND resume_fp = $2 AND job_url = ANY($3::text[])',
    [userId, fp, urls]).catch(() => []) : [];
  for (const r of cached || []) out.set(r.job_url, asJson(r.fit, null));
  const todo = jobs.filter((j) => !out.has(j.job_url)).slice(0, SCORE_PER_RUN);
  if (todo.length) {
    const scored = await fitScorer.scoreJobs(resumeText, todo.map((j) => ({ ...j, id: j.job_url })));
    for (const [url, fit] of scored) {
      out.set(url, fit);
      await dbConfig.run(
        `INSERT INTO job_agent_fit_cache (user_id, job_url, resume_fp, fit) VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (user_id, job_url, resume_fp) DO UPDATE SET fit = EXCLUDED.fit, created_at = NOW()`,
        [userId, url, fp, JSON.stringify(fit)]).catch(() => {});
    }
  }
  return out;
}

// ── calling the existing lanes ──────────────────────────────────────────────────────────────────
/** A request the existing handlers accept: the user, the body, the store environment and device the user saved. */
function agentReq(userId, body, { env, deviceId, params, letterMail } = {}) {
  const headers = { 'x-platform': 'job-agent' };
  if (env === SANDBOX) headers['x-store-env'] = SANDBOX;
  if (deviceId && /^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) headers['x-device-id'] = deviceId;
  const noop = () => {};
  return { user: { id: userId }, body: { ...body }, query: {}, params: params || {}, headers, letterMail,
    socket: { remoteAddress: '' }, ip: '', on: noop, once: noop, removeListener: noop, get: (h) => headers[String(h).toLowerCase()] };
}
/** A response that records what the handler answered. */
function captureRes() {
  const state = { status: 200, body: undefined };
  const noop = () => res;
  const res = {
    statusCode: 200, headersSent: false, writableEnded: false, locals: {},
    status(c) { state.status = c; res.statusCode = c; return res; },
    json(b) { state.body = b; res.headersSent = true; res.writableEnded = true; return res; },
    send(b) { state.body = b; res.headersSent = true; res.writableEnded = true; return res; },
    end() { res.headersSent = true; res.writableEnded = true; return res; },
    set: noop, setHeader: noop, header: noop, type: noop, on: noop, once: noop, removeListener: noop,
  };
  return { res, state };
}
async function callLane(handler, req) {
  const { res, state } = captureRes();
  await handler(req, res);
  return { status: state.status, body: state.body || {} };
}

/** The base résumé text and contact details the résumé lane needs (what the app sends from Home). */
async function resumeInputsFor(userId, env) {
  const scorer = require('./resumeScorer');
  const narrative = await scorer.narrativeFor(userId, { base: true, env, strict: false }).catch(() => null);
  const u = await dbConfig.get('SELECT full_name, email, phone_number, address FROM users WHERE id = $1', [userId]).catch(() => null);
  return {
    text: narrative && narrative.text ? narrative.text : '',
    name: (u && u.full_name) || '', email: (u && u.email) || '', phone: (u && u.phone_number) || '', location: (u && u.address) || '',
  };
}

async function setItem(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await dbConfig.run(`UPDATE job_agent_queue SET ${sets}, updated_at = NOW() WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
}

/**
 * Write the tailored résumé and letter for one queued job. → { ok, status, error }.
 * ⚠️ coveredOnly: the lanes spend only what already covers the build (plan, free day, a pass already bound to this
 * employer) and refuse otherwise — the agent never makes a purchase decision for the user.
 */
async function prepareItem(userId, item, { env, deviceId } = {}) {
  const rb = require('../controllers/resumeBuilderController');
  const el = require('../controllers/employerLetterController');
  const downloads = require('./downloads');
  // ⚠️ CLAIMED, NOT ASSUMED. A run reads its list once and then spends minutes per item; meanwhile the user may
  // have skipped, sent or prepared that very row. Only a row still matched/failed is taken, by one caller.
  const claimed = await dbConfig.get(
    `UPDATE job_agent_queue SET status = 'preparing', error = NULL, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status IN ('matched','failed') RETURNING id`, [item.id, userId]);
  if (!claimed) return { ok: false, error: 'not_preparable' };
  // ⚠️ THE PAYER IS NAMED BEFORE ANY LANE RUNS (contract C2, expectVia). coveredOnly alone still lets a lane
  // RESERVE the user's unspent one-employer pass when the plan and the free day cannot pay — binding a pass they
  // bought for a company they chose to one the agent chose. So the agent asks the gates first and sends their
  // payer as expectVia: a lane that would pay any other way (a pass) refuses with 409 payer_changed, having bound,
  // charged and stored nothing. No quota at all → nothing is called.
  const probe = agentReq(userId, {}, { env, deviceId });
  const [qR, qL] = await Promise.all([
    entitlements.canConsumeMany(userId, 'resume', 1, probe).catch(() => ({ allowed: false })),
    entitlements.canConsumeMany(userId, 'cover_letter', 1, probe).catch(() => ({ allowed: false })),
  ]);
  const payR = downloads.quotaPayerOf(qR);
  const payL = downloads.quotaPayerOf(qL);
  if (!payR || !payL) {
    await setItem(item.id, { status: 'matched', error: 'quota_exhausted' });
    return { ok: false, error: 'quota_exhausted' };
  }
  const g = item.global_job_id
    ? await dbConfig.get('SELECT * FROM global_jobs WHERE id = $1', [item.global_job_id]).catch(() => null)
    : null;
  const job = jobForDocs(g || { job_url: item.job_url, title: item.title, employer_name: item.employer });
  const inputs = await resumeInputsFor(userId, env);
  if (!inputs.text) { await setItem(item.id, { status: 'failed', error: 'no_resume' }); return { ok: false, error: 'no_resume' }; }

  const common = { coveredOnly: true, country: item.country || undefined, docJobUrl: item.job_url, job };
  const backTo = (reason) => (reason === 'quota_exhausted' || reason === 'payer_changed' ? 'matched' : 'failed');
  const r = await callLane(rb.generateAI, agentReq(userId, {
    ...common, expectVia: payR, saveTo: 'employer_doc', rawText: inputs.text, includeUploadedResume: true,
    name: inputs.name, email: inputs.email, phone: inputs.phone, location: inputs.location,
  }, { env, deviceId }));
  if (r.status >= 400 || !r.body.docId) {
    const reason = r.body.reason || `resume_${r.status}`;
    await setItem(item.id, { status: backTo(reason), error: reason });
    return { ok: false, error: reason, charged: false };
  }
  const l = await callLane(el.buildEmployerLetter, agentReq(userId, { ...common, expectVia: payL, employer: job.company }, { env, deviceId }));
  if (l.status >= 400 || !l.body.docId) {
    const reason = l.body.reason || `letter_${l.status}`;
    // The résumé stands (it is in their library and was paid for); a retry finds it cached (free) and pays only
    // the letter. `charged` tells the run a unit WAS spent, so it counts against today's budget.
    await setItem(item.id, { status: backTo(reason), error: reason, resume_doc_id: String(r.body.docId) });
    return { ok: false, error: reason, charged: !r.body.cached };
  }
  // Only a row this call still holds becomes ready (a skip during the build wins: the documents stay in the library).
  const done = await dbConfig.get(
    `UPDATE job_agent_queue SET status = 'ready', error = NULL, resume_doc_id = $2, letter_doc_id = $3, prepared_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'preparing' RETURNING id`, [item.id, String(r.body.docId), String(l.body.docId)]);
  return done ? { ok: true, status: 'ready' } : { ok: false, error: 'superseded', charged: true };
}

/** The short email that carries the two PDFs — no AI, and nothing the attachments do not already say. */
function applicationEmail(item, name) {
  const role = item.title || 'the open position';
  return {
    subject: `Application: ${role}`.slice(0, 150),
    body: `Dear Hiring Team,\n\nPlease find attached my application for ${role}${item.employer ? ` at ${item.employer}` : ''}: my résumé and a cover letter written for this role.\n\nI would welcome the chance to discuss how I can contribute. Thank you for your time and consideration.\n\nKind regards,\n${name || ''}`.trim(),
  };
}

/** Send one ready email-channel application from the user's own mailbox. → { ok, error }. */
async function sendItem(userId, item, { env, deviceId } = {}) {
  if (item.channel !== 'email' || !item.apply_email) return { ok: false, error: 'not_email_channel' };
  if (!item.letter_doc_id || !item.resume_doc_id) return { ok: false, error: 'not_prepared' };
  const ls = require('../controllers/letterSendController');
  const u = await dbConfig.get('SELECT full_name FROM users WHERE id = $1', [userId]).catch(() => null);
  const mail = applicationEmail(item, u && u.full_name);
  // Claimed first, so two taps (or the sweep and a tap) cannot both send it.
  const claim = await dbConfig.get(
    `UPDATE job_agent_queue SET status = 'sending', updated_at = NOW() WHERE id = $1 AND status = 'ready' RETURNING id`, [item.id]);
  if (!claim) return { ok: false, error: 'not_ready' };
  // The letter goes in ITS OWN top-ranked design (the one Home shows first), not the catalogue's first template.
  let template;
  try {
    const docs = require('./employerDocs');
    const doc = await docs.getById(userId, item.letter_doc_id, env || PRODUCTION, { kind: 'cover_letter' });
    const top = doc && doc.design && Array.isArray(doc.design.ranked) && doc.design.ranked[0];
    if (top && top.id) template = String(top.id);
  } catch { /* the lane's default design */ }
  const r = await callLane(ls.sendLetterEmail, agentReq(userId, {
    letter: { source: 'doc' }, resume: { source: 'tailored', docId: item.resume_doc_id }, ...(template ? { template } : {}),
  }, { env, deviceId, params: { id: item.letter_doc_id }, letterMail: { to: [item.apply_email], subject: mail.subject, body: mail.body } }));
  if (r.status >= 400 || r.body.success === false) {
    const raw = r.body.reason || `send_${r.status}`;
    // ⚠️ AN UNKNOWN OUTCOME IS NEVER RESENT. The mailbox may have accepted it before the connection dropped: it can
    // already be with the recruiter. Recorded as sent (with the doubt named), so no run and no tap sends it again.
    if (raw === 'unknown_outcome') {
      await setItem(item.id, { status: 'sent', error: 'unknown_outcome', applied_at: new Date() });
      return { ok: false, error: 'unknown_outcome' };
    }
    const reason = raw === 'quota_exhausted' ? 'downloads_used' : raw;
    await setItem(item.id, { status: 'ready', error: reason });
    return { ok: false, error: reason };
  }
  await setItem(item.id, { status: 'sent', error: null, applied_at: new Date() });
  return { ok: true };
}

/**
 * Rows a restart (a deploy, a crash) left mid-flight. 'preparing' longer than 20 minutes → failed ('interrupted'),
 * so the user can retry or skip it; 'sending' → SENT with 'unknown_outcome': the mailbox may have taken it, and a
 * resend is the one thing worse than a doubt.
 */
async function recoverStuck(userId) {
  await dbConfig.run(
    `UPDATE job_agent_queue SET status = 'failed', error = 'interrupted', updated_at = NOW()
      WHERE user_id = $1 AND status = 'preparing' AND updated_at < NOW() - INTERVAL '20 minutes'`, [userId]).catch(() => {});
  await dbConfig.run(
    `UPDATE job_agent_queue SET status = 'sent', error = 'unknown_outcome', applied_at = COALESCE(applied_at, NOW()), updated_at = NOW()
      WHERE user_id = $1 AND status = 'sending' AND updated_at < NOW() - INTERVAL '20 minutes'`, [userId]).catch(() => {});
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────────
const running = new Set();   // one run per user at a time, in this process

/**
 * One agent run for one user. → summary { found, scored, matched, prepared, sent, skippedReason? }.
 * Never throws: a failure becomes the summary's `error`, recorded on the settings row.
 */
async function runForUser(userId, { manual = false } = {}) {
  const uid = int(userId);
  if (!uid) return { error: 'bad_user' };
  if (running.has(uid)) return { error: 'already_running' };
  running.add(uid);
  const summary = { at: new Date().toISOString(), manual, found: 0, scored: 0, matched: 0, prepared: 0, sent: 0 };
  try {
    await recoverStuck(uid);
    const s = await getSettings(uid);
    if (!s.enabled) return { ...summary, skippedReason: 'disabled' };
    if (!s.criteria.roles.length) return { ...summary, skippedReason: 'no_roles' };
    const inputs = await resumeInputsFor(uid, s.env);
    if (!inputs.text) return { ...summary, skippedReason: 'no_resume' };

    // FIND + SCORE
    const candidates = await searchCandidates(uid, s.criteria);
    summary.found = candidates.length;
    const fits = candidates.length ? await scoreWithCache(uid, inputs.text, candidates) : new Map();
    summary.scored = fits.size;
    const good = candidates
      .map((j) => ({ job: j, fit: fits.get(j.job_url) }))
      .filter((x) => x.fit && !x.fit.blocked && x.fit.score >= s.criteria.minFit)
      .sort((a, b) => b.fit.score - a.fit.score);
    // ⚠️ ONE EMPLOYER, ONCE: the best posting per employer in this run, and none for an employer already in the
    // queue in the last 30 days (matched, ready or sent) — three Acme postings must not become three emails to Acme.
    const queuedEmployers = new Set(((await dbConfig.query(
      `SELECT DISTINCT lower(employer) AS e FROM job_agent_queue
        WHERE user_id = $1 AND status <> 'skipped' AND created_at > NOW() - INTERVAL '${SAME_EMPLOYER_DAYS} days'`, [uid]).catch(() => [])) || [])
      .map((r) => r.e));
    const picked = [];
    for (const x of good) {
      const e = String(x.job.employer_name || '').toLowerCase();
      if (!e || queuedEmployers.has(e)) continue;
      queuedEmployers.add(e);
      picked.push(x);
      if (picked.length >= 15) break;
    }
    for (const { job, fit } of picked) {
      const ch = channelOf(job);
      const ins = await dbConfig.get(
        `INSERT INTO job_agent_queue (user_id, job_url, global_job_id, title, employer, location, country, channel, apply_email, fit, status, env)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'matched',$11)
         ON CONFLICT (user_id, job_url) DO NOTHING RETURNING id`,
        [uid, job.job_url, job.id || null, str(job.title, 200), str(job.employer_name, 160), str(job.location, 160), str(job.country, 60),
          ch.channel, ch.email, JSON.stringify(fit), s.env]).catch(() => null);
      if (ins) summary.matched += 1;
    }

    // PREPARE — within the plan's month and the daily cap.
    const allow = await allowanceFor(uid, s.env);
    const today = await preparedToday(uid);
    let budget = Math.max(0, Math.min(allow.remaining, s.dailyCap - today));
    summary.allowance = { monthly: allow.monthly, used: allow.used, remaining: allow.remaining, planKey: allow.planKey };
    if (budget > 0) {
      const toPrepare = await dbConfig.query(
        `SELECT * FROM job_agent_queue WHERE user_id = $1 AND status = 'matched'
          ORDER BY (fit->>'score')::int DESC NULLS LAST, created_at ASC LIMIT $2`, [uid, budget]);
      for (const item of toPrepare || []) {
        if (budget <= 0) break;
        const r = await prepareItem(uid, item, { env: item.env || s.env, deviceId: s.deviceId });
        if (r.ok) { summary.prepared += 1; budget -= 1; continue; }
        // A unit that WAS spent (the résumé, before the letter failed) counts against today's budget.
        if (r.charged) budget -= 1;
        // ⚠️ STOP, don't spend on: quota gone, no résumé, a payer change, or the AI provider failing — the next job
        // would pay for another résumé and meet the same letter failure.
        if (['quota_exhausted', 'no_resume', 'payer_changed', 'ai_busy', 'ai_down', 'failed'].includes(r.error)
          || /^(resume|letter)_5\d\d$/.test(String(r.error))) { summary.stoppedReason = r.error; break; }
      }
    } else {
      summary.skippedReason = allow.remaining <= 0 ? 'monthly_limit' : 'daily_cap';
    }

    // APPLY — only email applications, only when the user chose automatic sending and may send. ⚠️ The settings are
    // READ AGAIN here: preparing took minutes, and a user who switched to "I review each one" (or turned the agent
    // off) in the meantime must not have ten applications sent on the strength of a setting they just changed.
    const now = await getSettings(uid);
    const autoSend = now.enabled && now.sendMode === 'auto_email';
    if (autoSend && !allow.canSend) summary.sendBlocked = 'plan_required';
    if (autoSend && allow.canSend) {
      const ready = await dbConfig.query(
        `SELECT * FROM job_agent_queue WHERE user_id = $1 AND status = 'ready' AND channel = 'email' AND apply_email IS NOT NULL
          ORDER BY prepared_at ASC LIMIT 10`, [uid]);
      for (const item of ready || []) {
        const r = await sendItem(uid, item, { env: item.env || s.env, deviceId: s.deviceId });
        if (r.ok) summary.sent += 1;
        else if (['no_mail_account', 'reconnect', 'scope', 'paid_required'].includes(r.error)) { summary.sendBlocked = r.error; break; }
      }
    }
    await notifyRun(uid, summary).catch(() => {});
    return summary;
  } catch (e) {
    console.warn(`[jobAgent] run for user ${uid} failed:`, e.message);
    summary.error = String(e.message || e).slice(0, 200);
    return summary;
  } finally {
    running.delete(uid);
    await dbConfig.run('UPDATE job_agent_settings SET last_run_at = NOW(), last_summary = $2::jsonb WHERE user_id = $1',
      [uid, JSON.stringify(summary)]).catch(() => {});
  }
}

/** One in-app notification (with a push) when a run produced something the user can act on. */
async function notifyRun(userId, summary) {
  if (!summary.prepared && !summary.sent) return;
  const { createNotification } = require('../controllers/notificationsController');
  const parts = [];
  if (summary.prepared) parts.push(`${summary.prepared} tailored application${summary.prepared === 1 ? '' : 's'} ready`);
  if (summary.sent) parts.push(`${summary.sent} sent by email`);
  await createNotification(userId, 'jobs', 'Your Job Agent found matching jobs 🎯', parts.join(' · ') + '. Review them in Job Agent.',
    null, { route: '/(job-agent)', params: {}, action: 'job_agent_run' }, { push: true, category: 'application_updates' });
}

// ── queue reads and user actions ────────────────────────────────────────────────────────────────
function itemView(r) {
  const fit = asJson(r.fit, null);
  return {
    id: Number(r.id), jobUrl: r.job_url, title: r.title, employer: r.employer, location: r.location, country: r.country,
    channel: r.channel, applyEmail: r.apply_email || null, status: r.status, error: r.error || null,
    resumeDocId: r.resume_doc_id || null, letterDocId: r.letter_doc_id || null,
    fit: fit ? { score: fit.score, band: fit.band, strengths: fit.strengths || [], gaps: fit.gaps || [],
      language: fit.language, languageQuote: fit.languageQuote || '', eligibility: fit.eligibility, deadline: fit.deadline || null } : null,
    preparedAt: r.prepared_at || null, appliedAt: r.applied_at || null, createdAt: r.created_at,
  };
}

async function listQueue(userId, { status, limit = 60 } = {}) {
  const wanted = STATUSES.includes(status) ? status : null;
  const rows = await dbConfig.query(
    `SELECT * FROM job_agent_queue WHERE user_id = $1 ${wanted ? 'AND status = $3' : `AND status <> 'skipped'`}
      ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'preparing' THEN 1 WHEN 'matched' THEN 2 WHEN 'sending' THEN 3 ELSE 4 END,
               (fit->>'score')::int DESC NULLS LAST, created_at DESC LIMIT $2`,
    wanted ? [userId, Math.min(200, limit), wanted] : [userId, Math.min(200, limit)]);
  return (rows || []).map(itemView);
}

async function ownItem(userId, id) {
  return dbConfig.get('SELECT * FROM job_agent_queue WHERE id = $1 AND user_id = $2', [int(id), userId]);
}

/** The user asks for one matched job to be prepared now — inside the same monthly allowance. */
// ⚠️ ONE PIECE OF AGENT WORK PER USER AT A TIME (the run's `running` set). Without it, three quick Prepare taps all
// read "1 left" and all prepared; a tap during a sweep raced the sweep for the same allowance.
async function exclusive(userId, fn) {
  const uid = int(userId);
  if (running.has(uid)) return { error: 'already_running' };
  running.add(uid);
  try { return await fn(); } finally { running.delete(uid); }
}

async function prepareNow(userId, id) {
  return exclusive(userId, async () => {
    const item = await ownItem(userId, id);
    if (!item) return { error: 'not_found' };
    if (item.status !== 'matched' && item.status !== 'failed') return { error: 'not_preparable' };
    const s = await getSettings(userId);
    const env = item.env || s.env;
    const allow = await allowanceFor(userId, env);
    if (allow.remaining <= 0) return { error: 'monthly_limit', allowance: allow };
    const r = await prepareItem(userId, item, { env, deviceId: s.deviceId });
    return r.ok ? { ok: true, item: itemView(await ownItem(userId, id)) } : { error: r.error };
  });
}

async function sendNow(userId, id) {
  return exclusive(userId, async () => {
    const item = await ownItem(userId, id);
    if (!item) return { error: 'not_found' };
    const s = await getSettings(userId);
    const r = await sendItem(userId, item, { env: item.env || s.env, deviceId: s.deviceId });
    return r.ok ? { ok: true, item: itemView(await ownItem(userId, id)) } : { error: r.error };
  });
}

/** The user applied themselves (a company form, with Auto Fill) — recorded so the queue and history agree. */
async function markApplied(userId, id) {
  const r = await dbConfig.get(
    `UPDATE job_agent_queue SET status = 'applied', applied_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status IN ('ready','matched','failed') RETURNING id`, [int(id), userId]);
  return r ? { ok: true } : { error: 'not_found' };
}

async function skip(userId, id) {
  const r = await dbConfig.get(
    // 'preparing' too: a skip during the build wins — prepareItem's final step only promotes a row it still holds.
    `UPDATE job_agent_queue SET status = 'skipped', updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status IN ('matched','preparing','ready','failed') RETURNING id`, [int(id), userId]);
  return r ? { ok: true } : { error: 'not_found' };
}

async function overview(userId, reqEnv) {
  await recoverStuck(userId);
  const s = await getSettings(userId);
  // The allowance in the environment of the build that is ASKING (a TestFlight plan is Sandbox), not the one saved last.
  const allow = await allowanceFor(userId, reqEnv ? envOf(reqEnv) : s.env);
  const counts = await dbConfig.query(
    'SELECT status, COUNT(*)::int AS n FROM job_agent_queue WHERE user_id = $1 GROUP BY status', [userId]);
  const byStatus = {};
  for (const r of counts || []) byStatus[r.status] = Number(r.n) || 0;
  return { settings: s, allowance: allow, counts: byStatus, dailyCapMax: MAX_DAILY_CAP };
}

// ── the daily sweep (DISARMED) ──────────────────────────────────────────────────────────────────
let timer = null;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const USERS_PER_TICK = 20;

async function sweepOnce() {
  const notifSwitch = require('./notifSwitch');
  if (!(await notifSwitch.isOn('job_agent'))) return { skipped: 'switch_off' };
  const due = await dbConfig.query(
    `SELECT user_id FROM job_agent_settings WHERE enabled = TRUE
       AND (last_run_at IS NULL OR last_run_at < NOW() - INTERVAL '20 hours')
     ORDER BY last_run_at ASC NULLS FIRST LIMIT ${USERS_PER_TICK}`);
  const out = [];
  for (const r of due || []) out.push({ userId: r.user_id, ...(await runForUser(r.user_id)) });   // one at a time: the lanes are minutes long
  return { ran: out.length, results: out };
}

function startScheduler() {
  if (timer) return { started: false, reason: 'already' };
  if (String(process.env.JOB_AGENT_SWEEP || '0') !== '1') {
    console.log('[jobAgent] daily sweep DISARMED (set JOB_AGENT_SWEEP=1 and turn the job_agent switch on to arm)');
    return { started: false, reason: 'disarmed' };
  }
  timer = setInterval(() => { sweepOnce().catch((e) => console.warn('[jobAgent] sweep:', e.message)); }, SWEEP_EVERY_MS);
  if (timer.unref) timer.unref();
  return { started: true };
}

// ── admin: limits ───────────────────────────────────────────────────────────────────────────────
async function getLimits() {
  const rows = await dbConfig.query('SELECT plan_key, monthly FROM job_agent_limits').catch(() => []);
  const over = new Map((rows || []).map((r) => [r.plan_key, Number(r.monthly)]));
  const plans = entitlements.PLANS.map((p) => ({ planKey: p.key, label: p.label, default: Number(p.autoApplies) || 0, monthly: over.has(p.key) ? over.get(p.key) : (Number(p.autoApplies) || 0) }));
  return [{ planKey: 'free', label: 'Free (preview, no sending)', default: FREE_PREVIEW_PREPARES, monthly: over.has('free') ? over.get('free') : FREE_PREVIEW_PREPARES }, ...plans];
}
async function setLimit(planKey, monthly) {
  const known = planKey === 'free' || !!entitlements.planByKey(planKey);
  const n = int(monthly, -1);
  if (!known || n < 0 || n > 5000) return { error: 'bad_limit' };
  await dbConfig.run(
    `INSERT INTO job_agent_limits (plan_key, monthly, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (plan_key) DO UPDATE SET monthly = EXCLUDED.monthly, updated_at = NOW()`, [planKey, n]);
  return { ok: true, limits: await getLimits() };
}

module.exports = {
  AGENT_SQL, STATUSES, FREE_PREVIEW_PREPARES, MAX_DAILY_CAP, SAME_EMPLOYER_DAYS,
  cleanCriteria, allowanceFor, getSettings, saveSettings, searchCandidates, channelOf, jobForDocs, applicationEmail,
  runForUser, prepareItem, sendItem, prepareNow, sendNow, markApplied, skip, listQueue, overview, recoverStuck,
  sweepOnce, startScheduler, getLimits, setLimit,
  _internals: { agentReq, captureRes, callLane, scoreWithCache, itemView },
};
