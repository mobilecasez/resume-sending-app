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
// BUILDS RUN IN THE BACKGROUND, PER EMPLOYER (services/homeBuilds holds their live state): the chip
// shows its progress, the carousel writes the pages with a live % and a tap reopens the overlay.
//
// THE LIBRARY OPENS, IT NEVER DOWNLOADS. A card under "Downloaded" grows into the same zoomed page a
// hero page does (PaperZoom), with the same two doors for a resume AND a cover letter — Customize and
// View PDF — through the same functions the hero uses; the download happens from View PDF, exactly as
// from the hero (openHistoryItem).
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash): one driver per view tree, no mixing.
// This file and its children (MeshStage, PaperCarousel, EmployerChip) use useNativeDriver:true ONLY,
// on transform/opacity, and contain no JS-driven Animated.Value — a self-contained native tree.
// ⚠️ A TICKING PERCENTAGE NEVER LIVES HERE: it is React state inside a small memo component (the chip's
// build line, the carousel's read-out). This screen subscribes to a build's PHASE only, so a stage
// tick re-renders a chip, never the whole of Home. The overlays it shares a screen with (JourneyCoach,
// ResumeScoreModal, BuildingOverlay, PaperZoom) are separate trees mounted as siblings, which the rule
// allows.
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Animated, Easing,
  ActivityIndicator, RefreshControl, Alert, Image,
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
import PaperCarousel, { PaperCard } from './PaperCarousel';
import PaperZoom, { OriginRect } from './PaperZoom';
import AddEmployerSheet, { type EmployerPick } from './AddEmployerSheet';
import BuildingOverlay from './BuildingOverlay';
import EmployerChip from './EmployerChip';
import { useHomeBuilds, forgetHomeBuilds, type HomeBuildJob } from './useHomeBuilds';
import { useDocList, useTargetDoc, useDocDeck, type DocLoaders } from './useTargetDoc';
import {
  fetchTargets, fetchHomeCards, fetchTemplateCatalogue, bestDesignForCountry, LETTER_DESIGNS,
  fetchDownloadHistory, cachedDownloadHistory, redownload, gradFor, savePendingListing,
  hideTarget, unhideTarget, untrackEmployer, fetchHiddenKeys, jobKeyForUrl,
  Target, HomeCard, HomeCards, DownloadHistory as HistoryPayload, DownloadHistoryItem,
} from '../../services/employerHomeService';
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
import { fetchProfileSnapshot, ProfileSetup } from '../../services/profileSetupService';
import { fetchSubscriptionStatus } from '../../services/subscriptionService';
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
}

