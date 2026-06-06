// Resume Builder — new feature. Safe to delete without affecting existing app.
import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Platform, Alert, Image, KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../../config';

const T = {
  bg: '#E5EAF3', bgSoft: '#F0F4FA', surface: '#FFFFFF',
  ink: '#0B0F22', muted: '#5A6480', faint: '#8A93B2',
  border: 'rgba(11,15,34,0.07)', blue: '#4F8DFF', blueDeep: '#2563EB',
  cyan: '#06B6D4', emerald: '#10B981', rose: '#EF4444',
};

const STEPS = ['Contact', 'Experience', 'Education', 'Projects', 'Skills'];

type Exp = { company: string; role: string; location: string; start_date: string; end_date: string; highlights: string };
type Edu = { institution: string; degree: string; field_of_study: string; end_date: string };
type Proj = { title: string; link: string; description: string };

export default function ManualBuilder() {
  const router = useRouter();
  const [step, setStep] = useState(0);

  // Step 0 — Contact
  const [fullName,   setFullName]   = useState('');
  const [email,      setEmail]      = useState('');
  const [phone,      setPhone]      = useState('');
  const [location,   setLocation]   = useState('');
  const [linkedin,   setLinkedin]   = useState('');
  const [portfolio,  setPortfolio]  = useState('');
  const [summary,    setSummary]    = useState('');

  // Step 1 — Experience
  const [exps, setExps] = useState<Exp[]>([{ company: '', role: '', location: '', start_date: '', end_date: '', highlights: '' }]);

  // Step 2 — Education
  const [edus, setEdus] = useState<Edu[]>([{ institution: '', degree: '', field_of_study: '', end_date: '' }]);

  // Step 3 — Projects
  const [projs, setProjs] = useState<Proj[]>([{ title: '', link: '', description: '' }]);

  // Step 4 — Skills
  const [techSkills, setTechSkills] = useState('');
  const [softSkills, setSoftSkills] = useState('');

  const [saving, setSaving] = useState(false);

  // Pre-fill from existing saved resume when editing
  useEffect(() => {
    (async () => {
      try {
        const raw = await SecureStore.getItemAsync('userSession');
        const token = JSON.parse(raw || '{}')?.token;
        let resumeData: any = null;
        if (token) {
          const res = await fetch(`${API_BASE}/resume-builder`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            const json = await res.json();
            resumeData = json.resumeData;
          }
        }
        if (!resumeData) {
          const cached = await AsyncStorage.getItem('resumeBuilderData');
          if (cached) resumeData = JSON.parse(cached);
        }
        if (!resumeData) return;
        const pi = resumeData.personal_info || {};
        if (pi.full_name)   setFullName(pi.full_name);
        if (pi.email)       setEmail(pi.email);
        if (pi.phone)       setPhone(pi.phone);
        if (pi.location)    setLocation(pi.location);
        if (pi.linkedin_url)  setLinkedin(pi.linkedin_url);
        if (pi.portfolio_url) setPortfolio(pi.portfolio_url);
        if (resumeData.summary) setSummary(resumeData.summary);
        if (resumeData.experience?.length) {
          setExps(resumeData.experience.map((e: any) => ({
            ...e,
            highlights: Array.isArray(e.highlights) ? e.highlights.join('\n') : (e.highlights || ''),
          })));
        }
        if (resumeData.education?.length)  setEdus(resumeData.education);
        if (resumeData.projects?.length)   setProjs(resumeData.projects);
        if (resumeData.skills?.technical?.length) setTechSkills(resumeData.skills.technical.join(', '));
        if (resumeData.skills?.soft?.length)      setSoftSkills(resumeData.skills.soft.join(', '));
      } catch {}
    })();
  }, []);

  function addExp()  { setExps(prev  => [...prev,  { company: '', role: '', location: '', start_date: '', end_date: '', highlights: '' }]); }
  function addEdu()  { setEdus(prev  => [...prev,  { institution: '', degree: '', field_of_study: '', end_date: '' }]); }
  function addProj() { setProjs(prev => [...prev,  { title: '', link: '', description: '' }]); }
  function removeExp(i: number)  { setExps(prev  => prev.filter((_, idx) => idx !== i)); }
  function removeEdu(i: number)  { setEdus(prev  => prev.filter((_, idx) => idx !== i)); }
  function removeProj(i: number) { setProjs(prev => prev.filter((_, idx) => idx !== i)); }

  async function handleFinish() {
    setSaving(true);
    try {
      const resumeData = {
        _buildMethod: 'manual',
        personal_info: { full_name: fullName, email, phone, location, linkedin_url: linkedin, portfolio_url: portfolio },
        summary,
        experience: exps.map(e => ({ ...e, highlights: e.highlights.split('\n').map(l => l.replace(/^[-•]\s*/, '')).filter(Boolean) })),
        education: edus,
        projects: projs,
        skills: {
          technical: techSkills.split(',').map(s => s.trim()).filter(Boolean),
          soft:      softSkills.split(',').map(s => s.trim()).filter(Boolean),
        },
      };

      const raw = await SecureStore.getItemAsync('userSession');
      const token = JSON.parse(raw || '{}')?.token;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;

      await fetch(`${API_BASE}/resume-builder/save`, {
        method: 'POST', headers,
        body: JSON.stringify({ resumeData }),
      });
      await AsyncStorage.setItem('resumeBuilderData', JSON.stringify(resumeData));
      await AsyncStorage.setItem('resumeBuilderMethod', 'manual').catch(() => {});
      router.replace('/(resume-builder)/preview');
    } catch (e: any) {
      Alert.alert('Save failed', e.message);
    } finally {
      setSaving(false);
    }
  }

  function renderStep() {
    switch (step) {
      // ── Contact ──────────────────────────────────────────────────────────────
      case 0: return (
        <View style={s.stepContent}>
          <Text style={s.sectionLabel}>CONTACT INFORMATION</Text>
          {([
            ['Full Name *',      fullName,  setFullName,  'John Smith',           'default',       'words'],
            ['Email *',          email,     setEmail,     'john@example.com',     'email-address', 'none'],
            ['Phone',            phone,     setPhone,     '+1 (555) 000-0000',    'phone-pad',     'none'],
            ['Location',         location,  setLocation,  'New York, USA',        'default',       'words'],
            ['LinkedIn URL',     linkedin,  setLinkedin,  'linkedin.com/in/you',  'url',           'none'],
            ['Portfolio / GitHub', portfolio, setPortfolio, 'github.com/you',     'url',           'none'],
          ] as const).map(([label, val, setter, ph, kb, cap]) => (
            <View key={label} style={s.inputWrap}>
              <Text style={s.inputLabel}>{label}</Text>
              <TextInput style={s.input} value={val} onChangeText={setter as any} placeholder={ph} placeholderTextColor={T.faint} keyboardType={kb as any} autoCapitalize={cap as any} />
            </View>
          ))}
          <View style={s.inputWrap}>
            <Text style={s.inputLabel}>Professional Summary</Text>
            <TextInput style={[s.input, s.multiInput]} value={summary} onChangeText={setSummary} placeholder="2-3 sentences about your career, expertise, and goals…" placeholderTextColor={T.faint} multiline textAlignVertical="top" />
          </View>
        </View>
      );

      // ── Experience ───────────────────────────────────────────────────────────
      case 1: return (
        <View style={s.stepContent}>
          <Text style={s.sectionLabel}>WORK EXPERIENCE</Text>
          {exps.map((e, i) => (
            <View key={i} style={s.subCard}>
              <View style={s.subCardHeader}>
                <Text style={s.subCardTitle}>Position {i + 1}</Text>
                {exps.length > 1 && (
                  <TouchableOpacity onPress={() => removeExp(i)} style={s.removeBtn}>
                    <Ionicons name="trash-outline" size={14} color={T.rose} />
                  </TouchableOpacity>
                )}
              </View>
              {(['company','role','location','start_date','end_date'] as const).map(key => (
                <View key={key} style={s.inputWrap}>
                  <Text style={s.inputLabel}>{key.replace('_',' ').replace(/^\w/,c=>c.toUpperCase())}</Text>
                  <TextInput style={s.input} value={e[key]} onChangeText={v => setExps(prev => prev.map((x,idx) => idx===i ? {...x,[key]:v} : x))} placeholder={key==='end_date'?'Present or Month YYYY':'Month YYYY'} placeholderTextColor={T.faint} />
                </View>
              ))}
              <View style={s.inputWrap}>
                <Text style={s.inputLabel}>Key Achievements (one per line, start with •)</Text>
                <TextInput style={[s.input, s.multiInput]} value={e.highlights} onChangeText={v => setExps(prev => prev.map((x,idx) => idx===i ? {...x,highlights:v} : x))} placeholder="• Led a team of 5 engineers to deliver a payment feature 2 weeks early&#10;• Reduced API latency by 40% through caching" placeholderTextColor={T.faint} multiline textAlignVertical="top" />
              </View>
            </View>
          ))}
          <TouchableOpacity style={s.addBtn} onPress={addExp} activeOpacity={0.8}>
            <Ionicons name="add-circle-outline" size={16} color={T.blue} />
            <Text style={s.addBtnText}>Add Another Position</Text>
          </TouchableOpacity>
        </View>
      );

      // ── Education ────────────────────────────────────────────────────────────
      case 2: return (
        <View style={s.stepContent}>
          <Text style={s.sectionLabel}>EDUCATION</Text>
          {edus.map((e, i) => (
            <View key={i} style={s.subCard}>
              <View style={s.subCardHeader}>
                <Text style={s.subCardTitle}>Degree {i + 1}</Text>
                {edus.length > 1 && (
                  <TouchableOpacity onPress={() => removeEdu(i)} style={s.removeBtn}>
                    <Ionicons name="trash-outline" size={14} color={T.rose} />
                  </TouchableOpacity>
                )}
              </View>
              {(['institution','degree','field_of_study','end_date'] as const).map(key => (
                <View key={key} style={s.inputWrap}>
                  <Text style={s.inputLabel}>{key.replace(/_/g,' ').replace(/^\w/,c=>c.toUpperCase())}</Text>
                  <TextInput style={s.input} value={e[key]} onChangeText={v => setEdus(prev => prev.map((x,idx) => idx===i ? {...x,[key]:v} : x))} placeholder={key==='end_date'?'Year e.g. 2021':''} placeholderTextColor={T.faint} />
                </View>
              ))}
            </View>
          ))}
          <TouchableOpacity style={s.addBtn} onPress={addEdu} activeOpacity={0.8}>
            <Ionicons name="add-circle-outline" size={16} color={T.blue} />
            <Text style={s.addBtnText}>Add Another Degree</Text>
          </TouchableOpacity>
        </View>
      );

      // ── Projects ─────────────────────────────────────────────────────────────
      case 3: return (
        <View style={s.stepContent}>
          <Text style={s.sectionLabel}>PROJECTS</Text>
          {projs.map((p, i) => (
            <View key={i} style={s.subCard}>
              <View style={s.subCardHeader}>
                <Text style={s.subCardTitle}>Project {i + 1}</Text>
                {projs.length > 1 && (
                  <TouchableOpacity onPress={() => removeProj(i)} style={s.removeBtn}>
                    <Ionicons name="trash-outline" size={14} color={T.rose} />
                  </TouchableOpacity>
                )}
              </View>
              {(['title','link'] as const).map(key => (
                <View key={key} style={s.inputWrap}>
                  <Text style={s.inputLabel}>{key === 'link' ? 'Link (optional)' : 'Project Name'}</Text>
                  <TextInput style={s.input} value={p[key]} onChangeText={v => setProjs(prev => prev.map((x,idx) => idx===i ? {...x,[key]:v} : x))} placeholder={key==='link'?'https://github.com/...' : ''} placeholderTextColor={T.faint} keyboardType={key==='link'?'url':'default'} autoCapitalize={key==='link'?'none':'sentences'} />
                </View>
              ))}
              <View style={s.inputWrap}>
                <Text style={s.inputLabel}>Description</Text>
                <TextInput style={[s.input, s.multiInput]} value={p.description} onChangeText={v => setProjs(prev => prev.map((x,idx) => idx===i ? {...x,description:v} : x))} placeholder="2-3 sentences on what it does, tech stack, and impact…" placeholderTextColor={T.faint} multiline textAlignVertical="top" />
              </View>
            </View>
          ))}
          <TouchableOpacity style={s.addBtn} onPress={addProj} activeOpacity={0.8}>
            <Ionicons name="add-circle-outline" size={16} color={T.blue} />
            <Text style={s.addBtnText}>Add Another Project</Text>
          </TouchableOpacity>
        </View>
      );

      // ── Skills ───────────────────────────────────────────────────────────────
      case 4: return (
        <View style={s.stepContent}>
          <Text style={s.sectionLabel}>SKILLS</Text>
          <View style={s.subCard}>
            <View style={s.inputWrap}>
              <Text style={s.inputLabel}>Technical Skills (comma-separated)</Text>
              <TextInput style={[s.input, s.multiInput]} value={techSkills} onChangeText={setTechSkills} placeholder="React Native, Node.js, PostgreSQL, AWS, Docker…" placeholderTextColor={T.faint} multiline textAlignVertical="top" />
            </View>
            <View style={s.inputWrap}>
              <Text style={s.inputLabel}>Soft Skills (comma-separated)</Text>
              <TextInput style={[s.input, s.multiInput]} value={softSkills} onChangeText={setSoftSkills} placeholder="Leadership, Communication, Problem Solving…" placeholderTextColor={T.faint} multiline textAlignVertical="top" />
            </View>
          </View>
        </View>
      );
    }
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.select({ ios: 'padding', android: undefined })}>
        {/* Top bar */}
        <View style={s.topBar}>
          <TouchableOpacity onPress={() => step > 0 ? setStep(step - 1) : router.back()} style={s.backPill} activeOpacity={0.8}>
            <Ionicons name="arrow-back" size={14} color={T.ink} />
            <Text style={s.backPillText}>{step > 0 ? 'Back' : 'Cancel'}</Text>
          </TouchableOpacity>
          <View style={s.wordmark} pointerEvents="none">
            <Image source={require('../../assets/images/logo_img.png')} style={s.logoImg} resizeMode="contain" />
            <Text style={s.wordmarkText}>CV<Text style={s.wordmarkBlue}>Applyr</Text></Text>
          </View>
          <Text style={s.stepCounter}>{step + 1}/{STEPS.length}</Text>
        </View>

        {/* Progress bar */}
        <View style={s.progressTrack}>
          <LinearGradient colors={[T.cyan, T.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={[s.progressFill, { width: `${((step + 1) / STEPS.length) * 100}%` as any }]} />
        </View>

        {/* Step tabs */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabs} contentContainerStyle={s.tabsContent}>
          {STEPS.map((label, i) => (
            <TouchableOpacity key={i} style={[s.tab, i === step && s.tabActive]} onPress={() => i <= step && setStep(i)} activeOpacity={0.8}>
              <Text style={[s.tabText, i === step && s.tabTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {renderStep()}
          <View style={{ height: 20 }} />
        </ScrollView>

        {/* Footer */}
        <View style={s.footer}>
          {step < STEPS.length - 1 ? (
            <TouchableOpacity onPress={() => setStep(step + 1)} activeOpacity={0.88} style={s.nextOuter}>
              <LinearGradient colors={[T.cyan, T.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.nextBtn}>
                <Text style={s.nextText}>Next: {STEPS[step + 1]}</Text>
                <Ionicons name="arrow-forward" size={16} color="#fff" />
              </LinearGradient>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={handleFinish} disabled={saving} activeOpacity={0.88} style={s.nextOuter}>
              <LinearGradient colors={[T.emerald, '#059669']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.nextBtn}>
                <Ionicons name={saving ? 'time-outline' : 'checkmark-circle'} size={18} color="#fff" />
                <Text style={s.nextText}>{saving ? 'Saving…' : 'Preview Resume'}</Text>
              </LinearGradient>
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: T.bg },
  topBar:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  backPill:     { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.surface, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 3 },
  backPillText: { fontSize: 13, fontWeight: '600', color: T.ink },
  wordmark:     { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, zIndex: 0 },
  logoImg:      { width: 22, height: 22 },
  wordmarkText: { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  wordmarkBlue: { color: T.blue },
  stepCounter:  { fontSize: 13, fontWeight: '700', color: T.muted },
  progressTrack:{ height: 3, backgroundColor: T.border, marginHorizontal: 0 },
  progressFill: { height: 3, borderRadius: 2 },
  tabs:         { maxHeight: 44 },
  tabsContent:  { paddingHorizontal: 16, gap: 8, alignItems: 'center' },
  tab:          { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: T.surface },
  tabActive:    { backgroundColor: T.blue },
  tabText:      { fontSize: 12, fontWeight: '600', color: T.muted },
  tabTextActive:{ color: '#fff' },
  scroll:       { padding: 16 },
  stepContent:  { gap: 12 },
  sectionLabel: { fontSize: 10, fontWeight: '800', color: T.faint, letterSpacing: 1.2, marginBottom: 4 },
  subCard:      { backgroundColor: T.surface, borderRadius: 18, padding: 14, gap: 2, shadowColor: T.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.06, shadowRadius: 12, elevation: 3 },
  subCardHeader:{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  subCardTitle: { fontSize: 13, fontWeight: '700', color: T.ink },
  removeBtn:    { padding: 4 },
  inputWrap:    { marginBottom: 8 },
  inputLabel:   { fontSize: 11, fontWeight: '700', color: T.muted, marginBottom: 4 },
  input:        { backgroundColor: T.bgSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14, color: T.ink, borderWidth: 1, borderColor: T.border },
  multiInput:   { minHeight: 90, paddingTop: 10 },
  addBtn:       { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 14, backgroundColor: 'rgba(79,141,255,0.08)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(79,141,255,0.2)' },
  addBtnText:   { fontSize: 13, fontWeight: '700', color: T.blue },
  footer:       { backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.border, padding: 16, paddingBottom: Platform.select({ ios: 28, default: 16 }) },
  nextOuter:    { borderRadius: 14, overflow: 'hidden' },
  nextBtn:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 14 },
  nextText:     { fontSize: 15, fontWeight: '800', color: '#fff' },
});
