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
const HANDLED_ROUTES = ['/(discover)', '/(ai-hub)', 'profile', 'help'];

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
