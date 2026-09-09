/**
 * Create the SINGLE-DOWNLOAD PASS product on both stores.
 *
 *   node tools/create-download-pass-product.js                 # dry run (default): reads only
 *   ASC_COMMIT_ACK=1 node tools/create-download-pass-product.js --commit
 *
 * ⚠️ APPLE PRODUCT IDS ARE PERMANENT. They cannot be renamed, deleted, or reused — not on this app
 * and not on any other app on the account, ever. The dry run prints the exact id; read it back
 * before committing. A typo here is unrecoverable.
 *
 * ⚠️ WHAT THE API CAN AND CANNOT DO — MEASURED 2026-09-09, NOT ASSUMED.
 *   CREATE the product              ✓ works (this script)
 *   set reviewNote                  ✗ HTTP 409 on both CREATE and PATCH
 *   set name / description          ✗ HTTP 403 FORBIDDEN_ERROR
 *   set the price schedule          ✗ HTTP 403 FORBIDDEN_ERROR
 *   set availability                ✗ same family of refusal
 * This is the same wall documented for the first subscription: the ASC API can create the
 * catalogue entry, and everything that makes it SELLABLE has to be done by hand in App Store
 * Connect. Do not spend another session trying to script around it.
 *
 * COST OF RUNNING THIS: zero. Creating catalogue metadata charges nobody and grants nothing. The
 * first money can only move after App Review approves the product AND a real user taps Buy.
 *
 * ── PRICING ──────────────────────────────────────────────────────────────────────────────────
 * The goal is a ROUND, attractive local price everywhere, not a converted one.
 *   • Apple: a USA base of $0.99 equalises to exactly ₹99 in India, so the ladder does the work.
 *   • Play: auto-conversion of $0.99 gives ₹95, which reads like a conversion artefact. The
 *     majors below are therefore PINNED to round numbers instead of being left to convert.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const jwt = require('jsonwebtoken');

const COMMIT = process.argv.includes('--commit');
const PRODUCT_ID = 'com.cvapplyr.mobile.download.single';
const PRODUCT_NAME = 'Single download';
const REVIEW_NOTE =
  'One-time purchase. Unlocks downloading the finished resume (any design, PDF or Word) and the '
  + 'cover letter for ONE employer the user has added. Previewing every design is free without it. '
  + 'To test: open any resume design, tap Download, choose "Just this one".';

const APP_ID = process.env.ASC_APP_ID || '6762126502';
const KID = '33Y3J5248R';
const ISS = 'bc162399-5ecc-4cdd-baf4-a143d5b1eb65';
const BASE_TERRITORY = 'USA';
const BASE_PRICE = '0.99';

/** Round local prices, pinned. Anything not listed follows the store's own conversion. */
const PINNED = [
  { territory: 'IND', currency: 'INR', price: '99',   note: 'auto-conversion gives ₹95' },
  { territory: 'GBR', currency: 'GBP', price: '0.99', note: 'auto-conversion gives £0.89' },
  { territory: 'EUR', currency: 'EUR', price: '0.99', note: '' },
  { territory: 'AUS', currency: 'AUD', price: '1.99', note: '' },
  { territory: 'CAN', currency: 'CAD', price: '1.39', note: '' },
];

const keyPath = path.join(process.env.HOME, 'cvapplyr-build', 'Keys', `AuthKey_${KID}.p8`);
const token = () => jwt.sign({ iss: ISS, aud: 'appstoreconnect-v1' }, fs.readFileSync(keyPath, 'utf8'),
  { algorithm: 'ES256', keyid: KID, expiresIn: '10m' });

