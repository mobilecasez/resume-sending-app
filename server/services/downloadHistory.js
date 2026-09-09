// Every document this user has already paid to download, so they can get it again.
//
// ⚠️ THIS IS AN INDEX, NOT AN ENTITLEMENT. A row here says "you downloaded this once", not "you may
// download it". Getting the file again still goes through services/downloads.canDownload, exactly
// like the first time — so a bought pass keeps its employer open forever, and a plan that has since
// lapsed locks the row until they subscribe or buy that employer outright. If this file ever became
// the thing that decides, one download would buy unlimited downloads for life.
//
// ⚠️ RECORDING MUST NEVER FAIL A DOWNLOAD. Every write here is best-effort and swallowed: the file
// already exists and the user has already been charged by the time we are called. A history row is
// a convenience; losing one is a cosmetic bug, while throwing would turn a successful paid download
// into a 500.
//
// ⚠️ THE PAYLOAD IS SELF-CONTAINED. A cover letter can be edited, or its job deleted, after the
// fact — re-rendering from today's data would hand back a different document than the one they
// paid for. So everything the renderer needs is frozen into the row at download time.
'use strict';
const dbConfig = require('../../db-config');
const downloads = require('./downloads');
const tempFiles = require('./tempFiles');
const { requestEnvironment } = require('./storeEnvironment');

/** One row per distinct document, and never more than this many per user per kind. */
const KEEP_PER_KIND = 60;

/** A payload big enough to matter is a cover letter's HTML; anything past this is a bug or an attack. */
const MAX_PAYLOAD_BYTES = 256 * 1024;

const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

/**
 * Remember that this document was downloaded.
 *
 * Upserts on the document identity, so downloading the same design four times leaves ONE row
 * saying "4 times, most recently Tuesday" rather than four identical cards. Every column in that
 * unique tuple is NOT NULL with a '' default on purpose — Postgres treats NULLs as distinct, so a
 * nullable member would silently defeat the dedupe and grow the list without bound.
 */
async function record(userId, entry, reqOrEnv) {
  if (!userId || !entry) return null;
  const kind = entry.kind === 'cover_letter' ? 'cover_letter' : 'resume';
  const format = entry.format === 'docx' ? 'docx' : 'pdf';
  const env = downloads.envOf(reqOrEnv);
  const employerName = str(entry.employer, 160);

  // ⚠️ BEFORE ANYTHING THAT CAN FAIL. The four /api/download-* routes authenticate the caller and
  // then serve any filename in temp/ to anybody; this is what makes the file that was just minted
  // theirs alone. It must not be skipped because a history row could not be written.
  tempFiles.own(userId, entry.fileName);

  let payload = null;
  try {
    const json = JSON.stringify(entry.payload || {});
    if (json.length <= MAX_PAYLOAD_BYTES) payload = json;
  } catch { /* an unserialisable payload just means "no one-tap re-render" */ }

  try {
    const row = await dbConfig.get(
      `INSERT INTO download_history
         (user_id, kind, employer_key, employer_name, template_id, template_name,
          format, mode, file_name, payload, environment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (user_id, kind, employer_key, template_id, format, mode, environment)
       DO UPDATE SET
         times         = download_history.times + 1,
         downloaded_at = NOW(),
         employer_name = EXCLUDED.employer_name,
         template_name = EXCLUDED.template_name,
         file_name     = EXCLUDED.file_name,
         payload       = COALESCE(EXCLUDED.payload, download_history.payload)
       RETURNING id`,
      [
        userId, kind,
        downloads.employerKeyOf(employerName), employerName,
        str(entry.templateId, 80), str(entry.templateName, 120),
        format, str(entry.mode, 40), str(entry.fileName, 260) || null,
        payload, env,
      ]);
    prune(userId, kind, env).catch(() => {});
    return row ? row.id : null;
  } catch (e) {
    console.warn('[downloadHistory] record failed:', e.message);
    return null;
  }
}

/** Keep the list finite. The oldest entries are the least likely to be wanted again. */
async function prune(userId, kind, env) {
  try {
    await dbConfig.run(
      `DELETE FROM download_history
        WHERE id IN (
          SELECT id FROM download_history
           WHERE user_id = $1 AND kind = $2 AND environment = $3
           ORDER BY downloaded_at DESC
           OFFSET $4
        )`, [userId, kind, env, KEEP_PER_KIND]);
  } catch { /* a list that is one row too long is not worth an error */ }
}

/**
 * The list, with an honest `unlocked` on every row.
 *
 * ⚠️ ONE subscription read and ONE pass read for the whole list, not one per row. Sixty rows would
 * otherwise be sixty round trips on a screen that has to feel instant. The per-row answer is then
 * derived with sameEmployer, which is the SAME comparison canDownload will make when they actually
 * tap — so the padlock the list draws and the answer the server gives cannot disagree.
 */
async function list(userId, kind, req, { limit = KEEP_PER_KIND } = {}) {
  const env = requestEnvironment(req || {});
  const want = kind === 'cover_letter' ? 'cover_letter' : 'resume';
  let rows = [];
  try {
    rows = await dbConfig.query(
      `SELECT id, kind, employer_name, template_id, template_name, format, mode,
              times, downloaded_at
         FROM download_history
        WHERE user_id = $1 AND kind = $2 AND environment = $3
        ORDER BY downloaded_at DESC
        LIMIT $4`, [userId, want, env, Math.min(Math.max(Number(limit) || 0, 1), KEEP_PER_KIND)]) || [];
  } catch (e) {
    console.warn('[downloadHistory] list failed:', e.message);
    return { items: [], unlimited: false };
  }

  const entitlements = require('./entitlements');
  const [sub, passes] = await Promise.all([
    entitlements.activeSubscription(userId, env).catch(() => null),
    downloads.boundPasses(userId, env).catch(() => []),
  ]);
  const unlimited = !!sub && !downloads.METERED;

  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    employer: r.employer_name || '',
    templateId: r.template_id || '',
    templateName: r.template_name || '',
    format: r.format,
    mode: r.mode || '',
    times: r.times || 1,
    downloadedAt: r.downloaded_at,
    // Free again because they bought this employer outright, or because a plan covers everything.
    ownsEmployer: passes.some((p) => downloads.sameEmployer(r.employer_name, p.employer_name || p.employer_key)),
  })).map((it) => ({ ...it, unlocked: it.ownsEmployer || unlimited }));

  return { items, unlimited };
}

/** One row, with its frozen render payload, for the re-download handler. */
async function get(userId, id, req) {
  const env = requestEnvironment(req || {});
  try {
    const r = await dbConfig.get(
      `SELECT * FROM download_history WHERE id = $1 AND user_id = $2 AND environment = $3`,
      [Number(id) || 0, userId, env]);
    if (!r) return null;
    let payload = r.payload;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
    return { ...r, payload: payload || {} };
  } catch (e) {
    console.warn('[downloadHistory] get failed:', e.message);
    return null;
  }
}

module.exports = { record, list, get, KEEP_PER_KIND };
