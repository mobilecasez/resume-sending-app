#!/usr/bin/env node
/**
 * tools/create-play-subscriptions.js
 *
 * Creates the five cvApplyr auto-renewing monthly subscriptions on Google Play.
 *
 *   ***********************************************************************************
 *   ***  DRY RUN IS THE DEFAULT.  NOTHING IS WRITTEN WITHOUT --commit.              ***
 *   ***  --commit ALSO REQUIRES  PLAY_COMMIT_ACK=1  AND  PLAY_MERCHANT_ACK=1.       ***
 *   ***  This script never publishes a release, never touches an app version, and   ***
 *   ***  never deletes or archives an existing product.                             ***
 *   ***********************************************************************************
 *
 *   node tools/create-play-subscriptions.js                    # dry run: preflight + full plan
 *   node tools/create-play-subscriptions.js --plan=starter     # dry run, one plan
 *   node tools/create-play-subscriptions.js --offline          # dry run with zero network calls
 *   PLAY_COMMIT_ACK=1 PLAY_MERCHANT_ACK=1 \
 *     node tools/create-play-subscriptions.js --commit         # the only mode that writes
 *
 * COST OF RUNNING THIS SCRIPT: zero. Creating a subscription product on Play charges nobody,
 * bills no card, and grants no entitlement. Play subscriptions have no review fee. The first
 * money can only move when a real user completes a purchase against an ACTIVE base plan.
 *
 * ── WHAT --commit DOES, PER PLAN ─────────────────────────────────────────────────────────────
 *   1. POST /applications/{pkg}/subscriptions?productId=…&regionsVersion.version=2022/02
 *   2. POST /applications/{pkg}/subscriptions/{id}/basePlans/monthly:activate
 * Step 2 is not optional. Base plans are created in DRAFT and a DRAFT base plan is INVISIBLE to
 * Play Billing — the product looks created in Console and is simply unbuyable. This is the
 * easiest thing in the whole flow to forget.
 *
 * ── PRICES ARE FETCHED, NOT INVENTED ─────────────────────────────────────────────────────────
 * Every regional price comes from monetization.convertRegionPrices, which is a pure calculation
 * endpoint (it stores nothing, so the dry run may call it). Measured 2026-08-06 it returns 173
 * regions with real local currency and tax amounts. regionalConfigs[] is REQUIRED for every
 * country you intend to sell in — otherRegionsConfig only covers regions Play adds in the FUTURE.
 * A country missing from regionalConfigs shows "not available in your country" rather than a
 * price that fails at checkout, which is the failure mode you want.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const { google } = require(path.join(ROOT, 'node_modules', 'googleapis'));

// ── arguments ─────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const OFFLINE = argv.includes('--offline');
const ONLY = (argv.find((a) => a.startsWith('--plan=')) || '').split('=')[1] || null;

// ── configuration ─────────────────────────────────────────────────────────────────────────────
const PKG = process.env.PLAY_PACKAGE || 'com.cvapplyr.mobile';
const KEY = process.env.GOOGLE_PLAY_SA_KEYFILE || path.join(ROOT, 'Keys', 'cvapplyr-e46cebab373e.json');
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const REGIONS_VERSION = '2022/02';   // bump only when Google publishes a new supported-regions set
const BASE_PLAN_ID = 'monthly';      // RFC-1034: lowercase letters, digits and '-' only. NO underscores.
const LANG = 'en-US';
const BASE = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}`;

// ── THE FROZEN PRODUCT TABLE — identical ids to Apple ─────────────────────────────────────────
// Not duplicated here: read from server/services/storeProducts.js, the one place a store product
// id becomes a plan_key. Play's charset for a subscription id is [a-z0-9_.] up to 40 chars, so
// com.cvapplyr.sub.<key> is legal on both stores; one id per plan keeps the server's
// product-id -> plan mapping a single table instead of two that can drift.
// storeProducts.js is dependency-free, so requiring it opens no database pool.
const storeProducts = require(path.join(ROOT, 'server/services/storeProducts.js'));

function serverPlans() {
  const src = fs.readFileSync(path.join(ROOT, 'server/services/entitlements.js'), 'utf8');
  const m = src.match(/const PLANS = (\[[\s\S]*?\n\];)/);
  if (!m) throw new Error('could not locate the PLANS array in server/services/entitlements.js');
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1].replace(/;$/, '')}`)();
}

const FROZEN = storeProducts.SUBSCRIPTIONS.map((s) => {
  const e = serverPlans().find((x) => x.key === s.planKey) || {};
  return {
    key: s.planKey,
    productId: s.productId,
    basePlanId: s.basePlanId || BASE_PLAN_ID,
    priceUsd: s.priceUsd,
    letters: e.letters,
    resumes: e.resumes,
    title: `cvApplyr ${e.label || s.planKey}`,
  };
});
const description = (p) => `${p.letters} AI cover letters and ${p.resumes} AI resumes every month.`;
const benefits = (p) => [
  `${p.letters} AI cover letters / month`,
  `${p.resumes} AI resumes / month`,
  'Auto Fill on job portals',
].map((b) => b.slice(0, 40)).slice(0, 4);

const usdMoney = (usd) => ({ currencyCode: 'USD', units: String(Math.floor(usd)), nanos: Math.round((usd - Math.floor(usd)) * 1e9) });
// Display only. Play amounts are units + nanos; naive nanos/1e7 rounding renders 0.998 as "0.100".
const money = (m) => (m ? `${m.currencyCode} ${(Number(m.units || 0) + Number(m.nanos || 0) / 1e9).toFixed(2)}` : '—');

// ── preflight bookkeeping ─────────────────────────────────────────────────────────────────────
const blockers = [];
const warnings = [];
const block = (what, remedy) => { blockers.push({ what, remedy }); console.log(`  BLOCKER  ${what}\n           -> ${remedy}`); };
const warn = (what, note) => { warnings.push({ what, note }); console.log(`  WARN     ${what}\n           -> ${note}`); };
const ok = (what) => console.log(`  ok       ${what}`);
const gerr = (e) => (e && e.response && e.response.data && e.response.data.error) || {};

/**
 * Write-permission probe that CANNOT create anything.
 *
 * PATCH a product id that does not and will never exist, with allowMissing=false. The service
 * account either has the monetisation write permission (Play answers 404 NOT_FOUND, because the
 * request was authorised and only then failed to find the product) or it does not (403
 * PERMISSION_DENIED). Measured 2026-08-06 this returns 404 for eas-submit@cvapplyr — i.e. the
 * write permission IS already granted, which is worth knowing before anyone edits Console roles.
 */
