// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Data for the employer-focused Home. The screen's promise is "one posting, one resume", so the
// employer chips must be REAL postings the user is chasing — not a demo list.
//
// Two stores hold them and they disagree on field names, so both are normalised here once:
//   • GET /ai-hub/dashboard      → tracked employers, jobs nested under `employer`, match =`matchScore`
//   • GET /discover/saved-jobs   → flat live-search cards,                          match =`match`
// A user typically has one or the other; merging means the chips are never empty for someone who
// has engaged with either surface.
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../config';

export type Target = {
  key: string;              // stable list key
  jobId: string | null;     // real UUID when we have one (dashboard jobs) — else null
  jobUrl?: string | null;   // saved cards are identified by URL
  employerId?: string | null;
  company: string;
  role: string;
  initial: string;
  colors: [string, string];
  match: number | null;     // 0-100, null = not scored yet
  skills: string[];
  location?: string;
  /** The posting's own URL — the identity the whole server agrees on. */
  applyUrl?: string | null;
};

export type HomeCard = { id: string; name: string; accent?: string; ats?: number | null; image?: string | null };

const AV: [string, string][] = [
  ['#4F8DFF', '#7C6BFF'], ['#7C6BFF', '#DB2777'], ['#7C6BFF', '#A855F7'],
  ['#06B6D4', '#3B82F6'], ['#10B981', '#06B6D4'], ['#F59E0B', '#EF4444'], ['#14B8A6', '#3B82F6'],
];
// Same hash the rest of the app uses for a stable per-company colour.
const gradFor = (s?: string): [string, string] => {
  let h = 0; const k = s || 'x';
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return AV[h % AV.length];
};
/** At most this many postings per employer in the chip row. */
const PER_EMPLOYER = 3;

/**
 * The posting's identity. Byte-identical to the server's own cleaner
 * (server/controllers/jobCaptureController.js cleanUrl, aiHubController.js) — do NOT 'improve' it,
 * because jobs.job_url carries a UNIQUE index built on exactly this shape.
 *
 * ⚠️ Chips are keyed on this rather than on job.id: an id is a real UUID only once a job is
 * persisted, and during an in-progress search the server hands back a synthetic
 * `${employerDbId}-job-${n}` that RENUMBERS as results stream in — keying on it re-mounts every
 * chip mid-search and drops the user's pinned selection.
 */
export const cleanJobUrl = (u?: string | null) => {
  try { const x = new URL(String(u)); return (x.origin + x.pathname).replace(/\/+$/, ''); }
  catch { return String(u || '').split('?')[0].split('#')[0].replace(/\/+$/, ''); }
};

const initialOf = (s?: string | null) => (s || '?').trim().charAt(0).toUpperCase();

