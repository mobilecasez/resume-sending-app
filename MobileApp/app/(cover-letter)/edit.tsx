// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE LETTER CUSTOMIZATION PAGE (route /(cover-letter)/edit, param `docId`): one employer's own cover letter — the
// version the AI wrote for THAT company (user_employer_documents, kind 'cover_letter') — opened from Home's letter page
// (Customize my Cover Letter). Loaded via GET /employer-docs/:id, saved via PUT /employer-docs/:id.
//
// THE OWNER'S ASK (2026-09-19): "make it like the Resume customization page, with multiple edit buttons — divide the
// paragraphs with edit buttons, then photo on top, then Subject, address of the employer — whatever details are on the
// PDF should come in an editable page … with bold formatting retained". So this page is the résumé page's twin, built
// from the same pieces (components/rich-text/RichText): the hero with the photo, Section cards with Edit / Cancel / Done,
// one card per paragraph, the same Quill box. Top to bottom it follows the printed letter:
//   hero (photo, name, title, contacts)  → FROM (payload.sender, over the profile)
//   DATE                                 → read-only: every design prints the day of the download
//   TO                                   → payload.companyName / companyAddress (the Original design's "Hiring Manager," as is)
//   SUBJECT                              → payload.subject — stored with the letter, NOT printed by any design (said so)
//   GREETING                             → payload.salutation ('' = the design's own line)
//   PARAGRAPH 1…n                        → payload.coverLetterHtml, one card per <p> (services/letterHtml)
//   SIGN-OFF                             → payload.closing + the name + the signature (read-only; Original design only)
//
// ⚠️ NOTHING HERE GENERATES OR CHARGES. Every write is saveDocPayload (PUT, the user's own words, never an AI call);
// Download / Preview only opens the gallery, which charges nothing until the user taps a download there.
//
// ⚠️ BOLD STAYS BOLD. A paragraph card shows its <strong> runs bold (ContentText), its Edit opens the résumé's Quill box
// holding the same <strong> (bold in the box too), and Quill hands <strong> back — narrowed to BOLD ONLY, the one format
// every design prints. Not a heading or underline (the server strips them), and NOT ITALIC: the Original (Branded)
// download is drawn by PDFKit (emailController.createCoverLetterPDFFromHTML) with a regular and a bold face only, so an
// italic run the card, the Original's own thumbnail and every other design showed slanted would print upright in that
// file. (The owner asked for bold; a stored <em> — the generator writes <strong> only — still shows in its card, as
// the HTML designs print it.)
// test-letter-editor proves every entry of LETTER_FORMATS prints in all 7 designs, the Word file and the PDFKit download.
// letterHtml.cleanInline escapes every text run on the way in, so a letter's own words can never become markup here.
//
// ⚠️ SAVED ON DONE, SAID OUT LOUD. A field card saves on Done (like the résumé); a paragraph saves when its editor's
// Done is tapped, and so does a move or a removal. A failed paragraph save keeps the edit ON SCREEN as "Not saved" with
// Retry and arms the unsaved-changes guard — the user is never told an edit was kept when it was not. 'gone' (the
// server says the doc no longer exists) → an Alert and back.
//
// ⚠️ AN UNTOUCHED LETTER IS NOT REWRITTEN. Saving a field card sends the stored letter HTML back byte for byte; only a
// paragraph change re-joins the cards. Only the fields the user changed are written (withLetterFields) — no sender /
// greeting / closing key appears on a letter nobody customised.
//
// ⚠️ DOWNLOAD / PREVIEW RENDERS THE SERVER'S COPY. The gallery (templates.tsx doc mode) re-reads the document by docId,
// so a paragraph edit that failed to save would silently be missing from the PDF — it retries first, and when that
// fails it asks instead of pretending ("View saved version" is the explicit way through).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Platform, TextInput, Alert, Image,
  KeyboardAvoidingView, Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
// usePreventRemove is the one guard that also reaches the NATIVE dismiss (see the unsaved-changes block below).
import { usePreventRemove, type NavigationAction } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../../config';
import { fetchDoc, saveDocPayload } from '../../services/employerDocs';
import { T, RichTextModal, ContentText, ProfileHero, Section, sec, type RichFormat } from '../../components/rich-text/RichText';
import {
  splitLetterParagraphs, joinLetterParagraphs, quillToBlocks, editorHtmlOf, hasText, oneLine,
  letterFieldsOf, withLetterFields, fieldsDiffer, effectiveSender,
  LINE_MAX, SUBJECT_MAX, ADDRESS_MAX,
  type LetterBlock, type LetterFields, type LetterSender, type SenderKey,
} from '../../services/letterHtml';

/** A route param → a real doc id, or null. Anything that is not a positive integer is "no doc". */
function docIdOf(raw: unknown): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The letter's editor makes only what EVERY design prints (see the header): bold. ⚠️ Not italic — the Original PDF can't. */
const LETTER_FORMATS: RichFormat[] = ['bold'];

/**
 * One authenticated GET (the profile photo / signature, the profile's sender block). null = no answer — these only
 * decorate the page, so a miss never blocks the letter. ⚠️ API_BASE is read per call (the admin switch reassigns it);
 * the store-environment header rides on fetch itself (services/storeEnv patches it for our origin).
 */
