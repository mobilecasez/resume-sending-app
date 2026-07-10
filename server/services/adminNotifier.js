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

async function getAdminTargets() {
    try {
        return await dbConfig.query(`SELECT id, expo_push_token FROM users WHERE role = 'admin' AND expo_push_token IS NOT NULL AND expo_push_token <> ''`) || [];
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
                const res = await sendPushNotification(a.expo_push_token, title, body, { ...data, adminAlert: true });
                if (res === true) sent++;
                else if (res === 'stale') { try { await dbConfig.run(`UPDATE users SET expo_push_token = NULL WHERE id = ?`, [a.id]); } catch {} }
            } catch {}
            // in-app bell history (no extra push — push already sent above)
            try { require('../controllers/notificationsController').createNotification(a.id, 'admin_alert', title, body, null, { category, ...data }, { push: false }); } catch {}
        }
        return { sent, admins: admins.length };
    } catch { return { sent: 0 }; }
}

const platLabel = (p) => p === 'ios' ? 'iOS' : p === 'android' ? 'Android' : (p ? String(p).charAt(0).toUpperCase() + String(p).slice(1) : 'New');
const provLabel = (p) => p === 'google' ? 'Gmail' : p === 'microsoft' ? 'Microsoft' : p === 'apple' ? 'Apple' : 'Email';

// Called from liveAnalytics.trackEvent on EVERY event. Cheap-gated: only touches the DB when the
// installs category is ON, then fires only when this is the FIRST-ever event for the device (anonId).
async function maybeNewInstall({ anonId, platform } = {}) {
    try {
        if (!anonId) return;
        const s = await getSettings();
        if (!s.installs) return;
        const cnt = await dbConfig.get(`SELECT COUNT(*)::int AS n FROM app_events WHERE anon_id = ?`, [anonId]).catch(() => null);
        if (!cnt || cnt.n !== 1) return;   // the just-inserted row is the only one → brand-new device
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

module.exports = { CATEGORIES, DEFAULTS, getSettings, setSettings, getAdminTargets, notifyAdmins, maybeNewInstall, notifyNewRegistration, notifyNewPurchase };
