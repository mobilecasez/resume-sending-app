// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE SELECTED EMPLOYER'S OWN DOCUMENT — what Home shows when a chip is picked.
//
// Every employer now has its own resume (and its own cover letter), rewritten for it and stored
// server-side in user_employer_documents with a ranked design list. Switching chips must show THAT
// employer's document at once, so three small hooks sit between EmployerHome and the server:
//   • useDocList    — the slim list of every saved doc (drives the chips' "tailored" dot)
//   • useTargetDoc  — the doc for the chip on screen (POST /employer-docs/current)
//   • useDocDeck    — that doc's designs, best fit first, with page images filled in on approach
//
// ⚠️ NOTHING HERE EVER STARTS A BUILD OR CHARGES. These are reads only: a lookup that finds no doc
// answers 'none' and the SCREEN offers an explicit CTA (the letters auto-regen drain is why a
// mount, a focus or a chip switch may never generate). Rendering thumbs is free server-side.
//
// ⚠️ NO Animated IN THIS FILE. It feeds the native-driver carousel tree; a JS-driven value created
// here would land inside that tree (the b126-128 fatal crash).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Target } from '../../services/employerHomeService';
import { signedInAccount, type DocKind } from '../../services/homeAddEmployer';
import {
  cachedCurrentDoc, docLookupOf, fetchCurrentDoc, fetchDocCards, fetchDocList, rememberDoc,
  type DocCard, type DocListItem, type DocLookup, type DocMeta,
} from '../../services/employerDocs';
import type { PaperCard } from './PaperCarousel';

/**
 * Injectable data sources, defaulting to the real services. The dev preview harness passes fixtures
 * so a ranked doc deck with fit badges renders signed-out — an injected loader replaces the network.
 */
export type DocLoaders = {
  current?: (kind: DocKind, q: DocLookup) => Promise<DocMeta | null | 'error'>;
  cards?: (kind: DocKind, docId: number, ids: string[]) => Promise<{ cards: DocCard[] } | 'gone' | null>;
  list?: (kind: DocKind) => Promise<DocListItem[] | null>;
};

/** A deck card as this file produces it. A PaperCard (so the carousel takes it as-is) plus the fit. */
export type DocDeckCard = PaperCard & { fit?: number | null; reason?: string | null };

/* ── useDocList ────────────────────────────────────────────────────────────────────────────────── */

/**
 * Every saved (non-base) doc of this kind, newest first. `null` until the first answer.
 *
 * ⚠️ A FAILED REFRESH KEEPS THE LAST LIST — unless the account changed underneath it. App.js's logout
 * never reloads the bundle, so component state outlives a sign-out; a list fetched for the previous
 * account would draw "tailored" dots on the next account's chips if a network blip kept it alive.
 */
export function useDocList(kind: DocKind, refreshToken: number, loaders?: DocLoaders):
  { list: DocListItem[] | null; reload: () => void } {
  // Held per kind, so flipping Resume ⇄ Letter shows the other kind's last list at once.
  const [held, setHeld] = useState<{ account: string | null; lists: Partial<Record<DocKind, DocListItem[]>> } | null>(null);
  const [nonce, setNonce] = useState(0);
  const loadersRef = useRef(loaders);
  loadersRef.current = loaders;
  // ⚠️ SEQUENCE GUARD: a mode switch and a build landing can overlap; an older answer landing last
  // must not replace the newer one.
  const seq = useRef(0);

  useEffect(() => {
    const my = ++seq.current;
    const load = loadersRef.current?.list || fetchDocList;
    (async () => {
      const [list, account] = await Promise.all([
        Promise.resolve().then(() => load(kind)).catch(() => null),
        signedInAccount().catch(() => null),
      ]);
      if (my !== seq.current) return;
      setHeld((prev) => {
        const mine = prev && prev.account === account ? prev.lists : {};
        if (!list) return prev && prev.account === account ? prev : null;
        return { account, lists: { ...mine, [kind]: list } };
      });
    })();
  }, [kind, refreshToken, nonce]);

  // Unmount invalidates whatever is in flight.
  useEffect(() => () => { seq.current++; }, []);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { list: (held && held.lists[kind]) || null, reload };
}

/* ── useTargetDoc ──────────────────────────────────────────────────────────────────────────────── */

type DocState = 'idle' | 'loading' | 'ready' | 'none' | 'error';
type Held = { key: string; doc: DocMeta | null; state: DocState };

