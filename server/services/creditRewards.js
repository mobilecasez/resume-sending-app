'use strict';
// Credit REWARDS — grants credits for activation actions (complete profile, first apply, rate the app)
// and referrals. Amounts come from ai_event_costs (admin-configurable, same store as the costs), keyed by
// the direction:'credit' rows in eventCosts.CATALOG. Every grant is idempotent via
// user_reward_grants(user_id, idem_key), so evaluate() is safe to call on every app open.
const dbConfig = require('../../db-config');
const eventCosts = require('./eventCosts');

// Idempotently grant `eventKey`'s reward to a user: add the admin-configured (active) credit amount to
// user_credits and record it in the ledger. idempotencyKey defaults to eventKey (a one-time reward);
// referrals pass 'reward_referral:<referredUserId>' so each friend pays out at most once.
// Returns { granted, already, amount, off }.
async function grantReward(userId, eventKey, opts = {}) {
  if (!userId) return { granted: false, amount: 0 };
  const amount = await eventCosts.getEventCost(eventKey);   // 0 if the reward is switched off by an admin
  if (!amount || amount <= 0) return { granted: false, amount: 0, off: true };
  const idem = opts.idempotencyKey || eventKey;
  const existing = await dbConfig.get('SELECT id FROM user_reward_grants WHERE user_id = ? AND idem_key = ?', [userId, idem]).catch(() => null);
  if (existing) return { granted: false, already: true, amount };
  try {
    await dbConfig.run(
      'INSERT INTO user_reward_grants (user_id, event_key, idem_key, credits, note) VALUES (?, ?, ?, ?, ?)',
      [userId, eventKey, idem, amount, opts.note || null]);
  } catch (e) { return { granted: false, already: true, amount }; }   // UNIQUE race → treat as already granted
  // Credit the balance (create the row if the user has no credits row yet).
  const acct = await dbConfig.get('SELECT user_id FROM user_credits WHERE user_id = ?', [userId]).catch(() => null);
  if (acct) await dbConfig.run('UPDATE user_credits SET credits_remaining = credits_remaining + ?, credits_total = credits_total + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [amount, amount, userId]);
  else await dbConfig.run('INSERT INTO user_credits (user_id, credits_remaining, credits_total) VALUES (?, ?, ?)', [userId, amount, amount]);
  return { granted: true, amount };
}

// ── Eligibility checks for the self-serve, one-time rewards ──────────────────────
async function hasCompleteProfile(userId) {
  const r = await dbConfig.get("SELECT 1 AS ok FROM resume_metadata WHERE user_id = ? AND parse_status = 'done' LIMIT 1", [userId]).catch(() => null);
  return !!(r && r.ok);
}
async function hasAppliedOnce(userId) {
  // "Applied to a job" = a Job Hub job marked applied, OR an apply telemetry event (either signal counts).
  const r1 = await dbConfig.get("SELECT 1 AS ok FROM job_cover_letters WHERE user_id = ? AND status = 'applied' LIMIT 1", [userId]).catch(() => null);
  if (r1 && r1.ok) return true;
  const r2 = await dbConfig.get("SELECT 1 AS ok FROM app_events WHERE user_id = ? AND event IN ('apply','application_submitted','job_applied','application_sent') LIMIT 1", [userId]).catch(() => null);
  return !!(r2 && r2.ok);
}
async function hasRatedApp(userId) {
  const r = await dbConfig.get('SELECT 1 AS ok FROM app_feedback WHERE user_id = ? LIMIT 1', [userId]).catch(() => null);
  return !!(r && r.ok);
}

const SELF_SERVE = [
  { key: 'reward_complete_profile', check: hasCompleteProfile },
  { key: 'reward_first_apply',      check: hasAppliedOnce },
  { key: 'reward_rate_app',         check: hasRatedApp },
];

async function grantedKeys(userId) {
  const rows = await dbConfig.query('SELECT DISTINCT event_key FROM user_reward_grants WHERE user_id = ?', [userId]).catch(() => []);
  return new Set((rows || []).map((r) => r.event_key));
}

// Evaluate the self-serve rewards and grant any newly-eligible ones. Idempotent → safe on every app open /
// rewards-screen load / right after the triggering action. Returns the grants made THIS call.
async function evaluateSelfServe(userId) {
  if (!userId) return [];
  const made = [];
  const already = await grantedKeys(userId);
  for (const r of SELF_SERVE) {
    if (already.has(r.key)) continue;
    let ok = false; try { ok = await r.check(userId); } catch {}
    if (!ok) continue;
    const g = await grantReward(userId, r.key);
    if (g.granted) made.push({ key: r.key, amount: g.amount });
  }
  return made;
}

// Reward status for the app's "Earn credits" screen: each reward + amount + earned? + eligible-now? Runs
// the evaluator first so the state is fresh (a just-completed action shows as earned immediately).
async function getStatus(userId) {
  await evaluateSelfServe(userId).catch(() => {});
  const earned = await grantedKeys(userId);
  const eligibleChecks = { reward_complete_profile: hasCompleteProfile, reward_first_apply: hasAppliedOnce, reward_rate_app: hasRatedApp };
  const rewards = [];
  for (const c of eventCosts.CATALOG.filter((x) => x.direction === 'credit')) {
    const amount = await eventCosts.getEventCost(c.key);
    let eligible = false;
    if (!earned.has(c.key) && eligibleChecks[c.key]) { try { eligible = await eligibleChecks[c.key](userId); } catch {} }
    rewards.push({ key: c.key, label: c.label, description: c.description, amount, earned: earned.has(c.key), eligible, active: amount > 0 });
  }
  const totalRow = await dbConfig.get('SELECT COALESCE(SUM(credits),0) AS n FROM user_reward_grants WHERE user_id = ?', [userId]).catch(() => null);
  return { rewards, totalEarned: (totalRow && Number(totalRow.n)) || 0 };
}

module.exports = { grantReward, evaluateSelfServe, getStatus, grantedKeys, hasCompleteProfile, hasAppliedOnce, hasRatedApp };
