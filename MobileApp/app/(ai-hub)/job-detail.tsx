// AI Hub — new feature. Safe to delete without affecting existing app.

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Linking,
  Platform,
  Alert,
  Animated,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  ActivityIndicator,
  AppState,
  AppStateStatus,
  Clipboard,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { RESUME_REGION_OPTIONS, REGION_OPTIONS, regionFromCountry, regionLabel, fmtLocation, employerAddress } from '../../regionUtils';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { File as FSFile, Paths } from 'expo-file-system';
import { track } from '../../services/analytics';
import { downloadAsync, cacheDirectory } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { startJobCoverLetter, pollJobCoverLetter, saveJobCoverLetter, loadJobCoverLetter, updateJobCLStatus, getJobContacts, fetchJobFull, translateJob, translateBatch, getSmartFillData, recordAutofillMemory, getJobUrlOverride, updateJobUrl, isLinkedInJobUrl, captureJob, type LinkedInJob, type TranslatedJob, type SmartFillData, type CapturedJob } from '../../services/aiHubService';
import LinkedInJobLoader from '../../components/LinkedInJobLoader';
import { API_BASE } from '../../config';
import { SUBMIT_DETECT_JS, CONFIRM_URL_RE } from './submitDetect';
import CreditCostPill from '../../components/CreditCostPill';
import JobToolsDock from '../../components/JobToolsDock';
import { useEventCosts } from '../../hooks/useEventCosts';
import RatingPromptModal, { useRatingPrompt } from '../../components/RatingPromptModal';
import { canonicalJobUrl, isAuthUrl } from '../../utils/jobUrl';
import { FRAME_GUARD_JS, AUTH_FLOW_JS } from '../../utils/webviewAuth';
import { xlateScanJS, xlateApplyJS, XLATE_RESTORE_JS, XLATE_WATCH_JS, runXlatePasses, type XlateItem } from '../../utils/webviewTranslate';
import { PAGE_TEXT_FN } from '../../utils/webviewPageText';
import type { Contact, Job, Employer } from '../../types/aiHub';

// Lightweight CLIENT-SIDE check: should we offer "Translate to English" for this
// job? Runs on the data already in the app — no network call, no backend/search
// cost. Biased to SHOW the toggle for non-English jobs (German/French/Dutch/…)
// and hide it for English ones. The actual translation happens only on tap.
const _TR_EN = ['the','and','for','with','you','your','our','are','will','we','this','that','have','from','experience','team','work','role','skills','requirements','responsibilities'];
const _TR_NONEN = ['und','der','die','das','für','mit','sie','ihre','wir','sind','aufgaben','kenntnisse','erfahrung','les','des','une','pour','avec','vous','nous','votre','het','een','van','voor','los','para','con','gli','esperienza'];
const _TR_DIA = /[äöüßàâçéèêëîïôûùœñãõ]/i;
const _TR_GENDER = /\(?\s*[mwfdx]\s*\/\s*[mwfdx]\s*\/\s*[mwfdx]\s*\)?/i;
const _TR_MORPH = ['entwickler','mitarbeiter','sachbearbeiter','bauleiter','gesucht','vertrieb','fachkraft','ingénieur','développeur','responsable','technicien','geschäft'];
function isLikelyNonEnglish(text: string): boolean {
  const raw = String(text || '');
  if (_TR_GENDER.test(raw)) return true;
  const toks = raw.toLowerCase().match(/[a-zà-ÿ]+/gi) || [];
  if (toks.length < 3) return false;
  const set = new Set(toks);
  const en = _TR_EN.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
  const non = _TR_NONEN.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
  const morph = toks.some((t) => _TR_MORPH.some((m) => t.includes(m)));
  if (_TR_DIA.test(raw) && en <= 2) return true;
  if (morph && en === 0) return true;
  if (non >= 2 && non >= en) return true;
  if (non >= 1 && en === 0) return true;
  return false;
}

async function getToken(): Promise<string | null> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    if (!raw) return null;
    return JSON.parse(raw)?.token ?? null;
  } catch { return null; }
}

// ─── Minimize-resilient request: POST → { jobId } → poll the job → result ──────
// The heavy work (AI / PDF render) runs as a server-side job, so backgrounding the
// app mid-request can't kill it. Polling PAUSES while the app is inactive and
// resumes on foreground — identical to the cover-letter generation flow.
function pollJobResult(jobId: string, token: string | null): Promise<any> {
  return new Promise((resolve, reject) => {
    let state: AppStateStatus = AppState.currentState;
    let attempts = 0;                       // active-state polls; caps total wait (~5 min)
    const sub = AppState.addEventListener('change', (next) => { state = next; });
    const cleanup = () => { try { sub.remove(); } catch {} };
    const tick = async () => {
      if (state !== 'active') { setTimeout(tick, 1000); return; }   // paused while backgrounded
      try {
        const r = await fetch(`${API_BASE}/ai-hub/job-status/${jobId}`, { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json().catch(() => ({}));
        if (d.status === 'completed') { cleanup(); resolve(d.data); return; }
        if (d.status === 'failed') { cleanup(); reject(new Error(d.error || 'Job failed')); return; }
        // 404 (job gone/expired) / 401 / 403 etc. are valid JSON with NO status — terminate,
        // don't poll forever (which would also leak the AppState listener).
        if (!r.ok) { cleanup(); reject(new Error(d.error || `Request failed (${r.status})`)); return; }
        if (++attempts > 150) { cleanup(); reject(new Error('This is taking too long — please try again.')); return; }
        setTimeout(tick, 2000);
      } catch { setTimeout(tick, 2000); }   // transient network error — keep retrying
    };
    tick();
  });
}

// POST that always survives minimize: asks the server to run async (__async), then polls.
// Falls back transparently to the sync response if the server didn't return a jobId.
async function postAndPoll(path: string, body: any, token: string | null): Promise<any> {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(body || {}), __async: true }),
  });
  const data = await r.json().catch(() => ({}));
  if (data && data.jobId) return pollJobResult(data.jobId, token);
  // Sync fallback (older server / job-creation fallback). Surface real HTTP errors so the
  // caller's catch fires instead of silently degrading to an "empty success".
  if (!r.ok) throw new Error((data && data.error) || `Request failed (${r.status})`);
  return data;
}

// A clean platform-browser UA for the apply WebView. WKWebView's default UA is flagged by Google
// ("disallowed_useragent") and LinkedIn as an embedded webview → "Sign in with Google/LinkedIn"
// silently dies or spins forever. A real mobile-browser UA makes OAuth serve its redirect-based
// flow that completes inside one WebView (same fix Browse & Fetch uses).
const BROWSER_UA = Platform.OS === 'android'
  ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
  : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

// True only for a real DB job id (UUID). Live/web/LinkedIn cards arrive with a synthetic id
// (gj_… / hashId) — those need a capture round-trip to get a canonical UUID for tracking.
const isUuid = (s?: string | null): boolean =>
  !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// "Not specified" / "Location TBD" are TRUTHY strings, so they used to win over a real captured
// location and then get stripped server-side as placeholders — leaving the letter with no location.
const isRealLoc = (v?: string | null): boolean =>
  !!v && !/^(not\s*(specified|available|provided)|location\s*tbd|tbd|n\.?\/?a\.?|none|null|unknown)$/i.test(String(v).trim());

// One-shot grab of the job page's visible text (the "actual job details" page the user is viewing),
// so the backend can extract responsibilities/description for the cover letter. Namespaced __cvf.
const GRAB_JOB_TEXT_JS = `(function(){ try {
  var t = (document.body && document.body.innerText) || '';
  var o = { type:'JOB_PAGE_TEXT', text:String(t).slice(0,16000), title:String(document.title||''), url:String(location.href||'') };
  o.__cvf = true; window.ReactNativeWebView.postMessage(JSON.stringify(o));
} catch(e){} })(); true;`;

// On-demand grab for the "Fetch job" dock action — captures WHATEVER page the user is looking at
// right now (they may have browsed from a listing to a specific job), on its own message type so it
// never trips the once-per-session cover-letter prefetch. Also carries a rough login/challenge signal
// so we can tell the user why a protected page couldn't be read instead of a blank failure.
const FETCH_PAGE_JS = `(function(){ try {
  ${PAGE_TEXT_FN}
  var t = (document.body && document.body.innerText) || '';
  var low = t.slice(0, 4000).toLowerCase();
  var wall = (/log ?in|sign ?in|please sign|create an account/.test(low) && t.length < 1200)
    ? 'login'
    : (/verify you are human|are you a robot|captcha|unusual traffic|checking your browser/.test(low) ? 'challenge' : '');
  var o = { type:'FETCH_PAGE', text:String(t).slice(0,16000), mainText:String(cvfMainText()).slice(0,16000), title:String(document.title||''), url:String(location.href||''), wall:wall };
  o.__cvf = true; window.ReactNativeWebView.postMessage(JSON.stringify(o));
} catch(e){} })(); true;`;

// ─── Theme (matches index.tsx exactly) ────────────────────────────
const T = {
  bg:       '#E5EAF3',
  bgSoft:   '#EDF1F8',
  surface:  '#FFFFFF',
  ink:      '#0B0F22',
  inkSoft:  '#1A2046',
  textMuted:'#5A6480',
  textFaint:'#8A93B2',
  border:   'rgba(11,15,34,0.06)',
  borderHi: 'rgba(11,15,34,0.10)',
  blue:     '#4F8DFF',
  blueDeep: '#2563EB',
  emerald:  '#10B981',
  rose:     '#EF4444',
  amber:    '#F59E0B',
};

// ─── Mock data (fallback for testing) ────────────────────────────
const MOCK_EMPLOYERS: Employer[] = [{
  id: 'apple', name: 'Apple Inc.', subInfo: 'Cupertino, CA · Technology',
  logoColor: ['#555555', '#1C1C1E'], logoInitial: 'A', status: 'active',
  jobs: [{
    id: 'apple-job-1', title: 'Senior Software Engineer — SwiftUI',
    location: 'Cupertino, CA', experience: '5+ years', salary: '$200K–$260K',
    jobType: 'Full-time', urgent: false,
    skills: ['SwiftUI', 'Combine', 'Core Data', 'UIKit', 'Xcode'],
    responsibilities: ['Build iOS features with SwiftUI', 'Maintain Core Data layer', 'Code reviews'],
    contacts: [{ id: 'c1', name: 'Sarah Chen', role: 'Engineering Manager', email: 's.chen@apple.com', verified: true, avatarColor: ['#06B6D4', '#3B82F6'] }],
  }],
}];

// ─── Contact row (matches index.tsx) ─────────────────────────────
function ContactRow({ contact }: { contact: Contact }) {
  const initials = contact.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
  return (
    <View style={s.contactRow}>
      <LinearGradient colors={contact.avatarColor} style={s.avatar}>
        <Text style={s.avatarText}>{initials}</Text>
      </LinearGradient>
      <View style={{ flex: 1 }}>
        <Text style={s.contactName}>{contact.name}</Text>
        <Text style={s.contactRole}>{contact.role}</Text>
        {!!contact.email && (
          <Text style={s.contactEmail} numberOfLines={1}>{contact.email}</Text>
        )}
      </View>
      {contact.verified && (
        <View style={s.verifiedBadge}>
          <Ionicons name="checkmark-circle" size={16} color={T.emerald} />
        </View>
      )}
    </View>
  );
}

// ─── Cover Letter Modal ───────────────────────────────────────────
// ─── Generate Cover Letter Button (exact clone of HomeScreen GenerateButton) ──
type CLBtnState = 'idle' | 'loading' | 'done';
function GenerateCLButton({ state, progress, progressAnim, label, onPress }: {
  state: CLBtnState; progress: number; progressAnim: Animated.Value; label: string; onPress: () => void;
}) {
  const { costs } = useEventCosts();
  const spinAnim = useRef(new Animated.Value(0)).current;
  const shimAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (state === 'loading') {
      Animated.loop(Animated.timing(spinAnim, { toValue: 1, duration: 800, useNativeDriver: true })).start();
      Animated.loop(Animated.timing(shimAnim, { toValue: 1, duration: 2200, useNativeDriver: true })).start();
    } else { spinAnim.stopAnimation(); shimAnim.stopAnimation(); }
  }, [state]);
  const spin  = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const shimX = shimAnim.interpolate({ inputRange: [0, 1], outputRange: [-160, 360] });
  const fillW = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  if (state === 'idle') return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={btn.wrap}>
      <LinearGradient colors={['#4F8DFF', '#7C6BFF', '#5B4FE8']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={btn.idleContent}>
        <Ionicons name="sparkles" size={14} color="#fff" />
        <Text style={btn.label}>Generate Cover Letter</Text>
        <CreditCostPill credits={costs['job_cover_letter'] ?? null} tone="dark" style={{ marginLeft: 2 }} />
      </View>
      <View style={btn.arrowPill}>
        <Ionicons name="arrow-forward" size={14} color="#fff" />
      </View>
    </TouchableOpacity>
  );

  if (state === 'loading') return (
    <View style={[btn.wrap, { backgroundColor: '#9FB9E8' }]}>
      <Animated.View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: fillW, overflow: 'hidden' }}>
        <LinearGradient colors={[T.blue, '#7C6BFF']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, width: 80, transform: [{ translateX: shimX }] }}>
        <LinearGradient colors={['transparent', 'rgba(255,255,255,0.28)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <View style={[btn.idleContent, { justifyContent: 'space-between', paddingRight: 14, zIndex: 2 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Animated.View style={[btn.spinner, { transform: [{ rotate: spin }] }]} />
          <Text style={btn.label} numberOfLines={1}>{label}</Text>
        </View>
        <Text style={btn.pct}>{Math.round(progress)}%</Text>
      </View>
    </View>
  );

  return (
    <View style={[btn.wrap, { overflow: 'hidden' }]}>
      <LinearGradient colors={['#10B981', '#059669']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
      <View style={btn.idleContent}>
        <Ionicons name="checkmark-circle" size={14} color="#fff" />
        <Text style={btn.label}>Generated ✓</Text>
      </View>
    </View>
  );
}

// ─── Download PDF Button (clone of HomeScreen DownloadButton) ─────────────────
function DownloadCLButton({ state, progress, progressAnim, onPress }: {
  state: CLBtnState; progress: number; progressAnim: Animated.Value; onPress: () => void;
}) {
  const spinAnim = useRef(new Animated.Value(0)).current;
  const shimAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (state === 'loading') {
      Animated.loop(Animated.timing(spinAnim, { toValue: 1, duration: 800, useNativeDriver: true })).start();
      Animated.loop(Animated.timing(shimAnim, { toValue: 1, duration: 2000, useNativeDriver: true })).start();
    } else { spinAnim.stopAnimation(); shimAnim.stopAnimation(); }
  }, [state]);
  const spin  = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const shimX = shimAnim.interpolate({ inputRange: [0, 1], outputRange: [-120, 300] });
  const fillW = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const isLoading = state === 'loading';
  const isDone    = state === 'done';

  return (
    <TouchableOpacity onPress={onPress} disabled={isLoading} activeOpacity={isLoading ? 1 : 0.82} style={[btn.dlWrap, { flex: 1 }]}>
      {(isLoading || isDone) && <View style={[StyleSheet.absoluteFill, { backgroundColor: '#9FB9E8', borderRadius: 12 }]} />}
      {(isLoading || isDone) && (
        <Animated.View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: isDone ? '100%' : fillW, borderRadius: 12, overflow: 'hidden' }}>
          <LinearGradient colors={['#0B0F22', '#2D3748']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      )}
      {isLoading && (
        <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, width: 60, transform: [{ translateX: shimX }], zIndex: 1 }}>
          <LinearGradient colors={['transparent', 'rgba(255,255,255,0.22)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      )}
      <View style={[btn.dlContent, { zIndex: 2 }]}>
        {isLoading
          ? <Animated.View style={[btn.spinner, { transform: [{ rotate: spin }] }]} />
          : <Ionicons name={isDone ? 'checkmark-circle' : 'download-outline'} size={14} color={(isDone || isLoading) ? '#fff' : T.ink} />
        }
        <Text style={[btn.dlLabel, (!isDone && !isLoading) && { color: T.ink }]}>
          {isDone ? 'Downloaded ✓' : isLoading ? 'Downloading…' : 'Download PDF'}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// In-button busy state for the Preview button — keeps a STABLE width and shows the same
// rotating-ring + shimmer treatment as the cover-letter buttons (indeterminate; no % to show).
function PreviewBusyContent() {
  const spinAnim = useRef(new Animated.Value(0)).current;
  const shimAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.timing(spinAnim, { toValue: 1, duration: 800, useNativeDriver: true }));
    const b = Animated.loop(Animated.timing(shimAnim, { toValue: 1, duration: 1400, useNativeDriver: true }));
    a.start(); b.start();
    return () => { a.stop(); b.stop(); };
  }, []);
  const spin  = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const shimX = shimAnim.interpolate({ inputRange: [0, 1], outputRange: [-130, 130] });
  return (
    <>
      <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, width: 70, transform: [{ translateX: shimX }] }}>
        <LinearGradient colors={['transparent', 'rgba(79,141,255,0.18)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View style={[btn.spinner, { borderColor: 'rgba(79,141,255,0.30)', borderTopColor: T.blue, transform: [{ rotate: spin }] }]} />
      <Text style={s.previewBtnText}>Preview</Text>
    </>
  );
}

// In-button progress for the "Apply via Mail" button (white spinner + shimmer on the gradient).
function MailPrepContent() {
  const spinAnim = useRef(new Animated.Value(0)).current;
  const shimAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.timing(spinAnim, { toValue: 1, duration: 800, useNativeDriver: true }));
    const b = Animated.loop(Animated.timing(shimAnim, { toValue: 1, duration: 1400, useNativeDriver: true }));
    a.start(); b.start();
    return () => { a.stop(); b.stop(); };
  }, []);
  const spin  = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const shimX = shimAnim.interpolate({ inputRange: [0, 1], outputRange: [-160, 220] });
  return (
    <>
      <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, width: 80, transform: [{ translateX: shimX }] }}>
        <LinearGradient colors={['transparent', 'rgba(255,255,255,0.25)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View style={[btn.spinner, { transform: [{ rotate: spin }] }]} />
      <Text style={s.applyBtnText}>Preparing…</Text>
    </>
  );
}

// Icon-only Download PDF button — same progress treatment as DownloadCLButton, just compact.
function DownloadIconButton({ state, progressAnim, onPress }: {
  state: CLBtnState; progressAnim: Animated.Value; onPress: () => void;
}) {
  const spinAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (state === 'loading') Animated.loop(Animated.timing(spinAnim, { toValue: 1, duration: 800, useNativeDriver: true })).start();
    else spinAnim.stopAnimation();
  }, [state]);
  const spin  = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const fillW = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const isLoading = state === 'loading';
  const isDone    = state === 'done';
  // Done = a clean green circular tick (no dark fill); loading = progress fill + spinner.
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={isLoading}
      activeOpacity={isLoading ? 1 : 0.82}
      style={[btn.iconBtn, isDone && { borderColor: 'rgba(16,185,129,0.45)', backgroundColor: 'rgba(16,185,129,0.10)' }]}
    >
      {/* Base layer so the centred white spinner is never white-on-white before the fill reaches it */}
      {isLoading && <View style={[StyleSheet.absoluteFill, { backgroundColor: '#9FB9E8' }]} />}
      {isLoading && (
        <Animated.View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: fillW, backgroundColor: '#0B0F22' }} />
      )}
      {isLoading
        ? <Animated.View style={[btn.spinner, { transform: [{ rotate: spin }] }]} />
        : isDone
          ? <Ionicons name="checkmark-circle" size={22} color={T.emerald} />
          : <Ionicons name="document-text-outline" size={18} color={T.ink} />
      }
    </TouchableOpacity>
  );
}

const btn = StyleSheet.create({
  wrap: {
    height: 46, borderRadius: 12, overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingLeft: 16, paddingRight: 5,
    shadowColor: 'rgba(79,141,255,0.34)', shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 1, shadowRadius: 20, elevation: 6,
  },
  idleContent: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7, paddingRight: 8 },
  label:  { fontSize: 13, fontWeight: '700', color: '#fff', letterSpacing: -0.01 },
  pct:    { fontSize: 13, fontWeight: '800', color: '#fff', letterSpacing: -0.02, minWidth: 36, textAlign: 'right' },
  arrowPill: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center', justifyContent: 'center',
  },
  spinner: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)', borderTopColor: '#fff' },
  dlWrap: {
    height: 46, borderRadius: 12, overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1.5, borderColor: '#CBD5E1', backgroundColor: '#fff',
  },
  dlContent: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 10 },
  dlLabel: { fontSize: 13, fontWeight: '700', color: '#fff', letterSpacing: -0.01 },
  iconBtn: {
    width: 46, height: 46, borderRadius: 12, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: '#CBD5E1', backgroundColor: '#fff',
  },
});

// ─── Main Screen ──────────────────────────────────────────────────
// ─── Auto-fill: injected web scripts ──────────────────────────────────────────
// All messages are namespaced with __cvf:true so the host page's own postMessage
// calls can never drive our state machine.
// Shared helpers embedded into the read + fill scripts. Fields are matched by a STABLE
// signature (name/id/label+type) so virtualized forms (fields removed when scrolled out of
// view) still fill — we fill AS we scroll, not after.
const JS_HELPERS = `
  function post(o){ try{ o.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  // document.querySelectorAll NEVER crosses a shadow boundary, so every control inside a web
  // component was invisible to BOTH the scan and the fill (SmartRecruiters' <spl-select> renders an
  // open shadow root holding the real dropdown — a plain query finds one control instead of a form).
  // Same walk utils/webviewTranslate.ts already uses for translation.
  function deepQuery(sel, root){
    var out=[], budget=0;
    function walk(r){
      if(budget>12000) return;
      try{
        var els=r.querySelectorAll(sel);
        for(var i=0;i<els.length;i++) out.push(els[i]);
        var all=r.querySelectorAll('*');
        budget+=all.length;
        for(var j=0;j<all.length;j++){ if(all[j].shadowRoot) walk(all[j].shadowRoot); }
      }catch(e){}
    }
    walk(root||document);
    return out;
  }
  // The deep walk costs a querySelectorAll('*') per level and fillVisible runs on every scroll step,
  // so pay for it only on pages that actually have a shadow root, rechecked at most every 2s. On an
  // ordinary page ctrls() executes byte-identically to the old literal query.
  var __cvfShadow = { at: 0, on: false };
  function hasShadow(){
    var now=Date.now();
    if(now-__cvfShadow.at < 2000) return __cvfShadow.on;
    __cvfShadow.at=now; __cvfShadow.on=false;
    try{ var all=document.querySelectorAll('*'); for(var i=0;i<all.length&&i<8000;i++){ if(all[i].shadowRoot){ __cvfShadow.on=true; break; } } }catch(e){}
    return __cvfShadow.on;
  }
  function ctrls(){
    if(!hasShadow()) return Array.prototype.slice.call(document.querySelectorAll('input,textarea,select'));
    return deepQuery('input,textarea,select');
  }
  function vis(el){ try { var t=(el.type||'').toLowerCase(); if(t!=='file'&&el.offsetParent===null) return false; var st=window.getComputedStyle(el); if(st.display==='none'||st.visibility==='hidden'||parseFloat(st.opacity||'1')===0) return false; var r=el.getBoundingClientRect(); if(t!=='file'&&r.width===0&&r.height===0) return false; } catch(e){} return true; }
  // Question text for a control. Wizard/SPA pages (Instahyre, Typeform-likes) put the question in a
  // plain <div>/<p>/<h4>, NOT a <label> — the old walk only looked for <label> and returned '' for
  // those, which made sig() collide and made the AI mapper correctly refuse to guess. So after the
  // label paths we also read the nearest preceding text block.
  function txtOf(n){ try { return (n && n.innerText ? n.innerText : '').replace(/\\s+/g,' ').trim(); } catch(e){ return ''; } }
  function nearText(el){
    var p=el, h=0;
    while(p && h<5){
      var s=p.previousElementSibling, g=0;
      while(s && g<4){
        if(!s.querySelector || !s.querySelector('input,textarea,select')){
          var t=txtOf(s);
          if(t.length>=4 && t.length<=180) return t;
        }
        s=s.previousElementSibling; g++;
      }
      p=p.parentElement; h++;
    }
    return '';
  }
  function lbl(el){
    try{ if(el.labels&&el.labels.length&&el.labels[0].innerText) return el.labels[0].innerText; }catch(e){}
    if(el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    var ab=el.getAttribute('aria-labelledby'); if(ab){var le=document.getElementById(ab.split(' ')[0]); if(le&&le.innerText) return le.innerText;}
    if(el.id){try{var lf=document.querySelector('label[for="'+(window.CSS&&CSS.escape?CSS.escape(el.id):el.id)+'"]'); if(lf&&lf.innerText) return lf.innerText;}catch(e){}}
    // NEAREST label by DOM distance (a Bootstrap .form-group can otherwise hand this control the
    // first label in document order — i.e. a different question's label).
    var p=el.parentElement,h=0;
    while(p&&h<3){
      var ls=p.querySelectorAll?p.querySelectorAll('label'):[];
      for(var i=0;i<ls.length;i++){ if(ls[i].innerText && (!ls[i].htmlFor || ls[i].htmlFor===el.id)) return ls[i].innerText; }
      h++; p=p.parentElement;
    }
    var nt=nearText(el); if(nt) return nt;
    return el.placeholder||el.name||'';
  }
  function nlbl(el){ return (lbl(el)||'').replace(/\\s+/g,' ').trim(); }
  // Stable per-field key. An EMPTY label used to produce 'l:|text' for every unlabeled control of a
  // type, so the scan silently dropped all but the first — hence a positional discriminator.
  //
  // That discriminator used to be an ORDINAL index into querySelectorAll('input,textarea,select'),
  // which any control inserted EARLIER renumbered: the reCAPTCHA textarea appearing mid-list, a
  // conditional "if yes, please explain" field opening, or Ashby swapping its upload control for a
  // file card once a résumé is attached. The scan and the fill are separated by a multi-second AI
  // round-trip, so the failure mode was not a missed field but the WRONG one — the user's city
  // written into the start-date box. A structural path is stable against inserts elsewhere.
  function domPath(el){
    var parts=[], n=el, h=0;
    try{
      while(n && n.nodeType===1 && n!==document.body && h<9){
        var par=n.parentElement;
        if(!par){ var pn=n.parentNode; if(pn&&pn.host){ parts.push('#s'); n=pn.host; h++; continue; } break; }
        var idx=0, kids=par.children;
        for(var k=0;k<kids.length;k++){ if(kids[k]===n) break; if(kids[k].tagName===n.tagName) idx++; }
        parts.push(n.tagName.toLowerCase()+(idx?('['+idx+']'):''));
        n=par; h++;
      }
    }catch(e){}
    return parts.join('/');
  }
  // A path truncated at 9 levels can be shared by two structurally identical branches, and a key
  // COLLISION is the exact catastrophe this function exists to prevent. When the path is not unique
  // among the page's controls, append this control's position among its twins.
  function uniqPath(el){
    var p=domPath(el), n=0, mine=0, taken=false;
    try{
      var all=ctrls();
      if(all.length>150) return p;                       // O(n^2) guard; plain path on huge forms
      for(var i=0;i<all.length;i++){
        // A control that appears LATER can compute a path equal to one another element already
        // cached — and two fields sharing a key means one value lands in the other's box. Whoever
        // cached it first keeps it.
        if(all[i]!==el && all[i].__cvfPath===p) taken=true;
        if(domPath(all[i])===p){ if(all[i]===el) mine=n; n++; }
      }
    }catch(e){}
    if(taken){ try{ window.__cvfPathN=(window.__cvfPathN||0)+1; }catch(e){} return p+'#u'+(window.__cvfPathN||n); }
    return n>1 ? (p+'#'+mine) : p;
  }
  // Framework ids (:r3:, radix-:r1:, headlessui-…, mui-12) change on every re-render — keying on one
  // is no more stable than an ordinal.
  function volatileId(id){ try{ return /^:|^radix-|^headlessui-|^mui-\\d|^react-aria|:r[0-9a-z]+:/.test(String(id)); }catch(e){ return false; } }
  function sig(el){
    var t=(el.type||'').toLowerCase();
    if(el.name) return 'n:'+el.name+'|'+t;
    if(el.id && !volatileId(el.id)) return 'i:'+el.id+'|'+t;
    var L=nlbl(el).toLowerCase().slice(0,70);
    if(L) return 'l:'+L+'|'+t;
    // Cache the positional key ON the element. Scan and fill are separate injections into the SAME
    // page, so the expando survives between them — an unlabeled field keeps its exact key even if
    // the surrounding DOM is rebuilt, and we pay the path cost once per element.
    try{ if(el.__cvfPath) return 'd:'+el.__cvfPath+'|'+t; }catch(e){}
    var p=uniqPath(el);
    try{ el.__cvfPath=p; }catch(e){}
    return 'd:'+p+'|'+t;
  }
  function radioQuestion(el){ var name=el.name; var esc=(window.CSS&&CSS.escape)?CSS.escape(name||''):(name||''); var rs=name?document.querySelectorAll('input[type=radio][name="'+esc+'"]'):[el]; var opts=[]; for(var i=0;i<rs.length;i++){ var o=nlbl(rs[i])||rs[i].value||''; if(o) opts.push(o); } var p=el.parentElement,h=0; while(p&&h<8){ var txt=(p.innerText||'').replace(/\\s+/g,' ').trim(); var strip=txt; for(var k=0;k<opts.length;k++){ if(opts[k]) strip=strip.split(opts[k]).join(' '); } strip=strip.replace(/\\s+/g,' ').replace(/\\*/g,'').trim(); if(strip.length>=4&&strip.length<=180) return strip; h++; p=p.parentElement; } return nlbl(el); }
  function fire(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  function setNative(el, value){ var proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:(el.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype); var d=Object.getOwnPropertyDescriptor(proto,'value'); if(d&&d.set) d.set.call(el,value); else el.value=value; fire(el); }
  function setChecked(el, val){ var d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'checked'); if(d&&d.set) d.set.call(el,val); else el.checked=val; el.dispatchEvent(new Event('click',{bubbles:true})); fire(el); }
  // Ambiguity used to mean "fill nothing": "Management" against {Project/Product/Program Management}
  // returned null. Prefer exact, then a single starts-with, then the SHORTEST containing option
  // (only for reasonably specific values, so a 2-char value can't latch onto something random).
  function pickOpt(opts, v){
    v=String(v).trim().toLowerCase(); var ex=[],sw=[],ct=[];
    for(var i=0;i<opts.length;i++){var x=(opts[i].text||'').trim().toLowerCase(); if(!x) continue; if(x===v) ex.push(opts[i]); else if(x.indexOf(v)===0) sw.push(opts[i]); else if(x.indexOf(v)>=0) ct.push(opts[i]);}
    if(ex.length) return ex[0];
    if(sw.length===1) return sw[0];
    if(ct.length===1) return ct[0];
    if(v.length>=4){
      var pool = sw.length ? sw : ct;
      if(pool.length){ var best=pool[0]; for(var j=1;j<pool.length;j++){ if((pool[j].text||'').length < (best.text||'').length) best=pool[j]; } return best; }
    }
    return pickOptFuzzy(opts, v);
  }
  // LAST-RESORT matcher. Substring matching leaves a field EMPTY whenever the wording differs at
  // all ("Bachelor's degree" vs "Bachelor of Science", "3-5 years" vs "3 to 5 years", "Male" vs
  // "Man"). Score by shared significant tokens and require a real majority overlap, so a confident
  // rewording matches while an unrelated option can never sneak in.
  // Structural filler + generic qualifiers. Without the qualifiers, "Bachelor's degree" scores only
  // 0.5 against "Bachelor of Science" (the word "degree" dilutes the one token that matters) and the
  // field is left blank — while dropping them keeps the DISTINGUISHING token (bachelor vs master).
  var PO_STOP={'the':1,'a':1,'an':1,'of':1,'or':1,'and':1,'to':1,'in':1,'for':1,'with':1,'my':1,'i':1,'is':1,'are':1,'other':1,'please':1,'select':1,'choose':1,
    'degree':1,'level':1,'category':1,'type':1,'status':1,'option':1,'currently':1,'have':1,'any':1};
  function poToks(s){
    var t=String(s||'').toLowerCase().replace(/[^a-z0-9+#.]+/g,' ').split(' ');
    var out=[]; for(var i=0;i<t.length;i++){ var w=t[i]; if(w && w.length>=2 && PO_STOP[w]!==1) out.push(w); }
    return out;
  }
  function pickOptFuzzy(opts, v){
    var want=poToks(v); if(!want.length) return null;
    var best=null, bestScore=0;
    for(var i=0;i<opts.length;i++){
      var tx=(opts[i].text||''); if(!tx) continue;
      var got=poToks(tx); if(!got.length) continue;
      var hit=0;
      for(var w=0;w<want.length;w++){
        for(var g=0;g<got.length;g++){
          // prefix match both ways so "engineering"/"engineer" and "5"/"5+" agree
          if(got[g]===want[w] || (want[w].length>=4 && got[g].indexOf(want[w])===0) || (got[g].length>=4 && want[w].indexOf(got[g])===0)){ hit++; break; }
        }
      }
      // overlap relative to the SHORTER side, so a long option text isn't unfairly penalised
      var score=hit/Math.min(want.length, got.length);
      if(score>bestScore){ bestScore=score; best=opts[i]; }
    }
    return bestScore>=0.67 ? best : null;   // confident rewording only — never a guess
  }
  // Normalise a value for a native date input (they accept ONLY yyyy-mm-dd; anything else is
  // silently rejected and the field stays empty).
  function dateVal(v){
    var s=String(v||'').trim();
    if(/^\\d{4}-\\d{2}-\\d{2}$/.test(s)) return s;
    var m=s.match(/^(\\d{1,2})[\\/.\\-](\\d{1,2})[\\/.\\-](\\d{4})$/);
    if(m){
      var a=parseInt(m[1],10), b=parseInt(m[2],10), y=m[3];
      // dd/mm vs mm/dd: >12 decides it; otherwise assume dd/mm (every locale but the US)
      var d=a, mo=b; if(a<=12 && b>12){ d=b; mo=a; }
      return y+'-'+('0'+mo).slice(-2)+'-'+('0'+d).slice(-2);
    }
    var t=Date.parse(s);
    if(!isNaN(t)){ var dt=new Date(t); return dt.getFullYear()+'-'+('0'+(dt.getMonth()+1)).slice(-2)+'-'+('0'+dt.getDate()).slice(-2); }
    return s;
  }
  // Values that mean "several answers": an array, or a comma/semicolon/pipe list.
  function multiVals(v){
    if(Array.isArray(v)) return v.map(function(x){ return String(x).trim(); }).filter(Boolean);
    var s=String(v==null?'':v);
    if(!/[,;|]/.test(s)) return [];
    return s.split(/[,;|]/).map(function(x){ return x.trim(); }).filter(Boolean);
  }
  // Bring a control into view before touching it. Off-screen widgets frequently refuse clicks and
  // render their popup outside the viewport, which read as "no options" and left fields blank.
  function bringIntoView(el){
    try{
      var r=el.getBoundingClientRect();
      var h=window.innerHeight||600;
      if(r.top>=0 && r.bottom<=h) return;
      if(el.scrollIntoView) el.scrollIntoView({block:'center'});
      else window.scrollTo(0, (window.pageYOffset||0)+r.top-h/2);
    }catch(e){}
  }
  // ── Country / dial-code support ─────────────────────────────────────────────
  // Option text arrives as "India+91" (intl-tel-input), "India (+91)", "+91 (India)" or "IN +91",
  // routinely padded with NBSP / bidi marks that break naive indexOf matching.
  function cleanTxt(s){ return String(s==null?'':s).replace(/[\\u200B-\\u200F\\u202A-\\u202E\\uFEFF]/g,'').replace(/\\u00A0/g,' ').replace(/\\s+/g,' ').trim(); }
  // \\d{1,4} — NOT \\d[\\d\\s\\-]{0,5}: that form swallows the number after the code, so
  // dialOf("+91 98765 43210") returned "91987" and every read-back comparison failed.
  function dialOf(s){ var m=cleanTxt(s).match(/\\+\\s*(\\d{1,4})/); return m ? m[1] : ''; }
  function wantDial(v){ var s=cleanTxt(v); var m=s.match(/\\+\\s*(\\d{1,4})/); if(m) return m[1]; m=s.match(/^00(\\d{1,4})$/); if(m) return m[1]; m=s.match(/^(\\d{1,4})$/); if(m) return m[1]; return ''; }
  function isoOf(s){ var t=cleanTxt(s); return /^[A-Za-z]{2}$/.test(t) ? t.toUpperCase() : ''; }
  function optText(o){ return cleanTxt(o&&o.text!=null?o.text:o); }
  function optVal(o){ return String(o&&o.value!=null?o.value:'').toUpperCase(); }
  // Countries that SHARE a dial code — without these, "+1" resolves to Guam and "+44" to Jersey.
  var PRIM_ISO={'1':'US','7':'RU','44':'GB','39':'IT','47':'NO','61':'AU','212':'MA','262':'RE','290':'SH','358':'FI','500':'FK','590':'GP','599':'CW','672':'NF','683':'NU','690':'TK'};
  var PRIM_NAME={'1':'united states','7':'russia','44':'united kingdom','39':'italy','47':'norway','61':'australia','212':'morocco','262':'reunion','290':'saint helena','358':'finland','500':'falkland','590':'guadeloupe','599':'curacao','672':'norfolk','683':'niue','690':'tokelau',
    // single-country codes too: these feed the popup SEARCH filter (searching "india" works on
    // every picker; searching "+91" fails on starts-with filters), never the exact-dial matcher.
    '91':'india','92':'pakistan','49':'germany','33':'france','34':'spain','351':'portugal','31':'netherlands','46':'sweden','41':'switzerland','971':'united arab emirates','966':'saudi arabia','94':'sri lanka','86':'china','81':'japan','82':'korea','55':'brazil','52':'mexico','234':'nigeria','254':'kenya','20':'egypt','63':'philippines','62':'indonesia','60':'malaysia','65':'singapore','64':'new zealand','48':'poland','43':'austria','32':'belgium','45':'denmark','30':'greece','36':'hungary','40':'romania','380':'ukraine','90':'turkey','880':'bangladesh','977':'nepal','353':'ireland','420':'czech'};
  // Dial-code-aware option matcher, tried BEFORE pickOpt on country controls. pickOpt is a substring
  // matcher: against a realistic country list it returns NULL for "+1", "+44" and "+7" (too many
  // candidates, and its v.length>=4 guard rejects short codes). Here the dial code is compared
  // NUMERICALLY, so it is exact. Returns null when unsure — pickOpt then still runs.
  function pickDial(opts, v){
    var wd=wantDial(v), iso=isoOf(v);
    var name=cleanTxt(v).replace(/[+0-9()\\[\\]]+/g,' ').replace(/\\s+/g,' ').trim().toLowerCase();
    var i,t,ex=[];
    if(wd){ for(i=0;i<opts.length;i++){ if(dialOf(optText(opts[i]))===wd) ex.push(opts[i]); } }
    if(ex.length>1){
      if(iso){ for(i=0;i<ex.length;i++){ if(optVal(ex[i])===iso) return ex[i]; } }
      if(name){ for(i=0;i<ex.length;i++){ if(optText(ex[i]).toLowerCase().indexOf(name)===0) return ex[i]; } }
      var pv=PRIM_ISO[wd]; if(pv){ for(i=0;i<ex.length;i++){ if(optVal(ex[i])===pv) return ex[i]; } }
      var pn=PRIM_NAME[wd]; if(pn){ for(i=0;i<ex.length;i++){ if(optText(ex[i]).toLowerCase().indexOf(pn)>=0) return ex[i]; } }
      var best=ex[0]; for(i=1;i<ex.length;i++){ if(optText(ex[i]).length<optText(best).length) best=ex[i]; } return best;
    }
    if(ex.length===1) return ex[0];
    if(iso){ for(i=0;i<opts.length;i++){ if(optVal(opts[i])===iso) return opts[i]; } }
    if(name){ for(i=0;i<opts.length;i++){ t=optText(opts[i]).toLowerCase();
      if(t===name||t.indexOf(name+' ')===0||t.indexOf(name+'+')===0||t.indexOf(name+'(')===0) return opts[i]; } }
    return null;
  }
  // Inverse of PRIM_NAME: "India" / "India (+91)" → "91". Only ever a FALLBACK for reading back a
  // dial code out of a value that carries no "+NN" at all (the model answering a code picker with a
  // country name). Exact whole-name match, so "Indian Ocean Territory" can never resolve to India.
  function dialForName(v){
    try{
      var n=cleanTxt(v).replace(/[+0-9()\\[\\]]+/g,' ').replace(/\\s+/g,' ').trim().toLowerCase();
      if(!n) return '';
      for(var k in PRIM_NAME){ if(Object.prototype.hasOwnProperty.call(PRIM_NAME,k) && PRIM_NAME[k]===n) return k; }
    }catch(e){}
    return '';
  }
  // "nationality" is deliberately NOT here: it is a legal question, not a dial-code control, and it
  // must keep the full never-overwrite protection.
  function isCountryLabel(s){ return /country|dial|calling code|phone code|\\bisd\\b/i.test(cleanTxt(s)); }
  function isPhoneCodeOpts(opts){ var n=0,t=0,i; for(i=0;i<opts.length&&i<40;i++){ var s=optText(opts[i]); if(!s) continue; t++; if(dialOf(s)) n++; } return t>=3 && n/t>0.6; }
  function isCountrySelect(el){
    try{ if(el.tagName!=='SELECT') return false;
      if(isCountryLabel(nlbl(el))) return true;
      return isPhoneCodeOpts(Array.prototype.slice.call(el.options));
    }catch(e){ return false; }
  }

  // ── Custom dropdowns (comboboxes) ───────────────────────────────────────────
  // A "combobox" = anything that behaves like a <select> but is not one: react-select, MUI
  // Autocomplete, Downshift, select2, Chosen, intl-tel-input's country list. Setting .value on one
  // leaves aria-expanded="false", renders no selection and posts NOTHING — while .value still reads
  // back, so the old read-back marked it FILLED. Every dropdown on such a form submitted empty while
  // we told the user "Filled 5 fields". This is the single biggest reason "+91 never applied".
  function cbNorm(s){ return String(s==null?'':s).replace(/\\s+/g,' ').trim().toLowerCase(); }
  function cbText(el){ try{ return String(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim(); }catch(e){ return ''; } }
  function isCombo(el){
    try{
      if(el.tagName==='SELECT') return false;
      if(!el.getAttribute) return false;
      if(el.getAttribute('role')==='combobox') return true;
      if(el.getAttribute('aria-haspopup')==='listbox') return true;
      if(el.getAttribute('aria-autocomplete')==='list') return true;
      if(el.closest && el.closest('[class*=select__control],[class*=react-select],[class*=select2-container],[class*=chosen-container],[class*=MuiAutocomplete],[class*=ui-select],.iti__country-container')) return true;
    }catch(e){}
    return false;
  }
  // A TRIGGER-style combo: an <input type=button> (Revolut's rui kit renders every dropdown this
  // way — country, gender, "Select one", the phone code picker) or a readOnly input. Typing into
  // one does nothing; it must be CLICKED open, and any filtering happens in the popup's own search
  // box. These used to be skipped entirely by both the scan and the fill ("many dropdowns missed").
  function isComboTrigger(el){
    try{
      if(!el || el.tagName!=='INPUT') return false;
      if(!isCombo(el)) return false;
      var t=(el.type||'').toLowerCase();
      return t==='button' || el.readOnly===true;
    }catch(e){ return false; }
  }
  // The search input INSIDE an opened popup (Revolut's "Search phone country codes", intl-tel-input's
  // country filter) — or wherever focus landed after opening. Never the trigger itself.
  function cbSearchBox(el, pop){
    // The filter box can sit in a STICKY HEADER that is a sibling of the rows container, so when the
    // resolved popup is the inner list we must also look at its ancestors. Without the filter, a
    // virtualized 240-country list only ever renders its first ~24 rows and "India" is unreachable.
    try{
      var scopes=[];
      if(pop&&pop.el){ var a=pop.el, h=0; while(a && h<4){ scopes.push(a); a=a.parentElement; h++; } }
      for(var s=0;s<scopes.length;s++){
        if(!scopes[s].querySelectorAll) continue;
        var cs=scopes[s].querySelectorAll('input');
        for(var i=0;i<cs.length;i++){ var c=cs[i], ct=(c.type||'').toLowerCase();
          if(c!==el && !c.readOnly && ['text','search',''].indexOf(ct)>=0 && vis(c)) return c; }
      }
    }catch(e){}
    try{
      var ae=document.activeElement;
      if(ae && ae!==el && ae.tagName==='INPUT' && !ae.readOnly && ['text','search',''].indexOf((ae.type||'').toLowerCase())>=0 && vis(ae)) return ae;
    }catch(e){}
    return null;
  }
  // What to type into a popup's search box. Dial-code pickers search by country NAME far more
  // reliably than by "+91", so prefer the name when one can be derived.
  function cbFilterFor(el, want){
    if(isCountryLabel(nlbl(el))){
      var name=cleanTxt(want).replace(/[+0-9()\\[\\]]+/g,' ').replace(/\\s+/g,' ').trim();
      if(name) return name;
      var wd=wantDial(want);
      if(wd && PRIM_NAME[wd]) return PRIM_NAME[wd];
      if(wd) return '+'+wd;
    }
    return String(want);
  }
  // Does this widget accept MORE THAN ONE answer? (react-select multi, chips/tokens already
  // rendered, aria-multiselectable, or a label that asks for plural places/languages/skills.)
  function isMultiCombo(el){
    try{
      if(el.getAttribute && el.getAttribute('aria-multiselectable')==='true') return true;
      var w=cbCtrl(el);
      if(w && w.querySelector && w.querySelector('[class*=multi-value],[class*=multiValue],[class*=chip],[class*=token],[class*=tag]')) return true;
      var L=cleanTxt(nlbl(el)).toLowerCase();
      if(/locations|languages|skills|technologies|countries|cities|areas|preferences/.test(L)) return true;
    }catch(e){}
    return false;
  }
  function cbCtrl(el){
    try{ return (el.closest&&(el.closest('[class*=select__control]')||el.closest('[class*=MuiAutocomplete-root]')||el.closest('[class*=select2-selection]')||el.closest('[class*=chosen-container]')))||el.parentElement; }catch(e){ return el.parentElement; }
  }
  // ── Resolving a widget's popup — the part that must never go wrong ──────────
  // An earlier version walked up to 4 ancestors and took any visible node whose class merely
  // CONTAINED "menu"/"options"/"dropdown". Driven against real page shapes that resolved to
  // <div class="form-options"> (holding a Submit button), to <nav class="navbar-menu"> (holding
  // links), and to a wizard's step container — and we then clicked what was inside. So a popup is
  // now only accepted when it is either EXPLICITLY associated with the control (aria-controls /
  // aria-owns), or it BECAME VISIBLE as a result of our own open gesture. A site nav and a sibling
  // button container are visible the whole time and can never qualify.
  // ⚠️ Design-system sheets (Revolut's rui, and most "bottom sheet" pickers) use NO aria roles and
  // no menu-ish class names: the country list is <button class="Cell__CellBase"> rows inside
  // <div class="Group…"> inside <div class="ScrollContent…">. Name-matching alone found nothing, so
  // we opened the sheet, saw "no options", and abandoned it half-open — the exact reported symptom.
  // Hence: a wide net here, plus the STRUCTURAL test below that actually decides.
  var CB_POPUP_SEL  = '[role=listbox],[role=menu],[role=grid],[class*=menu],[class*=dropdown],[class*=listbox],[class*=autocomplete],[class*=typeahead],[class*=results],[class*=suggestion],[class*=option],[class*=ScrollContent],[class*=scroll-content],[class*=Sheet],[class*=sheet],[class*=Drawer],[class*=drawer],[class*=Popover],[class*=popover],[class*=Picker],[class*=picker],[class*=Portal],[class*=portal],[class*=Overlay],[class*=overlay],[class*=Modal],[class*=Group]';
  // Word-boundary, so "form-options", "answer-options" and "optional-note" no longer look like popups.
  var CB_POPUP_WORD = /(^|[-_])(menu|dropdown|listbox|autocomplete|typeahead|results|suggestions?|choices|sheet|drawer|popover|picker|scrollcontent)([-_]|$)/i;
  // Rows a design system renders WITHOUT any aria: clickable leaves carrying one short label.
  var CB_ROW_SEL = '[role=option],li,[class*=option],[class*=item],[class*=Item],[class*=Cell],[class*=cell],[class*=row],[class*=Row],button,[role=button],[tabindex]';
  function cbClickableLeaf(n){
    try{
      if(!n || !vis(n)) return false;
      // a row holds its own label, not a nest of other rows
      if(n.querySelector && n.querySelector('[role=option],button,[role=button]')) return false;
      var tx=cbText(n); if(!tx || tx.length>120) return false;
      if(n.tagName==='BUTTON'||n.getAttribute('role')==='option'||n.getAttribute('role')==='button') return true;
      var cur=''; try{ cur=getComputedStyle(n).cursor; }catch(e){}
      return cur==='pointer';
    }catch(e){ return false; }
  }
  // STRUCTURAL popup test — what actually makes something a list: several sibling clickable rows.
  // This is what recognises the Revolut sheet (and any other unlabeled design-system picker).
  function cbLooksLikeList(n){
    try{
      if(!n || !n.querySelectorAll) return false;
      var cands=n.querySelectorAll(CB_ROW_SEL), hits=0;
      for(var i=0;i<cands.length && i<300 && hits<2;i++){ if(cbClickableLeaf(cands[i])) hits++; }
      // TWO rows, not three: plenty of real pickers are short — Yes/No, or Revolut's "Preferred
      // work locations" (London · UK-Remote), which returned NO options under a 3-row threshold.
      // Safe, because this only ever judges nodes that BECAME VISIBLE from our own open gesture.
      return hits>=2;
    }catch(e){ return false; }
  }
  function cbClassOf(n){ try{ var cn=n.className; if(cn&&typeof cn!=='string'&&cn.baseVal!=null) cn=cn.baseVal; return String(cn||''); }catch(e){ return ''; } }
  function cbPopupOk(n){
    try{
      var r=(n.getAttribute&&n.getAttribute('role'))||'';
      if(r==='listbox'||r==='menu'||r==='grid') return true;
      var toks=cbClassOf(n).split(/\\s+/);
      // styled-components emit "Cell__CellBase-rui__sc-10xyz" — test the whole token too, not just
      // its dash-separated words, or every design-system class fails the word test.
      for(var i=0;i<toks.length;i++){
        if(!toks[i]) continue;
        if(CB_POPUP_WORD.test(toks[i])) return true;
        if(/scrollcontent|sheet|drawer|popover|picker|listbox|dropdown/i.test(toks[i])) return true;
      }
      // Last word: does it BEHAVE like a list? (unlabeled design-system sheets)
      if(cbLooksLikeList(n)) return true;
    }catch(e){}
    return false;
  }
  // Snapshot of popup-shaped nodes ALREADY visible before we open anything.
  function cbPreOpen(){
    var out=[];
    try{ var ns=deepQuery(CB_POPUP_SEL); for(var i=0;i<ns.length&&i<400;i++){ if(vis(ns[i])) out.push(ns[i]); } }catch(e){}
    return out;
  }
  // Returns {el, trusted} or null. trusted === the control itself told us which node its popup is.
  function cbPopup(el, pre){
    var rt=document; try{ if(el.getRootNode){ var r=el.getRootNode(); if(r&&r.getElementById) rt=r; } }catch(e){}
    var ids=[];
    try{ var a=el.getAttribute('aria-controls'); if(a) ids=ids.concat(a.split(' ')); }catch(e){}
    try{ var o=el.getAttribute('aria-owns');    if(o) ids=ids.concat(o.split(' ')); }catch(e){}
    for(var i=0;i<ids.length;i++){ if(!ids[i]) continue; var n=null; try{ n=rt.getElementById(ids[i]); }catch(e){} if(n&&vis(n)) return {el:n, trusted:true}; }
    if(!pre) return null;                       // no association and no before-picture ⇒ refuse
    var cands=[]; try{ cands=deepQuery(CB_POPUP_SEL); }catch(e){ return null; }
    // ⚠️ Do NOT return the first name-match. Revolut renders an empty "DropdownGroup" wrapper that
    // matches on the word "dropdown" and appears BEFORE the real sheet in document order — taking
    // it gave us a popup with ZERO options while the actual list sat right below it.
    // Collect every candidate, then prefer one that genuinely CONTAINS rows.
    var first=null;
    for(var j=0;j<cands.length&&j<400;j++){
      var c=cands[j];
      if(!vis(c)||!cbPopupOk(c)) continue;
      var was=false; for(var k=0;k<pre.length;k++){ if(pre[k]===c){ was=true; break; } }
      if(was) continue;                          // was already on screen ⇒ not our popup
      try{ if(c.contains&&c.contains(el)) continue; }catch(e){}   // the control's own wrapper
      if(cbLooksLikeList(c)) return {el:c, trusted:false};         // has real rows — this is the list
      if(!first) first=c;                                          // remember, in case nothing better shows
    }
    return first ? {el:first, trusted:false} : null;
  }
  function cbOptions(el, pop){
    if(!pop||!pop.el) return [];
    var os=[]; try{ os=pop.el.querySelectorAll('[role=option],li,[class*=option],[class*=item]'); }catch(e){ os=[]; }
    var out=[], seen=[];
    for(var i=0;i<os.length&&out.length<200;i++){
      var o=os[i];
      if(!vis(o)) continue;
      try{ if(o.querySelector && o.querySelector('[role=option]')) continue; }catch(e){}   // container, not a row
      var tx=cbText(o); if(!tx||tx.length>120) continue;
      if(seen.indexOf(tx)>=0) continue; seen.push(tx);
      out.push(o);
    }
    // NOTHING matched the aria/class names → this is an unlabeled design-system list (Revolut rui:
    // <button class="Cell__CellBase">Afghanistan</button>). Fall back to clickable leaves. The cap
    // is high because a country list is ~240 rows and pickDial must see the RIGHT one, not row 60.
    if(!out.length){
      var cands=[]; try{ cands=pop.el.querySelectorAll(CB_ROW_SEL); }catch(e){ return []; }
      for(var j=0;j<cands.length&&out.length<300;j++){
        var c=cands[j];
        if(!cbClickableLeaf(c)) continue;
        var t2=cbText(c);
        if(seen.indexOf(t2)>=0) continue; seen.push(t2);
        out.push(c);
      }
    }
    return out;
  }
  // Is the list we just read the WHOLE list, or only a window onto a longer one?
  //
  // ⚠️ This is why "+91" never reached the picker. A design-system phone-code sheet holds ~240
  // countries but renders ~24 rows and RECYCLES them as you scroll — the row for India is simply not
  // in the DOM until the sheet's search box is filtered. We read those 24 ("+1 American Samoa" …
  // "+1 U.S. Virgin Islands"), reported them as THE options, and the server — which deletes a value
  // no option matches — concluded "+91: no matching option" and sent no dial code at all. The picker
  // kept its geo-IP +44 while the number box got the national digits. Measured on the real Revolut
  // sheet: scrollHeight 17216px behind a 796px viewport for 24 rows read, versus 796/796 and no
  // hidden content for the 7-row gender list. So: say the list is partial when the height we cannot
  // see is far more than the rows we CAN see could ever fill. The server already knows what to do
  // with a partial list — it passes the bare "+91" through and lets pickDial match it here, against
  // the real list, through the search box.
  function cbListPartial(el, pop, opts){
    try{
      opts = opts || [];
      if(opts.length>=200) return true;                       // we hit cbOptions' own read cap
      if(!pop || !pop.el) return false;
      var ch=0, hidden=0;
      try{ ch=pop.el.clientHeight||0; hidden=(pop.el.scrollHeight||0)-ch; }catch(e){}
      if(ch<=0 || hidden<=80) return false;                   // nothing is scrolled out of sight
      var rh=0; try{ if(opts.length && opts[0].getBoundingClientRect) rh=opts[0].getBoundingClientRect().height||0; }catch(e){}
      if(!rh) rh=40;
      // 1.4x slack so a genuinely complete list that merely overflows its sheet is not called partial.
      return hidden > opts.length*rh*1.4;
    }catch(e){ return false; }
  }
  // Any label containing one of these is never clicked by us, in any context. Unanchored and
  // multilingual on purpose: the old anchored English list let "Submit application" and
  // "Save and continue" straight through. (Kept separate from WIZARD_HELPERS' W_SUBMIT, which must
  // NOT contain the next-words or wizard detection could never recognise a Next button.)
  var CB_SUBMIT = /\\b(submit|apply|application|send|finish|finalise|finalize|next|continue|proceed|confirm|agree|accept|pay|buy|delete|remove|absenden|abschicken|abschliessen|bewerben|bewerbung|einreichen|weiter|fortfahren|envoyer|soumettre|postuler|terminer|candidature|suivant|continuer|enviar|postular|solicitud|finalizar|siguiente|continuar|invia|inviare|candidati|candidatura|termina|avanti|verzenden|versturen|solliciteer|sollicitatie|voltooien|indienen|volgende|doorgaan|submeter|candidatar|concluir|proximo|wyslij|aplikuj|zloz|zakoncz|dalej|skicka|ansok|ansokan|slutfor|nasta)\\b/i;
  // NEVER activate a submit control or a navigation link. Every rejection here is UNCONDITIONAL —
  // the old version required an "&& el.form" conjunct, and a Submit button outside any <form>
  // sailed past it. Note getAttribute('type'), never el.type: HTMLButtonElement.type DEFAULTS to
  // "submit", so el.type would reject every legitimate <button role=option> dropdown row.
  function cbSafeClick(el){
    try{
      if(!el) return false;
      var at=String((el.getAttribute&&el.getAttribute('type'))||'').toLowerCase();
      if(at==='submit'||at==='image'||at==='reset') return false;
      if(el.closest && el.closest('button[type=submit],input[type=submit]')) return false;
      if(el.getAttribute && el.getAttribute('form')) return false;
      // a link that would actually navigate — clicking it destroys the half-filled form
      var a=null; try{ a=el.closest?el.closest('a'):null; }catch(e){}
      if(a){ var h=a.getAttribute('href')||''; if(h && h!=='#' && h.indexOf('javascript:')!==0) return false; }
      if(CB_SUBMIT.test(cbText(el))) return false;
      var al=(el.getAttribute&&(el.getAttribute('aria-label')||el.getAttribute('title')))||'';
      if(al && CB_SUBMIT.test(al)) return false;
      el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
      el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      if(el.click) el.click(); else el.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      return true;
    }catch(e){ return false; }
  }
  // What the widget SHOWS as chosen. After a real pick react-select CLEARS the input, so el.value is
  // the wrong thing to read — both for verifying OUR write and for detecting the USER's own answer.
  //
  // STRICT on purpose. An earlier version fell back to the wrapper's whole innerText minus the
  // placeholder and label, which picked up sibling hint text ("e.g. +91") and the widget's own
  // "Select…" placeholder — so an EMPTY dropdown looked answered, autofill skipped it, and it was
  // reported as filled. Only an explicit selected-value node counts now; anything else returns ''.
  function cbShown(el){
    try{
      var w=cbCtrl(el);
      if(w&&w.querySelector){
        var sv=w.querySelector('[class*=single-value],[class*=multi-value],[class*=select2-selection__rendered],[class*=chosen-single] span,[aria-selected="true"]');
        if(sv){
          var t=cbText(sv);
          // select2/Chosen render their PLACEHOLDER through the same node.
          try{ if(t && sv.className && /placeholder/i.test(cbClassOf(sv))) t=''; }catch(e){}
          var ph=cbNorm(el.placeholder||'');
          if(t && ph && cbNorm(t)===ph) t='';
          if(t && /^(select|choose|please select|-{2,}|\\.\\.\\.)\\b/i.test(t)) t='';
          if(t) return t;
        }
      }
      // Trigger-style widgets display the selection AS the input's value, which the FRAMEWORK sets.
      // We never type into a trigger ourselves, so a value here is a real selection — not our echo.
      if(isComboTrigger(el)){
        var tv=cleanTxt(el.value||'');
        var ph2=cbNorm(el.placeholder||'');
        if(tv && cbNorm(tv)!==ph2 && !/^(select|choose|please select|-{2,})/i.test(tv)) return tv;
      }
      return '';
    }catch(e){ return ''; }
  }
  // "Shown" is not always "answered": an UNTOUCHED country / dial-code widget showing the page's
  // geo-IP default (+44 on a UK site) is nobody's answer — the exact "it never changes the phone
  // country code when one is already there" complaint. Mirrors selIsUserAnswer's select rule.
  function cbAnswered(el){
    var sh=cbShown(el); if(!sh) return false;
    try{ if(isCountryLabel(nlbl(el)) && !el.__cvfTouched) return false; }catch(e){}
    return true;
  }
  // Close a widget popup without ever pressing Enter (implicit submit) — and WITHOUT closing the host
  // application MODAL. A real el.blur() is what actually dismisses react-select / MUI Autocomplete /
  // select2 / Chosen (they all close on focus loss); Escape is only a supplement for widgets that
  // ignore blur.
  // ⚠️ The old code sent a BUBBLING Escape. On a portal application form inside a <dialog>/modal (YC's
  // "Apply for this role" popup, Ashby, etc.) that Escape bubbled to the modal's document-level
  // Escape-to-close handler and dismissed the user's ENTIRE application popup — during the scan, before
  // they'd typed anything. Now: Escape is bubbles:false (can't travel up to a document/dialog handler,
  // still reaches a keydown bound directly on the widget input), and inside a detected modal we skip
  // Escape entirely (a capture-phase modal listener would see even a non-bubbling event) and let blur
  // do the work. Residual: a widget that closes ONLY via a document Escape may stay visually open in a
  // modal — cosmetic, and far better than nuking the user's application.
  function cbInModal(el){
    try{ return !!(el.closest && el.closest('[role=dialog],[aria-modal="true"],dialog[open]')); }catch(e){ return false; }
  }
  function cbClose(el){
    if(!cbInModal(el)){
      try{ el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:false})); }catch(e){}
      try{ el.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:false})); }catch(e){}
    }
    try{ el.dispatchEvent(new Event('blur',{bubbles:true})); }catch(e){}
    try{ el.blur(); }catch(e){}
  }
  // ── Actually closing a design-system SHEET ───────────────────────────────────
  // blur + Escape are enough for react-select/MUI, but a full-screen sheet (Revolut rui) ignores
  // BOTH — verified live: a document-level Escape left it open. Every dropdown we touched therefore
  // stayed on screen, stacking one over another, and the user had to dismiss them by hand.
  // A sheet ships its own dismiss control, so use it; fall back through Escape → backdrop → blur,
  // verifying after each step instead of assuming.
  var CB_CLOSE_TXT = /^(close|cancel|dismiss|back|done|ok|×|✕|✖|╳|x)$/i;
  var CB_CLOSE_ARIA = /close|dismiss|back|cancel/i;
  function cbSheetRoot(popEl){
    // climb until the node covers most of the viewport (the sheet), max 6 hops
    var n=popEl, best=popEl, h=0;
    try{
      while(n && h<6){
        var r=n.getBoundingClientRect();
        if(r.height >= (window.innerHeight||600)*0.5) best=n;
        n=n.parentElement; h++;
      }
    }catch(e){}
    return best;
  }
  function cbIsCloseCtrl(c){
    try{
      if(!c || !vis(c)) return false;
      var tx=cbText(c).trim();
      var ar=(c.getAttribute&&(c.getAttribute('aria-label')||c.getAttribute('title')))||'';
      if(!((tx && CB_CLOSE_TXT.test(tx)) || (ar && CB_CLOSE_ARIA.test(ar)))) return false;
      var at=String((c.getAttribute&&c.getAttribute('type'))||'').toLowerCase();
      if(at==='submit'||at==='image') return false;                  // never a submit-shaped control
      if(CB_SUBMIT.test(tx) || (ar && CB_SUBMIT.test(ar))) return false;
      return true;
    }catch(e){ return false; }
  }
  // Snapshot of close-ish controls ALREADY on the page (a cookie banner's "Close", a nav "Back").
  // Clicking one of those instead of the sheet's own would dismiss the wrong thing entirely.
  function cbPreCloseCtrls(){
    var out=[];
    try{
      var ns=deepQuery('button,[role=button],[aria-label]');
      for(var i=0;i<ns.length && i<400;i++){ if(cbIsCloseCtrl(ns[i])) out.push(ns[i]); }
    }catch(e){}
    return out;
  }
  // ⚠️ The sheet's Close button is NOT inside the scrolling list — it sits in a sibling sticky
  // header. Searching only within the popup found nothing, so every sheet fell through to Escape
  // (which this widget ignores) and stayed open, stacking. Search the popup, then its ANCESTORS,
  // and finally anything that BECAME visible when we opened — never a control that was already there.
  function cbFindCloseCtrl(root, preCtrls){
    var seenBefore=function(c){ if(!preCtrls) return false; for(var k=0;k<preCtrls.length;k++){ if(preCtrls[k]===c) return true; } return false; };
    try{
      var n=root, h=0;
      while(n && h<6){
        var cands=n.querySelectorAll ? n.querySelectorAll('button,[role=button],[aria-label]') : [];
        for(var i=0;i<cands.length && i<200;i++){
          var c=cands[i];
          if(!cbIsCloseCtrl(c) || seenBefore(c)) continue;
          return c;
        }
        n=n.parentElement; h++;
      }
    }catch(e){}
    // last resort: any close control that appeared with the sheet
    try{
      var all=deepQuery('button,[role=button],[aria-label]');
      for(var j=0;j<all.length && j<400;j++){ if(cbIsCloseCtrl(all[j]) && !seenBefore(all[j])) return all[j]; }
    }catch(e){}
    return null;
  }
  function cbStillOpen(popEl){ try{ return !!(popEl && popEl.isConnected && vis(popEl)); }catch(e){ return false; } }
  // Close whatever we opened for this control. popEl is the resolved popup (may be null);
  // preCtrls is the pre-open snapshot of close controls, so we never click the page's own.
  // Strategy order is EMPIRICAL, measured against the real sheet (scripts/test-live-forms.js):
  //   ✓ Escape on the popup's own SEARCH BOX   ✓ clicking the trigger again (toggle)
  //   ✓ clicking the backdrop                  ✗ Escape on document (ignored by this widget)
  // The earlier version searched for a "Close" button and found the PAGE'S COOKIE BANNER instead —
  // the sheet ships no such control — so nothing ever closed and the sheets stacked up.
  function cbForceClose(el, popEl, preCtrls){
    try{ cbClose(el); }catch(e){}
    if(!popEl || !cbStillOpen(popEl)) return true;
    // 1) Escape ON THE SEARCH INPUT inside the popup (widget-level, verified to work).
    //    ⚠️ bubbles ONLY outside a host modal: a bubbling Escape reaches the application popup's
    //    own document-level close handler and throws away the user's half-filled application
    //    (YC "Apply for this role"). Non-bubbling still reaches a handler bound on the input.
    try{
      var bub = !cbInModal(el);
      var sb=cbSearchBox(el, { el: popEl });
      if(sb){
        sb.focus();
        sb.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:bub}));
        sb.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:bub}));
        if(!cbStillOpen(popEl)) return true;
      }
    }catch(e){}
    // 2) click the trigger again — a toggle, and it is the control we opened ourselves
    try{
      if(isComboTrigger(el) && vis(el)){ cbSafeClick(el); if(!cbStillOpen(popEl)) return true; }
    }catch(e){}
    // 3) a dedicated close control, when the widget actually has one (react-select, MUI dialogs)
    try{
      var btn=cbFindCloseCtrl(cbSheetRoot(popEl), preCtrls);
      if(btn){ cbSafeClick(btn); if(!cbStillOpen(popEl)) return true; }
    }catch(e){}
    // 4) the backdrop: the top-left corner is outside every sheet panel. Guarded — never a link,
    //    never a submit, and never a row inside the list itself.
    if(!cbInModal(el)){
      try{
        var pt=document.elementFromPoint(5,5);
        if(pt && !popEl.contains(pt) && pt!==el){ cbSafeClick(pt); if(!cbStillOpen(popEl)) return true; }
      }catch(e){}
      // 5) last: a bubbling document Escape (works for plain menus; ignored by sheets)
      try{ document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true})); }catch(e){}
    }
    return !cbStillOpen(popEl);
  }
  // A sheet does not render the instant we click: a fixed 360ms wait was too short for a
  // full-screen picker, so we read NO options and — worse — handed cbForceClose a null popup, whose
  // Escape fallback does nothing to that sheet. It stayed open, the next one opened on top, and the
  // user watched them stack. POLL for the popup instead of guessing a delay.
  function cbWaitPopup(el, pre, maxMs, cb){
    var t0=Date.now();
    (function tick(){
      var p=null; try{ p=cbPopup(el, pre); }catch(e){}
      if(p && cbOptions(el, p).length){ cb(p); return; }
      if(Date.now()-t0 >= maxMs){ cb(p); return; }   // p may be a popup with no rows yet
      setTimeout(tick, 120);
    })();
  }
  // Anything list-shaped still on screen gets closed. This is the "close it before opening the
  // next one" guarantee — enforced by CHECKING, not by assuming our close worked.
  // preCtrls = close controls that existed BEFORE we opened anything (captured once per run).
  var __cvfBaseCtrls = null;
  function cbBaselineCtrls(){ if(!__cvfBaseCtrls) __cvfBaseCtrls = cbPreCloseCtrls(); return __cvfBaseCtrls; }
  function cbEnsureNoneOpen(){
    var closed=0;
    try{
      var base=cbBaselineCtrls();
      for(var pass=0; pass<4; pass++){
        var ns=deepQuery(CB_POPUP_SEL), any=false;
        for(var i=0;i<ns.length && i<60;i++){
          var n=ns[i];
          if(!vis(n) || !cbLooksLikeList(n)) continue;
          // Escape on this sheet's own search box is the gesture that actually works; the trigger
          // that opened it may already be gone, so drive the popup directly.
          // same modal rule as cbForceClose: never let an Escape reach a host application popup
          var inDlg=false; try{ inDlg=!!(n.closest && n.closest('[role=dialog],[aria-modal="true"],dialog[open]')); }catch(e){}
          var sb=null; try{ sb=cbSearchBox(null, { el: n }); }catch(e){}
          if(sb){
            try{
              sb.focus();
              sb.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:!inDlg}));
              sb.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:!inDlg}));
            }catch(e){}
            if(!vis(n)){ closed++; any=true; continue; }
          }
          var b=cbFindCloseCtrl(cbSheetRoot(n), base);
          if(b){ cbSafeClick(b); if(!vis(n)){ closed++; any=true; continue; } }
          // ⚠️ NO blind corner-click here. Inside a host application modal (YC's "Apply for this
          // role" popup) the top-left corner IS the modal's backdrop — clicking it threw away the
          // user's entire half-filled application. The corner is only ever used by cbForceClose,
          // which knows the control and can check cbInModal first.
          try{
            var owner=null;
            try{ owner=n.closest && n.closest('[role=dialog],[aria-modal="true"],dialog[open]'); }catch(e2){}
            if(!owner){
              var pt=document.elementFromPoint(5,5);
              if(pt && !n.contains(pt)){ cbSafeClick(pt); if(!vis(n)){ closed++; any=true; } }
            }
          }catch(e){}
        }
        if(!any) break;   // nothing left to close
      }
    }catch(e){}
    return closed;
  }
  // Every sheet we open goes here so a final sweep can guarantee the page is left clean, even if a
  // pick failed halfway or the widget re-rendered its popup node.
  var __cvfOpened = [];
  function cbNoteOpened(el, popEl){ try{ if(popEl) __cvfOpened.push({ el: el, pop: popEl }); }catch(e){} }
  function cbCloseAllOpened(){
    for(var i=0;i<__cvfOpened.length;i++){
      try{ if(cbStillOpen(__cvfOpened[i].pop)) cbForceClose(__cvfOpened[i].el, __cvfOpened[i].pop, cbBaselineCtrls()); }catch(e){}
    }
    __cvfOpened = [];
    // Anything still standing (a sheet whose node was replaced) gets one last generic dismiss.
    try{ cbEnsureNoneOpen(); }catch(e){}
  }
  // SAFETY GUARD for every phase that clicks page elements — the same structure skillsJs uses, for
  // the same reason: while it is on a form submit is swallowed, and the loop aborts on any
  // navigation, URL change or beforeunload.
  var __cvfG = { on:false, aborted:false, url:'', h:null, b:null };
  function cbGuardOn(){
    if(__cvfG.on) return;
    __cvfG.on=true; __cvfG.aborted=false;
    try{ __cvfG.url=location.href; }catch(e){ __cvfG.url=''; }
    __cvfG.h=function(e){ try{ e.preventDefault(); e.stopPropagation(); }catch(_){} __cvfG.aborted=true; };
    __cvfG.b=function(){ __cvfG.aborted=true; };
    try{ document.addEventListener('submit', __cvfG.h, true); }catch(e){}
    try{ window.addEventListener('beforeunload', __cvfG.b, true); }catch(e){}
  }
  function cbGuardOff(){
    if(!__cvfG.on) return;
    try{ document.removeEventListener('submit', __cvfG.h, true); }catch(e){}
    try{ window.removeEventListener('beforeunload', __cvfG.b, true); }catch(e){}
    __cvfG.on=false;
  }
  function cbAborted(){ try{ if(__cvfG.url && location.href!==__cvfG.url) __cvfG.aborted=true; }catch(e){} return __cvfG.aborted; }
  // Type-then-CLICK. cb(true|false). Never throws, never presses Enter, never clicks a submit.
  //
  // Two rules earn their keep here:
  //  • The popup must be OUR popup (cbPopup with a before-picture). If we cannot establish that, we
  //    do nothing and report the field — clicking into an unidentified container is how a Submit
  //    button, a nav link and a wizard's "Save and continue" all got pressed.
  //  • If no option actually MATCHES, we give up. There used to be a "first row wins" fallback for
  //    relevance-ranked autocompletes; on a list that simply doesn't contain the answer it commits a
  //    random row — a wrong dial code, or a fabricated answer to a legal question — and then reports
  //    it as filled. An unanswered question the user can see beats a wrong one they cannot.
  function openAndPick(el, v, cb){
    var want=String(v), fin=false, trig=isComboTrigger(el), sb=null, popEl=null;
    // ALWAYS close, success or failure. Closing only on failure is what left a stack of sheets on
    // screen for the user to dismiss by hand — a pick that works still leaves the sheet up on any
    // widget that does not self-dismiss.
    function finish(ok){
      if(fin) return; fin=true;
      try{ cbForceClose(el, popEl, preC); }catch(e){}
      try{ cbEnsureNoneOpen(); }catch(e){}
      cb(ok);
    }
    if(cbAborted()){ finish(false); return; }
    bringIntoView(el);   // an off-screen widget renders its popup outside the viewport → "no options"
    var pre=cbPreOpen(), preC=cbBaselineCtrls();
    try{ el.focus(); }catch(e){}
    if(!trig){ try{ setNative(el,''); }catch(e){} }
    var ctrl=cbCtrl(el);
    if(ctrl&&ctrl!==el) cbSafeClick(ctrl);
    // A wrapper click never reaches an input-shaped trigger — it must be clicked itself to open.
    if(trig) cbSafeClick(el);
    // Wait for the sheet to actually exist before trying to type into its search box — on a
    // full-screen picker the old fixed 240ms landed before anything had rendered.
    cbWaitPopup(el, pre, 2200, function(){
      if(cbAborted()){ finish(false); return; }
      if(trig){
        // Typing into the trigger does nothing; filter via the popup's own search box when it has one.
        var pop0=cbPopup(el, pre);
        if(pop0){ popEl=pop0.el; cbNoteOpened(el, popEl); }   // known NOW, so finish() can always close it
        sb=cbSearchBox(el, pop0);
        if(sb){ try{ sb.focus(); }catch(e){} try{ setNative(sb, cbFilterFor(el, want)); }catch(e){} }
      } else {
        try{ el.focus(); }catch(e){}
        // Type the FILTER, not necessarily the raw value: dial-code widgets search by country
        // name ("india"), and "+91" finds nothing on a starts-with filter. For every non-country
        // control cbFilterFor returns the value unchanged.
        try{ setNative(el, cbFilterFor(el, want)); }catch(e){}
      }
      setTimeout(function(){
        if(cbAborted()){ finish(false); return; }
        var pop=cbPopup(el, pre);
        if(!pop){ finish(false); return; }
        popEl=pop.el; cbNoteOpened(el, popEl);   // remembered so the final sweep can guarantee closure
        function pickFrom(os, retried){
          if(cbAborted()){ finish(false); return; }
          var rbox = trig ? sb : el;   // whichever box holds our filter text
          function retry(){
            // our search filter may not match how this list spells things — clear it once and re-read
            try{ setNative(rbox,''); }catch(e){}
            setTimeout(function(){ var p2=cbPopup(el, pre)||pop; pickFrom(cbOptions(el, p2), true); }, 380);
          }
          if(!os.length){ if(rbox && !retried){ retry(); return; } finish(false); return; }
          var pool=[]; for(var i=0;i<os.length;i++) pool.push({text:cbText(os[i]),el:os[i]});
          var m=isCountryLabel(nlbl(el)) ? pickDial(pool,want) : null;
          if(!m) m=pickOpt(pool,want);
          if((!m || !m.el) && rbox && !retried){ retry(); return; }
          if(!m || !m.el || !cbSafeClick(m.el)){ finish(false); return; }
          setTimeout(function(){
            // Verify against what the widget SHOWS. el.value is not evidence for typeable combos —
            // we typed it ourselves, so comparing it to the wanted value reported success on every
            // run that misfired. (For triggers el.value IS framework-set — cbShown handles that.)
            var shown=cbNorm(cbShown(el)), mt=cbNorm(m.text), ok=false;
            try{ if(shown&&mt) ok = shown.indexOf(mt.slice(0,20))>=0 || mt.indexOf(shown.slice(0,20))>=0; }catch(e){}
            finish(ok);
          },300);
        }
        // The popup can appear only on this second look — the search box then still needs typing.
        if(trig && !sb){
          sb=cbSearchBox(el, pop);
          if(sb){
            try{ sb.focus(); }catch(e){}
            try{ setNative(sb, cbFilterFor(el, want)); }catch(e){}
            setTimeout(function(){ pickFrom(cbOptions(el, cbPopup(el, pre)||pop), false); }, 380);
            return;
          }
        }
        pickFrom(cbOptions(el, pop), false);
      },450);
    });
  }

  // Custom dropdowns hide their options until opened, so the AI was being asked to free-text a field
  // that only accepts one of N exact values. Open each one ONCE (bounded: 6 widgets, 2.5s total,
  // empty filter), read the list, then Escape+blur to restore it. Any widget that already SHOWS an
  // answer is skipped, so the user's own work is never disturbed. The submit guard is on for the
  // whole phase — the same protection skillsJs gives its chip clicks.
  function enumCombos(list, done){
    var q=[];
    for(var i=0;i<list.length&&q.length<6;i++){ if(list[i].widget==='combobox') q.push(list[i]); }
    if(!q.length){ done(); return; }
    cbGuardOn();
    var qi=0, t0=Date.now();
    function fin(){ cbGuardOff(); done(); }
    function step(){
      // Budget raised from 2.5s: a full-screen picker needs ~0.6-1s to render, so the old cap gave
      // up after ~4 widgets and every remaining dropdown reached the AI with NO options — which is
      // why they came back with wrong or empty values.
      if(qi>=q.length || Date.now()-t0>16000 || cbAborted()){ cbEnsureNoneOpen(); fin(); return; }
      var f=q[qi++], el=null, all=ctrls();
      for(var j=0;j<all.length;j++){ if(sig(all[j])===f.key){ el=all[j]; break; } }
      if(!el || cbAnswered(el)){ step(); return; }
      var pre=cbPreOpen(), preC=cbBaselineCtrls();
      bringIntoView(el);
      try{ el.focus(); }catch(e){}
      var c=cbCtrl(el); if(c&&c!==el) cbSafeClick(c);
      if(isComboTrigger(el)) cbSafeClick(el);   // wrapper clicks never reach an input-shaped trigger
      // WAIT for the list instead of guessing a delay (the 360ms guess read nothing on a sheet).
      cbWaitPopup(el, pre, 2200, function(pop){
        var popEl2 = pop ? pop.el : null;
        try{
          var os=pop?cbOptions(el, pop):[], opts=[];
          for(var k=0;k<os.length&&opts.length<60;k++){ var tx=cbText(os[k]); if(tx) opts.push(tx.slice(0,90)); }
          // A list we hit the cap on is INCOMPLETE. Say so, or the server's option-snap treats a
          // country picker's first 60 rows as the whole world and deletes "India (+91)" as
          // "no matching option".
          if(opts.length){ f.options=opts; f.optionsUnknown=false; if(os.length>=60 || cbListPartial(el, pop, os)) f.optionsTruncated=true; }
        }catch(e){}
        // CLOSE THIS ONE BEFORE OPENING THE NEXT — and verify it, rather than assuming. Reading a
        // dropdown must never leave it on screen.
        try{ cbForceClose(el, popEl2, preC); }catch(e){}
        setTimeout(function(){
          try{ cbEnsureNoneOpen(); }catch(e){}
          setTimeout(step, 120);
        }, 180);
      });
    }
    step();
  }
  // Widget-internal controls are not questions: intl-tel-input injects its own country search box,
  // which the AI would otherwise dutifully try to answer.
  function isWidgetInternal(el){
    try{ return !!(el.closest && el.closest('.iti__country-container,.iti__dropdown-content,[class*=select__menu],.MuiAutocomplete-popper,.select2-dropdown,[class*=chosen-drop]')); }catch(e){ return false; }
  }

  // THE FILL ENGINE. Shared verbatim by the main frame (fillJs) and every iframe agent (doFill), so
  // the two can never drift. frameFlag is 1 inside an iframe, 0 in the main frame.
  //
  // Reports per-field FAILURES, not just a count: a bare number let people trust a form that still
  // had required dropdowns sitting empty — and on react-select pages that was silently ALL of them.
  function runFill(bySig, frameFlag){
    try {
      var total = 0; for(var kk in bySig){ if(Object.prototype.hasOwnProperty.call(bySig,kk)) total++; }
      var filled={}, fails={}, deferred=[], dseen={};
      // The phone number we wrote, and the number we were HANDED before splitting it. Kept so the
      // split can be undone at the end if the dial half never landed (see phoneReconcile).
      var phoneRec=null;
      function fillVisible(){
        var els = ctrls();
        for (var i=0;i<els.length;i++){ var el=els[i]; var t=(el.type||'').toLowerCase();
          if (['hidden','submit','reset','image','file'].indexOf(t)>=0) continue;
          if (t==='button' && !isCombo(el)) continue;   // a button-shaped input that IS a combo (Revolut) stays in
          if (!vis(el)) continue;
          var s = sig(el);
          if (!(s in bySig)) continue;
          if (filled[s]) continue;
          var v = bySig[s]; if (v==null || v===''){ filled[s]=true; continue; }
          if (keepUser(el,t,v)){ filled[s]=true; continue; }   // user already answered this — leave it
          if (t!=='radio' && t!=='checkbox' && el.tagName!=='SELECT' && isCombo(el)){
            // keepUser() reads el.value — and react-select CLEARS el.value after a pick, so for a
            // dropdown the USER answered by hand it sees an empty box and would let us wipe and
            // re-pick their answer. Read what the widget SHOWS instead (cbAnswered also re-opens an
            // UNTOUCHED dial-code widget stuck on the page's geo-IP default).
            if (cbAnswered(el)){ filled[s]=true; continue; }
            if (!dseen[s]){
              dseen[s]=1;
              // Pre-seed the failure NOW, for every dropdown we defer. drain() deletes it on success.
              // Otherwise a widget past the 8-deep cap is neither filled nor reported — it just
              // disappears, which is the exact silence this whole change exists to remove.
              fails[s]={key:s,label:nlbl(el).slice(0,90),why:'dropdown — please pick this one yourself'};
              if (deferred.length<8) deferred.push({s:s, v:v, label:nlbl(el).slice(0,90)});
            }
            continue;
          }
          try {
            if (t==='radio'){
              var ol=(nlbl(el)||el.value||'').trim().toLowerCase(); var want=String(v).trim().toLowerCase();
              // Exact / substring first, then the confident-rewording matcher: real forms answer
              // "yes" with "Yes, I consent" and "male" with "Man", which used to match nothing and
              // leave a REQUIRED radio group empty.
              var rok = (ol===want || (want && ol.indexOf(want)>=0) || (el.value||'').toLowerCase()===want);
              if (!rok && want && ol){
                var fz=pickOptFuzzy([{text:ol}], want);
                rok = !!fz;
              }
              if (rok){ bringIntoView(el); setChecked(el,true); if(el.checked) filled[s]=true; }
            } else if (el.tagName==='SELECT'){
              bringIntoView(el);
              // MULTI-select: pick every value we can match, not just the first. "Preferred work
              // locations", "languages", "skills" are routinely multi-selects that used to receive
              // exactly one answer (or none, when the whole comma-list matched no single option).
              if (el.multiple){
                var mv=multiVals(v); if(!mv.length) mv=[String(v)];
                var oall=Array.prototype.slice.call(el.options), picked=0;
                for(var mi=0; mi<mv.length; mi++){
                  var mm=pickOpt(oall, mv[mi]);
                  if(mm){ try{ mm.selected=true; picked++; }catch(e){} }
                }
                if(picked){ fire(el); filled[s]=true; }
                else fails[s]={key:s,label:nlbl(el).slice(0,90),why:'no matching option'};
                continue;
              }
              // Country/dial-code selects first: pickOpt is a substring matcher and cannot compare
              // dial codes numerically, so "+1"/"+44"/"+7" matched nothing on a full country list.
              var oarr=Array.prototype.slice.call(el.options);
              var m=isCountrySelect(el) ? pickDial(oarr,v) : null;
              if (!m) m=pickOpt(el.options,v);
              if (m){
                setNative(el, m.value);
                // READ BACK — a controlled <select> can reject the assignment. Reporting a fill we
                // did not make is worse than reporting nothing.
                var so=el.options[el.selectedIndex];
                if (so && (so===m || cleanTxt(so.text)===cleanTxt(m.text))) filled[s]=true;
                else fails[s]={key:s,label:nlbl(el).slice(0,90),why:'the dropdown rejected the value'};
              }
              else fails[s]={key:s,label:nlbl(el).slice(0,90),why:'no matching option'};
            } else if (t==='checkbox'){
              // A checkbox GROUP ("What are your pronouns?" → He/him · She/her · They/them) carries
              // the answer in each box's LABEL, and its value attribute is just "on". Testing the
              // answer against yes/true/on made "He/him" read as FALSE — so we actively UNCHECKED
              // the very box we meant to tick. Label-match first, boolean second.
              var rawv=String(v).trim();
              var affirm=/^(yes|true|on|1|checked|y)$/i.test(rawv);
              var negate=/^(no|false|off|0|unchecked|n)$/i.test(rawv);
              if (v===true || affirm){
                bringIntoView(el); setChecked(el,true); if(el.checked) filled[s]=true;
              } else if (v===false || negate){
                // An explicit "no" must never UNTICK something the candidate ticked themselves.
                filled[s]=true;
              } else {
                var lab=cleanTxt(nlbl(el)).toLowerCase();
                var wants=multiVals(rawv); if(!wants.length) wants=[rawv];
                var hit=false;
                for (var wi=0; wi<wants.length; wi++){
                  var w=cleanTxt(wants[wi]).toLowerCase();
                  if(!w||!lab) continue;
                  if(lab===w || lab.indexOf(w)>=0 || w.indexOf(lab)>=0 || pickOptFuzzy([{text:lab}], w)){ hit=true; break; }
                }
                if (hit){ bringIntoView(el); setChecked(el,true); if(el.checked) filled[s]=true; }
                else filled[s]=true;   // a sibling box in this group is the answer — leave this one alone
              }
            } else {
              var vv=String(v);
              // A phone box next to a separate dial-code picker gets the LOCAL number only —
              // otherwise "+91 98765…" lands beside an already-selected "+91". REMEMBER the number
              // we were given: this strip is a bet that the dial picker will accept "+91", and
              // phoneReconcile() below settles that bet against what the picker actually shows.
              if (t==='tel' || /\\b(phone|mobile)\\b/i.test(nlbl(el)+' '+(el.name||''))){
                var vGiven=vv; vv=phoneLocal(vv, el);
                // FIRST phone box only. The split is a page-level pairing (one number ↔ one dial
                // control), so reconciling a second phone field against the same picker would be a
                // guess. Referee / emergency-contact numbers are excluded server-side already.
                if (!phoneRec && !isDialCtrl(el)) phoneRec={ s:s, given:vGiven };
              }
              // Native date/month inputs accept ONLY yyyy-mm-dd — anything else is silently dropped.
              if (t==='date' || t==='month') vv=dateVal(vv);
              bringIntoView(el);
              try{el.focus();}catch(e){} setNative(el,vv); try{el.dispatchEvent(new Event('blur',{bubbles:true}));el.blur();}catch(e){}
              if (sameAnswer(el.value,vv)) filled[s]=true;
              else fails[s]={key:s,label:nlbl(el).slice(0,90),why:'the field rejected the value'};
            }
          } catch(e){}
        }
      }
      // Drain the custom dropdowns ONE AT A TIME (each needs its own popup open, so they cannot
      // overlap). Elements are re-resolved by signature here rather than held from the scroll pass —
      // a virtualized form detaches them. Guard on for the whole phase; hard caps 8 widgets / 9s.
      function drain(done){
        if(!deferred.length){ done(); return; }
        cbGuardOn();
        var di=0, t0=Date.now();
        function fin(){ cbGuardOff(); done(); }
        function step(){
          // 9s was not enough once a picker needs ~1s to open, ~0.4s to filter and ~0.3s to verify:
          // later dropdowns were abandoned mid-run (some of them still on screen).
          if(di>=deferred.length || Date.now()-t0>30000 || cbAborted()){ try{ cbEnsureNoneOpen(); }catch(e){} fin(); return; }
          var d=deferred[di++], el=null, all=ctrls();
          for(var j=0;j<all.length;j++){ if(sig(all[j])===d.s && vis(all[j])){ el=all[j]; break; } }
          if(!el){ if(!filled[d.s]) fails[d.s]={key:d.s,label:d.label,why:'this dropdown left the page before we could pick'}; setTimeout(step,60); return; }
          if(cbAnswered(el)){ filled[d.s]=true; delete fails[d.s]; setTimeout(step,60); return; }
          // A multi-value widget ("Preferred work locations", languages, skills) takes several
          // picks: run them in sequence, and count the field filled if ANY landed.
          var vals=multiVals(d.v);
          if(vals.length>1 && isMultiCombo(el)){
            var vi=0, anyOk=false;
            (function pickNext(){
              if(vi>=vals.length || vi>=6){
                if(anyOk){ filled[d.s]=true; delete fails[d.s]; }
                else fails[d.s]={key:d.s,label:d.label,why:'dropdown — please pick this one yourself'};
                setTimeout(step,150); return;
              }
              var one=vals[vi++];
              var cur=null, all2=ctrls();
              for(var q=0;q<all2.length;q++){ if(sig(all2[q])===d.s && vis(all2[q])){ cur=all2[q]; break; } }
              if(!cur){ if(anyOk){ filled[d.s]=true; delete fails[d.s]; } setTimeout(step,150); return; }
              openAndPick(cur, one, function(ok){ if(ok) anyOk=true; setTimeout(pickNext,200); });
            })();
            return;
          }
          openAndPick(el, d.v, function(ok){
            if(ok){ filled[d.s]=true; delete fails[d.s]; }
            else fails[d.s]={key:d.s,label:d.label,why:'dropdown — please pick this one yourself'};
            // never start the next dropdown while this one is still on screen
            try{ cbEnsureNoneOpen(); }catch(e){}
            setTimeout(step,220);
          });
        }
        step();
      }
      // ── THE ATOMIC-SPLIT INVARIANT ─────────────────────────────────────────────
      // Never take information OUT of one field on the assumption that a second field accepted it.
      //
      // A split phone number is two writes that must succeed or fail together. The number half is a
      // text box and lands instantly; the dial half is a 240-row VIRTUALISED picker that can fail
      // for reasons we do not control. When it did, the page was left holding its own geo-IP default
      // (+44) beside OUR national digits — reported as "filled", and stored as a number that belongs
      // to nobody. Before the split existed the whole "+919970020596" went in one box: ugly, correct.
      //
      // THE TEST, applied AFTER the pickers have run: the two controls must CONCATENATE BACK to the
      // number we were handed. Read the dial control, and:
      //   • it shows a code the number actually starts with → keep the remainder (a real, correct split)
      //   • it shows anything else                          → restore the FULL international number
      // Worst case is "unsplit but correct". It is never "split and wrong".
      function phoneReconcile(){
        try{
          if(!phoneRec) return;
          var els=ctrls(), i, dialEl=null, numEl=null;
          for(i=0;i<els.length;i++){ if(isDialCtrl(els[i])){ dialEl=els[i]; break; } }
          var dsig=dialEl?sig(dialEl):null, wd='';
          // Only when the server pre-split does the code live somewhere other than the number itself:
          // in the value we were asked to put in the dial control ("+91", "India (+91)", or "India").
          if(dsig && (dsig in bySig)) wd=wantDial(bySig[dsig]) || dialForName(bySig[dsig]);
          var full=phoneDigits(phoneRec.given, wd);
          if(!full) return;                                  // no code anywhere ⇒ nothing was split
          for(i=0;i<els.length;i++){ if(sig(els[i])===phoneRec.s && vis(els[i])){ numEl=els[i]; break; } }
          if(!numEl) return;
          var got=dialOf(dialShownOf(dialEl));
          // The picker's code must be a genuine prefix of this number. That single test is both
          // "did our pick land" and "do these two fields still describe the user's number".
          var split=!!(got && full.indexOf(got)===0 && full.length>got.length);
          var target=split ? full.slice(got.length) : '+'+full;
          if(sameAnswer(numEl.value, target)) return;        // already in the right shape
          bringIntoView(numEl);
          try{ numEl.focus(); }catch(e){}
          setNative(numEl, target);
          try{ numEl.dispatchEvent(new Event('blur',{bubbles:true})); numEl.blur(); }catch(e){}
          if(sameAnswer(numEl.value, target)){ filled[phoneRec.s]=true; delete fails[phoneRec.s]; }
          else { delete filled[phoneRec.s]; fails[phoneRec.s]={key:phoneRec.s,label:nlbl(numEl).slice(0,90),why:'please check your phone number'}; }
          // Say so out loud. A dial picker we could not set is the user's to fix, and they need to
          // know the number now carries its country code so they do not add it twice.
          if(!split && dsig){
            delete filled[dsig];
            fails[dsig]={key:dsig,label:nlbl(dialEl).slice(0,90),why:'we could not set the country code — your full international number is in the phone box instead'};
          }
        }catch(e){}
      }
      function report(){
        // Leave the page as we found it: no half-open pickers for the user to dismiss by hand.
        try{ cbCloseAllOpened(); }catch(e){}
        var fl=[], n=0;
        for(var k in fails){ if(Object.prototype.hasOwnProperty.call(fails,k) && !filled[k] && fl.length<12) fl.push(fails[k]); }
        for(var k2 in filled){ if(Object.prototype.hasOwnProperty.call(filled,k2)) n++; }
        post({type:'FILLED', count:n, total:total, failed:fl, frame:frameFlag});
      }
      var passes = 0;
      function pass(){
        var before=0; for(var b in filled){ if(Object.prototype.hasOwnProperty.call(filled,b)) before++; }
        scrollThrough(fillVisible, function(){
          passes++;
          var after=0; for(var a in filled){ if(Object.prototype.hasOwnProperty.call(filled,a)) after++; }
          if (after > before && after < total && passes < 5){ pass(); }
          // Close every picker BEFORE reconciling: a full-screen sheet still on top of the phone box
          // would swallow the focus/typing that puts the international number back.
          else { drain(function(){ try{ cbCloseAllOpened(); }catch(e){} setTimeout(function(){ phoneReconcile(); report(); }, 180); }); }
        });
      }
      pass();
    } catch(e){ post({type:'AUTOFILL_ERROR', error:String((e && e.message) || e)}); }
  }

  // Respect work the user already did by hand: if a control already holds a different non-empty
  // answer, autofill leaves it alone (and reports it as handled) instead of overwriting it.
  //
  // A <select> needs care. Its "current answer" is usually whatever the BROWSER or the PAGE chose,
  // not the user's work — but the two are indistinguishable in general, so we relax only where it is
  // provably safe:
  //   • an option with an EMPTY VALUE is a placeholder ("Select country", "Select…"). It can never be
  //     submitted as an answer, so it is never the user's — safe to override on ANY select.
  //   • the page's own default (an explicit <option selected>, or the browser's implicit index-0
  //     pick) is overridden ONLY on a country / dial-code control. That is the "+91 never applies
  //     because the box already reads United States (+1)" bug.
  // Everywhere else a non-empty selection is still treated as the user's — so a Yes/No consent select
  // sitting at index 0 (where defaultSelected is false!) is never silently changed.
  function isPlaceholderOpt(o){
    if(!o) return true;
    if(o.disabled) return true;
    if(!String(o.value==null?'':o.value).trim()) return true;
    var t=cleanTxt(o.text||'');
    if(!t) return true;
    return /^(-{2,}|select\\b|choose\\b|please\\b)/i.test(t);
  }
  function selIsUserAnswer(el){
    try{
      var i=el.selectedIndex; if(i<0) return false;
      var o=el.options[i]; if(!o) return false;
      if(isPlaceholderOpt(o)) return false;
      // A country / dial-code control is the one place we override a selection nobody made. Beyond
      // the markup default and the browser's index-0 pick, a geo-IP script that calls
      // selectedIndex = <United States> leaves NOTHING in the DOM to distinguish it from a real
      // choice — so we trust the touch flag FOCUS_DETECT_JS sets on genuine user gestures instead.
      if(isCountrySelect(el)){
        if(el.__cvfTouched) return true;
        if(o.defaultSelected) return false;
        if(i===0) return false;
        return false;
      }
      return true;
    }catch(e){ return false; }
  }
  function keepUser(el, t, v){
    try{
      if(t==='radio'||t==='checkbox'||t==='file') return false;
      if(el.tagName==='SELECT'){
        if(!selIsUserAnswer(el)) return false;
        var o=el.options[el.selectedIndex];
        var cur=cleanTxt(o.text||o.value||'');
        return cur ? cur.toLowerCase()!==cleanTxt(v).toLowerCase() : false;
      }
      // An UNTOUCHED country / dial-code widget holding the page's default is nobody's answer —
      // same rule selIsUserAnswer applies to native selects. A trusted user gesture (FOCUS_DETECT
      // marks __cvfTouched) still protects a real choice.
      if(isCombo(el) && isCountryLabel(nlbl(el)) && !el.__cvfTouched) return false;
      var cv=cleanTxt(el.value||'');
      if(!cv) return false;
      return cv.toLowerCase()!==cleanTxt(v).toLowerCase();
    }catch(e){ return false; }
  }
  // ── Phone / dial-code splitting ─────────────────────────────────────────────
  // A dial-code control, as opposed to a plain country control. "Current country" must NOT match:
  // it is a residence question, and treating it as the phone's code half would pair the number with
  // the wrong widget entirely.
  var DIAL_LABEL=/dial|calling code|phone code|country code|phone country|\\bisd\\b/i;
  function isDialCtrl(el){
    try{
      if(!el || !vis(el)) return false;
      if(el.tagName==='SELECT') return isPhoneCodeOpts(Array.prototype.slice.call(el.options));
      return isCombo(el) && DIAL_LABEL.test(cleanTxt(nlbl(el)));
    }catch(e){ return false; }
  }
  // The dial control as it READS RIGHT NOW — the only evidence that our pick landed. A <select>
  // answers through its selected option; a combo through cbShown (which knows a trigger keeps its
  // selection in el.value while react-select clears it).
  function dialShownOf(el){
    try{
      if(!el) return '';
      if(el.tagName==='SELECT'){ var o=el.options[el.selectedIndex]; return o?cleanTxt(o.text||o.value||''):''; }
      return cbShown(el);
    }catch(e){ return ''; }
  }
  // The FULL international digits of the number we were handed — the one fact both halves of a split
  // must add up to. Either the value already carries them ("+91 99700 20596", "0091 99700 20596"), or
  // the server pre-split it and the code is whatever we were asked to put in the dial control.
  // Returns '' when the code is unknowable; we never invent one.
  //
  // ⚠️ Do NOT reach for wantDial() here. It reads the first 1-4 digits after a "+", which is right for
  // a code on its own ("+91", "India (+91)") and WRONG for a whole number: wantDial("+919970020596")
  // is "9199". Where the code ends is decided by the dial control, never by a regex over the number.
  // (No backticks in this comment — one inside this template literal terminates it and breaks the build.)
  function phoneDigits(given, wd){
    try{
      var s=cleanTxt(given); if(!s) return '';
      var d=s.replace(/[^0-9]/g,''); if(!d) return '';
      if(/^\\s*\\+/.test(s)) return d;
      if(/^\\s*00\\d/.test(s)) return d.replace(/^0+/,'');     // 0091… is +91…
      return wd ? wd+d : '';
    }catch(e){ return ''; }
  }
  // Does this page carry a SEPARATE dial-code control (a phone-code select, or a combo labeled
  // like one)? Cached: fillVisible runs on every scroll step.
  var __cvfDialAt=0, __cvfDialOn=false;
  function pageHasDialControl(){
    var now=Date.now(); if(now-__cvfDialAt<3000) return __cvfDialOn;
    __cvfDialAt=now; __cvfDialOn=false;
    try{
      var els=ctrls();
      for(var i=0;i<els.length;i++){ if(isDialCtrl(els[i])){ __cvfDialOn=true; break; } }
    }catch(e){}
    return __cvfDialOn;
  }
  function phoneLocal(v, el){
    var s=cleanTxt(v);
    if(!/^(\\+|00)\\d/.test(s.replace(/\\s/g,''))) return v;              // no international prefix — nothing to strip
    try{ if(/includ|with.*country|full.*international/i.test(nlbl(el))) return v; }catch(e){}   // the label ASKS for the code
    if(!pageHasDialControl()) return v;
    var m=s.match(/^\\+\\s*\\d{1,3}[\\s.\\-]*/);
    if(!m) m=s.match(/^00\\d{1,3}[\\s.\\-]*/);
    if(!m) return v;
    var rest=s.slice(m[0].length).replace(/^[\\s.\\-()]+/,'');
    return rest.replace(/[^0-9]/g,'').length>=5 ? rest : v;              // never strip a value that IS just the code
  }
  // A widget that REFORMATS what we typed still filled correctly (typing "2026-09-01" into a date
  // field can leave it reading "09/01/2026", and strict equality reported that as a failure — then
  // burned another full-page pass retrying it). Used ONLY to judge whether OUR write landed.
  // Digit-reordering tolerance is restricted to DATE-shaped strings on purpose: two phone numbers
  // ending 0123 and 0132 are anagrams of each other and must never read back as "filled".
  function cbDateish(s){ try{ return /\\d{4}/.test(s) && s.replace(/[^0-9]/g,'').length===8; }catch(e){ return false; } }
  function sameAnswer(a, b){
    var x=cbNorm(a), y=cbNorm(b);
    if(x===y) return true;
    if(!x||!y) return false;
    if(cbDateish(x)&&cbDateish(y)){
      var dx=x.replace(/[^0-9]/g,'').split('').sort().join('');
      var dy=y.replace(/[^0-9]/g,'').split('').sort().join('');
      if(dx===dy) return true;
    }
    var sx=x.replace(/[^a-z0-9]/g,''), sy=y.replace(/[^a-z0-9]/g,'');
    return !!sx && sx===sy;
  }
  function findScroller(){ var best=null,bestH=0; try{ var c=document.querySelectorAll('div,main,section,form,ul,ol'); for(var i=0;i<c.length&&i<5000;i++){ var e=c[i]; var diff=e.scrollHeight-e.clientHeight; if(diff>bestH+60){ var oy=''; try{oy=getComputedStyle(e).overflowY;}catch(_){} if(oy==='auto'||oy==='scroll'){ bestH=diff; best=e; } } } }catch(_){} return best; }
  function scrollThrough(onStep, onDone){
    var scroller=findScroller(); var docEl=document.scrollingElement||document.documentElement;
    function maxH(){ var a=docEl?docEl.scrollHeight:0; var b=scroller?scroller.scrollHeight:0; var c=document.body?document.body.scrollHeight:0; return Math.max(a,b,c); }
    var startW=window.pageYOffset||0; var startS=scroller?scroller.scrollTop:0;
    var stepPx=Math.max(220,(window.innerHeight||600)*0.75); var y=0; var guard=0;
    function go(){ try{window.scrollTo(0,y);}catch(e){} if(scroller){try{scroller.scrollTop=y;}catch(e){}} setTimeout(function(){ try{onStep();}catch(e){} y+=stepPx; guard++; if(y<maxH()&&guard<160){ go(); } else { try{window.scrollTo(0,startW);}catch(e){} if(scroller){try{scroller.scrollTop=startS;}catch(e){}} setTimeout(function(){ try{onStep();}catch(e){} onDone(); },220); } },165); }
    go();
  }
`;

// ── MULTI-STEP (wizard) DETECTION ─────────────────────────────────────────────
// READ-ONLY. Nothing here clicks anything. It answers three questions honestly: is this a multi-step
// form, which step are we on, and is there a forward control we would ever consider safe.
//
// Written against real portal DOM:
//   iCIMS   <li class="iCIMS_Steps_Current"><span class="sr-only">Step 3 of 4. …(Current Step)
//           The container's innerText concatenates ALL FOUR ordinals, so "first match wins" reads
//           1 of 4 while standing on step 3 — which would also make the i>=n last-step guard dead.
//           So an ordinal is trusted only when the element carrying it is MARKED CURRENT and yields
//           exactly ONE distinct ordinal.
//   Ashby   <button>Submit Application</button> with el.form === null — proof that "cannot submit a
//           form" is NOT sufficient on its own; the label gate is what catches it.
//   Workday el.type === 'submit' on the HAMBURGER MENU, because HTMLButtonElement.type DEFAULTS to
//           "submit". Every type test below therefore uses getAttribute('type'), never el.type.
//
// NOTE: declared HERE, above FRAME_AGENT_JS, because FRAME_AGENT_JS interpolates it. Declaring it
// further down puts it in the temporal dead zone and the whole module throws on load.
const WIZARD_HELPERS = `
  function wfold(s){ try{ return String(s||'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/\\u00df/g,'ss').replace(/[\\u2019\\u00b4']/g,'').replace(/\\s+/g,' ').trim().toLowerCase(); }catch(e){ return String(s||'').toLowerCase(); } }
  // The whole label must BE a next-word (optional chevron). Anchored, so "Next steps in our process"
  // is prose and must not match.
  var W_NEXT = /^(?:next|next step|next page|continue|save and continue|save & continue|proceed|weiter|naechster schritt|fortfahren|speichern und fortfahren|suivant|suivante|continuer|etape suivante|siguiente|continuar|paso siguiente|avanti|prosegui|continua|volgende|doorgaan|verder|proximo|prosseguir|dalej|kontynuuj|nasta|fortsatt|neste|seuraava|jatka)(?:\\s*[>\\u00bb\\u2192\\u203a]+)?$/i;
  // ANY occurrence anywhere in the label vetoes. Deliberately broad.
  var W_SUBMIT = /\\b(submit|apply|application|send|finish|finalise|finalize|absenden|abschicken|abschliessen|bewerben|bewerbung|einreichen|envoyer|soumettre|postuler|terminer|candidature|enviar|postular|solicitud|finalizar|invia|inviare|candidati|candidatura|termina|verzenden|versturen|solliciteer|sollicitatie|voltooien|indienen|submeter|candidatar|concluir|wyslij|aplikuj|zloz|zakoncz|skicka|ansok|ansokan|slutfor)\\b/i;
  var W_REVIEW = /\\b(review your application|please review|review and submit|final step|last step|almost done|confirm and submit|zusammenfassung|letzter schritt|recapitulatif|derniere etape|ultimo paso|riepilogo|ultimo passo|laatste stap|ultima etapa|podsumowanie|ostatni krok|sammanfattning|sista steget)\\b/i;
  // GLOBAL (we COUNT matches, we never take the first). "page/seite/pagina" deliberately dropped:
  // "Page 1 of 3" is pagination, not a wizard — a pure false-ordinal generator.
  var W_ORD    = /(?:^|[^a-z0-9])(?:step|schritt|etape|paso|passo|passaggio|stap|etapa|krok|steg)\\s*(\\d{1,2})\\s*(?:of|von|sur|de|di|van|z|av|\\/)\\s*(\\d{1,2})(?![0-9])/gi;
  var W_NOTCUR = /(?:^|[-_ ])(?:not[-_]?current|notcurrent|inactive|disabled|incomplete|pending|upcoming|future|completed|complete|done|visited)(?:[-_ ]|$)/i;
  var W_CURTOK = /^(?:current|active|selected|is-active|is-current|in-progress|iCIMS_Steps_Current)$/i;
  var W_STEPPY = /step|stepper|wizard|progress|iCIMS_Steps/i;

  // Tokenised — a whole-string regex lets "iCIMS_Steps_NotCurrent" pass as current.
  function wCurClass(el){
    try{
      var cn = el.className; if(cn && typeof cn!=='string' && cn.baseVal!=null) cn=cn.baseVal;
      cn = String(cn||''); if(W_NOTCUR.test(cn)) return false;
      var toks = cn.split(/[\\s]+/);
      for(var i=0;i<toks.length;i++){
        var t=toks[i]; if(!t) continue;
        if(W_CURTOK.test(t)) return true;
        if(/(^|[-_])current$/i.test(t) && !/not[-_]?current/i.test(t)) return true;
        if(/(^|[-_])(active|selected)$/i.test(t)) return true;
      }
    }catch(e){}
    return false;
  }
  function wAllOrds(s){
    var out=[], m; W_ORD.lastIndex=0;
    while((m=W_ORD.exec(s))!==null){
      var i=parseInt(m[1],10), n=parseInt(m[2],10);
      if(i>=1 && n>=2 && n<=20 && i<=n) out.push(i+'/'+n);
      if(out.length>6) break;
    }
    return out;
  }
  function wUniq(a){ var s={},o=[]; for(var i=0;i<a.length;i++){ if(!s[a[i]]){ s[a[i]]=1; o.push(a[i]); } } return o; }
  function wChrome(el){ try{ return !!(el.closest && el.closest('nav,header,footer,[role=navigation],[role=banner],[role=contentinfo]')); }catch(e){ return false; } }

  // ORDINAL. Three tiers, each requiring EXACTLY ONE distinct ordinal in the text it reads — more
  // than one means the text concatenates a whole stepper and cannot be trusted.
  function wOrdinal(){
    var best=null;
    try{
      var els=document.querySelectorAll('[aria-current],[role=tab],[class*=step],[class*=Step],[class*=stepper],[class*=Stepper],[class*=wizard],[class*=Wizard],[class*=progress],[class*=Progress],[data-automation-id]');
      for(var i=0;i<els.length && i<400;i++){
        var e=els[i]; if(wChrome(e)) continue;
        var ac=e.getAttribute('aria-current');
        var marked = (ac==='step'||ac==='true'||ac==='page') || e.getAttribute('aria-selected')==='true' || wCurClass(e);
        if(!marked) continue;
        var hay=wfold((e.getAttribute('aria-label')||'')+' '+txtOf(e).slice(0,240));
        var o=wUniq(wAllOrds(hay));
        if(o.length===1){ var p=o[0].split('/'); return {i:parseInt(p[0],10), n:parseInt(p[1],10), src:'marked'}; }
      }
    }catch(e){}
    try{
      var pools=[String(document.title||'')];
      var hs=document.querySelectorAll('h1,h2,h3,legend,[role=heading]');
      for(var k=0;k<hs.length && k<80;k++){ if(!wChrome(hs[k])) pools.push(txtOf(hs[k]).slice(0,160)); }
      for(var j=0;j<pools.length;j++){
        var oo=wUniq(wAllOrds(wfold(pools[j])));
        if(oo.length===1){ var q=oo[0].split('/'); best={i:parseInt(q[0],10), n:parseInt(q[1],10), src:'heading'}; break; }
      }
    }catch(e){}
    if(best) return best;
    try{
      var body=wfold(String((document.body&&document.body.innerText)||'').slice(0,8000));
      var ob=wUniq(wAllOrds(body));
      if(ob.length===1){ var r=ob[0].split('/'); return {i:parseInt(r[0],10), n:parseInt(r[1],10), src:'body'}; }
      if(ob.length>1) return {i:0, n:0, src:'ambiguous-text', ambiguous:1};
    }catch(e){}
    return null;
  }
  // STEPPER. Only role=tablist, or a container whose OWN class/data-automation-id says
  // step/stepper/wizard/progress. A blanket "any ol/ul with 2-20 children" turned an ordinary
  // <ul class="nav"><li class="nav-item active"> into a fake "1 of 2" on single-page forms.
  function wStepper(){
    var groups=[];
    try{ var tl=document.querySelectorAll('[role=tablist]');
         for(var a=0;a<tl.length;a++){ if(wChrome(tl[a])) continue; var tabs=tl[a].querySelectorAll('[role=tab]'); if(tabs.length>=2) groups.push(tabs); } }catch(e){}
    try{ var cs=document.querySelectorAll('[data-automation-id=progressBar],[class*=stepper],[class*=Stepper],[class*=wizard],[class*=Wizard],[class*=Steps],[class*=steps],[class*=progress-nav]');
         for(var b=0;b<cs.length && b<120;b++){ var c=cs[b]; if(wChrome(c)) continue;
           var cn=String((typeof c.className==='string'?c.className:'')||'')+' '+String(c.getAttribute('data-automation-id')||'');
           if(!W_STEPPY.test(cn)) continue;
           var kids=c.children; if(kids && kids.length>=2 && kids.length<=20) groups.push(kids); } }catch(e){}
    for(var g=0;g<groups.length;g++){
      var it=groups[g]; if(!it || it.length<2 || it.length>20) continue;
      var cur=-1, names=[], bad=false;
      for(var k=0;k<it.length;k++){
        var e2=it[k]; if(!e2 || !e2.getAttribute){ names.push(''); continue; }
        names.push(txtOf(e2).slice(0,60));
        var ac2=e2.getAttribute('aria-current');
        var isCur=(e2.getAttribute('aria-selected')==='true')||(ac2==='step'||ac2==='true')||wCurClass(e2);
        if(isCur){ if(cur>=0){ bad=true; break; } cur=k; }   // two "current" marks ⇒ untrustworthy
      }
      if(!bad && cur>=0) return {i:cur+1, n:it.length, src:'stepper', names:names};
    }
    return null;
  }
  // Identity of the step we are standing on: its ordinal plus the shape of its field set. RN compares
  // this across probes to notice the USER advancing the wizard.
  function wStepKey(){
    var o=wOrdinal()||wStepper();
    var sigs=[]; try{ var els=ctrls();
      for(var i=0;i<els.length;i++){ var t=(els[i].type||'').toLowerCase();
        if(['hidden','submit','button','reset','image'].indexOf(t)>=0) continue;
        if(!vis(els[i])) continue; sigs.push(sig(els[i])); } }catch(e){}
    sigs.sort();
    return ((o&&o.n)?(o.i+'/'+o.n):'?') + '#' + sigs.length + '#' + sigs.join(',').slice(0,600);
  }
  function wRequiredEmpty(){
    var n=0; try{ var els=ctrls();
      for(var i=0;i<els.length;i++){ var el=els[i], t=(el.type||'').toLowerCase();
        if(['hidden','submit','button','reset','image','file','radio','checkbox'].indexOf(t)>=0) continue;
        if(!vis(el)) continue;
        if(!(el.required || el.getAttribute('aria-required')==='true')) continue;
        if(!String(el.value||'').trim()) n++; } }catch(e){}
    return n;
  }
  // THE GATE. Returns {el,why,rejected} and NEVER clicks — the caller only ever REPORTS.
  function wFindNext(){
    var cands=[], rejected=[], best=null;
    try{ cands=document.querySelectorAll('button,input[type=submit],input[type=button],[role=button],a'); }catch(e){ return {el:null, why:'no-dom', rejected:rejected}; }
    for(var i=0;i<cands.length;i++){
      var el=cands[i];
      if(!vis(el) || el.disabled || el.getAttribute('aria-disabled')==='true') continue;
      var lab=wfold(el.innerText||el.value||el.getAttribute('aria-label')||el.getAttribute('title')||'');
      if(!lab || lab.length>44) continue;
      // GATE A — the label must BE a next-word AND carry no submit token in any language.
      if(!W_NEXT.test(lab)){ if(W_SUBMIT.test(lab)) rejected.push(lab.slice(0,28)+':submit-word'); continue; }
      if(W_SUBMIT.test(lab)){ rejected.push(lab.slice(0,28)+':submit-word'); continue; }
      // GATE B — structurally incapable of submitting a form. NEVER el.type (it defaults to submit).
      var at=String((el.getAttribute && el.getAttribute('type'))||'').toLowerCase();
      if(at==='submit'||at==='image'){ rejected.push(lab.slice(0,28)+':type'); continue; }
      if(el.form){ rejected.push(lab.slice(0,28)+':inform'); continue; }
      try{ if(el.closest && el.closest('form')){ rejected.push(lab.slice(0,28)+':form'); continue; } }catch(e){}
      if(el.getAttribute && el.getAttribute('form')){ rejected.push(lab.slice(0,28)+':formattr'); continue; }
      // GATE B2 — a real navigation link is not a wizard control.
      if(el.tagName==='A'){ var h=el.getAttribute('href')||''; if(h && h!=='#' && h.indexOf('javascript:')!==0){ rejected.push(lab.slice(0,28)+':href'); continue; } }
      // GATE B3 — never site chrome.
      if(wChrome(el)){ rejected.push(lab.slice(0,28)+':chrome'); continue; }
      if(best) return {el:null, why:'ambiguous', rejected:rejected};   // two candidates ⇒ refuse
      best=el;
    }
    return best ? {el:best, why:'ok', rejected:rejected} : {el:null, why:'none', rejected:rejected};
  }
  // The single report both the main frame and every iframe agent send back.
  function wReport(frameFlag){
    try{
      var ord = wOrdinal(); if(ord && !ord.n) ord=null;   // 'ambiguous-text' ⇒ no ordinal
      if(!ord) ord = wStepper();
      var nx = wFindNext();
      var txt = wfold(String((document.body&&document.body.innerText)||'').slice(0,8000));
      var review = W_REVIEW.test(txt);
      if(ord && ord.names){ try{ var cn=wfold(ord.names[ord.i-1]||''); if(W_REVIEW.test(cn)||W_SUBMIT.test(cn)) review=true; }catch(e){} }
      post({type:'WIZARD', frame:frameFlag,
        hasOrdinal: !!ord, i:(ord?ord.i:0), n:(ord?ord.n:0), src:(ord?ord.src:''),
        stepName:(ord&&ord.names?String(ord.names[ord.i-1]||'').slice(0,40):''),
        canNext: !!nx.el, why: nx.why, rejected:(nx.rejected||[]).slice(0,6),
        review: review, requiredEmpty: wRequiredEmpty(), stepKey: wStepKey()});
    }catch(e){ post({type:'WIZARD', frame:frameFlag, error:String((e&&e.message)||e)}); }
  }
`;

// Read-only wizard probe for the main frame. Clicks NOTHING.
const WIZARD_PROBE_JS = `(function(){
  ${JS_HELPERS}
  ${WIZARD_HELPERS}
  wReport(0);
})(); true;`;

// Watches for the USER advancing a multi-step form. We never press Next ourselves — the person is
// the safety interlock — but once they do, the newly rendered step should fill itself instead of
// making them hunt for the Auto Fill button again. Posts STEP_CHANGED with the new step identity.
const WIZARD_WATCH_JS = `(function(){
  if (window.__cvfSkipFrame) return;
  if (window.__cvfStepWatch) return; window.__cvfStepWatch = true;
  ${JS_HELPERS}
  ${WIZARD_HELPERS}
  var last='', t=null, armed=false;
  window.__cvfArmStepWatch=function(){ armed=true; try{ last=wStepKey(); }catch(e){ last=''; } };
  function check(){
    t=null;
    if(!armed) return;
    var k=''; try{ k=wStepKey(); }catch(e){ return; }
    if(!k || k===last) return;
    last=k;
    post({type:'STEP_CHANGED', stepKey:k});
  }
  function ping(){ if(t) return; t=setTimeout(check, 1200); }
  try{
    var mo=new MutationObserver(function(muts){
      for(var i=0;i<muts.length;i++){ if(muts[i].addedNodes&&muts[i].addedNodes.length){ ping(); return; } }
    });
    mo.observe(document.documentElement,{childList:true,subtree:true});
  }catch(e){}
})(); true;`;

// 1) SCROLL through the whole form, snapshotting every field by signature as it renders.
const READ_FIELDS_JS = `(function(){
  ${JS_HELPERS}
  try {
    var out=[], seen={}, rgroups={};
    function snap(){
      var els=ctrls();
      for(var i=0;i<els.length;i++){ var el=els[i]; var t=(el.type||'').toLowerCase();
        if(['hidden','submit','reset','image'].indexOf(t)>=0) continue;
        if(t==='button' && !isCombo(el)) continue;   // button-shaped inputs that ARE dropdowns (Revolut) stay in
        if(!vis(el)) continue;
        if(isWidgetInternal(el)) continue;
        var s=sig(el);
        if(t==='radio'){
          if(!rgroups[s]){ rgroups[s]={key:s,tag:'radio',type:'radio',name:(el.name||'').slice(0,60),label:radioQuestion(el).slice(0,180),required:!!el.required,options:[]}; out.push(rgroups[s]); }
          var ol=(nlbl(el)||el.value||'').slice(0,80); if(ol&&rgroups[s].options.indexOf(ol)<0) rgroups[s].options.push(ol);
          continue;
        }
        if(seen[s]) continue; seen[s]=true;
        var f={key:s,tag:el.tagName.toLowerCase(),type:t,name:(el.name||'').slice(0,60),placeholder:(el.placeholder||'').slice(0,80),label:nlbl(el).slice(0,140),required:!!el.required,accept:(el.getAttribute&&el.getAttribute('accept'))||''};
        if(el.tagName==='SELECT'){ var _all=Array.prototype.slice.call(el.options).map(function(o){return (o.text||'').trim();}).filter(Boolean); f.options=_all.slice(0,80); // A 240-country list truncated to 80 hides India. Flag it so the server does not read the
          // first 80 rows as the whole list and delete the value as "no matching option".
          if(_all.length>80) f.optionsTruncated=true; }
        else if(isCombo(el)){ f.widget='combobox'; f.optionsUnknown=true; }
        out.push(f);
      }
    }
    // SPA forms (SmartRecruiters one-click, Workday, etc.) render their inputs AFTER first paint, so a
    // single scan finds nothing → "No fillable fields found". Retry for ~5s until fields appear.
    var tries=0;
    (function run(){
      out=[]; seen={}; rgroups={};
      scrollThrough(snap, function(){
        if(out.length>0){ enumCombos(out, function(){ post({type:'FIELDS', fields: out}); }); }
        else if(++tries>=11){ post({type:'FIELDS', fields: out}); }
        else { setTimeout(run, 450); }
      });
    })();
  } catch(e){ post({type:'AUTOFILL_ERROR', error: String((e && e.message) || e)}); }
})(); true;`;

// Installed on every page load (via the WebView's injectedJavaScript): when the user taps a
// file-upload field, intercept it and ask RN to offer our resume / cover letter to attach.

const INTERCEPT_FILES_JS = `(function(){
  if (window.__cvfSkipFrame) return;
  if (window.__cvfFileHook) return; window.__cvfFileHook = true;
  function post(o){ try{ o.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  document.addEventListener('click', function(ev){
    try {
      // composedPath()[0] is the real target inside a shadow root; identical to ev.target elsewhere.
      var el = (ev.composedPath && ev.composedPath()[0]) || ev.target;
      if (!el || el.tagName!=='INPUT' || (el.type||'').toLowerCase()!=='file') return;
      if (el.__cvfSkip){ el.__cvfSkip=false; return; }   // let the native picker open this once
      ev.preventDefault(); ev.stopPropagation();
      if (!el.getAttribute('data-cvf')){ window.__cvfN=(window.__cvfN||0)+1; el.setAttribute('data-cvf','cvf_file_'+window.__cvfN); }
      post({type:'FILE_PICK', key:el.getAttribute('data-cvf'), accept:(el.getAttribute('accept')||''), label:(el.getAttribute('aria-label')||el.name||'')});
    } catch(e){}
  }, true);
})(); true;`;

// Installed on every page load: tell RN which form field the user just focused, so the
// "smart copy" popup can lead with the right value for that field. Self-contained helpers.
const FOCUS_DETECT_JS = `(function(){
  if (window.__cvfSkipFrame) return;
  if (window.__cvfFocusHook) return; window.__cvfFocusHook = true;
  ${JS_HELPERS}
  // Mark controls the PERSON actually operated. isTrusted is true only for a real user gesture, so
  // this distinguishes "the user chose United States" from "the page's geo-IP script preselected
  // United States" — which are identical in the DOM, and which keepUser previously had to guess
  // between. Installed at page load, so it also captures anything they filled BEFORE tapping Auto Fill.
  var mark = function(ev){
    try{ if(!ev || !ev.isTrusted) return; var t=ev.target;
      if(t && (t.tagName==='SELECT'||t.tagName==='INPUT'||t.tagName==='TEXTAREA')) t.__cvfTouched = true; }catch(e){}
  };
  document.addEventListener('change', mark, true);
  document.addEventListener('input', mark, true);
  // Trigger-style dropdowns (input[type=button]) get no native change/input event when the user
  // picks — a trusted CLICK on the control is the gesture that proves the selection is theirs.
  document.addEventListener('click', mark, true);
  document.addEventListener('focus', function(ev){
    try {
      var el = ev.target; if(!el) return; var tag = el.tagName;
      if (tag!=='INPUT' && tag!=='TEXTAREA' && tag!=='SELECT') return;
      var t = (el.type||'').toLowerCase();
      if (['hidden','submit','button','reset','image','file'].indexOf(t) >= 0) return;
      post({ type:'FIELD_FOCUS', key:sig(el), label:(t==='radio'?radioQuestion(el):nlbl(el)).slice(0,140), fieldType:t });
    } catch(e){}
  }, true);
})(); true;`;

// Injected on demand (at submit time) to HARVEST what the user filled, so autofill learns.
// Reads each visible, non-sensitive field's question + value and posts them to RN.
const HARVEST_JS = `(function(){
  ${JS_HELPERS}
  try {
    var out=[], seenRadio={};
    var els=ctrls();
    for(var i=0;i<els.length;i++){ var el=els[i]; var t=(el.type||'').toLowerCase();
      if(['hidden','submit','button','reset','image','file','password'].indexOf(t)>=0) continue;
      if(!vis(el)) continue;
      var label='', value='';
      if(t==='radio'){ if(!el.checked) continue; var rk=el.name||sig(el); if(seenRadio[rk]) continue; seenRadio[rk]=true; label=radioQuestion(el); value=nlbl(el)||el.value||''; }
      else if(t==='checkbox'){ label=nlbl(el); value=el.checked?'Yes':'No'; }
      else if(el.tagName==='SELECT'){ label=nlbl(el); var so=el.options&&el.options[el.selectedIndex]; value=so?(so.text||so.value||''):''; }
      else { value=(el.value||'').trim(); if(!value) continue; label=nlbl(el); }
      if(label && value) out.push({ label:String(label).slice(0,140), value:String(value).slice(0,200), type:t });
    }
    post({ type:'HARVEST', answers: out });
  } catch(e){}
})(); true;`;

// ── IFRAME AGENT ────────────────────────────────────────────────────────────────
// Many ATS embed the real application form in a CROSS-ORIGIN iframe (e.g. Greenhouse's
// grnhse_iframe → job-boards.greenhouse.io). injectJavaScript() only runs in the MAIN frame, so the
// scan/fill/attach never reached those fields ("No fillable fields found"). With the WebView's
// injectedJavaScriptForMainFrameOnly={false}, THIS script runs inside every frame; child frames then
// act on relayed commands (scan/fill/attach) posted from the main frame. The MAIN frame keeps its own
// direct path (READ_FIELDS_JS / fillJs / attachJs) unchanged — child frames only SUPPLEMENT it, so a
// normal (non-iframe) page behaves exactly as before.
const FRAME_AGENT_JS = `(function(){
  if (window.__cvfSkipFrame) return;
  if (window.__cvfAgent) return; window.__cvfAgent = true;
  ${JS_HELPERS}
  ${WIZARD_HELPERS}
  function b64ToFile(b64, filename, mime){ var bin=atob(b64); var bytes=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i); return new File([bytes], filename, {type:mime||'application/pdf'}); }
  function doScan(){
    try {
      // Tell RN a REAL agent frame is working, so the debounce waits for THIS frame. Captcha iframes
      // are marked __cvfSkipFrame by FRAME_GUARD_JS and never install the agent, so
      // window.frames.length is NOT a usable count of who owes us an answer.
      post({type:'FRAME_SCANNING', frame:1});
      var out=[], seen={}, rgroups={};
      function snap(){ var els=ctrls();
        for(var i=0;i<els.length;i++){ var el=els[i]; var t=(el.type||'').toLowerCase();
          if(['hidden','submit','reset','image'].indexOf(t)>=0) continue;
          if(t==='button' && !isCombo(el)) continue;
          if(!vis(el)) continue;
          if(isWidgetInternal(el)) continue;
          var s=sig(el);
          if(t==='radio'){ if(!rgroups[s]){ rgroups[s]={key:s,tag:'radio',type:'radio',name:(el.name||'').slice(0,60),label:radioQuestion(el).slice(0,180),required:!!el.required,options:[]}; out.push(rgroups[s]); } var ol=(nlbl(el)||el.value||'').slice(0,80); if(ol&&rgroups[s].options.indexOf(ol)<0) rgroups[s].options.push(ol); continue; }
          if(seen[s]) continue; seen[s]=true;
          var f={key:s,tag:el.tagName.toLowerCase(),type:t,name:(el.name||'').slice(0,60),placeholder:(el.placeholder||'').slice(0,80),label:nlbl(el).slice(0,140),required:!!el.required,accept:(el.getAttribute&&el.getAttribute('accept'))||''};
          if(el.tagName==='SELECT'){ var _all=Array.prototype.slice.call(el.options).map(function(o){return (o.text||'').trim();}).filter(Boolean); f.options=_all.slice(0,80); // A 240-country list truncated to 80 hides India. Flag it so the server does not read the
          // first 80 rows as the whole list and delete the value as "no matching option".
          if(_all.length>80) f.optionsTruncated=true; }
          else if(isCombo(el)){ f.widget='combobox'; f.optionsUnknown=true; }
          out.push(f);
        }
      }
      // Retry for ~5s so a cross-origin ATS iframe that renders its form late still gets scanned.
      // A child frame that finds nothing must still say DONE — otherwise RN waits for a frame that
      // will never answer — but it posts an empty list, which the RN side does not treat as terminal.
      var tries=0;
      (function run(){
        out=[]; seen={}; rgroups={};
        scrollThrough(snap, function(){
          if(out.length>0){ enumCombos(out, function(){ post({type:'FIELDS', fields: out, frame:1}); }); }
          else if(++tries<11){ setTimeout(run, 450); }
          else { post({type:'FIELDS', fields: [], frame:1, done:true}); }
        });
      })();
    } catch(e){ post({type:'AUTOFILL_ERROR', error:String((e&&e.message)||e)}); }
  }
  function doFill(bySig){
    post({type:'FRAME_FILLING', frame:1});
    runFill(bySig, 1);
  }
  function doAttach(keys,b64,filename,mime,kind){
    try{ var ok=0,total=0; (keys||[]).forEach(function(k){ var el=deepQuery('[data-cvf="'+k+'"]')[0]; if(!el||(el.type||'').toLowerCase()!=='file') return; total++; try{ var dt=new DataTransfer(); dt.items.add(b64ToFile(b64,filename,mime)); el.files=dt.files; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); if(el.files&&el.files.length>0) ok++; }catch(e){} });
      if(total>0) post({type:'ATTACHED', kind:kind, ok:ok, total:total, frame:1});
    }catch(e){}
  }
  window.addEventListener('message', function(ev){
    var d=ev&&ev.data; if(!d||typeof d!=='object'||!d.__cvfCmd) return;
    if(window.top===window.self) return;   // main frame uses its own direct path; only CHILD frames act on relays
    try {
      if(d.__cvfCmd==='scan') doScan();
      else if(d.__cvfCmd==='fill') doFill(d.values||{});
      else if(d.__cvfCmd==='attach') doAttach(d.keys, d.b64, d.filename, d.mime, d.kind);
      else if(d.__cvfCmd==='wizardProbe') wReport(1);
      // Most enterprise ATS host their form in a cross-origin iframe, so the step watcher has to be
      // armed INSIDE the frame — arming only the main frame meant the auto-fill-next-step promise
      // could never be kept on exactly the portals it was built for.
      else if(d.__cvfCmd==='armStepWatch'){ try{ window.__cvfArmStepWatch && window.__cvfArmStepWatch(); }catch(e){} }
    } catch(e){}
  }, false);
})(); true;`;

// Relay a command from the main frame to every child (iframe) frame. Runs in the MAIN frame.
const relayToChildrenJs = (cmd: Record<string, any>) =>
  `(function(){var m=${JSON.stringify(cmd)};try{for(var i=0;i<window.frames.length;i++){try{window.frames[i].postMessage(m,'*');}catch(e){}}}catch(e){}})(); true;`;

// Translate the apply page to English IN PLACE using Google's free website-translator widget
// (no API key, no backend, NO our-AI). It rewrites the visible text on the page's OWN domain,
// so the form, our autofill and smart-copy all keep working. The Google banner is hidden via CSS.
const TRANSLATE_TO_EN_JS = `(function(){
  try {
    var h=location.hostname, root=h.split('.').slice(-2).join('.');
    ['', ';domain='+h, ';domain=.'+root].forEach(function(suf){ document.cookie='googtrans=/auto/en;path=/'+suf; });
    if(!document.getElementById('__cvfGtCss')){
      var st=document.createElement('style'); st.id='__cvfGtCss';
      st.textContent='.goog-te-banner-frame,.skiptranslate{display:none!important;visibility:hidden!important;height:0!important;}body{top:0!important;position:static!important;}#goog-gt-tt,.goog-te-balloon-frame,.VIpgJd-ZVi9od-aZ2wEe-wOHMyf{display:none!important;}';
      document.head.appendChild(st);
    }
    // Watchdog: Google adds a "translated-ltr/rtl" class to <html> when it actually translates.
    // If that never appears (the site's CSP blocks Google's translation engine, e.g. ilionx), post
    // XLATE_WIDGET_DEAD so RN falls back to our backend "bridge" translator. One watchdog at a time.
    try{ if(window.__cvfWdIv) clearInterval(window.__cvfWdIv); }catch(e){}
    (function(){ var tries=0;
      window.__cvfWdIv=setInterval(function(){ tries++;
        var ok=/(^|\\s)translated-(ltr|rtl)(\\s|$)/.test(document.documentElement.className||'') || document.documentElement.getAttribute('data-cvf-xlated')==='1';
        if(ok){ clearInterval(window.__cvfWdIv); window.__cvfWdIv=0; return; }
        if(tries>=16){ clearInterval(window.__cvfWdIv); window.__cvfWdIv=0;
          try{ var o={type:'XLATE_WIDGET_DEAD'}; o.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){}
        }
      },300);
    })();
    if(window.__cvfGtLoaded){
      // already injected on THIS page — just re-trigger the translation (no reload, no flicker)
      var c0=document.querySelector('select.goog-te-combo');
      if(c0){ c0.value='en'; c0.dispatchEvent(new Event('change')); }
      return;
    }
    window.__cvfGtLoaded=true;
    window.googleTranslateElementInit=function(){
      try { new google.translate.TranslateElement({pageLanguage:'auto', autoDisplay:false}, '__cvfGte'); } catch(e){}
      var n=0, iv=setInterval(function(){
        var c=document.querySelector('select.goog-te-combo');
        if(c){ c.value='en'; c.dispatchEvent(new Event('change')); clearInterval(iv); }
        if(++n>24) clearInterval(iv);
      }, 250);
    };
    var box=document.createElement('div'); box.id='__cvfGte'; box.style.cssText='position:absolute;left:-9999px;top:-9999px'; document.body.appendChild(box);
    var sc=document.createElement('script'); sc.src='https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
    sc.onerror=function(){ try{ var o={type:'TRANSLATE_FAIL'}; o.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} };
    document.head.appendChild(sc);
  } catch(e){}
})(); true;`;

const TRANSLATE_OFF_JS = `(function(){
  try {
    var h=location.hostname, root=h.split('.').slice(-2).join('.');
    ['', ';domain='+h, ';domain=.'+root].forEach(function(suf){ document.cookie='googtrans=;path=/'+suf+';expires=Thu, 01 Jan 1970 00:00:00 GMT'; });
    window.__cvfGtLoaded=false;
    location.reload();
  } catch(e){}
})(); true;`;

// ── Bridge translator (CSP-proof) ──────────────────────────────────────────────
// When Google's in-page widget is blocked by a site's CSP, we translate via OUR backend instead:
// collect the page's visible text nodes, hand them to RN over the message bridge (NOT a network
// request, so the page's CSP can't block it), translate server-side, then write the English text
// back into the SAME text nodes (also not a network request). Form fields/inputs are left untouched.
const COLLECT_NODES_JS = `(function(){
  function post(o){ try{ o.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  try{
    if(window.__cvfTx && window.__cvfTx.length){ post({type:'XLATE_COLLECT',items:[],n:0,again:true}); return; }
    var SKIP={SCRIPT:1,STYLE:1,NOSCRIPT:1,TEXTAREA:1,CODE:1,PRE:1,IFRAME:1,svg:1,SVG:1};
    var nodes=[], items=[], idx=0;
    var w=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode:function(n){
        try{
          var p=n.parentNode; if(!p||SKIP[p.nodeName]) return NodeFilter.FILTER_REJECT;
          if(p.closest && p.closest('input,textarea,[contenteditable="true"],[translate="no"],.notranslate')) return NodeFilter.FILTER_REJECT;
          var s=(n.nodeValue||'').replace(/\\s+/g,' ').trim();
          if(s.length<2) return NodeFilter.FILTER_REJECT;
          if(!/[A-Za-z\\u00C0-\\u024F\\u0400-\\u04FF\\u0370-\\u03FF]/.test(s)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }catch(e){ return NodeFilter.FILTER_REJECT; }
      }
    });
    var n; while((n=w.nextNode())){ nodes.push(n); items.push({i:String(idx),t:(n.nodeValue||'').replace(/\\s+/g,' ').trim()}); idx++; if(idx>=600) break; }
    window.__cvfTx=nodes;
    post({type:'XLATE_COLLECT', items:items, n:items.length});
  }catch(e){ post({type:'XLATE_COLLECT', items:[], n:0}); }
})(); true;`;

// Build the injection that writes translations back into the collected nodes (preserving each
// node's original leading/trailing whitespace so inline words don't run together).
const buildApplyNodesJS = (map: Record<string, string>) =>
  `(function(){try{var M=${JSON.stringify(map)};var A=window.__cvfTx||[];for(var k in M){var n=A[+k];if(n&&n.nodeValue!=null){var o=n.nodeValue;var L=(o.match(/^\\s*/)||[''])[0];var T=(o.match(/\\s*$/)||[''])[0];n.nodeValue=L+M[k]+T;}}document.documentElement.setAttribute('data-cvf-xlated','1');}catch(e){}})(); true;`;

// Detect whether the loaded page is NOT in English so we can auto-translate it. Uses the
// <html lang> attribute first, then a non-ASCII-script ratio (Chinese/Cyrillic/Arabic/…), then
// common non-English function words (German/Dutch/French/Spanish/Italian/Portuguese/…). Posts
// PAGE_LANG so RN can decide. Runs after a short delay so SPA content has rendered.
const AUTODETECT_JS = `(function(){
  if (window.top !== window.self) return;   // language auto-detect only on the top page, not iframes
  function post(o){ try{o.__cvf=true;window.ReactNativeWebView.postMessage(JSON.stringify(o));}catch(e){} }
  function detect(){
    try{
      var lang=(document.documentElement.getAttribute('lang')||'').toLowerCase().trim();
      if(!lang){ var ml=document.querySelector('meta[http-equiv="content-language"],meta[name="language"]'); if(ml) lang=(ml.getAttribute('content')||'').toLowerCase().trim(); }
      var nonEn=false;
      if(lang && /^[a-z]{2}/.test(lang)) nonEn = !/^en($|[-_])/.test(lang);
      var t=((document.body&&document.body.innerText)||'').slice(0,4000);
      if(!nonEn && t){
        var nonAscii=(t.match(/[^\\x00-\\x7F]/g)||[]).length;
        if(nonAscii>15 && nonAscii/Math.max(t.length,1)>0.10) nonEn=true;
        if(!nonEn){
          var lower=' '+t.toLowerCase().replace(/[^a-zà-ÿ\\s]/g,' ').replace(/\\s+/g,' ')+' ';
          var sw=['und','oder','nicht','für','wir','auch','een','het','voor','niet','met','les','des','vous','nous','pour','avec','dans','para','con','los','las','que','não','você','com','che','sono','della','att','och','det','som','aux','être'];
          var hits=0; for(var i=0;i<sw.length;i++){ if(lower.indexOf(' '+sw[i]+' ')>=0) hits++; }
          if(hits>=4) nonEn=true;
        }
      }
      post({type:'PAGE_LANG', lang:lang||'', nonEnglish:nonEn});
    }catch(e){}
  }
  setTimeout(detect, 700);
})(); true;`;

// 1b) Detect a SUCCESSFUL application submission inside the apply WebView (multilingual,
//     language-agnostic — see submitDetect.ts). SUBMIT_DETECT_JS posts SUBMIT_INTENT on a
//     real apply-form submit and SUBMIT_SUCCESS when a confirmation is detected.

// 2) Fill by scrolling through the form and filling each field by signature AS it renders
//    (handles lazy-loaded + virtualized fields). Reports real filled/total counts.
function fillJs(values: Record<string, any>): string {
  return `(function(){
    ${JS_HELPERS}
    runFill(${JSON.stringify(values)}, 0);
  })(); true;`;
}

// 3) Attach a base64 file to tagged file inputs. VERIFIES el.files after assignment
//    (so iOS/custom uploaders that silently no-op are reported as failed, not success).
function attachJs(keys: string[], base64: string, filename: string, mime: string, kind: string): string {
  return `(function(){
    function post(o){ try{ o.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
    // Local shadow-aware lookup — this script is injected standalone (no JS_HELPERS), and a file
    // input living inside a web component is invisible to a plain document.querySelector.
    function deepQuery(sel, root){
      var out=[], budget=0;
      function walk(r){
        if(budget>12000) return;
        try{
          var els=r.querySelectorAll(sel);
          for(var i=0;i<els.length;i++) out.push(els[i]);
          var all=r.querySelectorAll('*'); budget+=all.length;
          for(var j=0;j<all.length;j++){ if(all[j].shadowRoot) walk(all[j].shadowRoot); }
        }catch(e){}
      }
      walk(root||document);
      return out;
    }
    try {
      var keys = ${JSON.stringify(keys)};
      var b64 = ${JSON.stringify(base64)};
      var filename = ${JSON.stringify(filename)};
      var mime = ${JSON.stringify(mime || 'application/pdf')};
      var kind = ${JSON.stringify(kind)};
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
      var ok = 0, total = 0;
      keys.forEach(function(k){
        // Manual "Upload" from the dock has no tapped field → target the first real file input.
        var el = deepQuery('[data-cvf="'+k+'"]')[0];
        if ((!el || (el.type||'').toLowerCase()!=='file') && k === '__manual__') el = deepQuery('input[type=file]')[0];
        if (!el || (el.type||'').toLowerCase()!=='file') return;
        total++;
        try {
          var file = new File([bytes], filename, {type: mime});
          var dt = new DataTransfer();
          dt.items.add(file);
          el.files = dt.files;
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
          // VERIFY: the assignment actually took (WKWebView often blocks it).
          if (el.files && el.files.length > 0 && el.files[0].size === bytes.length) ok++;
        } catch(e){}
      });
      post({type:'ATTACHED', kind:kind, ok:ok, total:total});
    } catch(e){ post({type:'ATTACHED', kind:kind, ok:0, total:(keys?keys.length:0), error:String((e && e.message) || e)}); }
  })(); true;`;
}

// Stages shown in the processing popup (in order). Files are attached via tap-to-attach,
// not here (the auto-attach was unreliable on real ATS), so only the fill stages show.
// 4) SKILLS — the one thing auto-fill could never do. Skill pickers are almost never form fields:
// they're clickable "+ Agile" chips plus a search box with an autocomplete list — elements the
// input/textarea/select engine literally cannot see, so skills were unfillable on ANY site. This
// stage clicks chips that exactly match the user's résumé skills, then types the leftovers into the
// search box and picks from its dropdown.
//
// SAFETY — this is the only code in the app that clicks arbitrary page elements:
//  • a capturing 'submit' handler is installed for the whole run, so an accidental form submit is
//    structurally impossible while it's active;
//  • links with a real href, submit buttons, and a denylist of destructive words are rejected;
//  • matching is EXACT after normalisation — never substring (that's how you'd click "Java" for a
//    JavaScript dev);
//  • the container can never be <body>, nav, header or footer;
//  • the loop aborts on any URL change, container detachment, or beforeunload;
//  • hard caps: 10 chip clicks, 8 typed skills, 8s wall clock;
//  • Enter is NEVER pressed — implicit submission would also trip SUBMIT_DETECT_JS and falsely mark
//    the job Applied.
function skillsJs(skills: string[]): string {
  return `(function(){
    ${JS_HELPERS}
    var SKILLS = ${JSON.stringify((skills || []).slice(0, 25))};
    var t0 = Date.now(), added = 0, attempted = 0, aborted = false;
    function blockSubmit(e){ try{ e.preventDefault(); e.stopPropagation(); }catch(_){} aborted = true; }
    function done(){ try{ document.removeEventListener('submit', blockSubmit, true); }catch(e){} post({type:'SKILLS_ADDED', added:added, attempted:attempted, aborted:aborted}); }
    if (!SKILLS.length) { post({type:'SKILLS_ADDED', added:0, attempted:0, aborted:false, none:true}); return; }
    document.addEventListener('submit', blockSubmit, true);
    window.addEventListener('beforeunload', function(){ aborted = true; }, true);

    function norm(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9+#]+/g,''); }
    var ALIAS = { js:'javascript', ts:'typescript', reactjs:'react', nodejs:'node', msproject:'microsoftproject' };
    var want = {};
    for (var i=0;i<SKILLS.length;i++){ var n=norm(SKILLS[i]); if(n){ want[n]=SKILLS[i]; if(ALIAS[n]) want[norm(ALIAS[n])]=SKILLS[i]; } }

    var DENY = /^(submit|save|next|continue|proceed|back|previous|cancel|delete|remove|clear|reset|close|logout|log ?out|sign ?out|apply|send|upload|browse|pay|buy|subscribe|confirm|agree|accept|skip|edit|yes|no|ok|done|finish)$/i;
    function chipText(el){ return String(el.innerText||el.textContent||'').replace(/\\s+/g,' ').replace(/^[+\\u002B\\u2022\\s]+/,'').replace(/[\\u00D7\\u2715]\\s*$/,'').trim(); }
    function safeChip(el){
      try{
        if(!el || !vis(el)) return false;
        if(el.querySelectorAll && el.querySelectorAll('*').length > 2) return false;
        var txt = chipText(el);
        if(!txt || txt.length>40 || txt.split(' ').length>5) return false;
        if(DENY.test(txt)) return false;
        if((el.type||'').toLowerCase()==='submit') return false;
        if(el.getAttribute && el.getAttribute('form')) return false;
        if(el.closest && el.closest('button[type=submit]')) return false;
        var a = el.closest ? el.closest('a') : null;
        if(a){ var h=a.getAttribute('href')||''; if(h && h!=='#' && h.indexOf('javascript:')!==0) return false; }
        var al = (el.getAttribute && (el.getAttribute('aria-label')||el.getAttribute('title'))) || '';
        if(/delete|remove|close|clear/i.test(al)) return false;
        var cls = String(el.className||'');
        if(/selected|active|chosen|is-on/i.test(cls)) return false;
        if(el.getAttribute && el.getAttribute('aria-pressed')==='true') return false;
        var role = (el.getAttribute && el.getAttribute('role')) || '';
        var cursor=''; try{ cursor = getComputedStyle(el).cursor; }catch(_){}
        return (el.tagName==='BUTTON' || role==='button' || role==='option' || cursor==='pointer' || /chip|tag|pill|token|skill|suggest|badge/i.test(cls));
      }catch(e){ return false; }
    }
    function findInput(){
      var els=deepQuery('input,textarea');
      for(var i=0;i<els.length;i++){ var el=els[i]; var t=(el.type||'').toLowerCase();
        if(['hidden','submit','button','reset','image','file','checkbox','radio'].indexOf(t)>=0) continue;
        if(!vis(el)) continue;
        var hay=((nlbl(el)||'')+' '+(el.placeholder||'')+' '+(el.name||'')+' '+(el.id||'')).toLowerCase();
        if(/skill|expertise|competenc|technolog|proficien|tag/.test(hay)) return el;
      }
      return null;
    }
    function findContainer(anchor){
      var p = anchor ? anchor.parentElement : null, h = 0;
      while(p && h<6){
        if(p===document.body) break;
        if(!(p.closest && p.closest('nav,header,footer,[role=navigation]'))){
          var kids = p.querySelectorAll ? p.querySelectorAll('button,[role=button],[role=option],span,li,div,a') : [];
          var n=0; for(var i=0;i<kids.length && n<3;i++){ if(safeChip(kids[i])) n++; }
          if(n>=3 && String(p.innerText||'').length < 1500) return p;
        }
        p=p.parentElement; h++;
      }
      var all=document.querySelectorAll('div,section,ul');
      for(var j=0;j<all.length && j<3000;j++){
        var e=all[j];
        if(e===document.body) continue;
        var tx=String(e.innerText||'');
        if(tx.length>1500) continue;
        if(!/suggested skills|selected skills|add (your )?skills|areas? of expertise/i.test(tx)) continue;
        if(e.closest && e.closest('nav,header,footer,[role=navigation]')) continue;
        return e;
      }
      return null;
    }
    function clickChips(container, cb){
      if(!container){ cb(); return; }
      var cands=container.querySelectorAll('button,[role=button],[role=option],span,li,div,a');
      var picks=[], seen={};
      for(var i=0;i<cands.length;i++){
        var el=cands[i]; if(!safeChip(el)) continue;
        var n=norm(chipText(el));
        if(!n || !want[n] || seen[n]) continue;
        seen[n]=true; picks.push({el:el,n:n});
        if(picks.length>=10) break;
      }
      var idx=0;
      function step(){
        if(aborted || idx>=picks.length || Date.now()-t0>8000){ cb(); return; }
        var it=picks[idx++], beforeUrl=location.href;
        attempted++;
        try{
          it.el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
          it.el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
          if(it.el.click) it.el.click(); else it.el.dispatchEvent(new MouseEvent('click',{bubbles:true}));
        }catch(e){}
        setTimeout(function(){
          if(location.href!==beforeUrl || !document.contains(container)){ aborted=true; cb(); return; }
          var ok=false;
          try{ ok = !document.contains(it.el) || /selected|active|chosen/i.test(String(it.el.className||'')) || it.el.getAttribute('aria-pressed')==='true'; }catch(e){}
          if(ok){ added++; delete want[it.n]; }
          step();
        },200);
      }
      step();
    }
    function typeRest(input, cb){
      if(!input){ cb(); return; }
      var left=[]; for(var k in want){ if(Object.prototype.hasOwnProperty.call(want,k)) left.push(want[k]); }
      left=left.slice(0,8);
      var i=0;
      function step(){
        if(aborted || i>=left.length || Date.now()-t0>8000){ cb(); return; }
        var sk=left[i++];
        attempted++;
        try{ input.focus(); }catch(e){}
        setNative(input, sk);
        setTimeout(function(){
          var opt=null;
          try{
            var os=document.querySelectorAll('[role=listbox] [role=option],[role=option],ul.dropdown-menu li,.ui-select-choices-row,.autocomplete-item,[class*=suggestion] li,[class*=autocomplete] li');
            for(var j=0;j<os.length;j++){ if(!vis(os[j])) continue; if(norm(chipText(os[j]))===norm(sk)){ opt=os[j]; break; } }
          }catch(e){}
          if(opt){
            try{
              opt.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
              opt.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
              if(opt.click) opt.click(); else opt.dispatchEvent(new MouseEvent('click',{bubbles:true}));
              added++;
            }catch(e){}
            setTimeout(step,600);
          } else {
            setNative(input,'');   // clear the residue — never press Enter (implicit submit)
            setTimeout(step,300);
          }
        },700);
      }
      step();
    }
    var input=findInput();
    clickChips(findContainer(input), function(){ typeRest(input, done); });
  })(); true;`;
}

const AUTOFILL_STEPS: { key: string; label: string; wizardOnly?: boolean }[] = [
  { key: 'reading', label: 'Scanning the whole form' },
  { key: 'mapping', label: 'Matching with your profile (AI)' },
  { key: 'filling', label: 'Filling in your details' },
  { key: 'skills',  label: 'Adding your skills' },
  { key: 'wizard',  label: 'Checking for more steps', wizardOnly: true },
];

// Cover-letter HTML → readable plain text (for pasting into a textarea).
function clPlainText(html?: string | null): string {
  if (!html) return '';
  return String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n')
    .trim();
}

// Is this form field a free-text COVER LETTER box (so we paste the letter text, not a file)?
// Parse a mailto: URL → { to, cc, bcc, subject, body }. Manual parse (RN's URLSearchParams polyfill
// is unreliable). Handles "mailto:a@x.com?cc=…&subject=…&body=…".
function parseMailto(raw: string): { to: string; cc: string; bcc: string; subject: string; body: string } {
  const out = { to: '', cc: '', bcc: '', subject: '', body: '' };
  try {
    const s = String(raw).replace(/^mailto:/i, '');
    const q = s.indexOf('?');
    const path = q >= 0 ? s.slice(0, q) : s;
    if (path) { try { out.to = decodeURIComponent(path).trim(); } catch { out.to = path.trim(); } }
    if (q >= 0) s.slice(q + 1).split('&').forEach((pair) => {
      const eq = pair.indexOf('='); if (eq < 0) return;
      const k = pair.slice(0, eq).toLowerCase();
      let v = pair.slice(eq + 1).replace(/\+/g, ' '); try { v = decodeURIComponent(v); } catch {}
      if (k === 'to') out.to = out.to ? `${out.to}, ${v.trim()}` : v.trim();
      else if (k === 'cc') out.cc = v.trim();
      else if (k === 'bcc') out.bcc = v.trim();
      else if (k === 'subject') out.subject = v.trim();
      else if (k === 'body') out.body = v;
    });
  } catch {}
  return out;
}

function isCoverLetterTextarea(f: any): boolean {
  if (!f) return false;
  const tag = String(f.tag || '').toLowerCase();
  const type = String(f.type || '').toLowerCase();
  if (tag !== 'textarea' && !(tag === 'input' && (type === 'text' || type === ''))) return false;
  const hay = `${f.label || ''} ${f.name || ''} ${f.placeholder || ''}`.toLowerCase();
  return /cover\s*letter|covering\s*letter|cover\s*note|motivation|why (do|are|would) you|why (this|the) (role|job|position|company)|tell us (about yourself|why)|introduce yourself/.test(hay);
}

export default function JobDetailScreen() {
  const router = useRouter();
  const { jobId, jobStr, employerStr, autoApply, applyNowUrl } = useLocalSearchParams<{ jobId?: string; jobStr?: string; employerStr?: string; autoApply?: string; applyNowUrl?: string }>();

  const [skillsExpanded, setSkillsExpanded] = useState(false);

  // Cover letter states — mirrors HomeScreen GenerateButton + DownloadButton
  const [clState,    setClState]    = useState<'idle'|'loading'|'done'>('idle');
  const [clProgress, setClProgress] = useState(0);
  const [clLabel,    setClLabel]    = useState('Generating cover letter…');
  const clAnim = useRef(new Animated.Value(0)).current;
  const [coverLetterHtml,  setCoverLetterHtml]  = useState<string | null>(null);
  const [companyNameCL,    setCompanyNameCL]    = useState('');
  const [websiteUrlCL,     setWebsiteUrlCL]     = useState('');
  const [companyAddressCL, setCompanyAddressCL] = useState('');
  type CLLocation = { address: string; city: string; country: string; isHeadquarters: boolean; matchesJobLocation?: boolean };
  const [companyLocations, setCompanyLocations] = useState<CLLocation[]>([]);
  const [showOfficePicker, setShowOfficePicker] = useState(false);

  // Download states
  const [dlState,    setDlState]    = useState<'idle'|'loading'|'done'>('idle');
  const [dlProgress, setDlProgress] = useState(0);
  const dlAnim = useRef(new Animated.Value(0)).current;

  // ── Email compose modal ──
  const [composeVisible, setComposeVisible] = useState(false);
  const [ccExpanded,     setCcExpanded]     = useState(false);
  const [composeTo,      setComposeTo]      = useState('');
  const [composeCc,      setComposeCc]      = useState('');
  const [composeBcc,     setComposeBcc]     = useState('');
  const [composeSubject, setComposeSubject] = useState('');
  const [composeBody,    setComposeBody]    = useState('');
  const [sendState,      setSendState]      = useState<'idle'|'loading'|'done'>('idle');
  const [mailPrep,       setMailPrep]       = useState<'idle'|'loading'>('idle');   // Apply-via-Mail prep progress
  // Email attachments (auto-attached, removable). Region comes from effResumeRegion/effClRegion.
  const [mailResumeOn,   setMailResumeOn]   = useState(true);
  const [mailCoverOn,    setMailCoverOn]    = useState(true);
  const [mailEditResume, setMailEditResume] = useState(false);   // inline region picker expanded
  const [mailEditCover,  setMailEditCover]  = useState(false);

  // ── In-app apply web view (slide-up) ──
  const [applyWebUrl,    setApplyWebUrl]    = useState<string | null>(null);
  const [applyLoading,   setApplyLoading]   = useState(false);
  const [applyProgress,  setApplyProgress]  = useState(0);
  const [applyCanGoBack, setApplyCanGoBack] = useState(false);
  const [applyHost,      setApplyHost]      = useState('');
  const [appliedBanner,  setAppliedBanner]  = useState(false);   // green "submitted ✓" toast inside the web view
  // "Fetch job" dock action: capture whatever page the user is viewing into Saved Jobs, so the apply
  // browser both applies AND fetches (no separate Browse & Fetch screen, no reload).
  const [fetchState,     setFetchState]     = useState<'idle' | 'fetching' | 'saved'>('idle');
  const fetchWantRef = useRef(false);        // a Fetch is in flight and awaiting its FETCH_PAGE grab
  const fetchTimerRef = useRef<any>(null);   // watchdog so a page that never answers doesn't hang the bubble
  const [webTranslated,  setWebTranslated]  = useState(false);   // page translated to English (Google in-page widget)
  const [webTranslating, setWebTranslating] = useState(false);
  const webTranslatedRef = useRef(false);                        // mirror for the load callback (no stale closure)
  const autoXlateRef     = useRef(true);                         // auto-translate non-English pages until the user opts out
  const bridgeXlateRef   = useRef(false);                        // a backend "bridge" translation is in-flight/done for this page
  // Translation is DESIRED-STATE driven: xlateOnRef is what the user wants, and every page load /
  // SPA render re-applies it. A tap while the page is still loading is remembered, not dropped.
  const xlateOnRef      = useRef(false);
  const xlateGenRef     = useRef(0);      // discard replies from a superseded pass
  const xlateBusyRef    = useRef(false);  // a pass is mid-flight — ignore the DOM churn it causes
  const xlatePendingRef = useRef(false);  // tapped mid-load → run once the load finishes
  const webLoadingRef   = useRef(false);
  const submitMarkedRef = useRef(false);                          // fire the "Applied" mark only once per session
  const submitIntentRef = useRef(0);                              // ts of last real apply-form submit (for the URL backstop)
  useEffect(() => {                                                // auto-dismiss the "submitted ✓" toast
    if (!appliedBanner) return;
    const t = setTimeout(() => setAppliedBanner(false), 6000);
    return () => clearTimeout(t);
  }, [appliedBanner]);

  // ── Job capture (live/web jobs) ──────────────────────────────────────────────
  // A live/web job arrives with a synthetic id and (often) no responsibilities — the real details
  // live only on the page shown in the apply WebView. We capture that page's text, get a canonical
  // DB UUID + AI-extracted details, and (on Generate-CL / submit) add it to My Jobs. capturedRef is
  // the source of truth (survives re-renders); state mirrors it for the UI / cover-letter inputs.
  const [capturedJobId, setCapturedJobId] = useState<string | null>(null);
  const [capturedJob,   setCapturedJob]   = useState<CapturedJob | null>(null);
  const capturedRef  = useRef<{ id: string | null; job: CapturedJob | null; tracked: boolean; promise: Promise<any> | null }>({ id: null, job: null, tracked: false, promise: null });
  const capturedIdRef = useRef<string | null>(null);          // canonical id readable from early callbacks
  const lastPageTextRef = useRef<string>('');                 // latest apply-page innerText (for on-demand capture)
  const capturePrefetchedRef = useRef(false);                 // grab the page text once per apply session
  const ensureTrackedRef = useRef<((pt?: string) => Promise<{ id: string; job: CapturedJob | null }>) | null>(null);

  // Mark the job "Applied" once — against the CANONICAL job (create + track it first if it was a
  // live/web job) so the dashboard shows it as Applied even without a generated cover letter.
  const markApplied = useCallback(() => {
    if (submitMarkedRef.current) return;
    submitMarkedRef.current = true;
    setAppliedBanner(true);
    (async () => {
      try {
        const cap = ensureTrackedRef.current
          ? await ensureTrackedRef.current(lastPageTextRef.current || undefined)
          : { id: capturedIdRef.current || '' };
        if (cap.id) await updateJobCLStatus(cap.id, 'applied');
      } catch {}
    })();
  }, []);
  const applyWebRef = useRef<WebView>(null);
  const applyOriginRef = useRef<string>('');   // origin of the apply page — injections are gated to it
  const currentUrlRef  = useRef<string>('');   // live page URL (from onNavigationStateChange)
  // ── LinkedIn → company-portal capture ──
  // LinkedIn hides a job's external apply URL from guests, but when the user taps Apply ON the
  // LinkedIn page, the browser lands on the company's own portal. Capture that landing URL and save
  // it as this job's per-user link — from then on, Apply/Portal opens the company page DIRECTLY.
  const sawLinkedInRef    = useRef(false);   // this apply session visited a linkedin.com page
  const portalCapturedRef = useRef(false);   // capture at most once per session
  const [portalSavedBanner, setPortalSavedBanner] = useState(false);
  useEffect(() => {                                                // auto-dismiss the "link saved" toast
    if (!portalSavedBanner) return;
    const t = setTimeout(() => setPortalSavedBanner(false), 4000);
    return () => clearTimeout(t);
  }, [portalSavedBanner]);
  // Hosts that are never "the company portal": LinkedIn itself + auth/OAuth + search engines.
  // NOTE: this used to match only auth HOSTS (login. / accounts.), so an auth PATH such as
  // career-schwab.icims.com/jobs/123720/<slug>/login sailed through and got saved as the job's
  // apply URL — sending every later open to a captcha wall. isAuthUrl() covers paths too.
  const NOT_PORTAL_RE = /linkedin\.com|licdn\.com|lnkd\.in|google\.[a-z.]+|bing\.com|accounts\.|login\.|signin\.|auth[0-9]?\.|appleid\.apple|facebook\.com|about:blank/i;
  // Every pattern above needs a trailing dot, so it only ever matched auth HOSTS. An OAuth CALLBACK
  // on the employer's own domain (…/oauth/callback?code=…) matched nothing and was persisted as the
  // job's permanent apply URL — a single-use, already-spent link, saved server-side. These two cover
  // the token-bearing and auth-path shapes that must never be captured.
  const AUTH_TOKEN_RE = /[?&](code|state|id_token|access_token|token|ticket|SAMLResponse|session_state)=/i;
  const AUTH_PATH_RE  = /\/(oauth2?|auth|callback|signin-|sso|saml|openid|login|session)(\/|$|\?)/i;
  const insets = useSafeAreaInsets();          // notch/home-indicator insets (Modal-safe)
  const rating = useRatingPrompt();            // post-apply rating prompt (portal close + email send)

  // ── AI auto-fill state ──
  const [autofillState, setAutofillState] = useState<string | null>(null); // null|running|done|error
  const [autofillNote,  setAutofillNote]  = useState('');
  const [afStep,        setAfStep]        = useState<Record<string, string>>({}); // stepKey -> pending|active|done|warn
  const autofillRef = useRef<{ active: boolean; gen: number; resumeKeys: string[]; clKeys: string[]; radioKeys: string[]; files: any }>({ active: false, gen: 0, resumeKeys: [], clKeys: [], radioKeys: [], files: null });
  // Cross-frame field merge: the main frame AND any iframe(s) each post FIELDS; accumulate + debounce
  // so an empty main frame (form lives in a Greenhouse-style iframe) doesn't fire "no fields found".
  const fieldsAccumRef = useRef<any[]>([]);
  const processedGenRef = useRef<number>(-1);   // gen whose AI mapping already started (dedupe late scans)
  const fieldsTimerRef = useRef<any>(null);
  const attachTimerRef = useRef<any>(null);
  const filledAccumRef = useRef<{ count: number }>({ count: 0 });
  const filledTimerRef = useRef<any>(null);
  const filledCountRef = useRef<number>(0);      // fields filled, carried into the skills stage's message
  const skillsTimerRef = useRef<any>(null);      // don't hang the overlay if the page has no skills widget
  const scanTimerRef   = useRef<any>(null);      // watchdog: the form scan must not spin forever
  const skillsCountRef = useRef<number>(0);      // carried into the wizard-aware final message
  // Frames that ANNOUNCED they are working and therefore owe us an answer. window.frames.length is
  // not usable: FRAME_GUARD_JS marks captcha iframes __cvfSkipFrame so they never install the agent
  // and never reply — counting them burns the whole cap on every page that has one.
  const pendingScanFramesRef = useRef<number>(0);
  const pendingFillFramesRef = useRef<number>(0);
  const fieldsCapRef   = useRef<any>(null);      // ceiling so a silent frame can't hang the scan
  const fillCapRef     = useRef<any>(null);
  const runTimerRef    = useRef<any>(null);      // whole-run ceiling (a hung mapping used to spin forever)
  const failedAccumRef = useRef<any[]>([]);      // per-field failures merged across frames
  const fillFinalizedRef = useRef<number>(-1);   // gen whose fill stage already finalized
  const [autofillFailed, setAutofillFailed] = useState<any[]>([]);
  // Multi-step forms. Both the main frame and every iframe answer a probe, so we must not act on
  // whichever lands first — on an iframe-hosted ATS the main frame reports "not a wizard" while the
  // iframe holds the truth.
  const wizProbeRef = useRef<{ seq: number; reports: any[] }>({ seq: 0, reports: [] });
  const wizTimerRef = useRef<any>(null);
  const wizStepKeyRef = useRef<string>('');      // identity of the step we last filled
  const wizAutoRef = useRef<number>(0);          // steps auto-filled after the user pressed Next
  const lastRunEndedRef = useRef<number>(0);     // cooldown, so a settling DOM can't retrigger a run
  const [wizardUi, setWizardUi] = useState<{ i: number; n: number; name: string } | null>(null);
  // The auto-advance gate reads this from inside onWebMessage, where the state value would be stale.
  const wizardUiRef = useRef<{ i: number; n: number; name: string } | null>(null);
  // Sign-in flow: the page we must return the user to once auth finishes, plus guards so we restore
  // exactly once and never fight the provider's own redirect chain.
  const preAuthUrlRef   = useRef<string>('');
  const authOriginRef   = useRef<string>('');
  const authAtRef       = useRef<number>(0);
  const authRestoreTmr  = useRef<any>(null);
  const [authBanner, setAuthBanner] = useState(false);
  const setStep = (key: string, status: string) => setAfStep(prev => ({ ...prev, [key]: status }));

  // File-tap interception: offer our resume / cover letter when the user taps an upload field.
  const [filePick,     setFilePick]     = useState<{ key: string; accept: string; label: string } | null>(null);
  const [filePickBusy, setFilePickBusy] = useState<string | null>(null);
  const filesRef = useRef<Record<string, any>>({}); // 'kind:region' -> file ({base64,name,mime}) or null
  const [resumeRegion,   setResumeRegion]   = useState('');   // '' = use the job's default region
  const [clRegion,       setClRegion]       = useState('');
  const [resumeExpanded, setResumeExpanded] = useState(false);
  const [clExpanded,     setClExpanded]     = useState(false);
  // `image` = a rendered template preview. `fileUri` = the ACTUAL attachment shown in a WebView
  // (iOS renders PDFs natively), used when there is no Resume-Builder resume to render a template
  // from — previewing the real file beats refusing to preview anything.
  const [preview,        setPreview]        = useState<{ image?: string; fileUri?: string; mime?: string; note?: string; title: string; ratio: number } | null>(null);
  const [previewBusy,    setPreviewBusy]    = useState<string | null>(null);

  // ── Smart-copy control (in-WebView floating helper) ──
  const [smartOpen,     setSmartOpen]     = useState(false);
  const [smartData,     setSmartData]     = useState<SmartFillData | null>(null);
  const [smartExpanded, setSmartExpanded] = useState(false);   // "See more": show ALL details
  const [copiedKey,     setCopiedKey]     = useState<string | null>(null); // inline "Copied ✓"
  const focusedFieldRef = useRef<{ key: string; label: string; type: string } | null>(null);
  const smartValuesRef  = useRef<Record<string, string>>({});  // autofill-map field key -> value (for field-awareness)
  const copyTimerRef    = useRef<any>(null);
  const localFillRef    = useRef<{ fullName?: string; email?: string; phone?: string; location?: string }>({}); // local session + resume-builder facts

  // Take over a sign-in popup: remember where we were, then run the auth in this same view.
  const beginAuthFlow = (target: string, from?: string) => {
    if (!target || !applyWebRef.current) return;
    const back = (from && /^https?:/i.test(from) ? from : currentUrlRef.current) || '';
    // Don't overwrite the remembered form with an auth page if the provider chains through several.
    if (back && !isAuthUrl(back)) {
      preAuthUrlRef.current = back;
      try { authOriginRef.current = new URL(back).origin; } catch { authOriginRef.current = ''; }
    }
    authAtRef.current = Date.now();
    setAuthBanner(true);
    try { applyWebRef.current.injectJavaScript(`window.location.href = ${JSON.stringify(target)}; true;`); } catch {}
  };

  // Auth is done — put the user back on the form they were filling. The session cookie is set by
  // now, so the site renders them as signed in.
  const returnFromAuth = (delay = 0) => {
    const back = preAuthUrlRef.current;
    if (!back || !applyWebRef.current) return;
    if (authRestoreTmr.current) clearTimeout(authRestoreTmr.current);
    authRestoreTmr.current = setTimeout(() => {
      const url = preAuthUrlRef.current;
      preAuthUrlRef.current = ''; authOriginRef.current = ''; authAtRef.current = 0;
      setAuthBanner(false);
      try { applyWebRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(url)}; true;`); } catch {}
    }, delay);
  };

  const openApplyWebView = (url?: string) => {
    const u = (url || '').trim();
    if (!u) return;
    track('apply_open', { linkedin: isLinkedInJobUrl(u) });
    // LinkedIn ADD-ON (LinkedIn URLs only — every other site is untouched and keeps the in-app
    // WebView below). A raw WKWebView blocks Google sign-in (disallowed_useragent) and LinkedIn
    // deep-links into its native app, so open LinkedIn in the OS secure in-app browser instead —
    // SFSafariViewController on iOS / Chrome Custom Tabs on Android (expo-web-browser). It shares
    // the system browser session, so Google sign-in + passkeys work. Falls back to the system
    // browser if it can't present.
    if (isLinkedInJobUrl(u)) {
      WebBrowser.openBrowserAsync(u).catch(() => { Linking.openURL(u).catch(() => {}); });
      return;
    }
    setApplyCanGoBack(false);
    setApplyProgress(0);
    try { setApplyHost(new URL(u).hostname.replace(/^www\./, '')); } catch { setApplyHost(''); }
    try { applyOriginRef.current = new URL(u).origin; } catch { applyOriginRef.current = ''; }
    currentUrlRef.current = u;
    // Reset any stale auto-fill state so a previous run's overlay never shows on reopen.
    autofillRef.current = { active: false, gen: autofillRef.current.gen, resumeKeys: [], clKeys: [], radioKeys: [], files: null };
    setAutofillState(null);
    setAutofillNote('');
    setAfStep({});
    setFilePick(null);
    setFilePickBusy(null);
    filesRef.current = {};
    setResumeRegion(''); setClRegion(''); setResumeExpanded(false); setClExpanded(false); setPreview(null); setPreviewBusy(null);
    submitMarkedRef.current = false; submitIntentRef.current = 0; setAppliedBanner(false);
    sawLinkedInRef.current = false; portalCapturedRef.current = false; setPortalSavedBanner(false);
    capturePrefetchedRef.current = false; lastPageTextRef.current = '';   // re-grab the job page text for this session
    preAuthUrlRef.current = ''; authOriginRef.current = ''; authAtRef.current = 0; setAuthBanner(false);
    if (authRestoreTmr.current) { clearTimeout(authRestoreTmr.current); authRestoreTmr.current = null; }
    // Smart-copy: reset + prefetch the user's reusable details for the floating helper.
    setSmartOpen(false); setSmartExpanded(false); setCopiedKey(null);
    focusedFieldRef.current = null; smartValuesRef.current = {};
    setWebTranslated(false); setWebTranslating(false); webTranslatedRef.current = false; autoXlateRef.current = true;
    xlateOnRef.current = false; xlatePendingRef.current = false; xlateGenRef.current++; webLoadingRef.current = false;
    bridgeXlateRef.current = false;
    loadLocalFill();
    if (!smartData) { getSmartFillData().then(setSmartData).catch(() => {}); }
    setApplyWebUrl(u);
  };

  // Translate the apply page to English (or back) using Google's free in-page widget — no AI.
  // Run a translation pass. Safe to call repeatedly — each pass gets a fresh generation and the
  // page scan never short-circuits, so turning translate off and on again always works.
  const runXlate = (why = 'toggle') => {
    if (!applyWebRef.current || !xlateOnRef.current) return;
    if (webLoadingRef.current) { xlatePendingRef.current = true; setWebTranslating(true); return; }
    const gen = ++xlateGenRef.current;
    setWebTranslating(true);
    try { applyWebRef.current.injectJavaScript(xlateScanJS(gen)); }
    catch { setWebTranslating(false); }
  };

  const toggleTranslate = () => {
    if (!applyWebRef.current) return;
    const next = !xlateOnRef.current;
    xlateOnRef.current = next;
    webTranslatedRef.current = next;
    autoXlateRef.current = next;                 // opting out also stops auto-translate on this page
    setWebTranslated(next);
    if (next) {
      runXlate('toggle-on');
    } else {
      xlatePendingRef.current = false;
      xlateGenRef.current++;                     // invalidate any in-flight pass
      setWebTranslating(false);
      // Restore IN PLACE — the old path did location.reload(), which raced with a re-tap and threw
      // away anything the user had typed.
      try { applyWebRef.current.injectJavaScript(XLATE_RESTORE_JS); } catch {}
    }
  };

  // "Apply here" hand-off from the Browse & Fetch dock: auto-open the apply browser at the exact
  // page the user was viewing (they get the full AI auto-fill / upload / memory arsenal there).
  const autoApplyFiredRef = useRef(false);
  useEffect(() => {
    if (autoApply !== '1' || autoApplyFiredRef.current) return;
    const u = String(applyNowUrl || '').trim();
    if (!u) return;
    autoApplyFiredRef.current = true;
    const t = setTimeout(() => { try { openApplyWebView(u); } catch {} }, 150);   // open the apply view promptly (minimal job-detail flash)
    return () => clearTimeout(t);
  }, [autoApply, applyNowUrl]);

  // Pull the user's reusable facts from local storage (session name/email + resume-builder
  // phone/location) so the smart-copy popup is populated even if the server bundle is sparse.
  const loadLocalFill = async () => {
    const out: { fullName?: string; email?: string; phone?: string; location?: string } = {};
    try { const raw = await SecureStore.getItemAsync('userSession'); if (raw) { const sx = JSON.parse(raw); out.fullName = sx.fullName || sx.full_name || ''; out.email = sx.email || ''; } } catch {}
    try { const raw = await AsyncStorage.getItem('resumeBuilderFormData'); if (raw) { const b = JSON.parse(raw); out.fullName = out.fullName || b.name || ''; out.email = out.email || b.email || ''; out.phone = b.phone || ''; out.location = b.location || ''; } } catch {}
    localFillRef.current = out;
  };

  const sameOrigin = () => {
    try { return !!applyOriginRef.current && new URL(currentUrlRef.current).origin === applyOriginRef.current; } catch { return false; }
  };

  // ── Smart-copy helpers ──
  const copyValue = (key: string, text: string) => {
    const t = String(text || '').trim();
    if (!t) return;
    try { Clipboard.setString(t); } catch {}
    setCopiedKey(key);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedKey(null), 1500);
  };
  const openSmart = () => {
    if (!smartData) getSmartFillData().then(setSmartData).catch(() => {});
    // Drop the on-screen keyboard so the bottom-sheet popup isn't hidden behind it.
    try { applyWebRef.current?.injectJavaScript('try{if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();}catch(e){} true;'); } catch {}
    setSmartExpanded(false);
    setSmartOpen(true);
  };
  // The copyable rows shown in the popup — local facts (session + resume builder) merged
  // with the server bundle (address/nationality + resume summary + skills).
  const buildSmartItems = (): { key: string; label: string; value: string; multiline?: boolean }[] => {
    const items: { key: string; label: string; value: string; multiline?: boolean }[] = [];
    const cl = clPlainText(coverLetterHtml);
    if (cl) items.push({ key: 'coverLetter', label: 'Cover letter', value: cl, multiline: true });
    const lf = localFillRef.current || {};
    const byId: Record<string, string> = {};
    for (const f of (smartData?.fields || [])) byId[f.id] = f.value;
    const add = (key: string, label: string, value?: string) => { const v = String(value || '').trim(); if (v) items.push({ key, label, value: v }); };
    add('fullName', 'Full name', lf.fullName || byId.fullName);
    add('email', 'Email', lf.email || byId.email);
    add('phone', 'Phone', lf.phone || byId.phone);
    add('location', 'Location', lf.location || byId.location);
    add('address', 'Address', byId.address);
    add('nationality', 'Nationality', byId.nationality);
    if (smartData?.resumeSummary) items.push({ key: 'resumeSummary', label: 'Resume summary', value: smartData.resumeSummary, multiline: true });
    if (smartData?.skills?.length) items.push({ key: 'skills', label: 'Skills', value: smartData.skills.join(', ') });
    return items;
  };
  // Which row to lead with, based on the field the user last focused.
  const primarySmartKey = (): string | null => {
    const f = focusedFieldRef.current;
    if (!f) return null;
    if (f.key && smartValuesRef.current[f.key]) return '__field__';
    const L = (f.label || '').toLowerCase();
    if (/cover.?letter|motivat|why.*(you|us|company|role|join)|about.?yourself|tell us|introduce|message/.test(L)) return 'coverLetter';
    if (/e-?mail/.test(L)) return 'email';
    if (/phone|mobile|tel\b|contact number/.test(L)) return 'phone';
    if (/full.?name|your name|first.?name|last.?name|^name/.test(L)) return 'fullName';
    if (/location|city|address|town|postcode|zip|country/.test(L)) return 'location';
    if (/summary|about you|\bbio\b|profile/.test(L)) return 'resumeSummary';
    return null;
  };
  const renderSmartRow = (it: { key: string; label: string; value: string; multiline?: boolean }) => (
    <View key={it.key} style={s.smartRow}>
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={s.smartRowLabel}>{it.label}</Text>
        <Text style={s.smartRowValue} numberOfLines={it.multiline ? 4 : 1}>{it.value}</Text>
      </View>
      <TouchableOpacity
        style={[s.smartCopyBtn, copiedKey === it.key && s.smartCopyBtnDone]}
        onPress={() => copyValue(it.key, it.value)}
        activeOpacity={0.8}
      >
        <Ionicons name={copiedKey === it.key ? 'checkmark' : 'copy-outline'} size={13} color={copiedKey === it.key ? '#fff' : T.blue} />
        <Text style={[s.smartCopyTxt, copiedKey === it.key && { color: '#fff' }]}>{copiedKey === it.key ? 'Copied' : 'Copy'}</Text>
      </TouchableOpacity>
    </View>
  );

  // Load CL from DB — triggered after jobId is known (see useEffect below)

  let foundJob: Job | null = null;
  let foundEmployer: Employer | null = null;
  try {
    if (jobStr) foundJob = JSON.parse(jobStr);
    if (employerStr) foundEmployer = JSON.parse(employerStr);
  } catch {}
  if (!foundJob && jobId) {
    for (const emp of MOCK_EMPLOYERS) {
      const j = emp.jobs.find(j => j.id === jobId);
      if (j) { foundJob = j; foundEmployer = emp; break; }
    }
  }

  if (!foundJob || !foundEmployer) {
    return (
      <SafeAreaView style={[s.safeArea, { justifyContent: 'center', alignItems: 'center', gap: 12 }]}>
        <Ionicons name="briefcase-outline" size={48} color={T.textFaint} />
        <Text style={{ fontSize: 18, fontWeight: '700', color: T.ink }}>Job not found</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ backgroundColor: T.blue, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 24 }}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>Go Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const job = foundJob;
  const employer = foundEmployer;

  // ── Translate-to-English — lives in the detail (not on the card). Language is
  // detected client-side (zero search cost); the translation runs on-demand only
  // when the user taps. `display` swaps the SHOWN fields; `job` stays the original
  // for all logic (cover-letter / email generation).
  const [translatedJob, setTranslatedJob] = useState<TranslatedJob | null>(null);
  const [showEnglish, setShowEnglish] = useState(false);
  const [translatingJob, setTranslatingJob] = useState(false);
  // ── LinkedIn auto-route: when a job's apply link is a LinkedIn posting, the hidden on-device WebView
  // extractor (defeats the HTTP-999 wall) fills liJob, which layers onto the display + feeds the cover letter.
  const [liJob, setLiJob] = useState<LinkedInJob | null>(null);
  const [liUrl, setLiUrl] = useState('');
  const [liStage, setLiStage] = useState('');
  const liTriedRef = useRef('');
  // ── Full-record hydration: the dashboard LIST ships a slimmed job (responsibilities trimmed
  // to the 3 the card shows) for speed — fetch the complete record once and layer it in, so the
  // detail view + cover letters always see ALL responsibilities/skills.
  const [fullJob, setFullJob] = useState<Job | null>(null);
  // Carry the job identity: without it "which job did they open" was unanswerable in analytics —
  // every job-level question in the 2026-08-01 review died on this one missing property.
  useEffect(() => {
    track('screen_view', {
      screen: 'job_detail',
      jobId: (job as any)?.id ? String((job as any).id).slice(0, 60) : undefined,
      jobUrl: (job as any)?.applyUrl ? String((job as any).applyUrl).slice(0, 200) : undefined,
      employer: (employer as any)?.name ? String((employer as any).name).slice(0, 80) : undefined,
    });
  }, []);
  useEffect(() => {
    let cancel = false;
    const id = job?.id;
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return;
    const slim = (job as any).respTotal != null && ((job as any).respTotal > (job.responsibilities || []).length);
    // Hydrate whenever the record might be slimmed (respTotal missing on old payloads → fetch anyway).
    if ((job as any).respTotal != null && !slim) return;
    fetchJobFull(id).then((full) => { if (!cancel && full?.job) setFullJob(full.job); });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);
  const hydratedJob: any = fullJob ? { ...job, ...fullJob } : job;
  // Layer in captured details (live/web jobs) so the detail view + cover letter see the real
  // responsibilities/skills that were only on the page the user viewed in the apply WebView.
  const capBase: any = capturedJob ? {
    ...hydratedJob,
    location: isRealLoc(hydratedJob.location) ? hydratedJob.location : (capturedJob.location || hydratedJob.location),
    jobType: hydratedJob.jobType || capturedJob.jobType,
    workMode: hydratedJob.workMode || capturedJob.workMode,
    experience: hydratedJob.experience || capturedJob.experience,
    salary: hydratedJob.salary || capturedJob.salary,
    skills: (hydratedJob.skills && hydratedJob.skills.length) ? hydratedJob.skills : capturedJob.skills,
    responsibilities: (hydratedJob.responsibilities && hydratedJob.responsibilities.length) ? hydratedJob.responsibilities : capturedJob.responsibilities,
  } : hydratedJob;
  const baseJob: any = liJob ? {
    ...capBase,
    title: liJob.title || capBase.title,
    location: liJob.location || capBase.location,
    salary: liJob.salary || capBase.salary,
    jobType: liJob.employment_type || capBase.jobType,
    workMode: liJob.work_mode || capBase.workMode,
    experience: liJob.seniority || capBase.experience,
    skills: (liJob.skills && liJob.skills.length) ? liJob.skills : capBase.skills,
    responsibilities: (liJob.responsibilities && liJob.responsibilities.length) ? liJob.responsibilities : capBase.responsibilities,
  } : capBase;
  const display: any = (showEnglish && translatedJob)
    ? { ...baseJob, ...Object.fromEntries(Object.entries(translatedJob).filter(([, v]) => v != null && (!Array.isArray(v) || v.length > 0))) }
    : baseJob;
  const canTranslate = isLikelyNonEnglish(
    `${job.title || ''} ${Array.isArray((job as any).responsibilities) ? (job as any).responsibilities.join(' ') : ''} ${Array.isArray(job.skills) ? job.skills.join(' ') : ''}`
  );
  const onTranslate = async () => {
    if (translatedJob) { setShowEnglish((v) => !v); return; }
    setTranslatingJob(true);
    try {
      const t = await translateJob(job.id, {
        title: (job as any).title, location: (job as any).location, experience: (job as any).experience,
        salary: (job as any).salary, jobType: (job as any).jobType, workMode: (job as any).workMode,
        skills: (job as any).skills, responsibilities: (job as any).responsibilities,
      });
      setTranslatedJob(t);
      setShowEnglish(true);
    } catch {
      Alert.alert('Translation unavailable', 'Could not translate this job right now. Please try again.');
    } finally { setTranslatingJob(false); }
  };
  // Proper company website WITH TLD (e.g. https://vertigis.com). Priority:
  // 1) threaded domain IF it has a real TLD (contains a dot), 2) the job's apply-URL host,
  // 3) the raw domain as a last resort. Never the bare TLD-less company name → "https://vertigis".
  const _dom = (employer as any).domain as string | undefined;
  const _fromApply = (() => { try { const u = new URL((job as any).applyUrl || ''); return `${u.protocol}//${u.hostname.replace(/^www\./, '')}`; } catch { return ''; } })();
  const employerWebsite =
    (_dom && _dom.includes('.') ? `https://${_dom}` : '') ||
    _fromApply ||
    (_dom ? `https://${_dom}` : '');
  const jobRegion = regionFromCountry((job as any).location || '');   // default region from the job
  const effResumeRegion = resumeRegion || jobRegion;
  const effClRegion = clRegion || jobRegion;
  const allSkills = display.skills || [];
  const SKILLS_LIMIT = 6;
  const visibleSkills = skillsExpanded ? allSkills : allSkills.slice(0, SKILLS_LIMIT);

  // Contacts: start from the param snapshot, then refresh from the backend on focus so a
  // newly-added contact (or any persisted research contact) appears. Merge by email/name so
  // the snapshot's research contacts are never lost.
  const [contacts, setContacts] = useState<Contact[]>(job.contacts ?? []);

  // ── Editable / correctable apply-URL override (per-user). AI/scraped links can be
  // wrong or missing; the user can paste the correct one and Apply opens it instead.
  const [overrideUrl, setOverrideUrl] = useState<string | null>(null);
  const [urlInput,    setUrlInput]    = useState('');
  const [savingUrl,   setSavingUrl]   = useState(false);
  // Canonicalise on the way out as well: jobs saved BEFORE this fix still hold the login/popup
  // URL, and this repairs them at open time without needing a migration.
  const effectiveApplyUrl = canonicalJobUrl(overrideUrl || (job as any).applyUrl || '');
  // Auto-route a LinkedIn job link to the hidden on-device extractor (once per link; backend caches by URL).
  useEffect(() => {
    if (!effectiveApplyUrl || !isLinkedInJobUrl(effectiveApplyUrl)) return;
    if (liTriedRef.current === effectiveApplyUrl) return;
    liTriedRef.current = effectiveApplyUrl;
    setLiJob(null); setLiStage('Loading the job from LinkedIn…'); setLiUrl(effectiveApplyUrl);
  }, [effectiveApplyUrl]);
  useFocusEffect(useCallback(() => {
    if (!job?.id) return;
    getJobContacts(job.id).then(fetched => {
      if (!fetched || !fetched.length) return;
      setContacts(prev => {
        const seen = new Set(prev.map(c => (c.email || c.name || '').toLowerCase()));
        const merged = [...prev];
        for (const c of fetched) {
          const key = (c.email || c.name || '').toLowerCase();
          if (key && !seen.has(key)) { seen.add(key); merged.push(c); }
        }
        return merged;
      });
    }).catch(() => {});
  }, [job?.id]));

  // Load existing cover letter from DB on mount
  useEffect(() => {
    if (!job?.id) return;
    loadJobCoverLetter(job.id).then(record => {
      if (!record) return;
      setCoverLetterHtml(record.cover_letter_html);
      setCompanyNameCL(record.company_name || '');
      setWebsiteUrlCL(record.website_url || '');
      let locs: CLLocation[] = [];
      try { locs = record.company_locations ? JSON.parse(record.company_locations) : []; } catch {}
      if (Array.isArray(locs)) setCompanyLocations(locs);
      // Auto-clean a placeholder ("Location TBD") address to a real office (skip/dedupe placeholders).
      const cleanAddr = employerAddress({ address: record.company_address, locations: Array.isArray(locs) ? locs : [] });
      setCompanyAddressCL(cleanAddr);
      // If the stored address was junk and we recovered a real one, persist it so the PDF/email use it.
      if (cleanAddr && cleanAddr !== (record.company_address || '')) {
        saveJobCoverLetter(job.id, { coverLetterHtml: record.cover_letter_html, companyName: record.company_name || '', websiteUrl: record.website_url || '', position: record.position || job.title, companyAddress: cleanAddr, companyLocations: Array.isArray(locs) ? locs : [] });
      }
      setClState('done');
      clAnim.setValue(1);
      if (record.status === 'downloaded') {
        setDlState('done');
        dlAnim.setValue(1);
      }
    });
  }, [job?.id]);

  // When a live/web job resolves to its canonical UUID (via capture), restore any cover letter
  // previously generated for it — the synthetic mount-load id above couldn't find it.
  useEffect(() => {
    if (!capturedJobId || capturedJobId === job.id || coverLetterHtml) return;
    loadJobCoverLetter(capturedJobId).then(record => {
      if (!record || !record.cover_letter_html) return;
      setCoverLetterHtml(record.cover_letter_html);
      setCompanyNameCL(record.company_name || '');
      setWebsiteUrlCL(record.website_url || '');
      let locs: CLLocation[] = [];
      try { locs = record.company_locations ? JSON.parse(record.company_locations) : []; } catch {}
      if (Array.isArray(locs)) setCompanyLocations(locs);
      setCompanyAddressCL(employerAddress({ address: record.company_address, locations: Array.isArray(locs) ? locs : [] }));
      setClState('done'); clAnim.setValue(1);
      if (record.status === 'downloaded') { setDlState('done'); dlAnim.setValue(1); }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturedJobId]);

  // Load any saved apply-URL override the user previously set for this job.
  // NOTE: use job.id (the real DB UUID, same id contacts/cover-letter use) — navigation passes the
  // job as `jobStr`, NOT a separate `jobId` route param, so the route `jobId` is undefined here.
  useEffect(() => {
    const jid = (job as any)?.id;
    if (!jid) return;
    getJobUrlOverride(jid).then(url => {
      if (!url) return;
      setOverrideUrl(url);
      setUrlInput(url);
    });
  }, [(job as any)?.id]);

  // Save the corrected/added apply link. On success, Apply will open it from now on.
  const handleSaveUrl = async () => {
    const jid = (job as any)?.id;
    const next = urlInput.trim();
    if (!jid) { Alert.alert('Can’t edit this job', 'This job can’t be edited right now.'); return; }
    if (!next || savingUrl) return;
    setSavingUrl(true);
    try {
      const saved = await updateJobUrl(jid, next);
      setOverrideUrl(saved);
      setUrlInput(saved);
      Alert.alert('Saved ✓', 'Apply will now open this link.');
    } catch (e: any) {
      Alert.alert('Could not save link', e?.message || 'Please try again.');
    } finally {
      setSavingUrl(false);
    }
  };

  function animTo(anim: Animated.Value, val: number) {
    Animated.timing(anim, { toValue: val, duration: 350, useNativeDriver: false }).start();
  }

  // Build the capture payload from the best-known fields (+ optional page text for AI extraction).
  const buildCapturePayload = (track: boolean, pageText?: string) => ({
    url: effectiveApplyUrl || (job as any).applyUrl || currentUrlRef.current || '',
    // Prefer what we actually extracted from the posting. Never ship a page-title / job-board host
    // as the title/company — the server treats client values as authoritative, so that junk would
    // block the AI's real extraction and the letter would be addressed to the job board.
    title: capturedJob?.title || ((job as any).weakTitle ? '' : (display.title || job.title || '')),
    company: capturedJob?.company || ((employer as any)?.weakName ? '' : ((employer as any)?.name || companyNameCL || '')),
    companyDomain: (employer as any)?.domain || '',
    location: capturedJob?.location || (isRealLoc(display.location) ? display.location : ((job as any).location || '')),
    jobType: display.jobType || '',
    workMode: display.workMode || null,
    experience: display.experience || '',
    salary: display.salary || '',
    responsibilities: (capturedJob?.responsibilities?.length ? capturedJob.responsibilities : (display.responsibilities || [])) as string[],
    skills: (capturedJob?.skills?.length ? capturedJob.skills : (display.skills || [])) as string[],
    matchScore: typeof (job as any).matchScore === 'number' ? (job as any).matchScore : null,
    pageText: pageText || undefined,
    track,
  });

  // Prefetch (untracked): fire once when the job page loads, so responsibilities + a canonical UUID
  // are ready by the time the user taps Generate Cover Letter. No-op for real DB jobs.
  const prefetchCapture = (pageText: string) => {
    if (isUuid(job.id)) return;
    if (capturedRef.current.id || capturedRef.current.promise) return;
    const p = captureJob(buildCapturePayload(false, pageText))
      .then((r) => {
        if (r && r.jobId) {
          capturedRef.current.id = r.jobId; capturedRef.current.job = r.job;
          capturedIdRef.current = r.jobId;
          setCapturedJobId(r.jobId); setCapturedJob(r.job);
        }
        return r;
      })
      .catch(() => null)
      .finally(() => { capturedRef.current.promise = null; });
    capturedRef.current.promise = p;
  };

  // Ensure the job is captured AND tracked (real UUID + shows in My Jobs). Called at Generate-CL /
  // successful submit. Reuses an in-flight prefetch so we never double-extract.
  const ensureTracked = async (pageText?: string): Promise<{ id: string; job: CapturedJob | null }> => {
    // Real DB job — already persisted (and normally tracked). Don't re-capture: it would risk
    // re-pointing the employer or shrinking the stored responsibilities. Just use its id; the
    // server already augments the letter from the full stored list via this id.
    if (isUuid(job.id)) return { id: job.id, job: capturedRef.current.job };
    if (capturedRef.current.promise) { try { await capturedRef.current.promise; } catch {} }
    // If a prefetch already stored responsibilities, omit pageText so the backend keeps them (an
    // empty list would null them out) and we skip a second AI call.
    const havePT = !!(capturedRef.current.job?.responsibilities?.length);
    const r = await captureJob(buildCapturePayload(true, havePT ? undefined : (pageText || lastPageTextRef.current || undefined)));
    if (r && r.jobId) {
      capturedRef.current.id = r.jobId; capturedRef.current.tracked = true;
      capturedRef.current.job = r.job || capturedRef.current.job;
      capturedIdRef.current = r.jobId;
      setCapturedJobId(r.jobId); if (r.job) setCapturedJob(r.job);
      return { id: r.jobId, job: capturedRef.current.job };
    }
    return { id: capturedRef.current.id || job.id, job: capturedRef.current.job };
  };
  ensureTrackedRef.current = ensureTracked;

  // ── "Fetch job" — save WHATEVER page is on screen to Saved Jobs ──────────────────────────────
  // Reuses the universal capture endpoint (same one the cover-letter flow uses), but always against
  // the LIVE current page, so it works after the user has browsed from a listing to a specific job.
  // A fresh grab is posted back as FETCH_PAGE; onWebMessage does the capture so title/company can be
  // left blank on a navigated page (the server AI-extracts them) without disturbing the initial-job
  // prefetch that feeds the cover letter.
  const fetchThisPage = () => {
    // No same-origin gate here (unlike autofill): Fetch sends only the page's PUBLIC text, and the
    // whole point is to capture whatever job you browsed to — usually a different site than you
    // started on (a board → the company's own ATS).
    if (fetchState !== 'idle' || !applyWebRef.current) return;
    setFetchState('fetching');
    fetchWantRef.current = true;
    try { applyWebRef.current.injectJavaScript(FETCH_PAGE_JS); } catch { fetchWantRef.current = false; setFetchState('idle'); return; }
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
    fetchTimerRef.current = setTimeout(() => {
      if (fetchWantRef.current) { fetchWantRef.current = false; setFetchState('idle'); Alert.alert("Couldn't read this page", 'Give the job a moment to load, then tap Fetch job again.'); }
    }, 25000);
  };

  // Runs once the grabbed page text comes back (from fetchThisPage). Captures + tracks it.
  const captureFetchedPage = async (liveUrl: string, pageText: string, wall: string, mainText = '') => {
    if (fetchTimerRef.current) { clearTimeout(fetchTimerRef.current); fetchTimerRef.current = null; }
    const host = (() => { try { return new URL(liveUrl).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    if (wall === 'login') { setFetchState('idle'); Alert.alert('Sign in first', `${host || 'This site'} wants you logged in before it shows the job. Log in on this page — your session is remembered — then tap Fetch job again.`); return; }
    if (wall === 'challenge') { setFetchState('idle'); Alert.alert('Human check', 'Complete the check shown on the page, wait for the job to appear, then tap Fetch job again.'); return; }
    if (!pageText || pageText.length < 120) { setFetchState('idle'); Alert.alert("Couldn't read this job", `We couldn't pull the details from ${host || 'this page'}. Open the job's own page and try again.`); return; }
    // Are we still on the job this screen was opened for? If so keep the good card title/company;
    // otherwise (browsed to a different job) leave them blank so the server extracts the real ones.
    const onInitial = (() => { try { return canonicalJobUrl(liveUrl) === canonicalJobUrl(effectiveApplyUrl || ''); } catch { return false; } })();
    try {
      const r = await captureJob({
        url: liveUrl,
        title: onInitial && !(job as any).weakTitle ? (display.title || job.title || '') : '',
        company: onInitial && !(employer as any)?.weakName ? ((employer as any)?.name || companyNameCL || '') : '',
        companyDomain: onInitial ? ((employer as any)?.domain || '') : '',
        location: '', jobType: '', workMode: null, experience: '', salary: '',
        responsibilities: [], skills: [],
        matchScore: typeof (job as any).matchScore === 'number' ? (job as any).matchScore : null,
        pageText, mainText, track: true,
      } as any);
      if (r && r.jobId) {
        // Feed the cover-letter path too, so a follow-up Generate uses this job's real details.
        capturedRef.current.id = r.jobId; capturedRef.current.tracked = true;
        if (r.job) { capturedRef.current.job = r.job; setCapturedJob(r.job); }
        capturedIdRef.current = r.jobId; setCapturedJobId(r.jobId);
        // "To apply, email …" contact the page named → merge into the job's contacts so it shows and
        // the compose flow can use it. Keyed on the new jobId, not this screen's initial job.id.
        const cc = (r.job as any)?.contacts as Contact[] | undefined;
        if (cc && cc.length) {
          setContacts((prev) => {
            const seen = new Set(prev.map((c) => (c.email || c.name || '').toLowerCase()));
            const merged = [...prev];
            cc.forEach((c, i) => {
              const key = (c.email || c.name || '').toLowerCase();
              if (key && !seen.has(key)) {
                seen.add(key);
                merged.push({ ...c, id: `cap-${i}-${Date.now()}`, verified: (c as any).verified ?? false, avatarColor: ((c as any).avatarColor as [string, string]) || ['#06B6D4', '#3B82F6'] });
              }
            });
            return merged;
          });
        }
        setFetchState('saved');
        setTimeout(() => setFetchState('idle'), 2400);
      } else {
        setFetchState('idle');
        Alert.alert("Couldn't read the full job", `We couldn't pull the details from ${host || 'this page'}. It may need you to open the job's own page first.`);
      }
    } catch (e: any) {
      setFetchState('idle');
      if (e && e.insufficient) { Alert.alert('Not enough credits', `Fetching a job costs ${e.cost ?? 1} credit(s). You have ${e.creditsRemaining ?? 0}. Top up in Account → Credits.`); return; }
      const timedOut = e && (e.code === 'ECONNABORTED' || /timeout/i.test(String(e?.message || '')));
      Alert.alert(timedOut ? 'Taking longer than expected' : "Couldn't save this job",
        timedOut ? "This job is still being read in the background — tap Fetch job again in a moment and it'll be ready." : String(e?.message || 'Something went wrong reading this page.'));
    }
  };

  // Hand the page the user is looking at to the phone's own browser (SFSafariViewController /
  // Chrome Custom Tabs). Uses the LIVE url, not the job's original one — after a board→ATS hop the
  // live page is the one they mean.
  const openCurrentInBrowser = () => {
    const u = currentUrlRef.current || effectiveApplyUrl || '';
    if (!u || !/^https?:\/\//i.test(u)) { Alert.alert('Nothing to open', 'Open the job page first.'); return; }
    WebBrowser.openBrowserAsync(u).catch(() => { Linking.openURL(u).catch(() => {}); });
  };

  // Canonical id for all cover-letter + status writes (falls back to the param id).
  const jid = capturedJobId || job.id;

  const handleGenerateCoverLetter = async () => {
    if (clState === 'loading') return;
    setClState('loading'); setClProgress(0); clAnim.setValue(0);

    // Fake progress ticks while polling (mirrors HomeScreen)
    let fake = 0;
    const tick = setInterval(() => {
      if (fake < 80) { fake = Math.min(fake + 1.2, 80); setClProgress(Math.round(fake)); animTo(clAnim, fake / 100); }
    }, 200);

    const stages = ['Analyzing Resume…', 'Researching Company…', 'Writing Cover Letter…', 'Finalising…'];
    let stageIdx = 0;
    const stageTick = setInterval(() => {
      stageIdx = Math.min(stageIdx + 1, stages.length - 1);
      setClLabel(stages[stageIdx]);
    }, 8000);

    try {
      // Capture + track the job FIRST: guarantees a real DB UUID (so it appears in My Jobs) and that
      // the letter is written from the ACTUAL posting's responsibilities, not the thin card.
      const captured = await ensureTracked(lastPageTextRef.current || undefined);
      const cjid = captured.id;
      const websiteUrl = websiteUrlCL || employerWebsite;
      const capResp = (captured.job?.responsibilities || capturedJob?.responsibilities || []) as string[];
      const responsibilities = capResp.length > 0 ? capResp : (((display as any).responsibilities as string[] | undefined) || []);
      // The REAL employer name (AI-extracted from the posting) — not the job-board host we may have
      // stamped on the card. Without this the letter researches instahyre/naukri as the employer.
      const realCompany = (captured.job?.company || capturedJob?.company || '').trim();
      const jobId = await startJobCoverLetter(
        websiteUrl,
        display.title,
        responsibilities.length > 0 ? responsibilities : undefined,
        display.location || undefined,
        cjid,   // canonical UUID → server augments from the FULL stored responsibilities
        realCompany || undefined,
      );
      const result = await pollJobCoverLetter(jobId, () => {
        if (fake < 75) { fake = Math.min(fake + 3, 75); setClProgress(Math.round(fake)); animTo(clAnim, fake / 100); }
      });

      clearInterval(tick); clearInterval(stageTick);
      setClProgress(100); animTo(clAnim, 1);
      const html   = result.coverLetterHtml || '';
      const cName  = result.companyName || employer.name;
      const webUrl = websiteUrl;

      // Full locations array from generation result
      const locs: CLLocation[] = ((result as any).locations as CLLocation[] | undefined) || [];

      // Pick best address: the server flags the job-location office as matchesJobLocation
      // (and lists it first). Prefer that; else local match; else HQ; else first.
      const jobLocLower = (job.location || '').toLowerCase();
      const bestLoc = locs.find(l => l.matchesJobLocation) || locs.find(l => {
        const loc = `${l.address} ${l.city} ${l.country}`.toLowerCase();
        return jobLocLower && (loc.includes(jobLocLower) || jobLocLower.split(/[,\s]+/).some(w => w.length > 2 && loc.includes(w)));
      }) || locs.find(l => l.isHeadquarters) || locs[0];
      // Clean join (dedupe + drop placeholder 'Location TBD' parts); fall back to first real office.
      const addr = (bestLoc && fmtLocation(bestLoc)) || employerAddress({ locations: locs }) || '';

      setCoverLetterHtml(html);
      setCompanyNameCL(cName);
      setWebsiteUrlCL(webUrl);
      setCompanyAddressCL(addr);
      setCompanyLocations(locs);
      setTimeout(() => setClState('done'), 300);
      // Persist to DB against the canonical job (non-blocking) — sets status 'generated' → the job
      // now shows in My Jobs as "CL Ready". Store locations as JSON for dropdown restore on reload.
      saveJobCoverLetter(cjid, { coverLetterHtml: html, companyName: cName, websiteUrl: webUrl, position: job.title, companyAddress: addr, companyLocations: locs });
      return html;   // so callers (e.g. Apply-via-Mail) can proceed once it's ready
    } catch (e: any) {
      clearInterval(tick); clearInterval(stageTick);
      setClState('idle');
      const msg = e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message ?? 'Failed to generate. Please try again.';
      // Quota exhausted (trial/plan) → offer the Plans screen instead of a dead-end error.
      if (e?.response?.status === 402) {
        Alert.alert('Limit reached', msg, [
          { text: 'Not now', style: 'cancel' },
          { text: 'See plans', onPress: () => router.push('/(subscription)/plans' as never) },
        ]);
        return null;
      }
      // NO RÉSUMÉ — the #1 silent dead-end in the 2026-08-01 analysis: users tapped Generate
      // three times in four seconds, got nothing they could act on, and left. Take them to the
      // upload instead of showing a message about a screen they have to go find.
      if (e?.response?.data?.action === 'upload_resume' || /resume required/i.test(String(msg))) {
        Alert.alert(
          'Add your résumé first',
          'Cover letters are written from your résumé. It takes about a minute to upload.',
          [
            { text: 'Not now', style: 'cancel' },
            {
              text: 'Upload résumé',
              onPress: async () => {
                // Same bridge the onboarding checklist uses: App.js opens Account Settings and
                // focuses the résumé section on this key. Leaving the user on a dead alert is
                // exactly what burned u140 three sessions in a row.
                try { await AsyncStorage.setItem('onboarding_focus_target', 'resume'); } catch {}
                try { track('cl_blocked_no_resume'); } catch {}
                router.back();
              },
            },
          ],
        );
        return null;
      }
      Alert.alert('Error', msg);
      return null;
    }
  };

  // Change which office address goes on the cover letter (PDF + email). Persists to job_cover_letters
  // — the SAME store the Jobs page reads — so the choice sticks on reload.
  const pickOffice = (loc: CLLocation) => {
    const addr = fmtLocation(loc);
    setShowOfficePicker(false);
    if (!addr) return;
    setCompanyAddressCL(addr);
    saveJobCoverLetter(jid, { coverLetterHtml: coverLetterHtml || '', companyName: companyNameCL || employer.name, websiteUrl: websiteUrlCL, position: job.title, companyAddress: addr, companyLocations });
  };

  const handleDownloadPdf = async () => {
    if (dlState === 'loading' || !coverLetterHtml) return;
    // Open the country-format picker (preview free, download charges credits).
    try {
      await AsyncStorage.setItem('coverLetterPickerContext', JSON.stringify({
        coverLetterHtml,
        companyName: companyNameCL || employer.name,
        companyAddress: companyAddressCL,
      }));
      updateJobCLStatus(jid, 'downloaded');
      router.push('/(cover-letter)/templates');
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Could not open download options.');
    }
  };

  // ── AI auto-fill orchestration (read → map → fill → attach resume → attach CL) ──
  const finishAutofill = (state: 'done' | 'error', note = '') => {
    autofillRef.current.active = false;
    lastRunEndedRef.current = Date.now();
    if (runTimerRef.current) { clearTimeout(runTimerRef.current); runTimerRef.current = null; }
    setAutofillState(state);
    setAutofillNote(note);
  };
  // Keep the ref in step with the state it mirrors.
  const applyWizardUi = (v: { i: number; n: number; name: string } | null) => { wizardUiRef.current = v; setWizardUi(v); };

  // Final message from BOTH stages, so a run that filled no text fields but DID add skills still
  // reads as a success (and vice-versa) instead of the old blanket "couldn't match any fields".
  // It also NAMES what it could not answer: a bare count made people trust a form that still had
  // required dropdowns sitting empty — and on react-select pages that was silently all of them.
  const finishFill = (fields: number, skills: number) => {
    const parts: string[] = [];
    if (fields > 0) parts.push(`Filled ${fields} field${fields === 1 ? '' : 's'}`);
    if (skills > 0) parts.push(`${fields > 0 ? 'added' : 'Added'} ${skills} skill${skills === 1 ? '' : 's'}`);
    const failed = failedAccumRef.current.filter((f: any) => f && f.label);
    setAutofillFailed(failed.slice(0, 6));
    if (!parts.length) {
      finishAutofill('done', failed.length
        ? "We couldn't fill this form automatically — the questions below still need you."
        : "We couldn't match anything on this page automatically — please fill it in manually.");
      return;
    }
    const tail = failed.length
      ? ` ${failed.length} question${failed.length === 1 ? '' : 's'} still need${failed.length === 1 ? 's' : ''} you — see below.`
      : '';
    finishAutofill('done', `${parts.join(' and ')}.${tail} Now tap each upload field to attach your resume & cover letter.`);
  };

  const closeApplyWebView = () => {
    autofillRef.current.active = false;
    autofillRef.current.gen++;            // invalidate any in-flight run
    setAutofillState(null);
    setPreview(null); setPreviewBusy(null);   // don't leave a stale preview / busy spinner
    setFilePick(null); setFilePickBusy(null);
    if (attachTimerRef.current) { clearTimeout(attachTimerRef.current); attachTimerRef.current = null; }   // no stray "couldn't attach" alert after close
    for (const r of [scanTimerRef, skillsTimerRef, fieldsCapRef, fillCapRef, runTimerRef, filledTimerRef, fieldsTimerRef, wizTimerRef, fetchTimerRef]) {
      if (r.current) { clearTimeout(r.current); r.current = null; }
    }
    fetchWantRef.current = false; setFetchState('idle');
    wizProbeRef.current.seq++;               // invalidate any in-flight wizard probe
    wizStepKeyRef.current = ''; wizAutoRef.current = 0;
    applyWizardUi(null);
    setAutofillFailed([]);
    const didApply = submitMarkedRef.current;
    setApplyWebUrl(null);
    // If they actually submitted on the portal, ask for a rating after the web view closes.
    if (didApply) setTimeout(() => { rating.ask('apply_portal'); }, 450);
  };

  // A run is still valid only if it's the current active run AND the page hasn't navigated
  // to a different origin (so a mid-flow SSO/redirect can never receive the user's PII/files).
  const stillValid = (gen: number) =>
    autofillRef.current.active && autofillRef.current.gen === gen && sameOrigin();

  const startAutofill = () => {
    if (!applyWebRef.current || autofillRef.current.active) return;
    // Lock the run to the origin the user is currently viewing.
    try { applyOriginRef.current = new URL(currentUrlRef.current || applyWebUrl || '').origin; } catch { applyOriginRef.current = ''; }
    if (!applyOriginRef.current) { setAutofillState('error'); setAutofillNote('Could not read the page. Reload and try again.'); setAfStep({}); return; }
    const gen = ++autofillRef.current.gen;
    autofillRef.current = { active: true, gen, resumeKeys: [], clKeys: [], radioKeys: [], files: null };
    setAutofillNote('');
    setAfStep({ reading: 'active' });
    setAutofillState('running');
    fieldsAccumRef.current = [];
    filledAccumRef.current = { count: 0 };
    filledCountRef.current = 0;
    skillsCountRef.current = 0;
    pendingScanFramesRef.current = 0;
    pendingFillFramesRef.current = 0;
    failedAccumRef.current = [];
    fillFinalizedRef.current = -1;
    setAutofillFailed([]);
    wizProbeRef.current = { seq: wizProbeRef.current.seq + 1, reports: [] };
    for (const r of [fieldsTimerRef, skillsTimerRef, fieldsCapRef, fillCapRef, runTimerRef, filledTimerRef, wizTimerRef]) {
      if (r.current) { clearTimeout(r.current); r.current = null; }
    }
    // The skills stage needs the user's résumé skills — make sure the bundle has landed.
    if (!smartData) { getSmartFillData().then(setSmartData).catch(() => {}); }
    // WHOLE-RUN ceiling. The scan watchdog below disarms the moment fields arrive, which left a hung
    // mapping (the server's own AI timeout is 60s) spinning the overlay with no honest way out.
    runTimerRef.current = setTimeout(() => {
      if (autofillRef.current.active && autofillRef.current.gen === gen) {
        finishAutofill('error', 'This form took too long. Anything already filled has been kept — please finish the rest by hand.');
      }
    }, 95000);
    // WATCHDOG: the scan retries internally (SPA forms render late). If nothing ever comes back,
    // fail honestly instead of leaving the overlay spinning forever.
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    scanTimerRef.current = setTimeout(() => {
      if (autofillRef.current.active && autofillRef.current.gen === gen && !fieldsAccumRef.current.length) {
        setStep('reading', 'warn');
        finishAutofill('error', "Couldn't read this form in time. Scroll to the application form and tap Auto Fill again.");
      }
    }, 25000);
    // Arm the step watcher so that when the USER presses Next on a multi-step form, the new step
    // fills itself. (We never press Next — see wReport/wFindNext: the probe is read-only.)
    try {
      applyWebRef.current.injectJavaScript('try{window.__cvfArmStepWatch&&window.__cvfArmStepWatch();}catch(e){} true;');
      applyWebRef.current.injectJavaScript(relayToChildrenJs({ __cvfCmd: 'armStepWatch' }));
    } catch {}
    applyWebRef.current.injectJavaScript(READ_FIELDS_JS);                          // main frame (as before)
    applyWebRef.current.injectJavaScript(relayToChildrenJs({ __cvfCmd: 'scan' })); // + any iframe(s)
  };

  // ── MULTI-STEP ──────────────────────────────────────────────────────────────────────────────
  // We probe; we never click. Deciding that a button labelled "Continue" is a Next and not the final
  // Submit is a heuristic, and the cost of getting it wrong once is a half-finished application sent
  // to a real employer. So the person taps Next — and the moment they do, STEP_CHANGED brings us
  // back and the next step fills itself.
  const WIZ_PROBE_MS = 900;      // ≈ the FIELDS debounce; long enough for every frame to answer
  const WIZ_MAX_AUTO = 8;        // never chain more than this many steps in one sitting

  const wizardProbe = (gen: number) => {
    if (!stillValid(gen)) { finishFill(filledCountRef.current, skillsCountRef.current); return; }
    const seq = ++wizProbeRef.current.seq;   // also invalidates a duplicate probe (the skills timeout
    wizProbeRef.current.reports = [];        // and a late SKILLS_ADDED both land here)
    try {
      applyWebRef.current?.injectJavaScript(WIZARD_PROBE_JS);
      applyWebRef.current?.injectJavaScript(relayToChildrenJs({ __cvfCmd: 'wizardProbe' }));
    } catch { finishFill(filledCountRef.current, skillsCountRef.current); return; }
    if (wizTimerRef.current) clearTimeout(wizTimerRef.current);
    wizTimerRef.current = setTimeout(() => {
      if (wizProbeRef.current.seq !== seq) return;
      settleWizard(wizProbeRef.current.reports.slice(), gen);
    }, WIZ_PROBE_MS);
  };

  const settleWizard = (reports: any[], gen: number) => {
    if (wizTimerRef.current) { clearTimeout(wizTimerRef.current); wizTimerRef.current = null; }
    if (!stillValid(gen)) return;
    // Pick ONE frame's report; never merge across frames. An ordinal printed by the host page must
    // never be combined with a control that lives inside an iframe.
    let best: any = null, bestScore = -1;
    for (const r of reports) {
      if (!r || r.error) continue;
      const score = (r.hasOrdinal ? 2 : 0) + (r.canNext ? 1 : 0);
      if (score > bestScore) { best = r; bestScore = score; }
    }
    if (best && best.stepKey) wizStepKeyRef.current = String(best.stepKey);
    const f = filledCountRef.current, sk = skillsCountRef.current;

    // Not a wizard → exactly today's ending.
    if (!best || (!best.hasOrdinal && !best.canNext)) { applyWizardUi(null); finishFill(f, sk); return; }

    const failed = failedAccumRef.current.filter((x: any) => x && x.label);
    setAutofillFailed(failed.slice(0, 6));
    const did = f > 0 || sk > 0
      ? `Filled ${f} field${f === 1 ? '' : 's'}${sk > 0 ? ` and added ${sk} skill${sk === 1 ? '' : 's'}` : ''}`
      : 'Nothing on this step matched your profile';
    setStep('wizard', 'done');

    if (best.hasOrdinal) {
      applyWizardUi({ i: best.i, n: best.n, name: String(best.stepName || '') });
      if (best.review || best.i >= best.n) {
        finishAutofill('done', `${did} on step ${best.i} of ${best.n} — the last one. Check everything, then submit it yourself.`);
        return;
      }
      const req = best.requiredEmpty > 0
        ? ` ${best.requiredEmpty} required question${best.requiredEmpty === 1 ? '' : 's'} here still need${best.requiredEmpty === 1 ? 's' : ''} your answer.`
        : '';
      finishAutofill('done', `${did} on step ${best.i} of ${best.n}.${req} Tap Next on the page — I'll fill the next step automatically.`);
      return;
    }
    // Wizard-shaped but uncountable (a bespoke SPA stepper). Say so; never invent a number.
    applyWizardUi({ i: 0, n: 0, name: '' });
    finishAutofill('done', `${did}. This form has more than one step. Tap Next on the page — I'll fill the next one automatically.`);
  };

  // Process the MERGED field set (main frame + iframes) once it settles. Extracted from the FIELDS
  // handler so a debounce can gather fields from every frame before the AI mapping runs.
  const processFields = async (fields: any[], gen: number) => {
    if (!autofillRef.current.active || autofillRef.current.gen !== gen) return;
    if (!Array.isArray(fields) || fields.length === 0) {
      setStep('reading', 'warn');
      finishAutofill('error', 'No fillable fields found. Open the application form first, then tap Auto Fill.');
      return;
    }
    // Run the AI mapping ONCE per run. The field-scan RETRY means a slow/empty frame can post FIELDS
    // seconds after mapping already started — without this guard that re-armed the debounce and fired a
    // SECOND autofill-map call (duplicate credit charge) + second fill. (Empty posts hit finishAutofill
    // above → active=false → the top guard stops them.)
    if (processedGenRef.current === gen) return;
    processedGenRef.current = gen;
    if (scanTimerRef.current) { clearTimeout(scanTimerRef.current); scanTimerRef.current = null; }   // fields arrived
    setStep('reading', 'done'); setStep('mapping', 'active');
    try {
      const token = await getToken();
      if (!stillValid(gen)) return;
      const data = await postAndPoll('/ai-hub/autofill-map', { fields, coverLetterHtml, jobTitle: job.title, companyName: companyNameCL || employer.name }, token);
      if (!stillValid(gen)) return;
      const values = (data && data.values) || {};
      const clText = clPlainText(coverLetterHtml);
      if (clText) { for (const f of fields) { if (isCoverLetterTextarea(f)) values[f.key] = clText; } }
      try { smartValuesRef.current = { ...smartValuesRef.current, ...values }; } catch {}
      // Questions the server DELIBERATELY left blank (legal/consent/no-matching-option). Naming them
      // is the difference between "filled 12 fields" and the user knowing what is still missing.
      if (Array.isArray(data?.skipped)) {
        for (const sk of data.skipped) {
          if (sk && sk.label && values[sk.key] == null && !failedAccumRef.current.some((x: any) => x.key === sk.key)) {
            failedAccumRef.current.push({ key: sk.key, label: String(sk.label).slice(0, 90), why: String(sk.why || 'needs your answer') });
          }
        }
      }
      // Be honest about WHICH stage came up empty: blaming the fill for a mapping that returned
      // nothing (AI down, or a profile too thin to answer these questions) sent people hunting the
      // wrong problem. The skills stage still runs — it doesn't depend on the mapping.
      if (data && data.warning === 'ai_unavailable') {
        setStep('mapping', 'warn');
        setAutofillNote('Our AI is busy right now — skills will still be added. Try Auto Fill again in a minute for the rest.');
      } else {
        setStep('mapping', Object.keys(values).length ? 'done' : 'warn');
      }
      setStep('filling', 'active');
      filledAccumRef.current = { count: 0 };
      if (filledTimerRef.current) { clearTimeout(filledTimerRef.current); filledTimerRef.current = null; }
      applyWebRef.current?.injectJavaScript(fillJs(values));                          // main frame
      applyWebRef.current?.injectJavaScript(relayToChildrenJs({ __cvfCmd: 'fill', values })); // + iframe(s)
    } catch (err: any) {
      if (stillValid(gen)) { setStep('mapping', 'warn'); finishAutofill('error', err?.message || 'AI mapping failed.'); }
    }
  };

  // A slow frame produced fields AFTER the mapping already ran. Fill anything we already hold a value
  // for; genuinely new questions are reported honestly rather than triggering a second mapping call
  // (autofill-map charges 'ai_autofill' — free only while no admin has priced it, and processedGenRef
  // exists precisely to stop the double charge).
  const processLateFields = async (fresh: any[], gen: number) => {
    if (!stillValid(gen)) return;
    const known = smartValuesRef.current || {};
    const values: Record<string, any> = {};
    for (const f of fresh) { if (known[f.key] != null) values[f.key] = known[f.key]; }
    const clText = clPlainText(coverLetterHtml);
    if (clText) { for (const f of fresh) { if (isCoverLetterTextarea(f)) values[f.key] = clText; } }
    for (const f of fresh) {
      if (values[f.key] == null && f.label && !failedAccumRef.current.some((x: any) => x.key === f.key)) {
        failedAccumRef.current.push({ key: f.key, label: String(f.label).slice(0, 90), why: 'appeared after we finished reading the form' });
      }
    }
    if (!Object.keys(values).length || !stillValid(gen)) return;
    applyWebRef.current?.injectJavaScript(fillJs(values));
    applyWebRef.current?.injectJavaScript(relayToChildrenJs({ __cvfCmd: 'fill', values }));
  };

  const onWebMessage = async (e: any) => {
    let msg: any;
    try { msg = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (!msg || msg.__cvf !== true) return;          // ignore the host page's own postMessages

    // The page tried to open a sign-in popup (impossible on iOS) — run it here and remember the form.
    if (msg.type === 'AUTH_POPUP') { beginAuthFlow(String(msg.url || ''), String(msg.from || '')); return; }
    // The callback page called window.close() → auth finished, go back to the application.
    if (msg.type === 'AUTH_DONE') { returnFromAuth(600); return; }

    // Job page text captured → remember it, and prefetch the job details (canonical UUID + AI
    // responsibilities) so Generate-Cover-Letter has real data ready. No-op for real DB jobs.
    if (msg.type === 'JOB_PAGE_TEXT') {
      lastPageTextRef.current = String(msg.text || '');
      if (lastPageTextRef.current.length > 120) prefetchCapture(lastPageTextRef.current);
      return;
    }

    // "Fetch job" grabbed the live page → capture + track it into Saved Jobs.
    if (msg.type === 'FETCH_PAGE') {
      if (!fetchWantRef.current) return;
      fetchWantRef.current = false;
      const liveUrl = String(msg.url || currentUrlRef.current || '');
      lastPageTextRef.current = String(msg.text || '');
      void captureFetchedPage(liveUrl, String(msg.text || ''), String(msg.wall || ''), String(msg.mainText || ''));
      return;
    }

    // File-tap interception (works independently of an auto-fill run).
    if (msg.type === 'FILE_PICK') { setFilePick({ key: msg.key, accept: msg.accept || '', label: msg.label || '' }); return; }
    if (msg.type === 'ATTACHED' && msg.kind === 'pick') {
      if (msg.noField) {   // manual Upload but the page has no file-upload field at all
        if (attachTimerRef.current) { clearTimeout(attachTimerRef.current); attachTimerRef.current = null; }
        setFilePickBusy(null); setFilePick(null);
        Alert.alert('No upload field here', 'This page has no file-upload field yet. Open the application form first, then tap Upload.');
        return;
      }
      if (!msg.total) return;   // a frame that didn't contain the tapped field — wait for the one that does
      if (attachTimerRef.current) { clearTimeout(attachTimerRef.current); attachTimerRef.current = null; }
      setFilePickBusy(null); setFilePick(null);
      if (msg.ok > 0) Alert.alert('Attached ✓', 'Your file was attached to the form.');
      else Alert.alert("Couldn't attach here", 'This upload field blocked the attachment. Tap “Choose from device” and pick the file yourself.');
      return;
    }

    // Language auto-detect: if the page is non-English and the user hasn't opted out, translate.
    if (msg.type === 'PAGE_LANG') {
      if (msg.nonEnglish && autoXlateRef.current && !xlateOnRef.current && applyWebRef.current) {
        xlateOnRef.current = true;
        webTranslatedRef.current = true;
        setWebTranslated(true);
        runXlate('auto');
      }
      return;
    }

    // ── translation ────────────────────────────────────────────────────────────
    // The page handed us everything translatable (text nodes, aria-label/title/placeholder/alt,
    // button values, shadow DOM). Translate server-side in chunks, then write it back in place.
    if (msg.type === 'XLATE_ITEMS') {
      if (msg.gen !== xlateGenRef.current || !xlateOnRef.current) return;   // superseded / turned off
      const items: XlateItem[] = Array.isArray(msg.items) ? msg.items : [];
      if (!items.length) { setWebTranslating(false); return; }
      const gen = msg.gen;
      xlateBusyRef.current = true;
      (async () => {
        const stale = () => gen !== xlateGenRef.current || !xlateOnRef.current;
        let applied = 0;
        try {
          // Deduped, chunked and written back round by round, so a long page fills in as it goes
          // instead of spinning until every chunk is home.
          applied = await runXlatePasses(
            items,
            (batch) => translateBatch(batch),
            (map, final) => { try { applyWebRef.current?.injectJavaScript(xlateApplyJS(gen, map, final)); } catch {} },
            stale,
          );
        } finally { xlateBusyRef.current = false; }
        if (stale()) return;                                                // user toggled off meanwhile
        if (!applied) {
          setWebTranslating(false);
          Alert.alert('Translation unavailable', "We couldn't translate this page right now. You can open it in your phone's browser to translate it there.");
        }
      })();
      return;
    }
    // Only the FINAL round ends the pass — earlier rounds are progress, not completion.
    if (msg.type === 'XLATE_APPLIED') { if (msg.gen === xlateGenRef.current && msg.final) setWebTranslating(false); return; }
    // SPA rendered new content while translation is on → translate the new bits too. Skipped while a
    // pass runs: the DOM churn would be our OWN writes, and restarting would cancel the pass.
    if (msg.type === 'XLATE_DIRTY') { if (xlateOnRef.current && !webLoadingRef.current && !xlateBusyRef.current) runXlate('spa'); return; }

    // Smart-copy: remember which field the user focused, so the popup leads with the
    // right value (works independently of an auto-fill run).
    if (msg.type === 'FIELD_FOCUS') {
      focusedFieldRef.current = { key: msg.key || '', label: msg.label || '', type: msg.fieldType || '' };
      return;
    }

    // Self-learning: the page is about to submit → harvest what the user filled, so the
    // next form with the same questions auto-fills. (Harvest while the values are still in
    // the DOM — SUBMIT_INTENT fires before the navigation completes.)
    if (msg.type === 'SUBMIT_INTENT') {
      submitIntentRef.current = Date.now();
      try { if (sameOrigin()) applyWebRef.current?.injectJavaScript(HARVEST_JS); } catch {}
      return;
    }
    if (msg.type === 'HARVEST') {
      if (Array.isArray(msg.answers) && msg.answers.length) recordAutofillMemory(msg.answers);
      return;
    }

    // Submission detected on the page (works whether the user auto-filled or filled
    // manually, in any language). Mark the job "Applied" once — dashboard reflects it.
    if (msg.type === 'SUBMIT_SUCCESS') { markApplied(); return; }

    // The USER advanced a multi-step form. Fill the step they just landed on, so a wizard takes one
    // tap per step instead of one tap plus hunting for Auto Fill. Runs only after a completed run,
    // never while one is in flight, and stops at WIZ_MAX_AUTO.
    if (msg.type === 'STEP_CHANGED') {
      const k = String(msg.stepKey || '');
      if (!k || k === wizStepKeyRef.current) return;
      if (autofillRef.current.active) return;               // a run is already working this page
      if (!applyWebUrl || !sameOrigin()) return;
      if (wizAutoRef.current >= WIZ_MAX_AUTO) return;
      // Only ever on a form the previous run actually IDENTIFIED as multi-step. Without this, an
      // ordinary single-page form that reveals a conditional "if yes, explain" field counts as a
      // "step change" and re-runs the whole charged mapping while the user is mid-sentence.
      if (!wizardUiRef.current) return;
      if (Date.now() - lastRunEndedRef.current < 4000) return;          // not while things settle
      // The step must really have MOVED: either the ordinal changed, or most of the questions did.
      // wStepKey is "<i/n>#<count>#<sig,sig,…>".
      const parse = (s: string) => { const p = s.split('#'); return { ord: p[0] || '', sigs: (p[2] || '').split(',').filter(Boolean) }; };
      const now = parse(k), was = parse(wizStepKeyRef.current || '');
      const ordMoved = !!now.ord && now.ord !== '?' && now.ord !== was.ord;
      const shared = now.sigs.filter((x) => was.sigs.includes(x)).length;
      const mostlyNew = now.sigs.length > 0 && shared / Math.max(now.sigs.length, was.sigs.length || 1) < 0.5;
      if (!ordMoved && !mostlyNew) return;
      wizStepKeyRef.current = k;
      wizAutoRef.current += 1;
      startAutofill();
      return;
    }

    // A real agent frame announced it is working and therefore owes us an answer.
    if (msg.type === 'FRAME_SCANNING') { pendingScanFramesRef.current += 1; return; }
    if (msg.type === 'FRAME_FILLING')  { pendingFillFramesRef.current += 1; return; }

    if (!autofillRef.current.active) return;
    const gen = autofillRef.current.gen;

    if (msg.type === 'FIELDS') {
      // Accumulate fields across frames (main + iframe), dedupe by key, then process once they settle.
      const incoming = Array.isArray(msg.fields) ? msg.fields : [];
      if (msg.frame) pendingScanFramesRef.current = Math.max(0, pendingScanFramesRef.current - 1);
      const fresh = incoming.filter((f: any) => f && f.key && !fieldsAccumRef.current.some((x: any) => x.key === f.key));
      for (const f of fresh) fieldsAccumRef.current.push(f);

      if (processedGenRef.current !== gen) {
        if (fieldsTimerRef.current) { clearTimeout(fieldsTimerRef.current); fieldsTimerRef.current = null; }
        // A cross-origin ATS iframe scans SECONDS slower than its host page (scrollThrough + up to 11
        // retries + dropdown enumeration). A flat 700ms debounce let the host page's lone search box
        // win the race, start the mapping, and then processedGen threw the iframe's ENTIRE
        // application form away — we filled a newsletter box and called it done.
        if (pendingScanFramesRef.current > 0) {
          if (!fieldsCapRef.current) {
            fieldsCapRef.current = setTimeout(() => {
              fieldsCapRef.current = null;
              if (stillValid(gen)) void processFields(fieldsAccumRef.current.slice(), gen);
            }, 20000);
          }
          return;
        }
        if (fieldsCapRef.current) { clearTimeout(fieldsCapRef.current); fieldsCapRef.current = null; }
        fieldsTimerRef.current = setTimeout(() => { void processFields(fieldsAccumRef.current.slice(), gen); }, 700);
        return;
      }
      // Mapping already ran and a frame has only NOW produced fields. Don't discard them — and don't
      // pay for a second mapping either.
      if (fresh.length) void processLateFields(fresh, gen);
      return;
    } else if (msg.type === 'FILLED') {
      filledAccumRef.current.count += (msg.count || 0);
      if (msg.frame) pendingFillFramesRef.current = Math.max(0, pendingFillFramesRef.current - 1);
      if (Array.isArray(msg.failed)) {
        for (const f of msg.failed) {
          if (f && f.key && !failedAccumRef.current.some((x: any) => x.key === f.key)) failedAccumRef.current.push(f);
        }
      }
      const finalizeFill = () => {
        if (fillFinalizedRef.current === gen) return;
        fillFinalizedRef.current = gen;
        for (const r of [fillCapRef, filledTimerRef]) { if (r.current) { clearTimeout(r.current); r.current = null; } }
        const c = filledAccumRef.current.count;
        filledCountRef.current = c;
        setStep('filling', c > 0 ? 'done' : 'warn');
        // Skills live in clickable chips, not form fields — run that stage now that the text fields
        // have settled. Kept as a SEPARATE injection so a bug here can't break the working fill path.
        const sk = (smartData?.skills || []).filter(Boolean);
        if (sk.length && stillValid(gen)) {
          setStep('skills', 'active');
          try { applyWebRef.current?.injectJavaScript(skillsJs(sk)); } catch { skillsCountRef.current = 0; wizardProbe(gen); }
          // If the page never answers (no skills widget), don't hang the overlay.
          if (skillsTimerRef.current) clearTimeout(skillsTimerRef.current);
          skillsTimerRef.current = setTimeout(() => { if (stillValid(gen)) { setStep('skills', 'warn'); skillsCountRef.current = 0; wizardProbe(gen); } }, 12000);
        } else {
          setStep('skills', 'warn');
          skillsCountRef.current = 0;
          wizardProbe(gen);
        }
      };
      if (filledTimerRef.current) { clearTimeout(filledTimerRef.current); filledTimerRef.current = null; }
      // The main frame posts FILLED{count:0} almost instantly when the form lives in an iframe. The
      // old 600ms debounce let that win, the run ended, and the iframe's real FILLED{count:18} was
      // dropped by the `if (!active) return` guard — the user was told nothing matched.
      if (pendingFillFramesRef.current > 0) {
        // Deliberately above the injected drain's own 9s cap, so skillsJs (the other script that
        // clicks page elements) can never run while a dropdown popup is open.
        if (!fillCapRef.current) fillCapRef.current = setTimeout(() => { fillCapRef.current = null; if (stillValid(gen)) finalizeFill(); }, 30000);
      } else {
        filledTimerRef.current = setTimeout(() => { if (stillValid(gen)) finalizeFill(); }, 600);
      }
    } else if (msg.type === 'SKILLS_ADDED') {
      if (skillsTimerRef.current) { clearTimeout(skillsTimerRef.current); skillsTimerRef.current = null; }
      const n = msg.added || 0;
      skillsCountRef.current = n;
      setStep('skills', n > 0 ? 'done' : 'warn');
      wizardProbe(gen);
    } else if (msg.type === 'WIZARD') {
      wizProbeRef.current.reports.push(msg);      // settleWizard decides once every frame has spoken
    } else if (msg.type === 'AUTOFILL_ERROR') {
      finishAutofill('error', msg.error || 'Auto-fill failed.');
    }
  };

  // ── File-pick sheet: attach our resume / cover letter (per region), preview, or device ──
  const loadFile = async (kind: 'resume' | 'coverLetter', region: string) => {
    const ck = kind + ':' + region;
    if (filesRef.current[ck] !== undefined) return filesRef.current[ck];
    const token = await getToken();
    const body = kind === 'resume'
      ? { which: 'resume', resumeRegion: region === 'generic' ? undefined : region }
      // companyAddress mirrors what openPreview() sends, so the attached letter == the preview.
      : { which: 'cover', clRegion: region === 'generic' ? undefined : region, coverLetterHtml, companyName: companyNameCL || employer.name, companyAddress: companyAddressCL || '' };
    // Background job (PDF render) — survives the app being minimized.
    const data = await postAndPoll('/ai-hub/autofill-files', body, token);
    filesRef.current[ck] = (kind === 'resume' ? data?.resume : data?.coverLetter) || null;
    return filesRef.current[ck];
  };

  const attachPickedFile = async (kind: 'resume' | 'coverLetter', region: string) => {
    if (!filePick || !applyWebRef.current) return;
    setFilePickBusy((kind === 'resume' ? 'r:' : 'c:') + region);
    try {
      const f = await loadFile(kind, region);
      if (!f) {
        setFilePickBusy(null);
        Alert.alert('Not available', kind === 'resume' ? 'Your resume could not be prepared.' : 'No cover letter for this job yet — generate one first.');
        return;
      }
      applyWebRef.current.injectJavaScript(attachJs([filePick.key], f.base64, f.name, f.mime, 'pick'));                                          // main frame
      applyWebRef.current.injectJavaScript(relayToChildrenJs({ __cvfCmd: 'attach', keys: [filePick.key], b64: f.base64, filename: f.name, mime: f.mime, kind: 'pick' })); // + iframe(s)
      // result handled in onWebMessage (ATTACHED kind 'pick'). Fallback if no frame reports back:
      if (attachTimerRef.current) clearTimeout(attachTimerRef.current);
      attachTimerRef.current = setTimeout(() => {
        attachTimerRef.current = null; setFilePickBusy(null); setFilePick(null);
        Alert.alert("Couldn't attach here", 'This upload field blocked the attachment. Tap “Choose from device” and pick the file yourself.');
      }, 4500);
    } catch {
      setFilePickBusy(null);
      Alert.alert('Error', 'Could not attach the file. Try “Choose from device”.');
    }
  };

  // Render a real IMAGE preview (PDFs don't reliably render in a WebView via data: URIs).
  // Reuses the same preview-templates endpoints the Resume Builder / Cover Letter pickers use.
  const openPreview = async (kind: 'resume' | 'coverLetter', region: string) => {
    setPreviewBusy(kind + ':' + region);
    try {
      const token = await getToken();
      const rgn = region === 'generic' ? 'generic' : region;
      let path = '', body: any = {};
      if (kind === 'resume') {
        path = '/resume-builder/preview-templates';
        body = { region: rgn };
      } else {
        if (!coverLetterHtml) { Alert.alert('Not available', 'Generate a cover letter for this job first.'); return; }
        path = '/cover-letter/preview-templates';
        body = { region: rgn, coverLetterHtml, companyName: companyNameCL || employer.name, companyAddress: companyAddressCL || '' };
      }
      // No Resume-Builder resume means no template to render — but the user still has a resume, and
      // it is the one we will attach. Show THAT instead of refusing: it is the more useful answer to
      // "what am I about to send?" anyway.
      const previewActualFile = async (): Promise<boolean> => {
        if (kind !== 'resume') return false;
        try {
          const f = await loadFile('resume', region);
          if (!f?.base64) return false;
          const ext = /officedocument|msword/i.test(String(f.mime || '')) ? '.docx' : '.pdf';
          const file = new FSFile(Paths.cache, `cvapplyr_resume_preview${ext}`);
          try { if (file.exists) file.delete(); } catch {}
          file.create({ overwrite: true });
          file.write(f.base64, { encoding: 'base64' });
          setPreview({
            fileUri: file.uri,
            mime: String(f.mime || 'application/pdf'),
            title: 'Resume preview',
            ratio: 0.72,
            note: 'This is the resume that will be attached.',
          });
          return true;
        } catch { return false; }
      };
      const unavailable = async () => {
        if (await previewActualFile()) return;
        Alert.alert(
          'Preview unavailable',
          kind === 'resume'
            ? 'We couldn’t render your resume right now. Your uploaded resume will still be attached.'
            : 'Could not render the cover-letter preview.',
        );
      };
      // Rendered as a background job — survives the app being minimized.
      let data: any;
      try { data = await postAndPoll(path, body, token); }
      catch { await unavailable(); return; }
      const p = data?.previews?.[0];
      if (!p?.image) { await unavailable(); return; }
      const ratio = p.width && p.height ? p.width / p.height : 0.72;
      setPreview({ image: p.image, title: kind === 'resume' ? 'Resume preview' : 'Cover letter preview', ratio });
    } catch {
      Alert.alert('Error', 'Could not load the preview.');
    } finally {
      setPreviewBusy(null);
    }
  };

  const pickFromDevice = () => {
    if (!filePick || !applyWebRef.current) return;
    const k = filePick.key;
    // Manual "Upload" from the dock ('__manual__') has no tapped field → open the first file input.
    applyWebRef.current.injectJavaScript(`(function(){ try{ var el=document.querySelector('[data-cvf="'+${JSON.stringify(k)}+'"]') || document.querySelector('input[type=file]'); if(el){ el.__cvfSkip=true; el.click(); } else { window.ReactNativeWebView.postMessage(JSON.stringify({__cvf:true,type:'ATTACHED',kind:'pick',ok:0,total:0,noField:true})); } }catch(e){} })(); true;`);
    setFilePick(null);
  };

  // Reusable full-screen preview overlay. Rendered inside whichever modal is open (apply web
  // view OR the email compose sheet), because iOS won't stack a second fullScreen Modal.
  const renderPreviewOverlay = () => {
    if (!preview) return null;
    return (
      // Absolutely positioned → does NOT inherit the parent's paddingTop, so pad the overlay
      // itself by the safe-area inset (header sits below the Dynamic Island, bg fills the notch).
      <View style={[s.previewOverlay, { paddingTop: insets.top }]}>
        <View style={s.webHeader}>
          <TouchableOpacity onPress={() => setPreview(null)} style={s.webHeaderBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} activeOpacity={0.7}>
            <Ionicons name="close" size={22} color={T.ink} />
          </TouchableOpacity>
          <View style={s.webHeaderCenter}><Text style={s.webHeaderTitle} numberOfLines={1}>{preview.title || 'Preview'}</Text></View>
          <View style={{ width: 36 }} />
        </View>
        {!!preview.note && (
          <View style={s.previewNote}>
            <Ionicons name="information-circle-outline" size={14} color="#2563EB" />
            <Text style={s.previewNoteTx} numberOfLines={2}>{preview.note}</Text>
          </View>
        )}
        {preview.fileUri ? (
          // The real attachment. iOS renders PDFs natively in a WebView; if a format can't be shown
          // the user still has "Open in your app" below rather than a dead end.
          <View style={{ flex: 1 }}>
            <WebView
              source={{ uri: preview.fileUri }}
              style={{ flex: 1, backgroundColor: '#fff' }}
              originWhitelist={['*']}
              allowFileAccess
              allowFileAccessFromFileURLs
              allowUniversalAccessFromFileURLs
              startInLoadingState
            />
            <TouchableOpacity
              style={[s.previewOpenBtn, { marginBottom: 12 + insets.bottom }]}
              activeOpacity={0.85}
              onPress={() => { const u = preview.fileUri; if (u) { void (async () => { try { if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(u); } catch {} })(); } }}
            >
              <Ionicons name="open-outline" size={16} color="#fff" />
              <Text style={s.previewOpenTx}>Open in another app</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ScrollView
            style={s.previewScroll}
            contentContainerStyle={[s.previewScrollContent, { paddingBottom: 24 + insets.bottom }]}
            maximumZoomScale={3}
            minimumZoomScale={1}
            showsVerticalScrollIndicator
          >
            <Image
              source={{ uri: preview.image }}
              style={{ width: '100%', aspectRatio: preview.ratio || 0.72, backgroundColor: '#fff' }}
              resizeMode="contain"
            />
          </ScrollView>
        )}
      </View>
    );
  };

  // ── Open compose modal: pre-fill all fields, auto-generate CL if missing ──
  // `prefill` lets an apply-by-email (mailto:) link inject the recipient/subject the page specified;
  // existing callers pass nothing → today's contact-derived defaults.
  const openComposeModal = async (prefill?: { to?: string; cc?: string; bcc?: string; subject?: string }) => {
    // Contacts → To field
    const contactEmails = (contacts || []).map(c => c.email).filter(Boolean).join(', ');
    setComposeTo(prefill?.to || contactEmails);
    setComposeCc(prefill?.cc || '');
    setComposeBcc(prefill?.bcc || '');
    setCcExpanded(!!(prefill?.cc || prefill?.bcc));
    // Both region docs are attached by default; user can remove/change in the modal.
    // (The cover-letter chip's JSX is gated on coverLetterHtml, so default this ON; if the CL was
    // just generated, the stale `coverLetterHtml` closure value here would otherwise hide it.)
    setMailResumeOn(true); setMailCoverOn(true);
    setMailEditResume(false); setMailEditCover(false);
    setPreview(null); setPreviewBusy(null);   // never carry a stale preview overlay into a fresh modal

    const cName  = companyNameCL || employer.name;
    const webUrl = websiteUrlCL || employerWebsite;

    // Subject — same formula as emailController
    const token = await getToken();
    let fullName = 'Applicant';
    try {
      const raw = await SecureStore.getItemAsync('userSession');
      fullName = JSON.parse(raw || '{}')?.fullName || JSON.parse(raw || '{}')?.full_name || fullName;
    } catch {}
    setComposeSubject(prefill?.subject || `Application for ${job.title} - ${fullName}`);

    // Body — call backend generateEmailBody equivalent via API
    setComposeBody('Loading email body…');
    try {
      // Background job (AI) — survives minimize; falls back to a template on any failure.
      const data = await postAndPoll('/ai-hub/generate-email-body', { position: job.title, companyName: cName }, token);
      if (data && typeof data.body === 'string') {
        setComposeBody(data.body || '');
      } else {
        setComposeBody(
          `Dear Hiring Manager,\n\nI am excited to submit my application for the ${job.title} role at ${cName}. Please find my resume and cover letter attached for your consideration.\n\nI would love the opportunity to discuss how my background aligns with your team's needs.\n\nBest regards,\n${fullName}`
        );
      }
    } catch {
      setComposeBody(
        `Dear Hiring Manager,\n\nI am excited to submit my application for the ${job.title} role at ${cName}. Please find my resume and cover letter attached for your consideration.\n\nI would love the opportunity to discuss how my background aligns with your team's needs.\n\nBest regards,\n${fullName}`
      );
    }

    setSendState('idle');
    setComposeVisible(true);
  };

  // The page's Apply button is a mailto: link. Instead of bouncing the user out to the system
  // Mail/Gmail app, open OUR in-app compose flow prefilled with the recipient (+ the generated cover
  // letter / résumé attachments). We dismiss the full-screen apply WebView FIRST — iOS is flaky about
  // presenting a Modal over a fullScreen Modal — then present compose after it settles.
  // A mailto: could be the real apply action OR an incidental footer "contact us" link — and this
  // TEARS DOWN the WebView (losing typed input) and generates a cover letter (a credit). So CONFIRM
  // first, and NEVER honour a page-supplied cc/bcc (the page shouldn't dictate hidden recipients on an
  // email that carries the user's résumé + PII — only its `to` and `subject`).
  const handleMailtoApply = (rawUrl: string) => {
    const p = parseMailto(rawUrl);
    const to = p.to || 'this address';
    Alert.alert(
      'Apply by email?',
      `This opens your in-app email to ${to} with your résumé and cover letter attached. You can review and edit before sending.`,
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Continue', onPress: async () => {
          setApplyWebUrl(null);
          setMailPrep('loading');
          try {
            if (!coverLetterHtml) {
              const html = await handleGenerateCoverLetter();
              if (!html) return;   // generation failed and already alerted
            }
            await new Promise((r) => setTimeout(r, 380));   // let the full-screen modal finish dismissing
            await openComposeModal({ to: p.to, subject: p.subject });   // page cc/bcc deliberately ignored
          } finally { setMailPrep('idle'); }
        } },
      ],
    );
  };

  // ── "Apply via Mail": show in-button progress, ensure a cover letter exists, then open compose. ──
  const applyViaMail = async () => {
    if (mailPrep === 'loading' || clState === 'loading') return;
    setMailPrep('loading');
    try {
      if (!coverLetterHtml) {
        const html = await handleGenerateCoverLetter();   // generates + persists; returns html
        if (!html) return;                                 // failed — handleGenerate already alerted
      }
      await openComposeModal();
    } finally {
      setMailPrep('idle');
    }
  };

  // ── Poll for async job completion ──
  function pollJob(
    jobId: string,
    token: string | null,
    onDone: (data: any) => void,
    onFail: (msg: string) => void,
  ) {
    const poll = async () => {
      try {
        const hdrs: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        const { default: ax } = await import('axios');
        const { data } = await ax.get(`${API_BASE}/job-status/${jobId}`, { headers: hdrs });
        if (data.status === 'completed') onDone(data.data ?? data.result ?? data);
        else if (data.status === 'failed') onFail(data.error || 'Send failed');
        else setTimeout(poll, 2000);
      } catch { setTimeout(poll, 2000); }
    };
    poll();
  }

  // ── Send the email via the same /send-single-application endpoint ──
  const handleSendEmail = async () => {
    if (sendState === 'loading' || sendState === 'done') return;
    if (!composeTo.trim()) {
      Alert.alert('No recipient', 'Please enter a To email address.');
      return;
    }
    if (!coverLetterHtml) {
      Alert.alert('No cover letter', 'Please generate a cover letter first.');
      return;
    }
    setSendState('loading');

    try {
      const token = await getToken();
      const hdrs: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      const cName  = companyNameCL || employer.name;
      const webUrl = websiteUrlCL || employerWebsite;

      // Send to first To address (primary contact); cc addresses sent separately if needed
      const primaryEmail = composeTo.split(',')[0].trim();

      const res = await fetch(`${API_BASE}/send-single-application`, {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({
          recipientEmail: primaryEmail,
          websiteUrl: webUrl,
          position: job.title,
          coverLetterText: coverLetterHtml,
          companyName: cName,
          companyAddress: companyAddressCL,
          // Region-specific attachments (same as the apply-page preview) + per-file include flags.
          resumeRegion: effResumeRegion,
          coverLetterRegion: effClRegion,
          includeResume: mailResumeOn,
          includeCoverLetter: mailCoverOn,
        }),
      });

      const finish = (success: boolean, errMsg?: string) => {
        if (success) {
          setSendState('done');
          updateJobCLStatus(jid, 'applied');
          setTimeout(() => {
            setComposeVisible(false);
            setTimeout(() => setSendState('idle'), 400);
            setTimeout(() => { rating.ask('apply_email'); }, 700);   // ask for a rating after the email is sent
          }, 1200);
          Alert.alert('Sent! 🎉', `Your application has been sent to ${cName}.`);
        } else {
          setSendState('idle');
          Alert.alert('Send failed', errMsg || 'Could not send. Please try again.');
        }
      };

      if (res.status === 202) {
        const { jobId } = await res.json();
        pollJob(jobId, token,
          (d) => finish(!d || d.success === false ? false : true, d?.error),
          (msg) => finish(false, msg),
        );
      } else if (res.ok) {
        finish(true);
      } else {
        const err = await res.json().catch(() => ({}));
        finish(false, err.message || err.error || `Server error ${res.status}`);
      }
    } catch (e: any) {
      setSendState('idle');
      Alert.alert('Send failed', 'Network error. Please check your connection.');
    }
  };

  const handleEdit = async () => {
    if (!coverLetterHtml) return;
    try {
      const websiteUrl = websiteUrlCL || employerWebsite;
      // Store the CL payload — HomeScreen's 800ms poll picks this up.
      // Use the first verified contact's email, else first contact's email, else BLANK
      // (blank → the send-flow validation forces the user to add a real email).
      const recipientEmail = contacts.find(c => c.verified)?.email
        || contacts[0]?.email
        || '';

      await AsyncStorage.setItem('aiHub_add_recipient_with_cl', JSON.stringify({
        website: websiteUrl,
        position: job.title,
        coverLetterHtml,
        companyName: companyNameCL || employer.name,
        companyAddress: companyAddressCL || '',
        companyLocations: companyLocations.length > 0 ? companyLocations : [],
        recipientEmail,
      }));
      // Step 1: mark relay flag so (ai-hub)/index pops itself on focus
      await AsyncStorage.setItem('aiHub_navigate_home', 'true');
      // Step 2: go back to (ai-hub)/index (which will call router.back() again)
      // App.js polls for aiHub_add_recipient_with_cl and navigates to Letters page
      router.back();
    } catch (e) {
      console.warn('[handleEdit] failed:', e);
    }
  };

  return (
    <SafeAreaView style={s.safeArea} edges={['top']}>
      {/* Hidden LinkedIn extractor — loads the LinkedIn job in an off-screen WebView on the user's
          device (real session/IP/fingerprint → bypasses the 999 wall) and enriches this job silently. */}
      {liUrl ? (
        <LinkedInJobLoader
          url={liUrl}
          onResult={(j) => { setLiJob(j); setLiUrl(''); setLiStage(''); }}
          onError={() => { setLiUrl(''); setLiStage(''); }}
          onStage={setLiStage}
        />
      ) : null}
      {/* Top bar — matches jobs dashboard exactly */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={s.backPill} activeOpacity={0.8}>
          <Ionicons name="arrow-back" size={14} color={T.ink} />
          <Text style={s.backPillText}>Back</Text>
        </TouchableOpacity>

        {/* Absolutely centred logo + wordmark */}
        <View style={s.wordmark} pointerEvents="none">
          <Image
            source={require('../../assets/images/logo_img.png')}
            style={s.wordmarkLogo}
            resizeMode="contain"
          />
          <Text style={s.wordmarkText}>cv<Text style={s.wordmarkBlue}>applyr</Text></Text>
        </View>

        {!!effectiveApplyUrl ? (
          <TouchableOpacity onPress={() => openApplyWebView(effectiveApplyUrl)} style={s.viewBtn} activeOpacity={0.8}>
            <Ionicons name="open-outline" size={14} color={T.blue} />
            <Text style={s.viewBtnText}>Open</Text>
          </TouchableOpacity>
        ) : (
          <View style={{ width: 60 }} />
        )}
      </View>

      <ScrollView style={s.scroll} showsVerticalScrollIndicator={false} contentContainerStyle={s.scrollContent}>

        {/* ── Card 1: Job Header (dark) ── */}
        <View style={s.heroCard}>
          {/* Watermark — lightly visible grey */}
          <Text style={s.watermark} numberOfLines={1} ellipsizeMode="clip">
            {employer.name.toUpperCase()}
          </Text>

          {typeof job.matchScore === 'number' && job.matchScore >= 0 && (
            <View style={[s.matchBadge, {
              backgroundColor: job.matchScore >= 70 ? 'rgba(16,185,129,0.22)'
                : job.matchScore >= 40 ? 'rgba(251,146,60,0.22)'
                : 'rgba(148,163,184,0.22)',
            }]}>
              <Text style={[s.matchBadgeText, {
                color: job.matchScore >= 70 ? '#34D399'
                  : job.matchScore >= 40 ? '#FB923C'
                  : '#CBD5E1',
              }]}>{job.matchScore}% match</Text>
            </View>
          )}

          <View style={s.heroTop}>
            <LinearGradient colors={employer.logoColor} style={s.logoBox}>
              <Text style={s.logoInitial}>{employer.logoInitial}</Text>
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <Text style={s.employerName}>{employer.name}</Text>
              {!!employer.subInfo && <Text style={s.employerSub}>{employer.subInfo}</Text>}
            </View>
            {job.urgent && (
              <View style={s.urgentBadge}>
                <Ionicons name="flash" size={10} color="#FF4E64" />
                <Text style={s.urgentText}>Urgent</Text>
              </View>
            )}
          </View>

          <Text style={s.jobTitle}>{display.title}</Text>

          {/* Meta chips — dark style */}
          <View style={s.metaRow}>
            {!!display.location && (
              <View style={s.metaChip}>
                <Ionicons name="location-outline" size={11} color="#06B6D4" />
                <Text style={s.metaChipText}>{display.location}</Text>
              </View>
            )}
            {!!display.experience && (
              <View style={s.metaChip}>
                <Ionicons name="time-outline" size={11} color="#A78BFA" />
                <Text style={s.metaChipText}>{display.experience}</Text>
              </View>
            )}
            {!!display.salary && display.salary !== 'Not listed' && (
              <View style={s.metaChip}>
                <Ionicons name="cash-outline" size={11} color="#34D399" />
                <Text style={s.metaChipText}>{display.salary}</Text>
              </View>
            )}
            {!!display.jobType && (
              <View style={s.metaChip}>
                <Ionicons name="briefcase-outline" size={11} color="#FB923C" />
                <Text style={s.metaChipText}>{display.jobType}</Text>
              </View>
            )}
            {!!display.workMode && (
              <View style={s.metaChip}>
                <Ionicons name="business-outline" size={11} color="#22D3EE" />
                <Text style={s.metaChipText}>{display.workMode}</Text>
              </View>
            )}
          </View>

          {/* Translate — bottom-right of the hero, clear of the top-right match badge */}
          {canTranslate && (
            <View style={s.heroTranslateRow}>
              <TouchableOpacity onPress={onTranslate} disabled={translatingJob} activeOpacity={0.85} style={[s.translatePill, showEnglish && s.translatePillActive]}>
                {translatingJob ? (
                  <ActivityIndicator size="small" color={showEnglish ? '#fff' : '#06B6D4'} />
                ) : (
                  <>
                    <Ionicons name="language" size={12} color={showEnglish ? '#fff' : '#06B6D4'} />
                    <Text style={[s.translatePillText, showEnglish && s.translatePillTextActive]}>{showEnglish ? 'English' : 'Translate'}</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* ── Card 2: Hiring Contacts ── */}
        <View style={s.card}>
          <View style={s.cardHead}>
            <View style={[s.cardHeadIcon, { backgroundColor: 'rgba(79,141,255,0.12)' }]}>
              <Ionicons name="people" size={17} color={T.blue} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardHeadTitle}>Hiring Contacts</Text>
              <Text style={s.cardHeadSub}>
                {contacts.length > 0 ? 'Who your application will be sent to' : 'Add a recipient so you can apply by email'}
              </Text>
            </View>
          </View>

          {contacts.length > 0
            ? contacts.map(c => <ContactRow key={c.id} contact={c} />)
            : <Text style={s.noContacts}>No contact details found for this listing</Text>
          }
          <TouchableOpacity
            onPress={() => router.push({ pathname: '/(ai-hub)/add-contact', params: { jobId: job.id } })}
            style={s.addContactBtn}
          >
            <Ionicons name="person-add-outline" size={14} color={T.blue} />
            <Text style={s.addContactBtnText}>Add Contact</Text>
          </TouchableOpacity>
        </View>

        {/* ── Card 2b: AI Cover Letter ── */}
        <View style={s.card}>
          <View style={s.cardHead}>
            <View style={[s.cardHeadIcon, { backgroundColor: 'rgba(124,107,255,0.12)' }]}>
              <Ionicons name="sparkles" size={16} color="#7C6BFF" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardHeadTitle}>AI Cover Letter</Text>
              <Text style={s.cardHeadSub}>Generate a letter tailored to this role. Once it's ready you can download it as a PDF or edit the wording — it's attached automatically when you apply.</Text>
            </View>
          </View>

          {clState !== 'done' ? (
            <GenerateCLButton
              state={clState}
              progress={clProgress}
              progressAnim={clAnim}
              label={clLabel}
              onPress={handleGenerateCoverLetter}
            />
          ) : (
            <>
            {/* All three actions on one line: Generated (big) + Download (icon) + Edit (icon). */}
            <View style={s.clActionRow}>
              <View style={{ flex: 1 }}>
                <GenerateCLButton
                  state={clState}
                  progress={clProgress}
                  progressAnim={clAnim}
                  label={clLabel}
                  onPress={handleGenerateCoverLetter}
                />
              </View>
              <DownloadIconButton state={dlState} progressAnim={dlAnim} onPress={handleDownloadPdf} />
              <TouchableOpacity style={s.editIconBtn} onPress={handleEdit} activeOpacity={0.82}>
                <Ionicons name="create-outline" size={18} color={T.blue} />
              </TouchableOpacity>
            </View>
            {/* Office address used on the letter (PDF + email). Tap to change it — persists here. */}
            {(companyAddressCL || companyLocations.length > 0) ? (
              <TouchableOpacity
                style={s.officeRow}
                activeOpacity={0.8}
                disabled={companyLocations.length <= 1}
                onPress={() => companyLocations.length > 1 && setShowOfficePicker(true)}
              >
                <Ionicons name="business-outline" size={15} color={T.textMuted} />
                <View style={{ flex: 1 }}>
                  <Text style={s.officeLabel}>OFFICE ON THE LETTER</Text>
                  <Text style={s.officeValue} numberOfLines={2}>{companyAddressCL || 'Not set'}</Text>
                </View>
                {companyLocations.length > 1 ? <Ionicons name="chevron-down" size={16} color={T.textMuted} /> : null}
              </TouchableOpacity>
            ) : null}
            </>
          )}

          <Modal visible={showOfficePicker} transparent animationType="fade" onRequestClose={() => setShowOfficePicker(false)}>
            <TouchableOpacity style={s.officeOverlay} activeOpacity={1} onPress={() => setShowOfficePicker(false)}>
              <View style={s.officeMenu}>
                <Text style={s.officeMenuTitle}>Choose the office address</Text>
                <ScrollView>
                  {companyLocations.map((loc, idx) => {
                    const label = fmtLocation(loc);
                    if (!label) return null;
                    const active = label === companyAddressCL;
                    return (
                      <TouchableOpacity key={idx} style={[s.officeItem, active ? s.officeItemActive : null]} activeOpacity={0.8} onPress={() => pickOffice(loc)}>
                        <Text style={s.officeItemText} numberOfLines={2}>{label}{loc.isHeadquarters ? '  (HQ)' : ''}</Text>
                        {active ? <Ionicons name="checkmark" size={16} color={T.blue} /> : null}
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            </TouchableOpacity>
          </Modal>
        </View>

        {/* ── Card 3: Skills ── */}
        {allSkills.length > 0 && (
          <View style={s.card}>
            <Text style={s.sectionLabel}>REQUIRED SKILLS</Text>
            <View style={s.skillsRow}>
              {visibleSkills.map((skill: string, i: number) => (
                <View key={i} style={s.skillChip}>
                  <Text style={s.skillChipText}>{skill}</Text>
                </View>
              ))}
              {!skillsExpanded && allSkills.length > SKILLS_LIMIT && (
                <TouchableOpacity onPress={() => setSkillsExpanded(true)} style={s.skillMore} activeOpacity={0.75}>
                  <Text style={s.skillMoreText}>+{allSkills.length - SKILLS_LIMIT} more</Text>
                </TouchableOpacity>
              )}
              {skillsExpanded && allSkills.length > SKILLS_LIMIT && (
                <TouchableOpacity onPress={() => setSkillsExpanded(false)} style={s.skillMore} activeOpacity={0.75}>
                  <Ionicons name="chevron-up" size={11} color={T.textMuted} />
                  <Text style={s.skillMoreText}>Less</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* ── Card 4: Responsibilities ── */}
        {(display.responsibilities?.length > 0) && (
          <View style={s.card}>
            <Text style={s.sectionLabel}>RESPONSIBILITIES</Text>
            {(display.responsibilities as string[]).map((item, i) => (
              <View key={i} style={s.respRow}>
                <View style={s.respDot} />
                <Text style={s.respText}>{item}</Text>
              </View>
            ))}
          </View>
        )}

        {/* ── Card 5: Editable apply link ── */}
        <View style={s.card}>
          <View style={s.cardHead}>
            <View style={[s.cardHeadIcon, { backgroundColor: 'rgba(16,185,129,0.12)' }]}>
              <Ionicons name="link-outline" size={17} color={T.emerald} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardHeadTitle}>Apply link</Text>
              <Text style={s.cardHeadSub}>Opens when you tap Apply</Text>
            </View>
          </View>

          <Text style={s.urlCurrent} numberOfLines={2}>
            {effectiveApplyUrl || 'No apply link yet — add one below'}
          </Text>

          <View style={s.urlInputWrap}>
            <TextInput
              style={s.fieldInput}
              value={urlInput}
              onChangeText={setUrlInput}
              placeholder="https://… paste the real job link"
              placeholderTextColor={T.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>

          <TouchableOpacity
            onPress={handleSaveUrl}
            disabled={savingUrl || !urlInput.trim() || urlInput.trim() === (effectiveApplyUrl || '')}
            style={[
              s.saveUrlBtn,
              (savingUrl || !urlInput.trim() || urlInput.trim() === (effectiveApplyUrl || '')) && s.saveUrlBtnDisabled,
            ]}
            activeOpacity={0.85}
          >
            {savingUrl
              ? <ActivityIndicator size="small" color={T.blue} />
              : <><Ionicons name="save-outline" size={14} color={T.blue} /><Text style={s.saveUrlBtnText}>Save link</Text></>}
          </TouchableOpacity>

          <Text style={s.urlExplainer}>
            Some job links are auto-detected and can be wrong or missing. Since you can apply
            right here in CVApplyr — with autofill, your résumé, and AI cover letters — just
            paste the correct job link (or add one if it's missing) and we'll open the right page.
          </Text>
        </View>


      </ScrollView>

      {/* ── Sticky Footer: Apply on Portal + Apply via Mail ── */}
      <View style={s.footer}>
        <TouchableOpacity
          activeOpacity={0.85}
          style={[s.applyOuter, { flex: 1 }]}
          onPress={() => openApplyWebView(effectiveApplyUrl)}
          disabled={mailPrep === 'loading'}
        >
          <View style={s.portalBtn}>
            <Ionicons name="globe-outline" size={16} color={T.blue} />
            <Text style={s.portalBtnText} numberOfLines={1}>Apply on Portal</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          activeOpacity={0.85}
          style={[s.applyOuter, { flex: 1 }]}
          onPress={applyViaMail}
          disabled={mailPrep === 'loading'}
        >
          <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.applyBtn}>
            {mailPrep === 'loading'
              ? <MailPrepContent />
              : (<><Ionicons name="mail-outline" size={15} color="white" /><Text style={s.applyBtnText} numberOfLines={1}>Apply via Mail</Text></>)}
          </LinearGradient>
        </TouchableOpacity>
      </View>

      {/* ── Email Compose Modal ── */}
      <Modal
        visible={composeVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setComposeVisible(false)}
      >
        <KeyboardAvoidingView
          style={s.modalOverlay}
          behavior={Platform.select({ ios: 'padding', android: undefined })}
        >
          <View style={s.modalSheet}>
            {/* Handle bar */}
            <View style={s.modalHandle} />

            {/* Header */}
            <View style={s.modalHeader}>
              <View style={{ flex: 1, marginRight: 10 }}>
                <Text style={s.modalTitle} numberOfLines={1}>New Application ({companyNameCL || employer.name})</Text>
                <Text style={s.modalSubtitle} numberOfLines={1}>{job.title}</Text>
              </View>
              <TouchableOpacity onPress={() => setComposeVisible(false)} style={s.modalCloseBtn} activeOpacity={0.7}>
                <Ionicons name="close" size={18} color={T.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView style={s.modalScroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

              {/* To */}
              <View style={s.fieldRow}>
                <Text style={s.fieldLabel}>To</Text>
                <TextInput
                  style={s.fieldInput}
                  value={composeTo}
                  onChangeText={setComposeTo}
                  placeholder="Recipient email(s)"
                  placeholderTextColor={T.textFaint}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
              </View>

              {/* Cc/Bcc toggle */}
              <TouchableOpacity style={s.ccToggle} onPress={() => setCcExpanded(v => !v)} activeOpacity={0.7}>
                <Text style={s.ccToggleText}>{ccExpanded ? '▴ Hide Cc / Bcc' : '▾ Add Cc / Bcc'}</Text>
              </TouchableOpacity>

              {ccExpanded && (
                <>
                  <View style={s.fieldRow}>
                    <Text style={s.fieldLabel}>Cc</Text>
                    <TextInput
                      style={s.fieldInput}
                      value={composeCc}
                      onChangeText={setComposeCc}
                      placeholder="Cc email(s)"
                      placeholderTextColor={T.textFaint}
                      keyboardType="email-address"
                      autoCapitalize="none"
                    />
                  </View>
                  <View style={s.fieldRow}>
                    <Text style={s.fieldLabel}>Bcc</Text>
                    <TextInput
                      style={s.fieldInput}
                      value={composeBcc}
                      onChangeText={setComposeBcc}
                      placeholder="Bcc email(s)"
                      placeholderTextColor={T.textFaint}
                      keyboardType="email-address"
                      autoCapitalize="none"
                    />
                  </View>
                </>
              )}

              {/* Subject */}
              <View style={s.fieldRow}>
                <Text style={s.fieldLabel}>Subject</Text>
                <TextInput
                  style={s.fieldInput}
                  value={composeSubject}
                  onChangeText={setComposeSubject}
                  placeholder="Email subject"
                  placeholderTextColor={T.textFaint}
                />
              </View>

              {/* Attachments — both region docs auto-attached; removable; region changeable */}
              <Text style={s.attachSectionLabel}>ATTACHMENTS</Text>

              {/* Resume */}
              {mailResumeOn ? (
                <View style={s.mailAttach}>
                  <View style={s.mailAttachMain}>
                    <View style={[s.mailAttachIconBox, { backgroundColor: 'rgba(79,141,255,0.12)' }]}>
                      <Ionicons name="document-text" size={16} color={T.blue} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.mailAttachName} numberOfLines={1}>Resume</Text>
                      <Text style={s.mailAttachMeta}>{regionLabel(effResumeRegion)}</Text>
                    </View>
                    <TouchableOpacity onPress={() => openPreview('resume', effResumeRegion)} disabled={!!previewBusy} style={s.mailAttachBtn} activeOpacity={0.7}>
                      {previewBusy === 'resume:' + effResumeRegion ? <ActivityIndicator size="small" color={T.blue} /> : <Ionicons name="eye-outline" size={18} color={T.blue} />}
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => { setMailEditResume(v => !v); setMailEditCover(false); }} style={s.mailAttachBtn} activeOpacity={0.7}>
                      <Ionicons name={mailEditResume ? 'chevron-up' : 'options-outline'} size={18} color={T.textMuted} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setMailResumeOn(false)} style={s.mailAttachBtn} activeOpacity={0.7}>
                      <Ionicons name="close-circle" size={19} color={T.textFaint} />
                    </TouchableOpacity>
                  </View>
                  {mailEditResume && (
                    <View style={s.mailChipWrap}>
                      {RESUME_REGION_OPTIONS.map((opt) => (
                        <TouchableOpacity key={opt.id} style={[s.regionChip, effResumeRegion === opt.id && s.regionChipSel]} activeOpacity={0.8} onPress={() => { setResumeRegion(opt.id); setMailEditResume(false); }}>
                          <Text style={[s.regionChipText, effResumeRegion === opt.id && s.regionChipTextSel]}>{opt.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </View>
              ) : (
                <TouchableOpacity style={s.mailAddBack} activeOpacity={0.8} onPress={() => setMailResumeOn(true)}>
                  <Ionicons name="add-circle-outline" size={17} color={T.blue} />
                  <Text style={s.mailAddBackText}>Attach resume</Text>
                </TouchableOpacity>
              )}

              {/* Cover letter (only when generated) */}
              {!!coverLetterHtml && (mailCoverOn ? (
                <View style={s.mailAttach}>
                  <View style={s.mailAttachMain}>
                    <View style={[s.mailAttachIconBox, { backgroundColor: 'rgba(124,107,255,0.12)' }]}>
                      <Ionicons name="mail" size={16} color="#7C6BFF" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.mailAttachName} numberOfLines={1}>Cover Letter</Text>
                      <Text style={s.mailAttachMeta}>{regionLabel(effClRegion)}</Text>
                    </View>
                    <TouchableOpacity onPress={() => openPreview('coverLetter', effClRegion)} disabled={!!previewBusy} style={s.mailAttachBtn} activeOpacity={0.7}>
                      {previewBusy === 'coverLetter:' + effClRegion ? <ActivityIndicator size="small" color={T.blue} /> : <Ionicons name="eye-outline" size={18} color={T.blue} />}
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => { setMailEditCover(v => !v); setMailEditResume(false); }} style={s.mailAttachBtn} activeOpacity={0.7}>
                      <Ionicons name={mailEditCover ? 'chevron-up' : 'options-outline'} size={18} color={T.textMuted} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setMailCoverOn(false)} style={s.mailAttachBtn} activeOpacity={0.7}>
                      <Ionicons name="close-circle" size={19} color={T.textFaint} />
                    </TouchableOpacity>
                  </View>
                  {mailEditCover && (
                    <View style={s.mailChipWrap}>
                      {REGION_OPTIONS.map((opt) => (
                        <TouchableOpacity key={opt.id} style={[s.regionChip, effClRegion === opt.id && s.regionChipSel]} activeOpacity={0.8} onPress={() => { setClRegion(opt.id); setMailEditCover(false); }}>
                          <Text style={[s.regionChipText, effClRegion === opt.id && s.regionChipTextSel]}>{opt.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </View>
              ) : (
                <TouchableOpacity style={s.mailAddBack} activeOpacity={0.8} onPress={() => setMailCoverOn(true)}>
                  <Ionicons name="add-circle-outline" size={17} color={T.blue} />
                  <Text style={s.mailAddBackText}>Attach cover letter</Text>
                </TouchableOpacity>
              ))}

              {/* Body */}
              <View style={s.bodyField}>
                <TextInput
                  style={s.bodyInput}
                  value={composeBody}
                  onChangeText={setComposeBody}
                  multiline
                  textAlignVertical="top"
                  placeholder="Email body…"
                  placeholderTextColor={T.textFaint}
                />
              </View>

            </ScrollView>

            {/* Action buttons */}
            <View style={s.modalFooter}>
              <TouchableOpacity style={s.cancelBtn} onPress={() => setComposeVisible(false)} activeOpacity={0.7}>
                <Text style={s.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[s.sendOuter, sendState === 'done' && s.sendOuterDone]}
                onPress={handleSendEmail}
                activeOpacity={0.85}
                disabled={sendState === 'loading' || sendState === 'done'}
              >
                <LinearGradient
                  colors={sendState === 'done' ? ['#10B981', '#059669'] : [T.blue, T.blueDeep]}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  style={s.sendBtn}
                >
                  {sendState === 'loading' ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : sendState === 'done' ? (
                    <>
                      <Ionicons name="checkmark-circle" size={16} color="#fff" />
                      <Text style={s.sendBtnText}>Sent!</Text>
                    </>
                  ) : (
                    <>
                      <Ionicons name="send" size={14} color="#fff" />
                      <Text style={s.sendBtnText}>Send Application</Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            </View>

          </View>

          {/* Attachment preview — drawn inside the compose modal so it shows above it */}
          {renderPreviewOverlay()}
        </KeyboardAvoidingView>
      </Modal>

      {/* ── In-app Apply Web View (slide-up) ── */}
      <Modal
        visible={!!applyWebUrl}
        animationType="slide"
        onRequestClose={closeApplyWebView}
        presentationStyle="fullScreen"
      >
        <View style={[s.webSafe, { paddingTop: insets.top }]}>
          {/* Header */}
          <View style={s.webHeader}>
            <TouchableOpacity onPress={closeApplyWebView} style={s.webHeaderBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} activeOpacity={0.7}>
              <Ionicons name="close" size={22} color={T.ink} />
            </TouchableOpacity>
            <View style={s.webHeaderCenter}>
              <Text style={s.webHeaderTitle} numberOfLines={1}>{companyNameCL || employer.name || 'Apply'}</Text>
              <View style={s.webHostRow}>
                <Ionicons name="lock-closed" size={9} color={T.textMuted} />
                <Text style={s.webHeaderHost} numberOfLines={1}>{applyHost}</Text>
              </View>
            </View>
            <TouchableOpacity onPress={toggleTranslate} style={[s.webHeaderBtn, webTranslated && s.webHeaderBtnActive]} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }} activeOpacity={0.7}>
              {webTranslating
                ? <ActivityIndicator size="small" color={T.blue} />
                : <Ionicons name="language" size={18} color={webTranslated ? '#fff' : T.textMuted} />}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => applyWebUrl && Linking.openURL(applyWebUrl)} style={s.webHeaderBtn} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }} activeOpacity={0.7}>
              <Ionicons name="open-outline" size={19} color={T.blue} />
            </TouchableOpacity>
          </View>

          {/* Thin progress bar while loading */}
          {applyLoading && (
            <View style={s.webProgressTrack}>
              <View style={[s.webProgressFill, { width: `${Math.max(8, Math.round(applyProgress * 100))}%` }]} />
            </View>
          )}

          {/* The page */}
          {!!applyWebUrl && (
            <WebView
              ref={applyWebRef}
              source={{ uri: applyWebUrl }}
              style={s.webView}
              originWhitelist={['*']}
              injectedJavaScript={FRAME_GUARD_JS + '\n' + AUTH_FLOW_JS + '\n' + XLATE_WATCH_JS + '\n' + INTERCEPT_FILES_JS + '\n' + SUBMIT_DETECT_JS + '\n' + FOCUS_DETECT_JS + '\n' + AUTODETECT_JS + '\n' + WIZARD_WATCH_JS + '\n' + FRAME_AGENT_JS}
              injectedJavaScriptForMainFrameOnly={false}
              javaScriptEnabled
              domStorageEnabled
              thirdPartyCookiesEnabled
              sharedCookiesEnabled
              allowFileAccess
              allowsInlineMediaPlayback
              // OAuth (Sign in with Google/LinkedIn/Apple) support — same fix as Browse & Fetch:
              // a clean browser UA (so LinkedIn/Google don't reject the embedded webview and leave
              // it spinning), popups allowed, and popup windows loaded IN THIS WebView (iOS drops
              // them by default → the "stuck on loading" the user hit). The shared cookie store means
              // a LinkedIn/Google login done here (or in the hidden extractor) is reused next time.
              userAgent={BROWSER_UA}
              javaScriptCanOpenWindowsAutomatically
              setSupportMultipleWindows={false}
              onOpenWindow={(e: any) => {
                const target = e?.nativeEvent?.targetUrl || '';
                if (/^mailto:/i.test(target)) { handleMailtoApply(target); return; }   // _blank mailto edge case
                if (target) beginAuthFlow(target);   // remembers the form so we can come back
              }}
              // Intercept non-http(s) schemes so an "Apply by email" (mailto:) button opens OUR in-app
              // compose flow instead of bouncing out to Gmail; tel/sms hand off to the OS. Everything
              // http(s) (autofill, translate, capture, submit-detect, OAuth) returns true → unchanged.
              onShouldStartLoadWithRequest={(req: any) => {
                const u = req?.url || '';
                if (/^mailto:/i.test(u)) { handleMailtoApply(u); return false; }
                if (/^(tel|sms|facetime|maps|geo):/i.test(u)) { Linking.openURL(u).catch(() => {}); return false; }
                return true;
              }}
              startInLoadingState
              pullToRefreshEnabled
              onMessage={onWebMessage}
              onLoadStart={() => { setApplyLoading(true); webLoadingRef.current = true; }}
              onLoadEnd={() => {
                setApplyLoading(false);
                // Grab the job page's visible text ONCE per session (the first load is the job
                // details page the user opened) → capture responsibilities for the cover letter.
                if (!capturePrefetchedRef.current && !isUuid(job.id) && applyWebRef.current) {
                  capturePrefetchedRef.current = true;
                  setTimeout(() => { try { applyWebRef.current?.injectJavaScript(GRAB_JOB_TEXT_JS); } catch {} }, 900);
                }
                webLoadingRef.current = false;
                // Re-apply translation to the freshly loaded document. This also flushes a tap that
                // happened WHILE the page was still loading (xlatePendingRef), which used to be lost.
                if (xlateOnRef.current || xlatePendingRef.current) {
                  xlatePendingRef.current = false;
                  setTimeout(() => runXlate('load'), 400);
                }
              }}
              onLoadProgress={({ nativeEvent }) => setApplyProgress(nativeEvent.progress)}
              onNavigationStateChange={(nav) => {
                setApplyCanGoBack(nav.canGoBack);
                if (nav.url) { currentUrlRef.current = nav.url; try { setApplyHost(new URL(nav.url).hostname.replace(/^www\./, '')); } catch {} }
                // Sign-in finished: we're back on the site's own origin, off the auth path. Give the
                // callback a beat to exchange its code, then return to the form. Once only.
                if (nav.url && preAuthUrlRef.current && authOriginRef.current && !nav.loading) {
                  let sameSite = false;
                  try { sameSite = new URL(nav.url).origin === authOriginRef.current; } catch {}
                  const settled = Date.now() - authAtRef.current > 2500;
                  if (sameSite && settled && !isAuthUrl(nav.url) && nav.url !== preAuthUrlRef.current) returnFromAuth(1200);
                }
                // ── LinkedIn → company-portal capture: the user tapped Apply on a LinkedIn page and
                // landed on the company's own site. Save that URL as this job's link (per-user
                // override) so Apply/Portal opens the company page DIRECTLY from now on.
                if (nav.url && /^https?:\/\//i.test(nav.url)) {
                  if (/linkedin\.com/i.test(nav.url)) {
                    sawLinkedInRef.current = true;
                  } else if (sawLinkedInRef.current && !portalCapturedRef.current && !NOT_PORTAL_RE.test(nav.url)
                             && !isAuthUrl(nav.url) && !AUTH_TOKEN_RE.test(nav.url) && !AUTH_PATH_RE.test(nav.url)
                             && (!overrideUrl || isLinkedInJobUrl(overrideUrl))) {
                    const jid = (job as any)?.id;
                    if (jid) {
                      portalCapturedRef.current = true;
                      const captured = nav.url;
                      updateJobUrl(jid, captured)
                        .then((saved) => { setOverrideUrl(saved); setUrlInput(saved); setPortalSavedBanner(true); })
                        .catch(() => { portalCapturedRef.current = false; });   // transient failure → retry on next hop
                    }
                  }
                }
                // Backstop: a real submit just happened and we navigated to a clear
                // confirmation URL (covers cross-origin pages that drop our injected state).
                // Same-origin ONLY. CONFIRM_URL_RE matches bare words like "success"/"submitted",
                // so an OAuth callback (…/auth/success?token=…) used to mark the job Applied.
                if (nav.url && !submitMarkedRef.current && submitIntentRef.current
                    && Date.now() - submitIntentRef.current < 120000 && CONFIRM_URL_RE.test(nav.url)) {
                  let sameOrigin = false;
                  try { sameOrigin = !!applyOriginRef.current && new URL(nav.url).origin === applyOriginRef.current; } catch {}
                  if (sameOrigin) markApplied();
                }
              }}
              renderLoading={() => (
                <View style={s.webLoading}>
                  <ActivityIndicator size="large" color={T.blue} />
                </View>
              )}
            />
          )}

          {/* LinkedIn → company portal captured → subtle toast (the job's link now opens the portal) */}
          {portalSavedBanner && !appliedBanner && (
            <View style={[s.appliedToast, { top: insets.top + 56 }]} pointerEvents="box-none">
              <View style={[s.appliedToastCard, { backgroundColor: '#2563EB' }]}>
                <Ionicons name="link" size={18} color="#fff" />
                <Text style={s.appliedToastText} numberOfLines={2}>Company apply page saved — this job now opens the portal directly.</Text>
                <TouchableOpacity onPress={() => setPortalSavedBanner(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close" size={17} color="rgba(255,255,255,0.85)" />
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Submission detected → confirmation toast (job is now "Applied" on the dashboard) */}
          {appliedBanner && (
            <View style={[s.appliedToast, { top: insets.top + 56 }]} pointerEvents="box-none">
              <View style={s.appliedToastCard}>
                <Ionicons name="checkmark-circle" size={20} color="#fff" />
                <Text style={s.appliedToastText} numberOfLines={2}>Application submitted — marked as Applied on your dashboard.</Text>
                <TouchableOpacity onPress={() => setAppliedBanner(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close" size={17} color="rgba(255,255,255,0.85)" />
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ── Floating "Job tools" robot dock — one control for Auto Fill / My details / Upload,
                consistent across Saved, My Jobs and live jobs (replaces the old Auto-Fill button +
                smart-copy FAB). A plain overlay (NOT a Modal — it lives inside the apply Modal). ── */}
          {autofillState !== 'running' && !smartOpen && !filePick && (
            <JobToolsDock
              bottomInset={insets.bottom}
              busy={fetchState === 'fetching'}
              busyLabel={fetchState === 'fetching' ? 'Saving this job…' : undefined}
              actions={[
                { key: 'fetch', icon: fetchState === 'saved' ? 'checkmark' : 'sparkles', label: fetchState === 'saved' ? 'Saved ✓' : 'Fetch job', sub: 'Save to CVApplyr', colors: ['#06B6D4', '#3B82F6'], onPress: fetchThisPage },
                { key: 'autofill', icon: 'flash', label: 'Auto Fill', sub: 'Fill the form', colors: ['#7C6BFF', '#4F8DFF'], onPress: startAutofill },
                { key: 'upload', icon: 'cloud-upload', label: 'Upload', sub: 'Résumé & cover', colors: ['#0EA5E9', '#2563EB'], onPress: () => setFilePick({ key: '__manual__', accept: '', label: 'Attach your résumé or cover letter' }) },
                { key: 'details', icon: 'copy-outline', label: 'My details', sub: 'Copy to a field', colors: ['#10B981', '#059669'], onPress: openSmart },
                // Always offer the phone's own browser: some sites simply behave better there.
                { key: 'browser', icon: 'open-outline', label: 'Open in browser', sub: 'Your phone’s browser', colors: ['#64748B', '#334155'], onPress: openCurrentInBrowser },
              ]}
            />
          )}

          {smartOpen && (() => {
            const items = buildSmartItems();
            const pk = primarySmartKey();
            const focused = focusedFieldRef.current;
            let primary: { key: string; label: string; value: string; multiline?: boolean } | null = null;
            if (pk === '__field__' && focused) {
              const v = smartValuesRef.current[focused.key] || '';
              primary = { key: '__field__', label: focused.label || 'Suggested answer', value: v, multiline: v.length > 60 };
            } else if (pk) {
              primary = items.find(it => it.key === pk) || null;
            }
            const rest = primary && primary.key !== '__field__' ? items.filter(it => it.key !== primary!.key) : items;
            const showAll = smartExpanded || !primary;
            return (
              <>
                <TouchableOpacity style={s.smartBackdrop} activeOpacity={1} onPress={() => setSmartOpen(false)} />
                <View style={[s.smartSheet, { paddingBottom: 12 + insets.bottom }]}>
                  <View style={s.smartHandle} />
                  <View style={s.smartHeader}>
                    <Ionicons name="sparkles" size={15} color={T.blue} />
                    <Text style={s.smartTitle}>Quick copy</Text>
                    <View style={{ flex: 1 }} />
                    <TouchableOpacity onPress={() => setSmartOpen(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Ionicons name="close" size={18} color={T.textMuted} />
                    </TouchableOpacity>
                  </View>
                  <ScrollView style={{ maxHeight: 380 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                    {items.length === 0 && (
                      <Text style={s.smartEmpty}>No saved details yet. Add your resume & profile, then your details appear here to copy.</Text>
                    )}
                    {primary && (
                      <View style={s.smartPrimaryWrap}>
                        <Text style={s.smartPrimaryHint}>For the field you tapped</Text>
                        {renderSmartRow(primary)}
                      </View>
                    )}
                    {!showAll && primary && (
                      <TouchableOpacity style={s.smartMoreBtn} onPress={() => setSmartExpanded(true)} activeOpacity={0.8}>
                        <Text style={s.smartMoreTxt}>See all details</Text>
                        <Ionicons name="chevron-down" size={15} color={T.blue} />
                      </TouchableOpacity>
                    )}
                    {showAll && rest.map(it => renderSmartRow(it))}
                  </ScrollView>
                </View>
              </>
            );
          })()}

          {/* Bottom nav (back / reload) — Auto Fill moved into the floating Job-tools dock. */}
          <View style={[s.webNav, { paddingBottom: 9 + insets.bottom }]}>
            <View style={s.webNavGroup}>
              <TouchableOpacity disabled={!applyCanGoBack} onPress={() => applyWebRef.current?.goBack()} style={s.webNavBtn} activeOpacity={0.7}>
                <Ionicons name="chevron-back" size={21} color={applyCanGoBack ? T.ink : T.textFaint} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => applyWebRef.current?.reload()} style={s.webNavBtn} activeOpacity={0.7}>
                <Ionicons name="reload" size={16} color={T.ink} />
              </TouchableOpacity>
            </View>
            <View style={s.webNavHint}>
              <Ionicons name="arrow-forward" size={13} color={T.textMuted} />
              <Text style={s.webNavHintTx}>Tap the robot for Auto Fill, Upload & your details</Text>
            </View>
          </View>

          {/* Intelligent processing overlay — per-step status reflects REAL outcomes */}
          {!!autofillState && (
            <View style={s.afOverlay}>
              <View style={s.afCard}>
                <LinearGradient
                  colors={autofillState === 'error' ? ['#EF4444', '#DC2626'] : autofillState === 'done' ? [T.emerald, '#059669'] : ['#7C6BFF', '#4F8DFF']}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.afIcon}
                >
                  <Ionicons name={autofillState === 'done' ? 'checkmark' : autofillState === 'error' ? 'alert' : 'sparkles'} size={26} color="#fff" />
                </LinearGradient>
                <Text style={s.afTitle}>
                  {autofillState === 'done'
                    // On a multi-step form "Done — review & submit" is a lie: it's done with THIS step.
                    ? (wizardUi && !(wizardUi.n > 0 && wizardUi.i >= wizardUi.n) ? 'Step filled — more to go' : 'Done — review & submit')
                    : autofillState === 'error' ? 'Auto-fill stopped' : 'Auto-filling your application'}
                </Text>
                {autofillState === 'running' && (
                  <Text style={s.afSub}>Reading the form and filling it with AI — a few seconds.</Text>
                )}
                {(autofillState === 'error' || (autofillState === 'done' && !!autofillNote)) && !!autofillNote && (
                  <Text style={autofillState === 'error' ? s.afErrText : s.afSub}>{autofillNote}</Text>
                )}

                {!!wizardUi && wizardUi.n > 0 && (
                  <View style={s.afWizBar}>
                    <Ionicons name="layers-outline" size={15} color={T.blue} />
                    <Text style={s.afWizText} numberOfLines={1}>
                      Step {wizardUi.i} of {wizardUi.n}{wizardUi.name ? ` · ${wizardUi.name}` : ''}
                    </Text>
                    <View style={s.afWizTrack}>
                      <View style={[s.afWizFill, { width: `${Math.min(100, Math.round((wizardUi.i / Math.max(1, wizardUi.n)) * 100))}%` }]} />
                    </View>
                  </View>
                )}

                {autofillFailed.length > 0 && (
                  <View style={s.afFailBox}>
                    <View style={s.afFailHead}>
                      <Ionicons name="alert-circle-outline" size={14} color={T.amber} />
                      <Text style={s.afFailTitle}>STILL NEEDS YOU</Text>
                    </View>
                    <ScrollView style={s.afFailScroll} nestedScrollEnabled>
                      {autofillFailed.map((f: any, i: number) => (
                        <View key={f.key || i} style={s.afFailRow}>
                          <Text style={s.afFailLabel} numberOfLines={2}>{f.label}</Text>
                          {!!f.why && <Text style={s.afFailWhy}>{f.why}</Text>}
                        </View>
                      ))}
                    </ScrollView>
                  </View>
                )}

                <View style={s.afSteps}>
                  {AUTOFILL_STEPS.filter((step) => !step.wizardOnly || !!wizardUi).map((step) => {
                    const st = afStep[step.key] || 'pending';
                    return (
                      <View key={step.key} style={s.afStepRow}>
                        {st === 'done' ? <Ionicons name="checkmark-circle" size={18} color={T.emerald} />
                          : st === 'warn' ? <Ionicons name="alert-circle" size={18} color={T.amber} />
                          : st === 'skip' ? <Ionicons name="remove-circle-outline" size={17} color={T.textFaint} />
                          : st === 'active' ? <ActivityIndicator size="small" color={T.blue} />
                          : <Ionicons name="ellipse-outline" size={16} color={T.textFaint} />}
                        <Text style={[s.afStepText, (st === 'done' || st === 'active') && { color: T.ink, fontWeight: '600' }, st === 'warn' && { color: T.ink }]}>
                          {step.label}{st === 'warn' ? ' — add it manually' : st === 'skip' ? ' — not needed' : ''}
                        </Text>
                      </View>
                    );
                  })}
                </View>

                {(autofillState === 'done' || autofillState === 'error') && (
                  <TouchableOpacity onPress={() => setAutofillState(null)} activeOpacity={0.85} style={s.afCloseBtn}>
                    <Text style={s.afCloseText}>{autofillState === 'done' ? 'Review the form' : 'Close'}</Text>
                  </TouchableOpacity>
                )}
                {/* Manual fallback: the step watcher fires on its own when you press Next, but a
                    stepper that re-renders in an unusual way may not trip it. */}
                {autofillState === 'done' && !!wizardUi && !(wizardUi.n > 0 && wizardUi.i >= wizardUi.n) && (
                  <TouchableOpacity
                    onPress={() => { setAutofillState(null); setTimeout(() => startAutofill(), 120); }}
                    activeOpacity={0.85} style={s.afNextStepBtn}
                  >
                    <Ionicons name="sparkles" size={15} color="#fff" />
                    <Text style={s.afNextStepText}>Fill this step</Text>
                  </TouchableOpacity>
                )}
                {autofillState === 'done' && (
                  <Text style={s.afFootHint}>
                    {wizardUi && !(wizardUi.n > 0 && wizardUi.i >= wizardUi.n)
                      ? 'Check this step, tap Next on the page, and the following step fills itself. You always press Submit yourself.'
                      : 'Double-check the filled details, add anything marked “manually”, then submit on the page.'}
                  </Text>
                )}
              </View>
            </View>
          )}

          {/* File-pick sheet — offer our resume / cover letter when an upload field is tapped */}
          {!!filePick && (
            <View style={s.afOverlay}>
              <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => !filePickBusy && clState !== 'loading' && setFilePick(null)} />
              <View style={s.sheetCard}>
                <View style={s.sheetGrabber} />
                <Text style={s.sheetTitle}>Attach a file</Text>
                <Text style={s.sheetSub} numberOfLines={1}>{filePick.label ? filePick.label : 'Choose what to upload'}</Text>

                {/* Resume — region default from the job, with Change + Preview */}
                <View style={s.docBlock}>
                  <View style={s.docHead}>
                    <View style={[s.pickIcon, { backgroundColor: 'rgba(79,141,255,0.12)' }]}>
                      <Ionicons name="document-text" size={20} color={T.blue} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.pickLabel}>Your Resume</Text>
                      <Text style={s.pickHint}>Version: {regionLabel(effResumeRegion)}</Text>
                    </View>
                    <TouchableOpacity style={s.changeBtn} activeOpacity={0.8} onPress={() => setResumeExpanded((v) => !v)}>
                      <Text style={s.changeBtnText}>{resumeExpanded ? 'Done' : 'Change'}</Text>
                      <Ionicons name={resumeExpanded ? 'chevron-up' : 'chevron-down'} size={13} color={T.blue} />
                    </TouchableOpacity>
                  </View>
                  {resumeExpanded && (
                    <View style={s.chipWrap}>
                      {RESUME_REGION_OPTIONS.map((opt) => (
                        <TouchableOpacity key={opt.id} style={[s.regionChip, effResumeRegion === opt.id && s.regionChipSel]} activeOpacity={0.8} onPress={() => { setResumeRegion(opt.id); setResumeExpanded(false); }}>
                          <Text style={[s.regionChipText, effResumeRegion === opt.id && s.regionChipTextSel]}>{opt.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                  <View style={s.docActions}>
                    <TouchableOpacity style={s.attachBtn} activeOpacity={0.85} disabled={!!filePickBusy} onPress={() => attachPickedFile('resume', effResumeRegion)}>
                      {filePickBusy === 'r:' + effResumeRegion ? <ActivityIndicator size="small" color="#fff" /> : (<><Ionicons name="cloud-upload" size={15} color="#fff" /><Text style={s.attachBtnText}>Attach</Text></>)}
                    </TouchableOpacity>
                    <TouchableOpacity style={s.previewBtn} activeOpacity={0.85} disabled={!!previewBusy || !!filePickBusy} onPress={() => openPreview('resume', effResumeRegion)}>
                      {previewBusy === 'resume:' + effResumeRegion ? <PreviewBusyContent /> : (<><Ionicons name="eye-outline" size={15} color={T.blue} /><Text style={s.previewBtnText}>Preview</Text></>)}
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Cover letter — region default from the job, with Change + Preview.
                    If not generated yet, offer the SAME generator as the apply page. */}
                {!!coverLetterHtml ? (
                  <View style={s.docBlock}>
                    <View style={s.docHead}>
                      <View style={[s.pickIcon, { backgroundColor: 'rgba(124,107,255,0.12)' }]}>
                        <Ionicons name="mail" size={20} color="#7C6BFF" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.pickLabel}>Your Cover Letter</Text>
                        <Text style={s.pickHint}>Version: {regionLabel(effClRegion)}</Text>
                      </View>
                      <TouchableOpacity style={s.changeBtn} activeOpacity={0.8} onPress={() => setClExpanded((v) => !v)}>
                        <Text style={s.changeBtnText}>{clExpanded ? 'Done' : 'Change'}</Text>
                        <Ionicons name={clExpanded ? 'chevron-up' : 'chevron-down'} size={13} color={T.blue} />
                      </TouchableOpacity>
                    </View>
                    {clExpanded && (
                      <View style={s.chipWrap}>
                        {REGION_OPTIONS.map((opt) => (
                          <TouchableOpacity key={opt.id} style={[s.regionChip, effClRegion === opt.id && s.regionChipSel]} activeOpacity={0.8} onPress={() => { setClRegion(opt.id); setClExpanded(false); }}>
                            <Text style={[s.regionChipText, effClRegion === opt.id && s.regionChipTextSel]}>{opt.label}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                    <View style={s.docActions}>
                      <TouchableOpacity style={s.attachBtn} activeOpacity={0.85} disabled={!!filePickBusy} onPress={() => attachPickedFile('coverLetter', effClRegion)}>
                        {filePickBusy === 'c:' + effClRegion ? <ActivityIndicator size="small" color="#fff" /> : (<><Ionicons name="cloud-upload" size={15} color="#fff" /><Text style={s.attachBtnText}>Attach</Text></>)}
                      </TouchableOpacity>
                      <TouchableOpacity style={s.previewBtn} activeOpacity={0.85} disabled={!!previewBusy || !!filePickBusy} onPress={() => openPreview('coverLetter', effClRegion)}>
                        {previewBusy === 'coverLetter:' + effClRegion ? <PreviewBusyContent /> : (<><Ionicons name="eye-outline" size={15} color={T.blue} /><Text style={s.previewBtnText}>Preview</Text></>)}
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <View style={s.docBlock}>
                    <View style={s.docHead}>
                      <View style={[s.pickIcon, { backgroundColor: 'rgba(124,107,255,0.12)' }]}>
                        <Ionicons name="mail" size={20} color="#7C6BFF" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.pickLabel}>Your Cover Letter</Text>
                        <Text style={s.pickHint}>Not generated yet — create one for this job</Text>
                      </View>
                    </View>
                    {/* SAME generator as the apply page: uses this job's title, responsibilities,
                        location & website — nothing changes about how the letter is produced. */}
                    <View style={{ marginTop: 12 }}>
                      <GenerateCLButton
                        state={clState}
                        progress={clProgress}
                        progressAnim={clAnim}
                        label={clLabel}
                        onPress={handleGenerateCoverLetter}
                      />
                    </View>
                  </View>
                )}

                <TouchableOpacity style={s.pickRow} activeOpacity={0.8} disabled={!!filePickBusy} onPress={pickFromDevice}>
                  <View style={[s.pickIcon, { backgroundColor: 'rgba(90,100,128,0.12)' }]}>
                    <Ionicons name="folder-open" size={19} color={T.textMuted} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.pickLabel}>Choose from device</Text>
                    <Text style={s.pickHint}>Pick a file from your phone</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={T.textFaint} />
                </TouchableOpacity>

                <TouchableOpacity style={s.sheetCancel} activeOpacity={0.8} disabled={!!filePickBusy || clState === 'loading'} onPress={() => setFilePick(null)}>
                  <Text style={s.sheetCancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Document preview — drawn INSIDE this modal (iOS won't stack a second fullScreen modal) */}
          {renderPreviewOverlay()}
        </View>
      </Modal>

      <RatingPromptModal visible={!!rating.trigger} trigger={rating.trigger} onClose={rating.close} />
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────
const s = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: T.bg },

  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: T.bg,
  },
  backPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: T.surface, borderRadius: 20,
    paddingVertical: 7, paddingHorizontal: 12,
    shadowColor: T.ink, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07, shadowRadius: 8, elevation: 3,
    zIndex: 1,
  },
  backPillText: { fontSize: 13, fontWeight: '600', color: T.ink },
  wordmark: {
    position: 'absolute', left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    zIndex: 0,
  },
  wordmarkLogo: { width: 22, height: 22 },
  wordmarkText: { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  wordmarkBlue: { color: T.blue },
  viewBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: T.surface, borderRadius: 20,
    paddingVertical: 7, paddingHorizontal: 12,
    shadowColor: T.ink, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07, shadowRadius: 8, elevation: 3,
    zIndex: 1,
  },
  viewBtnText: { fontSize: 13, fontWeight: '600', color: T.blue },

  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 100, gap: 12 },

  // White card (skills, responsibilities)
  card: {
    backgroundColor: T.surface, borderRadius: 22,
    padding: 16, overflow: 'hidden',
    shadowColor: T.ink, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.07, shadowRadius: 16, elevation: 4,
  },

  // Dark hero card (matches other pages)
  heroCard: {
    backgroundColor: '#0B1120', borderRadius: 22,
    padding: 18, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2, shadowRadius: 20, elevation: 8,
  },
  watermark: {
    position: 'absolute', top: '30%', left: '20%', right: -20,
    fontSize: 80, fontWeight: '900',
    color: 'rgba(255,255,255,0.04)',   // light grey on dark bg
    letterSpacing: -3, zIndex: 0,
  },

  // Hero layout
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  logoBox: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  logoInitial: { fontSize: 18, fontWeight: '800', color: '#fff' },
  employerName: { fontSize: 15, fontWeight: '700', color: '#fff' },
  employerSub: { fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 2 },
  jobTitle: { fontSize: 20, fontWeight: '800', color: '#fff', letterSpacing: -0.5, lineHeight: 26, marginBottom: 14 },
  urgentBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: 'rgba(255,78,100,0.2)', borderWidth: 1, borderColor: 'rgba(255,78,100,0.4)',
    borderRadius: 10, paddingVertical: 4, paddingHorizontal: 8, flexShrink: 0,
  },
  matchBadge: { position: 'absolute', top: 14, right: 14, zIndex: 3, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 5 },
  matchBadgeText: { fontSize: 11, fontWeight: '800' },
  urgentText: { fontSize: 10, fontWeight: '700', color: '#FF4E64' },

  // Translate-to-English pill (hero, top-right)
  translatePill: {
    flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 34, minHeight: 26, justifyContent: 'center',
    backgroundColor: 'rgba(6,182,212,0.15)', borderWidth: 1, borderColor: 'rgba(6,182,212,0.45)',
    borderRadius: 10, paddingVertical: 4, paddingHorizontal: 8, flexShrink: 0,
  },
  translatePillActive: { backgroundColor: '#06B6D4', borderColor: '#06B6D4' },
  translatePillText: { fontSize: 10, fontWeight: '700', color: '#06B6D4' },
  translatePillTextActive: { color: '#fff' },

  // Meta chips — dark style
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  heroTranslateRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
  metaChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 20, paddingVertical: 4, paddingHorizontal: 9,
    flexShrink: 1, maxWidth: '100%',   // long location wraps instead of overflowing the card's right edge
  },
  metaChipText: { fontSize: 11, fontWeight: '600', color: 'rgba(255,255,255,0.75)', flexShrink: 1, flexWrap: 'wrap' },

  // Divider inside merged card
  divider: { height: 1, backgroundColor: T.border, marginVertical: 16 },

  // Cover letter card
  // Cover letter row after generation
  clDoneRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  clActionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  officeRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 10, paddingVertical: 9, paddingHorizontal: 11, backgroundColor: 'rgba(11,15,34,0.03)', borderWidth: 1, borderColor: T.border, borderRadius: 12 },
  officeLabel: { fontSize: 9.5, fontWeight: '800', color: T.textMuted, letterSpacing: 0.6 },
  officeValue: { fontSize: 12.5, fontWeight: '700', color: T.ink, marginTop: 2 },
  officeOverlay: { flex: 1, backgroundColor: 'rgba(11,15,34,0.42)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  officeMenu: { width: '100%', maxHeight: '70%', backgroundColor: '#fff', borderRadius: 18, padding: 14 },
  officeMenuTitle: { fontSize: 14, fontWeight: '800', color: T.ink, marginBottom: 8, paddingHorizontal: 2 },
  officeItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12 },
  officeItemActive: { backgroundColor: 'rgba(79,141,255,0.10)' },
  officeItemText: { flex: 1, fontSize: 13, fontWeight: '600', color: T.ink },
  editBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 10, paddingHorizontal: 14,
    backgroundColor: 'rgba(79,141,255,0.08)', borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)',
  },
  editBtnText: { fontSize: 13, fontWeight: '700', color: T.blue },
  editIconBtn: {
    width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(79,141,255,0.08)', borderWidth: 1.5, borderColor: 'rgba(79,141,255,0.35)',
  },

  // Card header (icon + title + sub) — used by the Contacts & Cover Letter cards
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, marginBottom: 14 },
  cardHeadIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  cardHeadTitle: { fontSize: 15, fontWeight: '800', color: T.ink, letterSpacing: -0.2 },
  cardHeadSub: { fontSize: 11.5, color: T.textMuted, marginTop: 2, lineHeight: 16 },

  // Section label
  sectionLabel: { fontSize: 10, fontWeight: '800', color: T.textFaint, letterSpacing: 1.2, marginBottom: 10 },

  // Skills
  skillsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  skillChip: { backgroundColor: 'rgba(79,141,255,0.08)', borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  skillChipText: { fontSize: 11, fontWeight: '600', color: T.blue },
  skillMore: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(79,141,255,0.1)', borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  skillMoreText: { fontSize: 11, fontWeight: '700', color: T.blue },

  // Responsibilities
  respRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  respDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: T.blue, marginTop: 6, flexShrink: 0 },
  respText: { fontSize: 13, color: T.inkSoft, lineHeight: 20, flex: 1 },

  // Contacts
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 12, fontWeight: '700', color: '#fff' },
  contactName: { fontSize: 13, fontWeight: '700', color: T.ink },
  contactRole: { fontSize: 11, color: T.textFaint, marginTop: 1 },
  contactEmail: {
    fontSize: 11, color: T.blue, marginTop: 2,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  verifiedBadge: { marginLeft: 4 },
  noContacts: { fontSize: 12, color: T.textFaint, fontStyle: 'italic', marginBottom: 8 },
  addContactBtn: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    backgroundColor: 'rgba(79,141,255,0.08)', borderWidth: 1, borderColor: 'rgba(79,141,255,0.25)',
    borderRadius: 10, paddingVertical: 8, paddingHorizontal: 13, gap: 6, marginTop: 8,
  },
  addContactBtnText: { fontSize: 12.5, color: T.blue, fontWeight: '700' },

  // Editable apply link
  urlCurrent: { fontSize: 11.5, color: T.textMuted, marginBottom: 10, lineHeight: 16 },
  urlInputWrap: {
    borderWidth: 1, borderColor: T.border, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 11, backgroundColor: T.bgSoft,
  },
  saveUrlBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start',
    backgroundColor: 'rgba(79,141,255,0.08)', borderWidth: 1, borderColor: 'rgba(79,141,255,0.25)',
    borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14, gap: 6, marginTop: 10, minWidth: 110,
  },
  saveUrlBtnDisabled: { opacity: 0.45 },
  saveUrlBtnText: { fontSize: 12.5, color: T.blue, fontWeight: '700' },
  urlExplainer: { fontSize: 11, color: T.textFaint, lineHeight: 16, marginTop: 12 },

  // Footer
  footer: {
    backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.border,
    padding: 16, paddingBottom: Platform.select({ ios: 28, default: 16 }),
    flexDirection: 'row', gap: 10,
  },
  applyOuter: { borderRadius: 14, overflow: 'hidden' },
  applyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 14 },
  applyBtnText: { fontSize: 15, fontWeight: '800', color: '#fff' },
  portalBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 50, borderRadius: 14, backgroundColor: 'rgba(79,141,255,0.10)', borderWidth: 1.5, borderColor: 'rgba(79,141,255,0.35)' },
  portalBtnText: { fontSize: 14.5, fontWeight: '800', color: T.blue },

  // ── Email Compose Modal ──
  modalOverlay: {
    flex: 1, justifyContent: 'flex-end',
    backgroundColor: 'rgba(11,15,34,0.55)',
  },
  modalSheet: {
    backgroundColor: T.surface,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingBottom: Platform.select({ ios: 34, default: 20 }),
    maxHeight: '92%',
    shadowColor: '#000', shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.18, shadowRadius: 24, elevation: 20,
  },
  modalHandle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: T.border, alignSelf: 'center', marginTop: 10, marginBottom: 4,
  },
  modalHeader: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: T.border,
  },
  modalTitle: { fontSize: 17, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  modalSubtitle: { fontSize: 12, color: T.textMuted, marginTop: 2, fontWeight: '600' },
  modalCloseBtn: {
    backgroundColor: T.bg, borderRadius: 16, width: 32, height: 32,
    alignItems: 'center', justifyContent: 'center',
  },
  modalScroll: { paddingHorizontal: 20 },

  // Fields
  // Single-line fields: vertically centre the row so the label sits level with its text.
  fieldRow: {
    flexDirection: 'row', alignItems: 'center',
    borderBottomWidth: 1, borderBottomColor: T.border,
    paddingVertical: 12, gap: 10,
  },
  fieldLabel: {
    width: 52, fontSize: 13, fontWeight: '700',
    color: T.textMuted,
  },
  fieldInput: {
    flex: 1, fontSize: 13, color: T.ink, fontWeight: '500',
    paddingTop: 0, paddingBottom: 0,
  },

  ccToggle: { paddingVertical: 8, alignSelf: 'flex-end' },
  ccToggleText: { fontSize: 11, fontWeight: '700', color: T.blue },

  // Attachment pill
  attachPill: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(79,141,255,0.07)',
    borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)',
    borderRadius: 10, paddingVertical: 5, paddingHorizontal: 9,
  },
  attachPillText: { flex: 1, fontSize: 12, fontWeight: '600', color: T.blue },
  attachCheck: { marginLeft: 2 },

  // Email attachments (Resume + Cover Letter chips)
  attachSectionLabel: { fontSize: 10, fontWeight: '800', color: T.textFaint, letterSpacing: 1.2, marginTop: 14, marginBottom: 8 },
  mailAttach: {
    backgroundColor: T.bg, borderWidth: 1, borderColor: T.borderHi,
    borderRadius: 12, paddingHorizontal: 10, paddingVertical: 9, marginBottom: 8,
  },
  mailAttachMain: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  mailAttachIconBox: { width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  mailAttachName: { fontSize: 13, fontWeight: '700', color: T.ink },
  mailAttachMeta: { fontSize: 11, color: T.textMuted, marginTop: 1 },
  mailAttachBtn: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  mailChipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  mailAddBack: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6,
    backgroundColor: 'rgba(79,141,255,0.07)', borderWidth: 1, borderColor: 'rgba(79,141,255,0.22)', borderStyle: 'dashed',
    borderRadius: 10, paddingVertical: 9, paddingHorizontal: 13, marginBottom: 8,
  },
  mailAddBackText: { fontSize: 12.5, fontWeight: '700', color: T.blue },

  // Body
  bodyField: {
    marginTop: 10, marginBottom: 12,
    backgroundColor: T.bg, borderRadius: 14,
    borderWidth: 1, borderColor: T.border,
    padding: 12, minHeight: 180,
  },
  bodyInput: {
    fontSize: 13, color: T.ink, lineHeight: 20,
    fontWeight: '400', minHeight: 160,
  },

  // Modal footer buttons
  modalFooter: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: 20, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: T.border,
  },
  cancelBtn: {
    flex: 1, height: 48, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: T.bg, borderWidth: 1, borderColor: T.borderHi,
  },
  cancelBtnText: { fontSize: 14, fontWeight: '700', color: T.textMuted },
  sendOuter: { flex: 2, borderRadius: 14, overflow: 'hidden' },
  sendOuterDone: {},
  sendBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 7, height: 48, borderRadius: 14,
  },
  sendBtnText: { fontSize: 14, fontWeight: '800', color: '#fff' },

  // ── In-app Apply Web View ──
  webSafe:   { flex: 1, backgroundColor: T.bg },
  webHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: T.surface,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.borderHi,
  },
  webHeaderBtn:    { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: T.bg },
  webHeaderBtnActive: { backgroundColor: T.blue },
  webHeaderCenter: { flex: 1, alignItems: 'center' },
  webHeaderTitle:  { fontSize: 14, fontWeight: '700', color: T.ink, maxWidth: '92%' },
  webHostRow:      { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
  webHeaderHost:   { fontSize: 11, color: T.textMuted, maxWidth: 200 },
  webProgressTrack:{ height: 2.5, backgroundColor: 'rgba(79,141,255,0.15)' },
  webProgressFill: { height: 2.5, backgroundColor: T.blue, borderRadius: 2 },
  webView:         { flex: 1, backgroundColor: '#fff' },
  webLoading:      { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  appliedToast:    { position: 'absolute', left: 12, right: 12, zIndex: 70, alignItems: 'center' },
  appliedToastCard:{ flexDirection: 'row', alignItems: 'center', gap: 9, maxWidth: 460, backgroundColor: '#16A34A', paddingVertical: 11, paddingHorizontal: 14, borderRadius: 14, shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 7 },
  appliedToastText:{ flex: 1, color: '#fff', fontSize: 13.5, fontWeight: '700', lineHeight: 18 },
  previewOverlay:       { ...StyleSheet.absoluteFillObject, backgroundColor: T.surface, zIndex: 60 },
  previewNote: { flexDirection: 'row', alignItems: 'center', gap: 7, marginHorizontal: 14, marginBottom: 8, backgroundColor: '#EFF6FF', borderRadius: 10, paddingHorizontal: 11, paddingVertical: 8, borderWidth: 1, borderColor: '#DBEAFE' },
  previewNoteTx: { flex: 1, fontSize: 11.5, fontWeight: '600', color: '#1D4ED8' },
  previewOpenBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginHorizontal: 14, marginTop: 10, height: 44, borderRadius: 13, backgroundColor: '#0F172A' },
  previewOpenTx: { fontSize: 13.5, fontWeight: '800', color: '#fff' },
  previewScroll:        { flex: 1, backgroundColor: '#54607a' },
  previewScrollContent: { padding: 14, alignItems: 'center' },
  webNav: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 9,
    backgroundColor: T.surface,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.borderHi,
  },
  webNavGroup:     { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: T.bg, borderRadius: 12, padding: 3 },
  webNavBtn:       { width: 40, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  webNavHint:      { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 5, paddingRight: 4 },
  webNavHintTx:    { fontSize: 11, fontWeight: '700', color: T.textMuted, textAlign: 'right' },
  autofillOuter:   { flex: 1, borderRadius: 13, overflow: 'hidden', shadowColor: '#4F8DFF', shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 4 },
  autofillBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 40, borderRadius: 13 },
  autofillBtnText: { fontSize: 14.5, fontWeight: '800', color: '#fff', letterSpacing: -0.2 },

  // ── Bottom-sheet popups (auto-fill progress + file pick) ──
  afOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(11,15,34,0.5)', justifyContent: 'flex-end' },
  afCard:    { width: '100%', backgroundColor: T.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingHorizontal: 22, paddingTop: 20, paddingBottom: 30, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.18, shadowRadius: 20, elevation: 16 },
  afIcon:    { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  afTitle:   { fontSize: 17, fontWeight: '800', color: T.ink, textAlign: 'center', letterSpacing: -0.3 },
  afSub:     { fontSize: 12.5, color: T.textMuted, textAlign: 'center', marginTop: 5, lineHeight: 18 },
  afErrText: { fontSize: 12.5, color: T.rose, textAlign: 'center', marginTop: 6, lineHeight: 18 },
  // Multi-step progress + the questions autofill could not answer
  afWizBar:       { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, backgroundColor: 'rgba(79,141,255,0.10)' },
  afWizText:      { fontSize: 12.5, fontWeight: '700', color: T.ink, flexShrink: 1 },
  afWizTrack:     { flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(79,141,255,0.22)', overflow: 'hidden', marginLeft: 4 },
  afWizFill:      { height: 4, borderRadius: 2, backgroundColor: T.blue },
  afNextStepBtn:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, alignSelf: 'stretch', marginTop: 10, paddingVertical: 12, borderRadius: 11, backgroundColor: T.blue },
  afNextStepText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  afFailBox:      { marginTop: 12, alignSelf: 'stretch', backgroundColor: '#FFFBEB', borderRadius: 12, borderWidth: 1, borderColor: '#FDE68A', padding: 12 },
  afFailHead:     { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  afFailTitle:    { fontSize: 10.5, fontWeight: '800', color: '#B45309', letterSpacing: 0.6 },
  afFailScroll:   { maxHeight: 132 },
  afFailRow:      { paddingVertical: 5, borderTopWidth: 1, borderTopColor: '#FEF3C7' },
  afFailLabel:    { fontSize: 13, fontWeight: '600', color: T.ink },
  afFailWhy:      { fontSize: 11, color: T.textFaint, marginTop: 1 },
  afSteps:   { alignSelf: 'stretch', marginTop: 18, gap: 12 },
  afStepRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 20 },
  afStepText:{ fontSize: 13.5, color: T.textFaint, flex: 1 },
  afCloseBtn:{ marginTop: 20, alignSelf: 'stretch', height: 48, borderRadius: 14, backgroundColor: T.blue, alignItems: 'center', justifyContent: 'center' },
  afCloseText:{ fontSize: 14.5, fontWeight: '800', color: '#fff' },
  afFootHint:{ fontSize: 11.5, color: T.textMuted, textAlign: 'center', marginTop: 12, lineHeight: 16 },

  // File-pick sheet
  sheetCard:    { width: '100%', backgroundColor: T.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 28, shadowColor: '#000', shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.18, shadowRadius: 20, elevation: 16 },
  sheetGrabber: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: T.borderHi, marginBottom: 12 },
  sheetTitle:   { fontSize: 17, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  sheetSub:     { fontSize: 12.5, color: T.textMuted, marginTop: 2, marginBottom: 12 },
  pickRow:      { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 14, backgroundColor: T.bg, marginTop: 8 },
  pickIcon:     { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  pickLabel:    { fontSize: 14.5, fontWeight: '700', color: T.ink },
  pickHint:     { fontSize: 11.5, color: T.textMuted, marginTop: 1 },
  chipWrap:     { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 10, paddingLeft: 2 },
  regionChip:   { minWidth: 56, minHeight: 32, paddingHorizontal: 11, paddingVertical: 6, borderRadius: 10, backgroundColor: 'rgba(79,141,255,0.08)', borderWidth: 1, borderColor: 'rgba(79,141,255,0.22)', alignItems: 'center', justifyContent: 'center' },
  regionChipSel:    { backgroundColor: T.blue, borderColor: T.blue },
  regionChipText:   { fontSize: 12.5, fontWeight: '700', color: T.blue },
  regionChipTextSel:{ color: '#fff' },
  // Doc block (resume / cover letter)
  docBlock:     { marginTop: 12, padding: 12, borderRadius: 16, backgroundColor: T.bg },
  docHead:      { flexDirection: 'row', alignItems: 'center', gap: 12 },
  changeBtn:    { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 5, paddingHorizontal: 9, borderRadius: 9, backgroundColor: 'rgba(79,141,255,0.1)' },
  changeBtnText:{ fontSize: 12.5, fontWeight: '700', color: T.blue },
  docActions:   { flexDirection: 'row', gap: 8, marginTop: 12 },
  attachBtn:    { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 42, borderRadius: 12, backgroundColor: T.blue },
  attachBtnText:{ fontSize: 14, fontWeight: '800', color: '#fff' },
  previewBtn:   { width: 120, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 42, borderRadius: 12, paddingHorizontal: 16, backgroundColor: T.surface, borderWidth: 1, borderColor: 'rgba(79,141,255,0.3)' },
  previewBtnText:{ fontSize: 14, fontWeight: '800', color: T.blue },
  sheetCancel:  { marginTop: 14, height: 46, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: T.bg, borderWidth: 1, borderColor: T.borderHi },
  sheetCancelText: { fontSize: 14, fontWeight: '700', color: T.textMuted },

  // ── Smart-copy floating helper ──
  smartFab: {
    position: 'absolute', right: 16, width: 48, height: 48, borderRadius: 24,
    backgroundColor: 'rgba(79,141,255,0.95)', alignItems: 'center', justifyContent: 'center',
    shadowColor: T.ink, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.24, shadowRadius: 12, elevation: 11, zIndex: 60,
  },
  smartBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(11,15,34,0.28)', zIndex: 65 },
  smartSheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 66,
    backgroundColor: T.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 16, paddingTop: 8,
    shadowColor: T.ink, shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.16, shadowRadius: 22, elevation: 24,
  },
  smartHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: T.borderHi, marginBottom: 8 },
  smartHeader: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 8 },
  smartTitle: { fontSize: 15, fontWeight: '800', color: T.ink, letterSpacing: -0.2 },
  smartEmpty: { fontSize: 13, color: T.textMuted, paddingVertical: 20, textAlign: 'center', lineHeight: 19 },
  smartPrimaryWrap: { backgroundColor: 'rgba(79,141,255,0.07)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(79,141,255,0.18)', padding: 10, marginBottom: 10 },
  smartPrimaryHint: { fontSize: 10.5, fontWeight: '800', color: T.blue, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6, marginLeft: 2 },
  smartRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.border,
  },
  smartRowLabel: { fontSize: 11, fontWeight: '700', color: T.textFaint, marginBottom: 2 },
  smartRowValue: { fontSize: 13.5, fontWeight: '600', color: T.inkSoft, lineHeight: 18 },
  smartCopyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, height: 30, paddingHorizontal: 11, borderRadius: 9,
    backgroundColor: 'rgba(79,141,255,0.10)', borderWidth: 1, borderColor: 'rgba(79,141,255,0.25)',
  },
  smartCopyBtnDone: { backgroundColor: T.emerald, borderColor: T.emerald },
  smartCopyTxt: { fontSize: 12, fontWeight: '800', color: T.blue },
  smartMoreBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 11, marginTop: 2 },
  smartMoreTxt: { fontSize: 13, fontWeight: '800', color: T.blue },
});
