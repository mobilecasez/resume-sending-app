// AI Hub — new feature. Safe to delete without affecting existing app.
// "Browse & Fetch" — a VISIBLE in-app browser for job-board listing pages (Indeed/Naukri/Glassdoor…):
// the user browses the list like a human, opens a job they like, then taps the floating, DRAGGABLE
// "Fetch job" bubble to capture that posting into CVApplyr (scrape → AI extract → Saved Jobs).
// The bubble warns (instead of charging) when the current page is still a LIST of jobs.
import React, { useRef, useState, useCallback } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Animated, PanResponder, Alert, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { WebView } from 'react-native-webview';
import { fetchJobDetail, type LiveJobCard } from '../services/aiHubService';
import { isListingUrl } from '../utils/jobListing';

const { height: SH } = Dimensions.get('window');

// Immediate page grab — the user has visually confirmed the job is on screen, so no challenge-waiting.
const GRAB_NOW_JS = `(function(){ try { window.ReactNativeWebView.postMessage(JSON.stringify({ __cvbf: true, url: location.href, html: (document.documentElement.outerHTML || '').slice(0, 220000) })); } catch (e) {} })(); true;`;

const normUrl = (u: string) => { try { const x = new URL(String(u || '')); return (x.origin + x.pathname).replace(/\/+$/, ''); } catch { return String(u || '').split('#')[0].replace(/\/+$/, ''); } };

export default function BrowseFetch({ visible, url, fetchCost, onClose, onFetched }: {
  visible: boolean;
  url: string;
  fetchCost: number;
  onClose: () => void;
  onFetched: (job: LiveJobCard | null, sourceUrl: string) => void;
}) {
  const webRef = useRef<WebView>(null);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [canGoBack, setCanGoBack] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const currentUrlRef = useRef(url);
  const fetchingRef = useRef(false);
  const savedUrlsRef = useRef<Set<string>>(new Set());   // don't double-charge the same posting

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
    fetchingRef.current = true; setFetching(true);
    webRef.current?.injectJavaScript(GRAB_NOW_JS);
    // Safety: if the page never posts back (rare), release the button.
    setTimeout(() => { if (fetchingRef.current) { fetchingRef.current = false; setFetching(false); } }, 20000);
  }, []);

  const onMessage = useCallback(async (raw: string) => {
    let payload: any = null; try { payload = JSON.parse(raw); } catch { return; }
    if (!payload || !payload.__cvbf || !fetchingRef.current) return;
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
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
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
          onNavigationStateChange={(nav) => { currentUrlRef.current = nav.url; setCurrentUrl(nav.url); setCanGoBack(nav.canGoBack); }}
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
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F0F4FA', paddingTop: 54 },
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
