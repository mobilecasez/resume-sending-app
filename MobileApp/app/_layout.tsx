import { useEffect } from 'react';
import { AppState } from 'react-native';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { track } from '../services/analytics';

// Keep the splash screen visible until we explicitly hide it
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  useEffect(() => {
    // Hide the splash screen once the layout (and first screen) has mounted
    SplashScreen.hideAsync();
  }, []);

  // First-party analytics — report app opens + foreground returns so the admin dashboard shows
  // LIVE activity (active users now) instead of the 1–3 day store reports. Fire-and-forget.
  useEffect(() => {
    track('app_open');
    let prev = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      if (/inactive|background/.test(prev) && next === 'active') track('foreground');
      prev = next;
    });
    return () => sub.remove();
  }, []);

  return (
    <Stack
      initialRouteName="index"
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#06091B' },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="index" options={{ animation: 'none' }} />
      <Stack.Screen name="(ai-hub)" options={{ headerShown: false }} />
      <Stack.Screen name="(resume-builder)" options={{ headerShown: false }} />
    </Stack>
  );
}
