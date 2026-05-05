// AI Hub — new feature. Safe to delete without affecting existing app.

import axios from 'axios';
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
 * Analyzes the user's wishlist of target companies.
 * Calls POST /api/ai-hub/analyze-wishlist with the list of company names/URLs.
 * Returns the number of matches found and sources scanned.
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
 * Fetches AI-curated job matches for a specific company.
 * Calls GET /api/ai-hub/jobs?company={companyName}.
 * Returns a full Employer object with nested job and contact data.
 */
export async function fetchJobMatches(companyName: string): Promise<Employer> {
  try {
    const headers = await getAuthHeader();
    const response = await axios.get(`${API_BASE_URL}/ai-hub/jobs`, {
      params: { company: companyName },
      headers,
    });
    return response.data;
  } catch (error: unknown) {
    const msg = axios.isAxiosError(error)
      ? error.response?.data?.error ?? error.message
      : `Failed to fetch job matches for ${companyName}`;
    throw new Error(msg);
  }
}

/**
 * Verifies whether a given email address is deliverable.
 * Calls POST /api/ai-hub/verify-email with the email address.
 * Returns verified status and confidence score (0–1).
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
 * Calls POST /api/ai-hub/jobs/{jobId}/contacts with the contact data.
 * Returns the newly created Contact object with server-generated ID and state.
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

const aiHubService = {
  analyzeWishlist,
  fetchJobMatches,
  verifyEmail,
  addContactToJob,
};

export default aiHubService;
