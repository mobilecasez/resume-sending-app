// AI Hub — new feature. Safe to delete without affecting existing app.
// First-run "Finish setting up your account" checklist, shown on the Home screen until the user
// has completed their profile, resume, photo, and signature. Each row deep-links (via the parent's
// setScreen) into Account Settings where the actual action lives. Purely additive — App.js untouched.
import React, { useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

const C = {
  ink: '#0B0F22', muted: '#5B6B8A', faint: '#8896B0', line: 'rgba(11,15,34,0.08)',
  blue: '#4F8DFF', purple: '#7C6BFF', emerald: '#10B981', track: '#EAEFF7',
};

// Ordered steps. `key` matches the backend `setup` booleans; `target` is passed to onStep().
const STEPS = [
  { key: 'profile',   target: 'profile',   icon: 'person-outline',        label: 'Complete your profile', hint: 'Name, phone, address & date of birth' },
  { key: 'resume',    target: 'resume',    icon: 'document-text-outline', label: 'Upload your resume',    hint: 'We tailor every application to it' },
  { key: 'photo',     target: 'photo',     icon: 'image-outline',         label: 'Add a profile photo',   hint: 'Used on your applications' },
  { key: 'signature', target: 'signature', icon: 'create-outline',        label: 'Add your signature',    hint: 'Signs your cover letters' },
];

export default function OnboardingChecklist({ setup, firstName, onStep, onDismiss }) {
  const done = setup || {};
  const completed = STEPS.filter((s) => done[s.key]).length;
  const total = STEPS.length;
  const allDone = completed >= total;

  // Animate the progress bar toward the current ratio.
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(progress, { toValue: completed / total, duration: 500, useNativeDriver: false }).start();
  }, [completed, total, progress]);

  if (allDone) return null; // nothing left to set up → hide entirely

  return (
    <View style={styles.wrap}>
      <LinearGradient colors={['#0B0F22', '#141C36']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Finish setting up{firstName ? `, ${firstName}` : ''}</Text>
          <Text style={styles.sub}>A few quick steps and you're ready to apply</Text>
        </View>
        <TouchableOpacity onPress={onDismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={styles.close}>
          <Ionicons name="close" size={16} color="rgba(255,255,255,0.6)" />
        </TouchableOpacity>
      </LinearGradient>

      <View style={styles.body}>
        {/* Progress */}
        <View style={styles.progressRow}>
          <View style={styles.track}>
            <Animated.View style={[styles.fillWrap, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]}>
              <LinearGradient colors={[C.blue, C.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFillObject} />
            </Animated.View>
          </View>
          <Text style={styles.progressText}>{completed}/{total}</Text>
        </View>

        {/* Steps */}
        {STEPS.map((s, i) => {
          const isDone = !!done[s.key];
          return (
            <TouchableOpacity
              key={s.key}
              activeOpacity={isDone ? 1 : 0.7}
              disabled={isDone}
              onPress={() => onStep && onStep(s.target)}
              style={[styles.step, i === STEPS.length - 1 && { borderBottomWidth: 0 }]}
            >
              <View style={[styles.stepIcon, isDone && styles.stepIconDone]}>
                {isDone
                  ? <Ionicons name="checkmark" size={16} color="#fff" />
                  : <Ionicons name={s.icon} size={16} color={C.blue} />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.stepLabel, isDone && styles.stepLabelDone]}>{s.label}</Text>
                {!isDone && <Text style={styles.stepHint}>{s.hint}</Text>}
              </View>
              {isDone
                ? <Text style={styles.doneTag}>Done</Text>
                : <Ionicons name="arrow-forward" size={17} color={C.blue} />}
            </TouchableOpacity>
          );
        })}

        {/* Account settings — the hub where every step lives */}
        <TouchableOpacity style={styles.settingsBtn} activeOpacity={0.85} onPress={() => onStep && onStep('account')}>
          <Ionicons name="settings-outline" size={14} color={C.muted} />
          <Text style={styles.settingsText}>Open Account Settings</Text>
          <Ionicons name="chevron-forward" size={14} color={C.faint} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: '#fff', borderRadius: 22, marginBottom: 16, overflow: 'hidden',
    shadowColor: '#0F172A', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.10, shadowRadius: 24, elevation: 6,
    borderWidth: 1, borderColor: C.line,
  },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 16, gap: 10 },
  title: { color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: -0.3 },
  sub: { color: 'rgba(255,255,255,0.6)', fontSize: 12.5, marginTop: 2 },
  close: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)' },
  body: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  track: { flex: 1, height: 7, borderRadius: 4, backgroundColor: C.track, overflow: 'hidden' },
  fillWrap: { height: '100%', borderRadius: 4, overflow: 'hidden' },
  progressText: { fontSize: 12.5, fontWeight: '800', color: C.muted, minWidth: 30, textAlign: 'right' },
  step: {
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.line,
  },
  stepIcon: {
    width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(79,141,255,0.12)',
  },
  stepIconDone: { backgroundColor: C.emerald },
  stepLabel: { fontSize: 14, fontWeight: '700', color: C.ink },
  stepLabelDone: { color: C.faint, textDecorationLine: 'line-through' },
  stepHint: { fontSize: 12, color: C.faint, marginTop: 1 },
  doneTag: { fontSize: 12, fontWeight: '700', color: C.emerald },
  settingsBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 10,
    paddingVertical: 11, borderRadius: 12, backgroundColor: '#F1F4FA',
  },
  settingsText: { fontSize: 13, fontWeight: '700', color: C.muted },
});
