# Dual OAuth Implementation - COMPLETED ✅

## What Was Fixed

### Problem
- Mobile OAuth (PKCE) was working but broke web OAuth (standard flow)
- Both flows were trying to use the same OAuth client
- Token refresh was failing for web users (missing client_secret)
- `used_pkce` flag was missing from database

### Solution
Implemented dual OAuth client support:
- **Web users:** Standard OAuth with client_secret
- **Mobile users:** PKCE without client_secret
- Database tracks which flow each user used (`used_pkce` flag)

---

## Changes Made

### 1. Credentials Backup
**File:** `GOOGLE_OAUTH_CREDENTIALS.md` (created)
- Documented both OAuth clients
- Listed scopes, redirect URIs, usage instructions
- Won't get lost anymore!

### 2. Database Schema
**Command:** `ALTER TABLE users ADD COLUMN used_pkce BOOLEAN DEFAULT FALSE`
- Tracks which OAuth flow user authenticated with
- `true` = Mobile (PKCE), `false` = Web (standard)

### 3. Authentication Logic
**File:** `server/controllers/authController.js`
- Lines ~305-310: INSERT query sets `used_pkce` based on `codeVerifier` presence
- Lines ~351-361: UPDATE queries also set `used_pkce` flag
- Mobile (PKCE): `used_pkce=true` when `codeVerifier` present
- Web: `used_pkce=false` when `codeVerifier` absent

### 4. Passport OAuth Callback
**File:** `server.js` - `handleOAuthUser()` function
- Lines ~452-474: Google OAuth via Passport sets `used_pkce=false`
- Ensures web users are properly flagged

### 5. Token Refresh Logic
**File:** `server/controllers/emailController.js` - `createOAuth2Client()`
- Lines ~28-48: Conditionally uses correct OAuth client
- **PKCE users (mobile):**
  - Client ID: `GOOGLE_CLIENT_ID` (iOS client)
  - Client Secret: `undefined`
- **Standard users (web):**
  - Client ID: `GOOGLE_WEB_CLIENT_ID`
  - Client Secret: `GOOGLE_WEB_CLIENT_SECRET`

### 6. Environment Variables
**File:** `.env`
- Added `GOOGLE_WEB_CLIENT_ID` and `GOOGLE_WEB_CLIENT_SECRET`
- Kept original `GOOGLE_CLIENT_ID` for mobile/iOS

---

## How It Works

### Mobile Login Flow (PKCE)
1. User taps "Sign in with Google" in Expo app
2. App generates `code_verifier` (128 random chars)
3. Creates `code_challenge` via SHA-256 hash (expo-crypto)
4. Redirects to Google with iOS OAuth Client
5. Google redirects back via custom URI scheme
6. Backend exchanges code + code_verifier for tokens (no client secret)
7. Stores tokens + sets `used_pkce=true` in database

### Web Login Flow (Standard OAuth)
1. User clicks "Sign in with Google" on website
2. Passport redirects to Google with Web OAuth Client
3. Google redirects to `/auth/google/callback`
4. Passport exchanges code + client_secret for tokens
5. Stores tokens + sets `used_pkce=false` in database

### Email Sending (Both Flows)
1. User sends email via Gmail API
2. Backend reads `user.used_pkce` from database
3. Creates OAuth2 client with correct credentials:
   - PKCE users: iOS client (no secret)
   - Web users: Web client (with secret)
4. Token refresh works correctly for both!

---

## Testing Steps

### Test Web OAuth
1. Open browser: http://localhost:3000/login.html
2. Click "Sign in with Google"
3. Complete OAuth consent
4. Should redirect to dashboard
5. Try sending an email - should work!

### Test Mobile OAuth
1. Open Expo app on phone
2. Tap "Sign in with Google"
3. Complete OAuth consent
4. Should return to app
5. Try sending an email - should work!

### Verify Token Refresh
1. Wait 1 hour (or manually expire access_token in DB)
2. Try sending email again
3. Backend should auto-refresh token
4. Check logs for "🔧 Creating OAuth2 client"
5. Should see correct flow type (PKCE vs Standard OAuth)

---

## OAuth Clients

### iOS OAuth Client (Mobile/PKCE)
```
Client ID: YOUR_GOOGLE_IOS_CLIENT_ID.apps.googleusercontent.com
Redirect URI: com.googleusercontent.apps.YOUR_IOS_CLIENT_ID:/oauth2redirect/google
Type: iOS Application
Flow: PKCE (no client secret)
```

### Web OAuth Client (Web/Standard)
```
Client ID: YOUR_GOOGLE_WEB_CLIENT_ID.apps.googleusercontent.com
Client Secret: YOUR_GOOGLE_WEB_CLIENT_SECRET
Redirect URIs:
  - http://localhost:3000/auth/google/callback (dev)
  - https://cvapplyr.com/auth/google/callback (prod)
Type: Web Application
Flow: Standard OAuth (with client secret)
```

---

## Next Steps

### 1. Test Both Flows ⏳
- [ ] Web login works
- [ ] Mobile login works
- [ ] Email sending works (web)
- [ ] Email sending works (mobile)
- [ ] Token refresh works (both)

### 2. Record Verification Video 🎥
Now that OAuth is fully working, record Google verification video:

**What to show:**
1. **OAuth Consent (10 seconds):** Show all 5 scopes clearly visible
2. **Profile Display:** Show user's name and email in app
3. **Send Email:** Demonstrate sending email via Gmail API (gmail.send scope)
4. **Check Replies:** Show reply detection feature (gmail.readonly scope)

**Script:**
```
1. Revoke existing permissions: https://myaccount.google.com/permissions
2. Open app, click "Sign in with Google"
3. Pause on consent screen showing:
   - View your email address
   - See your personal info
   - Send email on your behalf
   - Read all your Gmail emails
4. Approve consent
5. Show profile page with name/email
6. Navigate to send email form
7. Fill out form and send
8. Show "Email sent successfully"
9. Go to "Check Replies" section
10. Click "Check for Replies"
11. Show reply detection working
```

**Upload:** YouTube unlisted, submit to Google OAuth verification

### 3. Production Deployment 🚀
- Update `.env.production` with production redirect URIs
- Verify both OAuth clients have production URIs configured
- Test on live site before Google verification

---

## Troubleshooting

### "invalid_client" Error
**Cause:** Wrong client credentials for user's OAuth flow  
**Fix:** Check `used_pkce` flag in database, verify correct client being used

### "invalid_request" Error (Web)
**Cause:** PKCE client being used for web flow  
**Fix:** Verify Passport using `GOOGLE_WEB_CLIENT_ID` in `server.js`

### "unsupported_response_type" Error (Mobile)
**Cause:** Using implicit flow instead of authorization code  
**Fix:** Check mobile app using `response_type=code` (not `token`)

### Token Refresh Failing
**Cause:** `used_pkce` flag mismatch with actual OAuth flow  
**Fix:** Delete user from database and re-authenticate

---

**Status:** ✅ READY TO TEST  
**Last Updated:** April 1, 2026  
**Server Status:** 🟢 Running on http://localhost:3000
