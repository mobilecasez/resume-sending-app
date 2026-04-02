# Google OAuth for Mobile Setup Guide

## Problem Solved

Google OAuth was **not working on Expo mobile app** because:
1. Custom URI schemes like `cvapplyr://` are **rejected** by Google Cloud Console
2. Google requires **platform-specific OAuth clients** (iOS/Android) with proper redirect URI formats
3. Microsoft OAuth works because it accepts custom schemes

## Solution

Use Google's **reverse domain notation** for redirect URIs, which iOS automatically handles.

## Current Configuration

- **Client ID**: `151384459549-ujnpfbck9e0q2jkmt2q4l0lv1s41lp04.apps.googleusercontent.com`
- **Bundle ID (iOS)**: `com.cvapplyr.mobile`
- **Package Name (Android)**: `com.cvapplyr.mobile`

## Google Cloud Console Setup

### Option 1: iOS OAuth Client (RECOMMENDED for iOS)

1. **Go to Google Cloud Console**
   - Visit [Google Cloud Console](https://console.cloud.google.com/)
   - Select your project

2. **Create iOS OAuth Client**
   - Navigate to **APIs & Services** → **Credentials**
   - Click **+ CREATE CREDENTIALS** → **OAuth client ID**
   - Select **iOS**
   - **Bundle ID**: `com.cvapplyr.mobile`
   - **App Store ID**: (leave empty for now, add when published)
   - Click **Create**

3. **Copy the iOS Client ID**
   - You'll get a Client ID in format: `XXXXXX-XXXXXX.apps.googleusercontent.com`
   - This generates an automatic redirect URI: `com.googleusercontent.apps.XXXXXX:/oauth2redirect/google`

### Option 2: Web OAuth Client (Current - needs redirect URI)

If you want to keep using your current Web OAuth Client:

1. **In OAuth Client Settings**
   - Select your existing OAuth client: `151384459549-ujnpfbck9e0q2jkmt2q4l0lv1s41lp04`
   - Under **Authorized redirect URIs**, add:

   **For iOS:**
   ```
   com.googleusercontent.apps.151384459549:/oauth2redirect/google
   ```

   **For Android:**
   ```
   com.cvapplyr.mobile:/oauth2redirect/google
   ```

2. **Why this works:**
   - `com.googleusercontent.apps.CLIENT_PREFIX` is Google's accepted format
   - Extracted from your Client ID: `151384459549-...`
   - iOS automatically handles this redirect URI format

### Option 3: Android OAuth Client (for Android only)

1. **Create Android OAuth Client**
   - Navigate to **APIs & Services** → **Credentials**
   - Click **+ CREATE CREDENTIALS** → **OAuth client ID**
   - Select **Android**
   - **Package name**: `com.cvapplyr.mobile`
   - **SHA-1 certificate fingerprint**: (get from your keystore)
   - Click **Create**

## Code Changes Made

### Updated Client ID
```javascript
const GOOGLE_CLIENT_ID = '151384459549-ujnpfbck9e0q2jkmt2q4l0lv1s41lp04.apps.googleusercontent.com';
```

### Updated Redirect URI (Platform-Specific)
```javascript
const redirectUri = Platform.OS === 'ios' 
  ? `com.googleusercontent.apps.${GOOGLE_CLIENT_ID.split('-')[0]}:/oauth2redirect/google`
  : `com.cvapplyr.mobile:/oauth2redirect/google`;
```

**Results in:**
- **iOS**: `com.googleusercontent.apps.151384459549:/oauth2redirect/google`
- **Android**: `com.cvapplyr.mobile:/oauth2redirect/google`

## Quick Start (Minimum Steps)

### ✅ Add These Redirect URIs to Your OAuth Client

In Google Cloud Console → Your OAuthClient → Authorized redirect URIs:

1. **iOS redirect:**
   ```
   com.googleusercontent.apps.151384459549:/oauth2redirect/google
   ```

2. **Android redirect (optional, for Android support):**
   ```
   com.cvapplyr.mobile:/oauth2redirect/google
   ```

3. **Click SAVE**

That's it! Google OAuth should now work on iOS.

## How It Works

1. **User taps "Sign in with Google"**
2. **App opens browser** with Google auth URL
3. **Google shows login page**
4. **User authenticates**
5. **Google redirects to** `com.googleusercontent.apps.151384459549:/oauth2redirect/google?access_token=...`
6. **iOS recognizes** the `com.googleusercontent.apps.*` scheme and opens your app
7. **App extracts** access token from URL
8. **Backend validates** token with Google API

## Testing

1. **Add redirect URIs to Google Cloud Console** (see above)
2. **Rebuild your Expo app** (changes to OAuth require rebuild)
3. **Test on iOS device/simulator**
4. **Tap "Sign in with Google"**
5. **Should open browser → Authenticate → Return to app**

## Differences from Microsoft OAuth

| Feature | Microsoft OAuth | Google OAuth |
|---------|----------------|--------------|
| Custom schemes | ✅ Accepts `msauth://` | ❌ Rejects custom schemes |
| Redirect format | `msauth://com.cvapplyr.app/callback` | `com.googleusercontent.apps.XXX:/oauth2redirect/google` |
| Configuration | Simple, one redirect URI | Platform-specific clients recommended |
| Web client | Works with one client | Needs iOS/Android clients or web with special URIs |

## Troubleshooting

### Error: "Invalid Redirect: must end with a public top-level domain"
- ✅ **Fixed**: Use `com.googleusercontent.apps.151384459549:/oauth2redirect/google`
- ❌ **Don't use**: `cvapplyr://google-auth`

### Error: "redirect_uri_mismatch"
- Check the redirect URI in Google Cloud Console exactly matches the code
- iOS: `com.googleusercontent.apps.151384459549:/oauth2redirect/google`
- Android: `com.cvapplyr.mobile:/oauth2redirect/google`

### OAuth doesn't open/return
- Make sure you've rebuilt the app after code changes
- Check console logs for the redirect URI being used
- Verify the URI is added in Google Cloud Console

## Why This Approach

- ✅ No custom URI scheme needed
- ✅ Google accepts reverse domain notation
- ✅ iOS handles `com.googleusercontent.apps.*` automatically
- ✅ Works with Web OAuth Client
- ✅ Consistent with Google's mobile OAuth guidelines

## Benefits

- **No app.json changes needed** - iOS handles the redirect automatically
- **Works immediately** after Google Cloud Console config
- **Platform-specific** - Different URIs for iOS and Android
- **follows Google best practices** for mobile OAuth
