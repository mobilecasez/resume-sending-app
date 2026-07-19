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
  // type, so the scan silently dropped all but the first — add a positional discriminator instead.
  function domIdx(el){ try{ var all=document.querySelectorAll('input,textarea,select'); for(var i=0;i<all.length;i++) if(all[i]===el) return i; }catch(e){} return 0; }
  function sig(el){ var t=(el.type||'').toLowerCase(); if(el.name) return 'n:'+el.name+'|'+t; if(el.id) return 'i:'+el.id+'|'+t; var L=nlbl(el).toLowerCase().slice(0,70); return L ? ('l:'+L+'|'+t) : ('p:'+domIdx(el)+'|'+t); }
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
    return null;
  }
  // Respect work the user already did by hand: if a control already holds a different non-empty
  // answer, autofill leaves it alone (and reports it as handled) instead of overwriting it.
  function keepUser(el, t, v){
    try{
      if(t==='radio'||t==='checkbox'||t==='file') return false;
      var cur='';
      if(el.tagName==='SELECT'){ var o=el.options&&el.options[el.selectedIndex]; cur=o?(o.text||o.value||''):''; }
      else cur=el.value||'';
      cur=String(cur).trim();
      if(!cur) return false;
      return cur.toLowerCase()!==String(v).trim().toLowerCase();
    }catch(e){ return false; }
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

// 1) SCROLL through the whole form, snapshotting every field by signature as it renders.
const READ_FIELDS_JS = `(function(){
  ${JS_HELPERS}
  try {
    var out=[], seen={}, rgroups={};
    function snap(){
      var els=document.querySelectorAll('input,textarea,select');
      for(var i=0;i<els.length;i++){ var el=els[i]; var t=(el.type||'').toLowerCase();
        if(['hidden','submit','button','reset','image'].indexOf(t)>=0) continue;
        if(!vis(el)) continue;
        var s=sig(el);
        if(t==='radio'){
          if(!rgroups[s]){ rgroups[s]={key:s,tag:'radio',type:'radio',name:(el.name||'').slice(0,60),label:radioQuestion(el).slice(0,180),required:!!el.required,options:[]}; out.push(rgroups[s]); }
          var ol=(nlbl(el)||el.value||'').slice(0,80); if(ol&&rgroups[s].options.indexOf(ol)<0) rgroups[s].options.push(ol);
          continue;
        }
        if(seen[s]) continue; seen[s]=true;
        var f={key:s,tag:el.tagName.toLowerCase(),type:t,name:(el.name||'').slice(0,60),placeholder:(el.placeholder||'').slice(0,80),label:nlbl(el).slice(0,140),required:!!el.required,accept:(el.getAttribute&&el.getAttribute('accept'))||''};
        if(el.tagName==='SELECT'){ f.options=Array.prototype.slice.call(el.options).map(function(o){return (o.text||'').trim();}).filter(Boolean).slice(0,80); }
        out.push(f);
      }
    }
    // SPA forms (SmartRecruiters one-click, Workday, etc.) render their inputs AFTER first paint, so a
    // single scan finds nothing → "No fillable fields found". Retry for ~5s until fields appear.
    var tries=0;
    (function run(){
      out=[]; seen={}; rgroups={};
      scrollThrough(snap, function(){
        if(out.length>0 || ++tries>=11){ post({type:'FIELDS', fields: out}); }
        else { setTimeout(run, 450); }
      });
    })();
  } catch(e){ post({type:'AUTOFILL_ERROR', error: String((e && e.message) || e)}); }
})(); true;`;

// Installed on every page load (via the WebView's injectedJavaScript): when the user taps a
// file-upload field, intercept it and ask RN to offer our resume / cover letter to attach.
const INTERCEPT_FILES_JS = `(function(){
  if (window.__cvfFileHook) return; window.__cvfFileHook = true;
  function post(o){ try{ o.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  document.addEventListener('click', function(ev){
    try {
      var el = ev.target;
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
  if (window.__cvfFocusHook) return; window.__cvfFocusHook = true;
  ${JS_HELPERS}
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
    var els=document.querySelectorAll('input,textarea,select');
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
  if (window.__cvfAgent) return; window.__cvfAgent = true;
  ${JS_HELPERS}
  function b64ToFile(b64, filename, mime){ var bin=atob(b64); var bytes=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i); return new File([bytes], filename, {type:mime||'application/pdf'}); }
  function doScan(){
    try {
      var out=[], seen={}, rgroups={};
      function snap(){ var els=document.querySelectorAll('input,textarea,select');
        for(var i=0;i<els.length;i++){ var el=els[i]; var t=(el.type||'').toLowerCase();
          if(['hidden','submit','button','reset','image'].indexOf(t)>=0) continue;
          if(!vis(el)) continue; var s=sig(el);
          if(t==='radio'){ if(!rgroups[s]){ rgroups[s]={key:s,tag:'radio',type:'radio',name:(el.name||'').slice(0,60),label:radioQuestion(el).slice(0,180),required:!!el.required,options:[]}; out.push(rgroups[s]); } var ol=(nlbl(el)||el.value||'').slice(0,80); if(ol&&rgroups[s].options.indexOf(ol)<0) rgroups[s].options.push(ol); continue; }
          if(seen[s]) continue; seen[s]=true;
          var f={key:s,tag:el.tagName.toLowerCase(),type:t,name:(el.name||'').slice(0,60),placeholder:(el.placeholder||'').slice(0,80),label:nlbl(el).slice(0,140),required:!!el.required,accept:(el.getAttribute&&el.getAttribute('accept'))||''};
          if(el.tagName==='SELECT'){ f.options=Array.prototype.slice.call(el.options).map(function(o){return (o.text||'').trim();}).filter(Boolean).slice(0,80); }
          out.push(f);
        }
      }
      // Retry for ~5s so a cross-origin ATS iframe that renders its form late still gets scanned.
      // A CHILD frame posts ONLY when it finds fields — it must never emit an empty terminal (that
      // would re-arm the debounce after mapping already started); the MAIN frame owns the empty signal.
      var tries=0;
      (function run(){
        out=[]; seen={}; rgroups={};
        scrollThrough(snap, function(){
          if(out.length>0){ post({type:'FIELDS', fields: out, frame:1}); }
          else if(++tries<11){ setTimeout(run, 450); }
        });
      })();
    } catch(e){ post({type:'AUTOFILL_ERROR', error:String((e&&e.message)||e)}); }
  }
  function doFill(bySig){
    try {
      var total=Object.keys(bySig).length, filled={};
      function fillVisible(){ var els=document.querySelectorAll('input,textarea,select');
        for(var i=0;i<els.length;i++){ var el=els[i]; var t=(el.type||'').toLowerCase();
          if(['hidden','submit','button','reset','image','file'].indexOf(t)>=0) continue; if(!vis(el)) continue;
          var s=sig(el); if(!(s in bySig)||filled[s]) continue; var v=bySig[s]; if(v==null||v===''){filled[s]=true;continue;}
          if(keepUser(el,t,v)){ filled[s]=true; continue; }   // user already answered this — leave it
          try{ if(t==='radio'){ var ol=(nlbl(el)||el.value||'').trim().toLowerCase(); var want=String(v).trim().toLowerCase(); if(ol===want||(want&&ol.indexOf(want)>=0)||(el.value||'').toLowerCase()===want){ setChecked(el,true); if(el.checked) filled[s]=true; } }
            else if(el.tagName==='SELECT'){ var m=pickOpt(el.options,v); if(m){ setNative(el, m.value); filled[s]=true; } }
            else if(t==='checkbox'){ var wc=(v===true)||/^(yes|true|on|1|checked)$/i.test(String(v)); setChecked(el,wc); if(el.checked===wc) filled[s]=true; }
            else { try{el.focus();}catch(e){} setNative(el,String(v)); try{el.dispatchEvent(new Event('blur',{bubbles:true}));el.blur();}catch(e){} if(String(el.value)===String(v)) filled[s]=true; }
          }catch(e){}
        }
      }
      var passes=0;
      function pass(){ var before=Object.keys(filled).length; scrollThrough(fillVisible, function(){ passes++; var after=Object.keys(filled).length; if(after>before&&after<total&&passes<5){pass();} else { post({type:'FILLED', count:after, total:total, frame:1}); } }); }
      pass();
    } catch(e){ post({type:'AUTOFILL_ERROR', error:String((e&&e.message)||e)}); }
  }
  function doAttach(keys,b64,filename,mime,kind){
    try{ var ok=0,total=0; (keys||[]).forEach(function(k){ var el=document.querySelector('[data-cvf="'+k+'"]'); if(!el||(el.type||'').toLowerCase()!=='file') return; total++; try{ var dt=new DataTransfer(); dt.items.add(b64ToFile(b64,filename,mime)); el.files=dt.files; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); if(el.files&&el.files.length>0) ok++; }catch(e){} });
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
    try {
      var bySig = ${JSON.stringify(values)};
      var total = Object.keys(bySig).length;
      var filled = {};
      function fillVisible(){
        var els = document.querySelectorAll('input,textarea,select');
        for (var i=0;i<els.length;i++){ var el=els[i]; var t=(el.type||'').toLowerCase();
          if (['hidden','submit','button','reset','image','file'].indexOf(t)>=0) continue;
          if (!vis(el)) continue;
          var s = sig(el);
          if (!(s in bySig)) continue;
          if (filled[s]) continue;
          var v = bySig[s]; if (v==null || v===''){ filled[s]=true; continue; }
          if (keepUser(el,t,v)){ filled[s]=true; continue; }   // user already answered this — leave it
          try {
            if (t==='radio'){
              var ol=(nlbl(el)||el.value||'').trim().toLowerCase(); var want=String(v).trim().toLowerCase();
              if (ol===want || (want && ol.indexOf(want)>=0) || (el.value||'').toLowerCase()===want){ setChecked(el,true); if(el.checked) filled[s]=true; }
            } else if (el.tagName==='SELECT'){
              var m=pickOpt(el.options,v); if(m){ setNative(el, m.value); filled[s]=true; }
            } else if (t==='checkbox'){
              var wc=(v===true)||/^(yes|true|on|1|checked)$/i.test(String(v)); setChecked(el,wc); if(el.checked===wc) filled[s]=true;
            } else {
              try{el.focus();}catch(e){} setNative(el,String(v)); try{el.dispatchEvent(new Event('blur',{bubbles:true}));el.blur();}catch(e){} if(String(el.value)===String(v)) filled[s]=true;
            }
          } catch(e){}
        }
      }
      // Multiple passes: re-scroll and fill until nothing new fills (handles virtualization,
      // lazy sections, and anything re-rendered after a file/upload control).
      var passes = 0;
      function pass(){
        var before = Object.keys(filled).length;
        scrollThrough(fillVisible, function(){
          passes++;
          var after = Object.keys(filled).length;
          if (after > before && after < total && passes < 5){ pass(); }
          else { post({type:'FILLED', count:after, total:total}); }
        });
      }
      pass();
    } catch(e){ post({type:'AUTOFILL_ERROR', error:String((e && e.message) || e)}); }
  })(); true;`;
}

