// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE LETTER'S SEND PAGE — its pure rules and its four calls (2026-09-19). The page is app/(cover-letter)/send.tsx,
// opened by the Send pill on the letter preview (templates.tsx, doc mode). The server half is
// server/controllers/letterSendController.js (routes under /api/employer-docs/:id/…).
//
// THE OWNER'S ASK: "a button Send … a well designed GUI page like our customisation page to send email … auto
// generated subject, auto generated body for that employer … attachments of that cover letter … the resume …
// with our smart file upload control box … use the connected gmail or microsoft account … add email id and send".
//
// ⚠️ NOTHING HERE CHARGES BY ITSELF. Opening the page reads a draft (no AI, no render, no charge); the email body is a
// free AI call on the server with a template fallback; the ONE call that can cost anything is sendLetterEmail, and the
// server charges it exactly like the page's Download — only after Gmail / Outlook accepted the message.
// ⚠️ A 404 WITH NO REASON IS AN OLDER SERVER, NOT A DELETED LETTER. Express answers a route it does not have with an
// HTML 404; reading that as "your letter is gone" would send the user off to rebuild a letter they still have. It is
// 'server_outdated' — the page then offers the Download (the saysGone rule of services/employerDocs).
// ⚠️ ONE SEND, EVEN IF THE ANSWER IS LOST. A Send runs as a server job (__async) keyed by clientBuildId: a retry after
// a dropped connection joins the SAME job and reads its real outcome instead of mailing the recruiter twice. A retry
// after a DEFINITE failure must use a new id — the server would otherwise hand back the failed job (send.tsx doSend).
// ⚠️ …AND ONLY FOR THE SAME MESSAGE (review, 2026-09-19). The kept id travels with the message's fingerprint
// (PendingSend, sendFingerprint): an edited To / subject / message / attachment gets a NEW id — after asking, because
// the unknown one may have gone — or the server hands back the old job and the page reports it as the new message.
// The pending Send is kept on the phone, so leaving the page mid-send and coming back polls that job instead of
// sending anything.
// ⚠️ 'unknown_outcome' (the server's own "the connection dropped after the message was handed over") and a job that is
// gone never say "nothing was sent": they send the user to their Sent folder, and the next Send asks first.
// ⚠️ EACH ATTACHMENT CARRIES ITS OWN PAGE SIZE (2026-09-20, the owner: "In the attachment section there should be
// option of selecting A4 selection and One page selection too… for cover letter keep One page as default and then for
// Resume keep A4 as default"). PageSize / DEFAULT_SIZES / SIZES_KEY below; the size lives INSIDE LetterAttachment and
// ResumeAttachment so it reaches the server through letterWire / resumeWire — and so sendFingerprint follows it.
// ⚠️ TWO KINDS OF LETTER, ONE PAGE (2026-09-20). The preview also opens WITHOUT a saved document — the Job Hub's, the
// Review screen's and the old Home's letters (templates.tsx's classic picker) — with the same Download, so it has the
// same Send. Such a letter has no id to name: the preview hands the letter itself to the Send page (CLASSIC_SEND_KEY)
// and every call carries it (LetterRef; the server's /classic/… routes). The phone keys its draft and its pending Send
// by the letter's content (classicLetterKey), exactly where a saved letter uses its id.
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';
import { storeEnvHeader } from './storeEnv';
import type { DownloadState } from './downloadPassService';

export const MAX_RECIPIENTS = 5;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const SUBJECT_MAX = 300;
export const BODY_MAX = 10000;

export type MailProvider = 'google' | 'microsoft';
/**
 * The mailbox the message goes from. ⚠️ `ready` AND `canSend` ARE DIFFERENT QUESTIONS (2026-09-20, the owner on build
 * 210: "I logged in with gmail account successfully and then when i clicked send then it showed me an error.. that
 * reconnect gmail"). `ready` is "is an account connected?"; `canSend` is "did that account actually allow us to send
 * mail?" — Google hands back both tokens with "Send email on your behalf" left unticked, so the two can disagree, and
 * the card used to show a green "Connected" over an account that would refuse the message being written.
 * An older server does not answer `canSend`; parseDraft reads that as true, so nothing changes for anyone else.
 */
export type MailAccount = { provider: MailProvider | null; ready: boolean; canSend: boolean; reconnect: boolean; address: string | null };
export type Contact = { email: string; name?: string; role?: string };
export type ResumeOptionId = 'tailored' | 'builder' | 'uploaded';
export type ResumeOption = {
  id: ResumeOptionId; label: string; detail: string; gated: boolean;
  docId?: number; template?: string; mode?: string | null; bytes?: number;
};
/**
 * A CLASSIC letter (see the header): what the classic preview's Download already sends, plus the posting when the opener
 * knew it (the Job Hub: jobUrl → its known contact prefilled and the job marked Applied) and the design's name to show.
 */
export type ClassicLetter = {
  coverLetterHtml: string; companyName?: string; companyAddress?: string; employer?: string | null;
  jobUrl?: string; position?: string; designName?: string;
};
/** Which letter a call is about: a saved Home letter by its id, or a classic letter itself. */
export type LetterRef = number | { classic: ClassicLetter };
/** Where the classic preview leaves its letter for the Send page it opens (templates.tsx → send.tsx). */
export const CLASSIC_SEND_KEY = 'letterSendClassic:v1';
/**
 * The server's cap on a classic letter's text (letterSendController CLASSIC_HTML_MAX — keep the two the same). It is a
 * letter's size, not a page's: the longest letter in production is 7,373 characters (2026-09-20), and every request runs
 * this text through the server's repair on its one thread.
 */
export const CLASSIC_HTML_MAX = 20000;

