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

/**
 * The two columns the one-device-one-account rule needs on `users` (Migration 049 — defined ONCE, here; db-init runs
 * these and ensurePushColumns() below runs them lazily too, because migrations race app.listen and one failed migration
 * skips every later one).
 *   admin_alert_token   — where an ADMIN's alerts go (adminNotifier, supportService.pushAdmins). It is the device the
 *                         admin last registered, and signing that device into another account does NOT take it away:
 *                         admin alerts are about the business, not about whoever is signed in on the phone.
 *   push_token_moved_at — when another account signed in on this account's phone took the token (cleared when this
 *                         account registers again). The admin user screen reads it to say WHY there is no token
 *                         (adminUserOps.pushBlockReason) instead of blaming a declined permission.
 */
const PUSH_COLUMNS = ['admin_alert_token', 'push_token_moved_at'];
const PUSH_COLUMNS_SQL = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_alert_token TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token_moved_at TIMESTAMPTZ`,
];
// Per database handle: the columns are checked (information_schema — no lock) once, and added only when missing.
//
// ⚠️ THIS IS A SAFETY NET, NOT THE MIGRATION (2026-09-20 review). db-init's Migration 049 is the real path; this exists
// only for the window where it has not run yet (server.js fires initializeDatabase() without awaiting it, so app.listen
// serves while migrations run) or never will (one throw inside db-init's single try block skips every later migration,
// and 049 is the last one). An ALTER TABLE takes ACCESS EXCLUSIVE, and a lock_timeout does NOT stop a QUEUED ALTER from
// blocking other queries — while it waits, every later `users` query in the app (login included) queues behind it, for
// the whole timeout. Measured on a scratch Postgres 17.8 against a 607-row users table with one ordinary reader holding
// ACCESS SHARE: at the old 5s the ALTER failed after 5.26s and a concurrent login query took 4.53s.
// So: the wait is now 1s (the ALTER itself is instant once it has the lock — a longer wait buys nothing and holds the
// table), and a FAILURE IS REMEMBERED for a cooloff instead of being retried on the very next request. It used to be
// forgotten immediately, so every registration AND every admin alert re-queued another ACCESS EXCLUSIVE lock; each
// attempt also pins a pooled client (max 10) for the whole wait. Callers degrade: saveDeviceToken falls back to the
// legacy statement, adminAlertTargets to the plain token. No timer is used — the cooloff is a timestamp comparison, so
// this module still schedules nothing.
const COLUMNS_RETRY_MS = 60000;
let _degradedLoggedAt = 0;             // saveDeviceToken's "columns unavailable" line, at most one per cooloff
const _columnsReady = new WeakMap();   // db → { p, failedAt }
function ensurePushColumns(db) {
    const prev = _columnsReady.get(db);
    if (prev && !(prev.failedAt && Date.now() - prev.failedAt >= COLUMNS_RETRY_MS)) return prev.p;
    const entry = { p: null, failedAt: 0 };
    entry.p = (async () => {
        const have = await db.query(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'users' AND column_name IN (?, ?)`, PUSH_COLUMNS);
        if ((Array.isArray(have) ? have : []).length >= PUSH_COLUMNS.length) return true;
        await db.withTransaction(async (tx) => {
            await tx.run(`SET LOCAL lock_timeout = '1s'`);
            for (const sql of PUSH_COLUMNS_SQL) await tx.run(sql);
        });
        return true;
    })().catch((e) => { entry.failedAt = Date.now(); throw e; });
    _columnsReady.set(db, entry);
    return entry.p;
}

