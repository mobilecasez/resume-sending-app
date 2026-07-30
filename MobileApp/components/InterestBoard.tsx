// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The redesigned Jobs tab: LOCATION-BASED INTEREST CARDS instead of company cards. A card is a
// place + the skills the user cares about ("React · Bengaluru, India"). Tapping a card expands the
// live jobs for it straight from the global directory (city matches first). The demand-research
// routine walks these same interests twice a day, researches the live web for them, and pushes
// "New matching jobs for you" when fresh matches land.
//
// ⚠️ The add-interest form is ONE top-level <Modal>, never nested inside another (build-87 lesson).
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Modal, ActivityIndicator, Alert, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import {
  fetchInterests, createInterest, deleteInterest, fetchInterestJobs,
  type Interest, type InterestJob,
} from '../services/interestsService';

const T = {
  card: '#FFFFFF', ink: '#0B0F22', muted: '#5B6B8A', faint: '#8896B0',
  line: 'rgba(11,15,34,0.06)', blue: '#4F8DFF', blueDeep: '#2563EB', cyan: '#06B6D4', emerald: '#10B981',
};
const AV: [string, string][] = [['#06B6D4', '#3B82F6'], ['#3B82F6', '#7C6BFF'], ['#7C6BFF', '#EC4899'], ['#10B981', '#06B6D4'], ['#F59E0B', '#EF4444']];
const gradFor = (s: string): [string, string] => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return AV[h % AV.length]; };
const hashId = (s: string) => { let h = 0; const k = s || 'x'; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return 'gj_' + h.toString(36); };

// Same job-detail hand-off the Explore feed uses: the card's data rides as jobStr/employerStr.
function openJob(router: ReturnType<typeof useRouter>, j: InterestJob) {
  const job = {
    id: hashId(j.job_url || j.id), title: j.title, location: j.location || 'Not specified',
    experience: j.experience || '', salary: j.salary || '', jobType: j.job_type || '',
    workMode: j.work_mode || null, urgent: false, skills: Array.isArray(j.skills) ? j.skills : [],
    responsibilities: Array.isArray(j.responsibilities) ? j.responsibilities : [], contacts: [],
    applyUrl: j.job_url, matchScore: null,
  };
  const name = j.employer_name || 'Company';
  const employer = {
    id: 'g_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name, subInfo: [j.location, j.country].filter(Boolean).join(' · ') || 'Live opening',
    logoColor: gradFor(name), logoInitial: (name[0] || '?').toUpperCase(), domain: j.employer_domain || '',
  };
  router.push({ pathname: '/(ai-hub)/job-detail', params: { jobStr: JSON.stringify(job), employerStr: JSON.stringify(employer) } });
}

