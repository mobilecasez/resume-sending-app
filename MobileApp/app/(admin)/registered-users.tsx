// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Admin-only NATIVE "Registered Users" screen. Light theme. Searchable + paginated list of every
// signed-up user with their sign-in type (Gmail / Microsoft / Apple / Email), registration date,
// profile-completion progress, and per-user usage (searches, cover letters, applications, replies,
// credits). Provider summary chips up top. Wired to GET /api/admin/users-list (authenticateAdmin).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  SafeAreaView, RefreshControl, TextInput, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { fetchUsersList, type RegisteredUser } from '../../services/aiHubService';

// ─── tokens (shared with store-analytics.tsx) ───
const C = {
  bg: '#E5EAF3', bgSoft: '#DCE2ED', surface: '#FFFFFF', ink: '#0B0F22', inkSoft: '#1A2046',
  textMuted: '#5B6B8A', textFaint: '#8896B0', border: 'rgba(11,15,34,0.06)', borderHi: 'rgba(11,15,34,0.10)',
  blue: '#4F8DFF', blueDeep: '#2563EB', purple: '#7C6BFF', teal: '#14B8A6', emerald: '#10B981',
  amber: '#F59E0B', rose: '#EF4444',
};
const PAGE = 40;

type Provider = 'Gmail' | 'Microsoft' | 'Apple' | 'Email';
const PROVIDERS: { key: Provider; icon: any; color: string; grad: [string, string] }[] = [
  { key: 'Gmail',     icon: 'logo-google',    color: '#DB4437', grad: ['#EA4335', '#DB4437'] },
  { key: 'Microsoft', icon: 'logo-microsoft', color: '#2563EB', grad: ['#2F6FED', '#1E5BD6'] },
  { key: 'Apple',     icon: 'logo-apple',     color: '#0B0F22', grad: ['#333844', '#0B0F22'] },
  { key: 'Email',     icon: 'mail-outline',   color: '#14B8A6', grad: ['#14B8A6', '#0E9488'] },
];
const provMeta = (p?: string) => PROVIDERS.find((x) => x.key === p) || PROVIDERS[3];

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
function dateLabel(iso?: string): string {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}
const initials = (name?: string | null, email?: string) => {
  const src = (name && name.trim()) || (email || '?');
  const parts = src.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
};

