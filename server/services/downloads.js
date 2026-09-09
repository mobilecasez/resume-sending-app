// Who may download a finished document, and what that costs them.
//
// There are two ways to pay:
//   • a PLAN, which now carries a monthly download allowance; or
//   • a PASS — one employer, bought outright, for people who do not want a subscription.
//
// This module is the ONLY place that answers either question. The gate used to be five
// copy-pasted `activeSubscription(userId) || 403` checks across the resume and cover-letter
// controllers; five copies of a money decision is five chances for them to drift apart.
//
// ⚠️ A PASS BUYS AN EMPLOYER, NOT A FILE. Once it is spent on a company, everything for that
// company is unlocked: every resume design, every format, and the cover letter as well. Someone
// applying to one job pays once and is done — they are never charged again for choosing a different
// design, or for wanting the Word version, or for the letter that goes with the resume.
//
// ⚠️ CLAIM AFTER THE BYTES EXIST, NEVER AT THE GATE. The PDF path can still fall through Playwright
// to PDFKit and either can throw. Charging at the gate means the first support ticket is "I paid
// and got an error". (The AI generations are the one exception, and for a reason spelled out at
// passCoversGeneration: an AI call is a minute long and real money, so its pass is RESERVED at the
// gate and only STAMPED on success.)
//
// ⚠️ THE GATE AND THE CLAIM MUST NEVER DISAGREE. Every "yes" here has to be followed by a claim
// that actually charges something. A gate that admits what the claim declines to bill is not a
// leniency — it is unlimited free downloads for one payment. See the '(none)' scope below.
'use strict';
const dbConfig = require('../../db-config');
const entitlements = require('./entitlements');
const { PRODUCTION, SANDBOX, requestEnvironment } = require('./storeEnvironment');

/** The scope a download with no company at all is charged into. Any real employer can take it over. */
const NONE = '(none)';

/**
 * The environment to read passes in. Accepts a request OR a plain environment string:
 * the cover-letter charge happens inside an async worker that runs AFTER the response,
 * so it has no req to derive one from and must be handed the value decided at gate time.
 */
function envOf(reqOrEnv) {
  if (reqOrEnv === PRODUCTION || reqOrEnv === SANDBOX) return reqOrEnv;
  return requestEnvironment(reqOrEnv || {});
}

/**
 * ⚠️ THE PLAN ALLOWANCE SHIPS OFF.
 *
 * Downloads have always been unlimited on a paid plan. Metering them is a REDUCTION of something
 * people already bought, so it must not switch itself on the moment this file is deployed — and it
 * must not switch on before the app can actually sell a pass, or a subscriber who hits the new
 * ceiling has no way to pay and simply loses the feature.
 *
 * Set DOWNLOADS_METERED=1 only when the store products are live and the app ships the sheet.
 * With it off, a paid plan behaves exactly as it does today: unlimited.
 */
const METERED = process.env.DOWNLOADS_METERED === '1';

const PASS_PRODUCT_ID = 'com.cvapplyr.mobile.download.single';

/**
 * The employer a download belongs to, normalised.
 *
 * ⚠️ This is the identity a PAYMENT is attached to, so it has to be stable across the two screens
 * that use it — the resume gallery knows the company from the Home target, the letter flow knows it
 * as `companyName`. Case and surrounding punctuation must not create a second, unpaid employer.
 * A download with no employer at all gets its own scope rather than unlocking everything.
 */
function employerKeyOf(name) {
  const k = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return k || NONE;
}

/**
 * Every spelling of a company that means the same company.
 *
 * ⚠️ EXACT STRING EQUALITY IS NOT AN IDENTITY, AND CHARGING ON IT TAKES MONEY TWICE.
 * The letter side stores whatever the AI read off the posting ("Acme Corporation GmbH"), or the
 * recipient's website when it found no name at all ("https://acme.com/careers"); the resume side
 * sends the dashboard's own name ("Acme Corp"). Three strings, one company — and under exact
 * matching the pass bought on one screen is invisible to the other, so the user is asked to pay a
 * second time for what they already own.
 *
 * So: reduce a URL to its own label, drop the legal suffixes that differ between databases, and
 * compare what is left. This can only ever be too GENEROUS — two sibling brands sharing a name
 * would unlock each other, which costs us a dollar. The other direction costs the USER a dollar
 * for something they already bought, and that is the failure worth engineering against.
 */
