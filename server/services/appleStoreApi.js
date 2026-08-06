// App Store Server API client — the ONLY thing this server is allowed to believe about an Apple
// purchase. Everything here is a GET to api.storekit.itunes.apple.com authenticated with our own
// ES256 key, so the trust anchor is TLS + our private key, not anything the client or a webhook
// caller handed us.
//
// WHY THIS FILE EXISTS (paymentController.js:584 is the bug it replaces): the old no-receipt branch
// took `productId` straight from the request body, and the JWS branch base64-decoded the client's
// token without checking a single signature. Both mint value from a string anyone with a valid JWT
// could type. Nothing in here decodes a caller-supplied blob and acts on it.
//
// FAILS CLOSED, ALWAYS: unconfigured key, network error, 4xx, missing field, environment mismatch
// → throws or returns null. A caller that cannot get an answer from Apple must grant nothing.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { BUNDLE_ID } = require('./storeProducts');

const ROOT = path.resolve(__dirname, '..', '..');

// ── credentials ───────────────────────────────────────────────────────────────────────────────
// ⚠️ The App Store Server API wants an IN-APP PURCHASE key (App Store Connect → Users and Access →
// Integrations → In-App Purchase), which has its OWN key id and its own issuer id — it is NOT
// necessarily the same key as the App Store Connect API key used by tools/asc-provision-*.js.
// Configure explicitly; we fall back to the on-disk ASC keys only so a local dry run can be tried.
const KEY_ID   = process.env.APPLE_IAP_KEY_ID   || process.env.ASC_KEY_ID   || '';
const ISSUER   = process.env.APPLE_IAP_ISSUER_ID || process.env.ASC_ISSUER_ID || '';
const KEY_PATH = process.env.APPLE_IAP_KEY_PATH || (KEY_ID ? path.join(ROOT, 'Keys', `AuthKey_${KEY_ID}.p8`) : '');
const INLINE_KEY = process.env.APPLE_IAP_PRIVATE_KEY || '';   // PEM in an env var (Railway-friendly)

const PROD_BASE    = 'https://api.storekit.itunes.apple.com/inApps/v1';
const SANDBOX_BASE = 'https://api.storekit-sandbox.itunes.apple.com/inApps/v1';

let cachedKey = null;
function privateKey() {
  if (cachedKey) return cachedKey;
  if (INLINE_KEY && INLINE_KEY.includes('BEGIN')) { cachedKey = INLINE_KEY.replace(/\\n/g, '\n'); return cachedKey; }
  if (KEY_PATH && fs.existsSync(KEY_PATH)) { cachedKey = fs.readFileSync(KEY_PATH, 'utf8'); return cachedKey; }
  return null;
}

/** True when this process can talk to Apple at all. Callers MUST check and refuse when false. */
function isConfigured() {
  return Boolean(KEY_ID && ISSUER && privateKey());
}

// Loud on boot, because the failure mode is invisible otherwise: without these three values every
// Apple purchase — consumable AND subscription — answers 503 "we could not confirm this". That is
// the correct fail-closed behaviour, but it means the paywall delivers nothing until it is set, so
// it must be configured BEFORE the 3.6 binary reaches users.
if (!isConfigured()) {
  console.warn('⚠️  App Store Server API NOT configured — set APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID '
    + 'and APPLE_IAP_PRIVATE_KEY (or APPLE_IAP_KEY_PATH). Until then every Apple purchase '
    + 'verification returns 503 and NO credits or plans are granted.');
}

function bearer() {
  const key = privateKey();
  if (!isConfigured()) throw new Error('apple_store_api_not_configured');
  // `bid` is required by the App Store Server API and is what scopes the token to our app.
  return jwt.sign({ iss: ISSUER, aud: 'appstoreconnect-v1', bid: BUNDLE_ID }, key,
    { algorithm: 'ES256', keyid: KEY_ID, expiresIn: '20m' });
}

// ── raw HTTP ──────────────────────────────────────────────────────────────────────────────────
async function apiGet(base, pathname, { timeoutMs = 12000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(base + pathname, {
      headers: { authorization: `Bearer ${bearer()}`, accept: 'application/json' },
      signal: ac.signal,
    });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    return { status: r.status, body, text };
  } finally { clearTimeout(t); }
}

// Apple's own guidance: query Production first; only a "not found" answer means "maybe sandbox".
// Any other failure is NOT retried in sandbox — a sandbox receipt must never satisfy a production
// purchase, and quietly falling through to sandbox is how test purchases become free real plans.
async function apiGetEitherEnv(pathname) {
  const prod = await apiGet(PROD_BASE, pathname);
  if (prod.status === 200) return { ...prod, environment: 'Production' };
  const notFound = prod.status === 404 || (prod.body && Number(prod.body.errorCode) === 4040010);
  if (!notFound) return { ...prod, environment: 'Production' };
  if (process.env.APPLE_ALLOW_SANDBOX === '0') return { ...prod, environment: 'Production' };
  const sb = await apiGet(SANDBOX_BASE, pathname);
  return { ...sb, environment: 'Sandbox' };
}

// ── JWS handling ──────────────────────────────────────────────────────────────────────────────
// Payloads returned by the API arrive over TLS from Apple, so decoding them is safe. Payloads that
// arrive on the webhook do NOT, which is what verifySignedPayload() below is for.
function decodeJwsPayload(jws) {
  try { return JSON.parse(Buffer.from(String(jws).split('.')[1], 'base64url').toString('utf8')); }
  catch { return null; }
}

