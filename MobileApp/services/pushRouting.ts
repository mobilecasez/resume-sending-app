// AI Hub — new feature. Safe to delete without affecting existing app.
//
// WHERE A TAPPED NOTIFICATION LANDS.
//
// Every push we send carries `data = { route, params }` (see the server's notification contract).
// This module turns that payload into ONE decision and then performs it:
//
//   '/(discover)' + { jobId }  → Explore feed, which opens that single job's detail
//   '/(discover)' + { sort }   → Explore feed, best matches first
//   '/(ai-hub)'   (+ { tab })  → Job Hub dashboard
//   'profile'                  → App.js Account Settings, via the AsyncStorage handoff key that
//                                App.js ALREADY consumes ('onboarding_focus_target')
//   'help'                     → AsyncStorage flag HomeScreen can read to open the in-app guide
//   'support'     (+ { focus, issue, threadId })
//                              → Help & support; a thread id opens that conversation, focus opens
//                                the "what went wrong" picker
//   'usage' | 'plans'          → Plans & Usage (quota, trial, granted bonus)
//   'rewards'                  → Earn free credits
//   anything else / malformed  → NOTHING. A push must never crash the app and must never dump the
//                                user on a random screen.
//
// The decision (`resolveRoute`) is a PURE function so it can be unit-tested with plain node —
// see MobileApp/scripts/test-push-routing.js. Only `handleNotificationRoute` touches the router
// and AsyncStorage.
//
// HARDENED like services/pushNotificationService.ts: expo-notifications and AsyncStorage are loaded
// through guarded require() so a build without those native modules still boots (everything no-ops).

let Notifications: any = null;
let AsyncStorage: any = null;
try { Notifications = require('expo-notifications'); } catch { Notifications = null; }
try { AsyncStorage = require('@react-native-async-storage/async-storage').default; } catch { AsyncStorage = null; }

/** The slice of expo-router's Router we use. Declared structurally (not imported) so this module
 *  stays require-able from a plain node test. */
export type PushRouter = {
  push?: (href: any) => void;
  canDismiss?: () => boolean;
  dismissAll?: () => void;
};

export type PushRouteAction = {
  /** 'navigate' = push an expo-router route. 'handoff' = write an AsyncStorage key App.js/HomeScreen
   *  already reads, then pop back to them. 'none' = do nothing at all. */
  kind: 'none' | 'navigate' | 'handoff';
  /** expo-router pathname (navigate only). */
  pathname?: string;
  /** Route params — always strings, because router params are strings. */
  params?: Record<string, string>;
  /** AsyncStorage key written BEFORE navigating (handoff only). */
  storage?: { key: string; value: string };
  /** Which hand-off HomeScreen must perform (handoff only) — writing the key is not enough on its
   *  own, see PENDING_NAV_KEY. */
  handoff?: 'profile' | 'help';
  /** The profile section to open, or 'help'. */
  target?: string;
  /** Why nothing happened — for logs/tests. */
  reason?: string;
};

/** What HomeScreen finds in PENDING_NAV_KEY. */
export type PendingNav = { handoff: 'profile' | 'help'; target: string; at: number };

// ── Keys + routes ─────────────────────────────────────────────────────────────────────────────
/** App.js reads this on entering the profile screen (written the same way HomeScreen does it —
 *  components/HomeScreen.js handleOnboardingStep → App.js's onboarding deep-link effect). */
export const FOCUS_TARGET_KEY = 'onboarding_focus_target';
/** Flag for HomeScreen to pop the in-app guide open on its next render. */
export const HELP_OPEN_KEY = 'help_open_tutorial';
/**
 * ⚠️ Writing FOCUS_TARGET_KEY is only HALF of a profile deep link, and the missing half is invisible.
 * App.js's consumer is gated on its own screen state (`if (screen !== 'profile') return`), and nothing
 * here can set that — App.js is off-limits. HomeScreen owns `setScreen`, so it is the one that has to
 * finish the job: this key is the request, and HomeScreen picks it up on focus and performs it.
 * Without it, tapping any of the six profile-targeting templates silently does nothing.
 *
 * It carries a timestamp because an unconsumed request must EXPIRE. Otherwise a tap that never
 * landed (app killed on the way) would sit in storage and hijack the user's next unrelated visit
 * days later, dropping them into edit mode on a section they never asked for.
 */
export const PENDING_NAV_KEY = 'push_pending_nav';
/** How long a pending hand-off stays valid. Long enough to survive a cold start, short enough that
 *  it can never surprise the user in a later session. */
export const PENDING_NAV_TTL_MS = 5 * 60 * 1000;
/** Last notification response we acted on — persisted so a STALE cold-start response is not
 *  re-handled on every launch. */
const HANDLED_KEY = 'push_last_handled_response';

