// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE LETTER EDITOR (route /(cover-letter)/edit, param `docId`): one employer's own cover letter — the
// version the AI wrote for THAT company (user_employer_documents, kind 'cover_letter') — opened from Home's
// zoomed page (Customize). Loaded via GET /employer-docs/:id, saved via PUT /employer-docs/:id.
//
// ⚠️ NOTHING HERE GENERATES OR CHARGES. Save stores the user's own words (saveDocPayload is never an AI call);
// View PDF only opens the gallery, which charges nothing until the user taps a download there.
//
// ⚠️ PLAIN TEXT, NOT RICH TEXT. The stored letter is HTML the server normalises to p/br/strong/b/em/i/ul/ol/li
// (employerDocsRoutes normaliseLetterHtml). The editor shows it as paragraphs separated by blank lines with
// **bold** — the only formatting a letter really uses — so there is no WebView/Quill to load or break, and
// the text → HTML side ESCAPES EVERYTHING FIRST: whatever the user types (or pastes), the only markup that
// leaves this screen is <p>, <br> and <strong> written by letterTextToHtml itself.
//   Lost on an edit: italics and list markup (a list comes back as "• " lines). Nothing is lost by just
//   opening and leaving — a letter is only re-written when the user taps Save or View PDF with changes.
//
// ⚠️ "NOT SAVED" IS SAID OUT LOUD. Every failure (no connection, 400, too big) leaves the status on Not saved
// with the reason; the user is never told an edit was kept when it was not. 'gone' (the server says the doc
// no longer exists) → an Alert and back, exactly like the résumé editor's doc mode.
//
// ⚠️ VIEW PDF RENDERS THE SERVER'S COPY. The gallery (templates.tsx doc mode) re-reads the document by docId,
// so unsaved edits would silently be missing from the PDF — View PDF saves first, and when that save fails
// it asks instead of pretending ("View saved version" is the explicit way through).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Platform, TextInput, Alert,
  KeyboardAvoidingView, Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
// usePreventRemove is the one guard that also reaches the NATIVE dismiss (see the unsaved-changes block below).
import { usePreventRemove, type NavigationAction } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchDoc, saveDocPayload } from '../../services/employerDocs';

// The résumé editor's palette (app/(resume-builder)/preview.tsx) — the two editors must read as one product.
const T = {
  bg: '#E5EAF3', bgSoft: '#F0F4FA', surface: '#FFFFFF',
  navy: '#0B1120', ink: '#0B0F22', inkSoft: '#1A2046',
  muted: '#5A6480', faint: '#8A93B2', border: 'rgba(11,15,34,0.07)',
  blue: '#4F8DFF', blueDeep: '#2563EB', cyan: '#06B6D4',
  emerald: '#10B981', violet: '#A78BFA', rose: '#EF4444',
};

/** A route param → a real doc id, or null. Anything that is not a positive integer is "no doc". */
function docIdOf(raw: unknown): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/* ── HTML ↔ TEXT (pure; unit-checked by a scratch round-trip: paragraphs, bold per paragraph, bold list items,
   a bold run split by a space, typed **bold**, <br>, & < >, <script>) ── */

// Elements whose CONTENT is never letter text — dropped whole, the same idea as the server's
// LETTER_DROP_WITH_CONTENT, so a stored letter that somehow carries one never shows its source as words.
const DROP_WITH_CONTENT_RE =
  /<(script|style|iframe|noscript|template|textarea|title|object|svg|math|head|select)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', sbquo: '‚', bdquo: '„',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  euro: '€', pound: '£', copy: '©', reg: '®', trade: '™', deg: '°',
  eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', iacute: 'í', oacute: 'ó',
  uacute: 'ú', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö',
  Uuml: 'Ü', szlig: 'ß', ccedil: 'ç', ntilde: 'ñ',
};