// Apple Root CA - G3 is the root of every App Store Server JWS chain. Supply the real certificate
// (Keys/AppleRootCA-G3.cer, DER or PEM) or set APPLE_ROOT_CA_G3_PEM; the fingerprint below is the
// published value and is used only when no certificate file is present.
// ⚠️ ASSUMPTION: confirm this fingerprint against https://www.apple.com/certificateauthority/
//    before relying on it. A wrong value can only make verification FAIL (never wrongly pass), and
//    entitlement is re-fetched from Apple over TLS regardless, so the blast radius is a log line.
const APPLE_ROOT_G3_SHA256 = (process.env.APPLE_ROOT_CA_G3_SHA256
  || '63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179').toUpperCase().replace(/[^0-9A-F]/g, '');

let cachedRoot = null;
function trustedRootCert() {
  if (cachedRoot !== null) return cachedRoot;
  cachedRoot = false;
  try {
    const pem = process.env.APPLE_ROOT_CA_G3_PEM;
    if (pem) { cachedRoot = new crypto.X509Certificate(pem.replace(/\\n/g, '\n')); return cachedRoot; }
    const f = process.env.APPLE_ROOT_CA_G3_PATH || path.join(ROOT, 'Keys', 'AppleRootCA-G3.cer');
    if (fs.existsSync(f)) { cachedRoot = new crypto.X509Certificate(fs.readFileSync(f)); return cachedRoot; }
  } catch (e) { console.warn('[apple] root CA load failed:', e.message); }
  return cachedRoot;
}

/**
 * Verify an Apple-signed JWS (webhook signedPayload, signedTransactionInfo, signedRenewalInfo):
 * walk the x5c chain leaf → intermediate → root, check every link actually signed the next, check
 * validity dates, pin the root, then verify the JWS itself with the leaf's public key.
 * Returns the decoded payload on success, or null. NEVER throws — callers treat null as "untrusted".
 */
function verifySignedPayload(jws) {
  try {
    const parts = String(jws || '').split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (header.alg !== 'ES256' || !Array.isArray(header.x5c) || header.x5c.length < 2) return null;

    const chain = header.x5c.map((b64) => new crypto.X509Certificate(
      Buffer.from(`-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`)));

    const now = Date.now();
    for (const c of chain) {
      if (new Date(c.validFrom).getTime() > now || new Date(c.validTo).getTime() < now) return null;
    }
    for (let i = 0; i < chain.length - 1; i++) {
      if (!chain[i].verify(chain[i + 1].publicKey)) return null;   // issued-by check
    }

    const root = chain[chain.length - 1];
    if (!root.verify(root.publicKey)) return null;                  // self-signed root
    const pinned = trustedRootCert();
    if (pinned) {
      if (!root.raw.equals(pinned.raw)) return null;
    } else if (root.fingerprint256.replace(/[^0-9A-Fa-f]/g, '').toUpperCase() !== APPLE_ROOT_G3_SHA256) {
      return null;
    }

    return jwt.verify(jws, chain[0].publicKey, { algorithms: ['ES256'] });
  } catch (e) {
    console.warn('[apple] JWS verification failed:', e.message);
    return null;
  }
}

// ── the two calls that decide money ───────────────────────────────────────────────────────────

/**
 * GET /transactions/{transactionId} — authoritative facts about ONE transaction (consumable or
 * subscription). Returns the decoded transaction payload, or null when Apple does not know it.
 * Throws only when we could not ask (misconfiguration / network), so callers can tell
 * "Apple says no" (deny) apart from "we could not ask" (503, do not deny permanently).
 */
async function getTransactionInfo(transactionId) {
  const id = encodeURIComponent(String(transactionId || '').trim());
  if (!id) return null;
  const r = await apiGetEitherEnv(`/transactions/${id}`);
  if (r.status === 404) return null;
  if (r.status !== 200 || !r.body || !r.body.signedTransactionInfo) {
    throw new Error(`apple_transactions_${r.status}${r.body && r.body.errorCode ? '_' + r.body.errorCode : ''}`);
  }
  const tx = decodeJwsPayload(r.body.signedTransactionInfo);
  if (!tx) throw new Error('apple_transaction_decode_failed');
  tx._environment = tx.environment || r.environment;
  return tx;
}

/**
 * GET /subscriptions/{originalTransactionId} — every subscription status in the app's groups for
 * one customer. Returns a flat, decoded list; the caller picks the row for our group/product.
 * status: 1 active · 2 expired · 3 billing retry · 4 billing grace · 5 revoked.
 */
async function getAllSubscriptionStatuses(originalTransactionId) {
  const id = encodeURIComponent(String(originalTransactionId || '').trim());
  if (!id) return null;
  const r = await apiGetEitherEnv(`/subscriptions/${id}`);
  if (r.status === 404) return null;
  if (r.status !== 200 || !r.body) {
    throw new Error(`apple_subscriptions_${r.status}${r.body && r.body.errorCode ? '_' + r.body.errorCode : ''}`);
  }
  const out = [];
  for (const group of (r.body.data || [])) {
    for (const t of (group.lastTransactions || [])) {
      out.push({
        status: Number(t.status),
        originalTransactionId: t.originalTransactionId,
        groupId: group.subscriptionGroupIdentifier || null,
        transaction: decodeJwsPayload(t.signedTransactionInfo),
        renewal: decodeJwsPayload(t.signedRenewalInfo),
      });
    }
  }
  return {
    environment: r.body.environment || r.environment,
    bundleId: r.body.bundleId || null,
    items: out.filter((x) => x.transaction),
  };
}

module.exports = {
  isConfigured, getTransactionInfo, getAllSubscriptionStatuses,
  verifySignedPayload, decodeJwsPayload,
  PROD_BASE, SANDBOX_BASE,
};