const DISCOVER = '/(discover)';
const AI_HUB = '/(ai-hub)';
const SUPPORT = '/(support)';
const SUPPORT_THREAD = '/(support)/thread';
const ADMIN_SUPPORT = '/(admin)/support';
const USAGE = '/(subscription)/usage';
const PLANS = '/(subscription)/plans';
const REWARDS = '/(rewards)';
const TUTORIAL = '/(tutorial)';
/** Thread ids are integers from a SERIAL column — anything else is not one of ours. */
const THREAD_ID_RE = /^[0-9]{1,12}$/;

// App.js's profile screen understands these focus targets (HomeScreen/OnboardingChecklist use the
// same set). Anything else is ignored and falls back to 'profile'.
const PROFILE_TARGETS = ['profile', 'resume', 'photo', 'signature', 'account'];
// The Job Hub's existing ?tab= deep-link surface (app/(ai-hub)/index.tsx).
const AI_HUB_TABS = ['search', 'saved', 'myjobs'];
const SORTS = ['match', 'recent'];
// Feed job ids are the synthetic 'gj_<base36>' hash. Keep it to safe URL-ish characters so a junk
// payload can never be pasted into a request path.
const JOB_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

// ── Pure helpers ──────────────────────────────────────────────────────────────────────────────
/** Accepts an object, or a JSON string of one (some senders stringify `params`). Never throws. */
function asObject(v: any): Record<string, any> {
  if (!v) return {};
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; }
    catch { return {}; }
  }
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, any>;
  return {};
}

/** Scalar → trimmed string. Objects/arrays/null become ''. */
function str(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** '/(discover)' | '(discover)' | 'discover' | '/discover/' → 'discover' */
function normRoute(v: any): string {
  if (typeof v !== 'string') return '';
  let s = v.trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  s = s.replace(/^\((.+)\)$/, '$1');
  return s;
}

// ── The decision ──────────────────────────────────────────────────────────────────────────────
/**
 * PURE: notification `data` → what the app should do. Never throws, never navigates.
 * Unknown/missing/malformed input always resolves to { kind: 'none' }.
 */
export function resolveRoute(data: any): PushRouteAction {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'none', reason: 'no-data' };

  const key = normRoute((data as any).route);
  if (!key) return { kind: 'none', reason: 'no-route' };
  const p = asObject((data as any).params);

  switch (key) {
    // Support replies land the user IN the conversation. Without a valid thread id we still open
    // Help & support rather than doing nothing — the user tapped for a reason.
    //
    // `focus:'1'` (the "are you facing any issue?" nudge) opens the same screen with the
    // "what went wrong" picker scrolled to and highlighted. It is deliberately NOT a thread: we do
    // not know what broke, and opening a pre-written ticket would put words in the user's mouth.
    case 'support':
    case 'support-reply':
    case 'support_reply': {
      const id = str(p.threadId) || str(p.thread_id);
      if (id && THREAD_ID_RE.test(id)) return { kind: 'navigate', pathname: SUPPORT_THREAD, params: { id } };
      const params: Record<string, string> = {};
      if (str(p.focus) === '1' || str(p.focus).toLowerCase() === 'true') params.focus = '1';
      const issue = str(p.issue).toLowerCase();
      if (issue && /^[a-z0-9_-]{1,60}$/.test(issue)) params.issue = issue;
      return { kind: 'navigate', pathname: SUPPORT, params };
    }

    // Plans & Usage — where granted bonus quota and trial state are visible. 'plans' goes to the
    // plan list, everything else to the usage screen (a nudge about quota should show the quota).
    case 'usage':
    case 'subscription':
      return { kind: 'navigate', pathname: USAGE, params: {} };
    case 'plans':
      return { kind: 'navigate', pathname: PLANS, params: {} };

    case 'rewards':
    case 'earn':
      return { kind: 'navigate', pathname: REWARDS, params: {} };

    // Staff tapping "a user needs help" go straight to that thread in the inbox.
    case 'admin-support':
    case 'admin_support': {
      const id = str(p.threadId) || str(p.thread_id);
      const params: Record<string, string> = {};
      if (id && THREAD_ID_RE.test(id)) params.threadId = id;
      return { kind: 'navigate', pathname: ADMIN_SUPPORT, params };
    }

    case 'discover':
    case 'explore': {
      const params: Record<string, string> = {};
      const jobId = str(p.jobId) || str(p.job_id);
      if (jobId && JOB_ID_RE.test(jobId)) params.jobId = jobId;
      const sort = str(p.sort).toLowerCase();
      if (SORTS.indexOf(sort) >= 0) params.sort = sort;
      return { kind: 'navigate', pathname: DISCOVER, params };
    }

    case 'ai-hub':
    case 'aihub':
    case 'job-hub':
    case 'jobhub': {
      const params: Record<string, string> = {};
      const tab = str(p.tab).toLowerCase();
      if (AI_HUB_TABS.indexOf(tab) >= 0) params.tab = tab;
      return { kind: 'navigate', pathname: AI_HUB, params };
    }

    case 'profile':
    case 'account': {
      // App.js opens the section named by the handoff key and scrolls/focuses it. 'account' means
      // "just show Account Settings" (no edit mode) — see App.js's consumer.
      const asked = str(p.section).toLowerCase();
      const target = PROFILE_TARGETS.indexOf(asked) >= 0 ? asked : (key === 'account' ? 'account' : 'profile');
      return { kind: 'handoff', handoff: 'profile', target, storage: { key: FOCUS_TARGET_KEY, value: target } };
    }

    // The explainer film. Split out of 'help' now that there is something to play — 'help'/'guide'
    // still open the step-by-step in-app guide, which is a different thing and still the right
    // answer for "show me how to do X".
    //
    // ⚠️ Deliberately keeping 'tutorial' as the wire value rather than inventing a new one. Builds
    // shipped before this screen existed resolve 'tutorial' to the help hand-off, so a push sent
    // while the fleet is mixed opens the guide on old builds and the video on new ones. Both are
    // sensible; neither is a dead tap. Renaming it would strand every un-updated device on
    // 'unknown-route' -> do nothing.
    case 'tutorial':
    case 'video':
      return { kind: 'navigate', pathname: TUTORIAL, params: {} };

    case 'help':
    case 'guide':
      return { kind: 'handoff', handoff: 'help', target: 'help', storage: { key: HELP_OPEN_KEY, value: '1' } };

    default:
      return { kind: 'none', reason: 'unknown-route' };
  }
}

