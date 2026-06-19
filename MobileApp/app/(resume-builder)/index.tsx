// Resume Builder — new feature. Safe to delete without affecting existing app.
import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, Alert, Animated, Platform, Image,
  KeyboardAvoidingView, Modal, FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../../config';
import { useEventCosts } from '../../hooks/useEventCosts';

const T = {
  bg:       '#E5EAF3',
  bgSoft:   '#F0F4FA',
  surface:  '#FFFFFF',
  ink:      '#0B0F22',
  inkSoft:  '#1A2046',
  muted:    '#5A6480',
  faint:    '#8A93B2',
  border:   'rgba(11,15,34,0.07)',
  blue:     '#4F8DFF',
  blueDeep: '#2563EB',
  cyan:     '#06B6D4',
  emerald:  '#10B981',
  navy:     '#0B1120',
};

// ── Country list ─────────────────────────────────────────────────────────────
const COUNTRIES = [
  { name: 'India',          flag: '🇮🇳', dial: '+91'  },
  { name: 'United States',  flag: '🇺🇸', dial: '+1'   },
  { name: 'United Kingdom', flag: '🇬🇧', dial: '+44'  },
  { name: 'Canada',         flag: '🇨🇦', dial: '+1'   },
  { name: 'Australia',      flag: '🇦🇺', dial: '+61'  },
  { name: 'UAE',            flag: '🇦🇪', dial: '+971' },
  { name: 'Singapore',      flag: '🇸🇬', dial: '+65'  },
  { name: 'Germany',        flag: '🇩🇪', dial: '+49'  },
  { name: 'France',         flag: '🇫🇷', dial: '+33'  },
  { name: 'Netherlands',    flag: '🇳🇱', dial: '+31'  },
  { name: 'Ireland',        flag: '🇮🇪', dial: '+353' },
  { name: 'New Zealand',    flag: '🇳🇿', dial: '+64'  },
  { name: 'South Africa',   flag: '🇿🇦', dial: '+27'  },
  { name: 'Saudi Arabia',   flag: '🇸🇦', dial: '+966' },
  { name: 'Qatar',          flag: '🇶🇦', dial: '+974' },
  { name: 'Bahrain',        flag: '🇧🇭', dial: '+973' },
  { name: 'Kuwait',         flag: '🇰🇼', dial: '+965' },
  { name: 'Pakistan',       flag: '🇵🇰', dial: '+92'  },
  { name: 'Bangladesh',     flag: '🇧🇩', dial: '+880' },
  { name: 'Sri Lanka',      flag: '🇱🇰', dial: '+94'  },
  { name: 'Nepal',          flag: '🇳🇵', dial: '+977' },
  { name: 'Malaysia',       flag: '🇲🇾', dial: '+60'  },
  { name: 'Philippines',    flag: '🇵🇭', dial: '+63'  },
  { name: 'Japan',          flag: '🇯🇵', dial: '+81'  },
  { name: 'China',          flag: '🇨🇳', dial: '+86'  },
  { name: 'South Korea',    flag: '🇰🇷', dial: '+82'  },
  { name: 'Indonesia',      flag: '🇮🇩', dial: '+62'  },
  { name: 'Thailand',       flag: '🇹🇭', dial: '+66'  },
  { name: 'Italy',          flag: '🇮🇹', dial: '+39'  },
  { name: 'Spain',          flag: '🇪🇸', dial: '+34'  },
  { name: 'Sweden',         flag: '🇸🇪', dial: '+46'  },
  { name: 'Switzerland',    flag: '🇨🇭', dial: '+41'  },
  { name: 'Brazil',         flag: '🇧🇷', dial: '+55'  },
  { name: 'Mexico',         flag: '🇲🇽', dial: '+52'  },
  { name: 'Nigeria',        flag: '🇳🇬', dial: '+234' },
  { name: 'Kenya',          flag: '🇰🇪', dial: '+254' },
  { name: 'Egypt',          flag: '🇪🇬', dial: '+20'  },
];
const DEFAULT_COUNTRY = COUNTRIES[0]; // India

// Remove ONE OR MORE leading dial-code groups (e.g. "+91 " or a buggy "+91 +91 ")
// so the phone field only ever holds the bare number — prevents the country code
// from being prepended twice on regenerate.
const stripDial = (s?: string) => (s || '').replace(/^(\s*\+\d{1,3}\s+)+/, '').trim();
// Re-select the saved country (by name first, then dial) so the dial prefix stays correct.
const findCountry = (name?: string, dial?: string) =>
  COUNTRIES.find(c => c.name === name) || COUNTRIES.find(c => c.dial === dial) || DEFAULT_COUNTRY;

