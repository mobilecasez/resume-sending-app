// AI Hub — new feature. Safe to delete without affecting existing app.
// The way into the Job Agent from the Jobs screen: one card, one tap. Says what it does in one line.
import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { track } from '../services/analytics';

export default function JobAgentEntry() {
  const router = useRouter();
  return (
    <TouchableOpacity activeOpacity={0.9} style={s.wrap}
      onPress={() => { track('job_agent_entry_tap', { from: 'jobs' }).catch(() => {}); router.push('/(job-agent)' as never); }}
      accessibilityRole="button" accessibilityLabel="Open Job Agent: it finds matching jobs and prepares tailored applications every day">
      {/* Solid navy: the feed behind it is LIGHT (#E5EAF3), where a translucent tint made white text unreadable. */}
      <LinearGradient colors={['#0B1120', '#16224A']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.card}>
        <View style={s.icon}><Ionicons name="sparkles" size={18} color="#fff" /></View>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Job Agent</Text>
          <Text style={s.body}>Finds jobs that fit you and prepares tailored applications every day</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.7)" />
      </LinearGradient>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  // ⚠️ NO marginHorizontal: full width inside the list's padding of 12, like the launcher above it (see its wrap).
  wrap: { marginBottom: 10 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 18, padding: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  icon: { width: 36, height: 36, borderRadius: 12, backgroundColor: '#06B6D4', alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontWeight: '800', fontSize: 15 },
  body: { color: 'rgba(255,255,255,0.65)', fontSize: 12, marginTop: 2 },
});
