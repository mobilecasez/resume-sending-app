// Subscription entitlements — quota-based plans replacing per-credit pricing for the two AI
// features that cost real money (cover-letter generation, resume generation). ADDITIVE and
// non-breaking: users with no trial and no plan fall back to the legacy credit balance at the
// old per-event price, so nobody who could generate yesterday is blocked today.
//
// Model (2026-07-31):
//   • Job fetch, Auto Fill, translate, apply (portal + email), downloads, searches → FREE
//     (their ai_event_costs rows are zeroed by Migration 028; the admin screen can re-price).
//   • 7-day FREE TRIAL: 2 resume generations + 5 cover letters. ONE trial per DEVICE — the app
//     sends a keychain-persisted device id (x-device-id); re-registering with a new email on the
//     same device does NOT reset the trial. No device id (old builds) → one trial per user.
//   • Paid plans (monthly): see PLANS. Store products are not wired yet — an admin can assign a
//     plan (source 'admin') for testing via POST /api/admin/set-subscription.
//   • Deduction happens ONLY on success: controllers call consumeOnSuccess() after the AI work
//     completed; pre-flight uses canConsumeMany() which checks but never reserves.
//   • Every consumption is a usage_ledger row with details → the in-app Usage screen.
'use strict';

const crypto = require('crypto');
const dbConfig = require('../../db-config');
const { getEventCost, chargeCredits } = require('./eventCosts');

// ── The plan catalog. priceUsd is a DISPLAY FALLBACK ONLY — see the warning below. ────────────
// ⚠️ priceUsd MUST NOT reach a buy button. Outside the US the store charges the local price tier,
// which is not 4.99 USD converted; showing this number next to a working purchase button means the
// user is quoted one price and billed another (an App Store rejection, and a real complaint).
// The paywall renders a buyable row only from the store's own localized displayPrice; priceUsd is
// for the disabled/not-yet-provisioned state.
//
// productAndroid was `cvapplyr_sub_*`, an id that has never existed on Play (Play has zero
// subscriptions), so nothing is stranded by moving to ONE identifier on both stores. The canonical
// table now lives in services/storeProducts.js and is asserted against below.
//
// ⚠️ productIos/productAndroid are `com.cvapplyr.mobile.sub.*` — the ids that EXIST in App Store
// Connect (group 22290874). They are NOT `com.cvapplyr.sub.*`: that namespace was proposed but
// never created on either store, and the app fetches its buyable SKUs from this very list, so the
// wrong id here means fetchProducts returns nothing and the paywall has no buy button at all.
const PLANS = [
  { key: 'starter', label: 'Starter', priceUsd: 4.99,  letters: 30,   resumes: 5,
    productIos: 'com.cvapplyr.mobile.sub.starter', productAndroid: 'com.cvapplyr.mobile.sub.starter' },
  { key: 'plus',    label: 'Plus',    priceUsd: 9.99,  letters: 100,  resumes: 10,
    productIos: 'com.cvapplyr.mobile.sub.plus', productAndroid: 'com.cvapplyr.mobile.sub.plus' },
  { key: 'pro',     label: 'Pro',     priceUsd: 14.99, letters: 150,  resumes: 15,
    productIos: 'com.cvapplyr.mobile.sub.pro', productAndroid: 'com.cvapplyr.mobile.sub.pro' },
  { key: 'power',   label: 'Power',   priceUsd: 24.99, letters: 300,  resumes: 25,
    productIos: 'com.cvapplyr.mobile.sub.power', productAndroid: 'com.cvapplyr.mobile.sub.power' },
  { key: 'max',     label: 'Max',     priceUsd: 49.99, letters: 1000, resumes: 50,
    productIos: 'com.cvapplyr.mobile.sub.max', productAndroid: 'com.cvapplyr.mobile.sub.max' },
];

