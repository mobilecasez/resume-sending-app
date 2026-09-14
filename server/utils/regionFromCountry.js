// Country → CV-convention region, for EVERY country: from free text (a chip's country, an address),
// from a website's ccTLD, or from researched conventions (employerResearch conventions.hqCountry).
// Region ids are the template gallery's: generic, us_ca, uk_au, india, dach, eu, sg.
//
// WHY THIS EXISTS: the design ranking and the letter style both key off the region, and the old
// matcher knew ~40 countries. Everything else fell to 'generic' — prod ranked a Moroccan public agency
// (.ma), a Ghanaian job site (.com) and a Swiss SME the same way, because two of the three had no
// region at all. Every country now maps to the NEAREST CV convention among the seven regions:
// Morocco/Tunisia/Algeria → eu (French CV conventions), the Gulf → eu with a photo + personal-details
// profile, Nigeria/Ghana/Kenya/South Africa → uk_au, Latin America → eu (photo optional), East and
// Southeast Asia → sg, Ireland → uk_au (a UK-style CV: no photo, two pages — it used to be 'eu').
//
// ⚠️ A REGION IS A GALLERY BUCKET, NOT A COUNTRY'S HABITS. "eu" holds France, Poland, Morocco and
// Qatar, and their CVs differ (a Qatari CV carries a photo and a nationality; a Dutch one usually
// does not). So each country also carries a CV PROFILE (photo / personal details / length / format)
// and a `home` flag (is this region the country's own, or only the nearest proxy?). designFit uses
// them as SOFT defaults under the researched conventions; they are general conventions, never a
// claim about one employer.
//
// ⚠️ MATCHING IS WORD-BOUNDED, LAST MENTION WINS, COUNTRY NAMES BEAT CITIES. Substring matching
// cannot scale to every country: "oman" is inside "romania", "niger" inside "nigeria", "india" inside
// "indiana", "mexico" inside "new mexico", "america" inside "latin america" (which the old matcher
// filed under us_ca). A hit inside a longer hit is dropped ("benin" in "Benin City", "wales" in "New
// South Wales"); addresses end with their country, so the LAST country-level mention wins; a city
// only decides when no country or code is named ("Paris, Texas" is Texas).
//
// ⚠️ TWO-LETTER CODES ARE READ ONLY WHEN THEY CANNOT BE A US STATE. "Casablanca, MA" and "Boston, MA"
// are indistinguishable; CA, IN, DE, GA, PA… are both. A trailing uppercase code is trusted only when
// it is not a US state code (so "Palo Alto, CA, US, 94304" → US, "Walldorf, DE" → unknown → the
// caller's next signal). A WHOLE string that is a code ("DE", "MA") is a clean data label and is read.
//
// The mobile mirror (MobileApp/regionUtils.js) still carries the original short lists; this server
// copy is the one the employer lanes and the batch send path (batchRoutes.js) use.
'use strict';

const REGION_IDS = ['generic', 'us_ca', 'uk_au', 'india', 'dach', 'eu', 'sg'];

// ── CV convention profiles ────────────────────────────────────────────────────
// photo: expected | optional | avoid · personalDetails (date of birth, nationality, marital status):
// include | avoid · length: one_page | two_pages | flexible · format: tabular | narrative | europass |
// ats_plain. null = no general convention worth ranking on. Same vocabulary as employerResearch
// conventions.cv, so a researched answer and a default are read by the same code in designFit.
const CV_PROFILES = {
  anglo1:     { photo: 'avoid',    personalDetails: 'avoid',   length: 'one_page',  format: null },       // US, Israel
  anglo2:     { photo: 'avoid',    personalDetails: 'avoid',   length: 'two_pages', format: null },       // UK, Ireland, Canada, AU, NZ
  africa_en:  { photo: 'avoid',    personalDetails: null,      length: 'two_pages', format: null },       // anglophone Africa
  dach:       { photo: 'optional', personalDetails: 'include', length: 'two_pages', format: 'tabular' },  // Lebenslauf
  franco:     { photo: 'optional', personalDetails: null,      length: 'one_page',  format: null },       // France, Belgium, Luxembourg
  franco_ext: { photo: 'optional', personalDetails: 'include', length: null,        format: null },       // Maghreb, francophone/lusophone Africa
  south_eu:   { photo: 'optional', personalDetails: 'include', length: 'two_pages', format: 'europass' }, // Italy, Portugal, Greece, Malta, Cyprus
  iberia:     { photo: 'optional', personalDetails: null,      length: 'two_pages', format: null },       // Spain, Andorra
  north_eu:   { photo: 'optional', personalDetails: 'avoid',   length: 'two_pages', format: null },       // Netherlands, Nordics
  cee:        { photo: 'optional', personalDetails: null,      length: 'two_pages', format: 'europass' }, // Central & Eastern Europe, Baltics
  cis:        { photo: 'expected', personalDetails: 'include', length: 'two_pages', format: null },       // Russia, Caucasus, Central Asia, Turkey
  gulf:       { photo: 'expected', personalDetails: 'include', length: 'two_pages', format: null },       // Gulf states, Levant, Egypt
  south_asia: { photo: 'optional', personalDetails: null,      length: 'two_pages', format: null },       // India, Pakistan, Bangladesh…
  sg:         { photo: 'optional', personalDetails: null,      length: 'two_pages', format: null },       // Singapore, Hong Kong, Macau
  sea:        { photo: 'expected', personalDetails: 'include', length: 'two_pages', format: null },       // Malaysia, Indonesia, Philippines…
  east_asia:  { photo: 'expected', personalDetails: 'include', length: null,        format: 'tabular' },  // Japan, Korea, China, Taiwan
  latam:      { photo: 'optional', personalDetails: null,      length: null,        format: null },       // Latin America
};
// When only the REGION is known (no country): the habits every country in it shares, nothing more.
const REGION_PROFILES = {
  us_ca: { photo: 'avoid',    personalDetails: 'avoid', length: null,        format: null },
  uk_au: { photo: 'avoid',    personalDetails: 'avoid', length: 'two_pages', format: null },
  india: CV_PROFILES.south_asia,
  dach:  CV_PROFILES.dach,
  eu:    { photo: 'optional', personalDetails: null,    length: 'two_pages', format: null },
  sg:    CV_PROFILES.sg,
};

