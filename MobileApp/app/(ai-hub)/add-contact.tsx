// AI Hub — new feature. Safe to delete without affecting existing app.

import React, { useState } from 'react';
import {
  View,
  Text,
  Image,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { addContactToJob } from '../../services/aiHubService';

// ─── Theme (matches job-detail.tsx / index.tsx) ───────────────────
const T = {
  bg:        '#E5EAF3',
  surface:   '#FFFFFF',
  inputBg:   '#F1F4FA',
  ink:       '#0B0F22',
  inkSoft:   '#1A2046',
  textMuted: '#5A6480',
  textFaint: '#8A93B2',
  border:    'rgba(11,15,34,0.08)',
  blue:      '#4F8DFF',
  blueDeep:  '#2563EB',
};

export default function AddContactScreen() {
  const router = useRouter();
  const { jobId } = useLocalSearchParams<{ jobId: string }>();

  const [fullName, setFullName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const nameTrimmed = fullName.trim();
    const titleTrimmed = jobTitle.trim();
    const emailTrimmed = email.trim();

    if (!nameTrimmed) {
      Alert.alert('Validation', 'Please enter the contact\'s full name.');
      return;
    }
    if (!titleTrimmed) {
      Alert.alert('Validation', 'Please enter the contact\'s job title or role.');
      return;
    }
    if (!emailTrimmed || !emailTrimmed.includes('@')) {
      Alert.alert('Validation', 'Please enter a valid email address.');
      return;
    }

    setSaving(true);
    try {
      await addContactToJob(jobId ?? '', {
        name: nameTrimmed,
        role: titleTrimmed,
        email: emailTrimmed,
      });
      Alert.alert('Success', 'Contact added successfully', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch {
      Alert.alert('Error', 'Failed to save contact. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      {/* Top bar — matches the rest of the AI Hub */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backPill} activeOpacity={0.8}>
          <Ionicons name="arrow-back" size={14} color={T.ink} />
          <Text style={styles.backPillText}>Back</Text>
        </TouchableOpacity>
        <View style={styles.wordmark} pointerEvents="none">
          <Image source={require('../../assets/images/logo_img.png')} style={styles.wordmarkLogo} resizeMode="contain" />
          <Text style={styles.wordmarkText}>cv<Text style={styles.wordmarkBlue}>applyr</Text></Text>
        </View>
        <View style={{ width: 70 }} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Header card */}
          <View style={styles.headerCard}>
            <LinearGradient
              colors={[T.blue, T.blueDeep]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.headerIcon}
            >
              <Ionicons name="person-add" size={22} color="white" />
            </LinearGradient>
            <Text style={styles.headerTitle}>Add Hiring Contact</Text>
            <Text style={styles.headerSubtitle}>
              Add a contact manually. It's saved to this job so you can email them directly.
            </Text>
          </View>

          {/* Form */}
          <View style={styles.form}>
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>FULL NAME</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="person-outline" size={16} color={T.blue} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Sarah Chen"
                  placeholderTextColor={T.textFaint}
                  value={fullName}
                  onChangeText={setFullName}
                  returnKeyType="next"
                  autoCapitalize="words"
                  autoCorrect={false}
                />
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>JOB TITLE / ROLE</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="briefcase-outline" size={16} color={T.blue} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Engineering Manager"
                  placeholderTextColor={T.textFaint}
                  value={jobTitle}
                  onChangeText={setJobTitle}
                  returnKeyType="next"
                  autoCapitalize="words"
                  autoCorrect={false}
                />
              </View>
            </View>

            <View style={[styles.fieldGroup, { marginBottom: 0 }]}>
              <Text style={styles.fieldLabel}>EMAIL ADDRESS</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="mail-outline" size={16} color={T.blue} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="e.g. s.chen@company.com"
                  placeholderTextColor={T.textFaint}
                  value={email}
                  onChangeText={setEmail}
                  returnKeyType="done"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  onSubmitEditing={handleSave}
                />
              </View>
            </View>
          </View>

          {/* Save button */}
          <TouchableOpacity
            onPress={handleSave}
            disabled={saving}
            style={styles.saveBtnOuter}
            activeOpacity={0.85}
          >
            <LinearGradient
              colors={saving ? ['#9FB0CF', '#9FB0CF'] : [T.blue, T.blueDeep]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.saveBtn}
            >
              <Ionicons
                name={saving ? 'hourglass-outline' : 'checkmark-circle-outline'}
                size={18}
                color="white"
              />
              <Text style={styles.saveBtnText}>{saving ? 'Saving…' : 'Save Contact'}</Text>
            </LinearGradient>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: T.bg },
  flex: { flex: 1 },

  // ── Top bar ──
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10, backgroundColor: T.bg,
  },
  backPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: T.surface, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 12,
    shadowColor: T.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 3, zIndex: 1,
  },
  backPillText: { fontSize: 13, fontWeight: '600', color: T.ink },
  wordmark: {
    position: 'absolute', left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, zIndex: 0,
  },
  wordmarkLogo: { width: 22, height: 22 },
  wordmarkText: { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  wordmarkBlue: { color: T.blue },

  scrollContent: { padding: 16, paddingBottom: 40, gap: 14 },

  // ── Header card ──
  headerCard: {
    backgroundColor: T.surface, borderRadius: 24, padding: 22, alignItems: 'center',
    shadowColor: T.ink, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 4,
  },
  headerIcon: { width: 52, height: 52, borderRadius: 16, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  headerTitle: { fontSize: 19, fontWeight: '800', color: T.ink, letterSpacing: -0.3, marginBottom: 6 },
  headerSubtitle: { fontSize: 13, color: T.textMuted, textAlign: 'center', lineHeight: 19 },

  // ── Form ──
  form: {
    backgroundColor: T.surface, borderRadius: 22, padding: 18,
    shadowColor: T.ink, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.07, shadowRadius: 16, elevation: 4,
  },
  fieldGroup: { marginBottom: 16 },
  fieldLabel: { fontSize: 10, fontWeight: '800', color: T.textFaint, letterSpacing: 1.2, marginBottom: 8 },
  inputWrapper: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: T.border, borderRadius: 12, backgroundColor: T.inputBg,
  },
  inputIcon: { paddingLeft: 14 },
  input: { flex: 1, paddingVertical: 13, paddingHorizontal: 10, fontSize: 14, color: T.ink, fontWeight: '500' },

  // ── Save button ──
  saveBtnOuter: {
    borderRadius: 16,
    shadowColor: T.blue, shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 16, paddingVertical: 16, gap: 8 },
  saveBtnText: { fontSize: 16, fontWeight: '700', color: 'white' },
});
