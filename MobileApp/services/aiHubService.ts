// AI Hub — new feature. Safe to delete without affecting existing app.

import axios from 'axios';
import { AppState, AppStateStatus } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../config';
import type { Contact, Employer, Job } from '../types/aiHub';

// Every request below interpolates `${API_BASE}` directly. That is deliberate: API_BASE is a live
// ES module binding, so each call reads whichever backend is selected NOW. It must never be copied
// into a module-scope const — that snapshots the value at import time, which happens before the
// stored admin environment override can be read, so this file would keep calling the old backend
// while the rest of the app called the new one. A session split across two databases is the exact
// failure this avoids.

async function getAuthHeader(): Promise<{ Authorization: string } | Record<string, never>> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    if (!raw) return {};
    const session = JSON.parse(raw);
    if (!session?.token) return {};
    return { Authorization: `Bearer ${session.token}` };
  } catch {
    return {};
  }
}

/**
 * Polls /api/job-status/:jobId every 2 s.
 * Pauses automatically when app is backgrounded; resumes on foreground.
 * Calls onPartialUpdate whenever partial data arrives during processing.
 * Resolves with the final completed data, rejects on failure.
 */
function pollUntilDone<T>(
  jobId: string,
  headers: Record<string, string>,
  onPartialUpdate?: (data: T) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    let appState: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      appState = next;
    });

    const cleanup = () => subscription.remove();

    const MAX_ACTIVE_MS = 10 * 60 * 1000;   // hard deadline (foreground time only) → stop polling
    let lastTickAt = Date.now();
    let activeMs = 0;
    let notFoundStrikes = 0;                 // 2 consecutive 404s → give up (tolerates the brief
                                             // window before the job row exists)

    const tick = async () => {
      // Pause while backgrounded — retry in 1 s (does NOT count toward the deadline)
      if (appState !== 'active') {
        lastTickAt = Date.now();
        setTimeout(tick, 1000);
        return;
      }

      activeMs += Date.now() - lastTickAt;
      lastTickAt = Date.now();
      if (activeMs > MAX_ACTIVE_MS) {
        cleanup();
        const e: any = new Error('Job polling timed out');
        e.code = 'POLL_TIMEOUT';
        reject(e);
        return;
      }

      try {
        const { data } = await axios.get(`${API_BASE}/ai-hub/job-status/${jobId}`, { headers });
        notFoundStrikes = 0;

        if (data.status === 'completed') {
          cleanup();
          resolve(data.data as T);
        } else if (data.status === 'failed') {
          cleanup();
          reject(new Error(data.error || 'Job failed'));
        } else {
          // Partial data available — stream it to the UI
          if (data.data && onPartialUpdate) {
            onPartialUpdate(data.data as T);
          }
          setTimeout(tick, 2000);
        }
      } catch (err) {
        // A 404 means the server never had / no longer has this job (e.g. a STALE persisted
        // in-flight entry). Don't spin forever — give up after 2 consecutive 404s so the caller's
        // .catch() can clear it. Transient errors (network / 5xx) keep retrying.
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          if (++notFoundStrikes >= 2) {
            cleanup();
            const e: any = new Error('Job not found');
            e.code = 'JOB_NOT_FOUND';
            reject(e);
            return;
          }
        }
        setTimeout(tick, 2000);
      }
    };

    tick();
  });
}

/**
 * Analyzes the user's wishlist of target companies.
 */
export async function analyzeWishlist(
  companies: string[]
): Promise<{ matches: number; sources: number }> {
  try {
    const headers = await getAuthHeader();
    const response = await axios.post(
      `${API_BASE}/ai-hub/analyze-wishlist`,
      { companies },
      { headers }
    );
    return response.data;
  } catch (error: unknown) {
    const msg = axios.isAxiosError(error)
      ? error.response?.data?.error ?? error.message
      : 'Failed to analyze wishlist';
    throw new Error(msg);
  }
}

/**
 * Kicks off an async job on the server and polls until Gemini returns all results.
 * Jobs appear progressively — onPartialUpdate is called as each batch of 3 arrives.
 * onJobIdKnown fires immediately when the server returns the async jobId (before polling).
 * Safe to background — polling pauses and resumes automatically.
 */
export async function fetchJobMatches(
  companyName: string,
  onPartialUpdate?: (employer: Employer) => void,
  onJobIdKnown?: (jobId: string) => void
): Promise<Employer> {
  try {
    const headers = await getAuthHeader();

    const response = await axios.get(`${API_BASE}/ai-hub/jobs`, {
      params: { company: companyName },
      headers,
    });

    const data = response.data;

    if (!data?.jobId) {
      // Legacy sync response — return directly
      return data as Employer;
    }

    // Fire callback as soon as jobId is known — caller can persist it
    onJobIdKnown?.(data.jobId);

    return pollUntilDone<Employer>(
      data.jobId,
      headers as Record<string, string>,
      onPartialUpdate
    );
  } catch (error: unknown) {
    // Re-throw axios errors as-is so callers can inspect response.data (e.g. job_portal error)
    if (axios.isAxiosError(error)) throw error;
    throw new Error(`Failed to fetch job matches for ${companyName}`);
  }
}

/**
 * Resumes polling for an existing async job.
 */
export async function resumeJobPolling(
  jobId: string,
  onPartialUpdate?: (employer: Employer) => void
): Promise<Employer> {
  try {
    const headers = await getAuthHeader();
    return pollUntilDone<Employer>(
      jobId,
      headers as Record<string, string>,
      onPartialUpdate
    );
  } catch (error: unknown) {
    const msg = axios.isAxiosError(error)
      ? error.response?.data?.error ?? error.message
      : `Failed to resume polling for job ${jobId}`;
    throw new Error(msg);
  }
}

/**
 * Verifies whether a given email address is deliverable.
 */
export async function verifyEmail(
  email: string
): Promise<{ verified: boolean; confidence: number }> {
  try {
    const headers = await getAuthHeader();
    const response = await axios.post(
      `${API_BASE}/ai-hub/verify-email`,
      { email },
      { headers }
    );
    return response.data;
  } catch (error: unknown) {
    const msg = axios.isAxiosError(error)
      ? error.response?.data?.error ?? error.message
      : `Failed to verify email ${email}`;
    throw new Error(msg);
  }
}

/**
 * Adds a manually-entered contact to a specific job.
 */
export async function addContactToJob(
  jobId: string,
  contact: Omit<Contact, 'id' | 'verified' | 'avatarColor'>
): Promise<Contact> {
  try {
    const headers = await getAuthHeader();
    const response = await axios.post(
      `${API_BASE}/ai-hub/jobs/${jobId}/contacts`,
      contact,
      { headers }
    );
    return response.data;
  } catch (error: unknown) {
    const msg = axios.isAxiosError(error)
      ? error.response?.data?.error ?? error.message
      : `Failed to add contact to job ${jobId}`;
    throw new Error(msg);
  }
}

/**
 * Translates a job card's text fields to English. The server caches the result
 * per job (shared across users), so repeat calls are instant. Returns the
 * translated fields; the caller merges them onto the Job object.
 */
export type TranslatedJob = {
  title?: string;
  location?: string;
  experience?: string;
  salary?: string;
  jobType?: string;
  workMode?: string | null;
  skills?: string[];
  responsibilities?: string[];
};

export async function translateJob(jobId: string, fields?: Record<string, any>): Promise<TranslatedJob> {
  try {
    const headers = await getAuthHeader();
    const response = await axios.post(
      `${API_BASE}/ai-hub/jobs/${jobId}/translate`,
      fields ? { fields } : {},   // Explore/live jobs aren't in the DB → send their text so translate works
      { headers }
    );
    return (response.data?.translated ?? {}) as TranslatedJob;
  } catch (error: unknown) {
    const msg = axios.isAxiosError(error)
      ? error.response?.data?.error ?? error.message
      : `Failed to translate job ${jobId}`;
    throw new Error(msg);
  }
}

// Translate a batch of short visible-text snippets to English. Used by the apply-WebView's
// "bridge" translator (via the RN message bridge) when a site's CSP blocks Google's in-page
// widget. Returns a map of { "<i>": "<english>" }; resolves to {} on failure (caller no-ops).
export async function translateBatch(items: { i: string; t: string }[]): Promise<Record<string, string>> {
  try {
    if (!items || !items.length) return {};
    const headers = await getAuthHeader();
    const response = await axios.post(
      `${API_BASE}/ai-hub/translate-batch`,
      { items },
      // A stalled request must reject so the translate spinner clears. 45s, not 30: the server now
      // sub-batches and retries transient Gemini failures internally, and cutting it off at 30 threw
      // away work that was about to land.
      { headers, timeout: 45000 }
    );
    return (response.data?.translations ?? {}) as Record<string, string>;
  } catch {
    return {};
  }
}

// ── LinkedIn (separate pipeline: hidden on-device WebView → backend AI extract) ──
export type LinkedInJob = {
  title: string; company: string; location: string; employment_type: string;
  work_mode: string; salary: string; seniority: string;
  skills: string[]; responsibilities: string[]; description: string;
  url: string; source: string;
};

// True for a LinkedIn job posting URL → route these to the hidden-WebView extractor, never the server scrape.
export function isLinkedInJobUrl(url: string): boolean {
  return /(^|\/\/|\.)linkedin\.com\/(jobs|job)\b/i.test(String(url || ''));
}

// Send the hidden WebView's page innerText to the backend → structured job (also stored for cover letters).
export async function extractLinkedInJob(url: string, content: string): Promise<LinkedInJob> {
  const headers = await getAuthHeader();
  const response = await axios.post(
    `${API_BASE}/ai-hub/linkedin/extract`,
    { url, content },
    { headers }
  );
  return (response.data?.job ?? null) as LinkedInJob;
}

// Extract AND add a pasted LinkedIn job URL to the user's Job Hub (employer + job + tracking) → shows on dashboard.
export async function addLinkedInJob(url: string, content: string): Promise<LinkedInJob> {
  const headers = await getAuthHeader();
  const response = await axios.post(
    `${API_BASE}/ai-hub/linkedin/add`,
    { url, content },
    { headers }
  );
  return (response.data?.job ?? null) as LinkedInJob;
}

/**
 * Fetches the persisted contacts for a job (used to refresh after adding one).
 * Returns [] on any error so the caller can keep showing the snapshot.
 */
export async function getJobContacts(jobId: string): Promise<Contact[]> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(
      `${API_BASE}/ai-hub/jobs/${jobId}/contacts`,
      { headers }
    );
    return (data?.contacts ?? data ?? []) as Contact[];
  } catch {
    return [];
  }
}

/**
 * Fetches the user's saved per-user apply-URL override for a job, if any.
 * Returns the override URL, or null when none is saved or on any error.
 */
export async function getJobUrlOverride(jobId: string): Promise<string | null> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(
      `${API_BASE}/ai-hub/jobs/${jobId}/url-override`,
      { headers }
    );
    return data?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Saves a corrected/added apply-URL override for a job (per-user).
 * Returns the saved url on success; throws with the server's error message
 * (or a friendly default) on failure.
 */
