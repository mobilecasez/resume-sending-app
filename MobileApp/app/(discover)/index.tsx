// AI Hub — new feature. Safe to delete without affecting existing app.
//
// "Explore Jobs" — value-first feed over the global_jobs firehose. A Job-Hub-style hero summary card
// on top, rich job cards (meta chips + skills + responsibilities) like the dashboard, and each job
// opens the EXISTING Job Hub detail screen (full details + inline-browser Apply + AI cover letter +
// autofill) by passing a mapped Job/Employer via jobStr/employerStr — no résumé/profile needed first.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput, ActivityIndicator,
  SafeAreaView, RefreshControl, Platform, Animated, Easing,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import {
  fetchDiscoverJobs, fetchDiscoverFacets,
  type DiscoverJob, type DiscoverFacets,
} from '../../services/aiHubService';
import { logEvent } from '../../services/firebaseAnalytics';

// Shared design tokens (match the Job Hub's `T`).
const T = {
  bg: '#E5EAF3', surface: '#FFFFFF', ink: '#0B0F22', textMuted: '#5B6B8A', textFaint: '#8896B0',
  border: 'rgba(11,15,34,0.06)', blue: '#4F8DFF', blueDeep: '#2563EB', purple: '#7C6BFF',
  emerald: '#10B981', amber: '#F59E0B', rose: '#EF4444',
};
const META = { location: '#06B6D4', experience: '#A78BFA', salary: '#34D399', jobType: '#FB923C', workMode: '#22D3EE' };
const HERO_GRAD: readonly [string, string, string] = ['#0B0F22', '#0F1635', '#0B0F22'];
const AV: [string, string][] = [['#06B6D4', '#3B82F6'], ['#3B82F6', '#7C6BFF'], ['#7C6BFF', '#EC4899'], ['#10B981', '#06B6D4'], ['#F59E0B', '#EF4444'], ['#14B8A6', '#3B82F6'], ['#EC4899', '#7C6BFF'], ['#F97316', '#EF4444']];
const PAGE = 20;
const MODES = ['Remote', 'Hybrid', 'Onsite'];

const fmt = (n?: number | null) => (n == null || isNaN(n) ? '0' : Math.round(n).toLocaleString('en-US'));
const initial = (s?: string | null) => (s || '?').trim().charAt(0).toUpperCase();
const gradFor = (s?: string): [string, string] => { let h = 0; const k = s || 'x'; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return AV[h % AV.length]; };

const hashId = (s: string) => { let h = 0; const k = s || 'x'; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return 'gj_' + h.toString(36); };

// DiscoverJob → the Job Hub's Job/Employer shape (so the existing detail screen renders it).
// id is a URL-safe synthetic (not the job_url) so the detail screen's /ai-hub/jobs/:id/* calls stay
// well-formed (they 404 harmlessly for global jobs — persistence just doesn't stick, everything else works).
function toJobHubParams(dj: DiscoverJob) {
  const job = {
    id: hashId(dj.job_url || dj.id), title: dj.title, location: dj.location || 'Not specified',
    experience: dj.experience || '', salary: dj.salary || '', jobType: dj.job_type || '',
    workMode: dj.work_mode || null, urgent: false, skills: Array.isArray(dj.skills) ? dj.skills : [],
    responsibilities: Array.isArray(dj.responsibilities) ? dj.responsibilities : [], contacts: [],
    applyUrl: dj.job_url,
  };
  const c = gradFor(dj.employer_name || dj.title);
  const employer = {
    id: 'g_' + (dj.employer_name || 'co').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: dj.employer_name || 'Company',
    subInfo: [dj.location, dj.country].filter(Boolean).join(' · ') || 'Live opening',
    logoColor: c, logoInitial: initial(dj.employer_name), domain: dj.employer_domain || '',
  };
  return { jobStr: JSON.stringify(job), employerStr: JSON.stringify(employer) };
}

// ── pulsing "Live" dot ───
function LiveDot() {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(a, { toValue: 1, duration: 1800, easing: Easing.out(Easing.ease), useNativeDriver: true }));
    loop.start(); return () => loop.stop();
  }, []);
  const scale = a.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] });
  const opacity = a.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] });
  return (
    <View style={{ width: 7, height: 7, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={{ position: 'absolute', width: 7, height: 7, borderRadius: 4, backgroundColor: '#22D3EE', transform: [{ scale }], opacity }} />
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: '#22D3EE' }} />
    </View>
  );
}

