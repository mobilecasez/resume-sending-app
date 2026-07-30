// Subscription + usage routes — ADDITIVE. Quota status, the usage ledger for the Usage screen,
// device registration (trial dedupe), and an admin plan-assign endpoint for testing until the
// store subscription products exist.
'use strict';
const express = require('express');
const router = express.Router();
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const ents = require('../services/entitlements');

// Plan catalog + the caller's current entitlement picture (plan/trial/remaining/used).
router.get('/subscription/status', authenticateToken, async (req, res) => {
  try {
    const status = await ents.getStatus(req.user.id, req);
    res.json({ success: true, ...status });
  } catch (e) {
    console.error('[subscription] status:', e.message);
    res.status(500).json({ error: 'Could not load subscription status' });
  }
});

// The detailed ledger — every deduction with what it was for and which pool paid it.
router.get('/subscription/usage', authenticateToken, async (req, res) => {
  try {
    const items = await ents.getUsage(req.user.id, parseInt(req.query.limit, 10) || 100);
    res.json({ success: true, items });
  } catch (e) {
    console.error('[subscription] usage:', e.message);
    res.status(500).json({ error: 'Could not load usage' });
  }
});

// The app reports its keychain-persisted device id once per launch (used for trial dedupe).
router.post('/subscription/device', authenticateToken, async (req, res) => {
  try {
    const deviceId = String((req.body || {}).deviceId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) return res.status(400).json({ error: 'Invalid device id' });
    await ents.reportDevice(req.user.id, deviceId, ents.ipHashOf(req));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not record device' });
  }
});

// Admin: assign/clear a plan without a store purchase (testing until IAP products exist).
router.post('/admin/set-subscription', authenticateAdmin, async (req, res) => {
  try {
    const userId = parseInt((req.body || {}).userId, 10);
    if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid userId' });
    const r = await ents.adminSetSubscription(userId, (req.body || {}).planKey || null);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ success: true, ...r });
  } catch (e) {
    console.error('[subscription] admin set:', e.message);
    res.status(500).json({ error: 'Could not set subscription' });
  }
});

module.exports = router;
