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
        // BillDesk asks for the paying device (its risk checks); the hosted page runs in the user's browser tab.
        const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || '0.0.0.0';
        const device = {
            init_channel: 'internet',
            ip,
            user_agent: String(req.headers['user-agent'] || 'CVApplyr Android').slice(0, 250),
            accept_header: 'text/html',
        };
        const r = await ucb.createOrder({
            userId: req.user.id, planKey, token: externalTransactionToken, platform, country, device,
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

// What happened to this payment — asked by the app the moment the payment tab closes, whatever the tab
// said. For BillDesk it asks BillDesk directly first, so a user who closed the page early still gets
// their plan. The browser's own result is never proof of anything.
router.get('/ucb/status/:id', authenticateToken, async (req, res) => {
    try {
        const r = await ucb.statusFor(req.user.id, req.params.id);
        if (!r.ok) return res.status(404).json({ success: false, reason: r.reason });
        res.json({ success: true, ...r });
    } catch (e) {
        console.error('[ucb] status:', e && e.message);
        res.status(500).json({ success: false, reason: 'status_failed' });
    }
});

// BillDesk's hosted page, opened in the user's browser tab. No login travels with a browser tab, so the
// link's own HMAC (?k=) is the permission, and a spent or unknown order gets nothing.
router.get('/ucb/billdesk/launch/:id', async (req, res) => {
    try {
        const html = await ucb.launchPageFor(req.params.id, req.query.k);
        res.set('Cache-Control', 'no-store');
        if (!html) return res.status(410).type('html').send(returnPage(null, 'This payment link has expired. Go back to CVApplyr and try again.'));
        res.type('html').send(html);
    } catch (e) {
        console.error('[ucb] billdesk launch:', e && e.message);
        res.status(500).type('html').send(returnPage(null, 'We could not open the payment page. Nothing was charged.'));
    }
});

// BillDesk posts the signed result here (the order's `ru`). The signature is the only authentication, and
// it is checked before anything is read. Whatever happens, the page hands the user back to the app, which
// then asks /ucb/status for the truth.
router.post('/ucb/billdesk/return', async (req, res) => {
    let txnId = null;
    try {
        const body = req.body || {};
        if (body.transaction_response) {
            const r = await ucb.acceptBillDeskResponse(String(body.transaction_response));
            txnId = r && r.txnId;
            if (!r.ok && !r.alreadyDone) console.warn('[ucb] billdesk return:', r.reason);
        }
        // terminal_state=111 is the user pressing Cancel on BillDesk's page: nothing to settle.
    } catch (e) {
        console.error('[ucb] billdesk return:', e && e.message);
    }
    res.set('Cache-Control', 'no-store');
    res.type('html').send(returnPage(txnId, 'Payment finished. Returning you to CVApplyr…'));
});

/** The last page of the browser tab: send the user back into the app. Only our own id is echoed. */
function returnPage(txnId, message) {
    const safeId = /^[0-9a-f-]{36}$/.test(String(txnId || '')) ? txnId : '';
    const deep = `cvapplyr://payment-return${safeId ? `?txn=${safeId}` : ''}`;
    const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CVApplyr</title></head><body style="font-family:-apple-system,system-ui,sans-serif;text-align:center;padding:48px 24px;color:#0B0F22">
<p>${esc(message)}</p><p><a href="${esc(deep)}" style="color:#2563EB">Return to CVApplyr</a></p>
<script>setTimeout(function(){ location.href = ${JSON.stringify(deep)}; }, 300);</script></body></html>`;
}

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
