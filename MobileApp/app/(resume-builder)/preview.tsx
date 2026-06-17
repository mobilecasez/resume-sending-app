// Resume Builder — new feature. Safe to delete without affecting existing app.
import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  ActivityIndicator, Image, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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
  emerald: '#10B981', violet: '#A78BFA',
};

type ResumeData = {
  personal_info: { full_name: string; email: string; phone: string; location: string; linkedin_url: string; portfolio_url: string };
  summary: string;
  experience: Array<{ company: string; role: string; location: string; start_date: string; end_date: string; highlights: string[] }>;
  education: Array<{ institution: string; degree: string; field_of_study: string; end_date: string }>;
  projects: Array<{ title: string; link: string; description: string }>;
  skills: { technical: string[]; soft: string[] };
};

function Chip({ label, color }: { label: string; color: string }) {
  const bg = color + '18';
  return (
    <View style={[chip.wrap, { backgroundColor: bg, borderColor: color + '33' }]}>
      <Text style={[chip.text, { color }]}>{label}</Text>
    </View>
  );
}
const chip = StyleSheet.create({
  wrap: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1 },
  text: { fontSize: 11, fontWeight: '600' },
});

// Returns up to 2 initials from a full name
function getInitials(name: string): string {
  const parts = (name || '').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (name[0] || '?').toUpperCase();
}

// Single content renderer — handles **...**  markers (subtle bold) + always selectable.
// Strips any stray ** that the AI placed outside a valid pair so they never show literally.
function ContentText({ text, style, bulletVerb }: { text: string; style?: any; bulletVerb?: boolean }) {
  // Strip any lone/unmatched asterisks first so they never leak to the screen
  const clean = text.replace(/\*\*(.+?)\*\*/g, '\x01$1\x02').replace(/\*/g, '').replace(/\x01(.+?)\x02/g, '**$1**');
  const parts = clean.split(/\*\*(.+?)\*\*/g);

  const renderParts = () =>
    parts.map((part, i) => {
      if (i % 2 === 1) {
        // Marked keyword — subtle weight-600, slightly darker
        return <Text key={i} style={{ fontWeight: '600', color: T.inkSoft }}>{part}</Text>;
      }
      // First segment of a bullet → make the opening action verb weight-700
      if (bulletVerb && i === 0) {
        const space = part.search(/[\s,;]/);
        if (space > 1) {
          return (
            <Text key={i}>
              <Text style={{ fontWeight: '700', color: T.ink }}>{part.slice(0, space)}</Text>
              {part.slice(space)}
            </Text>
          );
        }
      }
      return part;
    });

  return (
    <Text style={style} selectable>
      {renderParts()}
    </Text>
  );
}

