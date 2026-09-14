// AI Hub — new feature. Safe to delete without affecting existing app.
//
// EVERY BUILD HOME STARTS — tailored resumes AND cover letters, several at once, watched or not.
//
// This is EmployerHome's build orchestration (gateAndBuild, runBuild, finishBuild, retryBuild, drainQueue,
// dismissOverlay and the mount recovery) lifted out of the screen and generalised twice: to both document
// kinds, and from one build at a time to MAX_PARALLEL_BUILDS side by side. The screen used to keep its one
// build in refs and its one overlay in state, so the moment the user chose "Keep it building in the
// background" nothing on Home could show that the build existed. Now each build is a record in the
// observable store (services/homeBuilds), keyed by kind + the chip's render key: its chip and its carousel
// cards show THEIR build's progress, and BuildingOverlay is only a window onto one record — bound to a key,
// opened and closed without ever touching the build behind it.
//
// ⚠️ NEVER A SILENT CHARGE (the letters auto-regen drain). request() is the only way in, and it demands
// `explicit: true` (in its type AND again at run time). ⚠️ SINCE 2026-09-14 EVEN THAT TAP SPENDS NOTHING ON ITS
// OWN (the product owner's ask): a build starts without a question ONLY on the server's 'cache' answer — a
// document already built, which is free. Covered by the plan, the free allowance or a download pass is a
// question on the confirm sheet (GenerateConfirmSheet: what tailoring does, how many are left, Continue /
// Cancel), and only its Continue starts the build — sent coveredOnly, so the server refuses rather than fall
// through to anything else. Nothing left is the same sheet, empty: "Generate once" buys the one-time pass for
// THIS employer and builds with it, or See plans. A gate we could not read is still an Alert first.
// ⚠️ NO USER EVER SEES THE WORD "CREDITS" HERE. Since 2026-09-13 a resume or a letter is paid for by the plan
// or the free allowance only — the server has no credits lane for them, so a dialog asking consent to a
// credit charge was consent to something that cannot happen. The gate type still carries via 'credits' (an
// older or misconfigured server could say it); that answer is asked about in plan words and built
// coveredOnly:true, so it can never become a credit charge either. Mounting, focusing, switching chips or
// modes starts nothing new: the mount only re-joins builds the server already HAS (a job id to poll),
// and a build that waited in line for a free slot goes back through the gate before it starts.
// ⚠️ A LOST POST IS NEVER RESENT BY A MOUNT, A SWEEP OR ANOTHER CHIP'S TRY AGAIN. A record with no job id is
// a build the user was told had failed (or whose chip they removed); resending it from a remount charged
// them for something they had walked away from. Only Try again on THAT build passes its key as resendKey.
// ⚠️ AND A CONFIRMED BUILD NAMES ITS PAYER, NOT JUST "COVERED" (contract C2). coveredOnly is one permission for
// four different pockets, so a Continue given to "1 of 3 free left" also let the server spend a one-time pass
// bought for another employer. Every build the sheet starts carries expectVia — the payer that was on screen —
// and a server that would really use another refuses with 409 before binding or charging anything. That answer
// (payer_changed, or cache_miss for a promised cache that is gone) is not a failure to show: nothing was spent,
// so regate() reads the gate again and asks the same question about what is true NOW.
// ⚠️ A PAYMENT THAT WENT THROUGH IS NEVER SOLD TWICE (contract C1). "Generate once" treats the store's `paid`
// (charged, not visible on the server yet) and `pending` (Ask-to-Buy) answers as bought, exactly like ok: the
// button becomes "Use my one-time pass", which only re-reads the gate. It used to offer to buy again.
//
// ⚠️ THE ASYNC LANE CHARGES SOMEONE WHO WALKS AWAY. Closing the overlay, leaving Home, killing the app —
// none of them stop a build the server has, so nothing here is called cancel and no copy may say a build
// was cancelled. Only what has NOT started can be withdrawn: a gate still being read, a question still on
// screen (the dialog, or the sheet before its Continue), a place in the queue (cancelQueued).
//
// ⚠️ MODULE SCOPE, NOT HOOK STATE. EmployerHome unmounts whenever the Dashboard is shown and a build outlives
// it, so the queue, the runs and the records live in this module; the hook is only the screen watching them
// right now (the "host"). A build that lands with nobody mounted still updates the store — its notice and
// onLanded go to whichever Home is mounted when it lands, or to nobody.
//
// ⚠️ NOTHING TICKS HERE. Stages go to the store; the hook's only React state is which record the overlay is
// bound to (it subscribes to that ONE record only while the overlay is up), a mirror of the one question the
// sheet is asking, and a single re-render when a MODAL_GAP_MS pause ends. The creeping percentage is
// useCreepPct inside the small components that draw it. There are no Animated values in this file.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  checkBuildGate, gateJobFor, buildForEmployer, resumeInflightBuilds, activeBuildCount, buildKeyOf, peekInflight,
  signedInAccount, forgetInflight, MAX_PARALLEL_BUILDS,
  type DocKind, type BuildGate, type BuildStage, type BuildResult, type InflightMeta, type GateUsage, type GatePass,
} from '../../services/homeAddEmployer';
import { buyDownloadPass, type BuyResult } from '../../services/downloadPassService';
import {
  storeKeyOf, getBuilds, setBuild, patchBuild, clearBuild, clearAllBuilds, useTargetBuild,
  type BuildPhase,
} from '../../services/homeBuilds';
import { track } from '../../services/analytics';

/* ── the contract ─────────────────────────────────────────────────────────────────────────────── */

/**
 * One build Home can ask for. The caller builds it from docLookupOf(target), so the document a build
 * produces is the one the doc lookup for that chip then finds.
 */
export type HomeBuildJob = {
  kind: DocKind;
  /** The chip's RENDER key — it survives the pending → tracked key swap, so a build finds its chip. */
  rk: string;
  company: string;
  /** ⚠️ The employer's site, never a posting URL — the generator researches it as the employer. */
  website: string;
  employerId?: string | null;
  country?: string | null;
  /**
   * The document's IDENTITY: the posting URL for a posting chip, '' / absent for an employer-level chip. It is
   * what buildKeyOf and the saved doc are keyed by, so it never carries a link the user merely pasted.
   */
  jobUrl?: string;
  /**
   * The posting the build READS (the gate's fingerprint and the server's scrape input). ⚠️ May be set on an
   * employer-level chip — a link pasted in the Add sheet — without changing which document it writes; the
   * service sends it as job.url and jobUrl as docJobUrl. Absent = jobUrl.
   */
  postingUrl?: string;
  jobText?: string;
  jobTitle?: string;
};

/** What BuildingOverlay shows: one store record, seen through the window the user opened. */
export type OverlayView = {
  visible: boolean;
  key: string | null;
  kind: DocKind;
  company: string;
  stage: BuildStage | null;
  done: boolean;
  error: { reason: string; message: string } | null;
  /** Try again is offered only for a failure that can honestly be retried, with the whole job in hand. */
  canRetry: boolean;
};

/**
 * What GenerateConfirmSheet shows (contract 5): the ONE question on screen about ONE build, BEFORE anything is
 * spent. 'confirm' = something the user already has pays, and Continue starts it; 'empty' = nothing does, and
 * Generate once buys the one-time pass for this employer (or See plans).
 * ⚠️ WHAT THE TWO COUNTS MEAN IS DECIDED HERE, so the sheet never has to guess what pays. In 'confirm' mode
 * `pass` is non-null (and `available`) exactly when the one-time pass pays — `forThisEmployer` = it already
 * belongs to this employer, false = Continue binds it to them — and `usage` is set only when the allowance it
 * counts (plan or free) is the one paying and has one to give; both null means something pays that the server
 * did not count for us. In 'empty' mode `usage` is the allowance that ran out (null when the server sent no
 * count), and `pass` is null until a pass was bought from this very sheet without starting the build — then it
 * is { available: true, forThisEmployer: false } and the primary button USES that pass instead of selling a
 * second one. ⚠️ "BOUGHT" INCLUDES A PAYMENT THE SERVER HAS NOT SHOWN YET (contract C1, `payment` below): the
 * store has taken it (or will, on approval), so selling a second one would charge twice for one need. ⚠️ The server's own `pass` is never shown in 'empty' mode: a pass that could pay would have made
 * the gate answer via 'pass', so one riding on a refusal is at best about the other kind of document.
 * `error` is the one line under the question — a failure, or a note that must be read (a pass bought that did
 * not start the build). `busy` = the purchase, or a gate read around it, is running: nothing may be tapped.
 * ⚠️ `payment` is a purchase from THIS sheet that the server has not shown yet (contract C1): 'applying' = the
 * store charged them and the pass has not surfaced, 'approval' = Ask-to-Buy, where approving it later charges.
 * Both are "bought" as far as this sheet is concerned — it may re-read, never sell again — and both change what
 * the primary button says. `canCancel` = busy, but past the store: Cancel may take the question away, and what
 * was paid for stays theirs (nothing here can open the store a second time).
 */
export type ConfirmSheetView = {
  visible: boolean;
  mode: 'confirm' | 'empty';
  kind: DocKind;
  company: string;
  usage: GateUsage | null;
  pass: GatePass | null;
  busy: boolean;
  error: string | null;
  payment?: Payment;
  canCancel?: boolean;
  onContinue: () => void;
  onCancel: () => void;
  onBuyOnce: () => void;
  onSeePlans: () => void;
};

type NoticeAction = { label: string; kind: DocKind; rk: string };

type RequestHow = {
  explicit: true;
  /** Lets the new chip land and glow BEFORE an overlay or a dialog covers it. The gate is read during it. */
  holdMs?: number;
  /** The job under the name and website tracking settled on. null = build nothing (see beginRequest). */
  named?: Promise<HomeBuildJob | null>;
  showOverlay?: boolean;
  /**
   * One line to carry into the question this request ends at — used by regate(), so a build the server refused
   * without spending anything says what became of the money before it asks again. ⚠️ Never a claim that a
   * charge happened (see SHEET_COPY); dropped when the question has to wait in line rather than open now.
   */
  note?: string | null;
};

/* ── timings and copy ─────────────────────────────────────────────────────────────────────────── */

/**
 * After the chip's hold, how long the dry-run gate may take before it counts as unread. The service allows
 * a request 20s; past this the answer is 'unknown', which ASKS — never a guess that it was covered.
 */
const GATE_WAIT_MS = 8000;
/** With no hold, how long a quick gate gets before "Checking your plan…" goes up, so a fast one never flashes it. */
const QUICK_GATE_MS = 300;
/**
 * ⚠️ ONE MODAL AT A TIME, WITH A BREATH BETWEEN. The sheet and BuildingOverlay are two react-native Modals, and
 * on iOS a Modal is a view controller presented from the one that owns it: one presented while the other is still
 * there or still being dismissed is refused by UIKit without an error, while RN believes it is up — a question
 * nobody can see, holding the one question slot for good. So whichever comes second waits this long after the
 * first went away (and GenerateConfirmSheet retries a presentation that never showed, for Home's other Modals).
 */
const MODAL_GAP_MS = 380;
/** After a purchase the pass can take a moment to reach the gate: read it this many times, this far apart. */
const PASS_READS = 3;
const PASS_READ_GAP_MS = 1200;
/** ⚠️ A place in line EXPIRES: a wait from long ago is not consent to spend a plan build now. */
const QUEUE_TTL_MS = 10 * 60 * 1000;
/** How long a finished build keeps its record (the chip's mint check reads the first 6 s of it). */
const DONE_CLEAR_MS = 8000;
/** A build that just ended is not running, whatever a recovery that raced its landing replays afterwards. */
const ENDED_MEMO_MS = 3 * 60 * 1000;
/** How often a build that went 'pending' is looked at again while a Home is mounted. */
const SWEEP_MS = 45 * 1000;
/**
 * When a 'pending' build is given up on. The service honours a remembered build for 15 minutes from its
 * POST's answer (which itself can take a few); past that there is nothing left anywhere to collect.
 */
const GIVE_UP_MS = 18 * 60 * 1000;
/** Try again is honest only for these. The rest are a plan, a missing resume, or a build still running. */
const RETRYABLE = new Set(['network', 'failed']);
/**
 * The service's own words when every slot is taken. ⚠️ It can say so AFTER our count said there was room:
 * it also counts remembered builds nothing on this phone is watching (the app was killed mid-build). That
 * build is not a failure — it waits in line like any other.
 */
const TOO_MANY = /^Three builds are already running/;

const nounOf = (k: DocKind) => (k === 'cover_letter' ? 'cover letter' : 'resume');
const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];
const countWord = (n: number) => COUNT_WORDS[n] || String(n);

const GATE_COPY: Record<DocKind, Record<'quota_exhausted' | 'regen_limit', string>> = {
  resume: {
    quota_exhausted: 'You have used the resume builds your plan includes. See plans to build this one.',
    regen_limit: 'Your free plan includes one AI rebuild, and it has been used. See plans to tailor a resume for every employer.',
  },
  cover_letter: {
    quota_exhausted: 'You have used the cover letters your plan includes. See plans to write this one.',
    regen_limit: 'Your free plan’s cover letter has been used. See plans to write one for every employer.',
  },
};

