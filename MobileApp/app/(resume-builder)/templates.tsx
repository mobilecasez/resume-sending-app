// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The design gallery: 15 layout families × recolored variants (73 designs) from
// GET /resume-builder/templates. ⚠️ This prose said "9 families / 37 designs" long after the
// catalogue had grown — the only trustworthy count is `totalDesigns`, computed below from what
// the server actually returned. Do not re-hardcode a number here.
// One full preview per FAMILY, recolors via swatch taps —
// previews are fetched lazily in small batches because rendering every design in one request
// is exactly what used to break this screen at nine designs (multi-MB base64 + a serial
// chromium loop outliving the client timeout).
//
// Previews are free for everyone. DOWNLOADING the file is a paid-plan feature: the button is
// shown to free users too, and tapping it explains + routes to the plans screen. The server
// enforces the same rule with a 403 reason:'paid_required'.
//
// DOC MODE (route param `docId`): the gallery shows ONE EMPLOYER'S OWN résumé — the version rewritten
// for that company and stored in user_employer_documents — instead of the user's base résumé.
// Previews render from that doc, the "All designs" order follows the doc's ranked design list (best
// chance of being picked first, with a fit % on every design), downloads carry the docId so the
// server renders and bills THAT document, and Edit opens that doc in the editor.
// ⚠️ Doc mode never writes preferred_template: that column is the BASE résumé's design (Auto Fill
// attach, email attachment). A tailored version choosing a design must not repaint every other file.
// Without `docId` every line below behaves exactly as it did before doc mode existed.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Alert, ActivityIndicator, Dimensions, Platform, Modal, Pressable,
  NativeSyntheticEvent, NativeScrollEvent, useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams, useFocusEffect, useNavigation } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { downloadAsync, cacheDirectory } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { API_BASE } from '../../config';
import DownloadPaywallSheet from '../../components/downloads/DownloadPaywallSheet';
import { fetchDownloadState, downloadButtonLabel, type DownloadState } from '../../services/downloadPassService';
import { fetchSubscriptionStatus } from '../../services/subscriptionService';
import { fetchDoc, type Design } from '../../services/employerDocs';

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

/** A route param → a real doc id, or null. Anything that is not a positive integer is "no doc". */
function docIdOf(raw: unknown): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── Doc ranking ─────────────────────────────────────────────────────────────────────────────────
// pos = the design's place in design.ranked (0 = the best fit for this employer).
type Rank = { score: number; reason: string; pos: number };
type Ranking = { byId: Map<string, Rank>; topId: string | null };
// The fit reason under the pager is a fixed two-line slot (see reasonSlotH): one line's height,
// and the font-scale cap past which the slot stops growing (the Text is capped to match).
const REASON_LINE_H = 16;
const REASON_MAX_SCALE = 1.3;

function rankingOf(design: Design | null | undefined): Ranking | null {
  const list = Array.isArray(design?.ranked) ? design!.ranked : [];
  const byId = new Map<string, Rank>();
  for (const r of list) {
    if (!r || typeof r.id !== 'string' || byId.has(r.id)) continue;
    const n = Number(r.score);
    byId.set(r.id, {
      score: Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0,
      reason: typeof r.reason === 'string' ? r.reason : '',
      pos: byId.size,
    });
  }
  if (!byId.size) return null;
  return { byId, topId: byId.keys().next().value ?? null };
}

/** A family's best place in the ranking — its best-fitting variant decides where the family sits. */
function bestPosOf(f: Family, rk: Ranking): number {
  let best = Infinity;
  for (const id of [f.id, ...(f.variants || []).map((v) => v.id)]) {
    const r = rk.byId.get(id);
    if (r && r.pos < best) best = r.pos;
  }
  return best;
}

/** Families ordered best-fit first (stable: unranked families keep catalogue order at the end).
 *  ⚠️ Returns the SAME array when there is no ranking, so the base gallery is untouched. */
