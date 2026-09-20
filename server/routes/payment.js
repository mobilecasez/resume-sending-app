const express = require('express');
const router = express.Router();
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const paymentController = require('../controllers/paymentController');

// Pass dbConfig through middleware
let dbConfig;

function setDbConfig(db) {
    dbConfig = db;
}

// Create Razorpay order
router.post('/create-order', authenticateToken, (req, res) => {
    paymentController.createOrder(req, res, dbConfig);
});

// Verify Razorpay payment
router.post('/verify', authenticateToken, (req, res) => {
    paymentController.verifyPayment(req, res, dbConfig);
});

// Verify Apple In-App Purchase (the four CONSUMABLE credit packs only — subscriptions use
// /verify-apple-sub, which never touches the credit balance).
router.post('/verify-apple', authenticateToken, (req, res) => {
    paymentController.verifyApplePurchase(req, res, dbConfig);
});

// ── Store subscriptions (3.6) ────────────────────────────────────────────────────────────────
// Each of these takes only a POINTER to a purchase and re-reads the truth from the store's API.
const subs = require('../controllers/subscriptionPurchaseController');
router.post('/verify-apple-sub', authenticateToken, subs.verifyAppleSub);
// Two names for one handler on purpose. The shipped client (services/subscriptionService.ts:126)
// posts to /verify-google; the 3.6 spec names it /verify-google-sub and mirrors /verify-apple-sub.
// A binary already in a user's hands cannot be renamed, and a 404 here is a paid purchase that
// never becomes an entitlement — so both paths stay live permanently.
router.post('/verify-google', authenticateToken, subs.verifyGoogleSub);
router.post('/verify-google-sub', authenticateToken, subs.verifyGoogleSub);
// One-time (consumable) purchases on Play — the single-download pass. Apple's equivalent lives in
// /verify-apple, which already handled consumables for the credit packs; Play had no such route.
router.post('/verify-google-product', authenticateToken, subs.verifyGoogleProduct);
router.post('/restore', authenticateToken, subs.restorePurchases);
// The opaque per-user token the app attaches to a purchase so renewals can be attributed later.
router.get('/account-token', authenticateToken, subs.accountToken);

// Get payment order status
router.get('/status/:orderId', authenticateToken, (req, res) => {
    paymentController.getOrderStatus(req, res, dbConfig);
});

// Get payment history
router.get('/history', authenticateToken, (req, res) => {
    paymentController.getPaymentHistory(req, res, dbConfig);
});

// Get Razorpay config
router.get('/config', (req, res) => {
    paymentController.getConfig(req, res);
});

// ── Google Play user choice billing (India, Android) ──────────────────────────────────────────
// Our own checkout beside Play's, offered only where Google's programme allows it. All three
// routes answer honestly when the feature is off, because the app asks BEFORE it opens a billing
// connection and must be able to tell "off" from "broken". See server/services/userChoiceBilling.js.
const ucb = require('../services/userChoiceBilling');

// What the app may offer this device. Read-only, no money, no tokens.
router.get('/ucb/config', authenticateToken, (req, res) => {
    const cfg = ucb.config({ platform: req.query.platform, country: req.query.country });
    res.json({ success: true, ...cfg });
});

// The user picked our method in Google's chooser: make the gateway order.
router.post('/ucb/order', authenticateToken, async (req, res) => {
    try {
        const { planKey, externalTransactionToken, platform, country } = req.body || {};
        const r = await ucb.createOrder({
            userId: req.user.id, planKey, token: externalTransactionToken, platform, country,
        });
        if (!r.ok) return res.status(r.reason === 'unknown_plan' ? 400 : 409).json({ success: false, ...r });
        res.json({ success: true, ...r });
    } catch (e) {
        console.error('[ucb] order:', e && e.message);
        res.status(500).json({ success: false, reason: 'order_failed' });
    }
});

// The gateway took the money: prove it, switch the plan on, tell Google.
router.post('/ucb/verify', authenticateToken, async (req, res) => {
    try {
        const { transactionId, paymentId, signature } = req.body || {};
        const r = await ucb.settle({ userId: req.user.id, transactionId, paymentId, signature });
        if (!r.ok) return res.status(r.reason === 'bad_signature' ? 400 : 409).json({ success: false, ...r });
        res.json({ success: true, ...r });
    } catch (e) {
        console.error('[ucb] verify:', e && e.message);
        res.status(500).json({ success: false, reason: 'verify_failed' });
    }
});

// Admin: retry the payments Google has not been told about yet. Deliberately a route and not a
// timer — an armed scheduler is how 25 unapproved pushes once went out.
router.post('/admin/ucb/flush', authenticateAdmin, async (req, res) => {
    try {
        res.json({ success: true, ...(await ucb.flushUnreported(Number(req.body?.limit) || 50)) });
    } catch (e) {
        console.error('[ucb] flush:', e && e.message);
        res.status(500).json({ success: false, error: 'flush_failed' });
    }
});

module.exports = { router, setDbConfig };
