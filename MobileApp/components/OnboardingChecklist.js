// AI Hub — new feature. Safe to delete without affecting existing app.
// First-run "Finish setting up" card on Home. Matches HomeScreen's card language exactly
// (white, marginHorizontal 16, borderRadius 24, soft shadow). Each row deep-links into Account
// Settings via the parent's setScreen. Purely additive — App.js untouched.
import React, { useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

// HomeScreen design tokens (kept in sync so the card feels native to the screen).
const T = {
  ink: '#0B0F22', muted: '#5B6B8A', faint: '#8896B0',
  surface: '#FFFFFF', border: 'rgba(11,15,34,0.06)', track: '#EEF2F9',
  blue: '#4F8DFF', purple: '#7C6BFF', emerald: '#10B981', emeraldLite: '#34D399',
};
const GRAD_ACCENT = [T.blue, T.purple];
const GRAD_DONE = [T.emeraldLite, T.emerald];

// Ordered steps. `key` matches the backend `setup` booleans; `target` is passed to onStep().
const STEPS = [
  { key: 'profile',   target: 'profile',   icon: 'person-outline',        label: 'Complete your profile', hint: 'Name, phone & date of birth' },
  { key: 'resume',    target: 'resume',    icon: 'document-text-outline', label: 'Upload your resume',    hint: 'We tailor every application to it' },
  { key: 'photo',     target: 'photo',     icon: 'image-outline',         label: 'Add a profile photo',   hint: 'Shown on your applications' },
  { key: 'signature', target: 'signature', icon: 'create-outline',        label: 'Add your signature',    hint: 'Signs your cover letters' },
];

export default function OnboardingChecklist({ setup, firstName, onStep, onDismiss }) {
  const done = setup || {};
  const completed = STEPS.filter((s) => done[s.key]).length;
  const total = STEPS.length;
  const pct = Math.round((completed / total) * 100);

  // Animate progress + a gentle entrance.
  const progress = useRef(new Animated.Value(0)).current;
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(progress, { toValue: completed / total, duration: 650, useNativeDriver: false }).start();
  }, [completed, total, progress]);
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 380, useNativeDriver: true }).start();
  }, [enter]);

  if (completed >= total) return null; // nothing left → hide entirely

  return (
    <Animated.View style={[styles.card, { opacity: enter, transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }]}>
      {/* Header */}
      <View style={styles.header}>
        <LinearGradient colors={GRAD_ACCENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.badge}>
          <Ionicons name="rocket-outline" size={19} color="#fff" />
        </LinearGradient>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Finish setting up{firstName ? `, ${firstName}` : ''}</Text>
          <Text style={styles.subtitle}>{completed} of {total} done · a minute to go</Text>
        </View>
        <TouchableOpacity onPress={onDismiss} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={styles.close}>
          <Ionicons name="close" size={17} color={T.faint} />
        </TouchableOpacity>
      </View>

      {/* Progress */}
      <View style={styles.progressRow}>
        <View style={styles.track}>
          <Animated.View style={[styles.fill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]}>
            <LinearGradient colors={GRAD_ACCENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFillObject} />
          </Animated.View>
        </View>
        <Text style={styles.pct}>{pct}%</Text>
      </View>

      {/* Steps — vertical stepper */}
      <View style={styles.steps}>
        {STEPS.map((s, i) => {
          const isDone = !!done[s.key];
          const last = i === STEPS.length - 1;
          return (
            <TouchableOpacity
              key={s.key}
              activeOpacity={isDone ? 1 : 0.75}
              disabled={isDone}
              onPress={() => onStep && onStep(s.target)}
              style={styles.step}
            >
              {/* Indicator + connector */}
              <View style={styles.indicatorCol}>
                {isDone ? (
                  <LinearGradient colors={GRAD_DONE} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.circle}>
                    <Ionicons name="checkmark" size={17} color="#fff" />
                  </LinearGradient>
                ) : (
                  <View style={styles.circlePending}>
                    <Ionicons name={s.icon} size={16} color={T.blue} />
                  </View>
                )}
                {!last && <View style={[styles.connector, isDone && styles.connectorDone]} />}
              </View>

              {/* Text */}
              <View style={styles.stepText}>
                <Text style={[styles.stepLabel, isDone && styles.stepLabelDone]}>{s.label}</Text>
                {!isDone && <Text style={styles.stepHint}>{s.hint}</Text>}
              </View>

              {/* Right affordance */}
              {isDone ? (
                <Text style={styles.doneTag}>Done</Text>
              ) : (
                <LinearGradient colors={GRAD_ACCENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.goBtn}>
                  <Ionicons name="arrow-forward" size={15} color="#fff" />
                </LinearGradient>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Footer link */}
      <TouchableOpacity style={styles.footer} activeOpacity={0.7} onPress={() => onStep && onStep('account')}>
        <Ionicons name="settings-outline" size={13} color={T.muted} />
        <Text style={styles.footerText}>Manage in Account Settings</Text>
        <Ionicons name="chevron-forward" size={13} color={T.faint} />
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: T.surface,
    marginHorizontal: 16, marginBottom: 14,
    borderRadius: 24, padding: 18,
    borderWidth: 1, borderColor: T.border,
    shadowColor: '#0B1220', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.08, shadowRadius: 24, elevation: 4,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  badge: {
    width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    shadowColor: T.blue, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.28, shadowRadius: 8, elevation: 3,
  },
  title: { fontSize: 16.5, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  subtitle: { fontSize: 12.5, color: T.muted, marginTop: 2, fontWeight: '500' },
  close: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F2F5FA' },

  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16, marginBottom: 4 },
  track: { flex: 1, height: 7, borderRadius: 4, backgroundColor: T.track, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4, overflow: 'hidden' },
  pct: { fontSize: 12.5, fontWeight: '800', color: T.blue, minWidth: 34, textAlign: 'right' },

  steps: { marginTop: 12 },
  step: { flexDirection: 'row', alignItems: 'flex-start' },
  indicatorCol: { alignItems: 'center', width: 36 },
  circle: {
    width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
    shadowColor: T.emerald, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6, elevation: 2,
  },
  circlePending: {
    width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(79,141,255,0.10)', borderWidth: 1.5, borderColor: 'rgba(79,141,255,0.22)',
  },
  connector: { width: 2, flex: 1, minHeight: 18, backgroundColor: T.track, marginVertical: 2, borderRadius: 1 },
  connectorDone: { backgroundColor: 'rgba(16,185,129,0.35)' },
  stepText: { flex: 1, paddingLeft: 12, paddingTop: 7, paddingBottom: 14 },
  stepLabel: { fontSize: 14.5, fontWeight: '700', color: T.ink },
  stepLabelDone: { color: T.faint, textDecorationLine: 'line-through' },
  stepHint: { fontSize: 12.5, color: T.faint, marginTop: 2 },
  doneTag: { fontSize: 12.5, fontWeight: '800', color: T.emerald, marginTop: 9 },
  goBtn: {
    width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginTop: 3,
    shadowColor: T.blue, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.28, shadowRadius: 6, elevation: 2,
  },

  footer: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: 4, paddingTop: 14, borderTopWidth: 1, borderTopColor: T.border,
  },
  footerText: { fontSize: 13, fontWeight: '700', color: T.muted },
});
