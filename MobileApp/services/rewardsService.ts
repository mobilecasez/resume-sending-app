// AI Hub — new feature. Safe to delete without affecting existing app.
// Client for the credit-rewards + referral backend (services/creditRewards.js + referrals.js).
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';

async function authHeader(): Promise<Record<string, string>> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    const t = raw ? JSON.parse(raw)?.token : null;
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

export type Reward = { key: string; label: string; description: string; amount: number; earned: boolean; eligible: boolean; active: boolean };
export type RewardsStatus = { rewards: Reward[]; totalEarned: number; balance: number };

// GET /api/rewards — also auto-grants any newly-earned reward server-side; returns the fresh status.
export async function fetchRewards(): Promise<RewardsStatus> {
  try {
    const headers = await authHeader();
    const { data } = await axios.get(`${API_BASE}/rewards`, { headers, timeout: 20000 });
    return { rewards: (data && data.rewards) || [], totalEarned: (data && data.totalEarned) || 0, balance: (data && data.balance) || 0 };
  } catch { return { rewards: [], totalEarned: 0, balance: 0 }; }
}

export type ReferralInfo = { code: string; link: string; invited: number; qualified: number; creditsPerReferral: number };

export async function fetchReferral(): Promise<ReferralInfo | null> {
  try {
    const headers = await authHeader();
    const { data } = await axios.get(`${API_BASE}/referral`, { headers, timeout: 20000 });
    return { code: data.code, link: data.link, invited: data.invited || 0, qualified: data.qualified || 0, creditsPerReferral: data.creditsPerReferral || 0 };
  } catch { return null; }
}

// Redeem a friend's code (once, post-signup). Returns { ok, reason }.
export async function claimReferral(code: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const headers = await authHeader();
    await axios.post(`${API_BASE}/referral/claim`, { code: String(code || '').trim().toUpperCase() }, { headers, timeout: 20000 });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.response?.data?.reason || 'error' };
  }
}
