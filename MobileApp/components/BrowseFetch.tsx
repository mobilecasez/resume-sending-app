// AI Hub — new feature. Safe to delete without affecting existing app.
// "Browse & Fetch" — a VISIBLE in-app browser for job-board pages (Indeed/Naukri/Glassdoor…): the
// user browses like a human, opens a job, then uses the floating draggable bubble → a translucent
// DOCK with two actions:
//   • Fetch job  — capture this posting into CVApplyr (scrape → AI extract → Saved Jobs)
//   • Apply here — jump into the full apply experience (AI auto-fill, resume upload, cover letter)
// Fetch failures explain WHY (login required / human check / no job on page) instead of a generic
// error. Login sessions persist in the system cookie store (sharedCookies) so signing in to
// LinkedIn/Naukri once keeps working for later jobs — even after the app restarts.
//
// ⚠️ Deliberately NOT a <Modal>: it renders as a full-screen overlay VIEW inside the caller's modal.
// A Modal nested inside another Modal crashed the app on iOS when dismissed (v3.3 build 87).
import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Animated, PanResponder, Alert, Dimensions, BackHandler, Pressable, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetchJobDetail, type LiveJobCard } from '../services/aiHubService';
import { isListingUrl } from '../utils/jobListing';

const { height: SH } = Dimensions.get('window');

// Real-browser UA (same fix as the job-detail apply WebView, commit d1f9627): Google rejects
// embedded-WebView UAs with "disallowed_useragent" — "Sign in with Google" silently dies. A clean
// platform-browser UA makes OAuth serve its redirect-based mobile flow that works in one WebView.
const BROWSER_UA = Platform.OS === 'android'
  ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
  : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

// Immediate page grab (the user has visually confirmed the job is on screen — no challenge-waiting).
// The per-fetch id lets onMessage ignore stale grabs from an earlier, abandoned fetch.
const grabNowJs = (id: number) => `(function(){ try { window.ReactNativeWebView.postMessage(JSON.stringify({ __cvbf: true, id: ${id}, url: location.href, title: String(document.title || ''), html: (document.documentElement.outerHTML || '').slice(0, 220000) })); } catch (e) {} })(); true;`;

// KEEP the query string (an Indeed job is /viewjob?jk=<id> — the query IS the job identity); drop only
// tracking params + hash + trailing slashes.
const normUrl = (u: string) => {
  try {
    const x = new URL(String(u || ''));
    const qp = new URLSearchParams(x.search);
    for (const k of [...qp.keys()]) if (/^(utm_|gclid|fbclid|msclkid|mc_|_hs|ref$|trk)/i.test(k)) qp.delete(k);
    const q = qp.toString();
    return (x.origin + x.pathname).replace(/\/+$/, '') + (q ? '?' + q : '');
  } catch { return String(u || '').split('#')[0].replace(/\/+$/, ''); }
};

// Which job platform is this page on? Shown in the dock + used in failure messages.
export function platformOf(u: string): string {
  const s = String(u || '').toLowerCase();
  if (/linkedin\.com|lnkd\.in/.test(s)) return 'LinkedIn';
  if (/naukri\.com/.test(s)) return 'Naukri';
  if (/indeed\./.test(s)) return 'Indeed';
  if (/glassdoor\./.test(s)) return 'Glassdoor';
  if (/foundit\.(in|com)|monsterindia/.test(s)) return 'foundit';
  if (/monster\./.test(s)) return 'Monster';
  if (/shine\.com/.test(s)) return 'Shine';
  if (/timesjobs\.com/.test(s)) return 'TimesJobs';
  if (/wellfound\.com/.test(s)) return 'Wellfound';
  if (/instahyre\.com/.test(s)) return 'Instahyre';
  if (/(greenhouse|lever|ashbyhq|workday|smartrecruiters|recruitee|jobvite|icims)\./.test(s)) return 'Company portal';
  try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch { return 'this site'; }
}

// Why did the page not yield a job? Inspect the grabbed HTML BEFORE spending a credit.
function diagnosePage(html: string): 'login' | 'challenge' | null {
  const h = String(html || '');
  const text = h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 6000);
  if (/just a moment|verify (that )?you.?re (a )?human|are you a robot|unusual traffic|checking your browser|attention required|px-captcha|hcaptcha|recaptcha/i.test(text)) return 'challenge';
  const hasPassword = /<input[^>]+type=["']?password/i.test(h);
  const loginWords = /authwall|sign in to (view|continue|apply)|log ?in to (view|continue|apply)|join now to view|login to apply|register to apply|create an account to/i.test(text);
  if (loginWords || (hasPassword && text.length < 2500)) return 'login';
  return null;
}

