// Subscription + usage routes — ADDITIVE. Quota status, the usage ledger for the Usage screen,
// device registration (trial dedupe), and an admin plan-assign endpoint for testing until the
// store subscription products exist.
'use strict';
const express = require('express');
const router = express.Router();
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const ents = require('../services/entitlements');
const downloads = require('../services/downloads');
const { normalizeEnvironment, PRODUCTION } = require('../services/storeEnvironment');

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
    // req: which environment's pool is paying decides which rows are `counted` (a TestFlight plan is not the App Store's).
    const items = await ents.getUsage(req.user.id, parseInt(req.query.limit, 10) || 100, req);
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

// Admin: grant a download pass without a store purchase.
//
// WHY THIS HAS TO EXIST. The pass product (com.cvapplyr.mobile.download.single) was created by the
// App Store Connect API but sits in MISSING_METADATA — the API is allowed to create the catalogue
// entry and refused (403) on name, description and price schedule, so the rest is console work by
// hand. A product in that state is invisible to fetchProducts, which means the app correctly shows
// "not on sale yet" and NOTHING CAN BE BOUGHT, in sandbox either. Without this endpoint the entire
// post-purchase experience — one employer unlocked, every design, every format, the letter too —
// cannot be exercised at all until App Review has been and gone.
//
// It mirrors /admin/set-subscription exactly: admin-authenticated, for testing, and it grants
// through the SAME services/downloads.grantPass() that a real receipt uses, so what is tested is
// the real code path and not a special case that only exists for testing.
//
// The synthetic transaction id is prefixed `admin-` so these can be told apart from real receipts
// in the table, and it stays idempotent on the store-transaction unique index.
router.post('/admin/grant-download-pass', authenticateAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const userId = parseInt(body.userId, 10);
    if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid userId' });

    const count = Math.min(Math.max(parseInt(body.count, 10) || 1, 1), 10);
    // ⚠️ CAPITALISED, VIA THE CANONICAL NORMALISER. The column's CHECK constraint is
    // environment IN ('Sandbox','Production'); a hand-rolled lowercase ternary here made every
    // INSERT raise a check violation that grantPass then swallowed, so this replied
    // { success: true, granted: 0 } and handed out nothing. Production is the default because a
    // granted pass has to be visible to the ordinary, header-less requests that will spend it.
    const environment = normalizeEnvironment(body.environment) || PRODUCTION;
    const store = body.store === 'google' ? 'google' : 'apple';

    let granted = 0;
    for (let i = 0; i < count; i++) {
      const storeTxnId = `admin-${userId}-${body.label || 'test'}-${i}-${Date.now()}`;
      // grantPass no longer swallows write failures — let one reach the 500 below rather than
      // reporting a success that never happened.
      if (await downloads.grantPass(userId, { store, environment, storeTxnId, productId: downloads.PASS_PRODUCT_ID })) granted++;
    }
    const state = await downloads.downloadState(userId, body.employer || null, req).catch(() => null);
    res.json({ success: true, granted, requested: count, environment, store, state });
  } catch (e) {
    console.error('[subscription] admin grant pass:', e.message);
    res.status(500).json({ error: 'Could not grant download pass' });
  }
});

module.exports = router;
