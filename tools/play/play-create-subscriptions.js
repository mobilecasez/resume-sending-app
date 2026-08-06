#!/usr/bin/env node
/**
 * tools/play/play-create-subscriptions.js
 *
 * Creates the five cvApplyr monthly subscriptions on Google Play.
 *
 *   ***  DRY RUN IS THE DEFAULT.  NOTHING IS WRITTEN WITHOUT --commit.  ***
 *
 *   node tools/play/play-create-subscriptions.js                # dry run, calls the read-only
 *                                                               # price converter, prints payloads
 *   node tools/play/play-create-subscriptions.js --offline      # dry run, zero network calls
 *   node tools/play/play-create-subscriptions.js --only=starter # limit to one plan
 *   node tools/play/play-create-subscriptions.js --commit       # THE ONLY MODE THAT WRITES
 *
 * What --commit does, per plan:
 *   1. POST  /subscriptions?productId=…&regionsVersion.version=2022/02   (create, base plan DRAFT)
 *   2. POST  /subscriptions/{id}/basePlans/{bp}:activate                 (make it sellable)
 * It never deletes or archives anything, and it refuses to touch a product that already exists.
 *
 * Prerequisites that this script CANNOT create for you (Play Console, account owner only):
 *   • A Google payments merchant profile linked to the developer account.
 *   • The service account granted "Manage store presence" (account level) in Users & permissions.
 *   • An app release containing the Play Billing Library published to at least one track.
 */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { google } = require(path.join(ROOT, 'node_modules', 'googleapis'));

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const OFFLINE = argv.includes('--offline');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

const PKG = process.env.PLAY_PACKAGE || 'com.cvapplyr.mobile';
const KEY = process.env.GOOGLE_PLAY_SA_KEYFILE || path.join(ROOT, 'Keys', 'cvapplyr-e46cebab373e.json');
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

// The current set of supported Play regions. Bump only when Google publishes a new version.
const REGIONS_VERSION = '2022/02';
const BASE_PLAN_ID = 'monthly';           // RFC-1034: lowercase letters, digits and '-' only.
const LANG = 'en-US';

// Mirrors server/services/entitlements.js PLANS. priceUsd is the tax-EXCLUSIVE list price.
const PLANS = [
  { key: 'starter', productId: 'cvapplyr_sub_starter', priceUsd: 4.99,  title: 'cvApplyr Starter',
    description: '30 AI cover letters and 5 AI resumes every month.',
    benefits: ['30 AI cover letters / month', '5 AI resumes / month', 'Auto Fill on job portals'] },
  { key: 'plus',    productId: 'cvapplyr_sub_plus',    priceUsd: 9.99,  title: 'cvApplyr Plus',
    description: '100 AI cover letters and 10 AI resumes every month.',
    benefits: ['100 AI cover letters / month', '10 AI resumes / month', 'Auto Fill on job portals'] },
  { key: 'pro',     productId: 'cvapplyr_sub_pro',     priceUsd: 14.99, title: 'cvApplyr Pro',
    description: '150 AI cover letters and 15 AI resumes every month.',
    benefits: ['150 AI cover letters / month', '15 AI resumes / month', 'Auto Fill on job portals'] },
  { key: 'power',   productId: 'cvapplyr_sub_power',   priceUsd: 24.99, title: 'cvApplyr Power',
    description: '300 AI cover letters and 25 AI resumes every month.',
    benefits: ['300 AI cover letters / month', '25 AI resumes / month', 'Auto Fill on job portals'] },
  { key: 'max',     productId: 'cvapplyr_sub_max',     priceUsd: 49.99, title: 'cvApplyr Max',
    description: '1000 AI cover letters and 50 AI resumes every month.',
    benefits: ['1000 AI cover letters / month', '50 AI resumes / month', 'Auto Fill on job portals'] },
];

const usdMoney = (usd) => ({
  currencyCode: 'USD',
  units: String(Math.floor(usd)),
  nanos: Math.round((usd - Math.floor(usd)) * 1e9),
});

/**
 * Ask Play to convert one USD price into every sellable region's local currency.
 * This endpoint is a pure calculation — it stores nothing — so the dry run may call it.
 */
async function regionalPrices(ap, priceUsd) {
  const res = await ap.monetization.convertRegionPrices({
    packageName: PKG,
    requestBody: { price: { currencyCode: 'USD', units: String(Math.floor(priceUsd)), nanos: Math.round((priceUsd - Math.floor(priceUsd)) * 1e9) } },
  });
  const map = res.data.convertedRegionPrices || {};
  const regionalConfigs = Object.values(map).map((v) => ({
    regionCode: v.regionCode,
    newSubscriberAvailability: true,
    price: v.price,          // already tax-inclusive and in the region's currency
  }));
  const other = res.data.convertedOtherRegionsPrice || {};
  return {
    regionalConfigs,
    otherRegionsConfig: {
      usdPrice: other.usdPrice || usdMoney(priceUsd),
      eurPrice: other.eurPrice || null,
      newSubscriberAvailability: true,
    },
  };
}

