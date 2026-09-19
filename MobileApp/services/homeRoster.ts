// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE "DESIGNING FOR" ROW, KEPT — per account, on this device (2026-09-19).
//
// Home's chip row used to be worked out again on EVERY load as the top 12 of a live ranking
// (employerHomeService.fetchTargets: up to four employers with no postings first, then postings by match,
// three per employer). Nothing remembered what the row had been, so every place a removal freed was
// filled by the NEXT load with whatever ranked thirteenth.
//
// ⚠️ THE OWNER'S ROW REFILLED ITSELF — TWICE (2026-09-19, user 1, TestFlight b209). At 16:11 IST he removed
// the four lead employers and hid eight postings; the reload twenty seconds later put four government
// agencies he had never picked (Moroccan Ministry of Employment, Department of Employment and Labour SA,
// Ministry of Labour, Iskur — 69 more like them queued behind) and three strangers (MOM Ranch, Linum
// Consult, "N/A" on gob.mx) in their places. He hid those three as well, and at 22:02, on the letter tab,
// the row refilled AGAIN: Konnekt ×3, and three other Airbus roles standing in for the three he had hidden.
// "Designing for … just got reset and changed automatically." No server row had changed — the refill WAS
// the design. A failed read did the same thing louder: a timed-out dashboard read turned the whole row into
// saved cards, and a failed hidden-list read brought every hidden posting back and moved the selection.
//
// So the row is a SAVED LIST now (this file), and a load MERGES into it instead of replacing it:
//   • the FIRST complete load seeds it from the ranking — exactly the row the user saw before;
//   • a chip keeps its PLACE and its IDENTITY (company, employer id, site, posting URL, role, country,
//     colours — everything docLookupOf spells a saved document's lookup from) for as long as it is on the
//     row; a load refreshes only its match %, skills, location and job id;
//   • a chip leaves ONLY on evidence of a USER action: the X on this device (removedNow), a hide from any
//     device (the server's hidden list, with this device's hides in flight laid over it), an untrack (its
//     employer is missing from a dashboard read that ANSWERED — only an untrack or an archive does that),
//     an unsave (a saved card missing from a saved read that answered in full). ⚠️ A FAILED READ IS NEVER
//     EVIDENCE, and neither is a posting missing from the dashboard: postings are evicted, deactivated,
//     capped at 20 per employer, reordered by geography and replaced mid-search — none of that is the user;
//   • ⚠️ A FREED PLACE IS NEVER REFILLED from further down the ranking. Only genuinely NEW things join, at
//     the END: a posting newer than any this row has seen (jobs.created_at) or a card saved since, while the
//     row has fewer than MAX_CHIPS; an employer the user started tracking somewhere else, always (up to
//     ROSTER_HARD_MAX);
//   • the selection is kept BY KEY; when its chip leaves, the chip that slid into its place is selected —
//     never "the first chip".
//
// ⚠️ REVIEW FIXES (2026-09-19, round 1):
//   • A WATERMARK NEVER READ IS NOT "NOTHING IS OLD". A row saved while the saved-jobs read failed had no saved
//     watermark, and null read as "everything is newer" — so the first saved read that answered put August's saved
//     cards into the places the user had just emptied (user 1 has 119). Each watermark now carries whether it was
//     ever READ (postArmed / savedArmed); the read that first arms it adds nothing.
//   • THE RANKING'S LEAD EMPLOYERS ARE NOT SEEDED FOR AN ACCOUNT THAT TRACKS MORE THAN A ROW (see seedFrom): the four
//     no-posting agencies leading user 1's first saved row were the refill itself, not his picks.
//   • What one load does with the row is decided HERE (planRow, pure): with no saved row it could READ — the session
//     or storage unreadable — a load used to show the raw ranking for one load, then the saved row again.
//
// ⚠️ ONE ROW PER ACCOUNT, ON EVERY PHONE — KEPT ON THE SERVER TOO (2026-09-20). It used to be per device, on the
// grounds that hides and untracks already travel through the server. But the ORDER and the SELECTION did not, and a
// phone with no saved row seeded its own from the live ranking. The owner uses two phones: on 2026-09-19 user 1 was
// on install a_kz5txdx3… (b203) until 16:29:52 UTC and on a_ehuc9bgx… (b209, where test account 616 had been signed
// in) from 16:32:53 — the Airbus letter was built 27 s later. Each phone would have shown its own row. So the row is
// also kept at GET/PUT /ai-hub/home/roster (server/services/homeRoster.js, one JSONB row per user), and this
// device's copy is the offline and fast-paint cache:
//   • a load reads the server's row alongside its answer (fetchRemoteRoster); a device with no saved row, or one
//     OLDER than the server's (another phone wrote since: `rev`), merges into the server's row (savedRowOf) — the
//     selection going to whichever phone picked last (selectedAt), this device's unsent edits laid back on top;
//   • every save (keepRoster — a load's merge, and every user edit through editRoster) is written back, debounced,
//     COMPARE-AND-SET on the revision it was made from: a write from an older row gets 409 and the server's row,
//     this device's unsent edits are replayed onto it, and that is written instead (pushRoster). A seed never
//     overwrites a row another phone made.
//   • ⚠️ a server row that could not be READ is no answer: a device with no saved row of its own then keeps the row on
//     screen and saves nothing (pickSaved → undefined, planRow's rule), rather than seed one another phone would lose.
// An older server (no route: 404) is simply "no server copy" — the row stays per device, as before.
//
// ⚠️ REVIEW FIXES (2026-09-20, the server copy):
//   • A 409 REPLACES THIS PHONE'S ROW, AND THE SCREEN FOLLOWS IT (savedRowOf `replaced`). The screen used to keep the
//     chip it showed; the next load then saved that stale chip as a brand-new pick, stamped "now", and it beat the pick
//     the user had actually made on the other phone. ⚠️ No load stamps a pick any more (EmployerHome): only the user's
//     own selection does, and when two rows carry the SAME pick time each phone keeps its own (meet) — a selection
//     moves only for a pick made later somewhere.
//   • THIS PHONE'S HIGH-WATER MARKS SURVIVE ANOTHER PHONE'S ROW (meet): the posting / saved watermarks, whether they
//     were read, and the employers already seen. Taken from the other phone alone they went BACK, and a posting this
//     phone had already passed over (the row was full) walked into the first place the user freed.
//   • ONE CAP ON BOTH SIDES: at most ROSTER_MAX_KEYS chips (the server refuses more), and a row the server refused
//     (400) is not sent again until it changes.
//   • A SERVER ROW THAT IS GONE (rev 0, although this phone's copy came from one — the account was deleted) is not
//     uploaded again from this phone's copy: the copy goes, and the next complete load seeds afresh.
// ⚠️ NEVER KEPT: a pending add (emp_pending_*, it has no identity yet) and a posting with no URL (its key is
// a synthetic search id that renumbers as results stream in — see employerHomeService.cleanJobUrl).
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';
import { MAX_CHIPS, gradFor, deviceHeaders, type Target, type TargetAnswer } from './employerHomeService';

