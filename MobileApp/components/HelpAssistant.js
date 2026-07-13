// AI Hub — in-app help assistant. Safe to delete without affecting the existing app.
// A draggable floating button (hold to move anywhere) that opens a guided assistant: ask a question
// in plain words → scripted, step-by-step answers (no AI/LLM cost). "How to apply" branches into
// "I have the employer details" vs "Search for a job first". A "View tutorial" button replays the
// intro guide (SlideCarousel). Pure StyleSheet + Ionicons + expo-linear-gradient.
import React, { useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, TextInput, ScrollView, Animated, PanResponder,
  Dimensions, Platform, Keyboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SlideCarousel } from './WelcomeExplainer';

const { width: SW, height: SH } = Dimensions.get('window');

// ── Scripted knowledge base ─────────────────────────────────────────────────
const STEP = (icon, text) => ({ icon, text });
const KB = [
  {
    id: 'apply', label: 'How to apply for a job', icon: 'paper-plane-outline',
    match: /\bapply|application|applying\b/i, branch: true,
  },
  {
    id: 'find', label: 'How to find a job', icon: 'search-outline',
    match: /\bfind|search|discover|explore|look(ing)? for|browse\b/i,
    title: 'Find jobs that match you',
    steps: [
      STEP('sparkles-outline', 'Open “Explore Jobs”, then type what you want in plain words — e.g. “senior .NET jobs in Switzerland” — and tap Ask AI.'),
      STEP('options-outline', 'Or browse by your field and use Filters (technology, location, work mode, employer).'),
      STEP('ribbon-outline', 'Each job shows a match % against your résumé. Sort by “Best match”.'),
      STEP('reader-outline', 'Tap a job to see full details, then “View & Apply”.'),
    ],
  },
  {
    id: 'cover', label: 'Generate a cover letter', icon: 'document-text-outline',
    match: /\bcover ?letter|letter|motivation\b/i,
    title: 'Generate a tailored cover letter',
    steps: [
      STEP('reader-outline', 'Open any job’s detail page.'),
      STEP('document-text-outline', 'Tap “Generate Cover Letter” — the AI writes it for that role and region.'),
      STEP('create-outline', 'Preview, edit if you like, and download as PDF or Word.'),
      STEP('paper-plane-outline', 'When you apply, it can be pasted or attached automatically.'),
    ],
  },
  {
    id: 'employer', label: 'Add an employer to research', icon: 'business-outline',
    match: /\badd.*(employer|company)|employer|company|career page|url\b/i,
    title: 'Research a specific employer',
    steps: [
      STEP('briefcase-outline', 'Go to Job Hub.'),
      STEP('add-circle-outline', 'Add the employer name or paste their careers-page URL.'),
      STEP('sparkles-outline', 'CVApplyr researches all their open roles and matches them to your résumé.'),
      STEP('people-outline', 'It also finds the hiring contacts where available.'),
    ],
  },
  {
    id: 'resume', label: 'Upload / update my résumé', icon: 'cloud-upload-outline',
    match: /\bresume|résumé|\bcv\b|upload\b/i,
    title: 'Add your résumé (unlocks match scores)',
    steps: [
      STEP('person-circle-outline', 'Open Account / Profile.'),
      STEP('cloud-upload-outline', 'Upload your résumé (PDF or Word).'),
      STEP('ribbon-outline', 'We parse your skills so every job gets a match % and your field is set.'),
    ],
  },
];

const APPLY_BRANCH = {
  have: {
    title: 'Apply — you have the employer',
    steps: [
      STEP('briefcase-outline', 'Open Job Hub and add the employer name or paste their careers URL.'),
      STEP('sparkles-outline', 'We research all their open roles and match them to your résumé.'),
      STEP('reader-outline', 'Open the role you want → “View & Apply”.'),
      STEP('color-wand-outline', 'In the apply screen, tap “Auto Fill” — we fill the form, and tap each upload field to attach your résumé & cover letter.'),
    ],
  },
  search: {
    title: 'Apply — search for a job first',
    steps: [
      STEP('search-outline', 'Open “Explore Jobs” and use the AI search (e.g. “sales jobs near my area”) or browse your field.'),
      STEP('reader-outline', 'Tap a job → “View & Apply”.'),
      STEP('document-text-outline', 'Optionally tap “Generate Cover Letter” first.'),
      STEP('color-wand-outline', 'In the apply screen, tap “Auto Fill”, then tap upload fields to attach your résumé & cover letter.'),
    ],
  },
};

const GREETING = "Hi! I'm your CVApplyr assistant. Ask me anything — like how to apply, how to find a job, or how to make a cover letter.";

function StepList({ title, steps }) {
  return (
    <View style={s.answerCard}>
      {!!title && <Text style={s.answerTitle}>{title}</Text>}
      {steps.map((st, i) => (
        <View key={i} style={s.stepRow}>
          <View style={s.stepNum}><Text style={s.stepNumText}>{i + 1}</Text></View>
          <Ionicons name={st.icon} size={16} color="#3B82F6" style={{ marginTop: 1 }} />
          <Text style={s.stepText}>{st.text}</Text>
        </View>
      ))}
    </View>
  );
}