const LEGAL_WORDS = new Set([
  'inc', 'llc', 'llp', 'ltd', 'limited', 'gmbh', 'mbh', 'ag', 'sa', 'sas', 'sarl', 'bv',
  'nv', 'plc', 'corp', 'corporation', 'co', 'company', 'pvt', 'private', 'pte', 'srl', 'spa',
  'oy', 'oyj', 'ab', 'as', 'asa', 'aps', 'kg', 'kgaa', 'ug', 'se', 'group', 'holding', 'holdings',
  'international', 'global', 'worldwide', 'the', 'and', 'of',
]);

function aliasKeysOf(name) {
  const out = new Set();
  let s = String(name || '').trim().toLowerCase();
  if (!s || s === NONE) return out;

  // A URL or a bare host is a spelling too: "https://www.acme.co.uk/jobs" is the company "acme".
  const host = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) s = host.split('.')[0].replace(/-/g, ' ');

  const words = s.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return out;
  out.add(words.join(' '));
  out.add(words.join(''));
  const core = words.filter((w) => !LEGAL_WORDS.has(w));
  if (core.length) { out.add(core.join(' ')); out.add(core.join('')); }
  return out;
}

/** Do two spellings name the same company? */
function sameEmployer(a, b) {
  if (employerKeyOf(a) === employerKeyOf(b)) return true;
  const A = aliasKeysOf(a);
  if (!A.size) return false;
  for (const k of aliasKeysOf(b)) if (A.has(k)) return true;
  return false;
}

/**
 * Pick which of several spellings of "the employer" a payment should attach to.
 *
 * ⚠️ THIS EXISTS BECAUSE THE SCREENS DISAGREE, AND A USER MUST NOT PAY FOR THAT.
 * The resume side sends the Home target's `target.company` ("Acme Corp"). The letter side sends
 * `companyName`, which is `aiResult.employer_name || recipient.website || hint` — the AI's reading
 * of the posting, and a URL when it could not find a name at all. Same company, two strings, two
 * employer keys, and the pass bought for the resume did not cover the letter: one payment, and
 * they are asked for a second at the same company. That is the exact promise the feature makes.
 *
 * Forcing the clients to agree forever is the fragile fix — every new entry point would have to
 * remember. Instead: given every spelling the caller knows, if ANY of them already owns a pass,
 * that pass's OWN spelling is returned, so every check downstream matches it exactly. Only when
 * none is owned do we fall back to the first non-empty candidate, so a new company still binds
 * normally.
 *
 * Takes a req OR an environment string (envOf), because the letter worker has no req.
 */
async function resolveEmployer(userId, candidates, reqOrEnv) {
  const env = envOf(reqOrEnv);
  const seen = new Set();
  const list = (Array.isArray(candidates) ? candidates : [candidates])
    .map((c) => (typeof c === 'string' ? c.trim() : ''))
    .filter((c) => {
      if (!c) return false;
      const k = employerKeyOf(c);
      if (seen.has(k) || k === NONE) return false;
      seen.add(k);
      return true;
    });

  for (const c of list) {
    try {
      const owned = await boundPassFor(userId, c, env);       // already paid for — use its spelling
      if (owned) return owned.employer_name || c;
    } catch { /* a lookup failure must not decide the employer */ }
  }
  return list[0] || null;
}