export default function ResumePreview() {
  const router = useRouter();
  const rating = useRatingPrompt();
  // Ask for a rating when leaving the previewed resume; complete the back nav after.
  const goBack = async () => { if (!(await rating.ask('resume'))) router.replace('/(resume-builder)'); };
  const closeRating = () => { rating.close(); router.replace('/(resume-builder)'); };
  const [data, setData] = useState<ResumeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileImage, setProfileImage] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const raw = await SecureStore.getItemAsync('userSession');
        const token = JSON.parse(raw || '{}')?.token;
        if (token) {
          // Load resume + profile in parallel
          const [resumeRes, profileRes] = await Promise.all([
            fetch(`${API_BASE}/resume-builder`,    { headers: { Authorization: `Bearer ${token}` } }),
            fetch(`${API_BASE}/users/profile`,      { headers: { Authorization: `Bearer ${token}` } }),
          ]);
          if (resumeRes.ok) {
            const json = await resumeRes.json();
            if (json.resumeData) {
              setData(json.resumeData);
              await AsyncStorage.setItem('resumeBuilderData', JSON.stringify(json.resumeData));
            }
          }
          if (profileRes.ok) {
            const pj = await profileRes.json();
            // API returns full URL in profileImage field
            const imgUrl = pj.profileImage || pj.profile_image || null;
            if (imgUrl) setProfileImage(imgUrl);
          }
          setLoading(false);
          return;
        }
      } catch {}
      try {
        const cached = await AsyncStorage.getItem('resumeBuilderData');
        if (cached) setData(JSON.parse(cached));
      } catch {}
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return (
      <SafeAreaView style={[s.safe, { justifyContent: 'center', alignItems: 'center' }]} edges={['top']}>
        <ActivityIndicator size="large" color={T.blue} />
      </SafeAreaView>
    );
  }

  if (!data) {
    return (
      <SafeAreaView style={[s.safe, { justifyContent: 'center', alignItems: 'center', gap: 12 }]} edges={['top']}>
        <Ionicons name="document-outline" size={48} color={T.faint} />
        <Text style={{ fontSize: 16, fontWeight: '700', color: T.ink }}>No resume data found</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ backgroundColor: T.blue, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 10 }}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>Go Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const pi = data.personal_info;

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* Top bar */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={goBack} style={s.backPill} activeOpacity={0.8}>
          <Ionicons name="arrow-back" size={14} color={T.ink} />
          <Text style={s.backPillText}>Back</Text>
        </TouchableOpacity>
        <View style={s.wordmark} pointerEvents="none">
          <Image source={require('../../assets/images/logo_img.png')} style={s.logoImg} resizeMode="contain" />
          <Text style={s.wordmarkText}>CV<Text style={s.wordmarkBlue}>Applyr</Text></Text>
        </View>
        <TouchableOpacity onPress={() => router.push('/(resume-builder)/templates')} style={s.exportBtn} activeOpacity={0.8}>
          <Ionicons name="download-outline" size={14} color={T.blue} />
          <Text style={s.exportText}>Download</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Hero — Name & Contact */}
        <View style={s.heroCard}>
          <LinearGradient colors={['#0B1120', '#162550', '#0d1f45']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.heroGradient}>
            {/* Decorative shapes */}
            <View style={s.heroDeco1} />
            <View style={s.heroDeco2} />
            <View style={s.heroDeco3} />
            <View style={s.heroDeco4} />
            {/* Content */}
            <View style={s.heroContent}>
              <View style={s.avatarCircle}>
                {profileImage
                  ? <Image source={{ uri: profileImage }} style={s.avatarImage} />
                  : <Text style={s.avatarText}>{getInitials(pi.full_name)}</Text>
                }
              </View>
              <Text style={s.heroName}>{pi.full_name || 'Your Name'}</Text>
              <View style={s.heroDivider} />
              <View style={s.heroContactRow}>
                {pi.email    ? <ContactPill icon="mail-outline"     text={pi.email}    /> : null}
                {pi.phone    ? <ContactPill icon="call-outline"     text={pi.phone}    /> : null}
                {pi.location ? <ContactPill icon="location-outline" text={pi.location} /> : null}
              </View>
              {(pi.linkedin_url || pi.portfolio_url) ? (
                <View style={s.heroContactRow}>
                  {pi.linkedin_url  ? <ContactPill icon="logo-linkedin" text="LinkedIn"  /> : null}
                  {pi.portfolio_url ? <ContactPill icon="globe-outline" text="Portfolio" /> : null}
                </View>
              ) : null}
            </View>
          </LinearGradient>
        </View>

        {/* Summary */}
        {!!data.summary && (
          <Section title="SUMMARY" icon="newspaper-outline" color={T.cyan}>
            {data.summary.split('\n').map((line, i) => {
              const isBullet = line.trim().startsWith('•');
              if (!line.trim()) return null;
              return isBullet ? (
                <View key={i} style={s.bulletRow}>
                  <View style={[s.bulletDot, { backgroundColor: T.cyan }]} />
                  <ContentText text={line.trim().replace(/^•\s*/, '')} style={s.bulletText} bulletVerb />
                </View>
              ) : (
                <ContentText key={i} text={line.trim()} style={[s.summaryText, { marginBottom: 8 }]} />
              );
            })}
          </Section>
        )}

        {/* Experience */}
        {data.experience?.length > 0 && (
          <Section title="EXPERIENCE" icon="briefcase-outline" color={T.blue}>
            {data.experience.map((e, i) => (
              <View key={i} style={[s.expRow, i > 0 && s.divider]}>
                <View style={s.expHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.expRole} selectable>{e.role || '—'}</Text>
                    <Text style={s.expCompany} selectable>{e.company}{e.location ? ` · ${e.location}` : ''}</Text>
                  </View>
                  <Text style={s.expDates}>{[e.start_date, e.end_date].filter(Boolean).join(' – ') || ''}</Text>
                </View>
                {(e.highlights || []).map((h, j) => (
                  <View key={j} style={s.bulletRow}>
                    <View style={s.bulletDot} />
                    <ContentText text={h} style={s.bulletText} bulletVerb />
                  </View>
                ))}
              </View>
            ))}
          </Section>
        )}

        {/* Education */}
        {data.education?.length > 0 && (
          <Section title="EDUCATION" icon="school-outline" color={T.violet}>
            {data.education.map((e, i) => (
              <View key={i} style={[s.expRow, i > 0 && s.divider]}>
                <View style={s.expHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.expRole}>{[e.degree, e.field_of_study].filter(Boolean).join(' · ') || '—'}</Text>
                    <Text style={s.expCompany}>{e.institution}</Text>
                    {!!(e as any).grade && (
                      <View style={s.gradePill}>
                        <Ionicons name="ribbon-outline" size={11} color={T.violet} />
                        <Text style={s.gradeText}>{(e as any).grade}</Text>
                      </View>
                    )}
                  </View>
                  {!!e.end_date && <Text style={s.expDates}>{e.end_date}</Text>}
                </View>
              </View>
            ))}
          </Section>
        )}

        {/* Projects */}
        {data.projects?.length > 0 && (
          <Section title="PROJECTS" icon="code-slash-outline" color={T.emerald}>
            {data.projects.map((p: any, i: number) => (
              <View key={i} style={[s.expRow, i > 0 && s.divider]}>
                {/* Project name + type header */}
                <View style={s.expHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.expRole}>
                      {p.title || '—'}
                      {!!p.type && <Text style={s.projectType}>{`  (${p.type})`}</Text>}
                    </Text>
                  </View>
                  {!!p.link && <Ionicons name="link-outline" size={13} color={T.faint} />}
                </View>

                {/* About the project */}
                {!!p.about && (
                  <ContentText text={p.about} style={[s.summaryText, s.projectAbout]} />
                )}
                {/* Fallback for old-format resumes with description field */}
                {!p.about && !!p.description && (
                  <ContentText text={p.description} style={[s.summaryText, s.projectAbout]} />
                )}

                {/* Candidate's role */}
                {!!p.role && (
                  <View style={s.roleRow}>
                    <Ionicons name="person-outline" size={12} color={T.emerald} />
                    <Text style={s.roleLabel}>Role: </Text>
                    <Text style={s.roleValue}>{p.role}</Text>
                  </View>
                )}

                {/* Role highlights / bullets */}
                {(p.role_highlights || []).map((h: string, j: number) => (
                  <View key={j} style={s.bulletRow}>
                    <View style={[s.bulletDot, { backgroundColor: T.emerald }]} />
                    <ContentText text={h} style={s.bulletText} bulletVerb />
                  </View>
                ))}
              </View>
            ))}
          </Section>
        )}

        {/* Skills */}
        {(data.skills?.technical?.length > 0 || data.skills?.soft?.length > 0) && (
          <Section title="SKILLS" icon="flash-outline" color={T.cyan}>
            {data.skills.technical?.length > 0 && (
              <View style={s.skillGroup}>
                <Text style={s.skillGroupLabel}>Technical</Text>
                <View style={s.chipsRow}>
                  {data.skills.technical.map((sk, i) => <Chip key={i} label={sk} color={T.blue} />)}
                </View>
              </View>
            )}
            {data.skills.soft?.length > 0 && (
              <View style={s.skillGroup}>
                <Text style={s.skillGroupLabel}>Soft Skills</Text>
                <View style={s.chipsRow}>
                  {data.skills.soft.map((sk, i) => <Chip key={i} label={sk} color={T.violet} />)}
                </View>
              </View>
            )}
          </Section>
        )}

        <View style={{ height: 96 }} />
      </ScrollView>

      {/* Floating Regenerate Button */}
      <View style={s.floatingBar}>
        <TouchableOpacity
          style={s.regenOuter}
          activeOpacity={0.88}
          onPress={async () => {
            await AsyncStorage.setItem('resumeBuilderAction', 'regenerate').catch(() => {});
            router.back();
          }}
        >
          <LinearGradient colors={[T.navy, '#1a2346']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.regenBtn}>
            <Ionicons name="refresh-outline" size={16} color="#fff" />
            <Text style={s.regenText}>Regenerate Resume</Text>
            <View style={s.regenBadge}>
              <Ionicons name="diamond" size={9} color="#fff" />
              <Text style={s.regenBadgeText}>2</Text>
            </View>
          </LinearGradient>
        </TouchableOpacity>
        <Text style={s.regenNote}>Uses 2 credits · re-runs AI with your saved story</Text>
      </View>
      <RatingPromptModal visible={!!rating.trigger} trigger={rating.trigger} onClose={closeRating} />
    </SafeAreaView>
  );
}

function ContactPill({ icon, text }: { icon: any; text: string }) {
  return (
    <View style={cpStyles.pill}>
      <Ionicons name={icon} size={11} color="rgba(255,255,255,0.6)" />
      <Text style={cpStyles.text} numberOfLines={1}>{text}</Text>
    </View>
  );
}
const cpStyles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 20, paddingHorizontal: 8, paddingVertical: 4 },
  text: { fontSize: 10, color: 'rgba(255,255,255,0.75)', fontWeight: '500' },
});

function Section({ title, icon, color, children }: { title: string; icon: any; color: string; children: React.ReactNode }) {
  return (
    <View style={sec.card}>
      <View style={sec.header}>
        <View style={[sec.iconWrap, { backgroundColor: color + '18' }]}>
          <Ionicons name={icon} size={14} color={color} />
        </View>
        <Text style={sec.title}>{title}</Text>
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
  heroCard:       { borderRadius: 28, overflow: 'hidden', marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.22, shadowRadius: 24, elevation: 10 },
  heroGradient:   { paddingTop: 32, paddingBottom: 28, paddingHorizontal: 20 },
  heroContent:    { alignItems: 'center', gap: 10, zIndex: 2 },
  // Decorative shapes (absolute, behind content)
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