export async function updateJobUrl(jobId: string, url: string): Promise<string> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.post(
      `${API_BASE}/ai-hub/jobs/${jobId}/url-override`,
      { url },
      { headers }
    );
    return data.url;
  } catch (error: unknown) {
    const msg = axios.isAxiosError(error)
      ? error.response?.data?.error ?? error.message
      : `Couldn't save the apply link. Please try again.`;
    throw new Error(msg);
  }
}

/**
 * Smart-copy popup data: the user's reusable facts + a resume summary, shown inside the
 * apply WebView so the user can copy-paste any field the autofill couldn't reach.
 */
export type SmartFillField = { id: string; label: string; value: string };
export type SmartFillData = { fields: SmartFillField[]; resumeSummary: string; skills: string[]; jobTitles: string[] };

export async function getSmartFillData(): Promise<SmartFillData> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE}/ai-hub/smart-fill-data`, { headers });
    return {
      fields: Array.isArray(data?.fields) ? data.fields : [],
      resumeSummary: typeof data?.resumeSummary === 'string' ? data.resumeSummary : '',
      skills: Array.isArray(data?.skills) ? data.skills : [],
      jobTitles: Array.isArray(data?.jobTitles) ? data.jobTitles : [],
    };
  } catch {
    return { fields: [], resumeSummary: '', skills: [], jobTitles: [] };
  }
}

/**
 * Personalized, résumé-aware motivation lines shown while a search is processing. Generated
 * once per user on the backend and cached there — safe to call repeatedly. Returns [] on any
 * failure (the UI then leans on the bundled generic tip library).
 */
export async function getMotivationLines(): Promise<string[]> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE}/ai-hub/motivation`, { headers, timeout: 20000 });
    return Array.isArray(data?.lines) ? data.lines.filter((l: any) => typeof l === 'string' && l.trim()) : [];
  } catch {
    return [];
  }
}

/**
 * Self-learning autofill: remember the answers the user filled manually so the next form
 * with the same questions auto-fills. Best-effort — never throws to the caller.
 */
export async function recordAutofillMemory(
  answers: { label: string; value: string; type?: string }[]
): Promise<void> {
  try {
    if (!Array.isArray(answers) || answers.length === 0) return;
    const headers = await getAuthHeader();
    await axios.post(`${API_BASE}/ai-hub/autofill-memory`, { answers }, { headers });
  } catch { /* learning is best-effort */ }
}

export type DashboardEntry = {
  jobId: string;
  status: string;
  progress: number;
  employer: Employer;
  updatedAt: string;
};

// Stale-while-revalidate cache for the dashboard: the screen paints the cached copy INSTANTLY
// on open, then fetchDashboard() revalidates in the background. The server supports ETag/304,
// so an unchanged dashboard costs one header round-trip (0 bytes of body).
const DASH_CACHE_KEY = 'aiHub_dashboard_cache_v1';
const DASH_ETAG_KEY = 'aiHub_dashboard_etag_v1';

