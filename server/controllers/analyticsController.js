// First-party analytics intake + store server-notification webhooks. ADDITIVE.
// - POST /api/analytics/track : the app reports events (open auth; records user_id if a valid token is sent)
// - POST /api/webhooks/apple-notifications : Apple App Store Server Notifications V2 (real-time purchases/refunds/subs)
// - POST /api/webhooks/google-rtdn : Google Play Real-Time Developer Notifications (via Pub/Sub push)
// These NEVER grant entitlements/credits (the existing /payment/verify-* flow stays authoritative); they
// only record events for the live dashboard, so they return fast and never error the caller. Because
// nothing of value is granted here, we DECODE (not full x5c-chain-verify) the self-signed payloads —
// the worst case of a forged payload is a polluted analytics number, never a fraudulent credit.
const jwt = require('jsonwebtoken');
const live = require('../services/liveAnalytics');

const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'com.cvapplyr.mobile';

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

// ── Apple App Store Server Notifications V2 ────────────────────────────────────────────────────
// Map (notificationType, subtype) → clean lifecycle event. Unknown/new types → 'other' (Apple adds
// types over time; we never crash on them and always store the raw type).
function appleClassify(type, subtype) {
  switch (type) {
    case 'SUBSCRIBED':                 return subtype === 'RESUBSCRIBE' ? 'subscription_reactivated' : 'subscription_started';
    case 'DID_RENEW':                  return 'subscription_renewed';
    case 'DID_CHANGE_RENEWAL_STATUS':  return subtype === 'AUTO_RENEW_ENABLED' ? 'subscription_reactivated' : 'subscription_cancel_scheduled';
    case 'DID_FAIL_TO_RENEW':          return subtype === 'GRACE_PERIOD' ? 'subscription_grace' : 'subscription_expired';
    case 'EXPIRED':
    case 'GRACE_PERIOD_EXPIRED':
    case 'REVOKE':                     return 'subscription_expired';
    case 'OFFER_REDEEMED':             return (subtype === 'INITIAL_BUY' || subtype === 'RESUBSCRIBE') ? 'subscription_started' : 'other';
    case 'REFUND':                     return 'refund';
    case 'REFUND_REVERSED':            return 'refund_reversed';
    case 'CONSUMPTION_REQUEST':        return 'consumption_request';
    case 'ONE_TIME_CHARGE':            return 'purchase';
    case 'TEST':                       return 'test';
    default:                           return 'other'; // DID_CHANGE_RENEWAL_PREF, PRICE_INCREASE, RENEWAL_EXTENSION, etc.
  }
}

async function appleNotifications(req, res) {
  try {
    const env = req.body && req.body.signedPayload ? decodeJws(req.body.signedPayload) : null;
    if (env) {
      const tx = env.data && env.data.signedTransactionInfo ? decodeJws(env.data.signedTransactionInfo) : null;
      const rnw = env.data && env.data.signedRenewalInfo ? decodeJws(env.data.signedRenewalInfo) : null;
      const bundleId = (env.data && env.data.bundleId) || (tx && tx.bundleId) || null;
      // Only ignore if it's clearly another app's bundle; TEST/edge payloads (no bundleId) still record.
      if (!bundleId || bundleId === APPLE_BUNDLE_ID) {
        await live.recordStoreNotification({
          store: 'apple',
          notificationType: env.notificationType || null,
          subtype: env.subtype || null,
          event: appleClassify(env.notificationType, env.subtype),
          transactionId: tx ? tx.transactionId : null,
          originalTransactionId: (tx && tx.originalTransactionId) || (rnw && rnw.originalTransactionId) || null,
          productId: (tx && tx.productId) || (rnw && rnw.productId) || null,
          price: tx && tx.price != null ? tx.price / 1000 : null,   // Apple sends price in milliunits
          currency: (tx && tx.currency) || (rnw && rnw.currency) || null,
          environment: (env.data && env.data.environment) || (tx && tx.environment) || null,
          dedupeKey: env.notificationUUID ? 'a_' + env.notificationUUID : null,
          payload: env,
        });
      }
    }
  } catch (_) {}
  return res.status(200).end();
}

// ── Google Play Real-Time Developer Notifications (Pub/Sub push) ────────────────────────────────
const G_SUB = {
  1: 'subscription_renewed',   // RECOVERED (back to active)
  2: 'subscription_renewed',   // RENEWED
  3: 'subscription_canceled',  // CANCELED (auto-renew off; access until expiry)
  4: 'subscription_started',   // PURCHASED
  5: 'subscription_on_hold',   // ON_HOLD
  6: 'subscription_grace',     // IN_GRACE_PERIOD
  7: 'subscription_started',   // RESTARTED (re-subscribe)
  10: 'subscription_paused',   // PAUSED
  11: 'subscription_paused',   // PAUSE_SCHEDULE_CHANGED
  12: 'subscription_revoked',  // REVOKED (access lost now)
  13: 'subscription_expired',  // EXPIRED
};
const G_ONETIME = { 1: 'purchase', 2: 'purchase_canceled' };

function googleClassify(dn) {
  if (dn.testNotification) return { event: 'test', type: 'test', token: null, product: null };
  if (dn.subscriptionNotification) {
    const s = dn.subscriptionNotification;
    return { event: G_SUB[s.notificationType] || 'other', type: 'subscription:' + s.notificationType, token: s.purchaseToken || null, product: s.subscriptionId || null };
  }
  if (dn.oneTimeProductNotification) {
    const o = dn.oneTimeProductNotification;
    return { event: G_ONETIME[o.notificationType] || 'other', type: 'product:' + o.notificationType, token: o.purchaseToken || null, product: o.sku || null };
  }
  if (dn.voidedPurchaseNotification) {
    const v = dn.voidedPurchaseNotification;
    return { event: 'refund', type: 'voided:' + (v.productType || '') + ':' + (v.refundType || ''), token: v.purchaseToken || null, product: null };
  }
  return { event: 'other', type: 'unknown', token: null, product: null };
}

async function googleRtdn(req, res) {
  try {
    const msg = req.body && req.body.message;
    let dn = null;
    if (msg && msg.data) { try { dn = JSON.parse(Buffer.from(msg.data, 'base64').toString('utf8')); } catch {} }
    if (dn) {
      const c = googleClassify(dn);
      await live.recordStoreNotification({
        store: 'google',
        notificationType: c.type,
        subtype: null,
        event: c.event,
        transactionId: c.token,
        productId: c.product,
        environment: dn.packageName && /sandbox|test/i.test(dn.packageName) ? 'Sandbox' : 'Production',
        dedupeKey: (msg && msg.messageId) ? 'g_' + msg.messageId : null,
        payload: dn,
      });
    }
  } catch (_) {}
  return res.status(200).end();
}

module.exports = { track, appleNotifications, googleRtdn, appleClassify, googleClassify };