// ── The country table ─────────────────────────────────────────────────────────
// [iso2, English name, region, CV profile, home (1 = this region IS its convention, 0 = nearest proxy),
//  country-level aliases ("|"), places ("|" — cities/areas, weaker than any name)].
// Aliases and places are written in plain spelling; fold() strips accents on both sides.
const COUNTRY_ROWS = [
  // ── North America ──
  ['US', 'United States', 'us_ca', 'anglo1', 1,
    'united states of america|united states|usa|u.s.a.|u.s.a|u.s.|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|west virginia|wisconsin|wyoming|washington state|washington dc|washington d.c.|district of columbia',
    'new york city|nyc|manhattan|brooklyn|san francisco|los angeles|seattle|boston|chicago|austin|denver|atlanta|dallas|houston|miami|phoenix|san diego|san jose|palo alto|mountain view|menlo park|sunnyvale|cupertino|redmond|silicon valley|bay area|philadelphia|pittsburgh|detroit|minneapolis|portland|salt lake city|las vegas|nashville|charlotte|raleigh|orlando|tampa|baltimore|indianapolis|kansas city|cincinnati|cleveland|san antonio|sacramento'],
  ['CA', 'Canada', 'us_ca', 'anglo2', 1,
    'canada|ontario|quebec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|prince edward island|yukon|nunavut|northwest territories',
    'toronto|vancouver|montreal|ottawa|calgary|edmonton|waterloo|winnipeg|halifax|mississauga|quebec city|kitchener|burnaby'],
  ['PR', 'Puerto Rico', 'us_ca', 'anglo1', 0, 'puerto rico', 'san juan'],
  ['MX', 'Mexico', 'eu', 'latam', 0, 'mexico|estados unidos mexicanos', 'mexico city|ciudad de mexico|cdmx|guadalajara|monterrey|queretaro|puebla|tijuana|merida'],
  // ── Central America & Caribbean ──
  ['GT', 'Guatemala', 'eu', 'latam', 0, 'guatemala', 'guatemala city'],
  ['BZ', 'Belize', 'uk_au', 'anglo2', 0, 'belize', 'belmopan'],
  ['HN', 'Honduras', 'eu', 'latam', 0, 'honduras', 'tegucigalpa|san pedro sula'],
  ['SV', 'El Salvador', 'eu', 'latam', 0, 'el salvador', 'san salvador'],
  ['NI', 'Nicaragua', 'eu', 'latam', 0, 'nicaragua', 'managua'],
  ['CR', 'Costa Rica', 'eu', 'latam', 0, 'costa rica', 'san jose costa rica|heredia'],
  ['PA', 'Panama', 'eu', 'latam', 0, 'panama', 'panama city'],
  ['CU', 'Cuba', 'eu', 'latam', 0, 'cuba', 'havana|la habana'],
  ['DO', 'Dominican Republic', 'eu', 'latam', 0, 'dominican republic|republica dominicana', 'santo domingo'],
  ['HT', 'Haiti', 'eu', 'franco_ext', 0, 'haiti', 'port-au-prince'],
  ['JM', 'Jamaica', 'uk_au', 'anglo2', 0, 'jamaica', 'kingston jamaica|montego bay'],
  ['TT', 'Trinidad and Tobago', 'uk_au', 'anglo2', 0, 'trinidad and tobago|trinidad', 'port of spain'],
  ['BB', 'Barbados', 'uk_au', 'anglo2', 0, 'barbados', 'bridgetown'],
  ['BS', 'Bahamas', 'uk_au', 'anglo2', 0, 'bahamas', 'nassau'],
  ['AG', 'Antigua and Barbuda', 'uk_au', 'anglo2', 0, 'antigua and barbuda|antigua', ''],
  ['DM', 'Dominica', 'uk_au', 'anglo2', 0, 'dominica', 'roseau'],
  ['GD', 'Grenada', 'uk_au', 'anglo2', 0, 'grenada', ''],
  ['LC', 'Saint Lucia', 'uk_au', 'anglo2', 0, 'saint lucia|st lucia|st. lucia', 'castries'],
  ['VC', 'Saint Vincent and the Grenadines', 'uk_au', 'anglo2', 0, 'saint vincent and the grenadines|st vincent', 'kingstown'],
  ['KN', 'Saint Kitts and Nevis', 'uk_au', 'anglo2', 0, 'saint kitts and nevis|st kitts', 'basseterre'],
  ['KY', 'Cayman Islands', 'uk_au', 'anglo2', 0, 'cayman islands', 'grand cayman|george town cayman'],
  ['BM', 'Bermuda', 'uk_au', 'anglo2', 0, 'bermuda', 'hamilton bermuda'],
  ['GP', 'Guadeloupe', 'eu', 'franco', 0, 'guadeloupe', 'pointe-a-pitre'],
  ['MQ', 'Martinique', 'eu', 'franco', 0, 'martinique', 'fort-de-france'],
  // ── South America ──
  ['BR', 'Brazil', 'eu', 'latam', 0, 'brazil|brasil', 'sao paulo|rio de janeiro|belo horizonte|curitiba|porto alegre|brasilia|recife|florianopolis|campinas|fortaleza'],
  ['AR', 'Argentina', 'eu', 'latam', 0, 'argentina', 'buenos aires|rosario|mendoza'],
  ['CL', 'Chile', 'eu', 'latam', 0, 'chile', 'santiago|santiago de chile|valparaiso'],
  ['CO', 'Colombia', 'eu', 'latam', 0, 'colombia', 'bogota|medellin|barranquilla'],
  ['PE', 'Peru', 'eu', 'latam', 0, 'peru', 'lima|arequipa|cusco'],
  ['EC', 'Ecuador', 'eu', 'latam', 0, 'ecuador', 'quito|guayaquil'],
  ['BO', 'Bolivia', 'eu', 'latam', 0, 'bolivia', 'la paz|santa cruz de la sierra|cochabamba'],
  ['PY', 'Paraguay', 'eu', 'latam', 0, 'paraguay', 'asuncion'],
  ['UY', 'Uruguay', 'eu', 'latam', 0, 'uruguay', 'montevideo'],
  ['VE', 'Venezuela', 'eu', 'latam', 0, 'venezuela', 'caracas|maracaibo'],
  ['GY', 'Guyana', 'uk_au', 'anglo2', 0, 'guyana', 'georgetown guyana'],
  ['SR', 'Suriname', 'eu', 'latam', 0, 'suriname', 'paramaribo'],
  ['GF', 'French Guiana', 'eu', 'franco', 0, 'french guiana|guyane', 'cayenne'],
  // ── UK & Ireland ──
  ['GB', 'United Kingdom', 'uk_au', 'anglo2', 1,
    'united kingdom|great britain|britain|england|scotland|wales|northern ireland|u.k.|uk',
    'london|manchester|birmingham|leeds|glasgow|edinburgh|bristol|liverpool|sheffield|newcastle upon tyne|nottingham|cardiff|belfast|milton keynes|brighton|southampton|leicester|aberdeen'],
  ['IE', 'Ireland', 'uk_au', 'anglo2', 1, 'ireland|republic of ireland|eire', 'dublin|cork|galway|limerick'],
  ['IM', 'Isle of Man', 'uk_au', 'anglo2', 0, 'isle of man', 'douglas isle of man'],
  ['JE', 'Jersey', 'uk_au', 'anglo2', 0, 'bailiwick of jersey|jersey channel islands', 'st helier'],
  ['GG', 'Guernsey', 'uk_au', 'anglo2', 0, 'guernsey', 'st peter port'],
  ['GI', 'Gibraltar', 'uk_au', 'anglo2', 0, 'gibraltar', ''],
  // ── DACH ──
  ['DE', 'Germany', 'dach', 'dach', 1, 'germany|deutschland|federal republic of germany|bundesrepublik deutschland',
    'berlin|munich|munchen|muenchen|frankfurt|frankfurt am main|hamburg|cologne|koln|koeln|stuttgart|dusseldorf|duesseldorf|leipzig|karlsruhe|dresden|hannover|hanover|nuremberg|nurnberg|bremen|bonn|dortmund|mannheim|walldorf|wolfsburg|ingolstadt|darmstadt|heidelberg'],
  ['AT', 'Austria', 'dach', 'dach', 1, 'austria|osterreich|oesterreich', 'vienna|wien|graz|linz|salzburg|innsbruck|klagenfurt'],
  ['CH', 'Switzerland', 'dach', 'dach', 1, 'switzerland|schweiz|suisse|svizzera|swiss confederation',
    'zurich|zuerich|geneva|geneve|genf|basel|bern|berne|lausanne|zug|lugano|lucerne|luzern|winterthur|st. gallen|st gallen'],
  ['LI', 'Liechtenstein', 'dach', 'dach', 1, 'liechtenstein', 'vaduz'],
  // ── Western & Southern Europe ──
  ['FR', 'France', 'eu', 'franco', 1, 'france|republique francaise', 'paris|lyon|marseille|toulouse|bordeaux|lille|nantes|strasbourg|montpellier|rennes|grenoble|sophia antipolis|la defense'],
  ['BE', 'Belgium', 'eu', 'franco', 1, 'belgium|belgique|belgie|belgien', 'brussels|bruxelles|brussel|antwerp|antwerpen|ghent|gent|leuven|liege|charleroi|namur|mechelen'],
  ['LU', 'Luxembourg', 'eu', 'franco', 1, 'luxembourg|luxemburg|letzebuerg', 'luxembourg city|esch-sur-alzette'],
  ['MC', 'Monaco', 'eu', 'franco', 1, 'monaco', 'monte carlo|monte-carlo'],
  ['NL', 'Netherlands', 'eu', 'north_eu', 1, 'netherlands|the netherlands|nederland|holland', 'amsterdam|rotterdam|utrecht|eindhoven|the hague|den haag|delft|groningen|leiden|haarlem|arnhem|nijmegen|tilburg|breda|maastricht|amstelveen|hoofddorp'],
  ['ES', 'Spain', 'eu', 'iberia', 1, 'spain|espana|reino de espana', 'madrid|barcelona|valencia|sevilla|seville|malaga|bilbao|zaragoza|palma de mallorca|alicante|murcia|valladolid|vigo|a coruna|las palmas|granada'],
  ['AD', 'Andorra', 'eu', 'iberia', 1, 'andorra', 'andorra la vella'],
  ['PT', 'Portugal', 'eu', 'south_eu', 1, 'portugal', 'lisbon|lisboa|porto|braga|coimbra|faro|aveiro'],
  ['IT', 'Italy', 'eu', 'south_eu', 1, 'italy|italia', 'rome|roma|milan|milano|turin|torino|naples|napoli|florence|firenze|bologna|genoa|genova|venice|venezia|verona|padua|padova|bari|palermo|catania|trieste|brescia|bergamo|modena|parma|pisa'],
  ['SM', 'San Marino', 'eu', 'south_eu', 1, 'san marino', ''],
  ['VA', 'Vatican City', 'eu', 'south_eu', 1, 'vatican city|holy see', ''],
  ['MT', 'Malta', 'eu', 'south_eu', 1, 'malta', "valletta|sliema|st julians|st. julian's|birkirkara"],
  ['GR', 'Greece', 'eu', 'south_eu', 1, 'greece|hellas|hellenic republic', 'athens|athina|thessaloniki|patras|heraklion|piraeus'],
  ['CY', 'Cyprus', 'eu', 'south_eu', 1, 'cyprus', 'nicosia|limassol|larnaca|paphos'],
  // ── Nordics ──
  ['SE', 'Sweden', 'eu', 'north_eu', 1, 'sweden|sverige', 'stockholm|gothenburg|goteborg|malmo|uppsala|lund|linkoping|vasteras|orebro|umea'],
  ['NO', 'Norway', 'eu', 'north_eu', 1, 'norway|norge|noreg', 'oslo|bergen|trondheim|stavanger|tromso'],
  ['DK', 'Denmark', 'eu', 'north_eu', 1, 'denmark|danmark', 'copenhagen|kobenhavn|aarhus|odense|aalborg'],
  ['FI', 'Finland', 'eu', 'north_eu', 1, 'finland|suomi', 'helsinki|espoo|tampere|vantaa|oulu|turku'],
  ['IS', 'Iceland', 'eu', 'north_eu', 1, 'iceland', 'reykjavik'],
  ['FO', 'Faroe Islands', 'eu', 'north_eu', 1, 'faroe islands|faroes', 'torshavn'],
  ['GL', 'Greenland', 'eu', 'north_eu', 0, 'greenland', 'nuuk'],
  // ── Central & Eastern Europe, Baltics ──
  ['EE', 'Estonia', 'eu', 'cee', 1, 'estonia|eesti', 'tallinn|tartu'],
  ['LV', 'Latvia', 'eu', 'cee', 1, 'latvia|latvija', 'riga'],
  ['LT', 'Lithuania', 'eu', 'cee', 1, 'lithuania|lietuva', 'vilnius|kaunas|klaipeda'],
  ['PL', 'Poland', 'eu', 'cee', 1, 'poland|polska', 'warsaw|warszawa|krakow|cracow|wroclaw|gdansk|poznan|lodz|katowice|szczecin|lublin|bydgoszcz|gdynia'],
  ['CZ', 'Czechia', 'eu', 'cee', 1, 'czechia|czech republic|czech|ceska republika|cesko', 'prague|praha|brno|ostrava|plzen|pilsen'],
  ['SK', 'Slovakia', 'eu', 'cee', 1, 'slovakia|slovensko|slovak republic', 'bratislava|kosice|zilina'],
  ['HU', 'Hungary', 'eu', 'cee', 1, 'hungary|magyarorszag', 'budapest|debrecen|szeged|gyor'],
  ['RO', 'Romania', 'eu', 'cee', 1, 'romania|roumanie', 'bucharest|bucuresti|cluj-napoca|cluj|iasi|timisoara|brasov|constanta|oradea|sibiu'],
  ['BG', 'Bulgaria', 'eu', 'cee', 1, 'bulgaria', 'sofia|plovdiv|varna|burgas'],
  ['HR', 'Croatia', 'eu', 'cee', 1, 'croatia|hrvatska', 'zagreb|rijeka|osijek'],
  ['SI', 'Slovenia', 'eu', 'cee', 1, 'slovenia|slovenija', 'ljubljana|maribor'],
  ['RS', 'Serbia', 'eu', 'cee', 1, 'serbia|srbija', 'belgrade|beograd|novi sad'],
  ['BA', 'Bosnia and Herzegovina', 'eu', 'cee', 1, 'bosnia and herzegovina|bosnia & herzegovina|bosnia', 'sarajevo|banja luka|mostar'],
  ['ME', 'Montenegro', 'eu', 'cee', 1, 'montenegro|crna gora', 'podgorica'],
  ['MK', 'North Macedonia', 'eu', 'cee', 1, 'north macedonia|macedonia', 'skopje'],
  ['AL', 'Albania', 'eu', 'cee', 1, 'albania|shqiperia', 'tirana|tirane|durres'],
  ['XK', 'Kosovo', 'eu', 'cee', 1, 'kosovo', 'pristina|prishtina'],
  ['MD', 'Moldova', 'eu', 'cee', 1, 'moldova|republic of moldova', 'chisinau'],
  ['UA', 'Ukraine', 'eu', 'cee', 1, 'ukraine|ukraina', 'kyiv|kiev|lviv|kharkiv|odesa|odessa|dnipro'],
  ['BY', 'Belarus', 'eu', 'cee', 1, 'belarus', 'minsk'],
  // ── Russia, Turkey, Caucasus, Central Asia ──
  ['RU', 'Russia', 'eu', 'cis', 0, 'russia|russian federation|rossiya', 'moscow|moskva|saint petersburg|st. petersburg|st petersburg|novosibirsk|yekaterinburg|kazan|nizhny novgorod'],
  ['TR', 'Turkey', 'eu', 'cis', 0, 'turkey|turkiye', 'istanbul|ankara|izmir|bursa|antalya|kocaeli'],
  ['GE', 'Georgia', 'eu', 'cis', 0, 'sakartvelo|republic of georgia|georgia country', 'tbilisi|batumi|kutaisi'],
  ['AM', 'Armenia', 'eu', 'cis', 0, 'armenia|hayastan', 'yerevan'],
  ['AZ', 'Azerbaijan', 'eu', 'cis', 0, 'azerbaijan', 'baku'],
  ['KZ', 'Kazakhstan', 'eu', 'cis', 0, 'kazakhstan', 'almaty|astana|nur-sultan|shymkent'],
  ['UZ', 'Uzbekistan', 'eu', 'cis', 0, 'uzbekistan', 'tashkent|samarkand'],
  ['KG', 'Kyrgyzstan', 'eu', 'cis', 0, 'kyrgyzstan|kyrgyz republic', 'bishkek'],
  ['TJ', 'Tajikistan', 'eu', 'cis', 0, 'tajikistan', 'dushanbe'],
  ['TM', 'Turkmenistan', 'eu', 'cis', 0, 'turkmenistan', 'ashgabat'],
  ['MN', 'Mongolia', 'eu', 'cis', 0, 'mongolia', 'ulaanbaatar|ulan bator'],
  // ── Middle East ──
  ['AE', 'United Arab Emirates', 'eu', 'gulf', 0, 'united arab emirates|u.a.e.|uae|emirates', 'dubai|abu dhabi|sharjah|ajman|ras al khaimah|fujairah|al ain'],
  ['SA', 'Saudi Arabia', 'eu', 'gulf', 0, 'saudi arabia|kingdom of saudi arabia|ksa|saudi', 'riyadh|jeddah|jiddah|dammam|khobar|al khobar|makkah|mecca|madinah|medina|neom|dhahran|jubail'],
  ['QA', 'Qatar', 'eu', 'gulf', 0, 'qatar', 'doha|lusail|al rayyan'],
  ['KW', 'Kuwait', 'eu', 'gulf', 0, 'kuwait', 'kuwait city'],
  ['BH', 'Bahrain', 'eu', 'gulf', 0, 'bahrain', 'manama'],
  ['OM', 'Oman', 'eu', 'gulf', 0, 'oman|sultanate of oman', 'muscat|salalah|sohar'],
  ['YE', 'Yemen', 'eu', 'gulf', 0, 'yemen', 'sanaa|aden'],
  ['JO', 'Jordan', 'eu', 'gulf', 0, 'jordan|hashemite kingdom of jordan', 'amman|irbid|aqaba'],
  ['LB', 'Lebanon', 'eu', 'gulf', 0, 'lebanon|liban', 'beirut'],
  ['SY', 'Syria', 'eu', 'gulf', 0, 'syria|syrian arab republic', 'damascus|aleppo'],
  ['IQ', 'Iraq', 'eu', 'gulf', 0, 'iraq', 'baghdad|erbil|basra|sulaymaniyah'],
  ['PS', 'Palestine', 'eu', 'gulf', 0, 'palestine|state of palestine', 'ramallah|gaza city'],
  ['IL', 'Israel', 'us_ca', 'anglo1', 0, 'israel', 'tel aviv|tel aviv-yafo|jerusalem|haifa|herzliya|beersheba|petah tikva|ramat gan|netanya|rehovot'],
  ['IR', 'Iran', 'eu', 'gulf', 0, 'iran|islamic republic of iran', 'tehran|isfahan|mashhad|shiraz|tabriz'],
  // ── North Africa ──
  ['EG', 'Egypt', 'eu', 'gulf', 0, 'egypt|misr', 'cairo|new cairo|giza|alexandria|sharm el sheikh|hurghada|mansoura'],
  ['LY', 'Libya', 'eu', 'gulf', 0, 'libya', 'tripoli|benghazi'],
  ['TN', 'Tunisia', 'eu', 'franco_ext', 0, 'tunisia|tunisie', 'tunis|sfax|sousse'],
  ['DZ', 'Algeria', 'eu', 'franco_ext', 0, 'algeria|algerie', 'algiers|alger|oran'],
  ['MA', 'Morocco', 'eu', 'franco_ext', 0, 'morocco|maroc|kingdom of morocco', 'casablanca|rabat|marrakech|marrakesh|tangier|tanger|fes|fez|agadir|meknes|oujda|kenitra'],
  ['MR', 'Mauritania', 'eu', 'franco_ext', 0, 'mauritania|mauritanie', 'nouakchott'],
  ['SD', 'Sudan', 'uk_au', 'africa_en', 0, 'sudan', 'khartoum'],
  ['SS', 'South Sudan', 'uk_au', 'africa_en', 0, 'south sudan', 'juba'],
  // ── West Africa ──
  ['NG', 'Nigeria', 'uk_au', 'africa_en', 0, 'nigeria', 'lagos|abuja|port harcourt|ibadan|kano|benin city|enugu|kaduna|ikeja|lekki|victoria island'],
  ['GH', 'Ghana', 'uk_au', 'africa_en', 0, 'ghana', 'accra|kumasi|tema|takoradi|tamale|cape coast'],
  ['SN', 'Senegal', 'eu', 'franco_ext', 0, 'senegal', 'dakar|thies'],
  ['CI', "Cote d'Ivoire", 'eu', 'franco_ext', 0, "cote d'ivoire|cote divoire|ivory coast", 'abidjan|yamoussoukro|bouake'],
  ['ML', 'Mali', 'eu', 'franco_ext', 0, 'mali', 'bamako'],
  ['BF', 'Burkina Faso', 'eu', 'franco_ext', 0, 'burkina faso|burkina', 'ouagadougou'],
  ['NE', 'Niger', 'eu', 'franco_ext', 0, 'niger', 'niamey'],
  ['BJ', 'Benin', 'eu', 'franco_ext', 0, 'benin|republic of benin', 'cotonou|porto-novo'],
  ['TG', 'Togo', 'eu', 'franco_ext', 0, 'togo', 'lome'],
  ['GN', 'Guinea', 'eu', 'franco_ext', 0, 'guinea|guinee|republic of guinea', 'conakry'],
  ['GW', 'Guinea-Bissau', 'eu', 'franco_ext', 0, 'guinea-bissau|guinea bissau', 'bissau'],
  ['SL', 'Sierra Leone', 'uk_au', 'africa_en', 0, 'sierra leone', 'freetown'],
  ['LR', 'Liberia', 'uk_au', 'africa_en', 0, 'liberia', 'monrovia'],
  ['GM', 'Gambia', 'uk_au', 'africa_en', 0, 'gambia|the gambia', 'banjul'],
  ['CV', 'Cape Verde', 'eu', 'franco_ext', 0, 'cape verde|cabo verde', 'praia'],
  // ── Central Africa ──
  ['CM', 'Cameroon', 'eu', 'franco_ext', 0, 'cameroon|cameroun', 'douala|yaounde'],
  ['TD', 'Chad', 'eu', 'franco_ext', 0, 'chad|tchad', "n'djamena|ndjamena"],
  ['CF', 'Central African Republic', 'eu', 'franco_ext', 0, 'central african republic|centrafrique', 'bangui'],
  ['GA', 'Gabon', 'eu', 'franco_ext', 0, 'gabon', 'libreville'],
  ['CG', 'Republic of the Congo', 'eu', 'franco_ext', 0, 'republic of the congo|congo-brazzaville|congo brazzaville', 'brazzaville|pointe-noire'],
  ['CD', 'DR Congo', 'eu', 'franco_ext', 0, 'democratic republic of the congo|democratic republic of congo|dr congo|drc|congo-kinshasa|congo', 'kinshasa|lubumbashi|goma'],
  ['GQ', 'Equatorial Guinea', 'eu', 'franco_ext', 0, 'equatorial guinea', 'malabo'],
  ['ST', 'Sao Tome and Principe', 'eu', 'franco_ext', 0, 'sao tome and principe|sao tome', ''],
  ['AO', 'Angola', 'eu', 'franco_ext', 0, 'angola', 'luanda'],
  // ── East Africa ──
  ['KE', 'Kenya', 'uk_au', 'africa_en', 0, 'kenya', 'nairobi|mombasa|kisumu|nakuru'],
  ['UG', 'Uganda', 'uk_au', 'africa_en', 0, 'uganda', 'kampala|entebbe'],
  ['TZ', 'Tanzania', 'uk_au', 'africa_en', 0, 'tanzania', 'dar es salaam|dodoma|arusha|zanzibar'],
  ['RW', 'Rwanda', 'uk_au', 'africa_en', 0, 'rwanda', 'kigali'],
  ['BI', 'Burundi', 'eu', 'franco_ext', 0, 'burundi', 'bujumbura|gitega'],
  ['ET', 'Ethiopia', 'uk_au', 'africa_en', 0, 'ethiopia', 'addis ababa'],
  ['ER', 'Eritrea', 'uk_au', 'africa_en', 0, 'eritrea', 'asmara'],
  ['DJ', 'Djibouti', 'eu', 'franco_ext', 0, 'djibouti', ''],
  ['SO', 'Somalia', 'uk_au', 'africa_en', 0, 'somalia|somaliland', 'mogadishu|hargeisa'],
  ['MG', 'Madagascar', 'eu', 'franco_ext', 0, 'madagascar', 'antananarivo'],
  ['MU', 'Mauritius', 'uk_au', 'africa_en', 0, 'mauritius', 'port louis|ebene'],
  ['SC', 'Seychelles', 'uk_au', 'africa_en', 0, 'seychelles', 'victoria seychelles'],
  ['KM', 'Comoros', 'eu', 'franco_ext', 0, 'comoros', 'moroni'],
  ['RE', 'Reunion', 'eu', 'franco', 0, 'reunion island|la reunion', 'saint-denis reunion'],
  ['YT', 'Mayotte', 'eu', 'franco', 0, 'mayotte', 'mamoudzou'],
  // ── Southern Africa ──
  ['ZA', 'South Africa', 'uk_au', 'africa_en', 0, 'south africa|rsa|suid-afrika', 'johannesburg|cape town|durban|pretoria|sandton|port elizabeth|gqeberha|bloemfontein|stellenbosch|centurion|midrand'],
  ['NA', 'Namibia', 'uk_au', 'africa_en', 0, 'namibia', 'windhoek'],
  ['BW', 'Botswana', 'uk_au', 'africa_en', 0, 'botswana', 'gaborone'],
  ['ZW', 'Zimbabwe', 'uk_au', 'africa_en', 0, 'zimbabwe', 'harare|bulawayo'],
  ['ZM', 'Zambia', 'uk_au', 'africa_en', 0, 'zambia', 'lusaka|ndola|kitwe'],
  ['MW', 'Malawi', 'uk_au', 'africa_en', 0, 'malawi', 'lilongwe|blantyre'],
  ['MZ', 'Mozambique', 'eu', 'franco_ext', 0, 'mozambique|mocambique', 'maputo'],
  ['LS', 'Lesotho', 'uk_au', 'africa_en', 0, 'lesotho', 'maseru'],
  ['SZ', 'Eswatini', 'uk_au', 'africa_en', 0, 'eswatini|swaziland', 'mbabane'],
  // ── South Asia ──
  ['IN', 'India', 'india', 'south_asia', 1, 'india|bharat',
    'bangalore|bengaluru|mumbai|bombay|new delhi|delhi|hyderabad|pune|chennai|madras|kolkata|calcutta|ahmedabad|gurugram|gurgaon|noida|greater noida|jaipur|indore|kochi|cochin|coimbatore|chandigarh|lucknow|nagpur|surat|vadodara|bhubaneswar|thiruvananthapuram|trivandrum|visakhapatnam|mysore|mysuru|mangalore|navi mumbai|thane'],
  ['PK', 'Pakistan', 'india', 'south_asia', 1, 'pakistan', 'karachi|lahore|islamabad|rawalpindi|faisalabad|peshawar|multan'],
  ['BD', 'Bangladesh', 'india', 'south_asia', 1, 'bangladesh', 'dhaka|chittagong|chattogram|khulna|sylhet'],
  ['LK', 'Sri Lanka', 'india', 'south_asia', 1, 'sri lanka|ceylon', 'colombo|kandy|galle'],
  ['NP', 'Nepal', 'india', 'south_asia', 1, 'nepal', 'kathmandu|pokhara|lalitpur'],
  ['BT', 'Bhutan', 'india', 'south_asia', 1, 'bhutan', 'thimphu'],
  ['MV', 'Maldives', 'india', 'south_asia', 1, 'maldives', ''],
  ['AF', 'Afghanistan', 'india', 'south_asia', 0, 'afghanistan', 'kabul|herat|kandahar'],
  // ── East & Southeast Asia ──
  ['SG', 'Singapore', 'sg', 'sg', 1, 'singapore|republic of singapore', ''],
  ['HK', 'Hong Kong', 'sg', 'sg', 1, 'hong kong|hong kong sar|hksar', 'kowloon|tsim sha tsui|quarry bay|kwun tong'],
  ['MO', 'Macau', 'sg', 'sg', 0, 'macau|macao', ''],
  ['MY', 'Malaysia', 'sg', 'sea', 1, 'malaysia', 'kuala lumpur|penang|cyberjaya|petaling jaya|johor bahru|putrajaya|shah alam|kota kinabalu|kuching|ipoh'],
  ['ID', 'Indonesia', 'sg', 'sea', 0, 'indonesia', 'jakarta|surabaya|bandung|medan|bali|denpasar|yogyakarta|semarang|tangerang|bekasi|batam'],
  ['PH', 'Philippines', 'sg', 'sea', 0, 'philippines|pilipinas', 'manila|makati|quezon city|cebu|cebu city|taguig|pasig|davao|bonifacio global city|iloilo|mandaluyong'],
  ['TH', 'Thailand', 'sg', 'sea', 0, 'thailand', 'bangkok|chiang mai|phuket|pattaya|nonthaburi'],
  ['VN', 'Vietnam', 'sg', 'sea', 0, 'vietnam|viet nam', 'hanoi|ha noi|ho chi minh city|ho chi minh|saigon|da nang|haiphong|hai phong'],
  ['KH', 'Cambodia', 'sg', 'sea', 0, 'cambodia|kampuchea', 'phnom penh|siem reap'],
  ['LA', 'Laos', 'sg', 'sea', 0, "laos|lao pdr|lao people's democratic republic", 'vientiane'],
  ['MM', 'Myanmar', 'sg', 'sea', 0, 'myanmar|burma', 'yangon|rangoon|naypyidaw|mandalay'],
  ['BN', 'Brunei', 'sg', 'sea', 0, 'brunei|brunei darussalam', 'bandar seri begawan'],
  ['TL', 'Timor-Leste', 'sg', 'sea', 0, 'timor-leste|timor leste|east timor', 'dili'],
  ['CN', 'China', 'sg', 'east_asia', 0, "china|people's republic of china|mainland china|prc",
    "beijing|shanghai|shenzhen|guangzhou|hangzhou|chengdu|wuhan|nanjing|xi'an|suzhou|tianjin|chongqing|qingdao|dalian|xiamen|dongguan|ningbo|hefei|changsha"],
  ['TW', 'Taiwan', 'sg', 'east_asia', 0, 'taiwan', 'taipei|new taipei|hsinchu|taichung|kaohsiung|tainan|taoyuan'],
  ['JP', 'Japan', 'sg', 'east_asia', 0, 'japan|nippon|nihon', 'tokyo|osaka|kyoto|yokohama|nagoya|fukuoka|sapporo|kobe|kawasaki|sendai'],
  ['KR', 'South Korea', 'sg', 'east_asia', 0, 'south korea|republic of korea|korea', 'seoul|busan|incheon|pangyo|seongnam|daegu|daejeon|suwon|gwangju'],
  ['KP', 'North Korea', 'sg', 'east_asia', 0, "north korea|dprk|democratic people's republic of korea", 'pyongyang'],
  // ── Oceania ──
  ['AU', 'Australia', 'uk_au', 'anglo2', 1,
    'australia|commonwealth of australia|new south wales|queensland|western australia|south australia|tasmania|australian capital territory|victoria australia',
    'sydney|north sydney|melbourne|brisbane|perth|adelaide|canberra|gold coast|hobart|darwin|parramatta|newcastle nsw'],
  ['NZ', 'New Zealand', 'uk_au', 'anglo2', 1, 'new zealand|aotearoa', 'auckland|wellington|christchurch|dunedin|tauranga|hamilton new zealand'],
  ['FJ', 'Fiji', 'uk_au', 'anglo2', 0, 'fiji', 'suva|nadi'],
  ['PG', 'Papua New Guinea', 'uk_au', 'anglo2', 0, 'papua new guinea', 'port moresby'],
  ['WS', 'Samoa', 'uk_au', 'anglo2', 0, 'samoa', 'apia'],
  ['TO', 'Tonga', 'uk_au', 'anglo2', 0, 'tonga', ''],
  ['VU', 'Vanuatu', 'uk_au', 'anglo2', 0, 'vanuatu', 'port vila'],
  ['SB', 'Solomon Islands', 'uk_au', 'anglo2', 0, 'solomon islands', 'honiara'],
  ['NC', 'New Caledonia', 'eu', 'franco', 0, 'new caledonia|nouvelle-caledonie', 'noumea'],
  ['PF', 'French Polynesia', 'eu', 'franco', 0, 'french polynesia|polynesie francaise', 'papeete'],
];

