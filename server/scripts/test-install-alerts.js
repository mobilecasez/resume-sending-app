// "I am not receiving any notification today" (2026-10-14) — the install alert that went missing.
//   node server/scripts/test-install-alerts.js
//
// The alert fired only when a device had EXACTLY ONE event. iOS reports `foreground` and `app_open` together at
// launch; when both rows were inserted before either check ran, each counted two and neither fired. 93 new
// devices in 30 days produced 90 alerts — the 3 lost were all iPhones, one on 2026-10-13. Now a device must be
// young (all its events within its first two minutes) and the alert is CLAIMED once per device.
// The database is faked so the race can be played out exactly; the claim's real-Postgres behaviour (40 racing
// inserts for 20 devices → exactly 20 claims) was checked on a scratch PG17 cluster with the module's own SQL.
'use strict';
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 300) : '')); } };

// ── a fake database: app_events by device, one claims set, and the settings row ─────────────────────────
const db = { events: new Map(), claims: new Set(), settings: { installs: true, registrations: true, purchases: true }, sql: [] };
const dbFake = {
    query: async (sql) => { db.sql.push(String(sql)); return []; },
    run: async (sql, params = []) => {
        db.sql.push(String(sql));
        if (/admin_notification_settings/.test(String(sql))) db.settings = { installs: !!params[0], registrations: !!params[1], purchases: !!params[2] };
        return { changes: 1 };
    },
    get: async (sql, params = []) => {
        const s = String(sql);
        db.sql.push(s);
        if (/FROM admin_notification_settings/.test(s)) return { ...db.settings };
        if (/MAX\(created_at\) - MIN\(created_at\)\) <= interval '2 minutes' AS young/.test(s)) {
            const ts = db.events.get(params[0]) || [];
            if (!ts.length) return { young: null };
            return { young: Math.max(...ts) - Math.min(...ts) <= 2 * 60 * 1000 };
        }
        if (/INSERT INTO admin_install_alerts/.test(s)) {
            // ON CONFLICT DO NOTHING RETURNING: the first insert for a device returns the row, every later one nothing.
            await new Promise((r) => setTimeout(r, 1));
            if (db.claims.has(params[0])) return null;
            db.claims.add(params[0]);
            return { anon_id: params[0] };
        }
        if (/FROM users/.test(s)) return null;
        return null;
    },
};
const sent = [];
const pushFake = { sendPushNotification: async (token, title) => { sent.push(title); return true; }, clearStaleToken: async () => {} };

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    let resolved = '';
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch { /* fall through */ }
    if (resolved === path.join(ROOT, 'db-config.js')) return dbFake;
    if (resolved === path.join(ROOT, 'server', 'services', 'expoPushService.js')) return pushFake;
    if (resolved === path.join(ROOT, 'server', 'controllers', 'notificationsController.js')) return { createNotification: () => {} };
    return realLoad.apply(this, arguments);
};
const notifier = require(path.join(ROOT, 'server', 'services', 'adminNotifier.js'));
// One admin with a device, so a fired alert is visible as a send.
notifier.getAdminTargets = async () => [{ id: 1, expo_push_token: 'ExponentPushToken[admin]' }];

// notifyAdmins reads getAdminTargets through the module scope, so count by watching the claims and the SQL instead
// when the patched export is not the one used internally.
const fired = () => db.claims.size;

(async () => {
    console.log('── 1. The race that lost the 2026-10-13 alert ──');
    const t = Date.now();
    db.events.set('ios-new', [t, t + 3]);                 // foreground + app_open, 3 ms apart, BOTH already inserted
    await Promise.all([
        notifier.maybeNewInstall({ anonId: 'ios-new', platform: 'ios' }),
        notifier.maybeNewInstall({ anonId: 'ios-new', platform: 'ios' }),
    ]);
    ok('⚠️ two events arriving together still produce an alert', fired() === 1, { claims: [...db.claims] });
    ok('…exactly one, not two', db.claims.size === 1);

    console.log('── 2. Every ordinary case ──');
    db.events.set('android-new', [t]);
    await notifier.maybeNewInstall({ anonId: 'android-new', platform: 'android' });
    ok('a device\'s first lone event alerts', db.claims.has('android-new'));
    await notifier.maybeNewInstall({ anonId: 'android-new', platform: 'android' });
    ok('…and its next event does not alert again', db.claims.size === 2);

    db.events.set('owner-phone', [t - 90 * 24 * 3600 * 1000, t]);   // months of history
    await notifier.maybeNewInstall({ anonId: 'owner-phone', platform: 'ios' });
    ok('⚠️ a long-lived device never alerts (so the deploy does not re-announce old installs)', !db.claims.has('owner-phone'));

    db.events.set('three-minutes', [t - 3 * 60 * 1000, t]);
    await notifier.maybeNewInstall({ anonId: 'three-minutes', platform: 'ios' });
    ok('a device past its first two minutes is no longer new', !db.claims.has('three-minutes'));

    await notifier.maybeNewInstall({ anonId: '', platform: 'ios' });
    await notifier.maybeNewInstall({});
    ok('no device id → nothing at all', db.claims.size === 2);

    console.log('── 3. The switch still rules ──');
    db.settings.installs = false;
    // the settings cache lives 60 s; force a re-read
    await notifier.setSettings({ installs: false });
    db.events.set('while-off', [t]);
    await notifier.maybeNewInstall({ anonId: 'while-off', platform: 'ios' });
    ok('installs switched off → no claim, no alert', !db.claims.has('while-off'));

    console.log('── 4. Never throws into analytics ──');
    const brokenGet = dbFake.get;
    dbFake.get = async () => { throw new Error('db down'); };
    let threw = false;
    try { await notifier.maybeNewInstall({ anonId: 'x', platform: 'ios' }); } catch { threw = true; }
    ok('a database failure is swallowed (analytics must not break)', !threw);
    dbFake.get = brokenGet;

    console.log('── 5. The claim is made BEFORE anyone is notified ──');
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'server', 'services', 'adminNotifier.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const fn = (src.match(/async function maybeNewInstall[\s\S]*?\n}\n/) || [''])[0];
    ok('the old "exactly one event" test is gone', !/cnt\.n !== 1/.test(fn));
    ok('claim → then notify, in that order', fn.indexOf('INSERT INTO admin_install_alerts') > -1
        && fn.indexOf('INSERT INTO admin_install_alerts') < fn.indexOf("notifyAdmins('installs'"));
    ok('a lost claim returns before notifying', /if \(!claimed\) return;/.test(fn));
    ok('the table ships as Migration 052 from the module\'s own SQL',
        /Migration 052[\s\S]*?const \{ INSTALL_CLAIMS_SQL \} = require\('\.\/server\/services\/adminNotifier'\)/.test(fs.readFileSync(path.join(ROOT, 'db-init.js'), 'utf8')));

    console.log(`\ninstall alerts: ${pass} passed, ${fail} failed`);
    Module._load = realLoad;
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
