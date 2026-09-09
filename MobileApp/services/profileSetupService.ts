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
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';

export type ProfileSetup = {
  /** phone + address + date of birth are present. */
  profile: boolean;
  resume: boolean;
  photo: boolean;
  signature: boolean;
  complete: boolean;
};

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

/** What the server believes about this profile. Null when it could not be asked. */
export async function fetchProfileSnapshot(): Promise<ProfileSnapshot | null> {
  const t = await token();
  if (!t) return null;
  try {
    const r = await fetch(`${API_BASE}/users/profile`, { headers: { Authorization: `Bearer ${t}` } });
    if (!r.ok) return null;
    const j = await r.json();
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
      setup: { ...EMPTY_SETUP, ...(j.setup || {}) },
    };
  } catch { return null; }
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
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
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
async function upload(path: string, field: string, file: { uri: string; name: string; type: string }): Promise<SaveResult> {
  const t = await token();
  if (!t) return { ok: false, message: 'Please sign in again.' };
  try {
    const form = new FormData();
    // @ts-expect-error — RN's FormData takes this object form for a file part; the DOM types do not.
    form.append(field, { uri: file.uri, name: file.name, type: file.type });
    const r = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}` },   // ⚠️ never set Content-Type — the boundary is generated
      body: form,
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true } : { ok: false, message: j.error || 'That upload did not go through.' };
  } catch {
    return { ok: false, message: 'We could not reach the server. Please try again.' };
  }
}

export const uploadPhoto = (uri: string) =>
  upload('/users/profile/image', 'profileImage', { uri, name: 'profile.jpg', type: 'image/jpeg' });

export const uploadSignature = (uri: string) =>
  upload('/users/profile/signature', 'signature', { uri, name: 'signature.png', type: 'image/png' });

/**
 * ⚠️ The parse is FIRE AND FORGET. This resolves long before resume_metadata is usable, so nothing
 * may read the extracted skills or summary straight afterwards and expect them to be there.
 */
export const uploadResumeFile = (uri: string, name: string, type: string) =>
  upload('/users/profile/resume', 'resume', { uri, name: name || 'resume.pdf', type: type || 'application/pdf' });

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

export type GenerateResult =
  | { ok: true; resumeData: any }
  | { ok: false; reason?: 'quota_exhausted' | 'regen_limit'; message: string };

export async function generateResume(
  input: { name: string; email: string; phone: string; location: string; rawText: string; includeUploadedResume?: boolean },
  onStage?: (s: GenStage) => void,
): Promise<GenerateResult> {
  const t = await token();
  if (!t) return { ok: false, message: 'Please sign in again.' };
  const headers = { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' };

  let started: any;
  try {
    const r = await fetch(`${API_BASE}/resume-builder/generate-ai`, {
      method: 'POST', headers, body: JSON.stringify({ ...input, __async: true }),
    });
    started = await r.json().catch(() => ({}));
    if (r.status === 402) return { ok: false, reason: 'quota_exhausted', message: started.error || 'You have used your plan allowance.' };
    if (r.status === 403) return { ok: false, reason: 'regen_limit', message: started.error || 'Your free plan includes one rebuild.' };
    if (!r.ok) return { ok: false, message: started.error || 'We could not start building your resume.' };
  } catch {
    return { ok: false, message: 'We could not reach the server. Please try again.' };
  }

  // ⚠️ asJob falls back to running SYNCHRONOUSLY when it cannot create a job row, and then this is
  // the finished resume rather than a job id. Handle both or that fallback looks like a failure.
  if (started && started.resumeData) return { ok: true, resumeData: started.resumeData };
  const jobId = started && started.jobId;
  if (!jobId) return { ok: false, message: 'We could not start building your resume.' };

  const until = Date.now() + DEADLINE_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let j: any = null;
    try {
      const r = await fetch(`${API_BASE}/job-status/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${t}` } });
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
      if (d.resumeData) return { ok: true, resumeData: d.resumeData };
      return { ok: false, message: d.error || 'The resume finished but came back empty. Please try again.' };
    }
    if (j.status === 'failed') {
      // The server already replaced any internal error text with something a person can read.
      return { ok: false, message: j.error || 'We could not finish building your resume. Please try again.' };
    }
  }
  return { ok: false, message: 'This is taking longer than usual. Your resume may still arrive — check Home in a minute.' };
}