/** Everything the caller needs to render the button, and to know what a tap will cost. */
async function downloadState(userId, employerName, req) {
  const env = requestEnvironment(req || {});
  const sub = await entitlements.activeSubscription(userId, env).catch(() => null);
  const [passes, owned] = await Promise.all([
    unboundPassCount(userId, env),
    boundPassFor(userId, employerName, env),
  ]);
  const base = { passes, ownsEmployer: !!owned, employer: employerName || null };
  if (!METERED) {
    return { ...base, metered: false, paid: !!sub, remaining: null, unlimited: !!sub };
  }
  if (!sub) return { ...base, metered: true, paid: false, remaining: 0, unlimited: false };
  const gate = await entitlements.canConsumeMany(userId, 'download', 1, req).catch(() => null);
  return {
    ...base, metered: true, paid: true, unlimited: false,
    remaining: gate && typeof gate.remaining === 'number' ? gate.remaining : 0,
  };
}

// ⚠️ EVERY PASS QUERY IS SCOPED TO THE REQUEST'S ENVIRONMENT, exactly as activeSubscription is.
// Sandbox purchases are real purchases as far as the store is concerned but cost nothing, so a
// sandbox pass that satisfied a production download would be free downloads for anyone with a
// test account. Migration 036 exists because this same mistake was once made with subscriptions.
//
// ⚠️ "UNSPENT" INCLUDES A PASS BOUND TO '(none)'. A download that names no company still spends the
// pass (see claimDownload), but into a scope no real employer occupies — so it stays takeable by
// the first download or generation that DOES name one. Counting it here is what makes that takeover
// safe: the user is never told they own nothing while a takeable pass is sitting right there.
async function unboundPassCount(userId, env = PRODUCTION) {
  try {
    const r = await dbConfig.get(
      `SELECT COUNT(*)::int AS n FROM download_passes
        WHERE user_id = $1 AND environment = $2
          AND (bound_at IS NULL OR employer_key = $3)`, [userId, env, NONE]);
    return r ? (r.n || 0) : 0;
  } catch { return 0; }
}

/**
 * A pass already spent on this employer — everything for them is free from then on.
 *
 * Exact key first (the common case); then, because the screens spell companies differently, any
 * bound pass whose stored name is the SAME COMPANY under another spelling. '(none)' matches only
 * itself — the nameless scope must never be reached by fuzzy matching — but it DOES match itself,
 * which is what makes a second nameless download free rather than a second rebinding write.
 */
async function boundPassFor(userId, employerName, env = PRODUCTION) {
  const key = employerKeyOf(employerName);
  try {
    const exact = await dbConfig.get(
      `SELECT id, employer_name, employer_key FROM download_passes
        WHERE user_id = $1 AND employer_key = $2 AND environment = $3 AND bound_at IS NOT NULL
        LIMIT 1`, [userId, key, env]);
    if (exact || key === NONE) return exact || null;

    const rows = await dbConfig.query(
      `SELECT id, employer_name, employer_key FROM download_passes
        WHERE user_id = $1 AND environment = $2 AND bound_at IS NOT NULL AND employer_key <> $3`,
      [userId, env, NONE]);
    for (const r of rows || []) {
      if (sameEmployer(employerName, r.employer_name || r.employer_key)) return r;
    }
    return null;
  } catch { return null; }
}

/**
 * May this download happen? Answers WITHOUT spending anything — call claimDownload afterwards,
 * once the file actually exists.
 *
 * ⚠️ ORDER IS MONEY. The PLAN is asked before the one-off, deliberately: while downloads are
 * unmetered a subscriber's download is free, so consulting the pass first would spend the single
 * employer choice they paid for and hand back nothing. Under metering the same order still holds —
 * plan allowance is perishable and expires monthly, a pass does not.
 */
