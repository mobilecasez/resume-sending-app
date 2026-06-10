import { useEffect } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

// This route catches the server's cvapplyr://oauth-success?token=...&user=... redirect.
// App.js's Linking listener (handleDeepLink) does the actual token processing and
// sets the logged-in user + screen='dashboard'. This screen exists only so expo-router
// doesn't throw an "unmatched route" error — then it immediately bounces back to "/"
// (the App.js root) so the user lands on the dashboard instead of a blank screen.
export default function OAuthSuccess() {
  useEffect(() => {
    // replace (not push) so this transient route is removed from the stack
    const t = setTimeout(() => {
      try { router.replace('/'); } catch (e) {}
    }, 0);
    return () => clearTimeout(t);
  }, []);
  return <View style={{ flex: 1, backgroundColor: '#0B1120' }} />;
}
