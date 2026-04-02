# Action Checklist for Google OAuth Setup

## ✅ What I've Completed

### Backend (server.js)
- ✅ Added POST /api/auth/google endpoint (lines 375-450)
- ✅ Implemented access token verification with Google API
- ✅ Implemented user creation/lookup in SQLite
- ✅ Implemented JWT token generation
- ✅ Implemented proper JSON response format
- ✅ Added error handling and validation
- ✅ Enhanced /auth/google/callback to support mobile detection

### Mobile App (MobileApp/App.js)
- ✅ Added Google OAuth imports (WebBrowser, expo-auth-session)
- ✅ Added Google Client ID constant (with placeholder)
- ✅ Set up Google.useAuthRequest() hook
- ✅ Implemented useEffect for OAuth response handling
- ✅ Created handleGoogleAuthResponse() function
- ✅ Created handleGoogleLogin() function
- ✅ Connected Google button to OAuth flow
- ✅ Integrated with backend API endpoint
- ✅ Added proper error handling and alerts
- ✅ Integrated with app navigation

### Documentation
- ✅ [GOOGLE_OAUTH_QUICKSTART.md](GOOGLE_OAUTH_QUICKSTART.md) - 3-step setup
- ✅ [GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md) - Detailed guide
- ✅ [OAUTH_IMPLEMENTATION_STATUS.md](OAUTH_IMPLEMENTATION_STATUS.md) - Full details
- ✅ [OAUTH_COMPLETE.md](OAUTH_COMPLETE.md) - Summary of changes
- ✅ [OAUTH_WEB_VS_MOBILE.md](OAUTH_WEB_VS_MOBILE.md) - Flow comparison

---

## 🔧 What YOU Need to Do

### Phase 1: Google Cloud Console Setup (5-10 minutes)

#### [ ] Step 1: Create Google OAuth Credentials
- [ ] Go to https://console.cloud.google.com/
- [ ] Create new project (or use existing)
- [ ] Search for "Google+ API" and enable it
- [ ] Go to "OAuth consent screen"
  - [ ] Select "External"
  - [ ] Fill in app name: "Lettrico"
  - [ ] Add your email as support email
  - [ ] Add scopes (basic profile is enough)
- [ ] Go to "Credentials" → "Create Credentials"
- [ ] Choose "OAuth 2.0 Client ID"
- [ ] Select "Web application"
- [ ] **Copy your Client ID** (save it somewhere)
  - Example: `123456789.apps.googleusercontent.com`

#### [ ] Step 2: Add Authorized Redirect URIs
- [ ] Still in "OAuth 2.0 Client ID" settings
- [ ] Find "Authorized Redirect URIs" section
- [ ] Add these 3 URLs:
  ```
  http://localhost:3000/auth/google/callback
  http://192.168.1.14:3000/auth/google/callback
  http://127.0.0.1:3000/auth/google/callback
  ```
- [ ] **Click Save**
- [ ] Verify all 3 URLs are there

> **Note**: If your IP is different, replace `192.168.1.14` with your actual IP
> Find it: Open terminal and run `ifconfig | grep "inet "`

---

### Phase 2: App Configuration (2 minutes)

#### [ ] Step 3: Update Mobile App with Client ID
- [ ] Open [MobileApp/App.js](MobileApp/App.js)
- [ ] Go to line 7
- [ ] Find this:
  ```javascript
  const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
  ```
- [ ] Replace with your actual Client ID:
  ```javascript
  const GOOGLE_CLIENT_ID = '123456789.apps.googleusercontent.com';
  ```
- [ ] **Save the file**

#### [ ] Step 4: Verify IP Address (Optional but important)
- [ ] Open [MobileApp/App.js](MobileApp/App.js)
- [ ] Go to line 10
- [ ] Check: `const API_BASE = 'http://192.168.1.14:3000/api';`
- [ ] If your IP is different:
  - [ ] Update to your IP: `'http://YOUR_IP:3000/api'`
  - [ ] Find your IP: `ifconfig | grep "inet "`
  - [ ] Save the file

---

### Phase 3: Run the Application (5 minutes)

#### [ ] Step 5: Start Backend Server
- [ ] Open Terminal 1
- [ ] Navigate to project root:
  ```bash
  cd /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app
  ```
- [ ] Start backend:
  ```bash
  npm start
  ```
- [ ] **Wait for**: "Server running on port 3000"
- [ ] Leave this terminal running

#### [ ] Step 6: Start Expo Development Server
- [ ] Open Terminal 2
- [ ] Navigate to MobileApp:
  ```bash
  cd /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app/MobileApp
  ```
- [ ] Start Expo:
  ```bash
  npm start
  ```
- [ ] Choose one:
  - [ ] Press 'i' for iOS simulator
  - [ ] Press 'a' for Android emulator
  - [ ] Press 'w' for web version
- [ ] **Wait for app to load**
- [ ] Leave this terminal running

#### [ ] Step 7: Start QR Code Server (Optional)
- [ ] Open Terminal 3
- [ ] Go to project root
- [ ] Run (if you have a separate QR server script):
  ```bash
  npm run qr  # or node public/qr-code-server.js
  ```
- [ ] Or just visit: http://localhost:3001 in your browser

---

### Phase 4: Testing (10 minutes)

