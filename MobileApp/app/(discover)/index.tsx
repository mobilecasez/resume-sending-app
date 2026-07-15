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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import {
  fetchDiscoverJobs, fetchDiscoverFacets, aiSearchJobs, hydrateJobUrls,
  type DiscoverJob, type DiscoverFacets, type AiSearchParsed, type AiXray,
} from '../../services/aiHubService';
import { logEvent } from '../../services/firebaseAnalytics';
import HelpAssistant from '../../components/HelpAssistant';
import SilentWebSearch from '../../components/SilentWebSearch';
import LiveJobSearch from '../../components/LiveJobSearch';
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

function JobCard({ job, onOpen }: { job: DiscoverJob; onOpen: (j: DiscoverJob) => void }) {
  const c = gradFor(job.employer_name || job.title);
  const skills = Array.isArray(job.skills) ? job.skills : [];
  const resp = Array.isArray(job.responsibilities) ? job.responsibilities : [];
  return (
    <TouchableOpacity style={styles.card} activeOpacity={0.85} onPress={() => onOpen(job)}>
      <View style={styles.cardHead}>
        <LinearGradient colors={c} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.logo}><Text style={styles.logoText}>{initial(job.employer_name)}</Text></LinearGradient>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.jobTitle} numberOfLines={3}>{job.title}</Text>
          <Text style={styles.jobCompany} numberOfLines={2}>{job.employer_name || 'Company'}</Text>
          {!!job.role_category && <Text style={styles.roleTag} numberOfLines={1}>{job.role_category}</Text>}
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