export default function HelpAssistant() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState('home');   // home | answer | applyBranch | tutorial
  const [answer, setAnswer] = useState(null);  // {title, steps}
  const [input, setInput] = useState('');
  const [notFound, setNotFound] = useState(false);

  // Draggable floating button
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const moved = useRef(false);
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
      onPanResponderGrant: () => {
        moved.current = false;
        pan.setOffset({ x: pan.x.__getValue(), y: pan.y.__getValue() });
        pan.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: (e, g) => {
        if (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4) moved.current = true;
        pan.setValue({ x: g.dx, y: g.dy });
      },
      onPanResponderRelease: () => {
        pan.flattenOffset();
        if (!moved.current) setOpen(true);   // tap (not drag) → open
      },
    })
  ).current;

  const goHome = () => { setView('home'); setAnswer(null); setNotFound(false); setInput(''); };
  const showTopic = (t) => {
    if (t.branch) { setView('applyBranch'); return; }
    setAnswer({ title: t.title, steps: t.steps }); setView('answer'); setNotFound(false);
  };
  const ask = (text) => {
    const q = (text != null ? text : input).trim();
    if (!q) return;
    Keyboard.dismiss();
    const hit = KB.find((t) => t.match.test(q));
    if (hit) { setInput(''); showTopic(hit); }
    else { setInput(''); setNotFound(true); setView('home'); }
  };

  const suggestions = useMemo(() => KB.map((t) => ({ id: t.id, label: t.label, icon: t.icon, t })), []);

  return (
    <>
      {/* Floating draggable button */}
      {!open && (
        <Animated.View
          style={[s.fabWrap, { transform: pan.getTranslateTransform() }]}
          {...responder.panHandlers}
        >
          <View style={s.fab}>
            <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.fabGrad}>
              <Ionicons name="sparkles" size={22} color="#fff" />
            </LinearGradient>
            <View style={s.fabBadge}><Ionicons name="help" size={11} color="#fff" /></View>
          </View>
        </Animated.View>
      )}

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={s.overlay}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setOpen(false)} />
          <View style={s.sheet}>
            {/* Header */}
            <View style={s.header}>
              <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.headerIcon}>
                <Ionicons name="sparkles" size={16} color="#fff" />
              </LinearGradient>
              <View style={{ flex: 1 }}>
                <Text style={s.headerTitle}>CVApplyr Assistant</Text>
                <Text style={s.headerSub}>Guides you step by step</Text>
              </View>
              {view !== 'home' && (
                <TouchableOpacity onPress={goHome} style={s.headerBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="arrow-back" size={18} color="#5B6B8A" />
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => setOpen(false)} style={s.headerBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={20} color="#5B6B8A" />
              </TouchableOpacity>
            </View>

            <ScrollView style={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {view === 'home' && (
                <>
                  <View style={s.greetRow}>
                    <View style={s.botBubble}><Text style={s.botText}>{GREETING}</Text></View>
                  </View>
                  {notFound && (
                    <View style={s.notFound}><Ionicons name="information-circle-outline" size={15} color="#3B82F6" /><Text style={s.notFoundText}>I didn’t catch that — pick one of these, and I’ll walk you through it:</Text></View>
                  )}
                  <Text style={s.sectionLbl}>POPULAR QUESTIONS</Text>
                  {suggestions.map((sg) => (
                    <TouchableOpacity key={sg.id} style={s.suggRow} activeOpacity={0.85} onPress={() => showTopic(sg.t)}>
                      <View style={s.suggIcon}><Ionicons name={sg.icon} size={16} color="#3B82F6" /></View>
                      <Text style={s.suggText}>{sg.label}</Text>
                      <Ionicons name="chevron-forward" size={16} color="#B6C2D9" />
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity style={s.tutorialBtn} activeOpacity={0.9} onPress={() => setView('tutorial')}>
                    <Ionicons name="play-circle-outline" size={18} color="#3B82F6" />
                    <Text style={s.tutorialText}>View tutorial</Text>
                  </TouchableOpacity>
                </>
              )}

              {view === 'answer' && answer && (
                <StepList title={answer.title} steps={answer.steps} />
              )}

              {view === 'applyBranch' && (
                <>
                  <View style={s.greetRow}>
                    <View style={s.botBubble}><Text style={s.botText}>Sure! First — do you already know the employer, or should we search for a job first?</Text></View>
                  </View>
                  <TouchableOpacity style={s.optionCard} activeOpacity={0.9} onPress={() => { setAnswer(APPLY_BRANCH.have); setView('answer'); }}>
                    <View style={[s.optIcon, { backgroundColor: 'rgba(6,182,212,0.12)' }]}><Ionicons name="business-outline" size={20} color="#06B6D4" /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.optTitle}>I have the employer details</Text>
                      <Text style={s.optSub}>Add the company / careers URL and apply to their roles</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#B6C2D9" />
                  </TouchableOpacity>
                  <TouchableOpacity style={s.optionCard} activeOpacity={0.9} onPress={() => { setAnswer(APPLY_BRANCH.search); setView('answer'); }}>
                    <View style={[s.optIcon, { backgroundColor: 'rgba(59,130,246,0.12)' }]}><Ionicons name="search-outline" size={20} color="#3B82F6" /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.optTitle}>Search for a job first</Text>
                      <Text style={s.optSub}>Explore matching jobs, then apply</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#B6C2D9" />
                  </TouchableOpacity>
                </>
              )}

              {view === 'tutorial' && (
                <View style={{ paddingTop: 6 }}>
                  <SlideCarousel pageW={Math.min(SW * 0.86, 400) - 32} imgH={340} />
                </View>
              )}
              <View style={{ height: 10 }} />
            </ScrollView>

            {/* Ask box */}
            {view !== 'tutorial' && (
              <View style={s.askBar}>
                <TextInput
                  value={input} onChangeText={setInput}
                  placeholder="Ask about the app…" placeholderTextColor="#8896B0"
                  style={s.askInput} returnKeyType="send" onSubmitEditing={() => ask()}
                />
                <TouchableOpacity onPress={() => ask()} disabled={!input.trim()} style={[s.askSend, !input.trim() && { opacity: 0.45 }]} activeOpacity={0.85}>
                  <Ionicons name="arrow-up" size={18} color="#fff" />
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  fabWrap: { position: 'absolute', right: 16, bottom: Platform.OS === 'ios' ? 120 : 100, zIndex: 999 },
  fab: { width: 56, height: 56 },
  fabGrad: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', shadowColor: '#2563EB', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 12, elevation: 8 },
  fabBadge: { position: 'absolute', top: -2, right: -2, width: 20, height: 20, borderRadius: 10, backgroundColor: '#0B1120', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },

  overlay: { flex: 1, backgroundColor: 'rgba(6,10,25,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#F4F7FC', borderTopLeftRadius: 26, borderTopRightRadius: 26, maxHeight: SH * 0.82, paddingBottom: Platform.OS === 'ios' ? 28 : 14 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(11,15,34,0.06)' },
  headerIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 15.5, fontWeight: '800', color: '#0B0F22' },
  headerSub: { fontSize: 11.5, color: '#5B6B8A', marginTop: 1 },
  headerBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },

  body: { paddingHorizontal: 16, paddingTop: 14 },
  greetRow: { marginBottom: 14 },
  botBubble: { backgroundColor: '#fff', borderRadius: 16, borderTopLeftRadius: 4, padding: 13, borderWidth: 1, borderColor: 'rgba(11,15,34,0.05)', maxWidth: '92%' },
  botText: { fontSize: 13.5, color: '#334155', lineHeight: 20 },
  notFound: { flexDirection: 'row', gap: 7, alignItems: 'center', backgroundColor: 'rgba(59,130,246,0.08)', borderRadius: 10, padding: 10, marginBottom: 12 },
  notFoundText: { flex: 1, fontSize: 12.5, color: '#3B82F6', fontWeight: '600' },
  sectionLbl: { fontSize: 10.5, fontWeight: '800', color: '#8896B0', letterSpacing: 0.8, marginBottom: 9, marginLeft: 2 },
  suggRow: { flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(11,15,34,0.05)', paddingHorizontal: 13, paddingVertical: 13, marginBottom: 9 },
  suggIcon: { width: 32, height: 32, borderRadius: 10, backgroundColor: 'rgba(59,130,246,0.10)', alignItems: 'center', justifyContent: 'center' },
  suggText: { flex: 1, fontSize: 13.5, fontWeight: '700', color: '#0B0F22' },
  tutorialBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: 'rgba(59,130,246,0.08)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(59,130,246,0.2)', height: 48, marginTop: 4, marginBottom: 6 },
  tutorialText: { fontSize: 14, fontWeight: '800', color: '#3B82F6' },

  answerCard: { backgroundColor: '#fff', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(11,15,34,0.05)', padding: 15, marginBottom: 6 },
  answerTitle: { fontSize: 15.5, fontWeight: '800', color: '#0B0F22', marginBottom: 12, letterSpacing: -0.2 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, marginBottom: 13 },
  stepNum: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#0B1120', alignItems: 'center', justifyContent: 'center' },
  stepNumText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  stepText: { flex: 1, fontSize: 13.5, color: '#334155', lineHeight: 20 },

  optionCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(11,15,34,0.06)', padding: 14, marginBottom: 11 },
  optIcon: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  optTitle: { fontSize: 14.5, fontWeight: '800', color: '#0B0F22' },
  optSub: { fontSize: 12, color: '#5B6B8A', marginTop: 3, lineHeight: 16 },

  askBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 10 },
  askInput: { flex: 1, backgroundColor: '#fff', borderRadius: 22, borderWidth: 1, borderColor: 'rgba(11,15,34,0.08)', paddingHorizontal: 16, height: 44, fontSize: 14, color: '#0B0F22' },
  askSend: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center' },
});
