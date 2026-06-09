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
