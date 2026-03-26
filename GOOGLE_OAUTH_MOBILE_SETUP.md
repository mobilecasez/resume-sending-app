# Google OAuth for Mobile Setup Guide

## Problem Solved

Google OAuth was **not working on Expo mobile app** while Microsoft OAuth worked fine. The issue was that we were using `expo-auth-session/providers/google` hook which requires additional configuration that wasn't properly set up.

## Solution

Switched Google OAuth to use the same `WebBrowser.openAuthSessionAsync` approach as Microsoft OAuth, making the implementation consistent and eliminating dependencies on Expo's auth session hooks.

## Changes Made

### 1. Removed Hook-Based Approach
**Before:**
```javascript
const [request, response, promptAsync] = Google.useAuthRequest({
  clientId: GOOGLE_CLIENT_ID,
  scopes: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.send'],
});

useEffect(() => {
  if (response?.type === 'success') {
    handleGoogleAuthResponse(response.authentication.accessToken);
  }
}, [response]);
```

**After:**
```javascript
const handleGoogleLogin = async () => {
  setLoading(true);
  try {
    const redirectUri = `cvapplyr://google-auth`;
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${GOOGLE_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=token` +
      `&scope=${encodeURIComponent('profile email https://www.googleapis.com/auth/gmail.send')}`;
    
    const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri);
    
    if (result.type === 'success') {
      const accessTokenMatch = result.url.match(/access_token=([^&]+)/);
      if (accessTokenMatch) {
        await handleGoogleAuthResponse(accessTokenMatch[1]);
      }
    }
  } finally {
    setLoading(false);
  }
};
```

### 2. Updated Button References
- Removed dependency on `request` object (button was checking `!request`)
- Changed `onPress={() => promptAsync()}` to `onPress={handleGoogleLogin}`
- Applied to both login and register screens

## Google Cloud Console Configuration Required

To make Google OAuth work on mobile, you need to configure the redirect URI in Google Cloud Console:

### Steps:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project
3. Navigate to **APIs & Services** → **Credentials**
4. Click on your OAuth 2.0 Client ID
5. Under **Authorized redirect URIs**, add:
   ```
   cvapplyr://google-auth
   ```

### Current Configuration:
- **Client ID**: `832256639733-b0481qdpal17m1rcmmvq4nlnlvavgg59.apps.googleusercontent.com`
- **Redirect URI**: `cvapplyr://google-auth`
- **Response Type**: `token` (Implicit Flow)
- **Scopes**: 
  - `profile`
  - `email`
  - `https://www.googleapis.com/auth/gmail.send`

## Why Microsoft OAuth Worked

Microsoft OAuth was already using `WebBrowser.openAuthSessionAsync` with a proper redirect URI (`msauth://com.cvapplyr.app/callback`), which is why it worked without issues.

## Testing

After these changes and Google Cloud Console configuration:

1. **Login Screen**: Tap "Google" button → Opens browser → Authenticate → Redirects back
2. **Register Screen**: Tap "Sign up with Google" → Same flow
3. **Token Extraction**: Access token extracted from URL fragment
4. **Backend**: Token sent to `/api/auth/google` for verification

## Benefits

- ✅ Consistent OAuth pattern for both Google and Microsoft
- ✅ No dependency on `expo-auth-session` hooks
- ✅ Direct control over redirect URIs
- ✅ Simpler debugging and error handling
- ✅ Works on both iOS and Android

## Notes

- The `expo-auth-session/providers/google` import can now be removed if not used elsewhere
- Both iOS and Android will use the same redirect URI scheme: `cvapplyr://google-auth`
- Make sure the scheme `cvapplyr` matches your app.json configuration
