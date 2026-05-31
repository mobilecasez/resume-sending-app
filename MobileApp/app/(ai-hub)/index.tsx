// AI Hub — new feature. Safe to delete without affecting existing app.

import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
} from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  TouchableOpacity,
  Modal,
  TextInput,
  StyleSheet,
  Animated,
  Alert,
  ActivityIndicator,
  Linking,
  Platform,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { Contact, Job, Employer, WishlistPill } from '../../types/aiHub';
import { fetchJobMatches, fetchDashboard, resumeJobPolling, removeDashboardItem } from '../../services/aiHubService';
import { API_BASE } from '../../config';
import axios from 'axios';
import { LoadingTips } from './LoadingTips';

const { width: SCREEN_W } = Dimensions.get('window');

// ─── Design tokens (identical to ReviewScreen / HomeScreen) ──────────────────
const T = {
  bg:         '#E5EAF3',
  bgSoft:     '#DCE2ED',
  surface:    '#FFFFFF',
  inputBg:    '#F1F4FA',
  ink:        '#0B0F22',
  inkSoft:    '#1A2046',
  textMuted:  '#5B6B8A',
  textFaint:  '#8896B0',
  border:     'rgba(11,15,34,0.06)',
  borderHi:   'rgba(11,15,34,0.10)',
  blue:       '#4F8DFF',
  blueDeep:   '#2563EB',
  purple:     '#7C6BFF',
  teal:       '#14B8A6',
  emerald:    '#10B981',
  amber:      '#F59E0B',
  rose:       '#EF4444',
};

// ─────────────────────────────────────────────────────────────────
// MOCK DATA
// ─────────────────────────────────────────────────────────────────

const MOCK_EMPLOYERS: Employer[] = [
  {
    id: 'apple',
    name: 'Apple Inc.',
    subInfo: 'Cupertino, CA · Technology',
    logoColor: ['#555555', '#1C1C1E'],
    logoInitial: 'A',
    status: 'active',
    jobs: [
      {
        id: 'apple-job-1',
        title: 'Senior Software Engineer — SwiftUI',
        location: 'Cupertino, CA',
        experience: '5+ years',
        salary: '$200K–$260K',
        jobType: 'Full-time',
        urgent: false,
        skills: ['SwiftUI', 'Combine', 'Core Data', 'UIKit'],
        responsibilities: ['Build iOS features with SwiftUI', 'Maintain Core Data persistence layer', 'Collaborate with design team', 'Review pull requests'],
        contacts: [
          { id: 'apple-c1', name: 'Sarah Chen', role: 'Engineering Manager', email: 's.chen@apple.com', verified: true, avatarColor: ['#06B6D4', '#3B82F6'] },
          { id: 'apple-c2', name: 'James Park', role: 'Senior Recruiter', email: 'j.park@apple.com', verified: true, avatarColor: ['#8B5CF6', '#6D28D9'] },
        ],
      },
      {
        id: 'apple-job-2',
        title: 'Staff ML Engineer — Siri',
        location: 'Seattle, WA',
        experience: '7+ years',
        salary: '$250K–$320K',
        jobType: 'Full-time',
        urgent: true,
        skills: ['PyTorch', 'Core ML', 'Python', 'NLP', 'LLMs'],
        responsibilities: ['Train and fine-tune ML models', 'Deploy models to production', 'Collaborate with product teams', 'Monitor model performance'],
        contacts: [
          { id: 'apple-c3', name: 'Priya Nair', role: 'ML Team Lead', email: 'p.nair@apple.com', verified: true, avatarColor: ['#10B981', '#059669'] },
        ],
      },
    ],
  },
  {
    id: 'stripe',
    name: 'Stripe',
    subInfo: 'San Francisco, CA · Fintech',
    logoColor: ['#635BFF', '#4338CA'],
    logoInitial: 'S',
    status: 'watching',
    jobs: [
      {
        id: 'stripe-job-1',
        title: 'Product Engineer — Developer Experience',
        location: 'Remote (US)',
        experience: '3–6 years',
        salary: '$170K–$220K',
        jobType: 'Full-time',
        urgent: false,
        skills: ['React', 'TypeScript', 'Node.js', 'GraphQL'],
        responsibilities: ['Build developer tools and APIs', 'Improve CI/CD pipelines', 'Write technical documentation', 'Lead platform architecture decisions'],
        contacts: [
          { id: 'stripe-c1', name: 'Alex Rivera', role: 'Engineering Manager', email: 'a.rivera@stripe.com', verified: true, avatarColor: ['#635BFF', '#4338CA'] },
          { id: 'stripe-c2', name: 'Mia Thompson', role: 'Technical Recruiter', email: 'm.thompson@stripe.com', verified: false, avatarColor: ['#F59E0B', '#D97706'] },
        ],
      },
    ],
  },
];

const COLOR_CYCLE: Array<'cyan' | 'violet' | 'emerald'> = ['cyan', 'violet', 'emerald'];

const PILL_COLORS = {
  cyan:    { bg: 'rgba(6,182,212,0.15)',   border: 'rgba(6,182,212,0.28)',   text: '#67E8F9' },
  violet:  { bg: 'rgba(139,92,246,0.15)',  border: 'rgba(139,92,246,0.28)',  text: '#C4B5FD' },
  emerald: { bg: 'rgba(16,185,129,0.15)',  border: 'rgba(16,185,129,0.28)',  text: '#6EE7B7' },
} as const;

// ─────────────────────────────────────────────────────────────────
// CONTACT ROW
// ─────────────────────────────────────────────────────────────────