// Drift guard. If this ever fires, one of the two tables was edited alone and a real purchase will
// verify against a product id that maps to no plan — the user pays and gets nothing.
try {
  const sp = require('./storeProducts');
  for (const p of PLANS) {
    const want = sp.productIdForPlan(p.key);
    if (want !== p.productIos || want !== p.productAndroid) {
      console.error(`[entitlements] PRODUCT ID DRIFT for plan "${p.key}": catalog has ` +
        `${p.productIos}/${p.productAndroid}, storeProducts.js has ${want}`);
    }
  }
} catch (e) { console.warn('[entitlements] product id check skipped:', e.message); }
const TRIAL = { key: 'trial', label: '7-day free trial', days: 7, letters: 5, resumes: 2 };
const planByKey = (k) => PLANS.find((p) => p.key === k) || null;

const KIND_QUOTA_FIELD = { cover_letter: 'letters', resume: 'resumes' };
// Legacy credit price keys, for the fallback pool only.
const KIND_LEGACY_EVENT = { cover_letter: 'cover_letter_generate', resume: 'resume_ai_generate' };

const ipHashOf = (req) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    return ip ? crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16) : null;
  } catch { return null; }
};
const deviceIdOf = (req) => {
  const d = req && req.headers && String(req.headers['x-device-id'] || '').trim();
  return d && /^[A-Za-z0-9_-]{8,80}$/.test(d) ? d : null;
};

// ── device registry (analytics + trial dedupe) ────────────────────────────────────────────────
async function reportDevice(userId, deviceId, ipHash) {
  if (!deviceId) return;
  try {
    await dbConfig.query(
      `INSERT INTO user_devices (user_id, device_id, ip_hash, first_seen, last_seen)
       VALUES ($1,$2,$3,NOW(),NOW())
       ON CONFLICT (user_id, device_id) DO UPDATE SET last_seen = NOW(), ip_hash = COALESCE(EXCLUDED.ip_hash, user_devices.ip_hash)`,
      [userId, deviceId, ipHash || null]);
  } catch (e) { console.warn('[entitlements] reportDevice:', e.message); }
}

// ── trial ─────────────────────────────────────────────────────────────────────────────────────
// Returns the user's trial row, starting one lazily when they are eligible. Device rule: a device
// id that already started a trial blocks NEW users on that device (the original trial user keeps
// theirs). Old builds send no device id → per-user trial (best we can do until they update).
async function ensureTrial(userId, deviceId, ipHash) {
  const rows = await dbConfig.query('SELECT * FROM user_trials WHERE user_id = $1', [userId]);
  if (rows && rows.length) return rows[0];

  if (deviceId) {
    const dev = await dbConfig.query('SELECT * FROM trial_devices WHERE device_id = $1', [deviceId]);
    if (dev && dev.length && Number(dev[0].first_user_id) !== Number(userId)) {
      return { blocked: 'device_trial_used' };   // this device already consumed its one trial
    }
  }

  try {
    await dbConfig.query(
      `INSERT INTO user_trials (user_id, device_id, started_at, ends_at)
       VALUES ($1,$2,NOW(),NOW() + INTERVAL '${TRIAL.days} days') ON CONFLICT (user_id) DO NOTHING`,
      [userId, deviceId || null]);
    if (deviceId) {
      await dbConfig.query(
        `INSERT INTO trial_devices (device_id, first_user_id, ip_hash, trial_started_at)
         VALUES ($1,$2,$3,NOW()) ON CONFLICT (device_id) DO NOTHING`,
        [deviceId, userId, ipHash || null]);
    }
  } catch (e) { console.warn('[entitlements] ensureTrial:', e.message); }
  const again = await dbConfig.query('SELECT * FROM user_trials WHERE user_id = $1', [userId]);
  return (again && again[0]) || { blocked: 'trial_unavailable' };
}

// ── core reads ────────────────────────────────────────────────────────────────────────────────
async function activeSubscription(userId) {
  const rows = await dbConfig.query(
    `SELECT * FROM user_subscriptions
     WHERE user_id = $1 AND status = 'active' AND period_end > NOW()
     ORDER BY period_end DESC LIMIT 1`, [userId]);
  return (rows && rows[0]) || null;
}

async function usedSince(userId, kind, source, sinceSql, params) {
  const rows = await dbConfig.query(
    `SELECT COUNT(*)::int AS n FROM usage_ledger
     WHERE user_id = $1 AND kind = $2 AND source = $3 AND created_at >= ${sinceSql}`,
    [userId, kind, source, ...params]);
  return rows && rows[0] ? rows[0].n : 0;
}

