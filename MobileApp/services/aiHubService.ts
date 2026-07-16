// AI Hub — new feature. Safe to delete without affecting existing app.

import axios from 'axios';
import { AppState, AppStateStatus } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../config';
import type { Contact, Employer, Job } from '../types/aiHub';

const API_BASE_URL = `${API_BASE}`;

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
        const { data } = await axios.get(`${API_BASE_URL}/ai-hub/job-status/${jobId}`, { headers });
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
      `${API_BASE_URL}/ai-hub/analyze-wishlist`,
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

    const response = await axios.get(`${API_BASE_URL}/ai-hub/jobs`, {
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
      `${API_BASE_URL}/ai-hub/verify-email`,
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
      `${API_BASE_URL}/ai-hub/jobs/${jobId}/contacts`,
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
      `${API_BASE_URL}/ai-hub/jobs/${jobId}/translate`,
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
      `${API_BASE_URL}/ai-hub/translate-batch`,
      { items },
      { headers }
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
    `${API_BASE_URL}/ai-hub/linkedin/extract`,
    { url, content },
    { headers }
  );
  return (response.data?.job ?? null) as LinkedInJob;
}

// Extract AND add a pasted LinkedIn job URL to the user's Job Hub (employer + job + tracking) → shows on dashboard.
export async function addLinkedInJob(url: string, content: string): Promise<LinkedInJob> {
  const headers = await getAuthHeader();
  const response = await axios.post(
    `${API_BASE_URL}/ai-hub/linkedin/add`,
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
      `${API_BASE_URL}/ai-hub/jobs/${jobId}/contacts`,
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
      `${API_BASE_URL}/ai-hub/jobs/${jobId}/url-override`,
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
      `${API_BASE_URL}/ai-hub/jobs/${jobId}/url-override`,
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
    const { data } = await axios.get(`${API_BASE_URL}/ai-hub/smart-fill-data`, { headers });
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
    const { data } = await axios.get(`${API_BASE_URL}/ai-hub/motivation`, { headers, timeout: 20000 });
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
    await axios.post(`${API_BASE_URL}/ai-hub/autofill-memory`, { answers }, { headers });
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
    const response = await axios.get(`${API_BASE_URL}/ai-hub/dashboard`, {
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
    const r = await axios.get(`${API_BASE_URL}/ai-hub/dashboard/employer/${employerId}/jobs`, {
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
    const r = await axios.get(`${API_BASE_URL}/ai-hub/jobs/${jobId}/full`, { headers, timeout: 20000 });
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
      `${API_BASE_URL}/ai-hub/match-scores`,
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
    const response = await axios.get(`${API_BASE_URL}/user/credits`, { headers });
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
      `${API_BASE_URL}/ai-hub/deduct-credits`,
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
    await axios.delete(`${API_BASE_URL}/ai-hub/dashboard/${jobId}`, {
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
      `${API_BASE_URL}/ai-hub/employers/${employerId}/recruiters`,
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
    `${API_BASE_URL}/ai-hub/employers/${employerId}/find-recruiters`,
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
    `${API_BASE_URL}/ai-hub/employers/${employerId}/find-emails`,
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
}): Promise<void> {
  try {
    const headers = await getAuthHeader();
    await axios.post(`${API_BASE_URL}/ai-hub/jobs/${jobId}/cover-letter`, data, { headers });
  } catch {}
}

export async function loadJobCoverLetter(jobId: string): Promise<JobCLRecord | null> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE_URL}/ai-hub/jobs/${jobId}/cover-letter`, { headers });
    return data.coverLetter ?? null;
  } catch { return null; }
}

export async function updateJobCLStatus(jobId: string, status: 'generated' | 'downloaded' | 'applied'): Promise<void> {
  try {
    const headers = await getAuthHeader();
    await axios.patch(`${API_BASE_URL}/ai-hub/jobs/${jobId}/cover-letter/status`, { status }, { headers });
  } catch {}
}

export async function loadJobStatuses(employerId: string): Promise<Record<string, string>> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE_URL}/ai-hub/employers/${employerId}/job-statuses`, { headers });
    return data.statuses ?? {};
  } catch { return {}; }
}

/** Applied/CL statuses for ALL jobs in ONE call (was one request per tracked employer). */
export async function loadAllJobStatuses(): Promise<Record<string, string>> {
  try {
    const headers = await getAuthHeader();
    const { data } = await axios.get(`${API_BASE_URL}/ai-hub/job-statuses`, { headers, timeout: 20000 });
    return data.statuses ?? {};
  } catch { return {}; }
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
  jobId?: string
): Promise<string> {
  const headers = await getAuthHeader();
  const body: Record<string, any> = { websiteUrl, position, recipientEmail: '' };
  if (responsibilities && responsibilities.length > 0) body.responsibilities = responsibilities;
  if (jobLocation && jobLocation.trim()) body.jobLocation = jobLocation.trim();
  // The dashboard list ships a slimmed job (3 responsibilities) — sending the jobId lets the
  // server swap in the FULL stored list, so letter quality never depends on client hydration.
  if (jobId) body.jobId = jobId;
  const response = await axios.post(
    `${API_BASE_URL}/generate-cover-letter-details`,
    body,
    { headers, timeout: 30000 }
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
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const { data } = await axios.get(`${API_BASE_URL}/job-status/${jobId}`, { headers });
        if (data.status === 'completed') {
          resolve(data.data);
        } else if (data.status === 'failed') {
          reject(new Error(data.error || 'Cover letter generation failed'));
        } else {
          onProgress?.();
          setTimeout(tick, 2500);
        }
      } catch {
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
    const { data } = await axios.get(`${API_BASE_URL}/ai-event-costs`);
    _eventCostsCache = (data && data.costs) || {};
    return _eventCostsCache!;
  } catch {
    return _eventCostsCache || {};
  }
}

/** Admin: full catalog (requires admin token). */
export async function fetchAdminAiEvents(): Promise<AiEventCost[]> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE_URL}/admin/ai-event-costs`, { headers });
  return (data && data.events) || [];
}

/** Admin: send (or dry-run preview) a reward push nudge. dryRun=true returns { wouldTarget } without sending;
 *  testSelf=true sends ONLY to the admin's own device (ignores filters) for previewing before a mass send. */
export async function sendRewardNudge(nudgeKey: string, dryRun: boolean, testSelf = false): Promise<{ wouldTarget?: number; sent?: number; targeted?: number; credits?: number; test?: boolean; reason?: string; error?: string }> {
  const headers = await getAuthHeader();
  const { data } = await axios.post(`${API_BASE_URL}/admin/reward-nudge`, { nudgeKey, dryRun, testSelf }, { headers, timeout: 30000 });
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
  const { data } = await axios.get(`${API_BASE_URL}/admin/store-analytics`, { headers });
  return data;
}

/** Admin: run an uninstall-detection sweep (silent push + receipts → DeviceNotRegistered). */
export async function runUninstallSweep(): Promise<{ checked: number; uninstalled: number; pendingReceipts: number }> {
  const headers = await getAuthHeader();
  const { data } = await axios.post(`${API_BASE_URL}/admin/uninstall-sweep`, {}, { headers, timeout: 30000 });
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
  const { data } = await axios.get(`${API_BASE_URL}/admin/users-list`, {
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
  opts: { q?: string; limit?: number } = {},
): Promise<{ users: UserJourney[] }> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE_URL}/admin/user-journeys`, {
    headers,
    params: { q: opts.q || '', limit: opts.limit ?? 60 },
    timeout: 30000,
  });
  return data;
}

