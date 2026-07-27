import React, { useState, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Text,
  TouchableOpacity,
  ScrollView,
  FlatList,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../../config';

// The base url is read live at every request below (`${API_BASE}`) instead of being snapshotted
// into a module-scope const. Destructuring it at import time froze it before the admin environment
// override could be loaded, so this screen would keep talking to the previous backend while the
// rest of the app talked to the new one — a session split across production and local.

export default function ApplicationsScreen({ navigation }) {
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadApplications();
  }, []);

  const loadApplications = async () => {
    try {
      setLoading(true);
      const token = await SecureStore.getItemAsync('authToken');

      if (token) {
        const response = await axios.get(`${API_BASE}/api/applications`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (response.data.success) {
          setApplications(response.data.applications || []);
        }
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to load applications');
    } finally {
      setLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadApplications();
    setRefreshing(false);
  };

  const handleDeleteApplication = async (id) => {
    Alert.alert('Delete Application', 'Are you sure you want to delete this application?', [
      { text: 'Cancel', onPress: () => {} },
      {
        text: 'Delete',
        onPress: async () => {
          try {
            const token = await SecureStore.getItemAsync('authToken');
            await axios.delete(`${API_BASE}/api/applications/${id}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            loadApplications();
            Alert.alert('Success', 'Application deleted');
          } catch (error) {
            Alert.alert('Error', 'Failed to delete application');
          }
        },
      },
    ]);
  };

  const renderApplicationItem = ({ item }) => (
    <View style={styles.applicationCard}>
      <View style={styles.applicationHeader}>
        <View style={styles.applicationInfo}>
          <Text style={styles.companyName}>{item.company_name}</Text>
          <Text style={styles.position}>{item.position}</Text>
        </View>
        <View style={[styles.badge, item.cover_letter ? styles.badgeCovered : styles.badgePending]}>
          <Text style={styles.badgeText}>
            {item.cover_letter ? '✓ Covered' : 'Pending'}
          </Text>
        </View>
      </View>

      <Text style={styles.applicationDate}>
        Applied: {new Date(item.created_at).toLocaleDateString()}
      </Text>

      {item.application_link && (
        <TouchableOpacity
          onPress={() => {
            // Open URL in browser
            // In a real app, use Linking.openURL(item.application_link)
          }}
          style={styles.linkButton}
        >
          <Text style={styles.linkButtonText}>View Application Link →</Text>
        </TouchableOpacity>
      )}

      {item.cover_letter && (
        <TouchableOpacity style={styles.viewButton}>
          <Text style={styles.viewButtonText}>View Cover Letter</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={styles.deleteButton}
        onPress={() => handleDeleteApplication(item.id)}
      >
        <Text style={styles.deleteButtonText}>Delete</Text>
      </TouchableOpacity>
    </View>
  );

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#1e40af" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>My Applications</Text>
        <Text style={styles.subtitle}>{applications.length} applications</Text>
      </View>

      {applications.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyStateIcon}>📭</Text>
          <Text style={styles.emptyStateText}>No applications yet</Text>
          <Text style={styles.emptyStateSubtext}>Start by adding your first application</Text>
        </View>
      ) : (
        <FlatList
          data={applications}
          renderItem={renderApplicationItem}
          keyExtractor={(item) => item.id.toString()}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
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
  listContent: {
    padding: 16,
    gap: 12,
  },
  applicationCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  applicationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  applicationInfo: {
    flex: 1,
  },
  companyName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 4,
  },
  position: {
    fontSize: 14,
    color: '#6b7280',
    fontWeight: '500',
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  badgeCovered: {
    backgroundColor: '#d1fae5',
  },
  badgePending: {
    backgroundColor: '#fef3c7',
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1f2937',
  },
  applicationDate: {
    fontSize: 12,
    color: '#9ca3af',
    marginBottom: 12,
  },
  linkButton: {
    paddingVertical: 8,
    marginBottom: 8,
  },
  linkButtonText: {
    color: '#1e40af',
    fontSize: 14,
    fontWeight: '500',
  },
  viewButton: {
    backgroundColor: '#1e40af',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
    alignItems: 'center',
  },
  viewButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  deleteButton: {
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: 8,
    padding: 10,
    alignItems: 'center',
  },
  deleteButtonText: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '600',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyStateIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyStateText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 4,
  },
  emptyStateSubtext: {
    fontSize: 14,
    color: '#6b7280',
  },
});