// Bonus units granted on top of the plan/trial allowance (quota_grants — see services/quotaGrants.js),
// counted in the SAME window as the usage they offset. Read through a lazy require so the two modules
// can reference each other; falls back to 0 so a failed read can only ever UNDER-count quota.
async function bonusSince(userId, kind, since) {
  try { return await require('./quotaGrants').bonusSince(userId, kind, since); }
  catch (e) { console.warn('[entitlements] bonusSince:', e.message); return 0; }
}

/** The real allowance for a window: what the plan/trial gives, plus anything granted since. */
async function allowanceIn(userId, kind, base, since) {
  return base + await bonusSince(userId, kind, since);
}

// Full picture for the app: plan, trial, remaining, used — one call.
async function getStatus(userId, req) {
  const deviceId = req ? deviceIdOf(req) : null;
  const sub = await activeSubscription(userId);
  const plan = sub ? planByKey(sub.plan_key) : null;
  const out = {
    plans: PLANS, trial: TRIAL,
    // `store`/`autoRenew` let the paywall say "managed in the App Store" and hide a buy button that
    // would charge a second time on the other platform, instead of quietly selling a duplicate.
    subscription: sub ? {
      planKey: sub.plan_key, label: plan ? plan.label : sub.plan_key, periodEnd: sub.period_end,
      source: sub.source, store: sub.store || null, productId: sub.product_id || null,
      autoRenew: sub.auto_renew == null ? null : Boolean(sub.auto_renew),
    } : null,
    remaining: { letters: 0, resumes: 0 },
    used: { letters: 0, resumes: 0 },
    via: null,
  };
  if (sub && plan) {
    const uL = await usedSince(userId, 'cover_letter', 'plan', '$4', [sub.period_start]);
    const uR = await usedSince(userId, 'resume', 'plan', '$4', [sub.period_start]);
    const aL = await allowanceIn(userId, 'cover_letter', plan.letters, sub.period_start);
    const aR = await allowanceIn(userId, 'resume', plan.resumes, sub.period_start);
    out.used = { letters: uL, resumes: uR };
    out.remaining = { letters: Math.max(0, aL - uL), resumes: Math.max(0, aR - uR) };
    out.bonus = { letters: aL - plan.letters, resumes: aR - plan.resumes };
    out.via = 'plan';
    return out;
  }
  const trial = await ensureTrial(userId, deviceId, ipHashOf(req || {}));
  if (trial && !trial.blocked) {
    const active = new Date(trial.ends_at) > new Date();
    const uL = await usedSince(userId, 'cover_letter', 'trial', '$4', [trial.started_at]);
    const uR = await usedSince(userId, 'resume', 'trial', '$4', [trial.started_at]);
    const aL = await allowanceIn(userId, 'cover_letter', TRIAL.letters, trial.started_at);
    const aR = await allowanceIn(userId, 'resume', TRIAL.resumes, trial.started_at);
    out.trialState = { active, startedAt: trial.started_at, endsAt: trial.ends_at, used: { letters: uL, resumes: uR } };
    if (active) {
      out.used = { letters: uL, resumes: uR };
      out.remaining = { letters: Math.max(0, aL - uL), resumes: Math.max(0, aR - uR) };
      out.bonus = { letters: aL - TRIAL.letters, resumes: aR - TRIAL.resumes };
      out.via = 'trial';
    }
  } else if (trial && trial.blocked) {
    out.trialState = { active: false, blocked: trial.blocked };
  }
  // legacy credits still shown so grandfathered users understand what they're spending
  try {
    const acct = await dbConfig.get('SELECT credits_remaining FROM user_credits WHERE user_id = ?', [userId]);
    out.legacyCredits = acct ? (acct.credits_remaining || 0) : 0;
  } catch { out.legacyCredits = 0; }
  return out;
}

