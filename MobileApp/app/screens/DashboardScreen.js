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
  Animated,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../../config';

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
  const fadeAnim = new Animated.Value(0);
  const slideAnim = new Animated.Value(30);

  useEffect(() => {
    loadDashboard();
  }, []);

  useEffect(() => {
    if (!loading) {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 600,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [loading]);

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
      <LinearGradient
        colors={['#667eea', '#764ba2', '#f093fb']}
        style={styles.centerContainer}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      >
        <ActivityIndicator size="large" color="#ffffff" />
      </LinearGradient>
    );
  }

  return (
    <LinearGradient
      colors={['#667eea', '#764ba2', '#f093fb']}
      style={styles.container}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
    >
      <ScrollView
        style={styles.scrollView}
        refreshControl={
          <RefreshControl 
            refreshing={refreshing} 
            onRefresh={onRefresh}
            tintColor="#ffffff"
          />
        }
      >
        <Animated.View
          style={[
            styles.content,
            {
              opacity: fadeAnim,
              transform: [{ translateY: slideAnim }],
            },
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.greeting}>Welcome back,</Text>
            <Text style={styles.userName}>{user?.name}!</Text>
            <Text style={styles.subtext}>Here's your application summary</Text>
          </View>

          {/* Credit Balance Card */}
          <TouchableOpacity
            style={styles.creditCardContainer}
            onPress={() => navigation.navigate('Usage')}
            activeOpacity={0.9}
          >
            <BlurView intensity={30} tint="light" style={styles.creditCard}>
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
            </BlurView>
          </TouchableOpacity>

          {/* Stats Container */}
          <View style={styles.statsContainer}>
            <BlurView intensity={30} tint="light" style={styles.statCard}>
              <Text style={styles.statNumber}>{stats.totalApplications}</Text>
              <Text style={styles.statLabel}>Total Applications</Text>
            </BlurView>

            <BlurView intensity={30} tint="light" style={styles.statCard}>
              <Text style={styles.statNumber}>{stats.coveredApplications}</Text>
              <Text style={styles.statLabel}>With Cover Letters</Text>
            </BlurView>

            <BlurView intensity={30} tint="light" style={styles.statCard}>
              <Text style={styles.statNumber}>{stats.pendingApplications}</Text>
              <Text style={styles.statLabel}>Pending</Text>
            </BlurView>
          </View>

          {/* Quick Actions */}
          <View style={styles.quickActions}>
            <TouchableOpacity
              style={styles.actionButtonContainer}
              onPress={() => navigation.navigate('Generate')}
              activeOpacity={0.8}
            >
              <BlurView intensity={30} tint="light" style={styles.actionButton}>
                <Text style={styles.actionButtonIcon}>✨</Text>
                <Text style={styles.actionButtonText}>Generate Cover Letter</Text>
                <Text style={styles.actionButtonArrow}>→</Text>
              </BlurView>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionButtonContainer}
              onPress={() => navigation.navigate('Applications')}
              activeOpacity={0.8}
            >
              <BlurView intensity={30} tint="light" style={styles.actionButton}>
                <Text style={styles.actionButtonIcon}>📋</Text>
                <Text style={styles.actionButtonText}>View Applications</Text>
                <Text style={styles.actionButtonArrow}>→</Text>
              </BlurView>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionButtonContainer}
              onPress={() => navigation.navigate('Usage')}
              activeOpacity={0.8}
            >
              <BlurView intensity={30} tint="light" style={styles.actionButton}>
                <Text style={styles.actionButtonIcon}>📊</Text>
                <Text style={styles.actionButtonText}>Usage & Credits</Text>
                <Text style={styles.actionButtonArrow}>→</Text>
              </BlurView>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionButtonContainer}
              onPress={() => navigation.navigate('Profile')}
              activeOpacity={0.8}
            >
              <BlurView intensity={30} tint="light" style={styles.actionButton}>
                <Text style={styles.actionButtonIcon}>👤</Text>
                <Text style={styles.actionButtonText}>Edit Profile</Text>
                <Text style={styles.actionButtonArrow}>→</Text>
              </BlurView>
            </TouchableOpacity>
          </View>

          {/* Footer */}
          <View style={styles.footer}>
            <TouchableOpacity 
              style={styles.logoutButtonContainer} 
              onPress={handleLogout}
              activeOpacity={0.8}
            >
              <BlurView intensity={40} tint="dark" style={styles.logoutButton}>
                <Text style={styles.logoutButtonText}>Logout</Text>
              </BlurView>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrollView: {
    flex: 1,
  },
  content: {
    paddingBottom: 30,
  },
  header: {
    padding: 24,
    paddingTop: 60,
    paddingBottom: 30,
  },
  greeting: {
    fontSize: 18,
    fontWeight: '400',
    color: '#ffffff',
    opacity: 0.95,
    marginBottom: 4,
  },
  userName: {
    fontSize: 32,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 8,
  },
  subtext: {
    fontSize: 15,
    color: '#ffffff',
    opacity: 0.85,
  },
  creditCardContainer: {
    marginHorizontal: 16,
    marginBottom: 20,
  },
  creditCard: {
    borderRadius: 20,
    padding: 24,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.3)',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 8,
  },
  creditHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  creditLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#ffffff',
  },
  viewDetailsText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#ffffff',
    opacity: 0.9,
  },
  creditBalance: {
    fontSize: 56,
    fontWeight: '800',
    color: '#ffffff',
    marginBottom: 8,
    letterSpacing: -2,
  },
  expiryWarning: {
    backgroundColor: 'rgba(251, 191, 36, 0.3)',
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  expiryText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
  },
  creditSubtext: {
    fontSize: 13,
    color: '#ffffff',
    opacity: 0.85,
  },
  statsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 20,
  },
  statCard: {
    flex: 1,
    borderRadius: 16,
    padding: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    alignItems: 'center',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
  },
  statNumber: {
    fontSize: 28,
    fontWeight: '800',
    color: '#ffffff',
    marginBottom: 6,
  },
  statLabel: {
    fontSize: 11,
    color: '#ffffff',
    fontWeight: '500',
    textAlign: 'center',
    opacity: 0.9,
  },
  quickActions: {
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 20,
  },
  actionButtonContainer: {
    marginBottom: 4,
  },
  actionButton: {
    flexDirection: 'row',
    borderRadius: 14,
    padding: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    alignItems: 'center',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
  },
  actionButtonIcon: {
    fontSize: 24,
    marginRight: 14,
  },
  actionButtonText: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
  actionButtonArrow: {
    fontSize: 20,
    color: '#ffffff',
    opacity: 0.8,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  logoutButtonContainer: {
    marginBottom: 10,
  },
  logoutButton: {
    borderRadius: 14,
    padding: 16,
    backgroundColor: 'rgba(239, 68, 68, 0.3)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
    alignItems: 'center',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  logoutButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
});
