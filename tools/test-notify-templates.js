// Renders every admin notification template against the contexts that actually occur, and fails on
// the copy bugs that only show up for real users.
//
// These strings land on a stranger's lock screen, so the failure mode is not a crash — it is a
// message that reads as broken. The two that matter:
//   - a value the template assumed is missing, leaving "undefined", "NaN" or a doubled space;
//   - a mail-merge greeting with nothing to merge, which used to render "there, add your résumé".
// Both render fine for the seeded user an author tests with, and only break for the new signup we
// know nothing about — which is most of the people these get sent to.
//
// Run: node tools/test-notify-templates.js
'use strict';
const path = require('path');
const T = require(path.join(__dirname, '..', 'server', 'services', 'notifyTemplates'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};

// Anything that betrays a missing value or a broken join.
// ⚠️ The dangling-punctuation check must require the mark to END a clause. Matching a bare `\s+[.!?]`
// also flags legitimate copy — " .NET Developer" is a real job title, not a merge failure.
const BROKEN = /undefined|\bnull\b|NaN|\[object|\{\{|\}\}|,\s*,|\s{2,}|,\s*\.(\s|$)|\s+[.!?](\s|$)|^\s|\s$/;

const CONTEXTS = {
  // The user we know nothing about — a fresh signup. Every template must still read correctly.
  empty: { state: {}, job: null },
  // Someone with no name on file: the greeting has nothing to merge.
  nameless: { state: { completeness: { percent: 40, missing: ['resume'] }, credits: 0, savedJobs: 0 }, job: null },
  // A name we should NOT greet by.
  placeholderName: { firstName: 'User', fullName: 'User', state: { credits: 1 }, job: null },
  // Counts of exactly 1, where naive pluralisation breaks.
  singular: {
    firstName: 'Ana', fullName: 'Ana Lopez',
    state: {
      completeness: { percent: 100, missing: [] }, strongMatches: 1, matchedJobCount: 1, credits: 1,
      savedJobs: 1, applications: 1, coverLetters: 1, searches: 1, daysSinceSignup: 1, daysSinceLastSeen: 1,
      newJobsThisWeek: 1, hasResume: true, hasParsedResume: true, parseStatus: 'done',
      field: 'Design & UX', topMatch: { title: 'Product Designer', employer_name: 'Figma', match: 71, id: 'gj_1' },
    },
    job: { id: 'gj_1', title: 'Product Designer', employer_name: 'Figma', location: 'Remote', work_mode: 'Remote', match: 71 },
  },
  // Fully populated.
  rich: {
    firstName: 'Priya', fullName: 'Priya Sharma',
    state: {
      completeness: { percent: 100, missing: [] }, strongMatches: 7, matchedJobCount: 42, credits: 2,
      savedJobs: 3, applications: 0, coverLetters: 1, searches: 5, daysSinceSignup: 9, daysSinceLastSeen: 11,
      newJobsThisWeek: 120, hasResume: true, hasParsedResume: true, parseStatus: 'done', field: 'IT & Software',
      topMatch: { title: 'Senior .NET Developer', employer_name: 'Adyen', match: 88, id: 'gj_abc' },
    },
    job: { id: 'gj_abc', title: 'Senior .NET Developer', employer_name: 'Adyen', location: 'Amsterdam, Netherlands', work_mode: 'Hybrid', salary: null, match: 88 },
  },
  // Hostile-ish: values present but empty strings, which is how a half-filled DB row arrives.
  blanks: {
    firstName: '', fullName: '   ',
    state: { completeness: { percent: 0, missing: [] }, field: '', topMatch: { title: '', employer_name: '', match: 0 } },
    job: { id: '', title: '', employer_name: '', location: '', work_mode: '', match: 0 },
  },
};

// Only these routes are handled by the app (MobileApp/services/pushRouting.ts). A template pointing
// anywhere else is a notification that opens nothing.
//
// ⚠️ Keep this list and resolveRoute's switch in lockstep. The mirror-image assertion lives in
// MobileApp/scripts/test-push-routing.js ("every route in the server contract resolves to
// something") — adding a route here without teaching the app fails there, and vice versa.
// 'support', 'usage' and 'rewards' arrived with the lifecycle nudges in app build 143.
// 'tutorial' (the narrated film) arrived in build 158; it was missing here, which is why this suite
// never asked the one question that mattered for it — WHICH clip does the tap open? (see below).
const HANDLED_ROUTES = ['/(discover)', '/(ai-hub)', 'profile', 'help', 'support', 'usage', 'rewards', 'tutorial'];

// The tutorial's clip keys ARE the journey step keys, in film order. Pulled out of the SOURCE the way
// server/scripts/test-journey.js does it: services/journey.js opens the database on require, and this
// suite must run with no DATABASE_URL. test-journey.js pins these keys to the app's FILMS table, and
// MobileApp/scripts/test-push-routing.js pins the app's router to the same list — so a clip named here
// is one the app can actually open.
const FILM_KEYS = (() => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'server', 'services', 'journey.js'), 'utf8');
  const lit = src.match(/const STEPS = \[([\s\S]*?)\n\];/);
  return lit ? [...lit[1].matchAll(/key:\s*'([a-z_]+)'/g)].map((m) => m[1]) : [];
})();

