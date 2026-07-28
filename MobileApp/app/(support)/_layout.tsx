// AI Hub — new feature. Safe to delete without affecting existing app.
import { Stack } from 'expo-router';
import React from 'react';

export default function SupportLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#0B1120' },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: { fontWeight: '800' },
        contentStyle: { backgroundColor: '#F0F4FA' },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Help & support' }} />
      <Stack.Screen name="thread" options={{ title: 'Support' }} />
    </Stack>
  );
}
