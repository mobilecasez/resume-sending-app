// AI Hub — new feature. Safe to delete without affecting existing app.
//
// "SCROLL DOWN TO TAILOR THIS RESUME FOR <COMPANY>" — the pill laid over the page on Home.
//
// A chip with nothing tailored shows the BASE resume, and the one thing that fixes that ("Tailor my resume
// for X") sits under a page that is taller than most of the first screen — below the fold on every phone the
// product owner tried (2026-09-14). People read the base page as the tailored one and never found the
// button. This names the button from where they are already looking, and a tap takes them to it.
//
// ⚠️ IT NEVER STARTS ANYTHING. A tap SCROLLS (Home's onPress) — it does not call the build, does not read the
// gate and cannot spend. The button it points at is still the only door, and that door opens the confirm sheet
// first. A hint that built on tap would be a second, unlabelled Tailor button laid over a picture.
//
// ⚠️ WHEN IT SHOWS IS HOME'S DECISION, NOT THIS FILE'S (a chip with no document, not building, the CTA below
// the fold, not already scrolled to). This only draws it. Home keys it by chip + kind, so picking another chip
// remounts it and the entrance plays again for the new company.
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash): this lives INSIDE Home's Animated.ScrollView, whose
// onScroll drives a native value — and `fade` IS that value, interpolated. So every animation here is
// useNativeDriver:true on transform and opacity ONLY: the entrance (opacity + scale + lift), the soft pulse
// (scale + halo opacity) and the chevron's bounce (translateY). No width, no colour, no JS-driven value, and
// no ticking number.
//
// ⚠️ REDUCE MOTION IS A STATIC PILL, NOT NO PILL. The pointer is the useful part; the motion is only there to
// be noticed. Until the OS answers the question, nothing moves (the safe side of a wrong guess — the same
// rule BuildingOverlay follows), and the pill still appears after the delay.
//
// ⚠️ THE COMPANY IS NEVER THE TRUNCATED PART (review, 2026-09-15). The copy used to be ONE sentence with the
// company at its end under numberOfLines={2}, so a long name ("Rheinmetall Electronics GmbH") was exactly the
// words the ellipsis ate — a pointer that no longer said WHO it was for. Three lines now: the fixed phrase
// (may wrap to two on a 320pt phone, but it is a known length and never clips), the company on its OWN line
// with a middle ellipsis (so a very long name keeps its head and its tail), then the sub-line. The whole
// sentence is still the accessibility label, so a screen reader hears it unbroken.
//
// ⚠️ ITS HEIGHT IS REPORTED, NOT ASSUMED (onHeight). The pill is 70-100pt depending on the phone width and
// the text size, and Home placed it from a 64pt guess — so the real pill hung ~20pt lower than planned and sat
// on the page's zoom button, stealing its taps. Home keeps the measured bottom (plus halo, hitSlop and the
// entrance's lift) above that button.
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Animated, Easing, Pressable, AccessibilityInfo, type StyleProp, type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { E } from './theme';

/**
 * The pill's height at the default text size on a wide phone — ONLY the placement guess until onHeight
 * reports the real one. ⚠️ A GUIDE, NOT A BOX: the phrase wraps to two lines on a narrow phone and every
 * line grows with larger text, so the caller places from the measured height the moment it has it (the pill
 * is invisible for ENTER_DELAY_MS, which is far longer than one layout pass).
 */
export const TAILOR_HINT_H = 72;

/** How long the page is looked at before the hint arrives — long enough that the page reads first. */
const ENTER_DELAY_MS = 1000;
/**
 * How far past its layout box the pill can take a tap or be drawn, for the caller's clearance: hitSlop (6) is
 * the widest of hitSlop / halo (5); the pulse's 3% scale adds ~1.5pt a side on a 100pt pill, and the spring's
 * ~11% overshoot another ~1.5pt. Rounded up, because under-clearing is the bug this exists to prevent.
 */
export const TAILOR_HINT_REACH = 10;

/** How long the OS gets to say whether motion is reduced before the static look is assumed. */
const REDUCE_MOTION_WAIT_MS = 500;

function useReduceMotion(): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (alive) setOn(!!v); })
      .catch(() => { if (alive) setOn((o) => (o === null ? true : o)); });
    const id = setTimeout(() => { if (alive) setOn((o) => (o === null ? true : o)); }, REDUCE_MOTION_WAIT_MS);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => setOn(!!v));
    return () => { alive = false; clearTimeout(id); sub.remove(); };
  }, []);
  return on;
}

