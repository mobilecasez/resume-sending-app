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
const downloads = require('../services/downloads');
const store = require('../services/storeSubscriptions');
const apple = require('../services/appleStoreApi');
const play = require('../services/playStoreApi');
const { PRODUCTION, SANDBOX } = require('../services/storeEnvironment');

const uidOf = (req) => parseInt((req.user && (req.user.id || req.user.userId)), 10);

// Reasons where the STORE gave a definitive "no". Anything else means we failed to ask.
//
// ⚠️ 'unknown_environment' is deliberately NOT in here. It means the store answered but we could not
// tell Sandbox from Production, and an entitlement we cannot scope is one we refuse to write (see
// entitlements.storeSetSubscription). That is OUR failure, not the store's, so it must be a 503:
// retryable, transaction left unfinished, nothing granted on a guess.
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
  // ⚠️ Compute the entitlement snapshot in the environment the STORE just confirmed, not the one the
  // app claimed on the way in. On the very first TestFlight purchase the app still believes it is in
  // Production (that is the safe default it ships with), so without this line the response would
  // report "no plan" for the purchase it just successfully verified — and the tester would buy
  // again. Server-set, never read from the request body: see storeEnvironment.requestEnvironment.
  req.storeEnv = result.environment || null;
  const status = await ents.getStatus(uidOf(req), req).catch(() => null);
  return res.json({
    success: true, planKey: result.planKey, productId: result.productId,
    periodEnd: result.periodEnd, store: result.store,
    // The app persists this and sends it back as x-store-env from now on. It is the ONLY way an
    // app instance ever adopts Sandbox, which is what keeps a real customer in Production forever.
    environment: result.environment,
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
  // The environment of whatever we actually restored, for the same reason as verify: the snapshot
  // below and the value the app persists must describe the purchases the store just confirmed.
  // Sandbox only wins if nothing production-grade was restored — a device holding both must land in
  // Production, because that is the one where the user's money is.
  let restoredEnv = null;
  const noteEnv = (r) => {
    if (!r || !r.ok || !r.environment) return;
    if (restoredEnv !== ents.PRODUCTION) restoredEnv = r.environment;
  };
  for (const id of appleIds) {
    try {
      const r = await store.applyAppleSubscription({ userId, originalTransactionId: '', transactionId: String(id) });
      if (r.ok) { store.notifyIfNew(r); noteEnv(r); }
      results.push({ store: 'apple', id: String(id).slice(0, 40), ok: !!r.ok, planKey: r.planKey || null, reason: r.reason || null });
    } catch (e) { results.push({ store: 'apple', ok: false, reason: 'lookup_failed' }); }
  }
  for (const t of googleTokens) {
    try {
      const r = await store.applyGoogleSubscription({ userId, purchaseToken: String(t) });
      if (r.ok) { store.notifyIfNew(r); noteEnv(r); }
      results.push({ store: 'google', ok: !!r.ok, planKey: r.planKey || null, reason: r.reason || null });
    } catch (e) { results.push({ store: 'google', ok: false, reason: 'lookup_failed' }); }
  }
  if (restoredEnv) req.storeEnv = restoredEnv;
  const status = await ents.getStatus(userId, req).catch(() => null);
  return res.json({
    success: true, restored: results.filter((r) => r.ok).length, results,
    environment: restoredEnv, ...(status ? { entitlement: status } : {}),
  });
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


// ── POST /api/payment/verify-google-product ─────────────────────────────────────────────────────
// Google's half of the single-download pass. There was no one-time-purchase endpoint on this
// server at all: playStoreApi.getProductPurchase existed with zero callers, and /verify-google
// only ever reads subscriptionsv2. Without this, the pass would be an iOS-only feature.
//
// The client sends a POINTER (purchaseToken), never a claim — the truth is re-read from Google,
// exactly as the subscription path does.
//
// ⚠️ DO NOT consume or acknowledge here. On Android `finishTransaction({isConsumable:true})` in the
// APP is both the acknowledgement and the consume, and it must run only after this endpoint has
// answered yes — Google auto-refunds and revokes anything left unacknowledged for three days.
async function verifyGoogleProduct(req, res) {
  const userId = req.user.id;
  const { productId, purchaseToken } = req.body || {};
  if (!productId || !purchaseToken) {
    return res.status(400).json({ error: 'productId and purchaseToken are required.' });
  }
  if (productId !== downloads.PASS_PRODUCT_ID) {
    return res.status(400).json({ error: 'Unknown product ID', reason: 'unknown_product' });
  }
  let purchase;
  try {
    purchase = await play.getProductPurchase(productId, purchaseToken);
  } catch (e) {
    console.error('[verifyGoogleProduct] play lookup failed:', e.message);
    // Retryable: the purchase may well be valid and we simply could not read it. Never finish a
    // transaction off the back of this, or the user pays and Google revokes it three days later.
    return res.status(503).json({
      error: 'Purchase verification is temporarily unavailable. Your purchase is safe and will be applied automatically.',
      retryable: true,
    });
  }
  if (!purchase) return res.status(404).json({ error: 'Purchase not found.', reason: 'not_found' });

  // purchaseState: 0 = purchased, 1 = cancelled, 2 = pending. Only 0 is money that has moved.
  if (Number(purchase.purchaseState) !== 0) {
    return res.status(409).json({ error: 'Purchase is not complete.', reason: 'not_purchased', state: purchase.purchaseState });
  }
  // A test purchase is free; scoping it to sandbox keeps it out of production downloads.
  const environment = purchase.purchaseType === 0 ? SANDBOX : PRODUCTION;
  const storeTxnId = String(purchase.orderId || purchaseToken);

  // ⚠️ A WRITE FAILURE MUST NOT BE REPORTED AS SUCCESS. On success:true the client calls
  // finishOneTime, which CONSUMES and acknowledges the Play purchase — Google then keeps the money
  // (no three-day auto-refund, because it was acknowledged) for a pass that was never written.
  // 503 + retryable leaves the purchase unconsumed, so recoverStrandedPasses can honour it later.
  let created;
  try {
    created = await downloads.grantPass(userId, { store: 'google', environment, storeTxnId, productId });
  } catch (e) {
    console.error('[verifyGoogleProduct] pass write FAILED (nothing granted):', e.message);
    return res.status(503).json({
      error: 'We could not finish applying your purchase. Nothing is lost — it will be applied automatically.',
      retryable: true,
    });
  }
  if (!created) {
    const owner = await downloads.passOwnerOf({ store: 'google', environment, storeTxnId });
    if (owner && owner !== userId) {
      console.error(`🤖 download pass order=${storeTxnId} belongs to user ${owner}, replayed by user ${userId} — nothing granted`);
    }
  }
  console.log(`🤖 download pass ${created ? 'granted' : 'already recorded'} — user=${userId} order=${storeTxnId} env=${environment}`);
  return res.json({ success: true, kind: 'download_pass', granted: created, environment });
}

module.exports = { verifyAppleSub, verifyGoogleSub, verifyGoogleProduct, restorePurchases, accountToken };
