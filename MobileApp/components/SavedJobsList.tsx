// AI Hub — new feature. Safe to delete without affecting existing app.
// Reusable Saved-Jobs list: the postings the user fetched via "Look for live jobs on Google", stored
// server-side and listed newest-first. Rendered as the "Saved" tab on Explore and by the /saved route.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, useFocusEffect } from 'expo-router';
import { fetchSavedJobs, removeSavedJob, loadAllJobStatuses, type SavedJobCard } from '../services/aiHubService';

function clTagOf(s?: string | null): { label: string; color: string } | null {
  if (s === 'applied') return { label: 'Applied', color: '#10B981' };
  if (s === 'generated' || s === 'downloaded') return { label: 'CL Ready', color: '#4F8DFF' };   // matches the My Jobs badge
  return null;
}
const matchColor = (m: number) => (m >= 70 ? '#10B981' : m >= 40 ? '#F59E0B' : '#94A3B8');
function MatchBadge({ score }: { score: number }) {
  const c = matchColor(score);
  return (
    <View style={[styles.matchBadge, { backgroundColor: c + '18', borderColor: c + '44' }]}>
      <Ionicons name="sparkles" size={10} color={c} />
      <Text style={[styles.matchText, { color: c }]}>{score}%</Text>
    </View>
  );
}

const T = {
  bg: '#E5EAF3', surface: '#FFFFFF', ink: '#0B0F22', textMuted: '#5B6B8A', textFaint: '#8896B0',
  border: 'rgba(11,15,34,0.06)', blue: '#4F8DFF', blueDeep: '#2563EB',
};
const META = { location: '#06B6D4', salary: '#34D399', jobType: '#FB923C', workMode: '#22D3EE' };
const AV: [string, string][] = [['#06B6D4', '#3B82F6'], ['#3B82F6', '#7C6BFF'], ['#7C6BFF', '#EC4899'], ['#10B981', '#06B6D4'], ['#F59E0B', '#EF4444'], ['#14B8A6', '#3B82F6']];
const initial = (s?: string | null) => (s || '?').trim().charAt(0).toUpperCase();
const gradFor = (s?: string): [string, string] => { let h = 0; const k = s || 'x'; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return AV[h % AV.length]; };
const hashId = (s: string) => { let h = 0; const k = s || 'x'; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return 'gj_' + h.toString(36); };
const hostOf = (u?: string | null) => { try { return new URL(u || '').hostname.replace(/^www\./, ''); } catch { return ''; } };

function toJobHubParams(c: SavedJobCard) {
  const job = {
    id: hashId(c.job_url), title: c.title, location: c.location || 'Not specified',
    experience: c.experience || '', salary: c.salary || '', jobType: c.job_type || '',
    workMode: c.work_mode || null, urgent: false, skills: Array.isArray(c.skills) ? c.skills : [],
    responsibilities: Array.isArray(c.responsibilities) ? c.responsibilities : [], contacts: [],
    applyUrl: c.job_url, matchScore: typeof c.match === 'number' ? c.match : null,
  };
  const g = gradFor(c.company || c.employer_name || c.title);
  const employer = {
    id: 'g_' + String(c.company || c.employer_name || 'co').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: c.company || c.employer_name || 'Company', subInfo: c.location || hostOf(c.job_url) || 'Saved job',
    logoColor: g, logoInitial: initial(c.company || c.employer_name), domain: hostOf(c.job_url),
  };
  return { jobStr: JSON.stringify(job), employerStr: JSON.stringify(employer) };
}

function Meta({ icon, color, text }: { icon: any; color: string; text?: string | null }) {
  if (!text || /^not (specified|listed)$/i.test(text)) return null;
  return <View style={styles.metaChip}><Ionicons name={icon} size={12} color={color} /><Text style={styles.metaText} numberOfLines={1}>{text}</Text></View>;
}

