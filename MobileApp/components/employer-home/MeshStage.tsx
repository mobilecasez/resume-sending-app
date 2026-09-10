// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE BACKDROP FOR A WHOLE PAGE — not a hero with a light section under it.
//
// ⚠️ THERE IS NO LIGHT SECTION AND NO MELT ANY MORE, AND THAT IS THE POINT. The previous version
// faded to `E.bg` partway down so the download library could sit on grey. However carefully that
// fade was tuned it was still a place where one surface stopped and another started, and it read as
// a line across the screen. One gradient over the entire scrollable page has no such place. What
// used to be the melt is now a LIFT: the same near-black navy at the top, opening a little toward
// a lighter blue at the foot, so scrolling feels like moving down one surface rather than crossing
// between two.
//
// ⚠️ EVERY GRADIENT ENDS ON A ZERO-ALPHA VERSION OF ITS OWN COLOUR, NEVER ON `'transparent'`.
// The keyword is transparent BLACK: interpolating to it drags the midpoint toward dark and leaves a
// muddy band, which is what made the old seam visible. It also matters more here than it did there,
// because a wash whose tail is not truly zero would flood the entire page below the hero.
//
// ⚠️ THE FIRST VERSION OF THIS FILE SHIPPED VISIBLE RECTANGLES (b202). It drew "radial blobs" as
// circular Views holding two LinearGradients — but a child gradient does not respect the parent's
// borderRadius without `overflow: hidden`, so every blob painted as a hard-edged SQUARE across the
// hero. Even fixed, a circle filled with a LINEAR gradient still has a hard rim: React Native has
// no radial gradient, and expo-blur cannot be relied on to soften one on Android. So the mesh is
// several full-bleed translucent gradients at different angles, layered over the base colour.
//
// ⚠️ `focus` IS WHERE THE COLOUR LIVES, AS A FRACTION OF THE PAGE, AND IT IS EXPRESSED IN THE
// GRADIENT STOPS — NEVER BY SHORTENING THE AXIS. The page is now two or three times the height of
// the hero, and a wash spread evenly over all of it would leave the top of the screen flat. The
// obvious fix is to end the axis early (`end={{ y: 0.64 * focus }}`), and it is wrong: react-native
// -web turns start/end into a CSS ANGLE and throws the LENGTH away, so the same code paints one
// thing on a phone and a different thing in the preview harness — which is the one tool that exists
// to show what the phone will do. So every axis here runs corner to corner or straight down, where
// a CSS gradient line and a native one are the same line, and `focus` moves the STOPS instead.
//
// ⚠️ THE TOP BAND IS DELIBERATELY KEPT DARK AND FLAT. Home pins its header over this backdrop, and
// a pinned header can only merge invisibly with what is behind it if that region is a STABLE, flat
// colour — otherwise the header reads as a second, mismatched background.
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash): one driver per view tree. Everything here
// animates transform/opacity with useNativeDriver:true and contains no JS-driven Animated.Value.
import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { E } from './theme';

/** The foot of the page: the same navy, opened up. Painted from zero alpha of ITSELF. */
const LIFT = '34,55,110';
const lift = (a: number) => `rgba(${LIFT},${a})`;

