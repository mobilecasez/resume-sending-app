import { useEffect, useRef, useState } from 'react';
import { AppState, Alert } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { track } from '../services/analytics';
import { addNotificationResponseListener } from '../services/pushNotificationService';
import { handleNotificationResponse, handleColdStartNotification } from '../services/pushRouting';
import { applyEnvironmentOverride, defaultEnvironmentKey, urlForEnvironment } from '../config';
import UpdateGate from '../components/UpdateGate';

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

// ── ADMIN ENVIRONMENT OVERRIDE — startup ──────────────────────────────────────
// AI Hub — new feature. Safe to delete without affecting existing app.
//
// An admin can point THEIR OWN device at a different backend (app/(admin)/environment.tsx). This is
// where that choice is honoured, and it is the ONLY place it is ever honoured, because:
//
//   • `${API_BASE}` is read at request time through an ES live binding, so the value has to be
//     right BEFORE the first request leaves. The earliest ones fire on mount, so the override is
//     resolved here and the first frame is held until it settles.
//   • It is never re-applied mid-session. A session token minted by one database is meaningless in
//     another, and several modules keep their own copy of the base URL — a mid-session switch would
//     leave the app half on each backend, which is far worse than not switching at all.
//
// FOR A NORMAL (NON-ADMIN) USER exactly one extra thing happens at launch: the AsyncStorage.getItem
// below returns null and we fall straight through to this build's compile-time default. No record
// exists on their device, nothing is fetched, nothing is decided, nothing about their app changes.
export const ADMIN_ENV_KEY = 'cvapplyr_admin_env_v1';

/**
 * The single record behind this feature. It carries BOTH the chosen environment and the persisted
 * admin verdict — the fact, confirmed by the server at the time, that the person who wrote it was
 * an administrator. Persisting that verdict is deliberate: applying a switch signs the admin out,
 * so at the next launch there is BY CONSTRUCTION no live session to ask, and there is none to ask
 * either when the chosen backend is unreachable. The record is only ever written after
 * `/user/is-admin` answered true (see app/(admin)/environment.tsx), so its existence IS the
 * device-level proof, and it is bound to that admin's identity so nobody else inherits it.
 */
export type AdminEnvRecord = {
  v: 1;
  /** An environment key from config.ENVIRONMENTS, or null = "use this build's default". */
  key: string | null;
  /** Who was verified here, so a different user signing in on this device cannot inherit it. */
  adminUserId: string | null;
  adminEmail: string | null;
  /** ISO timestamp of the last server-confirmed admin check. Null = never verified = ignored. */
  verifiedAt: string | null;
  /**
   * Set when a switch is applied; cleared the next time the app cold-starts.
   *
   * The switch screen deletes the session, but the app KEEPS RUNNING until the admin quits, and
   * App.js re-writes SecureStore 'userSession' on every change to its in-memory user object (a
   * credit refresh is enough). So a session belonging to the old database can quietly come back
   * between the switch and the restart. This flag makes the sign-out survive that: the deletion is
   * repeated here at startup, before anything reads a token and before the first frame renders.
   */
  pendingSignOut?: boolean;
};

/** The three token namespaces in this app. App.js only knows about the first. */
export const SESSION_KEYS = ['userSession', 'authToken', 'userData'];

export type SessionUser = { id: string | null; email: string | null; token: string | null };

/** Read the signed-in user the same way services/pushNotificationService.ts does. Never throws —
 *  a missing, unreadable or corrupt session simply reads as "nobody is signed in". */
export async function readSessionUser(): Promise<SessionUser | null> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    if (!raw) return null;
    const s = JSON.parse(raw) as { id?: unknown; email?: unknown; token?: unknown } | null;
    if (!s || typeof s !== 'object') return null;
    const token = typeof s.token === 'string' && s.token ? s.token : null;
    if (!token) return null;   // App.js treats a token-less blob as no session; so do we
    return {
      id: s.id == null ? null : String(s.id),
      email: typeof s.email === 'string' ? s.email : null,
      token,
    };
  } catch {
    return null;
  }
}

/** Is the signed-in user the same person the record was written for? Id first, email as fallback. */
export function sameAdmin(session: SessionUser | null, rec: AdminEnvRecord | null): boolean {
  if (!session || !rec) return false;
  // Either identifier matching is enough. Comparing ids FIRST and returning outright meant that a
  // session which had an id but a record which did not (or vice versa) reported "different person",
  // silently discarding the admin's own override on a later restart.
  if (session.id && rec.adminUserId && session.id === rec.adminUserId) return true;
  const a = String(session.email || '').trim().toLowerCase();
  const b = String(rec.adminEmail || '').trim().toLowerCase();
  if (a && b && a === b) return true;
  return false;
}

