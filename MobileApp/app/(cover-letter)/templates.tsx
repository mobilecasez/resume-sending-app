// Cover Letter Builder — new feature. Safe to delete without affecting existing app.
//
// DOC MODE (route param `docId`, or a picker context carrying `docId`): the letter is ONE EMPLOYER'S
// OWN saved cover letter (user_employer_documents, kind cover_letter). Its designs come from
// GET /cover-letter/employer-cards (≤ 3 per request, filled in around the card on screen), ordered by
// the doc's ranked design list with a fit % on each, and the download carries the docId so the server
// renders and bills THAT document. The region chips give way to that ranking — the server already
// weighed the region when it ranked. Without a docId every line below behaves exactly as before.
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
import { useRouter, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { downloadAsync, cacheDirectory } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { API_BASE } from '../../config';
import DownloadPaywallSheet from '../../components/downloads/DownloadPaywallSheet';
import { fetchDownloadState, downloadButtonLabel, type DownloadState } from '../../services/downloadPassService';
import { useEventCosts } from '../../hooks/useEventCosts';
import RatingPromptModal, { useRatingPrompt } from '../../components/RatingPromptModal';
import { fetchDoc, fetchDocCards, type Design } from '../../services/employerDocs';
import { LETTER_DESIGNS } from '../../services/employerHomeService';

const T = {
  bg: '#E5EAF3', bgSoft: '#F0F4FA', surface: '#FFFFFF',
  navy: '#0B1120', ink: '#0B0F22', inkSoft: '#1A2046',
  muted: '#5A6480', faint: '#8A93B2', border: 'rgba(11,15,34,0.07)',
  blue: '#4F8DFF', blueDeep: '#2563EB',
};

type Preview = { id: string; name: string; accent: string; image: string; width: number; height: number };
type Mode = 'onepage' | 'a4';
type Ctx = {
  coverLetterHtml: string;
  companyName?: string;
  companyAddress?: string;
  /**
   * The company as the REST of the app knows it — the Home target's `target.company`, which is
   * exactly what the resume screen sends. `companyName` is the AI's reading of the posting and can
   * be a different string, or a bare URL when it found no name; using that for the pass is how a
   * user ends up paying twice for one company. Optional: older stashed contexts will not have it.
   */
  employer?: string;
  format?: 'pdf' | 'docx';
  /** Set by Home for a saved employer letter → doc mode (see the header). */
  docId?: number | string;
};

// ── Doc mode ────────────────────────────────────────────────────────────────────────────────────
/** One design page of a saved letter: catalogue identity + this employer's fit (null = unranked). */
type DocSlot = { id: string; name: string; accent: string; fit: number | null; reason: string | null };
/** A rendered page. width/height travel when the server sends them; else the image's own size. */
type DocImage = { image: string; width?: number; height?: number };
/** A4 portrait — the page shape until the real rendered height is known. */
const A4_RATIO = 297 / 210;
const DOC_BATCH = 3;   // /cover-letter/employer-cards caps a request at 3 ids

function docIdOf(raw: unknown): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The doc's ranked order mapped onto the letter catalogue: unknown ids skipped, catalogue designs
 *  the ranking missed appended unranked — every design stays reachable. */
function slotsFor(design: Design | null | undefined): DocSlot[] {
  const known = new Map(LETTER_DESIGNS.map((d) => [d.id, d] as const));
  const out: DocSlot[] = [];
  const seen = new Set<string>();
  const ranked = Array.isArray(design?.ranked) ? design!.ranked : [];
  for (const r of ranked) {
    const meta = r && typeof r.id === 'string' ? known.get(r.id) : undefined;
    if (!meta || seen.has(meta.id)) continue;
    seen.add(meta.id);
    const n = Number(r.score);
    out.push({
      ...meta,
      fit: Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null,
      reason: typeof r.reason === 'string' && r.reason ? r.reason : null,
    });
  }
  for (const d of LETTER_DESIGNS) if (!seen.has(d.id)) out.push({ ...d, fit: null, reason: null });
  return out;
}

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
  const { costs } = useEventCosts();
  const rating = useRatingPrompt();
  // Ask for a rating when leaving the previewed cover letter; complete the back nav after.
  const goBack = async () => { if (!(await rating.ask('cover_letter'))) router.back(); };
  const closeRating = () => { rating.close(); router.back(); };
  const scrollRef = useRef<ScrollView>(null);
  const { template: wantTemplate, docId: wantDocId } = useLocalSearchParams<{ template?: string; docId?: string }>();
  const [ctx, setCtx]           = useState<Ctx | null>(null);
  // ── Doc mode state (see the header). docId stays null for the classic picker. ──
  const [docId, setDocId]       = useState<number | null>(() => docIdOf(wantDocId));
  const [docEmployer, setDocEmployer] = useState<string | null>(null);
  const [docSlots, setDocSlots] = useState<DocSlot[]>([]);
  const [docImages, setDocImages] = useState<Record<string, DocImage>>({});
  // Mirror of docImages for the loader: it runs from closures that outlive the render they read.
  const docImagesRef = useRef<Record<string, DocImage>>({});
  const [docFailed, setDocFailed] = useState<Record<string, string>>({});
  const [docGone, setDocGone]   = useState(false);
  const docInFlight = useRef<Set<string>>(new Set());
  // Bumped per doc load, so a page reply for a previous load can never paint into this one.
  const docGen = useRef(0);
  const landOn = useRef<number | null>(null);
  // Prefer the shared identity; fall back to the AI's name so old contexts still work.
  // Doc mode: loadDoc rebuilds ctx from the doc with employer = the doc's own employer — the one the
  // server bills a doc download to — so this line needs no doc branch.
  const passEmployer = ctx?.employer || ctx?.companyName || null;
  const [region, setRegion]     = useState('generic');
  const [downloadHtml, setDownloadHtml] = useState('');
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [active, setActive]     = useState(0);
  const [mode, setMode]         = useState<Mode>('onepage');
  const [pagerH, setPagerH]     = useState(0);
  const [downloading, setDownloading] = useState(false);
  // Downloads are paid-plan features now (the credit model is retired); previews stay free.
  const [isPaid, setIsPaid] = useState(false);
  // A pass is bought per EMPLOYER and covers the letter as well as the resume, so this screen
  // asks about the SAME company the resume gallery does.
  const [dlState, setDlState] = useState<DownloadState>({ metered: false, paid: false, unlimited: false, remaining: null, passes: 0, ownsEmployer: false, employer: null });
  const [payOpen, setPayOpen] = useState(false);
  const [pendingFmt, setPendingFmt] = useState<'pdf' | 'docx' | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const { fetchSubscriptionStatus } = require('../../services/subscriptionService');
        const st = await fetchSubscriptionStatus();
        setIsPaid(!!st?.subscription);
      } catch {}
    })();
  }, []);
  // The sheet, not an alert — an alert had nowhere to offer the one-off, so "View paid plans" was
  // a dead end for anyone who wanted a single letter.
  function upsellDownload() { setPayOpen(true); }
  const refreshDownloadState = React.useCallback(async () => {
    const st = await fetchDownloadState(passEmployer);
    setDlState(st);
    return st;
  }, [passEmployer]);
  useEffect(() => { refreshDownloadState(); }, [refreshDownloadState]);
  const dlLabel = downloadButtonLabel(dlState);
  const dlBadge = dlState.ownsEmployer || dlState.passes > 0
    ? null
    : dlLabel.locked
      ? 'Locked'
      : (dlState.metered && dlState.paid && dlState.remaining != null ? `${dlState.remaining} left` : null);
  // Which format the user chose on the Review screen — shown first/prominent in the footer.
  const [preferredFormat, setPreferredFormat] = useState<'pdf' | 'docx'>('pdf');

  // Load the cover-letter context (stashed by whichever screen opened the picker).
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('coverLetterPickerContext');
        const c = raw ? JSON.parse(raw) : null;
        // Doc mode: the route's docId wins; a stashed context's docId is the fallback.
        const did = docIdOf(wantDocId) ?? docIdOf(c?.docId);
        if (did) {
          // ⚠️ Only trust the stashed text/employer when it is THIS doc's — a context left behind by
          // an earlier letter would otherwise name the wrong company until the doc loads.
          if (c && docIdOf(c.docId) === did) setCtx(c);
          if (c && c.format === 'docx') setPreferredFormat('docx');
          setDocId(did);
          loadDoc(did);
          return;
        }
        if (!c?.coverLetterHtml) { setError('No cover letter found. Generate one first.'); setLoading(false); return; }
        setCtx(c);
        setPreferredFormat(c.format === 'docx' ? 'docx' : 'pdf');
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

  // ── Doc mode: load the saved letter, then its design pages around the card on screen ──
  async function loadDoc(did: number) {
    const gen = ++docGen.current;
    setLoading(true);
    setError(null);
    setActive(0);
    docInFlight.current.clear();
    docImagesRef.current = {};
    setDocImages({});
    setDocFailed({});
    const d = await fetchDoc(did).catch(() => null);
    if (gen !== docGen.current) return;
    if (d === 'gone') {
      setDocGone(true);
      setError('This cover letter is no longer saved. Go back to Home to see your current one.');
      setLoading(false);
      return;
    }
    if (!d) { setError('Could not load your cover letter. Please try again.'); setLoading(false); return; }
    const p = (d.payload && typeof d.payload === 'object') ? d.payload : {};
    const html = String(p.coverLetterHtml || '');
    setDocEmployer(d.employer || null);
    setCtx({ coverLetterHtml: html, companyName: p.companyName, companyAddress: p.companyAddress, employer: d.employer || undefined, docId: did });
    setDownloadHtml(html);
    if (d.design?.mode === 'a4' || d.design?.mode === 'onepage') setMode(d.design.mode);
    const slots = slotsFor(d.design);
    setDocSlots(slots);
    // Opened on a specific design (Home's zoom): land on it, wherever the ranking put it.
    const want = Array.isArray(wantTemplate) ? wantTemplate[0] : wantTemplate;
    const start = Math.max(0, want ? slots.findIndex((sl) => sl.id === want) : 0);
    setActive(start);
    landOn.current = start > 0 ? start : null;
    setLoading(false);
    ensureDocAround(start, slots, did);
  }

  /** Pages for these ids, ≤ 3 per request. Every id ends in an image or a tap-to-retry — never limbo. */
  async function ensureDocCards(ids: string[], did: number) {
    const gen = docGen.current;
    const need = [...new Set(ids)].filter((id) => id && !docImagesRef.current[id] && !docInFlight.current.has(id));
    if (!need.length) return;
    need.forEach((id) => docInFlight.current.add(id));
    setDocFailed((f) => { const next = { ...f }; for (const id of need) delete next[id]; return next; });
    try {
      for (let i = 0; i < need.length; i += DOC_BATCH) {
        const batch = need.slice(i, i + DOC_BATCH);
        const got = await fetchDocCards('cover_letter', did, batch).catch(() => null);
        if (gen !== docGen.current) return;                  // a newer load owns the screen now
        if (got === 'gone') {
          setDocGone(true);
          setError('This cover letter is no longer saved. Go back to Home to see your current one.');
          return;
        }
        const add: Record<string, DocImage> = {};
        for (const c of (got && Array.isArray(got.cards)) ? got.cards : []) {
          const extra = c as { width?: unknown; height?: unknown };
          if (c && c.image && batch.includes(c.id)) {
            add[c.id] = {
              image: c.image,
              width: typeof extra.width === 'number' ? extra.width : undefined,
              height: typeof extra.height === 'number' ? extra.height : undefined,
            };
          }
        }
        if (Object.keys(add).length) {
          docImagesRef.current = { ...docImagesRef.current, ...add };
          setDocImages((prev) => ({ ...prev, ...add }));
        }
        const missing = batch.filter((id) => !add[id]);
        if (missing.length) {
          const msg = got ? 'Could not render this design.' : 'Could not load this design.';
          setDocFailed((f) => { const next = { ...f }; for (const id of missing) next[id] = msg; return next; });
        }
      }
    } finally {
      if (gen === docGen.current) need.forEach((id) => docInFlight.current.delete(id));
    }
  }

  /** The card on screen first, with its neighbours in the same request (one batch of ≤ 3). */
  function ensureDocAround(idx: number, slots: DocSlot[], did: number) {
    const ids = [slots[idx]?.id, slots[idx + 1]?.id, slots[idx - 1]?.id].filter(Boolean) as string[];
    if (ids.length) ensureDocCards(ids, did);
  }

  // One-shot: carry the pager to the design Home opened us on, once it exists to be scrolled.
  useEffect(() => {
    if (loading || landOn.current == null || !docSlots.length || pagerH <= 0) return;
    const idx = Math.min(landOn.current, docSlots.length - 1);
    landOn.current = null;
    if (idx > 0) requestAnimationFrame(() => scrollRef.current?.scrollTo({ x: idx * WIN, animated: false }));
  }, [loading, docSlots.length, pagerH]);

  function pickRegion(id: string) {
    if (id === region || loading || !ctx) return;
    setRegion(id);
    loadPreviews(id, ctx);
  }

  function onScrollEnd(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const idx = Math.round(e.nativeEvent.contentOffset.x / WIN);
    if (idx !== active) setActive(idx);
    if (docId && idx !== active) ensureDocAround(idx, docSlots, docId);
  }
  function goTo(idx: number) {
    scrollRef.current?.scrollTo({ x: idx * WIN, animated: true });
    setActive(idx);
    if (docId) ensureDocAround(idx, docSlots, docId);
  }

  async function handleDownload(fmt: 'pdf' | 'docx' = 'pdf') {
    if (downloading || !(docId ? docSlots[active] : previews[active]) || !ctx) return;
    const st = dlState;
    const allowed = st.ownsEmployer || st.passes > 0 || st.unlimited || (st.paid && (st.remaining ?? 1) > 0);
    if (!allowed) { setPendingFmt(fmt); upsellDownload(); return; }
    setDownloading(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not logged in');
      const selected = docId ? docSlots[active] : previews[active];
      const endpoint = fmt === 'docx' ? 'generate-template-docx' : 'generate-template-pdf';
      const res = await fetch(`${API_BASE}/cover-letter/${endpoint}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        // Doc mode: the server renders THAT saved letter and bills its own employer.
        body: JSON.stringify(docId
          ? { template: selected.id, mode, coverLetterHtml: downloadHtml || ctx.coverLetterHtml, companyName: ctx.companyName, companyAddress: ctx.companyAddress, employer: passEmployer, docId }
          : { template: selected.id, mode, coverLetterHtml: downloadHtml || ctx.coverLetterHtml, companyName: ctx.companyName, companyAddress: ctx.companyAddress, employer: passEmployer }),
      });
      const json = await res.json();
      if (docId && res.status === 410) {
        // Deleted between opening the picker and tapping Download — nothing was charged.
        setDocGone(true);
        setError('This cover letter is no longer saved. Go back to Home to see your current one.');
        return;
      }
      if (res.status === 403 && (json.reason === 'paid_required' || json.reason === 'quota_exhausted')) {
        setIsPaid(false); await refreshDownloadState(); setPendingFmt(fmt); upsellDownload(); return;
      }
      if (res.status === 402) {
        Alert.alert('Limit reached', json.error || 'Downloads are part of the paid plans.');
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
      refreshDownloadState();   // the pass is now bound, or a plan download spent
    } catch (e: any) {
      Alert.alert('Download failed', e.message || 'Please try again.');
    } finally {
      setDownloading(false);
    }
  }

  const selected = previews[active];
  const selectedDoc = docId ? docSlots[active] : undefined;
  const fitStyleOf = (n: number) => (n >= 85 ? s.fitHi : n >= 70 ? s.fitMid : s.fitLo);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.topBar}>
        <TouchableOpacity onPress={goBack} style={s.backPill} activeOpacity={0.8}>
          <Ionicons name="arrow-back" size={14} color={T.ink} />
          <Text style={s.backPillText}>Back</Text>
        </TouchableOpacity>
        <Text style={s.topTitle}>Cover Letter</Text>
        <View style={{ width: 64 }} />
      </View>

      {docId ? (
        <View>
          <Text style={s.regionHint} numberOfLines={1}>
            {docEmployer ? `Ranked for ${docEmployer} · best fit first` : 'Ranked for this employer · best fit first'}
          </Text>
        </View>
      ) : (
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
      )}

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
          {docId ? (
            docGone ? (
              <TouchableOpacity onPress={() => router.back()} style={s.retryBtn} activeOpacity={0.85}>
                <Ionicons name="arrow-back" size={15} color="#fff" />
                <Text style={s.retryText}>Go back</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={() => loadDoc(docId)} style={s.retryBtn} activeOpacity={0.85}>
                <Ionicons name="refresh-outline" size={15} color="#fff" />
                <Text style={s.retryText}>Try Again</Text>
              </TouchableOpacity>
            )
          ) : ctx && (
            <TouchableOpacity onPress={() => loadPreviews(region, ctx)} style={s.retryBtn} activeOpacity={0.85}>
              <Ionicons name="refresh-outline" size={15} color="#fff" />
              <Text style={s.retryText}>Try Again</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : docId ? (
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
                {docSlots.map((slot, i) => {
                  const img = docImages[slot.id];
                  const ratio = img && img.width && img.height ? img.height / img.width : A4_RATIO;
                  const imgH = Math.round(CARD_W * ratio);
                  return (
                    <View key={slot.id} style={[s.page, { height: pagerH }]}>
                      <View style={[s.cardShadow, { height: pagerH - 14, shadowColor: slot.accent }]}>
                        <View style={s.cardClip}>
                          {img ? (
                            <ScrollView
                              style={s.zoomScroll} contentContainerStyle={s.zoomContent}
                              maximumZoomScale={3} minimumZoomScale={1} bouncesZoom pinchGestureEnabled
                              showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} nestedScrollEnabled
                            >
                              <Image
                                source={{ uri: img.image }}
                                style={{ width: CARD_W, height: imgH }}
                                contentFit="cover"
                                transition={160}
                                onLoad={(e) => {
                                  // No size from the server → learn the real page height from the image
                                  // itself, once, so a long letter is not cropped to A4.
                                  if (img.width && img.height) return;
                                  const w = e?.source?.width; const h = e?.source?.height;
                                  if (!w || !h) return;
                                  const sized = { ...img, width: w, height: h };
                                  docImagesRef.current = { ...docImagesRef.current, [slot.id]: sized };
                                  setDocImages((prev) => (prev[slot.id] && prev[slot.id].image === img.image ? { ...prev, [slot.id]: sized } : prev));
                                }}
                              />
                            </ScrollView>
                          ) : docFailed[slot.id] ? (
                            <TouchableOpacity style={s.previewLoading} activeOpacity={0.8} onPress={() => ensureDocCards([slot.id], docId)}>
                              <Ionicons name="cloud-offline-outline" size={38} color={T.faint} />
                              <Text style={s.previewLoadingText}>{docFailed[slot.id]}</Text>
                              <View style={[s.retryChip, { backgroundColor: slot.accent }]}>
                                <Ionicons name="refresh" size={13} color="#fff" />
                                <Text style={s.retryChipText}>Tap to retry</Text>
                              </View>
                            </TouchableOpacity>
                          ) : (
                            <View style={s.previewLoading}>
                              <ActivityIndicator size="large" color={slot.accent} />
                              <Text style={s.previewLoadingText}>Rendering {slot.name}…</Text>
                            </View>
                          )}
                        </View>
                        {/* Fit for this employer (top-right) and the best design (top-left). Siblings of
                            the clip, so the rounded corners never cut them. */}
                        {slot.fit != null && (
                          <View style={[s.fitPill, fitStyleOf(slot.fit)]} pointerEvents="none">
                            <Text style={s.fitPillText}>{slot.fit}% fit</Text>
                          </View>
                        )}
                        {i === 0 && slot.fit != null && (
                          <View style={s.bestBadge} pointerEvents="none">
                            <Ionicons name="ribbon" size={11} color="#fff" />
                            <Text style={s.bestBadgeText} numberOfLines={1}>Best for {passEmployer || 'this employer'}</Text>
                          </View>
                        )}
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            )}
          </View>

          <View style={s.indicator}>
            {docSlots.length > 1 && (
              <View style={s.dots}>
                {docSlots.map((slot, i) => (
                  <TouchableOpacity key={slot.id} onPress={() => goTo(i)} hitSlop={8}>
                    <View style={[s.dot, i === active && { width: 22, backgroundColor: selectedDoc?.accent || T.blue }]} />
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <Text style={s.designName}>{selectedDoc?.name || 'Cover Letter'}</Text>
            {!!selectedDoc?.reason && <Text style={s.fitReason} numberOfLines={2}>{selectedDoc.reason}</Text>}
          </View>
        </>
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
          {(preferredFormat === 'docx' ? ['docx', 'pdf'] : ['pdf', 'docx']).map((fmt, i) => (
            <TouchableOpacity
              key={fmt}
              style={[s.dlOuter, i > 0 && { marginTop: 8 }]}
              activeOpacity={0.9}
              onPress={() => handleDownload(fmt as 'pdf' | 'docx')}
              disabled={downloading}
            >
              <LinearGradient
                colors={fmt === 'pdf' ? [T.navy, '#1a2346'] : ['#2B579A', '#1f407a']}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.dlBtn}
              >
                {downloading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name={dlLabel.locked ? 'lock-closed' : (fmt === 'pdf' ? 'download-outline' : 'document-text-outline')} size={17} color="#fff" />
                    <Text style={s.dlText}>{fmt === 'pdf' ? 'Download PDF' : 'Download as Word'}</Text>
                    {!!dlBadge && <View style={s.credBadge}><Text style={s.credBadgeText}>{dlBadge}</Text></View>}
                  </>
                )}
              </LinearGradient>
            </TouchableOpacity>
          ))}
          {/* Same rule as the resume gallery: a pass owner is a paying customer, so do not tell
              them downloads are "included in every paid plan" as though they had not bought one. */}
          <Text style={s.footerNote}>
            {!dlLabel.locked
              ? `Included · ${mode === 'onepage' ? 'one continuous page' : 'A4, splits into pages'}`
              : 'Previews are free · downloads are included in every paid plan'}
          </Text>
        </View>
      )}
      <RatingPromptModal visible={!!rating.trigger} trigger={rating.trigger} onClose={closeRating} />
      <DownloadPaywallSheet
        visible={payOpen}
        employer={passEmployer}
        onClose={() => { setPayOpen(false); setPendingFmt(null); }}
        onSeePlans={() => router.push('/(subscription)/plans' as never)}
        onUnlocked={async () => {
          setPayOpen(false);
          await refreshDownloadState();
          const fmt = pendingFmt; setPendingFmt(null);
          if (fmt) handleDownload(fmt);
        }}
      />
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
  // Doc mode
  previewLoading:     { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 24 },
  previewLoadingText: { fontSize: 12.5, fontWeight: '600', color: T.muted, textAlign: 'center' },
  retryChip:          { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 8 },
  retryChipText:      { fontSize: 12.5, fontWeight: '800', color: '#fff' },
  fitReason:    { fontSize: 11.5, fontWeight: '600', color: T.muted, textAlign: 'center', paddingHorizontal: 28 },
  fitPill:      { position: 'absolute', top: 10, right: 10, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4, shadowColor: T.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.18, shadowRadius: 6, elevation: 4 },
  fitHi:        { backgroundColor: '#0E9F6E' },
  fitMid:       { backgroundColor: T.blueDeep },
  fitLo:        { backgroundColor: 'rgba(11,15,34,0.62)' },
  fitPillText:  { fontSize: 11.5, fontWeight: '800', color: '#fff', letterSpacing: 0.1 },
  bestBadge:    { position: 'absolute', top: 10, left: 10, maxWidth: CARD_W - 120, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: T.navy, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4, shadowColor: T.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.18, shadowRadius: 6, elevation: 4 },
  bestBadgeText:{ fontSize: 11.5, fontWeight: '800', color: '#fff', flexShrink: 1 },
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
