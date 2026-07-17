// AI Hub — new feature. Safe to delete without affecting existing app.
// "Browse & Fetch" — a VISIBLE in-app browser for job-board listing pages (Indeed/Naukri/Glassdoor…):
// the user browses the list like a human, opens a job they like, then taps the floating, DRAGGABLE
// "Fetch job" bubble to capture that posting into CVApplyr (scrape → AI extract → Saved Jobs).
// The bubble warns (instead of charging) when the current page is still a LIST of jobs.
//
// ⚠️ Deliberately NOT a <Modal>: it renders as a full-screen overlay VIEW inside the caller's modal.
// A Modal nested inside another Modal crashed the app on iOS when dismissed (v3.3 build 87 report:
// "picked a few jobs → closed the webview → app crashed") — plain-view unmount cannot. Mount it
// conditionally ({open && <BrowseFetch …/>}) so each session starts with fresh state.
import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Animated, PanResponder, Alert, Dimensions, BackHandler,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetchJobDetail, type LiveJobCard } from '../services/aiHubService';
import { isListingUrl } from '../utils/jobListing';

const { height: SH } = Dimensions.get('window');

// Immediate page grab (the user has visually confirmed the job is on screen — no challenge-waiting).
// The per-fetch id lets onMessage ignore stale grabs from an earlier, abandoned fetch.
const grabNowJs = (id: number) => `(function(){ try { window.ReactNativeWebView.postMessage(JSON.stringify({ __cvbf: true, id: ${id}, url: location.href, html: (document.documentElement.outerHTML || '').slice(0, 220000) })); } catch (e) {} })(); true;`;

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

