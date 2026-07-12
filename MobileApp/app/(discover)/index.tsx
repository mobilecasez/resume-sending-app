// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Value-first job feed: a newly-registered user lands here and browses REAL jobs from top companies
// (the global_jobs firehose) immediately — no résumé/profile required first. Search, filter chips,
// infinite scroll; "Apply" opens the employer's own posting. Backed by GET /api/discover/jobs.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput, ActivityIndicator,
  SafeAreaView, RefreshControl, Linking, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import {
  fetchDiscoverJobs, fetchDiscoverFacets,
  type DiscoverJob, type DiscoverFacets,
} from '../../services/aiHubService';
import { logEvent } from '../../services/firebaseAnalytics';

const C = {
  navy: '#0B1120', feed: '#F0F4FA', card: '#FFFFFF', ink: '#0B1120', muted: '#5B6B8A', faint: '#8896B0',
  border: '#E2E8F0', cyan: '#06B6D4', blue: '#3B82F6', violet: '#8B5CF6', emerald: '#10B981', amber: '#F59E0B',
};
const PAGE = 20;
const AV = ['#06B6D4', '#3B82F6', '#8B5CF6', '#10B981', '#F59E0B', '#EF4444', '#EC4899', '#14B8A6'];
const colorFor = (s: string) => { let h = 0; const k = s || 'x'; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return AV[h % AV.length]; };
const initial = (s?: string | null) => (s || '?').trim().charAt(0).toUpperCase();
const fmt = (n: number) => (n || 0).toLocaleString('en-US');

const MODES = ['Remote', 'Hybrid', 'Onsite'];

function Chips({ meta }: { meta: (string | null | undefined)[] }) {
  const items = meta.filter(Boolean) as string[];
  if (!items.length) return null;
  return (
    <View style={styles.chipRow}>
      {items.slice(0, 3).map((m, i) => (
        <View key={i} style={styles.metaChip}><Text style={styles.metaChipText} numberOfLines={1}>{m}</Text></View>
      ))}
    </View>
  );
}