/** ONE pass, so "&amp;lt;" becomes the text "&lt;" and never "<". Unknown names stay as written. */
function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      if (code === 160) return ' ';
      // "&#1;" / "&#2;" would forge markBold's sentinels; no C0 control belongs in a letter anyway.
      if (code < 32 && code !== 9 && code !== 10) return '';
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : m;
  });
}

// Control-character sentinels for <strong>/<b> while other tags are stripped; any already in the source are removed first.
const BOLD_OPEN = '\u0001';
const BOLD_CLOSE = '\u0002';

/**
 * Sentinel-marked text → "**bold**" that is BALANCED ON EVERY LINE.
 * ⚠️ NEVER MERGE BOLD ACROSS A LINE BREAK. The old text-level merge ("**", any \s gap, "**" — and \s includes \n) turned
 * <p><strong>Re: …</strong></p><p><strong>Dear Ms. Smith,</strong></p> into "**Re: …\n\nDear Ms. Smith,**", which
 * letterTextToHtml (bold is matched inside ONE paragraph) saved back as literal asterisks with the bold gone.
 * So bold is tracked as a DEPTH across the whole letter (a <strong> left open over a </p> keeps the next line
 * bold, the way a browser renders it; nested <b> inside <strong> is not "****"), and every line opens and
 * closes its own markers. Merging happens only between runs on the SAME line: a whitespace-only gap between
 * two bold runs joins them (<strong>Hello</strong> <strong>World</strong> → **Hello World**), an empty or
 * whitespace-only bold run is plain, and a run's edge whitespace sits outside its markers.
 */
function markBold(s: string): string {
  let depth = 0;
  return s.split('\n').map((line) => {
    const runs: { text: string; bold: boolean }[] = [];
    for (const part of line.split(/([\u0001\u0002])/)) {
      if (part === BOLD_OPEN) { depth += 1; continue; }
      if (part === BOLD_CLOSE) { depth = Math.max(0, depth - 1); continue; }
      if (!part) continue;
      const bold = depth > 0 && /\S/.test(part);
      const last = runs[runs.length - 1];
      if (last && last.bold === bold) last.text += part;
      else runs.push({ text: part, bold });
    }
    for (let i = 1; i < runs.length - 1; i++) {
      if (!runs[i].bold && runs[i - 1].bold && runs[i + 1].bold && !/\S/.test(runs[i].text)) {
        runs[i - 1].text += runs[i].text + runs[i + 1].text;
        runs.splice(i, 2);
        i -= 1;
      }
    }
    return runs.map((r) => {
      if (!r.bold) return r.text;
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.text);
      return m ? `${m[1]}**${m[2]}**${m[3]}` : `**${r.text}**`;
    }).join('');
  }).join('\n');
}

/**
 * Stored letter HTML → the editor's text. <p> = a paragraph (blank line), <br> = a line break,
 * <strong>/<b> = **bold**, every other tag stripped, entities decoded.
 * Beyond the bare strip: a list item starts its own "• " line and a block element (div, heading) breaks a
 * paragraph — stripping those silently would glue a list or a <div>-per-paragraph letter into one run-on line.
 */
