// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Rating / feedback orchestration. Compliant "review routing":
//   • happy users (4–5★) → the platform's NATIVE store review sheet (expo-store-review)
//   • unhappy users (1–3★) → private feedback to our backend (never the store)
// Frequency-capped so it never nags. We never submit a star value to the store — the
// native sheet lets the user choose; we only decide WHO is shown it.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform, Linking } from 'react-native';
import * as StoreReview from 'expo-store-review';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import axios from 'axios';
import { API_BASE } from '../config';

// In Expo Go the native review sheet targets Expo Go itself (not our app). Real builds
// (TestFlight / App Store / Play) target CVApplyr correctly.
const IS_EXPO_GO = Constants.appOwnership === 'expo';

const KEY = 'cvapplyr_rating_state_v1';
const MAX_ASKS = 4;                               // hard cap on lifetime prompts
const COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000;      // ≥ 2 days between prompts
let askedThisSession = false;

type RatingState = { rated: boolean; handled: boolean; askCount: number; lastAskAt: number };

async function getState(): Promise<RatingState> {
  try { const raw = await AsyncStorage.getItem(KEY); if (raw) return JSON.parse(raw); } catch {}
  return { rated: false, handled: false, askCount: 0, lastAskAt: 0 };
}
async function setState(s: RatingState) { try { await AsyncStorage.setItem(KEY, JSON.stringify(s)); } catch {} }

/** Should we surface the prompt now? (not rated, within cap, past cooldown, once/session) */
export async function shouldAskForReview(): Promise<boolean> {
  if (askedThisSession) return false;
  const s = await getState();
  if (s.rated) return false;
  if (s.askCount >= MAX_ASKS) return false;
  if (s.lastAskAt && Date.now() - s.lastAskAt < COOLDOWN_MS) return false;
  return true;
}

export async function recordAsked() {
  askedThisSession = true;
  const s = await getState();
  await setState({ ...s, askCount: s.askCount + 1, lastAskAt: Date.now() });
}

export async function markRated() { const s = await getState(); await setState({ ...s, rated: true }); }
export async function markHandled() { const s = await getState(); await setState({ ...s, handled: true }); }

/** Open the platform's native in-app review (4–5★ path); fall back to the store page. */
export async function openNativeReview() {
  try {
    // Skip the native sheet in Expo Go (it would prompt an Expo Go review); deep-link to
    // our real listing instead. Real builds use the native in-app review for CVApplyr.
    if (!IS_EXPO_GO && await StoreReview.isAvailableAsync()) {
      await StoreReview.requestReview();
      return;
    }
  } catch {}
  try {
    const url = Platform.OS === 'ios'
      ? 'https://apps.apple.com/app/id6762126502?action=write-review'
      : 'market://details?id=com.cvapplyr.mobile';
    await Linking.openURL(url);
  } catch {}
}

async function authHeader(): Promise<Record<string, string>> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    const t = raw ? JSON.parse(raw)?.token : null;
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

/** Submit feedback / rating. Records the rating (so the "Rate the app" reward is granted server-side) and
 *  returns the reward, if any, so the caller can celebrate the earned credits. Best-effort. */
export async function submitFeedback(rating: number, message: string, trigger: string, appVersion?: string): Promise<{ reward?: { key: string; credits: number } | null } | null> {
  try {
    const headers = await authHeader();
    const { data } = await axios.post(
      `${API_BASE}/feedback`,
      { rating, message, trigger, platform: Platform.OS, appVersion: appVersion || null },
      { headers }
    );
    return data || null;
  } catch { return null; }   // best-effort; never block the user
}
