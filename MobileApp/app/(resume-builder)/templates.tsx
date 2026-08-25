// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The design gallery: 9 layout families × recolored variants (37 designs) from
// GET /resume-builder/templates. One full preview per FAMILY, recolors via swatch taps —
// previews are fetched lazily in small batches because rendering every design in one request
// is exactly what used to break this screen at nine designs (multi-MB base64 + a serial
// chromium loop outliving the client timeout).
//
// Previews are free for everyone. DOWNLOADING the file is a paid-plan feature: the button is
// shown to free users too, and tapping it explains + routes to the plans screen. The server
// enforces the same rule with a 403 reason:'paid_required'.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Alert, ActivityIndicator, Dimensions, Platform,
  NativeSyntheticEvent, NativeScrollEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { downloadAsync, cacheDirectory } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { API_BASE } from '../../config';
import { fetchSubscriptionStatus } from '../../services/subscriptionService';

const T = {
  bg: '#E5EAF3', bgSoft: '#F0F4FA', surface: '#FFFFFF',
  navy: '#0B1120', ink: '#0B0F22', inkSoft: '#1A2046',
  muted: '#5A6480', faint: '#8A93B2', border: 'rgba(11,15,34,0.07)',
  blue: '#4F8DFF', blueDeep: '#2563EB', cyan: '#06B6D4', gold: '#F5A623',
};

type Variant = { id: string; name: string; accent: string };
type Family  = { id: string; name: string; accent: string; ats?: number | null; photo?: boolean; variants: Variant[] };
type Region  = { id: string; label: string; sub?: string; templates: string[] };
type Preview = { id: string; name: string; accent: string; ats?: number | null; image: string; width: number; height: number };
type Mode = 'onepage' | 'a4';

const REGION_FLAGS: Record<string, string> = {
  all: '✨', generic: '🌐', us_ca: '🇺🇸', uk_au: '🇬🇧', india: '🇮🇳', dach: '🇩🇪', eu: '🇪🇺', sg: '🇸🇬',
};

const WIN = Dimensions.get('window').width;
const SIDE_PAD = 12;
const CARD_W = WIN - SIDE_PAD * 2;

async function getToken() {
  const raw = await SecureStore.getItemAsync('userSession');
  return JSON.parse(raw || '{}')?.token as string | undefined;
}

