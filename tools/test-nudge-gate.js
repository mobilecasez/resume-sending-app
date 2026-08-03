// The rules that stop CVApplyr becoming a nagging app. Pure functions, plain node, no database:
//   node tools/test-nudge-gate.js
//
// Why this file exists. "Don't irritate the user" is the requirement that is easiest to claim and
// hardest to verify — it only shows up in production, weeks later, as uninstalls. Every branch of
// nudgeGate.check() and the lifecycleNudges priority ladder is deterministic, so all of it can be
// asserted here instead: the 20-hour gap, the weekly cap, the escalating backoff, the point where a
// nudge gives up entirely, and the rule that someone who has ignored us three times gets left alone.
'use strict';
const path = require('path');

// Every assertion below is on a pure function, so this test must never reach a database — and
// FORCING a throwaway connection string is how that is guaranteed rather than hoped for. Without
// it the modules pick up whatever DATABASE_URL is in .env, which on this machine points at
// PRODUCTION. A test that can reach prod eventually will.
process.env.DATABASE_URL = 'postgresql://test@127.0.0.1:1/nudge_gate_unit_test';

const gate = require(path.join(__dirname, '..', 'server', 'services', 'nudgeGate'));
const life = require(path.join(__dirname, '..', 'server', 'services', 'lifecycleNudges'));

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (got !== undefined ? '  → got ' + JSON.stringify(got) : '')); }
};

const HOUR = 3600000, DAY = 86400000;
const NOW = Date.UTC(2026, 7, 4, 15, 0, 0);          // a fixed Tuesday 15:00 UTC — no Date.now()

/** Build a gate state. `hours` = [0..23] the user has been seen active in. */
function state({ lastSentAt = null, sent7d = 0, byKey = {}, recent = [], hours = [15] } = {}) {
  return {
    lastSentAt, sent7d,
    byKey: new Map(Object.entries(byKey)),
    recent,
    activeHours: new Set(hours),
  };
}

// ── 1. A clean slate ──────────────────────────────────────────────────────────────────────────
console.log('\nfirst contact');
{
  const r = gate.check(101, 'nudge_upload_resume', state(), NOW);
  ok('a user we have never nudged is eligible', r.ok === true, r);
  ok('…as attempt 1', r.attempt === 1, r);
}

// ── 2. The global gap and the weekly cap ──────────────────────────────────────────────────────
console.log('\nglobal frequency');
{
  const soon = gate.check(101, 'nudge_add_photo', state({ lastSentAt: NOW - 5 * HOUR }), NOW);
  ok('a push 5h ago blocks the next one', soon.ok === false && soon.reason === 'too_soon', soon);

  const later = gate.check(101, 'nudge_add_photo', state({ lastSentAt: NOW - 25 * HOUR, sent7d: 1 }), NOW);
  ok('25h later it is allowed again', later.ok === true, later);

  const edge = gate.check(101, 'nudge_add_photo', state({ lastSentAt: NOW - 19.5 * HOUR, sent7d: 1 }), NOW);
  ok('19.5h is still too soon (the boundary is 20h, not "about a day")', edge.ok === false && edge.reason === 'too_soon', edge);

  const capped = gate.check(101, 'nudge_add_photo', state({ lastSentAt: NOW - 30 * HOUR, sent7d: 3 }), NOW);
  ok('3 pushes in 7 days is the ceiling', capped.ok === false && capped.reason === 'weekly_cap', capped);

  const under = gate.check(101, 'nudge_add_photo', state({ lastSentAt: NOW - 30 * HOUR, sent7d: 2 }), NOW);
  ok('2 in 7 days still leaves room for one', under.ok === true, under);
}

