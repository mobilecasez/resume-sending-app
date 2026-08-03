// "May we notify this person right now?" — the ONE place that answers it. ADDITIVE.
//
// Before this, five automated push jobs each capped themselves independently (a flag column on the
// domain row, a 20h window over `notifications`, rewardNudges' own table, two system_schedule
// timestamps), so nothing could see the total. One user could legitimately receive follow-up +
// credit-expiry + digest + interest-match + résumé-match on the same day and every job would
// consider itself well-behaved. Every automated push now records itself in `user_nudge_log` and asks
// this module first, so the caps are real.
//
// THE FOUR RULES, in the order they are checked:
//   1. QUIET HOURS  — never push at an hour of day this person has never been awake for (below).
//   2. GLOBAL GAP   — at most one automated push per MIN_GAP_HOURS, and MAX_PER_7D per week.
//   3. PER-NUDGE BACKOFF — attempt 1, then +3 days, then +8 days, then never again. A nudge someone
//      ignored twice is not more persuasive the fifth time; it is just noise.
//   4. SILENCE      — if the last SILENCE_STREAK nudges produced no app open at all, stop nudging
//      this person entirely for SILENCE_PAUSE_DAYS. This is the rule that actually protects people:
//      the others limit the rate, this one recognises "they are not interested" and backs off.
//
// QUIET HOURS, honestly. There is no timezone on a user: `users.country` is NULL for 177 of 180
// accounts and `app_events.country` is empty for every row, so a country→offset table would be a
// fiction dressed as precision. What we DO have is when each person actually opens the app. So the
// rule is evidence-based: only push during a UTC hour this specific user has been observed active in
// (±QUIET_SPREAD hours), where "active" includes the hour they signed up — which everyone has. If a
// person has only ever used the app at 19:00 UTC, 19:00 UTC is demonstrably not their 3am.
'use strict';

const dbConfig = require('../../db-config');

// ── policy ────────────────────────────────────────────────────────────────────────────────────
const MIN_GAP_HOURS = parseInt(process.env.NUDGE_MIN_GAP_HOURS || '20', 10);
const MAX_PER_7D = parseInt(process.env.NUDGE_MAX_PER_7D || '3', 10);
const MAX_ATTEMPTS = parseInt(process.env.NUDGE_MAX_ATTEMPTS || '3', 10);
/** Hours to wait before attempt N+1 of the SAME nudge. Index 0 is unused (attempt 1 has no wait). */
const BACKOFF_HOURS = [0, 72, 192];
const SILENCE_STREAK = parseInt(process.env.NUDGE_SILENCE_STREAK || '3', 10);
const SILENCE_PAUSE_DAYS = parseInt(process.env.NUDGE_SILENCE_PAUSE_DAYS || '30', 10);
/** How far either side of an observed-active hour still counts as a reasonable time to arrive. */
const QUIET_SPREAD = 3;

// Founder + QA accounts. Previously this list existed ONLY inside demandResearch, so every other
// job happily nudged the test accounts and polluted its own numbers.
const TEST_USER_IDS = new Set([4, 5, 6, 7, 8, 9, 11, 14, 24, 26, 41, 43]);

const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);