/**
 * The saved document for the chip on screen.
 *
 * ⚠️ SYNCHRONOUS FIRST PAINT FROM MEMORY. The answer for a target is derived DURING RENDER from
 * cachedCurrentDoc whenever the held answer belongs to a different target — never set in an effect
 * afterwards, which would paint one frame of the PREVIOUS employer's resume under the new chip (the
 * exact "wrong company" confusion this feature exists to remove). Then it revalidates over the
 * network, which is also what carries `stale`.
 *
 * ⚠️ KEYED ON THE LOOKUP'S CONTENT, NOT THE Target OBJECT. fetchTargets rebuilds every Target on each
 * focus reload; keying on identity would refetch every chip's doc on every reload.
 *
 * ⚠️ A FAILED REVALIDATION LEAVES WHAT IS ON SCREEN ALONE. 'error' is only reported when there was
 * nothing to show — a flaky connection must never turn a saved resume into a "Tailor my resume" CTA
 * (that CTA leads to a paid build).
 */
export function useTargetDoc(
  kind: DocKind,
  target: Target | null,
  opts: { refreshToken: number; loaders?: DocLoaders },
): { doc: DocMeta | null; state: DocState; reload: () => void } {
  const q: DocLookup | null = target ? docLookupOf(target) : null;
  const lookupKey = q
    ? JSON.stringify([kind, q.employer, q.employerId ?? null, q.website ?? null, q.jobUrl ?? '',
      q.jobTitle ?? '', q.jobText ?? '', q.country ?? null])
    : '';
  const qRef = useRef(q);
  qRef.current = q;
  const loadersRef = useRef(opts.loaders);
  loadersRef.current = opts.loaders;

  const [held, setHeld] = useState<Held | null>(null);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);

  // What this render shows — see the header: held when it is for THIS target, else memory.
  let shown: { doc: DocMeta | null; state: DocState };
  if (!q) shown = { doc: null, state: 'idle' };
  else if (held && held.key === lookupKey) shown = { doc: held.doc, state: held.state };
  else {
    const c = cachedCurrentDoc(kind, q);
    shown = c === undefined ? { doc: null, state: 'loading' } : { doc: c, state: c ? 'ready' : 'none' };
  }
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    const my = ++seq.current;
    const lookup = qRef.current;
    if (!lookup) return;
    // A retry of a lookup that failed goes back to 'loading' rather than sitting on the error.
    if (shownRef.current.state === 'error') setHeld({ key: lookupKey, doc: null, state: 'loading' });
    const load = loadersRef.current?.current || fetchCurrentDoc;
    (async () => {
      let got: DocMeta | null | 'error';
      try { got = await load(kind, lookup); } catch { got = 'error'; }
      // ⚠️ The user already left this target (or a newer refresh started): drop the answer.
      if (my !== seq.current) return;
      if (got === 'error') {
        const now = shownRef.current;
        if (now.state === 'ready' || now.state === 'none') return;   // keep what is on screen
        setHeld({ key: lookupKey, doc: null, state: 'error' });
        return;
      }
      rememberDoc(kind, lookup, got);
      setHeld({ key: lookupKey, doc: got, state: got ? 'ready' : 'none' });
    })();
    // lookupKey carries kind + every lookup field, so the refs above are always this key's values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupKey, opts.refreshToken, nonce]);

  useEffect(() => () => { seq.current++; }, []);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const { doc, state } = shown;
  return useMemo(() => ({ doc, state, reload }), [doc, state, reload]);
}

/* ── useDocDeck ────────────────────────────────────────────────────────────────────────────────── */

/**
 * Page images, per document VERSION. Module-level so switching chips and back is instant: the images
 * belong to (account, kind, docId, updatedAt, design id), none of which a chip switch changes, and an
 * edit or a rebuild bumps updatedAt so an old page can never be shown for new content.
 * ⚠️ OWNED BY THE SIGNED-IN ACCOUNT: the account is part of every key and the whole store is wiped
 * the moment a different account is seen (logout never reloads the bundle — see signedInAccount).
 * ⚠️ BOUNDED. Each image is a base64 JPEG data URI (~50-150 KB of string); insertion-ordered LRU.
 */