async function getJson(path: string, ms = 15000): Promise<any | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    const token = JSON.parse(raw || '{}')?.token;
    if (!token) return null;
    const r = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function todayLong(): string {
  try { return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch { return new Date().toDateString(); }
}

/* ── SMALL PIECES (the résumé page's inputs, in its styles) ──────────────────────────────────────── */

function EI({ value, onChange, placeholder, multiline, maxLength, editable = true }: {
  value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean; maxLength?: number; editable?: boolean;
}) {
  return (
    <TextInput
      value={value || ''}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={T.faint}
      multiline={!!multiline}
      maxLength={maxLength}
      editable={editable}
      blurOnSubmit={!multiline}
      returnKeyType={multiline ? 'default' : 'done'}
      style={[ed.input, multiline && ed.inputMulti, !editable && ed.inputOff]}
    />
  );
}
function Label({ text }: { text: string }) { return <Text style={ed.label}>{text}</Text>; }
function AddBtn({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} style={[ed.addBtn, disabled && ed.dim]} activeOpacity={0.8}>
      <Ionicons name="add" size={15} color={T.blue} /><Text style={ed.addText}>{label}</Text>
    </TouchableOpacity>
  );
}
function IconBtn({ icon, color, onPress, disabled, label }: { icon: any; color: string; onPress: () => void; disabled?: boolean; label: string }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} hitSlop={6} style={[ed.iconBtn, disabled && ed.dim]} accessibilityLabel={label}>
      <Ionicons name={icon} size={15} color={color} />
    </TouchableOpacity>
  );
}

/* ── THE SCREEN ────────────────────────────────────────────────────────────────────────────────────── */

type Loaded = { employer: string; payload: Record<string, any> };
type FieldCard = 'from' | 'to' | 'subject' | 'greeting' | 'signoff';
/** The paragraph editor's target: an index to replace, or null to append (Add paragraph). */
type RichTarget = { title: string; initial: string; index: number | null };

