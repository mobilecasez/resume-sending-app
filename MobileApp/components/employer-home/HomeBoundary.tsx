// AI Hub — new feature. Safe to delete without affecting existing app.
//
// ⚠️ THIS WRAPS THE APP'S FRONT DOOR, SO IT MUST NEVER BE THE THING THAT BREAKS IT.
// The employer Home replaced the dashboard as the first screen every user sees. A render error
// there would white-screen the app on launch with no way out — the worst failure this codebase
// can ship. An error boundary turns that into a visible, recoverable fallback: the user lands on
// the Dashboard they already know, and we get told.
//
// React has no hook form of componentDidCatch, so this is the one class component in the feature.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { E } from './theme';

type Props = { children: React.ReactNode; onFallback: () => void };
type State = { failed: boolean };

export default class HomeBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State { return { failed: true }; }

  componentDidCatch(error: any, info: any) {
    try {
      // Report it, then get out of the user's way.
      require('../../services/analytics').track('home_employer_crash', {
        message: String(error?.message || error).slice(0, 200),
        stack: String(info?.componentStack || '').slice(0, 300),
      });
    } catch {}
    console.warn('[EmployerHome] render failed — falling back to Dashboard:', error?.message || error);
  }

  render() {
    if (!this.state.failed) return this.props.children as any;
    return (
      <View style={s.wrap}>
        <View style={s.icon}><Ionicons name="grid-outline" size={26} color={E.blue} /></View>
        <Text style={s.title}>Your dashboard is ready</Text>
        <Text style={s.sub}>We couldn’t draw the new home just now. Everything else works normally.</Text>
        <TouchableOpacity
          style={s.btn}
          activeOpacity={0.9}
          onPress={() => { this.setState({ failed: false }); this.props.onFallback(); }}
        >
          <Text style={s.btnTx}>Open Dashboard</Text>
          <Ionicons name="arrow-forward" size={15} color="#fff" />
        </TouchableOpacity>
      </View>
    );
  }
}

const s = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, backgroundColor: E.bg },
  icon: { width: 58, height: 58, borderRadius: 29, backgroundColor: 'rgba(79,141,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '800', color: E.ink, marginTop: 14, letterSpacing: -0.4 },
  sub: { fontSize: 13, color: E.textMuted, textAlign: 'center', marginTop: 8, lineHeight: 19 },
  btn: { marginTop: 18, height: 46, paddingHorizontal: 22, borderRadius: 14, backgroundColor: E.ink, flexDirection: 'row', alignItems: 'center', gap: 8 },
  btnTx: { fontSize: 14, fontWeight: '800', color: '#fff' },
});
