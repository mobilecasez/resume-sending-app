// AI Hub — new feature. Safe to delete without affecting existing app.

import { Stack } from 'expo-router';
import React from 'react';

export default function AIHubLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#0B1120' },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: { fontWeight: '700', color: '#FFFFFF' },
        headerBackTitle: 'Back',
        contentStyle: { backgroundColor: '#0B1120' },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: 'AI Hub',
          headerLargeTitle: false,
        }}
      />
      <Stack.Screen
        name="job-detail"
        options={{
          title: 'Job Detail',
          headerBackTitle: 'Hub',
        }}
      />
      <Stack.Screen
        name="add-contact"
        options={{
          title: 'Add Contact',
          headerBackTitle: 'Back',
          presentation: 'modal',
        }}
      />
    </Stack>
  );
}