// One drifting wash.
// ⚠️ INSET IN POINTS, NOT PER CENT. It used to be -25% on every side so its own rectangle could
// never enter frame; on a page-tall stage that is a 500pt overhang, and every `y` fraction below
// would then mean something different from the page fraction it is named after. 40pt is more than
// the 18pt any of them drifts, and it keeps the axis honest.
function Wash({ colors, locations, start, end, dur, dx, dy, delay = 0 }: {
  colors: [string, string, string]; locations: [number, number, number];
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
  children, style, focus = 1, rows = 40, lift: liftScale = 1,
}: {
  children?: React.ReactNode;
  style?: any;
  /**
   * How far down the stage the colour should resolve, 0-1. Home passes (header + hero) / total, so
   * the first screenful looks exactly as it always did however long the page below it becomes.
   */
  focus?: number;
  /**
   * How many horizontal grid lines to draw, one per 30pt. ⚠️ It is a prop because the grid is a
   * fixed COUNT of absolutely-placed lines: on a page taller than `rows * 30` it simply stops, and
   * the row where it stops is a visible horizontal edge — the exact artefact this file exists to
   * avoid. Callers pass ceil(height / 30).
   */
  rows?: number;
  /**
   * How much of the foot-of-page opening to apply, 0-1. A scrolling page wants the full amount —
   * it is what stops a long list ending in a black hole. A single screen that is mostly a FORM
   * wants very little: the lift lands halfway up a viewport-tall surface and washes out the panel
   * sitting on it.
   */
  lift?: number;
}) {
  const f = Math.max(0.12, Math.min(1, focus));
  const L = Math.max(0, Math.min(1, liftScale));
  return (
    <View style={[s.stage, style]}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {/* THE LIFT — dark navy at the top, a little more open at the foot. This is what replaced
            the melt into grey; it is one colour rising from zero alpha, so it introduces no edge
            and no third hue anywhere along the page. It starts below the colour, so the hero keeps
            the near-black it has always had and the opening happens under the list. */}
        <LinearGradient
          colors={[lift(0), lift(0.28 * L), lift(0.66 * L), lift(0.96 * L)]}
          locations={[0.78 * f, 0.78 * f + (1 - 0.78 * f) * 0.38, 0.78 * f + (1 - 0.78 * f) * 0.74, 1]}
          start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        {/* blue, leaning in from the upper left — held clear of the very top so the pinned header
            has flat dark under it */}
        <Wash colors={['rgba(79,141,255,0.62)', 'rgba(79,141,255,0.15)', 'rgba(79,141,255,0)']}
              locations={[0.10, 0.40 * f, 0.92 * f]}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} dur={9000} dx={16} dy={-12} />
        {/* violet, leaning the other way, arriving late — a BAND, so it cannot flood the page below */}
        <Wash colors={['rgba(124,107,255,0)', 'rgba(124,107,255,0.44)', 'rgba(124,107,255,0)']}
              locations={[0.1 * f, 0.55 * f, 0.98 * f]}
              start={{ x: 1, y: 0 }} end={{ x: 0, y: 1 }} dur={11000} dx={-18} dy={14} delay={400} />
        {/* teal, lower half of the hero, the smallest of the three */}
        <Wash colors={['rgba(20,184,166,0)', 'rgba(20,184,166,0.30)', 'rgba(20,184,166,0)']}
              locations={[0.3 * f, 0.74 * f, 1.0 * f]}
              start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} dur={13000} dx={12} dy={-10} delay={900} />
        {/* a faint grid, held well inside the edges so it never reads as a box */}
        <View style={s.grid} pointerEvents="none">
          {Array.from({ length: Math.max(8, Math.ceil(rows)) }).map((_, i) => <View key={'h' + i} style={[s.gline, { top: i * 30 }]} />)}
          {Array.from({ length: 14 }).map((_, i) => <View key={'v' + i} style={[s.gline, s.gvert, { left: i * 30 }]} />)}
        </View>
        {/* ⚠️ THE TOP IS DELIBERATELY NEAR-BLACK, AND IT CARRIES FURTHER DOWN THAN IT LOOKS.
            Every wash axis now runs the whole page, so each one is at its strongest from the very
            first pixel — the screen went pale blue under the status bar, which is the opposite of
            the dark head this design has always had. This holds the first fifth back to the base
            colour, and the pinned header still gets a flat, stable band to sit on. */}
        <LinearGradient colors={['rgba(7,10,24,0.96)', 'rgba(7,10,24,0.55)', 'rgba(7,10,24,0)']}
                        locations={[0, 0.09 * f, 0.34 * f]}
                        start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
                        style={StyleSheet.absoluteFill} />
      </View>
      {children != null && <View style={{ position: 'relative' }}>{children}</View>}
    </View>
  );
}

const s = StyleSheet.create({
  // No radius and no bottom edge: this is the page, not a panel on it.
  stage: {
    backgroundColor: E.stage,
    overflow: 'hidden',              // ⚠️ load-bearing: without it the washes paint past the bounds
  },
  wash: { position: 'absolute', left: -40, right: -40, top: -40, bottom: -40 },
  grid: { ...StyleSheet.absoluteFillObject, opacity: 0.07 },
  gline: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.5)' },
  gvert: { top: 0, bottom: 0, width: StyleSheet.hairlineWidth, height: undefined, right: undefined },
});
