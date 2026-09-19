// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE RICH-TEXT PIECES THE TWO CUSTOMIZATION PAGES SHARE — the résumé's (/(resume-builder)/preview) and the cover
// letter's (/(cover-letter)/edit). Moved here from preview.tsx (2026-09-19) so the letter page is built from the SAME
// renderer and the SAME editor, not a copy that drifts:
//   • RichTextModal  the focused full-screen Quill editor (Quill 1.3.6 in a WebView). Bold in the text is bold in the box.
//   • ContentText    the read renderer: <strong>/<b> bold, <em>/<i> italic, <u> underline, headings bold, legacy **markdown**.
//   • mdToHtml       legacy **markdown** → the HTML Quill opens with (HTML passes through unchanged).
// …and the résumé page's look for the letter: the palette T, the hero (ProfileHero + ContactPill + getInitials) and the
// Section card (header icon, title, Edit / Cancel / Done).
//
// ⚠️ THE RÉSUMÉ PAGE GETS WHAT IT HAD. RichTextModal without `formats` builds exactly the toolbar it always had (heading,
// B, I, underline, clean) with no `formats` option, and the same hint (now allowed to wrap on a narrow phone). The one
// deliberate change: ContentText decodes entities with services/letterHtml's complete decoder (numeric references like
// &#8217; used to show literally).
//
// ⚠️ `formats` NARROWS WHAT QUILL CAN PRODUCE. The letter passes ['bold']: the toolbar is built from it AND Quill is
// constructed with the same `formats`, so a pasted heading, list, link or italic comes in as plain text. The server stores
// a letter as p/br/strong/b/em/i/ul/ol/li only (employerDocsRoutes normaliseLetterHtml) — an <h2> or <u> reaching it would
// be stripped, and a heading's paragraph break lost with it — and the Original (Branded) PDF prints bold but no italic
// (see the letter page's header).
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Platform, Modal, StatusBar, KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { decodeEntities } from '../../services/letterHtml';

/** The résumé editor's palette — both customization pages read as one product. */
export const T = {
  bg: '#E5EAF3', bgSoft: '#F0F4FA', surface: '#FFFFFF',
  navy: '#0B1120', ink: '#0B0F22', inkSoft: '#1A2046',
  muted: '#5A6480', faint: '#8A93B2', border: 'rgba(11,15,34,0.07)',
  blue: '#4F8DFF', blueDeep: '#2563EB', cyan: '#06B6D4',
  emerald: '#10B981', violet: '#A78BFA', rose: '#EF4444',
};

// Resume prose is stored as HTML (Quill native) so heading/bold/italic/underline are preserved and
// shown in the preview. Legacy resumes used **markdown** — convert those to HTML when opening the
// editor. The PDF/DOCX renderers strip tags (inline formatting is preview-only, as it always was).
export function mdToHtml(value: string): string {
  const v = String(value || '');
  if (/<[a-z][\s\S]*>/i.test(v)) return v;                         // already HTML — use as-is
  let h = v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const lines = h.split(/\n/);
  return lines.map((l) => `<p>${l || '<br>'}</p>`).join('') || '<p><br></p>';
}

export type RichFormat = 'header' | 'bold' | 'italic' | 'underline';

/** The toolbar (and, when narrowed, Quill's `formats`) for a format list. undefined = the résumé's, unchanged. */
function quillConfigOf(formats?: RichFormat[]): string {
  if (!formats) return "modules:{ toolbar:[[{ header:[2,3,false] }],['bold','italic','underline'],['clean']] }";
  const inline = (['bold', 'italic', 'underline'] as const).filter((f) => formats.includes(f));
  const groups: string[] = [];
  if (formats.includes('header')) groups.push('[{ header:[2,3,false] }]');
  if (inline.length) groups.push(`[${inline.map((f) => `'${f}'`).join(',')}]`);
  groups.push("['clean']");
  return `formats:[${formats.map((f) => `'${f}'`).join(',')}], modules:{ toolbar:[${groups.join(',')}] }`;
}

