// The one code path that turns a store purchase into a user_subscriptions row.
//
// THE RULE THAT MAKES THIS SAFE: nothing here trusts its input. A client sends a transaction id or
// a purchase token; a webhook sends a notification body. Both are treated purely as a POINTER. The
// entitlement is always computed from a fresh, TLS-authenticated read of the store's own API
// (getAllSubscriptionStatuses / purchases.subscriptionsv2.get). A forged webhook can therefore do
// nothing worse than make us ask Apple or Google a question — and their answer is the truth.
//
// IDEMPOTENT BY CONSTRUCTION: the write is an upsert onto (store, original_transaction_id) whose
// values are recomputed from that authoritative read. Replaying the same notification a hundred
// times converges on the same row. There is no "have I seen this notification id" bookkeeping to
// get wrong, and no path that adds anything.
//
// FAILS CLOSED: unknown product, unmapped user, unconfigured credentials, store says "not found",
// bundle/package mismatch → no row is written and the caller is told why.
//
// LEGACY CREDITS ARE NOT TOUCHED. user_credits is never read or written in this file. A user with a
// plan spends plan quota first and falls back to their old credit balance when the plan runs out —
// entitlements.canConsumeMany() already does that, unchanged.
'use strict';

const crypto = require('crypto');
const dbConfig = require('../../db-config');
const ents = require('./entitlements');
const products = require('./storeProducts');
const apple = require('./appleStoreApi');
const play = require('./playStoreApi');
const { PRODUCTION, SANDBOX, normalizeEnvironment, isProduction } = require('./storeEnvironment');

const ms = (v) => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(n) && n > 0) return new Date(n);          // Apple: epoch milliseconds
  const d = new Date(v);                                         // Play: RFC-3339 string
  return isNaN(d.getTime()) ? null : d;
};

/** One calendar month before `d`. Every plan we sell is ONE_MONTH on both stores. */
const monthBefore = (d) => {
  const x = new Date(d.getTime());
  x.setUTCMonth(x.getUTCMonth() - 1);
  return x;
};

// ── who is this purchase for? ─────────────────────────────────────────────────────────────────
// Apple's appAccountToken must be a UUID; Play's obfuscatedExternalAccountId is a free string. One
// token serves both. Until the app started sending this, every store_notifications row had
// user_id NULL and no renewal could be attributed to anybody.
async function accountTokenFor(userId) {
  const uid = parseInt(userId, 10);
  if (!Number.isFinite(uid) || uid <= 0) return null;
  const existing = await dbConfig.query('SELECT account_token FROM user_store_tokens WHERE user_id = $1', [uid]);
  if (existing && existing[0]) return existing[0].account_token;
  const token = crypto.randomUUID();
  await dbConfig.query(
    `INSERT INTO user_store_tokens (user_id, account_token) VALUES ($1,$2)
     ON CONFLICT (user_id) DO NOTHING`, [uid, token]);
  const again = await dbConfig.query('SELECT account_token FROM user_store_tokens WHERE user_id = $1', [uid]);
  return (again && again[0]) ? again[0].account_token : null;
}

async function userIdForAccountToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const rows = await dbConfig.query('SELECT user_id FROM user_store_tokens WHERE account_token = $1', [t]);
  return rows && rows[0] ? Number(rows[0].user_id) : null;
}

/**
 * Fall back to the user already welded to this store identity (renewals of a known purchase).
 *
 * Environment-scoped when the caller knows it. Sandbox and Production transaction-id / purchase-token
 * namespaces are independent and can collide, so without the scope a sandbox renewal could be
 * attributed to whichever real customer happens to hold the same id — writing a Sandbox row against
 * their account. Harmless to their production entitlement (it cannot see Sandbox rows) but wrong,
 * and it would put a stranger's test purchase in their history. `environment` is optional so the
 * unscoped legacy behaviour is still available where the environment genuinely is not known yet.
 */
