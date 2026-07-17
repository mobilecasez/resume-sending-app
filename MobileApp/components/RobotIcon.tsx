// AI Hub — new feature. Safe to delete without affecting existing app.
// A friendly little robot face whose eyes BLINK on a loop — the engaging icon for the floating
// "Job tools" dock. Built from plain Views (no SVG / no extra deps), tinted via the `color` prop.
import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet } from 'react-native';

export default function RobotIcon({ size = 26, color = '#fff' }: { size?: number; color?: string }) {
  const blink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let cancelled = false;
    const loop = () => {
      Animated.sequence([
        Animated.delay(1700),
        Animated.timing(blink, { toValue: 0.12, duration: 80, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 80, useNativeDriver: true }),
        Animated.delay(160),
        Animated.timing(blink, { toValue: 0.12, duration: 80, useNativeDriver: true }),   // occasional double-blink
        Animated.timing(blink, { toValue: 1, duration: 80, useNativeDriver: true }),
      ]).start(() => { if (!cancelled) loop(); });
    };
    loop();
    return () => { cancelled = true; };
  }, [blink]);

  const headW = size;
  const headH = size * 0.82;
  const eye = Math.max(3, size * 0.15);
  const ant = size * 0.22;
  return (
    <View style={{ width: size, height: size + ant, alignItems: 'center', justifyContent: 'flex-end' }}>
      {/* antenna */}
      <View style={{ width: 2, height: ant, backgroundColor: color, opacity: 0.9 }} />
      <View style={{ width: eye * 0.9, height: eye * 0.9, borderRadius: eye, backgroundColor: color, marginBottom: -eye * 0.35 }} />
      {/* head */}
      <View style={{ width: headW, height: headH, borderRadius: size * 0.26, borderWidth: 2, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
        <View style={styles.eyesRow}>
          <Animated.View style={{ width: eye, height: eye, borderRadius: eye / 2, backgroundColor: color, marginHorizontal: eye * 0.5, transform: [{ scaleY: blink }] }} />
          <Animated.View style={{ width: eye, height: eye, borderRadius: eye / 2, backgroundColor: color, marginHorizontal: eye * 0.5, transform: [{ scaleY: blink }] }} />
        </View>
        {/* mouth */}
        <View style={{ width: headW * 0.42, height: 2, borderRadius: 2, backgroundColor: color, opacity: 0.85, marginTop: eye * 0.55 }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  eyesRow: { flexDirection: 'row', alignItems: 'center' },
});
