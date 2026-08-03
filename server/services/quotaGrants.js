// Bonus quota — "here are 3 more free cover letters" / "your trial is 5 days longer". ADDITIVE.
//
// WHY THIS EXISTS. The quota model counts CONSUMPTION: `usage_ledger` has one row per unit used and
// no amount column, and the allowances themselves are constants in entitlements.js (TRIAL.letters,
// PLANS[].letters). So before this file there was nowhere at all to record "this person was given
// extra" — the only grantable thing was legacy credits, which a trial user cannot even reach
// (the pool order is plan → trial → credits, so credits only surface once the trial is exhausted).
//
// The fix is deliberately small: quota_grants rows are read by entitlements as
// `allowance + granted − used`, inside the SAME window the usage is counted in. A grant made during
// the current trial or billing period counts toward it; one made before that window opened does not
// (it expired with the period it was given for). That is the behaviour the copy promises —
// "we've added 3 free cover letters to your trial" — and nothing else changes.
//
// ⚠️ EXTENDING A TRIAL DOES NOT GIVE MORE LETTERS. `user_trials.ends_at` only controls whether the
// trial is still active; the letter count is TRIAL.letters − used, independent of the end date. So
// someone who already burned all 5 letters gains NOTHING from extra days. Every caller that extends
// a trial for a user who is out of quota must grant letters too, or the notification is a lie.
// `extendTrial()` returns `lettersStillAvailable` so the caller can check rather than assume.
'use strict';

const dbConfig = require('../../db-config');

/** The kinds entitlements understands. 'trial_days' is bookkeeping for an ends_at extension. */
const KINDS = ['cover_letter', 'resume', 'trial_days'];
/** A single grant can never be larger than this — a bug in a nudge must not mint unlimited quota. */
const MAX_AMOUNT = 50;

const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);

/**
 * Grant bonus quota, ONCE. Idempotency is enforced by the UNIQUE (user_id, idem_key) constraint,
 * not by a read-then-write, so two concurrent runners cannot both pay out.
 *
 * Returns { granted, already, amount, error } — never throws.
 */
async function grantQuota(userId, kind, amount, idemKey, opts = {}) {
  const uid = int(userId);
  const n = int(amount);
  const key = String(idemKey || '').trim().slice(0, 120);
  if (!uid || !KINDS.includes(kind) || !key) return { granted: false, error: 'bad_request' };
  if (n <= 0 || n > MAX_AMOUNT) return { granted: false, error: 'bad_amount' };

  try {
    const rows = await dbConfig.query(
      `INSERT INTO quota_grants (user_id, kind, amount, source, idem_key, note)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, idem_key) DO NOTHING
       RETURNING id`,
      [uid, kind, n, String(opts.source || 'nudge').slice(0, 40), key,
        opts.note ? String(opts.note).slice(0, 300) : null]);
    if (rows && rows.length) return { granted: true, amount: n };
    return { granted: false, already: true, amount: 0 };
  } catch (e) {
    console.warn('[quotaGrants] grant failed:', e.message);
    return { granted: false, error: e.message };
  }
}

/**
 * Bonus units of `kind` granted to this user since `since` (a Date/ISO — the same window boundary
 * entitlements uses for usage). Returns 0 on any error so a broken read can never INFLATE quota.
 */
async function bonusSince(userId, kind, since) {
  if (!since) return 0;
  try {
    const rows = await dbConfig.query(
      `SELECT COALESCE(SUM(amount), 0)::int AS n FROM quota_grants
        WHERE user_id = $1 AND kind = $2 AND created_at >= $3`,
      [int(userId), kind, since]);
    return rows && rows[0] ? Math.max(0, int(rows[0].n)) : 0;
  } catch (e) {
    console.warn('[quotaGrants] bonusSince:', e.message);
    return 0;
  }
}

