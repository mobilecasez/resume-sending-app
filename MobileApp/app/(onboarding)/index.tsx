// AI Hub — new feature. Safe to delete without affecting existing app.
//
// MAKE YOURS — the five steps between "I just installed this" and "here is my resume".
//
// The app's own retention data says people install and never activate: most accounts never upload a
// résumé at all. Everything they need already had an endpoint and a screen somewhere — they were
// just scattered across Account Settings, the profile editor and the builder, so nobody walked the
// whole path. This is that path, once, in order, with the resume built at the end of it.
//
// ⚠️ IT DOES NOT INVENT A DEFINITION OF "COMPLETE". Two already exist and they disagree — the API
// says phone + address + date of birth, the activation journey says those three PLUS all three
// files on disk. A third would be how a green tick appears over a profile the generator then
// refuses, so the server's own `setup` object decides, and it also decides which step to open on.
//
// ⚠️ IT RESUMES. Someone who quits at the signature comes back to the signature, because `setup`
// already reports each piece separately. Restarting them at their own name would be a small insult.
//
// ⚠️ ONE ANIMATED DRIVER, NATIVE, IN THE WHOLE TREE (the b126-128 fatal crash). The step slide is
// transform + opacity. The progress bar is therefore scaleX with a translateX compensation rather
// than an animated `width` — animating width forces the JS driver, and a JS-driven value in the
// same tree as this native slide is exactly the crash. Nothing here animates width, height, margin
// or colour.
//
// ⚠️ STEP 5 SPENDS MONEY. Generating is a metered AI call that can answer 402 or 403, so it is
// behind an explicit tap and never fires on step entry — the letters auto-regeneration incident is
// the precedent for why.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, Animated, Easing,
  ActivityIndicator, Platform, KeyboardAvoidingView, Alert, Image,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { E, SERIF, sweepWords } from '../../components/employer-home/theme';
import MeshStage from '../../components/employer-home/MeshStage';
import SignaturePad from '../../components/onboarding/SignaturePad';
import {
  fetchProfileSnapshot, saveDetails, uploadPhoto, uploadSignature, uploadResumeFile,
  generateResume, GenStage, ProfileSnapshot,
} from '../../services/profileSetupService';
import { track } from '../../services/analytics';

type StepKey = 'you' | 'photo' | 'signature' | 'experience' | 'build';
const STEPS: Array<{ key: StepKey; title: string; short: string }> = [
  { key: 'you', title: 'About you', short: 'You' },
  { key: 'photo', title: 'Your photo', short: 'Photo' },
  { key: 'signature', title: 'Your signature', short: 'Sign' },
  { key: 'experience', title: 'Your experience', short: 'Work' },
  { key: 'build', title: 'Building it', short: 'Build' },
];

/** The server enum, exactly. Anything else is a 400. */
const GENDERS = ['Male', 'Female', 'Prefer Not to Say'];

