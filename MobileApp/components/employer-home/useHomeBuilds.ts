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
// ⚠️ NEVER A SILENT CHARGE (the letters auto-regen drain). request() is the only way in, it demands
// `explicit: true` (in its type AND again at run time), and a build starts on its own ONLY when the server's
// dry-run gate says the plan, the free allowance, a download pass or the cache covers it — and then it is
// sent coveredOnly, so the server refuses rather than fall through to credits. Credits, or a gate we could
// not read, is an Alert first; exhausted quota is the plans state. Mounting, focusing, switching chips or
// modes starts nothing new: the mount only re-joins builds the server already HAS (a job id to poll),
// and a build that waited in line for a free slot goes back through the gate before it starts.
// ⚠️ A LOST POST IS NEVER RESENT BY A MOUNT, A SWEEP OR ANOTHER CHIP'S TRY AGAIN. A record with no job id is
// a build the user was told had failed (or whose chip they removed); resending it from a remount charged
// them for something they had walked away from. Only Try again on THAT build passes its key as resendKey.
//
// ⚠️ THE ASYNC LANE CHARGES SOMEONE WHO WALKS AWAY. Closing the overlay, leaving Home, killing the app —
// none of them stop a build the server has, so nothing here is called cancel and no copy may say a build
// was cancelled. Only what has NOT started can be withdrawn: a gate still being read, a question still on
// screen, a place in the queue (cancelQueued).
//
// ⚠️ MODULE SCOPE, NOT HOOK STATE. EmployerHome unmounts whenever the Dashboard is shown and a build outlives
// it, so the queue, the runs and the records live in this module; the hook is only the screen watching them
// right now (the "host"). A build that lands with nobody mounted still updates the store — its notice and
// onLanded go to whichever Home is mounted when it lands, or to nobody.
//
// ⚠️ NOTHING TICKS HERE. Stages go to the store; the hook's only React state is which record the overlay is
// bound to, and it subscribes to that ONE record only while the overlay is up. The creeping percentage is
// useCreepPct inside the small components that draw it. There are no Animated values in this file.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  checkBuildGate, gateJobFor, buildForEmployer, resumeInflightBuilds, activeBuildCount, buildKeyOf, peekInflight,
  signedInAccount, forgetInflight, MAX_PARALLEL_BUILDS,
  type DocKind, type BuildGate, type BuildStage, type BuildResult, type InflightMeta,
} from '../../services/homeAddEmployer';
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

type NoticeAction = { label: string; kind: DocKind; rk: string };

type RequestHow = {
  explicit: true;
  /** Lets the new chip land and glow BEFORE an overlay or a dialog covers it. The gate is read during it. */
  holdMs?: number;
  /** The job under the name and website tracking settled on. null = build nothing (see beginRequest). */
  named?: Promise<HomeBuildJob | null>;
  showOverlay?: boolean;
};

/* ── timings and copy ─────────────────────────────────────────────────────────────────────────── */

/**
 * After the chip's hold, how long the dry-run gate may take before it counts as unread. The service allows
 * a request 20s; past this the answer is 'unknown', which ASKS — never a guess that it was covered.
 */
const GATE_WAIT_MS = 8000;
/** With no hold, how long a quick gate gets before "Checking your plan…" goes up, so a fast one never flashes it. */
const QUICK_GATE_MS = 300;
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

/* ── module state ─────────────────────────────────────────────────────────────────────────────── */

