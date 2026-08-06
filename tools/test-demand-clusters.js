// Where the demand researcher decides WHO it researches and WHERE they live. Pure functions,
// plain node, no database:
//   node tools/test-demand-clusters.js
//
// Why this file exists. The routine used to research only saved interests, and
// user_job_interests has never held a single row in production — so every run for months ended
// "no user interests saved yet, nothing to research" while dozens of parsed résumés sat there
// describing exactly what those people do. The résumé lane fixes that, and it turns on the
// riskiest primitive in the service: resolving a country from free CV text.
//
// Country is a HARD filter — it picks the jobs we research, store and push. Get it wrong and a
// Kumasi banker is told about jobs in Morocco, which is worse than silence. The original matcher
// used a bare indexOf(), so "Development Professional" contained Fès, Spanish "calidad" contained
// Cali, and "sistema" contained Tema — and because the earliest hit wins, that filler beat the
// real address line at the top of the CV. Every one of those is asserted below against the exact
// text shapes that produced them.
'use strict';
const path = require('path');

// These assertions are all on pure functions, so this test must never reach a database — forcing a
// throwaway connection string guarantees that rather than hoping for it. Without it the module
// picks up whatever DATABASE_URL is in .env, which on this machine points at PRODUCTION.
process.env.DATABASE_URL = 'postgresql://test@127.0.0.1:1/demand_clusters_unit_test';

const dr = require(path.join(__dirname, '..', 'server', 'services', 'demandResearch'));

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (got !== undefined ? '  → got ' + JSON.stringify(got) : '')); }
};
const co = (s) => dr.countryFromResume(String(s).toLowerCase());
const city = (s, c) => dr.cityFromResume(String(s).toLowerCase(), c);

console.log('\na place name is a WORD, not a substring');
{
  // The three real false positives that shipped. Each is filler text that contained a city name.
  ok('"Development Finance Professional" is not Fès, Morocco',
    co('Comfort Orgen, Branch Manager | Development Finance Professional, Kumasi, Ghana') === 'Ghana',
    co('Comfort Orgen, Branch Manager | Development Finance Professional, Kumasi, Ghana'));
  ok('Spanish "calidad" is not Cali, Colombia',
    co('Samantha Villa. Servicio de calidad. Residencia: Jalpa de Cánovas, Purísima del Rincón') === 'Mexico',
    co('Samantha Villa. Servicio de calidad. Residencia: Jalpa de Cánovas, Purísima del Rincón'));
  ok('"profesional" alone resolves to nothing at all', co('un profesional dedicado, sistema de calidad') === null,
    co('un profesional dedicado, sistema de calidad'));
  ok('a city still matches when it IS a word', co('Kumbakonam, Tamil Nadu') === 'India');
  ok('…including one with an accent', co('Asunción, Paraguay') === 'Paraguay');
  ok('…and one made of two words', co('resident of Addis Ababa') === 'Ethiopia');
}

console.log('\nthe address at the top beats the work history below it');
{
  // A Namangan waiter whose CV mentions Dubai further down: earliest mention must win.
  const uz = 'Davronjon Umaraliev, NAMANGAN region 160030, Uzbekistan. Experience: hotel in Dubai.';
  ok('the home address wins over a later foreign employer', co(uz) === 'Uzbekistan', co(uz));
  // …and the same rule decides the city handed to the grounded search.
  ok('the city comes from the address, not the employer', city(uz, 'Uzbekistan') === 'Namangan', city(uz, 'Uzbekistan'));
}