// ── Focused full-screen Quill rich-text editor (mirrors Letters/Review) ────────
export function RichTextModal({ visible, title, initialMd, onCancel, onDone, formats, hint }:
  {
    visible: boolean; title: string; initialMd: string; onCancel: () => void; onDone: (html: string) => void;
    /** Narrows the toolbar AND what Quill accepts (see the header). Omit for the résumé's full toolbar. */
    formats?: RichFormat[];
    /** Replaces the default "heading, B, I, underline" hint — a narrowed toolbar must not promise buttons it lacks. */
    hint?: React.ReactNode;
  }) {
  const insets = useSafeAreaInsets();
  const initHtml = useMemo(() => mdToHtml(initialMd), [initialMd]);
  const [liveHtml, setLiveHtml] = useState(initHtml);
  useEffect(() => { if (visible) setLiveHtml(initHtml); }, [visible, initHtml]);

  const editorHtml = `<!DOCTYPE html><html><head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <link href="https://cdn.quilljs.com/1.3.6/quill.snow.css" rel="stylesheet">
  <script src="https://cdn.quilljs.com/1.3.6/quill.min.js"></script>
  <style>
    html { height:100%; }
    /* Flex column: toolbar pinned (flex:0), editor area scrolls internally (flex:1) — so the
       formatting controls never scroll away while editing long content. */
    body { margin:0; padding:0; height:100%; width:100%; overflow:hidden; background:#fff;
           font-family:-apple-system,system-ui,sans-serif; -webkit-text-size-adjust:100%;
           display:flex; flex-direction:column; }
    .ql-toolbar.ql-snow { flex:0 0 auto; background:#fff; border:0; border-bottom:1px solid #eef1f7; }
    .ql-container.ql-snow { flex:1 1 auto; min-height:0; border:0; max-width:100%; font-size:16px; }
    .ql-editor { padding:16px; line-height:1.6; color:#0B0F22; word-break:break-word; overflow-wrap:break-word; white-space:pre-wrap; overflow-y:auto; }
    .ql-editor.ql-blank::before { color:#8A93B2; font-style:normal; left:16px; right:16px; }
  </style></head><body>
  <div id="editor">${initHtml}</div>
  <script>
    var quill = new Quill('#editor', { theme:'snow', placeholder:'Write here…',
      ${quillConfigOf(formats)} });
    function emit(){ window.ReactNativeWebView && window.ReactNativeWebView.postMessage(quill.root.innerHTML); }
    quill.on('text-change', emit);
    setTimeout(function(){ quill.focus(); }, 250);
  </script></body></html>`;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel} statusBarTranslucent={false}>
      {/* Explicit top padding (insets / Android status-bar height) so the bar never hides behind
          the notch / clock. */}
      <View style={[rt.screen, { paddingTop: Math.max(insets.top, Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 8) }]}>
        <StatusBar barStyle="dark-content" backgroundColor={T.surface} />
        <View style={rt.bar}>
          <TouchableOpacity onPress={onCancel} hitSlop={8}><Text style={rt.cancel}>Cancel</Text></TouchableOpacity>
          <Text style={rt.title} numberOfLines={1}>{title}</Text>
          <TouchableOpacity onPress={() => onDone(liveHtml)} style={rt.doneBtn} activeOpacity={0.85}>
            <Ionicons name="checkmark" size={14} color="#fff" /><Text style={rt.doneText}>Done</Text>
          </TouchableOpacity>
        </View>
        <View style={rt.hint}>
          <Ionicons name="text" size={12} color={T.blue} />
          <Text style={rt.hintText}>{hint ?? <>Select text, then use the toolbar — heading, <Text style={rt.hintBold}>B</Text>, <Text style={rt.hintItalic}>I</Text>, underline.</>}</Text>
        </View>
        <KeyboardAvoidingView style={rt.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <WebView
            key={initialMd}
            source={{ html: editorHtml }}
            style={rt.fill}
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            keyboardDisplayRequiresUserAction={false}
            onMessage={(e) => setLiveHtml(e.nativeEvent.data)}
          />
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
const rt = StyleSheet.create({
  screen:   { flex: 1, backgroundColor: T.surface },
  fill:     { flex: 1 },
  bar:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: T.border },
  cancel:   { fontSize: 14, fontWeight: '600', color: T.muted },
  title:    { flex: 1, textAlign: 'center', fontSize: 14, fontWeight: '800', color: T.ink, marginHorizontal: 10 },
  doneBtn:  { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: T.emerald, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  doneText: { fontSize: 13, fontWeight: '800', color: '#fff' },
  hint:     { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(79,141,255,0.08)', paddingHorizontal: 16, paddingVertical: 8 },
  hintText: { fontSize: 11.5, color: T.blueDeep, fontWeight: '600', flexShrink: 1 },
  hintBold: { fontWeight: '800' },
  hintItalic: { fontStyle: 'italic' },
});

// Read renderer — shows rich formatting (bold/italic/underline/heading) from the stored HTML, and
// still understands legacy **markdown**. A stack tokenizer supports nesting (e.g. bold + italic).
export function ContentText({ text, style, bulletVerb }: { text: string; style?: any; bulletVerb?: boolean }) {
  let src = String(text || '');
  // Only REAL rich-text tags flip HTML mode. The old test (/<[a-z]…>/) matched any angle-bracket
  // aside a user typed — "<3 years>", "&lt;placeholder&gt;" — and then silently deleted it as an
  // "unknown tag". Unknown tags are also no longer stripped in HTML mode for the same reason.
  if (/<\/?(h[1-6]|p|div|li|ul|ol|br|strong|b|em|i|u|span)\b[^>]*>/i.test(src)) {
    src = src.replace(/<h[1-6][^>]*>/gi, '⟦b⟧').replace(/<\/h[1-6]>/gi, '⟦/⟧\n')
             .replace(/<\/(p|div|li)>/gi, '\n').replace(/<(p|div|li)[^>]*>/gi, '').replace(/<br\s*\/?>/gi, '\n')
             .replace(/<(strong|b)\b[^>]*>/gi, '⟦b⟧').replace(/<\/(strong|b)>/gi, '⟦/⟧')
             .replace(/<(em|i)\b[^>]*>/gi, '⟦i⟧').replace(/<\/(em|i)>/gi, '⟦/⟧')
             .replace(/<u\b[^>]*>/gi, '⟦u⟧').replace(/<\/u>/gi, '⟦/⟧')
             .replace(/<\/?(span|ul|ol)\b[^>]*>/gi, '');
    src = decodeEntities(src);
  } else {
    src = src.replace(/\*\*(.+?)\*\*/g, '⟦b⟧$1⟦/⟧').replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1⟦i⟧$2⟦/⟧');
  }
  src = src.replace(/[\s\n]+$/g, '').replace(/\n{3,}/g, '\n\n');
  const tokens = src.split(/(⟦b⟧|⟦i⟧|⟦u⟧|⟦\/⟧)/);
  const stack: string[] = [];
  const nodes: React.ReactNode[] = [];
  let k = 0;
  for (const tk of tokens) {
    if (tk === '⟦b⟧') stack.push('b');
    else if (tk === '⟦i⟧') stack.push('i');
    else if (tk === '⟦u⟧') stack.push('u');
    else if (tk === '⟦/⟧') stack.pop();
    else if (tk) {
      const st: any = {};
      if (stack.includes('b')) { st.fontWeight = '700'; st.color = T.inkSoft; }
      if (stack.includes('i')) st.fontStyle = 'italic';
      if (stack.includes('u')) st.textDecorationLine = 'underline';
      nodes.push(<Text key={k++} style={st}>{tk}</Text>);
    }
  }
  return <Text style={style} selectable>{nodes.length ? nodes : src}</Text>;
}

/* ── THE RÉSUMÉ PAGE'S LOOK, FOR THE LETTER PAGE ──────────────────────────────────────────────────── */

export function getInitials(name?: string | null): string {
  // Reads the normalized copy only — a missing name must never TypeError the page (the résumé's b-fix).
  const safe = String(name || '').trim();
  const parts = safe.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return ((parts[0][0] || '') + (parts[parts.length - 1][0] || '')).toUpperCase();
  return (safe[0] || '?').toUpperCase();
}

export function ContactPill({ icon, text }: { icon: any; text: string }) {
  return (<View style={cp.pill}><Ionicons name={icon} size={11} color="rgba(255,255,255,0.6)" /><Text style={cp.text} numberOfLines={1}>{text}</Text></View>);
}
const cp = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 20, paddingHorizontal: 8, paddingVertical: 4 },
  text: { fontSize: 10, color: 'rgba(255,255,255,0.75)', fontWeight: '500' },
});