/** Instant read of the last-known dashboard (null if never fetched). */
export async function getCachedDashboard(): Promise<DashboardEntry[] | null> {
  try {
    const raw = await AsyncStorage.getItem(DASH_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch { return null; }
}

/** Drop one employer from the cached copy (called on remove, so a reopen can't resurrect it). */
export async function evictEmployerFromDashboardCache(employerId: string): Promise<void> {
  try {
    const cached = await getCachedDashboard();
    if (!cached) return;
    const next = cached.filter((e) => e?.employer?.id !== employerId);
    await AsyncStorage.setItem(DASH_CACHE_KEY, JSON.stringify(next));
    // The server copy differs now — clear the etag so the next fetch gets a fresh 200.
    await AsyncStorage.removeItem(DASH_ETAG_KEY);
  } catch { /* cache maintenance is best-effort */ }
}

/**
 * Fetches the user's tracked employers / search history.
 * Sends If-None-Match; on 304 returns the cached copy (0-byte revalidation).
 */
export async function fetchDashboard(): Promise<DashboardEntry[]> {
  try {
    const auth = await getAuthHeader();
    const etag = await AsyncStorage.getItem(DASH_ETAG_KEY);
    const cached = etag ? await getCachedDashboard() : null;
    const headers: Record<string, string> = { ...auth };
    if (etag && cached) headers['If-None-Match'] = etag;   // only revalidate when we can serve the cache
    const response = await axios.get(`${API_BASE}/ai-hub/dashboard`, {
      headers,
      validateStatus: (s) => (s >= 200 && s < 300) || s === 304,
    });
    if (response.status === 304 && cached) return cached;
    const dashboard: DashboardEntry[] = response.data?.dashboard || [];
    try {
      await AsyncStorage.setItem(DASH_CACHE_KEY, JSON.stringify(dashboard));
      const newTag = response.headers?.etag;
      if (newTag) await AsyncStorage.setItem(DASH_ETAG_KEY, String(newTag));
      else await AsyncStorage.removeItem(DASH_ETAG_KEY);
    } catch { /* cache write is best-effort (payload can exceed the store's limits) */ }
    return dashboard;
  } catch (error: unknown) {
    const msg = axios.isAxiosError(error)
      ? error.response?.data?.error ?? error.message
      : 'Failed to fetch AI Hub dashboard';
    throw new Error(msg);
  }
}

/**
 * Paged jobs for one employer ("Show more jobs") — same job shape as the dashboard list.
 * Never throws into the UI.
 */
export async function fetchEmployerJobs(
  employerId: string,
  offset: number,
  limit = 40,
): Promise<{ jobs: Job[]; total: number; offset: number }> {
  try {
    const headers = await getAuthHeader();
    const r = await axios.get(`${API_BASE}/ai-hub/dashboard/employer/${employerId}/jobs`, {
      headers, params: { offset, limit }, timeout: 30000,
    });
    return { jobs: r.data?.jobs || [], total: r.data?.total || 0, offset: r.data?.offset ?? offset };
  } catch {
    return { jobs: [], total: 0, offset };
  }
}

/**
 * Full-fidelity job record (ALL responsibilities/skills/contacts). The dashboard list ships a
 * slimmed copy for speed; the detail screen hydrates from here. Never throws into the UI.
 */
export async function fetchJobFull(jobId: string): Promise<{ job: Job; employer?: Employer } | null> {
  try {
    const headers = await getAuthHeader();
    const r = await axios.get(`${API_BASE}/ai-hub/jobs/${jobId}/full`, { headers, timeout: 20000 });
    return r.data && r.data.job ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * Background job-match scorer. POSTs the visible job ids; returns a { jobId: 0..100 }
 * map for the ones just scored (server caches them, so each job is scored once).
 * Never throws into the UI — returns empty scores on any failure.
 */
export async function fetchJobMatchScores(
  jobIds: string[],
): Promise<{ scores: Record<string, number>; noProfile?: boolean }> {
  try {
    if (!jobIds || !jobIds.length) return { scores: {} };
    const headers = await getAuthHeader();
    const response = await axios.post(
      `${API_BASE}/ai-hub/match-scores`,
      { jobIds },
      { headers, timeout: 60000 },
    );
    return {
      scores: (response.data && response.data.scores) || {},
      noProfile: !!(response.data && response.data.noProfile),
    };
  } catch {
    return { scores: {} };
  }
}

/**
 * Returns the user's current credit balance.
 * Uses the main credits endpoint which handles expiry correctly.
 */
export async function fetchCreditBalance(): Promise<number> {
  try {
    const headers = await getAuthHeader();
    // Credits routes are mounted at /api (not /api/credits), so path is /api/user/credits
    const response = await axios.get(`${API_BASE}/user/credits`, { headers });
    // Response shape: { success, balance, credits: { remaining, ... } }
    return response.data.credits?.remaining ?? response.data.balance ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Deducts `amount` credits from the user's balance after a successful search.
 * Returns the new balance.
 */
export async function deductSearchCredits(amount: number): Promise<number> {
  try {
    const headers = await getAuthHeader();
    // Send the event key so the SERVER decides the (admin-configurable) cost; `amount`
    // stays as a backward-compatible fallback.
    const response = await axios.post(
      `${API_BASE}/ai-hub/deduct-credits`,
      { amount, eventKey: 'company_search' },
      { headers }
    );
    return response.data.balance ?? 0;
  } catch (error: unknown) {
    const msg = axios.isAxiosError(error)
      ? error.response?.data?.error ?? error.message
      : 'Failed to deduct credits';
    throw new Error(msg);
  }
}

/**
 * Removes an employer job from the user's dashboard.
 */
export async function removeDashboardItem(jobId: string): Promise<void> {
  try {
    const headers = await getAuthHeader();
    await axios.delete(`${API_BASE}/ai-hub/dashboard/${jobId}`, {
      headers,
    });
  } catch (error: unknown) {
    const msg = axios.isAxiosError(error)
      ? error.response?.data?.error ?? error.message
      : `Failed to remove dashboard item ${jobId}`;
    throw new Error(msg);
  }
}

// ── Recruiter types ───────────────────────────────────────────────────────────
export type Recruiter = {
  id: number;
  employer_id: string;
  name: string;
  role: string | null;
  linkedin_url: string | null;
  email: string | null;
  email_verified: boolean;
  created_at: string;
};

/**
 * Fetch saved recruiters for an employer.
 */
export async function getRecruiters(employerId: string): Promise<Recruiter[]> {
  try {
    const headers = await getAuthHeader();
    const response = await axios.get(
      `${API_BASE}/ai-hub/employers/${employerId}/recruiters`,
      { headers }
    );
    return response.data.recruiters ?? [];
  } catch {
    return [];
  }
}

/**
 * Step 1 — Find recruiters on LinkedIn via Gemini Google Search. Costs 1 credit.
 */
export async function findRecruiters(
  employerId: string
): Promise<{ recruiters: Recruiter[]; creditsUsed: number }> {
  const headers = await getAuthHeader();
  // Runs as a background job (up to ~60s of Gemini search) — survives the app being minimized.
  const { data } = await axios.post(
    `${API_BASE}/ai-hub/employers/${employerId}/find-recruiters`,
    { __async: true },
    { headers, timeout: 30000 }
  );
  if (!data?.jobId) return data;   // sync fallback
  return pollUntilDone(data.jobId, headers as Record<string, string>);
}

/**
 * Step 2 — Find & verify work emails for saved recruiters. Costs 1 credit.
 */
export async function findRecruiterEmails(
  employerId: string
): Promise<{ results: Recruiter[]; creditsUsed: number }> {
  const headers = await getAuthHeader();
  // Background job (up to ~120s of SMTP verification) — survives the app being minimized.
  const { data } = await axios.post(
    `${API_BASE}/ai-hub/employers/${employerId}/find-emails`,
    { __async: true },
    { headers, timeout: 30000 }
  );
  if (!data?.jobId) return data;   // sync fallback
  return pollUntilDone(data.jobId, headers as Record<string, string>);
}

// ── Job Cover Letter Persistence ─────────────────────────────────────────────

export type JobCLRecord = {
  job_id: string;
  cover_letter_html: string;
  company_name: string;
  website_url: string;
  position: string;
  company_address: string;
  company_locations: string; // JSON array of {address,city,country,isHeadquarters}
  status: 'generated' | 'downloaded' | 'applied';
  updated_at: string;
};

export async function saveJobCoverLetter(jobId: string, data: {
  coverLetterHtml: string; companyName: string; websiteUrl: string; position: string;
  companyAddress?: string; companyLocations?: Array<{ address: string; city: string; country: string; isHeadquarters: boolean; matchesJobLocation?: boolean }>;
}): Promise<boolean> {
  try {
    const headers = await getAuthHeader();
    await axios.post(`${API_BASE}/ai-hub/jobs/${jobId}/cover-letter`, data, { headers });
    return true;
  } catch (e: any) {
    // ⚠️ Was a bare `catch {}`. A cover letter costs the user credits and a minute of waiting, and
    // a failed save looked EXACTLY like a successful one until they reopened the job and found it
    // gone — with nothing anywhere to say why. Still non-throwing (no caller can do anything about
    // it mid-flow), but never again silent.
    console.warn('[aiHub] saveJobCoverLetter failed for', jobId, '→',
      e?.response?.status || '', e?.response?.data?.error || e?.message || e);
    return false;
  }
}

export async function loadJobCoverLetter(jobId: string): Promise<JobCLRecord | null> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE}/ai-hub/jobs/${jobId}/cover-letter`, { headers });
    return data.coverLetter ?? null;
  } catch { return null; }
}

export async function updateJobCLStatus(jobId: string, status: 'generated' | 'downloaded' | 'applied'): Promise<void> {
  try {
    const headers = await getAuthHeader();
    await axios.patch(`${API_BASE}/ai-hub/jobs/${jobId}/cover-letter/status`, { status }, { headers });
  } catch {}
}

export async function loadJobStatuses(employerId: string): Promise<Record<string, string>> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE}/ai-hub/employers/${employerId}/job-statuses`, { headers });
    return data.statuses ?? {};
  } catch { return {}; }
}

/** Applied/CL statuses for ALL jobs in ONE call (was one request per tracked employer). */
export async function loadAllJobStatuses(): Promise<Record<string, string>> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE}/ai-hub/job-statuses`, { headers, timeout: 20000 });
    return data.statuses ?? {};
  } catch { return {}; }
}

// First-run setup completeness (profile / résumé / photo / signature booleans the server derives on
// GET /users/profile). Drives the help assistant's proactive guide. Null = not signed in / offline —
// callers must treat null as "unknown" and stay silent, never as "nothing is set up".
export type SetupStatus = { profile: boolean; resume: boolean; photo: boolean; signature: boolean; complete: boolean };
export async function fetchSetupStatus(): Promise<SetupStatus | null> {
  try {
    const headers = await getAuthHeader();
    if (!(headers as any).Authorization) return null;
    const { data } = await axios.get(`${API_BASE}/users/profile`, { headers, timeout: 15000 });
    return (data && data.setup) ? data.setup as SetupStatus : null;
  } catch { return null; }
}

// ── Universal job capture ──────────────────────────────────────────────────────
// Persist a live/web job's REAL details (AI-extracted from the page text when thin) so the cover
// letter is written from the actual posting, and — when track:true — the job appears in My Jobs.
// Returns the canonical DB jobId (UUID) to use for all cover-letter + status calls from then on.
export type CaptureJobInput = {
  url: string;
  title?: string;
  company?: string;
  companyDomain?: string;
  location?: string;
  jobType?: string;
  workMode?: string | null;
  experience?: string;
  salary?: string;
  responsibilities?: string[];
  skills?: string[];
  description?: string;
  matchScore?: number | null;
  pageText?: string;    // the job page's visible innerText (for AI extraction when card fields are thin)
  mainText?: string;    // just the main/article region, when the page marks one up (less nav/footer/other-role noise)
  track?: boolean;      // true → add to My Jobs (fired on Generate-CL / successful submit)
};
export type CapturedJob = {
  id: string; title: string; company: string; location: string;
  jobType: string; workMode: string; experience: string; salary: string;
  responsibilities: string[]; skills: string[]; description: string; url: string;
  contacts?: Contact[];   // "To apply, email …" — captured from the page's apply instructions
};
export async function captureJob(
  input: CaptureJobInput
): Promise<{ jobId: string; job: CapturedJob; tracked: boolean } | null> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.post(`${API_BASE}/ai-hub/jobs/capture`, input, { headers, timeout: 30000 });
    if (data && data.jobId) return { jobId: String(data.jobId), job: data.job as CapturedJob, tracked: !!data.tracked };
    return null;
  } catch {
    return null;   // graceful: pre-deploy 404 / offline → caller falls back to the synthetic id
  }
}

/**
 * Generate a cover letter for a specific job using the existing cover letter pipeline.
 * Uses /api/generate-cover-letter-details (same as Letters page) — returns jobId for polling.
 */
export async function startJobCoverLetter(
  websiteUrl: string,
  position: string,
  responsibilities?: string[],
  jobLocation?: string,
  jobId?: string,
  companyName?: string
): Promise<string> {
  const headers = await getAuthHeader();
  const body: Record<string, any> = { websiteUrl, position, recipientEmail: '' };
  // The employer's real name. When the only URL we have is a job board (instahyre/naukri/…), the
  // server researches THIS instead of the board — otherwise the letter is addressed to the board.
  if (companyName && companyName.trim()) body.companyName = companyName.trim();
  if (responsibilities && responsibilities.length > 0) body.responsibilities = responsibilities;
  if (jobLocation && jobLocation.trim()) body.jobLocation = jobLocation.trim();
  // The dashboard list ships a slimmed job (3 responsibilities) — sending the jobId lets the
  // server swap in the FULL stored list, so letter quality never depends on client hydration.
  if (jobId) body.jobId = jobId;
  // x-device-id joins the request so the server's trial quota is per-DEVICE (one 7-day trial per
  // phone, not per email). Absent on failure → server falls back to per-user trial.
  let devHeaders: Record<string, string> = {};
  try { devHeaders = await require('./deviceId').deviceHeader(); } catch {}
  const response = await axios.post(
    `${API_BASE}/generate-cover-letter-details`,
    body,
    { headers: { ...headers, ...devHeaders }, timeout: 30000 }
  );
  // Returns { jobId } in async mode or full result in sync mode
  if (response.data?.jobId) return response.data.jobId;
  // Sync mode — wrap result so pollJobCoverLetter can return it directly
  return '__sync__' + JSON.stringify(response.data);
}

/**
 * Poll until the cover letter job is complete. Returns coverLetterHtml.
 */
export async function pollJobCoverLetter(
  jobId: string,
  onProgress?: () => void
): Promise<{ coverLetterHtml: string; companyName: string; subject: string; locations?: Array<{ address: string; city: string; country: string; isHeadquarters: boolean; matchesJobLocation?: boolean }> }> {
  // Sync mode shortcut
  if (jobId.startsWith('__sync__')) {
    return JSON.parse(jobId.slice(8));
  }
  const headers = await getAuthHeader();
  // Must always SETTLE (mirrors pollUntilDone): a hard deadline + give-up on consecutive 404/401
  // (job row gone after a redeploy / expired session). Without these, a vanished job left the
  // promise pending forever — button stuck on "loading", polling in the background until restart.
  const DEADLINE_MS = 5 * 60 * 1000;
  const startedAt = Date.now();
  let gone = 0;   // consecutive 404/401 responses
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (Date.now() - startedAt > DEADLINE_MS) {
        reject(new Error('This is taking longer than expected. Please try again.'));
        return;
      }
      try {
        const { data } = await axios.get(`${API_BASE}/job-status/${jobId}`, { headers });
        gone = 0;
        if (data.status === 'completed') {
          resolve(data.data);
        } else if (data.status === 'failed') {
          reject(new Error(data.error || 'Cover letter generation failed'));
        } else {
          onProgress?.();
          setTimeout(tick, 2500);
        }
      } catch (err) {
        if (axios.isAxiosError(err) && [401, 404].includes(err.response?.status ?? 0)) {
          gone += 1;
          if (gone >= 2) {
            reject(new Error('We lost track of this generation. Please try again.'));
            return;
          }
        }
        setTimeout(tick, 2500);
      }
    };
    tick();
  });
}

// ── AI event credit costs (admin-configurable) ──────────────────────────────
export type AiEventCost = {
  id: number; event_key: string; label: string; description: string;
  category: string; direction?: string; credits: number; is_active: number; sort_order: number;
};

let _eventCostsCache: Record<string, number> | null = null;

/** Public { event_key: credits } map, for showing the cost on each spending button. */
export async function fetchEventCosts(force = false): Promise<Record<string, number>> {
  if (_eventCostsCache && !force) return _eventCostsCache;
  try {
    const { data } = await axios.get(`${API_BASE}/ai-event-costs`);
    _eventCostsCache = (data && data.costs) || {};
    return _eventCostsCache!;
  } catch {
    return _eventCostsCache || {};
  }
}

/** Admin: full catalog (requires admin token). */
export async function fetchAdminAiEvents(): Promise<AiEventCost[]> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE}/admin/ai-event-costs`, { headers });
  return (data && data.events) || [];
}

/** Admin: send (or dry-run preview) a reward push nudge. dryRun=true returns { wouldTarget } without sending;
 *  testSelf=true sends ONLY to the admin's own device (ignores filters) for previewing before a mass send. */
export async function sendRewardNudge(nudgeKey: string, dryRun: boolean, testSelf = false): Promise<{ wouldTarget?: number; sent?: number; targeted?: number; credits?: number; test?: boolean; reason?: string; error?: string }> {
  const headers = await getAuthHeader();
  const { data } = await axios.post(`${API_BASE}/admin/reward-nudge`, { nudgeKey, dryRun, testSelf }, { headers, timeout: 30000 });
  return data || {};
}

