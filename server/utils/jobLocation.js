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
    || (CLEAN_LABEL.test(String(boardRegion || '').trim()) ? String(boardRegion).trim() : null)
    || 'Global';
}

module.exports = { countryFromLocation, resolveCountry, CLEAN_LABEL };