// ── Performing it ─────────────────────────────────────────────────────────────────────────────
/**
 * Resolve `data` and act on it. Returns the action taken (handy for logs/tests). Never throws —
 * a bad payload must not turn a notification tap into a crash.
 */
export async function handleNotificationRoute(data: any, router: PushRouter | null | undefined): Promise<PushRouteAction> {
  const action = resolveRoute(data);
  try {
    if (action.kind === 'none') return action;

    // Write the handoff key BEFORE navigating — App.js reads it as it enters the screen.
    if (action.storage) {
      try { await AsyncStorage?.setItem?.(action.storage.key, action.storage.value); } catch { /* ignore */ }
    }

    if (action.kind === 'handoff') {
      // Leave the REQUEST for HomeScreen. Writing the focus key alone is not enough: App.js only
      // reads it once it is already ON the profile screen, and nothing here can put it there.
      try {
        const pending: PendingNav = { handoff: action.handoff || 'profile', target: action.target || 'profile', at: Date.now() };
        await AsyncStorage?.setItem?.(PENDING_NAV_KEY, JSON.stringify(pending));
      } catch { /* ignore */ }
      // App.js IS the root route ('/'). Pop whatever expo-router pushed on top of it so the screen
      // that consumes the key is visible. Never push('/') — that would mount a SECOND copy of the
      // 15k-line App.js on top of the first.
      try { if (router?.canDismiss?.()) router?.dismissAll?.(); } catch { /* already at root */ }
      return action;
    }

    router?.push?.({ pathname: action.pathname, params: action.params || {} });
  } catch { /* never crash on a notification tap */ }
  return action;
}

// ── Tap plumbing (warm listener + cold start), with once-only guards ───────────────────────────
let lastHandledId: string | null = null;

/** A stable id for one tap. expo-notifications always supplies request.identifier; the date+payload
 *  fallback keeps two different taps distinguishable if it ever doesn't. */
function responseId(response: any): string {
  const req = response?.notification?.request;
  const id = req?.identifier;
  if (typeof id === 'string' && id) return id.slice(0, 200);
  let payload = '';
  try { payload = JSON.stringify(req?.content?.data ?? null); } catch { payload = ''; }
  return (String(response?.notification?.date || '') + ':' + payload).slice(0, 200);
}

/**
 * Handle one notification-tap response (warm listener OR cold start). De-duplicates so the same tap
 * is never acted on twice: in-memory for this session, and persisted so the stale "last response"
 * the OS keeps around is not re-handled on the next launch.
 */
