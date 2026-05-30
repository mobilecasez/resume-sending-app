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

// ─── Design tokens (matching HomeScreen) ─────────────────────────────────────
const T = {
  bg:        '#E5EAF3',
  bgSoft:    '#DCE2ED',
  surface:   '#FFFFFF',
  ink:       '#0B0F22',
  textMuted: '#5B6B8A',
  textFaint: '#8896B0',
  border:    'rgba(11,15,34,0.06)',
  borderHi:  'rgba(11,15,34,0.10)',
  blue:      '#4F8DFF',
  blueDeep:  '#2563EB',
  purple:    '#7C6BFF',
  teal:      '#14B8A6',
  emerald:   '#10B981',
  rose:      '#EF4444',
  navBg:     '#0A0F24',
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
        skills: ['SwiftUI', 'Combine', 'Core Data', 'UIKit'], responsibilities: ['Build iOS features with SwiftUI', 'Maintain Core Data persistence layer', 'Collaborate with design team', 'Review pull requests'],
        contacts: [
          {
            id: 'apple-c1',
            name: 'Sarah Chen',
            role: 'Engineering Manager',
            email: 's.chen@apple.com',
            verified: true,
            avatarColor: ['#06B6D4', '#3B82F6'],
          },
          {
            id: 'apple-c2',
            name: 'James Park',
            role: 'Senior Recruiter',
            email: 'j.park@apple.com',
            verified: true,
            avatarColor: ['#8B5CF6', '#6D28D9'],
          },
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
        skills: ['PyTorch', 'Core ML', 'Python', 'NLP', 'LLMs'], responsibilities: ['Train and fine-tune ML models', 'Deploy models to production', 'Collaborate with product teams', 'Monitor model performance'],
        contacts: [
          {
            id: 'apple-c3',
            name: 'Priya Nair',
            role: 'ML Team Lead',
            email: 'p.nair@apple.com',
            verified: true,
            avatarColor: ['#10B981', '#059669'],
          },
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
          {
            id: 'stripe-c1',
            name: 'Alex Rivera',
            role: 'Engineering Manager',
            email: 'a.rivera@stripe.com',
            verified: true,
            avatarColor: ['#635BFF', '#4338CA'],
          },
          {
            id: 'stripe-c2',
            name: 'Mia Thompson',
            role: 'Technical Recruiter',
            email: 'm.thompson@stripe.com',
            verified: false,
            avatarColor: ['#F59E0B', '#D97706'],
          },
        ],
      },
    ],
  },
];

const INITIAL_PILLS: WishlistPill[] = [
  { id: '1', label: 'Apple Inc.', colorVariant: 'cyan', employerId: 'apple' },
  { id: '2', label: 'Stripe', colorVariant: 'violet', employerId: 'stripe' },
  { id: '3', label: 'careers.openai.com', colorVariant: 'emerald' },
];

const INITIAL_STATS = { matches: 12, contacts: 7, verifiedPct: 94 };

// ─────────────────────────────────────────────────────────────────
// PILL COLOR MAP
// ─────────────────────────────────────────────────────────────────

const PILL_COLORS = {
  cyan: {
    bg: 'rgba(6,182,212,0.15)',
    border: 'rgba(6,182,212,0.28)',
    text: '#67E8F9',
  },
  violet: {
    bg: 'rgba(139,92,246,0.15)',
    border: 'rgba(139,92,246,0.28)',
    text: '#C4B5FD',
  },
  emerald: {
    bg: 'rgba(16,185,129,0.15)',
    border: 'rgba(16,185,129,0.28)',
    text: '#6EE7B7',
  },
} as const;