function TailorHint({ kind, company, onPress, fade, style, onHeight }: {
  kind: 'resume' | 'cover_letter';
  company: string;
  /** Scroll Home to the Tailor / Write button. ⚠️ A scroll only — see the header. */
  onPress: () => void;
  /** Opacity driven by Home's native scroll value, so the pill gets out of the way as the page moves. */
  fade?: Animated.AnimatedInterpolation<number> | Animated.Value;
  /** Placement (Home sets `top`); the pill centres itself horizontally. */
  style?: StyleProp<ViewStyle>;
  /** The pill's laid-out height (untransformed — onLayout ignores the scale), for Home's placement. */
  onHeight?: (h: number) => void;
}) {
  const reduce = useReduceMotion();
  const enter = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const bounce = useRef(new Animated.Value(0)).current;
  // ⚠️ NOT TAPPABLE UNTIL IT IS ARRIVING. An opacity-0 Pressable still takes touches, so for the whole
  // entrance delay an invisible pill (sitting 12pt LOWER, at its entrance offset) swallowed taps on the page
  // under it. One state flip when the entrance starts — never an animated value, so no JS driver enters.
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (reduce === null) return;   // not known yet: nothing moves, nothing shows
    let loops: Animated.CompositeAnimation[] = [];
    const id = setTimeout(() => {
      setLive(true);
      if (reduce) { enter.setValue(1); return; }
      Animated.spring(enter, { toValue: 1, damping: 14, stiffness: 150, mass: 1, useNativeDriver: true }).start();
      // Soft: a 3% breath over 2.4s, never a flash. It is a pointer, not an alarm.
      const breathe = Animated.loop(Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]));
      // Down fast, back slow, then a rest — the shape of "this way", not a shake.
      const nudge = Animated.loop(Animated.sequence([
        Animated.timing(bounce, { toValue: 1, duration: 360, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(bounce, { toValue: 0, duration: 520, easing: Easing.bounce, useNativeDriver: true }),
        Animated.delay(520),
      ]));
      loops = [breathe, nudge];
      breathe.start();
      nudge.start();
    }, ENTER_DELAY_MS);
    return () => { clearTimeout(id); loops.forEach((l) => l.stop()); };
  }, [reduce, enter, pulse, bounce]);

  // What is drawn is split (see the header); `title` is the one sentence read out.
  const title = kind === 'cover_letter'
    ? `Scroll down to write your cover letter for ${company}`
    : `Scroll down to tailor this resume for ${company}`;
  const lead = kind === 'cover_letter' ? 'Scroll down to write your cover letter' : 'Scroll down to tailor this resume';
  const sub = 'Better chances of getting selected';

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[s.wrap, style, fade ? { opacity: fade } : null]}
    >
      <Animated.View
        pointerEvents={live ? 'box-none' : 'none'}
        style={{
          opacity: enter.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 1] }),
          transform: [
            { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
            { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) },
          ],
        }}
      >
        {/* The halo breathes with the pill; opacity only, so it stays on the native driver. */}
        <Animated.View
          pointerEvents="none"
          style={[s.halo, { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.8] }) }]}
        />
        <Animated.View style={{ transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] }) }] }}>
          <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={`${title}. ${sub}.`}
            accessibilityHint="Scrolls to the button"
            hitSlop={6}
            onLayout={onHeight ? (e) => onHeight(e.nativeEvent.layout.height) : undefined}
            style={({ pressed }) => [s.shadow, pressed && s.pressed]}
          >
            {/* ⚠️ The SAME blue-to-violet as the Tailor button it points at, so the two read as one thing. The
                gradient clips; the shadow lives on the Pressable (iOS drops a shadow on an overflow view). */}
            <LinearGradient colors={[E.blue, E.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.pill}>
              <View style={s.spark}>
                <Ionicons name="sparkles" size={15} color={E.mint} />
              </View>
              <View style={s.texts}>
                {/* A fixed phrase: two lines at most on the narrowest phone, so it never clips. */}
                <Text style={s.title} numberOfLines={2} maxFontSizeMultiplier={1.25}>{lead}</Text>
                <View style={s.forRow}>
                  <Text style={s.forTx} maxFontSizeMultiplier={1.25}>for </Text>
                  {/* ⚠️ Its own line, one line, ellipsis in the MIDDLE — only a very long name loses anything,
                      and it keeps both ends ("Rheinmetall El…nics GmbH"), never the whole company. */}
                  <Text style={s.company} numberOfLines={1} ellipsizeMode="middle" maxFontSizeMultiplier={1.25}>
                    {company}
                  </Text>
                </View>
                <Text style={s.sub} numberOfLines={1} maxFontSizeMultiplier={1.2}>{sub}</Text>
              </View>
              <Animated.View
                style={[s.chev, { transform: [{ translateY: bounce.interpolate({ inputRange: [0, 1], outputRange: [-2, 4] }) }] }]}
              >
                <Ionicons name="chevron-down" size={16} color="#fff" />
              </Animated.View>
            </LinearGradient>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

export default React.memo(TailorHint);

const s = StyleSheet.create({
  // Full width so the pill can centre itself; box-none so the page around it still takes its taps.
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: 22 },
  halo: {
    ...StyleSheet.absoluteFillObject, top: -5, bottom: -5, left: -5, right: -5, borderRadius: 24,
    backgroundColor: 'rgba(124,107,255,0.30)', borderWidth: 1, borderColor: 'rgba(157,190,255,0.45)',
  },
  shadow: {
    borderRadius: 19,
    shadowColor: '#01030A', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.5, shadowRadius: 18, elevation: 10,
  },
  pressed: { opacity: 0.9 },
  pill: {
    maxWidth: 320, minHeight: 54, borderRadius: 19, overflow: 'hidden',
    paddingVertical: 9, paddingLeft: 9, paddingRight: 10,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)',
  },
  spark: {
    width: 32, height: 32, borderRadius: 11, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    backgroundColor: 'rgba(7,10,24,0.32)', borderWidth: 1, borderColor: 'rgba(94,234,212,0.35)',
  },
  texts: { flexShrink: 1, minWidth: 0 },
  title: { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.92)', letterSpacing: -0.2, lineHeight: 17, flexShrink: 1 },
  forRow: { flexDirection: 'row', alignItems: 'baseline', minWidth: 0 },
  forTx: { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.92)', letterSpacing: -0.2, lineHeight: 17, flexShrink: 0 },
  company: { fontSize: 13, fontWeight: '900', color: '#fff', letterSpacing: -0.2, lineHeight: 17, flexShrink: 1 },
  sub: { marginTop: 2, fontSize: 11, fontWeight: '700', color: 'rgba(255,255,255,0.78)', flexShrink: 1 },
  chev: {
    width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.20)',
  },
});
