// AI Hub — new feature. Safe to delete without affecting existing app.
// First-run "Finish setting up" card on Home. Matches HomeScreen's card language exactly
// (white, marginHorizontal 16, borderRadius 24, soft shadow). A 4-node segmented progress
// stepper up top fills as steps complete; each row deep-links into Account Settings (edit mode,
// scrolled + focused on the field) via the parent's onStep. Purely additive.
import React, { useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

const T = {
  ink: '#0B0F22', muted: '#5B6B8A', faint: '#8896B0',
  surface: '#FFFFFF', border: 'rgba(11,15,34,0.06)', track: '#E7ECF4',
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

  const enter = useRef(new Animated.Value(0)).current;
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
          <Text style={styles.subtitle}>Just a few quick steps to get going</Text>
        </View>
        <TouchableOpacity onPress={onDismiss} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={styles.close}>
          <Ionicons name="close" size={17} color={T.faint} />
        </TouchableOpacity>
      </View>

      {/* 4-node segmented progress — circles carry each step's symbol and fill as it's done */}
      <View style={styles.dotsRow}>
        {STEPS.map((s, i) => {
          const isDone = !!done[s.key];
          const prevDone = i > 0 && !!done[STEPS[i - 1].key];
          return (
            <React.Fragment key={s.key}>
              {i > 0 && <View style={[styles.connector, prevDone && styles.connectorDone]} />}
              {isDone ? (
                <LinearGradient colors={GRAD_DONE} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.dot}>
                  <Ionicons name="checkmark" size={16} color="#fff" />
                </LinearGradient>
              ) : (
                <View style={styles.dotPending}>
                  <Ionicons name={s.icon} size={15} color={T.blue} />
                </View>
              )}
            </React.Fragment>
          );
        })}
      </View>
      <Text style={styles.dotsCaption}>{completed} of {total} complete · {pct}%</Text>

      {/* Steps — tappable list (deep-links into Account Settings) */}
      <View style={styles.steps}>
        {STEPS.map((s) => {
          const isDone = !!done[s.key];
          return (
            <TouchableOpacity
              key={s.key}
              activeOpacity={isDone ? 1 : 0.75}
              disabled={isDone}
              onPress={() => onStep && onStep(s.target)}
              style={styles.step}
            >
              <View style={[styles.stepIcon, isDone && styles.stepIconDone]}>
                {isDone
                  ? <Ionicons name="checkmark" size={16} color="#fff" />
                  : <Ionicons name={s.icon} size={16} color={T.blue} />}
              </View>
              <View style={styles.stepText}>
                <Text style={[styles.stepLabel, isDone && styles.stepLabelDone]}>{s.label}</Text>
                {!isDone && <Text style={styles.stepHint}>{s.hint}</Text>}
              </View>
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

  dotsRow: { flexDirection: 'row', alignItems: 'center', marginTop: 18, marginBottom: 8, paddingHorizontal: 2 },
  dot: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    shadowColor: T.emerald, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.22, shadowRadius: 5, elevation: 2,
  },
  dotPending: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(79,141,255,0.10)', borderWidth: 1.5, borderColor: 'rgba(79,141,255,0.30)',
  },
  connector: { flex: 1, height: 3, backgroundColor: T.track, marginHorizontal: 5, borderRadius: 2 },
  connectorDone: { backgroundColor: T.blue },
  dotsCaption: { fontSize: 12, fontWeight: '700', color: T.muted, textAlign: 'center', marginBottom: 2 },

  steps: { marginTop: 12 },
  step: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, borderTopWidth: 1, borderTopColor: T.border },
  stepIcon: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(79,141,255,0.10)',
  },
  stepIconDone: { backgroundColor: T.emerald },
  stepText: { flex: 1, paddingLeft: 12 },
  stepLabel: { fontSize: 14.5, fontWeight: '700', color: T.ink },
  stepLabelDone: { color: T.faint, textDecorationLine: 'line-through' },
  stepHint: { fontSize: 12.5, color: T.faint, marginTop: 2 },
  doneTag: { fontSize: 12.5, fontWeight: '800', color: T.emerald },
  goBtn: {
    width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    shadowColor: T.blue, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.28, shadowRadius: 6, elevation: 2,
  },

  footer: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: 6, paddingTop: 14, borderTopWidth: 1, borderTopColor: T.border,
  },
  footerText: { fontSize: 13, fontWeight: '700', color: T.muted },
});