/** Admin: full event timeline for one user (by userId) or anonymous device (by anonId). */
export async function fetchUserTimeline(
  opts: { userId?: number | string | null; anonId?: string | null; limit?: number } = {},
): Promise<UserTimeline> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE_URL}/admin/user-timeline`, {
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
  const { data } = await axios.get(`${API_BASE_URL}/admin/notification-settings`, { headers, timeout: 20000 });
  return data.settings || { installs: true, registrations: true, purchases: true };
}

/** Admin: update one or more push-alert toggles. Returns the saved settings. */
export async function updateAdminNotifySettings(patch: Partial<AdminNotifySettings>): Promise<AdminNotifySettings> {
  const headers = await getAuthHeader();
  const { data } = await axios.put(`${API_BASE_URL}/admin/notification-settings`, patch, { headers, timeout: 20000 });
  return data.settings || { installs: true, registrations: true, purchases: true };
}

/** Admin: fire a test push to all admin devices. */
export async function sendAdminTestNotification(): Promise<{ sent: number; admins?: number }> {
  const headers = await getAuthHeader();
  const { data } = await axios.post(`${API_BASE_URL}/admin/notification-test`, {}, { headers, timeout: 20000 });
  return (data && data.result) || { sent: 0 };
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
  const { data } = await axios.get(`${API_BASE_URL}/discover/jobs`, { headers, params, timeout: 25000 });
  return data;
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
  const { data } = await axios.post(`${API_BASE_URL}/discover/hydrate-urls`, { urls, query: query || '' }, { headers, timeout: 45000 });
  return data;
}

/** AI natural-language search over the saved network: breaks the sentence into role/location/etc,
 *  then returns matched jobs ranked by résumé fit. A pasted employer URL comes back as urlDetected. */
export async function aiSearchJobs(query: string, offset = 0, limit = 20, refresh = false): Promise<AiSearchResponse & { insufficient?: boolean; creditsRequired?: number; creditsRemaining?: number }> {
  const headers = await getAuthHeader();
  try {
    // `refresh` = an internal re-run (e.g. after silent web hydration) → backend skips the credit charge.
    const { data } = await axios.post(`${API_BASE_URL}/discover/ai-search`, { query, offset, limit, refresh }, { headers, timeout: 30000 });
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
  const { data } = await axios.post(`${API_BASE_URL}/discover/live-search`, { query }, { headers, timeout: 75000 });
  return { parsed: data?.parsed ?? null, cards: (data?.cards ?? []) as LiveJobCard[], count: data?.count ?? 0 };
}

/** Fetch ONE job's full details from the on-device-scraped page HTML → stores it → returns a rich card. */
export async function fetchJobDetail(url: string, html: string, company?: string): Promise<LiveJobCard | null> {
  const headers = await getAuthHeader();
  try {
    const { data } = await axios.post(`${API_BASE_URL}/discover/fetch-detail`, { url, html, company: company || '' }, { headers, timeout: 45000 });
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
  const { data } = await axios.get(`${API_BASE_URL}/discover/saved-jobs`, { headers, timeout: 20000 });
  return { jobs: (data?.jobs ?? []) as SavedJobCard[], count: data?.count ?? 0 };
}

export async function removeSavedJob(url: string): Promise<void> {
  const headers = await getAuthHeader();
  await axios.post(`${API_BASE_URL}/discover/saved-jobs/remove`, { url }, { headers, timeout: 15000 });
}

// Save a card directly (fallback when detail-fetch fails) so every selected job still lands in Saved Jobs.
export async function saveCard(card: LiveJobCard): Promise<void> {
  const headers = await getAuthHeader();
  await axios.post(`${API_BASE_URL}/discover/save-card`, { card }, { headers, timeout: 15000 });
}

/** Filter chips for the feed. Pass `field` to get the role categories within that field. */
export async function fetchDiscoverFacets(field?: string): Promise<DiscoverFacets> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE_URL}/discover/facets`, {
    headers, params: { field: field || '' }, timeout: 20000,
  });
  return data;
}

