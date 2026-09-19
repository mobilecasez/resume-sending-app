// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE LETTER'S SEND PAGE (route /(cover-letter)/send, params docId · template · mode — or classic=1, see below) — opened by the Send pill at the
// top right of the letter preview (templates.tsx, doc mode). One employer's saved cover letter, emailed from the
// user's OWN Gmail or Outlook with the letter PDF (the design on screen when Send was tapped) and a résumé attached.
//
// THE OWNER'S ASK (2026-09-19): "there is space on the top right corner … show a button Send and on click … a well
// designed GUI page like our customisation page to send email … auto generated subject, auto generated body for that
// employer … Attachments of that cover letter, attach the resume of the user if generated for that employer then use
// that otherwise use the normal one but on click of that it will give user the option to change that with our smart
// file upload control box … use the connected gmail or microsoft account to send the email … and it should allow
// user to add email id and send that".
// So the page is the customization page's twin (components/rich-text/RichText: the palette, the hero-style card, the
// Section cards with Edit / Cancel / Done), top to bottom:
//   the mailbox card   → which Gmail / Outlook it goes from; Connect / Reconnect when there is none (services/mailAccount)
//   TO                 → address chips, an add field (validated as typed), the contacts we know for this job as chips
//   SUBJECT            → the letter's own subject (its customization card), Edit
//   MESSAGE            → a short note written FROM the letter (free AI, template fallback), Edit / Rewrite
//   ATTACHMENTS        → the letter PDF and the résumé (tailored > Builder > uploaded), each with Change → the smart
//                        upload sheet (components/send/SmartAttachSheet: our versions, or a PDF / Word from the phone)
//   the Send bar       → idle / sending / sent
//
// ⚠️ OPENING THIS PAGE SENDS NOTHING AND CHARGES NOTHING. It reads a draft and asks for a free AI note. The one call
// that can cost anything is the Send tap, which the server gates and charges EXACTLY like the Download on the page
// before (a plan or a one-employer pass; charged only after Gmail / Outlook accepted the message). A locked account is
// shown the padlock here and the paywall sheet on Send — before any request — and the server refuses it again anyway.
// ⚠️ THE AI NEVER OVERWRITES THE USER. Once the message was edited, a late AI answer is dropped; Rewrite asks first.
// ⚠️ THE DRAFT IS KEPT ON THE PHONE (per letter version), so leaving the page loses nothing — no leave guard needed.
// ⚠️ ONE SEND. The Send is a server job keyed by a clientBuildId; the id is KEPT only after an unknown outcome (a lost
// connection), so a retry joins the same job instead of mailing the recruiter twice — and replaced after anything
// definite, because the server would otherwise hand back the failed job (services/letterSend).
// ⚠️ ONE SEND, HARDENED (review, 2026-09-19):
//   • the kept id belongs to ONE message (PendingSend.fp): edit the To line, the subject, the message or an attachment
//     and the next Send asks "your last Send may have gone out" and takes a new id — never the old job reported as new;
//   • the pending Send is kept on the phone (pendingKey) from the tap until a definite answer: Back mid-send asks first,
//     and a reopened page POLLS that job — it sends nothing — then shows what really happened;
//   • 'unknown_outcome' (the provider may have taken it) never says "nothing was sent" and never offers a blind retry;
//   • Send waits for a file that is still uploading, and asks before sending the standard note while the AI one is
//     still being written (a late AI answer is dropped once a Send has started — it was never sent).
// ⚠️ THE MESSAGE SAYS WHAT IS ATTACHED. The standard note comes in two shapes (with / without a résumé) and follows the
// attachment row; an AI note is rewritten for the new set (free); a user's own words are never touched — they are
// asked about if they say a résumé is attached and none is.
// ⚠️ THE PADLOCK IS DRAWN ONLY FROM A REAL ANSWER (readDownloadState is null when unreadable — never "locked"), and the
// paywall re-sends at most ONCE per opening: a refusal after it is said on the card, never a loop through the sheet.
// ⚠️ ONE MODAL AT A TIME: the attach sheet closes before the document picker or the paywall opens (SmartAttachSheet).
// ⚠️ A CLASSIC LETTER TOO (2026-09-20, params classic=1 · template · mode). The preview opened WITHOUT a saved document —
// the Job Hub's, the Review screen's, the old Home's letters — has the same Download, so it has this same page: it
// leaves its letter under CLASSIC_SEND_KEY and every call carries it (services/letterSend LetterRef). Everything below
// holds unchanged; only the letter's name differs — its id, or, for a classic letter, its content key (letterKey) for
// the DRAFT and its posting / employer (pendingId, classicIdentityKey) for the PENDING SEND, so regenerating the letter
// cannot hide a Send whose outcome is unknown. A classic page that finds no letter says so ('no_letter') and sends nothing.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Platform, TextInput, Alert,
  KeyboardAvoidingView, Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { T, Section, sec } from '../../components/rich-text/RichText';
import SmartAttachSheet, { type AttachOption, type DeviceFile } from '../../components/send/SmartAttachSheet';
import DownloadPaywallSheet from '../../components/downloads/DownloadPaywallSheet';
import { downloadButtonLabel, type DownloadState } from '../../services/downloadPassService';
import { fetchDocCards } from '../../services/employerDocs';
import { LETTER_DESIGNS } from '../../services/employerHomeService';
import { markAppliedByUrl } from '../../services/aiHubService';
import { useMailLink } from '../../services/mailAccount';
import {
  fetchEmailDraft, fetchEmailBody, uploadSendFile, sendLetterEmail, pollSendJob, readDownloadState,
  addRecipients, removeRecipient, canSend, defaultResumeChoice, isGated, isEmail, reasonMessage, providerName,
  sizeLabel, draftKey, newClientBuildId, pendingKey, parsePending, canJoin, sendFingerprint, saysResumeAttached,
  failureAction, parseClassicLetter, letterKeyOf, pendingLetterKeyOf,
  MAX_RECIPIENTS, SUBJECT_MAX, BODY_MAX, CLASSIC_SEND_KEY,
  type EmailDraft, type MailAccount, type MailProvider, type LetterAttachment, type ResumeAttachment,
  type SendReason, type SendResult, type SendOutcome, type PendingSend, type LetterRef, type ClassicLetter,
} from '../../services/letterSend';

/** A route param → a real doc id, or null. */
function docIdOf(raw: unknown): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
const paramOf = (raw: unknown): string => {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v : '';
};

type Failure = { reason: SendReason; title: string; message: string };
/** What a Send tap has already been through — each question is asked once, then the tap carries the answer. */
type SendOpts = { afterUnlock?: boolean; standardNote?: boolean; resumeOk?: boolean; newSend?: boolean };

