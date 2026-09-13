// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The per-employer documents: one resume and one cover letter the AI rewrote for ONE employer (or one
// posting at it), stored server-side in user_employer_documents with the design ranking beside them.
//
// Switching chips on Home must show THAT employer's own document immediately. Three layers make that:
//   cachedCurrentDoc  → sync memory, so a chip switch paints the known answer in the same frame
//   fetchCurrentDoc   → POST /employer-docs/current, the authority (and the only source of `stale`)
//   fetchDocList      → GET /employer-docs, slim rows for the "this chip has a document" dots
//
// ⚠️ ONE LOOKUP SPELLING. docLookupOf is the ONLY way a Target becomes a lookup, and both the build
// (useHomeBuilds → homeAddEmployer) and the lookup (useTargetDoc) must go through it. The server finds a
// document by (employer, job_url): a build that sent a posting URL the lookup did not (or the other way
// round) saves a document no chip can ever find again — the user paid for a resume that never shows.
//
// ⚠️ NOTHING HERE BUILDS OR CHARGES. Every call is a read, except saveDocPayload, which stores the user's
// own edit. A lookup that says "no document" is an invitation to an explicit tap, never a trigger.
//
// ⚠️ THREE OUTCOMES, NEVER TWO. 'error' / null (could not find out) is kept apart from "the server says
// there is none" everywhere, for the same reason as fetchHomeCards: a flaky network must never be
// mistaken for "no document", or Home offers to build (and charge for) one the user already has.
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';
import { signedInAccount } from './homeAddEmployer';
import type { DocKind } from './homeAddEmployer';
import { cachedJobListing, cleanJobUrl, deviceHeaders, keepJobListings } from './employerHomeService';
import type { Target } from './employerHomeService';

export type Design = {
  v: number;
  kind: DocKind;
  ranked: Array<{ id: string; score: number; reason?: string }>;
  mode?: 'a4' | 'onepage';
  brandColor?: string | null;
  tone?: string | null;
  region?: string | null;
  headline?: string | null;
};

/**
 * The exact job a document was built from — the object the server hashed into its fingerprint (and uses for
 * `stale`). ⚠️ What Refresh must send to rebuild the SAME posting: the device's pasted listing can be gone
 * or rewritten since, and a rebuild spelled from today's lookup would silently drop the posting.
 */
export type DocJobInput = { title: string; url: string; description: string; website: string };

export type DocMeta = {
  docId: number;
  kind: DocKind;
  employer: string;
  employerId: string | null;
  jobUrl: string;
  jobTitle: string;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  stale: boolean;
  design: Design | null;
  summary?: { title?: string; subject?: string };
  /** null for a document stored before the server kept it (current and GET :id both carry it). Optional in
   *  the type only so hand-written fixtures still compile; shapeMeta always sets it. */
  jobInput?: DocJobInput | null;
};

export type DocLookup = {
  employer: string;
  employerId?: string | null;
  website?: string | null;
  /** The doc's IDENTITY: the posting URL for a posting chip, '' for an employer chip. */
  jobUrl?: string | null;
  /**
   * The posting to WRITE AGAINST (scraped by the build, part of the fingerprint) — never identity. A posting
   * chip: its own URL. An employer chip: the job link pasted in Add employer for that company or website,
   * else null. ⚠️ Kept apart from jobUrl on purpose: folding the pasted link into jobUrl would file the
   * document under a posting no employer chip ever looks up, and leaving it out altogether (as before) wrote
   * the resume against the company in general while the user had given us the job.
   */
  postingUrl?: string | null;
  jobTitle?: string | null;
  jobText?: string | null;
  country?: string | null;
};

export type DocCard = { id: string; name: string; accent?: string; image?: string | null; fit?: number | null; reason?: string | null };

export type DocListItem = {
  docId: number;
  employer: string;
  employerId: string | null;
  jobUrl: string;
  jobTitle: string;
  updatedAt: string;
  topId: string | null;
  topScore: number | null;
};

/* ── TRANSPORT ────────────────────────────────────────────────────────────────────────────────────── */

async function token(): Promise<string | undefined> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    return JSON.parse(raw || '{}')?.token;
  } catch { return undefined; }
}

/**
 * One request. `null` means we never got an answer (no token, dropped connection, timeout) — which
 * callers must keep distinct from any answer the server actually gave.
 * ⚠️ API_BASE is read HERE, per call: it is a live binding the admin environment switch reassigns.
 */
