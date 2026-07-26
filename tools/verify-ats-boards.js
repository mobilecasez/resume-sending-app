// Guess-and-verify public ATS boards, so `server/data/global_job_sources.json` only ever grows with
// boards that are PROVEN to return jobs right now.
//
// Most companies' ATS slug is just their name lowercased with the punctuation removed, so a candidate
// name is probed against each keyless public API in turn and kept only when the API answers with real
// postings. A wrong guess costs one 404 and is dropped — nothing unverified reaches the sources file.
//
// Only keyless, public, documented board APIs are probed here. No search engines, no protected
// platforms, no bot-detection workarounds: every job we ingest links back to the employer's own board.
//
// Usage:
//   node tools/verify-ats-boards.js --in tools/data/ats_candidates.json --out /tmp/verified.json
//   node tools/verify-ats-boards.js --in ... --out ... --merge      # also write the sources file
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCES_FILE = path.join(ROOT, 'server', 'data', 'global_job_sources.json');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);

const CONCURRENCY = parseInt(arg('--concurrency', '14'), 10);
const TIMEOUT_MS = parseInt(arg('--timeout', '12000'), 10);
const MIN_JOBS = parseInt(arg('--min-jobs', '1'), 10);

const UA = 'CVApplyr/1.0 (+https://cvapplyr.com) job-board-verifier';

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}
async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) return null;
  return r.text().catch(() => null);
}

