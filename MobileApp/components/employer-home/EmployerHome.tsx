// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE HOME SCREEN — "one employer, one resume".
//
// Built from the Claude Design mockup "cvApplyr Home Employer Focus". People use this app to
// generate a resume or a cover letter, so Home now leads with exactly that: pick the employer
// you are applying to, watch your real document reshape for them, download it.
//
// ⚠️ WHAT THIS DELIBERATELY DOES **NOT** COPY FROM THE MOCKUP: its pay sheet sells a single PDF
// for €1.99 ("one-time purchase · no subscription"). This app shipped a SUBSCRIPTION model to
// both stores. Selling the same file twice under two models would be a pricing bug, so the CTA
// keeps the mockup's shape and honesty ("preview is free, pay to download") and routes to the
// real paid-plan gate instead of an invented checkout.
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash): one driver per view tree, no mixing.
// This file and its two children (MeshStage, PaperCarousel) use useNativeDriver:true ONLY, on
// transform/opacity, and contain no JS-driven Animated.Value — a self-contained native tree.
// The JS-driven overlays it shares a screen with (JourneyCoach, ResumeScoreModal) are separate
// trees mounted as siblings, which the rule allows.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Animated, Easing,
  ActivityIndicator, RefreshControl, Alert, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { E, SERIF, sweepWords } from './theme';
import MeshStage from './MeshStage';
import PaperCarousel, { PaperCard } from './PaperCarousel';
import { fetchTargets, fetchHomeCards, Target, HomeCard } from '../../services/employerHomeService';
import { fetchSubscriptionStatus } from '../../services/subscriptionService';
import { track } from '../../services/analytics';

const nav = () => require('expo-router').router;

type Mode = 'resume' | 'letter';

