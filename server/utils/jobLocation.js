// Map a free-text job location to a short country label.
//
// global_jobs.country feeds the Explore feed's country facet and filter, so it has to be a clean,
// consistent label. It used to be copied straight from the board's `region` entry in
// global_job_sources.json — a hand-written note like "London + global — cross-border payments fintech
// (96 EU roles". Those became their own bogus facets and could never match a country filter, and a
// note on the BOARD is the wrong thing to say about an individual JOB anyway: a London-HQ company
// posts roles in Singapore too.
//
// Deriving from the job's own location makes every ingest self-correcting: no AI, no network.
'use strict';

// Ordered: the first match wins, so put anything ambiguous after the specific case that should win.
const COUNTRY_PATTERNS = [
  ['India', /\b(india|bangalore|bengaluru|mumbai|new delhi|delhi|gurgaon|gurugram|noida|hyderabad|pune|chennai|kolkata|ahmedabad|jaipur|indore|kochi|coimbatore|chandigarh)\b/i],
  ['Singapore', /\bsingapore\b/i],
  ['Indonesia', /\b(indonesia|jakarta|bandung|surabaya)\b/i],
  ['Malaysia', /\b(malaysia|kuala lumpur|penang|cyberjaya)\b/i],
  ['Philippines', /\b(philippines|manila|makati|cebu|taguig)\b/i],
  ['Thailand', /\b(thailand|bangkok|chiang mai)\b/i],
  ['Vietnam', /\b(vietnam|viet nam|hanoi|ho chi minh|da nang)\b/i],
  ['Japan', /\b(japan|tokyo|osaka|kyoto|yokohama|fukuoka)\b/i],
  ['South Korea', /\b(south korea|korea|seoul|pangyo|busan)\b/i],
  ['China', /\b(china|beijing|shanghai|shenzhen|guangzhou|hangzhou)\b/i],
  ['Hong Kong', /\bhong kong\b/i],
  ['Taiwan', /\b(taiwan|taipei)\b/i],
  ['Australia', /\b(australia|sydney|melbourne|brisbane|perth|canberra|adelaide)\b/i],
  ['New Zealand', /\b(new zealand|auckland|wellington|christchurch)\b/i],
  ['UAE', /\b(united arab emirates|dubai|abu dhabi|sharjah)\b/i],
  ['Saudi Arabia', /\b(saudi|riyadh|jeddah|dammam)\b/i],
  ['Egypt', /\b(egypt|cairo|giza|alexandria)\b/i],
  ['Israel', /\b(israel|tel aviv|herzliya|haifa|jerusalem)\b/i],
  ['Turkey', /\b(turkey|türkiye|istanbul|ankara|izmir)\b/i],
  ['Nigeria', /\b(nigeria|lagos|abuja)\b/i],
  ['Kenya', /\b(kenya|nairobi)\b/i],
  ['South Africa', /\b(south africa|johannesburg|cape town|durban|pretoria)\b/i],
  ['Brazil', /\b(brazil|brasil|s[ãa]o paulo|rio de janeiro|belo horizonte|curitiba|porto alegre)\b/i],
  ['Mexico', /\b(mexico|m[ée]xico|guadalajara|monterrey|cdmx|quer[ée]taro)\b/i],
  ['Argentina', /\b(argentina|buenos aires|c[óo]rdoba)\b/i],
  ['Colombia', /\b(colombia|bogot[áa]|medell[íi]n|cali)\b/i],
  ['Chile', /\b(chile|santiago)\b/i],
  ['Peru', /\b(peru|per[úu]|lima)\b/i],
  ['Uruguay', /\b(uruguay|montevideo)\b/i],
  ['Canada', /\b(canada|toronto|vancouver|montr[ée]al|montreal|ottawa|calgary|waterloo|ontario|quebec|british columbia)\b/i],
  ['Ireland', /\b(ireland|dublin|galway)\b/i],
  ['UK', /\b(united kingdom|england|scotland|wales|london|manchester|edinburgh|bristol|leeds|glasgow|birmingham|belfast|cambridge, uk|oxford)\b/i],
  ['Germany', /\b(germany|deutschland|berlin|munich|m[üu]nchen|hamburg|frankfurt|cologne|k[öo]ln|stuttgart|d[üu]sseldorf|leipzig|karlsruhe)\b/i],
  ['France', /\b(france|paris|lyon|marseille|toulouse|bordeaux|lille|nantes)\b/i],
  ['Netherlands', /\b(netherlands|amsterdam|rotterdam|utrecht|eindhoven|the hague|den haag|delft)\b/i],
  ['Spain', /\b(spain|espa[ñn]a|madrid|barcelona|valencia|sevilla|m[áa]laga|bilbao)\b/i],
  ['Italy', /\b(italy|italia|milan|milano|rome|roma|turin|torino|bologna)\b/i],
  ['Portugal', /\b(portugal|lisbon|lisboa|porto|braga)\b/i],
  ['Switzerland', /\b(switzerland|schweiz|suisse|zurich|z[üu]rich|geneva|gen[èe]ve|basel|bern|lausanne|zug|lugano)\b/i],
  ['Austria', /\b(austria|[öo]sterreich|vienna|wien|graz|linz|salzburg)\b/i],
  ['Belgium', /\b(belgium|brussels|bruxelles|antwerp|ghent|leuven)\b/i],
  ['Sweden', /\b(sweden|sverige|stockholm|gothenburg|g[öo]teborg|malm[öo]|lund|uppsala)\b/i],
  ['Norway', /\b(norway|norge|oslo|bergen|trondheim)\b/i],
  ['Denmark', /\b(denmark|danmark|copenhagen|k[øo]benhavn|aarhus)\b/i],
  ['Finland', /\b(finland|suomi|helsinki|espoo|tampere|oulu)\b/i],
  ['Poland', /\b(poland|polska|warsaw|warszawa|krak[óo]w|krakow|wroc[łl]aw|gda[ńn]sk|pozna[ńn])\b/i],
  ['Czechia', /\b(czech|czechia|prague|praha|brno)\b/i],
  ['Romania', /\b(romania|bucharest|bucure[șs]ti|cluj|ia[șs]i|timi[șs]oara)\b/i],
  ['Hungary', /\b(hungary|budapest)\b/i],
  ['Greece', /\b(greece|athens|thessaloniki)\b/i],
  ['Estonia', /\b(estonia|tallinn|tartu)\b/i],
  ['Lithuania', /\b(lithuania|vilnius|kaunas)\b/i],
  ['Latvia', /\b(latvia|riga)\b/i],
  ['Bulgaria', /\b(bulgaria|sofia|plovdiv)\b/i],
  ['Serbia', /\b(serbia|belgrade|novi sad)\b/i],
  ['Ukraine', /\b(ukraine|kyiv|kiev|lviv)\b/i],
  ['US', /\b(united states|u\.s\.a?\.?|usa|new york|san francisco|seattle|austin|boston|chicago|los angeles|denver|atlanta|dallas|houston|miami|phoenix|san diego|san jose|washington, dc|california|texas|new jersey|virginia|colorado|massachusetts|illinois|florida|north carolina|pennsylvania|ohio|michigan|minnesota|utah|arizona|oregon|nevada|tennessee|missouri|wisconsin|maryland|georgia, us)\b/i],
];

