// AI Hub — new feature. Safe to delete without affecting existing app.
//
// "Explore Jobs" — value-first feed over the global_jobs firehose. Job-Hub-style hero summary card,
// rich job cards (meta + skills + responsibilities + résumé MATCH badge), sort by Best-match / Recent,
// a FIELD scope (defaults to the user's own field, e.g. IT / Sales / Finance, best matches first), and
// a Filters sheet (Field / Role / Technology / Location / Work mode / Employer). The feed round-robins
// employers server-side so no single company walls the list. Each job opens the EXISTING Job Hub detail
// (full details + inline-browser Apply + AI cover letter) via jobStr/employerStr.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput, ActivityIndicator,
  SafeAreaView, RefreshControl, Platform, Animated, Easing, Modal, Pressable, ScrollView, Alert,
  Keyboard, PanResponder, Image, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import SortControl from '../../components/SortControl';
import {
  fetchDiscoverJobs, fetchDiscoverFacets, aiSearchJobs, hydrateJobUrls, loadAllJobStatuses,
  fetchDiscoverJobById,
  type DiscoverJob, type DiscoverFacets, type AiSearchParsed, type AiXray,
} from '../../services/aiHubService';
import { logEvent } from '../../services/firebaseAnalytics';
import SilentWebSearch from '../../components/SilentWebSearch';
import { useEventCosts } from '../../hooks/useEventCosts';
import GoogleJobBrowser, { directUrlOf } from '../../components/GoogleJobBrowser';
import SavedJobsList from '../../components/SavedJobsList';

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
const cap = (s?: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const matchColor = (m: number) => (m >= 70 ? T.emerald : m >= 40 ? T.amber : '#94A3B8');
const hashId = (s: string) => { let h = 0; const k = s || 'x'; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return 'gj_' + h.toString(36); };
// shorten long field labels for compact chips ("Mechanical / Electrical / Civil Engineering" → "Mechanical / …")
const shortField = (f?: string | null) => { if (!f) return ''; return f.length > 22 ? f.split('/')[0].trim() + ' …' : f; };

function toJobHubParams(dj: DiscoverJob) {
  const job = {
    id: hashId(dj.job_url || dj.id), title: dj.title, location: dj.location || 'Not specified',
    experience: dj.experience || '', salary: dj.salary || '', jobType: dj.job_type || '',
    workMode: dj.work_mode || null, urgent: false, skills: Array.isArray(dj.skills) ? dj.skills : [],
    responsibilities: Array.isArray(dj.responsibilities) ? dj.responsibilities : [], contacts: [],
    applyUrl: dj.job_url, matchScore: dj.match ?? null,
  };
  const c = gradFor(dj.employer_name || dj.title);
  const employer = {
    id: 'g_' + (dj.employer_name || 'co').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: dj.employer_name || 'Company', subInfo: [dj.location, dj.country].filter(Boolean).join(' · ') || 'Live opening',
    logoColor: c, logoInitial: initial(dj.employer_name), domain: dj.employer_domain || '',
  };
  return { jobStr: JSON.stringify(job), employerStr: JSON.stringify(employer) };
}

function LiveDot() {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => { const loop = Animated.loop(Animated.timing(a, { toValue: 1, duration: 1800, easing: Easing.out(Easing.ease), useNativeDriver: true })); loop.start(); return () => loop.stop(); }, []);
  const scale = a.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] });
  const opacity = a.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] });
  return (
    <View style={{ width: 7, height: 7, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={{ position: 'absolute', width: 7, height: 7, borderRadius: 4, backgroundColor: '#22D3EE', transform: [{ scale }], opacity }} />
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: '#22D3EE' }} />
    </View>
  );
}

function MatchBadge({ score }: { score: number }) {
  const c = matchColor(score);
  return (
    <View style={[styles.matchBadge, { backgroundColor: c + '18', borderColor: c + '44' }]}>
      <Ionicons name="sparkles" size={10} color={c} />
      <Text style={[styles.matchText, { color: c }]}>{score}%</Text>
    </View>
  );
}

function HeroCard({ facets, total }: { facets: DiscoverFacets | null; total: number }) {
  const remote = facets?.workModes?.find((w) => /remote/i.test(w.work_mode))?.n || 0;
  const stats = [
    { value: fmt(facets?.total || total || 0), label: 'Live jobs', color: '#22D3EE' },
    { value: fmt(remote), label: 'Remote', color: '#A78BFA' },
    { value: fmt(facets?.fields?.length || 0), label: 'Fields', color: '#34D399' },
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
      <Text style={styles.heroSub}>{fmt(facets?.total || total || 0)} openings across every field — updated every few hours</Text>
      <View style={styles.statsRow}>
        {stats.map((s, i) => (
          <React.Fragment key={s.label}>
            {i > 0 && <View style={styles.statDivider} />}
            <View style={styles.statItem}><Text style={[styles.statValue, { color: s.color }]}>{s.value}</Text><Text style={styles.statLabel}>{s.label}</Text></View>
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}

function Meta({ icon, color, text }: { icon: any; color: string; text?: string | null }) {
  if (!text || /^not (specified|listed)$/i.test(text)) return null;
  return <View style={styles.metaChip}><Ionicons name={icon} size={12} color={color} /><Text style={styles.metaText} numberOfLines={1}>{text}</Text></View>;
}

function clTagOf(s?: string | null): { label: string; color: string } | null {
  if (s === 'applied') return { label: 'Applied', color: '#10B981' };
  if (s === 'generated' || s === 'downloaded') return { label: 'CL Ready', color: '#4F8DFF' };   // matches the My Jobs badge
  return null;
}
function JobCard({ job, onOpen, clStatus }: { job: DiscoverJob; onOpen: (j: DiscoverJob) => void; clStatus?: string | null }) {
  const c = gradFor(job.employer_name || job.title);
  const skills = Array.isArray(job.skills) ? job.skills : [];
  const resp = Array.isArray(job.responsibilities) ? job.responsibilities : [];
  const clt = clTagOf(clStatus);
  return (
    <TouchableOpacity style={[styles.card, clStatus === 'applied' && styles.cardApplied, (clStatus === 'generated' || clStatus === 'downloaded') && styles.cardCl]} activeOpacity={0.85} onPress={() => onOpen(job)}>
      <View style={styles.cardHead}>
        <LinearGradient colors={c} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.logo}><Text style={styles.logoText}>{initial(job.employer_name)}</Text></LinearGradient>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.jobTitle} numberOfLines={3}>{job.title}</Text>
          <Text style={styles.jobCompany} numberOfLines={2}>{job.employer_name || 'Company'}</Text>
          {!!job.role_category && <Text style={styles.roleTag} numberOfLines={1}>{job.role_category}</Text>}
          {clt && <View style={[styles.clTag, { backgroundColor: clt.color + '18', borderColor: clt.color + '44' }]}><Ionicons name="document-text" size={10} color={clt.color} /><Text style={[styles.clTagText, { color: clt.color }]}>{clt.label}</Text></View>}
        </View>
        {typeof job.match === 'number' && <MatchBadge score={job.match} />}
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
            {skills.slice(0, 5).map((s, i) => <View key={i} style={styles.skillChip}><Text style={styles.skillText} numberOfLines={1}>{s}</Text></View>)}
            {skills.length > 5 && <View style={styles.skillChip}><Text style={styles.skillText}>+{skills.length - 5} more</Text></View>}
          </View>
        </View>
      )}
      {resp.length > 0 && (
        <View style={styles.respWrap}>
          <Text style={styles.sectionLabel}>RESPONSIBILITIES</Text>
          {resp.slice(0, 3).map((r, i) => <View key={i} style={styles.respRow}><View style={styles.respDot} /><Text style={styles.respText} numberOfLines={2}>{r}</Text></View>)}
        </View>
      )}
      <View style={styles.cardFooter}>
        <View style={styles.viewBtn}><Ionicons name="reader-outline" size={15} color={T.blueDeep} /><Text style={styles.viewBtnText}>View details</Text></View>
        <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.applyBtn}><Ionicons name="paper-plane-outline" size={14} color="#fff" /><Text style={styles.applyText}>View & Apply</Text></LinearGradient>
      </View>
    </TouchableOpacity>
  );
}

