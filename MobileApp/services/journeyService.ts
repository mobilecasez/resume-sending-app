// Activation journey — new feature. Safe to delete without affecting existing app.
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

export type JourneyStep = { key: string; n: number; title: string; blurb: string; done: boolean };
export type Journey = {
  steps: JourneyStep[];
  nextKey: string | null;
  nextN: number | null;
  completed: number;
  total: number;
  pct: number;
  complete: boolean;
};

/** Never throws — this drives a home-screen nudge, so a flaky network must show nothing, not an error. */
export async function fetchJourney(): Promise<Journey | null> {
  try {
    const headers = await authHeader();
    const { data } = await axios.get(`${API_BASE}/journey`, { headers, timeout: 15000 });
    if (!data || !Array.isArray(data.steps) || !data.steps.length) return null;
    return data as Journey;
  } catch {
    return null;
  }
}