// Registrations of the SAME token run one after another (two-key form, its own namespace — the other advisory locks in
// this codebase are ('usage:'…, user) and ('ai_hub.track_employer', user)). See saveDeviceToken for why.
const TOKEN_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('push_token'), hashtext(?::text))`;
const SAVE_TOKEN_SQL =
    `UPDATE users SET
        expo_push_token     = CASE WHEN id = ? THEN ? ELSE NULL END,
        admin_alert_token   = CASE WHEN role = 'admin' THEN ? ELSE admin_alert_token END,
        push_token_moved_at = CASE WHEN id = ? THEN NULL ELSE NOW() END
      WHERE (id = ? OR expo_push_token = ?) AND EXISTS (SELECT 1 FROM users me WHERE me.id = ? AND me.deleted_at IS NULL)
      RETURNING id`;
// Used only when the two columns cannot be ensured (see ensurePushColumns): the pre-049 statement, so a registration is
// never LOST to a busy users table. It deliberately does NOT take the token off the other accounts: without
// admin_alert_token to hold the admin's device, clearing it there would page nobody for admin alerts — the exact bug
// Migration 049 exists to prevent. Degraded = today's behaviour (a shared token lingers); the next registration after
// the columns exist narrows it.
const LEGACY_SAVE_TOKEN_SQL =
    `UPDATE users SET expo_push_token = ? WHERE id = ? AND deleted_at IS NULL RETURNING id`;

/**
 * Save this device's Expo token on the signed-in account — and take it OFF every other account, in one statement.
 * → { saved, cleared } (cleared = how many other accounts held it). POST /api/user/push-token calls this.
 *
 * ⚠️ ONE DEVICE, ONE ACCOUNT (2026-09-20). The route only SET the token on the caller, so a phone that signed into a
 * second account left the same token on the first: in production {1, 17, 616}, {88, 89} and {118, 498} shared one
 * (read-only check). Every push chosen from one account's state could reach a phone signed into another — the
 * how_it_works push the owner tapped (issue 7) was picked from user 17's journey, on a phone signed in as 616, and it
 * opened a clip about someone else's progress. Whoever registered the token LAST now owns it; the app registers on
 * every sign-in and every session restore (App.js, `user.token`), so the right account takes it on the next open.
 * On a shared (family) phone that is the account signed in NOW — the only one whose pushes that screen can open.
 * This arms nothing and schedules nothing — it only narrows who a push reaches.
 * ⚠️ ADMIN ALERTS ARE NOT PART OF THAT RULE. Production has ONE admin (user 1) and its token is the one shared with the
 * owner's test accounts 17 and 616. Moving expo_push_token alone would leave getAdminTargets() with nobody the moment
 * that phone opened as 616: install/registration/purchase alerts, support pages and the aiHealth "AI service is down"
 * alarm would all go to no one, with no error anywhere. So the same statement records the device on the admin's
 * admin_alert_token — for the admin registering, AND for an admin losing the device to another account (it held this
 * token, so its alerts keep reaching this device). Only admin alerts read that column; every user-journey sender reads
 * expo_push_token, so user 1's nudges still stop reaching a phone signed in as 616 (not exempting admin rows is the
 * point — that would bring the original bug back for user 1). Admin alerts reach the same device they did before.
 * ⚠️ ONE statement, not clear-then-set: two would leave a moment where the token is on nobody (a crash between them).
 * And only when the caller's row EXISTS — a token is moved to an account, never just taken away (checked against a
 * scratch Postgres, 2026-09-20: without the EXISTS, a caller with no row wiped the token off its real owner and saved
 * it nowhere).
 * ⚠️ One statement is NOT enough against a RACE: under READ COMMITTED two registrations of the same token for two
 * accounts each clear only the rows that held it in their own snapshot, so both callers kept it (47 of 200 rounds on a
 * scratch Postgres 17). The transaction-scoped advisory lock on the token makes them run one after the other, so the
 * second statement sees the first one's row and takes the token off it.
 * ⚠️ A SOFT-DELETED ACCOUNT TAKES NOTHING (`me.deleted_at IS NULL`, 2026-09-20 review). authenticateToken only verifies
 * the 30-day JWT — it never reads the database — and getProfile has no deleted_at filter, so a deleted account restores
 * its session on the next cold start and re-registers. Without this, it re-acquired a push address (undoing the
 * expo_push_token = NULL the deletion path now writes, which rewardNudges/uninstallDetection would have pushed to) AND
 * stripped the token off the live account that had since taken that phone. Measured on a scratch Postgres 17.8.
 * ⚠️ A REGISTRATION IS NEVER LOST TO THE LAZY COLUMN ADD. ensurePushColumns can fail on a busy users table; that used to
 * throw straight out of here, so the route answered 500 and the device stayed unreachable until the next cold start
 * (the app swallows the error and only re-registers when `user.token` changes). It now degrades to the pre-049
 * statement instead — see LEGACY_SAVE_TOKEN_SQL.
 */
async function saveDeviceToken(userId, token, db = require('../../db-config')) {
    const tok = String(token || '').trim().slice(0, 300);
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0 || !/^Expo(nent)?PushToken\[/.test(tok)) return { saved: false, cleared: 0 };
    let full = true;
    try {
        await ensurePushColumns(db);
    } catch (e) {
        full = false;
        // One line per cooloff, not per registration: every phone that opens the app takes this path while the columns
        // are missing, and a flood would bury the reason.
        const now = Date.now();
        if (now - _degradedLoggedAt >= COLUMNS_RETRY_MS) {
            _degradedLoggedAt = now;
            console.error(`[push] Migration 049 columns unavailable (${e.message}) — saving tokens the pre-049 way; one device, one account waits for the next registration`);
        }
    }
    if (!full) {
        const legacy = await db.query(LEGACY_SAVE_TOKEN_SQL, [tok, uid]);
        return { saved: (Array.isArray(legacy) ? legacy : []).length > 0, cleared: 0, degraded: true };
    }
    const rows = await db.withTransaction(async (tx) => {
        await tx.get(TOKEN_LOCK_SQL, [tok]);
        return tx.query(SAVE_TOKEN_SQL, [uid, tok, tok, uid, uid, tok, uid]);
    });
    const ids = (Array.isArray(rows) ? rows : []).map((r) => Number(r && r.id));
    const cleared = ids.filter((id) => id !== uid).length;
    // Counts only — a push token is a delivery address, never logged.
    if (cleared) console.log(`[push] device token moved to user ${uid}: taken off ${cleared} other account(s)`);
    return { saved: ids.includes(uid), cleared };
}

// The address an admin alert goes to: the admin's alert device, or (before that admin has registered since Migration
// 049) the plain token. No `?` in this SQL — dbConfig turns every `?` into a parameter, hence the spelled-out regex.
const ADMIN_TARGETS_SQL =
    `SELECT id, COALESCE(NULLIF(admin_alert_token, ''), expo_push_token) AS expo_push_token FROM users
      WHERE role = 'admin' AND deleted_at IS NULL
        AND COALESCE(NULLIF(admin_alert_token, ''), expo_push_token, '') ~ '^(ExpoPushToken|ExponentPushToken)\\['`;
const LEGACY_ADMIN_TARGETS_SQL =
    `SELECT id, expo_push_token FROM users
      WHERE role = 'admin' AND deleted_at IS NULL AND COALESCE(expo_push_token, '') ~ '^(ExpoPushToken|ExponentPushToken)\\['`;

/**
 * Every admin device an admin alert should reach → [{ id, expo_push_token }]. adminNotifier.getAdminTargets() and
 * supportService.pushAdmins() both read THIS, so the two can never disagree about who the admins' phones are. If the
 * columns cannot be ensured, it falls back to the plain token (the pre-049 behaviour) rather than paging nobody.
 *
 * ⚠️ AN EMPTY ANSWER IS LOGGED (2026-09-20 review). Both callers loop over this list and do nothing when it is empty —
 * notifyAdmins returns { sent: 0 } and pushAdmins returns { sent: 0 }, neither of which anybody reads — so "no admin
 * device at all" looked exactly like "alert delivered". That is the same shape of silence this file's header is about.
 * It matters most right after a rollback: a pre-049 server reads expo_push_token only, which this change moves to
 * admin_alert_token, so the previous release pages nobody until the admin cold-starts the app signed in as themselves.
 * Throttled, and never a timer — one line per ADMIN_SILENT_LOG_MS at most.
 */
const ADMIN_SILENT_LOG_MS = 600000;
let _adminSilentLoggedAt = 0;
function noteNoAdminDevices(how) {
    const now = Date.now();
    if (now - _adminSilentLoggedAt < ADMIN_SILENT_LOG_MS) return;
    _adminSilentLoggedAt = now;
    console.error(`[push] ✗ no admin device to alert (${how}) — install, purchase, support and "AI service is down" alerts are reaching NOBODY. An admin signing into the app re-registers one.`);
}
async function adminAlertTargets(db = require('../../db-config')) {
    let rows;
    try {
        await ensurePushColumns(db);
        rows = (await db.query(ADMIN_TARGETS_SQL)) || [];
        if (!rows.length) noteNoAdminDevices('no admin row has an alert device or a push token');
    } catch (e) {
        console.error('[push] admin alert targets (falling back to the plain token):', e.message);
        rows = (await db.query(LEGACY_ADMIN_TARGETS_SQL)) || [];
        if (!rows.length) noteNoAdminDevices('pre-049 fallback: no admin row has a push token');
    }
    return rows;
}

/**
 * A send to `token` for this user came back DeviceNotRegistered: take that token off the user, from whichever of the
 * two addresses holds it — and ONLY if it still does (a fresh registration that landed meanwhile is never wiped).
 */
async function clearStaleToken(userId, token, db = require('../../db-config')) {
    const tok = String(token || '');
    if (!tok) return;
    try {
        await ensurePushColumns(db);
        await db.run(
            `UPDATE users SET
                expo_push_token   = CASE WHEN expo_push_token = ? THEN NULL ELSE expo_push_token END,
                admin_alert_token = CASE WHEN admin_alert_token = ? THEN NULL ELSE admin_alert_token END
              WHERE id = ? AND (expo_push_token = ? OR admin_alert_token = ?)`,
            [tok, tok, userId, tok, tok]);
    } catch (_) {
        await db.run(`UPDATE users SET expo_push_token = NULL WHERE id = ? AND expo_push_token = ?`, [userId, tok]).catch(() => {});
    }
}

module.exports = {
    sendPushNotification, getPushHealth, saveDeviceToken, adminAlertTargets, clearStaleToken,
    ensurePushColumns, PUSH_COLUMNS, PUSH_COLUMNS_SQL,
};
