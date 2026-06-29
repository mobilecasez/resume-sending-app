// AI Hub — new feature. Safe to delete without affecting existing app.

import { Stack } from 'expo-router';
import React from 'react';

export default function AdminLayout() {
  return (
    <Stack screenOptions={{ contentStyle: { backgroundColor: '#0B1120' } }}>
      <Stack.Screen name="ai-event-credits" options={{ headerShown: false }} />
      <Stack.Screen name="employer-requests" options={{ headerShown: false }} />
      <Stack.Screen name="store-analytics" options={{ headerShown: false }} />
    </Stack>
  );
}
