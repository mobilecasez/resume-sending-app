// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Admin-only NATIVE "Segments" screen — the in-app equivalent of public/admin-segments.html.
// Light (admin) theme, matching app/(admin)/user-analytics.tsx + store-analytics.tsx.
//
// Pick a segment → see exactly who is in it → pick a template → PREVIEW (dry run) → confirm → send.
// This screen can push a notification to hundreds of real phones, so the whole point of it is the
// arm/disarm state machine below:
//
//   Send is enabled ⇔ a preview SUCCEEDED for the exact (segment + template + title + body + cap)
//   that is on screen RIGHT NOW. The armed preview stores the signature it was run for, and the
//   button is derived from `armed.sig === sig` — so even a state change nobody remembered to pair
//   with disarm() cannot leave Send armed. disarm() additionally bumps a generation counter, so a
//   preview that was already in flight can never come back and arm a selection that has moved on.
//
// Backend (already deployed, not touched here): GET /api/admin/segments,
// GET /api/admin/segments/:key/users, POST /api/admin/segments/:key/notify (dry run without
// `confirm`, real send with `confirm:true`), GET /api/admin/notify/templates.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  SafeAreaView, RefreshControl, TextInput, Modal, Pressable, Platform, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import LiveTargetWarning from '../../components/LiveTargetWarning';
import {
  fetchAdminSegments, fetchAdminSegmentUsers, fetchAdminNotifyTemplates,
  previewAdminSegmentNotify, sendAdminSegmentNotify,
  type AdminSegment, type AdminSegmentUser, type AdminSegmentUsersResponse,
  type AdminNotifyTemplate, type AdminNotifyOverrides,
  type AdminSegmentNotifyPreview, type AdminSegmentNotifyResult,
} from '../../services/aiHubService';

// ─── tokens (shared with user-analytics.tsx / store-analytics.tsx) ───
// The server delivers at most this much (server/services/notifyTemplates.js clips title/body).
const TITLE_MAX = 90;
const BODY_MAX = 200;

const C = {
  bg: '#E5EAF3', bgSoft: '#DCE2ED', surface: '#FFFFFF', ink: '#0B0F22', inkSoft: '#1A2046',
  textMuted: '#5B6B8A', textFaint: '#8896B0', border: 'rgba(11,15,34,0.06)', borderHi: 'rgba(11,15,34,0.10)',
  blue: '#4F8DFF', blueDeep: '#2563EB', purple: '#7C6BFF', teal: '#14B8A6', emerald: '#10B981',
  amber: '#F59E0B', rose: '#EF4444', crimson: '#E11D48',
};

// Mirrors server/services/adminUserOps.js: DEFAULT_MAX_RECIPIENTS / ABSOLUTE_MAX_RECIPIENTS.
const MAX_DEFAULT = 500;
const MAX_CEILING = 2000;
const USERS_LIMIT = 200;      // how many segment members we ask the API for
const USERS_COLLAPSED = 12;   // how many we render before "show all"
const DEDUPE_HOURS = 72;

// expo-router typed routes: /(admin)/user-360 is being added by another agent and is not in the
// generated .expo/types/router.d.ts yet. One localised cast rather than `any` sprinkled around.
type RouterHref = Parameters<ReturnType<typeof useRouter>['push']>[0];

// ─── helpers ───
const fmt = (x?: number | null) => (x == null || isNaN(Number(x)) ? '0' : Math.round(Number(x)).toLocaleString('en-US'));
const plural = (n: number, one: string, many?: string) => (n === 1 ? one : many || `${one}s`);
const clampMax = (raw: string) => {
  const v = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
  if (!v || isNaN(v) || v < 1) return MAX_DEFAULT;
  return Math.min(v, MAX_CEILING);
};
function fmtDay(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}
function timeAgo(iso?: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
const initials = (name?: string | null, email?: string | null, id?: number) => {
  const src = (name && name.trim()) || email || (id != null ? `U${id}` : '?');
  const parts = String(src).trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return String(src).slice(0, 2).toUpperCase();
};
const SEG_COLORS = [C.teal, C.blue, C.purple, C.emerald, C.amber, C.rose, '#06B6D4', '#F472B6'];
function segColor(key: string): string {
  let h = 0;
  const s = String(key || 'x');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return SEG_COLORS[h % SEG_COLORS.length];
}
const segInitials = (s: AdminSegment) =>
  (String(s.label || s.key).replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || 'SG');

const httpStatus = (e: unknown): number | undefined => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};
const errMsg = (e: unknown, fallback: string) =>
  (e instanceof Error && e.message) ? e.message : fallback;

// ─── override / personalisation model ───
// ⚠️ The copy boxes are pre-filled with the template rendered WITHOUT a user. Posting that back as
// an override tells the server "use this exact text for everyone" and silently throws away the
// per-recipient personalisation. Only a field the admin ACTUALLY CHANGED becomes an override.
type OverrideMode = 'none' | 'title' | 'body' | 'both';
function overrideMode(o: AdminNotifyOverrides): OverrideMode {
  const t = !!o.title, b = !!o.body;
  return t && b ? 'both' : t ? 'title' : b ? 'body' : 'none';
}
function personalisationHeader(m: OverrideMode): string {
  if (m === 'none') return 'Example — each person gets their own version';
  if (m === 'both') return 'Exactly what every recipient will see';
  return 'Mixed — the edited field is fixed, the other is personalised';
}
function personalisationLine(m: OverrideMode): string {
  if (m === 'none') {
    return 'You have not edited the wording, so names, counts and job titles are filled in per person. Editing either field sends that exact text to everyone instead.';
  }
  if (m === 'both') {
    return 'You edited both fields, so this exact title and body go to every recipient — no per-person names, counts or job titles.';
  }
  if (m === 'title') {
    return 'You edited the title, so that exact title goes to everyone. The body is still personalised per person.';
  }
  return 'You edited the body, so that exact body goes to everyone. The title is still personalised per person.';
}
function personalisationShort(m: OverrideMode): string {
  if (m === 'none') return 'Personalised per person';
  if (m === 'both') return 'Fixed copy for everyone';
  return m === 'title' ? 'Fixed title · personalised body' : 'Fixed body · personalised title';
}

// ─── the armed-preview record: the single source of truth for "may we send?" ───
type SendPayload = { templateKey: string; overrides: AdminNotifyOverrides | null; maxRecipients: number };
type ArmedPreview = {
  sig: string;            // the exact selection this preview describes
  segKey: string;
  payload: SendPayload;   // the EXACT body that was previewed — resent verbatim, never re-read from the form
  data: AdminSegmentNotifyPreview;
  sendCount: number;      // how many the server said would receive it
  mode: OverrideMode;
};
type ResultView =
  | { kind: 'preview'; data: AdminSegmentNotifyPreview; mode: OverrideMode }
  | { kind: 'sent'; data: AdminSegmentNotifyResult; templateLabel: string; segLabel: string }
  | { kind: 'error'; message: string }
  | { kind: 'note'; message: string };

