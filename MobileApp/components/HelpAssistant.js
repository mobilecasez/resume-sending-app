// AI Hub — in-app help assistant. Safe to delete without affecting the existing app.
// A draggable floating button (hold to move anywhere) that opens a guided assistant: ask a question
// in plain words → scripted, step-by-step answers (no AI/LLM cost). "How to apply" branches into
// "I have the employer details" vs "Search for a job first". A "View tutorial" button replays the
// intro guide (SlideCarousel). Pure StyleSheet + Ionicons + expo-linear-gradient.
import React, { useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, TextInput, ScrollView, Animated, PanResponder,
  Dimensions, Platform, Keyboard, Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SlideCarousel } from './WelcomeExplainer';

const { width: SW, height: SH } = Dimensions.get('window');

// ── Scripted knowledge base ─────────────────────────────────────────────────
// A step can carry a SHOT — a real screenshot of that moment, cropped to the control it is about and
// ringed. Built by tools/build-guide-steps.js from the same recordings as the onboarding GIFs, so the
// guide SHOWS the app as it is now instead of describing a version of it.
const STEP = (icon, text, shot) => ({ icon, text, shot });
const SHOT = {
  profileMenu: require('../assets/onboarding/steps/profile-menu.png'),
  profileDetails: require('../assets/onboarding/steps/profile-details.png'),
  profileResume: require('../assets/onboarding/steps/profile-resume.png'),
  profileSign: require('../assets/onboarding/steps/profile-sign.png'),
  profileSave: require('../assets/onboarding/steps/profile-save.png'),
  resumeOpen: require('../assets/onboarding/steps/resume-open.png'),
  resumeStory: require('../assets/onboarding/steps/resume-story.png'),
  resumeGenerate: require('../assets/onboarding/steps/resume-generate.png'),
  resumeResult: require('../assets/onboarding/steps/resume-result.png'),
  resumeDownload: require('../assets/onboarding/steps/resume-download.png'),
  findSearch: require('../assets/onboarding/steps/find-search.png'),
  findResults: require('../assets/onboarding/steps/find-results.png'),
  findFetch: require('../assets/onboarding/steps/find-fetch.png'),
  findSaved: require('../assets/onboarding/steps/find-saved.png'),
  clOpen: require('../assets/onboarding/steps/cl-open.png'),
  clWriting: require('../assets/onboarding/steps/cl-writing.png'),
  clFormats: require('../assets/onboarding/steps/cl-formats.png'),
  clDownload: require('../assets/onboarding/steps/cl-download.png'),
  applyRobot: require('../assets/onboarding/steps/apply-robot.png'),
  applyAutofill: require('../assets/onboarding/steps/apply-autofill.png'),
  applyReview: require('../assets/onboarding/steps/apply-review.png'),
  applyAttached: require('../assets/onboarding/steps/apply-attached.png'),
  applyDone: require('../assets/onboarding/steps/apply-done.png'),
};

