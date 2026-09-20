// AI Hub — new feature. Safe to delete without affecting existing app.
//
// MAKE YOURS — the four steps between "I just installed this" and "here is my resume".
//
// The app's own retention data says people install and never activate: most accounts never upload a
// résumé at all. Everything they need already had an endpoint and a screen somewhere — they were
// just scattered across Account Settings, the profile editor and the builder, so nobody walked the
// whole path. This is that path, once, in order, with the resume built at the end of it.
//
// ⚠️ EVERY STEP FITS ON ONE SCREEN. That is a hard constraint, not a preference: a wizard step you
// have to scroll hides its own Next button, and the first version shipped five separate boxed
// fields plus their labels — 86pt each — which ran off the bottom of every phone. The details are
// now ONE inset card of 54pt rows with the value on the right, which is half the height and reads
// as a single object rather than five. Photo and signature became one step for the same reason:
// each was a single control with a whole screen to itself.
//
// ⚠️ IT DOES NOT INVENT A DEFINITION OF "COMPLETE". Two already exist and they disagree — the API
// says phone + address + date of birth, the activation journey says those three PLUS all three
// files on disk. A third would be how a green tick appears over a profile the generator then
// refuses, so the server's own `setup` object decides, and it also decides which step to open on.
//
// ⚠️ CITY AND COUNTRY ARE COLLECTED, AND THEY ARE STORED IN `address`. No endpoint in this codebase
// writes users.city or users.nationality — /api/update-user-details looks like it accepts them and
// silently drops them — so the two fields are ASKED separately, because that is how a person knows
// what to type, and JOINED into the one column that is really written. Re-opening splits them back
// apart on the last comma. Nothing is sent to a column that does not exist.
//
// ⚠️ THE DIAL CODE IS PART OF THE PHONE STRING, because `phone_number` is a single free-text column
// and a resume prints a phone number, not a pair of fields. Picking a country fills the code in
// when the user has not already chosen one — following the country is help; overriding a code they
// picked themselves would be a bug.
//
// ⚠️ IT RESUMES. Someone who quits at the signature comes back to the signature, because `setup`
// already reports each piece separately. Restarting them at their own name would be a small insult.
//
// ⚠️ …AND IT RESUMES FROM THE SERVER, NOT FROM THIS SCREEN (2026-09-19). The owner's fresh account drew a
// signature, uploaded a photo and a CV, tapped Build — and was sent back to the signature, asked for the CV
// again, charged twice for two EMPTY résumés, and after a restart had no "Pick up where you left off" at all.
// Every piece of that lived here: a drawn-but-unconfirmed signature died with "Next", and the chosen lane, the
// typed notes and the uploaded CV were screen state. (The second charge was NOT a running build forgotten on
// reopen — production shows build #1 had already completed, empty, in 1.6 s; the reopened wizard simply offered
// Build again. See onboardingProgress.joinRunningWizardBuild.) Now `setup.wizard` (server/services/
// onboardingProgress.js) opens the wizard on the FIRST unfinished step with everything saved shown as done:
// every way off the signature step but Skip commits a pending signature and waits for it (Next, the back arrow,
// the dots, and — through usePreventRemove — the close button, the iOS swipe and the Android back button); only
// Next counts the untapped hand the gallery shows ticked, and only while no signature is saved, and "Skip for now"
// uploads NOTHING (2026-09-20); a skip is stored (and sent again until the server has it); leaving the step goes on to
// where the server's wizard now is (finished, with a résumé with content already on file); valid details are saved on
// the way out; the CV is shown with whether the server has READ it (Next
// waits for that — a build from an unread CV is a build from nothing); notes are saved as they are typed; and a
// build still running is rejoined, never started again. Only a build that was charged and saved (or a résumé
// with content that already exists) finishes the wizard.
//
// ⚠️ ONE ANIMATED DRIVER, NATIVE, IN THE WHOLE TREE (the b126-128 fatal crash). The step slide is
// transform + opacity. The progress bar is therefore scaleX with a translateX compensation rather
// than an animated `width` — animating width forces the JS driver, and a JS-driven value in the
// same tree as this native slide is exactly the crash. Nothing here animates width, height, margin
// or colour.
//
// ⚠️ THE LAST STEP SPENDS MONEY. Generating is a metered AI call that can answer 402 or 403, so it
// is behind an explicit tap and never fires on step entry — the letters auto-regeneration incident
// is the precedent for why.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, Animated, Easing,
  ActivityIndicator, Platform, KeyboardAvoidingView, Alert, Image, Modal, Pressable, AppState,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
// usePreventRemove is the one guard that also reaches the NATIVE dismiss — the precedent is app/(cover-letter)/edit.tsx.
import { usePreventRemove, type NavigationAction } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { E, SERIF, sweepWords } from '../../components/employer-home/theme';
// The one warm accent on a blue screen, shared with Home's "Make your Resume" so the button that
// brought them here and the button that moves them forward are visibly the same thing.
const MINT: [string, string, string] = ['#8FF7E4', '#2DE0C0', '#12BFA6'];
const MINT_INK = '#04211C';
import MeshStage from '../../components/employer-home/MeshStage';
import SignatureStudio, { SignatureStudioHandle, SigCommit } from '../../components/onboarding/SignatureStudio';
import CountrySheet from '../../components/onboarding/CountrySheet';
import { COUNTRIES, Country, countryByName } from '../../constants/countries';
import {
  fetchProfileSnapshot, saveDetails, uploadPhoto, uploadSignature, uploadResumeFile,
  generateResume, joinBuild, buildOnServer, newWizardBuildId, saveOnboarding, waitForResumeParse, markProfileChanged, handOverSetup,
  wizardBuildText, checkBuildCovered, RESUME_PICKER_TYPES, RESUME_FORMATS_LINE,
  BuildOutcome, GenStage, ProfileSnapshot, WizardCv,
} from '../../services/profileSetupService';
import { subscribeEntitlements } from '../../services/subscriptionService';
import { track } from '../../services/analytics';

type StepKey = 'you' | 'sign' | 'experience' | 'build';
const STEPS: Array<{ key: StepKey; title: string; short: string }> = [
  { key: 'you', title: 'About you', short: 'You' },
  { key: 'sign', title: 'Photo & signature', short: 'Photo' },
  { key: 'experience', title: 'Your experience', short: 'Work' },
  { key: 'build', title: 'Building it', short: 'Build' },
];
const LAST = STEPS.length - 1;

/** The server enum, exactly. Anything else is a 400. */
const GENDERS = ['Male', 'Female', 'Prefer Not to Say'];

/** "Pune, India" → the two halves, when the tail is a country we know. */
function splitAddress(addr: string): { city: string; country: Country | null } {
  const raw = (addr || '').trim();
  if (!raw) return { city: '', country: null };
  const i = raw.lastIndexOf(',');
  if (i > 0) {
    const c = countryByName(raw.slice(i + 1));
    if (c) return { city: raw.slice(0, i).trim(), country: c };
  }
  const whole = countryByName(raw);
  if (whole) return { city: '', country: whole };
  return { city: raw, country: null };
}