// ── 3. Escalating backoff, then giving up ─────────────────────────────────────────────────────
console.log('\nper-nudge backoff');
{
  const key = 'nudge_upload_resume';
  const day1 = gate.check(101, key, state({ byKey: { [key]: { at: NOW - 1 * DAY, attempt: 1 } } }), NOW);
  ok('the same nudge one day later is held back', day1.ok === false && day1.reason === 'backoff', day1);

  const day4 = gate.check(101, key, state({ byKey: { [key]: { at: NOW - 4 * DAY, attempt: 1 } } }), NOW);
  ok('after 3 days it may go again', day4.ok === true, day4);
  ok('…as attempt 2', day4.attempt === 2, day4);

  const day5 = gate.check(101, key, state({ byKey: { [key]: { at: NOW - 5 * DAY, attempt: 2 } } }), NOW);
  ok('attempt 3 waits longer than attempt 2 did (5 days is not enough)', day5.ok === false && day5.reason === 'backoff', day5);

  const day9 = gate.check(101, key, state({ byKey: { [key]: { at: NOW - 9 * DAY, attempt: 2 } } }), NOW);
  ok('after 8 days attempt 3 is allowed', day9.ok === true && day9.attempt === 3, day9);

  const done = gate.check(101, key, state({ byKey: { [key]: { at: NOW - 60 * DAY, attempt: 3 } } }), NOW);
  ok('a nudge ignored three times is NEVER sent again, however long we wait',
    done.ok === false && done.reason === 'max_attempts', done);
}

// ── 4. The rule that actually protects people ─────────────────────────────────────────────────
console.log('\nsilence');
{
  const ignored = [
    { at: NOW - 5 * DAY, responded: false },
    { at: NOW - 12 * DAY, responded: false },
    { at: NOW - 20 * DAY, responded: false },
  ];
  const s = gate.check(101, 'nudge_add_photo', state({ recent: ignored, lastSentAt: NOW - 5 * DAY }), NOW);
  ok('3 nudges with no app open pauses everything', s.ok === false && s.reason === 'silent_user', s);
  ok('…and says until when', /paused until/.test(s.detail || ''), s);

  const answered = [
    { at: NOW - 5 * DAY, responded: true },
    { at: NOW - 12 * DAY, responded: false },
    { at: NOW - 20 * DAY, responded: false },
  ];
  const a = gate.check(101, 'nudge_add_photo', state({ recent: answered, lastSentAt: NOW - 5 * DAY, sent7d: 1 }), NOW);
  ok('one app open in the streak means they ARE listening', a.ok === true, a);

  // 31 days after the last ignored nudge the pause lapses and we may try once more.
  const lapsed = ignored.map((r) => ({ ...r, at: r.at - 31 * DAY }));
  const l = gate.check(101, 'nudge_add_photo', state({ recent: lapsed, lastSentAt: NOW - 36 * DAY }), NOW);
  ok('the pause expires — it is a cool-off, not a permanent ban', l.ok === true, l);

  const two = [{ at: NOW - 5 * DAY, responded: false }, { at: NOW - 12 * DAY, responded: false }];
  const t = gate.check(101, 'nudge_add_photo', state({ recent: two, lastSentAt: NOW - 5 * DAY, sent7d: 1 }), NOW);
  ok('two ignored is not yet a pattern', t.ok === true, t);
}

// ── 5. Quiet hours, from the user's own activity ──────────────────────────────────────────────
console.log('\nquiet hours');
{
  const nightOwl = state({ hours: [22, 23, 0, 1] });
  const at15 = gate.check(101, 'nudge_add_photo', nightOwl, NOW);
  ok('15:00 UTC is refused for someone only ever seen at 22:00–01:00',
    at15.ok === false && at15.reason === 'quiet_hours', at15);

  const at23 = gate.check(101, 'nudge_add_photo', nightOwl, Date.UTC(2026, 7, 4, 23, 0, 0));
  ok('23:00 UTC is fine for that same person', at23.ok === true, at23);

  const at2 = gate.check(101, 'nudge_add_photo', state({ hours: [23] }), Date.UTC(2026, 7, 4, 2, 0, 0));
  ok('the clock wraps: 02:00 is 3 hours from 23:00, not 21', at2.ok === true, at2);

  const at5 = gate.check(101, 'nudge_add_photo', state({ hours: [23] }), Date.UTC(2026, 7, 4, 5, 0, 0));
  ok('…but 05:00 is genuinely the middle of their night', at5.ok === false && at5.reason === 'quiet_hours', at5);

  const noData = gate.check(101, 'nudge_add_photo', state({ hours: [] }), NOW);
  ok('with no evidence at all we do not block (we would block everyone forever)', noData.ok === true, noData);

  const admin = gate.check(101, 'nudge_add_photo', nightOwl, NOW, { ignoreQuietHours: true });
  ok('an admin doing a deliberate send can override quiet hours', admin.ok === true, admin);

  ok('hour distance is circular', gate._hourDistance(23, 1) === 2, gate._hourDistance(23, 1));
  ok('hour distance is symmetric', gate._hourDistance(1, 23) === 2, gate._hourDistance(1, 23));
}