/** The neutral state while the gate is read: it starts nothing and claims nothing. */
const CHECKING: BuildStage = { stage: 'checking', label: 'Checking your plan…', pct: 0 };
const QUEUED: BuildStage = { stage: 'queued', label: 'Queued — starts when a build finishes', pct: 0 };
const PARKED: BuildStage = { stage: 'queued', label: 'Waiting for your answer on another build', pct: 0 };
/**
 * ⚠️ A PLACE IN LINE IS SHOWN TO THE OVERLAY AS 'checking'. BuildingOverlay reads that stage as "nothing has
 * started yet" — Close, not "Keep it building in the background" — which is exactly the truth about a build
 * that is waiting for a slot. The store itself keeps the honest 'queued'.
 */
const QUEUED_VIEW: BuildStage = { stage: 'checking', label: 'Waiting for one of your builds to finish…', pct: 0 };
const STARTING: BuildStage = { stage: 'starting', label: 'Getting started', pct: 2 };
const RECOVERING: BuildStage = { stage: 'recovering', label: 'Picking up where it left off', pct: 5 };
const DONE: BuildStage = { stage: 'done', label: 'Ready', pct: 100 };
const PENDING_LABEL = 'Still working on it…';
const UNREAD: BuildGate = { covered: false, via: null, reason: 'unknown' };

/** The sheet's own sentences. ⚠️ None of them may say a charge happened that did not, or did not that did. */
const SHEET_COPY = {
  unread: 'We couldn’t check your plan just now, so nothing was bought. Please try again.',
  failed: 'That didn’t go through. Please try again.',
  paidNotReady: 'Your payment went through, but we couldn’t start it yet. Tap “Use my one-time pass” to try again — you won’t be charged twice.',
  // The store charged them and the server has not shown the pass yet — the same fact as paidNotReady, one step
  // earlier, so it says where the pass is rather than blaming the build.
  applying: 'Your payment went through — we’re still applying your one-time pass. Tap “Use my one-time pass” in a moment; you won’t be charged twice.',
  // Ask-to-Buy / deferred: nothing has been charged YET, and approving it later is what charges. Saying
  // "your payment went through" here would be the exact lie this file exists to avoid.
  approval: 'Your payment is waiting to be approved, so nothing has been charged yet. When it clears, tap “Use my one-time pass”.',
  saved: 'Your one-time pass is saved — it covers the next employer you use it for.',
  savedApplying: 'Your payment went through — your one-time pass covers the next employer you use it for.',
  savedApproval: 'Your payment is waiting to be approved. When it clears, your one-time pass covers the next employer you use it for.',
  covered: 'Good news — this one is already covered, so nothing was bought.',
  // After a 409 (contract C2). Nothing was bound, charged or stored — and the question that follows is about
  // what pays NOW, so the note has to say why it is being asked again.
  payerChanged: 'What pays for this changed, so nothing was charged. Here’s what covers it now.',
  cacheMiss: 'Your saved copy wasn’t there any more, so nothing was charged. Here’s what a new one uses.',
};

/* ── module state ─────────────────────────────────────────────────────────────────────────────── */

/** What pays for a confirmed build: the plan, the free allowance, or the one-time pass. */
type Pool = 'plan' | 'free' | 'pass';

/**
 * Every answer a gate can give, as runBuild is told it. ⚠️ The first four ARE the expectVia sent to the server
 * (contract C2) when the build is covered-only; 'credits' and 'unknown' name no payer and send none, which is
 * the older behaviour — the only two sends that go out coveredOnly:false are 'unknown' anyway.
 */
type GateVia = Pool | 'cache' | 'credits' | 'unknown';

/**
 * A purchase from the sheet that the server has not shown yet (contract C1): 'applying' = the store charged
 * them, 'approval' = Ask-to-Buy (nothing charged until it clears). null = nothing pending — either no purchase,
 * or one the server has already confirmed.
 */
export type Payment = 'applying' | 'approval' | null;

/**
 * What the user already agreed to, carried with a build that then had to wait for a slot.
 *   { via: 'unknown' }   — Build on the dialog that said the plan could not be checked (coveredOnly:false).
 *   { via: 'confirmed' } — Continue on the sheet, or a pass bought on it: covers the SAME pool when the line
 *                          moves, and nothing else — a pool that changed while it waited is asked about again.
 * ⚠️ The credits shape is kept for the type, not produced.
 */
type Consent = { via: 'credits'; credits: number } | { via: 'unknown' } | { via: 'confirmed'; pool: Pool };

/** One build on its way, keyed by buildKeyOf — the identity the service's flights and records share. */
type Run = {
  buildKey: string;
  /** store key → chip render key, for every chip showing this build (two chips can be one posting). */
  keys: Map<string, string>;
  job: HomeBuildJob;
  /** The service's description, for a build this session did not start (a relaunch, a remount). */
  meta: InflightMeta | null;
  /** Its chip was GUESSED (rkFor had no chips yet), so it moves to the real one as soon as it can. */
  provisional: boolean;
  /** Re-picked-up by Try again: a vanished record goes back through the gate instead of being dropped. */
  retry: boolean;
  startedAt: number;
  epoch: number;
  /** A buildForEmployer call from THIS session is still waiting on the flight, and will land it itself. */
  local: boolean;
  pending: boolean;
  over: boolean;
};

type Waiting = { id: number; key: string; buildKey: string; job: HomeBuildJob; at: number; consent: Consent | null };

type Host = {
  alive: () => boolean;
  /** The overlay is up AND bound to this record. */
  watching: (key: string) => boolean;
  overlayUp: () => boolean;
  show: (key: string, kind: DocKind, rk: string, company: string) => void;
  hide: (key: string) => void;
  hideAll: () => void;
  rebind: (from: string, to: string, rk: string) => void;
  rkFor: (meta: InflightMeta) => string | null;
  landed: (job: HomeBuildJob, docId: number | null, cached: boolean, watched: boolean) => void;
  notice: (text: string, action?: NoticeAction) => void;
  /** The screen's plans route — only ever the user's own tap on the sheet's See plans. */
  seePlans: () => void;
};

/**
 * ⚠️ WHOSE BUILDS THESE ARE. Module state outlives a sign-out (App.js's logout never reloads the bundle), so
 * everything here belongs to an epoch: forgetHomeBuilds() starts a new one, and a run, a gate answer or a
 * dialog from an older epoch lands nowhere — another account's resume must never reach this one's chips.
 * `owner` is the account the last recovery ran for (undefined until one has).
 */
let epoch = 0;
let owner: string | null | undefined;
let seq = 0;
const runs = new Map<string, Run>();
/** The full job behind each store key, as last requested — what Try again rebuilds from. */
const jobs = new Map<string, HomeBuildJob>();
/** The request token reading each key's gate right now. Deleting it makes that request stand down. */
const requests = new Map<string, number>();
/** Bumped by retarget, so a gate read for an older version of a job is read again. */
const vers = new Map<string, number>();
/** Error records that are plan refusals: nothing started, so they clear once seen. */
const refused = new Set<string>();
/**
 * Chips whose last build was refused with 'cache_miss' — the gate promised a free cached document the build
 * could not find. ⚠️ BELIEVED TWICE IT IS A LOOP WITH NO TAP IN IT: a cache answer starts a build on its own
 * (it is free), so the same wrong promise would start, be refused, and start again. Cleared when that chip
 * builds something, when it goes, or with the account.
 */
const missedCache = new Set<string>();
/**
 * How each build last ended. ⚠️ A recovery (a remount, a sweep) joins the same flight a tap is waiting on, and
 * whichever hears the end second finds no run left — without this it would land the build again (a second
 * "ready", a second onLanded) or re-adopt it and flip a finished chip back to building.
 */
const ended = new Map<string, { at: number; ok: boolean; reason: string }>();
/**
 * store key → the build key of the last build that ENDED on that chip. A removed chip's lost POST must be
 * forgotten by the service too, and a build recovered after a relaunch never wrote its job into `jobs`.
 */
const endedFor = new Map<string, string>();
let queue: Waiting[] = [];
/** The id of the build-or-not dialog on screen. One at a time: a second one waits in line. */
let asking: number | null = null;
let draining = false;
let drainAgain = false;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
let host: Host | null = null;

/**
 * The confirm sheet's ONE question. ⚠️ IT SHARES `asking` WITH THE DIALOG, so a sheet and a dialog never stack
 * and a second question waits in line. Module scope like everything else here: a purchase that outlives the
 * Home that started it still lands. `shown` is false during MODAL_GAP_MS; `bought` = a pass was bought from
 * THIS question, so nothing on it may ever buy a second one; `show` = raise the overlay once it starts.
 */
type Ask = {
  id: number; key: string; job: HomeBuildJob; mode: 'confirm' | 'empty'; pool: Pool | null;
  usage: GateUsage | null; pass: GatePass | null; busy: boolean; error: string | null; bought: boolean;
  shown: boolean; startedAt: number; show: boolean; at?: number; epoch: number;
  /** A purchase from this question the server has not shown yet — `bought` is true for these too. */
  payment: Payment;
  /**
   * The store call for this question has returned (however it answered). ⚠️ THE ONLY THING THAT UNLOCKS CANCEL
   * WHILE BUSY: before it, a tap could land between "Generate once" and the store's own sheet; after it, nothing
   * here can open the store again, so leaving merely keeps what was paid for.
   */
  storeDone: boolean;
};
let sheet: Ask | null = null;
/** The last question published, so a closing sheet keeps its words instead of flashing blank ones. */
let sheetLast: Ask | null = null;
const sheetWatchers = new Set<(a: Ask | null) => void>();
/**
 * When a Modal of ours last went away — see MODAL_GAP_MS. Stamped by closeSheet for the sheet and by the hook's
 * setBound for the overlay (every way that window closes goes through it).
 */
let modalAt = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const keyOfJob = (j: { kind: DocKind; rk: string }) => storeKeyOf(j.kind, j.rk);
const verOf = (key: string) => vers.get(key) || 0;
const endedRecently = (bk: string) => {
  const e = ended.get(bk);
  return e && Date.now() - e.at < ENDED_MEMO_MS ? e : null;
};

/* ── the screen that is watching ──────────────────────────────────────────────────────────────── */

/** ⚠️ Every call into the screen is guarded: a throwing setState must never abandon a build mid-landing. */
function withHost<T>(fn: (h: Host) => T, fallback: T): T {
  const h = host;
  if (!h) return fallback;
  try { return fn(h); } catch { return fallback; }
}
const hostAlive = () => withHost((h) => !!h.alive(), false);
const watching = (key: string) => withHost((h) => h.watching(key), false);
const overlayUp = () => withHost((h) => h.overlayUp(), false);
/**
 * ⚠️ NEVER OVER THE SHEET. A question on the sheet (or one waiting out MODAL_GAP_MS to come up) is a Modal the
 * overlay would be presented on top of — refused by UIKit without an error. Unwatched, a build tells its news
 * in a notice instead, which is exactly what a build nobody is watching does anyway.
 */
function showOverlay(key: string, t: { kind: DocKind; rk: string; company: string }) {
  if (sheet) return;
  if (hostAlive()) withHost<void>((h) => h.show(key, t.kind, t.rk, t.company), undefined);
}
function hideOverlay(key: string) {
  withHost<void>((h) => h.hide(key), undefined);
}
function notify(text: string, action?: NoticeAction) {
  if (hostAlive()) withHost<void>((h) => h.notice(text, action), undefined);
}
function rkForMeta(meta: InflightMeta): string | null {
  return withHost((h) => { const rk = h.rkFor(meta); return rk ? String(rk) : null; }, null);
}

/* ── the gate ─────────────────────────────────────────────────────────────────────────────────── */

/** The dry-run gate for exactly the build that would run, with Home's own shorter deadline. */
async function readGate(job: HomeBuildJob): Promise<BuildGate> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      checkBuildGate(job.company, gateJobFor(job), job.kind, { employerId: job.employerId ?? null, country: job.country ?? null }),
      new Promise<BuildGate>((r) => { timer = setTimeout(() => r(UNREAD), GATE_WAIT_MS); }),
    ]);
  } catch { return UNREAD; } finally { if (timer) clearTimeout(timer); }
}

/**
 * The gate for what will REALLY be built. ⚠️ A retarget can land while the gate is out (tracking answers
 * with the stored website, or refuses a job-board host), and an answer about the old job is an answer about
 * a build that will not run — the 'cache' it promised would miss, and a refused board host would be
 * researched as the employer. So it is read again for the latest job; one still moving after three reads
 * is no answer at all ('unknown' → ask).
 * ⚠️ AND A CACHE THE BUILD JUST MISSED IS NOT PROMISED AGAIN (see missedCache): every path that can start a
 * build reads its gate through here, so the distrust is applied once, where the answer is produced.
 */
