// AI Hub — new feature. Safe to delete without affecting existing app.
import { Stack } from 'expo-router';
import React from 'react';

export default function DiscoverLayout() {
  return (
    <Stack screenOptions={{ contentStyle: { backgroundColor: '#0B1120' } }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="saved" options={{ headerShown: false }} />
    </Stack>
  );
}
