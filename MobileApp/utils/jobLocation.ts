// AI Hub — new feature. Safe to delete without affecting existing app.
// Resolve a free-text location ("delhi ncr", "bangalore", "london") into a LinkedIn-RECOGNIZABLE
// "City, Country" string plus match-terms for filtering results by relevance.
//
// WHY: LinkedIn's public guest jobs API silently resolves an unqualified place to the WRONG location —
// verified: location="Delhi" and "Delhi NCR" both return **Cincinnati, OH** jobs, while "Delhi, India"
// returns real Delhi jobs (9/9). So every location MUST be country-qualified before it hits LinkedIn,
// and results are then filtered so any stray wrong-country card is dropped.

export type ResolvedLocation = {
  linkedInLocation: string;   // country-qualified string for LinkedIn's `location=` param ('' → omit)
  country: string | null;     // canonical country display name, if detected
  hasLocation: boolean;       // the user actually specified a place
};

// Canonical country → its major job-market cities (lowercase). India is most thorough (active market).
const COUNTRY_CITIES: Record<string, string[]> = {
  India: ['delhi', 'new delhi', 'noida', 'gurgaon', 'gurugram', 'ghaziabad', 'faridabad', 'greater noida',
    'mumbai', 'bombay', 'navi mumbai', 'thane', 'pune', 'bangalore', 'bengaluru', 'hyderabad', 'secunderabad',
    'chennai', 'madras', 'kolkata', 'calcutta', 'ahmedabad', 'gandhinagar', 'jaipur', 'chandigarh', 'mohali',
    'indore', 'bhopal', 'kochi', 'cochin', 'ernakulam', 'coimbatore', 'nagpur', 'lucknow', 'kanpur', 'surat',
    'vadodara', 'visakhapatnam', 'vizag', 'thiruvananthapuram', 'trivandrum', 'bhubaneswar', 'mysore', 'mysuru',
    'nashik', 'rajkot', 'patna', 'ranchi', 'dehradun', 'guwahati', 'raipur', 'jodhpur', 'udaipur', 'trichy',
    'tiruchirappalli', 'madurai', 'vijayawada', 'mangalore', 'goa', 'jamshedpur', 'amritsar', 'ludhiana'],
  'United States': ['new york', 'nyc', 'brooklyn', 'manhattan', 'san francisco', 'bay area', 'silicon valley',
    'los angeles', 'san diego', 'san jose', 'sunnyvale', 'mountain view', 'palo alto', 'seattle', 'bellevue',
    'chicago', 'austin', 'dallas', 'houston', 'san antonio', 'boston', 'cambridge', 'atlanta', 'denver',
    'boulder', 'miami', 'orlando', 'tampa', 'washington', 'arlington', 'philadelphia', 'phoenix', 'tempe',
    'portland', 'cincinnati', 'columbus', 'cleveland', 'detroit', 'minneapolis', 'charlotte', 'raleigh',
    'durham', 'nashville', 'pittsburgh', 'salt lake city', 'kansas city', 'st louis', 'indianapolis',
    'mason', 'west chester', 'plano', 'irvine', 'santa clara', 'redmond'],
  'United Kingdom': ['london', 'manchester', 'birmingham', 'leeds', 'edinburgh', 'glasgow', 'bristol',
    'liverpool', 'sheffield', 'cardiff', 'belfast', 'cambridge', 'oxford', 'reading', 'nottingham',
    'newcastle', 'leicester', 'coventry', 'brighton', 'milton keynes'],
  Canada: ['toronto', 'vancouver', 'montreal', 'calgary', 'ottawa', 'edmonton', 'winnipeg', 'quebec',
    'quebec city', 'waterloo', 'mississauga', 'brampton', 'hamilton', 'halifax', 'victoria', 'kitchener'],
  Australia: ['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'canberra', 'gold coast', 'newcastle',
    'wollongong', 'hobart'],
  Germany: ['berlin', 'munich', 'münchen', 'muenchen', 'frankfurt', 'hamburg', 'cologne', 'köln', 'koeln',
    'stuttgart', 'düsseldorf', 'dusseldorf', 'leipzig', 'dortmund', 'nuremberg', 'nürnberg', 'bremen', 'essen'],
  France: ['paris', 'lyon', 'marseille', 'toulouse', 'lille', 'bordeaux', 'nantes', 'nice', 'strasbourg',
    'grenoble', 'montpellier'],
  Netherlands: ['amsterdam', 'rotterdam', 'the hague', 'den haag', 'utrecht', 'eindhoven', 'groningen', 'delft'],
  Ireland: ['dublin', 'cork', 'galway', 'limerick'],
  Spain: ['madrid', 'barcelona', 'valencia', 'seville', 'sevilla', 'bilbao', 'malaga', 'zaragoza'],
  Italy: ['rome', 'roma', 'milan', 'milano', 'turin', 'torino', 'naples', 'bologna', 'florence', 'firenze'],
  Poland: ['warsaw', 'warszawa', 'krakow', 'kraków', 'wroclaw', 'wrocław', 'gdansk', 'gdańsk', 'poznan', 'lodz'],
  Switzerland: ['zurich', 'zürich', 'geneva', 'genève', 'basel', 'bern', 'lausanne', 'lugano'],
  Sweden: ['stockholm', 'gothenburg', 'göteborg', 'malmö', 'malmo', 'uppsala'],
  'United Arab Emirates': ['dubai', 'abu dhabi', 'sharjah', 'ajman'],
  Singapore: ['singapore'],
  'Hong Kong': ['hong kong'],
  Japan: ['tokyo', 'osaka', 'kyoto', 'yokohama', 'nagoya', 'fukuoka'],
  China: ['beijing', 'shanghai', 'shenzhen', 'guangzhou', 'hangzhou', 'chengdu'],
  Brazil: ['sao paulo', 'são paulo', 'rio de janeiro', 'brasilia', 'belo horizonte', 'porto alegre'],
  Mexico: ['mexico city', 'guadalajara', 'monterrey', 'ciudad de mexico'],
  Philippines: ['manila', 'makati', 'cebu', 'taguig', 'quezon city'],
  Indonesia: ['jakarta', 'bandung', 'surabaya'],
  Malaysia: ['kuala lumpur', 'penang', 'cyberjaya', 'petaling jaya'],
  'South Africa': ['johannesburg', 'cape town', 'durban', 'pretoria'],
  Nigeria: ['lagos', 'abuja', 'ibadan'],
  Kenya: ['nairobi', 'mombasa'],
  Egypt: ['cairo', 'alexandria', 'giza'],
  'Saudi Arabia': ['riyadh', 'jeddah', 'dammam', 'khobar'],
  Israel: ['tel aviv', 'jerusalem', 'haifa', 'herzliya'],
  Turkey: ['istanbul', 'ankara', 'izmir'],
  'New Zealand': ['auckland', 'wellington', 'christchurch'],
};