// ── 6. Accounts we must never nudge ───────────────────────────────────────────────────────────
console.log('\nexclusions');
{
  const t = gate.check(14, 'nudge_add_photo', state(), NOW);
  ok('the founder/QA accounts are excluded (id 14)', t.ok === false && t.reason === 'test_account', t);
  ok('and the exclusion list is shared, not copied per job', gate.TEST_USER_IDS.has(24) && gate.TEST_USER_IDS.has(43));
}

// ── 7. The priority ladder ────────────────────────────────────────────────────────────────────
console.log('\nwhich nudge fits');
const base = {
  daysSinceSignup: 10, hasResume: false, hasPhoto: false, hasSignature: false, parseStatus: null,
  completeness: { percent: 20, missing: ['resume', 'photo'] },
  savedJobs: 0, coverLetters: 0, applications: 0, searches: 0, daysSinceLastSeen: 1,
  strongMatches: 0, matchedJobCount: 0, hasParsedResume: false, field: null,
  credits: 5, trialDaysLeft: null, lettersLeft: 0, resumesLeft: 0, hasOpenSupportThread: false,
  newJobsThisWeek: 0, pendingApplication: null, topMatch: null, firstName: 'Sam',
};
const allOn = {};
for (const n of life.NUDGES) allOn[n.key] = true;

{
  const p = life.pickNudge(base, state(), allOn);
  ok('no résumé beats everything else', p.nudge && p.nudge.key === 'nudge_upload_resume', p.nudge && p.nudge.key);
  ok('…and it carries the biggest incentive', p.nudge.incentive.amount === 3, p.nudge.incentive);

  const off = { ...allOn, nudge_upload_resume: false };
  const p2 = life.pickNudge(base, state(), off);
  ok('switching it off in admin really skips it', !p2.nudge || p2.nudge.key !== 'nudge_upload_resume', p2.nudge && p2.nudge.key);

  const fresh = life.pickNudge({ ...base, daysSinceSignup: 0 }, state(), allOn);
  ok('someone who signed up today is left alone entirely', !fresh.nudge, fresh.nudge && fresh.nudge.key);

  const withResume = { ...base, hasResume: true, hasParsedResume: true, completeness: { percent: 85, missing: ['photo'] } };
  const p3 = life.pickNudge(withResume, state(), allOn);
  ok('with a résumé in place the photo nudge becomes the fit', p3.nudge && p3.nudge.key === 'nudge_add_photo', p3.nudge && p3.nudge.key);

  const saved = { ...withResume, hasPhoto: true, hasSignature: true, completeness: { percent: 100, missing: [] }, searches: 4, savedJobs: 3 };
  const p4 = life.pickNudge(saved, state(), allOn);
  ok('saved jobs but no letter → the cover-letter nudge',
    p4.nudge && p4.nudge.key === 'nudge_generate_cover_letter', p4.nudge && p4.nudge.key);
}

