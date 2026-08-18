// AI Hub — new feature. Safe to delete without affecting existing app.
//
// ⚠️ THE SUGGESTION LISTS MUST WORK WITH NO SERVER. When the launcher shipped, its three endpoints
// were not deployed, every lookup fell through to an empty array, and the feature simply looked
// broken — you typed ".net" and nothing happened. A local list is not a nicety: it is what makes
// the field respond on the first keystroke, before any network call resolves. Server results are
// merged in on top when they arrive, because only the server knows our real job counts.

export type Suggestion = { label: string; sub?: string };

// Deliberately spans BOTH audiences. Production says the people who actually arrive want warehouse,
// security, driving and care work — while the catalogue is 39k software titles. A role list that
// only knew about engineers would tell a forklift driver this app is not for them.
const ROLES = [
  '.NET Developer', 'C# Developer', 'Java Developer', 'Python Developer', 'PHP Developer',
  'Full Stack Developer', 'Frontend Developer', 'Backend Developer', 'Mobile Developer',
  'Software Engineer', 'Senior Software Engineer', 'DevOps Engineer', 'Cloud Engineer',
  'Data Analyst', 'Data Engineer', 'Data Scientist', 'QA Engineer', 'Test Engineer',
  'Business Analyst', 'Project Manager', 'Product Manager', 'Scrum Master',
  'IT Support', 'System Administrator', 'Network Engineer', 'Security Analyst',
  'Accountant', 'Bookkeeper', 'Financial Analyst', 'Auditor',
  'Sales Executive', 'Sales Manager', 'Business Development Manager', 'Account Manager',
  'Customer Service Representative', 'Call Centre Agent', 'Receptionist',
  'Marketing Manager', 'Digital Marketing Specialist', 'Content Writer', 'Graphic Designer',
  'HR Manager', 'Recruiter', 'Office Administrator', 'Executive Assistant',
  'Warehouse Operative', 'Warehouse Manager', 'Forklift Operator', 'Storekeeper',
  'Logistics Coordinator', 'Supply Chain Manager', 'Delivery Driver', 'Truck Driver',
  'Security Guard', 'Security Officer', 'Lifeguard',
  'Nurse', 'Registered Nurse', 'Midwife', 'Caregiver', 'Care Assistant', 'Healthcare Assistant',
  'Pharmacist', 'Lab Technician', 'Medical Assistant',
  'Chef', 'Cook', 'Waiter', 'Barista', 'Bartender', 'Housekeeper', 'Cleaner',
  'Electrician', 'Plumber', 'Welder', 'Mechanic', 'Carpenter', 'Mason', 'Construction Worker',
  'Civil Engineer', 'Mechanical Engineer', 'Electrical Engineer', 'Site Supervisor',
  'Teacher', 'Tutor', 'Translator', 'Customer Success Manager',
];

// Big destination cities for jobseekers, with their country so the field always reads "City, Country".
const PLACES = [
  'Amsterdam, Netherlands', 'Rotterdam, Netherlands', 'The Hague, Netherlands',
  'London, UK', 'Manchester, UK', 'Birmingham, UK', 'Dublin, Ireland',
  'Berlin, Germany', 'Munich, Germany', 'Frankfurt, Germany', 'Hamburg, Germany',
  'Paris, France', 'Lyon, France', 'Madrid, Spain', 'Barcelona, Spain',
  'Lisbon, Portugal', 'Rome, Italy', 'Milan, Italy', 'Brussels, Belgium',
  'Zurich, Switzerland', 'Geneva, Switzerland', 'Vienna, Austria',
  'Stockholm, Sweden', 'Gothenburg, Sweden', 'Malmo, Sweden', 'Oslo, Norway',
  'Copenhagen, Denmark', 'Helsinki, Finland', 'Warsaw, Poland', 'Prague, Czechia',
  'Dubai, UAE', 'Abu Dhabi, UAE', 'Doha, Qatar', 'Riyadh, Saudi Arabia', 'Jeddah, Saudi Arabia',
  'Kuwait City, Kuwait', 'Manama, Bahrain', 'Muscat, Oman',
  'Toronto, Canada', 'Vancouver, Canada', 'Montreal, Canada',
  'New York, US', 'San Francisco, US', 'Austin, US', 'Chicago, US', 'Seattle, US',
  'Sydney, Australia', 'Melbourne, Australia', 'Auckland, New Zealand',
  'Singapore', 'Hong Kong', 'Tokyo, Japan', 'Seoul, South Korea',
  'Bangalore, India', 'Mumbai, India', 'Delhi, India', 'Hyderabad, India', 'Pune, India',
  'Chennai, India', 'Karachi, Pakistan', 'Lahore, Pakistan', 'Islamabad, Pakistan',
  'Manila, Philippines', 'Cebu, Philippines', 'Casablanca, Morocco', 'Tangier, Morocco',
  'Rabat, Morocco', 'Marrakesh, Morocco', 'Cairo, Egypt', 'Alexandria, Egypt',
  'Accra, Ghana', 'Lagos, Nigeria', 'Nairobi, Kenya', 'Beirut, Lebanon',
  'Johannesburg, South Africa', 'Cape Town, South Africa',
];

// Rank: prefix beats word-start beats substring, so typing "net" surfaces ".NET Developer" rather
// than "Network Engineer" only by accident of list order.
function rank(hay: string, q: string): number {
  const h = hay.toLowerCase();
  const i = h.indexOf(q);
  if (i < 0) return -1;
  if (i === 0) return 0;
  if (/[\s.\-,(]/.test(h[i - 1] || '')) return 1;
  return 2;
}

function match(list: string[], q: string, limit: number): Suggestion[] {
  const needle = q.trim().toLowerCase();
  if (needle.length < 1) return [];
  const hits: { label: string; r: number }[] = [];
  for (const label of list) {
    const r = rank(label, needle);
    if (r >= 0) hits.push({ label, r });
  }
  hits.sort((a, b) => a.r - b.r || a.label.length - b.label.length);
  return hits.slice(0, limit).map((h) => ({ label: h.label }));
}

export const localRoles = (q: string, limit = 8): Suggestion[] => match(ROLES, q, limit);
export const localPlaces = (q: string, limit = 8): Suggestion[] => match(PLACES, q, limit);

/** Server results first (they carry real counts); local fills the rest without duplicating. */
export function mergeSuggestions(server: Suggestion[], local: Suggestion[], limit = 8): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const s of [...server, ...local]) {
    const k = s.label.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Build the string we actually search for.
 * ⚠️ ".net" + "Amsterdam" was being sent as ".net in Amsterdam", which Google reads as prose and
 * answers with .NET documentation. It has to say ".net jobs in Amsterdam" — the word "jobs" is what
 * turns a topic into a job search. Added only when the role does not already say it.
 */
export function composeQuery(role: string, location: string): string {
  const r = role.trim().replace(/\s+/g, ' ');
  const l = location.trim().replace(/\s+/g, ' ');
  if (!r && !l) return '';
  const saysJobs = /\b(job|jobs|vacancy|vacancies|position|positions|hiring|career|careers)\b/i.test(r);
  if (!r) return `jobs in ${l}`;
  const head = saysJobs ? r : `${r} jobs`;
  return l ? `${head} in ${l}` : head;
}
