import { View } from 'react-native';

// This route exists solely to prevent the "unmatched route" error
// when the server redirects to cvapplyr://oauth-success?token=...&user=...
// The actual token processing is handled by the Linking event listener in App.js
export default function OAuthSuccess() {
  return <View />;
}
