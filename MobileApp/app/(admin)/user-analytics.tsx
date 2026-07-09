// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Admin-only NATIVE "User Analytics" screen. Light theme. A searchable list of recent user / device
// journeys; tapping one opens a bottom-sheet with that person's full event timeline (oldest→newest),
// an event rollup, profile completeness, and store purchases. Wired to GET /api/admin/user-journeys
// and GET /api/admin/user-timeline (authenticateAdmin).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  SafeAreaView, RefreshControl, TextInput, Modal, Pressable, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import {
  fetchUserJourneys, fetchUserTimeline,
  type UserJourney, type UserTimeline, type TimelineEvent,
} from '../../services/aiHubService';

// ─── tokens (shared with store-analytics.tsx) ───
const C = {
  bg: '#E5EAF3', bgSoft: '#DCE2ED', surface: '#FFFFFF', ink: '#0B0F22', inkSoft: '#1A2046',
  textMuted: '#5B6B8A', textFaint: '#8896B0', border: 'rgba(11,15,34,0.06)', borderHi: 'rgba(11,15,34,0.10)',
  blue: '#4F8DFF', blueDeep: '#2563EB', purple: '#7C6BFF', teal: '#14B8A6', emerald: '#10B981',
  amber: '#F59E0B', rose: '#EF4444',
};

