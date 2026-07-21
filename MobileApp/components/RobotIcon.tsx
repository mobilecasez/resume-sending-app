// AI Hub — new feature. Safe to delete without affecting existing app.
// A friendly little robot face whose eyes BLINK on a loop — the icon for the floating "Job tools"
// dock. Built from plain Views (no SVG / no extra deps), tinted via the `color` prop.
//
// Shape follows the reference mascot: a round head, two out-splayed antennae with ring tips, small
// side ears, an oval visor holding two ring eyes, and a curved smile. Everything is proportional to
// `size`, and the strokes are a touch thicker than the old version so it reads well on the dark FAB.
import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet } from 'react-native';

export default function RobotIcon({ size = 26, color = '#fff' }: { size?: number; color?: string }) {
  const blink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let cancelled = false;
    const loop = () => {
      Animated.sequence([
        Animated.delay(1700),
        Animated.timing(blink, { toValue: 0.1, duration: 90, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 90, useNativeDriver: true }),
        Animated.delay(150),
        Animated.timing(blink, { toValue: 0.1, duration: 90, useNativeDriver: true }),   // occasional double-blink
        Animated.timing(blink, { toValue: 1, duration: 90, useNativeDriver: true }),
      ]).start(() => { if (!cancelled) loop(); });
    };
    loop();
    return () => { cancelled = true; };
  }, [blink]);

  const S = size;
  const stroke = Math.max(2.5, S * 0.085);           // main outline — thicker than the old flat 2px
  const thin = Math.max(2, S * 0.065);               // antenna stalks + eye rings
  const headTop = S * 0.34;                            // head is the bottom S×S of the container

  // A ring-tipped antenna that pivots outward from its base on the head.
  const Antenna = ({ side }: { side: 'l' | 'r' }) => (
    <View
      style={{
        position: 'absolute',
        top: 0,
        height: headTop + stroke,
        alignItems: 'center',
        justifyContent: 'flex-start',
        transform: [{ rotate: side === 'l' ? '-20deg' : '20deg' }],
        transformOrigin: 'bottom center',
        ...(side === 'l' ? { left: S * 0.26 } : { right: S * 0.26 }),
      }}
    >
      <View style={{ width: S * 0.16, height: S * 0.16, borderRadius: S * 0.08, borderWidth: thin, borderColor: color }} />
      <View style={{ width: thin, flex: 1, backgroundColor: color, marginTop: -thin * 0.3 }} />
    </View>
  );

  // A little side ear, centred on the head's edge so its outer half pokes out.
  const Ear = ({ side }: { side: 'l' | 'r' }) => (
    <View
      style={{
        position: 'absolute',
        top: headTop + S * 0.34,
        width: S * 0.17,
        height: S * 0.17,
        borderRadius: S * 0.085,
        borderWidth: thin,
        borderColor: color,
        ...(side === 'l' ? { left: -S * 0.02 } : { right: -S * 0.02 }),
      }}
    />
  );

  const eye = S * 0.13;
  return (
    <View style={{ width: S, height: S + headTop, overflow: 'visible' }}>
      {/* antennae + ears sit BEHIND the head so their bases/inner edges tuck under the rim */}
      <Antenna side="l" />
      <Antenna side="r" />
      <Ear side="l" />
      <Ear side="r" />

      {/* head */}
      <View
        style={{
          position: 'absolute', left: 0, bottom: 0, width: S, height: S,
          borderRadius: S / 2, borderWidth: stroke, borderColor: color,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        {/* visor with two blinking ring eyes */}
        <View
          style={{
            width: S * 0.62, height: S * 0.36, borderRadius: S * 0.16,
            borderWidth: stroke, borderColor: color,
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Animated.View style={{ width: eye, height: eye, borderRadius: eye / 2, borderWidth: thin, borderColor: color, marginHorizontal: eye * 0.42, transform: [{ scaleY: blink }] }} />
          <Animated.View style={{ width: eye, height: eye, borderRadius: eye / 2, borderWidth: thin, borderColor: color, marginHorizontal: eye * 0.42, transform: [{ scaleY: blink }] }} />
        </View>
        {/* curved smile — a downward arc made from a box with only its bottom border + big bottom radii */}
        <View style={{ width: S * 0.3, height: S * 0.15, borderBottomWidth: stroke, borderColor: color, borderBottomLeftRadius: S * 0.16, borderBottomRightRadius: S * 0.16, marginTop: S * 0.055 }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({});
