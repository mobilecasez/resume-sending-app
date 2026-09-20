// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE HOME SCREEN — "one employer, one resume".
//
// Built from the Claude Design mockup "cvApplyr Home Employer Focus". People use this app to
// generate a resume or a cover letter, so Home now leads with exactly that: pick the employer
// you are applying to, see your real document rewritten for them, download it.
//
// ⚠️ WHAT THIS DELIBERATELY DOES **NOT** COPY FROM THE MOCKUP: its pay sheet sells a single PDF
// for €1.99 ("one-time purchase · no subscription"). This app shipped a SUBSCRIPTION model to
// both stores. Selling the same file twice under two models would be a pricing bug, so the CTA
// keeps the mockup's shape and honesty ("preview is free, pay to download") and routes to the
// real paid-plan gate instead of an invented checkout.
//
// EVERY EMPLOYER HAS ITS OWN DOCUMENTS. The AI rewrites the resume (and the cover letter) for one
// employer, ranks every design for it, and the server stores the result (user_employer_documents).
// Picking a chip shows THAT employer's document straight from the database — its pages, its designs
// best fit first with a fit % (useTargetDoc / useDocDeck). A chip with nothing saved shows the base
// resume and ONE explicit action (Tailor my resume / Write my cover letter); a saved document the
// resume has since moved past says so, with a Refresh.
//
// ADDING AN EMPLOYER HAPPENS ON THIS SCREEN. "+ Add employer" sits on the "Designing for" row, and
// the chip lands at the FRONT of the chip row. Tracking the employer is free and never starts a job
// search (services/homeAddEmployer). If a document is already saved for that employer (added again
// after its chip was removed) it is simply shown — no AI call; otherwise its build starts behind
// BuildingOverlay. The X on a chip removes it softly, with Undo; the documents stay saved.
// ⚠️ NEVER A SILENT CHARGE (the letters auto-regen drain): a build starts only from an explicit tap —
// Add, Tailor, Write or Refresh — through useHomeBuilds, which auto-starts ONLY when the server's
// dry-run gate says the plan, the free allowance, a download pass or the cache covers it, and then
// sends it coveredOnly so the server refuses rather than spend anything else. A gate we could not read
// is a question first. Switching chips or modes, focusing or mounting this screen READS documents; it
// never builds one.
// ⚠️ NO CREDITS PAY FOR A GENERATION (the product owner's call, 2026-09-13). A resume or a letter comes
// out of a plan's monthly allowance or the free one (ONE TIME for the life of the account, never
// refilled); when that is used up the answer is the plans screen. So nothing on this screen names a
// credit price — not the gate hint, not the overlay.
//
// ⚠️ NOTHING IS SPENT BEFORE A SHEET SAYS WHAT IT SPENDS (2026-09-14). Tailor, Write, Refresh and the Add
// auto-build open GenerateConfirmSheet first — what tailoring does, how many generations are left (or that the
// one-time pass covers this employer), Continue / Cancel — and with none left the same sheet offers the $0.99
// one-time pass for THIS employer or the plans. Its state is useHomeBuilds' (K.confirm); a cache hit skips it.
//
// THE TAILOR HINT. A chip with nothing tailored shows the base resume, and its Tailor button sits under a page
// taller than the first screen. TailorHint lays a pill over the page's lower half that names the button and
// scrolls to it on a tap — it never starts a build. It shows only while that button is below the fold, and
// leaves for good (per chip and kind) once the user has scrolled the button into view.
//
// BUILDS RUN IN THE BACKGROUND, PER EMPLOYER (services/homeBuilds holds their live state): the chip
// shows its progress, the carousel writes the pages with a live % and a tap reopens the overlay.
//
// THE LIBRARY OPENS, IT NEVER DOWNLOADS. A card under "Your library" grows into the same zoomed page a
// hero page does (PaperZoom), with the same two doors for a resume AND a cover letter — Customize and
// View PDF — through the same functions the hero uses; the download happens from View PDF, exactly as
// from the hero (openHistoryItem). The library is a shelf of paper cards (DownloadHistory): each shows
// the page it is a download of, and the page comes from what this screen ALREADY HOLDS (imageFor) —
// the employer's own document page from the image cache the deck fills and a small warm tops up for the
// front of the shelf (warmDocImages, a READ), else the base page in that design, else a drawn page.
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash): one driver per view tree, no mixing.
// This file and its children (MeshStage, PaperCarousel, EmployerChip) use useNativeDriver:true ONLY,
// on transform/opacity, and contain no JS-driven Animated.Value — a self-contained native tree.
// ⚠️ A TICKING PERCENTAGE NEVER LIVES HERE: it is React state inside a small memo component (the chip's
// build line, the carousel's read-out). This screen subscribes to a build's PHASE only, so a stage
// tick re-renders a chip, never the whole of Home. The overlays it shares a screen with (JourneyCoach,
// ResumeScoreModal, BuildingOverlay, GenerateConfirmSheet, PaperZoom) are separate trees mounted as siblings,
// which the rule allows. TailorHint is INSIDE the scroll view, so it is native-driver only, and its scroll
// fade is the scroll view's own native value.
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Animated, Easing,
  ActivityIndicator, RefreshControl, Alert, Image, AppState, type AppStateStatus,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
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
import PaperCarousel, { PaperCard, cardWidthFor } from './PaperCarousel';
import { AFFORDANCE } from './PaperSkeleton';
import PaperZoom, { OriginRect } from './PaperZoom';
import AddEmployerSheet, { type EmployerPick } from './AddEmployerSheet';
import BuildingOverlay from './BuildingOverlay';
import GenerateConfirmSheet from './GenerateConfirmSheet';
import TailorHint, { TAILOR_HINT_H, TAILOR_HINT_REACH } from './TailorHint';
import EmployerChip from './EmployerChip';
import { useHomeBuilds, forgetHomeBuilds, type HomeBuildJob } from './useHomeBuilds';
import { useDocList, useTargetDoc, useDocDeck, cachedDocImage, warmDocImages, type DocLoaders } from './useTargetDoc';
import {
  fetchTargetAnswer, fetchHomeCards, fetchTemplateCatalogue, bestDesignForCountry, LETTER_DESIGNS,
  fetchDownloadHistory, cachedDownloadHistory, redownload, gradFor, savePendingListing,
  hideTarget, unhideTarget, untrackEmployer, fetchHiddenKeys, jobKeyForUrl, warmJobListings,
  Target, HomeCard, HomeCards, DownloadHistory as HistoryPayload, DownloadHistoryItem, type TargetAnswer,
} from '../../services/employerHomeService';
import {
  planRow, rowAccounts, readRoster, keepRoster, editRoster, rosterCopy, rosterRow, rosterPlace, rosterRemove, rosterSelect,
  forgetRosterCopy, listAnswer, fetchRemoteRoster, savedRowOf, type Roster, type RemoteRoster,
} from '../../services/homeRoster';
import {
  trackEmployer, checkBuildGate, gateJobFor, signedInAccount,
  type BuildGate, type DocKind, type InflightMeta,
} from '../../services/homeAddEmployer';
import {
  docLookupOf, fetchCurrentDoc, cachedCurrentDoc, rememberDoc, forgetDocs, fetchDoc, fetchDocList, fetchDocCards,
  matchDocToTarget, sameEmployerName,
  type DocMeta, type DocLookup, type DocCard, type DocListItem,
} from '../../services/employerDocs';
import { buildFor, getBuilds, subscribeBuilds, storeKeyOf, type BuildPhase } from '../../services/homeBuilds';
import DownloadHistory from './DownloadHistory';
import DownloadPaywallSheet from '../downloads/DownloadPaywallSheet';
import { fetchProfileSnapshot, cachedSetup, consumeProfileChanged, makeYoursOf, ProfileSetup } from '../../services/profileSetupService';
import { fetchSubscriptionStatus, subscribeEntitlements } from '../../services/subscriptionService';
import { track } from '../../services/analytics';

const nav = () => require('expo-router').router;

type Mode = 'resume' | 'letter';
/** The mode switch speaks screen ('letter'); documents, builds and the server speak 'cover_letter'. */
const kindOfMode = (m: Mode): DocKind => (m === 'letter' ? 'cover_letter' : 'resume');
const modeOfKind = (k: DocKind): Mode => (k === 'cover_letter' ? 'letter' : 'resume');
const nounOf = (k: DocKind) => (k === 'cover_letter' ? 'cover letter' : 'resume');

/** How long a new chip lands and glows before an overlay or a dialog may cover it. */
const HOLD_MS = 950;
/** A removed chip's exit — EmployerChip plays it over the same time, then the row closes up. */
const EXIT_MS = 180;
/** How long "Removed X · Undo" stays up. */
const UNDO_MS = 5000;
/**
 * How long a notice may wait behind a live Undo before it is too old to be worth showing. ⚠️ An Undo is never
 * pre-empted (see showNotice), so everything else queues — and a line about something that happened half a
 * minute ago reads as news about now.
 */
const NOTICE_WAIT_MS = 20000;
/**
 * After a build lands, how long its chip counts as "document on its way" while the lookup refetches it. ⚠️ The
 * refetch is the only thing that can say the document exists, and until it answers the chip still holds the
 * answer from BEFORE the build ("nothing saved") — which drew "Tailor my resume" (and read the gate) for a
 * document the user had just paid for. Bounded, so a lookup that never finds it gives the action back.
 */
const LANDED_WAIT_MS = 15000;
/** At most this many chips' saved documents are read ahead of a tap, per list answer. */
const PREWARM_MAX = 6;
/**
 * The bottom of the viewport that does not count as "on screen" for the Tailor hint: the floating tab bar
 * over Home's foot (the page's own `tail` leaves it 108pt) less the part a button can peek out from under.
 */
const FOLD_ALLOW = 96;
/** How far the page scrolls before the hint has faded out of the way (native, from scrollY). */
const HINT_FADE_PX = 140;
/**
 * The centred page's geometry inside the slot, mirrored from PaperCarousel so the Tailor hint can keep off the
 * page's zoom button: the pager's contentContainerStyle paddingTop (10) and its A4 ratio (424/300, the
 * renderer's). The WIDTH is not mirrored — it is cardWidthFor itself, fed the slot's measured width, which is
 * the carousel's own container width (the slot is a plain full-width View).
 */
const DECK_PAD_TOP = 10;
const DECK_PAGE_RATIO = 424 / 300;
/** Visible air between the hint's reach (halo / hitSlop / motion) and the zoom button's top edge. */
const HINT_ZOOM_GAP = 8;
/** The Tailor button's own height (s.tailorBtn) — "in view" means the whole button, not its hint line. */
const TAILOR_BTN_H = 50;

/** What the confirm sheet takes — the hook's own shape, so this file cannot drift from it. */
type ConfirmView = ReturnType<typeof useHomeBuilds>['confirm'];
/** A harness-only answer for the confirm sheet (loaders.confirm): the parts a real gate read would supply. */
type PreviewAsk = { mode: ConfirmView['mode']; usage: ConfirmView['usage']; pass: ConfirmView['pass'] };

/** The letter designs as pages with no pixels — what a letter deck shows while it is being written. */
const LETTER_SLOTS: PaperCard[] = LETTER_DESIGNS.map((d) => ({ id: d.id, name: d.name, accent: d.accent, image: null }));

/** Whose resume the builder is armed for: a chip, or a library row's employer (which has no posting). */
type BuilderFor = Pick<Target, 'company'> & Partial<Pick<Target, 'role' | 'applyUrl' | 'jobUrl'>>;

/* ── the zoomed page ────────────────────────────────────────────────────── */

/** The saved document a zoomed page is a design of — enough to route Customize and View PDF to it. */
type ZoomDoc = { docId: number; kind: DocKind; employer: string };

/**
 * What PaperZoom shows.
 * A HERO page is read from the deck on screen by index, so it fills in as that deck does. A LIBRARY card
 * carries its own page: the library is not the deck — its row can belong to any employer's saved document,
 * or to none (the base resume) — so openHistoryItem builds the page and fills it in. `n` is the open it came
 * from, so a page image that lands after the sheet was closed (or another card opened) is dropped rather
 * than painted onto a different page.
 */
type Zoom =
  | { src: 'hero'; i: number; rect: OriginRect }
  | {
    src: 'library'; n: number; rect: OriginRect | null; kind: DocKind; doc: ZoomDoc | null;
    employer: string; card: PaperCard; sample: boolean;
  };

/**
 * Library pages already fetched, per document VERSION (kind | docId | updatedAt | design), so opening the
 * same card again paints at once. ⚠️ BOUNDED — each is a base64 data URI — and wiped with the account
 * cache (forgetAccountCache): otherwise it holds the previous account's pages.
 */
const LIB_PAGES_MAX = 12;
/**
 * How many library cards, from the front of the shelf, have their employer's own page warmed once the saved
 * list is in hand (the four on screen and the next line behind "See all"). ⚠️ Small on purpose: every page
 * is one render on the serial renderer, and this runs on the app's front door.
 */
const LIB_WARM = 8;
const libPages = new Map<string, { image: string; fit: number | null; reason: string | null }>();
const libPageKey = (kind: DocKind, d: { docId: number; updatedAt: string }, design: string) =>
  `${kind}|${d.docId}|${d.updatedAt}|${design}`;
function keepLibPage(key: string, page: { image: string; fit: number | null; reason: string | null }) {
  libPages.delete(key);                 // re-insert = most recent (Map keeps insertion order)
  libPages.set(key, page);
  while (libPages.size > LIB_PAGES_MAX) {
    const oldest = libPages.keys().next().value;
    if (oldest === undefined) break;
    libPages.delete(oldest);
  }
}

/**
 * The saved document a library row is a download of, or null when none is saved.
 * ⚠️ BY EMPLOYER NAME, AND THE EMPLOYER'S OWN DOCUMENT FIRST. A download row carries the employer it was
 * billed under and no posting, so which of that employer's posting documents it came from cannot be known;
 * the employer-level one (job_url '') is the one that employer's chip shows, so it is the honest pick, and
 * the newest otherwise. sameEmployerName is the client's hint — the server's identity is
 * downloads.employerKeyOf, which every screen this opens re-checks before anything is billed.
 */
function savedDocFor(list: DocListItem[], employer: string): DocListItem | null {
  const mine = (Array.isArray(list) ? list : []).filter((d) => !!d && sameEmployerName(employer, d.employer));
  if (!mine.length) return null;
  const at = (d: DocListItem) => { const t = Date.parse(d.updatedAt); return Number.isFinite(t) ? t : 0; };
  // Newest first. A stable sort, so rows with no usable time keep the order the server listed them in.
  const newest = [...mine].sort((a, b) => at(b) - at(a));
  return newest.find((d) => !String(d.jobUrl || '').trim()) || newest[0];
}

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
// its animation would snap. Held here so that swap is invisible — and builds are keyed on it too
// (services/homeBuilds), so a build started for the pending chip still finds the tracked one.
const renderKeyOf = new Map<string, string>();
// Chips this screen invented, so a merge never mistakes its own earlier chip for the server's copy.
let LOCAL = new WeakSet<Target>();

/* ── chips removed on THIS screen ───────────────────────────────────────── */

type Removal = {
  t: Target;
  rk: string;
  /** Where the chip was, so Undo puts it back in place. */
  at: number;
  /** Its slot in addedEmployers (-1 = a server chip), so an employer added here still leads after Undo. */
  addedAt: number;
  /** The server side of the removal (untrack / hide); resolves true when the server did it. null = none yet. */
  server: Promise<boolean> | null;
  /** An add whose chip was removed while tracking ran: what tracking returned before it was untracked again. */
  trackedAs: Target | null;
  /** Undone, failed, or answered by adding the employer again: nothing about it may act any more. */
  undone: boolean;
  /** When the X was tapped (the registry below forgets it after REMOVED_HOLD_MS). */
  madeAt: number;
  /** The account epoch it belongs to: an Undo from before a sign-out must never track under the next account. */
  gen: number;
  /** Its "Removed X · Undo" notice, so the notice goes when the removal stops being undoable. */
  noticeId: number | null;
};

/**
 * Chips the user removed, by chip key → until when (ms).
 * ⚠️ LAID OVER EVERY LOAD. The X is optimistic: the chip leaves at once while the untrack / hide is still
 * on its way, so a load that read the server before that landed would put the chip straight back. Held
 * well past any request, and dropped by Undo, by a failed removal, or by adding the employer again.
 */
const removedKeys = new Map<string, number>();
const REMOVED_HOLD_MS = 5 * 60 * 1000;
/**
 * Adds whose chip was removed BEFORE tracking answered, by render key. A request cannot be taken back
 * mid-flight, so the add flow reads this when tracking answers: it untracks what it just tracked and
 * builds nothing — and records what it untracked on the Removal, so Undo can track it again.
 */
const removedAdds = new Map<string, Removal>();
/**
 * Every removal made on this screen that may still be on its way to the server, oldest first.
 * ⚠️ WHY A REGISTRY: adding an employer again while its untrack (or a posting's hide) is still in flight used
 * to send the track straight away — two requests racing, and an untrack landing second left the employer
 * the user had just re-added untracked on the server. A re-add now waits for the removal it answers, the same
 * way Undo waits for the removal it undoes. Forgotten after REMOVED_HOLD_MS; every request is long settled by then.
 */
let removals: Removal[] = [];
/** Bumped with every account wipe: removals, and their Undo, belong to the account they were made under. */
let accountGen = 0;

function removedNow(key: string): boolean {
  const until = removedKeys.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  removedKeys.delete(key);
  return false;
}

/** The live removals, pruned of expired and other accounts' entries. */
function liveRemovals(): Removal[] {
  const now = Date.now();
  removals = removals.filter((r) => r.gen === accountGen && now - r.madeAt < REMOVED_HOLD_MS);
  return removals;
}

/** A removal's server side, settled either way — for sequencing only, never read as an answer. */
const settledOf = (r: Removal): Promise<unknown> => (r.server ? r.server.catch(() => false) : Promise.resolve(false));

/**
 * The live removals this add answers — the same employer, by site first and then by name (a re-add has no
 * employer id until tracking returns one). Newest first, so a chip removed and re-added twice is sequenced
 * behind both of its removals.
 */
function removalsFor(name: string, website: string): Removal[] {
  const h = hostOf(website);
  return liveRemovals()
    .filter((r) => !r.undone && ((h && hostOf(r.t.website) === h) || sameEmployerName(r.t.company, name)))
    .reverse();
}

/**
 * ⚠️ WHOSE CACHE THIS IS. Everything above is module scope, and App.js's logout does not reload the
 * bundle — so the next account to sign in saw the previous account's employers leading its chip row,
 * and that account's company in the build overlay. The cache is owned by the signed-in user id (a
 * token hash for a session without one) and wiped whenever a different account — or nobody — is found.
 * The saved documents and the builds on screen are that account's too, so they go with it.
 */
let cacheOwner: string | null = null;

function forgetAccountCache() {
  addedEmployers = [];
  renderKeyOf.clear();
  LOCAL = new WeakSet<Target>();
  removedKeys.clear();
  removedAdds.clear();
  removals = [];
  accountGen++;
  libPages.clear();
  forgetDocs();
  forgetHomeBuilds();
  // The saved chip row in memory is that account's; its stored copy stays under its own key (homeRoster).
  forgetRosterCopy();
}

// signedInAccount lives in services/homeAddEmployer — ONE definition, shared with the in-flight records.

/**
 * Make the module cache belong to whoever is signed in now. `wiped` = another account's was wiped; `who` = the
 * account this read actually saw (null = none could be read).
 * ⚠️ AN UNREADABLE SESSION IS NOT ANOTHER ACCOUNT (2026-09-19). signedInAccount answers null when SecureStore
 * throws, and one such read used to count as an account switch: it wiped the employers added here, the saved
 * documents and the builds on screen, and the chip row came back with its selection gone. Only a DIFFERENT
 * account that can actually be read wipes now; a null changes nothing, and nothing is saved under it.
 */
async function claimAccountCache(): Promise<{ wiped: boolean; who: string | null }> {
  const who = await signedInAccount();
  if (who === null || who === cacheOwner) return { wiped: false, who };
  // The first claim after the bundle loads has no owner to compare against: anything already here was
  // added moments ago by whoever is signed in now, so it is adopted rather than wiped.
  const wipe = cacheOwner !== null;
  cacheOwner = who;
  if (wipe) forgetAccountCache();
  return { wiped: wipe, who };
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
const rkOf = (t: Target) => renderKeyOf.get(t.key) || t.key;

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

/** An employer the user added on this screen (this session): a first saved row always keeps it (homeRoster seedFrom). */
function addedHere(key: string): boolean {
  return addedEmployers.some((a) => a.key === key);
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

/**
 * The build for a chip, spelled from docLookupOf and nothing else.
 * ⚠️ ONE SPELLING. A saved document is found again by (employer, posting URL): a build that sent a URL,
 * a listing or a website the lookup does not send would save a document no chip can ever show — paid
 * for, invisible, and offered again as "Tailor my resume" — or one that reads as stale forever.
 */
function jobFor(t: Target, kind: DocKind): HomeBuildJob {
  const q = docLookupOf(t);
  return {
    kind, rk: rkOf(t), company: q.employer, website: q.website || '',
    employerId: q.employerId ?? null, country: q.country ?? null,
    ...(q.jobUrl ? { jobUrl: q.jobUrl } : {}),
    // The posting the build reads, when it is not the identity: the link pasted in Add employer rides an
    // EMPLOYER chip (whose identity job_url is '') as posting context. The lookup spells it the same way.
    ...(q.postingUrl ? { postingUrl: q.postingUrl } : {}),
    ...(q.jobText ? { jobText: q.jobText } : {}),
    ...(q.jobTitle ? { jobTitle: q.jobTitle } : {}),
  };
}

/**
 * A Refresh of a saved document: the SAME chip identity (jobFor), rebuilt from the job the document was built
 * from. ⚠️ NOT FROM THIS DEVICE'S LISTING CACHE. The pasted listing lives in a bounded device store that evicts,
 * and a refresh spelled from an evicted listing rebuilt the resume WITHOUT the posting — and saved that
 * poorer input as the document's own. The server stores the exact job it fingerprinted (jobInput) and judges
 * `stale` against it, so a refresh from it reproduces that input and only the resume moves on.
 */
function refreshJobFor(t: Target, kind: DocKind, d: DocMeta): HomeBuildJob {
  const base = jobFor(t, kind);
  const ji = d.jobInput;
  if (!ji) return base;
  // Identity (kind, chip, employer, id, country, identity job_url) stays the chip's; the fingerprint inputs are
  // replaced wholesale — a field the stored job did not have must not be filled back in from the device.
  const job: HomeBuildJob = { ...base };
  delete job.postingUrl;
  delete job.jobText;
  delete job.jobTitle;
  // Exactly as stored: re-spelling a field (trimming, say) could fingerprint a different job.
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  job.website = s(ji.website);
  if (s(ji.url)) job.postingUrl = s(ji.url);
  if (s(ji.description)) job.jobText = s(ji.description);
  if (s(ji.title)) job.jobTitle = s(ji.title);
  return job;
}

/**
 * The chip a build belongs to, for a build recovered after a remount or a relaunch.
 * ⚠️ IT CAN RUN BEFORE THE FIRST LOAD — recovery starts on mount, with no chips on screen yet. So after
 * the chips (and the employers added here, which are module state) it names the key the chip WILL have
 * wherever that is certain: a posting chip is keyed on its cleaned URL (fetchTargets' own spelling), and
 * an employer added here maps through renderKeyOf. An employer chip that is only a guess is left null —
 * useHomeBuilds then marks its record provisional and moves it once the chips have loaded, which a
 * confident wrong answer from here would stop it doing.
 */
function rkForMeta(meta: InflightMeta, list: Target[]): string | null {
  const url = String(meta.jobUrl || '').trim();
  const same = (t: Target) => String(docLookupOf(t).jobUrl || '').trim() === url
    && ((!!meta.employerId && !!t.employerId && String(t.employerId) === String(meta.employerId))
      || sameEmployerName(t.company, meta.company));
  const hit = list.find(same) || addedEmployers.find(same);
  if (hit) return rkOf(hit);
  if (url) {
    // ⚠️ jobKeyForUrl, never a hand-rolled spelling: it is fetchTargets' own, and the two cannot drift.
    const key = jobKeyForUrl(url);
    return renderKeyOf.get(key) || key;
  }
  if (!meta.employerId) return null;
  const key = 'emp_' + meta.employerId;
  return renderKeyOf.get(key) || (list.length ? key : null);
}

/** A callback whose identity never changes but which always runs the latest render's function. */
function useStableFn<A extends any[], R>(fn: (...a: A) => R): (...a: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...a: A) => ref.current(...a), []);
}

