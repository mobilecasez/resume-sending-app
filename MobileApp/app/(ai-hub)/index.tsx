// AI Hub — new feature. Safe to delete without affecting existing app.

import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
} from 'react';
import { useFocusEffect } from 'expo-router';
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
  Easing,
  Alert,
  ActivityIndicator,
  Linking,
  Platform,
  Dimensions,
  Keyboard,
  PanResponder,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { Contact, Job, Employer, WishlistPill } from '../../types/aiHub';
import { fetchJobMatches, fetchDashboard, resumeJobPolling, removeDashboardItem, fetchCreditBalance, deductSearchCredits, getRecruiters, findRecruiters, findRecruiterEmails, loadJobStatuses, fetchJobMatchScores, getMotivationLines, submitEmployerFixRequest } from '../../services/aiHubService';
import type { Recruiter } from '../../services/aiHubService';
import { API_BASE } from '../../config';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LoadingTips } from './LoadingTips';
import MotivationProgress from '../../components/MotivationProgress';
import CreditCostPill from '../../components/CreditCostPill';
import { useEventCosts } from '../../hooks/useEventCosts';

const { width: SCREEN_W } = Dimensions.get('window');

// Merge a streamed/refreshed employer into the list WITHOUT wiping the per-user match scores the
// device computed (server-streamed jobs carry NO matchScore). Preserve each existing job's
// matchScore by id — otherwise every poll update resets jobs to "Evaluating" and, because their
// ids are already in scoreRequestedRef, they never get re-scored (the flicker + >80%-stuck bugs).
function mergeEmployerKeepScores(prev: Employer[], incoming: Employer): Employer[] {
  const idx = prev.findIndex((e) => e.id === incoming.id);
  if (idx < 0) return [incoming, ...prev];
  const prevScores = new Map<string, number>();
  for (const j of (prev[idx].jobs || [])) {
    const ms = (j as any).matchScore;
    if (typeof ms === 'number') prevScores.set(j.id, ms);
  }
  const jobs = (incoming.jobs || []).map((j) => {
    if (typeof (j as any).matchScore === 'number') return j;        // incoming already scored
    const keep = prevScores.get(j.id);
    return keep !== undefined ? ({ ...j, matchScore: keep } as Job) : j;  // restore prior score
  });
  const arr = [...prev];
  arr[idx] = { ...incoming, jobs };
  return arr;
}

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
        workMode: 'Hybrid',
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

// ── Location parsing (pure JS, NO AI) ───────────────────────────────────────
// Turns a free-form job location ("Cupertino, CA", "Berlin, Germany", "Remote (US)")
// into { country, city } so the filter can offer Country → City selection.
const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
// Only non-ambiguous province/state codes (dropped NL/PE/SK etc. that collide with country codes).
const CA_PROVINCES = new Set('ON QC BC AB MB'.split(' '));
const AU_STATES = new Set('NSW VIC QLD TAS ACT'.split(' '));

// Canonical country → all the ways it might be written (full names, ISO-3, and ISO-2
// codes that DON'T collide with a US state). Ambiguous 2-letter codes (CA, DE, IN, CO,
// IL, ID, AR…) are intentionally left out so they resolve to the US state.
const COUNTRY_DEFS: [string, string][] = [
  ['United States', 'us usa u s a united states united states of america america states'],
  ['United Kingdom', 'uk gb gbr united kingdom great britain britain england scotland wales'],
  ['Canada', 'can canada'],
  ['Germany', 'deu ger germany deutschland'],
  ['France', 'fr fra france'],
  ['India', 'ind india bharat'],
  ['Australia', 'au aus australia'],
  ['Singapore', 'sg sgp singapore'],
  ['Netherlands', 'nl nld netherlands holland the netherlands'],
  ['Ireland', 'ie irl ireland eire'],
  ['Spain', 'es esp spain espana'],
  ['Italy', 'it ita italy italia'],
  ['Japan', 'jp jpn japan'],
  ['China', 'cn chn china'],
  ['Brazil', 'br bra brazil brasil'],
  ['Mexico', 'mx mex mexico'],
  ['Switzerland', 'ch che switzerland schweiz suisse'],
  ['Sweden', 'se swe sweden'],
  ['Poland', 'pl pol poland polska'],
  ['Portugal', 'pt prt portugal'],
  ['Belgium', 'be bel belgium'],
  ['Austria', 'at aut austria'],
  ['Denmark', 'dk dnk denmark'],
  ['Norway', 'no nor norway'],
  ['Finland', 'fi fin finland'],
  ['United Arab Emirates', 'ae are uae united arab emirates dubai abu dhabi'],
  ['South Africa', 'za zaf south africa'],
  ['New Zealand', 'nz nzl new zealand'],
  ['Philippines', 'ph phl philippines'],
  ['Indonesia', 'idn indonesia'],
  ['Malaysia', 'my mys malaysia'],
  ['South Korea', 'kr kor south korea korea republic of korea'],
  ['Israel', 'isr israel'],
  ['Czech Republic', 'cz cze czech republic czechia'],
  ['Romania', 'ro rou romania'],
  ['Hungary', 'hu hun hungary'],
  ['Greece', 'gr grc greece'],
  ['Turkey', 'tr tur turkey turkiye'],
  ['Russia', 'ru rus russia'],
  ['Ukraine', 'ua ukr ukraine'],
  ['Argentina', 'arg argentina'],
  ['Chile', 'cl chl chile'],
  ['Colombia', 'col colombia'],
  ['Egypt', 'eg egy egypt'],
  ['Saudi Arabia', 'sau saudi arabia ksa'],
  ['Thailand', 'th tha thailand'],
  ['Vietnam', 'vn vnm vietnam viet nam'],
  ['Pakistan', 'pk pak pakistan'],
  ['Bangladesh', 'bd bgd bangladesh'],
  ['Nigeria', 'ng nga nigeria'],
  ['Kenya', 'ke ken kenya'],
  ['Luxembourg', 'lu lux luxembourg'],
  ['Hong Kong', 'hk hkg hong kong'],
  ['Taiwan', 'tw twn taiwan'],
  ['Estonia', 'ee est estonia'],
  ['Lithuania', 'lt ltu lithuania'],
  ['Latvia', 'lv lva latvia'],
  ['Croatia', 'hr hrv croatia'],
  ['Slovakia', 'svk slovakia'],
  ['Slovenia', 'si svn slovenia'],
  ['Bulgaria', 'bg bgr bulgaria'],
  ['Serbia', 'rs srb serbia'],
];
const COUNTRY_LOOKUP: Record<string, string> = {};
COUNTRY_DEFS.forEach(([name, aliases]) => aliases.split(' ').forEach((a) => { COUNTRY_LOOKUP[a] = name; }));

// Does ONE location segment name a country? (US state / CA province / AU state / lookup)
function matchCountrySeg(seg: string): string | null {
  const code = seg.toUpperCase().replace(/[^A-Z]/g, '');
  if (US_STATES.has(code)) return 'United States';
  if (CA_PROVINCES.has(code)) return 'Canada';
  if (AU_STATES.has(code)) return 'Australia';
  const norm = seg.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  return COUNTRY_LOOKUP[norm] || null;
}

function parseLocation(loc?: string): { country: string; city: string } {
  const rawIn = String(loc || '').trim();
  if (!rawIn) return { country: 'Other', city: 'Unknown' };
  // Split off a trailing "(…)" then split the rest on commas / slashes / dashes / pipes.
  const paren = rawIn.match(/\(([^)]+)\)\s*$/);
  let parenTok: string | null = null;
  let body = rawIn;
  if (paren) { parenTok = paren[1].trim(); body = rawIn.slice(0, paren.index).trim(); }
  const parts = body.split(/[,/|]|\s[–—-]\s/).map((s) => s.trim()).filter(Boolean);

  // Scan candidates last→first (country is usually at the end), parenthetical first.
  const candidates = parenTok ? [parenTok, ...[...parts].reverse()] : [...parts].reverse();
  let country: string | null = null;
  let matchedSeg: string | null = null;
  for (const cand of candidates) {
    const c = matchCountrySeg(cand);
    if (c) { country = c; matchedSeg = cand; break; }
  }

  // City = the first part that isn't the matched country segment (else the whole thing).
  let city: string;
  const cityPart = parts.find((p) => p !== matchedSeg);
  if (cityPart) city = cityPart;
  else if (parenTok && body) city = body;          // "Remote (US)" → "Remote"
  else city = country || rawIn;
  if (!country) { country = 'Other'; city = rawIn; }
  return { country, city: (city || rawIn).trim() };
}

// Indeterminate rotating-ring + shimmer overlay (same treatment as the cover-letter
// buttons) shown over a company card while its jobs mount after a tap. Animations use
// the native driver so they keep spinning even while the JS thread renders the cards.
function CardBusyOverlay() {
  const spin = useRef(new Animated.Value(0)).current;
  const shim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 800, useNativeDriver: true }));
    const b = Animated.loop(Animated.timing(shim, { toValue: 1, duration: 1300, useNativeDriver: true }));
    a.start(); b.start();
    return () => { a.stop(); b.stop(); };
  }, []);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const shimX = shim.interpolate({ inputRange: [0, 1], outputRange: [-70, 90] });
  return (
    <View style={styles.ccBusyOverlay}>
      <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, width: 50, transform: [{ translateX: shimX }] }}>
        <LinearGradient colors={['transparent', 'rgba(79,141,255,0.28)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View style={[styles.ccBusyRing, { transform: [{ rotate }] }]} />
    </View>
  );
}

