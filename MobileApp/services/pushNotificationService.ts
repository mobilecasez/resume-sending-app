// AI Hub — push notifications. Notifies the user when a slow employer job
// search finishes. Self-contained: does NOT import from aiHubService.ts.

import axios from 'axios';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';

// Hard-coded fallback matches app.json extra.eas.projectId.
const EAS_PROJECT_ID = 'ec507052-8ddd-49ea-89ec-d278eb1c7f58';

// Show a banner + play a sound even when the app is in the foreground.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // shouldShowAlert is the legacy field; shouldShowBanner/List are the SDK 54+ fields.
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Registers this device for Expo push notifications and saves the token to the
 * backend so it can notify the user when a job search completes.
 *
 * Best-effort: never throws. Returns the Expo push token on success, or null
 * (simulator, permission denied, not logged in, or any error).
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  try {
    // Push tokens are only available on physical devices.
    if (!Device.isDevice) {
      return null;
    }

    // Android requires a notification channel for notifications to appear.
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#06B6D4',
      });
    }

    // Request notification permission if we don't already have it.
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      return null;
    }

    // Resolve the EAS projectId (required for getExpoPushTokenAsync).
    const projectId =
      (Constants.expoConfig?.extra as any)?.eas?.projectId ?? EAS_PROJECT_ID;

    const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
    const expoPushToken = tokenResponse?.data;
    if (!expoPushToken) {
      return null;
    }

    // Read the auth session (same key/pattern the rest of the app uses).
    let authToken: string | null = null;
    try {
      const raw = await SecureStore.getItemAsync('userSession');
      if (raw) {
        const session = JSON.parse(raw);
        if (session?.token) authToken = session.token;
      }
    } catch {
      authToken = null;
    }

    // Only register the token with the backend when the user is logged in.
    if (authToken) {
      try {
        await axios.post(
          `${API_BASE}/user/push-token`,
          { token: expoPushToken },
          { headers: { Authorization: `Bearer ${authToken}` } }
        );
      } catch {
        // Saving the token failed — still return it so callers can retry later.
      }
    }

    return expoPushToken;
  } catch {
    // Never throw — push notifications are a best-effort enhancement.
    return null;
  }
}

/**
 * Registers a listener for when the user taps a notification (e.g. a
 * "job_search_complete" push). The caller wires navigation in the handler.
 * Returns the subscription so the caller can remove() it on cleanup.
 */
export function addNotificationResponseListener(
  handler: (response: Notifications.NotificationResponse) => void
): Notifications.EventSubscription {
  return Notifications.addNotificationResponseReceivedListener(handler);
}