async function stableGate(key: string, job: HomeBuildJob): Promise<{ job: HomeBuildJob; gate: BuildGate; ver: number }> {
  let cur = job;
  for (let n = 0; n < 3; n++) {
    const v = verOf(key);
    const gate = await readGate(cur);
    if (verOf(key) === v) return { job: cur, gate: trusted(key, gate), ver: v };
    cur = jobs.get(key) || cur;
  }
  return { job: cur, gate: UNREAD, ver: verOf(key) };
}

/**
 * A 'cache' answer for a chip whose last build was refused with 'cache_miss' is no answer at all — it ASKS
 * instead (the unread-gate dialog), which is the truth: the one thing we know is that this gate was wrong.
 * ⚠️ It only ever makes the app ask MORE, never spend more: every other answer is passed through untouched.
 */
const trusted = (key: string, gate: BuildGate): BuildGate =>
  (gate.covered && gate.via === 'cache' && missedCache.has(key) ? UNREAD : gate);

/**
 * The consent a build keeps while it waits for a slot — only the kind that matches how it is sent. ⚠️ A
 * covered-only build never carries the unread gate's "go ahead" (that would send it coveredOnly:false when
 * the line moves), and a coveredOnly:false build never carries a Continue.
 */
function carried(coveredOnly: boolean, c: Consent | null | undefined): Consent | null {
  if (!c) return null;
  if (coveredOnly) return c.via === 'confirmed' ? c : null;
  return c.via === 'unknown' ? c : null;
}

/** Whether a Continue the user already tapped covers what the gate says NOW: the same pool, and only that. */
function confirmedCovers(c: Consent | null, via: 'plan' | 'free' | 'pass' | 'cache'): boolean {
  return !!c && c.via === 'confirmed' && via !== 'cache' && c.pool === via;
}

/** Whether a dialog the user already said Build on covers what the gate says NOW. */
function consentCovers(c: Consent | null, gate: BuildGate): boolean {
  if (!c || gate.covered) return false;
  // "The plan could not be checked" accepted covers a gate that is STILL unread — what an immediate start
  // would have sent anyway. ⚠️ It never covers a 'credits' answer: that Build went out coveredOnly:false,
  // and generation has no credits lane to consent to since 2026-09-13 — so a credits gate is asked again
  // (in plan words, built covered-only), never run on an older "go ahead".
  if (gate.via === 'credits') return false;
  return gate.reason === 'unknown' && c.via === 'unknown';
}

/* ── store writes ─────────────────────────────────────────────────────────────────────────────── */

function record(
  key: string, who: { kind: DocKind; rk: string; company: string }, phase: BuildPhase, startedAt: number,
  extra: { stage?: BuildStage | null; error?: { reason: string; message: string } | null; docId?: number | null } = {},
) {
  const now = Date.now();
  setBuild({
    key, kind: who.kind, rk: who.rk, company: who.company, phase,
    stage: extra.stage ?? null, error: extra.error ?? null, docId: extra.docId ?? null,
    startedAt: startedAt || now, updatedAt: now,
  });
}

/**
 * One stage onto one record. ⚠️ NEVER BACKWARDS: the service replays its synthetic 'recovering' (5%) to
 * every joiner, and the number a user is watching must not fall from 38 to 5 because Home remounted.
 * Only a record that is actually building moves; the store drops a patch that changes nothing.
 */
function stageTo(key: string, s: BuildStage) {
  const rec = getBuilds()[key];
  if (!rec || rec.phase !== 'building' || !s) return;
  const raw = Number(s.pct);
  const pct = Math.max(isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0, rec.stage ? rec.stage.pct : 0);
  const label = String(s.label || (rec.stage && rec.stage.label) || '');
  patchBuild(key, { stage: { stage: String(s.stage || ''), label, pct } });
}

function stageRun(run: Run, s: BuildStage) {
  if (run.over || run.epoch !== epoch) return;
  for (const key of Array.from(run.keys.keys())) stageTo(key, s);
}

/* ── the line ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * Wait for a slot. Deduped per chip (a newer ask replaces the older one); two chips for the same posting
 * both wait, and whichever starts first the other simply joins.
 */
function enqueue(job: HomeBuildJob, consent: Consent | null, why: 'capacity' | 'asking', at?: number) {
  const key = keyOfJob(job);
  const now = Date.now();
  requests.delete(key);
  jobs.set(key, job);
  const entry: Waiting = { id: ++seq, key, buildKey: buildKeyOf(job.kind, job), job, at: at ?? now, consent };
  const i = queue.findIndex((q) => q.key === key);
  queue = i >= 0 ? queue.map((q, n) => (n === i ? entry : q)) : [...queue, entry];
  const prev = getBuilds()[key];
  record(key, job, 'queued', prev && prev.phase !== 'done' && prev.phase !== 'error' ? prev.startedAt : now, {
    stage: why === 'asking' ? PARKED : QUEUED,
  });
  track('home_build_queued', { kind: job.kind, why });
  if (why === 'capacity' && !watching(key)) {
    notify(`${countWord(MAX_PARALLEL_BUILDS)} builds are already running — we’ll start ${job.company} as soon as one finishes.`);
  }
}

function expireQueue() {
  const now = Date.now();
  const stale = queue.filter((q) => now - q.at > QUEUE_TTL_MS);
  if (!stale.length) return;
  queue = queue.filter((q) => now - q.at <= QUEUE_TTL_MS);
  for (const q of stale) {
    const rec = getBuilds()[q.key];
    if (!rec || rec.phase !== 'queued') continue;
    hideOverlay(q.key);
    clearBuild(q.key);
    track('home_build_expired', { kind: q.job.kind });
    notify(`We didn’t start your ${q.job.company} ${nounOf(q.job.kind)} — it waited too long. Start it again from its card.`);
  }
}

/**
 * Start what waited behind the builds that just ended — through the gate like any Add, so waiting in line
 * is never a pre-approved charge (a question the user already answered — Build on the dialog, Continue on the
 * sheet — is the one exception: it is not asked twice for the same thing, and only up to what it named: the
 * same unread gate, the same pool). A cache hit is free and simply starts.
 * ⚠️ A QUESTION NEEDS SOMEONE TO ANSWER IT: with no Home mounted, a question already up, or a build being
 * watched in the overlay, a build that needs asking keeps its place and is asked on the next pass.
 * ⚠️ AND A COVERED BUILD NOBODY SAID CONTINUE TO NEVER STARTS UNSEEN. It used to, the moment a slot freed; now
 * it waits for its sheet like any other question (or expires with QUEUE_TTL_MS).
 */
async function drain(): Promise<void> {
  if (!queue.length) return;
  if (draining) { drainAgain = true; return; }
  draining = true;
  drainAgain = false;
  let myEpoch = epoch;
  try {
    // ⚠️ WHOSE LINE THIS IS. Everything waiting was asked for by whoever was signed in THEN, and a gate read
    // now goes out with whoever is signed in NOW — an Add from the last account, re-gated under this one,
    // would spend this account's plan on that account's employer. A different account wipes the line first;
    // nobody signed in starts nothing.
    let who: string | null = null;
    try { who = await signedInAccount(); } catch { who = null; }
    if (epoch !== myEpoch || !who) return;
    if (owner !== undefined && owner !== who) { forgetAll(); owner = who; return; }
    owner = who;
    myEpoch = epoch;
    const seen = new Set<number>();
    for (;;) {
      if (epoch !== myEpoch) return;
      expireQueue();
      if (activeBuildCount() >= MAX_PARALLEL_BUILDS) break;
      const q = queue.find((x) => !seen.has(x.id));
      if (!q) break;
      seen.add(q.id);
      const rec0 = getBuilds()[q.key];
      if (!rec0 || rec0.phase !== 'queued') { queue = queue.filter((x) => x.id !== q.id); continue; }
      const { job, gate } = await stableGate(q.key, jobs.get(q.key) || q.job);
      if (epoch !== myEpoch) return;
      // Withdrawn (the chip was removed) or replaced by a newer ask while the gate was out.
      if (!queue.some((x) => x.id === q.id)) continue;
      const rec = getBuilds()[q.key];
      if (!rec || rec.phase !== 'queued') { queue = queue.filter((x) => x.id !== q.id); continue; }
      if (activeBuildCount() >= MAX_PARALLEL_BUILDS) break;
      if (gate.covered && gate.via === 'cache') {
        queue = queue.filter((x) => x.id !== q.id);
        runBuild(job, gate.via, true, { at: q.at });
        continue;
      }
      if (gate.covered && confirmedCovers(q.consent, gate.via)) {
        queue = queue.filter((x) => x.id !== q.id);
        runBuild(job, gate.via, true, { consent: q.consent, at: q.at });   // Continue was tapped for this very pool
        continue;
      }
      if (consentCovers(q.consent, gate)) {
        queue = queue.filter((x) => x.id !== q.id);
        runBuild(job, 'unknown', false, { consent: q.consent, at: q.at });   // only an unread gate gets here
        continue;
      }
      if (!gate.covered && (gate.via === 'credits' || gate.reason === 'unknown')) {
        if (asking !== null || !hostAlive() || overlayUp()) continue;   // keeps its place
        queue = queue.filter((x) => x.id !== q.id);
        askToBuild(job, gate, { show: false, startedAt: rec.startedAt, at: q.at });
        continue;
      }
      // Covered with nobody's Continue yet, or nothing left: the sheet's question. ⚠️ Nothing left is a question
      // too now (it offers the one-time pass), so with nobody to answer it, it keeps its place like the rest —
      // never started unseen, never turned into a refusal the user would only find later.
      const offer = offerFor(gate);
      if (offer) {
        if (asking !== null || !hostAlive() || overlayUp()) continue;   // keeps its place
        queue = queue.filter((x) => x.id !== q.id);
        askOnSheet(job, offer, { show: true, startedAt: rec.startedAt, at: q.at });
        continue;
      }
      if (gate.covered) continue;   // not reached: a covered answer is the cache, a Continue, or an offer
      queue = queue.filter((x) => x.id !== q.id);
      refuse(job, gate.reason, { show: hostAlive() && !overlayUp() && !sheet });
    }
  } finally {
    draining = false;
    if (drainAgain && epoch === myEpoch) { drainAgain = false; void drain(); }
  }
}

/* ── running ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * Start one build now — or join the same build already on its way, or wait for a slot when
 * MAX_PARALLEL_BUILDS are running.
 *
 * `coveredOnly` is how it is sent: true = the server may spend only plan, free allowance, pass or cache and
 * must refuse (402 → the plans state) rather than fall through to anything else. ⚠️ false ONLY after the
 * user tapped Build on the dialog that said the plan could not be checked — "the user agreed to proceed
 * without a gate answer". ⚠️ Nothing but a cache hit calls this without an answered question behind it.
 * `consent` carries that answer (the dialog's, or the sheet's Continue — see carried), so a build that then
 * has to wait for a slot is not asked the same question twice.
 * ⚠️ `via` IS ALSO WHAT THE SERVER IS TOLD TO EXPECT (expectVia, contract C2): the answer the user was shown
 * and agreed to, so a server that would really spend a different pocket — an unbound pass nobody said Continue
 * to — refuses with 409 instead of taking it. 'credits' and 'unknown' name no payer and send none, which is
 * all those two ever had.
 */
function runBuild(
  final: HomeBuildJob, via: GateVia, coveredOnly: boolean,
  o: { show?: boolean; consent?: Consent | null; at?: number } = {},
): void {
  const key = keyOfJob(final);
  const bk = buildKeyOf(final.kind, final);
  requests.delete(key);
  refused.delete(key);
  jobs.set(key, final);
  const same = runs.get(bk);
  if (same && !same.over && same.epoch === epoch) {
    // That build IS this one — bring it up rather than sending (and charging) it twice.
    joinRun(same, key, final);
    if (o.show) showOverlay(key, final);
    return;
  }
  if (activeBuildCount() >= MAX_PARALLEL_BUILDS) {
    enqueue(final, carried(coveredOnly, o.consent), 'capacity', o.at);
    return;
  }
  const run: Run = {
    buildKey: bk, keys: new Map([[key, final.rk]]), job: final, meta: null, provisional: false, retry: false,
    startedAt: Date.now(), epoch, local: true, pending: false, over: false,
  };
  runs.set(bk, run);
  queue = queue.filter((q) => q.key !== key);
  record(key, final, 'building', run.startedAt, { stage: STARTING });
  if (o.show) showOverlay(key, final);
  track('home_build_start', { kind: final.kind, gate: via, coveredOnly });
  const noun = nounOf(final.kind);
  // ⚠️ ONE STEP WITH THE COUNT ABOVE: buildForEmployer claims its flight synchronously, before its first
  // await, so nothing can take the slot between our check and the claim.
  // Named only where a payer really was named, and only under coveredOnly: the two coveredOnly:false sends are
  // the unread gate's, which promised the server nothing to hold them to.
  const expectVia = coveredOnly && via !== 'credits' && via !== 'unknown' ? via : undefined;
  buildForEmployer(
    {
      company: final.company, website: final.website, jobUrl: final.jobUrl, postingUrl: final.postingUrl,
      jobText: final.jobText, jobTitle: final.jobTitle, employerId: final.employerId ?? null,
      country: final.country ?? null, coveredOnly, expectVia, kind: final.kind,
    },
    (s) => stageRun(run, s),
  )
    .catch((): BuildResult => ({ ok: false, reason: 'failed', message: `We could not finish your ${final.company} ${noun}. Please try again.` }))
    .then((r) => {
      run.local = false;
      if (run.over || run.epoch !== epoch) return;
      if (!r.ok && r.reason === 'failed' && TOO_MANY.test(String(r.message || ''))) {
        // Nothing was sent: the service refused before its POST. It waits its turn instead of failing.
        run.over = true;
        if (runs.get(bk) === run) runs.delete(bk);
        for (const [k, rk] of Array.from(run.keys)) {
          enqueue(jobs.get(k) || { ...final, rk }, carried(coveredOnly, o.consent), 'capacity', o.at);
        }
        return;
      }
      settle(run, r);
    })
    .catch(() => { /* a landing that threw must not become an unhandled rejection */ });
}