export default function BrowseFetch({ url, fetchCost, onClose, onFetched }: {
  url: string;
  fetchCost: number;
  onClose: () => void;
  onFetched: (job: LiveJobCard | null, sourceUrl: string) => void;
}) {
  const webRef = useRef<WebView>(null);
  const insets = useSafeAreaInsets();
  const [currentUrl, setCurrentUrl] = useState(url);
  const [canGoBack, setCanGoBack] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const currentUrlRef = useRef(url);
  const canGoBackRef = useRef(false);
  const fetchingRef = useRef(false);
  const savedUrlsRef = useRef<Set<string>>(new Set());   // don't double-charge the same posting
  const fetchIdRef = useRef(0);                          // per-fetch nonce (stale grabs are ignored)
  const grabTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Android hardware back: back in web history first, then close the browser (we're not a Modal, so
  // there's no onRequestClose — handle it explicitly while mounted).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBackRef.current) { webRef.current?.goBack(); return true; }
      onClose();
      return true;
    });
    return () => { sub.remove(); if (grabTimerRef.current) clearTimeout(grabTimerRef.current); };
  }, [onClose]);

  // Draggable bubble (same pattern as the Help assistant): drag moves it, a TAP (no movement) fetches.
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
        if (!moved.current) fetchCurrent();
      },
    })
  ).current;

  const fetchCurrent = useCallback(() => {
    if (fetchingRef.current) return;
    const u = currentUrlRef.current;
    if (savedUrlsRef.current.has(normUrl(u))) {
      Alert.alert('Already saved', 'This job is already in your Saved Jobs.');
      return;
    }
    if (isListingUrl(u)) {
      Alert.alert('This is a list of jobs', 'Open one specific job first, then tap “Fetch job” to save it.');
      return;
    }
    const id = ++fetchIdRef.current;
    fetchingRef.current = true; setFetching(true);
    webRef.current?.injectJavaScript(grabNowJs(id));
    // Safety net ONLY for "the page never posted back" — cleared the moment the grab arrives
    // (the backend extraction can legitimately take >20s and must not be interrupted).
    if (grabTimerRef.current) clearTimeout(grabTimerRef.current);
    grabTimerRef.current = setTimeout(() => {
      if (fetchingRef.current && fetchIdRef.current === id) { fetchingRef.current = false; setFetching(false); }
    }, 20000);
  }, []);

  const onMessage = useCallback(async (raw: string) => {
    let payload: any = null; try { payload = JSON.parse(raw); } catch { return; }
    if (!payload || !payload.__cvbf || !fetchingRef.current) return;
    if (payload.id !== fetchIdRef.current) return;   // stale grab from an earlier, abandoned fetch
    if (grabTimerRef.current) { clearTimeout(grabTimerRef.current); grabTimerRef.current = null; }
    const srcUrl = String(payload.url || currentUrlRef.current);
    try {
      const job = await fetchJobDetail(srcUrl, String(payload.html || ''), '');
      fetchingRef.current = false; setFetching(false);
      if (job) {
        savedUrlsRef.current.add(normUrl(srcUrl));
        setJustSaved(true); setTimeout(() => setJustSaved(false), 2600);
        onFetched(job, srcUrl);
      } else {
        Alert.alert('No job found here', 'We couldn’t read a job posting on this page. Open the job’s own page and try again.');
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
        <TouchableOpacity onPress={() => (canGoBack ? webRef.current?.goBack() : onClose())} style={styles.navBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={20} color="#0F172A" />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.host} numberOfLines={1}>{host || 'browser'}</Text>
          <Text style={styles.hint} numberOfLines={1}>Open a job, then tap “Fetch job”</Text>
        </View>
        <TouchableOpacity onPress={() => webRef.current?.reload()} style={styles.navBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="refresh" size={17} color="#0F172A" />
        </TouchableOpacity>
        <TouchableOpacity onPress={onClose} style={styles.navBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="close" size={20} color="#0F172A" />
        </TouchableOpacity>
      </View>
      {pageLoading && <View style={styles.progress}><ActivityIndicator size="small" color="#06B6D4" /></View>}

      <WebView
        ref={webRef}
        source={{ uri: url }}
        style={{ flex: 1 }}
        onNavigationStateChange={(nav) => { currentUrlRef.current = nav.url; canGoBackRef.current = nav.canGoBack; setCurrentUrl(nav.url); setCanGoBack(nav.canGoBack); }}
        onLoadStart={() => setPageLoading(true)}
        onLoadEnd={() => setPageLoading(false)}
        onMessage={(e) => onMessage(e.nativeEvent.data)}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        allowsBackForwardNavigationGestures
      />

      {/* draggable "Fetch job" bubble */}
      <Animated.View style={[styles.fabWrap, { transform: pan.getTranslateTransform() }]} {...responder.panHandlers}>
        <View style={styles.fabInner}>
          <LinearGradient colors={justSaved ? ['#10B981', '#059669'] : ['#06B6D4', '#3B82F6']} style={styles.fabCircle}>
            {fetching
              ? <ActivityIndicator size="small" color="#fff" />
              : <Ionicons name={justSaved ? 'checkmark' : 'sparkles'} size={22} color="#fff" />}
          </LinearGradient>
          <View style={styles.fabLabel}>
            <Text style={styles.fabLabelTx}>
              {fetching ? 'Fetching…' : justSaved ? 'Saved ✓' : `Fetch job${fetchCost > 0 ? ` · ${fetchCost} cr` : ''}`}
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
  host: { fontSize: 13.5, fontWeight: '800', color: '#0F172A' },
  hint: { fontSize: 10.5, color: '#64748B', marginTop: 1 },
  progress: { position: 'absolute', top: 100, alignSelf: 'center', zIndex: 5, backgroundColor: '#fff', borderRadius: 14, padding: 8, shadowColor: '#0F172A', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 10, elevation: 6 },
  fabWrap: { position: 'absolute', right: 14, bottom: Math.min(SH * 0.16, 140), zIndex: 30 },
  fabInner: { alignItems: 'center' },
  fabCircle: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 14, elevation: 10 },
  fabLabel: { marginTop: 5, backgroundColor: '#0B0F22', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3.5 },
  fabLabelTx: { fontSize: 10.5, fontWeight: '800', color: '#fff' },
});
