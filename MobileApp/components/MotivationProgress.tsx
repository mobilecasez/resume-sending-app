// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Shown WHILE an employer is still being searched (processing, no jobs yet). Instead of an empty
// screen or a flat "Finding more positions…" banner, it keeps the user happy and engaged with a
// warm, rotating stream of encouragement — personalized résumé-aware praise (fetched once from the
// backend) mixed with a bundled 500-line tip library. Hidden automatically once jobs appear.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import GENERIC_TIPS from '../assets/motivationTips.json';

const C = {
  surface: '#FFFFFF',
  ink: '#0B0F22',
  inkSoft: '#1A2046',
  muted: '#5B6B8A',
  faint: '#8896B0',
  blue: '#4F8DFF',
  blueDeep: '#2563EB',
  purple: '#7C6BFF',
  track: 'rgba(79,141,255,0.12)',
};

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type Props = { employerName?: string; personalized?: string[] };

const MotivationProgress: React.FC<Props> = ({ employerName, personalized }) => {
  // Build a long, non-repeating deck: front-load + interleave the personalized praise (≈1 per 2
  // generic) so it feels résumé-aware, then flow into the bundled library. Reshuffle each mount.
  const deck = useMemo(() => {
    const generic = shuffle(GENERIC_TIPS as string[]);
    const pers = shuffle((personalized || []).filter((l) => typeof l === 'string' && l.trim()));
    if (!pers.length) return generic;
    const out: string[] = [];
    let gi = 0, pi = 0;
    while (gi < generic.length || pi < pers.length) {
      if (pi < pers.length) out.push(pers[pi++]);
      if (gi < generic.length) out.push(generic[gi++]);
      if (gi < generic.length) out.push(generic[gi++]);
    }
    return out;
  }, [personalized]);

  const [idx, setIdx] = useState(0);
  const op = useRef(new Animated.Value(1)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(0)).current;

  // Rotate the line every ~3.6s with a gentle fade + lift.
  useEffect(() => {
    if (!deck.length) return;
    const id = setInterval(() => {
      Animated.timing(op, { toValue: 0, duration: 260, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(() => {
        setIdx((i) => (i + 1) % deck.length);
        ty.setValue(10);
        Animated.parallel([
          Animated.timing(op, { toValue: 1, duration: 340, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(ty, { toValue: 0, duration: 340, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        ]).start();
      });
    }, 3600);
    return () => clearInterval(id);
  }, [deck]);

  // Pulsing avatar + indeterminate shimmer bar (purely cosmetic "it's working" motion).
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start();
    Animated.loop(
      Animated.timing(slide, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.ease), useNativeDriver: true })
    ).start();
  }, []);

  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });
  const barX = slide.interpolate({ inputRange: [0, 1], outputRange: [-90, 230] });

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Animated.View style={{ transform: [{ scale: pulseScale }] }}>
          <LinearGradient colors={[C.blue, C.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.avatar}>
            <Ionicons name="sparkles" size={18} color="#fff" />
          </LinearGradient>
        </Animated.View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>
            Scanning{employerName ? ` ${employerName}` : ''} for your matches…
          </Text>
          <Text style={styles.sub}>Hang tight — great roles are worth the wait</Text>
        </View>
      </View>

      <Animated.Text style={[styles.line, { opacity: op, transform: [{ translateY: ty }] }]}>
        {deck[idx] || 'Lining up the best roles for you…'}
      </Animated.Text>

      <View style={styles.track}>
        <Animated.View style={[styles.barWrap, { transform: [{ translateX: barX }] }]}>
          <LinearGradient colors={['transparent', C.blue, 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.bar} />
        </Animated.View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: C.surface,
    borderRadius: 22,
    paddingVertical: 22,
    paddingHorizontal: 20,
    marginTop: 4,
    marginBottom: 14,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 28,
    elevation: 6,
    borderWidth: 1,
    borderColor: 'rgba(79,141,255,0.10)',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  avatar: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 14.5, fontWeight: '800', color: C.inkSoft, letterSpacing: -0.2 },
  sub: { fontSize: 12, color: C.faint, marginTop: 2, fontWeight: '600' },
  line: { fontSize: 18, lineHeight: 26, fontWeight: '700', color: C.ink, letterSpacing: -0.3, minHeight: 78 },
  track: { height: 4, borderRadius: 4, backgroundColor: C.track, overflow: 'hidden', marginTop: 6 },
  barWrap: { width: 120, height: 4 },
  bar: { flex: 1, borderRadius: 4 },
});

export default React.memo(MotivationProgress);