// Indian states/UTs → India (so "…, Rajasthan" / "…, Karnataka" still resolve to India).
const INDIA_STATES = ['andhra pradesh', 'arunachal', 'assam', 'bihar', 'chhattisgarh', 'goa', 'gujarat',
  'haryana', 'himachal', 'jharkhand', 'karnataka', 'kerala', 'madhya pradesh', 'maharashtra', 'manipur',
  'meghalaya', 'mizoram', 'nagaland', 'odisha', 'punjab', 'rajasthan', 'sikkim', 'tamil nadu', 'telangana',
  'tripura', 'uttar pradesh', 'uttarakhand', 'west bengal', 'delhi ncr', 'ncr'];

// Country name / abbreviation aliases → canonical display name.
const COUNTRY_ALIASES: Record<string, string> = {
  india: 'India', bharat: 'India',
  usa: 'United States', us: 'United States', 'u.s.': 'United States', 'u.s.a.': 'United States',
  america: 'United States', 'united states': 'United States', 'united states of america': 'United States',
  uk: 'United Kingdom', 'u.k.': 'United Kingdom', britain: 'United Kingdom', 'great britain': 'United Kingdom',
  england: 'United Kingdom', scotland: 'United Kingdom', wales: 'United Kingdom', 'united kingdom': 'United Kingdom',
  canada: 'Canada', australia: 'Australia', 'aus': 'Australia',
  germany: 'Germany', deutschland: 'Germany', france: 'France', netherlands: 'Netherlands', holland: 'Netherlands',
  ireland: 'Ireland', spain: 'Spain', españa: 'Spain', italy: 'Italy', italia: 'Italy', poland: 'Poland',
  polska: 'Poland', switzerland: 'Switzerland', sweden: 'Sweden',
  uae: 'United Arab Emirates', 'u.a.e.': 'United Arab Emirates', emirates: 'United Arab Emirates',
  'united arab emirates': 'United Arab Emirates',
  singapore: 'Singapore', 'hong kong': 'Hong Kong', hk: 'Hong Kong', japan: 'Japan', china: 'China',
  brazil: 'Brazil', brasil: 'Brazil', mexico: 'Mexico', méxico: 'Mexico', philippines: 'Philippines',
  indonesia: 'Indonesia', malaysia: 'Malaysia', 'south africa': 'South Africa', nigeria: 'Nigeria',
  kenya: 'Kenya', egypt: 'Egypt', 'saudi arabia': 'Saudi Arabia', ksa: 'Saudi Arabia', israel: 'Israel',
  turkey: 'Turkey', türkiye: 'Turkey', 'new zealand': 'New Zealand', nz: 'New Zealand',
};

