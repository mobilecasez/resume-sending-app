#!/usr/bin/env node
// Tests for pushBlockReason() — the admin screen's answer to "why can't I reach this user?".
//
// Worth testing because the wrong answer here is worse than no answer: telling an admin "they
// declined notifications" when the truth is "our Android build could never register" sends them
// looking at the user instead of at us. That is exactly the mistake the old copy caused — every one
// of the 12 Android users showed the same generic "no push token" line while the real cause was a
// missing google-services.json in the build.
//
//   node tools/test-push-block-reason.js

const {
  pushBlockReason, compareVersions, ANDROID_FCM_MIN_VERSION,
} = require('../server/services/adminUserOps');

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fails.push(`${name}${extra ? ` — ${extra}` : ''}`);
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// A user state as buildUserState() produces it, with only the fields pushBlockReason reads.
const st = (o) => ({
  hasPushToken: false, platform: null, appVersion: null, firstEvent: null, lastEvent: null, ...o,
});
const DAY = '2026-07-20T10:00:00.000Z';

// ── compareVersions ──────────────────────────────────────────────────────────
eq('cmp equal', compareVersions('3.4', '3.4'), 0);
ok('cmp 3.3 < 3.4', compareVersions('3.3', '3.4') < 0);
ok('cmp 3.5 > 3.4', compareVersions('3.5', '3.4') > 0);
ok('cmp 3.10 > 3.4 (numeric, not lexical)', compareVersions('3.10', '3.4') > 0);
ok('cmp 10.0 > 9.9 (numeric, not lexical)', compareVersions('10.0', '9.9') > 0);
eq('cmp missing segments are 0', compareVersions('3.4', '3.4.0'), 0);
ok('cmp 3.4.1 > 3.4', compareVersions('3.4.1', '3.4') > 0);
ok('cmp null is lowest', compareVersions(null, '3.4') < 0);
ok('cmp empty is lowest', compareVersions('', '3.4') < 0);
ok('cmp junk sorts as 0', compareVersions('abc', '3.4') < 0);
eq('cmp junk vs junk', compareVersions('abc', 'xyz'), 0);
ok('cmp "3.4-beta" treated as 3.4', compareVersions('3.4-beta', '3.4') === 0);

// ── has a token → never blocked, whatever else is true ───────────────────────
eq('token present → null', pushBlockReason(st({ hasPushToken: true })), null);
eq('token present on old android → null',
  pushBlockReason(st({ hasPushToken: true, platform: 'android', appVersion: '3.0' })), null);
eq('token present, never opened app → null (token wins)',
  pushBlockReason(st({ hasPushToken: true, lastEvent: null, firstEvent: null })), null);

// ── never opened the app ─────────────────────────────────────────────────────
{
  const r = pushBlockReason(st({}));
  eq('web-only → never_opened_app', r && r.code, 'never_opened_app');
  ok('web-only is not admin-fixable', r && r.fixable === false);
  ok('web-only detail mentions the website', /website/i.test((r && r.detail) || ''));
}
eq('firstEvent alone counts as having opened the app',
  (pushBlockReason(st({ firstEvent: DAY })) || {}).code, 'notifications_off');

// ── android without FCM ──────────────────────────────────────────────────────
for (const v of ['3.0', '3.3', '2.9', '1.0']) {
  const r = pushBlockReason(st({ platform: 'android', appVersion: v, lastEvent: DAY }));
  eq(`android ${v} → android_no_fcm`, r && r.code, 'android_no_fcm');
  ok(`android ${v} label names the version`, (r.label || '').includes(v));
}
eq('android with UNKNOWN version → android_no_fcm (null sorts below the floor)',
  (pushBlockReason(st({ platform: 'android', appVersion: null, lastEvent: DAY })) || {}).code,
  'android_no_fcm');
eq('ANDROID case is normalised',
  (pushBlockReason(st({ platform: 'ANDROID', appVersion: '3.3', lastEvent: DAY })) || {}).code,
  'android_no_fcm');

// The floor itself and everything above it must NOT be blamed on the build.
eq(`android exactly ${ANDROID_FCM_MIN_VERSION} → notifications_off`,
  (pushBlockReason(st({ platform: 'android', appVersion: ANDROID_FCM_MIN_VERSION, lastEvent: DAY })) || {}).code,
  'notifications_off');
for (const v of ['3.5', '3.10', '4.0']) {
  eq(`android ${v} (above the floor) → notifications_off`,
    (pushBlockReason(st({ platform: 'android', appVersion: v, lastEvent: DAY })) || {}).code,
    'notifications_off');
}

// ── iOS is never blamed on the FCM bug — iOS push goes over APNs and never needed Firebase ──
for (const v of ['3.0', '3.3', '3.4']) {
  eq(`ios ${v} → notifications_off, never android_no_fcm`,
    (pushBlockReason(st({ platform: 'ios', appVersion: v, lastEvent: DAY })) || {}).code,
    'notifications_off');
}
eq('unknown platform that has opened the app → notifications_off',
  (pushBlockReason(st({ platform: null, appVersion: '3.3', lastEvent: DAY })) || {}).code,
  'notifications_off');

// ── ordering: "never opened" beats the platform branch ───────────────────────
// An android row with events=null must read as "never opened", not "old android build" — otherwise
// the admin is told to wait for an update that will never be installed.
eq('android with no events at all → never_opened_app',
  (pushBlockReason(st({ platform: 'android', appVersion: '3.3' })) || {}).code, 'never_opened_app');

