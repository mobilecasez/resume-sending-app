import { View } from 'react-native';

// Catch-all for cvapplyr://oauth-callback?... deep links
// Prevents expo-router "unmatched route" error
export default function OAuthCallback() {
  return <View />;
}