export default function SendLetter() {
  const router = useRouter();
  const params = useLocalSearchParams<{ docId?: string; template?: string; mode?: string; classic?: string }>();
  const docId = docIdOf(params.docId);                    // constant for the life of the screen
  const classicMode = !docId && paramOf(params.classic) === '1';
  const template = paramOf(params.template) || undefined;
  const modeParam = paramOf(params.mode);
  const pageMode: 'a4' | 'onepage' | undefined = modeParam === 'a4' || modeParam === 'onepage' ? modeParam : undefined;
  const { linkGoogle, linkMicrosoft } = useMailLink();
  // WHICH LETTER every call is about (see the header): a saved letter's id, or — once read from CLASSIC_SEND_KEY — the
  // classic letter itself; and its key on the phone (the draft, the pending Send). Refs: the callbacks outlive renders.
  const letterRef = useRef<LetterRef | null>(docId);
  const letterKey = useRef<string | null>(docId ? String(docId) : null);
  // …and which letter a PENDING Send belongs to: the same id, or a classic letter's POSTING (see the header).
  const pendingId = useRef<string | null>(docId ? String(docId) : null);
  const [classicDesign, setClassicDesign] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadFail, setLoadFail] = useState<SendReason | null>(null);
  const [nonce, setNonce] = useState(0);
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [account, setAccount] = useState<MailAccount | null>(null);
  const [linking, setLinking] = useState<MailProvider | null>(null);
  const [showSwitch, setShowSwitch] = useState(false);

  const [to, setTo] = useState<string[]>([]);
  const [toInput, setToInput] = useState('');
  const [toError, setToError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [bodySource, setBodySource] = useState<'template' | 'ai' | 'user'>('template');
  const [bodyLoading, setBodyLoading] = useState(false);
  const [editing, setEditing] = useState<'subject' | 'body' | null>(null);
  const [fieldDraft, setFieldDraft] = useState('');

  const [letterAtt, setLetterAtt] = useState<LetterAttachment>({ source: 'doc' });
  const [resumeAtt, setResumeAtt] = useState<ResumeAttachment>({ source: 'none' });
  const [sheet, setSheet] = useState<'letter' | 'resume' | null>(null);
  const sheetFor = useRef<'letter' | 'resume'>('letter');
  const [uploading, setUploading] = useState<'letter' | 'resume' | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);

  // null until read, and null when it could not be read (readDownloadState): the padlock is only drawn from a real
  // answer (the server decides on Send regardless).
  const [dl, setDl] = useState<DownloadState | null>(null);
  const [payOpen, setPayOpen] = useState(false);

  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [result, setResult] = useState<SendResult | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  // The phase as of NOW, for answers that land after the render that asked (a late AI note must not follow a Send).
  const phaseRef = useRef<'idle' | 'sending' | 'sent'>('idle');
  const goPhase = (p: 'idle' | 'sending' | 'sent') => { phaseRef.current = p; setPhase(p); };
  // The Send whose outcome this phone has not heard yet — kept on the phone too (see the header).
  const pending = useRef<PendingSend | null>(null);
  const restored = useRef(false);
  const bodyTouched = useRef(false);
  // Which attachment set the shown standard / AI note was written for: true = the letter AND a résumé.
  const bodyFor = useRef(true);
  // Bumped per AI request: an answer to an older request, or one a Send overtook, is dropped.
  const bodyGen = useRef(0);
  // One re-send per paywall opening (onUnlocked).
  const unlockUsed = useRef(false);
  const toRef = useRef<TextInput | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const savePending = (p: PendingSend | null) => {
    pending.current = p;
    if (!pendingId.current) return;
    const k = pendingKey(pendingId.current);
    (p ? AsyncStorage.setItem(k, JSON.stringify(p)) : AsyncStorage.removeItem(k)).catch(() => {});
  };

  /**
   * The free AI note for this attachment set. Dropped when the user has written their own, when a newer request
   * replaced it, or once a Send has started — that Send carried the message on screen, not this one (see the header).
   */
  const loadAiBody = async (ref: LetterRef, withResume: boolean) => {
    const gen = ++bodyGen.current;
    setBodyLoading(true);
    const r = await fetchEmailBody(ref, withResume);
    if (!alive.current || gen !== bodyGen.current) return;
    setBodyLoading(false);
    if (!r.ok || bodyTouched.current || phaseRef.current !== 'idle') return;
    setBody(r.body);
    setBodySource(r.source);
    bodyFor.current = withResume;
  };

  const refreshDl = async (employer?: string | null) => {
    const st = await readDownloadState(employer ?? (draft ? draft.letter.employer : null) ?? null);
    if (st && alive.current) setDl(st);
    return st;
  };
  // The paywall's onUnlocked is stable (see below), so it reaches TODAY's refresh through this.
  const refreshDlRef = useRef(refreshDl);
  refreshDlRef.current = refreshDl;

  useEffect(() => {
    let live = true;
    (async () => {
      if (!docId && !classicMode) { setLoadFail('gone'); setLoading(false); return; }
      setLoading(true);
      setLoadFail(null);
      if (!letterRef.current) {
        // A classic letter, read ONCE from where the preview left it (a retry keeps the one already read).
        let c: ClassicLetter | null = null;
        try { c = parseClassicLetter(await AsyncStorage.getItem(CLASSIC_SEND_KEY)); } catch { c = null; }
        if (!live) return;
        if (!c) { setLoadFail('no_letter'); setLoading(false); return; }
        letterRef.current = { classic: c };
        letterKey.current = letterKeyOf(letterRef.current);
        pendingId.current = pendingLetterKeyOf(letterRef.current);
        setClassicDesign(c.designName || null);
      }
      const ref = letterRef.current as LetterRef;
      const key = letterKey.current as string;
      const r = await fetchEmailDraft(ref);
      if (!live) return;
      if (!r.ok) { setLoadFail(r.reason); setLoading(false); return; }
      const d = r.draft;
      const firstResume = defaultResumeChoice(d.resume.options, d.resume.default);
      const firstFor = firstResume.source !== 'none';
      let nextTo = d.recipients.prefill.map((c) => c.email).slice(0, MAX_RECIPIENTS);
      let nextSubject = d.subject;
      // The standard note for what is attached by default (see the header).
      let nextBody = firstFor ? d.bodies.withResume : d.bodies.letterOnly;
      let nextSource: 'template' | 'ai' | 'user' = 'template';
      let nextFor = firstFor;
      let pend: PendingSend | null = null;
      try {
        const raw = await AsyncStorage.getItem(draftKey(key, d.letter.updatedAt));
        const saved = raw ? JSON.parse(raw) : null;
        if (saved && typeof saved === 'object') {
          if (Array.isArray(saved.to)) nextTo = saved.to.filter(isEmail).slice(0, MAX_RECIPIENTS);
          if (typeof saved.subject === 'string' && saved.subject.trim()) nextSubject = saved.subject.slice(0, SUBJECT_MAX);
          if (typeof saved.body === 'string' && saved.body.trim() && (saved.source === 'ai' || saved.source === 'user')) {
            nextBody = saved.body.slice(0, BODY_MAX);
            nextSource = saved.source;
            // The set that note was written for (a draft kept before this was recorded: the letter + résumé note).
            nextFor = typeof saved.withResume === 'boolean' ? saved.withResume : true;
          }
        }
      } catch { /* no saved draft: the server's defaults */ }
      try { pend = parsePending(await AsyncStorage.getItem(pendingKey(pendingId.current as string)), Date.now()); } catch { pend = null; }
      if (!live) return;
      setDraft(d);
      setAccount(d.account);
      setTo(nextTo);
      setSubject(nextSubject);
      setBody(nextBody);
      setBodySource(nextSource);
      bodyTouched.current = nextSource === 'user';
      bodyFor.current = nextFor;
      setResumeAtt(firstResume);
      restored.current = true;
      setLoading(false);
      if (pend) {
        // A Send from an earlier visit whose outcome this phone never heard. With its job: ask the job — nothing is
        // sent. Without one: say so, and let the SAME message join it (or ask, if it can no longer join).
        pending.current = pend;
        if (pend.jobId && !pend.ambiguous) resumePending(pend, d);
        else {
          const why: SendReason = pend.ambiguous ? 'unknown_outcome' : 'lost';
          const m = reasonMessage(why, { provider: d.account.provider });
          setFailure({ reason: why, title: m.title, message: m.message });
        }
      } else if (nextSource === 'template') {
        // Asked once per letter version: a note already written for it (kept on the phone) is not written again.
        loadAiBody(ref, nextFor);
      }
      readDownloadState(d.letter.employer || null).then((st) => { if (live && st) setDl(st); });
      // The design's thumbnail is a saved letter's card; a classic letter shows its icon (its pages were never stored).
      if (template && docId) {
        fetchDocCards('cover_letter', docId, [template], { size: 'card' })
          .then((got) => {
            if (!live || !got || got === 'gone') return;
            const c = got.cards.find((x) => x.id === template);
            if (c && c.image) setThumb(c.image);
          })
          .catch(() => {});
      }
    })();
    return () => { live = false; };
    // loadAiBody reads refs only; template is a route param (constant for the screen).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, nonce]);

  // The draft, kept on the phone per letter version (see the header).
  useEffect(() => {
    if (!restored.current || !letterKey.current || !draft || phase === 'sent') return;
    const key = draftKey(letterKey.current, draft.letter.updatedAt);
    const t = setTimeout(() => {
      AsyncStorage.setItem(key, JSON.stringify({ to, subject, body, source: bodySource, withResume: bodyFor.current })).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [to, subject, body, bodySource, draft, docId, phase]);

  // THE NOTE FOLLOWS THE ATTACHMENTS (see the header): the résumé taken off (or put back) → the standard note for that
  // set, and an AI note is written again for it (free). The user's own words are never replaced — doSend asks instead.
  const hasResume = resumeAtt.source !== 'none';
  useEffect(() => {
    const ref = letterRef.current;
    if (!restored.current || !draft || !ref || phaseRef.current !== 'idle') return;
    if (bodySource === 'user' || bodyFor.current === hasResume) return;
    const wasAi = bodySource === 'ai' || bodyLoading;
    bodyFor.current = hasResume;
    setBody(hasResume ? draft.bodies.withResume : draft.bodies.letterOnly);
    setBodySource('template');
    if (wasAi) loadAiBody(ref, hasResume);
    // Only the attachment set (and a freshly loaded draft) decides this; the rest is read as of that render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasResume, draft]);

  /* ── recipients ── */

  const addTyped = (text: string) => {
    if (!text.trim()) return;
    const r = addRecipients(to, text);
    setTo(r.list);
    setToError(r.error);
    setToInput(r.error ? text.trim() : '');
  };
  const onToChange = (v: string) => {
    setToError(null);
    // A separator typed (or a pasted list) commits what is before it — the way a mail app's To field does.
    if (/[,;\s]$/.test(v) && v.trim()) { addTyped(v); return; }
    setToInput(v);
  };
  const contactName = (email: string) => {
    const all = draft ? [...draft.recipients.prefill, ...draft.recipients.suggestions] : [];
    const c = all.find((x) => x.email.toLowerCase() === email.toLowerCase());
    return c && c.name ? c.name : null;
  };

  /* ── subject / message ── */

  const startEdit = (f: 'subject' | 'body') => {
    if (editing || phase !== 'idle' || (f === 'body' && bodyLoading)) return;
    setFieldDraft(f === 'subject' ? subject : body);
    setEditing(f);
  };
  const cancelEdit = () => { Keyboard.dismiss(); setEditing(null); };
  const doneEdit = () => {
    Keyboard.dismiss();
    if (editing === 'subject') {
      const v = fieldDraft.replace(/[\r\n]+/g, ' ').slice(0, SUBJECT_MAX);
      if (v.trim()) setSubject(v);
    } else if (editing === 'body') {
      const v = fieldDraft.slice(0, BODY_MAX);
      if (v !== body && v.trim()) { setBody(v); setBodySource('user'); bodyTouched.current = true; }
    }
    setEditing(null);
  };
  const rewrite = () => {
    const ref = letterRef.current;
    if (!ref || bodyLoading || editing || phase !== 'idle') return;
    const go = () => { bodyTouched.current = false; loadAiBody(ref, resumeAtt.source !== 'none'); };
    if (bodySource === 'user') {
      Alert.alert('Write a new message?', 'Your edited message will be replaced by a new one written from your letter.', [
        { text: 'Keep mine', style: 'cancel' },
        { text: 'Rewrite', onPress: go },
      ]);
    } else go();
  };

  /* ── the mailbox ── */

  const connect = async (p: MailProvider) => {
    const ref = letterRef.current;
    if (linking || !ref) return;
    setLinking(p);
    const r = p === 'google' ? await linkGoogle() : await linkMicrosoft();
    if (!alive.current) return;
    setLinking(null);
    if (!r.ok) { if (!r.cancelled) Alert.alert('Not connected', r.message); return; }
    // The server is the authority on which mailbox now sends — read it back rather than assume.
    const d = await fetchEmailDraft(ref);
    if (!alive.current) return;
    setAccount(d.ok ? d.draft.account : { provider: p, ready: true, reconnect: false, address: r.address });
    setShowSwitch(false);
    setFailure((f) => (f && (f.reason === 'reconnect' || f.reason === 'scope' || f.reason === 'no_mail_account') ? null : f));
  };

  /* ── attachments ── */

  const openSheet = (which: 'letter' | 'resume') => {
    if (phase !== 'idle' || uploading) return;
    sheetFor.current = which;
    setSheet(which);
  };
  const onPick = (key: string) => {
    const which = sheetFor.current;
    setSheet(null);
    if (which === 'letter') {
      if (key === 'doc') setLetterAtt({ source: 'doc' });
      return;
    }
    if (key === 'none') { setResumeAtt({ source: 'none' }); return; }
    const opt = draft ? draft.resume.options.find((o) => o.id === key) : undefined;
    if (opt) setResumeAtt({ source: opt.id, option: opt });
  };
  const onDevice = async (f: DeviceFile) => {
    const which = sheetFor.current;
    const ref = letterRef.current;
    if (!ref) return;
    setUploading(which);
    const r = await uploadSendFile(ref, { uri: f.uri, name: f.name, mimeType: f.mimeType });
    if (!alive.current) return;
    setUploading(null);
    if (!r.ok) {
      const m = reasonMessage(r.reason, { detail: r.message });
      Alert.alert(m.title, r.message || m.message);
      return;
    }
    if (which === 'letter') setLetterAtt({ source: 'file', file: r.file });
    else setResumeAtt({ source: 'file', file: r.file });
    setFailure((x) => (x && (x.reason === 'file_gone' || x.reason === 'resume_gone') ? null : x));
  };

  /* ── send ── */

  const locked = dl ? downloadButtonLabel(dl).locked : false;
  const gatedNow = isGated(letterAtt) || isGated(resumeAtt);
  const needsPay = gatedNow && locked;

  const openPaywall = () => { unlockUsed.current = false; setPayOpen(true); };

  /**
   * A Send's answer → the phone's records, then the page. ⚠️ The records are written even when the page has gone (the
   * user left mid-send): a definite answer clears the pending Send; success also clears the draft and marks the job
   * Applied. Only the screen updates wait for a live page.
   */
  const settle = async (r: SendOutcome, d: EmailDraft, opts: SendOpts) => {
    const key = letterKey.current;
    if (!key) return;
    if (r.ok) {
      savePending(null);
      AsyncStorage.removeItem(draftKey(key, d.letter.updatedAt)).catch(() => {});
      if (d.letter.jobUrl) markAppliedByUrl([d.letter.jobUrl]).catch(() => {});
      if (!alive.current) return;
      setFailure(null);
      setResult(r.result);          // its `to` is the list THAT Send was given (pollSendJob / resultOf)
      goPhase('sent');
      // Through the ref: a resumed Send settles in the FIRST render's closure, whose draft was still null.
      if (r.result.charged) refreshDlRef.current();
      return;
    }
    // Unknown → the pending Send stays (the SAME message joins its job); 'unknown_outcome' → it stays, marked, so the
    // next Send asks first; anything definite → cleared (the next Send is a new one: the server would hand back this
    // failed job under the old id).
    if (r.reason === 'unknown_outcome') { if (pending.current) savePending({ ...pending.current, ambiguous: true }); }
    else if (r.reason !== 'network' && r.reason !== 'lost') savePending(null);
    if (!alive.current) return;
    goPhase('idle');
    const m = reasonMessage(r.reason, { provider: r.provider || (account ? account.provider : null), detail: r.message });
    if (r.reason === 'paid_required' || r.reason === 'quota_exhausted') {
      const st = await refreshDlRef.current();
      if (!alive.current) return;
      // ⚠️ NEVER A LOOP THROUGH THE SHEET. The sheet unlocks ITSELF when the phone's state says unlocked (its focus
      // check) — e.g. 1 plan download left for a 2-file message — and would only re-send into the same refusal. So the
      // sheet only when the state really is locked and this tap did not already come through it; else the card says it.
      if (!opts.afterUnlock && (!st || downloadButtonLabel(st).locked)) { openPaywall(); return; }
      setFailure({ reason: r.reason, title: m.title, message: r.message || m.message });
      return;
    }
    if (r.reason === 'reconnect' || r.reason === 'scope' || r.reason === 'no_mail_account') {
      setAccount((a) => ({ provider: (r.provider || (a && a.provider)) ?? null, ready: false, reconnect: r.reason !== 'no_mail_account', address: a ? a.address : null }));
    }
    const ours = r.reason === 'bad_recipients' || r.reason === 'network' || r.reason === 'lost' || r.reason === 'server_outdated' || !r.message;
    setFailure({ reason: r.reason, title: m.title, message: ours ? m.message : (r.message as string) });
  };

  /** A pending Send from an earlier visit that has a job: ask the job — this sends nothing (see the header). */
  const resumePending = async (p: PendingSend, d: EmailDraft) => {
    if (!p.jobId) return;
    goPhase('sending');
    setFailure(null);
    const r = await pollSendJob(p.jobId, p.to);
    await settle(r, d, {});
  };

  const doSend = async (opts: SendOpts = {}) => {
    const ref = letterRef.current;
    if (!ref || !draft || phaseRef.current !== 'idle') return;
    // A file still on its way: this Send would carry what the row held BEFORE it (see canSend).
    if (uploading) return;
    let list = to;
    if (toInput.trim()) {
      const r = addRecipients(to, toInput);
      setTo(r.list);
      setToError(r.error);
      if (r.error) return;
      setToInput('');
      list = r.list;
    }
    const check = canSend({ to: list, subject, body, account, busy: false, hasLetter: true });
    if (!check.ok) { Alert.alert('Not ready to send', check.why || 'Please check the page.'); return; }
    // The AI note is still being written: what is on file is the standard note the user has not even seen — ask.
    if (bodyLoading && !opts.standardNote) {
      Alert.alert('Your message is still being written', 'Wait a few seconds for the note written from your letter, or send the standard note now.', [
        { text: 'Wait', style: 'cancel' },
        { text: 'Send the standard note', onPress: () => doSendRef.current({ ...opts, standardNote: true }) },
      ]);
      return;
    }
    // Their own words say a résumé is attached and none is (the standard / AI notes already follow the attachments).
    if (!opts.resumeOk && resumeAtt.source === 'none' && saysResumeAttached(body)) {
      Alert.alert('No résumé attached', 'Your message says a résumé is attached, but none is. Attach one under Attachments or edit the message — or send it as it is.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Send anyway', onPress: () => doSendRef.current({ ...opts, resumeOk: true }) },
      ]);
      return;
    }
    // The Download's rule, before any request: a locked account sees the paywall, never a round trip to a refusal.
    if (!opts.afterUnlock && needsPay) { openPaywall(); return; }
    const req = { to: list, subject, body, template, mode: pageMode, letter: letterAtt, resume: resumeAtt };
    // A classic letter travels in the request, so its own text is part of what this Send is: a kept id may not be reused
    // for a REGENERATED letter (its pending Send is kept per posting, not per version — see the header).
    const fp = sendFingerprint(req, typeof ref === 'number' ? '' : letterKeyOf(ref));
    const prev = pending.current;
    const now = Date.now();
    const join = canJoin(prev, fp, now);
    // ⚠️ An earlier Send may have gone out and THIS is a different message (or that one can no longer be joined).
    if (prev && !join && !opts.newSend) {
      Alert.alert('Your last Send may have gone out', 'We never heard back about your last Send. Look in your Sent folder first — send this one only if the last one is not there, or the recruiter may get it twice.', [
        { text: 'Not now', style: 'cancel' },
        { text: 'Send this one', onPress: () => doSendRef.current({ ...opts, newSend: true }) },
      ]);
      return;
    }
    const mine: PendingSend = join && prev ? prev : { id: newClientBuildId(), fp, to: list, jobId: null, at: now, ambiguous: false };
    savePending(mine);
    // Sent with the standard note while the AI one was written: that late answer was never sent — drop it.
    if (bodyLoading) { bodyGen.current++; setBodyLoading(false); }
    Keyboard.dismiss();
    goPhase('sending');
    setFailure(null);
    const d = draft;
    const r = await sendLetterEmail(ref, req, {
      clientBuildId: mine.id,
      onJob: (jobId) => { if (pending.current && pending.current.id === mine.id) savePending({ ...pending.current, jobId }); },
    });
    await settle(r, d, opts);
  };
  // The paywall's onUnlocked outlives the render it was created in — it must call TODAY's doSend.
  const doSendRef = useRef(doSend);
  doSendRef.current = doSend;
  // ⚠️ STABLE, AND ONCE PER OPENING. DownloadPaywallSheet re-runs its focus check whenever this prop changes, and an
  // inline function changed on every render — each run that read "unlocked" re-sent.
  const onUnlocked = useCallback(async () => {
    if (unlockUsed.current) return;
    unlockUsed.current = true;
    setPayOpen(false);
    await refreshDlRef.current();
    doSendRef.current({ afterUnlock: true });
  }, []);

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/' as never);
  };
  // Mid-send, Back asks: leaving is safe (the pending Send is on the phone and a reopened page asks its job), but the
  // user should know the message still goes out.
  const onBack = () => {
    if (editing) { cancelEdit(); return; }
    if (phaseRef.current === 'sending') {
      Alert.alert('Still sending', 'Your message is on its way and finishes without this page. Open Send again from your letter to see how it went — it will not be sent twice.', [
        { text: 'Stay', style: 'cancel' },
        { text: 'Leave', onPress: leave },
      ]);
      return;
    }
    leave();
  };

  /* ── RENDER ── */

  if (loading) {
    return (
      <SafeAreaView style={[s.safe, s.center]} edges={['top']}>
        <ActivityIndicator size="large" color={T.blue} />
        <Text style={s.loadingText}>Preparing your email…</Text>
      </SafeAreaView>
    );
  }
  if (!draft || loadFail) {
    const m = reasonMessage(loadFail || 'failed');
    const final = loadFail === 'gone' || loadFail === 'server_outdated' || loadFail === 'no_letter';
    return (
      <SafeAreaView style={[s.safe, s.center, s.emptyWrap]} edges={['top']}>
        <Ionicons name={loadFail === 'server_outdated' ? 'cloud-download-outline' : 'mail-unread-outline'} size={48} color={T.faint} />
        <Text style={s.emptyTitle}>{m.title}</Text>
        <Text style={s.emptyText}>{m.message}</Text>
        {!final && (
          <TouchableOpacity onPress={() => setNonce((n) => n + 1)} style={s.retryBtn} activeOpacity={0.85}>
            <Ionicons name="refresh-outline" size={14} color={T.blueDeep} /><Text style={s.retryText}>Try again</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={leave} style={s.goBackBtn} activeOpacity={0.85}>
          <Text style={s.goBackText}>{loadFail === 'server_outdated' ? 'Back to Download' : 'Go Back'}</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const acct = account || draft.account;
  const ready = !!acct.ready;
  const who = providerName(acct.provider);
  // A classic letter names the design as its preview did (its own catalogue's name); a saved one reads Home's catalogue.
  const designName = classicDesign || (LETTER_DESIGNS.find((d) => d.id === template) || { name: 'Your design' }).name;
  const modeLabel = pageMode === 'a4' ? 'A4 pages' : 'One page';
  const busy = phase !== 'idle';
  // An address typed but not yet a chip counts: Send commits it (doSend) — see canSend.
  const typedTo = toInput.trim();
  const typedList = typedTo ? addRecipients(to, typedTo) : null;
  const count = typedList && !typedList.error ? typedList.list.length : to.length;
  const check = canSend({ to, typed: typedTo, subject, body, account: acct, busy: false, hasLetter: true, uploading: !!uploading });
  const sendLabel = phase === 'sending' ? 'Sending…' : phase === 'sent' ? 'Done'
    : count ? `Send to ${count} ${count === 1 ? 'recipient' : 'recipients'}` : 'Send';
  const barNote = phase !== 'idle' ? null : !check.ok ? check.why : bodyLoading ? 'Still writing your message from the letter…' : null;
  const employer = draft.letter.employer || draft.letter.companyName || 'this employer';

  // The error card's one button: the fix its message names (failureAction), never a blind retry of a request that can
  // only fail the same way.
  const failAct = failure ? failureAction(failure.reason) : null;
  const attachSheetFor: 'letter' | 'resume' = resumeAtt.source !== 'none' ? 'resume' : 'letter';
  const failBtn: { label: string; run: () => void } | null = !failure ? null
    : failAct === 'back' ? { label: failure.reason === 'server_outdated' ? 'Back to Download' : 'Go back', run: leave }
      : failAct === 'choose_again' ? { label: 'Choose again', run: () => openSheet(letterAtt.source === 'file' && failure.reason === 'file_gone' ? 'letter' : 'resume') }
        : failAct === 'reconnect' ? { label: `Reconnect ${who}`, run: () => { connect(acct.provider || 'google'); } }
          : failAct === 'retry' ? { label: 'Try again', run: () => { doSend(); } }
            : failAct === 'send_again' ? { label: 'Send again', run: () => { doSend(); } }
              // A plan short by a file cannot be fixed on the sheet (it would unlock itself): change the files instead.
              : failAct === 'attachments' || (failAct === 'plans' && !locked) ? { label: 'Change attachments', run: () => openSheet(attachSheetFor) }
                : failAct === 'plans' ? { label: 'See options', run: openPaywall }
                  : failAct === 'recipients' ? { label: 'Check the addresses', run: () => { if (toRef.current) toRef.current.focus(); } }
                    : failAct === 'subject' ? { label: 'Edit the subject', run: () => startEdit('subject') }
                      : failAct === 'body' ? { label: 'Edit the message', run: () => startEdit('body') }
                        : null;

  const letterOptions: AttachOption[] = [
    {
      key: 'doc', icon: 'document-text', tint: T.violet, label: `This letter · ${designName}`,
      hint: `${modeLabel} · PDF — the design you were previewing`, selected: letterAtt.source === 'doc', locked,
    },
    ...(letterAtt.source === 'file'
      ? [{ key: 'file', icon: 'document-attach', tint: T.blue, label: letterAtt.file.name, hint: `Your file · ${sizeLabel(letterAtt.file.size)}`, selected: true }]
      : []),
  ];
  const resumeOptions: AttachOption[] = [
    ...draft.resume.options.map((o) => ({
      key: o.id,
      icon: o.id === 'tailored' ? 'sparkles' : o.id === 'builder' ? 'document-text' : 'cloud-upload',
      tint: o.id === 'tailored' ? T.emerald : o.id === 'builder' ? T.blue : T.cyan,
      label: o.label, hint: o.detail, selected: resumeAtt.source === o.id, locked: o.gated && locked,
    })),
    ...(resumeAtt.source === 'file'
      ? [{ key: 'file', icon: 'document-attach', tint: T.blue, label: resumeAtt.file.name, hint: `Your file · ${sizeLabel(resumeAtt.file.size)}`, selected: true }]
      : []),
    { key: 'none', icon: 'remove-circle-outline', tint: T.muted, label: 'No résumé', hint: 'Send the cover letter only', selected: resumeAtt.source === 'none' },
  ];

  const resumeTitle = resumeAtt.source === 'file' ? resumeAtt.file.name
    : resumeAtt.source === 'none' ? '' : resumeAtt.option.label;
  const resumeSub = resumeAtt.source === 'file' ? `Your file · ${sizeLabel(resumeAtt.file.size)}`
    : resumeAtt.source === 'none' ? '' : resumeAtt.option.detail;

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* Top bar — the customization page's */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={onBack} style={s.backPill} activeOpacity={0.8}>
          <Ionicons name={editing ? 'close' : 'arrow-back'} size={14} color={T.ink} />
          <Text style={s.backPillText}>{editing ? 'Cancel' : 'Back'}</Text>
        </TouchableOpacity>
        <View style={s.docHead} pointerEvents="none">
          <Text style={s.docEyebrow}>SEND COVER LETTER</Text>
          <Text style={s.docTitle} numberOfLines={1}>{`${employer} application`}</Text>
        </View>
        <View style={s.topSpacer} />
      </View>

      <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {phase === 'sent' && result ? (
            <View style={s.doneCard}>
              <View style={s.doneIcon}><Ionicons name="checkmark" size={28} color="#fff" /></View>
              <Text style={s.doneTitle}>Application sent</Text>
              <Text style={s.doneText}>
                {`Sent from ${result.from || providerName(result.provider)} to ${result.to.join(', ')}. It is in your ${providerName(result.provider)} Sent folder, and replies come straight to your inbox.`}
              </Text>
            </View>
          ) : null}

          {/* 1 — the mailbox it goes from */}
          <View style={s.acctCard}>
            <LinearGradient colors={['#0B1120', '#162550', '#0d1f45']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.acctGrad}>
              <View style={s.deco1} /><View style={s.deco2} />
              <View style={s.acctRow}>
                <View style={s.acctIcon}>
                  <Ionicons name={acct.provider === 'microsoft' ? 'logo-microsoft' : acct.provider === 'google' ? 'logo-google' : 'mail-outline'} size={20} color="#fff" />
                </View>
                <View style={s.fill}>
                  <Text style={s.acctEyebrow}>{ready ? 'SENDING FROM' : 'SEND FROM YOUR OWN MAILBOX'}</Text>
                  <Text style={s.acctAddr} numberOfLines={1}>
                    {ready ? (acct.address || who) : acct.reconnect ? `${who.charAt(0).toUpperCase()}${who.slice(1)} needs you to sign in again` : 'No mailbox connected yet'}
                  </Text>
                </View>
                {ready && (
                  <View style={s.okPill}>
                    <Ionicons name="checkmark-circle" size={11} color="#fff" />
                    <Text style={s.okPillText}>Connected</Text>
                  </View>
                )}
              </View>
              {!ready && (
                <Text style={s.acctWhy}>
                  Your application goes out from your own Gmail or Outlook: it lands in your Sent folder and replies come straight back to you. We never send it from our address.
                </Text>
              )}
              {(!ready || showSwitch) && phase !== 'sent' && (
                <View style={s.connectRow}>
                  {(['google', 'microsoft'] as MailProvider[]).map((p) => (
                    <TouchableOpacity key={p} style={s.connectBtn} activeOpacity={0.85} disabled={!!linking} onPress={() => connect(p)}>
                      {linking === p ? <ActivityIndicator size="small" color={T.ink} /> : <Ionicons name={p === 'google' ? 'logo-google' : 'logo-microsoft'} size={15} color={T.ink} />}
                      <Text style={s.connectText}>
                        {`${acct.reconnect && acct.provider === p ? 'Reconnect' : 'Connect'} ${p === 'google' ? 'Gmail' : 'Outlook'}`}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              {ready && !showSwitch && phase === 'idle' && (
                <TouchableOpacity onPress={() => setShowSwitch(true)} hitSlop={8} style={s.switchBtn}>
                  <Text style={s.switchText}>Use another account</Text>
                </TouchableOpacity>
              )}
            </LinearGradient>
          </View>

          {!!failure && phase === 'idle' && (
            <View style={s.errorCard}>
              <View style={s.errorHead}>
                <Ionicons name="alert-circle" size={16} color={T.rose} />
                <Text style={s.errorTitle}>{failure.title}</Text>
              </View>
              <Text style={s.errorText}>{failure.message}</Text>
              {failBtn ? (
                <TouchableOpacity onPress={failBtn.run} style={s.errorBtn} activeOpacity={0.85}><Text style={s.errorBtnText}>{failBtn.label}</Text></TouchableOpacity>
              ) : null}
            </View>
          )}

          {/* 2 — who it goes to */}
          <Section title="TO" icon="people-outline" color={T.violet} editing={false} busy={false} saving={false}>
            {to.length ? (
              <View style={s.chipsRow}>
                {to.map((e) => {
                  const name = contactName(e);
                  return (
                    <View key={e} style={s.toChip}>
                      <Ionicons name="person-circle-outline" size={14} color={T.violet} />
                      <Text style={s.toChipText} numberOfLines={1}>{name ? `${name} · ${e}` : e}</Text>
                      {!busy && (
                        <TouchableOpacity onPress={() => { setTo(removeRecipient(to, e)); setToError(null); }} hitSlop={8} accessibilityLabel={`Remove ${e}`}>
                          <Ionicons name="close" size={13} color={T.muted} />
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}
              </View>
            ) : (
              <Text style={s.emptyHint}>No address yet — add the recruiter’s or hiring manager’s email.</Text>
            )}
            {phase !== 'sent' && to.length < MAX_RECIPIENTS && (
              <View style={s.addRow}>
                <TextInput
                  ref={toRef}
                  value={toInput}
                  onChangeText={onToChange}
                  onSubmitEditing={() => addTyped(toInput)}
                  placeholder="name@company.com"
                  placeholderTextColor={T.faint}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  returnKeyType="done"
                  blurOnSubmit={false}
                  editable={!busy}
                  style={[s.input, s.addInput]}
                />
                <TouchableOpacity onPress={() => addTyped(toInput)} disabled={!toInput.trim() || busy} style={[s.addBtn, (!toInput.trim() || busy) && s.dim]} activeOpacity={0.85}>
                  <Ionicons name="add" size={15} color="#fff" /><Text style={s.addBtnText}>Add</Text>
                </TouchableOpacity>
              </View>
            )}
            {!!toError && <Text style={s.fieldError}>{toError}</Text>}
            {phase !== 'sent' && draft.recipients.suggestions.filter((c) => !to.some((a) => a.toLowerCase() === c.email.toLowerCase())).length > 0 && (
              <>
                <Text style={s.label}>{`Contacts we know at ${employer}`}</Text>
                <View style={s.chipsRow}>
                  {draft.recipients.suggestions
                    .filter((c) => !to.some((a) => a.toLowerCase() === c.email.toLowerCase()))
                    .map((c) => (
                      <TouchableOpacity key={c.email} style={s.suggestChip} activeOpacity={0.8} disabled={busy || to.length >= MAX_RECIPIENTS}
                        onPress={() => { const r = addRecipients(to, c.email); setTo(r.list); setToError(r.error); }}>
                        <Ionicons name="add-circle-outline" size={13} color={T.violet} />
                        <Text style={s.suggestText} numberOfLines={1}>{c.name ? `${c.name}${c.role ? ` · ${c.role}` : ''}` : c.email}</Text>
                      </TouchableOpacity>
                    ))}
                </View>
              </>
            )}
            <Text style={s.hint}>{`Up to ${MAX_RECIPIENTS} addresses. Each gets the same message.`}</Text>
          </Section>

          {/* 3 — the subject: the letter's own (its customization card) */}
          <Section
            title="SUBJECT" icon="pricetag-outline" color={T.cyan}
            editing={editing === 'subject'} busy={(!!editing && editing !== 'subject') || busy} saving={false}
            onEdit={() => startEdit('subject')} onDone={doneEdit} onCancel={cancelEdit}
          >
            {editing === 'subject' ? (
              <TextInput value={fieldDraft} onChangeText={(v) => setFieldDraft(v.replace(/[\r\n]+/g, ' '))} maxLength={SUBJECT_MAX}
                placeholder="Application for …" placeholderTextColor={T.faint} style={s.input} autoFocus />
            ) : subject ? <Text style={s.fieldText}>{subject}</Text> : <Text style={s.emptyHint}>No subject yet. Tap Edit to add one.</Text>}
          </Section>

          {/* 4 — the message, written from the letter */}
          <Section
            title="MESSAGE" icon="chatbox-ellipses-outline" color={T.blue}
            editing={editing === 'body'} busy={(!!editing && editing !== 'body') || busy} saving={false}
            onDone={doneEdit} onCancel={cancelEdit}
            actions={(
              <View style={s.msgActions}>
                <TouchableOpacity onPress={rewrite} disabled={bodyLoading} style={[s.rewriteBtn, bodyLoading && s.dim]} hitSlop={6} activeOpacity={0.8} accessibilityLabel="Rewrite the message">
                  <Ionicons name="sparkles-outline" size={12} color={T.violet} /><Text style={s.rewriteText}>Rewrite</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => startEdit('body')} disabled={bodyLoading} style={[sec.editBtn, bodyLoading && s.dim]} hitSlop={6} activeOpacity={0.8}>
                  <Ionicons name="create-outline" size={13} color={T.blue} /><Text style={sec.editText}>Edit</Text>
                </TouchableOpacity>
              </View>
            )}
          >
            {editing === 'body' ? (
              <TextInput value={fieldDraft} onChangeText={setFieldDraft} maxLength={BODY_MAX} multiline
                placeholder="Your message" placeholderTextColor={T.faint} style={[s.input, s.inputMulti]} autoFocus />
            ) : bodyLoading ? (
              <View style={s.shimmer}>
                <View style={[s.shimLine, s.shimW45]} />
                <View style={[s.shimLine, s.shimW96]} />
                <View style={[s.shimLine, s.shimW88]} />
                <View style={[s.shimLine, s.shimW70]} />
                <View style={s.shimNote}>
                  <ActivityIndicator size="small" color={T.blue} />
                  <Text style={s.shimText}>Writing a short note from your letter…</Text>
                </View>
              </View>
            ) : (
              <Text style={s.bodyText} selectable>{body}</Text>
            )}
            {!bodyLoading && editing !== 'body' && (
              <Text style={[s.hint, s.hintTight]}>
                {bodySource === 'ai' ? 'Written from your letter — free. Edit anything.'
                  : bodySource === 'user' ? 'Your message.'
                    : 'A short standard note. Tap Rewrite for one written from your letter — free.'}
              </Text>
            )}
          </Section>

          {/* 5 — the attachments, each with Change → the smart upload sheet */}
          <Section title="ATTACHMENTS" icon="attach-outline" color={T.emerald} editing={false} busy={false} saving={false}>
            <View style={s.attRow}>
              <View style={s.attThumb}>
                {letterAtt.source === 'doc' && thumb
                  ? <Image source={{ uri: thumb }} style={s.attThumbImg} contentFit="cover" />
                  : <Ionicons name={letterAtt.source === 'file' ? 'document-attach' : 'document-text'} size={20} color={T.violet} />}
              </View>
              <View style={s.fill}>
                <Text style={s.attTitle}>Cover letter</Text>
                <Text style={s.attSub} numberOfLines={1}>
                  {letterAtt.source === 'doc' ? `${designName} · ${modeLabel} · PDF` : `${letterAtt.file.name} · ${sizeLabel(letterAtt.file.size)}`}
                </Text>
                {letterAtt.source === 'doc' && locked && (
                  <View style={s.lockBadge}><Ionicons name="lock-closed" size={9} color={T.muted} /><Text style={s.lockText}>Paid plans</Text></View>
                )}
              </View>
              {uploading === 'letter' ? <ActivityIndicator size="small" color={T.blue} /> : phase === 'idle' ? (
                <TouchableOpacity onPress={() => openSheet('letter')} style={s.changeBtn} activeOpacity={0.8}>
                  <Text style={s.changeText}>Change</Text><Ionicons name="chevron-down" size={12} color={T.blue} />
                </TouchableOpacity>
              ) : null}
            </View>

            {resumeAtt.source === 'none' ? (
              uploading === 'resume' ? (
                <View style={[s.attRow, s.attRowTop]}><ActivityIndicator size="small" color={T.blue} /><Text style={s.attSub}>Uploading your file…</Text></View>
              ) : phase === 'idle' ? (
                <TouchableOpacity onPress={() => openSheet('resume')} style={s.addAtt} activeOpacity={0.85}>
                  <Ionicons name="add-circle-outline" size={16} color={T.blue} />
                  <Text style={s.addAttText}>Attach a résumé</Text>
                </TouchableOpacity>
              ) : null
            ) : (
              <View style={[s.attRow, s.attRowTop]}>
                <View style={s.attThumb}>
                  <Ionicons name={resumeAtt.source === 'tailored' ? 'sparkles' : resumeAtt.source === 'file' ? 'document-attach' : 'person-outline'} size={19} color={T.emerald} />
                </View>
                <View style={s.fill}>
                  <Text style={s.attTitle} numberOfLines={1}>{resumeTitle || 'Résumé'}</Text>
                  <Text style={s.attSub} numberOfLines={1}>{resumeSub}</Text>
                  {isGated(resumeAtt) && locked && (
                    <View style={s.lockBadge}><Ionicons name="lock-closed" size={9} color={T.muted} /><Text style={s.lockText}>Paid plans</Text></View>
                  )}
                </View>
                {uploading === 'resume' ? <ActivityIndicator size="small" color={T.blue} /> : phase === 'idle' ? (
                  <View style={s.attActions}>
                    <TouchableOpacity onPress={() => openSheet('resume')} style={s.changeBtn} activeOpacity={0.8}>
                      <Text style={s.changeText}>Change</Text><Ionicons name="chevron-down" size={12} color={T.blue} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setResumeAtt({ source: 'none' })} hitSlop={8} style={s.removeBtn} accessibilityLabel="Remove the résumé">
                      <Ionicons name="close" size={14} color={T.muted} />
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            )}
            <Text style={[s.hint, s.hintTight]}>
              {gatedNow && locked
                ? 'Attaching the PDFs works like downloading them — part of the paid plans. Nothing is charged unless the message is sent.'
                : `Sent from your ${who === 'your mail account' ? 'mailbox' : who}. Nothing is charged unless the message is sent.`}
            </Text>
          </Section>

          <View style={editing ? s.tailShort : s.tail} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* The Send bar (hidden while a field is edited) — the customization page's floating bar */}
      {!editing && (
        <View style={s.floatingBar}>
          {!!barNote && <Text style={s.whyText}>{barNote}</Text>}
          <TouchableOpacity
            onPress={() => (phase === 'sent' ? leave() : doSend())}
            activeOpacity={0.88}
            disabled={phase === 'sending' || (phase === 'idle' && !check.ok)}
            style={[s.primaryOuter, phase === 'idle' && !check.ok && s.dim]}
            accessibilityLabel={sendLabel}
          >
            <LinearGradient colors={phase === 'sent' ? ['#10B981', '#059669'] : ['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.primaryBtn}>
              {phase === 'sending' ? <ActivityIndicator size="small" color="#fff" />
                : <Ionicons name={phase === 'sent' ? 'checkmark-done' : needsPay ? 'lock-closed' : 'send'} size={16} color="#fff" />}
              <Text style={s.primaryText}>{sendLabel}</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      )}

      <SmartAttachSheet
        visible={!!sheet}
        title={sheet === 'letter' ? 'Attach your cover letter' : 'Attach a résumé'}
        subtitle={sheet === 'letter' ? `The letter you wrote for ${employer}, or a file of your own` : `The résumé for ${employer}, your usual one, or a file of your own`}
        options={sheet === 'letter' ? letterOptions : resumeOptions}
        busyKey={uploading ? 'device' : null}
        onPick={onPick}
        onDevice={onDevice}
        onClose={() => setSheet(null)}
      />
      {/* Closing re-reads the state: a pass bought elsewhere (or a read that failed before) redraws the padlock. */}
      <DownloadPaywallSheet
        visible={payOpen}
        employer={draft.letter.employer || null}
        onClose={() => { setPayOpen(false); refreshDl(); }}
        onSeePlans={() => router.push('/(subscription)/plans' as never)}
        onUnlocked={onUnlocked}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: T.bg },
  fill:         { flex: 1 },
  center:       { justifyContent: 'center', alignItems: 'center' },
  dim:          { opacity: 0.45 },
  loadingText:  { fontSize: 13, fontWeight: '600', color: T.muted, marginTop: 12 },
  emptyWrap:    { gap: 12, paddingHorizontal: 32 },
  emptyTitle:   { fontSize: 16, fontWeight: '700', color: T.ink, textAlign: 'center' },
  emptyText:    { fontSize: 13, color: T.muted, textAlign: 'center', lineHeight: 19 },
  retryBtn:     { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(79,141,255,0.1)', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 8, borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)' },
  retryText:    { fontSize: 13, fontWeight: '700', color: T.blueDeep },
  goBackBtn:    { backgroundColor: T.blue, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 10 },
  goBackText:   { color: '#fff', fontWeight: '700' },

  topBar:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  backPill:     { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.surface, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 3, zIndex: 1 },
  backPillText: { fontSize: 13, fontWeight: '600', color: T.ink },
  docHead:      { position: 'absolute', left: 96, right: 96, alignItems: 'center', justifyContent: 'center', zIndex: 0 },
  docEyebrow:   { fontSize: 9, fontWeight: '800', color: T.faint, letterSpacing: 1.2 },
  docTitle:     { fontSize: 15, fontWeight: '800', color: T.ink, letterSpacing: -0.3, marginTop: 1 },
  topSpacer:    { width: 72 },
  scroll:       { padding: 16 },

  doneCard:     { alignItems: 'center', gap: 8, backgroundColor: T.surface, borderRadius: 20, padding: 20, marginBottom: 12, borderWidth: 1.5, borderColor: T.emerald + '55' },
  doneIcon:     { width: 52, height: 52, borderRadius: 26, backgroundColor: T.emerald, alignItems: 'center', justifyContent: 'center' },
  doneTitle:    { fontSize: 17, fontWeight: '800', color: T.ink },
  doneText:     { fontSize: 13, color: T.muted, textAlign: 'center', lineHeight: 19 },

  acctCard:     { borderRadius: 24, overflow: 'hidden', marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.2, shadowRadius: 20, elevation: 9 },
  acctGrad:     { padding: 18, gap: 12 },
  deco1:        { position: 'absolute', width: 150, height: 150, borderRadius: 75, backgroundColor: 'rgba(6,182,212,0.12)', top: -50, right: -40 },
  deco2:        { position: 'absolute', width: 90, height: 90, borderRadius: 45, backgroundColor: 'rgba(167,139,250,0.14)', bottom: -30, left: -20 },
  acctRow:      { flexDirection: 'row', alignItems: 'center', gap: 12 },
  acctIcon:     { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(255,255,255,0.14)', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.25)', alignItems: 'center', justifyContent: 'center' },
  acctEyebrow:  { fontSize: 9, fontWeight: '800', color: 'rgba(255,255,255,0.6)', letterSpacing: 1.2 },
  acctAddr:     { fontSize: 15, fontWeight: '800', color: '#fff', marginTop: 2 },
  okPill:       { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(16,185,129,0.85)', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4 },
  okPillText:   { fontSize: 10.5, fontWeight: '800', color: '#fff' },
  acctWhy:      { fontSize: 12, color: 'rgba(255,255,255,0.75)', lineHeight: 17 },
  connectRow:   { flexDirection: 'row', gap: 8 },
  connectBtn:   { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#fff', borderRadius: 14, paddingVertical: 11 },
  connectText:  { fontSize: 13, fontWeight: '800', color: T.ink },
  switchBtn:    { alignSelf: 'flex-start' },
  switchText:   { fontSize: 12, fontWeight: '700', color: 'rgba(255,255,255,0.7)', textDecorationLine: 'underline' },

  errorCard:    { backgroundColor: 'rgba(239,68,68,0.07)', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(239,68,68,0.22)', padding: 14, marginBottom: 12, gap: 6 },
  errorHead:    { flexDirection: 'row', alignItems: 'center', gap: 6 },
  errorTitle:   { fontSize: 13.5, fontWeight: '800', color: T.rose },
  errorText:    { fontSize: 12.5, color: T.inkSoft, lineHeight: 18 },
  errorBtn:     { alignSelf: 'flex-start', backgroundColor: T.rose, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 7, marginTop: 4 },
  errorBtnText: { fontSize: 12.5, fontWeight: '800', color: '#fff' },

  chipsRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  toChip:       { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%', borderRadius: 14, borderWidth: 1, borderColor: T.violet + '40', backgroundColor: T.violet + '14', paddingHorizontal: 10, paddingVertical: 6 },
  toChipText:   { fontSize: 12.5, fontWeight: '700', color: T.inkSoft, flexShrink: 1 },
  suggestChip:  { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%', borderRadius: 12, borderWidth: 1, borderColor: T.border, backgroundColor: T.bgSoft, paddingHorizontal: 9, paddingVertical: 6 },
  suggestText:  { fontSize: 11.5, fontWeight: '600', color: T.inkSoft, flexShrink: 1 },
  addRow:       { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addInput:     { flex: 1, marginBottom: 0 },
  addBtn:       { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: T.violet, borderRadius: 10, paddingHorizontal: 12, paddingVertical: Platform.select({ ios: 10, default: 9 }) },
  addBtnText:   { fontSize: 12.5, fontWeight: '800', color: '#fff' },
  fieldError:   { fontSize: 12, color: T.rose, fontWeight: '600', marginTop: 6 },
  label:        { fontSize: 11, fontWeight: '700', color: T.muted, marginBottom: 6, marginTop: 10 },

  input:        { backgroundColor: T.bgSoft, borderRadius: 10, borderWidth: 1, borderColor: T.border, paddingHorizontal: 12, paddingVertical: Platform.select({ ios: 10, default: 8 }), fontSize: 13, color: T.ink, marginBottom: 8 },
  inputMulti:   { minHeight: 180, textAlignVertical: 'top' },
  fieldText:    { fontSize: 13.5, color: T.ink, lineHeight: 20 },
  bodyText:     { fontSize: 13, color: T.inkSoft, lineHeight: 20 },
  emptyHint:    { fontSize: 12.5, color: T.faint, lineHeight: 18, marginBottom: 8 },
  hint:         { fontSize: 11.5, color: T.faint, lineHeight: 16, marginTop: 6 },
  hintTight:    { marginTop: 8 },

  msgActions:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rewriteBtn:   { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: T.violet + '18', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: T.violet + '33' },
  rewriteText:  { fontSize: 11.5, fontWeight: '700', color: T.violet },
  shimmer:      { gap: 8, paddingVertical: 2 },
  shimLine:     { height: 10, borderRadius: 5, backgroundColor: T.bgSoft },
  shimW45:      { width: '45%' },
  shimW96:      { width: '96%' },
  shimW88:      { width: '88%' },
  shimW70:      { width: '70%' },
  shimNote:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  shimText:     { fontSize: 12, color: T.muted, fontWeight: '600' },

  attRow:       { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: T.bgSoft, borderRadius: 14, padding: 10 },
  attRowTop:    { marginTop: 8 },
  attThumb:     { width: 40, height: 52, borderRadius: 8, backgroundColor: T.surface, borderWidth: 1, borderColor: T.border, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  attThumbImg:  { width: 40, height: 52 },
  attTitle:     { fontSize: 13.5, fontWeight: '800', color: T.ink },
  attSub:       { fontSize: 11.5, color: T.muted, marginTop: 1 },
  attActions:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lockBadge:    { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-start', backgroundColor: T.surface, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2, marginTop: 4 },
  lockText:     { fontSize: 10, fontWeight: '800', color: T.muted },
  changeBtn:    { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 5, paddingHorizontal: 9, borderRadius: 9, backgroundColor: 'rgba(79,141,255,0.1)' },
  changeText:   { fontSize: 12.5, fontWeight: '700', color: T.blue },
  removeBtn:    { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: T.surface },
  addAtt:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 8, borderRadius: 14, borderWidth: 1.5, borderStyle: 'dashed', borderColor: T.blue + '55', paddingVertical: 14 },
  addAttText:   { fontSize: 13, fontWeight: '700', color: T.blue },

  tail:         { height: 120 },
  tailShort:    { height: 32 },
  floatingBar:  { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.border, paddingHorizontal: 16, paddingTop: 10, paddingBottom: Platform.select({ ios: 28, default: 16 }), gap: 6, shadowColor: T.ink, shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 12 },
  whyText:      { fontSize: 11.5, color: T.muted, textAlign: 'center', fontWeight: '600' },
  primaryOuter: { borderRadius: 16, overflow: 'hidden' },
  primaryBtn:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, height: 50, borderRadius: 16 },
  primaryText:  { fontSize: 14.5, fontWeight: '800', color: '#fff' },
});
