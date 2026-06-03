// AI Hub — new feature. Safe to delete without affecting existing app.

import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Linking,
  Platform,
  Alert,
  Animated,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { downloadAsync, cacheDirectory } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { startJobCoverLetter, pollJobCoverLetter, saveJobCoverLetter, loadJobCoverLetter, updateJobCLStatus } from '../../services/aiHubService';
import { API_BASE } from '../../config';
import type { Contact, Job, Employer } from '../../types/aiHub';

async function getToken(): Promise<string | null> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    if (!raw) return null;
    return JSON.parse(raw)?.token ?? null;
  } catch { return null; }
}

// ─── Theme (matches index.tsx exactly) ────────────────────────────
const T = {
  bg:       '#E5EAF3',
  bgSoft:   '#EDF1F8',
  surface:  '#FFFFFF',
  ink:      '#0B0F22',
  inkSoft:  '#1A2046',
  textMuted:'#5A6480',
  textFaint:'#8A93B2',
  border:   'rgba(11,15,34,0.06)',
  borderHi: 'rgba(11,15,34,0.10)',
  blue:     '#4F8DFF',
  blueDeep: '#2563EB',
  emerald:  '#10B981',
  rose:     '#EF4444',
  amber:    '#F59E0B',
};

// ─── Mock data (fallback for testing) ────────────────────────────
const MOCK_EMPLOYERS: Employer[] = [{
  id: 'apple', name: 'Apple Inc.', subInfo: 'Cupertino, CA · Technology',
  logoColor: ['#555555', '#1C1C1E'], logoInitial: 'A', status: 'active',
  jobs: [{
    id: 'apple-job-1', title: 'Senior Software Engineer — SwiftUI',
    location: 'Cupertino, CA', experience: '5+ years', salary: '$200K–$260K',
    jobType: 'Full-time', urgent: false,
    skills: ['SwiftUI', 'Combine', 'Core Data', 'UIKit', 'Xcode'],
    responsibilities: ['Build iOS features with SwiftUI', 'Maintain Core Data layer', 'Code reviews'],
    contacts: [{ id: 'c1', name: 'Sarah Chen', role: 'Engineering Manager', email: 's.chen@apple.com', verified: true, avatarColor: ['#06B6D4', '#3B82F6'] }],
  }],
}];

// ─── Contact row (matches index.tsx) ─────────────────────────────
function ContactRow({ contact }: { contact: Contact }) {
  const initials = contact.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
  return (
    <View style={s.contactRow}>
      <LinearGradient colors={contact.avatarColor} style={s.avatar}>
        <Text style={s.avatarText}>{initials}</Text>
      </LinearGradient>
      <View style={{ flex: 1 }}>
        <Text style={s.contactName}>{contact.name}</Text>
        <Text style={s.contactRole}>{contact.role}</Text>
        {!!contact.email && (
          <Text style={s.contactEmail} numberOfLines={1}>{contact.email}</Text>
        )}
      </View>
      {contact.verified && (
        <View style={s.verifiedBadge}>
          <Ionicons name="checkmark-circle" size={16} color={T.emerald} />
        </View>
      )}
    </View>
  );
}