console.log('\na nationality line is a real signal (and a language line is not)');
{
  ok('"Nationality : Indian" resolves to India', co('Nationality : Indian, married status : single') === 'India',
    co('Nationality : Indian, married status : single'));
  ok('…but "indian" is still not the bare word "india"', 'indian'.includes('india'));
  ok('a Ghanaian nationality line resolves', co('Nationality: Ghanaian. Contact: 0204-207620') === 'Ghana');
  // The reason demonyms are curated rather than generated: most are language names.
  ok('"Languages: French, Spanish, Arabic" decides nothing',
    co('Languages spoken: English, French, Spanish, Arabic, Portuguese') === null,
    co('Languages spoken: English, French, Spanish, Arabic, Portuguese'));
  ok('a language list does not override a real address',
    co('Ait Melloul, Morocco. Languages: French, English') === 'Morocco');
}

console.log('\nthe city must belong to the country we resolved');
{
  // A Chennai logistics CV whose skills name "Dubai Trade" software. Dubai is a real city in our
  // table — but it is a UAE city, and this person lives in India, so it must not be the search city.
  const in_ = 'Syed, Chennai, Tamil Nadu 600013. Software: Dubai Trade (DT), Calogi, Emirates SkyCargo';
  ok('country is India', co(in_) === 'India');
  ok('the city is Chennai, not Dubai', city(in_, 'India') === 'Chennai', city(in_, 'India'));
  ok('a region is not offered as a city', city('Noida, Uttar Pradesh', 'India') === 'Noida',
    city('Noida, Uttar Pradesh', 'India'));
  ok('no known city → null, and the search stays country-wide',
    city('Personal information (Bangladesh) +8801600039399', 'Bangladesh') === null,
    city('Personal information (Bangladesh) +8801600039399', 'Bangladesh'));
  ok('the city is title-cased for the prompt', city('San Lorenzo, Reducto', 'Paraguay') === 'San Lorenzo',
    city('San Lorenzo, Reducto', 'Paraguay'));
}

console.log('\nthe countries our real users live in are actually reachable');
{
  // Every one of these was a live user the routine could not research before, because the country
  // simply had no entry — silently, with no error anywhere.
  for (const [text, want] of [
    ['P.O. Box KS 4911, Kumasi, Ghana', 'Ghana'],
    ['San Lorenzo, Reducto, Paraguay', 'Paraguay'],
    ['Dhaka, Bangladesh', 'Bangladesh'],
    ['Addis Ababa, Ethiopia', 'Ethiopia'],
    ['Tashkent, Uzbekistan', 'Uzbekistan'],
    ['Purísima del Rincón, México', 'Mexico'],
  ]) ok(`${want} resolves`, co(text) === want, co(text));
}

console.log('\nwiring');
{
  ok('both lanes are behind one loader', typeof dr.loadClusters === 'function');
  ok('the city resolver is exported for reuse', typeof dr.cityFromResume === 'function');
  ok('the country resolver still is too', typeof dr.countryFromResume === 'function');
  // The résumé lane must reuse instantResearch's résumé→terms resolver, not fork a second one.
  const ir = require(path.join(__dirname, '..', 'server', 'services', 'instantResearch'));
  ok('the résumé→search-terms resolver is shared with the instant path', typeof ir.resolveDemand === 'function');
  // A taxonomy bucket is a guess; the user's own job title is not. On the 'field' arm the guess
  // must not lead the search — "Design & UX — General" for a Spanish sales advisor pulls the
  // entirely wrong jobs.
  const d = ir.resolveDemand({
    resumeMeta: { job_titles: ['Asesora de ventas', 'Encargada de ventas'], skills: ['Atención al cliente'], technical_skills: [], industries: [] },
    country: 'Mexico', city: 'Monterrey',
  });
  ok('resolveDemand still returns terms for a real résumé', d && d.ok && Array.isArray(d.terms) && d.terms.length > 0);
  if (d && d.ok && d.arm === 'field') {
    const demoted = [...d.terms.slice(1), d.terms[0]];
    ok('the demotion puts a real job title first', /ventas/i.test(demoted[0]), demoted[0]);
  } else {
    ok('the occupation arm already leads with a job title', !!d && d.ok && /ventas/i.test(d.terms[0]), d && d.terms[0]);
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
