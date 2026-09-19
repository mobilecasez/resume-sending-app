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
import { getDeviceId } from './deviceId';

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
  /** The employer's site, for an employer-level chip (no posting yet). ⚠️ NEVER a posting URL —
   *  the generator scrapes job.url as posting text, and a homepage read as a posting is nonsense. */
  website?: string | null;
  /** Where the posting is, when a store said so — steers the rule-ranked design region. Never guessed. */
  country?: string | null;
  /**
   * When it reached this user, on the SERVER's clock: a dashboard posting's jobs.created_at, a saved card's
   * saved_at. Only the saved "Designing for" row reads it (services/homeRoster): a posting newer than any the row
   * has seen may join it; an older one never refills a place the user emptied.
   */
  arrivedAt?: string | null;
};

export type HomeCard = { id: string; name: string; accent?: string; ats?: number | null; image?: string | null };

const AV: [string, string][] = [
  ['#4F8DFF', '#7C6BFF'], ['#7C6BFF', '#DB2777'], ['#7C6BFF', '#A855F7'],
  ['#06B6D4', '#3B82F6'], ['#10B981', '#06B6D4'], ['#F59E0B', '#EF4444'], ['#14B8A6', '#3B82F6'],
];
// Same hash the rest of the app uses for a stable per-company colour.
export const gradFor = (s?: string): [string, string] => {
  let h = 0; const k = s || 'x';
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return AV[h % AV.length];
};
/** At most this many postings per employer in the chip row. */
export const PER_EMPLOYER = 3;
/** The whole chip row, as the ranking offers it (services/homeRoster keeps what the user does with it). */
export const MAX_CHIPS = 12;
/** At most this many employer-level (no posting) chips lead the row; any others queue behind the postings. */
const LEAD_EMPLOYER_CHIPS = 4;

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

/**
 * The chip key a posting gets — fetchTargets' own spelling ('job_' + the cleaned URL, the raw URL when
 * cleaning leaves nothing). ⚠️ For callers that must NAME a posting chip before the chip exists (a build
 * recovered on mount, a removal keyed on the posting): spelling it any other way names a chip that never
 * appears, and whatever was keyed on it (a hide, a build record) silently misses.
 */
export const jobKeyForUrl = (url: string): string => {
  const raw = String(url || '').trim();
  return 'job_' + (cleanJobUrl(raw) || raw);
};

/**
 * A chip's letter, by CODE POINT. ⚠️ charAt(0) of "🚀 Rocket Lab" is HALF an emoji — a lone surrogate that draws as "�"
 * and that the server's jsonb refuses inside a saved row (homeRoster, 2026-09-20 review). The server's own logoInitial is
 * computed the same broken way (name[0]), so it is taken only when it is whole.
 */
const initialOf = (s?: string | null) => (Array.from((s || '?').trim())[0] || '?').toUpperCase();
const logoInitialOf = (given: unknown, name?: string | null) =>
  (typeof given === 'string' && given && !/[\uD800-\uDFFF]/.test(given) ? given : initialOf(name));

async function token(): Promise<string | undefined> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    return JSON.parse(raw || '{}')?.token;
  } catch { return undefined; }
}

/**
 * ⚠️ THE DEVICE GOES OUT ON EVERY HOME REQUEST — `x-device-id`, the same header and value
 * subscriptionService sends (services/deviceId.ts). The free 3 resumes + 3 letters are ONE PER DEVICE,
 * and the server can only hold that line for a device it can see. These helpers used to send only
 * Authorization, so an account created in THIS launch (reportDeviceOnce had not recorded its device yet)
 * reached generation-gate / generate-ai / employer-build with no device at all — and got a second full
 * allowance on a phone that had already used one, repeatable by signing out and up again.
 * Shared by homeAddEmployer.ts and employerDocs.ts so the whole Home talks through one copy. Resolved once
 * per module; a null (SecureStore unavailable) sends NO header — never a made-up id — and is retried on
 * the next request rather than remembered, so one transient keychain miss does not blind a whole session.
 */
