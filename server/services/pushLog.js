// Push analytics — the durable record of what we sent, to whom, and what became of it.
//
// Every function here is BEST-EFFORT. A logging failure must never change what a send returns or
// stop a notification going out; each write is individually caught. Analytics is not worth an
// outage.
//
// The funnel this feeds, and what each stage honestly means:
//   chosen    — a user the campaign selected
//   skipped   — never sent: no token, opted out, muted, or the payload was unbuildable
//   accepted  — Expo took the message. Says NOTHING about Apple or Google yet.
//   rejected  — Expo refused it (bad token, our credentials, message too big)
//   handed off— Apple/Google accepted it from Expo (receipt ok). STILL not proof of delivery,
//               and definitely not proof a human saw it.
//   opened    — the user tapped it and the app told us. Needs a build that reports taps.
//
// ⚠️ There is deliberately no "delivered" anywhere in this file. APNs and FCM do not tell you that,
// and inventing it would make every number on the admin screen a lie.
'use strict';

const crypto = require('crypto');
const dbConfig = require('../../db-config');

const RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts';

/** The id that ties a payload, a ticket, a receipt and a tap together. */
const newNid = () => crypto.randomUUID();

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * One row per (push, recipient), written after the POST with the ticket outcome.
 *
 * ⚠️ Written AFTER the send, so a crash in between loses the row while the phone still buzzed. That
 * is the accepted trade (one DB round trip on the hot path instead of two); push_opens has no
 * foreign key, so even an orphaned tap still records.
 */
async function recordSend(row = {}) {
  try {
    await dbConfig.run(
      `INSERT INTO push_sends (id, user_id, campaign_id, source, audience, template_key, notif_type,
         title, body, route, params, token_prefix, admin_log_id,
         ticket_id, ticket_status, ticket_error, ticket_message, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [row.nid || newNid(), row.userId ?? null, row.campaignId || null,
       row.source || 'unknown', row.audience || 'user', clip(row.templateKey, 60), clip(row.notifType, 40),
       clip(row.title, 500), clip(row.body, 2000), clip(row.route, 80),
       row.params ? JSON.stringify(row.params) : null,
       clip(row.tokenPrefix, 24), row.adminLogId ?? null,
       row.ticketId || null, clip(row.ticketStatus, 20), clip(row.ticketError, 60), clip(row.ticketMessage, 300)]);
  } catch (e) { console.warn('[pushLog] recordSend:', e.message); }
}

/**
 * A recipient we chose but never sent to. The push service cannot see these — the caller returns
 * before it — so callers report them here. Without this, "sent 40" silently hides the 180 people
 * who were unreachable, and every rate below it is computed against the wrong denominator.
 */
async function recordSkip({ nid, userId, source, templateKey, campaignId, reason, audience } = {}) {
  return recordSend({
    nid: nid || newNid(), userId, source, templateKey, campaignId, audience,
    ticketStatus: 'skipped', ticketError: reason || 'skipped',
  });
}

/** The campaign header. Idempotent — a re-send of the same batch updates rather than duplicates. */
async function upsertCampaign({ id, kind, segmentKey, templateKey, title, body, route, sentBy, recipients } = {}) {
  if (!id) return;
  try {
    await dbConfig.run(
      `INSERT INTO push_campaigns (id, kind, segment_key, template_key, title, body, route, sent_by, recipients)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         recipients = COALESCE(EXCLUDED.recipients, push_campaigns.recipients),
         title = COALESCE(EXCLUDED.title, push_campaigns.title),
         body = COALESCE(EXCLUDED.body, push_campaigns.body)`,
      [clip(id, 64), clip(kind, 30), clip(segmentKey, 60), clip(templateKey, 60),
       clip(title, 500), clip(body, 2000), clip(route, 80), sentBy ?? null, recipients ?? null]);
  } catch (e) { console.warn('[pushLog] upsertCampaign:', e.message); }
}

/** A tap. Called by the public open endpoint. */
async function recordOpen({ nid, userId, kind, coldStart, platform, appVersion } = {}) {
  if (!nid) return false;
  try {
    await dbConfig.run(
      `INSERT INTO push_opens (nid, user_id, kind, cold_start, platform, app_version)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [nid, userId ?? null, clip(kind, 20) || 'open',
       coldStart == null ? null : !!coldStart, clip(platform, 20), clip(appVersion, 40)]);
    return true;
  } catch (e) { console.warn('[pushLog] recordOpen:', e.message); return false; }
}