/**
 * One AsyncStorage value per account. ⚠️ Registered in app/(admin)/environment.tsx PREFIXES_TO_CLEAR: it holds
 * employer UUIDs and posting URLs from ONE backend, and they mean nothing in another.
 */
export const ROSTER_PREFIX = 'home_roster_v1:';
/** New employers the user tracked elsewhere still join a full row — up to this many chips in all. */
export const ROSTER_HARD_MAX = MAX_CHIPS + 8;
/**
 * How long a chip the user just put back (Undo, a re-add, a restored posting) ignores a read that says it is
 * gone: that read can have been made before the server heard about the un-hide or the track. Same span as
 * EmployerHome's REMOVED_HOLD_MS, the other direction.
 */
export const ROSTER_HOLD_MS = 5 * 60 * 1000;
/**
 * Chips on a saved row, at most — the SERVER's own cap (server/services/homeRoster.js ROSTER_MAX_KEYS), which refuses a
 * longer row outright. ⚠️ ONE CAP ON BOTH SIDES (2026-09-20 review): nothing here capped the row — every add, Undo and
 * restored posting goes in (rosterPlace) — so a row that reached 65 chips was refused on every write from then on: the
 * server's copy froze, and the other phone kept adopting the frozen copy.
 */
export const ROSTER_MAX_KEYS = 64;
/** A chip key, at most (the server's ROSTER_KEY_MAX_LEN): a row carrying a longer one would be refused whole. */
export const ROSTER_KEY_MAX_LEN = 2048;
const PENDING = 'emp_pending_';

export type Roster = {
  v: 1;
  /** The row, in order. */
  keys: string[];
  /** Each chip as it was first seen — its identity is frozen here (see the header). */
  snap: Record<string, Target>;
  /** The chip the user is on. */
  selected: string | null;
  /** Employer ids a complete dashboard read had already shown SETTLED — anything else that settles is new. null = none read yet. */
  knownEmployers: string[] | null;
  /** The newest posting (jobs.created_at, ms, the server's clock) this row has already been offered. */
  postWatermark: number | null;
  /**
   * postWatermark has been READ: a dashboard read answered and dated its postings (or had none — then null means
   * "the store was empty", and every dated posting is new). ⚠️ Until then nothing joins as a new posting.
   */
  postArmed: boolean;
  /** The newest saved card (saved_at, ms) this row has already been offered. */
  savedWatermark: number | null;
  /**
   * savedWatermark has been READ (a saved read answered). ⚠️ A row saved while that read FAILED had null here, and
   * null read as "every saved card is newer": the first saved read that answered refilled the freed places.
   */
  savedArmed: boolean;
  /** The last hidden list the server actually answered — so a hidden posting never comes back as "new" while a read fails. */
  hidden: string[] | null;
  /** Keys a read may not take away yet, → until when (ms). */
  hold: Record<string, number>;
  /** Keys whose snapshot is this device's stand-in (an add, a restore): the server's own copy replaces it once, then it freezes. */
  prov: Record<string, true>;
  /**
   * The server revision this row was made from (GET/PUT /ai-hub/home/roster). 0 = never synced. A server row with a
   * HIGHER revision was written by another phone since, and replaces this one (pickSaved).
   */
  rev: number;
  /** When the selection was last changed here or on another phone (ms): the later pick wins when two rows meet. 0 = never picked. */
  selectedAt: number;
};

export type MergeOpts = {
  /** The X on this device (EmployerHome removedNow): gone at once, whatever any read says. */
  removed?: (key: string) => boolean;
  /** Employers the user added on Home in this session (EmployerHome addedEmployers): a seed always keeps them. */
  added?: (key: string) => boolean;
  now?: number;
};

export type Merged = {
  roster: Roster;
  /** The chips, in order. */
  row: Target[];
  /** False for a row shown but not seeded (no saved row yet, and this answer was not complete enough to seed one). */
  persist: boolean;
};

const uniq = (a: string[]) => Array.from(new Set(a));

const msOf = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};

const maxOf = (a: number | null, b: number | null): number | null =>
  (a === null ? b : b === null ? a : Math.max(a, b));

/** A chip the row may keep: it has an identity that will still be its identity tomorrow. */
export function persistable(t: Target | null | undefined): boolean {
  if (!t || typeof t.key !== 'string' || !t.key || t.key.length > ROSTER_KEY_MAX_LEN) return false;
  if (t.key.startsWith(PENDING)) return false;
  if (t.key.startsWith('job_')) return !!String(t.applyUrl || t.jobUrl || '').trim();
  return t.key.startsWith('emp_');
}

/** A saved live-search card (it has no employer on the dashboard): only an unsave takes it away. */
const isSavedChip = (t: Target) => String(t.key || '').startsWith('job_') && !t.employerId;

/** The chips, in order. */
export function rosterRow(r: Roster | null | undefined): Target[] {
  if (!r) return [];
  return r.keys.map((k) => r.snap[k]).filter((t): t is Target => !!t);
}

/**
 * The row within ROSTER_MAX_KEYS (the server refuses a longer one). The chips furthest along the row — the ones least in
 * view — go first; never `keep` (the chip being placed) or the selection, and a held chip (an Undo, a re-add) only when
 * nothing else is left to take. The same object when the row is within the cap, which is every row but a 65th add.
 */
function capped(r: Roster, keep: string | null, now: number): Roster {
  if (r.keys.length <= ROSTER_MAX_KEYS) return r;
  const keys = r.keys.slice();
  const snap = { ...r.snap };
  const hold = { ...r.hold };
  const prov = { ...(r.prov || {}) };
  for (const spareHeld of [true, false]) {
    for (let i = keys.length - 1; i >= 0 && keys.length > ROSTER_MAX_KEYS; i--) {
      const k = keys[i];
      if (k === keep || k === r.selected || (spareHeld && (hold[k] || 0) > now)) continue;
      keys.splice(i, 1);
      delete snap[k]; delete hold[k]; delete prov[k];
    }
  }
  return { ...r, keys, snap, hold, prov };
}

