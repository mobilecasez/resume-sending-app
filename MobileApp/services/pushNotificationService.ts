// AI Hub — push notifications. Notifies the user when a slow employer job search finishes.
// Self-contained: does NOT import from aiHubService.ts.
//
// HARDENED: the expo-notifications / expo-device native modules are loaded via guarded require() so
// that a build WITHOUT them compiled in (an older dev build, or Expo Go) does NOT crash on import —
// everything just no-ops until a fresh build includes the native modules.

import axios from 'axios';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';

let Notifications: any = null;
let Device: any = null;
try { Notifications = require('expo-notifications'); } catch { Notifications = null; }
try { Device = require('expo-device'); } catch { Device = null; }

// Hard-coded fallback matches app.json extra.eas.projectId.
const EAS_PROJECT_ID = 'ec507052-8ddd-49ea-89ec-d278eb1c7f58';

// Show a banner + play a sound even when the app is in the foreground (guarded — no-op if the native
// module isn't in this build).
try {
  Notifications?.setNotificationHandler?.({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
} catch { /* native module not present in this build */ }

/**
 * Registers this device for Expo push notifications and saves the token to the backend so it can
 * notify the user when a job search completes. Best-effort: never throws. Returns the Expo push token,
 * or null (native module absent, simulator, permission denied, not logged in, or any error).
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  try {
    if (!Notifications || !Device) return null;       // native modules not in this build (old dev build / Expo Go)
    if (!Device.isDevice) return null;                // push tokens are only available on physical devices

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#06B6D4',
      });
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') return null;

    const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId ?? EAS_PROJECT_ID;
    const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
    const expoPushToken = tokenResponse?.data;
    if (!expoPushToken) return null;

    let authToken: string | null = null;
    try {
      const raw = await SecureStore.getItemAsync('userSession');
      if (raw) { const session = JSON.parse(raw); if (session?.token) authToken = session.token; }
    } catch { authToken = null; }

    if (authToken) {
      try {
        await axios.post(`${API_BASE}/user/push-token`, { token: expoPushToken }, { headers: { Authorization: `Bearer ${authToken}` } });
      } catch { /* token save failed — still return it */ }
    }

    return expoPushToken;
  } catch {
    return null;   // never throw — push is a best-effort enhancement
  }
}

/**
 * Registers a listener for when the user taps a notification (e.g. a "job_search_complete" push).
 * Returns the subscription so the caller can remove() it — or null if notifications aren't available.
 */
export function addNotificationResponseListener(handler: (response: any) => void): any {
  try { return Notifications?.addNotificationResponseReceivedListener?.(handler) ?? null; }
  catch { return null; }
}