async function call(path: string, init: { method?: 'GET' | 'POST' | 'PUT'; body?: any; ms?: number } = {}):
  Promise<{ status: number; ok: boolean; json: any } | null> {
  const t = await token();
  if (!t) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.ms || 20000);
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method: init.method || 'GET',
      // x-device-id on every call, like the rest of Home (see employerHomeService deviceHeaders).
      headers: init.body !== undefined
        ? { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(await deviceHeaders()) }
        : { Authorization: `Bearer ${t}`, ...(await deviceHeaders()) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctl.signal,
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, json: json && typeof json === 'object' ? json : {} };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/**
 * ⚠️ A 404 IS 'gone' ONLY WHEN THE SERVER SAYS SO. Express answers an unknown route (an older server that
 * does not have these endpoints yet) with a 404 too — as HTML, no reason. Reading that as "your document
 * was deleted" would drop a deck the user still has; it is "could not find out" instead.
 */
const saysGone = (r: { status: number; json: any }) =>
  r.status === 404 && (r.json.reason === 'doc_gone' || r.json.reason === 'gone' || r.json.reason === 'payload_gone');

/* ── SHAPING (the client never trusts a field it did not check) ──────────────────────────────────── */

const str = (v: any): string => (v == null ? '' : String(v));
const optStr = (v: any, max = 400): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
};
const kindOf = (v: any): DocKind | null => (v === 'resume' || v === 'cover_letter' ? v : null);
const docIdOf = (v: any): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const scoreOf = (v: any): number | null => {
  const n = Number(v);
  return v != null && v !== '' && isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
};

function shapeDesign(raw: any, fallbackKind: DocKind): Design | null {
  if (!raw || typeof raw !== 'object') return null;
  const seen = new Set<string>();
  const rows: Array<{ id: string; score: number; reason?: string; i: number }> = [];
  (Array.isArray(raw.ranked) ? raw.ranked : []).forEach((r: any, i: number) => {
    const id = r && typeof r.id === 'string' ? r.id.trim() : '';
    if (!id || seen.has(id)) return;
    seen.add(id);
    const reason = typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim().slice(0, 90) : undefined;
    rows.push({ id, score: scoreOf(r.score) ?? 0, reason, i });
  });
  // The server already sorts; this only guards the order a card deck is DRAWN in against a stored design
  // that predates the invariant. Explicit index tie-break = catalogue order, whatever the engine's sort.
  rows.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  const brand = typeof raw.brandColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.brandColor) ? raw.brandColor : null;
  return {
    v: Number(raw.v) || 1,
    kind: kindOf(raw.kind) || fallbackKind,
    ranked: rows.map(({ id, score, reason }) => (reason ? { id, score, reason } : { id, score })),
    mode: raw.mode === 'a4' || raw.mode === 'onepage' ? raw.mode : undefined,
    brandColor: brand,
    tone: optStr(raw.tone, 40),
    region: optStr(raw.region, 20),
    headline: optStr(raw.headline, 120),
  };
}

function shapeJobInput(v: any): DocJobInput | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  // ⚠️ Never trimmed or cut: these are the bytes the server hashed, and a rebuild that sent a shortened
  // description would miss the document it means to refresh.
  const f = (x: any) => (typeof x === 'string' ? x : x == null ? '' : String(x));
  const out = { title: f(v.title), url: f(v.url), description: f(v.description), website: f(v.website) };
  return out.title || out.url || out.description || out.website ? out : null;
}

function shapeMeta(d: any): DocMeta | null {
  if (!d || typeof d !== 'object') return null;
  const docId = docIdOf(d.docId);
  const kind = kindOf(d.kind);
  if (!docId || !kind) return null;
  const s = d.summary && typeof d.summary === 'object' ? d.summary : {};
  return {
    docId,
    kind,
    employer: str(d.employer),
    employerId: d.employerId ? String(d.employerId) : null,
    jobUrl: str(d.jobUrl),
    jobTitle: str(d.jobTitle),
    createdAt: str(d.createdAt),
    updatedAt: str(d.updatedAt),
    editedAt: d.editedAt ? String(d.editedAt) : null,
    stale: d.stale === true,
    design: shapeDesign(d.design, kind),
    summary: { title: str(s.title), subject: str(s.subject) },
    jobInput: shapeJobInput(d.jobInput),
  };
}