export type EmailDraft = {
  letter: { docId: number; classic?: boolean; employer: string; companyName: string; position: string; jobUrl: string; updatedAt: string | null };
  subject: string;
  body: string;
  /** The standard note in both shapes — the page shows the one that matches the attachments (see bodyFor). */
  bodies: { withResume: string; letterOnly: string };
  sender: { name: string; email: string };
  recipients: { prefill: Contact[]; suggestions: Contact[] };
  resume: { options: ResumeOption[]; default: ResumeOptionId | null };
  account: MailAccount;
};
/** A file picked on the phone and held by the server for this send (POST /:id/send-files). */
export type PickedFile = { fileId: string; name: string; size: number; mime: string };
/**
 * The page layout of something WE render — the same two the Download sheets offer ("One Page" / "A4 Pages",
 * templates.tsx's SegBtn) and the same two words every renderer takes (server/utils/coverLetterRenderer normMode,
 * resumeBuilderController renderResumeDocPdf). ⚠️ 2026-09-20: it belongs to the ATTACHMENT, not to the page — the
 * letter and the résumé have different defaults and can be changed apart (the owner's ask), and only a size that
 * travels INSIDE letterWire / resumeWire reaches sendFingerprint (see there).
 */
export type PageSize = 'onepage' | 'a4';
export type LetterAttachment = { source: 'doc'; size: PageSize } | { source: 'file'; file: PickedFile };
export type ResumeAttachment =
  | { source: 'none' }
  | { source: ResumeOptionId; option: ResumeOption; size: PageSize }
  | { source: 'file'; file: PickedFile };
export type SendResult = { provider: MailProvider | null; from: string | null; to: string[]; charged: boolean; sentAt: string | null };

/** Every reason the page can be told — each has a sentence in reasonMessage (test-letter-send pins that). */
export const SEND_REASONS = [
  'gone', 'no_letter', 'server_outdated', 'network', 'lost', 'failed',
  'no_mail_account', 'reconnect', 'scope',
  'bad_recipients', 'bad_recipient', 'bad_subject', 'bad_body', 'bad_request', 'too_many',
  'paid_required', 'quota_exhausted',
  'resume_gone', 'file_gone', 'bad_file', 'render_failed', 'too_big',
  'provider_busy', 'send_failed', 'unknown_outcome',
] as const;
export type SendReason = typeof SEND_REASONS[number];
const KNOWN = new Set<string>(SEND_REASONS);

/* ── PURE RULES ───────────────────────────────────────────────────────────────────────────────────── */

// The server's grammar (services/letterEmail EMAIL_RE), so the page never shows green for an address it will refuse.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;

export function isEmail(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s || s.length > 254) return false;
  const at = s.lastIndexOf('@');
  if (at < 1 || at > 64 || s.includes('..')) return false;
  return EMAIL_RE.test(s);
}

/** What was typed or pasted → the separate addresses in it ("a@x.com, b@y.com; c@z.com" → three). */
export function splitAddresses(text: string): string[] {
  return String(text || '').split(/[\s,;]+/).map((t) => t.replace(/^<|>$/g, '').trim()).filter(Boolean);
}

/**
 * Add what was typed to the To list. Valid, new addresses are added in order; a duplicate (any case) is skipped
 * quietly; the first invalid token and the cap are said out loud and nothing past them is added.
 */
export function addRecipients(list: string[], text: string): { list: string[]; error: string | null; added: number } {
  const out = [...list];
  const seen = new Set(out.map((a) => a.toLowerCase()));
  let added = 0;
  for (const token of splitAddresses(text)) {
    if (!isEmail(token)) return { list: out, error: `“${token.slice(0, 60)}” is not a valid email address.`, added };
    if (seen.has(token.toLowerCase())) continue;
    if (out.length >= MAX_RECIPIENTS) return { list: out, error: `One message can go to at most ${MAX_RECIPIENTS} addresses.`, added };
    out.push(token);
    seen.add(token.toLowerCase());
    added++;
  }
  return { list: out, error: null, added };
}

export function removeRecipient(list: string[], email: string): string[] {
  const k = String(email || '').toLowerCase();
  return list.filter((a) => a.toLowerCase() !== k);
}

/**
 * May the Send button be pressed — and if not, the one line that says why.
 * `typed` is what sits in the To field, not yet a chip: Send commits it (doSend), so an address on screen counts —
 * a dimmed button beside a valid address the user can see was a dead end. An invalid one is reported by that commit.
 * `uploading`: a file from the phone is still on its way — a Send now would go out with what the row held BEFORE it.
 * `writing`: the FIRST note from the letter is still being written (POST /email-body takes seconds). ⚠️ IT IS LAST,
 * AND IT DISABLES THE BUTTON (owner, 2026-09-20: "if the message is loading then please show loader"). Everything the
 * user must DO is said first; once the page is otherwise ready the bar simply says what it is waiting for, so nobody
 * can tap Send and be answered by a modal about a message they have not seen. The Alert in send.tsx's doSend stays as
 * the guard for the taps that do not come from the button (the failure card's Try again / Send again).
 * ⚠️ ONLY THE FIRST ONE (review, 2026-09-20). send.tsx passes this while no message has been SEEN yet — never during a
 * Rewrite, which replaces a note the user has read: taking the button away there would hold a perfectly sendable page
 * hostage to an AI call that can run 30 s and then fail silently. A Send during a Rewrite drops the late answer.
 */
