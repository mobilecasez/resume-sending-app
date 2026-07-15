// AI Hub — new feature. Safe to delete without affecting existing app.
// "Saved Jobs" — every posting the user fetched via "Look for live jobs on Google" is stored server-side
// and listed here (newest first). Tapping a card opens the existing Job Hub detail; swipe/trash removes it.
import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, SafeAreaView, RefreshControl, Platform, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, useFocusEffect } from 'expo-router';
import { fetchSavedJobs, removeSavedJob, type SavedJobCard } from '../../services/aiHubService';

const T = {
  bg: '#E5EAF3', surface: '#FFFFFF', ink: '#0B0F22', textMuted: '#5B6B8A', textFaint: '#8896B0',
  border: 'rgba(11,15,34,0.06)', blue: '#4F8DFF', blueDeep: '#2563EB', emerald: '#10B981', rose: '#EF4444',
};
const META = { location: '#06B6D4', experience: '#A78BFA', salary: '#34D399', jobType: '#FB923C', workMode: '#22D3EE' };
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
    applyUrl: c.job_url, matchScore: null,
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

function SavedCard({ job, onOpen, onRemove }: { job: SavedJobCard; onOpen: (j: SavedJobCard) => void; onRemove: (j: SavedJobCard) => void }) {
  const c = gradFor(job.company || job.employer_name || job.title);
  const skills = Array.isArray(job.skills) ? job.skills : [];
  const resp = Array.isArray(job.responsibilities) ? job.responsibilities : [];
  return (
    <TouchableOpacity style={styles.card} activeOpacity={0.85} onPress={() => onOpen(job)}>
      <View style={styles.cardHead}>
        <LinearGradient colors={c} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.logo}><Text style={styles.logoText}>{initial(job.company || job.employer_name)}</Text></LinearGradient>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.jobTitle} numberOfLines={3}>{job.title}</Text>
          <Text style={styles.jobCompany} numberOfLines={2}>{job.company || job.employer_name || 'Company'}</Text>
        </View>
        <TouchableOpacity onPress={() => onRemove(job)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={styles.trashBtn}>
          <Ionicons name="trash-outline" size={17} color={T.textFaint} />
        </TouchableOpacity>
      </View>
      <View style={styles.metaRow}>
        <Meta icon="location-outline" color={META.location} text={job.location} />
        <Meta icon="cash-outline" color={META.salary} text={job.salary} />
        <Meta icon="business-outline" color={META.workMode} text={job.work_mode} />
        <Meta icon="briefcase-outline" color={META.jobType} text={job.job_type} />
      </View>
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

export default function SavedJobsScreen() {
  const router = useRouter();
  const [jobs, setJobs] = useState<SavedJobCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try { const r = await fetchSavedJobs(); setJobs(r.jobs || []); setError(false); }
    catch { setError(true); }
  }, []);

  // Reload every time the screen gains focus (so newly-fetched jobs appear).
  useFocusEffect(useCallback(() => { let alive = true; (async () => { setLoading(true); await load(); if (alive) setLoading(false); })(); return () => { alive = false; }; }, [load]));

  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);
  const openJob = useCallback((c: SavedJobCard) => { router.push({ pathname: '/(ai-hub)/job-detail', params: toJobHubParams(c) }); }, [router]);
  const removeJob = useCallback((c: SavedJobCard) => {
    Alert.alert('Remove saved job', `Remove “${c.title}” from Saved Jobs?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => { setJobs((prev) => prev.filter((j) => j.job_url !== c.job_url)); try { await removeSavedJob(c.job_url); } catch {} } },
    ]);
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}><Ionicons name="chevron-back" size={20} color={T.ink} /></TouchableOpacity>
        <Text style={styles.topTitle}>Saved Jobs</Text>
        <View style={{ width: 38 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={T.blue} size="large" /></View>
      ) : (
        <FlatList
          data={jobs}
          keyExtractor={(j, i) => j.job_url + ':' + i}
          renderItem={({ item }) => <SavedCard job={item} onOpen={openJob} onRemove={removeJob} />}
          contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.blue} />}
          ListHeaderComponent={jobs.length > 0 ? <Text style={styles.countLine}>{jobs.length} saved {jobs.length === 1 ? 'job' : 'jobs'}</Text> : null}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name={error ? 'cloud-offline-outline' : 'bookmark-outline'} size={44} color={T.textFaint} />
              <Text style={styles.emptyTitle}>{error ? 'Could not load saved jobs' : 'No saved jobs yet'}</Text>
              <Text style={styles.emptyText}>{error ? 'Pull to retry.' : 'Use “Live jobs on Google” on Explore, fetch a posting, and it’ll appear here.'}</Text>
              {!error && (
                <TouchableOpacity style={styles.exploreBtn} onPress={() => router.back()} activeOpacity={0.9}>
                  <Ionicons name="search-outline" size={15} color="#fff" /><Text style={styles.exploreText}>Go to Explore</Text>
                </TouchableOpacity>
              )}
            </View>
          }
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
  countLine: { fontSize: 12, color: T.textMuted, fontWeight: '700', marginBottom: 8, marginLeft: 2 },

  card: { backgroundColor: T.surface, borderRadius: 20, borderWidth: 1, borderColor: T.border, padding: 15, marginBottom: 12, shadowColor: '#0F172A', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.06, shadowRadius: 18, elevation: 2 },
  cardHead: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  logo: { width: 46, height: 46, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  logoText: { color: '#fff', fontWeight: '800', fontSize: 19 },
  jobTitle: { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.2 },
  jobCompany: { fontSize: 12.5, color: T.textMuted, marginTop: 3, fontWeight: '600' },
  trashBtn: { padding: 4 },
  metaRow: { flexDirection: 'row', gap: 6, marginTop: 13, flexWrap: 'wrap' },
  metaChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: T.bg, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5, maxWidth: 240 },
  metaText: { fontSize: 11.5, color: T.textMuted, fontWeight: '600' },
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
  exploreBtn: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: T.blueDeep, borderRadius: 12, paddingHorizontal: 18, height: 44, marginTop: 8 },
  exploreText: { color: '#fff', fontWeight: '800', fontSize: 13.5 },
});