// Admin Store Analytics (Apple App Store + Google Play downloads + recorded transactions).
export type StoreAnalytics = {
  generatedAt: string;
  storeAsOf?: string;
  apple: { configured: boolean; pending?: boolean; reason?: string; note?: string; report?: string; processingDate?: string; totalDownloads?: number; firstTime?: number; redownloads?: number; series?: { date: string; downloads: number }[] };
  google: { configured: boolean; reason?: string; note?: string; month?: string; totalInstalls?: number; totalUninstalls?: number; totalUserUninstalls?: number; activeInstalls?: number; netInstalls?: number; series?: { date: string; installs: number; uninstalls?: number }[] };
  local: { byPlatform?: { platform: string; currency: string; txns: number; paying_users: number; revenue: string }[]; completedTxns?: { last_24h: number; last_7d: number; last_30d: number; all_time: number }; txnWindows?: { [k: string]: { txns: number; revenue: number; inr?: number } }; recent?: any[]; credits?: { credits_sold: number; purchase_events: number }; error?: string };
  live?: {
    activeNow?: { total: number; byPlatform?: { platform: string; users: number }[] };
    activeToday?: { total: number; byPlatform?: { platform: string; users: number }[] };
    opens?: { last_hour: number; last_24h: number; unique_24h: number };
    newInstalls?: { last_hour: number; last_24h: number; last_7d: number; all_time: number };
    newInstallsByPlatform?: { platform: string; installs: number }[];
    uninstalls?: { last_hour: number; last_24h: number; last_7d: number; all_time: number };
    uninstallsByPlatform?: { platform: string; uninstalls: number }[];
    netInstalls?: { last_24h: number; last_7d: number; all_time: number };
    lifecycle?: { events?: { store: string; event: string; d1: number; d7: number; all_time: number }[]; refunds?: { d1: number; d7: number; all_time: number }; subsNetEst?: number };
    topEvents?: { event: string; n: number }[];
    hourly?: { hour: string; users: number }[];
    byCountry?: { country: string; users: number }[];
    recent?: { event: string; platform: string; user_id: number; created_at: string }[];
    purchasesToday?: { platform: string; currency: string; n: number; revenue: string }[];
    opensByPlatform?: { platform: string; opens: number }[];
    deltas?: { installs: number; uninstalls: number; opens: number; active: number };
    byVersion?: { version: string; total: number; ios: number; android: number }[];
    series?: { day: string; platform: string; installs: number; uninstalls: number; opens: number; purchases: number; revenue: number }[];
    storeNotifications?: { store: string; notification_type: string; subtype?: string; event?: string; product_id: string; price?: number; currency?: string; environment?: string; created_at: string }[];
    totalEvents?: number;
    error?: string;
  };
};
export async function fetchStoreAnalytics(): Promise<StoreAnalytics> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE}/admin/store-analytics`, { headers });
  return data;
}

/** Admin: run an uninstall-detection sweep (silent push + receipts → DeviceNotRegistered). */
export async function runUninstallSweep(): Promise<{ checked: number; uninstalled: number; pendingReceipts: number }> {
  const headers = await getAuthHeader();
  const { data } = await axios.post(`${API_BASE}/admin/uninstall-sweep`, {}, { headers, timeout: 30000 });
  return data;
}

// ── Admin: Registered Users ─────────────────────────────────────────────────────
export type RegisteredUser = {
  id: number;
  email: string;
  full_name: string | null;
  oauth_provider: string | null;
  auth_type: 'Gmail' | 'Microsoft' | 'Apple' | 'Email';
  registered_at: string;
  profile_complete: number;   // 0..6
  has_resume: boolean;
  has_photo: boolean;
  has_signature: boolean;
  cover_letters: number;
  job_searches: number;
  applications: number;
  replies: number;
  credits: number;
};
export type UsersListResponse = {
  success: boolean;
  users: RegisteredUser[];
  total: number;
  offset: number;
  limit: number;
  byProvider: { auth_type: string; n: number }[];
};

/** Admin: paginated registered-users list with sign-in type + per-user usage. */
export async function fetchUsersList(
  opts: { q?: string; limit?: number; offset?: number } = {},
): Promise<UsersListResponse> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE}/admin/users-list`, {
    headers,
    params: { q: opts.q || '', limit: opts.limit ?? 50, offset: opts.offset ?? 0 },
    timeout: 30000,
  });
  return data;
}

// ── Admin: Per-user journeys + timeline ─────────────────────────────────────────
export type UserJourney = {
  uid: string;
  user_id: number | null;
  first_seen: string;
  last_seen: string;
  events: number;
  signups: number;
  platform: string | null;
  country: string | null;
  provider: string | null;
  email: string | null;
  full_name: string | null;
};
export type TimelineEvent = {
  id: number;
  event: string;
  props: any;
  platform: string | null;
  app_version: string | null;
  country: string | null;
  created_at: string;
};
export type UserTimeline = {
  profile: {
    id: number; full_name: string | null; email: string; created_at: string;
    oauth_provider: string | null; has_resume?: boolean; has_photo?: boolean; has_signature?: boolean;
  } | null;
  events: TimelineEvent[];   // oldest → newest
  rollup: { event: string; n: number; last: string }[];
  purchases: { store: string; event: string; product_id: string | null; price: number | null; currency: string | null; created_at: string }[];
};

/** Admin: recent user/device journeys (searchable). */
export async function fetchUserJourneys(
  opts: { q?: string; limit?: number; offset?: number; sort?: 'recent' | 'events' | 'name' } = {},
): Promise<{ users: UserJourney[]; total?: number; hasMore?: boolean; offset?: number }> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE}/admin/user-journeys`, {
    headers,
    // `sort` goes to the SERVER on purpose. Ranking a page client-side ranks only what happened to
    // load, so "most events" could never surface the heaviest user unless they were also recently
    // active — exactly the flaw the first version of the sort chips shipped with.
    params: { q: opts.q || '', limit: opts.limit ?? 60, offset: opts.offset ?? 0, sort: opts.sort || 'recent' },
    timeout: 30000,
  });
  return data;
}

/** Admin: full event timeline for one user (by userId) or anonymous device (by anonId). */
export async function fetchUserTimeline(
  opts: { userId?: number | string | null; anonId?: string | null; limit?: number } = {},
): Promise<UserTimeline> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE}/admin/user-timeline`, {
    headers,
    params: { userId: opts.userId ?? '', anonId: opts.anonId ?? '', limit: opts.limit ?? 300 },
    timeout: 30000,
  });
  return data;
}

// ── Admin: push-alert settings (new install / registration / purchase) ──────────
export type AdminNotifySettings = { installs: boolean; registrations: boolean; purchases: boolean };

/** Admin: current push-alert toggles. */
export async function fetchAdminNotifySettings(): Promise<AdminNotifySettings> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE}/admin/notification-settings`, { headers, timeout: 20000 });
  return data.settings || { installs: true, registrations: true, purchases: true };
}

/** Admin: update one or more push-alert toggles. Returns the saved settings. */
export async function updateAdminNotifySettings(patch: Partial<AdminNotifySettings>): Promise<AdminNotifySettings> {
  const headers = await getAuthHeader();
  const { data } = await axios.put(`${API_BASE}/admin/notification-settings`, patch, { headers, timeout: 20000 });
  return data.settings || { installs: true, registrations: true, purchases: true };
}

// ── Admin: forced-upgrade gate ──────────────────────────────────────────────────
// One target build per platform plus a single `mandatory` switch: ON hard-blocks anything older,
// OFF shows a dismissible "there's an update" sheet. target 0 = the gate is off for that platform.
export type VersionGate = {
  ios_target_build: number; android_target_code: number; mandatory: boolean;
  title?: string | null; message?: string | null; updated_at?: string | null;
};

export async function fetchVersionGate(): Promise<VersionGate> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE}/admin/version-gate`, { headers, timeout: 20000 });
  const g = data?.gate || {};
  return {
    ios_target_build: Number(g.ios_target_build) || 0,
    android_target_code: Number(g.android_target_code) || 0,
    mandatory: !!g.mandatory,
    title: g.title, message: g.message, updated_at: g.updated_at,
  };
}

export async function saveVersionGate(patch: Partial<VersionGate>): Promise<VersionGate> {
  const headers = await getAuthHeader();
  const { data } = await axios.post(`${API_BASE}/admin/version-gate`, patch, { headers, timeout: 20000 });
  const g = data?.gate || {};
  return {
    ios_target_build: Number(g.ios_target_build) || 0,
    android_target_code: Number(g.android_target_code) || 0,
    mandatory: !!g.mandatory,
    title: g.title, message: g.message, updated_at: g.updated_at,
  };
}

/** Admin: fire a test push to all admin devices. */
export async function sendAdminTestNotification(): Promise<{ sent: number; admins?: number }> {
  const headers = await getAuthHeader();
  const { data } = await axios.post(`${API_BASE}/admin/notification-test`, {}, { headers, timeout: 20000 });
  return (data && data.result) || { sent: 0 };
}

// ── Admin: kill switches for USER-facing automated pushes (interest/résumé match, reminders…) ──
export type UserNotifSwitch = {
  key: string; label: string; icon: string; description: string;
  enabled: boolean; sent24h: number; sent7d: number;
};

