// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Crash-proof wrapper over Firebase Analytics. Firebase feeds Google Ads so campaigns can bid for
// REAL activated users (not cheap installs). In Expo Go / dev (native module absent) every call is a
// silent no-op — the app never crashes if Firebase isn't linked. Only fires in a real native build.
let _analytics: any = null;
let _tried = false;
function getAnalytics(): any {
  if (_tried) return _analytics;
  _tried = true;
  try { _analytics = require('@react-native-firebase/analytics').default; } catch { _analytics = null; }
  return _analytics;
}

/** Log a Firebase Analytics event (best-effort; no-op if Firebase is unavailable). */
export async function logEvent(event: string, params?: Record<string, any>): Promise<void> {
  try {
    const a = getAnalytics();
    if (a) await a().logEvent(event, params || {});
  } catch { /* Firebase not linked (Expo Go/dev) — ignore */ }
}

/** Associate events with a user id (for cross-device attribution). Best-effort. */
export async function setAnalyticsUserId(id: string | null): Promise<void> {
  try { const a = getAnalytics(); if (a) await a().setUserId(id); } catch { /* ignore */ }
}
