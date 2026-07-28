// AI Hub — new feature. Safe to delete without affecting existing app.
//
// ⚠️ THIS STACK NEEDS ITS OWN BACK BUTTON.
//
// Support is opened from the ☰ menu inside App.js's own screen system, so when expo-router pushes
// /(support) it becomes the FIRST screen of a fresh stack. A stack has nothing to go back to at its
// root, so react-navigation draws no back arrow — and the user is stranded on the help screen with
// no way out but the OS gesture, which does not exist on Android without a hardware/gesture back.
// That is exactly what happened in testing.
//
// So the root screen gets an explicit close control that leaves the router entirely, and the child
// screen gets a normal back arrow that returns to the list.
import { Stack, useRouter } from 'expo-router';
import React, { useCallback } from 'react';
import { TouchableOpacity, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

function HeaderClose({ mode }: { mode: 'close' | 'back' }) {
  const router = useRouter();
  const go = useCallback(() => {
    // canGoBack() is false at the root of this stack — dismissing all returns to whatever the app
    // was showing before Support was opened.
    if (mode === 'back' && router.canGoBack()) { router.back(); return; }
    try {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch { router.replace('/'); }
  }, [mode, router]);

  return (
    <TouchableOpacity
      onPress={go}
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      accessibilityRole="button"
      accessibilityLabel={mode === 'back' ? 'Back' : 'Close help and support'}
      style={{ paddingRight: 14, paddingLeft: Platform.OS === 'android' ? 0 : 2 }}
    >
      <Ionicons name={mode === 'back' ? 'arrow-back' : 'close'} size={24} color="#FFFFFF" />
    </TouchableOpacity>
  );
}

export default function SupportLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#0B1120' },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: { fontWeight: '800' },
        contentStyle: { backgroundColor: '#F0F4FA' },
        headerBackVisible: false,   // we supply our own on both screens
      }}
    >
      <Stack.Screen
        name="index"
        options={{ title: 'Help & support', headerLeft: () => <HeaderClose mode="close" /> }}
      />
      <Stack.Screen
        name="thread"
        options={{ title: 'Support', headerLeft: () => <HeaderClose mode="back" /> }}
      />
    </Stack>
  );
}
