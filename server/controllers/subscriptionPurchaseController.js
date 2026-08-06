// Store subscription verification endpoints. The client hands over a POINTER to a purchase
// (Apple transactionId / Play purchaseToken) and this asks the store what it is worth. Nothing in
// the request body other than that pointer influences the outcome — no productId, no price, no
// plan key. That is the whole difference from the old /payment/verify-apple consumable path.
//
// HTTP contract the app depends on (App.js keeps the transaction unfinished until we say 200):
//   200 → entitlement written. Safe to finishTransaction / consume the pending record.
//   400 → the STORE says this purchase is not real or not ours. Permanent; stop retrying.
//   409 → real purchase, already welded to a different account. Permanent for this account.
//   503 → WE could not ask (key missing, Apple/Google unreachable). NOT the user's fault: keep the
//         transaction unfinished and retry on next launch. Never finish a transaction on a 503.
'use strict';

const ents = require('../services/entitlements');
const store = require('../services/storeSubscriptions');
const apple = require('../services/appleStoreApi');
const play = require('../services/playStoreApi');

const uidOf = (req) => parseInt((req.user && (req.user.id || req.user.userId)), 10);

// Reasons where the STORE gave a definitive "no". Anything else means we failed to ask.
const DENIED = new Set([
  'transaction_unknown_to_apple', 'token_unknown_to_google', 'no_known_subscription_product',
  'bundle_mismatch', 'missing_original_transaction_id', 'missing_purchase_token',
  'no_expiry_from_apple', 'no_expiry_from_google', 'unknown_plan', 'invalid_source',
]);

function statusFor(result) {
  if (result.ok) return 200;
  if (result.transferBlocked) return 409;
  return DENIED.has(result.reason) ? 400 : 503;
}

async function respond(req, res, result) {
  if (result.ok && result.transferBlocked) {
    return res.status(409).json({
      success: false, error: 'already_linked',
      message: 'This subscription is already active on another cvApplyr account. Sign in with that account, or contact support to move it.',
    });
  }
  if (!result.ok) {
    const code = statusFor(result);
    return res.status(code).json({
      success: false, error: result.reason,
      retryable: code === 503,
      message: code === 503
        ? 'We could not reach the store to confirm your purchase. You have not lost anything — we will finish this automatically the next time you open the app.'
        : 'The store could not confirm this purchase.',
    });
  }
  store.notifyIfNew(result);
  const status = await ents.getStatus(uidOf(req), req).catch(() => null);
  return res.json({
    success: true, planKey: result.planKey, productId: result.productId,
    periodEnd: result.periodEnd, store: result.store, environment: result.environment,
    ...(status ? { entitlement: status } : {}),
  });
}

/** POST /api/payment/verify-apple-sub  { transactionId | originalTransactionId } */
async function verifyAppleSub(req, res) {
  const userId = uidOf(req);
  const b = req.body || {};
  const transactionId = String(b.transactionId || '').trim();
  const originalTransactionId = String(b.originalTransactionId || '').trim();
  if (!transactionId && !originalTransactionId) {
    return res.status(400).json({ success: false, error: 'missing_transaction_id' });
  }
  if (!apple.isConfigured()) {
    console.error('[verify-apple-sub] App Store Server API is not configured — refusing to grant');
    return res.status(503).json({ success: false, error: 'apple_api_not_configured', retryable: true });
  }
  try {
    const r = await store.applyAppleSubscription({ userId, originalTransactionId, transactionId });
    return respond(req, res, r);
  } catch (e) {
    console.error('[verify-apple-sub]', e.message);
    return res.status(503).json({ success: false, error: 'apple_lookup_failed', retryable: true });
  }
}

/** POST /api/payment/verify-google  { purchaseToken } */
async function verifyGoogleSub(req, res) {
  const userId = uidOf(req);
  const purchaseToken = String((req.body || {}).purchaseToken || '').trim();
  if (!purchaseToken) return res.status(400).json({ success: false, error: 'missing_purchase_token' });
  if (!play.isConfigured()) {
    console.error('[verify-google] Play Developer API is not configured — refusing to grant');
    return res.status(503).json({ success: false, error: 'play_api_not_configured', retryable: true });
  }
  try {
    const r = await store.applyGoogleSubscription({ userId, purchaseToken });
    return respond(req, res, r);
  } catch (e) {
    console.error('[verify-google]', e.message);
    return res.status(503).json({ success: false, error: 'play_lookup_failed', retryable: true });
  }
}

/**
 * POST /api/payment/restore  { appleTransactionIds:[], googlePurchaseTokens:[] }
 * Apple rejects an app whose Restore Purchases is missing or broken (guideline 3.1.1). Each pointer
 * is re-verified independently; one bad entry never fails the whole restore.
 */
async function restorePurchases(req, res) {
  const userId = uidOf(req);
  const b = req.body || {};
  const appleIds = (Array.isArray(b.appleTransactionIds) ? b.appleTransactionIds : []).slice(0, 25);
  const googleTokens = (Array.isArray(b.googlePurchaseTokens) ? b.googlePurchaseTokens : []).slice(0, 25);
  const results = [];
  for (const id of appleIds) {
    try {
      const r = await store.applyAppleSubscription({ userId, originalTransactionId: '', transactionId: String(id) });
      if (r.ok) store.notifyIfNew(r);
      results.push({ store: 'apple', id: String(id).slice(0, 40), ok: !!r.ok, planKey: r.planKey || null, reason: r.reason || null });
    } catch (e) { results.push({ store: 'apple', ok: false, reason: 'lookup_failed' }); }
  }
  for (const t of googleTokens) {
    try {
      const r = await store.applyGoogleSubscription({ userId, purchaseToken: String(t) });
      if (r.ok) store.notifyIfNew(r);
      results.push({ store: 'google', ok: !!r.ok, planKey: r.planKey || null, reason: r.reason || null });
    } catch (e) { results.push({ store: 'google', ok: false, reason: 'lookup_failed' }); }
  }
  const status = await ents.getStatus(userId, req).catch(() => null);
  return res.json({ success: true, restored: results.filter((r) => r.ok).length, results, ...(status ? { entitlement: status } : {}) });
}

/**
 * GET /api/payment/account-token
 * The token the app must attach to every purchase (Apple appAccountToken, Play
 * obfuscatedExternalAccountId). Without it a renewal webhook cannot be traced back to a user —
 * which is exactly why every store_notifications row currently has user_id NULL.
 */
async function accountToken(req, res) {
  try {
    const token = await store.accountTokenFor(uidOf(req));
    if (!token) return res.status(500).json({ success: false, error: 'token_unavailable' });
    return res.json({ success: true, accountToken: token });
  } catch (e) {
    console.error('[account-token]', e.message);
    return res.status(500).json({ success: false, error: 'token_unavailable' });
  }
}

module.exports = { verifyAppleSub, verifyGoogleSub, restorePurchases, accountToken };
