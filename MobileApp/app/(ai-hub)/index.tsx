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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { Contact, Job, Employer, WishlistPill } from '../../types/aiHub';
import { fetchJobMatches, fetchDashboard, resumeJobPolling, removeDashboardItem } from '../../services/aiHubService';
import { LoadingTips } from './LoadingTips';

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
        skills: ['PyTorch', 'Core ML', 'Python', 'NLP', 'LLMs'],
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
// WISHLIST BAR
// ─────────────────────────────────────────────────────────────────

type WishlistBarProps = {
  pills: WishlistPill[];
  onRemove: (id: string) => void;
  onAddPress: () => void;
  sources: number;
  matches: number;
};

const WishlistBar: React.FC<WishlistBarProps> = ({
  pills,
  onRemove,
  onAddPress,
  sources,
  matches,
}) => {
  const router = useRouter();
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.4,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1.0,
          duration: 700,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  return (
    <View style={styles.wishlistBar}>
      <View style={styles.topHeader}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.replace('/(tabs)')}>
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={styles.wishlistLabel}>JOBS DASHBOARD</Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pillsRow}
      >
        {pills.map((pill) => {
          const c = PILL_COLORS[pill.colorVariant];
          return (
            <View
              key={pill.id}
              style={[styles.pill, { backgroundColor: c.bg, borderColor: c.border }]}
            >
              <Text style={[styles.pillText, { color: c.text }]}>{pill.label}</Text>
              <TouchableOpacity
                onPress={() => onRemove(pill.id)}
                style={styles.pillRemoveBtn}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Ionicons name="close" size={11} color={c.text} />
              </TouchableOpacity>
            </View>
          );
        })}

        <TouchableOpacity onPress={onAddPress} style={styles.addPillTrigger}>
          <Ionicons name="add-outline" size={14} color="#67E8F9" />
          <Text style={styles.addPillText}>Add company or URL...</Text>
        </TouchableOpacity>
      </ScrollView>

      <View style={styles.aiStatusRow}>
        <Animated.View
          style={[styles.pulseDot, { transform: [{ scale: pulseAnim }] }]}
        />
        <Text style={styles.aiStatusText}>
          {`AI is analyzing your wishlist · ${sources} sources · ${matches} matches`}
        </Text>
      </View>
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────
// STATS STRIP
// ─────────────────────────────────────────────────────────────────

type StatsStripProps = { matches: number; contacts: number; verifiedPct: number };

