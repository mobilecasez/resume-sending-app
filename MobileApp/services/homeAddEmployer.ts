// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Adding an employer from Home, and building its resume — or its cover letter — right there.
//
// The user's words: adding an employer must NOT walk them off to the Jobs page — the card lands at
// the start of the row and the document starts building behind a loader. Three calls make that:
//   trackEmployer    → save the employer. FREE, and it never starts a job search.
//   checkBuildGate   → would a build be covered, by what, and how much is left? A DRY RUN on the
//                      server; nothing is consumed, reserved or bound.
//   buildForEmployer → the async generate lane, polled, with real stage ticks for the overlay.
//
// Both kinds land in the per-employer DOC store (user_employer_documents), never in user_resumes:
// the resume lane is always sent saveTo:'employer_doc', and the letter lane has its own endpoint. A
// finished build answers with the stored doc's id, which is how Home finds that employer's own
// version when the user switches chips.
//
// ⚠️ THE STANDING RULE THIS FILE EXISTS TO KEEP: never regenerate and charge silently. An explicit
// Add, Tailor, Write or Refresh is intent to build, but it is not yet consent to SPEND (the product
// owner, 2026-09-14): the caller may start a build on its own ONLY on a cached build, which is free.
// Covered by the plan, the free allowance or a download pass is SHOWN first — Home's confirm sheet
// reads `usage` and `pass` off the gate ("2 of 3 free resume generations left") — and nothing starts
// until the user taps Continue there. Anything else — legacy credits, exhausted quota, or a gate we
// could not read at all — is "ask first". That is why a failed gate is `reason:'unknown'` and never
// something that looks like covered. And a confirmed build is sent with coveredOnly, so even a gate
// that went stale between the check and the build cannot fall through to credits on the server.
//
// ⚠️ coveredOnly ALONE NEVER SAID *WHO* PAYS (contract C2). "Plan, free allowance, pass or cache" was one
// permission, so a Continue the user gave to "1 of 3 free left" also let the server spend a one-time pass
// they had bought for another employer. Every confirmed build now also sends `expectVia` — the payer named
// on the sheet they answered — and the server refuses with 409 (payer_changed, or cache_miss for a promised
// cache that is not there) BEFORE binding or charging anything. Both come back as their own BuildResult
// reasons: nothing was spent, so the caller asks again with what is true now instead of showing a failure.
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../config';
import { gradFor, cleanJobUrl, deviceHeaders } from './employerHomeService';

export type DocKind = 'resume' | 'cover_letter';

export type TrackedEmployer = {
  employerId: string; name: string; website: string; domain: string;
  logoColor: [string, string]; logoInitial: string;
};

/**
 * The allowance a build would use, as the gate counted it (contract 3) — what Home's confirm sheet says:
 * "You have 2 of 3 free resume generations left", "12 of 15 left this month on Plus". `remaining` is
 * BEFORE this build. `pool` names the allowance the count is about — 'free' is one time for the life of
 * the account (`oneTime`), 'plan' is this billing month's — and is null when the server named none.
 * ⚠️ DISPLAY ONLY. Nothing here decides whether a build is covered or what pays: `covered` and `via` do,
 * and the server asks again at the moment of payment under coveredOnly.
 */
export type GateUsage = {
  kind: DocKind;
  pool: 'free' | 'plan' | null;
  planLabel: string | null;
  remaining: number;
  allowance: number;
  used: number;
  oneTime: boolean;
};

/**
 * The one-time download pass as the gate saw it — read-only on the server; a dry run never binds one.
 * `available` = a pass that could pay for this build; `forThisEmployer` = one already belongs to this
 * employer. ⚠️ DISPLAY ONLY, like GateUsage: via 'pass' is what says a pass pays.
 */
export type GatePass = { available: boolean; forThisEmployer: boolean };

/**
 * `usage` and `pass` ride on any answer the server sent them with, and are ABSENT — never guessed — when
 * it did not: an older server, a cache hit (which needs no sheet), or a gate we could not read at all.
 */
export type BuildGate =
  | { covered: true; via: 'plan' | 'free' | 'pass' | 'cache'; usage?: GateUsage; pass?: GatePass }
  | { covered: false; via: 'credits'; credits: number; usage?: GateUsage; pass?: GatePass }
  | { covered: false; via: null; reason: 'quota_exhausted' | 'regen_limit'; usage?: GateUsage; pass?: GatePass }
  | { covered: false; via: null; reason: 'unknown'; usage?: GateUsage; pass?: GatePass };

/**
 * The payer the user confirmed on the sheet, sent with the build (contract C2). ⚠️ IT IS A LIMIT, NOT A
 * CHOICE: the server still decides what pays, and refuses (409) when that is not this — it can never make
 * the server spend something it would not have. 'cache' means "the gate promised this document is already
 * built, and free"; a miss is refused rather than quietly turned into a paid build.
 */
export type ExpectVia = 'plan' | 'free' | 'pass' | 'cache';

/** Only the four real payers; anything else is "no expectation" (the older, coveredOnly-only behaviour). */
const expectViaOf = (v: any): ExpectVia | undefined =>
  (v === 'plan' || v === 'free' || v === 'pass' || v === 'cache' ? v : undefined);

/** The posting fields the gate fingerprints — the same ones generate-ai receives. */
export type GateJob = { title?: string; url?: string; description?: string; website?: string };

export type BuildTarget = {
  company: string; website: string; jobUrl?: string; jobText?: string; jobTitle?: string;
  /**
   * A posting link that is CONTEXT, not identity — e.g. the link pasted in the Add sheet for an
   * employer-level chip. ⚠️ TWO URLS, TWO JOBS: jobUrl is the doc's IDENTITY (sent as docJobUrl; '' = the
   * employer's own doc) and is what the build key, the remembered record and Home's chip key on;
   * postingUrl only takes jobUrl's place as job.url — the text the server scrapes and fingerprints — so
   * the gate (gateJobFor) and the build spell it the same. A posting chip passes the same link as both.
   */
  postingUrl?: string;
  employerId?: string | null; country?: string | null;
};

export type BuildStage = { stage: string; label: string; pct: number };

/**
 * 'pending' = our polling deadline passed while the job may still finish (and charge). It is NOT a
 * failure and must never be offered as a rebuild — the document it paid for can still land.
 * 'payer_changed' / 'cache_miss' = the server refused this build's `expectVia` BEFORE binding or charging
 * anything (contract C2): what would really pay is not what the user confirmed, or the cache the gate
 * promised is not there. ⚠️ NEITHER IS A FAILURE AND NEITHER MAY BE RESENT AS IT WAS — nothing was spent,
 * reserved or stored, and the honest answer is to read the gate again and ask about what is true now.
 * `docId` = the user_employer_documents row the build produced (or found, on a cache hit); null only
 * from a legacy lane that answered with resumeData and no doc.
 */
export type BuildResult = { ok: true; cached: boolean; docId: number | null }
  | {
    ok: false;
    reason: 'quota_exhausted' | 'regen_limit' | 'no_resume' | 'network' | 'failed' | 'pending' | 'payer_changed' | 'cache_miss';
    message: string;
  };

/** What a running (or remembered) build is for — enough for Home to find its chip, nothing more. */
export type InflightMeta = { key: string; kind: DocKind; company: string; employerId: string | null; jobUrl: string; startedAt: number };

/**
 * How many different builds may run at once from this phone. ⚠️ Not a money guard on its own — the
 * server is: every covered build is re-asked at the moment of payment under coveredOnly (canConsumeMany
 * never reserves, so two racing builds can both pass the gate; the loser is refused 402, never moved
 * onto credits). This cap only keeps a burst of Adds from queueing a pile of paid AI calls.
 */
export const MAX_PARALLEL_BUILDS = 3;

const POLL_MS = 1500;
/** How long one watch of a running job lasts before it is reported as 'pending'. */
const DEADLINE_MS = 6 * 60 * 1000;
/** How long a remembered build is honoured at all — the server's clientBuildId dedupe window. */
const KEEP_MS = 15 * 60 * 1000;
/** Someone who comes back to a build past its deadline still gets this long to watch it land. */
const GRACE_MS = 60 * 1000;
// ⚠️ Holds server job ids. Ids from one database mean nothing in another; after an environment
// switch the poll gets a 404 and the entry is dropped as 'gone', so a stale one cannot wedge a build.
const INFLIGHT_KEY = 'home_build_inflight_v2';
/** The single-slot record from before kinds and parallel builds — read ONCE, migrated, removed. */
const INFLIGHT_KEY_V1 = 'home_build_inflight_v1';
/** A bound on the remembered list. With MAX_PARALLEL_BUILDS running this is never reached in practice. */
const MAX_RECORDS = 12;