async function token(): Promise<string | undefined> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    return JSON.parse(raw || '{}')?.token;
  } catch { return undefined; }
}
// `meta` reports the HTTP status back to the caller. It matters because a null here is ambiguous:
// it can mean "the server says there is nothing" OR "we never got an answer". Callers that act on
// the difference (see fetchHomeCards) must be able to tell them apart.
async function getJson(path: string, ms = 15000, meta?: { status?: number }): Promise<any | null> {
  const t = await token();
  if (!t) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${t}` }, signal: ctl.signal });
    if (meta) meta.status = r.status;
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/** The employer chips: best-matching open role per company, strongest match first. */
export async function fetchTargets(): Promise<Target[]> {
  const [dash, saved] = await Promise.all([
    getJson('/ai-hub/dashboard'),
    getJson('/discover/saved-jobs'),
  ]);
  const out: Target[] = [];

  // (A) tracked employers — one chip per POSTING, not per company. Two roles at the same employer
  // are two different applications: they want different resumes and different letters, so
  // "Airbus · Senior Software Engineer" and "Airbus · Team Lead" have to be separately selectable.
  // ⚠️ Capped per employer so one company with a large careers page cannot fill the whole row.
  for (const row of (dash?.dashboard || [])) {
    const e = row?.employer;
    if (!e || !Array.isArray(e.jobs) || !e.jobs.length) continue;
    const colors: [string, string] = Array.isArray(e.logoColor) && e.logoColor.length >= 2
      ? [e.logoColor[0], e.logoColor[1]] : gradFor(e.name);
    const ranked = [...e.jobs].sort((a: any, b: any) => (b?.matchScore ?? -1) - (a?.matchScore ?? -1));
    for (const j of ranked.slice(0, PER_EMPLOYER)) {
      if (!j) continue;
      out.push({
        key: 'job_' + (cleanJobUrl(j.applyUrl || j.url) || j.id || `${e.id}_${(j.title || '').toLowerCase()}`),
        jobId: j.id || null,
        employerId: String(e.id),
        applyUrl: j.applyUrl || j.url || null,
        company: e.name || 'Employer',
        role: j.title || e.subInfo || 'Open role',
        initial: e.logoInitial || initialOf(e.name),
        colors,
        match: typeof j.matchScore === 'number' && j.matchScore >= 0 ? j.matchScore : null,
        skills: Array.isArray(j.skills) ? j.skills.slice(0, 3) : [],
        location: j.location || '',
      });
    }
  }

  // (B) saved live-search cards — deduped by POSTING now, not by company, or a saved role would
  // hide a tracked role at the same employer. Company+title is the only key the two stores share:
  // tracked jobs carry a UUID and saved ones carry a URL, so there is nothing else to match on.
  // Deduped on the CLEANED URL, which is what the server's UNIQUE index uses. Company+title looked
  // reasonable but misses on capitalisation and on "Senior Engineer (m/w/d)" vs "Senior Engineer".
  const seen = new Set(out.map((t) => cleanJobUrl(t.applyUrl)).filter(Boolean));
  for (const c of (saved?.jobs || [])) {
    const company = c.company || c.employer_name || '';
    const title = c.title || 'Open role';
    const k = cleanJobUrl(c.job_url || c.id);
    if (!company || (k && seen.has(k))) continue;
    if (k) seen.add(k);
    out.push({
      key: 'job_' + (k || c.job_url || c.id),
      jobId: null,
      jobUrl: c.job_url || c.id || null,
      applyUrl: c.job_url || c.id || null,
      company,
      role: title,
      initial: initialOf(company),
      colors: gradFor(company),
      match: typeof c.match === 'number' ? c.match : null,
      skills: Array.isArray(c.skills) ? c.skills.slice(0, 3) : [],
      location: c.location || '',
    });
  }

  // Scored first, best match leading; unscored keep their order behind them.
  out.sort((a, b) => (b.match ?? -1) - (a.match ?? -1));
  return out.slice(0, 12);
}

export type HomeCards = {
  preferred: string | null;
  cards: HomeCard[];
  /** True when these pages are a STAND-IN built from the account's name and email,
   *  because no resume has been uploaded yet. The UI must say so. */
  sample?: boolean;
};

/**
 * The carousel: the user's REAL resume rendered in several designs (server-side disk cache).
 *
 * ⚠️ THREE OUTCOMES, NEVER TWO. Home turns "no resume" into a CTA that AI-rebuilds the resume,
 * spending a plan generation and overwriting what is stored — so "the user has no resume" must be
 * something the SERVER said (404 + reason:'no_resume'), never something we inferred from a timeout,
 * a 500 off a failed render, or a dropped connection. Collapsing those into one null is how a
 * flaky network silently charges a paying user and replaces the resume they hand-edited.
 *   'none' → the server positively says there is no resume yet.
 *   null   → we could not find out. The caller must keep whatever it already had.
 */
export async function fetchHomeCards(ids?: string[]): Promise<HomeCards | 'none' | null> {
  const q = ids && ids.length ? `?ids=${encodeURIComponent(ids.join(','))}` : '';
  const meta: { status?: number } = {};
  const j = await getJson(`/resume-builder/home-cards${q}`, 60000, meta);
  if (meta.status === 404) return 'none';
  if (!j || !Array.isArray(j.cards) || !j.cards.length) return null;
  return { preferred: j.preferred || null, cards: j.cards, sample: !!j.sample };
}

/** Which jobs already have a cover letter — keyed by UUID and by the gj_ URL alias. */
export async function fetchLetterStatuses(): Promise<Record<string, string>> {
  const j = await getJson('/ai-hub/job-statuses');
  return (j && j.statuses) || {};
}
export const hashJobUrlId = (s: string) => {
  let h = 0; const k = s || 'x';
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return 'gj_' + h.toString(36);
};

/**
 * Which design family suits a country — mirrors the server's REGIONS table
 * (server/utils/resumeTemplates.js), whose `sub` field lists the countries each region covers.
 * Used only as a HINT in the Add-employer sheet; the gallery remains the source of truth.
 */
const REGION_PICK: Array<{ countries: string[]; id: string; name: string }> = [
  { countries: ['india', 'bangladesh', 'nepal', 'sri lanka'], id: 'india', name: 'India Professional' },
  { countries: ['germany', 'austria', 'switzerland'], id: 'germany', name: 'Germany Professional' },
  { countries: ['france', 'spain', 'italy', 'netherlands', 'belgium', 'portugal', 'poland', 'sweden', 'norway', 'denmark', 'finland', 'ireland', 'czechia', 'romania'], id: 'europass', name: 'Europass Premium' },
  { countries: ['united states', 'usa', 'canada', 'united kingdom', 'uk', 'australia', 'new zealand'], id: 'ats', name: 'ATS Modern' },
  { countries: ['singapore', 'hong kong', 'malaysia', 'japan', 'south korea'], id: 'exec_pro', name: 'Executive Professional' },
];

export function bestDesignForCountry(country?: string | null): { id: string; name: string } | null {
  const c = (country || '').trim().toLowerCase();
  if (!c) return null;
  for (const r of REGION_PICK) if (r.countries.includes(c)) return { id: r.id, name: r.name };
  return null;
}

/**
 * The whole design catalogue as SLOTS — id, name, accent — with no pixels.
 *
 * ⚠️ This endpoint renders NOTHING (it is metadata plus a warm-up), which is the only reason Home
 * can offer the full set. Images arrive later, a few at a time, through fetchHomeCards(ids):
 * rendering is serial and single-process chromium dies after ~4-5 pages in a session, so asking for
 * all of them at once would take the preview pipeline down for everyone.
 */
export async function fetchTemplateCatalogue(): Promise<HomeCard[]> {
  const j = await getJson('/resume-builder/templates', 20000);
  const fams = j?.families;
  if (!Array.isArray(fams)) return [];
  const out: HomeCard[] = [];
  for (const f of fams) {
    const variants = Array.isArray(f?.variants) && f.variants.length ? f.variants : [f];
    for (const v of variants) {
      if (!v?.id) continue;
      out.push({ id: v.id, name: v.name || f.name || v.id, accent: v.accent || f.accent || '#4F8DFF', image: null } as HomeCard);
    }
  }
  return out;
}

/**
 * The letter designs, mirroring server/utils/coverLetterTemplates.js.
 *
 * ⚠️ HARDCODED ON PURPOSE — unlike resumes there is no GET endpoint that lists letter templates,
 * and there is no letter equivalent of /resume-builder/home-cards either: the only letter preview
 * endpoint (POST /cover-letter/preview-templates) demands the letter HTML in the request, so it can
 * render nothing until a letter has actually been written for that employer. That is why Home shows
 * the letter designs by NAME and asks first, instead of a carousel of pages it cannot produce.
 */
export const LETTER_DESIGNS: Array<{ id: string; name: string; accent: string }> = [
  { id: 'standard',        name: 'Original (Branded)',   accent: '#3a6cb5' },
  { id: 'ats_pro',         name: 'ATS Professional',     accent: '#1f2937' },
  { id: 'exec_leader',     name: 'Executive Leadership',  accent: '#b8995a' },
  { id: 'technical',       name: 'Technical Specialist',  accent: '#0e7490' },
  { id: 'german',          name: 'German Professional',   accent: '#334155' },
  { id: 'euro_motivation', name: 'European Motivation',   accent: '#8a7a5e' },
  { id: 'graduate',        name: 'Graduate / Entry Level', accent: '#5b5bd6' },
];

/* ── The posting a user is applying to ────────────────────────────────────────────────────────────
 *
 * When someone adds an employer they may paste the actual listing. That listing is what makes a
 * resume specific to THIS job rather than generic to the company, so it has to survive the trip
 * from the Add-employer sheet to whenever they generate.
 *
 * ⚠️ It lives on the device, not on the job row: `jobs` has no description column, and the row is
 * SHARED — jobs.job_url is globally unique, so writing one user's pasted text onto it would put it
 * in front of every other user who ever tracks the same posting.
 *
 * Keyed by whatever identifies the target we have at the time: the typed company, or the cleaned
 * posting URL. Capped, newest first, so it cannot grow without bound.
 */
const LISTINGS_KEY = 'job_listings_v1';
const LISTINGS_MAX = 24;

export type JobListing = { jobUrl?: string; jobText?: string; at: number };

const listingKey = (v?: string | null) => {
  const raw = String(v || '').trim();
  if (!raw) return '';
  return (cleanJobUrl(raw) || raw).toLowerCase();
};

async function readListings(): Promise<Record<string, JobListing>> {
  try {
    const raw = await AsyncStorage.getItem(LISTINGS_KEY);
    const j = raw ? JSON.parse(raw) : null;
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

/** Remember the posting the user gave us for this employer or job. */
export async function savePendingListing(forValue: string, l: { jobUrl?: string; jobText?: string }): Promise<void> {
  const k = listingKey(forValue);
  if (!k || (!l.jobUrl && !l.jobText)) return;
  try {
    const all = await readListings();
    all[k] = { jobUrl: l.jobUrl || '', jobText: l.jobText || '', at: Date.now() };
    const trimmed = Object.entries(all)
      .sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
      .slice(0, LISTINGS_MAX);
    await AsyncStorage.setItem(LISTINGS_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch { /* a lost listing costs tailoring, never correctness — never fail the add for it */ }
}

/** The posting for a target, looked up by its URL first and then by its company. */
export async function loadJobListing(target?: { applyUrl?: string | null; jobUrl?: string | null; company?: string } | null): Promise<JobListing | null> {
  if (!target) return null;
  const all = await readListings();
  for (const candidate of [target.applyUrl, target.jobUrl, target.company]) {
    const k = listingKey(candidate);
    if (k && all[k]) return all[k];
  }
  return null;
}