/** Admin: change an event's credit cost and/or active flag. */
export async function updateAiEventCost(eventKey: string, credits: number, isActive: boolean): Promise<void> {
  const headers = await getAuthHeader();
  await axios.put(
    `${API_BASE_URL}/admin/ai-event-costs/${encodeURIComponent(eventKey)}`,
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
  const { data } = await axios.get(`${API_BASE_URL}/admin/users/search`, { params: { q }, headers });
  return (data && data.users) || [];
}

/** Admin: set a user's remaining credits; returns the new balance. */
export async function adminSetUserCredits(userId: number, credits: number): Promise<number> {
  const headers = await getAuthHeader();
  const { data } = await axios.put(`${API_BASE_URL}/admin/users/${userId}/credits`, { credits }, { headers });
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
  const { data } = await axios.post(`${API_BASE_URL}/ai-hub/fix-requests`, { employerInput }, { headers });
  return { requestId: data?.requestId, status: data?.status || 'investigating' };
}

/** User: poll a fix request's status (app re-runs the search when 'resolved'). */
export async function getFixRequestStatus(id: number): Promise<{ status: string; jobCount: number; resolved: boolean }> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE_URL}/ai-hub/fix-requests/${id}`, { headers });
  return { status: data?.status, jobCount: data?.jobCount || 0, resolved: !!data?.resolved };
}

/** Admin: list every employer fix request with its active fix. */
export async function adminListEmployerRequests(): Promise<EmployerFixRequest[]> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE_URL}/admin/employer-requests`, { headers });
  return (data && data.requests) || [];
}

/** Admin: run / re-run the diagnostic agent ("rethink") on a request. */
export async function adminInvestigateRequest(id: number): Promise<any> {
  const headers = await getAuthHeader();
  const { data } = await axios.post(`${API_BASE_URL}/admin/employer-requests/${id}/investigate`, {}, { headers });
  return data?.result;
}

/** Admin: full version history for a request's domain. */
export async function adminOverrideHistory(id: number): Promise<{ domain: string; overrides: EmployerFixOverride[] }> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE_URL}/admin/employer-requests/${id}/overrides`, { headers });
  return { domain: data?.domain, overrides: (data && data.overrides) || [] };
}

/** Admin: roll back / re-apply a specific override version. */
export async function adminActivateOverride(overrideId: number): Promise<void> {
  const headers = await getAuthHeader();
  await axios.post(`${API_BASE_URL}/admin/employer-overrides/${overrideId}/activate`, {}, { headers });
}

/** Admin: turn the fix OFF for a request's domain. */
export async function adminDeactivateOverride(requestId: number): Promise<void> {
  const headers = await getAuthHeader();
  await axios.post(`${API_BASE_URL}/admin/employer-requests/${requestId}/deactivate`, {}, { headers });
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
