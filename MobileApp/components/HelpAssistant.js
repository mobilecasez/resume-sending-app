// AI Hub — in-app help assistant. Safe to delete without affecting the existing app.
// A draggable floating button (drag to move anywhere — the spot is remembered) that opens a guided
// assistant: ask a question in plain words → scripted, step-by-step answers (no AI/LLM cost), each
// step carrying a FULL screenshot of that moment with a cyan ring on the control it names.
// A "Watch tutorial" link on every topic jumps to that topic's video in the guide carousel.
//
// It is also a proactive coach: it knows how far the user's setup has come (profile → résumé →
// photo/signature → first job fetched → cover letter → applied) and speaks up from the button with
// a small glass popup ("Hey — your profile is incomplete…", typed out character by character) until
// the journey is complete. After that it stays silent and waits to be tapped.
//
// The button is mounted on Home AND in the router layouts, so it follows the user through the app;
// module-level shared state below makes those instances feel like ONE button (same dragged position,
// each nudge shown once per session, only the topmost instance speaks).
// Pure StyleSheet + Ionicons + expo-linear-gradient.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, TextInput, ScrollView, Animated, PanResponder,
  Dimensions, Platform, Keyboard, Image, Easing,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SlideCarousel, HELP_FAB } from './WelcomeExplainer';

const { width: SW, height: SH } = Dimensions.get('window');
// Full phone-frame screenshots (tools/build-guide-steps.js writes 320x696) — shown whole, never
// cropped. Small enough in the card to keep a five-step answer scannable; tap to read full size.
const SHOT_RATIO = 320 / 696;
const SHOT_W = Math.min(Math.round(SW * 0.42), 168);