/**
 * One chip's build phase, as a PRIMITIVE. ⚠️ Not the record: the record is replaced on every stage
 * tick, and holding it here would re-render the whole screen every poll of every build. A phase changes
 * a handful of times per build.
 */
function useBuildPhase(kind: DocKind, rk: string | null): BuildPhase | null {
  const snap = useCallback(() => (rk ? buildFor(kind, rk)?.phase ?? null : null), [kind, rk]);
  return useSyncExternalStore(subscribeBuilds, snap, snap);
}

type NoticeAction = { label: string; run: () => void };
/**
 * One line on the notice row.
 * ⚠️ `at` AND `shownAt` ARE DIFFERENT MOMENTS, because a notice can WAIT (an Undo is never pre-empted —
 * see showNotice). `at` is when the thing it reports happened, and a line that waited longer than
 * `maxWait` is dropped rather than shown as news; `shownAt` is when it actually reached the line, and
 * `ms` is counted from there.
 */
type Notice = {
  id: number; text: string; action?: NoticeAction; ms: number;
  at: number; shownAt: number; maxWait: number;
};

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
    /** A chip's saved document (POST /employer-docs/current). ⚠️ With `loaders`, no document read touches the network. */
    doc?: (kind: DocKind, q: DocLookup) => Promise<DocMeta | null | 'error'>;
    /** Page images for a saved document's designs. */
    docCards?: (kind: DocKind, docId: number, ids: string[]) => Promise<{ cards: DocCard[] } | 'gone' | null>;
    /** Every saved document of a kind, slim — the chips' "tailored" dots. */
    docList?: (kind: DocKind) => Promise<DocListItem[] | null>;
    /**
     * The server side of a chip's X (untrack an employer / hide a posting); true = removed. ⚠️ With `loaders`
     * a removal never touches the network: one the harness did not supply succeeds locally, so Remove → Undo
     * can be looked at signed-out.
     */
    remove?: (t: Target) => Promise<boolean>;
    /** The server side of Undo, and of a re-add restoring a hidden posting (track again / un-hide); true = back. */
    unhide?: (t: Target) => Promise<boolean>;
    /**
     * HARNESS ONLY: what the confirm sheet says for a chip's Tailor / Write / Refresh, so both of its states
     * (counts left, and none left) can be looked at signed-out. ⚠️ It never reaches useHomeBuilds: every button
     * on a sheet opened this way is a "Preview only" alert or a close — nothing is built or bought. null = the
     * old "Preview only" alert.
     */
    confirm?: (kind: DocKind, t: Target) => Promise<PreviewAsk | null>;
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
  const [zoom, setZoom] = useState<Zoom | null>(null);
  // Every open, hero or library, bumps this: a library open still looking its document up is dropped when
  // another page was opened meanwhile.
  const zoomSeq = useRef(0);
  // The library zoom on screen (its `n`), 0 when there is none. ⚠️ Moved in the same breath as setZoom, not
  // at render: the page request queued straight after an open runs before React has rendered that open.
  const libOpen = useRef(0);
  // ⚠️ ONE LIBRARY PAGE REQUEST AT A TIME. Pages render one after another on the server (single-process
  // chromium), so tapping along the library queues its pages here instead of firing them side by side.
  const libFill = useRef<Promise<unknown>>(Promise.resolve());
  const [addOpen, setAddOpen] = useState(false);
  const regionHint = useCallback((c: string) => bestDesignForCountry(c)?.name || null, []);
  /**
   * Tell the builder which posting this is for. The server tailors the resume to it — ordering and
   * wording only, never invented facts.
   * ⚠️ `autoBuild` is NOT set here: that lane generates immediately and spends a plan generation.
   */
  const armBuilderFor = useCallback(async (t?: BuilderFor) => {
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
  /**
   * ── WHERE THE TAILOR BUTTON IS, FOR THE HINT ──
   * Content-space positions from onLayout, never measureInWindow: the chain from the scroll content to the
   * paper is MeshStage's paddingTop (headerH) → the page and hero views (both at 0) → the paper block
   * (paperY) → its first child, the carousel or the letter panel (slot) / the Tailor button's box (tailor).
   * ⚠️ scrollTop is only where the page came to REST (drag end, momentum end): reading every scroll frame on
   * JS would undo the native driver this screen is built on. Between rests the hint fades on the native value.
   */
  const scrollTop = useRef(0);
  const [paperY, setPaperY] = useState(0);
  const [slotY, setSlotY] = useState(0);
  const [slotH, setSlotH] = useState(0);
  const [slotW, setSlotW] = useState(0);
  // The Tailor hint's MEASURED height (TailorHint onHeight); the constant only until the first layout.
  const [hintH, setHintH] = useState(TAILOR_HINT_H);
  const [tailorY, setTailorY] = useState(0);
  const [tailorH, setTailorH] = useState(0);
  // Chip + kind signatures whose button the user has already scrolled to (or reached by tapping the hint).
  const [hintSeen, setHintSeen] = useState<Record<string, true>>({});
  // The hint's geometry as of the last render, for the scroll-rest handler (which is not re-created per render).
  const hintGeo = useRef<{ sig: string; ctaBottom: number; foldY: number } | null>(null);
  // HARNESS ONLY (loaders.confirm): the confirm sheet as the preview opens it. The real one is K.confirm.
  const [previewAsk, setPreviewAsk] = useState<(PreviewAsk & { kind: DocKind; company: string }) | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [empIdx, setEmpIdx] = useState(0);
  const [cards, setCards] = useState<HomeCard[]>([]);
  // Every design in the catalogue, as a slot. Pixels arrive later and are merged in by id.
  const [slots, setSlots] = useState<HomeCard[]>([]);
  const [shots, setShots] = useState<Record<string, string>>({});
  // Which résumé the pictures in `shots` are OF — the server's own thumb cache key without the design
  // (/resume-builder/home-cards `version`). A load that answers with a different one is a different résumé, and
  // everything hydrated under the old one is dropped in the same commit as the new cards.
  const cardsVer = useRef<string | null>(null);
  const dead = useRef<Record<string, true>>({});
  // How many times a design has been asked for by id and come back with no picture. ⚠️ ONE RETRY BEFORE IT IS
  // WRITTEN OFF (2026-09-20 review): `dead` is forever for this deck, and now that the first load renders within a
  // budget and hands part of its own payload back image-less, a single flaky wave would permanently blank designs
  // that used to arrive with the payload itself. The second miss still stops it — the point of `dead` is that a
  // failing renderer is never hammered, and two tries is not hammering.
  const misses = useRef<Record<string, number>>({});
  const hydrating = useRef(false);
  const [hydrateNudge, setHydrateNudge] = useState(0);
  // A library card's base page that found the hydrator's mutex held (fillBasePage): the open it belongs to
  // (`n`) and its design. ⚠️ Whoever releases the mutex knocks (baseKnock) and the effect below runs it —
  // otherwise the sheet opened on a blank page that nothing ever came back to fill.
  const basePending = useRef<{ n: number; templateId: string } | null>(null);
  const [baseKnock, setBaseKnock] = useState(0);
  const [cardIdx, setCardIdx] = useState(0);
  const [mode, setMode] = useState<Mode>('resume');
  const [loading, setLoading] = useState(true);
  // ⚠️ THE PAGES ON SCREEN ARE OF THE PREVIOUS RÉSUMÉ (2026-09-20). A reload asked for fresh pages (a build just
  // landed) keeps the old cards until its own answer arrives, and the deck under them is THE OLD DOCUMENT — for a
  // brand-new account, the server's SAMPLE résumé, which carries the user's own name and email and so reads as a
  // real one. The owner built his first résumé and was shown that: "it didnt load the latest resume". While such a
  // reload is in flight the deck is drawn as skeletons instead — an honest "coming" beats a wrong résumé.
  const [deckStale, setDeckStale] = useState(false);
  const [noResume, setNoResume] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // These pages are a stand-in built from the account's name and email — say so.
  const [sample, setSample] = useState(false);
  // Whether the account has a resume a build can read: a builder resume OR an uploaded one (the server's
  // /home-cards `hasResume`). null = the server did not say (an older one), and `sample` stands in for it.
  // ⚠️ NOT THE SAME QUESTION AS `sample`. The pages are a stand-in for someone who only UPLOADED a resume
  // (the builder row is what renders pages), yet the build lanes read the upload — gating Write and Tailor
  // on `sample` told exactly those people to "Build your resume first".
  const [hasResume, setHasResume] = useState<boolean | null>(null);
  const [isPaid, setIsPaid] = useState(false);
  // Whether isPaid has been read at all yet: until it has, a used-up allowance is not named as the free one
  // or the plan's — a paying user's first second on Home must not read "your free generations are used".
  const [paidRead, setPaidRead] = useState(false);
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
  // The chip on screen, held by KEY. empIdx alone is a position, and a position into a row that changes
  // under it names a different company — the ribbon and the CTA would silently rename themselves to an
  // employer the user never chose.
  // ⚠️ KEPT BY KEY FROM THE FIRST LOAD ON, NOT ONLY AFTER A TAP (2026-09-19). It used to stay null until the
  // user tapped, so "the default (best match first) is still free to move" — and every load re-ranked the row,
  // so the chip the user was reading could change under them. The row is a SAVED list now (services/homeRoster:
  // the owner's row refilled itself with the Moroccan Ministry, then with Konnekt ×3, after he emptied it), and
  // the selection is saved with it: a remount or a relaunch opens on the same chip. When the chip itself leaves,
  // the one that slid into its place is selected — never "back to the first".
  const pickedKey = useRef<string | null>(null);
  // HARNESS ONLY (loaders): the preview's saved row lives with the mount, in memory — its fixtures re-seed it
  // on every open, and nothing of it reaches storage. A signed-in row is homeRoster's (per account).
  const previewRoster = useRef<Roster | null>(null);

  const kind = kindOfMode(mode);
  // When the saved documents were last asked for: listToken re-reads the chips' dots, docToken the
  // selected chip's own document. Bumped by a landed build, a pull-to-refresh and a return to Home —
  // all READS.
  const [listToken, setListToken] = useState(0);
  const [docToken, setDocToken] = useState(0);
  // The same idea for the gate hint under the action: when this moves, the dry run is asked again. Bumped by a
  // return to this screen and by an entitlement the SERVER confirmed (a purchase or a Restore) — see the effect
  // that reads it. A READ, like the two above.
  const [entRev, setEntRev] = useState(0);
  // Builds that just landed, by store key → the document id they produced. While a chip is in here and its
  // lookup has not yet shown that document, the chip is "document on its way" — never "nothing saved".
  const [landed, setLanded] = useState<Record<string, number>>({});
  const landedTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => () => {
    for (const k of Object.keys(landedTimers.current)) clearTimeout(landedTimers.current[k]);
  }, []);
  /** This landing has been answered (or has waited long enough): the chip's own lookup speaks for it again. */
  const forgetLanded = useCallback((key: string) => {
    const timer = landedTimers.current[key];
    if (timer) { clearTimeout(timer); delete landedTimers.current[key]; }
    if (!alive.current) return;
    setLanded((m) => {
      if (m[key] === undefined) return m;
      const n = { ...m };
      delete n[key];
      return n;
    });
  }, []);
  /**
   * A build landed with a document for this chip. ⚠️ HELD UNTIL THE LOOKUP SHOWS THAT DOCUMENT: until it
   * answers, the chip still holds the answer from BEFORE the build ("nothing saved"), which drew
   * "Tailor my resume" — and read the gate — for a document the user had just paid for. Bounded by
   * LANDED_WAIT_MS, so a lookup that never finds it gives the action back rather than hiding it forever.
   */
  const markLanded = useCallback((key: string, docId: number) => {
    if (!alive.current) return;
    const timer = landedTimers.current[key];
    if (timer) clearTimeout(timer);
    landedTimers.current[key] = setTimeout(() => forgetLanded(key), LANDED_WAIT_MS);
    setLanded((m) => (m[key] === docId ? m : { ...m, [key]: docId }));
  }, [forgetLanded]);
  // ⚠️ THE REFS ARE MOVED WITH THE STATE, NOT ONLY AT THE NEXT RENDER (see commitTargets): the add,
  // remove and landing flows read them from timers and resolved requests, and a value synced only at
  // render would name the chip row from before the change that just happened.
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const empIdxRef = useRef(empIdx);
  empIdxRef.current = empIdx;
  const kindRef = useRef(kind);
  kindRef.current = kind;

  // ⚠️ THE USER'S HANDS ON HOME (2026-09-20 review): every touch on the screen, every pick, every time Home loses focus.
  // Another phone's row (adopted by a load, or put in place by a 409 — services/homeRoster savedRowOf) brings its
  // selection with it ONLY while this has not moved since the load or the resume that found it: the chip under a finger,
  // behind a build or behind a Customize never changes because the other phone was used last. (It used to move a few
  // seconds after a cold start — once the whole dashboard had answered — under whatever the user had started on.)
  const acts = useRef(0);
  const noteTouch = useCallback(() => { acts.current++; }, []);
  const focused = useRef(false);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    return () => { focused.current = false; acts.current++; };
  }, []));

  /**
   * A SAVED row on screen before (or without) a load's merge: the early paint, and a phone picked up again. `follow`:
   * the row is another phone's, and its selection comes with it (the caller has checked that the user's hands are off
   * the screen). Otherwise the chip already picked stays, or the row's own selection when none is.
   */
  const paintSaved = useStableFn((r: Roster, follow: boolean) => {
    const t = mergeAdded(rosterRow(r).filter((x) => !removedNow(x.key)), pickedKey);
    if (follow && r.selected && t.some((x) => x.key === r.selected)
      && !String(pickedKey.current || '').startsWith(PENDING)) pickedKey.current = r.selected;
    if (!pickedKey.current) pickedKey.current = r.selected;
    let j = pickedKey.current ? t.findIndex((x) => x.key === pickedKey.current) : -1;
    if (j < 0) j = 0;
    pickedKey.current = t[j]?.key ?? null;
    targetsRef.current = t;
    setTargets(t);
    empIdxRef.current = j;
    setEmpIdx(j);
  });

  // The harness's fixture list is a COMPLETE answer (listAnswer); a signed-in load reports what each read said.
  const loadTargets: () => Promise<TargetAnswer> = loaders
    ? () => Promise.resolve().then(() => loaders.targets()).then(listAnswer)
    : fetchTargetAnswer;
  const loadCards = loaders?.cards || fetchHomeCards;
  const loadPaid = loaders?.paid || (async () => { try { const st = await fetchSubscriptionStatus(); return !!st?.subscription; } catch { return false; } });
  const loadHistory = loaders?.history || fetchDownloadHistory;
  const loadSetup = loaders?.setup || (async () => (await fetchProfileSnapshot())?.setup ?? null);

  // ⚠️ READ THROUGH A REF, SO load() NEVER CHANGES IDENTITY. loadPaid/loadSetup above are new
  // arrow functions on every render, and load used to depend on them — so load was a new function
  // every render and useFocusEffect re-ran it: any render more than 60s after the last load fired a
  // full reload. A build re-renders Home as it moves, which made that a reload storm that could
  // replace the chip row mid-build.
  const live = useRef({ loaders, loadTargets, loadCards, loadPaid, loadSetup });
  live.current = { loaders, loadTargets, loadCards, loadPaid, loadSetup };
  // ⚠️ SEQUENCE GUARD: two loads can overlap (focus + pull-to-refresh + a landed build), and a
  // slower OLDER one landing last would put the previous pages back on screen.
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
    // Fresh pages were asked for, so the ones on screen are of the résumé that was just replaced: stop showing
    // them as this résumé (deckStale). Cleared by whichever load commits a deck last.
    if (freshPages) setDeckStale(true);
    const { loaders, loadTargets, loadCards, loadPaid, loadSetup } = live.current;
    // ⚠️ BEFORE the merge below: another account's added employers (and its saved row) must never lead this
    // row. The preview harness has no account, and claiming would wipe its fixtures on every load.
    const claiming = loaders ? Promise.resolve({ wiped: false, who: null as string | null }) : claimAccountCache();
    // Set once this load has put its own row on screen: the early paint below must never land over it.
    let committed = false;
    // The user's hands (acts) as this load begins: another phone's row moves the selection only if they stay off.
    const actsAt = acts.current;
    // The server's copy of the row (homeRoster: shared by the user's phones), read with the session the claim saw —
    // alongside the answer, not after it. The preview harness has no account, so none.
    const remoteP: Promise<RemoteRoster | null | undefined> = loaders
      ? Promise.resolve(undefined)
      : claiming.then(({ who }) => fetchRemoteRoster(who)).catch(() => undefined);
    // ⚠️ THE SAVED ROW PAINTS AS SOON AS STORAGE ANSWERS (2026-09-19) — on a cold start, and on every remount
    // (the Dashboard toggle and the HomeBoundary fallback both unmount this screen). The network answer behind it
    // is the whole dashboard (user 1: 255 employers, 1,676 postings), and waiting for it drew skeleton chips, then
    // a row whose selection had gone back to the first chip. ⚠️ ONLY AFTER THE ACCOUNT IS READ: the in-memory row
    // survives a sign-out, and a remount that painted it before the claim would show the previous account's
    // employers to the next one.
    // ⚠️ …AND THEN THE SERVER'S ROW, THE MOMENT IT ANSWERS (2026-09-20 review). When another phone wrote since, its row
    // used to wait for the whole dashboard (seconds, for user 1) and then replace this phone's row — selection and all —
    // under a user who had already tapped Build or Customize on the old one. It is one small row: it comes on screen as
    // soon as it answers (a phone with no row of its own paints from it too), before the user has touched anything —
    // and not at all once they have (acts), while a build for the chip on screen runs, or while a chip is being added.
    if (!loaders && !targetsRef.current.length) {
      claiming.then(async ({ who }) => {
        // An unreadable session (null) is no account switch (claimAccountCache): the row is still cacheOwner's.
        const { acct, owner } = rowAccounts(who, cacheOwner);
        if (!owner) return;
        const saved = await readRoster(owner);
        let warm: Promise<void> | null = null;
        if (saved && saved.keys.length) {
          // The posting text docLookupOf reads synchronously must be in memory before any chip exists.
          await (warm = warmJobListings());
          if (committed || !alive.current || seq !== loadSeq.current || targetsRef.current.length || cacheOwner !== owner) return;
          paintSaved(rosterCopy(owner) || saved, false);
        }
        // Only for the account this load READ: the server's copy was fetched with that session.
        if (!acct) return;
        const remote = await remoteP;
        const untouched = () => !committed && alive.current && seq === loadSeq.current && cacheOwner === owner
          && acts.current === actsAt && !selBuildingRef.current && !String(pickedKey.current || '').startsWith(PENDING);
        if (!untouched()) return;
        // `peek`: a 409's hand-over and a deleted row are the load's to act on, not this paint's.
        const other = savedRowOf(owner, rosterCopy(owner) || saved, remote, { peek: true });
        if (!other.adopted || !other.row || !other.row.keys.length) return;
        await (warm || warmJobListings());
        if (!untouched()) return;
        // Kept now, so what the user does next edits THIS row; the load merges its answer into it (same revision).
        keepRoster(acct, other.row);
        paintSaved(other.row, true);
      }).catch(() => {});
    }
    // ⚠️ THE DECK IS STARTED HERE AND AWAITED AT THE END (2026-09-20). All five of these used to be one
    // Promise.all, so the whole screen — the chip row, the catalogue, the `loading` flag — waited on
    // /home-cards, the ONE call on Home that can take twenty seconds: every card is keyed on the résumé's
    // updated_at, so the first load after a build is five cold chromium renders. Everything else answers in about
    // a second (measured against production, 2026-09-20: roster 261 ms, subscription 295 ms, catalogue 527 ms,
    // profile 687 ms, dashboard 1161 ms) — and the owner sat in front of a skeleton chip row for all of it.
    // Only the deck may wait for the deck.
    const cardsP: Promise<HomeCards | 'none' | null> = Promise.resolve().then(() => loadCards()).catch(() => null);
    const [answer, cat, claim, remote] = await Promise.all([
      loadTargets(),
      (loaders?.catalogue || fetchTemplateCatalogue)().catch(() => [] as HomeCard[]),
      claiming,
      remoteP,
    ]);
    const wiped = claim.wiped;
    if (wiped) {
      pickedKey.current = null;
      // The documents on screen were the previous account's: ask again for this one.
      setListToken((n) => n + 1);
      setDocToken((n) => n + 1);
    }
    // Nothing came back at all: if that was the server refusing the session, the cache goes too.
    let refused = false;
    // ⚠️ DECIDED FROM THE READS THAT HAVE ALREADY ANSWERED — NEVER FROM THE DECK (2026-09-20 review). This asked
    // `(await cardsP) === null`, two lines above the row commit, and `ranked` is empty for exactly the account this
    // change is for: a brand-new user with no tracked employers and no saved jobs (the owner's own, on build 210).
    // So the one screen that most needed its row painted still waited the full twenty seconds for /home-cards here.
    // What "nothing came back at all" really means is that NEITHER STORE ANSWERED — TargetAnswer reports what each
    // read said, and a failed one is …Ok false with its list null, never an empty answer. An empty ranking from two
    // reads that succeeded is not a refusal; it is an account with nothing on it yet.
    if (!loaders && !answer.ranked.length && !answer.dashOk && !answer.savedOk && (await sessionRejected())) {
      forgetAccountCache();
      cacheOwner = null;
      pickedKey.current = null;
      refused = true;
    }
    if (seq !== loadSeq.current) return undefined;

    // ── THE ROW: the saved one, merged with this answer (services/homeRoster) ──
    // ⚠️ NOT REPLACED BY IT. This used to be `setTargets(fetchTargets())` — a fresh top 12 on every focus, pull
    // and remount — so a chip the user removed was replaced by the next one down the ranking, and a failed read
    // replaced the whole row. Now a chip leaves only when the user took it away, and only genuinely new
    // postings / saved cards / employers join, at the end.
    // `acct`: the account this answer is SAVED under — only one this load actually read. `owner`: the account whose
    // saved row it is MERGED into. ⚠️ AN UNREADABLE SESSION (claim.who null) IS NO ACCOUNT SWITCH (claimAccountCache
    // keeps cacheOwner's module cache on it too), so the row on screen is still cacheOwner's: it is merged against
    // THAT saved row — it used to be merged against nothing, i.e. replaced by the raw ranking for one load — and
    // nothing is saved under it (homeRoster rowAccounts, 2026-09-19 review).
    const { acct, owner } = !loaders && !refused ? rowAccounts(claim.who, cacheOwner) : { acct: null, owner: null };
    const stored = owner ? await readRoster(owner) : undefined;
    // ⚠️ …and a screen that has gone writes NOTHING (2026-09-19 review): its pickedKey is the chip it showed, and a
    // remount has since saved its own selection — a stale load finishing late put the old one back, so the next open
    // jumped back to it. The mounted screen runs its own load.
    if (seq !== loadSeq.current || !alive.current) return undefined;
    // ⚠️ SYNCHRONOUS FROM HERE TO THE SAVE. A removal, an Undo or an add can land between two awaits, and a
    // merge of a copy read before it would write that edit away — so the row is taken from memory NOW.
    committed = true;
    // null = no saved row yet; ⚠️ undefined = none could be READ (no account, or storage threw) — see planRow.
    // ⚠️ THIS DEVICE'S ROW OR THE SERVER'S (2026-09-20, homeRoster savedRowOf): the server's when this device has none or
    // another phone wrote since — the owner's second phone used to seed a row of its own from the ranking. The server's
    // copy counts only for the account this load READ (acct): `remote` was fetched with that session.
    const picked = !loaders && owner ? savedRowOf(owner, rosterCopy(owner) || stored, acct ? remote : undefined) : null;
    const savedRow: Roster | null | undefined = loaders ? previewRoster.current : picked ? picked.row : undefined;
    // The chip the user was on — this row's own selection, or the one saved with the row.
    const before = wiped ? [] : targetsRef.current;
    const plan = planRow(savedRow, answer, { removed: removedNow, added: addedHere, shown: before.length, refused });
    const m = plan.merged;
    // ⚠️ ANOTHER PHONE'S ROW WAS TAKEN — by this load (adopted), or by a write of this phone's the server refused since
    // (replaced: a 409 put the other phone's row in place, this phone's unsent edits laid over it). Its selection is the
    // user's LATEST pick on any phone (savedRowOf keeps this phone's own when that is the later one), so the screen goes
    // to it. ⚠️ A 409 USED TO LEAVE THE SCREEN ON ITS OLD CHIP (2026-09-20 review), and the save below then stamped that
    // chip as a brand-new pick, which beat the pick the user had really made on the other phone.
    // ⚠️ NOT UNDER THE USER'S HANDS (acts): once they touched Home during this load, or while a build for the chip on
    // screen runs, or while a chip is being added, the chip on screen stays.
    const handsOn = acts.current !== actsAt || selBuildingRef.current || String(pickedKey.current || '').startsWith(PENDING);
    if (picked && (picked.adopted || picked.replaced) && !handsOn
      && m.roster.selected && m.row.some((x) => x.key === m.roster.selected)) pickedKey.current = m.roster.selected;
    if (!pickedKey.current) pickedKey.current = before[empIdxRef.current]?.key ?? m.roster.selected ?? null;
    const oldAt = pickedKey.current ? before.findIndex((x) => x.key === pickedKey.current) : -1;
    // Employers added on this screen lead, whether or not the server has them yet — and a chip removed
    // here stays gone even when this answer was read before the server heard about the removal.
    // ⚠️ With nothing to merge into (no saved row could be read, or both stores failed) the row on screen STAYS
    // (planRow.keep) — a refused session empties it (above).
    const t = plan.keep ? before : mergeAdded(refused ? [] : m.row, pickedKey);
    let j = pickedKey.current ? t.findIndex((x) => x.key === pickedKey.current) : -1;
    if (j < 0) {
      // ⚠️ THE NEIGHBOUR, NEVER THE FIRST CHIP: their chip left the row (removed, hidden, untracked — by the
      // user, somewhere), so the one that slid into its place is on screen, as when they remove it here.
      const saved = m.roster.selected ? t.findIndex((x) => x.key === m.roster.selected) : -1;
      j = oldAt >= 0 ? Math.min(oldAt, t.length - 1) : saved;
      if (j < 0) j = 0;
    }
    pickedKey.current = t[j]?.key ?? null;
    // ⚠️ A LOAD NEVER STAMPS A PICK (2026-09-20 review). The row keeps the chip on screen, under the row's OWN pick time:
    // a screen that merely still shows a chip has picked nothing. Stamped "now", a stale chip beat the pick the user made
    // on the other phone since — and that phone jumped to it. Only the user's own pick is stamped (the selKey effect).
    const kept = rosterSelect(m.roster, pickedKey.current, m.roster.selectedAt);
    if (loaders) previewRoster.current = kept;
    // ⚠️ Storage that could not be read (undefined) is never seeded over: that would erase the saved row (planRow.save).
    // Only under an account this load READ (acct) — never under the cacheOwner an unreadable session fell back to.
    else if (acct && plan.save) keepRoster(acct, kept);
    targetsRef.current = t;
    setTargets(t);
    empIdxRef.current = j;
    setEmpIdx(j);
    // The row, the catalogue and the chrome are on screen NOW — the deck arrives on its own below.
    setLoading(false);
    // ⚠️ AND THE PAID FLAG IS NOT WAITED FOR IN FRONT OF THE DECK (2026-09-20 review). Nothing about a card is
    // decided by it, and it is a network read of its own (/subscription/status, a 20 s timeout, its own SecureStore
    // reads) — awaited here it held the new résumé's pages, and the skeletons drawn over them, behind a call that
    // has nothing to do with them. It lands when it lands.
    loadPaid()
      .then((paid) => { if (seq === loadSeq.current && alive.current) { setIsPaid(paid); setPaidRead(true); } })
      .catch(() => {});
    const c = await cardsP;
    if (seq !== loadSeq.current || !alive.current) return undefined;
    // ⚠️ THE CATALOGUE LANDS WITH THE CARDS, NOT BEFORE THEM. `slots` is what turns the deck into all 73 designs,
    // and the hydrator renders whatever in that deck has no pixels near the card on screen — so a catalogue
    // committed while /home-cards was still in flight sent it after the first five designs of the CATALOGUE while
    // the first five of the DECK were already being rendered for this very request: ten cold renders for five
    // pages, in the wrong order. It answers in ~254 ms and waits here; nothing on screen depends on it sooner.
    if (cat.length) setSlots(cat);
    // ⚠️ Only the server's own 'none' may arm the build-my-resume lane — see fetchHomeCards.
    // A transient failure leaves cards AND noResume exactly as they were: at worst the user sees
    // the retry state, never a CTA that would spend a generation rewriting a resume they have.
    if (c === 'none') { setCards([]); setNoResume(true); setLoadFailed(false); }
    else if (c) {
      // ⚠️ AND WHENEVER THE SERVER SAYS THESE PAGES ARE OF A DIFFERENT RÉSUMÉ (2026-09-20 review). `freshPages` is
      // raised by exactly one caller — the wizard hand-back — so every other résumé-changing path (an edit in the
      // builder, a new photo, the pull that follows either) kept hydrated pictures of the résumé that had just been
      // replaced, and `shots` wins for any design whose picture the payload did not carry. That was survivable while
      // the payload always carried the lead five; with the render budget it no longer does, and it was never right
      // for the catalogue designs. `version` is the server's own cache key: a different one is a different résumé.
      if (freshPages || (c.version && c.version !== cardsVer.current)) {
        dead.current = {}; misses.current = {}; setShots({});
      }
      if (c.version) cardsVer.current = c.version;
      // ⚠️ THE DEFERRED DESIGNS COME BACK IN `pending`, NOT IN `cards` (2026-09-20 review) — see the server's
      // homeCards. A card with no picture is one the client has to heal by asking for it by id, and the builds
      // already in the store do not (one miss and the design is dead for the session), so the server hands them
      // under a key those builds ignore. THIS client heals them — `misses` retries once, and the deck applies
      // `shots` even with no catalogue — so it puts them straight back where the server chose them: after the
      // designs that were drawn, in order. Deferral is a suffix of the server's list, so appending restores it.
      setCards(c.pending && c.pending.length ? [...c.cards, ...c.pending] : c.cards);
      setNoResume(false); setSample(!!c.sample); setLoadFailed(false);
      // ⚠️ Only a real boolean counts: an older server that does not send it leaves this null, and `sample`
      // stands in — never `false`, which would tell someone with a resume to build one.
      setHasResume(typeof c.hasResume === 'boolean' ? c.hasResume : null);
    }
    else { setLoadFailed(true); }
    // ⚠️ ONLY A COMMITTED ANSWER ENDS THE SKELETONS (2026-09-20 review). This used to be unconditional, so the
    // honesty flag was dropped exactly where the client does not know what the new résumé looks like: a
    // fresh-pages read that FAILED (c === null) fell straight back to the deck it had, which for the account
    // building its first résumé is the server's SAMPLE — his own name over invented content — under the heading
    // of the build he had just paid for, with the sample bar and "Build your resume first" back with it. A
    // failed reload keeps the deck stale; `shown` then stands aside for the retry tile.
    // ⚠️ Cleared by whichever load COMMITS last, not only by the one that raised it (a superseded fresh-pages
    // load returns above) — 'none' counts, so the build-my-résumé lane is never held in skeletons either.
    if (c) setDeckStale(false);
    // ⚠️ `setup` IS NOT READ HERE ANY MORE (2026-09-20). It used to be the very last thing this function did —
    // behind the cards, i.e. behind those twenty seconds — which is why Home went on offering "Pick up where you
    // left off" after a finished build: the server had said `finished` since the moment it was saved, and the
    // client had not asked yet. The focus effect now reads it on every focus, in parallel with this whole load.
    return { cards: c, targets: t };
  }, []);

  /**
   * The library, per kind.
   *
   * ⚠️ CACHE FIRST, THEN REVALIDATE. Home has no SWR anywhere today, so a cold open shows nothing
   * until the network answers. Painting the last answer first is the difference between a section
   * that appears and one that pops in a second late; the reference for this shape is the Job Hub's
   * dashboard cache. A failed refresh returns null and leaves what is on screen alone.
   *
   * ⚠️ ITS OWN READ, NOT A PART OF load(). load() is throttled to one run a minute, and the library
   * used to be re-read only from the mode effect — so a PDF downloaded from the gallery (the server had
   * its download_history row) came back to a Home that did not show the card until the throttle let a
   * reload through. This is asked for on every focus after the first and when a build lands, on top of
   * the mode switch, and it never looks at lastLoad. ⚠️ NO THROTTLE HERE EITHER: a read of one small list.
   *
   * ⚠️ SEQUENCE GUARD (histSeq): a focus read, a landing and a mode switch can overlap, and a slower OLDER
   * answer landing last would put the previous shelf back — or another kind's — over the newer one. Only
   * the newest read may touch the list, and a superseded one leaves the loading flag to its successor.
   * Stable identity (useStableFn), so the focus effect never re-subscribes because of it.
   */
  const histSeq = useRef(0);
  const refreshHistory = useStableFn(async (kind: Mode) => {
    const wire: 'resume' | 'cover_letter' = kind === 'letter' ? 'cover_letter' : 'resume';
    const seq = ++histSeq.current;
    const current = () => alive.current && seq === histSeq.current;
    if (!loaders) {
      const cached = await cachedDownloadHistory(wire).catch(() => null);
      if (cached && current()) { setHistory(cached.items); setHistLoading(false); }
    }
    const fresh = await loadHistory(wire).catch(() => null);
    if (!current()) return;
    if (fresh) setHistory(fresh.items);
    else if (loaders) setHistory([]);
    setHistLoading(false);
  });

  // A kind switch is the one read that empties the shelf first: the other kind's cards must not sit under
  // the new heading while its own answer is on its way. A focus or a landing re-reads in place.
  useEffect(() => { setHistLoading(true); setHistOpen(false); refreshHistory(mode); }, [mode, refreshHistory]);

  /**
   * Get a document again.
   *
   * ⚠️ A LIBRARY TAP NO LONGER COMES HERE — a card opens its page (openHistoryItem). This runs only where
   * there is nothing to open: a letter card with no saved letter behind it, and a file the paywall has just
   * unlocked.
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
    // ⚠️ The harness has no account: the file would be asked of the production API, signed out.
    if (loaders) { Alert.alert('Preview only', 'Downloading needs a signed-in account.'); return; }
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
  }, [againId, mode, refreshHistory, loaders]);

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

  /** The design's accent, from the catalogue already in hand — or a letter format's own. Never a fetch. */
  const accentFor = useCallback((templateId: string): string => {
    const hit = slots.find((c) => c.id === templateId) || cards.find((c) => c.id === templateId)
      || LETTER_DESIGNS.find((d) => d.id === templateId);
    return (hit && hit.accent) || E.blue;
  }, [slots, cards]);

  // Back on Home from the editor, the gallery or the plans screen, a saved document may have been edited
  // (new pages) or gone stale, so the documents are asked for again — a READ, never a build. The very first
  // focus is the mount, which asks anyway (the mode effect reads the library). ⚠️ The library is re-read
  // here on its own, NOT through load(): its 60 s throttle is what hid a PDF downloaded from the gallery
  // (see refreshHistory). The kind on screen comes from kindRef, which moves with the state.
  const focusCount = useRef(0);
  /**
   * ⚠️ THE PROFILE'S `setup` IS RE-READ ON EVERY FOCUS, OUTSIDE load()'S 60 s THROTTLE (2026-09-19). Coming back from
   * the Make Yours wizard within a minute used to show the setup from BEFORE it — "One thing left: your signature"
   * while the signature had just been saved (user 616). One small GET; a failed one leaves the button as it was.
   */
  // Every SERVER answer applied to `setup`. ⚠️ Only so the wizard's handed-over copy below can tell whether one has
  // landed since it was handed over: a read that answers first is the newer answer and keeps the screen.
  const setupRead = useRef(0);
  const refreshSetup = useStableFn(async () => {
    const st = await live.current.loadSetup().catch(() => null);
    if (st && alive.current) { setupRead.current++; setSetup(st); }
  });
  // The button paints at once from this account's last known setup, before the first read answers.
  useEffect(() => {
    if (loaders) return;
    cachedSetup().then((st) => { if (st && alive.current) setSetup((cur) => cur || st); }).catch(() => {});
  }, [loaders]);
  useFocusEffect(useCallback(() => {
    const built = loaders ? { changed: false, setup: null, who: null } : consumeProfileChanged();
    // ⚠️ THE WIZARD'S OWN ANSWER, APPLIED BEFORE ANYTHING IS ASKED FOR (2026-09-20). It read the profile the
    // moment the build landed, while "Your resume is ready" was on screen; using it here is the difference
    // between a first frame that says "Pick up where you left off" and one that does not.
    // ⚠️ …AND ONLY TO THE ACCOUNT IT WAS READ FOR (2026-09-20 review). A hand-over is module state that a sign-out
    // does not clear (the reason SETUP_CACHE is keyed by account), so it is confirmed against the session first —
    // one SecureStore read, still milliseconds, still far ahead of the profile read fired beside it. A server
    // answer that lands first is the newer one and keeps the screen (setupRead).
    if (built.setup) {
      const handed = built.setup;
      const at = setupRead.current;
      signedInAccount()
        .then((who) => { if (who && who === built.who && alive.current && setupRead.current === at) setSetup(handed); })
        .catch(() => {});
    }
    // ⚠️ AND `setup` IS RE-READ ON EVERY FOCUS, IN PARALLEL WITH load() — never inside it and never behind it.
    // It used to be the last line of load(), i.e. behind /home-cards: after a build that is twenty seconds of
    // cold renders, and the button was wrong for every one of them. One small GET (measured 559 ms); a failed
    // one leaves the button exactly as it was.
    refreshSetup();
    // Back from a wizard that just built the résumé: the pages on Home are of the OLD one — reload them, now.
    if (built.changed) load(true, true);
    else load();
    if (focusCount.current++ > 0) {
      setDocToken((n) => n + 1);
      setListToken((n) => n + 1);
      refreshHistory(modeOfKind(kindRef.current));
      // ⚠️ Back from the plans screen, the gate hint under the action was a MONTH-old answer (2026-09-20): the
      // dry run is read once per chip selection, and going to Plans and back changes no chip — so "Your allowance
      // is used" stayed under the button of someone who had just subscribed. It is a free read; re-ask it.
      setEntRev((n) => n + 1);
    }
  }, [load, refreshHistory, refreshSetup, loaders]));

  // A purchase or a Restore the server confirmed while Home was mounted underneath the plans screen.
  useEffect(() => subscribeEntitlements(() => { if (alive.current) setEntRev((n) => n + 1); }), []);

  const onRefresh = async () => {
    setRefreshing(true);
    setDocToken((n) => n + 1);
    setListToken((n) => n + 1);
    // A pull is a request for everything to be current, and `setup` is no longer part of load() — so it is asked
    // for here too, alongside it. (Its own read; a failed one leaves the button alone.)
    refreshSetup();
    await load(true);
    setRefreshing(false);
  };

  /**
   * ⚠️ A PHONE PICKED UP AGAIN SHOWS THE ACCOUNT'S ROW AT ONCE (2026-09-20 review). A load runs only on focus (60 s
   * throttle) or a pull, so a phone brought back from the background kept its old row until some later navigation — and
   * then the row and its selection changed under the user. Back from the background, only the server's copy is read (one
   * small row, never the dashboard): when another phone wrote since, its row and its pick come on screen now, before
   * anything has been touched — and not at all once something has (acts), while a build for the chip on screen runs, or
   * while a chip is being added. The next load merges its answer into it as usual. A READ; nothing is built or charged.
   */
  const resumeRow = useStableFn(async () => {
    const acct = cacheOwner;
    if (loaders || !acct || !focused.current || !targetsRef.current.length) return;
    const at = acts.current;
    // fetchRemoteRoster reads nothing unless the session still names this account.
    const remote = await fetchRemoteRoster(acct);
    if (!remote || !remote.roster) return;
    const local = rosterCopy(acct) || (await readRoster(acct));
    if (!alive.current || !focused.current || cacheOwner !== acct || acts.current !== at || selBuildingRef.current
      || String(pickedKey.current || '').startsWith(PENDING)) return;
    const other = savedRowOf(acct, local, remote, { peek: true });
    if (!other.adopted || !other.row || !other.row.keys.length) return;
    keepRoster(acct, other.row);
    paintSaved(other.row, true);
  });
  useEffect(() => {
    if (loaders) return;
    let last: AppStateStatus = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      const was = last;
      last = next;
      if (next === 'active' && was === 'background') resumeRow().catch(() => {});
    });
    return () => sub.remove();
  }, [loaders, resumeRow]);

  /* ── the selected employer's own document ── */

  // ⚠️ Injected loaders REPLACE the network, including a loader the harness did not supply: a
  // harness that forgot one must render "nothing saved", not quietly call the production API.
  const docLoaders: DocLoaders | undefined = useMemo(() => (loaders ? {
    current: loaders.doc || (async () => null),
    cards: loaders.docCards || (async () => null),
    list: loaders.docList || (async () => []),
  } : undefined), [loaders]);
  const docLoadersRef = useRef(docLoaders);
  docLoadersRef.current = docLoaders;

  const target: Target | undefined = targets[empIdx];
  const selRk = target ? rkOf(target) : null;
  const selRkRef = useRef(selRk);
  selRkRef.current = selRk;
  const { list: docList } = useDocList(kind, listToken, docLoaders);
  const docListRef = useRef(docList);
  docListRef.current = docList;

  /* ── the library's pages ── */

  // Bumped when a warm lands: `imageFor` reads the module image cache at render, so the shelf needs a
  // render to see what the warm put there.
  const [libImgVer, setLibImgVer] = useState(0);

  /**
   * The page for a library card, from what is ALREADY IN HAND — never a fetch (see DownloadHistory's header).
   * A card of the kind on screen belongs to that employer's saved document (savedDocFor, the same pick
   * openHistoryItem makes): its page in that design from the document image cache the deck fills and the
   * warm below tops up, else a page the library kept from a previous open. Failing those, a resume shows the
   * BASE page in that design (thumbFor — the same stand-in the card's zoom opens on) and a letter shows
   * nothing: a letter's only picture is a saved letter's own page, so the drawn letter is the honest fallback.
   * ⚠️ Decided per card by ITS kind, not by the mode: the server never mixes kinds in one list, but the
   * harness does, and a letter card must never borrow a resume page.
   */
  const imageFor = useCallback((it: DownloadHistoryItem): string | null | undefined => {
    const k: DocKind = it.kind === 'cover_letter' ? 'cover_letter' : 'resume';
    const who = String(it.employer || '').trim();
    const saved = k === kind && docList && who ? savedDocFor(docList, who) : null;
    if (saved && it.templateId) {
      const own = cachedDocImage(k, saved.docId, saved.updatedAt, it.templateId)
        || libPages.get(libPageKey(k, saved, it.templateId))?.image || null;
      if (own) return own;
    }
    return k === 'resume' ? thumbFor(it.templateId) : null;
    // libImgVer: the module image cache was filled by a warm since the last render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, docList, thumbFor, libImgVer]);

  /**
   * Fill the front of the shelf. Once the saved list is in hand, the first LIB_WARM cards whose employer has a
   * saved document of the kind on screen, and whose page is not cached yet, are asked for through
   * warmDocImages — grouped by document, one document at a time, behind the same single-flight the deck's
   * own waves use, so the serial renderer never sees two waves. A READ of pages that exist, never a build.
   * ⚠️ In the harness the pages come from its docCards fixtures (opts.cards, the same injected reader the
   * deck uses — a harness that supplied none answers null), so the warm never reaches the network signed out.
   */
  useEffect(() => {
    if (!docList || !history.length) return;
    const k = kind;
    const cards = docLoadersRef.current?.cards;
    const byDoc = new Map<string, { docId: number; updatedAt: string; ids: string[] }>();
    for (const it of history.slice(0, LIB_WARM)) {
      const who = String(it.employer || '').trim();
      if (it.kind !== k || !it.templateId || !who) continue;
      const saved = savedDocFor(docList, who);
      if (!saved || cachedDocImage(k, saved.docId, saved.updatedAt, it.templateId)) continue;
      const key = `${saved.docId}|${saved.updatedAt}`;
      const e = byDoc.get(key) || { docId: saved.docId, updatedAt: saved.updatedAt, ids: [] };
      if (!e.ids.includes(it.templateId)) e.ids.push(it.templateId);
      byDoc.set(key, e);
    }
    if (!byDoc.size) return;
    let cancelled = false;
    (async () => {
      for (const e of byDoc.values()) {
        if (cancelled) return;
        try { await warmDocImages(k, e.docId, e.updatedAt, e.ids, { cards }); } catch { /* the drawn page stays */ }
        if (!cancelled && alive.current) setLibImgVer((v) => v + 1);
      }
    })();
    return () => { cancelled = true; };
  }, [docList, history, kind]);
  const { doc, state: docState, reload: reloadDoc } = useTargetDoc(kind, target || null, { refreshToken: docToken, loaders: docLoaders });
  const docRef = useRef(doc);
  docRef.current = doc;

  /**
   * The tint a library card's drawn page (and its zoomed card) wears when its saved document is THE ONE ON
   * SCREEN: the employer's brand accent — every page of that document was recoloured to design.brand.accent,
   * and the deck above tints its own skeletons with it (useDocDeck) — so the shelf and the hero cannot show the
   * same document in two colours: a catalogue-blue card under a brand-red deck promised one page and delivered
   * another. Any other document answers null and keeps the catalogue accent: its brand is not in hand, and a
   * null/absent brand means "rendered in the design's own colours" (employerDocs.Design.brand), never a guess.
   * Reads `doc` itself, not docRef: the shelf must re-tint when the document on screen changes, not only when
   * the saved list does.
   */
  const brandAccentFor = useCallback((it: DownloadHistoryItem): string | null => {
    const k: DocKind = it.kind === 'cover_letter' ? 'cover_letter' : 'resume';
    const who = String(it.employer || '').trim();
    if (!doc || k !== kind || !docList || !who) return null;
    const saved = savedDocFor(docList, who);
    if (!saved || saved.docId !== doc.docId) return null;
    return doc.design?.brand?.accent || null;
  }, [doc, kind, docList]);
  const { deck: docDeck, gone: docGone } = useDocDeck(
    kind, doc, kind === 'cover_letter' ? LETTER_DESIGNS : slots, cardIdx, { loaders: docLoaders, enabled: !!doc },
  );
  // A library card of the document on screen borrows its page from here rather than asking for it again.
  const docDeckRef = useRef(docDeck);
  docDeckRef.current = docDeck;
  const selPhase = useBuildPhase(kind, selRk);
  const selBuilding = selPhase === 'checking' || selPhase === 'queued' || selPhase === 'building';
  // The letter doors (sayNoLetterYet) run from the zoom 200ms after it starts closing: read the build NOW.
  const selBuildingRef = useRef(selBuilding);
  selBuildingRef.current = selBuilding;

  // A different document is a different deck, and it opens on its best design — reset in the SAME
  // render (not an effect), so the new deck is never drawn for a frame at the old deck's position.
  const deckId = doc ? `doc:${doc.docId}` : `base:${kind}`;
  const [shownDeckId, setShownDeckId] = useState(deckId);
  if (shownDeckId !== deckId) {
    setShownDeckId(deckId);
    if (cardIdx !== 0) setCardIdx(0);
  }

  // The server no longer has the document these pages belong to (pruned, or replaced): ask again rather
  // than show designs that will never fill in.
  useEffect(() => { if (docGone) reloadDoc(); }, [docGone, reloadDoc]);

  // The slim list already says which chips have a document. For a chip that does, a lookup still on its
  // way must never paint the BASE resume under that employer's name — the "wrong company" flash.
  const listDoc = target && docList ? matchDocToTarget(docList, target, kind) : null;
  // A build that just landed for this chip: its document is on its way (see LANDED_WAIT_MS and onLanded).
  const landedDocId = selRk ? landed[storeKeyOf(kind, selRk)] : undefined;
  const landedWait = landedDocId !== undefined;
  const docPending = !doc && ((docState === 'loading' && !!listDoc) || landedWait);
  const docPendingRef = useRef(docPending);
  docPendingRef.current = docPending;
  // The landed document is on screen (and current): the chip's own answer speaks for it from here on. Until
  // then — or until LANDED_WAIT_MS — the landing holds. ⚠️ Keyed on the document id, not on "a doc is shown":
  // a Refresh lands over the OLD document, which is on screen the whole time and must not end the wait.
  useEffect(() => {
    if (!doc || !selRk || landedDocId === undefined) return;
    if (doc.docId === landedDocId && !doc.stale) forgetLanded(storeKeyOf(kind, selRk));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, kind, selRk, landedDocId]);
  // An account with nothing a build can read has nothing to rewrite: its action is the builder. ⚠️ The server's
  // hasResume decides (an upload counts); `sample` only stands in when the server did not say.
  // ⚠️ …AND NOT WHILE THE DECK IS STALE (2026-09-20 review): a fresh-pages reload only ever follows a build that was
  // CHARGED AND SAVED, so both answers on screen are from before it and, for a first résumé, both say there is none.
  // For that window we know better than the last answer — the résumé exists.
  const noResumeYet = deckStale ? false : noResume || !(hasResume ?? !sample);

  const docRks = useMemo(() => {
    const out = new Set<string>();
    if (docList && docList.length) for (const t of targets) if (matchDocToTarget(docList, t, kind)) out.add(rkOf(t));
    return out;
  }, [docList, targets, kind]);

  /**
   * Chips that have a saved document are read ahead, so picking one paints its own pages at once
   * instead of a spinner. ⚠️ Bounded, one request at a time, and only for chips the list says HAVE a
   * document: a lookup computes `stale` on the server, which reads the resume from the database.
   */
  useEffect(() => {
    if (!docList || !docList.length || !targets.length) return;
    const k = kind;
    const wanted = targets
      .filter((t, i) => i !== empIdxRef.current && !!matchDocToTarget(docList, t, k))
      .map((t) => docLookupOf(t))
      .filter((q) => cachedCurrentDoc(k, q) === undefined)
      .slice(0, PREWARM_MAX);
    if (!wanted.length) return;
    let cancelled = false;
    (async () => {
      const read = docLoadersRef.current?.current || fetchCurrentDoc;
      for (const q of wanted) {
        if (cancelled || !alive.current) return;
        let got: DocMeta | null | 'error' = 'error';
        try { got = await read(k, q); } catch { got = 'error'; }
        if (got !== 'error') rememberDoc(k, q, got);
      }
    })();
    return () => { cancelled = true; };
  }, [docList, targets, kind]);

  // What the carousel actually shows. With a catalogue we show EVERY design — the ones the server
  // already rendered lead, the rest follow as slots and fill in on approach.
  const deck: PaperCard[] = React.useMemo(() => {
    // ⚠️ HYDRATED PIXELS APPLY EVEN WITH NO CATALOGUE (2026-09-20 review). The first payload used to carry a picture
    // for every card it named, so `shots` only ever mattered to catalogue slots — and `slots` is empty exactly when
    // /resume-builder/templates failed on this load, which is when the deck is only those five cards. Now that the
    // first load renders within a budget and hands the rest back image-less, those five can need `shots` too: this
    // branch left the hydrator's answers on the floor and the pages blank until the next fresh-pages reload.
    // ⚠️ …AND THE PAYLOAD WINS OVER THEM (2026-09-20 review). `shots` used to be read FIRST, which was harmless
    // only while it held nothing but catalogue slots: the picture in `c.image` is one the server rendered for the
    // résumé it just answered about, and a hydrated one can be of the résumé before it (`shots` is dropped on a
    // version change and a fresh-pages reload — nowhere else). `shots` is for the cards the payload had no picture
    // for, which is exactly the deferred ones, so it belongs second.
    if (!slots.length) return cards.map((c) => ({ ...c, image: c.image || shots[c.id] })) as PaperCard[];
    const ready = new Map(cards.map((c) => [c.id, c] as const));
    const lead = cards.map((c) => ({ ...c, image: c.image || shots[c.id] })) as PaperCard[];
    const rest = slots
      .filter((sl) => !ready.has(sl.id))
      .map((sl) => ({ ...sl, image: shots[sl.id] || null })) as PaperCard[];
    return [...lead, ...rest];
  }, [cards, slots, shots]);

  // The designs with no pixels — a saved document's deck while its lookup is still on the way.
  const slotCards: PaperCard[] = useMemo(
    () => slots.map((sl) => ({ id: sl.id, name: sl.name, accent: sl.accent, image: null })), [slots]);

  // ⚠️ THE BASE DECK HYDRATES ONLY WHILE IT IS THE DECK ON SCREEN. A saved document's deck fills its own
  // pages (useDocDeck) behind its own single-flight; two hydrators running at once would put two waves
  // on the one serial renderer — the stampede both caps exist to prevent.
  const baseOnScreen = mode === 'resume' && !doc && !docPending;

  // Fill in the pages around the one being looked at, a few at a time and never two waves at once:
  // renders are serial server-side and the preview browser recycles every 3 pages.
  useEffect(() => {
    if (!deck.length || noResume || loaders || !baseOnScreen) return;
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
        // Asked for and not drawn: one more try, then it is written off for this deck (see `misses`).
        const missed = (id: string) => {
          const n = (misses.current[id] || 0) + 1;
          misses.current[id] = n;
          if (n >= 2) dead.current[id] = true;   // don't hammer a failing renderer
        };
        if (got && got !== 'none') {
          const add: Record<string, string> = {};
          for (const c of got.cards) if (c.image) add[c.id] = c.image;
          for (const id of want) if (!add[id]) missed(id);
          if (Object.keys(add).length) setShots((p) => ({ ...p, ...add }));
        } else {
          for (const id of want) missed(id);
        }
      } finally {
        hydrating.current = false;
        // A library page waited for this wave: let it go first — the user is looking at it.
        if (basePending.current) setBaseKnock((x) => x + 1);
        // ⚠️ A wave cancelled by a deck change (fresh pages, say) used to leave nothing
        // scheduled: the run the change queued found the mutex still held and returned, so the new
        // resume's designs stayed blank until the user swiped. Knock once so it runs again.
        if (cancelled) setHydrateNudge((n) => n + 1);
      }
    };
    const id = setTimeout(run, 260);
    return () => { cancelled = true; clearTimeout(id); };
  }, [cardIdx, deck, noResume, loaders, hydrateNudge, baseOnScreen]);

  // ⚠️ THE OLD PAGES ARE NOT THIS RÉSUMÉ'S (deckStale). A reload that asked for fresh pages is a build landing,
  // and until its answer arrives every pixel in the deck belongs to the document it replaced — the SAMPLE résumé,
  // for the account building its first one, with the user's own name printed on it. The designs keep their names
  // and accents and lose their pixels, so PaperSkeleton draws them as the pages they are about to be.
  // ⚠️ APPLIED HERE AND NOT TO `deck`: the hydrator reads `deck` to decide what to render, and a deck of blanks
  // would send it after all of them — five more cold renders behind the five already coming.
  const staleDeck: PaperCard[] | null = useMemo(
    () => (deckStale && deck.length ? deck.map((c) => ({ ...c, image: null })) : null), [deckStale, deck]);

  // The deck on screen: the chip's own document when it has one (ranked, with fit), the base resume
  // when it does not, and the letter formats as blank pages while a letter is being written.
  let shown: { cards: PaperCard[]; fit: boolean } | null = null;
  if (doc && docDeck.length) shown = { cards: docDeck, fit: true };
  else if (mode === 'letter') {
    if (selBuilding || docPending) shown = { cards: LETTER_SLOTS, fit: false };
  } else if (!noResume) {
    if (docPending && slotCards.length) shown = { cards: slotCards, fit: false };
    // ⚠️ THE PAGES IT REPLACED ARE NOT AN ANSWER (2026-09-20 review). A fresh-pages reload that could not commit
    // leaves the deck stale (load() above), and the deck still in memory is the résumé this build replaced — the
    // sample, for a first build. Nothing is shown for that window, so the slot goes to the "Couldn't load your
    // designs · Tap to retry" tile below, which `shown` would otherwise win the ternary against; the retry is a
    // plain load(true), and the first one that commits a deck ends both states.
    else if (deckStale && loadFailed) shown = null;
    else if (staleDeck) shown = { cards: staleDeck, fit: false };
    else if (deck.length) shown = { cards: deck, fit: false };
  }
  const card: PaperCard | undefined = shown ? shown.cards[cardIdx] : undefined;
  const buildingProp = useMemo(
    () => (selBuilding && selRk && target ? { kind, rk: selRk, company: target.company } : null),
    [selBuilding, kind, selRk, target?.company],
  );

  const flashReshape = () => {
    setReshaping(true);
    setTimeout(() => { if (alive.current) setReshaping(false); }, 950);
  };

  // Picking an employer "reshapes" the page — the scan pulse the mockup plays over the card.
  const pickEmployer = (i: number) => {
    acts.current++;
    if (i === empIdx) return;
    setEmpIdx(i);
    pickedKey.current = targets[i]?.key || null;
    setReshaping(true);
    try { Haptics.selectionAsync(); } catch {}
    setTimeout(() => setReshaping(false), 950);
    track('home_employer_pick', { i });
  };
  // ⚠️ ONE IDENTITY FOR THE LIFE OF THE SCREEN, so the memoised chips stay memoised: a fresh
  // `() => pickEmployer(i)` per chip per render re-rendered every chip on every render of Home.
  const pickRef = useRef(pickEmployer);
  pickRef.current = pickEmployer;
  const onPickChip = useCallback((i: number) => pickRef.current(i), []);

  /* ── notices, and the chip row as the flows change it ── */

  /**
   * ONE notice line, and ⚠️ AN UNDO ON IT IS NEVER PRE-EMPTED. "Removed X · Undo" is the only way back for a
   * removed chip, and a build finishing in the background (or any other line) used to replace it inside its
   * window — the chip gone, the Undo with it. So while an Undo is up, every other notice waits in line and
   * shows when the Undo ends (a newer Undo still replaces it: that is the chip the user just removed).
   * A line that waited past its maxWait is dropped: news about half a minute ago is not news.
   * Returns the notice's id, so a removal can take its own Undo down once there is nothing left to undo.
   */
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef<Notice | null>(null);
  const noticeQueue = useRef<Notice[]>([]);
  const noticeSeq = useRef(0);
  const isUndo = (n: Notice | null | undefined) => !!n && n.action?.label === 'Undo';
  /** Put a notice on the line (null clears it), moving the ref with the state for the flows that read it. */
  const putNotice = useCallback((n: Notice | null) => {
    noticeRef.current = n ? { ...n, shownAt: Date.now() } : null;
    if (alive.current) setNotice(noticeRef.current);
  }, []);
  /** The line is free: the next queued notice that is still worth showing, or nothing. */
  const nextNotice = useCallback(() => {
    const now = Date.now();
    let next: Notice | null = null;
    while (noticeQueue.current.length) {
      const q = noticeQueue.current.shift()!;
      if (now - q.at <= q.maxWait) { next = q; break; }
    }
    putNotice(next);
  }, [putNotice]);
  const showNotice = useCallback((text: string, action?: NoticeAction, ms = 4500, maxWait = NOTICE_WAIT_MS): number => {
    const n: Notice = { id: ++noticeSeq.current, text, action, ms, at: Date.now(), shownAt: 0, maxWait };
    const cur = noticeRef.current;
    if (cur && isUndo(cur) && !isUndo(n) && Date.now() - cur.shownAt < cur.ms) {
      // The same line twice in the queue says nothing new; the newest copy keeps its place at the back.
      noticeQueue.current = [...noticeQueue.current.filter((q) => q.text !== text), n].slice(-4);
      return n.id;
    }
    putNotice(n);
    return n.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [putNotice]);
  /** Take one notice down, wherever it is — on the line (the next one then shows) or still waiting. */
  const dismissNotice = useCallback((id: number | null) => {
    if (id == null) return;
    noticeQueue.current = noticeQueue.current.filter((q) => q.id !== id);
    if (noticeRef.current && noticeRef.current.id === id) nextNotice();
  }, [nextNotice]);
  /** A signed-out account: nothing queued for it may show, and no Undo of its may be tapped. */
  const clearNotices = useCallback(() => {
    noticeQueue.current = [];
    putNotice(null);
  }, [putNotice]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => {
      if (noticeRef.current && noticeRef.current.id === notice.id) nextNotice();
    }, notice.ms);
    return () => clearTimeout(id);
  }, [notice, nextNotice]);
  /** "Loading your saved version…" — a tap on pages that stand in for a document still on its way. Short-lived. */
  const sayLoadingDoc = () => { showNotice('Loading your saved version…', undefined, 2500, 1500); };
  /** A saved document is on its way for the chip on screen, so the pages drawn in its place are not its pages. */
  const docOnItsWay = () => !docRef.current && docPendingRef.current;
  /**
   * A letter door (Customize, View PDF, a letter page) tapped with no saved letter in hand and none on its way.
   * ⚠️ NEVER A SILENT NO-OP: a letter still being written said nothing at all — the pages on screen are the
   * letter formats drawn blank, and Customize under them did nothing. Being written → says so; otherwise there
   * is simply no letter yet, and the letter panel's Write is the door. Nothing here writes or charges anything.
   */
  const sayNoLetterYet = () => {
    if (selBuildingRef.current) showNotice('Your letter is still being written…', undefined, 2500, 1500);
    else showNotice('There is no saved letter here yet — write it first.', undefined, 3500);
  };
  // Which chip plays the entrance: keyed by render key AND a counter, so only the newly added chip
  // animates, and adding the same employer twice replays it.
  const [enter, setEnter] = useState<{ key: string; n: number } | null>(null);
  const chipRowRef = useRef<ScrollView>(null);
  // Chips playing their exit, by render key, and the timers that close the row up behind them.
  const [exiting, setExiting] = useState<Record<string, true>>({});
  const exitTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Chips whose add is still being answered (tracking, then the saved-document lookup): their action
  // waits, or a tap would race the add into a second build.
  const [adding, setAdding] = useState<Record<string, true>>({});
  useEffect(() => () => {
    for (const k of Object.keys(exitTimers.current)) clearTimeout(exitTimers.current[k]);
  }, []);
  // A new chip lands at the start of the row, and the user may be scrolled right along it. From an
  // effect, so the insert has committed before the scroll.
  useEffect(() => {
    if (!enter) return;
    const id = setTimeout(() => chipRowRef.current?.scrollTo({ x: 0, animated: true }), 40);
    return () => clearTimeout(id);
  }, [enter]);

  const markAdding = (rk: string, on: boolean) => {
    if (!alive.current) return;
    setAdding((m) => {
      if (on ? m[rk] : !m[rk]) return m;
      const n = { ...m };
      if (on) n[rk] = true; else delete n[rk];
      return n;
    });
  };
  const stopExit = (rk: string) => {
    const timer = exitTimers.current[rk];
    if (timer) { clearTimeout(timer); delete exitTimers.current[rk]; }
    if (!alive.current) return;
    setExiting((m) => {
      if (!m[rk]) return m;
      const n = { ...m };
      delete n[rk];
      return n;
    });
  };

  /** Put a chip row on screen, moving the refs the flows read in the same breath (see targetsRef). */
  const commitTargets = (next: Target[], sel?: number) => {
    targetsRef.current = next;
    setTargets(next);
    if (sel !== undefined) { empIdxRef.current = sel; setEmpIdx(sel); }
  };

  /**
   * The user's own change to the SAVED row (services/homeRoster) — the X, an Undo, an add, a restored posting, a
   * pick. ⚠️ Every flow that changes the row on screen for the user says so here too, or the next load's merge
   * (which only ever keeps or appends) would not know: a removed chip would sit in the saved row until a read
   * showed it hidden, and an Undo'd one would be missing from it. The harness's row lives with the mount; a
   * signed-in one is the account's; with no account read yet nothing is kept.
   */
  const editRow = (fn: (r: Roster) => Roster) => {
    if (live.current.loaders) {
      if (previewRoster.current) previewRoster.current = fn(previewRoster.current);
      return;
    }
    editRoster(cacheOwner, fn).catch(() => {});
  };
  /** The keys on screen in front of a chip — where rosterPlace puts it in the saved row. */
  const keysBefore = (list: Target[], at: number) => list.slice(0, Math.max(0, at)).map((x) => x.key);

  // ⚠️ THE SELECTION IS SAVED WITH THE ROW: a tap, a build the user watched land, a removed chip's neighbour, an
  // add — whatever put a chip on screen, a remount or a relaunch opens on it again. A key the saved row does not
  // keep (a pending add) leaves the saved selection as it was.
  const selKey = targets[empIdx]?.key ?? null;
  useEffect(() => {
    if (selKey) editRow((r) => rosterSelect(r, selKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  /** Put a new chip row on screen and keep the user's pin on the chip it names. */
  const applyTargets = (next: Target[]) => {
    let sel: number | undefined;
    if (pickedKey.current) {
      const j = next.findIndex((x) => x.key === pickedKey.current);
      // Their chip is not in this row: the one now in its place (see load), never the first.
      sel = j >= 0 ? j : Math.max(0, Math.min(empIdxRef.current, next.length - 1));
    }
    commitTargets(next, sel);
  };

  /** Select a chip for the user (a build they watched, a notice they tapped) — pinned, like a tap. */
  const selectAt = (j: number) => {
    const t = targetsRef.current[j];
    if (!t) return;
    acts.current++;
    pickedKey.current = t.key;
    if (j === empIdxRef.current) return;
    empIdxRef.current = j;
    setEmpIdx(j);
    flashReshape();
  };

  /** Bring a build's chip (and its kind of document) on screen, and its overlay unless it already landed. */
  const focusBuild = (k: DocKind, rk: string) => {
    if (k !== kindRef.current) { kindRef.current = k; setMode(modeOfKind(k)); }
    const j = targetsRef.current.findIndex((t) => rkOf(t) === rk);
    if (j >= 0) selectAt(j);
    const b = buildFor(k, rk);
    if (b && b.phase !== 'done') KRef.current.openOverlayFor(k, rk);
  };

  /** Have a chip's document in memory before it is picked, so the pick paints it at once. A read. */
  const prewarmDoc = (k: DocKind, t: Target) => {
    const q = docLookupOf(t);
    const read = docLoadersRef.current?.current || fetchCurrentDoc;
    Promise.resolve()
      .then(() => read(k, q))
      .then((got) => { if (got !== 'error') rememberDoc(k, q, got); })
      .catch(() => {});
  };

  /* ── builds: started, queued, watched and recovered by useHomeBuilds ── */

  /**
   * A build finished. ⚠️ THE SELECTION MOVES ONLY FOR THE USER: to the chip whose build they WATCHED
   * land, or not at all. A build finishing behind another chip used to pull the row onto itself, which
   * yanked the user off the employer they were reading. Its document is read into memory instead, so
   * picking that chip later paints it at once.
   */
  const onLanded = useStableFn((job: HomeBuildJob, docId: number | null, cached: boolean, watched: boolean) => {
    if (!alive.current) return;
    track('home_doc_landed', { kind: job.kind, cached, watched, doc: docId != null });
    // ⚠️ BEFORE THE REFETCH IS ASKED FOR, not after it answers: between the two the chip's held answer is
    // still "nothing saved", and that flashed "Tailor my resume" over a document the user had just bought.
    if (docId != null && job.rk) markLanded(storeKeyOf(job.kind, job.rk), docId);
    setListToken((n) => n + 1);
    // The shelf for the kind on screen is re-read now, outside load()'s throttle (see refreshHistory). A
    // landing of the OTHER kind that moves the screen onto it switches the mode below, and the mode effect
    // reads that kind's shelf; one that does not move the screen changes nothing on the shelf shown.
    if (job.kind === kindRef.current) refreshHistory(modeOfKind(job.kind));
    const list = targetsRef.current;
    const j = list.findIndex((t) => rkOf(t) === job.rk);
    const onScreen = j >= 0 && j === empIdxRef.current && job.kind === kindRef.current;
    if (watched || onScreen) {
      if (job.kind !== kindRef.current) { kindRef.current = job.kind; setMode(modeOfKind(job.kind)); }
      if (j >= 0) selectAt(j);
      setDocToken((n) => n + 1);
      setCardIdx(0);
      flashReshape();
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
      return;
    }
    if (j >= 0) prewarmDoc(job.kind, list[j]);
  });

  const onBuildNotice = useStableFn((text: string, action?: { label: string; kind: DocKind; rk: string }) => {
    if (!alive.current) return;
    showNotice(text, action ? { label: action.label, run: () => focusBuild(action.kind, action.rk) } : undefined, action ? 6500 : 4500);
  });
  const rkForRecovered = useStableFn((meta: InflightMeta) => rkForMeta(meta, targetsRef.current));
  const isAlive = useStableFn(() => alive.current);
  const seePlans = useStableFn(() => { nav()?.push?.('/(subscription)/plans'); });

  const K = useHomeBuilds({
    alive: isAlive,
    rkFor: rkForRecovered,
    onLanded,
    onNotice: onBuildNotice,
    onSeePlans: seePlans,
  });
  const KRef = useRef(K);
  KRef.current = K;

  /** An explicit Tailor / Write / Refresh for the chip on screen — through the gate, like every build. */
  const requestBuild = (why: 'tailor' | 'write' | 'refresh') => {
    const t = targetsRef.current[empIdxRef.current];
    if (!t) return;
    if (loaders) {
      // The harness can OPEN the confirm sheet (loaders.confirm) so it can be looked at — never build.
      const ask = loaders.confirm;
      const k = kindRef.current;
      if (!ask) { Alert.alert('Preview only', 'Building a document needs a signed-in account.'); return; }
      Promise.resolve()
        .then(() => ask(k, t))
        .then((v) => {
          if (!alive.current) return;
          if (v) setPreviewAsk({ ...v, kind: k, company: t.company });
          else Alert.alert('Preview only', 'Building a document needs a signed-in account.');
        })
        .catch(() => {});
      return;
    }
    // ⚠️ A REFRESH REBUILDS THE DOCUMENT'S OWN JOB, NOT THIS DEVICE'S LISTING CACHE (see refreshJobFor):
    // the pasted listing lives in a store that evicts, and a refresh spelled from an evicted one rebuilt
    // the resume WITHOUT the posting — then saved that poorer input as the document's.
    const d = docRef.current;
    const job = why === 'refresh' && d ? refreshJobFor(t, kindRef.current, d) : jobFor(t, kindRef.current);
    try { Haptics.selectionAsync(); } catch {}
    track('home_build_request', { kind: job.kind, why });
    KRef.current.request(job, { explicit: true });
  };

  const openBuilding = useStableFn(() => {
    const rk = selRkRef.current;
    if (rk) KRef.current.openOverlayFor(kindRef.current, rk);
  });

  const openPaper = useStableFn((i: number, rect: OriginRect) => {
    const rk = selRkRef.current;
    const k = kindRef.current;
    // "Tap its card to see why": a build that did not finish explains itself from its card — unless a
    // saved document is on screen, whose pages are worth opening in their own right.
    const b = rk ? buildFor(k, rk) : null;
    if (rk && b && b.phase === 'error' && !docRef.current) { KRef.current.openOverlayFor(k, rk); return; }
    // ⚠️ THESE PAGES ARE NOT THIS CHIP'S PAGES YET (docPending). The deck under a chip whose document is
    // still on its way is the BASE resume — or, for a letter, blank slots — so zooming one opened the base
    // resume's editor and gallery under the employer's name, and a letter's Download had nothing to take.
    // The document is seconds away: say so instead of acting on the stand-in.
    if (docOnItsWay()) { sayLoadingDoc(); return; }
    // ⚠️ A LETTER PAGE WITHOUT ITS LETTER IS A DRAWING. With no saved letter the deck is LETTER_SLOTS (a letter
    // being written, or one that just landed), and a zoom on it offered a Customize and a View PDF with nothing
    // behind them. Say what is happening instead of opening it.
    if (k === 'cover_letter' && !docRef.current) { sayNoLetterYet(); return; }
    setCardIdx(i);
    zoomSeq.current++;
    libOpen.current = 0;
    setZoom({ src: 'hero', i, rect });
    track('home_paper_open', { i, doc: !!docRef.current });
  });

  const onOpenBuildNotice = useStableFn((k: DocKind, rk: string) => {
    track('home_build_notice_open', { kind: k });
    focusBuild(k, rk);
  });

  /* ── the gate, read ahead so the action can say what it costs ── */

  const lookupSig = target ? `${kind}|${JSON.stringify(docLookupOf(target))}` : '';
  // ⚠️ AND NOT WHILE A DOCUMENT IS ON ITS WAY (docPending). A build that has just landed, or a lookup still
  // running for a chip the list says HAS a document, both sit at docState 'none' for a moment — and this is
  // what draws "Tailor my resume" / "Write my cover letter" and reads the gate behind it.
  const wantsAction = !!target && !doc && docState === 'none' && !selBuilding && !noResumeYet && !docPending;
  const [gateHint, setGateHint] = useState<{ sig: string; via: 'plan' | 'free' | 'pass' | 'cache' | 'used' } | null>(null);
  // ⚠️ A DRY RUN: the gate reserves, binds and charges nothing. Debounced so flicking along the chips
  // asks once, and an answer for a chip the user has already left is dropped.
  // ⚠️ …AND IT IS RE-ASKED WHENEVER THE ENTITLEMENTS MAY HAVE MOVED (entRev): on every return to this screen, and
  // on a purchase or Restore the server confirmed. Without it the answer was cached for the life of a chip
  // selection, and a subscriber kept reading "Your allowance is used" until they switched chips.
  useEffect(() => {
    if (loaders || !wantsAction || !lookupSig) return;
    let stale = false;
    const id = setTimeout(async () => {
      const t = targetsRef.current[empIdxRef.current];
      if (!t) return;
      const job = jobFor(t, kindRef.current);
      let g: BuildGate;
      try {
        g = await checkBuildGate(job.company, gateJobFor(job), job.kind, { employerId: job.employerId, country: job.country });
      } catch { return; }
      if (stale || !alive.current) return;
      // ⚠️ NEVER A CREDIT PRICE (2026-09-13): credits pay for no resume or letter, so the gate has no "uses N
      // credits" answer for one — and an answer that somehow still said so gets no line here rather than name
      // a charge the product no longer makes. A used-up allowance says WHICH one at render (isPaid).
      const used = !g.covered && 'reason' in g && (g.reason === 'quota_exhausted' || g.reason === 'regen_limit');
      setGateHint(g.covered ? { sig: lookupSig, via: g.via } : used ? { sig: lookupSig, via: 'used' } : null);
    }, 400);
    return () => { stale = true; clearTimeout(id); };
  }, [lookupSig, wantsAction, loaders, entRev]);
  const hint = gateHint && gateHint.sig === lookupSig ? {
    text: gateHint.via !== 'used'
      ? (gateHint.via === 'free' ? 'Included in your free allowance' : 'Included in your plan')
      // The free allowance is ONE TIME and never comes back; a plan's is this month's.
      : !paidRead ? 'Your allowance is used'
        : isPaid ? 'This month’s plan allowance is used'
          : kind === 'cover_letter' ? 'Your free cover letters are used' : 'Your free resume generations are used',
    warn: gateHint.via === 'used',
  } : null;

  /* ── remove a chip, softly ── */

  /**
   * The X. ⚠️ NO DIALOG: the chip leaves at once, and Undo is on screen for five seconds.
   * ⚠️ SOFT, AND IT KEEPS THE DOCUMENTS: an employer chip is untracked (archived for this user), a posting
   * chip is only hidden from Home (the posting row is shared, never ours to delete). Adding the employer
   * again brings its saved resume and letter straight back, with no AI call.
   * ⚠️ A BUILD ALREADY RUNNING FOR IT IS LEFT TO FINISH: it is paid for, and nothing can stop the job on the
   * server anyway. Only a build still waiting in line is cancelled.
   */
  const removeChip = (i: number) => {
    const t = targetsRef.current[i];
    if (!t) return;
    const rk = rkOf(t);
    if (exitTimers.current[rk]) return;
    const posting = t.key.startsWith('job_');
    const pending = t.key.startsWith(PENDING);
    try { Haptics.selectionAsync(); } catch {}
    track('home_chip_remove', { what: posting ? 'posting' : pending ? 'adding' : 'employer' });
    KRef.current.cancelQueued('resume', rk);
    KRef.current.cancelQueued('cover_letter', rk);
    const r: Removal = {
      t, rk, at: i, addedAt: addedEmployers.findIndex((a) => a.key === t.key),
      server: null, trackedAs: null, undone: false,
      madeAt: Date.now(), gen: accountGen, noticeId: null,
    };
    removedKeys.set(t.key, Date.now() + REMOVED_HOLD_MS);
    addedEmployers = addedEmployers.filter((a) => a.key !== t.key);
    // Out of the saved row NOW, not when the exit has played: a remount inside the exit clears its timer, and the
    // next mount would paint the chip the user just removed. Its place closes up and is never refilled.
    editRow((ro) => rosterRemove(ro, t.key));
    if (pending) {
      // Tracking has not answered: the add flow untracks it when it does (removedAdds).
      removedAdds.set(rk, r);
    } else if (loaders) {
      // ⚠️ With `loaders` a removal never touches the network: one the harness did not supply succeeds
      // locally, so Remove → Undo can be exercised signed-out.
      r.server = Promise.resolve(loaders.remove ? loaders.remove(t) : true).then((ok) => !!ok, () => false);
    } else if (posting) {
      r.server = hideTarget(t.key).catch(() => false);
    } else if (t.employerId) {
      r.server = untrackEmployer(String(t.employerId)).catch(() => false);
    }
    // ⚠️ THE REGISTRY, SO A RE-ADD CAN WAIT FOR THIS (see liveRemovals / addEmployerHere). Adding the
    // employer again while this untrack is still in flight used to send the track straight away — two
    // requests racing, and the untrack landing second left the re-added employer untracked on the server.
    removals = [...liveRemovals(), r];
    r.server?.then((ok) => { if (!ok) failRemoval(r); });
    setExiting((m) => ({ ...m, [rk]: true }));
    exitTimers.current[rk] = setTimeout(() => dropChip(rk), EXIT_MS);
    r.noticeId = showNotice(`Removed ${t.company}`, { label: 'Undo', run: () => undoRemoval(r) }, UNDO_MS);
  };
  const onRemoveChip = useStableFn((i: number) => removeChip(i));

  /** The exit has played: close the row up, keeping the selection on the chip the user was on. */
  const dropChip = (rk: string) => {
    delete exitTimers.current[rk];
    // The saved row loses it even when this screen has gone (an Undo the server refused can answer after that).
    const leaving = targetsRef.current.find((x) => rkOf(x) === rk);
    if (leaving) editRow((ro) => rosterRemove(ro, leaving.key));
    if (!alive.current) return;
    setExiting((m) => {
      if (!m[rk]) return m;
      const n = { ...m };
      delete n[rk];
      return n;
    });
    const list = targetsRef.current;
    const idx = list.findIndex((x) => rkOf(x) === rk);
    if (idx < 0) return;
    const gone = list[idx];
    const next = list.filter((_, j) => j !== idx);
    const cur = empIdxRef.current;
    // Removing the selected chip lands on the one that slid into its place (or the new last one).
    const sel = Math.max(0, idx < cur ? cur - 1 : idx === cur ? Math.min(idx, next.length - 1) : cur);
    if (pickedKey.current === gone.key) pickedKey.current = next[sel]?.key ?? null;
    renderKeyOf.delete(gone.key);
    commitTargets(next, sel);
  };

  /** Put a removed chip back where it was — as `as` when tracking gave it a new identity meanwhile. */
  const restoreChip = (r: Removal, as?: Target) => {
    const t = as || r.t;
    stopExit(r.rk);
    // Same render key as before, so the chip — and any build keyed on it — is the same chip again.
    if (t.key !== r.rk) renderKeyOf.set(t.key, r.rk);
    if (r.addedAt >= 0 && !addedEmployers.some((a) => a.key === t.key)) {
      LOCAL.add(t);
      addedEmployers = [...addedEmployers.slice(0, r.addedAt), t, ...addedEmployers.slice(r.addedAt)].slice(0, 8);
    }
    // ⚠️ BACK INTO THE SAVED ROW, IN ITS OLD PLACE, WITH A HOLD. The un-hide / re-track is sent only after the
    // removal it undoes has settled, so a load in between still reads the chip as hidden or untracked — the hold
    // is what keeps that read from taking it away again. Under the identity tracking gave it (`as`), the server's
    // own copy replaces this one once it is read (provisional).
    {
      const shownNow = targetsRef.current;
      const i0 = shownNow.findIndex((x) => rkOf(x) === r.rk);
      const front = keysBefore(shownNow, i0 >= 0 ? i0 : Math.min(Math.max(0, r.at), shownNow.length));
      editRow((ro) => rosterPlace(ro, t, { after: front, replaces: r.t.key, hold: true, provisional: !!as }));
    }
    if (!alive.current) return;
    const list = targetsRef.current;
    const idx = list.findIndex((x) => rkOf(x) === r.rk);
    if (idx >= 0) {
      // Undo inside the exit: the chip never left the row.
      if (as && list[idx] !== as) commitTargets(list.map((x, j) => (j === idx ? as : x)));
      return;
    }
    const at = Math.min(Math.max(0, r.at), list.length);
    const cur = empIdxRef.current;
    commitTargets([...list.slice(0, at), t, ...list.slice(at)], list.length && at <= cur ? cur + 1 : cur);
  };

  /** The server would not remove it: it comes back, and says so. */
  const failRemoval = (r: Removal) => {
    if (r.undone) return;
    r.undone = true;   // nothing left to undo — the server never removed it
    removedKeys.delete(r.t.key);
    restoreChip(r);
    // Its Undo goes with it: the chip is already back, so the line would offer to do what just happened.
    dismissNotice(r.noticeId);
    r.noticeId = null;
    if (alive.current) showNotice(`We could not remove ${r.t.company} just now. Please try again.`);
  };

  /**
   * Undo. The chip is back at once; the server is told only after the removal it is undoing has
   * settled, so the two requests can never arrive in the wrong order and leave the employer removed.
   */
  const undoRemoval = (r: Removal) => {
    // ⚠️ AND NOT ACROSS AN ACCOUNT SWITCH. The notice (and its closure over this removal) outlives the wipe
    // that logout does to everything else here, and tracking again would put the previous account's
    // employer on this one's Home — under this one's session.
    if (r.undone || r.gen !== accountGen) return;
    r.undone = true;
    track('home_chip_remove_undo', {});
    // ⚠️ dismissNotice, not setNotice(null): notices that queued behind this Undo (a build finishing, a
    // failed track) are still waiting, and clearing the line without draining them would lose them all.
    dismissNotice(r.noticeId);
    r.noticeId = null;
    removedKeys.delete(r.t.key);
    removedAdds.delete(r.rk);
    const back = r.trackedAs || r.t;
    removedKeys.delete(back.key);
    restoreChip(r, r.trackedAs || undefined);
    // Still being added (tracking has not answered): the add flow simply carries on.
    if (!r.server) return;
    r.server.then(async (removedThere) => {
      if (!removedThere) return;
      const ok = loaders
        // Signed-out harness: the un-hide never touches the network either (see the X above).
        ? await Promise.resolve(loaders.unhide ? loaders.unhide(back) : true).then((x) => !!x, () => false)
        : back.key.startsWith('job_')
          ? await unhideTarget(back.key).catch(() => false)
          : await trackEmployer({ name: back.company, website: String(back.website || '') }).then((x) => x.ok, () => false);
      if (!ok && alive.current) {
        // The server kept it removed: the chip leaves again rather than pretend.
        removedKeys.set(back.key, Date.now() + REMOVED_HOLD_MS);
        addedEmployers = addedEmployers.filter((a) => a.key !== back.key);
        dropChip(r.rk);
        showNotice(`We could not bring ${back.company} back. Add it again from “Add employer”.`);
      }
    });
  };

  /* ── add an employer, and build for it, without leaving Home ── */

  /** A refused session: the module cache is this account's no longer, and nothing more is built. */
  const dropAccountOnAuth = () => {
    forgetAccountCache();
    cacheOwner = null;
    pickedKey.current = null;
    if (!alive.current) return;
    setTargets((ts) => ts.filter((t) => !t.key.startsWith(PENDING)));
    // Everything on the line — and everything waiting behind it — belonged to the refused session,
    // including Undos that would track that account's employers under the next one.
    clearNotices();
    showNotice('Please sign in again to add employers.');
  };

  /**
   * An employer added again after its POSTING chips were removed.
   *
   * ⚠️ ITS SAVED WORK COMES BACK RATHER THAN BEING BOUGHT AGAIN. Removing a posting chip only HIDES it —
   * every document it has is kept — but a hidden chip is never spelled as a lookup, so the add's own
   * employer-level lookup answered "nothing saved" and started a fresh, PAID build whose chip then
   * vanished behind the very same hide. So the saved list is read for this employer, the hidden postings
   * that have a document are un-hidden, and the newest comes back selected. NOTHING IS BUILT on this path.
   *
   * ⚠️ RUNS ONLY AFTER the employer-level document (job_url '') has been looked for and not found: that one
   * belongs to the chip already on screen, and it is the preferred answer.
   *
   * True when something came back — the add then stands its build down.
   */
  const restorePostings = async (real: Target, k: DocKind): Promise<boolean> => {
    const readList = docLoadersRef.current?.list || fetchDocList;
    let list: DocListItem[] | null = null;
    try { list = await readList(k); } catch { list = null; }
    if (!list || !list.length) return false;
    const id = real.employerId ? String(real.employerId) : null;
    // Newest first, as the list comes. Matched the way the server matches: the employer id OR the name.
    const mine = list.filter((d) => !!d && !!String(d.jobUrl || '').trim()
      && ((id && d.employerId && String(d.employerId) === id) || sameEmployerName(d.employer, real.company)));
    if (!mine.length) return false;
    // ⚠️ ONLY CHIPS THIS USER ACTUALLY HID: un-hiding a posting they never removed would put a chip on the
    // row they did not ask for. null = the server would not say, which is not "none" — fall back to what
    // this screen removed (which is also the signed-out harness's only honest answer).
    const server = loaders ? null : await fetchHiddenKeys().catch(() => null);
    const hidden = new Set(server || [...removedKeys.keys()].filter(removedNow));
    const wanted = mine.filter((d) => hidden.has(jobKeyForUrl(d.jobUrl))).slice(0, PREWARM_MAX);
    if (!wanted.length) return false;
    const back: string[] = [];
    const backChips: Target[] = [];
    for (const d of wanted) {
      // ⚠️ jobKeyForUrl, never a hand-rolled spelling: a key spelled any other way names a chip that never
      // appears, and the hide it is meant to lift stays where it is.
      const key = jobKeyForUrl(d.jobUrl);
      const posting: Target = { ...real, key, jobId: null, applyUrl: d.jobUrl, jobUrl: d.jobUrl, role: d.jobTitle || '' };
      const ok = loaders
        ? await Promise.resolve(loaders.unhide ? loaders.unhide(posting) : true).then((x) => !!x, () => false)
        : await unhideTarget(key).catch(() => false);
      if (!ok) continue;
      removedKeys.delete(key);
      back.push(key);
      backChips.push(posting);
    }
    if (!back.length) return false;
    // ⚠️ INTO THE SAVED ROW BEFORE THE READ, right behind the employer's own chip. The saved row never refills from
    // the ranking — an old posting no longer counts as new — so a restored posting that waited for the read to
    // bring it back would never come back at all. Held, so a read made before the un-hide landed cannot take it
    // away; provisional, so the server's own chip for that posting replaces this stand-in once it is read.
    {
      const shownNow = targetsRef.current;
      const at = shownNow.findIndex((x) => x.key === real.key);
      let front = keysBefore(shownNow, at >= 0 ? at + 1 : 0);
      for (const p of backChips) {
        // A posting chip carries no employer site (the dashboard's never do), so its lookup is spelled the same.
        const chip: Target = { ...p, website: null };
        const after = front;
        editRow((ro) => rosterPlace(ro, chip, { after, hold: true, provisional: true }));
        front = [...front, chip.key];
      }
    }
    // The row is read again so the restored postings arrive as the server's own chips, and the newest one
    // is the chip on screen. ⚠️ A READ. Nothing on this path spends anything.
    const got = await load(true).catch(() => undefined);
    if (!alive.current) return true;
    const now = got?.targets || targetsRef.current;
    let j = now.findIndex((x) => x.key === back[0]);
    if (j < 0) j = now.findIndex((x) => back.includes(x.key));
    if (j >= 0) selectAt(j);
    track('home_add_restored', { kind: k, postings: back.length });
    showNotice(back.length > 1
      ? `Your saved ${real.company} ${nounOf(k)}s are back`
      : `Your ${real.company} ${nounOf(k)} is saved — here it is`);
    return true;
  };

  /**
   * The pick from AddEmployerSheet. ⚠️ No navigation: the user asked to STAY on the page they were
   * designing on. The chip is optimistic — it is on screen before the server has heard of it.
   *
   * ⚠️ RESTORE BEFORE BUILD. Once tracking answers, the employer's saved document (in the current mode's
   * kind) is looked up first: an employer added again after its chip was removed gets its resume back
   * as it was — no AI call, no gate, no charge. Only when nothing is saved does the build go to
   * useHomeBuilds, which reads the gate before anything is spent (and no credit ever is, on a generation).
   * ⚠️ THE NAME THE USER PICKED WINS. The server answers with this user's display name for the
   * employer (a shared employers row can carry whatever a job ingest named that domain), so the chip,
   * the lookup and the build all use it.
   */
  const addEmployerHere = (value: string, extra: EmployerPick) => {
    const website = String(extra?.website || value || '').trim();
    const host = hostOf(website);
    const name = String(extra?.name || '').trim() || host || 'Employer';
    const jobUrl = extra?.jobUrl || undefined;
    const jobText = extra?.jobText || undefined;
    // Where the posting is, when the sheet knows it — it steers the design ranking's region. Never guessed.
    const country = String(extra?.country || '').trim() || null;
    const pending: Target = {
      key: PENDING + (host || name.toLowerCase()), jobId: null, employerId: null,
      company: name, website, role: '', match: null, country,
      // By code point: charAt(0) of an emoji-led name is half an emoji (homeRoster keeps the letter in the saved row).
      initial: (Array.from(name)[0] || '').toUpperCase() || '?', colors: gradFor(name), skills: [],
    };
    // Adding it again IS the answer to an earlier removal: nothing about that removal holds any more.
    // ⚠️ AND THE CHIPS IT REMOVED COME BACK OFF THE "removed" LIST TOO, or the next load would filter out
    // the very employer the user just re-added.
    removedKeys.delete(pending.key);
    const answering = removalsFor(name, website);
    for (const r of answering) {
      r.undone = true;
      dismissNotice(r.noticeId);
      r.noticeId = null;
      removedAdds.delete(r.rk);
      // ⚠️ A POSTING's key STAYS on the removed list until its hide is really lifted (restorePostings):
      // dropping it here would put the chip back on the row while the server still hides it, and the very
      // next load would take it away again. It is also how restorePostings knows which chips to ask for
      // when the server will not say what is hidden.
      if (r.t.key.startsWith('job_')) continue;
      removedKeys.delete(r.t.key);
      if (r.trackedAs) removedKeys.delete(r.trackedAs.key);
    }
    rememberAdded(pending);
    const next = mergeAdded(targetsRef.current, pickedKey);
    const rk = rkOf(next[0]);
    removedAdds.delete(rk);
    stopExit(rk);
    pickedKey.current = next[0].key;
    commitTargets(next, 0);
    setEnter((e) => ({ key: rk, n: (e?.n || 0) + 1 }));
    try { Haptics.selectionAsync(); } catch {}
    const k = kindRef.current;
    const t0 = Date.now();
    markAdding(rk, true);

    // ⚠️ A RE-ADD WAITS FOR THE REMOVAL IT ANSWERS, exactly as Undo does. Sent straight away, the track and
    // the untrack it answers were two requests racing — and an untrack landing second left the employer the
    // user had just re-added untracked on the server, with its chip gone again at the next load. The
    // removal's answer is not read; only its ORDER matters.
    const sequenced = answering.length
      ? answering.reduce<Promise<unknown>>((p, r) => p.then(() => settledOf(r)), Promise.resolve())
      : null;
    // Tracking is NOT required to build: a failed track keeps the chip, under the typed name, for this
    // session and says so. A refused SESSION is different — that builds nothing.
    const tracked: Promise<Target | null> = (sequenced
      ? sequenced.then(() => trackEmployer({ name, website }))
      : trackEmployer({ name, website })).then(async (r) => {
      if (r.ok) {
        const e = r.employer;
        const real: Target = {
          ...pending, key: 'emp_' + e.employerId, employerId: e.employerId, company: e.name || name,
          website: e.website || website, colors: e.logoColor,
          // The server's letter is name[0] — half of an emoji-led name — so it is taken only when it is whole.
          initial: e.logoInitial && !/[\uD800-\uDFFF]/.test(e.logoInitial) ? e.logoInitial : pending.initial,
        };
        removedKeys.delete(real.key);
        const gone = removedAdds.get(rk);
        if (gone) {
          // Removed while tracking ran. The user no longer wants it, so it does not stay tracked either;
          // Undo tracks it again.
          removedAdds.delete(rk);
          gone.trackedAs = real;
          gone.server = loaders
            ? Promise.resolve(loaders.remove ? loaders.remove(real) : true).then((ok) => !!ok, () => false)
            : untrackEmployer(e.employerId).catch(() => false);
          return null;
        }
        rememberAdded(real, pending.key);
        if (pickedKey.current === pending.key) pickedKey.current = real.key;
        if (alive.current) applyTargets(mergeAdded(targetsRef.current, pickedKey));
        // ⚠️ INTO THE SAVED ROW, where it stands on screen (the front), the moment it HAS an identity — a pending
        // chip is never kept. Held, so a dashboard read made before the track landed cannot drop it; provisional,
        // so the dashboard's own copy of the employer takes over its snapshot once (as mergeAdded's swap does).
        {
          const shownNow = targetsRef.current;
          const at = shownNow.findIndex((x) => x.key === real.key || x.key === pending.key);
          editRow((ro) => rosterPlace(ro, real, { after: keysBefore(shownNow, at), replaces: pending.key, hold: true, provisional: true }));
        }
        return real;
      }
      // ⚠️ The auth middleware answers an expired token with 403, which the service reports as 'network';
      // one look at the session on that failure path is what tells the two apart.
      if (r.reason === 'auth' || (r.reason === 'network' && (await sessionRejected()))) { dropAccountOnAuth(); return null; }
      if (alive.current) {
        showNotice(r.reason === 'limit' || r.reason === 'invalid'
          ? r.message
          : `We could not save ${name} to your employers yet — it stays here for now.`);
      }
      if (removedAdds.has(rk)) { removedAdds.delete(rk); return null; }
      // ⚠️ A website the server refused (a job board or ATS host that is not this employer's) is not
      // handed to the build: the generator would research the job board as the employer. ⚠️ AND IT IS
      // TAKEN OFF THE CHIP TOO: the chip's lookup and its build must spell the target identically, or the
      // document the build saves reads as stale forever.
      if (r.reason === 'invalid') {
        const refused: Target = { ...pending, website: '' };
        rememberAdded(refused, pending.key);
        if (alive.current) applyTargets(mergeAdded(targetsRef.current, pickedKey));
        return refused;
      }
      return pending;
    }).catch(() => (removedAdds.has(rk) ? null : pending));

    // Tracking → the listing → the saved-document lookup. Resolves to the job to build, or null when nothing
    // may be built: the session was refused, the chip was removed, or a document for this employer is
    // already saved (and was put on screen instead).
    const chain: Promise<HomeBuildJob | null> = (async () => {
      const real = await tracked;
      // The listing rides with the target under the SAME name and site the build uses — and it must be
      // stored BEFORE the target is spelled for the lookup and the build, which both read it
      // (docLookupOf). Sequential: both writes rewrite the same storage key, and in parallel the second
      // would drop the first.
      if (real && (jobUrl || jobText)) {
        await savePendingListing(real.company, { jobUrl, jobText })
          .then(() => savePendingListing(String(real.website || ''), { jobUrl, jobText }))
          .catch(() => {});
      }
      if (!real || !alive.current || removedAdds.has(rk) || removedNow(real.key)) return null;
      const q = docLookupOf(real);
      let saved: DocMeta | null | 'error' = 'error';
      try { saved = await (docLoadersRef.current?.current || fetchCurrentDoc)(k, q); } catch { saved = 'error'; }
      if (!alive.current || removedAdds.has(rk) || removedNow(real.key)) return null;
      if (saved && saved !== 'error') {
        rememberDoc(k, q, saved);
        const j = targetsRef.current.findIndex((x) => rkOf(x) === rk);
        if (j >= 0) selectAt(j);
        track('home_add_restored', { kind: k });
        showNotice(`Your ${real.company} ${nounOf(k)} is saved — here it is`);
        return null;
      }
      // Nothing saved for the EMPLOYER — but its postings may each have a document, hidden with their chips
      // when the user removed them. Bringing those back is what stops a re-add paying for work twice.
      let restored = false;
      try { restored = await restorePostings(real, k); } catch { restored = false; }
      if (restored || !alive.current || removedAdds.has(rk) || removedNow(real.key)) return null;
      // ⚠️ A lookup that could not answer ('error') is not "nothing saved" — but it is safe to go on: the
      // gate knows the saved documents too, and a cache hit is free and never touches billing.
      return jobFor(real, k);
    })().catch(() => null);

    // ⚠️ NEVER A SILENT WAIT. Tracking and the lookup are usually well inside the chip's hold, and then the
    // build is asked for once they have answered — a restored document never flashes a build that is not
    // happening. When they are slow, the build is asked for at the end of the hold WITH the chain still
    // running (`named`): the chip, its cards and the overlay say "Checking…" instead of nothing, and the
    // chain's null stands the request down if a saved document turns up after all.
    let settled = false;
    let asked = false;
    const early = setTimeout(() => {
      if (settled || !alive.current || removedAdds.has(rk) || exitTimers.current[rk]) return;
      // Only for a chip still on the row: a removed one has nothing to check (and the chain says null).
      const now = targetsRef.current.find((x) => rkOf(x) === rk);
      if (!now || removedNow(now.key)) return;
      asked = true;
      KRef.current.request(jobFor(now, k), { explicit: true, holdMs: 0, named: chain });
    }, HOLD_MS);
    chain.then((job) => {
      settled = true;
      clearTimeout(early);
      if (asked || !job || !alive.current) return;
      // `holdMs` lets the new chip land and glow BEFORE a full-screen overlay or a dialog covers it — the
      // user asked for "go to that card, THEN build". Tracking and the lookup already spent part of it.
      KRef.current.request(job, { explicit: true, holdMs: Math.max(0, HOLD_MS - (Date.now() - t0)), named: Promise.resolve(job) });
    }).finally(() => markAdding(rk, false));
  };

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    try { Haptics.selectionAsync(); } catch {}
    track('home_mode', { mode: m });
  };

  /** Someone with no resume yet: the builder makes one first — nothing on Home can be rewritten. */
  const buildYoursFirst = () => {
    track('home_sample_build', { hasTarget: !!target, from: mode });
    armBuilderFor(target).finally(() => nav()?.push?.('/(resume-builder)'));
  };

  /**
   * A saved cover letter, to the letter picker — a letter page's View PDF. ⚠️ THE PICKER READS ITS LETTER
   * FROM STORAGE, so the saved letter is fetched and written there first — and a write that failed stops
   * here, or the picker would open on whichever letter was stored before this one.
   * `forDoc` is the letter a LIBRARY card belongs to; left out, it is the letter on screen.
   */
  const openLetterPicker = async (templateId?: string, forDoc?: ZoomDoc | null) => {
    const d: ZoomDoc | null = forDoc !== undefined ? forDoc : docRef.current;
    if (!d || d.kind !== 'cover_letter') {
      // ⚠️ NEVER A SILENT NO-OP. While the saved letter was still being fetched this returned without a
      // word — a button that does nothing reads as a broken button, not as "not yet". Nor while it is still
      // being written, or not written at all: sayNoLetterYet.
      if (docOnItsWay()) sayLoadingDoc();
      else sayNoLetterYet();
      return;
    }
    track('home_letter_download', { id: templateId, from: forDoc !== undefined ? 'library' : 'hero' });
    if (loaders) { Alert.alert('Preview only', 'Downloading needs a signed-in account.'); return; }
    const full = await fetchDoc(d.docId);
    if (full === 'gone') {
      Alert.alert('That letter is gone', `Write your ${d.employer} cover letter again to download it.`);
      // Whichever list named it is out of date: the chip's lookup when it is the letter on screen, and the
      // saved list the library matches against either way.
      if (docRef.current && docRef.current.docId === d.docId) reloadDoc();
      setListToken((n) => n + 1);
      return;
    }
    const p = full && full.payload;
    if (!full || !p || typeof p.coverLetterHtml !== 'string' || !p.coverLetterHtml) {
      Alert.alert('Could not open your letter', 'Please try again.');
      return;
    }
    try {
      await AsyncStorage.setItem('coverLetterPickerContext', JSON.stringify({
        coverLetterHtml: p.coverLetterHtml,
        companyName: p.companyName || full.employer,
        companyAddress: p.companyAddress || '',
        employer: full.employer,
        docId: full.docId,
      }));
    } catch {
      Alert.alert('Could not open your letter', 'Please try again.');
      return;
    }
    nav()?.push?.({
      pathname: '/(cover-letter)/templates',
      params: { ...(templateId ? { template: templateId } : {}), docId: String(full.docId) },
    });
  };

  /**
   * A saved cover letter, to its editor — a letter page's Customize. app/(cover-letter)/edit loads the letter
   * by id, edits its subject and paragraphs and saves them back to THAT letter. ⚠️ Nothing is stored first and
   * nothing is written by the AI: this is the letter's counterpart of the resume's section editor, and it
   * never spends a generation. `forDoc` as in openLetterPicker.
   */
  const openLetterEditor = (forDoc?: ZoomDoc | null) => {
    const d: ZoomDoc | null = forDoc !== undefined ? forDoc : docRef.current;
    if (!d || d.kind !== 'cover_letter') {
      if (docOnItsWay()) sayLoadingDoc();
      else sayNoLetterYet();
      return;
    }
    track('home_letter_customize', { from: forDoc !== undefined ? 'library' : 'hero' });
    if (loaders) { Alert.alert('Preview only', 'Editing a letter needs a signed-in account.'); return; }
    nav()?.push?.({ pathname: '/(cover-letter)/edit', params: { docId: String(d.docId) } });
  };

  /**
   * A resume page's Customize — ONE door for a hero page and a library card, so the two cannot drift apart.
   * `d` is the saved employer document the page is a design of (null = the base resume); `target` is whose
   * page it is — the chip on screen, or the library row's employer; `sample` = the pages are a stand-in.
   * ⚠️ Straight to the section editor. Writing 'resume_builder_entry' with autoBuild, or
   * 'resumeBuilderAction', would arm a PAID regeneration — neither is touched.
   * ⚠️ `from: 'home'` on BOTH shapes: the editor's Back returns here, never to the builder's "Tell us your story"
   * (preview.tsx leave() — the owner's report, 2026-09-19).
   */
  const customizeResume = (d: ZoomDoc | null, target: BuilderFor | undefined, sample: boolean) => {
    // A saved employer document is edited AS that document: the editor loads it by id and saves
    // back to it, so the base resume — and every other employer's version — is left alone.
    if (d && d.kind === 'resume') {
      rememberBuilderEmployer(d.employer || target?.company)
        .finally(() => nav()?.push?.({ pathname: '/(resume-builder)/preview', params: { docId: String(d.docId), from: 'home' } }));
      return;
    }
    if (sample) armBuilderFor(target).finally(() => nav()?.push?.('/(resume-builder)'));
    // Not armBuilderFor: writing 'resume_builder_entry' here would arm a PAID regeneration.
    // Only the employer hint travels, so the editor's download can name the company.
    else rememberBuilderEmployer(target?.company).finally(() => nav()?.push?.({ pathname: '/(resume-builder)/preview', params: { from: 'home' } }));
  };

  /**
   * A resume page's View PDF — the gallery ON the design tapped, one door for the hero and the library.
   * The employer travels too: a download pass is bought PER EMPLOYER, so without this the payment would
   * have nothing to attach to. A saved document also carries its id, and names the employer it was saved
   * (and is billed) under.
   */
  const openResumeGallery = (id: string | undefined, d: ZoomDoc | null, target: BuilderFor | undefined) => {
    nav()?.push?.({
      pathname: '/(resume-builder)/templates',
      params: {
        ...(id ? { template: id } : {}),
        ...(target?.company ? { employer: target.company } : {}),
        ...(d ? { docId: String(d.docId), ...(d.employer ? { employer: d.employer } : {}) } : {}),
      },
    });
  };

  /* ── the library: a card opens the page, never the file ── */

  /**
   * A library card, tapped.
   *
   * ⚠️ IT NEVER DOWNLOADS (the product owner's call, 2026-09-13). It opens the SAME zoom a hero page opens,
   * whose Customize and View PDF go through the same doors the hero's do (customizeResume, openResumeGallery,
   * openLetterEditor, openLetterPicker) — so a download happens from View PDF, gate and paywall included,
   * exactly as it does from the hero.
   *
   * WHICH PAGE: the design the row was downloaded in, of that employer's SAVED document when one exists
   * (savedDocFor) — painted at once from a page already in hand, then filled from that document's own cards
   * endpoint. With nothing saved, a resume is the base resume in that design (thumbFor, or one page for this
   * one tap); a cover letter has no page anywhere but a saved letter, so it falls back to getting the file
   * again — what a tap always did — and says so.
   * ⚠️ A SAVED LIST THAT COULD NOT BE READ IS NOT "NOTHING SAVED": opening the base resume under an employer
   * whose own version exists would put the wrong document behind Customize. It says so and opens nothing.
   */
  const openHistoryItem = useStableFn(async (item: DownloadHistoryItem, origin: OriginRect | null) => {
    const k: DocKind = item.kind === 'cover_letter' ? 'cover_letter' : 'resume';
    const n = ++zoomSeq.current;
    const who = String(item.employer || '').trim();
    track('home_history_open', { kind: k, unlocked: item.unlocked });
    // That kind's saved documents: the list already in hand when it is the kind on screen, else one read.
    let list: DocListItem[] | null = k === kindRef.current ? docListRef.current : null;
    if (!list) {
      const read = docLoadersRef.current?.list || fetchDocList;
      try { list = await read(k); } catch { list = null; }
      // Another card, or a hero page, was opened while this one was being looked up.
      if (n !== zoomSeq.current || !alive.current) return;
    }
    if (!list) {
      showNotice(`We couldn’t open ${who ? `your ${who} ${nounOf(k)}` : `that ${nounOf(k)}`} just now. Please try again.`);
      return;
    }
    const saved = who ? savedDocFor(list, who) : null;
    // The catalogue accent — replaced by the employer's brand below when the document on screen is this one.
    let accent = accentFor(item.templateId);

    if (!saved) {
      if (k === 'cover_letter') {
        // Nothing to preview. The file is still theirs: the same fetch (or, locked, the same sheet) as ever.
        // A file already on its way (its row spins) is not asked for twice, and not announced twice either.
        if (againId != null) return;
        track('home_history_letter_file', { unlocked: item.unlocked });
        showNotice(`No saved ${who ? `${who} ` : ''}letter to preview${item.unlocked ? ' — getting your file' : ''}`, undefined, 3500);
        if (item.unlocked) doAgain(item);
        else { againItem.current = null; setPayFor(item.employer || null); }
        return;
      }
      libOpen.current = n;
      setZoom({
        src: 'library', n, rect: origin, kind: k, doc: null, employer: who, sample,
        card: { id: item.templateId, name: item.templateName, accent, image: thumbFor(item.templateId) || null, fit: null },
      });
      fillBasePage(n, item.templateId);
      return;
    }

    const zd: ZoomDoc = { docId: saved.docId, kind: k, employer: saved.employer || who };
    // A page already in hand, in the order the card itself was painted from (imageFor): the deck on screen
    // when it IS this document, then the document image cache the deck fills and the shelf warm tops up,
    // then a page the library kept from an earlier open. ⚠️ The cache is consulted HERE, not only in imageFor:
    // a warmed card that skipped it opened on a blank page and asked the serial renderer for the very page
    // it was already wearing — one extra chromium render per tap, on the front door.
    const onScreen = docRef.current && docRef.current.docId === saved.docId ? docRef.current : null;
    const onDeck = onScreen ? docDeckRef.current.find((c) => c.id === item.templateId) || null : null;
    const kept = libPages.get(libPageKey(k, saved, item.templateId)) || null;
    const image = (onDeck && onDeck.image)
      || cachedDocImage(k, saved.docId, saved.updatedAt, item.templateId)
      || (kept && kept.image) || null;
    const fit = onDeck && onDeck.fit != null ? onDeck.fit
      : kept && kept.fit != null ? kept.fit
        : saved.topId === item.templateId ? saved.topScore : null;
    // The document on screen was recoloured to the employer's brand, and its deck tints with it (brandAccentFor
    // for the shelf's own card): the zoomed card wears the same, so it never changes colour on the way open.
    const brand = onScreen ? onScreen.design?.brand?.accent : null;
    if (brand) accent = brand;
    libOpen.current = n;
    setZoom({
      src: 'library', n, rect: origin, kind: k, doc: zd, employer: zd.employer, sample: false,
      card: {
        id: item.templateId, name: item.templateName, accent, image, fit,
        reason: (onDeck && onDeck.reason) || (kept && kept.reason) || null,
      },
    });
    // ⚠️ Never with no design id: the cards endpoint answers an empty id list with its own pick of pages —
    // several renders on the serial renderer for one tap.
    if (!image && item.templateId) fillDocPage(n, k, saved, item.templateId);
  });

  /**
   * A library page of a saved document, from that document's own cards endpoint — queued behind any other
   * library page (libFill), and skipped when nobody is looking at it any more.
   */
  const fillDocPage = (n: number, k: DocKind, saved: DocListItem, templateId: string) => {
    const readCards = docLoadersRef.current?.cards || fetchDocCards;
    libFill.current = libFill.current.then(async () => {
      if (libOpen.current !== n || !alive.current) return;
      let got: { cards: DocCard[] } | 'gone' | null = null;
      try { got = await readCards(k, saved.docId, [templateId]); } catch { got = null; }
      if (!alive.current) return;
      // No longer saved: the list the card was matched against is out of date. The page is left as it is —
      // Customize and View PDF each say "gone" on their own screen, from the server, rather than guess here.
      if (got === 'gone') { setListToken((x) => x + 1); return; }
      const c = got && Array.isArray(got.cards) ? got.cards.find((x) => !!x && x.id === templateId) : undefined;
      if (!c) return;
      if (c.image) keepLibPage(libPageKey(k, saved, templateId), { image: c.image, fit: c.fit ?? null, reason: c.reason ?? null });
      setZoom((z) => (z && z.src === 'library' && z.n === n
        ? {
          ...z,
          card: {
            ...z.card, image: c.image || z.card.image || null,
            fit: c.fit != null ? c.fit : z.card.fit ?? null, reason: c.reason || z.card.reason || null,
          },
        }
        : z));
    }).catch(() => {});
  };

  /**
   * The BASE resume's page in one design, for a library card with no saved document behind it.
   * ⚠️ ONE PAGE, FOR ONE TAP, AND NEVER BESIDE A HYDRATION WAVE: it takes the base hydrator's own
   * single-flight mutex (and waits for nothing — a wave in flight means no page for now), so the two can never
   * put two renders on the serial renderer at once. A design that will not render is dead, as it is to the
   * hydrator. The harness never reaches the network from here.
   * ⚠️ A HELD MUTEX IS "LATER", NOT "NEVER". It used to return and nothing retried, so a card tapped while a
   * wave was out opened on a blank page for good. Now the page is parked in basePending (the latest open
   * replaces an older one), and whoever releases the mutex knocks; it runs only if open `n` is still the
   * library page on screen — a closed or replaced sheet costs no render.
   */
  const fillBasePage = (n: number, templateId: string) => {
    if (loaders || noResume || !templateId || thumbFor(templateId) || dead.current[templateId]) return;
    if (hydrating.current) { basePending.current = { n, templateId }; return; }
    hydrating.current = true;
    fetchHomeCards([templateId])
      .then((got) => {
        const c = got && got !== 'none' ? got.cards.find((x) => x.id === templateId) : undefined;
        if (c && c.image) {
          const image = c.image;
          if (alive.current) setShots((prev) => ({ ...prev, [templateId]: image }));
        } else {
          dead.current[templateId] = true;
        }
      })
      .catch(() => { dead.current[templateId] = true; })
      .finally(() => {
        hydrating.current = false;
        // A hydrator run that found the mutex held returned without scheduling another: knock once. And a
        // library card tapped while this page was out is parked — knock for it too.
        if (alive.current) {
          if (basePending.current) setBaseKnock((x) => x + 1);
          setHydrateNudge((x) => x + 1);
        }
      });
  };

  // The parked library page, run after the render that followed the mutex's release — so thumbFor reads the
  // shots that wave just added (a page it brought is not rendered twice). ⚠️ The hydrator's own re-run waits
  // 260ms before it looks at the mutex, so the page the user is looking at takes it first.
  useEffect(() => {
    const p = basePending.current;
    if (!p || hydrating.current) return;   // still held: its release knocks again
    basePending.current = null;
    if (libOpen.current !== p.n || !alive.current) return;   // that sheet was closed or replaced
    fillBasePage(p.n, p.templateId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKnock]);

  // What the letter panel's one button does for the chip on screen. ⚠️ Every branch is a tap the user
  // makes; none of them starts anything on its own.
  const letterAction: { label: string; busy?: boolean; run: () => void } = !target
    ? { label: 'Choose an employer', run: () => setAddOpen(true) }
    : noResumeYet
      ? { label: 'Build your resume first', run: buildYoursFirst }
      // ⚠️ THE ERROR IS TESTED BEFORE THE BUSY LABEL, as on the resume side. docPending is true for the
      // whole of LANDED_WAIT_MS whatever the lookup said, so a build that landed with a doc id whose
      // refetch then failed sat on a dead "Looking for your saved letter…" for ~15s with no way back.
      : docState === 'error'
        ? { label: 'Couldn’t check your saved letters — try again', run: reloadDoc }
        : (selRk && adding[selRk]) || docState === 'loading' || docPending
          ? { label: 'Looking for your saved letter…', busy: true, run: () => {} }
          : { label: `Write my cover letter for ${target.company}`, run: () => requestBuild('write') };

  // What the zoom shows (see Zoom): a hero page read from the deck on screen, or a library card's own page —
  // whose BASE resume image is read here at render, so it appears the moment Home has it.
  const libZoom = zoom && zoom.src === 'library' ? zoom : null;
  const zoomCard: PaperCard | null = !zoom ? null
    : zoom.src === 'hero' ? (shown ? shown.cards[zoom.i] || null : null)
      : { ...zoom.card, image: zoom.card.image || (!zoom.doc && zoom.kind === 'resume' ? thumbFor(zoom.card.id) || null : null) };

  const headline = mode === 'resume' ? 'Design your resume' : 'Write your cover letter';
  const accent = mode === 'resume' ? 'exclusively for the employer.' : 'for this exact posting.';

  const headerH = insets.top + 52;
  /**
   * ⚠️ THE PAGE RUNS UNDER THE HOME INDICATOR (2026-09-18: "why there is a bottom white small area on the
   * home page"). HomeScreen wraps this screen in a SafeAreaView with the BOTTOM edge on (it drops only the
   * top one for Home), so the last `insets.bottom` points of the screen — the home-indicator strip, 34pt
   * on a Face ID iPhone — were that wrapper's padding, painted in its light app background: a pale band
   * under the floating menu, and a hard stop for the page above it (the Tailor button, blue into violet,
   * was sliced off right there, so its two ends peeked out either side of the menu like a stray shape).
   * The fix is here, not in the wrapper: the scroll view hangs `footBleed` below this root, into that
   * padding (overflow is visible, the strip is inside the wrapper's own bounds), so the page — gradient,
   * cards and all — runs to the very bottom edge and scrolls on under the menu and the indicator.
   * Three things keep the rest of the screen exactly where it was:
   *   • the root's own box does NOT move, so rootH, the fold (FOLD_ALLOW) and the Tailor hint's geometry —
   *     all measured from the top — are untouched, and so is the menu (HomeScreen pins it to the screen's
   *     bottom, which never moved);
   *   • the stage is at least the viewport PLUS the strip (stageMinH), so even a short page leaves no gap
   *     in it — for a long page the spacer below is already inside pageH, so nothing is counted twice;
   *   • a `footBleed` spacer under the tail keeps the page's END where it was: scrolled to the bottom, the
   *     last line still rests 108pt above the old edge, clear of the menu.
   * The scroll view paints E.stage behind its content, so a bounce past the foot shows the stage colour in
   * the strip too, never the wrapper's grey. ⚠️ COUPLED TO HomeScreen's `edges` (test-employer-home pins
   * both): if that wrapper ever stops padding the bottom for Home, this bleed must go with it, or the page
   * would hang off the screen by the same amount.
   */
  const footBleed = insets.bottom;
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
  // The stage never ends above the screen's bottom edge — the viewport now reaches into the strip (footBleed).
  const stageMinH = Math.max(stageH, (rootH || 700) + footBleed);
  // ⚠️ CAPPED AT 0.82. While the deck is still loading the page is barely taller than the
  // viewport, so the ratio runs to ~0.95 and the teal wash — which sits at three quarters of
  // the colour — lands in the middle of the first screen and turns it green for a second.
  const focus = pageH ? Math.max(0.18, Math.min(0.82, (headerH + heroH) / stageH)) : 0.75;
  const gridRows = Math.ceil(stageH / 30) + 2;

  /**
   * ── THE TAILOR HINT: whether, where, and what a tap does ──
   * Only for the chip's ONE action — the resume's Tailor button under the base deck, or the letter panel's
   * Write button — exactly when that action is what is drawn (wantsAction, not being added, not building, no
   * document). ⚠️ AND ONLY WHILE THE BUTTON IS BELOW THE FOLD: a button already on screen needs no pointer,
   * and one the user has scrolled to once (hintSeen) is found — the hint does not come back to nag.
   */
  const actionShown = !!target && wantsAction && !(selRk && adding[selRk]);
  const hintKind: DocKind | null = !actionShown || loading ? null
    : mode === 'resume' ? (shown && !noResume ? 'resume' : null)
      : (!shown ? 'cover_letter' : null);
  const hintSig = hintKind && selRk ? `${hintKind}|${selRk}` : '';
  const foldY = (rootH || 0) - FOLD_ALLOW;
  const slotTop = headerH + paperY + slotY;
  // The bottom of the button itself, in content space. The letter's Write button closes its panel (18pt of
  // padding below it, and a one-line gate hint when there is one).
  const ctaBottom = hintKind === 'resume'
    ? (tailorH > 0 ? headerH + paperY + tailorY + TAILOR_BTN_H : 0)
    : hintKind === 'cover_letter' && slotH > 0 ? slotTop + slotH - 18 - (hint ? 20 : 0) : 0;
  const hintOn = !!hintSig && !hintSeen[hintSig] && rootH > 0 && slotH > 0 && ctaBottom > 0
    && ctaBottom - scrollTop.current > foldY;
  hintGeo.current = hintSig && ctaBottom > 0 ? { sig: hintSig, ctaBottom, foldY } : null;
  // Over the LOWER part of the page, or just above the letter's button — and never under the fold itself, or
  // on a short phone the pointer would be as hidden as the button.
  // ⚠️ ITS BOTTOM STOPS ABOVE THE PAGE'S ZOOM BUTTON, FROM THE MEASURED HEIGHT (review, 2026-09-15). It was
  // placed from slotH − 36 − 64 − 22: a 64pt GUESS measured up from under the dots. The real pill is 70-100pt
  // (the phrase wraps on a narrow phone, text size grows it), so it hung onto the zoom button — which sits
  // AFFORDANCE.inset in from the page's bottom-right and is horizontally under the pill at every width — and
  // took its taps. Now: the page's zoom-button top (pager padding + page height − inset − size), less the
  // pill's reach past its box (hitSlop/halo/pulse/overshoot) and a visible gap, less the MEASURED height.
  //   320pt: card 192 → page 271 → button top 249 → pill (4 lines ≈ 86) top ≈ 145, over a page spanning 10-281.
  //   430pt: card 252 → page 356 → button top 334 → pill (≈ 70-86) top ≈ 230-246, over a page spanning 10-366.
  // Both land in the page's lower half, clear of the ribbon/fit pills at its head and the dots under it.
  const deckPageH = Math.round(cardWidthFor(slotW) * DECK_PAGE_RATIO);
  const zoomBtnTop = DECK_PAD_TOP + deckPageH - AFFORDANCE.inset - AFFORDANCE.size;
  const hintTop = Math.max(8, Math.min(
    hintKind === 'cover_letter'
      ? slotH - 18 - 50 - 18 - TAILOR_HINT_REACH - hintH
      : zoomBtnTop - HINT_ZOOM_GAP - TAILOR_HINT_REACH - hintH,
    foldY - slotTop - hintH - 24,
  ));
  /** The pill reports its laid-out height; whole points, and no re-render for sub-point jitter. */
  const onHintHeight = useStableFn((h: number) => {
    const r = Math.ceil(h);
    if (r > 0) setHintH((o) => (o === r ? o : r));
  });
  const hintFade = useMemo(
    () => scrollY.interpolate({ inputRange: [0, HINT_FADE_PX], outputRange: [1, 0], extrapolate: 'clamp' }),
    [scrollY],
  );
  /** The page came to rest: if the button is now in view, the hint for that chip has done its job. */
  const onScrollRest = useStableFn((e: { nativeEvent: { contentOffset: { y: number } } }) => {
    const y = e?.nativeEvent?.contentOffset?.y;
    if (typeof y !== 'number') return;
    scrollTop.current = y;
    const g = hintGeo.current;
    if (g && g.ctaBottom - y <= g.foldY) setHintSeen((m) => (m[g.sig] ? m : { ...m, [g.sig]: true }));
  });
  /** A tap on the hint: bring the button up into view. ⚠️ A scroll — it never calls requestBuild. */
  const onHintPress = useStableFn(() => {
    const g = hintGeo.current;
    if (!g) return;
    try { Haptics.selectionAsync(); } catch {}
    track('home_tailor_hint_tap', { kind: kindRef.current });
    const y = Math.max(0, g.ctaBottom - g.foldY + 28);
    scrollRef.current?.scrollTo?.({ y, animated: true });
    scrollTop.current = y;
    setHintSeen((m) => (m[g.sig] ? m : { ...m, [g.sig]: true }));
  });

  return (
    <View style={s.root} onLayout={(e) => setRootH(e.nativeEvent.layout.height)} onTouchStart={noteTouch}>
      <Animated.ScrollView
        ref={scrollRef}
        style={[s.scroll, { marginBottom: -footBleed }]}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
        // Where the page RESTS, for the Tailor hint — two events per gesture, not one per frame.
        onScrollEndDrag={onScrollRest}
        onMomentumScrollEnd={onScrollRest}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={E.blue} progressViewOffset={headerH} />}
      >
      {/* ────────────────── ONE GRADIENT, THE WHOLE PAGE ────────────────── */}
      <MeshStage style={{ minHeight: stageMinH, paddingTop: headerH }} focus={focus} rows={gridRows}>
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
          {/* ⚠️ THE ADD ACTION RIDES THE LABEL'S ROW. It used to be the LAST chip, so with a full row it sat
              off-screen to the right — the one place nobody looks for the thing they came to do. */}
          {/* ⚠️ IT HAS TO SURVIVE THE LARGEST TEXT SIZE ON A 320pt PHONE. At full accessibility scale the
              uppercase label and the pill together were wider than the screen, and with the pill pushed to
              the right end the thing the user came to do went off the edge. The label gives way (it is the
              quiet half), the pill grows in HEIGHT rather than width, and its label is capped. */}
          <View style={s.forRow}>
            <Text style={s.eyebrowDark} numberOfLines={1}>Designing for</Text>
            {(loading || targets.length > 0) && (
              <TouchableOpacity
                style={s.addPill}
                activeOpacity={0.85}
                hitSlop={8}
                accessibilityRole="button"
                onPress={() => { track('home_add_employer_open', { from: 'header' }); setAddOpen(true); }}
              >
                <Ionicons name="add" size={14} color="#fff" />
                <Text style={s.addPillTx} numberOfLines={1} maxFontSizeMultiplier={1.3}>Add employer</Text>
              </TouchableOpacity>
            )}
          </View>
          {/* The saved row paints before the network answers (load's early paint), so a row in hand is shown
              even while loading — the skeleton is only for a row we do not have yet. */}
          {loading && !targets.length ? (
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
                    onRemove={onRemoveChip}
                    kind={kind}
                    rk={rk}
                    hasDoc={docRks.has(rk) || (i === empIdx && !!doc)}
                    exiting={!!exiting[rk]}
                  />
                );
              })}
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
          {/* Non-blocking: a failed track, a removal's Undo or a finished background build is worth a
              line, never a dialog. */}
          {!!notice && (
            <TouchableOpacity
              style={s.addNotice}
              activeOpacity={notice.action ? 0.7 : 1}
              disabled={!notice.action}
              onPress={() => notice.action?.run()}
              accessibilityRole={notice.action ? 'button' : undefined}
              accessibilityLabel={notice.action ? `${notice.text} · ${notice.action.label}` : undefined}
              // ⚠️ Undo is the ONLY way back for a removed chip and it lives on a 15pt line: without this
              // its real target is about half the 44pt minimum. The slop costs no layout.
              hitSlop={{ top: 14, bottom: 14, left: 10, right: 10 }}
            >
              <Ionicons name="information-circle" size={13} color={E.mint} />
              <Text style={s.addNoticeTx} numberOfLines={2}>
                {notice.text}
                {notice.action ? ' · ' : ''}
                {!!notice.action && <Text style={s.noticeAct}>{notice.action.label}</Text>}
              </Text>
            </TouchableOpacity>
          )}
          <BuildNotice onOpen={onOpenBuildNotice} />
        </View>

        {/* the paper */}
        <View style={{ paddingTop: 10 }} onLayout={(e) => setPaperY(Math.round(e.nativeEvent.layout.y))}>
          {/* The slot: whatever stands for the page (the deck, the letter panel, a loading state), measured so the
              Tailor hint can sit over its lower half. ⚠️ A plain View — full width, no style — so the carousel's
              own width measurement and the panel's margins are exactly what they were. */}
          <View
            onLayout={(e) => {
              setSlotY(Math.round(e.nativeEvent.layout.y));
              setSlotH(Math.round(e.nativeEvent.layout.height));
              setSlotW(Math.round(e.nativeEvent.layout.width));
            }}
          >
          {mode === 'letter' && !shown ? (
            <LetterPanel
              company={target?.company}
              action={letterAction.label}
              busy={letterAction.busy}
              hint={target && wantsAction && hint ? hint.text : null}
              warn={!!hint?.warn}
              onWrite={() => {
                track('home_letter_write', { hasTarget: !!target });
                letterAction.run();
              }}
            />
          ) : mode === 'resume' && noResume ? (
            <NoResume onBuild={() => {
              AsyncStorage.setItem('resume_builder_entry', JSON.stringify({ from: 'home_employer', autoBuild: true })).catch(() => {});
              nav()?.push?.('/(resume-builder)');
            }} />
          ) : shown ? (
            <PaperCarousel
              cards={shown.cards}
              index={cardIdx}
              onIndex={setCardIdx}
              ribbon={target ? { letter: target.initial, short: target.company, colors: target.colors } : null}
              onOpen={openPaper}
              building={buildingProp}
              onOpenBuilding={openBuilding}
              showFit={shown.fit}
            />
          ) : selBuilding ? (
            <TouchableOpacity style={s.paperLoading} activeOpacity={0.8} onPress={openBuilding}>
              <ActivityIndicator color="#fff" />
              <Text style={s.paperFailTx}>Writing your {target?.company} {nounOf(kind)}</Text>
              <Text style={s.paperFailSub}>Tap to watch</Text>
            </TouchableOpacity>
          ) : loadFailed ? (
            <TouchableOpacity style={s.paperLoading} activeOpacity={0.8} onPress={() => load(true)}>
              <Ionicons name="cloud-offline-outline" size={22} color="rgba(255,255,255,0.5)" />
              <Text style={s.paperFailTx}>Couldn't load your designs</Text>
              <Text style={s.paperFailSub}>Tap to retry</Text>
            </TouchableOpacity>
          ) : (
            /* ⚠️ A BARE SPINNER SAYS NOTHING (2026-09-20). This is what a brand-new account looks at while the
               deck is on its way — the owner's "the loader was taking time" — and it was the one state here
               with no words on it, unlike its two siblings above. */
            <View style={s.paperLoading}>
              <ActivityIndicator color="#fff" />
              <Text style={s.paperFailTx}>Getting your designs ready</Text>
              <Text style={s.paperFailSub}>This takes a moment the first time</Text>
            </View>
          )}
          {/* Keyed by chip + kind: another chip is another company, so the entrance plays again for it. */}
          {hintOn && hintKind && !!target && (
            <TailorHint
              key={hintSig}
              kind={hintKind}
              company={target.company}
              onPress={onHintPress}
              fade={hintFade}
              onHeight={onHintHeight}
              style={{ top: hintTop }}
            />
          )}
          </View>

          {/* caption */}
          {(mode === 'resume' || !!doc || selBuilding) && (
          <View style={s.caption}>
            {reshaping ? (
              <View style={s.rowCenter}>
                <Ionicons name="sparkles" size={12} color="#C4BBFF" />
                <Text style={s.captionScan}> Reshaping for {target?.company || 'this employer'}…</Text>
              </View>
            ) : selBuilding ? (
              <View style={s.rowCenter}>
                <Ionicons name="create" size={12} color="#C4BBFF" />
                <Text style={s.captionScan} numberOfLines={1}> Writing your {target?.company || 'employer'} {nounOf(kind)}…</Text>
              </View>
            ) : doc ? (
              <View style={s.rowCenter}>
                <Text style={[s.captionName, s.captionShrink]} numberOfLines={1}>{card?.name || `Your ${nounOf(kind)}`}</Text>
                <View style={s.capDot} />
                <Text style={s.captionMeta} numberOfLines={1}>
                  {card?.fit != null
                    ? `${card.fit}% fit for ${target?.company || doc.employer}`
                    : `For ${target?.company || doc.employer}`}
                </Text>
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
          {/* Why the top design fits this employer — the ranking's own sentence. */}
          {!!doc?.design?.headline && !reshaping && !selBuilding && (
            <Text style={s.docHeadline} numberOfLines={2}>{doc.design.headline}</Text>
          )}

          {/* ⚠️ THE ONLY WAYS A BUILD STARTS FROM HERE ARE TAPS. A chip with nothing saved offers one
              action; a saved document the resume has since moved past offers a Refresh. Both go
              through useHomeBuilds, which reads the gate before anything is spent — and no credit
              pays for a generation; a used-up allowance is the plans screen. */}
          {mode === 'resume' && !!target && !doc && !selBuilding && !noResumeYet && (
            wantsAction && !(selRk && adding[selRk]) ? (
              // Measured for the Tailor hint (where "in view" is), and nothing else.
              <View
                onLayout={(e) => {
                  setTailorY(Math.round(e.nativeEvent.layout.y));
                  setTailorH(Math.round(e.nativeEvent.layout.height));
                }}
              >
                <TailorAction
                  label={`Tailor my resume for ${target.company}`}
                  hint={hint ? hint.text : null}
                  warn={!!hint?.warn}
                  onPress={() => requestBuild('tailor')}
                />
              </View>
            ) : docState === 'error' ? (
              <TouchableOpacity style={s.docPill} activeOpacity={0.8} onPress={reloadDoc} accessibilityRole="button" hitSlop={7}>
                <Ionicons name="cloud-offline-outline" size={12} color="rgba(255,255,255,0.7)" />
                <Text style={s.docPillTx} numberOfLines={1}>
                  Couldn’t check for a saved resume · <Text style={s.docPillAct}>Try again</Text>
                </Text>
              </TouchableOpacity>
            ) : null
          )}
          {!!doc && doc.stale && !selBuilding && (
            <TouchableOpacity style={s.docPill} activeOpacity={0.8} onPress={() => requestBuild('refresh')} accessibilityRole="button" hitSlop={7}>
              <Ionicons name="refresh" size={12} color={E.mint} />
              <Text style={s.docPillTx} numberOfLines={1}>
                Your {nounOf(kind)} changed since this version · <Text style={s.docPillAct}>Refresh</Text>
              </Text>
            </TouchableOpacity>
          )}

          {/* ⚠️ INSIDE MeshStage ON PURPOSE. stageH = rootH * 1.18, so the hero is taller than the
              viewport and anything placed after </MeshStage> is below the fold on first paint —
              a CTA that has to be seen "right below the slider" cannot live down there. */}
          {!!setup && (() => {
            // ⚠️ AN UNFINISHED WIZARD IS THE SERVER'S FACT, NOT THIS SCREEN'S GUESS (2026-09-19). The owner's words:
            // "that option should always be there till the time he either finish it using make my resume or complete
            // the profile by going to the account settings". It used to be derived from the four file/field booleans
            // alone, so once every file was on disk the button turned into "Customize your resume" over an EMPTY
            // résumé — after a restart, on every device. `setup.wizard` (server/services/onboardingProgress.js) is
            // 'open' until a wizard build is charged and saved ('finished') or Account Settings completes the profile
            // ('closed'); while it is open this is "Pick up where you left off" on BOTH tabs, even if setup.complete.
            const wz = setup.wizard || null;
            // ⚠️ NAME WHAT IS ACTUALLY LEFT. `setup` carries four real booleans from the server, so
            // saying "Make yours" to someone who finished two steps last week tells them their work
            // is gone. In wizard order, so the sentence matches the screens they will see. An open wizard names its
            // own list — the skips it stored, and "building your resume".
            // ⚠️ ONCE THE PROFILE IS COMPLETE THIS DOOR IS THE EDITOR, NOT THE WIZARD. The wizard used to
            // stay the destination for a finished profile too ("rebuilding from fresh notes is a thing
            // people do repeatedly") — but with a document per employer, what a finished profile wants
            // from this button is to change the words, and the editor opens on the employer's OWN
            // version when the chip on screen has one. "Edit details" at the top still reaches the builder.
            // A wizard FINISHED by its build counts as complete (its photo / signature may have been skipped); an OPEN
            // one never does. An account with no wizard row keeps the old rule. The rule itself is makeYoursOf —
            // pure, in services/profileSetupService, so a test runs it.
            const { complete, started, left } = makeYoursOf(setup);
            // ⚠️ ON THE COVER LETTER TAB A FINISHED PROFILE'S DOOR IS THE LETTER'S EDITOR. This block used to ignore
            // `mode`: it read "Customize your resume" under a cover letter, and a tap opened the RESUME editor (the
            // owner's report, 2026-09-19). A letter is customized only when there is one — the saved letter on
            // screen, or one seconds away (docPending: the tap says "Loading your saved version…") — and never
            // while one is being written. With neither, the letter panel's Write is the door: nothing here may
            // start a generation. The unfinished wizard stays the same on both tabs — the profile is one profile.
            const letterTab = mode === 'letter';
            if (complete && letterTab && (selBuilding || (!doc && !docPending))) return null;
            const resumeDoc: DocMeta | null = mode === 'resume'
              ? doc
              : (target ? cachedCurrentDoc('resume', docLookupOf(target)) || null : null);
            // ⚠️ AND IT IS MINT, NOT BLUE. The finished state used to be a glass pill, which on a
            // blue-violet hero is the one thing on the screen you cannot see. Every other surface
            // here is blue or violet, so the only colour that can carry a call to action is the
            // one that is not: the mint already in the LIVE pill and at the end of the headline's
            // sweep. Dark ink on a bright fill, rather than white on mid-blue, is what makes it
            // read from across the room. Weight still varies — the glow, not the colour — so a
            // finished profile gets a quieter version of the same button instead of a hidden one.
            const sub = complete
              ? (letterTab
                ? (doc ? `Edit your ${doc.employer} letter — its subject, address and every paragraph.` : 'Loading your saved letter…')
                : resumeDoc ? `Edit your ${resumeDoc.employer} version — every design above follows.` : 'Edit any section — every design above follows.')
              : !started
                ? 'A few details and we will build your real resume into every design above.'
                : left.length === 0
                  ? 'New notes, a fresh resume — into every design above.'
                  : left.length === 1
                    ? `One thing left — ${left[0]}.`
                    : `${left.length} things left — ${left.slice(0, -1).join(', ')} and ${left[left.length - 1]}.`;
            // "Make your Resume" names the DESTINATION — the wizard that makes one — not a claim
            // that you have not got one. Someone mid-way gets the more useful sentence instead.
            // "Customize my Cover Letter" is the owner's own wording for the letter's door.
            const label = complete
              ? (letterTab ? 'Customize my Cover Letter' : 'Customize your resume')
              : left.length && started ? 'Pick up where you left off' : 'Make your Resume';
            const go = () => {
              try { Haptics.selectionAsync(); } catch {}
              track('home_make_yours', { has: [setup.profile && 'p', setup.photo && 'i', setup.signature && 's', setup.resume && 'r'].filter(Boolean).join(''), complete, doc: letterTab ? !!doc : !!resumeDoc, mode, wizard: wz ? wz.state : 'none', step: wz ? wz.stepKey : '' });
              if (complete && letterTab) {
                // The letter on screen, in ITS editor — the zoom's Customize door, so the two cannot drift apart.
                // Editing a saved letter never spends a generation; a letter still on its way says so.
                openLetterEditor();
                return;
              }
              if (complete) {
                // ⚠️ Straight to the section editor — never 'resume_builder_entry' / 'resumeBuilderAction',
                // which arm a PAID regeneration. The employer rides along for the editor's own download, and
                // `from: 'home'` brings Back here (customizeResume).
                rememberBuilderEmployer(resumeDoc?.employer || target?.company).finally(() => nav()?.push?.({
                  pathname: '/(resume-builder)/preview',
                  params: resumeDoc ? { docId: String(resumeDoc.docId), from: 'home' } : { from: 'home' },
                }));
                return;
              }
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
                    <Ionicons name={complete ? 'create' : 'sparkles'} size={16} color={MAKE_INK} />
                    <Text style={s.makeTx} numberOfLines={1}>{label}</Text>
                    <Ionicons name="arrow-forward" size={15} color="rgba(4,33,28,0.6)" />
                  </LinearGradient>
                </TouchableOpacity>
                <Text style={s.makeSub} numberOfLines={2}>{sub}</Text>
              </>
            );
          })()}

          {/* ⚠️ NEVER WHILE THE DECK IS STALE (2026-09-20 review). `sample` is only rewritten when the cards commit,
              so on the reload that follows a build it is still the answer from BEFORE it — and for the account
              building its first résumé that answer is "this is a sample". The first screen after "Your resume is
              ready" would then read "This is a sample … Build yours", over blank skeleton pages, with a tap that
              arms the builder for ANOTHER build. The deck's own honesty flag decides this line too. */}
          {sample && !deckStale && mode === 'resume' && !doc && (
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
          what they have already paid for, and can have again — a shelf of paper cards, each
          wearing the page it is a download of (imageFor: in hand or drawn, never fetched here).
          ⚠️ A card OPENS its page (openHistoryItem) — the hero's zoom, Customize and View PDF — and
          never downloads on the tap. */}
      <View style={s.library}>
      <DownloadHistory
        mode={mode}
        items={history}
        loading={histLoading}
        expanded={histOpen}
        busyId={againId}
        imageFor={imageFor}
        accentFor={accentFor}
        brandAccentFor={brandAccentFor}
        onOpen={openHistoryItem}
        onExpand={() => { try { Haptics.selectionAsync(); } catch {} setHistOpen(true); }}
        onScrollToTop={() => { scrollTop.current = 0; scrollRef.current?.scrollTo?.({ y: 0, animated: true }); }}
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
      {/* …and the home-indicator strip the scroll view now runs under (footBleed), so the page ends where it did. */}
      <View style={{ height: footBleed }} />
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

      {/* the page, full size, with the only things you can do with a design */}
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
          track('home_add_employer_pick', { listing: hasListing, mode });
          // ⚠️ NO NAVIGATION. This used to push to the Job Hub with addCompany, and the user was
          // walked off the page they were designing on. The add, the chip and the build all happen
          // here now; the pasted listing goes straight to the build (and to device storage for the
          // section editor), never through a route param.
          addEmployerHere(value, extra);
        }}
      />

      {/* Mounted as a SIBLING of the scroll view, never inside the hero: its own tree, so whatever
          driver it animates with never meets the hero's native one. Its state is useHomeBuilds'.
          ⚠️ `buildKey` is overlay.key — storeKeyOf(kind, rk), the SAME key the chip's line and the
          carousel's card hand to useCreepPct. Without it the overlay's % seeds at the current stage's
          ceiling, so tapping a chip creeping at 24% opened a screen reading ~38% for the one build. */}
      <BuildingOverlay
        visible={K.overlay.visible}
        kind={K.overlay.kind}
        company={K.overlay.company}
        stage={K.overlay.stage}
        done={K.overlay.done}
        error={K.overlay.error}
        buildKey={K.overlay.key || undefined}
        onDismiss={K.dismissOverlay}
        onRetry={K.overlay.canRetry ? K.retryOverlay : undefined}
        onSeePlans={K.overlay.error && (K.overlay.error.reason === 'quota_exhausted' || K.overlay.error.reason === 'regen_limit')
          ? () => { K.dismissOverlay(); nav()?.push?.('/(subscription)/plans'); }
          : undefined}
        // Which allowance a refusal names when the server's sentence does not: a plan's month, or the free one.
        isPaid={isPaid}
      />

      {/* ⚠️ THE QUESTION BEFORE ANY SPEND (2026-09-14). Tailor, Write, Refresh and the Add auto-build all land
          here first unless the document is already built (a cache hit is free and skips it): what tailoring
          does, how many generations are left, Continue / Cancel — and with none left, the $0.99 one-time pass
          for THIS employer or the plans. Its whole state is useHomeBuilds' (K.confirm); Continue is what starts
          the build, and the overlay above takes over from there. A sibling, like the overlay: its own tree.
          The harness's copy (previewAsk) can be opened and closed, and can do nothing else. */}
      <GenerateConfirmSheet
        {...(previewAsk ? {
          visible: true,
          mode: previewAsk.mode,
          kind: previewAsk.kind,
          company: previewAsk.company,
          usage: previewAsk.usage,
          pass: previewAsk.pass,
          busy: false,
          error: null,
          onContinue: () => { setPreviewAsk(null); Alert.alert('Preview only', 'Building a document needs a signed-in account.'); },
          onCancel: () => setPreviewAsk(null),
          onBuyOnce: () => { setPreviewAsk(null); Alert.alert('Preview only', 'Buying the one-time pass needs a signed-in account.'); },
          onSeePlans: () => { setPreviewAsk(null); nav()?.push?.('/(subscription)/plans'); },
        } : K.confirm)}
      />

      {/* ⚠️ The SAME sheet a first download offers. A row goes locked when the plan that paid for it
          has ended, and the honest answer to that is the two ways to pay — not an error dialog. It opens
          from here only where a library card has nothing to preview (a letter with no saved letter) or a
          re-download the server refused; every other card's download goes through View PDF.
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

      {/* One sheet for both doors to a page: a hero page (by index into the deck on screen) and a library
          card (its own page — see Zoom). Customize and View PDF go through the SAME functions from either,
          for a resume and a cover letter alike. ⚠️ The handlers read the zoom captured at render: the sheet
          calls them 200ms after it has started closing, when `zoom` is already null again. */}
      <PaperZoom
        card={zoomCard}
        origin={zoom?.rect || null}
        kind={libZoom ? libZoom.kind : kind}
        subtitle={libZoom
          ? (libZoom.employer ? `${libZoom.doc ? 'Designed' : 'Downloaded'} for ${libZoom.employer}` : undefined)
          : target ? `Designed for ${target.company}` : undefined}
        isPaid={isPaid}
        sample={libZoom ? libZoom.sample : sample && !doc && kind === 'resume'}
        onClose={() => { libOpen.current = 0; setZoom(null); }}
        onCustomize={() => {
          if (libZoom) {
            track('home_customize', { mode: modeOfKind(libZoom.kind), sample: libZoom.sample, doc: !!libZoom.doc, from: 'library' });
            if (libZoom.kind === 'cover_letter') openLetterEditor(libZoom.doc);
            else customizeResume(libZoom.doc, { company: libZoom.employer, role: '' }, libZoom.sample);
            return;
          }
          track('home_customize', { mode, sample, doc: !!doc });
          if (kind === 'cover_letter') { openLetterEditor(); return; }
          customizeResume(doc, target, sample);
        }}
        onViewPdf={() => {
          const id = zoomCard ? zoomCard.id : undefined;
          if (libZoom) {
            if (libZoom.kind === 'cover_letter') { openLetterPicker(id, libZoom.doc); return; }
            track('home_view_pdf', { id, doc: !!libZoom.doc, from: 'library' });
            openResumeGallery(id, libZoom.doc, { company: libZoom.employer, role: '' });
            return;
          }
          if (kind === 'cover_letter') { openLetterPicker(id); return; }
          track('home_view_pdf', { id, doc: !!doc });
          openResumeGallery(id, doc, target);
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

/**
 * The newest build that is actually running, as ONE string — so this line re-renders when a different
 * build starts or the last one ends, and never on a stage tick.
 */
function runningBuildSig(): string {
  const all = getBuilds();
  let best: { kind: DocKind; rk: string; company: string; startedAt: number } | null = null;
  for (const key of Object.keys(all)) {
    const b = all[key];
    if (b && b.phase === 'building' && (!best || b.startedAt > best.startedAt)) best = b;
  }
  return best ? `${best.kind}${best.rk}${best.company}` : '';
}

/**
 * "Building your X resume · tap its card to watch" — for as long as ANY build runs, not a few seconds:
 * a build kept going in the background is otherwise invisible from every chip but its own.
 * ⚠️ ISOLATED + MEMOISED: it subscribes to the build store itself, so Home never re-renders for it.
 */
const BuildNotice = React.memo(function BuildNotice({ onOpen }: { onOpen: (kind: DocKind, rk: string) => void }) {
  const sig = useSyncExternalStore(subscribeBuilds, runningBuildSig, runningBuildSig);
  if (!sig) return null;
  const [k, rk, company] = sig.split('');
  const kind: DocKind = k === 'cover_letter' ? 'cover_letter' : 'resume';
  return (
    <TouchableOpacity style={s.addNotice} activeOpacity={0.7} onPress={() => onOpen(kind, rk)} accessibilityRole="button">
      <Ionicons name="hourglass-outline" size={13} color={E.mint} />
      <Text style={s.addNoticeTx} numberOfLines={2}>Building your {company} {nounOf(kind)} · tap its card to watch</Text>
    </TouchableOpacity>
  );
});

// ⚠️ A LETTER IS NEVER WRITTEN ON ITS OWN. Generation spends the cover-letter quota, and auto-spending on
// screen entry is the exact mistake the letters auto-regen drain was. So a chip with no saved letter
// shows the formats by name and ONE explicit action; once a letter is saved for the employer, Home shows
// its pages instead (a PaperCarousel of these formats, ranked for that employer).
function LetterPanel({ company, action, busy, hint, warn, onWrite }: {
  company?: string; action: string; busy?: boolean; hint?: string | null; warn?: boolean; onWrite: () => void;
}) {
  return (
    <View style={s.letterPanel}>
      <View style={s.letterIcon}><Ionicons name="mail-open-outline" size={24} color={E.mint} /></View>
      <Text style={s.letterTitle} numberOfLines={2}>
        {company ? `Write a cover letter for ${company}` : 'Write a cover letter'}
      </Text>
      <Text style={s.letterSub} numberOfLines={3}>
        Written for this employer from your resume, then ranked across these {LETTER_DESIGNS.length} formats — best fit first.
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
      <TouchableOpacity onPress={onWrite} activeOpacity={0.9} disabled={busy} style={{ marginTop: 16 }} accessibilityRole="button">
        <LinearGradient colors={[E.teal, E.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[s.letterBtn, busy && s.btnBusy]}>
          <Ionicons name={busy ? 'hourglass-outline' : 'create'} size={16} color="#fff" />
          <Text style={s.letterBtnTx} numberOfLines={1}>{action}</Text>
        </LinearGradient>
      </TouchableOpacity>
      {!!hint && <Text style={[s.actionHint, warn && s.actionHintWarn]} numberOfLines={1}>{hint}</Text>}
    </View>
  );
}

/** "Tailor my resume for X" — the one explicit way a chip with nothing saved gets its own resume. */
function TailorAction({ label, hint, warn, onPress }: {
  label: string; hint?: string | null; warn?: boolean; onPress: () => void;
}) {
  return (
    <View style={s.tailorBox}>
      <TouchableOpacity style={s.tailorWrap} activeOpacity={0.9} onPress={onPress} accessibilityRole="button">
        <LinearGradient colors={[E.blue, E.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.tailorBtn}>
          <Ionicons name="color-wand" size={16} color="#fff" />
          <Text style={s.tailorTx} numberOfLines={1}>{label}</Text>
        </LinearGradient>
      </TouchableOpacity>
      {!!hint && <Text style={[s.actionHint, warn && s.actionHintWarn]} numberOfLines={1}>{hint}</Text>}
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
  // The page's scroll view: it paints the stage colour itself because it reaches PAST the root (footBleed),
  // so a bounce at the foot shows the stage in the home-indicator strip, not the wrapper behind it.
  scroll: { flex: 1, backgroundColor: E.stage },
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

  // The label and the add action, one row: the label on the left, the pill on the right.
  forRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8, gap: 12 },
  // flexShrink: at accessibility text sizes the label gives way rather than push the add pill off screen.
  eyebrowDark: { flexShrink: 1, fontSize: 10, fontWeight: '700', letterSpacing: 1.8, textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)' },
  // Compact and glass: it sits beside a quiet label, so it must not outshout the chips below it.
  // ⚠️ minHeight, NOT height: a fixed 28 clipped the label's descenders the moment the text scaled up.
  addPill: {
    minHeight: 28, paddingLeft: 8, paddingRight: 11, paddingVertical: 4, borderRadius: 100,
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)',
    flexDirection: 'row', alignItems: 'center', gap: 4,
  },
  addPillTx: { fontSize: 11.5, fontWeight: '800', color: '#fff', letterSpacing: -0.1 },
  chipsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, alignItems: 'center' },
  addNotice: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 16, marginTop: 8 },
  addNoticeTx: { flex: 1, fontSize: 11.5, fontWeight: '600', color: 'rgba(255,255,255,0.72)', lineHeight: 15.5 },
  noticeAct: { fontWeight: '800', color: E.mint },
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
  btnBusy: { opacity: 0.6 },
  paperFailTx: { color: 'rgba(255,255,255,0.72)', fontSize: 13.5, fontWeight: '700', marginTop: 10 },
  paperFailSub: { color: 'rgba(255,255,255,0.42)', fontSize: 12, marginTop: 3 },
  caption: { alignItems: 'center', marginTop: 8, height: 18, paddingHorizontal: 16 },
  captionName: { fontSize: 13, fontWeight: '800', color: '#fff', letterSpacing: -0.3 },
  // A long design name gives way to "94% fit for Airbus", never the other way round.
  captionShrink: { flexShrink: 1 },
  capDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)', marginHorizontal: 8 },
  captionMeta: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)' },
  captionScan: { fontSize: 12, fontWeight: '600', color: '#C4BBFF' },
  docHeadline: {
    marginTop: 6, marginHorizontal: 28, fontSize: 12, fontWeight: '600', lineHeight: 16.5,
    color: 'rgba(255,255,255,0.66)', textAlign: 'center',
  },
  // The Refresh (and try-again) line: glass, centred, one line — information with a verb in it.
  docPill: {
    alignSelf: 'center', maxWidth: '92%', marginTop: 10, paddingHorizontal: 11, height: 30, borderRadius: 100,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(20,184,166,0.12)', borderWidth: 1, borderColor: 'rgba(94,234,212,0.30)',
  },
  docPillTx: { flexShrink: 1, fontSize: 11.5, fontWeight: '600', color: 'rgba(255,255,255,0.82)' },
  docPillAct: { fontWeight: '800', color: E.mint },
  // ⚠️ Shadow on the outer view, clipping on the inner gradient — the same iOS trap as makeWrap.
  tailorBox: { marginTop: 12, marginHorizontal: 16, alignItems: 'stretch' },
  tailorWrap: {
    borderRadius: 16,
    shadowColor: E.blue, shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.42, shadowRadius: 20, elevation: 8,
  },
  tailorBtn: {
    height: 50, paddingHorizontal: 18, borderRadius: 16, overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  tailorTx: { fontSize: 15, fontWeight: '800', color: '#fff', letterSpacing: -0.2, flexShrink: 1 },
  actionHint: { marginTop: 7, fontSize: 11.5, fontWeight: '700', color: E.mint, textAlign: 'center' },
  actionHintWarn: { color: 'rgba(255,214,153,0.9)' },



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