// ── Receipts ──────────────────────────────────────────────────────────────────────────────────
// Expo keeps a receipt for roughly 24h. It is the ONLY place an Apple/Google-side refusal shows up
// (a bad token still returns a perfectly happy ticket), so this is what catches uninstalls.
//
// ⚠️ Reads Object.ENTRIES. The old in-memory drain used Object.values and threw the ticket id away,
// which is precisely why no receipt was ever attributable to a device.
async function pollReceipts() {
  let rows;
  try {
    rows = await dbConfig.query(
      `SELECT id, ticket_id FROM push_sends
        WHERE ticket_id IS NOT NULL AND receipt_status IS NULL
          AND sent_at > NOW() - INTERVAL '24 hours'
          AND sent_at < NOW() - INTERVAL '15 seconds'
        ORDER BY sent_at LIMIT 100`);
  } catch (e) { console.warn('[pushLog] receipt queue:', e.message); return 0; }
  if (!rows || !rows.length) { await expireStaleReceipts(); return 0; }

  const byTicket = new Map(rows.map((r) => [r.ticket_id, r.id]));
  try {
    const r = await fetch(RECEIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ids: [...byTicket.keys()] }),
      signal: AbortSignal.timeout(9000),
    });
    const j = await r.json().catch(() => ({}));
    for (const [ticketId, rec] of Object.entries((j && j.data) || {})) {
      const id = byTicket.get(ticketId);
      if (!id || !rec) continue;
      await dbConfig.run(
        `UPDATE push_sends SET receipt_status = ?, receipt_error = ?, receipt_message = ?,
                               receipt_checked_at = NOW()
          WHERE id = ?`,
        [rec.status === 'ok' ? 'ok' : 'error',
         clip(rec.details && rec.details.error, 60), clip(rec.message, 300), id]).catch(() => {});
    }
  } catch (e) { console.warn('[pushLog] receipt fetch:', e.message); }
  await expireStaleReceipts();
  return rows.length;
}

/** Past ~24h Expo has forgotten the receipt. Mark it, so the poller stops asking forever. */
async function expireStaleReceipts() {
  try {
    await dbConfig.run(
      `UPDATE push_sends SET receipt_status = 'expired', receipt_checked_at = NOW()
        WHERE ticket_id IS NOT NULL AND receipt_status IS NULL
          AND sent_at < NOW() - INTERVAL '24 hours'`);
  } catch { /* best effort */ }
}

let pollTimer = null;
/**
 * Poll receipts once a minute.
 *
 * This is a READER — it sends nothing, so it is not covered by the "ship schedulers disarmed" rule
 * that exists for anything that can push to users. It still has a kill switch.
 */
function startReceiptPoller() {
  if (pollTimer) return;
  if (/^(1|true|yes|on)$/i.test(String(process.env.PUSH_RECEIPT_POLL_DISABLED || ''))) {
    console.log('[pushLog] receipt poller disabled by env');
    return;
  }
  pollTimer = setInterval(() => { pollReceipts().catch(() => {}); }, 60 * 1000);
  if (pollTimer.unref) pollTimer.unref();
  console.log('[pushLog] receipt poller started (60s)');
}

// ── Read side ─────────────────────────────────────────────────────────────────────────────────

const FUNNEL_SQL = `
  COUNT(*)::int                                                              AS rows,
  COUNT(*) FILTER (WHERE ticket_status = 'skipped')::int                     AS not_reachable,
  COUNT(*) FILTER (WHERE ticket_status = 'skipped' AND ticket_error = 'opted_out')::int AS opted_out,
  COUNT(*) FILTER (WHERE ticket_status = 'skipped' AND ticket_error = 'no_token')::int  AS no_token,
  COUNT(*) FILTER (WHERE ticket_status = 'ok')::int                          AS accepted,
  COUNT(*) FILTER (WHERE ticket_status IN ('error','exception'))::int        AS rejected,
  COUNT(*) FILTER (WHERE receipt_status = 'ok')::int                         AS handed_off,
  COUNT(*) FILTER (WHERE receipt_error = 'DeviceNotRegistered')::int         AS dead_device,
  COUNT(*) FILTER (WHERE receipt_status IS NULL AND ticket_id IS NOT NULL)::int AS receipt_pending`;

/** Campaigns in the window, newest first, each with its funnel. */
async function campaignList(days = 30, limit = 50) {
  const d = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  const rows = await dbConfig.query(
    `SELECT s.campaign_id AS id,
            MIN(s.sent_at) AS sent_at,
            MAX(s.source) AS source,
            MAX(s.template_key) AS template_key,
            MAX(s.title) AS title,
            ${FUNNEL_SQL},
            (SELECT COUNT(DISTINCT o.nid)::int FROM push_opens o
               JOIN push_sends s2 ON s2.id = o.nid
              WHERE s2.campaign_id = s.campaign_id) AS opened
       FROM push_sends s
      WHERE s.campaign_id IS NOT NULL AND s.audience = 'user'
        AND s.sent_at > NOW() - ($1 || ' days')::interval
      GROUP BY s.campaign_id
      ORDER BY MIN(s.sent_at) DESC
      LIMIT ${Math.max(1, Math.min(200, parseInt(limit, 10) || 50))}`, [String(d)]);
  return rows || [];
}

/** Automated (non-campaign) sends rolled up by source — the lifecycle/transactional traffic. */
async function sourceRollup(days = 30) {
  const d = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  const rows = await dbConfig.query(
    `SELECT source, MAX(sent_at) AS last_at, ${FUNNEL_SQL},
            (SELECT COUNT(DISTINCT o.nid)::int FROM push_opens o
               JOIN push_sends s2 ON s2.id = o.nid
              WHERE s2.source = s.source
                AND s2.sent_at > NOW() - ($1 || ' days')::interval) AS opened
       FROM push_sends s
      WHERE audience = 'user' AND sent_at > NOW() - ($1 || ' days')::interval
      GROUP BY source
      ORDER BY MAX(sent_at) DESC`, [String(d)]);
  return rows || [];
}

