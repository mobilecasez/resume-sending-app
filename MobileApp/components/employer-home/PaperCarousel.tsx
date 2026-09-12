// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The 3D coverflow of REAL rendered resume/cover-letter pages. Cards are the user's own
// document — server-rendered and disk-cached (see /resume-builder/home-cards) — not a mock,
// so the promise on screen ("this is your resume, designed for this employer") is literally
// what they are looking at.
//
// ⚠️ ANIMATION DRIVER RULE (b126-128 fatal crash): never mix native and JS drivers on one view
// tree. Every animation here is transform/opacity driven by the scroll position with
// useNativeDriver:true, and nothing inside a card animates on the JS driver.
//
// ⚠️ React Native has NO translateZ. The mockup's translateZ(-|d|*50) depth is reproduced with
// scale + a small translateY, which is what the eye actually reads at this size.
//
// ⚠️ CARD SIZE IS MEASURED, NEVER READ FROM Dimensions AT MODULE LOAD. The b202 build centred the
// pager from a module-load window width and the first page sat flush against the left edge on a
// real device. Everything here derives from the container's own onLayout width.
//
// ⚠️ A TICKING PERCENTAGE NEVER LIVES IN Card. The building state's live % is React state, and state
// that changes every 90 ms re-renders whatever owns it. Owned by Card, that is the page, its
// skeleton and every interpolation under it, eleven times a second, on five cards. So it lives in
// BuildingPct → PctNumber, two tiny memo components that subscribe to the build store themselves;
// Card only knows WHICH build to show (kind + rk), which does not change while it runs.
import React, { useRef, useEffect, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, Animated, TouchableOpacity, Easing } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { E } from './theme';
import PaperSkeleton, { AFFORDANCE, PaperState } from './PaperSkeleton';
import { useTargetBuild, useCreepPct, storeKeyOf, type BuildPhase } from '../../services/homeBuilds';
import type { DocKind, BuildStage } from '../../services/homeAddEmployer';

const GAP = 18;
// ⚠️ WIDE ON PURPOSE, AND IT CANNOT BE LIVE. `dist` is measured from the SETTLED index, and the
// screen above only advances that in onMomentumScrollEnd — so for the entire duration of a fling
// the index is still whichever card the gesture started on. At the old window of 4 that meant
// every card crossing the viewport mid-fling drew as a bare accent band + name bar and only filled
// in once the deck had already stopped: the page content degraded exactly while the user was
// looking through it. The live distance `d` exists and is native-driven, but mounting views off it
// means an addListener callback on every frame — a JS-driven value in a native-driver tree, which
// is the b126-128 fatal crash. So the STATIC window is widened instead: with decelerationRate
// "fast" and snapToInterval a hard fling settles within ~8 steps, and 12 covers that with headroom.
// Cost of the extra reach is 12 flat, non-animated Views per card across 25 cards instead of 9.
const DETAIL_WINDOW = 12;
// Mirrors the hydrator above: it asks for cards within ±6 of the current one, 5 ids per wave
// (the /home-cards cap), and each wave's result re-triggers the next until the window is full.
const FETCH_WINDOW = 6;
const FETCH_BATCH = 5;
const A4 = 424 / 300;                 // page ratio, same as the renderer
/** The paper is the hero of this screen, so it takes as much width as the frame allows. */
export function cardWidthFor(containerW: number) {
  return Math.max(170, Math.min(252, Math.round((containerW || PROVISIONAL_W) * 0.6)));
}
// ⚠️ NEVER render nothing while waiting to be measured. The first build of this gated the whole
// pager on a measured width and simply drew a blank 300pt hole when onLayout had not arrived —
// which is what a device shows if the measurement is late or never comes. Lay out from a
// provisional phone width instead and correct on the first real measurement: worst case the cards
// reflow once, best case nobody ever sees a gap.
const PROVISIONAL_W = 360;

