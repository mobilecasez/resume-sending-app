// AI Hub — new feature. Safe to delete without affecting existing app.

import { Stack } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import HelpAssistant from '../../components/HelpAssistant';

export default function AIHubLayout() {
  return (
    <View style={{ flex: 1 }}>
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: '#0B1120' },
      }}
    >
      {/* index has its own WishlistBar header — no Stack header needed */}
      <Stack.Screen
        name="index"
        options={{ headerShown: false }}
      />
      {/* job-detail has its own hero back-button — no Stack header needed */}
      <Stack.Screen
        name="job-detail"
        options={{ headerShown: false }}
      />
      {/* add-contact is a modal — keep the Stack header with back/close */}
      <Stack.Screen
        name="add-contact"
        options={{
          title: 'Add Contact',
          headerStyle: { backgroundColor: '#0B1120' },
          headerTintColor: '#FFFFFF',
          headerTitleStyle: { fontWeight: '700', color: '#FFFFFF' },
          headerBackTitle: 'Back',
          presentation: 'modal',
        }}
      />
    </Stack>
    {/* The guide follows the user through the app. WebViews (apply browser, Google browser) are
        Modals, so they cover the button on their own — exactly the "hide while browsing" rule. */}
    <HelpAssistant context="jobs" />
    </View>
  );
}
