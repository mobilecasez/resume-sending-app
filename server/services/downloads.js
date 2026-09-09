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
// and got an error".
'use strict';
const dbConfig = require('../../db-config');
const entitlements = require('./entitlements');
const { PRODUCTION, SANDBOX, requestEnvironment } = require('./storeEnvironment');

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
  return k || '(none)';
}

/**
 * Pick which of several spellings of "the employer" a payment should attach to.
 *
 * ⚠️ THIS EXISTS BECAUSE THE TWO SCREENS DISAGREE, AND A USER MUST NOT PAY FOR THAT.
 * The resume side sends the Home target's `target.company` ("Acme Corp"). The letter side sends
 * `companyName`, which is `aiResult.employer_name || recipient.website || hint` — the AI's reading
 * of the posting, and a URL when it could not find a name at all. Same company, two strings, two
 * employer keys, and the pass bought for the resume did not cover the letter: one payment, and
 * they are asked for a second at the same company. That is the exact promise the feature makes.
 *
 * Forcing the clients to agree forever is the fragile fix — every new entry point would have to
 * remember. Instead: given every spelling the caller knows, if ANY of them already owns a pass,
 * that is the employer. Only when none is owned do we fall back to the first non-empty candidate,
 * so a genuinely new company still binds normally.
 */
