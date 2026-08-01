// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Firebase Analytics is TEMPORARILY DISABLED (v3.1): @react-native-firebase + Expo SDK 54 +
// New Architecture + static frameworks fail to co-compile on iOS. These are no-ops so the
// ad-conversion call sites (`app_activated` / `feed_opened` in HomeScreen / Discover) keep
// compiling and running harmlessly. Re-enable in 3.2 once the iOS native issue is solved:
// re-add @react-native-firebase/app+analytics + the config plugin + googleServicesFile, and
// restore the real implementation (see git history: commit 763e7c5).
// ⚠️ Firebase is still off, but these call sites are the ONLY record of several real user
// actions (google_search_opened, feed_opened, app_activated). Silently dropping them is why the
// 2026-08-01 pain analysis could not tell "nobody tapped Google Search" from "we never logged it".
// Mirror every call into our own first-party analytics, which does reach the server.
export async function logEvent(event: string, params?: Record<string, any>): Promise<void> {
  try {
    const { track } = require('./analytics');
    await track(event, params);
  } catch { /* analytics must never break a screen */ }
}
export async function setAnalyticsUserId(_id: string | null): Promise<void> {
  /* no-op until Firebase is re-enabled in 3.2 */
}