/** Admin: every automated user push category with its on/off state and sent counts. */
export async function fetchUserNotifSwitches(): Promise<UserNotifSwitch[]> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE}/admin/user-notification-switches`, { headers, timeout: 20000 });
  return (data?.switches ?? []) as UserNotifSwitch[];
}

/** Admin: flip one user-push category on/off (takes effect server-side within a minute). */
export async function setUserNotifSwitch(key: string, enabled: boolean): Promise<boolean> {
  const headers = await getAuthHeader();
  const { data } = await axios.put(`${API_BASE}/admin/user-notification-switches/${encodeURIComponent(key)}`, { enabled }, { headers, timeout: 20000 });
  return !!data?.enabled;
}

// ── Discover: value-first global job feed (browse real jobs before any setup) ────
export type DiscoverJob = {
  id: string; title: string; company: string | null; employer_name: string | null; employer_domain: string | null;
  location: string | null; work_mode: string | null; job_type: string | null; salary: string | null; experience: string | null;
  responsibilities: string[]; skills: string[]; job_url: string; source: string | null; country: string | null;
  field?: string | null; role_category?: string | null; seniority?: string | null;
  match?: number | null;   // résumé skill-match 0..100 (null = job lists no skills / no résumé)
};
export type DiscoverResponse = {
  success: boolean; jobs: DiscoverJob[]; total: number; offset: number; limit: number; hasMore: boolean;
  noProfile?: boolean; sort?: string; userField?: string | null; userRoleCategory?: string | null;
  appliedField?: string | null; minMatch?: number;
};
export type DiscoverFacets = {
  total: number;
  fields: { field: string; n: number }[];
  roleCategories: { role_category: string; n: number }[];
  skills: { skill: string; n: number }[];
  employers: { employer_name: string; n: number }[];
  countries: { country: string; n: number }[];
  workModes: { work_mode: string; n: number }[];
  userField?: string | null;
  userRoleCategory?: string | null;
};

/** The browse feed of world jobs (from the ATS firehose). sort='match' ranks by résumé fit. */
export async function fetchDiscoverJobs(
  opts: {
    offset?: number; limit?: number; q?: string; country?: string; work_mode?: string; employer?: string;
    skill?: string; field?: string; role_category?: string; sort?: 'match' | 'recent'; min_match?: number;
  } = {},
): Promise<DiscoverResponse> {
  const headers = await getAuthHeader();
  const params: Record<string, string | number> = {
    offset: opts.offset ?? 0, limit: opts.limit ?? 20, q: opts.q || '', country: opts.country || '',
    work_mode: opts.work_mode || '', employer: opts.employer || '', skill: opts.skill || '',
    field: opts.field || '', role_category: opts.role_category || '', sort: opts.sort || 'match',
  };
  if (opts.min_match != null) params.min_match = opts.min_match;
  const { data } = await axios.get(`${API_BASE}/discover/jobs`, { headers, params, timeout: 25000 });
  return data;
}

/** ONE feed job by its synthetic 'gj_…' id — used when a tapped notification deep-links to a
 *  specific job. Returns null when the posting is gone (404) so the caller can say so instead of
 *  showing an error. */
export async function fetchDiscoverJobById(id: string): Promise<DiscoverJob | null> {
  const headers = await getAuthHeader();
  try {
    const { data } = await axios.get(`${API_BASE}/discover/job/${encodeURIComponent(id)}`, { headers, timeout: 20000 });
    return data?.success && data.job ? (data.job as DiscoverJob) : null;
  } catch (e: any) {
    if (axios.isAxiosError(e) && e.response?.status === 404) return null;
    throw e;
  }
}

export type AiSearchParsed = { keywords: string[]; field: string | null; location: string | null; workMode: string | null; seniority: string | null };
export type AiXray = { sites: string[]; terms: string[]; query: string; perSite: string[] };
export type AiSearchResponse = {
  success: boolean; urlDetected?: boolean; url?: string; parsed?: AiSearchParsed | null;
  jobs: DiscoverJob[]; total: number; offset: number; limit: number; hasMore: boolean;
  noProfile?: boolean; userField?: string | null; xray?: AiXray | null;
};

/** Hydrate ATS board links discovered by the on-device silent browser: the server pulls each board
 *  through the 24-ATS engine and ingests the jobs into the network. Returns how many were added. */
export async function hydrateJobUrls(urls: string[], query?: string): Promise<{ boards: number; hydrated: number; ingested: number }> {
  const headers = await getAuthHeader();
  const { data } = await axios.post(`${API_BASE}/discover/hydrate-urls`, { urls, query: query || '' }, { headers, timeout: 45000 });
  return data;
}

/** AI natural-language search over the saved network: breaks the sentence into role/location/etc,
 *  then returns matched jobs ranked by résumé fit. A pasted employer URL comes back as urlDetected. */
export async function aiSearchJobs(query: string, offset = 0, limit = 20, refresh = false): Promise<AiSearchResponse & { insufficient?: boolean; creditsRequired?: number; creditsRemaining?: number }> {
  const headers = await getAuthHeader();
  try {
    // `refresh` = an internal re-run (e.g. after silent web hydration) → backend skips the credit charge.
    const { data } = await axios.post(`${API_BASE}/discover/ai-search`, { query, offset, limit, refresh }, { headers, timeout: 30000 });
    return data;
  } catch (e: any) {
    if (axios.isAxiosError(e) && e.response?.status === 402) {
      return { insufficient: true, creditsRequired: e.response.data?.creditsRequired, creditsRemaining: e.response.data?.creditsRemaining, jobs: [], total: 0, parsed: null, hasMore: false } as any;
    }
    throw e;
  }
}

// ── "Look for live jobs on Google" — user-triggered live search → our-style cards ─────────────
export type LiveJobCard = {
  id: string; job_url: string; title: string; company: string | null; employer_name: string | null;
  location: string | null; work_mode: string | null; job_type: string | null; salary: string | null;
  experience: string | null; responsibilities: string[]; skills: string[]; source: string | null; highlights: string[];
  saved?: boolean; summary?: string | null; match?: number | null;   // résumé skill-match 0..100 (null = no résumé)
};

/** Grounded live web search → structured job CARDS (the raw web page is never shown). Worldwide (any
 *  city/country) via Google-Search grounding, which can run ~40-50s for a novel query — so allow 75s. */
export async function liveSearchJobs(query: string): Promise<{ parsed: AiSearchParsed | null; cards: LiveJobCard[]; count: number }> {
  const headers = await getAuthHeader();
  const { data } = await axios.post(`${API_BASE}/discover/live-search`, { query }, { headers, timeout: 75000 });
  return { parsed: data?.parsed ?? null, cards: (data?.cards ?? []) as LiveJobCard[], count: data?.count ?? 0 };
}

/** Fetch ONE job's full details from the on-device-scraped page HTML → stores it → returns a rich card. */
export async function fetchJobDetail(url: string, html: string, company?: string, pageText?: string, mainText?: string): Promise<LiveJobCard | null> {
  const headers = await getAuthHeader();
  try {
    // pageText = the page's VISIBLE text. SPA / iframe-hosted boards render the job where outerHTML
    // can't see it, so the server falls back to extracting from this when the HTML yields nothing.
    // mainText = just the main/article region when the page marks one up, so the extractor isn't
    // reading the nav, the footer and the "more open roles" cards alongside the posting.
    const { data } = await axios.post(`${API_BASE}/discover/fetch-detail`, { url, html, company: company || '', pageText: pageText || '', mainText: mainText || '' }, { headers, timeout: 45000 });
    return data?.success && data.job ? (data.job as LiveJobCard) : null;
  } catch (e: any) {
    if (axios.isAxiosError(e) && e.response?.status === 402) {
      const err: any = new Error('insufficient_credits');
      err.insufficient = true; err.creditsRemaining = e.response.data?.creditsRemaining;
      throw err;
    }
    throw e;
  }
}

export type SavedJobCard = LiveJobCard & { saved_at?: string };

// The user's Saved Jobs — every posting fetched via live search is stored server-side.
export async function fetchSavedJobs(): Promise<{ jobs: SavedJobCard[]; count: number }> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE}/discover/saved-jobs`, { headers, timeout: 20000 });
  return { jobs: (data?.jobs ?? []) as SavedJobCard[], count: data?.count ?? 0 };
}

export async function removeSavedJob(url: string): Promise<void> {
  const headers = await getAuthHeader();
  await axios.post(`${API_BASE}/discover/saved-jobs/remove`, { url }, { headers, timeout: 15000 });
}

// Save a card directly (fallback when detail-fetch fails) so every selected job still lands in Saved Jobs.
export async function saveCard(card: LiveJobCard): Promise<void> {
  const headers = await getAuthHeader();
  await axios.post(`${API_BASE}/discover/save-card`, { card }, { headers, timeout: 15000 });
}

/** Filter chips for the feed. Pass `field` to get the role categories within that field. */
export async function fetchDiscoverFacets(field?: string): Promise<DiscoverFacets> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE}/discover/facets`, {
    headers, params: { field: field || '' }, timeout: 20000,
  });
  return data;
}

/** Admin: change an event's credit cost and/or active flag. */
export async function updateAiEventCost(eventKey: string, credits: number, isActive: boolean): Promise<void> {
  const headers = await getAuthHeader();
  await axios.put(
    `${API_BASE}/admin/ai-event-costs/${encodeURIComponent(eventKey)}`,
    { credits, is_active: isActive ? 1 : 0 },
    { headers }
  );
  _eventCostsCache = null; // refresh labels next read
}

// ── Admin: user credit management ────────────────────────────────────────────
export type AdminUser = { id: number; email: string; full_name: string; credits_remaining: number };

/** Admin: typeahead search users by email substring. */
export async function adminSearchUsers(q: string): Promise<AdminUser[]> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE}/admin/users/search`, { params: { q }, headers });
  return (data && data.users) || [];
}

/** Admin: set a user's remaining credits; returns the new balance. */
export async function adminSetUserCredits(userId: number, credits: number): Promise<number> {
  const headers = await getAuthHeader();
  const { data } = await axios.put(`${API_BASE}/admin/users/${userId}/credits`, { credits }, { headers });
  return data?.credits_remaining ?? credits;
}

// ── Self-improving employer fix loop ────────────────────────────────────────
export type EmployerFixOverride = {
  id: number; version: number; fixConfig: any; verified: boolean;
  verifyJobCount: number; verifySample?: any[]; createdBy: string; notes?: string; active?: boolean; createdAt?: string;
};
export type EmployerFixRequest = {
  id: number; email?: string; employerInput: string; domain: string;
  detectedAts?: string; jobCount: number; status: string; diagnosis?: any; attempts: number;
  createdAt?: string; resolvedAt?: string; activeOverride?: EmployerFixOverride | null;
};

/** User: ask us to learn an employer we couldn't fetch. Returns the request id. */
export async function submitEmployerFixRequest(employerInput: string): Promise<{ requestId: number; status: string }> {
  const headers = await getAuthHeader();
  const { data } = await axios.post(`${API_BASE}/ai-hub/fix-requests`, { employerInput }, { headers });
  return { requestId: data?.requestId, status: data?.status || 'investigating' };
}

/** User: poll a fix request's status (app re-runs the search when 'resolved'). */
export async function getFixRequestStatus(id: number): Promise<{ status: string; jobCount: number; resolved: boolean }> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE}/ai-hub/fix-requests/${id}`, { headers });
  return { status: data?.status, jobCount: data?.jobCount || 0, resolved: !!data?.resolved };
}

/** Admin: list every employer fix request with its active fix. */
export async function adminListEmployerRequests(): Promise<EmployerFixRequest[]> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE}/admin/employer-requests`, { headers });
  return (data && data.requests) || [];
}

/** Admin: run / re-run the diagnostic agent ("rethink") on a request. */
export async function adminInvestigateRequest(id: number): Promise<any> {
  const headers = await getAuthHeader();
  const { data } = await axios.post(`${API_BASE}/admin/employer-requests/${id}/investigate`, {}, { headers });
  return data?.result;
}

