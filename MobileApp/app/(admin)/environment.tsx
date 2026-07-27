// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Admin-only "Environment" screen — point THIS ONE DEVICE at a different backend.
// Light (admin) theme, matching app/(admin)/segments.tsx + store-analytics.tsx.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS SCREEN IS SHAPED THE WAY IT IS
//
// Nothing here touches a server. The choice is a single record in this phone's own storage
// (see ADMIN_ENV_KEY in app/_layout.tsx). No other user, no other device and no server setting is
// affected in any way — a real user's app cannot end up anywhere but this build's default, because
// the code that would move it never finds a record on their device.
//
// The one genuine hazard is a HALF-APPLIED switch: if some requests go to production and some to
// local while the app carries a single session token, the admin can write into the wrong database.
// So the switch is deliberately NOT applied live. It is stored, the session is destroyed, every
// cache that came from the old backend is deleted, and the admin is told to fully quit the app.
// The new address is picked up on the next cold start, before the first frame renders, and only
// then. Anything else would be worse than having no switch at all.
//
// The other hazard is losing the way back in: admin status is fetched live from whichever database
// is selected, so switching to one that does not flag you as an admin would normally hide the Admin
// menu and strand you. That is why this screen also accepts the persisted admin verdict — it
// displays no admin data and grants no server authority, it only changes which address this device
// dials, so it can safely stay reachable when the selected backend disagrees or is unreachable.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  SafeAreaView, Platform, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import LiveTargetWarning from '../../components/LiveTargetWarning';
import TypeToConfirm, { confirmSatisfied } from '../../components/TypeToConfirm';
import {
  API_BASE, ENVIRONMENTS, currentEnvironmentKey, defaultEnvironmentKey, urlForEnvironment,
} from '../../config';
import {
  readAdminEnvRecord, writeAdminEnvRecord, readSessionUser, sameAdmin, deleteAllSessions,
  ADMIN_ENV_KEY, SESSION_KEYS, type AdminEnvRecord, type SessionUser,
} from '../_layout';

// ─── tokens (shared with segments.tsx / store-analytics.tsx) ───
const C = {
  bg: '#E5EAF3', bgSoft: '#DCE2ED', surface: '#FFFFFF', ink: '#0B0F22', inkSoft: '#1A2046',
  textMuted: '#5B6B8A', textFaint: '#8896B0', border: 'rgba(11,15,34,0.06)', borderHi: 'rgba(11,15,34,0.10)',
  blue: '#4F8DFF', blueDeep: '#2563EB', purple: '#7C6BFF', teal: '#14B8A6', emerald: '#10B981',
  amber: '#F59E0B', rose: '#EF4444', crimson: '#E11D48',
};

const CONFIRM_SWITCH = 'SWITCH';
const CONFIRM_RESET = 'RESET';
const ADMIN_CHECK_TIMEOUT_MS = 8000;

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL STATE THAT MUST DIE WHEN THE BACKEND CHANGES
//
// Every one of these was produced by, or contains ids issued by, the backend we are leaving.
// Two of them are not merely stale but actively dangerous:
//
//   • aiHub_dashboard_etag_v1 — replays an ETag issued by one server as If-None-Match to another.
//     A matching/weak ETag on the new server answers 304 and the app renders the OTHER database's
//     dashboard as if it were fresh: a silent cross-environment leak with no failed request to see.
//   • resumeBuilderFormData  — mirrors the server-side resume record, and the next save POSTs it,
//     writing the old environment's resume INTO the new database.
//
// Deliberately KEPT: 'cvapplyr_rating_state_v1' (device-scoped review frequency cap — clearing it
// would just re-nag), apple_fullName_* (Apple gives the name once ever, keyed on the Apple user id,
// not on our DB), SecureStore 'analyticsAnonId' (clearing it would break production continuity —
// but be aware the same anon id will now appear in both databases' event streams), and of course
// ADMIN_ENV_KEY itself, which is the record we are writing.
// ─────────────────────────────────────────────────────────────────────────────
export const EXACT_KEYS_TO_CLEAR: string[] = [
  'aiHub_dashboard_etag_v1',       // ETag replayed cross-server → phantom 304
  'aiHub_dashboard_cache_v1',      // Job-Hub SWR cache: employers/jobs/contacts with server ids
  'aiHub_inflight_searches',       // server-side jobIds; polls 404 forever after a switch
  'aiHub_motivation_lines',
  'aiHub_add_recipient_with_cl',   // cross-screen hand-off with job + cover-letter data
  'aiHub_navigate_home',
  'aiHub_trigger_add_recipient',
  'coverLetterPickerContext',      // generated HTML + employer details in flight between screens
  'discover_recent_v1',
  'resumeBuilderData',
  'resumeBuilderFormData',         // gets POSTed to the NEW backend on the next save
  'resumeBuilderMethod',
  'resumeBuilderAction',
  'resumeBuilderSeedSample',
  'onboarding_focus_target',
  'help_open_tutorial',
  'push_pending_nav',              // deferred deep link to an id from the other database
  'push_last_handled_response',
  'fb_activated_v1',
  'userToken',                     // a third, currently-dead token namespace (app/screens/*)
];

