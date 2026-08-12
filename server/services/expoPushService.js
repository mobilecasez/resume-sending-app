// Send a push notification via the Expo Push API — a single HTTPS POST, no SDK.
// https://docs.expo.dev/push-notifications/sending-notifications/
// Tokens look like ExponentPushToken[xxx]. Best-effort: never throws (push must not break a search).
//
// ⚠️ A SEND HAS TWO STAGES AND EITHER CAN FAIL:
//   1. the TICKET  — Expo accepted the message, or rejected it outright (InvalidCredentials when the
//      project has no APNs key; DeviceNotRegistered when the token is dead)
//   2. the RECEIPT — what Apple/Google actually did with it, readable a few seconds later
// This file used to return `true` on a good ticket and never look at receipts, and it logged
// rejections at warn level with no counter. So a total outage was invisible: from 18 Jul to 26 Jul
// 2026 EVERY iOS push was rejected with InvalidCredentials — the Expo project had no APNs key after
// the account move — and nothing surfaced it. Now the reason is logged loudly, a health snapshot is
// kept for the admin dashboard, and receipts are polled so Apple-side failures show up too.
'use strict';

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts';

// Rolling health — "is push actually working right now?"
const health = {
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,          // e.g. "InvalidCredentials: Could not find APNs credentials for…"
    sent: 0,
    failed: 0,
    consecutiveFailures: 0,
};
function getPushHealth() {
    return {
        ...health,
        // A project-level misconfiguration fails EVERY send, so a RUN of failures is the signal —
        // a single failure is usually just one dead device.
        looksBroken: health.consecutiveFailures >= 5 && !!health.lastError,
    };
}

// Receipts moved to services/pushLog.js (Migration 040).
//
// They used to be tracked here in a module-level array that died on every deploy, and the drain read
// Object.values() — throwing away the ticket id — so a receipt could tell you "something failed"
// but never WHICH device. Ticket ids are now persisted on push_sends and polled from there, so a
// failure is attributable to a user and survives a restart. This rolling `health` still records
// ticket-time failures, which is the signal that says push is broken right now.

function noteError(kind, detail) {
    health.failed += 1;
    health.consecutiveFailures += 1;
    health.lastErrorAt = new Date().toISOString();
    health.lastError = kind + (detail ? ': ' + String(detail).slice(0, 180) : '');
    // error, not warn — this is the class of failure that hid for eight days.
    console.error(`[push] ✗ ${health.lastError}${health.consecutiveFailures > 1 ? `  (${health.consecutiveFailures} in a row)` : ''}`);
}
function noteOk() {
    health.sent += 1;
    health.consecutiveFailures = 0;
    health.lastOkAt = new Date().toISOString();
}

async function sendPushNotification(pushToken, title, body, data = {}, log = null) {
    if (!pushToken || !/^Expo(nent)?PushToken\[/.test(pushToken)) return false;
    // The id that ties this payload to its ticket, its receipt, and any later tap. Stamped into the
    // payload so the app can hand it back when the user opens the notification.
    const pushLog = require('./pushLog');
    const nid = pushLog.newNid();
    const payload = { ...(data || {}), nid };
    const logRow = (ticket) => {
        if (!log) return;
        pushLog.recordSend({
            nid, userId: log.userId, campaignId: log.campaignId, source: log.source || 'unknown',
            audience: log.audience || 'user', templateKey: log.templateKey,
            notifType: (data && data.type) || null, title, body,
            route: (data && data.route) || null, params: data || null,
            tokenPrefix: String(pushToken).slice(0, 12), adminLogId: log.adminLogId,
            ...ticket,
        }).catch(() => {});
    };
    try {
        const r = await fetch(SEND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ to: pushToken, title, body, data: payload, sound: 'default', priority: 'high', channelId: 'default' }),
            signal: AbortSignal.timeout(9000),
        });
        const j = await r.json().catch(() => ({}));
        const ticket = j && j.data;
        if (ticket && ticket.status === 'error') {
            const err = ticket.details && ticket.details.error;
            // Per-notification receipt line. noteError records the ROLLING health, which tells you
            // push is broken but never WHICH device — so "did it arrive for this user?" had no
            // answer anywhere. Log the token prefix (first 12 chars is enough to match a row in
            // users.expo_push_token, and stops short of the full credential) next to the reason.
            // Best-effort and non-fatal: a logging failure must not change what the send returns.
            try {
                console.warn(`[push] ticket error  token=${String(pushToken).slice(0, 12)}…  reason=${err || 'unknown'}  ${String(ticket.message || '').slice(0, 160)}`);
            } catch {}
            noteError(err || 'TicketError', ticket.message);
            logRow({ ticketStatus: 'error', ticketError: err || 'TicketError', ticketMessage: ticket.message });
            // DeviceNotRegistered → the token really is stale, so the caller clears it. Anything
            // else (notably InvalidCredentials) is OUR configuration: leave the token alone, or a
            // project-level outage would wipe every user's token and they'd all need a reinstall.
            return err === 'DeviceNotRegistered' ? 'stale' : false;
        }
        noteOk();
        // ⚠️ A ticket WITHOUT status 'error' is not the same as status 'ok' — a malformed response
        // would otherwise be counted as a success. Record what we actually got.
        logRow({
            ticketId: (ticket && ticket.id) || null,
            ticketStatus: ticket && ticket.status === 'ok' ? 'ok' : (ticket && ticket.id ? 'ok' : 'exception'),
            ticketMessage: ticket && ticket.id ? null : 'no ticket id in Expo response',
        });
        return true;
    } catch (e) {
        noteError('SendFailed', e.message);
        logRow({ ticketStatus: 'exception', ticketError: 'SendFailed', ticketMessage: e.message });
        return false;
    }
}

module.exports = { sendPushNotification, getPushHealth };
