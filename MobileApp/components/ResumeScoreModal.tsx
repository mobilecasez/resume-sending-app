// Résumé score — new feature. Safe to delete without affecting existing app.
//
// The verdict popup on Home: one number, one reason, three fixes, one way forward.
//
// ⚠️ ANIMATION RULE (build 126-128 cost us a fatal crash): every Animated.Value in this file uses
// useNativeDriver: false. Not because layout is animated — but because mixing drivers across values
// that end up on the same view tree is what crashed the drag handler, and a résumé popup is not
// worth re-litigating that. One driver, everywhere, no exceptions.
//
// ⚠️ NO react-native-svg in this project, so the ring is built from two clipped halves of a
// bordered circle. See ScoreRing for the geometry — it is exact, not approximate.
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, Animated, ScrollView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import type { ResumeScore } from '../services/resumeScoreService';

const T = {
  card: '#FFFFFF', ink: '#0B0F22', muted: '#5B6B8A', faint: '#8896B0',
  line: 'rgba(11,15,34,0.07)', track: 'rgba(11,15,34,0.08)',
};

// The band decides the whole colour story. Deliberately NOT red for a low score: this arrives
// unprompted on someone's home screen, and "your résumé is a failure" is how you lose a user on
// day one. Low scores read as warm amber — a job to do, not a judgement.
function paletteFor(score: number): { grad: [string, string]; ring: string; soft: string } {
  if (score >= 85) return { grad: ['#10B981', '#06B6D4'], ring: '#10B981', soft: 'rgba(16,185,129,0.10)' };
  if (score >= 70) return { grad: ['#14B8A6', '#3B82F6'], ring: '#14B8A6', soft: 'rgba(20,184,166,0.10)' };
  if (score >= 55) return { grad: ['#4F8DFF', '#7C6BFF'], ring: '#4F8DFF', soft: 'rgba(79,141,255,0.10)' };
  return { grad: ['#F59E0B', '#F97316'], ring: '#F59E0B', soft: 'rgba(245,158,11,0.12)' };
}

/**
 * A progress ring with no SVG.
 *
 * A circle whose top+right borders are coloured shows a 180° arc running 315°→135° (clock angles,
 * 0 = twelve o'clock, clockwise). Rotating it +45° puts that arc at 0°→180°.
 *
 *  • RIGHT half is clipped to 0°–180°. Rotating the arc from -135° to +45° sweeps it into view,
 *    so `rotate = deg - 135` draws exactly the first 0–180° of progress.
 *  • LEFT half is clipped to 180°–360°. At `rotate = 45 + q` the arc sits at q°→(180+q)°, and the
 *    clip reveals only the 180°→(180+q)° part — exactly the second half of progress.
 *
 * The clips do the masking, so no angle arithmetic is ever approximate.
 */
function ScoreRing({ size, stroke, deg, color }: { size: number; stroke: number; deg: Animated.Value; color: string }) {
  const half = size / 2;
  const arc = {
    width: size, height: size, borderRadius: half, borderWidth: stroke,
    borderTopColor: color, borderRightColor: color,
    borderBottomColor: 'transparent', borderLeftColor: 'transparent',
  } as const;
  const rightRotate = deg.interpolate({ inputRange: [0, 180, 360], outputRange: ['-135deg', '45deg', '45deg'], extrapolate: 'clamp' });
  const leftRotate = deg.interpolate({ inputRange: [0, 180, 360], outputRange: ['45deg', '45deg', '225deg'], extrapolate: 'clamp' });
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: half, borderWidth: stroke, borderColor: T.track }} />
      <View style={[styles.clip, { width: half, height: size, left: half }]}>
        <Animated.View style={[arc, { marginLeft: -half, transform: [{ rotate: rightRotate }] }]} />
      </View>
      <View style={[styles.clip, { width: half, height: size, left: 0 }]}>
        <Animated.View style={[arc, { transform: [{ rotate: leftRotate }] }]} />
      </View>
    </View>
  );
}

type Props = {
  visible: boolean;
  score: ResumeScore | null;
  onDismiss: () => void;
  onEnhance: () => void;
  busy?: boolean;
};