export default function EmployerHome({
  firstName, onOpenDashboard, onOpenMenu, onOpenNotifications, unreadCount = 0, handleReview,
}: {
  firstName?: string;
  onOpenDashboard: () => void;
  onOpenMenu: () => void;
  onOpenNotifications: () => void;
  unreadCount?: number;
  handleReview?: (tab?: number) => void;
}) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [empIdx, setEmpIdx] = useState(0);
  const [cards, setCards] = useState<HomeCard[]>([]);
  const [cardIdx, setCardIdx] = useState(0);
  const [mode, setMode] = useState<Mode>('resume');
  const [loading, setLoading] = useState(true);
  const [noResume, setNoResume] = useState(false);
  const [isPaid, setIsPaid] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reshaping, setReshaping] = useState(false);
  const lastLoad = useRef(0);

  const load = useCallback(async (force = false) => {
    if (!force && Date.now() - lastLoad.current < 60_000) return;
    lastLoad.current = Date.now();
    const [t, c] = await Promise.all([fetchTargets(), fetchHomeCards()]);
    setTargets(t);
    if (c) { setCards(c.cards); setNoResume(false); } else { setCards([]); setNoResume(true); }
    setLoading(false);
    try { const st = await fetchSubscriptionStatus(); setIsPaid(!!st?.subscription); } catch {}
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(true); setRefreshing(false); };

  const target: Target | undefined = targets[empIdx];
  const card: PaperCard | undefined = cards[cardIdx];

  // Picking an employer "reshapes" the page — the scan pulse the mockup plays over the card.
  const pickEmployer = (i: number) => {
    if (i === empIdx) return;
    setEmpIdx(i);
    setReshaping(true);
    try { Haptics.selectionAsync(); } catch {}
    setTimeout(() => setReshaping(false), 950);
    track('home_employer_pick', { i });
  };

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    try { Haptics.selectionAsync(); } catch {}
    track('home_mode', { mode: m });
  };

  // ── The one CTA. Downloads are a paid-plan feature (server enforces it too) ──
  const onDownload = () => {
    track('home_cta', { mode, paid: isPaid, hasTarget: !!target });
    if (mode === 'letter') {
      // A letter is written FOR a posting — send them to the job, where generation lives.
      if (target?.jobId || target?.jobUrl) {
        nav()?.push?.({ pathname: '/(ai-hub)', params: { tab: 'myjobs' } });
      } else {
        handleReview?.(0);
      }
      return;
    }
    if (noResume) {
      AsyncStorage.setItem('resume_builder_entry', JSON.stringify({ from: 'home_employer', autoBuild: true })).catch(() => {});
      nav()?.push?.('/(resume-builder)');
      return;
    }
    // Resume: the design gallery is where preview (free) and download (paid) live.
    nav()?.push?.('/(resume-builder)/templates');
  };

  const headline = mode === 'resume' ? 'Design your resume' : 'Write your cover letter';
  const accent = mode === 'resume' ? 'exclusively for the employer.' : 'for this exact posting.';

  return (
    <ScrollView
      style={s.flex}
      contentContainerStyle={{ paddingBottom: 108 }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={E.blue} />}
    >
      {/* ───────────────────────── DARK STAGE ───────────────────────── */}
      <MeshStage>
        {/* top bar */}
        <View style={s.topBar}>
          <View style={s.brandRow}>
            <LinearGradient colors={[E.blue, E.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.brandMark}>
              <Ionicons name="document-text" size={15} color="#fff" />
            </LinearGradient>
            <Text style={s.brandTx}>cv<Text style={{ color: E.blue }}>applyr</Text></Text>
          </View>
          <View style={s.topActions}>
            <TouchableOpacity onPress={onOpenNotifications} style={s.glassBtn} activeOpacity={0.8}>
              <Ionicons name="notifications-outline" size={17} color="#fff" />
              {unreadCount > 0 && <View style={s.badge}><Text style={s.badgeTx}>{unreadCount > 9 ? '9+' : unreadCount}</Text></View>}
            </TouchableOpacity>
            <TouchableOpacity onPress={onOpenMenu} style={s.glassBtn} activeOpacity={0.8}>
              <Ionicons name="menu" size={19} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>

        {/* live pill + edit */}
        <View style={[s.rowBetween, { paddingHorizontal: 16, paddingTop: 22 }]}>
          <View style={s.livePill}>
            <LiveDot />
            <Text style={s.livePillTx}>TAILORED PER EMPLOYER · LIVE</Text>
          </View>
          <TouchableOpacity onPress={() => nav()?.push?.('/(resume-builder)')} style={s.editBtn} activeOpacity={0.85}>
            <Ionicons name="create-outline" size={12} color="#fff" />
            <Text style={s.editTx}>Edit details</Text>
          </TouchableOpacity>
        </View>

        {/* headline */}
        <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
          <Text style={s.h1}>{headline}</Text>
          <Text style={s.h1Accent}>
            {sweepWords(accent).map((p, i) => (
              <Text key={i} style={{ color: p.c }}>{p.w}{i < accent.split(' ').length - 1 ? ' ' : ''}</Text>
            ))}
          </Text>
          <Text style={s.sub}>
            {mode === 'resume'
              ? 'One posting, one resume. Skills, wording and layout reshaped around what they ask for — so you get shortlisted more often.'
              : 'Written from this posting and your experience — specific enough that it could only have been sent to them.'}
          </Text>
        </View>

        {/* mode toggle */}
        <View style={{ paddingHorizontal: 16, paddingTop: 18 }}>
          <ModeToggle mode={mode} onChange={switchMode} />
        </View>

        {/* employer chips */}
        <View style={{ paddingTop: 18 }}>
          <Text style={s.eyebrowDark}>Designing for</Text>
          {loading ? (
            <View style={s.chipsRow}><View style={s.chipSkeleton} /><View style={s.chipSkeleton} /></View>
          ) : targets.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipsRow}>
              {targets.map((t, i) => (
                <EmployerChip key={t.key} t={t} on={i === empIdx} onPress={() => pickEmployer(i)} />
              ))}
              <TouchableOpacity
                style={s.chipAdd}
                activeOpacity={0.85}
                onPress={() => nav()?.push?.({ pathname: '/(ai-hub)', params: { tab: 'search' } })}
              >
                <Ionicons name="add" size={16} color="#fff" />
                <Text style={s.chipAddTx}>Find a job</Text>
              </TouchableOpacity>
            </ScrollView>
          ) : (
            <TouchableOpacity
              style={[s.chipsRow, s.emptyTargets]}
              activeOpacity={0.85}
              onPress={() => nav()?.push?.({ pathname: '/(ai-hub)', params: { tab: 'search' } })}
            >
              <Ionicons name="search" size={15} color="#fff" />
              <Text style={s.emptyTargetsTx}>Find a job to design your resume around</Text>
              <Ionicons name="arrow-forward" size={14} color="rgba(255,255,255,0.6)" />
            </TouchableOpacity>
          )}
        </View>

        {/* the paper */}
        <View style={{ paddingTop: 10 }}>
          {noResume ? (
            <NoResume onBuild={() => {
              AsyncStorage.setItem('resume_builder_entry', JSON.stringify({ from: 'home_employer', autoBuild: true })).catch(() => {});
              nav()?.push?.('/(resume-builder)');
            }} />
          ) : cards.length ? (
            <PaperCarousel
              cards={cards}
              index={cardIdx}
              onIndex={setCardIdx}
              ribbon={target ? { letter: target.initial, short: target.company, colors: target.colors } : null}
            />
          ) : (
            <View style={s.paperLoading}><ActivityIndicator color="#fff" /></View>
          )}

          {/* caption */}
          <View style={s.caption}>
            {reshaping ? (
              <View style={s.rowCenter}>
                <Ionicons name="sparkles" size={12} color="#C4BBFF" />
                <Text style={s.captionScan}> Reshaping for {target?.company || 'this employer'}…</Text>
              </View>
            ) : (
              <View style={s.rowCenter}>
                <Text style={s.captionName}>{card?.name || 'Your resume'}</Text>
                <View style={s.capDot} />
                <Text style={s.captionMeta}>
                  {target
                    ? `${target.match != null ? target.match + '% match · ' : ''}${target.company}`
                    : 'Ready to send'}
                </Text>
              </View>
            )}
          </View>
        </View>
      </MeshStage>

      {/* ───────────────────────── CTA ───────────────────────── */}
      <View style={{ paddingHorizontal: 16, paddingTop: 18 }}>
        <TouchableOpacity activeOpacity={0.9} onPress={onDownload}>
          <LinearGradient
            colors={[E.blue, E.purple, E.purpleLite]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={s.cta}
          >
            <Shimmer />
            <Ionicons name={mode === 'letter' ? 'create' : (isPaid ? 'download-outline' : 'lock-closed')} size={17} color="#fff" />
            <Text style={s.ctaTx} numberOfLines={1}>
              {mode === 'letter'
                ? (target ? `Write for ${target.company}` : 'Write a cover letter')
                : (noResume ? 'Build my resume' : target ? `Download for ${target.company}` : 'Download my resume')}
            </Text>
          </LinearGradient>
        </TouchableOpacity>
        <View style={s.reassure}>
          <Ionicons name="checkmark-circle" size={13} color={E.tealDeep} />
          <Text style={s.reassureTx}>
            {isPaid ? 'Preview every design free · downloads are on your plan' : 'Preview every design free · downloads are on paid plans'}
          </Text>
        </View>
      </View>

      {/* ───────────────────────── SAMPLES ───────────────────────── */}
      {targets.length > 0 && (
        <View style={{ paddingHorizontal: 16, paddingTop: 26 }}>
          <View style={s.rowBetween}>
            <View>
              <Text style={s.eyebrow}>Your targets</Text>
              <Text style={s.sectionTitle}>
                {targets.length === 1 ? 'One employer, tailored' : `Same you, ${targets.length} employers`}
              </Text>
            </View>
            <TouchableOpacity
              style={s.rowCenter}
              activeOpacity={0.8}
              onPress={() => nav()?.push?.({ pathname: '/(ai-hub)', params: { tab: 'myjobs' } })}
            >
              <Text style={s.moreTx}>More jobs </Text>
              <Ionicons name="arrow-forward" size={12} color={E.blueDeep} />
            </TouchableOpacity>
          </View>
          <View style={s.grid}>
            {targets.slice(0, 6).map((t, i) => (
              <TargetCard
                key={t.key}
                t={t}
                image={cards[i % Math.max(1, cards.length)]?.image}
                onPress={() => { pickEmployer(targets.indexOf(t)); }}
              />
            ))}
          </View>
        </View>
      )}

      {/* the old home, one tap away */}
      <TouchableOpacity style={s.dashLink} activeOpacity={0.8} onPress={onOpenDashboard}>
        <Ionicons name="grid-outline" size={15} color={E.textMuted} />
        <Text style={s.dashLinkTx}>Open Dashboard</Text>
        <Ionicons name="chevron-forward" size={14} color={E.textFaint} />
      </TouchableOpacity>
    </ScrollView>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────────── */

function LiveDot() {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const l = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(a, { toValue: 0, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    l.start(); return () => l.stop();
  }, [a]);
  return <Animated.View style={[s.liveDot, { opacity: a.interpolate({ inputRange: [0, 1], outputRange: [1, 0.35] }), transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [1, 0.7] }) }] }]} />;
}