export function canSend(s: {
  to: string[]; subject: string; body: string; account: MailAccount | null; busy: boolean; hasLetter: boolean;
  typed?: string; uploading?: boolean; writing?: boolean;
}): { ok: boolean; why: string | null } {
  if (s.busy) return { ok: false, why: null };
  if (s.uploading) return { ok: false, why: 'Waiting for your file to finish uploading…' };
  if (!s.account || !s.account.ready) return { ok: false, why: 'Connect Gmail or Outlook to send.' };
  // ⚠️ Said BEFORE the message is written, not after it is tapped out and Send is pressed (2026-09-20). A connected
  // account that was never allowed to send is a decided refusal; the card beside this line offers the one fix.
  if (s.account.canSend === false) {
    return { ok: false, why: `${s.account.provider === 'microsoft' ? 'Outlook has' : 'Gmail has'} not been allowed to send mail yet.` };
  }
  if (!s.to.length && !(s.typed && s.typed.trim())) return { ok: false, why: 'Add at least one email address.' };
  if (s.to.length > MAX_RECIPIENTS) return { ok: false, why: `At most ${MAX_RECIPIENTS} addresses.` };
  if (!s.subject.trim()) return { ok: false, why: 'Add a subject.' };
  if (s.subject.length > SUBJECT_MAX) return { ok: false, why: `The subject is longer than ${SUBJECT_MAX} characters.` };
  if (!s.body.trim()) return { ok: false, why: 'Add a message.' };
  if (s.body.length > BODY_MAX) return { ok: false, why: 'The message is too long.' };
  if (!s.hasLetter) return { ok: false, why: 'Attach your cover letter.' };
  if (s.writing) return { ok: false, why: 'Still writing your message from the letter…' };
  return { ok: true, why: null };
}

/* ── THE PAGE SIZE OF EACH ATTACHMENT ─────────────────────────────────────────────────────────────── */

/**
 * ⚠️ THE SEND PAGE'S OWN DEFAULTS (owner, 2026-09-20): "for cover letter keep One page as default and then for Resume
 * keep A4 as default and that user can change it". They deliberately OVERRIDE the `mode` the preview hands over in the
 * route: the preview seeds its own toggle from the document's stored design.mode, which is 'a4' for the owner's own
 * letter — so seeding from the route would default the letter to A4 pages, the opposite of what he asked for. What
 * overrides these is only the choice he made last (SIZES_KEY), never the previous screen.
 */
export const DEFAULT_SIZES: { letter: PageSize; resume: PageSize } = { letter: 'onepage', resume: 'a4' };
/** Where the last choice is kept on the phone — ONE preference for every letter, so the next Send starts from it. */
export const SIZES_KEY = 'letterSendSizes:v1';
export type PageSizes = { letter: PageSize; resume: PageSize };

/** What was stored → the two sizes. Absent, unreadable or junk → the defaults above (never a half-read pair). */
export function parseSizes(raw: unknown): PageSizes {
  let v: any;
  try { v = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return { ...DEFAULT_SIZES }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...DEFAULT_SIZES };
  const one = (x: any, d: PageSize): PageSize => (x === 'a4' || x === 'onepage' ? x : d);
  return { letter: one(v.letter, DEFAULT_SIZES.letter), resume: one(v.resume, DEFAULT_SIZES.resume) };
}

/** A layout's name — the gallery's own words (templates.tsx's download sheet), so the two pages read as one product. */
export function sizeText(s: PageSize): string {
  return s === 'a4' ? 'A4 Pages' : 'One Page';
}

/**
 * ⚠️ EVERY LETTER DESIGN CHOOSES ITS PAGE LAYOUT — THERE IS NO EXCEPTION ANY MORE (2026-09-20). "Original (Branded)"
 * (id 'standard') used to be one: it is flagged `generic` (coverLetterTemplates.js) and its PDF came from the original
 * PDFKit generator, which only knows how to build a single page sized to the letter's content, so both screens greyed
 * A4 out for it and said why (`fixedLetterSize`, now gone). That is exactly the half of the owner's sentence — "and
 * that user can change it" — that his OWN letter (doc 17 ranks 'standard' first) would have met with a dead button.
 * The server now renders this design's A4 from its own HTML twin instead (coverLetterController renderLetterPdfFile's
 * `genericA4`), so the choice is real on every design and this screen has nothing left to special-case.
 */

/** The résumé the page starts with: the server's order is tailored > Builder > uploaded; none when there is none. */
export function defaultResumeChoice(options: ResumeOption[], def: ResumeOptionId | null, size: PageSize = DEFAULT_SIZES.resume): ResumeAttachment {
  const list = Array.isArray(options) ? options : [];
  const pick = list.find((o) => o.id === def) || list[0];
  return pick ? { source: pick.id, option: pick, size } : { source: 'none' };
}

/** Is this attachment one WE render (so the Download rule — a plan or a pass — applies to it)? */
export function isGated(a: LetterAttachment | ResumeAttachment): boolean {
  if (a.source === 'doc') return true;
  if (a.source === 'tailored' || a.source === 'builder') return true;
  return false;
}

/**
 * The body the server wants for an attachment choice — and the page size WE render it in, on the choice itself
 * (letterSendController letterChoiceOf / resumeChoiceOf read `mode` there). ⚠️ THE SIZE MUST TRAVEL HERE, not beside
 * the choices: sendFingerprint hashes these two objects, so a changed size gets a NEW Send id instead of joining the
 * pending job that already rendered and mailed the old layout (see sendFingerprint). A file from the phone and the
 * uploaded CV carry none — they are the user's own bytes, attached unchanged.
 */
export function letterWire(a: LetterAttachment): { source: 'doc'; mode: PageSize } | { source: 'file'; fileId: string } {
  return a.source === 'file' ? { source: 'file', fileId: a.file.fileId } : { source: 'doc', mode: a.size };
}
export function resumeWire(a: ResumeAttachment): any {
  if (a.source === 'file') return { source: 'file', fileId: a.file.fileId };
  if (a.source === 'tailored') return { source: 'tailored', docId: a.option.docId, mode: a.size };
  if (a.source === 'builder') return { source: 'builder', mode: a.size };
  return { source: a.source };
}

