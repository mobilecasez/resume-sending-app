// The country-then-distance comparator, asserted as a pure function:
//   node tools/test-geo-rank.js
//
// Why this file exists. "Jobs near me first" is a rule that looks obviously right and is quietly
// destructive when the corpus does not hold what the user does for a living — production has 899
// French jobs and 3 of them are Science & Research, so ranking country-first for a French chemist
// puts 896 irrelevant listings ahead of every job he could actually take. That failure is invisible
// in a demo and expensive in the store reviews, so every branch of the decision is nailed down here:
// the tiering, the guard that turns country-first OFF, the honest line that goes with it, the user
// with no city (which today is every user), and the rule that a remote role is not "far away".
'use strict';
const path = require('path');

// Pure functions only — this test must never reach a database. FORCING a dead connection string is
// how that is guaranteed rather than hoped for: without it the modules pick up the .env DATABASE_URL
// on this machine, which points at PRODUCTION.
process.env.DATABASE_URL = 'postgresql://test@127.0.0.1:1/geo_rank_unit_test';

const geo = require(path.join(__dirname, '..', 'server', 'utils', 'geoRank'));

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (got !== undefined ? '  → got ' + JSON.stringify(got) : '')); }
};

const T = geo.TIER;
const job = (title, location, country, match) => ({ title, location, country, match });
const titles = (list) => list.map((j) => j.title);

// A French anchor with a city, and the real one from production (country only, no city).
const paris = { country: 'France', countrySource: 'profile', city: 'Paris', citySource: 'profile', region: null };
const franceOnly = { country: 'France', countrySource: 'profile', city: null, citySource: null, region: null };

// ── 1. The tiers, on REAL location strings copied out of production ────────────────────────────
console.log('\ntiering real global_jobs.location strings (France anchor, city = Paris)');
{
  const t = (loc, country) => geo.tierOf(job('x', loc, country), paris);
  ok('"Paris" (bare city, country column France) → same city', t('Paris', 'France') === T.CITY, t('Paris', 'France'));
  ok('"Paris, Paris, France" → same city', t('Paris, Paris, France', 'France') === T.CITY);
  ok('"FR - Paris" → same city', t('FR - Paris', 'France') === T.CITY);
  ok('"Montpellier, France" → same country, not same city', t('Montpellier, France', 'France') === T.COUNTRY, t('Montpellier, France', 'France'));
  ok('"Stockholm, Sweden" → other country', t('Stockholm, Sweden', 'Sweden') === T.ELSEWHERE, t('Stockholm, Sweden', 'Sweden'));
  ok('"Paris, Texas" is NOT France (the country label decides, not the word)', t('Paris, Texas', 'US') === T.ELSEWHERE, t('Paris, Texas', 'US'));
}

console.log('\nremote and "anywhere" markers are not treated as far away');
{
  const t = (loc, country) => geo.tierOf(job('x', loc, country), paris);
  ok('"All France (remote)" → same country', t('All France (remote)', 'France') === T.COUNTRY, t('All France (remote)', 'France'));
  ok('"Anywhere in France" → same country', t('Anywhere in France', 'France') === T.COUNTRY, t('Anywhere in France', 'France'));
  ok('"Remote-France" → same country', t('Remote-France', 'France') === T.COUNTRY, t('Remote-France', 'France'));
  ok('an unpinned "Remote (worldwide)" beats another country…', t('Remote (worldwide)', 'Global') === T.OPEN_REMOTE, t('Remote (worldwide)', 'Global'));
  ok('…but still loses to anything actually in France', T.OPEN_REMOTE > T.COUNTRY);
  ok('"Remote — Berlin" is Germany, not open remote', t('Remote — Berlin', 'Germany') === T.ELSEWHERE, t('Remote — Berlin', 'Germany'));
  ok('an unpinned NON-remote row is just elsewhere', t('Bengaluru office', 'Global') === T.ELSEWHERE, t('Bengaluru office', 'Global'));
}

