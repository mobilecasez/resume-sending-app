// Server-side mirror of MobileApp/regionUtils.js regionFromCountry — maps a free-text
// country/address to a template region id (generic, us_ca, uk_au, india, dach, eu, sg).
// Used by the batch send path so "Send All" honours the same region as single sends.
function regionFromCountry(text) {
  const s = (text || '').toLowerCase();
  if (!s.trim()) return 'generic';
  const has = (...k) => k.some(x => s.includes(x));

  // North America
  if (has('united states', 'usa', 'u.s.a', 'u.s.', 'america', 'canada', 'toronto', 'vancouver',
          'new york', 'san francisco', 'california', 'texas', 'seattle', 'boston') || /\bus\b/.test(s)) return 'us_ca';
  // UK / Australia / NZ
  if (has('united kingdom', 'england', 'scotland', 'wales', 'britain', 'london', 'manchester',
          'australia', 'sydney', 'melbourne', 'brisbane', 'new zealand', 'auckland') || /\buk\b/.test(s)) return 'uk_au';
  // India / South Asia
  if (has('india', 'bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai',
          'gurugram', 'gurgaon', 'noida', 'kolkata', 'ahmedabad', 'bangladesh', 'nepal', 'sri lanka', 'pakistan')) return 'india';
  // Germany / DACH
  if (has('germany', 'deutschland', 'berlin', 'munich', 'münchen', 'frankfurt', 'hamburg', 'cologne', 'stuttgart',
          'austria', 'österreich', 'vienna', 'wien', 'switzerland', 'zurich', 'zürich', 'geneva', 'basel')) return 'dach';
  // Europe / EU
  if (has('france', 'paris', 'spain', 'madrid', 'barcelona', 'italy', 'rome', 'milan', 'milano',
          'netherlands', 'amsterdam', 'belgium', 'brussels', 'ireland', 'dublin', 'portugal', 'lisbon',
          'sweden', 'stockholm', 'poland', 'warsaw', 'denmark', 'norway', 'finland', 'europe')) return 'eu';
  // Singapore / APAC hubs
  if (has('singapore')) return 'sg';

  return 'generic';
}

// ccTLD → region, from the employer website or recruiter email domain. An ALWAYS-available fallback
// when the scraped address is empty/placeholder (mirror of MobileApp/regionUtils.js regionFromTld).
const TLD_REGION = {
  de: 'dach', at: 'dach', ch: 'dach',
  nl: 'eu', be: 'eu', fr: 'eu', es: 'eu', it: 'eu', ie: 'eu', pt: 'eu', se: 'eu', pl: 'eu',
  dk: 'eu', no: 'eu', fi: 'eu', eu: 'eu', lu: 'eu', cz: 'eu', gr: 'eu', ro: 'eu', hu: 'eu', sk: 'eu', is: 'eu',
  in: 'india', uk: 'uk_au', au: 'uk_au', nz: 'uk_au', sg: 'sg', us: 'us_ca', ca: 'us_ca',
};
function regionFromTld(urlOrEmail) {
  let s = (urlOrEmail || '').toLowerCase().trim();
  if (!s) return 'generic';
  if (s.includes('@')) s = s.split('@').pop();
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[\/:?#]/)[0];
  const tld = s.split('.').filter(Boolean).pop();
  return TLD_REGION[tld] || 'generic';
}

module.exports = { regionFromCountry, regionFromTld };