export type PaperCard = {
  id: string; name: string; accent?: string; image?: string | null;
  /** 0-100 chance this design gets picked for the employer (the doc's ranked design), null = unranked. */
  fit?: number | null;
  /** Why it fits, user-facing, <= 90 chars. Read out to screen readers; the caption owns the visible copy. */
  reason?: string | null;
};

/** The build a deck is waiting on. Identity only — the live numbers are read by BuildingPct. */
export type PaperBuilding = { kind: DocKind; rk: string; company: string };

type Metrics = { w: number; h: number; step: number };
type Ribbon = { letter: string; short: string; colors: [string, string] };
type OpenFn = (i: number, rect: { x: number; y: number; w: number; h: number }) => void;

/** Width the fit pill column reserves, so the "For …" ribbon truncates before it runs underneath. */
const FIT_CLEAR = 70;

/**
 * Fit tiers. ⚠️ Colours are for TEXT ON THE DARK PILL, not for the page: E.blue itself is too dim at
 * 8.5pt on rgba(11,15,34,0.86), so the blue tier uses a lifted tint of it.
 */
function fitTone(fit: number): string {
  if (fit >= 85) return E.mint;
  if (fit >= 70) return '#8CB4FF';
  return 'rgba(255,255,255,0.62)';
}

/**
 * Which pixel-less slots are genuinely being worked on, walked out from the centre in the same
 * order the hydrator uses so the words match what it will actually request.
 *
 * ⚠️ IT SAYS 'idle' UNLESS IT CAN SHOW ITS WORKING. Anything outside the fetch window is nobody's
 * job — it will not be requested until the user moves — and a card that says "loading" forever is
 * worse than a card that just says its own name. Residual: a slot the renderer already FAILED on
 * is marked dead upstairs and never retried, and that is invisible from here, so a dead card
 * inside the window still reads as busy. That is at most a handful next to the user rather than
 * the whole deck, and the fix when it matters is to pass the truth down through `state`.
 *
 * The `| undefined` in the return type is deliberate: most ids are simply ABSENT from this map, and
 * without it TypeScript reads the lookup as always-truthy — which makes the caller's `|| 'idle'`
 * look like dead code that a later cleanup would delete, taking every idle card's honesty with it.
 */
function hydrationStates(cards: PaperCard[], index: number): Record<string, PaperState | undefined> {
  const out: Record<string, PaperState | undefined> = {};
  let asked = 0;
  for (let k = 0; k <= FETCH_WINDOW * 2; k++) {
    const i = index + (k % 2 === 0 ? k / 2 : -((k + 1) / 2));
    if (i < 0 || i >= cards.length) continue;
    const c = cards[i];
    if (!c || c.image || out[c.id]) continue;
    if (asked < FETCH_BATCH) { out[c.id] = 'loading'; asked++; } else out[c.id] = 'queued';
  }
  return out;
}

/**
 * The live number on a building card. ⚠️ ISOLATED ON PURPOSE (see the header): useCreepPct ticks
 * every 90 ms, and this is the only component that re-renders when it does.
 */
const PctNumber = React.memo(function PctNumber({ stage, phase, size, buildKey }: {
  stage: BuildStage | null; phase: BuildPhase | null; size: number;
  /** storeKeyOf(kind, rk). ⚠️ Shared with the chip's line: a card that mounts late continues from the
   *  number the chip is already showing instead of seeding at the stage ceiling (two % for one build). */
  buildKey: string;
}) {
  const pct = useCreepPct(stage, phase, buildKey);
  return (
    <Text style={[s.bPct, { fontSize: size, lineHeight: Math.round(size * 1.08) }]} allowFontScaling={false}>
      {pct}<Text style={[s.bPctSign, { fontSize: Math.round(size * 0.5) }]}>%</Text>
    </Text>
  );
});