export function providerName(p: MailProvider | null | undefined): string {
  return p === 'microsoft' ? 'Outlook' : p === 'google' ? 'Gmail' : 'your mail account';
}

export function sizeLabel(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

const NOTHING = 'Nothing was sent and nothing was charged.';

/**
 * Every reason → a title and a sentence: what went wrong, what to do, and — where it is TRUE — that nothing was sent
 * or charged. ⚠️ 'network' and 'lost' do NOT say that: the request may have reached the server, so the message may
 * have gone; they send the user to their Sent folder before any retry (and a retry joins the same job anyway).
 */
export function reasonMessage(reason: SendReason | string | null | undefined, ctx: { provider?: MailProvider | null; detail?: string | null } = {}): { title: string; message: string } {
  const who = providerName(ctx.provider);
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  const detail = ctx.detail ? String(ctx.detail).trim() : '';
  switch (reason) {
    case 'gone': return { title: 'This letter is gone', message: 'This cover letter is no longer saved. Go back to Home to see your current one.' };
    // A classic letter the page never received (or one the server could not read) — nothing was deleted, nothing sent.
    case 'no_letter': return { title: 'No letter to send', message: `We could not find the cover letter to send. Go back to your letter and tap Send again. ${NOTHING}` };
    case 'server_outdated': return { title: 'Sending is not available yet', message: 'Sending from the app needs a server update that is not live yet. Download the PDF on the previous page and attach it in your mail app for now.' };
    case 'network': return { title: 'No connection', message: 'We could not reach the server. Check your connection. If you had already tapped Send, look in your Sent folder before trying again.' };
    case 'lost': return { title: 'Still checking', message: 'We lost track of the send. Look in your Sent folder — if it is not there, tap Send again (it will not go out twice).' };
    case 'no_mail_account': return { title: 'Connect your mailbox', message: `Your application is sent from your own Gmail or Outlook, so replies come straight to you. Connect one to send. ${NOTHING}` };
    case 'reconnect': return { title: `Reconnect ${who}`, message: `${Who} needs you to sign in again. Tap Reconnect, then send. ${NOTHING}` };
    // ⚠️ NOT "sign in again" (2026-09-20). The account IS signed in; only the send permission is missing, and the
    // Google screen that grants it shows it as a checkbox that starts unticked — so the message names the checkbox.
    case 'scope': return {
      title: 'Allow sending',
      message: ctx.provider === 'microsoft'
        ? `${Who} is connected, but it did not allow CVApplyr to send mail. Tap Allow sending and accept the “Send mail as you” permission. ${NOTHING}`
        : `${Who} is connected, but you did not allow CVApplyr to send mail. Tap Allow sending and tick “Send email on your behalf”. ${NOTHING}`,
    };
    case 'bad_recipients': return { title: 'Check the addresses', message: `${detail || 'One of the email addresses is not valid.'} ${NOTHING}` };
    case 'bad_recipient': return { title: 'Address refused', message: `${Who} refused one of the addresses. Check them and try again. ${NOTHING}` };
    case 'bad_subject': return { title: 'Add a subject', message: `The subject is empty or longer than ${SUBJECT_MAX} characters. ${NOTHING}` };
    case 'bad_body': return { title: 'Add a message', message: `The message is empty or too long. ${NOTHING}` };
    case 'bad_request': return { title: 'Could not send', message: `The attachments could not be read. Pick them again and send. ${NOTHING}` };
    case 'too_many': return { title: 'Slow down a little', message: `You have sent a lot of messages in the last hour. Please wait a few minutes. ${NOTHING}` };
    case 'paid_required': return { title: 'Part of the paid plans', message: `Attaching your cover letter or tailored résumé as a PDF works like downloading it — it needs a plan or a one-employer pass. ${NOTHING}` };
    case 'quota_exhausted': return { title: 'No downloads left', message: `Your plan has no downloads left this month for these attachments. ${NOTHING}` };
    case 'resume_gone': return { title: 'Résumé not found', message: `That résumé is no longer available. Pick another one in Attachments. ${NOTHING}` };
    case 'file_gone': return { title: 'Pick the file again', message: `The file you chose has expired (files are kept for 30 minutes). Choose it again. ${NOTHING}` };
    case 'bad_file': return { title: 'That file cannot be attached', message: 'Only PDF or Word files (.pdf, .doc, .docx) up to 5 MB can be attached.' };
    case 'render_failed': return { title: 'Could not make the PDF', message: `We could not make the PDF of your document. Try again, or pick another design. ${NOTHING}` };
    case 'too_big': return { title: 'Attachments too large', message: `${detail || `The attachments are too large for ${who}.`} Remove or replace a file and try again.` };
    case 'provider_busy': return { title: `${Who} is busy`, message: `${Who} did not answer in time. Try again in a minute. ${NOTHING}` };
    case 'send_failed': return { title: 'Not sent', message: `${Who} did not accept the message. Try again in a moment. ${NOTHING}` };
    // ⚠️ Like 'network' / 'lost', NOT "nothing was sent": the connection dropped after the message was handed over.
    case 'unknown_outcome': return { title: 'Could not confirm the send', message: `We could not confirm whether ${who} sent your message. Look in your Sent folder before sending again — if it is there, it reached the recruiter. Nothing was charged.` };
    default: return { title: 'Something went wrong', message: `${detail || 'Please try again.'} ${NOTHING}` };
  }
}

/**
 * An answer → the reason it failed (null = it did not fail). A 404 is 'gone' ONLY when the server says so; without a
 * JSON reason it is an older server that lacks the route (see the header).
 */
export function classify(status: number, json: any): SendReason | null {
  if (status >= 200 && status < 300) return null;
  const reason = json && typeof json.reason === 'string' ? json.reason : '';
  if (status === 404) {
    if (reason === 'gone' || reason === 'payload_gone' || reason === 'doc_gone') return 'gone';
    return 'server_outdated';
  }
  if (KNOWN.has(reason)) return reason as SendReason;
  if (status === 403) return 'paid_required';
  if (status === 413) return 'too_big';
  if (status === 429) return 'too_many';
  return 'failed';
}

/**
 * Where a draft of this letter is kept on the phone — one per letter VERSION, so an edited letter starts fresh.
 * `letter` is a saved letter's id, or a classic letter's key (classicLetterKey — its content IS its version).
 */
export function draftKey(letter: number | string, updatedAt: string | null | undefined): string {
  return `letterSendDraft:v1:${letter}:${updatedAt || ''}`;
}

/** FNV-1a ×2 over a string — a fingerprint, not a secret: it only has to tell two different inputs apart. */
function fingerprintOf(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}.${s.length}`;
}

const cap = (v: unknown, n: number): string => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/**
 * What the classic preview left for the Send page → a ClassicLetter, or null (nothing there, unreadable, no text, or
 * longer than the server takes — a Send page that would only be refused says so up front instead).
 */
export function parseClassicLetter(raw: unknown): ClassicLetter | null {
  let c: any;
  try { c = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const html = typeof c.coverLetterHtml === 'string' ? c.coverLetterHtml : '';
  if (!html.trim() || html.length > CLASSIC_HTML_MAX) return null;
  const jobUrl = cap(c.jobUrl, 2000);
  return {
    coverLetterHtml: html,
    companyName: cap(c.companyName, 160) || undefined,
    companyAddress: cap(c.companyAddress, 400) || undefined,
    employer: cap(c.employer, 160) || null,
    jobUrl: /^https?:\/\/\S+$/i.test(jobUrl) ? jobUrl : undefined,
    position: cap(c.position, 160) || undefined,
    designName: cap(c.designName, 80) || undefined,
  };
}

/** A classic letter's VERSION key on the phone (its draft): its content — the same letter, the same key. */
export function classicLetterKey(c: ClassicLetter): string {
  return `c-${fingerprintOf(JSON.stringify([c.coverLetterHtml, c.companyName || '', c.companyAddress || '', c.employer || '', c.jobUrl || '', c.position || '']))}`;
}

/** A LetterRef's key on the phone: a saved letter's id, or the classic letter's content key. */
export function letterKeyOf(ref: LetterRef): string {
  return typeof ref === 'number' ? String(ref) : classicLetterKey(ref.classic);
}

/**
 * A classic letter's IDENTITY key — what it is FOR, not what it says: the posting it was written for (the Job Hub always
 * passes jobUrl), else the employer, else its content (a letter with neither).
 * ⚠️ WHY IT IS NOT THE CONTENT KEY (review, 2026-09-20). A pending Send is kept per LETTER, not per version (pendingKey),
 * because an edited letter can still have one out — but a classic letter's content IS its version, so regenerating the
 * Job Hub's letter hid an unresolved Send: the "Your last Send may have gone out" prompt never appeared and a second
 * message went to the recruiter with no warning. Keyed by the posting, the same posting's next letter finds it.
 */
export function classicIdentityKey(c: ClassicLetter): string {
  const url = typeof c.jobUrl === 'string' ? c.jobUrl.trim() : '';
  if (url) return `cj-${fingerprintOf(url.toLowerCase())}`;
  const employer = (c.employer || c.companyName || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (employer) return `ce-${fingerprintOf(employer)}`;
  return classicLetterKey(c);
}

/** Which letter a PENDING Send belongs to: a saved letter's id, or the classic letter's identity (not its version). */
export function pendingLetterKeyOf(ref: LetterRef): string {
  return typeof ref === 'number' ? String(ref) : classicIdentityKey(ref.classic);
}

/** What the server reads of a classic letter — never the design name (a label for this page only). */
function classicWire(c: ClassicLetter) {
  return {
    coverLetterHtml: c.coverLetterHtml, companyName: c.companyName || '', companyAddress: c.companyAddress || '',
    employer: c.employer || '', jobUrl: c.jobUrl || '', position: c.position || '',
  };
}

/** A call's path: /employer-docs/:id/<tail> for a saved letter, /employer-docs/classic/<tail> for a classic one. */
function pathOf(ref: LetterRef, tail: string): string {
  return typeof ref === 'number' ? `/employer-docs/${ref}/${tail}` : `/employer-docs/classic/${tail}`;
}
/** What a call's body adds for its letter: nothing for a saved one (the server reads it by id), the letter for a classic one. */
function letterBodyOf(ref: LetterRef): { classic?: ReturnType<typeof classicWire> } {
  return typeof ref === 'number' ? {} : { classic: classicWire(ref.classic) };
}

/** A random id for one Send (asJob dedupes on it for 15 minutes). */
export function newClientBuildId(): string {
  let s = 'ls-';
  for (let i = 0; i < 24; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)];
  return s;
}

/**
 * Does this message tell the reader a résumé / CV is attached? The server's rule (services/letterEmail
 * RESUME_ATTACHED_RE), so the page can ask before a message that says so goes out with no résumé on it.
 * ⚠️ No \b next to "é" — JS word boundaries are ASCII.
 */
const RESUME_ATTACHED_RE = /(?:^|[^a-z])(?:r[ée]sum[ée]s?|cv|curriculum vitae)(?:[^a-z]|$)[^.!?\n]{0,60}(?:attached|enclosed)|(?:attached|enclosed|attaching)[^.!?\n]{0,60}(?:^|[^a-z])(?:r[ée]sum[ée]s?|cv|curriculum vitae)(?:[^a-z]|$)/i;
export function saysResumeAttached(text: string | null | undefined): boolean {
  return RESUME_ATTACHED_RE.test(String(text || ''));
}

type SendRequest = {
  to: string[]; subject: string; body: string; template?: string; mode?: string;
  letter: LetterAttachment; resume: ResumeAttachment;
};

/**
 * One Send's identity: everything that decides what the recruiter receives (addresses, subject, message, design,
 * layout, both attachments). A kept clientBuildId may only be REUSED for the same fingerprint — reusing it for an
 * edited message would hand back the job that mailed the OLD one and report it as this one (send.tsx doSend).
 * FNV-1a ×2 (fingerprintOf): a fingerprint, not a secret — it only has to tell two different messages apart.
 * `letterVersion` is what the recruiter receives that the request itself does not name: a CLASSIC letter's own text
 * (classicLetterKey), which travels in the body. Its pending Send is now kept per POSTING (classicIdentityKey), so
 * without this a regenerated letter with the same message would join the job that mailed the OLD letter.
 */
export function sendFingerprint(r: SendRequest, letterVersion = ''): string {
  return fingerprintOf(JSON.stringify([
    r.to.map((a) => String(a).trim().toLowerCase()), r.subject, r.body, r.template || '', r.mode || '',
    letterWire(r.letter), resumeWire(r.resume), letterVersion,
  ]));
}

/**
 * A Send whose outcome the phone does not know yet — kept on the phone (pendingKey) from the moment it is tapped until a
 * DEFINITE answer, so leaving the page mid-send, a lost answer or a killed app cannot turn into a second email:
 *   jobId      the server job, once the 202 arrived → a reopened page POLLS it (no new request at all)
 *   ambiguous  the outcome cannot be learned any more (the server said 'unknown_outcome', the job row is gone, or the
 *              id is past the server's dedupe window with no job) → the next Send asks before going out again
 * `to` is the list THAT Send went to — what the page reports, never the one on screen now.
 */
export type PendingSend = { id: string; fp: string; to: string[]; jobId: string | null; at: number; ambiguous: boolean };

/** asJob dedupes a clientBuildId for 15 minutes; a margin under that is when an id can still JOIN its job. */
export const JOIN_WINDOW_MS = 14 * 60 * 1000;
/** A pending Send older than this is forgotten (its job's answer is long settled, one way or the other). */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Where the pending Send of this letter is kept — per LETTER, not per version: an edited letter can still have one out.
 * `letter` is a saved letter's id, or a classic letter's key (classicLetterKey).
 */
export function pendingKey(letter: number | string): string {
  return `letterSendPending:v1:${letter}`;
}

/** What was stored → a PendingSend, or null (unreadable, or older than PENDING_TTL_MS). */
export function parsePending(raw: unknown, now: number): PendingSend | null {
  let p: any;
  try { p = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id || typeof p.fp !== 'string') return null;
  const at = Number(p.at);
  if (!Number.isFinite(at) || now - at > PENDING_TTL_MS || at > now + 60 * 1000) return null;
  const jobId = typeof p.jobId === 'string' && p.jobId ? p.jobId : null;
  return {
    id: p.id, fp: p.fp, at, jobId,
    to: Array.isArray(p.to) ? p.to.filter(isEmail).slice(0, MAX_RECIPIENTS) : [],
    ambiguous: p.ambiguous === true || (!jobId && now - at > JOIN_WINDOW_MS),
  };
}

/** May a new tap re-use this pending Send's id (and so join its job)? Only for the SAME message, inside the window. */
export function canJoin(p: PendingSend | null, fp: string, now: number): boolean {
  return !!p && !p.ambiguous && p.fp === fp && now - p.at < JOIN_WINDOW_MS;
}

/**
 * The one button the error card offers for a reason — the fix the message names, never a blind "Try again" that can
 * only fail the same way (a file too large, an address the provider refused, a file of the wrong kind).
 */
export type FailureAction =
  | 'retry' | 'send_again' | 'attachments' | 'choose_again' | 'recipients' | 'subject' | 'body'
  | 'reconnect' | 'allow_sending' | 'plans' | 'back' | null;
export function failureAction(reason: SendReason | string | null | undefined): FailureAction {
  switch (reason) {
    case 'failed': case 'render_failed': case 'send_failed': case 'provider_busy': case 'network': case 'lost':
      return 'retry';
    case 'unknown_outcome': return 'send_again';
    case 'too_big': case 'bad_file': case 'bad_request': return 'attachments';
    case 'file_gone': case 'resume_gone': return 'choose_again';
    case 'bad_recipient': case 'bad_recipients': return 'recipients';
    case 'bad_subject': return 'subject';
    case 'bad_body': return 'body';
    case 'reconnect': return 'reconnect';
    // ⚠️ NOT THE SAME BUTTON (2026-09-20). 'scope' means the account IS signed in and simply was not allowed to send;
    // "Reconnect" describes the wrong problem and sends the user round the loop the owner described. Both run the same
    // OAuth screen — what changes is what the button says the user has to do when they get there.
    case 'scope': return 'allow_sending';
    case 'paid_required': case 'quota_exhausted': return 'plans';
    case 'gone': case 'no_letter': case 'server_outdated': return 'back';
    default: return null;   // no_mail_account (the mailbox card offers Connect), too_many (wait)
  }
}

/* ── TRANSPORT ────────────────────────────────────────────────────────────────────────────────────── */

async function token(): Promise<string | undefined> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    return JSON.parse(raw || '{}')?.token;
  } catch { return undefined; }
}

/**
 * One request → { status, json } or null (no token, no answer). ⚠️ API_BASE is read per call (the admin switch
 * reassigns it), and the store environment is named on the request itself: the documents are scoped by it.
 */
async function call(path: string, init: { method?: 'GET' | 'POST'; body?: any; form?: FormData; ms?: number } = {}):
  Promise<{ status: number; json: any } | null> {
  const t = await token();
  if (!t) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.ms || 30000);
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${t}`, ...(await storeEnvHeader()) };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${API_BASE}${path}`, {
      method: init.method || 'GET',
      headers,
      // ⚠️ A FormData body sets its own multipart boundary — never a Content-Type of ours on it.
      body: init.form ? (init.form as any) : init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctl.signal,
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, json: json && typeof json === 'object' ? json : {} };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

const str = (v: any): string => (typeof v === 'string' ? v : '');

function shapeDraft(j: any): EmailDraft | null {
  if (!j || !j.letter || typeof j.letter !== 'object') return null;
  const contact = (c: any): Contact | null => (c && isEmail(c.email) ? { email: String(c.email).trim(), name: str(c.name), role: str(c.role) } : null);
  const contacts = (v: any): Contact[] => (Array.isArray(v) ? v.map(contact).filter((c): c is Contact => !!c) : []);
  const opts: ResumeOption[] = (j.resume && Array.isArray(j.resume.options) ? j.resume.options : [])
    .filter((o: any) => o && (o.id === 'tailored' || o.id === 'builder' || o.id === 'uploaded'))
    .map((o: any) => ({
      id: o.id, label: str(o.label) || 'Your résumé', detail: str(o.detail), gated: o.gated === true,
      docId: Number.isInteger(Number(o.docId)) ? Number(o.docId) : undefined,
      template: str(o.template) || undefined, mode: typeof o.mode === 'string' ? o.mode : null,
      bytes: typeof o.bytes === 'number' ? o.bytes : undefined,
    }));
  const a = j.account && typeof j.account === 'object' ? j.account : {};
  const provider: MailProvider | null = a.provider === 'google' || a.provider === 'microsoft' ? a.provider : null;
  const def = j.resume && (j.resume.default === 'tailored' || j.resume.default === 'builder' || j.resume.default === 'uploaded') ? j.resume.default : null;
  const body = str(j.body).slice(0, BODY_MAX);
  const b = j.bodies && typeof j.bodies === 'object' ? j.bodies : {};
  return {
    letter: {
      docId: Number(j.letter.docId) || 0,
      classic: j.letter.classic === true,
      employer: str(j.letter.employer), companyName: str(j.letter.companyName), position: str(j.letter.position),
      jobUrl: str(j.letter.jobUrl), updatedAt: str(j.letter.updatedAt) || null,
    },
    subject: str(j.subject).slice(0, SUBJECT_MAX),
    body,
    bodies: { withResume: str(b.withResume).slice(0, BODY_MAX) || body, letterOnly: str(b.letterOnly).slice(0, BODY_MAX) || body },
    sender: { name: str(j.sender && j.sender.name), email: str(j.sender && j.sender.email) },
    recipients: { prefill: contacts(j.recipients && j.recipients.prefill), suggestions: contacts(j.recipients && j.recipients.suggestions) },
    resume: { options: opts, default: def },
    // `canSend` absent → true: an older server never answers it, and a mailbox that has always worked must not be
    // blocked by a field it cannot send (see MailAccount).
    account: { provider, ready: a.ready === true, canSend: a.canSend !== false, reconnect: a.reconnect === true, address: isEmail(a.address) ? String(a.address).trim() : null },
  };
}

type Fail = { ok: false; reason: SendReason; message?: string; provider?: MailProvider | null };

function failOf(status: number, json: any): Fail {
  const reason = classify(status, json) || 'failed';
  return { ok: false, reason, message: str(json && json.error) || undefined, provider: json && (json.provider === 'google' || json.provider === 'microsoft') ? json.provider : undefined };
}

/**
 * GET /:id/email-draft — what the page opens with. Read-only on the server. A classic letter POSTs /classic/email-draft
 * (the letter travels in the body) — still read-only: no AI, no render, no charge.
 */
export async function fetchEmailDraft(ref: LetterRef): Promise<{ ok: true; draft: EmailDraft } | Fail> {
  const r = typeof ref === 'number'
    ? await call(pathOf(ref, 'email-draft'))
    : await call(pathOf(ref, 'email-draft'), { method: 'POST', body: letterBodyOf(ref) });
  if (!r) return { ok: false, reason: 'network' };
  if (r.status !== 200 || r.json.success === false) return failOf(r.status, r.json);
  const draft = shapeDraft(r.json);
  return draft ? { ok: true, draft } : { ok: false, reason: 'failed' };
}

/**
 * POST /:id/email-body — a short AI body from the letter (free; the server falls back to its template itself).
 * `withResume` is what the message will carry: false = the cover letter only, and the note must not claim a résumé.
 */
export async function fetchEmailBody(ref: LetterRef, withResume = true): Promise<{ ok: true; body: string; source: 'ai' | 'template' } | Fail> {
  const r = await call(pathOf(ref, 'email-body'), { method: 'POST', body: { resume: withResume, ...letterBodyOf(ref) }, ms: 30000 });
  if (!r) return { ok: false, reason: 'network' };
  if (r.status !== 200 || typeof r.json.body !== 'string' || !r.json.body.trim()) return failOf(r.status, r.json);
  return { ok: true, body: r.json.body.slice(0, BODY_MAX), source: r.json.source === 'ai' ? 'ai' : 'template' };
}

/**
 * GET /downloads/state — the page's padlock. ⚠️ NULL WHEN IT COULD NOT BE READ, never "locked": downloadPassService's
 * fetchDownloadState fails CLOSED (right for a Download button, which asks the server anyway), but here a locked
 * answer opens the paywall INSTEAD of asking the server — so a flaky read showed a subscriber a pass they did not
 * need, with no way past it. Unknown = no padlock; the Send asks the server, and its 403 opens the paywall.
 */
export async function readDownloadState(employer: string | null): Promise<DownloadState | null> {
  const q = employer ? `?employer=${encodeURIComponent(employer)}` : '';
  const r = await call(`/downloads/state${q}`, { ms: 10000 });
  if (!r || r.status !== 200 || !r.json || r.json.success === false) return null;
  const j = r.json;
  return {
    metered: !!j.metered,
    paid: !!j.paid,
    unlimited: !!j.unlimited,
    remaining: typeof j.remaining === 'number' ? j.remaining : null,
    passes: Number(j.passes) || 0,
    ownsEmployer: !!j.ownsEmployer,
    employer: typeof j.employer === 'string' ? j.employer : null,
  };
}

/**
 * POST /:id/send-files — one PDF / Word file from the phone; the server keeps it 30 minutes for the send. A classic
 * letter's upload (/classic/send-files) carries no letter: the file is held for this user, and only their send takes it.
 */
export async function uploadSendFile(ref: LetterRef, file: { uri: string; name: string; mimeType?: string | null }):
  Promise<{ ok: true; file: PickedFile } | Fail> {
  const form = new FormData();
  // @ts-expect-error — RN's FormData takes this object form for a file part; the DOM types do not.
  form.append('file', { uri: file.uri, name: file.name || 'file.pdf', type: file.mimeType || 'application/octet-stream' });
  const r = await call(pathOf(ref, 'send-files'), { method: 'POST', form, ms: 60000 });
  if (!r) return { ok: false, reason: 'network' };
  if (r.status !== 200 || typeof r.json.fileId !== 'string') return failOf(r.status, r.json);
  return { ok: true, file: { fileId: r.json.fileId, name: str(r.json.name) || file.name, size: Number(r.json.size) || 0, mime: str(r.json.mime) } };
}

const POLL_MS = 1500;
const POLL_DEADLINE_MS = 3 * 60 * 1000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The server's success body → SendResult. `to` is the list THAT job was given (the server answers a count only). */
function resultOf(j: any, to: string[]): SendResult {
  const provider: MailProvider | null = j && (j.provider === 'google' || j.provider === 'microsoft') ? j.provider : null;
  return {
    provider,
    from: j && isEmail(j.from) ? j.from : null,
    to: to.filter(isEmail),
    charged: !!(j && j.charged),
    sentAt: j && typeof j.sentAt === 'string' ? j.sentAt : null,
  };
}

export type SendOutcome = { ok: true; result: SendResult } | Fail;

/**
 * POST /:id/send as a server job, then its outcome. `clientBuildId` is the idempotency key (see the header): the SAME
 * id on a retry after 'network' / 'lost' of the SAME message (canJoin), a NEW one after any definite answer.
 * `onJob` hears the job id the moment the 202 lands, so the page can keep it (PendingSend) and a reopened page polls
 * that job instead of sending anything.
 */
export async function sendLetterEmail(ref: LetterRef, req: SendRequest,
  opts: { clientBuildId: string; onJob?: (jobId: string) => void }): Promise<SendOutcome> {
  const r = await call(pathOf(ref, 'send'), {
    method: 'POST',
    ms: 120000,
    body: {
      to: req.to, subject: req.subject, body: req.body,
      template: req.template, mode: req.mode,
      letter: letterWire(req.letter), resume: resumeWire(req.resume),
      ...letterBodyOf(ref),
      __async: true, clientBuildId: opts.clientBuildId,
    },
  });
  if (!r) return { ok: false, reason: 'network' };
  // The server could not make a job row and ran the send right there: its answer IS the outcome.
  if (r.status === 200) return r.json && r.json.success ? { ok: true, result: resultOf(r.json, req.to) } : failOf(500, r.json);
  if (r.status !== 202 || typeof r.json.jobId !== 'string') return failOf(r.status, r.json);
  try { if (opts.onJob) opts.onJob(r.json.jobId); } catch { /* a bookkeeping hook must not lose the send */ }
  return pollSendJob(r.json.jobId, req.to);
}

/**
 * A Send job's outcome, polled until the deadline. `to` is the list that job was given (the server answers a count).
 * ⚠️ A job row that is not there (three 404s) is 'unknown_outcome', not 'lost': there is nothing left to join, so a
 * retry would be a NEW message — the page must ask the user to look in their Sent folder first.
 */
export async function pollSendJob(jobId: string, to: string[]): Promise<SendOutcome> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let missing = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const s = await call(`/job-status/${encodeURIComponent(jobId)}`, { ms: 15000 });
    if (!s) continue;                                   // a blip while polling: keep asking until the deadline
    if (s.status === 404) { if (++missing >= 3) return { ok: false, reason: 'unknown_outcome' }; continue; }
    if (s.status !== 200) continue;
    missing = 0;
    const st = s.json.status;
    if (st === 'completed') {
      const data = s.json.data && typeof s.json.data === 'object' ? s.json.data : {};
      return data.success ? { ok: true, result: resultOf(data, to) } : failOf(500, data);
    }
    if (st === 'failed') {
      const reason = typeof s.json.reason === 'string' && KNOWN.has(s.json.reason) ? s.json.reason as SendReason : 'failed';
      return { ok: false, reason, message: str(s.json.error) || undefined };
    }
  }
  return { ok: false, reason: 'lost' };
}
