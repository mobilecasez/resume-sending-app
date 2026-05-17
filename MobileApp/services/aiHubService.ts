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
        const { data } = await axios.get(`${API_BASE_URL}/job-status/${jobId}`, { headers });

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
 * Safe to background — polling pauses and resumes automatically.
 */
export async function fetchJobMatches(
  companyName: string,
  onPartialUpdate?: (employer: Employer) => void
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

    return pollUntilDone<Employer>(
      data.jobId,
      headers as Record<string, string>,
      onPartialUpdate
    );
  } catch (error: unknown) {
    const msg = axios.isAxiosError(error)
      ? error.response?.data?.error ?? error.message
      : `Failed to fetch job matches for ${companyName}`;
    throw new Error(msg);
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

const aiHubService = {
  analyzeWishlist,
  fetchJobMatches,
  resumeJobPolling,
  verifyEmail,
  addContactToJob,
  fetchDashboard,
  removeDashboardItem,
};

export default aiHubService;
