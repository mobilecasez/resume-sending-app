// Subscription entitlements — the quota model for the two AI features that cost real money
// (resume generation, cover-letter generation). A paid plan or the one-time Free plan pays for
// them, and NOTHING else does: there is no credit fallback any more.
//
// Model (2026-09-13 — the product owner's decisions; replaces the 2026-07-31 trial and the
// 2026-08-10 refilling Free plan):
//   • Job fetch, Auto Fill, translate, apply (portal + email), searches → FREE (their ai_event_costs
//     rows are zeroed by Migration 028; the admin screen can re-price). Downloads are a plan
//     allowance or a one-time single-download pass (services/downloads.js).
//   • FREE PLAN (2026-10-29): 10 resume generations + 10 cover letters in any ROLLING 24 HOURS —
//     generate and preview for free, every day; only DOWNLOADING costs money (a plan or a pass). It is
//     also every subscriber's floor: once a plan's monthly allowance is spent, the free daily lane
//     pays. ONE free allowance per DEVICE: the app sends a keychain-persisted device id
//     (x-device-id), and a second account on a device whose allowance is already claimed gets none
//     ('device_trial_used'). No device id at all (old builds) → one free allowance per user.
//     quota_grants bonuses add on top, inside the same 24 hours.
//   • Paid plans (monthly): see PLANS. Bought in the stores (storeSetSubscription); an admin can
//     also assign one (source 'admin') via POST /api/admin/set-subscription.
//   • NO CREDITS FOR GENERATION. A legacy credit balance no longer pays for a resume or a cover
//     letter: an exhausted allowance answers quota_exhausted (→ the plans screen), never "this uses N
//     credits". getStatus still reports the balance, for display only.
//   • Deduction happens ONLY on success: controllers call consumeOnSuccess() after the AI work
//     completed; pre-flight uses canConsumeMany() which checks but never reserves.
//   • Every consumption is a usage_ledger row with details → the in-app Usage screen.
'use strict';

