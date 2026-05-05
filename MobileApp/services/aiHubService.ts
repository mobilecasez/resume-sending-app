// AI Hub — new feature. Safe to delete without affecting existing app.

import type { Contact, Employer } from '../types/aiHub';

/**
 * Analyzes the user's wishlist of target companies.
 * When connected to the real backend, this will call the AI analysis endpoint
 * which scrapes each company's careers page, identifies open roles, and scores
 * them against the user's stored resume using an LLM similarity model.
 *
 * @param companies - Array of company names or career page URLs to analyze.
 * @returns Object containing the number of matches found and sources scanned.
 */
export async function analyzeWishlist(
  companies: string[]
): Promise<{ matches: number; sources: number }> {
  // Mock — replace with: POST /api/ai-hub/analyze { companies }
  await new Promise<void>((resolve) => setTimeout(resolve, 400));
  return { matches: 12, sources: companies.length };
}

/**
 * Fetches AI-curated job matches for a specific company.
 * When connected to the real backend, this will return live job postings
 * scraped from the company's careers portal, ranked by resume-match score,
 * with verified hiring manager contacts pre-populated.
 *
 * @param companyName - The company name or URL to fetch job matches for.
 * @returns A full Employer object with nested job and contact data.
 */
export async function fetchJobMatches(companyName: string): Promise<Employer> {
  // Mock — replace with: GET /api/ai-hub/matches?company=<companyName>
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  return {
    id: `mock-${Date.now()}`,
    name: companyName,
    subInfo: 'Location TBD · Industry TBD',
    logoColor: ['#06B6D4', '#3B82F6'],
    logoInitial: companyName.charAt(0).toUpperCase(),
    status: 'watching',
    jobs: [],
  };
}

/**
 * Verifies whether a given email address is deliverable and belongs to an
 * active employee at the target company.
 * When connected to the real backend, this will call the email verification
 * microservice which uses SMTP handshake probing combined with LinkedIn
 * cross-referencing.
 *
 * @param email - The email address to verify.
 * @returns Object containing verified status and confidence score (0–1).
 */
export async function verifyEmail(
  email: string
): Promise<{ verified: boolean; confidence: number }> {
  // Mock — replace with: POST /api/ai-hub/verify-email { email }
  await new Promise<void>((resolve) => setTimeout(resolve, 200));
  console.log(`[aiHubService] Verifying email: ${email}`);
  return { verified: true, confidence: 0.94 };
}

/**
 * Adds a manually-entered contact to a specific job in the user's AI Hub.
 * When connected to the real backend, this will persist the contact to the
 * database, trigger async email verification, and optionally attempt to
 * find additional social profiles for the contact.
 *
 * @param jobId - The ID of the job this contact is associated with.
 * @param contact - The contact details (without id, verified, or avatarColor).
 * @returns The newly created Contact object with generated ID and default state.
 */
export async function addContactToJob(
  jobId: string,
  contact: Omit<Contact, 'id' | 'verified' | 'avatarColor'>
): Promise<Contact> {
  // Mock — replace with: POST /api/ai-hub/jobs/:jobId/contacts { contact }
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  console.log(`[aiHubService] Adding contact to job ${jobId}:`, contact.name);
  return {
    ...contact,
    id: `contact-${Date.now()}`,
    verified: false,
    avatarColor: ['#64748B', '#475569'],
  };
}

const aiHubService = {
  analyzeWishlist,
  fetchJobMatches,
  verifyEmail,
  addContactToJob,
};

export default aiHubService;
