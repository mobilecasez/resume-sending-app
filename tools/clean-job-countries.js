// Normalise global_jobs.country.
//
// The column is meant to be a short country label — the feed's facets and country filter read it.
// Earlier board lists stored a descriptive note in the source's `region` field instead, and the
// firehose copies region straight into country, so rows ended up labelled things like
// "London + global — cross-border payments fintech (96 EU roles". Those become their own bogus facet
// and can never match a country filter.
//
// Each bad label is replaced by the country implied by the JOB'S OWN location — never by re-parsing
// the note — and falls back to 'Global' when the location says nothing definite.
//
// Usage: PGURL=<db> node tools/clean-job-countries.js [--apply]     (dry-run without --apply)
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Client } = require(path.join(ROOT, 'node_modules', 'pg'));

if (!process.env.PGURL) { console.error('set PGURL'); process.exit(1); }
const APPLY = process.argv.includes('--apply');

// Same table the board verifier uses, kept deliberately simple: a label is "clean" if it is short and
// free of the punctuation that marks a hand-written note.
const CLEAN_LABEL = /^[A-Za-zÀ-ÿ .'-]{2,24}$/;

const COUNTRY_PATTERNS = [
  ['India', /\b(india|bangalore|bengaluru|mumbai|delhi|gurgaon|gurugram|noida|hyderabad|pune|chennai|kolkata|ahmedabad)\b/i],
  ['Singapore', /\bsingapore\b/i],
  ['Indonesia', /\b(indonesia|jakarta)\b/i], ['Malaysia', /\b(malaysia|kuala lumpur)\b/i],
  ['Philippines', /\b(philippines|manila|makati|cebu)\b/i], ['Thailand', /\b(thailand|bangkok)\b/i],
  ['Vietnam', /\b(vietnam|hanoi|ho chi minh)\b/i], ['Japan', /\b(japan|tokyo|osaka)\b/i],
  ['South Korea', /\b(south korea|seoul)\b/i], ['China', /\b(china|beijing|shanghai|shenzhen)\b/i],
  ['Hong Kong', /\bhong kong\b/i], ['Taiwan', /\b(taiwan|taipei)\b/i],
  ['Australia', /\b(australia|sydney|melbourne|brisbane|perth)\b/i],
  ['New Zealand', /\b(new zealand|auckland|wellington)\b/i],
  ['UAE', /\b(united arab emirates|dubai|abu dhabi)\b/i], ['Saudi Arabia', /\b(saudi|riyadh|jeddah)\b/i],
  ['Egypt', /\b(egypt|cairo)\b/i], ['Israel', /\b(israel|tel aviv)\b/i], ['Turkey', /\b(turkey|türkiye|istanbul)\b/i],
  ['Nigeria', /\b(nigeria|lagos)\b/i], ['Kenya', /\b(kenya|nairobi)\b/i],
  ['South Africa', /\b(south africa|johannesburg|cape town)\b/i],
  ['Brazil', /\b(brazil|brasil|s[ãa]o paulo|rio de janeiro)\b/i],
  ['Mexico', /\b(mexico|m[ée]xico|guadalajara|monterrey)\b/i],
  ['Argentina', /\b(argentina|buenos aires)\b/i], ['Colombia', /\b(colombia|bogot[áa]|medell[íi]n)\b/i],
  ['Chile', /\b(chile|santiago)\b/i], ['Uruguay', /\b(uruguay|montevideo)\b/i],
  ['Canada', /\b(canada|toronto|vancouver|montr[ée]al|ottawa|calgary)\b/i],
  ['UK', /\b(united kingdom|england|scotland|london|manchester|edinburgh|bristol|leeds|glasgow)\b/i],
  ['Ireland', /\b(ireland|dublin)\b/i],
  ['Germany', /\b(germany|deutschland|berlin|munich|m[üu]nchen|hamburg|frankfurt|cologne|stuttgart)\b/i],
  ['France', /\b(france|paris|lyon|marseille|toulouse|bordeaux)\b/i],
  ['Netherlands', /\b(netherlands|amsterdam|rotterdam|utrecht|eindhoven)\b/i],
  ['Spain', /\b(spain|espa[ñn]a|madrid|barcelona|valencia)\b/i],
  ['Italy', /\b(italy|italia|milan|milano|rome|roma)\b/i],
  ['Portugal', /\b(portugal|lisbon|lisboa|porto)\b/i],
  ['Switzerland', /\b(switzerland|zurich|z[üu]rich|geneva|gen[èe]ve|basel|bern|lausanne|zug)\b/i],
  ['Austria', /\b(austria|vienna|wien|graz)\b/i], ['Belgium', /\b(belgium|brussels|antwerp|ghent)\b/i],
  ['Sweden', /\b(sweden|sverige|stockholm|gothenburg|g[öo]teborg|malm[öo])\b/i],
  ['Norway', /\b(norway|oslo|bergen)\b/i], ['Denmark', /\b(denmark|copenhagen|k[øo]benhavn|aarhus)\b/i],
  ['Finland', /\b(finland|helsinki|espoo|tampere)\b/i],
  ['Poland', /\b(poland|warsaw|warszawa|krak[óo]w|wroc[łl]aw|gda[ńn]sk)\b/i],
  ['Czechia', /\b(czech|prague|praha|brno)\b/i], ['Romania', /\b(romania|bucharest|cluj)\b/i],
  ['Hungary', /\b(hungary|budapest)\b/i], ['Greece', /\b(greece|athens)\b/i],
  ['Estonia', /\b(estonia|tallinn)\b/i], ['Lithuania', /\b(lithuania|vilnius)\b/i],
  ['Latvia', /\b(latvia|riga)\b/i], ['Bulgaria', /\b(bulgaria|sofia)\b/i],
  ['Serbia', /\b(serbia|belgrade)\b/i], ['Ukraine', /\b(ukraine|kyiv|kiev|lviv)\b/i],
  ['US', /\b(united states|usa|new york|san francisco|seattle|austin|boston|chicago|los angeles|denver|atlanta|dallas|houston|miami|california|texas|virginia|colorado|massachusetts|illinois|florida|washington, dc)\b/i],
];
const countryOf = (loc) => {
  const s = String(loc || '');
  for (const [name, re] of COUNTRY_PATTERNS) if (re.test(s)) return name;
  return null;
};

(async () => {
  const c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const bad = await c.query(
    `SELECT DISTINCT country FROM global_jobs WHERE country IS NOT NULL AND country <> '' ORDER BY 1`);
  const dirty = bad.rows.map((r) => r.country).filter((v) => !CLEAN_LABEL.test(v));
  console.log(`${bad.rows.length} distinct country labels, ${dirty.length} malformed`);
  if (!dirty.length) { await c.end(); return; }
  for (const d of dirty.slice(0, 15)) console.log('   ' + JSON.stringify(d.slice(0, 70)));
  if (dirty.length > 15) console.log(`   … and ${dirty.length - 15} more`);

  const rows = await c.query(
    `SELECT id, location FROM global_jobs WHERE country = ANY($1::text[])`, [dirty]);
  console.log(`\n${rows.rows.length} rows to relabel`);

  const buckets = new Map();
  for (const r of rows.rows) {
    const target = countryOf(r.location) || 'Global';
    if (!buckets.has(target)) buckets.set(target, []);
    buckets.get(target).push(r.id);
  }
  for (const [target, ids] of [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(ids.length).padStart(6)} → ${target}`);
  }

  if (!APPLY) { console.log('\ndry run — pass --apply to write'); await c.end(); return; }
  let done = 0;
  for (const [target, ids] of buckets) {
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      // id is a uuid, not an int — casting to int[] fails outright ("operator does not exist").
      await c.query(`UPDATE global_jobs SET country = $1 WHERE id::text = ANY($2::text[])`, [target, chunk.map(String)]);
      done += chunk.length;
    }
  }
  console.log(`\nrelabelled ${done} rows`);
  await c.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