const COLOR_CYCLE: Array<'cyan' | 'violet' | 'emerald'> = ['cyan', 'violet', 'emerald'];

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
      {contact.imageUrl ? (
        <Image source={{ uri: contact.imageUrl }} style={styles.avatar} />
      ) : (
        <LinearGradient colors={contact.avatarColor} style={styles.avatar}>
          <Text style={styles.avatarInitials}>{initials}</Text>
        </LinearGradient>
      )}

      <View style={styles.contactMid}>
        <Text style={styles.contactName}>{contact.name}</Text>
        <Text style={styles.contactRole}>{contact.role}</Text>
        {!!contact.phone && (
          <Text style={styles.contactPhone}>{contact.phone}</Text>
        )}
      </View>

      <View style={styles.contactRight}>
        {!!contact.email && (
          <Text style={styles.contactEmail} numberOfLines={1}>
            {contact.email}
          </Text>
        )}
        <View style={styles.contactBadgesRow}>
          {contact.verified && (
            <LinearGradient
              colors={['#10B981', '#059669']}
              style={styles.verifiedBadge}
            >
              <Ionicons name="checkmark" size={9} color="white" />
            </LinearGradient>
          )}
          {!!contact.linkedin && (
            <TouchableOpacity onPress={openLinkedIn} style={styles.linkedinBtn}>
              <Ionicons name="logo-linkedin" size={14} color="#0A66C2" />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────
// JOB CARD (redesigned)
// ─────────────────────────────────────────────────────────────────

type JobCardProps = {
  job: Job;
  employer: Employer;
  onApply: () => void;
  onAddContact: () => void;
  onVisitJob?: () => void;
};

const JobCard: React.FC<JobCardProps> = ({ job, employer, onApply, onAddContact, onVisitJob }) => (
  <View style={styles.card}>
    {/* ── Card Header: company logo + title + match ── */}
    <View style={styles.cardHeader}>
      <LinearGradient colors={employer.logoColor || ['#555', '#222']} style={styles.cardLogo}>
        <Text style={styles.cardLogoText}>{employer.logoInitial}</Text>
      </LinearGradient>
      <View style={styles.cardHeaderMid}>
        <Text style={styles.cardCompanyLabel}>{employer.name}</Text>
        <Text style={styles.jobTitle} numberOfLines={2}>{job.title}</Text>
      </View>
      {job.matchScore != null && job.matchScore > 0 && (
        <View style={[
          styles.matchBadge,
          { backgroundColor: job.matchScore >= 70 ? 'rgba(16,185,129,0.12)' : job.matchScore >= 40 ? 'rgba(251,146,60,0.12)' : 'rgba(148,163,184,0.12)' }
        ]}>
          <Text style={[
            styles.matchBadgeText,
            { color: job.matchScore >= 70 ? '#059669' : job.matchScore >= 40 ? '#EA580C' : '#64748B' }
          ]}>{job.matchScore}%</Text>
          <Text style={[styles.matchBadgeLabel, { color: job.matchScore >= 70 ? '#059669' : job.matchScore >= 40 ? '#EA580C' : '#64748B' }]}>match</Text>
        </View>
      )}
      {job.urgent && (
        <View style={styles.urgentBadge}>
          <Ionicons name="flash" size={11} color="#EF4444" />
          <Text style={styles.urgentText}>Urgent</Text>
        </View>
      )}
    </View>

    {/* ── Meta chips ── */}
    <View style={styles.metaRow}>
      <View style={styles.metaChip}>
        <Ionicons name="location-outline" size={11} color={T.blue} />
        <Text style={styles.metaChipText}>{job.location}</Text>
      </View>
      {job.experience ? (
        <View style={styles.metaChip}>
          <Ionicons name="time-outline" size={11} color="#A78BFA" />
          <Text style={styles.metaChipText}>{job.experience}</Text>
        </View>
      ) : null}
      {job.salary && job.salary !== 'Not listed' ? (
        <View style={styles.metaChip}>
          <Ionicons name="cash-outline" size={11} color="#34D399" />
          <Text style={styles.metaChipText}>{job.salary}</Text>
        </View>
      ) : null}
      {job.jobType ? (
        <View style={styles.metaChip}>
          <Ionicons name="briefcase-outline" size={11} color="#FB923C" />
          <Text style={styles.metaChipText}>{job.jobType}</Text>
        </View>
      ) : null}
    </View>

    {/* ── Skills ── */}
    {(job.skills || []).length > 0 && (
      <View style={styles.skillsBlock}>
        <View style={styles.skillsChipsRow}>
          {(job.skills || []).slice(0, 5).map((skill, i) => (
            <View key={i} style={styles.skillChip}>
              <Text style={styles.skillChipText}>{skill}</Text>
            </View>
          ))}
          {(job.skills || []).length > 5 && (
            <View style={styles.skillChipMore}>
              <Text style={styles.skillChipMoreText}>+{job.skills.length - 5}</Text>
            </View>
          )}
        </View>
      </View>
    )}

    {/* ── Responsibilities preview ── */}
    {(job.responsibilities || []).length > 0 && (
      <View style={styles.respPreview}>
        {(job.responsibilities || []).slice(0, 2).map((r, i) => (
          <View key={i} style={styles.respRow}>
            <View style={styles.respDotCircle} />
            <Text style={styles.respText}>{r}</Text>
          </View>
        ))}
      </View>
    )}

    {/* ── Divider ── */}
    <View style={styles.cardDivider} />

    {/* ── Contacts ── */}
    <View style={styles.contactsZone}>
      <Text style={styles.contactsLabel}>HIRING CONTACTS</Text>
      {(job.contacts || []).length > 0 ? (
        (job.contacts || []).map((contact) => (
          <ContactRow key={contact.id} contact={contact} />
        ))
      ) : (
        <Text style={styles.noContactsText}>No contacts found for this listing</Text>
      )}
    </View>

    {/* ── Card Footer ── */}
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

// ─────────────────────────────────────────────────────────────────
// COMPANY TAB BAR
// ─────────────────────────────────────────────────────────────────

type CompanyTabBarProps = {
  employers: Employer[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
};

const CompanyTabBar: React.FC<CompanyTabBarProps> = ({ employers, selectedId, onSelect }) => {
  if (employers.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.companyTabScroll}
      contentContainerStyle={styles.companyTabContent}
    >
      {/* "All" tab */}
      <TouchableOpacity
        onPress={() => onSelect(null)}
        style={[styles.companyTab, selectedId === null && styles.companyTabActive]}
        activeOpacity={0.75}
      >
        {selectedId === null ? (
          <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.companyTabGradient}>
            <Text style={styles.companyTabLabelActive}>All</Text>
          </LinearGradient>
        ) : (
          <Text style={styles.companyTabLabel}>All</Text>
        )}
      </TouchableOpacity>

      {employers.map((emp) => {
        const isSelected = selectedId === emp.id;
        return (
          <TouchableOpacity
            key={emp.id}
            onPress={() => onSelect(emp.id)}
            style={[styles.companyTab, isSelected && styles.companyTabActive]}
            activeOpacity={0.75}
          >
            {isSelected ? (
              <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.companyTabGradient}>
                <LinearGradient colors={emp.logoColor || ['#555', '#222']} style={styles.companyTabAvatarSmall}>
                  <Text style={styles.companyTabAvatarText}>{emp.logoInitial}</Text>
                </LinearGradient>
                <Text style={styles.companyTabLabelActive} numberOfLines={1}>{emp.name}</Text>
              </LinearGradient>
            ) : (
              <>
                <LinearGradient colors={emp.logoColor || ['#555', '#222']} style={styles.companyTabAvatarSmall}>
                  <Text style={styles.companyTabAvatarText}>{emp.logoInitial}</Text>
                </LinearGradient>
                <Text style={styles.companyTabLabel} numberOfLines={1}>{emp.name.split(' ')[0]}</Text>
              </>
            )}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
};

// ─────────────────────────────────────────────────────────────────
// INDETERMINATE PROGRESS BAR
// ─────────────────────────────────────────────────────────────────

function IndeterminateBar() {
  const translateX = useRef(new Animated.Value(-1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(translateX, {
          toValue: 1,
          duration: 1400,
          useNativeDriver: true,
        }),
        Animated.timing(translateX, {
          toValue: -1,
          duration: 1400,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [translateX]);

  return (
    <View style={indeterminateStyles.track}>
      <Animated.View
        style={[
          indeterminateStyles.fill,
          {
            transform: [
              {
                translateX: translateX.interpolate({
                  inputRange: [-1, 1],
                  outputRange: ['-100%' as unknown as number, '100%' as unknown as number],
                }),
              },
            ],
          },
        ]}
      />
    </View>
  );
}

const indeterminateStyles = StyleSheet.create({
  track: {
    height: 4,
    backgroundColor: T.border,
    borderRadius: 2,
    marginTop: 10,
    overflow: 'hidden',
  },
  fill: {
    position: 'absolute',
    left: 0,
    width: '50%',
    height: '100%',
    backgroundColor: T.blue,
    borderRadius: 2,
  },
});

// ─────────────────────────────────────────────────────────────────
// BOTTOM TAB BAR (local — handles expo-router nav from ai-hub)
// ─────────────────────────────────────────────────────────────────

function JobHubTabBar({ onAddPress }: { onAddPress: () => void }) {
  const router = useRouter();

  const TABS = [
    { key: 'home',    label: 'Home',    icon: 'home-outline',          iconActive: 'home' },
    { key: 'jobs',    label: 'Jobs',    icon: 'briefcase-outline',     iconActive: 'briefcase' },
    { key: 'letters', label: 'Letters', icon: 'document-text-outline', iconActive: 'document-text' },
    { key: 'me',      label: 'Me',      icon: 'person-outline',        iconActive: 'person' },
  ];

  function handlePress(key: string) {
    if (key === 'jobs') return; // already here
    if (key === 'home' || key === 'letters' || key === 'me') {
      router.back();
    }
  }

  return (
    <View style={tabBarStyles.wrapper}>
      <View style={tabBarStyles.bar}>
        {TABS.map((tab) => {
          const isActive = tab.key === 'jobs';
          if (isActive) {
            return (
              <LinearGradient
                key={tab.key}
                colors={[T.blue, T.blueDeep]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={tabBarStyles.activeTab}
              >
                <TouchableOpacity
                  style={tabBarStyles.activeTabInner}
                  onPress={() => handlePress(tab.key)}
                  activeOpacity={0.85}
                >
                  <Ionicons name={tab.iconActive as any} size={16} color="#fff" />
                  <Text style={tabBarStyles.activeLabel}>{tab.label}</Text>
                </TouchableOpacity>
              </LinearGradient>
            );
          }
          return (
            <TouchableOpacity
              key={tab.key}
              style={tabBarStyles.tab}
              onPress={() => handlePress(tab.key)}
              activeOpacity={0.7}
            >
              <Ionicons name={tab.icon as any} size={20} color={T.textFaint} />
              <Text style={tabBarStyles.tabLabel}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const tabBarStyles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingBottom: 28,
    paddingTop: 8,
    backgroundColor: 'transparent',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: T.surface,
    borderRadius: 28,
    paddingVertical: 8,
    paddingHorizontal: 8,
    gap: 4,
    shadowColor: T.ink,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
    elevation: 12,
  },
  activeTab: {
    flex: 1,
    borderRadius: 22,
  },
  activeTabInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  activeLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.2,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 6,
  },
  tabLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: T.textFaint,
    letterSpacing: -0.1,
  },
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

  // Feature flag — controls "coming soon" overlay
  const [featureFlag, setFeatureFlag] = useState<{ status: string; title: string | null; message: string | null } | null>(null);

  // Pulse animation for AI active dot
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.5, duration: 700, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1.0, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  // Recalculate stats whenever employers list changes
  useEffect(() => {
    let newMatches = 0;
    let newContacts = 0;
    employers.forEach(emp => {
      newMatches += (emp.jobs || []).length;
      newContacts += (emp.jobs || []).reduce((sum, j) => sum + (j.contacts || []).length, 0);
    });
    setStats({ sources: employers.length, matches: newMatches, contacts: newContacts, verifiedPct: 94 });
  }, [employers]);

  // Fetch feature flag for this page
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
           setEmployers([]);
           setPills([]);
           setInitialLoading(false);
           return;
        }

        const loadedEmployers: Employer[] = [];
        const loadedPills: WishlistPill[] = [];
        const loadedStats = { sources: dashboard.length, matches: 0, contacts: 0 };
        const currentlyProcessing = new Set<string>();

        dashboard.forEach((entry, i) => {
          const emp = entry.employer;
          loadedEmployers.push(emp);
          loadedPills.push({
            id: `pill-${emp.id}`,
            label: emp.name,
            colorVariant: COLOR_CYCLE[i % 3],
            employerId: emp.id
          });
          loadedStats.matches += (emp.jobs || []).length;
          loadedStats.contacts += (emp.jobs || []).reduce((sum, j) => sum + (j.contacts || []).length, 0);

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
    let firstPartialReceived = false;

    const onPartialUpdate = (partialEmployer: Employer) => {
      if (!firstPartialReceived) {
        firstPartialReceived = true;
      }
      setEmployers((prev) => {
        const idx = prev.findIndex((e) => e.id === partialEmployer.id);
        if (idx >= 0) {
          const arr = [...prev];
          arr[idx] = partialEmployer;
          return arr;
        }
        return [partialEmployer, ...prev];
      });
    };

    resumeJobPolling(jobId, onPartialUpdate)
      .then((finalEmployer) => {
        setProcessingEmployerIds((prev) => {
          const next = new Set(prev);
          next.delete(finalEmployer.id);
          return next;
        });
        setEmployers((prev) => {
          const idx = prev.findIndex((e) => e.id === finalEmployer.id);
          if (idx >= 0) {
            const arr = [...prev];
            arr[idx] = finalEmployer;
            return arr;
          }
          return [finalEmployer, ...prev];
        });
      })
      .catch(() => {
        Alert.alert('Error', `Failed to resume tracking jobs for ${companyName}`);
      });
  };

  const handleRemovePill = useCallback((id: string) => {
    setPills((prev) => {
      const pill = prev.find((p) => p.id === id);
      if (pill?.employerId) {
        const targetEmployer = employers.find((e) => e.id === pill.employerId);
        if (targetEmployer?.jobId) {
          removeDashboardItem(targetEmployer.jobId).catch(console.error);
        }
        setEmployers((emp) => emp.filter((e) => e.id !== pill.employerId));
        if (selectedEmployerId === pill.employerId) setSelectedEmployerId(null);
      }
      return prev.filter((p) => p.id !== id);
    });
  }, [employers, selectedEmployerId]);

  const handleAddPill = useCallback(() => {
    let trimmed = inputValue.trim();
    if (!trimmed || trimmed === 'https://' || trimmed === 'http://') return;

    if (!/^https?:\/\//i.test(trimmed) && /\./.test(trimmed)) {
      trimmed = `https://${trimmed}`;
    }

    const pillId = `pill-${Date.now()}`;

    setPills((prev) => {
      const nextVariant = COLOR_CYCLE[prev.length % 3];
      return [...prev, { id: pillId, label: trimmed, colorVariant: nextVariant }];
    });
    setLoadingCompanies((prev) => [...prev, trimmed]);
    setInputValue('');
    setModalVisible(false);

    let firstPartialReceived = false;

    const onPartialUpdate = (partialEmployer: Employer) => {
      if (!firstPartialReceived) {
        firstPartialReceived = true;
        setLoadingCompanies((prev) => prev.filter((c) => c !== trimmed));
        setProcessingEmployerIds((prev) => new Set([...prev, partialEmployer.id]));
        setPills((prev) =>
          prev.map((p) => (p.id === pillId ? { ...p, employerId: partialEmployer.id } : p))
        );
      }
      setEmployers((prev) => {
        const idx = prev.findIndex((e) => e.id === partialEmployer.id);
        if (idx >= 0) {
          const arr = [...prev];
          arr[idx] = partialEmployer;
          return arr;
        }
        return [partialEmployer, ...prev];
      });
    };

    fetchJobMatches(trimmed, onPartialUpdate)
      .then((employer) => {
        setProcessingEmployerIds((prev) => {
          const next = new Set(prev);
          next.delete(employer.id);
          return next;
        });
        setEmployers((prev) => {
          const idx = prev.findIndex((e) => e.id === employer.id);
          return idx >= 0
            ? prev.map((e, i) => (i === idx ? employer : e))
            : [...prev, employer];
        });
        setPills((prev) =>
          prev.map((p) => (p.id === pillId ? { ...p, employerId: employer.id } : p))
        );
      })
      .catch((err) => {
        const isPortal = err?.response?.data?.error === 'job_portal' || err?.isPortal;
        if (isPortal) {
          const portal = err?.response?.data?.portal || trimmed;
          Alert.alert(
            '🚫 Job Portal Detected',
            `"${portal}" is a job listing portal, not a company.\n\nCVApplyr works exclusively on employer career pages — we go directly to the source to find jobs and hiring contacts.\n\nPlease enter a specific company name or their career page URL.\n\nExample: "https://careers.google.com"`,
            [{ text: 'Got it', style: 'default' }]
          );
        } else {
          Alert.alert('Could not fetch jobs', `No results found for "${trimmed}". Try a full URL like https://careers.company.com`);
        }
        setPills((prev) => prev.filter((p) => p.id !== pillId));
      })
      .finally(() => {
        setLoadingCompanies((prev) => prev.filter((c) => c !== trimmed));
      });
  }, [inputValue]);

  const handleApply = useCallback(
    (employer: Employer, job: Job) => {
      router.push({
        pathname: '/(ai-hub)/job-detail',
        params: {
          jobStr: JSON.stringify(job),
          employerStr: JSON.stringify({
            id: employer.id,
            name: employer.name,
            subInfo: employer.subInfo,
            logoColor: employer.logoColor,
            logoInitial: employer.logoInitial
          })
        }
      });
    },
    [router]
  );

  const handleAddContact = useCallback(
    (jobId: string) => {
      router.push({ pathname: '/(ai-hub)/add-contact', params: { jobId } });
    },
    [router]
  );

  // Filter employers for selected tab
  const visibleEmployers = selectedEmployerId
    ? employers.filter((e) => e.id === selectedEmployerId)
    : employers;

  const openModal = () => { setInputValue('https://'); setModalVisible(true); };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ─── Dark navy hero header ─── */}
        <LinearGradient
          colors={['#0A0F24', '#111827']}
          style={styles.hero}
        >
          {/* Top row: title + add button */}
          <View style={styles.heroTopRow}>
            <View>
              <Text style={styles.heroEyebrow}>AI-POWERED</Text>
              <Text style={styles.heroTitle}>Job Hub</Text>
            </View>
            <TouchableOpacity onPress={openModal} style={styles.heroAddBtn} activeOpacity={0.85}>
              <LinearGradient
                colors={[T.blue, T.blueDeep]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.heroAddBtnGradient}
              >
                <Ionicons name="add" size={18} color="#fff" />
                <Text style={styles.heroAddBtnText}>Add Company</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>

          {/* AI status row */}
          {employers.length > 0 && (
            <View style={styles.aiStatusRow}>
              <Animated.View style={[styles.pulseDot, { transform: [{ scale: pulseAnim }] }]} />
              <Text style={styles.aiStatusText}>
                AI active · {stats.sources} {stats.sources === 1 ? 'company' : 'companies'} · {stats.matches} {stats.matches === 1 ? 'match' : 'matches'} · {stats.contacts} contacts
              </Text>
            </View>
          )}

          {/* Stats row */}
          {employers.length > 0 && (
            <View style={styles.statsRow}>
              <View style={styles.statChip}>
                <Text style={[styles.statValue, { color: '#22D3EE' }]}>{stats.matches}</Text>
                <Text style={styles.statLabel}>Matches</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statChip}>
                <Text style={[styles.statValue, { color: '#A78BFA' }]}>{stats.contacts}</Text>
                <Text style={styles.statLabel}>Contacts</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statChip}>
                <Text style={[styles.statValue, { color: '#34D399' }]}>{stats.verifiedPct}%</Text>
                <Text style={styles.statLabel}>Verified</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statChip}>
                <Text style={[styles.statValue, { color: '#FB923C' }]}>{stats.sources}</Text>
                <Text style={styles.statLabel}>Companies</Text>
              </View>
            </View>
          )}

          {/* Tracked company pills (with remove) */}
          {pills.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.pillsRow}
            >
              {pills.map((pill) => {
                const c = PILL_COLORS[pill.colorVariant];
                return (
                  <View key={pill.id} style={[styles.pill, { backgroundColor: c.bg, borderColor: c.border }]}>
                    <Text style={[styles.pillText, { color: c.text }]} numberOfLines={1}>{pill.label}</Text>
                    <TouchableOpacity
                      onPress={() => handleRemovePill(pill.id)}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    >
                      <Ionicons name="close-circle" size={13} color={c.text} />
                    </TouchableOpacity>
                  </View>
                );
              })}
              <TouchableOpacity onPress={openModal} style={styles.addPillTrigger}>
                <Ionicons name="add-outline" size={13} color="rgba(255,255,255,0.4)" />
                <Text style={styles.addPillText}>Add...</Text>
              </TouchableOpacity>
            </ScrollView>
          )}
        </LinearGradient>

        {/* ─── Light content panel ─── */}
        <View style={styles.panel}>

          {/* Company tab switcher */}
          <CompanyTabBar
            employers={employers}
            selectedId={selectedEmployerId}
            onSelect={setSelectedEmployerId}
          />

          {/* ─── Content ─── */}
          {initialLoading ? (
            <View style={styles.emptyState}>
              <ActivityIndicator size="large" color={T.blue} />
              <Text style={styles.emptyStateTitle}>Loading your dashboard...</Text>
            </View>
          ) : employers.length === 0 && loadingCompanies.length === 0 ? (
            <View style={styles.emptyState}>
              <LinearGradient colors={[T.blue, T.blueDeep]} style={styles.emptyStateIcon}>
                <Ionicons name="briefcase-outline" size={32} color="#fff" />
              </LinearGradient>
              <Text style={styles.emptyStateTitle}>No jobs tracked yet</Text>
              <Text style={styles.emptyStateSub}>
                Add a company career page URL or company name to let AI automatically find matching jobs and hiring contacts.
              </Text>
              <TouchableOpacity onPress={openModal} activeOpacity={0.85} style={styles.emptyStateBtnOuter}>
                <LinearGradient
                  colors={[T.blue, T.blueDeep]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.emptyStateBtn}
                >
                  <Ionicons name="add" size={18} color="white" />
                  <Text style={styles.emptyStateBtnText}>Add target company</Text>
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
                  <Text style={styles.loaderFootnote}>
                    This can take a minute. You can leave the app — we'll notify you when done.
                  </Text>
                </View>
              ))}

              {loadingCompanies.length > 0 && <LoadingTips />}

              {/* Employer sections */}
              {visibleEmployers.map((employer) => (
                <View key={employer.id} style={styles.employerSection}>
                  {/* Employer header card */}
                  <View style={styles.employerHeaderCard}>
                    <LinearGradient colors={employer.logoColor || ['#555', '#222']} style={styles.employerLogo}>
                      <Text style={styles.employerLogoText}>{employer.logoInitial}</Text>
                    </LinearGradient>
                    <View style={styles.employerInfo}>
                      <Text style={styles.employerName}>{employer.name}</Text>
                      <Text style={styles.employerSub}>{employer.subInfo}</Text>
                    </View>
                    <View style={[
                      styles.jobCountBadge,
                      employer.status === 'active' ? styles.jobCountBadgeActive : styles.jobCountBadgeWatching
                    ]}>
                      <Text style={[
                        styles.jobCountText,
                        employer.status === 'active' ? styles.jobCountTextActive : styles.jobCountTextWatching
                      ]}>
                        {(employer.jobs || []).length} {(employer.jobs || []).length === 1 ? 'job' : 'jobs'}
                      </Text>
                    </View>
                  </View>

                  {/* Job cards */}
                  {(employer.jobs || []).map((job) => (
                    <JobCard
                      key={job.id}
                      job={job}
                      employer={employer}
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

      {/* ── Coming Soon Overlay (DB-controlled) ── */}
      {featureFlag?.status === 'under_construction' && (
        <View style={styles.comingSoonOverlay}>
          <View style={styles.comingSoonCard}>
            <TouchableOpacity
              style={styles.comingSoonBackBtn}
              onPress={() => router.back()}
              activeOpacity={0.75}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="arrow-back" size={18} color={T.textMuted} />
              <Text style={styles.comingSoonBackText}>Go Back</Text>
            </TouchableOpacity>
            <LinearGradient
              colors={[T.blue, T.blueDeep]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.comingSoonIconWrap}
            >
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
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => { setInputValue('https://'); setModalVisible(false); }}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => { setInputValue('https://'); setModalVisible(false); }}
        >
          <View style={styles.modalBox} onStartShouldSetResponder={() => true}>
            <View style={styles.modalHeader}>
              <LinearGradient colors={[T.blue, T.blueDeep]} style={styles.modalIconWrap}>
                <Ionicons name="business-outline" size={20} color="#fff" />
              </LinearGradient>
              <Text style={styles.modalTitle}>Add Target Company</Text>
            </View>
            <Text style={styles.modalHint}>Enter a company name or career page URL</Text>
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
              <TouchableOpacity
                onPress={() => { setInputValue('https://'); setModalVisible(false); }}
                style={styles.modalCancelBtn}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleAddPill} style={styles.modalAddBtnOuter} activeOpacity={0.85}>
                <LinearGradient
                  colors={[T.blue, T.blueDeep]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.modalAddBtn}
                >
                  <Text style={styles.modalAddBtnText}>Search Jobs</Text>
                  <Ionicons name="arrow-forward" size={15} color="#fff" />
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── Floating Tab Bar ── */}
      <JobHubTabBar onAddPress={openModal} />
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: T.navBg,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: 100,
  },

  // ── Hero header ──
  hero: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 22,
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  heroEyebrow: {
    fontSize: 10,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.35)',
    letterSpacing: 1.5,
    marginBottom: 3,
  },
  heroTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: -0.8,
  },
  heroAddBtn: {
    borderRadius: 22,
    overflow: 'hidden',
  },
  heroAddBtnGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 22,
  },
  heroAddBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.2,
  },
  aiStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  pulseDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#22D3EE',
  },
  aiStatusText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    fontStyle: 'italic',
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
    borderRadius: 20,
    paddingVertical: 14,
    paddingHorizontal: 20,
    marginBottom: 14,
    justifyContent: 'space-between',
  },
  statChip: {
    alignItems: 'center',
    flex: 1,
  },
  statValue: {
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  statLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.35)',
    fontWeight: '600',
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 28,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  pillsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 30,
    borderWidth: 1,
    paddingVertical: 5,
    paddingHorizontal: 10,
    gap: 5,
    maxWidth: 160,
  },
  pillText: {
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
  },
  addPillTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 30,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.2)',
    paddingVertical: 5,
    paddingHorizontal: 10,
    gap: 4,
  },
  addPillText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.3)',
  },

  // ── Light panel ──
  panel: {
    flex: 1,
    backgroundColor: T.bg,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 8,
    paddingHorizontal: 16,
    minHeight: 400,
  },

  // ── Company tab bar ──
  companyTabScroll: {
    marginBottom: 16,
  },
  companyTabContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  companyTab: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 22,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.border,
    overflow: 'hidden',
    shadowColor: T.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  companyTabActive: {
    borderColor: 'transparent',
  },
  companyTabGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  companyTabAvatarSmall: {
    width: 20,
    height: 20,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  companyTabAvatarText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#fff',
  },
  companyTabLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: T.textMuted,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  companyTabLabelActive: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
  },

  // ── Empty state ──
  emptyState: {
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  emptyStateIcon: {
    width: 72,
    height: 72,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  emptyStateTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: T.ink,
    letterSpacing: -0.4,
    marginBottom: 10,
    textAlign: 'center',
  },
  emptyStateSub: {
    fontSize: 13,
    color: T.textMuted,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 28,
  },
  emptyStateBtnOuter: {
    borderRadius: 22,
    overflow: 'hidden',
  },
  emptyStateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 28,
  },
  emptyStateBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },

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
  loaderHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  loaderIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loaderTexts: {
    flex: 1,
  },
  loaderTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: T.ink,
    letterSpacing: -0.3,
  },
  loaderSub: {
    fontSize: 12,
    color: T.textMuted,
    marginTop: 2,
  },
  loaderFootnote: {
    fontSize: 11,
    color: T.textFaint,
    marginTop: 10,
    lineHeight: 16,
  },

  // ── Employer section ──
  employerSection: {
    marginBottom: 28,
  },
  employerHeaderCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: T.surface,
    borderRadius: 18,
    padding: 14,
    marginBottom: 12,
    shadowColor: T.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 3,
  },
  employerLogo: {
    width: 44,
    height: 44,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  employerLogoText: {
    fontSize: 18,
    fontWeight: '800',
    color: '#fff',
  },
  employerInfo: {
    flex: 1,
  },
  employerName: {
    fontSize: 15,
    fontWeight: '700',
    color: T.ink,
    letterSpacing: -0.3,
  },
  employerSub: {
    fontSize: 11,
    color: T.textFaint,
    marginTop: 2,
  },
  jobCountBadge: {
    borderRadius: 20,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  jobCountBadgeActive: { backgroundColor: '#DCFCE7' },
  jobCountBadgeWatching: { backgroundColor: 'rgba(79,141,255,0.12)' },
  jobCountText: {
    fontSize: 11,
    fontWeight: '700',
  },
  jobCountTextActive: { color: '#15803D' },
  jobCountTextWatching: { color: T.blue },
  processingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
    paddingVertical: 8,
  },
  processingText: {
    fontSize: 12,
    color: T.textMuted,
    fontStyle: 'italic',
  },

  // ── Job Card ──
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
    padding: 16,
    paddingBottom: 12,
    gap: 12,
  },
  cardLogo: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  cardLogoText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#fff',
  },
  cardHeaderMid: {
    flex: 1,
  },
  cardCompanyLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: T.textFaint,
    letterSpacing: 0.5,
    marginBottom: 3,
    textTransform: 'uppercase',
  },
  jobTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: T.ink,
    letterSpacing: -0.3,
    lineHeight: 20,
  },
  matchBadge: {
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 5,
    flexShrink: 0,
  },
  matchBadgeText: {
    fontSize: 13,
    fontWeight: '800',
    lineHeight: 16,
  },
  matchBadgeLabel: {
    fontSize: 9,
    fontWeight: '600',
    lineHeight: 12,
  },
  urgentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: 10,
    paddingVertical: 5,
    paddingHorizontal: 8,
    flexShrink: 0,
  },
  urgentText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#EF4444',
  },

  // Meta chips
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: T.bg,
    borderWidth: 1,
    borderColor: T.border,
    borderRadius: 20,
    paddingVertical: 4,
    paddingHorizontal: 9,
  },
  metaChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: T.textMuted,
  },

  // Skills
  skillsBlock: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  skillsChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  skillChip: {
    backgroundColor: 'rgba(79,141,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(79,141,255,0.18)',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  skillChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: T.blue,
  },
  skillChipMore: {
    backgroundColor: T.bgSoft,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  skillChipMoreText: {
    fontSize: 11,
    fontWeight: '600',
    color: T.textMuted,
  },

  // Responsibilities
  respPreview: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 5,
  },
  respRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  respDotCircle: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: T.blue,
    marginTop: 6,
    flexShrink: 0,
  },
  respText: {
    fontSize: 12,
    color: T.textMuted,
    lineHeight: 18,
    flex: 1,
  },

  // Divider
  cardDivider: {
    height: 1,
    backgroundColor: T.border,
    marginHorizontal: 16,
  },

  // Contacts zone
  contactsZone: {
    padding: 16,
    paddingBottom: 12,
  },
  contactsLabel: {
    fontSize: 10,
    color: T.textFaint,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 10,
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarInitials: {
    fontSize: 12,
    fontWeight: '700',
    color: 'white',
  },
  contactMid: {
    flex: 1,
  },
  contactName: {
    fontSize: 13,
    fontWeight: '700',
    color: T.ink,
  },
  contactRole: {
    fontSize: 11,
    color: T.textFaint,
    marginTop: 1,
  },
  contactPhone: {
    fontSize: 11,
    color: T.textMuted,
    marginTop: 1,
  },
  noContactsText: {
    fontSize: 12,
    color: T.textFaint,
    fontStyle: 'italic',
  },
  contactRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  contactEmail: {
    fontSize: 10,
    color: T.blue,
    maxWidth: 130,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  contactBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  verifiedBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  linkedinBtn: {
    width: 22,
    height: 22,
    borderRadius: 4,
    backgroundColor: 'rgba(10,102,194,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Card footer
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 8,
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
  addContactBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: T.textMuted,
  },
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
  visitJobBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: T.blue,
  },
  applyBtnOuter: {
    flex: 1,
    borderRadius: 20,
    overflow: 'hidden',
  },
  applyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 16,
  },
  applyBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.2,
  },

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
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 6,
  },
  modalIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: T.ink,
    letterSpacing: -0.4,
  },
  modalHint: {
    fontSize: 13,
    color: T.textMuted,
    marginBottom: 16,
    marginLeft: 52,
  },
  modalInput: {
    backgroundColor: T.bg,
    borderWidth: 1,
    borderColor: T.borderHi,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 13,
    fontSize: 14,
    color: T.ink,
    marginBottom: 20,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  modalCancelBtn: {
    flex: 1,
    backgroundColor: T.bg,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: T.textMuted,
  },
  modalAddBtnOuter: {
    flex: 2,
    borderRadius: 14,
    overflow: 'hidden',
  },
  modalAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    paddingHorizontal: 20,
  },
  modalAddBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
  },

  // ── Coming Soon Overlay ──
  comingSoonOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(10,15,36,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
    paddingHorizontal: 28,
  },
  comingSoonCard: {
    backgroundColor: T.surface,
    borderRadius: 28,
    padding: 28,
    width: '100%',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.18,
    shadowRadius: 40,
    elevation: 16,
  },
  comingSoonBackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    marginBottom: 18,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: T.bg,
    borderRadius: 10,
  },
  comingSoonBackText: {
    fontSize: 13,
    fontWeight: '600',
    color: T.textMuted,
  },
  comingSoonIconWrap: {
    width: 60,
    height: 60,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  comingSoonBadge: {
    fontSize: 10,
    fontWeight: '800',
    color: T.blue,
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  comingSoonTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: T.ink,
    letterSpacing: -0.5,
    marginBottom: 10,
  },
  comingSoonDesc: {
    fontSize: 13,
    color: T.textMuted,
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 18,
  },
  comingSoonDivider: {
    height: 1,
    backgroundColor: T.border,
    width: '100%',
    marginBottom: 16,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  featureText: {
    fontSize: 13,
    color: '#334155',
    fontWeight: '500',
  },
});