// ─── Cover Letter Modal ───────────────────────────────────────────
// ─── Generate Cover Letter Button (exact clone of HomeScreen GenerateButton) ──
type CLBtnState = 'idle' | 'loading' | 'done';
function GenerateCLButton({ state, progress, progressAnim, label, onPress }: {
  state: CLBtnState; progress: number; progressAnim: Animated.Value; label: string; onPress: () => void;
}) {
  const spinAnim = useRef(new Animated.Value(0)).current;
  const shimAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (state === 'loading') {
      Animated.loop(Animated.timing(spinAnim, { toValue: 1, duration: 800, useNativeDriver: true })).start();
      Animated.loop(Animated.timing(shimAnim, { toValue: 1, duration: 2200, useNativeDriver: true })).start();
    } else { spinAnim.stopAnimation(); shimAnim.stopAnimation(); }
  }, [state]);
  const spin  = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const shimX = shimAnim.interpolate({ inputRange: [0, 1], outputRange: [-160, 360] });
  const fillW = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  if (state === 'idle') return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={btn.wrap}>
      <LinearGradient colors={['#4F8DFF', '#7C6BFF', '#5B4FE8']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={btn.idleContent}>
        <Ionicons name="sparkles" size={14} color="#fff" />
        <Text style={btn.label}>Generate Cover Letter</Text>
      </View>
      <View style={btn.arrowPill}>
        <Ionicons name="arrow-forward" size={14} color="#fff" />
      </View>
    </TouchableOpacity>
  );

  if (state === 'loading') return (
    <View style={[btn.wrap, { backgroundColor: '#9FB9E8' }]}>
      <Animated.View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: fillW, overflow: 'hidden' }}>
        <LinearGradient colors={[T.blue, '#7C6BFF']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, width: 80, transform: [{ translateX: shimX }] }}>
        <LinearGradient colors={['transparent', 'rgba(255,255,255,0.28)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <View style={[btn.idleContent, { justifyContent: 'space-between', paddingRight: 14, zIndex: 2 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Animated.View style={[btn.spinner, { transform: [{ rotate: spin }] }]} />
          <Text style={btn.label} numberOfLines={1}>{label}</Text>
        </View>
        <Text style={btn.pct}>{Math.round(progress)}%</Text>
      </View>
    </View>
  );

  return (
    <View style={[btn.wrap, { overflow: 'hidden' }]}>
      <LinearGradient colors={['#10B981', '#059669']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
      <View style={btn.idleContent}>
        <Ionicons name="checkmark-circle" size={14} color="#fff" />
        <Text style={btn.label}>Generated ✓</Text>
      </View>
    </View>
  );
}

// ─── Download PDF Button (clone of HomeScreen DownloadButton) ─────────────────
function DownloadCLButton({ state, progress, progressAnim, onPress }: {
  state: CLBtnState; progress: number; progressAnim: Animated.Value; onPress: () => void;
}) {
  const spinAnim = useRef(new Animated.Value(0)).current;
  const shimAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (state === 'loading') {
      Animated.loop(Animated.timing(spinAnim, { toValue: 1, duration: 800, useNativeDriver: true })).start();
      Animated.loop(Animated.timing(shimAnim, { toValue: 1, duration: 2000, useNativeDriver: true })).start();
    } else { spinAnim.stopAnimation(); shimAnim.stopAnimation(); }
  }, [state]);
  const spin  = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const shimX = shimAnim.interpolate({ inputRange: [0, 1], outputRange: [-120, 300] });
  const fillW = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const isLoading = state === 'loading';
  const isDone    = state === 'done';

  return (
    <TouchableOpacity onPress={onPress} disabled={isLoading} activeOpacity={isLoading ? 1 : 0.82} style={[btn.dlWrap, { flex: 1 }]}>
      {(isLoading || isDone) && <View style={[StyleSheet.absoluteFill, { backgroundColor: '#9FB9E8', borderRadius: 12 }]} />}
      {(isLoading || isDone) && (
        <Animated.View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: isDone ? '100%' : fillW, borderRadius: 12, overflow: 'hidden' }}>
          <LinearGradient colors={['#0B0F22', '#2D3748']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      )}
      {isLoading && (
        <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, width: 60, transform: [{ translateX: shimX }], zIndex: 1 }}>
          <LinearGradient colors={['transparent', 'rgba(255,255,255,0.22)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      )}
      <View style={[btn.dlContent, { zIndex: 2 }]}>
        {isLoading
          ? <Animated.View style={[btn.spinner, { transform: [{ rotate: spin }] }]} />
          : <Ionicons name={isDone ? 'checkmark-circle' : 'download-outline'} size={14} color={(isDone || isLoading) ? '#fff' : T.ink} />
        }
        <Text style={[btn.dlLabel, (!isDone && !isLoading) && { color: T.ink }]}>
          {isDone ? 'Downloaded ✓' : isLoading ? 'Downloading…' : 'Download PDF'}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const btn = StyleSheet.create({
  wrap: {
    height: 46, borderRadius: 12, overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingLeft: 16, paddingRight: 5,
    shadowColor: 'rgba(79,141,255,0.34)', shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 1, shadowRadius: 20, elevation: 6,
  },
  idleContent: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7, paddingRight: 8 },
  label:  { fontSize: 13, fontWeight: '700', color: '#fff', letterSpacing: -0.01 },
  pct:    { fontSize: 13, fontWeight: '800', color: '#fff', letterSpacing: -0.02, minWidth: 36, textAlign: 'right' },
  arrowPill: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center', justifyContent: 'center',
  },
  spinner: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)', borderTopColor: '#fff' },
  dlWrap: {
    height: 46, borderRadius: 12, overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1.5, borderColor: '#CBD5E1', backgroundColor: '#fff',
  },
  dlContent: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 10 },
  dlLabel: { fontSize: 13, fontWeight: '700', color: '#fff', letterSpacing: -0.01 },
});