export function letterHtmlToText(html: string): string {
  let s = String(html == null ? '' : html).replace(/[\u0001\u0002]/g, '');
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  s = s.replace(DROP_WITH_CONTENT_RE, '');
  // Source newlines/tabs are just whitespace in HTML; only tags make breaks.
  s = s.replace(/[\r\n\t]+/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/?p(?:\s[^>]*)?>/gi, '\n\n');
  s = s.replace(/<\/?(?:div|h[1-6]|blockquote|section|article|header|footer|table|tr)(?:\s[^>]*)?>/gi, '\n\n');
  s = s.replace(/<li(?:\s[^>]*)?>/gi, '\n• ');
  s = s.replace(/<\/li\s*>/gi, '');
  s = s.replace(/<\/?(?:ul|ol)(?:\s[^>]*)?>/gi, '\n\n');      // a list is its own paragraph of "• " lines
  s = s.replace(/<(?:strong|b)(?:\s[^>]*)?>/gi, BOLD_OPEN).replace(/<\/(?:strong|b)\s*>/gi, BOLD_CLOSE);
  s = s.replace(/<[^>]*>/g, '');                            // after this only text, \n and the two sentinels remain
  s = decodeEntities(s);                                    // before markBold, so "&nbsp;" counts as a gap
  s = markBold(s);
  return s
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The editor's text → letter HTML. Escaped FIRST (so typed or pasted markup is only ever text), then:
 * blank line(s) → a new <p>, a single newline → <br>, **x** → <strong>x</strong> (matched inside ONE paragraph,
 * which is why letterHtmlToText balances the markers on every line).
 */
export function letterTextToHtml(text: string): string {
  const src = escapeHtml(String(text == null ? '' : text).replace(/\r\n?/g, '\n'));
  return src
    .split(/\n[ \t]*\n[\s]*/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => {
      const lines = para.split('\n').map((l) => l.trim()).join('<br>');
      return `<p>${lines.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`;
    })
    .join('');
}

/* ── THE SCREEN ────────────────────────────────────────────────────────────────────────────────────── */

type Save = { state: 'idle' } | { state: 'saving' } | { state: 'saved' } | { state: 'error'; message: string };
type Loaded = { employer: string; payload: Record<string, any> };

export default function CoverLetterEdit() {
  const router = useRouter();
  const navigation = useNavigation();
  const { docId: wantDocId } = useLocalSearchParams<{ docId?: string }>();
  const docId = docIdOf(wantDocId);   // constant for the life of the screen

  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);                     // Try again
  const [doc, setDoc] = useState<Loaded | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  // What the SERVER holds right now (loaded, or last saved). Dirty = the fields differ from it.
  const [base, setBase] = useState<{ subject: string; body: string; html: string }>({ subject: '', body: '', html: '' });
  const [save, setSave] = useState<Save>({ state: 'idle' });
  const [kbOpen, setKbOpen] = useState(false);
  const savingRef = useRef(false);
  // Leaving on purpose (gone, discard confirmed) must not trip the unsaved-changes guard.
  // The REF is for code that runs right after an await (no re-render in between); the STATE is what the
  // usePreventRemove condition reads — a ref flip alone would leave the guard (and iOS's blocked swipe) armed.
  // exit.action = the navigation the user confirmed discarding for; no action = a plain back (goneOut).
  const leavingRef = useRef(false);
  const [exit, setExit] = useState<{ action?: NavigationAction } | null>(null);

  const dirty = !!doc && (subject !== base.subject || body !== base.body);
  const empty = !body.trim();

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKbOpen(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKbOpen(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

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
      const html = typeof p.coverLetterHtml === 'string' ? p.coverLetterHtml : '';
      const subj = typeof p.subject === 'string' ? p.subject : '';
      const text = letterHtmlToText(html);
      setDoc({ employer: d.employer || '', payload: p });
      setSubject(subj);
      setBody(text);
      setBase({ subject: subj, body: text, html });
      setSave({ state: 'idle' });
      setLoading(false);
    })();
    return () => { alive = false; };
    // router / goneOut are stable for this screen; nonce is the retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, nonce]);

  /**
   * Store the fields. { html } = the letter now on the server; { error } = it was NOT saved (the message is
   * already on screen); { error: null } = nothing was attempted (no doc, a save already running, or gone).
   */
  const doSave = async (): Promise<{ html: string } | { error: string | null }> => {
    if (!doc || !docId || savingRef.current) return { error: null };
    if (empty) {
      const message = 'A letter needs some text before it can be saved.';
      setSave({ state: 'error', message });
      return { error: message };
    }
    savingRef.current = true;
    setSave({ state: 'saving' });
    const wantSubject = subject.replace(/[\r\n]+/g, ' ').trim();
    const wantBody = body;
    const html = letterTextToHtml(wantBody);
    try {
      const payload = { ...doc.payload, subject: wantSubject, coverLetterHtml: html };
      const r = await saveDocPayload(docId, payload).catch(() => ({ ok: false as const, reason: 'network' as const, message: undefined }));
      if (r.ok) {
        setDoc({ ...doc, payload });
        // The baseline is what was SENT; fields typed during the request stay dirty on purpose.
        setBase({ subject: wantSubject, body: wantBody, html });
        // A subject saved trimmed must not read as a pending change; newer typing is left alone.
        setSubject((cur) => (cur !== wantSubject && cur.replace(/[\r\n]+/g, ' ').trim() === wantSubject ? wantSubject : cur));
        setSave({ state: 'saved' });
        return { html };
      }
      if (r.reason === 'gone') { setSave({ state: 'error', message: 'This letter no longer exists.' }); goneOut(); return { error: null }; }
      const message = r.reason === 'too_big'
        ? 'This letter is too long to store. Shorten it and try again.'
        : (r.message || 'Check your connection and try again.');
      setSave({ state: 'error', message });
      return { error: message };
    } finally {
      savingRef.current = false;
    }
  };

  const onSavePress = async () => {
    Keyboard.dismiss();
    const r = await doSave();
    // The inline status already says Not saved; the Alert makes sure a user who looked away sees it.
    if ('error' in r && r.error && !leavingRef.current) Alert.alert('Not saved', r.error);
  };

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
    if (!doc || savingRef.current) return;
    Keyboard.dismiss();
    if (!dirty) { openGallery(base.html); return; }
    const r = await doSave();
    if ('html' in r) { openGallery(r.html); return; }
    if (leavingRef.current || !r.error) return;
    Alert.alert(
      'Your changes are not saved',
      'The PDF shows the letter as it is saved on our side, so it would not include your latest edits.',
      [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'View saved version', onPress: () => openGallery(base.html) },
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
    Alert.alert('Discard your changes?', 'Your edits to this letter are not saved.', [
      { text: 'Keep editing', style: 'cancel' },
      {
        text: 'Discard', style: 'destructive',
        onPress: () => { leavingRef.current = true; setExit({ action: data.action }); },
      },
    ]);
  });

  useEffect(() => {
    if (!exit) return;
    if (exit.action) navigation.dispatch(exit.action);
    else if (router.canGoBack()) router.back();
    // router / navigation are stable for this screen; exit is set once (leaving is one-way).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exit]);

  // The Back pill goes through the same removal as the hardware back, so a dirty letter asks here too.
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
  if (!doc) {
    return (
      <SafeAreaView style={[s.safe, s.center, { gap: 12, paddingHorizontal: 32 }]} edges={['top']}>
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
  const company = String(p.companyName || doc.employer || '').trim();
  const position = String(p.position || '').trim();
  const manager = String(p.hiringManager || '').trim();
  const busy = save.state === 'saving';

  let statusIcon: any = 'ellipse-outline';
  let statusText = '';
  let statusColor = T.faint;
  if (busy) { statusText = 'Saving…'; statusColor = T.blue; }
  else if (dirty) { statusIcon = 'ellipse'; statusText = save.state === 'error' ? 'Not saved' : 'Unsaved changes'; statusColor = save.state === 'error' ? T.rose : '#F59E0B'; }
  else if (save.state === 'saved') { statusIcon = 'checkmark-circle'; statusText = 'Saved'; statusColor = T.emerald; }
  else if (save.state === 'error') { statusIcon = 'alert-circle'; statusText = 'Not saved'; statusColor = T.rose; }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* Top bar */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={leave} style={s.backPill} activeOpacity={0.8}>
          <Ionicons name="arrow-back" size={14} color={T.ink} />
          <Text style={s.backPillText}>Back</Text>
        </TouchableOpacity>
        {/* Say WHOSE letter this is — editing it changes nothing for any other employer. */}
        <View style={s.docHead} pointerEvents="none">
          <Text style={s.docEyebrow}>TAILORED COVER LETTER</Text>
          <Text style={s.docTitle} numberOfLines={1}>{doc.employer ? `${doc.employer} letter` : 'Employer letter'}</Text>
        </View>
        <TouchableOpacity
          onPress={onSavePress}
          style={[s.saveBtn, (!dirty || busy || empty) && { opacity: 0.45 }]}
          activeOpacity={0.8}
          disabled={!dirty || busy || empty}
          accessibilityLabel="Save letter"
        >
          {busy ? <ActivityIndicator size="small" color={T.blue} /> : <Ionicons name="checkmark-circle-outline" size={14} color={T.blue} />}
          <Text style={s.saveText}>{busy ? 'Saving' : 'Save'}</Text>
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {/* Hero: who the letter goes to */}
          <View style={s.heroCard}>
            <LinearGradient colors={['#0B1120', '#162550', '#0d1f45']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.heroGradient}>
              <View style={s.heroDeco1} /><View style={s.heroDeco2} />
              <View style={s.heroRow}>
                <View style={s.heroIcon}><Ionicons name="mail-open-outline" size={20} color="#fff" /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.heroEyebrow}>TO</Text>
                  <Text style={s.heroName} numberOfLines={2}>{company || 'The hiring team'}</Text>
                  {!!(position || manager) && (
                    <Text style={s.heroMeta} numberOfLines={2}>{[position, manager].filter(Boolean).join(' · ')}</Text>
                  )}
                </View>
              </View>
            </LinearGradient>
          </View>

          {/* Save status — never silent */}
          {!!statusText && (
            <View style={s.statusRow}>
              <Ionicons name={statusIcon} size={12} color={statusColor} />
              <Text style={[s.statusText, { color: statusColor }]}>{statusText}</Text>
            </View>
          )}
          {save.state === 'error' && !busy && (
            <TouchableOpacity onPress={onSavePress} style={s.errorCard} activeOpacity={0.85} disabled={empty}>
              <Ionicons name="alert-circle-outline" size={16} color={T.rose} />
              <Text style={s.errorText}>Not saved — {save.message}</Text>
              {!empty && <Text style={s.errorRetry}>Retry</Text>}
            </TouchableOpacity>
          )}

          {/* Subject */}
          <View style={s.card}>
            <View style={s.cardHead}>
              <View style={[s.cardIcon, { backgroundColor: T.cyan + '18' }]}><Ionicons name="pricetag-outline" size={14} color={T.cyan} /></View>
              <Text style={s.cardTitle}>SUBJECT</Text>
            </View>
            <TextInput
              value={subject}
              onChangeText={(v) => setSubject(v.replace(/[\r\n]+/g, ' '))}
              placeholder="Application for …"
              placeholderTextColor={T.faint}
              style={s.input}
              maxLength={300}
              returnKeyType="done"
              blurOnSubmit
              editable={!busy}
            />
          </View>

          {/* Letter body */}
          <View style={s.card}>
            <View style={s.cardHead}>
              <View style={[s.cardIcon, { backgroundColor: T.blue + '18' }]}><Ionicons name="document-text-outline" size={14} color={T.blue} /></View>
              <Text style={s.cardTitle}>LETTER</Text>
            </View>
            <Text style={s.hint}>Leave a blank line between paragraphs. Wrap words in **double asterisks** to make them bold.</Text>
            <TextInput
              value={body}
              onChangeText={setBody}
              placeholder="Dear hiring team, …"
              placeholderTextColor={T.faint}
              style={[s.input, s.inputBody]}
              multiline
              scrollEnabled={false}
              textAlignVertical="top"
              autoCapitalize="sentences"
              editable={!busy}
            />
            {empty && <Text style={[s.hint, { color: T.rose, marginTop: 6, marginBottom: 0 }]}>A letter needs some text before it can be saved.</Text>}
          </View>

          <View style={{ height: 24 }} />
        </ScrollView>

        {/* Action bar — hidden while typing so the letter keeps the screen. */}
        {!kbOpen && (
          <View style={s.bottomBar}>
            <TouchableOpacity onPress={onViewPdf} activeOpacity={0.88} disabled={busy} style={[s.primaryOuter, busy && { opacity: 0.6 }]}>
              <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.primaryBtn}>
                {busy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="document-outline" size={16} color="#fff" />}
                <Text style={s.primaryText}>{dirty ? 'Save & View PDF' : 'View PDF'}</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: T.bg },
  center:       { justifyContent: 'center', alignItems: 'center' },
  topBar:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  backPill:     { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.surface, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 3, zIndex: 1 },
  backPillText: { fontSize: 13, fontWeight: '600', color: T.ink },
  docHead:      { position: 'absolute', left: 96, right: 96, alignItems: 'center', justifyContent: 'center', zIndex: 0 },
  docEyebrow:   { fontSize: 9, fontWeight: '800', color: T.faint, letterSpacing: 1.2 },
  docTitle:     { fontSize: 15, fontWeight: '800', color: T.ink, letterSpacing: -0.3, marginTop: 1 },
  saveBtn:      { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(79,141,255,0.1)', borderRadius: 16, paddingVertical: 7, paddingHorizontal: 12, borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)', zIndex: 1 },
  saveText:     { fontSize: 12, fontWeight: '700', color: T.blue },
  scroll:       { padding: 16 },

  heroCard:     { borderRadius: 24, overflow: 'hidden', marginBottom: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.22, shadowRadius: 24, elevation: 10 },
  heroGradient: { paddingVertical: 20, paddingHorizontal: 18 },
  heroDeco1:    { position: 'absolute', width: 160, height: 160, borderRadius: 80, backgroundColor: 'rgba(6,182,212,0.12)', top: -50, right: -50 },
  heroDeco2:    { position: 'absolute', width: 90, height: 90, borderRadius: 45, backgroundColor: 'rgba(167,139,250,0.14)', bottom: -30, left: -20 },
  heroRow:      { flexDirection: 'row', alignItems: 'center', gap: 14 },
  heroIcon:     { width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.14)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)', alignItems: 'center', justifyContent: 'center' },
  heroEyebrow:  { fontSize: 9, fontWeight: '800', color: 'rgba(255,255,255,0.55)', letterSpacing: 1.2 },
  heroName:     { fontSize: 18, fontWeight: '800', color: '#fff', letterSpacing: -0.4, marginTop: 2 },
  heroMeta:     { fontSize: 12, color: 'rgba(255,255,255,0.72)', marginTop: 3, fontWeight: '500' },

  statusRow:    { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-end', marginBottom: 8, paddingHorizontal: 4 },
  statusText:   { fontSize: 11.5, fontWeight: '700' },
  errorCard:    { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(239,68,68,0.22)', paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 },
  errorText:    { flex: 1, fontSize: 12.5, color: T.rose, fontWeight: '600', lineHeight: 17 },
  errorRetry:   { fontSize: 12.5, color: T.rose, fontWeight: '800' },

  card:         { backgroundColor: T.surface, borderRadius: 20, padding: 16, marginBottom: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 12, elevation: 3 },
  cardHead:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  cardIcon:     { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  cardTitle:    { fontSize: 10, fontWeight: '800', color: T.faint, letterSpacing: 1.2 },
  hint:         { fontSize: 11.5, color: T.faint, lineHeight: 16, marginBottom: 8 },
  input:        { backgroundColor: T.bgSoft, borderRadius: 10, borderWidth: 1, borderColor: T.border, paddingHorizontal: 12, paddingVertical: Platform.select({ ios: 10, default: 8 }), fontSize: 14, color: T.ink },
  inputBody:    { minHeight: 280, lineHeight: 21, paddingTop: 12, paddingBottom: 12 },

  bottomBar:    { backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.border, paddingHorizontal: 16, paddingTop: 12, paddingBottom: Platform.select({ ios: 28, default: 16 }), shadowColor: T.ink, shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 12 },
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
