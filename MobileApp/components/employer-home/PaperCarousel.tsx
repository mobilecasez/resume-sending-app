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
import { View, Text, StyleSheet, Animated, Dimensions, Platform } from 'react-native';
import { Image } from 'expo-image';
import { E } from './theme';

const WIN = Dimensions.get('window').width;
export const CARD_W = 214;
const GAP = 18;
export const STEP = CARD_W + GAP;
const CARD_H = Math.round(CARD_W * (424 / 300));   // A4 ratio, same as the renderer
const SIDE = (WIN - CARD_W) / 2;

export type PaperCard = { id: string; name: string; accent?: string; image?: string | null };

function Card({ card, i, scrollX, ribbon }: {
  card: PaperCard; i: number; scrollX: Animated.Value;
  ribbon?: { letter: string; short: string; colors: [string, string] } | null;
}) {
  // Distance from centre, in card-steps.
  const d = Animated.divide(Animated.subtract(scrollX, i * STEP), STEP);
  const clamp = (out: [number, number, number]) =>
    d.interpolate({ inputRange: [-1.6, 0, 1.6], outputRange: out, extrapolate: 'clamp' });

  return (
    <Animated.View
      style={{
        width: CARD_W, marginRight: GAP,
        opacity: clamp([0.44, 1, 0.44]),
        transform: [
          { perspective: 900 },
          { rotateY: d.interpolate({ inputRange: [-1.6, 0, 1.6], outputRange: ['26deg', '0deg', '-26deg'], extrapolate: 'clamp' }) },
          { scale: clamp([0.9, 1, 0.9]) },
          { translateY: clamp([14, 0, 14]) },
        ],
      }}
    >
      <View style={s.paper}>
        {card.image ? (
          <Image source={{ uri: card.image }} style={s.img} contentFit="cover" transition={220} />
        ) : (
          <View style={[s.img, s.imgEmpty]} />
        )}
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

export default function PaperCarousel({ cards, index, onIndex, ribbon }: {
  cards: PaperCard[];
  index: number;
  onIndex: (i: number) => void;
  ribbon?: { letter: string; short: string; colors: [string, string] } | null;
}) {
  const scrollX = useRef(new Animated.Value(0)).current;
  const ref = useRef<any>(null);
  const settled = useRef(index);

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
        contentContainerStyle={{ paddingHorizontal: SIDE, paddingTop: 10 }}
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
  ribbon: {
    position: 'absolute', left: 8, top: 8, flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: 4, paddingLeft: 5, paddingRight: 8, borderRadius: 100,
    backgroundColor: 'rgba(11,15,34,0.86)',
  },
  ribbonTile: { width: 14, height: 14, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  ribbonTileTx: { fontSize: 8, fontWeight: '800', color: '#fff' },
  ribbonTx: { fontSize: 8.5, fontWeight: '800', color: '#fff', letterSpacing: 0.5, textTransform: 'uppercase' },
  reflect: {
    height: 22, marginTop: 8, marginHorizontal: 18, borderRadius: 11,
    backgroundColor: 'rgba(79,141,255,0.30)',
    // A soft pool of light under the page. iOS renders the blur; Android approximates with the
    // rounded translucent block, which reads correctly at this size.
    ...Platform.select({ ios: { shadowColor: E.blue, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.7, shadowRadius: 14 }, default: {} }),
  },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5, marginTop: 6 },
  dot: { width: 6, height: 6, borderRadius: 100, backgroundColor: 'rgba(255,255,255,0.28)' },
  dotOn: { width: 20, backgroundColor: '#fff' },
});
