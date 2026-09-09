// AI Hub — new feature. Safe to delete without affecting existing app.
//
// ⚠️ A CROSSFADE, NOT A PUSH. This screen paints the same MeshStage the Home hero does, so a 220ms
// fade between the two reads as the hero simply staying put while the content on it changes. A
// slide would drag one copy of the same backdrop across another.
import { Stack } from 'expo-router';
export default function OnboardingLayout() {
  return <Stack screenOptions={{ headerShown: false, animation: 'fade', animationDuration: 220 }} />;
}