async function getAuthHeader(): Promise<Record<string, string>> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    const token = JSON.parse(raw || '{}')?.token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch { return {}; }
}

// A ready-to-edit starter resume for the "Build Manually" path — realistic example values the
// user simply taps and replaces (their real name/email/phone/location get merged in at seed time).
const SAMPLE_RESUME = {
  _buildMethod: 'manual',
  personal_info: { full_name: 'Your Name', email: 'you@email.com', phone: '', location: 'City, Country', linkedin_url: '', portfolio_url: '' },
  summary: 'Results-driven professional with a track record of delivering impactful work. Replace this with 2–3 lines on your strengths, focus areas, and what you bring to a team.',
  experience: [
    { role: 'Your Job Title', company: 'Company Name', location: 'City, Country', start_date: 'Jan 2022', end_date: 'Present',
      highlights: ['Describe a key achievement — include a number or result where you can.', 'Add another responsibility or outcome from this role.'] },
  ],
  education: [
    { degree: 'Your Degree', field_of_study: 'Field of Study', institution: 'University / College Name', end_date: '2021', grade: '' },
  ],
  projects: [
    { title: 'Project Name', type: 'Web app', about: 'One line about what this project does and the problem it solves.', role: 'Your role',
      role_highlights: ['What you built or achieved on this project.'] },
  ],
  skills: { technical: ['Skill 1', 'Skill 2', 'Skill 3'], soft: ['Communication', 'Teamwork', 'Problem Solving'] },
};