console.log('\nde-accenting and word boundaries');
{
  const zurich = { country: 'Switzerland', city: 'Zurich', region: null, countrySource: 'profile', citySource: 'profile' };
  ok('a "Zurich" anchor matches the stored "Zürich"', geo.tierOf(job('x', 'Zürich, Switzerland', 'Switzerland'), zurich) === T.CITY);
  const bern = { country: 'Switzerland', city: 'Bern', region: null, countrySource: 'profile', citySource: 'profile' };
  ok('"Bern" does not swallow "Berne-sur-Mer"-style substrings ("Bernex" ≠ Bern)',
    geo.tierOf(job('x', 'Bernex, Switzerland', 'Switzerland'), bern) === T.COUNTRY,
    geo.tierOf(job('x', 'Bernex, Switzerland', 'Switzerland'), bern));
}

// ── 2. Country-first: the thing the user asked for ────────────────────────────────────────────
console.log('\ncountry-first: my country first, nearest inside it, then everywhere else');
{
  const ctx = { mode: 'country-first', anchor: paris };
  const jobs = [
    job('sweden-95', 'Stockholm, Sweden', 'Sweden', 95),
    job('france-12', 'Montpellier, France', 'France', 12),
    job('paris-8', 'Paris, France', 'France', 8),
    job('us-80', 'Austin, Texas', 'US', 80),
    job('paris-60', 'Paris', 'France', 60),
    job('openremote-70', 'Remote (worldwide)', 'Global', 70),
  ];
  const got = titles(geo.rank(jobs, ctx));
  ok('same-country beats other-country even at a much lower match score',
    got.indexOf('france-12') < got.indexOf('sweden-95'), got);
  ok('nearer beats farther INSIDE the country (Paris 8% before Montpellier 12%)',
    got.indexOf('paris-8') < got.indexOf('france-12'), got);
  ok('inside the same city, the better match wins', got.indexOf('paris-60') < got.indexOf('paris-8'), got);
  ok('unpinned remote sits between home and other countries',
    got.indexOf('openremote-70') > got.indexOf('france-12') && got.indexOf('openremote-70') < got.indexOf('us-80'), got);
  ok('full order is city → country → open remote → elsewhere-by-match',
    JSON.stringify(got) === JSON.stringify(['paris-60', 'paris-8', 'france-12', 'openremote-70', 'sweden-95', 'us-80']), got);
}

// ── 3. A user with no city — which is EVERY live user today (0/186 have one) ──────────────────
console.log('\nno city on file (users.city is NULL for 186/186 live accounts)');
{
  const ctx = { mode: 'country-first', anchor: franceOnly };
  const jobs = [
    job('sweden-95', 'Stockholm, Sweden', 'Sweden', 95),
    job('paris-8', 'Paris, France', 'France', 8),
    job('france-40', 'Montpellier, France', 'France', 40),
  ];
  const got = titles(geo.rank(jobs, ctx));
  ok('country still wins', got[0] !== 'sweden-95' && got[2] === 'sweden-95', got);
  ok('with no city we do NOT pretend Paris is nearer — inside France it is match order',
    JSON.stringify(got) === JSON.stringify(['france-40', 'paris-8', 'sweden-95']), got);
  ok('every French job lands on the same tier',
    geo.tierOf(jobs[1], franceOnly) === geo.tierOf(jobs[2], franceOnly), [geo.tierOf(jobs[1], franceOnly), geo.tierOf(jobs[2], franceOnly)]);
}

// ── 4. No anchor at all → the geo term must be a no-op, never a guess ──────────────────────────
console.log('\nno country on file → ranking is untouched');
{
  const ctx = { mode: 'match-first', anchor: null };
  const jobs = [job('a-10', 'Paris, France', 'France', 10), job('b-90', 'Stockholm', 'Sweden', 90)];
  ok('best match still first', titles(geo.rank(jobs, ctx))[0] === 'b-90');
  ok('every job is UNKNOWN tier', geo.tierOf(jobs[0], null) === T.UNKNOWN && geo.tierOf(jobs[1], null) === T.UNKNOWN);
  ok('the SQL tier is a parenthesised constant, never a bare ORDER BY ordinal',
    geo.tierSql(null, () => '$1') === '(5)::int', geo.tierSql(null, () => '$1'));
}

