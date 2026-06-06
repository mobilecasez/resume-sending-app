// This tab is rendered by App.js (the main HomeScreen / Letters page).
// Expo-router requires a file here for the tab to exist, but App.js
// controls what actually renders via its `screen` state — this file
// is never shown to the user directly.
import { useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export default function HomeTab() {
  useEffect(() => {
    // If expo-router ever lands here directly, tell App.js to show HomeScreen.
    AsyncStorage.setItem('aiHub_navigate_home', 'true').catch(() => {});
  }, []);
  return null;
}