let deviceIdMemo: string | null = null;
export async function deviceHeaders(): Promise<Record<string, string>> {
  if (!deviceIdMemo) {
    try { deviceIdMemo = (await getDeviceId()) || null; } catch { deviceIdMemo = null; }
  }
  return deviceIdMemo ? { 'x-device-id': deviceIdMemo } : {};
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
    const r = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${t}`, ...(await deviceHeaders()) }, signal: ctl.signal });
    if (meta) meta.status = r.status;
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/** Same auth (device included) and the same swallow-everything discipline as getJson, for the one call that writes. */
async function postJson(path: string, body: any, ms = 60000): Promise<any | null> {
  const t = await token();
  if (!t) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(await deviceHeaders()) },
      body: JSON.stringify(body || {}),
      signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    return { ...j, __status: r.status, __ok: r.ok };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/** postJson for the verbs that are not POST (the hidden-targets DELETE carries its key in the body). */
async function sendJson(method: 'POST' | 'DELETE', path: string, body: any, ms = 20000): Promise<any | null> {
  if (method === 'POST') return postJson(path, body, ms);
  const t = await token();
  if (!t) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(await deviceHeaders()) },
      body: JSON.stringify(body || {}),
      signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    return { ...j, __status: r.status, __ok: r.ok };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/* ── WHAT THEY HAVE ALREADY DOWNLOADED ──────────────────────────────────────────────────────────
 *
 * Home's lower half used to re-show the same resume designs the hero was already showing. This is
 * what goes there instead: the documents this person has paid for, so they can have them again on a
 * new phone, months later, without paying twice.
 *
 * ⚠️ `unlocked` IS THE SERVER'S ANSWER, NOT OURS. It is computed from the same subscription and the
 * same passes that canDownload will consult when they actually tap, so the padlock the list draws
 * and the answer the download gives cannot disagree. The client never decides that something is
 * free — it only draws what it was told.
 */
export type DownloadHistoryItem = {
  id: number;
  kind: 'resume' | 'cover_letter';
  employer: string;
  templateId: string;
  templateName: string;
  format: 'pdf' | 'docx';
  mode: string;
  /** How many times this exact document has been downloaded. One row per document, not per tap. */
  times: number;
  downloadedAt: string;
  /** A pass bought for this company covers it forever. */
  ownsEmployer: boolean;
  /** Free to fetch again right now — by a pass, or by a plan. */
  unlocked: boolean;
};

export type DownloadHistory = { items: DownloadHistoryItem[]; unlimited: boolean };

// ⚠️ Registered in app/(admin)/environment.tsx so switching environments clears it — it holds
// server row ids, and ids from one database mean nothing in another.
const HISTORY_KEY = 'dl_history_v1';

/** The last answer, so the section paints instantly instead of showing a spinner on every open. */
export async function cachedDownloadHistory(kind: 'resume' | 'cover_letter'): Promise<DownloadHistory | null> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const j = raw ? JSON.parse(raw) : null;
    const hit = j && j[kind];
    return hit && Array.isArray(hit.items) ? hit : null;
  } catch { return null; }
}

/** The live list. Returns null on any failure, leaving whatever was already on screen alone. */
export async function fetchDownloadHistory(kind: 'resume' | 'cover_letter'): Promise<DownloadHistory | null> {
  const j = await getJson(`/downloads/history?kind=${encodeURIComponent(kind)}`, 20000);
  if (!j || !Array.isArray(j.items)) return null;
  const out: DownloadHistory = { items: j.items, unlimited: !!j.unlimited };
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const all = raw ? JSON.parse(raw) : {};
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify({ ...(all || {}), [kind]: out }));
  } catch { /* a cache that will not write is still a working screen */ }
  return out;
}

export type RedownloadResult =
  | { ok: true; downloadUrl: string }
  | { ok: false; locked?: boolean; gone?: boolean; message: string };

/**
 * Get the file again.
 *
 * ⚠️ THE SERVER RE-RENDERS; IT DOES NOT KEEP THE OLD FILE. temp/ is wiped on every deploy, so a
 * stored filename is a dangling pointer within hours. For a resume that means the CURRENT resume in
 * the design they chose; for a letter it is the exact text they downloaded, which the server froze.
 *
 * ⚠️ A 403 IS NOT AN ERROR TO SWALLOW. It means the plan that paid for this has ended, and the
 * caller is expected to offer the paywall — the same sheet a first download offers.
 */
export async function redownload(id: number): Promise<RedownloadResult> {
  const j = await postJson(`/downloads/history/${id}/again`, {});
  if (!j) return { ok: false, message: 'We could not reach the server. Please try again.' };
  if (j.__ok && j.downloadUrl) return { ok: true, downloadUrl: String(j.downloadUrl) };
  if (j.__status === 403) {
    return { ok: false, locked: true, message: j.error || 'Downloading this is part of the paid plans.' };
  }
  if (j.__status === 410) {
    return { ok: false, gone: true, message: j.error || 'We no longer have the text of that letter.' };
  }
  return { ok: false, message: j.error || 'We could not produce that file. Please try again.' };
}

/* ── CHIPS THE USER REMOVED ─────────────────────────────────────────────────────────────────────────
 *
 * The X on a chip. Two different removals, because the two stores own different things:
 *   • emp_<id>  → untrackEmployer: the user stops tracking that employer (archived, never deleted —
 *                 their documents for it stay, so tracking it again restores them with no AI call).
 *   • job_<url> → hideTarget: a posting belongs to a shared jobs row / a saved card we must not delete,
 *                 so Home only stops SHOWING it (user_home_hidden_targets, per user).
 *
 * ⚠️ THE SERVER LIST CAN BE OLDER THAN THE TAP. A fetchTargets that started while the hide was still in
 * flight reads a hidden list without it, and the chip the user just removed pops back. What this device
 * asked for is laid over the server's answer: for as long as the request runs, and for a short grace
 * after it lands. The opposite action (Undo) replaces the entry, so an undone hide is never kept hidden.
 * ⚠️ An untrack's entry lasts only while its request runs: its Undo is trackEmployer (another service),
 * which cannot clear an entry here, and a grace would keep a re-tracked employer invisible.
 */
const HIDE_GRACE_MS = 30 * 1000;
const localHide = new Map<string, { hidden: boolean; until: number }>();

function hiddenNow(key: string, server: Set<string> | null): boolean {
  const l = localHide.get(key);
  if (l && l.until > Date.now()) return l.hidden;
  if (l) localHide.delete(key);
  return !!server && server.has(key);
}

/** The keys this user hid from Home. null = we could not find out (callers must not treat it as "none"). */
export async function fetchHiddenKeys(): Promise<string[] | null> {
  const j = await getJson('/ai-hub/home/hidden-targets', 15000);
  if (!j || !Array.isArray(j.keys)) return null;
  return j.keys.filter((k: any) => typeof k === 'string' && k);
}

/** Stop showing a posting chip. True when the server stored it; false leaves the server list unchanged. */
export async function hideTarget(key: string): Promise<boolean> {
  const k = String(key || '').trim();
  if (!k || k.length > 300) return false;
  localHide.set(k, { hidden: true, until: Number.POSITIVE_INFINITY });
  const j = await sendJson('POST', '/ai-hub/home/hidden-targets', { key: k });
  const ok = !!(j && j.__ok && j.success !== false);
  // Only settle OUR entry: an Undo that landed meanwhile has already replaced it with hidden:false.
  const cur = localHide.get(k);
  if (cur && cur.hidden) {
    if (ok) localHide.set(k, { hidden: true, until: Date.now() + HIDE_GRACE_MS });
    else localHide.delete(k);
  }
  return ok;
}

/** Undo a hide. True when the server removed it. */
export async function unhideTarget(key: string): Promise<boolean> {
  const k = String(key || '').trim();
  if (!k || k.length > 300) return false;
  localHide.set(k, { hidden: false, until: Number.POSITIVE_INFINITY });
  const j = await sendJson('DELETE', '/ai-hub/home/hidden-targets', { key: k });
  const ok = !!(j && j.__ok && j.success !== false);
  const cur = localHide.get(k);
  if (cur && !cur.hidden) {
    if (ok) localHide.set(k, { hidden: false, until: Date.now() + HIDE_GRACE_MS });
    else localHide.delete(k);   // the server still hides it, so the device must agree
  }
  return ok;
}

/**
 * Stop tracking an employer (archive for this user). True when the server answered success — including
 * an employer that was already archived. ⚠️ Archive, not delete: the documents built for it are kept.
 */
export async function untrackEmployer(employerId: string): Promise<boolean> {
  const id = String(employerId || '').trim();
  if (!id) return false;
  const k = 'emp_' + id;
  const mark = { hidden: true, until: Number.POSITIVE_INFINITY };
  localHide.set(k, mark);
  const j = await sendJson('POST', `/ai-hub/employers/${encodeURIComponent(id)}/untrack`, {});
  if (localHide.get(k) === mark) localHide.delete(k);
  return !!(j && j.__ok && j.success === true);
}

/**
 * Everything one Home load read about the chip row: the ranked row itself (fetchTargets), AND what the saved row
 * (services/homeRoster) needs to merge it without guessing.
 * ⚠️ A FAILED READ IS REPORTED AS FAILED (…Ok false, its list null), never as an empty answer. The row used to be
 * replaced by whatever came back, so a timed-out dashboard read (user 1's is 255 employers and 1,676 postings,
 * against a 15 s timeout) turned the whole row into saved cards, and a failed hidden-list read brought every
 * hidden posting back — and moved the selection off a chip that was no longer in the top 12 (2026-09-19).
 */
export type TargetAnswer = {
  /** fetchTargets' row, exactly: the top MAX_CHIPS. What the first complete load seeds the saved row from. */
  ranked: Target[];
  /** Every chip the ranking would offer, in its order, before the MAX_CHIPS cut (hidden ones left out). */
  candidates: Target[];
  /** Every chip either store could make — every posting, no per-employer cap, hidden or not — so a chip already
   *  on the row can refresh its match % when the ranking no longer offers it. */
  pool: Target[];
  dashOk: boolean;
  savedOk: boolean;
  hiddenOk: boolean;
  /** The server's hidden list; null when it could not be read. */
  hidden: string[] | null;
  /** This device's own hides / un-hides still in flight or in their grace (localHide) — they beat the server's list. */
  localHidden: Record<string, boolean>;
  /** Every employer this user tracks, from a dashboard read that answered; null when it did not. */
  trackedEmployerIds: string[] | null;
  /** …of those, the ones whose search has settled (not pending / processing). */
  settledEmployerIds: string[] | null;
  /** Every saved card's chip key; null when the read failed OR may have been cut short (see SAVED_READ_LIMIT). */
  savedKeys: string[] | null;
  /** The newest posting (jobs.created_at) and saved card (saved_at) in this answer — ms, the server's clock. */
  postMax: number | null;
  savedMax: number | null;
};

/**
 * GET /discover/saved-jobs lists at most this many, newest first (server discoverController.savedJobs LIMIT 500).
 * ⚠️ A full page may have cut the oldest cards off, so it is no evidence that a card missing from it was unsaved.
 */
const SAVED_READ_LIMIT = 500;

const msOf = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};

/** The employer chips: best-matching open role per company, strongest match first. */
export async function fetchTargets(): Promise<Target[]> {
  return (await fetchTargetAnswer()).ranked;
}

/** fetchTargets' ranking, with what each read actually said (see TargetAnswer). Never throws. */
export async function fetchTargetAnswer(): Promise<TargetAnswer> {
  const [dash, saved, hiddenJ] = await Promise.all([
    getJson('/ai-hub/dashboard'),
    getJson('/discover/saved-jobs'),
    // ⚠️ A failed read of the hidden list is NO filter, never an empty row: hiding is cosmetic.
    getJson('/ai-hub/home/hidden-targets', 15000),
    // The posting text docLookupOf reads synchronously must be in memory before any chip exists.
    warmJobListings(),
  ]);
  const hidden: Set<string> | null = hiddenJ && Array.isArray(hiddenJ.keys)
    ? new Set<string>(hiddenJ.keys.filter((k: any) => typeof k === 'string'))
    : null;
  const dashOk = !!dash && Array.isArray(dash.dashboard);
  const savedOk = !!saved && Array.isArray(saved.jobs);
  const out: Target[] = [];
  const employerChips: Target[] = [];
  const pool: Target[] = [];
  const tracked: string[] = [];
  const settled: string[] = [];
  let postMax: number | null = null;
  let savedMax: number | null = null;

  // (A) tracked employers — one chip per POSTING, not per company. Two roles at the same employer
  // are two different applications: they want different resumes and different letters, so
  // "Airbus · Senior Software Engineer" and "Airbus · Team Lead" have to be separately selectable.
  // ⚠️ Capped per employer so one company with a large careers page cannot fill the whole row.
  for (const row of (dash?.dashboard || [])) {
    const e = row?.employer;
    // Every row the dashboard lists is an employer this user tracks (status 'watching') — settled or not.
    if (e && e.id != null && String(e.id)) {
      tracked.push(String(e.id));
      if (row.status !== 'pending' && row.status !== 'processing') settled.push(String(e.id));
    }
    if (!e || !Array.isArray(e.jobs)) continue;
    const colors: [string, string] = Array.isArray(e.logoColor) && e.logoColor.length >= 2
      ? [e.logoColor[0], e.logoColor[1]] : gradFor(e.name);
    // An employer added from Home has no postings yet (the add is free and never searches), and
    // it used to be skipped here — so the chip the user just added simply never appeared. It is
    // ONE employer-level chip instead, keyed on the employer id: there is no posting URL to key on.
    if (!e.jobs.length) {
      // ⚠️ Only a SETTLED row. A search still pending/processing has no jobs YET — as an employer
      // chip it would lead the row, then vanish the moment its postings stream in. (A processing row
      // that already has partial postings still shows them below; this only stops the empty stand-in.)
      if (row.status === 'pending' || row.status === 'processing') continue;
      const chip: Target = {
        key: 'emp_' + e.id,
        jobId: null,
        employerId: String(e.id),
        company: e.name || 'Employer',
        role: '',
        initial: logoInitialOf(e.logoInitial, e.name),
        colors,
        match: null,
        skills: [],
        location: '',
        website: e.domain ? 'https://' + e.domain : null,
        country: typeof e.country === 'string' && e.country.trim() ? e.country.trim() : null,
      };
      employerChips.push(chip);
      pool.push(chip);
      continue;
    }
    const ranked = [...e.jobs].sort((a: any, b: any) => (b?.matchScore ?? -1) - (a?.matchScore ?? -1));
    // A posting the user removed does not use up one of its employer's PER_EMPLOYER places.
    // (Past the cap every posting still goes into `pool` — only the ranking stops at PER_EMPLOYER.)
    let taken = 0;
    for (const j of ranked) {
      if (!j) continue;
      const posting: Target = {
        key: 'job_' + (cleanJobUrl(j.applyUrl || j.url) || j.id || `${e.id}_${(j.title || '').toLowerCase()}`),
        jobId: j.id || null,
        employerId: String(e.id),
        applyUrl: j.applyUrl || j.url || null,
        company: e.name || 'Employer',
        role: j.title || e.subInfo || 'Open role',
        initial: logoInitialOf(e.logoInitial, e.name),
        colors,
        match: typeof j.matchScore === 'number' && j.matchScore >= 0 ? j.matchScore : null,
        skills: Array.isArray(j.skills) ? j.skills.slice(0, 3) : [],
        location: j.location || '',
        country: typeof j.country === 'string' && j.country.trim() ? j.country.trim() : null,
        arrivedAt: typeof j.createdAt === 'string' && j.createdAt ? j.createdAt : null,
      };
      const at = msOf(j.createdAt);
      if (at !== null && (postMax === null || at > postMax)) postMax = at;
      pool.push(posting);
      if (taken >= PER_EMPLOYER) continue;
      if (hiddenNow(posting.key, hidden)) continue;
      taken++;
      out.push(posting);
    }
  }

  // (B) saved live-search cards — deduped by POSTING now, not by company, or a saved role would
  // hide a tracked role at the same employer. Company+title is the only key the two stores share:
  // tracked jobs carry a UUID and saved ones carry a URL, so there is nothing else to match on.
  // Deduped on the CLEANED URL, which is what the server's UNIQUE index uses. Company+title looked
  // reasonable but misses on capitalisation and on "Senior Engineer (m/w/d)" vs "Senior Engineer".
  const seen = new Set(out.map((t) => cleanJobUrl(t.applyUrl)).filter(Boolean));
  const savedKeys: string[] = [];
  for (const c of (saved?.jobs || [])) {
    if (!c) continue;
    const company = c.company || c.employer_name || '';
    const title = c.title || 'Open role';
    const k = cleanJobUrl(c.job_url || c.id);
    // Every saved card counts as still saved — shown or not — so only an unsave can read as one.
    savedKeys.push('job_' + (k || c.job_url || c.id));
    const at = msOf(c.saved_at);
    if (at !== null && (savedMax === null || at > savedMax)) savedMax = at;
    if (!company || (k && seen.has(k))) continue;
    if (k) seen.add(k);
    const card: Target = {
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
      country: typeof c.country === 'string' && c.country.trim() ? c.country.trim() : null,
      arrivedAt: typeof c.saved_at === 'string' && c.saved_at ? c.saved_at : null,
    };
    out.push(card);
    pool.push(card);
  }

  // Postings: scored first, best match leading; unscored keep their order behind them.
  out.sort((a, b) => (b.match ?? -1) - (a.match ?? -1));
  // ⚠️ The newest employer-level chips go FIRST, in the dashboard's own order (updated_at DESC = most
  // recently tracked leading), and the cap is applied AFTER. Sorting them in with the postings would
  // put a match of null behind every scored role, and the 12-cap would then drop the employer the
  // user added a second ago — Home scrolls to that chip and starts building for it, so it must exist.
  // ⚠️ But only a FEW lead: completed searches that found nothing are employer-level chips too (about
  // a third of searches return zero), and letting all of them lead pushed every real posting out of
  // the 12. The rest follow the postings, filling the row only where there is room.
  // ⚠️ Removed chips are dropped BEFORE the lead split and the cap, or a hidden chip would still take
  // one of the 12 slots (and one of the 4 lead places) while showing nothing.
  const shown = (t: Target) => !hiddenNow(t.key, hidden);
  const leads = employerChips.filter(shown);
  const candidates = [
    ...leads.slice(0, LEAD_EMPLOYER_CHIPS),
    ...out.filter(shown),
    ...leads.slice(LEAD_EMPLOYER_CHIPS),
  ];
  // This device's hides and un-hides that still outrank the server's list, as they stand now.
  const localHidden: Record<string, boolean> = {};
  const now = Date.now();
  localHide.forEach((l, k) => { if (l.until > now) localHidden[k] = l.hidden; });
  return {
    ranked: candidates.slice(0, MAX_CHIPS),
    candidates,
    pool,
    dashOk,
    savedOk,
    hiddenOk: !!hidden,
    hidden: hidden ? Array.from(hidden) : null,
    localHidden,
    trackedEmployerIds: dashOk ? tracked : null,
    settledEmployerIds: dashOk ? settled : null,
    savedKeys: savedOk && saved.jobs.length < SAVED_READ_LIMIT ? savedKeys : null,
    postMax: dashOk ? postMax : null,
    savedMax: savedOk ? savedMax : null,
  };
}

export type HomeCards = {
  preferred: string | null;
  cards: HomeCard[];
  /** True when these pages are a STAND-IN built from the account's name and email,
   *  because no resume has been uploaded yet. The UI must say so. */
  sample?: boolean;
  /** True when the account has a resume the AI can write from — a builder row with content OR an uploaded
   *  resume. ⚠️ NOT the inverse of `sample`: an upload-only user gets sample pages (nothing in the builder
   *  to render) yet has everything a letter or a tailored resume needs, and reading `sample` as "no resume"
   *  hid Write my cover letter from exactly those users. undefined = an older server that does not say
   *  (callers fall back to !sample). */
  hasResume?: boolean;
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
  return {
    preferred: j.preferred || null, cards: j.cards, sample: !!j.sample,
    // Only a real boolean: an absent field must stay undefined so Home falls back to !sample, never "false".
    ...(typeof j.hasResume === 'boolean' ? { hasResume: j.hasResume } : {}),
  };
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
    // ⚠️ ats lives on the FAMILY (server FAMILIES), not on its recolored variants — a variant is the same
    // layout in another colour, so it inherits the family's score rather than reading as unknown.
    const famAts = typeof f?.ats === 'number' && isFinite(f.ats) ? f.ats : null;
    for (const v of variants) {
      if (!v?.id) continue;
      const ats = typeof v.ats === 'number' && isFinite(v.ats) ? v.ats : famAts;
      out.push({ id: v.id, name: v.name || f.name || v.id, accent: v.accent || f.accent || '#4F8DFF', ats, image: null } as HomeCard);
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
 *
 * ⚠️ A LISTING A SAVED DOCUMENT WAS FOUND WITH IS NOT EVICTED LIKE THE REST. docLookupOf spells a chip's
 * posting text and posting link FROM this store, so evicting one silently changed the chip: the saved
 * document's staleness question changed with it (it read stale forever) and Refresh rebuilt it with no
 * posting at all. Each add writes two entries (company + website), so the old flat cap of 24 did that
 * after a dozen adds. Now an entry a saved document was looked up with is marked `kept` (keepJobListings,
 * called by employerDocs.rememberDoc) and only a much larger cap reaches it. The server also keeps the job
 * a document was built from (job_input) for its own staleness check, so this protects Refresh, not billing.
 * ⚠️ Plus a SIZE budget: all of it is ONE AsyncStorage value, and Android cannot read back a row of a few
 * MB (CursorWindow) — an oversized value would read as {} and lose every listing at once.
 */
const LISTINGS_KEY = 'job_listings_v1';
/** Entries no saved document was found with. Newest first. */
const LISTINGS_MAX = 40;
/** Entries a saved document was found with — only this (or the size budget) evicts them. */
const LISTINGS_KEPT_MAX = 120;
/** The whole stored JSON, in characters (a pasted description is usually 3-15 KB). */
const LISTINGS_BUDGET = 600000;

export type JobListing = {
  jobUrl?: string;
  jobText?: string;
  at: number;
  /** When a saved document was first found with this listing (see keepJobListings). */
  kept?: number;
};

const listingKey = (v?: string | null) => {
  const raw = String(v || '').trim();
  if (!raw) return '';
  return (cleanJobUrl(raw) || raw).toLowerCase();
};

const sameListingUrl = (a?: string | null, b?: string | null) => {
  const x = listingKey(a);
  return !!x && x === listingKey(b);
};

/**
 * A synchronous mirror of the stored listings. ⚠️ WHY IT EXISTS: services/employerDocs' docLookupOf is
 * SYNC (a chip switch must find its cached document in the same frame), yet the posting text it carries
 * feeds the build fingerprint and the staleness check. A lookup that read '' before storage answered and
 * the text after would ask two different questions about one chip. So the mirror is loaded when this
 * module loads, re-read by fetchTargets before any chip exists, and updated by every save.
 * ⚠️ STORAGE IS ADOPTED ONLY IN TURN WITH THE WRITES (warmJobListings runs through `serially`). A plain
 * read that landed between a save's mirror update and its setItem used to put the OLD storage back into
 * the mirror, and the listing just pasted vanished from the next lookup. Reads that only answer a caller
 * (loadJobListing) never touch the mirror at all.
 */
let listingsMirror: Record<string, JobListing> | null = null;
let listingsLoad: Promise<void> | null = null;

/** The stored listings, or null when storage could not be read (callers must not mistake that for "none"). */
async function readListings(): Promise<Record<string, JobListing> | null> {
  try {
    const raw = await AsyncStorage.getItem(LISTINGS_KEY);
    const j = raw ? JSON.parse(raw) : null;
    return j && typeof j === 'object' ? { ...j } : {};
  } catch { return null; }
}

/**
 * Every write is a read-modify-write of ONE storage value, so two at once (a save and a keep) would drop
 * whichever finished first. They run one after another; a failed one never blocks the next.
 */
let listingsWrites: Promise<void> = Promise.resolve();
function serially(fn: () => Promise<void>): Promise<void> {
  const run = listingsWrites.then(fn, fn);
  listingsWrites = run.catch(() => undefined);
  return run;
}

/**
 * (Re)load the mirror from storage; concurrent calls share one read. Never throws.
 * ⚠️ RE-READ ON EVERY CALL, not once: fetchTargets calls it on each Home load, and storage can change under
 * a running app without this module writing — account deletion runs AsyncStorage.clear() and the next
 * account signs in to the same JS bundle, which must not keep reading the old account's pasted postings.
 * A read that fails keeps what the mirror already has.
 */
export function warmJobListings(): Promise<void> {
  if (!listingsLoad) {
    listingsLoad = serially(async () => {
      const all = await readListings();
      if (all) listingsMirror = all;
    }).finally(() => { listingsLoad = null; });
  }
  return listingsLoad;
}
warmJobListings();

/**
 * The stored listing for these lookup values, SYNCHRONOUSLY, first match wins. undefined values are
 * skipped. null when nothing matches or the mirror has not loaded yet.
 */
export function cachedJobListing(candidates: Array<string | null | undefined>): JobListing | null {
  const all = listingsMirror;
  if (!all) return null;
  for (const c of candidates) {
    const k = listingKey(c);
    if (k && all[k]) return all[k];
  }
  return null;
}

/** Newest first by what matters for eviction: when it was saved, or when a document was found with it. */
const recency = (l: JobListing | undefined) => Math.max(Number(l?.at) || 0, Number(l?.kept) || 0);

/**
 * What survives a write: the entry just written first (always — it is what the user is building with),
 * then kept entries, then the rest, each newest first, each under its own cap, all under the size budget.
 */
function trimListings(all: Record<string, JobListing>, justWrote: string | null): Record<string, JobListing> {
  const rows = Object.entries(all).filter(([k, l]) => !!k && !!l && typeof l === 'object');
  const byRecency = (a: [string, JobListing], b: [string, JobListing]) => recency(b[1]) - recency(a[1]);
  const kept = rows.filter(([k, l]) => k !== justWrote && !!l.kept).sort(byRecency).slice(0, LISTINGS_KEPT_MAX);
  const loose = rows.filter(([k, l]) => k !== justWrote && !l.kept).sort(byRecency).slice(0, LISTINGS_MAX);
  const first = justWrote && all[justWrote] ? [[justWrote, all[justWrote]] as [string, JobListing]] : [];
  const out: Record<string, JobListing> = {};
  let size = 2;
  let n = 0;
  for (const [k, l] of [...first, ...kept, ...loose]) {
    const cost = k.length + JSON.stringify(l).length + 6;
    if (n && size + cost > LISTINGS_BUDGET) continue;
    out[k] = l;
    size += cost;
    n++;
  }
  return out;
}

/** Remember the posting the user gave us for this employer or job. */
export async function savePendingListing(forValue: string, l: { jobUrl?: string; jobText?: string }): Promise<void> {
  const k = listingKey(forValue);
  if (!k || (!l.jobUrl && !l.jobText)) return;
  await serially(async () => {
    try {
      // A read that failed is not an empty store: writing from {} would erase every other listing.
      const all = (await readListings()) || { ...(listingsMirror || {}) };
      const jobUrl = l.jobUrl || '';
      const jobText = l.jobText || '';
      const prev = all[k];
      // The same listing written again keeps its protection; different text under this key is a new
      // listing, and nothing was built from it yet.
      const same = !!prev && (prev.jobUrl || '') === jobUrl && (prev.jobText || '') === jobText;
      all[k] = { jobUrl, jobText, at: Date.now(), ...(same && prev.kept ? { kept: prev.kept } : {}) };
      const next = trimListings(all, k);
      // The mirror moves first: a docLookupOf in the next frame must already see this listing.
      listingsMirror = { ...next };
      await AsyncStorage.setItem(LISTINGS_KEY, JSON.stringify(next));
    } catch { /* a lost listing costs tailoring, never correctness — never fail the add for it */ }
  });
}

/**
 * A saved document was found for a lookup that read one of these listings: exempt it from the ordinary
 * cap (see the section header). `read` is what the lookup carried — only an entry whose text is that text
 * (or, for a text-less listing, whose link is that posting link) is the one the document depends on.
 * ⚠️ SYNC AND CHEAP WHEN THERE IS NOTHING TO DO. It is called on every document answer; an entry already
 * kept costs one map read, and only a real change touches storage (in the background, never awaited).
 */
export function keepJobListings(
  candidates: Array<string | null | undefined>,
  read: { jobText?: string | null; postingUrl?: string | null },
): void {
  const all = listingsMirror;
  if (!all) return;
  const text = String(read?.jobText || '');
  const link = String(read?.postingUrl || '').trim();
  if (!text && !link) return;
  const reads = (l: JobListing | undefined) => !!l
    && (l.jobText || '') === text
    && (text ? true : sameListingUrl(l.jobUrl, link));
  const keys = Array.from(new Set(candidates.map((c) => listingKey(c)).filter(Boolean)))
    .filter((k) => reads(all[k]) && !all[k].kept);
  if (!keys.length) return;
  const now = Date.now();
  // The mirror first, so the next call in this frame is a no-op.
  listingsMirror = { ...all };
  for (const k of keys) listingsMirror[k] = { ...all[k], kept: now };
  serially(async () => {
    try {
      const stored = await readListings();
      if (!stored) return;
      let changed = false;
      for (const k of keys) {
        if (reads(stored[k]) && !stored[k].kept) { stored[k] = { ...stored[k], kept: now }; changed = true; }
      }
      if (!changed) return;
      const next = trimListings(stored, null);
      listingsMirror = { ...next };
      await AsyncStorage.setItem(LISTINGS_KEY, JSON.stringify(next));
    } catch { /* protection is best effort; the listing itself is untouched */ }
  }).catch(() => undefined);
}

/** The posting for a target, looked up by its URL first and then by its company. */
export async function loadJobListing(target?: { applyUrl?: string | null; jobUrl?: string | null; company?: string } | null): Promise<JobListing | null> {
  if (!target) return null;
  const all = await readListings();
  if (!all) return null;
  for (const candidate of [target.applyUrl, target.jobUrl, target.company]) {
    const k = listingKey(candidate);
    if (k && all[k]) return all[k];
  }
  return null;
}
