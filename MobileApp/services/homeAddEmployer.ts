// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Adding an employer from Home, and building the resume for it right there.
//
// The user's words: adding an employer must NOT walk them off to the Jobs page — the card lands at
// the start of the row and the resume starts building behind a loader. Three calls make that:
//   trackEmployer    → save the employer. FREE, and it never starts a job search.
//   checkBuildGate   → would a build be covered? A DRY RUN on the server; nothing is consumed.
//   buildForEmployer → the async generate lane, polled, with real stage ticks for the overlay.
//
// ⚠️ THE STANDING RULE THIS FILE EXISTS TO KEEP: never regenerate and charge silently. An explicit
// Add is intent to build, so the caller may auto-start ONLY when checkBuildGate says covered (plan,
// free allowance, a download pass, or a cached build). Anything else — legacy credits, exhausted
// quota, or a gate we could not read at all — is "ask first". That is why a failed gate is
// `reason:'unknown'` and never something that looks like covered. And an auto-started build is sent
// with coveredOnly, so even a gate that went stale between the check and the build cannot fall
// through to credits on the server.
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../config';
import { gradFor, cleanJobUrl } from './employerHomeService';

export type TrackedEmployer = {
  employerId: string; name: string; website: string; domain: string;
  logoColor: [string, string]; logoInitial: string;
};

export type BuildGate =
  | { covered: true; via: 'plan' | 'free' | 'pass' | 'cache' }
  | { covered: false; via: 'credits'; credits: number }
  | { covered: false; via: null; reason: 'quota_exhausted' | 'regen_limit' }
  | { covered: false; via: null; reason: 'unknown' };

/** The posting fields the gate fingerprints — the same ones generate-ai receives. */
export type GateJob = { title?: string; url?: string; description?: string; website?: string };

export type BuildTarget = { company: string; website: string; jobUrl?: string; jobText?: string; jobTitle?: string };

export type BuildStage = { stage: string; label: string; pct: number };

/**
 * 'pending' = our polling deadline passed while the job may still finish (and charge). It is NOT a
 * failure and must never be offered as a rebuild — the resume it paid for can still land.
 */
export type BuildResult = { ok: true; cached: boolean }
  | { ok: false; reason: 'quota_exhausted' | 'regen_limit' | 'no_resume' | 'network' | 'failed' | 'pending'; message: string };

const POLL_MS = 1500;
/** How long one watch of a running job lasts before it is reported as 'pending'. */
const DEADLINE_MS = 6 * 60 * 1000;
/** How long a remembered build is honoured at all — the server's clientBuildId dedupe window. */
const KEEP_MS = 15 * 60 * 1000;
/** Someone who comes back to a build past its deadline still gets this long to watch it land. */
const GRACE_MS = 60 * 1000;
// ⚠️ Holds a server job id. Ids from one database mean nothing in another; after an environment
// switch the poll gets a 404 and the entry is dropped as 'gone', so a stale one cannot wedge a build.
const INFLIGHT_KEY = 'home_build_inflight_v1';

/**
 * Who is signed in, as a stable string: the user id, or a token hash for a session without one.
 * ⚠️ THE ONE DEFINITION. EmployerHome keys its module cache with it and the in-flight record below is
 * keyed with it, so the two can never disagree about whose build or whose employers these are.
 * ⚠️ WHY IT EXISTS: App.js's logout resets React state but never reloads the JS bundle, so module state
 * and AsyncStorage both outlive a sign-out. Without an owner, the next account to sign in on the phone
 * inherited the previous account's in-flight build and its company name in the overlay.
 */
export async function signedInAccount(): Promise<string | null> {
  try {
    const u = JSON.parse((await SecureStore.getItemAsync('userSession')) || '{}');
    if (u && u.id != null && String(u.id)) return 'u:' + String(u.id);
    if (u && u.token) {
      const tok = String(u.token);
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      return 't:' + h.toString(36);
    }
  } catch { /* an unreadable session is nobody */ }
  return null;
}

