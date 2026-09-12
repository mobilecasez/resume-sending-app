// AI Hub — new feature. Safe to delete without affecting existing app.
//
// What every Home build is doing RIGHT NOW, per target, observable from anywhere.
//
// A build used to live inside EmployerHome as one overlay's state, so the moment the user tapped "Keep
// it building in the background" nothing on Home could say that a build existed at all. Now a build is a
// record here, keyed by kind + the chip's render key, and three different surfaces read the SAME record:
//   • the chip           → a thin progress track and '<pct>%'
//   • the carousel cards → the writing loader with a live percentage, "Tap to watch"
//   • the overlay        → the full scene, re-openable from either of the above
// useHomeBuilds (components/employer-home) is the only writer; everything else only subscribes.
//
// ⚠️ RE-RENDER DISCIPLINE (the reason this is an external store and not React context). Stage ticks
// arrive every 1.5 s per running build, and up to three run at once. useTargetBuild reads through
// useSyncExternalStore with a PER-KEY snapshot: the store replaces only the record that changed and
// keeps every other record's object identity, so a chip re-renders when ITS build moves and never when a
// sibling's does. patchBuild drops no-op patches for the same reason — a poll that repeats the stage it
// already reported must not re-render three chips and a carousel.
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash). Nothing here is Animated. useCreepPct is plain
// React state: a component that shows the ticking number renders it as TEXT, inside a small isolated
// React.memo, and any bar it drives follows the WHOLE number through a native-driver scaleX. Never
// feed this into a JS-driven Animated value or a layout prop.
//
// ⚠️ NOT A RECORD OF MONEY. Whether a build was charged, and whether it may be resumed, is decided by
// services/homeAddEmployer's persisted in-flight records and the server. Clearing a record here only
// stops SHOWING a build; it never cancels one (nothing can — the async job outlives the app).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { BuildStage, DocKind } from './homeAddEmployer';

export type BuildPhase = 'checking' | 'queued' | 'building' | 'done' | 'error';

export type TargetBuild = {
  key: string;
  kind: DocKind;
  /** The chip render key this build is for. */
  rk: string;
  company: string;
  phase: BuildPhase;
  stage: BuildStage | null;
  error: { reason: string; message: string } | null;
  docId: number | null;
  startedAt: number;
  updatedAt: number;
};

/** Replaced (never mutated) on every change, so getBuilds() is itself a valid snapshot. */
let builds: Record<string, TargetBuild> = {};
const listeners = new Set<() => void>();

function emit() {
  // A copy: a listener may unsubscribe (a chip unmounting) while we are notifying.
  for (const fn of Array.from(listeners)) {
    // ⚠️ One throwing subscriber must not starve the rest of an update about a build still running.
    try { fn(); } catch { /* ignore */ }
  }
}

export function storeKeyOf(kind: DocKind, rk: string): string {
  return kind + '|' + rk;
}

export function getBuilds(): Record<string, TargetBuild> {
  return builds;
}

export function buildFor(kind: DocKind, rk: string): TargetBuild | null {
  return builds[storeKeyOf(kind, rk)] || null;
}

export function setBuild(b: TargetBuild): void {
  if (!b || !b.key) return;
  const now = Date.now();
  const next = { ...b, startedAt: b.startedAt || now, updatedAt: b.updatedAt || now };
  forgetCreepIfRestarted(next);
  builds = { ...builds, [b.key]: next };
  emit();
}

const sameStage = (a: BuildStage | null | undefined, b: BuildStage | null | undefined) =>
  a === b || (!!a && !!b && a.stage === b.stage && a.label === b.label && a.pct === b.pct);

const sameError = (a: TargetBuild['error'] | undefined, b: TargetBuild['error'] | undefined) =>
  a === b || (!!a && !!b && a.reason === b.reason && a.message === b.message);

