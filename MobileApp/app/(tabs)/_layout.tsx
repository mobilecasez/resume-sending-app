import { Tabs, useRouter } from 'expo-router';
import React, { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

/** Set once the user has actually applied to something — see markApplied / markAppliedByUrl. */
export const APPLIED_FLAG = 'cvf_has_applied_v1';

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter();

  // ⚠️ LAND ON JOBS UNTIL THE FIRST APPLICATION. Production says the funnel dies before the job
  // search: 337 registered, 92 with a résumé, 18 who ever ran a search, 5 who ever applied. Opening
  // on Letters asks people to compose something for a job they have not found yet. Once they HAVE
  // applied the app stops steering and Home behaves normally again.
  // Done here rather than in App.js — App.js owns the Letters screen but has no route to this tab,
  // and the project forbids editing it. A one-shot replace() also cannot fight a user's own taps.
  const steered = useRef(false);
  useEffect(() => {
    if (steered.current) return;
    steered.current = true;
    (async () => {
      try {
        const applied = await AsyncStorage.getItem(APPLIED_FLAG);
        if (applied === '1') return;                       // they are past this stage — leave them alone
        router.replace('/(tabs)/job-hub' as never);
      } catch { /* navigation is a nicety; never block the tab bar */ }
    })();
  }, [router]);

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme ?? 'light'].tint,
        headerShown: false,
        tabBarButton: HapticTab,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="house.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Explore',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="paperplane.fill" color={color} />,
        }}
      />
      {/* AI Hub — new feature. Safe to delete without affecting existing app. */}
      <Tabs.Screen
        name="job-hub"
        options={{
          title: 'Job Hub',
          tabBarIcon: ({ color }) => (
            <Ionicons name="briefcase-outline" size={24} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