async function campaignFunnel(campaignId) {
  const r = await dbConfig.get(
    `SELECT ${FUNNEL_SQL} FROM push_sends WHERE campaign_id = ? AND audience = 'user'`, [campaignId]);
  const opened = await dbConfig.get(
    `SELECT COUNT(DISTINCT o.nid)::int AS n FROM push_opens o
       JOIN push_sends s ON s.id = o.nid
      WHERE s.campaign_id = ? AND o.kind = 'open'`, [campaignId]);
  const head = await dbConfig.get(`SELECT * FROM push_campaigns WHERE id = ?`, [campaignId]);
  return { ...(r || {}), opened: (opened && opened.n) || 0, campaign: head || null };
}

/**
 * Users who did ANYTHING in the app within `hours` of the send.
 *
 * ⚠️ THIS IS CORRELATION, NOT ATTRIBUTION. Someone who would have opened the app anyway is counted
 * here. It is a useful floor — "at least this many were active afterwards" — and it must be labelled
 * that way on screen, never as "opened" or "converted". Real attribution needs the tap ping.
 */
async function activityAfter(campaignId, hours = 24, events = null) {
  const h = Math.max(1, Math.min(168, parseInt(hours, 10) || 24));
  const useEvents = Array.isArray(events) && events.length > 0;
  // ⚠️ Placeholders must be `?` ONLY and in TEXTUAL order — db-config.toPg rewrites them to $1,$2…
  // by position, so mixing in a literal $2 here silently binds the wrong value.
  const params = [String(h)];
  if (useEvents) params.push(events);
  params.push(campaignId);
  const r = await dbConfig.get(
    `SELECT COUNT(DISTINCT s.user_id)::int AS n
       FROM push_sends s
       JOIN app_events e ON e.user_id = s.user_id
        AND e.created_at > s.sent_at
        AND e.created_at < s.sent_at + (? || ' hours')::interval
        ${useEvents ? 'AND e.event = ANY(?)' : ''}
      WHERE s.campaign_id = ? AND s.ticket_status = 'ok' AND s.audience = 'user'`, params)
    .catch((e) => { console.warn('[pushLog] activityAfter:', e.message); return null; });
  return (r && r.n) || 0;
}

/** The per-recipient rows behind a campaign, for the drill-down. */
async function sendRows({ campaignId, userId, source, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (campaignId) { where.push('s.campaign_id = ?'); params.push(campaignId); }
  if (userId) { where.push('s.user_id = ?'); params.push(userId); }
  if (source) { where.push('s.source = ?'); params.push(source); }
  if (!where.length) where.push('1=1');
  const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const rows = await dbConfig.query(
    `SELECT s.id, s.user_id, u.email, s.source, s.template_key, s.title, s.sent_at,
            s.ticket_status, s.ticket_error, s.receipt_status, s.receipt_error,
            (SELECT MIN(o.created_at) FROM push_opens o WHERE o.nid = s.id) AS opened_at
       FROM push_sends s LEFT JOIN users u ON u.id = s.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.sent_at DESC LIMIT ${lim} OFFSET ${off}`, params);
  return rows || [];
}

/**
 * Video watch depth from app_events.
 * ⚠️ tutorial_* events exist on builds already in the field but carry no notification id and no
 * duration, so until the instrumented build ships this answers "how many watched" and not
 * "for how long", and cannot be split by campaign.
 */
async function videoStats(days = 30) {
  const d = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  const rows = await dbConfig.query(
    `SELECT event, COUNT(*)::int AS n, COUNT(DISTINCT user_id)::int AS users
       FROM app_events
      WHERE event IN ('tutorial_opened','tutorial_halfway','tutorial_completed','tutorial_failed','tutorial_progress')
        AND created_at > NOW() - ($1 || ' days')::interval
      GROUP BY event`, [String(d)]);
  const by = {};
  for (const r of (rows || [])) by[r.event] = { plays: r.n, users: r.users };
  // Seconds watched only exists once the instrumented build is out; absent is reported as null
  // rather than 0, so "no data yet" cannot be misread as "nobody watched".
  const secs = await dbConfig.get(
    `SELECT ROUND(AVG((props->>'seconds')::numeric))::int AS avg_seconds,
            ROUND(AVG((props->>'coverPct')::numeric))::int AS avg_cover_pct,
            COUNT(*)::int AS samples
       FROM app_events
      WHERE event = 'tutorial_progress' AND props ? 'seconds'
        AND created_at > NOW() - ($1 || ' days')::interval`, [String(d)]).catch(() => null);
  return { byEvent: by, duration: (secs && secs.samples) ? secs : null };
}

module.exports = {
  newNid, recordSend, recordSkip, recordOpen, upsertCampaign,
  pollReceipts, startReceiptPoller,
  campaignList, sourceRollup, campaignFunnel, activityAfter, sendRows, videoStats,
};