// ── filter chip (single-select toggle) ───
function FChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return <TouchableOpacity onPress={onPress} style={[styles.fChip, on && styles.fChipOn]} activeOpacity={0.8}><Text style={[styles.fChipText, on && styles.fChipTextOn]} numberOfLines={1}>{label}</Text></TouchableOpacity>;
}

// ── Movable circular Filters button ────────────────────────────────────────────────────────────────
// Floats where the old header filter button sat (right side, just under the search bar) but the user
// can drag it anywhere — the spot is remembered across screens and launches. Tap (not drag) opens
// the Filters sheet.
const { width: SCW, height: SCH } = Dimensions.get('window');
const FFAB = { size: 48, right: 12, top: 118 };
let filterFabPos = { x: 0, y: 0 };                    // module cache so every mount agrees instantly
const FFAB_KEY = 'discover_filter_fab_v1';
const clampFfab = (p: { x: number; y: number }) => ({
  x: Math.max(-(SCW - FFAB.right - FFAB.size - 6), Math.min(FFAB.right - 6, p.x)),
  y: Math.max(-FFAB.top + 6, Math.min(SCH - FFAB.top - FFAB.size - 160, p.y)),
});
function FilterFab({ active, count, onPress }: { active: boolean; count: number; onPress: () => void }) {
  const pan = useRef(new Animated.ValueXY(filterFabPos)).current;
  const moved = useRef(false);
  useEffect(() => {
    AsyncStorage.getItem(FFAB_KEY).then((r) => {
      if (!r) return;
      try { const p = clampFfab(JSON.parse(r)); filterFabPos = p; pan.setValue(p); } catch {}
    }).catch(() => {});
  }, []);
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
      onPanResponderGrant: () => {
        moved.current = false;
        pan.setOffset({ x: (pan.x as any).__getValue(), y: (pan.y as any).__getValue() });
        pan.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: (_e, g) => {
        if (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4) moved.current = true;
        pan.setValue({ x: g.dx, y: g.dy });
      },
      onPanResponderRelease: () => {
        pan.flattenOffset();
        if (!moved.current) { onPressRef.current(); return; }
        const p = clampFfab({ x: (pan.x as any).__getValue(), y: (pan.y as any).__getValue() });
        filterFabPos = p;
        Animated.spring(pan, { toValue: p, friction: 7, useNativeDriver: false }).start();
        AsyncStorage.setItem(FFAB_KEY, JSON.stringify(p)).catch(() => {});
      },
    })
  ).current;
  // The responder is created once; onPress changes across renders — read it through a ref.
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;
  return (
    <Animated.View style={[styles.filterFab, { transform: pan.getTranslateTransform() }]} {...responder.panHandlers}>
      <View style={[styles.filterFabBtn, active && styles.filterFabBtnOn]}>
        <Ionicons name="options-outline" size={20} color={active ? '#fff' : T.blueDeep} />
        {active && <View style={styles.filterDot}><Text style={styles.filterDotTx}>{count}</Text></View>}
      </View>
    </Animated.View>
  );
}

