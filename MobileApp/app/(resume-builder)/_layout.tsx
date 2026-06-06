// Resume Builder — new feature. Safe to delete without affecting existing app.
import { Stack } from 'expo-router';
import React from 'react';

export default function ResumeBuilderLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#E5EAF3' } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="manual" />
      <Stack.Screen name="preview" />
      <Stack.Screen name="templates" />
    </Stack>
  );
}
