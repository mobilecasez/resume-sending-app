// PER-ENVIRONMENT ENTITLEMENT — the one place that decides what "Sandbox" and "Production" mean.
//
// THE PROBLEM THIS SOLVES. TestFlight StoreKit is ALWAYS Sandbox. Apple's own guidance is to query
// the Production App Store Server API first and fall back to Sandbox on "not found", which is what
// appleStoreApi.apiGetEitherEnv() does — so a $0 sandbox purchase made by a TestFlight tester
// verifies successfully and, until this module existed, was written as an ordinary entitlement that
// every production quota check honoured. It was repeatable, too: each sandbox purchase gets a fresh
// transactionId, so the (store, original_transaction_id) dedupe never fired.
//
// WHY NOT A BOOLEAN. The obvious patch is APPLE_ALLOW_SANDBOX=0. It does not work: with sandbox
// verification off, EVERY TestFlight purchase fails, so there is no setting where testers can test
// and production is safe at the same time. You would be choosing between "cannot test the money
// path at all" and "the money path mints free plans".
//
// WHAT WE DO INSTEAD. The environment is a first-class property of an entitlement, carried from
// Apple's/Google's answer all the way onto the row, and every entitlement CHECK is scoped to one
// environment:
//
//   • A row earned in Sandbox satisfies only Sandbox checks. A row earned in Production satisfies
//     only Production checks. There is no query anywhere that can see both.
//   • The unique key that makes writes idempotent is (store, environment, original_transaction_id).
//     Sandbox and Production transaction-id namespaces are independent and CAN collide, so the old
//     two-column key could have let a sandbox purchase upsert onto a real customer's row.
//   • Supersede ("one active entitlement per user") is environment-scoped, so a sandbox test can
//     never cancel a real paid subscription.
//
// HOW A REQUEST DECLARES ITS ENVIRONMENT — and why that is safe to let the client say.
// The app sends `x-store-env: Sandbox` (services/storeEnv.ts). Absent or unrecognised → Production,
// which is the fail-closed default: every existing build, the web app, and every server-internal
// caller therefore run in Production and cannot see a sandbox row.
//
// The header is a SELECTOR, not a grant. Claiming an environment gets you nothing you do not
// already hold in it:
//   • Claim "Sandbox" without a sandbox purchase → your production plan stops being visible to you.
//     Self-harm, not escalation.
//   • Claim "Production" with only a sandbox purchase → denied.
// To gain anything by claiming Sandbox you must first OWN a Sandbox entitlement, and one can only
// be created by a transaction that Apple's *sandbox* API recognises (or a Play purchase Google
// flags testPurchase). An App Store build's StoreKit only ever talks to production, so a real
// customer cannot mint one.
//
// The app does not guess its environment either. It learns it from the SERVER's answer to a verify
// or restore call — the response carries the environment Apple/Google reported — and persists that.
// So the sequence for a TestFlight tester is: buy (Sandbox) → verify → server writes a Sandbox row
// and replies environment:"Sandbox" → app persists it and sends the header from then on → the
// tester has a fully working entitlement that no production request can ever see. A real customer
// never receives "Sandbox" from any endpoint, so their app never sends the header at all.
'use strict';

const PRODUCTION = 'Production';
const SANDBOX = 'Sandbox';

/**
 * Canonical form of an environment string from ANY source (Apple JWS payload, Apple API response
 * body, Play testPurchase flag, our own DB, a client header).
 * @returns {'Production'|'Sandbox'|null} null means "unrecognised" — callers must fail closed, not
 *          substitute a default, wherever the value decides money.
 */
function normalizeEnvironment(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'sandbox' || s === 'xcode' || s === 'test' || s === 'local') return SANDBOX;
  if (s === 'production' || s === 'prod' || s === 'live') return PRODUCTION;
  return null;
}

/**
 * The environment THIS request is entitled to see. Production unless the caller explicitly and
 * recognisably says Sandbox.
 *
 * `req.storeEnv` takes precedence over the header: it is set server-side (never from user input)
 * right after a verify call, so the entitlement snapshot returned with that response is computed in
 * the environment the store just confirmed, instead of the one the app knew a moment earlier.
 */
function requestEnvironment(req) {
  if (req && req.storeEnv) return normalizeEnvironment(req.storeEnv) || PRODUCTION;
  const h = req && req.headers ? req.headers['x-store-env'] : null;
  return normalizeEnvironment(h) || PRODUCTION;
}

/** True for the environment where money is real. Anything else is a test purchase. */
const isProduction = (v) => normalizeEnvironment(v) === PRODUCTION;

module.exports = { PRODUCTION, SANDBOX, normalizeEnvironment, requestEnvironment, isProduction };