// ── the token MOVED to another account on the same phone (one device, one account — 2026-09-20) ──
// Nobody declined anything: someone else signed in on this user's phone. "Notifications are switched off … only the
// user can reverse it in Settings" was the wrong answer for accounts 88/89 and 17/616, which share a phone.
{
  const MOVED = '2026-09-20T10:00:00.000Z';
  const r = pushBlockReason(st({ platform: 'ios', appVersion: '4.6.0', firstEvent: DAY, lastEvent: DAY, pushTokenMovedAt: MOVED }));
  eq('token moved → device_signed_into_other_account', r && r.code, 'device_signed_into_other_account');
  ok('moved is not admin-fixable', r && r.fixable === false);
  ok('moved never says notifications are off', !/switched off|declined/i.test(`${r && r.label} ${r && r.detail}`));
  eq('moved beats the old-android branch',
    (pushBlockReason(st({ platform: 'android', appVersion: '3.3', lastEvent: DAY, pushTokenMovedAt: MOVED })) || {}).code,
    'device_signed_into_other_account');
  eq('a token present wins over a stale moved stamp',
    pushBlockReason(st({ hasPushToken: true, pushTokenMovedAt: MOVED })), null);
  eq('no moved stamp → unchanged (notifications_off)',
    (pushBlockReason(st({ platform: 'ios', appVersion: '4.6.0', lastEvent: DAY, pushTokenMovedAt: null })) || {}).code,
    'notifications_off');

  // ⚠️ REGRESSION (2026-09-20 review): the stamp is cleared by ONE thing only — this user registering a token again —
  // so read as a mere presence it is permanent. A user who has OPENED THE APP SINCE the move and still has no token did
  // not lose it to the other phone: they declined the permission, or their Android build could never register. The
  // branch is fixable:false, so answering it there hides `android_no_fcm` — the one cause an admin can act on ("tell
  // them to update"). Production stamps 17, 616, 88, 89, 118, 498 the first time the new code runs.
  const LATER = '2026-09-21T10:00:00.000Z';
  eq('moved, but the user has opened the app SINCE → the real cause, not the stale stamp',
    (pushBlockReason(st({ platform: 'ios', appVersion: '4.6.0', firstEvent: DAY, lastEvent: LATER, pushTokenMovedAt: MOVED })) || {}).code,
    'notifications_off');
  eq('…and an old Android build still gets the answer an admin can act on',
    (pushBlockReason(st({ platform: 'android', appVersion: '3.3', firstEvent: DAY, lastEvent: LATER, pushTokenMovedAt: MOVED })) || {}).code,
    'android_no_fcm');
  eq('opened at the same instant as the move → still the move (only a LATER open clears it)',
    (pushBlockReason(st({ platform: 'ios', appVersion: '4.6.0', lastEvent: MOVED, pushTokenMovedAt: MOVED })) || {}).code,
    'device_signed_into_other_account');
  eq('moved with no events since → still the move',
    (pushBlockReason(st({ platform: 'ios', appVersion: '4.6.0', firstEvent: DAY, lastEvent: null, pushTokenMovedAt: MOVED })) || {}).code,
    'device_signed_into_other_account');
  eq('an unparseable stamp never crashes and keeps the move answer',
    (pushBlockReason(st({ platform: 'ios', appVersion: '4.6.0', lastEvent: LATER, pushTokenMovedAt: 'not-a-date' })) || {}).code,
    'device_signed_into_other_account');
  eq('an unparseable lastEvent keeps the move answer',
    (pushBlockReason(st({ platform: 'ios', appVersion: '4.6.0', lastEvent: 'nonsense', pushTokenMovedAt: MOVED })) || {}).code,
    'device_signed_into_other_account');
  eq('a Date object for lastEvent works too (what the DB driver returns)',
    (pushBlockReason(st({ platform: 'ios', appVersion: '4.6.0', lastEvent: new Date(LATER), pushTokenMovedAt: new Date(MOVED) })) || {}).code,
    'notifications_off');
}

// ── shape contract: every branch is renderable ───────────────────────────────
const ALL = [
  pushBlockReason(st({})),
  pushBlockReason(st({ platform: 'android', appVersion: '3.3', lastEvent: DAY })),
  pushBlockReason(st({ platform: 'ios', appVersion: '3.4', lastEvent: DAY })),
  pushBlockReason(st({ platform: 'ios', appVersion: '4.6.0', lastEvent: DAY, pushTokenMovedAt: DAY })),
];
for (const r of ALL) {
  ok(`${r.code}: has a non-empty label`, typeof r.label === 'string' && r.label.length > 3);
  ok(`${r.code}: has a non-empty detail`, typeof r.detail === 'string' && r.detail.length > 20);
  ok(`${r.code}: fixable is a boolean`, typeof r.fixable === 'boolean');
  // The UI lowercases the label mid-sentence, so it must not start with an acronym that would look
  // wrong lowercased, and must not already end with punctuation the UI appends after.
  ok(`${r.code}: label has no trailing period`, !/[.!?]$/.test(r.label));
  ok(`${r.code}: detail ends in a full stop`, /\.$/.test(r.detail));
}
const codes = ALL.map((r) => r.code);
eq('all four branches are distinct', new Set(codes).size, 4);

// ── defensive: garbage in ────────────────────────────────────────────────────
eq('null state → null', pushBlockReason(null), null);
eq('undefined state → null', pushBlockReason(undefined), null);
eq('empty object → never_opened_app', (pushBlockReason({}) || {}).code, 'never_opened_app');

console.log(`\npushBlockReason: ${pass} assertions passed, ${fails.length} failed`);
console.log(`(ANDROID_FCM_MIN_VERSION = ${ANDROID_FCM_MIN_VERSION})`);
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ all green');