console.log('rendering ' + T.TEMPLATES.length + ' templates × ' + Object.keys(CONTEXTS).length + ' contexts');
for (const tpl of T.TEMPLATES) {
  ok(`${tpl.key}: category is a real preference column`, T.PREF_CATEGORIES.includes(tpl.category), `got '${tpl.category}'`);
  ok(`${tpl.key}: route is one the app handles`, HANDLED_ROUTES.includes(tpl.route), `got '${tpl.route}'`);

  for (const [name, ctx] of Object.entries(CONTEXTS)) {
    let r = null;
    try { r = T.render(tpl, ctx); } catch (e) { ok(`${tpl.key} [${name}]: renders`, false, e.message); continue; }
    const title = String(r.title || ''), body = String(r.body || '');
    ok(`${tpl.key} [${name}]: has a title and body`, !!title && !!body);
    ok(`${tpl.key} [${name}]: title is clean`, !BROKEN.test(title), JSON.stringify(title));
    ok(`${tpl.key} [${name}]: body is clean`, !BROKEN.test(body), JSON.stringify(body));
    // A lock screen truncates well before this; anything longer is not read.
    ok(`${tpl.key} [${name}]: title fits a lock screen`, title.length <= 62, `${title.length} chars: ${title}`);
    ok(`${tpl.key} [${name}]: body is a reasonable length`, body.length <= 200, `${body.length} chars`);
    ok(`${tpl.key} [${name}]: params serialise`, (() => { try { JSON.stringify(r.params); return true; } catch (_) { return false; } })());
  }

  // relevanceFor must never throw on a sparse state — it runs for every template on every page load.
  for (const [name, ctx] of Object.entries(CONTEXTS)) {
    try { T.relevanceFor(tpl, ctx.state || {}); ok(`${tpl.key} [${name}]: relevance computes`, true); }
    catch (e) { ok(`${tpl.key} [${name}]: relevance computes`, false, e.message); }
  }
}

ok('no template uses a category outside notification_preferences', T.invalidCategories().length === 0, JSON.stringify(T.invalidCategories()));