/** The chip now at the index `gone` had (clamped) — the one that slid into its place. */
function neighbour(prevKeys: string[], nextKeys: string[], gone: string | null): string | null {
  if (!nextKeys.length) return null;
  const at = gone ? prevKeys.indexOf(gone) : -1;
  return nextKeys[Math.min(Math.max(0, at), nextKeys.length - 1)];
}

/** A chip's non-identity fields from a fresh read of the same key. The same object when nothing moved. */
function refreshed(s: Target, f: Target): Target {
  const skills = Array.isArray(f.skills) ? f.skills : (s.skills || []);
  const location = typeof f.location === 'string' ? f.location : s.location;
  const jobId = f.jobId || s.jobId || null;
  const match = typeof f.match === 'number' ? f.match : null;
  if (s.match === match && s.jobId === jobId && (s.location || '') === (location || '')
    && JSON.stringify(s.skills || []) === JSON.stringify(skills)) return s;
  return { ...s, match, skills, location, jobId };
}

/** An employer-level chip: an employer whose search found no posting (fetchTargetAnswer's `emp_<id>`). */
const bareEmployer = (t: Target | null | undefined) => !!t && typeof t.key === 'string' && t.key.startsWith('emp_') && !t.key.startsWith(PENDING);

/**
 * The chips a first saved row is made from: the ranking's own top MAX_CHIPS — exactly what the screen showed before
 * this file existed — with ONE exception.
 * ⚠️ THE LEAD EMPLOYERS OF AN ACCOUNT THAT TRACKS MORE THAN A ROW ARE LEFT OUT (2026-09-19 review). The ranking puts
 * up to four employer-level chips FIRST (employerHomeService LEAD_EMPLOYER_CHIPS) for one reason: an employer added
 * on Home a second ago must be inside the 12. The saved row does that job now (rosterPlace puts an add at the front,
 * and an employer tracked elsewhere joins even a full row), so for an account with more employers than one row holds
 * the four leads are just the four most recently touched of a long list — the ranking's pick, not the user's. User 1
 * (255 tracked, 73 with no posting) untracked his four leads at 16:11 IST and the ranking promoted four agencies he
 * had bulk-tracked on 2026-07-03 (TAECHIR, the South African Department of Employment, Ministry of Labour, Iskur);
 * seeding them would have frozen the refill he reported as his starting row. Their places are NOT refilled, and they
 * are `knownEmployers`, so they never join later either.
 * Kept as they are: an account that tracks no more than MAX_CHIPS employers (each lead is one it picked — for 13 of
 * the 16 production accounts with a no-posting employer, such employers are ALL it tracks, so a rule that dropped
 * them would empty its row), an employer the user added on Home (opts.added), and a row that is nothing but employers.
 */
function seedFrom(a: TargetAnswer, opts: MergeOpts = {}): Target[] {
  const ranked = a.ranked || [];
  if (!a.dashOk || !Array.isArray(a.trackedEmployerIds) || a.trackedEmployerIds.length <= MAX_CHIPS) return ranked;
  const added = opts.added || (() => false);
  let lead = 0;
  while (lead < ranked.length && bareEmployer(ranked[lead])) lead++;
  if (lead === ranked.length) return ranked;
  return ranked.filter((t, i) => i >= lead || added(t.key));
}

/** This answer READS the posting watermark: the dashboard answered, and dated its postings or had none at all. */
const armsPosts = (a: TargetAnswer) => a.dashOk
  && (a.postMax !== null || !(a.pool || []).some((t) => !!t && !!t.employerId && String(t.key || '').startsWith('job_')));
/** …and the saved one: the saved read answered, and dated its cards or had none. */
const armsSaved = (a: TargetAnswer) => a.savedOk
  && (a.savedMax !== null || !(a.pool || []).some((t) => !!t && isSavedChip(t)));

/**
 * The first saved row: seedFrom's chips, the first one selected. Only from an answer whose dashboard AND hidden
 * reads answered (see mergeRoster).
 */
export function seedRoster(a: TargetAnswer, opts: MergeOpts = {}): Roster {
  const removed = opts.removed || (() => false);
  const keys: string[] = [];
  const snap: Record<string, Target> = {};
  for (const t of seedFrom(a, opts)) {
    if (!persistable(t) || removed(t.key) || snap[t.key]) continue;
    keys.push(t.key);
    snap[t.key] = { ...t };
  }
  return {
    v: 1,
    keys,
    snap,
    selected: keys[0] ?? null,
    knownEmployers: a.dashOk && a.settledEmployerIds ? uniq(a.settledEmployerIds.map(String)) : null,
    postWatermark: a.dashOk ? a.postMax : null,
    postArmed: armsPosts(a),
    savedWatermark: a.savedOk ? a.savedMax : null,
    savedArmed: armsSaved(a),
    hidden: a.hiddenOk && a.hidden ? uniq(a.hidden) : null,
    hold: {},
    prov: {},
    rev: 0,
    selectedAt: 0,
  };
}

/**
 * Merge one load's answer into the saved row (see the header for every rule). Pure — no I/O — so it can be
 * run against a replay of the owner's session.
 * ⚠️ NO SAVED ROW YET: an answer whose dashboard or hidden read failed seeds NOTHING (a seed from it would
 * freeze a row of saved cards, or one with every hidden posting back in it). It is shown as the ranking
 * says, not kept, and the next answer that can seed does.
 */