/** Merge into an existing record (ignored when there is none) and stamp updatedAt. No-op patches emit nothing. */
export function patchBuild(key: string, patch: Partial<TargetBuild>): void {
  const old = builds[key];
  if (!old || !patch) return;
  let changed = false;
  for (const k of Object.keys(patch) as Array<keyof TargetBuild>) {
    if (k === 'updatedAt' || k === 'key') continue;
    const a = old[k] as any;
    const b = patch[k] as any;
    const same = k === 'stage' ? sameStage(a, b) : k === 'error' ? sameError(a, b) : Object.is(a, b);
    if (!same) { changed = true; break; }
  }
  if (!changed) return;
  const rec = { ...old, ...patch, key: old.key, updatedAt: Date.now() };
  forgetCreepIfRestarted(rec);
  builds = { ...builds, [key]: rec };
  emit();
}

export function clearBuild(key: string): void {
  creepShown.delete(key);
  if (!(key in builds)) return;
  const next = { ...builds };
  delete next[key];
  builds = next;
  emit();
}

/** Account switch / Home reset. ⚠️ Display only — the builds themselves run on (see the header). */
export function clearAllBuilds(): void {
  creepShown.clear();
  if (!Object.keys(builds).length) return;
  builds = {};
  emit();
}

export function subscribeBuilds(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * The live record for one target, or null. Re-renders only when THAT record object changes.
 * rk null (nothing selected) is always null.
 */
export function useTargetBuild(kind: DocKind, rk: string | null): TargetBuild | null {
  const key = rk ? storeKeyOf(kind, rk) : null;
  const snapshot = useCallback(() => (key ? builds[key] || null : null), [key]);
  return useSyncExternalStore(subscribeBuilds, snapshot, snapshot);
}

/** Every record — for the one screen-level "a build is running" notice. Re-renders on ANY change. */
export function useAllBuilds(): Record<string, TargetBuild> {
  return useSyncExternalStore(subscribeBuilds, getBuilds, getBuilds);
}

/* ── THE CREEPING NUMBER ──────────────────────────────────────────────────────────────────────────── */

const TICK_MS = 90;
/** A shared value written this recently was advanced by ANOTHER display in this tick: adopt it, do not add. */
const FRESH_MS = TICK_MS - 15;
const CREEP_MAX = 64;

/**
 * The last number shown for each build (store key), shared by every display of it. ⚠️ WHY: the chip's line
 * mounts with the build and creeps; a carousel card or the overlay mounting LATER used to seed at the stage
 * ceiling, so one build read 24% on the chip and 38% on its card. Each display now seeds from, and writes
 * to, this one value. Plain numbers, never Animated (the header's driver rule).
 */
const creepShown = new Map<string, { v: number; at: number }>();

function writeCreep(key: string, v: number, at: number) {
  creepShown.delete(key);                // re-insert = most recent
  creepShown.set(key, { v, at });
  while (creepShown.size > CREEP_MAX) {
    const oldest = creepShown.keys().next().value;
    if (oldest === undefined) break;
    creepShown.delete(oldest);
  }
}

/**
 * ⚠️ THE RECORD'S CEILING FELL BELOW THE SHARED NUMBER = A NEW BUILD FOR THIS KEY (a retry restarting at its
 * first stage, a rebuild after 'done', an error). Within one build the stage never goes backwards
 * (useHomeBuilds' stageTo), so this is the one reliable "start again" signal; keeping the old number would
 * have a fresh build jump straight to where the last one stopped the moment its ceiling passed it.
 */
function forgetCreepIfRestarted(rec: TargetBuild) {
  const c = creepShown.get(rec.key);
  if (!c) return;
  const raw = Number(rec.stage?.pct);
  const ceiling = rec.phase === 'done' ? 100 : isFinite(raw) ? raw : 0;
  if (ceiling < c.v - 0.001) creepShown.delete(rec.key);
}

/**
 * The displayed percentage for a build: creeps toward the CURRENT stage's pct and stops there.
 *
 * ⚠️ THE NUMBER IS HONEST, WHICH MEANS IT STALLS. The server says nothing for the 30-90 s one AI call
 * takes; creeping past the stage it reported would claim work that has not started. BuildStep's curve,
 * unchanged: ease toward the ceiling, slowing as it approaches, never overtaking it.
 * ⚠️ ONE NUMBER PER BUILD. Pass `key` (storeKeyOf(kind, rk)) and every mounted display of that build — the
 * chip, its carousel card, the overlay — seeds from and writes to the same last-shown value (creepShown),
 * so a display that mounts late continues from the number already on screen instead of jumping to the
 * ceiling. Several displays ticking at once still advance the value once per tick (FRESH_MS), not once
 * each. Without a key, or before any display of the build has shown a number, it seeds from the pct it
 * mounts with, NOT 0: chips and cards remount on every chip switch, and starting from 0 there would crawl a
 * nearly finished build back up from nothing.
 * ⚠️ KEYED ON PRIMITIVES (the pct, whether it is done, the key), never the stage object: callers hand down a
 * fresh object on every poll, and re-arming the ticker for a number that did not move is waste.
 * The ticker stops once it reaches the ceiling (idle costs nothing) and state is set only when the WHOLE
 * number changes, so a creeping build re-renders its tiny text component at most once per percent.
 */
export function useCreepPct(stage: BuildStage | null, phase: BuildPhase | null, key?: string): number {
  const done = phase === 'done';
  const raw = Number(stage?.pct);
  const target = done ? 100 : Math.max(0, Math.min(100, isFinite(raw) ? raw : 0));
  const k = key || null;
  const seedOf = (): number => {
    if (done) return 100;
    const c = k ? creepShown.get(k) : undefined;
    return c && isFinite(c.v) ? Math.max(0, Math.min(c.v, target)) : target;
  };
  const v = useRef<number | null>(null);
  const seededFor = useRef<string | null>(k);
  if (v.current === null) v.current = seedOf();
  const [shown, setShown] = useState(() => Math.round(v.current as number));

  useEffect(() => {
    if (seededFor.current !== k) {
      // The same component now shows ANOTHER build: take that build's number, not this one's.
      seededFor.current = k;
      v.current = seedOf();
    }
    const cur0 = v.current as number;
    if (done || cur0 >= target) {
      // Done, or the ceiling moved DOWN (a retry restarting at its first stage): settle, no ticker.
      v.current = target;
      // Fill in an absent shared value, and pull one ABOVE this ceiling down to it: that is a leftover from
      // the build before (a tick that landed between a restart and this render). A display that is merely a
      // render behind costs nothing — every tick takes the max of its own number and the shared one, so
      // whoever is ahead writes it back up on its next tick without anyone's number going backwards.
      const c = k ? creepShown.get(k) : undefined;
      if (k && (done || !c || c.v > target)) writeCreep(k, target, Date.now());
      const whole = Math.round(target);
      setShown((p) => (p === whole ? p : whole));
      return;
    }
    // A reseed above (or a mount mid-creep) shows its starting number now, not a tick later.
    const start = Math.round(cur0);
    setShown((p) => (p === start ? p : start));
    const id = setInterval(() => {
      const now = Date.now();
      const c = k ? creepShown.get(k) : undefined;
      // Never behind another display of this build, never past this display's own ceiling.
      const base = Math.min(target, Math.max(v.current as number, c ? c.v : 0));
      let next: number;
      if (c && now - c.at < FRESH_MS) next = base;
      else next = base >= target ? target : Math.min(target, base + Math.max(0.15, (target - base) * 0.06));
      v.current = next;
      if (k && (!c || next > c.v)) writeCreep(k, next, now);
      const whole = Math.round(next);
      setShown((p) => (p === whole ? p : whole));
      if (next >= target) clearInterval(id);
    }, TICK_MS);
    return () => clearInterval(id);
    // seedOf reads only k, target and done, which are the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, done, k]);

  return shown;
}
