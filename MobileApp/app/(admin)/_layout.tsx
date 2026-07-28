// AI Hub — new feature. Safe to delete without affecting existing app.

import { Stack } from 'expo-router';
import React from 'react';

export default function AdminLayout() {
  return (
    <Stack screenOptions={{ contentStyle: { backgroundColor: '#0B1120' } }}>
      <Stack.Screen name="ai-event-credits" options={{ headerShown: false }} />
      <Stack.Screen name="employer-requests" options={{ headerShown: false }} />
      <Stack.Screen name="store-analytics" options={{ headerShown: false }} />
      <Stack.Screen name="registered-users" options={{ headerShown: false }} />
      <Stack.Screen name="user-analytics" options={{ headerShown: false }} />
      <Stack.Screen name="user-360" options={{ headerShown: false }} />
      <Stack.Screen name="segments" options={{ headerShown: false }} />
      <Stack.Screen name="environment" options={{ headerShown: false }} />
      <Stack.Screen name="support" options={{ headerShown: false }} />
    </Stack>
  );
}
