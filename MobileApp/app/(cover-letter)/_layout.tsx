// Cover Letter Builder — new feature. Safe to delete without affecting existing app.
import { Stack } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import HelpAssistant from '../../components/HelpAssistant';

export default function CoverLetterLayout() {
  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#E5EAF3' } }}>
        <Stack.Screen name="templates" />
      </Stack>
      {/* The guide follows the user through the app. */}
      <HelpAssistant context="cover" />
    </View>
  );
}