// Ordered the way a new user actually goes: set up -> resume -> find a job -> letter -> apply.
const KB = [
  {
    id: 'profile', label: 'Set up my profile', icon: 'person-circle-outline',
    match: /\bprofile|account|signature|detail|set ?up|start\b/i,
    title: 'Set up your profile first',
    intro: 'Everything else reuses this — your details, résumé and signature go onto every form and letter.',
    steps: [
      STEP('menu-outline', 'Open the ☰ menu and tap “Account Settings”.', SHOT.profileMenu),
      STEP('create-outline', 'Fill in your name, email, phone, address and date of birth. Auto Fill puts these on job forms for you.', SHOT.profileDetails),
      STEP('document-attach-outline', 'Upload your résumé here. It gets attached when you apply, and it unlocks match scores.', SHOT.profileResume),
      STEP('color-wand-outline', 'Tap “Generate Signature from Name”, or upload your own signature.', SHOT.profileSign),
      STEP('checkmark-done-outline', 'Tap “Save Changes”. You only do this once.', SHOT.profileSave),
    ],
  },
  {
    id: 'resume', label: 'Build or upload a résumé', icon: 'document-text-outline',
    match: /\bresume|résumé|\bcv\b|upload|builder\b/i,
    title: 'Get a résumé the AI writes for you',
    intro: 'Already uploaded one to your profile? The builder can merge it with your story instead of starting over.',
    steps: [
      STEP('menu-outline', 'Open the ☰ menu and tap “Resume Builder”.', SHOT.resumeOpen),
      STEP('chatbubble-ellipses-outline', 'Paste your story — old résumé text, a LinkedIn bio, rough notes. Tick “Include my uploaded resume” to use both.', SHOT.resumeStory),
      STEP('sparkles-outline', 'Tap “Generate My Resume with AI”.', SHOT.resumeGenerate),
      STEP('reader-outline', 'Read it through — every section is editable.', SHOT.resumeResult),
      STEP('download-outline', 'Pick the country format and download as PDF or Word. Previewing is free.', SHOT.resumeDownload),
    ],
  },
  {
    id: 'find', label: 'Find a job', icon: 'search-outline',
    match: /\bfind|search|discover|explore|look(ing)? for|browse|google\b/i,
    title: 'Find a job on Google, inside the app',
    intro: 'This is the real Google — the same results you would get in your phone’s browser.',
    steps: [
      STEP('globe-outline', 'Type what you want (“dotnet jobs in netherlands”) and tap “Search live on Google”.', SHOT.findSearch),
      STEP('open-outline', 'Real Google results open in the app. Tap any result to read the job.', SHOT.findResults),
      STEP('sparkles-outline', 'Once you are on the job’s own page, tap the robot → “Fetch job”. CVApplyr reads the posting and saves it.', SHOT.findFetch),
      STEP('bookmark-outline', 'It lands in Saved Jobs with the full details filled in.', SHOT.findSaved),
    ],
  },
  {
    id: 'cover', label: 'Generate a cover letter', icon: 'mail-outline',
    match: /\bcover ?letter|letter|motivation\b/i,
    title: 'A cover letter written from the real posting',
    steps: [
      STEP('reader-outline', 'Open the saved job and tap “View & Apply”.', SHOT.clOpen),
      STEP('sparkles-outline', 'The AI writes the letter from that job’s actual description — nothing to type.', SHOT.clWriting),
      STEP('flag-outline', 'Choose the country format the employer expects.', SHOT.clFormats),
      STEP('download-outline', 'Download it as PDF or Word — or let it attach itself when you apply.', SHOT.clDownload),
    ],
  },
  {
    id: 'apply', label: 'Apply with Auto Fill', icon: 'flash-outline',
    match: /\bapply|application|applying|auto ?fill|form\b/i,
    title: 'Let Auto Fill do the form',
    intro: 'Works on the company’s own application form — Greenhouse, Workday, Personio and the rest.',
    steps: [
      STEP('sparkles-outline', 'On the application page, tap the floating robot to open Job tools.', SHOT.applyRobot),
      STEP('flash-outline', 'Tap “Auto Fill”. It reads the whole form and fills in everything it knows about you.', SHOT.applyAutofill),
      STEP('eye-outline', 'Check the summary — anything needing your judgement is listed under “Still needs you”.', SHOT.applyReview),
      STEP('cloud-upload-outline', 'Tap each upload field to attach your résumé and cover letter.', SHOT.applyAttached),
      STEP('checkmark-done-outline', 'Submit on the site. CVApplyr marks the job Applied on your dashboard.', SHOT.applyDone),
    ],
  },
];

const GREETING = "Hi! I'm your CVApplyr assistant. Ask me anything — like how to apply, how to find a job, or how to make a cover letter.";

function StepList({ title, intro, steps }) {
  return (
    <View style={s.answerCard}>
      {!!title && <Text style={s.answerTitle}>{title}</Text>}
      {!!intro && <Text style={s.answerIntro}>{intro}</Text>}
      {steps.map((st, i) => (
        <View key={i} style={s.stepBlock}>
          <View style={s.stepRow}>
            <View style={s.stepNum}><Text style={s.stepNumText}>{i + 1}</Text></View>
            <Ionicons name={st.icon} size={16} color="#3B82F6" style={{ marginTop: 1 }} />
            <Text style={s.stepText}>{st.text}</Text>
          </View>
          {/* The shot is cropped to just the control this step is about, with the same cyan ring the
              tutorial uses — so "tap the robot" is something you can recognise, not just read. */}
          {!!st.shot && <Image source={st.shot} style={s.stepShot} resizeMode="contain" />}
        </View>
      ))}
    </View>
  );
}

export default function HelpAssistant() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState('home');   // home | answer | tutorial
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
    setAnswer({ title: t.title, intro: t.intro, steps: t.steps }); setView('answer'); setNotFound(false);
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
                <StepList title={answer.title} intro={answer.intro} steps={answer.steps} />
              )}

              {view === 'tutorial' && (
                <View style={s.tutorialStage}>
                  {/* Full sheet width and as tall as the sheet allows — at 340 the phone recording
                      was scaled down to about a third of its size and the UI in it was unreadable. */}
                  <SlideCarousel pageW={Math.min(SW, 520) - 24} imgH={Math.min(SH * 0.56, 560)} />
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
  sheet: { backgroundColor: '#F4F7FC', borderTopLeftRadius: 26, borderTopRightRadius: 26, maxHeight: SH * 0.92, paddingBottom: Platform.OS === 'ios' ? 28 : 14 },
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
  answerIntro: { fontSize: 12.5, color: '#5B6B8A', lineHeight: 18, marginTop: -4, marginBottom: 12 },
  stepBlock: { marginBottom: 16 },
  stepShot: { width: '100%', aspectRatio: 440 / 266, marginTop: 9, borderRadius: 12, backgroundColor: '#F1F5F9' },
  tutorialStage: { marginHorizontal: -16, paddingTop: 4, alignItems: 'center' },
  answerTitle: { fontSize: 15.5, fontWeight: '800', color: '#0B0F22', marginBottom: 12, letterSpacing: -0.2 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
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
