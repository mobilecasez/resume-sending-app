// Activation journey coach — new feature. Safe to delete without affecting existing app.
//
// A floating nudge that will not let a half-set-up account sit there quietly. On production today
// 317 of 362 users have not finished step one, and only 2 of 362 have done all five — people are
// not failing to activate because the features are hidden, they are failing because nothing ever
// tells them what to do next.
//
// So: a pill that says how far along they are, and — when tapped — a sheet listing all five steps
// with a hand pointing at THE one to do now, a 30-second film for it, and a button that goes there.
//
// ⚠️ ANIMATION RULE (build 126-128 shipped a fatal crash from this): every Animated.Value in this
// file uses useNativeDriver: false. One driver, everywhere, no exceptions.
//
// ⚠️ Positioned bottom-LEFT on purpose. HelpAssistant's draggable FAB lives at right:16 and can be
// moved anywhere; anchoring this one opposite keeps two floating controls from stacking on open.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, Animated, Platform, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import type { Journey, JourneyStep } from '../services/journeyService';

const T = {
  card: '#FFFFFF', ink: '#0B0F22', muted: '#5B6B8A', faint: '#8896B0',
  line: 'rgba(11,15,34,0.07)', track: '#E7ECF4',
  blue: '#4F8DFF', purple: '#7C6BFF', emerald: '#10B981', amber: '#F59E0B',
};

// One line per step, written as what they DON'T have yet. "Complete your profile" is a chore;
// "Auto Fill can't fill forms until your details are saved" is a reason.
const WHY: Record<string, string> = {
  profile: 'Auto Fill can’t complete forms until your details are saved',
  resume: 'A proper résumé in your country’s format, written for you',
  save_job: 'Keep the jobs worth applying to in one place',
  cover_letter: 'A letter written for that exact job, not a template',
  apply: 'The part that saves you the most time — forms fill themselves',
};

const ICON: Record<string, any> = {
  profile: 'person-outline',
  resume: 'document-text-outline',
  save_job: 'bookmark-outline',
  cover_letter: 'mail-outline',
  apply: 'flash-outline',
};

type Props = {
  journey: Journey | null;
  onWatch: (stepKey: string) => void;
  onGo: (stepKey: string) => void;
  onDismiss?: () => void;
};