const crypto = require('crypto');
const dbConfig = require('../../db-config');
const { PRODUCTION, normalizeEnvironment, requestEnvironment } = require('./storeEnvironment');

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
//
// ⚠️ ALLOWANCES (2026-09-13), resumes / letters a month: Starter 6 / 10, Plus 15 / 25, Pro 25 / 50,
// Power 40 / 100, Max 100 / 500. Prices did not move. Letters were CUT from the 2026-07-31 numbers
// (Starter 30 → 10, Max 1000 → 500) while resumes went up, so a subscriber part-way through a billing
// period can already have used more letters than the new allowance. That is not a fault: remaining
// clamps at 0 until the next period, and the admin screen flags the row as `over`. The website
// (scripts/check-pricing-parity.js) and the store-listing tools read these literals as source, so
// PLANS must stay one plain array literal ending in "\n];".
const PLANS = [
  { key: 'starter', label: 'Starter', priceUsd: 4.99,  letters: 10,  resumes: 6,   downloads: 20,
    productIos: 'com.cvapplyr.mobile.sub.starter', productAndroid: 'com.cvapplyr.mobile.sub.starter' },
  { key: 'plus',    label: 'Plus',    priceUsd: 9.99,  letters: 25,  resumes: 15,  downloads: 40,
    productIos: 'com.cvapplyr.mobile.sub.plus', productAndroid: 'com.cvapplyr.mobile.sub.plus' },
  { key: 'pro',     label: 'Pro',     priceUsd: 14.99, letters: 50,  resumes: 25,  downloads: 60,
    productIos: 'com.cvapplyr.mobile.sub.pro', productAndroid: 'com.cvapplyr.mobile.sub.pro' },
  { key: 'power',   label: 'Power',   priceUsd: 24.99, letters: 100, resumes: 40,  downloads: 100,
    productIos: 'com.cvapplyr.mobile.sub.power', productAndroid: 'com.cvapplyr.mobile.sub.power' },
  { key: 'max',     label: 'Max',     priceUsd: 49.99, letters: 500, resumes: 100, downloads: 200,
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
// ── The FREE plan — DAILY since 2026-10-29 ─────────────────────────────────────────────────────
// 10 resume generations + 10 cover letters in any rolling 24 hours. The owner's decision after the
// October sales analysis: nobody EVER used up the one-time 3 + 3, and the real paywall is Download —
// so making and previewing is free, every day, and money changes hands only for the file. The cap is
// fair use: each generation is a real AI call (≈₹0.5 a resume, ≈₹3 a grounded letter). History:
//   • 2026-07-31  7-day trial, 2 resumes + 5 letters, one per device.
//   • 2026-08-10  refilling Free plan: 1 resume + 5 letters again every 30 days from signup, and on
//                 2026-08-12 the device rule came OFF (a refilling allowance gains a 2nd account nothing).
//   • 2026-09-13  one-time 3 + 3 — which is why the device rule came back (see ensureTrial).
//   • 2026-10-29  this: 10 + 10 a day. The device rule STAYS: without it every new email doubles the
//                 daily cap, and the cap is the only thing between a script and our AI bill.
//
// ⚠️ ROLLING, NOT CALENDAR. "Today" is the last 24 hours measured on the ledger's own timestamps, so no
// timezone is involved and there is no midnight at which 20 can be made in a minute. The next free unit
// opens when the oldest one counted leaves the window (freeNextAt) — that is the time the refusal quotes.
//
// ⚠️ COUNTED FROM max(user_trials.started_at, FREE_CUTOVER), never from started_at alone. Every account
// older than the cutover would otherwise have its whole refilling-era history billed against 3 + 3 and
// start the new model already exhausted — and the decision is that every existing user starts it with
// a fresh 3 + 3. So usage AND bonus grants from before the cutover belong to the old model and are not
// counted; after that the start never moves again. ⚠️ The cutover is a fixed instant, not the deploy:
// free usage recorded between it and the deploy (under the old code) does count.
//
// ⚠️ Still exported as TRIAL, and the row still lives in `user_trials` (its started_at is the counting
// origin; usage_ledger.source stays 'trial' — see consumeOnSuccess). quotaGrants.js and adminUserOps.js
// read `ent.TRIAL.letters/.resumes`, and scripts/check-pricing-parity.js reads THIS literal by name, so
// keep it one plain object literal.
// ⚠️ `days` IS NOT AN ALLOWANCE PERIOD. It survives only because user_trials.ends_at is NOT NULL and
// ensureTrial has to write something there. Nothing grants or refuses on ends_at; the app is told not
// to render `days` when oneTime is set.
// ⚠️ downloads: 0 is not a new restriction — downloads have ALWAYS been paid-only. A free
// user buys a single-download pass or subscribes.
// ⚠️ oneTime: false + daily: true is the CONTRACT the apps read. Builds before 4.8 render a non-oneTime
// offer as "every {days} days", which is why days is 1 (true, if clumsy, on an old build); 4.8+ reads daily.
const FREE = { key: 'free', label: 'Free plan', letters: 10, resumes: 10, downloads: 0, oneTime: false, daily: true, days: 1 };
const TRIAL = FREE;
/** The instant the one-time model began (2026-09-13). Kept: nothing before it ever counts against the Free plan. */
const FREE_CUTOVER = '2026-09-13T00:00:00.000Z';
const FREE_CUTOVER_MS = Date.parse(FREE_CUTOVER);
/** The free allowance's window: the last 24 hours. */
const FREE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where the free allowance's counting starts NOW: max(started_at, FREE_CUTOVER, now − 24 h). Usage and
 * bonus grants are both counted from here, so a bonus granted today adds to today's cap.
 * ⚠️ FAILS CLOSED. An unparseable started_at counts from now − 24 h, the earliest start the window can
 * have, which can only count MORE usage than the true start, never less.
 * `now` is a parameter for the tests; every caller passes nothing.
 */
function freeWindowStart(startedAt, now = Date.now()) {
  const floor = Math.max(FREE_CUTOVER_MS, now - FREE_DAY_MS);
  const start = startedAt == null ? NaN : new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return new Date(floor);
  return new Date(Math.max(start, floor));
}
/**
 * The window has no fixed end — it rolls — so ALWAYS null. Kept as a function rather than deleted so a
 * caller that used to show "refills on <date>" gets an explicit "there is none". The real "when does the
 * next one open" depends on usage: freeNextAt.
 */
function freeWindowEnd() {
  return null;
}

/**
 * When the next free <kind> opens up: the oldest unit counted in the window, plus 24 hours. null when none
 * is counted (nothing to wait for). Display only — the gate counts, it never trusts this.
 */
async function freeNextAt(userId, kind, since) {
  const rows = await dbConfig.query(
    `SELECT MIN(created_at) AS first FROM usage_ledger
      WHERE user_id = $1 AND kind = $2 AND source = 'trial' AND created_at >= $3`,
    [userId, kind, since]);
  const first = rows && rows[0] && rows[0].first ? new Date(rows[0].first).getTime() : NaN;
  return Number.isFinite(first) ? new Date(first + FREE_DAY_MS) : null;
}

/** "in about 3 hours" — for a refusal. Rounds UP below an hour so it never promises a minute early. */
function opensInText(at, now = Date.now()) {
  const ms = at instanceof Date ? at.getTime() - now : NaN;
  if (!Number.isFinite(ms)) return 'within 24 hours';
  const mins = Math.max(1, Math.ceil(ms / 60000));
  if (mins < 60) return `in about ${mins} minute${mins === 1 ? '' : 's'}`;
  const h = Math.ceil(mins / 60);
  return `in about ${h} hour${h === 1 ? '' : 's'}`;
}

/**
 * The free daily lane for one kind: { since, used, allowance, left }. Only resume and cover_letter have one
 * (FREE.downloads is 0 — a download is never free).
 * ⚠️ `withBonus` is false for a SUBSCRIBER. quota_grants rows carry no pool, and a grant made to a subscriber is
 * the plan's (ensureCountableWindow answers 'plan'; allowanceIn counts it in the period). Counting it here too
 * paid every subscriber grant twice — once in the month, once more in the free day.
 */
async function freeLaneOf(userId, kind, startedAt, { withBonus = true } = {}) {
  const since = freeWindowStart(startedAt);
  const used = await usedSince(userId, kind, 'trial', '$4', [since]);
  const base = FREE[KIND_QUOTA_FIELD[kind]] || 0;
  const allowance = withBonus ? await allowanceIn(userId, kind, base, since) : base;
  return { since, used, allowance, left: Math.max(0, allowance - used) };
}
const hasFreeLane = (kind) => (FREE[KIND_QUOTA_FIELD[kind]] || 0) > 0;

/**
 * ⚠️ THE CIRCUIT BREAKER ON FREE AI (2026-10-29). The device rule stops a second account on one phone, but a
 * script that signs up throwaway accounts (no device id, or a random one) gets 10 + 10 a day EACH, for ever —
 * under the one-time plan the same script got 3 + 3 once. So free generations of a kind across EVERYONE are
 * capped per rolling 24 hours (FREE_GLOBAL_DAILY_CAP, default 2000 — ~200× today's real volume). Normal use
 * never meets it; an attack meets it and stops costing money. Plans and passes are never affected.
 * The GATE asks it; the charge does not (a build the gate admitted is paid, never dropped, on a race).
 */
const FREE_GLOBAL_DAILY_CAP = Math.max(1, parseInt(process.env.FREE_GLOBAL_DAILY_CAP || '2000', 10) || 2000);
async function freeLaneSaturated(kind) {
  try {
    const rows = await dbConfig.query(
      `SELECT COUNT(*)::int AS n FROM usage_ledger WHERE kind = $1 AND source = 'trial' AND created_at >= $2`,
      [kind, new Date(Date.now() - FREE_DAY_MS)]);
    const n = rows && rows[0] ? Number(rows[0].n) || 0 : 0;
    if (n >= FREE_GLOBAL_DAILY_CAP) console.warn(`[entitlements] FREE ${kind} BREAKER: ${n} free in 24 h ≥ cap ${FREE_GLOBAL_DAILY_CAP} — free lane paused`);
    return n >= FREE_GLOBAL_DAILY_CAP;
  } catch { return false; }   // an unreadable count must not refuse real users; the per-user cap still holds
}
const planByKey = (k) => PLANS.find((p) => p.key === k) || null;

const KIND_QUOTA_FIELD = { cover_letter: 'letters', resume: 'resumes', download: 'downloads' };

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

// ── free plan ─────────────────────────────────────────────────────────────────────────────────
// Returns the user's free-plan row (table still named user_trials), creating one lazily on first
// read — unless this device's one free allowance already belongs to another account, in which case
// it answers { blocked: 'device_trial_used' } and creates nothing.
async function ensureTrial(userId, deviceId, ipHash) {
  const rows = await dbConfig.query('SELECT * FROM user_trials WHERE user_id = $1', [userId]);
  if (rows && rows.length) return rows[0];

  // ⚠️ ONE FREE ALLOWANCE PER DEVICE — BACK since 2026-09-13, because the allowance is one-time again.
  // It came off on 2026-08-12 for a reason that was right then: the Free plan refilled every 30 days,
  // so a second account on the same phone gained nothing that waiting would not also give, while the
  // block was permanent and total for a second person on a shared tablet or a second-hand phone. A
  // ONE-TIME allowance flips that trade straight back: without the block a new email IS a new 3 + 3,
  // and "sign out, sign up again" is an unlimited free tier. So a second account on a device whose
  // allowance is claimed gets none (Plans & Usage renders 'device_trial_used'); the account that
  // claimed it keeps its own, and a plan or a download pass still works for everyone.
  // ⚠️ ONLY CREATING A ROW IS GATED. An account that already has one keeps it — the second accounts
  // made on shared devices while the rule was off included — because every existing user starts the
  // one-time model with a fresh 3 + 3. The rule exists to stop the NEXT extra account.
  if (await deviceClaimedByAnother(userId, deviceId)) return { blocked: 'device_trial_used' };

  try {
    // ends_at only because the column is NOT NULL (see FREE.days) — nothing reads it as an expiry.
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

/**
 * Does another account already hold the one free allowance of the device this request comes from?
 *
 * The device is the request's own x-device-id when it sent one. ⚠️ NOT EVERY QUOTA CHECK SENDS ONE —
 * Home's calls now send x-device-id; the older lanes (e.g. the Letters screen's generate-cover-letter-details) still do not — so without it this falls back to the
 * device the account most recently reported (POST /subscription/device, once per launch). Checking
 * nothing there would let whichever header-less call happened to land first create the row unchecked,
 * which makes the rule one race away from optional.
 * The asymmetry is deliberate: a refusal resting on that inference is TRANSIENT (no row is written, and
 * the next request that names its device decides again), whereas a device is only ever CLAIMED —
 * permanently — from an id the request itself sent (the trial_devices insert in ensureTrial).
 * No device on record at all (builds that never send one) → one free allowance per user, as always.
 * A read that fails throws, like every other entitlement read, so it can never become an allowance.
 */
async function deviceClaimedByAnother(userId, deviceId) {
  let device = deviceId || null;
  if (!device) {
    const seen = await dbConfig.query(
      'SELECT device_id FROM user_devices WHERE user_id = $1 ORDER BY last_seen DESC LIMIT 1', [userId]);
    device = seen && seen[0] ? seen[0].device_id : null;
  }
  if (!device) return false;
  const dev = await dbConfig.query('SELECT first_user_id FROM trial_devices WHERE device_id = $1', [device]);
  const owner = dev && dev[0] ? dev[0].first_user_id : null;
  return owner != null && Number(owner) !== Number(userId);
}

// ── core reads ────────────────────────────────────────────────────────────────────────────────
/**
 * The plan a user is entitled to IN ONE ENVIRONMENT. See services/storeEnvironment.js for why the
 * environment exists at all; the short version is that TestFlight StoreKit is always Sandbox, so
 * without this scope a $0 test purchase was a real production plan.
 *
 * The three cases in the WHERE clause, and why each is what it is:
 *   • store IS NOT NULL AND environment = $2 — a purchase earned in THIS environment. The only way
 *     a store-backed plan is ever honoured.
 *   • store IS NOT NULL AND environment <> $2 — invisible. A Sandbox row cannot satisfy a Production
 *     check and a Production row cannot satisfy a Sandbox one. This is the whole fix.
 *   • store IS NULL — admin/legacy grants (adminSetSubscription, source 'admin'). Environment-
 *     agnostic on purpose: they were never earned in a store, they are how comps and support fixes
 *     are issued today, and every one of them predates this column. Scoping them would silently
 *     revoke plans nobody bought.
 * A store row whose environment is NULL matches NOTHING — fail closed. Migration 036 backfills the
 * rows that predate the column and adds a CHECK so no new one can be written without it.
 *
 * @param {string} [environment] 'Production' | 'Sandbox'. Defaults to Production: every internal
 *        caller (nudges, admin screens, cron) is asking about real money, and an unrecognised value
 *        must never widen what is visible.
 */
async function activeSubscription(userId, environment = PRODUCTION) {
  const env = normalizeEnvironment(environment) || PRODUCTION;
  const rows = await dbConfig.query(
    `SELECT * FROM user_subscriptions
     WHERE user_id = $1 AND status = 'active' AND period_end > NOW()
       AND (store IS NULL OR environment = $2)
     -- ⚠️ A STORE ROW WINS, even against a comp that runs longer. Ordering by period_end alone
     -- meant an admin grant (source 'admin', no store, typically a generous 30 days) outranked the
     -- subscription the user is actually PAYING for, whose sandbox/monthly window is shorter. The
     -- paywall then reported the comp as "your plan": the real purchase was invisible, there was no
     -- way to see or manage it, and the obvious next move for the user is to buy it a second time.
     -- Store first, then the later expiry among equals.
     ORDER BY (store IS NOT NULL) DESC, period_end DESC LIMIT 1`, [userId, env]);
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
  const env = requestEnvironment(req || {});
  const sub = await activeSubscription(userId, env);
  const plan = sub ? planByKey(sub.plan_key) : null;
  const out = {
    plans: PLANS, trial: TRIAL,
    // The environment this answer was computed in. The app persists it off a verify/restore
    // response (services/storeEnv.ts) and echoes it back as x-store-env; surfacing it here is what
    // makes "why does my TestFlight plan not show up" answerable instead of a mystery.
    environment: env,
    // `store`/`autoRenew` let the paywall say "managed in the App Store" and hide a buy button that
    // would charge a second time on the other platform, instead of quietly selling a duplicate.
    subscription: sub ? {
      planKey: sub.plan_key, label: plan ? plan.label : sub.plan_key, periodEnd: sub.period_end,
      source: sub.source, store: sub.store || null, productId: sub.product_id || null,
      autoRenew: sub.auto_renew == null ? null : Boolean(sub.auto_renew),
      // A plan change the user has already made that has not started yet — both stores defer a
      // downgrade to the renewal date. Reporting it is what stops the screen looking as though the
      // change never happened, which is when people tap Buy a second time.
      pendingPlanKey: sub.pending_plan_key || null,
      pendingLabel: sub.pending_plan_key
        ? ((planByKey(sub.pending_plan_key) || {}).label || sub.pending_plan_key) : null,
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
    // ⚠️ remaining STAYS THE PLAN'S (the Plans/Usage bars are drawn against the plan's totals). What the user can
    // still make RIGHT NOW is remainingNow: once the plan's month is spent the free day pays (canConsumeMany), and
    // a screen reading only `remaining` told a paying user "Limit reached — see plans" while Generate worked.
    out.remainingNow = { ...out.remaining };
    if (out.remaining.letters === 0 || out.remaining.resumes === 0) {
      const t = await ensureTrial(userId, deviceId, ipHashOf(req || {})).catch(() => null);
      if (t && !t.blocked) {
        for (const [kind, f] of [['cover_letter', 'letters'], ['resume', 'resumes']]) {
          if (out.remaining[f] > 0) continue;
          const lane = await freeLaneOf(userId, kind, t.started_at, { withBonus: false });
          out.remainingNow[f] = lane.left;
        }
        out.freeFloor = true;
      }
    }
    return out;
  }
  // DIAGNOSTIC ONLY — never acted on. When a user holds a live store plan in the OTHER environment
  // we say so, because the alternative is a TestFlight tester (or the founder) staring at a paywall
  // that shows nothing after a purchase that visibly succeeded. The app must NOT switch environment
  // on the strength of this: an environment is adopted only from a fresh verify/restore, i.e. from
  // a purchase this build's own StoreKit actually produced. Reading it as permission would re-open
  // exactly the crossover this whole change closes.
  try {
    const other = await dbConfig.query(
      `SELECT environment FROM user_subscriptions
        WHERE user_id = $1 AND status = 'active' AND period_end > NOW()
          AND store IS NOT NULL AND environment IS NOT NULL AND environment <> $2
        ORDER BY period_end DESC LIMIT 1`, [userId, env]);
    out.otherEnvironmentSubscription = (other && other[0]) ? other[0].environment : null;
  } catch { out.otherEnvironmentSubscription = null; }

  const trial = await ensureTrial(userId, deviceId, ipHashOf(req || {}));
  if (trial && !trial.blocked) {
    // DAILY: the last 24 hours, so `active` is "not superseded by a paid plan" and what is left comes back
    // as each counted unit turns 24 hours old (nextAt).
    const L = await freeLaneOf(userId, 'cover_letter', trial.started_at, { withBonus: !sub });
    const R = await freeLaneOf(userId, 'resume', trial.started_at, { withBonus: !sub });
    const [nL, nR] = await Promise.all([
      L.left < L.allowance ? freeNextAt(userId, 'cover_letter', L.since).catch(() => null) : null,
      R.left < R.allowance ? freeNextAt(userId, 'resume', R.since).catch(() => null) : null,
    ]);
    out.trialState = {
      active: !sub, startedAt: trial.started_at, oneTime: false, daily: true,
      windowStart: L.since.toISOString(),
      // ⚠️ NULL, NOT A DATE: the window rolls, it has no end. When the next one opens is nextAt, per kind.
      endsAt: null, renewsAt: null,
      used: { letters: L.used, resumes: R.used },
      remaining: { letters: L.left, resumes: R.left },
      nextAt: { letters: nL ? nL.toISOString() : null, resumes: nR ? nR.toISOString() : null },
    };
    // ⚠️ A paid plan's own counts stay in remaining/used — filling these in when `sub` exists would
    // overwrite them. (A subscriber whose plan the catalogue knows never gets here: it returned above.)
    if (!sub) {
      out.used = { letters: L.used, resumes: R.used };
      out.remaining = { letters: L.left, resumes: R.left };
      out.bonus = { letters: L.allowance - FREE.letters, resumes: R.allowance - FREE.resumes };
      out.via = 'free';
      out.remainingNow = { ...out.remaining };
    }
  } else if (trial && trial.blocked) {
    out.trialState = { active: false, blocked: trial.blocked };
  }
  // Legacy credits: DISPLAY ONLY. Since 2026-09-13 they pay for no resume and no cover letter, so the
  // app must never word this balance as a way to keep generating.
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

  // ⚠️ ORDER IS LOAD-BEARING: plan → free daily, and NOTHING after them. There used to be a third lane —
  // legacy credits at the old per-event price — and it is gone on purpose (2026-09-13): credits no
  // longer pay for generation, and downloads never had a credit price. An exhausted allowance is
  // simply exhausted, and the answer is quota_exhausted, which every caller turns into the plans
  // screen. Which plan is visible is environment-scoped: a store plan from another environment is not.
  // ⚠️ SINCE 2026-10-29 THE FREE DAILY LANE IS EVERYONE'S FLOOR, a subscriber's too. A Starter plan has 6
  // resumes a month; a free user has 10 a day — refusing the subscriber at 6 while the free user carries on
  // would make paying the worse deal. So a spent plan falls through to the free lane (consumeOnSuccess
  // charges in the same order, one unit at a time: the plan's first, then the free day's). Downloads have
  // no free lane (FREE.downloads is 0), so a download is still plan or pass, exactly as before.
  const sub = await activeSubscription(userId, requestEnvironment(req || {}));
  let planLeft = 0;      // what the plan still has, for an honest refusal below
  let lane = null;       // the free daily lane, when it could be asked
  let blocked = null;    // why the free lane could not even be asked
  let saturated = false; // the global breaker (freeLaneSaturated) paused the free lane
  if (sub) {
    const plan = planByKey(sub.plan_key);
    if (plan) {
      const used = await usedSince(userId, kind, 'plan', '$4', [sub.period_start]);
      const allow = await allowanceIn(userId, kind, plan[field], sub.period_start);
      if (allow - used >= n) return { allowed: true, via: 'plan', remaining: allow - used };
      planLeft = Math.max(0, allow - used);
    }
  }
  if (hasFreeLane(kind)) {
    const trial = await ensureTrial(userId, deviceId, ipHashOf(req || {}));
    if (trial && !trial.blocked) {
      lane = await freeLaneOf(userId, kind, trial.started_at, { withBonus: !sub });
      if (lane.left > 0 && await freeLaneSaturated(kind)) { saturated = true; lane = { ...lane, left: 0 }; }
      if (planLeft === 0 && lane.left >= n) return { allowed: true, via: 'free', remaining: lane.left };
      // A batch (Generate All) the plan starts and the free day finishes: the first unit is the plan's.
      if (planLeft > 0 && planLeft + lane.left >= n) return { allowed: true, via: 'plan', remaining: planLeft + lane.left };
    } else if (trial) {
      blocked = trial.blocked;
    }
  }
  const left = planLeft + (lane ? lane.left : 0);

  // ── refused ──
  if (kind !== 'resume' && kind !== 'cover_letter') {
    return {
      allowed: false, via: null, reason: 'quota_exhausted',
      message: sub
        ? "You've used all the downloads in your plan this month. You can buy a single download, or upgrade in Plans & Usage."
        : 'Downloads are on paid plans. You can buy a single download instead.',
    };
  }
  const noun = kind === 'resume' ? 'resume generations' : 'cover letters';
  const leftNoun = left === 1 ? noun.slice(0, -1) : noun;   // "1 cover letter left", not "1 cover letters"
  // When the oldest free unit counted turns 24 hours old. Display only, and a failed read just says "within 24 hours".
  const nextAt = lane && lane.used > 0 && !saturated ? await freeNextAt(userId, kind, lane.since).catch(() => null) : null;
  const opens = opensInText(nextAt);
  // A batch the free day could NEVER hold (12 letters on a 10-a-day allowance): "more open up" would be a promise.
  const tooBig = !!lane && n > planLeft + lane.allowance;
  let message;
  if (saturated) {
    message = sub
      ? `You've used this month's ${noun} in your plan, and the daily ones are paused for a few hours. Upgrade in Plans & Usage to continue now.`
      : `Free ${noun} are paused for a few hours because of very high demand. A plan or a one-time pass still works now.`;
  } else if (sub && !lane) {
    // A subscriber whose free floor could not be asked (this device's free allowance is another account's).
    message = left > 0
      ? `You have ${left} ${leftNoun} left in your plan this month, not enough for ${n}. Upgrade in Plans & Usage to continue.`
      : `You've used all the ${noun} in your plan this month. Upgrade in Plans & Usage to continue.`;
  } else if (blocked === 'device_trial_used') {
    // Not "you've used your free ones": this account never had them — the device's allowance went to another.
    message = 'The free plan on this device was already used by another account. Start a plan in Plans & Usage to keep going.';
  } else if (blocked) {
    // trial_unavailable — the row could not be written. A transient failure, not a used-up allowance.
    message = "We couldn't check your free allowance just now. Please try again in a moment.";
  } else if (sub) {
    // ⚠️ NO WORD "free" IN A SUBSCRIBER'S SENTENCE. Store builds before 4.8 pick the allowance that ran out by
    // testing /free/ before /this month/ (BuildingOverlay.allowanceOf), and would tell a paying user their "free
    // generations are a one-time allowance — pick a plan". "daily ones" reads as the plan's sentence there.
    message = tooBig
      ? `You have ${left} ${leftNoun} left right now, not enough for ${n}. Upgrade in Plans & Usage to do more at once.`
      : left > 0
        ? `You have ${left} ${leftNoun} left right now, not enough for ${n}. More daily ones open up ${opens}, or upgrade in Plans & Usage.`
        : `You've used this month's ${noun} in your plan and today's ${FREE[field]} daily ones. The next daily one opens up ${opens}, or upgrade in Plans & Usage.`;
  } else {
    message = tooBig
      ? `The free plan makes up to ${FREE[field]} ${noun} a day, and you have ${left} left today — not enough for ${n} at once. Start a plan in Plans & Usage to do more.`
      : left > 0
        ? `You have ${left} free ${leftNoun} left today, not enough for ${n}. More open up ${opens}, or start a plan in Plans & Usage.`
        : `You've used today's ${FREE[field]} free ${noun}. The next one opens up ${opens}, or start a plan in Plans & Usage to keep going now.`;
  }
  return {
    allowed: false, via: null, reason: 'quota_exhausted', message,
    // ⚠️ never `blocked` on a subscriber's refusal: the device sentence is about the free plan, and the clients
    // render it as "this device's free plan belongs to another account" — not what a paying user ran out of.
    ...(blocked && !sub ? { blocked } : {}),
    ...(saturated ? { paused: true } : {}),
    ...(nextAt ? { nextFreeAt: nextAt.toISOString() } : {}),
  };
}

// ── the confirm sheet's numbers (display — NEVER a gate) ──────────────────────────────────────
/**
 * What is left of ONE kind in the pool that would pay for it — the line Home's confirm sheet shows BEFORE
 * anything is spent ("You have 2 of 3 free resume generations left", "12 of 15 left this month on Plus").
 *   → { kind, pool: 'free'|'plan'|null, planLabel, remaining, allowance, used, oneTime }   (null for an unknown kind)
 *   planLabel names a PAID plan ("Plus") and is null on the Free tier — the sheet says "free", never "on Free plan".
 *
 * ⚠️ THE SAME NUMBERS canConsumeMany ENFORCES, CLAUSE FOR CLAUSE. A sheet that says "1 left" while the gate
 * refuses (or "0 left" while it would allow) is the app quoting one allowance and billing another. So:
 *   • the plan is the ENVIRONMENT-SCOPED activeSubscription — a Sandbox plan is not a production pool;
 *   • a plan counts 'plan' rows since period_start, against plan[field] + quota_grants in that window
 *     (allowanceIn), and a subscriber is NEVER shown the free allowance — their usage is the plan's.
 *     A plan key the catalogue does not know pays for nothing there, so it shows allowance 0 here;
 *   • no plan → the Free row through ensureTrial, the SAME lazy first-use bookkeeping canConsumeMany (and
 *     every status read) already does, counted from freeWindowStart with source 'trial' — one-time, so
 *     `oneTime` is true and nothing here may ever read as "this month";
 *   • a device whose one free allowance another account holds ('device_trial_used'), or a Free row that could
 *     not be written ('trial_unavailable') → pool null, remaining 0, and `blocked` says which. Not "0 of 3
 *     left": that account never had the 3 (see canConsumeMany's device message). oneTime stays true — it is
 *     still the Free tier, and waiting refills nothing, so the sheet must not suggest it will.
 * `remaining` clamps at 0: usage over a cut allowance (see PLANS) is not a negative balance.
 * ⚠️ If canConsumeMany's lanes change, this must change with it.
 * ⚠️ DISPLAY ONLY. Nothing may decide covered / via / a charge from this — the gates and the builds ask
 * canConsumeMany themselves, at the moment they need the answer. A read that fails THROWS, like every
 * entitlement read: the caller shows no count, never a guessed one.
 */
async function usageFor(userId, kind, req) {
  const field = KIND_QUOTA_FIELD[kind];
  if (!field) return null;
  const deviceId = req ? deviceIdOf(req) : null;
  const sub = await activeSubscription(userId, requestEnvironment(req || {}));
  let planPool = null;
  if (sub) {
    const plan = planByKey(sub.plan_key);
    const used = await usedSince(userId, kind, 'plan', '$4', [sub.period_start]);
    if (!plan) {
      planPool = { kind, pool: 'plan', planLabel: sub.plan_key || null, remaining: 0, allowance: 0, used, oneTime: false };
    } else {
      const allowance = await allowanceIn(userId, kind, plan[field], sub.period_start);
      planPool = { kind, pool: 'plan', planLabel: plan.label, remaining: Math.max(0, allowance - used), allowance, used, oneTime: false };
    }
    // The plan pays while it has any left — the gate's first clause.
    if (planPool.remaining > 0 || !hasFreeLane(kind)) return planPool;
  }
  // No plan, or a spent one: the free daily lane is what pays next (the gate's second clause).
  const trial = await ensureTrial(userId, deviceId, ipHashOf(req || {}));
  if (!trial || trial.blocked) {
    // A subscriber whose free floor is unavailable is still on their plan — show that, at 0, not a device message.
    if (planPool) return planPool;
    return {
      kind, pool: null, planLabel: null, remaining: 0, allowance: 0, used: 0, oneTime: false, daily: true,
      blocked: (trial && trial.blocked) || 'trial_unavailable',
    };
  }
  const lane = await freeLaneOf(userId, kind, trial.started_at, { withBonus: !sub });
  const nextAt = lane.used > 0 ? await freeNextAt(userId, kind, lane.since).catch(() => null) : null;
  return {
    kind, pool: 'free', planLabel: null, remaining: lane.left, allowance: lane.allowance, used: lane.used,
    oneTime: false, daily: true, nextAt: nextAt ? nextAt.toISOString() : null,
  };
}

// ── the deduction — call ONLY after the work succeeded ────────────────────────────────────────
// Picks the pool in the same priority order as the gate (plan → free) and writes the ledger row, with
// details for the Usage screen. Never throws, and never touches a credit balance.
//
// Returns { via, charge, ledgerId }:
//   • via — 'plan', or 'trial' (the Free plan's ledger spelling, see below), when a pool paid.
//     'none' when NOTHING that may pay still can: the gate said yes, then the last unit went to an
//     overlapping build before this ran (canConsumeMany checks, it never reserves). No row is written
//     and nothing is charged. The Home doc/letter lanes read an unrecognised via as "not confirmed paid"
//     and refuse without storing, and every generation lane refuses it with 402 quota_exhausted and delivers nothing, so the
//     race never stores a free document; the letter lanes (coverLetterController, employerLetterController, the Job Hub lane) refuse it too, as
//     they logged a credits lane that deducted nothing. Home's coveredOnly re-check runs in the same usage
//     lock just before this call, so there only a lane that takes no lock can still cause it.
//     'error' when recording failed.
//     ⚠️ NEVER 'credits' ANY MORE (2026-09-13). This used to fall through to the legacy pool, which is
//     exactly how a generation would be paid in credits nobody agreed to after credits stopped paying
//     for generation at all.
//   • charge — ALWAYS null now; nothing here deducts. Kept rather than deleted because the lanes test
//     hasOwnProperty('charge') to know this answer is authoritative — without it they fall back to
//     inferring a credit deduction from history, which is the inference this field replaced.
//   • ledgerId — the usage_ledger row THIS call inserted, so a caller that cannot deliver what was
//     paid for (a store that failed) can delete exactly that row and give the unit back.
async function consumeOnSuccess(userId, kind, detail = {}, req) {
  const charge = null;
  try {
    const deviceId = req ? deviceIdOf(req) : null;
    // Same environment scope as the gate. If these two disagreed, a sandbox tester would be let
    // through canConsumeMany and then billed against the wrong allowance by consumeOnSuccess.
    const sub = await activeSubscription(userId, requestEnvironment(req || {}));
    let via = null;
    if (sub && planByKey(sub.plan_key)) {
      const plan = planByKey(sub.plan_key);
      const used = await usedSince(userId, kind, 'plan', '$4', [sub.period_start]);
      const allow = await allowanceIn(userId, kind, plan[KIND_QUOTA_FIELD[kind]], sub.period_start);
      if (allow - used >= 1) via = 'plan';
    }
    // The free daily lane — a free user's only lane and a subscriber's floor once the plan is spent
    // (the gate's order, unit by unit).
    if (!via && hasFreeLane(kind)) {
      const trial = await ensureTrial(userId, deviceId, null);
      if (trial && !trial.blocked) {
        const lane = await freeLaneOf(userId, kind, trial.started_at, { withBonus: !sub });
        // ⚠️ THE LEDGER SOURCE STAYS 'trial'. usage_ledger.source is what usedSince() matches on,
        // and every free-tier row ever written carries 'trial'. Writing 'free' here would make the
        // counter stop seeing the new rows — every user would silently get unlimited free
        // generations. The user-facing name changed; the stored label must not.
        if (lane.left >= 1) via = 'trial';
      }
    }
    if (!via) {
      console.warn(`[entitlements] consumeOnSuccess: no allowance left for ${kind} (user ${userId}) — nothing recorded, nothing charged`);
      return { via: 'none', charge, ledgerId: null };
    }
    // detail.env — the store environment that PAID (the gate's, carried in by the caller). usage_ledger has no
    // environment column, and without this a TestFlight row and an App Store row were indistinguishable: a user
    // counting their letters could not see that one was made on the other build (whose Home shows its own letters).
    const rows = await dbConfig.query(
      `INSERT INTO usage_ledger (user_id, kind, source, plan_key, detail, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
       RETURNING id`,
      // plan_key only on a row the plan paid — a subscriber's free-floor row is the free day's, not the plan's.
      [userId, kind, via, via === 'plan' ? sub.plan_key : null,
       JSON.stringify({ ...detail, env: requestEnvironment(req || {}) }).slice(0, 4000)]);
    const id = rows && rows[0] ? Number(rows[0].id) : NaN;
    return { via, charge, ledgerId: Number.isFinite(id) && id > 0 ? id : null };
  } catch (e) {
    console.warn('[entitlements] consumeOnSuccess:', e.message);
    return { via: 'error', charge, ledgerId: null };
  }
}

// ── usage screen data ─────────────────────────────────────────────────────────────────────────
/**
 * The pool that is paying NOW, as the ledger spells it → { source, since } | null. The same clauses as
 * canConsumeMany / usageFor: an environment-scoped plan counts 'plan' rows since period_start; no plan → the Free
 * allowance, 'trial' rows since freeWindowStart. ⚠️ READ-ONLY: it opens no Free row (ensureTrial is the gate's
 * business) — with none yet, the window is the cutover, the earliest any account can have.
 */
async function payingPoolOf(userId, req) {
  const sub = await activeSubscription(userId, requestEnvironment(req || {}));
  const rows = await dbConfig.query('SELECT started_at FROM user_trials WHERE user_id = $1', [userId]);
  const free = { source: 'trial', since: freeWindowStart(rows && rows[0] ? rows[0].started_at : null) };
  // A subscriber's free-day rows (written once the plan's month was spent) count against today's free allowance,
  // so they are counted too — not filed under "before your current allowance".
  if (sub) return { source: 'plan', since: new Date(sub.period_start), also: free };
  return free;
}

/**
 * The ledger for the Usage screen, newest first. Each row says `counted`: whether it is one of the rows the paying
 * pool counts right now (its source, since its window start) — so "3 used" can be matched against exactly three rows.
 * ⚠️ THE LIST WAS EVERY ROW EVER WRITTEN, with nothing to tell them apart: pre-cutover history and an earlier plan's
 * period sat between the rows that count, and a user adding up "which three letters" could not. `counted` is null
 * when the pool could not be read — the screen then shows the rows as it always did, never a guess.
 */
async function getUsage(userId, limit = 100, req = null) {
  const rows = await dbConfig.query(
    `SELECT id, kind, source, plan_key, detail, created_at FROM usage_ledger
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 300)]);
  let pool = null;
  try { pool = await payingPoolOf(userId, req); }
  catch (e) { console.warn('[entitlements] getUsage: the paying pool is unreadable —', e.message); }
  const sinceMs = pool ? pool.since.getTime() : NaN;
  const also = pool && pool.also ? pool.also : null;
  return (rows || []).map((r) => ({
    id: r.id, kind: r.kind, source: r.source, planKey: r.plan_key,
    detail: typeof r.detail === 'object' ? r.detail : (() => { try { return JSON.parse(r.detail); } catch { return {}; } })(),
    createdAt: r.created_at,
    counted: pool && Number.isFinite(sinceMs)
      ? ((r.source === pool.source && new Date(r.created_at).getTime() >= sinceMs)
        || (!!also && r.source === also.source && new Date(r.created_at).getTime() >= also.since.getTime()))
      : null,
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
// ⚠️ period_end IS THE STORE'S NUMBER. Not GREATEST(old, new), not a guess, not a floor. It used to
// be GREATEST(old, new) "so an out-of-order delivery can only move access forward", and that was a
// free-money bug: a Play plan change is charged by PRORATION, which pays $0 today and SHORTENS the
// expiry. Keeping the old, longer expiry handed the user the new tier AND the old tier's remaining
// days for nothing. There is no need for the floor either — nothing in this file writes a value a
// notification claimed. Both callers (services/storeSubscriptions.js) re-read Apple/Google over TLS
// immediately before calling in, so EXCLUDED.period_end is the store's answer as of seconds ago; a
// re-ordered notification just makes us ask the store again and get the same current truth. The
// worst a stale in-flight read can now do is expire access a few seconds early, which the next
// notification or the app's own verify-on-launch corrects. The old behaviour's worst case was a
// free month.
//
// ⚠️ period_start IS THE QUOTA WINDOW, AND IT ONLY MOVES WHEN THE USER PAYS. usedSince() counts
// every generation since period_start against the plan's allowance, so advancing it mints a fresh
// bucket of letters. It therefore advances on exactly one signal: the store reporting a NEW PAID
// transaction (Apple transactionId / Play latestOrderId changing — both are minted per payment).
// It is deliberately NOT keyed on:
//   • plan_key changing — that was the other half of the free-quota bug. A mid-cycle tier change
//     is not a new billing period; the user pays a prorated difference for the SAME window, so the
//     allowance grows and what they already spent still counts against it.
//   • period_end moving forward — a billing-retry grace period and Apple's goodwill extensions both
//     push the expiry out with no payment behind them, and that used to reset the window in full.
// Unknown/absent transaction id → the window does not move. Failing closed here costs a user
// nothing they paid for; failing open costs a month of quota per event.
//
// Legacy credits are untouched by every path in here.
async function storeSetSubscription({
  userId, planKey, source, productId, originalTxnId,
  periodStart = null, periodEnd, status = 'active', terminal = false,
  purchaseToken = null, latestTxnId = null, environment = null,
  autoRenew = null, acknowledged = null, storeState = null, supersede = true,
  // The plan this subscription will RENEW into, when the store says that differs from the live one
  // (a deferred downgrade). Authoritative and always overwritten, never COALESCEd: a user who
  // cancels a scheduled change must see it disappear, and only the store knows it has gone.
  pendingPlanKey = null,
}) {
  const uid = parseInt(userId, 10);
  if (!Number.isFinite(uid) || uid <= 0) return { error: 'invalid_user' };
  if (!planByKey(planKey)) return { error: 'unknown_plan' };
  if (source !== 'apple' && source !== 'google') return { error: 'invalid_source' };
  const txn = String(originalTxnId || '').trim();
  if (!txn) return { error: 'missing_original_transaction_id' };
  const end = periodEnd instanceof Date ? periodEnd : new Date(periodEnd);
  if (!end || isNaN(end.getTime())) return { error: 'invalid_period_end' };
  let start = periodStart ? new Date(periodStart) : null;
  if (start && isNaN(start.getTime())) return { error: 'invalid_period_start' };
  // ⚠️ A quota window may not start in the FUTURE. usedSince() counts `created_at >= period_start`,
  // so a future start counts NOTHING, for as long as it lasts — an unmetered plan, not a generous
  // one. It is reachable without any bug of ours: Play's WITH_TIME_PRORATION converts the unused
  // value of an expensive plan into TIME on a cheap one (25 days of Max ≈ 250 days of Starter), and
  // the cycle start storeSubscriptions.js derives from the store's expiry then lands months ahead.
  // The app no longer asks for that mode, but old installs still can, so the ceiling lives here at
  // the write rather than in the client that happens to be current. Clamping only ever makes MORE
  // usage count, never less.
  if (start && start.getTime() > Date.now()) start = new Date();
  // `terminal` (refund / revoke / chargeback) no longer needs its own SQL branch: period_end is the
  // store's number unconditionally now, and a terminal event arrives carrying an expiry of NOW().
  // It stays in the signature as an assertion — a caller that says "this entitlement is finished"
  // while also saying "status: active" has computed something self-contradictory, and writing that
  // row would leave a refunded user with live access. Refuse rather than pick one of the two.
  if (terminal && status === 'active') return { error: 'terminal_with_active_status' };
  // ⚠️ THE SANDBOX GATE. A store row without a known environment cannot be scoped, and an unscoped
  // row is exactly the bug: a TestFlight $0 purchase satisfying a production quota check. Both
  // callers always know the answer — Apple names the environment in the signed payload AND by which
  // host answered, Google by testPurchase — so this is unreachable in normal operation. When it
  // does fire the caller returns 503 (see subscriptionPurchaseController.DENIED), the transaction
  // stays unfinished, and the retry succeeds. Nothing is lost; nothing is granted on a guess.
  const env = normalizeEnvironment(environment);
  if (!env) return { error: 'unknown_environment' };

  // ONE transaction. The upsert and the supersede are the two halves of the invariant "exactly one
  // active entitlement per user"; run apart, a failure between them leaves the user holding two
  // active rows. Note the shape here is already replay-safe in a way the consumable credit path was
  // not: this SETS absolute state (plan, window, expiry) computed from the store's own answer — it
  // never ADDS to a balance — so a redelivered notification converges instead of granting twice.
  return await dbConfig.withTransaction(async (tx) => {
  const rows = await tx.query(
    `INSERT INTO user_subscriptions
       (user_id, plan_key, status, source, product_id, store, original_transaction_id,
        purchase_token, latest_transaction_id, environment, auto_renew, acknowledged, store_state,
        pending_plan_key, period_start, period_end, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$4,$6,$7,$8,$9,$10,COALESCE($11,FALSE),$12,$15,
             COALESCE($13, NOW()), $14, NOW(), NOW())
     -- ⚠️ environment IS PART OF THE KEY (Migration 036). Apple's Sandbox and Production
     -- originalTransactionId namespaces are independent small integers and CAN collide, so the old
     -- two-column key let a sandbox test purchase upsert straight onto a paying customer's row —
     -- rewriting their plan, window and expiry from a $0 transaction. Keyed this way the two
     -- environments cannot address the same row at all.
     ON CONFLICT (store, environment, original_transaction_id)
       WHERE store IS NOT NULL AND original_transaction_id IS NOT NULL AND environment IS NOT NULL
     DO UPDATE SET
       plan_key   = EXCLUDED.plan_key,
       status     = EXCLUDED.status,
       product_id = EXCLUDED.product_id,
       purchase_token        = COALESCE(EXCLUDED.purchase_token, user_subscriptions.purchase_token),
       latest_transaction_id = COALESCE(EXCLUDED.latest_transaction_id, user_subscriptions.latest_transaction_id),
       -- environment is NOT assigned here: it is a key column now, so the matched row already has
       -- this exact value. Letting it be updated would mean a row could change environment.
       auto_renew            = COALESCE(EXCLUDED.auto_renew, user_subscriptions.auto_renew),
       acknowledged          = user_subscriptions.acknowledged OR EXCLUDED.acknowledged,
       store_state           = COALESCE(EXCLUDED.store_state, user_subscriptions.store_state),
       -- Deliberately NOT COALESCEd: NULL is a real answer here ("renews as-is"), and it is the
       -- answer whenever a user cancels a scheduled downgrade. Keeping the old value would leave
       -- the paywall promising a plan change that is no longer going to happen.
       pending_plan_key      = EXCLUDED.pending_plan_key,
       -- ⚠️ THE MONEY LINES. Read the two period_start / period_end notes above this function before
       -- changing either — between them they decide whether a month of quota is sold or given away.
       --
       -- The window advances ONLY when the store minted a new PAID transaction (Apple mints a new
       -- transactionId per charge, Play a new latestOrderId), and then only forwards. Not on a plan
       -- change, not on an expiry extension, not on a replay.
       --
       -- $13, not EXCLUDED.period_start: the VALUES list COALESCEs that column to NOW(), so using
       -- EXCLUDED here would read "the caller told us no start date" as "open a fresh window today".
       -- The outer GREATEST keeps it monotonic — Google's subscriptionsv2 startTime is when the
       -- subscription was FIRST granted, so anything derived from it must never be allowed to rewind
       -- the window to the signup date; usedSince() would then bill this month's allowance for every
       -- cover letter the user has ever generated.
       period_start = GREATEST(user_subscriptions.period_start, CASE
         WHEN $13::timestamptz IS NOT NULL
          AND EXCLUDED.latest_transaction_id IS NOT NULL
          AND EXCLUDED.latest_transaction_id IS DISTINCT FROM user_subscriptions.latest_transaction_id
           THEN $13::timestamptz
         ELSE user_subscriptions.period_start END),
       -- Exactly what the store says, in both directions. A refund/revoke arrives as an expiry of
       -- NOW() and so needs no special case; a proration that shortens the term is honoured instead
       -- of being floored back to the term the user no longer has.
       period_end = EXCLUDED.period_end,
       updated_at = NOW()
     RETURNING *, (xmax = 0) AS _inserted`,
    [uid, planKey, status, source, productId || null, txn, purchaseToken, latestTxnId,
     env, autoRenew, acknowledged, storeState, start, end,
     pendingPlanKey && planByKey(pendingPlanKey) ? pendingPlanKey : null]
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

  // One active entitlement per user, PER ENVIRONMENT. This is still the "subscribed on both stores"
  // fix: whichever store wrote last wins, the other row goes to 'superseded', and the paywall can
  // tell the user where the live subscription is managed instead of quietly billing them twice.
  //
  // ⚠️ THE ENVIRONMENT SCOPE IS NOT COSMETIC. Unscoped, this statement was a second, independent way
  // for a sandbox purchase to reach production: the founder verifying a $0 TestFlight purchase would
  // mark their own REAL paid subscription 'superseded' and lose it, and the same would happen to any
  // user who is also a tester. A Sandbox write therefore only supersedes Sandbox rows.
  //
  // A Production write additionally retires admin/legacy rows (store IS NULL) — they are
  // environment-agnostic comps, and a real payment should replace one. A Sandbox write must not
  // touch them: a test purchase cannot take away a comp somebody was given.
  if (supersede && row.status === 'active' && new Date(row.period_end) > new Date()) {
    await tx.query(
      `UPDATE user_subscriptions SET status = 'superseded', updated_at = NOW()
        WHERE user_id = $1 AND id <> $2 AND status = 'active'
          AND (environment = $3 OR ($3 = '${PRODUCTION}' AND store IS NULL))`,
      [claimedBy, row.id, env]);
  }
  return { ok: true, created, transferBlocked, row, environment: env };
  });
}

/**
 * The store-backed row for a user, if any (used by the paywall to say where it is managed).
 * Environment-scoped like every other entitlement read — a Sandbox row must not make a production
 * paywall claim the user already has a subscription somewhere.
 */
async function storeSubscriptionFor(userId, environment = PRODUCTION) {
  const env = normalizeEnvironment(environment) || PRODUCTION;
  const rows = await dbConfig.query(
    `SELECT * FROM user_subscriptions
      WHERE user_id = $1 AND store IS NOT NULL AND environment = $2
      ORDER BY period_end DESC LIMIT 1`, [userId, env]);
  return (rows && rows[0]) || null;
}

module.exports = {
  PLANS, TRIAL, FREE, FREE_CUTOVER,
  reportDevice, ensureTrial, getStatus, canConsumeMany, consumeOnSuccess, getUsage,
  // The confirm sheet's "N of M left" — the gate's numbers, for display only (see usageFor).
  usageFor,
  adminSetSubscription, storeSetSubscription, storeSubscriptionFor, deviceIdOf, ipHashOf,
  // exported for the lifecycle nudges (which must know what a user has LEFT before offering more)
  activeSubscription, usedSince, bonusSince, allowanceIn, planByKey, KIND_QUOTA_FIELD,
  // The free plan's counting start (the last 24 hours), its absent end, and when the next unit opens. Exported
  // so the admin screens and bonus grants count "used" exactly the way the app does.
  freeWindowStart, freeWindowEnd, freeNextAt, opensInText, FREE_DAY_MS, FREE_GLOBAL_DAILY_CAP,
  // re-exported so callers do not have to know where the environment vocabulary lives
  PRODUCTION, normalizeEnvironment, requestEnvironment,
};
