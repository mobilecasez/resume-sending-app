// Cover Letter Builder — new feature. Safe to delete without affecting existing app.
import React, { useEffect, useRef, useState } from 'react';
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
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { downloadAsync, cacheDirectory } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { API_BASE } from '../../config';

const T = {
  bg: '#E5EAF3', bgSoft: '#F0F4FA', surface: '#FFFFFF',
  navy: '#0B1120', ink: '#0B0F22', inkSoft: '#1A2046',
  muted: '#5A6480', faint: '#8A93B2', border: 'rgba(11,15,34,0.07)',
  blue: '#4F8DFF', blueDeep: '#2563EB',
};

type Preview = { id: string; name: string; accent: string; image: string; width: number; height: number };
type Mode = 'onepage' | 'a4';
type Ctx = { coverLetterHtml: string; companyName?: string; companyAddress?: string };

// Region ids MUST match server coverLetterTemplates.js REGIONS.
const REGIONS = [
  { id: 'generic', label: 'Generic',       flag: '📄' },
  { id: 'us_ca',  label: 'USA / Canada',   flag: '🇺🇸' },
  { id: 'uk_au',  label: 'UK / Australia', flag: '🇬🇧' },
  { id: 'india',  label: 'India',          flag: '🇮🇳' },
  { id: 'dach',   label: 'Germany / DACH', flag: '🇩🇪' },
  { id: 'eu',     label: 'Europe / EU',    flag: '🇪🇺' },
  { id: 'sg',     label: 'Singapore',      flag: '🇸🇬' },
  { id: 'global', label: 'Global / Entry', flag: '🌐' },
];

const DOWNLOAD_CREDITS = 2;
const WIN = Dimensions.get('window').width;
const SIDE_PAD = 12;
const CARD_W = WIN - SIDE_PAD * 2;

async function getToken() {
  const raw = await SecureStore.getItemAsync('userSession');
  return JSON.parse(raw || '{}')?.token as string | undefined;
}

