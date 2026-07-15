// AI Hub — new feature. Safe to delete without affecting existing app.
// Standalone /saved route (Saved Jobs is primarily the "Saved" tab on Explore; this keeps a direct route).
import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import SavedJobsList from '../../components/SavedJobsList';

const T = { bg: '#E5EAF3', surface: '#FFFFFF', ink: '#0B0F22', border: 'rgba(11,15,34,0.06)' };

export default function SavedJobsScreen() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}><Ionicons name="chevron-back" size={20} color={T.ink} /></TouchableOpacity>
        <Text style={styles.topTitle}>Saved Jobs</Text>
        <View style={{ width: 38 }} />
      </View>
      <SavedJobsList />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: T.bg },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: Platform.OS === 'android' ? 30 : 6, paddingBottom: 8 },
  backBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: T.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.border },
  topTitle: { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
});