#### [ ] Step 8: Test Web Login
- [ ] Open browser
- [ ] Go to http://localhost:3000
- [ ] See the login screen
- [ ] Click **"Sign in with Google"**
- [ ] Google sign-in page should appear
- [ ] Sign in with a personal Google account
- [ ] Should redirect back to dashboard
- [ ] **Verify**:
  - [ ] Your name appears on dashboard
  - [ ] Your email appears on dashboard
  - [ ] "Sign Out" button is visible
  - [ ] ✅ Web login works!

#### [ ] Step 9: Test Mobile Login
- [ ] Look at Expo terminal - should see QR code
- [ ] Get your phone/simulator ready
- [ ] Scan QR code OR
- [ ] Go to http://localhost:3001 on your phone
- [ ] Lettrico app should open
- [ ] Click **"Sign in with Google"**
- [ ] Account picker should appear (native dialog)
- [ ] Select your Google account
- [ ] Should see dashboard
- [ ] **Verify**:
  - [ ] Your name appears on dashboard
  - [ ] Your email appears on dashboard
  - [ ] You see the same user data as web
  - [ ] ✅ Mobile login works!

#### [ ] Step 10: Test Email/Password Still Works
- [ ] Still on login screen
- [ ] Try regular email/password login (not Google)
- [ ] Should work as before
- [ ] ✅ Legacy auth still works!

---

## 🐛 Troubleshooting

### "Invalid redirect URI" error on Google login

**Solution**:
1. Go back to Google Cloud Console
2. Check "OAuth 2.0 Client ID" settings
3. Verify these 3 URLs are exactly correct:
   - `http://localhost:3000/auth/google/callback`
   - `http://192.168.1.14:3000/auth/google/callback`
   - `http://127.0.0.1:3000/auth/google/callback`
4. No extra spaces, no https:// (must be http://)
5. Port number must be included
6. Click Save
7. Wait 5 minutes for Google to process
8. Try again

### "Connection refused" on mobile

**Solution**:
1. Check your IP address: `ifconfig | grep "inet "`
2. Update [MobileApp/App.js](MobileApp/App.js) line 10:
   ```javascript
   const API_BASE = 'http://YOUR_CORRECT_IP:3000/api';
   ```
3. Restart Expo: Press 'r' in Expo terminal
4. Try again

### "Access Denied" when signing in

**Solution**:
1. Make sure you're using a personal Google account
2. NOT a Google Workspace account
3. Try signing out and back in with different account
4. Check browser console for errors
5. Check terminal logs

### Nothing happens when clicking Google button

**Solution**:
1. Check that Client ID is correct in [MobileApp/App.js](MobileApp/App.js) line 7
2. Check that it doesn't say "YOUR_GOOGLE_CLIENT_ID"
3. Restart Expo: Press 'r' in Expo terminal
4. Check browser/console for errors
5. Make sure both servers are running

### Token expires or "Unauthorized" errors

**Solution**:
- This means JWT token expired
- Just log out and log back in
- Or restart the app

---

## 📋 Final Checklist

### Google Console
- [ ] OAuth Client ID created
- [ ] 3 Redirect URIs added and saved
- [ ] Redirect URIs verified (exact match)

### Code Updates
- [ ] [MobileApp/App.js](MobileApp/App.js) line 7 updated with Client ID
- [ ] [MobileApp/App.js](MobileApp/App.js) line 10 updated with correct IP (if needed)

### Servers Running
- [ ] Terminal 1: Backend (npm start) → port 3000
- [ ] Terminal 2: Expo (npm start) → port 8081
- [ ] Terminal 3: QR Server (optional) → port 3001

### Testing Completed
- [ ] Web OAuth login works ✅
- [ ] Mobile OAuth login works ✅
- [ ] Email/password login still works ✅
- [ ] Both show real user data ✅
- [ ] Dashboard appears correctly ✅

---

## 🎉 Success Criteria

You'll know everything is working when:

1. **Web**: Log in with Google at localhost:3000 and see your real Google name/email on dashboard
2. **Mobile**: Log in with Google in Expo app and see the same real data on dashboard
3. **Both**: Can sign out and sign back in multiple times
4. **Persistence**: Close and reopen app, data persists (user saved in database)
5. **Switching**: Can log in as different user, database updates correctly

---

## 📚 Reference Documents

- **Quick Setup** (start here): [GOOGLE_OAUTH_QUICKSTART.md](GOOGLE_OAUTH_QUICKSTART.md)
- **Detailed Guide**: [GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md)
- **Flow Comparison**: [OAUTH_WEB_VS_MOBILE.md](OAUTH_WEB_VS_MOBILE.md)
- **Implementation Status**: [OAUTH_IMPLEMENTATION_STATUS.md](OAUTH_IMPLEMENTATION_STATUS.md)

---

## 💬 Need Help?

Check these files in order:
1. [GOOGLE_OAUTH_QUICKSTART.md](GOOGLE_OAUTH_QUICKSTART.md) - Quick answers
2. [GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md) - Detailed troubleshooting
3. Check browser console (web) - Press F12
4. Check Expo terminal logs (mobile) - Look for errors

**Most Common Issue**: Redirect URI doesn't match exactly. Double-check Google Console!

---

## 🚀 Ready?

1. ✅ Follow steps in order
2. ✅ Don't skip Google Console setup
3. ✅ Update Client ID in app code
4. ✅ Start both servers
5. ✅ Test on web and mobile
6. ✅ You're done! 🎉

Good luck! 💪
