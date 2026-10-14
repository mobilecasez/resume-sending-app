// Admin-only push alerts — ADDITIVE. Fires a push to every admin's device when:
//   • a NEW user installs the app (platform-specific: "New iOS install" / "New Android install")
//   • a NEW user registers (with sign-in provider + who)
//   • a user PURCHASES credits/a subscription (with amount + credits + who + source)
// Each category is independently toggleable (admin_notification_settings, Migration 022). Everything
// here is BEST-EFFORT and never throws into the caller — analytics / auth / payment must not break if
// a notification fails. Admins = users with role='admin' and an expo_push_token.
'use strict';
const dbConfig = require('../../db-config');
const { sendPushNotification } = require('./expoPushService');

const CATEGORIES = ['installs', 'registrations', 'purchases'];
const DEFAULTS = { installs: true, registrations: true, purchases: true };

// tiny in-memory cache so the hot install path (fires on every analytics event) doesn't hit the DB
// for settings every time. 60s TTL; setSettings refreshes it immediately.
let _settings = null, _settingsAt = 0;
const SETTINGS_TTL = 60 * 1000;

async function getSettings() {
    if (_settings && Date.now() - _settingsAt < SETTINGS_TTL) return _settings;
    try {
        const row = await dbConfig.get(`SELECT installs, registrations, purchases FROM admin_notification_settings WHERE id = 1`);
        _settings = row ? { installs: !!row.installs, registrations: !!row.registrations, purchases: !!row.purchases } : { ...DEFAULTS };
    } catch { _settings = { ...DEFAULTS }; }
    _settingsAt = Date.now();
    return _settings;
}

async function setSettings(patch = {}) {
    const cur = await getSettings();
    const next = {
        installs: patch.installs != null ? !!patch.installs : cur.installs,
        registrations: patch.registrations != null ? !!patch.registrations : cur.registrations,
        purchases: patch.purchases != null ? !!patch.purchases : cur.purchases,
    };
    await dbConfig.run(
        `INSERT INTO admin_notification_settings (id, installs, registrations, purchases, updated_at)
         VALUES (1, ?, ?, ?, NOW())
         ON CONFLICT (id) DO UPDATE SET installs = EXCLUDED.installs, registrations = EXCLUDED.registrations,
             purchases = EXCLUDED.purchases, updated_at = NOW()`,
        [next.installs, next.registrations, next.purchases]);
    _settings = next; _settingsAt = Date.now();
    return next;
}

// ⚠️ An admin's alert device is users.admin_alert_token, NOT only expo_push_token (2026-09-20): signing the owner's
// phone into a test account moves expo_push_token to that account (one device, one account), and reading only that
// column paged NOBODY from then on — install, registration, purchase and "AI service is down" alike, with no error.
// expoPushService.adminAlertTargets() is the one definition (supportService.pushAdmins reads it too).
async function getAdminTargets() {
    try {
        return await require('./expoPushService').adminAlertTargets(dbConfig);
    } catch { return []; }
}

// Send a push to every admin device (+ record an in-app bell entry for history). Gated by category.
async function notifyAdmins(category, title, body, data = {}) {
    try {
        if (category) { const s = await getSettings(); if (s[category] === false) return { sent: 0, skipped: 'disabled' }; }
        const admins = await getAdminTargets();
        let sent = 0;
        for (const a of admins) {
            try {
                // audience 'admin' — these are alerts to US, and must never be counted in a user campaign funnel.
                const res = await sendPushNotification(a.expo_push_token, title, body, { ...data, adminAlert: true },
                    { userId: a.id, source: 'admin_alert', audience: 'admin' });
                if (res === true) sent++;
                else if (res === 'stale') { try { await require('./expoPushService').clearStaleToken(a.id, a.expo_push_token, dbConfig); } catch {} }
            } catch {}
            // in-app bell history (no extra push — push already sent above)
            try { require('../controllers/notificationsController').createNotification(a.id, 'admin_alert', title, body, null, { category, ...data }, { push: false }); } catch {}
        }
        return { sent, admins: admins.length };
    } catch { return { sent: 0 }; }
}

const platLabel = (p) => p === 'ios' ? 'iOS' : p === 'android' ? 'Android' : (p ? String(p).charAt(0).toUpperCase() + String(p).slice(1) : 'New');
const provLabel = (p) => p === 'google' ? 'Gmail' : p === 'microsoft' ? 'Microsoft' : p === 'apple' ? 'Apple' : 'Email';

