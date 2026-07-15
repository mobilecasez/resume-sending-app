// AI Hub — new feature. Safe to delete without affecting existing app.
// "Look for live jobs on Google" — a rich, interactive modal. The web browser is the ENGINE, never the
// UI: the search comes back as structured cards rendered in OUR style (the raw Google page is never
// shown). The user multi-selects cards and taps "Fetch details" → each posting is opened ONE AT A TIME
// in a hidden on-device WebView (the user's own IP → no bot wall), the page HTML is scraped, sent to the
// backend for AI extraction, STORED, and shown back as a full our-style job card.
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, Animated, Easing, Dimensions, AppState,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { liveSearchJobs, fetchJobDetail, type LiveJobCard } from '../services/aiHubService';
import { notifyLocal } from '../services/pushNotificationService';

const { height: SH } = Dimensions.get('window');
type FetchState = 'idle' | 'fetching' | 'done' | 'failed';

// Grab the fully-rendered page HTML once the page has actually rendered (SPAs like arbeitsagentur/get-in-it
// load their content via JS). Polls until readyState=complete AND the body has real text, up to a 9s cap —
// so fast pages return quickly and slow SPAs still get captured (a fixed short delay was missing them).
const GRAB_JS = `(function(){
  var START = Date.now(), MAXW = 9000;
  function grab(){ try { window.ReactNativeWebView.postMessage(JSON.stringify({ __cvd:true, url: location.href, html: (document.documentElement.outerHTML||'').slice(0,220000) })); } catch(e){} }
  var blocked = /captcha|unusual traffic|are you a robot|verify you are human/i.test(document.body ? document.body.innerText : '');
  if (blocked) { setTimeout(grab, 400); return; }
  function ready(){ try { var t = (document.body && document.body.innerText) || ''; return document.readyState === 'complete' && t.replace(/\\s+/g,' ').trim().length > 500; } catch(e){ return false; } }
  (function wait(){ if (ready() || Date.now()-START > MAXW) setTimeout(grab, 250); else setTimeout(wait, 300); })();
})(); true;`;

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export default function LiveJobSearch({ visible, query, onClose }: { visible: boolean; query: string; onClose: () => void }) {
  const CONCURRENCY = 5;   // fetch up to 5 selected postings at once (was one-at-a-time)
  const [phase, setPhase] = useState<'searching' | 'results' | 'error'>('searching');
  const [cards, setCards] = useState<LiveJobCard[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, LiveJobCard>>({});
  const [fstate, setFstate] = useState<Record<string, FetchState>>({});
  const [fetching, setFetching] = useState(false);
  const [activeUrls, setActiveUrls] = useState<string[]>([]);   // urls with a live hidden WebView (≤ CONCURRENCY)
  const [webGen, setWebGen] = useState(0);                      // bump → remount WebViews (resume after background)
  const queueRef = useRef<string[]>([]);
  const activeRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const detailsRef = useRef<Record<string, LiveJobCard>>({});
  const fstateRef = useRef<Record<string, FetchState>>({});
  const cardsRef = useRef<LiveJobCard[]>([]);
  const fetchingRef = useRef(false);
  const queryRef = useRef(query);
  const batchRef = useRef<string[]>([]);   // urls in the current fetch batch (for the completion notification)
  const retryRef = useRef<Record<string, number>>({});   // per-url auto-retry count (retry once before failing)

  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => { cardsRef.current = cards; }, [cards]);
  useEffect(() => { queryRef.current = query; }, [query]);

  // Persist completed fetches so progress survives app minimize / restart (restored on open, below).
  const persistKey = () => 'live_fetch_v1:' + String(queryRef.current || '').trim().toLowerCase();
  const saveProgress = () => { AsyncStorage.setItem(persistKey(), JSON.stringify({ details: detailsRef.current, fstate: fstateRef.current })).catch(() => {}); };
  const setFetchingBoth = (v: boolean) => { fetchingRef.current = v; setFetching(v); };

  // ── run the live search when opened ──
  useEffect(() => {
    if (!visible) return;
    setPhase('searching'); setCards([]); setSelected(new Set());
    setDetails({}); detailsRef.current = {};
    setFstate({}); fstateRef.current = {};
    setFetchingBoth(false); setActiveUrls([]); activeRef.current = new Set(); queueRef.current = [];
    Object.values(timersRef.current).forEach(clearTimeout); timersRef.current = {};
    let alive = true;
    (async () => {
      // restore any saved fetch progress for THIS query (survives minimize / app restart)
      try {
        const raw = await AsyncStorage.getItem('live_fetch_v1:' + String(query || '').trim().toLowerCase());
        if (alive && raw) { const p = JSON.parse(raw); if (p && p.details) { detailsRef.current = p.details; setDetails(p.details); } if (p && p.fstate) { fstateRef.current = p.fstate; setFstate(p.fstate); } }
      } catch (_) {}
      try {
        const r = await liveSearchJobs(query);
        if (!alive) return;
        setCards(r.cards || []); cardsRef.current = r.cards || [];
        setPhase((r.cards && r.cards.length) ? 'results' : 'error');
      } catch { if (alive) setPhase('error'); }
    })();
    return () => { alive = false; Object.values(timersRef.current).forEach(clearTimeout); };
  }, [visible, query]);

  // ── searching animation ──
  useEffect(() => {
    if (phase !== 'searching') return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [phase, pulse]);

  const toggle = useCallback((url: string) => {
    setSelected((prev) => { const n = new Set(prev); n.has(url) ? n.delete(url) : n.add(url); return n; });
  }, []);
  const selectAll = useCallback(() => {
    setSelected((prev) => prev.size === cards.length ? new Set() : new Set(cards.map((c) => c.job_url)));
  }, [cards]);

  // ── fetch selected cards, up to CONCURRENCY at a time, via hidden on-device WebViews ──
  const PAGE_TIMEOUT = 20000;
  // Fill open slots from the queue (mounts a hidden WebView per active url).
  function pump() {
    while (activeRef.current.size < CONCURRENCY && queueRef.current.length) {
      const u = queueRef.current.shift() as string;
      activeRef.current.add(u);
      fstateRef.current = { ...fstateRef.current, [u]: 'fetching' };
      setFstate((s) => ({ ...s, [u]: 'fetching' }));
      timersRef.current[u] = setTimeout(() => finish(u, false), PAGE_TIMEOUT);
    }
    setActiveUrls([...activeRef.current]);
    if (activeRef.current.size === 0 && queueRef.current.length === 0) {
      setFetchingBoth(false);
      // Batch finished → tell the user (fires even if they'd minimized and just returned).
      const batch = batchRef.current;
      if (batch.length) {
        const done = batch.filter((u) => fstateRef.current[u] === 'done').length;
        notifyLocal('Live jobs fetched', `${done} of ${batch.length} job${batch.length > 1 ? 's' : ''} saved — find them in Saved Jobs.`, { type: 'live_fetch_done', query: queryRef.current });
        batchRef.current = [];
      }
    }
  }
  // Resolve one url (done or failed), persist, and pull the next from the queue.
  function finish(url: string, ok: boolean, job?: LiveJobCard | null) {
    if (!activeRef.current.has(url)) return;   // already handled
    if (timersRef.current[url]) { clearTimeout(timersRef.current[url]); delete timersRef.current[url]; }
    activeRef.current.delete(url);
    // One automatic retry before giving up (a fresh WebView — key includes the retry count — reloads the
    // page; handles SPA/timing misses that failed the first pass).
    if (!ok && (retryRef.current[url] || 0) < 1) {
      retryRef.current[url] = (retryRef.current[url] || 0) + 1;
      queueRef.current.unshift(url);
      pump();
      return;
    }
    if (ok && job) { detailsRef.current = { ...detailsRef.current, [url]: job }; setDetails((d) => ({ ...d, [url]: job })); }
    fstateRef.current = { ...fstateRef.current, [url]: ok ? 'done' : 'failed' };
    setFstate((s) => ({ ...s, [url]: ok ? 'done' : 'failed' }));
    saveProgress();
    pump();
  }
  function startFetch() {
    const urls = cardsRef.current.map((c) => c.job_url).filter((u) => selected.has(u) && fstateRef.current[u] !== 'done');
    if (!urls.length) return;
    queueRef.current = urls;
    batchRef.current = urls.slice();
    setFetchingBoth(true);
    pump();
  }
  async function onGrab(sourceUrl: string, raw: string) {
    let payload: any = null; try { payload = JSON.parse(raw); } catch { return; }
    if (!payload || !payload.__cvd) return;
    if (!activeRef.current.has(sourceUrl)) return;   // stale / already finished
    if (timersRef.current[sourceUrl]) { clearTimeout(timersRef.current[sourceUrl]); delete timersRef.current[sourceUrl]; }
    const card = cardsRef.current.find((c) => c.job_url === sourceUrl);
    try {
      const job = await fetchJobDetail(sourceUrl, String(payload.html || ''), card?.company || card?.employer_name || '');
      finish(sourceUrl, !!job, job || null);
    } catch { finish(sourceUrl, false, null); }
  }

  // Keep fetching alive across app minimize/restore: iOS pauses background WebViews & timers, so on return
  // we re-arm timers and REMOUNT the in-flight WebViews (webGen bump) to resume the scrape, then keep pumping.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        if (fetchingRef.current && (activeRef.current.size > 0 || queueRef.current.length > 0)) {
          activeRef.current.forEach((u) => {
            if (timersRef.current[u]) clearTimeout(timersRef.current[u]);
            timersRef.current[u] = setTimeout(() => finish(u, false), PAGE_TIMEOUT);
          });
          setWebGen((g) => g + 1);
          pump();
        }
      } else {
        Object.values(timersRef.current).forEach(clearTimeout);
        timersRef.current = {};   // don't let suspended time count as timeouts
      }
    });
    return () => sub.remove();
  }, []);

  const doneCount = Object.values(fstate).filter((s) => s === 'done').length;

  const renderCard = ({ item }: { item: LiveJobCard }) => {
    const isSel = selected.has(item.job_url);
    const st = fstate[item.job_url] || 'idle';
    const det = details[item.job_url];
    const highlights = (det?.responsibilities?.length ? det.responsibilities : item.highlights) || [];
    return (
      <TouchableOpacity activeOpacity={0.85} onPress={() => toggle(item.job_url)} style={[styles.card, isSel && styles.cardSel]}>
        <View style={styles.cardTop}>
          <View style={[styles.check, isSel && styles.checkOn]}>
            {isSel && <Ionicons name="checkmark" size={13} color="#fff" />}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle} numberOfLines={3}>{det?.title || item.title}</Text>
            <Text style={styles.cardCompany} numberOfLines={2}>{det?.company || item.company || item.employer_name || 'Employer'}</Text>
            {!!(det?.location || item.location) && (
              <View style={styles.cardLocRow}>
                <Ionicons name="location-outline" size={11} color="#94A3B8" style={{ marginTop: 1 }} />
                <Text style={styles.cardLoc} numberOfLines={2}>{det?.location || item.location}</Text>
              </View>
            )}
          </View>
          {st === 'done' && <View style={styles.badgeDone}><Ionicons name="checkmark-circle" size={12} color="#059669" /><Text style={styles.badgeDoneTx}>Saved</Text></View>}
          {st === 'fetching' && <ActivityIndicator size="small" color="#06B6D4" />}
          {st === 'failed' && <Ionicons name="alert-circle-outline" size={16} color="#F59E0B" />}
        </View>
        {(det || highlights.length > 0) && (
          <View style={styles.cardBody}>
            {!!det && (
              <View style={styles.metaRow}>
                {!!det.job_type && <Text style={styles.metaPill}>{det.job_type}</Text>}
                {!!det.work_mode && <Text style={styles.metaPill}>{det.work_mode}</Text>}
                {!!det.salary && <Text style={styles.metaPill}>{det.salary}</Text>}
              </View>
            )}
            {highlights.slice(0, det ? 4 : 2).map((h, i) => (
              <Text key={i} style={styles.highlight} numberOfLines={2}>• {String(h).replace(/<[^>]+>/g, '')}</Text>
            ))}
            {!!det?.skills?.length && <Text style={styles.skills} numberOfLines={1}>{det.skills.slice(0, 6).join(' · ')}</Text>}
          </View>
        )}
        <View style={styles.srcRow}>
          <Ionicons name="globe-outline" size={11} color="#94A3B8" />
          <Text style={styles.srcTx}>{item.source || 'web'}</Text>
          {st === 'idle' && <Text style={styles.tapHint}>tap to select</Text>}
        </View>
      </TouchableOpacity>
    );
  };

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  const selCount = selected.size;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          {/* header */}
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.hTitle}>Live jobs on the web</Text>
              <Text style={styles.hSub} numberOfLines={1}>“{query}”</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={24} color="#64748B" />
            </TouchableOpacity>
          </View>

          {phase === 'searching' && (
            <View style={styles.center}>
              <Animated.View style={{ transform: [{ scale }], opacity }}>
                <LinearGradient colors={['#06B6D4', '#3B82F6']} style={styles.pulseCircle}>
                  <Ionicons name="search" size={30} color="#fff" />
                </LinearGradient>
              </Animated.View>
              <Text style={styles.searchingTx}>Searching the live web…</Text>
              <Text style={styles.searchingSub}>Finding real, current openings and formatting them for you.</Text>
            </View>
          )}

          {phase === 'error' && (
            <View style={styles.center}>
              <Ionicons name="cloud-offline-outline" size={40} color="#CBD5E1" />
              <Text style={styles.searchingTx}>No live results right now</Text>
              <Text style={styles.searchingSub}>Try a broader search, or check your feed — it may already have matches.</Text>
              <TouchableOpacity style={styles.retryBtn} onPress={onClose}><Text style={styles.retryTx}>Close</Text></TouchableOpacity>
            </View>
          )}

          {phase === 'results' && (
            <>
              <View style={styles.subBar}>
                <Text style={styles.subBarTx}>{cards.length} found{doneCount ? ` · ${doneCount} fetched` : ''}</Text>
                <TouchableOpacity onPress={selectAll}><Text style={styles.selAll}>{selected.size === cards.length ? 'Clear' : 'Select all'}</Text></TouchableOpacity>
              </View>
              <FlatList
                data={cards}
                keyExtractor={(c) => c.job_url}
                renderItem={renderCard}
                contentContainerStyle={{ padding: 14, paddingBottom: 100 }}
                showsVerticalScrollIndicator={false}
              />
              <View style={styles.footer}>
                <TouchableOpacity disabled={!selCount || fetching} activeOpacity={0.85} onPress={startFetch} style={{ flex: 1 }}>
                  <LinearGradient colors={(!selCount || fetching) ? ['#CBD5E1', '#CBD5E1'] : ['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.fetchBtn}>
                    {fetching
                      ? <><ActivityIndicator size="small" color="#fff" /><Text style={styles.fetchTx}>Fetching… {doneCount ? `(${doneCount} done)` : ''}</Text></>
                      : <><Ionicons name="download-outline" size={18} color="#fff" /><Text style={styles.fetchTx}>{selCount ? `Fetch details (${selCount})` : 'Select jobs to fetch'}</Text></>}
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </>
          )}

          {/* hidden on-device fetchers — up to CONCURRENCY pages at once, on the user's IP.
              Keyed by webGen so an AppState resume remounts them (iOS pauses background WebViews). */}
          {activeUrls.map((url) => (
            <View key={webGen + '|' + (retryRef.current[url] || 0) + '|' + url} style={styles.hiddenWeb} pointerEvents="none">
              <WebView
                source={{ uri: url }}
                injectedJavaScript={GRAB_JS}
                onMessage={(e) => onGrab(url, e.nativeEvent.data)}
                userAgent={MOBILE_UA}
                javaScriptEnabled
                domStorageEnabled
                originWhitelist={['*']}
              />
            </View>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(6,10,25,0.55)', justifyContent: 'flex-end' },
  sheet: { height: Math.min(SH * 0.9, 800), backgroundColor: '#F0F4FA', borderTopLeftRadius: 26, borderTopRightRadius: 26, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 18, paddingBottom: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#EEF2F7' },
  hTitle: { fontSize: 18, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 },
  hSub: { fontSize: 12.5, color: '#64748B', marginTop: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  pulseCircle: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
  searchingTx: { fontSize: 16, fontWeight: '700', color: '#0F172A', marginTop: 22 },
  searchingSub: { fontSize: 13, color: '#64748B', marginTop: 6, textAlign: 'center', lineHeight: 19 },
  retryBtn: { marginTop: 18, paddingHorizontal: 22, paddingVertical: 10, borderRadius: 12, backgroundColor: '#E2E8F0' },
  retryTx: { fontSize: 14, fontWeight: '700', color: '#334155' },
  subBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 2 },
  subBarTx: { fontSize: 12.5, fontWeight: '700', color: '#475569' },
  selAll: { fontSize: 12.5, fontWeight: '700', color: '#06B6D4' },
  card: { backgroundColor: '#fff', borderRadius: 18, padding: 14, marginBottom: 10, borderWidth: 1.5, borderColor: '#fff' },
  cardSel: { borderColor: '#06B6D4', backgroundColor: '#F7FEFF' },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start' },
  check: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.6, borderColor: '#CBD5E1', marginRight: 11, marginTop: 1, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: '#06B6D4', borderColor: '#06B6D4' },
  cardTitle: { fontSize: 14.5, fontWeight: '800', color: '#0F172A', letterSpacing: -0.3 },
  cardCompany: { fontSize: 12.5, color: '#334155', fontWeight: '600', marginTop: 3 },
  cardLocRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 3, marginTop: 3 },
  cardLoc: { flex: 1, fontSize: 12, color: '#64748B', lineHeight: 16 },
  badgeDone: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#ECFDF5', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8, gap: 3 },
  badgeDoneTx: { fontSize: 10.5, fontWeight: '700', color: '#059669' },
  cardBody: { marginTop: 10, marginLeft: 33 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  metaPill: { fontSize: 11, fontWeight: '600', color: '#0369A1', backgroundColor: '#E0F2FE', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: 'hidden' },
  highlight: { fontSize: 12, color: '#475569', lineHeight: 17, marginTop: 1 },
  skills: { fontSize: 11.5, color: '#7C3AED', marginTop: 6, fontWeight: '600' },
  srcRow: { flexDirection: 'row', alignItems: 'center', marginTop: 9, marginLeft: 33, gap: 4 },
  srcTx: { fontSize: 10.5, color: '#94A3B8', fontWeight: '600' },
  tapHint: { fontSize: 10.5, color: '#CBD5E1', marginLeft: 8 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 14, backgroundColor: 'rgba(240,244,250,0.96)', borderTopWidth: 1, borderTopColor: '#E2E8F0' },
  fetchBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 52, borderRadius: 16, gap: 8 },
  fetchTx: { fontSize: 15.5, fontWeight: '800', color: '#fff' },
  hiddenWeb: { position: 'absolute', width: 1, height: 1, left: -4000, top: -4000, opacity: 0 },
});