const nounOf = (kind: DocKind) => (kind === 'cover_letter' ? 'cover letter' : 'resume');
const verbOf = (kind: DocKind) => (kind === 'cover_letter' ? 'writing' : 'building');

/**
 * Who is signed in, as a stable string: the user id, or a token hash for a session without one.
 * ⚠️ THE ONE DEFINITION. EmployerHome keys its module cache with it and the in-flight records below are
 * keyed with it, so the two can never disagree about whose build or whose employers these are.
 * ⚠️ WHY IT EXISTS: App.js's logout resets React state but never reloads the JS bundle, so module state
 * and AsyncStorage both outlive a sign-out. Without an owner, the next account to sign in on the phone
 * inherited the previous account's in-flight build and its company name in the overlay.
 */
export async function signedInAccount(): Promise<string | null> {
  return (await readSession()).account;
}

/**
 * The account AND its token, read from ONE parse of the session — so a flight that captures both can
 * never pair one account's id with another account's token.
 */
type Session = { account: string | null; tok: string | undefined };

/**
 * The account the last successful session read saw. ⚠️ Only for the SYNCHRONOUS cap count
 * (activeBuildCount) — buildForEmployer must claim its flight before its first await, so it cannot ask
 * SecureStore. Anything that decides who a build belongs to awaits readSession instead. undefined = not
 * read yet (or only ever unreadable), which counts every flight — the conservative side of a cap.
 */
let lastAccount: string | null | undefined;

async function readSession(): Promise<Session> {
  try {
    const u = JSON.parse((await SecureStore.getItemAsync('userSession')) || '{}');
    const tok = u && u.token ? String(u.token) : undefined;
    let account: string | null = null;
    if (u && u.id != null && String(u.id)) account = 'u:' + String(u.id);
    else if (tok) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      account = 't:' + h.toString(36);
    }
    lastAccount = account;
    return { account, tok };
  } catch { /* an unreadable session is nobody — but not proof the account changed, so lastAccount stays */ }
  return { account: null, tok: undefined };
}

async function token(): Promise<string | undefined> {
  return (await readSession()).tok;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * x-store-env for every request here — the gate, both build lanes and the polls (contract C3).
 *
 * ⚠️ WITHOUT IT A TESTFLIGHT PASS CAN NEVER START THE BUILD IT WAS BOUGHT FOR. TestFlight StoreKit is
 * always Sandbox, so a pass bought from Home's sheet is written in Sandbox — and a gate or a build that
 * names no environment is read as Production, where that pass does not exist. The user pays and the sheet
 * goes on saying nothing is left.
 * ⚠️ Read lazily and guarded, the way the device header is read elsewhere: a header must never be the
 * reason a request does not go out, and a build that could not ask is Production — the server's own
 * default. (storeEnv also patches global fetch, but that reads a value which may still be loading;
 * storeEnvHeader awaits it, so the first request after a cold start carries the right environment too.)
 * Like the device, it is the PHONE's and not the session's, so it is never part of a flight's ctx.
 */
async function storeEnvHeaders(): Promise<Record<string, string>> {
  try { return await (require('./storeEnv') as typeof import('./storeEnv')).storeEnvHeader(); }
  catch { return {}; }
}

/**
 * One request. `null` means we never got an answer (no token, dropped connection, timeout) — which
 * callers must keep distinct from any answer the server actually gave.
 * ⚠️ API_BASE is read HERE, per call: it is a live binding the admin environment switch reassigns.
 * `ctx` = a build's captured session: every request of one flight goes out under the token it started
 * with, never under whoever happens to be signed in by the time a later step runs (see Flight.ctx).
 */
async function call(path: string, init: { method?: 'GET' | 'POST'; body?: any; ms?: number } = {}, ctx?: Session):
  Promise<{ status: number; ok: boolean; json: any } | null> {
  const t = ctx ? ctx.tok : await token();
  if (!t) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.ms || 20000);
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method: init.method || 'GET',
      // x-device-id rides with EVERY call here, the gate and both build lanes included: without it a
      // just-created account had no device for the server's one-free-allowance-per-device check (see
      // deviceHeaders). The device is not part of ctx — it is the phone's, not the session's.
      headers: init.body !== undefined
        ? { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(await deviceHeaders()), ...(await storeEnvHeaders()) }
        : { Authorization: `Bearer ${t}`, ...(await deviceHeaders()), ...(await storeEnvHeaders()) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctl.signal,
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, json: json || {} };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/* ── ADD ────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ THE NAME THE USER PICKED WINS for this user: the server answers employer.name with their display
 * name (the shared employers row can carry whatever a job ingest named that domain — "Souq.com for
 * E-Commerce LLC" for amazon.jobs), so the chip, the gate and the build all use `name` from here.
 */
export async function trackEmployer(i: { name: string; website: string }):
  Promise<{ ok: true; employer: TrackedEmployer } | { ok: false; reason: 'auth' | 'limit' | 'invalid' | 'network'; message: string }> {
  if (!(await token())) return { ok: false, reason: 'auth', message: 'Please sign in again.' };
  const r = await call('/ai-hub/employers/track', {
    method: 'POST', body: { name: i.name, website: i.website }, ms: 30000,
  });
  if (!r) return { ok: false, reason: 'network', message: 'We could not reach the server. Please try again.' };
  const err = r.json.error ? String(r.json.error) : '';
  if (r.status === 401) return { ok: false, reason: 'auth', message: err || 'Please sign in again.' };
  if (r.status === 429) return { ok: false, reason: 'limit', message: err || 'You are tracking as many employers as your plan allows.' };
  // Every 400 is 'invalid' whatever its reason string ('invalid_website' is a job board or ATS host
  // the name does not own; 'invalid_name'), so a new server reason can never read as a dropped call.
  if (r.status === 400) {
    return {
      ok: false, reason: 'invalid',
      message: err || (r.json.reason === 'invalid_name' ? "Please enter the employer's name." : 'That website does not look right.'),
    };
  }
  const e = r.json.employer;
  if (!r.ok || !e || e.id == null) {
    return { ok: false, reason: 'network', message: err || 'We could not add that employer. Please try again.' };
  }
  const name = String(e.name || i.name || '').trim() || 'Employer';
  const domain = String(e.domain || '').trim();
  return {
    ok: true,
    employer: {
      employerId: String(e.id),
      name,
      domain,
      // Built from the server's normalised domain, not echoed from what was typed — this is the
      // same spelling fetchTargets derives, so the new chip and the build agree on the website.
      website: domain ? `https://${domain}` : String(i.website || ''),
      logoColor: Array.isArray(e.logoColor) && e.logoColor.length >= 2 ? [String(e.logoColor[0]), String(e.logoColor[1])] : gradFor(name),
      logoInitial: String(e.logoInitial || name.charAt(0)).toUpperCase(),
    },
  };
}

/* ── WOULD IT BE COVERED? ───────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ ONE SPELLING FOR BOTH CALLS. The gate answers 'cache' by fingerprinting these fields exactly as
 * the build will; if the two requests spelled them differently, a hit the gate promised would miss
 * on the build. Both go through here, and empty fields are dropped rather than sent as ''.
 */
function jobFields(j: GateJob): GateJob {
  const out: GateJob = {};
  if (j.title) out.title = String(j.title);
  if (j.url) out.url = String(j.url);
  if (j.description) out.description = String(j.description);
  if (j.website) out.website = String(j.website);
  return out;
}

/**
 * employerId and country, spelled ONCE for the gate and the build — same rule as jobFields: trimmed,
 * and omitted when empty. ⚠️ country is part of the LETTER fingerprint (the format is regional), so a
 * gate that sent '' while the build sent null would promise a cache hit the build then misses.
 */
function extraFields(x: { employerId?: string | null; country?: string | null }): { employerId?: string; country?: string } {
  const out: { employerId?: string; country?: string } = {};
  const id = typeof x.employerId === 'string' ? x.employerId.trim() : '';
  if (id) out.employerId = id;
  const c = typeof x.country === 'string' ? x.country.trim() : '';
  if (c) out.country = c;
  return out;
}

/**
 * The gate's `job` for a build target — pass this to checkBuildGate so it fingerprints the real build.
 * ⚠️ url = postingUrl || jobUrl: the posting text the server scrapes, which on an employer-level chip can
 * be a pasted link while the doc's identity stays ''. The build body goes through here too (job.url), so
 * the gate and the build can never disagree about which posting was fingerprinted.
 */
export const gateJobFor = (i: { website?: string; jobUrl?: string; postingUrl?: string; jobText?: string; jobTitle?: string }): GateJob =>
  jobFields({ title: i.jobTitle, url: i.postingUrl || i.jobUrl, description: i.jobText, website: i.website });

/** A whole, non-negative count exactly as the server sent it — or null. Never coerced from a string. */
const countOf = (v: any): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * The gate's `usage`, or undefined. ⚠️ All three counts must be real counts and the kind must be THIS
 * build's (a count of cover letters is not a count of resume generations); anything else is dropped
 * whole rather than half-shown.
 */
function usageOf(v: any, kind: DocKind): GateUsage | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const remaining = countOf(v.remaining);
  const allowance = countOf(v.allowance);
  const used = countOf(v.used);
  if (remaining === null || allowance === null || used === null) return undefined;
  if (v.kind != null && v.kind !== kind) return undefined;
  const label = typeof v.planLabel === 'string' ? v.planLabel.trim() : '';
  return {
    kind,
    pool: v.pool === 'free' || v.pool === 'plan' ? v.pool : null,
    planLabel: label ? label.slice(0, 40) : null,
    remaining, allowance, used,
    oneTime: v.oneTime === true,
  };
}