/**
 * The résumé page's hero card: the photo (or initials), the name, the cyan divider, contact pills, and an "Edit" pill
 * top right (hidden when onEdit is not given — e.g. while another card is being edited).
 */
export function ProfileHero({ photo, name, subtitle, contacts, onEdit }: {
  photo?: string | null; name: string; subtitle?: string;
  contacts: Array<{ icon: any; text: string }>; onEdit?: () => void;
}) {
  const shown = contacts.filter((c) => !!c.text);
  return (
    <View style={hero.card}>
      <LinearGradient colors={['#0B1120', '#162550', '#0d1f45']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={hero.gradient}>
        <View style={hero.deco1} /><View style={hero.deco2} /><View style={hero.deco3} /><View style={hero.deco4} />
        {!!onEdit && (
          <TouchableOpacity onPress={onEdit} style={hero.editBtn} activeOpacity={0.85} hitSlop={8} accessibilityLabel="Edit your details">
            <Ionicons name="create-outline" size={15} color="#fff" />
            <Text style={hero.editText}>Edit</Text>
          </TouchableOpacity>
        )}
        <View style={hero.content}>
          <View style={hero.avatar}>
            {photo ? <Image source={{ uri: photo }} style={hero.avatarImage} /> : <Text style={hero.avatarText}>{getInitials(name)}</Text>}
          </View>
          <Text style={hero.name}>{name || 'Your Name'}</Text>
          {!!subtitle && <Text style={hero.subtitle} numberOfLines={2}>{subtitle}</Text>}
          <View style={hero.divider} />
          {shown.length > 0 && (
            <View style={hero.contactRow}>
              {shown.map((c) => <ContactPill key={c.icon + c.text} icon={c.icon} text={c.text} />)}
            </View>
          )}
        </View>
      </LinearGradient>
    </View>
  );
}
const hero = StyleSheet.create({
  card:        { borderRadius: 28, overflow: 'hidden', marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.22, shadowRadius: 24, elevation: 10 },
  gradient:    { paddingTop: 32, paddingBottom: 28, paddingHorizontal: 20 },
  content:     { alignItems: 'center', gap: 10, zIndex: 2 },
  deco1:       { position: 'absolute', width: 180, height: 180, borderRadius: 90, backgroundColor: 'rgba(6,182,212,0.12)', top: -50, right: -50 },
  deco2:       { position: 'absolute', width: 120, height: 120, borderRadius: 60, backgroundColor: 'rgba(79,141,255,0.1)', bottom: -30, left: -30 },
  deco3:       { position: 'absolute', width: 60,  height: 60,  borderRadius: 30, backgroundColor: 'rgba(167,139,250,0.15)', top: 20, left: 20 },
  deco4:       { position: 'absolute', width: 40,  height: 40,  borderRadius: 20, backgroundColor: 'rgba(16,185,129,0.12)', bottom: 20, right: 30 },
  avatar:      { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center', borderWidth: 2.5, borderColor: 'rgba(255,255,255,0.3)', overflow: 'hidden' },
  avatarImage: { width: 72, height: 72, borderRadius: 36 },
  avatarText:  { fontSize: 26, fontWeight: '800', color: '#fff' },
  name:        { fontSize: 22, fontWeight: '800', color: '#fff', letterSpacing: -0.5, textAlign: 'center' },
  subtitle:    { fontSize: 12.5, fontWeight: '600', color: 'rgba(255,255,255,0.72)', textAlign: 'center', marginTop: -4 },
  divider:     { width: 40, height: 2, borderRadius: 2, backgroundColor: T.cyan, marginVertical: 2 },
  contactRow:  { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 },
  editBtn:     { position: 'absolute', top: 12, right: 12, zIndex: 3, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  editText:    { fontSize: 12, fontWeight: '700', color: '#fff' },
});

/**
 * The résumé page's section card. Not editing: an Edit button (hidden while another card is busy), or `actions` when the
 * card brings its own header controls. Editing: Cancel and Done (a spinner while it saves).
 */
export function Section({ title, icon, color, editing, busy, saving, onEdit, onDone, onCancel, actions, children }: {
  title: string; icon: any; color: string; editing: boolean; busy: boolean; saving: boolean;
  onEdit?: () => void; onDone?: () => void; onCancel?: () => void;
  /** Replaces the lone Edit button when the card is not being edited. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={[sec.card, editing && { borderWidth: 1.5, borderColor: color + '55' }]}>
      <View style={sec.header}>
        <View style={[sec.iconWrap, { backgroundColor: color + '18' }]}><Ionicons name={icon} size={14} color={color} /></View>
        <Text style={sec.title}>{title}</Text>
        <View style={sec.spacer} />
        {editing ? (
          <View style={sec.editRow}>
            <TouchableOpacity onPress={onCancel} style={sec.cancelBtn} hitSlop={6} disabled={saving}><Text style={sec.cancelText}>Cancel</Text></TouchableOpacity>
            <TouchableOpacity onPress={onDone} style={sec.doneBtn} disabled={saving} activeOpacity={0.85}>
              {saving ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="checkmark" size={13} color="#fff" />}
              <Text style={sec.doneText}>{saving ? 'Saving' : 'Done'}</Text>
            </TouchableOpacity>
          </View>
        ) : busy ? null : actions ? actions : onEdit ? (
          <TouchableOpacity onPress={onEdit} style={sec.editBtn} hitSlop={6} activeOpacity={0.8}>
            <Ionicons name="create-outline" size={13} color={T.blue} /><Text style={sec.editText}>Edit</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {children}
    </View>
  );
}
export const sec = StyleSheet.create({
  card:    { backgroundColor: T.surface, borderRadius: 20, padding: 16, marginBottom: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 12, elevation: 3 },
  header:  { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  iconWrap:{ width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  title:   { fontSize: 10, fontWeight: '800', color: T.faint, letterSpacing: 1.2 },
  spacer:  { flex: 1 },
  editRow: { flexDirection: 'row', gap: 6 },
  editBtn:   { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(79,141,255,0.1)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)' },
  editText:  { fontSize: 11.5, fontWeight: '700', color: T.blue },
  cancelBtn: { paddingHorizontal: 8, paddingVertical: 5 },
  cancelText:{ fontSize: 12, fontWeight: '700', color: T.muted },
  doneBtn:   { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: T.emerald, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 6 },
  doneText:  { fontSize: 12, fontWeight: '800', color: '#fff' },
});