export default function MakeYours() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState(0);
  const [snap, setSnap] = useState<ProfileSnapshot | null>(null);
  const [booting, setBooting] = useState(true);
  const [saving, setSaving] = useState(false);

  // step 1
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [dob, setDob] = useState('');
  const [address, setAddress] = useState('');
  const [gender, setGender] = useState('');

  // steps 2-3
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [signUri, setSignUri] = useState<string | null>(null);

  // step 4
  const [lane, setLane] = useState<'write' | 'upload'>('write');
  const [rawText, setRawText] = useState('');
  const [file, setFile] = useState<{ uri: string; name: string; mime: string } | null>(null);

  // step 5
  const [stage, setStage] = useState<GenStage | null>(null);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

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
        setPhone(s.phone || '');
        setDob(s.dateOfBirth || '');
        setAddress(s.address || '');
        setGender(GENDERS.includes(s.gender) ? s.gender : '');
        const first = !s.setup.profile ? 0 : !s.setup.photo ? 1 : !s.setup.signature ? 2 : !s.setup.resume ? 3 : 3;
        setStep(first);
      }
      setBooting(false);
      track('onboarding_open', { resumedAt: s ? String(s.setup.complete) : 'unknown' });
    })();
    return () => { alive = false; };
  }, []);

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
  const saveYou = useCallback(async () => {
    setSaving(true);
    const r = await saveDetails({ fullName, phone, address, dateOfBirth: dob, gender });
    setSaving(false);
    if (!r.ok) { Alert.alert('Could not save', r.message || 'Please try again.'); return false; }
    return true;
  }, [fullName, phone, address, dob, gender]);

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

  const saveSignature = useCallback(async (uri: string) => {
    setSignUri(uri);
    setSaving(true);
    const up = await uploadSignature(uri);
    setSaving(false);
    if (!up.ok) { setSignUri(null); Alert.alert('Could not upload', up.message || 'Please try again.'); return; }
    try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    goTo(3);
  }, [goTo]);

  const pickFile = useCallback(async () => {
    try {
      // ⚠️ PDF ONLY, on purpose. The server accepts anything, but the parser's vision fallback
      // handles pdf/png/jpg/webp/heic — a .docx uploads happily and then fails with no signal.
      const r = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true });
      if (r.canceled || !r.assets?.length) return;
      const a = r.assets[0];
      setFile({ uri: a.uri, name: a.name || 'resume.pdf', mime: a.mimeType || 'application/pdf' });
      setSaving(true);
      const up = await uploadResumeFile(a.uri, a.name || 'resume.pdf', a.mimeType || 'application/pdf');
      setSaving(false);
      if (!up.ok) { setFile(null); Alert.alert('Could not upload', up.message || 'Please try again.'); }
    } catch (e: any) {
      setSaving(false);
      Alert.alert('Could not open that file', e?.message || 'Please try again.');
    }
  }, []);

  /**
   * ⚠️ THE ONE PLACE THAT SPENDS A GENERATION. Explicit tap only.
   * The uploaded file lane sends a short note plus `includeUploadedResume`, because the server
   * needs at least twenty characters of text and the parsed CV arrives separately — the parse is
   * fire-and-forget, so it may still be running, and folding it in is best-effort by design.
   */
  const build = useCallback(async () => {
    if (stage) return;
    setGenErr(null);
    setStage({ stage: 'start', label: 'Getting started', pct: 3 });
    track('onboarding_build', { lane });
    const text = lane === 'upload'
      ? (rawText.trim() || `Please build my resume from the CV I uploaded${fullName ? ` for ${fullName}` : ''}.`)
      : rawText.trim();
    const r = await generateResume(
      {
        name: fullName, email: snap?.email || '', phone, location: address,
        rawText: text, includeUploadedResume: true,
      },
      (st) => setStage(st),
    );
    if (r.ok) {
      setStage({ stage: 'done', label: 'Ready', pct: 100 });
      setDone(true);
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
      return;
    }
    setStage(null);
    setGenErr(r.message);
  }, [stage, lane, rawText, fullName, phone, address, snap]);

  /* ── gating ──────────────────────────────────────────────────────────────────────────────── */
  const canAdvance = (() => {
    if (step === 0) return fullName.trim().length > 1 && phone.trim().length >= 5 && address.trim().length >= 4;
    if (step === 3) return lane === 'write' ? rawText.trim().length >= 40 : !!file;
    return true;
  })();

  const next = useCallback(async () => {
    if (step === 0 && !(await saveYou())) return;
    if (step < STEPS.length - 1) goTo(step + 1);
  }, [step, saveYou, goTo]);

  const leave = useCallback(() => {
    // ⚠️ THE EXIT MATTERS. App.js owns profileData and refetches it only when its own `screen`
    // flips; a route pushed on top of it does not do that. So the app's older cover-letter gate can
    // still believe the profile is incomplete until Account Settings is next opened. Home itself
    // re-reads `setup` on focus, which is what the CTA and the library depend on.
    router.back();
  }, [router]);

  /* ── render ──────────────────────────────────────────────────────────────────────────────── */
  const s0 = STEPS[step];

  return (
    <View style={s.root}>
      {/* ⚠️ AN ABSOLUTE SIBLING, NOT A PARENT. MeshStage wraps its children in a plain
          <View style={{position:'relative'}}> with no flex:1, so content passed as children sizes
          to itself and a pinned footer never reaches the bottom of the screen. As a sibling it
          needs no change to a shipped hero component — and its three washes keep drifting through
          the whole flow, on the same native driver everything here uses. */}
      <MeshStage fade={false} style={StyleSheet.absoluteFill}><View /></MeshStage>

      {/* insets.top + 52 is Home's own header height, so the chrome on both screens sits on
          exactly one line and the crossfade between them does not jump. */}
      <View style={[s.head, { height: insets.top + 52, paddingTop: insets.top }]}>
        {done ? <View style={s.icon} /> : (
          <TouchableOpacity onPress={step > 0 ? () => goTo(step - 1) : leave} style={s.icon} activeOpacity={0.8}>
            <Ionicons name={step > 0 ? 'chevron-back' : 'close'} size={19} color="#fff" />
          </TouchableOpacity>
        )}
        <View style={s.steps}>
          {STEPS.map((st, i) => (
            <TouchableOpacity
              key={st.key}
              activeOpacity={0.8}
              // Backwards only — skipping ahead would submit a step that was never filled in.
              onPress={() => { if (i < step && !done) goTo(i); }}
              style={s.stepDotWrap}
            >
              <View style={[s.stepDot, i <= step && s.stepDotOn]} />
            </TouchableOpacity>
          ))}
        </View>
        <View style={s.icon} />
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
              contentContainerStyle={[s.body, { paddingBottom: 132 + insets.bottom }]}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Text style={s.kicker}>Step {step + 1} of {STEPS.length}</Text>
              <Text style={s.h1}>{s0.title}</Text>

              {step === 0 && (
                <>
                  <Text style={s.lede}>
                    {sweepWords('This is what goes at the top of every resume.').map((p, i, a) => (
                      <Text key={i} style={{ color: p.c }}>{p.w}{i < a.length - 1 ? ' ' : ''}</Text>
                    ))}
                  </Text>
                  <Field label="Full name" value={fullName} onChange={setFullName} placeholder="Your name" autoCapitalize="words" />
                  <Field label="Phone" value={phone} onChange={setPhone} placeholder="+91 98765 43210" keyboardType="phone-pad" />
                  <Field label="Where you live" value={address} onChange={setAddress} placeholder="City, country" autoCapitalize="words" />
                  <Field label="Date of birth" value={dob} onChange={setDob} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" hint="Some employers ask for it. Leave it blank if you would rather not." />
                  <Text style={s.label}>Gender</Text>
                  <View style={s.chips}>
                    {GENDERS.map((g) => (
                      <TouchableOpacity
                        key={g}
                        style={[s.chip, gender === g && s.chipOn]}
                        activeOpacity={0.85}
                        onPress={() => setGender(gender === g ? '' : g)}
                      >
                        <Text style={[s.chipTx, gender === g && s.chipTxOn]} numberOfLines={1}>{g}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              )}

              {step === 1 && (
                <>
                  <Text style={s.lede}>Optional. Most designs show your initials instead, and look just as good.</Text>
                  <TouchableOpacity style={s.photoWrap} activeOpacity={0.9} onPress={pickPhoto}>
                    {photoUri || snap?.profileImage ? (
                      <Image source={{ uri: photoUri || snap?.profileImage || '' }} style={s.photo} />
                    ) : (
                      <View style={s.photoEmpty}>
                        <Ionicons name="camera-outline" size={28} color="rgba(255,255,255,0.6)" />
                      </View>
                    )}
                    <View style={s.photoBadge}>
                      <Ionicons name={photoUri || snap?.profileImage ? 'refresh' : 'add'} size={15} color="#fff" />
                    </View>
                  </TouchableOpacity>
                  <Text style={s.photoTx}>
                    {photoUri || snap?.profileImage ? 'Tap to choose a different one' : 'Tap to choose a photo'}
                  </Text>
                </>
              )}

              {step === 2 && (
                <>
                  <Text style={s.lede}>Signed letters get read. This goes at the bottom of your cover letters.</Text>
                  <SignaturePad onCaptured={saveSignature} onEmpty={() => Alert.alert('Nothing to save', 'Draw your signature first.')} />
                  {!!snap?.signature && !signUri && (
                    <Text style={s.have}>You already have one saved. Drawing a new one replaces it.</Text>
                  )}
                </>
              )}

              {step === 3 && (
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
                      <TouchableOpacity style={s.drop} activeOpacity={0.9} onPress={pickFile}>
                        <Ionicons name={file ? 'document-text' : 'cloud-upload-outline'} size={26} color={file ? E.mint : 'rgba(255,255,255,0.6)'} />
                        <Text style={s.dropTx} numberOfLines={1}>{file ? file.name : 'Choose a PDF'}</Text>
                        <Text style={s.dropSub} numberOfLines={2}>
                          {file ? 'Tap to pick a different file' : 'We read it and pull out your experience'}
                        </Text>
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

              {step === 4 && (
                <BuildStep
                  stage={stage}
                  error={genErr}
                  done={done}
                  onStart={build}
                  onFinish={leave}
                />
              )}
            </ScrollView>
          </Animated.View>
        </KeyboardAvoidingView>
      )}

      {/* footer — hidden on the build step, which owns its own action */}
      {!booting && step < STEPS.length - 1 && (
        <View style={[s.footer, { paddingBottom: insets.bottom + 12 }]}>
          {(step === 1 || step === 2) && (
            <TouchableOpacity style={s.skip} activeOpacity={0.8} onPress={() => goTo(step + 1)}>
              <Text style={s.skipTx}>Skip for now</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[s.nextWrap, (!canAdvance || saving) && s.nextOff]}
            activeOpacity={0.9}
            disabled={!canAdvance || saving}
            onPress={next}
          >
            <LinearGradient colors={[E.blue, E.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.nextBtn}>
              {saving
                ? <ActivityIndicator size="small" color="#fff" />
                : (
                  <>
                    <Text style={s.nextTx} numberOfLines={1}>Next: {STEPS[step + 1].short}</Text>
                    <Ionicons name="arrow-forward" size={16} color="#fff" />
                  </>
                )}
            </LinearGradient>
          </TouchableOpacity>
        </View>
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
  stage, error, done, onStart, onFinish,
}: {
  stage: GenStage | null; error: string | null; done: boolean;
  onStart: () => void; onFinish: () => void;
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
          <LinearGradient colors={[E.blue, E.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={b.ctaBtn}>
            <Text style={b.ctaTxt} numberOfLines={1}>See my designs</Text>
            <Ionicons name="arrow-forward" size={16} color="#fff" />
          </LinearGradient>
        </TouchableOpacity>
      </View>
    );
  }

  if (!stage) {
    return (
      <View style={b.wrap}>
        <Text style={b.h}>Ready when you are</Text>
        <Text style={b.p}>
          This takes about a minute. You can put your phone down — it carries on in the background.
        </Text>
        {!!error && (
          <View style={b.err}>
            <Ionicons name="alert-circle-outline" size={15} color="#FCA5A5" />
            <Text style={b.errTx}>{error}</Text>
          </View>
        )}
        <TouchableOpacity style={b.cta} activeOpacity={0.9} onPress={onStart}>
          <LinearGradient colors={[E.blue, E.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={b.ctaBtn}>
            <Ionicons name="sparkles" size={16} color="#fff" />
            <Text style={b.ctaTxt} numberOfLines={1}>{error ? 'Try again' : 'Build my resume'}</Text>
          </LinearGradient>
        </TouchableOpacity>
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

function Field({
  label, value, onChange, placeholder, hint, keyboardType, autoCapitalize,
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string;
  keyboardType?: any; autoCapitalize?: any;
}) {
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="rgba(255,255,255,0.3)"
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize || 'none'}
      />
      {!!hint && <Text style={s.hint} numberOfLines={2}>{hint}</Text>}
    </View>
  );
}

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
  steps: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  stepDotWrap: { paddingVertical: 8 },
  stepDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.22)' },
  stepDotOn: { width: 20, backgroundColor: E.blue },

  track: { height: 3, marginHorizontal: 14, borderRadius: 3, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.1)' },
  fillWrap: { ...StyleSheet.absoluteFillObject },
  fill: { flex: 1 },

  body: { paddingHorizontal: 22, paddingTop: 26 },
  kicker: { fontSize: 11, fontWeight: '800', letterSpacing: 1.6, textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)' },
  h1: { fontSize: 30, fontWeight: '800', color: '#fff', letterSpacing: -0.9, marginTop: 6 },
  lede: { fontFamily: SERIF, fontStyle: 'italic', fontSize: 17, color: 'rgba(255,255,255,0.66)', marginTop: 10, lineHeight: 24 },

  label: { fontSize: 11.5, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)', marginBottom: 7, marginTop: 16 },
  input: {
    height: 52, borderRadius: 15, paddingHorizontal: 15, fontSize: 15.5, fontWeight: '600', color: '#fff',
    backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: E.glassBorder,
  },
  hint: { fontSize: 11.5, fontWeight: '600', color: 'rgba(255,255,255,0.4)', marginTop: 6, lineHeight: 16, flexShrink: 1 },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: E.glassBorder,
  },
  chipOn: { backgroundColor: 'rgba(79,141,255,0.22)', borderColor: 'rgba(150,186,255,0.6)' },
  chipTx: { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.62)', flexShrink: 1 },
  chipTxOn: { color: '#fff' },

  photoWrap: { alignSelf: 'center', marginTop: 30 },
  photo: { width: 132, height: 132, borderRadius: 66, borderWidth: 2, borderColor: 'rgba(255,255,255,0.22)' },
  photoEmpty: {
    width: 132, height: 132, borderRadius: 66, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1.5, borderColor: E.glassBorder, borderStyle: 'dashed',
  },
  photoBadge: {
    position: 'absolute', right: -2, bottom: -2, width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center', backgroundColor: E.blueDeep,
    borderWidth: 3, borderColor: E.stage,
  },
  photoTx: { textAlign: 'center', marginTop: 16, fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.5)', flexShrink: 1 },
  have: { marginTop: 12, fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.45)', textAlign: 'center', flexShrink: 1 },

  laneRow: { flexDirection: 'row', gap: 10, marginTop: 20 },
  lane: {
    flex: 1, height: 50, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: E.glassBorder,
  },
  laneOn: { backgroundColor: 'rgba(79,141,255,0.22)', borderColor: 'rgba(150,186,255,0.6)' },
  laneTx: { fontSize: 13.5, fontWeight: '700', color: 'rgba(255,255,255,0.65)', flexShrink: 1 },
  laneTxOn: { color: '#fff' },

  hintCard: {
    flexDirection: 'row', gap: 9, alignItems: 'flex-start', marginTop: 16, padding: 13, borderRadius: 14,
    backgroundColor: 'rgba(94,234,212,0.09)', borderWidth: 1, borderColor: 'rgba(94,234,212,0.24)',
  },
  hintTx: { flex: 1, fontSize: 12.5, fontWeight: '600', color: 'rgba(255,255,255,0.78)', lineHeight: 18 },

  area: {
    marginTop: 14, minHeight: 190, borderRadius: 16, padding: 15, fontSize: 15, lineHeight: 22,
    fontWeight: '500', color: '#fff',
    backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: E.glassBorder,
  },
  areaShort: { minHeight: 110 },
  count: { marginTop: 9, fontSize: 11.5, fontWeight: '700', color: 'rgba(255,255,255,0.42)', textAlign: 'right', flexShrink: 1 },

  drop: {
    marginTop: 16, paddingVertical: 26, paddingHorizontal: 18, borderRadius: 18, alignItems: 'center', gap: 7,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1.5, borderColor: E.glassBorder, borderStyle: 'dashed',
  },
  dropTx: { fontSize: 15, fontWeight: '800', color: '#fff', flexShrink: 1 },
  dropSub: { fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.45)', textAlign: 'center', flexShrink: 1 },

  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 18, paddingTop: 12,
    backgroundColor: 'rgba(7,10,24,0.86)', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.07)',
    gap: 10,
  },
  skip: { alignSelf: 'center', paddingVertical: 4 },
  skipTx: { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.5)', flexShrink: 1 },
  // Glow outside, clipping inside — iOS drops a shadow on an overflow:'hidden' view.
  nextWrap: {
    borderRadius: 16,
    shadowColor: E.blue, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 8,
  },
  nextOff: { shadowOpacity: 0, elevation: 0, opacity: 0.45 },
  nextBtn: { height: 54, borderRadius: 16, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  nextTx: { fontSize: 15.5, fontWeight: '800', color: '#fff', flexShrink: 1 },
});

const b = StyleSheet.create({
  wrap: { alignItems: 'center', paddingTop: 34 },
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
    shadowColor: E.blue, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 8,
  },
  ctaBtn: { height: 54, borderRadius: 16, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  ctaTxt: { fontSize: 15.5, fontWeight: '800', color: '#fff', flexShrink: 1 },
});
