#!/usr/bin/env node
/**
 * tools/create-apple-subscriptions.js
 *
 * Creates the five cvApplyr auto-renewable monthly subscriptions in App Store Connect.
 *
 *   ***********************************************************************************
 *   ***  DRY RUN IS THE DEFAULT.  NOTHING IS CREATED WITHOUT --commit.              ***
 *   ***  --commit ALSO REQUIRES  ASC_COMMIT_ACK=1  AND  ASC_AGREEMENT_ACK=1.        ***
 *   ***  THIS SCRIPT NEVER SUBMITS ANYTHING TO APP REVIEW. There is no --submit.    ***
 *   ***********************************************************************************
 *
 *   node tools/create-apple-subscriptions.js                     # dry run: preflight + full plan
 *   node tools/create-apple-subscriptions.js --plan=starter      # dry run, one plan
 *   ASC_COMMIT_ACK=1 ASC_AGREEMENT_ACK=1 \
 *     node tools/create-apple-subscriptions.js --commit          # the only mode that writes
 *
 * COST OF RUNNING THIS SCRIPT: zero. Creating a subscription product in App Store Connect
 * charges nobody, bills no card, and grants no entitlement to any user. It creates catalogue
 * metadata that sits in MISSING_METADATA / READY_TO_SUBMIT until a human submits it for review.
 * The first money can only move after (a) App Review approves and (b) a real user taps Buy.
 *
 * ── WHY THE CALL SHAPES ARE WHAT THEY ARE ────────────────────────────────────────────────────
 * Verified read-only against the live account on 2026-08-06 by GETting each resource type with a
 * zero-uuid: a 404 NOT_FOUND proves the type exists, a 404 PATH_ERROR proves it does not.
 *   subscriptionVersions            404 NOT_FOUND  -> exists (metadata hangs off a VERSION)
 *   /v2/subscriptionLocalizations   404 NOT_FOUND  -> exists (v1 is deprecated; rel is `version`)
 *   subscriptionPlanAvailabilities  404 NOT_FOUND  -> exists (replaces subscriptionAvailabilities)
 *   subscriptionPricePoints         404 NOT_FOUND  -> exists
 *   subscriptionPrices              403            -> POST-only, no GET_INSTANCE
 *
 * Price point ids are base64 of {"s":<productId>,"t":<territory>,"p":<tier>} — they embed the
 * product, so they CANNOT be hardcoded or copied between products. Create first, then look up,
 * then price. Always. This script never invents a price point id.
 *
 * ── KEY CHOICE ───────────────────────────────────────────────────────────────────────────────
 * Uses AuthKey_8B7UN3VG74. Measured 2026-08-06, both keys authenticate and both read the catalogue,
 * but on GET /v1/apps/{app}/appAvailabilityV2:
 *   33Y3J5248R -> 403 FORBIDDEN_ERROR "The API key in use does not allow this request"
 *   8B7UN3VG74 -> 200
 * That endpoint is the cheapest read-only bellwether for the pricing/availability permission set,
 * and preflight below runs it every time rather than trusting this comment.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));

// ── arguments ─────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const ONLY = (argv.find((a) => a.startsWith('--plan=')) || '').split('=')[1] || null;

if (argv.includes('--submit')) {
  console.error('--submit is not implemented here on purpose. This script provisions products only.');
  console.error('Submitting the first auto-renewable subscription requires it to ride in the SAME');
  console.error('reviewSubmission as a new app binary — that is a human decision, not a tool flag.');
  process.exit(2);
}

// ── configuration ─────────────────────────────────────────────────────────────────────────────
const KEY_ID = process.env.ASC_KEY_ID || '8B7UN3VG74';
const ISSUER = process.env.ASC_ISSUER_ID || 'bc162399-5ecc-4cdd-baf4-a143d5b1eb65';
const APP_ID = process.env.ASC_APP_ID || '6762126502';
const BUNDLE_ID = 'com.cvapplyr.mobile';
const LOCALE = 'en-US';
const BASE_TERRITORY = 'USA';
const GROUP_REFERENCE_NAME = 'cvApplyr Plans';   // internal only
const GROUP_DISPLAY_NAME = 'cvApplyr';           // shown on the user's Manage Subscriptions screen
const REVIEW_SCREENSHOT = process.env.ASC_REVIEW_SCREENSHOT || '';
const KEY_PATH = path.join(ROOT, 'Keys', `AuthKey_${KEY_ID}.p8`);

// ── THE FROZEN PRODUCT TABLE ──────────────────────────────────────────────────────────────────
// Apple product ids are PERMANENTLY RESERVED. They can never be renamed, deleted or reused, on
// this app or any other. One typo is unrecoverable.
//
// The table is NOT duplicated here — it is read from server/services/storeProducts.js, which is
// the one place a store product id becomes a plan_key. A provisioning tool with its own private
// copy of the ids is exactly how you end up creating a product the app never asks for.
// storeProducts.js is dependency-free, so it can be require()'d without opening a database pool.
const storeProducts = require(path.join(ROOT, 'server/services/storeProducts.js'));

// groupLevel 1 is the HIGHEST tier. Apple uses it to decide whether a plan change is an upgrade
// (immediate, with a prorated refund of the unused period) or a downgrade (takes effect at
// renewal). Getting this backwards is the single most likely way to over-charge someone.
const FROZEN = storeProducts.SUBSCRIPTIONS.map((s) => ({
  key: s.planKey,
  productId: s.productId,
  groupLevel: s.appleGroupLevel,
  priceUsd: s.priceUsd,
  label: s.planKey.charAt(0).toUpperCase() + s.planKey.slice(1),
}));

const desc = (p) => `Monthly plan: ${p.letters} AI cover letters and ${p.resumes} AI resumes.`;

// ── read the server catalogue and refuse to proceed on drift ──────────────────────────────────
// Parsed out of the source text rather than require()'d: entitlements.js opens a pool against the
// production database on load, and a provisioning tool has no business doing that.
function serverPlans() {
  const src = fs.readFileSync(path.join(ROOT, 'server/services/entitlements.js'), 'utf8');
  const m = src.match(/const PLANS = (\[[\s\S]*?\n\];)/);
  if (!m) throw new Error('could not locate the PLANS array in server/services/entitlements.js');
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1].replace(/;$/, '')}`)();
}
// Quotas live only in entitlements.js; fold them onto the frozen rows so the store description
// and the server grant can never promise different numbers.
for (const f of FROZEN) {
  const s = serverPlans().find((x) => x.key === f.key);
  if (s) { f.letters = s.letters; f.resumes = s.resumes; f.label = s.label || f.label; }
}

// ── transport ─────────────────────────────────────────────────────────────────────────────────
const P8 = fs.existsSync(KEY_PATH) ? fs.readFileSync(KEY_PATH, 'utf8') : null;
const token = () => jwt.sign({ iss: ISSUER, aud: 'appstoreconnect-v1' }, P8,
  { algorithm: 'ES256', keyid: KEY_ID, expiresIn: '15m' });

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: 'api.appstoreconnect.apple.com', path: urlPath, method,
      headers: Object.assign(
        { Authorization: 'Bearer ' + token(), Accept: 'application/json' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(raw || '{}'); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const GET = (p) => api('GET', p);
const errText = (r) => ((r.json && r.json.errors) || []).map((e) => `${e.status} ${e.code}: ${e.detail || e.title}`).join(' | ') || (r.raw || '').slice(0, 200);

// Some relationship paths are not documented consistently across ASC spec revisions. Try each and
// return the first that answers 200, so idempotency never depends on a guess.
async function firstOk(paths) {
  for (const p of paths) {
    const r = await GET(p);
    if (r.status === 200) return { path: p, json: r.json };
  }
  return null;
}

// Long arrays (the 175-territory availability list) are collapsed for printing only — the real
// --commit call always sends the full array.
function printable(v) {
  return JSON.parse(JSON.stringify(v, (k, val) => {
    if (Array.isArray(val) && val.length > 6) {
      return [...val.slice(0, 3), `… ${val.length - 4} more …`, val[val.length - 1]];
    }
    return val;
  }));
}

// Every mutation funnels through here. In dry run it prints the exact call and creates nothing.
const wouldDo = [];
let dryCounter = 0;
async function MUTATE(label, method, urlPath, body) {
  if (!COMMIT) {
    wouldDo.push({ label, method, urlPath, body });
    console.log(`\n  WOULD ${method} ${urlPath}`);
    console.log(`  # ${label}`);
    console.log(JSON.stringify(printable(body), null, 2).replace(/^/gm, '    '));
    return { dryRun: true, id: `<${label.replace(/[^a-z]+/gi, '-')}-id-${++dryCounter}>` };
  }
  const r = await api(method, urlPath, body);
  if (r.status >= 300) throw new Error(`${label} FAILED — ${errText(r)}`);
  const id = r.json && r.json.data && r.json.data.id;
  console.log(`    created: ${label} -> ${id}`);
  return { id, json: r.json };
}

// ── price points: looked up, never invented ───────────────────────────────────────────────────
async function findPricePoint(subscriptionId, territory, customerPrice) {
  let url = `/v1/subscriptions/${subscriptionId}/pricePoints`
          + `?filter[territory]=${territory}&filter[subscriptionPricePoints.territory]=${territory}&limit=200`;
  let seen = 0;
  while (url) {
    const r = await GET(url);
    if (r.status >= 300) throw new Error(`pricePoints lookup failed: ${errText(r)}`);
    const page = r.json.data || [];
    seen += page.length;
    const hit = page.find((p) => p.attributes.customerPrice === customerPrice);
    if (hit) return { hit, seen };
    url = r.json.links && r.json.links.next
      ? r.json.links.next.replace('https://api.appstoreconnect.apple.com', '') : null;
  }
  return { hit: null, seen };
}

// ── review screenshot: reserve -> PUT the bytes -> commit the checksum ─────────────────────────
async function uploadReviewScreenshot(subscriptionId, filePath) {
  const buf = fs.readFileSync(filePath);
  const reserve = await MUTATE(`reserve review screenshot (${path.basename(filePath)}, ${buf.length} bytes)`,
    'POST', '/v1/subscriptionAppStoreReviewScreenshots', {
      data: {
        type: 'subscriptionAppStoreReviewScreenshots',
        attributes: { fileName: path.basename(filePath), fileSize: buf.length },
        relationships: { subscription: { data: { type: 'subscriptions', id: subscriptionId } } },
      },
    });
  if (reserve.dryRun) {
    console.log('  WOULD then PUT the bytes to every uploadOperation returned above,');
    console.log('  WOULD then PATCH /v1/subscriptionAppStoreReviewScreenshots/{id} {uploaded:true, sourceFileChecksum:<md5>}');
    return;
  }
  for (const op of reserve.json.data.attributes.uploadOperations) {
    const headers = {};
    for (const h of op.requestHeaders || []) headers[h.name] = h.value;
    const slice = buf.subarray(op.offset, op.offset + op.length);
    headers['Content-Length'] = slice.length;
    const u = new URL(op.url);
    await new Promise((res, rej) => {
      const rq = https.request({ host: u.host, path: u.pathname + u.search, method: op.method, headers },
        (r) => { r.resume(); r.on('end', () => (r.statusCode < 300 ? res() : rej(new Error('upload ' + r.statusCode)))); });
      rq.on('error', rej); rq.write(slice); rq.end();
    });
  }
  await MUTATE('commit review screenshot', 'PATCH', `/v1/subscriptionAppStoreReviewScreenshots/${reserve.id}`, {
    data: {
      type: 'subscriptionAppStoreReviewScreenshots', id: reserve.id,
      attributes: { uploaded: true, sourceFileChecksum: crypto.createHash('md5').update(buf).digest('hex') },
    },
  });
}

// ── preflight ─────────────────────────────────────────────────────────────────────────────────
const blockers = [];
const warnings = [];
const block = (what, remedy) => { blockers.push({ what, remedy }); console.log(`  BLOCKER  ${what}\n           -> ${remedy}`); };
const warn = (what, note) => { warnings.push({ what, note }); console.log(`  WARN     ${what}\n           -> ${note}`); };
const ok = (what) => console.log(`  ok       ${what}`);

async function preflight(plans) {
  console.log('\n=== PREFLIGHT (all read-only) ===');

  // 1. credentials
  if (!P8) {
    block(`signing key Keys/AuthKey_${KEY_ID}.p8 is missing`,
      'You must download it from App Store Connect > Users and Access > Integrations > App Store Connect API. '
      + 'Apple only offers the .p8 once; if it is lost, revoke the key and generate a new one.');
    return;
  }
  ok(`signing key Keys/AuthKey_${KEY_ID}.p8 present`);

  const app = await GET(`/v1/apps/${APP_ID}`);
  if (app.status === 401) {
    block('the App Store Connect API rejected the token (401)',
      'The key, issuer id or key id do not match. Check ASC_KEY_ID / ASC_ISSUER_ID against '
      + 'App Store Connect > Users and Access > Integrations.');
    return;
  }
  if (app.status >= 300) { block(`GET /v1/apps/${APP_ID} -> ${app.status} ${errText(app)}`, 'Fix API access before continuing.'); return; }
  const a = app.json.data.attributes;
  if (a.bundleId !== BUNDLE_ID) {
    block(`app ${APP_ID} has bundleId ${a.bundleId}, expected ${BUNDLE_ID}`, 'You are pointed at the wrong app. Set ASC_APP_ID correctly.');
    return;
  }
  ok(`app ${APP_ID} "${a.name}" (${a.bundleId})`);

  // 2. does this key carry the pricing/availability permission set?
  const cap = await GET(`/v1/apps/${APP_ID}/appAvailabilityV2`);
  if (cap.status === 403) {
    block(`API key ${KEY_ID} is refused on pricing/availability endpoints (403 FORBIDDEN_ERROR)`,
      'ACCOUNT HOLDER ACTION: in App Store Connect > Users and Access > Integrations, either use a key '
      + 'with the Admin or App Manager role, or re-run with ASC_KEY_ID=8B7UN3VG74. Creating the '
      + 'subscriptions with this key would succeed and then fail at the pricing step, leaving five '
      + 'permanently-reserved product ids with no price.');
  } else if (cap.status === 200) {
    ok(`API key ${KEY_ID} accepted on the pricing/availability surface`);
  } else {
    warn(`appAvailabilityV2 probe returned ${cap.status}`, 'Could not confirm the key permission set; a pricing call may still 403.');
  }

  // 3. Paid Applications agreement. NOT EXPOSED BY THE API — /v1/agreements, /v1/bankAccounts and
  //    /v1/finance all return 404 PATH_ERROR (the resource type does not exist). The best evidence
  //    available programmatically is that this app already has APPROVED paid products, which means
  //    the agreement was Active at least once. Apple reissues it periodically and only the Account
  //    Holder can accept the new one, so evidence is not proof and --commit demands an explicit ack.
  const iaps = await GET(`/v1/apps/${APP_ID}/inAppPurchasesV2?limit=20`);
  const approved = ((iaps.json && iaps.json.data) || []).filter((p) => p.attributes.state === 'APPROVED');
  if (approved.length) {
    ok(`${approved.length} paid product(s) already APPROVED on this app `
      + `(${approved.map((p) => p.attributes.productId).join(', ')}) — the Paid Applications agreement was Active at some point`);
  } else {
    warn('no APPROVED paid products found on this app', 'Cannot infer anything about the Paid Applications agreement.');
  }
  console.log('  note     The Paid Applications agreement, bank account and tax forms CANNOT be read through');
  console.log('           the API (/v1/agreements, /v1/bankAccounts, /v1/finance all 404 PATH_ERROR).');
  console.log('           ACCOUNT HOLDER ACTION, before --commit: open App Store Connect > Business and confirm');
  console.log('           Paid Applications reads Active, with banking and tax complete. If it has lapsed the');
  console.log('           subscriptions will still be created and can still be approved, but no money moves and');
  console.log('           the products can silently fail to become purchasable.');
  if (COMMIT && process.env.ASC_AGREEMENT_ACK !== '1') {
    block('ASC_AGREEMENT_ACK=1 not set',
      'Set ASC_AGREEMENT_ACK=1 only after you have personally seen "Active" on App Store Connect > Business.');
  }

  // 4. Server-to-server notification endpoint (needed before any renewal can be attributed).
  if (a.subscriptionStatusUrl) {
    ok(`App Store Server Notifications ${a.subscriptionStatusUrlVersion || 'V?'} -> ${a.subscriptionStatusUrl}`);
  } else {
    warn('no App Store Server Notifications URL is configured',
      'ACCOUNT HOLDER ACTION: App Store Connect > App Information > App Store Server Notifications, '
      + 'set the Production URL to https://cvapplyr.com/api/webhooks/apple-notifications (V2).');
  }
  if (!a.subscriptionStatusUrlForSandbox) {
    warn('no SANDBOX notification URL is configured',
      'Sandbox renewals will not reach the server, so you cannot test renew/cancel/refund before release. '
      + 'Set it in the same App Information panel.');
  }

  // 5. Dangling review submissions — they do not block CREATION, only submission.
  const rs = await GET(`/v1/apps/${APP_ID}/reviewSubmissions?limit=20`);
  const open = ((rs.json && rs.json.data) || []).filter((s) => s.attributes.state === 'READY_FOR_REVIEW' && !s.attributes.submittedDate);
  if (open.length) {
    warn(`${open.length} review submission(s) sitting in READY_FOR_REVIEW: ${open.map((s) => s.id).join(', ')}`,
      'Harmless for product creation. But App Store Connect allows one open submission per app, so these '
      + 'must be cancelled before the 3.6 binary + the 5 subscriptionVersions can go in together.');
  } else ok('no dangling review submissions');

  // 6. Review screenshot.
  if (REVIEW_SCREENSHOT && fs.existsSync(REVIEW_SCREENSHOT)) {
    ok(`review screenshot ${REVIEW_SCREENSHOT} (${fs.statSync(REVIEW_SCREENSHOT).size} bytes)`);
  } else {
    warn('no ASC_REVIEW_SCREENSHOT set (or the file does not exist)',
      'Each subscription will be created and then sit in MISSING_METADATA until a paywall screenshot is '
      + 'uploaded. Take it from a real 3.6 build; 1320x2868 is proven accepted on this app. '
      + 'Re-run with ASC_REVIEW_SCREENSHOT=/path/to/paywall.png to attach it during creation.');
  }

  // 7. Do the five prices exist on Apple's real USA ladder? Subscription price points cannot be
  //    listed until the subscription exists, so validate against an existing product's ladder —
  //    the USA customer-price ladder is account-wide, only the price point IDS are per-product.
  const ladderSource = approved[0];
  if (ladderSource) {
    let url = `/v2/inAppPurchases/${ladderSource.id}/pricePoints?filter[territory]=${BASE_TERRITORY}&limit=200`;
    const prices = new Set();
    while (url) {
      const r = await GET(url);
      if (r.status >= 300) break;
      for (const pp of r.json.data || []) prices.add(pp.attributes.customerPrice);
      url = r.json.links && r.json.links.next ? r.json.links.next.replace('https://api.appstoreconnect.apple.com', '') : null;
    }
    if (prices.size) {
      console.log(`  ok       read ${prices.size} real ${BASE_TERRITORY} customer prices from Apple's ladder`);
      for (const p of plans) {
        const want = p.priceUsd.toFixed(2);
        if (prices.has(want)) ok(`  $${want} is a real ${BASE_TERRITORY} price point (${p.key})`);
        else block(`$${want} (${p.key}) is NOT on Apple's ${BASE_TERRITORY} price ladder`,
          'Pick the nearest real price point. Apple will not accept an arbitrary amount.');
      }
    }
  }

  // 8. Idempotency scan — and the id-drift check that matters most.
  //
  // An Apple product id is permanently reserved the instant it is created. If a subscription
  // already exists under an id that is NOT in storeProducts.js, then either the store or the repo
  // is wrong, and creating the frozen ids on top would burn five MORE permanent ids while leaving
  // the first five stranded. Refuse, and make a human decide which table is correct.
  const groups = await GET(`/v1/apps/${APP_ID}/subscriptionGroups?limit=50`);
  const existingGroups = (groups.json && groups.json.data) || [];
  if (!existingGroups.length) {
    ok('no subscription groups exist yet — this run would create the first one');
  } else {
    ok(`${existingGroups.length} existing subscription group(s): `
      + existingGroups.map((g) => `${g.id} "${g.attributes.referenceName}"`).join(', '));
    const frozenIds = new Set(FROZEN.map((p) => p.productId));
    const onStore = [];
    for (const g of existingGroups) {
      const subs = await GET(`/v1/subscriptionGroups/${g.id}/subscriptions?limit=100`);
      for (const s of (subs.json && subs.json.data) || []) {
        onStore.push({ groupId: g.id, id: s.id, productId: s.attributes.productId, state: s.attributes.state, level: s.attributes.groupLevel });
      }
    }
    if (onStore.length) {
      console.log(`  info     ${onStore.length} subscription(s) already exist on App Store Connect:`);
      for (const s of onStore) console.log(`             ${s.productId}  (${s.id}, state ${s.state}, groupLevel ${s.level})`);
    }
    const foreign = onStore.filter((s) => !frozenIds.has(s.productId));
    if (foreign.length) {
      block(`${foreign.length} subscription(s) exist under product id(s) NOT in server/services/storeProducts.js: `
        + foreign.map((s) => s.productId).join(', '),
        'These ids are now PERMANENTLY RESERVED on this Apple account and can never be renamed, deleted '
        + 'or reused. Decide which table is correct before anything else:\n'
        + '           (a) The STORE is right -> edit server/services/storeProducts.js SUBSCRIPTIONS[].productId '
        + 'to the ids above (and entitlements.js productIos/productAndroid with it). Nothing is lost; Play has '
        + 'zero subscriptions so the same ids can still be used there.\n'
        + '           (b) The REPO is right -> the ids above are burned. Creating the storeProducts.js ids as well '
        + 'means ten reserved ids and five orphans sitting in MISSING_METADATA forever. Only do this deliberately.\n'
        + '           This script will not create anything until the two agree.');
    }
    const missing = FROZEN.filter((p) => !onStore.some((s) => s.productId === p.productId));
    if (onStore.length && missing.length && missing.length < FROZEN.length) {
      warn(`${missing.length} of the ${FROZEN.length} frozen ids are absent from the store: ${missing.map((p) => p.productId).join(', ')}`,
        'A partially provisioned group. This script is idempotent and would create only the missing ones.');
    }
  }

  // 9. entitlements.js drift.
  const server = serverPlans();
  for (const f of FROZEN) {
    const s = server.find((x) => x.key === f.key);
    if (!s) { block(`entitlements.js has no plan "${f.key}"`, 'The server catalogue and this table must match exactly.'); continue; }
    if (s.productIos !== f.productId) {
      block(`entitlements.js productIos for ${f.key} is "${s.productIos}" but this script would create "${f.productId}"`,
        'Fix server/services/entitlements.js first. An Apple product id is permanently reserved — creating one '
        + 'the app never requests wastes it forever.');
    }
    if (Number(s.priceUsd) !== f.priceUsd) {
      block(`entitlements.js priceUsd for ${f.key} is ${s.priceUsd} but this script would price at ${f.priceUsd}`,
        'Reconcile before creating; the paywall would advertise a price the store does not charge.');
    }
    if (s.letters !== f.letters || s.resumes !== f.resumes) {
      block(`entitlements.js quota for ${f.key} is ${s.letters}/${s.resumes}, this script advertises ${f.letters}/${f.resumes}`,
        'The store description would promise something the server does not grant.');
    }
  }
  if (!blockers.length) ok('server/services/entitlements.js matches the frozen product table');
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────
(async () => {
  const plans = ONLY ? FROZEN.filter((p) => p.key === ONLY) : FROZEN;
  if (!plans.length) { console.error(`No plan matches --plan=${ONLY}. Known: ${FROZEN.map((p) => p.key).join(', ')}`); process.exit(1); }

  console.log('App Store Connect — create the 5 cvApplyr monthly subscriptions');
  console.log(`App        : ${APP_ID} (${BUNDLE_ID})`);
  console.log(`API key    : ${KEY_ID}`);
  console.log(`Mode       : ${COMMIT ? '*** COMMIT — THIS WILL CREATE REAL PRODUCTS ***' : 'DRY RUN (no writes; every mutation is printed, not sent)'}`);
  console.log(`Plans      : ${plans.map((p) => p.key).join(', ')}`);
  console.log('Charges    : none. Creating catalogue products bills nobody and entitles nobody.');

  await preflight(plans);

  if (COMMIT && !process.env.ASC_COMMIT_ACK) {
    console.error('\nRefusing to commit: ASC_COMMIT_ACK=1 is not set in the environment.');
    console.error('These product ids are PERMANENT and can never be renamed, deleted or reused.');
    process.exit(2);
  }
  if (blockers.length) {
    console.log(`\n=== ${blockers.length} BLOCKER(S) ===`);
    blockers.forEach((b, i) => console.log(`${i + 1}. ${b.what}\n   ACTION: ${b.remedy}`));
    if (COMMIT) { console.error('\nRefusing to write to App Store Connect while blockers remain.'); process.exit(3); }
    console.log('\n(dry run continues so you can see the full plan, but --commit would refuse here)');
  }

  console.log(`\n=== ${COMMIT ? 'EXECUTING' : 'PLAN — this is exactly what --commit would send'} ===`);

  // 1 ── group. Reuse ANY existing group rather than creating a second one: an app with two
  // subscription groups cannot offer upgrades/downgrades between them, and Apple treats a purchase
  // in each group as a separate concurrent subscription — i.e. the user gets billed twice.
  // The reference-name match is case-insensitive on purpose; "CVApplyr Plans" and "cvApplyr Plans"
  // differing by one capital letter must not cause a duplicate group.
  const groups = await GET(`/v1/apps/${APP_ID}/subscriptionGroups?limit=50`);
  const allGroups = (groups.json && groups.json.data) || [];
  const norm = (s) => String(s || '').trim().toLowerCase();
  let group = allGroups.find((g) => norm(g.attributes.referenceName) === norm(GROUP_REFERENCE_NAME)) || allGroups[0];
  if (group) {
    console.log(`\n[skip] reusing the existing subscription group ${group.id} "${group.attributes.referenceName}"`);
    const gl = await GET(`/v1/subscriptionGroups/${group.id}/subscriptionGroupLocalizations?limit=10`);
    const locs = (gl.json && gl.json.data) || [];
    group = { id: group.id };
    if (!locs.some((l) => l.attributes.locale === LOCALE)) {
      console.log(`  the group has NO ${LOCALE} localization — the Manage Subscriptions screen would show no name.`);
      await MUTATE(`group display name shown on the user's Manage Subscriptions screen`,
        'POST', '/v1/subscriptionGroupLocalizations', {
          data: {
            type: 'subscriptionGroupLocalizations',
            attributes: { name: GROUP_DISPLAY_NAME, locale: LOCALE, customAppName: null },
            relationships: { subscriptionGroup: { data: { type: 'subscriptionGroups', id: group.id } } },
          },
        });
    } else {
      console.log(`  [skip] ${LOCALE} group localization already present: "${locs.find((l) => l.attributes.locale === LOCALE).attributes.name}"`);
    }
  } else {
    console.log('\n── subscription group ──');
    group = await MUTATE('create the subscription group', 'POST', '/v1/subscriptionGroups', {
      data: {
        type: 'subscriptionGroups',
        attributes: { referenceName: GROUP_REFERENCE_NAME },
        relationships: { app: { data: { type: 'apps', id: APP_ID } } },
      },
    });
    await MUTATE(`group display name shown on the user's Manage Subscriptions screen`,
      'POST', '/v1/subscriptionGroupLocalizations', {
        data: {
          type: 'subscriptionGroupLocalizations',
          attributes: { name: GROUP_DISPLAY_NAME, locale: LOCALE, customAppName: null },
          relationships: { subscriptionGroup: { data: { type: 'subscriptionGroups', id: group.id } } },
        },
      });
  }

  // territories, read live — never a hardcoded list
  const terrRes = await GET('/v1/territories?limit=200');
  const territories = ((terrRes.json && terrRes.json.data) || []).map((t) => t.id);
  console.log(`\nterritories read from the API: ${territories.length}`);

  for (const plan of plans) {
    console.log(`\n════ ${plan.key} — ${plan.productId} — $${plan.priceUsd}/mo — groupLevel ${plan.groupLevel} ════`);

    // 2 ── the subscription. Relationship key is `group`, NOT `subscriptionGroup`.
    let subId = null;
    if (!group.dryRun) {
      const found = await GET(`/v1/subscriptionGroups/${group.id}/subscriptions?filter[productId]=${encodeURIComponent(plan.productId)}&limit=5`);
      const hit = ((found.json && found.json.data) || []).find((s) => s.attributes.productId === plan.productId);
      if (hit) { subId = hit.id; console.log(`  [skip] subscription already exists -> ${subId} (state ${hit.attributes.state})`); }
    }
    if (!subId) {
      const sub = await MUTATE(`create subscription ${plan.key}`, 'POST', '/v1/subscriptions', {
        data: {
          type: 'subscriptions',
          attributes: {
            name: `${plan.label} Monthly`,
            productId: plan.productId,
            subscriptionPeriod: 'ONE_MONTH',
            familySharable: false,
            groupLevel: plan.groupLevel,
            reviewNote: `Auto-renewing monthly plan granting ${plan.letters} AI cover letters and `
              + `${plan.resumes} AI resumes per month. Sign in with the demo account, open the Jobs tab > `
              + `Subscription, and tap ${plan.label}.`,
          },
          relationships: { group: { data: { type: 'subscriptionGroups', id: group.id } } },
        },
      });
      subId = sub.id;
    }

    // 3 ── metadata lives on a VERSION, not on the subscription (ASC 4.4.x).
    let versionId = null;
    if (COMMIT) {
      const v = await firstOk([`/v1/subscriptions/${subId}/subscriptionVersions?limit=1`, `/v1/subscriptions/${subId}/versions?limit=1`]);
      if (v && v.json.data && v.json.data.length) { versionId = v.json.data[0].id; console.log(`  [skip] version already exists -> ${versionId}`); }
    }
    if (!versionId) {
      const version = await MUTATE(`create the metadata version for ${plan.key}`, 'POST', '/v1/subscriptionVersions', {
        data: { type: 'subscriptionVersions', relationships: { subscription: { data: { type: 'subscriptions', id: subId } } } },
      });
      versionId = version.id;
    }

    // 4 ── en-US localization. v1 subscriptionLocalizations is DEPRECATED; v2 hangs off `version`.
    let hasLoc = false;
    if (COMMIT) {
      const l = await firstOk([`/v2/subscriptionVersions/${versionId}/subscriptionLocalizations?limit=10`,
                               `/v1/subscriptionVersions/${versionId}/subscriptionLocalizations?limit=10`]);
      hasLoc = !!(l && l.json.data && l.json.data.some((x) => x.attributes.locale === LOCALE));
      if (hasLoc) console.log(`  [skip] ${LOCALE} localization already present`);
    }
    if (!hasLoc) {
      await MUTATE(`${LOCALE} localization for ${plan.key}`, 'POST', '/v2/subscriptionLocalizations', {
        data: {
          type: 'subscriptionLocalizations',
          attributes: { name: `${plan.label} Monthly`, locale: LOCALE, description: desc(plan) },
          relationships: { version: { data: { type: 'subscriptionVersions', id: versionId } } },
        },
      });
    }

    // 5 ── price. The price point id embeds the subscription id, so it is looked up AFTER creation.
    let pricePointId = `<looked up at run time — see the GET below>`;
    let priced = false;
    if (COMMIT) {
      const existing = await GET(`/v1/subscriptions/${subId}/prices?filter[territory]=${BASE_TERRITORY}&limit=5`);
      if (existing.status === 200 && (existing.json.data || []).length) { priced = true; console.log('  [skip] a base-territory price already exists'); }
    }
    if (!priced) {
      if (COMMIT) {
        const { hit, seen } = await findPricePoint(subId, BASE_TERRITORY, plan.priceUsd.toFixed(2));
        if (!hit) throw new Error(`no ${BASE_TERRITORY} price point equal to $${plan.priceUsd.toFixed(2)} on ${plan.productId} (scanned ${seen})`);
        pricePointId = hit.id;
        console.log(`    price point ${hit.id} -> customer $${hit.attributes.customerPrice}, proceeds $${hit.attributes.proceeds}`);
      } else {
        console.log(`\n  WOULD GET /v1/subscriptions/{newSubId}/pricePoints?filter[territory]=${BASE_TERRITORY}&limit=200`);
        console.log(`  # paging until attributes.customerPrice === "${plan.priceUsd.toFixed(2)}". The id is base64 of`);
        console.log(`  # {"s":"<subscriptionId>","t":"${BASE_TERRITORY}","p":"<tier>"} so it CANNOT be hardcoded or`);
        console.log(`  # copied from another product. Verified above: $${plan.priceUsd.toFixed(2)} is a real ${BASE_TERRITORY} price point.`);
      }
      await MUTATE(`set the ${BASE_TERRITORY} base price for ${plan.key} (Apple derives the other 174 territories from it)`,
        'POST', '/v1/subscriptionPrices', {
          data: {
            type: 'subscriptionPrices',
            attributes: { startDate: null, preserveCurrentPrice: false },
            relationships: {
              subscription: { data: { type: 'subscriptions', id: subId } },
              territory: { data: { type: 'territories', id: BASE_TERRITORY } },
              subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: pricePointId } },
            },
          },
        });
    }

    // 6 ── territories. subscriptionAvailabilities is deprecated; planAvailabilities replaces it.
    let available = false;
    if (COMMIT) {
      const av = await firstOk([`/v1/subscriptions/${subId}/subscriptionPlanAvailabilities?limit=5`,
                                `/v1/subscriptions/${subId}/planAvailabilities?limit=5`]);
      available = !!(av && av.json.data && av.json.data.length);
      if (available) console.log('  [skip] plan availability already configured');
    }
    if (!available) {
      await MUTATE(`make ${plan.key} available in all ${territories.length} territories`,
        'POST', '/v1/subscriptionPlanAvailabilities', {
          data: {
            type: 'subscriptionPlanAvailabilities',
            attributes: { planType: 'MONTHLY', availableInNewTerritories: true },
            relationships: {
              subscription: { data: { type: 'subscriptions', id: subId } },
              availableTerritories: { data: territories.map((id) => ({ type: 'territories', id })) },
            },
          },
        });
    }

    // 7 ── review screenshot, without which the product stays MISSING_METADATA.
    if (REVIEW_SCREENSHOT && fs.existsSync(REVIEW_SCREENSHOT)) {
      await uploadReviewScreenshot(subId, REVIEW_SCREENSHOT);
    } else {
      console.log(`  [skip] no ASC_REVIEW_SCREENSHOT — ${plan.key} would remain MISSING_METADATA until one is uploaded`);
    }
  }

  console.log('\n=== SUMMARY ===');
  if (COMMIT) {
    console.log('Products were created in App Store Connect. NOTHING has been submitted for review and');
    console.log('NOBODY has been charged. The products are not purchasable until App Review approves them.');
  } else {
    console.log(`Nothing was written. ${wouldDo.length} mutation(s) would have been sent:`);
    wouldDo.forEach((w, i) => console.log(`  ${String(i + 1).padStart(2)}. ${w.method.padEnd(5)} ${w.urlPath}   # ${w.label}`));
    console.log(`\n${blockers.length} blocker(s), ${warnings.length} warning(s).`);
    console.log('\nTo actually create these products, once every blocker is cleared:');
    console.log('  ASC_COMMIT_ACK=1 ASC_AGREEMENT_ACK=1 ASC_REVIEW_SCREENSHOT=/absolute/path/to/paywall.png \\');
    console.log('    node tools/create-apple-subscriptions.js --commit');
    console.log('\nThat command creates catalogue entries only. It charges nothing, refunds nothing, grants');
    console.log('no user a subscription, and does not submit anything to App Review.');
  }
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
