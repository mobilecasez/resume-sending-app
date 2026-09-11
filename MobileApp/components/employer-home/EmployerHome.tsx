// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE HOME SCREEN — "one employer, one resume".
//
// Built from the Claude Design mockup "cvApplyr Home Employer Focus". People use this app to
// generate a resume or a cover letter, so Home now leads with exactly that: pick the employer
// you are applying to, watch your real document reshape for them, download it.
//
// ⚠️ WHAT THIS DELIBERATELY DOES **NOT** COPY FROM THE MOCKUP: its pay sheet sells a single PDF
// for €1.99 ("one-time purchase · no subscription"). This app shipped a SUBSCRIPTION model to
// both stores. Selling the same file twice under two models would be a pricing bug, so the CTA
// keeps the mockup's shape and honesty ("preview is free, pay to download") and routes to the
// real paid-plan gate instead of an invented checkout.
//
// ADDING AN EMPLOYER HAPPENS ON THIS SCREEN. It used to hand the pick to the Job Hub (/(ai-hub)
// with addCompany), which walked the user off the page they were designing on. Now the chip lands
// at the FRONT of the row, the row scrolls back to it, and the tailored resume starts building
// behind BuildingOverlay; the carousel shows it when it lands. Tracking the employer is free and
// never starts a job search (services/homeAddEmployer).
// ⚠️ NEVER A SILENT CHARGE (the letters auto-regen drain): the build auto-starts ONLY when the
// server's dry-run gate says the plan, the free allowance, a download pass or the cache covers it,
// and then it is sent coveredOnly so the server refuses rather than fall through to credits. Legacy
// credits, or a gate we could not read, is a question first; exhausted quota is the plans screen.
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash): one driver per view tree, no mixing.
// This file and its two children (MeshStage, PaperCarousel) use useNativeDriver:true ONLY, on
// transform/opacity, and contain no JS-driven Animated.Value — a self-contained native tree.
// That includes the new-chip entrance in EmployerChip. The overlays it shares a screen with
// (JourneyCoach, ResumeScoreModal, BuildingOverlay) are separate trees mounted as siblings, which
// the rule allows.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Animated, Easing,
  ActivityIndicator, RefreshControl, Alert, Platform, Image,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { rememberBuilderEmployer } from '../../services/builderEmployer';
import * as Haptics from 'expo-haptics';
import * as Sharing from 'expo-sharing';
import { downloadAsync, cacheDirectory } from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../../config';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { E, SERIF, sweepWords } from './theme';
import MeshStage from './MeshStage';
import PaperCarousel, { PaperCard } from './PaperCarousel';
import PaperZoom, { OriginRect } from './PaperZoom';
import AddEmployerSheet, { type EmployerPick } from './AddEmployerSheet';
import BuildingOverlay from './BuildingOverlay';
import {
  fetchTargets, fetchHomeCards, fetchTemplateCatalogue, bestDesignForCountry, LETTER_DESIGNS,
  fetchDownloadHistory, cachedDownloadHistory, redownload, gradFor, savePendingListing,
  Target, HomeCard, HomeCards, DownloadHistory as HistoryPayload, DownloadHistoryItem,
} from '../../services/employerHomeService';
import {
  trackEmployer, checkBuildGate, gateJobFor, buildForEmployer, resumeInflightBuild, signedInAccount,
  type BuildGate, type BuildStage, type BuildResult,
} from '../../services/homeAddEmployer';
import DownloadHistory from './DownloadHistory';
import DownloadPaywallSheet from '../downloads/DownloadPaywallSheet';
import { fetchProfileSnapshot, ProfileSetup } from '../../services/profileSetupService';
import { fetchSubscriptionStatus } from '../../services/subscriptionService';
import { track } from '../../services/analytics';

const nav = () => require('expo-router').router;

type Mode = 'resume' | 'letter';

/* ── employers added on THIS screen ─────────────────────────────────────── */

/**
 * The employers the user added from Home, most recent first.
 *
 * ⚠️ MODULE SCOPE, NOT STATE. EmployerHome unmounts whenever the Dashboard is shown, and load()
 * replaces the chip row wholesale from the server — so a chip held only in state would vanish on
 * the next focus, or the moment a /dashboard answer that does not have it yet (tracking failed, or
 * raced the read) landed. Every load merges these IN FRONT, and a server copy of the same employer
 * takes the pending chip's place rather than showing up twice.
 */
const PENDING = 'emp_pending_';
let addedEmployers: Target[] = [];
// The React key an added chip was FIRST rendered under. Tracking swaps 'emp_pending_x' for
// 'emp_<id>' a moment after the add; keyed on the raw key, the chip would remount mid-entrance and
// its animation would snap. Held here so that swap is invisible.
const renderKeyOf = new Map<string, string>();
// Chips this screen invented, so a merge never mistakes its own earlier chip for the server's copy.
let LOCAL = new WeakSet<Target>();

type BuildJob = {
  company: string; website: string; jobUrl?: string; jobText?: string;
  /** The chip's RENDER key — it survives the pending → tracked key swap, so a build finds its chip. */
  rk: string;
};
// The build Home started, for a Home that remounts mid-build (Dashboard round trip). It does not
// survive a relaunch — resumeInflightBuild recovers the job itself; this only adds the company
// name and what the pages looked like before, so "done" can be checked against them.
let homeBuild: { company: string; rk: string; sigBefore: string; t0: number } | null = null;
/**
 * The ONE build waiting behind the running one. An Add during a build used to be dropped silently
 * (or re-showed the OLD company's overlay); now it waits here and goes through the gate when the
 * current one ends. One slot: a newer Add replaces an older wait, so builds never stack up.
 * ⚠️ Module scope for the same reason as addedEmployers (a Dashboard round trip remounts Home), and
 * it EXPIRES: a wait from long ago is not consent to spend a plan build now.
 */
let queuedBuild: { job: BuildJob; at: number } | null = null;
const QUEUE_TTL_MS = 10 * 60 * 1000;

/**
 * ⚠️ WHOSE CACHE THIS IS. Everything above is module scope, and App.js's logout does not reload the
 * bundle — so the next account to sign in saw the previous account's employers leading its chip row,
 * and that account's company in the build overlay. The cache is owned by the signed-in user id (a
 * token hash for a session without one) and wiped whenever a different account — or nobody — is found.
 */
let cacheOwner: string | null = null;

function forgetAccountCache() {
  addedEmployers = [];
  renderKeyOf.clear();
  LOCAL = new WeakSet<Target>();
  homeBuild = null;
  queuedBuild = null;
}

// signedInAccount lives in services/homeAddEmployer — ONE definition, shared with the in-flight record.

/** Make the module cache belong to whoever is signed in now. True when another account's was wiped. */
async function claimAccountCache(): Promise<boolean> {
  const who = await signedInAccount();
  if (who === cacheOwner) return false;
  // The first claim after the bundle loads has no owner to compare against: anything already here was
  // added moments ago by whoever is signed in now, so it is adopted rather than wiped.
  const wipe = cacheOwner !== null || who === null;
  cacheOwner = who;
  if (wipe) forgetAccountCache();
  return wipe;
}

/**
 * Did the server reject this session? Asked ONLY after a load came back with nothing at all: the
 * Home services swallow status codes, so an expired token looks exactly like a network blip.
 * ⚠️ 401 AND 403: server/middleware/auth.js answers an invalid or expired token with 403.
 */
async function sessionRejected(): Promise<boolean> {
  try {
    const tok = JSON.parse((await SecureStore.getItemAsync('userSession')) || '{}')?.token;
    if (!tok) return true;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(`${API_BASE}/users/profile`, { headers: { Authorization: `Bearer ${tok}` }, signal: ctl.signal });
      return r.status === 401 || r.status === 403;
    } finally { clearTimeout(timer); }
  } catch { return false; }   // no answer is not a rejection
}

const hostOf = (u?: string | null) => String(u || '').trim().toLowerCase()
  .replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0] || '';
const sameName = (a?: string, b?: string) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const rkOf = (t: Target) => renderKeyOf.get(t.key) || t.key;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function rememberAdded(t: Target, replacesKey?: string) {
  LOCAL.add(t);
  if (replacesKey) {
    renderKeyOf.set(t.key, renderKeyOf.get(replacesKey) || replacesKey);
    addedEmployers = addedEmployers.map((a) => (a.key === replacesKey ? t : a));
  } else {
    const h = hostOf(t.website);
    addedEmployers = [t, ...addedEmployers.filter((a) => a.key !== t.key && !(h && hostOf(a.website) === h))];
  }
  addedEmployers = addedEmployers.filter((a, i, all) => all.findIndex((b) => b.key === a.key) === i).slice(0, 8);
}

/**
 * The server's list with the employers added here in front.
 * ⚠️ MATCHED BY employerId FIRST. The host is only a stand-in while the id is unknown (tracking has not
 * answered): the dashboard now withholds a domain that fails vetting, and two employers can share one.
 * ⚠️ A SWAP IS PERMANENT AND CARRIES THE PIN. When a server copy takes a pending chip's place under a
 * different key, addedEmployers keeps the copy (so the next load does not swap all over again) and the
 * user's pin moves with it — left behind, load() found no chip under the old key and jumped to index 0.
 */
function mergeAdded(list: Target[], pin?: { current: string | null }): Target[] {
  if (!addedEmployers.length) return list;
  const used = new Set<Target>();
  addedEmployers = addedEmployers.map((a) => {
    const h = hostOf(a.website);
    const copy = list.find((t) => !LOCAL.has(t) && !used.has(t) && t.key.startsWith('emp_') && !t.key.startsWith(PENDING)
      && (a.employerId ? t.employerId === a.employerId : (!!h && hostOf(t.website) === h)));
    if (!copy) return a;
    used.add(copy);
    if (copy.key !== a.key) {
      renderKeyOf.set(copy.key, renderKeyOf.get(a.key) || a.key);
      if (pin && pin.current === a.key) pin.current = copy.key;
    }
    return copy;
  }).filter((a, i, all) => all.findIndex((b) => b.key === a.key) === i);
  const frontKeys = new Set(addedEmployers.map((t) => t.key));
  return [...addedEmployers, ...list.filter((t) => !used.has(t) && !LOCAL.has(t) && !t.key.startsWith(PENDING) && !frontKeys.has(t.key))];
}

/** What the pages look like now — compared after a build, so "done" means the NEW resume is up. */
const cardsSig = (cs: HomeCard[]) => cs.map((c) => `${c.id}:${(c.image || '').length}:${(c.image || '').slice(-40)}`).join('|');