export default function BrowseFetch({ url, fetchCost, onClose, onFetched, onApplyHere }: {
  url: string;
  fetchCost: number;
  onClose: () => void;
  onFetched: (job: LiveJobCard | null, sourceUrl: string) => void;
  onApplyHere?: (applyUrl: string, pageTitle: string) => void;
}) {
  const webRef = useRef<WebView>(null);
  const insets = useSafeAreaInsets();
  const [currentUrl, setCurrentUrl] = useState(url);
  const [canGoBack, setCanGoBack] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const currentUrlRef = useRef(url);
  const currentTitleRef = useRef('');
  const canGoBackRef = useRef(false);
  const fetchingRef = useRef(false);
  const savedUrlsRef = useRef<Set<string>>(new Set());   // don't double-charge the same posting
  const fetchIdRef = useRef(0);                          // per-fetch nonce (stale grabs are ignored)
  const grabTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const platform = platformOf(currentUrl);

  // While a fetch is running, back/close are BLOCKED — leaving the page mid-grab loses the fetch.
  const guardBusy = useCallback((): boolean => {
    if (!fetchingRef.current) return false;
    Alert.alert('Fetching in progress', 'Please wait a few seconds — your job is being read and saved.');
    return true;
  }, []);

  // Android hardware back: blocked while fetching; else web-history back first, then close.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (fetchingRef.current) { guardBusy(); return true; }
      if (canGoBackRef.current) { webRef.current?.goBack(); return true; }
      onClose();
      return true;
    });
    return () => { sub.remove(); if (grabTimerRef.current) clearTimeout(grabTimerRef.current); };
  }, [onClose, guardBusy]);

  // Draggable bubble (same pattern as the Help assistant): drag moves it, a TAP opens the dock.
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const moved = useRef(false);
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
      onPanResponderGrant: () => {
        moved.current = false;
        pan.setOffset({ x: (pan.x as any).__getValue(), y: (pan.y as any).__getValue() });
        pan.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: (e, g) => {
        if (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4) moved.current = true;
        pan.setValue({ x: g.dx, y: g.dy });
      },
      onPanResponderRelease: () => {
        pan.flattenOffset();
        if (!moved.current) { if (!fetchingRef.current) setDockOpen((o) => !o); }
      },
    })
  ).current;

  const doGrab = useCallback(() => {
    const id = ++fetchIdRef.current;
    fetchingRef.current = true; setFetching(true);
    webRef.current?.injectJavaScript(grabNowJs(id));
    // Safety net ONLY for "the page never posted back" — cleared the moment the grab arrives
    // (the backend extraction can legitimately take >20s and must not be interrupted).
    if (grabTimerRef.current) clearTimeout(grabTimerRef.current);
    grabTimerRef.current = setTimeout(() => {
      if (fetchingRef.current && fetchIdRef.current === id) {
        fetchingRef.current = false; setFetching(false);
        Alert.alert('Page didn’t respond', 'The page didn’t hand over its content. Reload it and try again.');
      }
    }, 20000);
  }, []);

  const fetchCurrent = useCallback(() => {
    if (fetchingRef.current) return;
    setDockOpen(false);
    const u = currentUrlRef.current;
    if (savedUrlsRef.current.has(normUrl(u))) {
      Alert.alert('Already saved', 'This job is already in your Saved Jobs.');
      return;
    }
    // The URL LOOKS like a list — but SPA boards (Glassdoor/Indeed) open a job without changing the
    // URL, so this can be wrong. CONFIRM instead of blocking: the user can see what's on screen.
    if (isListingUrl(u)) {
      Alert.alert(
        'Is one job open?',
        'This page looks like a list of jobs. If you have a specific job open, go ahead and fetch it.',
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Fetch this job', onPress: doGrab }],
      );
      return;
    }
    doGrab();
  }, [doGrab]);

  const applyHere = useCallback(() => {
    if (guardBusy()) return;
    setDockOpen(false);
    onApplyHere?.(currentUrlRef.current, currentTitleRef.current);
  }, [onApplyHere, guardBusy]);

  const onMessage = useCallback(async (raw: string) => {
    let payload: any = null; try { payload = JSON.parse(raw); } catch { return; }
    if (!payload || !payload.__cvbf || !fetchingRef.current) return;
    if (payload.id !== fetchIdRef.current) return;   // stale grab from an earlier, abandoned fetch
    if (grabTimerRef.current) { clearTimeout(grabTimerRef.current); grabTimerRef.current = null; }
    const srcUrl = String(payload.url || currentUrlRef.current);
    const plat = platformOf(srcUrl);
    // Diagnose BEFORE calling the backend — a login wall / bot check can't yield a job (and must
    // not cost a credit). Tell the user exactly what to do about it.
    const problem = diagnosePage(String(payload.html || ''));
    if (problem === 'login') {
      fetchingRef.current = false; setFetching(false);
      Alert.alert(
        `${plat} asks you to log in`,
        `This job is protected — ${plat} wants a login before showing it.\n\n• Log in on this page (CVApplyr remembers your session, even after you close the app), then tap “Fetch job” again.\n• Or tap “Apply here” to open the application with AI auto-fill.`,
      );
      return;
    }
    if (problem === 'challenge') {
      fetchingRef.current = false; setFetching(false);
      Alert.alert(
        `${plat} is checking you’re human`,
        'Complete the check shown on the page, wait for the job to appear, then tap “Fetch job” again.',
      );
      return;
    }
    try {
      const job = await fetchJobDetail(srcUrl, String(payload.html || ''), '');
      fetchingRef.current = false; setFetching(false);
      if (job) {
        savedUrlsRef.current.add(normUrl(srcUrl));
        setJustSaved(true); setTimeout(() => setJustSaved(false), 2600);
        onFetched(job, srcUrl);
      } else {
        Alert.alert('No job found on this page', `We couldn’t read a job posting here. Open the job’s own page on ${plat} and try again — or use “Apply here” to apply directly.`);
        onFetched(null, srcUrl);
      }
    } catch (e: any) {
      fetchingRef.current = false; setFetching(false);
      if (e && e.insufficient) {
        Alert.alert('Not enough credits', `Fetching a job costs ${fetchCost || 1} credit${(fetchCost || 1) === 1 ? '' : 's'}. You have ${e.creditsRemaining ?? 0}. Top up in Account → Credits.`);
      } else {
        Alert.alert('Could not fetch', 'Something went wrong reading this page. Please try again.');
      }
    }
  }, [fetchCost, onFetched]);

  let host = ''; try { host = new URL(currentUrl).hostname.replace(/^www\./, ''); } catch {}

  return (
    <View style={[StyleSheet.absoluteFillObject, styles.root, { paddingTop: Math.max(insets.top, 14) }]}>
      {/* top bar */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => { if (guardBusy()) return; canGoBack ? webRef.current?.goBack() : onClose(); }} style={[styles.navBtn, fetching && styles.navBtnOff]} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={20} color={fetching ? '#94A3B8' : '#0F172A'} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.host} numberOfLines={1}>{platform}</Text>
          <Text style={styles.hint} numberOfLines={1}>{host}</Text>
        </View>
        <TouchableOpacity onPress={() => { if (!fetching) webRef.current?.reload(); }} style={[styles.navBtn, fetching && styles.navBtnOff]} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="refresh" size={17} color={fetching ? '#94A3B8' : '#0F172A'} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { if (guardBusy()) return; onClose(); }} style={[styles.navBtn, fetching && styles.navBtnOff]} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="close" size={20} color={fetching ? '#94A3B8' : '#0F172A'} />
        </TouchableOpacity>
      </View>
      {pageLoading && <View style={styles.progress}><ActivityIndicator size="small" color="#06B6D4" /></View>}

      <WebView
        ref={webRef}
        source={{ uri: url }}
        style={{ flex: 1 }}
        onNavigationStateChange={(nav) => {
          currentUrlRef.current = nav.url; canGoBackRef.current = nav.canGoBack;
          currentTitleRef.current = String(nav.title || '');
          setCurrentUrl(nav.url); setCanGoBack(nav.canGoBack);
        }}
        onLoadStart={() => setPageLoading(true)}
        onLoadEnd={() => setPageLoading(false)}
        onMessage={(e) => onMessage(e.nativeEvent.data)}
        javaScriptEnabled
        domStorageEnabled
        // Persist logins: cookies live in the system web store, SHARED across all our WebViews and
        // surviving app restarts — log in to LinkedIn/Naukri once, stay logged in for future jobs.
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        originWhitelist={['*']}
        allowsBackForwardNavigationGestures
        // OAuth (Google/Apple/Microsoft) support — same fix as the apply WebView: clean browser UA,
        // popups allowed, and popup windows loaded IN THIS WebView (iOS drops them by default →
        // "nothing happens" / endless spinner on Sign in with Google/Apple).
        userAgent={BROWSER_UA}
        javaScriptCanOpenWindowsAutomatically
        setSupportMultipleWindows={false}
        onOpenWindow={(e: any) => {
          const target = e?.nativeEvent?.targetUrl;
          if (target && webRef.current) {
            webRef.current.injectJavaScript(`window.location.href = ${JSON.stringify(target)}; true;`);
          }
        }}
      />

      {/* ── translucent DOCK (iOS-style sheet above the bubble) ── */}
      {dockOpen && (
        <Pressable style={styles.dockBackdrop} onPress={() => setDockOpen(false)}>
          <Pressable style={[styles.dock, { paddingBottom: Math.max(insets.bottom, 12) }]} onPress={() => {}}>
            <View style={styles.dockGrip} />
            <View style={styles.dockHead}>
              <View style={styles.dockPlatIcon}><Ionicons name="globe-outline" size={15} color="#22D3EE" /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.dockPlatName} numberOfLines={1}>{platform}</Text>
                <Text style={styles.dockPlatHost} numberOfLines={1}>{host}</Text>
              </View>
              <TouchableOpacity onPress={() => setDockOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={19} color="rgba(255,255,255,0.6)" />
              </TouchableOpacity>
            </View>
            <View style={styles.dockRow}>
              <TouchableOpacity style={styles.dockItem} onPress={fetchCurrent} activeOpacity={0.85}>
                <LinearGradient colors={['#06B6D4', '#3B82F6']} style={styles.dockItemIcon}>
                  <Ionicons name="sparkles" size={22} color="#fff" />
                </LinearGradient>
                <Text style={styles.dockItemTitle}>Fetch job</Text>
                <Text style={styles.dockItemSub}>{fetchCost > 0 ? `Save to CVApplyr · ${fetchCost} cr` : 'Save to CVApplyr'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.dockItem} onPress={applyHere} activeOpacity={0.85}>
                <LinearGradient colors={['#7C6BFF', '#EC4899']} style={styles.dockItemIcon}>
                  <Ionicons name="flash" size={22} color="#fff" />
                </LinearGradient>
                <Text style={styles.dockItemTitle}>Apply here</Text>
                <Text style={styles.dockItemSub}>AI auto-fill + resume</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.dockHint}>Open a specific job first, then fetch it or apply with auto-fill.</Text>
          </Pressable>
        </Pressable>
      )}

      {/* draggable bubble — opens the dock */}
      <Animated.View style={[styles.fabWrap, { transform: pan.getTranslateTransform() }]} {...responder.panHandlers}>
        <View style={styles.fabInner}>
          <LinearGradient colors={justSaved ? ['#10B981', '#059669'] : ['#06B6D4', '#3B82F6']} style={styles.fabCircle}>
            {fetching
              ? <ActivityIndicator size="small" color="#fff" />
              : <Ionicons name={justSaved ? 'checkmark' : 'apps'} size={22} color="#fff" />}
          </LinearGradient>
          <View style={styles.fabLabel}>
            <Text style={styles.fabLabelTx}>
              {fetching ? 'Fetching…' : justSaved ? 'Saved ✓' : 'Job tools'}
            </Text>
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#F0F4FA', zIndex: 100, elevation: 100 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 10, gap: 4, backgroundColor: '#F0F4FA' },
  navBtn: { width: 36, height: 36, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  navBtnOff: { opacity: 0.55 },
  host: { fontSize: 13.5, fontWeight: '800', color: '#0F172A' },
  hint: { fontSize: 10.5, color: '#64748B', marginTop: 1 },
  progress: { position: 'absolute', top: 100, alignSelf: 'center', zIndex: 5, backgroundColor: '#fff', borderRadius: 14, padding: 8, shadowColor: '#0F172A', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 10, elevation: 6 },
  fabWrap: { position: 'absolute', right: 14, bottom: Math.min(SH * 0.16, 140), zIndex: 30 },
  fabInner: { alignItems: 'center' },
  fabCircle: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 14, elevation: 10 },
  fabLabel: { marginTop: 5, backgroundColor: '#0B0F22', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3.5 },
  fabLabelTx: { fontSize: 10.5, fontWeight: '800', color: '#fff' },
  // dock
  dockBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(6,10,25,0.35)', justifyContent: 'flex-end', zIndex: 40 },
  dock: { marginHorizontal: 10, marginBottom: 10, borderRadius: 26, backgroundColor: 'rgba(11,15,34,0.94)', paddingHorizontal: 16, paddingTop: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.4, shadowRadius: 28, elevation: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  dockGrip: { alignSelf: 'center', width: 40, height: 4.5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)', marginBottom: 10 },
  dockHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  dockPlatIcon: { width: 30, height: 30, borderRadius: 10, backgroundColor: 'rgba(34,211,238,0.14)', alignItems: 'center', justifyContent: 'center' },
  dockPlatName: { fontSize: 14.5, fontWeight: '800', color: '#fff' },
  dockPlatHost: { fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 1 },
  dockRow: { flexDirection: 'row', gap: 10 },
  dockItem: { flex: 1, backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 18, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)' },
  dockItemIcon: { width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  dockItemTitle: { fontSize: 13.5, fontWeight: '800', color: '#fff' },
  dockItemSub: { fontSize: 10.5, color: 'rgba(255,255,255,0.55)', marginTop: 2, textAlign: 'center' },
  dockHint: { fontSize: 10.5, color: 'rgba(255,255,255,0.45)', textAlign: 'center', marginTop: 12, marginBottom: 2 },
});