async function userIdForStoreTxn(store, originalTxnId, purchaseToken, environment = null) {
  const env = normalizeEnvironment(environment);
  const rows = await dbConfig.query(
    `SELECT user_id FROM user_subscriptions
      WHERE store = $1 AND (original_transaction_id = $2 OR ($3 <> '' AND purchase_token = $3))
        AND ($4::text IS NULL OR environment = $4)
      ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [store, String(originalTxnId || ''), String(purchaseToken || ''), env]);
  return rows && rows[0] ? Number(rows[0].user_id) : null;
}

// ── Apple ─────────────────────────────────────────────────────────────────────────────────────
// status: 1 active · 2 expired · 3 billing retry · 4 billing grace · 5 revoked.
// 'billing_retry' is deliberately NOT 'active': with no grace period configured, Apple has already
// stopped the customer's access, and keeping ours open gives away a month per failed renewal.
const APPLE_STATUS = { 1: 'active', 2: 'expired', 3: 'billing_retry', 4: 'active', 5: 'revoked' };

/**
 * Re-read one Apple subscription from Apple and write the entitlement.
 * @param {object} a
 * @param {number} [a.userId]  the buyer, when we know it (verify endpoint). Webhooks omit it and we
 *                             resolve from appAccountToken / an existing row; unresolved → no write.
 * @param {string} a.originalTransactionId
 * @returns {Promise<object>} { ok, planKey, periodEnd, ... } or { ok:false, reason }
 */
async function applyAppleSubscription({ userId = null, originalTransactionId, transactionId = null }) {
  if (!apple.isConfigured()) return { ok: false, reason: 'apple_api_not_configured', retryable: true };

  let origTxn = String(originalTransactionId || '').trim();
  if (!origTxn && transactionId) {
    const tx = await apple.getTransactionInfo(transactionId);
    if (!tx) return { ok: false, reason: 'transaction_unknown_to_apple' };
    origTxn = String(tx.originalTransactionId || tx.transactionId || '');
  }
  if (!origTxn) return { ok: false, reason: 'missing_original_transaction_id' };

  const res = await apple.getAllSubscriptionStatuses(origTxn);
  if (!res) return { ok: false, reason: 'transaction_unknown_to_apple' };
  if (res.bundleId && res.bundleId !== products.BUNDLE_ID) {
    return { ok: false, reason: 'bundle_mismatch' };            // another app's purchase
  }

  // Pick the entry for a product we actually sell. Apple returns the whole customer, groups and all.
  const candidates = res.items
    .map((it) => ({ it, sub: products.subscriptionForProduct(it.transaction && it.transaction.productId) }))
    .filter((c) => c.sub);
  if (!candidates.length) return { ok: false, reason: 'no_known_subscription_product' };
  // Prefer the entry matching the id we were asked about, then the one that is actually live.
  candidates.sort((a, b) => {
    const am = a.it.originalTransactionId === origTxn ? 0 : 1;
    const bm = b.it.originalTransactionId === origTxn ? 0 : 1;
    if (am !== bm) return am - bm;
    return (a.it.status === 1 ? 0 : 1) - (b.it.status === 1 ? 0 : 1);
  });
  const { it, sub } = candidates[0];
  const tx = it.transaction;
  const rn = it.renewal || {};

  // Which App Store did this actually come from? Apple tells us three times over — in the signed
  // transaction payload, in the /subscriptions response body, and by which host answered — and
  // appleStoreApi normalises all three to 'Production' | 'Sandbox' | null. TestFlight is ALWAYS
  // Sandbox, so this value is what stops a $0 tester purchase from becoming a production plan.
  // No fallback to Production: an environment we cannot name is refused (see storeSetSubscription).
  const environment = normalizeEnvironment(tx.environment) || normalizeEnvironment(res.environment);
  if (!environment) return { ok: false, reason: 'unknown_environment', retryable: true };

  // Ownership: a FAMILY_SHARED entitlement is real, but it is not a purchase this account made.
  // Honour it (Apple requires it) and record it so support can tell the two apart.
  const ownership = tx.inAppOwnershipType || 'PURCHASED';

  let status = APPLE_STATUS[it.status] || 'expired';
  let terminal = false;
  let periodEnd = ms(tx.expiresDate);
  if (it.status === 4 && rn.gracePeriodExpiresDate) {
    const g = ms(rn.gracePeriodExpiresDate);
    if (g && (!periodEnd || g > periodEnd)) periodEnd = g;      // grace extends real access
  }
  if (tx.revocationDate) {                                       // refund / family removal / chargeback
    status = tx.revocationReason != null ? 'refunded' : 'revoked';
    terminal = true;
    periodEnd = ms(tx.revocationDate) || new Date();
  } else if (it.status === 5) {
    status = 'revoked'; terminal = true; periodEnd = new Date();
  }
  if (!periodEnd) return { ok: false, reason: 'no_expiry_from_apple' };

  const uid = userId
    || await userIdForAccountToken(tx.appAccountToken)
    || await userIdForStoreTxn('apple', it.originalTransactionId || origTxn, null, environment);
  // RETRYABLE on purpose. A first purchase races: Apple's SUBSCRIBED notification often lands before
  // the app's own verify call, and until that call creates the row there is nothing to attribute to
  // except appAccountToken. Answering 500 makes Apple redeliver (5 times over 3 days), by which
  // point the row exists and userIdForStoreTxn resolves it. Answering 200 throws the purchase away.
  if (!uid) return { ok: false, reason: 'unattributed', retryable: true, productId: tx.productId, originalTransactionId: it.originalTransactionId };

  const w = await ents.storeSetSubscription({
    userId: uid,
    planKey: sub.planKey,
    source: 'apple',
    productId: tx.productId,
    originalTxnId: String(it.originalTransactionId || origTxn),
    latestTxnId: tx.transactionId ? String(tx.transactionId) : null,
    periodStart: ms(tx.purchaseDate),
    periodEnd,
    status,
    terminal,
    environment,
    autoRenew: rn.autoRenewStatus != null ? Number(rn.autoRenewStatus) === 1 : null,
    acknowledged: true,                                          // Apple has no acknowledge step
    storeState: `${it.status}:${ownership}`,
    // What this subscription will RENEW into. Apple settles a plan change inside the group itself:
    // an upgrade takes effect at once (so this equals the live product and there is nothing
    // pending), a DOWNGRADE is deferred and this is the only place Apple states it. Without it the
    // paywall can only show the product still running and a user who has just switched tier sees no
    // evidence of it. A product we do not sell resolves to null rather than being invented.
    pendingPlanKey: (() => {
      const next = rn.autoRenewProductId;
      if (!next || next === tx.productId) return null;
      const s = products.subscriptionForProduct(next);
      return s ? s.planKey : null;
    })(),
  });
  if (w.error) return { ok: false, reason: w.error };
  return {
    ok: true, store: 'apple', userId: Number(w.row.user_id), planKey: sub.planKey,
    productId: tx.productId, status, periodEnd, created: w.created,
    transferBlocked: w.transferBlocked, ownership,
    environment,
  };
}

// ── Google Play ───────────────────────────────────────────────────────────────────────────────
// Access-granting states. CANCELED means auto-renew is off, NOT that access stopped — the customer
// paid for the current cycle and keeps it until expiryTime. Treating CANCELED as "cut them off"
// takes money for a month the user cannot use.
const PLAY_ACTIVE = new Set([
  'SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED',
]);
const PLAY_STATUS = {
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'active',
  SUBSCRIPTION_STATE_CANCELED: 'active',
  SUBSCRIPTION_STATE_ON_HOLD: 'on_hold',
  SUBSCRIPTION_STATE_PAUSED: 'paused',
  SUBSCRIPTION_STATE_EXPIRED: 'expired',
  SUBSCRIPTION_STATE_PENDING: 'pending',
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'expired',
};

/**
 * Re-read one Play subscription from Google and write the entitlement, then acknowledge.
 * @param {object} a
 * @param {number} [a.userId]
 * @param {string} a.purchaseToken
 * @param {boolean} [a.voided] set by the voidedPurchase RTDN — Google has already refunded.
 */
async function applyGoogleSubscription({ userId = null, purchaseToken, voided = false }) {
  if (!play.isConfigured()) return { ok: false, reason: 'play_api_not_configured', retryable: true };
  const token = String(purchaseToken || '').trim();
  if (!token) return { ok: false, reason: 'missing_purchase_token' };

  const p = await play.getSubscriptionV2(token);
  if (!p) return { ok: false, reason: 'token_unknown_to_google' };

  const line = (p.lineItems || [])
    .map((l) => ({ l, sub: products.subscriptionForProduct(l.productId) }))
    .filter((x) => x.sub)[0];
  if (!line) return { ok: false, reason: 'no_known_subscription_product' };

  const state = p.subscriptionState || '';
  let status = PLAY_STATUS[state] || 'expired';
  let terminal = false;
  const expiry = ms(line.l.expiryTime);
  let periodEnd = expiry;
  // A voided purchase is a refund or chargeback: access ends now regardless of expiryTime.
  if (voided) { status = 'refunded'; terminal = true; periodEnd = new Date(); }
  if (!periodEnd) return { ok: false, reason: 'no_expiry_from_google' };
  if (!voided && !PLAY_ACTIVE.has(state) && status === 'active') status = 'expired';

  // ⚠️ NOT p.startTime. Google's subscriptionsv2 `startTime` is when the subscription was FIRST
  // granted and it does not move on renewal, so handing it over as period_start would open a quota
  // window months wide — every cover letter the user has ever generated would count against this
  // month's allowance. The current cycle began one calendar month before the store's own expiry
  // (all five plans are ONE_MONTH on both stores); clamped so it can never predate the purchase.
  const started = ms(p.startTime);
  let cycleStart = expiry ? monthBefore(expiry) : started;
  if (started && (!cycleStart || cycleStart < started)) cycleStart = started;

  // Play's equivalent of Apple's Sandbox: `testPurchase` is set on any purchase made by a licence
  // tester or from an internal-test track — $0, and it must not buy a production plan. Google
  // answers this on every subscriptionsv2 read, so unlike Apple there is no "unknown" case.
  // Computed BEFORE attribution because the token lookups below are scoped by it.
  const environment = p.testPurchase ? SANDBOX : PRODUCTION;

  const ext = p.externalAccountIdentifiers || {};
  const uid = userId
    || await userIdForAccountToken(ext.obfuscatedExternalAccountId)
    || await userIdForStoreTxn('google', token, token, environment)
    || (p.linkedPurchaseToken ? await userIdForStoreTxn('google', p.linkedPurchaseToken, p.linkedPurchaseToken, environment) : null);
  // Retryable for the same reason as Apple: Pub/Sub redelivers, and by the next attempt the app's
  // own verify call has usually created the row we can attribute to.
  if (!uid) return { ok: false, reason: 'unattributed', retryable: true, productId: line.l.productId };

  const acked = String(p.acknowledgementState || '') === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  const w = await ents.storeSetSubscription({
    userId: uid,
    planKey: line.sub.planKey,
    source: 'google',
    productId: line.l.productId,
    // Play has no "original transaction id". The purchase token is the stable handle for a
    // subscription across renewals; upgrades/resubscribes mint a new token and point at the old one
    // through linkedPurchaseToken, which we retire below.
    originalTxnId: token,
    purchaseToken: token,
    latestTxnId: p.latestOrderId || null,
    periodStart: cycleStart,
    periodEnd,
    status,
    terminal,
    environment,
    autoRenew: line.l.autoRenewingPlan ? Boolean(line.l.autoRenewingPlan.autoRenewEnabled) : null,
    acknowledged: acked,
    storeState: state,
  });
  if (w.error) return { ok: false, reason: w.error };

  // Retire the token this purchase replaced, so an upgrade cannot leave two live rows.
  // Environment-scoped for the same reason the supersede in storeSetSubscription is: a test-track
  // purchase must never be able to retire a real customer's row, and purchase tokens are not
  // guaranteed to be distinct across the two.
  if (p.linkedPurchaseToken) {
    await dbConfig.query(
      `UPDATE user_subscriptions SET status = 'superseded', updated_at = NOW()
        WHERE store = 'google' AND original_transaction_id = $1 AND environment = $2
          AND status = 'active'`,
      [String(p.linkedPurchaseToken), environment]).catch(() => {});
  }

  // ⚠️ ONLY NOW. Google auto-refunds and revokes anything unacknowledged after 3 days, so
  // acknowledging before the entitlement exists is how a crash turns into "charged, nothing given".
  let acknowledged = acked;
  if (!acked && !terminal && status === 'active') {
    const r = await play.acknowledgeSubscription(line.l.productId, token);
    acknowledged = Boolean(r.acknowledged);
    if (acknowledged) {
      await dbConfig.query(
        `UPDATE user_subscriptions SET acknowledged = TRUE, updated_at = NOW() WHERE id = $1`,
        [w.row.id]).catch(() => {});
    }
  }

  return {
    ok: true, store: 'google', userId: Number(w.row.user_id), planKey: line.sub.planKey,
    productId: line.l.productId, status, periodEnd, created: w.created,
    transferBlocked: w.transferBlocked, acknowledged,
    environment,
  };
}

/**
 * Fire the admin "new purchase" alert exactly once per subscription row. Never throws.
 *
 * A Sandbox purchase is a TEST, not revenue. It is still worth announcing (it is the founder's
 * confirmation that a TestFlight purchase went all the way through) but it must be unmistakable and
 * it must not carry a price — an alert saying "Max — $49.99" for a $0 sandbox transaction is how a
 * test gets counted as a sale in the only revenue signal that arrives in real time.
 */
function notifyIfNew(result) {
  if (!result || !result.ok || !result.created || result.status !== 'active') return;
  try {
    const plan = ents.planByKey(result.planKey);
    const real = isProduction(result.environment);
    const storeName = result.store === 'apple' ? 'Apple subscription' : 'Play subscription';
    require('./adminNotifier').notifyNewPurchase(result.userId, {
      plan: plan ? plan.label : result.planKey,
      amount: real ? (plan ? plan.priceUsd : null) : 0,
      currency: 'USD',
      source: real ? storeName : `${storeName} — SANDBOX TEST (no money)`,
    }).catch(() => {});
  } catch (_) {}
}

module.exports = {
  accountTokenFor, userIdForAccountToken, userIdForStoreTxn,
  applyAppleSubscription, applyGoogleSubscription, notifyIfNew,
};