const IMG_MAX = 160;
const images = new Map<string, string>();
/** Designs the renderer did not return for a doc version → skip until `until` (ms epoch). */
const dead = new Map<string, number>();
/** Doc versions the server says no longer exist (404 doc_gone). */
const goneVersions = new Set<string>();
/** Server-side names for ids the catalogue did not know yet (resume catalogue still loading). */
const names = new Map<string, { name: string; accent?: string }>();
let knownAccount: string | null | undefined;
/** Readers to knock when the store is wiped or filled by another hook instance. */
const deckListeners = new Set<() => void>();

function adoptAccount(acct: string | null): boolean {
  if (acct === knownAccount) return false;
  const hadOwner = knownAccount !== undefined;
  knownAccount = acct;
  if (hadOwner) { images.clear(); dead.clear(); goneVersions.clear(); names.clear(); }
  return true;
}
const versionKeyOf = (kind: DocKind, doc: DocMeta) =>
  `${knownAccount ?? '-'}|${kind}|${doc.docId}|${doc.updatedAt}`;
function readImage(k: string): string | null {
  const v = images.get(k);
  if (v === undefined) return null;
  images.delete(k); images.set(k, v);          // touch → most recent
  return v;
}
function writeImage(k: string, v: string) {
  images.delete(k); images.set(k, v);
  while (images.size > IMG_MAX) {
    const oldest = images.keys().next().value;
    if (oldest === undefined) break;
    images.delete(oldest);
  }
}

/**
 * ⚠️ ONE WAVE AT A TIME FOR THE WHOLE APP, not per hook: renders are serial server-side and
 * single-process chromium dies after ~4-5 pages, so two decks (or a remount mid-wave) must never
 * fire parallel waves. A run that finds the flight busy registers to be knocked when it lands —
 * otherwise a wave cancelled by a chip switch left the new doc's designs blank until a swipe
 * (the same bug EmployerHome's base hydrator fixed with hydrateNudge).
 */
let flying = false;
const flightWaiters = new Set<() => void>();

const WINDOW = 6;
const BATCH_RESUME = 5;   // /resume-builder/home-cards caps a request at 5 ids
const BATCH_LETTER = 3;   // /cover-letter/employer-cards caps a request at 3 ids
/** A request that got no answer at all: retry those designs after this, not on every swipe. */
const FAIL_BACKOFF_MS = 60_000;

const prettyId = (id: string) =>
  id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()).trim() || id;
const fitOf = (n: unknown): number | null =>
  typeof n === 'number' && isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;

/**
 * The selected doc's designs as carousel cards, in the order the server ranked them (highest chance
 * of being picked first), each carrying its fit % and the one-line reason.
 *
 * Deck = design.ranked mapped onto the catalogue (ids the catalogue does not know are skipped;
 * catalogue ids the ranking missed follow with fit null). While the resume catalogue has not loaded
 * yet (empty), ranked ids are shown under their server-given or prettified names instead of an empty
 * deck — the carousel must never draw a blank hole for a doc that exists.
 *
 * Images are filled in around the card on screen, like EmployerHome's base hydrator: ±6 cards, at
 * most 5 ids per request for resumes / 3 for letters, one wave at a time, 260 ms after the deck
 * settles. Ids a reply leaves out are dead for that doc version; a doc the server no longer has
 * sets `gone` so the screen can re-look it up instead of showing blank pages forever.
 */
