import React, { useState, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Text,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';

export default function DashboardScreen({ navigation }) {
  const [user, setUser] = useState(null);
  const [stats, setStats] = useState({
    totalApplications: 0,
    coveredApplications: 0,
    pendingApplications: 0,
  });
  const [credits, setCredits] = useState({
    balance: 0,
    expiringCredits: 0,
    expiryDate: null,
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      setLoading(true);
      const userData = await SecureStore.getItemAsync('userData');
      const token = await SecureStore.getItemAsync('authToken');

      if (userData) {
        setUser(JSON.parse(userData));
      }

      // Fetch dashboard stats and credits
      if (token) {
        // Fetch dashboard stats
        const statsResponse = await axios.get(`${API_BASE}/dashboard/stats`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (statsResponse.data.success) {
          setStats(statsResponse.data.stats);
        }

        // Fetch credit balance
        try {
          const creditsResponse = await axios.get(`${API_BASE}/user/credits`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (creditsResponse.data.success) {
            setCredits({
              balance: creditsResponse.data.balance || 0,
              expiringCredits: creditsResponse.data.expiringCredits || 0,
              expiryDate: creditsResponse.data.expiryDate,
            });
          }
        } catch (error) {
          console.error('Error loading credits:', error);
          // Don't fail the whole dashboard if credits fail
        }
      }
    } catch (error) {
      console.error('Error loading dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadDashboard();
    setRefreshing(false);
  };

  const handleLogout = async () => {
    Alert.alert('Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', onPress: () => {} },
      {
        text: 'Logout',
        onPress: async () => {
          await SecureStore.deleteItemAsync('authToken');
          await SecureStore.deleteItemAsync('userData');
          navigation.reset({
            index: 0,
            routes: [{ name: 'Login' }],
          });
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#1e40af" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <Text style={styles.greeting}>Welcome back, {user?.name}!</Text>
        <Text style={styles.subtext}>Here's your application summary</Text>
      </View>

      {/* Credit Balance Card - Prominently displayed */}
      <TouchableOpacity
        style={styles.creditCard}
        onPress={() => navigation.navigate('Usage')}
      >
        <View style={styles.creditHeader}>
          <Text style={styles.creditLabel}>💳 Available Credits</Text>
          <Text style={styles.viewDetailsText}>View Details →</Text>
        </View>
        <Text style={styles.creditBalance}>{credits.balance}</Text>
        {credits.expiringCredits > 0 && credits.expiryDate && (
          <View style={styles.expiryWarning}>
            <Text style={styles.expiryText}>
              ⚠️ {credits.expiringCredits} credits expiring soon
            </Text>
          </View>
        )}
        <Text style={styles.creditSubtext}>
          Tap to view usage stats & purchase more credits
        </Text>
      </TouchableOpacity>

      <View style={styles.statsContainer}>
        <View style={styles.statCard}>
          <Text style={styles.statNumber}>{stats.totalApplications}</Text>
          <Text style={styles.statLabel}>Total Applications</Text>
        </View>

        <View style={styles.statCard}>
          <Text style={styles.statNumber}>{stats.coveredApplications}</Text>
          <Text style={styles.statLabel}>With Cover Letters</Text>
        </View>

        <View style={styles.statCard}>
          <Text style={styles.statNumber}>{stats.pendingApplications}</Text>
          <Text style={styles.statLabel}>Pending</Text>
        </View>
      </View>

      <View style={styles.quickActions}>
        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => navigation.navigate('Generate')}
        >
          <Text style={styles.actionButtonIcon}>✨</Text>
          <Text style={styles.actionButtonText}>Generate Cover Letter</Text>
          <Text style={styles.actionButtonArrow}>→</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => navigation.navigate('Applications')}
        >
          <Text style={styles.actionButtonIcon}>📋</Text>
          <Text style={styles.actionButtonText}>View Applications</Text>
          <Text style={styles.actionButtonArrow}>→</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => navigation.navigate('Usage')}
        >
          <Text style={styles.actionButtonIcon}>📊</Text>
          <Text style={styles.actionButtonText}>Usage & Credits</Text>
          <Text style={styles.actionButtonArrow}>→</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => navigation.navigate('Profile')}
        >
          <Text style={styles.actionButtonIcon}>👤</Text>
          <Text style={styles.actionButtonText}>Edit Profile</Text>
          <Text style={styles.actionButtonArrow}>→</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.footer}>
        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <Text style={styles.logoutButtonText}>Logout</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
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
  greeting: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 4,
  },
  subtext: {
    fontSize: 14,
    color: '#6b7280',
  },
  creditCard: {
    margin: 16,
    marginTop: 12,
    backgroundColor: '#1e40af',
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
  },
  creditHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  creditLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
    opacity: 0.9,
  },
  viewDetailsText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
    opacity: 0.8,
  },
  creditBalance: {
    fontSize: 48,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 8,
  },
  expiryWarning: {
    backgroundColor: 'rgba(251, 191, 36, 0.2)',
    borderRadius: 8,
    padding: 8,
    marginBottom: 8,
  },
  expiryText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fef3c7',
  },
  creditSubtext: {
    fontSize: 12,
    color: '#ffffff',
    opacity: 0.7,
  },
  statsContainer: {
    flexDirection: 'row',
    padding: 16,
    gap: 12,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  statNumber: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1e40af',
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '500',
    textAlign: 'center',
  },
  quickActions: {
    padding: 16,
    gap: 12,
  },
  actionButton: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  actionButtonIcon: {
    fontSize: 24,
    marginRight: 12,
  },
  actionButtonText: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#1f2937',
  },
  actionButtonArrow: {
    fontSize: 18,
    color: '#9ca3af',
  },
  footer: {
    padding: 20,
  },
  logoutButton: {
    backgroundColor: '#ef4444',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
  },
  logoutButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
});
