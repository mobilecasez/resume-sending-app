// AI Hub — new feature. Safe to delete without affecting existing app.
import { Stack } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import HelpAssistant from '../../components/HelpAssistant';

export default function DiscoverLayout() {
  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ contentStyle: { backgroundColor: '#0B1120' } }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="saved" options={{ headerShown: false }} />
      </Stack>
      {/* The guide follows the user; WebView modals cover it automatically. */}
      <HelpAssistant />
    </View>
  );
}