// Custom 0–100 "minimum match" slider (no slider lib is allowed). Drag or tap the track.
// Smoothness notes: (1) we use absolute pageX minus the track's measured screen-x — NOT
// locationX, which is relative to whatever child the finger is over (thumb/fill) and so
// jumps; (2) the thumb tracks LOCAL state during the drag (cheap re-render of just the
// slider) and only commits to the parent (re-filtering the list) on release.
function MatchSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [w, setW] = useState(0);
  const [local, setLocal] = useState(value);
  const wRef = useRef(0);
  const xRef = useRef(0);              // track's x on screen
  const localRef = useRef(value);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const trackRef = useRef<View>(null);
  valueRef.current = value;
  onChangeRef.current = onChange;

  // Sync when the value changes from outside (e.g. "Clear all").
  useEffect(() => { setLocal(value); localRef.current = value; }, [value]);

  const measure = () => {
    trackRef.current?.measureInWindow((x, _y, width) => {
      xRef.current = x;
      if (width) { wRef.current = width; setW(width); }
    });
  };
  const fromPageX = (pageX: number) => {
    const width = wRef.current;
    if (!width) return;
    const rel = Math.max(0, Math.min(width, pageX - xRef.current));
    const v = Math.round(((rel / width) * 100) / 5) * 5; // step 5
    if (v !== localRef.current) { localRef.current = v; setLocal(v); }
  };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => { measure(); fromPageX(e.nativeEvent.pageX); },
      onPanResponderMove: (e) => fromPageX(e.nativeEvent.pageX),
      onPanResponderRelease: () => { if (localRef.current !== valueRef.current) onChangeRef.current(localRef.current); },
      onPanResponderTerminate: () => { if (localRef.current !== valueRef.current) onChangeRef.current(localRef.current); },
    }),
  ).current;

  const thumbLeft = w ? Math.max(0, Math.min(w - 22, (local / 100) * w - 11)) : 0;
  return (
    <View>
      <View style={styles.filterRowBetween}>
        <Text style={styles.filterLabel}>Minimum match</Text>
        <Text style={styles.filterValue}>{local === 0 ? 'Any' : `${local}%+`}</Text>
      </View>
      <View style={styles.sliderWrap}>
        <View
          ref={trackRef}
          style={styles.sliderTrack}
          onLayout={measure}
          {...pan.panHandlers}
        >
          <View style={[styles.sliderFill, { width: `${local}%` }]} pointerEvents="none" />
          <View style={[styles.sliderThumb, { left: thumbLeft }]} pointerEvents="none" />
        </View>
      </View>
    </View>
  );
}

// While a card's search is still running in the background, the WHOLE card "heartbeats"
// — a gentle double-pulse scale plus a cyan border/glow that throbs — signalling work.
const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

type CompanyCardProps = {
  employer: Employer;
  selected: boolean;
  loading?: boolean;
  processing?: boolean;
  onPress: () => void;
  onRemove: () => void;
};

const CompanyCard: React.FC<CompanyCardProps> = ({ employer, selected, loading, processing, onPress, onRemove }) => {
  const jobCount     = (employer.jobs || []).length;
  const contactCount = (employer.jobs || []).reduce((s, j) => s + (j.contacts || []).length, 0);

  // Heartbeat animation while processing (double-thump + pause, like a pulse).
  const beat = !!processing && !loading;
  const hb = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!beat) { hb.setValue(0); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(hb, { toValue: 1,   duration: 170, useNativeDriver: false }),
      Animated.timing(hb, { toValue: 0.3, duration: 170, useNativeDriver: false }),
      Animated.timing(hb, { toValue: 0.9, duration: 170, useNativeDriver: false }),
      Animated.timing(hb, { toValue: 0,   duration: 220, useNativeDriver: false }),
      Animated.delay(520),
    ]));
    loop.start();
    return () => loop.stop();
  }, [beat]);
  const beatStyle = beat ? {
    transform: [{ scale: hb.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] }) }],
    borderWidth: 2,
    borderColor: hb.interpolate({ inputRange: [0, 1], outputRange: ['rgba(34,211,238,0.25)', 'rgba(34,211,238,0.95)'] }),
    shadowColor: '#22D3EE',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: hb.interpolate({ inputRange: [0, 1], outputRange: [0.12, 0.55] }),
    shadowRadius: hb.interpolate({ inputRange: [0, 1], outputRange: [4, 14] }),
  } : null;

  return (
    <AnimatedTouchable onPress={onPress} disabled={loading} activeOpacity={loading ? 1 : 0.85} style={[styles.ccWrap, selected && styles.ccWrapSelected, beatStyle]}>
      {selected && (
        <LinearGradient
          colors={[T.blue, T.purple]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={styles.ccSelectedRing}
        />
      )}
      <View style={styles.ccInner}>
        {/* Watermark */}
        <Text style={styles.ccWatermark} numberOfLines={1}>
          {employer.name.replace(/\s+/g, '').slice(0, 4).toUpperCase()}
        </Text>
        {/* Delete button */}
        <TouchableOpacity
          style={styles.ccDeleteBtn}
          onPress={(e) => { e.stopPropagation?.(); onRemove(); }}
          activeOpacity={0.7}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Ionicons name="close" size={12} color="rgba(255,255,255,0.7)" />
        </TouchableOpacity>
        {/* Logo */}
        <LinearGradient colors={employer.logoColor || ['#555', '#222']} style={styles.ccLogo}>
          <Text style={styles.ccLogoText}>{employer.logoInitial}</Text>
        </LinearGradient>
        {/* Name */}
        <Text style={styles.ccName} numberOfLines={2} ellipsizeMode="tail">{employer.name}</Text>
        {/* Stats */}
        <View style={styles.ccRow}>
          <Ionicons name="briefcase-outline" size={11} color="#22D3EE" />
          <Text style={[styles.ccStat, { color: '#22D3EE' }]}>{jobCount}</Text>
          <View style={styles.ccDot} />
          <Ionicons name="people-outline" size={11} color="#A78BFA" />
          <Text style={[styles.ccStat, { color: '#A78BFA' }]}>{contactCount}</Text>
        </View>
        {/* Selected tick */}
        {selected && !loading && (
          <View style={styles.ccTick}>
            <Ionicons name="checkmark" size={11} color="#fff" />
          </View>
        )}
      </View>
      {loading && <CardBusyOverlay />}
    </AnimatedTouchable>
  );
};

// ─────────────────────────────────────────────────────────────────
// JOB CARD
// ─────────────────────────────────────────────────────────────────

type JobCardProps = {
  job: Job;
  employer: Employer;
  clStatus?: string | null;
  onApply: (employer: Employer, job: Job) => void;
  onAddContact: (jobId: string) => void;
  onVisitJob: (job: Job) => void;
};

// Gently-bobbing green tip in the Add-Company modal — nudges the user to paste the page where
// ALL jobs are listed (not just the bare domain), which materially improves how many roles we find.
function AddCompanyTip() {
  const bob = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(bob, { toValue: 0, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);
  const translateY = bob.interpolate({ inputRange: [0, 1], outputRange: [0, -4] });
  return (
    <Animated.View style={[styles.tipNote, { transform: [{ translateY }] }]}>
      <Ionicons name="bulb" size={15} color="#059669" />
      <Text style={styles.tipNoteText}>
        Tip: paste the URL of the page where you can <Text style={styles.tipNoteBold}>see all the jobs</Text> — not just the company domain — to find more roles.
      </Text>
    </Animated.View>
  );
}

// Top-right "Evaluating…" pill shown while the AI match % is being computed in the
// background (matchScore === null). A gentle pulse signals work in progress.
function EvaluatingBadge() {
  const pulse = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, []);
  return (
    <Animated.View style={[styles.evalBadge, { opacity: pulse }]}>
      <View style={styles.evalDot} />
      <Text style={styles.evalText}>Evaluating</Text>
    </Animated.View>
  );
}

// Shown while the AI agent is silently learning a brand-new employer. Rotating tips
// keep the (longer) wait feeling alive instead of a dead spinner.
const LEARNING_TIPS = [
  'Reading their careers page the way a human would…',
  'Teaching our AI how this company lists its roles…',
  'First time we’ve seen this employer — learning its layout…',
  'Hunting down every open position for you…',
  'Almost there — pulling the roles together…',
];
function LearningBanner({ message }: { message?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((p) => (p + 1) % LEARNING_TIPS.length), 2800);
    return () => clearInterval(id);
  }, []);
  return (
    <View style={styles.learningCard}>
      <View style={styles.learningHeaderRow}>
        <ActivityIndicator size="small" color={T.blue} />
        <Text style={styles.learningTitle}>{message || 'New employer — training our system…'}</Text>
      </View>
      <Text style={styles.learningTip}>{LEARNING_TIPS[i]}</Text>
    </View>
  );
}

// Top-of-section progress banner shown while a search is still streaming. When the
// employer has more open roles than we keep, it tells the user we're matching the best 200.
function SearchProgressBanner({ employer }: { employer: any }) {
  const total = employer?.totalOpen;
  const more = !!employer?.moreAvailable;
  const msg = more
    ? `${total && total > 200 ? `${total} open positions` : 'More than 200 open positions'} — matching the best 200 for you…`
    : 'Finding more positions…';
  return (
    <View style={styles.progressBanner}>
      <ActivityIndicator size="small" color={T.blue} />
      <Text style={styles.progressBannerText}>{msg}</Text>
    </View>
  );
}