/** The gate's `pass`, or undefined: both flags must be real booleans. */
function passOf(v: any): GatePass | undefined {
  if (!v || typeof v !== 'object' || typeof v.available !== 'boolean' || typeof v.forThisEmployer !== 'boolean') return undefined;
  return { available: v.available, forThisEmployer: v.forThisEmployer };
}

/** Only the extras that parsed — an absent key, never `usage: undefined`. */
function gateExtras(j: any, kind: DocKind): { usage?: GateUsage; pass?: GatePass } {
  const out: { usage?: GateUsage; pass?: GatePass } = {};
  const usage = usageOf(j && j.usage, kind);
  if (usage) out.usage = usage;
  const pass = passOf(j && j.pass);
  if (pass) out.pass = pass;
  return out;
}

/**
 * ⚠️ Mapped STRICTLY. Anything that is not exactly one of the contract's shapes — a 500, a timeout,
 * `covered:true` with via 'credits', credits missing — is `unknown`, which the caller treats as
 * "ask first". A loose mapping here is precisely how a silent charge would get back in.
 * `usage` / `pass` are mapped just as strictly but ON THEIR OWN: a malformed one is dropped (the sheet
 * then says less), never repaired into numbers the server did not send, and never able to change the
 * answer they ride on.
 * The resume gate is asked about the DOC lane (saveTo:'employer_doc') — the lane buildForEmployer
 * really uses, whose fingerprint differs from the builder's; the letter gate has its own endpoint.
 */
export async function checkBuildGate(
  employer: string, job?: GateJob, kind: DocKind = 'resume',
  extra?: { employerId?: string | null; country?: string | null },
): Promise<BuildGate> {
  const unread: BuildGate = { covered: false, via: null, reason: 'unknown' };
  const ex = extraFields(extra || {});
  const r = kind === 'cover_letter'
    ? await call('/cover-letter/employer-gate', {
      method: 'POST', body: { employer: String(employer || ''), ...ex, job: jobFields(job || {}) },
    })
    : await call('/resume-builder/generation-gate', {
      method: 'POST',
      body: {
        employer: String(employer || ''), job: jobFields(job || {}), saveTo: 'employer_doc',
        ...(ex.employerId ? { employerId: ex.employerId } : {}),
      },
    });
  if (!r || !r.ok) return unread;
  const j = r.json;
  const extras = gateExtras(j, kind);
  if (j.covered === true && (j.via === 'plan' || j.via === 'free' || j.via === 'pass' || j.via === 'cache')) {
    return { covered: true, via: j.via, ...extras };
  }
  if (j.covered === false && j.via === 'credits' && typeof j.credits === 'number' && isFinite(j.credits) && j.credits >= 0) {
    return { covered: false, via: 'credits', credits: j.credits, ...extras };
  }
  if (j.covered === false && j.via == null && (j.reason === 'quota_exhausted' || j.reason === 'regen_limit')) {
    return { covered: false, via: null, reason: j.reason, ...extras };
  }
  return unread;
}

/* ── BUILD ──────────────────────────────────────────────────────────────────────────────────────── *
 *
 * ⚠️ THE ASYNC LANE CHARGES SOMEONE WHO WALKS AWAY. Once the request lands the work outlives it:
 * leaving Home, minimising, even killing the app does not stop it, and the allowance is spent. So
 * nothing here offers a cancel, and no message may say a build was cancelled. What we do instead is
 * REMEMBER every build (AsyncStorage) so a remounted Home can pick the same builds back up and show
 * the documents they paid for — see resumeInflightBuilds.
 *
 * ⚠️ A LOST ANSWER IS NOT A BUILD THAT NEVER HAPPENED. A dropped connection on the POST can come after
 * the server created (and started charging for) the job. So every build carries a clientBuildId,
 * written to storage BEFORE the POST; the server returns the SAME job for the same id, which makes a
 * retry of the same build safe. A new id is minted only for a genuinely new build — never for a retry.
 * ⚠️ BUT A RESEND IS STILL A POSSIBLE CHARGE: when the first POST never landed, the same id STARTS the
 * build. So a lost POST is resent only by an explicit action on that build (a tap on it, or its own Try
 * again via resendKey) — never by a mount or a sweep — and removing its chip forgets it (forgetInflight).
 *
 * ⚠️ ONE FLIGHT PER TARGET. Builds are keyed on kind + company + posting (buildKeyOf): the exact same
 * target joins the running promise; a different one — including a different role at the same company,
 * or the letter for an employer whose resume is building — is a separate build, because joining would
 * report a document that was never built. Different targets run side by side up to MAX_PARALLEL_BUILDS.
 * canConsumeMany checks quota without reserving it, so two covered builds started together can both
 * pass the gate: that is safe only because each is sent coveredOnly and the server re-asks at the
 * moment of payment, refusing (402) the one that lost rather than falling through to credits.
 */
type Inflight = {
  key: string;
  kind: DocKind;
  clientBuildId: string;
  company: string;
  employerId: string | null;
  jobKey: string;
  jobUrl: string;
  startedAt: number;
  /** null while the POST's answer has not been seen — the job may or may not exist on the server. */
  jobId: string | null;
  /** Enough to send the SAME build again. ⚠️ No resume text or contact details: those are refetched. */
  target: BuildTarget;
  coveredOnly: boolean;
  /**
   * The payer the user confirmed for THIS build (contract C2). ⚠️ Kept with the record because a resend of a
   * lost POST must go out under the consent given then and nothing wider — absent on records written before
   * expectVia existed, which resend as they always did (coveredOnly alone).
   */
  expectVia?: ExpectVia;
};
/** `gone` = nothing to show the recovering screen; `joiner` is what a same-target tap is told instead. */
type Outcome = BuildResult | { gone: true; joiner?: BuildResult };
type Flight = {
  key: string; kind: DocKind; company: string; employerId: string | null; jobUrl: string; jobKey: string;
  startedAt: number;
  promise: Promise<Outcome>;
  listeners: Set<(s: BuildStage) => void>;
  /** The newest stage, replayed to anyone who joins — 'writing' spans the whole AI call, so a joiner
   *  waiting for the NEXT change would stare at an empty overlay for most of the build. */
  last: BuildStage | null;
  /**
   * ⚠️ WHOSE BUILD, FIXED AT START: the account and its token, read once when the flight is claimed.
   * App.js's logout never reloads the bundle, so a flight can outlive its account. Every request of the
   * flight uses THIS token, and before each send, poll and record write it re-reads the session and
   * stops (result 'failed', its record left as the original account wrote it) the moment someone else
   * is signed in — otherwise account A's resume text went out under B's session and the record was
   * re-stamped as B's.
   */
  ctx: Promise<Session>;
  /** Whose build this is. Module state outlives a sign-out, so recovery only ever joins its own. */
  account: Promise<string | null>;
  /** ctx's account once it has resolved (undefined before) — for the synchronous cap count. */
  owner?: string | null;
};

const flights = new Map<string, Flight>();