async function probeMonetizationWrite(accessToken) {
  const probeId = 'com.cvapplyr.sub.__permission_probe__';
  const url = `${BASE}/subscriptions/${probeId}`
            + `?updateMask=listings&allowMissing=false&regionsVersion.version=${encodeURIComponent(REGIONS_VERSION)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ packageName: PKG, productId: probeId, listings: [{ languageCode: LANG, title: 'probe', description: 'probe' }] }),
  });
  let body = {}; try { body = JSON.parse(await r.text()); } catch { /* ignore */ }
  return { status: r.status, message: (body.error && body.error.message) || '' };
}

async function preflight(ap, accessToken, plans) {
  console.log('\n=== PREFLIGHT (read-only; the write probe cannot create anything) ===');

  if (!fs.existsSync(KEY)) {
    block(`service account key ${path.relative(ROOT, KEY)} is missing`,
      'ACCOUNT OWNER ACTION: Google Cloud Console > IAM > Service Accounts > Keys > Add key (JSON), '
      + 'then link that service account in Play Console > Users and permissions.');
    return;
  }
  ok(`service account ${require(KEY).client_email}`);

  // 1. Read the catalogue. A 401/403 here means the account is not linked at all.
  let existing = [];
  try {
    const r = await ap.monetization.subscriptions.list({ packageName: PKG, pageSize: 100 });
    existing = r.data.subscriptions || [];
    ok(`monetization.subscriptions.list -> ${existing.length} existing subscription(s)`);
  } catch (e) {
    const g = gerr(e);
    block(`cannot read the Play subscription catalogue (${e.code} ${g.status || ''})`,
      'ACCOUNT OWNER ACTION: Play Console > Users and permissions > invite '
      + `${fs.existsSync(KEY) ? require(KEY).client_email : 'the service account'} and grant it access to ${PKG}.`);
    return { existing };
  }

  // 2. Write permission on monetisation objects.
  const probe = await probeMonetizationWrite(accessToken);
  if (probe.status === 404) {
    ok('monetisation WRITE permission confirmed (PATCH on a nonexistent product returned 404 NOT_FOUND, '
      + 'not 403 — the request was authorised; allowMissing=false means nothing was created)');
  } else if (probe.status === 403 || probe.status === 401) {
    block(`the service account is NOT allowed to write monetisation objects (${probe.status})`,
      'ACCOUNT OWNER ACTION: Play Console > Users and permissions > select the service account > '
      + 'Account permissions > tick "Manage store presence" (and "Manage orders and subscriptions" '
      + 'if you also want it to handle refunds). Without it, create the five products by hand in Console.');
  } else {
    warn(`write probe returned ${probe.status}: ${probe.message.slice(0, 160)}`,
      'Could not confirm write permission. --commit may still fail with 403.');
  }

  // 3. Merchant account. Play exposes NO endpoint that reports merchant-profile status, but
  //    convertRegionPrices only answers for a developer account that is set up to sell, so a
  //    healthy multi-region response is the best available proxy.
  if (!OFFLINE) {
    try {
      const r = await ap.monetization.convertRegionPrices({ packageName: PKG, requestBody: { price: usdMoney(1.99) } });
      const n = Object.keys(r.data.convertedRegionPrices || {}).length;
      if (n > 100) ok(`pricing:convertRegionPrices answers for ${n} regions — the developer account can sell`);
      else block(`convertRegionPrices returned only ${n} region(s)`,
        'ACCOUNT OWNER ACTION: Play Console > Setup > Payments profile. Create/link a Google payments '
        + 'merchant profile and complete tax, banking and payout country.');
    } catch (e) {
      const g = gerr(e);
      block(`pricing:convertRegionPrices failed (${e.code} ${g.status || ''}: ${(g.message || '').slice(0, 120)})`,
        'ACCOUNT OWNER ACTION: this usually means there is no Google payments merchant profile linked to '
        + 'the developer account. Play Console > Setup > Payments profile — owner only, no API can do it.');
    }
  }
  console.log('  note     Merchant profile, tax, banking, payout country and the Developer Distribution');
  console.log('           Agreement are NOT readable through any API. ACCOUNT OWNER ACTION before --commit:');
  console.log('           confirm each in Play Console > Setup > Payments profile.');
  if (COMMIT && process.env.PLAY_MERCHANT_ACK !== '1') {
    block('PLAY_MERCHANT_ACK=1 not set',
      'Set it only after you have personally seen the payments profile, tax and banking complete in Play Console.');
  }

  // 4. RTDN — needed before a renewal or refund can be attributed to a user.
  console.log('  note     Real-time developer notifications (Pub/Sub topic + Cloud IAM) are configured under');
  console.log('           Monetization setup and are not readable here. Without RTDN, renewals, cancellations');
  console.log('           and refunds never reach the server and a refunded user keeps a paid plan forever.');

  // 5. Product id legality.
  for (const p of plans) {
    if (!/^[a-z0-9_.]{1,40}$/.test(p.productId)) block(`product id "${p.productId}" is illegal on Play`, 'Play allows [a-z0-9_.] up to 40 characters.');
  }
  if (!/^[a-z0-9-]{1,63}$/.test(BASE_PLAN_ID)) block(`base plan id "${BASE_PLAN_ID}" is illegal`, 'RFC-1034: lowercase letters, digits and hyphens only — no underscores.');
  ok(`product ids and base plan id "${BASE_PLAN_ID}" are legal on Play`);

  // 6. entitlements.js drift — the app must ask for exactly these ids.
  const server = serverPlans();
  for (const f of plans) {
    const s = server.find((x) => x.key === f.key);
    if (!s) { block(`entitlements.js has no plan "${f.key}"`, 'The server catalogue and this table must match exactly.'); continue; }
    if (s.productAndroid !== f.productId) {
      block(`entitlements.js productAndroid for ${f.key} is "${s.productAndroid}" but this script would create "${f.productId}"`,
        'ACTION: edit server/services/entitlements.js line ~25-34 and change productAndroid to '
        + `"${f.productId}". Play currently has ZERO subscriptions so nothing is stranded by the rename. `
        + 'If you create the product under one id and the app requests the other, the paywall fetch returns '
        + 'nothing and every plan renders unbuyable.');
    }
    if (s.productIos !== f.productId) {
      block(`entitlements.js productIos for ${f.key} is "${s.productIos}" but the canonical id is "${f.productId}"`,
        'The design rule is ONE identifier on both stores. Reconcile storeProducts.js and entitlements.js. '
        + 'Also run `node tools/create-apple-subscriptions.js` — it checks what is actually reserved on Apple, '
        + 'where ids can never be renamed or reused.');
    }
    if (Number(s.priceUsd) !== f.priceUsd) block(`entitlements.js priceUsd for ${f.key} is ${s.priceUsd}, this script prices at ${f.priceUsd}`, 'Reconcile before creating.');
    if (s.letters !== f.letters || s.resumes !== f.resumes) block(`entitlements.js quota for ${f.key} is ${s.letters}/${s.resumes}, the store listing would promise ${f.letters}/${f.resumes}`, 'The listing would promise what the server does not grant.');
  }

  return { existing };
}

// ── real regional pricing ─────────────────────────────────────────────────────────────────────
async function regionalPricing(ap, priceUsd) {
  if (OFFLINE) {
    return {
      regionalConfigs: [{ regionCode: 'US', newSubscriberAvailability: true, price: usdMoney(priceUsd) }],
      otherRegionsConfig: { usdPrice: usdMoney(priceUsd), eurPrice: null, newSubscriberAvailability: true },
      offline: true,
    };
  }
  const r = await ap.monetization.convertRegionPrices({ packageName: PKG, requestBody: { price: usdMoney(priceUsd) } });
  const map = r.data.convertedRegionPrices || {};
  const other = r.data.convertedOtherRegionsPrice || {};
  return {
    regionalConfigs: Object.values(map).map((v) => ({ regionCode: v.regionCode, newSubscriberAvailability: true, price: v.price })),
    otherRegionsConfig: { usdPrice: other.usdPrice || usdMoney(priceUsd), eurPrice: other.eurPrice || null, newSubscriberAvailability: true },
    taxSample: Object.values(map).slice(0, 5),
  };
}

function subscriptionBody(plan, pricing) {
  return {
    packageName: PKG,
    productId: plan.productId,
    listings: [{ languageCode: LANG, title: plan.title, description: description(plan), benefits: benefits(plan) }],
    basePlans: [{
      basePlanId: BASE_PLAN_ID,
      autoRenewingBasePlanType: {
        billingPeriodDuration: 'P1M',
        gracePeriodDuration: 'P7D',        // grace + account hold must total between P30D and P60D
        accountHoldDuration: 'P30D',
        resubscribeState: 'RESUBSCRIBE_STATE_ACTIVE',
        // Explicit and deliberate. Without a proration mode a plan change can bill the full new
        // price immediately with no credit for the unused period — the most likely real over-charge
        // in this whole migration. CHARGE_ON_NEXT_BILLING_DATE never takes money mid-cycle.
        prorationMode: 'SUBSCRIPTION_PRORATION_MODE_CHARGE_ON_NEXT_BILLING_DATE',
        legacyCompatible: false,
      },
      regionalConfigs: pricing.regionalConfigs,
      otherRegionsConfig: pricing.otherRegionsConfig,
      offerTags: [{ tag: plan.key }],
    }],
    taxAndComplianceSettings: {
      isTokenizedDigitalAsset: false,
      // Per-region digital-services tax categories are set in Console. Leaving this to Play's
      // default means Play remits where it is merchant of record; verify before launch.
    },
  };
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const plans = ONLY ? FROZEN.filter((p) => p.key === ONLY) : FROZEN;
  if (!plans.length) { console.error(`No plan matches --plan=${ONLY}. Known: ${FROZEN.map((p) => p.key).join(', ')}`); process.exit(1); }

  console.log('Google Play — create the 5 cvApplyr monthly subscriptions');
  console.log(`Package        : ${PKG}`);
  console.log(`Regions version: ${REGIONS_VERSION}`);
  console.log(`Base plan      : ${BASE_PLAN_ID} (P1M, auto-renewing)`);
  console.log(`Mode           : ${COMMIT ? '*** COMMIT — THIS WILL WRITE TO THE LIVE STORE ***' : OFFLINE ? 'DRY RUN (offline, zero network calls)' : 'DRY RUN (read-only calls only; nothing is written)'}`);
  console.log(`Plans          : ${plans.map((p) => p.key).join(', ')}`);
  console.log('Charges        : none. Creating catalogue products bills nobody and entitles nobody.');

  let ap = null; let accessToken = null;
  if (!OFFLINE) {
    const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: [SCOPE] });
    const client = await auth.getClient();
    accessToken = (await client.getAccessToken()).token;
    ap = google.androidpublisher({ version: 'v3', auth: client });
  }

  const pre = OFFLINE
    ? (console.log('\n=== PREFLIGHT SKIPPED (--offline) ===') || { existing: [] })
    : (await preflight(ap, accessToken, plans)) || { existing: [] };

  if (COMMIT && !process.env.PLAY_COMMIT_ACK) {
    console.error('\nRefusing to commit: PLAY_COMMIT_ACK=1 is not set in the environment.');
    console.error('This creates real, sellable products on the live Play listing.');
    process.exit(2);
  }
  if (blockers.length) {
    console.log(`\n=== ${blockers.length} BLOCKER(S) ===`);
    blockers.forEach((b, i) => console.log(`${i + 1}. ${b.what}\n   ACTION: ${b.remedy}`));
    if (COMMIT) { console.error('\nRefusing to write to Google Play while blockers remain.'); process.exit(3); }
    console.log('\n(dry run continues so you can see the full plan, but --commit would refuse here)');
  }

  console.log(`\n=== ${COMMIT ? 'EXECUTING' : 'PLAN — this is exactly what --commit would send'} ===`);
  const existingIds = new Set((pre.existing || []).map((s) => s.productId));
  let wouldCreate = 0; let wouldActivate = 0;

  for (const plan of plans) {
    console.log(`\n════ ${plan.key}  $${plan.priceUsd}/month  →  ${plan.productId} ════`);

    // Idempotency: never overwrite, never re-create. An existing product with a DRAFT base plan
    // still needs activating, so that path stays open.
    let current = null;
    if (ap) {
      try { current = (await ap.monetization.subscriptions.get({ packageName: PKG, productId: plan.productId })).data; }
      catch (e) {
        if (e.code !== 404) {
          console.log(`  SKIP — unexpected ${e.code} reading this product: ${(gerr(e).message || e.message).slice(0, 160)}`);
          continue;
        }
      }
    }
    if (existingIds.has(plan.productId) && !current) current = { productId: plan.productId, basePlans: [] };

    if (current) {
      const bp = (current.basePlans || []).find((b) => b.basePlanId === BASE_PLAN_ID);
      console.log(`  [skip create] this product already exists on Play (base plans: `
        + `${(current.basePlans || []).map((b) => `${b.basePlanId}:${b.state}`).join(', ') || 'none'})`);
      if (bp && bp.state === 'ACTIVE') { console.log('  [skip activate] base plan is already ACTIVE and sellable.'); continue; }
      if (!bp) { console.log(`  WARN — no "${BASE_PLAN_ID}" base plan on the existing product. Fix it in Console; this script will not mutate an existing product.`); continue; }
      wouldActivate++;
      if (!COMMIT) { console.log(`  WOULD POST ${BASE_PLAN_ID}:activate — the base plan exists but is ${bp.state}, so it is NOT sellable.`); continue; }
      await ap.monetization.subscriptions.basePlans.activate({
        packageName: PKG, productId: plan.productId, basePlanId: BASE_PLAN_ID,
        requestBody: { latencyTolerance: 'PRODUCT_UPDATE_LATENCY_TOLERANCE_LATENCY_SENSITIVE' },
      });
      console.log('    ACTIVATED — base plan is now sellable to new subscribers.');
      continue;
    }

    const pricing = await regionalPricing(ap, plan.priceUsd);
    console.log(`  regions priced : ${pricing.regionalConfigs.length}`
      + (pricing.offline ? '  (offline placeholder — a real run fetches every Play region)' : '  (fetched live from pricing:convertRegionPrices)'));
    if (pricing.taxSample) {
      console.log('  sample of the REAL prices Play returned (local currency, tax-inclusive):');
      for (const s of pricing.taxSample) console.log(`      ${s.regionCode}  ${money(s.price)}   (tax ${money(s.taxAmount)})`);
      const us = pricing.regionalConfigs.find((r) => r.regionCode === 'US');
      console.log(`      US  ${money(us && us.price)}  <- must equal the $${plan.priceUsd} advertised by entitlements.js`);
    }

    const body = subscriptionBody(plan, pricing);
    const shown = { ...body, basePlans: [{ ...body.basePlans[0], regionalConfigs: [`… ${pricing.regionalConfigs.length} regionalConfigs, first 3 shown …`, ...pricing.regionalConfigs.slice(0, 3)] }] };
    console.log(`\n  WOULD POST ${BASE}/subscriptions?productId=${plan.productId}&regionsVersion.version=${REGIONS_VERSION}`);
    console.log(JSON.stringify(shown, null, 2).replace(/^/gm, '    '));
    console.log(`\n  WOULD POST ${BASE}/subscriptions/${plan.productId}/basePlans/${BASE_PLAN_ID}:activate`);
    console.log('  # without this the base plan stays DRAFT: visible in Console, invisible to Play Billing.');
    wouldCreate++;

    if (!COMMIT) continue;

    const created = await ap.monetization.subscriptions.create({
      packageName: PKG, productId: plan.productId, 'regionsVersion.version': REGIONS_VERSION, requestBody: body,
    });
    console.log(`    CREATED — base plan state: ${(created.data.basePlans || [])[0] && created.data.basePlans[0].state}`);
    await ap.monetization.subscriptions.basePlans.activate({
      packageName: PKG, productId: plan.productId, basePlanId: BASE_PLAN_ID,
      requestBody: { latencyTolerance: 'PRODUCT_UPDATE_LATENCY_TOLERANCE_LATENCY_SENSITIVE' },
    });
    console.log('    ACTIVATED — base plan is now sellable to new subscribers.');
  }

  console.log('\n=== SUMMARY ===');
  if (COMMIT) {
    console.log('Products were written to the live Play listing. NOBODY has been charged — a Play');
    console.log('subscription only takes money when a real user completes a purchase.');
  } else {
    console.log(`Nothing was written. Would create ${wouldCreate} subscription(s) and activate ${wouldActivate} existing base plan(s).`);
    console.log(`${blockers.length} blocker(s), ${warnings.length} warning(s).`);
    console.log('\nTo actually create these products, once every blocker is cleared:');
    console.log('  PLAY_COMMIT_ACK=1 PLAY_MERCHANT_ACK=1 node tools/create-play-subscriptions.js --commit');
    console.log('\nThat command creates catalogue entries and activates their base plans. It charges');
    console.log('nothing, refunds nothing, grants no user a subscription, and publishes no release.');
  }
}

main().catch((e) => {
  const g = (e && e.response && e.response.data) || null;
  console.error('\nFAILED:', g ? JSON.stringify(g, null, 2) : (e && e.message) || e);
  process.exit(1);
});