/**
 * Add days to a live trial, once per idem key.
 *
 * Only extends a trial that EXISTS. It does not create one — a user with no trial row either never
 * qualified or is on a plan, and inventing a trial for them from a marketing nudge would hand a paid
 * user a downgrade path and hand a device-blocked user the trial the device rule denied them.
 *
 * Returns { extended, already, endsAt, lettersStillAvailable, resumesStillAvailable, error }.
 * The two *StillAvailable* flags exist so callers can honour the warning at the top of this file.
 */
async function extendTrial(userId, days, idemKey, opts = {}) {
  const uid = int(userId);
  const d = int(days);
  const key = String(idemKey || '').trim().slice(0, 120);
  if (!uid || !key) return { extended: false, error: 'bad_request' };
  if (d <= 0 || d > 60) return { extended: false, error: 'bad_amount' };

  let trial = null;
  try {
    const rows = await dbConfig.query('SELECT * FROM user_trials WHERE user_id = $1', [uid]);
    trial = (rows && rows[0]) || null;
  } catch (e) { return { extended: false, error: e.message }; }
  if (!trial) return { extended: false, error: 'no_trial' };

  // Claim the idem key FIRST. If the UPDATE below fails we have under-granted, which is the safe
  // direction; if we updated first and the marker insert failed we would extend again next run.
  const claim = await grantQuota(uid, 'trial_days', d, key, { source: opts.source || 'nudge', note: opts.note });
  if (!claim.granted) return { extended: false, already: !!claim.already, error: claim.error };

  try {
    // GREATEST(ends_at, NOW()) so extending an ALREADY-EXPIRED trial gives the promised number of
    // days from today rather than silently landing in the past — "+5 days" on a trial that ended
    // last week must not resolve to a still-expired trial.
    const rows = await dbConfig.query(
      `UPDATE user_trials
          SET ends_at = GREATEST(ends_at, NOW()) + ($2 || ' days')::interval
        WHERE user_id = $1
      RETURNING ends_at, started_at`,
      [uid, String(d)]);
    const endsAt = rows && rows[0] ? rows[0].ends_at : null;
    const startedAt = rows && rows[0] ? rows[0].started_at : trial.started_at;

    const { TRIAL } = require('./entitlements');
    const [usedL, usedR, bonusL, bonusR] = await Promise.all([
      usedCount(uid, 'cover_letter', 'trial', startedAt),
      usedCount(uid, 'resume', 'trial', startedAt),
      bonusSince(uid, 'cover_letter', startedAt),
      bonusSince(uid, 'resume', startedAt),
    ]);
    return {
      extended: true,
      days: d,
      endsAt,
      lettersStillAvailable: Math.max(0, TRIAL.letters + bonusL - usedL),
      resumesStillAvailable: Math.max(0, TRIAL.resumes + bonusR - usedR),
    };
  } catch (e) {
    console.warn('[quotaGrants] extendTrial:', e.message);
    return { extended: false, error: e.message };
  }
}

async function usedCount(userId, kind, source, since) {
  try {
    const rows = await dbConfig.query(
      `SELECT COUNT(*)::int AS n FROM usage_ledger
        WHERE user_id = $1 AND kind = $2 AND source = $3 AND created_at >= $4`,
      [userId, kind, source, since]);
    return rows && rows[0] ? int(rows[0].n) : 0;
  } catch { return 0; }
}

/** Everything granted to a user, newest first — for the admin user page and the Usage screen. */
async function listGrants(userId, limit = 50) {
  try {
    const rows = await dbConfig.query(
      `SELECT id, kind, amount, source, note, created_at FROM quota_grants
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [int(userId), Math.min(Math.max(int(limit, 50), 1), 200)]);
    return (rows || []).map((r) => ({
      id: r.id, kind: r.kind, amount: int(r.amount), source: r.source,
      note: r.note || null, createdAt: r.created_at,
    }));
  } catch { return []; }
}

module.exports = { KINDS, MAX_AMOUNT, grantQuota, bonusSince, extendTrial, listGrants };