const NETWORK: BuildResult = { ok: false, reason: 'network', message: 'We could not reach the server. Please try again.' };
const UNREADABLE: BuildResult = { ok: false, reason: 'failed', message: "We couldn't read your resume just now. Please try again." };
const TOO_MANY: BuildResult = { ok: false, reason: 'failed', message: 'Three builds are already running — start this one when one finishes.' };
const RECOVERING: BuildStage = { stage: 'recovering', label: 'Picking up where it left off', pct: 5 };
/** A flight that stopped because another account signed in. ⚠️ Never "cancelled": a POST it already sent may still land. */
const SWITCHED = (kind: DocKind): BuildResult => ({
  ok: false, reason: 'failed',
  message: `You switched accounts, so this ${nounOf(kind)} stays with the account that started it.`,
});

/** Is the account a flight started under still the one signed in? Read fresh — never from lastAccount. */
async function stillSignedIn(ctx: Session): Promise<boolean> {
  return (await readSession()).account === ctx.account;
}

const companyKey = (s?: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const asResult = (o: Outcome): BuildResult =>
  'gone' in o ? (o.joiner || { ok: false, reason: 'failed', message: 'We lost track of that build. Please try again.' }) : o;

function newBuildId(): string {
  try {
    const c: any = (globalThis as any).crypto;
    if (c && typeof c.randomUUID === 'function') return String(c.randomUUID());
  } catch { /* Hermes has no crypto by default */ }
  const r = () => Math.floor(Math.random() * 0x100000000).toString(36);
  return `hb-${Date.now().toString(36)}-${r()}${r()}${r()}`;
}

const shortHash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

/** Which posting a build is for: its URL, else its pasted text, else its title, else '' (the employer). */
function jobKeyOf(i: { jobUrl?: string; jobText?: string; jobTitle?: string }): string {
  const url = String(i.jobUrl || '').trim();
  if (url) return 'u:' + (cleanJobUrl(url) || url).toLowerCase();
  const text = String(i.jobText || '').trim();
  if (text) return `t:${shortHash(text)}:${text.length}`;
  const title = String(i.jobTitle || '').trim().toLowerCase();
  return title ? 'n:' + title : '';
}

/**
 * The identity of one build: kind + company (trimmed, lowercased, spaces collapsed) + posting. Flights,
 * persisted records and Home's queue all key on this, so "the same build" means one thing everywhere.
 */
export function buildKeyOf(kind: DocKind, t: { company: string; jobUrl?: string; jobText?: string; jobTitle?: string }): string {
  return kind + '|' + companyKey(t.company) + '|' + jobKeyOf(t);
}

const docIdOf = (v: any): number | null => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,15}$/.test(v.trim()) ? Number(v.trim()) : NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/* ── REMEMBERED BUILDS ──────────────────────────────────────────────────────────────────────────── *
 *
 * One AsyncStorage array holds every remembered build. ⚠️ READ-MODIFY-WRITE, SERIALISED: builds now
 * finish side by side, and two unserialised "read the list, drop mine, write it back" passes would
 * each write a list still holding what the other just removed — or lose a record the other just
 * added, which is the one record that stops a retry from minting a second paid build.
 */
let storeChain: Promise<unknown> = Promise.resolve();
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const run = storeChain.then(fn, fn);
  storeChain = run.catch(() => undefined);
  return run;
}

const kindOf = (v: any): DocKind | null => (v === 'resume' || v === 'cover_letter' ? v : null);
const str = (v: any) => (typeof v === 'string' && v ? v : null);

function parseRecord(j: any): Inflight | null {
  if (!j || typeof j !== 'object') return null;
  const kind = kindOf(j.kind);
  if (!kind || typeof j.clientBuildId !== 'string' || !j.clientBuildId || typeof j.company !== 'string' || !j.company
    || typeof j.startedAt !== 'number' || !isFinite(j.startedAt)
    || !(j.jobId === null || (typeof j.jobId === 'string' && j.jobId))) return null;
  const t = j.target && typeof j.target === 'object' ? j.target : {};
  const target: BuildTarget = {
    company: j.company, website: String(t.website || ''),
    jobUrl: t.jobUrl || undefined, jobText: t.jobText || undefined, jobTitle: t.jobTitle || undefined,
    // Absent on records from before postingUrl existed: those builds sent jobUrl as job.url, and still do.
    postingUrl: str(t.postingUrl) || undefined,
    employerId: str(t.employerId) || str(j.employerId),
    country: str(t.country),
  };
  const jobKey = typeof j.jobKey === 'string' ? j.jobKey : jobKeyOf(target);
  const expectVia = expectViaOf(j.expectVia);
  return {
    key: str(j.key) || kind + '|' + companyKey(j.company) + '|' + jobKey,
    kind, clientBuildId: j.clientBuildId, company: j.company,
    employerId: target.employerId || null, jobKey,
    jobUrl: String(t.jobUrl || j.jobUrl || ''),
    startedAt: j.startedAt, jobId: j.jobId, target,
    // ⚠️ Anything but an explicit false is "covered only": a mangled entry must never widen consent.
    coveredOnly: j.coveredOnly !== false,
    // A mangled payer is dropped, never guessed: no expectation is the narrower, older behaviour.
    ...(expectVia ? { expectVia } : {}),
  };
}

async function saveAll(list: Inflight[], account: string | null): Promise<void> {
  if (!account || !list.length) { await AsyncStorage.removeItem(INFLIGHT_KEY); return; }
  await AsyncStorage.setItem(INFLIGHT_KEY, JSON.stringify(list.slice(-MAX_RECORDS).map((v) => ({ ...v, account }))));
}

/**
 * UNSERIALISED — call only inside serialised(). Returns this account's live records, oldest first.
 * `expect` = the account a flight started under. When someone else is signed in now, this returns
 * `foreign` and reads nothing further and WRITES NOTHING: a flight of account A must neither re-stamp
 * its record as B's nor, by this read, prune A's records. (B's own reads still drop them, by the rule below.)
 */
async function loadAll(expect?: string | null): Promise<{ me: string | null; list: Inflight[]; foreign: boolean }> {
  const me = await signedInAccount();
  if (expect !== undefined && (expect === null || me !== expect)) return { me, list: [], foreign: me !== expect };
  let raw: any[] = [];
  let dirty = false;
  let dropV1 = false;
  let text: string | null = null;
  try { text = await AsyncStorage.getItem(INFLIGHT_KEY); } catch { return { me, list: [], foreign: false }; }   // unreadable ≠ empty: never overwrite it
  if (text) {
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j)) raw = j; else dirty = true;
    } catch { dirty = true; }
  }
  // The single-slot record an older build of the app left behind is carried over (as a resume) once.
  try {
    const v1 = await AsyncStorage.getItem(INFLIGHT_KEY_V1);
    if (v1) {
      dropV1 = true;
      dirty = true;
      try {
        const j1 = JSON.parse(v1);
        if (j1 && typeof j1 === 'object' && !Array.isArray(j1)) raw = [{ ...j1, kind: 'resume' }, ...raw];
      } catch { /* a mangled v1 entry is simply dropped */ }
    }
  } catch { /* looked at again next time */ }

  const now = Date.now();
  const keep: Inflight[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  // Newest first, so a duplicate key keeps the record written last.
  for (let n = raw.length - 1; n >= 0; n--) {
    const j = raw[n];
    // ⚠️ Another account's build is not ours to resume or to report on. Dropped, not just ignored, so it
    // cannot surface again for the account that DID start it on some later sign-in either — its job
    // still completes and lands on the server, and Home shows it from there.
    if (!me || !j || j.account !== me) { dirty = true; continue; }
    const r = parseRecord(j);
    // Past the server's dedupe window a resend would be a NEW build (and charge), so it is never honoured.
    if (!r || now - r.startedAt >= KEEP_MS || ids.has(r.clientBuildId) || keys.has(r.key)) { dirty = true; continue; }
    ids.add(r.clientBuildId);
    keys.add(r.key);
    keep.push(r);
  }
  keep.reverse();
  if (dirty) {
    try {
      await saveAll(keep, me);
      // ⚠️ v1 goes only once v2 holds its record — removed first, a failed write would lose a paid build.
      if (dropV1) await AsyncStorage.removeItem(INFLIGHT_KEY_V1);
    } catch { /* recovery is a nicety */ }
  }
  return { me, list: keep, foreign: false };
}

/** The signed-in account's records — or, given a flight's account, null when someone else is signed in now. */
async function readInflight(expect?: string | null): Promise<Inflight[] | null> {
  return serialised(async () => {
    try {
      const got = await loadAll(expect);
      return got.foreign ? null : got.list;
    } catch { return []; }
  });
}
/**
 * One record per build key: writing replaces this build's earlier record, never another build's.
 * Resolves false ONLY when `owner` is no longer the signed-in account (nothing written) — the caller
 * stops there. A storage failure resolves true: recovery is a nicety, not a reason to abandon a build.
 */
