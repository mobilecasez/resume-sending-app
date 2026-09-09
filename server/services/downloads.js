// Who may download a finished document, and what that costs them.
//
// There are two ways to pay for a download:
//   • a PLAN, which now carries a monthly download allowance; or
//   • a PASS — one download bought outright, for people who do not want a subscription.
//
// This module is the ONLY place that answers either question. The gate used to be five
// copy-pasted `activeSubscription(userId) || 403` checks across the resume and cover-letter
// controllers; five copies of a money decision is five chances for them to drift apart.
//
// ⚠️ ONE PASS COVERS ONE DESIGN, IN EVERY FORMAT. The download sheet offers PDF and Word, and a
// user who taps Word after PDF must not be charged twice. So a pass BINDS to the first design it is
// spent on, and every later download of that same design is free.
//
// ⚠️ CLAIM AFTER THE BYTES EXIST, NEVER AT THE GATE. The PDF path can still fall through Playwright
// to PDFKit and either can throw. Charging at the gate means the first support ticket is "I paid
// and got an error".
'use strict';
const dbConfig = require('../../db-config');
const entitlements = require('./entitlements');
const { requestEnvironment } = require('./storeEnvironment');

/**
 * ⚠️ THE PLAN ALLOWANCE SHIPS OFF.
 *
 * Downloads have always been unlimited on a paid plan. Metering them is a REDUCTION of something
 * people already bought, so it must not switch itself on the moment this file is deployed — and it
 * must not switch on before the app can actually sell a single-download pass, or a subscriber who
 * hits the new ceiling has no way to pay and simply loses the feature.
 *
 * Set DOWNLOADS_METERED=1 only when the store products are live and the app ships the sheet.
 * With it off, a paid plan behaves exactly as it does today: unlimited.
 */
const METERED = process.env.DOWNLOADS_METERED === '1';

const PASS_PRODUCT_ID = 'com.cvapplyr.mobile.download.single';

/** Everything the caller needs to render the button, and to know what a tap will cost. */
async function downloadState(userId, req) {
  const sub = await entitlements.activeSubscription(userId, requestEnvironment(req || {})).catch(() => null);
  const passes = await unboundPassCount(userId);
  if (!METERED) {
    return { metered: false, paid: !!sub, remaining: null, passes, unlimited: !!sub };
  }
  if (!sub) return { metered: true, paid: false, remaining: 0, passes, unlimited: false };
  const gate = await entitlements.canConsumeMany(userId, 'download', 1, req).catch(() => null);
  return {
    metered: true, paid: true, passes, unlimited: false,
    remaining: gate && typeof gate.remaining === 'number' ? gate.remaining : 0,
  };
}

async function unboundPassCount(userId) {
  try {
    const r = await dbConfig.get(
      'SELECT COUNT(*)::int AS n FROM download_passes WHERE user_id = $1 AND bound_at IS NULL', [userId]);
    return r ? (r.n || 0) : 0;
  } catch { return 0; }
}

/** A pass already spent on this exact design — every further format of it is free. */
async function boundPassFor(userId, kind, templateId) {
  if (!templateId) return null;
  try {
    return await dbConfig.get(
      `SELECT id FROM download_passes
        WHERE user_id = $1 AND kind = $2 AND template_id = $3 AND bound_at IS NOT NULL
        LIMIT 1`, [userId, kind, String(templateId)]);
  } catch { return null; }
}

/**
 * May this download happen? Answers WITHOUT spending anything — call claimDownload afterwards,
 * once the file actually exists.
 */
async function canDownload(userId, { kind = 'resume', templateId = null } = {}, req) {
  if (await boundPassFor(userId, kind, templateId)) {
    return { allowed: true, via: 'pass_bound' };
  }
  if (await unboundPassCount(userId) > 0) {
    return { allowed: true, via: 'pass' };
  }
  const sub = await entitlements.activeSubscription(userId, requestEnvironment(req || {})).catch(() => null);
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
async function claimDownload(userId, { kind = 'resume', templateId = null } = {}, req) {
  if (await boundPassFor(userId, kind, templateId)) return { via: 'pass_bound', charged: false };

  if (templateId) {
    try {
      const claimed = await dbConfig.get(
        `UPDATE download_passes
            SET template_id = $3, bound_at = NOW(), kind = $2
          WHERE id = (
            SELECT id FROM download_passes
             WHERE user_id = $1 AND bound_at IS NULL
             ORDER BY created_at
             LIMIT 1
             FOR UPDATE SKIP LOCKED
          )
          RETURNING id`, [userId, kind, String(templateId)]);
      if (claimed) return { via: 'pass', charged: true, passId: claimed.id };
    } catch (e) {
      console.warn('[downloads] pass claim failed:', e.message);
    }
  }
  if (!METERED) return { via: 'plan_unlimited', charged: false };
  try {
    await entitlements.consumeOnSuccess(userId, 'download', { templateId, kind, screen: 'download' }, req);
  } catch (e) {
    console.warn('[downloads] usage record failed:', e.message);   // never fail a paid-for download
  }
  return { via: 'plan', charged: true };
}

/**
 * Record a purchased pass. Idempotent on the STORE TRANSACTION, globally — a receipt replayed
 * against a second account collides on the unique index rather than minting a second pass.
 * Returns true when this call is the one that created it.
 */
async function grantPass(userId, { store, environment, storeTxnId, productId, kind = 'resume' }) {
  if (!userId || !store || !environment || !storeTxnId) return false;
  try {
    const r = await dbConfig.get(
      `INSERT INTO download_passes (user_id, store, environment, store_txn_id, product_id, kind)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (store, environment, store_txn_id) DO NOTHING
       RETURNING id`,
      [userId, store, environment, String(storeTxnId), productId || PASS_PRODUCT_ID, kind]);
    return !!r;
  } catch (e) {
    console.error('[downloads] grantPass failed:', e.message);
    return false;
  }
}

module.exports = {
  METERED, PASS_PRODUCT_ID,
  downloadState, canDownload, claimDownload, grantPass,
  unboundPassCount, boundPassFor,
};