async function canDownload(userId, { employer = null } = {}, req) {
  const env = requestEnvironment(req || {});
  if (await boundPassFor(userId, employer, env)) return { allowed: true, via: 'pass_owned' };

  const sub = await entitlements.activeSubscription(userId, env).catch(() => null);
  let gate = null;
  if (!METERED) {
    if (sub) return { allowed: true, via: 'plan_unlimited' };
  } else {
    gate = await entitlements.canConsumeMany(userId, 'download', 1, req);
    if (gate.allowed) return { allowed: true, via: 'plan', remaining: gate.remaining };
  }

  if (await unboundPassCount(userId, env) > 0) return { allowed: true, via: 'pass' };
  if (!METERED) return { allowed: false, reason: 'paid_required', message: 'Downloads are on paid plans.' };
  return { allowed: false, reason: sub ? 'quota_exhausted' : 'paid_required', message: gate && gate.message };
}

/**
 * Spend it. Call ONLY once the document exists.
 *
 * ⚠️ Atomic by construction: the pass is claimed with a single conditional UPDATE ... RETURNING, so
 * two taps racing each other cannot both win it. A SELECT-then-UPDATE here would let the PDF and
 * the Word button each bind their own pass.
 */
async function claimDownload(userId, { employer = null } = {}, req) {
  const env = requestEnvironment(req || {});
  if (await boundPassFor(userId, employer, env)) return { via: 'pass_owned', charged: false };

  // ⚠️ A PLAN THAT ALREADY COVERS THIS DOWNLOAD MUST NOT EAT AN UNSPENT ONE-OFF.
  // Unmetered, a subscriber's download is free — binding the pass here would spend the single
  // employer choice they paid for and give nothing back for it.
  const sub = await entitlements.activeSubscription(userId, env).catch(() => null);
  if (sub) {
    if (!METERED) return { via: 'plan_unlimited', charged: false };
    const gate = await entitlements.canConsumeMany(userId, 'download', 1, req).catch(() => null);
    if (gate && gate.allowed) {
      try {
        await entitlements.consumeOnSuccess(userId, 'download', { employer, screen: 'download' }, req);
      } catch (e) {
        console.warn('[downloads] usage record failed:', e.message);   // never fail a paid-for download
      }
      return { via: 'plan', charged: true };
    }
  }

  // ⚠️ A NAMELESS DOWNLOAD IS CHARGED INTO '(none)', NOT WAIVED.
  // Not every route into the design gallery carries the company: opening it from the resume
  // editor's "Download / Preview" pushed no employer param, so this arrived as null. Waiving the
  // charge there was worse than it looked — the SAME nameless entry point can be used forever, so
  // one $0.99 pass bought every design in every format for every company for the life of the
  // account. It also broke the rule at the top of this file: the gate said yes to something the
  // claim would not bill.
  //
  // So bind it — but into a scope no company occupies. `unboundPassCount` still counts a
  // '(none)'-bound pass as unspent and both claim paths still select it, so the first download or
  // AI generation that DOES name a company TAKES IT OVER and the user gets exactly what they paid
  // for. Until then further nameless downloads are free: boundPassFor matches its own '(none)'
  // scope, so it cannot rebind in a loop.
  const key = employerKeyOf(employer);
  try {
    const claimed = await dbConfig.get(
      `UPDATE download_passes
          SET employer_key = $2, employer_name = $3, bound_at = NOW()
        WHERE id = (
          SELECT id FROM download_passes
           WHERE user_id = $1 AND environment = $4
             AND (bound_at IS NULL OR employer_key = $5)
           ORDER BY (bound_at IS NOT NULL) DESC, created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
      [userId, key, employer || null, env, NONE]);
    if (claimed) return { via: 'pass', charged: true, passId: claimed.id };
  } catch (e) {
    console.warn('[downloads] pass claim failed:', e.message);
  }

  if (!METERED) return { via: 'plan_unlimited', charged: false };
  try {
    await entitlements.consumeOnSuccess(userId, 'download', { employer, screen: 'download' }, req);
  } catch (e) {
    console.warn('[downloads] usage record failed:', e.message);   // never fail a paid-for download
  }
  return { via: 'plan', charged: true };
}


/* ── THE TWO AI CALLS A PASS INCLUDES ────────────────────────────────────────────────────────────
 *
 * The pass promise is everything needed to apply to ONE company: one AI resume, one AI cover
 * letter, and then any design in any format as often as they like. The downloads are unlimited
 * because rendering a file we already generated costs us almost nothing; the two AI calls are not,
 * because each one is real money.
 *
 * ⚠️ ONE EACH, TRACKED SEPARATELY — never a shared counter of two. A single "2 generations" pool
 * would let someone spend both on resumes and never receive the cover letter they paid for.
 *
 * ⚠️ EITHER ACTION BINDS THE PASS. Someone may generate before they download, so an unbound pass
 * must be claimable by a generation too — otherwise the first generate is refused while a paid-for
 * pass sits unused next to it.
 */
const GEN_COLUMN = { resume: 'resume_generated_at', cover_letter: 'letter_generated_at' };

/**
 * Does a pass still include this employer's AI <kind>? Spends nothing — but RESERVES.
 *
 * ⚠️ THIS ONE GATE RESERVES, AND IT HAS TO. An AI generation takes about a minute and costs real
 * money. A pure read here let two generations for two DIFFERENT companies both be admitted inside
 * that minute on a single pass: the first worker to finish claimed it, and the second fell through
 * to `consumeOnSuccess`, which does not enforce — two paid-for letters, one payment. So an unbound
 * pass is BOUND to this employer at the gate (a single conditional UPDATE, so exactly one racer can
 * win it) while the generation column is stamped only by claimGeneration, after the AI actually
 * returned. A failed generation therefore still costs nothing, and the pass keeps everything else
 * it promised for that company.
 *
 * `boundOnly` is the caller saying "the plan or the free allowance can pay for this". Then only a
 * pass ALREADY bound to this employer may jump in — they bought it for exactly this — and an
 * unspent pass is left alone rather than burned ahead of quota the user already has.
 */
async function passCoversGeneration(userId, kind, employer, reqOrEnv, { boundOnly = false } = {}) {
  const col = GEN_COLUMN[kind];
  if (!col) return false;
  const env = envOf(reqOrEnv);
  const key = employerKeyOf(employer);
  // ⚠️ AN AI CALL IS NEVER SPENT NAMELESSLY. Unlike a download, a generation stamps a column that
  // no later employer can take back, so a pass whose letter was burned on "(none)" would owe its
  // real company a letter it can no longer produce. The controllers always know SOMETHING — the
  // website at worst — so a missing name here means the plan or the free allowance pays.
  if (key === NONE) return false;
  try {
    // The pass they already own for this company — including under another spelling of it.
    const owned = await boundPassFor(userId, employer, env);
    if (owned) {
      const free = await dbConfig.get(
        `SELECT id FROM download_passes WHERE id = $1 AND ${col} IS NULL LIMIT 1`, [owned.id]);
      if (free) return true;
    }
    if (boundOnly) return false;

    const bound = await dbConfig.get(
      `UPDATE download_passes
          SET employer_key = $3, employer_name = $4, bound_at = NOW()
        WHERE id = (
          SELECT id FROM download_passes
           WHERE user_id = $1 AND environment = $2 AND ${col} IS NULL
             AND (bound_at IS NULL OR employer_key = $5)
           ORDER BY (bound_at IS NOT NULL) DESC, created_at
           LIMIT 1 FOR UPDATE SKIP LOCKED
        ) RETURNING id`, [userId, env, key, employer || null, NONE]);
    return !!bound;
  } catch { return false; }   // fail closed: an unreadable pass is not a pass
}

/**
 * Spend the AI call. Call ONLY after the generation succeeded — a failed call must not consume it.
 *
 * ⚠️ Two conditional UPDATEs, each atomic, tried in order: the pass already bound to this employer
 * first (which is normally the reservation the gate just made), then any still-unbound one, which
 * this also binds. Never SELECT-then-UPDATE — two taps on Generate would both pass the read and
 * both spend.
 */
async function claimGeneration(userId, kind, employer, reqOrEnv) {
  const col = GEN_COLUMN[kind];
  if (!col) return { charged: false };
  const env = envOf(reqOrEnv);
  const key = employerKeyOf(employer);
  if (key === NONE) return { charged: false };   // see passCoversGeneration — never nameless
  try {
    // The reservation is normally right here under this employer's own key — but by now the letter
    // worker may know a better spelling than the gate did, so match the COMPANY, not the string.
    const owned = await boundPassFor(userId, employer, env);
    if (owned) {
      const onBound = await dbConfig.get(
        `UPDATE download_passes SET ${col} = NOW()
          WHERE id = (
            SELECT id FROM download_passes WHERE id = $1 AND ${col} IS NULL
             FOR UPDATE SKIP LOCKED
          ) RETURNING id`, [owned.id]);
      if (onBound) return { charged: true, via: 'pass', passId: onBound.id };
    }

    const onFree = await dbConfig.get(
      `UPDATE download_passes
          SET ${col} = NOW(), employer_key = $3, employer_name = $4, bound_at = NOW()
        WHERE id = (
          SELECT id FROM download_passes
           WHERE user_id = $1 AND environment = $2 AND ${col} IS NULL
             AND (bound_at IS NULL OR employer_key = $5)
           ORDER BY (bound_at IS NOT NULL) DESC, created_at
           LIMIT 1 FOR UPDATE SKIP LOCKED
        ) RETURNING id`, [userId, env, key, employer || null, NONE]);
    if (onFree) return { charged: true, via: 'pass', passId: onFree.id, bound: true };
  } catch (e) {
    console.warn('[downloads] generation claim failed:', e.message);
  }
  return { charged: false };
}

/**
 * Record a purchased pass. Idempotent on the STORE TRANSACTION, globally — a receipt replayed
 * against a second account collides on the unique index rather than minting a second pass.
 * Returns true when this call is the one that created it.
 *
 * ⚠️ NO try/catch HERE, ON PURPOSE. `false` has to mean exactly one thing: "the row is already
 * there". Swallowing a write failure into that same `false` told both verify endpoints the purchase
 * had landed — they answered success:true, and the client then FINISHED the store transaction: on
 * Apple it left StoreKit's queue and the retry record was deleted; on Google finishOneTime consumed
 * and acknowledged it, so not even the three-day auto-refund fired. Money taken, no pass, and no
 * artifact left anywhere to rebuild the claim from. A throw reaches the caller, which owes the
 * client a 503 so the transaction is kept and replayed on the next launch.
 */
async function grantPass(userId, { store, environment, storeTxnId, productId }) {
  if (!userId || !store || !environment || !storeTxnId) return false;
  const r = await dbConfig.get(
    `INSERT INTO download_passes (user_id, store, environment, store_txn_id, product_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (store, environment, store_txn_id) DO NOTHING
     RETURNING id`,
    [userId, store, environment, String(storeTxnId), productId || PASS_PRODUCT_ID]);
  return !!r;
}

/**
 * Who a store transaction was already granted to. Used to log loudly when a receipt is replayed
 * under a SECOND account — the pending-purchase list on iOS is per device, not per user, so a
 * shared phone can hand one person's pass to whoever signs in next.
 */
async function passOwnerOf({ store, environment, storeTxnId }) {
  try {
    const r = await dbConfig.get(
      `SELECT user_id FROM download_passes
        WHERE store = $1 AND environment = $2 AND store_txn_id = $3 LIMIT 1`,
      [store, environment, String(storeTxnId)]);
    return r ? r.user_id : null;
  } catch { return null; }
}

module.exports = {
  METERED, PASS_PRODUCT_ID, NONE, employerKeyOf, aliasKeysOf, sameEmployer,
  downloadState, canDownload, claimDownload, grantPass, passOwnerOf,
  passCoversGeneration, claimGeneration, envOf, resolveEmployer,
  unboundPassCount, boundPassFor,
};