export function mergeRoster(prev: Roster | null | undefined, a: TargetAnswer, opts: MergeOpts = {}): Merged {
  const removed = opts.removed || (() => false);
  if (!prev) {
    const seed = seedRoster(a, opts);
    if (!a.dashOk || !a.hiddenOk) {
      return { roster: seed, row: seedFrom(a, opts).filter((t) => !removed(t.key)), persist: false };
    }
    return { roster: seed, row: rosterRow(seed), persist: true };
  }
  const now = opts.now ?? Date.now();
  const pastProv = prev.prov || {};
  const hold: Record<string, number> = {};
  for (const k of Object.keys(prev.hold || {})) {
    const until = prev.hold[k];
    if (typeof until === 'number' && until > now && prev.snap[k]) hold[k] = until;
  }
  const held = (k: string) => (hold[k] || 0) > now;
  const serverHidden = a.hiddenOk && a.hidden ? new Set(a.hidden) : null;
  const lastHidden = new Set(serverHidden ? Array.from(serverHidden) : (prev.hidden || []));
  const local = a.localHidden || {};
  // A chip ON the row leaves for a hide only on real evidence: this device's own, or a list that answered.
  const hiddenNow = (k: string) => (k in local ? !!local[k] : !!serverHidden && serverHidden.has(k));
  // A chip that would JOIN is kept out by the last list we could read too: a hidden posting never comes back as new.
  const hiddenEver = (k: string) => (k in local ? !!local[k] : lastHidden.has(k));
  const tracked = a.dashOk && a.trackedEmployerIds ? new Set(a.trackedEmployerIds.map(String)) : null;
  const savedKeys = a.savedOk && a.savedKeys ? new Set(a.savedKeys) : null;
  const pool = new Map<string, Target>();
  for (const t of [...(a.pool || []), ...(a.candidates || [])]) if (t && t.key && !pool.has(t.key)) pool.set(t.key, t);

  // (1) What is on the row stays, in its place — unless the user took it away.
  const keys: string[] = [];
  const snap: Record<string, Target> = {};
  const prov: Record<string, true> = {};
  for (const k of prev.keys) {
    const s = prev.snap[k];
    if (!s || snap[k] || removed(k)) continue;
    if (!held(k)) {
      if (hiddenNow(k)) continue;
      if (tracked && s.employerId && !tracked.has(String(s.employerId))) continue;
      if (savedKeys && isSavedChip(s) && !savedKeys.has(k)) continue;
    }
    const f = pool.get(k);
    if (f && pastProv[k]) snap[k] = { ...f, arrivedAt: s.arrivedAt ?? f.arrivedAt ?? null };
    else {
      snap[k] = f ? refreshed(s, f) : s;
      if (pastProv[k]) prov[k] = true;
    }
    keys.push(k);
  }

  // (2) Only what is genuinely new joins — at the end. Never a refill from further down the ranking.
  const inRow = new Set(keys);
  const rowEmployers = new Set(keys.map((k) => snap[k].employerId).filter(Boolean).map(String));
  const known = prev.knownEmployers ? new Set(prev.knownEmployers) : null;
  const settled = a.dashOk && a.settledEmployerIds ? new Set(a.settledEmployerIds.map(String)) : null;
  const newer = (t: Target, mark: number | null) => {
    const at = msOf(t.arrivedAt);
    return at !== null && (mark === null || at > mark);
  };
  for (const c of a.candidates || []) {
    if (!c || inRow.has(c.key) || !persistable(c) || removed(c.key) || hiddenEver(c.key)) continue;
    const emp = c.employerId ? String(c.employerId) : '';
    let take: boolean;
    if (emp && known && settled && settled.has(emp) && !known.has(emp) && !rowEmployers.has(emp)) {
      // An employer the user started tracking somewhere else (the Job Hub, the web): theirs, so it joins a full row too.
      take = keys.length < ROSTER_HARD_MAX;
    } else if (keys.length >= MAX_CHIPS) take = false;
    // ⚠️ Only against a watermark that was READ (postArmed / savedArmed): the read that first arms one adds nothing.
    else if (emp) take = a.dashOk && prev.postArmed && newer(c, prev.postWatermark);
    else take = a.savedOk && prev.savedArmed && newer(c, prev.savedWatermark);
    if (!take) continue;
    keys.push(c.key);
    snap[c.key] = { ...c };
    inRow.add(c.key);
  }

  const selected = prev.selected && inRow.has(prev.selected)
    ? prev.selected
    : neighbour(prev.keys, keys, prev.selected);
  // (Within the server's cap: only a row saved before the cap existed can be over it — a load adds at most ROSTER_HARD_MAX.)
  const roster: Roster = capped({
    v: 1,
    keys,
    snap,
    selected,
    // An employer untracked since leaves `known`, so tracking it again later counts as new.
    knownEmployers: settled
      ? uniq([...(prev.knownEmployers || []).filter((id) => !tracked || tracked.has(id)), ...Array.from(settled)])
      : prev.knownEmployers,
    postWatermark: a.dashOk ? maxOf(prev.postWatermark, a.postMax) : prev.postWatermark,
    postArmed: prev.postArmed || armsPosts(a),
    savedWatermark: a.savedOk ? maxOf(prev.savedWatermark, a.savedMax) : prev.savedWatermark,
    savedArmed: prev.savedArmed || armsSaved(a),
    hidden: serverHidden ? Array.from(serverHidden) : prev.hidden,
    hold,
    prov,
    // Still made from the same server row; a neighbour taking over a chip that left is no new pick.
    rev: prev.rev || 0,
    selectedAt: prev.selectedAt || 0,
  }, null, now);
  return { roster, row: rosterRow(roster), persist: true };
}

/**
 * Whose saved row one Home load merges its answer into (`owner`), and saves it under (`acct`). `who` = the account
 * this load's session read saw (null = it could not be read); `last` = the account the module cache belongs to
 * (EmployerHome cacheOwner — the last one that could be read).
 * ⚠️ AN UNREADABLE SESSION IS NO ACCOUNT SWITCH (2026-09-19 review): the row on screen is still `last`'s, so the answer
 * is merged against THAT row — it used to be merged against nothing, and the raw ranking replaced the row for one
 * load — but saved under nobody: it cannot be proven to be that account's answer. A different account read
 * mid-load (who ≠ last) is neither.
 */
export function rowAccounts(who: string | null, last: string | null): { acct: string | null; owner: string | null } {
  const acct = who && who === last ? who : null;
  return { acct, owner: acct || (who === null ? last : null) };
}

/** What one Home load does with the chip row (planRow). */
export type RowPlan = {
  /** The answer merged into the saved row (a seed when there is none). */
  merged: Merged;
  /** Leave the row on screen exactly as it is: there is nothing this answer could be merged into. */
  keep: boolean;
  /** Save merged.roster as the account's row. */
  save: boolean;
};