function subscriptionBody(plan, pricing) {
  return {
    packageName: PKG,
    productId: plan.productId,
    listings: [{
      languageCode: LANG,
      title: plan.title,                    // <= 55 chars
      description: plan.description,        // <= 200 chars
      benefits: plan.benefits.slice(0, 4),  // max 4, <= 40 chars each
    }],
    basePlans: [{
      basePlanId: BASE_PLAN_ID,
      autoRenewingBasePlanType: {
        billingPeriodDuration: 'P1M',
        gracePeriodDuration: 'P7D',       // grace + accountHold must total P30D..P60D
        accountHoldDuration: 'P30D',
        resubscribeState: 'RESUBSCRIBE_STATE_ACTIVE',
        prorationMode: 'SUBSCRIPTION_PRORATION_MODE_CHARGE_ON_NEXT_BILLING_DATE',
        legacyCompatible: false,
      },
      regionalConfigs: pricing.regionalConfigs,
      otherRegionsConfig: pricing.otherRegionsConfig,
      offerTags: [{ tag: plan.key }],
    }],
    taxAndComplianceSettings: {
      // Digital service, no physical goods. Play remits where it is the merchant of record.
      isTokenizedDigitalAsset: false,
    },
  };
}

async function main() {
  const plans = ONLY ? PLANS.filter((p) => p.key === ONLY) : PLANS;
  if (!plans.length) { console.error(`No plan matches --only=${ONLY}`); process.exit(1); }

  console.log(`Package        : ${PKG}`);
  console.log(`Regions version: ${REGIONS_VERSION}`);
  console.log(`Mode           : ${COMMIT ? '*** COMMIT — THIS WILL WRITE TO THE LIVE STORE ***' : OFFLINE ? 'DRY RUN (offline, no network)' : 'DRY RUN (read-only calls only)'}`);
  console.log(`Plans          : ${plans.map((p) => p.key).join(', ')}\n`);

  if (COMMIT && !process.env.PLAY_COMMIT_ACK) {
    console.error('Refusing to commit. Re-run with PLAY_COMMIT_ACK=1 in the environment to confirm you');
    console.error('intend to create real, sellable subscription products on the live Play listing.');
    process.exit(2);
  }

  let ap = null;
  if (!OFFLINE) {
    const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: [SCOPE] });
    ap = google.androidpublisher({ version: 'v3', auth: await auth.getClient() });
  }

  for (const plan of plans) {
    console.log(`\n════ ${plan.key}  ($${plan.priceUsd}/month  →  ${plan.productId}) ════`);

    // Never overwrite an existing product.
    if (ap) {
      try {
        await ap.monetization.subscriptions.get({ packageName: PKG, productId: plan.productId });
        console.log('  SKIP — a subscription with this productId already exists on Play.');
        continue;
      } catch (e) {
        if (e.code !== 404) { console.log(`  ABORT — unexpected ${e.code}: ${e?.response?.data?.error?.message || e.message}`); continue; }
      }
    }

    const pricing = OFFLINE
      ? { regionalConfigs: [{ regionCode: 'US', newSubscriberAvailability: true, price: usdMoney(plan.priceUsd) }],
          otherRegionsConfig: { usdPrice: usdMoney(plan.priceUsd), eurPrice: null, newSubscriberAvailability: true } }
      : await regionalPrices(ap, plan.priceUsd);

    const body = subscriptionBody(plan, pricing);
    console.log(`  regions priced : ${pricing.regionalConfigs.length}${OFFLINE ? '  (offline placeholder — real run fetches every Play region)' : ''}`);
    console.log('  payload (regionalConfigs truncated to 3 for readability):');
    console.log(JSON.stringify({ ...body, basePlans: [{ ...body.basePlans[0], regionalConfigs: pricing.regionalConfigs.slice(0, 3) }] }, null, 2)
      .split('\n').map((l) => '    ' + l).join('\n'));

    if (!COMMIT) {
      console.log(`  DRY RUN — would POST /applications/${PKG}/subscriptions?productId=${plan.productId}&regionsVersion.version=${REGIONS_VERSION}`);
      console.log(`  DRY RUN — would then POST …/subscriptions/${plan.productId}/basePlans/${BASE_PLAN_ID}:activate`);
      continue;
    }

    const created = await ap.monetization.subscriptions.create({
      packageName: PKG,
      productId: plan.productId,
      'regionsVersion.version': REGIONS_VERSION,
      requestBody: body,
    });
    console.log(`  CREATED — base plan state: ${(created.data.basePlans || [])[0]?.state}`);

    await ap.monetization.subscriptions.basePlans.activate({
      packageName: PKG,
      productId: plan.productId,
      basePlanId: BASE_PLAN_ID,
      requestBody: { latencyTolerance: 'PRODUCT_UPDATE_LATENCY_TOLERANCE_LATENCY_SENSITIVE' },
    });
    console.log('  ACTIVATED — base plan is now sellable to new subscribers.');
  }

  console.log(`\nDone. ${COMMIT ? 'Products were written to the live store.' : 'Nothing was written.'}`);
}

main().catch((e) => {
  console.error('\nFAILED:', e?.response?.data ? JSON.stringify(e.response.data, null, 2) : e);
  process.exit(1);
});
