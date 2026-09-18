// AI Hub — new feature. Safe to delete without affecting existing app.
//
// ⚠️ THE PILL IS A LITTLE TRANSLUCENT (2026-09-18, "make the bottom menu little bit transparent").
// White at 93%, not opaque: what scrolls under the bar shows through as a faint tint, so the menu reads as
// floating over the page rather than as a white slab stamped on it. ⚠️ Not lower: at 86% (the first try) the
// page's own TEXT stayed legible through the pill, right behind the labels — on the simulator it read as clutter.
// ⚠️ NOT A BlurView. expo-blur is installed, and it is still the wrong tool for a bar that sits over a
// scrolling page: it samples imperfectly on Android and costs real frames on both (DownloadHistory's
// glass note says the same). A translucent fill renders identically everywhere.
// ⚠️ THE INACTIVE INK GOT DARKER TO PAY FOR IT. The old #8896B0 was 3.0:1 on OPAQUE white; on this fill
// over a near-black page it would fall to 2.2:1. #5B6B8A (the Home theme's textMuted) is 5.4:1 on white
// and 4.6:1 in the worst case — the 93% fill over #070A18 (AA for normal text) — so every label is MORE legible than before
// on every screen. The active pill is an opaque gradient with white on it and did not change.
// Both are exported (TAB_BAR_FILL / TAB_BAR_INK) so the bars drawn inline elsewhere (HomeScreen's own
// copy of this bar, ReviewScreen's) can take the same values instead of drifting from them.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

/** The pill's fill: white, slightly see-through (see the header for why not a blur). */
export const TAB_BAR_FILL = 'rgba(255,255,255,0.93)';
/** Inactive icon + label ink — dark enough to hold on TAB_BAR_FILL over a dark page (see the header). */
export const TAB_BAR_INK = '#5B6B8A';

const T = {
  surface:   TAB_BAR_FILL,
  textFaint: TAB_BAR_INK,
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
    // A hairline of brighter white at the rim: on a dark page the translucent pill keeps a crisp edge
    // instead of melting into what is under it; on a light page it is invisible.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.9)',
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