export default function InterestBoard({
  addOpen, onAddClose, onOpenCompanySearch,
}: {
  addOpen: boolean;                       // parent's + button opens the form
  onAddClose: () => void;
  onOpenCompanySearch?: () => void;       // legacy employer search stays one tap away
}) {
  const router = useRouter();
  const [items, setItems] = useState<Interest[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);
  const [jobs, setJobs] = useState<Record<number, { jobs: InterestJob[]; total: number; loading: boolean }>>({});
  // add form
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [skills, setSkills] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try { setItems(await fetchInterests()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = useCallback(async (id: number) => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    if (!jobs[id]) {
      setJobs((p) => ({ ...p, [id]: { jobs: [], total: 0, loading: true } }));
      try {
        const r = await fetchInterestJobs(id);
        setJobs((p) => ({ ...p, [id]: { ...r, loading: false } }));
      } catch {
        setJobs((p) => ({ ...p, [id]: { jobs: [], total: 0, loading: false } }));
      }
    }
  }, [openId, jobs]);

  const save = useCallback(async () => {
    const c = country.trim();
    const sk = skills.split(',').map((s) => s.trim()).filter(Boolean);
    if (!c) { Alert.alert('Missing country', 'Tell us which country you want jobs in.'); return; }
    if (!sk.length) { Alert.alert('Missing skills', 'Add at least one skill or role — e.g. "plumber" or "react, node".'); return; }
    setSaving(true);
    try {
      const ok = await createInterest({ country: c, city: city.trim() || undefined, skills: sk });
      if (ok) { setCountry(''); setCity(''); setSkills(''); onAddClose(); load(); }
      else Alert.alert('Could not save', 'Please try again.');
    } catch (e: any) {
      Alert.alert('Could not save', e?.response?.data?.error || 'Please try again.');
    } finally { setSaving(false); }
  }, [country, city, skills, onAddClose, load]);

  const remove = useCallback((it: Interest) => {
    Alert.alert('Remove this interest?', `${it.label} — job alerts for it stop too.`, [
      { text: 'Keep', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => { try { await deleteInterest(it.id); load(); } catch {} } },
    ]);
  }, [load]);

  return (
    <View style={s.wrap}>
      {loading ? (
        <ActivityIndicator color={T.blue} style={{ marginVertical: 26 }} />
      ) : items.length === 0 ? (
        <View style={s.empty}>
          <Ionicons name="location-outline" size={34} color={T.faint} />
          <Text style={s.emptyTitle}>Tell us where and what</Text>
          <Text style={s.emptyText}>Add a place + your skills, and jobs for it appear here. Our researcher then scans the live web for exactly this twice a day — and tells you when fresh matches land.</Text>
        </View>
      ) : (
        items.map((it) => {
          const open = openId === it.id;
          const j = jobs[it.id];
          return (
            <View key={it.id} style={s.card}>
              <TouchableOpacity style={s.cardHead} activeOpacity={0.85} onPress={() => toggle(it.id)} onLongPress={() => remove(it)}>
                <LinearGradient colors={gradFor(it.label || it.country)} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.logo}>
                  <Ionicons name="location" size={17} color="#fff" />
                </LinearGradient>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.cardTitle} numberOfLines={1}>{it.city ? `${it.city}, ${it.country}` : it.country}</Text>
                  <Text style={s.cardSkills} numberOfLines={1}>{it.skills.join(' · ')}</Text>
                </View>
                <View style={s.countPill}><Text style={s.countText}>{it.jobCount}</Text><Text style={s.countLbl}>jobs</Text></View>
                <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={17} color={T.faint} />
              </TouchableOpacity>

              {open && (
                <View style={s.jobsWrap}>
                  {!j || j.loading ? <ActivityIndicator color={T.blue} style={{ marginVertical: 14 }} />
                    : j.jobs.length === 0 ? (
                      <Text style={s.noJobs}>Nothing in the directory yet — our researcher hunts for this twice a day, and you'll get a notification when matches land.</Text>
                    ) : (
                      <>
                        {j.jobs.map((job) => (
                          <TouchableOpacity key={job.id} style={s.jobRow} activeOpacity={0.85} onPress={() => openJob(router, job)}>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text style={s.jobTitle} numberOfLines={2}>{job.title}</Text>
                              <Text style={s.jobMeta} numberOfLines={1}>{[job.employer_name, job.location].filter(Boolean).join(' · ')}</Text>
                            </View>
                            <Ionicons name="chevron-forward" size={16} color={T.faint} />
                          </TouchableOpacity>
                        ))}
                        {j.total > j.jobs.length && <Text style={s.moreNote}>{j.total - j.jobs.length} more in Search → filter by {it.country}</Text>}
                      </>
                    )}
                </View>
              )}
            </View>
          );
        })
      )}

      {/* ── Add-interest form — ONE top-level modal ── */}
      <Modal visible={addOpen} transparent animationType="slide" onRequestClose={onAddClose}>
        <View style={s.sheetOverlay}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onAddClose} />
          <View style={s.sheet}>
            <View style={s.sheetHead}>
              <Text style={s.sheetTitle}>What jobs should we watch for?</Text>
              <TouchableOpacity onPress={onAddClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={T.muted} />
              </TouchableOpacity>
            </View>
            <Text style={s.label}>COUNTRY *</Text>
            <TextInput value={country} onChangeText={setCountry} placeholder="e.g. India" placeholderTextColor={T.faint} style={s.input} autoCapitalize="words" />
            <Text style={s.label}>CITY (OPTIONAL — its jobs rank first)</Text>
            <TextInput value={city} onChangeText={setCity} placeholder="e.g. Bengaluru" placeholderTextColor={T.faint} style={s.input} autoCapitalize="words" />
            <Text style={s.label}>SKILLS OR ROLES * (COMMA SEPARATED)</Text>
            <TextInput value={skills} onChangeText={setSkills} placeholder="e.g. react, node — or plumber" placeholderTextColor={T.faint} style={s.input} autoCapitalize="none" />
            <TouchableOpacity style={[s.saveBtn, saving && { opacity: 0.6 }]} onPress={save} disabled={saving} activeOpacity={0.9}>
              <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.saveGrad}>
                {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.saveText}>Start watching</Text>}
              </LinearGradient>
            </TouchableOpacity>
            {!!onOpenCompanySearch && (
              <TouchableOpacity
                style={s.companyLink}
                onPress={() => { onAddClose(); setTimeout(() => onOpenCompanySearch(), 350); }}
              >
                <Ionicons name="business-outline" size={14} color={T.blueDeep} />
                <Text style={s.companyLinkText}>Search a specific company instead</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginBottom: 8 },
  empty: { alignItems: 'center', gap: 8, backgroundColor: T.card, borderRadius: 24, padding: 26, marginBottom: 12, borderWidth: 1, borderColor: T.line },
  emptyTitle: { fontSize: 15.5, fontWeight: '800', color: T.ink },
  emptyText: { fontSize: 12.5, color: T.muted, textAlign: 'center', lineHeight: 18 },

  card: { backgroundColor: T.card, borderRadius: 20, borderWidth: 1, borderColor: T.line, marginBottom: 10, overflow: 'hidden' },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 11, padding: 13 },
  logo: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 14.5, fontWeight: '800', color: T.ink },
  cardSkills: { fontSize: 12, color: T.muted, marginTop: 2, fontWeight: '600' },
  countPill: { alignItems: 'center', backgroundColor: 'rgba(6,182,212,0.10)', borderRadius: 11, paddingHorizontal: 9, paddingVertical: 4 },
  countText: { fontSize: 13, fontWeight: '800', color: T.cyan },
  countLbl: { fontSize: 8.5, fontWeight: '700', color: T.cyan, letterSpacing: 0.4 },

  jobsWrap: { borderTopWidth: 1, borderTopColor: T.line, paddingHorizontal: 13, paddingVertical: 6 },
  noJobs: { fontSize: 12, color: T.faint, lineHeight: 17, paddingVertical: 10 },
  jobRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: T.line },
  jobTitle: { fontSize: 13, fontWeight: '700', color: T.ink, lineHeight: 18 },
  jobMeta: { fontSize: 11.5, color: T.muted, marginTop: 2 },
  moreNote: { fontSize: 11, color: T.faint, fontWeight: '600', paddingVertical: 9, textAlign: 'center' },

  sheetOverlay: { flex: 1, backgroundColor: 'rgba(6,10,25,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 18, paddingBottom: Platform.OS === 'ios' ? 34 : 20 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sheetTitle: { fontSize: 16.5, fontWeight: '800', color: T.ink, letterSpacing: -0.2, flex: 1 },
  label: { fontSize: 10, fontWeight: '800', color: T.faint, letterSpacing: 0.8, marginTop: 10, marginBottom: 5 },
  input: { backgroundColor: '#F4F7FC', borderWidth: 1, borderColor: T.line, borderRadius: 13, paddingHorizontal: 13, height: 46, fontSize: 14, color: T.ink },
  saveBtn: { marginTop: 16, borderRadius: 14, overflow: 'hidden' },
  saveGrad: { height: 50, alignItems: 'center', justifyContent: 'center' },
  saveText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  companyLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 13 },
  companyLinkText: { fontSize: 12.5, fontWeight: '700', color: T.blueDeep },
});
