import { useEffect } from 'react';
import { AppState, Alert } from 'react-native';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { track } from '../services/analytics';

// Keep the splash screen visible until we explicitly hide it
SplashScreen.preventAutoHideAsync();

// ── GLOBAL CRASH GUARD ────────────────────────────────────────────────────────
// In a RELEASE build, an unhandled JS exception hard-crashes the app (no RedBox). Catch fatal JS
// errors instead: report them to our analytics (so we SEE crashes in the admin dashboard) and show
// a friendly alert. In dev, defer to the original handler (RedBox) so debugging stays normal.
const globalAny = global as any;
if (globalAny.ErrorUtils && !globalAny.__cvErrorGuard) {
  globalAny.__cvErrorGuard = true;
  const prevHandler = globalAny.ErrorUtils.getGlobalHandler && globalAny.ErrorUtils.getGlobalHandler();
  let lastAlertAt = 0;
  globalAny.ErrorUtils.setGlobalHandler((error: any, isFatal?: boolean) => {
    try { track('app_error', { message: String(error && error.message || error).slice(0, 300), fatal: !!isFatal }); } catch {}
    if (__DEV__) { prevHandler && prevHandler(error, isFatal); return; }
    if (isFatal) {
      const now = Date.now();
      if (now - lastAlertAt > 5000) {   // don't stack alerts if errors cascade
        lastAlertAt = now;
        try { Alert.alert('Something went wrong', 'That action hit a snag. Please try again — if it keeps happening, restart the app.'); } catch {}
      }
    } else {
      prevHandler && prevHandler(error, isFatal);
    }
  });
}

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