function SavedCard({ job, onOpen, onRemove, clStatus }: { job: SavedJobCard; onOpen: (j: SavedJobCard) => void; onRemove: (j: SavedJobCard) => void; clStatus?: string | null }) {
  const c = gradFor(job.company || job.employer_name || job.title);
  const skills = Array.isArray(job.skills) ? job.skills : [];
  const resp = Array.isArray(job.responsibilities) ? job.responsibilities : [];
  const clt = clTagOf(clStatus);
  return (
    <TouchableOpacity style={[styles.card, clStatus === 'applied' && styles.cardApplied, (clStatus === 'generated' || clStatus === 'downloaded') && styles.cardCl]} activeOpacity={0.85} onPress={() => onOpen(job)}>
      <View style={styles.cardHead}>
        <LinearGradient colors={c} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.logo}><Text style={styles.logoText}>{initial(job.company || job.employer_name)}</Text></LinearGradient>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.jobTitle} numberOfLines={3}>{job.title}</Text>
          <Text style={styles.jobCompany} numberOfLines={2}>{job.company || job.employer_name || 'Company'}</Text>
          {clt && <View style={[styles.clTag, { backgroundColor: clt.color + '18', borderColor: clt.color + '44' }]}><Ionicons name="document-text" size={10} color={clt.color} /><Text style={[styles.clTagText, { color: clt.color }]}>{clt.label}</Text></View>}
        </View>
        <View style={styles.headRight}>
          {typeof job.match === 'number' && <MatchBadge score={job.match} />}
          <TouchableOpacity onPress={() => onRemove(job)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={styles.trashBtn}>
            <Ionicons name="trash-outline" size={17} color={T.textFaint} />
          </TouchableOpacity>
        </View>
      </View>
      <View style={styles.metaRow}>
        <Meta icon="location-outline" color={META.location} text={job.location} />
        <Meta icon="cash-outline" color={META.salary} text={job.salary} />
        <Meta icon="business-outline" color={META.workMode} text={job.work_mode} />
        <Meta icon="briefcase-outline" color={META.jobType} text={job.job_type} />
      </View>
      {!!job.summary && <Text style={styles.summary} numberOfLines={3}>{job.summary}</Text>}
      {skills.length > 0 && (
        <View style={styles.skillRow}>
          {skills.slice(0, 5).map((s, i) => <View key={i} style={styles.skillChip}><Text style={styles.skillText} numberOfLines={1}>{s}</Text></View>)}
        </View>
      )}
      {resp.length > 0 && resp.slice(0, 2).map((r, i) => (
        <View key={i} style={styles.respRow}><View style={styles.respDot} /><Text style={styles.respText} numberOfLines={2}>{r}</Text></View>
      ))}
      <View style={styles.cardFooter}>
        <Text style={styles.srcText} numberOfLines={1}><Ionicons name="globe-outline" size={11} color={T.textFaint} /> {hostOf(job.job_url) || 'web'}</Text>
        <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.applyBtn}><Ionicons name="reader-outline" size={14} color="#fff" /><Text style={styles.applyText}>View & Apply</Text></LinearGradient>
      </View>
    </TouchableOpacity>
  );
}