type Overlay = {
  visible: boolean; company: string; stage: BuildStage | null; done: boolean;
  error: { reason: string; message: string } | null;
  /** What Retry does: recover-then-rebuild (re-gated), or only reload the pages it already built. */
  retry: 'build' | 'refresh' | null;
};
const OVERLAY_CLOSED: Overlay = { visible: false, company: '', stage: null, done: false, error: null, retry: null };
const GATE_COPY: Record<'quota_exhausted' | 'regen_limit', string> = {
  quota_exhausted: 'You have used the resume builds your plan includes. See plans to build this one.',
  regen_limit: 'Your free plan includes one AI rebuild, and it has been used. See plans to tailor a resume for every employer.',
};
/**
 * After the chip's hold, how long the dry-run gate may take before it counts as unread. The service
 * allows a request 20s; past this the answer is 'unknown', which ASKS — never a guess that it was covered.
 */
const GATE_WAIT_MS = 8000;
/** The overlay's neutral state while the gate is read: it starts nothing and claims nothing. */
const CHECKING: BuildStage = { stage: 'checking', label: 'Checking your plan…', pct: 0 };

/** The dry-run gate for exactly the build that would run, with Home's own shorter deadline. */
async function readGate(job: BuildJob): Promise<BuildGate> {
  const unread: BuildGate = { covered: false, via: null, reason: 'unknown' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      checkBuildGate(job.company, gateJobFor(job)),
      new Promise<BuildGate>((r) => { timer = setTimeout(() => r(unread), GATE_WAIT_MS); }),
    ]);
  } catch { return unread; } finally { if (timer) clearTimeout(timer); }
}

