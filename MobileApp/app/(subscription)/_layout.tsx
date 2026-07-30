// AI Hub — new feature. Safe to delete without affecting existing app.
//
// ⚠️ Opened from the ☰ menu inside App.js's screen system → this stack's ROOT has nothing to go
// back to, so it must supply its own close control (the support stack learned this the hard way).
import { Stack, useRouter } from 'expo-router';
import React from 'react';
import { TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import HelpAssistant from '../../components/HelpAssistant';

function HeaderClose({ back = false }: { back?: boolean }) {
  const router = useRouter();
  return (
    <TouchableOpacity
      onPress={() => { if (back && router.canGoBack()) router.back(); else if (router.canGoBack()) router.back(); else router.replace('/'); }}
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      accessibilityRole="button"
      accessibilityLabel={back ? 'Back' : 'Close'}
      style={{ paddingRight: 14, paddingLeft: 2 }}
    >
      <Ionicons name={back ? 'arrow-back' : 'close'} size={24} color="#FFFFFF" />
    </TouchableOpacity>
  );
}

export default function SubscriptionLayout() {
  return (
    <View style={{ flex: 1 }}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#0B1120' },
          headerTintColor: '#FFFFFF',
          headerTitleStyle: { fontWeight: '800' },
          contentStyle: { backgroundColor: '#F0F4FA' },
          headerBackVisible: false,
        }}
      >
        <Stack.Screen name="usage" options={{ title: 'Plans & Usage', headerLeft: () => <HeaderClose /> }} />
        <Stack.Screen name="plans" options={{ title: 'Plans', headerLeft: () => <HeaderClose back /> }} />
      </Stack>
      <HelpAssistant />
    </View>
  );
}
