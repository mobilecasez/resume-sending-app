// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Client for the subscription/quota backend: plan catalog + the user's entitlement picture,
// the detailed usage ledger, and the once-per-launch device report (trial dedupe).
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';
import { deviceHeader, getDeviceId } from './deviceId';

async function authHeader(): Promise<Record<string, string>> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    const s = raw ? JSON.parse(raw) : null;
    if (s?.token) return { Authorization: `Bearer ${s.token}` };
  } catch {}
  return {};
}

export type Plan = {
  key: string; label: string; priceUsd: number; letters: number; resumes: number;
  productIos?: string; productAndroid?: string;
};
export type SubscriptionStatus = {
  plans: Plan[];
  trial: { key: string; label: string; days: number; letters: number; resumes: number };
  subscription: { planKey: string; label: string; periodEnd: string; source: string } | null;
  trialState?: { active: boolean; startedAt?: string; endsAt?: string; blocked?: string; used?: { letters: number; resumes: number } };
  remaining: { letters: number; resumes: number };
  used: { letters: number; resumes: number };
  via: 'plan' | 'trial' | null;
  legacyCredits?: number;
};
export type UsageItem = {
  id: number; kind: 'cover_letter' | 'resume'; source: 'plan' | 'trial' | 'credits';
  planKey: string | null; detail: Record<string, any>; createdAt: string;
};

export async function fetchSubscriptionStatus(): Promise<SubscriptionStatus> {
  const headers = { ...(await authHeader()), ...(await deviceHeader()) };
  const { data } = await axios.get(`${API_BASE}/subscription/status`, { headers, timeout: 20000 });
  return data as SubscriptionStatus;
}

export async function fetchUsage(limit = 100): Promise<UsageItem[]> {
  const headers = await authHeader();
  const { data } = await axios.get(`${API_BASE}/subscription/usage?limit=${limit}`, { headers, timeout: 20000 });
  return (data?.items ?? []) as UsageItem[];
}

/** Fire-and-forget device report; the server uses it to enforce one-trial-per-device. */
export async function reportDeviceOnce(): Promise<void> {
  try {
    const auth = await authHeader();
    if (!auth.Authorization) return;
    const deviceId = await getDeviceId();
    if (!deviceId) return;
    await axios.post(`${API_BASE}/subscription/device`, { deviceId }, { headers: auth, timeout: 15000 });
  } catch { /* never block launch on this */ }
}

/** Admin-only: assign/clear a plan for a user (testing until store products exist). */
export async function adminSetSubscription(userId: number, planKey: string | null): Promise<boolean> {
  try {
    const headers = await authHeader();
    const { data } = await axios.post(`${API_BASE}/admin/set-subscription`, { userId, planKey }, { headers, timeout: 15000 });
    return !!data?.success;
  } catch { return false; }
}
