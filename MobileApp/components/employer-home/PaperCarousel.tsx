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
import React, { useRef, useEffect } from 'react';
import { View, Text, StyleSheet, Animated, Platform } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { E } from './theme';

export const CARD_W = 158;
const GAP = 18;
export const STEP = CARD_W + GAP;
const CARD_H = Math.round(CARD_W * (424 / 300));   // A4 ratio, same as the renderer

export type PaperCard = { id: string; name: string; accent?: string; image?: string | null };

function Card({ card, i, scrollX, ribbon }: {
  card: PaperCard; i: number; scrollX: Animated.Value;
  ribbon?: { letter: string; short: string; colors: [string, string] } | null;
}) {
  // Distance from centre, in card-steps.
  const d = Animated.divide(Animated.subtract(scrollX, i * STEP), STEP);
  const clamp = (out: [number, number, number]) =>
    d.interpolate({ inputRange: [-1.4, 0, 1.4], outputRange: out, extrapolate: 'clamp' });

  return (
    <Animated.View
      style={{
        width: CARD_W, marginRight: GAP,
        opacity: clamp([0.35, 1, 0.35]),
        transform: [
          { perspective: 700 },
          { rotateY: d.interpolate({ inputRange: [-1.4, 0, 1.4], outputRange: ['38deg', '0deg', '-38deg'], extrapolate: 'clamp' }) },
          { scale: clamp([0.82, 1, 0.82]) },
          { translateY: clamp([18, 0, 18]) },
        ],
      }}
    >
      <View style={s.paper}>
        {card.image ? (
          <Image source={{ uri: card.image }} style={s.img} contentFit="cover" transition={220} />
        ) : (
          <View style={[s.img, s.imgEmpty]} />
        )}
        <Glare />
        {!!ribbon && (
          <View style={s.ribbon}>
            <View style={[s.ribbonTile, { backgroundColor: ribbon.colors[0] }]}>
              <Text style={s.ribbonTileTx}>{ribbon.letter}</Text>
            </View>
            <Text style={s.ribbonTx} numberOfLines={1}>For {ribbon.short}</Text>
          </View>
        )}
      </View>
      {/* the glow the card sits on */}
      <Animated.View style={[s.reflect, { opacity: clamp([0.3, 1, 0.3]) }]} />
    </Animated.View>
  );
}

// A slow highlight travelling across the page — the mockup's "glare". Transform-only, native
// driver, same as everything else in this tree.
function Glare() {
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
      style={[s.glare, { transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [-90, CARD_W + 90] }) }, { rotate: '12deg' }] }]}
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

export default function PaperCarousel({ cards, index, onIndex, ribbon }: {
  cards: PaperCard[];
  index: number;
  onIndex: (i: number) => void;
  ribbon?: { letter: string; short: string; colors: [string, string] } | null;
}) {
  const scrollX = useRef(new Animated.Value(0)).current;
  const ref = useRef<any>(null);
  const settled = useRef(index);
  const [width, setWidth] = React.useState(0);
  const side = width > CARD_W ? (width - CARD_W) / 2 : 16;

  // Drive the pager from outside (an employer chip tap re-centres it).
  useEffect(() => {
    if (index === settled.current) return;
    settled.current = index;
    ref.current?.scrollTo({ x: index * STEP, animated: true });
  }, [index]);

  return (
    <View>
      <Animated.ScrollView
        ref={ref}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={STEP}
        decelerationRate="fast"
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        contentContainerStyle={{ paddingHorizontal: side, paddingTop: 10 }}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: true })}
        onMomentumScrollEnd={(e) => {
          const i = Math.max(0, Math.min(cards.length - 1, Math.round(e.nativeEvent.contentOffset.x / STEP)));
          if (i !== settled.current) { settled.current = i; onIndex(i); }
        }}
      >
        {cards.map((c, i) => (
          <Card key={c.id} card={c} i={i} scrollX={scrollX} ribbon={ribbon} />
        ))}
      </Animated.ScrollView>

      {/* dots */}
      <View style={s.dots}>
        {cards.map((c, i) => (
          <View key={c.id} style={[s.dot, i === index && s.dotOn]} />
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  paper: {
    width: CARD_W, height: CARD_H, borderRadius: 14, overflow: 'hidden', backgroundColor: '#fff',
    shadowColor: '#000', shadowOffset: { width: 0, height: 24 }, shadowOpacity: 0.5, shadowRadius: 40, elevation: 14,
  },
  img: { width: '100%', height: '100%' },
  imgEmpty: { backgroundColor: '#EEF2F8' },
  glare: { position: 'absolute', top: -30, bottom: -30, width: 60 },
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
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5, marginTop: 6 },
  dot: { width: 6, height: 6, borderRadius: 100, backgroundColor: 'rgba(255,255,255,0.28)' },
  dotOn: { width: 20, backgroundColor: '#fff' },
});