// ── Scripted knowledge base ─────────────────────────────────────────────────
// A step can carry a SHOT — the full screen at that moment, ringed the way the tutorial rings it.
// Built by tools/build-guide-steps.js from the same recordings as the onboarding GIFs, so the
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
// `video` = index of this topic's slide in the tutorial carousel (WelcomeExplainer.TUTORIAL_SLIDES).
const KB = [
  {
    id: 'profile', label: 'Set up my profile', icon: 'person-circle-outline', video: 0,
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
    id: 'resume', label: 'Build or upload a résumé', icon: 'document-text-outline', video: 1,
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
    id: 'find', label: 'Find a job', icon: 'search-outline', video: 2,
    match: /\bfind|search|discover|explore|look(ing)? for|browse|google\b/i,
    title: 'Find a job on Google, inside the app',
    intro: 'This is the real Google — the same results you would get in your phone’s browser.',
    steps: [
      STEP('globe-outline', 'On the Jobs tab, type what you want (“dotnet jobs in netherlands”) and tap “Google Search”.', SHOT.findSearch),
      STEP('open-outline', 'Real Google results open in the app. Tap any result to read the job.', SHOT.findResults),
      STEP('sparkles-outline', 'Once you are on the job’s own page, tap the robot → “Fetch job”. CVApplyr reads the posting and saves it.', SHOT.findFetch),
      STEP('bookmark-outline', 'It lands in Saved Jobs with the full details filled in.', SHOT.findSaved),
    ],
  },
  {
    id: 'cover', label: 'Generate a cover letter', icon: 'mail-outline', video: 2,
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
    id: 'apply', label: 'Apply with Auto Fill', icon: 'flash-outline', video: 3,
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

// ── Proactive coach: what to say at each point of the journey ───────────────────────────────────
// Ordered checks; the FIRST unmet one is the current stage. `topic` = the KB page "Show me how" opens.
const COACH_STAGES = [
  { key: 'profile', topic: 'profile', when: (s) => !s.setup.profile,
    msg: 'Hey! Your profile is incomplete. Please update it to continue — tap below and I’ll show you how.' },
  { key: 'resume', topic: 'resume', when: (s) => !s.setup.resume,
    msg: 'Nice, profile done! Now add your résumé — upload one or let the AI build it. It powers everything here.' },
  { key: 'finishing', topic: 'profile', when: (s) => !s.setup.photo || !s.setup.signature,
    msg: 'Almost set! Add your photo and signature — they go on your applications and cover letters.' },
  { key: 'find', topic: 'find', when: (s) => s.savedCount === 0 && s.statusCount === 0,
    msg: 'You’re all set up! Let me show you how to search a job on Google and fetch it into the app.' },
  { key: 'cover', topic: 'cover', when: (s) => !s.hasCoverLetter,
    msg: 'You’ve saved a job — now let the AI write its cover letter from the real posting. Here’s how.' },
  { key: 'apply', topic: 'apply', when: (s) => !s.hasApplied,
    msg: 'Your letter is ready — let Auto Fill do the application form for you. Here’s how.' },
];

// Which stage to raise FIRST depends on where the user is standing: on the Jobs page the flow they
// came for is find → cover letter → Auto Fill, so those outrank an unfinished profile there.
const CONTEXT_ORDER = {
  home:   ['profile', 'resume', 'finishing', 'find', 'cover', 'apply'],
  jobs:   ['find', 'cover', 'apply', 'profile', 'resume', 'finishing'],
  resume: ['resume', 'profile', 'finishing', 'find', 'cover', 'apply'],
  cover:  ['cover', 'apply', 'find', 'profile', 'resume', 'finishing'],
};

// Copy for the ALWAYS_SHOW_GUIDE tour: the stage is already DONE, so the incomplete-stage wording
// ("your profile is incomplete") would be a lie — these are neutral "here's how it works" lines.
const TOUR_MSG = {
  profile: 'Here’s how to set up your profile — it powers every application and letter.',
  resume: 'Here’s how to upload your résumé, or let the AI build one for you.',
  finishing: 'Here’s how to add your photo and signature to your applications.',
  find: 'Let me show you how to search a job on Google and fetch it into the app.',
  cover: 'Here’s how to generate a cover letter written from the real job posting.',
  apply: 'Here’s how to apply with Auto Fill — it fills the whole form for you.',
};

// The current stage for this screen. Normal mode: the first UNMET stage not yet nudged this
// session (dismissing one lets the next unmet stage speak on the next screen visit). With the
// server's ALWAYS_SHOW_GUIDE flag on, the coach never goes silent: once everything is met it
// still walks the stages in context order with the neutral tour wording (testing/demo).
function pickStage(st, context, always) {
  const order = CONTEXT_ORDER[context] || CONTEXT_ORDER.home;
  const stages = order.map((k) => COACH_STAGES.find((c) => c.key === k)).filter(Boolean);
  for (const c of stages) {
    let unmet = false;
    try { unmet = c.when(st); } catch {}
    if (unmet && !shared.coachShown[c.key]) return c;
  }
  if (!always) return null;
  for (const c of stages) {
    if (!shared.coachShown[c.key]) return { ...c, msg: TOUR_MSG[c.key] || c.msg };
  }
  return null;
}

// ── State shared across every mounted instance (Home + each router layout) ──────────────────────
// One dragged position, one "already nudged" ledger, and a stack that names the TOPMOST instance —
// the only one allowed to speak, so a popup never fires twice from two layers at once.
const POS_KEY = 'help_fab_pos_v1';
const shared = {
  pos: { x: 0, y: 0 },
  posLoaded: false,
  stack: [],                 // instance ids, last = topmost/visible
  listeners: new Set(),      // notified on pos/stack changes
  coachShown: {},            // stage key → nudged this app session
  coachAt: 0,                // last status fetch (ms) — throttles refetch across instances
  coachStatus: null,         // last computed status snapshot
  guideAlways: null,         // server ALWAYS_SHOW_GUIDE flag (null = not fetched yet)
  guideAt: 0,
};
const notify = () => { shared.listeners.forEach((fn) => { try { fn(); } catch {} }); };

// Keep the button on-screen wherever it is dropped. The top margin leaves room for the coach popup
// that grows ~170px ABOVE the button — without it a top-dragged button speaks off-screen.
const clampPos = (p) => ({
  x: Math.max(-(SW - HELP_FAB.right - HELP_FAB.size - 6), Math.min(HELP_FAB.right - 6, p.x)),
  y: Math.max(-(SH - HELP_FAB.bottom - HELP_FAB.size - 190), Math.min(HELP_FAB.bottom - 28, p.y)),
});

// Server-controlled "never go silent" switch (env ALWAYS_SHOW_GUIDE on Railway → /app-config).
// Lets the guide be demoed on a fully-set-up account without a rebuild.
async function loadGuideFlag() {
  const now = Date.now();
  if (shared.guideAlways != null && now - shared.guideAt < 60000) return shared.guideAlways;
  shared.guideAt = now;
  try {
    const { API_BASE } = require('../config');
    if (!API_BASE) { shared.guideAlways = false; return false; }
    const r = await fetch(`${API_BASE}/app-config`);
    const cfg = r.ok ? await r.json() : null;
    shared.guideAlways = !!(cfg && cfg.alwaysShowGuide);
  } catch { if (shared.guideAlways == null) shared.guideAlways = false; }
  return shared.guideAlways;
}

async function loadCoachStatus(force = false) {
  const now = Date.now();
  if (!force && shared.coachStatus && now - shared.coachAt < 45000) return shared.coachStatus;
  shared.coachAt = now;
  try {
    const svc = require('../services/aiHubService');
    const [setup, saved, statuses] = await Promise.all([
      svc.fetchSetupStatus(),
      svc.fetchSavedJobs().catch(() => ({ count: 0 })),
      svc.loadAllJobStatuses(),
    ]);
    if (!setup) return null;   // signed out / offline → unknown, stay silent
    const vals = Object.values(statuses || {});
    shared.coachStatus = {
      setup,
      savedCount: saved?.count || 0,
      statusCount: vals.length,
      hasCoverLetter: vals.some((v) => v === 'generated' || v === 'downloaded' || v === 'applied'),
      hasApplied: vals.some((v) => v === 'applied'),
    };
    return shared.coachStatus;
  } catch { return null; }
}

// One card per step: the instruction on top, the full ringed screen under it — tap to enlarge.
function StepList({ title, intro, steps, onZoom, onWatch }) {
  return (
    <View>
      {!!title && <Text style={s.answerTitle}>{title}</Text>}
      {!!onWatch && (
        <TouchableOpacity style={s.watchBtn} activeOpacity={0.85} onPress={onWatch}>
          <Ionicons name="play-circle" size={17} color="#fff" />
          <Text style={s.watchText}>Watch video tutorial</Text>
          <Ionicons name="chevron-forward" size={14} color="rgba(255,255,255,0.8)" />
        </TouchableOpacity>
      )}
      {!!intro && <Text style={s.answerIntro}>{intro}</Text>}
      {steps.map((st, i) => (
        <View key={i} style={s.stepCard}>
          <View style={s.stepRow}>
            <View style={s.stepNum}><Text style={s.stepNumText}>{i + 1}</Text></View>
            <View style={s.stepIcon}><Ionicons name={st.icon} size={13} color="#3B82F6" /></View>
            <Text style={s.stepText}>{st.text}</Text>
          </View>
          {/* The whole screen at that moment, ringed the way the tutorial rings it — full image,
              never cropped (cropped bands read as broken screenshots). */}
          {!!st.shot && (
            <TouchableOpacity activeOpacity={0.85} style={s.shotWrap} onPress={() => onZoom && onZoom(st, i + 1)}>
              <Image source={st.shot} style={s.stepShot} resizeMode="contain" />
              <View style={s.shotZoom}><Ionicons name="expand-outline" size={11} color="#fff" /></View>
            </TouchableOpacity>
          )}
        </View>
      ))}
    </View>
  );
}

// `attention` — bump it (any changing number) to make the button announce itself. HomeScreen bumps it
// when the first-run guide is dismissed, right after the guide has visibly flown into this button.
// `context` — which screen family hosts this instance ('home' | 'jobs' | 'resume' | 'cover'); it
// decides which coach stage speaks first there (on Jobs: find → cover → apply before profile).
export default function HelpAssistant({ attention = 0, context = 'home' }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState('home');   // home | answer | tutorial
  const [answer, setAnswer] = useState(null);  // {title, intro, steps, video}
  const [tutorialAt, setTutorialAt] = useState(0);   // which slide the tutorial opens on
  const [input, setInput] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [zoom, setZoom] = useState(null);      // {shot, text, n} — a step screenshot at full size

  // ── Draggable floating button — position shared + remembered ───────────────────────────────────
  const pan = useRef(new Animated.ValueXY(shared.pos)).current;
  const moved = useRef(false);
  const id = useRef('fab_' + Math.random().toString(36).slice(2)).current;
  const [, force] = useState(0);
  const isTop = shared.stack.length === 0 || shared.stack[shared.stack.length - 1] === id;

  useEffect(() => {
    shared.stack.push(id);
    const onChange = () => { pan.setValue(shared.pos); force((n) => n + 1); };
    shared.listeners.add(onChange);
    if (!shared.posLoaded) {
      shared.posLoaded = true;
      AsyncStorage.getItem(POS_KEY).then((r) => {
        if (!r) return;
        try { const p = clampPos(JSON.parse(r)); shared.pos = p; notify(); } catch {}
      }).catch(() => {});
    }
    notify();
    return () => {
      const i = shared.stack.indexOf(id);
      if (i >= 0) shared.stack.splice(i, 1);
      shared.listeners.delete(onChange);
      notify();
    };
  }, []);

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
        if (!moved.current) { setOpen(true); return; }   // tap (not drag) → open
        // Snap inside the screen, remember the spot, and tell the other instances.
        const p = clampPos({ x: pan.x.__getValue(), y: pan.y.__getValue() });
        shared.pos = p;
        Animated.spring(pan, { toValue: p, friction: 7, useNativeDriver: false }).start(() => notify());
        AsyncStorage.setItem(POS_KEY, JSON.stringify(p)).catch(() => {});
      },
    })
  ).current;

  // Dragging the COACH POPUP moves the whole assistant too (popup + button share `pan`). Unlike the
  // button's responder this must NOT claim the touch on start — the popup has its own tappable
  // children (See how / close), and claiming on start would eat their taps. It claims on movement.
  const popupResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
      onPanResponderGrant: () => {
        pan.setOffset({ x: pan.x.__getValue(), y: pan.y.__getValue() });
        pan.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: (_e, g) => pan.setValue({ x: g.dx, y: g.dy }),
      onPanResponderRelease: () => {
        pan.flattenOffset();
        const p = clampPos({ x: pan.x.__getValue(), y: pan.y.__getValue() });
        shared.pos = p;
        Animated.spring(pan, { toValue: p, friction: 7, useNativeDriver: false }).start(() => notify());
        AsyncStorage.setItem(POS_KEY, JSON.stringify(p)).catch(() => {});
      },
      onPanResponderTerminationRequest: () => false,
    })
  ).current;

  // ── "Your guide lives here" ────────────────────────────────────────────────────────────────────
  // The intro popup shrinks into this button; the moment it lands, the button rings and says so.
  const ring = useRef(new Animated.Value(0)).current;
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!attention) return undefined;
    setHint(true);
    ring.setValue(0);
    // One timing, not a sequence with Animated.delay — delay runs on the JS driver and mixing drivers
    // inside one sequence is a trap. The loop resets the value before each iteration for us.
    const loop = Animated.loop(
      Animated.timing(ring, { toValue: 1, duration: 1250, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      { iterations: 3 }
    );
    loop.start();
    const t = setTimeout(() => setHint(false), 4600);
    return () => { loop.stop(); clearTimeout(t); };
  }, [attention, ring]);
  // Opening the assistant is the lesson learnt — stop nagging.
  useEffect(() => { if (open) setHint(false); }, [open]);

  // ── Proactive coach ────────────────────────────────────────────────────────────────────────────
  // Only the topmost instance speaks; each stage nudges once per app session and comes back on the
  // next launch until that stage is done. Completing a stage mid-session lets the NEXT nudge fire.
  const [coach, setCoach] = useState(null);      // the stage being shown, or null
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (!isTop || open) return undefined;
    let alive = true;
    const t = setTimeout(async () => {
      const [always, st] = await Promise.all([loadGuideFlag(), loadCoachStatus()]);
      if (!alive) return;
      // Unknown status (offline / signed out) → silent, UNLESS the demo flag is on — then tour a
      // synthetic "everything done" state so the walkthrough still runs.
      const base = st || (always ? {
        setup: { profile: true, resume: true, photo: true, signature: true },
        savedCount: 1, statusCount: 1, hasCoverLetter: true, hasApplied: true,
      } : null);
      if (!base) return;
      const stage = pickStage(base, context, always);
      if (stage) setCoach(stage);
    }, hint ? 5200 : 1800);   // let the "guide lives here" hint finish first
    return () => { alive = false; clearTimeout(t); };
  }, [isTop, open, hint, attention, context]);

  // Typing animation — the message writes itself out, which is what makes the popup feel alive.
  useEffect(() => {
    if (!coach) { setTyped(''); return undefined; }
    setTyped('');
    let i = 0;
    const msg = coach.msg;
    const t = setInterval(() => {
      i += 2;
      setTyped(msg.slice(0, i));
      if (i >= msg.length) clearInterval(t);
    }, 26);
    return () => clearInterval(t);
  }, [coach]);

  // ── Idle flash ─────────────────────────────────────────────────────────────────────────────────
  // When the coach has nothing to say and no hint is up, the button occasionally flashes a small
  // "For any help, Tap me!!" bubble so a quiet screen still shows where help lives. Fades in for a
  // few seconds, fades out, repeats — tapping it opens the assistant.
  const [idle, setIdle] = useState(false);
  const idleA = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!isTop || open || coach || hint) { setIdle(false); idleA.setValue(0); return undefined; }
    let alive = true;
    const timers = [];
    const flash = () => {
      if (!alive) return;
      setIdle(true);
      // ⚠️ JS driver, NEVER native: the bubble's view also carries the drag position `pan` in its
      // transform. A native-driver animation on ANY value of a view migrates every value attached
      // to that view to native nodes — pan included — and the next JS-driven drag then throws the
      // FATAL "Attempting to run JS driven animation on animated node that has been moved to
      // native". That was a real crash in build 128, caught by the global guard.
      Animated.timing(idleA, { toValue: 1, duration: 320, useNativeDriver: false }).start();
      timers.push(setTimeout(() => {
        Animated.timing(idleA, { toValue: 0, duration: 450, useNativeDriver: false })
          .start(() => { if (alive) setIdle(false); });
      }, 3600));
    };
    timers.push(setTimeout(flash, 7000));       // first flash a little after the screen settles
    const iv = setInterval(flash, 32000);        // then a gentle reminder every so often
    return () => { alive = false; clearInterval(iv); timers.forEach(clearTimeout); };
  }, [isTop, open, coach, hint]);

  const dismissCoach = useCallback(() => {
    if (coach) shared.coachShown[coach.key] = true;
    setCoach(null);
  }, [coach]);
  const coachShowHow = useCallback(() => {
    if (!coach) return;
    const topic = KB.find((t) => t.id === coach.topic);
    shared.coachShown[coach.key] = true;
    setCoach(null);
    if (topic) {
      setAnswer({ title: topic.title, intro: topic.intro, steps: topic.steps, video: topic.video });
      setView('answer');
      setOpen(true);
    }
  }, [coach]);

  // Always clear the zoom on the way out, or reopening the assistant lands straight back on the
  // enlarged screenshot the user closed the sheet from.
  const closeSheet = () => { setZoom(null); setOpen(false); };
  const goHome = () => { setView('home'); setAnswer(null); setNotFound(false); setInput(''); setZoom(null); };
  const showTopic = (t) => {
    setAnswer({ title: t.title, intro: t.intro, steps: t.steps, video: t.video }); setView('answer'); setNotFound(false);
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

  // The popup hangs off the button, so it follows wherever the button was dragged. When the button
  // sits in the LEFT half of the screen the popup grows to the right of it instead.
  const fabCx = SW - HELP_FAB.right - HELP_FAB.size / 2 + shared.pos.x;
  const coachOnLeft = fabCx < SW / 2;

  return (
    <>
      {/* Floating draggable button */}
      {!open && (
        <Animated.View
          style={[s.fabWrap, { transform: pan.getTranslateTransform() }]}
          {...responder.panHandlers}
        >
          <View style={s.fab}>
            {/* expanding ring — drawn behind the button, so the button itself never moves under a tap */}
            <Animated.View
              pointerEvents="none"
              style={[s.fabRing, {
                opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
                transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 2.1] }) }],
              }]}
            />
            <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.fabGrad}>
              <Ionicons name="sparkles" size={22} color="#fff" />
            </LinearGradient>
            <View style={s.fabBadge}><Ionicons name="help" size={11} color="#fff" /></View>
          </View>
        </Animated.View>
      )}

      {/* Deliberately NOT inside the draggable wrapper: that wrapper answers every touch in its
          bounds, so a bubble parented to it would become a large invisible "open help" target. */}
      {!open && hint && !coach && (
        <Animated.View style={[s.hint, { transform: pan.getTranslateTransform() }]} pointerEvents="none">
          <Text style={s.hintText}>Your guide lives here — open it any time</Text>
        </Animated.View>
      )}

      {/* ── Coach popup — a translucent thought-cloud that types its message. It hangs off the
             button (two puffs trail down toward it) and DRAGGING the cloud moves both together. ── */}
      {!open && !!coach && (
        <Animated.View
          style={[s.coach, coachOnLeft ? s.coachLeft : s.coachRight, { transform: pan.getTranslateTransform() }]}
          {...popupResponder.panHandlers}
        >
          <View style={[s.cloud, coachOnLeft ? s.cloudTailLeft : s.cloudTailRight]}>
            <View style={s.coachHead}>
              <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.coachIcon}>
                <Ionicons name="sparkles" size={12} color="#fff" />
              </LinearGradient>
              <Text style={s.coachTitle}>Your guide</Text>
              <TouchableOpacity onPress={dismissCoach} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={16} color="rgba(255,255,255,0.7)" />
              </TouchableOpacity>
            </View>
            <Text style={s.coachMsg}>
              {typed}
              {typed.length < (coach?.msg?.length || 0) ? <Text style={s.coachCaret}>▍</Text> : null}
            </Text>
            <TouchableOpacity style={s.coachCta} activeOpacity={0.85} onPress={coachShowHow} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
              <Ionicons name="play-circle-outline" size={13} color="#67E8F9" />
              <Text style={s.coachCtaText}>See how</Text>
              <Ionicons name="arrow-forward" size={11} color="#67E8F9" />
            </TouchableOpacity>
          </View>
          {/* the trail of puffs that ties the cloud to the button */}
          <View style={[s.puff, s.puffBig, coachOnLeft ? { left: 22 } : { right: 22 }]} />
          <View style={[s.puff, s.puffSmall, coachOnLeft ? { left: 8 } : { right: 6 }]} />
        </Animated.View>
      )}

      {/* ── Idle flash — nothing to say, so just wave occasionally. Tapping it opens the guide. ── */}
      {!open && idle && !coach && !hint && (
        <Animated.View
          style={[s.idleWrap, coachOnLeft ? s.coachLeft : s.coachRight, { opacity: idleA, transform: pan.getTranslateTransform() }]}
        >
          <TouchableOpacity activeOpacity={0.85} onPress={() => setOpen(true)} style={[s.cloud, s.idleCloud, coachOnLeft ? s.cloudTailLeft : s.cloudTailRight]}>
            <Text style={s.idleText}>For any help, Tap me!!</Text>
          </TouchableOpacity>
          <View style={[s.puff, s.puffBig, coachOnLeft ? { left: 18 } : { right: 18 }]} />
          <View style={[s.puff, s.puffSmall, coachOnLeft ? { left: 6 } : { right: 4 }]} />
        </Animated.View>
      )}

      <Modal
        visible={open} transparent animationType="slide"
        onRequestClose={() => { if (zoom) setZoom(null); else setOpen(false); }}
      >
        <View style={s.overlay}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={closeSheet} />
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
              <TouchableOpacity onPress={closeSheet} style={s.headerBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
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
                  <TouchableOpacity style={s.tutorialBtn} activeOpacity={0.9} onPress={() => { setTutorialAt(0); setView('tutorial'); }}>
                    <Ionicons name="play-circle-outline" size={18} color="#3B82F6" />
                    <Text style={s.tutorialText}>View tutorial</Text>
                  </TouchableOpacity>
                </>
              )}

              {view === 'answer' && answer && (
                <StepList
                  title={answer.title} intro={answer.intro} steps={answer.steps}
                  onZoom={(st, n) => setZoom({ shot: st.shot, text: st.text, n })}
                  onWatch={typeof answer.video === 'number' ? () => { setTutorialAt(answer.video); setView('tutorial'); } : null}
                />
              )}

              {view === 'tutorial' && (
                <View style={s.tutorialStage}>
                  {/* Full sheet width and as tall as the sheet allows — at 340 the phone recording
                      was scaled down to about a third of its size and the UI in it was unreadable. */}
                  <SlideCarousel pageW={Math.min(SW, 520) - 24} imgH={Math.min(SH * 0.56, 560)} initialIndex={tutorialAt} />
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

          {/* ⚠️ A sibling layer inside the SAME Modal, never a nested <Modal> — nesting one modal in
              another hard-crashed iOS in build 87. */}
          {!!zoom && (
            <View style={s.zoomLayer}>
              <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setZoom(null)} />
              <View style={s.zoomCard}>
                <View style={s.zoomHead}>
                  <View style={s.stepNum}><Text style={s.stepNumText}>{zoom.n}</Text></View>
                  <Text style={s.zoomText}>{zoom.text}</Text>
                </View>
                <Image source={zoom.shot} style={s.zoomImg} resizeMode="contain" />
                <TouchableOpacity style={s.zoomClose} onPress={() => setZoom(null)} activeOpacity={0.85}>
                  <Ionicons name="close" size={16} color="#fff" />
                  <Text style={s.zoomCloseText}>Close</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  // Positioned from HELP_FAB so the intro popup's dismiss animation lands exactly on this button.
  fabWrap: { position: 'absolute', right: HELP_FAB.right, bottom: HELP_FAB.bottom, zIndex: 999 },
  fab: { width: HELP_FAB.size, height: HELP_FAB.size },
  fabGrad: { width: HELP_FAB.size, height: HELP_FAB.size, borderRadius: HELP_FAB.size / 2, alignItems: 'center', justifyContent: 'center', shadowColor: '#2563EB', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 12, elevation: 8 },
  fabRing: { position: 'absolute', left: 0, top: 0, width: HELP_FAB.size, height: HELP_FAB.size, borderRadius: HELP_FAB.size / 2, borderWidth: 2.5, borderColor: '#06B6D4' },
  fabBadge: { position: 'absolute', top: -2, right: -2, width: 20, height: 20, borderRadius: 10, backgroundColor: '#0B1120', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  hint: {
    position: 'absolute', right: HELP_FAB.right + HELP_FAB.size + 10, bottom: HELP_FAB.bottom + 12,
    maxWidth: SW * 0.6, backgroundColor: '#0B1120', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, zIndex: 999,
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.28, shadowRadius: 14, elevation: 10,
  },
  hintText: { color: '#fff', fontSize: 12.5, fontWeight: '700', lineHeight: 17 },

  // ── Coach popup — a translucent thought-cloud (uneven corners + puffs toward the button) so it
  //    reads as the button "thinking", on both the navy and the light screens ──
  coach: { position: 'absolute', bottom: HELP_FAB.bottom + HELP_FAB.size - 4, width: Math.min(SW * 0.8, 320), zIndex: 999, paddingBottom: 30 },
  coachRight: { right: HELP_FAB.right },
  coachLeft: { right: undefined, left: HELP_FAB.right },
  cloud: {
    backgroundColor: 'rgba(13,20,40,0.72)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.24)',
    paddingHorizontal: 15, paddingTop: 11, paddingBottom: 13,
    // Uneven on purpose — even radii read as a card, these read as a cloud.
    borderTopLeftRadius: 32, borderTopRightRadius: 22, borderBottomLeftRadius: 26, borderBottomRightRadius: 28,
    shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.32, shadowRadius: 22, elevation: 12,
  },
  // the corner nearest the button tucks in, pointing the cloud at it
  cloudTailRight: { borderBottomRightRadius: 8 },
  cloudTailLeft: { borderBottomLeftRadius: 8 },
  puff: { position: 'absolute', backgroundColor: 'rgba(13,20,40,0.62)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)' },
  puffBig: { width: 16, height: 16, borderRadius: 8, bottom: 12 },
  puffSmall: { width: 9, height: 9, borderRadius: 5, bottom: 1 },
  coachHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 7 },
  coachIcon: { width: 22, height: 22, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  coachTitle: { flex: 1, fontSize: 11, fontWeight: '800', color: 'rgba(255,255,255,0.72)', letterSpacing: 0.7, textTransform: 'uppercase' },
  coachMsg: { fontSize: 13.5, color: '#FFFFFF', lineHeight: 20, fontWeight: '600' },
  coachCaret: { color: '#67E8F9', fontWeight: '400' },
  // A slim pill, not a full-width bar — the message is the point, the button just says where to tap.
  coachCta: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', gap: 5, marginTop: 10,
    paddingHorizontal: 12, height: 30, borderRadius: 15,
    backgroundColor: 'rgba(103,232,249,0.14)', borderWidth: 1, borderColor: 'rgba(103,232,249,0.4)',
  },
  coachCtaText: { fontSize: 12, fontWeight: '800', color: '#67E8F9' },
  // idle "Tap me" — the same cloud, minified
  idleWrap: { position: 'absolute', bottom: HELP_FAB.bottom + HELP_FAB.size - 4, maxWidth: SW * 0.6, zIndex: 999, paddingBottom: 26 },
  idleCloud: { paddingHorizontal: 14, paddingTop: 9, paddingBottom: 10 },
  idleText: { fontSize: 12.5, fontWeight: '800', color: '#FFFFFF', letterSpacing: 0.2 },

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

  answerIntro: { fontSize: 12.5, color: '#5B6B8A', lineHeight: 18, marginBottom: 14, marginLeft: 2 },
  answerTitle: { fontSize: 16.5, fontWeight: '800', color: '#0B0F22', marginBottom: 8, marginLeft: 2, letterSpacing: -0.2 },
  watchBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 42,
    borderRadius: 13, backgroundColor: '#2563EB', marginBottom: 12,
  },
  watchText: { fontSize: 13.5, fontWeight: '800', color: '#fff' },
  tutorialStage: { marginHorizontal: -16, paddingTop: 4, alignItems: 'center' },

  // One card per step. The shot is inset under the text (not full-bleed) so the instruction stays the
  // thing you read first; it is the FULL screen so nothing looks sliced off.
  stepCard: { backgroundColor: '#fff', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(11,15,34,0.06)', padding: 13, marginBottom: 10 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  stepNum: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#0B1120', alignItems: 'center', justifyContent: 'center' },
  stepNumText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  stepIcon: { width: 22, height: 22, borderRadius: 7, backgroundColor: 'rgba(59,130,246,0.10)', alignItems: 'center', justifyContent: 'center' },
  stepText: { flex: 1, fontSize: 13.5, color: '#334155', lineHeight: 20 },
  shotWrap: {
    width: SHOT_W, height: Math.round(SHOT_W / SHOT_RATIO), marginTop: 11, alignSelf: 'center',
    borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(11,15,34,0.08)', backgroundColor: '#F1F5F9',
  },
  stepShot: { width: '100%', height: '100%' },
  shotZoom: { position: 'absolute', right: 6, bottom: 6, width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(11,17,32,0.62)', alignItems: 'center', justifyContent: 'center' },

  zoomLayer: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(6,10,25,0.86)', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 20 },
  zoomCard: { width: '100%', maxWidth: 520, backgroundColor: '#fff', borderRadius: 20, padding: 14 },
  zoomHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, marginBottom: 12 },
  zoomText: { flex: 1, fontSize: 13.5, color: '#334155', lineHeight: 20, fontWeight: '600' },
  // Portrait full-screen shot — height-capped so card + caption + button always fit on screen.
  zoomImg: { alignSelf: 'center', height: Math.min(SH * 0.56, 620), aspectRatio: SHOT_RATIO, maxWidth: '100%', borderRadius: 12, backgroundColor: '#F1F5F9' },
  zoomClose: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 44, marginTop: 12, borderRadius: 13, backgroundColor: '#0B1120' },
  zoomCloseText: { color: '#fff', fontSize: 14, fontWeight: '800' },

  askBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 10 },
  askInput: { flex: 1, backgroundColor: '#fff', borderRadius: 22, borderWidth: 1, borderColor: 'rgba(11,15,34,0.08)', paddingHorizontal: 16, height: 44, fontSize: 14, color: '#0B0F22' },
  askSend: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center' },
});
