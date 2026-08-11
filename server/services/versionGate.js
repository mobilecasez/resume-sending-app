// Forced-upgrade gate — which app builds may keep running.
//
// ⚠️ THIS IS THE ONE SETTING THAT CAN LOCK EVERY USER OUT OF THE PRODUCT AT ONCE. It ships inert
// (target 0) and is armed by hand from Settings → App Updates.
//
// The admin surface is one target build plus one switch:
//   • target_build          → the build everyone should be on. 0 = the gate is off entirely.
//   • mandatory = true      → HARD BLOCK below the target. The app refuses to continue.
//   • mandatory = false     → a dismissible "there's an update" sheet. This is the default, and the
//                             right choice for anything short of a genuinely unusable build.
// The 038 min/nudge floors still work underneath, so a gate armed the old way keeps behaving.
//
// ⚠️ A GATE ONLY EXISTS IN BUILDS THAT SHIPPED WITH IT. Every user on a build older than the one
// that introduced this cannot be blocked — they never ask. Raising min_build does nothing to them;
// it only governs builds ≥ the first gated release. Setting a huge number does NOT reach them.
'use strict';

const dbConfig = require('../../db-config');

const DEFAULTS = {
    // The simple pair the admin page drives: "everyone should be on this build" + is it compulsory.
    ios_target_build: 0, android_target_code: 0, mandatory: false,
    // The original two floors, kept so an already-armed gate is not silently disarmed.
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
    const bool = (v, fallback) => (v === true || v === false ? v
        : (v == null || v === '' ? fallback : /^(1|true|yes|on)$/i.test(String(v))));
    const next = {
        ios_target_build: int(patch.ios_target_build, cur.ios_target_build),
        android_target_code: int(patch.android_target_code, cur.android_target_code),
        mandatory: bool(patch.mandatory, cur.mandatory),
        ios_min_build: int(patch.ios_min_build, cur.ios_min_build),
        ios_nudge_build: int(patch.ios_nudge_build, cur.ios_nudge_build),
        android_min_code: int(patch.android_min_code, cur.android_min_code),
        android_nudge_code: int(patch.android_nudge_code, cur.android_nudge_code),
        title: patch.title != null ? String(patch.title).slice(0, 120) : cur.title,
        message: patch.message != null ? String(patch.message).slice(0, 500) : cur.message,
    };
    await dbConfig.run(
        `INSERT INTO app_version_gate (id, ios_target_build, android_target_code, mandatory,
             ios_min_build, ios_nudge_build, android_min_code, android_nudge_code, title, message, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON CONFLICT (id) DO UPDATE SET ios_target_build = EXCLUDED.ios_target_build,
           android_target_code = EXCLUDED.android_target_code, mandatory = EXCLUDED.mandatory,
           ios_min_build = EXCLUDED.ios_min_build,
           ios_nudge_build = EXCLUDED.ios_nudge_build, android_min_code = EXCLUDED.android_min_code,
           android_nudge_code = EXCLUDED.android_nudge_code, title = EXCLUDED.title,
           message = EXCLUDED.message, updated_at = NOW()`,
        [next.ios_target_build, next.android_target_code, next.mandatory,
         next.ios_min_build, next.ios_nudge_build, next.android_min_code, next.android_nudge_code,
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
    const target = ios ? g.ios_target_build : g.android_target_code;
    const min = ios ? g.ios_min_build : g.android_min_code;
    const nudge = ios ? g.ios_nudge_build : g.android_nudge_code;
    const storeUrl = ios ? IOS_URL : ANDROID_URL;
    const say = (action) => ({ action, title: g.title, message: g.message, storeUrl });
    // The admin switch wins: one target build, and `mandatory` decides block vs. ask.
    if (target > 0 && n < target) return say(g.mandatory ? 'block' : 'nudge');
    // Legacy 038 floors — only reachable if someone armed them directly.
    if (min > 0 && n < min) return say('block');
    if (nudge > 0 && n < nudge) return say('nudge');
    return { action: 'ok' };
}

module.exports = { getGate, setGate, evaluate };
