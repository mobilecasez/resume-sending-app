# Quick Start: Google OAuth Configuration

## What You Need to Do (3 Simple Steps)

### Step 1: Get Google Credentials (5 min)
```
1. Go to: https://console.cloud.google.com/
2. New Project → Name it → Create
3. Enable Google+ API
4. OAuth consent screen → External → Create
5. Credentials → Create OAuth 2.0 Client ID → Web application
6. Copy your Client ID
```

### Step 2: Add Callback URLs (2 min)
In Google Cloud Console, under your OAuth Client ID, add these 3 Authorized Redirect URIs:
```
http://localhost:3000/auth/google/callback
http://192.168.1.14:3000/auth/google/callback
http://127.0.0.1:3000/auth/google/callback
```
> Replace `192.168.1.14` with your actual IP: `ifconfig | grep "inet "`

### Step 3: Update Your App (1 min)
Edit [MobileApp/App.js](MobileApp/App.js) line 7:
```javascript
// Before:
const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';

// After:
const GOOGLE_CLIENT_ID = '123456789.apps.googleusercontent.com';  // Your actual Client ID
```

## Run the App

Terminal 1:
```bash
npm start
# Backend on http://localhost:3000
```

Terminal 2:
```bash
cd MobileApp
npm start
# Press 'i' for iOS, 'a' for Android, or 'w' for web
```

## Test Google Login

**On Web**: http://localhost:3000
- Click "Sign in with Google"
- Sign in
- See dashboard ✅

**On Mobile**: Scan QR at http://localhost:3001
- Click "Sign in with Google"
- See account picker
- Select account
- See dashboard ✅

## If Something Goes Wrong

| Error | Solution |
|-------|----------|
| "Invalid redirect URI" | Check exact match in Google Console (include protocol, IP, port, path) |
| "Connection refused" | Update API_BASE in MobileApp/App.js to your IP |
| "Access Denied" | Make sure using personal Google account, not workspace |
| Nothing happens | Check browser console (web) or Expo logs (mobile) |

## More Information
- [Full Setup Guide](GOOGLE_OAUTH_SETUP.md)
- [Implementation Status](OAUTH_IMPLEMENTATION_STATUS.md)

## The Flow (For Nerds 🤓)

```
Web (Desktop):
  User clicks "Sign in with Google"
  → Redirect to Google
  ← Google redirects back to /auth/google/callback
  → Backend exchanges code for token
  ← JWT returned, dashboard loaded

Mobile (Expo):
  User clicks "Sign in with Google"
  → expo-auth-session shows account picker
  ← User selects account, gets accessToken
  → App sends token to POST /api/auth/google
  ← Backend returns JWT, dashboard loaded
```

Both end with same result: JWT token + user data in dashboard ✅
