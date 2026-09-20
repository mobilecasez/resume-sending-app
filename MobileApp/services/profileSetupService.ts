// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Everything the "Make Yours" wizard reads and writes.
//
// ⚠️ NOTHING HERE IS A NEW SERVER SURFACE. Every endpoint already existed and is already used by
// App.js; this file only gives the wizard a typed, swallowing client for them. That matters because
// a wizard that invents its own "profile complete" rule would be the THIRD definition in this
// codebase — server/controllers/profileController.js says phone+address+DOB, server/services/
// journey.js says those three PLUS all three files on disk — and three rules that disagree is how a
// green tick appears over a profile the generator then refuses. So `setup` is read from the server,
// never computed here.
//
// ⚠️ A PATH IN THE DATABASE IS NOT PROOF OF A FILE. profileController.livePath() stat()s every path
// and returns null when it is missing (account deletion rm -rf's the folder while leaving the row),
// which is why completeness is taken from `setup` and not from whether a URL string is non-empty.
//
// ⚠️ THE PARTIAL-UPDATE ENDPOINT, NEVER /api/update-user-details. POST /users/profile/update writes
// only truthy fields; /api/update-user-details overwrites everything it was not given with NULL, so
// a half-filled wizard step would silently erase the phone number they set last month.
//
// ⚠️ …AND THE WIZARD'S OWN PROGRESS IS THE SERVER'S TOO (2026-09-19). `setup.wizard` (server/services/
// onboardingProgress.js) says which step is the first unfinished one, what was typed, what was skipped, whether the
// CV has been READ, and whether a build is running. The owner's fresh account lost his signature and his CV on the
// way through, was charged for two empty résumés, and after a restart "Pick up where you left off" was gone — all
// of it state that lived in the screen. Every wizard write below carries X-CV-Source: onboarding, which is how the
// server tells the wizard from Account Settings (App.js writes through the very same endpoints).
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../config';
import { signedInAccount } from './homeAddEmployer';
import { deviceHeaders } from './employerHomeService';

export type WizardStepKey = 'you' | 'sign' | 'experience' | 'build';
/** Whether the uploaded CV has been read: 'slow' is a transient failure the server retries by itself. */
export type CvStatus = 'done' | 'pending' | 'slow' | 'error' | 'unread';
export type WizardCv = { ext: string | null; uploadedAt: string | null; status: CvStatus; error: string | null };
export type WizardState = {
  /** 'none' = never wrote through the wizard; 'open' = unfinished; 'finished' = a wizard build was charged and saved;
   *  'closed' = the profile was completed in Account Settings. */
  state: 'none' | 'open' | 'finished' | 'closed';
  step: number;
  stepKey: WizardStepKey;
  done: Record<WizardStepKey, boolean>;
  /** What is still to do, in wizard order — "your signature", "building your resume"… */
  left: string[];
  lane: 'write' | 'upload' | null;
  notes: string;
  skipped: { photo: boolean; signature: boolean };
  cv: WizardCv | null;
  build: { jobId: string; status: 'running' | 'stale' | 'completed' | 'failed' } | null;
  /** A built résumé with something in it already exists — building again spends a generation. */
  builtResume: boolean;
  closedBy: string | null;
};

export type ProfileSetup = {
  /** phone + address + date of birth are present. */
  profile: boolean;
  resume: boolean;
  photo: boolean;
  signature: boolean;
  complete: boolean;
  /** The Make Yours wizard's progress. null/absent from an older server, or when it could not be read. */
  wizard?: WizardState | null;
};

/** Every write the wizard makes carries this. The server keeps the wizard open for it, and closes the wizard only
 *  for a write WITHOUT it (Account Settings) that completes the profile. */
export const WIZARD_HEADER: Record<string, string> = { 'X-CV-Source': 'onboarding' };

export type ProfileSnapshot = {
  fullName: string;
  email: string;
  phone: string;
  address: string;
  dateOfBirth: string;      // YYYY-MM-DD, or ''
  gender: string;
  profileImage: string | null;
  signature: string | null;
  resume: string | null;
  setup: ProfileSetup;
};

const EMPTY_SETUP: ProfileSetup = { profile: false, resume: false, photo: false, signature: false, complete: false };

async function token(): Promise<string | undefined> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    return JSON.parse(raw || '{}')?.token;
  } catch { return undefined; }
}