/** The stored record, or null. Anything malformed reads as "no record" rather than as an error. */
export async function readAdminEnvRecord(): Promise<AdminEnvRecord | null> {
  try {
    const raw = await AsyncStorage.getItem(ADMIN_ENV_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<AdminEnvRecord> | null;
    if (!p || typeof p !== 'object' || p.v !== 1) return null;
    return {
      v: 1,
      key: typeof p.key === 'string' && p.key ? p.key : null,
      adminUserId: typeof p.adminUserId === 'string' && p.adminUserId ? p.adminUserId : null,
      adminEmail: typeof p.adminEmail === 'string' && p.adminEmail ? p.adminEmail : null,
      verifiedAt: typeof p.verifiedAt === 'string' && p.verifiedAt ? p.verifiedAt : null,
      pendingSignOut: p.pendingSignOut === true,
    };
  } catch {
    return null;
  }
}

/** Merge a change into the record and store it. Returns the record as it now stands on disk. */
export async function writeAdminEnvRecord(patch: Partial<AdminEnvRecord>): Promise<AdminEnvRecord> {
  const current: AdminEnvRecord = (await readAdminEnvRecord()) || {
    v: 1, key: null, adminUserId: null, adminEmail: null, verifiedAt: null, pendingSignOut: false,
  };
  const next: AdminEnvRecord = { ...current, ...patch, v: 1 };
  // Defence in depth: an unknown key can never reach storage, so it can never reach API_BASE.
  if (next.key && !urlForEnvironment(next.key)) next.key = null;
  await AsyncStorage.setItem(ADMIN_ENV_KEY, JSON.stringify(next));
  return next;
}

/** Drop the whole record — used when a different user signs in on this device. */
export async function forgetAdminEnvRecord(): Promise<void> {
  try { await AsyncStorage.removeItem(ADMIN_ENV_KEY); } catch { /* nothing we can do */ }
}

/** Delete every stored token. Used by the switch screen and again here at the next cold start. */
export async function deleteAllSessions(): Promise<void> {
  for (const k of SESSION_KEYS) {
    try { await SecureStore.deleteItemAsync(k); } catch { /* nothing stored under it */ }
  }
}

/**
 * Apply the stored override, if there is a legitimate one. Returns the environment key actually in
 * force, so a caller can log it. NEVER throws, and never returns anything but a known key.
 */
export async function applyStoredEnvironmentOverride(opts?: { isStale?: () => boolean }): Promise<string> {
  const fallback = defaultEnvironmentKey();
  try {
    const rec = await readAdminEnvRecord();
    if (!rec) return fallback;                            // ← every normal user stops on this line

    // Finish the sign-out the switch screen started, in case the old session was re-saved while the
    // app kept running between the switch and this restart. Done first, and regardless of whether
    // the override below turns out to be usable: the admin asked to be signed out either way.
    if (rec.pendingSignOut) {
      // ⚠️ Replay the FULL wipe, not just the session delete. Between Apply and this restart the app
      // kept running against the OLD backend, so it will have re-populated the Job-Hub SWR cache and
      // friends with data from there. Deleting only the session would leave production job cards on
      // screen while every request goes to local — the app would look like it had switched and be
      // showing the other database's data.
      try {
        const { wipeStateForSwitch } = require('./(admin)/environment');
        if (typeof wipeStateForSwitch === 'function') await wipeStateForSwitch();
        else await deleteAllSessions();
      } catch {
        await deleteAllSessions();   // wipe unavailable → at least the session must go
      }
      try { await writeAdminEnvRecord({ pendingSignOut: false }); } catch { /* retried next launch */ }
    }

    if (!rec.verifiedAt) return fallback;                 // never server-confirmed → not an admin
    if (!rec.key || !urlForEnvironment(rec.key)) return fallback;  // no override, or an unknown key

    // ⚠️ The admin verdict EXPIRES. It is a cached answer to "is this person an admin?", and that
    // answer can change server-side (demotion, a cleaned-up compromised account) with nothing to tell
    // this device. Without a ceiling the override would outlive the privilege that justified it.
    const verifiedMs = Date.parse(String(rec.verifiedAt));
    if (!Number.isFinite(verifiedMs) || Date.now() - verifiedMs > ADMIN_VERDICT_TTL_MS) {
      await forgetAdminEnvRecord();
      return fallback;
    }

    // ⚠️ REQUIRE a signed-in matching admin. The previous version applied the override when there was
    // NO session, reasoning that a switch signs you out — but "no session" is also a plain logged-out
    // device, and that was the single path by which a non-admin could leave production. The pending
    // sign-out above is already handled; a launch with no session simply boots on the default, and
    // the override applies again once the admin signs back in and restarts.
    const session = await readSessionUser();
    if (!session || !sameAdmin(session, rec)) {
      if (session) await forgetAdminEnvRecord();   // a DIFFERENT user owns this device now
      return fallback;                             // no session → keep the record, just don't apply it
    }

    if (opts && typeof opts.isStale === 'function' && opts.isStale()) return fallback;   // see the race note
    return applyEnvironmentOverride(rec.key);
  } catch {
    return fallback;   // any surprise at all → this build's default, which is what users get
  }
}

// If the storage layer ever hangs, the app must still start. Past this point we give up on the
// override and boot on the compile-time default rather than sit on the splash screen forever.
const ENV_RESOLVE_TIMEOUT_MS = 2500;

// How long a server-confirmed "this user is an admin" verdict stays good on this device.
const ADMIN_VERDICT_TTL_MS = 14 * 24 * 60 * 60 * 1000;   // 14 days

// Cold start: App.js restores the session asynchronously after this layout mounts. Give it a moment
// before navigating, so the tap's destination isn't stomped by the post-restore screen change.
const COLD_START_DELAY_MS = 1200;

export default function RootLayout() {
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => { routerRef.current = router; }, [router]);

  // Nothing renders and no request goes out until this is true. See the block comment above.
  const [envReady, setEnvReady] = useState(false);

  useEffect(() => {
    let settled = false;
    // ⚠️ `timedOut` is the whole point. If the guard fires we have ALREADY rendered on the
    // compile-time default and requests are in flight — letting the slow resolver apply the override
    // afterwards would retarget the app mid-session, which is precisely the half-switch (some calls
    // to production, some to local, one token) this design exists to prevent. Once we time out, the
    // override is abandoned for this launch; the next cold start will apply it cleanly.
    let timedOut = false;
    const finish = () => { if (!settled) { settled = true; setEnvReady(true); } };
    const guard = setTimeout(() => { timedOut = true; finish(); }, ENV_RESOLVE_TIMEOUT_MS);
    applyStoredEnvironmentOverride({ isStale: () => timedOut })
      .catch(() => { /* it already swallows everything; this is belt and braces */ })
      .then(() => { clearTimeout(guard); finish(); });
    return () => clearTimeout(guard);
  }, []);

  useEffect(() => {
    // Hide the splash only once the backend address is settled, so the first frame the user sees is
    // already pointed at the right place.
    if (!envReady) return;
    SplashScreen.hideAsync().catch(() => { /* already hidden */ });
  }, [envReady]);

  // ── NOTIFICATION TAPS ───────────────────────────────────────────────────────────────────────
  // Two paths, one handler (services/pushRouting.ts de-dupes so a tap is never acted on twice):
  //  • WARM  — app already running: the response listener fires.
  //  • COLD  — the tap LAUNCHED the app: the listener never fires, so read the launch response once.
  // Everything is guarded (the listener helper returns null without the native module) so a build
  // without expo-notifications still boots — this is the ROOT layout, a throw here kills the app.
  // Gated on envReady for two reasons: these handlers navigate, so the navigator has to be mounted,
  // and the payload they resolve came from a backend, so it must be resolved against the right one.
  useEffect(() => {
    if (!envReady) return;
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
  }, [envReady]);

  // First-party analytics — report app opens + foreground returns so the admin dashboard shows
  // LIVE activity (active users now) instead of the 1–3 day store reports. Fire-and-forget.
  // This is the earliest request the app makes, so it waits for the address to settle too.
  // Report the keychain-persisted device id once per launch (trial dedupe — one 7-day trial per
  // device). Delayed a beat so the session restore has landed; silently a no-op when signed out.
  useEffect(() => {
    if (!envReady) return;
    const t = setTimeout(() => {
      try { require('../services/subscriptionService').reportDeviceOnce(); } catch { /* optional */ }
    }, 4000);
    return () => clearTimeout(t);
  }, [envReady]);

  useEffect(() => {
    if (!envReady) return;
    track('app_open');
    let prev = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      if (/inactive|background/.test(prev) && next === 'active') track('foreground');
      prev = next;
    });
    return () => sub.remove();
  }, [envReady]);

  // The splash screen is still up here — this is one AsyncStorage read, a few milliseconds.
  if (!envReady) return null;

  return (
    <>
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
      {/* Mounted OUTSIDE the navigator so a hard block covers every route, including any screen
          reached from a push deep link. It renders nothing at all unless the server says so. */}
      <UpdateGate />
    </>
  );
}