// Reusable Explore feed. `embedded` renders JUST the feed (no SafeAreaView / top bar / Explore|Saved
// sub-tabs) so the Job Hub can mount it as its "Search" tab; the standalone /(discover) route wraps it.
export function ExploreFeed({ embedded = false, onStats, onSavedChange, initialSort }: { embedded?: boolean; onStats?: (s: { total: number; remote: number; fields: number; regions: number }) => void; onSavedChange?: () => void; initialSort?: 'match' | 'recent' }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { costOf } = useEventCosts();
  const aiCost = costOf('ai_search');
  const [clStatuses, setClStatuses] = useState<Record<string, string>>({});   // job id → cover-letter/applied status
  const [jobs, setJobs] = useState<DiscoverJob[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noProfile, setNoProfile] = useState(false);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'explore' | 'saved'>('explore');   // top segmented tabs
  const [savedCount, setSavedCount] = useState(0);
  const [liveOpen, setLiveOpen] = useState(false);   // "Look for live jobs on Google" modal
  const [liveQuery, setLiveQuery] = useState('');
  const [sort, setSort] = useState<'match' | 'recent'>(initialSort === 'recent' ? 'recent' : 'match');
  const [mode, setMode] = useState('');          // work_mode
  const [skill, setSkill] = useState('');
  const [country, setCountry] = useState('');
  const [employer, setEmployer] = useState('');
  const [field, setField] = useState('');        // department scope ('' = all fields)
  const [roleCat, setRoleCat] = useState('');
  const [userField, setUserField] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [facets, setFacets] = useState<DiscoverFacets | null>(null);
  const seq = useRef(0);
  const fieldInit = useRef(false);
  const searchRef = useRef<TextInput | null>(null);   // focus target for the always-on Live-jobs pill
  // AI natural-language search (over the whole saved network)
  const [aiActive, setAiActive] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiParsed, setAiParsed] = useState<AiSearchParsed | null>(null);
  const [aiResults, setAiResults] = useState<DiscoverJob[]>([]);
  const [aiTotal, setAiTotal] = useState(0);
  const [aiHasMore, setAiHasMore] = useState(false);
  const [aiLoadingMore, setAiLoadingMore] = useState(false);
  // Silent on-device browser: X-Ray the web (user IP) → hydrate → grow the network for this search
  const [xrayUrls, setXrayUrls] = useState<string[]>([]);  // [] = WebViews unmounted
  const [xraySeq, setXraySeq] = useState(0);               // bump to force fresh WebViews per search
  const [webPhase, setWebPhase] = useState<'' | 'searching' | 'hydrating'>('');
  const [webNote, setWebNote] = useState('');
  const lastQueryRef = useRef('');
  const webTimerRef = useRef<any>(null);
  // Recent searches (last 5) — shown in a popup when the search box is focused.
  const [recent, setRecent] = useState<string[]>([]);
  const [showRecent, setShowRecent] = useState(false);
  // Local network search now lives in the Filters sheet (the top button is Google Search).
  const [localQ, setLocalQ] = useState('');
  // First visit to the Jobs page → play the Google-search video once, at readable speed.
  const [searchIntro, setSearchIntro] = useState(false);
  useEffect(() => {
    AsyncStorage.getItem('jobs_search_intro_v1').then((r) => { if (r !== '1') setSearchIntro(true); }).catch(() => {});
  }, []);
  const dismissSearchIntro = useCallback(() => {
    setSearchIntro(false);
    AsyncStorage.setItem('jobs_search_intro_v1', '1').catch(() => {});
  }, []);
  useEffect(() => { AsyncStorage.getItem('discover_recent_v1').then((r) => { if (!r) return; try { const a = JSON.parse(r); if (Array.isArray(a)) setRecent(a.filter((x) => typeof x === 'string').slice(0, 5)); } catch {} }); }, []);
  const pushRecent = useCallback((q: string) => {
    const t = String(q || '').trim(); if (!t) return;
    setRecent((prev) => { const next = [t, ...prev.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, 5); AsyncStorage.setItem('discover_recent_v1', JSON.stringify(next)).catch(() => {}); return next; });
  }, []);

  const activeCount = [mode, skill, country, employer, roleCat].filter(Boolean).length;
  // A ≥10% match floor only makes sense inside the user's OWN field (where match is meaningful).
  const minMatch = !noProfile && field && field === userField ? 10 : 0;

  // NOTE: the search box no longer live-filters the feed (that caused a refetch on every keystroke).
  // Typing is for AI search only (triggered by the Ask-AI button / keyboard submit). So `query` is
  // intentionally NOT a dependency here.
  const load = useCallback(async (opts: { offset: number; append: boolean }) => {
    const my = ++seq.current;
    try {
      const data = await fetchDiscoverJobs({ work_mode: mode, skill, country, employer, field, role_category: roleCat, sort, min_match: minMatch, offset: opts.offset, limit: PAGE });
      if (my !== seq.current) return;
      setError(null); setTotal(data.total || 0); setNoProfile(!!data.noProfile);
      if (data.userField && userField == null) setUserField(data.userField);
      setJobs((prev) => (opts.append ? [...prev, ...(data.jobs || [])] : (data.jobs || [])));
    } catch {
      if (my !== seq.current) return;
      setError('Could not load jobs. Pull to retry.');
      if (!opts.append) setJobs([]);
    }
  }, [mode, skill, country, employer, field, roleCat, sort, minMatch, userField]);

  // Mount: load facets, capture the user's own field, and default the scope to it.
  useEffect(() => {
    fetchDiscoverFacets('').then((f) => {
      setFacets(f);
      setUserField(f.userField || null);
      if (!fieldInit.current) { fieldInit.current = true; if (f.userField) setField(f.userField); }
    }).catch(() => {});
    logEvent('feed_opened');
  }, []);
  // Cover-letter / applied status for the visible jobs → drives the CL tag on Search cards too.
  useEffect(() => { loadAllJobStatuses().then((s) => setClStatuses(s || {})).catch(() => {}); }, [jobs.length, aiResults.length]);
  // Refresh statuses whenever this screen regains focus, so a cover letter generated in job-detail shows
  // on the Search cards the moment the user comes back (was loaded once → stale until the list reloaded).
  useFocusEffect(useCallback(() => { loadAllJobStatuses().then((s) => setClStatuses(s || {})).catch(() => {}); }, []));
  // Surface feed totals to the parent Job Hub so its shared hero can show Search-tab stats (issue: every tab must show counts).
  useEffect(() => {
    if (!onStats || !facets) return;
    const remote = facets.workModes?.find((w) => /remote/i.test(w.work_mode))?.n || 0;
    onStats({ total: facets.total || 0, remote, fields: facets.fields?.length || 0, regions: facets.countries?.length || 0 });
  }, [facets, onStats]);
  // When the scope field changes, refresh facets so the Role list matches the field.
  useEffect(() => { if (field) fetchDiscoverFacets(field).then(setFacets).catch(() => {}); }, [field]);

  useEffect(() => {
    const t = setTimeout(async () => { setLoading(true); await load({ offset: 0, append: false }); setLoading(false); }, 300);
    return () => clearTimeout(t);
  }, [load]);

  const onRefresh = useCallback(async () => { setRefreshing(true); await Promise.all([load({ offset: 0, append: false }), fetchDiscoverFacets(field).then(setFacets).catch(() => {})]); setRefreshing(false); }, [load, field]);
  const onEnd = useCallback(async () => { if (loadingMore || jobs.length >= total || loading) return; setLoadingMore(true); await load({ offset: jobs.length, append: true }); setLoadingMore(false); }, [loadingMore, jobs.length, total, loading, load]);
  const openJob = useCallback((dj: DiscoverJob) => { router.push({ pathname: '/(ai-hub)/job-detail', params: toJobHubParams(dj) }); }, [router]);
  // "Apply here" from the Browse & Fetch dock → open job-detail with the apply browser auto-opened
  // at that page, so the user gets the FULL apply arsenal (AI auto-fill, resume upload interception,
  // answer memory, submit detection) on the exact page they were viewing.
  const openApplyHere = useCallback((applyUrl: string, pageTitle: string, card: any) => {
    let host = ''; try { host = new URL(applyUrl).hostname.replace(/^www\./, ''); } catch {}
    const title = (card?.title || pageTitle || 'Job application').slice(0, 140);
    const company = card?.company || card?.employer_name || host || 'Company';
    // These are DISPLAY fallbacks only. When they came from the page/host rather than a real card,
    // flag them weak so job capture doesn't ship "instahyre.com" as the employer and block the AI's
    // real extraction (the job board is not the company you're applying to).
    const weakTitle = !card?.title;
    const weakName  = !(card?.company || card?.employer_name);
    const job = {
      id: hashId(applyUrl), title, location: card?.location || 'Not specified',
      experience: card?.experience || '', salary: card?.salary || '', jobType: card?.job_type || '',
      workMode: card?.work_mode || null, urgent: false, skills: Array.isArray(card?.skills) ? card.skills : [],
      responsibilities: Array.isArray(card?.responsibilities) ? card.responsibilities : [], contacts: [],
      applyUrl, matchScore: typeof card?.match === 'number' ? card.match : null, weakTitle,
    };
    const g = gradFor(company);
    const employer = {
      id: 'g_' + String(company).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: company, subInfo: card?.location || host || 'Live job', logoColor: g, logoInitial: initial(company), domain: host, weakName,
    };
    router.push({ pathname: '/(ai-hub)/job-detail', params: { jobStr: JSON.stringify(job), employerStr: JSON.stringify(employer), autoApply: '1', applyNowUrl: applyUrl } });
  }, [router]);
  const clearFilters = () => { setMode(''); setSkill(''); setCountry(''); setEmployer(''); setRoleCat(''); };

  // AI natural-language search: parse the sentence → search the network → show ranked matches.
  const runAiSearch = useCallback(async (q: string) => {
    const query = (q || '').trim();
    if (!query) return;
    pushRecent(query); setShowRecent(false);
    setAiLoading(true); setAiActive(true); setWebNote(''); setWebPhase('');
    try {
      const data = await aiSearchJobs(query, 0, 30);
      if ((data as any).insufficient) {
        setAiActive(false);
        const need = (data as any).creditsRequired ?? aiCost ?? 5;
        Alert.alert('Not enough credits', `AI search needs ${need} credit${need === 1 ? '' : 's'}. You have ${(data as any).creditsRemaining ?? 0}. Top up in Account → Credits.`);
        return;
      }
      if (data.urlDetected && data.url) {
        setAiActive(false);
        Alert.alert('Employer link detected', 'Add this link in Job Hub to research every open role at this employer.', [{ text: 'OK' }]);
        return;
      }
      setAiParsed(data.parsed || null); setAiResults(data.jobs || []); setAiTotal(data.total || 0);
      setAiHasMore(!!data.hasMore); lastQueryRef.current = query;
      if (typeof data.noProfile === 'boolean') setNoProfile(data.noProfile);
      // Nothing in our own network yet → go STRAIGHT to the rich live web search (LinkedIn + Google on the
      // user's IP, location-accurate). Far better than the ATS-only X-Ray for places like Delhi/India — this
      // is why "0 matches → searched the web → still nothing" happened. Skip the X-Ray in that case.
      if ((data.total || 0) === 0) {
        // Cancel any still-in-flight X-Ray from a PRIOR search (its timer + mounted SilentWebSearch) so it
        // can't hydrate/re-query behind the modal, then jump to the rich live web search.
        if (webTimerRef.current) { clearTimeout(webTimerRef.current); webTimerRef.current = null; }
        setXrayUrls([]); setWebPhase(''); setWebNote('');
        setLiveQuery(query); setLiveOpen(true);
        return;
      }
      // We have some network matches → silently X-Ray the ATS web to GROW them (Google + DDG-lite).
      const perSite: string[] = (data.xray && Array.isArray(data.xray.perSite)) ? data.xray.perSite : [];
      const urls = [
        ...perSite.map((q) => 'https://www.google.com/search?num=30&q=' + encodeURIComponent(q)),
        ...perSite.slice(0, 2).map((q) => 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q)),
      ].slice(0, 6);
      if (urls.length) {
        lastQueryRef.current = query;
        setWebPhase('searching'); setXraySeq((n) => n + 1); setXrayUrls(urls);
        if (webTimerRef.current) clearTimeout(webTimerRef.current);
        webTimerRef.current = setTimeout(() => { setWebPhase(''); setXrayUrls([]); }, 24000);  // safety timeout
      }
    } catch { setAiResults([]); setAiTotal(0); }
    finally { setAiLoading(false); }
  }, []);

  // The silent WebView finished the X-Ray → hydrate the discovered boards, then refresh the results.
  const onXrayResult = useCallback(async (urls: string[], blocked: boolean) => {
    if (webTimerRef.current) { clearTimeout(webTimerRef.current); webTimerRef.current = null; }
    setXrayUrls([]);   // unmount the WebView
    if (!urls.length) { setWebPhase(''); setWebNote(blocked ? '' : ''); return; }
    setWebPhase('hydrating');
    try {
      const q = lastQueryRef.current;
      const h = await hydrateJobUrls(urls, q).catch(() => ({ ingested: 0 } as any));
      // Re-run the network search — it now includes the freshly-ingested jobs. refresh=true → no re-charge.
      const fresh = await aiSearchJobs(q, 0, 30, true);
      setAiResults(fresh.jobs || []); setAiTotal(fresh.total || 0); setAiHasMore(!!fresh.hasMore);
      setWebNote(h && h.ingested > 0 ? 'Searched the live web — results updated' : '');
    } catch { /* keep the network results */ }
    finally { setWebPhase(''); }
  }, []);

  // Paginate AI-search results (was disabled → the feed capped at the first 30 even when total was 214).
  const onAiEnd = useCallback(async () => {
    if (aiLoadingMore || !aiHasMore || webPhase) return;
    setAiLoadingMore(true);
    try {
      const data = await aiSearchJobs(lastQueryRef.current, aiResults.length, 30);
      setAiResults((prev) => [...prev, ...(data.jobs || [])]);
      setAiHasMore(!!data.hasMore);
    } catch {}
    finally { setAiLoadingMore(false); }
  }, [aiLoadingMore, aiHasMore, webPhase, aiResults.length]);

  const clearAiSearch = useCallback(() => {
    if (webTimerRef.current) { clearTimeout(webTimerRef.current); webTimerRef.current = null; }
    setAiActive(false); setAiParsed(null); setAiResults([]); setAiTotal(0); setQuery('');
    setXrayUrls([]); setWebPhase(''); setWebNote('');
  }, []);
  // The ONE search button: "Google Search" — opens the real Google (in-app) for what's typed. Uses
  // whatever is CURRENTLY typed first; falls back to the last search when the box is empty. If
  // neither exists, nudge them to type. (Local network search lives in the Filters sheet now.)
  const openGoogle = useCallback((text?: string) => {
    const q = ((text != null ? text : query).trim() || lastQueryRef.current || '').trim();
    if (!q) { searchRef.current?.focus(); return; }
    Keyboard.dismiss();
    pushRecent(q); setShowRecent(false);
    setLiveQuery(q); setLiveOpen(true);
    logEvent('google_search_opened');
  }, [query, pushRecent]);

  // What the recents popup actually lists: everything when the box is empty, otherwise the ones that
  // match what is being typed (minus an exact repeat of it, which would be a row that does nothing).
  const recentShown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recent;
    return recent.filter((r) => { const t = r.toLowerCase(); return t !== q && t.includes(q); });
  }, [recent, query]);

  const pickField = (f: string) => { const nf = f === field ? '' : f; setField(nf); setRoleCat(''); };

  const scopeLabel = field ? shortField(field) : 'All fields';
  const isOwnField = !!field && field === userField;

  const header = useMemo(() => (
    <View>
      {!embedded && <HeroCard facets={facets} total={total} />}
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={T.blueDeep} />
        <TextInput ref={searchRef} value={query} onChangeText={setQuery} placeholder="Search jobs — or paste a job link" placeholderTextColor={T.textFaint} style={styles.searchInput} autoCapitalize="none" autoCorrect={false} returnKeyType="search" onFocus={() => setShowRecent(true)} onBlur={() => setTimeout(() => setShowRecent(false), 150)} onSubmitEditing={() => openGoogle()} />
        {query.length > 0 && <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}><Ionicons name="close-circle" size={17} color={T.textFaint} /></TouchableOpacity>}
        {/* A pasted link OPENS directly in the browser (save it there via robot → Fetch job);
            anything else Google-searches. The label tells the user which will happen. */}
        <TouchableOpacity onPress={() => openGoogle()} disabled={!query.trim()} style={[styles.askAiBtn, !query.trim() && { opacity: 0.5 }]} activeOpacity={0.85}>
          {directUrlOf(query)
            ? <><Ionicons name="link-outline" size={13} color="#fff" /><Text style={styles.askAiText}>Open Link</Text></>
            : <><Ionicons name="logo-google" size={13} color="#fff" /><Text style={styles.askAiText}>Google Search</Text></>}
        </TouchableOpacity>
      </View>

      {/* Recent searches — shown whenever the box is focused, filtered by what is typed.
          ⚠️ THIS USED TO REQUIRE AN EMPTY BOX (`query.trim().length === 0`), which meant it
          effectively never appeared: the box KEEPS its text after a search, so from the first
          search onwards tapping it showed nothing and the feature looked broken. Filtering as you
          type is also what every search box does. */}
      {showRecent && recentShown.length > 0 && !aiActive && (
        <View style={styles.recentBox}>
          <View style={styles.recentHead}>
            <Text style={styles.recentTitle}>Recent searches</Text>
            <TouchableOpacity onPress={() => { setRecent([]); AsyncStorage.removeItem('discover_recent_v1').catch(() => {}); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}><Text style={styles.recentClear}>Clear</Text></TouchableOpacity>
          </View>
          {recentShown.map((r, i) => (
            <TouchableOpacity key={r + i} style={styles.recentRow} activeOpacity={0.7} onPress={() => { setQuery(r); setShowRecent(false); searchRef.current?.blur(); openGoogle(r); }}>
              <Ionicons name="time-outline" size={15} color={T.textFaint} />
              <Text style={styles.recentRowTx} numberOfLines={1}>{r}</Text>
              <Ionicons name="arrow-forward" size={14} color={T.textFaint} />
            </TouchableOpacity>
          ))}
        </View>
      )}

      {aiActive && (
        <View style={styles.aiBanner}>
          <View style={styles.aiBannerHead}>
            <Ionicons name="search" size={13} color={T.blueDeep} />
            <Text style={styles.aiBannerTitle}>Your search</Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={clearAiSearch} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}><Text style={styles.aiClear}>Clear</Text></TouchableOpacity>
          </View>
          {!!aiParsed && (
            <View style={styles.aiChips}>
              {(aiParsed.keywords || []).slice(0, 4).map((k) => <View key={'k' + k} style={styles.aiChip}><Text style={styles.aiChipText}>{k}</Text></View>)}
              {!!aiParsed.field && <View style={[styles.aiChip, styles.aiChipAlt]}><Text style={styles.aiChipText}>{shortField(aiParsed.field)}</Text></View>}
              {!!aiParsed.location && <View style={styles.aiChip}><Text style={styles.aiChipText}>📍 {aiParsed.location}</Text></View>}
              {!!aiParsed.workMode && <View style={styles.aiChip}><Text style={styles.aiChipText}>{cap(aiParsed.workMode)}</Text></View>}
              {!!aiParsed.seniority && <View style={styles.aiChip}><Text style={styles.aiChipText}>{aiParsed.seniority}</Text></View>}
            </View>
          )}
          <Text style={styles.aiCount}>{aiLoading ? 'Searching…' : `${fmt(aiTotal)} ${aiTotal === 1 ? 'match' : 'matches'} found`}</Text>
          {(webPhase || webNote) ? (
            <View style={styles.webRow}>
              {webPhase ? <ActivityIndicator size="small" color={T.blueDeep} /> : <Ionicons name="checkmark-circle" size={14} color={T.emerald} />}
              <Text style={[styles.webText, !webPhase && { color: T.emerald }]}>
                {webPhase === 'searching' ? 'Searching the live web for more…' : webPhase === 'hydrating' ? 'Pulling fresh jobs into your feed…' : webNote}
              </Text>
            </View>
          ) : null}
        </View>
      )}

      {/* The green "Search live on Google" bar used to sit here — the top Google Search button does
          that job now, and the Filters button floats (movable) instead of taking a header row. */}
      {!aiActive && (<>
      {noProfile && (
        <View style={styles.hintBox}><Ionicons name="information-circle-outline" size={15} color={T.blueDeep} /><Text style={styles.hintText}>Upload your résumé in Account Settings to see match scores and your-field jobs.</Text></View>
      )}
      {/* Count + Sort — uses the summary row's spare space for the sort control. */}
      <View style={styles.countRow}>
        <Text style={styles.countLine} numberOfLines={1}>
          {fmt(total)} {total === 1 ? 'job' : 'jobs'}
          {isOwnField && !noProfile ? ' · best matches' : (field ? ` · ${shortField(field)}` : '')}
        </Text>
        <SortControl options={[{ key: 'match', label: 'Best match' }, { key: 'recent', label: 'Newest first' }]} value={sort} onChange={(k) => setSort(k as any)} />
      </View>
      </>)}
    </View>
  ), [facets, total, query, sort, activeCount, noProfile, field, userField, scopeLabel, isOwnField, aiActive, aiLoading, aiParsed, aiTotal, webPhase, webNote, runAiSearch, clearAiSearch, openGoogle, recent, recentShown, showRecent]);

  // Only blank to a spinner on the FIRST load (no data yet). A re-load triggered by facets setting the
  // field must NOT clear the screen — that was the "shows page → blank → reloads" flicker on the tab.
  const feedContent = (loading && jobs.length === 0 && !aiActive) ? (
    <View style={styles.center}><ActivityIndicator color={T.blue} size="large" /></View>
  ) : (
    <FlatList
      data={aiActive ? aiResults : jobs} keyExtractor={(j, i) => j.id + ':' + i}
      extraData={clStatuses}
      renderItem={({ item }) => <JobCard job={item} onOpen={openJob} clStatus={clStatuses[hashId(item.job_url || item.id)]} />}
      ListHeaderComponent={header}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.blue} />}
      onEndReached={aiActive ? onAiEnd : onEnd} onEndReachedThreshold={0.6}
      removeClippedSubviews initialNumToRender={6} windowSize={9}
      contentContainerStyle={{ padding: 12, paddingBottom: insets.bottom + (embedded ? 96 : 80) }}
      ListEmptyComponent={aiActive
        ? <View style={styles.empty}>{aiLoading ? <ActivityIndicator color={T.blue} /> : <><Ionicons name="search-outline" size={40} color={T.textFaint} /><Text style={styles.emptyText}>No matches in the network yet — try different words, or tap “Google Search” above to search the live web.</Text></>}</View>
        : <View style={styles.empty}><Ionicons name={error ? 'cloud-offline-outline' : 'briefcase-outline'} size={40} color={T.textFaint} /><Text style={styles.emptyText}>{error || (query || activeCount || field ? 'No jobs match — try “All fields” or clear filters.' : 'No jobs yet — check back soon.')}</Text></View>}
      ListFooterComponent={
        <View>
          {(loadingMore || aiLoadingMore) ? <ActivityIndicator color={T.blue} style={{ marginVertical: 18 }} /> : null}
          <View style={{ height: 20 }} />
        </View>
      }
    />
  );

  const overlays = (
    <>
      {/* ── Filters sheet ── */}
      <Modal visible={showFilters} transparent animationType="slide" onRequestClose={() => setShowFilters(false)}>
        <View style={styles.sheetOverlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setShowFilters(false)} />
          <View style={styles.sheet}>
            <View style={styles.sheetGrip} />
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>Filters</Text>
              <TouchableOpacity onPress={clearFilters}><Text style={styles.clearText}>Clear all</Text></TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 460 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* Free-text LOCAL search — scans our own saved job network (the top button is Google). */}
              <View style={styles.fSection}>
                <Text style={styles.fSectionTitle}>Search our job network</Text>
                <View style={styles.localRow}>
                  <Ionicons name="search" size={15} color={T.blueDeep} />
                  <TextInput
                    value={localQ} onChangeText={setLocalQ}
                    placeholder="e.g. react developer in Berlin" placeholderTextColor={T.textFaint}
                    style={styles.localInput} autoCapitalize="none" autoCorrect={false} returnKeyType="search"
                    onSubmitEditing={() => { const q = localQ.trim(); if (q) { setShowFilters(false); runAiSearch(q); } }}
                  />
                  <TouchableOpacity
                    onPress={() => { const q = localQ.trim(); if (q) { setShowFilters(false); runAiSearch(q); } }}
                    disabled={!localQ.trim() || aiLoading}
                    style={[styles.localBtn, (!localQ.trim() || aiLoading) && { opacity: 0.5 }]} activeOpacity={0.85}
                  >
                    {aiLoading ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.localBtnTx}>Search</Text>}
                  </TouchableOpacity>
                </View>
                <Text style={styles.localHint}>AI search across {fmt(facets?.total || total || 0)} jobs already in the network</Text>
              </View>
              <FilterSection title="Sort" items={['Best match', 'Recent']} value={sort === 'recent' ? 'Recent' : 'Best match'} onPick={(v) => setSort(v === 'Recent' ? 'recent' : 'match')} />
              <FilterSection
                title="Field" allLabel="All fields"
                items={(facets?.fields || []).map((f) => f.field)} value={field}
                onPick={(v) => pickField(v)} onAll={() => { setField(''); setRoleCat(''); }}
                labelFor={shortField} highlight={userField || undefined}
              />
              {!!field && (facets?.roleCategories || []).length > 0 && (
                <FilterSection title="Role" items={(facets?.roleCategories || []).map((r) => r.role_category)} value={roleCat} onPick={(v) => setRoleCat(v === roleCat ? '' : v)} />
              )}
              <FilterSection title="Technology" items={(facets?.skills || []).slice(0, 24).map((s) => s.skill)} value={skill} onPick={(v) => setSkill(v === skill ? '' : v)} />
              <FilterSection title="Location" items={(facets?.countries || []).map((c) => c.country)} value={country} onPick={(v) => setCountry(v === country ? '' : v)} />
              <FilterSection title="Work mode" items={MODES} value={cap(mode) || ''} onPick={(v) => setMode(v.toLowerCase() === mode ? '' : v.toLowerCase())} />
              <FilterSection title="Employer" items={(facets?.employers || []).slice(0, 20).map((e) => e.employer_name)} value={employer} onPick={(v) => setEmployer(v === employer ? '' : v)} />
              <View style={{ height: 8 }} />
            </ScrollView>
            <TouchableOpacity style={styles.applySheet} onPress={() => setShowFilters(false)} activeOpacity={0.9}>
              <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.applySheetGrad}>
                <Text style={styles.applySheetText}>Show {fmt(total)} jobs</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      {xrayUrls.length > 0 && <SilentWebSearch key={xraySeq} urls={xrayUrls} onResult={onXrayResult} />}
      {/* On close, tell the parent so the Saved count/summary refresh (fetching happens here, not on the Saved tab). */}
      <GoogleJobBrowser visible={liveOpen} query={liveQuery} onClose={() => { setLiveOpen(false); onSavedChange?.(); }} onApplyHere={openApplyHere} />

      {/* First landing on the Jobs page → SHOW the Google-search flow once, at a readable speed. */}
      <Modal visible={searchIntro} transparent animationType="fade" onRequestClose={dismissSearchIntro}>
        <View style={styles.introOverlay}>
          <View style={styles.introCard}>
            <View style={styles.introHead}>
              <Ionicons name="logo-google" size={17} color={T.blueDeep} />
              <Text style={styles.introTitle}>Search jobs on Google</Text>
              <TouchableOpacity onPress={dismissSearchIntro} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={T.textFaint} />
              </TouchableOpacity>
            </View>
            <Text style={styles.introSub}>
              Type what you want, tap “Google Search”, and the real Google opens inside the app. Open a job, tap the robot → Fetch job — it lands in Saved Jobs.
            </Text>
            <Image
              source={require('../../assets/onboarding/guide-google-search.gif')}
              style={styles.introGif} resizeMode="contain"
            />
            <TouchableOpacity style={styles.introBtn} onPress={dismissSearchIntro} activeOpacity={0.9}>
              <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.introBtnGrad}>
                <Text style={styles.introBtnTx}>Got it — let me try</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );

  // Embedded (Job Hub "Search" tab): just the feed + overlays, no screen chrome.
  if (embedded) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg }}>
        {feedContent}
        <FilterFab active={activeCount > 0 || !!field} count={activeCount + (field ? 1 : 0)} onPress={() => setShowFilters(true)} />
        {overlays}
      </View>
    );
  }

  // Standalone /(discover) route: full screen with its own top bar + Explore|Saved sub-tabs.
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}><Ionicons name="chevron-back" size={20} color={T.ink} /></TouchableOpacity>
        <Text style={styles.topTitle}>Explore Jobs</Text>
        <View style={{ width: 38 }} />
      </View>
      <View style={styles.segWrap}>
        {(['explore', 'saved'] as const).map((t) => (
          <TouchableOpacity key={t} onPress={() => setTab(t)} style={[styles.segBtn, tab === t && styles.segBtnOn]} activeOpacity={0.85}>
            <Ionicons name={t === 'explore' ? 'compass-outline' : 'bookmark-outline'} size={15} color={tab === t ? '#fff' : T.textMuted} />
            <Text style={[styles.segText, tab === t && styles.segTextOn]}>{t === 'explore' ? 'Explore' : (savedCount > 0 ? `Saved · ${savedCount}` : 'Saved')}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {tab === 'saved' ? <SavedJobsList onCountChange={setSavedCount} /> : feedContent}
      {tab !== 'saved' && <FilterFab active={activeCount > 0 || !!field} count={activeCount + (field ? 1 : 0)} onPress={() => setShowFilters(true)} />}
      {overlays}
    </SafeAreaView>
  );
}

// The standalone /(discover) route. It also accepts the deep-link params a tapped notification
// carries: `jobId` (open that ONE job's detail, exactly like tapping its feed card) and `sort`.
export default function DiscoverScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ jobId?: string | string[]; sort?: string | string[] }>();
  const first = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v) || '';
  const jobId = first(params?.jobId).trim();
  const sortParam = first(params?.sort).trim().toLowerCase();
  const [opening, setOpening] = useState(false);
  // The jobId we have ALREADY acted on. The param stays in the route forever (it's still there when
  // the user comes back from job-detail, and on every unrelated re-render), so without this the
  // screen would re-open the job again and again.
  const openedRef = useRef<string>('');

  useEffect(() => {
    if (!jobId || openedRef.current === jobId) return;
    openedRef.current = jobId;
    let cancelled = false;
    setOpening(true);
    fetchDiscoverJobById(jobId)
      .then((dj) => {
        if (cancelled) return;
        if (!dj) {
          // Gone (unlisted / expired) — stay on the feed rather than showing a dead screen.
          Alert.alert('Job no longer listed', 'That opening has been taken down. Here are the latest jobs instead.');
          return;
        }
        router.push({ pathname: '/(ai-hub)/job-detail', params: toJobHubParams(dj) });
      })
      .catch(() => {
        if (cancelled) return;
        Alert.alert('Could not open that job', 'Check your connection and try again — the feed below is still up to date.');
      })
      .finally(() => { if (!cancelled) setOpening(false); });
    return () => { cancelled = true; };
  }, [jobId, router]);

  return (
    <View style={{ flex: 1 }}>
      <ExploreFeed initialSort={sortParam === 'recent' ? 'recent' : sortParam === 'match' ? 'match' : undefined} />
      {opening && (
        <View style={styles.openingOverlay} pointerEvents="auto">
          <View style={styles.openingCard}>
            <ActivityIndicator color={T.blue} />
            <Text style={styles.openingText}>Opening job…</Text>
          </View>
        </View>
      )}
    </View>
  );
}