/**
 * The last `setup` this account was told, so Home can draw its button at once and KEEP it through a failed re-read.
 * ⚠️ PER ACCOUNT: App.js's logout does not reload the bundle, so an unkeyed copy would show the previous account's
 * "Pick up where you left off" to the next one. Only ever a stand-in while the server is asked again.
 */
const SETUP_CACHE = 'profile_setup_cache_v1:';

async function writeCachedSetup(setup: ProfileSetup) {
  try {
    const who = await signedInAccount();
    if (who) await AsyncStorage.setItem(SETUP_CACHE + who, JSON.stringify(setup));
  } catch { /* a cache that cannot be written is only a slower first paint */ }
}

/** This account's last known `setup`, or null. Never a network call. */
export async function cachedSetup(): Promise<ProfileSetup | null> {
  try {
    const who = await signedInAccount();
    if (!who) return null;
    const raw = await AsyncStorage.getItem(SETUP_CACHE + who);
    return raw ? { ...EMPTY_SETUP, ...JSON.parse(raw) } : null;
  } catch { return null; }
}

/** What the server believes about this profile. Null when it could not be asked. */
export async function fetchProfileSnapshot(): Promise<ProfileSnapshot | null> {
  const t = await token();
  if (!t) return null;
  try {
    const r = await fetch(`${API_BASE}/users/profile`, { headers: { Authorization: `Bearer ${t}` } });
    if (!r.ok) return null;
    const j = await r.json();
    const setup: ProfileSetup = { ...EMPTY_SETUP, ...(j.setup || {}) };
    writeCachedSetup(setup);
    return {
      fullName: j.fullName || '',
      email: j.email || '',
      phone: j.phone || '',
      address: j.address || '',
      dateOfBirth: j.dateOfBirth || '',
      gender: j.gender || '',
      profileImage: j.profileImage || null,
      signature: j.signature || null,
      resume: j.resume || null,
      setup,
    };
  } catch { return null; }
}

/**
 * What Home's Make-Yours button stands for, from `setup` alone — pure, so the rule is run by a test, not re-read.
 * ⚠️ THE OWNER'S RULE (2026-09-19): "Pick up where you left off" stays "till the time he either finish it using make
 * my resume or complete the profile by going to the account settings". So:
 *   wizard 'open'     → NOT complete, whatever the four booleans say; `left` is the wizard's own list, and it is
 *                       always non-empty ("building your resume" is on it until a build is charged and saved);
 *   wizard 'finished' → complete (the build is the finish line; a skipped photo does not reopen the wizard);
 *   wizard 'closed'   → complete: the server closes it only on the Account Settings write that COMPLETED the profile
 *                       by the wizard's own fields (onboardingProgress.closeIfCompletedElsewhere) — the owner's second
 *                       door. ⚠️ NOT the checklist's setup.complete (review round 2, 2026-09-19): that one also wants a
 *                       date of birth, a photo and a signature the wizard calls optional, so a wizard closed with a
 *                       skipped photo kept "Pick up where you left off · your details and a photo", and the tap opened
 *                       the wizard on Build — naming two things it never asks for, and offering a paid build;
 *   none              → the old rule, setup.complete — EXCEPT when the wizard's own rules leave nothing to do (a real
 *                       résumé, details, photo and signature: the date of birth the checklist also wants is optional
 *                       in the wizard). "Pick up" would open on "Your resume is ready" and lead nowhere.
 * `left` names what the WIZARD will ask for, where it will open (the server's own list whenever it sent one — a
 * sentence that names a date of birth and then opens on Build is a broken promise); an older server without wizard
 * state gets the four booleans. Nothing is left once it is complete by the wizard's rules.
 */
export function makeYoursOf(setup: ProfileSetup): { complete: boolean; started: boolean; left: string[]; wizardOpen: boolean } {
  const wz = setup.wizard || null;
  const wizardOpen = !!wz && wz.state === 'open';
  const nothingLeft = !!wz && Array.isArray(wz.left) && wz.left.length === 0;
  const wizardDone = !!wz && (wz.state === 'finished' || wz.state === 'closed' || (!wizardOpen && nothingLeft));
  const complete = wizardDone ? true : wizardOpen ? false : !!setup.complete;
  const left = complete ? [] : wz && Array.isArray(wz.left) ? wz.left.slice() : ([
    [setup.profile, 'your details'], [setup.photo, 'a photo'],
    [setup.signature, 'your signature'], [setup.resume, 'your experience'],
  ] as Array<[boolean, string]>).filter(([done]) => !done).map(([, n]) => n);
  const started = wizardOpen || setup.profile || setup.photo || setup.signature || setup.resume;
  return { complete, started, left, wizardOpen };
}