const fmt = (x?: number) => (x == null || isNaN(x) ? '0' : Math.round(x).toLocaleString('en-US'));
function timeAgo(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
function clock(iso?: string): string {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleString('en-US', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
const initials = (name?: string | null, email?: string | null, uid?: string) => {
  const src = (name && name.trim()) || email || uid || '?';
  const parts = String(src).trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return String(src).slice(0, 2).toUpperCase();
};

// ─── event → icon / label / color ───
type EvMeta = { icon: any; label: string; color: string };
const EVENTS: Record<string, EvMeta> = {
  signup:                { icon: 'person-add',        label: 'Signed up',            color: C.emerald },
  login:                 { icon: 'log-in',            label: 'Logged in',            color: C.blue },
  login_failed:          { icon: 'alert-circle',      label: 'Login failed',         color: C.rose },
  app_open:              { icon: 'phone-portrait',    label: 'Opened app',           color: C.teal },
  foreground:            { icon: 'sunny',             label: 'Resumed app',          color: C.teal },
  resume_uploaded:       { icon: 'document-text',     label: 'Uploaded resume',      color: C.purple },
  photo_uploaded:        { icon: 'image',             label: 'Uploaded photo',       color: C.purple },
  signature_uploaded:    { icon: 'create',            label: 'Added signature',      color: C.purple },
  profile_updated:       { icon: 'person',            label: 'Updated profile',      color: C.blue },
  job_search:            { icon: 'search',            label: 'Searched jobs',        color: C.blue },
  apply_complete:        { icon: 'checkmark-done',    label: 'Applied to a job',     color: C.emerald },
  cover_letter_generate: { icon: 'document-attach',   label: 'Generated cover letter', color: C.purple },
  screen_view:           { icon: 'eye',               label: 'Viewed a screen',      color: C.textMuted },
  onboarding_step:       { icon: 'footsteps',         label: 'Onboarding step',      color: C.amber },
  onboarding_dismiss:    { icon: 'close-circle',      label: 'Dismissed onboarding', color: C.textMuted },
  purchase:              { icon: 'cash',              label: 'Purchase',             color: C.emerald },
  uninstall:             { icon: 'trash',             label: 'Uninstalled',          color: C.rose },
};
const evMeta = (e: string): EvMeta =>
  EVENTS[e] || { icon: 'ellipse', label: e.replace(/_/g, ' '), color: C.textFaint };

// pull a short human detail out of an event's props (provider, screen, company, etc.)
function evDetail(ev: TimelineEvent): string {
  const p = ev.props || {};
  const bits: string[] = [];
  if (p.provider) bits.push(String(p.provider));
  if (p.method && !p.provider) bits.push(String(p.method));
  if (p.screen) bits.push(String(p.screen));
  if (p.company) bits.push(String(p.company));
  if (p.count != null) bits.push(`${p.count} results`);
  if (p.step) bits.push(String(p.step));
  const extra = [ev.platform, ev.app_version ? `v${ev.app_version}` : null].filter(Boolean).join(' · ');
  const main = bits.join(' · ');
  return [main, extra].filter(Boolean).join('  ·  ');
}

const provColor = (p?: string | null) =>
  p === 'google' ? '#DB4437' : p === 'microsoft' ? '#2563EB' : p === 'apple' ? '#0B0F22'
    : p === 'email' ? C.teal : C.blue;
const provLabel = (p?: string | null) =>
  p === 'google' ? 'Gmail' : p === 'microsoft' ? 'Microsoft' : p === 'apple' ? 'Apple'
    : p === 'email' ? 'Email' : (p || null);

// ─── journey row ───
function JourneyCard({ j, onPress }: { j: UserJourney; onPress: () => void }) {
  const isUser = !!j.user_id;
  const name = j.full_name || (isUser ? 'Registered user' : 'Anonymous visitor');
  const sub = j.email || (isUser ? `user #${j.user_id}` : j.uid);
  const pv = provLabel(j.provider);
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.85}>
      <LinearGradient
        colors={isUser ? [C.blue, C.blueDeep] : ['#94A3B8', '#64748B']}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.avatar}
      >
        {isUser
          ? <Text style={styles.avatarText}>{initials(j.full_name, j.email, j.uid)}</Text>
          : <Ionicons name="eye-off-outline" size={17} color="#fff" />}
      </LinearGradient>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.name} numberOfLines={1}>{name}</Text>
          {pv && <View style={[styles.tinyBadge, { backgroundColor: provColor(j.provider) + '18' }]}>
            <Text style={[styles.tinyBadgeText, { color: provColor(j.provider) }]}>{pv}</Text>
          </View>}
        </View>
        <Text style={styles.sub} numberOfLines={1}>{sub}</Text>
        <View style={styles.jMeta}>
          <View style={styles.jMetaItem}><Ionicons name="pulse-outline" size={11} color={C.textMuted} /><Text style={styles.jMetaText}>{fmt(j.events)} events</Text></View>
          {!!j.platform && <View style={styles.jMetaItem}><Ionicons name={j.platform === 'ios' ? 'logo-apple' : j.platform === 'android' ? 'logo-android' : 'globe-outline'} size={11} color={C.textMuted} /><Text style={styles.jMetaText}>{j.platform}</Text></View>}
          {!!j.country && <View style={styles.jMetaItem}><Ionicons name="location-outline" size={11} color={C.textMuted} /><Text style={styles.jMetaText}>{j.country}</Text></View>}
          <View style={styles.jMetaItem}><Ionicons name="time-outline" size={11} color={C.textMuted} /><Text style={styles.jMetaText}>{timeAgo(j.last_seen)}</Text></View>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={18} color={C.textFaint} />
    </TouchableOpacity>
  );
}

