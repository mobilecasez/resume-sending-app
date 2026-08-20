// "Best match" must mean best match. The badge on a job card shows a percentage; if the list is not
// in that order, the number stops being believed — and the list WAS not in that order.
//
// Two causes, both in the ORDER BY:
//   1. match-first bucketed match into TENS (floor(match/10)), with geography deciding inside each
//      bucket — so a real list read 78%, 71%, 75%, 73%.
//   2. country-first was chosen from DATA, not from the user, so picking "Best match" could still
//      return a country-first list where a 40% local job outranked a 95% one.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; } else { fail++; console.log(`  ✗ ${n}${x !== undefined ? ' → ' + x : ''}`); } };

const geoSrc = fs.readFileSync(path.join(__dirname, '../utils/geoRank.js'), 'utf8');
const m = new module.constructor();
m._compile(geoSrc.match(/function orderSql[\s\S]*?\n}\n/)[0] + '\nmodule.exports = { orderSql };', '/georank-harness.js');
const { orderSql } = m.exports;

console.log('── the default sort ──');
const mf = orderSql('match-first', { tier: 'geo_tier', match: 'match' });
ok('match is the FIRST key', /^match DESC NULLS LAST/.test(mf), mf);
ok('geography only breaks ties', /match DESC NULLS LAST, geo_tier ASC/.test(mf), mf);
// ⚠️ The exact thing that made the order look random. If this ever comes back, so does the bug.
ok('match is NOT bucketed into tens any more', !/floor\(/.test(mf), mf);

console.log('── "Near me" still puts place first, because that is what it means ──');
const cf = orderSql('country-first', { tier: 'geo_tier', match: 'match' });
ok('tier first', /^geo_tier ASC/.test(cf), cf);
ok('then match, highest first', /geo_tier ASC, match DESC NULLS LAST/.test(cf), cf);

console.log('── the sort the user picks is the sort they get ──');
const dc = fs.readFileSync(path.join(__dirname, '../controllers/discoverController.js'), 'utf8');
ok('three sorts are accepted', /\/\^\(recent\|nearby\)\$\/\.test\(String\(req\.query\.sort/.test(dc));
ok('anything unknown falls back to best-match', /: 'match';/.test(dc));
ok('country-first is reachable ONLY by asking for it',
  /const geoMode = sortKey === 'nearby' \? 'country-first' : 'match-first';/.test(dc));
ok('the data-driven geo.mode no longer decides the ORDER', !/orderSql\(geo\.mode/.test(dc.split('aiSearch')[0]));
// "Newest first" must not quietly become "nearest first" — the file's own comment demanded this
// and the code did the opposite.
ok('recent applies no geo ordering at all', /const applyGeo = geo\.active && sortKey !== 'recent';/.test(dc));
ok('the response echoes the sort actually used', /sort: useMatchSort \? sortKey : 'recent'/.test(dc));

console.log('── the search fields survive a restart ──');
const sl = fs.readFileSync(path.join(__dirname, '../../MobileApp/components/JobSearchLauncher.tsx'), 'utf8');
ok('last search is persisted', /job_search_last_v1/.test(sl));
ok('restored on mount, not on first open', /AsyncStorage\.getItem\(LAST_KEY\)/.test(sl));
ok('writes are debounced', /setTimeout\(\(\) => \{[\s\S]{0,120}AsyncStorage\.setItem\(LAST_KEY/.test(sl));
// ⚠️ Without this guard the empty initial render overwrites the saved search before it is read.
ok('the empty initial state cannot overwrite a saved search', /if \(!restoredOnce\.current\) return;/.test(sl));
// ⚠️ And the résumé prefill must never clobber what the user last typed.
ok('résumé prefill only fills fields still empty', /setRole\(\(cur\) => cur \|\| p\.role\)/.test(sl));

console.log(`\njob sort + search memory: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