// ─── usage stat cell ───
function Stat({ icon, label, value, color }: { icon: any; label: string; value: number; color: string }) {
  return (
    <View style={styles.stat}>
      <View style={[styles.statIcon, { backgroundColor: color + '18' }]}>
        <Ionicons name={icon} size={13} color={color} />
      </View>
      <Text style={styles.statValue}>{fmt(value)}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ─── one user card ───
function CopiedTag() {
  return (
    <View style={styles.copiedTag}>
      <Ionicons name="checkmark" size={10} color="#fff" />
      <Text style={styles.copiedTagText}>Copied</Text>
    </View>
  );
}

function UserCard({ u }: { u: RegisteredUser }) {
  const pm = provMeta(u.auth_type);
  const pct = Math.round((Math.min(u.profile_complete, 6) / 6) * 100);
  const [copied, setCopied] = useState<'name' | 'email' | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const copy = useCallback(async (field: 'name' | 'email', value: string) => {
    if (!value) return;
    try { await Clipboard.setStringAsync(value); } catch { /* clipboard unavailable */ }
    try { Haptics.selectionAsync(); } catch { /* haptics optional */ }
    setCopied(field);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1400);
  }, []);
  const displayName = u.full_name || 'Unnamed user';
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <LinearGradient colors={pm.grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(u.full_name, u.email)}</Text>
        </LinearGradient>
        <View style={{ flex: 1, minWidth: 0 }}>
          <TouchableOpacity activeOpacity={0.6} onPress={() => copy('name', u.full_name || u.email)} style={styles.copyRow}>
            <Text style={[styles.name, { flexShrink: 1 }]} numberOfLines={1}>{displayName}</Text>
            {copied === 'name' ? <CopiedTag /> : <Ionicons name="copy-outline" size={12} color={C.textFaint} />}
          </TouchableOpacity>
          <TouchableOpacity activeOpacity={0.6} onPress={() => copy('email', u.email)} style={styles.copyRow}>
            <Text style={[styles.email, { flexShrink: 1 }]} numberOfLines={1}>{u.email}</Text>
            {copied === 'email' ? <CopiedTag /> : <Ionicons name="copy-outline" size={11} color={C.textFaint} />}
          </TouchableOpacity>
        </View>
        <View style={[styles.provBadge, { backgroundColor: pm.color + '15' }]}>
          <Ionicons name={pm.icon} size={12} color={pm.color} />
          <Text style={[styles.provBadgeText, { color: pm.color }]}>{u.auth_type}</Text>
        </View>
      </View>

      <View style={styles.metaRow}>
        <View style={styles.metaChip}>
          <Ionicons name="calendar-outline" size={11} color={C.textMuted} />
          <Text style={styles.metaText}>{dateLabel(u.registered_at)} · {timeAgo(u.registered_at)}</Text>
        </View>
        <View style={[styles.metaChip, { backgroundColor: 'rgba(245,158,11,0.12)' }]}>
          <Ionicons name="diamond-outline" size={11} color={C.amber} />
          <Text style={[styles.metaText, { color: C.amber, fontWeight: '800' }]}>{fmt(u.credits)} credits</Text>
        </View>
      </View>

      {/* profile completion */}
      <View style={styles.profileRow}>
        <Text style={styles.profileLabel}>Profile</Text>
        <View style={styles.progressTrack}>
          <LinearGradient
            colors={pct === 100 ? [C.emerald, '#059669'] : [C.blue, C.blueDeep]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            style={[styles.progressFill, { width: `${Math.max(pct, 4)}%` }]}
          />
        </View>
        <Text style={[styles.profilePct, pct === 100 && { color: C.emerald }]}>{u.profile_complete}/6</Text>
      </View>

      {/* usage stats */}
      <View style={styles.statsGrid}>
        <Stat icon="search-outline"        label="Searches" value={u.job_searches}  color={C.blue} />
        <Stat icon="document-text-outline" label="Letters"  value={u.cover_letters} color={C.purple} />
        <Stat icon="send-outline"          label="Applied"  value={u.applications}  color={C.teal} />
        <Stat icon="mail-open-outline"     label="Replies"  value={u.replies}       color={C.emerald} />
      </View>
    </View>
  );
}

export default function RegisteredUsersScreen() {
  const router = useRouter();
  const [users, setUsers] = useState<RegisteredUser[]>([]);
  const [byProvider, setByProvider] = useState<{ auth_type: string; n: number }[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const searchSeq = useRef(0);

  const load = useCallback(async (opts: { q: string; offset: number; append: boolean }) => {
    const seq = ++searchSeq.current;
    try {
      const data = await fetchUsersList({ q: opts.q, limit: PAGE, offset: opts.offset });
      if (seq !== searchSeq.current) return; // a newer request superseded this one
      setError(null);
      setTotal(data.total || 0);
      setByProvider(data.byProvider || []);
      setUsers((prev) => (opts.append ? [...prev, ...(data.users || [])] : (data.users || [])));
    } catch (e: any) {
      if (seq !== searchSeq.current) return;
      setError('Could not load users. Pull to retry.');
      if (!opts.append) setUsers([]);
    }
  }, []);

  // initial load
  useEffect(() => {
    (async () => { setLoading(true); await load({ q: '', offset: 0, append: false }); setLoading(false); })();
  }, [load]);

  // debounced search
  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true);
      await load({ q: query.trim(), offset: 0, append: false });
      setLoading(false);
    }, 350);
    return () => clearTimeout(t);
  }, [query, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load({ q: query.trim(), offset: 0, append: false });
    setRefreshing(false);
  }, [query, load]);

  const onLoadMore = useCallback(async () => {
    if (loadingMore || users.length >= total) return;
    setLoadingMore(true);
    await load({ q: query.trim(), offset: users.length, append: true });
    setLoadingMore(false);
  }, [loadingMore, users.length, total, query, load]);

  const providerCounts = useMemo(() => {
    const map: Record<string, number> = {};
    byProvider.forEach((r) => { map[r.auth_type] = r.n; });
    return map;
  }, [byProvider]);

  return (
    <SafeAreaView style={styles.safe}>
      {/* header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={22} color={C.ink} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.hTitle}>Registered Users</Text>
          <Text style={styles.hSub}>{fmt(total)} total · sign-in type & usage</Text>
        </View>
        <View style={styles.hIcon}>
          <Ionicons name="people" size={18} color={C.blue} />
        </View>
      </View>

      {/* search */}
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
          onMomentumScrollEnd={(e) => {
            const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
            if (layoutMeasurement.height + contentOffset.y >= contentSize.height - 240) onLoadMore();
          }}
          scrollEventThrottle={16}
        >
          {/* provider summary chips */}
          {!query && byProvider.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
              {PROVIDERS.map((p) => (
                <View key={p.key} style={styles.provStat}>
                  <View style={[styles.provStatIcon, { backgroundColor: p.color + '15' }]}>
                    <Ionicons name={p.icon} size={13} color={p.color} />
                  </View>
                  <Text style={styles.provStatN}>{fmt(providerCounts[p.key] || 0)}</Text>
                  <Text style={styles.provStatLabel}>{p.key}</Text>
                </View>
              ))}
            </ScrollView>
          )}

          {error && (
            <View style={styles.errorBox}>
              <Ionicons name="warning-outline" size={16} color={C.rose} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {users.length === 0 && !error ? (
            <View style={styles.empty}>
              <Ionicons name="people-outline" size={40} color={C.textFaint} />
              <Text style={styles.emptyText}>{query ? 'No users match your search.' : 'No registered users yet.'}</Text>
            </View>
          ) : (
            users.map((u) => <UserCard key={u.id} u={u} />)
          )}

          {users.length > 0 && users.length < total && (
            <TouchableOpacity style={styles.loadMore} onPress={onLoadMore} disabled={loadingMore} activeOpacity={0.8}>
              {loadingMore
                ? <ActivityIndicator color={C.blue} />
                : <Text style={styles.loadMoreText}>Load more · {fmt(total - users.length)} left</Text>}
            </TouchableOpacity>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'android' ? 28 : 0 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12 },
  backBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  hTitle: { fontSize: 20, fontWeight: '800', color: C.ink, letterSpacing: -0.4 },
  hSub: { fontSize: 12, color: C.textMuted, marginTop: 1 },
  hIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.blue + '15', alignItems: 'center', justifyContent: 'center' },

  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginBottom: 4, paddingHorizontal: 12, height: 44, borderRadius: 14, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  searchInput: { flex: 1, fontSize: 14, color: C.ink, padding: 0 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  provStat: { alignItems: 'center', backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.border, paddingVertical: 10, paddingHorizontal: 14, minWidth: 76 },
  provStatIcon: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginBottom: 5 },
  provStatN: { fontSize: 17, fontWeight: '800', color: C.ink },
  provStatLabel: { fontSize: 10.5, color: C.textMuted, marginTop: 1, fontWeight: '600' },

  card: { backgroundColor: C.surface, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 14, marginBottom: 11, shadowColor: '#0F172A', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.05, shadowRadius: 14, elevation: 2 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  avatar: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  name: { fontSize: 15, fontWeight: '700', color: C.ink },
  email: { fontSize: 12, color: C.textMuted },
  copyRow: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 2 },
  copiedTag: { flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: C.emerald, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 100 },
  copiedTagText: { color: '#fff', fontSize: 9.5, fontWeight: '800' },
  provBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 100 },
  provBadgeText: { fontSize: 11, fontWeight: '800' },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  metaChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.bgSoft, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 100 },
  metaText: { fontSize: 11, color: C.textMuted, fontWeight: '600' },

  profileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  profileLabel: { fontSize: 11.5, color: C.textMuted, fontWeight: '700', width: 46 },
  progressTrack: { flex: 1, height: 7, borderRadius: 100, backgroundColor: C.bgSoft, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 100 },
  profilePct: { fontSize: 12, fontWeight: '800', color: C.blueDeep, width: 30, textAlign: 'right' },

  statsGrid: { flexDirection: 'row', gap: 8, marginTop: 14 },
  stat: { flex: 1, alignItems: 'center', backgroundColor: C.bg, borderRadius: 12, paddingVertical: 9 },
  statIcon: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginBottom: 5 },
  statValue: { fontSize: 15, fontWeight: '800', color: C.ink },
  statLabel: { fontSize: 9.5, color: C.textMuted, marginTop: 1, fontWeight: '600' },

  loadMore: { marginTop: 6, backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.border, paddingVertical: 14, alignItems: 'center' },
  loadMoreText: { fontSize: 13.5, fontWeight: '700', color: C.blueDeep },

  errorBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: 12, padding: 12, marginBottom: 12 },
  errorText: { fontSize: 12.5, color: C.rose, fontWeight: '600', flex: 1 },

  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 13.5, color: C.textMuted, fontWeight: '600' },
});