/** The longest dial code this number starts with, so +91 does not win over +9 by accident. */
function splitPhone(phone: string): { dial: string; rest: string } {
  const raw = (phone || '').trim();
  if (!raw.startsWith('+')) return { dial: '', rest: raw };
  const digits = raw.slice(1).replace(/\D/g, '');
  let best = '';
  for (const c of COUNTRIES) {
    const d = c.dial.slice(1);
    if (digits.startsWith(d) && d.length > best.length) best = d;
  }
  if (!best) return { dial: '', rest: raw };
  return { dial: `+${best}`, rest: raw.slice(1).replace(/\D/g, '').slice(best.length) };
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const pretty = (s: string) => {
  if (!ISO_RE.test(s)) return '';
  const [y, m, d] = s.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
/** " · 19 Sep" for when the CV on file was uploaded, or '' when the server did not say. */
const cvDate = (at: string | null) => {
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : ` · ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

/**
 * What leaving the photo & signature step stores as SKIPPED: whatever it still lacks — "Both optional" is what the step
 * promises, and a skip the server does not know about is a step that reopens on every launch. `have`: what is saved
 * (this session's uploads or the server's); `signedNow`: a signature was committed on the way out (its image is not in
 * state yet). null: nothing to store. Pure, so the suite runs it.
 */
type SignStepHas = { photo: boolean; signature: boolean };
function skipsOnLeave(have: SignStepHas, signedNow: boolean): Partial<SignStepHas> | null {
  const photo = !have.photo;
  const signature = !have.signature && !signedNow;
  if (!photo && !signature) return null;
  return { ...(photo ? { photo: true } : {}), ...(signature ? { signature: true } : {}) };
}

/** A progress write, as saveOnboarding takes it. */
type ProgressPatch = Parameters<typeof saveOnboarding>[0];
/** How long a skip the server has not confirmed waits before it is sent again (then it rides on the next write). */
const SKIP_RETRY_MS = [2000, 6000, 15000];

export default function MakeYours() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // ⚠️ DEV ONLY, AND IT MUST STAY THAT WAY. Three of the four steps are unreachable in the preview
  // harness without a signed-in session, and a screen nobody can look at is a screen nobody checks.
  // __DEV__ is compiled out of a release bundle, so this cannot skip a step for a real user.
  const params = useLocalSearchParams<{ step?: string }>();
  const devStep = __DEV__ && params.step != null ? Math.max(0, Math.min(3, Number(params.step) || 0)) : null;

  const [step, setStep] = useState(0);
  const [snap, setSnap] = useState<ProfileSnapshot | null>(null);
  const [booting, setBooting] = useState(true);
  const [saving, setSaving] = useState(false);

  // step 1 — the details
  const [fullName, setFullName] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState<Country | null>(null);
  const [dial, setDial] = useState('');
  const [phone, setPhone] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState('');
  const [focus, setFocus] = useState('');
  const [sheet, setSheet] = useState<'dial' | 'country' | null>(null);
  const [dobOpen, setDobOpen] = useState(false);
  const [dobDraft, setDobDraft] = useState<Date>(new Date(1995, 0, 1));
  // Set the moment they open the code picker themselves — after that, choosing a country must not
  // quietly rewrite the code they chose.
  const dialPinned = useRef(false);

  // step 2 — photo + signature
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [signUri, setSignUri] = useState<string | null>(null);
  // What was skipped — stored on the server, so "Skip for now" is still skipped after a restart.
  const [skipped, setSkipped] = useState({ photo: false, signature: false });
  // A saved signature is SHOWN (the image), and the studio opens only to replace it.
  const [redoSign, setRedoSign] = useState(false);
  const studio = useRef<SignatureStudioHandle>(null);
  // The pad holds ink nobody saved (SignatureStudio's onDirty) — what the leave guard commits before the screen goes.
  const [sigDirty, setSigDirty] = useState(false);
  // The leave guard shows its own "Leave without it?" when its commit fails, so saveSignature stays quiet then.
  const quietSignAlert = useRef(false);
  // Next / the back arrow / a dot is committing the pad (commitSign): one at a time, and the footer shows it is working.
  const [sigBusy, setSigBusy] = useState(false);
  const committing = useRef(false);
  // A skip the server has not confirmed yet (flushSkips): sent again until one write carrying it lands.
  const pendingSkips = useRef<Partial<SignStepHas> | null>(null);
  const flushingSkips = useRef(false);

  // step 3 — experience
  const [lane, setLane] = useState<'write' | 'upload'>('write');
  const [rawText, setRawText] = useState('');
  const [file, setFile] = useState<{ uri: string; name: string; mime: string } | null>(null);
  // The CV the SERVER holds and whether it has been read — what Next on this step waits for.
  const [cv, setCv] = useState<WizardCv | null>(null);
  const cvSeq = useRef(0);
  // ⚠️ AN OLDER SERVER (review, 2026-09-19): one that answers the profile WITHOUT setup.wizard — before Migration 047,
  // a rollback, another environment in the switcher — never says whether a CV was read, so "wait until it is read"
  // would be a dead end (Next disabled forever, even with a CV already on file). There the old rule stands: a CV
  // uploaded now, or one already on file, is enough to go on.
  const legacy = !!snap && !snap.setup.wizard;

  // step 4 — the build
  const [stage, setStage] = useState<GenStage | null>(null);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // How the last build ended when it did not end well — it decides the step's buttons (Try again / Keep waiting / Plans).
  const [outcome, setOutcome] = useState<BuildOutcome | null>(null);
  // What a re-check of the plan found when it did NOT clear the refusal (see retryAfterPlans). Declared with the
  // build's own state because build() clears it; nothing is said until someone has actually asked.
  const [recheckNote, setRecheckNote] = useState<string | null>(null);
  // A wizard build the server says is still running: rejoined on the build step, never started again.
  const [joinJob, setJoinJob] = useState<string | null>(null);
  // A résumé with content already exists: building again spends a generation, so it is asked first.
  const [builtResume, setBuiltResume] = useState(false);
  // One clientBuildId per tap on Build; `reuse` only after a POST that got no answer (see generateResume).
  const buildId = useRef<{ id: string; reuse: boolean } | null>(null);
  // The furthest step the dots may jump to: everything up to the first unfinished one is done and can be revisited.
  const [reach, setReach] = useState(0);
  // The screen is gone: polls stop (the server keeps building; reopening rejoins).
  const gone = useRef(false);
  useEffect(() => () => { gone.current = true; }, []);

  const slide = useRef(new Animated.Value(0)).current;   // 0 → settled; 1 → arriving
  const [barW, setBarW] = useState(0);
  const bar = useRef(new Animated.Value(0)).current;      // 0..1

  /* ── boot: read the truth, and open on the first unfinished thing ─────────────────────────── */
  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await fetchProfileSnapshot();
      if (!alive) return;
      if (s) {
        setSnap(s);
        setFullName(s.fullName || '');
        const a = splitAddress(s.address || '');
        setCity(a.city);
        setCountry(a.country);
        const p = splitPhone(s.phone || '');
        if (p.dial) { setDial(p.dial); dialPinned.current = true; }
        else if (a.country) setDial(a.country.dial);
        setPhone(p.rest);
        setDob(ISO_RE.test(s.dateOfBirth || '') ? s.dateOfBirth : '');
        if (ISO_RE.test(s.dateOfBirth || '')) {
          const [y, m, d] = s.dateOfBirth.split('-').map(Number);
          setDobDraft(new Date(y, m - 1, d));
        }
        setGender(GENDERS.includes(s.gender) ? s.gender : '');
        const w = s.setup.wizard || null;
        let first: number;
        if (w) {
          // ⚠️ THE SERVER SAYS WHERE TO OPEN, and everything it already holds is filled in: the skips, the notes, the
          // lane, the CV and whether it has been read. A build still running is rejoined on the build step.
          setSkipped(w.skipped);
          setRawText(w.notes || '');
          setCv(w.cv);
          // The lane they chose — unless it is "type it out" with too little typed while a CV is on file: the CV is
          // what makes that step done, so that is the lane to open on (and to build from).
          const thinNotes = (w.notes || '').trim().length < 40;
          setLane(w.lane === 'write' && thinNotes && w.cv ? 'upload' : (w.lane || (w.cv ? 'upload' : 'write')));
          setBuiltResume(!!w.builtResume);
          const running = w.build && w.build.status === 'running' ? w.build.jobId : null;
          if (running) setJoinJob(running);
          // Finished, or nothing left by the wizard's own rules (a résumé with content already exists and the rest is
          // there — no progress row yet): "Your resume is ready", never a Build button that would spend a generation.
          const ready = w.state === 'finished' || (Array.isArray(w.left) && !w.left.length);
          if (ready) setDone(true);
          first = running || ready ? LAST : w.step;
        } else {
          // An older server (no `wizard`): its four booleans, and never past a missing piece.
          if (s.resume) setLane('upload');
          first = !s.setup.profile ? 0 : (!s.setup.photo || !s.setup.signature) ? 1 : 2;
        }
        setReach(first);
        setStep(devStep ?? first);
      } else if (devStep != null) {
        setStep(devStep);
      }
      setBooting(false);
      track('onboarding_open', {
        resumedAt: s ? String(s.setup.complete) : 'unknown',
        wizard: (s && s.setup.wizard && s.setup.wizard.state) || 'none',
        step: s && s.setup.wizard ? s.setup.wizard.stepKey : 'legacy',
      });
    })();
    return () => { alive = false; };
  }, [devStep]);

  /* ── motion ──────────────────────────────────────────────────────────────────────────────── */
  const goTo = useCallback((next: number) => {
    if (next === step) return;
    try { Haptics.selectionAsync(); } catch {}
    const forward = next > step;
    // Leave, swap, arrive — one value, transform and opacity only, native driver throughout.
    Animated.timing(slide, {
      toValue: forward ? -1 : 1, duration: 150, easing: Easing.in(Easing.quad), useNativeDriver: true,
    }).start(() => {
      setStep(next);
      setReach((r) => Math.max(r, next));
      slide.setValue(forward ? 1 : -1);
      Animated.timing(slide, {
        toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true,
      }).start();
    });
  }, [slide, step]);

  useEffect(() => {
    Animated.timing(bar, {
      toValue: (step + 1) / STEPS.length,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [bar, step]);

  /* ── steps ───────────────────────────────────────────────────────────────────────────────── */
  const address = useMemo(
    () => [city.trim(), country?.name].filter(Boolean).join(', '),
    [city, country],
  );

  const youFields = useMemo(() => ({
    fullName,
    // One column, one string — the code is part of the number a resume prints.
    phone: [dial, phone.trim()].filter(Boolean).join(' '),
    address,
    dateOfBirth: dob,
    gender,
  }), [fullName, dial, phone, address, dob, gender]);
  const youKey = JSON.stringify(youFields);
  // The details as last saved — or as the server gave them on open. The leave guard saves valid ones that differ.
  const [savedYou, setSavedYou] = useState<string | null>(null);
  useEffect(() => { if (!booting && savedYou === null) setSavedYou(youKey); }, [booting, savedYou, youKey]);

  /** `quiet`: the leave guard's save — leaving is their choice, and a failed save must not trap them on the screen. */
  const saveYou = useCallback(async (quiet = false) => {
    setSaving(true);
    const r = await saveDetails(youFields);
    setSaving(false);
    if (!r.ok) { if (!quiet) Alert.alert('Could not save', r.message || 'Please try again.'); return false; }
    setSavedYou(JSON.stringify(youFields));
    return true;
  }, [youFields]);

  const pickPhoto = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { Alert.alert('Photos', 'Allow photo access to choose a picture.'); return; }
      const r = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true, aspect: [1, 1], quality: 0.85,
      });
      if (r.canceled || !r.assets?.length) return;
      const uri = r.assets[0].uri;
      setPhotoUri(uri);
      setSaving(true);
      const up = await uploadPhoto(uri);
      setSaving(false);
      if (!up.ok) { setPhotoUri(null); Alert.alert('Could not upload', up.message || 'Please try again.'); }
    } catch (e: any) {
      setSaving(false);
      Alert.alert('Could not open your photos', e?.message || 'Please try again.');
    }
  }, []);

  // ⚠️ NO AUTO-ADVANCE. Photo and signature share this step, so jumping to the next one the moment
  // the signature uploads would walk away from a photo they had not chosen yet.
  // Resolves false when the upload failed — SignatureStudio then keeps the ink as UNSAVED, and Next stays put.
  // ⚠️ signUri is set only AFTER the upload landed (review, 2026-09-19). Set before it, a FIRST signature made hasSign
  // true mid-upload, the render swapped the studio for the saved image, and a failed upload then mounted a fresh,
  // blank pad — the ink this comment promises to keep was gone.
  const saveSignature = useCallback(async (uri: string): Promise<boolean> => {
    setSaving(true);
    const up = await uploadSignature(uri);
    setSaving(false);
    if (!up.ok) { if (!quietSignAlert.current) Alert.alert('Could not upload', up.message || 'Please try again.'); return false; }
    setSignUri(uri);
    setRedoSign(false);
    try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    return true;
  }, []);

  /**
   * ⚠️ A SKIP IS STORED UNTIL THE SERVER HAS IT (review, 2026-09-20). It used to be one fire-and-forget POST: offline or
   * on a 5xx the skip was lost (no later write carried it), and the next launch reopened the very step they had skipped,
   * with Home saying "Pick up where you left off · a photo, your signature". Now it waits in `pendingSkips`, is sent
   * again with backoff while the screen is open, and rides on every other progress write (saveProgress) until one lands.
   * ⚠️ Never after the screen is gone: the token is whoever is signed in THEN, and a retry must not write one account's
   * skip onto the next account to sign in.
   */
  const flushSkips = useCallback(async () => {
    if (flushingSkips.current) return;
    flushingSkips.current = true;
    try {
      for (let tries = 0; pendingSkips.current && !gone.current; tries++) {
        const sk = pendingSkips.current;
        const r = await saveOnboarding({ skipped: sk });
        if (r.ok) { if (pendingSkips.current === sk) pendingSkips.current = null; continue; }
        if (tries >= SKIP_RETRY_MS.length || gone.current) return;
        await new Promise((res) => setTimeout(res, SKIP_RETRY_MS[tries]));
      }
    } finally {
      flushingSkips.current = false;
    }
  }, []);
  /** Every other progress write (notes, lane) — carrying a skip the server has not confirmed yet, if there is one. */
  const saveProgress = useCallback((patch: ProgressPatch) => {
    const sk = pendingSkips.current;
    const sent = saveOnboarding(sk ? { ...patch, skipped: { ...sk, ...(patch.skipped || {}) } } : patch);
    if (sk) sent.then((r) => { if (r.ok && pendingSkips.current === sk) pendingSkips.current = null; });
    return sent;
  }, []);

  /** Whatever the photo & signature step still lacks is stored as SKIPPED (skipsOnLeave). `signedNow`: see there. */
  const noteSkips = useCallback((signedNow: boolean) => {
    const sk = skipsOnLeave({ photo: !!(photoUri || snap?.profileImage), signature: !!(signUri || snap?.signature) }, signedNow);
    if (!sk) return;
    setSkipped((cur) => ({ photo: cur.photo || !!sk.photo, signature: cur.signature || !!sk.signature }));
    pendingSkips.current = { ...(pendingSkips.current || {}), ...sk };
    flushSkips();
  }, [photoUri, signUri, snap, flushSkips]);

  /**
   * On from the photo & signature step (Next or Skip) — to where the SERVER's wizard now is (review, 2026-09-20).
   * Leaving it makes the step done there (what it lacks is stored as skipped), and with a résumé with content already on
   * file the server counts the experience AND the build as done (onboardingProgress.wizardStateOf, builtResume) — so the
   * wizard is FINISHED. Walking on to "Your experience" asked for notes or a CV again and then offered "Rebuild — uses
   * 1 resume" on a wizard the server (and Home) already called done: it is "Your resume is ready" instead, exactly as
   * a reopen would show. Otherwise the experience step, as before.
   */
  const onFromSign = useCallback(() => {
    if (builtResume) { setDone(true); goTo(LAST); return; }
    goTo(2);
  }, [builtResume, goTo]);

  /**
   * Commit the pad for Next / the back arrow / a dot: one at a time (null: one is already going), with the footer busy
   * meanwhile — the export and the upload can take seconds, and Next used to look dead through them.
   */
  const commitSign = useCallback(async (handOnScreen: boolean): Promise<SigCommit | null> => {
    if (!studio.current) return 'clean';
    if (committing.current) return null;
    committing.current = true;
    setSigBusy(true);
    try {
      return await studio.current.commit({ handOnScreen });
    } finally {
      committing.current = false;
      setSigBusy(false);
    }
  }, []);

  /**
   * The pad could not hand the signature over ('stuck': it stopped answering, its page died, the image could not be
   * written). ⚠️ NOTHING ELSE SAYS SO (review, 2026-09-20) — saveSignature's alert is for a failed UPLOAD, and none was
   * tried — so Next and the back arrow used to simply stop, silently, on a pad that now looked blank. The studio has
   * already reloaded a dead page; they try again, or go on without it.
   */
  const padStuck = useCallback((goOn: () => void) => {
    Alert.alert(
      'Your signature is not saved',
      'The signature pad stopped working, so it was not saved. Try again, or go on without it — you can add it later.',
      [{ text: 'Try again', style: 'cancel' }, { text: 'Continue without it', onPress: goOn }],
    );
  }, []);

  /**
   * "Skip for now". ⚠️ A SKIP IS A SKIP (review round 4, 2026-09-20): it used to BE leaveSign, whose commit uploaded the
   * hand the gallery opens with ticked — so Skip saved a cursive signature the user had just turned down (skipped stayed
   * false, and every letter and letterhead was signed with it); and offline that upload failed, leaveSign returned early,
   * and Skip did nothing at all. It commits NOTHING — no upload, so nothing can fail: what is missing is stored as
   * skipped (flushSkips keeps it until the server has it) and the step is left, always. A signature already saved is
   * never touched by it.
   */
  const skipSign = useCallback(() => {
    noteSkips(false);
    onFromSign();
  }, [noteSkips, onFromSign]);

  /**
   * Leave the photo & signature step by Next:
   * ⚠️ 1. A SIGNATURE ON THE PAD THAT NOBODY SAVED IS SAVED FIRST, and the step waits for the upload (the owner's
   *    signature died exactly here, 2026-09-19). A failed upload keeps them on the step; a stuck pad says so.
   * ⚠️ 2. Next also saves the untapped hand the gallery shows ticked (handOnScreen) — "Next" on it is choosing it — but
   *    ONLY WHEN NO SIGNATURE IS SAVED (review, 2026-09-20). That rule exists because without it the wizard stored a
   *    skip and letters went out unsigned; with a signature on file nothing is skipped, and counting the hand made
   *    "Sign again" → a look at "Pick a hand" → Next upload hand #1 over their own drawn signature. There, only what
   *    they drew or tapped replaces it.
   * 3. Whatever is still missing is stored as SKIPPED (noteSkips), and the wizard goes on to the server's next step.
   */
  const leaveSign = useCallback(async () => {
    const c = await commitSign(!(signUri || snap?.signature));
    if (c === null || c === 'failed') return;
    if (c === 'stuck') { padStuck(skipSign); return; }
    noteSkips(c === 'saved');
    onFromSign();
  }, [commitSign, signUri, snap, padStuck, skipSign, noteSkips, onFromSign]);

  /**
   * Follow the CV the server holds until it has been READ. Every upload (and a reopen that finds one still being
   * read) starts a new follow; an older one stops as soon as it is superseded or the screen is gone.
   */
  const followCv = useCallback(async () => {
    const seq = ++cvSeq.current;
    const stale = () => gone.current || seq !== cvSeq.current;
    const last = await waitForResumeParse((c) => { if (!stale()) setCv(c); }, stale);
    if (!stale() && last && last.status === 'done') {
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    }
  }, []);
  // Reopened with a CV still being read, or one never read at all (an old upload): follow it — asking the server to
  // read the unread one first. A read is free; nothing here spends a generation.
  const cvBoot = useRef(false);
  useEffect(() => {
    if (booting || cvBoot.current) return;
    cvBoot.current = true;          // the CV the server gave us on open, once — an upload starts its own follow
    if (!cv) return;
    if (cv.status === 'unread') { saveOnboarding({ readCv: true }).then(() => followCv()); return; }
    if (cv.status === 'pending' || cv.status === 'slow') followCv();
  }, [booting, cv, followCv]);

  const pickFile = useCallback(async () => {
    try {
      // ⚠️ EVERY FORMAT THE SERVER CAN READ, AND NOT ONE MORE (2026-09-19). "PDF only" was the owner's complaint;
      // the server now reads Word, OpenDocument, RTF and plain text too (services/resumeText.js) and refuses the rest
      // with a sentence saying which formats work — so a refusal is shown, and the CV already on file stays.
      const r = await DocumentPicker.getDocumentAsync({ type: RESUME_PICKER_TYPES, copyToCacheDirectory: true });
      if (r.canceled || !r.assets?.length) return;
      const a = r.assets[0];
      const name = a.name || 'resume.pdf';
      setSaving(true);
      const up = await uploadResumeFile(a.uri, name, a.mimeType || '');
      setSaving(false);
      if (!up.ok) { Alert.alert('We could not use that file', up.message || 'Please try again.'); return; }
      setFile({ uri: a.uri, name, mime: a.mimeType || '' });
      setLane('upload');
      saveProgress({ lane: 'upload' });
      // An older server cannot say whether a CV was read (see `legacy`): the upload itself is what Next waits for there.
      if (legacy) return;
      // The server marked it 'pending' before it answered: show that, then follow the read.
      setCv({ ext: up.format || (name.split('.').pop() || '').toUpperCase() || null, uploadedAt: new Date().toISOString(), status: 'pending', error: null });
      followCv();
    } catch (e: any) {
      setSaving(false);
      Alert.alert('Could not open that file', e?.message || 'Please try again.');
    }
  }, [followCv, legacy, saveProgress]);

  // ⚠️ TYPED NOTES ARE SAVED AS THEY ARE TYPED (debounced). They used to exist only in this screen and in the one
  // generate-ai request, so leaving before Build lost them. (saveProgress: a skip not yet confirmed rides along.)
  const notesBoot = useRef(true);
  useEffect(() => {
    if (booting) return;
    if (notesBoot.current) { notesBoot.current = false; return; }    // the value the server just gave us
    const t = setTimeout(() => { saveProgress({ notes: rawText, lane }); }, 900);
    return () => clearTimeout(t);
  }, [rawText, lane, booting, saveProgress]);

  /** The build step's end states, one place: the done screen, or the outcome's own buttons. */
  const settle = useCallback((r: BuildOutcome) => {
    if (gone.current) return;
    if (r.kind === 'done') {
      buildId.current = null;
      setJoinJob(null);
      setOutcome(null);
      setStage({ stage: 'done', label: 'Ready', pct: 100 });
      setDone(true);
      // Home re-reads setup on focus anyway; this also makes it reload the pages — they are of this résumé now.
      // ⚠️ THE FLAG FIRST, SYNCHRONOUSLY: "See my designs" can be tapped the very next moment, and a focus that
      // finds no flag leaves Home's 60 s throttle in charge — the old (sample) pages would stay on screen.
      markProfileChanged();
      // ⚠️ …AND THEN THE SERVER'S OWN ANSWER (2026-09-20). It does two things, both of which the owner needed and
      // neither of which the flag alone could do: it hands Home the finished `setup` so the first frame after
      // "See my designs" no longer says "Pick up where you left off", and — through fetchProfileSnapshot's own
      // write — it corrects the CACHED setup, which is what a REMOUNTED Home (the Dashboard toggle, HomeBoundary)
      // paints from and which still said the wizard was open. It runs while the ready screen is up, so it costs
      // the user nothing, and a failed read simply leaves today's behaviour (Home's own read) in place.
      // (Not guarded by `gone`: the screen closing is exactly the case this is for, and handOverSetup is a no-op
      // once Home has consumed the flag.)
      fetchProfileSnapshot().then((s) => { if (s) handOverSetup(s.setup); }).catch(() => {});
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
      return;
    }
    setStage(null);
    setOutcome(r);
    if (r.kind === 'late') { setJoinJob(r.jobId); setGenErr('Still building — this one is taking longer than usual. Nothing will be charged twice.'); return; }
    // ⚠️ A BUILD THAT ENDED IS NEVER FOLLOWED AGAIN (review, 2026-09-19). Kept, the rejoin effect re-followed the OLD
    // job the moment they came back to this step from "Add more about your experience" — and showed its refusal again
    // over the notes they had just added. Only "late" (still running: Keep waiting) keeps a job to follow.
    setJoinJob(null);
    // A POST that got no answer may still be running: Try again repeats THIS build. Anything else is a new tap.
    buildId.current = r.kind === 'failed' && r.retrySame && buildId.current ? { id: buildId.current.id, reuse: true } : null;
    if (r.kind === 'refused' && r.reason === 'cv_unreadable') {
      // Nothing to build from: back to the upload, with the server's sentence where the CV is shown.
      setCv((c) => (c ? { ...c, status: 'error', error: r.message } : c));
      setGenErr(null);
      goTo(2);
      return;
    }
    setGenErr(r.message);
  }, [goTo]);

  /** Follow a build the server already has (reopened wizard, Keep waiting). Polling costs nothing. */
  const follow = useCallback(async (jobId: string) => {
    setGenErr(null);
    setOutcome(null);
    setStage({ stage: 'start', label: 'Picking up your build', pct: 5 });
    settle(await joinBuild(jobId, (st) => { if (!gone.current) setStage(st); }, () => gone.current));
  }, [settle]);
  // Reopened while the wizard's build runs: follow THAT job — this never starts (or charges for) a build.
  useEffect(() => {
    if (step === LAST && joinJob && !stage && !done && !outcome) follow(joinJob);
  }, [step, joinJob, stage, done, outcome, follow]);

  /**
   * ⚠️ THE ONE PLACE THAT SPENDS A GENERATION. Explicit tap only.
   * The uploaded file lane sends a short note plus `includeUploadedResume` and `fromUpload`: the server needs at
   * least twenty characters of text, and it WAITS for a CV still being read — and refuses, before any charge, to
   * build "from the upload" when there is no read CV (cv_not_ready / cv_unreadable). It also refuses an empty
   * résumé before the charge (thin_input). One clientBuildId per tap; see settle for when it is reused.
   */
  const build = useCallback(async () => {
    if (stage) return;
    setGenErr(null);
    setOutcome(null);
    setRecheckNote(null);   // whatever the last re-check said about their plan, this build is the newer answer
    setStage({ stage: 'start', label: 'Getting started', pct: 3 });
    const retry = !!(buildId.current && buildId.current.reuse);
    if (retry) {
      // The last POST got no answer: before sending the same id again, ask whether it already landed or is running.
      const there = await buildOnServer();
      if (there && 'done' in there) { settle({ kind: 'done' }); return; }
      if (there && 'jobId' in there) { setJoinJob(there.jobId); follow(there.jobId); return; }
    }
    if (!retry) buildId.current = { id: newWizardBuildId(), reuse: false };
    const id = buildId.current ? buildId.current.id : newWizardBuildId();
    // Typed notes too short to write from, but a READ CV on file: the CV is the content (the server agrees — that is
    // how its experience step came out done).
    const fromCv = lane === 'upload' || (rawText.trim().length < 40 && !!cv && cv.status === 'done');
    track('onboarding_build', { lane: fromCv ? 'upload' : 'write', retry: retry ? 'same' : 'new' });
    // From the CV, the "build it from my CV" sentence always goes — an optional short note alone was refused (see it).
    const text = wizardBuildText(rawText, fromCv, fullName);
    const r = await generateResume(
      {
        name: fullName, email: snap?.email || '', phone: [dial, phone.trim()].filter(Boolean).join(' '),
        location: address, rawText: text, includeUploadedResume: true, fromUpload: fromCv,
      },
      id,
      (st) => { if (!gone.current) setStage(st); },
      () => gone.current,
    );
    settle(r);
  }, [stage, lane, rawText, cv, fullName, dial, phone, address, snap, settle, follow]);

  /** The Build button. ⚠️ A second résumé is a second generation: asked, never assumed. */
  const start = useCallback(() => {
    if (stage) return;
    if (outcome && outcome.kind === 'late') { follow(outcome.jobId); return; }   // Keep waiting: the SAME job
    if (builtResume && !done && !(buildId.current && buildId.current.reuse)) {
      Alert.alert(
        'Build a new resume?',
        'You already have a resume. Building a new one uses 1 resume from your plan.',
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Rebuild — uses 1 resume', onPress: () => { build(); } }],
      );
      return;
    }
    build();
  }, [stage, outcome, builtResume, done, build, follow]);

  /* ── the plan refusal, re-read ───────────────────────────────────────────────────────────── */

  /**
   * ⚠️ A REFUSAL IS ONLY TRUE UNTIL THEY PAY (2026-09-20, the owner on build 210).
   * He tapped Build, was refused with "The free plan on this device was already used by another account…", tapped
   * See plans, got a plan — and came back to the SAME sentence with the SAME "See plans" as its only button, so he
   * left the wizard and started the whole thing again. The server was never wrong (canConsumeMany reads the
   * subscription first, so a plan always beats a claimed device): what was wrong is that this screen kept a
   * server answer in React state and never asked a second time. The plans screen is PUSHED on top of this one, so
   * this screen is alive the whole time and can simply ask again.
   *
   * It asks ONLY while a plan refusal is on screen, never during a build and never once one is done, and the answer
   * comes from the gate the build itself consults — a dry run that reserves, binds and charges nothing. Anything but
   * a clear "covered" leaves the banner exactly as it is: a user who genuinely has no plan must still be told so.
   * The gate is asked as a plain build, which is what this build is: the wizard never sends isRegenerate, so the
   * server's regenerate lane cannot apply to it (a 403 here is simply how generateResume labels any 403).
   * ⚠️ IT CLEARS THE MESSAGE, IT NEVER BUILDS. The tap builds (see the header's "THE LAST STEP SPENDS MONEY").
   */
  const showsPlanRefusal = !stage && !done && !!outcome && outcome.kind === 'refused'
    && (outcome.reason === 'quota_exhausted' || outcome.reason === 'regen_limit');
  // The read that is going, not a boolean: a second caller JOINS it instead of being dropped (see retryAfterPlans —
  // a tap that lands while the focus re-check is still in flight must answer the person who tapped).
  const rechecking = useRef<Promise<boolean | null> | null>(null);
  const [checking, setChecking] = useState(false);
  /** true = covered (the banner is cleared) · false = the server still refuses · null = we could not read it. */
  const recheck = useCallback((): Promise<boolean | null> => {
    if (!showsPlanRefusal) return Promise.resolve(null);
    if (rechecking.current) return rechecking.current;
    const run = async (): Promise<boolean | null> => {
      try {
        const g = await checkBuildCovered();
        if (gone.current || !g) return null;
        if (!g.covered) return false;
        // Back to "Build my resume", with the lane, the notes, the CV and the details all untouched.
        setOutcome(null);
        setGenErr(null);
        setRecheckNote(null);
        return true;
      } finally { rechecking.current = null; }
    };
    const p = run();
    rechecking.current = p;
    return p;
  }, [showsPlanRefusal]);

  // Back from the plans screen — the owner's exact path.
  useFocusEffect(useCallback(() => { recheck(); }, [recheck]));
  // The store's own sheet backgrounds the app, and a grant can land while it is away (his arrived as an ADMIN
  // grant, which no purchase callback in this app can ever see).
  useEffect(() => {
    if (!showsPlanRefusal) return;
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') recheck(); });
    return () => sub.remove();
  }, [showsPlanRefusal, recheck]);
  // A purchase or a Restore the SERVER confirmed while this screen was mounted underneath it.
  useEffect(() => subscribeEntitlements(() => { recheck(); }), [recheck]);

  /**
   * ⚠️ …AND THE REFUSAL IS NOT A DEAD END. "instead of starting the build resume process from start i should be able
   * to do that from here": this re-runs the build he already asked for — same lane, same notes, same CV, same
   * details, nothing re-entered. It is safe to charge because the refusal happened BEFORE any charge (the gate runs
   * before the first AI call), so this is a first charge, not a second; and settle() nulls buildId on a refusal, so
   * it mints a NEW clientBuildId — sending the refused one again would only hand back that failed job for fifteen
   * minutes (server/middleware/asyncJob.js). Still not covered → the banner stands, and the tap says what the
   * re-check found rather than answering with nothing.
   */
  const retryAfterPlans = useCallback(async () => {
    if (stage) return;
    setChecking(true);
    // A re-check already going is JOINED, never dropped: the focus one fires a heartbeat before this tap can land,
    // and returning here would have given the tap no spinner and no answer at all.
    const covered = await recheck();
    if (gone.current) return;
    setChecking(false);
    // ⚠️ start(), not build(): "a second résumé is a second generation" is asked here exactly as it is on the Build
    // button. This tap is not always the second half of one they made — a build rejoined when the wizard reopened
    // (joinJob) can be refused with nobody having tapped Build at all, and that must not become a silent rebuild
    // over the résumé they already have. Whatever it asks, the build itself is unchanged: same lane, same notes,
    // same CV, same details, nothing re-entered.
    if (covered === true) { start(); return; }
    // ⚠️ AND A TAP IS NEVER SILENT (review, 2026-09-20). Everything that is not "covered" used to end here with the
    // screen byte-for-byte as it was — a spinner, then nothing — which reads as a broken button to the one person
    // this action exists for. It adds only what we now know, and never re-diagnoses: the banner above already
    // carries the server's own sentence, and the gate answers 'quota_exhausted' both to someone with no plan AND
    // to someone whose plan's allowance is spent, so "we see no plan" would be a lie to half of them.
    // `false` is the server's answer (a purchase not verified yet, one made on another store account, an allowance
    // used up); `null` is us (offline, an older server, a 500, a read that timed out) — never stated as a refusal.
    setRecheckNote(covered === false
      ? 'We checked again and this build is still not covered. If you have just subscribed, tap See plans and then Restore Purchases.'
      : 'We could not check your plan just then. Please try again in a moment.');
  }, [stage, recheck, start]);

  /* ── gating ──────────────────────────────────────────────────────────────────────────────── */
  const cvRead = !!cv && cv.status === 'done';
  // Only against an older server (see `legacy`): a CV uploaded in this session or one already on file.
  const legacyCv = legacy && (!!file || !!snap?.resume);
  const canAdvance = (() => {
    if (step === 0) {
      return fullName.trim().length > 1 && phone.replace(/\D/g, '').length >= 5
        && city.trim().length >= 2 && !!country;
    }
    // ⚠️ THE UPLOAD LANE WAITS FOR THE CV TO BE READ — not merely for a file to exist. A build from a CV that is
    // still being read was a build from nothing, and it was charged (user 616, twice).
    if (step === 2) return lane === 'write' ? rawText.trim().length >= 40 : legacy ? legacyCv : cvRead;
    return true;
  })();

  /**
   * Leave the step on screen for another by the header's back arrow or a step dot.
   * ⚠️ NOT A SIDE DOOR PAST THE SAVE: a drawn signature is committed on the way out of step 1 (the dots made the owner's
   * lost signature reachable again), and valid details are saved on the way out of step 0.
   * ⚠️ …BUT NOT AS NEXT DOES (2026-09-20): only what they DREW or TAPPED is saved here — commit() without handOnScreen.
   * Going back to fix a name is not choosing the pre-ticked hand #1; with it, the arrow uploaded a signature unasked.
   */
  const leaveTo = useCallback(async (i: number) => {
    if (step === 1) {
      const c = await commitSign(false);
      if (c === null || c === 'failed') return;
      // A stuck pad says so (padStuck); going on without it goes where they asked, nothing invented on the way.
      if (c === 'stuck') { padStuck(() => goTo(i)); return; }
    }
    if (step === 0 && i > 0 && canAdvance && !(await saveYou())) return;
    goTo(i);
  }, [step, commitSign, padStuck, canAdvance, saveYou, goTo]);

  const next = useCallback(async () => {
    if (step === 0 && !(await saveYou())) return;
    if (step === 1) { await leaveSign(); return; }
    if (step === 2) saveProgress({ notes: rawText, lane });
    if (step < LAST) goTo(step + 1);
  }, [step, saveYou, leaveSign, saveProgress, rawText, lane, goTo]);

  const leave = useCallback(() => {
    // ⚠️ THE EXIT MATTERS. App.js owns profileData and refetches it only when its own `screen`
    // flips; a route pushed on top of it does not do that. So the app's older cover-letter gate can
    // still believe the profile is incomplete until Account Settings is next opened. Home itself
    // re-reads `setup` on EVERY focus (and reloads its pages after a build — markProfileChanged).
    if (done) markProfileChanged();
    router.back();
  }, [router, done]);

  /**
   * ⚠️ EVERY WAY OFF THE SCREEN SAVES FIRST (review, 2026-09-19) — the close button, the iOS swipe and the Android back
   * button, which the Next / Skip / back-arrow / dot saves above never saw. The owner's complaint was a drawn signature
   * that was lost, and "left intentionally in between" must find the details they typed still there:
   *   step 1 — a signature on the pad that nobody saved is committed, and the screen waits for the upload; if it fails
   *            they choose: stay and try again, or leave without it. Only what they DREW or TAPPED (commit() without
   *            handOnScreen, and sigDirty means the same): closing on the pre-ticked hand #1 is not choosing it;
   *   step 0 — valid details that differ from what the server holds are saved (quietly: leaving is their choice). That
   *            wizard write is also what creates the progress row, so Home says "Pick up where you left off".
   * ⚠️ usePreventRemove, NOT a raw beforeRemove listener: Home pushes /(onboarding), so the screen swiped away on the
   * ROOT stack is the group; only usePreventRemove reports up so the root native stack refuses the swipe natively and
   * hands it here as a pop (the same reason as app/(cover-letter)/edit.tsx). The action waits in `exit` until a render
   * with the guard down, then goes (the hook reads its condition from the last render).
   */
  const navigation = useNavigation();
  const [exit, setExit] = useState<{ action: NavigationAction } | null>(null);
  const guarding = useRef(false);
  // A pad left dirty on a step that is no longer on screen is not the next visit's ink — and "Sign again" is not the next
  // visit's state either: coming back shows the saved signature again, never an open studio whose Next could replace it.
  useEffect(() => { if (step !== 1) { setSigDirty(false); setRedoSign(false); } }, [step]);
  const unsavedYou = step === 0 && canAdvance && savedYou !== null && youKey !== savedYou;
  const unsavedSign = step === 1 && sigDirty;
  usePreventRemove(!booting && !done && !exit && (unsavedYou || unsavedSign), ({ data }) => {
    if (guarding.current) return;          // a second swipe while the first is still saving
    guarding.current = true;
    (async () => {
      try {
        if (unsavedSign && studio.current) {
          quietSignAlert.current = true;
          const c = await studio.current.commit();
          quietSignAlert.current = false;
          // 'stuck' too: the pad could not hand it over, and nothing else has said so (see padStuck).
          if (c === 'failed' || c === 'stuck') {
            Alert.alert(
              'Your signature is not saved',
              c === 'stuck'
                ? 'The signature pad stopped working, so it was not saved. Stay and try again, or leave without it — you can add it later.'
                : 'It could not be uploaded. Stay and try again, or leave without it — you can add it later.',
              [
                { text: 'Stay', style: 'cancel' },
                { text: 'Leave without it', style: 'destructive', onPress: () => setExit({ action: data.action }) },
              ],
            );
            return;
          }
        }
        if (unsavedYou) await saveYou(true);
        setExit({ action: data.action });
      } finally {
        quietSignAlert.current = false;
        guarding.current = false;
      }
    })();
  });
  useEffect(() => {
    if (exit) navigation.dispatch(exit.action);
    // navigation is stable for this screen; exit is set once (leaving is one-way).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exit]);

  const chooseCountry = useCallback((c: Country) => {
    setCountry(c);
    // Help, not an override: it fills a code in, and never replaces one they picked themselves.
    if (!dialPinned.current) setDial(c.dial);
  }, []);

  /* ── render ──────────────────────────────────────────────────────────────────────────────── */
  const s0 = STEPS[step];
  const hasPhoto = !!(photoUri || snap?.profileImage);
  const hasSign = !!(signUri || snap?.signature);

  return (
    <View style={s.root}>
      {/* ⚠️ AN ABSOLUTE SIBLING, NOT A PARENT. MeshStage wraps its children in a plain
          <View style={{position:'relative'}}> with no flex:1, so content passed as children sizes
          to itself and a pinned footer never reaches the bottom of the screen. As a sibling it
          needs no change to a shipped hero component — and its three washes keep drifting through
          the whole flow, on the same native driver everything here uses. */}
      <MeshStage style={StyleSheet.absoluteFill} focus={0.78} lift={0.35}><View /></MeshStage>

      {/* insets.top + 52 is Home's own header height, so the chrome on both screens sits on
          exactly one line and the crossfade between them does not jump. */}
      <View style={[s.head, { height: insets.top + 52, paddingTop: insets.top }]}>
        {done ? <View style={s.iconSpacer} /> : (
          <TouchableOpacity onPress={step > 0 ? () => { if (!saving && !sigBusy) leaveTo(step - 1); } : leave} style={s.icon} activeOpacity={0.8}>
            <Ionicons name={step > 0 ? 'chevron-back' : 'close'} size={19} color="#fff" />
          </TouchableOpacity>
        )}
        <View style={s.steps}>
          {STEPS.map((st, i) => (
            <TouchableOpacity
              key={st.key}
              activeOpacity={0.8}
              // Any step up to the first UNFINISHED one (`reach`, from the server on open): everything before it is
              // done and can be revisited; skipping past it would submit a step that was never filled in.
              onPress={() => { if (i !== step && i <= reach && !done && !stage && !saving && !sigBusy) leaveTo(i); }}
              style={s.stepDotWrap}
            >
              <View style={[s.stepDot, i <= step && s.stepDotOn, i > step && i <= reach && s.stepDotDone]} />
            </TouchableOpacity>
          ))}
        </View>
        <View style={s.iconSpacer} />
      </View>

      {/* ⚠️ scaleX, not width: an animated width forces the JS driver, and this tree is native. */}
      <View style={s.track} onLayout={(e) => setBarW(e.nativeEvent.layout.width)}>
        <Animated.View
          style={[
            s.fillWrap,
            {
              transform: [
                { translateX: Animated.multiply(Animated.add(bar, -1), barW / 2) },
                { scaleX: bar },
              ],
            },
          ]}
        >
          <LinearGradient colors={[E.blue, E.purpleLite, E.mint]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.fill} />
        </Animated.View>
      </View>

      {booting ? (
        <View style={s.center}><ActivityIndicator color="#fff" /></View>
      ) : (
        <KeyboardAvoidingView
          style={s.flex}
          // ⚠️ NEVER on Android — adjustResize already shrinks the window and doubling it shifts twice.
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
        >
          <Animated.View
            style={[
              s.flex,
              {
                opacity: slide.interpolate({ inputRange: [-1, 0, 1], outputRange: [0, 1, 0] }),
                transform: [{ translateX: slide.interpolate({ inputRange: [-1, 0, 1], outputRange: [-46, 0, 46] }) }],
              },
            ]}
          >
            <ScrollView
              contentContainerStyle={[s.body, { paddingBottom: 126 + insets.bottom }]}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Text style={s.kicker}>Step {step + 1} of {STEPS.length}</Text>
              <Text style={s.h1}>{s0.title}</Text>

              {step === 0 && (
                <>
                  <Text style={s.lede}>
                    {sweepWords('This is the top of every resume you send.').map((p, i, a) => (
                      <Text key={i} style={{ color: p.c }}>{p.w}{i < a.length - 1 ? ' ' : ''}</Text>
                    ))}
                  </Text>

                  {/* ONE card, five rows. Five boxed fields with their own labels was twice this
                      tall and turned a one-screen step into a scroll. */}
                  <View style={s.card}>
                    <Row icon="person-outline" label="Full name" focused={focus === 'name'}>
                      <TextInput
                        style={s.value}
                        value={fullName}
                        onChangeText={setFullName}
                        onFocus={() => setFocus('name')}
                        onBlur={() => setFocus('')}
                        placeholder="Your name"
                        placeholderTextColor="rgba(255,255,255,0.28)"
                        autoCapitalize="words"
                        returnKeyType="next"
                      />
                    </Row>
                    <Rule />
                    <Row icon="business-outline" label="City" focused={focus === 'city'}>
                      <TextInput
                        style={s.value}
                        value={city}
                        onChangeText={setCity}
                        onFocus={() => setFocus('city')}
                        onBlur={() => setFocus('')}
                        placeholder="Where you live"
                        placeholderTextColor="rgba(255,255,255,0.28)"
                        autoCapitalize="words"
                        returnKeyType="next"
                      />
                    </Row>
                    <Rule />
                    <Row icon="earth-outline" label="Country" focused={sheet === 'country'}>
                      <TouchableOpacity style={s.pickRow} activeOpacity={0.7} onPress={() => setSheet('country')}>
                        {country ? (
                          <>
                            <Text style={s.flag}>{country.flag}</Text>
                            <Text style={s.value} numberOfLines={1}>{country.name}</Text>
                          </>
                        ) : (
                          <Text style={s.placeholder}>Choose</Text>
                        )}
                        <Ionicons name="chevron-down" size={14} color="rgba(255,255,255,0.4)" />
                      </TouchableOpacity>
                    </Row>
                    <Rule />
                    <Row icon="call-outline" label="Phone" focused={focus === 'phone' || sheet === 'dial'}>
                      <TouchableOpacity
                        style={s.dialBtn}
                        activeOpacity={0.7}
                        onPress={() => { dialPinned.current = true; setSheet('dial'); }}
                      >
                        <Text style={[s.dialTx, !dial && s.placeholder]}>{dial || '+ code'}</Text>
                        <Ionicons name="chevron-down" size={12} color="rgba(255,255,255,0.4)" />
                      </TouchableOpacity>
                      <TextInput
                        style={[s.value, s.phoneInput]}
                        value={phone}
                        onChangeText={setPhone}
                        onFocus={() => setFocus('phone')}
                        onBlur={() => setFocus('')}
                        placeholder="98765 43210"
                        placeholderTextColor="rgba(255,255,255,0.28)"
                        keyboardType="phone-pad"
                      />
                    </Row>
                    <Rule />
                    <Row icon="calendar-outline" label="Born" focused={dobOpen}>
                      {Platform.OS === 'web' ? (
                        <TextInput
                          style={s.value}
                          value={dob}
                          onChangeText={setDob}
                          placeholder="YYYY-MM-DD"
                          placeholderTextColor="rgba(255,255,255,0.28)"
                        />
                      ) : (
                        <TouchableOpacity style={s.pickRow} activeOpacity={0.7} onPress={() => setDobOpen(true)}>
                          <Text style={dob ? s.value : s.placeholder}>{dob ? pretty(dob) : 'Optional'}</Text>
                          <Ionicons name="chevron-down" size={14} color="rgba(255,255,255,0.4)" />
                        </TouchableOpacity>
                      )}
                    </Row>
                  </View>

                  <View style={s.genderRow}>
                    <Text style={s.genderLabel}>GENDER</Text>
                    <View style={s.chips}>
                      {GENDERS.map((g) => (
                        <TouchableOpacity
                          key={g}
                          style={[s.chip, gender === g && s.chipOn]}
                          activeOpacity={0.85}
                          onPress={() => setGender(gender === g ? '' : g)}
                        >
                          <Text style={[s.chipTx, gender === g && s.chipTxOn]} numberOfLines={1}>
                            {g === 'Prefer Not to Say' ? 'Rather not' : g}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>

                  <View style={s.note}>
                    <Ionicons name="lock-closed-outline" size={13} color="rgba(255,255,255,0.38)" />
                    <Text style={s.noteTx} numberOfLines={2}>
                      Used on the documents you make here. Nothing is shared with employers you
                      have not applied to.
                    </Text>
                  </View>
                </>
              )}

              {step === 1 && (
                <>
                  <Text style={s.lede}>Both optional. Both make a document look like it is yours.</Text>

                  <TouchableOpacity style={s.photoRow} activeOpacity={0.9} onPress={pickPhoto}>
                    <View>
                      {hasPhoto ? (
                        <Image source={{ uri: photoUri || snap?.profileImage || '' }} style={s.photo} />
                      ) : (
                        <View style={s.photoEmpty}>
                          <Ionicons name="person-outline" size={26} color="rgba(255,255,255,0.5)" />
                        </View>
                      )}
                      <View style={s.photoBadge}>
                        <Ionicons name={hasPhoto ? 'refresh' : 'add'} size={13} color="#fff" />
                      </View>
                    </View>
                    <View style={s.photoText}>
                      <Text style={s.photoH}>Your photo</Text>
                      <Text style={s.photoP} numberOfLines={2}>
                        {hasPhoto ? 'Tap to choose a different one.' : 'Designs that use one look better with it. The rest show your initials.'}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.35)" />
                  </TouchableOpacity>

                  <View style={s.sectionRow}>
                    <Text style={s.section}>YOUR SIGNATURE</Text>
                    {hasSign && (
                      <View style={s.savedPill}>
                        <Ionicons name="checkmark" size={11} color={E.mint} />
                        <Text style={s.savedTx}>SAVED</Text>
                      </View>
                    )}
                    {/* ⚠️ "SIGN AGAIN" CAN BE TAKEN BACK (review, 2026-09-20). It had no way back but "Skip for now", which
                        does not say it keeps anything — so a look at the studio ended in Next, and Next replaced the
                        saved signature. In the header row, so the step still fits on one screen. */}
                    {hasSign && redoSign && (
                      <TouchableOpacity
                        style={s.keepSign}
                        activeOpacity={0.8}
                        disabled={saving || sigBusy}
                        onPress={() => { setRedoSign(false); setSigDirty(false); }}
                      >
                        <Ionicons name="arrow-undo-outline" size={13} color="rgba(255,255,255,0.72)" />
                        <Text style={s.keepSignTx} numberOfLines={1}>Keep my saved one</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  {/* ⚠️ A SAVED SIGNATURE IS SHOWN, NOT A BLANK PAD WITH A LINE OF TEXT UNDER IT. The blank pad is
                      what made a saved signature look lost; the studio opens only to replace it. */}
                  {hasSign && !redoSign ? (
                    <View style={s.sigSaved}>
                      <View style={s.sigPaper}>
                        <Image source={{ uri: signUri || snap?.signature || '' }} style={s.sigImg} resizeMode="contain" />
                      </View>
                      <TouchableOpacity style={s.sigRedo} activeOpacity={0.85} onPress={() => setRedoSign(true)}>
                        <Ionicons name="brush-outline" size={14} color="rgba(255,255,255,0.72)" />
                        <Text style={s.sigRedoTx}>Sign again</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <SignatureStudio
                      ref={studio}
                      name={fullName}
                      existing={signUri || snap?.signature}
                      onCaptured={saveSignature}
                      onDirty={setSigDirty}
                      onEmpty={() => Alert.alert('Nothing to save', 'Draw your signature, or pick a hand.')}
                    />
                  )}
                  {skipped.signature && !hasSign && (
                    <Text style={s.skipNote}>You skipped this last time — it is still optional.</Text>
                  )}
                </>
              )}

              {step === 2 && (
                <>
                  <Text style={s.lede}>Either is fine. We turn whatever you give us into a proper resume.</Text>
                  <View style={s.laneRow}>
                    <TouchableOpacity style={[s.lane, lane === 'write' && s.laneOn]} activeOpacity={0.9} onPress={() => setLane('write')}>
                      <Ionicons name="create-outline" size={17} color={lane === 'write' ? '#fff' : 'rgba(255,255,255,0.65)'} />
                      <Text style={[s.laneTx, lane === 'write' && s.laneTxOn]} numberOfLines={1}>Type it out</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[s.lane, lane === 'upload' && s.laneOn]} activeOpacity={0.9} onPress={() => setLane('upload')}>
                      <Ionicons name="cloud-upload-outline" size={17} color={lane === 'upload' ? '#fff' : 'rgba(255,255,255,0.65)'} />
                      <Text style={[s.laneTx, lane === 'upload' && s.laneTxOn]} numberOfLines={1}>Upload a CV</Text>
                    </TouchableOpacity>
                  </View>

                  {lane === 'write' ? (
                    <>
                      <View style={s.hintCard}>
                        <Ionicons name="bulb-outline" size={15} color={E.mint} />
                        <Text style={s.hintTx}>
                          Rough notes are fine. Jot down where you have worked, roughly when, and what you
                          did — we will turn it into a proper resume.
                        </Text>
                      </View>
                      <TextInput
                        style={s.area}
                        value={rawText}
                        onChangeText={setRawText}
                        multiline
                        textAlignVertical="top"
                        placeholder={'e.g. 3 years at Acme as a backend dev, node and postgres, built their payments thing. Before that 2 years support at Beta. B.Tech 2019.'}
                        placeholderTextColor="rgba(255,255,255,0.32)"
                      />
                      <Text style={s.count}>
                        {rawText.trim().length < 40
                          ? `A little more — ${40 - rawText.trim().length} characters to go`
                          : 'That is plenty to work with'}
                      </Text>
                    </>
                  ) : (
                    <>
                      {/* ⚠️ THE CV THE SERVER HOLDS IS SHOWN, WITH WHETHER IT HAS BEEN READ. Asking for it again is
                          what sent the owner back to square one (2026-09-19). */}
                      <TouchableOpacity style={[s.drop, (!!cv || legacyCv) && s.dropHave]} activeOpacity={0.9} onPress={pickFile}>
                        <Ionicons
                          name={cv ? (cv.status === 'error' ? 'alert-circle-outline' : 'document-text') : legacyCv ? 'document-text' : 'cloud-upload-outline'}
                          size={26}
                          color={cv ? (cv.status === 'error' ? '#FCA5A5' : E.mint) : legacyCv ? E.mint : 'rgba(255,255,255,0.6)'}
                        />
                        <Text style={s.dropTx} numberOfLines={1}>
                          {cv ? (file ? file.name : `Your CV${cv.ext ? ` · ${cv.ext}` : ''}${cvDate(cv.uploadedAt)}`)
                            : legacyCv ? (file ? file.name : 'Your CV is on file') : 'Choose your CV'}
                        </Text>
                        {cv ? (
                          <View style={s.cvState}>
                            {(cv.status === 'pending' || cv.status === 'unread') && <ActivityIndicator size="small" color={E.mint} />}
                            {cv.status === 'done' && <Ionicons name="checkmark-circle" size={14} color={E.mint} />}
                            <Text style={[s.cvStateTx, cv.status === 'error' && s.cvStateErr]} numberOfLines={3}>
                              {cv.status === 'done' ? 'Read ✓ — tap to replace'
                                : cv.status === 'error' ? `${cv.error || 'We could not read this CV.'} Tap to choose another file.`
                                : cv.status === 'slow' ? 'Still reading — this one is taking longer than usual. You can also type it out instead.'
                                : 'Reading your CV…'}
                            </Text>
                          </View>
                        ) : (
                          <Text style={s.dropSub} numberOfLines={2}>{legacyCv ? `Tap to replace · ${RESUME_FORMATS_LINE}` : RESUME_FORMATS_LINE}</Text>
                        )}
                      </TouchableOpacity>
                      <TextInput
                        style={[s.area, s.areaShort]}
                        value={rawText}
                        onChangeText={setRawText}
                        multiline
                        textAlignVertical="top"
                        placeholder="Anything to add that is not in the CV? Optional."
                        placeholderTextColor="rgba(255,255,255,0.32)"
                      />
                    </>
                  )}
                </>
              )}

              {step === 3 && (
                <BuildStep
                  stage={stage}
                  error={genErr}
                  outcome={outcome}
                  done={done}
                  onStart={start}
                  onFinish={leave}
                  onFix={() => { setGenErr(null); setOutcome(null); goTo(2); }}
                  onPlans={() => router.push('/(subscription)/plans' as any)}
                  onRetryAfterPlans={retryAfterPlans}
                  checking={checking}
                  retryNote={recheckNote}
                />
              )}
            </ScrollView>
          </Animated.View>
        </KeyboardAvoidingView>
      )}

      {/* footer — hidden on the build step, which owns its own action */}
      {!booting && step < LAST && (
        <View style={[s.footer, { paddingBottom: insets.bottom + 12 }]}>
          {step === 1 && (
            <TouchableOpacity style={s.skip} activeOpacity={0.8} disabled={saving || sigBusy} onPress={skipSign}>
              <Text style={s.skipTx}>Skip for now</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[s.nextWrap, (!canAdvance || saving || sigBusy) && s.nextOff]}
            activeOpacity={0.9}
            disabled={!canAdvance || saving || sigBusy}
            onPress={next}
          >
            <LinearGradient colors={MINT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.nextBtn}>
              {saving || sigBusy
                ? <ActivityIndicator size="small" color={MINT_INK} />
                : (
                  <>
                    <Text style={s.nextTx} numberOfLines={1}>Next: {STEPS[step + 1].short}</Text>
                    <Ionicons name="arrow-forward" size={16} color="rgba(4,33,28,0.7)" />
                  </>
                )}
            </LinearGradient>
          </TouchableOpacity>
        </View>
      )}

      <CountrySheet
        open={sheet != null}
        mode={sheet === 'dial' ? 'dial' : 'country'}
        selectedIso={country?.iso}
        onPick={(c) => { if (sheet === 'dial') setDial(c.dial); else chooseCountry(c); }}
        onClose={() => setSheet(null)}
      />

      {/* ⚠️ ANDROID RENDERS THE NATIVE DIALOG DIRECTLY — mounting it inside a Modal shows two.
          This is App.js's own pattern for the same component; it is not worth diverging from. */}
      {dobOpen && Platform.OS === 'android' && (
        <DateTimePicker
          value={dobDraft}
          mode="date"
          display="default"
          maximumDate={new Date()}
          minimumDate={new Date(1930, 0, 1)}
          onChange={(e: any, d?: Date) => {
            setDobOpen(false);
            if (e?.type === 'set' && d) { setDobDraft(d); setDob(iso(d)); }
          }}
        />
      )}
      {Platform.OS === 'ios' && (
        <Modal transparent visible={dobOpen} animationType="slide" onRequestClose={() => setDobOpen(false)}>
          <View style={s.dobBackdrop}>
            <Pressable style={s.flex} onPress={() => setDobOpen(false)} />
            <View style={[s.dobSheet, { paddingBottom: insets.bottom + 10 }]}>
              <Text style={s.dobTitle}>Date of birth</Text>
              <DateTimePicker
                value={dobDraft}
                mode="date"
                display="spinner"
                themeVariant="dark"
                maximumDate={new Date()}
                minimumDate={new Date(1930, 0, 1)}
                onChange={(_: any, d?: Date) => { if (d) setDobDraft(d); }}
                style={s.dobPicker}
              />
              <View style={s.dobBtns}>
                <TouchableOpacity style={s.dobGhost} activeOpacity={0.85} onPress={() => setDobOpen(false)}>
                  <Text style={s.dobGhostTx}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.dobSet}
                  activeOpacity={0.9}
                  onPress={() => { setDob(iso(dobDraft)); setDobOpen(false); }}
                >
                  <Text style={s.dobSetTx}>Set date</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

/* ── the build step ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ THE BAR CREEPS INSIDE A STAGE, AND NEVER PAST IT.
 * The server reports the true stage and its ceiling, but around nine tenths of a run is one
 * non-streaming AI call that reports nothing for up to ninety seconds. A bar that only moved on
 * server ticks would freeze there and read as hung. So it eases toward the CURRENT stage's ceiling
 * and stops — it always moves, and it never claims a stage that has not started.
 */
function BuildStep({
  stage, error, outcome, done, onStart, onFinish, onFix, onPlans, onRetryAfterPlans, checking, retryNote,
}: {
  stage: GenStage | null; error: string | null; outcome: BuildOutcome | null; done: boolean;
  onStart: () => void; onFinish: () => void; onFix: () => void; onPlans: () => void;
  onRetryAfterPlans: () => void; checking: boolean; retryNote: string | null;
}) {
  const [shown, setShown] = useState(0);
  const target = stage ? stage.pct : 0;

  useEffect(() => {
    if (!stage) { setShown(0); return; }
    const id = setInterval(() => {
      setShown((v) => {
        // Ease toward the ceiling, slowing as it approaches; never overtake it.
        if (v >= target) return target;
        return Math.min(target, v + Math.max(0.15, (target - v) * 0.06));
      });
    }, 90);
    return () => clearInterval(id);
  }, [stage, target]);

  if (done) {
    return (
      <View style={b.wrap}>
        <View style={b.tickWrap}>
          <LinearGradient colors={[E.teal, E.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={b.tick}>
            <Ionicons name="checkmark" size={30} color="#fff" />
          </LinearGradient>
        </View>
        <Text style={b.h}>Your resume is ready</Text>
        <Text style={b.p}>It is in every design on your home screen. Pick the one you like.</Text>
        <TouchableOpacity style={b.cta} activeOpacity={0.9} onPress={onFinish}>
          <LinearGradient colors={MINT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={b.ctaBtn}>
            <Text style={b.ctaTxt} numberOfLines={1}>See my designs</Text>
            <Ionicons name="arrow-forward" size={16} color="rgba(4,33,28,0.7)" />
          </LinearGradient>
        </TouchableOpacity>
      </View>
    );
  }

  if (!stage) {
    // ⚠️ EVERY END THAT IS NOT "READY" KEEPS THEM HERE, with the server's own sentence and the one action that
    // fits it — never a silent return to Home. The refusals were all decided before the charge.
    const reason = outcome && outcome.kind === 'refused' ? outcome.reason : null;
    const late = !!outcome && outcome.kind === 'late';
    const plans = reason === 'quota_exhausted' || reason === 'regen_limit';
    const fix = reason === 'thin_input' || reason === 'no_resume';
    const label = late ? 'Keep waiting' : plans ? 'See plans' : error ? 'Try again' : 'Build my resume';
    return (
      <View style={b.wrap}>
        <Text style={b.h}>{late ? 'Still building' : 'Ready when you are'}</Text>
        <Text style={b.p}>
          {late
            ? 'Your resume is still being written. Keep waiting follows the same build — you will not be charged twice.'
            : 'This takes about a minute. You can put your phone down — it carries on in the background.'}
        </Text>
        {!!error && (
          <View style={b.err}>
            <Ionicons name="alert-circle-outline" size={15} color="#FCA5A5" />
            <Text style={b.errTx}>{error}</Text>
          </View>
        )}
        <TouchableOpacity style={b.cta} activeOpacity={0.9} onPress={plans ? onPlans : onStart}>
          <LinearGradient colors={MINT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={b.ctaBtn}>
            <Ionicons name={late ? 'hourglass-outline' : plans ? 'card-outline' : 'sparkles'} size={16} color={MINT_INK} />
            <Text style={b.ctaTxt} numberOfLines={1}>{label}</Text>
          </LinearGradient>
        </TouchableOpacity>
        {fix && (
          <TouchableOpacity style={b.ghost} activeOpacity={0.85} onPress={onFix}>
            <Ionicons name="create-outline" size={15} color="rgba(255,255,255,0.75)" />
            <Text style={b.ghostTx} numberOfLines={1}>Add more about your experience</Text>
          </TouchableOpacity>
        )}
        {/* ⚠️ THE WAY ON FOR SOMEONE WHO HAS JUST PAID (2026-09-20). Coming back from the plans screen clears this
            banner by itself (the wizard re-reads the gate on focus, on foreground and on a confirmed purchase), but
            a plan can also arrive with no signal this app ever sees — an admin grant, a store webhook, another
            device — so the screen also says so out loud and offers the tap. It re-runs THIS build: nothing to type
            again, and nothing was charged for the one that was refused. */}
        {plans && (
          <>
            <TouchableOpacity style={b.ghost} activeOpacity={0.85} disabled={checking} onPress={onRetryAfterPlans}>
              {checking
                ? <ActivityIndicator size="small" color="rgba(255,255,255,0.75)" />
                : (
                  <>
                    <Ionicons name="refresh-outline" size={15} color="rgba(255,255,255,0.75)" />
                    <Text style={b.ghostTx} numberOfLines={1}>I’ve subscribed — build it now</Text>
                  </>
                )}
            </TouchableOpacity>
            {/* ⚠️ …and what the re-check FOUND when it did not clear the banner: a tap that answers with nothing
                reads as a broken button to the one person this action is for. */}
            {retryNote
              ? <Text style={b.noteWarn}>{retryNote}</Text>
              : (
                <Text style={b.note}>
                  Already on a plan? We check again every time you come back — you carry on from here, with everything
                  you have entered still in place.
                </Text>
              )}
          </>
        )}
      </View>
    );
  }

  return (
    <View style={b.wrap}>
      <Text style={b.pct}>{Math.round(shown)}<Text style={b.pctSm}>%</Text></Text>
      <View style={b.track}>
        <View style={[b.fill, { width: `${Math.max(2, Math.min(100, shown))}%` }]}>
          <LinearGradient colors={[E.blue, E.purpleLite, E.mint]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </View>
      </View>
      <Text style={b.stage} numberOfLines={2}>{stage.label || 'Working on it'}</Text>
      <Text style={b.p}>You can leave this screen. We will keep going.</Text>
    </View>
  );
}

/* ── bits ────────────────────────────────────────────────────────────────────────────────────── */

/** One line of the details card: icon, name, and the answer on the right. */
function Row({
  icon, label, focused, children,
}: {
  icon: any; label: string; focused?: boolean; children: React.ReactNode;
}) {
  return (
    <View style={[s.row, focused && s.rowOn]}>
      <Ionicons name={icon} size={16} color={focused ? E.mint : 'rgba(255,255,255,0.42)'} />
      <Text style={[s.rowLabel, focused && s.rowLabelOn]}>{label}</Text>
      <View style={s.rowValue}>{children}</View>
    </View>
  );
}

const Rule = () => <View style={s.rule} />;

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: E.stage },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 10 },
  // Home's glassBtn, byte for byte, so the two screens' chrome is the same object.
  icon: {
    width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder,
  },
  // Balances the row so the dots stay centred. It must NOT carry the glass fill, or it paints an
  // empty button nobody can press.
  iconSpacer: { width: 38, height: 38 },
  steps: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  stepDotWrap: { paddingVertical: 8 },
  stepDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.22)' },
  stepDotOn: { width: 20, backgroundColor: E.blue },
  // A step ahead that is already done (the server said so on open) — reachable, so it reads as lit, not as blank.
  stepDotDone: { backgroundColor: 'rgba(94,234,212,0.55)' },

  track: { height: 3, marginHorizontal: 14, borderRadius: 3, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.1)' },
  fillWrap: { ...StyleSheet.absoluteFillObject },
  fill: { flex: 1 },

  body: { paddingHorizontal: 20, paddingTop: 20 },
  kicker: { fontSize: 11, fontWeight: '800', letterSpacing: 1.6, textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)' },
  h1: { fontSize: 28, fontWeight: '800', color: '#fff', letterSpacing: -0.9, marginTop: 5 },
  lede: { fontFamily: SERIF, fontStyle: 'italic', fontSize: 16, color: 'rgba(255,255,255,0.66)', marginTop: 8, lineHeight: 22 },

  /* the details card */
  // ⚠️ DARKER THAN THE PAGE, NOT LIGHTER — the same lesson as the download cards. A white tint on
  // a blue ground is a milky panel that reads as a second background pasted onto the screen; a
  // deeper pane with a lit rim reads as glass, and the white type on it gets its contrast back.
  card: {
    marginTop: 18, borderRadius: 18, overflow: 'hidden',
    backgroundColor: 'rgba(6,11,30,0.42)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  row: { height: 54, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 },
  rowOn: { backgroundColor: 'rgba(94,234,212,0.09)' },
  rowLabel: { width: 74, fontSize: 12.5, fontWeight: '700', color: 'rgba(255,255,255,0.5)' },
  rowLabelOn: { color: 'rgba(255,255,255,0.78)' },
  rowValue: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  rule: { height: StyleSheet.hairlineWidth, marginLeft: 44, backgroundColor: 'rgba(255,255,255,0.10)' },
  value: { flexShrink: 1, fontSize: 15, fontWeight: '700', color: '#fff', textAlign: 'right', padding: 0 },
  placeholder: { fontSize: 15, fontWeight: '600', color: 'rgba(255,255,255,0.28)' },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1, paddingVertical: 8 },
  flag: { fontSize: 17 },
  dialBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 3, height: 32, paddingHorizontal: 9,
    borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: E.glassBorder,
  },
  dialTx: { fontSize: 13.5, fontWeight: '800', color: '#fff' },
  phoneInput: { flex: 1, minWidth: 60 },

  genderRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16, gap: 10 },
  genderLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1.1, color: 'rgba(255,255,255,0.42)' },
  chips: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', gap: 7 },
  chip: {
    paddingHorizontal: 12, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: E.glassBorder,
  },
  chipOn: { backgroundColor: 'rgba(79,141,255,0.22)', borderColor: 'rgba(150,186,255,0.6)' },
  chipTx: { fontSize: 12.5, fontWeight: '700', color: 'rgba(255,255,255,0.6)', flexShrink: 1 },
  chipTxOn: { color: '#fff' },

  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 18, paddingHorizontal: 2 },
  noteTx: { flex: 1, fontSize: 11.5, fontWeight: '600', color: 'rgba(255,255,255,0.38)', lineHeight: 16 },

  /* the date sheet */
  dobBackdrop: { flex: 1, backgroundColor: 'rgba(4,6,14,0.62)', justifyContent: 'flex-end' },
  dobSheet: {
    borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingHorizontal: 16, paddingTop: 16,
    backgroundColor: '#0E1428', borderTopWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  dobTitle: { fontSize: 17, fontWeight: '800', color: '#fff', textAlign: 'center', letterSpacing: -0.4 },
  dobPicker: { height: 196, width: '100%' },
  dobBtns: { flexDirection: 'row', gap: 10, marginTop: 6 },
  dobGhost: {
    flex: 1, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: E.glassBorder,
  },
  dobGhostTx: { fontSize: 14.5, fontWeight: '700', color: 'rgba(255,255,255,0.6)' },
  dobSet: { flex: 1.4, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: E.blueDeep },
  dobSetTx: { fontSize: 14.5, fontWeight: '800', color: '#fff' },

  /* photo + signature */
  photoRow: {
    marginTop: 18, flexDirection: 'row', alignItems: 'center', gap: 14, padding: 13, borderRadius: 18,
    backgroundColor: 'rgba(6,11,30,0.42)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  photo: { width: 62, height: 62, borderRadius: 31, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.22)' },
  photoEmpty: {
    width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1.5, borderColor: E.glassBorder, borderStyle: 'dashed',
  },
  photoBadge: {
    position: 'absolute', right: -3, bottom: -3, width: 26, height: 26, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center', backgroundColor: E.blueDeep,
    borderWidth: 2.5, borderColor: '#0B1024',
  },
  photoText: { flex: 1, minWidth: 0 },
  photoH: { fontSize: 15, fontWeight: '800', color: '#fff', letterSpacing: -0.3 },
  photoP: { fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.48)', marginTop: 3, lineHeight: 16.5 },

  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 20, marginBottom: 10 },
  section: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1.3, color: 'rgba(255,255,255,0.45)' },
  savedPill: {
    flexDirection: 'row', alignItems: 'center', gap: 3, height: 18, paddingHorizontal: 7, borderRadius: 6,
    backgroundColor: 'rgba(20,184,166,0.14)', borderWidth: 1, borderColor: 'rgba(20,184,166,0.3)',
  },
  savedTx: { fontSize: 8.5, fontWeight: '800', letterSpacing: 0.7, color: E.mint },

  // The saved signature, shown on the same white paper the studio draws on — so it reads as THE signature.
  sigSaved: { gap: 10 },
  sigPaper: {
    height: 130, borderRadius: 18, overflow: 'hidden', padding: 14,
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: 'rgba(11,15,34,0.08)',
  },
  sigImg: { flex: 1, width: '100%' },
  sigRedo: {
    alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: 14,
    borderRadius: 13, backgroundColor: 'rgba(6,11,30,0.42)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  sigRedoTx: { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.72)', flexShrink: 1 },
  keepSign: { marginLeft: 'auto', flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingLeft: 8 },
  keepSignTx: { fontSize: 12.5, fontWeight: '700', color: 'rgba(255,255,255,0.72)', flexShrink: 1 },
  skipNote: { marginTop: 10, fontSize: 11.5, fontWeight: '600', color: 'rgba(255,255,255,0.45)', textAlign: 'center', flexShrink: 1 },

  /* experience */
  laneRow: { flexDirection: 'row', gap: 10, marginTop: 18 },
  lane: {
    flex: 1, height: 50, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: E.glassBorder,
  },
  laneOn: { backgroundColor: 'rgba(79,141,255,0.22)', borderColor: 'rgba(150,186,255,0.6)' },
  laneTx: { fontSize: 13.5, fontWeight: '700', color: 'rgba(255,255,255,0.65)', flexShrink: 1 },
  laneTxOn: { color: '#fff' },

  hintCard: {
    flexDirection: 'row', gap: 9, alignItems: 'flex-start', marginTop: 14, padding: 13, borderRadius: 14,
    backgroundColor: 'rgba(94,234,212,0.09)', borderWidth: 1, borderColor: 'rgba(94,234,212,0.24)',
  },
  hintTx: { flex: 1, fontSize: 12.5, fontWeight: '600', color: 'rgba(255,255,255,0.78)', lineHeight: 18 },

  area: {
    marginTop: 12, minHeight: 178, borderRadius: 16, padding: 15, fontSize: 15, lineHeight: 22,
    fontWeight: '500', color: '#fff',
    backgroundColor: 'rgba(6,11,30,0.42)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  areaShort: { minHeight: 104 },
  count: { marginTop: 8, fontSize: 11.5, fontWeight: '700', color: 'rgba(255,255,255,0.42)', textAlign: 'right', flexShrink: 1 },

  drop: {
    marginTop: 14, paddingVertical: 24, paddingHorizontal: 18, borderRadius: 18, alignItems: 'center', gap: 7,
    backgroundColor: 'rgba(6,11,30,0.34)', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.18)', borderStyle: 'dashed',
  },
  dropTx: { fontSize: 15, fontWeight: '800', color: '#fff', flexShrink: 1 },
  dropSub: { fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.45)', textAlign: 'center', flexShrink: 1 },
  // A CV on file: a solid rim instead of the dashed "drop here" one.
  dropHave: { borderStyle: 'solid', borderColor: 'rgba(94,234,212,0.32)', backgroundColor: 'rgba(6,11,30,0.42)' },
  cvState: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 4 },
  cvStateTx: { fontSize: 12, fontWeight: '700', color: 'rgba(255,255,255,0.62)', textAlign: 'center', flexShrink: 1 },
  cvStateErr: { color: '#FCA5A5' },

  // ⚠️ NO BAR BEHIND IT. This used to be a near-opaque panel with a hairline on top, which drew a
  // second background across the foot of a screen that is one continuous gradient — the same
  // "separate background" complaint the home screen's seam was. The button carries itself on its
  // own colour instead; the step's scroll padding already keeps content from running under it.
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 18, paddingTop: 12,
    backgroundColor: 'transparent', gap: 10,
  },
  skip: { alignSelf: 'center', paddingVertical: 4 },
  skipTx: { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.5)', flexShrink: 1 },
  // Glow outside, clipping inside — iOS drops a shadow on an overflow:'hidden' view.
  nextWrap: {
    borderRadius: 16,
    shadowColor: '#2DE0C0', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.45, shadowRadius: 18, elevation: 8,
  },
  nextOff: { shadowOpacity: 0, elevation: 0, opacity: 0.4 },
  nextBtn: { height: 54, borderRadius: 16, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  nextTx: { fontSize: 15.5, fontWeight: '800', color: MINT_INK, flexShrink: 1 },
});

const b = StyleSheet.create({
  wrap: { alignItems: 'center', paddingTop: 30 },
  h: { fontSize: 22, fontWeight: '800', color: '#fff', letterSpacing: -0.6, textAlign: 'center', flexShrink: 1 },
  p: { fontSize: 13.5, fontWeight: '600', color: 'rgba(255,255,255,0.55)', textAlign: 'center', marginTop: 9, lineHeight: 20, flexShrink: 1 },

  pct: { fontSize: 58, fontWeight: '200', color: '#fff', letterSpacing: -2 },
  pctSm: { fontSize: 24, fontWeight: '600', color: 'rgba(255,255,255,0.45)' },
  track: { width: '100%', height: 6, borderRadius: 6, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.1)', marginTop: 16 },
  fill: { height: '100%', borderRadius: 6, overflow: 'hidden' },
  stage: { fontSize: 16, fontWeight: '700', color: '#fff', marginTop: 20, textAlign: 'center', flexShrink: 1 },

  tickWrap: {
    borderRadius: 40, marginBottom: 20,
    shadowColor: E.teal, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.45, shadowRadius: 20, elevation: 8,
  },
  tick: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },

  err: {
    flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 18, padding: 13, borderRadius: 14,
    backgroundColor: 'rgba(248,113,113,0.1)', borderWidth: 1, borderColor: 'rgba(248,113,113,0.28)',
  },
  errTx: { flex: 1, fontSize: 12.5, fontWeight: '600', color: '#FCA5A5', lineHeight: 18 },

  cta: {
    marginTop: 26, alignSelf: 'stretch', borderRadius: 16,
    shadowColor: '#2DE0C0', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.45, shadowRadius: 18, elevation: 8,
  },
  ctaBtn: { height: 54, borderRadius: 16, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  ctaTxt: { fontSize: 15.5, fontWeight: '800', color: MINT_INK, flexShrink: 1 },

  ghost: {
    marginTop: 12, alignSelf: 'stretch', height: 46, borderRadius: 14, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 7, backgroundColor: 'rgba(6,11,30,0.42)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  ghostTx: { fontSize: 13.5, fontWeight: '700', color: 'rgba(255,255,255,0.75)', flexShrink: 1 },
  note: { fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.42)', textAlign: 'center', marginTop: 10, lineHeight: 17, flexShrink: 1 },
  // What the re-check found: readable (this one is an answer to a tap), never the red of the refusal above it.
  noteWarn: { fontSize: 12, fontWeight: '700', color: 'rgba(255,255,255,0.68)', textAlign: 'center', marginTop: 10, lineHeight: 17, flexShrink: 1 },
});
