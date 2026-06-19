// Resume Builder — new feature. Safe to delete without affecting existing app.
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  ActivityIndicator, Image, Platform, TextInput, Alert, Modal, StatusBar, KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../../config';
import RatingPromptModal, { useRatingPrompt } from '../../components/RatingPromptModal';

const T = {
  bg: '#E5EAF3', bgSoft: '#F0F4FA', surface: '#FFFFFF',
  navy: '#0B1120', ink: '#0B0F22', inkSoft: '#1A2046',
  muted: '#5A6480', faint: '#8A93B2', border: 'rgba(11,15,34,0.07)',
  blue: '#4F8DFF', blueDeep: '#2563EB', cyan: '#06B6D4',
  emerald: '#10B981', violet: '#A78BFA', rose: '#EF4444',
};

type ResumeData = {
  personal_info: { full_name: string; email: string; phone: string; location: string; linkedin_url: string; portfolio_url: string };
  summary: string;
  experience: Array<{ company: string; role: string; location: string; start_date: string; end_date: string; highlights: string[] }>;
  education: Array<{ institution: string; degree: string; field_of_study: string; end_date: string }>;
  projects: Array<{ title: string; link: string; description: string }>;
  skills: { technical: string[]; soft: string[] };
};

// Resume prose is stored as HTML (Quill native) so heading/bold/italic/underline are preserved and
// shown in the preview. Legacy resumes used **markdown** — convert those to HTML when opening the
// editor. The PDF/DOCX renderers strip tags (inline formatting is preview-only, as it always was).
function mdToHtml(value: string): string {
  const v = String(value || '');
  if (/<[a-z][\s\S]*>/i.test(v)) return v;                         // already HTML — use as-is
  let h = v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const lines = h.split(/\n/);
  return lines.map((l) => `<p>${l || '<br>'}</p>`).join('') || '<p><br></p>';
}