// ── the gate (check only — NEVER reserves; deduction happens on success) ──────────────────────
async function canConsumeMany(userId, kind, count, req) {
  const field = KIND_QUOTA_FIELD[kind];
  const n = Math.max(1, parseInt(count, 10) || 1);
  const deviceId = req ? deviceIdOf(req) : null;

  const sub = await activeSubscription(userId);
  if (sub) {
    const plan = planByKey(sub.plan_key);
    if (plan) {
      const used = await usedSince(userId, kind, 'plan', '$4', [sub.period_start]);
      const allow = await allowanceIn(userId, kind, plan[field], sub.period_start);
      if (allow - used >= n) return { allowed: true, via: 'plan', remaining: allow - used };
      // plan exhausted → fall through to credits fallback below (never to trial)
    }
  } else {
    const trial = await ensureTrial(userId, deviceId, ipHashOf(req || {}));
    if (trial && !trial.blocked && new Date(trial.ends_at) > new Date()) {
      const used = await usedSince(userId, kind, 'trial', '$4', [trial.started_at]);
      const allow = await allowanceIn(userId, kind, TRIAL[field], trial.started_at);
      if (allow - used >= n) return { allowed: true, via: 'trial', remaining: allow - used };
    }
  }

  // Legacy pool: existing credit balances keep working at the old per-event price.
  const price = await getEventCost(KIND_LEGACY_EVENT[kind]);
  try {
    const acct = await dbConfig.get('SELECT credits_remaining FROM user_credits WHERE user_id = ?', [userId]);
    const bal = acct ? (acct.credits_remaining || 0) : 0;
    if (price > 0 && bal >= price * n) return { allowed: true, via: 'credits', remaining: Math.floor(bal / price) };
  } catch { /* fall through to denial */ }

  const noun = kind === 'resume' ? 'resume generations' : 'cover letters';
  return {
    allowed: false, via: null, reason: 'quota_exhausted',
    message: sub
      ? `You've used all the ${noun} in your plan this month. Upgrade in Plans & Usage (menu) to continue.`
      : `You've used your free ${noun}. Open Plans & Usage in the menu to start a plan and continue.`,
  };
}

// ── the deduction — call ONLY after the work succeeded ────────────────────────────────────────
// Picks the pool in the same priority order as the gate, writes the ledger row (with details for
// the Usage screen) and, for the legacy pool, performs the old credit deduction. Never throws.
async function consumeOnSuccess(userId, kind, detail = {}, req) {
  try {
    const deviceId = req ? deviceIdOf(req) : null;
    const sub = await activeSubscription(userId);
    let via = 'credits';
    if (sub && planByKey(sub.plan_key)) {
      const plan = planByKey(sub.plan_key);
      const used = await usedSince(userId, kind, 'plan', '$4', [sub.period_start]);
      const allow = await allowanceIn(userId, kind, plan[KIND_QUOTA_FIELD[kind]], sub.period_start);
      if (allow - used >= 1) via = 'plan';
    } else {
      const trial = await ensureTrial(userId, deviceId, null);
      if (trial && !trial.blocked && new Date(trial.ends_at) > new Date()) {
        const used = await usedSince(userId, kind, 'trial', '$4', [trial.started_at]);
        const allow = await allowanceIn(userId, kind, TRIAL[KIND_QUOTA_FIELD[kind]], trial.started_at);
        if (allow - used >= 1) via = 'trial';
      }
    }
    if (via === 'credits') {
      // legacy path — same deduction the old code performed (no-op when the price is 0)
      await chargeCredits(userId, KIND_LEGACY_EVENT[kind], detail);
    }
    await dbConfig.query(
      `INSERT INTO usage_ledger (user_id, kind, source, plan_key, detail, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,NOW())`,
      [userId, kind, via, sub ? sub.plan_key : null,
       JSON.stringify({ ...detail, }).slice(0, 4000)]);
    return { via };
  } catch (e) {
    console.warn('[entitlements] consumeOnSuccess:', e.message);
    return { via: 'error' };
  }
}