/**
 * What one Home load (EmployerHome load()) does with the chip row — pure, so the suite runs the cases that used to
 * reset it. `saved` is the account's saved row: null = none saved yet; ⚠️ undefined = none could be READ (no account
 * could be read, or storage threw). `shown` = the chips on screen now.
 * ⚠️ NOTHING TO MERGE INTO WHILE A ROW IS ON SCREEN = THE ROW STAYS (2026-09-19 review). With no saved row the merge
 * is a fresh SEED — the raw ranking — and a SecureStore or AsyncStorage blip put that on screen for one load, until the
 * next read brought the saved row back: "reset and changed automatically". An answer with nothing in it (both stores
 * failed) stays out the same way. A refused session is the one load that empties the row (EmployerHome).
 * ⚠️ Nothing is saved over a row that could not be read (it would be erased), nor for a refused session.
 */
export function planRow(
  saved: Roster | null | undefined, a: TargetAnswer,
  o: MergeOpts & { shown: number; refused?: boolean },
): RowPlan {
  const prev = saved || null;
  const merged = mergeRoster(prev, a, o);
  const keep = !o.refused && !prev && o.shown > 0 && (saved === undefined || (!a.dashOk && !a.savedOk));
  const save = !o.refused && !keep && merged.persist && saved !== undefined;
  return { merged, keep, save };
}

/* ── the user's own edits ─────────────────────────────────────────────────────────────────────────── */

/**
 * Put a chip on the row — an Undo, an employer added (or added again) on Home, a posting whose saved document a
 * re-add restored. `after` is the keys shown IN FRONT of it on screen: it goes right behind the last of them the
 * row has (the front when none). `replaces` is the key it takes over (a removed chip coming back under the
 * identity tracking just gave it), and it keeps that key's selection. `hold` shields it from a read made
 * before the server heard (ROSTER_HOLD_MS); `provisional` lets the server's own copy replace this snapshot once.
 * ⚠️ A 65th chip pushes the one furthest along the row off it (capped): the server refuses a longer row.
 */
export function rosterPlace(
  r: Roster, t: Target,
  opts: { after?: string[]; replaces?: string | null; hold?: boolean; provisional?: boolean; now?: number } = {},
): Roster {
  if (!persistable(t)) return r;
  const out = opts.replaces && opts.replaces !== t.key ? opts.replaces : null;
  const keys = r.keys.filter((k) => k !== t.key && k !== out);
  let pos = 0;
  for (const k of opts.after || []) pos = Math.max(pos, keys.indexOf(k) + 1);
  keys.splice(pos, 0, t.key);
  const snap = { ...r.snap, [t.key]: { ...t } };
  const hold = { ...r.hold };
  const prov = { ...(r.prov || {}) };
  if (out) { delete snap[out]; delete hold[out]; delete prov[out]; }
  if (opts.hold) hold[t.key] = (opts.now ?? Date.now()) + ROSTER_HOLD_MS;
  if (opts.provisional) prov[t.key] = true;
  else delete prov[t.key];
  const selected = out && r.selected === out ? t.key : r.selected;
  return capped({ ...r, keys, snap, hold, prov, selected }, t.key, opts.now ?? Date.now());
}

/** The X: the chip leaves the row, and its place closes up. Not refilled — ever. */
export function rosterRemove(r: Roster, key: string, now?: number): Roster {
  if (!r.keys.includes(key) && !r.snap[key]) return r;
  const keys = r.keys.filter((k) => k !== key);
  const snap = { ...r.snap };
  const hold = { ...r.hold };
  const prov = { ...(r.prov || {}) };
  delete snap[key]; delete hold[key]; delete prov[key];
  const moved = r.selected === key;
  const selected = moved ? neighbour(r.keys, keys, key) : r.selected;
  // The user took their chip away here: the one now selected is this phone's latest pick.
  return { ...r, keys, snap, hold, prov, selected, selectedAt: moved ? (now ?? Date.now()) : r.selectedAt };
}

/**
 * The chip the user is on. A key the row does not keep (a pending add) leaves the saved selection as it was.
 * `now` = when the pick was made. ⚠️ Only the user's own pick is stamped with the time it happened: a load that records
 * the chip on screen passes the row's own selectedAt (EmployerHome load) — a screen that merely still SHOWS a chip has
 * picked nothing, and a fresh stamp would beat the pick the user really made on another phone since (meet).
 */
export function rosterSelect(r: Roster, key: string | null | undefined, now?: number): Roster {
  if (!key || r.selected === key || !r.keys.includes(key)) return r;
  return { ...r, selected: key, selectedAt: now ?? Date.now() };
}

/**
 * A plain list as a COMPLETE answer — for the preview harness (EmployerHome `loaders.targets`), whose fixtures
 * are the whole truth. No employer or saved list is claimed (null), so nothing is ever dropped as untracked.
 */
export function listAnswer(list: Target[]): TargetAnswer {
  const l = Array.isArray(list) ? list : [];
  return {
    ranked: l, candidates: l, pool: l,
    dashOk: true, savedOk: true, hiddenOk: true, hidden: [], localHidden: {},
    trackedEmployerIds: null, settledEmployerIds: null, savedKeys: null, postMax: null, savedMax: null,
  };
}

/* ── storage: one value per account, and a module copy for the next mount ─────────────────────────── */