/** What the user already agreed to on a dialog, carried with a build that then had to wait for a slot. */
type Consent = { via: 'credits'; credits: number } | { via: 'unknown' };

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
function showOverlay(key: string, t: { kind: DocKind; rk: string; company: string }) {
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
 */
async function stableGate(key: string, job: HomeBuildJob): Promise<{ job: HomeBuildJob; gate: BuildGate; ver: number }> {
  let cur = job;
  for (let n = 0; n < 3; n++) {
    const v = verOf(key);
    const gate = await readGate(cur);
    if (verOf(key) === v) return { job: cur, gate, ver: v };
    cur = jobs.get(key) || cur;
  }
  return { job: cur, gate: UNREAD, ver: verOf(key) };
}

/** Whether a dialog the user already said Build on covers what the gate says NOW. */
function consentCovers(c: Consent | null, gate: BuildGate): boolean {
  if (!c || gate.covered) return false;
  // "It may use credits" accepted with no number is what an immediate start would have spent anyway; a
  // named number covers that number or less. A gate that went unreadable since is asked again.
  if (gate.via === 'credits') return c.via === 'unknown' || gate.credits <= c.credits;
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
 * is never a pre-approved charge (a dialog the user already said Build on is the one exception: it is not
 * asked twice for the same thing, and only up to what it named).
 * ⚠️ A QUESTION NEEDS SOMEONE TO ANSWER IT: with no Home mounted, a dialog already up, or a build being
 * watched in the overlay, a build that needs asking keeps its place and is asked on the next pass.
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
      if (gate.covered) {
        queue = queue.filter((x) => x.id !== q.id);
        runBuild(job, gate.via, true, { at: q.at });
        continue;
      }
      if (consentCovers(q.consent, gate)) {
        queue = queue.filter((x) => x.id !== q.id);
        runBuild(job, gate.via === 'credits' ? 'credits' : 'unknown', false, { consent: q.consent, at: q.at });
        continue;
      }
      if (gate.via === 'credits' || gate.reason === 'unknown') {
        if (asking !== null || !hostAlive() || overlayUp()) continue;   // keeps its place
        queue = queue.filter((x) => x.id !== q.id);
        askToBuild(job, gate, { show: false, startedAt: rec.startedAt, at: q.at });
        continue;
      }
      queue = queue.filter((x) => x.id !== q.id);
      refuse(job, gate.reason, { show: hostAlive() && !overlayUp() });
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
 * `coveredOnly` is the consent: true = the server may spend only plan, free allowance, pass or cache and
 * must refuse (402 → the plans state) rather than fall through to credits. ⚠️ false ONLY after the user
 * tapped Build on a dialog that named a credit charge, or said the plan could not be read — `consent`
 * says which, so a build that then has to wait for a slot is not asked the same question twice.
 */
function runBuild(
  final: HomeBuildJob, via: string, coveredOnly: boolean,
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
    enqueue(final, coveredOnly ? null : (o.consent || null), 'capacity', o.at);
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
  buildForEmployer(
    {
      company: final.company, website: final.website, jobUrl: final.jobUrl, postingUrl: final.postingUrl,
      jobText: final.jobText, jobTitle: final.jobTitle, employerId: final.employerId ?? null,
      country: final.country ?? null, coveredOnly, kind: final.kind,
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
          enqueue(jobs.get(k) || { ...final, rk }, coveredOnly ? null : (o.consent || null), 'capacity', o.at);
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

/* ── asking ───────────────────────────────────────────────────────────────────────────────────── */

type Asked = Extract<BuildGate, { via: 'credits' }> | Extract<BuildGate, { reason: 'unknown' }>;

/**
 * ⚠️ THE STANDING RULE: credits are a question with the number in it; a gate we could not read is a
 * question too, never a guess. The tap on Build is the ONLY consent coveredOnly:false ever gets.
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
  if (gate.via === 'credits') {
    const n = gate.credits;
    Alert.alert(`Build your ${final.company} ${noun}?`, `This uses ${n} credit${n === 1 ? '' : 's'}.`, [
      { text: 'Cancel', style: 'cancel', onPress: () => decline('credits') },
      {
        text: 'Build',
        onPress: () => {
          if (!answer()) return;
          if (wanted()) runBuild(latest(), 'credits', false, { show: o.show, consent: { via: 'credits', credits: n }, at: o.at });
          void drain();
        },
      },
    ], { cancelable: true, onDismiss: () => decline('credits') });
    return;
  }
  Alert.alert(
    `Build your ${final.company} ${noun}?`,
    final.kind === 'cover_letter'
      ? 'We could not check your plan just now, so writing this letter may use your plan allowance or credits.'
      : 'We could not check your plan just now, so this build may use your plan allowance or credits.',
    [
      { text: 'Not now', style: 'cancel', onPress: () => decline('unknown') },
      // The dialog names credits, so this tap is the explicit consent coveredOnly:false needs.
      {
        text: 'Build',
        onPress: () => {
          if (!answer()) return;
          if (wanted()) runBuild(latest(), 'unknown', false, { show: o.show, consent: { via: 'unknown' }, at: o.at });
          void drain();
        },
      },
    ],
    { cancelable: true, onDismiss: () => decline('unknown') },
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
    if (gate.covered) { runBuild(final, gate.via, true, { show }); return; }
    if (checking) hideOverlay(key);
    if (gate.via === 'credits' || gate.reason === 'unknown') {
      // Nobody on Home to answer (it unmounted during the gate read): nothing is asked, nothing starts.
      if (!hostAlive()) { standDown(); return; }
      // One dialog at a time; this one waits and is asked when the other is answered.
      if (asking !== null) { enqueue(final, null, 'asking'); return; }
      askToBuild(final, gate, { show: wantOverlay, startedAt: t0 });
      return;
    }
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
 * still being read, a dialog still up (its Build will find nothing to build). A running build is left to
 * finish; its document is saved and comes back if the employer is added again.
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
  const rec = getBuilds()[key];
  if (rec && (rec.phase === 'checking' || rec.phase === 'queued')) { hideOverlay(key); clearBuild(key); }
  for (const bk of Array.from(bks)) {
    const run = runs.get(bk);
    if (run && !run.over && run.epoch === epoch) continue;
    forget(bk);
  }
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
  ended.clear();
  endedFor.clear();
  asking = null;
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

/**
 * Home's builds.
 *  request         — the one door: gate, then start / ask / refuse (never on focus, switch or mount).
 *  openOverlayFor  — bind the overlay to a chip's build and show its live stage, done or error.
 *  cancelQueued    — take back what has not started for a removed chip, and its lost POST (forgetInflight).
 *  retarget        — the job behind a chip changed before its build started.
 *  overlay         — what BuildingOverlay shows; dismissOverlay hides it (the build continues).
 *  retryOverlay    — Try again on the bound build (only when overlay.canRetry) — the only resend of a lost POST.
 * `onSeePlans` is the screen's: the overlay's See plans is wired by the caller from overlay.error, and this
 * hook never navigates on its own — a refusal is shown, and leaving for the plans screen is the user's tap.
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
    boundRef.current = next;
    setBoundState(next);
  }, []);

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
    // re-gated before it starts — covered goes, credits asks, nothing goes after QUEUE_TTL_MS, and drain
    // checks whose line it is before anything goes out.
    void drain();
    return () => {
      off = true;
      if (host === me) host = null;
    };
  }, [setBound]);

  // A bound record that went away (cleared, forgotten, withdrawn) closes the window instead of leaving it
  // open to reappear over some unrelated later build under the same key.
  useEffect(() => {
    if (bound && bound.visible && !rec && !getBuilds()[bound.key]) setBound({ ...bound, visible: false });
  }, [bound, rec, setBound]);

  const request = useCallback((job: HomeBuildJob, how: RequestHow) => requestBuild(job, how), []);

  const openOverlayFor = useCallback((kind: DocKind, rk: string) => {
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
      visible: true,
      key: bound.key,
      kind: bound.kind,
      company: r.company || bound.company,
      stage,
      done: r.phase === 'done',
      error: err ? { reason: err.reason, message: err.message } : null,
      canRetry: !!err && RETRYABLE.has(err.reason) && jobs.has(bound.key),
    };
  }, [bound, rec]);

  return useMemo(
    () => ({ request, openOverlayFor, cancelQueued, retarget, overlay, dismissOverlay, retryOverlay }),
    [request, openOverlayFor, cancelQueued, retarget, overlay, dismissOverlay, retryOverlay],
  );
}