/** Another chip for a build already on its way: it shows that build, and nothing is sent twice. */
function joinRun(run: Run, key: string, job: HomeBuildJob) {
  run.keys.set(key, job.rk);
  queue = queue.filter((q) => q.key !== key);
  const rec = getBuilds()[key];
  if (rec && rec.phase === 'building') return;
  let stage: BuildStage = STARTING;
  for (const k of Array.from(run.keys.keys())) {
    const other = getBuilds()[k];
    if (other && other.phase === 'building' && other.stage) { stage = other.stage; break; }
  }
  record(key, job, 'building', run.startedAt, { stage });
}

/**
 * ⚠️ A5: 'pending' IS NOT A FAILURE. Our watch ran out while the job may still finish AND charge, so the
 * record stays 'building' (never an error with Try again — that would be an invitation to pay twice), the
 * service keeps its remembered record, and a sweep keeps looking until it lands or there is nothing left
 * to collect.
 */
function markPending(run: Run, tell: boolean) {
  const first = !run.pending;
  run.pending = true;
  for (const key of Array.from(run.keys.keys())) {
    const rec = getBuilds()[key];
    if (rec && rec.phase === 'building') {
      patchBuild(key, { stage: { stage: 'pending', label: PENDING_LABEL, pct: rec.stage ? rec.stage.pct : 0 } });
    }
  }
  if (first && tell) {
    const job = run.job;
    track('home_build_fail', { kind: job.kind, reason: 'pending' });
    if (!Array.from(run.keys.keys()).some(watching)) {
      notify(`Your ${job.company} ${nounOf(job.kind)} is taking longer than usual — it may still arrive.`, { label: 'Watch', kind: job.kind, rk: job.rk });
    }
  }
  scheduleSweep();
}

/** Stop showing a build we can no longer follow. It is not cancelled — nothing can be. */
function dropRun(run: Run) {
  run.over = true;
  if (runs.get(run.buildKey) === run) runs.delete(run.buildKey);
  for (const key of Array.from(run.keys.keys())) {
    const rec = getBuilds()[key];
    if (rec && rec.phase === 'building') { hideOverlay(key); clearBuild(key); }
  }
}

/**
 * A build ended. ⚠️ THE DOCUMENT IS ON THE SERVER, so "done" needs no page refresh to be honest any more:
 * the result carries the stored doc's id, and the screen shows that doc when its chip is on screen. The
 * old page-signature dance (was the carousel really redrawn?) is gone with the single shared resume row.
 */
function settle(run: Run, r: BuildResult) {
  if (run.over || run.epoch !== epoch) return;
  if (run.provisional) remap(run);
  if (!r.ok && r.reason === 'pending') {
    markPending(run, true);
    void drain();
    return;
  }
  // ⚠️ REFUSED BEFORE ANYTHING WAS BOUND, CHARGED OR STORED (contract C2): not an ending to show, a question to
  // ask again. Before the error record below on purpose — "that build didn't finish" with a Try again that
  // resends the same, now wrong, expectation is a loop the user cannot get out of.
  if (!r.ok && (r.reason === 'payer_changed' || r.reason === 'cache_miss')) {
    regate(run, r.reason);
    return;
  }
  run.over = true;
  if (runs.get(run.buildKey) === run) runs.delete(run.buildKey);
  const job = run.job;
  const noun = nounOf(job.kind);
  const entries = Array.from(run.keys);
  const watched = entries.some(([k]) => watching(k));
  const now = Date.now();
  ended.set(run.buildKey, { at: now, ok: r.ok, reason: r.ok ? '' : String(r.reason || 'failed') });
  for (const [k] of entries) endedFor.set(k, run.buildKey);
  if (r.ok) {
    const docId = typeof r.docId === 'number' && isFinite(r.docId) ? r.docId : null;
    // This chip's gate has been proved right by a build that landed: its next 'cache' answer is trusted again.
    for (const [k] of entries) missedCache.delete(k);
    for (const [k, rk] of entries) {
      const prev = getBuilds()[k];
      record(k, { kind: job.kind, rk, company: (prev && prev.company) || job.company }, 'done', run.startedAt, { stage: DONE, docId });
      const startedAt = run.startedAt;
      const myEpoch = epoch;
      setTimeout(() => {
        const cur = getBuilds()[k];
        if (epoch === myEpoch && cur && cur.phase === 'done' && cur.startedAt === startedAt && cur.docId === docId) clearBuild(k);
      }, DONE_CLEAR_MS);
    }
    track('home_build_done', { kind: job.kind, cached: r.cached, ms: now - run.startedAt, recovered: !!run.meta });
    if (hostAlive()) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      for (const [k, rk] of entries) {
        const j = jobs.get(k) || run.job;
        withHost<void>((h) => h.landed({ ...j, rk }, docId, r.cached, watching(k)), undefined);
      }
    }
    // Watched, the overlay stamps "done" from the record and dismisses ITSELF; hidden, it is a line.
    if (!watched) notify(`Your ${job.company} ${noun} is ready`, { label: 'View', kind: job.kind, rk: job.rk });
  } else {
    const reason = String(r.reason || 'failed');
    const error = { reason, message: r.message || `We could not finish your ${job.company} ${noun}. Please try again.` };
    // ⚠️ The chip STAYS, and its record says why. Try again first picks up a build the service still holds
    // before it will start another (retryJob), and anything new goes back through the gate.
    for (const [k, rk] of entries) {
      const prev = getBuilds()[k];
      record(k, { kind: job.kind, rk, company: (prev && prev.company) || job.company }, 'error', run.startedAt, { error });
    }
    track('home_build_fail', { kind: job.kind, reason });
    if (!watched) notify(`Your ${job.company} ${noun} didn’t finish — tap its card to see why`, { label: 'See why', kind: job.kind, rk: job.rk });
  }
  void drain();
}

/**
 * The server refused what this build expected to pay with (contract C2) — nothing was bound, charged or stored.
 *
 * ⚠️ SO IT IS ASKED AGAIN, NOT REPORTED. The build goes back through the ONE door (beginRequest): a fresh gate
 * read decides what is true now, and its answer is the same sheet with the new numbers, the empty sheet, the
 * plans refusal, or a real cache hit (free, and the one thing that starts without a tap). Nothing here starts a
 * build, and nothing here spends.
 * ⚠️ WITH NOBODY TO ASK, OR NOTHING TO ASK ABOUT, IT SAYS SO INSTEAD. No Home is mounted (the question would be
 * cleared unseen), or this session never held the job — a build recovered after a relaunch carries half a one
 * (adoptRecovered), and re-gating from that would ask about the wrong thing. The record then says both that the
 * build did not happen and that nothing was charged; its Try again goes through the gate like any other.
 */
function regate(run: Run, reason: 'payer_changed' | 'cache_miss') {
  run.over = true;
  if (runs.get(run.buildKey) === run) runs.delete(run.buildKey);
  const entries = Array.from(run.keys);
  const kind = run.job.kind;
  // Remembered like any other ending, so a recovery that hears the same refusal does not act on it twice.
  ended.set(run.buildKey, { at: Date.now(), ok: false, reason });
  for (const [k] of entries) endedFor.set(k, run.buildKey);
  track('home_build_regate', { kind, reason });
  const note = reason === 'cache_miss' ? SHEET_COPY.cacheMiss : SHEET_COPY.payerChanged;
  for (const [k, rk] of entries) {
    if (reason === 'cache_miss') missedCache.add(k);
    const job = jobs.get(k);
    const watched = watching(k);
    const prev = getBuilds()[k];
    const company = (prev && prev.company) || run.job.company;
    if (!job || !hostAlive()) {
      refused.add(k);
      record(k, { kind, rk, company }, 'error', run.startedAt, {
        error: { reason: 'failed', message: `${note} Start it again from its card.` },
      });
      if (!watched) notify(`Your ${company} ${nounOf(kind)} wasn’t started — nothing was charged.`, { label: 'See why', kind, rk });
      continue;
    }
    // The overlay follows it only if the user was watching this build; the question comes either way.
    beginRequest({ ...job, rk }, { explicit: true, showOverlay: watched, note });
  }
  void drain();
}

/* ── asking ───────────────────────────────────────────────────────────────────────────────────── */

type Asked = Extract<BuildGate, { via: 'credits' }> | Extract<BuildGate, { reason: 'unknown' }>;

/**
 * ⚠️ THE STANDING RULE: a gate we could not read is a question, never a guess. The tap on Build in that
 * dialog is the ONLY consent coveredOnly:false ever gets. Try again reads the gate again (a fresh request —
 * the same door an Add goes through, so it may start, ask again or refuse).
 * ⚠️ NO CREDIT WORDING, AND NO CREDIT CHARGE. Generation has no credits lane since 2026-09-13. A gate that
 * says 'credits' anyway (an older or misconfigured server) gets the same plan-words dialog, and its Build is
 * sent coveredOnly:TRUE — the server may use plan, free allowance, pass or cache, and otherwise refuses into
 * the plans state. Nothing on this screen can agree to a credit charge.
 */
function askToBuild(final: HomeBuildJob, gate: Asked, o: { show: boolean; startedAt: number; at?: number }) {
  const key = keyOfJob(final);
  const myEpoch = epoch;
  const id = ++seq;
  const noun = nounOf(final.kind);
  asking = id;
  let answered = false;
  const answer = () => {
    if (answered) return false;
    answered = true;
    if (asking === id) asking = null;
    return true;
  };
  // Still the same ask: not removed, not picked up by a recovery, not from another account.
  const wanted = () => {
    if (epoch !== myEpoch) return false;
    const rec = getBuilds()[key];
    return !!rec && (rec.phase === 'checking' || rec.phase === 'queued') && rec.startedAt === o.startedAt;
  };
  const decline = (g: string) => {
    if (!answer()) return;
    track('home_build_declined', { kind: final.kind, gate: g });
    if (wanted()) { requests.delete(key); clearBuild(key); }
    void drain();
  };
  // A retarget while the dialog was up (a refused website, say) is honoured: the consent is for the build.
  const latest = () => jobs.get(key) || final;
  const credits = gate.via === 'credits';
  const g = credits ? 'credits' : 'unknown';
  // Another read of the gate, as a new request for the same chip. It replaces this ask's record, so the
  // chip never shows two things at once; the overlay is whatever this ask would have shown.
  const tryAgain = () => {
    if (!answer()) return;
    track('home_build_gate_retry', { kind: final.kind, gate: g });
    if (wanted()) beginRequest(latest(), { explicit: true, showOverlay: o.show });
    void drain();
  };
  Alert.alert(
    `Build your ${final.company} ${noun}?`,
    final.kind === 'cover_letter'
      ? 'We could not check your plan just now. Try again, or write this letter now from your plan’s allowance.'
      : 'We could not check your plan just now. Try again, or build it now from your plan’s allowance.',
    [
      { text: 'Not now', style: 'cancel', onPress: () => decline(g) },
      { text: 'Try again', onPress: tryAgain },
      {
        text: 'Build',
        onPress: () => {
          if (!answer()) return;
          if (wanted()) {
            // ⚠️ A 'credits' answer is built covered-only: this dialog never names a charge, so it can never
            // consent to one. Only the unread gate's Build is the consent coveredOnly:false needs.
            if (credits) runBuild(latest(), 'credits', true, { show: o.show, at: o.at });
            else runBuild(latest(), 'unknown', false, { show: o.show, consent: { via: 'unknown' }, at: o.at });
          }
          void drain();
        },
      },
    ],
    { cancelable: true, onDismiss: () => decline(g) },
  );
}

