// AI Hub — new feature. Safe to delete without affecting existing app.
// Small "N credits" / "Free" pill shown on any button that spends AI credits.
// Cost comes from the admin-configurable event-costs map (see useEventCosts).

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function CreditCostPill({
  credits,
  tone = 'light',
  style,
}: {
  credits?: number | null;
  tone?: 'light' | 'dark';
  style?: any;
}) {
  if (credits === null || credits === undefined) return null; // unknown/loading → render nothing
  const free = credits <= 0;
  const dark = tone === 'dark';
  const color = free ? '#10B981' : dark ? '#22D3EE' : '#0E7490';
  return (
    <View style={[styles.pill, dark ? styles.pillDark : styles.pillLight, free && styles.pillFree, style]}>
      <Ionicons name={free ? 'gift-outline' : 'flash'} size={11} color={color} />
      <Text style={[styles.txt, { color }]}>{free ? 'Free' : `${credits} ${credits === 1 ? 'credit' : 'credits'}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  pillLight: { backgroundColor: 'rgba(6,182,212,0.12)' },
  pillDark: { backgroundColor: 'rgba(34,211,238,0.16)' },
  pillFree: { backgroundColor: 'rgba(16,185,129,0.14)' },
  txt: { fontSize: 11, fontWeight: '700' },
});