/** Admin: full version history for a request's domain. */
export async function adminOverrideHistory(id: number): Promise<{ domain: string; overrides: EmployerFixOverride[] }> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE}/admin/employer-requests/${id}/overrides`, { headers });
  return { domain: data?.domain, overrides: (data && data.overrides) || [] };
}

/** Admin: roll back / re-apply a specific override version. */
export async function adminActivateOverride(overrideId: number): Promise<void> {
  const headers = await getAuthHeader();
  await axios.post(`${API_BASE}/admin/employer-overrides/${overrideId}/activate`, {}, { headers });
}

/** Admin: turn the fix OFF for a request's domain. */
export async function adminDeactivateOverride(requestId: number): Promise<void> {
  const headers = await getAuthHeader();
  await axios.post(`${API_BASE}/admin/employer-requests/${requestId}/deactivate`, {}, { headers });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Admin USER OPS — a 360° view of ONE user + targeted / segment push sends.
// Backend: server/routes/adminUserOpsRoutes.js (every route behind authenticateAdmin),
// logic in server/services/adminUserOps.js. Read-mostly; the two POSTs actually reach
// real phones, so read the guard-rail comments on them before wiring a button.
// ADDITIVE — nothing above this line was changed.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * These endpoints answer with a real explanation ("User not found (or soft-deleted)",
 * "kind must be one of: …") — an admin screen is useless if it can only say
 * "Request failed with status code 404", so surface the server's own message.
 * The HTTP status is attached as `.status` for callers that need to branch on 404.
 */
function adminErr(error: unknown, fallback: string): Error {
  if (axios.isAxiosError(error)) {
    const d = error.response?.data as { error?: string; message?: string } | undefined;
    const e: any = new Error(d?.error || d?.message || error.message || fallback);
    e.status = error.response?.status;
    return e;
  }
  return new Error(fallback);
}

// ── 1. GET /api/admin/users/:id/overview ────────────────────────────────────────
export type AdminOverviewUser = {
  id: number; full_name: string | null; email: string; phone_number: string | null;
  date_of_birth: string | null; address: string | null; city: string | null; country: string | null;
  gender: string | null; nationality: string | null; oauth_provider: string | null; role: string | null;
  created_at: string; last_seen_at: string | null;
  registration_ip: string | null; last_login_ip: string | null;
};
export type AdminUserAsset = { has: boolean; url: string | null; filename: string | null };
export type AdminUserAssets = { resume: AdminUserAsset; photo: AdminUserAsset; signature: AdminUserAsset };
export type AdminCreditTxn = { amount: number | null; type: string | null; created_at: string; description: string | null };
export type AdminUserCredits = {
  remaining: number; total: number; expiry_date: string | null;
  last_purchase_date: string | null; recent: AdminCreditTxn[];
};
/** One metered feature's allowance and consumption for the CURRENT billing/refill period. */
export type AdminPlanQuota = {
  kind: 'cover_letter' | 'resume';
  label: string;
  /** The plan's own allowance before any admin/reward bonus. */
  base: number;
  bonus: number;
  allowance: number;
  /** Used in this period, against THIS plan's pool. */
  used: number;
  remaining: number;
  /** Used in this period across every pool (incl. legacy credits) — always >= `used`. */
  used_any_pool: number;
  used_lifetime: number;
  last_used: string | null;
  /** Used exceeds allowance: the free résumé allowance dropped 2 → 1, so old usage can outrun it. */
  over: boolean;
};

/**
 * What the user is actually on TODAY. Read without side effects — deliberately NOT from
 * entitlements.getStatus(), which would create a trial row just by being asked.
 */
export type AdminUserPlan = {
  key: string;
  label: string;
  via: 'plan' | 'plan_unknown' | 'free' | null;
  status: 'paid' | 'unknown_plan' | 'free' | 'never_started';
  price_usd: number | null;
  source: string | null;
  store: string | null;
  environment: string | null;
  auto_renew: boolean | null;
  pending_plan_key: string | null;
  pending_label: string | null;
  period_start: string | null;
  period_end: string | null;
  window_start: string | null;
  window_end: string | null;
  window_days_left: number | null;
  free_since: string | null;
  /** A live store plan in the OTHER environment (Sandbox/TestFlight). Diagnostic only. */
  other_environment: string | null;
  quotas: AdminPlanQuota[];
  legacy: { remaining: number; total: number; expiry_date: string | null; last_purchase_date: string | null } | null;
  caveats: string[];
};

export type AdminUserResumeMeta = {
  parse_status: string | null; summary: string | null; skills: string[]; technical_skills: string[];
  soft_skills: string[]; experience_years: number | null; job_titles: string[]; industries: string[];
  education: any[]; languages: string[]; parsed_at: string | null;
};
export type AdminUserActivityCounts = {
  saved_jobs: number;
  /** ⚠️ A UNION of two records of the SAME act — see fetchAdminUserActivity('applications').meta. */
  applications: number;
  cover_letters: number; searches: number; events_30d: number;
  first_event: string | null; last_event: string | null;
};
/** The five notification_preferences columns. false = the user opted OUT of that category. */
export type AdminNotifyPrefs = {
  replies: boolean; application_updates: boolean; reminders: boolean; digest: boolean; marketing: boolean;
};
/** Why push cannot reach this user. null when it can. `fixable` = is it an admin's to fix at all. */
export type AdminPushBlock = {
  code: 'never_opened_app' | 'android_no_fcm' | 'notifications_off';
  label: string; detail: string; fixable: boolean;
};
export type AdminUserPush = {
  has_token: boolean; platform: string | null; app_version?: string | null;
  block?: AdminPushBlock | null; preferences: AdminNotifyPrefs;
};
export type AdminUserCompleteness = { percent: number; missing: string[] };
export type AdminUserNotification = {
  type: string | null; title: string | null; message: string | null; created_at: string; is_read: boolean;
};
export type AdminSendLogEntry = {
  template_key: string; title: string | null; created_at: string; sent_by: number | null;
  sent_by_email: string | null; push_ok: boolean; push_error: string | null; batch_id: string | null;
};
export type AdminUserInsights = {
  field: string | null; role_category: string | null; strong_matches: number;
  top_match: AdminMatchedJob | null; days_since_last_seen: number | null;
  days_since_signup: number | null; has_parsed_resume: boolean;
};
export type AdminUserOverview = {
  success: boolean;
  user: AdminOverviewUser;
  assets: AdminUserAssets;
  /** The live entitlement. This — not `credits` — is what the user is on. */
  plan: AdminUserPlan;
  /** Legacy credit pool. Still a live fallback for grandfathered accounts, so kept, but secondary. */
  credits: AdminUserCredits;
  resume: AdminUserResumeMeta;
  activity: AdminUserActivityCounts;
  push: AdminUserPush;
  completeness: AdminUserCompleteness;
  recent_notifications: AdminUserNotification[];
  admin_sends: AdminSendLogEntry[];
  /** Derived signals, so the screen needs no second round-trip. */
  insights?: AdminUserInsights;
  /** Server-authored caveats about the numbers above — worth rendering verbatim. */
  notes?: string[];
};

/** Everything about one user: profile, files, credits, résumé, activity counts, push state. */
export async function fetchAdminUserOverview(userId: number | string): Promise<AdminUserOverview> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE}/admin/users/${userId}/overview`, { headers, timeout: 30000 });
    return data as AdminUserOverview;
  } catch (error: unknown) {
    throw adminErr(error, 'Failed to load user overview');
  }
}

// ── 2. GET /api/admin/users/:id/files/:kind ─────────────────────────────────────
export type AdminFileKind = 'resume' | 'photo' | 'signature';

/**
 * The absolute URL that streams a user's file. The route is admin-only, so a bare
 * `<Image source={{ uri }}>` / WebView `source={{ uri }}` gets a 401 — the caller MUST attach the
 * Authorization header itself (see adminAuthHeaderValue / adminFileSource below).
 * (overview.assets.*.url is the server-relative path; prefer this.)
 */
export function adminFileUrl(userId: number | string, kind: AdminFileKind): string {
  return `${API_BASE}/admin/users/${userId}/files/${kind}`;
}

/**
 * The raw `Authorization` header VALUE ("Bearer …") for the signed-in admin, or null when there is
 * no session. Exists so an <Image> / WebView can authenticate against the file route:
 *   `<Image source={{ uri, headers: { Authorization: value } }} />`
 */
export async function adminAuthHeaderValue(): Promise<string | null> {
  const h = (await getAuthHeader()) as { Authorization?: string };
  return h.Authorization || null;
}

/**
 * Ready-made `source` for <Image> / WebView pointing at a user's file, with the admin header
 * already attached. Returns null when there is no session (nothing would authenticate).
 */
/**
 * Download an admin file and hand back its BYTES as a data: URI.
 *
 * ⚠️ Do not point a WebView or <Image> at the file URL with a `headers` prop and expect it to work.
 * react-native-webview only applies those headers to the FIRST request, and iOS hands PDF rendering
 * to a separate loader that never sees them — so the endpoint is hit with no Authorization, replies
 * "Access denied. No token provided.", and the viewer displays that error page. That is exactly the
 * failure this replaces: a spinner, then an access-denied page.
 *
 * Fetching the bytes ourselves means the header is applied exactly once, by us, where we can see it.
 */
export async function fetchAdminFileToCache(
  userId: number | string,
  kind: AdminFileKind,
): Promise<{ uri: string; mime: string; bytes: number } | null> {
  const auth = await adminAuthHeaderValue();
  if (!auth) throw new Error('Your admin session has expired — sign in again.');

  // ⚠️ '/legacy' is REQUIRED on SDK 54: the package's main entry deprecated downloadAsync and
  // THROWS a "migrate to File/Directory" error — which is exactly what broke the admin viewer.
  // Every other download in this app (HomeScreen, templates, job-detail) already imports /legacy.
  const FileSystem = require('expo-file-system/legacy');
  const target = `${FileSystem.cacheDirectory}admin-${kind}-${userId}`;

  // ⚠️ STREAM TO DISK. The previous version fetched the bytes, base64-encoded the whole file into a
  // JavaScript string, held it in component state and handed it to a WebView as a data: URI. That
  // CRASHED the app: base64 inflates by ~37%, so a 2 MB résumé becomes a ~2.7 MB string that is
  // then copied across the bridge and parsed as a URL. downloadAsync writes straight to disk and
  // never materialises the file in JS memory at all.
  const res = await FileSystem.downloadAsync(adminFileUrl(userId, kind), target, {
    headers: { Authorization: auth },
  });
  if (!res || res.status !== 200) {
    let msg = `The server refused the file (HTTP ${res ? res.status : '?'}).`;
    // The endpoint answers with JSON on failure — small enough to read safely.
    try {
      const body = await FileSystem.readAsStringAsync(target).catch(() => '');
      const b = body ? JSON.parse(body) : null;
      if (b && (b.error || b.stored)) msg = b.error + (b.stored ? ` (${b.stored})` : '');
    } catch { /* not json — keep the status message */ }
    await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
    throw new Error(msg);
  }

  const info = await FileSystem.getInfoAsync(res.uri).catch(() => null);
  const mime = String((res.headers && (res.headers['Content-Type'] || res.headers['content-type'])) || '')
    .split(';')[0] || 'application/octet-stream';
  return { uri: res.uri, mime, bytes: (info && info.size) || 0 };
}

export async function adminFileSource(
  userId: number | string,
  kind: AdminFileKind,
): Promise<{ uri: string; headers: Record<string, string> } | null> {
  const auth = await adminAuthHeaderValue();
  if (!auth) return null;
  return { uri: adminFileUrl(userId, kind), headers: { Authorization: auth } };
}