/** Exhausted quota is the plans state — shown, never charged. Nothing started, so it clears once seen. */
function refuse(final: HomeBuildJob, reason: 'quota_exhausted' | 'regen_limit', o: { show: boolean }) {
  const key = keyOfJob(final);
  const prev = getBuilds()[key];
  requests.delete(key);
  refused.add(key);
  track('home_build_fail', { kind: final.kind, reason });
  record(key, final, 'error', prev ? prev.startedAt : Date.now(), { error: { reason, message: GATE_COPY[final.kind][reason] } });
  if (o.show && hostAlive()) { showOverlay(key, final); return; }
  notify(`Your ${final.company} ${nounOf(final.kind)} wasn’t started — your plan has none left.`, { label: 'See why', kind: final.kind, rk: final.rk });
}

/* ── the confirm sheet ────────────────────────────────────────────────────────────────────────── */

/** What one gate answer asks on the sheet: its mode, the pool that would pay (confirm only), and what it may show. */
type Offer = { mode: 'confirm' | 'empty'; pool: Pool | null; usage: GateUsage | null; pass: GatePass | null };

/**
 * The sheet's question for a gate answer — or null when the sheet has none to ask: a cache hit (free, it simply
 * starts), a gate we could not read or one that still says 'credits' (the dialog asks those), and 'regen_limit'
 * (the builder's one free rebuild, which Home's doc lane never asks about — it stays the plans refusal).
 * ⚠️ ONLY THE PAYING POOL'S COUNT, AND ONLY WHILE IT HAS ONE TO GIVE. A plan answer shows the plan's count and a
 * free answer the free one; a count about some other allowance, or one that says nothing is left while the gate
 * says covered, is dropped — the sheet then says less, never a number about money this build does not touch.
 * A pass answer shows the pass and no count at all.
 */
function offerFor(gate: BuildGate): Offer | null {
  if (gate.covered) {
    if (gate.via === 'cache') return null;
    if (gate.via === 'pass') {
      return { mode: 'confirm', pool: 'pass', usage: null, pass: { available: true, forThisEmployer: !!(gate.pass && gate.pass.forThisEmployer) } };
    }
    const u = gate.usage;
    return { mode: 'confirm', pool: gate.via, usage: u && u.pool === gate.via && u.remaining > 0 ? u : null, pass: null };
  }
  if (gate.via === null && gate.reason === 'quota_exhausted') {
    return { mode: 'empty', pool: null, usage: gate.usage || null, pass: null };
  }
  return null;
}

/** Tell every watching Home what the sheet is asking now. ⚠️ Guarded per watcher, like withHost. */
function publishSheet() {
  if (sheet) sheetLast = sheet;
  const now = sheet;
  for (const w of Array.from(sheetWatchers)) {
    try { w(now); } catch { /* one watcher must not stop the others */ }
  }
}

function patchSheet(id: number, patch: Partial<Ask>) {
  if (!sheet || sheet.id !== id) return;
  sheet = { ...sheet, ...patch };
  publishSheet();
}

/** The question goes away, answered or withdrawn. ⚠️ Its Modal starts to leave NOW — see MODAL_GAP_MS. */
function closeSheet(id: number) {
  if (!sheet || sheet.id !== id) return;
  if (sheet.shown) modalAt = Date.now();
  sheet = null;
  if (asking === id) asking = null;
  publishSheet();
}

/** Still the same ask: not removed, not taken over by another request or a recovery, not another account's. */
function sheetWanted(a: Ask): boolean {
  if (a.epoch !== epoch) return false;
  const rec = getBuilds()[a.key];
  return !!rec && (rec.phase === 'checking' || rec.phase === 'queued') && rec.startedAt === a.startedAt;
}

/**
 * Put one build's question on the sheet. ⚠️ THE CALLER HAS CHECKED THE SLOT (`asking`) AND THE OVERLAY, and this
 * takes the slot. The record keeps saying what it said (checking, or its place in line) — nothing has started.
 * The sheet comes up only once MODAL_GAP_MS has passed since the last Modal of ours went away.
 */
function askOnSheet(final: HomeBuildJob, offer: Offer, o: { show: boolean; startedAt: number; at?: number; note?: string | null }) {
  const id = ++seq;
  const wait = Math.max(0, MODAL_GAP_MS - (Date.now() - modalAt));
  asking = id;
  // ⚠️ A PURCHASE THIS CHIP MADE THAT HAS NOT SURFACED YET IS REMEMBERED ACROSS ASKS. Cancel, then Tailor again
  // before the server shows the pass, used to rebuild the sheet from scratch — `bought:false` — and an empty gate
  // answer offered "Generate once" a second time. The memo re-seeds the sheet as paid, so the button is
  // "Use my one-time pass" (a read, never a sale) until the pass is seen or the memo ages out.
  const memo = offer.mode === 'empty' ? paidMemoFor(keyOfJob(final)) : null;
  sheet = {
    id, key: keyOfJob(final), job: final, mode: offer.mode, pool: offer.pool, usage: offer.usage,
    pass: memo ? { available: true, forThisEmployer: false } : offer.pass,
    busy: false, error: memo ? settlingCopy(memo.payment) : (o.note || null),
    bought: !!memo, payment: memo ? memo.payment : null, storeDone: false,
    shown: wait === 0, startedAt: o.startedAt, show: o.show, at: o.at, epoch,
  };
  track('home_build_sheet', { kind: final.kind, mode: offer.mode, pool: offer.pool || 'none' });
  publishSheet();
  if (wait > 0) {
    setTimeout(() => { if (sheet && sheet.id === id && !sheet.shown) patchSheet(id, { shown: true }); }, wait);
  }
}

/**
 * Take a question off the sheet without building: the record it was holding goes (when it is still this ask's),
 * the slot frees, and the line may move. ⚠️ A PASS BOUGHT HERE THAT BUILT NOTHING IS NOT LOST, and the user is
 * told so — it stays theirs, for the next employer they use it on. ⚠️ AND ONE THE SERVER HAS NOT SHOWN YET IS
 * NOT CALLED SAVED: a payment still being applied says so, and an Ask-to-Buy waiting for approval says that
 * nothing has been charged at all.
 */
function withdrawAsk(a: Ask) {
  closeSheet(a.id);
  if (sheetWanted(a)) { requests.delete(a.key); clearBuild(a.key); }
  if (a.bought && a.epoch === epoch) notify(savedCopy(a.payment));
  void drain();
}

/** What a bought-but-unused pass is called when the question goes — by where its payment has got to. */
const savedCopy = (payment: Payment): string =>
  (payment === 'approval' ? SHEET_COPY.savedApproval : payment === 'applying' ? SHEET_COPY.savedApplying : SHEET_COPY.saved);

/**
 * Continue — THE tap that lets a plan, free or pass build start. Sent coveredOnly, and carrying the pool it named,
 * so a build that has to wait for a slot starts on that same pool without asking again, and on nothing else.
 * The overlay (when the build wants it) comes up MODAL_GAP_MS after the sheet went: the hook holds it back.
 */
function sheetContinue(id: number) {
  const a = sheet;
  if (!a || a.id !== id || !a.shown || a.busy || a.mode !== 'confirm' || !a.pool || a.epoch !== epoch) return;
  const pool = a.pool;
  closeSheet(id);
  if (sheetWanted(a)) {
    const job = jobs.get(a.key) || a.job;   // a retarget while the sheet was up is honoured: the consent is for the build
    track('home_build_confirmed', { kind: job.kind, pool, bought: a.bought });
    runBuild(job, pool, true, { show: a.show, consent: { via: 'confirmed', pool }, at: a.at });
  }
  void drain();
}

/**
 * Cancel, the backdrop, the back button, See plans: nothing starts. Refused while a purchase is on its way.
 * ⚠️ EXCEPT CANCEL, ONCE THE STORE HAS ANSWERED (`storeDone`). Everything after that — applying the pass,
 * reading the gate again — is a wait, and a stalled network could hold it for the better part of a minute; the
 * sheet used to be locked for all of it. Nothing here can open the store a second time, so leaving only keeps
 * what was paid for, and withdrawAsk says so. See plans stays shut while busy: it is a screen change, not a way
 * out of the wait.
 */
function sheetDecline(id: number, why: 'cancel' | 'plans'): boolean {
  const a = sheet;
  if (!a || a.id !== id || (a.busy && !(why === 'cancel' && a.storeDone))) return false;
  track(why === 'plans' ? 'home_build_see_plans' : 'home_build_declined', { kind: a.job.kind, gate: a.mode === 'empty' ? 'empty' : String(a.pool) });
  withdrawAsk(a);
  return true;
}

/** See plans: the question goes first (a Modal left up would cover the plans screen), then the screen's route. */
function sheetSeePlans(id: number) {
  if (sheetDecline(id, 'plans')) withHost<void>((h) => h.seePlans(), undefined);
}

type GateRead = { job: HomeBuildJob; gate: BuildGate };

/**
 * Generate once — <price>: buy the one-time pass for THIS employer, then build with it.
 * ⚠️ NEVER A PURCHASE THE BUILD DOES NOT NEED. The gate is read again before the store opens: a question that sat
 * on screen can be out of date (a plan bought on another device, the document built meanwhile, a pass already
 * owned). Covered now is started (cache, pass) or turned into its Continue (plan, free) — no store sheet — and a
 * gate that cannot be read buys nothing.
 * ⚠️ NEVER TWO PURCHASES FROM ONE SHEET. Once a pass is bought here (`bought`) the button USES it: another tap
 * reads the gate again and buys nothing. After the purchase the pass can take a moment to reach the gate, so it
 * is read up to PASS_READS times.
 * ⚠️ AND "BOUGHT" IS THE STORE'S WORD, NOT THE SERVER'S (contract C1). A purchase that COMPLETED but has not
 * surfaced on the server (paid), and one waiting for approval (pending), are both money this sheet must never
 * ask for again — they set `bought` exactly like ok does, and the button becomes "Use my one-time pass", which
 * only re-reads. Offering "Generate once" on either of them is how one need is paid for twice.
 * ⚠️ WHAT MAY START A BUILD FROM HERE: 'pass' (what the tap paid for) or 'cache' (free). A plan or free answer
 * becomes the Continue question instead — nobody said Continue to spending THAT.
 * A cancelled store sheet is not an error, and says nothing.
 */
async function sheetBuyOnce(id: number): Promise<void> {
  const a0 = sheet;
  if (!a0 || a0.id !== id || !a0.shown || a0.busy || a0.mode !== 'empty' || a0.epoch !== epoch) return;
  const myEpoch = epoch;
  const read = (): Promise<GateRead> => stableGate(a0.key, jobs.get(a0.key) || a0.job);
  // Is this still THE question on screen? Once the store has answered, Cancel can take it away under us — and
  // that Cancel has already said what became of the money (withdrawAsk), so everything here goes quiet.
  const mine = () => !!sheet && sheet.id === id && sheet.epoch === epoch;
  let bought = a0.bought;
  let payment: Payment = a0.payment;
  patchSheet(id, { busy: true, error: null });
  try {
    if (!bought) {
      const pre = await read();
      if (epoch !== myEpoch || !mine()) return;
      if (!sheetWanted(a0)) { withdrawAsk(a0); return; }
      if (!(pre.gate.covered === false && pre.gate.via === null && pre.gate.reason === 'quota_exhausted')) {
        landBuyRead(id, pre, { bought: false, failure: null, before: true });
        return;
      }
      track('home_build_buy_once', { kind: a0.job.kind });
      let r: BuyResult;
      try { r = await buyDownloadPass(a0.job.company); } catch { r = { ok: false }; }
      if (epoch !== myEpoch) return;
      // The store has spoken, whatever it said: from here the sheet may be cancelled while it waits.
      patchSheet(id, { storeDone: true });
      if (r.ok || r.paid || r.pending) {
        bought = true;
        // paid = charged, not visible yet; pending = Ask-to-Buy, charged only when it clears. The note says
        // which, because the two are not the same promise to make about someone's money.
        payment = r.ok ? null : r.pending ? 'approval' : 'applying';
        if (payment) paidMemo.set(a0.key, { payment, at: Date.now() });
        track('home_build_pass_bought', { kind: a0.job.kind, settling: payment || 'none' });
        patchSheet(id, {
          bought: true, payment, pass: { available: true, forThisEmployer: false },
          error: payment ? SHEET_COPY[payment] : null,
        });
      } else if (r.cancelled) {
        if (!mine()) return;
        if (!sheetWanted(a0)) { withdrawAsk(a0); return; }
        patchSheet(id, { busy: false });
        return;
      } else {
        // One quiet read: the pass may have landed after all (a slow verification), and then it builds.
        const after = await read();
        if (epoch !== myEpoch || !mine()) return;
        if (!sheetWanted(a0)) { withdrawAsk(a0); return; }
        landBuyRead(id, after, { bought: false, failure: r.message || SHEET_COPY.failed, before: false });
        return;
      }
    }
    let got: GateRead | null = null;
    for (let n = 0; n < PASS_READS; n++) {
      if (n) await sleep(PASS_READ_GAP_MS);
      if (epoch !== myEpoch || !mine()) return;
      if (!sheetWanted(a0)) break;
      got = await read();
      if (epoch !== myEpoch || !mine()) return;
      if (got.gate.covered) break;
    }
    // The chip let go of the question while the store was out: nothing is built, and the pass stays theirs.
    if (!sheetWanted(a0)) { if (mine()) withdrawAsk({ ...a0, bought, payment }); return; }
    landBuyRead(id, got, { bought: true, failure: null, before: false });
  } catch {
    if (epoch !== myEpoch || !mine()) return;
    patchSheet(id, { busy: false, error: bought ? settlingCopy(payment) : SHEET_COPY.failed });
  }
}

