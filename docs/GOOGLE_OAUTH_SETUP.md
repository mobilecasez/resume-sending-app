# Google OAuth Setup for Web & Mobile

This document explains how to configure Google OAuth for both your web (localhost:3000) and mobile (Expo) versions.

## Architecture

The app now uses a **dual-endpoint OAuth strategy**:

1. **Web (Desktop)**: Uses traditional OAuth redirect flow via Passport.js
   - Endpoint: `GET http://localhost:3000/auth/google`
   - Callback: `GET http://localhost:3000/auth/google/callback`
   - Returns: HTML redirect to `/auth-success.html`

2. **Mobile (Expo)**: Uses direct API endpoint with access token
   - Endpoint: `POST http://192.168.1.14:3000/api/auth/google`
   - Client: Uses `expo-auth-session` to get access token
   - Returns: JSON with JWT token and user data
   - Mobile IP: `http://192.168.1.14:3000` (for local network)

## Step 1: Get Your Google Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable the **Google+ API**
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Choose **Web application**
6. You'll get:
   - **Client ID**: `XXXXX.apps.googleusercontent.com`
   - **Client Secret**: Keep this private!

## Step 2: Add Authorized Redirect URIs

In Google Cloud Console, under your OAuth 2.0 Client ID, add these Redirect URIs:

### For Web (Desktop)
```
http://localhost:3000/auth/google/callback
```

### For Mobile (Local Network)
```
http://192.168.1.14:3000/auth/google/callback
```

### Optional: For Testing on Different Networks
```
http://127.0.0.1:3000/auth/google/callback
```

Your final **Authorized Redirect URIs** should look like:
```
http://localhost:3000/auth/google/callback
http://192.168.1.14:3000/auth/google/callback
http://127.0.0.1:3000/auth/google/callback
```

> **Note**: Replace `192.168.1.14` with your actual local IP address if different. Find it with: `ifconfig | grep "inet "`

## Step 3: Configure Your App

### Mobile (Expo)

Open [MobileApp/App.js](MobileApp/App.js) and replace:
```javascript
const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
```

With your actual Client ID:
```javascript
const GOOGLE_CLIENT_ID = '123456789.apps.googleusercontent.com';
```

### Web/Backend

Open [server.js](server.js) and verify the Google OAuth strategy is configured:
```javascript
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'YOUR_GOOGLE_CLIENT_SECRET',
    callbackURL: '/auth/google/callback'
}), ...);
```

You can set environment variables or edit these values in the code.

## Step 4: Start Your Servers

```bash
# Terminal 1: Backend (port 3000)
cd /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app
npm start
# Backend should say: "Server running on port 3000"

# Terminal 2: Expo (port 8081)
cd MobileApp
npm start
# Select 'i' for iOS or 'a' for Android, or 'w' for web
```

## Step 5: Test Google OAuth

### On Web (Desktop)
1. Go to http://localhost:3000
2. Click **"Sign in with Google"**
3. Sign in with your Google account
4. Should redirect to dashboard with your name

### On Mobile (Expo)
1. Scan QR code at http://localhost:3001
2. Click **"Sign in with Google"** button
3. Account picker opens (from expo-auth-session)
4. Select your Google account
5. Should navigate to dashboard with your name

## How It Works

### Web Flow (Passport.js Redirect)
```
User clicks "Sign in with Google"
↓
→ GET /auth/google (Passport initiates OAuth)
↓
→ Redirects to Google login
↓
← User logs in and grants permission
↓
← Redirects back to /auth/google/callback
↓
Passport handles the callback automatically
↓
User data extracted and JWT generated
↓
→ /auth-success.html?token=JWT_TOKEN
↓
Dashboard loaded with user data
```

### Mobile Flow (Direct API)
```
User clicks "Sign in with Google"
↓
→ expo-auth-session shows account picker
↓
← User selects account
↓
← Google returns accessToken to app
↓
useEffect captures accessToken
↓
handleGoogleAuthResponse() called
↓
→ POST /api/auth/google { accessToken }
↓
Backend exchanges token for user info
↓
Backend creates/finds user and generates JWT
↓
← Returns { token, user } in JSON
↓
App stores user and navigates to dashboard
```

## Troubleshooting

### "Invalid redirect URI" error
- Check that your redirect URI exactly matches what's in Google Console
- Includes protocol (`http://` not `https://`), IP/domain, port, and path
- Common mistake: forgetting the port number

### Mobile app says "Connection refused"
- Make sure `192.168.1.14` is your correct local IP
- Find it: `ifconfig | grep "inet "`
- Update API_BASE in [MobileApp/App.js](MobileApp/App.js)

### "Access Denied" or "invalid_grant"
- Make sure Client ID is correct
- Make sure you're signing in with a Google account, not a workspace/organization account
- Check that the callback URL is authorized in Google Console

### Token expires too quickly
- JWT tokens are set to expire in 24 hours
- Adjust in server.js line ~423: `{ expiresIn: '24h' }`

### User data not showing
- Check browser console (web) or Expo logs (mobile)
- Make sure Google API returns user info properly
- Verify the user was created in SQLite database

## Files Modified

1. **[MobileApp/App.js](MobileApp/App.js)**
   - Added Google Client ID constant
   - Added `Google.useAuthRequest()` hook
   - Added `handleGoogleAuthResponse()` function
   - Added useEffect to capture OAuth response

2. **[server.js](server.js)**
   - Enhanced `/auth/google/callback` with mobile detection
   - Added new `POST /api/auth/google` endpoint for mobile
   - Both create/find users and return JWT tokens

## Security Notes

- **Client ID**: Safe to share (it's meant to be)
- **Client Secret**: Keep this private! Don't commit to git
- **Tokens**: JWT tokens are returned in responses, store securely on client
- **HTTPS**: For production, use HTTPS not HTTP
- **IP Addresses**: Only use for local development, not production

## Next Steps

1. ✅ Add Google OAuth redirect URIs to Google Console
2. ✅ Replace `GOOGLE_CLIENT_ID` in [MobileApp/App.js](MobileApp/App.js)
3. ✅ Test on web: http://localhost:3000
4. ✅ Test on mobile: Scan QR code at http://localhost:3001
5. ✅ For production: Use ngrok or proper hosting with real domains

## Support

If you need help:
- Check Google Cloud Console settings match exactly
- Look at browser/terminal console logs
- Verify both servers are running (backend + Expo)
- Make sure firewall isn't blocking port 3000 or 8081