/**
 * Home re-reads `setup` on every focus; this makes the NEXT focus also reload the pages (a résumé was just built,
 * so the designs on Home are now of it). Set by the wizard, read once by Home.
 *
 * ⚠️ …AND IT CARRIES THE ANSWER, NOT JUST THE FLAG (2026-09-20). The owner built his résumé, tapped "See my
 * designs", and Home still offered "Pick up where you left off" — the server had said `finished` since the instant
 * the build was saved, but Home only ASKED for the profile at the very end of its load, behind the ~22 s of cold
 * renders that build had just caused. The wizard already knows the answer by then, so it hands it over and Home
 * paints the finished state on its first frame. The network read still runs (in parallel) and still wins.
 */
let profileChanged = false;
let changedSetup: { who: string; setup: ProfileSetup } | null = null;
export function markProfileChanged() { profileChanged = true; }
/**
 * A fresher `setup` for a change ALREADY marked — what the wizard read after the build landed.
 * ⚠️ It never re-arms a flag Home has consumed: that would cost a second full reload (with the pages cleared)
 * on the next focus, for a screen that is already showing this résumé.
 *
 * ⚠️ AND IT IS KEYED BY ACCOUNT (2026-09-20 review), for the reason SETUP_CACHE above is: this is module state and
 * App.js's logout does not reload the bundle, so a hand-over armed by A and never consumed — A built a résumé and
 * walked to Settings rather than Home — would otherwise paint A's finished wizard for whoever signs in next. The
 * flag alone only ever cost a redundant reload; this carries an answer, so it says whose. Awaits the session read,
 * so a Home that consumes first simply gets no hand-over and falls back to its own read (see consumeProfileChanged).
 */
export async function handOverSetup(setup: ProfileSetup): Promise<void> {
  if (!profileChanged) return;
  const who = await signedInAccount().catch(() => null);
  if (!who || !profileChanged) return;
  changedSetup = { who, setup };
}
/** `who` = the account the setup was READ for; the caller applies it only to that account. */
export function consumeProfileChanged(): { changed: boolean; setup: ProfileSetup | null; who: string | null } {
  const v = { changed: profileChanged, setup: changedSetup ? changedSetup.setup : null, who: changedSetup ? changedSetup.who : null };
  profileChanged = false;
  changedSetup = null;
  return v;
}

/**
 * What the wizard knows that no profile column holds: the typed notes, the lane, the skips — and `readCv` asks the
 * server to read a CV on file that has never been read. Answers with the fresh wizard state (null when unreachable).
 */
export async function saveOnboarding(patch: {
  notes?: string; lane?: 'write' | 'upload'; skipped?: { photo?: boolean; signature?: boolean }; readCv?: boolean;
}): Promise<{ ok: boolean; wizard: WizardState | null; message?: string }> {
  const t = await token();
  if (!t) return { ok: false, wizard: null, message: 'Please sign in again.' };
  try {
    const r = await fetch(`${API_BASE}/users/profile/onboarding`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...WIZARD_HEADER },
      body: JSON.stringify(patch),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, wizard: j.wizard || null } : { ok: false, wizard: null, message: j.error || 'We could not save your progress.' };
  } catch {
    return { ok: false, wizard: null, message: 'We could not reach the server. Please try again.' };
  }
}

/**
 * Follow the uploaded CV until the server has READ it (or given up on it). The parse runs in the background after the
 * upload answers — a scanned PDF read by the vision model can take most of a minute.
 * Resolves with the last status seen ('pending' if `maxMs` ran out first) and the server's sentence for an error.
 */