function FilterSection({ title, items, value, onPick, allLabel, onAll, labelFor, highlight }:
  { title: string; items: string[]; value: string; onPick: (v: string) => void; allLabel?: string; onAll?: () => void; labelFor?: (v: string) => string; highlight?: string }) {
  if (!items.length && !allLabel) return null;
  return (
    <View style={styles.fSection}>
      <Text style={styles.fSectionTitle}>{title}</Text>
      <View style={styles.fChipWrap}>
        {allLabel && <FChip label={allLabel} on={!value} onPress={() => (onAll ? onAll() : onPick(''))} />}
        {items.map((it) => <FChip key={it} label={(labelFor ? labelFor(it) : it) + (highlight && it === highlight ? '  ★' : '')} on={value === it} onPress={() => onPick(it)} />)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: T.bg },
  openingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(11,15,34,0.35)', alignItems: 'center', justifyContent: 'center' },
  openingCard: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: T.surface, borderRadius: 14, paddingHorizontal: 18, paddingVertical: 14, borderWidth: 1, borderColor: T.border },
  openingText: { fontSize: 14, fontWeight: '700', color: T.ink },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: Platform.OS === 'android' ? 30 : 6, paddingBottom: 8 },
  backBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: T.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.border },
  topTitle: { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  segWrap: { flexDirection: 'row', marginHorizontal: 14, marginBottom: 8, backgroundColor: T.surface, borderRadius: 12, borderWidth: 1, borderColor: T.border, padding: 3, gap: 4 },
  segBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 38, borderRadius: 9 },
  segBtnOn: { backgroundColor: T.blueDeep },
  segText: { fontSize: 13, fontWeight: '800', color: T.textMuted },
  segTextOn: { color: '#fff' },
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
  askAiBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: T.blueDeep, borderRadius: 9, paddingHorizontal: 11, height: 32 },
  askAiText: { color: '#fff', fontSize: 12.5, fontWeight: '800' },
  aiBanner: { backgroundColor: 'rgba(79,141,255,0.07)', borderWidth: 1, borderColor: 'rgba(79,141,255,0.18)', borderRadius: 14, padding: 12, marginBottom: 10 },
  aiBannerHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  aiBannerTitle: { fontSize: 12.5, fontWeight: '800', color: T.blueDeep },
  aiClear: { fontSize: 12.5, fontWeight: '700', color: T.textMuted },
  aiChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 9 },
  aiChip: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: T.surface, borderWidth: 1, borderColor: T.border, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5 },
  aiChipAlt: { backgroundColor: 'rgba(124,107,255,0.10)', borderColor: 'rgba(124,107,255,0.25)' },
  aiChipText: { fontSize: 11.5, fontWeight: '700', color: T.textMuted },
  aiCount: { fontSize: 11.5, fontWeight: '700', color: T.blueDeep, marginTop: 9 },
  webRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 7 },
  webText: { fontSize: 11.5, fontWeight: '700', color: T.textMuted },

  scopeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  scopePill: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: T.surface, borderRadius: 12, borderWidth: 1, borderColor: T.border, paddingHorizontal: 12, height: 42 },
  scopePillText: { flex: 1, fontSize: 13.5, fontWeight: '800', color: T.ink },
  ownTag: { backgroundColor: 'rgba(16,185,129,0.12)', borderRadius: 100, paddingHorizontal: 8, paddingVertical: 3 },
  ownTagText: { fontSize: 10, fontWeight: '800', color: T.emerald },
  showAllBtn: { paddingHorizontal: 10, height: 42, justifyContent: 'center' },
  showAllText: { fontSize: 12.5, fontWeight: '700', color: T.blueDeep },

  controlsRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  sortToggle: { flexDirection: 'row', backgroundColor: T.surface, borderRadius: 12, borderWidth: 1, borderColor: T.border, padding: 3, flex: 1 },
  sortBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, height: 34, borderRadius: 9 },
  sortBtnOn: { backgroundColor: T.blue },
  sortText: { fontSize: 12.5, fontWeight: '700', color: T.textMuted },
  sortTextOn: { color: '#fff' },
  filterBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: 14, borderRadius: 12, backgroundColor: T.surface, borderWidth: 1, borderColor: T.border },
  filterBtnOn: { backgroundColor: T.blueDeep, borderColor: T.blueDeep },
  filterBtnText: { fontSize: 12.5, fontWeight: '700', color: T.blueDeep },
  filterBar: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, paddingHorizontal: 14, borderRadius: 12, backgroundColor: T.surface, borderWidth: 1, borderColor: T.border, marginBottom: 8 },
  filterBarOn: { backgroundColor: T.blueDeep, borderColor: T.blueDeep },
  filterBarText: { flex: 1, fontSize: 13, fontWeight: '700', color: T.blueDeep },
  hintBox: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: 'rgba(79,141,255,0.08)', borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9, marginBottom: 8 },
  hintText: { fontSize: 12, color: T.blueDeep, fontWeight: '600', flex: 1 },
  countLine: { fontSize: 12, color: T.textMuted, fontWeight: '600', marginBottom: 8, marginLeft: 2 },

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
  roleTag: { fontSize: 11, color: T.purple, marginTop: 3, fontWeight: '700' },
  matchBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 100, borderWidth: 1 },
  matchText: { fontSize: 11.5, fontWeight: '800' },
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

  // filters sheet
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(6,10,25,0.45)' },
  sheet: { backgroundColor: T.bg, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingTop: 8, paddingHorizontal: 18, paddingBottom: 28 },
  sheetGrip: { alignSelf: 'center', width: 40, height: 4, borderRadius: 100, backgroundColor: 'rgba(11,15,34,0.14)', marginBottom: 10 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: T.ink },
  clearText: { fontSize: 13, fontWeight: '700', color: T.blueDeep },
  fSection: { marginTop: 14 },
  fSectionTitle: { fontSize: 12, fontWeight: '800', color: T.textFaint, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 9 },
  fChipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  fChip: { paddingHorizontal: 13, paddingVertical: 8, borderRadius: 100, backgroundColor: T.surface, borderWidth: 1, borderColor: T.border, maxWidth: 300 },
  fChipOn: { backgroundColor: T.blue, borderColor: T.blue },
  fChipText: { fontSize: 12.5, fontWeight: '700', color: T.textMuted },
  fChipTextOn: { color: '#fff' },
  applySheet: { marginTop: 14, borderRadius: 14, overflow: 'hidden' },
  applySheetGrad: { height: 50, alignItems: 'center', justifyContent: 'center' },
  applySheetText: { color: '#fff', fontSize: 15, fontWeight: '800' },

  // always-on floating "Live jobs on Google" pill (bottom-center; clears the help FAB at bottom-right)
  // Movable circular Filters button — floats near where the old header filter button sat.
  filterFab: { position: 'absolute', right: FFAB.right, top: FFAB.top, zIndex: 997 },
  filterFabBtn: {
    width: FFAB.size, height: FFAB.size, borderRadius: FFAB.size / 2, backgroundColor: T.surface,
    borderWidth: 1, borderColor: T.border, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#0F172A', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.18, shadowRadius: 12, elevation: 7,
  },
  filterFabBtnOn: { backgroundColor: T.blueDeep, borderColor: T.blueDeep },
  // Local network search inside the Filters sheet.
  localRow: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#F4F7FC', borderWidth: 1, borderColor: T.border, borderRadius: 12, paddingHorizontal: 12, height: 46 },
  localInput: { flex: 1, fontSize: 13.5, color: T.ink, paddingVertical: 0 },
  localBtn: { backgroundColor: T.blueDeep, borderRadius: 9, paddingHorizontal: 13, height: 34, alignItems: 'center', justifyContent: 'center' },
  localBtnTx: { color: '#fff', fontSize: 12.5, fontWeight: '800' },
  localHint: { fontSize: 11, color: T.textFaint, fontWeight: '600', marginTop: 6, marginLeft: 2 },
  // First-visit "how searching works" popup.
  introOverlay: { flex: 1, backgroundColor: 'rgba(6,10,25,0.6)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  introCard: { width: '100%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 22, padding: 16 },
  introHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  introTitle: { flex: 1, fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.2 },
  introSub: { fontSize: 12.5, color: T.textMuted, lineHeight: 18, marginBottom: 10 },
  introGif: { width: '100%', height: Math.min(SCH * 0.5, 480), borderRadius: 14, backgroundColor: '#F1F5F9' },
  introBtn: { marginTop: 12, borderRadius: 14, overflow: 'hidden' },
  introBtnGrad: { height: 48, alignItems: 'center', justifyContent: 'center' },
  introBtnTx: { color: '#fff', fontSize: 14.5, fontWeight: '800' },
  filterDot: { position: 'absolute', top: -5, right: -5, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: '#FB923C', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, borderWidth: 1.5, borderColor: '#fff' },
  filterDotTx: { fontSize: 10, fontWeight: '800', color: '#fff' },
  countRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 },
  recentBox: { backgroundColor: T.surface, borderRadius: 14, borderWidth: 1, borderColor: T.border, paddingHorizontal: 6, paddingVertical: 4, marginBottom: 10, marginTop: -4 },
  recentHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingTop: 6, paddingBottom: 4 },
  recentTitle: { fontSize: 11, fontWeight: '800', color: T.textFaint, textTransform: 'uppercase', letterSpacing: 0.4 },
  recentClear: { fontSize: 12, fontWeight: '700', color: T.blueDeep },
  recentRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 8, paddingVertical: 10, borderRadius: 10 },
  recentRowTx: { flex: 1, fontSize: 14, color: T.ink, fontWeight: '600' },
});
