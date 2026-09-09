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
  ActivityIndicator, RefreshControl, Alert, Platform, Image,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { E, SERIF, sweepWords } from './theme';
import MeshStage from './MeshStage';
import PaperCarousel, { PaperCard } from './PaperCarousel';
import PaperZoom, { OriginRect } from './PaperZoom';
import AddEmployerSheet from './AddEmployerSheet';
import { fetchTargets, fetchHomeCards, fetchTemplateCatalogue, bestDesignForCountry, LETTER_DESIGNS, Target, HomeCard, HomeCards } from '../../services/employerHomeService';
import { fetchSubscriptionStatus } from '../../services/subscriptionService';
import { track } from '../../services/analytics';

const nav = () => require('expo-router').router;

type Mode = 'resume' | 'letter';

export default function EmployerHome({
  firstName, onOpenDashboard, onOpenMenu, onOpenNotifications, unreadCount = 0, handleReview,
  loaders,
}: {
  firstName?: string;
  onOpenDashboard: () => void;
  onOpenMenu: () => void;
  onOpenNotifications: () => void;
  unreadCount?: number;
  handleReview?: (tab?: number) => void;
  // Injectable data sources, defaulting to the real services. The preview route passes fixtures
  // so the design can be rendered and inspected without a signed-in account.
  loaders?: {
    targets: () => Promise<Target[]>;
    cards: () => Promise<HomeCards | 'none' | null>;
    paid?: () => Promise<boolean>;
    catalogue?: () => Promise<HomeCard[]>;
  };
}) {
  // The dark stage runs edge to edge under the status bar (HomeScreen drops its top safe-area
  // edge for this screen), so the hero owns that inset itself. Without this the notch band is
  // painted in the app's LIGHT background and sits as a grey strip above the near-black hero.
  const insets = useSafeAreaInsets();
  const [rootH, setRootH] = useState(0);
  const [zoom, setZoom] = useState<{ i: number; rect: OriginRect } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const regionHint = useCallback((c: string) => bestDesignForCountry(c)?.name || null, []);
  /**
   * Tell the builder which posting this is for. The server tailors the resume to it — ordering and
   * wording only, never invented facts.
   * ⚠️ `autoBuild` is NOT set here: that lane generates immediately and spends a plan generation.
   */
  const armBuilderFor = useCallback(async (t?: Target) => {
    await AsyncStorage.setItem('resume_builder_entry', JSON.stringify({
      from: 'home_employer',
      target: t ? { company: t.company, role: t.role, applyUrl: t.applyUrl || t.jobUrl || '' } : null,
    })).catch(() => {});
  }, []);
  // Drives ONLY the pinned header's backdrop. Native driver, and the header is a sibling of the
  // ScrollView — a separate view tree from the mesh, so the b126 one-driver-per-tree rule holds.
  const scrollY = useRef(new Animated.Value(0)).current;
  const [targets, setTargets] = useState<Target[]>([]);
  const [empIdx, setEmpIdx] = useState(0);
  const [cards, setCards] = useState<HomeCard[]>([]);
  // Every design in the catalogue, as a slot. Pixels arrive later and are merged in by id.
  const [slots, setSlots] = useState<HomeCard[]>([]);
  const [shots, setShots] = useState<Record<string, string>>({});
  const dead = useRef<Record<string, true>>({});
  const hydrating = useRef(false);
  const [cardIdx, setCardIdx] = useState(0);
  const [mode, setMode] = useState<Mode>('resume');
  const [loading, setLoading] = useState(true);
  const [noResume, setNoResume] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // These pages are a stand-in built from the account's name and email — say so.
  const [sample, setSample] = useState(false);
  const [isPaid, setIsPaid] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reshaping, setReshaping] = useState(false);
  const lastLoad = useRef(0);
  // The employer the user actually TAPPED, held by key. empIdx alone is a position into a list
  // that is re-fetched and re-sorted by match on every focus, so a background refresh could slide
  // a different company under the same index — the ribbon and the CTA would silently rename
  // themselves to an employer the user never chose. Stays null until they pick, so the default
  // (best match first) is still free to move.
  const pickedKey = useRef<string | null>(null);

  const loadTargets = loaders?.targets || fetchTargets;
  const loadCards = loaders?.cards || fetchHomeCards;
  const loadPaid = loaders?.paid || (async () => { try { const st = await fetchSubscriptionStatus(); return !!st?.subscription; } catch { return false; } });

  const load = useCallback(async (force = false) => {
    if (!force && Date.now() - lastLoad.current < 60_000) return;
    lastLoad.current = Date.now();
    const [t, c, cat] = await Promise.all([
      loadTargets(),
      loadCards(),
      (loaders?.catalogue || fetchTemplateCatalogue)().catch(() => [] as HomeCard[]),
    ]);
    if (cat.length) setSlots(cat);
    setTargets(t);
    if (pickedKey.current) {
      const j = t.findIndex((x) => x.key === pickedKey.current);
      setEmpIdx(j >= 0 ? j : 0);
      if (j < 0) pickedKey.current = null; // their employer dropped off the list
    }
    // ⚠️ Only the server's own 'none' may arm the build-my-resume lane — see fetchHomeCards.
    // A transient failure leaves cards AND noResume exactly as they were: at worst the user sees
    // the retry state, never a CTA that would spend a generation rewriting a resume they have.
    if (c === 'none') { setCards([]); setNoResume(true); setLoadFailed(false); }
    else if (c) { setCards(c.cards); setNoResume(false); setSample(!!c.sample); setLoadFailed(false); }
    else { setLoadFailed(true); }
    setLoading(false);
    setIsPaid(await loadPaid());
  }, [loadTargets, loadCards, loadPaid]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(true); setRefreshing(false); };

  const target: Target | undefined = targets[empIdx];
  // What the carousel actually shows. With a catalogue we show EVERY design — the ones the server
  // already rendered lead, the rest follow as slots and fill in on approach.
  const deck: PaperCard[] = React.useMemo(() => {
    if (!slots.length) return cards as PaperCard[];
    const ready = new Map(cards.map((c) => [c.id, c] as const));
    const lead = cards.map((c) => ({ ...c, image: shots[c.id] || c.image })) as PaperCard[];
    const rest = slots
      .filter((sl) => !ready.has(sl.id))
      .map((sl) => ({ ...sl, image: shots[sl.id] || null })) as PaperCard[];
    return [...lead, ...rest];
  }, [cards, slots, shots]);

  // Fill in the pages around the one being looked at, a few at a time and never two waves at once:
  // renders are serial server-side and the preview browser recycles every 3 pages.
  useEffect(() => {
    if (!deck.length || noResume || loaders) return;
    let cancelled = false;
    const run = async () => {
      if (hydrating.current) return;
      // ⚠️ BOUNDED to the cards either side of the one on screen. An unbounded search would always
      // find five more missing designs somewhere in the deck, so each wave would trigger the next
      // and the whole catalogue would render itself off one glance at Home — exactly the stampede
      // the 5-per-request cap exists to prevent. Nothing renders unless it is nearly in view.
      const WINDOW = 6;
      const want: string[] = [];
      for (let k = 0; k <= WINDOW * 2 && want.length < 5; k++) {
        const i = cardIdx + (k % 2 === 0 ? k / 2 : -((k + 1) / 2));
        if (i < 0 || i >= deck.length) continue;
        const d = deck[Math.round(i)];
        if (d && !d.image && !dead.current[d.id] && !want.includes(d.id)) want.push(d.id);
      }
      if (!want.length) return;
      hydrating.current = true;
      try {
        const got = await fetchHomeCards(want);
        if (cancelled) return;
        if (got && got !== 'none') {
          const add: Record<string, string> = {};
          for (const c of got.cards) if (c.image) add[c.id] = c.image;
          for (const id of want) if (!add[id]) dead.current[id] = true;
          if (Object.keys(add).length) setShots((p) => ({ ...p, ...add }));
        } else {
          for (const id of want) dead.current[id] = true;   // don't hammer a failing renderer
        }
      } finally {
        hydrating.current = false;
      }
    };
    const id = setTimeout(run, 260);
    return () => { cancelled = true; clearTimeout(id); };
  }, [cardIdx, deck, noResume, loaders]);

  const card: PaperCard | undefined = deck[cardIdx];

  // Picking an employer "reshapes" the page — the scan pulse the mockup plays over the card.
  const pickEmployer = (i: number) => {
    if (i === empIdx) return;
    setEmpIdx(i);
    pickedKey.current = targets[i]?.key || null;
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

  const headline = mode === 'resume' ? 'Design your resume' : 'Write your cover letter';
  const accent = mode === 'resume' ? 'exclusively for the employer.' : 'for this exact posting.';

  const headerH = insets.top + 52;
  // The stage must outrun the viewport so the first screenful is ALL gradient and the fade into the
  // grey is something you only meet on the way down (minHeight, so it still grows with content).
  // Just past the fold — enough that screen one is unbroken gradient, not so much that scrolling
  // drags through a dead field of it before the content resumes.
  const stageH = rootH ? Math.round(rootH * 1.18) : 900;
  const fadeFrom = rootH ? Math.min(0.88, (rootH * 0.97) / stageH) : 0.8;

  return (
    <View style={s.root} onLayout={(e) => setRootH(e.nativeEvent.layout.height)}>
      <Animated.ScrollView
        style={s.flex}
        contentContainerStyle={{ paddingBottom: 108 }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={E.blue} progressViewOffset={headerH} />}
      >
      {/* ───────────────────────── DARK STAGE ───────────────────────── */}
      <MeshStage style={{ minHeight: stageH, paddingTop: headerH }} fadeFrom={fadeFrom}>
        {/* live pill + edit */}
        <View style={[s.rowBetween, { paddingHorizontal: 16, paddingTop: 14 }]}>
          <View style={s.livePill}>
            <LiveDot />
            <Text style={s.livePillTx}>TAILORED PER EMPLOYER · LIVE</Text>
          </View>
          <TouchableOpacity onPress={() => nav()?.push?.('/(resume-builder)')} style={s.editBtn} activeOpacity={0.85}>
            <Ionicons name="create-outline" size={12} color="#fff" />
            <Text style={s.editTx}>Edit details</Text>
          </TouchableOpacity>
        </View>

        {/* headline — the mode switch rides the free space on its right */}
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <View style={s.headRow}>
            <Text style={[s.h1, s.headText]}>{headline}</Text>
            <ModeSwitch mode={mode} onChange={switchMode} />
          </View>
          <Text style={s.h1Accent}>
            {sweepWords(accent).map((p, i) => (
              <Text key={i} style={{ color: p.c }}>{p.w}{i < accent.split(' ').length - 1 ? ' ' : ''}</Text>
            ))}
          </Text>
          <Text style={s.sub}>
            {mode === 'resume'
              ? 'One posting, one resume — reshaped around what they ask for.'
              : 'Written from this posting and your experience.'}
          </Text>
        </View>

        {/* employer chips */}
        <View style={{ paddingTop: 14 }}>
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
                onPress={() => { track('home_add_employer_open', { from: 'chips' }); setAddOpen(true); }}
              >
                <Ionicons name="add" size={16} color="#fff" />
                <Text style={s.chipAddTx}>Add employer</Text>
              </TouchableOpacity>
            </ScrollView>
          ) : (
            <TouchableOpacity
              style={[s.chipsRow, s.emptyTargets]}
              activeOpacity={0.85}
              onPress={() => { track('home_add_employer_open', { from: 'empty' }); setAddOpen(true); }}
            >
              <Ionicons name="add" size={15} color="#fff" />
              <Text style={s.emptyTargetsTx}>Add an employer to design your resume around</Text>
              <Ionicons name="arrow-forward" size={14} color="rgba(255,255,255,0.6)" />
            </TouchableOpacity>
          )}
        </View>

        {/* the paper */}
        <View style={{ paddingTop: 10 }}>
          {mode === 'letter' ? (
            <LetterPanel
              company={target?.company}
              onWrite={() => {
                track('home_letter_write', { hasTarget: !!target });
                if (target?.jobId || target?.jobUrl) {
                  nav()?.push?.({ pathname: '/(ai-hub)', params: { tab: 'myjobs' } });
                } else {
                  setAddOpen(true);
                }
              }}
            />
          ) : noResume ? (
            <NoResume onBuild={() => {
              AsyncStorage.setItem('resume_builder_entry', JSON.stringify({ from: 'home_employer', autoBuild: true })).catch(() => {});
              nav()?.push?.('/(resume-builder)');
            }} />
          ) : deck.length ? (
            <PaperCarousel
              cards={deck}
              index={cardIdx}
              onIndex={setCardIdx}
              ribbon={target ? { letter: target.initial, short: target.company, colors: target.colors } : null}
              onOpen={(i, rect) => { setCardIdx(i); setZoom({ i, rect }); track('home_paper_open', { i }); }}
            />
          ) : loadFailed ? (
            <TouchableOpacity style={s.paperLoading} activeOpacity={0.8} onPress={() => load(true)}>
              <Ionicons name="cloud-offline-outline" size={22} color="rgba(255,255,255,0.5)" />
              <Text style={s.paperFailTx}>Couldn't load your designs</Text>
              <Text style={s.paperFailSub}>Tap to retry</Text>
            </TouchableOpacity>
          ) : (
            <View style={s.paperLoading}><ActivityIndicator color="#fff" /></View>
          )}

          {/* caption */}
          {mode === 'resume' && (
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
          )}

          {sample && mode === 'resume' && (
            <TouchableOpacity
              style={s.sampleBar}
              activeOpacity={0.9}
              onPress={() => {
                track('home_sample_build', { hasTarget: !!target });
                armBuilderFor(target).finally(() => nav()?.push?.('/(resume-builder)'));
              }}
            >
              <Ionicons name="information-circle" size={15} color={E.mint} />
              <Text style={s.sampleTx} numberOfLines={2}>
                This is a sample so you can see the designs. Build yours to fill them with your own details.
              </Text>
              <Ionicons name="chevron-forward" size={15} color="rgba(255,255,255,0.55)" />
            </TouchableOpacity>
          )}
        </View>
      </MeshStage>

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
        <Text style={s.dashLinkTx} numberOfLines={1}>Open Dashboard</Text>
        <Ionicons name="chevron-forward" size={14} color={E.textFaint} />
      </TouchableOpacity>
      </Animated.ScrollView>

      {/* ── PINNED HEADER ───────────────────────────────────────────────────
          It never scrolls, so it can no longer ride up under the clock and battery.
          Its backdrop is TRANSPARENT at rest and fades in only once the page moves: at the top of
          the screen there is literally nothing painted here, so it cannot read as a second
          background — the stage's own flat top band shows through and the two are one surface. */}
      <View style={[s.headerWrap, { height: headerH, paddingTop: insets.top }]} pointerEvents="box-none">
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { opacity: scrollY.interpolate({ inputRange: [0, 64], outputRange: [0, 1], extrapolate: 'clamp' }) }]}
        >
          <LinearGradient colors={['rgba(7,10,24,0.97)', 'rgba(7,10,24,0.90)']} style={StyleSheet.absoluteFill} />
          <View style={s.headerHair} />
        </Animated.View>
        <View style={s.headerRow}>
          <View style={s.brandRow}>
            <Image source={require('../../assets/images/logo_img.png')} style={s.brandLogo} resizeMode="contain" />
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
      </View>

      {/* the page, full size, with the only two things you can do with a design */}
      <AddEmployerSheet
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        regionHint={regionHint}
        onPick={(value, extra) => {
          setAddOpen(false);
          const hasListing = !!(extra?.jobUrl || extra?.jobText);
          track('home_add_employer_pick', { url: /^https?:\/\//i.test(value), listing: hasListing });
          // ⚠️ A pasted job description NEVER travels as a route param — it can be thousands of
          // characters and params end up in the URL. It goes through storage; the param only says
          // that there is one to collect.
          if (hasListing) {
            AsyncStorage.setItem('pending_job_listing', JSON.stringify({
              jobUrl: extra?.jobUrl || '', jobText: extra?.jobText || '',
            })).catch(() => {});
          }
          // The Job Hub owns the add itself: it prechecks credits, spots job portals and recovers
          // in-flight searches. Home only decides WHICH employer, and for WHICH posting.
          nav()?.push?.({
            pathname: '/(ai-hub)',
            params: hasListing
              ? { tab: 'search', addCompany: value, withListing: '1' }
              : { tab: 'search', addCompany: value },
          });
        }}
      />

      <PaperZoom
        card={zoom ? deck[zoom.i] || null : null}
        origin={zoom?.rect || null}
        subtitle={target ? `Designed for ${target.company}` : undefined}
        isPaid={isPaid}
        sample={sample}
        onClose={() => setZoom(null)}
        onCustomize={() => {
          // ⚠️ Straight to the section editor. Writing 'resume_builder_entry' with autoBuild, or
          // 'resumeBuilderAction', would arm a PAID regeneration — neither is touched.
          track('home_customize', { mode, sample });
          if (sample) armBuilderFor(target).finally(() => nav()?.push?.('/(resume-builder)'));
          else nav()?.push?.('/(resume-builder)/preview');
        }}
        onViewPdf={() => {
          const id = zoom ? deck[zoom.i]?.id : undefined;
          track('home_view_pdf', { id });
          // The employer travels too: a download pass is bought PER EMPLOYER, so without this the
          // payment would have nothing to attach to.
          nav()?.push?.({
            pathname: '/(resume-builder)/templates',
            params: {
              ...(id ? { template: id } : {}),
              ...(target?.company ? { employer: target.company } : {}),
            },
          });
        }}
      />
    </View>
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

// Two icons, not two big tabs: the mode is a small, permanent control that sits in the space the
// headline leaves on its right — the headline is what the screen is about, not the switch.
function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const opts: Array<{ k: Mode; ic: any; a11y: string }> = [
    { k: 'resume', ic: 'document-text', a11y: 'Resume' },
    { k: 'letter', ic: 'mail', a11y: 'Cover letter' },
  ];
  return (
    <View style={s.mSwitch}>
      {opts.map((o) => {
        const on = mode === o.k;
        return (
          <TouchableOpacity
            key={o.k}
            onPress={() => onChange(o.k)}
            activeOpacity={0.9}
            accessibilityRole="button"
            accessibilityLabel={o.a11y}
            accessibilityState={{ selected: on }}
            style={[s.mBtn, on && s.mBtnOn]}
          >
            <Ionicons name={o.ic} size={16} color={on ? '#fff' : 'rgba(255,255,255,0.5)'} />
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ⚠️ Selection is a GLASS state, never a white pill. A white chip on the dark hero was the single
// loudest thing on the screen and fought every other surface; the selected chip should read as the
// same material, lit. Dropping the role line is what makes it narrow enough to scan.
function EmployerChip({ t, on, onPress }: { t: Target; on: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={[s.chip, on && s.chipOn]}
    >
      <LinearGradient colors={t.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.chipTile}>
        <Text style={s.chipTileTx}>{t.initial}</Text>
      </LinearGradient>
      {/* Two lines, because a chip identifies a POSTING: the same employer can appear twice and the
          role underneath is the only thing telling the two apart. */}
      <View style={s.chipText}>
        <Text style={[s.chipName, on && s.chipNameOn]} numberOfLines={1}>{t.company}</Text>
        {!!t.role && <Text style={[s.chipRole, on && s.chipRoleOn]} numberOfLines={1}>{t.role}</Text>}
      </View>
      {t.match != null && (
        <View style={[s.chipPct, on && s.chipPctOn]}>
          <Text style={[s.chipPctTx, on && s.chipPctTxOn]}>{t.match}%</Text>
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
          <ExpoImage source={{ uri: image }} style={s.tThumbImg} contentFit="cover" contentPosition="top" transition={160} />
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

// ⚠️ A letter is written FOR A POSTING, and no letter exists until one is generated — there is no
// cached letter-thumbnail endpoint to page through the way the resume side does. So this shows the
// designs by name and puts ONE explicit action in front of the user. It never generates on its own:
// generation spends the cover-letter quota, and auto-spending on screen entry is the exact mistake
// the letters auto-regen drain was.
function LetterPanel({ company, onWrite }: { company?: string; onWrite: () => void }) {
  return (
    <View style={s.letterPanel}>
      <View style={s.letterIcon}><Ionicons name="mail-open-outline" size={24} color={E.mint} /></View>
      <Text style={s.letterTitle} numberOfLines={2}>
        {company ? `Write a cover letter for ${company}` : 'Write a cover letter'}
      </Text>
      <Text style={s.letterSub} numberOfLines={3}>
        A letter is written from one posting, so it starts with the employer — then you pick from these {LETTER_DESIGNS.length} formats.
      </Text>
      {/* ⚠️ WRAPPED, NOT SCROLLED. A horizontal ScrollView inside this centre-aligned card took its
          CONTENT width, so it overflowed the panel on both sides and the row began mid-word — and
          the formats past the edge could not be read at all. Wrapping shows all seven. */}
      <View style={s.letterRow}>
        {LETTER_DESIGNS.map((d) => (
          <View key={d.id} style={s.letterChip}>
            <View style={[s.letterDot, { backgroundColor: d.accent }]} />
            <Text style={s.letterChipTx} numberOfLines={1}>{d.name}</Text>
          </View>
        ))}
      </View>
      <TouchableOpacity onPress={onWrite} activeOpacity={0.9} style={{ marginTop: 16 }}>
        <LinearGradient colors={[E.teal, E.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.letterBtn}>
          <Ionicons name="create" size={16} color="#fff" />
          <Text style={s.letterBtnTx} numberOfLines={1}>{company ? `Write for ${company}` : 'Choose an employer'}</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
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
  root: { flex: 1, backgroundColor: E.bg },
  flex: { flex: 1 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowCenter: { flexDirection: 'row', alignItems: 'center' },

  headerWrap: { position: 'absolute', top: 0, left: 0, right: 0 },
  headerRow: { flex: 1, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerHair: { position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.10)' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // the real mark, tinted: it is a single-colour glyph on transparency, so it reads on the hero
  brandLogo: { width: 26, height: 26, tintColor: '#fff' },
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

  h1: { fontSize: 26, fontWeight: '800', color: '#fff', letterSpacing: -1, lineHeight: 29 },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  headText: { flex: 1 },
  h1Accent: { fontFamily: SERIF, fontStyle: 'italic', fontSize: 26, lineHeight: 31, letterSpacing: -0.4, marginTop: 1 },
  sub: { fontSize: 12.5, fontWeight: '500', color: E.onDark, marginTop: 8, lineHeight: 17.5 },
  // the sub is context, not the message — never let it push the paper off screen


  mSwitch: { flexDirection: 'row', padding: 3, borderRadius: 13, backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder, gap: 3 },
  mBtn: { width: 36, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  mBtnOn: { backgroundColor: 'rgba(79,141,255,0.34)', borderWidth: 1, borderColor: 'rgba(150,186,255,0.55)' },

  eyebrowDark: { fontSize: 10, fontWeight: '700', letterSpacing: 1.8, textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)', paddingHorizontal: 16, paddingBottom: 8 },
  chipsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, alignItems: 'center' },
  chip: {
    height: 48, paddingLeft: 6, paddingRight: 10, borderRadius: 16, borderWidth: 1,
    borderColor: E.glassBorder, backgroundColor: E.glass,
    flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 218,
  },
  chipText: { flexShrink: 1 },
  chipOn: {
    backgroundColor: 'rgba(79,141,255,0.22)', borderColor: 'rgba(150,186,255,0.6)',
    ...Platform.select({ ios: { shadowColor: E.blue, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 12 }, default: { elevation: 4 } }),
  },
  chipTile: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  chipTileTx: { fontSize: 11.5, fontWeight: '800', color: '#fff' },
  chipName: { fontSize: 12.5, fontWeight: '700', color: 'rgba(255,255,255,0.8)', letterSpacing: -0.2 },
  chipRole: { fontSize: 10, fontWeight: '600', color: 'rgba(255,255,255,0.5)', marginTop: 1.5 },
  chipRoleOn: { color: 'rgba(255,255,255,0.78)' },
  chipNameOn: { color: '#fff', fontWeight: '800' },
  chipPct: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 100, backgroundColor: 'rgba(255,255,255,0.12)' },
  chipPctOn: { backgroundColor: 'rgba(255,255,255,0.22)' },
  chipPctTx: { fontSize: 9.5, fontWeight: '800', color: 'rgba(255,255,255,0.7)' },
  chipPctTxOn: { color: '#fff' },
  chipAdd: { height: 48, paddingHorizontal: 13, borderRadius: 100, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.32)', flexDirection: 'row', alignItems: 'center', gap: 6 },
  chipAddTx: { fontSize: 12, fontWeight: '700', color: '#fff' },
  chipSkeleton: { width: 150, height: 48, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.07)' },
  emptyTargets: { marginHorizontal: 16, paddingHorizontal: 14, height: 48, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.3)', gap: 8 },
  emptyTargetsTx: { flex: 1, fontSize: 12.5, fontWeight: '700', color: '#fff' },

  paperLoading: { height: 300, alignItems: 'center', justifyContent: 'center' },
  sampleBar: {
    marginHorizontal: 16, marginTop: 12, padding: 11, borderRadius: 15,
    flexDirection: 'row', alignItems: 'center', gap: 9,
    backgroundColor: 'rgba(20,184,166,0.13)', borderWidth: 1, borderColor: 'rgba(94,234,212,0.32)',
  },
  sampleTx: { flex: 1, fontSize: 11.5, fontWeight: '700', color: 'rgba(255,255,255,0.86)', lineHeight: 16 },
  letterPanel: { marginHorizontal: 16, marginTop: 6, padding: 18, borderRadius: 22, backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder, alignItems: 'center' },
  letterIcon: { width: 52, height: 52, borderRadius: 18, backgroundColor: 'rgba(20,184,166,0.16)', alignItems: 'center', justifyContent: 'center' },
  letterTitle: { marginTop: 12, fontSize: 17, fontWeight: '800', color: '#fff', letterSpacing: -0.4, textAlign: 'center' },
  letterSub: { marginTop: 6, fontSize: 12.5, fontWeight: '600', color: E.onDark, textAlign: 'center', lineHeight: 18 },
  letterRow: { alignSelf: 'stretch', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 7, paddingTop: 14 },
  letterChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 30, borderRadius: 100, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: E.glassBorder, maxWidth: '100%' },
  letterDot: { width: 8, height: 8, borderRadius: 100 },
  letterChipTx: { flexShrink: 1, fontSize: 11.5, fontWeight: '700', color: 'rgba(255,255,255,0.8)' },
  letterBtn: { height: 48, paddingHorizontal: 22, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  letterBtnTx: { fontSize: 14.5, fontWeight: '800', color: '#fff', flexShrink: 1 },
  paperFailTx: { color: 'rgba(255,255,255,0.72)', fontSize: 13.5, fontWeight: '700', marginTop: 10 },
  paperFailSub: { color: 'rgba(255,255,255,0.42)', fontSize: 12, marginTop: 3 },
  caption: { alignItems: 'center', marginTop: 8, height: 18 },
  captionName: { fontSize: 13, fontWeight: '800', color: '#fff', letterSpacing: -0.3 },
  capDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)', marginHorizontal: 8 },
  captionMeta: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)' },
  captionScan: { fontSize: 12, fontWeight: '600', color: '#C4BBFF' },

  // Same iOS trap as PaperCarousel.paper: the Shimmer needs overflow:'hidden', which would clip
  // the blue glow off the button. Glow on the touchable, clipping on the gradient.
  reassure: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10 },
  reassureTx: { fontSize: 11.5, fontWeight: '600', color: E.textMuted },

  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.8, textTransform: 'uppercase', color: E.textFaint },
  sectionTitle: { fontSize: 19, fontWeight: '800', color: E.ink, letterSpacing: -0.7, marginTop: 3 },
  moreTx: { fontSize: 12.5, fontWeight: '700', color: E.blueDeep },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  tCard: { width: '48%', backgroundColor: E.surface, borderRadius: 18, borderWidth: 1, borderColor: E.border, padding: 8, shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.05, shadowRadius: 18, elevation: 2 },
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
  dashLinkTx: { fontSize: 13, fontWeight: '700', color: E.textMuted },
});