async function writeInflight(v: Inflight, owner: string | null): Promise<boolean> {
  return serialised(async () => {
    try {
      const { me, list, foreign } = await loadAll(owner);
      if (foreign) return false;
      if (!me) return true;   // nobody signed in owns nothing, so there is nothing to recover
      const next = list.filter((r) => r.clientBuildId !== v.clientBuildId && r.key !== v.key);
      next.push(v);
      await saveAll(next, me);
    } catch { /* recovery is a nicety */ }
    return true;
  });
}
/**
 * Clears only OUR entry, so a finishing build can never erase the record of a different one. Same
 * false-means-switched answer as writeInflight: another account's session never touches this list.
 */
async function clearInflight(clientBuildId: string, owner: string | null): Promise<boolean> {
  return serialised(async () => {
    try {
      const { me, list, foreign } = await loadAll(owner);
      if (foreign) return false;
      const next = list.filter((r) => r.clientBuildId !== clientBuildId);
      if (next.length !== list.length) await saveAll(next, me);
    } catch { /* nothing to do */ }
    return true;
  });
}

/**
 * Forget every remembered build for one build key — the chip was removed, so nothing may ever resend it.
 * ⚠️ WHY: a record without a jobId is a POST whose answer was lost; resent, it can start (and charge) a
 * build the user was told had failed and then took away. Removing the chip is the user's "no".
 * ⚠️ It never touches the server: a job that exists runs on and its document lands on the server (Home
 * shows it if the employer comes back). A flight for this key still running in THIS process is left
 * alone too — if its POST answers, it writes a record WITH a jobId, which recovery only ever polls.
 * Only the signed-in account's list is rewritten (the pass drops any other account's records, as every
 * read by this account does); signed out, there is nothing of anyone's to forget.
 */
export async function forgetInflight(key: string): Promise<void> {
  const k = typeof key === 'string' ? key : '';
  if (!k) return;
  const me = await signedInAccount();
  if (!me) return;
  await serialised(async () => {
    try {
      const { list, foreign } = await loadAll(me);
      if (foreign) return;
      const next = list.filter((r) => r.key !== k);
      if (next.length !== list.length) await saveAll(next, me);
    } catch { /* nothing to do */ }
  });
}

/* ── FLIGHTS ────────────────────────────────────────────────────────────────────────────────────── */

function emitTo(f: Flight, s: BuildStage) {
  f.last = s;
  // ⚠️ A listener that throws (an unmounted screen's setState, say) must not end the poll for the
  // others — an exception here would abandon a build the user is still being charged for.
  f.listeners.forEach((l) => { try { l(s); } catch { /* ignore */ } });
}

/**
 * `session` = the account a recovery already resolved (its records are that account's). Without it the
 * session is read now — started synchronously, so the flight is still claimed before the caller's first await.
 */
function newFlight(
  m: { key: string; kind: DocKind; company: string; employerId: string | null; jobUrl: string; jobKey: string; startedAt: number },
  onStage?: (s: BuildStage) => void,
  session?: Session,
): Flight {
  const f: Flight = {
    ...m,
    listeners: new Set(onStage ? [onStage] : []),
    last: null,
    promise: null as unknown as Promise<Outcome>,
    ctx: session ? Promise.resolve(session) : readSession().catch((): Session => ({ account: null, tok: undefined })),
    account: null as unknown as Promise<string | null>,
    owner: session ? session.account : undefined,
  };
  f.account = f.ctx.then((s) => { f.owner = s.account; return s.account; });
  return f;
}

/**
 * Does this flight count as the signed-in account's, as far as a SYNCHRONOUS check can tell? An owner not
 * resolved yet, or no session read yet, counts as ours — a flight claimed a moment ago was this session's.
 */
const ownedNow = (f: Flight) => f.owner === undefined || lastAccount === undefined || f.owner === lastAccount;
/** The same question once the account is known for sure. */
const ownedBy = (f: Flight, account: string | null) => f.owner === undefined || f.owner === account;

/** Join a running build: listen from now on AND hear where it has already got to, synchronously. */
function joinFlight(f: Flight, onStage: (s: BuildStage) => void) {
  f.listeners.add(onStage);
  if (f.last) { try { onStage(f.last); } catch { /* ignore */ } }
}

const metaOf = (f: { key: string; kind: DocKind; company: string; employerId: string | null; jobUrl: string; startedAt: number }): InflightMeta =>
  ({ key: f.key, kind: f.kind, company: f.company, employerId: f.employerId, jobUrl: f.jobUrl, startedAt: f.startedAt });

/**
 * How many different builds the SIGNED-IN ACCOUNT is running on this phone right now (joined taps do not
 * count twice). ⚠️ Another account's flights do not count: after a switch, the previous account's builds
 * (which stop at their next send, poll or write) must not hold the new account's three slots.
 */
export function activeBuildCount(): number {
  let n = 0;
  flights.forEach((f) => { if (ownedNow(f)) n++; });
  return n;
}

// ⚠️ 'payer_changed' and 'cache_miss' are here too because the async lane answers through a FAILED JOB: the
// handler's 409 is stored as the job's reason, so a refusal that spent nothing must be readable from both
// the POST's own status and the job that carried it.
const FAIL_REASONS = ['quota_exhausted', 'regen_limit', 'no_resume', 'payer_changed', 'cache_miss'] as const;
const failReason = (r: any): 'quota_exhausted' | 'regen_limit' | 'no_resume' | 'payer_changed' | 'cache_miss' | 'failed' =>
  (FAIL_REASONS as readonly string[]).includes(r) ? r : 'failed';

/**
 * One status read: a terminal outcome, 'running', 'auth' (signed out — the job itself runs on), or
 * null when the server could not be asked.
 */
async function readJob(jobId: string, kind: DocKind, onStage: ((s: BuildStage) => void) | undefined, ctx: Session):
  Promise<Outcome | 'running' | 'auth' | null> {
  const r = await call(`/job-status/${encodeURIComponent(jobId)}`, { ms: 15000 }, ctx);
  if (!r) return null;                                   // one dropped poll is not a failure
  if (r.status === 404) return { gone: true };
  if (r.status === 401) return 'auth';
  if (!r.ok) return null;
  const j = r.json;
  // ⚠️ `data` carries TWO different things: the {stage,label,pct} envelope while running, and the
  // real payload once completeJob overwrites it. `docId` (the doc lanes) or `resumeData` (the legacy
  // lane) is what tells them apart.
  const d0 = j.data;
  const finished = !!(d0 && (d0.resumeData || docIdOf(d0.docId) !== null));
  if (d0 && d0.stage && !finished && onStage) {
    onStage({ stage: String(d0.stage), label: String(d0.label || ''), pct: Number(d0.pct) || 0 });
  }
  if (j.status === 'completed') {
    const d = j.data || {};
    const docId = docIdOf(d.docId);
    if (docId !== null || d.resumeData) return { ok: true, cached: !!d.cached, docId };
    return { ok: false, reason: 'failed', message: d.error || `The ${nounOf(kind)} finished but came back empty. Please try again.` };
  }
  if (j.status === 'failed') {
    return {
      ok: false,
      reason: failReason(j.reason ?? (j.data && j.data.reason)),
      message: j.error || `We could not finish ${verbOf(kind)} your ${nounOf(kind)}. Please try again.`,
    };
  }
  return 'running';
}

const untilFor = (startedAt: number) => Math.max(startedAt + DEADLINE_MS, Date.now() + GRACE_MS);

async function pollJob(
  clientBuildId: string, jobId: string, kind: DocKind, until: number, onStage: (s: BuildStage) => void, ctx: Session,
): Promise<Outcome> {
  let last = '';
  const tick = (s: BuildStage) => {
    const k = `${s.stage}|${s.pct}|${s.label}`;
    if (k !== last) { last = k; onStage(s); }
  };
  // ⚠️ Poll BEFORE checking the deadline. JS timers stop while the app is backgrounded, so a user
  // who comes back after ten minutes wakes this loop already past the deadline — without a final
  // read they would be told "taking longer than usual" about a document that finished long ago.
  for (;;) {
    await sleep(POLL_MS);
    // Another account signed in: stop asking with the old token. The job runs on for the account that
    // started it, and its record is left as that account wrote it.
    if (!(await stillSignedIn(ctx))) return SWITCHED(kind);
    const o = await readJob(jobId, kind, tick, ctx);
    // The job is still the user's and still spending: keep the entry so signing back in finds it.
    if (o === 'auth') return { ok: false, reason: 'failed', message: `Please sign in again to see your ${nounOf(kind)}.` };
    // A terminal answer is the truth whoever is signed in now; only the record clear is refused on a switch.
    if (o && o !== 'running') { await clearInflight(clientBuildId, ctx.account); return o; }
    if (Date.now() >= until) break;
  }
  // ⚠️ 'pending', and the entry is KEPT: the job may still finish and charge, so this must neither
  // offer a rebuild nor forget the build a later resumeInflightBuilds can still collect.
  return {
    ok: false, reason: 'pending',
    message: `This is taking longer than usual. Your ${nounOf(kind)} may still arrive — check Home in a minute.`,
  };
}