/**
 * Purchases made from the sheet whose pass the server has not shown yet, by chip store key. Read by askOnSheet so
 * a re-opened empty sheet starts as PAID. Ends when a gate read shows the chip covered, on forgetHomeBuilds, or
 * after PAID_MEMO_MS (by then the pass has surfaced or support is needed — and a stale "paid" would hide a real
 * buy button from someone who never bought).
 */
const PAID_MEMO_MS = 30 * 60 * 1000;
const paidMemo = new Map<string, { payment: Payment; at: number }>();
function paidMemoFor(key: string): { payment: Payment; at: number } | null {
  const m = paidMemo.get(key);
  if (!m) return null;
  if (Date.now() - m.at > PAID_MEMO_MS) { paidMemo.delete(key); return null; }
  return m;
}

/** The one line for a purchase this sheet made that has not become a usable pass yet. */
const settlingCopy = (payment: Payment): string =>
  (payment === 'approval' ? SHEET_COPY.approval : payment === 'applying' ? SHEET_COPY.applying : SHEET_COPY.paidNotReady);

/**
 * What a gate read around Generate once means for the sheet that asked it (see sheetBuyOnce).
 * `before` = read before any purchase; `bought` = a pass was bought from this sheet; `failure` = the store's words.
 */
function landBuyRead(id: number, got: GateRead | null, how: { bought: boolean; failure: string | null; before: boolean }) {
  const a = sheet;
  if (!a || a.id !== id || a.epoch !== epoch) return;
  // What the money is doing, in this sheet's words: a purchase the server has not shown yet (a.payment) says so;
  // one it HAS shown that still did not start the build is the older paidNotReady.
  const settling = settlingCopy(a.payment);
  const gate = got ? got.gate : UNREAD;
  const job = got ? got.job : (jobs.get(a.key) || a.job);
  if (gate.covered) paidMemo.delete(a.key);
  if (gate.covered && (gate.via === 'cache' || gate.via === 'pass')) {
    closeSheet(id);
    track('home_build_confirmed', { kind: job.kind, pool: gate.via, bought: how.bought });
    runBuild(job, gate.via, true, {
      show: a.show, consent: gate.via === 'pass' ? { via: 'confirmed', pool: 'pass' } : null, at: a.at,
    });
    void drain();
    return;
  }
  const offer = offerFor(gate);
  if (offer && offer.mode === 'confirm') {
    // Covered by the plan or the free allowance after all: a Continue nobody has tapped yet. Its note says what
    // became of the money — the pass bought here is kept, or nothing was bought at all.
    patchSheet(id, {
      mode: 'confirm', pool: offer.pool, usage: offer.usage, pass: offer.pass, busy: false,
      error: how.bought ? savedCopy(a.payment) : SHEET_COPY.covered,
    });
    return;
  }
  if (offer && offer.mode === 'empty') {
    patchSheet(id, {
      busy: false, usage: offer.usage || a.usage,
      error: how.bought ? settling : (how.failure || SHEET_COPY.failed),
    });
    return;
  }
  // Unread, 'credits', 'regen_limit': no answer to act on — and before a purchase, nothing is bought on it.
  patchSheet(id, {
    busy: false,
    error: how.bought ? settling : how.before ? SHEET_COPY.unread : (how.failure || SHEET_COPY.failed),
  });
}

/* ── requests ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ THE ONE DOOR. An explicit Add, Tailor, Write or Refresh IS the intent to build; nothing else is.
 * A request for a chip whose build is already being checked, queued or built opens that build instead —
 * the same employer twice is one build, never two charges.
 */
function requestBuild(job: HomeBuildJob, how: RequestHow) {
  if (!job || !how || how.explicit !== true) return;
  const company = String(job.company || '').trim();
  const rk = String(job.rk || '');
  if (!company || !rk || (job.kind !== 'resume' && job.kind !== 'cover_letter')) return;
  const clean: HomeBuildJob = { ...job, company, rk, website: String(job.website || '') };
  const key = keyOfJob(clean);
  const rec = getBuilds()[key];
  if (rec && (rec.phase === 'checking' || rec.phase === 'queued' || rec.phase === 'building')) {
    if (how.showOverlay !== false) showOverlay(key, rec);
    return;
  }
  beginRequest(clean, how);
}

/**
 * Gate, then start, ask or refuse.
 *
 * `named` resolves to the job under the name and website the server STORED once tracking answers — the
 * gate, the build and the overlay all wait for it, so the chip, the fingerprint and the document never
 * disagree about what the employer is called. It keeps the typed job when tracking merely failed, blanks
 * the website when the server REFUSED it (a job board or ATS host is not this employer's site — the
 * generator would research the board), and resolves null when nothing may be built (the session was
 * refused, or the caller found this employer's document already saved): null stands down, quietly.
 */
function beginRequest(job: HomeBuildJob, how: RequestHow) {
  const key = keyOfJob(job);
  const token = ++seq;
  const myEpoch = epoch;
  const t0 = Date.now();
  requests.set(key, token);
  refused.delete(key);
  jobs.set(key, job);
  queue = queue.filter((q) => q.key !== key);
  record(key, job, 'checking', t0, { stage: CHECKING });
  const wantOverlay = how.showOverlay !== false;
  const live = () => epoch === myEpoch && requests.get(key) === token;
  const standDown = () => {
    if (requests.get(key) === token) requests.delete(key);
    const rec = getBuilds()[key];
    if (epoch === myEpoch && rec && rec.phase === 'checking' && rec.startedAt === t0) { hideOverlay(key); clearBuild(key); }
  };

  void (async () => {
    let answered = false;
    const decided = (async (): Promise<{ final: HomeBuildJob | null; gate: BuildGate | null; ver: number }> => {
      let final: HomeBuildJob | null = job;
      if (how.named) {
        let named: HomeBuildJob | null;
        try { named = await how.named; } catch { named = job; }   // a failed track keeps the typed job
        // The chip and the kind are the caller's request, not tracking's to change — and a blank stored name
        // keeps the typed one rather than send a build for nobody.
        final = named ? { ...named, company: String(named.company || '').trim() || job.company, kind: job.kind, rk: job.rk } : null;
        if (final && live()) {
          jobs.set(key, final);
          if (final.company && final.company !== job.company) patchBuild(key, { company: final.company });
        }
      }
      if (!final || !live()) return { final, gate: null, ver: verOf(key) };
      const g = await stableGate(key, jobs.get(key) || final);
      return { final: g.job, gate: g.gate, ver: g.ver };
    })().finally(() => { answered = true; });

    // `holdMs` lets the new chip land and glow BEFORE a full-screen overlay or a dialog covers it — the user
    // asked for "go to that card, THEN build". The gate is read during the hold, not after.
    const hold = Math.max(0, Number(how.holdMs) || 0);
    if (hold) await sleep(hold);
    if (!answered) await Promise.race([decided, sleep(hold ? 0 : QUICK_GATE_MS)]);
    // ⚠️ NEVER A SILENT WAIT. Past the hold a slow gate used to leave the screen doing nothing for up to
    // 20s; now it says what it is doing, and starts nothing while it does.
    let checking = false;
    if (!answered && wantOverlay && live() && hostAlive()) {
      checking = true;
      showOverlay(key, job);
    }
    const got = await decided;
    if (!live()) return;
    let final = got.final;
    let gate = got.gate;
    if (!final || !gate) { standDown(); return; }
    if (verOf(key) !== got.ver) {
      // Retargeted during the hold, after the gate answered: that answer is for a build that will not run.
      const again = await stableGate(key, jobs.get(key) || final);
      if (!live()) return;
      final = again.job;
      gate = again.gate;
    }
    // Closing "Checking your plan…" is "carry on without this screen", and the build honours it.
    const show = checking ? watching(key) : wantOverlay;
    const same = runs.get(buildKeyOf(final.kind, final));
    if (same && !same.over && same.epoch === epoch) {
      // Already on its way (a recovered flight, another chip for the same posting): nothing to ask or send.
      requests.delete(key);
      joinRun(same, key, final);
      if (show) showOverlay(key, final);
      return;
    }
    // ⚠️ ONLY A CACHE HIT STARTS WITHOUT A QUESTION: that document is already built, and it is free.
    if (gate.covered && gate.via === 'cache') { runBuild(final, gate.via, true, { show }); return; }
    if (checking) hideOverlay(key);
    if (!gate.covered && (gate.via === 'credits' || gate.reason === 'unknown')) {
      // Nobody on Home to answer (it unmounted during the gate read): nothing is asked, nothing starts.
      if (!hostAlive()) { standDown(); return; }
      // One question at a time; this one waits and is asked when the other is answered.
      if (asking !== null) { enqueue(final, null, 'asking'); return; }
      askToBuild(final, gate, { show: wantOverlay, startedAt: t0 });
      return;
    }
    // Covered by the plan, the free allowance or a pass — or nothing left: the sheet's question, before any spend.
    const offer = offerFor(gate);
    if (offer) {
      if (!hostAlive()) { standDown(); return; }
      // ⚠️ The sheet is a Modal, so never over the overlay: Try again's overlay on this very build goes first, and
      // one open on another build (or another question already up) makes this one wait its turn in line.
      if (watching(key)) hideOverlay(key);
      if (asking !== null || overlayUp()) { enqueue(final, null, 'asking'); return; }
      askOnSheet(final, offer, { show, startedAt: t0, note: how.note });
      return;
    }
    if (gate.covered) { standDown(); return; }   // not reached: a covered answer is the cache or an offer
    refuse(final, gate.reason, { show: true });
  })().catch(() => { standDown(); });
}

/**
 * ⚠️ TRY AGAIN NEVER STARTS A SECOND PAID BUILD ON TOP OF THE FIRST. 'network' and 'failed' can both mean
 * the job is still running (a lost 202, a dropped poll, a POST whose answer never came): the service kept
 * that record and re-uses its clientBuildId, which the server dedupes. So Try again first asks the service
 * whether it still holds this build and, if so, picks THAT one back up (recovery never starts a new build);
 * only when nothing is held does a new request start — and that one goes back through the gate.
 * ⚠️ THIS IS THE ONE PLACE A LOST POST IS RESENT, and only this build's: the recovery below passes its own
 * build key as resendKey. Every other record with no job id — another chip's failure — is left alone.
 */
async function retryJob(job: HomeBuildJob) {
  const key = keyOfJob(job);
  const bk = buildKeyOf(job.kind, job);
  const myEpoch = epoch;
  const t0 = Date.now();
  refused.delete(key);
  record(key, job, 'checking', t0, { stage: { stage: 'checking', label: `Checking on your ${nounOf(job.kind)}…`, pct: 0 } });
  let held: InflightMeta[] = [];
  try { held = (await peekInflight()) || []; } catch { held = []; }
  const rec = getBuilds()[key];
  if (epoch !== myEpoch || !rec || rec.phase !== 'checking' || rec.startedAt !== t0) return;   // taken over meanwhile
  const running = runs.get(bk);
  if (running && !running.over && running.epoch === epoch) { joinRun(running, key, job); return; }
  if (held.some((m) => m && m.key === bk)) {
    const run: Run = {
      buildKey: bk, keys: new Map([[key, job.rk]]), job, meta: null, provisional: false, retry: true,
      startedAt: t0, epoch, local: false, pending: false, over: false,
    };
    runs.set(bk, run);
    record(key, job, 'building', t0, { stage: RECOVERING });
    track('home_build_retry', { kind: job.kind, held: true });
    await recoverAll(bk);
    if (epoch !== myEpoch || run.over || run.pending || runs.get(bk) !== run) return;
    // Nothing came back for it: it finished, or the server forgot it, between the look and the pick-up.
    run.over = true;
    runs.delete(bk);
  } else {
    track('home_build_retry', { kind: job.kind, held: false });
  }
  const now = getBuilds()[key];
  // Gone means withdrawn (the chip was removed) — a late Try again must not rebuild what the user took away.
  if (epoch !== myEpoch || !now || (now.phase !== 'checking' && now.phase !== 'building')) return;
  // Overwritten in place, never cleared first: a cleared record closes the overlay the user is looking at.
  beginRequest(jobs.get(key) || job, { explicit: true, showOverlay: true });
}

/* ── withdrawing and retargeting ──────────────────────────────────────────────────────────────── */