export async function waitForResumeParse(
  onTick?: (cv: WizardCv) => void, isLeft?: () => boolean, maxMs = 3 * 60 * 1000,
): Promise<WizardCv | null> {
  const until = Date.now() + maxMs;
  let last: WizardCv | null = null;
  while (Date.now() < until) {
    if (isLeft && isLeft()) return last;
    const s = await fetchProfileSnapshot();
    // ⚠️ A server that ANSWERS without wizard state (before Migration 047, a rollback, another environment) will never
    // say whether a CV was read: stop at once rather than poll it for three minutes (review, 2026-09-19).
    if (s && !s.setup.wizard) return last;
    const cv = s && s.setup.wizard ? s.setup.wizard.cv : null;
    if (cv) {
      last = cv;
      if (onTick) onTick(cv);
      if (cv.status === 'done' || cv.status === 'error') return cv;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return last;
}

export type SaveResult = { ok: boolean; message?: string };

/**
 * The typed details.
 *
 * ⚠️ `gender` is a strict enum on the server — 'Male' | 'Female' | 'Prefer Not to Say' | '' — and
 * anything else is a 400. ⚠️ `dateOfBirth` must be a plain YYYY-MM-DD; the server applies its own
 * noon-shift so the date survives timezones. Sending an ISO instant re-introduces the off-by-one.
 *
 * ⚠️ city and country are deliberately NOT here. No endpoint in this codebase writes users.city or
 * users.nationality from user input, and POST /api/update-user-details looks like it accepts them
 * and then silently drops them. `address` is the field that is actually stored, and it is the one
 * the completeness rule counts.
 */
export async function saveDetails(d: {
  fullName?: string; phone?: string; address?: string; dateOfBirth?: string; gender?: string;
}): Promise<SaveResult> {
  const t = await token();
  if (!t) return { ok: false, message: 'Please sign in again.' };
  const body: Record<string, string> = {};
  for (const k of ['fullName', 'phone', 'address', 'dateOfBirth', 'gender'] as const) {
    const v = (d as any)[k];
    if (typeof v === 'string' && v.trim()) body[k] = v.trim();
  }
  if (!Object.keys(body).length) return { ok: true };          // nothing to say is not a failure
  try {
    const r = await fetch(`${API_BASE}/users/profile/update`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...WIZARD_HEADER },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true } : { ok: false, message: j.error || 'We could not save those details.' };
  } catch {
    return { ok: false, message: 'We could not reach the server. Please try again.' };
  }
}

/**
 * One file, to one of the three single-file endpoints.
 *
 * The `{ uri, name, type }` shape is React Native's own FormData file part — it is not a browser
 * File and must not be a Blob. This is the exact shape App.js has been uploading with since the
 * profile screen shipped; do not "modernise" it.
 */
async function upload(path: string, field: string, file: { uri: string; name: string; type: string }): Promise<SaveResult & { format?: string; reason?: string }> {
  const t = await token();
  if (!t) return { ok: false, message: 'Please sign in again.' };
  try {
    const form = new FormData();
    // @ts-expect-error — RN's FormData takes this object form for a file part; the DOM types do not.
    form.append(field, { uri: file.uri, name: file.name, type: file.type });
    const r = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      // ⚠️ never set Content-Type — the boundary is generated. X-CV-Source marks this as the wizard's write.
      headers: { Authorization: `Bearer ${t}`, ...WIZARD_HEADER },
      body: form,
    });
    const j = await r.json().catch(() => ({}));
    // A refused résumé (415 / 413) carries the server's own sentence: which formats work, or that it is too large.
    return r.ok ? { ok: true, format: j.format } : { ok: false, message: j.error || 'That upload did not go through.', reason: j.reason };
  } catch {
    return { ok: false, message: 'We could not reach the server. Please try again.' };
  }
}

export const uploadPhoto = (uri: string) =>
  upload('/users/profile/image', 'profileImage', { uri, name: 'profile.jpg', type: 'image/jpeg' });

export const uploadSignature = (uri: string) =>
  upload('/users/profile/signature', 'signature', { uri, name: 'signature.png', type: 'image/png' });

/**
 * The CV formats the server can really READ (services/resumeText.js + pdf-parse) — the picker offers exactly these.
 * ⚠️ NEVER ADD ONE THE SERVER CANNOT READ: the upload refuses it (415) and the user is left with a picker that lied.
 */