function shapeItem(d: any): DocListItem | null {
  if (!d || typeof d !== 'object') return null;
  const docId = docIdOf(d.docId);
  if (!docId) return null;
  return {
    docId,
    employer: str(d.employer),
    employerId: d.employerId ? String(d.employerId) : null,
    jobUrl: str(d.jobUrl),
    jobTitle: str(d.jobTitle),
    updatedAt: str(d.updatedAt),
    topId: typeof d.topId === 'string' && d.topId ? d.topId : null,
    topScore: scoreOf(d.topScore),
  };
}

function shapeCard(c: any): DocCard | null {
  if (!c || typeof c.id !== 'string' || !c.id) return null;
  return {
    id: c.id,
    name: str(c.name) || c.id,
    accent: typeof c.accent === 'string' && c.accent ? c.accent : undefined,
    image: typeof c.image === 'string' && c.image ? c.image : null,
    fit: scoreOf(c.fit),
    reason: typeof c.reason === 'string' && c.reason.trim() ? c.reason.trim() : null,
  };
}

/* ── IDENTITY ─────────────────────────────────────────────────────────────────────────────────────── */

// Legal-form words that say nothing about WHICH employer: "Nordex SE" and "Nordex" are one company.
// ⚠️ Stripped only from the END, and never the last word left — "AB InBev" and "Co-op" keep their names.
const LEGAL_SUFFIXES = new Set([
  'inc', 'llc', 'ltd', 'gmbh', 'ag', 'se', 'sa', 'as', 'bv', 'nv', 'plc', 'corp', 'co', 'ab', 'oy', 'spa', 'srl',
  'kg', 'corporation', 'incorporated', 'limited',
]);

// ASCII punctuation and the common Unicode punctuation blocks (Latin-1 symbols, general punctuation, CJK
// punctuation). Built from code points so the source stays plain ASCII. Letters in any script survive.
const cp = (n: number) => String.fromCharCode(n);
const PUNCT_RE = new RegExp(
  '[!-/:-@\\[-`{-~' + cp(0xa1) + '-' + cp(0xbf) + cp(0x2010) + '-' + cp(0x2027)
  + cp(0x2030) + '-' + cp(0x205e) + cp(0x3000) + '-' + cp(0x303f) + ']+', 'g');

function employerNameKey(s: string): string {
  let x = String(s || '').toLowerCase();
  x = x.replace(/\b([as])\s*\/\s*([as])\b/g, '$1$2');       // A/S, S/A → as, sa
  x = x.replace(/\b([a-z])\.(?=[a-z]\b)/g, '$1');            // S.A. / B.V. / S.p.A. → sa. bv. spa.
  x = x.replace(PUNCT_RE, ' ');                            // punctuation → spaces
  const words = x.split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join('');
}

/**
 * Same employer by name. The client's HINT only — the server's identity is downloads.employerKeyOf /
 * sameEmployer, and the /employer-docs/current answer is what a chip actually shows.
 */
export function sameEmployerName(a: string, b: string): boolean {
  const ka = employerNameKey(a);
  return !!ka && ka === employerNameKey(b);
}

/**
 * The ONE Target → lookup conversion (see the header).
 *   • a posting chip (key job_…) is identified by its posting URL; an employer chip by '' — the
 *     server stores an employer-level document under an empty job_url.
 *   • jobText is the listing the user pasted when they added this employer, read SYNCHRONOUSLY from
 *     employerHomeService's mirror (warmed before any chip exists).
 *   • postingUrl is what the build writes against: a posting chip's own URL, or for an employer chip the
 *     job LINK pasted with that listing. ⚠️ The Add sheet's link used to be dropped here (an employer chip's
 *     jobUrl is '' by identity), so a link pasted without description text changed nothing at all.
 * ⚠️ A posting chip reads a listing by ITS URL, or a company/website listing only when that listing was
 * saved for this very posting. A listing pasted for "Airbus" in general is not the text of every Airbus
 * posting, and tailoring the Team Lead resume to the Senior Engineer ad would be a wrong document.
 */