export default function EmployerHome({
  firstName, onOpenDashboard, onOpenMenu, onOpenNotifications, unreadCount = 0, handleReview,
  loaders,
}: {
  firstName?: string;
  onOpenDashboard: () => void;
  onOpenMenu: () => void;
  onOpenNotifications: () => void;
  unreadCount?: number;
  handleReview?: (tab?: number) => void;
  // Injectable data sources, defaulting to the real services. The preview route passes fixtures
  // so the design can be rendered and inspected without a signed-in account.
  loaders?: {
    targets: () => Promise<Target[]>;
    cards: () => Promise<HomeCards | 'none' | null>;
    paid?: () => Promise<boolean>;
    catalogue?: () => Promise<HomeCard[]>;
    /** The library section. Injected so the preview harness can render it from fixtures. */
    history?: (kind: 'resume' | 'cover_letter') => Promise<HistoryPayload | null>;
    setup?: () => Promise<ProfileSetup | null>;
  };
}) {
  // The dark stage runs edge to edge under the status bar (HomeScreen drops its top safe-area
  // edge for this screen), so the hero owns that inset itself. Without this the notch band is
  // painted in the app's LIGHT background and sits as a grey strip above the near-black hero.
  const insets = useSafeAreaInsets();
  const [rootH, setRootH] = useState(0);
  // What the hero puts on the stage, and what the WHOLE page does. The backdrop is one gradient
  // over all of it now, and it needs both: the page height to know how far it runs, the hero height
  // to know where the colour should resolve. See `focus` in MeshStage.
  const [heroH, setHeroH] = useState(0);
  const [pageH, setPageH] = useState(0);
  const [zoom, setZoom] = useState<{ i: number; rect: OriginRect } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const regionHint = useCallback((c: string) => bestDesignForCountry(c)?.name || null, []);
  /**
   * Tell the builder which posting this is for. The server tailors the resume to it — ordering and
   * wording only, never invented facts.
   * ⚠️ `autoBuild` is NOT set here: that lane generates immediately and spends a plan generation.
   */
  const armBuilderFor = useCallback(async (t?: Target) => {
    await AsyncStorage.setItem('resume_builder_entry', JSON.stringify({
      from: 'home_employer',
      target: t ? { company: t.company, role: t.role, applyUrl: t.applyUrl || t.jobUrl || '' } : null,
    })).catch(() => {});
    // The company also has to survive into the EDITOR's own download button, which has no params
    // to inherit — otherwise a pass bought there attaches to nothing. See services/builderEmployer.
    await rememberBuilderEmployer(t?.company);
  }, []);
  // Drives ONLY the pinned header's backdrop. Native driver, and the header is a sibling of the
  // ScrollView — a separate view tree from the mesh, so the b126 one-driver-per-tree rule holds.
  const scrollY = useRef(new Animated.Value(0)).current;
  // The library's empty state points back UP at the carousel rather than pushing a route: the
  // designs are 800pt straight up on this same screen.
  const scrollRef = useRef<any>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [empIdx, setEmpIdx] = useState(0);
  const [cards, setCards] = useState<HomeCard[]>([]);
  // Every design in the catalogue, as a slot. Pixels arrive later and are merged in by id.
  const [slots, setSlots] = useState<HomeCard[]>([]);
  const [shots, setShots] = useState<Record<string, string>>({});
  const dead = useRef<Record<string, true>>({});
  const hydrating = useRef(false);
  const [hydrateNudge, setHydrateNudge] = useState(0);
  const [cardIdx, setCardIdx] = useState(0);
  const [mode, setMode] = useState<Mode>('resume');
  const [loading, setLoading] = useState(true);
  const [noResume, setNoResume] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // These pages are a stand-in built from the account's name and email — say so.
  const [sample, setSample] = useState(false);
  const [isPaid, setIsPaid] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reshaping, setReshaping] = useState(false);
  // The library below the hero: what they have already paid to download, per kind.
  const [history, setHistory] = useState<DownloadHistoryItem[]>([]);
  const [histLoading, setHistLoading] = useState(true);
  const [histOpen, setHistOpen] = useState(false);
  const [againId, setAgainId] = useState<number | null>(null);
  // Whether the profile is filled in, straight from the server's own `setup` — this screen does
  // NOT get to invent a third definition of "complete" (the API and the journey already disagree).
  const [setup, setSetup] = useState<ProfileSetup | null>(null);
  const lastLoad = useRef(0);
  // The employer the user actually TAPPED, held by key. empIdx alone is a position into a list
  // that is re-fetched and re-sorted by match on every focus, so a background refresh could slide
  // a different company under the same index — the ribbon and the CTA would silently rename
  // themselves to an employer the user never chose. Stays null until they pick, so the default
  // (best match first) is still free to move.
  const pickedKey = useRef<string | null>(null);

  const loadTargets = loaders?.targets || fetchTargets;
  const loadCards = loaders?.cards || fetchHomeCards;
  const loadPaid = loaders?.paid || (async () => { try { const st = await fetchSubscriptionStatus(); return !!st?.subscription; } catch { return false; } });
  const loadHistory = loaders?.history || fetchDownloadHistory;
  const loadSetup = loaders?.setup || (async () => (await fetchProfileSnapshot())?.setup ?? null);

  // ⚠️ READ THROUGH A REF, SO load() NEVER CHANGES IDENTITY. loadPaid/loadSetup above are new
  // arrow functions on every render, and load used to depend on them — so load was a new function
  // every render and useFocusEffect re-ran it: any render more than 60s after the last load fired a
  // full reload. A build re-renders Home on every progress tick, which made that a reload storm that
  // could replace the chip row mid-build.
  const live = useRef({ loaders, loadTargets, loadCards, loadPaid, loadSetup });
  live.current = { loaders, loadTargets, loadCards, loadPaid, loadSetup };
  // ⚠️ SEQUENCE GUARD: two loads can overlap (focus + pull-to-refresh + a build's refresh), and a
  // slower OLDER one landing last would put the pre-build pages back on screen.
  const loadSeq = useRef(0);

  /**
   * `freshPages` clears the per-design page images in the SAME commit as the new cards, never
   * before: clearing first sets the hydrator off alongside this load's own cold render and queues a
   * run of serial chromium renders (single-process chromium dies after ~4-5).
   * Resolves undefined when throttled or superseded, else what it fetched.
   */
  const load = useCallback(async (force = false, freshPages = false):
    Promise<{ cards: HomeCards | 'none' | null; targets: Target[] } | undefined> => {
    if (!force && Date.now() - lastLoad.current < 60_000) return undefined;
    lastLoad.current = Date.now();
    const seq = ++loadSeq.current;
    const { loaders, loadTargets, loadCards, loadPaid, loadSetup } = live.current;
    const [fetched, c, cat, wiped] = await Promise.all([
      loadTargets(),
      loadCards(),
      (loaders?.catalogue || fetchTemplateCatalogue)().catch(() => [] as HomeCard[]),
      // ⚠️ BEFORE the merge below: another account's added employers must never lead this row.
      // The preview harness has no account, and claiming would wipe its fixtures on every load.
      loaders ? Promise.resolve(false) : claimAccountCache(),
    ]);
    if (wiped) pickedKey.current = null;
    // Nothing came back at all: if that was the server refusing the session, the cache goes too.
    if (!loaders && !fetched.length && c === null && (await sessionRejected())) {
      forgetAccountCache();
      cacheOwner = null;
      pickedKey.current = null;
    }
    if (seq !== loadSeq.current) return undefined;
    if (cat.length) setSlots(cat);
    // Employers added on this screen lead, whether or not the server has them yet.
    const t = mergeAdded(fetched, pickedKey);
    setTargets(t);
    if (pickedKey.current) {
      const j = t.findIndex((x) => x.key === pickedKey.current);
      setEmpIdx(j >= 0 ? j : 0);
      if (j < 0) pickedKey.current = null; // their employer dropped off the list
    }
    // ⚠️ Only the server's own 'none' may arm the build-my-resume lane — see fetchHomeCards.
    // A transient failure leaves cards AND noResume exactly as they were: at worst the user sees
    // the retry state, never a CTA that would spend a generation rewriting a resume they have.
    if (c === 'none') { setCards([]); setNoResume(true); setLoadFailed(false); }
    else if (c) {
      if (freshPages) { dead.current = {}; setShots({}); }
      setCards(c.cards); setNoResume(false); setSample(!!c.sample); setLoadFailed(false);
    }
    else { setLoadFailed(true); }
    setLoading(false);
    const paid = await loadPaid();
    if (seq === loadSeq.current) setIsPaid(paid);
    loadSetup().then((st) => setSetup(st)).catch(() => {});
    return { cards: c, targets: t };
  }, []);

  /**
   * The library, per kind.
   *
   * ⚠️ CACHE FIRST, THEN REVALIDATE. Home has no SWR anywhere today, so a cold open shows nothing
   * until the network answers. Painting the last answer first is the difference between a section
   * that appears and one that pops in a second late; the reference for this shape is the Job Hub's
   * dashboard cache. A failed refresh returns null and leaves what is on screen alone.
   */
  const refreshHistory = useCallback(async (kind: Mode) => {
    const wire: 'resume' | 'cover_letter' = kind === 'letter' ? 'cover_letter' : 'resume';
    setHistOpen(false);
    if (!loaders) {
      const cached = await cachedDownloadHistory(wire).catch(() => null);
      if (cached) { setHistory(cached.items); setHistLoading(false); }
    }
    const fresh = await loadHistory(wire).catch(() => null);
    if (fresh) setHistory(fresh.items);
    else if (loaders) setHistory([]);
    setHistLoading(false);
  }, [loadHistory, loaders]);

  useEffect(() => { setHistLoading(true); refreshHistory(mode); }, [mode, refreshHistory]);

  /**
   * Get a document again.
   *
   * ⚠️ THE SERVER DECIDES, NOT THIS FUNCTION. It re-renders through the very same controller the
   * first download used, so canDownload runs again exactly as it did then: a pass bought for that
   * employer keeps it free forever, and a plan that has since lapsed answers 403 — at which point
   * the honest response is the same purchase sheet a first download offers, not an error.
   */
  const [payFor, setPayFor] = useState<string | null>(null);
  const againItem = useRef<DownloadHistoryItem | null>(null);

  const doAgain = useCallback(async (it: DownloadHistoryItem) => {
    if (againId != null) return;
    setAgainId(it.id);
    track('home_history_again', { kind: it.kind, unlocked: it.unlocked, format: it.format });
    try {
      const r = await redownload(it.id);
      if (!r.ok) {
        if (r.locked) { againItem.current = it; setPayFor(it.employer || null); return; }
        Alert.alert(r.gone ? 'That letter is gone' : 'Could not get that file', r.message);
        return;
      }
      const raw = await SecureStore.getItemAsync('userSession').catch(() => null);
      const tok = JSON.parse(raw || '{}')?.token;
      const cleanPath = r.downloadUrl.replace(/^\/api/, '');
      const name = decodeURIComponent(r.downloadUrl.split('/').pop() || 'document');
      const dl = await downloadAsync(`${API_BASE}${cleanPath}`, cacheDirectory + name, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (dl.status !== 200) throw new Error('Download failed');
      const mime = it.format === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/pdf';
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(dl.uri, { mimeType: mime, dialogTitle: 'Save or share' });
      } else {
        Alert.alert('Downloaded', 'Saved successfully.');
      }
      refreshHistory(mode);
    } catch (e: any) {
      Alert.alert('Could not get that file', e?.message || 'Please try again.');
    } finally {
      setAgainId(null);
    }
  }, [againId, mode, refreshHistory]);

  /**
   * A page image we ALREADY have for this design, or nothing.
   *
   * ⚠️ IT NEVER TRIGGERS A FETCH. /home-cards is capped at five ids server-side because rendering
   * is serial and single-process chromium dies after about five pages; Home's own hydration runs
   * behind a single-flight mutex within a bounded window for the same reason. A library row that
   * asked for its own render would stampede the front door of the app.
   */
  const thumbFor = useCallback((templateId: string): string | null | undefined => {
    if (!templateId) return null;
    const hit = cards.find((c) => c.id === templateId);
    return (hit && hit.image) || shots[templateId] || null;
  }, [cards, shots]);

  /** The design's accent, from the catalogue already in hand. Never a fetch. */
  const accentFor = useCallback((templateId: string): string => {
    const hit = slots.find((c) => c.id === templateId) || cards.find((c) => c.id === templateId);
    return (hit && hit.accent) || E.blue;
  }, [slots, cards]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(true); setRefreshing(false); };

  const target: Target | undefined = targets[empIdx];
  // What the carousel actually shows. With a catalogue we show EVERY design — the ones the server
  // already rendered lead, the rest follow as slots and fill in on approach.
  const deck: PaperCard[] = React.useMemo(() => {
    if (!slots.length) return cards as PaperCard[];
    const ready = new Map(cards.map((c) => [c.id, c] as const));
    const lead = cards.map((c) => ({ ...c, image: shots[c.id] || c.image })) as PaperCard[];
    const rest = slots
      .filter((sl) => !ready.has(sl.id))
      .map((sl) => ({ ...sl, image: shots[sl.id] || null })) as PaperCard[];
    return [...lead, ...rest];
  }, [cards, slots, shots]);

  // Fill in the pages around the one being looked at, a few at a time and never two waves at once:
  // renders are serial server-side and the preview browser recycles every 3 pages.
  useEffect(() => {
    if (!deck.length || noResume || loaders) return;
    let cancelled = false;
    const run = async () => {
      if (hydrating.current) return;
      // ⚠️ BOUNDED to the cards either side of the one on screen. An unbounded search would always
      // find five more missing designs somewhere in the deck, so each wave would trigger the next
      // and the whole catalogue would render itself off one glance at Home — exactly the stampede
      // the 5-per-request cap exists to prevent. Nothing renders unless it is nearly in view.
      const WINDOW = 6;
      const want: string[] = [];
      for (let k = 0; k <= WINDOW * 2 && want.length < 5; k++) {
        const i = cardIdx + (k % 2 === 0 ? k / 2 : -((k + 1) / 2));
        if (i < 0 || i >= deck.length) continue;
        const d = deck[Math.round(i)];
        if (d && !d.image && !dead.current[d.id] && !want.includes(d.id)) want.push(d.id);
      }
      if (!want.length) return;
      hydrating.current = true;
      try {
        const got = await fetchHomeCards(want);
        if (cancelled) return;
        if (got && got !== 'none') {
          const add: Record<string, string> = {};
          for (const c of got.cards) if (c.image) add[c.id] = c.image;
          for (const id of want) if (!add[id]) dead.current[id] = true;
          if (Object.keys(add).length) setShots((p) => ({ ...p, ...add }));
        } else {
          for (const id of want) dead.current[id] = true;   // don't hammer a failing renderer
        }
      } finally {
        hydrating.current = false;
        // ⚠️ A wave cancelled by a deck change (a build's fresh pages, say) used to leave nothing
        // scheduled: the run the change queued found the mutex still held and returned, so the new
        // resume's designs stayed blank until the user swiped. Knock once so it runs again.
        if (cancelled) setHydrateNudge((n) => n + 1);
      }
    };
    const id = setTimeout(run, 260);
    return () => { cancelled = true; clearTimeout(id); };
  }, [cardIdx, deck, noResume, loaders, hydrateNudge]);

  const card: PaperCard | undefined = deck[cardIdx];

  // Picking an employer "reshapes" the page — the scan pulse the mockup plays over the card.
  const pickEmployer = (i: number) => {
    if (i === empIdx) return;
    setEmpIdx(i);
    pickedKey.current = targets[i]?.key || null;
    setReshaping(true);
    try { Haptics.selectionAsync(); } catch {}
    setTimeout(() => setReshaping(false), 950);
    track('home_employer_pick', { i });
  };
  // ⚠️ ONE IDENTITY FOR THE LIFE OF THE SCREEN, so the memoised chips stay memoised: a fresh
  // `() => pickEmployer(i)` per chip per render re-rendered every chip on every build-stage tick.
  const pickRef = useRef(pickEmployer);
  pickRef.current = pickEmployer;
  const onPickChip = useCallback((i: number) => pickRef.current(i), []);

  /* ── add an employer, and build for it, without leaving Home ── */

  const [overlay, setOverlayState] = useState<Overlay>(OVERLAY_CLOSED);
  // ⚠️ THE REF IS WRITTEN WITH THE STATE, NOT AT THE NEXT RENDER. The flow reads overlayRef to decide
  // whether a build is on screen (a done stamp vs a notice, whether a queued build may start). Synced
  // only at render, a result that arrived before React re-rendered read the PREVIOUS overlay — a build
  // on screen looked hidden, and its "ready" became a notice under a spinner that never stamped done.
  const overlayRef = useRef(overlay);
  const setOverlay = useCallback((next: Overlay | ((o: Overlay) => Overlay)) => {
    const v = typeof next === 'function' ? next(overlayRef.current) : next;
    overlayRef.current = v;
    setOverlayState(v);
  }, []);
  const [notice, setNotice] = useState<string | null>(null);
  // Which chip plays the entrance: keyed by render key AND a counter, so only the newly added chip
  // animates, and adding the same employer twice replays it.
  const [enter, setEnter] = useState<{ key: string; n: number } | null>(null);
  const chipRowRef = useRef<ScrollView>(null);
  const alive = useRef(true);
  // One build at a time from this screen, held from the gate read through the page refresh.
  const building = useRef(false);
  // Set once THIS instance starts a build, so a recovered one from before a remount never also
  // lands its result here.
  const localBuild = useRef(false);
  // The job being gated or built right now (a queued Add's notice names it), and the last one, for
  // Try again. `lastSig` is what the pages looked like when that build started.
  const current = useRef<BuildJob | null>(null);
  const lastJob = useRef<BuildJob | null>(null);
  const lastSig = useRef<{ sig: string; t0: number } | null>(null);
  // The mount-time recovery has finished, so a focus may start a queued build without racing it.
  const recovered = useRef(false);
  // A line to show once the overlay is closed (it would expire unseen behind the modal).
  const noteOnClose = useRef<string | null>(null);
  const landing = useRef<{ company: string; rk: string; sigBefore: string | null; cached: boolean; t0: number } | null>(null);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(id);
  }, [notice]);
  // "Add employer" is the LAST item in the row, so the user is usually scrolled right when the new
  // chip lands at the start. From an effect, so the insert has committed before the scroll.
  useEffect(() => {
    if (!enter) return;
    const id = setTimeout(() => chipRowRef.current?.scrollTo({ x: 0, animated: true }), 40);
    return () => clearTimeout(id);
  }, [enter]);

  /** Put a new chip row on screen and keep the user's pin on the chip it names. */
  const applyTargets = (next: Target[]) => {
    setTargets(next);
    if (pickedKey.current) {
      const j = next.findIndex((x) => x.key === pickedKey.current);
      setEmpIdx(j >= 0 ? j : 0);
    }
  };

  /** Select the chip a build was for — by render key, which is stable across the tracking swap. */
  const pinBuilt = (list: Target[], rk: string) => {
    const j = rk ? list.findIndex((t) => rkOf(t) === rk) : -1;
    if (j < 0) return;
    pickedKey.current = list[j].key;
    setEmpIdx(j);
  };

  const followStage = (st: BuildStage) => {
    if (alive.current) setOverlay((o) => (o.done || o.error ? o : { ...o, stage: st }));
  };

  /**
   * Start the build that waited behind the one that just ended — through the gate like any Add, so
   * waiting in line is never a pre-approved charge. Not while another build or overlay holds the screen.
   */
  const drainQueue = () => {
    const q = queuedBuild;
    if (!q || building.current || overlayRef.current.visible || !alive.current) return;
    queuedBuild = null;
    if (Date.now() - q.at > QUEUE_TTL_MS) return;
    gateAndBuild(q.job);
  };

  /**
   * The build is on the server; this makes the pages on screen BE it.
   * ⚠️ "Done" is claimed only once fresh cards arrived. A failed refresh only sets loadFailed, which
   * is invisible while the deck is non-empty — so trusting it would show the OLD resume under the
   * new ribbon and call it built.
   * ⚠️ FRESH = PAGES THAT DIFFER FROM BEFORE, OR THE SERVER SAYING IT SERVED ITS CACHE. Nothing else.
   * Accepting the second refresh "as what the server has" stamped Ready over UNCHANGED pages whenever
   * the read raced the save; that is the honest 'refresh' state instead (built, pages not in yet).
   */
  /**
   * `sigBefore` is the page signature from BEFORE the build, or null when there is no honest one.
   * ⚠️ A BUILD RECOVERED AFTER A RELAUNCH HAS NO "BEFORE". Its signature used to be read from the cards
   * on screen at recovery time — but if the job finished while the app was closed, Home's first load
   * already shows the NEW pages, so before === after, the freshness check failed, and a landed, charged
   * build ended on "your pages did not refresh". "Load my pages" re-ran with the same signature, so it
   * could never clear. With null, a successful fresh load of the server's pages is the proof.
   */
  const landBuild = async (company: string, rk: string, cached: boolean, sigBefore: string | null, t0: number) => {
    building.current = true;
    landing.current = { company, rk, sigBefore, cached, t0 };
    setOverlay((o) => ({ ...o, error: null, retry: null, stage: { stage: 'refresh', label: 'Built — refreshing your pages…', pct: 97 } }));
    let fresh = false;
    for (let attempt = 0; attempt < 2 && !fresh; attempt++) {
      if (attempt) await sleep(2500);
      if (!alive.current) break;
      const got = await load(true, true).catch(() => undefined);
      if (!got || !got.cards || got.cards === 'none') continue;
      if (cached || sigBefore === null || cardsSig(got.cards.cards) !== sigBefore) {
        fresh = true;
        pinBuilt(got.targets, rk);
      }
    }
    building.current = false;
    if (!alive.current) return;
    if (!fresh) {
      track('home_build_fail', { reason: 'refresh' });
      setOverlay((o) => ({
        ...o, visible: true, company: company || o.company, stage: null, done: false, retry: 'refresh',
        error: { reason: 'refresh', message: `Your ${company} resume is built, but your pages did not refresh. Try again to load them.` },
      }));
      return;
    }
    landing.current = null;
    track('home_build_done', { cached, ms: Date.now() - t0 });
    try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    setReshaping(true);
    setTimeout(() => { if (alive.current) setReshaping(false); }, 950);
    // The overlay stamps "done" and dismisses ITSELF (its own hold timer calls onDismiss, which starts
    // any queued build). One hidden mid-build gets a line instead, and the queue goes straight away.
    if (!overlayRef.current.visible) {
      setNotice(`Your ${company} resume is ready.`);
      setOverlay(OVERLAY_CLOSED);
      drainQueue();
      return;
    }
    setOverlay((o) => ({ ...o, company: company || o.company, done: true, error: null, retry: null, stage: { stage: 'done', label: 'Ready', pct: 100 } }));
  };

  const finishBuild = async (company: string, rk: string, r: BuildResult, sigBefore: string | null, t0: number) => {
    homeBuild = null;
    if (!alive.current) { building.current = false; return; }
    if (!r.ok) {
      building.current = false;
      const reason: string = r.reason;
      track('home_build_fail', { reason });
      if (reason === 'pending') {
        // ⚠️ A5: the job may still finish AND charge. No rebuild is offered, and nothing waits behind
        // it: starting the next build now would only be refused while this one runs, or overlap it.
        const waiting = queuedBuild;
        queuedBuild = null;
        const next = waiting ? ` Add ${waiting.job.company} again once your ${company} resume arrives.` : '';
        if (!overlayRef.current.visible) {
          setNotice(`Your ${company} resume is taking longer than usual — it may still arrive.${next}`);
          setOverlay(OVERLAY_CLOSED);
          return;
        }
        // Said once the overlay closes: a notice set now would expire unseen behind the full-screen modal.
        if (waiting) noteOnClose.current = `${waiting.job.company} was not started.${next}`;
      }
      // ⚠️ The chip STAYS. Try again recovers the build the service still holds before it will start
      // another (retryBuild), and anything new goes back through the gate.
      setOverlay((o) => ({
        ...o, visible: true, company: company || o.company, stage: null, done: false,
        error: { reason, message: r.message },
        retry: reason === 'network' || reason === 'failed' ? 'build' : null,
      }));
      return;
    }
    setOverlay((o) => ({ ...o, company: company || o.company }));
    await landBuild(company, rk, r.cached, sigBefore, t0);
  };

  /**
   * `coveredOnly` is the consent: true = the server may spend only plan, free allowance, pass or cache
   * and must refuse (402 → the plans state) rather than fall through to credits. ⚠️ false ONLY after the
   * user tapped Build on a dialog that named a credit charge.
   */
  const runBuild = async (job: BuildJob, via: string, coveredOnly: boolean, show = true) => {
    if (building.current) return;
    building.current = true;
    localBuild.current = true;
    current.current = job;
    lastJob.current = job;
    const t0 = Date.now();
    const sigBefore = cardsSig(cardsRef.current);
    lastSig.current = { sig: sigBefore, t0 };
    homeBuild = { company: job.company, rk: job.rk, sigBefore, t0 };
    track('home_build_start', { gate: via, coveredOnly });
    setOverlay({ visible: show, company: job.company, stage: null, done: false, error: null, retry: null });
    let r: BuildResult;
    try {
      r = await buildForEmployer(
        { company: job.company, website: job.website, jobUrl: job.jobUrl, jobText: job.jobText, coveredOnly },
        followStage,
      );
    } catch {
      r = { ok: false, reason: 'failed', message: 'We could not finish building your resume. Please try again.' };
    }
    await finishBuild(job.company, job.rk, r, sigBefore, t0);
  };

  /**
   * ⚠️ THE STANDING RULE: never regenerate and charge silently. An explicit Add IS the intent to
   * build, so it starts on its own ONLY when the dry-run gate says plan / free / pass / cache covers
   * it. Credits are a question with the number in it; a gate we could not read is a question too,
   * never a guess; exhausted quota shows the plans, not a charge.
   *
   * `named` resolves to the job under the name the server STORED once tracking answers — the gate,
   * the build and the overlay all wait for it, so the chip, the fingerprint and the resume never
   * disagree about what the employer is called.
   */
  const gateAndBuild = async (job: BuildJob, holdMs = 0, named?: Promise<BuildJob | null>) => {
    if (building.current) {
      const cur = current.current;
      const curName = cur?.company || overlayRef.current.company;
      if ((cur && cur.rk === job.rk) || sameName(curName, job.company)) {
        // The same employer: that build IS this one — bring it back rather than charging twice.
        setOverlay((o) => (o.company ? { ...o, visible: true } : o));
        return;
      }
      // Another employer: it waits its turn, and says so.
      queuedBuild = { job, at: Date.now() };
      track('home_build_queued', {});
      setNotice(curName
        ? `Your ${curName} resume is still building — we'll build ${job.company} next.`
        : `We'll build ${job.company} as soon as the current build is done.`);
      return;
    }
    building.current = true;   // held through the gate read, so two quick adds cannot both pass it
    current.current = job;
    lastJob.current = job;
    let answered = false;
    const decided = (async () => {
      const final = named ? await named.catch(() => job) : job;
      return { final, gate: final ? await readGate(final) : null };
    })().finally(() => { answered = true; });
    // `holdMs` lets the new chip land and glow BEFORE a full-screen overlay or a dialog covers it — the
    // user asked for "go to that card, THEN build". The gate is read during the hold, not after.
    await sleep(holdMs);
    if (!answered) await Promise.race([decided, sleep(holdMs ? 0 : 300)]);
    // ⚠️ NEVER A SILENT WAIT. Past the hold a slow gate used to leave the screen doing nothing for up
    // to 20s; now it says what it is doing, and starts nothing while it does.
    let checking = false;
    if (!answered && alive.current) {
      checking = true;
      setOverlay({ visible: true, company: job.company, stage: CHECKING, done: false, error: null, retry: null });
    }
    const { final, gate } = await decided;
    building.current = false;
    if (!alive.current) return;
    // Closing "Checking your plan…" is "carry on without this screen", and the build honours it.
    const show = !checking || overlayRef.current.visible;
    if (!final || !gate) {
      if (checking) setOverlay(OVERLAY_CLOSED);
      return;   // the session was refused while tracking; the notice already says so
    }
    current.current = final;
    lastJob.current = final;
    if (gate.covered) { runBuild(final, gate.via, true, show); return; }
    if (checking) setOverlay(OVERLAY_CLOSED);
    if (gate.via === 'credits') {
      const n = gate.credits;
      Alert.alert(`Build your ${final.company} resume?`, `This uses ${n} credit${n === 1 ? '' : 's'}.`, [
        { text: 'Cancel', style: 'cancel', onPress: () => { track('home_build_declined', { gate: 'credits' }); drainQueue(); } },
        { text: 'Build', onPress: () => { runBuild(final, 'credits', false); } },
      ]);
      return;
    }
    if (gate.reason === 'unknown') {
      Alert.alert(
        `Build your ${final.company} resume?`,
        'We could not check your plan just now, so this build may use your plan allowance or credits.',
        [
          { text: 'Not now', style: 'cancel', onPress: () => { track('home_build_declined', { gate: 'unknown' }); drainQueue(); } },
          // The dialog names credits, so this tap is the explicit consent coveredOnly:false needs.
          { text: 'Build', onPress: () => { runBuild(final, 'unknown', false); } },
        ],
      );
      return;
    }
    track('home_build_fail', { reason: gate.reason });
    setOverlay({
      visible: true, company: final.company, stage: null, done: false, retry: null,
      error: { reason: gate.reason, message: GATE_COPY[gate.reason] },
    });
  };

  /** A refused session: the module cache is this account's no longer, and nothing more is built. */
  const dropAccountOnAuth = () => {
    forgetAccountCache();
    cacheOwner = null;
    pickedKey.current = null;
    if (!alive.current) return;
    setTargets((ts) => ts.filter((t) => !t.key.startsWith(PENDING)));
    setNotice('Please sign in again to add employers.');
  };

  /**
   * The pick from AddEmployerSheet. ⚠️ No navigation: the user asked to STAY on the page they were
   * designing on. The chip is optimistic — it is on screen before the server has heard of it.
   */
  const addEmployerHere = (value: string, extra: EmployerPick) => {
    const website = String(extra?.website || value || '').trim();
    const host = hostOf(website);
    const name = String(extra?.name || '').trim() || host || 'Employer';
    const jobUrl = extra?.jobUrl || undefined;
    const jobText = extra?.jobText || undefined;
    const pending: Target = {
      key: PENDING + (host || name.toLowerCase()), jobId: null, employerId: null,
      company: name, website, role: '', match: null,
      initial: name.charAt(0).toUpperCase() || '?', colors: gradFor(name), skills: [],
    };
    rememberAdded(pending);
    const next = mergeAdded(targetsRef.current, pickedKey);
    const rk = rkOf(next[0]);
    pickedKey.current = next[0].key;
    setTargets(next);
    setEmpIdx(0);
    setEnter((e) => ({ key: rk, n: (e?.n || 0) + 1 }));
    try { Haptics.selectionAsync(); } catch {}

    const typed: BuildJob = { company: name, website, jobUrl, jobText, rk };
    // Tracking is NOT required to build: a failed track keeps the chip, under the typed name, for this
    // session and says so. A refused SESSION is different — that builds nothing.
    // ⚠️ THE STORED NAME WINS. The server keeps one shared name per employer; the chip used to keep
    // what was typed while the dashboard (and the next load) said the stored one.
    const named: Promise<BuildJob | null> = trackEmployer({ name, website }).then(async (r) => {
      if (r.ok) {
        const e = r.employer;
        const stored = e.name || name;
        const real: Target = {
          ...pending, key: 'emp_' + e.employerId, employerId: e.employerId, company: stored,
          website: e.website || website, initial: e.logoInitial || pending.initial, colors: e.logoColor,
        };
        rememberAdded(real, pending.key);
        if (pickedKey.current === pending.key) pickedKey.current = real.key;
        if (alive.current) applyTargets(mergeAdded(targetsRef.current, pickedKey));
        const final: BuildJob = { ...typed, company: stored, website: e.website || website };
        if (queuedBuild && queuedBuild.job.rk === rk) queuedBuild = { ...queuedBuild, job: final };
        return final;
      }
      // ⚠️ The auth middleware answers an expired token with 403, which the service reports as 'network';
      // one look at the session on that failure path is what tells the two apart.
      if (r.reason === 'auth' || (r.reason === 'network' && (await sessionRejected()))) { dropAccountOnAuth(); return null; }
      if (alive.current) {
        setNotice(r.reason === 'limit' || r.reason === 'invalid'
          ? r.message
          : `We could not save ${name} to your employers yet — it stays here for now.`);
      }
      // ⚠️ A website the server refused (a job board or ATS host that is not this employer's) is not
      // handed to the build either: the generator would research the job board as the employer.
      // ⚠️ AND NOT TO A QUEUED COPY OF IT. The success branch above rewrites queuedBuild; this one did
      // not, so an employer added while another build ran kept the refused board host and was built
      // around boards.greenhouse.io.
      if (r.reason === 'invalid') {
        if (queuedBuild && queuedBuild.job.rk === rk) queuedBuild = { ...queuedBuild, job: { ...queuedBuild.job, website: '' } };
        return { ...typed, website: '' };
      }
      return typed;
    }).catch(() => typed);

    // The listing also rides to the section editor, which looks it up by company or URL — under the
    // SAME name and site the build uses. Sequential: both writes rewrite the same storage key, and in
    // parallel the second would drop the first.
    if (jobUrl || jobText) {
      named.then((j) => (j
        ? savePendingListing(j.company, { jobUrl, jobText }).then(() => savePendingListing(j.website, { jobUrl, jobText }))
        : undefined)).catch(() => {});
    }

    // Cover letters from Home come later: in letter mode the add only selects the employer.
    if (mode === 'resume') gateAndBuild(typed, 950, named);
  };

  // A build that was running when Home unmounted (or the app was killed) is picked back up: the
  // overlay reopens and the resume it paid for is shown when it lands.
  useEffect(() => {
    if (loaders) return;   // the preview harness has no account to build for
    (async () => {
      // ⚠️ Claimed FIRST: homeBuild and queuedBuild may belong to the account that just signed out.
      await claimAccountCache().catch(() => false);
      try {
        if (localBuild.current || !alive.current) return;
        const mem = homeBuild;
        let opened = false;
        const open = (st: BuildStage | null) => {
          if (localBuild.current || !alive.current) return;
          if (!opened) {
            opened = true;
            building.current = true;
            setOverlay({ visible: true, company: mem?.company || '', stage: st, done: false, error: null, retry: null });
          } else if (st) {
            setOverlay((o) => (o.done || o.error ? o : { ...o, stage: st }));
          }
        };
        if (mem) open(null);
        const res = await resumeInflightBuild(open).catch(() => null);
        if (localBuild.current || !alive.current) return;
        if (!res) {
          if (opened) { building.current = false; setOverlay(OVERLAY_CLOSED); }
          if (!queuedBuild) return;
          // Nothing in flight, so a build queued behind one that ended while Home was away can go — once
          // the pages are in. ⚠️ Started before them, its "before" would be empty and ANY pages that
          // came back would count as the new resume.
          for (let k = 0; k < 20 && !cardsRef.current.length && alive.current; k++) await sleep(250);
          recovered.current = true;
          drainRef.current();
          return;
        }
        open(null);
        recovered.current = true;
        const rk = mem && sameName(mem.company, res.company) ? mem.rk : '';
        // No remembered signature means no honest "before" — see landBuild.
        await finishBuild(res.company, rk, res.result, mem?.sigBefore ?? null, mem?.t0 ?? Date.now());
      } finally { recovered.current = true; }
    })().catch(() => { recovered.current = true; });
    // Once per mount, on purpose: this recovers a build, it does not follow prop changes.
  }, []);

  // Back on Home (from the plans screen, say) with a build still waiting in line.
  const drainRef = useRef(drainQueue);
  drainRef.current = drainQueue;
  useFocusEffect(useCallback(() => {
    if (!loaders && recovered.current && queuedBuild) drainRef.current();
  }, [loaders]));

  /**
   * ⚠️ TRY AGAIN NEVER STARTS A SECOND PAID BUILD ON TOP OF THE FIRST. 'network' and 'failed' can both
   * mean the job is still running (a lost 202, a dropped poll): the service kept that entry and re-uses
   * its clientBuildId, which the server dedupes. So Try again first picks that build back up; then, if
   * nothing is in flight, looks at the pages in case it landed meanwhile; only then does a new build
   * start — and that one goes back through the gate.
   */
  const retryBuild = async () => {
    const job = lastJob.current;
    if (!job || building.current) return;
    building.current = true;
    setOverlay((o) => ({
      ...o, visible: true, company: job.company, done: false, error: null, retry: null,
      stage: { stage: 'checking', label: 'Checking on your resume…', pct: 0 },
    }));
    const res = await resumeInflightBuild(followStage).catch(() => null);
    if (!alive.current) { building.current = false; return; }
    const before = lastSig.current;
    if (res) {
      const rk = sameName(res.company, job.company) ? job.rk : '';
      await finishBuild(res.company, rk, res.result, before?.sig ?? cardsSig(cardsRef.current), before?.t0 ?? Date.now());
      return;
    }
    const got = await load(true, true).catch(() => undefined);
    building.current = false;
    if (!alive.current) return;
    if (before && got && got.cards && got.cards !== 'none' && cardsSig(got.cards.cards) !== before.sig) {
      pinBuilt(got.targets, job.rk);
      track('home_build_done', { cached: false, ms: Date.now() - before.t0, recovered: true });
      setOverlay((o) => ({ ...o, done: true, error: null, retry: null, stage: { stage: 'done', label: 'Ready', pct: 100 } }));
      return;
    }
    setOverlay(OVERLAY_CLOSED);
    gateAndBuild(job);
  };

  const retryOverlay = () => {
    const o = overlayRef.current;
    const l = landing.current;
    if (o.retry === 'refresh' && l) { landBuild(l.company, l.rk, l.cached, l.sigBefore, l.t0); return; }
    if (o.retry === 'build') retryBuild();
  };

  /** Hiding a running build keeps it going; closing a finished or failed one lets the queue move. */
  const dismissOverlay = () => {
    const o = overlayRef.current;
    if (!(o.done || o.error)) { setOverlay({ ...o, visible: false }); return; }
    setOverlay(OVERLAY_CLOSED);
    if (noteOnClose.current) { setNotice(noteOnClose.current); noteOnClose.current = null; }
    drainQueue();
  };

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    try { Haptics.selectionAsync(); } catch {}
    track('home_mode', { mode: m });
  };

  const headline = mode === 'resume' ? 'Design your resume' : 'Write your cover letter';
  const accent = mode === 'resume' ? 'exclusively for the employer.' : 'for this exact posting.';

  const headerH = insets.top + 52;
  /**
   * ⚠️ THERE IS NO SECOND SURFACE ON THIS SCREEN ANY MORE. The stage used to end partway down and
   * melt into a light section that carried the library; however carefully that melt was tuned, it
   * was still a place where one surface stopped and another began, and it read as a line. The
   * backdrop is now ONE gradient over the entire page — dark navy at the top, opening a little
   * toward the foot — and everything, library included, sits on it.
   * `focus` keeps the hero looking like the hero: it tells the mesh to resolve its colour inside
   * the first screenful rather than spreading it over a page three times as tall.
   */
  const stageH = Math.max(rootH || 700, headerH + pageH);
  // ⚠️ CAPPED AT 0.82. While the deck is still loading the page is barely taller than the
  // viewport, so the ratio runs to ~0.95 and the teal wash — which sits at three quarters of
  // the colour — lands in the middle of the first screen and turns it green for a second.
  const focus = pageH ? Math.max(0.18, Math.min(0.82, (headerH + heroH) / stageH)) : 0.75;
  const gridRows = Math.ceil(stageH / 30) + 2;

  return (
    <View style={s.root} onLayout={(e) => setRootH(e.nativeEvent.layout.height)}>
      <Animated.ScrollView
        ref={scrollRef}
        style={s.flex}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={E.blue} progressViewOffset={headerH} />}
      >
      {/* ────────────────── ONE GRADIENT, THE WHOLE PAGE ────────────────── */}
      <MeshStage style={{ minHeight: stageH, paddingTop: headerH }} focus={focus} rows={gridRows}>
        {/* ⚠️ EVERYTHING GOES INSIDE, INCLUDING THE TAIL. Anything rendered after </MeshStage>
            would sit on the root colour, and the root is the near-black the gradient STARTS from —
            so a sibling below would be a hard step back to dark at the bottom of the page. */}
        <View onLayout={(e) => setPageH(Math.round(e.nativeEvent.layout.height))}>
        <View onLayout={(e) => setHeroH(Math.round(e.nativeEvent.layout.height))}>
        {/* live pill + edit */}
        <View style={[s.rowBetween, { paddingHorizontal: 16, paddingTop: 14 }]}>
          <View style={s.livePill}>
            <LiveDot />
            <Text style={s.livePillTx}>TAILORED PER EMPLOYER · LIVE</Text>
          </View>
          <TouchableOpacity onPress={() => nav()?.push?.('/(resume-builder)')} style={s.editBtn} activeOpacity={0.85}>
            <Ionicons name="create-outline" size={12} color="#fff" />
            <Text style={s.editTx}>Edit details</Text>
          </TouchableOpacity>
        </View>

        {/* headline — the mode switch rides the free space on its right */}
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <View style={s.headRow}>
            <Text style={[s.h1, s.headText]}>{headline}</Text>
            <ModeSwitch mode={mode} onChange={switchMode} />
          </View>
          <Text style={s.h1Accent}>
            {sweepWords(accent).map((p, i) => (
              <Text key={i} style={{ color: p.c }}>{p.w}{i < accent.split(' ').length - 1 ? ' ' : ''}</Text>
            ))}
          </Text>
          <Text style={s.sub}>
            {mode === 'resume'
              ? 'One posting, one resume — reshaped around what they ask for.'
              : 'Written from this posting and your experience.'}
          </Text>
        </View>

        {/* employer chips */}
        <View style={{ paddingTop: 14 }}>
          <Text style={s.eyebrowDark}>Designing for</Text>
          {loading ? (
            <View style={s.chipsRow}><View style={s.chipSkeleton} /><View style={s.chipSkeleton} /></View>
          ) : targets.length ? (
            <ScrollView ref={chipRowRef} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipsRow}>
              {targets.map((t, i) => {
                const rk = rkOf(t);
                return (
                  <EmployerChip
                    key={rk}
                    t={t}
                    index={i}
                    on={i === empIdx}
                    enterToken={enter && enter.key === rk ? enter.n : 0}
                    onPick={onPickChip}
                  />
                );
              })}
              <TouchableOpacity
                style={s.chipAdd}
                activeOpacity={0.85}
                onPress={() => { track('home_add_employer_open', { from: 'chips' }); setAddOpen(true); }}
              >
                <Ionicons name="add" size={16} color="#fff" />
                <Text style={s.chipAddTx}>Add employer</Text>
              </TouchableOpacity>
            </ScrollView>
          ) : (
            <TouchableOpacity
              style={[s.chipsRow, s.emptyTargets]}
              activeOpacity={0.85}
              onPress={() => { track('home_add_employer_open', { from: 'empty' }); setAddOpen(true); }}
            >
              <Ionicons name="add" size={15} color="#fff" />
              <Text style={s.emptyTargetsTx}>Add an employer to design your resume around</Text>
              <Ionicons name="arrow-forward" size={14} color="rgba(255,255,255,0.6)" />
            </TouchableOpacity>
          )}
          {/* Non-blocking: a failed track or a finished background build is worth a line, never a dialog. */}
          {!!notice && (
            <View style={s.addNotice}>
              <Ionicons name="information-circle" size={13} color={E.mint} />
              <Text style={s.addNoticeTx} numberOfLines={2}>{notice}</Text>
            </View>
          )}
        </View>

        {/* the paper */}
        <View style={{ paddingTop: 10 }}>
          {mode === 'letter' ? (
            <LetterPanel
              company={target?.company}
              onWrite={() => {
                track('home_letter_write', { hasTarget: !!target });
                if (target?.jobId || target?.jobUrl) {
                  nav()?.push?.({ pathname: '/(ai-hub)', params: { tab: 'myjobs' } });
                } else {
                  setAddOpen(true);
                }
              }}
            />
          ) : noResume ? (
            <NoResume onBuild={() => {
              AsyncStorage.setItem('resume_builder_entry', JSON.stringify({ from: 'home_employer', autoBuild: true })).catch(() => {});
              nav()?.push?.('/(resume-builder)');
            }} />
          ) : deck.length ? (
            <PaperCarousel
              cards={deck}
              index={cardIdx}
              onIndex={setCardIdx}
              ribbon={target ? { letter: target.initial, short: target.company, colors: target.colors } : null}
              onOpen={(i, rect) => { setCardIdx(i); setZoom({ i, rect }); track('home_paper_open', { i }); }}
            />
          ) : loadFailed ? (
            <TouchableOpacity style={s.paperLoading} activeOpacity={0.8} onPress={() => load(true)}>
              <Ionicons name="cloud-offline-outline" size={22} color="rgba(255,255,255,0.5)" />
              <Text style={s.paperFailTx}>Couldn't load your designs</Text>
              <Text style={s.paperFailSub}>Tap to retry</Text>
            </TouchableOpacity>
          ) : (
            <View style={s.paperLoading}><ActivityIndicator color="#fff" /></View>
          )}

          {/* caption */}
          {mode === 'resume' && (
          <View style={s.caption}>
            {reshaping ? (
              <View style={s.rowCenter}>
                <Ionicons name="sparkles" size={12} color="#C4BBFF" />
                <Text style={s.captionScan}> Reshaping for {target?.company || 'this employer'}…</Text>
              </View>
            ) : (
              <View style={s.rowCenter}>
                <Text style={s.captionName}>{card?.name || 'Your resume'}</Text>
                <View style={s.capDot} />
                <Text style={s.captionMeta}>
                  {target
                    ? `${target.match != null ? target.match + '% match · ' : ''}${target.company}`
                    : 'Ready to send'}
                </Text>
              </View>
            )}
          </View>
          )}

          {/* ⚠️ INSIDE MeshStage ON PURPOSE. stageH = rootH * 1.18, so the hero is taller than the
              viewport and anything placed after </MeshStage> is below the fold on first paint —
              a CTA that has to be seen "right below the slider" cannot live down there.
              It shows only while the profile is unfinished, which is also the only time the
              library below is empty, so the two never compete for the same space. */}
          {!!setup && (() => {
            // ⚠️ NAME WHAT IS ACTUALLY LEFT. `setup` carries four real booleans from the server, so
            // saying "Make yours" to someone who finished two steps last week tells them their work
            // is gone. In wizard order, so the sentence matches the screens they will see.
            const left = ([
              [setup.profile, 'your details'], [setup.photo, 'a photo'],
              [setup.signature, 'your signature'], [setup.resume, 'your experience'],
            ] as Array<[boolean, string]>).filter(([done]) => !done).map(([, n]) => n);
            const started = setup.profile || setup.photo || setup.signature || setup.resume;
            // ⚠️ THE WIZARD IS THE ONLY WAY IN, SO IT IS ALWAYS REACHABLE.
            // Gating it on an unfinished profile meant that the moment someone completed one, the
            // door disappeared — and rebuilding a resume from fresh notes is a thing people want to
            // do repeatedly, not once.
            // ⚠️ AND IT IS MINT, NOT BLUE. The finished state used to be a glass pill, which on a
            // blue-violet hero is the one thing on the screen you cannot see. Every other surface
            // here is blue or violet, so the only colour that can carry a call to action is the
            // one that is not: the mint already in the LIVE pill and at the end of the headline's
            // sweep. Dark ink on a bright fill, rather than white on mid-blue, is what makes it
            // read from across the room. Weight still varies — the glow, not the colour — so a
            // finished profile gets a quieter version of the same button instead of a hidden one.
            const sub = !started
              ? 'A few details and we will build your real resume into every design above.'
              : left.length === 0
                ? 'New notes, a fresh resume — into every design above.'
                : left.length === 1
                  ? `One thing left — ${left[0]}.`
                  : `${left.length} things left — ${left.slice(0, -1).join(', ')} and ${left[left.length - 1]}.`;
            // "Make your Resume" names the DESTINATION — the wizard that makes one — not a claim
            // that you have not got one. Someone mid-way gets the more useful sentence instead.
            const label = left.length && started ? 'Pick up where you left off' : 'Make your Resume';
            const go = () => {
              try { Haptics.selectionAsync(); } catch {}
              track('home_make_yours', { has: [setup.profile && 'p', setup.photo && 'i', setup.signature && 's', setup.resume && 'r'].filter(Boolean).join('') });
              nav()?.push?.('/(onboarding)');
            };
            return (
              <>
                <TouchableOpacity
                  style={[s.makeWrap, !left.length && s.makeCalm]}
                  activeOpacity={0.9}
                  onPress={go}
                >
                  <LinearGradient
                    colors={MAKE_MINT}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={s.makeBtn}
                  >
                    <Ionicons name="sparkles" size={16} color={MAKE_INK} />
                    <Text style={s.makeTx} numberOfLines={1}>{label}</Text>
                    <Ionicons name="arrow-forward" size={15} color="rgba(4,33,28,0.6)" />
                  </LinearGradient>
                </TouchableOpacity>
                <Text style={s.makeSub} numberOfLines={2}>{sub}</Text>
              </>
            );
          })()}

          {sample && mode === 'resume' && (
            <TouchableOpacity
              style={s.sampleBar}
              activeOpacity={0.9}
              onPress={() => {
                track('home_sample_build', { hasTarget: !!target });
                armBuilderFor(target).finally(() => nav()?.push?.('/(resume-builder)'));
              }}
            >
              <Ionicons name="information-circle" size={15} color={E.mint} />
              <Text style={s.sampleTx} numberOfLines={2}>
                This is a sample so you can see the designs. Build yours to fill them with your own details.
              </Text>
              <Ionicons name="chevron-forward" size={15} color="rgba(255,255,255,0.55)" />
            </TouchableOpacity>
          )}
        </View>
        </View>

      {/* ─────────────────── YOUR LIBRARY ───────────────────
          What used to be here re-showed the SAME resume pages the carousel above was already
          showing — `image={cards[i % cards.length]?.image}` under a company badge — so scrolling
          revealed the same designs twice and said nothing new. This says what only they know:
          what they have already paid for, and can have again. */}
      <View style={s.library}>
      <DownloadHistory
        mode={mode}
        items={history}
        loading={histLoading}
        expanded={histOpen}
        busyId={againId}
        thumbFor={thumbFor}
        accentFor={accentFor}
        onAgain={doAgain}
        onPay={(employer) => { againItem.current = null; setPayFor(employer); }}
        onExpand={() => { try { Haptics.selectionAsync(); } catch {} setHistOpen(true); }}
        onScrollToTop={() => scrollRef.current?.scrollTo?.({ y: 0, animated: true })}
        onMoreJobs={() => nav()?.push?.({ pathname: '/(ai-hub)', params: { tab: 'myjobs' } })}
      />
      </View>

      {/* the old home, one tap away */}
      <TouchableOpacity style={s.dashLink} activeOpacity={0.8} onPress={onOpenDashboard}>
        <Ionicons name="grid-outline" size={15} color="rgba(255,255,255,0.62)" />
        <Text style={s.dashLinkTx} numberOfLines={1}>Open Dashboard</Text>
        <Ionicons name="chevron-forward" size={14} color="rgba(255,255,255,0.34)" />
      </TouchableOpacity>

      {/* The tab bar's worth of room, ON the gradient rather than under it. */}
      <View style={s.tail} />
      </View>
      </MeshStage>
      </Animated.ScrollView>

      {/* ── PINNED HEADER ───────────────────────────────────────────────────
          It never scrolls, so it can no longer ride up under the clock and battery.
          Its backdrop is TRANSPARENT at rest and fades in only once the page moves: at the top of
          the screen there is literally nothing painted here, so it cannot read as a second
          background — the stage's own flat top band shows through and the two are one surface. */}
      <View style={[s.headerWrap, { height: headerH, paddingTop: insets.top }]} pointerEvents="box-none">
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { opacity: scrollY.interpolate({ inputRange: [0, 64], outputRange: [0, 1], extrapolate: 'clamp' }) }]}
        >
          <LinearGradient colors={['rgba(7,10,24,0.97)', 'rgba(7,10,24,0.90)']} style={StyleSheet.absoluteFill} />
          <View style={s.headerHair} />
        </Animated.View>
        <View style={s.headerRow}>
          <View style={s.brandRow}>
            <Image source={require('../../assets/images/logo_img.png')} style={s.brandLogo} resizeMode="contain" />
            <Text style={s.brandTx}>cv<Text style={{ color: E.blue }}>applyr</Text></Text>
          </View>
          <View style={s.topActions}>
            <TouchableOpacity onPress={onOpenNotifications} style={s.glassBtn} activeOpacity={0.8}>
              <Ionicons name="notifications-outline" size={17} color="#fff" />
              {unreadCount > 0 && <View style={s.badge}><Text style={s.badgeTx}>{unreadCount > 9 ? '9+' : unreadCount}</Text></View>}
            </TouchableOpacity>
            <TouchableOpacity onPress={onOpenMenu} style={s.glassBtn} activeOpacity={0.8}>
              <Ionicons name="menu" size={19} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* the page, full size, with the only two things you can do with a design */}
      <AddEmployerSheet
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        regionHint={regionHint}
        onPick={(value, extra) => {
          setAddOpen(false);
          const hasListing = !!(extra?.jobUrl || extra?.jobText);
          // The sheet always hands on a website now, so a url flag would always be true; and it does
          // not say whether the site came from a result or was typed, so there is no honest flag to
          // send in its place. ⚠️ Never the name or the website itself: that is the user's job hunt.
          track('home_add_employer_pick', { listing: hasListing });
          // ⚠️ NO NAVIGATION. This used to push to the Job Hub with addCompany, and the user was
          // walked off the page they were designing on. The add, the chip and the build all happen
          // here now; the pasted listing goes straight to the build (and to device storage for the
          // section editor), never through a route param.
          addEmployerHere(value, extra);
        }}
      />

      {/* Mounted as a SIBLING of the scroll view, never inside the hero: its own tree, so whatever
          driver it animates with never meets the hero's native one. */}
      <BuildingOverlay
        visible={overlay.visible}
        company={overlay.company}
        stage={overlay.stage}
        done={overlay.done}
        error={overlay.error}
        onDismiss={dismissOverlay}
        onRetry={overlay.retry === 'refresh' || (overlay.retry === 'build' && !!lastJob.current) ? retryOverlay : undefined}
        onSeePlans={overlay.error && (overlay.error.reason === 'quota_exhausted' || overlay.error.reason === 'regen_limit')
          ? () => { setOverlay(OVERLAY_CLOSED); nav()?.push?.('/(subscription)/plans'); }
          : undefined}
      />

      {/* ⚠️ The SAME sheet a first download offers. A row goes locked when the plan that paid for it
          has ended, and the honest answer to that is the two ways to pay — not an error dialog.
          A react-native Modal is a separate native window above the whole navigator, which is why
          the sheet hides itself while the plans screen it pushes is up. */}
      <DownloadPaywallSheet
        visible={payFor !== null}
        employer={payFor}
        onClose={() => { setPayFor(null); againItem.current = null; }}
        onUnlocked={() => {
          const it = againItem.current;
          setPayFor(null); againItem.current = null;
          refreshHistory(mode);
          if (it) doAgain(it);
        }}
        onSeePlans={() => nav()?.push?.('/(subscription)/plans')}
      />

      <PaperZoom
        card={zoom ? deck[zoom.i] || null : null}
        origin={zoom?.rect || null}
        subtitle={target ? `Designed for ${target.company}` : undefined}
        isPaid={isPaid}
        sample={sample}
        onClose={() => setZoom(null)}
        onCustomize={() => {
          // ⚠️ Straight to the section editor. Writing 'resume_builder_entry' with autoBuild, or
          // 'resumeBuilderAction', would arm a PAID regeneration — neither is touched.
          track('home_customize', { mode, sample });
          if (sample) armBuilderFor(target).finally(() => nav()?.push?.('/(resume-builder)'));
          // Not armBuilderFor: writing 'resume_builder_entry' here would arm a PAID regeneration.
          // Only the employer hint travels, so the editor's download can name the company.
          else rememberBuilderEmployer(target?.company).finally(() => nav()?.push?.('/(resume-builder)/preview'));
        }}
        onViewPdf={() => {
          const id = zoom ? deck[zoom.i]?.id : undefined;
          track('home_view_pdf', { id });
          // The employer travels too: a download pass is bought PER EMPLOYER, so without this the
          // payment would have nothing to attach to.
          nav()?.push?.({
            pathname: '/(resume-builder)/templates',
            params: {
              ...(id ? { template: id } : {}),
              ...(target?.company ? { employer: target.company } : {}),
            },
          });
        }}
      />
    </View>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────────── */

