const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
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

module.exports = { router, setDbConfig };