/** Half of a surrogate pair on its own (not global: .test must not keep a lastIndex). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A stored row, checked field by field. Anything unreadable is "no saved row" — never a throw. */
function readable(x: any): Roster | null {
  if (!x || typeof x !== 'object' || x.v !== 1 || !Array.isArray(x.keys) || !x.snap || typeof x.snap !== 'object') return null;
  const snap: Record<string, Target> = {};
  const keys: string[] = [];
  for (const k of x.keys) {
    const s = typeof k === 'string' && k ? x.snap[k] : null;
    if (!s || typeof s !== 'object' || s.key !== k || typeof s.company !== 'string' || snap[k]) continue;
    const company = s.company || 'Employer';
    snap[k] = {
      ...s,
      company,
      role: typeof s.role === 'string' ? s.role : '',
      // (By code point: charAt(0) of "🚀 Rocket Lab" is half an emoji — a lone surrogate the server's jsonb refuses.)
      initial: typeof s.initial === 'string' && s.initial && !LONE_SURROGATE.test(s.initial) ? s.initial
        : (Array.from(String(company).trim())[0] || '').toUpperCase() || '?',
      colors: Array.isArray(s.colors) && s.colors.length >= 2 ? [String(s.colors[0]), String(s.colors[1])] : gradFor(company),
      match: typeof s.match === 'number' ? s.match : null,
      skills: Array.isArray(s.skills) ? s.skills.filter((v: any) => typeof v === 'string') : [],
      jobId: typeof s.jobId === 'string' ? s.jobId : null,
    };
    keys.push(k);
  }
  const strs = (v: any): string[] | null => (Array.isArray(v) ? v.filter((s: any) => typeof s === 'string') : null);
  const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const hold: Record<string, number> = {};
  const prov: Record<string, true> = {};
  if (x.hold && typeof x.hold === 'object') for (const k of Object.keys(x.hold)) if (snap[k] && num(x.hold[k]) !== null) hold[k] = x.hold[k];
  if (x.prov && typeof x.prov === 'object') for (const k of Object.keys(x.prov)) if (snap[k] && x.prov[k] === true) prov[k] = true;
  return {
    v: 1,
    keys,
    snap,
    selected: typeof x.selected === 'string' && snap[x.selected] ? x.selected : (keys[0] ?? null),
    knownEmployers: strs(x.knownEmployers),
    postWatermark: num(x.postWatermark),
    // A row saved without the flag: a null watermark counts as never read — the safe side (nothing joins until read).
    postArmed: typeof x.postArmed === 'boolean' ? x.postArmed : num(x.postWatermark) !== null,
    savedWatermark: num(x.savedWatermark),
    savedArmed: typeof x.savedArmed === 'boolean' ? x.savedArmed : num(x.savedWatermark) !== null,
    hidden: strs(x.hidden),
    hold,
    prov,
    rev: typeof x.rev === 'number' && Number.isInteger(x.rev) && x.rev >= 0 ? x.rev : 0,
    selectedAt: num(x.selectedAt) ?? 0,
  };
}

/**
 * The row of the account that last used it, in memory. ⚠️ ONE ACCOUNT AT A TIME: a read or a save for another
 * account replaces it, and EmployerHome's account wipe drops it (forgetRosterCopy). The stored rows of other
 * accounts are left alone — each is its own key.
 */
let mem: { account: string; roster: Roster } | null = null;
/**
 * Saves run one after another, each writing the WHOLE row as it was when it was queued — never a
 * read-modify-write, so two saves in flight cannot drop each other's change, and the last one queued wins.
 */
let writes: Promise<void> = Promise.resolve();

/** The in-memory row, when it belongs to `account`. Synchronous. */
export function rosterCopy(account: string | null | undefined): Roster | null {
  return account && mem && mem.account === account ? mem.roster : null;
}

/**
 * The saved row for this account. null = none saved (or unreadable JSON: a fresh seed replaces it).
 * undefined = storage could not be read, or no account — ⚠️ the caller must not seed OVER it.
 */
export async function readRoster(account: string | null | undefined): Promise<Roster | null | undefined> {
  if (!account) return undefined;
  const have = rosterCopy(account);
  if (have) return have;
  let raw: string | null;
  try { raw = await AsyncStorage.getItem(ROSTER_PREFIX + account); } catch { return undefined; }
  // A save (or an edit) for this account may have landed while storage was being read: it is newer.
  const meanwhile = rosterCopy(account);
  if (meanwhile) return meanwhile;
  let r: Roster | null = null;
  try { r = raw ? readable(JSON.parse(raw)) : null; } catch { r = null; }
  if (r) mem = { account, roster: r };
  return r;
}

/** In memory at once, in storage in turn — exactly `r` (keepRoster and the server's answers go through here). */
function store(account: string, r: Roster): void {
  mem = { account, roster: r };
  const key = ROSTER_PREFIX + account;
  const body = JSON.stringify(r);
  writes = writes.then(() => AsyncStorage.setItem(key, body).catch(() => undefined));
}

/**
 * Make `r` this account's row: in memory at once, in storage in turn, on the server after ROSTER_PUSH_MS (pushRoster).
 * A null account keeps nothing.
 * ⚠️ NEVER BEHIND THE REVISION THIS DEVICE HAS ALREADY REACHED: a load merges a copy it took before its last await, and
 * a write of this device's own can have come back since with the next revision — sent with the older one, this
 * device's next write would be refused as another phone's (409).
 */
export function keepRoster(account: string | null | undefined, r: Roster): void {
  if (!account) return;
  const had = rosterCopy(account);
  store(account, had && (had.rev || 0) > (r.rev || 0) ? { ...r, rev: had.rev } : r);
  schedulePush(account);
}

/**
 * Apply a user's edit (rosterPlace / rosterRemove / rosterSelect) to this account's row. Nothing when there is no
 * saved row yet — the next complete load seeds one that already reflects the edit (removedNow, the hidden list).
 * An edit that changed the row is also remembered until the server has it (`unsent`): if another phone's row turns
 * out to be newer, the edit is laid over THAT row instead of being lost with this one.
 */
export function editRoster(account: string | null | undefined, fn: (r: Roster) => Roster): Promise<void> {
  if (!account) return Promise.resolve();
  const apply = () => {
    const cur = rosterCopy(account);
    if (!cur) return;
    const next = fn(cur);
    if (next === cur) return;
    if (syncable(account)) {
      unsent.push({ account, seq: ++editSeq, fn });
      if (unsent.length > UNSENT_MAX) unsent = unsent.slice(-UNSENT_MAX);
    }
    keepRoster(account, next);
  };
  if (rosterCopy(account)) { apply(); return Promise.resolve(); }
  return readRoster(account).then(apply, () => undefined);
}

/** Everything queued has reached storage (tests, and nothing else, wait on this). */
export function rosterWrites(): Promise<void> {
  return writes;
}

/** The account changed: the in-memory row goes, and so does everything waiting for the server. Stored rows stay — each account's is its own. */
export function forgetRosterCopy(): void {
  mem = null;
  syncGen++;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
  pushAccount = null;
  synced = null;
  unsent = [];
  replaced = null;
  refused = null;
}

/* ── the server's copy: one row per account, shared by the user's phones (server/services/homeRoster.js) ── */

/** How long a save waits before it goes to the server: a burst of picks, or a load and the pick after it, is one write. */
export const ROSTER_PUSH_MS = 800;
/** This device's edits the server has not stored yet, at most (the oldest go first). */
const UNSENT_MAX = 50;