// ── Focused full-screen Quill rich-text editor (mirrors Letters/Review) ────────
function RichTextModal({ visible, title, initialMd, onCancel, onDone }:
  { visible: boolean; title: string; initialMd: string; onCancel: () => void; onDone: (html: string) => void }) {
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
      modules:{ toolbar:[[{ header:[2,3,false] }],['bold','italic','underline'],['clean']] } });
    function emit(){ window.ReactNativeWebView && window.ReactNativeWebView.postMessage(quill.root.innerHTML); }
    quill.on('text-change', emit);
    setTimeout(function(){ quill.focus(); }, 250);
  </script></body></html>`;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel} statusBarTranslucent={false}>
      {/* Explicit top padding (insets / Android status-bar height) so the bar never hides behind
          the notch / clock. */}
      <View style={{ flex: 1, backgroundColor: T.surface, paddingTop: Math.max(insets.top, Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 8) }}>
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
          <Text style={rt.hintText}>Select text, then use the toolbar — heading, <Text style={{ fontWeight: '800' }}>B</Text>, <Text style={{ fontStyle: 'italic' }}>I</Text>, underline.</Text>
        </View>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <WebView
            key={initialMd}
            source={{ html: editorHtml }}
            style={{ flex: 1 }}
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
  bar:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: T.border },
  cancel:   { fontSize: 14, fontWeight: '600', color: T.muted },
  title:    { flex: 1, textAlign: 'center', fontSize: 14, fontWeight: '800', color: T.ink, marginHorizontal: 10 },
  doneBtn:  { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: T.emerald, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  doneText: { fontSize: 13, fontWeight: '800', color: '#fff' },
  hint:     { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(79,141,255,0.08)', paddingHorizontal: 16, paddingVertical: 8 },
  hintText: { fontSize: 11.5, color: T.blueDeep, fontWeight: '600' },
});

function Chip({ label, color }: { label: string; color: string }) {
  return (
    <View style={[chip.wrap, { backgroundColor: color + '18', borderColor: color + '33' }]}>
      <Text style={[chip.text, { color }]}>{label}</Text>
    </View>
  );
}
const chip = StyleSheet.create({
  wrap: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1 },
  text: { fontSize: 11, fontWeight: '600' },
});

function getInitials(name: string): string {
  const parts = (name || '').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (name[0] || '?').toUpperCase();
}

function decodeEntities(s: string): string {
  return s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;/gi, "'").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'");
}
// Read renderer — shows rich formatting (bold/italic/underline/heading) from the stored HTML, and
// still understands legacy **markdown**. A stack tokenizer supports nesting (e.g. bold + italic).
function ContentText({ text, style, bulletVerb }: { text: string; style?: any; bulletVerb?: boolean }) {
  let src = String(text || '');
  if (/<[a-z][\s\S]*>/i.test(src)) {
    src = src.replace(/<h[1-6][^>]*>/gi, '⟦b⟧').replace(/<\/h[1-6]>/gi, '⟦/⟧\n')
             .replace(/<\/(p|div|li)>/gi, '\n').replace(/<(p|div|li)[^>]*>/gi, '').replace(/<br\s*\/?>/gi, '\n')
             .replace(/<(strong|b)\b[^>]*>/gi, '⟦b⟧').replace(/<\/(strong|b)>/gi, '⟦/⟧')
             .replace(/<(em|i)\b[^>]*>/gi, '⟦i⟧').replace(/<\/(em|i)>/gi, '⟦/⟧')
             .replace(/<u\b[^>]*>/gi, '⟦u⟧').replace(/<\/u>/gi, '⟦/⟧')
             .replace(/<[^>]+>/g, '');
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

// Plain input for structured fields (role, dates, skills…)
function EI({ value, onChange, placeholder, multiline, style }: { value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean; style?: any }) {
  return (
    <TextInput value={value || ''} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={T.faint}
      multiline={!!multiline} style={[ed.input, multiline && ed.inputMulti, style]} />
  );
}
function Label({ text }: { text: string }) { return <Text style={ed.label}>{text}</Text>; }
function AddBtn({ label, color = T.blue, onPress }: { label: string; color?: string; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={[ed.addBtn, { borderColor: color + '40', backgroundColor: color + '10' }]} activeOpacity={0.8}>
      <Ionicons name="add" size={15} color={color} /><Text style={[ed.addText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// A prose row in edit mode: shows rendered (bold) text; tap → opens the rich editor.
function ProseRow({ md, placeholder, color, dot, onEdit, onRemove }:
  { md: string; placeholder: string; color?: string; dot?: boolean; onEdit: () => void; onRemove?: () => void }) {
  return (
    <View style={ed.proseRow}>
      {dot && <View style={[s.bulletDot, color ? { backgroundColor: color } : null]} />}
      <TouchableOpacity style={{ flex: 1 }} activeOpacity={0.7} onPress={onEdit}>
        {md ? <ContentText text={md} style={s.bulletText} bulletVerb /> : <Text style={ed.placeholder}>{placeholder}</Text>}
      </TouchableOpacity>
      <TouchableOpacity onPress={onEdit} hitSlop={8}><Ionicons name="create-outline" size={15} color={T.blue} /></TouchableOpacity>
      {onRemove && <TouchableOpacity onPress={onRemove} hitSlop={8}><Ionicons name="close-circle" size={17} color={T.faint} /></TouchableOpacity>}
    </View>
  );
}

export default function ResumePreview() {
  const router = useRouter();
  const rating = useRatingPrompt();
  const goBack = async () => { if (!(await rating.ask('resume'))) router.replace('/(resume-builder)'); };
  const closeRating = () => { rating.close(); router.replace('/(resume-builder)'); };

  const [data, setData] = useState<ResumeData | null>(null);
  const [draft, setDraft] = useState<any | null>(null);
  const [editSection, setEditSection] = useState<string | null>(null);   // 'details'|'summary'|'experience'|'education'|'projects'|'skills'
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [profileImage, setProfileImage] = useState<string | null>(null);
  // rich-text editor target: a path into draft + current value
  const [rich, setRich] = useState<{ title: string; value: string; apply: (md: string) => void } | null>(null);

  useEffect(() => {
    (async () => {
      // Manual-build seed: start from the sample template the index screen saved (ignore any
      // saved/backend resume so it isn't overwritten). One-shot flag; still pull the profile photo.
      try {
        const seed = await AsyncStorage.getItem('resumeBuilderSeedSample');
        if (seed) {
          await AsyncStorage.removeItem('resumeBuilderSeedSample').catch(() => {});
          const cached = await AsyncStorage.getItem('resumeBuilderData');
          if (cached) setData(JSON.parse(cached));
          try {
            const raw = await SecureStore.getItemAsync('userSession');
            const token = JSON.parse(raw || '{}')?.token;
            if (token) {
              const pr = await fetch(`${API_BASE}/users/profile`, { headers: { Authorization: `Bearer ${token}` } });
              if (pr.ok) { const pj = await pr.json(); const u = pj.profileImage || pj.profile_image; if (u) setProfileImage(u); }
            }
          } catch {}
          setLoading(false);
          return;
        }
      } catch {}
      try {
        const raw = await SecureStore.getItemAsync('userSession');
        const token = JSON.parse(raw || '{}')?.token;
        if (token) {
          const [resumeRes, profileRes] = await Promise.all([
            fetch(`${API_BASE}/resume-builder`, { headers: { Authorization: `Bearer ${token}` } }),
            fetch(`${API_BASE}/users/profile`, { headers: { Authorization: `Bearer ${token}` } }),
          ]);
          if (resumeRes.ok) {
            const json = await resumeRes.json();
            if (json.resumeData) { setData(json.resumeData); await AsyncStorage.setItem('resumeBuilderData', JSON.stringify(json.resumeData)); }
          }
          if (profileRes.ok) {
            const pj = await profileRes.json();
            const imgUrl = pj.profileImage || pj.profile_image || null;
            if (imgUrl) setProfileImage(imgUrl);
          }
          setLoading(false); return;
        }
      } catch {}
      try { const cached = await AsyncStorage.getItem('resumeBuilderData'); if (cached) setData(JSON.parse(cached)); } catch {}
      setLoading(false);
    })();
  }, []);

  // ── Per-card edit lifecycle ────────────────────────────────────────────────
  const cur: any = (editSection && draft) ? draft : (data || {});
  const mutate = (fn: (d: any) => void) => setDraft((prev: any) => { const c = JSON.parse(JSON.stringify(prev ?? {})); fn(c); return c; });
  const startEdit = (name: string) => {
    const base = JSON.parse(JSON.stringify(data || {}));
    base.personal_info = base.personal_info || { full_name: '', email: '', phone: '', location: '', linkedin_url: '', portfolio_url: '' };
    base.skills = base.skills || { technical: [], soft: [] };
    if (!Array.isArray(base.experience)) base.experience = [];
    if (!Array.isArray(base.education)) base.education = [];
    if (!Array.isArray(base.projects)) base.projects = [];
    setDraft(base); setEditSection(name);
  };
  const cancelEdit = () => { setEditSection(null); setDraft(null); };
  const saveCard = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const raw = await SecureStore.getItemAsync('userSession');
      const token = JSON.parse(raw || '{}')?.token;
      const res = await fetch(`${API_BASE}/resume-builder/save`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeData: draft }),
      });
      if (!res.ok) throw new Error('save failed');
      setData(draft);
      await AsyncStorage.setItem('resumeBuilderData', JSON.stringify(draft)).catch(() => {});
      setEditSection(null); setDraft(null);
    } catch { Alert.alert('Could not save', 'Please check your connection and try again.'); }
    finally { setSaving(false); }
  };

  // mutators
  const setPI = (k: string, v: string) => mutate((c) => { c.personal_info = { ...(c.personal_info || {}), [k]: v }; });
  const setItem = (sec: string, i: number, k: string, v: string) => mutate((c) => { c[sec][i][k] = v; });
  const addBullet = (sec: string, i: number, key: string) => mutate((c) => { if (!Array.isArray(c[sec][i][key])) c[sec][i][key] = []; c[sec][i][key].push(''); });
  const delBullet = (sec: string, i: number, key: string, j: number) => mutate((c) => c[sec][i][key].splice(j, 1));
  const addEntry = (sec: string, blank: any) => mutate((c) => { if (!Array.isArray(c[sec])) c[sec] = []; c[sec].push(blank); });
  const delEntry = (sec: string, i: number) => mutate((c) => c[sec].splice(i, 1));
  const setSkill = (g: 'technical' | 'soft', j: number, v: string) => mutate((c) => { c.skills[g][j] = v; });
  const addSkill = (g: 'technical' | 'soft') => mutate((c) => { c.skills = c.skills || { technical: [], soft: [] }; if (!Array.isArray(c.skills[g])) c.skills[g] = []; c.skills[g].push(''); });
  const delSkill = (g: 'technical' | 'soft', j: number) => mutate((c) => c.skills[g].splice(j, 1));

  // open rich editor for a path
  const openRich = (title: string, value: string, apply: (md: string) => void) => setRich({ title, value, apply });

  if (loading) {
    return <SafeAreaView style={[s.safe, { justifyContent: 'center', alignItems: 'center' }]} edges={['top']}><ActivityIndicator size="large" color={T.blue} /></SafeAreaView>;
  }
  if (!data) {
    return (
      <SafeAreaView style={[s.safe, { justifyContent: 'center', alignItems: 'center', gap: 12 }]} edges={['top']}>
        <Ionicons name="document-outline" size={48} color={T.faint} />
        <Text style={{ fontSize: 16, fontWeight: '700', color: T.ink }}>No resume data found</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ backgroundColor: T.blue, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 10 }}><Text style={{ color: '#fff', fontWeight: '700' }}>Go Back</Text></TouchableOpacity>
      </SafeAreaView>
    );
  }

  const pi = cur.personal_info || {};
  const busy = editSection !== null;   // a card is being edited → hide other Edit buttons
  const sectionProps = (name: string) => ({
    name, editing: editSection === name, busy: busy && editSection !== name, saving,
    onEdit: () => startEdit(name), onDone: saveCard, onCancel: cancelEdit,
  });

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* Top bar */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={busy ? cancelEdit : goBack} style={s.backPill} activeOpacity={0.8}>
          <Ionicons name={busy ? 'close' : 'arrow-back'} size={14} color={T.ink} />
          <Text style={s.backPillText}>{busy ? 'Cancel' : 'Back'}</Text>
        </TouchableOpacity>
        <View style={s.wordmark} pointerEvents="none">
          <Image source={require('../../assets/images/logo_img.png')} style={s.logoImg} resizeMode="contain" />
          <Text style={s.wordmarkText}>CV<Text style={s.wordmarkBlue}>Applyr</Text></Text>
        </View>
        <TouchableOpacity onPress={() => router.push('/(resume-builder)/templates')} style={[s.exportBtn, busy && { opacity: 0.4 }]} activeOpacity={0.8} disabled={busy}>
          <Ionicons name="download-outline" size={14} color={T.blue} />
          <Text style={s.exportText}>Download</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

        {/* Hero */}
        <View style={s.heroCard}>
          <LinearGradient colors={['#0B1120', '#162550', '#0d1f45']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.heroGradient}>
            <View style={s.heroDeco1} /><View style={s.heroDeco2} /><View style={s.heroDeco3} /><View style={s.heroDeco4} />
            {!busy && (
              <TouchableOpacity onPress={() => startEdit('details')} style={s.heroEditBtn} activeOpacity={0.85} hitSlop={8}>
                <Ionicons name="create-outline" size={15} color="#fff" />
                <Text style={s.heroEditText}>Edit</Text>
              </TouchableOpacity>
            )}
            <View style={s.heroContent}>
              <View style={s.avatarCircle}>
                {profileImage ? <Image source={{ uri: profileImage }} style={s.avatarImage} /> : <Text style={s.avatarText}>{getInitials(pi.full_name)}</Text>}
              </View>
              <Text style={s.heroName}>{pi.full_name || 'Your Name'}</Text>
              <View style={s.heroDivider} />
              <View style={s.heroContactRow}>
                {pi.email ? <ContactPill icon="mail-outline" text={pi.email} /> : null}
                {pi.phone ? <ContactPill icon="call-outline" text={pi.phone} /> : null}
                {pi.location ? <ContactPill icon="location-outline" text={pi.location} /> : null}
              </View>
              {(pi.linkedin_url || pi.portfolio_url) ? (
                <View style={s.heroContactRow}>
                  {pi.linkedin_url ? <ContactPill icon="logo-linkedin" text="LinkedIn" /> : null}
                  {pi.portfolio_url ? <ContactPill icon="globe-outline" text="Portfolio" /> : null}
                </View>
              ) : null}
            </View>
          </LinearGradient>
        </View>

        {/* DETAILS — shown only in edit mode (opened via the pencil on the hero card above) */}
        {editSection === 'details' && (
          <Section title="DETAILS" icon="person-outline" color={T.blue} {...sectionProps('details')}>
            <Label text="Full name" /><EI value={pi.full_name} onChange={(v) => setPI('full_name', v)} placeholder="Your name" />
            <Label text="Email" /><EI value={pi.email} onChange={(v) => setPI('email', v)} placeholder="email@example.com" />
            <Label text="Phone" /><EI value={pi.phone} onChange={(v) => setPI('phone', v)} placeholder="Phone" />
            <Label text="Location" /><EI value={pi.location} onChange={(v) => setPI('location', v)} placeholder="City, Country" />
            <Label text="LinkedIn URL" /><EI value={pi.linkedin_url} onChange={(v) => setPI('linkedin_url', v)} placeholder="linkedin.com/in/…" />
            <Label text="Portfolio URL" /><EI value={pi.portfolio_url} onChange={(v) => setPI('portfolio_url', v)} placeholder="your-site.com" />
          </Section>
        )}

        {/* SUMMARY */}
        <Section title="SUMMARY" icon="newspaper-outline" color={T.cyan} {...sectionProps('summary')}>
          {editSection === 'summary' ? (
            <ProseRow md={cur.summary} placeholder="Tap to write your professional summary…"
              onEdit={() => openRich('Summary', cur.summary || '', (md) => mutate((c) => { c.summary = md; }))} />
          ) : !!cur.summary ? (
            <ContentText text={cur.summary} style={s.summaryText} />
          ) : <Text style={s.detailsHint}>No summary yet. Tap Edit to add one.</Text>}
        </Section>

        {/* EXPERIENCE */}
        {(editSection === 'experience' || (cur.experience?.length ?? 0) > 0) && (
          <Section title="EXPERIENCE" icon="briefcase-outline" color={T.blue} {...sectionProps('experience')}>
            {(cur.experience || []).map((e: any, i: number) => (
              <View key={i} style={[s.expRow, i > 0 && s.divider]}>
                {editSection === 'experience' ? (
                  <>
                    <View style={ed.entryHead}><Text style={ed.entryTag}>Experience {i + 1}</Text><DelBtn onPress={() => delEntry('experience', i)} /></View>
                    <EI value={e.role} onChange={(v) => setItem('experience', i, 'role', v)} placeholder="Role / Title" />
                    <EI value={e.company} onChange={(v) => setItem('experience', i, 'company', v)} placeholder="Company" />
                    <EI value={e.location} onChange={(v) => setItem('experience', i, 'location', v)} placeholder="Location" />
                    <View style={ed.row2}>
                      <EI value={e.start_date} onChange={(v) => setItem('experience', i, 'start_date', v)} placeholder="Start" style={{ flex: 1 }} />
                      <EI value={e.end_date} onChange={(v) => setItem('experience', i, 'end_date', v)} placeholder="End / Present" style={{ flex: 1 }} />
                    </View>
                    <Label text="Highlights (tap to edit · bold supported)" />
                    {(e.highlights || []).map((h: string, j: number) => (
                      <ProseRow key={j} md={h} placeholder="Tap to write a highlight…" dot
                        onEdit={() => openRich(`Highlight ${j + 1}`, h, (md) => mutate((c) => { c.experience[i].highlights[j] = md; }))}
                        onRemove={() => delBullet('experience', i, 'highlights', j)} />
                    ))}
                    <AddBtn label="Add highlight" onPress={() => addBullet('experience', i, 'highlights')} />
                  </>
                ) : (
                  <>
                    <View style={s.expHeader}>
                      <View style={{ flex: 1 }}>
                        <Text style={s.expRole} selectable>{e.role || '—'}</Text>
                        <Text style={s.expCompany} selectable>{e.company}{e.location ? ` · ${e.location}` : ''}</Text>
                      </View>
                      <Text style={s.expDates}>{[e.start_date, e.end_date].filter(Boolean).join(' – ') || ''}</Text>
                    </View>
                    {(e.highlights || []).map((h: string, j: number) => (
                      <View key={j} style={s.bulletRow}><View style={s.bulletDot} /><ContentText text={h} style={s.bulletText} bulletVerb /></View>
                    ))}
                  </>
                )}
              </View>
            ))}
            {editSection === 'experience' && <AddBtn label="Add experience" onPress={() => addEntry('experience', { role: '', company: '', location: '', start_date: '', end_date: '', highlights: [] })} />}
          </Section>
        )}

        {/* EDUCATION */}
        {(editSection === 'education' || (cur.education?.length ?? 0) > 0) && (
          <Section title="EDUCATION" icon="school-outline" color={T.violet} {...sectionProps('education')}>
            {(cur.education || []).map((e: any, i: number) => (
              <View key={i} style={[s.expRow, i > 0 && s.divider]}>
                {editSection === 'education' ? (
                  <>
                    <View style={ed.entryHead}><Text style={ed.entryTag}>Education {i + 1}</Text><DelBtn onPress={() => delEntry('education', i)} /></View>
                    <EI value={e.degree} onChange={(v) => setItem('education', i, 'degree', v)} placeholder="Degree" />
                    <EI value={e.field_of_study} onChange={(v) => setItem('education', i, 'field_of_study', v)} placeholder="Field of study" />
                    <EI value={e.institution} onChange={(v) => setItem('education', i, 'institution', v)} placeholder="Institution" />
                    <EI value={e.end_date} onChange={(v) => setItem('education', i, 'end_date', v)} placeholder="Year / End date" />
                    <EI value={e.grade} onChange={(v) => setItem('education', i, 'grade', v)} placeholder="Grade / Percentage (e.g. 8.5 CGPA, 85%)" />
                  </>
                ) : (
                  <View style={s.expHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.expRole}>{[e.degree, e.field_of_study].filter(Boolean).join(' · ') || '—'}</Text>
                      <Text style={s.expCompany}>{e.institution}</Text>
                      {!!e.grade && <View style={s.gradePill}><Ionicons name="ribbon-outline" size={11} color={T.violet} /><Text style={s.gradeText}>{e.grade}</Text></View>}
                    </View>
                    {!!e.end_date && <Text style={s.expDates}>{e.end_date}</Text>}
                  </View>
                )}
              </View>
            ))}
            {editSection === 'education' && <AddBtn label="Add education" color={T.violet} onPress={() => addEntry('education', { degree: '', field_of_study: '', institution: '', end_date: '', grade: '' })} />}
          </Section>
        )}

        {/* PROJECTS */}
        {(editSection === 'projects' || (cur.projects?.length ?? 0) > 0) && (
          <Section title="PROJECTS" icon="code-slash-outline" color={T.emerald} {...sectionProps('projects')}>
            {(cur.projects || []).map((p: any, i: number) => (
              <View key={i} style={[s.expRow, i > 0 && s.divider]}>
                {editSection === 'projects' ? (
                  <>
                    <View style={ed.entryHead}><Text style={ed.entryTag}>Project {i + 1}</Text><DelBtn onPress={() => delEntry('projects', i)} /></View>
                    <EI value={p.title} onChange={(v) => setItem('projects', i, 'title', v)} placeholder="Project name" />
                    <EI value={p.type} onChange={(v) => setItem('projects', i, 'type', v)} placeholder="Type (e.g. Web app)" />
                    <EI value={p.role} onChange={(v) => setItem('projects', i, 'role', v)} placeholder="Your role" />
                    <Label text="About (tap to edit · bold supported)" />
                    <ProseRow md={p.about ?? p.description} placeholder="Tap to describe the project…"
                      onEdit={() => openRich('About this project', (p.about ?? p.description) || '', (md) => mutate((c) => { c.projects[i].about = md; }))} />
                    <Label text="Highlights" />
                    {(p.role_highlights || []).map((h: string, j: number) => (
                      <ProseRow key={j} md={h} placeholder="Tap to write a highlight…" dot color={T.emerald}
                        onEdit={() => openRich(`Highlight ${j + 1}`, h, (md) => mutate((c) => { c.projects[i].role_highlights[j] = md; }))}
                        onRemove={() => delBullet('projects', i, 'role_highlights', j)} />
                    ))}
                    <AddBtn label="Add highlight" color={T.emerald} onPress={() => addBullet('projects', i, 'role_highlights')} />
                  </>
                ) : (
                  <>
                    <View style={s.expHeader}>
                      <View style={{ flex: 1 }}><Text style={s.expRole}>{p.title || '—'}{!!p.type && <Text style={s.projectType}>{`  (${p.type})`}</Text>}</Text></View>
                      {!!p.link && <Ionicons name="link-outline" size={13} color={T.faint} />}
                    </View>
                    {!!p.about && <ContentText text={p.about} style={[s.summaryText, s.projectAbout]} />}
                    {!p.about && !!p.description && <ContentText text={p.description} style={[s.summaryText, s.projectAbout]} />}
                    {!!p.role && <View style={s.roleRow}><Ionicons name="person-outline" size={12} color={T.emerald} /><Text style={s.roleLabel}>Role: </Text><Text style={s.roleValue}>{p.role}</Text></View>}
                    {(p.role_highlights || []).map((h: string, j: number) => (
                      <View key={j} style={s.bulletRow}><View style={[s.bulletDot, { backgroundColor: T.emerald }]} /><ContentText text={h} style={s.bulletText} bulletVerb /></View>
                    ))}
                  </>
                )}
              </View>
            ))}
            {editSection === 'projects' && <AddBtn label="Add project" color={T.emerald} onPress={() => addEntry('projects', { title: '', type: '', about: '', role: '', role_highlights: [] })} />}
          </Section>
        )}

        {/* SKILLS */}
        {(editSection === 'skills' || (cur.skills?.technical?.length ?? 0) > 0 || (cur.skills?.soft?.length ?? 0) > 0) && (
          <Section title="SKILLS" icon="flash-outline" color={T.cyan} {...sectionProps('skills')}>
            {(['technical', 'soft'] as const).map((group) => (
              (editSection === 'skills' || (cur.skills?.[group]?.length ?? 0) > 0) ? (
                <View key={group} style={s.skillGroup}>
                  <Text style={s.skillGroupLabel}>{group === 'technical' ? 'Technical' : 'Soft Skills'}</Text>
                  {editSection === 'skills' ? (
                    <>
                      {(cur.skills?.[group] || []).map((sk: string, j: number) => (
                        <View key={j} style={ed.skillEdit}>
                          <EI value={sk} onChange={(v) => setSkill(group, j, v)} placeholder="Skill" style={{ flex: 1 }} />
                          <TouchableOpacity onPress={() => delSkill(group, j)} hitSlop={8}><Ionicons name="close-circle" size={18} color={T.faint} /></TouchableOpacity>
                        </View>
                      ))}
                      <AddBtn label={`Add ${group} skill`} onPress={() => addSkill(group)} />
                    </>
                  ) : (
                    <View style={s.chipsRow}>{(cur.skills[group] || []).map((sk: string, i: number) => <Chip key={i} label={sk} color={group === 'technical' ? T.blue : T.violet} />)}</View>
                  )}
                </View>
              ) : null
            ))}
          </Section>
        )}

        <View style={{ height: busy ? 32 : 96 }} />
      </ScrollView>

      {/* Floating Regenerate (hidden while editing a card) */}
      {!busy && (
        <View style={s.floatingBar}>
          <TouchableOpacity style={s.regenOuter} activeOpacity={0.88} onPress={async () => { await AsyncStorage.setItem('resumeBuilderAction', 'regenerate').catch(() => {}); router.back(); }}>
            <LinearGradient colors={[T.navy, '#1a2346']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.regenBtn}>
              <Ionicons name="refresh-outline" size={16} color="#fff" /><Text style={s.regenText}>Regenerate Resume</Text>
              <View style={s.regenBadge}><Ionicons name="diamond" size={9} color="#fff" /><Text style={s.regenBadgeText}>2</Text></View>
            </LinearGradient>
          </TouchableOpacity>
          <Text style={s.regenNote}>Uses 2 credits · re-runs AI with your saved story</Text>
        </View>
      )}

      <RichTextModal
        visible={!!rich}
        title={rich?.title || ''}
        initialMd={rich?.value || ''}
        onCancel={() => setRich(null)}
        onDone={(md) => { rich?.apply(md); setRich(null); }}
      />
      <RatingPromptModal visible={!!rating.trigger} trigger={rating.trigger} onClose={closeRating} />
    </SafeAreaView>
  );
}

function DelBtn({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={ed.delBtn} activeOpacity={0.8} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
      <Ionicons name="trash-outline" size={13} color={T.rose} /><Text style={ed.delText}>Remove</Text>
    </TouchableOpacity>
  );
}

function ContactPill({ icon, text }: { icon: any; text: string }) {
  return (<View style={cpStyles.pill}><Ionicons name={icon} size={11} color="rgba(255,255,255,0.6)" /><Text style={cpStyles.text} numberOfLines={1}>{text}</Text></View>);
}
const cpStyles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 20, paddingHorizontal: 8, paddingVertical: 4 },
  text: { fontSize: 10, color: 'rgba(255,255,255,0.75)', fontWeight: '500' },
});

function Section({ title, icon, color, editing, busy, saving, onEdit, onDone, onCancel, children }:
  { title: string; icon: any; color: string; name: string; editing: boolean; busy: boolean; saving: boolean; onEdit: () => void; onDone: () => void; onCancel: () => void; children: React.ReactNode }) {
  return (
    <View style={[sec.card, editing && { borderWidth: 1.5, borderColor: color + '55' }]}>
      <View style={sec.header}>
        <View style={[sec.iconWrap, { backgroundColor: color + '18' }]}><Ionicons name={icon} size={14} color={color} /></View>
        <Text style={sec.title}>{title}</Text>
        <View style={{ flex: 1 }} />
        {editing ? (
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <TouchableOpacity onPress={onCancel} style={sec.cancelBtn} hitSlop={6}><Text style={sec.cancelText}>Cancel</Text></TouchableOpacity>
            <TouchableOpacity onPress={onDone} style={sec.doneBtn} disabled={saving} activeOpacity={0.85}>
              {saving ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="checkmark" size={13} color="#fff" />}
              <Text style={sec.doneText}>{saving ? 'Saving' : 'Done'}</Text>
            </TouchableOpacity>
          </View>
        ) : !busy ? (
          <TouchableOpacity onPress={onEdit} style={sec.editBtn} hitSlop={6} activeOpacity={0.8}>
            <Ionicons name="create-outline" size={13} color={T.blue} /><Text style={sec.editText}>Edit</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {children}
    </View>
  );
}
const sec = StyleSheet.create({
  card:    { backgroundColor: T.surface, borderRadius: 20, padding: 16, marginBottom: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 12, elevation: 3 },
  header:  { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  iconWrap:{ width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  title:   { fontSize: 10, fontWeight: '800', color: T.faint, letterSpacing: 1.2 },
  editBtn:   { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(79,141,255,0.1)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)' },
  editText:  { fontSize: 11.5, fontWeight: '700', color: T.blue },
  cancelBtn: { paddingHorizontal: 8, paddingVertical: 5 },
  cancelText:{ fontSize: 12, fontWeight: '700', color: T.muted },
  doneBtn:   { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: T.emerald, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 6 },
  doneText:  { fontSize: 12, fontWeight: '800', color: '#fff' },
});

const ed = StyleSheet.create({
  input:     { backgroundColor: T.bgSoft, borderRadius: 10, borderWidth: 1, borderColor: T.border, paddingHorizontal: 12, paddingVertical: Platform.select({ ios: 10, default: 8 }), fontSize: 13, color: T.ink, marginBottom: 8 },
  inputMulti:{ minHeight: 64, textAlignVertical: 'top' },
  label:     { fontSize: 11, fontWeight: '700', color: T.muted, marginBottom: 4, marginTop: 4 },
  row2:      { flexDirection: 'row', gap: 8 },
  entryHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  entryTag:  { fontSize: 11, fontWeight: '800', color: T.faint, letterSpacing: 0.6 },
  proseRow:  { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 8, backgroundColor: T.bgSoft, borderRadius: 10, borderWidth: 1, borderColor: T.border, paddingHorizontal: 12, paddingVertical: 10 },
  placeholder:{ fontSize: 13, color: T.faint, fontStyle: 'italic' },
  skillEdit: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addBtn:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 10, borderWidth: 1, paddingVertical: 9, marginTop: 2, marginBottom: 4 },
  addText:   { fontSize: 12.5, fontWeight: '700' },
  delBtn:    { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  delText:   { fontSize: 11, fontWeight: '700', color: T.rose },
});

const s = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: T.bg },
  topBar:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  backPill:     { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.surface, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 3 },
  backPillText: { fontSize: 13, fontWeight: '600', color: T.ink },
  wordmark:     { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, zIndex: 0 },
  logoImg:      { width: 22, height: 22 },
  wordmarkText: { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  wordmarkBlue: { color: T.blue },
  exportBtn:    { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(79,141,255,0.1)', borderRadius: 16, paddingVertical: 7, paddingHorizontal: 12, borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)' },
  exportText:   { fontSize: 12, fontWeight: '700', color: T.blue },
  scroll:       { padding: 16 },
  detailsHint:  { fontSize: 12.5, color: T.faint, lineHeight: 18 },
  heroCard:       { borderRadius: 28, overflow: 'hidden', marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.22, shadowRadius: 24, elevation: 10 },
  heroGradient:   { paddingTop: 32, paddingBottom: 28, paddingHorizontal: 20 },
  heroContent:    { alignItems: 'center', gap: 10, zIndex: 2 },
  heroDeco1:      { position: 'absolute', width: 180, height: 180, borderRadius: 90, backgroundColor: 'rgba(6,182,212,0.12)', top: -50, right: -50 },
  heroDeco2:      { position: 'absolute', width: 120, height: 120, borderRadius: 60, backgroundColor: 'rgba(79,141,255,0.1)', bottom: -30, left: -30 },
  heroDeco3:      { position: 'absolute', width: 60,  height: 60,  borderRadius: 30, backgroundColor: 'rgba(167,139,250,0.15)', top: 20, left: 20 },
  heroDeco4:      { position: 'absolute', width: 40,  height: 40,  borderRadius: 20, backgroundColor: 'rgba(16,185,129,0.12)', bottom: 20, right: 30 },
  avatarCircle:   { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center', borderWidth: 2.5, borderColor: 'rgba(255,255,255,0.3)', overflow: 'hidden' },
  avatarImage:    { width: 72, height: 72, borderRadius: 36 },
  avatarText:     { fontSize: 26, fontWeight: '800', color: '#fff' },
  heroName:       { fontSize: 22, fontWeight: '800', color: '#fff', letterSpacing: -0.5, textAlign: 'center' },
  heroDivider:    { width: 40, height: 2, borderRadius: 2, backgroundColor: T.cyan, marginVertical: 2 },
  heroContactRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 },
  heroEditBtn:    { position: 'absolute', top: 12, right: 12, zIndex: 3, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  heroEditText:   { fontSize: 12, fontWeight: '700', color: '#fff' },
  summaryText:  { fontSize: 13, color: T.muted, lineHeight: 20 },
  expRow:       { paddingTop: 10 },
  divider:      { borderTopWidth: 1, borderTopColor: T.border, marginTop: 10 },
  expHeader:    { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6, gap: 8 },
  expRole:      { fontSize: 14, fontWeight: '700', color: T.ink },
  expCompany:   { fontSize: 12, color: T.muted, marginTop: 2 },
  expDates:     { fontSize: 11, color: T.faint, fontWeight: '600', flexShrink: 0 },
  floatingBar:    { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.border, paddingHorizontal: 16, paddingTop: 12, paddingBottom: Platform.select({ ios: 28, default: 16 }), gap: 6, shadowColor: T.ink, shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 12 },
  regenOuter:     { borderRadius: 16, overflow: 'hidden' },
  regenBtn:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, height: 50, borderRadius: 16 },
  regenText:      { fontSize: 14, fontWeight: '800', color: '#fff' },
  regenBadge:     { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3 },
  regenBadgeText: { fontSize: 11, fontWeight: '800', color: '#fff' },
  regenNote:      { fontSize: 11, color: T.faint, textAlign: 'center' },
  bulletRow:    { flexDirection: 'row', gap: 8, marginTop: 4, alignItems: 'flex-start' },
  bulletDot:    { width: 5, height: 5, borderRadius: 3, backgroundColor: T.blue, marginTop: 7, flexShrink: 0 },
  bulletText:   { fontSize: 12, color: T.muted, lineHeight: 18, flex: 1 },
  skillGroup:   { marginBottom: 10 },
  skillGroupLabel: { fontSize: 11, fontWeight: '700', color: T.muted, marginBottom: 6 },
  chipsRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  gradePill:    { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, backgroundColor: 'rgba(167,139,250,0.1)', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3, alignSelf: 'flex-start', borderWidth: 1, borderColor: 'rgba(167,139,250,0.25)' },
  gradeText:    { fontSize: 11, fontWeight: '700', color: T.violet },
  projectType:  { fontSize: 13, fontWeight: '500', color: T.muted },
  projectAbout: { marginTop: 6, marginBottom: 6, lineHeight: 19 },
  roleRow:      { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, marginBottom: 2 },
  roleLabel:    { fontSize: 12, fontWeight: '700', color: T.ink },
  roleValue:    { fontSize: 12, fontWeight: '600', color: T.emerald, flex: 1 },
});