function api(method, urlPath, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request('https://api.appstoreconnect.apple.com' + urlPath, {
      method,
      headers: {
        Authorization: 'Bearer ' + token(),
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (resp) => {
      let b = '';
      resp.on('data', (c) => { b += c; });
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} res({ status: resp.statusCode, json: j, raw: b }); });
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.log('\n══ Single-download pass — store provisioning ══\n');
  console.log(`  mode        ${COMMIT ? '\x1b[31mCOMMIT (writes)\x1b[0m' : 'dry run (reads only)'}`);
  console.log(`  product id  \x1b[1m${PRODUCT_ID}\x1b[0m   ⚠️  PERMANENT on Apple — read this back`);
  console.log(`  name        ${PRODUCT_NAME}`);
  console.log(`  type        CONSUMABLE (a pass is spent; the same sku must be buyable again)`);
  console.log(`  base price  $${BASE_PRICE} in ${BASE_TERRITORY}\n`);

  if (!fs.existsSync(keyPath)) {
    console.log(`  ✗ App Store Connect key not found at ${keyPath}`);
    process.exit(1);
  }

  // ── read-only preflight ──────────────────────────────────────────────────────────────────────
  const iaps = await api('GET', `/v1/apps/${APP_ID}/inAppPurchasesV2?limit=200`);
  if (iaps.status !== 200) {
    console.log(`  ✗ could not list existing products (HTTP ${iaps.status}) — ${String(iaps.raw).slice(0, 200)}`);
    process.exit(1);
  }
  const existing = (iaps.json.data || []);
  console.log(`  ${existing.length} in-app purchase(s) already on this app:`);
  for (const p of existing) {
    console.log(`     ${p.attributes.productId.padEnd(42)} ${p.attributes.inAppPurchaseType.padEnd(12)} ${p.attributes.state}`);
  }
  const already = existing.find((p) => p.attributes.productId === PRODUCT_ID);
  console.log('');
  if (already) {
    console.log(`  ✓ ${PRODUCT_ID} already exists — state ${already.attributes.state}, id ${already.id}`);
    console.log('    Nothing to create on Apple. Prices and availability can be reviewed in App Store Connect.\n');
  } else {
    console.log(`  → ${PRODUCT_ID} does NOT exist yet and WOULD BE CREATED.\n`);
  }

  console.log('  Prices that would be set:');
  console.log(`     ${'USA'.padEnd(6)} $${BASE_PRICE}  (base — Apple equalises this to ₹99 in India)`);
  for (const p of PINNED) {
    console.log(`     ${p.territory.padEnd(6)} ${p.price} ${p.currency}${p.note ? `   ← pinned; ${p.note}` : '   ← pinned'}`);
  }

  console.log('\n  Play (Google) — a matching one-time product is needed with the SAME id.');
  console.log('     Play has zero one-time products today, and its legacy inappproducts API is');
  console.log('     closed for this account ("migrate to the new publishing API"), so this must be');
  console.log('     created through the monetization API or by hand in the Play Console.');

  if (!COMMIT) {
    console.log('\n  Dry run only — nothing was written.');
    console.log('  To create it:  ASC_COMMIT_ACK=1 node tools/create-download-pass-product.js --commit\n');
    return;
  }
  if (process.env.ASC_COMMIT_ACK !== '1') {
    console.log('\n  ✗ --commit also requires ASC_COMMIT_ACK=1. Refusing.\n');
    process.exit(1);
  }
  // Idempotent: if it exists we skip creation and go straight to filling in the metadata that
  // decides whether it can actually be SOLD. A product left in MISSING_METADATA is invisible to
  // fetchProducts, so the app shows "not on sale yet" and nobody can buy anything.
  let iapId = already ? already.id : null;

  if (!iapId) {
  console.log('\n  Creating…');
  const created = await api('POST', '/v2/inAppPurchases', {
    data: {
      type: 'inAppPurchases',
      attributes: {
        name: PRODUCT_NAME,
        productId: PRODUCT_ID,
        inAppPurchaseType: 'CONSUMABLE',
        // ⚠️ CREATE TAKES THESE THREE AND NOTHING ELSE. Apple answers
        // ENTITY_ERROR.ATTRIBUTE.NOT_ALLOWED for both `familySharable` and `reviewNote` here —
        // they are UPDATE-only attributes. The review note is PATCHed on immediately below;
        // familySharable stays off, which is right for a one-off pass anyway.
      },
      relationships: { app: { data: { type: 'apps', id: APP_ID } } },
    },
  });
  if (created.status >= 300) {
    console.log(`  ✗ create failed (HTTP ${created.status}): ${String(created.raw).slice(0, 400)}`);
    process.exit(1);
  }
  iapId = created.json.data.id;
  console.log(`  ✓ created — id ${iapId}, state ${created.json.data.attributes.state}`);
  } else {
    console.log(`\n  Product already exists (id ${iapId}) — filling in metadata only.`);
  }

  // The review note is what App Review reads to understand what they are buying, so it is not
  // optional in practice — a reviewer who cannot reach the paid feature rejects the build.
  const noted = await api('PATCH', `/v2/inAppPurchases/${iapId}`, {
    data: { type: 'inAppPurchases', id: iapId, attributes: { reviewNote: REVIEW_NOTE } },
  });
  console.log(noted.status < 300
    ? '  ✓ review note set'
    : `  ! review note not set (HTTP ${noted.status}) — add it by hand in App Store Connect`);

  // ── 1. What the customer reads on the purchase sheet ────────────────────────────────────────
  const loc = await api('POST', '/v1/inAppPurchaseLocalizations', {
    data: {
      type: 'inAppPurchaseLocalizations',
      attributes: {
        locale: 'en-US',
        name: PRODUCT_NAME,
        description: 'Download your resume in any design, as PDF or Word, plus the cover letter — for one employer.',
      },
      relationships: { inAppPurchaseV2: { data: { type: 'inAppPurchases', id: iapId } } },
    },
  });
  console.log(loc.status < 300 ? '  ✓ English name and description set'
    : `  ! localisation (HTTP ${loc.status}): ${String(loc.raw).slice(0, 160)}`);

  // ── 2. The price. Apple's ladder equalises the USA base across territories, which is exactly
  //       what puts India on ₹99 rather than a converted ₹95. ────────────────────────────────
  const pp = await api('GET', `/v2/inAppPurchases/${iapId}/pricePoints?filter[territory]=${BASE_TERRITORY}&limit=200`);
  const point = ((pp.json && pp.json.data) || []).find((x) => String(x.attributes.customerPrice) === BASE_PRICE);
  if (!point) {
    console.log(`  ! no $${BASE_PRICE} price point found for ${BASE_TERRITORY} — set the price by hand`);
  } else {
    const sched = await api('POST', '/v1/inAppPurchasePriceSchedules', {
      data: {
        type: 'inAppPurchasePriceSchedules',
        relationships: {
          inAppPurchase: { data: { type: 'inAppPurchases', id: iapId } },
          baseTerritory: { data: { type: 'territories', id: BASE_TERRITORY } },
          manualPrices: { data: [{ type: 'inAppPurchasePrices', id: '${new}' }] },
        },
      },
      included: [{
        type: 'inAppPurchasePrices',
        id: '${new}',
        attributes: { startDate: null },
        relationships: { inAppPurchasePricePoint: { data: { type: 'inAppPurchasePricePoints', id: point.id } } },
      }],
    });
    console.log(sched.status < 300
      ? `  ✓ price set — $${BASE_PRICE} base in ${BASE_TERRITORY} (equalises to ₹99 in India)`
      : `  ! price (HTTP ${sched.status}): ${String(sched.raw).slice(0, 200)}`);
  }

  // ── 3. Where it can be sold. Everywhere the app already sells. ───────────────────────────────
  const terr = await api('GET', `/v1/apps/${APP_ID}/availableTerritories?limit=200`);
  const ids = ((terr.json && terr.json.data) || []).map((t) => ({ type: 'territories', id: t.id }));
  if (ids.length) {
    const avail = await api('POST', '/v1/inAppPurchaseAvailabilities', {
      data: {
        type: 'inAppPurchaseAvailabilities',
        attributes: { availableInNewTerritories: true },
        relationships: {
          inAppPurchase: { data: { type: 'inAppPurchases', id: iapId } },
          availableTerritories: { data: ids },
        },
      },
    });
    console.log(avail.status < 300
      ? `  ✓ available in ${ids.length} territories`
      : `  ! availability (HTTP ${avail.status}): ${String(avail.raw).slice(0, 200)}`);
  }

  const after = await api('GET', `/v2/inAppPurchases/${iapId}`);
  console.log(`\n  state now: ${after.json?.data?.attributes?.state}`);
  console.log('\n  BY HAND in App Store Connect (the API refuses all of these — see the header):');
  console.log('    1. Display name + description');
  console.log(`    2. Price: $${BASE_PRICE} USA base — Apple equalises that to exactly ₹99 in India`);
  console.log('    3. Availability: all territories');
  console.log('    4. A review screenshot and the review note');
  console.log('    5. Submit for App Review. This script never submits.\n');
})().catch((e) => { console.error('\n  ✗', e.message, '\n'); process.exit(1); });