const ContactRow: React.FC<{ contact: Contact }> = ({ contact }) => {
  const initials = contact.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const openLinkedIn = () => {
    if (contact.linkedin) {
      const url = contact.linkedin.startsWith('http') ? contact.linkedin : `https://${contact.linkedin}`;
      Linking.openURL(url).catch(() => {});
    }
  };

  return (
    <View style={styles.contactRow}>
      {/* Avatar — photo if available, else gradient initials */}
      {contact.imageUrl ? (
        <Image source={{ uri: contact.imageUrl }} style={styles.avatar} />
      ) : (
        <LinearGradient colors={contact.avatarColor} style={styles.avatar}>
          <Text style={styles.avatarInitials}>{initials}</Text>
        </LinearGradient>
      )}

      {/* Name + role */}
      <View style={styles.contactMid}>
        <Text style={styles.contactName}>{contact.name}</Text>
        <Text style={styles.contactRole}>{contact.role}</Text>
        {!!contact.phone && <Text style={styles.contactPhone}>{contact.phone}</Text>}
      </View>

      {/* Email + badges */}
      <View style={styles.contactRight}>
        {!!contact.email && (
          <Text style={styles.contactEmail} numberOfLines={1}>{contact.email}</Text>
        )}
        <View style={styles.contactBadgesRow}>
          {contact.verified && (
            <LinearGradient colors={[T.emerald, '#059669']} style={styles.verifiedBadge}>
              <Ionicons name="checkmark" size={10} color="white" />
            </LinearGradient>
          )}
          {!!contact.linkedin && (
            <TouchableOpacity onPress={openLinkedIn} style={styles.linkedinBtn} activeOpacity={0.7}>
              <Ionicons name="logo-linkedin" size={18} color="#0A66C2" />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────
// COMPANY CARD
// ─────────────────────────────────────────────────────────────────

type CompanyCardProps = {
  employer: Employer;
  selected: boolean;
  onPress: () => void;
};

const CompanyCard: React.FC<CompanyCardProps> = ({ employer, selected, onPress }) => {
  const jobCount     = (employer.jobs || []).length;
  const contactCount = (employer.jobs || []).reduce((s, j) => s + (j.contacts || []).length, 0);

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={[styles.ccWrap, selected && styles.ccWrapSelected]}>
      {selected && (
        <LinearGradient
          colors={[T.blue, T.purple]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={styles.ccSelectedRing}
        />
      )}
      <View style={styles.ccInner}>
        {/* Logo */}
        <LinearGradient colors={employer.logoColor || ['#555', '#222']} style={styles.ccLogo}>
          <Text style={styles.ccLogoText}>{employer.logoInitial}</Text>
        </LinearGradient>
        {/* Name */}
        <Text style={styles.ccName} numberOfLines={2}>{employer.name}</Text>
        {/* Stats */}
        <View style={styles.ccRow}>
          <Ionicons name="briefcase-outline" size={11} color="#22D3EE" />
          <Text style={[styles.ccStat, { color: '#22D3EE' }]}>{jobCount}</Text>
          <View style={styles.ccDot} />
          <Ionicons name="people-outline" size={11} color="#A78BFA" />
          <Text style={[styles.ccStat, { color: '#A78BFA' }]}>{contactCount}</Text>
        </View>
        {/* Selected tick */}
        {selected && (
          <View style={styles.ccTick}>
            <Ionicons name="checkmark" size={11} color="#fff" />
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
};

// ─────────────────────────────────────────────────────────────────
// JOB CARD
// ─────────────────────────────────────────────────────────────────

type JobCardProps = {
  job: Job;
  onApply: () => void;
  onAddContact: () => void;
  onVisitJob?: () => void;
};

function JobCard({ job, onApply, onAddContact, onVisitJob }: JobCardProps) {
  const [skillsExpanded, setSkillsExpanded] = useState(false);
  const SKILLS_PREVIEW = 5;
  const allSkills = job.skills || [];
  const visibleSkills = skillsExpanded ? allSkills : allSkills.slice(0, SKILLS_PREVIEW);
  const hiddenCount = allSkills.length - SKILLS_PREVIEW;

  return (
  <View style={styles.card}>
    {/* ── Header: title + badges ── */}
    <View style={styles.cardHeader}>
      <View style={styles.cardHeaderMid}>
        <Text style={styles.jobTitle} numberOfLines={2}>{job.title}</Text>
      </View>
      <View style={styles.cardBadgesCol}>
        {job.urgent && (
          <View style={styles.urgentBadge}>
            <Ionicons name="flash" size={10} color="#EF4444" />
            <Text style={styles.urgentText}>Urgent</Text>
          </View>
        )}
        {job.matchScore != null && job.matchScore > 0 && (
          <View style={[
            styles.matchBadge,
            { backgroundColor: job.matchScore >= 70 ? 'rgba(16,185,129,0.12)' : job.matchScore >= 40 ? 'rgba(251,146,60,0.12)' : 'rgba(148,163,184,0.12)' }
          ]}>
            <Text style={[
              styles.matchBadgeText,
              { color: job.matchScore >= 70 ? '#059669' : job.matchScore >= 40 ? '#EA580C' : '#64748B' }
            ]}>{job.matchScore}% match</Text>
          </View>
        )}
      </View>
    </View>

    {/* ── Meta chips ── */}
    <View style={styles.metaRow}>
      <View style={styles.metaChip}>
        <Ionicons name="location-outline" size={12} color={T.blue} />
        <Text style={styles.metaChipText}>{job.location}</Text>
      </View>
      {!!job.experience && (
        <View style={styles.metaChip}>
          <Ionicons name="time-outline" size={12} color="#A78BFA" />
          <Text style={styles.metaChipText}>{job.experience}</Text>
        </View>
      )}
      {!!job.salary && job.salary !== 'Not listed' && (
        <View style={styles.metaChip}>
          <Ionicons name="cash-outline" size={12} color="#34D399" />
          <Text style={styles.metaChipText}>{job.salary}</Text>
        </View>
      )}
      {!!job.jobType && (
        <View style={styles.metaChip}>
          <Ionicons name="briefcase-outline" size={12} color="#FB923C" />
          <Text style={styles.metaChipText}>{job.jobType}</Text>
        </View>
      )}
    </View>

    {/* ── Skills ── */}
    {allSkills.length > 0 && (
      <View style={styles.cardSection}>
        <Text style={styles.cardSectionLabel}>SKILLS</Text>
        <View style={styles.skillsChipsRow}>
          {visibleSkills.map((skill, i) => (
            <View key={i} style={styles.skillChip}>
              <Text style={styles.skillChipText}>{skill}</Text>
            </View>
          ))}
          {!skillsExpanded && hiddenCount > 0 && (
            <TouchableOpacity onPress={() => setSkillsExpanded(true)} style={styles.skillChipMore} activeOpacity={0.75}>
              <Text style={styles.skillChipMoreText}>+{hiddenCount} more</Text>
            </TouchableOpacity>
          )}
          {skillsExpanded && allSkills.length > SKILLS_PREVIEW && (
            <TouchableOpacity onPress={() => setSkillsExpanded(false)} style={styles.skillChipCollapse} activeOpacity={0.75}>
              <Ionicons name="chevron-up" size={11} color={T.textMuted} />
              <Text style={styles.skillChipCollapseText}>Less</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    )}

    {/* ── Responsibilities ── */}
    {(job.responsibilities || []).length > 0 && (
      <View style={styles.cardSection}>
        <Text style={styles.cardSectionLabel}>RESPONSIBILITIES</Text>
        {(job.responsibilities || []).slice(0, 3).map((r, i) => (
          <View key={i} style={styles.respRow}>
            <View style={styles.respDot} />
            <Text style={styles.respText}>{r}</Text>
          </View>
        ))}
      </View>
    )}

    {/* ── Contacts ── */}
    <View style={styles.cardSectionContacts}>
      <Text style={styles.cardSectionLabel}>HIRING CONTACTS</Text>
      {(job.contacts || []).length > 0 ? (
        (job.contacts || []).map((contact) => (
          <ContactRow key={contact.id} contact={contact} />
        ))
      ) : (
        <Text style={styles.noContactsText}>No contacts found for this listing</Text>
      )}
    </View>

    {/* ── Footer ── */}
    <View style={styles.cardFooter}>
      <TouchableOpacity onPress={onAddContact} style={styles.addContactBtn}>
        <Ionicons name="person-add-outline" size={13} color={T.textMuted} />
        <Text style={styles.addContactBtnText}>Add Contact</Text>
      </TouchableOpacity>
      {!!job.applyUrl && (
        <TouchableOpacity onPress={onVisitJob} style={styles.visitJobBtn}>
          <Ionicons name="open-outline" size={13} color={T.blue} />
          <Text style={styles.visitJobBtnText}>View Job</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={onApply} activeOpacity={0.85} style={styles.applyBtnOuter}>
        <LinearGradient
          colors={[T.blue, T.blueDeep]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.applyBtn}
        >
          <Ionicons name="send-outline" size={13} color="white" />
          <Text style={styles.applyBtnText}>Apply Now</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
  </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// INDETERMINATE PROGRESS BAR
// ─────────────────────────────────────────────────────────────────

function IndeterminateBar() {
  const translateX = useRef(new Animated.Value(-1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(translateX, { toValue: 1, duration: 1400, useNativeDriver: true }),
        Animated.timing(translateX, { toValue: -1, duration: 1400, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [translateX]);
  return (
    <View style={barStyles.track}>
      <Animated.View style={[barStyles.fill, {
        transform: [{
          translateX: translateX.interpolate({
            inputRange: [-1, 1],
            outputRange: ['-100%' as unknown as number, '100%' as unknown as number],
          }),
        }],
      }]} />
    </View>
  );
}
const barStyles = StyleSheet.create({
  track: { height: 4, backgroundColor: T.border, borderRadius: 2, marginTop: 10, overflow: 'hidden' },
  fill:  { position: 'absolute', left: 0, width: '50%', height: '100%', backgroundColor: T.blue, borderRadius: 2 },
});

// ─────────────────────────────────────────────────────────────────
// BOTTOM TAB BAR (Letters-screen style)
// ─────────────────────────────────────────────────────────────────

function JobHubTabBar() {
  const router = useRouter();
  const TABS = [
    { key: 'home',    label: 'Home',    icon: 'home-outline',          iconActive: 'home' },
    { key: 'jobs',    label: 'Jobs',    icon: 'briefcase-outline',     iconActive: 'briefcase' },
    { key: 'letters', label: 'Letters', icon: 'document-text-outline', iconActive: 'document-text' },
    { key: 'me',      label: 'Me',      icon: 'person-outline',        iconActive: 'person' },
  ];
  return (
    <View style={tabStyles.wrapper}>
      <View style={tabStyles.bar}>
        {TABS.map((tab) => {
          const isActive = tab.key === 'jobs';
          if (isActive) {
            return (
              <LinearGradient key={tab.key} colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={tabStyles.activeTab}>
                <TouchableOpacity style={tabStyles.activeTabInner} activeOpacity={0.85}>
                  <Ionicons name={tab.iconActive as any} size={16} color="#fff" />
                  <Text style={tabStyles.activeLabel}>{tab.label}</Text>
                </TouchableOpacity>
              </LinearGradient>
            );
          }
          return (
            <TouchableOpacity key={tab.key} style={tabStyles.tab} onPress={() => router.back()} activeOpacity={0.7}>
              <Ionicons name={tab.icon as any} size={20} color={T.textFaint} />
              <Text style={tabStyles.tabLabel}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}
const tabStyles = StyleSheet.create({
  wrapper:      { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 20, paddingBottom: 28, paddingTop: 8, backgroundColor: 'transparent' },
  bar:          { flexDirection: 'row', alignItems: 'center', backgroundColor: T.surface, borderRadius: 28, paddingVertical: 8, paddingHorizontal: 8, gap: 4, shadowColor: T.ink, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.14, shadowRadius: 24, elevation: 12 },
  activeTab:    { flex: 1, borderRadius: 22 },
  activeTabInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 12 },
  activeLabel:  { fontSize: 13, fontWeight: '700', color: '#fff', letterSpacing: -0.2 },
  tab:          { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 6 },
  tabLabel:     { fontSize: 10, fontWeight: '600', color: T.textFaint, letterSpacing: -0.1 },
});

// ─────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────

export default function AIHubScreen() {
  const router = useRouter();
  const [pills, setPills] = useState<WishlistPill[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [inputValue, setInputValue] = useState('https://');
  const [employers, setEmployers] = useState<Employer[]>([]);
  const [loadingCompanies, setLoadingCompanies] = useState<string[]>([]);
  const [processingEmployerIds, setProcessingEmployerIds] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState({ sources: 0, matches: 0, contacts: 0, verifiedPct: 0 });
  const [initialLoading, setInitialLoading] = useState(true);
  const [selectedEmployerId, setSelectedEmployerId] = useState<string | null>(null);
  const [featureFlag, setFeatureFlag] = useState<{ status: string; title: string | null; message: string | null } | null>(null);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.6, duration: 750, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1.0, duration: 750, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  useEffect(() => {
    let m = 0, c = 0;
    employers.forEach(emp => {
      m += (emp.jobs || []).length;
      c += (emp.jobs || []).reduce((s, j) => s + (j.contacts || []).length, 0);
    });
    setStats({ sources: employers.length, matches: m, contacts: c, verifiedPct: 94 });
  }, [employers]);

  useEffect(() => {
    axios.get(`${API_BASE}/feature-flags/jobs_dashboard`)
      .then(({ data }) => setFeatureFlag(data))
      .catch(() => setFeatureFlag({ status: 'active', title: null, message: null }));
  }, []);

  useEffect(() => {
    async function loadDashboard() {
      try {
        const dashboard = await fetchDashboard();
        if (!dashboard || dashboard.length === 0) {
          setEmployers([]); setPills([]); setInitialLoading(false); return;
        }
        const loadedEmployers: Employer[] = [];
        const loadedPills: WishlistPill[] = [];
        const currentlyProcessing = new Set<string>();
        dashboard.forEach((entry, i) => {
          const emp = entry.employer;
          loadedEmployers.push(emp);
          loadedPills.push({ id: `pill-${emp.id}`, label: emp.name, colorVariant: COLOR_CYCLE[i % 3], employerId: emp.id });
          if (entry.status === 'processing' || entry.status === 'pending') {
            currentlyProcessing.add(emp.id);
            resumePolling(entry.jobId, emp.name);
          }
        });
        setEmployers(loadedEmployers);
        setPills(loadedPills);
        setProcessingEmployerIds(currentlyProcessing);
      } catch (e) {
        console.error('Failed to load dashboard', e);
      } finally {
        setInitialLoading(false);
      }
    }
    loadDashboard();
  }, []);

  const resumePolling = (jobId: string, companyName: string) => {
    const onPartialUpdate = (partialEmployer: Employer) => {
      setEmployers((prev) => {
        const idx = prev.findIndex((e) => e.id === partialEmployer.id);
        if (idx >= 0) { const arr = [...prev]; arr[idx] = partialEmployer; return arr; }
        return [partialEmployer, ...prev];
      });
    };
    resumeJobPolling(jobId, onPartialUpdate)
      .then((finalEmployer) => {
        setProcessingEmployerIds((prev) => { const n = new Set(prev); n.delete(finalEmployer.id); return n; });
        setEmployers((prev) => {
          const idx = prev.findIndex((e) => e.id === finalEmployer.id);
          if (idx >= 0) { const arr = [...prev]; arr[idx] = finalEmployer; return arr; }
          return [finalEmployer, ...prev];
        });
      })
      .catch(() => Alert.alert('Error', `Failed to resume tracking jobs for ${companyName}`));
  };

  const handleRemovePill = useCallback((id: string) => {
    setPills((prev) => {
      const pill = prev.find((p) => p.id === id);
      if (pill?.employerId) {
        const target = employers.find((e) => e.id === pill.employerId);
        if (target?.jobId) removeDashboardItem(target.jobId).catch(console.error);
        setEmployers((emp) => emp.filter((e) => e.id !== pill.employerId));
        if (selectedEmployerId === pill.employerId) setSelectedEmployerId(null);
      }
      return prev.filter((p) => p.id !== id);
    });
  }, [employers, selectedEmployerId]);

  const handleAddPill = useCallback(() => {
    let trimmed = inputValue.trim();
    if (!trimmed || trimmed === 'https://' || trimmed === 'http://') return;
    if (!/^https?:\/\//i.test(trimmed) && /\./.test(trimmed)) trimmed = `https://${trimmed}`;
    const pillId = `pill-${Date.now()}`;
    setPills((prev) => [...prev, { id: pillId, label: trimmed, colorVariant: COLOR_CYCLE[prev.length % 3] }]);
    setLoadingCompanies((prev) => [...prev, trimmed]);
    setInputValue('');
    setModalVisible(false);
    let firstPartial = false;
    const onPartialUpdate = (partialEmployer: Employer) => {
      if (!firstPartial) {
        firstPartial = true;
        setLoadingCompanies((prev) => prev.filter((c) => c !== trimmed));
        setProcessingEmployerIds((prev) => new Set([...prev, partialEmployer.id]));
        setPills((prev) => prev.map((p) => p.id === pillId ? { ...p, employerId: partialEmployer.id } : p));
      }
      setEmployers((prev) => {
        const idx = prev.findIndex((e) => e.id === partialEmployer.id);
        if (idx >= 0) { const arr = [...prev]; arr[idx] = partialEmployer; return arr; }
        return [partialEmployer, ...prev];
      });
    };
    fetchJobMatches(trimmed, onPartialUpdate)
      .then((employer) => {
        setProcessingEmployerIds((prev) => { const n = new Set(prev); n.delete(employer.id); return n; });
        setEmployers((prev) => {
          const idx = prev.findIndex((e) => e.id === employer.id);
          return idx >= 0 ? prev.map((e, i) => i === idx ? employer : e) : [...prev, employer];
        });
        setPills((prev) => prev.map((p) => p.id === pillId ? { ...p, employerId: employer.id } : p));
      })
      .catch((err) => {
        const isPortal = err?.response?.data?.error === 'job_portal' || err?.isPortal;
        if (isPortal) {
          const portal = err?.response?.data?.portal || trimmed;
          Alert.alert('🚫 Job Portal Detected', `"${portal}" is a job listing portal, not a company.\n\nCVApplyr works exclusively on employer career pages. Please enter a specific company name or their career page URL.\n\nExample: "https://careers.google.com"`, [{ text: 'Got it' }]);
        } else {
          Alert.alert('Could not fetch jobs', `No results found for "${trimmed}". Try a full URL like https://careers.company.com`);
        }
        setPills((prev) => prev.filter((p) => p.id !== pillId));
      })
      .finally(() => setLoadingCompanies((prev) => prev.filter((c) => c !== trimmed)));
  }, [inputValue]);

  const handleApply = useCallback((employer: Employer, job: Job) => {
    router.push({
      pathname: '/(ai-hub)/job-detail',
      params: {
        jobStr: JSON.stringify(job),
        employerStr: JSON.stringify({ id: employer.id, name: employer.name, subInfo: employer.subInfo, logoColor: employer.logoColor, logoInitial: employer.logoInitial }),
      },
    });
  }, [router]);

  const handleAddContact = useCallback((jobId: string) => {
    router.push({ pathname: '/(ai-hub)/add-contact', params: { jobId } });
  }, [router]);

  const openModal = () => { setInputValue('https://'); setModalVisible(true); };
  const visibleEmployers = selectedEmployerId ? employers.filter((e) => e.id === selectedEmployerId) : employers;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >

        {/* ══ TOP BAR (Letters-style: back pill · logo · add btn) ══════════════ */}
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.backPill} onPress={() => router.back()} activeOpacity={0.8}>
            <Ionicons name="arrow-back" size={14} color={T.ink} />
            <Text style={styles.backPillText}>Back</Text>
          </TouchableOpacity>

          <View style={styles.wordmark}>
            <Image
              source={require('../../assets/images/logo_img.png')}
              style={styles.wordmarkLogo}
              resizeMode="contain"
            />
            <Text style={styles.wordmarkText}>
              cv<Text style={styles.wordmarkBlue}>applyr</Text>
            </Text>
          </View>

          <TouchableOpacity style={styles.addBtn} onPress={openModal} activeOpacity={0.8}>
            <Ionicons name="add" size={18} color={T.ink} />
          </TouchableOpacity>
        </View>

        {/* ══ HERO CARD (Letters-style dark gradient) ══════════════════════════ */}
        <View style={styles.heroCard}>
          <LinearGradient
            colors={['#0B0F22', '#0F1635', '#0B0F22']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFillObject}
          />
          {/* Mesh blobs */}
          <View style={[styles.blob, { top: -24, left: -30, backgroundColor: 'rgba(79,141,255,0.18)', width: 150, height: 150 }]} />
          <View style={[styles.blob, { top: 16, right: -20, backgroundColor: 'rgba(124,107,255,0.14)', width: 120, height: 120 }]} />
          <View style={[styles.blob, { bottom: -16, left: 80, backgroundColor: 'rgba(20,184,166,0.10)', width: 100, height: 100 }]} />

          {/* Eyebrow + AI dot */}
          <View style={styles.heroEyeRow}>
            <Text style={styles.heroEyebrow}>AI-POWERED JOB SEARCH</Text>
            {employers.length > 0 && (
              <View style={styles.aiPill}>
                <Animated.View style={[styles.pulseDot, { transform: [{ scale: pulseAnim }] }]} />
                <Text style={styles.aiPillText}>Live</Text>
              </View>
            )}
          </View>

          {/* Title */}
          <Text style={styles.heroTitle}>Job Hub</Text>
          <Text style={styles.heroSub}>
            {employers.length > 0
              ? `Tracking ${stats.sources} ${stats.sources === 1 ? 'company' : 'companies'} · ${stats.matches} job ${stats.matches === 1 ? 'match' : 'matches'} · ${stats.contacts} contacts found`
              : 'Add a company to start AI-powered job matching'}
          </Text>

          {/* Stats row — only when data exists */}
          {employers.length > 0 && (
            <View style={styles.statsRow}>
              {[
                { value: stats.matches,  label: 'Matches',   color: '#22D3EE' },
                { value: stats.contacts, label: 'Contacts',  color: '#A78BFA' },
                { value: `${stats.verifiedPct}%`, label: 'Verified',  color: '#34D399' },
                { value: stats.sources,  label: 'Companies', color: '#FB923C' },
              ].map((s, i, arr) => (
                <React.Fragment key={s.label}>
                  <View style={styles.statItem}>
                    <Text style={[styles.statValue, { color: s.color }]}>{s.value}</Text>
                    <Text style={styles.statLabel}>{s.label}</Text>
                  </View>
                  {i < arr.length - 1 && <View style={styles.statDivider} />}
                </React.Fragment>
              ))}
            </View>
          )}

          {/* Company tab switcher (inside hero, like step indicators in Letters) */}
          {employers.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.tabScroll}
              contentContainerStyle={styles.tabScrollContent}
            >
              {/* "All" tab */}
              <TouchableOpacity
                onPress={() => setSelectedEmployerId(null)}
                style={[styles.compTab, selectedEmployerId === null && styles.compTabActive]}
                activeOpacity={0.75}
              >
                {selectedEmployerId === null ? (
                  <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.compTabGrad}>
                    <Text style={styles.compTabLabelActive}>All companies</Text>
                  </LinearGradient>
                ) : (
                  <Text style={styles.compTabLabel}>All</Text>
                )}
              </TouchableOpacity>

              {employers.map((emp) => {
                const isSelected = selectedEmployerId === emp.id;
                const jobCount = (emp.jobs || []).length;
                return (
                  <TouchableOpacity
                    key={emp.id}
                    onPress={() => setSelectedEmployerId(emp.id)}
                    style={[styles.compTab, isSelected && styles.compTabActive]}
                    activeOpacity={0.75}
                  >
                    {isSelected ? (
                      <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.compTabGrad}>
                        <LinearGradient colors={emp.logoColor || ['#555', '#222']} style={styles.compTabAvatar}>
                          <Text style={styles.compTabAvatarText}>{emp.logoInitial}</Text>
                        </LinearGradient>
                        <Text style={styles.compTabLabelActive} numberOfLines={1}>{emp.name.split(' ')[0]}</Text>
                        <View style={styles.compTabCount}>
                          <Text style={styles.compTabCountText}>{jobCount}</Text>
                        </View>
                      </LinearGradient>
                    ) : (
                      <View style={styles.compTabInner}>
                        <LinearGradient colors={emp.logoColor || ['#555', '#222']} style={styles.compTabAvatar}>
                          <Text style={styles.compTabAvatarText}>{emp.logoInitial}</Text>
                        </LinearGradient>
                        <Text style={styles.compTabLabel} numberOfLines={1}>{emp.name.split(' ')[0]}</Text>
                        {jobCount > 0 && (
                          <View style={styles.compTabCountMuted}>
                            <Text style={styles.compTabCountMutedText}>{jobCount}</Text>
                          </View>
                        )}
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}

              {/* Add company shortcut */}
              <TouchableOpacity onPress={openModal} style={styles.compTabAdd} activeOpacity={0.75}>
                <Ionicons name="add-circle-outline" size={14} color="rgba(255,255,255,0.45)" />
                <Text style={styles.compTabAddText}>Add</Text>
              </TouchableOpacity>
            </ScrollView>
          )}
        </View>

        {/* ══ BODY (light bg) ══════════════════════════════════════════════════ */}
        <View style={styles.body}>

          {initialLoading ? (
            <View style={styles.emptyState}>
              <ActivityIndicator size="large" color={T.blue} />
              <Text style={styles.emptyStateTitle}>Loading your dashboard...</Text>
            </View>
          ) : employers.length === 0 && loadingCompanies.length === 0 ? (
            <View style={styles.emptyState}>
              <LinearGradient colors={[T.blue, T.blueDeep]} style={styles.emptyIcon}>
                <Ionicons name="briefcase-outline" size={32} color="#fff" />
              </LinearGradient>
              <Text style={styles.emptyStateTitle}>No jobs tracked yet</Text>
              <Text style={styles.emptyStateSub}>
                Add a company career page URL or company name to let AI automatically find matching jobs and hiring contacts.
              </Text>
              <TouchableOpacity onPress={openModal} activeOpacity={0.85} style={styles.emptyBtnOuter}>
                <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.emptyBtn}>
                  <Ionicons name="add" size={18} color="white" />
                  <Text style={styles.emptyBtnText}>Add target company</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {/* Loading cards */}
              {loadingCompanies.map((company) => (
                <View key={company} style={styles.loaderCard}>
                  <View style={styles.loaderHeader}>
                    <LinearGradient colors={[T.blue, T.purple]} style={styles.loaderIcon}>
                      <ActivityIndicator size="small" color="#fff" />
                    </LinearGradient>
                    <View style={styles.loaderTexts}>
                      <Text style={styles.loaderTitle}>Analyzing {company}</Text>
                      <Text style={styles.loaderSub}>AI is scraping and matching jobs</Text>
                    </View>
                  </View>
                  <IndeterminateBar />
                  <Text style={styles.loaderNote}>This can take a minute. You can leave the app — we'll notify you when done.</Text>
                </View>
              ))}
              {loadingCompanies.length > 0 && <LoadingTips />}

              {/* ── Horizontal company card strip ── */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.companyStrip}
                style={styles.companyStripScroll}
              >
                {employers.map((employer) => (
                  <CompanyCard
                    key={employer.id}
                    employer={employer}
                    selected={selectedEmployerId === employer.id}
                    onPress={() => setSelectedEmployerId(
                      selectedEmployerId === employer.id ? null : employer.id
                    )}
                  />
                ))}
              </ScrollView>

              {/* ── Job cards for selected / all companies ── */}
              {visibleEmployers.map((employer) => (
                <View key={employer.id} style={styles.employerSection}>
                  {(employer.jobs || []).map((job) => (
                    <JobCard
                      key={job.id}
                      job={job}
                      onApply={() => handleApply(employer, job)}
                      onAddContact={() => handleAddContact(job.id)}
                      onVisitJob={job.applyUrl ? () => Linking.openURL(job.applyUrl!) : undefined}
                    />
                  ))}
                  {processingEmployerIds.has(employer.id) && (
                    <View style={styles.processingRow}>
                      <ActivityIndicator size="small" color={T.blue} />
                      <Text style={styles.processingText}>Finding more positions...</Text>
                    </View>
                  )}
                </View>
              ))}
            </>
          )}
        </View>
      </ScrollView>

      {/* ── Coming Soon Overlay ── */}
      {featureFlag?.status === 'under_construction' && (
        <View style={styles.comingSoonOverlay}>
          <View style={styles.comingSoonCard}>
            <TouchableOpacity style={styles.comingSoonBack} onPress={() => router.back()} activeOpacity={0.75}>
              <Ionicons name="arrow-back" size={18} color={T.textMuted} />
              <Text style={styles.comingSoonBackText}>Go Back</Text>
            </TouchableOpacity>
            <LinearGradient colors={[T.blue, T.blueDeep]} style={styles.comingSoonIcon}>
              <Ionicons name="rocket-outline" size={28} color="#fff" />
            </LinearGradient>
            <Text style={styles.comingSoonBadge}>COMING SOON</Text>
            <Text style={styles.comingSoonTitle}>{featureFlag.title || 'AI Job Hub'}</Text>
            <Text style={styles.comingSoonDesc}>
              {featureFlag.message || "We're building something powerful — AI will automatically research companies, match jobs to your resume, and surface verified hiring contacts."}
            </Text>
            <View style={styles.comingSoonDivider} />
            {['Auto job discovery from company pages', 'AI resume-to-job matching', 'Verified hiring manager contacts'].map((f, i) => (
              <View key={i} style={styles.featureRow}>
                <Ionicons name="checkmark-circle" size={14} color={T.blue} />
                <Text style={styles.featureText}>{f}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* ── Add Company Modal ── */}
      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={() => { setInputValue('https://'); setModalVisible(false); }}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => { setInputValue('https://'); setModalVisible(false); }}>
          <View style={styles.modalBox} onStartShouldSetResponder={() => true}>
            <View style={styles.modalHeader}>
              <LinearGradient colors={[T.blue, T.blueDeep]} style={styles.modalIconWrap}>
                <Ionicons name="business-outline" size={20} color="#fff" />
              </LinearGradient>
              <View>
                <Text style={styles.modalTitle}>Add Target Company</Text>
                <Text style={styles.modalHint}>Enter a company name or career page URL</Text>
              </View>
            </View>
            <TextInput
              style={styles.modalInput}
              placeholder="e.g. https://careers.google.com"
              placeholderTextColor={T.textFaint}
              value={inputValue}
              onChangeText={setInputValue}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleAddPill}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity onPress={() => { setInputValue('https://'); setModalVisible(false); }} style={styles.modalCancelBtn}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleAddPill} style={styles.modalConfirmOuter} activeOpacity={0.85}>
                <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.modalConfirmBtn}>
                  <Text style={styles.modalConfirmText}>Search Jobs</Text>
                  <Ionicons name="arrow-forward" size={15} color="#fff" />
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── Floating Tab Bar ── */}
      <JobHubTabBar />
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea:     { flex: 1, backgroundColor: T.bg },
  scrollView:   { flex: 1 },
  scrollContent:{ flexGrow: 1, paddingBottom: 100 },

  // ── Top bar (Letters-style) ──
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: T.bg,
  },
  backPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: T.surface,
    borderRadius: 20,
    paddingVertical: 7,
    paddingHorizontal: 12,
    shadowColor: T.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 3,
  },
  backPillText: { fontSize: 13, fontWeight: '600', color: T.ink },
  wordmark: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  wordmarkLogo: { width: 22, height: 22 },
  wordmarkText: { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  wordmarkBlue: { color: T.blue },
  addBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: T.surface,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: T.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 3,
  },

  // ── Hero card (Letters-style dark gradient with blobs) ──
  heroCard: {
    marginHorizontal: 12,
    borderRadius: 28,
    overflow: 'hidden',
    padding: 22,
    paddingBottom: 0,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 10,
  },
  blob: {
    position: 'absolute',
    borderRadius: 999,
    zIndex: 0,
  },
  heroEyeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    zIndex: 1,
  },
  heroEyebrow: {
    fontSize: 10,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.4)',
    letterSpacing: 1.5,
  },
  aiPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(34,211,238,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(34,211,238,0.25)',
    borderRadius: 20,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  pulseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#22D3EE',
  },
  aiPillText: { fontSize: 11, fontWeight: '700', color: '#22D3EE' },
  heroTitle: {
    fontSize: 30,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: -1,
    marginBottom: 6,
    zIndex: 1,
  },
  heroSub: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.5)',
    lineHeight: 18,
    marginBottom: 18,
    zIndex: 1,
  },

  // Stats row inside hero
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 10,
    marginBottom: 18,
    zIndex: 1,
  },
  statItem:   { flex: 1, alignItems: 'center' },
  statValue:  { fontSize: 18, fontWeight: '800', letterSpacing: -0.5 },
  statLabel:  { fontSize: 10, color: 'rgba(255,255,255,0.35)', fontWeight: '600', marginTop: 2 },
  statDivider:{ width: 1, height: 26, backgroundColor: 'rgba(255,255,255,0.08)' },

  // Company tabs inside hero (like step strip in Letters)
  tabScroll:  { zIndex: 1, marginBottom: 0 },
  tabScrollContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 2,
  },
  compTab: {
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  compTabActive: { borderColor: 'transparent' },
  compTabGrad: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  compTabInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  compTabAvatar: {
    width: 20,
    height: 20,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compTabAvatarText: { fontSize: 9, fontWeight: '800', color: '#fff' },
  compTabLabel: { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.55)' },
  compTabLabelActive: { fontSize: 13, fontWeight: '700', color: '#fff' },
  compTabCount: {
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  compTabCountText: { fontSize: 10, fontWeight: '700', color: '#fff' },
  compTabCountMuted: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  compTabCountMutedText: { fontSize: 10, fontWeight: '600', color: 'rgba(255,255,255,0.5)' },
  compTabAdd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 22,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.2)',
  },
  compTabAddText: { fontSize: 12, color: 'rgba(255,255,255,0.4)', fontWeight: '600' },

  // ── Body (light bg) ──
  body: {
    flex: 1,
    paddingHorizontal: 12,
  },

  // ── Empty state ──
  emptyState: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 24, paddingBottom: 40 },
  emptyIcon:  { width: 72, height: 72, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  emptyStateTitle: { fontSize: 18, fontWeight: '800', color: T.ink, letterSpacing: -0.4, marginBottom: 10, textAlign: 'center' },
  emptyStateSub: { fontSize: 13, color: T.textMuted, lineHeight: 20, textAlign: 'center', marginBottom: 28 },
  emptyBtnOuter: { borderRadius: 22, overflow: 'hidden' },
  emptyBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14, paddingHorizontal: 28 },
  emptyBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },

  // ── Loader card ──
  loaderCard: {
    backgroundColor: T.surface,
    borderRadius: 20,
    padding: 18,
    marginBottom: 14,
    shadowColor: T.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.07,
    shadowRadius: 16,
    elevation: 4,
  },
  loaderHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  loaderIcon:   { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  loaderTexts:  { flex: 1 },
  loaderTitle:  { fontSize: 14, fontWeight: '700', color: T.ink, letterSpacing: -0.3 },
  loaderSub:    { fontSize: 12, color: T.textMuted, marginTop: 2 },
  loaderNote:   { fontSize: 11, color: T.textFaint, marginTop: 10, lineHeight: 16 },

  // ── Employer section ──
  employerSection: { marginBottom: 28 },
  processingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingVertical: 8 },
  processingText: { fontSize: 12, color: T.textMuted, fontStyle: 'italic' },

  // ── Company strip (horizontal scroll) ──
  companyStripScroll: { marginBottom: 16 },
  companyStrip: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 6,
    paddingHorizontal: 2,
  },

  // ── Company bookmark cards ──
  ccWrap: {
    width: 130,
    borderRadius: 20,
    backgroundColor: T.surface,
    shadowColor: T.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.09,
    shadowRadius: 14,
    elevation: 5,
    padding: 2,                 // padding creates space for the gradient ring
  },
  ccWrapSelected: {
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 10,
  },
  ccSelectedRing: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 20,
  },
  ccInner: {
    backgroundColor: '#0D1230',
    borderRadius: 18,
    paddingVertical: 16,
    paddingHorizontal: 14,
    alignItems: 'center',
    gap: 8,
  },
  ccLogo: {
    width: 48,
    height: 48,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ccLogoText: { fontSize: 21, fontWeight: '800', color: '#fff' },
  ccName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.3,
    textAlign: 'center',
    lineHeight: 18,
  },
  ccRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ccStat: { fontSize: 12, fontWeight: '700' },
  ccDot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.25)', marginHorizontal: 2 },
  ccTick: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: T.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Job card ──
  card: {
    backgroundColor: T.surface,
    borderRadius: 22,
    marginBottom: 14,
    shadowColor: T.ink,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
    elevation: 6,
    overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 10,
    gap: 10,
  },
  cardHeaderMid: { flex: 1 },
  jobTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: T.ink,
    letterSpacing: -0.3,
    lineHeight: 20,
  },
  cardBadgesCol: {
    alignItems: 'flex-end',
    gap: 4,
    flexShrink: 0,
  },
  urgentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: 10,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  urgentText: { fontSize: 10, fontWeight: '700', color: '#EF4444' },
  matchBadge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  matchBadgeText: { fontSize: 11, fontWeight: '700' },

  // Meta chips
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 16, paddingBottom: 12 },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: T.bg,
    borderWidth: 1,
    borderColor: T.borderHi,
    borderRadius: 20,
    paddingVertical: 4,
    paddingHorizontal: 9,
  },
  metaChipText: { fontSize: 11, fontWeight: '600', color: T.textMuted },

  // Card sections (Skills / Responsibilities / Contacts)
  cardSection: {
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  cardSectionContacts: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: T.border,
    marginTop: 4,
  },
  cardSectionLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: T.textFaint,
    letterSpacing: 1.2,
    marginBottom: 8,
  },

  // Skills chips
  skillsChipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  skillChip: {
    backgroundColor: 'rgba(79,141,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(79,141,255,0.2)',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  skillChipText: { fontSize: 11, fontWeight: '600', color: T.blue },
  skillChipMore: {
    backgroundColor: 'rgba(79,141,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(79,141,255,0.25)',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  skillChipMoreText: { fontSize: 11, fontWeight: '700', color: T.blue },
  skillChipCollapse: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: T.bgSoft,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  skillChipCollapseText: { fontSize: 11, fontWeight: '600', color: T.textMuted },

  // Responsibilities
  respRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 5 },
  respDot:  { width: 5, height: 5, borderRadius: 2.5, backgroundColor: T.blue, marginTop: 6, flexShrink: 0 },
  respText: { fontSize: 12, color: T.textMuted, lineHeight: 18, flex: 1 },

  // Contact row
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  avatarInitials: { fontSize: 14, fontWeight: '700', color: 'white' },
  contactMid: { flex: 1 },
  contactName: { fontSize: 13, fontWeight: '700', color: T.ink },
  contactRole: { fontSize: 11, color: T.textFaint, marginTop: 1 },
  contactPhone: { fontSize: 11, color: T.textMuted, marginTop: 1 },
  noContactsText: { fontSize: 12, color: T.textFaint, fontStyle: 'italic' },
  contactRight: { alignItems: 'flex-end', gap: 5 },
  contactEmail: {
    fontSize: 10,
    color: T.blue,
    maxWidth: 130,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  contactBadgesRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  verifiedBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    justifyContent: 'center',
    alignItems: 'center',
  },
  linkedinBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: 'rgba(10,102,194,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(10,102,194,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Card footer
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
    paddingTop: 4,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: T.border,
  },
  addContactBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: T.bg,
    borderWidth: 1,
    borderColor: T.borderHi,
    borderRadius: 20,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  addContactBtnText: { fontSize: 12, fontWeight: '600', color: T.textMuted },
  visitJobBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(79,141,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(79,141,255,0.2)',
    borderRadius: 20,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  visitJobBtnText: { fontSize: 12, fontWeight: '600', color: T.blue },
  applyBtnOuter: { flex: 1, borderRadius: 20, overflow: 'hidden' },
  applyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
  },
  applyBtnText: { fontSize: 13, fontWeight: '700', color: '#fff', letterSpacing: -0.2 },

  // ── Modal ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(11,15,34,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalBox: {
    backgroundColor: T.surface,
    borderRadius: 28,
    padding: 24,
    width: '100%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.2,
    shadowRadius: 40,
    elevation: 20,
  },
  modalHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  modalIconWrap: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  modalTitle: { fontSize: 17, fontWeight: '800', color: T.ink, letterSpacing: -0.4 },
  modalHint: { fontSize: 12, color: T.textMuted, marginTop: 2 },
  modalInput: {
    backgroundColor: T.bg,
    borderWidth: 1,
    borderColor: T.borderHi,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 13,
    fontSize: 14,
    color: T.ink,
    marginBottom: 16,
  },
  modalButtons: { flexDirection: 'row', gap: 10 },
  modalCancelBtn: { flex: 1, backgroundColor: T.bg, borderRadius: 14, paddingVertical: 13, alignItems: 'center' },
  modalCancelText: { fontSize: 14, fontWeight: '600', color: T.textMuted },
  modalConfirmOuter: { flex: 2, borderRadius: 14, overflow: 'hidden' },
  modalConfirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
  },
  modalConfirmText: { fontSize: 14, fontWeight: '700', color: '#fff' },

  // ── Coming Soon Overlay ──
  comingSoonOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(10,15,36,0.82)',
    alignItems: 'center', justifyContent: 'center', zIndex: 999, paddingHorizontal: 28,
  },
  comingSoonCard: {
    backgroundColor: T.surface, borderRadius: 28, padding: 28, width: '100%', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 16 }, shadowOpacity: 0.18, shadowRadius: 40, elevation: 16,
  },
  comingSoonBack: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 4, marginBottom: 18, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: T.bg, borderRadius: 10 },
  comingSoonBackText: { fontSize: 13, fontWeight: '600', color: T.textMuted },
  comingSoonIcon: { width: 60, height: 60, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  comingSoonBadge: { fontSize: 10, fontWeight: '800', color: T.blue, letterSpacing: 1.5, marginBottom: 6 },
  comingSoonTitle: { fontSize: 22, fontWeight: '800', color: T.ink, letterSpacing: -0.5, marginBottom: 10 },
  comingSoonDesc: { fontSize: 13, color: T.textMuted, textAlign: 'center', lineHeight: 19, marginBottom: 18 },
  comingSoonDivider: { height: 1, backgroundColor: T.border, width: '100%', marginBottom: 16 },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', marginBottom: 8 },
  featureText: { fontSize: 13, color: '#334155', fontWeight: '500' },
});
