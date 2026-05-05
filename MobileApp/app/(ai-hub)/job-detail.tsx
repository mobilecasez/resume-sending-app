// AI Hub — new feature. Safe to delete without affecting existing app.

import React from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import type { Contact, Job, Employer } from '../../types/aiHub';

// ─────────────────────────────────────────────────────────────────
// MOCK DATA (copy of index.tsx mock — used until real API is wired)
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
      </View>

      <View style={styles.contactRight}>
        <Text style={styles.contactEmail} numberOfLines={1}>
          {contact.email}
        </Text>
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
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────

export default function JobDetailScreen() {
  const router = useRouter();
  const { jobId } = useLocalSearchParams<{ jobId: string }>();

  let foundJob: Job | null = null;
  let foundEmployer: Employer | null = null;
  for (const employer of MOCK_EMPLOYERS) {
    const job = employer.jobs.find((j) => j.id === jobId);
    if (job) {
      foundJob = job;
      foundEmployer = employer;
      break;
    }
  }

  if (!foundJob || !foundEmployer) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <View style={styles.notFoundContainer}>
          <Ionicons name="briefcase-outline" size={48} color="#CBD5E1" />
          <Text style={styles.notFoundTitle}>Job not found</Text>
          <Text style={styles.notFoundSub}>Job ID: {jobId ?? '—'}</Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtnFallback}>
            <Text style={styles.backBtnFallbackText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const job = foundJob;
  const employer = foundEmployer;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* ── 1. HERO SECTION ── */}
        <View style={styles.hero}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backButton}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="arrow-back" size={22} color="white" />
          </TouchableOpacity>

          <Text style={styles.heroJobTitle}>{job.title}</Text>

          <View style={styles.heroEmployerRow}>
            <LinearGradient colors={employer.logoColor} style={styles.heroEmployerLogo}>
              <Text style={styles.heroEmployerLogoInitial}>{employer.logoInitial}</Text>
            </LinearGradient>
            <View style={styles.heroEmployerInfo}>
              <Text style={styles.heroEmployerName}>{employer.name}</Text>
              <Text style={styles.heroEmployerSub}>{employer.subInfo}</Text>
            </View>
          </View>

          {job.urgent && (
            <View style={styles.urgentBadge}>
              <Ionicons name="flash-outline" size={11} color="#FF4E64" />
              <Text style={styles.urgentBadgeText}>URGENT HIRE</Text>
            </View>
          )}
        </View>

        {/* ── 2. META CARDS ROW ── */}
        <View style={styles.metaCardsWrapper}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.metaCardsRow}
          >
            <View style={styles.metaCard}>
              <Ionicons name="location-outline" size={18} color="#06B6D4" />
              <Text style={styles.metaCardLabel}>LOCATION</Text>
              <Text style={styles.metaCardValue}>{job.location}</Text>
            </View>

            <View style={styles.metaCard}>
              <Ionicons name="time-outline" size={18} color="#A78BFA" />
              <Text style={styles.metaCardLabel}>EXPERIENCE</Text>
              <Text style={styles.metaCardValue}>{job.experience}</Text>
            </View>

            <View style={styles.metaCard}>
              <Ionicons name="cash-outline" size={18} color="#34D399" />
              <Text style={styles.metaCardLabel}>SALARY</Text>
              <Text style={styles.metaCardValue}>{job.salary}</Text>
            </View>

            <View style={styles.metaCard}>
              <Ionicons name="briefcase-outline" size={18} color="#FB923C" />
              <Text style={styles.metaCardLabel}>JOB TYPE</Text>
              <Text style={styles.metaCardValue}>{job.jobType}</Text>
            </View>
          </ScrollView>
        </View>

        {/* ── 3. LIGHT CONTENT PANEL ── */}
        <View style={styles.lightPanel}>

          {/* A) SKILLS */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>REQUIRED SKILLS</Text>
            <View style={styles.skillsRow}>
              {job.skills.map((skill) => (
                <View key={skill} style={styles.skillChip}>
                  <Text style={styles.skillChipText}>{skill}</Text>
                </View>
              ))}
            </View>
          </View>

          {/* B) CONTACTS */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>HIRING CONTACTS</Text>
            {job.contacts.map((contact) => (
              <ContactRow key={contact.id} contact={contact} />
            ))}
            <TouchableOpacity
              onPress={() =>
                router.push({ pathname: '/(ai-hub)/add-contact', params: { jobId: job.id } })
              }
              style={styles.addContactBtn}
            >
              <Ionicons name="person-add-outline" size={14} color="#64748B" />
              <Text style={styles.addContactBtnText}>Add Contact</Text>
            </TouchableOpacity>
          </View>

          {/* C) ABOUT THE ROLE */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>ABOUT THE ROLE</Text>
            <View style={styles.aboutPlaceholder}>
              <Text style={styles.aboutPlaceholderText}>
                AI-generated summary coming soon...
              </Text>
            </View>
          </View>

        </View>
      </ScrollView>

      {/* ── 4. STICKY FOOTER ── */}
      <View style={styles.stickyFooter}>
        <TouchableOpacity activeOpacity={0.85} style={styles.applyBtnOuter}>
          <LinearGradient
            colors={['#06B6D4', '#3B82F6']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.applyBtn}
          >
            <Ionicons name="checkmark-done-outline" size={18} color="white" />
            <Text style={styles.applyBtnText}>Apply Now</Text>
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0B1120',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 100,
  },

  // ── Not Found ──
  notFoundContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    gap: 12,
    backgroundColor: '#F0F4FA',
  },
  notFoundTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0F172A',
  },
  notFoundSub: {
    fontSize: 13,
    color: '#94A3B8',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  backBtnFallback: {
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 24,
    backgroundColor: '#3B82F6',
    borderRadius: 12,
  },
  backBtnFallbackText: {
    fontSize: 14,
    fontWeight: '600',
    color: 'white',
  },

  // ── Hero ──
  hero: {
    backgroundColor: '#0B1120',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 20,
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: 16,
    padding: 4,
  },
  heroJobTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: 'white',
    letterSpacing: -0.5,
    marginBottom: 14,
  },
  heroEmployerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  heroEmployerLogo: {
    width: 40,
    height: 40,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroEmployerLogoInitial: {
    fontSize: 17,
    fontWeight: '700',
    color: 'white',
  },
  heroEmployerInfo: {
    flex: 1,
  },
  heroEmployerName: {
    fontSize: 15,
    fontWeight: '700',
    color: 'white',
  },
  heroEmployerSub: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.5)',
    marginTop: 2,
  },
  urgentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,78,100,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(255,78,100,0.4)',
    borderRadius: 20,
    paddingVertical: 5,
    paddingHorizontal: 10,
    gap: 5,
    marginTop: 14,
  },
  urgentBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FF4E64',
    letterSpacing: 0.6,
  },

  // ── Meta Cards ──
  metaCardsWrapper: {
    backgroundColor: '#0B1120',
    paddingBottom: 0,
  },
  metaCardsRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingBottom: 24,
    gap: 10,
  },
  metaCard: {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 16,
    padding: 14,
    minWidth: 110,
    alignItems: 'center',
    gap: 6,
  },
  metaCardLabel: {
    fontSize: 9,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.35)',
    letterSpacing: 1,
    marginTop: 2,
  },
  metaCardValue: {
    fontSize: 12,
    fontWeight: '600',
    color: 'white',
    textAlign: 'center',
  },

  // ── Light Panel ──
  lightPanel: {
    backgroundColor: '#F0F4FA',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 24,
    paddingHorizontal: 20,
    paddingBottom: 16,
    minHeight: 400,
  },
  section: {
    marginBottom: 28,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#94A3B8',
    letterSpacing: 1.4,
    marginBottom: 12,
  },

  // ── Skills ──
  skillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  skillChip: {
    backgroundColor: 'white',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  skillChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
  },

  // ── Contacts ──
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
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
    fontWeight: '600',
    color: '#334155',
  },
  contactRole: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 1,
  },
  contactRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  contactEmail: {
    fontSize: 11,
    color: '#3B82F6',
    maxWidth: 130,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  verifiedBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addContactBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'white',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    paddingVertical: 9,
    paddingHorizontal: 14,
    gap: 6,
    marginTop: 4,
  },
  addContactBtnText: {
    fontSize: 13,
    color: '#64748B',
    fontWeight: '500',
  },

  // ── About the Role ──
  aboutPlaceholder: {
    backgroundColor: '#E2E8F0',
    borderRadius: 12,
    height: 120,
    justifyContent: 'center',
    alignItems: 'center',
  },
  aboutPlaceholderText: {
    fontSize: 13,
    color: '#94A3B8',
    fontStyle: 'italic',
  },

  // ── Sticky Footer ──
  stickyFooter: {
    backgroundColor: 'white',
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    padding: 16,
    paddingBottom: Platform.select({ ios: 24, default: 16 }),
  },
  applyBtnOuter: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  applyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    gap: 8,
    borderRadius: 16,
  },
  applyBtnText: {
    fontSize: 16,
    fontWeight: '800',
    color: 'white',
  },
});