async function token(): Promise<string | undefined> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    return JSON.parse(raw || '{}')?.token;
  } catch { return undefined; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One request. `null` means we never got an answer (no token, dropped connection, timeout) — which
 * callers must keep distinct from any answer the server actually gave.
 * ⚠️ API_BASE is read HERE, per call: it is a live binding the admin environment switch reassigns.
 */
async function call(path: string, init: { method?: 'GET' | 'POST'; body?: any; ms?: number } = {}):
  Promise<{ status: number; ok: boolean; json: any } | null> {
  const t = await token();
  if (!t) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.ms || 20000);
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method: init.method || 'GET',
      headers: init.body !== undefined
        ? { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
        : { Authorization: `Bearer ${t}` },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctl.signal,
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, json: json || {} };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/* ── ADD ────────────────────────────────────────────────────────────────────────────────────────── */

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
 * generate-ai will; if the two requests spelled them differently, a hit the gate promised would miss
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

/** The gate's `job` for a build target — pass this to checkBuildGate so it fingerprints the real build. */
export const gateJobFor = (i: { website?: string; jobUrl?: string; jobText?: string; jobTitle?: string }): GateJob =>
  jobFields({ title: i.jobTitle, url: i.jobUrl, description: i.jobText, website: i.website });

/**
 * ⚠️ Mapped STRICTLY. Anything that is not exactly one of the contract's shapes — a 500, a timeout,
 * `covered:true` with via 'credits', credits missing — is `unknown`, which the caller treats as
 * "ask first". A loose mapping here is precisely how a silent charge would get back in.
 */
export async function checkBuildGate(employer: string, job?: GateJob): Promise<BuildGate> {
  const unread: BuildGate = { covered: false, via: null, reason: 'unknown' };
  const r = await call('/resume-builder/generation-gate', {
    method: 'POST', body: { employer: String(employer || ''), job: jobFields(job || {}) },
  });
  if (!r || !r.ok) return unread;
  const j = r.json;
  if (j.covered === true && (j.via === 'plan' || j.via === 'free' || j.via === 'pass' || j.via === 'cache')) {
    return { covered: true, via: j.via };
  }
  if (j.covered === false && j.via === 'credits' && typeof j.credits === 'number' && isFinite(j.credits) && j.credits >= 0) {
    return { covered: false, via: 'credits', credits: j.credits };
  }
  if (j.covered === false && j.via == null && (j.reason === 'quota_exhausted' || j.reason === 'regen_limit')) {
    return { covered: false, via: null, reason: j.reason };
  }
  return unread;
}

/* ── BUILD ──────────────────────────────────────────────────────────────────────────────────────── *
 *
 * ⚠️ THE ASYNC LANE CHARGES SOMEONE WHO WALKS AWAY. Once the request lands the work outlives it:
 * leaving Home, minimising, even killing the app does not stop it, and the allowance is spent. So
 * nothing here offers a cancel, and no message may say a build was cancelled. What we do instead is
 * REMEMBER the build (AsyncStorage) so a remounted Home can pick the same build back up and show the
 * resume it paid for — see resumeInflightBuild.
 *
 * ⚠️ A LOST ANSWER IS NOT A BUILD THAT NEVER HAPPENED. A dropped connection on the POST can come after
 * the server created (and started charging for) the job. So every build carries a clientBuildId,
 * written to storage BEFORE the POST; the server returns the SAME job for the same id, which makes a
 * retry of the same build safe. A new id is minted only for a genuinely new build — never for a retry.
 *
 * ⚠️ SINGLE-FLIGHT. canConsumeMany checks quota without reserving it, so two builds started together
 * can both pass the check and overrun the allowance. One build at a time, module-wide, keyed on the
 * company AND the posting: only the exact same target joins the running promise; anything else —
 * including a different role at the same company — is refused, because joining would report a
 * role-tailored resume that was never built.
 */
type Inflight = {
  clientBuildId: string;
  company: string;
  jobKey: string;
  startedAt: number;
  /** null while the POST's answer has not been seen — the job may or may not exist on the server. */
  jobId: string | null;
  /** Enough to send the SAME build again. ⚠️ No resume text or contact details: those are refetched. */
  target: BuildTarget;
  coveredOnly: boolean;
};
/** `gone` = nothing to show the recovering screen; `joiner` is what a same-target tap is told instead. */
type Outcome = BuildResult | { gone: true; joiner?: BuildResult };
type Flight = {
  company: string; jobKey: string; promise: Promise<Outcome>;
  listeners: Set<(s: BuildStage) => void>;
  /** The newest stage, replayed to anyone who joins — 'writing' spans the whole AI call, so a joiner
   *  waiting for the NEXT change would stare at an empty overlay for most of the build. */
  last: BuildStage | null;
};

let flight: Flight | null = null;

const NETWORK: BuildResult = { ok: false, reason: 'network', message: 'We could not reach the server. Please try again.' };
const UNREADABLE: BuildResult = { ok: false, reason: 'failed', message: "We couldn't read your resume just now. Please try again." };

const sameCompany = (a?: string, b?: string) =>
  String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

const stillBuilding = (company: string): BuildResult => ({
  ok: false, reason: 'failed',
  message: `Your resume for ${company} is still being built. Try again when it is ready.`,
});

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

async function readInflight(): Promise<Inflight | null> {
  try {
    const raw = await AsyncStorage.getItem(INFLIGHT_KEY);
    const j = raw ? JSON.parse(raw) : null;
    if (!j || typeof j.clientBuildId !== 'string' || !j.clientBuildId || typeof j.company !== 'string' || !j.company
      || typeof j.startedAt !== 'number' || !(j.jobId === null || (typeof j.jobId === 'string' && j.jobId))) return null;
    // ⚠️ Another account's build is not ours to resume or to report on. Dropped, not just ignored, so it
    // cannot surface again for the account that DID start it on some later sign-in either — its job
    // still completes and lands on the server, and Home shows it from there.
    const me = await signedInAccount();
    if (!me || j.account !== me) { await AsyncStorage.removeItem(INFLIGHT_KEY).catch(() => {}); return null; }
    const t = j.target && typeof j.target === 'object' ? j.target : {};
    return {
      clientBuildId: j.clientBuildId, company: j.company, startedAt: j.startedAt, jobId: j.jobId,
      jobKey: typeof j.jobKey === 'string' ? j.jobKey : '',
      target: {
        company: j.company, website: String(t.website || ''),
        jobUrl: t.jobUrl || undefined, jobText: t.jobText || undefined, jobTitle: t.jobTitle || undefined,
      },
      // ⚠️ Anything but an explicit false is "covered only": a mangled entry must never widen consent.
      coveredOnly: j.coveredOnly !== false,
    };
  } catch { return null; }
}
async function writeInflight(v: Inflight): Promise<void> {
  try {
    const account = await signedInAccount();
    if (!account) return;   // nobody signed in owns nothing, so there is nothing to recover
    await AsyncStorage.setItem(INFLIGHT_KEY, JSON.stringify({ ...v, account }));
  } catch { /* recovery is a nicety */ }
}
/** Clears only OUR entry, so a finishing build can never erase the record of a different one. */
async function clearInflight(clientBuildId: string): Promise<void> {
  try {
    const cur = await readInflight();
    if (cur && cur.clientBuildId !== clientBuildId) return;
    await AsyncStorage.removeItem(INFLIGHT_KEY);
  } catch { /* nothing to do */ }
}

function emitTo(f: Flight, s: BuildStage) {
  f.last = s;
  // ⚠️ A listener that throws (an unmounted screen's setState, say) must not end the poll for the
  // others — an exception here would abandon a build the user is still being charged for.
  f.listeners.forEach((l) => { try { l(s); } catch { /* ignore */ } });
}

function newFlight(company: string, jobKey: string, onStage: (s: BuildStage) => void): Flight {
  return { company, jobKey, listeners: new Set([onStage]), last: null, promise: null as unknown as Promise<Outcome> };
}

/** Join a running build: listen from now on AND hear where it has already got to, synchronously. */
function joinFlight(f: Flight, onStage: (s: BuildStage) => void) {
  f.listeners.add(onStage);
  if (f.last) { try { onStage(f.last); } catch { /* ignore */ } }
}

const FAIL_REASONS = ['quota_exhausted', 'regen_limit', 'no_resume'] as const;
const failReason = (r: any): 'quota_exhausted' | 'regen_limit' | 'no_resume' | 'failed' =>
  (FAIL_REASONS as readonly string[]).includes(r) ? r : 'failed';

/**
 * One status read: a terminal outcome, 'running', 'auth' (signed out — the job itself runs on), or
 * null when the server could not be asked.
 */
async function readJob(jobId: string, onStage?: (s: BuildStage) => void): Promise<Outcome | 'running' | 'auth' | null> {
  const r = await call(`/job-status/${encodeURIComponent(jobId)}`, { ms: 15000 });
  if (!r) return null;                                   // one dropped poll is not a failure
  if (r.status === 404) return { gone: true };
  if (r.status === 401) return 'auth';
  if (!r.ok) return null;
  const j = r.json;
  // ⚠️ `data` carries TWO different things: the {stage,label,pct} envelope while running, and the
  // real payload once completeJob overwrites it. `resumeData` is what tells them apart.
  if (j.data && j.data.stage && !j.data.resumeData && onStage) {
    onStage({ stage: String(j.data.stage), label: String(j.data.label || ''), pct: Number(j.data.pct) || 0 });
  }
  if (j.status === 'completed') {
    const d = j.data || {};
    if (d.resumeData) return { ok: true, cached: !!d.cached };
    return { ok: false, reason: 'failed', message: d.error || 'The resume finished but came back empty. Please try again.' };
  }
  if (j.status === 'failed') {
    return {
      ok: false,
      reason: failReason(j.reason ?? (j.data && j.data.reason)),
      message: j.error || 'We could not finish building your resume. Please try again.',
    };
  }
  return 'running';
}

const untilFor = (startedAt: number) => Math.max(startedAt + DEADLINE_MS, Date.now() + GRACE_MS);

async function pollJob(clientBuildId: string, jobId: string, until: number, onStage: (s: BuildStage) => void): Promise<Outcome> {
  let last = '';
  const tick = (s: BuildStage) => {
    const k = `${s.stage}|${s.pct}|${s.label}`;
    if (k !== last) { last = k; onStage(s); }
  };
  // ⚠️ Poll BEFORE checking the deadline. JS timers stop while the app is backgrounded, so a user
  // who comes back after ten minutes wakes this loop already past the deadline — without a final
  // read they would be told "taking longer than usual" about a resume that finished long ago.
  for (;;) {
    await sleep(POLL_MS);
    const o = await readJob(jobId, tick);
    // The job is still the user's and still spending: keep the entry so signing back in finds it.
    if (o === 'auth') return { ok: false, reason: 'failed', message: 'Please sign in again to see your resume.' };
    if (o && o !== 'running') { await clearInflight(clientBuildId); return o; }
    if (Date.now() >= until) break;
  }
  // ⚠️ 'pending', and the entry is KEPT: the job may still finish and charge, so this must neither
  // offer a rebuild nor forget the build a later resumeInflightBuild can still collect.
  return {
    ok: false, reason: 'pending',
    message: 'This is taking longer than usual. Your resume may still arrive — check Home in a minute.',
  };
}

/**
 * The request body, from the user's base resume and profile.
 * ⚠️ THREE OUTCOMES, NEVER TWO: "no resume" must be something the server SAID — a short base text
 * AND a profile with no resume on it. A timeout is 'network', and a resume the server has but could
 * not read (a 5xx, or empty text beside an uploaded file) is 'failed': telling a user who HAS a
 * resume to go upload one is how they end up overwriting it.
 */
async function prepareBuild(i: BuildTarget, clientBuildId: string, coveredOnly: boolean):
  Promise<{ body: Record<string, any> } | { fail: BuildResult }> {
  const [src, prof] = await Promise.all([
    call('/resume-score/source-text?base=1', { ms: 20000 }),
    call('/users/profile', { ms: 20000 }),
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
      rawText: text,
      name: p.fullName || '', email: p.email || '',
      phone: p.phone || '', location: p.address || '',
      includeUploadedResume: true,
      // ⚠️ website is NEVER placed in url. job.url is a POSTING and the server scrapes it as posting
      // text; a homepage scraped in as "Posting text" tailors the resume to the careers-page chrome.
      job: { company: i.company, ...gateJobFor(i) },
    },
  };
}

type Sent = { jobId: string } | { result: BuildResult } | { lost: true; status: number };

/** One POST. `lost` = no answer we can trust (no response, or a 5xx a proxy may have sent after the job was made). */
async function sendBuild(body: Record<string, any>): Promise<Sent> {
  const r = await call('/resume-builder/generate-ai', { method: 'POST', ms: 90000, body });
  if (!r || r.status >= 500) return { lost: true, status: r ? r.status : 0 };
  const s = r.json;
  if (r.status === 401) return { result: { ok: false, reason: 'failed', message: 'Please sign in again.' } };
  if (r.status === 402) return { result: { ok: false, reason: 'quota_exhausted', message: s.error || 'You have used your plan allowance.' } };
  if (r.status === 403) return { result: { ok: false, reason: 'regen_limit', message: s.error || 'Your free plan includes one rebuild.' } };
  if (!r.ok) return { result: { ok: false, reason: failReason(s.reason), message: s.error || 'We could not start building your resume.' } };
  // ⚠️ asJob runs SYNCHRONOUSLY when it cannot create a job row, and then this IS the finished
  // resume rather than a job id. Handle both or that fallback looks like a failure.
  if (s.resumeData) return { result: { ok: true, cached: !!s.cached } };
  if (s.jobId) return { jobId: String(s.jobId) };
  return { result: { ok: false, reason: 'failed', message: 'We could not start building your resume.' } };
}

async function runBuild(i: BuildTarget, f: Flight, coveredOnly: boolean): Promise<Outcome> {
  const emit = (s: BuildStage) => emitTo(f, s);
  let clientBuildId = newBuildId();
  let startedAt = Date.now();

  // A build remembered from before (a relaunch, or a POST whose answer was lost) may still be
  // spending the allowance. Join it if it is this target; refuse a second one if it is not.
  const prior = await readInflight();
  if (prior) {
    const age = Date.now() - prior.startedAt;
    const same = sameCompany(prior.company, i.company) && prior.jobKey === f.jobKey;
    if (age >= KEEP_MS) {
      await clearInflight(prior.clientBuildId);
    } else if (prior.jobId) {
      const now = await readJob(prior.jobId);
      if (now === 'running' || now === null || now === 'auth') {
        if (same) return pollJob(prior.clientBuildId, prior.jobId, untilFor(prior.startedAt), emit);
        return stillBuilding(prior.company);
      }
      await clearInflight(prior.clientBuildId);     // finished, or the server no longer knows it
    } else if (same) {
      // ⚠️ THE RETRY OF A LOST ANSWER IS THE SAME BUILD: same id, so the server hands back the job the
      // first POST may already have made instead of creating (and charging for) a second one.
      clientBuildId = prior.clientBuildId;
      startedAt = prior.startedAt;
    } else if (age < DEADLINE_MS) {
      return {
        ok: false, reason: 'failed',
        message: `Your resume for ${prior.company} may still be building. Try again in a few minutes.`,
      };
    } else {
      await clearInflight(prior.clientBuildId);
    }
  }

  emit({ stage: 'reading', label: 'Reading your resume', pct: 3 });
  const prep = await prepareBuild(i, clientBuildId, coveredOnly);
  if ('fail' in prep) return prep.fail;

  const entry: Inflight = { clientBuildId, company: i.company, jobKey: f.jobKey, startedAt, jobId: null, target: i, coveredOnly };
  // ⚠️ Written BEFORE the POST: if the app dies mid-request, this is the only record that a paid
  // build may exist, and the only way a later attempt reuses its id.
  await writeInflight(entry);
  let sent = await sendBuild(prep.body);
  if ('lost' in sent) {
    await sleep(POLL_MS);
    sent = await sendBuild(prep.body);             // ⚠️ the SAME body, so the SAME clientBuildId
  }
  if ('lost' in sent) {
    // The entry stays: resumeInflightBuild (or a retry of this target) resends with this id.
    return sent.status ? { ok: false, reason: 'failed', message: 'We could not start building your resume. Please try again.' } : NETWORK;
  }
  if ('result' in sent) { await clearInflight(clientBuildId); return sent.result; }

  const running: Inflight = { ...entry, jobId: sent.jobId, startedAt: Date.now() };
  await writeInflight(running);
  return pollJob(clientBuildId, sent.jobId, running.startedAt + DEADLINE_MS, emit);
}

/**
 * A remembered build whose POST answer was never seen: send it again with its own id. The server
 * returns the job the first POST made, or — if that one never landed — starts the build the user
 * asked for, under the consent (coveredOnly) they gave then. Failures are quiet: the user was
 * already told, and the entry stays for the next attempt.
 */
async function recoverLost(saved: Inflight, f: Flight): Promise<Outcome> {
  const prep = await prepareBuild(saved.target, saved.clientBuildId, saved.coveredOnly);
  if ('fail' in prep) return { gone: true, joiner: prep.fail };
  const sent = await sendBuild(prep.body);
  if ('lost' in sent) return { gone: true, joiner: NETWORK };
  if ('result' in sent) {
    await clearInflight(saved.clientBuildId);
    return sent.result.ok ? sent.result : { gone: true, joiner: sent.result };
  }
  const running: Inflight = { ...saved, jobId: sent.jobId, startedAt: Date.now() };
  await writeInflight(running);
  return pollJob(saved.clientBuildId, sent.jobId, running.startedAt + DEADLINE_MS, (s) => emitTo(f, s));
}

/**
 * Build the resume for one employer, or one posting at it.
 * `coveredOnly` (default true): the server may spend only plan, free allowance, pass or cache, and
 * refuses with 'quota_exhausted' otherwise. Pass false ONLY after the user confirmed a credit charge.
 */
export function buildForEmployer(
  i: BuildTarget & { coveredOnly?: boolean },
  onStage: (s: BuildStage) => void,
): Promise<BuildResult> {
  const company = String(i.company || '').trim();
  if (!company) return Promise.resolve({ ok: false, reason: 'failed', message: 'Which employer is this resume for?' });
  const target: BuildTarget = { company, website: i.website, jobUrl: i.jobUrl, jobText: i.jobText, jobTitle: i.jobTitle };
  const jobKey = jobKeyOf(target);

  if (flight) {
    if (sameCompany(flight.company, company) && flight.jobKey === jobKey) {
      joinFlight(flight, onStage);
      return flight.promise.then(asResult);
    }
    return Promise.resolve(stillBuilding(flight.company));
  }

  // ⚠️ `flight` is claimed SYNCHRONOUSLY, before the first await, or two taps in the same tick would
  // both see it empty and both start a paid build.
  const f = newFlight(company, jobKey, onStage);
  flight = f;
  f.promise = runBuild(target, f, i.coveredOnly !== false)
    .catch((): Outcome => ({ ok: false, reason: 'failed', message: 'We could not finish building your resume. Please try again.' }))
    .finally(() => { if (flight === f) flight = null; });
  return f.promise.then(asResult);
}

/**
 * Pick a build back up after Home remounts or the app relaunches. Returns null when there is nothing
 * to show — no remembered build, one the server no longer knows, one still running past its deadline
 * (kept, and looked at again next time), or a lost POST that could not be resent just now.
 */
export async function resumeInflightBuild(onStage: (s: BuildStage) => void):
  Promise<{ company: string; result: BuildResult } | null> {
  const join = async (f: Flight) => {
    joinFlight(f, onStage);
    const o = await f.promise;
    return 'gone' in o ? null : { company: f.company, result: o };
  };
  if (flight) return join(flight);

  const saved = await readInflight();
  if (flight) return join(flight);          // a build claimed the slot while we were reading
  if (!saved) return null;
  const age = Date.now() - saved.startedAt;
  if (age >= KEEP_MS) { await clearInflight(saved.clientBuildId); return null; }

  if (age >= DEADLINE_MS) {
    // ⚠️ Too late to START anything: a lost POST this old is one the user was told had failed.
    if (!saved.jobId) return null;
    // One quiet look at a build that went 'pending' — collect it if it has finished since.
    const o = await readJob(saved.jobId);
    if (!o || o === 'running' || o === 'auth') return null;
    await clearInflight(saved.clientBuildId);
    return 'gone' in o ? null : { company: saved.company, result: o };
  }

  const f = newFlight(saved.company, saved.jobKey, onStage);
  flight = f;
  const jobId = saved.jobId;
  f.promise = (jobId
    ? pollJob(saved.clientBuildId, jobId, untilFor(saved.startedAt), (s) => emitTo(f, s))
    : recoverLost(saved, f))
    .catch((): Outcome => ({ gone: true }))
    .finally(() => { if (flight === f) flight = null; });
  return join(f);
}