function orderFamilies(fams: Family[], rk: Ranking | null): Family[] {
  if (!rk) return fams;
  return fams
    .map((f, i) => ({ f, i, b: bestPosOf(f, rk) }))
    .sort((a, b) => (a.b - b.b) || (a.i - b.i))
    .map((x) => x.f);
}

/** The variant of a family that fits this employer best — what the family's page opens on. */
function bestVariantOf(f: Family, rk: Ranking): string {
  let bestId = f.id;
  let best = rk.byId.get(f.id)?.pos ?? Infinity;
  for (const v of f.variants || []) {
    const p = rk.byId.get(v.id)?.pos ?? Infinity;
    if (p < best) { best = p; bestId = v.id; }
  }
  return bestId;
}

export default function ResumeTemplates() {
  const router = useRouter();
  // The (resume-builder) Stack itself — goEdit needs to know WHAT is sitting under this screen
  // before it decides between back() and push(). See goEdit for why that matters.
  const navigation = useNavigation();
  // Home opens this screen on the design the user tapped. Optional: with no param the gallery
  // behaves exactly as before and starts on the first family.
  const { template: wantTemplate, employer: wantEmployer } = useLocalSearchParams<{ template?: string; employer?: string }>();
  const { docId: wantDocId } = useLocalSearchParams<{ docId?: string }>();
  // Doc mode — see the header. A constant for the life of the screen (route params never change
  // under a mounted screen), so closures below may read it freely.
  const docId = docIdOf(wantDocId);
  // The doc's own ranking + employer, once GET /employer-docs/:id answers. null = base gallery, or a
  // doc whose meta could not be read (previews still render from the doc; only the order is lost).
  const [ranking, setRanking]   = useState<Ranking | null>(null);
  const [docEmployer, setDocEmployer] = useState<string | null>(null);
  // The doc was deleted (404 doc_gone / 410 payload_gone) — say so instead of spinning or retrying.
  const [docGone, setDocGone]   = useState(false);
  // The company this download is for. A pass is bought per EMPLOYER, so it has to travel with
  // the request or the payment attaches to nothing. In doc mode the server bills the doc's own
  // employer whatever we send; the doc's name is only the fallback for the download-state label.
  const employer = (Array.isArray(wantEmployer) ? wantEmployer[0] : wantEmployer) || docEmployer || null;
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
  // setActive alone does NOT move the pager — it is a paged ScrollView driven by scrollTo.
  const landOn = useRef<number | null>(null);
  const [mode, setMode]         = useState<Mode>('onepage');
  const [pagerH, setPagerH]     = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [isPaid, setIsPaid]     = useState(false);
  const [dlState, setDlState]   = useState<DownloadState>({ metered: false, paid: false, unlimited: false, remaining: null, passes: 0, ownsEmployer: false, employer: null });
  const [payOpen, setPayOpen]   = useState(false);
  const [pendingFmt, setPendingFmt] = useState<'pdf' | 'docx' | null>(null);

  // ── Lazy preview loader: small batches, deduped, merged into a cache ───────
  // Every batch carries its own 45s timeout and marks ITS ids as failed on any miss — the pager
  // card then shows a tap-to-retry. Nothing in here may leave an id in spinner-limbo.
  // ⚠️ `force` and `cacheGen` both exist for the Edit round trip. The cache is keyed by DESIGN id
  // alone, so once the résumé text changes every entry in it is a stale picture: `force` re-requests
  // ids we already hold, and `cacheGen` makes a request that was already in the air when the cache
  // was dropped throw its own result away instead of writing the pre-edit render back in.
  const cacheGen = useRef(0);
  async function ensurePreviews(ids: string[], force = false) {
    const gen = cacheGen.current;
    const need = [...new Set(ids)].filter((id) => id && (force || !previews[id]) && !inFlight.current.has(id));
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
            body: JSON.stringify(docId ? { ids: batch, docId } : { ids: batch }),
            signal: controller.signal,
          });
          const json = await res.json();
          if (cacheGen.current !== gen) return;          // cache was dropped mid-flight → this answer is stale
          // ⚠️ In doc mode a 404 means THE DOC is gone, not "no résumé" — telling someone with a
          // perfectly good base résumé to "generate your resume first" would send them to a paid build.
          if (res.status === 404 && docId && json?.reason === 'doc_gone') { setDocGone(true); return; }
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
          if (cacheGen.current !== gen) return;
          const msg = e?.name === 'AbortError' ? 'This took too long.' : (e?.message || 'Could not render this design.');
          setFailed((f) => { const next = { ...f }; for (const id of batch) next[id] = msg; return next; });
        } finally {
          clearTimeout(tmr);
        }
      }
    } catch (e: any) {
      if (cacheGen.current === gen) setFailed((f) => { const next = { ...f }; for (const id of need) next[id] = e?.message || 'Could not render this design.'; return next; });
    } finally {
      need.forEach((id) => inFlight.current.delete(id));
    }
  }

  // The VISIBLE design renders first, alone — its request must never wait behind the
  // neighbours'. They prefetch immediately after, so a swipe still lands on a warm image.
  function prefetchAround(idx: number, fams: Family[], sel: Record<string, string>, force = false) {
    const idOf = (j: number) => { const f = fams[j]; return f ? (sel[f.id] || f.id) : ''; };
    const rest = [idOf(idx + 1), idOf(idx - 1)].filter(Boolean);
    const cur = idOf(idx);
    if (cur) ensurePreviews([cur], force).then(() => { if (rest.length) ensurePreviews(rest, force); });
    else if (rest.length) ensurePreviews(rest, force);
  }

  async function loadCatalogue() {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not logged in');
      // Doc mode reads the doc's meta (ranking + employer) alongside the catalogue, not after it:
      // the order decides which family the pager opens on, so it has to be known before the first
      // prefetch — otherwise the first render goes to a design that is about to move.
      const docP = docId ? fetchDoc(docId).catch(() => null) : null;
      const res = await fetch(`${API_BASE}/resume-builder/templates`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!res.ok || !json.families?.length) throw new Error(json.error || 'Could not load designs');
      let rk: Ranking | null = null;
      let gone = false;
      if (docP) {
        const d = await docP;
        if (d === 'gone') { gone = true; setDocGone(true); }
        else if (d) {
          rk = rankingOf(d.design);
          setRanking(rk);
          setDocEmployer(d.employer || null);
          // The page layout the doc was designed for is the sensible default for its download.
          if (d.design?.mode === 'a4' || d.design?.mode === 'onepage') setMode(d.design.mode);
        }
      }
      setFamilies(json.families);
      setRegions(json.regions || []);
      // "All designs" order: best fit first in doc mode, catalogue order otherwise (same array).
      const ordered = orderFamilies(json.families as Family[], rk);
      const sel: Record<string, string> = {};
      // Doc mode opens each family on the variant that fits this employer best.
      for (const f of json.families as Family[]) sel[f.id] = rk ? bestVariantOf(f, rk) : f.id;
      // If we were opened on a specific design, land on ITS family with THAT variant chosen —
      // otherwise the user taps a design on Home and arrives on an unrelated one.
      let start = 0;
      const want = Array.isArray(wantTemplate) ? wantTemplate[0] : wantTemplate;
      if (want) {
        const fi = ordered.findIndex(
          (f) => f.id === want || (f.variants || []).some((v: any) => v.id === want),
        );
        if (fi >= 0) { start = fi; sel[ordered[fi].id] = want; landOn.current = fi; }
      }
      setChosen(sel);
      setActive(start);
      setLoading(false);
      if (!gone) prefetchAround(start, ordered, sel);
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
  // Doc mode: "All" (and every fallback to it) is best-fit first. Base gallery: the same array.
  const orderedFams = useMemo(() => orderFamilies(families, ranking), [families, ranking]);
  const visibleFams = useMemo(() => {
    if (region === 'all') return orderedFams;
    const r = regions.find((x) => x.id === region);
    if (!r) return orderedFams;
    const famOf = (tid: string) => families.find((f) => f.id === tid || f.variants.some((v) => v.id === tid));
    const picked = r.templates.map(famOf).filter(Boolean) as Family[];
    return picked.length ? [...new Set(picked)] : orderedFams;
  }, [region, regions, families, orderedFams]);

  const totalDesigns = useMemo(() => visibleFams.reduce((a, f) => a + f.variants.length, 0), [visibleFams]);

  // ── Coming back from Edit: the preview cache must not outlive the résumé it was rendered from ──
  // ⚠️ `previews` is plain mounted state and ensurePreviews early-returns on any id already in it,
  // so tap Edit → change a bullet → come back and every card still shows the PRE-EDIT render, with
  // no refresh anywhere on the screen. Drop the cache on the focus that follows an edit trip.
  // Only that trip: returning from the plans / paywall screens changed no résumé, and each rebuild
  // is a real chromium render on the server, so a blanket "invalidate on every focus" would burn
  // renders for nothing.
  const returningFromEdit = useRef(false);
  // Refs, not deps: a useFocusEffect callback closing over active/visibleFams/chosen would be a NEW
  // callback on every swipe, and useFocusEffect re-runs it — the invalidation would fire mid-browse.
  const focusState = useRef<{ active: number; fams: Family[]; sel: Record<string, string> }>({ active: 0, fams: [], sel: {} });
  useEffect(() => { focusState.current = { active, fams: visibleFams, sel: chosen }; }, [active, visibleFams, chosen]);
  useFocusEffect(React.useCallback(() => {
    if (!returningFromEdit.current) return;
    returningFromEdit.current = false;
    cacheGen.current += 1;             // orphan anything still in the air (it renders the OLD résumé)
    inFlight.current.clear();
    setPreviews({});
    setFailed({});
    const { active: a, fams, sel } = focusState.current;
    if (fams.length) prefetchAround(a, fams, sel, true);   // force: the ids are all "already cached"
  }, []));

  // ── The selection IS the choice: whatever design is on screen becomes the user's preferred
  // template (debounced). Every downstream file — Auto Fill attach, email attachment, the Home
  // thumbnail — renders THIS template, so what gets sent is exactly what they picked here.
  const prefTimer = useRef<any>(null);
  const activeFamForSave = visibleFams[active];
  const selForSave = activeFamForSave ? (chosen[activeFamForSave.id] || activeFamForSave.id) : '';
  const savePreferred = React.useCallback(async (tpl: string) => {
    try {
      const token = await getToken();
      if (!token) return;
      await fetch(`${API_BASE}/resume-builder/save`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredTemplate: tpl }),
      });
    } catch {}
  }, []);
  useEffect(() => {
    // ⚠️ Doc mode never records a preferred template — see the header.
    if (!selForSave || docId) return;
    if (prefTimer.current) clearTimeout(prefTimer.current);
    prefTimer.current = setTimeout(() => { prefTimer.current = null; savePreferred(selForSave); }, 900);
    return () => { if (prefTimer.current) clearTimeout(prefTimer.current); };
  }, [selForSave, savePreferred, docId]);
  // ⚠️ The cleanup above clears the timer on unmount, so ANY navigation inside that 900ms window
  // silently drops the design the user just chose — the one thing this screen exists to record.
  // goEdit now LEAVES this screen (see below), so the pending save must be fired first; the fetch
  // itself is not tied to the component and finishes after the unmount.
  function flushPreferred() {
    if (!prefTimer.current || docId) return;
    clearTimeout(prefTimer.current);
    prefTimer.current = null;
    if (selForSave) savePreferred(selForSave);
  }

  function pickRegion(id: string) {
    if (id === region) return;
    setRegion(id);
    setActive(0);
    scrollRef.current?.scrollTo({ x: 0, animated: false });
    // The new region's first family must start rendering immediately.
    const fams = id === 'all' ? orderedFams : (() => {
      const r = regions.find((x) => x.id === id);
      if (!r) return orderedFams;
      const famOf = (tid: string) => families.find((f) => f.id === tid || f.variants.some((v) => v.id === tid));
      const picked = r.templates.map(famOf).filter(Boolean) as Family[];
      return picked.length ? [...new Set(picked)] : orderedFams;
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
  // ⚠️ NEVER push a screen that can push you. preview's "Download / Preview" pushes THIS gallery,
  // so a plain push() here grew the stack without limit on the commonest path —
  // preview→templates→preview→templates… Each round trip mounted a FRESH preview (re-running its
  // mount effects), and preview's own Back is a router.replace that swaps only the TOP entry, so
  // hardware back then walked the user down through the copies left underneath: first the gallery
  // they had just left, then a stale preview still showing the pre-edit résumé.
  // So: if a preview is already sitting under us, go BACK to it. Push only when nothing is there to
  // return to (arriving straight from Home's design card), which is the one case that cannot loop.
  function goEdit() {
    // Leaving unmounts this screen either way, and the design choice is still in a 900ms debounce.
    flushPreferred();
    const st = navigation?.getState?.();
    const routes: any[] = st?.routes || [];
    const meIdx = typeof st?.index === 'number' ? st.index : routes.length - 1;
    // Route names inside this Stack are the file names ('preview'); split guards a fuller form.
    const below = String(routes[meIdx - 1]?.name || '').split('/').pop();
    if (below === 'preview' && router.canGoBack()) { router.back(); return; }
    returningFromEdit.current = true;   // we stay mounted → arm the stale-preview invalidation
    // Doc mode edits THAT employer's version; the editor saves it back to the doc, never the base.
    if (docId) { router.push({ pathname: '/(resume-builder)/preview', params: { docId: String(docId) } } as never); return; }
    router.push('/(resume-builder)/preview' as never);
  }

  function pickVariant(famId: string, tplId: string) {
    const sel = { ...chosen, [famId]: tplId };
    setChosen(sel);
    ensurePreviews([tplId]);
  }

  const activeFam = visibleFams[active];
  const dlLabel = downloadButtonLabel(dlState);
  // The badge says what the tap will actually do: nothing when it is simply included.
  const dlBadge = dlState.ownsEmployer || dlState.passes > 0
    ? null
    : dlLabel.locked
      ? 'Locked'
      : (dlState.metered && dlState.paid && dlState.remaining != null ? `${dlState.remaining} left` : null);

  // One-shot: carry the pager to the design Home opened us on, once it exists to be scrolled.
  useEffect(() => {
    if (loading || landOn.current == null || !visibleFams.length) return;
    const idx = Math.min(landOn.current, visibleFams.length - 1);
    landOn.current = null;
    if (idx > 0) requestAnimationFrame(() => scrollRef.current?.scrollTo({ x: idx * WIN, animated: false }));
  }, [loading, visibleFams.length]);
  const selectedId = activeFam ? (chosen[activeFam.id] || activeFam.id) : '';
  const selected = previews[selectedId];
  const selectedMeta = activeFam?.variants.find((v) => v.id === selectedId);
  // Doc mode only: how well the design on screen fits this employer, and why.
  const selectedRank = ranking ? ranking.byId.get(selectedId) || null : null;
  // ⚠️ The reason line is a FIXED two-line slot, not a line that comes and goes. It sits in the
  // indicator under the flex pager, so a design with no reason (or a one-line one) next to a
  // two-line one resized the whole pager on every swipe and swatch tap — the card jumped. The
  // slot is reserved from the moment the ranking lands (ranking is set before the first family
  // renders, so there is no jump on arrival either). Its height follows the reactive font scale,
  // capped like the Text itself, so large accessibility sizes cannot reintroduce the jump.
  const { fontScale } = useWindowDimensions();
  const reasonSlotH = REASON_LINE_H * 2 * Math.min(Math.max(fontScale || 1, 1), REASON_MAX_SCALE);
  const fitStyleOf = (n: number) => (n >= 85 ? s.fitHi : n >= 70 ? s.fitMid : s.fitLo);

  // ⚠️ Not an Alert any more. An alert could only offer PLANS — there was nowhere to put the
  // one-off — and its "View paid plans" was a dead end for someone who wanted a single file.
  function upsellDownload() { setPayOpen(true); }

  const refreshDownloadState = React.useCallback(async () => {
    const st = await fetchDownloadState(employer);
    setDlState(st);
    return st;
  }, [employer]);
  useEffect(() => { refreshDownloadState(); }, [refreshDownloadState]);

  async function handleDownload(fmt: 'pdf' | 'docx' = 'pdf') {
    if (downloading || !selectedId) return;
    // The server is authoritative; this is only about not opening a purchase sheet needlessly.
    const st = dlState;
    const allowed = st.ownsEmployer || st.passes > 0 || st.unlimited || (st.paid && (st.remaining ?? 1) > 0);
    if (!allowed) { setPendingFmt(fmt); upsellDownload(); return; }
    setDownloading(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not logged in');
      const url = fmt === 'docx' ? `${API_BASE}/resume-builder/generate-docx` : `${API_BASE}/resume-builder/generate-pdf`;
      const init = {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: selectedId, mode, employer }),
      };
      // Doc mode: the server renders THAT doc and bills its own employer (body.employer ignored).
      if (docId) init.body = JSON.stringify({ template: selectedId, mode, employer, docId });
      const res = await fetch(url, init);
      const json = await res.json();
      if (docId && res.status === 410) {
        // The doc was deleted between opening the gallery and tapping Download — nothing was charged.
        setDocGone(true);
        Alert.alert('This version is gone', 'It is no longer saved. Go back to Home to see your current one.');
        return;
      }
      // The server said no — its word beats our cached status (subscription may have lapsed).
      if (res.status === 403 && (json.reason === 'paid_required' || json.reason === 'quota_exhausted')) {
        setIsPaid(false); await refreshDownloadState(); setPendingFmt(fmt); upsellDownload(); return;
      }
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
      // The pass is now bound to this employer, or a plan download has been spent — either way the
      // button's label is stale until we re-read it.
      refreshDownloadState();
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
        <View style={s.titleCol}>
          <Text style={s.topTitle}>Choose a Format</Text>
          {/* The count is not deleted, only demoted: it is the only place the user is told how far
              the pager runs, but it answered a question nobody asked from the screen's most
              valuable slot. The corner now carries the way OUT of the gallery. */}
          <Text style={s.countLine}>{totalDesigns || '…'} designs</Text>
        </View>
        <TouchableOpacity onPress={goEdit} style={s.editPill} activeOpacity={0.8}>
          <Ionicons name="create-outline" size={14} color={T.blueDeep} />
          <Text style={s.editPillText}>Edit</Text>
        </TouchableOpacity>
      </View>

      {/* Region chips — a recommendation lens over the same families, no reload */}
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
      ) : docGone ? (
        <View style={s.center}>
          <Ionicons name="document-text-outline" size={46} color={T.faint} />
          <Text style={s.errTitle}>
            {employer ? `This ${employer} version is no longer saved.` : 'This version is no longer saved.'} Go back to Home to see your current one.
          </Text>
          <TouchableOpacity onPress={() => router.back()} style={s.retryBtn} activeOpacity={0.85}>
            <Ionicons name="arrow-back" size={15} color="#fff" />
            <Text style={s.retryText}>Go back</Text>
          </TouchableOpacity>
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
          <Text style={s.lead} numberOfLines={ranking ? 1 : undefined}>
            {ranking && region === 'all'
              ? `Best fit for ${employer || 'this employer'} first · every preview is free`
              : 'Swipe layouts · tap a color to restyle · every preview is free'}
          </Text>

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
                        {/* Doc mode: fit for this employer (top-right) and the single best design
                            (top-left). Siblings of the clip, so the rounded corners never cut them. */}
                        {!!ranking && (() => {
                          const r = ranking.byId.get(tid);
                          return (
                            <>
                              {!!r && (
                                <View style={[s.fitPill, fitStyleOf(r.score)]} pointerEvents="none">
                                  <Text style={s.fitPillText}>{r.score}% fit</Text>
                                </View>
                              )}
                              {tid === ranking.topId && (
                                <View style={s.bestBadge} pointerEvents="none">
                                  <Ionicons name="ribbon" size={11} color="#fff" />
                                  <Text style={s.bestBadgeText} numberOfLines={1}>Best for {employer || 'this employer'}</Text>
                                </View>
                              )}
                            </>
                          );
                        })()}
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
            {!!ranking && (
              <Text style={[s.fitReason, { minHeight: reasonSlotH }]} numberOfLines={2} maxFontSizeMultiplier={REASON_MAX_SCALE}>
                {selectedRank?.reason || ''}
              </Text>
            )}
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

      {/* Sticky footer: ONE button — the three-row footer ate the preview's space. Format and
          page options live in the swipe-up sheet, like the filter sheet elsewhere in the app. */}
      {!loading && !docGone && families.length > 0 && (
        <View style={s.footer}>
          <TouchableOpacity style={s.dlOuter} activeOpacity={0.9} onPress={() => setSheetOpen(true)} disabled={downloading}>
            <LinearGradient colors={[T.navy, '#1a2346']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.dlBtn}>
              {downloading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="download-outline" size={17} color="#fff" />
                  <Text style={s.dlText}>Download</Text>
                  {/* ⚠️ THE PADLOCK FOLLOWS THE PASS, NOT THE SUBSCRIPTION. `isPaid` is set from
                      fetchSubscriptionStatus alone, so someone who had just bought a pass and
                      downloaded a file was still shown 🔒 "Paid plans" on the button they had
                      already paid for — for the life of the account, unless they also subscribed.
                      dlLabel.locked is the same truth the sheet and the format rows use. */}
                  {dlLabel.locked && <View style={s.credBadge}><Ionicons name="lock-closed" size={10} color="#fff" /><Text style={s.credBadgeText}>Paid plans</Text></View>}
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
        </View>
      )}

      {/* ── The download sheet: page format + file format, paid-gated ── */}
      <Modal visible={sheetOpen} transparent animationType="slide" onRequestClose={() => setSheetOpen(false)}>
        <Pressable style={s.sheetBackdrop} onPress={() => setSheetOpen(false)} />
        <View style={s.sheet}>
          <View style={s.sheetHandle} />
          <Text style={s.sheetTitle}>Download “{selectedMeta?.name || activeFam?.name || 'Resume'}”</Text>

          <Text style={s.sheetLabel}>Page layout</Text>
          <View style={s.segWrap}>
            <SegBtn icon="document-outline"  label="One Page" active={mode === 'onepage'} onPress={() => setMode('onepage')} />
            <SegBtn icon="documents-outline" label="A4 Pages" active={mode === 'a4'}      onPress={() => setMode('a4')} />
          </View>

          <Text style={s.sheetLabel}>File format</Text>
          <TouchableOpacity style={s.dlOuter} activeOpacity={0.9} disabled={downloading}
            onPress={() => { setSheetOpen(false); handleDownload('pdf'); }}>
            <LinearGradient colors={[T.navy, '#1a2346']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.dlBtn}>
              <Ionicons name={dlLabel.locked ? 'lock-closed' : 'download-outline'} size={17} color="#fff" />
              <Text style={s.dlText}>PDF</Text>
              {!!dlBadge && <View style={s.credBadge}><Text style={s.credBadgeText}>{dlBadge}</Text></View>}
            </LinearGradient>
          </TouchableOpacity>
          <TouchableOpacity style={[s.dlOuter, { marginTop: 8 }]} activeOpacity={0.9} disabled={downloading}
            onPress={() => { setSheetOpen(false); handleDownload('docx'); }}>
            <LinearGradient colors={['#2B579A', '#1f407a']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.dlBtn}>
              <Ionicons name={dlLabel.locked ? 'lock-closed' : 'document-text-outline'} size={17} color="#fff" />
              <Text style={s.dlText}>Word (.docx)</Text>
              {!!dlBadge && <View style={s.credBadge}><Text style={s.credBadgeText}>{dlBadge}</Text></View>}
            </LinearGradient>
          </TouchableOpacity>

          <Text style={s.footerNote}>
            {dlState.ownsEmployer
              ? `Unlocked for ${dlState.employer || 'this employer'} · every design and the cover letter`
              : dlState.passes > 0
                ? 'You have a download ready to use · it unlocks this employer'
                : dlLabel.locked
                  ? 'Previews are free · buy this one, or take a plan'
                  : `Included in your plan · ${mode === 'onepage' ? 'one continuous page' : 'A4, splits into pages'}`}
          </Text>
        </View>
      </Modal>
      <DownloadPaywallSheet
        visible={payOpen}
        employer={employer}
        onClose={() => { setPayOpen(false); setPendingFmt(null); }}
        onSeePlans={() => router.push('/(subscription)/plans' as never)}
        onUnlocked={async () => {
          setPayOpen(false);
          await refreshDownloadState();
          const fmt = pendingFmt; setPendingFmt(null);
          if (fmt) handleDownload(fmt);          // carry on with what they were doing
        }}
      />
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
  titleCol:     { alignItems: 'center' },
  countLine:    { fontSize: 11, fontWeight: '700', color: T.faint, marginTop: 1 },
  editPill:     { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.blue + '15', borderRadius: 20, paddingVertical: 7, paddingHorizontal: 12 },
  editPillText: { fontSize: 13, fontWeight: '700', color: T.blueDeep },

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
  // lineHeight is pinned so the two-line slot (minHeight, set inline from the font scale) is exact.
  fitReason:    { fontSize: 11.5, lineHeight: REASON_LINE_H, fontWeight: '600', color: T.muted, textAlign: 'center', paddingHorizontal: 28 },

  // Doc mode badges on the card
  fitPill:      { position: 'absolute', top: 10, right: 10, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4, shadowColor: T.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.18, shadowRadius: 6, elevation: 4 },
  fitHi:        { backgroundColor: '#0E9F6E' },
  fitMid:       { backgroundColor: T.blueDeep },
  fitLo:        { backgroundColor: 'rgba(11,15,34,0.62)' },
  fitPillText:  { fontSize: 11.5, fontWeight: '800', color: '#fff', letterSpacing: 0.1 },
  bestBadge:    { position: 'absolute', top: 10, left: 10, maxWidth: CARD_W - 120, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: T.navy, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4, shadowColor: T.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.18, shadowRadius: 6, elevation: 4 },
  bestBadgeText:{ fontSize: 11.5, fontWeight: '800', color: '#fff', flexShrink: 1 },

  footer:       { backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.border, paddingHorizontal: 16, paddingTop: 10, paddingBottom: Platform.select({ ios: 26, default: 14 }), shadowColor: T.ink, shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 12 },
  sheetBackdrop:{ flex: 1, backgroundColor: 'rgba(11,15,34,0.45)' },
  sheet:        { backgroundColor: T.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 18, paddingTop: 10, paddingBottom: Platform.select({ ios: 34, default: 20 }), gap: 10 },
  sheetHandle:  { alignSelf: 'center', width: 40, height: 4.5, borderRadius: 3, backgroundColor: 'rgba(11,15,34,0.16)', marginBottom: 4 },
  sheetTitle:   { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.3, textAlign: 'center', marginBottom: 2 },
  sheetLabel:   { fontSize: 11, fontWeight: '800', color: T.faint, letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 4 },
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