// ── 5. The guard: user 192's real situation ────────────────────────────────────────────────────
console.log('\nthe empty-field guard (user 192: Trainee Chemist, France, 3 Science & Research jobs there)');
{
  const d = geo.decideMode({ anchor: franceOnly, field: 'Science & Research', fieldJobsInCountry: 3, minFieldJobs: 5 });
  ok('3 < 5 → falls back to match-first', d.mode === 'match-first', d);
  ok('and SAYS so, in one line the UI can show', /Science & Research/.test(d.notice || '') && /France/.test(d.notice || ''), d.notice);
  ok('the line offers the alternative honestly', /closest matches elsewhere/.test(d.notice || ''), d.notice);

  const none = geo.decideMode({ anchor: franceOnly, field: 'Science & Research', fieldJobsInCountry: 0, minFieldJobs: 5 });
  ok('zero reads as "No … yet", not "Only 0"', /^No Science & Research roles in France yet/.test(none.notice || ''), none.notice);

  const rich = geo.decideMode({ anchor: franceOnly, field: 'IT & Software', fieldJobsInCountry: 231, minFieldJobs: 5 });
  ok('231 IT jobs in France → country-first turns ON', rich.mode === 'country-first', rich);
  ok('…with nothing to apologise for', rich.notice === null, rich);

  const unknown = geo.decideMode({ anchor: franceOnly, field: 'IT & Software', fieldJobsInCountry: null, minFieldJobs: 5 });
  ok('an uncountable field keeps TODAY\'s order rather than guessing', unknown.mode === 'match-first' && unknown.notice === null, unknown);

  const noField = geo.decideMode({ anchor: franceOnly, field: null, fieldJobsInCountry: null, minFieldJobs: 5 });
  ok('no résumé field at all → country-first is safe (nothing to bury)', noField.mode === 'country-first', noField);

  const noCountry = geo.decideMode({ anchor: { country: null }, field: 'IT & Software', fieldJobsInCountry: 999 });
  ok('no country → match-first and no claim about location', noCountry.mode === 'match-first' && noCountry.notice === null, noCountry);
}

// ── 6. What the fallback actually does to the order ────────────────────────────────────────────
console.log('\nmatch-first fallback: field first ACROSS countries, geography only as a tie-break');
{
  const ctx = { mode: 'match-first', anchor: franceOnly };
  const jobs = [
    job('sweden-chem-70', 'Göteborg, Sweden', 'Sweden', 70),
    job('paris-sales-30', 'Paris, France', 'France', 30),
    job('us-chem-72', 'Newark, New Jersey', 'US', 72),
    job('france-chem-71', 'Lyon, France', 'France', 71),
  ];
  const got = titles(geo.rank(jobs, ctx));
  ok('the 70-72% chemistry roles all beat the 30% local one',
    got.indexOf('paris-sales-30') === 3, got);
  ok('inside the 70s band the FRENCH one comes first — "closest matches" is literally true',
    got.indexOf('france-chem-71') === 0, got);
  ok('band, then distance, then exact score', JSON.stringify(got) === JSON.stringify(['france-chem-71', 'us-chem-72', 'sweden-chem-70', 'paris-sales-30']), got);
  ok('a 10-point band boundary is a band boundary (69 vs 70)', geo.band(69) !== geo.band(70));
  ok('a null match sorts last, never as 0%', geo.band(null) < geo.band(0));
}