// 3) Attach a base64 file to tagged file inputs. VERIFIES el.files after assignment
//    (so iOS/custom uploaders that silently no-op are reported as failed, not success).
function attachJs(keys: string[], base64: string, filename: string, mime: string, kind: string): string {
  return `(function(){
    function post(o){ try{ o.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
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
        var el = document.querySelector('[data-cvf="'+k+'"]');
        if ((!el || (el.type||'').toLowerCase()!=='file') && k === '__manual__') el = document.querySelector('input[type=file]');
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
      var els=document.querySelectorAll('input,textarea');
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

const AUTOFILL_STEPS: { key: string; label: string }[] = [
  { key: 'reading', label: 'Scanning the whole form' },
  { key: 'mapping', label: 'Matching with your profile (AI)' },
  { key: 'filling', label: 'Filling in your details' },
  { key: 'skills',  label: 'Adding your skills' },
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
  const [webTranslated,  setWebTranslated]  = useState(false);   // page translated to English (Google in-page widget)
  const [webTranslating, setWebTranslating] = useState(false);
  const webTranslatedRef = useRef(false);                        // mirror for the load callback (no stale closure)
  const autoXlateRef     = useRef(true);                         // auto-translate non-English pages until the user opts out
  const bridgeXlateRef   = useRef(false);                        // a backend "bridge" translation is in-flight/done for this page
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
  const setStep = (key: string, status: string) => setAfStep(prev => ({ ...prev, [key]: status }));

  // File-tap interception: offer our resume / cover letter when the user taps an upload field.
  const [filePick,     setFilePick]     = useState<{ key: string; accept: string; label: string } | null>(null);
  const [filePickBusy, setFilePickBusy] = useState<string | null>(null);
  const filesRef = useRef<Record<string, any>>({}); // 'kind:region' -> file ({base64,name,mime}) or null
  const [resumeRegion,   setResumeRegion]   = useState('');   // '' = use the job's default region
  const [clRegion,       setClRegion]       = useState('');
  const [resumeExpanded, setResumeExpanded] = useState(false);
  const [clExpanded,     setClExpanded]     = useState(false);
  const [preview,        setPreview]        = useState<{ image: string; title: string; ratio: number } | null>(null);
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
    // Smart-copy: reset + prefetch the user's reusable details for the floating helper.
    setSmartOpen(false); setSmartExpanded(false); setCopiedKey(null);
    focusedFieldRef.current = null; smartValuesRef.current = {};
    setWebTranslated(false); setWebTranslating(false); webTranslatedRef.current = false; autoXlateRef.current = true;
    bridgeXlateRef.current = false;
    loadLocalFill();
    if (!smartData) { getSmartFillData().then(setSmartData).catch(() => {}); }
    setApplyWebUrl(u);
  };

  // Translate the apply page to English (or back) using Google's free in-page widget — no AI.
  const toggleTranslate = () => {
    if (!applyWebRef.current || webTranslating) return;
    if (!webTranslated) {
      setWebTranslating(true);
      webTranslatedRef.current = true;            // stays on across page navigations
      autoXlateRef.current = true;                // opt back into auto-translate
      applyWebRef.current.injectJavaScript(TRANSLATE_TO_EN_JS);
      setWebTranslated(true);
      // The widget swaps text asynchronously; clear the spinner shortly after.
      setTimeout(() => setWebTranslating(false), 2200);
    } else {
      webTranslatedRef.current = false;
      autoXlateRef.current = false;               // user wants the original → stop auto-translating
      bridgeXlateRef.current = false;             // allow re-bridging if they translate again
      applyWebRef.current.injectJavaScript(TRANSLATE_OFF_JS);   // clears cookie + reloads to original
      setWebTranslated(false);
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
  useEffect(() => { track('screen_view', { screen: 'job_detail' }); }, []);
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
    setAutofillState(state);
    setAutofillNote(note);
  };

  // Final message from BOTH stages, so a run that filled no text fields but DID add skills still
  // reads as a success (and vice-versa) instead of the old blanket "couldn't match any fields".
  const finishFill = (fields: number, skills: number) => {
    const parts: string[] = [];
    if (fields > 0) parts.push(`Filled ${fields} field${fields === 1 ? '' : 's'}`);
    if (skills > 0) parts.push(`${fields > 0 ? 'added' : 'Added'} ${skills} skill${skills === 1 ? '' : 's'}`);
    if (!parts.length) {
      finishAutofill('done', "We couldn't match anything on this page automatically — please fill it in manually.");
      return;
    }
    finishAutofill('done', `${parts.join(' and ')}. Now tap each upload field to attach your resume & cover letter.`);
  };

  const closeApplyWebView = () => {
    autofillRef.current.active = false;
    autofillRef.current.gen++;            // invalidate any in-flight run
    setAutofillState(null);
    setPreview(null); setPreviewBusy(null);   // don't leave a stale preview / busy spinner
    setFilePick(null); setFilePickBusy(null);
    if (attachTimerRef.current) { clearTimeout(attachTimerRef.current); attachTimerRef.current = null; }   // no stray "couldn't attach" alert after close
    if (scanTimerRef.current)   { clearTimeout(scanTimerRef.current);   scanTimerRef.current = null; }
    if (skillsTimerRef.current) { clearTimeout(skillsTimerRef.current); skillsTimerRef.current = null; }
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
    if (fieldsTimerRef.current) { clearTimeout(fieldsTimerRef.current); fieldsTimerRef.current = null; }
    if (skillsTimerRef.current) { clearTimeout(skillsTimerRef.current); skillsTimerRef.current = null; }
    // The skills stage needs the user's résumé skills — make sure the bundle has landed.
    if (!smartData) { getSmartFillData().then(setSmartData).catch(() => {}); }
    // WATCHDOG: the scan retries internally (SPA forms render late). If nothing ever comes back,
    // fail honestly instead of leaving the overlay spinning forever.
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    scanTimerRef.current = setTimeout(() => {
      if (autofillRef.current.active && autofillRef.current.gen === gen && !fieldsAccumRef.current.length) {
        setStep('reading', 'warn');
        finishAutofill('error', "Couldn't read this form in time. Scroll to the application form and tap Auto Fill again.");
      }
    }, 25000);
    applyWebRef.current.injectJavaScript(READ_FIELDS_JS);                          // main frame (as before)
    applyWebRef.current.injectJavaScript(relayToChildrenJs({ __cvfCmd: 'scan' })); // + any iframe(s)
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

  const onWebMessage = async (e: any) => {
    let msg: any;
    try { msg = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (!msg || msg.__cvf !== true) return;          // ignore the host page's own postMessages

    // Job page text captured → remember it, and prefetch the job details (canonical UUID + AI
    // responsibilities) so Generate-Cover-Letter has real data ready. No-op for real DB jobs.
    if (msg.type === 'JOB_PAGE_TEXT') {
      lastPageTextRef.current = String(msg.text || '');
      if (lastPageTextRef.current.length > 120) prefetchCapture(lastPageTextRef.current);
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
      if (msg.nonEnglish && autoXlateRef.current && !webTranslatedRef.current && applyWebRef.current) {
        setWebTranslating(true);
        webTranslatedRef.current = true;
        applyWebRef.current.injectJavaScript(TRANSLATE_TO_EN_JS);
        setWebTranslated(true);
        setTimeout(() => setWebTranslating(false), 2200);
      }
      return;
    }

    // The free Google in-page widget couldn't translate (its script was blocked, or — like ilionx —
    // the site's CSP blocks Google's translation engine so the page never actually changes). Fall
    // back to our backend "bridge" translator, which works regardless of the page's CSP.
    if (msg.type === 'TRANSLATE_FAIL' || msg.type === 'XLATE_WIDGET_DEAD') {
      if (bridgeXlateRef.current) return;                 // already bridging / bridged this page
      bridgeXlateRef.current = true;
      setWebTranslating(true);
      webTranslatedRef.current = true;
      try { applyWebRef.current?.injectJavaScript(COLLECT_NODES_JS); } catch {}
      return;
    }

    // Bridge step 2: the page handed us its visible text nodes → translate them server-side (chunked),
    // then write the English back into the same nodes. Inputs/forms are untouched, so Apply still works.
    if (msg.type === 'XLATE_COLLECT') {
      const items: { i: string; t: string }[] = Array.isArray(msg.items) ? msg.items : [];
      if (!items.length) { setWebTranslating(false); return; }
      (async () => {
        const map: Record<string, string> = {};
        try {
          const CH = 60, chunks: { i: string; t: string }[][] = [];
          for (let k = 0; k < items.length; k += CH) chunks.push(items.slice(k, k + CH));
          // translate in small concurrent waves to stay friendly with the AI quota
          for (let k = 0; k < chunks.length; k += 4) {
            const part = await Promise.all(chunks.slice(k, k + 4).map(c => translateBatch(c)));
            part.forEach(m => Object.assign(map, m));
          }
          if (Object.keys(map).length && applyWebRef.current) {
            applyWebRef.current.injectJavaScript(buildApplyNodesJS(map));
            setWebTranslated(true); webTranslatedRef.current = true;
          } else {
            Alert.alert('Translation unavailable', "We couldn't translate this page right now. You can open it in your phone's browser to translate it there.");
          }
        } catch {}
        finally { setWebTranslating(false); }
      })();
      return;
    }

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

    if (!autofillRef.current.active) return;
    const gen = autofillRef.current.gen;

    if (msg.type === 'FIELDS') {
      // Accumulate fields across frames (main + iframe), dedupe by key, then process once they settle.
      const incoming = Array.isArray(msg.fields) ? msg.fields : [];
      for (const f of incoming) { if (f && f.key && !fieldsAccumRef.current.some((x: any) => x.key === f.key)) fieldsAccumRef.current.push(f); }
      if (fieldsTimerRef.current) clearTimeout(fieldsTimerRef.current);
      fieldsTimerRef.current = setTimeout(() => { void processFields(fieldsAccumRef.current.slice(), gen); }, 700);
    } else if (msg.type === 'FILLED') {
      // Sum FILLED across frames (main fills 0 when the form is in an iframe; the iframe fills N) —
      // debounce so we report the combined count once, not a race between frames.
      filledAccumRef.current.count += (msg.count || 0);
      if (filledTimerRef.current) clearTimeout(filledTimerRef.current);
      filledTimerRef.current = setTimeout(() => {
        const c = filledAccumRef.current.count;
        filledCountRef.current = c;
        setStep('filling', c > 0 ? 'done' : 'warn');
        // Skills live in clickable chips, not form fields — run that stage now that the text fields
        // have settled. Kept as a SEPARATE injection so a bug here can't break the working fill path.
        const sk = (smartData?.skills || []).filter(Boolean);
        if (sk.length && stillValid(gen)) {
          setStep('skills', 'active');
          try { applyWebRef.current?.injectJavaScript(skillsJs(sk)); } catch { finishFill(c, 0); }
          // If the page never answers (no skills widget), don't hang the overlay.
          if (skillsTimerRef.current) clearTimeout(skillsTimerRef.current);
          skillsTimerRef.current = setTimeout(() => { if (stillValid(gen)) { setStep('skills', 'warn'); finishFill(c, 0); } }, 12000);
        } else {
          setStep('skills', 'warn');
          finishFill(c, 0);
        }
      }, 600);
    } else if (msg.type === 'SKILLS_ADDED') {
      if (skillsTimerRef.current) { clearTimeout(skillsTimerRef.current); skillsTimerRef.current = null; }
      const n = msg.added || 0;
      setStep('skills', n > 0 ? 'done' : 'warn');
      finishFill(filledCountRef.current, n);
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
      const unavailable = () => Alert.alert(
        'Preview unavailable',
        kind === 'resume'
          ? 'Build a resume in the Resume Builder to preview it. Your uploaded resume will still be attached.'
          : 'Could not render the cover-letter preview.',
      );
      // Rendered as a background job — survives the app being minimized.
      let data: any;
      try { data = await postAndPoll(path, body, token); }
      catch { unavailable(); return; }
      const p = data?.previews?.[0];
      if (!p?.image) { unavailable(); return; }
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
      </View>
    );
  };

  // ── Open compose modal: pre-fill all fields, auto-generate CL if missing ──
  const openComposeModal = async () => {
    // Contacts → To field
    const contactEmails = (contacts || []).map(c => c.email).filter(Boolean).join(', ');
    setComposeTo(contactEmails);
    setComposeCc('');
    setComposeBcc('');
    setCcExpanded(false);
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
    setComposeSubject(`Application for ${job.title} - ${fullName}`);

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
              {visibleSkills.map((skill, i) => (
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
            <TouchableOpacity onPress={toggleTranslate} disabled={webTranslating} style={[s.webHeaderBtn, webTranslated && s.webHeaderBtnActive]} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }} activeOpacity={0.7}>
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
              injectedJavaScript={INTERCEPT_FILES_JS + '\n' + SUBMIT_DETECT_JS + '\n' + FOCUS_DETECT_JS + '\n' + AUTODETECT_JS + '\n' + FRAME_AGENT_JS}
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
                const target = e?.nativeEvent?.targetUrl;
                if (target && applyWebRef.current) {
                  applyWebRef.current.injectJavaScript(`window.location.href = ${JSON.stringify(target)}; true;`);
                }
              }}
              startInLoadingState
              pullToRefreshEnabled
              onMessage={onWebMessage}
              onLoadStart={() => setApplyLoading(true)}
              onLoadEnd={() => {
                setApplyLoading(false);
                // Grab the job page's visible text ONCE per session (the first load is the job
                // details page the user opened) → capture responsibilities for the cover letter.
                if (!capturePrefetchedRef.current && !isUuid(job.id) && applyWebRef.current) {
                  capturePrefetchedRef.current = true;
                  setTimeout(() => { try { applyWebRef.current?.injectJavaScript(GRAB_JOB_TEXT_JS); } catch {} }, 900);
                }
                // If translation is toggled ON, auto-translate each newly-loaded page (the
                // widget doesn't survive navigation, so re-inject it on every load).
                if (webTranslatedRef.current && applyWebRef.current) {
                  setWebTranslating(true);
                  setTimeout(() => { try { applyWebRef.current?.injectJavaScript(TRANSLATE_TO_EN_JS); } catch {} }, 350);
                  setTimeout(() => setWebTranslating(false), 2400);
                }
              }}
              onLoadProgress={({ nativeEvent }) => setApplyProgress(nativeEvent.progress)}
              onNavigationStateChange={(nav) => {
                setApplyCanGoBack(nav.canGoBack);
                if (nav.url) { currentUrlRef.current = nav.url; try { setApplyHost(new URL(nav.url).hostname.replace(/^www\./, '')); } catch {} }
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
              actions={[
                { key: 'autofill', icon: 'sparkles', label: 'Auto Fill', sub: 'Fill the form with AI', colors: ['#7C6BFF', '#4F8DFF'], onPress: startAutofill },
                { key: 'upload', icon: 'cloud-upload', label: 'Upload', sub: 'Résumé & cover letter', colors: ['#06B6D4', '#3B82F6'], onPress: () => setFilePick({ key: '__manual__', accept: '', label: 'Attach your résumé or cover letter' }) },
                { key: 'details', icon: 'copy-outline', label: 'My details', sub: 'Copy to any field', colors: ['#10B981', '#059669'], onPress: openSmart },
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
                  {autofillState === 'done' ? 'Done — review & submit' : autofillState === 'error' ? 'Auto-fill stopped' : 'Auto-filling your application'}
                </Text>
                {autofillState === 'running' && (
                  <Text style={s.afSub}>Reading the form and filling it with AI — a few seconds.</Text>
                )}
                {(autofillState === 'error' || (autofillState === 'done' && !!autofillNote)) && !!autofillNote && (
                  <Text style={autofillState === 'error' ? s.afErrText : s.afSub}>{autofillNote}</Text>
                )}

                <View style={s.afSteps}>
                  {AUTOFILL_STEPS.map((step) => {
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
                {autofillState === 'done' && (
                  <Text style={s.afFootHint}>Double-check the filled details, add anything marked “manually”, then submit on the page.</Text>
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
