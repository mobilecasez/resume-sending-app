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
  ActivityIndicator, Platform, KeyboardAvoidingView, Alert, Image, Modal, Pressable,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useLocalSearchParams, useRouter } from 'expo-router';
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
import SignatureStudio from '../../components/onboarding/SignatureStudio';
import CountrySheet from '../../components/onboarding/CountrySheet';
import { COUNTRIES, Country, countryByName } from '../../constants/countries';
import {
  fetchProfileSnapshot, saveDetails, uploadPhoto, uploadSignature, uploadResumeFile,
  generateResume, GenStage, ProfileSnapshot,
} from '../../services/profileSetupService';
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

  // step 3 — experience
  const [lane, setLane] = useState<'write' | 'upload'>('write');
  const [rawText, setRawText] = useState('');
  const [file, setFile] = useState<{ uri: string; name: string; mime: string } | null>(null);

  // step 4 — the build
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
        const first = !s.setup.profile ? 0 : (!s.setup.photo || !s.setup.signature) ? 1 : !s.setup.resume ? 2 : 2;
        setStep(devStep ?? first);
      } else if (devStep != null) {
        setStep(devStep);
      }
      setBooting(false);
      track('onboarding_open', { resumedAt: s ? String(s.setup.complete) : 'unknown' });
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

  const saveYou = useCallback(async () => {
    setSaving(true);
    const r = await saveDetails({
      fullName,
      // One column, one string — the code is part of the number a resume prints.
      phone: [dial, phone.trim()].filter(Boolean).join(' '),
      address,
      dateOfBirth: dob,
      gender,
    });
    setSaving(false);
    if (!r.ok) { Alert.alert('Could not save', r.message || 'Please try again.'); return false; }
    return true;
  }, [fullName, dial, phone, address, dob, gender]);

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
  const saveSignature = useCallback(async (uri: string) => {
    setSignUri(uri);
    setSaving(true);
    const up = await uploadSignature(uri);
    setSaving(false);
    if (!up.ok) { setSignUri(null); Alert.alert('Could not upload', up.message || 'Please try again.'); return; }
    try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
  }, []);

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
        name: fullName, email: snap?.email || '', phone: [dial, phone.trim()].filter(Boolean).join(' '),
        location: address, rawText: text, includeUploadedResume: true,
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
  }, [stage, lane, rawText, fullName, dial, phone, address, snap]);

  /* ── gating ──────────────────────────────────────────────────────────────────────────────── */
  const canAdvance = (() => {
    if (step === 0) {
      return fullName.trim().length > 1 && phone.replace(/\D/g, '').length >= 5
        && city.trim().length >= 2 && !!country;
    }
    if (step === 2) return lane === 'write' ? rawText.trim().length >= 40 : !!file;
    return true;
  })();

  const next = useCallback(async () => {
    if (step === 0 && !(await saveYou())) return;
    if (step < LAST) goTo(step + 1);
  }, [step, saveYou, goTo]);

  const leave = useCallback(() => {
    // ⚠️ THE EXIT MATTERS. App.js owns profileData and refetches it only when its own `screen`
    // flips; a route pushed on top of it does not do that. So the app's older cover-letter gate can
    // still believe the profile is incomplete until Account Settings is next opened. Home itself
    // re-reads `setup` on focus, which is what the CTA and the library depend on.
    router.back();
  }, [router]);

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
      <MeshStage style={StyleSheet.absoluteFill}><View /></MeshStage>

      {/* insets.top + 52 is Home's own header height, so the chrome on both screens sits on
          exactly one line and the crossfade between them does not jump. */}
      <View style={[s.head, { height: insets.top + 52, paddingTop: insets.top }]}>
        {done ? <View style={s.iconSpacer} /> : (
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
                  </View>
                  <SignatureStudio
                    name={fullName}
                    existing={signUri || snap?.signature}
                    onCaptured={saveSignature}
                    onEmpty={() => Alert.alert('Nothing to save', 'Draw your signature, or pick a hand.')}
                  />
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

              {step === 3 && (
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
      {!booting && step < LAST && (
        <View style={[s.footer, { paddingBottom: insets.bottom + 12 }]}>
          {step === 1 && (
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
            <LinearGradient colors={MINT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.nextBtn}>
              {saving
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
          <LinearGradient colors={MINT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={b.ctaBtn}>
            <Text style={b.ctaTxt} numberOfLines={1}>See my designs</Text>
            <Ionicons name="arrow-forward" size={16} color="rgba(4,33,28,0.7)" />
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
          <LinearGradient colors={MINT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={b.ctaBtn}>
            <Ionicons name="sparkles" size={16} color={MINT_INK} />
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

  track: { height: 3, marginHorizontal: 14, borderRadius: 3, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.1)' },
  fillWrap: { ...StyleSheet.absoluteFillObject },
  fill: { flex: 1 },

  body: { paddingHorizontal: 20, paddingTop: 20 },
  kicker: { fontSize: 11, fontWeight: '800', letterSpacing: 1.6, textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)' },
  h1: { fontSize: 28, fontWeight: '800', color: '#fff', letterSpacing: -0.9, marginTop: 5 },
  lede: { fontFamily: SERIF, fontStyle: 'italic', fontSize: 16, color: 'rgba(255,255,255,0.66)', marginTop: 8, lineHeight: 22 },

  /* the details card */
  card: {
    marginTop: 18, borderRadius: 18, overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.055)', borderWidth: 1, borderColor: E.glassBorder,
  },
  row: { height: 54, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 },
  rowOn: { backgroundColor: 'rgba(94,234,212,0.07)' },
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
    backgroundColor: 'rgba(255,255,255,0.055)', borderWidth: 1, borderColor: E.glassBorder,
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
    backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: E.glassBorder,
  },
  areaShort: { minHeight: 104 },
  count: { marginTop: 8, fontSize: 11.5, fontWeight: '700', color: 'rgba(255,255,255,0.42)', textAlign: 'right', flexShrink: 1 },

  drop: {
    marginTop: 14, paddingVertical: 24, paddingHorizontal: 18, borderRadius: 18, alignItems: 'center', gap: 7,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1.5, borderColor: E.glassBorder, borderStyle: 'dashed',
  },
  dropTx: { fontSize: 15, fontWeight: '800', color: '#fff', flexShrink: 1 },
  dropSub: { fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.45)', textAlign: 'center', flexShrink: 1 },

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
});