export const PREFIXES_TO_CLEAR: string[] = [
  'live_fetch_v1:',            // per-query, unbounded — must be swept by prefix, not by name
  'reviewCoverLetters_',       // generated cover-letter bodies; survives even logout
  'applicationHistory_',       // application rows with server ids
  'appCounters_',              // totalGenerated / totalSent, read back from the backend
  'recipients_',
  'onboarding_dismissed_',     // gates a checklist derived from ${API_BASE}/users/profile
  'explainer_seen_v1_',
];

// ─── helpers ───
type Gate =
  | { state: 'checking' }
  | { state: 'denied'; reason: string }
  | { state: 'ok'; via: 'server' | 'persisted-signed-out' | 'persisted-not-admin' | 'persisted-offline' };

const envLabel = (key: string | null): string => {
  if (!key) return '—';
  const hit = ENVIRONMENTS.find((e) => e.key === key);
  return hit ? hit.label : key;
};

const envIcon = (key: string): keyof typeof Ionicons.glyphMap =>
  key === 'production' ? 'globe-outline' : key === 'local' ? 'hardware-chip-outline' : 'server-outline';

function fmtWhen(iso?: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'never';
  return d.toLocaleString('en-US', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Ask the CURRENT backend whether this token is an admin. Never throws — resolves to a verdict. */
async function checkIsAdmin(token: string): Promise<{ ok: boolean; isAdmin: boolean; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADMIN_CHECK_TIMEOUT_MS);
  try {
    // NOT routed through services/aiHubService — that module snapshots the base URL at import time,
    // so it would ask the wrong backend. `${API_BASE}` inside this function reads the live binding.
    const res = await fetch(`${API_BASE}/user/is-admin`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, isAdmin: false, status: res.status };
    const data = (await res.json()) as { isAdmin?: unknown };
    return { ok: true, isAdmin: data?.isAdmin === true, status: res.status };
  } catch {
    return { ok: false, isAdmin: false, status: 0 };   // network / timeout / bad JSON
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delete the session and every cache that belongs to the backend we are leaving.
 * Returns how many local keys were removed, purely so the screen can show the admin a number.
 *
 * Note this is only half of the sign-out: App.js re-saves 'userSession' whenever its in-memory user
 * object changes, so the session can come back while the app keeps running. The record's
 * `pendingSignOut` flag makes app/_layout.tsx repeat the deletion at the next cold start, which is
 * the moment it actually has to be gone.
 */
export async function wipeStateForSwitch(): Promise<number> {
  let removed = SESSION_KEYS.length;
  await deleteAllSessions();

  let all: string[] = [];
  try { all = [...(await AsyncStorage.getAllKeys())]; } catch { all = []; }

  const doomed = new Set<string>();
  for (const k of all) {
    if (EXACT_KEYS_TO_CLEAR.includes(k)) doomed.add(k);
    else if (PREFIXES_TO_CLEAR.some((p) => k.startsWith(p))) doomed.add(k);
  }
  doomed.delete(ADMIN_ENV_KEY);   // never delete the record we just wrote

  if (doomed.size > 0) {
    try { await AsyncStorage.multiRemove([...doomed]); removed += doomed.size; } catch { /* keep going */ }
  }
  return removed;
}

// ─── small presentational pieces ───
function SectionCard({ children, style }: { children: React.ReactNode; style?: object }) {
  return <View style={[s.card, style]}>{children}</View>;
}

function Bullet({ icon, title, children, tone = C.textMuted }: {
  icon: keyof typeof Ionicons.glyphMap; title: string; children: React.ReactNode; tone?: string;
}) {
  return (
    <View style={s.bullet}>
      <View style={[s.bulletIcon, { backgroundColor: tone + '18' }]}>
        <Ionicons name={icon} size={14} color={tone} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.bulletTitle}>{title}</Text>
        <Text style={s.bulletBody}>{children}</Text>
      </View>
    </View>
  );
}

function WarnBox({ children, icon = 'information-circle', tone = C.amber }: {
  children: React.ReactNode; icon?: keyof typeof Ionicons.glyphMap; tone?: string;
}) {
  return (
    <View style={[s.warnBox, { backgroundColor: tone + '14', borderColor: tone + '55' }]}>
      <Ionicons name={icon} size={16} color={tone} style={{ marginTop: 1 }} />
      <Text style={s.warnText}>{children}</Text>
    </View>
  );
}

// ─── screen ───
export default function AdminEnvironmentScreen() {
  const router = useRouter();

  const [gate, setGate] = useState<Gate>({ state: 'checking' });
  const [session, setSession] = useState<SessionUser | null>(null);
  const [record, setRecord] = useState<AdminEnvRecord | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [intent, setIntent] = useState<'switch' | 'reset' | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<{ key: string | null; cleared: number } | null>(null);

  // What is true RIGHT NOW, in this running process. currentEnvironmentKey() reads the live
  // API_BASE, so it stays on the OLD value after a switch is stored — which is exactly the point.
  const liveKey = currentEnvironmentKey();
  const buildDefaultKey = defaultEnvironmentKey();
  const liveUrl = API_BASE;

  // What the next cold start will use.
  const pendingKey = applied ? applied.key : (record?.key ?? null);
  const nextLaunchKey = pendingKey && urlForEnvironment(pendingKey) ? pendingKey : buildDefaultKey;
  const willChangeOnRestart = nextLaunchKey !== liveKey;
  const overrideStored = !!(record?.key && urlForEnvironment(record.key));

  // ── ADMIN GATE ──────────────────────────────────────────────────────────────
  // A hidden menu item is not a permission check: every route under app/ is reachable by deep link,
  // and app/(admin)/_layout.tsx does no gating of its own. So the screen checks for itself.
  //
  // Note what this gate does and does not protect. It protects nothing on any server — every admin
  // API is guarded server-side by authenticateAdmin, and this screen calls none of them. What it
  // protects is a curious or malicious person on a NON-admin device pointing that device at a
  // backend it was never meant to talk to. Such a device has no record and no admin token, so it
  // lands on "denied" and the switch is unreachable.
  const runGate = useCallback(async () => {
    setGate({ state: 'checking' });
    const [sess, rec] = await Promise.all([readSessionUser(), readAdminEnvRecord()]);
    setSession(sess);
    setRecord(rec);
    setSelected(rec?.key && urlForEnvironment(rec.key) ? rec.key : currentEnvironmentKey());

    const verdictOnFile = rec?.verifiedAt ? rec : null;
    const verdictIsMine = !sess || sameAdmin(sess, verdictOnFile);

    if (sess?.token) {
      const res = await checkIsAdmin(sess.token);
      if (res.ok && res.isAdmin) {
        // Refresh the persisted verdict — this is the ONLY place it is ever written, and only
        // after the server said yes.
        try {
          const next = await writeAdminEnvRecord({
            adminUserId: sess.id, adminEmail: sess.email, verifiedAt: new Date().toISOString(),
          });
          setRecord(next);
        } catch { /* the gate still opens; we just could not persist the verdict */ }
        setGate({ state: 'ok', via: 'server' });
        return;
      }
      if (verdictOnFile && verdictIsMine) {
        setGate({ state: 'ok', via: res.ok ? 'persisted-not-admin' : 'persisted-offline' });
        return;
      }
      setGate({
        state: 'denied',
        reason: res.ok
          ? 'This backend does not list your account as an administrator, and this device has never been verified as one.'
          : `Could not reach ${liveUrl} to check your account${res.status ? ` (HTTP ${res.status})` : ''}, and this device has never been verified as an administrator.`,
      });
      return;
    }

    // Signed out. This is the EXPECTED state immediately after a switch, so a device that was
    // already verified keeps its way back in — otherwise a switch to an unreachable backend would
    // strand the app with no route to undo it short of reinstalling.
    if (verdictOnFile) { setGate({ state: 'ok', via: 'persisted-signed-out' }); return; }
    setGate({ state: 'denied', reason: 'You are signed out, and this device has never been verified as an administrator.' });
  }, [liveUrl]);

  useEffect(() => { runGate(); }, [runGate]);

  // ── APPLY ───────────────────────────────────────────────────────────────────
  const confirmWord = intent === 'reset' ? CONFIRM_RESET : CONFIRM_SWITCH;
  const targetKey = intent === 'reset' ? null : selected;
  // A 'switch' must name a real environment. Without this a null `selected` would quietly write
  // key:null — i.e. perform a RESET while the button says Switch.
  const targetValid = intent === 'reset' || !!(targetKey && urlForEnvironment(targetKey));
  const canApply = !busy && !!intent && targetValid && confirmSatisfied(typed, confirmWord);

  const cancelConfirm = useCallback(() => {
    setIntent(null);
    setTyped('');
    setSelected(record?.key && urlForEnvironment(record.key) ? record.key : liveKey);
  }, [record, liveKey]);

  const apply = useCallback(async () => {
    if (!canApply) return;
    setBusy(true);
    try {
      // ORDER MATTERS.
      // 1. Persist first. If the app were killed between steps, the next launch comes up on the new
      //    backend holding a stale token — which App.js's restoreSession resolves by itself: a 401
      //    deletes the session. Signing out first and then failing to persist would log the admin
      //    out for nothing.
      let next: AdminEnvRecord;
      try {
        next = await writeAdminEnvRecord({ key: targetKey, pendingSignOut: true });
      } catch {
        Alert.alert('Could not save', 'The choice could not be written to this device. Nothing was changed — you are still signed in.');
        setBusy(false);
        return;
      }
      // 2 + 3. Destroy the session and every cache belonging to the backend we are leaving.
      const cleared = await wipeStateForSwitch();

      setRecord(next);
      setApplied({ key: next.key, cleared });
      setIntent(null);
      setTyped('');
    } finally {
      setBusy(false);
    }
  }, [canApply, targetKey]);

  const envRows = useMemo(() => ENVIRONMENTS.map((e) => ({ ...e })), []);

  // ── denied ──────────────────────────────────────────────────────────────────
  if (gate.state === 'denied') {
    return (
      <SafeAreaView style={s.safe}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="chevron-back" size={22} color={C.ink} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}><Text style={s.hTitle}>Environment</Text></View>
        </View>
        <View style={s.deniedWrap}>
          <Ionicons name="lock-closed" size={44} color={C.rose} />
          <Text style={s.deniedTitle}>Access denied</Text>
          <WarnBox icon="alert-circle" tone={C.rose}>{gate.reason}</WarnBox>
          <Text style={s.deniedSub}>
            Nothing on this device was changed and this app is still using the address it started
            with. Sign in with an administrator account and reopen this screen.
          </Text>
          <TouchableOpacity style={s.retryBtn} onPress={runGate}>
            <Ionicons name="refresh" size={15} color="#fff" />
            <Text style={s.retryBtnT}>Check again</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── checking ────────────────────────────────────────────────────────────────
  if (gate.state === 'checking') {
    return (
      <SafeAreaView style={s.safe}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="chevron-back" size={22} color={C.ink} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}><Text style={s.hTitle}>Environment</Text></View>
        </View>
        <View style={s.center}>
          <ActivityIndicator color={C.blue} size="large" />
          <Text style={s.checkingT}>Checking your account…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── allowed ─────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.safe}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={22} color={C.ink} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.hTitle}>Environment</Text>
          <Text style={s.hSub}>Which backend this one device talks to</Text>
        </View>
        <View style={s.hIcon}><Ionicons name="git-branch" size={18} color={C.purple} /></View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 60 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <LiveTargetWarning what="Everything you do here reaches real users' data" />

        {gate.via !== 'server' && (
          <WarnBox icon="key" tone={C.amber}>
            {gate.via === 'persisted-signed-out'
              ? `You are signed out. This screen opened because this device was verified as ${record?.adminEmail || 'an administrator'} on ${fmtWhen(record?.verifiedAt)}. It shows no admin data — the only thing it can do is change which address this device dials.`
              : gate.via === 'persisted-not-admin'
                ? `${envLabel(liveKey)} does not list your account as an administrator. This screen opened on this device's stored verification (${record?.adminEmail || 'unknown'}, ${fmtWhen(record?.verifiedAt)}) so you can switch back. No admin data is shown and no admin API is called.`
                : `Could not reach ${liveUrl} to re-check your account, so this screen opened on this device's stored verification (${record?.adminEmail || 'unknown'}, ${fmtWhen(record?.verifiedAt)}). No admin data is shown.`}
          </WarnBox>
        )}

        {/* ── AFTER A SWITCH: the restart instruction, above everything else ── */}
        {applied && (
          <View style={s.restartCard}>
            <View style={s.restartHead}>
              <View style={s.restartIcon}><Ionicons name="power" size={20} color="#fff" /></View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.restartTitle}>Fully quit and reopen the app</Text>
                <Text style={s.restartSub}>
                  Saved. Your stored session and {applied.cleared} local{' '}
                  {applied.cleared === 1 ? 'item were' : 'items were'} deleted.
                </Text>
              </View>
            </View>
            <Text style={s.restartBody}>
              This app is still running against {envLabel(liveKey)} — {liveUrl} — and the screens
              behind this one still hold its data. The new address is only read once, at launch,
              before the first screen appears. Backgrounding the app is not enough: swipe it away
              from the app switcher (or force-stop it), then open it again. Do that now rather than
              carrying on — the running app can re-save the old session by itself, and the sign-out
              is only guaranteed once it has restarted. Then sign in with your EMAIL and password.
            </Text>
            <View style={s.restartWhyBox}>
              <Text style={s.restartWhyT}>Why it cannot switch while running</Text>
              <Text style={s.restartWhyB}>
                A session token minted by one database means nothing in another, and parts of the app
                keep their own copy of the address from the moment it started. Changing it mid-flight
                would send some requests to {envLabel(liveKey)} and some to {envLabel(nextLaunchKey)}
                {' '}with one token — which is how you write real data into the wrong database.
              </Text>
            </View>
          </View>
        )}

        {/* ── WHERE WE ARE ── */}
        <SectionCard>
          <Text style={s.cardTitle}>Right now</Text>
          <Text style={s.cardSub}>What this running app is actually talking to.</Text>

          <View style={s.nowRow}>
            <View style={[s.nowIcon, { backgroundColor: (liveKey === 'production' ? C.rose : C.emerald) + '18' }]}>
              <Ionicons name={envIcon(liveKey)} size={19} color={liveKey === 'production' ? C.rose : C.emerald} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={s.nowTitleRow}>
                <Text style={s.nowTitle}>{envLabel(liveKey)}</Text>
                {liveKey === buildDefaultKey ? (
                  <View style={[s.chip, { backgroundColor: C.bgSoft }]}>
                    <Text style={[s.chipT, { color: C.textMuted }]}>BUILD DEFAULT</Text>
                  </View>
                ) : (
                  <View style={[s.chip, { backgroundColor: 'rgba(124,107,255,0.14)' }]}>
                    <Text style={[s.chipT, { color: C.purple }]}>OVERRIDE ACTIVE</Text>
                  </View>
                )}
              </View>
              <Text style={s.url} selectable>{liveUrl}</Text>
            </View>
          </View>

          <View style={s.kvBlock}>
            <View style={s.kv}>
              <Text style={s.kvK}>This build&apos;s default</Text>
              <Text style={s.kvV}>{envLabel(buildDefaultKey)}</Text>
            </View>
            <View style={s.kvDiv} />
            <View style={s.kv}>
              <Text style={s.kvK}>After you quit and reopen</Text>
              <Text style={[s.kvV, willChangeOnRestart && { color: C.purple }]}>
                {envLabel(nextLaunchKey)}{willChangeOnRestart ? ' (pending)' : ''}
              </Text>
            </View>
            <View style={s.kvDiv} />
            <View style={s.kv}>
              <Text style={s.kvK}>Signed in as</Text>
              <Text style={s.kvV} numberOfLines={1}>{session?.email || 'signed out'}</Text>
            </View>
          </View>

          <Text style={s.footnote}>
            This choice lives on this phone only. It is not a server setting, it is not shared, and
            no other user is affected by it in any way.
          </Text>
        </SectionCard>

        {/* ── PICK ── */}
        <SectionCard>
          <Text style={s.cardTitle}>Choose a backend</Text>
          <Text style={s.cardSub}>
            Only the environments compiled into this build are listed. There is no free-text address
            box on purpose — this app can never be pointed at an arbitrary host.
          </Text>

          <View style={{ gap: 9, marginTop: 12 }}>
            {envRows.map((e) => {
              const isLive = e.key === liveKey;
              const isSel = e.key === selected;
              const isNext = e.key === nextLaunchKey;
              return (
                <TouchableOpacity
                  key={e.key}
                  activeOpacity={0.85}
                  disabled={busy}
                  onPress={() => { setSelected(e.key); setIntent(e.key === liveKey ? null : 'switch'); setTyped(''); }}
                  style={[s.envCard, isSel && s.envCardOn, e.danger && isSel && { borderColor: C.rose }]}
                >
                  <View style={[s.envIcon, { backgroundColor: (e.danger ? C.rose : C.emerald) + '16' }]}>
                    <Ionicons name={envIcon(e.key)} size={18} color={e.danger ? C.rose : C.emerald} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={s.envTitleRow}>
                      <Text style={s.envLabel}>{e.label}</Text>
                      {e.danger && (
                        <View style={[s.chip, { backgroundColor: 'rgba(239,68,68,0.12)' }]}>
                          <Text style={[s.chipT, { color: C.rose }]}>REAL USERS</Text>
                        </View>
                      )}
                    </View>
                    <Text style={s.envUrl} numberOfLines={1}>{e.url}</Text>
                    <View style={s.envFlags}>
                      {isLive && <Text style={s.envFlag}>in use now</Text>}
                      {isNext && !isLive && <Text style={[s.envFlag, { color: C.purple }]}>after restart</Text>}
                      {e.key === buildDefaultKey && <Text style={s.envFlag}>build default</Text>}
                    </View>
                  </View>
                  <Ionicons
                    name={isSel ? 'radio-button-on' : 'radio-button-off'}
                    size={20}
                    color={isSel ? C.blueDeep : C.borderHi}
                  />
                </TouchableOpacity>
              );
            })}
          </View>

          {/* ── CONFIRM ── */}
          {intent && (
            <View style={s.confirmWrap}>
              <View style={s.confirmHead}>
                <Ionicons name="swap-horizontal" size={16} color={C.ink} />
                <Text style={s.confirmHeadT}>
                  {intent === 'reset'
                    ? `Back to this build's default — ${envLabel(buildDefaultKey)}`
                    : `${envLabel(liveKey)} → ${envLabel(selected)}`}
                </Text>
              </View>

              <View style={s.stepList}>
                <Text style={s.step}>1. The choice is saved on this device.</Text>
                <Text style={s.step}>2. You are signed out and the session token is deleted.</Text>
                <Text style={s.step}>3. Every cached page, draft and counter from {envLabel(liveKey)} is deleted.</Text>
                <Text style={s.step}>4. You fully quit the app and reopen it. Nothing changes until you do.</Text>
              </View>

              <TypeToConfirm
                value={typed}
                onChange={setTyped}
                word={confirmWord}
                disabled={busy}
                // Its default copy is about a message reaching someone's phone — untrue here. State
                // what this action really does, or the warning trains the reader to skim past it.
                headline="This changes which database THIS DEVICE talks to"
                detail={
                  intent === 'reset'
                    ? `You will be signed out of ${envLabel(liveKey)}, and this device goes back to ${envLabel(buildDefaultKey)} at the next launch. Nothing on any server changes and no other user is affected.`
                    : `You will be signed out of ${envLabel(liveKey)} and every page cached from it is deleted. The switch takes effect only after you fully quit and reopen the app. Nothing on any server changes and no other user is affected.`
                }
              />

              <View style={s.confirmBtns}>
                <TouchableOpacity style={s.cancelBtn} onPress={cancelConfirm} disabled={busy}>
                  <Text style={s.cancelBtnT}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.applyBtn, !canApply && s.applyBtnOff]}
                  onPress={apply}
                  disabled={!canApply}
                  activeOpacity={0.85}
                >
                  {busy ? <ActivityIndicator color="#fff" size="small" /> : (
                    <>
                      <Ionicons name="log-out-outline" size={16} color="#fff" />
                      <Text style={s.applyBtnT}>
                        {intent === 'reset' ? 'Reset and sign out' : 'Switch and sign out'}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ── RESET ── */}
          {!intent && (
            <TouchableOpacity
              style={[s.resetBtn, !overrideStored && s.resetBtnOff]}
              disabled={!overrideStored || busy}
              onPress={() => { setIntent('reset'); setTyped(''); }}
            >
              <Ionicons name="refresh" size={15} color={overrideStored ? C.ink : C.textFaint} />
              <Text style={[s.resetBtnT, !overrideStored && { color: C.textFaint }]}>
                {overrideStored
                  ? `Reset to this build's default (${envLabel(buildDefaultKey)})`
                  : `No override stored — already on this build's default`}
              </Text>
            </TouchableOpacity>
          )}
        </SectionCard>

        {/* ── PERMANENT: WHAT DOES NOT FOLLOW ── */}
        <SectionCard style={{ borderColor: C.amber + '55', backgroundColor: '#FFFDF7' }}>
          <View style={s.cardHeadRow}>
            <Ionicons name="alert-circle" size={17} color={C.amber} />
            <Text style={s.cardTitle}>What does NOT follow the switch</Text>
          </View>
          <Text style={s.cardSub}>
            Read this before you trust anything you see on a non-default environment. These are not
            bugs you can work around by trying again — they are parts of the app that read the
            address once, or that are pinned to production at compile time.
          </Text>

          <Bullet icon="logo-google" title="Sign in with Google / Microsoft" tone={C.rose}>
            Pinned at compile time and cannot be changed from here. In a release or TestFlight build
            these ALWAYS go to Production, whatever this screen says; in a development build they
            always go to Local. This does not fail loudly — it succeeds, and hands you a token for
            the wrong database, or creates your user row in it. Use EMAIL and password sign-in on
            any environment that is not this build&apos;s default.
          </Bullet>

          <Bullet icon="grid-outline" title="The admin dashboards and the Job Hub" tone={C.emerald}>
            These DO follow the switch. Store Analytics, Registered Users, User Analytics, Segments,
            AI Event Credits, Employer Fix Agent, Discover and the Job Hub all reach the network
            through services/aiHubService.ts, which used to copy the address into a constant the
            first time it loaded. It now reads the address per request, so these screens show the
            environment named above.
          </Bullet>

          <Bullet icon="phone-portrait-outline" title="This device's push token" tone={C.amber}>
            Once you sign in on the new environment, this phone&apos;s real push token is registered
            there too. The old backend keeps its copy, so for a while you may receive notifications
            from both databases on the same device.
          </Bullet>

          <Bullet icon="analytics-outline" title="Your analytics identity" tone={C.amber}>
            The anonymous device id is kept on purpose, so production&apos;s history stays intact.
            The side effect is that your own poking about on another environment shares an id with
            your production activity.
          </Bullet>

          <Bullet icon="star-outline" title="The Admin menu itself" tone={C.amber}>
            Admin status is fetched live from whichever database you are on. If the one you switch to
            does not flag your account as an administrator, the whole Admin section disappears from
            the menu there. You can still reach this screen — it opens on this device&apos;s stored
            verification — but the way in is the menu, so note the escape route below.
          </Bullet>

          <Bullet icon="exit-outline" title="Escape route, if the menu vanishes" tone={C.blueDeep}>
            Open cvapplyr:///environment on this device (from Notes, Messages or the browser); if
            that does not open the app, try cvapplyr:///(admin)/environment. Failing both,
            reinstalling the app clears the stored choice completely and returns to
            {' '}{envLabel(buildDefaultKey)} — this setting lives nowhere but this phone.
          </Bullet>
        </SectionCard>

        {/* ── PERMANENT: WHAT GETS DELETED ── */}
        <SectionCard>
          <View style={s.cardHeadRow}>
            <Ionicons name="trash-outline" size={16} color={C.textMuted} />
            <Text style={s.cardTitle}>What a switch deletes from this phone</Text>
          </View>
          <Text style={s.cardSub}>
            All of it came from the backend you are leaving, and every piece of it would otherwise be
            shown to you, or sent back, as if it belonged to the new one.
          </Text>
          <View style={s.kvBlock}>
            <View style={s.kv}><Text style={s.kvK}>Your session</Text><Text style={s.kvV}>all three token stores</Text></View>
            <View style={s.kvDiv} />
            <View style={s.kv}><Text style={s.kvK}>Job Hub cache + its ETag</Text><Text style={s.kvV}>deleted</Text></View>
            <View style={s.kvDiv} />
            <View style={s.kv}><Text style={s.kvK}>Searches in flight</Text><Text style={s.kvV}>deleted</Text></View>
            <View style={s.kvDiv} />
            <View style={s.kv}><Text style={s.kvK}>Cover letters, applications, counters</Text><Text style={s.kvV}>deleted</Text></View>
            <View style={s.kvDiv} />
            <View style={s.kv}><Text style={s.kvK}>Résumé builder drafts</Text><Text style={s.kvV}>deleted</Text></View>
            <View style={s.kvDiv} />
            <View style={s.kv}><Text style={s.kvK}>Review prompt state, Apple name</Text><Text style={s.kvV}>kept</Text></View>
          </View>
          <Text style={s.footnote}>
            Deleted locally only. Nothing is deleted from any database — the copies on the server you
            are leaving are untouched, and everything reappears when you switch back and sign in.
          </Text>
        </SectionCard>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'android' ? 28 : 0 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12 },
  backBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  hTitle: { fontSize: 20, fontWeight: '800', color: C.ink, letterSpacing: -0.4 },
  hSub: { fontSize: 12, color: C.textMuted, marginTop: 1 },
  hIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.purple + '15', alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  checkingT: { fontSize: 12.5, color: C.textMuted, fontWeight: '600' },

  card: {
    backgroundColor: C.surface, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 14, marginBottom: 14,
    shadowColor: '#0F172A', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.05, shadowRadius: 14, elevation: 2,
  },
  cardHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 2 },
  cardTitle: { fontSize: 15.5, fontWeight: '800', color: C.ink },
  cardSub: { fontSize: 11.5, color: C.textMuted, marginTop: 3, lineHeight: 16.5 },
  footnote: { fontSize: 10.5, color: C.textFaint, marginTop: 10, lineHeight: 15 },

  // now
  nowRow: { flexDirection: 'row', alignItems: 'center', gap: 11, marginTop: 13 },
  nowIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  nowTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  nowTitle: { fontSize: 16, fontWeight: '800', color: C.ink, letterSpacing: -0.3 },
  url: { fontFamily: 'Menlo', fontSize: 10.5, color: C.textMuted, marginTop: 3 },
  chip: { paddingHorizontal: 7, paddingVertical: 2.5, borderRadius: 100 },
  chipT: { fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },

  kvBlock: { marginTop: 13, backgroundColor: C.bg, borderRadius: 13, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  kv: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 12, paddingVertical: 10 },
  kvDiv: { height: 1, backgroundColor: C.border },
  kvK: { fontSize: 12, color: C.textMuted, fontWeight: '600', flexShrink: 1 },
  kvV: { fontSize: 12.5, color: C.ink, fontWeight: '800', flexShrink: 1, textAlign: 'right' },

  // env cards
  envCard: {
    flexDirection: 'row', alignItems: 'center', gap: 11, padding: 11,
    backgroundColor: C.bg, borderRadius: 14, borderWidth: 1.5, borderColor: C.border,
  },
  envCardOn: { borderColor: C.blueDeep, backgroundColor: 'rgba(37,99,235,0.05)' },
  envIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  envTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  envLabel: { fontSize: 13.5, fontWeight: '800', color: C.ink },
  envUrl: { fontFamily: 'Menlo', fontSize: 9.5, color: C.textMuted, marginTop: 2 },
  envFlags: { flexDirection: 'row', gap: 10, marginTop: 4, flexWrap: 'wrap' },
  envFlag: { fontSize: 9.5, fontWeight: '800', color: C.textFaint, letterSpacing: 0.3, textTransform: 'uppercase' },

  // confirm
  confirmWrap: { marginTop: 14, borderTopWidth: 1, borderTopColor: C.border, paddingTop: 13 },
  confirmHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  confirmHeadT: { fontSize: 13.5, fontWeight: '800', color: C.ink, flex: 1 },
  stepList: { marginTop: 10, gap: 5 },
  step: { fontSize: 12, color: C.inkSoft, lineHeight: 17 },
  confirmBtns: { flexDirection: 'row', gap: 9, marginTop: 13 },
  cancelBtn: { paddingHorizontal: 16, height: 46, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bgSoft },
  cancelBtnT: { fontSize: 13, fontWeight: '800', color: C.inkSoft },
  applyBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    height: 46, borderRadius: 13, backgroundColor: C.crimson,
  },
  applyBtnOff: { backgroundColor: C.borderHi },
  applyBtnT: { fontSize: 13.5, fontWeight: '800', color: '#fff' },

  resetBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    marginTop: 13, paddingVertical: 11, borderRadius: 12, backgroundColor: C.bgSoft,
  },
  resetBtnOff: { backgroundColor: C.bg },
  resetBtnT: { fontSize: 12, fontWeight: '800', color: C.ink },

  // restart panel
  restartCard: {
    backgroundColor: '#0B1120', borderRadius: 20, padding: 15, marginBottom: 14,
  },
  restartHead: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  restartIcon: { width: 40, height: 40, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  restartTitle: { fontSize: 16, fontWeight: '800', color: '#fff', letterSpacing: -0.3 },
  restartSub: { fontSize: 11.5, color: 'rgba(255,255,255,0.62)', marginTop: 2 },
  restartBody: { fontSize: 12.5, color: 'rgba(255,255,255,0.86)', lineHeight: 18.5, marginTop: 13 },
  restartWhyBox: { marginTop: 13, padding: 12, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  restartWhyT: { fontSize: 10.5, fontWeight: '800', color: 'rgba(255,255,255,0.72)', letterSpacing: 0.8, textTransform: 'uppercase' },
  restartWhyB: { fontSize: 12, color: 'rgba(255,255,255,0.78)', lineHeight: 17.5, marginTop: 6 },

  // bullets
  bullet: { flexDirection: 'row', gap: 10, marginTop: 13 },
  bulletIcon: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  bulletTitle: { fontSize: 13, fontWeight: '800', color: C.ink },
  bulletBody: { fontSize: 11.5, color: C.inkSoft, lineHeight: 17, marginTop: 3 },

  warnBox: { flexDirection: 'row', gap: 9, alignItems: 'flex-start', borderWidth: 1, borderRadius: 13, padding: 11, marginBottom: 12 },
  warnText: { flex: 1, fontSize: 11.5, color: C.inkSoft, lineHeight: 16.5, fontWeight: '600' },

  // denied
  deniedWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 26, gap: 6 },
  deniedTitle: { fontSize: 19, fontWeight: '800', color: C.ink, marginTop: 8, marginBottom: 8 },
  deniedSub: { fontSize: 12, color: C.textMuted, textAlign: 'center', lineHeight: 18, marginTop: 2 },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 13, backgroundColor: C.blue },
  retryBtnT: { color: '#fff', fontWeight: '800', fontSize: 13 },
});