// ── hero summary card (clones the Job Hub header) ───
function HeroCard({ facets, total }: { facets: DiscoverFacets | null; total: number }) {
  const remote = facets?.workModes?.find((w) => /remote/i.test(w.work_mode))?.n || 0;
  const stats = [
    { value: fmt(total || facets?.total || 0), label: 'Live jobs', color: '#22D3EE' },
    { value: fmt(remote), label: 'Remote', color: '#A78BFA' },
    { value: fmt(facets?.employers?.length || 0) + (facets && facets.employers.length >= 30 ? '+' : ''), label: 'Employers', color: '#34D399' },
    { value: fmt(facets?.countries?.length || 0), label: 'Regions', color: '#FB923C' },
  ];
  return (
    <View style={styles.hero}>
      <LinearGradient colors={HERO_GRAD} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={[styles.blob, { top: -30, right: -20, backgroundColor: 'rgba(79,141,255,0.18)' }]} />
      <View style={[styles.blob, { bottom: -40, left: -30, backgroundColor: 'rgba(124,107,255,0.14)' }]} />
      <View style={styles.heroEyebrowRow}>
        <Text style={styles.heroEyebrow}>WORLDWIDE JOB FEED</Text>
        <View style={styles.livePill}><LiveDot /><Text style={styles.livePillText}>Live</Text></View>
      </View>
      <Text style={styles.heroTitle}>Explore Jobs</Text>
      <Text style={styles.heroSub}>{fmt(total || facets?.total || 0)} openings from top companies — updated every few hours</Text>
      <View style={styles.statsRow}>
        {stats.map((s, i) => (
          <React.Fragment key={s.label}>
            {i > 0 && <View style={styles.statDivider} />}
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: s.color }]}>{s.value}</Text>
              <Text style={styles.statLabel}>{s.label}</Text>
            </View>
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}

// ── meta chip ───
function Meta({ icon, color, text }: { icon: any; color: string; text?: string | null }) {
  if (!text || /^not (specified|listed)$/i.test(text)) return null;
  return (
    <View style={styles.metaChip}>
      <Ionicons name={icon} size={12} color={color} />
      <Text style={styles.metaText} numberOfLines={1}>{text}</Text>
    </View>
  );
}

// ── rich job card (clones the dashboard JobCard essence) ───
function JobCard({ job, onOpen }: { job: DiscoverJob; onOpen: (j: DiscoverJob) => void }) {
  const c = gradFor(job.employer_name || job.title);
  const skills = Array.isArray(job.skills) ? job.skills : [];
  const resp = Array.isArray(job.responsibilities) ? job.responsibilities : [];
  return (
    <TouchableOpacity style={styles.card} activeOpacity={0.85} onPress={() => onOpen(job)}>
      <View style={styles.cardHead}>
        <LinearGradient colors={c} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.logo}>
          <Text style={styles.logoText}>{initial(job.employer_name)}</Text>
        </LinearGradient>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.jobTitle} numberOfLines={2}>{job.title}</Text>
          <Text style={styles.jobCompany} numberOfLines={1}>{job.employer_name || 'Company'}</Text>
        </View>
      </View>

      <View style={styles.metaRow}>
        <Meta icon="location-outline" color={META.location} text={job.location} />
        <Meta icon="cash-outline" color={META.salary} text={job.salary} />
        <Meta icon="business-outline" color={META.workMode} text={job.work_mode} />
        <Meta icon="briefcase-outline" color={META.jobType} text={job.job_type} />
        <Meta icon="time-outline" color={META.experience} text={job.experience} />
      </View>

      {skills.length > 0 && (
        <View style={styles.skillsWrap}>
          <Text style={styles.sectionLabel}>SKILLS</Text>
          <View style={styles.skillRow}>
            {skills.slice(0, 5).map((s, i) => (
              <View key={i} style={styles.skillChip}><Text style={styles.skillText} numberOfLines={1}>{s}</Text></View>
            ))}
            {skills.length > 5 && <View style={styles.skillChip}><Text style={styles.skillText}>+{skills.length - 5} more</Text></View>}
          </View>
        </View>
      )}

      {resp.length > 0 && (
        <View style={styles.respWrap}>
          <Text style={styles.sectionLabel}>RESPONSIBILITIES</Text>
          {resp.slice(0, 3).map((r, i) => (
            <View key={i} style={styles.respRow}>
              <View style={styles.respDot} />
              <Text style={styles.respText} numberOfLines={2}>{r}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.cardFooter}>
        <View style={styles.viewBtn}><Ionicons name="reader-outline" size={15} color={T.blueDeep} /><Text style={styles.viewBtnText}>View details</Text></View>
        <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.applyBtn}>
          <Ionicons name="paper-plane-outline" size={14} color="#fff" />
          <Text style={styles.applyText}>View & Apply</Text>
        </LinearGradient>
      </View>
    </TouchableOpacity>
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
      setError(null); setTotal(data.total || 0);
      setJobs((prev) => (opts.append ? [...prev, ...(data.jobs || [])] : (data.jobs || [])));
    } catch {
      if (my !== seq.current) return;
      setError('Could not load jobs. Pull to retry.');
      if (!opts.append) setJobs([]);
    }
  }, []);

  useEffect(() => { fetchDiscoverFacets().then(setFacets).catch(() => {}); logEvent('feed_opened'); }, []);
  useEffect(() => { (async () => { setLoading(true); await load({ q: '', mode: null, offset: 0, append: false }); setLoading(false); })(); }, [load]);
  useEffect(() => {
    const t = setTimeout(async () => { setLoading(true); await load({ q: query.trim(), mode, offset: 0, append: false }); setLoading(false); }, 350);
    return () => clearTimeout(t);
  }, [query, mode, load]);

  const onRefresh = useCallback(async () => { setRefreshing(true); await Promise.all([load({ q: query.trim(), mode, offset: 0, append: false }), fetchDiscoverFacets().then(setFacets).catch(() => {})]); setRefreshing(false); }, [query, mode, load]);
  const onEnd = useCallback(async () => {
    if (loadingMore || jobs.length >= total || loading) return;
    setLoadingMore(true); await load({ q: query.trim(), mode, offset: jobs.length, append: true }); setLoadingMore(false);
  }, [loadingMore, jobs.length, total, loading, query, mode, load]);

  const openJob = useCallback((dj: DiscoverJob) => {
    router.push({ pathname: '/(ai-hub)/job-detail', params: toJobHubParams(dj) });
  }, [router]);

  const header = useMemo(() => (
    <View>
      <HeroCard facets={facets} total={total} />
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={T.textFaint} />
        <TextInput value={query} onChangeText={setQuery} placeholder="Search role, company or city" placeholderTextColor={T.textFaint} style={styles.searchInput} autoCapitalize="none" autoCorrect={false} returnKeyType="search" />
        {query.length > 0 && <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}><Ionicons name="close-circle" size={17} color={T.textFaint} /></TouchableOpacity>}
      </View>
      <View style={styles.chipsRow}>
        {MODES.map((m) => {
          const on = mode === m;
          return <TouchableOpacity key={m} onPress={() => setMode(on ? null : m)} style={[styles.filterChip, on && styles.filterChipOn]} activeOpacity={0.8}><Text style={[styles.filterChipText, on && styles.filterChipTextOn]}>{m}</Text></TouchableOpacity>;
        })}
        <Text style={styles.countLine}>{fmt(total)} {total === 1 ? 'result' : 'results'}</Text>
      </View>
    </View>
  ), [facets, total, query, mode]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={20} color={T.ink} />
        </TouchableOpacity>
        <Text style={styles.topTitle}>Explore Jobs</Text>
        <View style={{ width: 38 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={T.blue} size="large" /></View>
      ) : (
        <FlatList
          data={jobs}
          keyExtractor={(j, i) => j.id + ':' + i}
          renderItem={({ item }) => <JobCard job={item} onOpen={openJob} />}
          ListHeaderComponent={header}
          contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.blue} />}
          onEndReached={onEnd} onEndReachedThreshold={0.5}
          removeClippedSubviews initialNumToRender={6} windowSize={9}
          ListEmptyComponent={<View style={styles.empty}><Ionicons name={error ? 'cloud-offline-outline' : 'briefcase-outline'} size={40} color={T.textFaint} /><Text style={styles.emptyText}>{error || (query ? 'No jobs match your search.' : 'No jobs yet — check back soon.')}</Text></View>}
          ListFooterComponent={loadingMore ? <ActivityIndicator color={T.blue} style={{ marginVertical: 18 }} /> : <View style={{ height: 8 }} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: T.bg },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: Platform.OS === 'android' ? 30 : 6, paddingBottom: 8 },
  backBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: T.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.border },
  topTitle: { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  hero: { borderRadius: 26, overflow: 'hidden', padding: 20, marginBottom: 14, shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.18, shadowRadius: 24, elevation: 8 },
  blob: { position: 'absolute', width: 160, height: 160, borderRadius: 999 },
  heroEyebrowRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroEyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.5, color: 'rgba(255,255,255,0.4)' },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(34,211,238,0.12)', borderRadius: 100, paddingHorizontal: 9, paddingVertical: 4 },
  livePillText: { color: '#22D3EE', fontSize: 11, fontWeight: '700' },
  heroTitle: { fontSize: 28, fontWeight: '800', color: '#fff', letterSpacing: -1, marginTop: 8 },
  heroSub: { color: 'rgba(255,255,255,0.5)', fontSize: 12.5, marginTop: 4 },
  statsRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', borderRadius: 18, paddingVertical: 12, paddingHorizontal: 8, marginTop: 16 },
  statItem: { flex: 1, alignItems: 'center' },
  statValue: { fontSize: 18, fontWeight: '800' },
  statLabel: { fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 2, fontWeight: '600' },
  statDivider: { width: 1, height: 26, backgroundColor: 'rgba(255,255,255,0.08)' },

  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: T.surface, borderRadius: 14, borderWidth: 1, borderColor: T.border, paddingHorizontal: 12, height: 46, marginBottom: 10 },
  searchInput: { flex: 1, fontSize: 14, color: T.ink, padding: 0 },
  chipsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' },
  filterChip: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 100, backgroundColor: T.surface, borderWidth: 1, borderColor: T.border },
  filterChipOn: { backgroundColor: T.blue, borderColor: T.blue },
  filterChipText: { fontSize: 12.5, fontWeight: '700', color: T.textMuted },
  filterChipTextOn: { color: '#fff' },
  countLine: { fontSize: 12, color: T.textMuted, fontWeight: '600', marginLeft: 'auto' },

  card: { backgroundColor: T.surface, borderRadius: 20, borderWidth: 1, borderColor: T.border, padding: 15, marginBottom: 12, shadowColor: '#0F172A', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.06, shadowRadius: 18, elevation: 2 },
  cardHead: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  logo: { width: 46, height: 46, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  logoText: { color: '#fff', fontWeight: '800', fontSize: 19 },
  jobTitle: { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.2 },
  jobCompany: { fontSize: 12.5, color: T.textMuted, marginTop: 3, fontWeight: '600' },
  metaRow: { flexDirection: 'row', gap: 6, marginTop: 13, flexWrap: 'wrap' },
  metaChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: T.bg, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5, maxWidth: 220 },
  metaText: { fontSize: 11.5, color: T.textMuted, fontWeight: '600' },
  sectionLabel: { fontSize: 10, fontWeight: '800', color: T.textFaint, letterSpacing: 0.8, marginBottom: 7 },
  skillsWrap: { marginTop: 13 },
  skillRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  skillChip: { backgroundColor: 'rgba(79,141,255,0.08)', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5, maxWidth: 220 },
  skillText: { fontSize: 11, color: T.blueDeep, fontWeight: '700' },
  respWrap: { marginTop: 13 },
  respRow: { flexDirection: 'row', gap: 8, marginBottom: 5 },
  respDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: T.blue, marginTop: 6 },
  respText: { flex: 1, fontSize: 12.5, color: T.textMuted, lineHeight: 18 },
  cardFooter: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 15 },
  viewBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, height: 40, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: T.border, backgroundColor: T.surface },
  viewBtnText: { color: T.blueDeep, fontWeight: '700', fontSize: 12.5 },
  applyBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 40, borderRadius: 12 },
  applyText: { color: '#fff', fontWeight: '800', fontSize: 13.5 },

  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 50, gap: 12 },
  emptyText: { fontSize: 13.5, color: T.textMuted, fontWeight: '600', textAlign: 'center', paddingHorizontal: 30 },
});