export function useDocDeck(
  kind: DocKind,
  doc: DocMeta | null,
  catalogue: Array<{ id: string; name: string; accent?: string }>,
  cardIdx: number,
  opts?: { loaders?: DocLoaders; enabled?: boolean },
): { deck: DocDeckCard[]; gone: boolean } {
  const enabled = opts?.enabled !== false;
  const loadersRef = useRef(opts?.loaders);
  loadersRef.current = opts?.loaders;
  // Bumped whenever the module store changes in a way this deck should re-read.
  const [ver, setVer] = useState(0);
  const [nudge, setNudge] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const knock = () => { if (alive.current) setVer((v) => v + 1); };
    deckListeners.add(knock);
    // Resolve the owner once on mount: keys read during render use the last known account.
    signedInAccount().catch(() => null).then((acct) => {
      if (adoptAccount(acct)) deckListeners.forEach((fn) => fn());
    });
    return () => { alive.current = false; deckListeners.delete(knock); };
  }, []);

  const vKey = doc ? versionKeyOf(kind, doc) : '';

  const deck: DocDeckCard[] = useMemo(() => {
    if (!doc) return [];
    const known = new Map(catalogue.map((c) => [c.id, c] as const));
    const ranked = Array.isArray(doc.design?.ranked) ? doc.design!.ranked : [];
    const seen = new Set<string>();
    const out: DocDeckCard[] = [];
    const push = (id: string, fit: number | null, reason: string | null) => {
      const meta = known.get(id) || (!catalogue.length ? (names.get(id) || { name: prettyId(id) }) : null);
      if (!meta || seen.has(id)) return;
      seen.add(id);
      const card: DocDeckCard = {
        id, name: meta.name, accent: meta.accent, image: readImage(`${vKey}|${id}`), fit, reason,
      };
      out.push(card);
    };
    for (const r of ranked) {
      if (!r || typeof r.id !== 'string') continue;
      push(r.id, fitOf(r.score), typeof r.reason === 'string' && r.reason ? r.reason : null);
    }
    for (const c of catalogue) push(c.id, null, null);
    return out;
    // ver: the module image store changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, catalogue, vKey, ver]);

  const gone = !!vKey && goneVersions.has(vKey);

  useEffect(() => {
    if (!enabled || !doc || !deck.length || gone) return;
    let cancelled = false;
    const docId = doc.docId;
    const version = vKey;
    const run = async () => {
      if (flying) { flightWaiters.add(retry); return; }
      // ⚠️ Re-check the owner per wave: a different account means every key above is someone
      // else's. Wipe, knock every deck (their version keys change) and let the re-run ask again.
      const acct = await signedInAccount().catch(() => null);
      if (adoptAccount(acct)) { deckListeners.forEach((fn) => fn()); return; }
      if (cancelled || flying) { if (!cancelled) flightWaiters.add(retry); return; }
      const now = Date.now();
      const batch = kind === 'cover_letter' ? BATCH_LETTER : BATCH_RESUME;
      // ⚠️ BOUNDED to the cards either side of the one on screen, walked outward from the centre in
      // the same order PaperCarousel's "writing" words assume. An unbounded search would always find
      // more missing designs, each wave triggering the next until the whole catalogue had rendered
      // off one glance — the stampede the per-request cap exists to prevent.
      const want: string[] = [];
      for (let k = 0; k <= WINDOW * 2 && want.length < batch; k++) {
        const i = cardIdx + (k % 2 === 0 ? k / 2 : -((k + 1) / 2));
        if (i < 0 || i >= deck.length) continue;
        const d = deck[Math.round(i)];
        if (!d || d.image || want.includes(d.id)) continue;
        const until = dead.get(`${version}|${d.id}`);
        if (until !== undefined && until > now) continue;
        want.push(d.id);
      }
      if (!want.length) return;
      flying = true;
      try {
        const load = loadersRef.current?.cards || fetchDocCards;
        let got: { cards: DocCard[] } | 'gone' | null;
        try { got = await load(kind, docId, want); } catch { got = null; }
        // ⚠️ Stored even when this effect was cancelled: the key is the doc VERSION, so pixels for a
        // doc the user just switched away from are still right when they switch back.
        if (got === 'gone') {
          goneVersions.add(version);
        } else if (got && Array.isArray(got.cards)) {
          const add = new Set<string>();
          for (const c of got.cards) {
            if (!c || !c.id) continue;
            if (c.name && !names.has(c.id)) names.set(c.id, { name: c.name, accent: c.accent });
            if (c.image && want.includes(c.id)) { writeImage(`${version}|${c.id}`, c.image); add.add(c.id); }
          }
          for (const id of want) if (!add.has(id)) dead.set(`${version}|${id}`, Infinity);
        } else {
          // No answer at all: don't hammer a failing renderer, but a dropped connection is not a
          // verdict on the design — try again after a while.
          for (const id of want) dead.set(`${version}|${id}`, Date.now() + FAIL_BACKOFF_MS);
        }
        if (alive.current) setVer((v) => v + 1);
      } finally {
        flying = false;
        const waiting = Array.from(flightWaiters);
        flightWaiters.clear();
        waiting.forEach((fn) => fn());
        if (cancelled && alive.current) setNudge((n) => n + 1);
      }
    };
    function retry() { if (!cancelled && alive.current) setNudge((n) => n + 1); }
    const id = setTimeout(run, 260);
    return () => { cancelled = true; clearTimeout(id); flightWaiters.delete(retry); };
  }, [kind, doc, vKey, cardIdx, deck, enabled, gone, nudge]);

  return { deck, gone };
}
