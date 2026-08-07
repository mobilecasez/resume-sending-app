// AI Hub — new feature. Safe to delete without affecting existing app.
import { Stack } from 'expo-router';
import React from 'react';

export default function TutorialLayout() {
  return (
    <Stack screenOptions={{ contentStyle: { backgroundColor: '#05080F' } }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
    </Stack>
  );
}