// Each probe returns {count, locations[]} or null. `board` is the URL stored in the sources file — it
// must be a shape atsDiscovery.detectAndFetchAts() recognises, or the firehose cannot read it back.
const LOC_CAP = 30;   // locations sampled per board, enough to tell where the company actually hires
const PLATFORMS = [
  {
    name: 'greenhouse',
    board: (s) => `https://boards.greenhouse.io/${s}`,
    probe: async (s) => {
      const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`);
      const jobs = d && Array.isArray(d.jobs) ? d.jobs : null;
      return jobs && jobs.length ? { count: jobs.length, locations: jobs.slice(0, LOC_CAP).map((j) => j.location && j.location.name) } : null;
    },
  },
  {
    name: 'lever',
    board: (s) => `https://jobs.lever.co/${s}`,
    probe: async (s) => {
      const d = await getJson(`https://api.lever.co/v0/postings/${s}?mode=json`);
      return Array.isArray(d) && d.length ? { count: d.length, locations: d.slice(0, LOC_CAP).map((j) => j.categories && j.categories.location) } : null;
    },
  },
  {
    name: 'ashby',
    board: (s) => `https://jobs.ashbyhq.com/${s}`,
    probe: async (s) => {
      const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${s}`);
      const jobs = d && Array.isArray(d.jobs) ? d.jobs : null;
      return jobs && jobs.length ? { count: jobs.length, locations: jobs.slice(0, LOC_CAP).map((j) => j.location) } : null;
    },
  },
  {
    name: 'workable',
    board: (s) => `https://apply.workable.com/${s}`,
    probe: async (s) => {
      const d = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`);
      const jobs = d && Array.isArray(d.jobs) ? d.jobs : null;
      return jobs && jobs.length ? { count: jobs.length, locations: jobs.slice(0, LOC_CAP).map((j) => [j.city, j.country].filter(Boolean).join(', ')) } : null;
    },
  },
  {
    name: 'smartrecruiters',
    board: (s) => `https://careers.smartrecruiters.com/${s}`,
    probe: async (s) => {
      const d = await getJson(`https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=${LOC_CAP}`);
      const posts = d && Array.isArray(d.content) ? d.content : null;
      if (!posts || !posts.length) return null;
      return {
        count: d.totalFound || posts.length,
        locations: posts.map((p) => { const l = p.location || {}; return [l.city, l.country].filter(Boolean).join(', '); }),
      };
    },
  },
  {
    name: 'recruitee',
    board: (s) => `https://${s}.recruitee.com`,
    probe: async (s) => {
      const d = await getJson(`https://${s}.recruitee.com/api/offers/`);
      const offers = d && Array.isArray(d.offers) ? d.offers : null;
      return offers && offers.length ? { count: offers.length, locations: offers.slice(0, LOC_CAP).map((o) => [o.city, o.country].filter(Boolean).join(', ')) } : null;
    },
  },
  {
    name: 'bamboohr',
    board: (s) => `https://${s}.bamboohr.com/careers`,
    probe: async (s) => {
      const d = await getJson(`https://${s}.bamboohr.com/careers/list`);
      const list = d && Array.isArray(d.result) ? d.result : null;
      if (!list || !list.length) return null;
      return {
        count: list.length,
        locations: list.slice(0, LOC_CAP).map((j) => { const l = j.atsLocation || j.location || {}; return [l.city, l.state, l.addressCountry || l.country].filter(Boolean).join(', '); }),
      };
    },
  },
  {
    name: 'teamtailor',
    board: (s) => `https://${s}.teamtailor.com`,
    probe: async (s) => {
      const d = await getJson(`https://${s}.teamtailor.com/jobs.json`);
      const items = d && Array.isArray(d.items) ? d.items : null;
      if (!items || !items.length) return null;
      return { count: items.length, locations: items.slice(0, LOC_CAP).map((i) => (i._jobposting && i._jobposting.jobLocation && i._jobposting.jobLocation.address && i._jobposting.jobLocation.address.addressLocality) || null) };
    },
  },
  {
    name: 'personio',
    board: (s) => `https://${s}.jobs.personio.de`,
    probe: async (s) => {
      const t = await getText(`https://${s}.jobs.personio.de/xml`);
      if (!t || !/<position>/i.test(t)) return null;
      const count = (t.match(/<position>/gi) || []).length;
      const offices = [...t.matchAll(/<office>([^<]*)<\/office>/gi)].slice(0, LOC_CAP).map((m) => m[1]);
      return count ? { count, locations: offices } : null;
    },
  },
  {
    name: 'pinpoint',
    board: (s) => `https://${s}.pinpointhq.com`,
    probe: async (s) => {
      const d = await getJson(`https://${s}.pinpointhq.com/postings.json`);
      const list = d && Array.isArray(d.data) ? d.data : null;
      if (!list || !list.length) return null;
      return { count: list.length, locations: list.slice(0, LOC_CAP).map((p) => (p.location && (p.location.name || p.location)) || null) };
    },
  },
  {
    name: 'rippling',
    board: (s) => `https://ats.rippling.com/${s}/jobs`,
    probe: async (s) => {
      const d = await getJson(`https://ats.rippling.com/api/v2/board/${s}/jobs?page=0&pageSize=${LOC_CAP}&groupJobsByLocation=false`);
      const items = d && Array.isArray(d.items) ? d.items : null;
      if (!items || !items.length) return null;
      return { count: items.length, locations: items.map((i) => { const l = (i.locations && i.locations[0]) || {}; return [l.city, l.country].filter(Boolean).join(', ') || l.name || null; }) };
    },
  },
  {
    name: 'jobscore',
    board: (s) => `https://careers.jobscore.com/careers/${s}`,
    probe: async (s) => {
      const d = await getJson(`https://careers.jobscore.com/careers/${s}/feed`);
      const jobs = d && Array.isArray(d.jobs) ? d.jobs : null;
      return jobs && jobs.length ? { count: jobs.length, locations: jobs.slice(0, LOC_CAP).map((j) => j.location || [j.city, j.state, j.country].filter(Boolean).join(', ')) } : null;
    },
  },
  {
    name: 'breezy',
    board: (s) => `https://${s}.breezy.hr`,
    probe: async (s) => {
      const d = await getJson(`https://${s}.breezy.hr/json`);
      return Array.isArray(d) && d.length ? { count: d.length, locations: d.slice(0, LOC_CAP).map((j) => j.location && (j.location.name || [j.location.city, j.location.country].filter(Boolean).join(', '))) } : null;
    },
  },
];

// ── Where does this board actually hire? ───────────────────────────────────────────────────────────
// ⚠️ The region label becomes each job's `country`, which the feed's facets and filters read. A guess
// from the company NAME is not good enough: slugs collide (probing "Tiki" for the Vietnamese retailer
// returns a German company's Personio board), and a wrong label quietly mislabels every job on it.
// So the label is derived from the locations the board itself reports, and falls back to "Global".
const COUNTRY_PATTERNS = [
  ['India', /\b(india|bangalore|bengaluru|mumbai|delhi|gurgaon|gurugram|noida|hyderabad|pune|chennai|kolkata|ahmedabad|jaipur|indore|kochi|coimbatore|trivandrum|thiruvananthapuram|mysore|mysuru|chandigarh|nagpur)\b/i],
  ['Singapore', /\bsingapore\b|,\s*sg$/i],
  ['Indonesia', /\b(indonesia|jakarta|bandung|surabaya|bali|denpasar)\b|,\s*id$/i],
  ['Malaysia', /\b(malaysia|kuala lumpur|penang|cyberjaya|johor)\b|,\s*my$/i],
  ['Philippines', /\b(philippines|manila|makati|cebu|taguig|quezon city)\b|,\s*ph$/i],
  ['Thailand', /\b(thailand|bangkok|chiang mai|phuket)\b|,\s*th$/i],
  ['Vietnam', /\b(vietnam|viet nam|hanoi|ho chi minh|saigon|da nang)\b|,\s*vn$/i],
  ['Japan', /\b(japan|tokyo|osaka|kyoto|yokohama|fukuoka|nagoya)\b|,\s*jp$/i],
  ['South Korea', /\b(korea|seoul|busan|pangyo|incheon)\b|,\s*kr$/i],
  ['China', /\b(china|beijing|shanghai|shenzhen|guangzhou|hangzhou|chengdu)\b|,\s*cn$/i],
  ['Hong Kong', /\bhong kong\b|,\s*hk$/i],
  ['Taiwan', /\b(taiwan|taipei)\b|,\s*tw$/i],
  ['Australia', /\b(australia|sydney|melbourne|brisbane|perth|canberra|adelaide|nsw|victoria, au)\b|,\s*au$/i],
  ['New Zealand', /\b(new zealand|auckland|wellington|christchurch|canterbury)\b|,\s*nz$/i],
  ['UAE', /\b(united arab emirates|uae|dubai|abu dhabi|sharjah)\b|,\s*ae$/i],
  ['Saudi Arabia', /\b(saudi|riyadh|jeddah|dammam|khobar)\b|,\s*sa$/i],
  ['Egypt', /\b(egypt|cairo|giza|alexandria)\b|,\s*eg$/i],
  ['Israel', /\b(israel|tel aviv|herzliya|haifa|jerusalem)\b|,\s*il$/i],
  ['Turkey', /\b(turkey|türkiye|istanbul|ankara|izmir)\b|,\s*tr$/i],
  ['Nigeria', /\b(nigeria|lagos|abuja)\b|,\s*ng$/i],
  ['Kenya', /\b(kenya|nairobi)\b|,\s*ke$/i],
  ['South Africa', /\b(south africa|johannesburg|cape town|durban|pretoria)\b|,\s*za$/i],
  ['Brazil', /\b(brazil|brasil|s[ãa]o paulo|rio de janeiro|belo horizonte|curitiba|porto alegre|florian[óo]polis|recife)\b|,\s*br$/i],
  ['Mexico', /\b(mexico|m[ée]xico|guadalajara|monterrey|cdmx|queretaro|quer[ée]taro)\b|,\s*mx$/i],
  ['Argentina', /\b(argentina|buenos aires|c[óo]rdoba|rosario)\b|,\s*ar$/i],
  ['Colombia', /\b(colombia|bogot[áa]|medell[íi]n|cali|barranquilla)\b|,\s*co$/i],
  ['Chile', /\b(chile|santiago)\b|,\s*cl$/i],
  ['Peru', /\b(peru|per[úu]|lima)\b|,\s*pe$/i],
  ['Uruguay', /\b(uruguay|montevideo)\b|,\s*uy$/i],
  ['Canada', /\b(canada|toronto|vancouver|montreal|montr[ée]al|ottawa|calgary|waterloo|ontario|quebec|british columbia)\b|,\s*ca$/i],
  ['UK', /\b(united kingdom|england|scotland|wales|london|manchester|edinburgh|cambridge, uk|bristol|leeds|glasgow|birmingham, uk|belfast)\b|,\s*(uk|gb)$/i],
  ['Ireland', /\b(ireland|dublin|cork, ie|galway)\b|,\s*ie$/i],
  ['Germany', /\b(germany|deutschland|berlin|munich|m[üu]nchen|hamburg|frankfurt|cologne|k[öo]ln|stuttgart|d[üu]sseldorf|leipzig|karlsruhe)\b|,\s*de$/i],
  ['France', /\b(france|paris|lyon|marseille|toulouse|bordeaux|lille|nantes|sophia antipolis)\b|,\s*fr$/i],
  ['Netherlands', /\b(netherlands|amsterdam|rotterdam|utrecht|eindhoven|the hague|den haag|delft)\b|,\s*nl$/i],
  ['Spain', /\b(spain|espa[ñn]a|madrid|barcelona|valencia|sevilla|malaga|m[áa]laga|bilbao)\b|,\s*es$/i],
  ['Italy', /\b(italy|italia|milan|milano|rome|roma|turin|torino|bologna)\b|,\s*it$/i],
  ['Portugal', /\b(portugal|lisbon|lisboa|porto|braga)\b|,\s*pt$/i],
  ['Switzerland', /\b(switzerland|schweiz|suisse|zurich|z[üu]rich|geneva|gen[èe]ve|basel|bern|lausanne|zug|lugano)\b|,\s*ch$/i],
  ['Austria', /\b(austria|[öo]sterreich|vienna|wien|graz|linz|salzburg)\b|,\s*at$/i],
  ['Belgium', /\b(belgium|brussels|bruxelles|antwerp|ghent|leuven)\b|,\s*be$/i],
  ['Sweden', /\b(sweden|sverige|stockholm|gothenburg|g[öo]teborg|malm[öo]|lund|uppsala)\b|,\s*se$/i],
  ['Norway', /\b(norway|norge|oslo|bergen|trondheim)\b|,\s*no$/i],
  ['Denmark', /\b(denmark|danmark|copenhagen|k[øo]benhavn|aarhus|odense)\b|,\s*dk$/i],
  ['Finland', /\b(finland|suomi|helsinki|espoo|tampere|oulu)\b|,\s*fi$/i],
  ['Poland', /\b(poland|polska|warsaw|warszawa|krak[óo]w|krakow|wroc[łl]aw|gda[ńn]sk|pozna[ńn])\b|,\s*pl$/i],
  ['Czechia', /\b(czech|czechia|prague|praha|brno)\b|,\s*cz$/i],
  ['Romania', /\b(romania|bucharest|bucure[șs]ti|cluj|ia[șs]i|timi[șs]oara)\b|,\s*ro$/i],
  ['Hungary', /\b(hungary|budapest)\b|,\s*hu$/i],
  ['Greece', /\b(greece|athens|thessaloniki)\b|,\s*gr$/i],
  ['Estonia', /\b(estonia|tallinn|tartu)\b|,\s*ee$/i],
  ['Lithuania', /\b(lithuania|vilnius|kaunas)\b|,\s*lt$/i],
  ['Latvia', /\b(latvia|riga)\b|,\s*lv$/i],
  ['Bulgaria', /\b(bulgaria|sofia|plovdiv)\b|,\s*bg$/i],
  ['Serbia', /\b(serbia|belgrade|novi sad)\b|,\s*rs$/i],
  ['Ukraine', /\b(ukraine|kyiv|kiev|lviv)\b|,\s*ua$/i],
  ['US', /\b(united states|usa|u\.s\.|new york|san francisco|seattle|austin|boston|chicago|los angeles|denver|atlanta|dallas|houston|miami|phoenix|portland, or|san diego|san jose|washington, dc|remote - us|california|texas|new jersey|virginia|colorado|massachusetts|illinois|florida|georgia, united|north carolina|pennsylvania|ohio|michigan|minnesota|utah|arizona|oregon|nevada|tennessee|missouri|wisconsin|maryland)\b|,\s*us$/i],
];
function countryOf(loc) {
  const s = String(loc || '').trim();
  if (!s || /^(remote|anywhere|global|worldwide|multiple locations|various)$/i.test(s)) return null;
  for (const [name, re] of COUNTRY_PATTERNS) if (re.test(s)) return name;
  return null;
}
// Modal country, but only when it is a clear majority — a genuinely spread-out board stays "Global".
function regionFromLocations(locations) {
  const counts = {};
  let mapped = 0;
  for (const l of locations || []) { const c = countryOf(l); if (c) { counts[c] = (counts[c] || 0) + 1; mapped++; } }
  if (mapped < 2) return null;
  const [top, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n / mapped >= 0.5 ? top : 'Global';
}

// Slug variants worth trying for one company name, most likely first.
function slugsFor(name) {
  const base = String(name).trim().toLowerCase();
  const compact = base.replace(/[^a-z0-9]/g, '');
  const hyphen = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const noSuffix = compact.replace(/(inc|ltd|limited|llc|gmbh|bv|ab|as|sa|plc|corp|technologies|technology|labs|group)$/i, '');
  return [...new Set([compact, hyphen, noSuffix].filter((s) => s && s.length >= 2 && s.length <= 40))];
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// One candidate: try each slug against each platform, stop at the first board that really has jobs.
// The expected region is kept only as a cross-check — the label written out comes from the board.
async function verifyCandidate(cand) {
  const name = typeof cand === 'string' ? cand : cand.name;
  const expected = (typeof cand === 'object' && cand.region) || null;
  for (const slug of slugsFor(name)) {
    for (const p of PLATFORMS) {
      let hit = null;
      try { hit = await p.probe(slug); } catch { hit = null; }
      if (hit && hit.count >= MIN_JOBS) {
        const observed = regionFromLocations(hit.locations);
        return {
          name, slug, ats: p.name, url: p.board(slug), jobs: hit.count,
          region: observed || expected || 'Global',
          expectedRegion: expected,
          // Flags a slug collision: the board is real, but it is not the company I was looking for.
          regionMismatch: !!(observed && expected && observed !== expected && observed !== 'Global'),
          sampleLocation: (hit.locations || []).find(Boolean) || null,
        };
      }
    }
  }
  return null;
}

const norm = (u) => String(u).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');

(async () => {
  const inFile = arg('--in');
  const outFile = arg('--out', '/tmp/verified-boards.json');
  if (!inFile) { console.error('need --in <candidates.json>'); process.exit(1); }
  const candidates = JSON.parse(fs.readFileSync(inFile, 'utf8'));

  const existing = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
  const existingSlugs = new Set(existing.map((e) => norm(e.url)));
  // Skip candidates whose obvious board URL is already in the file — no point re-probing 687 boards.
  const todo = candidates.filter((c) => {
    const n = typeof c === 'string' ? c : c.name;
    return !slugsFor(n).some((s) => PLATFORMS.some((p) => existingSlugs.has(norm(p.board(s)))));
  });

  console.log(`${candidates.length} candidates, ${candidates.length - todo.length} already known → probing ${todo.length}`);
  const t0 = Date.now();
  let done = 0;
  const found = [];
  const results = await mapLimit(todo, CONCURRENCY, async (c) => {
    const r = await verifyCandidate(c);
    done++;
    if (r) { found.push(r); console.log(`  ✓ ${r.name} → ${r.ats}/${r.slug}  ${r.jobs} jobs  [${r.region}]${r.regionMismatch ? ` ⚠ expected ${r.expectedRegion}` : ''}`); }
    if (done % 100 === 0) console.log(`  … ${done}/${todo.length} probed, ${found.length} live boards, ${Math.round((Date.now() - t0) / 1000)}s`);
    return r;
  });

  const hits = results.filter(Boolean);
  // Two candidates can resolve to the same board (e.g. a rename) — keep one.
  const byUrl = new Map();
  for (const h of hits) if (!byUrl.has(norm(h.url))) byUrl.set(norm(h.url), h);
  const uniq = [...byUrl.values()];
  const totalJobs = uniq.reduce((s, h) => s + h.jobs, 0);

  fs.writeFileSync(outFile, JSON.stringify(uniq, null, 2));
  console.log(`\n${uniq.length} verified boards (~${totalJobs} jobs) → ${outFile}   [${Math.round((Date.now() - t0) / 1000)}s]`);
  const byAts = {}; const byRegion = {};
  for (const h of uniq) { byAts[h.ats] = (byAts[h.ats] || 0) + 1; byRegion[h.region] = (byRegion[h.region] || 0) + 1; }
  console.log('by ats:', JSON.stringify(byAts));
  console.log('by region:', JSON.stringify(byRegion));

  if (has('--merge')) {
    // ⚠️ region becomes each job's `country`, which the location filter reads. Keep it a SHORT clean
    // label ("India", "Germany") — a descriptive one leaks into the feed and breaks country matching.
    const merged = existing.slice();
    let added = 0;
    for (const h of uniq) {
      if (existingSlugs.has(norm(h.url))) continue;
      existingSlugs.add(norm(h.url));
      merged.push({ url: h.url, region: h.region });
      added++;
    }
    fs.writeFileSync(SOURCES_FILE, JSON.stringify(merged, null, 2) + '\n');
    console.log(`merged: ${existing.length} → ${merged.length} sources (+${added})`);
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
