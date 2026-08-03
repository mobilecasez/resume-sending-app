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

// ── The plan catalog. Prices are DISPLAY values (the stores are the billing truth once wired). ──
const PLANS = [
  { key: 'starter', label: 'Starter', priceUsd: 4.99,  letters: 30,   resumes: 5,
    productIos: 'com.cvapplyr.sub.starter', productAndroid: 'cvapplyr_sub_starter' },
  { key: 'plus',    label: 'Plus',    priceUsd: 9.99,  letters: 100,  resumes: 10,
    productIos: 'com.cvapplyr.sub.plus', productAndroid: 'cvapplyr_sub_plus' },
  { key: 'pro',     label: 'Pro',     priceUsd: 14.99, letters: 150,  resumes: 15,
    productIos: 'com.cvapplyr.sub.pro', productAndroid: 'cvapplyr_sub_pro' },
  { key: 'power',   label: 'Power',   priceUsd: 24.99, letters: 300,  resumes: 25,
    productIos: 'com.cvapplyr.sub.power', productAndroid: 'cvapplyr_sub_power' },
  { key: 'max',     label: 'Max',     priceUsd: 49.99, letters: 1000, resumes: 50,
    productIos: 'com.cvapplyr.sub.max', productAndroid: 'cvapplyr_sub_max' },
];
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
    subscription: sub ? { planKey: sub.plan_key, label: plan ? plan.label : sub.plan_key, periodEnd: sub.period_end, source: sub.source } : null,
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

module.exports = {
  PLANS, TRIAL,
  reportDevice, ensureTrial, getStatus, canConsumeMany, consumeOnSuccess, getUsage,
  adminSetSubscription, deviceIdOf, ipHashOf,
  // exported for the lifecycle nudges (which must know what a user has LEFT before offering more)
  activeSubscription, usedSince, bonusSince, allowanceIn, planByKey, KIND_QUOTA_FIELD,
};