// ── ISO-2 country codes ──────────────────────────────────────────────────────
// Some feeds never spell the country out. SAP writes "Walldorf, DE, 69190" and, in the US,
// "Palo Alto, CA, US, 94304" — 445 of its 1,035 jobs (43%) resolved to nothing before this.
//
// ⚠️ THE TRAP: half the US state abbreviations ARE ISO-2 country codes. CA is California AND
// Canada; IN is Indiana AND India; DE is Delaware AND Germany; GA, AZ, MD, PA, AL, AR, CO, ID,
// LA, MT, NE, SC, VA all collide too. Reading the FIRST two-letter token would file Palo Alto
// under Canada.
//
// The rule that works is: the country is the LAST standalone two-letter token, never the first.
// It holds for every shape in the data — "Palo Alto, CA, US, 94304" → US, "Bangalore, KA, IN,
// 560066" → IN, "Toronto, ON, CA" → CA(nada), "Walldorf, DE, 69190" → DE. A state code is always
// followed by its country; a country code never is.
//
// Names on the right MUST match COUNTRY_PATTERNS exactly ("US" not "United States", "UK" not
// "GB") or the same country becomes two separate facets in the feed.
const ISO2_COUNTRY = {
  IN: 'India', SG: 'Singapore', ID: 'Indonesia', MY: 'Malaysia', PH: 'Philippines', TH: 'Thailand',
  VN: 'Vietnam', JP: 'Japan', KR: 'South Korea', CN: 'China', HK: 'Hong Kong', TW: 'Taiwan',
  AU: 'Australia', NZ: 'New Zealand', AE: 'UAE', SA: 'Saudi Arabia', EG: 'Egypt', IL: 'Israel',
  TR: 'Turkey', NG: 'Nigeria', KE: 'Kenya', ZA: 'South Africa', BR: 'Brazil', MX: 'Mexico',
  AR: 'Argentina', CO: 'Colombia', CL: 'Chile', PE: 'Peru', UY: 'Uruguay', CA: 'Canada',
  IE: 'Ireland', GB: 'UK', UK: 'UK', DE: 'Germany', FR: 'France', NL: 'Netherlands', ES: 'Spain',
  IT: 'Italy', PT: 'Portugal', CH: 'Switzerland', AT: 'Austria', BE: 'Belgium', SE: 'Sweden',
  NO: 'Norway', DK: 'Denmark', FI: 'Finland', PL: 'Poland', CZ: 'Czechia', RO: 'Romania',
  HU: 'Hungary', GR: 'Greece', EE: 'Estonia', LT: 'Lithuania', LV: 'Latvia', BG: 'Bulgaria',
  RS: 'Serbia', UA: 'Ukraine', US: 'US',
  // Beyond the pattern list — these had no way to resolve at all before.
  SK: 'Slovakia', SI: 'Slovenia', HR: 'Croatia', LU: 'Luxembourg', IS: 'Iceland', MT: 'Malta',
  CY: 'Cyprus', MA: 'Morocco', TN: 'Tunisia', DZ: 'Algeria', GH: 'Ghana', TZ: 'Tanzania',
  UG: 'Uganda', ET: 'Ethiopia', AO: 'Angola', QA: 'Qatar', KW: 'Kuwait', BH: 'Bahrain',
  OM: 'Oman', JO: 'Jordan', LB: 'Lebanon', PK: 'Pakistan', BD: 'Bangladesh', LK: 'Sri Lanka',
  NP: 'Nepal', KZ: 'Kazakhstan', AZ: 'Azerbaijan', GE: 'Georgia', AM: 'Armenia', CR: 'Costa Rica',
  PA: 'Panama', GT: 'Guatemala', DO: 'Dominican Republic', EC: 'Ecuador', BO: 'Bolivia',
  PY: 'Paraguay', VE: 'Venezuela', PR: 'Puerto Rico', MU: 'Mauritius', RU: 'Russia',
};