export default function SavedJobsList({ onCountChange, onStats }: { onCountChange?: (n: number) => void; onStats?: (s: { count: number; withCl: number; applied: number }) => void }) {
  const router = useRouter();
  const [jobs, setJobs] = useState<SavedJobCard[]>([]);
  const [clStatuses, setClStatuses] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const jobsRef = useRef<SavedJobCard[]>([]);
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);

  // Derive the Saved-tab summary stats (total / cover-letters-ready / applied) from the list + statuses.
  const reportStats = useCallback((list: SavedJobCard[], statuses: Record<string, string>) => {
    let withCl = 0, applied = 0;
    for (const j of list) {
      const s = statuses[hashId(j.job_url)];
      if (s === 'applied') applied++;
      else if (s === 'generated' || s === 'downloaded') withCl++;
    }
    onStats?.({ count: list.length, withCl, applied });
  }, [onStats]);

  const load = useCallback(async () => {
    try {
      const r = await fetchSavedJobs();
      // Sort best-match first (like the My Jobs tab); jobs with no match score sink to the bottom.
      const list = (r.jobs || []).slice().sort((a, b) => (b.match ?? -1) - (a.match ?? -1));
      setJobs(list); setError(false); onCountChange?.(r.count || 0);
      const s = await loadAllJobStatuses().catch(() => ({} as Record<string, string>));
      setClStatuses(s || {}); reportStats(list, s || {});
    } catch { setError(true); }
  }, [onCountChange, reportStats]);

  useEffect(() => { let alive = true; (async () => { setLoading(true); await load(); if (alive) setLoading(false); })(); return () => { alive = false; }; }, [load]);

  // Refresh CL/applied statuses whenever the screen regains focus — so a cover letter generated (or an
  // application marked) over in job-detail is reflected on the Saved cards the moment the user returns.
  useFocusEffect(useCallback(() => {
    loadAllJobStatuses().then((s) => { setClStatuses(s || {}); reportStats(jobsRef.current, s || {}); }).catch(() => {});
  }, [reportStats]));

  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);
  const openJob = useCallback((c: SavedJobCard) => { router.push({ pathname: '/(ai-hub)/job-detail', params: toJobHubParams(c) }); }, [router]);
  const removeJob = useCallback((c: SavedJobCard) => {
    Alert.alert('Remove saved job', `Remove “${c.title}” from Saved Jobs?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => { setJobs((prev) => { const next = prev.filter((j) => j.job_url !== c.job_url); onCountChange?.(next.length); return next; }); try { await removeSavedJob(c.job_url); } catch {} } },
    ]);
  }, [onCountChange]);

  if (loading) return <View style={styles.center}><ActivityIndicator color={T.blue} size="large" /></View>;

  return (
    <FlatList
      data={jobs}
      extraData={clStatuses}
      keyExtractor={(j, i) => j.job_url + ':' + i}
      renderItem={({ item }) => <SavedCard job={item} onOpen={openJob} onRemove={removeJob} clStatus={clStatuses[hashId(item.job_url)]} />}
      contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.blue} />}
      ListHeaderComponent={jobs.length > 0 ? <Text style={styles.countLine}>{jobs.length} saved {jobs.length === 1 ? 'job' : 'jobs'}</Text> : null}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Ionicons name={error ? 'cloud-offline-outline' : 'bookmark-outline'} size={44} color={T.textFaint} />
          <Text style={styles.emptyTitle}>{error ? 'Could not load saved jobs' : 'No saved jobs yet'}</Text>
          <Text style={styles.emptyText}>{error ? 'Pull to retry.' : 'Use “Live jobs on Google”, fetch a posting, and it’ll appear here.'}</Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  countLine: { fontSize: 12, color: T.textMuted, fontWeight: '700', marginBottom: 8, marginLeft: 2 },
  card: { backgroundColor: T.surface, borderRadius: 20, borderWidth: 1, borderColor: T.border, padding: 15, marginBottom: 12, shadowColor: '#0F172A', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.06, shadowRadius: 18, elevation: 2 },
  cardApplied: { backgroundColor: '#F1FBF5', borderColor: '#CDEBD8' },
  cardCl: { backgroundColor: '#F5F9FF', borderColor: '#D6E4FB' },
  clTag: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-start', marginTop: 5, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 100, borderWidth: 1 },
  clTagText: { fontSize: 10, fontWeight: '800' },
  cardHead: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  logo: { width: 46, height: 46, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  logoText: { color: '#fff', fontWeight: '800', fontSize: 19 },
  jobTitle: { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.2 },
  jobCompany: { fontSize: 12.5, color: T.textMuted, marginTop: 3, fontWeight: '600' },
  headRight: { alignItems: 'flex-end', gap: 8 },
  matchBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 100, borderWidth: 1 },
  matchText: { fontSize: 11.5, fontWeight: '800' },
  trashBtn: { padding: 4 },
  metaRow: { flexDirection: 'row', gap: 6, marginTop: 13, flexWrap: 'wrap' },
  metaChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: T.bg, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5, maxWidth: 240 },
  metaText: { fontSize: 11.5, color: T.textMuted, fontWeight: '600' },
  summary: { fontSize: 12.5, color: T.textMuted, lineHeight: 18, marginTop: 10 },
  skillRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 12 },
  skillChip: { backgroundColor: 'rgba(79,141,255,0.08)', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5, maxWidth: 220 },
  skillText: { fontSize: 11, color: T.blueDeep, fontWeight: '700' },
  respRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  respDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: T.blue, marginTop: 6 },
  respText: { flex: 1, fontSize: 12.5, color: T.textMuted, lineHeight: 18 },
  cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 15 },
  srcText: { flex: 1, fontSize: 10.5, color: T.textFaint, fontWeight: '600' },
  applyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 38, paddingHorizontal: 16, borderRadius: 12 },
  applyText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 70, gap: 10 },
  emptyTitle: { fontSize: 15.5, color: T.ink, fontWeight: '800', marginTop: 4 },
  emptyText: { fontSize: 13, color: T.textMuted, fontWeight: '600', textAlign: 'center', paddingHorizontal: 40, lineHeight: 19 },
});