/**
 * The request body.
 * RESUME — from the user's base resume and profile.
 * ⚠️ THREE OUTCOMES, NEVER TWO: "no resume" must be something the server SAID — a short base text
 * AND a profile with no resume on it. A timeout is 'network', and a resume the server has but could
 * not read (a 5xx, or empty text beside an uploaded file) is 'failed': telling a user who HAS a
 * resume to go upload one is how they end up overwriting it.
 * COVER LETTER — no client-side resume text at all: the server writes from the base resume and that
 * employer's tailored resume doc, and says 'no_resume' itself when there is none.
 */
async function prepareBuild(
  i: BuildTarget, kind: DocKind, clientBuildId: string, coveredOnly: boolean, ctx: Session, expectVia?: ExpectVia,
): Promise<{ body: Record<string, any> } | { fail: BuildResult }> {
  const ex = extraFields(i);
  // ⚠️ docJobUrl is the doc's IDENTITY ('' = the employer's own doc); job.url (via gateJobFor) is the
  // posting text to scrape and fingerprint, which may be a pasted link on an employer-level doc. Sent
  // apart so a pasted link can shape the document without moving it to a posting slot Home never looks in.
  const docJobUrl = i.jobUrl || '';
  if (kind === 'cover_letter') {
    if (!ctx.tok) return { fail: { ok: false, reason: 'failed', message: 'Please sign in again.' } };
    return {
      body: {
        __async: true,
        clientBuildId,
        // ⚠️ true = the server must refuse (402) rather than fall through to legacy credits.
        coveredOnly,
        // ⚠️ WHO THE USER AGREED WOULD PAY (C2). Absent = no expectation, and the server behaves as before.
        ...(expectVia ? { expectVia } : {}),
        employer: i.company,
        ...ex,
        docJobUrl,
        // ⚠️ Same rule as the resume: website is never a posting url (see below).
        job: { company: i.company, ...gateJobFor(i) },
      },
    };
  }
  // Read with the flight's own token: the resume text and profile are ALWAYS the account that started it.
  const [src, prof] = await Promise.all([
    call('/resume-score/source-text?base=1', { ms: 20000 }, ctx),
    call('/users/profile', { ms: 20000 }, ctx),
  ]);
  if (!src || !prof) return { fail: NETWORK };
  if (src.status === 401 || prof.status === 401) return { fail: { ok: false, reason: 'failed', message: 'Please sign in again.' } };
  if (!src.ok) return { fail: UNREADABLE };
  if (!prof.ok) return { fail: { ok: false, reason: 'failed', message: "We couldn't read your profile just now. Please try again." } };
  const p = prof.json;
  const text = src.json.hasText && typeof src.json.text === 'string' ? src.json.text : '';
  if (text.trim().length < 30) {
    const hasResume = !!(p.resume || (p.setup && p.setup.resume));
    return {
      fail: hasResume ? UNREADABLE
        : { ok: false, reason: 'no_resume', message: 'Upload your current resume first — the AI rebuilds it from there.' },
    };
  }
  return {
    body: {
      __async: true,
      clientBuildId,
      // ⚠️ true = the server must refuse (402) rather than fall through to legacy credits.
      coveredOnly,
      // ⚠️ WHO THE USER AGREED WOULD PAY (C2). Absent = no expectation, and the server behaves as before.
      ...(expectVia ? { expectVia } : {}),
      // ⚠️ The DOC lane: the result is stored per employer and NEVER written over the user's resume row.
      // The gate is asked with the same saveTo, so its 'cache' answer fingerprints this exact build.
      saveTo: 'employer_doc',
      ...ex,
      rawText: text,
      name: p.fullName || '', email: p.email || '',
      phone: p.phone || '', location: p.address || '',
      includeUploadedResume: true,
      docJobUrl,
      // ⚠️ website is NEVER placed in url. job.url is a POSTING and the server scrapes it as posting
      // text; a homepage scraped in as "Posting text" tailors the resume to the careers-page chrome.
      job: { company: i.company, ...gateJobFor(i) },
    },
  };
}

type Sent = { jobId: string } | { result: BuildResult } | { lost: true; status: number };

/** One POST. `lost` = no answer we can trust (no response, or a 5xx a proxy may have sent after the job was made). */
async function sendBuild(kind: DocKind, body: Record<string, any>, ctx: Session): Promise<Sent> {
  const path = kind === 'cover_letter' ? '/cover-letter/employer-build' : '/resume-builder/generate-ai';
  const noun = nounOf(kind);
  const r = await call(path, { method: 'POST', ms: 90000, body }, ctx);
  if (!r || r.status >= 500) return { lost: true, status: r ? r.status : 0 };
  const s = r.json;
  if (r.status === 401) return { result: { ok: false, reason: 'failed', message: 'Please sign in again.' } };
  if (r.status === 402) return { result: { ok: false, reason: 'quota_exhausted', message: s.error || 'You have used your plan allowance.' } };
  if (r.status === 403) {
    return {
      result: {
        ok: false, reason: 'regen_limit',
        message: s.error || (kind === 'cover_letter' ? 'Your plan does not include another cover letter.' : 'Your free plan includes one rebuild.'),
      },
    };
  }
  // ⚠️ 409 = REFUSED BEFORE ANYTHING WAS BOUND, CHARGED OR STORED (contract C2): the payer the server would
  // really use is not the one the user confirmed (payer_changed), or the cache the gate promised is not there
  // (cache_miss). Reported as itself so the caller asks again — never as a failure whose Try again would
  // resend the same, now wrong, expectation.
  if (r.status === 409 && (s.reason === 'payer_changed' || s.reason === 'cache_miss')) {
    return {
      result: {
        ok: false, reason: s.reason,
        message: s.error || (s.reason === 'cache_miss'
          ? `Your saved ${noun} is not there any more, so nothing was started.`
          : `What pays for this ${noun} changed, so nothing was started.`),
      },
    };
  }
  if (!r.ok) return { result: { ok: false, reason: failReason(s.reason), message: s.error || `We could not start ${verbOf(kind)} your ${noun}.` } };
  // ⚠️ asJob runs SYNCHRONOUSLY when it cannot create a job row, and then this IS the finished
  // document rather than a job id. Handle both or that fallback looks like a failure.
  const docId = docIdOf(s.docId);
  if (docId !== null || s.resumeData) return { result: { ok: true, cached: !!s.cached, docId } };
  if (s.jobId) return { jobId: String(s.jobId) };
  return { result: { ok: false, reason: 'failed', message: `We could not start ${verbOf(kind)} your ${noun}.` } };
}

