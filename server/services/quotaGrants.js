// Bonus quota — "here are 3 more free cover letters". ADDITIVE.
//
// WHY THIS EXISTS. The quota model counts CONSUMPTION: `usage_ledger` has one row per unit used and
// no amount column, and the allowances themselves are constants in entitlements.js (TRIAL.letters,
// PLANS[].letters). So before this file there was nowhere at all to record "this person was given
// extra" — the only grantable thing was legacy credits, and since 2026-09-13 credits pay for no
// generation at all.
//
// The fix is deliberately small: quota_grants rows are read by entitlements as
// `allowance + granted − used`, inside the SAME window the usage is counted in:
//   • a plan — its billing period. A grant counts toward the period it was made in and expires with it.
//   • the Free plan — its one-time window, from max(started_at, FREE_CUTOVER), which never closes. A
//     grant counts for as long as the user stays on Free; only grants from before the cutover are
//     outside it (they belonged to the old refilling windows, like the usage from then).
// That is the behaviour the copy promises — "we've added 3 free cover letters" — and nothing else changes.
//
// ⚠️ DAYS BUY NOTHING. The Free plan stopped expiring on 2026-08-10 and stopped refilling on
// 2026-09-13; `user_trials.ends_at` is only a NOT NULL filler that no entitlement reads. The allowance
// is TRIAL.letters + granted − used whatever the date, so anything meant to give a free user more must
// grant UNITS (grantQuota). extendTrial() survives for old callers as bookkeeping only, and reports
// `lettersStillAvailable` so no caller has to assume.
'use strict';

const dbConfig = require('../../db-config');

/** The kinds entitlements understands. 'trial_days' is bookkeeping for an ends_at extension — it grants nothing. */
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
 * Push a free-plan row's ends_at out, once per idem key. ⚠️ BOOKKEEPING ONLY: ends_at gates nothing (see
 * the top of this file), so this gives the user nothing they can use — no caller in the app offers
 * days any more, and none should.
 *
 * Only touches a row that EXISTS. It does not create one — a user with no row either never used a
 * metered feature or is on a plan, and inventing one from a marketing nudge would hand a device-blocked
 * user the free allowance the device rule denied them.
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
    // GREATEST(ends_at, NOW()) so "+5 days" on a date already in the past lands five days from today
    // rather than still in the past — the recorded date stays sane for anyone reading the row, even
    // though (top of this file) no entitlement reads it.
    const rows = await dbConfig.query(
      `UPDATE user_trials
          SET ends_at = GREATEST(ends_at, NOW()) + ($2 || ' days')::interval
        WHERE user_id = $1
      RETURNING ends_at, started_at`,
      [uid, String(d)]);
    const endsAt = rows && rows[0] ? rows[0].ends_at : null;
    const startedAt = rows && rows[0] ? rows[0].started_at : trial.started_at;

    // Counted in the Free plan's one-time window — max(started_at, cutover), the same start the app's
    // own quota check uses. From started_at alone, every pre-cutover generation would count against 3 + 3.
    const { TRIAL, freeWindowStart } = require('./entitlements');
    const since = freeWindowStart(startedAt);
    const [usedL, usedR, bonusL, bonusR] = await Promise.all([
      usedCount(uid, 'cover_letter', 'trial', since),
      usedCount(uid, 'resume', 'trial', since),
      bonusSince(uid, 'cover_letter', since),
      bonusSince(uid, 'resume', since),
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

/**
 * Make sure a bonus grant will actually be COUNTABLE for this user, and return the window it lands in.
 *
 * ⚠️ This is the difference between granting quota and granting the ILLUSION of quota. entitlements
 * reads bonuses inside a window — `created_at >= period_start` for a plan, `>= max(started_at,
 * FREE_CUTOVER)` for the Free plan — and a free user with NO user_trials row has no window yet:
 * ensureTrial would later create one with started_at = NOW(), AFTER our grant, excluding it forever.
 * On production, 4 of the 16 users promised 3 free cover letters had no trial row at all — a quarter
 * of that campaign would have been a lie. So: open the window first, then grant.
 *
 * An existing Free row is always countable: the allowance is one-time and never closes, so there is no
 * "expired — reopen it with extra days" case any more (that is what `idemKey` used to key; it is still
 * accepted so callers need not change).
 *
 * Returns { via: 'plan' | 'trial' | null, opened?: string, blocked?: string }.
 */
async function ensureCountableWindow(userId, idemKey) {
  const uid = int(userId);
  if (!uid) return { via: null };
  try {
    const ent = require('./entitlements');
    const sub = await ent.activeSubscription(uid);
    if (sub && ent.planByKey(sub.plan_key)) return { via: 'plan' };

    const rows = await dbConfig.query('SELECT started_at FROM user_trials WHERE user_id = $1', [uid]);
    if (rows && rows[0]) return { via: 'trial' };

    // No Free row: they never touched a quota-gated feature. Open it through ensureTrial, which applies
    // ⚠️ ONE FREE ALLOWANCE PER DEVICE itself — with no request here, against the device this account
    // last reported. A device whose allowance belongs to another account gets no row and no grant:
    // a bonus must never become the free allowance the device rule refused.
    const t = await ent.ensureTrial(uid, null, null);
    if (t && t.blocked) return { via: null, blocked: t.blocked };
    return t ? { via: 'trial', opened: 'started_trial' } : { via: null };
  } catch (e) {
    console.warn('[quotaGrants] ensureCountableWindow:', e.message);
    return { via: null };
  }
}

module.exports = { KINDS, MAX_AMOUNT, grantQuota, bonusSince, extendTrial, listGrants, ensureCountableWindow };