export default function ResumeTemplates() {
  const router = useRouter();
  const scrollRef = useRef<ScrollView>(null);
  const [families, setFamilies] = useState<Family[]>([]);
  const [regions, setRegions]   = useState<Region[]>([]);
  const [region, setRegion]     = useState('all');
  // family id → the variant currently chosen on that family's page (defaults to the base)
  const [chosen, setChosen]     = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  // ids whose preview request FAILED → the card shows a retry instead of a spinner. A silent
  // failure here was an infinite "Rendering Azure Sidebar…": the full-screen error only covers
  // catalogue failure, so a lost preview request left the pager spinning with no way out.
  const [failed, setFailed] = useState<Record<string, string>>({});
  // The account has no built resume yet — previews are impossible, say so instead of spinning.
  const [noResume, setNoResume] = useState(false);
  const inFlight = useRef<Set<string>>(new Set());
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [active, setActive]     = useState(0);
  const [mode, setMode]         = useState<Mode>('onepage');
  const [pagerH, setPagerH]     = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [isPaid, setIsPaid]     = useState(false);

  // ── Lazy preview loader: small batches, deduped, merged into a cache ───────
  // Every batch carries its own 45s timeout and marks ITS ids as failed on any miss — the pager
  // card then shows a tap-to-retry. Nothing in here may leave an id in spinner-limbo.
  async function ensurePreviews(ids: string[]) {
    const need = [...new Set(ids)].filter((id) => id && !previews[id] && !inFlight.current.has(id));
    if (!need.length) return;
    need.forEach((id) => inFlight.current.add(id));
    setFailed((f) => { const next = { ...f }; for (const id of need) delete next[id]; return next; });
    try {
      const token = await getToken();
      if (!token) throw new Error('Not logged in');
      for (let i = 0; i < need.length; i += 3) {
        const batch = need.slice(i, i + 3);
        const controller = new AbortController();
        const tmr = setTimeout(() => controller.abort(), 45_000);
        try {
          const res = await fetch(`${API_BASE}/resume-builder/preview-templates`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: batch }),
            signal: controller.signal,
          });
          const json = await res.json();
          if (res.status === 404) { setNoResume(true); return; }
          if (!res.ok) throw new Error(json.error || 'Could not build previews');
          const got: Preview[] = json.previews || [];
          setPreviews((prev) => {
            const next = { ...prev };
            for (const p of got) next[p.id] = p;
            return next;
          });
          const gotIds = new Set(got.map((p) => p.id));
          const missing = batch.filter((id) => !gotIds.has(id));
          if (missing.length) setFailed((f) => { const next = { ...f }; for (const id of missing) next[id] = 'Could not render this design.'; return next; });
        } catch (e: any) {
          const msg = e?.name === 'AbortError' ? 'This took too long.' : (e?.message || 'Could not render this design.');
          setFailed((f) => { const next = { ...f }; for (const id of batch) next[id] = msg; return next; });
        } finally {
          clearTimeout(tmr);
        }
      }
    } catch (e: any) {
      setFailed((f) => { const next = { ...f }; for (const id of need) next[id] = e?.message || 'Could not render this design.'; return next; });
    } finally {
      need.forEach((id) => inFlight.current.delete(id));
    }
  }

  // The VISIBLE design renders first, alone — its request must never wait behind the
  // neighbours'. They prefetch immediately after, so a swipe still lands on a warm image.
  function prefetchAround(idx: number, fams: Family[], sel: Record<string, string>) {
    const idOf = (j: number) => { const f = fams[j]; return f ? (sel[f.id] || f.id) : ''; };
    const rest = [idOf(idx + 1), idOf(idx - 1)].filter(Boolean);
    const cur = idOf(idx);
    if (cur) ensurePreviews([cur]).then(() => { if (rest.length) ensurePreviews(rest); });
    else if (rest.length) ensurePreviews(rest);
  }

  async function loadCatalogue() {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not logged in');
      const res = await fetch(`${API_BASE}/resume-builder/templates`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!res.ok || !json.families?.length) throw new Error(json.error || 'Could not load designs');
      setFamilies(json.families);
      setRegions(json.regions || []);
      const sel: Record<string, string> = {};
      for (const f of json.families as Family[]) sel[f.id] = f.id;
      setChosen(sel);
      setLoading(false);
      prefetchAround(0, json.families, sel);
    } catch (e: any) {
      setError(e.message || 'Something went wrong. Please try again.');
      setLoading(false);
    }
    // Paid state decides only how the download tap is EXPLAINED; the server stays authoritative.
    try {
      const st = await fetchSubscriptionStatus();
      setIsPaid(!!st?.subscription);
    } catch {}
  }
  useEffect(() => { loadCatalogue(); }, []);

  // ⚠️ THE REGION IS LEVEL ONE. The first ship of this screen used the chips as a cosmetic
  // "Recommended" badge while the pager always showed every family — which read as "all designs
  // are under Generic and the chips do nothing" (exactly the report). Now the chip decides WHICH
  // families the pager holds; "All" shows the whole catalogue.
  const visibleFams = useMemo(() => {
    if (region === 'all') return families;
    const r = regions.find((x) => x.id === region);
    if (!r) return families;
    const famOf = (tid: string) => families.find((f) => f.id === tid || f.variants.some((v) => v.id === tid));
    const picked = r.templates.map(famOf).filter(Boolean) as Family[];
    return picked.length ? [...new Set(picked)] : families;
  }, [region, regions, families]);

  const totalDesigns = useMemo(() => visibleFams.reduce((a, f) => a + f.variants.length, 0), [visibleFams]);

  function pickRegion(id: string) {
    if (id === region) return;
    setRegion(id);
    setActive(0);
    scrollRef.current?.scrollTo({ x: 0, animated: false });
    // The new region's first family must start rendering immediately.
    const fams = id === 'all' ? families : (() => {
      const r = regions.find((x) => x.id === id);
      if (!r) return families;
      const famOf = (tid: string) => families.find((f) => f.id === tid || f.variants.some((v) => v.id === tid));
      const picked = r.templates.map(famOf).filter(Boolean) as Family[];
      return picked.length ? [...new Set(picked)] : families;
    })();
    prefetchAround(0, fams, chosen);
  }

  function onScrollEnd(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const idx = Math.round(e.nativeEvent.contentOffset.x / WIN);
    if (idx !== active) { setActive(idx); prefetchAround(idx, visibleFams, chosen); }
  }
  function goTo(idx: number) {
    scrollRef.current?.scrollTo({ x: idx * WIN, animated: true });
    setActive(idx);
    prefetchAround(idx, visibleFams, chosen);
  }
  function pickVariant(famId: string, tplId: string) {
    const sel = { ...chosen, [famId]: tplId };
    setChosen(sel);
    ensurePreviews([tplId]);
  }

  const activeFam = visibleFams[active];
  const selectedId = activeFam ? (chosen[activeFam.id] || activeFam.id) : '';
  const selected = previews[selectedId];
  const selectedMeta = activeFam?.variants.find((v) => v.id === selectedId);

  function upsellDownload() {
    Alert.alert(
      'Downloads are part of the paid plans',
      'Applying to jobs stays free on every plan — and previewing all designs is free too. To download your designed PDF or Word file, choose a paid plan.',
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'View paid plans', onPress: () => router.push('/(subscription)/plans' as never) },
      ],
    );
  }

  async function handleDownload(fmt: 'pdf' | 'docx' = 'pdf') {
    if (downloading || !selectedId) return;
    if (!isPaid) { upsellDownload(); return; }
    setDownloading(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not logged in');
      const url = fmt === 'docx' ? `${API_BASE}/resume-builder/generate-docx` : `${API_BASE}/resume-builder/generate-pdf`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: selectedId, mode }),
      });
      const json = await res.json();
      // The server said no — its word beats our cached status (subscription may have lapsed).
      if (res.status === 403 && json.reason === 'paid_required') { setIsPaid(false); upsellDownload(); return; }
      if (!res.ok || !json.downloadUrl) throw new Error(json.error || 'Failed to generate file');

      const cleanPath = json.downloadUrl.replace(/^\/api/, '');
      const fullUrl   = `${API_BASE}${cleanPath}`;
      const fileName  = decodeURIComponent(json.downloadUrl.split('/').pop() || (fmt === 'docx' ? 'Resume.docx' : 'Resume.pdf'));
      const fileUri   = cacheDirectory + fileName;
      const dl = await downloadAsync(fullUrl, fileUri, { headers: { Authorization: `Bearer ${token}` } });
      if (dl.status !== 200) throw new Error('Download failed');

      const mimeType = fmt === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/pdf';
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(dl.uri, { mimeType, dialogTitle: 'Save or share your resume' });
      } else {
        Alert.alert('Downloaded', `Resume ${fmt === 'docx' ? 'Word document' : 'PDF'} saved successfully.`);
      }
    } catch (e: any) {
      Alert.alert('Download failed', e.message || 'Please try again.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* Top bar */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={s.backPill} activeOpacity={0.8}>
          <Ionicons name="arrow-back" size={14} color={T.ink} />
          <Text style={s.backPillText}>Back</Text>
        </TouchableOpacity>
        <Text style={s.topTitle}>Choose a Format</Text>
        <View style={s.countPill}><Text style={s.countPillText}>{totalDesigns || '…'} designs</Text></View>
      </View>

      {/* Region chips — a recommendation lens over the same 9 families, no reload */}
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.regionRow}>
          {[{ id: 'all', label: 'All designs' } as Region, ...regions].map((r) => {
            const on = r.id === region;
            return (
              <TouchableOpacity key={r.id} onPress={() => pickRegion(r.id)} activeOpacity={0.85} style={[s.regionChip, on && s.regionChipOn]}>
                <Text style={s.regionFlag}>{REGION_FLAGS[r.id] || '🌐'}</Text>
                <Text style={[s.regionLabel, on && s.regionLabelOn]}>{r.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={T.blue} />
          <Text style={s.loadingText}>Loading the design catalogue…</Text>
        </View>
      ) : noResume ? (
        <View style={s.center}>
          <Ionicons name="document-text-outline" size={46} color={T.faint} />
          <Text style={s.errTitle}>Generate your resume first — then every design here previews it for free.</Text>
          <TouchableOpacity onPress={() => router.back()} style={s.retryBtn} activeOpacity={0.85}>
            <Ionicons name="color-wand-outline" size={15} color="#fff" />
            <Text style={s.retryText}>Build my resume</Text>
          </TouchableOpacity>
        </View>
      ) : error && !families.length ? (
        <View style={s.center}>
          <Ionicons name="alert-circle-outline" size={46} color={T.faint} />
          <Text style={s.errTitle}>{error}</Text>
          <TouchableOpacity onPress={loadCatalogue} style={s.retryBtn} activeOpacity={0.85}>
            <Ionicons name="refresh-outline" size={15} color="#fff" />
            <Text style={s.retryText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <Text style={s.lead}>Swipe layouts · tap a color to restyle · every preview is free</Text>

          <View style={s.pagerWrap} onLayout={(e) => setPagerH(e.nativeEvent.layout.height)}>
            {pagerH > 0 && (
              <ScrollView
                ref={scrollRef}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={onScrollEnd}
                decelerationRate="fast"
              >
                {visibleFams.map((f) => {
                  const tid = chosen[f.id] || f.id;
                  const p = previews[tid];
                  const accent = f.variants.find((v) => v.id === tid)?.accent || f.accent;
                  const imgH = p ? Math.round(CARD_W * (p.height / p.width)) : 0;
                  return (
                    <View key={f.id} style={[s.page, { height: pagerH }]}>
                      <View style={[s.cardShadow, { height: pagerH - 14, shadowColor: accent }]}>
                        <View style={s.cardClip}>
                          {p ? (
                            <ScrollView
                              style={s.zoomScroll}
                              contentContainerStyle={s.zoomContent}
                              maximumZoomScale={3}
                              minimumZoomScale={1}
                              bouncesZoom
                              pinchGestureEnabled
                              showsVerticalScrollIndicator={false}
                              showsHorizontalScrollIndicator={false}
                              nestedScrollEnabled
                            >
                              <Image source={{ uri: p.image }} style={{ width: CARD_W, height: imgH }} contentFit="cover" transition={160} />
                            </ScrollView>
                          ) : failed[tid] ? (
                            <TouchableOpacity style={s.previewLoading} activeOpacity={0.8} onPress={() => ensurePreviews([tid])}>
                              <Ionicons name="cloud-offline-outline" size={38} color={T.faint} />
                              <Text style={s.previewLoadingText}>{failed[tid]}</Text>
                              <View style={[s.retryChip, { backgroundColor: accent }]}>
                                <Ionicons name="refresh" size={13} color="#fff" />
                                <Text style={s.retryChipText}>Tap to retry</Text>
                              </View>
                            </TouchableOpacity>
                          ) : (
                            <View style={s.previewLoading}>
                              <ActivityIndicator size="large" color={accent} />
                              <Text style={s.previewLoadingText}>Rendering {f.variants.find((v) => v.id === tid)?.name || f.name}…</Text>
                            </View>
                          )}
                        </View>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            )}
          </View>

          {/* Family dots · name · recommended badge · ATS · variant swatches */}
          <View style={s.indicator}>
            <View style={s.dots}>
              {visibleFams.map((f, i) => (
                <TouchableOpacity key={f.id} onPress={() => goTo(i)} hitSlop={8}>
                  <View style={[s.dot, i === active && { width: 22, backgroundColor: selectedMeta?.accent || T.blue }]} />
                </TouchableOpacity>
              ))}
            </View>
            <View style={s.nameRow}>
              <Text style={s.designName}>{selectedMeta?.name || activeFam?.name || 'Resume'}</Text>
              <Text style={s.famCount}>{visibleFams.length > 1 ? `${active + 1}/${visibleFams.length} layouts` : ''}</Text>
            </View>
            {!!activeFam?.ats && <AtsStars n={activeFam.ats} />}
            {activeFam && activeFam.variants.length > 1 && (
              <View style={s.swatchRow}>
                {activeFam.variants.map((v) => {
                  const on = v.id === selectedId;
                  return (
                    <TouchableOpacity key={v.id} onPress={() => pickVariant(activeFam.id, v.id)} hitSlop={6} activeOpacity={0.8}>
                      <View style={[s.swatch, { backgroundColor: v.accent }, on && s.swatchOn]}>
                        {on && <Ionicons name="checkmark" size={13} color="#fff" />}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>
        </>
      )}

      {/* Sticky footer: page format + downloads (paid) — previews above stay free */}
      {!loading && families.length > 0 && (
        <View style={s.footer}>
          <View style={s.segWrap}>
            <SegBtn icon="document-outline"  label="One Page" active={mode === 'onepage'} onPress={() => setMode('onepage')} />
            <SegBtn icon="documents-outline" label="A4 Pages" active={mode === 'a4'}      onPress={() => setMode('a4')} />
          </View>

          <TouchableOpacity style={s.dlOuter} activeOpacity={0.9} onPress={() => handleDownload('pdf')} disabled={downloading}>
            <LinearGradient colors={[T.navy, '#1a2346']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.dlBtn}>
              {downloading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name={isPaid ? 'download-outline' : 'lock-closed'} size={17} color="#fff" />
                  <Text style={s.dlText}>Download PDF</Text>
                  {!isPaid && <View style={s.credBadge}><Text style={s.credBadgeText}>Paid plans</Text></View>}
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
          <TouchableOpacity style={[s.dlOuter, { marginTop: 8 }]} activeOpacity={0.9} onPress={() => handleDownload('docx')} disabled={downloading}>
            <LinearGradient colors={['#2B579A', '#1f407a']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.dlBtn}>
              {downloading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name={isPaid ? 'document-text-outline' : 'lock-closed'} size={17} color="#fff" />
                  <Text style={s.dlText}>Download as Word</Text>
                  {!isPaid && <View style={s.credBadge}><Text style={s.credBadgeText}>Paid plans</Text></View>}
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
          <Text style={s.footerNote}>
            {isPaid
              ? `Included in your plan · ${mode === 'onepage' ? 'one continuous page' : 'A4, splits into pages'}`
              : 'Previews are free · downloads are included in every paid plan'}
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}

function AtsStars({ n }: { n: number }) {
  return (
    <View style={s.atsRow}>
      <Text style={s.atsLabel}>ATS</Text>
      {[1, 2, 3, 4, 5].map((i) => (
        <Ionicons key={i} name={i <= n ? 'star' : 'star-outline'} size={12} color={T.gold} />
      ))}
    </View>
  );
}

function SegBtn({ icon, label, active, onPress }: { icon: any; label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[s.segBtn, active && s.segBtnActive]} onPress={onPress} activeOpacity={0.85}>
      <Ionicons name={icon} size={14} color={active ? '#fff' : T.muted} />
      <Text style={[s.segTxt, active && s.segTxtActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: T.bg },
  topBar:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  backPill:     { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.surface, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 3 },
  backPillText: { fontSize: 13, fontWeight: '600', color: T.ink },
  topTitle:     { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  countPill:    { backgroundColor: T.blue + '15', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  countPillText:{ fontSize: 11, fontWeight: '800', color: T.blueDeep },

  regionRow:    { paddingHorizontal: 12, gap: 8, paddingBottom: 4, paddingTop: 2 },
  regionChip:   { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: T.surface, borderRadius: 20, paddingVertical: 8, paddingHorizontal: 13, borderWidth: 1, borderColor: T.border },
  regionChipOn: { backgroundColor: T.navy, borderColor: T.navy },
  regionFlag:   { fontSize: 14 },
  regionLabel:  { fontSize: 13, fontWeight: '700', color: T.inkSoft },
  regionLabelOn:{ color: '#fff' },

  center:       { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 32 },
  loadingText:  { fontSize: 15, fontWeight: '700', color: T.ink, marginTop: 6, textAlign: 'center' },
  errTitle:     { fontSize: 14, fontWeight: '600', color: T.muted, textAlign: 'center', marginTop: 4 },
  retryBtn:     { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: T.blueDeep, borderRadius: 14, paddingHorizontal: 20, paddingVertical: 11, marginTop: 8 },
  retryText:    { color: '#fff', fontWeight: '700', fontSize: 14 },

  lead:         { fontSize: 11.5, color: T.muted, textAlign: 'center', marginBottom: 6, marginTop: 6 },
  pagerWrap:    { flex: 1 },
  page:         { width: WIN, alignItems: 'center', justifyContent: 'center' },
  cardShadow:   { width: CARD_W, borderRadius: 16, backgroundColor: '#fff', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.2, shadowRadius: 18, elevation: 8 },
  cardClip:     { flex: 1, borderRadius: 16, overflow: 'hidden', backgroundColor: '#fff' },
  zoomScroll:   { flex: 1 },
  zoomContent:  { alignItems: 'center' },
  previewLoading:     { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 24 },
  previewLoadingText: { fontSize: 12.5, fontWeight: '600', color: T.muted, textAlign: 'center' },
  retryChip:          { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 8 },
  retryChipText:      { fontSize: 12.5, fontWeight: '800', color: '#fff' },

  indicator:    { alignItems: 'center', gap: 6, paddingTop: 10 },
  dots:         { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot:          { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(11,15,34,0.18)' },
  nameRow:      { flexDirection: 'row', alignItems: 'center', gap: 8 },
  designName:   { fontSize: 15, fontWeight: '800', color: T.ink, letterSpacing: -0.2 },
  famCount:     { fontSize: 11, fontWeight: '700', color: T.faint },
  atsRow:       { flexDirection: 'row', alignItems: 'center', gap: 2 },
  atsLabel:     { fontSize: 10, fontWeight: '800', color: T.faint, letterSpacing: 1, marginRight: 4 },
  swatchRow:    { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 4 },
  swatch:       { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'rgba(255,255,255,0.9)', shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.18, shadowRadius: 4, elevation: 3 },
  swatchOn:     { transform: [{ scale: 1.18 }], borderColor: '#fff' },

  footer:       { backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.border, paddingHorizontal: 16, paddingTop: 12, paddingBottom: Platform.select({ ios: 28, default: 16 }), gap: 10, shadowColor: T.ink, shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 12 },
  segWrap:      { flexDirection: 'row', backgroundColor: T.bgSoft, borderRadius: 12, padding: 4, gap: 4 },
  segBtn:       { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 9, borderRadius: 9 },
  segBtnActive: { backgroundColor: T.navy },
  segTxt:       { fontSize: 13, fontWeight: '700', color: T.muted },
  segTxtActive: { color: '#fff' },
  dlOuter:      { borderRadius: 16, overflow: 'hidden' },
  dlBtn:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, height: 52, borderRadius: 16 },
  dlText:       { fontSize: 15, fontWeight: '800', color: '#fff' },
  credBadge:    { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(255,255,255,0.16)', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3 },
  credBadgeText:{ fontSize: 11, fontWeight: '800', color: '#fff' },
  footerNote:   { fontSize: 11, color: T.faint, textAlign: 'center' },
});