// ── A push that opens the tutorial must open the RIGHT CLIP ─────────────────────────────────────
// ⚠️ 2026-09-19: how_it_works ("Watch the app fill a job form for you") sent no params, so every tap
// opened clip 01 "Set up your profile" and the owner had to hunt for the part the push promised. The
// route resolved, the screen played, and nothing here failed — the tap was merely useless.
ok('journey STEPS parsed (the five clip keys)', FILM_KEYS.length === 5, JSON.stringify(FILM_KEYS));
const tutorialTemplates = T.TEMPLATES.filter((t) => t.route === 'tutorial');
ok('at least one template opens the tutorial (else this block tests nothing)', tutorialTemplates.length > 0);
for (const tpl of tutorialTemplates) {
  for (const [name, ctx] of Object.entries(CONTEXTS)) {
    const p = T.render(tpl, ctx).params || {};
    ok(`${tpl.key} [${name}]: names the clip it is about`, FILM_KEYS.includes(p.film), `got film=${JSON.stringify(p.film)}`);
    if (p.until !== undefined) {
      // `until` plays on through the following clips. At or before `film` it would chain nothing.
      ok(`${tpl.key} [${name}]: 'until' is a clip AFTER 'film'`,
        FILM_KEYS.includes(p.until) && FILM_KEYS.indexOf(p.until) > FILM_KEYS.indexOf(p.film),
        `film=${p.film} until=${p.until}`);
    }
    ok(`${tpl.key} [${name}]: carries nothing but film/until`,
      Object.keys(p).every((k) => k === 'film' || k === 'until'), JSON.stringify(p));
  }
}
// The owner's "4-5": clip 04 (the letter) then 05 (Auto Fill fills the form with it).
{
  const how = T.get ? T.get('how_it_works') : T.TEMPLATES.find((t) => t.key === 'how_it_works');
  const p = how ? T.render(how, CONTEXTS.rich).params : null;
  ok('how_it_works opens clip 04 and plays on into 05', JSON.stringify(p) === JSON.stringify({ film: 'cover_letter', until: 'apply' }), JSON.stringify(p));
  // The copy must describe what THE RECIPIENT'S BUILD opens. On 210+ that is clips 04→05, so the old
  // "the whole thing in 90 seconds — set up once, then find a job…" would sell more than the tap
  // shows. But every build up to 209 drops the params and lands on clip 01 "Set up your profile":
  // sending THOSE users the two-clip line promises a letter + form fill and shows profile set-up.
  // ⚠️ 2026-09-19 review: the first cut changed the body for everyone while ~all of the fleet was on
  // ≤209 — so the split is pinned here at the exact boundary, both formats and the unknown case.
  const MIN = T.TUTORIAL_FILM_MIN_BUILD;
  ok('TUTORIAL_FILM_MIN_BUILD is exported and is the build after 209 (the last one that drops film)',
    Number.isInteger(MIN) && MIN >= 210, String(MIN));
  const bodyOn = (appVersion) => (how ? String(T.render(how, { state: { appVersion } }).body || '') : '');
  const HEAD_BODY = 'The whole thing in 90 seconds — set up once, then find a job and apply without typing it all out again.';
  const namesBothClips = (b) => /cover letter/i.test(b) && /auto ?fill/i.test(b) && b.search(/cover letter/i) < b.search(/auto ?fill/i);
  const sellsWholeFilm = (b) => /whole thing|set up|find a job|90 seconds/i.test(b);
  // Builds that open the named clip get the two-clip line.
  for (const v of [`4.7 (${MIN})`, `4.7 (${MIN + 1})`, '5.0 (231)', `4.7 (${MIN}) `]) {
    const b = bodyOn(v);
    ok(`how_it_works on ${JSON.stringify(v)}: body names both clips it opens (the cover letter, then Auto Fill)`, namesBothClips(b), b);
    ok(`how_it_works on ${JSON.stringify(v)}: body does not sell the whole film`, !sellsWholeFilm(b), b);
    ok(`how_it_works on ${JSON.stringify(v)}: body is clean and fits`, !BROKEN.test(b) && b.length <= 200, b);
  }
  // Builds that open clip 01 whatever the push names — and every recipient whose build we do not
  // know — keep the ORIGINAL line byte-for-byte: it is what they have always received and opened.
  for (const v of [`4.6 (${MIN - 1})`, '4.6 (209)', '4.5 (201)', '4.4 (183)', '3.9 (167)', '3.4', '2.8',
    null, undefined, '', 'abc', '4.6 (abc)']) {
    const b = bodyOn(v);
    ok(`how_it_works on ${JSON.stringify(v)}: keeps the original body (the tap opens clip 01 there)`, b === HEAD_BODY, b);
  }
  ok('how_it_works with no state at all (segment preview with nobody reachable) keeps the original body',
    how && String(T.render(how, { state: {} }).body) === HEAD_BODY);
  // The params do NOT follow the build: an old build ignores them, a new one needs them.
  ok('how_it_works names the clip on an old build too (harmless there, needed the moment they update)',
    how && JSON.stringify(T.render(how, { state: { appVersion: '4.5 (201)' } }).params) === JSON.stringify({ film: 'cover_letter', until: 'apply' }));
  // buildOf reads the build the same way the build-aware segments in adminUserOps.js do ("(165)" → 165).
  ok('buildOf("4.6 (209)") = 209', T.buildOf('4.6 (209)') === 209);
  ok('buildOf of a bare version / null / junk = 0 (predates the build-number format)',
    [T.buildOf('3.4'), T.buildOf(null), T.buildOf(undefined), T.buildOf('abc')].every((n) => n === 0));

  // ⚠️ The split only works if the send path LOADS the build. adminUserOps.stateTierFor() scans the
  // template's title/body/params source: a template that reads no DB field is rendered from
  // lightUserState(), whose appVersion is always null — every recipient would get the old line and
  // 210+ would never see the new one, silently. Ask the REAL stateTierFor. adminUserOps requires
  // db-config, which exits without a DATABASE_URL and pings the one it is given, so it runs in a
  // child with an unreachable stand-in URL and exits before the ping can answer.
  const probe = require('child_process').spawnSync(process.execPath, ['-e',
    `const A = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'services', 'adminUserOps'))});
     const T = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'services', 'notifyTemplates'))});
     process.stdout.write('TIER=' + A.stateTierFor(T.get('how_it_works')) + '\\n');
     process.exit(0);`],
  { env: { ...process.env, DATABASE_URL: 'postgresql://tier-probe@127.0.0.1:9/none' }, encoding: 'utf8', timeout: 30000 });
  const tier = ((probe.stdout || '').match(/TIER=(\w+)/) || [])[1] || null;
  ok('how_it_works state is built with the recipient\'s build (stateTierFor is not \'light\')',
    tier === 'basic' || tier === 'full', `tier=${tier} status=${probe.status} ${String(probe.stderr || '').slice(0, 300)}`);
}
// …and nothing else grew a film param: every other payload must stay byte-for-byte what it was.
for (const tpl of T.TEMPLATES.filter((t) => t.route !== 'tutorial')) {
  const p = T.render(tpl, CONTEXTS.rich).params || {};
  ok(`${tpl.key}: no tutorial params on a non-tutorial push`, !('film' in p) && !('until' in p), JSON.stringify(p));
}

// The greeting must not merge a name that is not one.
const greetingTemplates = T.TEMPLATES.filter((t) => /\$\{n\}|greet\(/.test(String(t.title)));
for (const tpl of greetingTemplates) {
  const nameless = T.render(tpl, CONTEXTS.nameless).title;
  const placeholder = T.render(tpl, CONTEXTS.placeholderName).title;
  ok(`${tpl.key}: no filler greeting when the name is missing`, !/^there[,\s]/i.test(nameless) && !/\bthere,/i.test(nameless), nameless);
  ok(`${tpl.key}: does not greet a placeholder name`, !/\bUser\b/.test(placeholder), placeholder);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