// ─── timeline sheet ───
function TimelineSheet({ journey, onClose }: { journey: UserJourney | null; onClose: () => void }) {
  const [data, setData] = useState<UserTimeline | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!journey) { setData(null); return; }
    let alive = true;
    (async () => {
      setLoading(true); setErr(false); setData(null);
      try {
        const d = await fetchUserTimeline({ userId: journey.user_id || undefined, anonId: journey.user_id ? undefined : journey.uid, limit: 300 });
        if (alive) setData(d);
      } catch { if (alive) setErr(true); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [journey]);

  const isUser = !!(journey && journey.user_id);
  const title = journey ? (journey.full_name || journey.email || (isUser ? `User #${journey.user_id}` : 'Anonymous visitor')) : '';
  const profile = data?.profile;
  const profileScore = profile
    ? [profile.has_resume, profile.has_photo, profile.has_signature].filter(Boolean).length
    : 0;

  return (
    <Modal visible={!!journey} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetOverlay}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.sheetGrip} />
          {/* header */}
          <View style={styles.sheetHeader}>
            <LinearGradient colors={isUser ? [C.blue, C.blueDeep] : ['#94A3B8', '#64748B']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.sheetAvatar}>
              {isUser
                ? <Text style={[styles.avatarText, { fontSize: 15 }]}>{initials(journey?.full_name, journey?.email, journey?.uid)}</Text>
                : <Ionicons name="eye-off-outline" size={19} color="#fff" />}
            </LinearGradient>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.sheetTitle} numberOfLines={1}>{title}</Text>
              {!!journey?.email && <Text style={styles.sheetSub} numberOfLines={1}>{journey.email}</Text>}
            </View>
            <TouchableOpacity onPress={onClose} style={styles.sheetClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={18} color={C.ink} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={{ paddingVertical: 60, alignItems: 'center' }}><ActivityIndicator color={C.blue} size="large" /></View>
          ) : err ? (
            <View style={{ paddingVertical: 50, alignItems: 'center', gap: 10 }}>
              <Ionicons name="warning-outline" size={30} color={C.rose} />
              <Text style={{ color: C.textMuted, fontWeight: '600' }}>Couldn’t load this timeline.</Text>
            </View>
          ) : (
            <ScrollView style={{ maxHeight: '100%' }} contentContainerStyle={{ paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
              {/* profile / summary strip */}
              <View style={styles.summaryRow}>
                <View style={styles.summaryCell}>
                  <Text style={styles.summaryN}>{fmt(data?.events?.length || 0)}</Text>
                  <Text style={styles.summaryL}>Events</Text>
                </View>
                <View style={styles.summaryCell}>
                  <Text style={styles.summaryN}>{fmt(data?.rollup?.length || 0)}</Text>
                  <Text style={styles.summaryL}>Event types</Text>
                </View>
                {isUser && (
                  <View style={styles.summaryCell}>
                    <Text style={[styles.summaryN, profileScore === 3 && { color: C.emerald }]}>{profileScore}/3</Text>
                    <Text style={styles.summaryL}>Assets</Text>
                  </View>
                )}
                {data && data.purchases && data.purchases.length > 0 && (
                  <View style={styles.summaryCell}>
                    <Text style={[styles.summaryN, { color: C.emerald }]}>{fmt(data.purchases.length)}</Text>
                    <Text style={styles.summaryL}>Purchases</Text>
                  </View>
                )}
              </View>

              {/* asset chips for registered users */}
              {isUser && profile && (
                <View style={styles.assetRow}>
                  {([['Resume', profile.has_resume], ['Photo', profile.has_photo], ['Signature', profile.has_signature]] as [string, boolean | undefined][]).map(([label, on]) => (
                    <View key={label} style={[styles.assetChip, on ? styles.assetOn : styles.assetOff]}>
                      <Ionicons name={on ? 'checkmark-circle' : 'ellipse-outline'} size={12} color={on ? C.emerald : C.textFaint} />
                      <Text style={[styles.assetText, { color: on ? C.emerald : C.textFaint }]}>{label}</Text>
                    </View>
                  ))}
                </View>
              )}

              {/* rollup chips */}
              {data && data.rollup && data.rollup.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 4 }} contentContainerStyle={{ gap: 7, paddingHorizontal: 16, paddingVertical: 8 }}>
                  {data.rollup.map((r) => {
                    const m = evMeta(r.event);
                    return (
                      <View key={r.event} style={[styles.rollupChip, { backgroundColor: m.color + '12' }]}>
                        <Ionicons name={m.icon} size={12} color={m.color} />
                        <Text style={[styles.rollupLabel, { color: m.color }]}>{m.label}</Text>
                        <Text style={styles.rollupN}>{fmt(r.n)}</Text>
                      </View>
                    );
                  })}
                </ScrollView>
              )}

              {/* timeline */}
              <Text style={styles.sectionLabel}>ACTIVITY TIMELINE</Text>
              <View style={{ paddingHorizontal: 16 }}>
                {(data?.events || []).slice().reverse().map((ev, idx, arr) => {
                  const m = evMeta(ev.event);
                  const detail = evDetail(ev);
                  const last = idx === arr.length - 1;
                  return (
                    <View key={ev.id} style={styles.tlRow}>
                      <View style={styles.tlRail}>
                        <View style={[styles.tlDot, { backgroundColor: m.color }]}>
                          <Ionicons name={m.icon} size={11} color="#fff" />
                        </View>
                        {!last && <View style={styles.tlLine} />}
                      </View>
                      <View style={styles.tlBody}>
                        <Text style={styles.tlLabel}>{m.label}</Text>
                        {!!detail && <Text style={styles.tlDetail} numberOfLines={2}>{detail}</Text>}
                        <Text style={styles.tlTime}>{clock(ev.created_at)}</Text>
                      </View>
                    </View>
                  );
                })}
                {(!data?.events || data.events.length === 0) && (
                  <Text style={{ color: C.textMuted, fontSize: 13, paddingVertical: 20, textAlign: 'center' }}>No events recorded.</Text>
                )}
              </View>

              {/* purchases */}
              {data && data.purchases && data.purchases.length > 0 && (
                <>
                  <Text style={styles.sectionLabel}>PURCHASES</Text>
                  <View style={{ paddingHorizontal: 16, gap: 8 }}>
                    {data.purchases.map((p, i) => (
                      <View key={i} style={styles.purchaseRow}>
                        <Ionicons name={p.store === 'apple' ? 'logo-apple' : 'logo-google-playstore'} size={16} color={C.ink} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.purchaseTitle}>{p.product_id || p.event}</Text>
                          <Text style={styles.purchaseSub}>{clock(p.created_at)}</Text>
                        </View>
                        {p.price != null && <Text style={styles.purchasePrice}>{p.currency || ''} {p.price}</Text>}
                      </View>
                    ))}
                  </View>
                </>
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

export default function UserAnalyticsScreen() {
  const router = useRouter();
  const [journeys, setJourneys] = useState<UserJourney[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<UserJourney | null>(null);
  const searchSeq = useRef(0);

  const load = useCallback(async (q: string) => {
    const seq = ++searchSeq.current;
    try {
      const d = await fetchUserJourneys({ q, limit: 80 });
      if (seq !== searchSeq.current) return;
      setError(null);
      setJourneys(d.users || []);
    } catch {
      if (seq !== searchSeq.current) return;
      setError('Could not load journeys. Pull to retry.');
      setJourneys([]);
    }
  }, []);

  useEffect(() => {
    (async () => { setLoading(true); await load(''); setLoading(false); })();
  }, [load]);

  useEffect(() => {
    const t = setTimeout(async () => { setLoading(true); await load(query.trim()); setLoading(false); }, 350);
    return () => clearTimeout(t);
  }, [query, load]);

  const onRefresh = useCallback(async () => { setRefreshing(true); await load(query.trim()); setRefreshing(false); }, [query, load]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={22} color={C.ink} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.hTitle}>User Analytics</Text>
          <Text style={styles.hSub}>Per-user journey timelines</Text>
        </View>
        <View style={styles.hIcon}>
          <Ionicons name="compass" size={18} color={C.purple} />
        </View>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={C.textFaint} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search name or email"
          placeholderTextColor={C.textFaint}
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={17} color={C.textFaint} />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={C.blue} size="large" /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 14, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.blue} />}
        >
          {error && (
            <View style={styles.errorBox}>
              <Ionicons name="warning-outline" size={16} color={C.rose} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
          {journeys.length === 0 && !error ? (
            <View style={styles.empty}>
              <Ionicons name="compass-outline" size={40} color={C.textFaint} />
              <Text style={styles.emptyText}>{query ? 'No journeys match your search.' : 'No user activity recorded yet.'}</Text>
            </View>
          ) : (
            journeys.map((j) => <JourneyCard key={j.uid} j={j} onPress={() => setSelected(j)} />)
          )}
        </ScrollView>
      )}

      <TimelineSheet journey={selected} onClose={() => setSelected(null)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'android' ? 28 : 0 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12 },
  backBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  hTitle: { fontSize: 20, fontWeight: '800', color: C.ink, letterSpacing: -0.4 },
  hSub: { fontSize: 12, color: C.textMuted, marginTop: 1 },
  hIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.purple + '15', alignItems: 'center', justifyContent: 'center' },

  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginBottom: 4, paddingHorizontal: 12, height: 44, borderRadius: 14, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  searchInput: { flex: 1, fontSize: 14, color: C.ink, padding: 0 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.surface, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 13, marginBottom: 10, shadowColor: '#0F172A', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.05, shadowRadius: 14, elevation: 2 },
  avatar: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  name: { fontSize: 14.5, fontWeight: '700', color: C.ink, flexShrink: 1 },
  sub: { fontSize: 11.5, color: C.textMuted, marginTop: 1 },
  tinyBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 100 },
  tinyBadgeText: { fontSize: 9.5, fontWeight: '800' },
  jMeta: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 5, flexWrap: 'wrap' },
  jMetaItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  jMetaText: { fontSize: 10.5, color: C.textMuted, fontWeight: '600' },

  errorBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: 12, padding: 12, marginBottom: 12 },
  errorText: { fontSize: 12.5, color: C.rose, fontWeight: '600', flex: 1 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 13.5, color: C.textMuted, fontWeight: '600', textAlign: 'center', paddingHorizontal: 30 },

  // sheet
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(6,10,25,0.45)' },
  sheet: { backgroundColor: C.bg, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingTop: 8, maxHeight: '88%' },
  sheetGrip: { alignSelf: 'center', width: 40, height: 4, borderRadius: 100, backgroundColor: C.borderHi, marginBottom: 10 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  sheetAvatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sheetTitle: { fontSize: 16, fontWeight: '800', color: C.ink },
  sheetSub: { fontSize: 12, color: C.textMuted, marginTop: 1 },
  sheetClose: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },

  summaryRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 14 },
  summaryCell: { flex: 1, backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.border, paddingVertical: 12, alignItems: 'center' },
  summaryN: { fontSize: 18, fontWeight: '800', color: C.ink },
  summaryL: { fontSize: 10, color: C.textMuted, marginTop: 2, fontWeight: '600' },

  assetRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginTop: 10 },
  assetChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 100, borderWidth: 1 },
  assetOn: { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.25)' },
  assetOff: { backgroundColor: C.surface, borderColor: C.border },
  assetText: { fontSize: 11.5, fontWeight: '700' },

  rollupChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 100 },
  rollupLabel: { fontSize: 11.5, fontWeight: '700' },
  rollupN: { fontSize: 11.5, fontWeight: '800', color: C.ink, marginLeft: 1 },

  sectionLabel: { fontSize: 11, fontWeight: '800', color: C.textFaint, letterSpacing: 0.8, paddingHorizontal: 16, marginTop: 18, marginBottom: 10 },

  tlRow: { flexDirection: 'row', gap: 12 },
  tlRail: { alignItems: 'center', width: 24 },
  tlDot: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  tlLine: { width: 2, flex: 1, minHeight: 14, backgroundColor: C.borderHi, marginVertical: 2 },
  tlBody: { flex: 1, paddingBottom: 16 },
  tlLabel: { fontSize: 13.5, fontWeight: '700', color: C.ink },
  tlDetail: { fontSize: 11.5, color: C.textMuted, marginTop: 2 },
  tlTime: { fontSize: 10.5, color: C.textFaint, marginTop: 3, fontWeight: '600' },

  purchaseRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.surface, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 12 },
  purchaseTitle: { fontSize: 13, fontWeight: '700', color: C.ink },
  purchaseSub: { fontSize: 11, color: C.textMuted, marginTop: 1 },
  purchasePrice: { fontSize: 13, fontWeight: '800', color: C.emerald },
});
