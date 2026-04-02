import React, { useState } from 'react';
import {
  View,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import config from '../../config';

const { API_BASE_URL } = config;

export default function GenerateCoverLetterScreen() {
  const [formData, setFormData] = useState({
    company_name: '',
    position: '',
    job_description: '',
    user_experience: '',
  });
  const [loading, setLoading] = useState(false);
  const [generatedLetter, setGeneratedLetter] = useState(null);

  const handleInputChange = (field, value) => {
    setFormData({ ...formData, [field]: value });
  };

  const handleGenerate = async () => {
    if (!formData.company_name || !formData.position || !formData.job_description) {
      Alert.alert('Error', 'Please fill in all required fields');
      return;
    }

    setLoading(true);
    try {
      const token = await SecureStore.getItemAsync('authToken');

      const response = await axios.post(
        `${API_BASE_URL}/api/generate-cover-letter`,
        formData,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (response.data.success) {
        setGeneratedLetter(response.data.coverLetter);
        Alert.alert('Success', 'Cover letter generated!');
      }
    } catch (error) {
      Alert.alert('Error', error.response?.data?.error || 'Failed to generate cover letter');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveLetter = async () => {
    if (!generatedLetter) {
      Alert.alert('Error', 'No letter to save');
      return;
    }

    setLoading(true);
    try {
      const token = await SecureStore.getItemAsync('authToken');

      const response = await axios.post(
        `${API_BASE_URL}/api/save-cover-letter`,
        {
          ...formData,
          coverLetter: generatedLetter,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (response.data.success) {
        Alert.alert('Success', 'Cover letter saved!');
        setFormData({
          company_name: '',
          position: '',
          job_description: '',
          user_experience: '',
        });
        setGeneratedLetter(null);
      }
    } catch (error) {
      Alert.alert('Error', error.response?.data?.error || 'Failed to save cover letter');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.title}>Generate Cover Letter</Text>
          <Text style={styles.subtitle}>AI-powered cover letter generation</Text>
        </View>

        {!generatedLetter ? (
          <View style={styles.form}>
            <View style={styles.formGroup}>
              <Text style={styles.label}>Company Name *</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g., Acme Corporation"
                value={formData.company_name}
                onChangeText={(text) => handleInputChange('company_name', text)}
                editable={!loading}
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Position Title *</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g., Senior Software Engineer"
                value={formData.position}
                onChangeText={(text) => handleInputChange('position', text)}
                editable={!loading}
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Job Description *</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                placeholder="Paste the job description here..."
                value={formData.job_description}
                onChangeText={(text) => handleInputChange('job_description', text)}
                editable={!loading}
                multiline
                numberOfLines={6}
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Your Experience</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                placeholder="Briefly describe your relevant experience..."
                value={formData.user_experience}
                onChangeText={(text) => handleInputChange('user_experience', text)}
                editable={!loading}
                multiline
                numberOfLines={4}
              />
            </View>

            <TouchableOpacity
              style={[styles.generateButton, loading && styles.buttonDisabled]}
              onPress={handleGenerate}
              disabled={loading}
            >
              <Text style={styles.generateButtonText}>
                {loading ? '✨ Generating...' : '✨ Generate Cover Letter'}
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.resultContainer}>
            <View style={styles.letterContainer}>
              <Text style={styles.letterTitle}>Generated Cover Letter</Text>
              <Text style={styles.letterContent}>{generatedLetter}</Text>
            </View>

            <View style={styles.actions}>
              <TouchableOpacity
                style={styles.saveButton}
                onPress={handleSaveLetter}
                disabled={loading}
              >
                <Text style={styles.saveButtonText}>
                  {loading ? 'Saving...' : '💾 Save Letter'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.editButton}
                onPress={() => setGeneratedLetter(null)}
                disabled={loading}
              >
                <Text style={styles.editButtonText}>Edit & Regenerate</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  scrollView: {
    flex: 1,
  },
  header: {
    padding: 20,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#6b7280',
  },
  form: {
    padding: 16,
  },
  formGroup: {
    marginBottom: 20,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    fontFamily: 'System',
  },
  textArea: {
    height: 120,
    textAlignVertical: 'top',
  },
  generateButton: {
    backgroundColor: '#1e40af',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 20,
  },
  generateButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  resultContainer: {
    padding: 16,
  },
  letterContainer: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  letterTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  letterContent: {
    fontSize: 14,
    lineHeight: 22,
    color: '#374151',
    fontFamily: 'System',
  },
  actions: {
    gap: 12,
  },
  saveButton: {
    backgroundColor: '#10b981',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
  },
  saveButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  editButton: {
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  editButtonText: {
    color: '#1f2937',
    fontSize: 16,
    fontWeight: '600',
  },
});
