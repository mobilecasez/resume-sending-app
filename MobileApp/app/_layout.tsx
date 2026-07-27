import { useEffect, useRef } from 'react';
import { AppState, Alert } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { track } from '../services/analytics';
import { addNotificationResponseListener } from '../services/pushNotificationService';
import { handleNotificationResponse, handleColdStartNotification } from '../services/pushRouting';

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

// Cold start: App.js restores the session asynchronously after this layout mounts. Give it a moment
// before navigating, so the tap's destination isn't stomped by the post-restore screen change.
const COLD_START_DELAY_MS = 1200;

export default function RootLayout() {
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => { routerRef.current = router; }, [router]);

  useEffect(() => {
    // Hide the splash screen once the layout (and first screen) has mounted
    SplashScreen.hideAsync();
  }, []);

  // ── NOTIFICATION TAPS ───────────────────────────────────────────────────────────────────────
  // Two paths, one handler (services/pushRouting.ts de-dupes so a tap is never acted on twice):
  //  • WARM  — app already running: the response listener fires.
  //  • COLD  — the tap LAUNCHED the app: the listener never fires, so read the launch response once.
  // Everything is guarded (the listener helper returns null without the native module) so a build
  // without expo-notifications still boots — this is the ROOT layout, a throw here kills the app.
  useEffect(() => {
    let cancelled = false;
    let sub: any = null;
    try {
      sub = addNotificationResponseListener((response: any) => {
        if (cancelled) return;
        handleNotificationResponse(response, routerRef.current).catch(() => {});
      });
    } catch { sub = null; }

    const t = setTimeout(() => {
      if (cancelled) return;
      handleColdStartNotification(routerRef.current).catch(() => {});
    }, COLD_START_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(t);
      try { sub?.remove?.(); } catch { /* nothing to remove */ }
    };
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