export function docLookupOf(t: Target): DocLookup {
  const posting = String(t.key || '').startsWith('job_');
  const jobUrl = posting ? String(t.applyUrl || t.jobUrl || '').trim() : '';
  let listing = null as ReturnType<typeof cachedJobListing>;
  if (posting) {
    listing = cachedJobListing([t.applyUrl, t.jobUrl]);
    if (!listing && jobUrl) {
      const byName = cachedJobListing([t.company, t.website]);
      const want = (cleanJobUrl(jobUrl) || jobUrl).toLowerCase();
      if (byName && byName.jobUrl && (cleanJobUrl(byName.jobUrl) || byName.jobUrl).toLowerCase() === want) listing = byName;
    }
  } else {
    listing = cachedJobListing([t.company, t.website]);
  }
  const pastedLink = listing && typeof listing.jobUrl === 'string' ? listing.jobUrl.trim() : '';
  return {
    employer: t.company,
    employerId: t.employerId ?? null,
    website: t.website ?? null,
    jobUrl,
    postingUrl: posting ? (jobUrl || null) : (pastedLink || null),
    jobTitle: t.role || '',
    jobText: (listing && typeof listing.jobText === 'string' ? listing.jobText : '') || '',
    country: t.country ?? null,
  };
}

/* ── THE MEMORY CACHE (owned by the signed-in account) ────────────────────────────────────────────── *
 *
 * ⚠️ WHOSE CACHE THIS IS. Logout never reloads the bundle (see signedInAccount), so module state outlives a
 * sign-out. Every network read claims the cache for the account signed in NOW and wipes it when that is
 * someone else; an answer that arrives after the account changed is reported as 'error' / null and never
 * remembered. forgetDocs (EmployerHome's account switch) wipes it outright.
 *
 * Entries live under two keys: the employer NAME (+ posting URL) always, the employer ID (+ posting URL)
 * when the lookup had one. The server matches employer_id OR employer name, so:
 *   • a document found for a name is valid for any chip with that name;
 *   • "no document" found for a name is NOT proof for a chip with an id (the id can find a document stored
 *     under another name — the shared row that was named by a job ingest), so a null is served to an id
 *     lookup only when it was produced by that same id.
 */
type Entry = { meta: DocMeta | null; employerId: string | null };
const CACHE_MAX = 200;
const docCache = new Map<string, Entry>();
/** undefined = never claimed (the first claim ADOPTS whatever is here: it was written by whoever is signed in). */
let docOwner: string | null | undefined;
/** Bumped by forgetDocs so an answer that was in flight across it is not remembered into the new cache. */
let docGen = 0;

async function claimDocs(): Promise<{ who: string | null; gen: number }> {
  const who = await signedInAccount().catch(() => null);
  if (docOwner !== undefined && docOwner !== who) docCache.clear();
  docOwner = who;
  return { who, gen: docGen };
}

/** Still the same account, and no forgetDocs in between? */
async function stillOwner(c: { who: string | null; gen: number }): Promise<boolean> {
  if (c.gen !== docGen || !c.who) return false;
  const now = await signedInAccount().catch(() => null);
  return now === c.who && docOwner === c.who && c.gen === docGen;
}

// ⚠️ Keyed on jobUrl (identity) only, never postingUrl: which document a chip has does not change with the
// link it would be written against.
const urlPart = (q: DocLookup) => String(q.jobUrl || '').trim();
const nameKeyOf = (kind: DocKind, q: DocLookup) =>
  `${kind}|n:${employerNameKey(q.employer) || String(q.employer || '').trim().toLowerCase()}|${urlPart(q)}`;
const idKeyOf = (kind: DocKind, q: DocLookup) =>
  (q.employerId ? `${kind}|i:${String(q.employerId)}|${urlPart(q)}` : null);

function put(key: string, e: Entry) {
  docCache.delete(key);                 // re-insert = most recent (Map keeps insertion order)
  docCache.set(key, e);
  while (docCache.size > CACHE_MAX) {
    const oldest = docCache.keys().next().value;
    if (oldest === undefined) break;
    docCache.delete(oldest);
  }
}

/** The remembered answer: a document, null (the server said there is none), or undefined (never asked). */
export function cachedCurrentDoc(kind: DocKind, q: DocLookup): DocMeta | null | undefined {
  if (!q || !String(q.employer || '').trim()) return undefined;
  const ik = idKeyOf(kind, q);
  if (ik) {
    const byId = docCache.get(ik);
    if (byId) return byId.meta;
  }
  const byName = docCache.get(nameKeyOf(kind, q));
  if (!byName) return undefined;
  if (byName.meta) return byName.meta;
  // A remembered "none": only an answer to the same question (no id, or this very id).
  const qid = q.employerId ? String(q.employerId) : null;
  return !qid || byName.employerId === qid ? null : undefined;
}