export default function JourneyCoach({ journey, onWatch, onGo, onDismiss }: Props) {
  const [open, setOpen] = useState(false);
  const bob = useRef(new Animated.Value(0)).current;      // the pill breathing
  const point = useRef(new Animated.Value(0)).current;    // the hand nudging right
  const enter = useRef(new Animated.Value(0)).current;    // sheet entrance

  const next = journey?.steps.find((s) => s.key === journey?.nextKey) || null;

  // The pill breathes until it is tapped. It stops while the sheet is open so the two are not
  // competing for attention, and it never starts at all once every step is done.
  useEffect(() => {
    if (!journey || journey.complete || open) { bob.stopAnimation(); bob.setValue(0); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(bob, { toValue: 1, duration: 1100, useNativeDriver: false }),
      Animated.timing(bob, { toValue: 0, duration: 1100, useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [journey?.complete, journey?.nextKey, open, bob]);

  // The pointing hand. Small travel, slow — a big sweep reads as a broken layout, not a pointer.
  useEffect(() => {
    if (!open) { point.stopAnimation(); point.setValue(0); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(point, { toValue: 1, duration: 620, useNativeDriver: false }),
      Animated.timing(point, { toValue: 0, duration: 620, useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [open, point]);

  useEffect(() => {
    Animated.timing(enter, { toValue: open ? 1 : 0, duration: open ? 240 : 140, useNativeDriver: false }).start();
  }, [open, enter]);

  const openSheet = useCallback(() => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch {}
    setOpen(true);
  }, []);

  if (!journey || journey.complete || !next) return null;

  const pct = journey.pct;

  return (
    <>
      {/* ── the floater ─────────────────────────────────────────────────────── */}
      <Animated.View
        style={[
          styles.pillWrap,
          {
            transform: [{ translateY: bob.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }) }],
            opacity: open ? 0 : 1,
          },
        ]}
        pointerEvents={open ? 'none' : 'auto'}
      >
        <TouchableOpacity activeOpacity={0.9} onPress={openSheet} accessibilityLabel="Finish setting up">
          <LinearGradient
            colors={[T.blue, T.purple]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={styles.pill}
          >
            <Animated.View
              style={[
                styles.pillDot,
                { opacity: bob.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }) },
              ]}
            />
            <View style={{ flex: 1 }}>
              <Text style={styles.pillTitle} numberOfLines={1}>
                {journey.completed === 0 ? 'Let’s get you set up' : `${journey.completed} of ${journey.total} done`}
              </Text>
              <Text style={styles.pillSub} numberOfLines={1}>Tap me — {next.title.toLowerCase()}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#fff" />
          </LinearGradient>
        </TouchableOpacity>
      </Animated.View>

      {/* ── the sheet ───────────────────────────────────────────────────────── */}
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)} statusBarTranslucent>
        <View style={styles.overlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setOpen(false)} />
          <View style={styles.sheet}>
            <View style={styles.grip} />

            <View style={styles.head}>
              <View style={{ flex: 1 }}>
                <Text style={styles.headTitle}>You’re {pct}% set up</Text>
                <Text style={styles.headSub}>
                  {journey.completed} of {journey.total} steps done — here’s the next one.
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => { setOpen(false); onDismiss?.(); }}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Ionicons name="close" size={22} color={T.faint} />
              </TouchableOpacity>
            </View>

            <View style={styles.bar}>
              <View style={[styles.barFill, { width: `${Math.max(4, pct)}%` }]} />
            </View>

            <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={false}>
              {journey.steps.map((s: JourneyStep) => {
                const isNext = s.key === journey.nextKey;
                return (
                  <View key={s.key} style={[styles.row, isNext && styles.rowNext]}>
                    {/* the pointing hand, on the step to do now */}
                    {isNext ? (
                      <Animated.View
                        style={{ transform: [{ translateX: point.interpolate({ inputRange: [0, 1], outputRange: [-3, 4] }) }] }}
                      >
                        <Ionicons name="hand-right" size={20} color={T.amber} />
                      </Animated.View>
                    ) : (
                      <View style={{ width: 20 }} />
                    )}

                    <View style={[styles.badge, s.done && styles.badgeDone, isNext && styles.badgeNext]}>
                      {s.done
                        ? <Ionicons name="checkmark" size={15} color="#fff" />
                        : <Ionicons name={ICON[s.key] || 'ellipse-outline'} size={15} color={isNext ? '#fff' : T.faint} />}
                    </View>

                    <View style={{ flex: 1 }}>
                      <Text style={[styles.rowTitle, s.done && styles.rowTitleDone]} numberOfLines={1}>
                        {String(s.n).padStart(2, '0')} · {s.title}
                      </Text>
                      {!s.done && <Text style={styles.rowWhy} numberOfLines={2}>{WHY[s.key] || s.blurb}</Text>}
                    </View>

                    <TouchableOpacity
                      onPress={() => { setOpen(false); onWatch(s.key); }}
                      style={styles.watch}
                      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                      accessibilityLabel={`Watch the ${s.title} video`}
                    >
                      <Ionicons name="play-circle" size={22} color={isNext ? T.blue : T.faint} />
                    </TouchableOpacity>
                  </View>
                );
              })}
            </ScrollView>

            <View style={styles.footer}>
              <TouchableOpacity activeOpacity={0.9} onPress={() => { setOpen(false); onGo(next.key); }} style={styles.ctaWrap}>
                <LinearGradient colors={[T.blue, T.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.cta}>
                  <Ionicons name="arrow-forward-circle" size={19} color="#fff" />
                  <Text style={styles.ctaText}>{next.title}</Text>
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { setOpen(false); onWatch(next.key); }} style={styles.secondary}>
                <Ionicons name="play-circle-outline" size={17} color={T.muted} />
                <Text style={styles.secondaryText}>Watch how first</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  // bottom-LEFT: HelpAssistant's FAB owns right:16
  pillWrap: {
    position: 'absolute', left: 14, right: 84,
    bottom: Platform.OS === 'ios' ? 122 : 102,
    zIndex: 998,
  },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 11, paddingHorizontal: 14, borderRadius: 999,
    ...Platform.select({
      ios: { shadowColor: '#2563EB', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.34, shadowRadius: 16 },
      android: { elevation: 8 },
    }),
  },
  pillDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#fff' },
  pillTitle: { color: '#fff', fontSize: 13.5, fontWeight: '800', letterSpacing: -0.2 },
  pillSub: { color: 'rgba(255,255,255,0.9)', fontSize: 11.5, fontWeight: '600', marginTop: 1 },

  overlay: { flex: 1, backgroundColor: 'rgba(6,10,25,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: T.card, borderTopLeftRadius: 26, borderTopRightRadius: 26,
    paddingHorizontal: 18, paddingTop: 10, paddingBottom: Platform.OS === 'ios' ? 30 : 18,
  },
  grip: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: T.track, marginBottom: 12 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  headTitle: { fontSize: 19.5, fontWeight: '800', color: T.ink, letterSpacing: -0.4 },
  headSub: { fontSize: 13, color: T.muted, marginTop: 3, lineHeight: 18 },

  bar: { height: 6, borderRadius: 3, backgroundColor: T.track, marginTop: 14, marginBottom: 6, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3, backgroundColor: T.emerald },

  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderRadius: 14, paddingHorizontal: 6 },
  rowNext: { backgroundColor: 'rgba(79,141,255,0.07)' },
  badge: {
    width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: T.track,
  },
  badgeDone: { backgroundColor: T.emerald },
  badgeNext: { backgroundColor: T.blue },
  rowTitle: { fontSize: 14.5, fontWeight: '700', color: T.ink, letterSpacing: -0.2 },
  rowTitleDone: { color: T.faint, textDecorationLine: 'line-through' },
  rowWhy: { fontSize: 12.3, color: T.muted, lineHeight: 17, marginTop: 2 },
  watch: { padding: 2 },

  footer: { marginTop: 12, borderTopWidth: 1, borderTopColor: T.line, paddingTop: 12 },
  ctaWrap: { borderRadius: 16, overflow: 'hidden' },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 15 },
  ctaText: { color: '#fff', fontSize: 15.5, fontWeight: '800', letterSpacing: -0.2 },
  secondary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingTop: 12, paddingBottom: 2 },
  secondaryText: { fontSize: 13.5, fontWeight: '600', color: T.muted },
});
