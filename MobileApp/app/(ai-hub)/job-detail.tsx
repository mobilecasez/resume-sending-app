// AI Hub — new feature. Safe to delete without affecting existing app.

import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';

export default function JobDetailScreen() {
  const { jobId } = useLocalSearchParams<{ jobId: string }>();

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <View style={styles.container}>
        <Ionicons name="briefcase-outline" size={48} color="#CBD5E1" />
        <Text style={styles.title}>Job Detail</Text>
        <Text style={styles.subtitle}>
          Full job detail view for job{'\n'}
          <Text style={styles.jobId}>{jobId ?? '—'}</Text>
          {'\n'}coming soon.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F0F4FA',
  },
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    gap: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0F172A',
  },
  subtitle: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 22,
  },
  jobId: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    color: '#3B82F6',
  },
});