// ── 3. GET /api/admin/users/:id/matched-jobs ────────────────────────────────────
export type AdminMatchedJob = {
  id: string; job_url: string; url: string; title: string | null;
  employer_name: string | null; company: string | null; employer_domain: string | null;
  location: string | null; work_mode: string | null; job_type: string | null;
  salary: string | null; experience: string | null; skills: string[];
  field: string | null; role_category: string | null; seniority: string | null;
  country: string | null; last_seen: string | null;
  match: number | null;   // 0..100, the same score the user's own Explore feed shows
};
export type AdminMatchedJobsResponse = {
  success: boolean;
  /** true = no parsed résumé skills; the app shows this user no match scores either. */
  noProfile: boolean;
  jobs: AdminMatchedJob[];
  total?: number;
  strongMatches?: number;
  reason?: string;
  scope?: string;
  matchFloor?: number;
  /**
   * ⚠️ false = NOTHING cleared the 10% floor and these are an unfiltered admin-only view (a job here
   * can score 0%). Never quote a match % / "top match" from a non-advertisable result in a
   * notification or in copy the user will see.
   */
  advertisable?: boolean;
  userField?: string | null;
  candidatePool?: number;
  note?: string;
  unavailable?: string;
};

/** Global jobs ranked by THIS user's own résumé match (same pool + formula as their Explore feed). */
export async function fetchAdminUserMatchedJobs(
  userId: number | string,
  limit = 20,
): Promise<AdminMatchedJobsResponse> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE}/admin/users/${userId}/matched-jobs`, {
      headers, params: { limit }, timeout: 45000,
    });
    return data as AdminMatchedJobsResponse;
  } catch (error: unknown) {
    throw adminErr(error, 'Failed to load matched jobs');
  }
}

// ── 4. GET /api/admin/users/:id/activity?kind= ──────────────────────────────────
export type AdminActivityKind = 'cover_letters' | 'saved_jobs' | 'applications' | 'credits' | 'searches';

export type AdminActivityCoverLetter = {
  id: number; company_name: string | null; position: string | null; website_url: string | null;
  status: string | null; created_at: string; preview: string;
};
export type AdminActivitySavedJob = {
  job_url: string | null; title: string | null; employer_name: string | null;
  location: string | null; saved_at: string;
};
export type AdminActivityApplication = {
  id: string;
  /** Which record this row came from — 'email' and 'cover_letter' can describe the SAME application. */
  source: 'email' | 'cover_letter' | 'job_match';
  company_name: string | null; position: string | null; title: string | null;
  job_url: string | null; status: string | null; created_at: string;
  reply_received: boolean | null;
};
export type AdminActivityCredit = {
  id: number; credits_used: number; action_type: string | null;
  company_name: string | null; position: string | null; created_at: string;
};
export type AdminActivitySearch = {
  id: string | null; created_at: string; platform: string | null; app_version: string | null;
  country: string | null; query: string | null; location: string | null; company: string | null;
  props: Record<string, any>;
};
export type AdminActivityItemMap = {
  cover_letters: AdminActivityCoverLetter;
  saved_jobs: AdminActivitySavedJob;
  applications: AdminActivityApplication;
  credits: AdminActivityCredit;
  searches: AdminActivitySearch;
};
export type AdminActivityMeta = {
  /**
   * ⚠️ RENDER THIS. For `applications` it explains that `total` is a UNION of an emailed application
   * AND its cover letter marked 'applied', so one real application can be counted twice — the bare
   * total must never be labelled "applications made". `sources` has the per-source split.
   */
  note?: string;
  sources?: Record<string, number>;
  match_statuses_seen?: string[];
  match_statuses_counted?: string[];
  total_credits_used?: number;
};
export type AdminActivityResponse<K extends AdminActivityKind = AdminActivityKind> = {
  success: boolean;
  kind: K;
  total: number;
  offset: number;
  limit: number;
  items: AdminActivityItemMap[K][];
  /** true = this page does NOT contain everything there is. */
  truncated: boolean;
  limit_capped?: boolean;
  max_limit?: number;
  meta?: AdminActivityMeta;
  /** The source table is absent on this deployment — an empty list here means "unknown", not "none". */
  unavailable?: string;
};

/**
 * The ITEMS behind the overview's counts. `limit` is clamped to 100 server-side (`limit_capped`
 * says when the ask was clamped). Generic on `kind`, so `items` comes back typed per kind.
 */
export async function fetchAdminUserActivity<K extends AdminActivityKind>(
  userId: number | string,
  kind: K,
  limit = 25,
  offset = 0,
): Promise<AdminActivityResponse<K>> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE}/admin/users/${userId}/activity`, {
      headers, params: { kind, limit, offset }, timeout: 30000,
    });
    return data as AdminActivityResponse<K>;
  } catch (error: unknown) {
    throw adminErr(error, `Failed to load ${kind} activity`);
  }
}

// ── 5. GET /api/admin/users/:id/cover-letters/:letterId ─────────────────────────
export type AdminCoverLetter = {
  id: number; company_name: string | null; position: string | null; website_url: string | null;
  status: string | null; created_at: string; updated_at: string | null;
  html: string;   // already server-sanitized (scripts / inline handlers stripped)
  text: string;   // plain-text version, for copy-paste or <Text> rendering
  sanitized: boolean;   // true = script-ish markup WAS found and removed
};

/** One full cover letter, scoped to its owner (a wrong-owner id is a plain 404). */
export async function fetchAdminCoverLetter(
  userId: number | string,
  letterId: number | string,
): Promise<AdminCoverLetter> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(
      `${API_BASE}/admin/users/${userId}/cover-letters/${letterId}`,
      { headers, timeout: 30000 },
    );
    return data.letter as AdminCoverLetter;
  } catch (error: unknown) {
    throw adminErr(error, 'Failed to load cover letter');
  }
}

// ── 6. GET /api/admin/notify/templates ──────────────────────────────────────────
/** A category that is NOT one of these cannot be opt-out-gated, so the server refuses to send it. */
export type AdminNotifyCategory = keyof AdminNotifyPrefs;
export type AdminTemplateRelevance = 'suggested' | 'available' | 'not_applicable';
export type AdminNotifyTemplate = {
  key: string;
  label: string;
  description: string;
  /** Normally an AdminNotifyCategory; a template with anything else is reported in `warning`. */
  category: string;
  /** Copy rendered for THIS user (or generic when no userId was passed) — pre-fill, not an override. */
  title: string;
  body: string;
  route: string | null;
  params: Record<string, any>;
  needsJob: boolean;
  relevance: AdminTemplateRelevance;
  reason: string;
};
export type AdminNotifyTemplatesResponse = {
  success: boolean;
  templates: AdminNotifyTemplate[];
  userId: number | null;
  /** false = the copy above is the GENERIC render (no user context was resolved). */
  userKnown: boolean;
  categories: string[];
  /** Present when some template's category is not a preferences column — opt-outs can't gate it. */
  warning?: string;
};

/**
 * The template catalogue. Pass `userId` to get per-user relevance AND per-user rendered copy;
 * pass `jobId` as well for the templates that target one specific job (`needsJob`).
 */
export async function fetchAdminNotifyTemplates(
  userId?: number | string | null,
  jobId?: string | null,
): Promise<AdminNotifyTemplatesResponse> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE}/admin/notify/templates`, {
      headers, params: { userId: userId ?? '', jobId: jobId ?? '' }, timeout: 30000,
    });
    return data as AdminNotifyTemplatesResponse;
  } catch (error: unknown) {
    throw adminErr(error, 'Failed to load notification templates');
  }
}

// ── 7. POST /api/admin/users/:id/notify — sends to a REAL phone ─────────────────
/** Server caps: title 200 chars, body 500. */
export type AdminNotifyOverrides = { title?: string; body?: string };

/**
 * ⚠️ Only pass an override the admin ACTUALLY EDITED. The copy boxes are pre-filled with the
 * template's rendered text; posting that same text back turns a personalised send into a literal
 * one. This drops empty / whitespace-only fields and returns null when nothing was edited, so the
 * body can omit `overrides` entirely and let the server personalise.
 */
function cleanAdminOverrides(o?: AdminNotifyOverrides | null): AdminNotifyOverrides | null {
  const title = typeof o?.title === 'string' ? o.title.trim() : '';
  const body = typeof o?.body === 'string' ? o.body.trim() : '';
  const out: AdminNotifyOverrides = {};
  if (title) out.title = title;
  if (body) out.body = body;
  return Object.keys(out).length ? out : null;
}

/**
 * Why a send did not reach the phone. opted_out / no_token / recently_sent / bad_template_category
 * arrive on a `success: true` response (the request worked, the rails stopped the send);
 * unknown_template / user_not_found / job_not_found come back as a THROWN error (4xx).
 */
export type AdminNotifySkipReason =
  | 'opted_out' | 'no_token' | 'recently_sent' | 'bad_template_category'
  | 'unknown_template' | 'user_not_found' | 'job_not_found';

export type AdminUserNotifyResult = {
  /** ⚠️ The REQUEST succeeded. It does NOT mean a notification was delivered — check push.ok. */
  success: boolean;
  push: { ok: boolean; error?: string };
  /** Non-null = BLOCKED by the rails. Report this distinctly; never show a green tick for it. */
  skipped: AdminNotifySkipReason | null;
  logId: number | null;
  /** The copy that actually went out — null whenever nothing was delivered. */
  sent: { title: string; body: string; route: string | null; params: Record<string, any> } | null;
};

/**
 * Send ONE template to ONE user. Delivered ⇔ `push.ok === true`; a `skipped` reason with
 * `success: true` means the request was fine and the send was deliberately withheld
 * (opted out / no push token / the same template already went out inside 72h).
 */
export async function sendAdminUserNotification(
  userId: number | string,
  opts: { key: string; jobId?: string | null; overrides?: AdminNotifyOverrides | null },
): Promise<AdminUserNotifyResult> {
  try {
    const headers = await getAuthHeader();
    const overrides = cleanAdminOverrides(opts.overrides);
    const body: { key: string; jobId?: string; overrides?: AdminNotifyOverrides } = { key: opts.key };
    if (opts.jobId) body.jobId = String(opts.jobId);
    if (overrides) body.overrides = overrides;
    const { data } = await axios.post(`${API_BASE}/admin/users/${userId}/notify`, body, {
      headers, timeout: 45000,
    });
    return data as AdminUserNotifyResult;
  } catch (error: unknown) {
    throw adminErr(error, 'Failed to send notification');
  }
}

// ── 8. GET /api/admin/segments ──────────────────────────────────────────────────
export type AdminSegment = {
  key: string; label: string; description: string;
  count: number | null;          // null + `error` = the count query failed; don't render it as 0
  available?: boolean;           // false = a table this segment needs is absent on this deployment
  suggests?: string[];           // template keys that fit this segment
  error?: string;
};

/** The segment catalogue with live counts. */
export async function fetchAdminSegments(): Promise<AdminSegment[]> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE}/admin/segments`, { headers, timeout: 45000 });
    return (data && data.segments) || [];
  } catch (error: unknown) {
    throw adminErr(error, 'Failed to load segments');
  }
}