// ── usage screen data ─────────────────────────────────────────────────────────────────────────
async function getUsage(userId, limit = 100) {
  const rows = await dbConfig.query(
    `SELECT id, kind, source, plan_key, detail, created_at FROM usage_ledger
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 300)]);
  return (rows || []).map((r) => ({
    id: r.id, kind: r.kind, source: r.source, planKey: r.plan_key,
    detail: typeof r.detail === 'object' ? r.detail : (() => { try { return JSON.parse(r.detail); } catch { return {}; } })(),
    createdAt: r.created_at,
  }));
}

// ── admin (testing until store products exist) ────────────────────────────────────────────────
async function adminSetSubscription(userId, planKey) {
  if (!planKey) {
    await dbConfig.query(`UPDATE user_subscriptions SET status = 'cancelled' WHERE user_id = $1 AND status = 'active'`, [userId]);
    return { cleared: true };
  }
  if (!planByKey(planKey)) return { error: 'unknown_plan' };
  await dbConfig.query(`UPDATE user_subscriptions SET status = 'cancelled' WHERE user_id = $1 AND status = 'active'`, [userId]);
  await dbConfig.query(
    `INSERT INTO user_subscriptions (user_id, plan_key, status, source, period_start, period_end)
     VALUES ($1,$2,'active','admin',NOW(),NOW() + INTERVAL '30 days')`, [userId, planKey]);
  return { ok: true, planKey };
}

// ── store-backed subscriptions (Apple / Google) ───────────────────────────────────────────────
// The ONLY way a real purchase becomes an entitlement. Deliberately NOT adminSetSubscription with
// a different source string:
//
//   • adminSetSubscription hardcodes NOW() + INTERVAL '30 days'. For a paid plan that guess is
//     wrong in both directions — it keeps a lapsed user in, and it cuts off a paying user early
//     whenever the store's expiry is later (annual promos, grace periods, billing retry, Apple's
//     free extensions). period_end here comes from the store's expiry and nowhere else.
//   • adminSetSubscription cancels-then-inserts. Replay that on a redelivered webhook and you have
//     two active rows for one payment. This upserts onto the unique index
//     (store, original_transaction_id) from Migration 035, so a replay recomputes the same state
//     onto the same row: idempotent by construction, not by remembering notification ids.
//
// Monotonic on purpose: an out-of-order delivery can only move period_end FORWARD. The one thing
// allowed to pull access back is `terminal` (refund / revoke / chargeback), which is explicit.
//
// Legacy credits are untouched by every path in here.
async function storeSetSubscription({
  userId, planKey, source, productId, originalTxnId,
  periodStart = null, periodEnd, status = 'active', terminal = false,
  purchaseToken = null, latestTxnId = null, environment = null,
  autoRenew = null, acknowledged = null, storeState = null, supersede = true,
}) {
  const uid = parseInt(userId, 10);
  if (!Number.isFinite(uid) || uid <= 0) return { error: 'invalid_user' };
  if (!planByKey(planKey)) return { error: 'unknown_plan' };
  if (source !== 'apple' && source !== 'google') return { error: 'invalid_source' };
  const txn = String(originalTxnId || '').trim();
  if (!txn) return { error: 'missing_original_transaction_id' };
  const end = periodEnd instanceof Date ? periodEnd : new Date(periodEnd);
  if (!end || isNaN(end.getTime())) return { error: 'invalid_period_end' };
  const start = periodStart ? new Date(periodStart) : null;

  const rows = await dbConfig.query(
    `INSERT INTO user_subscriptions
       (user_id, plan_key, status, source, product_id, store, original_transaction_id,
        purchase_token, latest_transaction_id, environment, auto_renew, acknowledged, store_state,
        period_start, period_end, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$4,$6,$7,$8,$9,$10,COALESCE($11,FALSE),$12,
             COALESCE($13, NOW()), $14, NOW(), NOW())
     ON CONFLICT (store, original_transaction_id)
       WHERE store IS NOT NULL AND original_transaction_id IS NOT NULL
     DO UPDATE SET
       plan_key   = EXCLUDED.plan_key,
       status     = EXCLUDED.status,
       product_id = EXCLUDED.product_id,
       purchase_token        = COALESCE(EXCLUDED.purchase_token, user_subscriptions.purchase_token),
       latest_transaction_id = COALESCE(EXCLUDED.latest_transaction_id, user_subscriptions.latest_transaction_id),
       environment           = COALESCE(EXCLUDED.environment, user_subscriptions.environment),
       auto_renew            = COALESCE(EXCLUDED.auto_renew, user_subscriptions.auto_renew),
       acknowledged          = user_subscriptions.acknowledged OR EXCLUDED.acknowledged,
       store_state           = COALESCE(EXCLUDED.store_state, user_subscriptions.store_state),
       -- A new billing cycle must reset the quota window, so period_start advances to the moment
       -- the old cycle ended. A plan change starts a fresh window at the change. Anything else
       -- (a replay, a status-only notification) leaves the window exactly where it was.
       --
       -- ⚠️ The outer GREATEST is not decoration: period_start must NEVER move backwards. Google's
       -- subscriptionsv2 reports startTime = when the subscription was FIRST granted, not when the
       -- current cycle began, so a plan change on a long-lived Play token would otherwise rewind the
       -- window to the original signup date — and usedSince() would then count every cover letter
       -- the user has ever generated against this month's allowance. A user who upgrades after six
       -- months would pay and find the new plan already exhausted. Refusing to rewind costs at most
       -- one partial window on an upgrade; rewinding costs somebody their month.
       period_start = GREATEST(user_subscriptions.period_start, CASE
         WHEN EXCLUDED.plan_key <> user_subscriptions.plan_key THEN EXCLUDED.period_start
         WHEN EXCLUDED.period_end > user_subscriptions.period_end
           THEN GREATEST(user_subscriptions.period_end, EXCLUDED.period_start)
         ELSE user_subscriptions.period_start END),
       period_end = CASE
         WHEN $15::boolean THEN EXCLUDED.period_end
         ELSE GREATEST(user_subscriptions.period_end, EXCLUDED.period_end) END,
       updated_at = NOW()
     RETURNING *, (xmax = 0) AS _inserted`,
    [uid, planKey, status, source, productId || null, txn, purchaseToken, latestTxnId,
     environment, autoRenew, acknowledged, storeState, start, end, Boolean(terminal)]
  );
  const row = rows && rows[0];
  if (!row) return { error: 'upsert_failed' };

  // The purchase stays welded to the account that first claimed it. Letting a second account adopt
  // the same store transaction is how one Apple ID farms plans for a dozen users — and it would
  // silently strip the plan from whoever paid.
  const claimedBy = Number(row.user_id);
  const transferBlocked = claimedBy !== uid;
  // Did this statement INSERT, or did it take the DO UPDATE branch? That is what stops the
  // "new purchase" admin alert firing again on every redelivered webhook.
  //
  // ⚠️ NOT a created_at/updated_at comparison. Both are stamped NOW() on insert, so a webhook that
  // arrives within a second of the client's own verify call — the normal case, Apple's SUBSCRIBED
  // notification races the app — measured a sub-second delta and reported a brand-new purchase for
  // the second time. Postgres answers this exactly: xmax is 0 on a freshly inserted tuple and
  // non-zero on one that an ON CONFLICT DO UPDATE touched. Where it is ambiguous (a concurrently
  // locked row) it reads non-zero, i.e. it errs toward staying quiet rather than alerting twice.
  const created = row._inserted === true;

  // One active entitlement per user. This is also the "subscribed on both stores" fix: whichever
  // store wrote last wins, the other row goes to 'superseded', and the paywall can then tell the
  // user where the live subscription is managed instead of quietly billing them twice.
  if (supersede && row.status === 'active' && new Date(row.period_end) > new Date()) {
    await dbConfig.query(
      `UPDATE user_subscriptions SET status = 'superseded', updated_at = NOW()
        WHERE user_id = $1 AND id <> $2 AND status = 'active'`, [claimedBy, row.id]);
  }
  return { ok: true, created, transferBlocked, row };
}

/** The store-backed row for a user, if any (used by the paywall to say where it is managed). */
async function storeSubscriptionFor(userId) {
  const rows = await dbConfig.query(
    `SELECT * FROM user_subscriptions
      WHERE user_id = $1 AND store IS NOT NULL
      ORDER BY period_end DESC LIMIT 1`, [userId]);
  return (rows && rows[0]) || null;
}

module.exports = {
  PLANS, TRIAL,
  reportDevice, ensureTrial, getStatus, canConsumeMany, consumeOnSuccess, getUsage,
  adminSetSubscription, storeSetSubscription, storeSubscriptionFor, deviceIdOf, ipHashOf,
  // exported for the lifecycle nudges (which must know what a user has LEFT before offering more)
  activeSubscription, usedSince, bonusSince, allowanceIn, planByKey, KIND_QUOTA_FIELD,
};