// ═══════════════════════════════════════════════════════════════════════════════
// small presentational pieces
// ═══════════════════════════════════════════════════════════════════════════════
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}
function NoteBox({ children, icon = 'information-circle-outline' }: { children: React.ReactNode; icon?: any }) {
  return (
    <View style={styles.noteBox}>
      <Ionicons name={icon} size={14} color={C.amber} style={{ marginTop: 1 }} />
      <Text style={styles.noteText}>{children}</Text>
    </View>
  );
}
function WarnBox({ children, icon = 'warning-outline' }: { children: React.ReactNode; icon?: any }) {
  return (
    <View style={styles.warnBox}>
      <Ionicons name={icon} size={14} color={C.rose} style={{ marginTop: 1 }} />
      <Text style={styles.warnText}>{children}</Text>
    </View>
  );
}
function OkBox({ children, icon = 'checkmark-circle' }: { children: React.ReactNode; icon?: any }) {
  return (
    <View style={styles.okBox}>
      <Ionicons name={icon} size={14} color={C.emerald} style={{ marginTop: 1 }} />
      <Text style={styles.okText}>{children}</Text>
    </View>
  );
}
function StatCard({ n, label, tone }: { n: number | null | undefined; label: string; tone?: 'ok' | 'warn' | 'bad' | 'plain' }) {
  const color = tone === 'ok' ? C.emerald : tone === 'warn' ? C.amber : tone === 'bad' ? C.rose : C.ink;
  return (
    <View style={styles.statCard}>
      <Text style={[styles.statN, { color }]}>{n == null ? '—' : fmt(n)}</Text>
      <Text style={styles.statL}>{label}</Text>
    </View>
  );
}
function StepBar({ hasTemplate, hasPreview }: { hasTemplate: boolean; hasPreview: boolean }) {
  const steps: [string, boolean][] = [['Template', hasTemplate], ['Preview', hasPreview], ['Confirm & send', false]];
  return (
    <View style={styles.stepBar}>
      {steps.map(([label, done], i) => (
        <View key={label} style={styles.stepItem}>
          {i > 0 && <Ionicons name="chevron-forward" size={11} color={C.textFaint} style={{ marginHorizontal: 2 }} />}
          <View style={[styles.stepBullet, done && styles.stepBulletDone]}>
            {done
              ? <Ionicons name="checkmark" size={10} color={C.emerald} />
              : <Text style={styles.stepBulletText}>{i + 1}</Text>}
          </View>
          <Text style={[styles.stepText, done && { color: C.emerald }]}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

// ─── segment card ───
function SegmentCard({ seg, selected, onPress }: { seg: AdminSegment; selected: boolean; onPress: () => void }) {
  const col = segColor(seg.key);
  const countFailed = seg.count == null;
  return (
    <TouchableOpacity style={[styles.segCard, selected && styles.segCardActive]} onPress={onPress} activeOpacity={0.85}>
      <LinearGradient colors={[col, col + 'AA']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.segAvatar}>
        <Text style={styles.segAvatarText}>{segInitials(seg)}</Text>
      </LinearGradient>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.segLabel} numberOfLines={1}>{seg.label || seg.key}</Text>
        {!!seg.description && <Text style={styles.segDesc} numberOfLines={2}>{seg.description}</Text>}
        {seg.available === false && (
          <Text style={styles.segUnavailable}>A table this segment needs is missing on this deployment.</Text>
        )}
        {!!seg.error && <Text style={styles.segUnavailable}>{seg.error}</Text>}
      </View>
      <View style={[styles.countPill, countFailed ? styles.countPillDead : (seg.count! > 0 ? styles.countPillLive : styles.countPillZero)]}>
        <Text style={[styles.countPillText, countFailed ? { color: C.rose } : (seg.count! > 0 ? { color: C.blueDeep } : { color: C.textMuted })]}>
          {countFailed ? '?' : fmt(seg.count)}
        </Text>
      </View>
      {selected && <Ionicons name="checkmark-circle" size={18} color={C.blueDeep} />}
    </TouchableOpacity>
  );
}

// ─── one member of the segment ───
function UserRow({ u, hasTemplate, onPress }: { u: AdminSegmentUser; hasTemplate: boolean; onPress: () => void }) {
  const name = u.full_name || u.email || `User ${u.id}`;
  const comp = u.completeness == null ? null : Number(u.completeness);
  const compTone = comp == null ? C.textMuted : comp >= 80 ? C.emerald : comp >= 40 ? C.amber : C.rose;
  return (
    <TouchableOpacity style={styles.userRow} onPress={onPress} activeOpacity={0.8}>
      <LinearGradient colors={[C.blue, C.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.userAvatar}>
        <Text style={styles.userAvatarText}>{initials(u.full_name, u.email, u.id)}</Text>
      </LinearGradient>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.userNameRow}>
          <Text style={styles.userName} numberOfLines={1}>{name}</Text>
          <View style={[styles.pushDot, { backgroundColor: u.has_push ? C.emerald : '#C3CCDC' }]} />
        </View>
        <Text style={styles.userEmail} numberOfLines={1}>{u.email || '—'}</Text>
        <View style={styles.userMeta}>
          <View style={styles.userMetaItem}>
            <Ionicons name="calendar-outline" size={10} color={C.textMuted} />
            <Text style={styles.userMetaText}>joined {fmtDay(u.created_at)}</Text>
          </View>
          <View style={styles.userMetaItem}>
            <Ionicons name="time-outline" size={10} color={C.textMuted} />
            <Text style={styles.userMetaText}>seen {timeAgo(u.last_seen_at)}</Text>
          </View>
          <View style={styles.userMetaItem}>
            <Ionicons name="person-circle-outline" size={10} color={compTone} />
            <Text style={[styles.userMetaText, { color: compTone, fontWeight: '800' }]}>{comp == null ? '—' : `${comp}%`}</Text>
          </View>
        </View>
        {(!u.has_push || (hasTemplate && (u.opted_out || u.recently_sent))) && (
          <View style={styles.userFlags}>
            {!u.has_push && (
              <View style={styles.flagChip}><Ionicons name="notifications-off-outline" size={9} color={C.textMuted} /><Text style={styles.flagText}>no push token</Text></View>
            )}
            {hasTemplate && u.opted_out && (
              <View style={styles.flagChip}><Ionicons name="ban-outline" size={9} color={C.rose} /><Text style={[styles.flagText, { color: C.rose }]}>opted out</Text></View>
            )}
            {hasTemplate && u.recently_sent && (
              <View style={styles.flagChip}><Ionicons name="time-outline" size={9} color={C.amber} /><Text style={[styles.flagText, { color: C.amber }]}>sent in {DEDUPE_HOURS}h</Text></View>
            )}
          </View>
        )}
      </View>
      <Ionicons name="chevron-forward" size={16} color={C.textFaint} />
    </TouchableOpacity>
  );
}

// ─── template picker (the ONE Modal on this screen — confirmation uses native Alert, never a
//     second Modal; a Modal inside a Modal hard-crashed iOS in build 87) ───
function TemplatePicker({
  visible, templates, hidden, selectedKey, onPick, onClose,
}: {
  visible: boolean;
  templates: AdminNotifyTemplate[];
  hidden: { key: string; label: string; why: string }[];
  selectedKey: string | null;
  onPick: (t: AdminNotifyTemplate) => void;
  onClose: () => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, AdminNotifyTemplate[]>();
    templates.forEach((t) => {
      const c = t.category || 'other';
      if (!map.has(c)) map.set(c, []);
      map.get(c)!.push(t);
    });
    return Array.from(map.entries());
  }, [templates]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetOverlay}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.sheetGrip} />
          <View style={styles.sheetHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sheetTitle}>Choose a template</Text>
              <Text style={styles.sheetSub}>Only templates the server will accept for a segment are listed.</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.sheetClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={18} color={C.ink} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ paddingBottom: 34 }} showsVerticalScrollIndicator={false}>
            {groups.length === 0 && (
              <Text style={styles.emptyInline}>No template can be sent to a segment.</Text>
            )}
            {groups.map(([cat, list]) => (
              <View key={cat}>
                <SectionLabel>{String(cat).toUpperCase()}</SectionLabel>
                <View style={{ paddingHorizontal: 16, gap: 8 }}>
                  {list.map((t) => {
                    const on = t.key === selectedKey;
                    const relTone = t.relevance === 'suggested' ? C.emerald : t.relevance === 'not_applicable' ? C.rose : C.blueDeep;
                    return (
                      <TouchableOpacity key={t.key} style={[styles.tplRow, on && styles.tplRowActive]} onPress={() => onPick(t)} activeOpacity={0.85}>
                        <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={18} color={on ? C.blueDeep : C.textFaint} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <View style={styles.tplTitleRow}>
                            <Text style={styles.tplLabel} numberOfLines={1}>{t.label || t.key}</Text>
                            {!!t.relevance && (
                              <View style={[styles.relPill, { backgroundColor: relTone + '18' }]}>
                                <Text style={[styles.relPillText, { color: relTone }]}>{t.relevance}</Text>
                              </View>
                            )}
                          </View>
                          {!!t.description && <Text style={styles.tplDesc} numberOfLines={3}>{t.description}</Text>}
                          {!!t.reason && <Text style={styles.tplReason} numberOfLines={2}>{t.reason}</Text>}
                          {!!t.route && (
                            <Text style={styles.tplRoute} numberOfLines={1}>
                              opens {t.route}{t.params && Object.keys(t.params).length ? ` ${JSON.stringify(t.params)}` : ''}
                            </Text>
                          )}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            ))}
            {hidden.length > 0 && (
              <>
                <SectionLabel>NOT OFFERED ({hidden.length})</SectionLabel>
                <View style={{ paddingHorizontal: 16, gap: 6 }}>
                  {hidden.map((h) => (
                    <View key={h.key} style={styles.hiddenRow}>
                      <Ionicons name="lock-closed" size={11} color={C.textFaint} style={{ marginTop: 2 }} />
                      <Text style={styles.hiddenText}><Text style={{ fontWeight: '800', color: C.ink }}>{h.label}</Text> — {h.why}</Text>
                    </View>
                  ))}
                </View>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
export default function SegmentsScreen() {
  const router = useRouter();

  // ── catalogue ──
  const [segments, setSegments] = useState<AdminSegment[]>([]);
  const [segLoading, setSegLoading] = useState(true);
  const [segError, setSegError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [templates, setTemplates] = useState<AdminNotifyTemplate[]>([]);
  const [hiddenTemplates, setHiddenTemplates] = useState<{ key: string; label: string; why: string }[]>([]);
  const [tplLoaded, setTplLoaded] = useState(false);
  const [tplLoading, setTplLoading] = useState(true);
  const [tplError, setTplError] = useState<string | null>(null);
  const [tplWarning, setTplWarning] = useState<string | null>(null);

  // ── selection ──
  const [segKey, setSegKey] = useState<string | null>(null);
  const [segListOpen, setSegListOpen] = useState(true);
  const [users, setUsers] = useState<AdminSegmentUsersResponse | null>(null);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [usersExpanded, setUsersExpanded] = useState(false);

  const [tplKey, setTplKey] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [seedTitle, setSeedTitle] = useState('');   // what the template rendered WITHOUT a user
  const [seedBody, setSeedBody] = useState('');
  const [maxText, setMaxText] = useState(String(MAX_DEFAULT));

  // ── the safety machine ──
  const [armed, setArmed] = useState<ArmedPreview | null>(null);
  const [disarmReason, setDisarmReason] = useState<string>('no preview has been run yet');
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ResultView | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [hardLock, setHardLock] = useState<string | null>(null);
  const previewGen = useRef(0);
  const usersSeq = useRef(0);

  const selectedSegment = useMemo(() => segments.find((s) => s.key === segKey) || null, [segments, segKey]);
  const selectedTemplate = useMemo(() => templates.find((t) => t.key === tplKey) || null, [templates, tplKey]);
  const segLabel = selectedSegment?.label || segKey || '';
  const cappedMax = useMemo(() => clampMax(maxText), [maxText]);

  // Only fields the admin actually CHANGED become overrides — see the comment on OverrideMode.
  const overrides = useMemo<AdminNotifyOverrides>(() => {
    const o: AdminNotifyOverrides = {};
    if (title.trim() && title !== seedTitle) o.title = title.trim();
    if (body.trim() && body !== seedBody) o.body = body.trim();
    return o;
  }, [title, body, seedTitle, seedBody]);
  const mode = useMemo(() => overrideMode(overrides), [overrides]);

  // Signature of everything that decides WHO gets WHAT. Raw (untrimmed) title/body on purpose:
  // any keystroke must disarm Send. cappedMax (not the raw text) because that is what is sent.
  const sig = useMemo(
    () => [segKey || '', tplKey || '', title, body, String(cappedMax)].join('\u0001'),
    [segKey, tplKey, title, body, cappedMax],
  );

  // Derived, never stored: the button cannot be armed unless the armed preview describes the copy
  // and audience currently on screen. This is what makes a forgotten disarm() call harmless.
  const previewFresh = !!armed && armed.sig === sig && armed.segKey === segKey;
  const canSend = previewFresh && armed!.sendCount > 0 && !sending && !previewing && !denied && !hardLock;
  const lockWhy = useMemo(() => {
    if (denied) return 'admin access was denied';
    if (hardLock) return 'the API returned something unexpected';
    if (sending) return 'a send is in progress';
    if (!armed) return disarmReason;
    if (!previewFresh) return 'the message changed after the preview';
    if (armed.sendCount <= 0) return 'nobody in this segment can receive it right now';
    return '';
  }, [denied, hardLock, sending, armed, previewFresh, disarmReason]);

  // Refs so the Alert callback (a stale closure by construction) can re-check the LIVE state.
  const sigRef = useRef(sig);
  const armedRef = useRef(armed);
  const sendingRef = useRef(false);
  useEffect(() => { sigRef.current = sig; }, [sig]);
  useEffect(() => { armedRef.current = armed; }, [armed]);
  useEffect(() => { sendingRef.current = sending; }, [sending]);

  /** The ONLY way to drop the armed state. Bumps the generation so an in-flight preview is stale. */
  const disarm = useCallback((why: string) => {
    previewGen.current += 1;
    setArmed(null);
    setDisarmReason(why);
  }, []);

  /** A 401/403 must not leave an operational-looking screen behind — tear everything down. */
  const gate = useCallback((e: unknown): boolean => {
    const st = httpStatus(e);
    if (st !== 401 && st !== 403) return false;
    previewGen.current += 1;
    setArmed(null);
    setDisarmReason('admin access was denied');
    setDenied(errMsg(e, 'Admin privileges are required for this screen.'));
    setSegments([]); setUsers(null); setTemplates([]); setHiddenTemplates([]);
    setTplLoaded(false); setResult(null);
    return true;
  }, []);

  // ── loaders ──────────────────────────────────────────────────────────────────
  const loadTemplates = useCallback(async () => {
    setTplLoading(true); setTplError(null);
    try {
      // No userId on purpose: a segment send has no single user, so the seed copy is the GENERIC
      // render. That is exactly the text we must NOT echo back as an override.
      const d = await fetchAdminNotifyTemplates();
      const prefCats = Array.isArray(d.categories) ? d.categories : null;
      const keep: AdminNotifyTemplate[] = [];
      const hide: { key: string; label: string; why: string }[] = [];
      (d.templates || []).forEach((t) => {
        let why: string | null = null;
        if (t.needsJob) why = 'needs one specific job — the server refuses to send it to a segment';
        else if (prefCats && prefCats.length && prefCats.indexOf(t.category) < 0) {
          why = `category "${t.category || '—'}" is not an opt-out column, so the server refuses it (opt-outs could not be honoured)`;
        } else if (t.relevance === 'not_applicable') {
          why = `not applicable${t.reason ? ` — ${t.reason}` : ''}`;
        }
        if (why) hide.push({ key: t.key, label: t.label || t.key, why });
        else keep.push(t);
      });
      setTemplates(keep);
      setHiddenTemplates(hide);
      setTplWarning(d.warning || null);
      setTplLoaded(true);
    } catch (e: unknown) {
      if (gate(e)) return;
      setTemplates([]); setHiddenTemplates([]); setTplLoaded(false);
      setTplError(errMsg(e, 'Could not load the notification templates.'));
    } finally {
      setTplLoading(false);
    }
  }, [gate]);

  const loadSegments = useCallback(async () => {
    setSegError(null);
    try {
      const list = await fetchAdminSegments();
      setSegments(list);
    } catch (e: unknown) {
      if (gate(e)) return;
      setSegments([]);
      setSegError(errMsg(e, 'Could not load segments.'));
    }
  }, [gate]);

  const loadUsers = useCallback(async (key: string, templateKey: string | null) => {
    const seq = ++usersSeq.current;
    setUsersLoading(true); setUsersError(null);
    try {
      // templateKey gives the REAL per-user opted_out / recently_sent flags and the segment-wide
      // exclusion breakdown; without it those flags are always false.
      const d = await fetchAdminSegmentUsers(key, { limit: USERS_LIMIT, templateKey });
      if (seq !== usersSeq.current) return;   // a newer selection won — write nothing
      setUsers(d);
    } catch (e: unknown) {
      if (seq !== usersSeq.current) return;
      if (gate(e)) return;
      setUsers(null);
      setUsersError(errMsg(e, 'Could not load the users in this segment.'));
    } finally {
      if (seq === usersSeq.current) setUsersLoading(false);
    }
  }, [gate]);

  useEffect(() => {
    (async () => {
      setSegLoading(true);
      await Promise.all([loadTemplates(), loadSegments()]);
      setSegLoading(false);
    })();
  }, [loadTemplates, loadSegments]);

  // A template that disappeared between reloads must not stay selected.
  useEffect(() => {
    if (!tplLoaded || !tplKey) return;
    if (!templates.some((t) => t.key === tplKey)) {
      setTplKey(null); setTitle(''); setBody(''); setSeedTitle(''); setSeedBody('');
      setResult(null);
      disarm('the selected template is no longer available');
    }
  }, [templates, tplLoaded, tplKey, disarm]);

  // Reload the member list whenever the segment or the template changes (the template decides the
  // per-user opt-out / dedupe flags).
  useEffect(() => {
    if (!segKey) { setUsers(null); return; }
    loadUsers(segKey, tplKey);
  }, [segKey, tplKey, loadUsers]);

  // ── transitions ──────────────────────────────────────────────────────────────
  const onSelectSegment = useCallback((s: AdminSegment) => {
    setSegKey(s.key);
    setSegListOpen(false);
    setUsersExpanded(false);
    setResult(null);
    disarm('the segment changed');       // T1
  }, [disarm]);

  const onPickTemplate = useCallback((t: AdminNotifyTemplate) => {
    setTplKey(t.key);
    // Remember the seed so overrides can tell "the admin typed this" from "this is the placeholder".
    setTitle(t.title || ''); setBody(t.body || '');
    setSeedTitle(t.title || ''); setSeedBody(t.body || '');
    setPickerOpen(false);
    setResult(null);
    disarm('the template changed');      // T2
  }, [disarm]);

  const onChangeTitle = useCallback((v: string) => { setTitle(v); disarm('the title was edited'); }, [disarm]);        // T3
  const onChangeBody = useCallback((v: string) => { setBody(v); disarm('the body was edited'); }, [disarm]);           // T4
  const onChangeMax = useCallback((v: string) => {
    setMaxText(v.replace(/[^0-9]/g, '').slice(0, 4));
    disarm('the recipient cap changed');                                                                              // T5
  }, [disarm]);
  const onBlurMax = useCallback(() => { setMaxText(String(clampMax(maxText))); }, [maxText]);

  const resetCopyToTemplate = useCallback(() => {
    setTitle(seedTitle); setBody(seedBody);
    disarm('the copy was reset to the template');
  }, [seedTitle, seedBody, disarm]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    // A refresh can move who is in a segment, so anything previewed before it is no longer proven.
    disarm('the data was refreshed');    // T14
    await Promise.all([loadSegments(), loadTemplates()]);
    if (segKey) await loadUsers(segKey, tplKey);
    setRefreshing(false);
  }, [disarm, loadSegments, loadTemplates, loadUsers, segKey, tplKey]);

  // ── preview (dry run — structurally cannot send: previewAdminSegmentNotify has no `confirm`) ──
  const runPreview = useCallback(async () => {
    if (denied || hardLock || previewing || sending) return;
    if (!segKey) { setResult({ kind: 'note', message: 'Select a segment first.' }); return; }
    if (!tplKey) { setResult({ kind: 'note', message: 'Pick a template first.' }); return; }

    setPreviewing(true);
    const myGen = previewGen.current;
    const mySig = sig;
    const mySeg = segKey;
    const payload: SendPayload = {
      templateKey: tplKey,
      overrides: Object.keys(overrides).length ? overrides : null,
      maxRecipients: cappedMax,
    };
    const myMode = mode;
    try {
      const data = await previewAdminSegmentNotify(mySeg, payload);
      // A newer selection / edit happened while this was in flight → this answer describes copy or
      // an audience that is no longer on screen. It must never arm Send.                    // T7
      if (myGen !== previewGen.current || mySig !== sigRef.current) {
        disarm('the selection changed while the preview was running');
        setResult({ kind: 'note', message: 'The selection changed while previewing — that result was discarded. Run Preview again.' });
        return;
      }
      const reachable = Number(data.reachable ?? data.recipients ?? 0);
      setArmed({ sig: mySig, segKey: mySeg, payload, data, sendCount: reachable, mode: myMode });   // T11
      setDisarmReason('');
      setResult({ kind: 'preview', data, mode: myMode });
    } catch (e: unknown) {
      if (gate(e)) return;
      const msg = errMsg(e, 'Preview failed.');
      // previewAdminSegmentNotify throws this when the server answered dryRun:false — i.e. pushes
      // went out under a Preview button. Lock the screen rather than let another request follow. T9
      if (/REAL send result/i.test(msg)) {
        disarm('the API returned something unexpected');
        setHardLock(msg);
        setResult({ kind: 'error', message: `${msg} Nothing further will be sent from this screen — check the API before retrying.` });
        return;
      }
      disarm('the preview failed');      // T8
      setResult({ kind: 'error', message: msg });
    } finally {
      setPreviewing(false);
    }
  }, [denied, hardLock, previewing, sending, segKey, tplKey, sig, overrides, cappedMax, mode, disarm, gate]);

  // ── the real send ────────────────────────────────────────────────────────────
  const doSend = useCallback(async (snapshot: ArmedPreview) => {
    // Re-check against the LIVE state: the confirm dialog is asynchronous, and a refresh or a
    // keystroke behind it must still cancel the send.                                       // T12
    if (sendingRef.current) return;
    const live = armedRef.current;
    if (!live || live !== snapshot || live.sig !== sigRef.current || live.sendCount <= 0) {
      disarm('the message changed after the preview');
      setResult({ kind: 'note', message: 'The message or the audience changed after the preview — nothing was sent. Run Preview again.' });
      return;
    }
    setSending(true);
    try {
      // Send the EXACT payload that was previewed (never a fresh read of the form), so the copy that
      // goes out is provably the copy that was reviewed.
      const data = await sendAdminSegmentNotify(snapshot.segKey, snapshot.payload);
      setResult({
        kind: 'sent',
        data,
        templateLabel: selectedTemplate?.label || snapshot.payload.templateKey,
        segLabel: segLabel || snapshot.segKey,
      });
      // Counts have moved and the batch is now inside the dedupe window.
      loadSegments();
      if (segKey) loadUsers(segKey, tplKey);
    } catch (e: unknown) {
      if (gate(e)) return;
      setResult({ kind: 'error', message: errMsg(e, 'The send failed.') });
    } finally {
      setSending(false);
      // Whatever happened, a fresh preview is required before another send (no double-send).  // T13
      disarm('this selection was already sent — run a new preview');
    }
  }, [disarm, gate, selectedTemplate, segLabel, segKey, tplKey, loadSegments, loadUsers]);

  const onSendPress = useCallback(() => {
    const snapshot = armedRef.current;
    if (!canSend || !snapshot) return;
    const n = snapshot.sendCount;
    const tplLabel = selectedTemplate?.label || snapshot.payload.templateKey;
    Alert.alert(
      `Send to ${fmt(n)} real ${plural(n, 'person', 'people')}?`,
      `Template: ${tplLabel}\nSegment: ${segLabel}\nCopy: ${personalisationShort(snapshot.mode)}\n\n` +
      `${fmt(n)} ${plural(n, 'person', 'people')} will get a push notification on their phone immediately. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: `Send to ${fmt(n)}`, style: 'destructive', onPress: () => { doSend(snapshot); } },
      ],
      { cancelable: true },
    );
  }, [canSend, selectedTemplate, segLabel, doSend]);

  // ── render helpers ───────────────────────────────────────────────────────────
  const visibleUsers = useMemo(() => {
    const list = users?.users || [];
    return usersExpanded ? list : list.slice(0, USERS_COLLAPSED);
  }, [users, usersExpanded]);

  const openUser = useCallback((id: number) => {
    router.push({ pathname: '/(admin)/user-360', params: { userId: String(id) } } as unknown as RouterHref);
  }, [router]);

  // ── denied ───────────────────────────────────────────────────────────────────
  if (denied) {
    return (
      <SafeAreaView style={styles.safe}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="chevron-back" size={22} color={C.ink} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}><Text style={styles.hTitle}>Segments</Text></View>
        </View>
        <View style={styles.deniedWrap}>
          <Ionicons name="lock-closed" size={44} color={C.rose} />
          <Text style={styles.deniedTitle}>Access denied</Text>
          <WarnBox>{denied}</WarnBox>
          <Text style={styles.deniedSub}>
            No segment, user or template data was loaded, and nothing can be sent from this screen.
            Sign in with an admin account and reopen it.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={22} color={C.ink} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.hTitle}>Segments</Text>
          <Text style={styles.hSub}>Pick a segment, preview, then confirm</Text>
        </View>
        <View style={styles.hIcon}><Ionicons name="megaphone" size={18} color={C.teal} /></View>
      </View>

      {segLoading ? (
        <View style={styles.center}><ActivityIndicator color={C.blue} size="large" /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 14, paddingBottom: 60 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.blue} />}
        >
          {!!hardLock && (
            <WarnBox icon="alert-circle">
              The API returned a real send result for a dry run. This screen is locked — preview and
              send are disabled until it is reopened. {hardLock}
            </WarnBox>
          )}

          {/* ── SEGMENTS ── */}
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>Segments</Text>
                <Text style={styles.cardSub}>Live counts, computed on load. Soft-deleted users are excluded everywhere.</Text>
              </View>
              {!!segKey && (
                <TouchableOpacity style={styles.ghostBtn} onPress={() => setSegListOpen((v) => !v)} activeOpacity={0.8}>
                  <Ionicons name={segListOpen ? 'chevron-up' : 'chevron-down'} size={13} color={C.ink} />
                  <Text style={styles.ghostBtnText}>{segListOpen ? 'Hide' : 'Change'}</Text>
                </TouchableOpacity>
              )}
            </View>

            {segError ? (
              <View style={{ paddingTop: 12, gap: 10 }}>
                <WarnBox>{segError}</WarnBox>
                <TouchableOpacity style={styles.primaryBtnSm} onPress={loadSegments} activeOpacity={0.85}>
                  <Text style={styles.primaryBtnSmText}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : segments.length === 0 ? (
              <View style={styles.emptyBox}>
                <Ionicons name="people-outline" size={34} color={C.textFaint} />
                <Text style={styles.emptyText}>No segments are defined.</Text>
              </View>
            ) : (
              <View style={{ marginTop: 10, gap: 8 }}>
                {(segListOpen ? segments : segments.filter((s) => s.key === segKey)).map((s) => (
                  <SegmentCard key={s.key} seg={s} selected={s.key === segKey} onPress={() => onSelectSegment(s)} />
                ))}
                {segments.some((s) => s.count == null) && (
                  <NoteBox>Segments showing “?” could not be counted — that is not a count of zero.</NoteBox>
                )}
              </View>
            )}
          </View>

          {/* ── WHO IS IN IT ── */}
          {!segKey ? (
            <View style={[styles.card, styles.emptyCard]}>
              <Ionicons name="hand-left-outline" size={30} color={C.textFaint} />
              <Text style={styles.emptyText}>Select a segment above to see who is in it.</Text>
            </View>
          ) : (
            <View style={styles.card}>
              <View style={styles.cardHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{segLabel}</Text>
                  <Text style={styles.cardSub}>
                    {users ? `${fmt(users.total)} ${plural(users.total, 'user')} in this segment` : 'Loading…'}
                    {users?.sendableTotal != null ? ` · ${fmt(users.sendableTotal)} sendable` : ''}
                  </Text>
                </View>
                <View style={styles.keyChip}><Text style={styles.keyChipText}>{segKey}</Text></View>
              </View>

              {usersLoading ? (
                <View style={{ paddingVertical: 30, alignItems: 'center' }}><ActivityIndicator color={C.blue} /></View>
              ) : usersError ? (
                <View style={{ paddingTop: 12, gap: 10 }}>
                  <WarnBox>{usersError}</WarnBox>
                  <TouchableOpacity style={styles.primaryBtnSm} onPress={() => loadUsers(segKey, tplKey)} activeOpacity={0.85}>
                    <Text style={styles.primaryBtnSmText}>Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : !users || users.users.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Ionicons name="people-outline" size={30} color={C.textFaint} />
                  <Text style={styles.emptyText}>No users currently match this segment.</Text>
                  {!!users?.error && <Text style={styles.emptySub}>{users.error}</Text>}
                </View>
              ) : (
                <>
                  {/* segment-wide exclusions — NEVER "dropped from this batch" */}
                  {!!users.excluded && (
                    <View style={styles.exclBox}>
                      <Text style={styles.exclHead}>EXCLUDED ACROSS THE WHOLE SEGMENT{tplKey ? '' : ' (pick a template for real numbers)'}</Text>
                      <View style={styles.exclRow}>
                        <Text style={styles.exclLabel}>No push token on file</Text>
                        <Text style={styles.exclN}>{fmt(users.excluded.no_token)}</Text>
                      </View>
                      <View style={styles.exclRow}>
                        <Text style={styles.exclLabel}>Opted out of this category</Text>
                        <Text style={styles.exclN}>{fmt(users.excluded.opted_out)}</Text>
                      </View>
                      <View style={[styles.exclRow, styles.exclRowLast]}>
                        <Text style={styles.exclLabel}>Already sent this template in {DEDUPE_HOURS}h</Text>
                        <Text style={styles.exclN}>{fmt(users.excluded.recently_sent)}</Text>
                      </View>
                    </View>
                  )}
                  {!!users.exclusion_note && <NoteBox icon="funnel-outline">{users.exclusion_note}</NoteBox>}
                  {users.truncation_note
                    ? <NoteBox>{users.truncation_note}</NoteBox>
                    : users.truncated
                      ? <NoteBox>The server flagged this list as truncated but returned no explanation — assume users are missing below.</NoteBox>
                      : null}

                  <View style={styles.legendRow}>
                    <View style={[styles.pushDot, { backgroundColor: C.emerald }]} />
                    <Text style={styles.legendText}>push-reachable</Text>
                    <View style={[styles.pushDot, { backgroundColor: '#C3CCDC', marginLeft: 10 }]} />
                    <Text style={styles.legendText}>cannot be reached</Text>
                  </View>

                  <View style={{ marginTop: 6 }}>
                    {visibleUsers.map((u) => (
                      <UserRow key={u.id} u={u} hasTemplate={!!tplKey} onPress={() => openUser(u.id)} />
                    ))}
                  </View>
                  {users.users.length > USERS_COLLAPSED && (
                    <TouchableOpacity style={styles.expandBtn} onPress={() => setUsersExpanded((v) => !v)} activeOpacity={0.8}>
                      <Ionicons name={usersExpanded ? 'chevron-up' : 'chevron-down'} size={14} color={C.blueDeep} />
                      <Text style={styles.expandBtnText}>
                        {usersExpanded ? 'Show fewer' : `Show all ${fmt(users.users.length)} loaded`}
                      </Text>
                    </TouchableOpacity>
                  )}
                  {!!users.last_seen_note && <Text style={styles.footnote}>{users.last_seen_note}</Text>}
                </>
              )}
            </View>
          )}

          {/* ── SEND ── */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>📣 Send to this segment</Text>
            <Text style={styles.cardSub}>
              Preview first — Send stays locked until a preview has run for the exact selection below.
            </Text>
            <View style={{ marginTop: 10 }}><LiveTargetWarning what="Sending here pushes to every real person in this segment" /></View>
            <View style={{ marginTop: 10 }}>
              <WarnBox>
                This sends a real push notification to real people’s phones. Opted-out users and anyone
                who already got this template in the last {DEDUPE_HOURS}h are skipped automatically.
              </WarnBox>
            </View>

            {!tplLoaded ? (
              tplLoading ? (
                <View style={{ paddingVertical: 26, alignItems: 'center' }}><ActivityIndicator color={C.blue} /></View>
              ) : (
                <View style={{ paddingTop: 12, gap: 10 }}>
                  <WarnBox>{tplError || 'Templates could not be loaded.'}</WarnBox>
                  <TouchableOpacity style={styles.primaryBtnSm} onPress={loadTemplates} activeOpacity={0.85}>
                    <Text style={styles.primaryBtnSmText}>Retry loading templates</Text>
                  </TouchableOpacity>
                </View>
              )
            ) : !segKey ? (
              <View style={styles.emptyBox}>
                <Ionicons name="arrow-up-outline" size={28} color={C.textFaint} />
                <Text style={styles.emptyText}>Select a segment first.</Text>
              </View>
            ) : (
              <>
                {!!tplWarning && <NoteBox>{tplWarning}</NoteBox>}

                {templates.length === 0 ? (
                  <View style={{ paddingTop: 12, gap: 10 }}>
                    <NoteBox>No template can be sent to a segment.</NoteBox>
                    {hiddenTemplates.map((h) => (
                      <Text key={h.key} style={styles.hiddenText}>
                        <Text style={{ fontWeight: '800', color: C.ink }}>{h.label}</Text> — {h.why}
                      </Text>
                    ))}
                    <TouchableOpacity style={styles.primaryBtnSm} onPress={loadTemplates} activeOpacity={0.85}>
                      <Text style={styles.primaryBtnSmText}>Reload templates</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    {/* template */}
                    <Text style={styles.fieldLabel}>TEMPLATE</Text>
                    <TouchableOpacity style={styles.selectBtn} onPress={() => setPickerOpen(true)} activeOpacity={0.85}>
                      <Ionicons name="document-text-outline" size={16} color={C.textMuted} />
                      <Text style={[styles.selectBtnText, !selectedTemplate && { color: C.textFaint }]} numberOfLines={1}>
                        {selectedTemplate ? (selectedTemplate.label || selectedTemplate.key) : 'Choose a template'}
                      </Text>
                      <Ionicons name="chevron-down" size={16} color={C.textMuted} />
                    </TouchableOpacity>
                    {!!selectedTemplate?.description && (
                      <Text style={styles.fieldHint}>{selectedTemplate.description}</Text>
                    )}
                    {hiddenTemplates.length > 0 && (
                      <Text style={styles.fieldHint}>
                        {hiddenTemplates.length} {plural(hiddenTemplates.length, 'template')} hidden — a segment send would be rejected. Open the picker to see why.
                      </Text>
                    )}

                    {/* copy */}
                    {/* ⚠️ 90 / 200 are the server's real delivery limits (notifyTemplates clips to
                        exactly that). Allowing 120 / 400 here let an admin write copy that arrived
                        silently truncated — they would only discover it on the recipient's phone. */}
                    <Text style={styles.fieldLabel}>TITLE {title.length}/{TITLE_MAX}</Text>
                    <TextInput
                      value={title}
                      onChangeText={onChangeTitle}
                      placeholder="Notification title"
                      placeholderTextColor={C.textFaint}
                      style={styles.input}
                      maxLength={TITLE_MAX}
                      editable={!!selectedTemplate && !sending}
                    />
                    <Text style={styles.fieldLabel}>BODY {body.length}/{BODY_MAX}</Text>
                    <TextInput
                      value={body}
                      onChangeText={onChangeBody}
                      placeholder="Notification body"
                      placeholderTextColor={C.textFaint}
                      style={[styles.input, styles.textarea]}
                      maxLength={BODY_MAX}
                      multiline
                      textAlignVertical="top"
                      editable={!!selectedTemplate && !sending}
                    />

                    {!!selectedTemplate && (
                      <View style={[styles.modeRow, mode === 'none' ? styles.modeRowOk : styles.modeRowFixed]}>
                        <Ionicons
                          name={mode === 'none' ? 'sparkles-outline' : 'lock-closed'}
                          size={13}
                          color={mode === 'none' ? C.emerald : C.amber}
                        />
                        <Text style={[styles.modeText, { color: mode === 'none' ? C.emerald : C.amber }]}>
                          {personalisationShort(mode)}
                        </Text>
                        {mode !== 'none' && (
                          <TouchableOpacity onPress={resetCopyToTemplate} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Text style={styles.resetLink}>Reset</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    )}
                    {!!selectedTemplate && <Text style={styles.fieldHint}>{personalisationLine(mode)}</Text>}

                    {/* cap */}
                    <Text style={styles.fieldLabel}>MAX RECIPIENTS (HARD CEILING {MAX_CEILING})</Text>
                    <TextInput
                      value={maxText}
                      onChangeText={onChangeMax}
                      onBlur={onBlurMax}
                      keyboardType="number-pad"
                      placeholder={String(MAX_DEFAULT)}
                      placeholderTextColor={C.textFaint}
                      style={styles.input}
                      editable={!sending}
                    />
                    {clampMax(maxText) !== parseInt(maxText || '0', 10) && (
                      <Text style={styles.fieldHint}>Will be sent as {fmt(cappedMax)}.</Text>
                    )}

                    <StepBar hasTemplate={!!tplKey} hasPreview={previewFresh} />

                    {/* actions */}
                    <View style={styles.actions}>
                      <TouchableOpacity
                        style={[styles.previewBtn, (previewing || sending || !tplKey || !!hardLock) && styles.btnDisabled]}
                        onPress={runPreview}
                        disabled={previewing || sending || !tplKey || !!hardLock}
                        activeOpacity={0.85}
                      >
                        {previewing
                          ? <ActivityIndicator color="#fff" size="small" />
                          : <><Ionicons name="eye-outline" size={16} color="#fff" /><Text style={styles.previewBtnText}>Preview</Text></>}
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.sendBtn, !canSend && styles.sendBtnLocked]}
                        onPress={onSendPress}
                        disabled={!canSend}
                        activeOpacity={0.85}
                      >
                        {sending
                          ? <ActivityIndicator color="#fff" size="small" />
                          : (
                            <>
                              <Ionicons name={canSend ? 'send' : 'lock-closed'} size={15} color={canSend ? '#fff' : '#9AA6BE'} />
                              <Text style={[styles.sendBtnText, !canSend && { color: '#9AA6BE' }]}>
                                {canSend && armed ? `Send to ${fmt(armed.sendCount)}` : 'Send'}
                              </Text>
                            </>
                          )}
                      </TouchableOpacity>
                    </View>

                    {!canSend && !sending && (
                      <Text style={styles.lockLine}>
                        <Ionicons name="lock-closed" size={11} color={C.textMuted} /> Send is locked
                        {lockWhy ? ` — ${lockWhy}` : ''}{previewFresh && armed && armed.sendCount > 0 ? '' : '. Run Preview.'}
                      </Text>
                    )}

                    {/* ── result ── */}
                    {result?.kind === 'note' && <View style={{ marginTop: 12 }}><NoteBox>{result.message}</NoteBox></View>}
                    {result?.kind === 'error' && <View style={{ marginTop: 12 }}><WarnBox>{result.message}</WarnBox></View>}

                    {result?.kind === 'preview' && (() => {
                      const d = result.data;
                      const sk = d.skipped || { no_token: 0, opted_out: 0, recently_sent: 0 };
                      const skipTotal = Number(sk.no_token || 0) + Number(sk.opted_out || 0) + Number(sk.recently_sent || 0);
                      const reachable = Number(d.reachable ?? d.recipients ?? 0);
                      const pv = d.preview || { title: '', body: '', route: null, params: {} };
                      return (
                        <View style={{ marginTop: 14 }}>
                          {/* The panel below describes the selection the preview RAN for. If the copy
                              or the audience has moved on since, say so loudly rather than let stale
                              numbers read as current. */}
                          {previewFresh
                            ? <OkBox>Dry run only — nothing was sent.</OkBox>
                            : <NoteBox icon="alert-circle">
                                Out of date — this preview was run for a different segment, template or
                                wording. The numbers and copy below no longer describe what would be sent.
                                Run Preview again.
                              </NoteBox>}
                          <View style={styles.statRow}>
                            <StatCard n={d.totalMatching} label="match the segment" />
                            <StatCard n={reachable} label="will receive it now" tone="ok" />
                            <StatCard n={skipTotal} label="excluded segment-wide" tone="warn" />
                          </View>
                          {d.sendableTotal != null && Number(d.sendableTotal) > reachable && (
                            <View style={styles.statRow}>
                              <StatCard n={d.sendableTotal} label="sendable in total" />
                              <StatCard n={d.remainingAfterThisRun} label="left after this run" tone="warn" />
                            </View>
                          )}

                          <View style={styles.copyBox}>
                            <Text style={styles.copyBoxHead}>{personalisationHeader(result.mode).toUpperCase()}</Text>
                            <View style={{ padding: 12 }}>
                              <Text style={styles.copyTitle}>{pv.title || '—'}</Text>
                              <Text style={styles.copyBody}>{pv.body || '—'}</Text>
                              {!!pv.route && (
                                <Text style={styles.copyRoute}>
                                  opens {pv.route}{pv.params && Object.keys(pv.params).length ? ` ${JSON.stringify(pv.params)}` : ''}
                                </Text>
                              )}
                              <Text style={styles.copyNote}>{personalisationLine(result.mode)}</Text>
                            </View>
                          </View>

                          {/* ⚠️ segment-wide, NOT "dropped from this batch" */}
                          <View style={styles.exclBox}>
                            <Text style={styles.exclHead}>EXCLUDED ACROSS THE WHOLE SEGMENT (NOT JUST THIS BATCH)</Text>
                            <View style={styles.exclRow}>
                              <Text style={styles.exclLabel}>📵 No push token on file — the app was never opened with notifications allowed</Text>
                              <Text style={styles.exclN}>{fmt(sk.no_token)}</Text>
                            </View>
                            <View style={styles.exclRow}>
                              <Text style={styles.exclLabel}>🚫 Opted out of this notification category</Text>
                              <Text style={styles.exclN}>{fmt(sk.opted_out)}</Text>
                            </View>
                            <View style={[styles.exclRow, styles.exclRowLast]}>
                              <Text style={styles.exclLabel}>⏱️ Already got this template in the last {DEDUPE_HOURS}h</Text>
                              <Text style={styles.exclN}>{fmt(sk.recently_sent)}</Text>
                            </View>
                          </View>
                          {!!d.exclusion_note && <NoteBox icon="funnel-outline">{d.exclusion_note}</NoteBox>}
                          {d.truncation_note
                            ? <NoteBox>{d.truncation_note}</NoteBox>
                            : d.truncated
                              ? <NoteBox>The server flagged this preview as truncated but returned no explanation — users beyond the cap are NOT included.</NoteBox>
                              : null}
                          {reachable === 0 && (
                            <NoteBox icon="ban-outline">
                              Nobody in this segment can receive this template right now, so Send stays locked.
                            </NoteBox>
                          )}
                        </View>
                      );
                    })()}

                    {result?.kind === 'sent' && (() => {
                      const d = result.data;
                      const sent = Number(d.sent || 0);
                      const failed = Number(d.failed || 0);
                      const sk = d.skipped || { no_token: 0, opted_out: 0, recently_sent: 0 };
                      const skTxt = `${fmt(sk.no_token)} no push token · ${fmt(sk.opted_out)} opted out · ${fmt(sk.recently_sent)} already sent in ${DEDUPE_HOURS}h`;
                      const rt = d.runtimeSkipped;
                      const runtimeTotal = rt ? Number(rt.no_token || 0) + Number(rt.opted_out || 0) + Number(rt.recently_sent || 0) : 0;
                      return (
                        <View style={{ marginTop: 14 }}>
                          {/* No green tick unless something was actually delivered. */}
                          {sent > 0
                            ? <OkBox>Sent to {fmt(sent)} {plural(sent, 'phone')}. Run a new preview before sending again.</OkBox>
                            : <WarnBox icon="ban-outline">Nothing was delivered — every selected recipient was blocked or failed. Run a new preview before trying again.</WarnBox>}
                          <View style={styles.statRow}>
                            <StatCard n={sent} label="delivered" tone={sent > 0 ? 'ok' : 'bad'} />
                            <StatCard n={failed} label="failed / blocked" tone={failed > 0 ? 'bad' : 'plain'} />
                            <StatCard n={d.recipients} label="in this batch" />
                          </View>
                          {runtimeTotal > 0 && (
                            <NoteBox icon="ban-outline">
                              {fmt(runtimeTotal)} {plural(runtimeTotal, 'recipient')} were blocked between the preview and the send
                              (opted out, lost their token, or another sender got there first).
                            </NoteBox>
                          )}
                          {/* segment-wide, not "your send lost N users" */}
                          <NoteBox icon="funnel-outline">
                            Excluded across the whole segment (they were never in this batch): {skTxt}.
                          </NoteBox>
                          {Array.isArray(d.failures) && d.failures.length > 0 && (
                            <View style={styles.exclBox}>
                              <Text style={styles.exclHead}>FAILURES (FIRST {d.failures.length})</Text>
                              {d.failures.map((f, i) => (
                                <View key={`${f.userId}-${i}`} style={[styles.exclRow, i === d.failures.length - 1 && styles.exclRowLast]}>
                                  <Text style={styles.exclLabel}>user #{f.userId}</Text>
                                  <Text style={[styles.exclN, { color: C.rose }]}>{String(f.reason).replace(/_/g, ' ')}</Text>
                                </View>
                              ))}
                            </View>
                          )}
                          {!!d.batchId && <Text style={styles.footnote}>batch {d.batchId}</Text>}
                          {d.truncation_note
                            ? <NoteBox>{d.truncation_note}</NoteBox>
                            : d.truncated
                              ? <NoteBox>The server flagged this send as truncated but returned no explanation — some matching users were not sent to.</NoteBox>
                              : null}
                        </View>
                      );
                    })()}
                  </>
                )}
              </>
            )}
          </View>
        </ScrollView>
      )}

      <TemplatePicker
        visible={pickerOpen}
        templates={templates}
        hidden={hiddenTemplates}
        selectedKey={tplKey}
        onPick={onPickTemplate}
        onClose={() => setPickerOpen(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'android' ? 28 : 0 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12 },
  backBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  hTitle: { fontSize: 20, fontWeight: '800', color: C.ink, letterSpacing: -0.4 },
  hSub: { fontSize: 12, color: C.textMuted, marginTop: 1 },
  hIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.teal + '15', alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  card: {
    backgroundColor: C.surface, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 14, marginBottom: 14,
    shadowColor: '#0F172A', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.05, shadowRadius: 14, elevation: 2,
  },
  emptyCard: { alignItems: 'center', justifyContent: 'center', paddingVertical: 34, gap: 10 },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  cardTitle: { fontSize: 15.5, fontWeight: '800', color: C.ink },
  cardSub: { fontSize: 11.5, color: C.textMuted, marginTop: 2, lineHeight: 16 },
  keyChip: { backgroundColor: C.bgSoft, borderRadius: 100, paddingHorizontal: 9, paddingVertical: 4 },
  keyChipText: { fontSize: 10.5, fontWeight: '800', color: C.textMuted },

  ghostBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.bgSoft, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7 },
  ghostBtnText: { fontSize: 12, fontWeight: '700', color: C.ink },
  primaryBtnSm: { alignSelf: 'flex-start', backgroundColor: C.blue, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  primaryBtnSmText: { color: '#fff', fontWeight: '700', fontSize: 12.5 },

  // segments
  segCard: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.bg, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 10 },
  segCardActive: { borderColor: C.blueDeep, backgroundColor: 'rgba(37,99,235,0.06)' },
  segAvatar: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  segAvatarText: { color: '#fff', fontWeight: '800', fontSize: 12.5 },
  segLabel: { fontSize: 13.5, fontWeight: '800', color: C.ink },
  segDesc: { fontSize: 11, color: C.textMuted, marginTop: 1, lineHeight: 15 },
  segUnavailable: { fontSize: 10.5, color: C.rose, marginTop: 3, fontWeight: '600' },
  countPill: { minWidth: 40, alignItems: 'center', borderRadius: 100, paddingHorizontal: 8, paddingVertical: 4 },
  countPillLive: { backgroundColor: 'rgba(37,99,235,0.12)' },
  countPillZero: { backgroundColor: C.bgSoft },
  countPillDead: { backgroundColor: 'rgba(239,68,68,0.12)' },
  countPillText: { fontSize: 12, fontWeight: '800' },

  // users
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 12 },
  legendText: { fontSize: 10.5, color: C.textMuted, fontWeight: '600' },
  userRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.border },
  userAvatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  userAvatarText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  userNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  userName: { fontSize: 13.5, fontWeight: '700', color: C.ink, flexShrink: 1 },
  pushDot: { width: 8, height: 8, borderRadius: 4 },
  userEmail: { fontSize: 11, color: C.textMuted, marginTop: 1 },
  userMeta: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' },
  userMetaItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  userMetaText: { fontSize: 10, color: C.textMuted, fontWeight: '600' },
  userFlags: { flexDirection: 'row', gap: 5, marginTop: 5, flexWrap: 'wrap' },
  flagChip: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: C.bgSoft, borderRadius: 100, paddingHorizontal: 7, paddingVertical: 3 },
  flagText: { fontSize: 9.5, fontWeight: '700', color: C.textMuted },
  expandBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: 10, paddingVertical: 9, borderRadius: 10, backgroundColor: C.bgSoft },
  expandBtnText: { fontSize: 12, fontWeight: '700', color: C.blueDeep },
  footnote: { fontSize: 10.5, color: C.textFaint, marginTop: 8, lineHeight: 15 },

  // fields
  fieldLabel: { fontSize: 10.5, fontWeight: '800', color: C.textFaint, letterSpacing: 0.7, marginTop: 14, marginBottom: 6 },
  fieldHint: { fontSize: 11, color: C.textMuted, marginTop: 6, lineHeight: 16 },
  selectBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 46, paddingHorizontal: 12, borderRadius: 12, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border },
  selectBtnText: { flex: 1, fontSize: 13.5, fontWeight: '600', color: C.ink },
  input: { minHeight: 46, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 12, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, fontSize: 13.5, color: C.ink },
  textarea: { minHeight: 96 },

  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, borderWidth: 1 },
  modeRowOk: { backgroundColor: 'rgba(16,185,129,0.08)', borderColor: 'rgba(16,185,129,0.25)' },
  modeRowFixed: { backgroundColor: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.28)' },
  modeText: { flex: 1, fontSize: 11.5, fontWeight: '800' },
  resetLink: { fontSize: 11.5, fontWeight: '800', color: C.blueDeep },

  // steps + actions
  stepBar: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4, marginTop: 16 },
  stepItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stepBullet: { width: 18, height: 18, borderRadius: 9, backgroundColor: C.bgSoft, alignItems: 'center', justifyContent: 'center' },
  stepBulletDone: { backgroundColor: 'rgba(16,185,129,0.16)' },
  stepBulletText: { fontSize: 10, fontWeight: '800', color: C.textMuted },
  stepText: { fontSize: 11, fontWeight: '700', color: C.textMuted },

  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  previewBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 48, borderRadius: 14, backgroundColor: C.blue },
  previewBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  sendBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 48, borderRadius: 14, backgroundColor: C.crimson },
  sendBtnLocked: { backgroundColor: '#E3E8F1' },
  sendBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  btnDisabled: { opacity: 0.5 },
  lockLine: { fontSize: 11, color: C.textMuted, marginTop: 8, lineHeight: 16 },

  // boxes
  noteBox: { flexDirection: 'row', gap: 7, backgroundColor: 'rgba(245,158,11,0.08)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.28)', borderRadius: 12, padding: 10, marginTop: 10 },
  noteText: { flex: 1, fontSize: 11.5, color: '#8A5A05', lineHeight: 16 },
  warnBox: { flexDirection: 'row', gap: 7, backgroundColor: 'rgba(239,68,68,0.07)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.28)', borderRadius: 12, padding: 10 },
  warnText: { flex: 1, fontSize: 11.5, color: '#9B1C1C', lineHeight: 16 },
  okBox: { flexDirection: 'row', gap: 7, backgroundColor: 'rgba(16,185,129,0.08)', borderWidth: 1, borderColor: 'rgba(16,185,129,0.28)', borderRadius: 12, padding: 10 },
  okText: { flex: 1, fontSize: 11.5, color: '#046C4E', fontWeight: '600', lineHeight: 16 },

  statRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  statCard: { flex: 1, backgroundColor: C.bg, borderRadius: 12, borderWidth: 1, borderColor: C.border, paddingVertical: 11, paddingHorizontal: 6, alignItems: 'center' },
  statN: { fontSize: 17, fontWeight: '800' },
  statL: { fontSize: 9.5, color: C.textMuted, marginTop: 2, fontWeight: '700', textAlign: 'center' },

  copyBox: { borderWidth: 1, borderColor: C.border, borderRadius: 12, marginTop: 12, overflow: 'hidden' },
  copyBoxHead: { backgroundColor: C.bgSoft, paddingHorizontal: 10, paddingVertical: 7, fontSize: 9.5, fontWeight: '800', color: C.textMuted, letterSpacing: 0.6 },
  copyTitle: { fontSize: 13.5, fontWeight: '800', color: C.ink },
  copyBody: { fontSize: 12.5, color: C.textMuted, marginTop: 4, lineHeight: 18 },
  copyRoute: { fontSize: 10.5, color: C.blueDeep, marginTop: 7, fontWeight: '700' },
  copyNote: { fontSize: 10.5, color: C.textFaint, marginTop: 8, lineHeight: 15 },

  exclBox: { borderWidth: 1, borderColor: C.border, borderRadius: 12, marginTop: 12, overflow: 'hidden' },
  exclHead: { backgroundColor: C.bgSoft, paddingHorizontal: 10, paddingVertical: 7, fontSize: 9.5, fontWeight: '800', color: C.textMuted, letterSpacing: 0.6 },
  exclRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  exclRowLast: { borderBottomWidth: 0 },
  exclLabel: { flex: 1, fontSize: 11.5, color: C.textMuted, lineHeight: 16 },
  exclN: { fontSize: 12.5, fontWeight: '800', color: C.ink },

  emptyBox: { alignItems: 'center', justifyContent: 'center', paddingVertical: 28, gap: 9 },
  emptyText: { fontSize: 12.5, color: C.textMuted, fontWeight: '600', textAlign: 'center', paddingHorizontal: 20 },
  emptySub: { fontSize: 11, color: C.rose, textAlign: 'center', paddingHorizontal: 20 },
  emptyInline: { fontSize: 12.5, color: C.textMuted, textAlign: 'center', paddingVertical: 30 },

  // denied
  deniedWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 26, gap: 12 },
  deniedTitle: { fontSize: 19, fontWeight: '800', color: C.ink },
  deniedSub: { fontSize: 12, color: C.textMuted, textAlign: 'center', lineHeight: 18 },

  // sheet (template picker)
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(6,10,25,0.45)' },
  sheet: { backgroundColor: C.bg, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingTop: 8, maxHeight: '88%' },
  sheetGrip: { alignSelf: 'center', width: 40, height: 4, borderRadius: 100, backgroundColor: C.borderHi, marginBottom: 10 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  sheetTitle: { fontSize: 16, fontWeight: '800', color: C.ink },
  sheetSub: { fontSize: 11.5, color: C.textMuted, marginTop: 1 },
  sheetClose: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  sectionLabel: { fontSize: 11, fontWeight: '800', color: C.textFaint, letterSpacing: 0.8, paddingHorizontal: 16, marginTop: 16, marginBottom: 8 },

  tplRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 12 },
  tplRowActive: { borderColor: C.blueDeep, backgroundColor: 'rgba(37,99,235,0.05)' },
  tplTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tplLabel: { fontSize: 13.5, fontWeight: '800', color: C.ink, flexShrink: 1 },
  relPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 100 },
  relPillText: { fontSize: 9, fontWeight: '800' },
  tplDesc: { fontSize: 11.5, color: C.textMuted, marginTop: 3, lineHeight: 16 },
  tplReason: { fontSize: 10.5, color: C.textFaint, marginTop: 3, lineHeight: 15 },
  tplRoute: { fontSize: 10, color: C.blueDeep, marginTop: 5, fontWeight: '700' },
  hiddenRow: { flexDirection: 'row', gap: 6 },
  hiddenText: { flex: 1, fontSize: 11, color: C.textMuted, lineHeight: 16 },
});