export const RESUME_PICKER_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   // .docx
  'application/msword',                                                          // .doc (Word 97-2003)
  'application/vnd.oasis.opendocument.text',                                     // .odt
  'application/rtf', 'text/rtf',                                                // .rtf
  'text/plain',                                                                  // .txt
];
/** What the upload step says it takes — the same list, in words. */
export const RESUME_FORMATS_LINE = 'PDF, Word (.docx or .doc), OpenDocument, RTF or plain text';

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', docx: RESUME_PICKER_TYPES[1], doc: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text', rtf: 'application/rtf', txt: 'text/plain',
};
/** The file's type for the multipart part: the picker's when it gave one, else from its name. The server decides
 *  from the BYTES either way — iOS hands a .docx over as application/octet-stream. */
export function resumeMimeOf(name: string, pickerType?: string | null): string {
  if (pickerType && pickerType !== 'application/octet-stream') return pickerType;
  const ext = String(name || '').split('.').pop()?.toLowerCase() || '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * ⚠️ The parse is FIRE AND FORGET. This resolves long before resume_metadata is usable, so nothing
 * may read the extracted skills or summary straight afterwards and expect them to be there — follow it with
 * waitForResumeParse. The server marks the new CV 'pending' BEFORE it answers, so a read straight after this
 * never mistakes the previous CV for this one.
 */
export const uploadResumeFile = (uri: string, name: string, type: string) =>
  upload('/users/profile/resume', 'resume', { uri, name: name || 'resume.pdf', type: resumeMimeOf(name, type) });

/* ── BUILDING THE RESUME, WITH REAL PROGRESS ─────────────────────────────────────────────────────
 *
 * ⚠️ THIS RUNS AS A BACKGROUND JOB, AND THAT IS A DELIBERATE CHANGE OF SHAPE.
 * The synchronous lane holds one socket for up to four and a half minutes of server work against a
 * two-minute client abort, so a run that hit a Gemini retry told the user "taking too long, tap
 * Generate again" while the server quietly finished and saved. Sending `__async: true` returns a
 * job id in about fifty milliseconds and the work outlives the request — the app can be minimised,
 * and the timeout failure disappears entirely.
 *
 * The trade, stated plainly because it is real: in the synchronous lane a user who walked away was
 * NOT charged (the server watches the socket close). Here they are charged — and they get the
 * resume, waiting for them when they come back. For a wizard whose whole purpose is to end with a
 * finished resume, that is the right side of the trade.
 */
export type GenStage = { stage: string; label: string; pct: number };

const POLL_MS = 1500;
const DEADLINE_MS = 6 * 60 * 1000;

/**
 * Why the server said no, when it said it with a reason the wizard acts on:
 *   quota_exhausted / regen_limit — Plans;  thin_input — nothing to build from (add detail);
 *   cv_not_ready — the CV is still being read (try again shortly);  cv_unreadable — back to the upload;
 *   no_resume — too little text.  Every one of them was decided BEFORE the charge: nothing was spent.
 */
export type BuildRefusal = 'quota_exhausted' | 'regen_limit' | 'thin_input' | 'cv_not_ready' | 'cv_unreadable' | 'no_resume';
const REFUSALS: BuildRefusal[] = ['quota_exhausted', 'regen_limit', 'thin_input', 'cv_not_ready', 'cv_unreadable', 'no_resume'];

/**
 * ⚠️ ONE TAP, ONE BUILD, ONE CHARGE (2026-09-19). The wizard used to send no clientBuildId, so "could not reach the
 * server" + Try again could start a second charged job for the first one's résumé; after the deadline Try again
 * started a new build while the first was still running; and a wizard reopened mid-build forgot the running job.
 * ⚠️ None of those is how user 616 paid twice in 34 seconds (production, corrected after review): his first build
 * had already COMPLETED — empty, in 1.6 s, while his CV was still being read — and was charged; "Ready" sent him Home,
 * Home said "Pick up" because his drawn signature was never uploaded, and the reopened wizard asked for the CV again
 * and offered Build again. Those are stopped by the server's refusals before the charge (empty résumé, unread CV),
 * the signature committed on every way off its step, and a charged-and-saved build finishing the wizard. Now:
 *   done    — the résumé is saved and paid for;
 *   refused — the server declined before charging (see BuildRefusal);
 *   failed  — retrySame: no answer reached us, so the build MAY be running — Try again repeats the SAME clientBuildId
 *             (asJob hands back the same job) after asking the server whether it already finished or is running;
 *             otherwise a real failure, and Try again is a new build;
 *   late    — still running at the deadline: Keep waiting FOLLOWS this job (never a second POST).
 */
export type BuildOutcome =
  | { kind: 'done'; resumeData?: any }
  | { kind: 'refused'; reason: BuildRefusal; message: string }
  | { kind: 'failed'; message: string; retrySame: boolean }
  | { kind: 'late'; jobId: string };

/** A fresh id per tap on Build. Reused ONLY by a Try again after a POST that got no answer. */
export const newWizardBuildId = () => `wz-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * The text a wizard build sends. Built from the CV → the sentence that says so ALWAYS goes, with any notes in front of
 * it: the server wants twenty characters of text, and an optional note like "PM roles" sent ALONE was refused as "Please
 * provide more detail about your experience" although the CV held all of it (review, 2026-09-19). Typed out → the notes.
 */
export function wizardBuildText(notes: string, fromCv: boolean, fullName?: string): string {
  const typed = String(notes || '').trim();
  if (!fromCv) return typed;
  const ask = `Please build my resume from the CV I uploaded${fullName && fullName.trim() ? ` for ${fullName.trim()}` : ''}.`;
  return typed ? `${typed}\n\n${ask}` : ask;
}

/** Follow one build job to its end (or to the deadline, or until the screen is gone). Never throws. */
export async function joinBuild(jobId: string, onStage?: (s: GenStage) => void, isLeft?: () => boolean): Promise<BuildOutcome> {
  const t = await token();
  if (!t) return { kind: 'failed', message: 'Please sign in again.', retrySame: false };
  const until = Date.now() + DEADLINE_MS;
  let missing = 0;   // consecutive 404s: the job row is gone — nothing left to follow
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    // The screen was left: the server keeps going, and the wizard rejoins this job when it is opened again.
    if (isLeft && isLeft()) return { kind: 'late', jobId };
    let j: any = null;
    try {
      const r = await fetch(`${API_BASE}/job-status/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${t}` } });
      if (r.status === 404) { if (++missing >= 2) break; continue; }
      missing = 0;
      j = await r.json().catch(() => null);
    } catch { /* one dropped poll is not a failure; the next one will answer */ }
    if (!j) continue;

    // ⚠️ `data` carries TWO different things. While the job runs it is the progress envelope the
    // server writes through updateJobPartialResult; when it completes, completeJob overwrites it
    // with the real payload. `resumeData` is what tells them apart.
    if (j.data && j.data.stage && !j.data.resumeData && onStage) {
      onStage({ stage: String(j.data.stage), label: String(j.data.label || ''), pct: Number(j.data.pct) || 0 });
    }
    if (j.status === 'completed') {
      const d = j.data || {};
      if (d.resumeData) return { kind: 'done', resumeData: d.resumeData };
      return { kind: 'failed', message: d.error || 'The resume finished but came back empty. Please try again.', retrySame: false };
    }
    if (j.status === 'failed') {
      // asJob keeps a refusal's reason on the job; the server already made every message readable.
      if (REFUSALS.includes(j.reason)) return { kind: 'refused', reason: j.reason, message: j.error || 'We could not build your resume.' };
      return { kind: 'failed', message: j.error || 'We could not finish building your resume. Please try again.', retrySame: false };
    }
  }
  if (missing >= 2) return { kind: 'failed', message: 'We lost track of that build. Please try again.', retrySame: false };
  return { kind: 'late', jobId };
}

/**
 * Before a Try again that would re-POST: has the build that got no answer already landed, or is it running?
 * { done } | { jobId } (rejoin it) | null (nothing — POST the same id again).
 */
export async function buildOnServer(): Promise<{ done: true } | { jobId: string } | null> {
  const s = await fetchProfileSnapshot();
  const w = s && s.setup.wizard;
  if (!w) return null;
  if (w.state === 'finished') return { done: true };
  if (w.build && w.build.status === 'running') return { jobId: w.build.jobId };
  return null;
}

/**
 * ⚠️ "WOULD A BUILD BE PAID FOR RIGHT NOW?" — A READ. NOTHING IS SPENT, BOUND OR STARTED (2026-09-20).
 *
 * The owner's report: the wizard refused his build with "The free plan on this device was already used by another
 * account…", he subscribed, came back — and the same refusal was still on the screen, with "See plans" as its only
 * button. The refusal was correct WHEN IT WAS MADE and the server was right all along (entitlements.canConsumeMany
 * reads the subscription FIRST, so a plan always beats a claimed device); what was stale was the sentence in the
 * screen, which nothing ever re-read.
 *
 * This asks the server the same question the build asks, so the wizard can clear that sentence the moment it stops
 * being true. POST /resume-builder/generation-gate with no employer and no regenerate is generateAI's own decision
 * order (cache → regen → canConsumeMany → pass) run as a DRY RUN: it reserves nothing, binds no pass and charges
 * nothing (see resumeBuilderController.generationGate). It is asked rather than /subscription/status because
 * `remaining` is not the whole answer — a one-time pass or an admin grant covers a build that no count describes,
 * and the app must never promise something the build would then refuse.
 *
 * x-device-id rides along exactly as generateResume sends it: the free allowance is one per DEVICE, and an answer
 * computed against a different device would be a different answer. `null` = we could not read it (offline, an older
 * server): the caller must then leave whatever it was showing alone.
 */
export async function checkBuildCovered(): Promise<{ covered: boolean; reason: string | null } | null> {
  const t = await token();
  if (!t) return null;
  const headers = { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...WIZARD_HEADER, ...(await deviceHeaders()) };
  // ⚠️ IT GIVES UP AFTER 15 s (review, 2026-09-20), the same budget as every other read here
  // (employerHomeService.getJson). A caller holds "a re-check is going" for the life of this request and skips
  // every other trigger while it is held, so a socket iOS would leave open for a minute (NSURLSession's default)
  // would keep the stale refusal on screen for that whole minute with no way forward — the very bug this
  // function exists to fix. An abort lands in the catch below as `null`: "we could not read it", nothing cleared.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`${API_BASE}/resume-builder/generation-gate`, { method: 'POST', headers, body: JSON.stringify({}), signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || typeof j.covered !== 'boolean') return null;
    return { covered: j.covered === true, reason: typeof j.reason === 'string' ? j.reason : null };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export async function generateResume(
  input: {
    name: string; email: string; phone: string; location: string; rawText: string;
    includeUploadedResume?: boolean; fromUpload?: boolean;
  },
  buildId: string,
  onStage?: (s: GenStage) => void,
  isLeft?: () => boolean,
): Promise<BuildOutcome> {
  const t = await token();
  if (!t) return { kind: 'failed', message: 'Please sign in again.', retrySame: false };
  // ⚠️ x-device-id, like every Home generation (employerHomeService.deviceHeaders): the free 3 + 3 are ONE PER DEVICE,
  // and the wizard is the first thing a brand-new account spends a unit on — before this launch may have recorded
  // its device at all (review, 2026-09-19).
  const headers = { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...WIZARD_HEADER, ...(await deviceHeaders()) };

  let started: any;
  let status = 0;
  try {
    const r = await fetch(`${API_BASE}/resume-builder/generate-ai`, {
      method: 'POST',
      headers,
      // source 'onboarding': the server joins a wizard build that is still running instead of starting another,
      // and only a build with it finishes the wizard. fromUpload: without the read CV there is nothing to write from.
      body: JSON.stringify({ ...input, __async: true, clientBuildId: buildId, source: 'onboarding' }),
    });
    status = r.status;
    started = await r.json().catch(() => ({}));
  } catch {
    return { kind: 'failed', message: 'We could not reach the server. Please check your connection and try again.', retrySame: true };
  }
  if (status === 402) return { kind: 'refused', reason: 'quota_exhausted', message: started.error || 'You have used your plan allowance.' };
  if (status === 403) return { kind: 'refused', reason: 'regen_limit', message: started.error || 'Your free plan includes one rebuild.' };
  if (status >= 400 && REFUSALS.includes(started.reason)) return { kind: 'refused', reason: started.reason, message: started.error || 'We could not build your resume.' };
  if (status >= 400) return { kind: 'failed', message: started.error || 'We could not start building your resume.', retrySame: false };

  // ⚠️ asJob falls back to running SYNCHRONOUSLY when it cannot create a job row, and then this is
  // the finished resume rather than a job id. Handle both or that fallback looks like a failure.
  if (started && started.resumeData) return { kind: 'done', resumeData: started.resumeData };
  const jobId = started && started.jobId;
  if (!jobId) return { kind: 'failed', message: 'We could not start building your resume.', retrySame: false };
  return joinBuild(String(jobId), onStage, isLeft);
}