// The Delhi NCR metro — a search for any of these means "the NCR", so accept them all when filtering.
const NCR_CITIES = ['delhi', 'new delhi', 'noida', 'greater noida', 'gurgaon', 'gurugram', 'ghaziabad', 'faridabad', 'ncr'];

// Build a reverse city → country lookup once.
const CITY_TO_COUNTRY: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [country, cities] of Object.entries(COUNTRY_CITIES)) for (const c of cities) if (!m[c]) m[c] = country;
  for (const s of INDIA_STATES) if (!m[s]) m[s] = 'India';
  return m;
})();

const REMOTE_RE = /\b(remote|anywhere|work from home|wfh|worldwide|global)\b/i;
const titleCase = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase());

// Resolve a raw location string → { linkedInLocation, country, hasLocation }.
export function resolveLiveLocation(rawLoc: string): ResolvedLocation {
  const raw = String(rawLoc || '').trim();
  if (!raw) return { linkedInLocation: '', country: null, hasLocation: false };
  // Remote / worldwide → treat as no geographic filter (relevant anywhere).
  if (REMOTE_RE.test(raw) && raw.replace(REMOTE_RE, '').replace(/[,\s]+/g, '').length < 3) {
    return { linkedInLocation: '', country: null, hasLocation: true };
  }
  const lower = raw.toLowerCase();
  const parts = lower.split(/[,/|]| in | near /).map((p) => p.trim()).filter(Boolean);

  // Detect country: explicit country/alias anywhere, else infer from a recognized city/state token.
  let country: string | null = null;
  for (const p of parts) { if (COUNTRY_ALIASES[p]) { country = COUNTRY_ALIASES[p]; break; } }
  if (!country) for (const p of parts) { if (CITY_TO_COUNTRY[p]) { country = CITY_TO_COUNTRY[p]; break; } }
  // token-level (handles "noida sector 62", "south delhi")
  if (!country) {
    const toks = lower.split(/\s+/);
    for (const t of toks) { if (COUNTRY_ALIASES[t]) { country = COUNTRY_ALIASES[t]; break; } if (CITY_TO_COUNTRY[t]) { country = CITY_TO_COUNTRY[t]; break; } }
  }

  const isNcr = /\bncr\b|national capital region/.test(lower) || (country === 'India' && /\bdelhi\b/.test(lower));

  // Build the LinkedIn location string (must be country-qualified).
  const cityPart = raw.replace(/\bncr\b/gi, '').replace(/national capital region/gi, '').replace(/[,/|]+\s*$/, '').replace(/\s+/g, ' ').trim();
  const cityLower = cityPart.toLowerCase();
  const cityIsCountry = !cityPart || cityLower === country?.toLowerCase() || COUNTRY_ALIASES[cityLower] === country;
  let linkedInLocation = raw;
  if (country) {
    const hasCountryWord = parts.some((p) => COUNTRY_ALIASES[p] === country) || lower.includes(country.toLowerCase());
    if (isNcr) linkedInLocation = 'New Delhi, Delhi, India';
    else if (cityIsCountry) linkedInLocation = country;
    else if (hasCountryWord) linkedInLocation = titleCase(cityPart);
    else linkedInLocation = titleCase(cityPart) + ', ' + country;
  }

  return { linkedInLocation, country, hasLocation: true };
}

// Detect which country a location STRING belongs to (from a country name/alias or a recognized city),
// or null if unknown. Token/bigram lookup → fast enough to run per result card.
export function detectLocationCountry(loc: string | null | undefined): string | null {
  const s = String(loc || '').toLowerCase();
  if (!s.trim()) return null;
  for (const [alias, disp] of Object.entries(COUNTRY_ALIASES)) {
    if (alias.length < 4) continue;   // skip ambiguous 2–3 char aliases (us/uk/hk/nz) that hit substrings
    if (s.includes(alias)) return disp;
  }
  const toks = s.split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    if (CITY_TO_COUNTRY[toks[i]]) return CITY_TO_COUNTRY[toks[i]];
    if (i + 1 < toks.length) { const bg = toks[i] + ' ' + toks[i + 1]; if (CITY_TO_COUNTRY[bg]) return CITY_TO_COUNTRY[bg]; }
  }
  return null;
}

// Should a result card be kept for a location-scoped search?
//  • no location / no detected country in the search → keep everything (nothing to enforce)
//  • card has no location, or is remote/anywhere       → keep
//  • card's location resolves to a DIFFERENT country    → DROP (this is the "Cincinnati for Delhi" bug)
//  • same country, or card country unknown              → keep (never over-drop)
export function locationAllowed(cardLocation: string | null | undefined, resolved: ResolvedLocation): boolean {
  if (!resolved || !resolved.hasLocation || !resolved.country) return true;
  const s = String(cardLocation || '').toLowerCase().trim();
  if (!s) return true;
  if (REMOTE_RE.test(s)) return true;
  const cc = detectLocationCountry(s);
  return !(cc && cc !== resolved.country);
}