async function resolveEmployer(userId, candidates, req) {
  const env = requestEnvironment(req || {});
  const seen = new Set();
  const list = (Array.isArray(candidates) ? candidates : [candidates])
    .map((c) => (typeof c === 'string' ? c.trim() : ''))
    .filter((c) => {
      if (!c) return false;
      const k = employerKeyOf(c);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  for (const c of list) {
    try {
      if (await boundPassFor(userId, c, env)) return c;          // already paid for — use this one
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
    employerName ? boundPassFor(userId, employerName, env) : Promise.resolve(null),
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
async function unboundPassCount(userId, env = PRODUCTION) {
  try {
    const r = await dbConfig.get(
      `SELECT COUNT(*)::int AS n FROM download_passes
        WHERE user_id = $1 AND environment = $2 AND bound_at IS NULL`, [userId, env]);
    return r ? (r.n || 0) : 0;
  } catch { return 0; }
}

/** A pass already spent on this employer — everything for them is free from then on. */
async function boundPassFor(userId, employerName, env = PRODUCTION) {
  try {
    return await dbConfig.get(
      `SELECT id, employer_name FROM download_passes
        WHERE user_id = $1 AND employer_key = $2 AND environment = $3 AND bound_at IS NOT NULL
        LIMIT 1`, [userId, employerKeyOf(employerName), env]);
  } catch { return null; }
}

/**
 * May this download happen? Answers WITHOUT spending anything — call claimDownload afterwards,
 * once the file actually exists.
 */
async function canDownload(userId, { employer = null } = {}, req) {
  const env = requestEnvironment(req || {});
  if (await boundPassFor(userId, employer, env)) return { allowed: true, via: 'pass_owned' };
  if (await unboundPassCount(userId, env) > 0) return { allowed: true, via: 'pass' };

  const sub = await entitlements.activeSubscription(userId, env).catch(() => null);
  if (!METERED) {
    // Today's behaviour, unchanged: a plan means unlimited downloads.
    return sub
      ? { allowed: true, via: 'plan_unlimited' }
      : { allowed: false, reason: 'paid_required', message: 'Downloads are on paid plans.' };
  }
  const gate = await entitlements.canConsumeMany(userId, 'download', 1, req);
  if (gate.allowed) return { allowed: true, via: 'plan', remaining: gate.remaining };
  return { allowed: false, reason: sub ? 'quota_exhausted' : 'paid_required', message: gate.message };
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

  // ⚠️ NEVER BURN A PASS ON A NAMELESS EMPLOYER.
  // Not every route into the design gallery carries the company: opening it from the resume
  // editor's "Download / Preview" pushes no employer param at all, so this arrives as null and
  // employerKeyOf turns it into the sentinel '(none)'. Binding there is the worst possible
  // outcome — the single thing the user bought is spent on a company that does not exist, and the
  // letter for the real company is then refused as unpaid. They paid, and got locked out.
  //
  // So leave it unbound. The download still happens (the gate above already allowed it), and the
  // pass survives to bind to the first download that actually names a company. The cost is that a
  // nameless download is not metered; losing what someone paid for is far worse than that.
  if (employerKeyOf(employer) === '(none)') {
    return { via: 'pass_unbound', charged: false, reason: 'no employer on this download' };
  }

  try {
    const claimed = await dbConfig.get(
      `UPDATE download_passes
          SET employer_key = $2, employer_name = $3, bound_at = NOW()
        WHERE id = (
          SELECT id FROM download_passes
           WHERE user_id = $1 AND bound_at IS NULL AND environment = $4
           ORDER BY created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
      [userId, employerKeyOf(employer), employer || null, env]);
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

/** Does a pass still include this employer's AI <kind>? Spends nothing. */
async function passCoversGeneration(userId, kind, employer, req) {
  const col = GEN_COLUMN[kind];
  if (!col) return false;
  const env = envOf(req);
  try {
    const r = await dbConfig.get(
      `SELECT id FROM download_passes
        WHERE user_id = $1 AND environment = $2 AND ${col} IS NULL
          AND (employer_key = $3 OR bound_at IS NULL)
        LIMIT 1`,
      [userId, env, employerKeyOf(employer)]);
    return !!r;
  } catch { return false; }   // fail closed: an unreadable pass is not a pass
}

/**
 * Spend the AI call. Call ONLY after the generation succeeded — a failed call must not consume it.
 *
 * ⚠️ Two conditional UPDATEs, each atomic, tried in order: the pass already bound to this employer
 * first, then any unbound one (which this also binds). Never SELECT-then-UPDATE — two taps on
 * Generate would both pass the read and both spend.
 */
async function claimGeneration(userId, kind, employer, req) {
  const col = GEN_COLUMN[kind];
  if (!col) return { charged: false };
  const env = envOf(req);
  const key = employerKeyOf(employer);
  try {
    const onBound = await dbConfig.get(
      `UPDATE download_passes SET ${col} = NOW()
        WHERE id = (
          SELECT id FROM download_passes
           WHERE user_id = $1 AND environment = $2 AND employer_key = $3
             AND bound_at IS NOT NULL AND ${col} IS NULL
           ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
        ) RETURNING id`, [userId, env, key]);
    if (onBound) return { charged: true, via: 'pass', passId: onBound.id };

    const onFree = await dbConfig.get(
      `UPDATE download_passes
          SET ${col} = NOW(), employer_key = $3, employer_name = $4, bound_at = NOW()
        WHERE id = (
          SELECT id FROM download_passes
           WHERE user_id = $1 AND environment = $2 AND bound_at IS NULL
           ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
        ) RETURNING id`, [userId, env, key, employer || null]);
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
 */
async function grantPass(userId, { store, environment, storeTxnId, productId }) {
  if (!userId || !store || !environment || !storeTxnId) return false;
  try {
    const r = await dbConfig.get(
      `INSERT INTO download_passes (user_id, store, environment, store_txn_id, product_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (store, environment, store_txn_id) DO NOTHING
       RETURNING id`,
      [userId, store, environment, String(storeTxnId), productId || PASS_PRODUCT_ID]);
    return !!r;
  } catch (e) {
    console.error('[downloads] grantPass failed:', e.message);
    return false;
  }
}

module.exports = {
  METERED, PASS_PRODUCT_ID, employerKeyOf,
  downloadState, canDownload, claimDownload, grantPass,
  passCoversGeneration, claimGeneration, envOf, resolveEmployer,
  unboundPassCount, boundPassFor,
};
