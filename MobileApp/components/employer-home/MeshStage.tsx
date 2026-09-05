// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The dark hero backdrop: three slowly drifting colour blobs over a faint grid, matching the
// mockup's animated mesh. Pure decoration — it renders its children on top and never blocks a
// touch.
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash): never mix native and JS drivers on ONE
// view tree. Everything here animates transform ONLY and uses useNativeDriver:true throughout,
// on views that contain no JS-driven animation — a self-contained tree, so the rule holds and
// the drift stays smooth while the user scrolls.
import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { E } from './theme';

function Blob({ size, color, style, dur, dx, dy, delay = 0 }: {
  size: number; color: string; style: any; dur: number; dx: number; dy: number; delay?: number;
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
        { position: 'absolute', width: size, height: size, borderRadius: size / 2, opacity: 0.75 },
        style,
        {
          transform: [
            { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) },
            { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, dy] }) },
            { scale: t.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) },
          ],
        },
      ]}
    >
      {/* A radial glow, built from a linear gradient pair — expo-linear-gradient has no radial
          mode, and the blur-and-fade reads the same at this scale. */}
      <LinearGradient
        colors={[color, 'transparent']}
        start={{ x: 0.5, y: 0.5 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={[color, 'transparent']}
        start={{ x: 0.5, y: 0.5 }}
        end={{ x: 0, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

export default function MeshStage({ children, style }: { children: React.ReactNode; style?: any }) {
  return (
    <View style={[s.stage, style]}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Blob size={300} color="rgba(79,141,255,0.75)"  style={{ left: -90, top: -60 }}   dur={9000}  dx={18}  dy={-14} />
        <Blob size={300} color="rgba(124,107,255,0.70)" style={{ right: -110, top: 120 }} dur={11000} dx={-22} dy={16} delay={400} />
        <Blob size={240} color="rgba(20,184,166,0.50)"  style={{ left: 120, bottom: -80 }} dur={13000} dx={14}  dy={-18} delay={900} />
        {/* the faint grid, fading out toward the edges */}
        <View style={s.grid}>
          {Array.from({ length: 26 }).map((_, i) => (
            <View key={'h' + i} style={[s.gline, { top: i * 26 }]} />
          ))}
          {Array.from({ length: 16 }).map((_, i) => (
            <View key={'v' + i} style={[s.gline, s.gvert, { left: i * 26 }]} />
          ))}
        </View>
        {/* vignette so the blobs never touch the rounded edge harshly */}
        <LinearGradient
          colors={['transparent', 'rgba(7,10,24,0.55)']}
          style={StyleSheet.absoluteFill}
          start={{ x: 0.5, y: 0.35 }}
          end={{ x: 0.5, y: 1 }}
        />
      </View>
      <View style={{ position: 'relative' }}>{children}</View>
    </View>
  );
}

const s = StyleSheet.create({
  stage: {
    backgroundColor: E.stage,
    borderBottomLeftRadius: 34,
    borderBottomRightRadius: 34,
    overflow: 'hidden',
    paddingBottom: 22,
    shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 30 }, shadowOpacity: 0.35, shadowRadius: 60, elevation: 16,
  },
  grid: { ...StyleSheet.absoluteFillObject, opacity: 0.10 },
  gline: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.14)' },
  gvert: { top: 0, bottom: 0, width: StyleSheet.hairlineWidth, height: undefined, right: undefined },
});
