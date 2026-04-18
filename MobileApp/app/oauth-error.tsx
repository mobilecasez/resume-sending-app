import { View } from 'react-native';

// Catch-all for cvapplyr://oauth-error?... deep links
// Prevents expo-router "unmatched route" error
export default function OAuthError() {
  return <View />;
}