async function runBuild(i: BuildTarget, f: Flight, coveredOnly: boolean, expectVia?: ExpectVia): Promise<Outcome> {
  const emit = (s: BuildStage) => emitTo(f, s);
  const kind = f.kind;
  // ⚠️ Whose build this is, fixed ONCE (see Flight.ctx): every request below uses this token, and every
  // send, poll and record write first checks that this account is still the one signed in.
  const ctx = await f.ctx;
  let clientBuildId = newBuildId();
  let startedAt = Date.now();

  // A build remembered from before (a relaunch, or a POST whose answer was lost) may still be
  // spending the allowance. Join it if it is this target.
  const records = await readInflight(ctx.account);
  if (!records) return SWITCHED(kind);
  const prior = records.find((r) => r.key === f.key) || null;
  if (prior) {
    if (prior.jobId) {
      const now = await readJob(prior.jobId, prior.kind, undefined, ctx);
      if (now === 'running' || now === null || now === 'auth') {
        f.startedAt = prior.startedAt;
        return pollJob(prior.clientBuildId, prior.jobId, prior.kind, untilFor(prior.startedAt), emit, ctx);
      }
      // finished, or the server no longer knows it
      if (!(await clearInflight(prior.clientBuildId, ctx.account))) return SWITCHED(kind);
    } else {
      // ⚠️ THE RETRY OF A LOST ANSWER IS THE SAME BUILD: same id, so the server hands back the job the
      // first POST may already have made instead of creating (and charging for) a second one. This is
      // an EXPLICIT tap on this very target (it came through the gate), so resending here is allowed —
      // unlike recovery, which resends a lost POST only for its own Try again (resendKey).
      clientBuildId = prior.clientBuildId;
      startedAt = prior.startedAt;
      f.startedAt = startedAt;
    }
  }

  // Remembered builds for OTHER targets that nothing on this phone is watching (the app was killed
  // mid-build) still count toward the cap while the server may be running them. Finished ones are
  // forgotten here — their documents are on the server, and Home reads them from there.
  let others = 0;
  for (const r of records) {
    const watching = flights.get(r.key);
    if (r.key === f.key || (watching && ownedBy(watching, ctx.account))) continue;
    if (r.jobId) {
      const s = await readJob(r.jobId, r.kind, undefined, ctx);
      if (s === 'running' || s === null || s === 'auth') others++;
      else if (!(await clearInflight(r.clientBuildId, ctx.account))) return SWITCHED(kind);
    } else if (Date.now() - r.startedAt < DEADLINE_MS) {
      others++;                                       // a lost POST that may have started a build
    } else if (!(await clearInflight(r.clientBuildId, ctx.account))) {
      return SWITCHED(kind);
    }
  }
  // Only this account's flights hold slots — a previous account's (still winding down) never does.
  let mine = 0;
  flights.forEach((g) => { if (ownedBy(g, ctx.account)) mine++; });
  if (mine + others > MAX_PARALLEL_BUILDS) return TOO_MANY;

  emit({ stage: 'reading', label: 'Reading your resume', pct: 3 });
  const prep = await prepareBuild(i, kind, clientBuildId, coveredOnly, ctx, expectVia);
  if ('fail' in prep) return prep.fail;

  const entry: Inflight = {
    key: f.key, kind, clientBuildId, company: i.company, employerId: f.employerId, jobKey: f.jobKey,
    jobUrl: f.jobUrl, startedAt, jobId: null, target: i, coveredOnly,
    ...(expectVia ? { expectVia } : {}),
  };
  // ⚠️ Written BEFORE the POST: if the app dies mid-request, this is the only record that a paid
  // build may exist, and the only way a later attempt reuses its id. Refused on an account switch,
  // and then nothing is sent at all.
  if (!(await writeInflight(entry, ctx.account))) return SWITCHED(kind);
  if (!(await stillSignedIn(ctx))) return SWITCHED(kind);
  let sent = await sendBuild(kind, prep.body, ctx);
  if ('lost' in sent) {
    await sleep(POLL_MS);
    // The record stays as written, under the account that started it.
    if (!(await stillSignedIn(ctx))) return SWITCHED(kind);
    sent = await sendBuild(kind, prep.body, ctx);       // ⚠️ the SAME body, so the SAME clientBuildId
  }
  if ('lost' in sent) {
    // The entry stays: an explicit Try again for this build (resendKey) or a new tap on this target
    // resends with this id. ⚠️ Nothing else does — a mount or a sweep never resends a lost POST.
    return sent.status
      ? { ok: false, reason: 'failed', message: `We could not start ${verbOf(kind)} your ${nounOf(kind)}. Please try again.` }
      : NETWORK;
  }
  // An answer the server gave is the truth whoever is signed in now; only the record clear is refused on a switch.
  if ('result' in sent) { await clearInflight(clientBuildId, ctx.account); return sent.result; }

  const running: Inflight = { ...entry, jobId: sent.jobId, startedAt: Date.now() };
  // Switched meanwhile: the job exists and runs on for the account that started it; its record is not re-stamped.
  if (!(await writeInflight(running, ctx.account))) return SWITCHED(kind);
  return pollJob(clientBuildId, sent.jobId, kind, running.startedAt + DEADLINE_MS, emit, ctx);
}

/**
 * A remembered build whose POST answer was never seen: send it again with its own id. The server
 * returns the job the first POST made, or — if that one never landed — starts the build the user
 * asked for, under the consent (coveredOnly) they gave then. The entry stays on failure for the next
 * attempt. ⚠️ Called ONLY for the build an explicit Try again named (resendKey): because the second
 * half of that sentence can start and CHARGE a build, it is never run from a mount, a sweep or another
 * chip's retry — a build the user was told had failed, or whose chip they removed, stays unsent.
 */
async function recoverLost(saved: Inflight, f: Flight, ctx: Session): Promise<Outcome> {
  // ⚠️ The SAME expectation the user agreed to when it was first sent — a resend may never widen it.
  const prep = await prepareBuild(saved.target, saved.kind, saved.clientBuildId, saved.coveredOnly, ctx, saved.expectVia);
  if ('fail' in prep) return { gone: true, joiner: prep.fail };
  if (!(await stillSignedIn(ctx))) return { gone: true, joiner: SWITCHED(saved.kind) };
  const sent = await sendBuild(saved.kind, prep.body, ctx);
  if ('lost' in sent) return { gone: true, joiner: NETWORK };
  if ('result' in sent) {
    await clearInflight(saved.clientBuildId, ctx.account);
    return sent.result.ok ? sent.result : { gone: true, joiner: sent.result };
  }
  const running: Inflight = { ...saved, jobId: sent.jobId, startedAt: Date.now() };
  if (!(await writeInflight(running, ctx.account))) return { gone: true, joiner: SWITCHED(saved.kind) };
  return pollJob(saved.clientBuildId, sent.jobId, saved.kind, running.startedAt + DEADLINE_MS, (s) => emitTo(f, s), ctx);
}

/**
 * Build the resume or cover letter for one employer, or one posting at it.
 * `coveredOnly` (default true): the server may spend only plan, free allowance, pass or cache, and
 * refuses with 'quota_exhausted' otherwise. Pass false ONLY when the user chose to build although the plan could not be read (no credit dialog exists any more).
 * `expectVia` (contract C2): WHICH of those the user confirmed. The server refuses with 409 —
 * 'payer_changed', or 'cache_miss' for a promised cache that is not there — before binding or charging
 * anything, so a Continue given to the free allowance can never spend a one-time pass instead.
 * `kind` (default 'resume').
 */
export async function buildForEmployer(
  i: BuildTarget & { coveredOnly?: boolean; kind?: DocKind; expectVia?: ExpectVia },
  onStage: (s: BuildStage) => void,
): Promise<BuildResult> {
  const kind: DocKind = i.kind === 'cover_letter' ? 'cover_letter' : 'resume';
  const company = String(i.company || '').trim();
  if (!company) return { ok: false, reason: 'failed', message: `Which employer is this ${nounOf(kind)} for?` };
  const target: BuildTarget = {
    company, website: String(i.website || ''), jobUrl: i.jobUrl, jobText: i.jobText, jobTitle: i.jobTitle,
    // ⚠️ Untrimmed, like jobUrl: the gate spelled it through gateJobFor as given, and the build must match.
    postingUrl: str(i.postingUrl) || undefined,
    employerId: str(typeof i.employerId === 'string' ? i.employerId.trim() : null),
    country: str(typeof i.country === 'string' ? i.country.trim() : null),
  };
  // postingUrl is NOT part of the key: the key is the doc's identity (the chip), and jobUrl spells it.
  const key = buildKeyOf(kind, target);

  // ⚠️ Everything down to flights.set runs SYNCHRONOUSLY, before the first await, or two taps in the
  // same tick would both see no flight and both start a paid build.
  const live = flights.get(key);
  // A flight a previous account left winding down is not this account's build to join: it gets its own
  // (the old one ends at its next check, and its finally only removes itself from the map).
  if (live && ownedNow(live)) {
    joinFlight(live, onStage);
    return asResult(await live.promise);
  }
  if (activeBuildCount() >= MAX_PARALLEL_BUILDS) return TOO_MANY;

  const f = newFlight({
    key, kind, company, employerId: target.employerId || null, jobUrl: String(target.jobUrl || ''),
    jobKey: jobKeyOf(target), startedAt: Date.now(),
  }, onStage);
  flights.set(key, f);
  f.promise = runBuild(target, f, i.coveredOnly !== false, expectViaOf(i.expectVia))
    .catch((): Outcome => ({ ok: false, reason: 'failed', message: `We could not finish ${verbOf(kind)} your ${nounOf(kind)}. Please try again.` }))
    .finally(() => { if (flights.get(key) === f) flights.delete(key); });
  return asResult(await f.promise);
}