// Reusable Explore feed. `embedded` renders JUST the feed (no SafeAreaView / top bar / Explore|Saved
// sub-tabs) so the Job Hub can mount it as its "Search" tab; the standalone /(discover) route wraps it.
export function ExploreFeed({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
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
  const [sort, setSort] = useState<'match' | 'recent'>('match');
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
  // When the scope field changes, refresh facets so the Role list matches the field.
  useEffect(() => { if (field) fetchDiscoverFacets(field).then(setFacets).catch(() => {}); }, [field]);

  useEffect(() => {
    const t = setTimeout(async () => { setLoading(true); await load({ offset: 0, append: false }); setLoading(false); }, 300);
    return () => clearTimeout(t);
  }, [load]);

  const onRefresh = useCallback(async () => { setRefreshing(true); await Promise.all([load({ offset: 0, append: false }), fetchDiscoverFacets(field).then(setFacets).catch(() => {})]); setRefreshing(false); }, [load, field]);
  const onEnd = useCallback(async () => { if (loadingMore || jobs.length >= total || loading) return; setLoadingMore(true); await load({ offset: jobs.length, append: true }); setLoadingMore(false); }, [loadingMore, jobs.length, total, loading, load]);
  const openJob = useCallback((dj: DiscoverJob) => { router.push({ pathname: '/(ai-hub)/job-detail', params: toJobHubParams(dj) }); }, [router]);
  const clearFilters = () => { setMode(''); setSkill(''); setCountry(''); setEmployer(''); setRoleCat(''); };

  // AI natural-language search: parse the sentence → search the network → show ranked matches.
  const runAiSearch = useCallback(async (q: string) => {
    const query = (q || '').trim();
    if (!query) return;
    setAiLoading(true); setAiActive(true); setWebNote(''); setWebPhase('');
    try {
      const data = await aiSearchJobs(query, 0, 30);
      if (data.urlDetected && data.url) {
        setAiActive(false);
        Alert.alert('Employer link detected', 'Add this link in Job Hub to research every open role at this employer.', [{ text: 'OK' }]);
        return;
      }
      setAiParsed(data.parsed || null); setAiResults(data.jobs || []); setAiTotal(data.total || 0);
      setAiHasMore(!!data.hasMore); lastQueryRef.current = query;
      if (typeof data.noProfile === 'boolean') setNoProfile(data.noProfile);
      // Kick off the silent on-device web search to find MORE jobs across the ATS web (user IP).
      // Google (far richer index) as primary + DDG-lite as fallback, each as a SEPARATE per-site query.
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
      // Re-run the network search — it now includes the freshly-ingested jobs.
      const fresh = await aiSearchJobs(q, 0, 30);
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
  // Always-on "Live jobs on Google": use whatever the user is searching for; if nothing yet, nudge them to type.
  const openLive = useCallback(() => {
    const q = (lastQueryRef.current || query).trim();
    if (q) { setLiveQuery(q); setLiveOpen(true); }
    else { searchRef.current?.focus(); }
  }, [query]);

  const pickField = (f: string) => { const nf = f === field ? '' : f; setField(nf); setRoleCat(''); };

  const scopeLabel = field ? shortField(field) : 'All fields';
  const isOwnField = !!field && field === userField;

  const header = useMemo(() => (
    <View>
      <HeroCard facets={facets} total={total} />
      <View style={styles.searchWrap}>
        <Ionicons name="sparkles" size={16} color={T.blueDeep} />
        <TextInput ref={searchRef} value={query} onChangeText={setQuery} placeholder="Describe the job you want — AI finds it" placeholderTextColor={T.textFaint} style={styles.searchInput} autoCapitalize="none" autoCorrect={false} returnKeyType="search" onSubmitEditing={() => runAiSearch(query)} />
        {query.length > 0 && <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}><Ionicons name="close-circle" size={17} color={T.textFaint} /></TouchableOpacity>}
        <TouchableOpacity onPress={() => runAiSearch(query)} disabled={!query.trim() || aiLoading} style={[styles.askAiBtn, (!query.trim() || aiLoading) && { opacity: 0.5 }]} activeOpacity={0.85}>
          {aiLoading ? <ActivityIndicator size="small" color="#fff" /> : <><Ionicons name="arrow-forward" size={13} color="#fff" /><Text style={styles.askAiText}>Ask AI</Text></>}
        </TouchableOpacity>
      </View>

      {aiActive && (
        <View style={styles.aiBanner}>
          <View style={styles.aiBannerHead}>
            <Ionicons name="sparkles" size={13} color={T.blueDeep} />
            <Text style={styles.aiBannerTitle}>AI understood your search</Text>
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
          <Text style={styles.aiCount}>{aiLoading ? 'Searching the network…' : `${fmt(aiTotal)} ${aiTotal === 1 ? 'match' : 'matches'} found`}</Text>
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

      {!aiActive && (<>
      {/* Field scope pill: defaults to the user's field, tap to change, clear to browse all */}
      <View style={styles.scopeRow}>
        <TouchableOpacity onPress={() => setShowFilters(true)} style={styles.scopePill} activeOpacity={0.85}>
          <Ionicons name="layers-outline" size={14} color={T.blueDeep} />
          <Text style={styles.scopePillText} numberOfLines={1}>{scopeLabel}</Text>
          {isOwnField && <View style={styles.ownTag}><Text style={styles.ownTagText}>your field</Text></View>}
          <Ionicons name="chevron-down" size={14} color={T.textMuted} />
        </TouchableOpacity>
        {!!field && (
          <TouchableOpacity onPress={() => { setField(''); setRoleCat(''); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.showAllBtn}>
            <Text style={styles.showAllText}>All fields</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.controlsRow}>
        <View style={styles.sortToggle}>
          {(['match', 'recent'] as const).map((s) => (
            <TouchableOpacity key={s} onPress={() => setSort(s)} style={[styles.sortBtn, sort === s && styles.sortBtnOn]} activeOpacity={0.8}>
              <Ionicons name={s === 'match' ? 'sparkles' : 'time-outline'} size={13} color={sort === s ? '#fff' : T.textMuted} />
              <Text style={[styles.sortText, sort === s && styles.sortTextOn]}>{s === 'match' ? 'Best match' : 'Recent'}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity onPress={() => setShowFilters(true)} style={[styles.filterBtn, activeCount > 0 && styles.filterBtnOn]} activeOpacity={0.8}>
          <Ionicons name="options-outline" size={16} color={activeCount > 0 ? '#fff' : T.blueDeep} />
          <Text style={[styles.filterBtnText, activeCount > 0 && { color: '#fff' }]}>{activeCount > 0 ? `Filters · ${activeCount}` : 'Filters'}</Text>
        </TouchableOpacity>
      </View>

      {sort === 'match' && noProfile && (
        <View style={styles.hintBox}><Ionicons name="information-circle-outline" size={15} color={T.blueDeep} /><Text style={styles.hintText}>Upload your résumé in Account Settings to see match scores and your-field jobs.</Text></View>
      )}
      <Text style={styles.countLine}>
        {fmt(total)} {total === 1 ? 'job' : 'jobs'}
        {isOwnField && !noProfile ? ' · your field, best matches' : (field ? ` · ${shortField(field)}` : '')}
      </Text>
      </>)}

      {/* Inline "search live on Google" — contextual, always under the search area (replaces the floating pill) */}
      <TouchableOpacity onPress={openLive} activeOpacity={0.85} style={styles.liveBar}>
        <Ionicons name="globe-outline" size={15} color={T.blueDeep} />
        <Text style={styles.liveBarText}>Not finding it? <Text style={{ fontWeight: '800' }}>Search live on Google</Text></Text>
        <Ionicons name="arrow-forward" size={14} color={T.blueDeep} />
      </TouchableOpacity>
    </View>
  ), [facets, total, query, sort, activeCount, noProfile, field, userField, scopeLabel, isOwnField, aiActive, aiLoading, aiParsed, aiTotal, webPhase, webNote, runAiSearch, clearAiSearch, openLive]);

  // Only blank to a spinner on the FIRST load (no data yet). A re-load triggered by facets setting the
  // field must NOT clear the screen — that was the "shows page → blank → reloads" flicker on the tab.
  const feedContent = (loading && jobs.length === 0 && !aiActive) ? (
    <View style={styles.center}><ActivityIndicator color={T.blue} size="large" /></View>
  ) : (
    <FlatList
      data={aiActive ? aiResults : jobs} keyExtractor={(j, i) => j.id + ':' + i}
      renderItem={({ item }) => <JobCard job={item} onOpen={openJob} />}
      ListHeaderComponent={header}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.blue} />}
      onEndReached={aiActive ? onAiEnd : onEnd} onEndReachedThreshold={0.6}
      removeClippedSubviews initialNumToRender={6} windowSize={9}
      contentContainerStyle={{ padding: 12, paddingBottom: embedded ? 120 : 96 }}
      ListEmptyComponent={aiActive
        ? <View style={styles.empty}>{aiLoading ? <ActivityIndicator color={T.blue} /> : <><Ionicons name="search-outline" size={40} color={T.textFaint} /><Text style={styles.emptyText}>No matches in the network yet — try different words, or tap “Search live on Google” above.</Text></>}</View>
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
            <ScrollView style={{ maxHeight: 460 }} showsVerticalScrollIndicator={false}>
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
      {!embedded && <HelpAssistant />}
      {xrayUrls.length > 0 && <SilentWebSearch key={xraySeq} urls={xrayUrls} onResult={onXrayResult} />}
      <LiveJobSearch visible={liveOpen} query={liveQuery} onClose={() => setLiveOpen(false)} />
    </>
  );

  // Embedded (Job Hub "Search" tab): just the feed + overlays, no screen chrome.
  if (embedded) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg }}>
        {feedContent}
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
      {overlays}
    </SafeAreaView>
  );
}

export default function DiscoverScreen() { return <ExploreFeed />; }

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
  hintBox: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: 'rgba(79,141,255,0.08)', borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9, marginBottom: 8 },
  hintText: { fontSize: 12, color: T.blueDeep, fontWeight: '600', flex: 1 },
  countLine: { fontSize: 12, color: T.textMuted, fontWeight: '600', marginBottom: 8, marginLeft: 2 },

  card: { backgroundColor: T.surface, borderRadius: 20, borderWidth: 1, borderColor: T.border, padding: 15, marginBottom: 12, shadowColor: '#0F172A', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.06, shadowRadius: 18, elevation: 2 },
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
  liveFabWrap: { position: 'absolute', left: 0, right: 0, bottom: Platform.OS === 'ios' ? 30 : 22, alignItems: 'center', zIndex: 998 },
  liveFabShadow: { borderRadius: 100, shadowColor: '#2563EB', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 12, elevation: 8 },
  liveFab: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, height: 50, borderRadius: 100 },
  liveFabText: { color: '#fff', fontSize: 14.5, fontWeight: '800', letterSpacing: -0.2 },
  liveBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: 'rgba(37,99,235,0.06)', borderWidth: 1, borderColor: 'rgba(37,99,235,0.18)', borderRadius: 12, paddingVertical: 11, paddingHorizontal: 12, marginTop: 2, marginBottom: 6 },
  liveBarText: { fontSize: 12.5, color: T.textMuted, fontWeight: '600' },
});