function Shimmer() {
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const l = Animated.loop(Animated.sequence([
      Animated.delay(1200),
      Animated.timing(x, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    l.start(); return () => l.stop();
  }, [x]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[s.shimmer, { transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [-160, 420] }) }, { skewX: '-18deg' }] }]}
    />
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const opts: Array<{ k: Mode; l: string; ic: any }> = [
    { k: 'resume', l: 'Resume', ic: 'document-text-outline' },
    { k: 'letter', l: 'Cover letter', ic: 'create-outline' },
  ];
  return (
    <View style={s.toggle}>
      {opts.map((o) => {
        const on = mode === o.k;
        return (
          <TouchableOpacity key={o.k} onPress={() => onChange(o.k)} activeOpacity={0.9} style={[s.toggleBtn, on && s.toggleBtnOn]}>
            <Ionicons name={o.ic} size={15} color={on ? E.blue : 'rgba(255,255,255,0.75)'} />
            <Text style={[s.toggleTx, on && s.toggleTxOn]}>{o.l}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function EmployerChip({ t, on, onPress }: { t: Target; on: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={[s.chip, on && s.chipOn]}>
      <LinearGradient colors={t.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.chipTile}>
        <Text style={s.chipTileTx}>{t.initial}</Text>
      </LinearGradient>
      <View style={{ maxWidth: 132 }}>
        <Text style={[s.chipName, on && { color: E.ink }]} numberOfLines={1}>{t.company}</Text>
        <Text style={[s.chipRole, on && { color: E.textMuted }]} numberOfLines={1}>{t.role}</Text>
      </View>
      {t.match != null && (
        <View style={[s.chipPct, on && { backgroundColor: 'rgba(79,141,255,0.14)' }]}>
          <Text style={[s.chipPctTx, on && { color: E.blueDeep }]}>{t.match}%</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

function TargetCard({ t, image, onPress }: { t: Target; image?: string | null; onPress: () => void }) {
  const strong = (t.match ?? 0) >= 90;
  return (
    <TouchableOpacity style={s.tCard} activeOpacity={0.9} onPress={onPress}>
      <View style={s.tThumb}>
        {image ? (
          <Animated.Image source={{ uri: image }} style={s.tThumbImg} resizeMode="cover" />
        ) : (
          <View style={[s.tThumbImg, { backgroundColor: '#EEF2F8' }]} />
        )}
        <LinearGradient colors={t.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.tBadge}>
          <Text style={s.tBadgeTx}>{t.initial}</Text>
        </LinearGradient>
        {t.match != null && (
          <View style={[s.tPct, { backgroundColor: strong ? E.tealDeep : E.blueDeep }]}>
            <Text style={s.tPctTx}>{t.match}%</Text>
          </View>
        )}
      </View>
      <Text style={s.tOrg} numberOfLines={1}>{t.company}</Text>
      <Text style={s.tRole} numberOfLines={1}>{t.role}</Text>
      {!!t.skills.length && (
        <View style={s.tChips}>
          {t.skills.slice(0, 3).map((sk) => (
            <View key={sk} style={s.tChip}><Text style={s.tChipTx} numberOfLines={1}>{sk}</Text></View>
          ))}
        </View>
      )}
    </TouchableOpacity>
  );
}

function NoResume({ onBuild }: { onBuild: () => void }) {
  return (
    <View style={s.noResume}>
      <View style={s.noResumeIcon}><Ionicons name="sparkles" size={26} color={E.blue} /></View>
      <Text style={s.noResumeTitle}>Build your resume first</Text>
      <Text style={s.noResumeSub}>We rebuild it from the one you already have — then design it for each employer.</Text>
      <TouchableOpacity onPress={onBuild} activeOpacity={0.9} style={{ marginTop: 14 }}>
        <LinearGradient colors={[E.blue, E.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.noResumeBtn}>
          <Ionicons name="color-wand" size={16} color="#fff" />
          <Text style={s.noResumeBtnTx}>Build with AI</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

/* ── styles ─────────────────────────────────────────────────────────────── */
const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: E.bg },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowCenter: { flexDirection: 'row', alignItems: 'center' },

  topBar: { paddingHorizontal: 16, paddingTop: Platform.select({ ios: 8, default: 12 }), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandMark: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  brandTx: { fontSize: 17, fontWeight: '800', color: '#fff', letterSpacing: -0.3 },
  topActions: { flexDirection: 'row', gap: 8 },
  glassBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: -3, right: -3, minWidth: 16, height: 16, paddingHorizontal: 3, borderRadius: 8, backgroundColor: '#EF4444', alignItems: 'center', justifyContent: 'center' },
  badgeTx: { fontSize: 9, fontWeight: '800', color: '#fff' },

  livePill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 5, paddingLeft: 8, paddingRight: 10, borderRadius: 100, backgroundColor: 'rgba(20,184,166,0.14)', borderWidth: 1, borderColor: 'rgba(20,184,166,0.32)' },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#2DE0C0' },
  livePillTx: { fontSize: 9.5, fontWeight: '700', color: E.mint, letterSpacing: 1.4 },
  editBtn: { height: 30, paddingHorizontal: 11, borderRadius: 100, backgroundColor: E.glass, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', flexDirection: 'row', alignItems: 'center', gap: 5 },
  editTx: { fontSize: 11.5, fontWeight: '700', color: '#fff' },

  h1: { fontSize: 30, fontWeight: '800', color: '#fff', letterSpacing: -1.2, lineHeight: 32 },
  h1Accent: { fontFamily: SERIF, fontStyle: 'italic', fontSize: 33, lineHeight: 40, letterSpacing: -0.6, marginTop: 2 },
  sub: { fontSize: 13, fontWeight: '500', color: E.onDark, marginTop: 10, lineHeight: 19 },

  toggle: { flexDirection: 'row', padding: 4, borderRadius: 16, backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder, gap: 4 },
  toggleBtn: { flex: 1, height: 40, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  toggleBtnOn: { backgroundColor: '#fff' },
  toggleTx: { fontSize: 13.5, fontWeight: '700', color: 'rgba(255,255,255,0.75)', letterSpacing: -0.2 },
  toggleTxOn: { color: E.ink },

  eyebrowDark: { fontSize: 10, fontWeight: '700', letterSpacing: 1.8, textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)', paddingHorizontal: 16, paddingBottom: 8 },
  chipsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, alignItems: 'center' },
  chip: { height: 46, paddingLeft: 6, paddingRight: 10, borderRadius: 14, borderWidth: 1, borderColor: E.glassBorder, backgroundColor: E.glass, flexDirection: 'row', alignItems: 'center', gap: 8 },
  chipOn: { backgroundColor: '#fff', borderColor: 'rgba(255,255,255,0.9)' },
  chipTile: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  chipTileTx: { fontSize: 12.5, fontWeight: '800', color: '#fff' },
  chipName: { fontSize: 12.5, fontWeight: '800', color: '#fff', letterSpacing: -0.2 },
  chipRole: { fontSize: 9.5, fontWeight: '600', color: 'rgba(255,255,255,0.6)', marginTop: 2 },
  chipPct: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 100, backgroundColor: 'rgba(255,255,255,0.16)' },
  chipPctTx: { fontSize: 10, fontWeight: '800', color: '#fff' },
  chipAdd: { height: 46, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.35)', flexDirection: 'row', alignItems: 'center', gap: 6 },
  chipAddTx: { fontSize: 12, fontWeight: '700', color: '#fff' },
  chipSkeleton: { width: 150, height: 46, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.07)' },
  emptyTargets: { marginHorizontal: 16, paddingHorizontal: 14, height: 48, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.3)', gap: 8 },
  emptyTargetsTx: { flex: 1, fontSize: 12.5, fontWeight: '700', color: '#fff' },

  paperLoading: { height: 300, alignItems: 'center', justifyContent: 'center' },
  caption: { alignItems: 'center', marginTop: 8, height: 18 },
  captionName: { fontSize: 13, fontWeight: '800', color: '#fff', letterSpacing: -0.3 },
  capDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)', marginHorizontal: 8 },
  captionMeta: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)' },
  captionScan: { fontSize: 12, fontWeight: '600', color: '#C4BBFF' },

  cta: { height: 54, borderRadius: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, overflow: 'hidden', shadowColor: E.blue, shadowOffset: { width: 0, height: 14 }, shadowOpacity: 0.42, shadowRadius: 30, elevation: 10 },
  ctaTx: { fontSize: 15.5, fontWeight: '800', color: '#fff', letterSpacing: -0.2 },
  shimmer: { position: 'absolute', top: -10, bottom: -10, width: 70, backgroundColor: 'rgba(255,255,255,0.28)' },
  reassure: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10 },
  reassureTx: { fontSize: 11.5, fontWeight: '600', color: E.textMuted },

  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.8, textTransform: 'uppercase', color: E.textFaint },
  sectionTitle: { fontSize: 19, fontWeight: '800', color: E.ink, letterSpacing: -0.7, marginTop: 3 },
  moreTx: { fontSize: 12.5, fontWeight: '700', color: E.blueDeep },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  tCard: { width: '48%', flexGrow: 1, backgroundColor: E.surface, borderRadius: 18, borderWidth: 1, borderColor: E.border, padding: 8, shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.05, shadowRadius: 18, elevation: 2 },
  tThumb: { width: '100%', aspectRatio: 300 / 424, borderRadius: 11, overflow: 'hidden', backgroundColor: '#fff', borderWidth: 1, borderColor: E.border },
  tThumbImg: { width: '100%', height: '100%' },
  tBadge: { position: 'absolute', left: 6, top: 6, width: 22, height: 22, borderRadius: 7, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#fff' },
  tBadgeTx: { fontSize: 11, fontWeight: '800', color: '#fff' },
  tPct: { position: 'absolute', right: 6, top: 6, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 100 },
  tPctTx: { fontSize: 9.5, fontWeight: '800', color: '#fff' },
  tOrg: { fontSize: 12.5, fontWeight: '800', color: E.ink, letterSpacing: -0.2, marginTop: 9, paddingHorizontal: 4 },
  tRole: { fontSize: 10.5, fontWeight: '500', color: E.textMuted, marginTop: 2, paddingHorizontal: 4 },
  tChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 7, paddingHorizontal: 4, paddingBottom: 2 },
  tChip: { paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6, backgroundColor: E.inputBg, maxWidth: '100%' },
  tChipTx: { fontSize: 9, fontWeight: '700', color: E.textMuted },

  noResume: { marginHorizontal: 16, padding: 20, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: E.glassBorder, alignItems: 'center' },
  noResumeIcon: { width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(79,141,255,0.16)', alignItems: 'center', justifyContent: 'center' },
  noResumeTitle: { fontSize: 17, fontWeight: '800', color: '#fff', marginTop: 12, letterSpacing: -0.4 },
  noResumeSub: { fontSize: 12.5, color: E.onDark, textAlign: 'center', marginTop: 6, lineHeight: 18 },
  noResumeBtn: { height: 46, paddingHorizontal: 22, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 8 },
  noResumeBtnTx: { fontSize: 14, fontWeight: '800', color: '#fff' },

  dashLink: { marginHorizontal: 16, marginTop: 26, height: 46, borderRadius: 14, backgroundColor: E.surface, borderWidth: 1, borderColor: E.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  dashLinkTx: { flex: 0, fontSize: 13, fontWeight: '700', color: E.textMuted },
});