export default function CoverLetterEdit() {
  const router = useRouter();
  const navigation = useNavigation();
  const { docId: wantDocId } = useLocalSearchParams<{ docId?: string }>();
  const docId = docIdOf(wantDocId);   // constant for the life of the screen

  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);                     // Try again
  const [doc, setDoc] = useState<Loaded | null>(null);
  // The profile: the photo and signature (GET /users/profile — both read-only here), and the sender block the letter
  // prints where it does not override it (GET /employer-docs/:id/sender — buildCLSender, the renderers' own reading).
  const [photo, setPhoto] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [basics, setBasics] = useState<Partial<LetterSender> | null>(null);
  const [profileSender, setProfileSender] = useState<LetterSender | null>(null);
  const [senderState, setSenderState] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [senderNonce, setSenderNonce] = useState(0);
  // The field card being edited, what it opened with, and its working copy (only the difference is written).
  const [editing, setEditing] = useState<FieldCard | null>(null);
  const [opened, setOpened] = useState<LetterFields | null>(null);
  const [draft, setDraft] = useState<LetterFields | null>(null);
  // Paragraph changes the server has NOT confirmed (a failed save) — shown, guarded, retried. null = none.
  const [bodyDraft, setBodyDraft] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [rich, setRich] = useState<RichTarget | null>(null);
  const savingRef = useRef(false);
  // Leaving on purpose (gone, discard confirmed) must not trip the unsaved-changes guard.
  // The REF is for code that runs right after an await (no re-render in between); the STATE is what the
  // usePreventRemove condition reads — a ref flip alone would leave the guard (and iOS's blocked swipe) armed.
  // exit.action = the navigation the user confirmed discarding for; no action = a plain back (goneOut).
  const leavingRef = useRef(false);
  const [exit, setExit] = useState<{ action?: NavigationAction } | null>(null);

  const storedHtml = doc && typeof doc.payload.coverLetterHtml === 'string' ? doc.payload.coverLetterHtml : '';
  const bodyHtml = bodyDraft ?? storedHtml;
  const blocks = useMemo(() => splitLetterParagraphs(bodyHtml), [bodyHtml]);
  const fields = useMemo(() => (doc ? letterFieldsOf(doc.payload, doc.employer, profileSender) : null), [doc, profileSender]);
  const fieldDirty = !!editing && fieldsDiffer(opened, draft);
  // Armed while a field card holds an unsaved change, a paragraph change is not on the server, or a save is in flight.
  const dirty = fieldDirty || bodyDraft !== null || saving;

  const goneOut = useCallback(() => {
    leavingRef.current = true;
    Alert.alert('This letter is gone', 'It is no longer saved. Your other cover letters are unchanged.');
    setExit({});   // the back() itself runs in the exit effect, once the guard is down
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!docId) { setLoadFailed('This link does not point to a saved cover letter.'); setLoading(false); return; }
      setLoading(true);
      setLoadFailed(null);
      const d = await fetchDoc(docId).catch(() => null);
      if (!alive) return;
      if (d === 'gone') { setLoading(false); goneOut(); return; }
      if (!d) { setLoadFailed('Could not load your cover letter. Check your connection and try again.'); setLoading(false); return; }
      // A résumé doc id here would be edited as a letter and saved back as one — refuse to open it.
      if (d.kind !== 'cover_letter') { setLoadFailed('This document is not a cover letter.'); setLoading(false); return; }
      const p = d.payload && typeof d.payload === 'object' ? d.payload : {};
      setDoc({ employer: d.employer || '', payload: p });
      setBodyDraft(null);
      setBodyError(null);
      setLoading(false);
    })();
    return () => { alive = false; };
    // goneOut is stable for this screen; nonce is the retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, nonce]);

  // The profile pieces decorate the page and never hold the letter back; the sender block alone gates the FROM edits
  // (an override is only written against the real profile value, see withLetterFields).
  useEffect(() => {
    if (!docId) return;
    let alive = true;
    (async () => {
      setSenderState('loading');
      const [prof, snd] = await Promise.all([getJson('/users/profile'), getJson(`/employer-docs/${docId}/sender`)]);
      if (!alive) return;
      if (prof) {
        setPhoto(prof.profileImage || prof.profile_image || null);
        setSignature(typeof prof.signature === 'string' && prof.signature ? prof.signature : null);
        setBasics({ name: prof.fullName || '', email: prof.email || '', phone: prof.phone || '' });
      }
      const s = snd && snd.success !== false && snd.sender && typeof snd.sender === 'object' ? snd.sender : null;
      if (s) { setProfileSender(effectiveSender(s, null)); setSenderState('ok'); } else setSenderState('failed');
    })();
    return () => { alive = false; };
  }, [docId, senderNonce]);

  /**
   * Store a payload. true = it is on the server now. false = it is NOT (the reason was already said out loud, unless
   * `quiet`); 'gone' leaves the screen. A second save while one is in flight is refused, never queued.
   */
  const persist = async (next: Record<string, any>, opts: { quiet?: boolean } = {}): Promise<boolean> => {
    if (!doc || !docId || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      const r = await saveDocPayload(docId, next).catch(() => ({ ok: false as const, reason: 'network' as const, message: undefined }));
      if (r.ok) {
        setDoc((cur) => (cur ? { ...cur, payload: next } : cur));
        setSavedOnce(true);
        return true;
      }
      if (r.reason === 'gone') { goneOut(); return false; }
      if (!opts.quiet && !leavingRef.current) {
        if (r.reason === 'too_big') Alert.alert('Too long to save', 'This letter is too long to store. Shorten it and try again.');
        else Alert.alert('Could not save', r.message || 'Check your connection and try again.');
      }
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  /* ── field cards ── */

  const startEdit = (card: FieldCard) => {
    if (!fields || saving || editing) return;
    if (card === 'from' && !profileSender) return;   // the Edit is not drawn then either
    const copy: LetterFields = { ...fields, sender: { ...fields.sender } };
    setOpened(copy);
    setDraft({ ...copy, sender: { ...copy.sender } });
    setEditing(card);
  };
  const cancelEdit = () => {
    if (saving) return;
    Keyboard.dismiss();
    setEditing(null); setOpened(null); setDraft(null);
  };
  const setField = (k: 'companyName' | 'companyAddress' | 'subject' | 'salutation' | 'closing', v: string) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));
  const setSender = (k: SenderKey, v: string) => setDraft((d) => (d ? { ...d, sender: { ...d.sender, [k]: v } } : d));

  const saveCard = async () => {
    if (!doc || !editing || !draft || !opened || savingRef.current) return;
    Keyboard.dismiss();
    if (!fieldsDiffer(opened, draft)) { cancelEdit(); return; }   // nothing changed: nothing to store
    // Only what changed — the letter HTML rides along exactly as stored (see the header).
    const next = withLetterFields(doc.payload, opened, draft, profileSender);
    if (await persist(next)) { setEditing(null); setOpened(null); setDraft(null); }
  };

  /* ── paragraph cards ── */

  /** The cards, re-joined and stored. Refused before any request when no paragraph would have words left. */
  const commitBlocks = async (next: LetterBlock[], opts: { quiet?: boolean } = {}): Promise<boolean> => {
    if (!doc || savingRef.current) return false;
    if (!next.some((b) => hasText(b.html))) {
      Alert.alert('A letter needs some text', 'Keep at least one paragraph with words in it.');
      return false;
    }
    const html = joinLetterParagraphs(next);
    if (bodyDraft === null && html === joinLetterParagraphs(blocks)) return true;   // nothing moved: nothing to store
    setBodyDraft(html);
    setBodyError(null);
    if (await persist({ ...doc.payload, coverLetterHtml: html }, opts)) { setBodyDraft(null); return true; }
    if (!leavingRef.current) setBodyError('Your last paragraph change is not saved yet.');
    return false;
  };
  const retryBody = (opts: { quiet?: boolean } = {}) => (bodyDraft === null ? Promise.resolve(true) : commitBlocks(splitLetterParagraphs(bodyDraft), opts));

  const openParagraph = (index: number | null) => {
    if (editing || saving) return;
    const b = index == null ? null : blocks[index];
    setRich({ title: index == null ? 'New paragraph' : `Paragraph ${index + 1}`, initial: editorHtmlOf(b), index });
  };
  const onRichDone = (html: string) => {
    const target = rich;
    setRich(null);
    if (!target) return;
    const replacement = quillToBlocks(html);
    if (target.index == null) {
      if (replacement.length) commitBlocks([...blocks, ...replacement]);   // an empty new paragraph adds nothing
      return;
    }
    commitBlocks([...blocks.slice(0, target.index), ...replacement, ...blocks.slice(target.index + 1)]);
  };
  const moveBlock = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= blocks.length || saving) return;
    const next = blocks.slice();
    [next[i], next[j]] = [next[j], next[i]];
    commitBlocks(next);
  };
  const removeBlock = (i: number) => {
    if (saving) return;
    const next = blocks.filter((_, j) => j !== i);
    if (!next.some((b) => hasText(b.html))) {
      Alert.alert('A letter needs some text', 'This is the last paragraph. Edit it instead of removing it.');
      return;
    }
    Alert.alert(`Remove paragraph ${i + 1}?`, 'It is taken out of this letter only. Your other letters are unchanged.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => { commitBlocks(next); } },
    ]);
  };

  /* ── the gallery ── */

  const openGallery = async (html: string) => {
    if (!doc || !docId) return;
    const p = doc.payload || {};
    try {
      // The gallery's doc mode trusts a stashed context only when its docId matches (templates.tsx), and
      // re-reads the document by docId either way — the context just names the company without a flash.
      await AsyncStorage.setItem('coverLetterPickerContext', JSON.stringify({
        coverLetterHtml: html,
        companyName: p.companyName,
        companyAddress: p.companyAddress,
        employer: doc.employer,
        docId,
      }));
    } catch { /* the route's docId alone is enough for the gallery */ }
    router.push({ pathname: '/(cover-letter)/templates', params: { docId: String(docId) } } as never);
  };

  const onViewPdf = async () => {
    if (!doc || savingRef.current || editing) return;
    Keyboard.dismiss();
    if (bodyDraft === null) { openGallery(storedHtml); return; }
    const pending = bodyDraft;
    if (await retryBody({ quiet: true })) { openGallery(pending); return; }
    if (leavingRef.current) return;
    Alert.alert(
      'Your changes are not saved',
      'The PDF shows the letter as it is saved on our side, so it would not include your latest edits.',
      [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'View saved version', onPress: () => openGallery(storedHtml) },
      ],
    );
  };

  // Unsaved edits: the Back pill, the Android back button and the iOS swipe all meet ONE guard.
  // ⚠️ WHY usePreventRemove AND NOT setOptions({ gestureEnabled }) + a beforeRemove listener: Home pushes
  // /(cover-letter)/edit, so the screen the user swipes away on the ROOT stack is the (cover-letter) group,
  // not this inner screen — gestureEnabled here changed the wrong navigator, and a raw beforeRemove listener
  // cannot cancel a native dismiss. usePreventRemove reports up through every nested navigator, so the root
  // native stack sets preventNativeDismiss on the group: the swipe is refused natively and arrives as a pop,
  // which lands in this callback like any other removal (router.back, router.replace, hardware back).
  // The Discard path does not dispatch from inside the callback: the hook reads its condition from the last
  // render, so the action waits in `exit` until a render with the guard down (the effect below).
  usePreventRemove(dirty && !exit, ({ data }) => {
    const inFlight = savingRef.current;
    Alert.alert(
      inFlight ? 'Still saving' : 'Discard your changes?',
      inFlight ? 'Your last change is still being saved. If you leave now it may not be kept.' : 'Your edits to this letter are not saved.',
      [
        { text: 'Keep editing', style: 'cancel' },
        {
          text: 'Discard', style: 'destructive',
          onPress: () => { leavingRef.current = true; setExit({ action: data.action }); },
        },
      ],
    );
  });

  useEffect(() => {
    if (!exit) return;
    if (exit.action) navigation.dispatch(exit.action);
    else if (router.canGoBack()) router.back();
    // router / navigation are stable for this screen; exit is set once (leaving is one-way).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exit]);

  // The Back pill goes through the same removal as the hardware back, so unsaved changes ask here too.
  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/' as never);
  };

  /* ── RENDER ── */

  if (loading) {
    return (
      <SafeAreaView style={[s.safe, s.center]} edges={['top']}>
        <ActivityIndicator size="large" color={T.blue} />
      </SafeAreaView>
    );
  }
  if (!doc || !fields) {
    return (
      <SafeAreaView style={[s.safe, s.center, s.emptyWrap]} edges={['top']}>
        <Ionicons name="document-text-outline" size={48} color={T.faint} />
        <Text style={s.emptyTitle}>Could not open this letter</Text>
        {!!loadFailed && <Text style={s.emptyText}>{loadFailed}</Text>}
        {!!docId && (
          <TouchableOpacity onPress={() => setNonce((n) => n + 1)} style={s.retryBtn} activeOpacity={0.85}>
            <Ionicons name="refresh-outline" size={14} color={T.blueDeep} /><Text style={s.retryText}>Try again</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={leave} style={s.goBackBtn} activeOpacity={0.85}>
          <Text style={s.goBackText}>Go Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const p = doc.payload || {};
  const cur: LetterFields = editing && draft ? draft : fields;
  // What the hero prints: the letter's overrides over the profile (over /users/profile's basics while the sender block
  // is unknown — display only; edits wait for the real block).
  const shownSender = effectiveSender(profileSender || basics, p.sender);
  const heroSender = editing === 'from' && draft ? draft.sender : shownSender;
  const offices = Array.from(new Set((Array.isArray(p.locations) ? p.locations : [])
    .map((l: any) => oneLine(l && l.address, ADDRESS_MAX)).filter(Boolean))) as string[];
  const cardBusy = editing !== null;             // a field card is open → the other Edit buttons step aside
  const sectionProps = (card: FieldCard) => ({
    editing: editing === card, busy: cardBusy && editing !== card, saving,
    onEdit: () => startEdit(card), onDone: saveCard, onCancel: cancelEdit,
  });
  const showSave = fieldDirty || bodyDraft !== null;

  let statusIcon: any = 'checkmark-circle';
  let statusText = '';
  let statusColor = T.emerald;
  if (saving) { statusIcon = 'ellipse-outline'; statusText = 'Saving…'; statusColor = T.blue; }
  else if (bodyDraft !== null) { statusIcon = 'alert-circle'; statusText = 'Not saved'; statusColor = T.rose; }
  else if (savedOnce && !fieldDirty) { statusText = 'Saved'; }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* Top bar */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={editing ? cancelEdit : leave} style={s.backPill} activeOpacity={0.8}>
          <Ionicons name={editing ? 'close' : 'arrow-back'} size={14} color={T.ink} />
          <Text style={s.backPillText}>{editing ? 'Cancel' : 'Back'}</Text>
        </TouchableOpacity>
        {/* Say WHOSE letter this is — editing it changes nothing for any other employer. */}
        <View style={s.docHead} pointerEvents="none">
          <Text style={s.docEyebrow}>TAILORED COVER LETTER</Text>
          <Text style={s.docTitle} numberOfLines={1}>{doc.employer ? `${doc.employer} letter` : 'Employer letter'}</Text>
        </View>
        {showSave ? (
          <TouchableOpacity
            onPress={() => { if (editing) saveCard(); else retryBody(); }}
            style={[s.saveBtn, saving && ed.dim]}
            activeOpacity={0.8}
            disabled={saving}
            accessibilityLabel="Save letter"
          >
            {saving ? <ActivityIndicator size="small" color={T.blue} /> : <Ionicons name="checkmark-circle-outline" size={14} color={T.blue} />}
            <Text style={s.saveText}>{saving ? 'Saving' : 'Save'}</Text>
          </TouchableOpacity>
        ) : <View style={s.savePlaceholder} />}
      </View>

      <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {/* 1 — the sender, as the letterhead prints it */}
          <ProfileHero
            photo={photo}
            name={heroSender.name}
            subtitle={heroSender.title}
            contacts={[
              { icon: 'mail-outline', text: heroSender.email },
              { icon: 'call-outline', text: heroSender.phone },
              { icon: 'location-outline', text: heroSender.location },
            ]}
            onEdit={!cardBusy && profileSender ? () => startEdit('from') : undefined}
          />
          {senderState === 'failed' && !editing && (
            <TouchableOpacity onPress={() => setSenderNonce((n) => n + 1)} style={s.noteCard} activeOpacity={0.85}>
              <Ionicons name="cloud-offline-outline" size={15} color={T.muted} />
              <Text style={s.noteText}>Could not load your details, so they cannot be edited yet.</Text>
              <Text style={s.noteAction}>Try again</Text>
            </TouchableOpacity>
          )}

          {/* FROM — opened by the hero's Edit, like the résumé's DETAILS */}
          {editing === 'from' && draft && (
            <Section title="FROM" icon="person-outline" color={T.blue} {...sectionProps('from')}>
              <View style={s.photoRow}>
                <View style={s.photoThumb}>
                  {photo ? <Image source={{ uri: photo }} style={s.photoImg} /> : <Ionicons name="person" size={18} color={T.faint} />}
                </View>
                <Text style={s.photoNote}>Your profile photo — change it in Profile. It prints on the Original (Branded) design.</Text>
              </View>
              <Label text="Full name" />
              <EI value={draft.sender.name} onChange={(v) => setSender('name', v)} placeholder={profileSender?.name || 'Your name'} maxLength={LINE_MAX} />
              <Label text="Title" />
              <EI value={draft.sender.title} onChange={(v) => setSender('title', v)} placeholder="e.g. Senior Software Engineer" maxLength={LINE_MAX} />
              <Label text="Email" />
              <EI value={draft.sender.email} onChange={(v) => setSender('email', v)} placeholder="email@example.com" maxLength={LINE_MAX} />
              <Label text="Phone" />
              <EI value={draft.sender.phone} onChange={(v) => setSender('phone', v)} placeholder="Phone" maxLength={LINE_MAX} />
              <Label text="Location" />
              <EI value={draft.sender.location} onChange={(v) => setSender('location', v)} placeholder="City, Country" maxLength={LINE_MAX} />
              <Text style={s.hint}>Changes print on this letter only — your profile stays as it is. A blank line is left off the letter (the Original design prints “Applicant” for a blank title); a blank name uses your profile name.</Text>
            </Section>
          )}

          {/* Save status — never silent */}
          {!!statusText && (
            <View style={s.statusRow}>
              <Ionicons name={statusIcon} size={12} color={statusColor} />
              <Text style={[s.statusText, { color: statusColor }]}>{statusText}</Text>
            </View>
          )}
          {!!bodyError && bodyDraft !== null && !saving && (
            <TouchableOpacity onPress={() => retryBody()} style={s.errorCard} activeOpacity={0.85}>
              <Ionicons name="alert-circle-outline" size={16} color={T.rose} />
              <Text style={s.errorText}>Not saved — {bodyError}</Text>
              <Text style={s.errorRetry}>Retry</Text>
            </TouchableOpacity>
          )}

          {/* 2 — the date every design prints */}
          <View style={s.dateCard}>
            <View style={[sec.iconWrap, s.dateIcon]}><Ionicons name="calendar-outline" size={14} color={T.cyan} /></View>
            <View style={s.fill}>
              <Text style={sec.title}>DATE</Text>
              <Text style={s.dateText}>{todayLong()}</Text>
            </View>
            <Text style={s.dateNote}>Dated the day{'\n'}you download</Text>
          </View>

          {/* 3 — the recipient */}
          <Section title="TO" icon="business-outline" color={T.violet} {...sectionProps('to')}>
            <Text style={s.toManager}>Hiring Manager,</Text>
            {editing === 'to' && draft ? (
              <>
                <Label text="Company name" />
                <EI value={draft.companyName} onChange={(v) => setField('companyName', v)} placeholder={doc.employer || 'Company'} maxLength={LINE_MAX} />
                <Label text="Address" />
                <EI value={draft.companyAddress} onChange={(v) => setField('companyAddress', v)} placeholder="Street, City, Country" multiline maxLength={ADDRESS_MAX} />
                {offices.length > 1 && (
                  <>
                    <Label text="Or pick an office we found" />
                    <View style={s.chipsRow}>
                      {offices.map((o) => (
                        <TouchableOpacity key={o} onPress={() => setField('companyAddress', o)} activeOpacity={0.8}
                          style={[s.officeChip, oneLine(draft.companyAddress, ADDRESS_MAX) === o && s.officeChipOn]}>
                          <Ionicons name="location-outline" size={12} color={T.violet} />
                          <Text style={s.officeText} numberOfLines={2}>{o}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </>
                )}
                <Text style={s.hint}>Line breaks print as commas. “Hiring Manager,” is printed as it is, on the Original (Branded) design only.</Text>
              </>
            ) : (
              <>
                <Text style={s.toCompany}>{cur.companyName || doc.employer || '—'}</Text>
                {cur.companyAddress ? <Text style={s.toAddress}>{cur.companyAddress}</Text> : <Text style={s.emptyHint}>No address. Tap Edit to add one.</Text>}
              </>
            )}
          </Section>

          {/* 4 — the subject (stored, never printed — and it says so) */}
          <Section title="SUBJECT" icon="pricetag-outline" color={T.cyan} {...sectionProps('subject')}>
            {editing === 'subject' && draft ? (
              <EI value={draft.subject} onChange={(v) => setField('subject', v.replace(/[\r\n]+/g, ' '))} placeholder="Application for …" maxLength={SUBJECT_MAX} />
            ) : cur.subject ? <Text style={s.fieldText}>{cur.subject}</Text> : <Text style={s.emptyHint}>No subject yet. Tap Edit to add one.</Text>}
            <Text style={[s.hint, s.hintTight]}>Saved with this letter only — handy as your email subject. The letter designs do not print a subject line.</Text>
          </Section>

          {/* 5 — the greeting */}
          <Section title="GREETING" icon="hand-right-outline" color={T.emerald} {...sectionProps('greeting')}>
            {editing === 'greeting' && draft ? (
              <>
                <EI value={draft.salutation} onChange={(v) => setField('salutation', v.replace(/[\r\n]+/g, ' '))} placeholder="Design default (Dear Hiring Manager,)" maxLength={LINE_MAX} />
                <Text style={[s.hint, s.hintTight]}>Leave it blank for each design’s own greeting — German Professional says “Dear Sir or Madam,”.</Text>
              </>
            ) : (
              <>
                <Text style={s.fieldText}>{cur.salutation || 'Dear Hiring Manager,'}</Text>
                {!cur.salutation && <Text style={[s.hint, s.hintTight]}>The design’s own greeting (German Professional: “Dear Sir or Madam,”).</Text>}
              </>
            )}
          </Section>

          {/* 6 — the letter, one card per paragraph */}
          {blocks.map((b, i) => (
            <Section
              key={`p${i}`}
              title={`PARAGRAPH ${i + 1}`}
              icon={b.kind === 'list' ? 'list-outline' : 'reorder-four-outline'}
              color={T.blue}
              editing={false}
              busy={cardBusy}
              saving={saving}
              actions={(
                <View style={s.paraActions}>
                  <IconBtn icon="chevron-up" color={T.muted} label={`Move paragraph ${i + 1} up`} onPress={() => moveBlock(i, -1)} disabled={saving || i === 0} />
                  <IconBtn icon="chevron-down" color={T.muted} label={`Move paragraph ${i + 1} down`} onPress={() => moveBlock(i, 1)} disabled={saving || i === blocks.length - 1} />
                  <IconBtn icon="trash-outline" color={T.rose} label={`Remove paragraph ${i + 1}`} onPress={() => removeBlock(i)} disabled={saving} />
                  <TouchableOpacity onPress={() => openParagraph(i)} disabled={saving} style={[sec.editBtn, saving && ed.dim]} hitSlop={6} activeOpacity={0.8}>
                    <Ionicons name="create-outline" size={13} color={T.blue} /><Text style={sec.editText}>Edit</Text>
                  </TouchableOpacity>
                </View>
              )}
            >
              <TouchableOpacity activeOpacity={0.7} onPress={() => openParagraph(i)} disabled={cardBusy || saving}>
                <ContentText text={b.kind === 'list' ? b.html : `<p>${b.html}</p>`} style={s.paraText} />
              </TouchableOpacity>
            </Section>
          ))}
          {!cardBusy && <AddBtn label="Add paragraph" onPress={() => openParagraph(null)} disabled={saving} />}

          {/* 7 — the sign-off */}
          <Section title="SIGN-OFF" icon="ribbon-outline" color={T.violet} {...sectionProps('signoff')}>
            {editing === 'signoff' && draft ? (
              <>
                <Label text="Closing" />
                <EI value={draft.closing} onChange={(v) => setField('closing', v.replace(/[\r\n]+/g, ' '))} placeholder="Design default (Sincerely,)" maxLength={LINE_MAX} />
                <Label text="Name printed under it" />
                {profileSender ? (
                  <EI value={draft.sender.name} onChange={(v) => setSender('name', v)} placeholder={profileSender.name || 'Your name'} maxLength={LINE_MAX} />
                ) : <Text style={s.fieldText}>{shownSender.name || '—'}</Text>}
                <Text style={[s.hint, s.hintTight]}>Leave the closing blank for each design’s own (Sincerely, / Best regards, / Respectfully, …).</Text>
              </>
            ) : (
              <>
                <Text style={s.fieldText}>{cur.closing || 'Sincerely,'}</Text>
                {!cur.closing && <Text style={[s.hint, s.hintTight]}>Each design prints its own closing (Sincerely, / Best regards, / Respectfully, / Yours faithfully, …).</Text>}
              </>
            )}
            {!!signature && (
              <View style={s.sigWrap}>
                <Image source={{ uri: signature }} style={s.sigImg} resizeMode="contain" />
                <Text style={s.sigNote}>Your signature prints on the Original (Branded) design.</Text>
              </View>
            )}
            {editing !== 'signoff' && <Text style={s.signName}>{shownSender.name || 'Your name'}</Text>}
          </Section>

          <View style={editing ? s.tailShort : s.tail} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Floating action bar (hidden while a card is edited) — like the résumé's; nothing here regenerates or charges. */}
      {!editing && (
        <View style={s.floatingBar}>
          <TouchableOpacity onPress={onViewPdf} activeOpacity={0.88} disabled={saving} style={[s.primaryOuter, saving && ed.dim]}>
            <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.primaryBtn}>
              {saving ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="download-outline" size={16} color="#fff" />}
              <Text style={s.primaryText}>Download / Preview</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      )}

      <RichTextModal
        visible={!!rich}
        title={rich?.title || ''}
        initialMd={rich?.initial || ''}
        formats={LETTER_FORMATS}
        hint={<>Select words, then tap <Text style={s.hintBold}>B</Text> for bold. Enter starts a new paragraph.</>}
        onCancel={() => setRich(null)}
        onDone={onRichDone}
      />
    </SafeAreaView>
  );
}

const ed = StyleSheet.create({
  input:      { backgroundColor: T.bgSoft, borderRadius: 10, borderWidth: 1, borderColor: T.border, paddingHorizontal: 12, paddingVertical: Platform.select({ ios: 10, default: 8 }), fontSize: 13, color: T.ink, marginBottom: 8 },
  inputMulti: { minHeight: 64, textAlignVertical: 'top' },
  inputOff:   { opacity: 0.55 },
  label:      { fontSize: 11, fontWeight: '700', color: T.muted, marginBottom: 4, marginTop: 4 },
  addBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 10, borderWidth: 1, borderColor: T.blue + '40', backgroundColor: T.blue + '10', paddingVertical: 11, marginBottom: 12 },
  addText:    { fontSize: 12.5, fontWeight: '700', color: T.blue },
  iconBtn:    { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: T.bgSoft },
  dim:        { opacity: 0.4 },
});

const s = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: T.bg },
  fill:         { flex: 1 },
  center:       { justifyContent: 'center', alignItems: 'center' },
  emptyWrap:    { gap: 12, paddingHorizontal: 32 },
  topBar:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  backPill:     { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.surface, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 3, zIndex: 1 },
  backPillText: { fontSize: 13, fontWeight: '600', color: T.ink },
  docHead:      { position: 'absolute', left: 96, right: 96, alignItems: 'center', justifyContent: 'center', zIndex: 0 },
  docEyebrow:   { fontSize: 9, fontWeight: '800', color: T.faint, letterSpacing: 1.2 },
  docTitle:     { fontSize: 15, fontWeight: '800', color: T.ink, letterSpacing: -0.3, marginTop: 1 },
  saveBtn:      { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(79,141,255,0.1)', borderRadius: 16, paddingVertical: 7, paddingHorizontal: 12, borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)', zIndex: 1 },
  saveText:     { fontSize: 12, fontWeight: '700', color: T.blue },
  savePlaceholder: { width: 72 },
  scroll:       { padding: 16 },

  noteCard:     { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: T.surface, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12, borderWidth: 1, borderColor: T.border },
  noteText:     { flex: 1, fontSize: 12, color: T.muted, lineHeight: 17 },
  noteAction:   { fontSize: 12, fontWeight: '800', color: T.blueDeep },
  photoRow:     { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: T.bgSoft, borderRadius: 12, padding: 10, marginBottom: 8 },
  photoThumb:   { width: 40, height: 40, borderRadius: 20, overflow: 'hidden', backgroundColor: T.border, alignItems: 'center', justifyContent: 'center' },
  photoImg:     { width: 40, height: 40, borderRadius: 20 },
  photoNote:    { flex: 1, fontSize: 11.5, color: T.muted, lineHeight: 16 },

  statusRow:    { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-end', marginBottom: 8, paddingHorizontal: 4 },
  statusText:   { fontSize: 11.5, fontWeight: '700' },
  errorCard:    { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(239,68,68,0.22)', paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 },
  errorText:    { flex: 1, fontSize: 12.5, color: T.rose, fontWeight: '600', lineHeight: 17 },
  errorRetry:   { fontSize: 12.5, color: T.rose, fontWeight: '800' },

  dateCard:     { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: T.surface, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14, marginBottom: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 12, elevation: 3 },
  dateIcon:     { backgroundColor: T.cyan + '18' },
  dateText:     { fontSize: 14, fontWeight: '700', color: T.ink, marginTop: 3 },
  dateNote:     { fontSize: 11, color: T.faint, textAlign: 'right', lineHeight: 15 },

  toManager:    { fontSize: 12.5, color: T.faint, marginBottom: 4 },
  toCompany:    { fontSize: 14, fontWeight: '700', color: T.ink },
  toAddress:    { fontSize: 12.5, color: T.muted, lineHeight: 18, marginTop: 3 },
  chipsRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  officeChip:   { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%', borderRadius: 12, borderWidth: 1, borderColor: T.violet + '33', backgroundColor: T.violet + '12', paddingHorizontal: 9, paddingVertical: 6 },
  officeChipOn: { borderColor: T.violet, backgroundColor: T.violet + '26' },
  officeText:   { fontSize: 11.5, fontWeight: '600', color: T.inkSoft, flexShrink: 1 },

  fieldText:    { fontSize: 13.5, color: T.ink, lineHeight: 20 },
  emptyHint:    { fontSize: 12.5, color: T.faint, lineHeight: 18 },
  hint:         { fontSize: 11.5, color: T.faint, lineHeight: 16, marginTop: 2 },
  hintTight:    { marginTop: 6 },
  hintBold:     { fontWeight: '800' },

  paraActions:  { flexDirection: 'row', alignItems: 'center', gap: 6 },
  paraText:     { fontSize: 13, color: T.muted, lineHeight: 20 },

  sigWrap:      { marginTop: 10, gap: 4 },
  sigImg:       { width: 140, height: 46 },
  sigNote:      { fontSize: 11, color: T.faint },
  signName:     { fontSize: 13.5, fontWeight: '800', color: T.ink, marginTop: 10 },

  tail:         { height: 96 },
  tailShort:    { height: 32 },
  floatingBar:  { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.border, paddingHorizontal: 16, paddingTop: 12, paddingBottom: Platform.select({ ios: 28, default: 16 }), shadowColor: T.ink, shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 12 },
  primaryOuter: { borderRadius: 16, overflow: 'hidden' },
  primaryBtn:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, height: 50, borderRadius: 16 },
  primaryText:  { fontSize: 14, fontWeight: '800', color: '#fff' },

  emptyTitle:   { fontSize: 16, fontWeight: '700', color: T.ink, textAlign: 'center' },
  emptyText:    { fontSize: 13, color: T.muted, textAlign: 'center', lineHeight: 19 },
  retryBtn:     { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(79,141,255,0.1)', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 8, borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)' },
  retryText:    { fontSize: 13, fontWeight: '700', color: T.blueDeep },
  goBackBtn:    { backgroundColor: T.blue, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 10 },
  goBackText:   { color: '#fff', fontWeight: '700' },
});