export default function ResumeBuilderIndex() {
  const router = useRouter();
  const { costs } = useEventCosts();
  const genCost = costs['resume_ai_generate'] ?? 2;   // admin-configurable
  const [mode, setMode] = useState<'select' | 'ai' | 'loading'>('select');
  const [existingResume, setExistingResume] = useState<{ full_name?: string; email?: string } | null>(null);
  const [buildMethod, setBuildMethod] = useState<'ai' | 'manual'>('manual');

  // AI form fields
  const [name,        setName]        = useState('');
  const [email,       setEmail]       = useState('');
  const [country,     setCountry]     = useState(DEFAULT_COUNTRY);
  const [phone,       setPhone]       = useState('');
  const [location,    setLocation]    = useState('');
  const [rawText,     setRawText]     = useState('');
  const [pickerOpen,  setPickerOpen]  = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  // Point 5: optionally fold the uploaded profile resume into the AI generation.
  const [hasUploadedResume,      setHasUploadedResume]      = useState(false);
  const [includeUploadedResume,  setIncludeUploadedResume]  = useState(false);

  // Runs every time screen gains focus
  useFocusEffect(useCallback(() => {
    (async () => {

      // ── 1. Handle "Regenerate" flag set by preview screen ───────────────────
      const action = await AsyncStorage.getItem('resumeBuilderAction').catch(() => null);
      if (action === 'regenerate') {
        await AsyncStorage.removeItem('resumeBuilderAction').catch(() => {});
        const formRaw = await AsyncStorage.getItem('resumeBuilderFormData').catch(() => null);
        if (formRaw) {
          const d = JSON.parse(formRaw);
          if (d.name)     setName(d.name);
          if (d.email)    setEmail(d.email);
          // restore the saved country, then show just the bare number
          if (d.countryDial || d.countryName) setCountry(findCountry(d.countryName, d.countryDial));
          if (d.phone)    setPhone(stripDial(d.phone));
          if (d.location) setLocation(d.location);
          if (d.rawText)  setRawText(d.rawText);
        }
        setMode('ai');
        return;
      }

      // ── 2. Reset mid-generation spinner ─────────────────────────────────────
      setMode(prev => prev === 'loading' ? 'ai' : prev);

      // ── 3. Restore form fields — saved form data first, profile as fallback ────
      const formRaw = await AsyncStorage.getItem('resumeBuilderFormData').catch(() => null);
      const hasFormData = !!formRaw;

      // Parse saved form data
      const saved = formRaw ? JSON.parse(formRaw) : {};

      // Fetch profile from API for auto-fill
      let profile: Record<string, string> = {};
      try {
        const sessionRaw = await SecureStore.getItemAsync('userSession');
        const token = JSON.parse(sessionRaw || '{}')?.token;
        if (token) {
          const pRes = await fetch(`${API_BASE}/users/profile`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (pRes.ok) profile = await pRes.json();
        }
      } catch {}

      // Point 5: show the "include uploaded resume" option only when one exists on file.
      setHasUploadedResume(!!profile.resume);

      // Helper: pick saved value first, then profile, then keep current state
      const pick = (saved: string, profileVal: string) => saved || profileVal || '';

      // For phone: keep only the bare number (strip any dial code from saved or profile)
      const profilePhone = stripDial(profile.phone || '');

      // Restore the saved country (only if the user hasn't already picked one this session)
      if (saved.countryDial || saved.countryName) {
        setCountry(c => (c === DEFAULT_COUNTRY ? findCountry(saved.countryName, saved.countryDial) : c));
      }

      setName(n     => n || pick(saved.name,     profile.fullName || ''));
      setEmail(e    => e || pick(saved.email,    profile.email    || ''));
      setPhone(p    => p || stripDial(pick(saved.phone, profilePhone)));
      setLocation(l => l || pick(saved.location, profile.address  || ''));
      if (saved.rawText) setRawText(saved.rawText);

      // ── 4. Determine build method (3-tier fallback) ──────────────────────────
      // Tier 1: explicit AsyncStorage key (set on every generate/save)
      const storedMethod = await AsyncStorage.getItem('resumeBuilderMethod').catch(() => null);
      if (storedMethod === 'ai' || storedMethod === 'manual') {
        setBuildMethod(storedMethod);
      } else {
        // Tier 2: DB _buildMethod tag
        // (checked inside the DB fetch below — handled there)

        // Tier 3 (final fallback): if the user has ever used the AI form, assume AI
        if (hasFormData) {
          setBuildMethod('ai');
          await AsyncStorage.setItem('resumeBuilderMethod', 'ai').catch(() => {});
        }
      }

      // ── 5. Load existing resume from DB ──────────────────────────────────────
      try {
        const sessionRaw = await SecureStore.getItemAsync('userSession');
        const token = JSON.parse(sessionRaw || '{}')?.token;
        if (!token) return;
        const res = await fetch(`${API_BASE}/resume-builder`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const json = await res.json();
        if (json.resumeData?.personal_info) {
          setExistingResume(json.resumeData.personal_info);
          // Tier 2 fallback: use DB tag if AsyncStorage had nothing
          if (!storedMethod && json.resumeData._buildMethod) {
            setBuildMethod(json.resumeData._buildMethod);
            await AsyncStorage.setItem('resumeBuilderMethod', json.resumeData._buildMethod).catch(() => {});
          }
        } else {
          setExistingResume(null);
        }
      } catch {}
    })();
  }, []));

  // Build Manually → seed the sample resume (with the user's real contact details) and open the
  // editable preview so they create their resume by tapping & replacing the example values.
  const startManualBuild = async () => {
    const dial = (country && (country as any).dial) ? `${(country as any).dial} ` : '';
    const sample = {
      ...SAMPLE_RESUME,
      personal_info: {
        ...SAMPLE_RESUME.personal_info,
        full_name: name || SAMPLE_RESUME.personal_info.full_name,
        email:     email || SAMPLE_RESUME.personal_info.email,
        phone:     phone ? `${dial}${phone}`.trim() : SAMPLE_RESUME.personal_info.phone,
        location:  location || SAMPLE_RESUME.personal_info.location,
      },
    };
    await AsyncStorage.setItem('resumeBuilderData', JSON.stringify(sample)).catch(() => {});
    await AsyncStorage.setItem('resumeBuilderMethod', 'manual').catch(() => {});
    await AsyncStorage.setItem('resumeBuilderSeedSample', '1').catch(() => {});
    router.push('/(resume-builder)/preview');
  };

  // Loading animation
  const dotAnim = useRef(new Animated.Value(0)).current;
  const [loadingMsg, setLoadingMsg] = useState('Extracting your career story…');
  const loadingMsgs = [
    'Extracting your career story…',
    'Scanning for project links…',
    'Enriching project details…',
    'Crafting professional summaries…',
    'Finalising your resume…',
  ];

  function startLoadingAnim() {
    let idx = 0;
    const iv = setInterval(() => {
      idx = (idx + 1) % loadingMsgs.length;
      setLoadingMsg(loadingMsgs[idx]);
    }, 2800);
    Animated.loop(Animated.sequence([
      Animated.timing(dotAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(dotAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ])).start();
    return iv;
  }

  async function handleAIGenerate() {
    if (!rawText.trim() || rawText.trim().length < 30) {
      Alert.alert('More detail needed', 'Please share more about your experience (at least a few sentences).');
      return;
    }
    // Save form data so regenerate from preview can pre-fill.
    // Store the BARE number (no dial) so the country code is only ever added once.
    const cleanPhone = stripDial(phone);
    const fullPhone  = cleanPhone ? `${country.dial} ${cleanPhone}` : '';
    await AsyncStorage.setItem('resumeBuilderFormData', JSON.stringify({ name, email, phone: cleanPhone, location, rawText, countryDial: country.dial, countryName: country.name })).catch(() => {})
    setMode('loading');
    const iv = startLoadingAnim();

    // 120-second client-side timeout — AI generation can take up to 90s
    const controller = new AbortController();
    const clientTimeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const authHeader = await getAuthHeader();
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...authHeader };
      const res = await fetch(`${API_BASE}/resume-builder/generate-ai`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, email, phone: fullPhone, location, rawText, includeUploadedResume: hasUploadedResume && includeUploadedResume }),
        signal: controller.signal,
      });
      clearTimeout(clientTimeout);
      const data = await res.json();
      clearInterval(iv);
      if (res.status === 402) {
        setMode('ai');
        Alert.alert('Insufficient Credits', data.error || 'You need 2 credits to generate a resume. Please top up your credits.');
        return;
      }
      if (!res.ok || !data.resumeData) throw new Error(data.error || 'Generation failed');
      await AsyncStorage.setItem('resumeBuilderData', JSON.stringify(data.resumeData));
      await AsyncStorage.setItem('resumeBuilderMethod', 'ai').catch(() => {});
      setBuildMethod('ai');
      router.push('/(resume-builder)/preview');
    } catch (e: any) {
      clearTimeout(clientTimeout);
      clearInterval(iv);
      setMode('ai');
      const isAbort = e?.name === 'AbortError';
      Alert.alert(
        isAbort ? 'Taking too long…' : 'Generation failed',
        isAbort
          ? 'The AI is taking longer than usual. Please tap "Generate" again — it usually succeeds on the next try.'
          : (e.message || 'Something went wrong. Please try again.'),
        [{ text: 'Try Again', style: 'default' }]
      );
    }
  }

  // ── SELECT MODE ─────────────────────────────────────────────────────────────
  if (mode === 'select') {
    return (
      <SafeAreaView style={s.safe} edges={['top']}>
        {/* Top bar */}
        <View style={s.topBar}>
          <TouchableOpacity onPress={() => router.back()} style={s.backPill} activeOpacity={0.8}>
            <Ionicons name="arrow-back" size={14} color={T.ink} />
            <Text style={s.backPillText}>Back</Text>
          </TouchableOpacity>
          <View style={s.wordmark} pointerEvents="none">
            <Image source={require('../../assets/images/logo_img.png')} style={s.logoImg} resizeMode="contain" />
            <Text style={s.wordmarkText}>CV<Text style={s.wordmarkBlue}>Applyr</Text></Text>
          </View>
          <View style={{ width: 70 }} />
        </View>

        <ScrollView contentContainerStyle={s.selectScroll} showsVerticalScrollIndicator={false}>
          {/* Hero */}
          <View style={s.heroCard}>
            <LinearGradient colors={[T.cyan, T.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.heroBadge}>
              <Ionicons name="document-text" size={28} color="#fff" />
            </LinearGradient>
            <Text style={s.heroTitle}>Resume Builder</Text>
            <Text style={s.heroSub}>Create a job-ready resume in minutes — powered by AI or built manually.</Text>
          </View>

          {/* Existing Resume Card */}
          {existingResume && (
            <View style={s.existingCard}>
              <View style={s.existingLeft}>
                <LinearGradient colors={[T.emerald, '#059669']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.existingIcon}>
                  <Ionicons name="document-text" size={20} color="#fff" />
                </LinearGradient>
                <View style={s.existingText}>
                  <Text style={s.existingTitle}>{existingResume.full_name || 'My Resume'}</Text>
                  <Text style={s.existingSub}>{existingResume.email || 'Resume saved'}</Text>
                </View>
              </View>
              <View style={s.existingActions}>
                <TouchableOpacity style={s.existingViewBtn} onPress={() => router.push('/(resume-builder)/preview')} activeOpacity={0.8}>
                  <Text style={s.existingViewText}>View</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.existingEditBtn}
                  onPress={() => buildMethod === 'ai' ? setMode('ai') : router.push('/(resume-builder)/preview')}
                  activeOpacity={0.8}
                >
                  <Text style={s.existingEditText}>Edit</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* AI Card */}
          <TouchableOpacity style={s.modeCard} onPress={() => setMode('ai')} activeOpacity={0.88}>
            <LinearGradient colors={[T.cyan, T.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.modeIconWrap}>
              <Ionicons name="flash" size={22} color="#fff" />
            </LinearGradient>
            <View style={s.modeTextWrap}>
              <Text style={s.modeTitle}>Build with AI  <Text style={s.modeBadge}>Recommended</Text></Text>
              <Text style={s.modeSub}>Paste any rough notes, old CV snippets, or career story — our AI structures it into a polished resume instantly.</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={T.faint} />
          </TouchableOpacity>

          {/* Manual Card */}
          <TouchableOpacity style={s.modeCard} onPress={startManualBuild} activeOpacity={0.88}>
            <View style={[s.modeIconWrap, { backgroundColor: T.bgSoft }]}>
              <Ionicons name="create-outline" size={22} color={T.blue} />
            </View>
            <View style={s.modeTextWrap}>
              <Text style={s.modeTitle}>Build Manually</Text>
              <Text style={s.modeSub}>Start from a sample resume and tap any section to replace it with your details.</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={T.faint} />
          </TouchableOpacity>

          {/* What you get */}
          <View style={s.featureCard}>
            <Text style={s.featureTitle}>What you get</Text>
            {[
              ['checkmark-circle', T.emerald, 'Professional summary written by AI'],
              ['checkmark-circle', T.emerald, 'Impact-driven bullet points for every role'],
              ['checkmark-circle', T.emerald, 'Auto-enriched project descriptions from your links'],
              ['checkmark-circle', T.emerald, 'Downloadable PDF resume'],
            ].map(([icon, color, text], i) => (
              <View key={i} style={s.featureRow}>
                <Ionicons name={icon as any} size={16} color={color as string} />
                <Text style={s.featureText}>{text as string}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── LOADING ──────────────────────────────────────────────────────────────────
  if (mode === 'loading') {
    return (
      <SafeAreaView style={[s.safe, { justifyContent: 'center', alignItems: 'center' }]} edges={['top']}>
        <LinearGradient colors={[T.cyan, T.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.loadingIcon}>
          <Ionicons name="flash" size={36} color="#fff" />
        </LinearGradient>
        <ActivityIndicator size="large" color={T.blue} style={{ marginTop: 28 }} />
        <Text style={s.loadingTitle}>Building Your Resume</Text>
        <Text style={s.loadingMsg}>{loadingMsg}</Text>
        <View style={s.loadingSteps}>
          {['Extracting URLs', 'Enriching Projects', 'AI Generation', 'Structuring Data'].map((step, i) => (
            <View key={i} style={s.loadingStep}>
              <Animated.View style={[s.loadingDot, { opacity: dotAnim }]} />
              <Text style={s.loadingStepText}>{step}</Text>
            </View>
          ))}
        </View>
      </SafeAreaView>
    );
  }

  // ── AI FORM ──────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.select({ ios: 'padding', android: undefined })}>
        {/* Top bar */}
        <View style={s.topBar}>
          <TouchableOpacity onPress={() => setMode('select')} style={s.backPill} activeOpacity={0.8}>
            <Ionicons name="arrow-back" size={14} color={T.ink} />
            <Text style={s.backPillText}>Back</Text>
          </TouchableOpacity>
          <View style={s.wordmark} pointerEvents="none">
            <Image source={require('../../assets/images/logo_img.png')} style={s.logoImg} resizeMode="contain" />
            <Text style={s.wordmarkText}>CV<Text style={s.wordmarkBlue}>Applyr</Text></Text>
          </View>
          <View style={{ width: 70 }} />
        </View>

        <ScrollView contentContainerStyle={s.aiScroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <View style={s.aiHero}>
            <Text style={s.aiHeroTitle}>Tell Us Your Story</Text>
            <Text style={s.aiHeroSub}>We'll structure it into a professional resume using AI</Text>
          </View>

          {/* Basic info */}
          <View style={s.card}>
            <Text style={s.sectionLabel}>BASIC DETAILS</Text>

            {/* Name */}
            <View style={s.inputRow}>
              <Ionicons name="person-outline" size={16} color={T.blue} style={s.inputIcon} />
              <TextInput style={s.input} placeholder="Full Name" placeholderTextColor={T.faint} value={name} onChangeText={setName} autoCapitalize="words" />
            </View>

            {/* Email */}
            <View style={s.inputRow}>
              <Ionicons name="mail-outline" size={16} color={T.blue} style={s.inputIcon} />
              <TextInput style={s.input} placeholder="Email" placeholderTextColor={T.faint} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
            </View>

            {/* Country picker */}
            <TouchableOpacity style={s.inputRow} onPress={() => { setPickerSearch(''); setPickerOpen(true); }} activeOpacity={0.7}>
              <Ionicons name="globe-outline" size={16} color={T.blue} style={s.inputIcon} />
              <Text style={[s.input, { paddingTop: 0, lineHeight: 20, color: T.ink }]}>
                {country.flag}  {country.name}
              </Text>
              <Ionicons name="chevron-down" size={14} color={T.faint} />
            </TouchableOpacity>

            {/* Phone with non-editable country code */}
            <View style={s.inputRow}>
              <Ionicons name="call-outline" size={16} color={T.blue} style={s.inputIcon} />
              <View style={s.phoneDialBox}>
                <Text style={s.phoneDialText}>{country.dial}</Text>
              </View>
              <TextInput
                style={[s.input, { marginLeft: 8 }]}
                placeholder="Phone number"
                placeholderTextColor={T.faint}
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
              />
            </View>

            {/* Location */}
            <View style={[s.inputRow, { borderBottomWidth: 0 }]}>
              <Ionicons name="location-outline" size={16} color={T.blue} style={s.inputIcon} />
              <TextInput style={s.input} placeholder="City, Country" placeholderTextColor={T.faint} value={location} onChangeText={setLocation} autoCapitalize="words" />
            </View>
          </View>

          {/* Country picker modal */}
          <Modal visible={pickerOpen} animationType="slide" transparent onRequestClose={() => setPickerOpen(false)}>
            <View style={s.modalOverlay}>
              <View style={s.modalSheet}>
                <View style={s.modalHeader}>
                  <Text style={s.modalTitle}>Select Country</Text>
                  <TouchableOpacity onPress={() => setPickerOpen(false)} style={s.modalClose}>
                    <Ionicons name="close" size={20} color={T.ink} />
                  </TouchableOpacity>
                </View>
                <View style={s.searchRow}>
                  <Ionicons name="search-outline" size={15} color={T.faint} />
                  <TextInput
                    style={s.searchInput}
                    placeholder="Search country..."
                    placeholderTextColor={T.faint}
                    value={pickerSearch}
                    onChangeText={setPickerSearch}
                    autoCapitalize="none"
                  />
                </View>
                <FlatList
                  data={COUNTRIES.filter(c => c.name.toLowerCase().includes(pickerSearch.toLowerCase()))}
                  keyExtractor={c => c.name}
                  keyboardShouldPersistTaps="handled"
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={[s.countryRow, item.name === country.name && s.countryRowActive]}
                      onPress={() => { setCountry(item); setPickerOpen(false); }}
                      activeOpacity={0.7}
                    >
                      <Text style={s.countryFlag}>{item.flag}</Text>
                      <Text style={s.countryName}>{item.name}</Text>
                      <Text style={s.countryDial}>{item.dial}</Text>
                      {item.name === country.name && <Ionicons name="checkmark" size={16} color={T.blue} />}
                    </TouchableOpacity>
                  )}
                />
              </View>
            </View>
          </Modal>

          {/* Story textarea */}
          <View style={s.card}>
            <Text style={s.sectionLabel}>YOUR CAREER STORY</Text>
            <Text style={s.storyHint}>
              Paste anything — old resume text, LinkedIn bio, rough notes about your jobs, projects, and education. The more detail, the better.
            </Text>
            <TextInput
              style={s.storyInput}
              placeholder={`e.g.\n"Worked at TechCorp as a backend dev for 3 years. Built a REST API for payments. Also did an open-source project at github.com/me/myapp — it's a task manager built with React + Node.\n\nEducation: B.Tech Computer Science, Delhi University, 2020."`}
              placeholderTextColor={T.faint}
              value={rawText}
              onChangeText={setRawText}
              multiline
              textAlignVertical="top"
            />
            <View style={s.storyHintRow}>
              <Ionicons name="link-outline" size={13} color={T.cyan} />
              <Text style={s.storyHintSmall}>Include any GitHub / portfolio links — we'll auto-enrich them</Text>
            </View>
          </View>

          {/* Point 5: merge uploaded profile resume (only shown when one exists) */}
          {hasUploadedResume && (
            <TouchableOpacity style={s.checkCard} activeOpacity={0.85} onPress={() => setIncludeUploadedResume(v => !v)}>
              <Ionicons
                name={includeUploadedResume ? 'checkbox' : 'square-outline'}
                size={22}
                color={includeUploadedResume ? T.blue : T.faint}
              />
              <View style={s.checkTextWrap}>
                <Text style={s.checkLabel}>Include my uploaded resume</Text>
                <Text style={s.checkSub}>Merge the resume from your Profile with the story above, so the AI uses both.</Text>
              </View>
            </TouchableOpacity>
          )}

          {/* Generate button */}
          <TouchableOpacity onPress={handleAIGenerate} activeOpacity={0.88} style={s.generateOuter}>
            <LinearGradient colors={[T.cyan, T.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.generateBtn}>
              <Ionicons name="flash" size={18} color="#fff" />
              <Text style={s.generateText}>Generate My Resume with AI</Text>
              <View style={s.creditBadge}>
                <Ionicons name="diamond" size={9} color="#fff" />
                <Text style={s.creditBadgeText}>{genCost}</Text>
              </View>
            </LinearGradient>
          </TouchableOpacity>
          <Text style={s.creditNote}>{genCost > 0 ? `Uses ${genCost} credit${genCost === 1 ? '' : 's'} per generation` : 'Free'}</Text>
          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: T.bg },
  topBar:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: T.bg },
  backPill:     { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.surface, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 3 },
  backPillText: { fontSize: 13, fontWeight: '600', color: T.ink },
  wordmark:     { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, zIndex: 0 },
  logoImg:      { width: 22, height: 22 },
  wordmarkText: { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  wordmarkBlue: { color: T.blue },

  // Select mode
  selectScroll:      { padding: 16, gap: 14, paddingBottom: 40 },
  existingCard:      { backgroundColor: T.surface, borderRadius: 20, padding: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.5, borderColor: '#10B981', shadowColor: T.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 12, elevation: 3 },
  existingLeft:      { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  existingIcon:      { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  existingText:      { flex: 1 },
  existingTitle:     { fontSize: 14, fontWeight: '700', color: T.ink },
  existingSub:       { fontSize: 11, color: T.muted, marginTop: 1 },
  existingActions:   { flexDirection: 'row', gap: 8, flexShrink: 0 },
  existingViewBtn:   { backgroundColor: '#10B981', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7 },
  existingViewText:  { fontSize: 12, fontWeight: '700', color: '#fff' },
  existingEditBtn:   { backgroundColor: 'rgba(16,185,129,0.1)', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)' },
  existingEditText:  { fontSize: 12, fontWeight: '700', color: '#10B981' },
  heroCard:     { backgroundColor: T.surface, borderRadius: 24, padding: 24, alignItems: 'center', gap: 10, shadowColor: T.ink, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 4 },
  heroBadge:    { width: 64, height: 64, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  heroTitle:    { fontSize: 22, fontWeight: '800', color: T.ink, letterSpacing: -0.5 },
  heroSub:      { fontSize: 14, color: T.muted, textAlign: 'center', lineHeight: 20 },
  modeCard:     { backgroundColor: T.surface, borderRadius: 20, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14, shadowColor: T.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 12, elevation: 3 },
  modeIconWrap: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  modeTextWrap: { flex: 1, gap: 3 },
  modeTitle:    { fontSize: 15, fontWeight: '700', color: T.ink },
  modeBadge:    { fontSize: 10, fontWeight: '700', color: T.cyan, backgroundColor: 'rgba(6,182,212,0.12)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  modeSub:      { fontSize: 12, color: T.muted, lineHeight: 17 },
  featureCard:  { backgroundColor: T.surface, borderRadius: 20, padding: 18, gap: 10, shadowColor: T.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 12, elevation: 3 },
  featureTitle: { fontSize: 13, fontWeight: '700', color: T.ink, marginBottom: 4 },
  featureRow:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  featureText:  { fontSize: 13, color: T.inkSoft ?? T.muted, flex: 1 },

  // Loading
  loadingIcon:  { width: 80, height: 80, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  loadingTitle: { fontSize: 20, fontWeight: '800', color: T.ink, marginTop: 16, letterSpacing: -0.3 },
  loadingMsg:   { fontSize: 14, color: T.muted, marginTop: 6, textAlign: 'center', paddingHorizontal: 40 },
  loadingSteps: { marginTop: 28, gap: 10, alignSelf: 'stretch', paddingHorizontal: 40 },
  loadingStep:  { flexDirection: 'row', alignItems: 'center', gap: 10 },
  loadingDot:   { width: 8, height: 8, borderRadius: 4, backgroundColor: T.cyan },
  loadingStepText: { fontSize: 13, color: T.muted },

  // AI form
  aiScroll:   { padding: 16, gap: 14, paddingBottom: 40 },
  aiHero:     { marginBottom: 4 },
  aiHeroTitle:{ fontSize: 22, fontWeight: '800', color: T.ink, letterSpacing: -0.4 },
  aiHeroSub:  { fontSize: 13, color: T.muted, marginTop: 4 },
  card:       { backgroundColor: T.surface, borderRadius: 22, padding: 16, shadowColor: T.ink, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.07, shadowRadius: 16, elevation: 4, gap: 2 },
  sectionLabel: { fontSize: 10, fontWeight: '800', color: T.faint, letterSpacing: 1.2, marginBottom: 10 },
  inputRow:     { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: T.border, paddingVertical: 10, gap: 10 },
  inputIcon:    { width: 20 },
  input:        { flex: 1, fontSize: 14, color: T.ink, fontWeight: '500' },
  phoneDialBox: { backgroundColor: T.bgSoft, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: T.border },
  phoneDialText:{ fontSize: 13, fontWeight: '700', color: T.ink },
  // Country picker modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalSheet:   { backgroundColor: T.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '75%', paddingBottom: Platform.select({ ios: 34, default: 16 }) },
  modalHeader:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: T.border },
  modalTitle:   { fontSize: 16, fontWeight: '800', color: T.ink },
  modalClose:   { width: 32, height: 32, borderRadius: 16, backgroundColor: T.bgSoft, alignItems: 'center', justifyContent: 'center' },
  searchRow:    { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginVertical: 10, backgroundColor: T.bgSoft, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: T.border },
  searchInput:  { flex: 1, fontSize: 14, color: T.ink },
  countryRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 13, gap: 12, borderBottomWidth: 1, borderBottomColor: T.border },
  countryRowActive: { backgroundColor: 'rgba(79,141,255,0.06)' },
  countryFlag:  { fontSize: 22 },
  countryName:  { flex: 1, fontSize: 14, fontWeight: '500', color: T.ink },
  countryDial:  { fontSize: 13, color: T.muted, fontWeight: '600' },
  storyHint:  { fontSize: 12, color: T.muted, lineHeight: 17, marginBottom: 10 },
  storyInput: { fontSize: 13, color: T.ink, lineHeight: 20, minHeight: 180, backgroundColor: T.bg, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: T.border },
  storyHintRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 },
  storyHintSmall: { fontSize: 11, color: T.cyan, fontWeight: '600' },
  checkCard:    { backgroundColor: T.surface, borderRadius: 16, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.06, shadowRadius: 10, elevation: 2 },
  checkTextWrap:{ flex: 1, gap: 2 },
  checkLabel:   { fontSize: 14, fontWeight: '700', color: T.ink },
  checkSub:     { fontSize: 12, color: T.muted, lineHeight: 16 },
  generateOuter:   { borderRadius: 16, overflow: 'hidden', marginTop: 4 },
  generateBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, height: 54, borderRadius: 16 },
  generateText:    { fontSize: 16, fontWeight: '800', color: '#fff' },
  creditBadge:     { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3 },
  creditBadgeText: { fontSize: 11, fontWeight: '800', color: '#fff' },
  creditNote:      { fontSize: 11, color: T.faint, textAlign: 'center', marginTop: 6 },
});
