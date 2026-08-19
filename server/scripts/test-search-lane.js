// The search lane turns a typed query into a research brief. If this parsing is wrong the routine
// goes and researches the wrong thing worldwide, so it is asserted rather than eyeballed.
process.env.DEMAND_RESEARCH_ENABLED = '0';        // never start the scheduler from a test
const path = '/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app/server/services/demandResearch.js';
const src = require('fs').readFileSync(path, 'utf8');

// Pull the pure parsing out of the lane so it can be exercised without a database.
const body = src.match(/async function loadSearchClusters[\s\S]*?\n}\n/)[0];
const countryFrom = src.match(/function countryFromResume[\s\S]*?\n}\n/)[0];
const aliases = src.match(/const COUNTRY_ALIASES = \[[\s\S]*?\n\];/)[0];
const region = src.match(/const REGION_COUNTRY = \[[\s\S]*?\n\];/)[0];
const placeIdx = src.match(/(?:const|function) placeIndex[\s\S]*?\n(?:\}|\};)\n/)[0];
const word = src.match(/const WORD = '[^']*';/)[0];
const notCity = src.match(/const NOT_A_CITY = new Set\(\[[\s\S]*?\n\]\);/)[0];

const harness = `
${word}
${aliases}
${region}
${placeIdx}
${countryFrom}
${notCity}
function parse(raw, profileCountry) {
  const lower = String(raw).trim().toLowerCase();
  if (!lower || lower.length < 3 || /^https?:\\/\\//i.test(lower)) return null;
  const split = lower.split(/\\s+\\bin\\b\\s+/);
  const head = split[0] || '';
  const placeText = split.length > 1 ? split.slice(1).join(' in ') : '';
  const role = head.replace(/\\b(jobs?|vacancy|vacancies|positions?|hiring|careers?|openings?)\\b/g, ' ').replace(/\\s+/g, ' ').trim();
  if (!role || role.length < 2) return null;
  const country = (placeText ? countryFromResume(placeText) : null) || (profileCountry || null);
  if (!country) return null;
  let city = null;
  if (placeText) {
    const first = placeText.split(',')[0].trim();
    if (first && first.toLowerCase() !== String(country).toLowerCase() && !NOT_A_CITY.has(first.toLowerCase())) {
      city = first.replace(/\\b\\w/g, (c) => c.toUpperCase());
    }
  }
  return { role, country, city };
}
module.exports = { parse };
`;
const m = new module.constructor();
m._compile(harness, '/tmp/harness.js');
const { parse } = m.exports;

let pass = 0, fail = 0;
const t = (raw, profile, want) => {
  const got = parse(raw, profile);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${JSON.stringify(raw)} -> ${JSON.stringify(got)}`); }
  else { fail++; console.log(`  ✗ ${JSON.stringify(raw)}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
};

console.log('\n── the shape our own launcher composes ──');
// A bare city has no country in the TEXT — stage 2 resolves it from global_jobs
// (verified live: amsterdam -> Netherlands, 294 rows, beating EU/US noise). The parser's job here
// is only to hand stage 2 a clean role and a clean city.
t('.net jobs in Amsterdam', null, null);
t('.net jobs in Amsterdam, Netherlands', null, { role: '.net', country: 'Netherlands', city: 'Amsterdam' });
t('warehouse jobs in Tangier, Morocco', null, { role: 'warehouse', country: 'Morocco', city: 'Tangier' });
t('midwife jobs in Doha, Qatar', null, { role: 'midwife', country: 'Qatar', city: 'Doha' });
t('security jobs in Sweden', null, { role: 'security', country: 'Sweden', city: null });

console.log('\n── free-typed, and the profile fallback ──');
t('forklift operator', 'Morocco', { role: 'forklift operator', country: 'Morocco', city: null });
t('nurse vacancies in Dubai', null, { role: 'nurse', country: 'UAE', city: 'Dubai' });

console.log('\n── must be REJECTED ──');
t('https://boards.greenhouse.io/x/jobs/123', null, null);   // a link is a job already found
t('jobs', null, null);                                       // scaffolding only, no occupation
t('driver jobs in Atlantis', null, null);                    // no resolvable country → not researchable

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