/** The server's row: `roster` null when it has none (or one this build cannot read); `rev` 0 when it has none. */
export type RemoteRoster = { roster: Roster | null; rev: number };

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pushAccount: string | null = null;
/** Writes to the server, one after another. */
let pushes: Promise<void> = Promise.resolve();
/** The row the server holds (canonical body, no rev) at `rev`, as far as this device knows — an unchanged row is never sent. */
let synced: { account: string; rev: number; body: string } | null = null;
/** This device's edits the server has not stored yet, in order (editRoster). */
let unsent: { account: string; seq: number; fn: (r: Roster) => Roster }[] = [];
let editSeq = 0;
/** Bumped by forgetRosterCopy: a request made for the previous account changes nothing when it comes back. */
let syncGen = 0;
/**
 * The account whose row a 409 REPLACED since its screen last loaded (pushRoster): the other phone's row, this phone's
 * unsent edits laid over it. The screen still shows the chip it had; savedRowOf reports it (`replaced`) so the next load
 * goes to the row's selection instead of saving the stale chip over it.
 */
let replaced: string | null = null;
/** A body the server REFUSED (400): never sent again — only a changed row is. */
let refused: { account: string; body: string } | null = null;

/**
 * This device's copy of a row the server no longer has — the account was deleted (server.js clears user_home_roster),
 * so a copy made from revision N meets revision 0. Gone from memory, from storage and from everything waiting to be
 * sent: re-uploaded, it would bring the deleted account's row back. The next complete load seeds afresh.
 */
function dropCopy(account: string): void {
  if (mem && mem.account === account) mem = null;
  unsent = unsent.filter((u) => u.account !== account);
  if (synced && synced.account === account) synced = null;
  if (replaced === account) replaced = null;
  if (refused && refused.account === account) refused = null;
  const key = ROSTER_PREFIX + account;
  writes = writes.then(() => AsyncStorage.removeItem(key).catch(() => undefined));
}

/** Only an account with a user id has a server row (a token-hash account — no id — stays on this device). */
const syncable = (account: string | null | undefined): account is string => typeof account === 'string' && account.startsWith('u:');

/** A row as the server should hold it, in one spelling: keys sorted at every level, no `rev` (the server's column). */
function bodyOf(r: Roster): string {
  return JSON.stringify({ ...r, rev: undefined }, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.keys(x).sort().reduce((o: Record<string, unknown>, k) => { o[k] = x[k]; return o; }, {})
    : x));
}

/**
 * The token for `account`, read in ONE parse of the session with the id it belongs to — null when the session now
 * names someone else (or cannot be read). ⚠️ A write queued for user 1 must never go out with user 616's token.
 */
async function tokenFor(account: string): Promise<string | null> {
  try {
    const u = JSON.parse((await SecureStore.getItemAsync('userSession')) || '{}');
    if (!u || u.id == null || !u.token || 'u:' + String(u.id) !== account) return null;
    return String(u.token);
  } catch { return null; }
}

/**
 * GET /ai-hub/home/roster for this account. null = there is no server copy to have (an older server without the route,
 * or an account with no user id); undefined = it could not be READ (offline, 5xx, a session that names someone else) —
 * ⚠️ never read as "the server has none".
 */