export default function CoverLetterTemplates() {
  const router = useRouter();
  const scrollRef = useRef<ScrollView>(null);
  const [ctx, setCtx]           = useState<Ctx | null>(null);
  const [region, setRegion]     = useState('generic');
  const [downloadHtml, setDownloadHtml] = useState('');
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [active, setActive]     = useState(0);
  const [mode, setMode]         = useState<Mode>('onepage');
  const [pagerH, setPagerH]     = useState(0);
  const [downloading, setDownloading] = useState(false);

  // Load the cover-letter context (stashed by whichever screen opened the picker).
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('coverLetterPickerContext');
        const c = raw ? JSON.parse(raw) : null;
        if (!c?.coverLetterHtml) { setError('No cover letter found. Generate one first.'); setLoading(false); return; }
        setCtx(c);
        loadPreviews('generic', c);
      } catch {
        setError('Could not load the cover letter.'); setLoading(false);
      }
    })();
  }, []);

  async function loadPreviews(regionId: string, c: Ctx) {
    setLoading(true);
    setError(null);
    setActive(0);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not logged in');
      // One region-neutral letter is used for every region; the server only changes the visual formatting.
      const body = c.coverLetterHtml;
      const res = await fetch(`${API_BASE}/cover-letter/preview-templates`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: regionId, coverLetterHtml: body, companyName: c.companyName, companyAddress: c.companyAddress }),
      });
      const json = await res.json();
      if (!res.ok || !json.previews?.length) throw new Error(json.error || 'Could not build previews');
      setPreviews(json.previews);
      setDownloadHtml(body); // the exact text shown — sent verbatim at download (no AI)
      scrollRef.current?.scrollTo({ x: 0, animated: false });
    } catch (e: any) {
      setPreviews([]);
      setError(e.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function pickRegion(id: string) {
    if (id === region || loading || !ctx) return;
    setRegion(id);
    loadPreviews(id, ctx);
  }

  function onScrollEnd(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const idx = Math.round(e.nativeEvent.contentOffset.x / WIN);
    if (idx !== active) setActive(idx);
  }
  function goTo(idx: number) {
    scrollRef.current?.scrollTo({ x: idx * WIN, animated: true });
    setActive(idx);
  }

  async function handleDownload(fmt: 'pdf' | 'docx' = 'pdf') {
    if (downloading || !previews[active] || !ctx) return;
    setDownloading(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not logged in');
      const selected = previews[active];
      const endpoint = fmt === 'docx' ? 'generate-template-docx' : 'generate-template-pdf';
      const res = await fetch(`${API_BASE}/cover-letter/${endpoint}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: selected.id, mode, coverLetterHtml: downloadHtml || ctx.coverLetterHtml, companyName: ctx.companyName, companyAddress: ctx.companyAddress }),
      });
      const json = await res.json();
      if (res.status === 402) {
        Alert.alert('Not enough credits', json.error || `You need ${DOWNLOAD_CREDITS} credits to download.`);
        return;
      }
      if (!res.ok || !json.downloadUrl) throw new Error(json.error || 'Failed to generate file');

      const cleanPath = json.downloadUrl.replace(/^\/api/, '');
      const fullUrl   = `${API_BASE}${cleanPath}`;
      const fileName  = decodeURIComponent(json.downloadUrl.split('/').pop() || (fmt === 'docx' ? 'Cover_Letter.docx' : 'Cover_Letter.pdf'));
      const fileUri   = cacheDirectory + fileName;
      const dl = await downloadAsync(fullUrl, fileUri, { headers: { Authorization: `Bearer ${token}` } });
      if (dl.status !== 200) throw new Error('Download failed');

      const mimeType = fmt === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/pdf';
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(dl.uri, { mimeType, dialogTitle: 'Save or share your cover letter' });
      } else {
        Alert.alert('Downloaded', `Cover letter ${fmt === 'docx' ? 'Word document' : 'PDF'} saved successfully.`);
      }
    } catch (e: any) {
      Alert.alert('Download failed', e.message || 'Please try again.');
    } finally {
      setDownloading(false);
    }
  }

  const selected = previews[active];

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={s.backPill} activeOpacity={0.8}>
          <Ionicons name="arrow-back" size={14} color={T.ink} />
          <Text style={s.backPillText}>Back</Text>
        </TouchableOpacity>
        <Text style={s.topTitle}>Cover Letter</Text>
        <View style={{ width: 64 }} />
      </View>

      <View>
        <Text style={s.regionHint}>Target country / region</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.regionRow}>
          {REGIONS.map((r) => {
            const on = r.id === region;
            return (
              <TouchableOpacity key={r.id} onPress={() => pickRegion(r.id)} activeOpacity={0.85} style={[s.regionChip, on && s.regionChipOn]}>
                <Text style={s.regionFlag}>{r.flag}</Text>
                <Text style={[s.regionLabel, on && s.regionLabelOn]}>{r.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={T.blue} />
          <Text style={s.loadingText}>Formatting your cover letter…</Text>
          <Text style={s.loadingSub}>Rendering each style — a moment</Text>
        </View>
      ) : error ? (
        <View style={s.center}>
          <Ionicons name="alert-circle-outline" size={46} color={T.faint} />
          <Text style={s.errTitle}>{error}</Text>
          {ctx && (
            <TouchableOpacity onPress={() => loadPreviews(region, ctx)} style={s.retryBtn} activeOpacity={0.85}>
              <Ionicons name="refresh-outline" size={15} color="#fff" />
              <Text style={s.retryText}>Try Again</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <>
          <Text style={s.lead}>Swipe to compare · scroll &amp; pinch to zoom · preview is free</Text>
          <View style={s.pagerWrap} onLayout={(e) => setPagerH(e.nativeEvent.layout.height)}>
            {pagerH > 0 && (
              <ScrollView
                ref={scrollRef}
                horizontal pagingEnabled
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={onScrollEnd}
                decelerationRate="fast"
              >
                {previews.map((p) => {
                  const imgH = Math.round(CARD_W * (p.height / p.width));
                  return (
                    <View key={p.id} style={[s.page, { height: pagerH }]}>
                      <View style={[s.cardShadow, { height: pagerH - 14, shadowColor: p.accent }]}>
                        <View style={s.cardClip}>
                          <ScrollView
                            style={s.zoomScroll} contentContainerStyle={s.zoomContent}
                            maximumZoomScale={3} minimumZoomScale={1} bouncesZoom pinchGestureEnabled
                            showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} nestedScrollEnabled
                          >
                            <Image source={{ uri: p.image }} style={{ width: CARD_W, height: imgH }} contentFit="cover" transition={160} />
                          </ScrollView>
                        </View>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            )}
          </View>

          <View style={s.indicator}>
            {previews.length > 1 && (
              <View style={s.dots}>
                {previews.map((p, i) => (
                  <TouchableOpacity key={p.id} onPress={() => goTo(i)} hitSlop={8}>
                    <View style={[s.dot, i === active && { width: 22, backgroundColor: selected?.accent || T.blue }]} />
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <Text style={s.designName}>{selected?.name || 'Cover Letter'}</Text>
          </View>
        </>
      )}

      {!loading && !error && (
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
                  <Ionicons name="download-outline" size={17} color="#fff" />
                  <Text style={s.dlText}>Download PDF</Text>
                  <View style={s.credBadge}>
                    <Ionicons name="diamond" size={9} color="#fff" />
                    <Text style={s.credBadgeText}>{DOWNLOAD_CREDITS}</Text>
                  </View>
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
                  <Ionicons name="document-text-outline" size={17} color="#fff" />
                  <Text style={s.dlText}>Download as Word</Text>
                  <View style={s.credBadge}>
                    <Ionicons name="diamond" size={9} color="#fff" />
                    <Text style={s.credBadgeText}>{DOWNLOAD_CREDITS}</Text>
                  </View>
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
          <Text style={s.footerNote}>
            {`${DOWNLOAD_CREDITS} credits per download · ${mode === 'onepage' ? 'one continuous page' : 'A4, splits into pages'}`}
          </Text>
        </View>
      )}
    </SafeAreaView>
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
  regionHint:   { fontSize: 11, fontWeight: '700', color: T.faint, letterSpacing: 0.6, textTransform: 'uppercase', paddingHorizontal: 16, marginTop: 2, marginBottom: 6 },
  regionRow:    { paddingHorizontal: 12, gap: 8, paddingBottom: 4 },
  regionChip:   { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: T.surface, borderRadius: 20, paddingVertical: 8, paddingHorizontal: 13, borderWidth: 1, borderColor: T.border },
  regionChipOn: { backgroundColor: T.navy, borderColor: T.navy },
  regionFlag:   { fontSize: 14 },
  regionLabel:  { fontSize: 13, fontWeight: '700', color: T.inkSoft },
  regionLabelOn:{ color: '#fff' },
  center:       { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 32 },
  loadingText:  { fontSize: 15, fontWeight: '700', color: T.ink, marginTop: 6, textAlign: 'center' },
  loadingSub:   { fontSize: 12, color: T.faint },
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
  indicator:    { alignItems: 'center', gap: 6, paddingTop: 10 },
  dots:         { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot:          { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(11,15,34,0.18)' },
  designName:   { fontSize: 15, fontWeight: '800', color: T.ink, letterSpacing: -0.2 },
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