// signedInAccount lives in services/homeAddEmployer — ONE definition, shared with the in-flight records.

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
  const [targets, setTargets] = useState<Target[]>([]);
  const [empIdx, setEmpIdx] = useState(0);
  const [cards, setCards] = useState<HomeCard[]>([]);
  // Every design in the catalogue, as a slot. Pixels arrive later and are merged in by id.
  const [slots, setSlots] = useState<HomeCard[]>([]);
  const [shots, setShots] = useState<Record<string, string>>({});
  const dead = useRef<Record<string, true>>({});
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
  // The employer the user actually TAPPED, held by key. empIdx alone is a position into a list
  // that is re-fetched and re-sorted by match on every focus, so a background refresh could slide
  // a different company under the same index — the ribbon and the CTA would silently rename
  // themselves to an employer the user never chose. Stays null until they pick, so the default
  // (best match first) is still free to move.
  const pickedKey = useRef<string | null>(null);

  const kind = kindOfMode(mode);
  // When the saved documents were last asked for: listToken re-reads the chips' dots, docToken the
  // selected chip's own document. Bumped by a landed build, a pull-to-refresh and a return to Home —
  // all READS.
  const [listToken, setListToken] = useState(0);
  const [docToken, setDocToken] = useState(0);
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

  const loadTargets = loaders?.targets || fetchTargets;
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
    const { loaders, loadTargets, loadCards, loadPaid, loadSetup } = live.current;
    const [fetched, c, cat, wiped] = await Promise.all([
      loadTargets(),
      loadCards(),
      (loaders?.catalogue || fetchTemplateCatalogue)().catch(() => [] as HomeCard[]),
      // ⚠️ BEFORE the merge below: another account's added employers must never lead this row.
      // The preview harness has no account, and claiming would wipe its fixtures on every load.
      loaders ? Promise.resolve(false) : claimAccountCache(),
    ]);
    if (wiped) {
      pickedKey.current = null;
      // The documents on screen were the previous account's: ask again for this one.
      setListToken((n) => n + 1);
      setDocToken((n) => n + 1);
    }
    // Nothing came back at all: if that was the server refusing the session, the cache goes too.
    if (!loaders && !fetched.length && c === null && (await sessionRejected())) {
      forgetAccountCache();
      cacheOwner = null;
      pickedKey.current = null;
    }
    if (seq !== loadSeq.current) return undefined;
    if (cat.length) setSlots(cat);
    // Employers added on this screen lead, whether or not the server has them yet — and a chip removed
    // here stays gone even when this answer was read before the server heard about the removal.
    const t = mergeAdded(fetched.filter((x) => !removedNow(x.key)), pickedKey);
    targetsRef.current = t;
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
      // ⚠️ Only a real boolean counts: an older server that does not send it leaves this null, and `sample`
      // stands in — never `false`, which would tell someone with a resume to build one.
      setHasResume(typeof c.hasResume === 'boolean' ? c.hasResume : null);
    }
    else { setLoadFailed(true); }
    setLoading(false);
    const paid = await loadPaid();
    if (seq === loadSeq.current) { setIsPaid(paid); setPaidRead(true); }
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

  /** The design's accent, from the catalogue already in hand. Never a fetch. */
  const accentFor = useCallback((templateId: string): string => {
    const hit = slots.find((c) => c.id === templateId) || cards.find((c) => c.id === templateId);
    return (hit && hit.accent) || E.blue;
  }, [slots, cards]);

  // Back on Home from the editor, the gallery or the plans screen, a saved document may have been edited
  // (new pages) or gone stale, so the documents are asked for again — a READ, never a build. The very first
  // focus is the mount, which asks anyway.
  const focusCount = useRef(0);
  useFocusEffect(useCallback(() => {
    load();
    if (focusCount.current++ > 0) { setDocToken((n) => n + 1); setListToken((n) => n + 1); }
  }, [load]));

  const onRefresh = async () => {
    setRefreshing(true);
    setDocToken((n) => n + 1);
    setListToken((n) => n + 1);
    await load(true);
    setRefreshing(false);
  };

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
  const { doc, state: docState, reload: reloadDoc } = useTargetDoc(kind, target || null, { refreshToken: docToken, loaders: docLoaders });
  const docRef = useRef(doc);
  docRef.current = doc;
  const { deck: docDeck, gone: docGone } = useDocDeck(
    kind, doc, kind === 'cover_letter' ? LETTER_DESIGNS : slots, cardIdx, { loaders: docLoaders, enabled: !!doc },
  );
  // A library card of the document on screen borrows its page from here rather than asking for it again.
  const docDeckRef = useRef(docDeck);
  docDeckRef.current = docDeck;
  const selPhase = useBuildPhase(kind, selRk);
  const selBuilding = selPhase === 'checking' || selPhase === 'queued' || selPhase === 'building';

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
  const noResumeYet = noResume || !(hasResume ?? !sample);

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
    if (!slots.length) return cards as PaperCard[];
    const ready = new Map(cards.map((c) => [c.id, c] as const));
    const lead = cards.map((c) => ({ ...c, image: shots[c.id] || c.image })) as PaperCard[];
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

  // The deck on screen: the chip's own document when it has one (ranked, with fit), the base resume
  // when it does not, and the letter formats as blank pages while a letter is being written.
  let shown: { cards: PaperCard[]; fit: boolean } | null = null;
  if (doc && docDeck.length) shown = { cards: docDeck, fit: true };
  else if (mode === 'letter') {
    if (selBuilding || docPending) shown = { cards: LETTER_SLOTS, fit: false };
  } else if (!noResume) {
    if (docPending && slotCards.length) shown = { cards: slotCards, fit: false };
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

  /** Put a new chip row on screen and keep the user's pin on the chip it names. */
  const applyTargets = (next: Target[]) => {
    let sel: number | undefined;
    if (pickedKey.current) {
      const j = next.findIndex((x) => x.key === pickedKey.current);
      sel = j >= 0 ? j : 0;
    }
    commitTargets(next, sel);
  };

  /** Select a chip for the user (a build they watched, a notice they tapped) — pinned, like a tap. */
  const selectAt = (j: number) => {
    const t = targetsRef.current[j];
    if (!t) return;
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
    if (loaders) { Alert.alert('Preview only', 'Building a document needs a signed-in account.'); return; }
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
  }, [lookupSig, wantsAction, loaders]);
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
    }
    if (!back.length) return false;
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
      initial: name.charAt(0).toUpperCase() || '?', colors: gradFor(name), skills: [],
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
          website: e.website || website, initial: e.logoInitial || pending.initial, colors: e.logoColor,
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
      // word — a button that does nothing reads as a broken button, not as "not yet".
      if (docOnItsWay()) sayLoadingDoc();
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
   */
  const customizeResume = (d: ZoomDoc | null, target: BuilderFor | undefined, sample: boolean) => {
    // A saved employer document is edited AS that document: the editor loads it by id and saves
    // back to it, so the base resume — and every other employer's version — is left alone.
    if (d && d.kind === 'resume') {
      rememberBuilderEmployer(d.employer || target?.company)
        .finally(() => nav()?.push?.({ pathname: '/(resume-builder)/preview', params: { docId: String(d.docId) } }));
      return;
    }
    if (sample) armBuilderFor(target).finally(() => nav()?.push?.('/(resume-builder)'));
    // Not armBuilderFor: writing 'resume_builder_entry' here would arm a PAID regeneration.
    // Only the employer hint travels, so the editor's download can name the company.
    else rememberBuilderEmployer(target?.company).finally(() => nav()?.push?.('/(resume-builder)/preview'));
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
    const accent = accentFor(item.templateId);

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
    // A page already in hand: the deck on screen when it IS this document, else one the library kept.
    const onDeck = docRef.current && docRef.current.docId === saved.docId
      ? docDeckRef.current.find((c) => c.id === item.templateId) || null
      : null;
    const kept = libPages.get(libPageKey(k, saved, item.templateId)) || null;
    const image = (onDeck && onDeck.image) || (kept && kept.image) || null;
    const fit = onDeck && onDeck.fit != null ? onDeck.fit
      : kept && kept.fit != null ? kept.fit
        : saved.topId === item.templateId ? saved.topScore : null;
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
        <View style={{ paddingTop: 10 }}>
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
            <View style={s.paperLoading}><ActivityIndicator color="#fff" /></View>
          )}

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
              <TailorAction
                label={`Tailor my resume for ${target.company}`}
                hint={hint ? hint.text : null}
                warn={!!hint?.warn}
                onPress={() => requestBuild('tailor')}
              />
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
            // ⚠️ NAME WHAT IS ACTUALLY LEFT. `setup` carries four real booleans from the server, so
            // saying "Make yours" to someone who finished two steps last week tells them their work
            // is gone. In wizard order, so the sentence matches the screens they will see.
            const left = ([
              [setup.profile, 'your details'], [setup.photo, 'a photo'],
              [setup.signature, 'your signature'], [setup.resume, 'your experience'],
            ] as Array<[boolean, string]>).filter(([done]) => !done).map(([, n]) => n);
            const started = setup.profile || setup.photo || setup.signature || setup.resume;
            // ⚠️ ONCE THE PROFILE IS COMPLETE THIS DOOR IS THE EDITOR, NOT THE WIZARD. The wizard used to
            // stay the destination for a finished profile too ("rebuilding from fresh notes is a thing
            // people do repeatedly") — but with a document per employer, what a finished profile wants
            // from this button is to change the words, and the editor opens on the employer's OWN
            // version when the chip on screen has one. "Edit details" at the top still reaches the builder.
            const complete = !!setup.complete;
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
              ? (resumeDoc ? `Edit your ${resumeDoc.employer} version — every design above follows.` : 'Edit any section — every design above follows.')
              : !started
                ? 'A few details and we will build your real resume into every design above.'
                : left.length === 0
                  ? 'New notes, a fresh resume — into every design above.'
                  : left.length === 1
                    ? `One thing left — ${left[0]}.`
                    : `${left.length} things left — ${left.slice(0, -1).join(', ')} and ${left[left.length - 1]}.`;
            // "Make your Resume" names the DESTINATION — the wizard that makes one — not a claim
            // that you have not got one. Someone mid-way gets the more useful sentence instead.
            const label = complete ? 'Customize your resume' : left.length && started ? 'Pick up where you left off' : 'Make your Resume';
            const go = () => {
              try { Haptics.selectionAsync(); } catch {}
              track('home_make_yours', { has: [setup.profile && 'p', setup.photo && 'i', setup.signature && 's', setup.resume && 'r'].filter(Boolean).join(''), complete, doc: !!resumeDoc });
              if (complete) {
                // ⚠️ Straight to the section editor — never 'resume_builder_entry' / 'resumeBuilderAction',
                // which arm a PAID regeneration. The employer rides along for the editor's own download.
                rememberBuilderEmployer(resumeDoc?.employer || target?.company).finally(() => nav()?.push?.(resumeDoc
                  ? { pathname: '/(resume-builder)/preview', params: { docId: String(resumeDoc.docId) } }
                  : '/(resume-builder)/preview'));
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

          {sample && mode === 'resume' && !doc && (
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
          what they have already paid for, and can have again.
          ⚠️ A card OPENS its page (openHistoryItem) — the hero's zoom, Customize and View PDF — and
          never downloads on the tap. */}
      <View style={s.library}>
      <DownloadHistory
        mode={mode}
        items={history}
        loading={histLoading}
        expanded={histOpen}
        busyId={againId}
        thumbFor={thumbFor}
        accentFor={accentFor}
        onOpen={openHistoryItem}
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
        sample={libZoom ? libZoom.sample : sample && !doc}
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
