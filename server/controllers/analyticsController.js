// First-party analytics intake + store server-notification webhooks.
// - POST /api/analytics/track : the app reports events (open auth; records user_id if a valid token is sent)
// - POST /api/webhooks/apple-notifications : Apple App Store Server Notifications V2
// - POST /api/webhooks/google-rtdn : Google Play Real-Time Developer Notifications (via Pub/Sub push)
//
// ⚠️ THESE NOW DRIVE ENTITLEMENT (renew / cancel / refund / expire / grace), which they did not
// before — a renewal used to leave user_subscriptions frozen at whatever the purchase call wrote.
// Two properties keep that safe on endpoints that anyone on the internet can POST to:
//
//   1. AUTHENTICITY. Apple's payload is x5c-chain-verified and root-pinned; Google's Pub/Sub push
//      is OIDC-JWT-verified. Both previously decoded without verifying anything at all.
//   2. THE BODY IS ONLY A POINTER. Even a perfectly signed notification is not believed: we take
//      the transaction id / purchase token out of it and RE-FETCH the state from the store's own
//      API over TLS. A forged notification can therefore only ask us to look something up, and the
//      answer comes from Apple or Google, not from the caller. An unverified payload is refused
//      outright unless we already hold a row for that purchase.
//
// Idempotency is inherited from storeSetSubscription()'s upsert: a redelivered notification
// recomputes identical state onto the same row and can never double-grant.
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const live = require('../services/liveAnalytics');
const dbConfig = require('../../db-config');
const appleApi = require('../services/appleStoreApi');
const playApi = require('../services/playStoreApi');
const storeSubs = require('../services/storeSubscriptions');
const storeProducts = require('../services/storeProducts');

// Hash the client IP (never store it raw) so we can dedup a person's repeat installs by network
// without holding PII. Salted so hashes aren't reversible/rainbow-tableable.
const IP_SALT = process.env.IP_HASH_SALT || process.env.JWT_SECRET || 'cvapplyr-ip-salt';
function clientIpHash(req) {
  try {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || xff || req.ip
      || (req.connection && req.connection.remoteAddress) || '';
    if (!ip) return null;
    return crypto.createHash('sha256').update(IP_SALT + '|' + ip).digest('hex').slice(0, 32);
  } catch { return null; }
}

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

function geoCountry(req) {
  const c = req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-appengine-country'] || req.headers['fastly-geo-country'] || null;
  if (!c || /^(XX|T1|ZZ)$/i.test(String(c))) return null; // CDN "unknown" sentinels
  return String(c).toUpperCase().slice(0, 2);
}