// ── 7. The anchor: only what the user actually told us ─────────────────────────────────────────
console.log('\nbuilding the anchor from a real users row');
{
  // user 192, verbatim from production.
  const a192 = geo.buildAnchor({
    user: { id: 192, city: null, country: 'France', address: 'Kumbakonam ' },
    resumeMeta: { raw_text: 'V. VIGNESH VEERAMANI\nTrainee Chemist | Chemical Process Operations\n+91 9715083073 | Kumbakonam, Tamil Nadu' },
  });
  ok('country comes from the profile', a192.country === 'France' && a192.countrySource === 'profile', a192);
  ok('⚠️ the Indian address does NOT become a French city anchor', a192.city === null, a192);
  ok('…and the rejection is reported, not swallowed', !!a192.cityRejected && /Kumbakonam/.test(a192.cityRejected.value), a192.cityRejected);

  const consistent = geo.buildAnchor({ user: { country: 'Netherlands', city: null, address: 'Keizersgracht 1, Amsterdam, Netherlands' } });
  ok('an address that DOES name the profile country may give a city', consistent.city === 'Amsterdam' && consistent.citySource === 'address', consistent);

  const explicit = geo.buildAnchor({ user: { country: 'France', city: 'Lyon' } });
  ok('an explicit city is taken at face value', explicit.city === 'Lyon' && explicit.citySource === 'profile', explicit);

  const withRegion = geo.buildAnchor({ user: { country: 'France', city: 'Nanterre, Île-de-France' } });
  ok('a "city, region" profile value fills both tiers', withRegion.city === 'Nanterre' && withRegion.region === 'Île-de-France', withRegion);

  const fromAddress = geo.buildAnchor({ user: { country: null, address: '12 Rue de Rivoli, Paris, France' } });
  ok('no profile country → the address may supply one', fromAddress.country === 'France' && fromAddress.countrySource === 'address', fromAddress);

  const fromResume = geo.buildAnchor({ user: {}, resumeMeta: { raw_text: 'Ana Silva\nLisbon, Portugal\nSUMMARY …' } });
  ok('…then the résumé header', fromResume.country === 'Portugal' && fromResume.countrySource === 'resume-header', fromResume);

  const phoneOnly = geo.buildAnchor({ user: { phone_number: '+91 9715083073' } });
  ok('⚠️ a dial code is NOT an address — no anchor from a phone number', phoneOnly.country === null, phoneOnly);

  const nothing = geo.buildAnchor({ user: {} });
  ok('nothing on file → no anchor, no guess', nothing.country === null && nothing.city === null, nothing);
}

// ── 8. Country labels: users type them one way, the corpus stores another ──────────────────────
console.log('\ncountry labels line up between users.country and global_jobs.country');
{
  ok('"United States" and "US" are the same country', geo.canonCountry('United States') === 'US' && geo.canonCountry('us') === 'US');
  ok('"Deutschland" is Germany', geo.canonCountry('Deutschland') === 'Germany');
  ok('an address resolves to its country', geo.canonCountry('12 Rue de Rivoli, Paris') === 'France');
  ok('"Global" is not a country', geo.canonCountry('Global') === null);
  ok('"EU" is not a country', geo.canonCountry('EU') === null);
  ok('the label list a US anchor matches includes what the corpus stores', geo.countryLabels('US').includes('us'));
  const usAnchor = { country: 'US', city: null, region: null };
  ok('a US anchor matches a row stored as "US"', geo.tierOf(job('x', 'Austin, Texas', 'US'), usAnchor) === T.COUNTRY);
}

// ── 9. The SQL side is the SAME rules (shape only — equality with JS is re-checked on prod rows
//       by tools/geo-rank-prod-check.js) ───────────────────────────────────────────────────────
console.log('\nthe generated SQL binds every value and mirrors the JS branches');
{
  const params = [];
  const P = (v) => { params.push(v); return '$' + params.length; };
  const sql = geo.tierSql(paris, P, { countryCol: 'country', locationCol: 'location' });
  ok('the CASE covers city/country/open-remote explicitly and elsewhere as the ELSE',
    ['THEN 0', 'THEN 2', 'THEN 3', 'ELSE 4'].every((s) => sql.includes(s)), sql);
  ok('no anchor value is inlined into the SQL text', !/paris/i.test(sql), sql);
  ok('the city is a bound parameter', params.some((p) => String(p).includes('paris')), params);
  ok('the word boundary is Postgres\'s \\y, not JavaScript\'s \\b', params.some((p) => String(p).startsWith('\\y')), params);
  ok('the country regex is bound too', params.some((p) => String(p).includes('france')), params);
  ok('country-first ORDER BY is tier then match', geo.orderSql('country-first') === 'geo_tier ASC, match DESC NULLS LAST', geo.orderSql('country-first'));
  ok('match-first ORDER BY bands the match BEFORE the tier', /^floor\(coalesce\(match, -10\)::numeric \/ 10\) DESC, geo_tier ASC/.test(geo.orderSql('match-first')), geo.orderSql('match-first'));
  const noCity = [];
  geo.tierSql(franceOnly, (v) => { noCity.push(v); return '$' + noCity.length; }, { countryCol: 'country' });
  ok('with no city the CASE has no city branch at all', !geo.tierSql(franceOnly, (v) => '$1', {}).includes('THEN 0'), geo.tierSql(franceOnly, (v) => '$1', {}));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
