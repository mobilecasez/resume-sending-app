// Forced-upgrade gate — which app builds may keep running.
//
// ⚠️ THIS IS THE ONE SETTING THAT CAN LOCK EVERY USER OUT OF THE PRODUCT AT ONCE. It ships inert
// (both floors 0) and is armed by hand. Two floors on purpose:
//   • min   → HARD BLOCK. The app refuses to continue until the store version is installed.
//   • nudge → a dismissible "there's an update" sheet. Use this by default; reserve the hard block
//             for a build that is genuinely unusable (a data-losing bug, a dead API contract).
//
// ⚠️ A GATE ONLY EXISTS IN BUILDS THAT SHIPPED WITH IT. Every user on a build older than the one
// that introduced this cannot be blocked — they never ask. Raising min_build does nothing to them;
// it only governs builds ≥ the first gated release. Setting a huge number does NOT reach them.
'use strict';

const dbConfig = require('../../db-config');

const DEFAULTS = {
    ios_min_build: 0, ios_nudge_build: 0,
    android_min_code: 0, android_nudge_code: 0,
    title: 'Update CVApplyr',
    message: 'This version is out of date. Update to the latest version to carry on.',
};

// The hot path is "every app launch", so cache briefly. 60s is short enough that arming the gate
// takes effect while you are still watching, and long enough to keep launches off the database.
let _cache = null, _at = 0;
const TTL = 60 * 1000;

async function getGate() {
    if (_cache && Date.now() - _at < TTL) return _cache;
    try {
        const row = await dbConfig.get(`SELECT * FROM app_version_gate WHERE id = 1`);
        _cache = row ? { ...DEFAULTS, ...row } : { ...DEFAULTS };
    } catch { _cache = { ...DEFAULTS }; }   // table missing → nobody is blocked, which is the safe way to fail
    _at = Date.now();
    return _cache;
}

async function setGate(patch = {}) {
    const cur = await getGate();
    const int = (v, fallback) => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const next = {
        ios_min_build: int(patch.ios_min_build, cur.ios_min_build),
        ios_nudge_build: int(patch.ios_nudge_build, cur.ios_nudge_build),
        android_min_code: int(patch.android_min_code, cur.android_min_code),
        android_nudge_code: int(patch.android_nudge_code, cur.android_nudge_code),
        title: patch.title != null ? String(patch.title).slice(0, 120) : cur.title,
        message: patch.message != null ? String(patch.message).slice(0, 500) : cur.message,
    };
    await dbConfig.run(
        `INSERT INTO app_version_gate (id, ios_min_build, ios_nudge_build, android_min_code, android_nudge_code, title, message, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, NOW())
         ON CONFLICT (id) DO UPDATE SET ios_min_build = EXCLUDED.ios_min_build,
           ios_nudge_build = EXCLUDED.ios_nudge_build, android_min_code = EXCLUDED.android_min_code,
           android_nudge_code = EXCLUDED.android_nudge_code, title = EXCLUDED.title,
           message = EXCLUDED.message, updated_at = NOW()`,
        [next.ios_min_build, next.ios_nudge_build, next.android_min_code, next.android_nudge_code,
         next.title, next.message]);
    _cache = { ...cur, ...next }; _at = Date.now();
    return _cache;
}

const IOS_URL = 'https://apps.apple.com/app/id6762126502';
const ANDROID_URL = 'https://play.google.com/store/apps/details?id=com.cvapplyr.mobile';

/** What should THIS build do? 'block' | 'nudge' | 'ok'. */
async function evaluate({ platform, build }) {
    const g = await getGate();
    const n = parseInt(build, 10);
    // An unreadable build number must never block — that would brick the app on a parsing slip.
    if (!Number.isFinite(n) || n <= 0) return { action: 'ok' };
    const ios = String(platform || '').toLowerCase() !== 'android';
    const min = ios ? g.ios_min_build : g.android_min_code;
    const nudge = ios ? g.ios_nudge_build : g.android_nudge_code;
    const storeUrl = ios ? IOS_URL : ANDROID_URL;
    if (min > 0 && n < min) return { action: 'block', title: g.title, message: g.message, storeUrl };
    if (nudge > 0 && n < nudge) return { action: 'nudge', title: g.title, message: g.message, storeUrl };
    return { action: 'ok' };
}

module.exports = { getGate, setGate, evaluate };