export function rememberDoc(kind: DocKind, q: DocLookup, meta: DocMeta | null): void {
  if (!q || !String(q.employer || '').trim()) return;
  if (meta && meta.kind !== kind) return;
  // ⚠️ A saved document was found with this lookup's listing: keep that listing out of the device store's
  // ordinary eviction (employerHomeService, "The posting a user is applying to"). Evicting it changed what
  // this chip's Refresh would send — the document would be rebuilt without the posting it was written for.
  if (meta && (q.jobText || (!urlPart(q) && q.postingUrl))) {
    try { keepJobListings([urlPart(q), q.employer, q.website], { jobText: q.jobText, postingUrl: q.postingUrl }); } catch { /* best effort */ }
  }
  const employerId = q.employerId ? String(q.employerId) : null;
  const entry: Entry = { meta: meta || null, employerId };
  const ik = idKeyOf(kind, q);
  if (ik) put(ik, entry);
  // ⚠️ A document the server matched by ID under a DIFFERENT name is not filed under this name: a chip
  // with this name but no id would be handed a document the server would not give it.
  if (!meta || !ik || sameEmployerName(meta.employer, q.employer)) put(nameKeyOf(kind, q), entry);
}

/** Account switch: drop everything, and disown every answer still in flight. */
export function forgetDocs(): void {
  docCache.clear();
  docOwner = undefined;
  docGen++;
}

/* ── READS ────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The newest document for this target, or null when the server says there is none.
 * 'error' = we could not find out: the caller keeps whatever it already shows and offers NO build for it.
 */
export async function fetchCurrentDoc(kind: DocKind, q: DocLookup): Promise<DocMeta | null | 'error'> {
  const employer = String(q?.employer || '').trim();
  if (!employer || !kindOf(kind)) return 'error';
  const owner = await claimDocs();
  if (!owner.who) return 'error';
  const body: Record<string, any> = { kind, employer };
  // Empty fields are left out rather than sent as '' — the same discipline as the build's jobFields.
  if (q.employerId) body.employerId = String(q.employerId);
  if (q.website) body.website = String(q.website);
  const url = urlPart(q);
  if (url) body.jobUrl = url;
  // The posting the stale check fingerprints when the document has no stored job_input (an old row). Not
  // identity: the server still finds the document by jobUrl.
  const posting = String(q.postingUrl || '').trim();
  if (posting) body.postingUrl = posting;
  if (q.jobTitle) body.jobTitle = String(q.jobTitle);
  if (q.jobText) body.jobText = String(q.jobText);
  if (q.country) body.country = String(q.country);
  // Generous: `stale` fingerprints the user's current resume on the server, which reads it from the DB.
  const r = await call('/employer-docs/current', { method: 'POST', body, ms: 25000 });
  if (!r || !r.ok || r.json.success === false || !('doc' in r.json)) return 'error';
  let meta: DocMeta | null = null;
  if (r.json.doc != null) {
    meta = shapeMeta(r.json.doc);
    if (!meta || meta.kind !== kind) return 'error';   // an answer we cannot read is not "none"
  }
  if (!(await stillOwner(owner))) return 'error';
  rememberDoc(kind, q, meta);
  return meta;
}

/** Slim rows for every document of this kind, newest first. null = could not find out. */
export async function fetchDocList(kind: DocKind): Promise<DocListItem[] | null> {
  if (!kindOf(kind)) return null;
  const owner = await claimDocs();
  if (!owner.who) return null;
  const r = await call(`/employer-docs?kind=${encodeURIComponent(kind)}`, { ms: 20000 });
  if (!r || !r.ok || !Array.isArray(r.json.docs)) return null;
  const list = r.json.docs.map(shapeItem).filter((x: DocListItem | null): x is DocListItem => !!x);
  if (!(await stillOwner(owner))) return null;
  return list;
}

/**
 * The list row for a chip (newest wins — the list is newest first). Mirrors the server's match: the same
 * posting URL, and the employer id OR the employer name.
 */
