// AI Hub — new feature. Safe to delete without affecting existing app.
//
// First-party real-time analytics — fire-and-forget event reporting to our backend so the admin
// dashboard can show LIVE activity (active users right now, by platform) without the 1–3 day
// store-report delay. Never throws; never blocks the UI.
import axios from 'axios';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { API_BASE } from '../config';

let _anonId: string | null = null;
async function getAnonId(): Promise<string> {
  if (_anonId) return _anonId;
  try {
    let id = await SecureStore.getItemAsync('analyticsAnonId');
    if (!id) {
      id = 'a_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      await SecureStore.setItemAsync('analyticsAnonId', id);
    }
    _anonId = id;
    return id;
  } catch {
    return 'anon';
  }
}

async function getToken(): Promise<string | null> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s?.token || null;
  } catch {
    return null;
  }
}

const APP_VERSION: string =
  (Constants as any)?.expoConfig?.version || (Constants as any)?.manifest?.version || '';

export async function track(event: string, props?: Record<string, any>): Promise<void> {
  try {
    const [token, anonId] = await Promise.all([getToken(), getAnonId()]);
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    await axios.post(
      `${API_BASE}/analytics/track`,
      { event, props, platform: Platform.OS, appVersion: APP_VERSION, anonId },
      { headers, timeout: 6000 }
    );
  } catch {
    /* best-effort — analytics must never affect the app */
  }
}

export default { track };