function JobCard({ job, onApply }: { job: DiscoverJob; onApply: (j: DiscoverJob) => void }) {
  const col = colorFor(job.employer_name || job.title);
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <LinearGradient colors={[col, col + 'cc']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.avatar}>
          <Text style={styles.avatarText}>{initial(job.employer_name)}</Text>
        </LinearGradient>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.jobTitle} numberOfLines={2}>{job.title}</Text>
          <Text style={styles.jobCompany} numberOfLines={1}>
            {job.company || 'Company'}{job.location ? `  ·  ${job.location}` : ''}
          </Text>
        </View>
      </View>
      <Chips meta={[job.work_mode, job.job_type, job.salary]} />
      {Array.isArray(job.skills) && job.skills.length > 0 && (
        <View style={styles.skillRow}>
          {job.skills.slice(0, 4).map((s, i) => (
            <View key={i} style={styles.skillPill}><Text style={styles.skillText} numberOfLines={1}>{s}</Text></View>
          ))}
        </View>
      )}
      <TouchableOpacity style={styles.applyBtn} onPress={() => onApply(job)} activeOpacity={0.85}>
        <LinearGradient colors={[C.cyan, C.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.applyGrad}>
          <Ionicons name="open-outline" size={15} color="#fff" />
          <Text style={styles.applyText}>View & Apply</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

export default function DiscoverScreen() {
  const router = useRouter();
  const [jobs, setJobs] = useState<DiscoverJob[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<string | null>(null);
  const [facets, setFacets] = useState<DiscoverFacets | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (opts: { q: string; mode: string | null; offset: number; append: boolean }) => {
    const my = ++seq.current;
    try {
      const data = await fetchDiscoverJobs({ q: opts.q, work_mode: opts.mode || '', offset: opts.offset, limit: PAGE });
      if (my !== seq.current) return;
      setError(null);
      setTotal(data.total || 0);
      setJobs((prev) => (opts.append ? [...prev, ...(data.jobs || [])] : (data.jobs || [])));
    } catch {
      if (my !== seq.current) return;
      setError('Could not load jobs. Pull to retry.');
      if (!opts.append) setJobs([]);
    }
  }, []);

  useEffect(() => { fetchDiscoverFacets().then(setFacets).catch(() => {}); logEvent('feed_opened'); }, []);
  useEffect(() => {
    (async () => { setLoading(true); await load({ q: '', mode: null, offset: 0, append: false }); setLoading(false); })();
  }, [load]);

  // debounced search / filter
  useEffect(() => {
    const t = setTimeout(async () => { setLoading(true); await load({ q: query.trim(), mode, offset: 0, append: false }); setLoading(false); }, 350);
    return () => clearTimeout(t);
  }, [query, mode, load]);

  const onRefresh = useCallback(async () => { setRefreshing(true); await load({ q: query.trim(), mode, offset: 0, append: false }); setRefreshing(false); }, [query, mode, load]);
  const onEnd = useCallback(async () => {
    if (loadingMore || jobs.length >= total || loading) return;
    setLoadingMore(true);
    await load({ q: query.trim(), mode, offset: jobs.length, append: true });
    setLoadingMore(false);
  }, [loadingMore, jobs.length, total, loading, query, mode, load]);

  const apply = useCallback((j: DiscoverJob) => { if (j.job_url) Linking.openURL(j.job_url).catch(() => {}); }, []);

  const header = useMemo(() => (
    <View>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={C.faint} />
        <TextInput
          value={query} onChangeText={setQuery}
          placeholder="Search role, company or city" placeholderTextColor={C.faint}
          style={styles.searchInput} autoCapitalize="none" autoCorrect={false} returnKeyType="search"
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={17} color={C.faint} />
          </TouchableOpacity>
        )}
      </View>
      <FlatList
        horizontal showsHorizontalScrollIndicator={false} data={MODES} keyExtractor={(m) => m}
        style={styles.chipsScroller} contentContainerStyle={{ gap: 8, paddingRight: 12 }}
        renderItem={({ item }) => {
          const on = mode === item;
          return (
            <TouchableOpacity onPress={() => setMode(on ? null : item)} style={[styles.filterChip, on && styles.filterChipOn]} activeOpacity={0.8}>
              <Text style={[styles.filterChipText, on && styles.filterChipTextOn]}>{item}</Text>
            </TouchableOpacity>
          );
        }}
      />
      <Text style={styles.countLine}>{fmt(total)} {total === 1 ? 'opening' : 'openings'}{mode ? ` · ${mode}` : ''}</Text>
    </View>
  ), [query, mode, total]);

  return (
    <SafeAreaView style={styles.safe}>
      <LinearGradient colors={['#0B1120', '#111a33']} style={styles.headerWrap}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="chevron-back" size={22} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.hTitle}>Explore Jobs</Text>
            <Text style={styles.hSub}>Live openings from top companies{facets ? ` · ${fmt(facets.total)}` : ''}</Text>
          </View>
          <View style={styles.hIcon}><Ionicons name="sparkles" size={17} color={C.cyan} /></View>
        </View>
      </LinearGradient>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={C.blue} size="large" /></View>
      ) : (
        <FlatList
          data={jobs}
          keyExtractor={(j, i) => j.id + ':' + i}
          renderItem={({ item }) => <JobCard job={item} onApply={apply} />}
          ListHeaderComponent={header}
          contentContainerStyle={{ padding: 14, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.blue} />}
          onEndReached={onEnd} onEndReachedThreshold={0.5}
          removeClippedSubviews initialNumToRender={8} windowSize={9}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name={error ? 'cloud-offline-outline' : 'briefcase-outline'} size={40} color={C.faint} />
              <Text style={styles.emptyText}>{error || (query ? 'No jobs match your search.' : 'No jobs yet — check back soon.')}</Text>
            </View>
          }
          ListFooterComponent={loadingMore ? <ActivityIndicator color={C.blue} style={{ marginVertical: 18 }} /> : <View style={{ height: 8 }} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.feed },
  headerWrap: { paddingTop: Platform.OS === 'android' ? 32 : 8, paddingBottom: 16, paddingHorizontal: 14, borderBottomLeftRadius: 22, borderBottomRightRadius: 22 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  backBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.10)', alignItems: 'center', justifyContent: 'center' },
  hTitle: { fontSize: 20, fontWeight: '800', color: '#fff', letterSpacing: -0.3 },
  hSub: { fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 1 },
  hIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: 'rgba(6,182,212,0.15)', alignItems: 'center', justifyContent: 'center' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, paddingHorizontal: 12, height: 46, marginBottom: 10 },
  searchInput: { flex: 1, fontSize: 14, color: C.ink, padding: 0 },
  chipsScroller: { marginBottom: 10, flexGrow: 0 },
  filterChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 100, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  filterChipOn: { backgroundColor: C.blue, borderColor: C.blue },
  filterChipText: { fontSize: 12.5, fontWeight: '700', color: C.muted },
  filterChipTextOn: { color: '#fff' },
  countLine: { fontSize: 12, color: C.muted, fontWeight: '600', marginBottom: 8, marginLeft: 2 },

  card: { backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 14, marginBottom: 12, shadowColor: '#0F172A', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.06, shadowRadius: 16, elevation: 2 },
  cardTop: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  avatar: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '800', fontSize: 18 },
  jobTitle: { fontSize: 15.5, fontWeight: '800', color: C.ink, letterSpacing: -0.2 },
  jobCompany: { fontSize: 12.5, color: C.muted, marginTop: 3, fontWeight: '600' },
  chipRow: { flexDirection: 'row', gap: 6, marginTop: 12, flexWrap: 'wrap' },
  metaChip: { backgroundColor: C.feed, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5, maxWidth: 180 },
  metaChipText: { fontSize: 11.5, color: C.muted, fontWeight: '700' },
  skillRow: { flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  skillPill: { backgroundColor: 'rgba(6,182,212,0.10)', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5, maxWidth: 160 },
  skillText: { fontSize: 11, color: '#0891b2', fontWeight: '700' },
  applyBtn: { marginTop: 13, borderRadius: 12, overflow: 'hidden' },
  applyGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 42 },
  applyText: { color: '#fff', fontWeight: '800', fontSize: 14 },

  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 13.5, color: C.muted, fontWeight: '600', textAlign: 'center', paddingHorizontal: 30 },
});
