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
import { View, Text, StyleSheet, Animated, Platform, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { E } from './theme';

const GAP = 18;
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

function Card({ card, i, scrollX, ribbon, m, onOpen }: {
  card: PaperCard; i: number; scrollX: Animated.Value; m: Metrics;
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
          {card.image ? (
            <Image source={{ uri: card.image }} style={s.img} contentFit="cover" transition={220} />
          ) : (
            <View style={[s.img, s.imgEmpty]} />
          )}
          <Glare w={m.w} />
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
      {/* the glow the card sits on */}
      <Animated.View style={[s.reflect, { opacity: clamp([0.3, 1, 0.3]) }]} />
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
          <Card key={c.id} card={c} i={i} scrollX={scrollX} ribbon={ribbon} m={m} onOpen={onOpen} />
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
  img: { width: '100%', height: '100%' },
  imgEmpty: { backgroundColor: '#EEF2F8' },
  glare: { position: 'absolute', top: -30, bottom: -30, width: 60 },
  expand: {
    position: 'absolute', right: 8, bottom: 8, width: 24, height: 24, borderRadius: 8,
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
  reflect: {
    height: 6, marginTop: 7, marginHorizontal: 30, borderRadius: 3,
    backgroundColor: 'rgba(79,141,255,0.22)',
    ...Platform.select({ ios: { shadowColor: E.blue, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.5, shadowRadius: 10 }, default: {} }),
  },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5, marginTop: 10 },
  dot: { width: 6, height: 6, borderRadius: 100, backgroundColor: 'rgba(255,255,255,0.28)' },
  dotOn: { width: 20, backgroundColor: '#fff' },
  dotCount: { marginLeft: 8, fontSize: 10.5, fontWeight: '700', color: 'rgba(255,255,255,0.55)' },
});