// ── 8. "Are you facing any issue?" is asked LAST ──────────────────────────────────────────────
console.log('\nthe support check-in');
{
  // Someone who tried the app and stalled, with everything else already done or not applicable.
  const stalled = {
    ...base, hasResume: true, hasParsedResume: true, hasPhoto: true, hasSignature: true,
    completeness: { percent: 100, missing: [] }, searches: 6, savedJobs: 2, coverLetters: 1,
    applications: 0, daysSinceLastSeen: 3, daysSinceSignup: 12,
  };
  const noHistory = life.pickNudge(stalled, state({ recent: [] }), allOn);
  ok('it is NOT the first thing we ask — an earlier nudge wins',
    noHistory.nudge && noHistory.nudge.key !== 'nudge_support_checkin', noHistory.nudge && noHistory.nudge.key);

  // Now suppose every earlier nudge is switched off, so only the check-in could apply.
  const onlyCheckin = {};
  for (const n of life.NUDGES) onlyCheckin[n.key] = n.key === 'nudge_support_checkin';

  const tooEarly = life.pickNudge(stalled, state({ recent: [{ at: NOW - 5 * DAY, responded: true }] }), onlyCheckin);
  ok('with only 1 earlier nudge it still holds off', !tooEarly.nudge, tooEarly.nudge && tooEarly.nudge.key);

  const ready = life.pickNudge(stalled, state({
    recent: [{ at: NOW - 5 * DAY, responded: true }, { at: NOW - 12 * DAY, responded: true }],
  }), onlyCheckin);
  ok('after 2 earlier nudges we finally ask', ready.nudge && ready.nudge.key === 'nudge_support_checkin', ready.nudge && ready.nudge.key);

  const alreadyTalking = life.pickNudge({ ...stalled, hasOpenSupportThread: true }, state({
    recent: [{ at: NOW - 5 * DAY, responded: true }, { at: NOW - 12 * DAY, responded: true }],
  }), onlyCheckin);
  ok('someone already in a conversation with support is not asked again',
    !alreadyTalking.nudge, alreadyTalking.nudge && alreadyTalking.nudge.key);

  const neverStarted = life.pickNudge({ ...base, daysSinceSignup: 30 }, state({
    recent: [{ at: NOW - 5 * DAY, responded: true }, { at: NOW - 12 * DAY, responded: true }],
  }), onlyCheckin);
  ok('someone who never got started is not asked "did something break?" — nothing broke',
    !neverStarted.nudge, neverStarted.nudge && neverStarted.nudge.key);

  const applied = life.pickNudge({ ...stalled, applications: 2 }, state({
    recent: [{ at: NOW - 5 * DAY, responded: true }, { at: NOW - 12 * DAY, responded: true }],
  }), onlyCheckin);
  ok('someone who applied successfully is not asked either', !applied.nudge, applied.nudge && applied.nudge.key);
}

// ── 9. The registry itself ────────────────────────────────────────────────────────────────────
console.log('\nregistry sanity');
{
  const templates = require(path.join(__dirname, '..', 'server', 'services', 'notifyTemplates'));
  const switches = require(path.join(__dirname, '..', 'server', 'services', 'notifSwitch'));
  const switchKeys = new Set(switches.SWITCHES.map((s) => s.key));

  const missingTpl = life.NUDGES.filter((n) => !templates.get(n.templateKey)).map((n) => n.key);
  ok('every nudge points at a template that exists', missingTpl.length === 0, missingTpl);

  const missingSwitch = life.NUDGES.filter((n) => !switchKeys.has(n.key)).map((n) => n.key);
  ok('every nudge has an admin on/off switch', missingSwitch.length === 0, missingSwitch);

  const noDone = life.NUDGES.filter((n) => typeof n.done !== 'function').map((n) => n.key);
  ok('every nudge can tell whether the user finished the step', noDone.length === 0, noDone);

  const badIncentive = life.NUDGES.filter((n) => n.incentive &&
    !['promise', 'immediate'].includes(n.incentive.mode)).map((n) => n.key);
  ok('every incentive has a known mode', badIncentive.length === 0, badIncentive);

  // An incentive the copy never mentions is one the user cannot act on.
  const silentOffer = life.NUDGES.filter((n) => n.incentive && !n.incentive.offer).map((n) => n.key);
  ok('every incentive is stated in the notification copy', silentOffer.length === 0, silentOffer);

  const dupes = life.NUDGES.map((n) => n.key).filter((k, i, a) => a.indexOf(k) !== i);
  ok('no duplicate nudge keys', dupes.length === 0, dupes);

  ok('the support check-in is last in the ladder',
    life.NUDGES[life.NUDGES.length - 1].key === 'nudge_support_checkin',
    life.NUDGES[life.NUDGES.length - 1].key);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