/**
 * The chip was removed: take back everything about it that has NOT started — its place in line, a gate
 * still being read, a dialog still up (its Build will find nothing to build), a question on the sheet. A running
 * build is left to finish; its document is saved and comes back if the employer is added again.
 * ⚠️ AND THE SERVICE FORGETS ITS REMEMBERED BUILD. A lost POST (a record with no job id) is a build the user
 * was told had failed; with its chip gone there is no Try again left to consent to resending it, so it is
 * dropped here rather than left for some later explicit retry to find. ⚠️ EXCEPT one this module is still
 * FOLLOWING (running, in the air, or 'pending'): that record is the only way a sweep or a relaunch collects
 * a build that is already paid for, and no follower here is a lost POST.
 */
function cancelQueuedFor(kind: DocKind, rk: string) {
  const key = storeKeyOf(kind, rk);
  const bks = new Set<string>();
  const known = jobs.get(key);
  if (known) bks.add(buildKeyOf(known.kind, known));
  for (const q of queue) if (q.key === key) bks.add(q.buildKey);
  const last = endedFor.get(key);
  if (last) bks.add(last);
  queue = queue.filter((q) => q.key !== key);
  requests.delete(key);
  missedCache.delete(key);
  const rec = getBuilds()[key];
  if (rec && (rec.phase === 'checking' || rec.phase === 'queued')) { hideOverlay(key); clearBuild(key); }
  for (const bk of Array.from(bks)) {
    const run = runs.get(bk);
    if (run && !run.over && run.epoch === epoch) continue;
    forget(bk);
  }
  // Its question on the sheet goes too. ⚠️ Not one whose purchase is on its way: that lands first (sheetBuyOnce),
  // finds nothing left to build, and tells the user the pass is saved.
  const a = sheet;
  if (a && a.key === key && !a.busy) withdrawAsk(a);
}

/** ⚠️ Guarded: a service without forgetInflight (or one that throws) must never break a chip's removal. */
function forget(bk: string) {
  try {
    const p = forgetInflight(bk);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* nothing to forget, or nothing to forget it with */ }
}

/**
 * The job behind a chip changed before its build started — tracking answered with the stored name and
 * website, or refused a website. ⚠️ AND IT REACHES A QUEUED COPY TOO: a build waiting in line used to keep
 * the refused board host and was built around boards.greenhouse.io. A running build cannot change (the
 * server has it); only its display name follows.
 */
function retargetFor(kind: DocKind, rk: string, patch: Partial<HomeBuildJob>) {
  if (!patch || typeof patch !== 'object') return;
  const key = storeKeyOf(kind, rk);
  const fields: Partial<HomeBuildJob> = { ...patch };
  delete fields.kind;
  delete fields.rk;
  if (typeof fields.company === 'string') {
    const c = fields.company.trim();
    if (c) fields.company = c; else delete fields.company;   // a blank name would leave nothing to build for
  }
  if (!Object.keys(fields).length) return;
  const cur = jobs.get(key);
  if (cur) jobs.set(key, { ...cur, ...fields });
  if (sheet && sheet.key === key) patchSheet(sheet.id, { job: { ...sheet.job, ...fields } });
  queue = queue.map((q) => {
    if (q.key !== key) return q;
    const next: HomeBuildJob = { ...q.job, ...fields };
    return { ...q, job: next, buildKey: buildKeyOf(next.kind, next) };
  });
  vers.set(key, verOf(key) + 1);
  const company = fields.company;
  if (company) {
    const rec = getBuilds()[key];
    if (rec && rec.company !== company) patchBuild(key, { company });
    for (const run of Array.from(runs.values())) {
      if (run.keys.has(key) && run.job.rk === rk) run.job = { ...run.job, company };
    }
  }
}

/* ── recovery ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * Make the module belong to whoever is signed in now. The first claim after the bundle loads adopts what is
 * here (it was started moments ago by whoever is signed in); a different account — or nobody — wipes it.
 */
async function claimOwner(): Promise<string | null> {
  let who: string | null = null;
  try { who = await signedInAccount(); } catch { who = null; }
  if (who === null || (owner !== undefined && who !== owner)) forgetAll();
  owner = who;
  return who;
}

/**
 * A recovered build's chip, now that the chips may have loaded. The guessed record moves under the real
 * chip's key (and the overlay with it, if it was open on the guess); a guess that happens to BE the real
 * chip changes nothing.
 */
function remap(run: Run) {
  if (!run.provisional || !run.meta) return;
  const rk = rkForMeta(run.meta);
  if (!rk) return;
  run.provisional = false;
  const kind = run.meta.kind;
  const key = storeKeyOf(kind, rk);
  const guessed = Array.from(run.keys.keys()).filter((k) => k !== key);
  if (!guessed.length) return;
  const prev = getBuilds()[guessed[0]];
  for (const k of guessed) {
    run.keys.delete(k);
    withHost<void>((h) => h.rebind(k, key, rk), undefined);
    const r0 = getBuilds()[k];
    if (r0 && r0.phase === 'building') clearBuild(k);
  }
  run.keys.set(key, rk);
  if (run.job.rk !== rk) run.job = { ...run.job, rk };
  const known = jobs.get(key);
  if (known && buildKeyOf(known.kind, known) === run.buildKey) requests.delete(key);
  queue = queue.filter((q) => !(q.key === key && q.buildKey === run.buildKey));
  const cur = getBuilds()[key];
  if (!cur || cur.phase !== 'building') {
    record(key, { kind, rk, company: (prev && prev.company) || run.job.company }, 'building', run.startedAt, {
      stage: (prev && prev.stage) || RECOVERING,
    });
  }
}

/**
 * A build this screen is not following yet (a relaunch, or a Home that remounted after its runs were
 * forgotten). ⚠️ ITS CHIP MAY NOT EXIST YET: on a cold start recovery can beat the chip row. rkFor gets the
 * first say; failing that the employer's own chip key is the guess, and remap moves it once chips load.
 */
function adoptRecovered(bk: string, meta: InflightMeta, s: BuildStage | null): Run {
  const mapped = rkForMeta(meta);
  const rk = mapped || (meta.employerId ? 'emp_' + meta.employerId : 'name_' + meta.company);
  const key = storeKeyOf(meta.kind, rk);
  const known = jobs.get(key);
  const mine = !!known && buildKeyOf(known.kind, known) === bk;
  // ⚠️ No website, posting text or country in a recovered description — so this job is for display, and
  // for landing only. It is never written to `jobs`: Try again must not rebuild from half a job.
  const job: HomeBuildJob = mine && known
    ? known
    : { kind: meta.kind, rk, company: meta.company, website: '', employerId: meta.employerId ?? null, jobUrl: meta.jobUrl || undefined };
  const run: Run = {
    buildKey: bk, keys: new Map([[key, rk]]), job, meta, provisional: !mapped, retry: false,
    startedAt: Number(meta.startedAt) || Date.now(), epoch, local: false, pending: false, over: false,
  };
  runs.set(bk, run);
  // A tap on the same build that is still reading its gate stands down: the build it would start is running.
  if (mine) requests.delete(key);
  queue = queue.filter((q) => q.buildKey !== bk);
  const rec = getBuilds()[key];
  if (!rec || rec.phase !== 'building') {
    record(key, { kind: meta.kind, rk, company: (rec && rec.company) || meta.company }, 'building', run.startedAt, { stage: s || RECOVERING });
  } else if (s) {
    stageTo(key, s);
  }
  return run;
}

function recoveredStage(bk: string, s: BuildStage, meta: InflightMeta, who: string) {
  if (owner !== who || !bk || !meta) return;
  const run = runs.get(bk);
  if (run && !run.over && run.epoch === epoch) {
    if (run.provisional) remap(run);
    // ⚠️ The service announces every joined build as 'recovering'. One this screen already follows has a
    // real stage ('writing' spans the whole AI call), and must not read "Picking up…" for a minute.
    const followed = Array.from(run.keys.keys()).some((k) => { const r = getBuilds()[k]; return !!(r && r.stage); });
    if (s && s.stage === 'recovering' && followed) return;
    stageRun(run, s);
    return;
  }
  // ⚠️ Just LANDED is not running: no flip back to building. A build that ended in an error may be alive
  // after all (its answer was lost, not its job), so that one is picked up.
  const e = endedRecently(bk);
  if (e && e.ok) return;
  adoptRecovered(bk, meta, s);
}

function landRecovered(bk: string, meta: InflightMeta, result: BuildResult) {
  let run = runs.get(bk);
  // The tap that started it is still waiting on the SAME flight, and lands it itself — never twice.
  if (run && run.local && !run.over) return;
  if (!run || run.over || run.epoch !== epoch) {
    const e = endedRecently(bk);
    // Already told: a landing twice, a failure repeated, or a stale failure arriving after the success.
    if (e && (e.ok || (!result.ok && result.reason === e.reason))) return;
    run = adoptRecovered(bk, meta, null);
  }
  settle(run, result);
}

type Recovered = { key: string; meta: InflightMeta; result: BuildResult };

/**
 * Join every build the service still holds for this account — running in this process, remembered from
 * before a relaunch with a job to poll, or a 'pending' one worth a quiet look — and land each one when it ends.
 * ⚠️ RECOVERY IS NOT A NEW BUILD: the service polls a job that exists. That is why a mount may call this.
 * A lost POST (no job id) is resent under its own clientBuildId ONLY when `resendKey` is its build key —
 * which only retryJob passes, for the build the user tapped Try again on. Mount and sweep pass nothing.
 * ⚠️ EACH BUILD LANDS WHEN IT ENDS (onLanded), not when the slowest one does: a finished resume used to sit
 * on 'building' for minutes behind someone else's letter. The array at the end is only the belt — it lands
 * whatever an older service never called back for, and settles the 'loose' bookkeeping.
 */
async function recoverAll(resendKey: string | null = null): Promise<void> {
  const who = await claimOwner();
  if (!who) return;
  const myEpoch = epoch;
  // A different account (claimOwner) or a forgotten session (forgetHomeBuilds) — nothing lands any more.
  const here = () => owner === who && epoch === myEpoch;
  const staged = new Set<string>();
  const answered = new Set<string>();
  const land = (x: Recovered | null | undefined) => {
    if (!x || typeof x.key !== 'string' || !x.meta || !x.result || answered.has(x.key)) return;
    answered.add(x.key);
    if (!here()) return;
    try { landRecovered(x.key, x.meta, x.result); } catch { /* the next one still lands */ }
  };
  let results: Recovered[] = [];
  try {
    const got = await resumeInflightBuilds(
      (bk, s, meta) => {
        staged.add(bk);
        if (!here()) return;
        try { recoveredStage(bk, s, meta, who); } catch { /* one bad record must not end the others' recovery */ }
      },
      { resendKey, onLanded: (bk: string, meta: InflightMeta, result: BuildResult) => land({ key: bk, meta, result }) },
    );
    results = Array.isArray(got) ? got : [];
  } catch { results = []; }
  if (!here()) return;
  for (const x of results) land(x);
  // The service promises an answer for every build it announced; this is only the belt to that brace, so a
  // record can never be left saying "building" forever.
  const loose = Array.from(staged)
    .filter((bk) => !answered.has(bk))
    .map((bk) => runs.get(bk))
    .filter((r): r is Run => !!r && !r.over && !r.local && !r.pending && r.epoch === epoch);
  if (!loose.length) return;
  for (const run of loose) {
    if (run.retry) continue;   // retryJob decides for its own
    markPending(run, false);
  }
}

function scheduleSweep() {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => { sweepTimer = null; void sweep(); }, SWEEP_MS);
}

/**
 * Look again at builds that went 'pending'. ⚠️ ONLY the recovery's answer decides: the service stops
 * LISTING a build once it is past its deadline while still keeping it for a quiet look, so "not in
 * peekInflight" would declare a live, charged build lost. It is given up on only past GIVE_UP_MS, when the
 * service itself has dropped it.
 */
async function sweep() {
  const myEpoch = epoch;
  const waiting = () => Array.from(runs.values()).filter((r) => r.pending && !r.over && r.epoch === epoch);
  if (!waiting().length || !host) return;   // a Home that mounts later recovers them itself
  await recoverAll();
  if (epoch !== myEpoch) return;
  const now = Date.now();
  for (const run of waiting()) {
    if (now - run.startedAt < GIVE_UP_MS) continue;
    const job = run.job;
    dropRun(run);
    track('home_build_fail', { kind: job.kind, reason: 'lost' });
    notify(`We lost track of your ${job.company} ${nounOf(job.kind)}. If it finished, it will be on its card.`);
  }
  if (waiting().length) scheduleSweep();
}

/* ── forgetting ───────────────────────────────────────────────────────────────────────────────── */