// ⚠️ ONE ALERT PER NEW DEVICE, HOWEVER ITS FIRST EVENTS ARRIVE (2026-10-14). This used to fire only when the
// device had EXACTLY ONE event. iOS reports `foreground` and `app_open` together at launch, as two requests a
// few ms apart; when both rows were inserted before either check ran, each check counted two and NEITHER
// fired. Measured: 93 new devices in 30 days → 90 install alerts, the 3 lost were all iPhones whose second
// event landed within 50 ms (one of them on 2026-10-13, the morning the owner asked why the phone was quiet).
// Now: the device must be YOUNG (every event it has sent falls within its first two minutes — measured on its
// own timestamps, so no clock or timezone is involved), and the alert is CLAIMED with one INSERT … ON CONFLICT
// DO NOTHING. Two concurrent checks both see a young device; exactly one of them wins the insert.
// A returning device is never young (its events span days), so this does not re-alert the old installs on
// deploy — the claims table does not need a backfill.
const INSTALL_CLAIMS_SQL = `CREATE TABLE IF NOT EXISTS admin_install_alerts (
    anon_id    TEXT PRIMARY KEY,
    alerted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;
let _claimsReady = null;
function ensureInstallClaims() {
    if (!_claimsReady) _claimsReady = dbConfig.query(INSTALL_CLAIMS_SQL).catch((e) => { _claimsReady = null; throw e; });
    return _claimsReady;
}

// Called from liveAnalytics.trackEvent on EVERY event. Cheap-gated: only touches the DB when the
// installs category is ON.
async function maybeNewInstall({ anonId, platform } = {}) {
    try {
        if (!anonId) return;
        const s = await getSettings();
        if (!s.installs) return;
        const age = await dbConfig.get(
            `SELECT (MAX(created_at) - MIN(created_at)) <= interval '2 minutes' AS young FROM app_events WHERE anon_id = ?`,
            [anonId],
        ).catch(() => null);
        if (!age || !age.young) return;
        await ensureInstallClaims();
        const claimed = await dbConfig.get(
            `INSERT INTO admin_install_alerts (anon_id) VALUES (?) ON CONFLICT (anon_id) DO NOTHING RETURNING anon_id`,
            [anonId],
        ).catch(() => null);
        if (!claimed) return;              // another request for the same device got here first
        const plat = platLabel(platform);
        await notifyAdmins('installs', `New ${plat} install 🎉`, `A new ${plat} user just installed CVApplyr.`, { type: 'install', platform: plat });
    } catch {}
}

async function notifyNewRegistration(userId, { provider } = {}) {
    try {
        const s = await getSettings();
        if (!s.registrations) return;
        const u = await dbConfig.get(`SELECT email, full_name FROM users WHERE id = ?`, [userId]).catch(() => null);
        const who = (u && (u.full_name || u.email)) || `user #${userId}`;
        const prov = provLabel(provider);
        await notifyAdmins('registrations', `New sign-up · ${prov} 🙋`,
            `${who}${u && u.email && u.full_name ? ` (${u.email})` : ''} just registered via ${prov}.`,
            { type: 'registration', userId, provider: prov });
    } catch {}
}

async function notifyNewPurchase(userId, { credits, amount, currency, source, plan } = {}) {
    try {
        const s = await getSettings();
        if (!s.purchases) return;
        const u = await dbConfig.get(`SELECT email, full_name FROM users WHERE id = ?`, [userId]).catch(() => null);
        const who = (u && (u.full_name || u.email)) || `user #${userId}`;
        const money = (amount != null && !isNaN(amount)) ? `${currency ? currency + ' ' : ''}${amount}` : '';
        const detail = [plan || null, credits != null ? `${credits} credits` : null].filter(Boolean).join(' · ');
        await notifyAdmins('purchases', `New purchase 💳${money ? ' · ' + money : ''}`,
            `${who} bought ${detail || 'a package'}${source ? ` via ${source}` : ''}.`,
            { type: 'purchase', userId, credits, amount, currency, source });
    } catch {}
}

module.exports = { CATEGORIES, DEFAULTS, getSettings, setSettings, getAdminTargets, notifyAdmins, maybeNewInstall, notifyNewRegistration, notifyNewPurchase,
    INSTALL_CLAIMS_SQL,
};
