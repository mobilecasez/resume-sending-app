// Shared region helpers for the cover-letter / resume region pickers.
// Region ids match the server REGIONS (generic, us_ca, uk_au, india, dach, eu, sg, global).
// Used by App.js (send-time auto-detect) and components/ReviewScreen.js (the dropdowns).

// Map a free-text country / address string to a template region id.
export function regionFromCountry(text) {
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

// ── Robust region resolution for the SEND flows ──────────────────────────────
// The cover-letter object carries the employer's offices in `locations[]`, NOT a flat `address`,
// so reading coverLetter.address alone yields '' → always 'generic'. Resolve the real address from
// locations[], and fall back to the website / recruiter-email ccTLD (.nl→eu, .de→dach, .in→india…)
// which is ALWAYS available even when the scraped address is a placeholder ("Address not available").
const TLD_REGION = {
  de: 'dach', at: 'dach', ch: 'dach',
  nl: 'eu', be: 'eu', fr: 'eu', es: 'eu', it: 'eu', ie: 'eu', pt: 'eu', se: 'eu', pl: 'eu',
  dk: 'eu', no: 'eu', fi: 'eu', eu: 'eu', lu: 'eu', cz: 'eu', gr: 'eu', ro: 'eu', hu: 'eu', sk: 'eu', is: 'eu',
  in: 'india', uk: 'uk_au', au: 'uk_au', nz: 'uk_au', sg: 'sg', us: 'us_ca', ca: 'us_ca',
};
export function regionFromTld(urlOrEmail) {
  let s = (urlOrEmail || '').toLowerCase().trim();
  if (!s) return 'generic';
  if (s.includes('@')) s = s.split('@').pop();                         // email → domain
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[\/:?#]/)[0];   // url → host
  const tld = s.split('.').filter(Boolean).pop();
  return TLD_REGION[tld] || 'generic';
}
// Pull the employer's real address out of the cover-letter object (locations[] preferred).
export function employerAddress(coverLetter) {
  if (!coverLetter) return '';
  if (typeof coverLetter.address === 'string' && coverLetter.address.trim()) return coverLetter.address;
  if (typeof coverLetter.companyAddress === 'string' && coverLetter.companyAddress.trim()) return coverLetter.companyAddress;
  const locs = Array.isArray(coverLetter.locations) ? coverLetter.locations : [];
  const hq = locs.find((l) => l && l.isHeadquarters) || locs[0];
  if (!hq) return '';
  if (typeof hq === 'string') return hq;
  return [hq.address, hq.city, hq.country].filter((x) => x && !/not available|not specified/i.test(String(x))).join(', ');
}
// Auto-detected region for a send. Explicit user picks are honoured by the CALLER (saved override
// || bestRegion). Address first, then the website / recruiter-email ccTLD as a last resort.
export function bestRegion(coverLetter, recipient) {
  const loc = [employerAddress(coverLetter), recipient && (recipient.location || recipient.country)].filter(Boolean).join(', ');
  let r = regionFromCountry(loc);
  if (r === 'generic') r = regionFromTld((recipient && recipient.website) || (recipient && recipient.email) || (coverLetter && (coverLetter.companyWebsite || coverLetter.website)) || '');
  return r;
}

// Picker options (cover letter supports all eight; resume has no 'global' — it maps to generic server-side).
export const REGION_OPTIONS = [
  { id: 'generic', label: 'Generic',           sub: 'Original · any country' },
  { id: 'us_ca',   label: 'USA / Canada',      sub: 'Direct, achievement-based' },
  { id: 'uk_au',   label: 'UK / Australia',    sub: 'Professional, respectful' },
  { id: 'india',   label: 'India / South Asia', sub: 'Skills & projects' },
  { id: 'dach',    label: 'Germany / DACH',    sub: 'Formal, qualification-led' },
  { id: 'eu',      label: 'Europe / EU',       sub: 'Motivation & fit' },
  { id: 'sg',      label: 'Singapore',         sub: 'Corporate, concise' },
  { id: 'global',  label: 'Global / Entry',    sub: 'Graduate & entry-level' },
];

// Resume regions exclude 'global' (no distinct resume design — falls back to generic on the server).
export const RESUME_REGION_OPTIONS = REGION_OPTIONS.filter(r => r.id !== 'global');

export const regionLabel = (id) =>
  (REGION_OPTIONS.find(r => r.id === id) || REGION_OPTIONS[0]).label;