function LiveDot() {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const l = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(a, { toValue: 0, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    l.start(); return () => l.stop();
  }, [a]);
  return <Animated.View style={[s.liveDot, { opacity: a.interpolate({ inputRange: [0, 1], outputRange: [1, 0.35] }), transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [1, 0.7] }) }] }]} />;
}

// Two icons, not two big tabs: the mode is a small, permanent control that sits in the space the
// headline leaves on its right — the headline is what the screen is about, not the switch.
function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const opts: Array<{ k: Mode; ic: any; a11y: string }> = [
    { k: 'resume', ic: 'document-text', a11y: 'Resume' },
    { k: 'letter', ic: 'mail', a11y: 'Cover letter' },
  ];
  return (
    <View style={s.mSwitch}>
      {opts.map((o) => {
        const on = mode === o.k;
        return (
          <TouchableOpacity
            key={o.k}
            onPress={() => onChange(o.k)}
            activeOpacity={0.9}
            accessibilityRole="button"
            accessibilityLabel={o.a11y}
            accessibilityState={{ selected: on }}
            style={[s.mBtn, on && s.mBtnOn]}
          >
            <Ionicons name={o.ic} size={16} color={on ? '#fff' : 'rgba(255,255,255,0.5)'} />
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ⚠️ Selection is a GLASS state, never a white pill. A white chip on the dark hero was the single
// loudest thing on the screen and fought every other surface; the selected chip should read as the
// same material, lit. Dropping the role line is what makes it narrow enough to scan.
// ⚠️ MEMOISED, with a stable onPick and its index instead of a per-render closure: Home re-renders on
// every build-stage tick, and each re-render used to re-render every chip in the row with it.
const EmployerChip = React.memo(function EmployerChip({ t, index, on, onPick, enterToken = 0 }: {
  t: Target; index: number; on: boolean; onPick: (i: number) => void;
  /** Non-zero only on the chip that was just added; a new value replays the entrance. */
  enterToken?: number;
}) {
  const onPress = useCallback(() => onPick(index), [onPick, index]);
  // ⚠️ NATIVE DRIVER, transform + opacity ONLY: this chip lives inside the hero's native tree
  // (see ANIMATION DRIVER RULE). A chip that is not new starts at rest and never animates.
  const pop = useRef(new Animated.Value(enterToken ? 0 : 1)).current;
  const glow = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!enterToken) return;
    pop.setValue(0);
    glow.setValue(0);
    const a = Animated.parallel([
      Animated.spring(pop, { toValue: 1, friction: 6, tension: 90, useNativeDriver: true }),
      Animated.sequence([
        Animated.delay(160),
        Animated.timing(glow, { toValue: 1, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(glow, { toValue: 0.3, duration: 380, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(glow, { toValue: 1, duration: 300, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(glow, { toValue: 0, duration: 720, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    ]);
    a.start();
    // ⚠️ Settle, not just stop: when another chip is added the token here drops to 0 mid-entrance,
    // and a stopped value would leave this chip frozen half-scaled.
    return () => { a.stop(); pop.setValue(1); glow.setValue(0); };
  }, [enterToken, pop, glow]);
  // Built once per value, not per render: a fresh interpolate() re-creates the native animated nodes
  // and re-attaches them, mid-entrance, for nothing.
  const popStyle = useMemo(() => ({
    opacity: pop.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1], extrapolate: 'clamp' }),
    transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
  }), [pop]);
  const glowStyle = useMemo(() => [s.chipGlow, { opacity: glow }], [glow]);
  return (
    <Animated.View style={popStyle}>
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={[s.chip, on && s.chipOn]}
    >
      <LinearGradient colors={t.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.chipTile}>
        <Text style={s.chipTileTx}>{t.initial}</Text>
      </LinearGradient>
      {/* Two lines, because a chip identifies a POSTING: the same employer can appear twice and the
          role underneath is the only thing telling the two apart. */}
      <View style={s.chipText}>
        <Text style={[s.chipName, on && s.chipNameOn]} numberOfLines={1}>{t.company}</Text>
        {!!t.role && <Text style={[s.chipRole, on && s.chipRoleOn]} numberOfLines={1}>{t.role}</Text>}
      </View>
      {t.match != null && (
        <View style={[s.chipPct, on && s.chipPctOn]}>
          <Text style={[s.chipPctTx, on && s.chipPctTxOn]}>{t.match}%</Text>
        </View>
      )}
    </TouchableOpacity>
      {/* INSET, not a halo: the horizontal ScrollView clips to its 48pt row, so anything drawn
          outside the chip would be cut flat top and bottom. */}
      <Animated.View pointerEvents="none" style={glowStyle} />
    </Animated.View>
  );
});

// ⚠️ A letter is written FOR A POSTING, and no letter exists until one is generated — there is no
// cached letter-thumbnail endpoint to page through the way the resume side does. So this shows the
// designs by name and puts ONE explicit action in front of the user. It never generates on its own:
// generation spends the cover-letter quota, and auto-spending on screen entry is the exact mistake
// the letters auto-regen drain was.
function LetterPanel({ company, onWrite }: { company?: string; onWrite: () => void }) {
  return (
    <View style={s.letterPanel}>
      <View style={s.letterIcon}><Ionicons name="mail-open-outline" size={24} color={E.mint} /></View>
      <Text style={s.letterTitle} numberOfLines={2}>
        {company ? `Write a cover letter for ${company}` : 'Write a cover letter'}
      </Text>
      <Text style={s.letterSub} numberOfLines={3}>
        A letter is written from one posting, so it starts with the employer — then you pick from these {LETTER_DESIGNS.length} formats.
      </Text>
      {/* ⚠️ WRAPPED, NOT SCROLLED. A horizontal ScrollView inside this centre-aligned card took its
          CONTENT width, so it overflowed the panel on both sides and the row began mid-word — and
          the formats past the edge could not be read at all. Wrapping shows all seven. */}
      <View style={s.letterRow}>
        {LETTER_DESIGNS.map((d) => (
          <View key={d.id} style={s.letterChip}>
            <View style={[s.letterDot, { backgroundColor: d.accent }]} />
            <Text style={s.letterChipTx} numberOfLines={1}>{d.name}</Text>
          </View>
        ))}
      </View>
      <TouchableOpacity onPress={onWrite} activeOpacity={0.9} style={{ marginTop: 16 }}>
        <LinearGradient colors={[E.teal, E.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.letterBtn}>
          <Ionicons name="create" size={16} color="#fff" />
          <Text style={s.letterBtnTx} numberOfLines={1}>{company ? `Write for ${company}` : 'Choose an employer'}</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

function NoResume({ onBuild }: { onBuild: () => void }) {
  return (
    <View style={s.noResume}>
      <View style={s.noResumeIcon}><Ionicons name="sparkles" size={26} color={E.blue} /></View>
      <Text style={s.noResumeTitle}>Build your resume first</Text>
      <Text style={s.noResumeSub}>We rebuild it from the one you already have — then design it for each employer.</Text>
      <TouchableOpacity onPress={onBuild} activeOpacity={0.9} style={{ marginTop: 14 }}>
        <LinearGradient colors={[E.blue, E.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.noResumeBtn}>
          <Ionicons name="color-wand" size={16} color="#fff" />
          <Text style={s.noResumeBtnTx}>Build with AI</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

/**
 * The one warm-side accent on a blue-violet screen, and the ink that goes on it.
 * ⚠️ DARK INK, NOT WHITE. White on mint fails contrast at this size; #04211C is the same hue
 * driven almost to black, so the label reads as part of the button rather than sitting on it.
 */
const MAKE_MINT: [string, string, string] = ['#8FF7E4', '#2DE0C0', '#12BFA6'];
const MAKE_INK = '#04211C';

/* ── styles ─────────────────────────────────────────────────────────────── */
const s = StyleSheet.create({
  // ⚠️ The SAME colour the gradient starts from. A bounce at the top of the scroll view
  // exposes this, and any other value would flash a band above the hero.
  root: { flex: 1, backgroundColor: E.stage },
  flex: { flex: 1 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowCenter: { flexDirection: 'row', alignItems: 'center' },

  headerWrap: { position: 'absolute', top: 0, left: 0, right: 0 },
  headerRow: { flex: 1, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerHair: { position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.10)' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // the real mark, tinted: it is a single-colour glyph on transparency, so it reads on the hero
  brandLogo: { width: 26, height: 26, tintColor: '#fff' },
  brandTx: { fontSize: 17, fontWeight: '800', color: '#fff', letterSpacing: -0.3 },
  topActions: { flexDirection: 'row', gap: 8 },
  glassBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: -3, right: -3, minWidth: 16, height: 16, paddingHorizontal: 3, borderRadius: 8, backgroundColor: '#EF4444', alignItems: 'center', justifyContent: 'center' },
  badgeTx: { fontSize: 9, fontWeight: '800', color: '#fff' },

  livePill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 5, paddingLeft: 8, paddingRight: 10, borderRadius: 100, backgroundColor: 'rgba(20,184,166,0.14)', borderWidth: 1, borderColor: 'rgba(20,184,166,0.32)' },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#2DE0C0' },
  livePillTx: { fontSize: 9.5, fontWeight: '700', color: E.mint, letterSpacing: 1.4 },
  editBtn: { height: 30, paddingHorizontal: 11, borderRadius: 100, backgroundColor: E.glass, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', flexDirection: 'row', alignItems: 'center', gap: 5 },
  editTx: { fontSize: 11.5, fontWeight: '700', color: '#fff' },

  h1: { fontSize: 26, fontWeight: '800', color: '#fff', letterSpacing: -1, lineHeight: 29 },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  headText: { flex: 1 },
  h1Accent: { fontFamily: SERIF, fontStyle: 'italic', fontSize: 26, lineHeight: 31, letterSpacing: -0.4, marginTop: 1 },
  sub: { fontSize: 12.5, fontWeight: '500', color: E.onDark, marginTop: 8, lineHeight: 17.5 },
  // the sub is context, not the message — never let it push the paper off screen


  mSwitch: { flexDirection: 'row', padding: 3, borderRadius: 13, backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder, gap: 3 },
  mBtn: { width: 36, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  mBtnOn: { backgroundColor: 'rgba(79,141,255,0.34)', borderWidth: 1, borderColor: 'rgba(150,186,255,0.55)' },

  eyebrowDark: { fontSize: 10, fontWeight: '700', letterSpacing: 1.8, textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)', paddingHorizontal: 16, paddingBottom: 8 },
  chipsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, alignItems: 'center' },
  chip: {
    height: 48, paddingLeft: 6, paddingRight: 10, borderRadius: 16, borderWidth: 1,
    borderColor: E.glassBorder, backgroundColor: E.glass,
    flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 218,
  },
  chipText: { flexShrink: 1 },
  chipOn: {
    backgroundColor: 'rgba(79,141,255,0.22)', borderColor: 'rgba(150,186,255,0.6)',
    ...Platform.select({ ios: { shadowColor: E.blue, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 12 }, default: { elevation: 4 } }),
  },
  chipTile: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  chipTileTx: { fontSize: 11.5, fontWeight: '800', color: '#fff' },
  chipName: { fontSize: 12.5, fontWeight: '700', color: 'rgba(255,255,255,0.8)', letterSpacing: -0.2 },
  chipRole: { fontSize: 10, fontWeight: '600', color: 'rgba(255,255,255,0.5)', marginTop: 1.5 },
  chipRoleOn: { color: 'rgba(255,255,255,0.78)' },
  chipNameOn: { color: '#fff', fontWeight: '800' },
  chipPct: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 100, backgroundColor: 'rgba(255,255,255,0.12)' },
  chipPctOn: { backgroundColor: 'rgba(255,255,255,0.22)' },
  chipPctTx: { fontSize: 9.5, fontWeight: '800', color: 'rgba(255,255,255,0.7)' },
  chipPctTxOn: { color: '#fff' },
  chipAdd: { height: 48, paddingHorizontal: 13, borderRadius: 100, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.32)', flexDirection: 'row', alignItems: 'center', gap: 6 },
  chipAddTx: { fontSize: 12, fontWeight: '700', color: '#fff' },
  chipGlow: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 16,
    borderWidth: 1.5, borderColor: 'rgba(143,247,228,0.95)', backgroundColor: 'rgba(45,224,192,0.16)',
  },
  addNotice: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 16, marginTop: 8 },
  addNoticeTx: { flex: 1, fontSize: 11.5, fontWeight: '600', color: 'rgba(255,255,255,0.72)', lineHeight: 15.5 },
  chipSkeleton: { width: 150, height: 48, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.07)' },
  emptyTargets: { marginHorizontal: 16, paddingHorizontal: 14, height: 48, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.3)', gap: 8 },
  emptyTargetsTx: { flex: 1, fontSize: 12.5, fontWeight: '700', color: '#fff' },

  paperLoading: { height: 300, alignItems: 'center', justifyContent: 'center' },
  // ⚠️ THE GLOW IS ON THE OUTER VIEW AND THE CLIPPING ON THE INNER GRADIENT. iOS drops a shadow
  // drawn on the same view as overflow:'hidden', and this exact trap has been hit three times in
  // this folder. Note the style is NOT keyed `cta` — the suite forbids a shadowColor inside one.
  makeWrap: {
    marginTop: 15, marginHorizontal: 16, borderRadius: 16,
    shadowColor: '#2DE0C0', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.5, shadowRadius: 20, elevation: 8,
  },
  // Same button, half the glow: a finished profile still needs the door, not the announcement.
  makeCalm: { shadowOpacity: 0.28, shadowRadius: 13, elevation: 5 },
  makeBtn: {
    height: 52, borderRadius: 16, overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
  },
  makeTx: { fontSize: 15.5, fontWeight: '800', color: MAKE_INK, letterSpacing: -0.2, flexShrink: 1 },

  makeSub: {
    marginTop: 9, marginHorizontal: 22, fontSize: 12, fontWeight: '600',
    color: E.onDark, textAlign: 'center', lineHeight: 17, flexShrink: 1,
  },

  sampleBar: {
    marginHorizontal: 16, marginTop: 12, padding: 11, borderRadius: 15,
    flexDirection: 'row', alignItems: 'center', gap: 9,
    backgroundColor: 'rgba(20,184,166,0.13)', borderWidth: 1, borderColor: 'rgba(94,234,212,0.32)',
  },
  sampleTx: { flex: 1, fontSize: 11.5, fontWeight: '700', color: 'rgba(255,255,255,0.86)', lineHeight: 16 },
  letterPanel: { marginHorizontal: 16, marginTop: 6, padding: 18, borderRadius: 22, backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder, alignItems: 'center' },
  letterIcon: { width: 52, height: 52, borderRadius: 18, backgroundColor: 'rgba(20,184,166,0.16)', alignItems: 'center', justifyContent: 'center' },
  letterTitle: { marginTop: 12, fontSize: 17, fontWeight: '800', color: '#fff', letterSpacing: -0.4, textAlign: 'center' },
  letterSub: { marginTop: 6, fontSize: 12.5, fontWeight: '600', color: E.onDark, textAlign: 'center', lineHeight: 18 },
  letterRow: { alignSelf: 'stretch', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 7, paddingTop: 14 },
  letterChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 30, borderRadius: 100, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: E.glassBorder, maxWidth: '100%' },
  letterDot: { width: 8, height: 8, borderRadius: 100 },
  letterChipTx: { flexShrink: 1, fontSize: 11.5, fontWeight: '700', color: 'rgba(255,255,255,0.8)' },
  letterBtn: { height: 48, paddingHorizontal: 22, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  letterBtnTx: { fontSize: 14.5, fontWeight: '800', color: '#fff', flexShrink: 1 },
  paperFailTx: { color: 'rgba(255,255,255,0.72)', fontSize: 13.5, fontWeight: '700', marginTop: 10 },
  paperFailSub: { color: 'rgba(255,255,255,0.42)', fontSize: 12, marginTop: 3 },
  caption: { alignItems: 'center', marginTop: 8, height: 18 },
  captionName: { fontSize: 13, fontWeight: '800', color: '#fff', letterSpacing: -0.3 },
  capDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)', marginHorizontal: 8 },
  captionMeta: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)' },
  captionScan: { fontSize: 12, fontWeight: '600', color: '#C4BBFF' },



  noResume: { marginHorizontal: 16, padding: 20, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: E.glassBorder, alignItems: 'center' },
  noResumeIcon: { width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(79,141,255,0.16)', alignItems: 'center', justifyContent: 'center' },
  noResumeTitle: { fontSize: 17, fontWeight: '800', color: '#fff', marginTop: 12, letterSpacing: -0.4 },
  noResumeSub: { fontSize: 12.5, color: E.onDark, textAlign: 'center', marginTop: 6, lineHeight: 18 },
  noResumeBtn: { height: 46, paddingHorizontal: 22, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 8 },
  noResumeBtnTx: { fontSize: 14, fontWeight: '800', color: '#fff' },

  // Nothing to overlap any more: there is no seam to hide, only the spacing between two parts of
  // one page.
  library: { marginTop: 4 },
  tail: { height: 108 },

  dashLink: {
    marginHorizontal: 16, marginTop: 24, height: 46, borderRadius: 14,
    backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  dashLinkTx: { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.72)' },
});
