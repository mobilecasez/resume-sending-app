'use strict';
// Credit rewards API — the app's "Earn free credits" screen reads GET /api/rewards (which also lazily
// auto-grants any newly-eligible self-serve reward). See services/creditRewards.js.
const rewards = require('../services/creditRewards');
const dbConfig = require('../../db-config');

// GET /api/rewards — reward status + balance (+ grants any self-serve reward the user has now earned).
async function getRewards(req, res) {
  try {
    const userId = req.user && req.user.id;
    const status = await rewards.getStatus(userId);
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
    const made = await rewards.evaluateSelfServe(req.user && req.user.id);
    res.json({ success: true, granted: made });
  } catch (e) {
    res.status(500).json({ error: 'Failed to evaluate rewards' });
  }
}

module.exports = { getRewards, evaluate };