// ─── Main Screen ──────────────────────────────────────────────────
export default function JobDetailScreen() {
  const router = useRouter();
  const { jobId, jobStr, employerStr } = useLocalSearchParams<{ jobId?: string; jobStr?: string; employerStr?: string }>();

  const [skillsExpanded, setSkillsExpanded] = useState(false);

  // Cover letter states — mirrors HomeScreen GenerateButton + DownloadButton
  const [clState,    setClState]    = useState<'idle'|'loading'|'done'>('idle');
  const [clProgress, setClProgress] = useState(0);
  const [clLabel,    setClLabel]    = useState('Generating cover letter…');
  const clAnim = useRef(new Animated.Value(0)).current;
  const [coverLetterHtml,  setCoverLetterHtml]  = useState<string | null>(null);
  const [companyNameCL,    setCompanyNameCL]    = useState('');
  const [websiteUrlCL,     setWebsiteUrlCL]     = useState('');
  const [companyAddressCL, setCompanyAddressCL] = useState('');

  // Download states
  const [dlState,    setDlState]    = useState<'idle'|'loading'|'done'>('idle');
  const [dlProgress, setDlProgress] = useState(0);
  const dlAnim = useRef(new Animated.Value(0)).current;

  // ── Email compose modal ──
  const [composeVisible, setComposeVisible] = useState(false);
  const [ccExpanded,     setCcExpanded]     = useState(false);
  const [composeTo,      setComposeTo]      = useState('');
  const [composeCc,      setComposeCc]      = useState('');
  const [composeBcc,     setComposeBcc]     = useState('');
  const [composeSubject, setComposeSubject] = useState('');
  const [composeBody,    setComposeBody]    = useState('');
  const [sendState,      setSendState]      = useState<'idle'|'loading'|'done'>('idle');

  // Load CL from DB — triggered after jobId is known (see useEffect below)

  let foundJob: Job | null = null;
  let foundEmployer: Employer | null = null;
  try {
    if (jobStr) foundJob = JSON.parse(jobStr);
    if (employerStr) foundEmployer = JSON.parse(employerStr);
  } catch {}
  if (!foundJob && jobId) {
    for (const emp of MOCK_EMPLOYERS) {
      const j = emp.jobs.find(j => j.id === jobId);
      if (j) { foundJob = j; foundEmployer = emp; break; }
    }
  }

  if (!foundJob || !foundEmployer) {
    return (
      <SafeAreaView style={[s.safeArea, { justifyContent: 'center', alignItems: 'center', gap: 12 }]}>
        <Ionicons name="briefcase-outline" size={48} color={T.textFaint} />
        <Text style={{ fontSize: 18, fontWeight: '700', color: T.ink }}>Job not found</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ backgroundColor: T.blue, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 24 }}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>Go Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const job = foundJob;
  const employer = foundEmployer;
  const allSkills = job.skills || [];
  const SKILLS_LIMIT = 6;
  const visibleSkills = skillsExpanded ? allSkills : allSkills.slice(0, SKILLS_LIMIT);

  // Load existing cover letter from DB on mount
  useEffect(() => {
    if (!job?.id) return;
    loadJobCoverLetter(job.id).then(record => {
      if (!record) return;
      setCoverLetterHtml(record.cover_letter_html);
      setCompanyNameCL(record.company_name || '');
      setWebsiteUrlCL(record.website_url || '');
      setCompanyAddressCL(record.company_address || '');
      setClState('done');
      clAnim.setValue(1);
      if (record.status === 'downloaded') {
        setDlState('done');
        dlAnim.setValue(1);
      }
    });
  }, [job?.id]);

  function animTo(anim: Animated.Value, val: number) {
    Animated.timing(anim, { toValue: val, duration: 350, useNativeDriver: false }).start();
  }

  const handleGenerateCoverLetter = async () => {
    if (clState === 'loading') return;
    setClState('loading'); setClProgress(0); clAnim.setValue(0);

    // Fake progress ticks while polling (mirrors HomeScreen)
    let fake = 0;
    const tick = setInterval(() => {
      if (fake < 80) { fake = Math.min(fake + 1.2, 80); setClProgress(Math.round(fake)); animTo(clAnim, fake / 100); }
    }, 200);

    const stages = ['Analyzing Resume…', 'Researching Company…', 'Writing Cover Letter…', 'Finalising…'];
    let stageIdx = 0;
    const stageTick = setInterval(() => {
      stageIdx = Math.min(stageIdx + 1, stages.length - 1);
      setClLabel(stages[stageIdx]);
    }, 8000);

    try {
      const domain = (employer as any).domain || employer.name;
      const websiteUrl = domain.startsWith('http') ? domain : `https://${domain}`;
      const responsibilities = ((job as any).responsibilities as string[] | undefined) || [];
      const jobId = await startJobCoverLetter(websiteUrl, job.title, responsibilities.length > 0 ? responsibilities : undefined);
      const result = await pollJobCoverLetter(jobId, () => {
        if (fake < 75) { fake = Math.min(fake + 3, 75); setClProgress(Math.round(fake)); animTo(clAnim, fake / 100); }
      });

      clearInterval(tick); clearInterval(stageTick);
      setClProgress(100); animTo(clAnim, 1);
      const html     = result.coverLetterHtml || '';
      const cName    = result.companyName || employer.name;
      const webUrl   = domain.startsWith('http') ? domain : `https://${domain}`;
      // Extract address from locations (same logic as ReviewScreen/HomeScreen)
      const locs = (result as any).locations as Array<{ address: string; city: string; country: string; isHeadquarters: boolean }> | undefined;
      const hq   = locs?.find(l => l.isHeadquarters) || locs?.[0];
      const addr = hq
        ? [hq.address, hq.city, hq.country].filter(Boolean).join(', ')
        : '';
      setCoverLetterHtml(html);
      setCompanyNameCL(cName);
      setWebsiteUrlCL(webUrl);
      setCompanyAddressCL(addr);
      setTimeout(() => setClState('done'), 300);
      // Persist to DB (non-blocking)
      saveJobCoverLetter(job.id, { coverLetterHtml: html, companyName: cName, websiteUrl: webUrl, position: job.title, companyAddress: addr });
    } catch (e: any) {
      clearInterval(tick); clearInterval(stageTick);
      setClState('idle');
      const msg = e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message ?? 'Failed to generate. Please try again.';
      Alert.alert('Error', msg);
    }
  };

  const handleDownloadPdf = async () => {
    if (dlState === 'loading' || !coverLetterHtml) return;
    setDlState('loading'); setDlProgress(0); dlAnim.setValue(0);

    let fake = 0;
    const tick = setInterval(() => {
      if (fake < 80) { fake = Math.min(fake + 1.5, 80); setDlProgress(Math.round(fake)); animTo(dlAnim, fake / 100); }
    }, 150);

    try {
      const token = await getToken();
      const hdrs: Record<string, string> = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      const res = await fetch(`${API_BASE}/generate-cover-letter-pdf`, {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({ coverLetterHtml, companyName: companyNameCL, companyAddress: companyAddressCL }),
      });

      let downloadUrl: string | null = null;
      if (res.status === 202) {
        const { jobId } = await res.json();
        // Poll for PDF job completion
        await new Promise<void>((resolve, reject) => {
          const pollPdf = async () => {
            try {
              const { data: d } = await (await import('axios')).default.get(`${API_BASE}/job-status/${jobId}`, { headers: hdrs });
              if (d.status === 'completed') { downloadUrl = (d.data || d.result || d)?.downloadUrl; resolve(); }
              else if (d.status === 'failed') reject(new Error(d.error || 'PDF generation failed'));
              else setTimeout(pollPdf, 2000);
            } catch { setTimeout(pollPdf, 2000); }
          };
          pollPdf();
        });
      } else if (res.ok) {
        downloadUrl = (await res.json())?.downloadUrl;
      } else {
        throw new Error(`Server error ${res.status}`);
      }

      if (!downloadUrl) throw new Error('No download URL from server');

      clearInterval(tick);
      setDlProgress(88); animTo(dlAnim, 0.88);
      const cleanUrl = downloadUrl.replace(/^\/api/, '');
      const fullUrl = `${API_BASE}${cleanUrl}`;
      const fileName = `${employer.name.replace(/[^a-zA-Z0-9]/g, '_')}_Cover_Letter.pdf`;
      const fileUri = (cacheDirectory || '') + fileName;
      const result = await downloadAsync(fullUrl, fileUri, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (result.status !== 200) throw new Error(`Download HTTP ${result.status}`);
      setDlProgress(100); animTo(dlAnim, 1);
      setTimeout(() => setDlState('done'), 300);
      updateJobCLStatus(job.id, 'downloaded');
      if (await Sharing.isAvailableAsync()) { await Sharing.shareAsync(result.uri); }
    } catch (e: any) {
      clearInterval(tick);
      setDlState('idle');
      Alert.alert('Download failed', e.message || 'Could not save PDF. Please try again.');
    }
  };

  // ── Open compose modal: pre-fill all fields, auto-generate CL if missing ──
  const openComposeModal = async () => {
    // Contacts → To field
    const contactEmails = (job.contacts || []).map(c => c.email).filter(Boolean).join(', ');
    setComposeTo(contactEmails);
    setComposeCc('');
    setComposeBcc('');
    setCcExpanded(false);

    const cName  = companyNameCL || employer.name;
    const domain = (employer as any).domain || employer.name;
    const webUrl = websiteUrlCL || (domain.startsWith('http') ? domain : `https://${domain}`);

    // Subject — same formula as emailController
    const token = await getToken();
    let fullName = 'Applicant';
    try {
      const raw = await SecureStore.getItemAsync('userSession');
      fullName = JSON.parse(raw || '{}')?.fullName || JSON.parse(raw || '{}')?.full_name || fullName;
    } catch {}
    setComposeSubject(`Application for ${job.title} - ${fullName}`);

    // Body — call backend generateEmailBody equivalent via API
    setComposeBody('Loading email body…');
    try {
      const hdrs: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      const r = await fetch(`${API_BASE}/ai-hub/generate-email-body`, {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({ position: job.title, companyName: cName }),
      });
      if (r.ok) {
        const { body } = await r.json();
        setComposeBody(body || '');
      } else {
        setComposeBody(
          `Dear Hiring Manager,\n\nI am excited to submit my application for the ${job.title} role at ${cName}. Please find my resume and cover letter attached for your consideration.\n\nI would love the opportunity to discuss how my background aligns with your team's needs.\n\nBest regards,\n${fullName}`
        );
      }
    } catch {
      setComposeBody(
        `Dear Hiring Manager,\n\nI am excited to submit my application for the ${job.title} role at ${cName}. Please find my resume and cover letter attached for your consideration.\n\nI would love the opportunity to discuss how my background aligns with your team's needs.\n\nBest regards,\n${fullName}`
      );
    }

    // If CL not generated yet — generate it first, then open modal
    if (!coverLetterHtml) {
      Alert.alert(
        'No Cover Letter',
        'Your cover letter hasn\'t been generated yet. Generate it first, then tap Apply Now.',
        [{ text: 'OK' }]
      );
      return;
    }

    setSendState('idle');
    setComposeVisible(true);
  };

  // ── Poll for async job completion ──
  function pollJob(
    jobId: string,
    token: string | null,
    onDone: (data: any) => void,
    onFail: (msg: string) => void,
  ) {
    const poll = async () => {
      try {
        const hdrs: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        const { default: ax } = await import('axios');
        const { data } = await ax.get(`${API_BASE}/job-status/${jobId}`, { headers: hdrs });
        if (data.status === 'completed') onDone(data.data ?? data.result ?? data);
        else if (data.status === 'failed') onFail(data.error || 'Send failed');
        else setTimeout(poll, 2000);
      } catch { setTimeout(poll, 2000); }
    };
    poll();
  }

  // ── Send the email via the same /send-single-application endpoint ──
  const handleSendEmail = async () => {
    if (sendState === 'loading' || sendState === 'done') return;
    if (!composeTo.trim()) {
      Alert.alert('No recipient', 'Please enter a To email address.');
      return;
    }
    if (!coverLetterHtml) {
      Alert.alert('No cover letter', 'Please generate a cover letter first.');
      return;
    }
    setSendState('loading');

    try {
      const token = await getToken();
      const hdrs: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      const cName  = companyNameCL || employer.name;
      const domain = (employer as any).domain || employer.name;
      const webUrl = websiteUrlCL || (domain.startsWith('http') ? domain : `https://${domain}`);

      // Send to first To address (primary contact); cc addresses sent separately if needed
      const primaryEmail = composeTo.split(',')[0].trim();

      const res = await fetch(`${API_BASE}/send-single-application`, {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({
          recipientEmail: primaryEmail,
          websiteUrl: webUrl,
          position: job.title,
          coverLetterText: coverLetterHtml,
          companyName: cName,
          companyAddress: companyAddressCL,
        }),
      });

      const finish = (success: boolean, errMsg?: string) => {
        if (success) {
          setSendState('done');
          updateJobCLStatus(job.id, 'applied');
          setTimeout(() => {
            setComposeVisible(false);
            setTimeout(() => setSendState('idle'), 400);
          }, 1200);
          Alert.alert('Sent! 🎉', `Your application has been sent to ${cName}.`);
        } else {
          setSendState('idle');
          Alert.alert('Send failed', errMsg || 'Could not send. Please try again.');
        }
      };

      if (res.status === 202) {
        const { jobId } = await res.json();
        pollJob(jobId, token,
          (d) => finish(!d || d.success === false ? false : true, d?.error),
          (msg) => finish(false, msg),
        );
      } else if (res.ok) {
        finish(true);
      } else {
        const err = await res.json().catch(() => ({}));
        finish(false, err.message || err.error || `Server error ${res.status}`);
      }
    } catch (e: any) {
      setSendState('idle');
      Alert.alert('Send failed', 'Network error. Please check your connection.');
    }
  };

  const handleEdit = async () => {
    if (!coverLetterHtml) return;
    try {
      // Bridge to HomeScreen: add a new recipient with this job's details pre-filled
      // and store the cover letter in AsyncStorage in the exact format HomeScreen reads
      const websiteUrl = websiteUrlCL || ((employer as any).domain
        ? `https://${(employer as any).domain}`
        : '');
      await AsyncStorage.setItem('aiHub_add_recipient_with_cl', JSON.stringify({
        website: websiteUrl,
        position: job.title,
        coverLetterHtml,
        companyName: companyNameCL || employer.name,
      }));
      // Tell App.js to switch to the HomeScreen/Letters tab
      await AsyncStorage.setItem('aiHub_navigate_home', 'true');
      // Switch the bottom tab to Home so the user lands on the Letters page
      router.replace('/(tabs)');
    } catch {}
  };

  return (
    <SafeAreaView style={s.safeArea} edges={['top']}>
      {/* Top bar — matches jobs dashboard exactly */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={s.backPill} activeOpacity={0.8}>
          <Ionicons name="arrow-back" size={14} color={T.ink} />
          <Text style={s.backPillText}>Back</Text>
        </TouchableOpacity>

        {/* Absolutely centred logo + wordmark */}
        <View style={s.wordmark} pointerEvents="none">
          <Image
            source={require('../../assets/images/logo_img.png')}
            style={s.wordmarkLogo}
            resizeMode="contain"
          />
          <Text style={s.wordmarkText}>cv<Text style={s.wordmarkBlue}>applyr</Text></Text>
        </View>

        {!!(job as any).applyUrl ? (
          <TouchableOpacity onPress={() => Linking.openURL((job as any).applyUrl)} style={s.viewBtn} activeOpacity={0.8}>
            <Ionicons name="open-outline" size={14} color={T.blue} />
            <Text style={s.viewBtnText}>View</Text>
          </TouchableOpacity>
        ) : (
          <View style={{ width: 60 }} />
        )}
      </View>

      <ScrollView style={s.scroll} showsVerticalScrollIndicator={false} contentContainerStyle={s.scrollContent}>

        {/* ── Card 1: Job Header (dark) ── */}
        <View style={s.heroCard}>
          {/* Watermark — lightly visible grey */}
          <Text style={s.watermark} numberOfLines={1} ellipsizeMode="clip">
            {employer.name.toUpperCase()}
          </Text>

          <View style={s.heroTop}>
            <LinearGradient colors={employer.logoColor} style={s.logoBox}>
              <Text style={s.logoInitial}>{employer.logoInitial}</Text>
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <Text style={s.employerName}>{employer.name}</Text>
              {!!employer.subInfo && <Text style={s.employerSub}>{employer.subInfo}</Text>}
            </View>
            {job.urgent && (
              <View style={s.urgentBadge}>
                <Ionicons name="flash" size={10} color="#FF4E64" />
                <Text style={s.urgentText}>Urgent</Text>
              </View>
            )}
          </View>

          <Text style={s.jobTitle}>{job.title}</Text>

          {/* Meta chips — dark style */}
          <View style={s.metaRow}>
            {!!job.location && (
              <View style={s.metaChip}>
                <Ionicons name="location-outline" size={11} color="#06B6D4" />
                <Text style={s.metaChipText}>{job.location}</Text>
              </View>
            )}
            {!!(job as any).experience && (
              <View style={s.metaChip}>
                <Ionicons name="time-outline" size={11} color="#A78BFA" />
                <Text style={s.metaChipText}>{(job as any).experience}</Text>
              </View>
            )}
            {!!job.salary && job.salary !== 'Not listed' && (
              <View style={s.metaChip}>
                <Ionicons name="cash-outline" size={11} color="#34D399" />
                <Text style={s.metaChipText}>{job.salary}</Text>
              </View>
            )}
            {!!job.jobType && (
              <View style={s.metaChip}>
                <Ionicons name="briefcase-outline" size={11} color="#FB923C" />
                <Text style={s.metaChipText}>{job.jobType}</Text>
              </View>
            )}
          </View>
        </View>

        {/* ── Card 2: Contacts + Cover Letter (merged) ── */}
        <View style={s.card}>
          {/* Hiring Contacts */}
          <Text style={s.sectionLabel}>HIRING CONTACTS</Text>
          {job.contacts.length > 0
            ? job.contacts.map(c => <ContactRow key={c.id} contact={c} />)
            : <Text style={s.noContacts}>No contact details found for this listing</Text>
          }
          <TouchableOpacity
            onPress={() => router.push({ pathname: '/(ai-hub)/add-contact', params: { jobId: job.id } })}
            style={s.addContactBtn}
          >
            <Ionicons name="person-add-outline" size={13} color={T.textMuted} />
            <Text style={s.addContactBtnText}>Add Contact</Text>
          </TouchableOpacity>

          {/* Divider */}
          <View style={s.divider} />

          {/* ── Generate Cover Letter — exact same button as Home page ── */}
          <GenerateCLButton
            state={clState}
            progress={clProgress}
            progressAnim={clAnim}
            label={clLabel}
            onPress={handleGenerateCoverLetter}
          />

          {/* ── After generation: Download PDF + Edit ── */}
          {clState === 'done' && (
            <View style={s.clDoneRow}>
              <DownloadCLButton
                state={dlState}
                progress={dlProgress}
                progressAnim={dlAnim}
                onPress={handleDownloadPdf}
              />
              <TouchableOpacity style={s.editBtn} onPress={handleEdit} activeOpacity={0.8}>
                <Ionicons name="create-outline" size={14} color={T.blue} />
                <Text style={s.editBtnText}>Edit</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* ── Card 3: Skills ── */}
        {allSkills.length > 0 && (
          <View style={s.card}>
            <Text style={s.sectionLabel}>REQUIRED SKILLS</Text>
            <View style={s.skillsRow}>
              {visibleSkills.map((skill, i) => (
                <View key={i} style={s.skillChip}>
                  <Text style={s.skillChipText}>{skill}</Text>
                </View>
              ))}
              {!skillsExpanded && allSkills.length > SKILLS_LIMIT && (
                <TouchableOpacity onPress={() => setSkillsExpanded(true)} style={s.skillMore} activeOpacity={0.75}>
                  <Text style={s.skillMoreText}>+{allSkills.length - SKILLS_LIMIT} more</Text>
                </TouchableOpacity>
              )}
              {skillsExpanded && allSkills.length > SKILLS_LIMIT && (
                <TouchableOpacity onPress={() => setSkillsExpanded(false)} style={s.skillMore} activeOpacity={0.75}>
                  <Ionicons name="chevron-up" size={11} color={T.textMuted} />
                  <Text style={s.skillMoreText}>Less</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* ── Card 4: Responsibilities ── */}
        {((job as any).responsibilities?.length > 0) && (
          <View style={s.card}>
            <Text style={s.sectionLabel}>RESPONSIBILITIES</Text>
            {((job as any).responsibilities as string[]).map((item, i) => (
              <View key={i} style={s.respRow}>
                <View style={s.respDot} />
                <Text style={s.respText}>{item}</Text>
              </View>
            ))}
          </View>
        )}


      </ScrollView>

      {/* ── Sticky Footer ── */}
      <View style={s.footer}>
        <TouchableOpacity activeOpacity={0.85} style={[s.applyOuter, { flex: 1 }]} onPress={openComposeModal}>
          <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.applyBtn}>
            <Ionicons name="send-outline" size={15} color="white" />
            <Text style={s.applyBtnText}>Apply Now</Text>
          </LinearGradient>
        </TouchableOpacity>
      </View>

      {/* ── Email Compose Modal ── */}
      <Modal
        visible={composeVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setComposeVisible(false)}
      >
        <KeyboardAvoidingView
          style={s.modalOverlay}
          behavior={Platform.select({ ios: 'padding', android: undefined })}
        >
          <View style={s.modalSheet}>
            {/* Handle bar */}
            <View style={s.modalHandle} />

            {/* Header */}
            <View style={s.modalHeader}>
              <View>
                <Text style={s.modalTitle}>New Application</Text>
                <Text style={s.modalSubtitle}>{companyNameCL || employer.name}</Text>
              </View>
              <TouchableOpacity onPress={() => setComposeVisible(false)} style={s.modalCloseBtn} activeOpacity={0.7}>
                <Ionicons name="close" size={18} color={T.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView style={s.modalScroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

              {/* To */}
              <View style={s.fieldRow}>
                <Text style={s.fieldLabel}>To</Text>
                <TextInput
                  style={s.fieldInput}
                  value={composeTo}
                  onChangeText={setComposeTo}
                  placeholder="Recipient email(s)"
                  placeholderTextColor={T.textFaint}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  multiline
                />
              </View>

              {/* Cc/Bcc toggle */}
              <TouchableOpacity style={s.ccToggle} onPress={() => setCcExpanded(v => !v)} activeOpacity={0.7}>
                <Text style={s.ccToggleText}>{ccExpanded ? '▴ Hide Cc / Bcc' : '▾ Add Cc / Bcc'}</Text>
              </TouchableOpacity>

              {ccExpanded && (
                <>
                  <View style={s.fieldRow}>
                    <Text style={s.fieldLabel}>Cc</Text>
                    <TextInput
                      style={s.fieldInput}
                      value={composeCc}
                      onChangeText={setComposeCc}
                      placeholder="Cc email(s)"
                      placeholderTextColor={T.textFaint}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      multiline
                    />
                  </View>
                  <View style={s.fieldRow}>
                    <Text style={s.fieldLabel}>Bcc</Text>
                    <TextInput
                      style={s.fieldInput}
                      value={composeBcc}
                      onChangeText={setComposeBcc}
                      placeholder="Bcc email(s)"
                      placeholderTextColor={T.textFaint}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      multiline
                    />
                  </View>
                </>
              )}

              {/* Subject */}
              <View style={s.fieldRow}>
                <Text style={s.fieldLabel}>Subject</Text>
                <TextInput
                  style={s.fieldInput}
                  value={composeSubject}
                  onChangeText={setComposeSubject}
                  placeholder="Email subject"
                  placeholderTextColor={T.textFaint}
                />
              </View>

              {/* Attachment pill */}
              <View style={s.fieldRow}>
                <Text style={s.fieldLabel}>Attach</Text>
                <View style={s.attachPill}>
                  <Ionicons name="document-text-outline" size={14} color={T.blue} />
                  <Text style={s.attachPillText} numberOfLines={1}>
                    {(companyNameCL || employer.name).replace(/[^a-zA-Z0-9 ]/g, '')}_Cover_Letter.pdf
                  </Text>
                  <View style={s.attachCheck}>
                    <Ionicons name="checkmark-circle" size={13} color={T.emerald} />
                  </View>
                </View>
              </View>

              {/* Body */}
              <View style={s.bodyField}>
                <TextInput
                  style={s.bodyInput}
                  value={composeBody}
                  onChangeText={setComposeBody}
                  multiline
                  textAlignVertical="top"
                  placeholder="Email body…"
                  placeholderTextColor={T.textFaint}
                />
              </View>

            </ScrollView>

            {/* Action buttons */}
            <View style={s.modalFooter}>
              <TouchableOpacity style={s.cancelBtn} onPress={() => setComposeVisible(false)} activeOpacity={0.7}>
                <Text style={s.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[s.sendOuter, sendState === 'done' && s.sendOuterDone]}
                onPress={handleSendEmail}
                activeOpacity={0.85}
                disabled={sendState === 'loading' || sendState === 'done'}
              >
                <LinearGradient
                  colors={sendState === 'done' ? ['#10B981', '#059669'] : [T.blue, T.blueDeep]}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  style={s.sendBtn}
                >
                  {sendState === 'loading' ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : sendState === 'done' ? (
                    <>
                      <Ionicons name="checkmark-circle" size={16} color="#fff" />
                      <Text style={s.sendBtnText}>Sent!</Text>
                    </>
                  ) : (
                    <>
                      <Ionicons name="send" size={14} color="#fff" />
                      <Text style={s.sendBtnText}>Send Application</Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            </View>

          </View>
        </KeyboardAvoidingView>
      </Modal>

    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────
const s = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: T.bg },

  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: T.bg,
  },
  backPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: T.surface, borderRadius: 20,
    paddingVertical: 7, paddingHorizontal: 12,
    shadowColor: T.ink, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07, shadowRadius: 8, elevation: 3,
    zIndex: 1,
  },
  backPillText: { fontSize: 13, fontWeight: '600', color: T.ink },
  wordmark: {
    position: 'absolute', left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    zIndex: 0,
  },
  wordmarkLogo: { width: 22, height: 22 },
  wordmarkText: { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  wordmarkBlue: { color: T.blue },
  viewBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: T.surface, borderRadius: 20,
    paddingVertical: 7, paddingHorizontal: 12,
    shadowColor: T.ink, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07, shadowRadius: 8, elevation: 3,
    zIndex: 1,
  },
  viewBtnText: { fontSize: 13, fontWeight: '600', color: T.blue },

  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 100, gap: 12 },

  // White card (skills, responsibilities)
  card: {
    backgroundColor: T.surface, borderRadius: 22,
    padding: 16, overflow: 'hidden',
    shadowColor: T.ink, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.07, shadowRadius: 16, elevation: 4,
  },

  // Dark hero card (matches other pages)
  heroCard: {
    backgroundColor: '#0B1120', borderRadius: 22,
    padding: 18, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2, shadowRadius: 20, elevation: 8,
  },
  watermark: {
    position: 'absolute', top: '30%', left: '20%', right: -20,
    fontSize: 80, fontWeight: '900',
    color: 'rgba(255,255,255,0.04)',   // light grey on dark bg
    letterSpacing: -3, zIndex: 0,
  },

  // Hero layout
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  logoBox: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  logoInitial: { fontSize: 18, fontWeight: '800', color: '#fff' },
  employerName: { fontSize: 15, fontWeight: '700', color: '#fff' },
  employerSub: { fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 2 },
  jobTitle: { fontSize: 20, fontWeight: '800', color: '#fff', letterSpacing: -0.5, lineHeight: 26, marginBottom: 14 },
  urgentBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: 'rgba(255,78,100,0.2)', borderWidth: 1, borderColor: 'rgba(255,78,100,0.4)',
    borderRadius: 10, paddingVertical: 4, paddingHorizontal: 8, flexShrink: 0,
  },
  urgentText: { fontSize: 10, fontWeight: '700', color: '#FF4E64' },

  // Meta chips — dark style
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  metaChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 20, paddingVertical: 4, paddingHorizontal: 9,
  },
  metaChipText: { fontSize: 11, fontWeight: '600', color: 'rgba(255,255,255,0.75)' },

  // Divider inside merged card
  divider: { height: 1, backgroundColor: T.border, marginVertical: 16 },

  // Cover letter card
  // Cover letter row after generation
  clDoneRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  editBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 10, paddingHorizontal: 14,
    backgroundColor: 'rgba(79,141,255,0.08)', borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)',
  },
  editBtnText: { fontSize: 13, fontWeight: '700', color: T.blue },

  // Section label
  sectionLabel: { fontSize: 10, fontWeight: '800', color: T.textFaint, letterSpacing: 1.2, marginBottom: 10 },

  // Skills
  skillsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  skillChip: { backgroundColor: 'rgba(79,141,255,0.08)', borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  skillChipText: { fontSize: 11, fontWeight: '600', color: T.blue },
  skillMore: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(79,141,255,0.1)', borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  skillMoreText: { fontSize: 11, fontWeight: '700', color: T.blue },

  // Responsibilities
  respRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  respDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: T.blue, marginTop: 6, flexShrink: 0 },
  respText: { fontSize: 13, color: T.inkSoft, lineHeight: 20, flex: 1 },

  // Contacts
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 12, fontWeight: '700', color: '#fff' },
  contactName: { fontSize: 13, fontWeight: '700', color: T.ink },
  contactRole: { fontSize: 11, color: T.textFaint, marginTop: 1 },
  contactEmail: {
    fontSize: 11, color: T.blue, marginTop: 2,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  verifiedBadge: { marginLeft: 4 },
  noContacts: { fontSize: 12, color: T.textFaint, fontStyle: 'italic', marginBottom: 8 },
  addContactBtn: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    backgroundColor: T.bg, borderWidth: 1, borderColor: T.borderHi,
    borderRadius: 10, paddingVertical: 7, paddingHorizontal: 12, gap: 5, marginTop: 4,
  },
  addContactBtnText: { fontSize: 12, color: T.textMuted, fontWeight: '600' },

  // Footer
  footer: {
    backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.border,
    padding: 16, paddingBottom: Platform.select({ ios: 28, default: 16 }),
    flexDirection: 'row', gap: 10,
  },
  applyOuter: { borderRadius: 14, overflow: 'hidden' },
  applyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 14 },
  applyBtnText: { fontSize: 15, fontWeight: '800', color: '#fff' },

  // ── Email Compose Modal ──
  modalOverlay: {
    flex: 1, justifyContent: 'flex-end',
    backgroundColor: 'rgba(11,15,34,0.55)',
  },
  modalSheet: {
    backgroundColor: T.surface,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingBottom: Platform.select({ ios: 34, default: 20 }),
    maxHeight: '92%',
    shadowColor: '#000', shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.18, shadowRadius: 24, elevation: 20,
  },
  modalHandle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: T.border, alignSelf: 'center', marginTop: 10, marginBottom: 4,
  },
  modalHeader: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: T.border,
  },
  modalTitle: { fontSize: 17, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  modalSubtitle: { fontSize: 12, color: T.textMuted, marginTop: 2, fontWeight: '600' },
  modalCloseBtn: {
    backgroundColor: T.bg, borderRadius: 16, width: 32, height: 32,
    alignItems: 'center', justifyContent: 'center',
  },
  modalScroll: { paddingHorizontal: 20 },

  // Fields
  fieldRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    borderBottomWidth: 1, borderBottomColor: T.border,
    paddingVertical: 10, gap: 10,
  },
  fieldLabel: {
    width: 52, fontSize: 12, fontWeight: '700',
    color: T.textMuted, paddingTop: 3,
  },
  fieldInput: {
    flex: 1, fontSize: 13, color: T.ink, fontWeight: '500',
    paddingTop: 0, paddingBottom: 0,
  },

  ccToggle: { paddingVertical: 8 },
  ccToggleText: { fontSize: 11, fontWeight: '700', color: T.blue },

  // Attachment pill
  attachPill: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(79,141,255,0.07)',
    borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)',
    borderRadius: 10, paddingVertical: 5, paddingHorizontal: 9,
  },
  attachPillText: { flex: 1, fontSize: 12, fontWeight: '600', color: T.blue },
  attachCheck: { marginLeft: 2 },

  // Body
  bodyField: {
    marginTop: 10, marginBottom: 12,
    backgroundColor: T.bg, borderRadius: 14,
    borderWidth: 1, borderColor: T.border,
    padding: 12, minHeight: 180,
  },
  bodyInput: {
    fontSize: 13, color: T.ink, lineHeight: 20,
    fontWeight: '400', minHeight: 160,
  },

  // Modal footer buttons
  modalFooter: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: 20, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: T.border,
  },
  cancelBtn: {
    flex: 1, height: 48, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: T.bg, borderWidth: 1, borderColor: T.borderHi,
  },
  cancelBtnText: { fontSize: 14, fontWeight: '700', color: T.textMuted },
  sendOuter: { flex: 2, borderRadius: 14, overflow: 'hidden' },
  sendOuterDone: {},
  sendBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 7, height: 48, borderRadius: 14,
  },
  sendBtnText: { fontSize: 14, fontWeight: '800', color: '#fff' },
});
