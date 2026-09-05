// AI Hub — new feature. Safe to delete without affecting existing app.
import { Stack } from 'expo-router';
export default function DevLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
