// The ONE place a store product id becomes a plan_key. Everything that touches money — the
// /payment/verify-* endpoints, the Apple V2 / Google RTDN webhooks, and the provisioning tools —
// reads this file, so the app, the two stores and the database can never drift apart.
//
// DESIGN RULES (each one exists because of a specific way money goes wrong):
//   • ONE identifier on both stores: `com.cvapplyr.mobile.sub.<plan_key>`. These are the ids that
//     ACTUALLY EXIST in App Store Connect (subscription group 22290874, created 2026-08-06) and
//     Apple product ids are PERMANENTLY reserved — they can never be renamed or reused. The table
//     is therefore frozen. Play has zero subscriptions yet, so Play adopts the same ids.
//     ⚠️ The `.mobile.sub.` namespace is one level deeper than it looks like it should be because
//     the four existing CONSUMABLES already own `com.cvapplyr.mobile.<name>`.
//     ⚠️ `com.cvapplyr.sub.*` (no `.mobile`) was an earlier proposal that was NEVER created on
//     either store. It is kept below as a read-only alias, never as a canonical id: a purchase can
//     only ever arrive with a real id, and mapping a real id to null means the user pays and gets
//     nothing.
//   • Play's basePlanId is `monthly` — RFC-1034 forbids underscores, so `base_monthly` is illegal.
//   • The legacy Android ids (`cvapplyr_sub_*`) never existed on Play (zero subscriptions there),
//     but they are accepted on READ so that a build compiled against the old entitlements.js
//     constant can still be verified instead of silently failing to grant a plan somebody paid for.
//   • The 4 APPROVED consumables stay listed. They are NOT subscriptions: a notification carrying
//     one of them must never reach the subscription entitlement writer, or a $4.99 credit pack
//     would grant a monthly plan.
//   • Unknown product id → null. Callers fail CLOSED on null; nothing is ever granted by default.
'use strict';

// planKey MUST match server/services/entitlements.js PLANS[].key exactly.
// APPLE_SUB_PREFIX is exported because MobileApp/App.js has to recognise a subscription product id
// without a server round-trip, and a prefix that does not match the live ids silently disables
// that guard. Keep the two in step.
const APPLE_SUB_PREFIX = 'com.cvapplyr.mobile.sub.';
const SUBSCRIPTIONS = [
  { planKey: 'starter', productId: 'com.cvapplyr.mobile.sub.starter', basePlanId: 'monthly', priceUsd: 4.99,  appleGroupLevel: 5, aliasIds: ['com.cvapplyr.sub.starter', 'cvapplyr_sub_starter'] },
  { planKey: 'plus',    productId: 'com.cvapplyr.mobile.sub.plus',    basePlanId: 'monthly', priceUsd: 9.99,  appleGroupLevel: 4, aliasIds: ['com.cvapplyr.sub.plus',    'cvapplyr_sub_plus'] },
  { planKey: 'pro',     productId: 'com.cvapplyr.mobile.sub.pro',     basePlanId: 'monthly', priceUsd: 14.99, appleGroupLevel: 3, aliasIds: ['com.cvapplyr.sub.pro',     'cvapplyr_sub_pro'] },
  { planKey: 'power',   productId: 'com.cvapplyr.mobile.sub.power',   basePlanId: 'monthly', priceUsd: 24.99, appleGroupLevel: 2, aliasIds: ['com.cvapplyr.sub.power',   'cvapplyr_sub_power'] },
  { planKey: 'max',     productId: 'com.cvapplyr.mobile.sub.max',     basePlanId: 'monthly', priceUsd: 49.99, appleGroupLevel: 1, aliasIds: ['com.cvapplyr.sub.max',     'cvapplyr_sub_max'] },
];
// Apple's subscription group. Recorded so a subscription status read can pick OUR group's row
// instead of assuming the app has exactly one group forever.
const APPLE_GROUP_ID = process.env.APPLE_SUB_GROUP_ID || '22290874';

// The four APPROVED consumable credit packs. Left on sale during the 3.6 cycle on purpose: removing
// a product refunds nothing, frees no identifier, and would leave the app with no working paywall
// if 3.6 is rejected. Listed here only so the subscription path can recognise and REFUSE them.
const CONSUMABLES = [
  'com.cvapplyr.mobile.starter',
  'com.cvapplyr.mobile.professional',
  'com.cvapplyr.mobile.premium',
  'com.cvapplyr.mobile.enterprise',
];

const BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'com.cvapplyr.mobile';
const PLAY_PACKAGE = process.env.PLAY_PACKAGE || 'com.cvapplyr.mobile';

const byProduct = new Map();
for (const s of SUBSCRIPTIONS) {
  byProduct.set(s.productId, s);
  for (const alias of (s.aliasIds || [])) byProduct.set(alias, s);
}
const byPlan = new Map(SUBSCRIPTIONS.map((s) => [s.planKey, s]));

/** Subscription descriptor for a store product id, or null. Case-sensitive by design. */
function subscriptionForProduct(productId) {
  const id = typeof productId === 'string' ? productId.trim() : '';
  return id ? (byProduct.get(id) || null) : null;
}

/** plan_key for a store product id, or null when the id is unknown / is a consumable. */
function planKeyForProduct(productId) {
  const s = subscriptionForProduct(productId);
  return s ? s.planKey : null;
}

/** Canonical store product id for a plan_key (identical on Apple and Play), or null. */
function productIdForPlan(planKey) {
  const s = byPlan.get(String(planKey || ''));
  return s ? s.productId : null;
}

function isConsumable(productId) {
  return CONSUMABLES.includes(String(productId || '').trim());
}

/** True only for ids this server is willing to treat as a monthly plan. */
function isSubscriptionProduct(productId) {
  return subscriptionForProduct(productId) !== null;
}

module.exports = {
  SUBSCRIPTIONS, CONSUMABLES, BUNDLE_ID, PLAY_PACKAGE, APPLE_SUB_PREFIX, APPLE_GROUP_ID,
  subscriptionForProduct, planKeyForProduct, productIdForPlan, isConsumable, isSubscriptionProduct,
};
