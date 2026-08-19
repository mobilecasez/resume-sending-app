// Résumé score — new feature. Safe to delete without affecting existing app.
// Client for the background résumé verdict shown on Home.
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';

async function authHeader(): Promise<Record<string, string>> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    const s = raw ? JSON.parse(raw) : null;
    if (s?.token) return { Authorization: `Bearer ${s.token}` };
  } catch {}
  return {};
}

export type Improvement = { title: string; detail: string };
export type ResumeScore = {
  id: number;
  score: number;
  band: string;
  headline: string;
  summary: string;
  improvements: Improvement[];
  subscores: { impact?: number; clarity?: number; keywords?: number; completeness?: number };
  source: 'builder' | 'upload' | string;
  createdAt: string;
  previousScore: number | null;
};

/**
 * The latest verdict. EVERY failure returns "nothing to show" rather than throwing: this is called
 * on Home focus, and a flaky network must never surface an error on the user's home screen for a
 * feature they did not ask for.
 */
export async function fetchResumeScore(): Promise<{ hasScore: boolean; shouldPrompt: boolean; score?: ResumeScore }> {
  try {
    const headers = await authHeader();
    const { data } = await axios.get(`${API_BASE}/resume-score`, { headers, timeout: 15000 });
    return data && typeof data === 'object' ? data : { hasScore: false, shouldPrompt: false };
  } catch {
    return { hasScore: false, shouldPrompt: false };
  }
}

/** Record that the popup was seen / dismissed / acted on. Fire-and-forget. */
export async function markResumeScore(scoreId: number, what: 'shown' | 'dismissed' | 'acted'): Promise<void> {
  try {
    const headers = await authHeader();
    await axios.post(`${API_BASE}/resume-score/mark`, { scoreId, what }, { headers, timeout: 10000 });
  } catch {}
}

/**
 * Claim the free rewrite before entering the builder. Returns whether it is actually free — the
 * server can legitimately say no (a device that already used its trial), and the UI must be able to
 * tell the truth rather than repeat the promise on the button.
 */
export async function claimEnhancePass(scoreId: number): Promise<{ ok: boolean; free: boolean }> {
  try {
    const headers = await authHeader();
    const { data } = await axios.post(`${API_BASE}/resume-score/enhance-pass`, { scoreId }, { headers, timeout: 15000 });
    return { ok: !!data?.ok, free: !!data?.free };
  } catch {
    return { ok: true, free: false };
  }
}

/**
 * The user's current résumé as editable prose, for prefilling the builder. Returns '' when there is
 * nothing to pull — the builder must then behave exactly as it always did.
 */
export async function fetchResumeSourceText(): Promise<string> {
  try {
    const headers = await authHeader();
    const { data } = await axios.get(`${API_BASE}/resume-score/source-text`, { headers, timeout: 20000 });
    return data?.hasText && typeof data.text === 'string' ? data.text : '';
  } catch {
    return '';
  }
}
