// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The dark hero backdrop.
//
// ⚠️ THE FIRST VERSION OF THIS FILE SHIPPED VISIBLE RECTANGLES (b202). It drew "radial blobs" as
// circular Views holding two LinearGradients — but a child gradient does not respect the parent's
// borderRadius without `overflow: hidden`, so every blob painted as a hard-edged SQUARE across the
// hero. Even fixed, a circle filled with a LINEAR gradient still has a hard rim: React Native has
// no radial gradient, and expo-blur cannot be relied on to soften one on Android.
//
// So the mesh is built the way it can actually be built here: several FULL-BLEED translucent
// gradients at different angles, layered over the base colour. Every layer covers the entire
// stage, so there is no edge to see anywhere — the colour simply falls off toward transparent.
// Overlapping them reproduces the mockup's soft colour field, identically on both platforms.
//
// ⚠️ THE TOP BAND IS DELIBERATELY KEPT DARK AND FLAT. Home pins its header over this backdrop, and
// a pinned header can only merge invisibly with what is behind it if that region is a STABLE, flat
// colour — otherwise the header reads as a second, mismatched background (which is exactly the
// complaint against the previous build). Every wash therefore starts below `TOP_CLEAR`, so the
// first ~15% of the stage stays E.stage and the header has something constant to sit on.
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash): one driver per view tree. Everything here
// animates transform/opacity with useNativeDriver:true and contains no JS-driven Animated.Value.
import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { E } from './theme';

// The light section's colour, as a fade-up rather than a fade-through. See the melt below.
const BG_RGB = '229,234,243';                    // E.bg — kept as components so alpha can vary
const bg = (a: number) => `rgba(${BG_RGB},${a})`;
const BG0 = bg(0);
/** Where the four intermediate stops sit inside the melt, as a smoothstep rather than evenly. */
const RAMP = [0.2, 0.42, 0.66, 0.86];

// One drifting wash. Deliberately oversized (150% of the stage) and offset, so its own bounds can
// never enter frame however far it drifts.
function Wash({ colors, locations, start, end, dur, dx, dy, delay = 0 }: {
  colors: [string, string]; locations?: [number, number];
  start: { x: number; y: number }; end: { x: number; y: number };
  dur: number; dx: number; dy: number; delay?: number;
}) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(t, { toValue: 1, duration: dur, delay, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(t, { toValue: 0, duration: dur, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [dur, dx, dy, delay, t]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        s.wash,
        {
          transform: [
            { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) },
            { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, dy] }) },
          ],
        },
      ]}
    >
      <LinearGradient colors={colors} locations={locations} start={start} end={end} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

export default function MeshStage({
  children, style, fade = true, fadeFrom = 0.74,
}: {
  children?: React.ReactNode;
  style?: any;
  /** Melt the bottom edge into the light section instead of ending on a hard line. */
  fade?: boolean;
  /**
   * Where the melt STARTS, 0-1 of the stage height. Home passes a value derived from the real
   * viewport so the transition begins just below the fold: the first screenful must be unbroken
   * gradient, and the grey is something you only meet on the way down.
   */
  fadeFrom?: number;
}) {
  return (
    <View style={[s.stage, style]}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {/* blue, upper-left — held clear of the very top so the pinned header has flat dark under it */}
        <Wash colors={['rgba(79,141,255,0.82)', 'transparent']} locations={[0.16, 0.66]}
              start={{ x: 0.05, y: 0.02 }} end={{ x: 0.9, y: 0.62 }} dur={9000} dx={16} dy={-12} />
        {/* violet, right side, arriving late */}
        <Wash colors={['transparent', 'rgba(124,107,255,0.7)']} locations={[0.34, 0.92]}
              start={{ x: 0.05, y: 0.12 }} end={{ x: 1, y: 0.76 }} dur={11000} dx={-18} dy={14} delay={400} />
        {/* teal, lower half, the smallest of the three */}
        <Wash colors={['transparent', 'rgba(20,184,166,0.5)']} locations={[0.44, 0.94]}
              start={{ x: 0.55, y: 0.3 }} end={{ x: 0.3, y: 1 }} dur={13000} dx={12} dy={-10} delay={900} />
        {/* a faint grid, held well inside the edges so it never reads as a box */}
        <View style={s.grid} pointerEvents="none">
          {Array.from({ length: 40 }).map((_, i) => <View key={'h' + i} style={[s.gline, { top: i * 30 }]} />)}
          {Array.from({ length: 14 }).map((_, i) => <View key={'v' + i} style={[s.gline, s.gvert, { left: i * 30 }]} />)}
        </View>
        {/* Keep the very top flat: the washes are already held clear, this settles any bleed. */}
        <LinearGradient colors={['rgba(7,10,24,0.92)', 'transparent']} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 0.13 }}
                        style={StyleSheet.absoluteFill} />
        {/* Melt into the light section rather than ending on an edge.
            ⚠️ EVERY STOP IS THE LIGHT COLOUR AT A DIFFERENT ALPHA, AND THE FIRST ONE IS NOT
            `transparent`. The keyword means transparent BLACK, so a gradient from it to a light
            colour interpolates through dark — which is exactly the muddy grey-blue band that made
            this seam read as a third surface sitting between the hero and the list. Fading one
            colour up from zero alpha introduces no colour of its own, so what you see is the hero
            being covered rather than something being drawn between the two.
            ⚠️ SIX STOPS, EASED, NOT THREE. Three evenly-spaced stops band visibly across 100+pt;
            the curve below is a smoothstep, so the ramp has no edge anywhere along it. */}
        {fade && (
          <LinearGradient
            colors={[BG0, BG0, bg(0.08), bg(0.28), bg(0.58), bg(0.85), E.bg]}
            locations={[0, fadeFrom, ...RAMP.map((r) => fadeFrom + (1 - fadeFrom) * r), 1]}
            start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        )}
      </View>
      {children != null && <View style={{ position: 'relative' }}>{children}</View>}
    </View>
  );
}

const s = StyleSheet.create({
  // No bottom radius any more: this is a full-bleed backdrop that fades into the light section,
  // and a rounded edge would reintroduce exactly the "two surfaces" seam the fade exists to remove.
  stage: {
    backgroundColor: E.stage,
    overflow: 'hidden',              // ⚠️ load-bearing: without it the washes paint past the bounds
  },
  // 150% of the stage, offset by a quarter — its own rectangle is always outside the frame.
  wash: { position: 'absolute', left: '-25%', right: '-25%', top: '-25%', bottom: '-25%' },
  grid: { ...StyleSheet.absoluteFillObject, opacity: 0.07 },
  gline: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.5)' },
  gvert: { top: 0, bottom: 0, width: StyleSheet.hairlineWidth, height: undefined, right: undefined },
});