// ── 9. GET /api/admin/segments/:key/users ───────────────────────────────────────
export type AdminSegmentUser = {
  id: number; full_name: string | null; email: string; created_at: string;
  last_seen_at: string | null;   // derived from app_events (users.last_seen_at is never written)
  has_push: boolean; completeness: number;
  opted_out: boolean; recently_sent: boolean;   // per the templateKey passed in, else always false
};
export type AdminSegmentExclusions = { no_token: number; opted_out: number; recently_sent: number };
export type AdminSegmentUsersResponse = {
  success: boolean;
  key: string;
  label?: string;
  total: number;                       // everyone in the segment
  sendableTotal?: number;              // …minus the exclusions below
  excluded?: AdminSegmentExclusions;   // counted over the WHOLE segment, not just this page
  sendableOnly?: boolean;
  templateKey?: string | null;
  users: AdminSegmentUser[];
  limit?: number;
  truncated?: boolean;
  truncation_note?: string;
  /** Plain-English exclusion breakdown from the server — render it rather than re-deriving it. */
  exclusion_note?: string;
  last_seen_note?: string;
  error?: string;
};

/** Who is in a segment. Pass `templateKey` to get real per-template opt-out / 72h-dedupe flags. */
export async function fetchAdminSegmentUsers(
  key: string,
  opts: { limit?: number; templateKey?: string | null } = {},
): Promise<AdminSegmentUsersResponse> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE}/admin/segments/${encodeURIComponent(key)}/users`, {
      headers,
      params: { limit: opts.limit ?? 200, templateKey: opts.templateKey || '' },
      timeout: 45000,
    });
    return data as AdminSegmentUsersResponse;
  } catch (error: unknown) {
    throw adminErr(error, 'Failed to load segment users');
  }
}

// ── 10. POST /api/admin/segments/:key/notify — the BULK send ────────────────────
export type AdminSegmentNotifyBase = {
  success: boolean;
  segment: string;
  templateKey: string;
  category: string;
  totalMatching: number;        // everyone in the segment
  sendableTotal: number;        // …who can actually be sent to
  remainingAfterThisRun: number;
  recipients: number;           // how many this run selected
  reachable: number;
  skipped: AdminSegmentExclusions;
  runtimeSkipped: AdminSegmentExclusions;
  cap: number;
  selectionLimit: number;
  truncated: boolean;
  exclusion_note?: string;
  truncation_note?: string;
};
export type AdminSegmentNotifyPreview = AdminSegmentNotifyBase & {
  dryRun: true;
  /** The copy as the FIRST reachable recipient would receive it. */
  preview: { title: string; body: string; route: string | null; params: Record<string, any> };
  note?: string;
};
export type AdminSegmentNotifyResult = AdminSegmentNotifyBase & {
  dryRun: false;
  batchId: string;
  sent: number;
  failed: number;
  failures: { userId: number; reason: string }[];
  stateTier?: 'light' | 'basic' | 'full';
};

// The two request bodies are SEPARATE types on purpose: the preview body has no `confirm` field at
// all, so TypeScript's excess-property check rejects any attempt to smuggle one in. That is why
// preview and send are two functions rather than one function with a boolean — a caller cannot
// accidentally flip a preview into a mass send by passing the wrong argument.
type SegmentPreviewBody = { templateKey: string; overrides?: AdminNotifyOverrides; maxRecipients?: number };
type SegmentSendBody = SegmentPreviewBody & { confirm: true };

/**
 * DRY RUN. Sends NOTHING and is structurally incapable of it — `confirm` never appears in the body.
 * Returns who would be reached, what is excluded and why, and the exact copy that would go out.
 */
export async function previewAdminSegmentNotify(
  key: string,
  opts: { templateKey: string; overrides?: AdminNotifyOverrides | null; maxRecipients?: number },
): Promise<AdminSegmentNotifyPreview> {
  try {
    const headers = await getAuthHeader();
    const overrides = cleanAdminOverrides(opts.overrides);
    const body: SegmentPreviewBody = { templateKey: opts.templateKey };
    if (overrides) body.overrides = overrides;
    if (opts.maxRecipients != null) body.maxRecipients = opts.maxRecipients;
    const { data } = await axios.post(
      `${API_BASE}/admin/segments/${encodeURIComponent(key)}/notify`,
      body,   // ⚠️ NO `confirm` — adding one here turns every preview into a mass send.
      { headers, timeout: 60000 },
    );
    // Defence in depth: without `confirm` the server always answers dryRun:true. An explicit false
    // would mean pushes went out under a "preview" button, and the caller must not paint it as one.
    if (data && data.dryRun === false) {
      throw new Error('Preview returned a REAL send result — treat this as a send that already happened, not a preview.');
    }
    return data as AdminSegmentNotifyPreview;
  } catch (error: unknown) {
    if (error instanceof Error && !axios.isAxiosError(error)) throw error;
    throw adminErr(error, 'Failed to preview the segment notification');
  }
}

/**
 * THE REAL BULK SEND — pushes land on real phones. Always run previewAdminSegmentNotify first and
 * make the admin confirm the recipient count. Opt-outs, the 72h per-template dedupe and the
 * recipient cap are enforced server-side; `sent` / `failed` / `skipped` report what happened.
 */
export async function sendAdminSegmentNotify(
  key: string,
  opts: { templateKey: string; overrides?: AdminNotifyOverrides | null; maxRecipients?: number },
): Promise<AdminSegmentNotifyResult> {
  try {
    const headers = await getAuthHeader();
    const overrides = cleanAdminOverrides(opts.overrides);
    const body: SegmentSendBody = { templateKey: opts.templateKey, confirm: true };
    if (overrides) body.overrides = overrides;
    if (opts.maxRecipients != null) body.maxRecipients = opts.maxRecipients;
    const { data } = await axios.post(
      `${API_BASE}/admin/segments/${encodeURIComponent(key)}/notify`,
      body,
      { headers, timeout: 180000 },   // a capped batch of up to 500 sends serially in workers
    );
    return data as AdminSegmentNotifyResult;
  } catch (error: unknown) {
    throw adminErr(error, 'Failed to run the segment notification');
  }
}

// ── Admin: résumé profile, searches, and a no-charge cover-letter render ────────
// See server/services/adminResumeView.js and adminSearchView.js for why these exist rather than the
// page just streaming the uploaded file / listing app_events.

export type AdminResumeEntry = {
  title: string; org: string; period: string; detail: string; location?: string; kind?: string;
};
export type AdminResumeFile = {
  has_file: boolean; stored_path: string | null; filename: string | null; ext: string | null;
};
export type AdminResumeProfile = {
  available: boolean;
  reason?: string;
  detail?: string;
  parse_error?: string | null;
  source?: 'builder' | 'parsed';
  source_label?: string;
  updated_at?: string | null;
  identity?: { full_name: string; email: string; phone: string; location: string; headline?: string; links?: string[] };
  summary?: string;
  skills?: string[];
  technical_skills?: string[];
  soft_skills?: string[];
  experience_years?: number | null;
  experience_summary?: string;
  experience?: AdminResumeEntry[];
  education?: AdminResumeEntry[];
  projects?: AdminResumeEntry[];
  certifications?: string[];
  languages?: string[];
  achievements?: string[];
  job_titles?: string[];
  industries?: string[];
  parse_status?: string | null;
  parsed_at?: string | null;
  raw_text?: string;
  file?: AdminResumeFile;
  can_render_pdf?: boolean;
};

export type AdminSearchVerdict = { code: string; label: string; tone: 'good' | 'warn' | 'bad' };
export type AdminSearchRow = {
  kind: 'employer' | 'event';
  id: string;
  employer_id: string | null;
  async_job_id: string | null;
  query: string;
  query_is_exact: boolean;
  employer: string | null;
  domain: string | null;
  sub_info?: string;
  job_count: number;
  with_url: number;
  with_detail: number;
  status: string;
  created_at: string;
  last_scraped_at?: string | null;
  platform?: string | null;
  app_version?: string | null;
  verdict: AdminSearchVerdict;
};
export type AdminSearchList = {
  total: number;
  counts: { searches: number; produced_nothing: number; single_job: number; healthy: number };
  items: AdminSearchRow[];
};
export type AdminSearchJob = {
  id: string; title: string; location: string; experience: string; salary: string;
  job_type: string; work_mode: string; urgent: boolean; is_active: boolean;
  skills: string[]; responsibilities: string[]; job_url: string | null;
  url_is_synthetic: boolean; has_detail: boolean; created_at: string;
};
export type AdminSearchJobs = {
  employer: { id: string; name: string; domain: string; sub_info: string; last_scraped_at: string | null } | null;
  total: number;
  summary: { with_real_url: number; with_detail: number; with_skills: number };
  jobs: AdminSearchJob[];
};
export type AdminTestLetter = {
  success: boolean; coverLetter: string; jobTitle: string; companyName: string;
  creditsUsed: number; adminTest?: boolean;
  inputs?: { resume_chars: number; resume_source: string; job_skills: string; job_responsibilities: string | null; employer: string | null };
};

export async function fetchAdminResumeProfile(userId: number | string): Promise<AdminResumeProfile> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE}/admin/users/${userId}/resume-profile`, { headers, timeout: 30000 });
    return data as AdminResumeProfile;
  } catch (error: unknown) {
    throw adminErr(error, 'Failed to load the résumé profile');
  }
}

/** The rendered-PDF URL. Needs the admin header, so pair it with adminAuthHeaderValue(). */
export function adminResumePdfUrl(userId: number | string, template?: string): string {
  const q = template ? `?template=${encodeURIComponent(template)}` : '';
  return `${API_BASE}/admin/users/${userId}/resume-pdf${q}`;
}

export async function fetchAdminSearches(userId: number | string, limit = 50): Promise<AdminSearchList> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE}/admin/users/${userId}/searches`, {
      headers, params: { limit }, timeout: 30000,
    });
    return data as AdminSearchList;
  } catch (error: unknown) {
    throw adminErr(error, 'Failed to load searches');
  }
}

export async function fetchAdminSearchJobs(
  userId: number | string, employerId: string, limit = 50,
): Promise<AdminSearchJobs> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE}/admin/users/${userId}/searches/${employerId}/jobs`, {
      headers, params: { limit }, timeout: 30000,
    });
    return data as AdminSearchJobs;
  } catch (error: unknown) {
    throw adminErr(error, 'Failed to load the jobs for that search');
  }
}

/** Generates on the USER's résumé, charges nobody, stores nothing. 90s: it is a live model call. */
export async function adminTestCoverLetter(
  userId: number | string, jobId: string,
): Promise<AdminTestLetter> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.post(`${API_BASE}/admin/users/${userId}/test-cover-letter`, { jobId }, {
      headers, timeout: 90000,
    });
    return data as AdminTestLetter;
  } catch (error: unknown) {
    throw adminErr(error, 'Failed to generate a test cover letter');
  }
}

const aiHubService = {
  analyzeWishlist,
  fetchJobMatches,
  resumeJobPolling,
  verifyEmail,
  addContactToJob,
  fetchDashboard,
  removeDashboardItem,
  fetchCreditBalance,
  deductSearchCredits,
  getRecruiters,
  findRecruiters,
  findRecruiterEmails,
};

export default aiHubService;
