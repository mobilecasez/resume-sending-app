// First-party analytics intake + store server-notification webhooks. ADDITIVE.
// - POST /api/analytics/track : the app reports events (open auth; records user_id if a valid token is sent)
// - POST /api/webhooks/apple-notifications : Apple App Store Server Notifications V2 (real-time purchases/refunds)
// - POST /api/webhooks/google-rtdn : Google Play Real-Time Developer Notifications (via Pub/Sub push)
// These NEVER grant entitlements/credits (the existing /payment/verify-* flow stays authoritative); they
// only record events for the live dashboard, so they return fast and never error the caller.
const jwt = require('jsonwebtoken');
const live = require('../services/liveAnalytics');

function softUserId(req) {
  try {
    const h = req.headers['authorization'] || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!t || !process.env.JWT_SECRET) return null;
    const u = jwt.verify(t, process.env.JWT_SECRET);
    return u && u.id ? u.id : null;
  } catch { return null; }
}

async function track(req, res) {
  try {
    const b = req.body || {};
    const userId = softUserId(req);
    const events = Array.isArray(b.events) ? b.events : [b];
    for (const e of events.slice(0, 40)) {
      if (!e || !e.event) continue;
      await live.trackEvent({
        event: e.event, props: e.props,
        platform: e.platform || b.platform, appVersion: e.appVersion || b.appVersion,
        anonId: e.anonId || b.anonId, country: e.country || b.country, userId,
      });
    }
  } catch (_) { /* analytics must never break the client */ }
  return res.status(204).end();
}

function decodeJws(jws) {
  try { return JSON.parse(Buffer.from(String(jws).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

// Apple App Store Server Notifications V2 — body is { signedPayload: <JWS> }.
async function appleNotifications(req, res) {
  try {
    const payload = req.body && req.body.signedPayload ? decodeJws(req.body.signedPayload) : null;
    if (payload) {
      const tx = payload.data && payload.data.signedTransactionInfo ? decodeJws(payload.data.signedTransactionInfo) : null;
      await live.recordStoreNotification({
        store: 'apple', notificationType: payload.notificationType, subtype: payload.subtype,
        transactionId: tx && tx.transactionId, originalTransactionId: tx && tx.originalTransactionId,
        productId: tx && tx.productId, payload,
      });
    }
  } catch (_) {}
  return res.status(200).end();
}

// Google Play RTDN — Pub/Sub push: { message: { data: <base64 json> }, subscription }.
async function googleRtdn(req, res) {
  try {
    const msg = req.body && req.body.message;
    let data = null;
    if (msg && msg.data) { try { data = JSON.parse(Buffer.from(msg.data, 'base64').toString('utf8')); } catch {} }
    if (data) {
      const sn = data.subscriptionNotification, op = data.oneTimeProductNotification, vp = data.voidedPurchaseNotification, ts = data.testNotification;
      await live.recordStoreNotification({
        store: 'google',
        notificationType: sn ? `subscription:${sn.notificationType}` : op ? `product:${op.notificationType}` : vp ? 'voided' : ts ? 'test' : 'unknown',
        productId: (sn && sn.subscriptionId) || (op && op.sku) || null,
        transactionId: (sn && sn.purchaseToken) || (op && op.purchaseToken) || (vp && vp.purchaseToken) || null,
        payload: data,
      });
    }
  } catch (_) {}
  return res.status(200).end();
}

module.exports = { track, appleNotifications, googleRtdn };
