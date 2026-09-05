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
const initialOf = (s?: string | null) => (s || '?').trim().charAt(0).toUpperCase();

async function token(): Promise<string | undefined> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    return JSON.parse(raw || '{}')?.token;
  } catch { return undefined; }
}
async function getJson(path: string, ms = 15000): Promise<any | null> {
  const t = await token();
  if (!t) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${t}` }, signal: ctl.signal });
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

  // (A) tracked employers — one chip per COMPANY, showing its best-matching role, because the
  // headline promise is per-employer, not per-posting.
  for (const row of (dash?.dashboard || [])) {
    const e = row?.employer;
    if (!e || !Array.isArray(e.jobs) || !e.jobs.length) continue;
    const best = [...e.jobs].sort((a: any, b: any) => (b?.matchScore ?? -1) - (a?.matchScore ?? -1))[0];
    if (!best) continue;
    const colors: [string, string] = Array.isArray(e.logoColor) && e.logoColor.length >= 2
      ? [e.logoColor[0], e.logoColor[1]] : gradFor(e.name);
    out.push({
      key: 'emp_' + e.id,
      jobId: best.id || null,
      employerId: String(e.id),
      company: e.name || 'Employer',
      role: best.title || e.subInfo || 'Open role',
      initial: e.logoInitial || initialOf(e.name),
      colors,
      match: typeof best.matchScore === 'number' && best.matchScore >= 0 ? best.matchScore : null,
      skills: Array.isArray(best.skills) ? best.skills.slice(0, 3) : [],
      location: best.location || '',
    });
  }

  // (B) saved live-search cards — deduped against the companies already present.
  const seen = new Set(out.map((t) => t.company.toLowerCase()));
  for (const c of (saved?.jobs || [])) {
    const company = c.company || c.employer_name || '';
    if (!company || seen.has(company.toLowerCase())) continue;
    seen.add(company.toLowerCase());
    out.push({
      key: 'sav_' + (c.job_url || c.id),
      jobId: null,
      jobUrl: c.job_url || c.id || null,
      company,
      role: c.title || 'Open role',
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

/** The carousel: the user's REAL resume rendered in several designs (server-side disk cache). */
export async function fetchHomeCards(ids?: string[]): Promise<{ preferred: string | null; cards: HomeCard[] } | null> {
  const q = ids && ids.length ? `?ids=${encodeURIComponent(ids.join(','))}` : '';
  const j = await getJson(`/resume-builder/home-cards${q}`, 60000);
  if (!j || !Array.isArray(j.cards) || !j.cards.length) return null;
  return { preferred: j.preferred || null, cards: j.cards };
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