export async function handleNotificationResponse(
  response: any,
  router: PushRouter | null | undefined,
  opts?: { coldStart?: boolean },
): Promise<PushRouteAction> {
  const id = responseId(response);
  if (id) {
    if (lastHandledId === id) return { kind: 'none', reason: 'already-handled' };
    lastHandledId = id;                                  // claim it SYNCHRONOUSLY — closes the race
                                                         // between the listener and the cold-start read
    let seen: string | null = null;
    try { seen = await AsyncStorage?.getItem?.(HANDLED_KEY); } catch { seen = null; }
    if (seen === id) return { kind: 'none', reason: 'already-handled' };
    try { await AsyncStorage?.setItem?.(HANDLED_KEY, id); } catch { /* ignore */ }
  }
  const data = response?.notification?.request?.content?.data;
  // Report the tap AFTER the dedupe above, so one tap is counted once — and BEFORE routing, which
  // may navigate away. Fire-and-forget on purpose: analytics must never delay or block where a
  // notification lands, and must never be able to throw on the launch path.
  reportPushOpen(data, !!opts?.coldStart);
  return handleNotificationRoute(data, router);
}

/**
 * Tell the server this notification was opened.
 *
 * `nid` is stamped into every push payload by the server. No nid (an older push, or a local
 * notification) simply means nothing to report — never an error.
 *
 * Deliberately unauthenticated and deliberately not awaited: a tap very often lands on a cold start
 * before the session has been restored, so waiting for a token would drop exactly the opens most
 * worth counting.
 */
function reportPushOpen(data: any, coldStart: boolean): void {
  try {
    const nid = data && typeof data.nid === 'string' ? data.nid : null;
    if (!nid) return;
    const { API_BASE } = require('../config');
    const { Platform } = require('react-native');
    let appVersion = '';
    try { appVersion = require('./analytics').APP_BUILD || ''; } catch { /* optional */ }
    fetch(`${API_BASE}/push/opened`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nid, kind: 'open', coldStart, platform: Platform.OS, appVersion }),
    }).catch(() => { /* offline — the tap still routes, we just never learn about it */ });
  } catch { /* never let analytics break a notification tap */ }
}

/**
 * COLD START: when the tap LAUNCHED the app, the response listener never fires (the OS delivered it
 * before any JS was running). Read the launch response once on mount instead, then clear it so it
 * can't be replayed on a later launch.
 */
export async function handleColdStartNotification(router: PushRouter | null | undefined): Promise<PushRouteAction> {
  try {
    if (!Notifications?.getLastNotificationResponseAsync) return { kind: 'none', reason: 'no-native-module' };
    const response = await Notifications.getLastNotificationResponseAsync();
    if (!response) return { kind: 'none', reason: 'no-last-response' };
    const action = await handleNotificationResponse(response, router, { coldStart: true });
    try { await Notifications.clearLastNotificationResponseAsync?.(); } catch { /* older SDK — the
      persisted HANDLED_KEY above is the backstop */ }
    return action;
  } catch {
    return { kind: 'none', reason: 'error' };
  }
}

/**
 * Consume a pending hand-off, if there is a FRESH one. Called by HomeScreen on focus — it is the only
 * component that both stays mounted and holds `setScreen`, so it is the only place that can finish a
 * profile deep link.
 *
 * Always clears what it reads, including when the request has expired: a request that is too old to
 * act on is exactly the one that must not linger and surprise the user later. Clearing the stale
 * FOCUS_TARGET_KEY alongside it is the point — that orphan is what would otherwise drop someone into
 * edit mode on their next unrelated visit to Account Settings.
 */
export async function takePendingNav(now: number = Date.now()): Promise<PendingNav | null> {
  if (!AsyncStorage) return null;
  let raw: string | null = null;
  try { raw = await AsyncStorage.getItem?.(PENDING_NAV_KEY); } catch { return null; }
  if (!raw) return null;
  try { await AsyncStorage.removeItem?.(PENDING_NAV_KEY); } catch { /* ignore */ }

  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const fresh = parsed && typeof parsed.at === 'number' && (now - parsed.at) >= 0 && (now - parsed.at) <= PENDING_NAV_TTL_MS;
  if (!fresh) {
    // Expired or malformed — drop the companion key too so nothing acts on it later.
    try { await AsyncStorage.removeItem?.(FOCUS_TARGET_KEY); } catch { /* ignore */ }
    try { await AsyncStorage.removeItem?.(HELP_OPEN_KEY); } catch { /* ignore */ }
    return null;
  }
  const handoff = parsed.handoff === 'help' ? 'help' : 'profile';
  return { handoff, target: str(parsed.target) || handoff, at: parsed.at };
}

/** Test seam: forget the in-memory "already handled" claim. Not used by the app. */
export function __resetHandledForTests(): void { lastHandledId = null; }

/** Test seams: the native modules are absent under plain node, so the storage/notification paths
 *  would be untestable — and those paths are exactly where the deep link previously died silently.
 *  Not used by the app. */
export function __setStorageForTests(mock: any): void { AsyncStorage = mock; }
export function __setNotificationsForTests(mock: any): void { Notifications = mock; }