function forgetAll() {
  epoch++;
  queue = [];
  runs.clear();
  jobs.clear();
  requests.clear();
  vers.clear();
  refused.clear();
  missedCache.clear();
  paidMemo.clear();   // another account's purchase memory must never seed this account's sheet
  ended.clear();
  endedFor.clear();
  asking = null;
  // ⚠️ So did the question on the sheet. A purchase already on its way lands nowhere: every step checks the epoch.
  sheet = null;
  sheetLast = null;
  publishSheet();
  drainAgain = false;
  if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
  withHost<void>((h) => h.hideAll(), undefined);
  clearAllBuilds();
}

/**
 * Account switch or a refused session (EmployerHome's forgetAccountCache calls this). Clears the line and
 * every record, and starts a new epoch so nothing already on its way from the old account lands here.
 * ⚠️ Display and bookkeeping only: the builds themselves run on, and land on the server for their owner.
 */
export function forgetHomeBuilds(): void {
  forgetAll();
}

/* ── the hook ─────────────────────────────────────────────────────────────────────────────────── */

type Bound = { key: string; kind: DocKind; rk: string; company: string; visible: boolean };

const CLOSED: OverlayView = { visible: false, key: null, kind: 'resume', company: '', stage: null, done: false, error: null, canRetry: false };

const noop = () => {};
/** The sheet before any question was ever asked: closed, and every button a no-op. */
const NO_SHEET: ConfirmSheetView = {
  visible: false, mode: 'confirm', kind: 'resume', company: '', usage: null, pass: null, busy: false, error: null,
  onContinue: noop, onCancel: noop, onBuyOnce: noop, onSeePlans: noop,
};

/** How long is left of the breath between two Modals of ours (MODAL_GAP_MS); 0 when none is. */
const gapLeft = () => Math.max(0, MODAL_GAP_MS - (Date.now() - modalAt));

/**
 * Home's builds.
 *  request         — the one door: gate, then start (a cache hit) / ask on the sheet / ask the dialog / refuse
 *                    (never on focus, switch or mount).
 *  openOverlayFor  — bind the overlay to a chip's build and show its live stage, done or error.
 *  cancelQueued    — take back what has not started for a removed chip, and its lost POST (forgetInflight).
 *  retarget        — the job behind a chip changed before its build started.
 *  overlay         — what BuildingOverlay shows; dismissOverlay hides it (the build continues).
 *  retryOverlay    — Try again on the bound build (only when overlay.canRetry) — the only resend of a lost POST.
 *  confirm         — what GenerateConfirmSheet shows (contract 5). Its Continue and its Generate once are the only
 *                    taps that let a plan, free or pass build start; Cancel and See plans start nothing.
 * `onSeePlans` is the screen's: the overlay's See plans is wired by the caller from overlay.error, the sheet's
 * calls it after the question has gone, and this hook never navigates on its own — leaving for the plans screen
 * is always the user's tap.
 */
export function useHomeBuilds(opts: {
  alive: () => boolean;
  rkFor: (meta: InflightMeta) => string | null;
  onLanded: (job: HomeBuildJob, docId: number | null, cached: boolean, watched: boolean) => void;
  onNotice: (text: string, action?: { label: string; kind: DocKind; rk: string }) => void;
  onSeePlans: () => void;
}): {
  request: (job: HomeBuildJob, how: { explicit: true; holdMs?: number; named?: Promise<HomeBuildJob | null>; showOverlay?: boolean }) => void;
  openOverlayFor: (kind: DocKind, rk: string) => void;
  cancelQueued: (kind: DocKind, rk: string) => void;
  retarget: (kind: DocKind, rk: string, patch: Partial<HomeBuildJob>) => void;
  overlay: OverlayView;
  dismissOverlay: () => void;
  retryOverlay: () => void;
  confirm: ConfirmSheetView;
} {
  // ⚠️ THE LATEST CALLBACKS LIVE IN A REF. Home hands down fresh arrows on every render; the module calls
  // whichever are current when a build lands, minutes after the render that started it.
  const latest = useRef(opts);
  latest.current = opts;

  const [bound, setBoundState] = useState<Bound | null>(null);
  // ⚠️ THE REF IS WRITTEN WITH THE STATE, NOT AT THE NEXT RENDER. The module reads it to decide whether a
  // build is being watched (a done stamp vs a notice). Synced only at render, a result that arrived before
  // React re-rendered read the PREVIOUS overlay — a build on screen looked hidden, and its "ready" became a
  // notice under a spinner that never stamped done.
  const boundRef = useRef<Bound | null>(null);
  const setBound = useCallback((next: Bound | null) => {
    // A window that closes is a Modal leaving: whatever comes up next waits out MODAL_GAP_MS.
    const was = boundRef.current;
    if (was && was.visible && !(next && next.visible)) modalAt = Date.now();
    boundRef.current = next;
    setBoundState(next);
  }, []);
  // The question the sheet is asking, mirrored from the module (null = none).
  const [ask, setAsk] = useState<Ask | null>(sheet);
  // Bumped when a Modal gap ends, so an overlay held back by it comes up.
  const [gapTick, setGapTick] = useState(0);

  // Subscribed to the ONE bound record, and only while the overlay is up: a hidden overlay costs Home no renders.
  const rec = useTargetBuild(bound ? bound.kind : 'resume', bound && bound.visible ? bound.rk : null);

  useEffect(() => {
    const me: Host = {
      alive: () => !!latest.current.alive(),
      watching: (key) => { const b = boundRef.current; return !!b && b.visible && b.key === key; },
      overlayUp: () => !!(boundRef.current && boundRef.current.visible),
      show: (key, kind, rk, company) => setBound({ key, kind, rk, company, visible: true }),
      hide: (key) => { const b = boundRef.current; if (b && b.key === key && b.visible) setBound({ ...b, visible: false }); },
      hideAll: () => { const b = boundRef.current; if (b && b.visible) setBound({ ...b, visible: false }); },
      rebind: (from, to, rk) => { const b = boundRef.current; if (b && b.key === from) setBound({ ...b, key: to, rk }); },
      rkFor: (meta) => latest.current.rkFor(meta),
      landed: (job, docId, cached, watched) => latest.current.onLanded(job, docId, cached, watched),
      notice: (text, action) => latest.current.onNotice(text, action),
      seePlans: () => latest.current.onSeePlans(),
    };
    host = me;
    let off = false;
    const pendingLeft = () => Array.from(runs.values()).some((r) => r.pending && !r.over && r.epoch === epoch);
    // A 'pending' build from before the Dashboard round trip keeps being looked at (sweeps stop with no Home).
    if (pendingLeft()) scheduleSweep();
    // A build that was running when Home unmounted (or the app was killed) is picked back up: its chip and
    // cards show it again, and the document it paid for is shown when it lands. Once per mount, on purpose.
    // ⚠️ No resendKey: a mount polls what the server has and resends NOTHING (a lost POST waits for its Try again).
    void recoverAll()
      .then(() => { if (!off && host === me && pendingLeft()) scheduleSweep(); })
      .catch(() => {});
    // ⚠️ Not a new build: whatever waited in line was an explicit request inside its expiry, and it is
    // re-gated before it starts — a cache hit goes, a Continue already tapped goes on its own pool, anything else
    // is asked (the sheet or the dialog), nothing goes after QUEUE_TTL_MS, and drain checks whose line it is first.
    void drain();
    return () => {
      off = true;
      if (host === me) host = null;
      // ⚠️ A QUESTION NOBODY CAN SEE IS WITHDRAWN, never left holding the one question slot until some later Home.
      // Not one whose purchase is on its way: the money is spent, so that one lands by itself (sheetBuyOnce).
      const a = sheet;
      if (!host && a && !a.busy) withdrawAsk(a);
    };
  }, [setBound]);

  // The sheet's question, mirrored. Re-read once subscribed: a question published between the first render and
  // this effect would otherwise be missed.
  useEffect(() => {
    const watch = (a: Ask | null) => setAsk(a);
    sheetWatchers.add(watch);
    setAsk(sheet);
    return () => { sheetWatchers.delete(watch); };
  }, []);

  // A bound record that went away (cleared, forgotten, withdrawn) closes the window instead of leaving it
  // open to reappear over some unrelated later build under the same key.
  useEffect(() => {
    if (bound && bound.visible && !rec && !getBuilds()[bound.key]) setBound({ ...bound, visible: false });
  }, [bound, rec, setBound]);

  // An overlay asked for inside a Modal gap comes up when the gap ends (see `overlay` below).
  useEffect(() => {
    if (!bound || !bound.visible) return;
    const left = gapLeft();
    if (left <= 0) return;
    const id = setTimeout(() => setGapTick((n) => n + 1), left);
    return () => clearTimeout(id);
  }, [bound, gapTick]);

  const request = useCallback((job: HomeBuildJob, how: RequestHow) => requestBuild(job, how), []);

  const openOverlayFor = useCallback((kind: DocKind, rk: string) => {
    // ⚠️ Not over a question on the sheet (see showOverlay): the chip's build is still there once it is answered.
    if (sheet) return;
    const key = storeKeyOf(kind, rk);
    const r = getBuilds()[key];
    if (!r) return;
    setBound({ key, kind, rk, company: r.company, visible: true });
  }, [setBound]);

  const cancelQueued = useCallback((kind: DocKind, rk: string) => cancelQueuedFor(kind, rk), []);

  const retarget = useCallback((kind: DocKind, rk: string, patch: Partial<HomeBuildJob>) => retargetFor(kind, rk, patch), []);

  /** Hiding never touches the build. A refusal that was seen stops marking its chip; the line may move. */
  const dismissOverlay = useCallback(() => {
    const b = boundRef.current;
    if (!b) return;
    if (b.visible) setBound({ ...b, visible: false });
    if (refused.has(b.key)) {
      refused.delete(b.key);
      const r = getBuilds()[b.key];
      if (r && r.phase === 'error') clearBuild(b.key);
    }
    void drain();
  }, [setBound]);

  const retryOverlay = useCallback(() => {
    const b = boundRef.current;
    if (!b) return;
    const r = getBuilds()[b.key];
    const job = jobs.get(b.key);
    if (!r || r.phase !== 'error' || !r.error || !RETRYABLE.has(r.error.reason) || !job) return;
    void retryJob(job);
  }, []);

  const overlay: OverlayView = useMemo(() => {
    if (!bound) return CLOSED;
    const r = bound.visible ? rec : null;
    if (!r) return { ...CLOSED, key: bound.key, kind: bound.kind, company: bound.company };
    const err = r.phase === 'error' ? (r.error || { reason: 'failed', message: '' }) : null;
    const stage = r.phase === 'queued'
      ? { ...QUEUED_VIEW, label: (r.stage && r.stage.label) || QUEUED_VIEW.label }
      : r.phase === 'done' ? DONE : r.phase === 'error' ? null : r.stage;
    return {
      // ⚠️ HELD BACK FOR THE MODAL GAP. Right after the sheet (or this overlay) went away, raising the overlay is
      // the refused second presentation MODAL_GAP_MS exists for — so it comes up when the gap ends (gapTick).
      // The build is watched all the same meanwhile (boundRef): its landing is a done stamp, never a notice.
      visible: gapLeft() <= 0,
      key: bound.key,
      kind: bound.kind,
      company: r.company || bound.company,
      stage,
      done: r.phase === 'done',
      error: err ? { reason: err.reason, message: err.message } : null,
      canRetry: !!err && RETRYABLE.has(err.reason) && jobs.has(bound.key),
    };
    // gapTick is read through gapLeft(): it is the re-render that lets the held-back overlay up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bound, rec, gapTick]);

  /**
   * What GenerateConfirmSheet shows. ⚠️ EVERY BUTTON NAMES ITS QUESTION: a tap meant for one question can never
   * answer the next (a sheet that closed and reopened for another build between the render and the tap), and
   * each handler checks it again. Closing keeps the last words on screen rather than flashing blank ones.
   */
  const confirm: ConfirmSheetView = useMemo(() => {
    const a = ask || sheetLast;
    if (!a) return NO_SHEET;
    const id = a.id;
    return {
      visible: !!ask && ask.shown && ask.epoch === epoch,
      mode: a.mode,
      kind: a.job.kind,
      company: a.job.company,
      usage: a.usage,
      pass: a.pass,
      busy: !!ask && ask.busy,
      payment: a.payment,
      // ⚠️ Cancel comes back once the STORE has answered (Ask.storeDone): nothing left in this question can open
      // it again, so leaving simply keeps what was paid for. Before that, a tap must not slip between
      // "Generate once" and the store's own sheet.
      canCancel: !!ask && ask.busy && ask.storeDone,
      error: a.error,
      onContinue: () => sheetContinue(id),
      onCancel: () => { sheetDecline(id, 'cancel'); },
      onBuyOnce: () => { sheetBuyOnce(id).catch(() => {}); },
      onSeePlans: () => sheetSeePlans(id),
    };
  }, [ask]);

  return useMemo(
    () => ({ request, openOverlayFor, cancelQueued, retarget, overlay, dismissOverlay, retryOverlay, confirm }),
    [request, openOverlayFor, cancelQueued, retarget, overlay, dismissOverlay, retryOverlay, confirm],
  );
}