async function track(req, res) {
  try {
    const b = req.body || {};
    const userId = softUserId(req);
    const geo = geoCountry(req);
    const ipHash = clientIpHash(req);
    const events = Array.isArray(b.events) ? b.events : [b];
    for (const e of events.slice(0, 40)) {
      if (!e || !e.event) continue;
      await live.trackEvent({
        event: e.event, props: e.props,
        platform: e.platform || b.platform, appVersion: e.appVersion || b.appVersion,
        anonId: e.anonId || b.anonId, country: e.country || b.country || geo, userId, ipHash,
      });
    }
    // users.last_seen_at was declared in migration 004 and then NEVER written, so every
    // "active user" question had to be answered from app_events instead. Stamp it here — ONCE
    // per request, not once per event — for any batch that carried a valid token. Best-effort:
    // analytics intake must still succeed if this write fails.
    if (userId) {
      await dbConfig.run(`UPDATE users SET last_seen_at = NOW() WHERE id = ?`, [userId]).catch(() => {});
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

// Is this original_transaction_id one we already hold? Used to decide whether an UNVERIFIED payload
// is worth acting on: a purchase we already know about cannot be used to fish for anything new.
async function knownAppleTxn(originalTransactionId) {
  if (!originalTransactionId) return false;
  try {
    const rows = await dbConfig.query(
      `SELECT 1 FROM user_subscriptions WHERE store = 'apple' AND original_transaction_id = $1 LIMIT 1`,
      [String(originalTransactionId)]);
    return Boolean(rows && rows.length);
  } catch { return false; }
}

async function appleNotifications(req, res) {
  let transient = false;
  try {
    const signed = req.body && req.body.signedPayload;
    if (!signed) return res.status(200).end();

    // 1. AUTHENTICITY. Root-pinned x5c chain + ES256 signature. Null means "not proven Apple".
    const verified = appleApi.verifySignedPayload(signed);
    const env = verified || decodeJws(signed);        // unverified copy is for logging/pointers only
    if (!env) return res.status(200).end();

    const tx = env.data && env.data.signedTransactionInfo
      ? (verified ? appleApi.verifySignedPayload(env.data.signedTransactionInfo) : null) || decodeJws(env.data.signedTransactionInfo)
      : null;
    const rnw = env.data && env.data.signedRenewalInfo ? decodeJws(env.data.signedRenewalInfo) : null;
    const bundleId = (env.data && env.data.bundleId) || (tx && tx.bundleId) || null;
    if (bundleId && bundleId !== APPLE_BUNDLE_ID) return res.status(200).end();   // another app

    const originalTransactionId = (tx && tx.originalTransactionId) || (rnw && rnw.originalTransactionId) || null;
    const productId = (tx && tx.productId) || (rnw && rnw.productId) || null;
    const event = appleClassify(env.notificationType, env.subtype);

    // 2. ENTITLEMENT. Never from the payload — always a fresh read from Apple keyed by the pointer.
    let userId = null;
    const isOurSub = storeProducts.isSubscriptionProduct(productId);
    const mayAct = verified || await knownAppleTxn(originalTransactionId);
    if (isOurSub && originalTransactionId && mayAct && appleApi.isConfigured()) {
      try {
        const r = await storeSubs.applyAppleSubscription({ originalTransactionId });
        if (r.ok) {
          userId = r.userId;
          storeSubs.notifyIfNew(r);
          console.log(`[apple-webhook] ${env.notificationType}/${env.subtype || '-'} → user ${userId} ${r.planKey} ${r.status} until ${r.periodEnd}`);
        } else if (r.retryable) {
          transient = true;   // ask Apple to redeliver rather than lose a renewal
        } else {
          console.warn(`[apple-webhook] not applied: ${r.reason} (${productId})`);
        }
      } catch (e) {
        transient = true;
        console.error('[apple-webhook] apply failed:', e.message);
      }
    } else if (isOurSub && originalTransactionId && mayAct && !appleApi.isConfigured()) {
      // The notification is real and ours, and we simply cannot ask Apple yet (key not set). Dropping
      // it with a 200 loses a renewal or a refund permanently. Ask Apple to bring it back instead.
      transient = true;
      console.error('[apple-webhook] App Store Server API not configured — asking Apple to redeliver');
    } else if (isOurSub && !verified) {
      console.warn('[apple-webhook] refused UNVERIFIED payload for an unknown transaction');
    }

    // 3. ANALYTICS. Recorded either way; user_id is now filled in whenever we could attribute it.
    await live.recordStoreNotification({
      store: 'apple',
      notificationType: (verified ? '' : 'UNVERIFIED:') + (env.notificationType || ''),
      subtype: env.subtype || null,
      event,
      transactionId: tx ? tx.transactionId : null,
      originalTransactionId,
      productId,
      price: tx && tx.price != null ? tx.price / 1000 : null,   // Apple sends price in milliunits
      currency: (tx && tx.currency) || (rnw && rnw.currency) || null,
      environment: (env.data && env.data.environment) || (tx && tx.environment) || null,
      userId,
      dedupeKey: env.notificationUUID ? 'a_' + env.notificationUUID : null,
      payload: env,
    });
  } catch (e) {
    console.error('[apple-webhook]', e.message);
  }
  // 500 makes Apple redeliver (up to 5 times over 3 days). Only used for OUR transient failures —
  // a forged or irrelevant payload always gets 200 so nobody can farm retries.
  return res.status(transient ? 500 : 200).end();
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

async function knownPlayToken(purchaseToken) {
  if (!purchaseToken) return false;
  try {
    const rows = await dbConfig.query(
      `SELECT 1 FROM user_subscriptions
        WHERE store = 'google' AND (original_transaction_id = $1 OR purchase_token = $1) LIMIT 1`,
      [String(purchaseToken)]);
    return Boolean(rows && rows.length);
  } catch { return false; }
}

async function googleRtdn(req, res) {
  let transient = false;
  try {
    // 1. AUTHENTICITY. Pub/Sub signs every push with an OIDC token; before this the endpoint took
    //    an unauthenticated POST from anywhere and believed it.
    const auth = await playApi.verifyPubSubPush(req);

    const msg = req.body && req.body.message;
    let dn = null;
    if (msg && msg.data) { try { dn = JSON.parse(Buffer.from(msg.data, 'base64').toString('utf8')); } catch {} }
    if (!dn) return res.status(200).end();
    if (dn.packageName && dn.packageName !== storeProducts.PLAY_PACKAGE) return res.status(200).end();

    const c = googleClassify(dn);
    const voided = Boolean(dn.voidedPurchaseNotification);
    // voidedPurchase productType: 1 = subscription, 2 = one-time. Only subscriptions belong here;
    // a voided credit pack is a different (consumable) refund path and must not clear a plan.
    const voidedIsSub = voided && Number(dn.voidedPurchaseNotification.productType || 1) === 1;

    // 2. ENTITLEMENT — re-read from Google, never from this body.
    let userId = null;
    const token = c.token;
    const isSubEvent = Boolean(dn.subscriptionNotification) || voidedIsSub;
    const mayAct = auth.verified || await knownPlayToken(token);
    if (isSubEvent && token && mayAct && playApi.isConfigured()) {
      try {
        const r = await storeSubs.applyGoogleSubscription({ purchaseToken: token, voided: voidedIsSub });
        if (r.ok) {
          userId = r.userId;
          storeSubs.notifyIfNew(r);
          console.log(`[play-webhook] ${c.type} → user ${userId} ${r.planKey} ${r.status} until ${r.periodEnd}`);
        } else if (r.retryable) {
          transient = true;
        } else {
          console.warn(`[play-webhook] not applied: ${r.reason}`);
        }
      } catch (e) {
        transient = true;
        console.error('[play-webhook] apply failed:', e.message);
      }
    } else if (isSubEvent && token && mayAct && !playApi.isConfigured()) {
      transient = true;   // same as Apple: a real event we cannot yet resolve must be redelivered
      console.error('[play-webhook] Play Developer API not configured — asking Pub/Sub to redeliver');
    } else if (isSubEvent && !auth.verified) {
      console.warn(`[play-webhook] refused UNVERIFIED push (${auth.reason}) for an unknown token`);
    }

    await live.recordStoreNotification({
      store: 'google',
      notificationType: (auth.verified ? '' : 'UNVERIFIED:') + c.type,
      subtype: null,
      event: c.event,
      transactionId: token,
      productId: c.product,
      userId,
      environment: dn.packageName && /sandbox|test/i.test(dn.packageName) ? 'Sandbox' : 'Production',
      dedupeKey: (msg && msg.messageId) ? 'g_' + msg.messageId : null,
      payload: dn,
    });
  } catch (e) {
    console.error('[play-webhook]', e.message);
  }
  // Pub/Sub redelivers on any non-2xx; reserve that for our own transient failures.
  return res.status(transient ? 500 : 200).end();
}

module.exports = { track, appleNotifications, googleRtdn, appleClassify, googleClassify };
