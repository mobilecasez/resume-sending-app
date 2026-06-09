// Cover Letter Builder — new feature. Safe to delete without affecting existing app.
import { Stack } from 'expo-router';
import React from 'react';

export default function CoverLetterLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#E5EAF3' } }}>
      <Stack.Screen name="templates" />
    </Stack>
  );
}