/**
 * The "being written" read-out centred on a building card: the live %, what the build is doing right
 * now, and the way back into the overlay. It subscribes to the build store by key, so it re-renders
 * when THIS build's record changes and at no other time (useTargetBuild's per-key snapshot).
 *
 * ⚠️ The bar is driven by the STAGE's own pct, not by the creeping number: the number changes eleven
 * times a second and restarting a native timing on every change is exactly the bridge traffic this
 * tree avoids. Stages move a handful of times per build, and a 700 ms ease-out lands the bar about
 * where the creep would have taken the number anyway.
 */
const BuildingPct = React.memo(function BuildingPct({ kind, rk, company, w }: PaperBuilding & { w: number }) {
  const b = useTargetBuild(kind, rk);
  const phase = b ? b.phase : null;
  const stage = b ? b.stage : null;
  const noun = kind === 'cover_letter' ? 'cover letter' : 'resume';
  const label = phase === 'queued' ? 'Queued · starts when a build finishes'
    : phase === 'error' ? (b?.error?.message || 'Didn’t finish')
    : (stage && stage.label) || (phase === 'checking' ? 'Checking your plan…' : `Writing your ${company} ${noun}`);

  const panelW = Math.round(w * 0.66);
  const trackW = panelW - 24;
  const target = phase === 'done' ? 1 : Math.max(0, Math.min(1, ((stage && stage.pct) || 0) / 100));
  const p = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.timing(p, { toValue: target, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [p, target]);
  // Full-width fill scaled on X from its LEFT edge: RN scales about the centre, so translate by the
  // half the scale took away. Transform only — never an animated width.
  const fill = useMemo(() => ({
    transform: [
      { translateX: p.interpolate({ inputRange: [0, 1], outputRange: [-trackW / 2, 0] }) },
      { scaleX: p.interpolate({ inputRange: [0, 1], outputRange: [0.001, 1] }) },
    ],
  }), [p, trackW]);

  const size = Math.round(Math.max(26, Math.min(40, w * 0.16)));
  return (
    <View style={s.bWrap} pointerEvents="none">
      <View style={[s.bPanel, { width: panelW }]}>
        {phase === 'queued'
          ? <Text style={[s.bQueued, { fontSize: Math.round(size * 0.6) }]} allowFontScaling={false}>Queued</Text>
          : <PctNumber stage={stage} phase={phase} size={size} buildKey={storeKeyOf(kind, rk)} />}
        <View style={[s.bTrack, { width: trackW }]}>
          <Animated.View style={[s.bFill, { width: trackW }, fill]} />
        </View>
        <Text style={s.bLabel} numberOfLines={1}>{label}</Text>
        <View style={s.bWatch}>
          <Ionicons name="eye-outline" size={11} color={E.mint} />
          <Text style={s.bWatchTx}>Tap to watch</Text>
        </View>
      </View>
    </View>
  );
});

/**
 * ⚠️ MEMOISED, AND EVERY PROP IS KEPT REFERENTIALLY STABLE UPSTREAM FOR IT TO WORK: `m`, `ribbon`,
 * `building` and both callbacks are memoised in PaperCarousel, and the settled index arrives as two
 * booleans (`near`, `detail`) instead of a distance — a distance changes for every card on every
 * swipe, a boolean only for the couple of cards crossing a threshold. Without that, one settle
 * re-rendered all 73 pages and rebuilt every one of their native interpolation nodes.
 */
const Card = React.memo(function Card({ card, i, near, detail, state, scrollX, ribbon, m, onOpen, building, onOpenBuilding, showFit }: {
  card: PaperCard; i: number; scrollX: Animated.Value; m: Metrics;
  /** Within 2 steps of the settled card. Gates what is allowed to LOOP (sweep, pen, glare, the live %). */
  near: boolean;
  /** Within DETAIL_WINDOW steps: draw the skeleton's body copy. */
  detail: boolean;
  /** Whether anything is actually fetching this slot's page — see hydrationStates. */
  state: PaperState;
  ribbon?: Ribbon | null;
  onOpen?: OpenFn;
  /** The deck's document is being rebuilt: draw the page being written, and a tap opens the build. */
  building?: PaperBuilding | null;
  onOpenBuilding?: () => void;
  showFit?: boolean;
}) {
  // The zoom grows out of the exact rectangle the finger is on, so the card measures itself at
  // the moment of the tap rather than the sheet guessing where it was.
  const box = useRef<any>(null);
  const open = () => {
    // ⚠️ A building deck has no page worth zooming into — every card is a drawing of the one being
    // written — so the tap goes to the thing the user can actually watch.
    if (building) { onOpenBuilding?.(); return; }
    if (!onOpen) return;
    const fallback = { x: 0, y: 0, w: m.w, h: m.h };
    if (!box.current?.measureInWindow) { onOpen(i, fallback); return; }
    box.current.measureInWindow((x: number, y: number, w: number, h: number) =>
      onOpen(i, w ? { x, y, w, h } : fallback));
  };

  // Distance from centre, in card-steps. ⚠️ Memoised: rebuilt inline, every render detached and
  // re-attached a fresh set of native nodes on each card for no change in what they compute.
  const anim = useMemo(() => {
    const d = Animated.divide(Animated.subtract(scrollX, i * m.step), m.step);
    const clamp = (out: [number, number, number]) =>
      d.interpolate({ inputRange: [-1.4, 0, 1.4], outputRange: out, extrapolate: 'clamp' });
    return {
      opacity: clamp([0.35, 1, 0.35]),
      rotateY: d.interpolate({ inputRange: [-1.4, 0, 1.4], outputRange: ['38deg', '0deg', '-38deg'], extrapolate: 'clamp' }),
      scale: clamp([0.82, 1, 0.82]),
      translateY: clamp([18, 0, 18]),
      reflect: clamp([0.22, 0.75, 0.22]),
      // ⚠️ TWO GATES, AND THEY ARE NOT REDUNDANT. `d` is the same native-driven distance-from-centre
      // that already turns and dims this card, so riding it costs nothing and the sweep dies as the
      // page rotates away — but an opacity of 0 does not stop an Animated.loop, and `d` cannot be read
      // in JS without a per-frame listener, which is exactly the bridge traffic this native-driver tree
      // exists to avoid. So the loops are MOUNTED off the settled index instead (`near`). 73 slots each
      // running a shimmer is a battery fire; this runs at most five and shows at most one. The sweep is
      // also gated on the state, for the same reason the label is: a slot that nothing is fetching
      // must not animate as though its page were on the way.
      sweepFade: d.interpolate({ inputRange: [-0.85, 0, 0.85], outputRange: [0, 1, 0], extrapolate: 'clamp' }),
    };
  }, [scrollX, i, m.step]);

  const fit = showFit && !building && card.fit != null ? Math.max(0, Math.min(100, Math.round(card.fit))) : null;
  // ⚠️ 'Best match' ONLY ON A REAL RANKING (card.fit present). An unranked saved doc still has a
  // first card, and "best" on it was a claim nothing had measured — and with no fit pill above it the
  // lone best pill sat on the ribbon row. Keying it off fit keeps the FIT_CLEAR cap below honest too.
  const best = !!showFit && !building && i === 0 && card.fit != null;
  const a11y = building
    ? `${card.name}. Your ${building.company} ${building.kind === 'cover_letter' ? 'cover letter' : 'resume'} is being written`
    : `${card.name}${fit != null ? `, ${fit}% fit` : ''}${best ? ', best match' : ''}${card.reason ? `. ${card.reason}` : ''}`;

  return (
    <Animated.View
      style={{
        width: m.w, marginRight: GAP,
        opacity: anim.opacity,
        transform: [
          { perspective: 700 },
          { rotateY: anim.rotateY },
          { scale: anim.scale },
          { translateY: anim.translateY },
        ],
      }}
    >
      <TouchableOpacity
        ref={box} activeOpacity={0.92} onPress={open} style={s.paperShadow}
        accessibilityRole="button" accessibilityLabel={a11y}
        accessibilityHint={building ? 'Opens the build progress' : 'Opens this design full screen'}
      >
        <View style={[s.paper, { width: m.w, height: m.h }]}>
          {/* ⚠️ THE PLACEHOLDER STAYS MOUNTED UNDERNEATH, ALWAYS. `transition` alone is NOT the
              cross-fade it looks like: expo-image fades from whatever that Image was already
              showing, and with no `placeholder` prop that is TRANSPARENT — so on its own the page
              fades up out of the bare white card and the user still watches a blank sheet for the
              1.7s serial chromium render. Fading in over a drawn page is what makes it read as the
              page filling in. Leaving it mounted afterwards also means an image that fails or gets
              evicted from expo-image's cache falls back to a page instead of to white, and it is
              ~20 flat Views with nothing to decode — cheaper than the onLoad state change and
              re-render that unmounting it would cost, mid-scroll, on the app's front door. */}
          <PaperSkeleton
            w={m.w} h={m.h} accent={card.accent} name={card.name}
            detail={detail} state={state}
            shimmer={(state === 'loading' || state === 'writing') && near} fade={anim.sweepFade}
          />
          {/* ⚠️ TOP-ANCHORED. `cover` alone centres the page, so anything taller than the card loses
              its head AND its foot — and the head is where the name is. Crop the tail instead.
              ⚠️ Hidden while building: those pixels are the version being REPLACED, and a finished-
              looking old page under "writing 40%" says the opposite of what is happening. */}
          {!!card.image && !building && (
            <Image source={{ uri: card.image }} style={s.img} contentFit="cover" contentPosition="top" transition={220} />
          )}
          {/* Same reason the sweep is gated: this was 73 concurrent loops on a 73-design deck, all
              but three of them sweeping a card nobody can see. Off while building — the pen is
              already moving on that page, and two moving things over one read-out is noise. */}
          {near && !building && <Glare w={m.w} />}
          {!!ribbon && (
            <View style={[s.ribbon, (fit != null || best) && { maxWidth: m.w - 16 - FIT_CLEAR }]}>
              <View style={[s.ribbonTile, { backgroundColor: ribbon.colors[0] }]}>
                <Text style={s.ribbonTileTx}>{ribbon.letter}</Text>
              </View>
              <Text style={s.ribbonTx} numberOfLines={1}>For {ribbon.short}</Text>
            </View>
          )}
          {(fit != null || best) && (
            <View style={s.fitCol} pointerEvents="none">
              {fit != null && (
                <View style={s.fitPill}>
                  <View style={[s.fitDot, { backgroundColor: fitTone(fit) }]} />
                  <Text style={[s.fitTx, { color: fitTone(fit) }]} allowFontScaling={false}>{fit}% fit</Text>
                </View>
              )}
              {best && (
                <View style={s.bestPill}>
                  <Ionicons name="sparkles" size={9} color={E.ink} />
                  <Text style={s.bestTx} allowFontScaling={false}>Best match</Text>
                </View>
              )}
            </View>
          )}
          {/* Only the cards near the centre carry the live read-out: each one is a ticking
              subscriber, and a card 30 steps away is a dimmed sliver nobody can read anyway. */}
          {!!building && near && <BuildingPct kind={building.kind} rk={building.rk} company={building.company} w={m.w} />}
          {/* the affordance for the zoom — without it nothing says the page is tappable */}
          {!building && (
            <View style={s.expand}>
              <Ionicons name="scan-outline" size={13} color="#fff" />
            </View>
          )}
        </View>
      </TouchableOpacity>
      {/* ⚠️ THIS WAS A SOLID BAR AND IT READ AS A RULE ACROSS THE SCREEN. A 6pt block of flat blue
          spanning the card width, sitting directly above the page counter, is a horizontal LINE —
          which on a screen whose whole point is that it has no seams was the most visible edge left
          on it. A reflection has no ends: this one fades to nothing at both, and it is dimmer and
          narrower than the card so it can never trace its edge. */}
      <Animated.View style={[s.reflect, { opacity: anim.reflect }]} pointerEvents="none">
        <LinearGradient
          colors={['rgba(79,141,255,0)', 'rgba(140,180,255,0.30)', 'rgba(79,141,255,0)']}
          start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </Animated.View>
  );
});

// A slow highlight travelling across the page — the mockup's "glare". Transform-only, native
// driver, same as everything else in this tree.
function Glare({ w }: { w: number }) {
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const l = Animated.loop(Animated.sequence([
      Animated.delay(900),
      Animated.timing(x, { toValue: 1, duration: 2200, useNativeDriver: true }),
      Animated.delay(2600),
    ]));
    l.start();
    return () => l.stop();
  }, [x]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[s.glare, { transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [-90, w + 90] }) }, { rotate: '12deg' }] }]}
    >
      {/* soft-edged: a hard white block read as a bar across the page */}
      <LinearGradient
        colors={['transparent', 'rgba(255,255,255,0.42)', 'transparent']}
        start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