export function matchDocToTarget(list: DocListItem[], t: Target, kind: DocKind): DocListItem | null {
  // `kind` is carried for the call site's sake: a list is fetched per kind, so its rows are all that kind.
  if (!Array.isArray(list) || !list.length || !t || !kindOf(kind)) return null;
  const url = String(docLookupOf(t).jobUrl || '');
  const tid = t.employerId ? String(t.employerId) : null;
  for (const d of list) {
    if (!d || String(d.jobUrl || '').trim() !== url) continue;
    if ((tid && d.employerId && String(d.employerId) === tid) || sameEmployerName(d.employer, t.company)) return d;
  }
  return null;
}

/**
 * Rendered pages for some designs of one document. 'gone' = the server says the document no longer
 * exists; null = no usable answer (keep what is shown, try again later).
 * ⚠️ Rendering is serial on the server — callers ask for a few ids at a time, never the catalogue.
 */
export async function fetchDocCards(kind: DocKind, docId: number, ids: string[]):
  Promise<{ cards: DocCard[] } | 'gone' | null> {
  const id = docIdOf(docId);
  if (!id || !kindOf(kind)) return null;
  const owner = await claimDocs();
  if (!owner.who) return null;
  const want = (Array.isArray(ids) ? ids : []).map((x) => String(x || '').trim()).filter(Boolean);
  const q = `doc=${id}${want.length ? `&ids=${encodeURIComponent(want.join(','))}` : ''}`;
  const path = kind === 'cover_letter' ? `/cover-letter/employer-cards?${q}` : `/resume-builder/home-cards?${q}`;
  const r = await call(path, { ms: 60000 });
  if (!r) return null;
  if (saysGone(r)) return (await stillOwner(owner)) ? 'gone' : null;
  if (!r.ok || !Array.isArray(r.json.cards)) return null;
  const cards = r.json.cards.map(shapeCard).filter((c: DocCard | null): c is DocCard => !!c);
  if (!(await stillOwner(owner))) return null;
  return { cards };
}

/** One document with its payload (the resume JSON, or the letter fields). 'gone' | null as above. */
export async function fetchDoc(docId: number): Promise<(DocMeta & { payload: any }) | 'gone' | null> {
  const id = docIdOf(docId);
  if (!id) return null;
  const owner = await claimDocs();
  if (!owner.who) return null;
  const r = await call(`/employer-docs/${id}`, { ms: 30000 });
  if (!r) return null;
  if (saysGone(r)) return (await stillOwner(owner)) ? 'gone' : null;
  if (!r.ok || !r.json.doc || typeof r.json.doc !== 'object') return null;
  const meta = shapeMeta(r.json.doc);
  const payload = r.json.doc.payload;
  // A document with no readable payload cannot be edited or rendered; it is not "gone" either.
  if (!meta || !payload || typeof payload !== 'object') return null;
  if (!(await stillOwner(owner))) return null;
  return { ...meta, payload };
}

/* ── THE ONE WRITE ────────────────────────────────────────────────────────────────────────────────── */

/**
 * Store the user's own edit of a document. ⚠️ Never an AI call, never a charge: it replaces the payload
 * the user is looking at. 'too_big' is refused on the server rather than truncated (a cut resume JSON is
 * a broken resume); a 400 (a payload the server will not accept) comes back as 'network' with the
 * server's message, because the edit was NOT saved and the user must not be told it was.
 */
export async function saveDocPayload(docId: number, payload: any):
  Promise<{ ok: true; updatedAt: string } | { ok: false; reason: 'gone' | 'too_big' | 'network'; message?: string }> {
  const id = docIdOf(docId);
  if (!id) return { ok: false, reason: 'gone' };
  const r = await call(`/employer-docs/${id}`, { method: 'PUT', body: { payload }, ms: 30000 });
  if (!r) return { ok: false, reason: 'network' };
  if (saysGone(r)) return { ok: false, reason: 'gone' };
  if (r.status === 413) return { ok: false, reason: 'too_big' };
  if (!r.ok || r.json.success === false) {
    return { ok: false, reason: 'network', message: r.json.error ? String(r.json.error) : undefined };
  }
  const updatedAt = str(r.json.updatedAt) || new Date().toISOString();
  // ⚠️ The remembered meta must move with the edit. Card images are cached per docId|updatedAt, so a chip
  // switch back to this employer would otherwise paint the pages from BEFORE the edit.
  for (const [k, e] of Array.from(docCache.entries())) {
    if (e.meta && e.meta.docId === id) docCache.set(k, { ...e, meta: { ...e.meta, updatedAt, editedAt: updatedAt } });
  }
  return { ok: true, updatedAt };
}
