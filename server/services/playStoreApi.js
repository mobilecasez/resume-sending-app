// Google Play Developer API client — the authoritative source for anything a Play purchase claims.
// Same contract as appleStoreApi.js: nothing the client or a webhook body says is believed; we take
// only the purchaseToken (an opaque handle, useless without our service-account credentials) and ask
// Google what it is worth.
//
// FAILS CLOSED: no key file, no googleapis, network error, non-200 → throws. Callers grant nothing.
//
// ⚠️ ACKNOWLEDGEMENT IS A DEADLINE, NOT A NICETY. Play auto-refunds and revokes any purchase not
// acknowledged within 3 days. acknowledgeSubscription() is therefore called ONLY after the
// entitlement row is written — never before, or a crash in between takes the money and gives
// nothing while Google considers the purchase delivered.
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { PLAY_PACKAGE } = require('./storeProducts');

const ROOT = path.resolve(__dirname, '..', '..');
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

// Key resolution: inline JSON (Railway env) wins, then an explicit path, then the repo key file.
const KEY_JSON = process.env.GOOGLE_PLAY_SA_JSON || '';
const KEY_FILE = process.env.GOOGLE_PLAY_SA_KEYFILE || path.join(ROOT, 'Keys', 'cvapplyr-e46cebab373e.json');

let clientPromise = null;
function isConfigured() {
  try {
    require.resolve('googleapis');
  } catch { return false; }
  return Boolean(KEY_JSON || (KEY_FILE && fs.existsSync(KEY_FILE)));
}

function androidPublisher() {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    if (!isConfigured()) throw new Error('play_api_not_configured');
    const { google } = require('googleapis');
    const opts = { scopes: [SCOPE] };
    if (KEY_JSON) opts.credentials = JSON.parse(KEY_JSON);
    else opts.keyFile = KEY_FILE;
    const auth = new google.auth.GoogleAuth(opts);
    return google.androidpublisher({ version: 'v3', auth: await auth.getClient() });
  })().catch((e) => { clientPromise = null; throw e; });
  return clientPromise;
}

/**
 * purchases.subscriptionsv2.get — the full state of one subscription purchase.
 * Returns null when Google says the token is unknown (410/404): that is a definitive "worthless",
 * so the caller may safely deny. Any other failure throws (we could not ask → do not deny forever).
 */
async function getSubscriptionV2(purchaseToken) {
  const token = String(purchaseToken || '').trim();
  if (!token) return null;
  const ap = await androidPublisher();
  try {
    const r = await ap.purchases.subscriptionsv2.get({ packageName: PLAY_PACKAGE, token });
    return r && r.data ? r.data : null;
  } catch (e) {
    const code = e && (e.code || (e.response && e.response.status));
    if (code === 404 || code === 410) return null;      // unknown / long-expired token
    throw new Error(`play_subscriptionsv2_${code || 'error'}: ${e.message}`);
  }
}

/** purchases.products.get — one-time (consumable) purchase state, for the credit packs. */
async function getProductPurchase(productId, purchaseToken) {
  const token = String(purchaseToken || '').trim();
  const sku = String(productId || '').trim();
  if (!token || !sku) return null;
  const ap = await androidPublisher();
  try {
    const r = await ap.purchases.products.get({ packageName: PLAY_PACKAGE, productId: sku, token });
    return r && r.data ? r.data : null;
  } catch (e) {
    const code = e && (e.code || (e.response && e.response.status));
    if (code === 404 || code === 410) return null;
    throw new Error(`play_products_${code || 'error'}: ${e.message}`);
  }
}

/** Acknowledge a subscription purchase. Idempotent on Google's side; already-acked returns an error we swallow. */
async function acknowledgeSubscription(productId, purchaseToken) {
  const ap = await androidPublisher();
  try {
    await ap.purchases.subscriptions.acknowledge({
      packageName: PLAY_PACKAGE, subscriptionId: String(productId), token: String(purchaseToken),
      requestBody: { developerPayload: '' },
    });
    return { acknowledged: true };
  } catch (e) {
    const msg = String(e && e.message || '');
    if (/already been acknowledged/i.test(msg)) return { acknowledged: true, alreadyAcked: true };
    console.warn('[play] acknowledge failed:', msg);
    return { acknowledged: false, error: msg };
  }
}

// ── RTDN authenticity: verify the Pub/Sub push OIDC token ─────────────────────────────────────
// Google signs a JWT into the Authorization header of every push delivery. Without this check the
// webhook is an unauthenticated POST that anybody on the internet can send. Verification here is a
// gate only — the entitlement write always re-fetches from the Play API — but an unverified caller
// should not even be able to make us spend a Google API quota unit.
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let jwks = { keys: [], fetchedAt: 0 };

async function googleKeys() {
  if (Date.now() - jwks.fetchedAt < 60 * 60 * 1000 && jwks.keys.length) return jwks.keys;
  const r = await fetch(CERTS_URL);
  if (!r.ok) throw new Error(`google_certs_${r.status}`);
  const body = await r.json();
  jwks = { keys: body.keys || [], fetchedAt: Date.now() };
  return jwks.keys;
}

/**
 * Verify the Pub/Sub push request. Returns { verified:true, claims } or { verified:false, reason }.
 * Configure PUBSUB_PUSH_AUDIENCE (the push endpoint URL you registered) and/or
 * PUBSUB_PUSH_SA_EMAIL (the service account you set as the push identity) to make this meaningful;
 * with neither set we still prove Google signed the token, which already excludes any third party.
 */
async function verifyPubSubPush(req) {
  try {
    const h = String((req.headers && req.headers.authorization) || '');
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!token) return { verified: false, reason: 'missing_bearer' };

    const parts = token.split('.');
    if (parts.length !== 3) return { verified: false, reason: 'malformed' };
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
    if (!jwk) return { verified: false, reason: 'unknown_kid' };

    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const opts = { algorithms: [header.alg || 'RS256'], issuer: ['https://accounts.google.com', 'accounts.google.com'] };
    if (process.env.PUBSUB_PUSH_AUDIENCE) opts.audience = process.env.PUBSUB_PUSH_AUDIENCE;
    const claims = jwt.verify(token, key, opts);

    const want = process.env.PUBSUB_PUSH_SA_EMAIL;
    if (want && String(claims.email || '').toLowerCase() !== want.toLowerCase()) {
      return { verified: false, reason: 'wrong_service_account' };
    }
    if (want && claims.email_verified === false) return { verified: false, reason: 'email_unverified' };
    return { verified: true, claims };
  } catch (e) {
    return { verified: false, reason: e.message };
  }
}

module.exports = {
  isConfigured, getSubscriptionV2, getProductPurchase, acknowledgeSubscription, verifyPubSubPush,
};