/** With a large catalogue a dot per design is unreadable, so the strip is windowed. */
function Dots({ n, index }: { n: number; index: number }) {
  const MAX = 7;
  if (n <= 1) return null;
  let from = 0;
  if (n > MAX) from = Math.max(0, Math.min(n - MAX, index - Math.floor(MAX / 2)));
  const shown = Array.from({ length: Math.min(MAX, n) }, (_, k) => from + k);
  return (
    <View style={s.dots}>
      {shown.map((i) => <View key={i} style={[s.dot, i === index && s.dotOn]} />)}
      {n > MAX && <Text style={s.dotCount}>{index + 1}/{n}</Text>}
    </View>
  );
}

export default function PaperCarousel({ cards, index, onIndex, ribbon, onOpen, building, onOpenBuilding, showFit }: {
  cards: PaperCard[];
  index: number;
  onIndex: (i: number) => void;
  ribbon?: { letter: string; short: string; colors: [string, string] } | null;
  /** Tap a page to open it full-screen; the rect is where it was on screen when tapped. */
  onOpen?: (i: number, rect: { x: number; y: number; w: number; h: number }) => void;
  /**
   * The document behind this deck is being built right now (checking / queued / building). Every
   * card draws the page being written, the centre ones carry the live %, and a tap calls
   * onOpenBuilding instead of zooming. ⚠️ Identity only: pass the same kind/rk while it runs — the
   * numbers are read from the build store by BuildingPct, never pushed down through here.
   */
  building?: PaperBuilding | null;
  onOpenBuilding?: () => void;
  /** Draw the '<fit>% fit' pill (and 'Best match' on the first card, only when that card has a fit) — a ranked doc deck. */
  showFit?: boolean;
}) {
  const scrollX = useRef(new Animated.Value(0)).current;
  const ref = useRef<any>(null);
  const settled = useRef(index);
  const [width, setWidth] = React.useState(0);

  // One pass over the fetch window per render, not a scan per card.
  const states = React.useMemo(() => hydrationStates(cards, index), [cards, index]);

  const w = cardWidthFor(width);
  // ⚠️ Memoised for Card's React.memo: a fresh object per render defeats it on every card.
  const m: Metrics = useMemo(() => ({ w, h: Math.round(w * A4), step: w + GAP }), [w]);
  const side = width > w ? (width - w) / 2 : 16;

  // ⚠️ The screen passes these as inline literals and arrows, which are new on every one of ITS
  // renders. Stabilised here (by value for the objects, through a ref for the callbacks) so a parent
  // re-render that changed nothing about the deck re-renders no page.
  const rib: Ribbon | null = useMemo(
    () => (ribbon ? { letter: ribbon.letter, short: ribbon.short, colors: ribbon.colors } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ribbon?.letter, ribbon?.short, ribbon?.colors?.[0], ribbon?.colors?.[1]],
  );
  const bld: PaperBuilding | null = useMemo(
    () => (building ? { kind: building.kind, rk: building.rk, company: building.company } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [building?.kind, building?.rk, building?.company],
  );
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const openBuildingRef = useRef(onOpenBuilding);
  openBuildingRef.current = onOpenBuilding;
  const openStable = useCallback<OpenFn>((i, rect) => { openRef.current?.(i, rect); }, []);
  const openBuildingStable = useCallback(() => { openBuildingRef.current?.(); }, []);
  const hasOpen = !!onOpen;

  // Drive the pager from outside (an employer chip tap re-centres it).
  useEffect(() => {
    if (index === settled.current) return;
    settled.current = index;
    if (m.step) ref.current?.scrollTo({ x: index * m.step, animated: true });
  }, [index, m.step]);

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Animated.ScrollView
        ref={ref}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={m.step}
        decelerationRate="fast"
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        contentContainerStyle={{ paddingHorizontal: side, paddingTop: 10 }}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: true })}
        onMomentumScrollEnd={(e) => {
          const i = Math.max(0, Math.min(cards.length - 1, Math.round(e.nativeEvent.contentOffset.x / m.step)));
          if (i !== settled.current) { settled.current = i; onIndex(i); }
        }}
      >
        {cards.map((c, i) => {
          const dist = Math.abs(i - index);
          return (
            <Card
              key={c.id} card={c} i={i} near={dist <= 2} detail={dist <= DETAIL_WINDOW}
              // A building deck overrides the hydration word on every card: none of these pages is
              // "loading" any more, the document they would show is being rewritten.
              state={bld ? 'writing' : (states[c.id] || 'idle')}
              scrollX={scrollX} ribbon={rib} m={m} onOpen={hasOpen ? openStable : undefined}
              building={bld} onOpenBuilding={openBuildingStable} showFit={!!showFit}
            />
          );
        })}
      </Animated.ScrollView>
      <Dots n={cards.length} index={index} />
    </View>
  );
}

