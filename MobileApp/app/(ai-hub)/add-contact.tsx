// AI Hub — new feature. Safe to delete without affecting existing app.

import React, { useState } from 'react';
import {
  View,
  Text,
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
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
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
              colors={['#06B6D4', '#3B82F6']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.headerIcon}
            >
              <Ionicons name="person-add-outline" size={22} color="white" />
            </LinearGradient>
            <Text style={styles.headerTitle}>Add Hiring Contact</Text>
            <Text style={styles.headerSubtitle}>
              Add a contact manually. The AI will attempt to verify their email
              in the background.
            </Text>
          </View>

          {/* Form */}
          <View style={styles.form}>
            {/* Full Name */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>FULL NAME</Text>
              <View style={styles.inputWrapper}>
                <Ionicons
                  name="person-outline"
                  size={16}
                  color="#94A3B8"
                  style={styles.inputIcon}
                />
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Sarah Chen"
                  placeholderTextColor="#CBD5E1"
                  value={fullName}
                  onChangeText={setFullName}
                  returnKeyType="next"
                  autoCapitalize="words"
                  autoCorrect={false}
                />
              </View>
            </View>

            {/* Job Title / Role */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>JOB TITLE / ROLE</Text>
              <View style={styles.inputWrapper}>
                <Ionicons
                  name="briefcase-outline"
                  size={16}
                  color="#94A3B8"
                  style={styles.inputIcon}
                />
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Engineering Manager"
                  placeholderTextColor="#CBD5E1"
                  value={jobTitle}
                  onChangeText={setJobTitle}
                  returnKeyType="next"
                  autoCapitalize="words"
                  autoCorrect={false}
                />
              </View>
            </View>

            {/* Email Address */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>EMAIL ADDRESS</Text>
              <View style={styles.inputWrapper}>
                <Ionicons
                  name="mail-outline"
                  size={16}
                  color="#94A3B8"
                  style={styles.inputIcon}
                />
                <TextInput
                  style={styles.input}
                  placeholder="e.g. s.chen@company.com"
                  placeholderTextColor="#CBD5E1"
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

            {/* Verification note */}
            <View style={styles.verifyNote}>
              <Ionicons name="shield-checkmark-outline" size={14} color="#06B6D4" />
              <Text style={styles.verifyNoteText}>
                Email will be queued for AI verification after saving.
              </Text>
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
              colors={saving ? ['#94A3B8', '#94A3B8'] : ['#06B6D4', '#3B82F6']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.saveBtn}
            >
              <Ionicons
                name={saving ? 'hourglass-outline' : 'checkmark-circle-outline'}
                size={18}
                color="white"
              />
              <Text style={styles.saveBtnText}>
                {saving ? 'Saving…' : 'Save Contact'}
              </Text>
            </LinearGradient>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F0F4FA',
  },
  flex: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },

  // ── Header card ──
  headerCard: {
    backgroundColor: 'white',
    borderRadius: 20,
    padding: 20,
    alignItems: 'center',
    marginBottom: 20,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 16,
    elevation: 4,
  },
  headerIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 6,
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 19,
  },

  // ── Form ──
  form: {
    backgroundColor: 'white',
    borderRadius: 20,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 16,
    elevation: 4,
  },
  fieldGroup: {
    marginBottom: 18,
  },
  fieldLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#94A3B8',
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    backgroundColor: '#F8FAFC',
  },
  inputIcon: {
    paddingLeft: 14,
  },
  input: {
    flex: 1,
    paddingVertical: 13,
    paddingHorizontal: 10,
    fontSize: 14,
    color: '#0F172A',
  },
  verifyNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(6,182,212,0.06)',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 4,
  },
  verifyNoteText: {
    fontSize: 12,
    color: '#0891B2',
    flex: 1,
  },

  // ── Save button ──
  saveBtnOuter: {
    borderRadius: 16,
    shadowColor: '#06B6D4',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    paddingVertical: 16,
    gap: 8,
  },
  saveBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: 'white',
  },
});