// ccTLDs sold as vanity domains (.io, .ai, .co, .me, .tv…) say nothing about where an employer is.
const VANITY_TLDS = new Set([
  'ac', 'ag', 'ai', 'am', 'as', 'bz', 'cc', 'cf', 'co', 'cx', 'dj', 'fm', 'ga', 'gg', 'gl', 'gq', 'io', 'la',
  'ly', 'md', 'me', 'ml', 'ms', 'nu', 'pw', 'sh', 'so', 'st', 'tk', 'tm', 'to', 'tv', 'vc', 'vg', 'ws',
]);
// US state (and DC/PR) postal codes. Half are ISO country codes too — a trailing one is never trusted.
const US_STATE_CODES = new Set(('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH '
  + 'NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR').split(' '));
const ISO3 = {
  USA: 'US', GBR: 'GB', DEU: 'DE', AUT: 'AT', CHE: 'CH', FRA: 'FR', NLD: 'NL', BEL: 'BE', ESP: 'ES', PRT: 'PT',
  ITA: 'IT', IRL: 'IE', SWE: 'SE', NOR: 'NO', DNK: 'DK', FIN: 'FI', POL: 'PL', IND: 'IN', PAK: 'PK', BGD: 'BD',
  SGP: 'SG', MYS: 'MY', AUS: 'AU', NZL: 'NZ', CAN: 'CA', MEX: 'MX', BRA: 'BR', ARG: 'AR', MAR: 'MA', TUN: 'TN',
  DZA: 'DZ', EGY: 'EG', GHA: 'GH', NGA: 'NG', KEN: 'KE', ZAF: 'ZA', ARE: 'AE', UAE: 'AE', SAU: 'SA', KSA: 'SA',
  QAT: 'QA', KWT: 'KW', BHR: 'BH', OMN: 'OM', TUR: 'TR', ISR: 'IL', JPN: 'JP', KOR: 'KR', CHN: 'CN', HKG: 'HK',
  PHL: 'PH', IDN: 'ID', THA: 'TH', VNM: 'VN', RUS: 'RU', UKR: 'UA', ROU: 'RO', CZE: 'CZ', HUN: 'HU', GRC: 'GR',
};