const StatsStrip: React.FC<StatsStripProps> = ({ matches, contacts, verifiedPct }) => (
  <View style={styles.statsStrip}>
    <View style={styles.statCard}>
      <Text style={[styles.statValue, { color: '#22D3EE' }]}>{matches}</Text>
      <Text style={styles.statLabel}>MATCHES</Text>
    </View>
    <View style={styles.statCard}>
      <Text style={[styles.statValue, { color: '#A78BFA' }]}>{contacts}</Text>
      <Text style={styles.statLabel}>CONTACTS</Text>
    </View>
    <View style={styles.statCard}>
      <Text style={[styles.statValue, { color: '#34D399' }]}>{verifiedPct}%</Text>
      <Text style={styles.statLabel}>VERIFIED %</Text>
    </View>
  </View>
);

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

  return (
    <View style={styles.contactRow}>
      <LinearGradient colors={contact.avatarColor} style={styles.avatar}>
        <Text style={styles.avatarInitials}>{initials}</Text>
      </LinearGradient>

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
        {contact.verified && (
          <LinearGradient
            colors={['#10B981', '#059669']}
            style={styles.verifiedBadge}
          >
            <Ionicons name="checkmark" size={9} color="white" />
          </LinearGradient>
        )}
      </View>
    </View>
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

const JobCard: React.FC<JobCardProps> = ({ job, onApply, onAddContact, onVisitJob }) => (
  <View style={styles.card}>
    {/* ── Card Body ── */}
    <View style={styles.cardBody}>
      <View style={styles.jobTitleRow}>
        <Text style={[styles.jobTitle, { flex: 1 }]}>{job.title}</Text>
        {job.matchScore != null && (
          <View style={[
            styles.matchScoreBadge,
            { backgroundColor: job.matchScore > 0 ? (job.matchScore >= 70 ? 'rgba(16,185,129,0.12)' : job.matchScore >= 40 ? 'rgba(251,146,60,0.12)' : 'rgba(148,163,184,0.12)') : '#F1F5F9' }
          ]}>
            {job.matchScore > 0 ? (
              <Text style={[
                styles.matchScoreText,
                { color: job.matchScore >= 70 ? '#059669' : job.matchScore >= 40 ? '#EA580C' : '#64748B' }
              ]}>{job.matchScore}% match</Text>
            ) : (
              <Text style={[styles.matchScoreText, { color: '#94A3B8' }]}>Evaluating...</Text>
            )}
          </View>
        )}
      </View>

      <View style={styles.badgesRow}>
        <View style={[styles.badge, styles.badgeLocation]}>
          <Ionicons name="location-outline" size={11} color="#1D4ED8" />
          <Text style={[styles.badgeText, { color: '#1D4ED8' }]}>{job.location}</Text>
        </View>

        <View style={[styles.badge, styles.badgeExperience]}>
          <Ionicons name="time-outline" size={11} color="#B45309" />
          <Text style={[styles.badgeText, { color: '#B45309' }]}>{job.experience}</Text>
        </View>

        <View style={[styles.badge, styles.badgeSalary]}>
          <Ionicons name="cash-outline" size={11} color="#047857" />
          <Text style={[styles.badgeText, { color: '#047857' }]}>{job.salary}</Text>
        </View>

        <View style={[styles.badge, styles.badgeJobType]}>
          <Ionicons name="briefcase-outline" size={11} color="#6D28D9" />
          <Text style={[styles.badgeText, { color: '#6D28D9' }]}>{job.jobType}</Text>
        </View>

        {job.urgent && (
          <View style={[styles.badge, styles.badgeUrgent]}>
            <Ionicons name="flash-outline" size={11} color="#BE123C" />
            <Text style={[styles.badgeText, { color: '#BE123C' }]}>Urgent</Text>
          </View>
        )}
      </View>

      <Text style={styles.skillsText}>Skills: {job.skills.join(', ')}</Text>
    </View>

    {/* ── Contacts Zone ── */}
    <View style={styles.contactsZone}>
      <View style={styles.contactsInner}>
        <Text style={styles.contactsLabel}>HIRING CONTACTS</Text>
        {(job.contacts || []).length > 0 ? (
          (job.contacts || []).map((contact) => (
            <ContactRow key={contact.id} contact={contact} />
          ))
        ) : (
          <Text style={styles.noContactsText}>No contact details found for this listing</Text>
        )}
      </View>
    </View>

    {/* ── Card Footer ── */}
    <View style={styles.cardFooter}>
      <View style={styles.cardFooterLeft}>
        <TouchableOpacity onPress={onAddContact} style={styles.addContactBtn}>
          <Ionicons name="add-outline" size={13} color="#64748B" />
          <Text style={styles.addContactBtnText}>Add Contact</Text>
        </TouchableOpacity>
        {!!job.applyUrl && (
          <TouchableOpacity onPress={onVisitJob} style={styles.visitJobBtn}>
            <Ionicons name="open-outline" size={13} color="#3B82F6" />
            <Text style={styles.visitJobBtnText}>Visit Job</Text>
          </TouchableOpacity>
        )}
      </View>

      <TouchableOpacity onPress={onApply} style={styles.applyBtnWrapper}>
        <LinearGradient
          colors={['#06B6D4', '#3B82F6']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.applyBtn}
        >
          <Ionicons name="checkmark-done-outline" size={13} color="white" />
          <Text style={styles.applyBtnText}>Apply Now</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
  </View>
);

// ─────────────────────────────────────────────────────────────────
// EMPLOYER SECTION
// ─────────────────────────────────────────────────────────────────

type EmployerSectionProps = {
  employer: Employer;
  isProcessing: boolean;
  onApply: (employer: Employer, job: Job) => void;
  onAddContact: (jobId: string) => void;
};

const EmployerSection: React.FC<EmployerSectionProps> = ({
  employer,
  isProcessing,
  onApply,
  onAddContact,
}) => {
  const isActive = employer.status === 'active';
  const jobsCount = (employer.jobs || []).length;
  
  return (
    <View style={styles.employerSection}>
      <View style={styles.employerHeader}>
        <LinearGradient colors={employer.logoColor || ['#555555', '#1C1C1E']} style={styles.employerLogo}>
          <Text style={styles.employerLogoInitial}>{employer.logoInitial}</Text>
        </LinearGradient>

        <View style={styles.employerInfo}>
          <Text style={styles.employerName}>{employer.name}</Text>
          <Text style={styles.employerSubInfo}>{employer.subInfo}</Text>
        </View>

        <View
          style={[
            styles.matchBadge,
            isActive ? styles.matchBadgeActive : styles.matchBadgeWatching,
          ]}
        >
          <Text
            style={[
              styles.matchBadgeText,
              isActive ? styles.matchBadgeTextActive : styles.matchBadgeTextWatching,
            ]}
          >
            {jobsCount} match{jobsCount !== 1 ? 'es' : ''}
          </Text>
        </View>
      </View>

      {(employer.jobs || []).map((job) => (
        <JobCard
          key={job.id}
          job={job}
          onApply={() => onApply(employer, job)}
          onAddContact={() => onAddContact(job.id)}
          onVisitJob={job.applyUrl ? () => Linking.openURL(job.applyUrl!) : undefined}
        />
      ))}

      {isProcessing && (
        <View style={styles.loadingMoreRow}>
          <ActivityIndicator size="small" color="#06B6D4" />
          <Text style={styles.loadingMoreText}>Finding more positions...</Text>
        </View>
      )}
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────

export default function AIHubScreen() {
  const router = useRouter();
  const [pills, setPills] = useState<WishlistPill[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [employers, setEmployers] = useState<Employer[]>([]);
  const [loadingCompanies, setLoadingCompanies] = useState<string[]>([]);
  const [processingEmployerIds, setProcessingEmployerIds] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState({ sources: 0, matches: 0, contacts: 0, verifiedPct: 0 });
  const [initialLoading, setInitialLoading] = useState(true);

  // Recalculate stats whenever employers list changes
  useEffect(() => {
    let newMatches = 0;
    let newContacts = 0;
    employers.forEach(emp => {
      newMatches += (emp.jobs || []).length;
      newContacts += (emp.jobs || []).reduce((sum, j) => sum + (j.contacts || []).length, 0);
    });
    // Hardcode verifiedPct to something static like 94 for now, since it was static before
    setStats({ sources: employers.length, matches: newMatches, contacts: newContacts, verifiedPct: 94 });
  }, [employers]);

  useEffect(() => {
    async function loadDashboard() {
      try {
        const dashboard = await fetchDashboard();
        
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
      .catch((err) => {
        setProcessingEmployerIds((prev) => {
          // If we fail, try to figure out which employer ID it was to clear it.
          // Since we might only have the name, we just clear everything for simplicity if it fails.
          // Or we can just find it by name.
          const next = new Set(prev);
          // Just let it be, or show error
          return next;
        });
        Alert.alert('Error', `Failed to resume tracking jobs for ${companyName}`);
      });
  };

  const handleRemovePill = useCallback((id: string) => {
    setPills((prev) => {
      const pill = prev.find((p) => p.id === id);
      if (pill?.employerId) {
        // Also remove from backend
        const targetEmployer = employers.find((e) => e.id === pill.employerId);
        if (targetEmployer?.jobId) {
          removeDashboardItem(targetEmployer.jobId).catch(console.error);
        }
        setEmployers((emp) => emp.filter((e) => e.id !== pill.employerId));
      }
      return prev.filter((p) => p.id !== id);
    });
  }, [employers]);

  const handleAddPill = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

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
        Alert.alert('Could not fetch jobs', `No results found for "${trimmed}". Try a full URL like https://careers.company.com`);
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

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Dark navy header section ── */}
        <WishlistBar
          pills={pills}
          onRemove={handleRemovePill}
          onAddPress={() => setModalVisible(true)}
          sources={pills.length}
          matches={stats.matches}
        />

        <StatsStrip matches={stats.matches} contacts={stats.contacts} verifiedPct={stats.verifiedPct} />

        {/* ── Light feed section ── */}
        <View style={styles.feedSection}>
          <Text style={styles.feedLabel}>JOB MATCHES</Text>

          {initialLoading ? (
            <View style={styles.emptyStateContainer}>
              <ActivityIndicator size="large" color="#06B6D4" />
              <Text style={styles.emptyStateTitle}>Loading your dashboard...</Text>
            </View>
          ) : employers.length === 0 && loadingCompanies.length === 0 ? (
            <View style={styles.emptyStateContainer}>
              <View style={styles.emptyStateIconCircle}>
                <Ionicons name="briefcase-outline" size={48} color="#94A3B8" />
              </View>
              <Text style={styles.emptyStateTitle}>No jobs tracked yet</Text>
              <Text style={styles.emptyStateSubtitle}>
                Add a company career page URL or company name above to let AI automatically extract jobs and hiring contacts that match your profile.
              </Text>
              <TouchableOpacity onPress={() => setModalVisible(true)} style={styles.emptyStateButton}>
                <LinearGradient
                  colors={['#06B6D4', '#3B82F6']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.emptyStateButtonGradient}
                >
                  <Ionicons name="add" size={18} color="white" />
                  <Text style={styles.emptyStateButtonText}>Add target company</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {loadingCompanies.map((company) => (
                <View key={company} style={styles.modernLoaderCard}>
                  <View style={styles.loaderHeader}>
                    <View style={styles.loaderIconWrapper}>
                      <ActivityIndicator size="small" color="#FFF" />
                    </View>
                    <View style={styles.loaderTexts}>
                      <Text style={styles.loaderTitle}>Analyzing {company}...</Text>
                      <Text style={styles.loaderSub}>AI is scraping and matching jobs</Text>
                    </View>
                  </View>
                  <View style={styles.loaderProgressBg}>
                    <Animated.View style={[styles.loaderProgressFill, { width: '40%' }]} />
                  </View>
                  <Text style={styles.loaderFootnote}>This can take a minute. You can safely leave this app, we will notify you when it's done.</Text>
                </View>
              ))}

              {/* Interesting AI Tips / Suggestions - Shown separately at the top if something is loading */}
              {loadingCompanies.length > 0 && <LoadingTips />}

              {employers.map((employer) => (
                <EmployerSection
                  key={employer.id}
                  employer={employer}
                  isProcessing={processingEmployerIds.has(employer.id)}
                  onApply={handleApply}
                  onAddContact={handleAddContact}
                />
              ))}
            </>
          )}
        </View>
      </ScrollView>

      {/* ── Add Company Modal ── */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setModalVisible(false)}
        >
          <View
            style={styles.modalBox}
            onStartShouldSetResponder={() => true}
          >
            <Text style={styles.modalTitle}>Add Target Company</Text>

            <TextInput
              style={styles.modalInput}
              placeholder="Company name or career page URL..."
              placeholderTextColor="#94A3B8"
              value={inputValue}
              onChangeText={setInputValue}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleAddPill}
            />

            <View style={styles.modalButtons}>
              <TouchableOpacity
                onPress={() => {
                  setInputValue('');
                  setModalVisible(false);
                }}
                style={styles.modalCancelBtn}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={handleAddPill} style={styles.modalAddBtnOuter}>
                <LinearGradient
                  colors={['#06B6D4', '#3B82F6']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.modalAddBtn}
                >
                  <Text style={styles.modalAddBtnText}>Add</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── Root ──
  safeArea: {
    flex: 1,
    backgroundColor: '#0A0F24',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },

  // ── Wishlist Bar ──
  wishlistBar: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 16,
  },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    marginTop: 10,
  },
  backButton: {
    marginRight: 12,
    marginLeft: -8,
    padding: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  wishlistLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFF',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  pillsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 4,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 30,
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 12,
    gap: 6,
  },
  pillText: {
    fontSize: 12,
    fontWeight: '600',
  },
  pillRemoveBtn: {
    padding: 1,
  },
  addPillTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 30,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(6,182,212,0.45)',
    paddingVertical: 6,
    paddingHorizontal: 12,
    gap: 4,
  },
  addPillText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
  },
  aiStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    gap: 8,
  },
  pulseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#06B6D4',
  },
  aiStatusText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.45)',
    fontStyle: 'italic',
  },

  // ── Stats Strip ──
  statsStrip: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingBottom: 26,
    gap: 12,
  },
  statCard: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 24,
    fontWeight: '700',
  },
  statLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.35)',
    fontWeight: '600',
    letterSpacing: 0.8,
    marginTop: 3,
  },

  // ── Feed Section ──
  feedSection: {
    flex: 1, // Let it expand to fill the bottom of the screen
    backgroundColor: '#F0F4FA',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 22,
    paddingHorizontal: 16,
    paddingBottom: 80,
  },
  feedLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94A3B8',
    letterSpacing: 1.4,
    marginBottom: 16,
    marginLeft: 4,
  },

  // ── Employer Section ──
  employerSection: {
    marginBottom: 24,
  },
  employerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  employerLogo: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  employerLogoInitial: {
    fontSize: 16,
    fontWeight: '700',
    color: 'white',
  },
  employerInfo: {
    flex: 1,
  },
  employerName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0F172A',
  },
  employerSubInfo: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 1,
  },
  matchBadge: {
    borderRadius: 20,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  matchBadgeActive: { backgroundColor: '#DCFCE7' },
  matchBadgeWatching: { backgroundColor: '#EDE9FE' },
  matchBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  matchBadgeTextActive: { color: '#15803D' },
  matchBadgeTextWatching: { color: '#6D28D9' },

  // ── Job Card ──
  card: {
    backgroundColor: 'white',
    borderRadius: 24,
    marginBottom: 14,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.10,
    shadowRadius: 32,
    elevation: 8,
    overflow: 'hidden',
  },
  cardBody: {
    padding: 18,
  },
  jobTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 10,
    gap: 8,
  },
  jobTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
    letterSpacing: -0.4,
  },
  matchScoreBadge: {
    borderRadius: 20,
    paddingVertical: 3,
    paddingHorizontal: 8,
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  matchScoreText: {
    fontSize: 11,
    fontWeight: '700',
  },
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 10,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    paddingVertical: 5,
    paddingHorizontal: 10,
    gap: 4,
  },
  badgeLocation: { backgroundColor: '#EFF6FF' },
  badgeExperience: { backgroundColor: '#FFFBEB' },
  badgeSalary: { backgroundColor: '#ECFDF5' },
  badgeJobType: { backgroundColor: '#F5F3FF' },
  badgeUrgent: { backgroundColor: '#FFF1F2' },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  skillsText: {
    fontSize: 12,
    color: '#94A3B8',
    fontStyle: 'italic',
  },

  // ── Contacts Zone ──
  contactsZone: {
    backgroundColor: '#F8FAFC',
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
  },
  contactsInner: {
    padding: 14,
    paddingHorizontal: 18,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
  },
  contactsLabel: {
    fontSize: 10,
    color: '#CBD5E1',
    fontWeight: '600',
    letterSpacing: 1.2,
    marginBottom: 10,
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarInitials: {
    fontSize: 11,
    fontWeight: '700',
    color: 'white',
  },
  contactMid: {
    flex: 1,
  },
  contactName: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
  },
  contactRole: {
    fontSize: 10,
    color: '#94A3B8',
  },
  contactPhone: {
    fontSize: 10,
    color: '#64748B',
    marginTop: 1,
  },
  noContactsText: {
    fontSize: 11,
    color: '#CBD5E1',
    fontStyle: 'italic',
    marginTop: 2,
  },
  contactRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  contactEmail: {
    fontSize: 10,
    color: '#3B82F6',
    maxWidth: 120,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  verifiedBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // ── Card Footer ──
  cardFooter: {
    backgroundColor: '#F8FAFC',
    borderTopWidth: 1,
    borderTopColor: '#EEF2F8',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  cardFooterLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  visitJobBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    borderRadius: 20,
    paddingVertical: 7,
    paddingHorizontal: 12,
    gap: 4,
  },
  visitJobBtnText: {
    fontSize: 12,
    color: '#3B82F6',
    fontWeight: '600',
  },
  addContactBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'white',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 20,
    paddingVertical: 7,
    paddingHorizontal: 12,
    gap: 4,
  },
  addContactBtnText: {
    fontSize: 12,
    color: '#64748B',
  },
  applyBtnWrapper: {
    borderRadius: 20,
    shadowColor: '#06B6D4',
    shadowOpacity: 0.4,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  applyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
    gap: 6,
  },
  applyBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: 'white',
  },

  // ── Loading More (inside employer section) ──
  loadingMoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'white',
    borderRadius: 16,
    marginBottom: 14,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: '#E0F2FE',
    shadowColor: '#06B6D4',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  loadingMoreText: {
    fontSize: 13,
    color: '#0EA5E9',
    fontStyle: 'italic',
    flex: 1,
  },

  // ── Loading Card ──
  loadingCard: {
    backgroundColor: 'white',
    borderRadius: 16,
    marginBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 18,
    gap: 12,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 16,
    elevation: 4,
  },
  loadingCardText: {
    fontSize: 13,
    color: '#64748B',
    fontStyle: 'italic',
    flex: 1,
  },

  // ── Modal ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalBox: {
    backgroundColor: 'white',
    borderRadius: 20,
    padding: 24,
    width: '100%',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 16,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 14,
    fontSize: 14,
    color: '#0F172A',
    marginBottom: 16,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 12,
  },
  modalCancelBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  modalCancelText: {
    fontSize: 14,
    color: '#64748B',
  },
  modalAddBtnOuter: {
    borderRadius: 20,
    overflow: 'hidden',
  },
  modalAddBtn: {
    paddingVertical: 10,
    paddingHorizontal: 24,
  },
  modalAddBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: 'white',
  },
  emptyStateContainer: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 40,
    backgroundColor: 'white',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderStyle: 'dashed',
  },
  emptyStateIconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  emptyStateTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 12,
    textAlign: 'center',
  },
  emptyStateSubtitle: {
    fontSize: 15,
    color: '#64748B',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },
  emptyStateButton: {
    borderRadius: 8,
    overflow: 'hidden',
  },
  emptyStateButtonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 24,
    gap: 8,
  },
  emptyStateButtonText: {
    color: 'white',
    fontWeight: '600',
    fontSize: 15,
  },
  modernLoaderCard: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  loaderHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  loaderIconWrapper: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#06B6D4',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  loaderTexts: {
    flex: 1,
  },
  loaderTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 4,
  },
  loaderSub: {
    fontSize: 13,
    color: '#64748B',
  },
  loaderProgressBg: {
    height: 6,
    backgroundColor: '#F1F5F9',
    borderRadius: 3,
    marginBottom: 12,
    overflow: 'hidden',
  },
  loaderProgressFill: {
    height: '100%',
    backgroundColor: '#06B6D4',
    borderRadius: 3,
  },
  loaderFootnote: {
    fontSize: 12,
    color: '#94A3B8',
    fontStyle: 'italic',
  }
});