// The country is the LAST standalone uppercase two-letter token — see the trap above.
function countryFromIso2(location) {
  const parts = String(location || '').split(/[,/|]/).map((p) => p.trim());
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^[A-Z]{2}$/.test(parts[i]) && ISO2_COUNTRY[parts[i]]) return ISO2_COUNTRY[parts[i]];
  }
  return null;
}

// A board's own label is only trusted when it already looks like a plain country name.
const CLEAN_LABEL = /^[A-Za-zÀ-ÿ .'-]{2,24}$/;

function countryFromLocation(location) {
  const s = String(location || '').trim();
  if (!s) return null;
  for (const [name, re] of COUNTRY_PATTERNS) if (re.test(s)) return name;
  return null;
}

// What to store in global_jobs.country: the job's own location wins; a tidy board label is the
// fallback; anything else becomes 'Global' rather than a bogus facet of its own.
function resolveCountry(location, boardRegion) {
  return countryFromLocation(location)
    // ISO-2 runs AFTER the name/city patterns and BEFORE the board's own label, so it can only
    // ever turn a job we were about to file under "Global" (or under a board label like "Europe")
    // into its real country. It can never override a country we already recognised by name.
    || countryFromIso2(location)
    || (CLEAN_LABEL.test(String(boardRegion || '').trim()) ? String(boardRegion).trim() : null)
    || 'Global';
}

// COUNTRY_PATTERNS is exported so geoRank.js can reuse the SAME "is this location in country X"
// rule for ranking (in JS and, transliterated \b→\y, in SQL) instead of writing a second one that
// would drift from this one.
module.exports = { countryFromLocation, countryFromIso2, resolveCountry, CLEAN_LABEL, COUNTRY_PATTERNS, ISO2_COUNTRY };
