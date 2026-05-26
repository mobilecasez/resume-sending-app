// AI Hub — new feature. Safe to delete without affecting existing app.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

const T = {
  surface:   '#FFFFFF',
  textFaint: '#8896B0',
  ink:       '#0B0F22',
  blue:      '#4F8DFF',
  blueDeep:  '#2563EB',
};

const TABS = [
  { key: 'dashboard', label: 'Home',    icon: 'home',                 iconActive: 'home' },
  { key: 'jobs',      label: 'Jobs',    icon: 'briefcase-outline',    iconActive: 'briefcase' },
  { key: 'review',    label: 'Letters', icon: 'document-text-outline',iconActive: 'document-text' },
  { key: 'profile',   label: 'Me',      icon: 'person-outline',       iconActive: 'person' },
];

export default function FloatingTabBar({ currentScreen, setScreen, handleReview }) {
  function handlePress(tabKey) {
    if (tabKey === 'jobs') {
      try { require('expo-router').router?.push?.('/(ai-hub)'); } catch (_) {}
      return;
    }
    if (tabKey === 'review') {
      handleReview && handleReview();
      return;
    }
    setScreen && setScreen(tabKey);
  }

  const active = currentScreen === 'review' ? 'review'
    : currentScreen === 'profile' ? 'profile'
    : currentScreen === 'notifications' ? 'dashboard'
    : currentScreen === 'usage' ? 'dashboard'
    : currentScreen || 'dashboard';

  return (
    <View style={styles.wrapper}>
      <View style={styles.bar}>
        {TABS.map(tab => {
          const isActive = active === tab.key;
          if (isActive) {
            return (
              <LinearGradient
                key={tab.key}
                colors={[T.blue, T.blueDeep]}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                style={styles.activeTab}
              >
                <TouchableOpacity
                  style={styles.activeTabInner}
                  onPress={() => handlePress(tab.key)}
                  activeOpacity={0.8}
                >
                  <Ionicons name={tab.iconActive} size={16} color="#fff" />
                  <Text style={styles.activeLabel}>{tab.label}</Text>
                </TouchableOpacity>
              </LinearGradient>
            );
          }
          return (
            <TouchableOpacity
              key={tab.key}
              style={styles.tab}
              onPress={() => handlePress(tab.key)}
              activeOpacity={0.7}
            >
              <Ionicons name={tab.icon} size={20} color={T.textFaint} />
              <Text style={styles.label}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    paddingHorizontal: 20,
    paddingBottom: 28,
    paddingTop: 8,
    backgroundColor: 'transparent',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: T.surface,
    borderRadius: 28,
    paddingVertical: 8,
    paddingHorizontal: 8,
    gap: 4,
    shadowColor: '#0B0F22',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
    elevation: 12,
  },
  activeTab: {
    flex: 1,
    borderRadius: 22,
  },
  activeTabInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  activeLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.2,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 6,
  },
  label: {
    fontSize: 10,
    fontWeight: '600',
    color: T.textFaint,
    letterSpacing: -0.1,
  },
});