/* ── RECOVERY ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * What a remounted Home would find running: this account's live flights, plus remembered builds still
 * inside their watch window. No network, nothing started. (A build past its deadline is not listed —
 * recovery only takes one quiet look at those.) ⚠️ A lost POST (no jobId) IS listed, so Try again on
 * that chip knows the build may exist — but only that Try again (resendKey) ever resends it.
 */
export async function peekInflight(): Promise<InflightMeta[]> {
  const me = await signedInAccount();
  if (!me) return [];
  const out = new Map<string, InflightMeta>();
  for (const f of Array.from(flights.values())) {
    if ((await f.account) === me && flights.get(f.key) === f) out.set(f.key, metaOf(f));
  }
  const now = Date.now();
  for (const r of (await readInflight(me)) || []) {
    if (!out.has(r.key) && now - r.startedAt < DEADLINE_MS) out.set(r.key, metaOf(r));
  }
  return Array.from(out.values());
}

type Recovered = { key: string; meta: InflightMeta; outcome: Outcome };

export type RecoverOptions = {
  /** Fires for EACH build the moment it settles, with the same entry the resolved array will hold. */
  onLanded?: (key: string, meta: InflightMeta, result: BuildResult) => void;
  /** The ONE build key whose lost POST (a record with no jobId) may be resent — an explicit Try again. */
  resendKey?: string | null;
};

/**
 * ⚠️ INVARIANT the Home store relies on: every key handed to onStage gets an entry in the result (a
 * build the screen was told is running must also be told how it ended), and every entry had onStage
 * called first. So a build past its deadline is announced only once its quiet look found it finished,
 * and a lost POST that is not resent is never announced at all. onLanded, when given, fires for each
 * entry as it settles — after its onStage, before the array resolves.
 */
async function recoverAll(
  onStage: (key: string, s: BuildStage, meta: InflightMeta) => void, only?: DocKind, opts: RecoverOptions = {},
): Promise<Recovered[]> {
  // ⚠️ One session for the whole pass: the records read below are this account's, so the flights made
  // from them run under this account's token (see Flight.ctx) — never whoever signs in mid-recovery.
  const ctx = await readSession();
  const me = ctx.account;
  if (!me) return [];
  const resendKey = typeof opts.resendKey === 'string' && opts.resendKey ? opts.resendKey : null;
  const watched: Array<Promise<Recovered | null>> = [];
  const taken = new Set<string>();
  // ⚠️ PER BUILD, not at the end: Promise.all below waits for the SLOWEST watched build, so a recovered
  // build that finished in a minute stayed on 'building' until a six-minute one beside it ended.
  const landed = (x: Recovered): Recovered => {
    if (opts.onLanded) { try { opts.onLanded(x.key, x.meta, asResult(x.outcome)); } catch { /* the others still land */ } }
    return x;
  };
  const hear = (f: Flight) => {
    const meta = metaOf(f);
    taken.add(f.key);
    try { onStage(f.key, RECOVERING, meta); } catch { /* ignore */ }
    joinFlight(f, (s) => onStage(f.key, s, meta));
    watched.push(f.promise.then((outcome) => landed({ key: f.key, meta, outcome })));
  };

  // Builds already running in this process (Home remounted mid-build) — joined, never restarted.
  for (const f of Array.from(flights.values())) {
    if (only && f.kind !== only) continue;
    if ((await f.account) !== me) continue;
    // Re-checked after the await: one that ended meanwhile was already reported to whoever started it.
    if (flights.get(f.key) === f && !taken.has(f.key)) hear(f);
  }

  const records = (await readInflight(me)) || [];   // null = another account signed in meanwhile: nothing of ours to read
  for (const r of records) {
    if (only && r.kind !== only) continue;
    if (taken.has(r.key)) continue;
    const live = flights.get(r.key);
    if (live) {
      // A build claimed this key while we were reading. One a previous account left winding down is not
      // ours to join — this record waits for a later look.
      if (ownedBy(live, me)) hear(live);
      continue;
    }
    const meta = metaOf(r);
    const late = Date.now() - r.startedAt >= DEADLINE_MS;

    if (!r.jobId) {
      // ⚠️ A LOST POST IS NEVER RESENT BY RECOVERY ON ITS OWN. Its resend can START and CHARGE the build
      // (when the first POST never landed), and by now the user was told it failed — or removed its chip.
      // A mount, a sweep or another chip's Try again leaves it alone: not announced, not returned. Only
      // Try again on this very build (resendKey) sends it, and only inside the watch window.
      if (r.key !== resendKey || late) {
        // Past the window it is forgotten — except the named build's own, which a new tap on that target
        // (runBuild's `prior`) may still resend under the same id instead of minting a second paid build.
        if (late && r.key !== resendKey) await clearInflight(r.clientBuildId, me);
        continue;
      }
    } else if (late) {
      const jobId = r.jobId;
      taken.add(r.key);
      // One quiet look at a build that went 'pending' — collect it if it has finished since.
      watched.push((async (): Promise<Recovered | null> => {
        const o = await readJob(jobId, r.kind, undefined, ctx);
        if (!o || o === 'running' || o === 'auth') return null;    // kept, and looked at again next time
        // Another account signed in meanwhile: not this pass's to report.
        if (!(await clearInflight(r.clientBuildId, me))) return null;
        if ('gone' in o) return null;
        try { onStage(r.key, RECOVERING, meta); } catch { /* ignore */ }
        return landed({ key: r.key, meta, outcome: o });
      })().catch(() => null));
      continue;
    }

    // ⚠️ Claimed SYNCHRONOUSLY (no await since the flights.get above), so a tap on the same target
    // joins this recovery instead of starting a second paid build beside it.
    const f = newFlight({
      key: r.key, kind: r.kind, company: r.company, employerId: r.employerId, jobUrl: r.jobUrl,
      jobKey: r.jobKey, startedAt: r.startedAt,
    }, undefined, ctx);
    flights.set(r.key, f);
    const jobId = r.jobId;
    f.promise = (jobId
      ? pollJob(r.clientBuildId, jobId, r.kind, untilFor(r.startedAt), (s) => emitTo(f, s), ctx)
      : recoverLost(r, f, ctx))
      .catch((): Outcome => ({ gone: true }))
      .finally(() => { if (flights.get(r.key) === f) flights.delete(r.key); });
    hear(f);
  }

  const got = await Promise.all(watched);
  return got.filter((x): x is Recovered => !!x);
}

/**
 * Pick builds back up after Home remounts or the app relaunches: this account's running flights and
 * remembered records, of both kinds. onStage(key, 'recovering') fires at once for each build being
 * watched, then its real stages. `opts.onLanded` fires per build as it settles; the returned array
 * still resolves once all of them have, one entry per watched build.
 * ⚠️ Recovery never starts a NEW build: it polls a job that exists. A lost POST (no jobId) is resent —
 * under its own clientBuildId and the consent given when it was started — ONLY when `opts.resendKey`
 * names its build key (an explicit Try again on it). Mount, sweep and any other chip's retry pass none.
 */
export async function resumeInflightBuilds(
  onStage: (key: string, s: BuildStage, meta: InflightMeta) => void,
  opts?: RecoverOptions,
): Promise<Array<{ key: string; meta: InflightMeta; result: BuildResult }>> {
  const got = await recoverAll(onStage, undefined, opts || {}).catch((): Recovered[] => []);
  return got.map((g) => ({ key: g.key, meta: g.meta, result: asResult(g.outcome) }));
}

/**
 * LEGACY — the single-build, resume-only shape the old Home used. Returns null when there is nothing
 * to show — no remembered build, one the server no longer knows, one still running past its deadline
 * (kept, and looked at again next time), or a lost POST (never resent from here: it names no build to
 * retry). With more than one resume build running, onStage follows the first one heard and that one is
 * returned.
 */
export async function resumeInflightBuild(onStage: (s: BuildStage) => void):
  Promise<{ company: string; result: BuildResult } | null> {
  const bound: { key: string | null } = { key: null };
  const got = await recoverAll((key, s) => {
    if (bound.key === null) bound.key = key;
    if (key === bound.key) { try { onStage(s); } catch { /* ignore */ } }
  }, 'resume').catch((): Recovered[] => []);
  const shown = got.filter((g) => !('gone' in g.outcome));
  const pick = shown.find((g) => g.key === bound.key) || shown[0];
  return pick ? { company: pick.meta.company, result: asResult(pick.outcome) } : null;
}
