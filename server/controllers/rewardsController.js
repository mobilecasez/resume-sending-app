'use strict';
// Credit rewards API — the app's "Earn free credits" screen reads GET /api/rewards (which also lazily
// auto-grants any newly-eligible self-serve reward). See services/creditRewards.js.
const rewards = require('../services/creditRewards');
const referrals = require('../services/referrals');
const eventCosts = require('../services/eventCosts');
const rewardNudges = require('../services/rewardNudges');
const dbConfig = require('../../db-config');

// GET /api/rewards — reward status + balance (+ grants any self-serve reward the user has now earned, and
// pays this user's referrer if the user has now activated).
async function getRewards(req, res) {
  try {
    const userId = req.user && req.user.id;
    const status = await rewards.getStatus(userId);   // evaluates + grants the self-serve rewards
    await referrals.evaluateReferralQualification(userId).catch(() => {});   // may pay THIS user's referrer
    const bal = await dbConfig.get('SELECT credits_remaining FROM user_credits WHERE user_id = ?', [userId]).catch(() => null);
    res.json({ success: true, ...status, balance: bal ? (bal.credits_remaining || 0) : 0 });
  } catch (e) {
    console.error('[rewards] getRewards:', e.message);
    res.status(500).json({ error: 'Failed to load rewards' });
  }
}

// POST /api/rewards/evaluate — force an evaluation right after an action (returns the grants just made).
async function evaluate(req, res) {
  try {
    const userId = req.user && req.user.id;
    const made = await rewards.evaluateSelfServe(userId);
    await referrals.evaluateReferralQualification(userId).catch(() => {});
    res.json({ success: true, granted: made });
  } catch (e) {
    res.status(500).json({ error: 'Failed to evaluate rewards' });
  }
}

// GET /api/referral — the user's referral code + link + stats + credits-per-referral.
async function getReferral(req, res) {
  try {
    const userId = req.user && req.user.id;
    const st = await referrals.getReferralStatus(userId);
    const creditsPerReferral = await eventCosts.getEventCost('reward_referral');
    res.json({ success: true, ...st, creditsPerReferral, link: 'https://cvapplyr.com/download?ref=' + encodeURIComponent(st.code) });
  } catch (e) {
    console.error('[rewards] getReferral:', e.message);
    res.status(500).json({ error: 'Failed to load referral' });
  }
}

// POST /api/referral/claim { code } — a new user redeems a friend's code (call once, post-signup).
async function claimReferral(req, res) {
  try {
    const userId = req.user && req.user.id;
    const email = req.user && req.user.email;
    const r = await referrals.claimReferral(userId, (req.body && req.body.code) || '', email);
    if (!r.ok) return res.status(400).json({ success: false, reason: r.reason });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to claim referral' });
  }
}

// POST /api/admin/reward-nudge { nudgeKey, limit?, cooldownDays?, dryRun? } — ADMIN-ONLY. Safe by default:
// dryRun unless dryRun:false is passed explicitly (so a preview never blasts anyone).
async function sendRewardNudge(req, res) {
  try {
    const { nudgeKey, limit, cooldownDays } = req.body || {};
    const testSelf = (req.body && req.body.testSelf) === true;
    const dryRun = (req.body && req.body.dryRun) === false ? false : true;
    const opts = testSelf ? { testUserId: req.user && req.user.id } : { limit, cooldownDays, dryRun };
    const r = await rewardNudges.sendNudge(nudgeKey, opts);
    res.json({ success: !r.error, ...r });
  } catch (e) {
    console.error('[rewards] sendRewardNudge:', e.message);
    res.status(500).json({ error: 'Nudge failed' });
  }
}

module.exports = { getRewards, evaluate, getReferral, claimReferral, sendRewardNudge };