// ── Text folding ──────────────────────────────────────────────────────────────
const FOLD_CHARS = { 'ø': 'o', 'æ': 'ae', 'ł': 'l', 'đ': 'd', 'ß': 'ss', 'ı': 'i', 'œ': 'oe', 'þ': 'th', 'ð': 'd' };
/** Lower-case, accents stripped, list punctuation → spaces; dots, hyphens and apostrophes kept. */
function fold(text) {
  return String(text == null ? '' : text)
    .slice(0, 500)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[øæłđßıœþð]/g, (ch) => FOLD_CHARS[ch])
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[,;:/|()[\]{}_*"<>!?+#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function wordsRe(list) {
  const parts = [...new Set(String(list || '').split('|').map((a) => fold(a)).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe);
  return parts.length ? new RegExp(`(?<![a-z0-9])(?:${parts.join('|')})(?![a-z0-9])`, 'g') : null;
}

// ── Compiled table ────────────────────────────────────────────────────────────
const COUNTRIES = COUNTRY_ROWS.map(([iso2, name, region, profile, home, aliases, places]) => ({
  iso2, name, region, profile, home: !!home, nameRe: wordsRe(aliases), placeRe: wordsRe(places),
}));
const BY_ISO2 = new Map(COUNTRIES.map((c) => [c.iso2, c]));
const EXACT = new Map(); // folded whole-string label → country
for (const [iso2, name, , , , aliases] of COUNTRY_ROWS) {
  for (const a of [name, ...String(aliases).split('|')]) { const k = fold(a); if (k && !EXACT.has(k)) EXACT.set(k, BY_ISO2.get(iso2)); }
}
// Labels that are a country only when they stand alone ("Georgia" the country vs "Atlanta, Georgia";
// "America" alone vs "Latin America"; "Jersey" vs "New Jersey").
EXACT.set('georgia', BY_ISO2.get('GE'));
EXACT.set('america', BY_ISO2.get('US'));
EXACT.set('jersey', BY_ISO2.get('JE'));
EXACT.set('us', BY_ISO2.get('US'));
EXACT.set('gb', BY_ISO2.get('GB'));
const AMBIGUOUS_NAMES = new Set(['georgia']); // a US state inside a longer string — unless a Georgian city says otherwise

/** The public view of a table row (a copy: callers can never edit the table). */
const viewOf = (c) => (c ? { iso2: c.iso2, name: c.name, region: c.region, profile: c.profile, home: c.home } : null);

// ── countryOf ─────────────────────────────────────────────────────────────────
/**
 * The one country a free-text country / location / address names, or null.
 *   'Zürich, Switzerland' → CH · 'Casablanca' → MA · 'UAE' → AE · 'Palo Alto, CA, US, 94304' → US
 *   'Remote' / 'Europe' / '' → null (regionLabelOf reads the region words).
 */
function countryOf(text) {
  if (typeof text !== 'string') return null;
  const original = text.slice(0, 500).trim();
  const s = fold(original);
  if (!s) return null;

  // 1) The whole string is a label: a name, an alias, an uppercase ISO-2 / ISO-3 code.
  const exact = EXACT.get(s.replace(/[.\s-]+$/, ''));
  if (exact) return viewOf(exact);
  const bare = original.replace(/\.$/, '');
  if (/^[A-Z]{2}$/.test(bare) && bare !== 'NA' && BY_ISO2.has(bare)) return viewOf(BY_ISO2.get(bare));
  if (/^[A-Z]{3}$/.test(bare) && ISO3[bare]) return viewOf(BY_ISO2.get(ISO3[bare]));

  // 2) Every word-bounded mention; a mention inside a longer one is not a mention.
  const hits = [];
  for (const c of COUNTRIES) {
    if (c.nameRe) for (const m of s.matchAll(c.nameRe)) hits.push({ c, level: 2, start: m.index, end: m.index + m[0].length, text: m[0] });
    if (c.placeRe) for (const m of s.matchAll(c.placeRe)) hits.push({ c, level: 1, start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  // "US" written as a word in capitals ("Remote - US"); lower-case "us" is an English word.
  const US = BY_ISO2.get('US');
  for (const m of original.matchAll(/(?<![A-Za-z0-9])US(?![A-Za-z0-9])/g)) {
    const end = fold(original.slice(0, m.index + 2)).length; // the folded prefix ends with this "us"
    hits.push({ c: US, level: 2, start: end - 2, end, text: 'us' });
  }
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.start <= h.start && o.end >= h.end
    && (o.end - o.start) > (h.end - h.start)));
  const last = (list) => list.slice().sort((a, b) => (b.end - a.end) || ((b.end - b.start) - (a.end - a.start)))[0];
  const places = kept.filter((h) => h.level === 1);

  let best = last(kept.filter((h) => h.level === 2));
  if (best && AMBIGUOUS_NAMES.has(best.text)) {
    const other = kept.filter((h) => h.level === 2 && !AMBIGUOUS_NAMES.has(h.text));
    const georgianPlace = places.find((h) => h.c.iso2 === 'GE');
    if (other.length) best = last(other);
    else if (georgianPlace) return viewOf(georgianPlace.c);
  }
  if (best) return viewOf(best.c);

  // 3) A trailing uppercase country code that cannot be a US state ("Leeds, GB", "Lagos, NG, 100001").
  const parts = original.split(/[,;|/()]+/).map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (/\d/.test(p)) continue; // a postcode
    if (/^[A-Z]{2}$/.test(p)) { if (!US_STATE_CODES.has(p) && p !== 'NA' && BY_ISO2.has(p)) return viewOf(BY_ISO2.get(p)); }
    else if (/^[A-Z]{3}$/.test(p) && ISO3[p]) return viewOf(BY_ISO2.get(ISO3[p]));
    break;
  }

  // 4) A city or area, last mention wins.
  const place = last(places);
  return place ? viewOf(place.c) : null;
}

// ── regionLabelOf ─────────────────────────────────────────────────────────────
// Region words, read only when no country is named. Ordered: "south asia" before "asia", "north
// africa" before the rest. A bare "Africa" or "Global" is not a convention.
const REGION_LABELS = [
  [/(?<![a-z])dach(?![a-z])/, 'dach'],
  [/(?<![a-z])(north america)(?![a-z])/, 'us_ca'],
  [/(?<![a-z])(latin america|latam|south america|central america)(?![a-z])/, 'eu'],
  [/(?<![a-z])(middle east|mena|gcc|arabian gulf|persian gulf|maghreb|north africa)(?![a-z])/, 'eu'],
  [/(?<![a-z])(south asia|indian subcontinent)(?![a-z])/, 'india'],
  [/(?<![a-z])(east africa)(?![a-z])/, 'uk_au'],
  [/(?<![a-z])(oceania|australasia|anz)(?![a-z])/, 'uk_au'],
  [/(?<![a-z])(europe|european union|eu|eea|emea|nordics?|scandinavia|benelux|baltics?|balkans|iberia)(?![a-z])/, 'eu'],
  [/(?<![a-z])(apac|asia-pacific|asia pacific|southeast asia|south-east asia|east asia|asean|greater china|asia)(?![a-z])/, 'sg'],
];
function regionLabelOf(text) {
  const s = fold(text);
  if (!s) return null;
  for (const [re, region] of REGION_LABELS) if (re.test(s)) return region;
  return null;
}

// ── regionFromCountry ─────────────────────────────────────────────────────────
/**
 * Free-text country / address → region id. 'generic' when nothing is recognised (same contract as
 * before: a TRUTHY string, so callers that want a fallback must test for 'generic', not falsiness).
 */
function regionFromCountry(text) {
  const c = countryOf(typeof text === 'string' ? text : '');
  if (c) return c.region;
  return regionLabelOf(typeof text === 'string' ? text : '') || 'generic';
}

// ── TLD ───────────────────────────────────────────────────────────────────────
/** 'https://www.acme.com.gh/careers' / 'jobs@acme.ma' → 'gh' / 'ma'; '' when there is no host. */
function tldOf(urlOrEmail) {
  let s = (typeof urlOrEmail === 'string' ? urlOrEmail : '').toLowerCase().trim();
  if (!s) return '';
  if (s.includes('@')) s = s.split('@').pop();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').split(/[/:?#]/)[0].replace(/\.+$/, '');
  const labels = s.split('.').filter(Boolean);
  return labels.length >= 2 ? labels.pop() : '';
}

/** The country a website's / email's ccTLD names, or null (.com, vanity ccTLDs, .eu). */
function countryFromTld(urlOrEmail) {
  const tld = tldOf(urlOrEmail);
  if (!tld || tld.length !== 2 || VANITY_TLDS.has(tld)) return null;
  const code = tld === 'uk' ? 'GB' : tld === 'su' ? 'RU' : tld.toUpperCase();
  return viewOf(BY_ISO2.get(code));
}

/**
 * ccTLD → region (the ALWAYS-available fallback when an address is empty or a placeholder). With
 * `conventions` (employerResearch conventions), a TLD that names no country (.com, .org, .jobs, .io)
 * falls back through conventions.hqCountry — "deutschebahn.com" is still a German employer.
 */
function regionFromTld(urlOrEmail, conventions) {
  const byTld = countryFromTld(urlOrEmail);
  if (byTld) return byTld.region;
  if (tldOf(urlOrEmail) === 'eu') return 'eu';
  const hq = conventions && typeof conventions === 'object' ? countryOf(conventions.hqCountry) : null;
  return hq ? hq.region : 'generic';
}

// ── resolveRegion ─────────────────────────────────────────────────────────────
/**
 * THE region chain, shared by designFit.regionFor and employerResearch.regionForConventions:
 *   1. the caller's own country, when it names one (a posting's country is the ROLE's location);
 *   2. the research's role country (where this employer hires, when that is one country);
 *   3. the website's ccTLD (.ch, .ma, .com.gh — the site the user picked);
 *   4. the research's HQ country ("deutschebahn.com" → Germany);
 *   5. the caller's country as a region word ("Europe", "APAC");
 *   6. 'generic'.
 * Specific beats general at every step: a posting in Germany at a US company is read by a German team.
 */
function resolveRegion({ country = null, website = null, conventions = null } = {}) {
  const conv = conventions && typeof conventions === 'object' && !Array.isArray(conventions) ? conventions : null;
  const own = countryOf(typeof country === 'string' ? country : '');
  if (own) return own.region;
  const role = conv ? countryOf(conv.roleCountry) : null;
  if (role) return role.region;
  const byTld = countryFromTld(website);
  if (byTld) return byTld.region;
  if (tldOf(website) === 'eu') return 'eu';
  const hq = conv ? countryOf(conv.hqCountry) : null;
  if (hq) return hq.region;
  return regionLabelOf(typeof country === 'string' ? country : '') || 'generic';
}

/**
 * The same chain for the COUNTRY whose CV habits apply (steps 1-4), or null. designFit reads its
 * profile as soft defaults; a country whose region is not the one being ranked for is not used.
 */
function placeFor({ country = null, website = null, conventions = null } = {}) {
  const conv = conventions && typeof conventions === 'object' && !Array.isArray(conventions) ? conventions : null;
  return countryOf(typeof country === 'string' ? country : '')
    || (conv ? countryOf(conv.roleCountry) : null)
    || countryFromTld(website)
    || (conv ? countryOf(conv.hqCountry) : null)
    || null;
}

/** A copy of the CV profile for a country view (from countryOf) or a region id; null when none applies. */
function cvDefaultsFor(placeOrRegion) {
  const p = placeOrRegion && typeof placeOrRegion === 'object'
    ? CV_PROFILES[placeOrRegion.profile]
    : REGION_PROFILES[placeOrRegion];
  return p ? { ...p } : null;
}

module.exports = {
  regionFromCountry,
  regionFromTld,
  // every-country helpers (2026-09-14)
  countryOf,
  countryFromTld,
  regionLabelOf,
  resolveRegion,
  placeFor,
  cvDefaultsFor,
  REGION_IDS,
  // exposed for tests / diagnostics only
  _internals: { fold, tldOf, COUNTRY_ROWS, CV_PROFILES, REGION_PROFILES, VANITY_TLDS },
};
