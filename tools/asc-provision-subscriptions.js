#!/usr/bin/env node
/**
 * App Store Connect — provision the 5 auto-renewable subscriptions from entitlements.js.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  DRY RUN IS THE DEFAULT. Nothing is created unless you pass --commit.
 *  Even with --commit, nothing is SUBMITTED to App Review unless you ALSO pass --submit.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 *   node tools/asc-provision-subscriptions.js                 # print every payload, call nothing
 *   node tools/asc-provision-subscriptions.js --commit        # create group+subs+prices (NOT submitted)
 *   node tools/asc-provision-subscriptions.js --commit --submit   # ...and file the review submission
 *
 * Written against App Store Connect API OpenAPI spec 4.4.1.
 *
 * WHY THE SHAPE IS WHAT IT IS (verified against the live account, read-only, 2026-08-06):
 *   • Subscription metadata (localizations, promo image) now hangs off a subscriptionVersion, not
 *     the subscription. POST /v1/subscriptionLocalizations (v1) is DEPRECATED as of 4.4.1.
 *   • Review submission is reviewSubmissions + reviewSubmissionItems. POST /v1/subscriptionSubmissions
 *     is DEPRECATED as of 4.4.1.
 *   • Price points are PER SUBSCRIPTION — the price point id encodes the product id, so they cannot
 *     be looked up until the subscription resource exists, and they cannot be hardcoded.
 *   • subscriptionAvailabilities is DEPRECATED; use subscriptionPlanAvailabilities (planType MONTHLY).
 *
 * KEY CHOICE: use AuthKey_8B7UN3VG74. Key 33Y3J5248R is denied on pricing/availability endpoints
 * ("The API key in use does not allow this request") — see the audit notes.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const jwt = require('jsonwebtoken');

const ROOT = path.resolve(__dirname, '..');
const COMMIT = process.argv.includes('--commit');
const SUBMIT = process.argv.includes('--submit');

const KEY_ID = process.env.ASC_KEY_ID || '8B7UN3VG74';
const ISSUER = process.env.ASC_ISSUER_ID || 'bc162399-5ecc-4cdd-baf4-a143d5b1eb65';
const APP_ID = process.env.ASC_APP_ID || '6762126502';
const PRIMARY_LOCALE = 'en-US';
const BASE_TERRITORY = 'USA';
const GROUP_REFERENCE_NAME = 'cvapplyr Credits';
const GROUP_DISPLAY_NAME = 'cvapplyr';        // shown to users on the manage-subscription screen
// A PNG/JPG of the in-app paywall. Apple accepted 1320x2868 for this app's consumables.
const REVIEW_SCREENSHOT = process.env.ASC_REVIEW_SCREENSHOT || '';

const KEY = fs.readFileSync(path.join(ROOT, 'Keys', `AuthKey_${KEY_ID}.p8`), 'utf8');
const token = () => jwt.sign({ iss: ISSUER, aud: 'appstoreconnect-v1' }, KEY,
  { algorithm: 'ES256', keyid: KEY_ID, expiresIn: '15m' });

// ── the catalog, read straight from the server so the two can never drift ──────────────────────
// Parsed out of the source text rather than require()'d: entitlements.js pulls in db-config, and
// a provisioning tool has no business opening a pool against the production database.
const PLANS = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'server/services/entitlements.js'), 'utf8');
  const m = src.match(/const PLANS = (\[[\s\S]*?\n\];)/);
  if (!m) throw new Error('could not locate the PLANS array in server/services/entitlements.js');
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1].replace(/;$/, '')}`)();
})();
if (!Array.isArray(PLANS) || PLANS.length !== 5) {
  console.error('entitlements.js did not yield 5 PLANS — refusing to guess. Got:', PLANS && PLANS.length);
  process.exit(1);
}

// groupLevel 1 = highest tier. Apple ranks upgrade/downgrade by this, so Max must be level 1.
const LEVEL_BY_KEY = { max: 1, power: 2, pro: 3, plus: 4, starter: 5 };

const DESCRIPTIONS = {
  starter: 'Monthly plan: 30 AI cover letters and 5 AI resumes.',
  plus:    'Monthly plan: 100 AI cover letters and 10 AI resumes.',
  pro:     'Monthly plan: 150 AI cover letters and 15 AI resumes.',
  power:   'Monthly plan: 300 AI cover letters and 25 AI resumes.',
  max:     'Monthly plan: 1000 AI cover letters and 50 AI resumes.',
};

// ── transport ─────────────────────────────────────────────────────────────────────────────────
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

// Every mutation funnels through here. In dry run it prints and returns a fake id.
let dryCounter = 0;
async function MUTATE(label, method, urlPath, body) {
  if (!COMMIT) {
    console.log(`\n[DRY RUN] ${label}\n  ${method} ${urlPath}\n${JSON.stringify(body, null, 2).replace(/^/gm, '  ')}`);
    return { dryRun: true, id: `DRYRUN-${++dryCounter}` };
  }
  const r = await api(method, urlPath, body);
  if (r.status >= 300) {
    const detail = (r.json && r.json.errors || []).map((e) => `${e.status} ${e.code}: ${e.detail || e.title}`).join(' | ');
    throw new Error(`${label} FAILED — ${detail || r.raw.slice(0, 300)}`);
  }
  const id = r.json && r.json.data && r.json.data.id;
  console.log(`  ✓ ${label} → ${id}`);
  return { id, json: r.json };
}

// ── price points: must be LOOKED UP per subscription, per territory ────────────────────────────
// The id is base64 of {"s":<subscriptionId>,"t":<territory>,"p":<tier>} — it is not portable
// between products, which is exactly why this cannot be hardcoded.
async function findPricePoint(subscriptionId, territory, customerPrice) {
  let url = `/v1/subscriptions/${subscriptionId}/pricePoints`
          + `?filter[territory]=${territory}&filter[planType]=MONTHLY&limit=8000`;
  while (url) {
    const r = await GET(url);
    if (r.status >= 300) throw new Error(`pricePoints lookup failed: ${r.raw.slice(0, 200)}`);
    const hit = (r.json.data || []).find((p) => p.attributes.customerPrice === customerPrice);
    if (hit) return hit;
    url = r.json.links && r.json.links.next
      ? r.json.links.next.replace('https://api.appstoreconnect.apple.com', '') : null;
  }
  return null;
}

// ── review screenshot: reserve → upload to the returned URL → commit ───────────────────────────
async function uploadReviewScreenshot(subscriptionId, filePath) {
  const buf = fs.readFileSync(filePath);
  const reserve = await MUTATE('reserve review screenshot', 'POST', '/v1/subscriptionAppStoreReviewScreenshots', {
    data: {
      type: 'subscriptionAppStoreReviewScreenshots',
      attributes: { fileName: path.basename(filePath), fileSize: buf.length },
      relationships: { subscription: { data: { type: 'subscriptions', id: subscriptionId } } },
    },
  });
  if (reserve.dryRun) { console.log('  [DRY RUN] would then PUT the bytes to each uploadOperation, then PATCH uploaded:true'); return; }

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
  const md5 = require('crypto').createHash('md5').update(buf).digest('hex');
  await MUTATE('commit review screenshot', 'PATCH', `/v1/subscriptionAppStoreReviewScreenshots/${reserve.id}`, {
    data: { type: 'subscriptionAppStoreReviewScreenshots', id: reserve.id, attributes: { uploaded: true, sourceFileChecksum: md5 } },
  });
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log(COMMIT
    ? `!! COMMIT MODE — this WILL create real App Store Connect objects on app ${APP_ID}.`
    : `DRY RUN — printing payloads only. Re-run with --commit to actually create anything.`);
  console.log(SUBMIT ? '!! --submit given: a review submission WILL be filed.' : 'Review submission: NOT filed (pass --submit).');

  // Guard: refuse to run twice. A second group would be a mess to unwind.
  const existing = await GET(`/v1/apps/${APP_ID}/subscriptionGroups?limit=10`);
  if (existing.status >= 300) throw new Error('cannot read subscriptionGroups: ' + existing.raw.slice(0, 200));
  if ((existing.json.data || []).length) {
    console.error(`\nABORT: app already has ${existing.json.data.length} subscription group(s):`,
      existing.json.data.map((g) => `${g.id} "${g.attributes.referenceName}"`).join(', '));
    console.error('Refusing to create a second group. Delete or reuse the existing one.');
    process.exit(2);
  }

  // 1 ── the group, plus its user-visible name.
  const group = await MUTATE('create subscription group', 'POST', '/v1/subscriptionGroups', {
    data: {
      type: 'subscriptionGroups',
      attributes: { referenceName: GROUP_REFERENCE_NAME },
      relationships: { app: { data: { type: 'apps', id: APP_ID } } },
    },
  });

  await MUTATE('group localization (en-US)', 'POST', '/v1/subscriptionGroupLocalizations', {
    data: {
      type: 'subscriptionGroupLocalizations',
      attributes: { name: GROUP_DISPLAY_NAME, locale: PRIMARY_LOCALE, customAppName: null },
      relationships: { subscriptionGroup: { data: { type: 'subscriptionGroups', id: group.id } } },
    },
  });

  const created = [];
  for (const plan of PLANS) {
    console.log(`\n── ${plan.key} — ${plan.productIos} — $${plan.priceUsd}/mo ──`);

    // 2 ── the subscription itself. NB the relationship key is `group`, not `subscriptionGroup`.
    const sub = await MUTATE(`create subscription ${plan.key}`, 'POST', '/v1/subscriptions', {
      data: {
        type: 'subscriptions',
        attributes: {
          name: `${plan.label} Monthly`,
          productId: plan.productIos,
          subscriptionPeriod: 'ONE_MONTH',
          familySharable: false,
          groupLevel: LEVEL_BY_KEY[plan.key],
          reviewNote: `Monthly plan granting ${plan.letters} AI cover letters and ${plan.resumes} AI resumes. `
            + `Sign in with the demo account, open Settings > Subscription, and tap ${plan.label}.`,
        },
        relationships: { group: { data: { type: 'subscriptionGroups', id: group.id } } },
      },
    });

    // 3 ── metadata goes on a VERSION (4.4.1+), not on the subscription.
    const version = await MUTATE(`create version for ${plan.key}`, 'POST', '/v1/subscriptionVersions', {
      data: { type: 'subscriptionVersions', relationships: { subscription: { data: { type: 'subscriptions', id: sub.id } } } },
    });

    await MUTATE(`localization for ${plan.key}`, 'POST', '/v2/subscriptionLocalizations', {
      data: {
        type: 'subscriptionLocalizations',
        attributes: { name: `${plan.label} Monthly`, locale: PRIMARY_LOCALE, description: DESCRIPTIONS[plan.key] },
        relationships: { version: { data: { type: 'subscriptionVersions', id: version.id } } },
      },
    });

    // 4 ── price. Look the point up; never invent the id.
    if (COMMIT) {
      const pp = await findPricePoint(sub.id, BASE_TERRITORY, plan.priceUsd.toFixed(2));
      if (!pp) throw new Error(`no ${BASE_TERRITORY} price point for $${plan.priceUsd} on ${plan.productIos}`);
      console.log(`  price point ${pp.id} → customer $${pp.attributes.customerPrice}, proceeds $${pp.attributes.proceeds}`);
      await MUTATE(`price for ${plan.key}`, 'POST', '/v1/subscriptionPrices', {
        data: {
          type: 'subscriptionPrices',
          attributes: { startDate: null, preserveCurrentPrice: false },
          relationships: {
            subscription: { data: { type: 'subscriptions', id: sub.id } },
            territory: { data: { type: 'territories', id: BASE_TERRITORY } },
            subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: pp.id } },
          },
        },
      });
    } else {
      console.log(`\n[DRY RUN] look up price point (cannot be hardcoded — id embeds the subscription id)`
        + `\n  GET /v1/subscriptions/<newSubId>/pricePoints?filter[territory]=USA&filter[planType]=MONTHLY&limit=8000`
        + `\n  → pick the entry whose attributes.customerPrice === "${plan.priceUsd.toFixed(2)}"`);
      await MUTATE(`price for ${plan.key}`, 'POST', '/v1/subscriptionPrices', {
        data: {
          type: 'subscriptionPrices',
          attributes: { startDate: null, preserveCurrentPrice: false },
          relationships: {
            subscription: { data: { type: 'subscriptions', id: '<newSubId>' } },
            territory: { data: { type: 'territories', id: BASE_TERRITORY } },
            subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: '<pricePointId from the lookup above>' } },
          },
        },
      });
    }

    // 5 ── territories. subscriptionAvailabilities is deprecated; planAvailabilities replaces it.
    let territories = ['<all 175 territory ids>'];
    if (COMMIT) {
      const t = await GET('/v1/territories?limit=200');
      territories = (t.json.data || []).map((x) => x.id);
    }
    await MUTATE(`availability for ${plan.key}`, 'POST', '/v1/subscriptionPlanAvailabilities', {
      data: {
        type: 'subscriptionPlanAvailabilities',
        attributes: { planType: 'MONTHLY', availableInNewTerritories: true },
        relationships: {
          subscription: { data: { type: 'subscriptions', id: COMMIT ? sub.id : '<newSubId>' } },
          availableTerritories: { data: territories.map((id) => ({ type: 'territories', id })) },
        },
      },
    });

    // 6 ── review screenshot. Without it the subscription stays MISSING_METADATA.
    if (REVIEW_SCREENSHOT && fs.existsSync(REVIEW_SCREENSHOT)) {
      await uploadReviewScreenshot(COMMIT ? sub.id : '<newSubId>', REVIEW_SCREENSHOT);
    } else {
      console.log('  ! no ASC_REVIEW_SCREENSHOT set — subscription will sit in MISSING_METADATA until one is uploaded');
    }

    created.push({ plan, subId: sub.id, versionId: version.id });
  }

  // 7 ── review submission. Only with an explicit --submit.
  if (!SUBMIT) {
    console.log('\nStopping before App Review submission (no --submit).');
    console.log('Reminder: this app has never shipped an auto-renewable subscription, so the FIRST one');
    console.log('must go to review attached to a NEW app version + binary in the same reviewSubmission.');
    return;
  }

  const rs = await MUTATE('create review submission', 'POST', '/v1/reviewSubmissions', {
    data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: APP_ID } } } },
  });
  console.log('\n!! Add the new appStoreVersion as an item on this submission too — the first');
  console.log('!! auto-renewable subscription cannot be reviewed without an accompanying binary:');
  console.log(JSON.stringify({ data: { type: 'reviewSubmissionItems', relationships: {
    reviewSubmission: { data: { type: 'reviewSubmissions', id: rs.id } },
    appStoreVersion: { data: { type: 'appStoreVersions', id: '<new 3.5 appStoreVersion id>' } } } } }, null, 2));

  for (const c of created) {
    await MUTATE(`add ${c.plan.key} version to submission`, 'POST', '/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: rs.id } },
          subscriptionVersion: { data: { type: 'subscriptionVersions', id: c.versionId } },
        },
      },
    });
  }

  await MUTATE('SUBMIT to App Review', 'PATCH', `/v1/reviewSubmissions/${rs.id}`, {
    data: { type: 'reviewSubmissions', id: rs.id, attributes: { submitted: true } },
  });
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