export async function fetchRemoteRoster(account: string | null | undefined, ms = 15000): Promise<RemoteRoster | null | undefined> {
  if (!account) return undefined;
  if (!syncable(account)) return null;
  const tok = await tokenFor(account);
  if (!tok) return undefined;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${API_BASE}/ai-hub/home/roster`, { headers: { Authorization: `Bearer ${tok}`, ...(await deviceHeaders()) }, signal: ctl.signal });
    if (r.status === 404) return null;
    if (!r.ok) return undefined;
    const j = await r.json();
    if (!j || j.account !== account || !Number.isInteger(j.rev) || j.rev < 0) return undefined;
    const roster = j.roster ? readable(j.roster) : null;
    return { roster: roster ? { ...roster, rev: j.rev } : null, rev: j.rev };
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}

/**
 * The server's row as this device takes it: its revision, this device's unsent edits laid over it (`edits`, oldest
 * first), and the LATER of the two picks. ⚠️ By the time each pick was made (selectedAt), not by the replay — a replayed
 * rosterSelect would stamp an old pick "now" and beat the one the user made on the other phone since.
 * ⚠️ THE SAME PICK TIME = THIS PHONE KEEPS ITS OWN (2026-09-20 review). Two rows carry one time only when neither phone
 * picked since (a load records the chip on its screen under the row's own time): nobody chose between them, so the
 * selection on this phone does not move. A pick made later — anywhere — still wins.
 * ⚠️ THIS PHONE'S HIGH-WATER MARKS ARE KEPT (2026-09-20 review): the posting and saved watermarks (the later of the two),
 * whether each was ever read (either phone), and the employers either phone has already seen settle. Taken from the
 * other phone's row alone they went BACK — a posting this phone had already passed over because the row was full became
 * "new" again, and walked into the first place the user freed ("a freed place is never refilled"). The hidden list is
 * the server's last answer on either phone; the next read that answers replaces it anyway.
 */
function meet(local: Roster | null | undefined, server: Roster, rev: number, edits: Array<(r: Roster) => Roster>): Roster {
  let out: Roster = { ...server, rev };
  if (local) {
    out = {
      ...out,
      postWatermark: maxOf(local.postWatermark, server.postWatermark),
      postArmed: !!(local.postArmed || server.postArmed),
      savedWatermark: maxOf(local.savedWatermark, server.savedWatermark),
      savedArmed: !!(local.savedArmed || server.savedArmed),
      knownEmployers: server.knownEmployers && local.knownEmployers
        ? uniq([...server.knownEmployers, ...local.knownEmployers])
        : (server.knownEmployers || local.knownEmployers),
      hidden: server.hidden || local.hidden,
    };
  }
  for (const fn of edits) {
    try { out = fn(out); } catch { /* an edit that no longer applies is simply not there */ }
  }
  const later = local && local.selected && (local.selectedAt || 0) >= (server.selectedAt || 0) ? local : server;
  if (later.selected && out.keys.includes(later.selected)) out = { ...out, selected: later.selected, selectedAt: later.selectedAt || 0 };
  return { ...out, rev };
}

/**
 * Which saved row one load merges its answer into — pure. `local` = this device's (readRoster: null none, undefined
 * unreadable), `remote` = the server's (fetchRemoteRoster), `edits` = this device's unsent edits.
 *   • the server's row, when this device has none or its own is OLDER (a lower rev: another phone wrote since) —
 *     `adopted`, so the screen can follow the selection;
 *   • this device's, when the server has none, has no route, or holds the same revision or an older one;
 *   • ⚠️ the server could not be read: this device's row — and with none of its own, `undefined` ("could not be
 *     read"), NOT null: a seed made now would be written as this account's row over nothing on this device, and the
 *     row another phone made would come back over it at the next load. planRow keeps the row on screen instead.
 *   • ⚠️ the server has NO row (rev 0) although this device's came from one (rev > 0): the account's row was deleted
 *     (account deletion) — `gone`, and null: the next complete load seeds afresh instead of uploading the deleted row
 *     again. (A copy that never reached the server, rev 0, is simply this device's row, and is written as the first.)
 */
export function pickSaved(
  local: Roster | null | undefined, remote: RemoteRoster | null | undefined, edits: Array<(r: Roster) => Roster> = [],
): { row: Roster | null | undefined; adopted: boolean; gone?: boolean } {
  if (remote === undefined) return { row: local || undefined, adopted: false };
  if (remote && !remote.roster && remote.rev === 0 && local && (local.rev || 0) > 0) return { row: null, adopted: false, gone: true };
  if (!remote || !remote.roster) return { row: local, adopted: false };
  if (local && (local.rev || 0) >= remote.rev) return { row: local, adopted: false };
  return { row: meet(local, remote.roster, remote.rev, edits), adopted: true };
}

/**
 * pickSaved for `account`, with this device's unsent edits — and what the server holds, remembered (no write of an
 * unchanged row). `replaced`: a 409 put another phone's row in place of this device's since the last load asked — the
 * screen goes to its selection, as for `adopted` (EmployerHome load). ⚠️ `peek` (the early paint, a resume) reads
 * without consuming that, and without dropping a `gone` copy: only the load that merges acts on them.
 */
export function savedRowOf(
  account: string, local: Roster | null | undefined, remote: RemoteRoster | null | undefined, opts: { peek?: boolean } = {},
): { row: Roster | null | undefined; adopted: boolean; replaced: boolean } {
  if (remote && (!synced || synced.account !== account || synced.rev !== remote.rev)) {
    synced = remote.roster ? { account, rev: remote.rev, body: bodyOf(remote.roster) } : null;
  }
  const p = pickSaved(local, remote, unsent.filter((u) => u.account === account).map((u) => u.fn));
  const wasReplaced = replaced === account;
  if (!opts.peek) {
    if (wasReplaced) replaced = null;
    if (p.gone) dropCopy(account);
  }
  return { row: p.row, adopted: p.adopted, replaced: wasReplaced && !p.gone };
}

function schedulePush(account: string): void {
  if (!syncable(account)) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushAccount = account;
  const gen = syncGen;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushAccount = null;
    if (gen === syncGen) pushes = pushes.then(() => pushRoster(account)).catch(() => undefined);
  }, ROSTER_PUSH_MS);
}

/**
 * Write this account's row to the server — COMPARE-AND-SET on the revision it was made from. On 409 (another phone
 * wrote since) the server's row comes back: this device's unsent edits are laid over it, that becomes this device's
 * row, and it is written once more. Anything else (offline, 5xx, an older server's 404) changes nothing: the next save
 * or load writes again. ⚠️ The row on SCREEN follows a 409's row at the next load (savedRowOf `replaced`), not now.
 * ⚠️ A 400 (a row the server will never take) is not sent again until the row changes — it used to go out, whole, on
 * every save for ever. ⚠️ A 409 answering "no row at all" (rev 0) to a write made from a revision: the account's row
 * was deleted — this device's copy goes too (dropCopy), never re-uploaded.
 */
async function pushRoster(account: string, again = true): Promise<void> {
  const gen = syncGen;
  const cur = rosterCopy(account);
  if (!cur) return;
  const body = bodyOf(cur);
  if (synced && synced.account === account && synced.rev === (cur.rev || 0) && synced.body === body) {
    // The server already holds exactly this: every edit in it has arrived.
    unsent = unsent.filter((u) => u.account !== account);
    return;
  }
  if (refused && refused.account === account && refused.body === body) return;
  const upto = editSeq;
  const tok = await tokenFor(account);
  if (!tok || gen !== syncGen) return;
  let status = 0;
  let j: any = null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(`${API_BASE}/ai-hub/home/roster`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(await deviceHeaders()) },
      body: `{"account":${JSON.stringify(account)},"base":${cur.rev || 0},"roster":${body}}`,
      signal: ctl.signal,
    });
    status = r.status;
    j = await r.json().catch(() => null);
  } catch { return; }
  finally { clearTimeout(timer); }
  if (gen !== syncGen) return;
  if (status === 200 && j && Number.isInteger(j.rev)) {
    synced = { account, rev: j.rev, body };
    unsent = unsent.filter((u) => !(u.account === account && u.seq <= upto));
    // What is in memory now is this row, or a later edit of it — either way it stands on the new revision.
    const now = rosterCopy(account);
    if (now) store(account, { ...now, rev: j.rev });
    return;
  }
  if (status === 400) {
    refused = { account, body };
    console.warn(`[homeRoster] the server refused this row (${(j && j.reason) || 'invalid'}): not sent again until it changes`);
    return;
  }
  if (status === 409 && j && j.reason === 'conflict' && Number.isInteger(j.rev)) {
    if (j.rev === 0 && !j.roster && (cur.rev || 0) > 0) { dropCopy(account); return; }
    const theirs = j.roster ? readable(j.roster) : null;
    const now = rosterCopy(account) || cur;
    const mine = unsent.filter((u) => u.account === account).map((u) => u.fn);
    // A server row this build cannot read is written over (on its revision) rather than left in the way for ever.
    synced = theirs ? { account, rev: j.rev, body: bodyOf(theirs) } : null;
    store(account, theirs ? meet(now, theirs, j.rev, mine) : { ...now, rev: j.rev });
    // The screen still shows the chip it had: its next load goes to this row's selection (savedRowOf `replaced`).
    if (theirs) replaced = account;
    if (again) await pushRoster(account, false);
  }
}

/** Send what is waiting now instead of after the pause, and resolve once every write to the server has come back. */
export function rosterSync(): Promise<void> {
  if (pushTimer && pushAccount) {
    clearTimeout(pushTimer);
    pushTimer = null;
    const account = pushAccount;
    pushAccount = null;
    pushes = pushes.then(() => pushRoster(account)).catch(() => undefined);
  }
  return pushes;
}
