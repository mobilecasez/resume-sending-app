#!/usr/bin/env node
/**
 * tools/play/play-audit.js — READ-ONLY audit of the Google Play monetisation state.
 *
 * Every call in this file is a GET. It creates nothing, changes nothing, deletes nothing.
 * Safe to run at any time, including against the live store.
 *
 *   node tools/play/play-audit.js
 *
 * Answers:
 *   • Which subscriptions / one-time products exist on Play right now?
 *   • Is the legacy inappproducts API still open for this developer account?
 *   • Can the service account read monetisation objects?
 *   • Can the service account call the purchase-verification endpoints?
 */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { google } = require(path.join(ROOT, 'node_modules', 'googleapis'));

const PKG = process.env.PLAY_PACKAGE || 'com.cvapplyr.mobile';
const KEY = process.env.GOOGLE_PLAY_SA_KEYFILE || path.join(ROOT, 'Keys', 'cvapplyr-e46cebab373e.json');
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const BASE = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}`;

// The five plans the app sells. Keep in sync with server/services/entitlements.js PLANS.
const PRODUCT_IDS = [
  'cvapplyr_sub_starter', 'cvapplyr_sub_plus', 'cvapplyr_sub_pro',
  'cvapplyr_sub_power', 'cvapplyr_sub_max',
];

async function main() {
  const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: [SCOPE] });
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;
  const ap = google.androidpublisher({ version: 'v3', auth: client });

  const GET = async (label, url) => {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    const body = await r.text();
    console.log(`\n[${r.status}] ${label}`);
    if (body) console.log(body.slice(0, 1200));
    else console.log('(empty body — 204 means "none exist")');
    return { status: r.status, body };
  };

  console.log(`Google Play read-only audit — package ${PKG}`);
  console.log(`Service account: ${require(KEY).client_email}`);

  // 1. Token identity + granted scopes (token is POSTed, never placed in a URL).
  const ti = await fetch('https://oauth2.googleapis.com/tokeninfo', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ access_token: token }),
  }).then((r) => r.json());
  console.log(`\nGranted scope: ${ti.scope}`);

  // 2. The three catalogue surfaces.
  await GET('monetization.subscriptions.list', `${BASE}/subscriptions?pageSize=50`);
  await GET('monetization.onetimeproducts.list (new publishing API)', `${BASE}/oneTimeProducts?pageSize=50`);
  await GET('inappproducts.list (LEGACY — 403 here means the account is already on the new model)',
    `${BASE}/inappproducts?maxResults=50`);

  // 3. Per-product existence check for the five plans we intend to sell.
  console.log('\n--- intended subscription product ids ---');
  for (const id of PRODUCT_IDS) {
    try {
      const r = await ap.monetization.subscriptions.get({ packageName: PKG, productId: id });
      const bps = (r.data.basePlans || []).map((b) => `${b.basePlanId}:${b.state}`).join(', ') || 'none';
      console.log(`  EXISTS  ${id}  basePlans[${bps}]`);
    } catch (e) {
      const code = e && e.code;
      console.log(`  ${code === 404 ? 'MISSING' : 'ERROR  '} ${id}  (${code} ${e?.response?.data?.error?.status || ''})`);
    }
  }

  // 4. Permission probes on the purchase-verification endpoints. A deliberately invalid token
  //    proves authorisation without touching a real purchase: 400 = we may call it,
  //    401/403 = the service account lacks the Play Console permission.
  console.log('\n--- purchase verification permission probes (invalid token on purpose) ---');
  for (const [label, fn] of [
    ['purchases.subscriptionsv2.get', () => ap.purchases.subscriptionsv2.get({ packageName: PKG, token: 'PERMISSION_PROBE' })],
    ['purchases.products.get', () => ap.purchases.products.get({ packageName: PKG, productId: PRODUCT_IDS[0], token: 'PERMISSION_PROBE' })],
    ['purchases.voidedpurchases.list', () => ap.purchases.voidedpurchases.list({ packageName: PKG, maxResults: 1 })],
  ]) {
    try {
      const r = await fn();
      console.log(`  ${label}: HTTP ${r.status} — AUTHORISED`);
    } catch (e) {
      const code = e && e.code;
      const verdict = code === 400 || code === 404 ? 'AUTHORISED (token was invalid, as intended)'
        : code === 401 || code === 403 ? 'NOT AUTHORISED — grant the permission in Play Console'
        : 'unexpected';
      console.log(`  ${label}: HTTP ${code} — ${verdict} — ${e?.response?.data?.error?.message || e.message}`);
    }
  }

  console.log('\nNOTE: write permission on monetisation objects CANNOT be proven read-only.');
  console.log('      The only proof is an actual create call — see tools/play/play-create-subscriptions.js --commit.');
}

main().catch((e) => { console.error(e); process.exit(1); });