const s = StyleSheet.create({
  // ⚠️ The shadow CANNOT live on the same view as `overflow: 'hidden'` — iOS clips the shadow to
  // the view's bounds, so the paper loses all its lift and sits flat on the hero. (Android draws
  // elevation from the outline and survives, which is exactly how this hides in a web/Android
  // check.) Shadow on the wrapper, clipping on the inner view.
  paperShadow: {
    borderRadius: 14, backgroundColor: '#fff',
    shadowColor: '#000', shadowOffset: { width: 0, height: 24 }, shadowOpacity: 0.5, shadowRadius: 40, elevation: 14,
  },
  paper: { borderRadius: 14, overflow: 'hidden', backgroundColor: '#fff' },
  // ⚠️ NO `imgEmpty` ANY MORE. A slot with no pixels used to be a flat #EEF2F8 rectangle, which
  // users read as "blank resume" — PaperSkeleton draws the design instead.
  img: { width: '100%', height: '100%' },
  glare: { position: 'absolute', top: -30, bottom: -30, width: 60 },
  // ⚠️ GEOMETRY COMES FROM PaperSkeleton's AFFORDANCE, because the skeleton has to reserve exactly
  // this footprint for it — the name chip used to run underneath, and since this button renders
  // AFTER the skeleton it drew on top of the name. Change the size or inset here and the chip's
  // clearance moves with it; hard-code a number and they drift apart again.
  expand: {
    position: 'absolute', right: AFFORDANCE.inset, bottom: AFFORDANCE.inset,
    width: AFFORDANCE.size, height: AFFORDANCE.size, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(11,15,34,0.55)',
  },
  ribbon: {
    position: 'absolute', left: 8, top: 8, flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: 4, paddingLeft: 5, paddingRight: 8, borderRadius: 100,
    backgroundColor: 'rgba(11,15,34,0.86)',
  },
  ribbonTile: { width: 14, height: 14, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  ribbonTileTx: { fontSize: 8, fontWeight: '800', color: '#fff' },
  // flexShrink so a long employer name truncates inside the ribbon's maxWidth (set when the fit
  // column is showing) instead of pushing the pill out under it.
  ribbonTx: { fontSize: 8.5, fontWeight: '800', color: '#fff', letterSpacing: 0.5, textTransform: 'uppercase', flexShrink: 1 },
  // Top-RIGHT, opposite the ribbon, and clear of the zoom affordance at the bottom-right. Same dark
  // glass as the ribbon so the two read as one family on a white page and on a skeleton alike.
  fitCol: { position: 'absolute', right: 8, top: 8, alignItems: 'flex-end', gap: 4 },
  fitPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 4, paddingHorizontal: 7, borderRadius: 100,
    backgroundColor: 'rgba(11,15,34,0.86)',
  },
  fitDot: { width: 5, height: 5, borderRadius: 3 },
  fitTx: { fontSize: 8.5, fontWeight: '800', letterSpacing: 0.2, fontVariant: ['tabular-nums'] },
  bestPill: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingVertical: 3, paddingHorizontal: 6, borderRadius: 100,
    backgroundColor: E.mint,
  },
  bestTx: { fontSize: 8, fontWeight: '800', color: E.ink, letterSpacing: 0.3, textTransform: 'uppercase' },
  // The building read-out: a centred dark glass panel over the page being written. The pen keeps
  // moving around it, which is what makes the number read as live rather than as a stuck label.
  bWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  bPanel: {
    alignItems: 'center', paddingTop: 10, paddingBottom: 9, paddingHorizontal: 12, borderRadius: 16,
    backgroundColor: 'rgba(11,15,34,0.86)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
    shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 18,
  },
  bPct: { fontWeight: '800', color: '#fff', letterSpacing: -1, fontVariant: ['tabular-nums'] },
  bPctSign: { fontWeight: '700', color: 'rgba(255,255,255,0.62)', letterSpacing: 0 },
  bQueued: { fontWeight: '800', color: '#fff', letterSpacing: -0.3, marginVertical: 4 },
  bTrack: { height: 3, borderRadius: 2, marginTop: 6, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.14)' },
  bFill: { height: 3, borderRadius: 2, backgroundColor: E.mint },
  bLabel: { marginTop: 7, fontSize: 9.5, fontWeight: '700', color: 'rgba(255,255,255,0.78)', maxWidth: '100%' },
  bWatch: {
    flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 7,
    paddingVertical: 3, paddingHorizontal: 8, borderRadius: 100, backgroundColor: 'rgba(94,234,212,0.12)',
  },
  bWatchTx: { fontSize: 8.5, fontWeight: '800', color: E.mint, letterSpacing: 0.4, textTransform: 'uppercase' },
  // ⚠️ NOT a blur — React Native has none. A thin tinted sliver directly under the page, which
  // reads as the light it sits in. A taller/darker block read as a grey bar (b202 preview).
  // No fill and no shadow: both gave it hard ends. It is a gradient that starts and finishes at
  // zero alpha, inset well inside the card so it cannot line up with the paper's edge.
  reflect: { height: 4, marginTop: 9, marginHorizontal: 76, borderRadius: 2, overflow: 'hidden' },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5, marginTop: 10 },
  dot: { width: 6, height: 6, borderRadius: 100, backgroundColor: 'rgba(255,255,255,0.28)' },
  dotOn: { width: 20, backgroundColor: '#fff' },
  dotCount: { marginLeft: 8, fontSize: 10.5, fontWeight: '700', color: 'rgba(255,255,255,0.55)' },
});