const JobCard = React.memo(function JobCard({ job, employer, clStatus, onApply, onAddContact, onVisitJob }: JobCardProps) {
  const [skillsExpanded, setSkillsExpanded] = useState(false);

  const SKILLS_PREVIEW = 5;
  const allSkills = job.skills || [];
  const visibleSkills = skillsExpanded ? allSkills : allSkills.slice(0, SKILLS_PREVIEW);
  const hiddenCount = allSkills.length - SKILLS_PREVIEW;

  const watermark = (employer.name || '').toUpperCase();

  const cardBg =
    clStatus === 'applied' || clStatus === 'downloaded'
      ? '#F0FDF4'   // very light green — application sent / PDF downloaded
      : clStatus === 'generated'
      ? '#FEFCE8'   // very light yellow — cover letter ready
      : '#FFFFFF';  // default white

  return (
  <View style={[styles.card, { backgroundColor: cardBg }]}>
    {/* ── Employer watermark ── */}
    {!!watermark && (
      <Text style={styles.cardWatermark} numberOfLines={1} ellipsizeMode="clip">{watermark}</Text>
    )}
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
        {job.matchScore == null ? (
          <EvaluatingBadge />
        ) : job.matchScore >= 0 ? (
          <View style={[
            styles.matchBadge,
            { backgroundColor: job.matchScore >= 70 ? 'rgba(16,185,129,0.12)' : job.matchScore >= 40 ? 'rgba(251,146,60,0.12)' : 'rgba(148,163,184,0.12)' }
          ]}>
            <Text style={[
              styles.matchBadgeText,
              { color: job.matchScore >= 70 ? '#059669' : job.matchScore >= 40 ? '#EA580C' : '#64748B' }
            ]}>{job.matchScore}% match</Text>
          </View>
        ) : null}
        {/* CL / Applied status dots */}
        {clStatus === 'applied' ? (
          <View style={styles.statusBadge}>
            <Ionicons name="checkmark-circle" size={10} color="#10B981" />
            <Text style={[styles.statusBadgeText, { color: '#10B981' }]}>Applied</Text>
          </View>
        ) : clStatus === 'downloaded' || clStatus === 'generated' ? (
          <View style={styles.statusBadge}>
            <Ionicons name="document-text" size={10} color="#4F8DFF" />
            <Text style={[styles.statusBadgeText, { color: '#4F8DFF' }]}>CL Ready</Text>
          </View>
        ) : null}
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
      {!!job.workMode && (
        <View style={styles.metaChip}>
          <Ionicons name="business-outline" size={12} color="#22D3EE" />
          <Text style={styles.metaChipText}>{job.workMode}</Text>
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
      <TouchableOpacity onPress={() => onAddContact(job.id)} style={styles.addContactBtn}>
        <Ionicons name="person-add-outline" size={13} color={T.textMuted} />
        <Text style={styles.addContactBtnText}>Add Contact</Text>
      </TouchableOpacity>
      {!!job.applyUrl && (
        <TouchableOpacity onPress={() => onVisitJob(job)} style={styles.visitJobBtn}>
          <Ionicons name="open-outline" size={13} color={T.blue} />
          <Text style={styles.visitJobBtnText}>View Job</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={() => onApply(employer, job)} activeOpacity={0.85} style={styles.applyBtnOuter}>
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
});

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
// IN-FLIGHT SEARCH PERSISTENCE (survives tab switches)
// ─────────────────────────────────────────────────────────────────

const INFLIGHT_KEY = 'aiHub_inflight_searches';

type InflightEntry = { jobId: string; companyName: string; pillId: string };

async function saveInflightSearch(entry: InflightEntry) {
  try {
    const raw = await AsyncStorage.getItem(INFLIGHT_KEY);
    const existing: InflightEntry[] = raw ? JSON.parse(raw) : [];
    const updated = [...existing.filter((e) => e.jobId !== entry.jobId), entry];
    await AsyncStorage.setItem(INFLIGHT_KEY, JSON.stringify(updated));
  } catch {}
}

async function removeInflightSearch(jobId: string) {
  try {
    const raw = await AsyncStorage.getItem(INFLIGHT_KEY);
    const existing: InflightEntry[] = raw ? JSON.parse(raw) : [];
    await AsyncStorage.setItem(INFLIGHT_KEY, JSON.stringify(existing.filter((e) => e.jobId !== jobId)));
  } catch {}
}

async function getInflightSearches(): Promise<InflightEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(INFLIGHT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────
// RECRUITER CARD
// Shown above job cards when ALL jobs for an employer have 0 contacts.
// ─────────────────────────────────────────────────────────────────

type RecruiterCardProps = {
  employer: Employer;
  creditBalance: number | null;
};

function RecruiterCard({ employer, creditBalance }: RecruiterCardProps) {
  const { costs } = useEventCosts();
  const [recruiters, setRecruiters] = useState<Recruiter[]>([]);
  const [step1Loading, setStep1Loading] = useState(false);
  const [step2Loading, setStep2Loading] = useState(false);
  const [step1Done, setStep1Done] = useState(false);
  const [step2Done, setStep2Done] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load existing recruiters on mount
  useEffect(() => {
    getRecruiters(employer.id).then(rows => {
      if (rows.length > 0) {
        setRecruiters(rows);
        setStep1Done(true);
        if (rows.some(r => r.email)) setStep2Done(true);
      }
    });
  }, [employer.id]);

  const handleFindRecruiters = async () => {
    if (creditBalance !== null && creditBalance < 1) {
      Alert.alert('Insufficient Credits', 'You need at least 1 credit to find recruiters.');
      return;
    }
    setStep1Loading(true);
    setError(null);
    try {
      const result = await findRecruiters(employer.id);
      setRecruiters(result.recruiters);
      setStep1Done(true);
    } catch (e: any) {
      const msg = e?.response?.data?.error ?? e?.message ?? 'Failed to find recruiters';
      setError(msg);
    } finally {
      setStep1Loading(false);
    }
  };

  const handleFindEmails = async () => {
    if (creditBalance !== null && creditBalance < 1) {
      Alert.alert('Insufficient Credits', 'You need at least 1 credit to find emails.');
      return;
    }
    setStep2Loading(true);
    setError(null);
    try {
      const result = await findRecruiterEmails(employer.id);
      setRecruiters(result.results);
      setStep2Done(true);
    } catch (e: any) {
      const msg = e?.response?.data?.error ?? e?.message ?? 'Failed to find emails';
      setError(msg);
    } finally {
      setStep2Loading(false);
    }
  };

  return (
    <View style={rcStyles.card}>
      {/* Header */}
      <View style={rcStyles.header}>
        <View style={rcStyles.headerIcon}>
          <Ionicons name="people-outline" size={16} color={T.blue} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={rcStyles.title}>Recruiters & HR</Text>
          <Text style={rcStyles.subtitle}>{employer.name}</Text>
        </View>
      </View>

      {error && (
        <Text style={rcStyles.errorText}>{error}</Text>
      )}

      {step1Done && recruiters.length === 0 && (
        <View style={rcStyles.noResultsBox}>
          <Ionicons name="search-outline" size={18} color="#94A3B8" />
          <Text style={rcStyles.noResultsText}>
            No LinkedIn recruiters found for this company.{'\n'}
            This can happen for smaller companies with low LinkedIn presence.
          </Text>
        </View>
      )}

      {/* Recruiter list */}
      {recruiters.length > 0 && (
        <View style={rcStyles.recruiterList}>
          {recruiters.map((r, i) => (
            <View key={r.id ?? i} style={rcStyles.recruiterRow}>
              <LinearGradient
                colors={['#6366F1', '#8B5CF6']}
                style={rcStyles.avatar}
              >
                <Text style={rcStyles.avatarText}>{(r.name[0] || '?').toUpperCase()}</Text>
              </LinearGradient>
              <View style={{ flex: 1 }}>
                <View style={rcStyles.nameRow}>
                  <Text style={rcStyles.recruiterName}>{r.name}</Text>
                  {r.email_verified && (
                    <View style={rcStyles.verifiedBadge}>
                      <Ionicons name="checkmark-circle" size={11} color="#10B981" />
                      <Text style={rcStyles.verifiedText}>verified</Text>
                    </View>
                  )}
                </View>
                <Text style={rcStyles.recruiterRole}>{r.role ?? 'Recruiter'}</Text>
                {r.email ? (
                  <Text style={rcStyles.recruiterEmail}>{r.email}</Text>
                ) : r.linkedin_url ? (
                  <View style={rcStyles.linkedinRow}>
                    <TouchableOpacity
                      style={rcStyles.linkedinOpenBtn}
                      onPress={() => {
                        let url = r.linkedin_url!.trim();
                        if (!url.startsWith('http')) url = 'https://' + url;
                        url = url.replace('://linkedin.com', '://www.linkedin.com');
                        Linking.openURL(url).catch(() =>
                          Alert.alert('Error', 'Could not open LinkedIn profile.')
                        );
                      }}
                    >
                      <Ionicons name="logo-linkedin" size={11} color="#3B82F6" />
                      <Text style={rcStyles.linkedinLink}>View on LinkedIn</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={rcStyles.copyBtn}
                      onPress={() => {
                        const { Clipboard } = require('react-native');
                        Clipboard.setString(r.linkedin_url!);
                        Alert.alert('Copied', 'LinkedIn URL copied to clipboard.');
                      }}
                    >
                      <Ionicons name="copy-outline" size={11} color="#64748B" />
                      <Text style={rcStyles.copyText}>Copy</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Step 1 button */}
      {!step1Done ? (
        <TouchableOpacity
          style={rcStyles.btn}
          activeOpacity={0.8}
          onPress={handleFindRecruiters}
          disabled={step1Loading}
        >
          {step1Loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Ionicons name="logo-linkedin" size={15} color="#fff" />
              <Text style={rcStyles.btnText}>Find Recruiters on LinkedIn</Text>
              <View style={rcStyles.creditPill}>
                <Ionicons name="flash" size={10} color="#F59E0B" />
                <Text style={rcStyles.creditPillText}>{costs['find_recruiters'] ?? 1}</Text>
              </View>
            </>
          )}
        </TouchableOpacity>
      ) : (
        <View style={rcStyles.doneRow}>
          <Ionicons name="checkmark-circle" size={16} color="#10B981" />
          <Text style={rcStyles.doneText}>Recruiters found</Text>
          <TouchableOpacity onPress={handleFindRecruiters} disabled={step1Loading} style={rcStyles.rerunBtn}>
            {step1Loading
              ? <ActivityIndicator size="small" color={T.blue} />
              : <Text style={rcStyles.rerunText}>Refresh</Text>
            }
          </TouchableOpacity>
        </View>
      )}

      {/* Step 2 button — shown after Step 1, disabled with Coming Soon */}
      {step1Done && !step2Done && (
        <View style={[rcStyles.btn, rcStyles.btnDisabled]}>
          <Ionicons name="mail-outline" size={15} color="#94A3B8" />
          <Text style={rcStyles.btnDisabledText}>Find Work Emails</Text>
          <View style={rcStyles.comingSoonPill}>
            <Text style={rcStyles.comingSoonText}>Coming Soon</Text>
          </View>
        </View>
      )}

      {step2Done && (
        <View style={rcStyles.doneRow}>
          <Ionicons name="checkmark-circle" size={16} color="#10B981" />
          <Text style={rcStyles.doneText}>Emails verified</Text>
          <TouchableOpacity onPress={handleFindEmails} disabled={step2Loading} style={rcStyles.rerunBtn}>
            {step2Loading
              ? <ActivityIndicator size="small" color={T.blue} />
              : <Text style={rcStyles.rerunText}>Refresh</Text>
            }
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const rcStyles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 18,
    marginBottom: 14,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#EFF6FF',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  headerIcon: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(6,182,212,0.1)', alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: 14, fontWeight: '800', color: '#0F172A', letterSpacing: -0.2 },
  subtitle: { fontSize: 12, color: '#64748B', marginTop: 1 },
  recruiterList: { gap: 12, marginBottom: 14 },
  recruiterRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  recruiterName: { fontSize: 13, fontWeight: '700', color: '#0F172A' },
  recruiterRole: { fontSize: 11, color: '#64748B', marginTop: 1 },
  recruiterEmail: { fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: '#06B6D4', marginTop: 3 },
  linkedinRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  linkedinOpenBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(59,130,246,0.08)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  linkedinLink: { fontSize: 11, color: '#3B82F6', fontWeight: '600' },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#F1F5F9', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  copyText: { fontSize: 11, color: '#64748B', fontWeight: '600' },
  verifiedBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(16,185,129,0.1)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
  verifiedText: { fontSize: 10, color: '#10B981', fontWeight: '600' },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, borderRadius: 12, paddingVertical: 12,
    backgroundColor: T.blue, marginTop: 4,
  },
  btnText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  btnSecondary: {
    backgroundColor: 'rgba(6,182,212,0.08)',
    borderWidth: 1, borderColor: 'rgba(6,182,212,0.25)', marginTop: 8,
  },
  btnSecondaryText: { fontSize: 13, fontWeight: '700', color: T.blue },
  creditPill: { flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: 'rgba(245,158,11,0.15)', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8 },
  creditPillText: { fontSize: 11, fontWeight: '700', color: '#F59E0B' },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  doneText: { fontSize: 12, fontWeight: '600', color: '#10B981', flex: 1 },
  rerunBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: 'rgba(6,182,212,0.08)' },
  rerunText: { fontSize: 11, fontWeight: '600', color: T.blue },
  errorText: { fontSize: 12, color: '#EF4444', marginBottom: 8, lineHeight: 18 },
  noResultsBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: '#F8FAFC', borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#E2E8F0' },
  noResultsText: { fontSize: 12, color: '#64748B', lineHeight: 18, flex: 1 },
  btnDisabled: {
    backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#E2E8F0',
    marginTop: 8, opacity: 0.7,
  },
  btnDisabledText: { fontSize: 13, fontWeight: '700', color: '#94A3B8', flex: 1 },
  comingSoonPill: {
    backgroundColor: '#F1F5F9', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
    borderWidth: 1, borderColor: '#E2E8F0',
  },
  comingSoonText: { fontSize: 10, fontWeight: '700', color: '#94A3B8', letterSpacing: 0.3 },
});

// ─────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────

// ── Always-visible "raise a concern" footer card ──
// Shown at the bottom of every finished employer section — whether 0 jobs were
// found or many. Lets the user flag an employer whose listings we're still
// learning; submits via the existing fix-request service. Submitted state is
// tracked by the parent (keyed by employer id) so it survives re-renders.
function EmployerConcernCard({
  employer,
  submitted,
  onSubmitted,
}: {
  employer: Employer;
  submitted: boolean;
  onSubmitted: (employerId: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const handleReport = async () => {
    if (busy || submitted) return;
    setBusy(true);
    try {
      await submitEmployerFixRequest(employer.name || (employer as any).domain || employer.id);
      onSubmitted(employer.id);
      Alert.alert(
        "Thanks — we're on it 🛠",
        `We'll improve ${employer.name} and notify you, usually within 24 hours.`,
      );
    } catch (e) {
      Alert.alert(
        "Couldn't send that",
        "Something went wrong reporting this employer. Please try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.concernCard}>
      <View style={styles.concernIconWrap}>
        <Ionicons name="construct-outline" size={18} color={T.amber} />
      </View>
      <Text style={styles.concernTitle}>Not seeing all the jobs?</Text>
      <Text style={styles.concernBody}>
        We're still learning {employer.name}'s careers site. If you know they have openings that aren't
        showing up here, raise a concern and our team will fix it — usually within 24 hours. We'll let
        you know once it's ready.
      </Text>

      {submitted ? (
        <View style={styles.concernDoneRow}>
          <Ionicons name="checkmark-circle" size={15} color={T.amber} />
          <Text style={styles.concernDoneText}>Concern submitted ✓ — we'll notify you when it's ready</Text>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.concernBtn}
          activeOpacity={0.8}
          disabled={busy}
          onPress={handleReport}
        >
          {busy ? (
            <ActivityIndicator size="small" color={T.amber} />
          ) : (
            <Ionicons name="flag-outline" size={14} color={T.amber} />
          )}
          <Text style={styles.concernBtnText}>Report missing jobs</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export default function AIHubScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { costs } = useEventCosts();
  const [pills, setPills] = useState<WishlistPill[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [inputValue, setInputValue] = useState('https://');
  const [employers, setEmployers] = useState<Employer[]>([]);
  // Keep ref in sync so useFocusEffect can access latest employers without a stale closure
  useEffect(() => { employersRef.current = employers; }, [employers]);
  const [loadingCompanies, setLoadingCompanies] = useState<string[]>([]);
  const [processingEmployerIds, setProcessingEmployerIds] = useState<Set<string>>(new Set());
  // Employer ids whose "raise a concern" report has been submitted this session.
  const [concernSubmittedIds, setConcernSubmittedIds] = useState<Set<string>>(new Set());
  const markConcernSubmitted = (employerId: string) =>
    setConcernSubmittedIds((prev) => new Set(prev).add(employerId));
  // Derived (no setState → no extra render pass on every employers change).
  const [initialLoading, setInitialLoading] = useState(true);
  const [selectedEmployerId, setSelectedEmployerId] = useState<string | null>(null);
  // Per-card loader shown while a tapped company's jobs mount (the switch render is heavy).
  const [loadingEmployerId, setLoadingEmployerId] = useState<string | null>(null);
  const lastRemoveRef = useRef(0);   // debounce company-card removal (the list re-render lags a beat)
  const removedIdsRef = useRef<Set<string>>(new Set());  // employers removed this session — filtered out of any refetch
  // Per-company job filter — resets whenever the selected company changes.
  const [filterOpen, setFilterOpen] = useState(false);
  const [countryFilter, setCountryFilter] = useState<string[]>([]);
  const [cityFilter, setCityFilter] = useState<string[]>([]);
  const [minMatch, setMinMatch] = useState(0);
  const [showFloatingFilter, setShowFloatingFilter] = useState(false);
  // Résumé-aware praise lines for the processing-state motivation card. Fetched ONCE (cached in
  // AsyncStorage + on the backend), mixed with the bundled generic tip library. Empty is fine —
  // the card falls back to the generic library.
  const [motivationLines, setMotivationLines] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cached = await AsyncStorage.getItem('aiHub_motivation_lines');
        if (cached && alive) { const arr = JSON.parse(cached); if (Array.isArray(arr) && arr.length) setMotivationLines(arr); }
      } catch {}
      const lines = await getMotivationLines().catch(() => []);
      if (alive && lines.length) { setMotivationLines(lines); AsyncStorage.setItem('aiHub_motivation_lines', JSON.stringify(lines)).catch(() => {}); }
    })();
    return () => { alive = false; };
  }, []);

  // Clear the per-card loader once the new selection has rendered. The rAF outlasts the
  // synchronous JobCard mount that causes the perceived delay; the timeout is a backstop.
  useEffect(() => {
    if (!loadingEmployerId) return;
    const raf = requestAnimationFrame(() => setLoadingEmployerId(null));
    const safety = setTimeout(() => setLoadingEmployerId(null), 4000);
    return () => { cancelAnimationFrame(raf); clearTimeout(safety); };
  }, [selectedEmployerId]);

  // The per-company filter resets on every company switch.
  useEffect(() => { setCountryFilter([]); setCityFilter([]); setMinMatch(0); setFilterOpen(false); }, [selectedEmployerId]);
  const [featureFlag, setFeatureFlag] = useState<{ status: string; title: string | null; message: string | null } | null>(null);
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [creditLoading, setCreditLoading] = useState(false);
  // jobId → status ('generated' | 'downloaded' | 'applied')
  const [jobStatuses, setJobStatuses] = useState<Record<string, string>>({});

  // Keyboard height — used to lift the Add-Company bottom sheet above the keyboard.
  // KeyboardAvoidingView is unreliable inside a React Native <Modal> (the modal is a
  // separate window, so Android's adjustResize never reaches it), so we measure the
  // keyboard ourselves and pad the sheet up. Works identically on iOS and Android.
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const sub1 = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates?.height ?? 0));
    const sub2 = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { sub1.remove(); sub2.remove(); };
  }, []);

  // ── Background AI match-% scoring ───────────────────────────────────────────
  // Runs OFF the job-fetch path: whenever jobs appear that haven't been scored yet
  // (matchScore == null), debounce briefly (so a streaming search batches into one
  // request), score them via the cached server endpoint, and merge the % back in.
  // Each job is requested once (scoreRequestedRef); the server caches forever.
  const scoreRequestedRef = useRef<Set<string>>(new Set());
  const scoringActiveRef = useRef(false);
  useEffect(() => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // Re-collect EVERY job that still needs a score, reading the latest employers via the ref so
    // jobs that streamed in while we were scoring are picked up too.
    const collectPending = () => {
      const ids: string[] = [];
      for (const emp of (employersRef.current || [])) {
        for (const job of (emp.jobs || [])) {
          if (job.matchScore == null && UUID.test(job.id) && !scoreRequestedRef.current.has(job.id)) ids.push(job.id);
        }
      }
      return ids;
    };
    // One continuous drainer. The OLD code re-armed a 1200ms debounce on every `employers` change
    // and cancelled it each time — so during a long streaming search the timer never fired and
    // scoring was STARVED (jobs stuck on "Evaluating", appearing as you scroll). This drains the
    // whole queue in back-to-back batches and never cancels itself; concurrent runs are guarded.
    if (scoringActiveRef.current || !collectPending().length) return;
    scoringActiveRef.current = true;
    (async () => {
      try {
        await new Promise((r) => setTimeout(r, 500)); // brief coalesce so an initial burst batches
        let pending = collectPending();
        while (pending.length) {
          const batch = pending.slice(0, 40);
          batch.forEach((id) => scoreRequestedRef.current.add(id));
          let scores: Record<string, number> = {};
          try { ({ scores } = await fetchJobMatchScores(batch)); } catch { scores = {}; }
          setEmployers((prev) => prev.map((emp) => ({
            ...emp,
            jobs: (emp.jobs || []).map((job) =>
              batch.includes(job.id)
                // scored → number; requested but unscorable (no résumé / AI down) → -1 → no badge
                ? { ...job, matchScore: typeof scores[job.id] === 'number' ? scores[job.id] : -1 }
                : job
            ),
          })));
          pending = collectPending(); // includes any jobs that arrived during the request
        }
      } finally {
        scoringActiveRef.current = false;
      }
    })();
  }, [employers]);

  // Job cards always sort best-match-first (see the render). No sort toggle/prompt:
  // whenever match %s exist, the list shows highest → lowest automatically.

  // Relay: if job-detail set aiHub_navigate_home, pop this screen too → reveals App.js HomeScreen
  useFocusEffect(
    useCallback(() => {
      AsyncStorage.getItem('aiHub_navigate_home').then(flag => {
        if (flag === 'true') {
          AsyncStorage.removeItem('aiHub_navigate_home');
          router.back(); // pops (ai-hub) off the root Stack → App.js HomeScreen visible
        }
      }).catch(() => {});
    }, [router])
  );

  // Reload statuses whenever this screen comes into focus (e.g. returning from job-detail)
  const employersRef = useRef<Employer[]>([]);
  useFocusEffect(
    useCallback(() => {
      const current = employersRef.current;
      if (current.length === 0) return;
      const load = async () => {
        const allStatuses: Record<string, string> = {};
        await Promise.all(current.map(async (emp) => {
          const s = await loadJobStatuses(emp.id);
          Object.assign(allStatuses, s);
        }));
        setJobStatuses(allStatuses);
      };
      load();
    }, [])
  );

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

  const stats = useMemo(() => {
    let m = 0, c = 0;
    employers.forEach((emp) => {
      m += (emp.jobs || []).length;
      c += (emp.jobs || []).reduce((s, j) => s + (j.contacts || []).length, 0);
    });
    return { sources: employers.length, matches: m, contacts: c, verifiedPct: 94 };
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
        // Server already returns employers newest-first (ute.updated_at DESC) — keep that
        // order so the most recently added company is first (leftmost) in the company strip.
        // (The previous .reverse() flipped it to oldest-first.)
        const sorted = [...dashboard];
        sorted.forEach((entry, i) => {
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
        // Auto-select the most recently added employer
        if (loadedEmployers.length > 0) {
          setSelectedEmployerId(loadedEmployers[0].id);
        }
        // Load cover letter / apply statuses for all employers
        const allStatuses: Record<string, string> = {};
        await Promise.all(loadedEmployers.map(async (emp) => {
          const s = await loadJobStatuses(emp.id);
          Object.assign(allStatuses, s);
        }));
        setJobStatuses(allStatuses);

        // Reconnect any in-flight searches that the DB doesn't know about yet
        // (employer record not created until Phase 1 completes — can take 30-60s)
        const inflight = await getInflightSearches();
        const dashboardJobIds = new Set(sorted.map((e) => e.jobId));
        for (const entry of inflight) {
          if (dashboardJobIds.has(entry.jobId)) continue; // already tracked in DB
          // Reattach loading state and resume polling
          setLoadingCompanies((prev) => prev.includes(entry.companyName) ? prev : [...prev, entry.companyName]);
          // Restore the pill for this in-flight search
          setPills((prev) => prev.find((p) => p.id === entry.pillId) ? prev : [
            ...prev,
            { id: entry.pillId, label: entry.companyName, colorVariant: COLOR_CYCLE[prev.length % 3] },
          ]);
          let firstPartial = false;
          const onPartialUpdate = (partialEmployer: Employer) => {
            if (!firstPartial) {
              firstPartial = true;
              setLoadingCompanies((prev) => prev.filter((c) => c !== entry.companyName));
              setProcessingEmployerIds((prev) => new Set([...prev, partialEmployer.id]));
              setPills((prev) => prev.map((p) => p.id === entry.pillId ? { ...p, employerId: partialEmployer.id } : p));
            }
            setEmployers((prev) => mergeEmployerKeepScores(prev, partialEmployer));
          };
          resumeJobPolling(entry.jobId, onPartialUpdate)
            .then((employer) => {
              setProcessingEmployerIds((prev) => { const n = new Set(prev); n.delete(employer.id); return n; });
              setEmployers((prev) => mergeEmployerKeepScores(prev, employer));
              setPills((prev) => prev.map((p) => p.id === entry.pillId ? { ...p, employerId: employer.id } : p));
              setSelectedEmployerId(employer.id);
              removeInflightSearch(entry.jobId);
            })
            .catch(() => {
              setLoadingCompanies((prev) => prev.filter((c) => c !== entry.companyName));
              removeInflightSearch(entry.jobId);
            });
        }
      } catch (e) {
        console.error('Failed to load dashboard', e);
      } finally {
        setInitialLoading(false);
      }
    }
    loadDashboard();
  }, []);

  // Safety net for the "comes back empty until restart" case: if we end up with NO
  // companies after the initial load (e.g. a transient empty/failed refetch, or a
  // post-remove glitch), re-fetch on focus and repopulate — minus anything removed this
  // session. Only runs when empty, so it never clobbers a populated list.
  useFocusEffect(
    useCallback(() => {
      if (initialLoading || employers.length > 0) return;
      let cancelled = false;
      (async () => {
        try {
          const dashboard = await fetchDashboard();
          if (cancelled || !dashboard) return;
          const live = dashboard.filter((e) => e?.employer && !removedIdsRef.current.has(e.employer.id));
          if (!live.length) return;
          setEmployers(live.map((e) => e.employer));
          setPills(live.map((e, i) => ({ id: `pill-${e.employer.id}`, label: e.employer.name, colorVariant: COLOR_CYCLE[i % 3], employerId: e.employer.id })));
        } catch (e) { /* keep whatever we have */ }
      })();
      return () => { cancelled = true; };
    }, [initialLoading, employers.length]),
  );

  const resumePolling = (jobId: string, companyName: string) => {
    const onPartialUpdate = (partialEmployer: Employer) => {
      setEmployers((prev) => mergeEmployerKeepScores(prev, partialEmployer));
    };
    resumeJobPolling(jobId, onPartialUpdate)
      .then((finalEmployer) => {
        setProcessingEmployerIds((prev) => { const n = new Set(prev); n.delete(finalEmployer.id); return n; });
        setEmployers((prev) => mergeEmployerKeepScores(prev, finalEmployer));
      })
      .catch(() => Alert.alert('Error', `Failed to resume tracking jobs for ${companyName}`));
  };

  // Detach an employer from the dashboard. Instant local removal; the backend archive is
  // fire-and-forget. If we removed the SELECTED company we auto-select the NEXT one (never
  // null — null would make visibleEmployers = ALL companies and render every job at once,
  // which froze the app) and show a loader on it while its job list mounts.
  const removeEmployerCore = useCallback((empId: string) => {
    removedIdsRef.current.add(empId);  // so a racing refetch can't resurrect it
    const target = employers.find((e) => e.id === empId);
    const removeKey = target?.jobId || target?.id || empId;
    if (removeKey) removeDashboardItem(removeKey).catch(console.error);  // fire-and-forget
    const idx = employers.findIndex((e) => e.id === empId);
    const remaining = employers.filter((e) => e.id !== empId);
    setEmployers(remaining);
    if (selectedEmployerId === empId) {
      const nextId = remaining.length ? (remaining[Math.min(idx, remaining.length - 1)]?.id ?? null) : null;
      setSelectedEmployerId(nextId);
      if (nextId) setLoadingEmployerId(nextId);  // loader + "Loading jobs…" while the next list mounts
    }
  }, [employers, selectedEmployerId]);

  const handleRemovePill = useCallback((id: string) => {
    const pill = pills.find((p) => p.id === id);
    setPills((prev) => prev.filter((p) => p.id !== id));
    if (pill?.employerId) removeEmployerCore(pill.employerId);
  }, [pills, removeEmployerCore]);

  const handleAddPill = useCallback(() => {
    let trimmed = inputValue.trim();
    if (!trimmed || trimmed === 'https://' || trimmed === 'http://') return;
    if (!/^https?:\/\//i.test(trimmed) && /\./.test(trimmed)) trimmed = `https://${trimmed}`;

    const SEARCH_COST = costs['company_search'] ?? 3;
    if (creditBalance !== null && SEARCH_COST > 0 && creditBalance < SEARCH_COST) {
      Alert.alert(
        'Not Enough Credits',
        `This search costs ${SEARCH_COST} credits. You only have ${creditBalance} credit${creditBalance === 1 ? '' : 's'} remaining.\n\nPurchase more credits to continue.`,
        [{ text: 'OK' }]
      );
      return;
    }

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
        // Auto-select the just-searched employer so the user sees ITS progress /
        // "we're learning" message (not whichever card was selected before).
        setSelectedEmployerId(partialEmployer.id);
      }
      setEmployers((prev) => mergeEmployerKeepScores(prev, partialEmployer));
    };
    const onJobIdKnown = (jobId: string) => {
      saveInflightSearch({ jobId, companyName: trimmed, pillId });
    };

    fetchJobMatches(trimmed, onPartialUpdate, onJobIdKnown)
      .then((employer) => {
        setProcessingEmployerIds((prev) => { const n = new Set(prev); n.delete(employer.id); return n; });
        setEmployers((prev) => mergeEmployerKeepScores(prev, employer));
        setPills((prev) => prev.map((p) => p.id === pillId ? { ...p, employerId: employer.id } : p));
        // Auto-select the newly added employer
        setSelectedEmployerId(employer.id);
        // Clean up persisted in-flight entry
        // (jobId stored via closure from onJobIdKnown)
        getInflightSearches().then((entries) => {
          const entry = entries.find((e) => e.pillId === pillId);
          if (entry) removeInflightSearch(entry.jobId);
        });
        // Deduct 3 credits after successful search
        deductSearchCredits(3)
          .then((newBalance) => setCreditBalance(newBalance))
          .catch(() => {}); // silent — don't interrupt UI on deduction failure
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
        getInflightSearches().then((entries) => {
          const entry = entries.find((e) => e.pillId === pillId);
          if (entry) removeInflightSearch(entry.jobId);
        });
      })
      .finally(() => setLoadingCompanies((prev) => prev.filter((c) => c !== trimmed)));
  }, [inputValue, costs]);

  const handleApply = useCallback((employer: Employer, job: Job) => {
    router.push({
      pathname: '/(ai-hub)/job-detail',
      params: {
        jobStr: JSON.stringify(job),
        employerStr: JSON.stringify({ id: employer.id, name: employer.name, subInfo: employer.subInfo, logoColor: employer.logoColor, logoInitial: employer.logoInitial, domain: (employer as any).domain }),
      },
    });
  }, [router]);

  const handleAddContact = useCallback((jobId: string) => {
    router.push({ pathname: '/(ai-hub)/add-contact', params: { jobId } });
  }, [router]);

  const handleVisitJob = useCallback((job: Job) => {
    if (job.applyUrl) Linking.openURL(job.applyUrl);
  }, []);

  const openModal = () => {
    setInputValue('https://');
    setModalVisible(true);
    setCreditBalance(null);
    setCreditLoading(true);
    fetchCreditBalance()
      .then((bal) => setCreditBalance(bal))
      .finally(() => setCreditLoading(false));
  };
  const visibleEmployers = selectedEmployerId ? employers.filter((e) => e.id === selectedEmployerId) : employers;
  const selectedEmployer = selectedEmployerId ? employers.find((e) => e.id === selectedEmployerId) : null;
  const filterParsed = selectedEmployer ? (selectedEmployer.jobs || []).map((j) => parseLocation(j.location)) : [];
  const filterCountries = [...new Set(filterParsed.map((p) => p.country))].sort();
  // Cities are grouped under the selected countries (or the only country, if there's one).
  const effectiveCountries = countryFilter.length ? countryFilter : (filterCountries.length === 1 ? filterCountries : []);
  const citiesByCountry = (country: string) =>
    [...new Set(filterParsed.filter((p) => p.country === country).map((p) => p.city))].sort();
  const filterActive = countryFilter.length > 0 || cityFilter.length > 0 || minMatch > 0;
  const showFilterBtn = !!selectedEmployerId && (selectedEmployer?.jobs?.length || 0) > 1;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={(e) => {
          const should = e.nativeEvent.contentOffset.y > 240;
          setShowFloatingFilter((prev) => (prev === should ? prev : should));
        }}
      >

        {/* ══ TOP BAR ══════════════════════════════════════════════════════════ */}
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.backPill} onPress={() => router.back()} activeOpacity={0.8}>
            <Ionicons name="arrow-back" size={14} color={T.ink} />
            <Text style={styles.backPillText}>Back</Text>
          </TouchableOpacity>

          {/* Absolutely centred wordmark — unaffected by side button sizes */}
          <View style={styles.wordmark} pointerEvents="none">
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
              {loadingCompanies.map((company) => {
                // Show a clean display name: extract hostname from URL or use as-is
                let displayName = company;
                try {
                  if (company.startsWith('http')) {
                    displayName = new URL(company).hostname.replace(/^www\./, '');
                  }
                } catch {}

                return (
                  <View key={company} style={styles.loaderCard}>
                    <View style={styles.loaderHeader}>
                      <LinearGradient colors={[T.blue, T.purple]} style={styles.loaderIcon}>
                        <ActivityIndicator size="small" color="#fff" />
                      </LinearGradient>
                      <View style={styles.loaderTexts}>
                        <Text style={styles.loaderTitle} numberOfLines={1}>Analyzing {displayName}</Text>
                        <Text style={styles.loaderSub}>AI is scraping and matching jobs</Text>
                      </View>
                      <TouchableOpacity
                        style={styles.loaderDeleteBtn}
                        activeOpacity={0.7}
                        onPress={() => {
                          setLoadingCompanies((prev) => prev.filter((c) => c !== company));
                          setPills((prev) => prev.filter((p) => p.label !== company));
                          getInflightSearches().then((entries) => {
                            const entry = entries.find((e) => e.companyName === company);
                            if (entry) removeInflightSearch(entry.jobId);
                          });
                        }}
                      >
                        <Ionicons name="close" size={16} color={T.textMuted} />
                      </TouchableOpacity>
                    </View>
                    <IndeterminateBar />
                    <Text style={styles.loaderNote}>This can take a minute. You can leave the app — we'll notify you when done.</Text>
                  </View>
                );
              })}
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
                    loading={loadingEmployerId === employer.id}
                    processing={processingEmployerIds.has(employer.id)}
                    onPress={() => {
                      if (loadingEmployerId) return;                       // a switch is already loading
                      if (selectedEmployerId === employer.id) { setSelectedEmployerId(null); return; }
                      setLoadingEmployerId(employer.id);                   // paint the loader first…
                      requestAnimationFrame(() => setSelectedEmployerId(employer.id)); // …then the heavy switch
                    }}
                    onRemove={() => {
                      // Ignore rapid repeat taps: the list re-render lags a beat, and a
                      // second tap would land on whichever card shifted into that spot.
                      const now = Date.now();
                      if (now - lastRemoveRef.current < 400) return;
                      lastRemoveRef.current = now;
                      const pill = pills.find((p) => p.employerId === employer.id);
                      if (pill) handleRemovePill(pill.id);
                      else removeEmployerCore(employer.id);
                    }}
                  />
                ))}
              </ScrollView>

              {/* ── Job cards for selected / all companies ── */}
              {visibleEmployers.map((employer) => {
                // Always best-match first: scored jobs rank by % (highest → lowest).
                // Still-evaluating / unscorable jobs (matchScore null or -1) fall to the
                // bottom, newest-first among themselves (createdAt desc).
                const jobs = [...(employer.jobs || [])].sort((a, b) => {
                  const ma = typeof a.matchScore === 'number' && a.matchScore >= 0 ? a.matchScore : -1;
                  const mb = typeof b.matchScore === 'number' && b.matchScore >= 0 ? b.matchScore : -1;
                  if (mb !== ma) return mb - ma;
                  const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                  const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                  return tb - ta;
                });
                // Per-company filter (Location + minimum match) — applied ONLY when a single
                // company is selected; switching company resets it (effect above).
                const filteredJobs = selectedEmployerId
                  ? jobs.filter((j) => {
                      const { country, city } = parseLocation(j.location);
                      return (countryFilter.length === 0 || countryFilter.includes(country)) &&
                        (cityFilter.length === 0 || cityFilter.includes(city)) &&
                        (minMatch === 0 || (typeof j.matchScore === 'number' && j.matchScore >= minMatch));
                    })
                  : jobs;
                const isProcessing = processingEmployerIds.has(employer.id);
                // No jobs and not processing — show a helpful empty-state card
                if (jobs.length === 0 && !isProcessing) {
                  return (
                  <View key={employer.id}>
                  <View style={styles.noJobsCard}>
                    <LinearGradient colors={employer.logoColor || ['#555', '#222']} style={styles.noJobsLogo}>
                      <Text style={styles.noJobsLogoText}>{employer.logoInitial}</Text>
                    </LinearGradient>
                    <Text style={styles.noJobsTitle}>No openings found on {employer.name}'s portal</Text>
                    <Text style={styles.noJobsBody}>
                      This company may not be actively posting jobs on their career page right now — their listings may be behind a login wall our AI can't access.
                      {'\n\n'}
                      You can still apply proactively. Search for this role on any major job platform to find the right contact, then add the recruiter's details on your{' '}
                      <Text style={styles.noJobsHighlight}>CVApplyr dashboard</Text>{' '}and send a personalised application.
                    </Text>

                    <TouchableOpacity
                      style={styles.noJobsAddBtn}
                      activeOpacity={0.8}
                      onPress={async () => {
                        await AsyncStorage.setItem('aiHub_trigger_add_recipient', 'true');
                        router.back();
                      }}
                    >
                      <Ionicons name="person-add-outline" size={14} color={T.blue} />
                      <Text style={styles.noJobsAddBtnText}>Add a Recruiter Contact</Text>
                    </TouchableOpacity>
                  </View>
                  {/* Always-visible "raise a concern" card — shown in the 0-jobs layout too. */}
                  <EmployerConcernCard
                    employer={employer}
                    submitted={concernSubmittedIds.has(employer.id)}
                    onSubmitted={markConcernSubmitted}
                  />
                  </View>
                  );
                }
                return (
                <View key={employer.id} style={styles.employerSection}>
                  {/* While the search is still running and nothing has come back yet, keep the
                      user happy and engaged with personalized, résumé-aware encouragement instead
                      of an empty screen. Hidden the moment jobs appear. (No "finding more" card.) */}
                  {(isProcessing || (employer as any).learning) && jobs.length === 0 && (
                    <MotivationProgress employerName={employer.name} personalized={motivationLines} />
                  )}
                  {/* Count row above the first job — ALWAYS visible when there are jobs. Shows the
                      filter when a company is selected with >1 role, and a tiny loader beside the
                      count while the search is still running. */}
                  {jobs.length > 0 && (
                    <View style={styles.filterHeaderRow}>
                      <View style={styles.countWithLoader}>
                        <Text style={styles.filterCountText}>
                          {filteredJobs.length}{filterActive ? ` of ${jobs.length}` : ''} {jobs.length === 1 ? 'job' : 'jobs'}
                        </Text>
                        {isProcessing && <ActivityIndicator size="small" color={T.blue} style={styles.countLoader} />}
                      </View>
                      {showFilterBtn && (
                        <TouchableOpacity
                          style={[styles.filterChip, filterActive && styles.filterChipActive]}
                          activeOpacity={0.85}
                          onPress={() => setFilterOpen(true)}
                        >
                          <Ionicons name="options-outline" size={14} color={filterActive ? '#fff' : T.ink} />
                          <Text style={[styles.filterChipText, filterActive && styles.filterChipTextActive]}>Filter</Text>
                          {filterActive && <View style={styles.filterChipDot} />}
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                  {loadingEmployerId === employer.id ? (
                    <View style={styles.jobsLoadingRow}>
                      <ActivityIndicator size="small" color={T.blue} />
                      <Text style={styles.jobsLoadingText}>Loading jobs for {employer.name}…</Text>
                    </View>
                  ) : filteredJobs.length === 0 && jobs.length > 0 ? (
                    <View style={styles.noMatchCard}>
                      <Ionicons name="funnel-outline" size={22} color={T.textFaint} />
                      <Text style={styles.noMatchText}>No jobs match these filters</Text>
                      <TouchableOpacity onPress={() => { setCountryFilter([]); setCityFilter([]); setMinMatch(0); }} activeOpacity={0.8}>
                        <Text style={styles.noMatchClear}>Clear filters</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    filteredJobs.map((job) => (
                      <JobCard
                        key={job.id}
                        job={job}
                        employer={employer}
                        clStatus={jobStatuses[job.id] ?? null}
                        onApply={handleApply}
                        onAddContact={handleAddContact}
                        onVisitJob={handleVisitJob}
                      />
                    ))
                  )}
                  {/* (Progress indicator now lives at the TOP of the section, above.) */}
                  {/* Always-visible "raise a concern" card — only once the search is done. */}
                  {!isProcessing && (
                    <EmployerConcernCard
                      employer={employer}
                      submitted={concernSubmittedIds.has(employer.id)}
                      onSubmitted={markConcernSubmitted}
                    />
                  )}
                </View>
                );
              })}
            </>
          )}
        </View>
      </ScrollView>

      {/* Floating filter — pinned top-right, fades in once scrolled into the job list */}
      {showFilterBtn && showFloatingFilter && (
        <TouchableOpacity style={[styles.floatingFilterBtn, { top: insets.top + 56 }]} activeOpacity={0.9} onPress={() => setFilterOpen(true)}>
          <Ionicons name="options-outline" size={20} color="#fff" />
          {filterActive && <View style={styles.floatingFilterDot} />}
        </TouchableOpacity>
      )}

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
      <Modal visible={modalVisible} transparent statusBarTranslucent animationType="fade" onRequestClose={() => { setInputValue('https://'); setModalVisible(false); }}>
        {/* Lift the bottom sheet above the keyboard by the measured keyboard height
            (see the kbHeight effect). This is reliable inside a <Modal> on both iOS
            and Android, where KeyboardAvoidingView is not. */}
        <TouchableOpacity
          style={[styles.modalOverlay, kbHeight > 0 && { paddingBottom: kbHeight + 16 }]}
          activeOpacity={1}
          onPress={() => { setInputValue('https://'); setModalVisible(false); }}
        >
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
            <AddCompanyTip />
            {/* Credit cost note */}
            <View style={styles.modalCreditRow}>
              <Ionicons name="flash-outline" size={13} color="#F59E0B" />
              <Text style={styles.modalCreditText}>
                This search costs <Text style={styles.modalCreditBold}>3 Credits</Text>
              </Text>
              <View style={styles.modalCreditSpacer} />
              {creditLoading ? (
                <ActivityIndicator size="small" color={T.textFaint} />
              ) : creditBalance !== null ? (
                <View style={[styles.modalBalancePill, creditBalance < 3 && styles.modalBalancePillLow]}>
                  <Ionicons name="wallet-outline" size={11} color={creditBalance < 3 ? '#EF4444' : T.textMuted} />
                  <Text style={[styles.modalBalanceText, creditBalance < 3 && styles.modalBalanceTextLow]}>
                    {creditBalance} left
                  </Text>
                </View>
              ) : null}
            </View>
            {creditBalance !== null && creditBalance < 3 && (
              <Text style={styles.modalInsufficientText}>
                You need at least 3 credits to search. Purchase more credits to continue.
              </Text>
            )}
            <View style={styles.modalButtons}>
              <TouchableOpacity onPress={() => { setInputValue('https://'); setModalVisible(false); }} style={styles.modalCancelBtn}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleAddPill}
                style={[styles.modalConfirmOuter, creditBalance !== null && creditBalance < 3 && styles.modalConfirmOuterDisabled]}
                activeOpacity={creditBalance !== null && creditBalance < 3 ? 1 : 0.85}
                disabled={creditBalance !== null && creditBalance < 3}
              >
                <LinearGradient
                  colors={creditBalance !== null && creditBalance < 3 ? ['#94A3B8', '#94A3B8'] : [T.blue, T.blueDeep]}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  style={styles.modalConfirmBtn}
                >
                  <Text style={styles.modalConfirmText}>Search Jobs</Text>
                  <Ionicons name="arrow-forward" size={15} color="#fff" />
                </LinearGradient>
              </TouchableOpacity>
            </View>
            <View style={{ alignItems: 'center', marginTop: 12 }}>
              <CreditCostPill credits={costs['company_search'] ?? null} tone="dark" />
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── Filter popup (applies to the selected company only) ── */}
      <Modal visible={filterOpen} transparent statusBarTranslucent animationType="fade" onRequestClose={() => setFilterOpen(false)}>
        <TouchableOpacity style={styles.filterOverlay} activeOpacity={1} onPress={() => setFilterOpen(false)}>
          <View style={styles.filterSheet} onStartShouldSetResponder={() => true}>
            <View style={styles.filterSheetHandle} />
            <View style={styles.filterSheetHead}>
              <Text style={styles.filterSheetTitle} numberOfLines={1}>Filter jobs{selectedEmployer ? ` · ${selectedEmployer.name}` : ''}</Text>
              {filterActive && (
                <TouchableOpacity onPress={() => { setCountryFilter([]); setCityFilter([]); setMinMatch(0); }} activeOpacity={0.8}>
                  <Text style={styles.filterClearLink}>Clear all</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => setFilterOpen(false)} activeOpacity={0.7} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.filterCloseBtn}>
                <Ionicons name="close" size={20} color={T.textMuted} />
              </TouchableOpacity>
            </View>

            {/* Minimum match — fixed, always visible (label + value live inside the slider) */}
            <View style={styles.filterSection}>
              <MatchSlider value={minMatch} onChange={setMinMatch} />
            </View>

            {/* Country — fixed, MULTI-select (label + chips stay put) */}
            {filterCountries.length > 1 && (
              <View style={styles.filterSection}>
                <Text style={styles.filterLabel}>Country</Text>
                <View style={styles.filterChipsWrap}>
                  {filterCountries.map((c) => {
                    const on = countryFilter.includes(c);
                    return (
                      <TouchableOpacity
                        key={c}
                        style={[styles.locChip, on && styles.locChipOn]}
                        activeOpacity={0.8}
                        onPress={() => {
                          setCountryFilter((prev) => (on ? prev.filter((x) => x !== c) : [...prev, c]));
                          if (on) { const cc = new Set(citiesByCountry(c)); setCityFilter((prev) => prev.filter((ci) => !cc.has(ci))); }
                        }}
                      >
                        <Text style={[styles.locChipText, on && styles.locChipTextOn]} numberOfLines={1}>{c}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}

            {/* City — label fixed; ONLY the chip list scrolls. Grouped per selected country. */}
            {effectiveCountries.length > 0 ? (
              <View style={[styles.filterSection, styles.filterCitySection]}>
                <Text style={styles.filterLabel}>{filterCountries.length > 1 ? 'City' : 'Location'}</Text>
                <ScrollView style={styles.filterCityScroll} contentContainerStyle={{ paddingBottom: 6 }} showsVerticalScrollIndicator keyboardShouldPersistTaps="handled">
                  {effectiveCountries.map((country) => {
                    const cities = citiesByCountry(country);
                    if (!cities.length) return null;
                    return (
                      <View key={country} style={styles.filterCityGroup}>
                        {effectiveCountries.length > 1 && <Text style={styles.filterCityGroupLabel}>{country}</Text>}
                        <View style={styles.filterChipsWrap}>
                          {cities.map((city) => {
                            const on = cityFilter.includes(city);
                            return (
                              <TouchableOpacity
                                key={`${country}::${city}`}
                                style={[styles.locChip, on && styles.locChipOn]}
                                activeOpacity={0.8}
                                onPress={() => setCityFilter((prev) => (on ? prev.filter((l) => l !== city) : [...prev, city]))}
                              >
                                <Text style={[styles.locChipText, on && styles.locChipTextOn]} numberOfLines={1}>{city}</Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      </View>
                    );
                  })}
                </ScrollView>
              </View>
            ) : filterCountries.length > 1 ? (
              <Text style={styles.filterHintText}>Pick one or more countries to choose cities.</Text>
            ) : null}

            <TouchableOpacity style={styles.filterDoneOuter} activeOpacity={0.9} onPress={() => setFilterOpen(false)}>
              <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.filterDoneBtn}>
                <Text style={styles.filterDoneText}>Show jobs</Text>
              </LinearGradient>
            </TouchableOpacity>
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

  // ── Top bar ──
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
    zIndex: 1,
  },
  backPillText: { fontSize: 13, fontWeight: '600', color: T.ink },
  // Absolutely centred so it's always in the middle regardless of side button widths
  wordmark: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    zIndex: 0,
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
  loaderDeleteBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: T.bg,
    borderWidth: 1,
    borderColor: T.borderHi,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
    flexShrink: 0,
  },

  // ── Employer section ──
  employerSection: { marginBottom: 28 },
  processingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingVertical: 8 },
  processingText: { fontSize: 12, color: T.textMuted, fontStyle: 'italic' },
  learningCard: { backgroundColor: 'rgba(79,141,255,0.08)', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(79,141,255,0.18)', padding: 16, marginTop: 6, gap: 8 },
  learningHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  learningTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: T.inkSoft },
  learningTip: { fontSize: 13, color: T.textMuted, lineHeight: 18 },
  progressBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(79,141,255,0.08)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(79,141,255,0.16)', paddingVertical: 11, paddingHorizontal: 14, marginBottom: 10 },
  progressBannerText: { flex: 1, fontSize: 13, fontWeight: '600', color: T.inkSoft },

  // ── Company strip (horizontal scroll) ──
  companyStripScroll: { marginBottom: 16 },
  companyStrip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 6,
    paddingHorizontal: 2,
  },

  // ── Company bookmark cards ──
  ccWrap: {
    width: 130,
    alignSelf: 'flex-start',    // prevents stretching to fill scroll container height
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
    overflow: 'hidden',
  },
  ccWatermark: {
    position: 'absolute',
    bottom: -8,
    right: -4,
    fontSize: 52,
    fontWeight: '900',
    color: 'rgba(255,255,255,0.045)',
    letterSpacing: -2,
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
    maxHeight: 36,       // exactly 2 lines — hard cap
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
  ccDeleteBtn: {
    position: 'absolute',
    top: 7,
    left: 7,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
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
  cardWatermark: {
    position: 'absolute',
    top: '50%',
    left: '30%',
    right: -40,
    fontSize: 88,
    fontWeight: '900',
    color: 'rgba(11,15,34,0.04)',
    letterSpacing: -3,
    zIndex: 0,
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
  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3, backgroundColor: 'rgba(79,141,255,0.08)' },
  statusBadgeText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.2 },
  matchBadgeText: { fontSize: 11, fontWeight: '700' },
  evalBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(124,107,255,0.12)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  evalDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#7C6BFF' },
  evalText: { fontSize: 10, fontWeight: '700', color: '#7C6BFF', letterSpacing: 0.2 },

  // Company-card busy overlay (shown while a tapped company's jobs mount)
  ccBusyOverlay: { ...StyleSheet.absoluteFillObject, borderRadius: 20, backgroundColor: 'rgba(11,17,32,0.55)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  ccBusyRing: { width: 22, height: 22, borderRadius: 11, borderWidth: 2.5, borderColor: 'rgba(255,255,255,0.3)', borderTopColor: '#fff' },

  // Inline filter header (above the first job of the selected company)
  filterHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: -16, marginBottom: 8, paddingHorizontal: 2 },
  filterCountText: { fontSize: 12, fontWeight: '700', color: T.textMuted },
  tipNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: 'rgba(16,185,129,0.10)', borderWidth: 1, borderColor: 'rgba(16,185,129,0.32)', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, marginTop: 12 },
  tipNoteText: { flex: 1, fontSize: 12, lineHeight: 17, color: '#047857', fontWeight: '600' },
  tipNoteBold: { fontWeight: '800', color: '#065F46' },
  countWithLoader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  countLoader: { transform: [{ scale: 0.7 }] },
  filterChip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.surface, borderWidth: 1, borderColor: T.borderHi, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 12 },
  filterChipActive: { backgroundColor: T.blue, borderColor: T.blue },
  filterChipText: { fontSize: 12, fontWeight: '700', color: T.ink },
  filterChipTextActive: { color: '#fff' },
  filterChipDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },

  // No-jobs-match-filter state
  noMatchCard: { alignItems: 'center', gap: 8, backgroundColor: T.surface, borderRadius: 20, paddingVertical: 28, paddingHorizontal: 20, marginBottom: 12 },
  noMatchText: { fontSize: 14, fontWeight: '700', color: T.textMuted },
  noMatchClear: { fontSize: 13, fontWeight: '700', color: T.blue },
  jobsLoadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 44 },
  jobsLoadingText: { fontSize: 13, fontWeight: '600', color: T.textMuted },

  // Floating filter button (pinned)
  floatingFilterBtn: { position: 'absolute', right: 16, width: 46, height: 46, borderRadius: 23, backgroundColor: 'rgba(79,141,255,0.90)', alignItems: 'center', justifyContent: 'center', shadowColor: T.ink, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.22, shadowRadius: 12, elevation: 10, zIndex: 50 },
  floatingFilterDot: { position: 'absolute', top: 10, right: 10, width: 9, height: 9, borderRadius: 5, backgroundColor: '#FB923C', borderWidth: 1.5, borderColor: '#fff' },

  // Filter modal (bottom sheet)
  filterOverlay: { flex: 1, backgroundColor: 'rgba(11,15,34,0.65)', justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 14, paddingBottom: 28 },
  filterSheet: { width: '100%', maxHeight: '85%', backgroundColor: T.surface, borderRadius: 28, paddingHorizontal: 22, paddingTop: 12, paddingBottom: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 20 }, shadowOpacity: 0.2, shadowRadius: 40, elevation: 20 },
  filterSheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: T.borderHi, marginBottom: 16 },
  filterSheetHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  filterCloseBtn: { padding: 2 },
  filterScroll: { flexGrow: 0, flexShrink: 1, marginTop: 4 },
  filterCitySection: { flexShrink: 1 },
  filterCityScroll: { maxHeight: 230, flexGrow: 0, flexShrink: 1, marginTop: 2 },
  filterCityWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 8, paddingBottom: 6 },
  filterCityGroup: { marginBottom: 4 },
  filterCityGroupLabel: { fontSize: 11.5, fontWeight: '700', color: T.textMuted, letterSpacing: 0.2, marginTop: 10 },
  filterHintText: { fontSize: 12.5, color: T.textFaint, marginTop: 14, fontStyle: 'italic' },
  filterSheetTitle: { flex: 1, fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  filterClearLink: { fontSize: 13, fontWeight: '700', color: T.blue, marginLeft: 12 },
  filterSection: { marginTop: 16 },
  filterRowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  filterLabel: { fontSize: 13, fontWeight: '700', color: T.ink },
  filterValue: { fontSize: 13, fontWeight: '800', color: T.blue },
  filterChipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  locChip: { maxWidth: '100%', backgroundColor: T.inputBg, borderWidth: 1, borderColor: T.border, borderRadius: 18, paddingVertical: 8, paddingHorizontal: 13 },
  locChipOn: { backgroundColor: T.blue, borderColor: T.blue },
  locChipText: { fontSize: 12.5, fontWeight: '600', color: T.inkSoft },
  locChipTextOn: { color: '#fff' },
  filterDoneOuter: { marginTop: 22, borderRadius: 16, overflow: 'hidden' },
  filterDoneBtn: { alignItems: 'center', justifyContent: 'center', paddingVertical: 15 },
  filterDoneText: { fontSize: 15, fontWeight: '800', color: '#fff' },

  // Custom match slider
  sliderWrap: { paddingVertical: 14 },
  sliderTrack: { height: 6, borderRadius: 3, backgroundColor: T.inputBg, justifyContent: 'center' },
  sliderFill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3, backgroundColor: T.blue },
  sliderThumb: { position: 'absolute', top: -8, width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff', borderWidth: 2, borderColor: T.blue, shadowColor: T.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4, elevation: 4 },

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
    flexShrink: 1,          // let a long chip (e.g. location) shrink instead of overflowing the card
    maxWidth: '100%',
  },
  metaChipText: { fontSize: 11, fontWeight: '600', color: T.textMuted, flexShrink: 1, flexWrap: 'wrap' },

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

  // ── No-jobs empty state card ──
  noJobsCard: {
    backgroundColor: T.surface,
    borderRadius: 22,
    marginBottom: 14,
    padding: 22,
    alignItems: 'center',
    shadowColor: T.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.07,
    shadowRadius: 16,
    elevation: 4,
  },
  noJobsLogo: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  noJobsLogoText: { fontSize: 22, fontWeight: '800', color: '#fff' },
  noJobsTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: T.ink,
    textAlign: 'center',
    letterSpacing: -0.3,
    marginBottom: 10,
    lineHeight: 21,
  },
  noJobsBody: {
    fontSize: 13,
    color: T.textMuted,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 18,
  },
  noJobsHighlight: {
    color: T.blue,
    fontWeight: '700',
  },
  noJobsAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(79,141,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(79,141,255,0.22)',
    borderRadius: 14,
    paddingVertical: 11,
    paddingHorizontal: 18,
  },
  noJobsAddBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: T.blue,
  },
  // ── "Raise a concern about this employer" footer card ──
  concernCard: {
    backgroundColor: T.surface,
    borderRadius: 18,
    marginBottom: 14,
    padding: 18,
    alignItems: 'center',
    shadowColor: T.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.07,
    shadowRadius: 16,
    elevation: 4,
  },
  concernIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(245,158,11,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.22)',
    marginBottom: 12,
  },
  concernTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: T.ink,
    textAlign: 'center',
    letterSpacing: -0.3,
    marginBottom: 8,
  },
  concernBody: {
    fontSize: 13,
    color: T.textMuted,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 16,
  },
  concernBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(245,158,11,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.22)',
    borderRadius: 14,
    paddingVertical: 11,
    paddingHorizontal: 18,
  },
  concernBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: T.amber,
  },
  concernDoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  concernDoneText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: T.amber,
    textAlign: 'center',
    flexShrink: 1,
  },
  // ── Modal ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(11,15,34,0.65)',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 24,
    paddingBottom: 32,
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
  modalConfirmOuterDisabled: { opacity: 0.75 },

  // Credit cost row inside modal
  modalCreditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(245,158,11,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.2)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 8,
  },
  modalCreditText: { fontSize: 12, color: T.textMuted, fontWeight: '500' },
  modalCreditBold: { fontWeight: '700', color: T.ink },
  modalCreditSpacer: { flex: 1 },
  modalBalancePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: T.bg,
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  modalBalancePillLow: { backgroundColor: 'rgba(239,68,68,0.08)' },
  modalBalanceText: { fontSize: 11, fontWeight: '700', color: T.textMuted },
  modalBalanceTextLow: { color: '#EF4444' },
  modalInsufficientText: {
    fontSize: 11,
    color: '#EF4444',
    marginBottom: 10,
    paddingHorizontal: 2,
    lineHeight: 16,
  },

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
