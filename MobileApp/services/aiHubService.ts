// AI Hub — new feature. Safe to delete without affecting existing app.

import axios from 'axios';
import { AppState, AppStateStatus } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';
import type { Contact, Employer } from '../types/aiHub';

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

export async function translateJob(jobId: string): Promise<TranslatedJob> {
  try {
    const headers = await getAuthHeader();
    const response = await axios.post(
      `${API_BASE_URL}/ai-hub/jobs/${jobId}/translate`,
      {},
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

/**
 * Fetches the user's tracked employers / search history.
 */
export async function fetchDashboard(): Promise<{
  jobId: string;
  status: string;
  progress: number;
  employer: Employer;
  updatedAt: string;
}[]> {
  try {
    const headers = await getAuthHeader();
    const response = await axios.get(`${API_BASE_URL}/ai-hub/dashboard`, {
      headers,
    });
    return response.data.dashboard;
  } catch (error: unknown) {
    const msg = axios.isAxiosError(error)
      ? error.response?.data?.error ?? error.message
      : 'Failed to fetch AI Hub dashboard';
    throw new Error(msg);
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

/**
 * Generate a cover letter for a specific job using the existing cover letter pipeline.
 * Uses /api/generate-cover-letter-details (same as Letters page) — returns jobId for polling.
 */
export async function startJobCoverLetter(
  websiteUrl: string,
  position: string,
  responsibilities?: string[],
  jobLocation?: string
): Promise<string> {
  const headers = await getAuthHeader();
  const body: Record<string, any> = { websiteUrl, position, recipientEmail: '' };
  if (responsibilities && responsibilities.length > 0) body.responsibilities = responsibilities;
  if (jobLocation && jobLocation.trim()) body.jobLocation = jobLocation.trim();
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
  category: string; credits: number; is_active: number; sort_order: number;
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

// Admin Store Analytics (Apple App Store + Google Play downloads + recorded transactions).
export type StoreAnalytics = {
  generatedAt: string;
  storeAsOf?: string;
  apple: { configured: boolean; pending?: boolean; reason?: string; note?: string; report?: string; processingDate?: string; totalDownloads?: number; firstTime?: number; redownloads?: number; series?: { date: string; downloads: number }[] };
  google: { configured: boolean; reason?: string; note?: string; month?: string; totalInstalls?: number; series?: { date: string; installs: number }[] };
  local: { byPlatform?: { platform: string; currency: string; txns: number; paying_users: number; revenue: string }[]; completedTxns?: { last_24h: number; last_7d: number; last_30d: number; all_time: number }; recent?: any[]; credits?: { credits_sold: number; purchase_events: number }; error?: string };
  live?: {
    activeNow?: { total: number; byPlatform?: { platform: string; users: number }[] };
    activeToday?: { total: number; byPlatform?: { platform: string; users: number }[] };
    opens?: { last_hour: number; last_24h: number; unique_24h: number };
    newInstalls?: { last_hour: number; last_24h: number; last_7d: number; all_time: number };
    newInstallsByPlatform?: { platform: string; installs: number }[];
    topEvents?: { event: string; n: number }[];
    hourly?: { hour: string; users: number }[];
    byCountry?: { country: string; users: number }[];
    recent?: { event: string; platform: string; user_id: number; created_at: string }[];
    purchasesToday?: { platform: string; currency: string; n: number; revenue: string }[];
    storeNotifications?: { store: string; notification_type: string; product_id: string; created_at: string }[];
    totalEvents?: number;
    error?: string;
  };
};
export async function fetchStoreAnalytics(): Promise<StoreAnalytics> {
  const headers = await getAuthHeader();
  const { data } = await axios.get(`${API_BASE_URL}/admin/store-analytics`, { headers });
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
