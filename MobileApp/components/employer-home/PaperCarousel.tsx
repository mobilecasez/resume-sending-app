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
import React, { useRef, useEffect } from 'react';
import { View, Text, StyleSheet, Animated, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { E } from './theme';
import PaperSkeleton, { AFFORDANCE, PaperState } from './PaperSkeleton';

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

export type PaperCard = { id: string; name: string; accent?: string; image?: string | null };

type Metrics = { w: number; h: number; step: number };

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

function Card({ card, i, dist, state, scrollX, ribbon, m, onOpen }: {
  card: PaperCard; i: number; scrollX: Animated.Value; m: Metrics;
  /** Cards away from the settled one, in whole steps. Gates what is allowed to animate. */
  dist: number;
  /** Whether anything is actually fetching this slot's page — see hydrationStates. */
  state: PaperState;
  ribbon?: { letter: string; short: string; colors: [string, string] } | null;
  onOpen?: (i: number, rect: { x: number; y: number; w: number; h: number }) => void;
}) {
  // The zoom grows out of the exact rectangle the finger is on, so the card measures itself at
  // the moment of the tap rather than the sheet guessing where it was.
  const box = useRef<any>(null);
  const open = () => {
    if (!onOpen) return;
    const fallback = { x: 0, y: 0, w: m.w, h: m.h };
    if (!box.current?.measureInWindow) { onOpen(i, fallback); return; }
    box.current.measureInWindow((x: number, y: number, w: number, h: number) =>
      onOpen(i, w ? { x, y, w, h } : fallback));
  };

  // Distance from centre, in card-steps.
  const d = Animated.divide(Animated.subtract(scrollX, i * m.step), m.step);
  const clamp = (out: [number, number, number]) =>
    d.interpolate({ inputRange: [-1.4, 0, 1.4], outputRange: out, extrapolate: 'clamp' });

  // ⚠️ TWO GATES, AND THEY ARE NOT REDUNDANT. `d` is the same native-driven distance-from-centre
  // that already turns and dims this card, so riding it costs nothing and the sweep dies as the
  // page rotates away — but an opacity of 0 does not stop an Animated.loop, and `d` cannot be read
  // in JS without a per-frame listener, which is exactly the bridge traffic this native-driver tree
  // exists to avoid. So the loops are MOUNTED off the settled index instead. 73 slots each running
  // a shimmer is a battery fire; this runs at most five and shows at most one. The sweep is also
  // gated on `state === 'loading'` now, for the same reason the label is: a slot that nothing is
  // fetching must not animate as though its page were on the way.
  const sweepFade = d.interpolate({ inputRange: [-0.85, 0, 0.85], outputRange: [0, 1, 0], extrapolate: 'clamp' });
  const near = dist <= 2;

  return (
    <Animated.View
      style={{
        width: m.w, marginRight: GAP,
        opacity: clamp([0.35, 1, 0.35]),
        transform: [
          { perspective: 700 },
          { rotateY: d.interpolate({ inputRange: [-1.4, 0, 1.4], outputRange: ['38deg', '0deg', '-38deg'], extrapolate: 'clamp' }) },
          { scale: clamp([0.82, 1, 0.82]) },
          { translateY: clamp([18, 0, 18]) },
        ],
      }}
    >
      <TouchableOpacity ref={box} activeOpacity={0.92} onPress={open} style={s.paperShadow}>
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
            detail={dist <= DETAIL_WINDOW} state={state}
            shimmer={state === 'loading' && near} fade={sweepFade}
          />
          {/* ⚠️ TOP-ANCHORED. `cover` alone centres the page, so anything taller than the card loses
              its head AND its foot — and the head is where the name is. Crop the tail instead. */}
          {!!card.image && (
            <Image source={{ uri: card.image }} style={s.img} contentFit="cover" contentPosition="top" transition={220} />
          )}
          {/* Same reason the sweep is gated: this was 73 concurrent loops on a 73-design deck, all
              but three of them sweeping a card nobody can see. */}
          {near && <Glare w={m.w} />}
          {!!ribbon && (
            <View style={s.ribbon}>
              <View style={[s.ribbonTile, { backgroundColor: ribbon.colors[0] }]}>
                <Text style={s.ribbonTileTx}>{ribbon.letter}</Text>
              </View>
              <Text style={s.ribbonTx} numberOfLines={1}>For {ribbon.short}</Text>
            </View>
          )}
          {/* the affordance for the zoom — without it nothing says the page is tappable */}
          <View style={s.expand}>
            <Ionicons name="scan-outline" size={13} color="#fff" />
          </View>
        </View>
      </TouchableOpacity>
      {/* ⚠️ THIS WAS A SOLID BAR AND IT READ AS A RULE ACROSS THE SCREEN. A 6pt block of flat blue
          spanning the card width, sitting directly above the page counter, is a horizontal LINE —
          which on a screen whose whole point is that it has no seams was the most visible edge left
          on it. A reflection has no ends: this one fades to nothing at both, and it is dimmer and
          narrower than the card so it can never trace its edge. */}
      <Animated.View style={[s.reflect, { opacity: clamp([0.22, 0.75, 0.22]) }]} pointerEvents="none">
        <LinearGradient
          colors={['rgba(79,141,255,0)', 'rgba(140,180,255,0.30)', 'rgba(79,141,255,0)']}
          start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </Animated.View>
  );
}

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

export default function PaperCarousel({ cards, index, onIndex, ribbon, onOpen }: {
  cards: PaperCard[];
  index: number;
  onIndex: (i: number) => void;
  ribbon?: { letter: string; short: string; colors: [string, string] } | null;
  /** Tap a page to open it full-screen; the rect is where it was on screen when tapped. */
  onOpen?: (i: number, rect: { x: number; y: number; w: number; h: number }) => void;
}) {
  const scrollX = useRef(new Animated.Value(0)).current;
  const ref = useRef<any>(null);
  const settled = useRef(index);
  const [width, setWidth] = React.useState(0);

  // One pass over the fetch window per render, not a scan per card.
  const states = React.useMemo(() => hydrationStates(cards, index), [cards, index]);

  const w = cardWidthFor(width);
  const m: Metrics = { w, h: Math.round(w * A4), step: w + GAP };
  const side = width > w ? (width - w) / 2 : 16;

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
        {cards.map((c, i) => (
          <Card
            key={c.id} card={c} i={i} dist={Math.abs(i - index)} state={states[c.id] || 'idle'}
            scrollX={scrollX} ribbon={ribbon} m={m} onOpen={onOpen}
          />
        ))}
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
  ribbonTx: { fontSize: 8.5, fontWeight: '800', color: '#fff', letterSpacing: 0.5, textTransform: 'uppercase' },
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
