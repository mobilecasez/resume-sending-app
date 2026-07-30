// AI Hub — new feature. Safe to delete without affecting existing app.
//
// A stable per-device id for trial dedupe. Stored in SecureStore, which on iOS is the KEYCHAIN —
// it survives app deletion + reinstall, so "delete the app, sign up with a new email" does NOT
// reset the 7-day trial. On Android keychain persistence across reinstalls is not guaranteed
// (best-effort; the server also records an ip hash as a weak secondary signal).
//
// The id is random (no fingerprinting, no hardware identifiers) — it identifies the INSTALL
// KEYCHAIN, not the person, which is all trial dedupe needs and the store-policy-safe choice.
import * as SecureStore from 'expo-secure-store';

const KEY = 'cvapplyr_device_v1';
let cached: string | null = null;

function randomId(): string {
  // 32 hex chars from Math.random+time — collision odds are irrelevant at this scale, and it
  // avoids pulling in expo-crypto. Matches the server's /^[A-Za-z0-9_-]{8,80}$/ validation.
  let s = Date.now().toString(16);
  while (s.length < 32) s += Math.floor(Math.random() * 16).toString(16);
  return s.slice(0, 32);
}

export async function getDeviceId(): Promise<string | null> {
  if (cached) return cached;
  try {
    let id = await SecureStore.getItemAsync(KEY);
    if (!id || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
      id = randomId();
      await SecureStore.setItemAsync(KEY, id);
    }
    cached = id;
    return id;
  } catch {
    return null;   // SecureStore unavailable → server falls back to per-user trial
  }
}

/** Header fragment for requests that participate in trial/quota decisions. */
export async function deviceHeader(): Promise<Record<string, string>> {
  const id = await getDeviceId();
  return id ? { 'x-device-id': id } : {};
}
