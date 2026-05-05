// AI Hub — new feature. Safe to delete without affecting existing app.
// This file makes the AI Hub accessible as a tab in the (tabs) navigator.
// It redirects immediately to the (ai-hub) stack so the full Stack header
// and nested navigation (add-contact, job-detail) work correctly.

import { Redirect } from 'expo-router';

export default function JobHubTab() {
  return <Redirect href="/(ai-hub)" />;
}
