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

    const tick = async () => {
      // Pause while backgrounded — retry in 1 s
      if (appState !== 'active') {
        setTimeout(tick, 1000);
        return;
      }

      try {
        const { data } = await axios.get(`${API_BASE_URL}/ai-hub/job-status/${jobId}`, { headers });

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
      } catch {
        // Network hiccup — keep retrying
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
    const response = await axios.post(
      `${API_BASE_URL}/ai-hub/deduct-credits`,
      { amount },
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