export default function ResumeScoreModal({ visible, score, onDismiss, onEnhance, busy }: Props) {
  const sweep = useRef(new Animated.Value(0)).current;
  const enter = useRef(new Animated.Value(0)).current;
  // The number counts up with the ring. It is driven by a listener rather than a second animation
  // so the digits can never disagree with the arc.
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!visible || !score) return;
    sweep.setValue(0); enter.setValue(0); setShown(0);
    const id = sweep.addListener(({ value }) => setShown(Math.round((value / 360) * 100)));
    try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    Animated.sequence([
      Animated.timing(enter, { toValue: 1, duration: 260, useNativeDriver: false }),
      Animated.timing(sweep, { toValue: (Math.max(0, Math.min(100, score.score)) / 100) * 360, duration: 1050, useNativeDriver: false }),
    ]).start();
    return () => sweep.removeListener(id);
  }, [visible, score?.id]);

  if (!score) return null;
  const pal = paletteFor(score.score);
  const delta = score.previousScore == null ? null : score.score - score.previousScore;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss} statusBarTranslucent>
      <View style={styles.backdrop}>
        <Animated.View
          style={[
            styles.card,
            { opacity: enter, transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] },
          ]}
        >
          <TouchableOpacity style={styles.close} onPress={onDismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={20} color={T.faint} />
          </TouchableOpacity>

          <ScrollView bounces={false} showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
            <Text style={styles.eyebrow}>YOUR RÉSUMÉ, SCORED</Text>

            <View style={styles.ringWrap}>
              <ScoreRing size={148} stroke={11} deg={sweep} color={pal.ring} />
              <View style={styles.ringCenter} pointerEvents="none">
                <Text style={[styles.scoreNum, { color: pal.ring }]}>{shown}</Text>
                <Text style={styles.scoreOutOf}>out of 100</Text>
              </View>
            </View>

            <View style={styles.bandRow}>
              <View style={[styles.bandPill, { backgroundColor: pal.soft }]}>
                <Text style={[styles.bandText, { color: pal.ring }]}>{score.band}</Text>
              </View>
              {delta != null && delta !== 0 && (
                <View style={[styles.bandPill, { backgroundColor: delta > 0 ? 'rgba(16,185,129,0.10)' : 'rgba(245,158,11,0.12)' }]}>
                  <Ionicons name={delta > 0 ? 'trending-up' : 'trending-down'} size={13} color={delta > 0 ? '#10B981' : '#F59E0B'} />
                  <Text style={[styles.bandText, { color: delta > 0 ? '#10B981' : '#F59E0B' }]}>
                    {delta > 0 ? '+' : ''}{delta} since last time
                  </Text>
                </View>
              )}
            </View>

            <Text style={styles.headline}>{score.headline}</Text>
            {!!score.summary && <Text style={styles.summary}>{score.summary}</Text>}

            <View style={styles.fixes}>
              <Text style={styles.fixesLabel}>WHAT WOULD LIFT IT MOST</Text>
              {score.improvements.map((imp, i) => (
                <View key={i} style={styles.fixRow}>
                  <View style={[styles.fixNum, { backgroundColor: pal.soft }]}>
                    <Text style={[styles.fixNumText, { color: pal.ring }]}>{i + 1}</Text>
                  </View>
                  <View style={styles.fixBody}>
                    <Text style={styles.fixTitle}>{imp.title}</Text>
                    <Text style={styles.fixDetail}>{imp.detail}</Text>
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity activeOpacity={0.9} onPress={onEnhance} disabled={busy} style={styles.ctaWrap}>
              <LinearGradient colors={pal.grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.cta}>
                <Ionicons name={busy ? 'hourglass-outline' : 'sparkles'} size={19} color="#fff" />
                <Text style={styles.ctaText}>{busy ? 'Opening…' : 'Enhance My Résumé — Free'}</Text>
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity onPress={onDismiss} style={styles.later} hitSlop={{ top: 8, bottom: 8 }}>
              <Text style={styles.laterText}>Maybe later</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(6,10,25,0.55)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: {
    width: '100%', maxWidth: 400, maxHeight: '88%', backgroundColor: T.card, borderRadius: 30,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 18 }, shadowOpacity: 0.28, shadowRadius: 34 },
      android: { elevation: 14 },
    }),
  },
  close: { position: 'absolute', top: 14, right: 14, zIndex: 5, width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  scroll: { paddingTop: 26, paddingHorizontal: 22, paddingBottom: 8, alignItems: 'center' },
  eyebrow: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1.3, color: T.faint },

  ringWrap: { width: 148, height: 148, marginTop: 16, alignItems: 'center', justifyContent: 'center' },
  clip: { position: 'absolute', top: 0, overflow: 'hidden' },
  ringCenter: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  scoreNum: { fontSize: 52, fontWeight: '800', letterSpacing: -2, includeFontPadding: false, lineHeight: 58 },
  scoreOutOf: { fontSize: 11, fontWeight: '600', color: T.faint, marginTop: -2 },

  bandRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 16 },
  bandPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  bandText: { fontSize: 12.5, fontWeight: '800', letterSpacing: -0.1 },

  headline: { fontSize: 19, fontWeight: '800', color: T.ink, textAlign: 'center', letterSpacing: -0.45, marginTop: 16, lineHeight: 25 },
  summary: { fontSize: 14, color: T.muted, textAlign: 'center', lineHeight: 20.5, marginTop: 8 },

  fixes: { alignSelf: 'stretch', marginTop: 22, backgroundColor: '#F7F9FD', borderRadius: 20, padding: 16, borderWidth: 1, borderColor: T.line },
  fixesLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 1.1, color: T.faint, marginBottom: 12 },
  fixRow: { flexDirection: 'row', gap: 12, marginBottom: 14 },
  fixNum: { width: 24, height: 24, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  fixNumText: { fontSize: 12.5, fontWeight: '800' },
  fixBody: { flex: 1 },
  fixTitle: { fontSize: 14.5, fontWeight: '700', color: T.ink, letterSpacing: -0.2 },
  fixDetail: { fontSize: 13, color: T.muted, lineHeight: 18.5, marginTop: 2 },

  footer: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 18, borderTopWidth: 1, borderTopColor: T.line, backgroundColor: T.card },
  ctaWrap: { borderRadius: 18, overflow: 'hidden' },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, paddingVertical: 16 },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: -0.3 },
  later: { alignItems: 'center', paddingTop: 13, paddingBottom: 2 },
  laterText: { fontSize: 13.5, fontWeight: '600', color: T.faint },
});