// ── recording ─────────────────────────────────────────────────────────────────────────────────
/** Log one automated push attempt. Every automated sender must call this — it IS the shared ledger. */
async function record(userId, nudgeKey, { attempt = 1, pushOk = null, skipped = null, incentive = null } = {}) {
  try {
    await dbConfig.query(
      `INSERT INTO user_nudge_log (user_id, nudge_key, attempt, push_ok, skipped, incentive)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [int(userId), String(nudgeKey).slice(0, 60), Math.max(1, int(attempt, 1)),
        pushOk === null ? null : !!pushOk,
        skipped ? String(skipped).slice(0, 60) : null,
        incentive ? String(incentive).slice(0, 120) : null]);
  } catch (e) { console.warn('[nudgeGate] record:', e.message); }
}

/**
 * Fill in `responded_at` for past nudges the user has since reacted to (any app event after the
 * send). Run once at the start of a sweep: the silence rule is only meaningful if "did they come
 * back?" is up to date, and computing it per-candidate would be one query per row.
 */
async function refreshResponses() {
  try {
    const r = await dbConfig.query(
      `UPDATE user_nudge_log l
          SET responded_at = e.first_after
         FROM (SELECT l2.id, MIN(a.created_at) AS first_after
                 FROM user_nudge_log l2
                 JOIN app_events a ON a.user_id = l2.user_id AND a.created_at > l2.sent_at
                WHERE l2.responded_at IS NULL
                  AND l2.push_ok IS TRUE
                  AND l2.sent_at > NOW() - INTERVAL '60 days'
                GROUP BY l2.id) e
        WHERE l.id = e.id
      RETURNING l.id`);
    return r ? r.length : 0;
  } catch (e) { console.warn('[nudgeGate] refreshResponses:', e.message); return 0; }
}

// ── the decision ──────────────────────────────────────────────────────────────────────────────
/**
 * Load everything the gate needs for a batch of users in THREE queries rather than three per user.
 * Returns a Map<userId, state> consumed by `check()`.
 */
async function loadState(userIds) {
  const ids = (userIds || []).map((n) => int(n)).filter(Boolean);
  const state = new Map();
  if (!ids.length) return state;
  for (const id of ids) state.set(id, { lastSentAt: null, sent7d: 0, byKey: new Map(), activeHours: new Set(), silentUntil: null });

  // 1) every logged send in the window that matters (7 days covers the weekly cap; 60 the streak)
  try {
    const rows = await dbConfig.query(
      `SELECT user_id, nudge_key, attempt, sent_at, push_ok, responded_at
         FROM user_nudge_log
        WHERE user_id = ANY($1::int[]) AND sent_at > NOW() - INTERVAL '60 days'
        ORDER BY sent_at DESC`, [ids]);
    for (const r of rows || []) {
      const s = state.get(int(r.user_id));
      if (!s) continue;
      // Only a push that actually went out counts against the caps. A skip ('opted_out', 'no_token')
      // reached nobody, so letting it consume the weekly budget would silently mute a reachable user.
      if (r.push_ok !== true) continue;
      const at = new Date(r.sent_at).getTime();
      if (!s.lastSentAt || at > s.lastSentAt) s.lastSentAt = at;
      if (Date.now() - at <= 7 * 86400000) s.sent7d += 1;
      const k = String(r.nudge_key);
      const prev = s.byKey.get(k);
      if (!prev || at > prev.at) s.byKey.set(k, { at, attempt: Math.max(1, int(r.attempt, 1)) });
      s.recent = s.recent || [];
      s.recent.push({ at, responded: !!r.responded_at });
    }
  } catch (e) { console.warn('[nudgeGate] loadState log:', e.message); }

  // 2) the hours of day this person is demonstrably awake
  try {
    const rows = await dbConfig.query(
      `SELECT user_id, EXTRACT(HOUR FROM created_at)::int AS h
         FROM app_events
        WHERE user_id = ANY($1::int[]) AND created_at > NOW() - INTERVAL '180 days'
        GROUP BY user_id, EXTRACT(HOUR FROM created_at)`, [ids]);
    for (const r of rows || []) {
      const s = state.get(int(r.user_id));
      if (s) s.activeHours.add(int(r.h));
    }
  } catch (e) { console.warn('[nudgeGate] loadState hours:', e.message); }

  // 3) signup hour — the floor of evidence, so a brand-new user is never treated as "no data"
  try {
    const rows = await dbConfig.query(
      `SELECT id, EXTRACT(HOUR FROM created_at)::int AS h FROM users WHERE id = ANY($1::int[])`, [ids]);
    for (const r of rows || []) {
      const s = state.get(int(r.id));
      if (s) s.activeHours.add(int(r.h));
    }
  } catch (e) { console.warn('[nudgeGate] loadState signup:', e.message); }

  return state;
}

/** Circular distance between two hours of a 24h clock (23 and 1 are 2 apart, not 22). */
function hourDistance(a, b) {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
}

/** Is `hour` within QUIET_SPREAD of an hour this user has been active in? */
function isAwakeAt(activeHours, hour) {
  if (!activeHours || !activeHours.size) return true;      // no evidence at all → do not block
  for (const h of activeHours) if (hourDistance(h, hour) <= QUIET_SPREAD) return true;
  return false;
}

/**
 * The decision for ONE user and ONE nudge key.
 * Returns { ok: true, attempt } or { ok: false, reason, detail }.
 *
 * PURE given `state` and `now` — every branch is unit-testable without a database.
 */
function check(userId, nudgeKey, state, now = Date.now(), opts = {}) {
  if (TEST_USER_IDS.has(int(userId))) return { ok: false, reason: 'test_account' };
  const s = state || { byKey: new Map(), activeHours: new Set() };

  // 4) silence — checked FIRST among the history rules, because someone who has stopped responding
  // should not even be evaluated for "which nudge fits them best".
  const recent = (s.recent || []).slice().sort((a, b) => b.at - a.at).slice(0, SILENCE_STREAK);
  if (recent.length >= SILENCE_STREAK && recent.every((r) => !r.responded)) {
    const newestIgnored = recent[0].at;
    const until = newestIgnored + SILENCE_PAUSE_DAYS * 86400000;
    if (now < until) {
      return { ok: false, reason: 'silent_user',
        detail: `last ${SILENCE_STREAK} nudges went unanswered; paused until ${new Date(until).toISOString().slice(0, 10)}` };
    }
  }

  // 3) per-nudge backoff
  const prev = s.byKey ? s.byKey.get(nudgeKey) : null;
  let attempt = 1;
  if (prev) {
    attempt = prev.attempt + 1;
    if (attempt > MAX_ATTEMPTS) {
      return { ok: false, reason: 'max_attempts', detail: `already sent '${nudgeKey}' ${prev.attempt}x` };
    }
    const waitH = BACKOFF_HOURS[attempt - 1] != null ? BACKOFF_HOURS[attempt - 1] : BACKOFF_HOURS[BACKOFF_HOURS.length - 1];
    const dueAt = prev.at + waitH * 3600000;
    if (now < dueAt) {
      return { ok: false, reason: 'backoff',
        detail: `attempt ${attempt} of '${nudgeKey}' due ${new Date(dueAt).toISOString().slice(0, 16)}Z` };
    }
  }

  // 2) global gap + weekly cap
  if (s.lastSentAt && (now - s.lastSentAt) < MIN_GAP_HOURS * 3600000) {
    const h = ((now - s.lastSentAt) / 3600000).toFixed(1);
    return { ok: false, reason: 'too_soon', detail: `last automated push ${h}h ago (min ${MIN_GAP_HOURS}h)` };
  }
  if (int(s.sent7d) >= MAX_PER_7D) {
    return { ok: false, reason: 'weekly_cap', detail: `${s.sent7d} automated pushes in the last 7 days (max ${MAX_PER_7D})` };
  }

  // 1) quiet hours — skipped when the caller is an admin doing a deliberate manual send
  if (!opts.ignoreQuietHours) {
    const hour = new Date(now).getUTCHours();
    if (!isAwakeAt(s.activeHours, hour)) {
      return { ok: false, reason: 'quiet_hours',
        detail: `${hour}:00 UTC is outside every hour this user has ever opened the app` };
    }
  }

  return { ok: true, attempt };
}

module.exports = {
  MIN_GAP_HOURS, MAX_PER_7D, MAX_ATTEMPTS, BACKOFF_HOURS, SILENCE_STREAK, SILENCE_PAUSE_DAYS,
  QUIET_SPREAD, TEST_USER_IDS,
  record, refreshResponses, loadState, check,
  // test seams
  _hourDistance: hourDistance, _isAwakeAt: isAwakeAt,
};
