# Google OAuth Credentials - DO NOT DELETE

## Web OAuth Client (for web login via Passport)
**Client ID:** `YOUR_GOOGLE_WEB_CLIENT_ID.apps.googleusercontent.com`
**Client Secret:** `YOUR_GOOGLE_WEB_CLIENT_SECRET`
**Authorized redirect URIs:**
- http://localhost:3000/auth/google/callback
- https://cvapplyr.com/auth/google/callback

**Scopes:**
- profile
- email
- https://www.googleapis.com/auth/gmail.send
- https://www.googleapis.com/auth/gmail.readonly

---

## iOS OAuth Client (for mobile login via PKCE)
**Client ID:** `YOUR_GOOGLE_IOS_CLIENT_ID.apps.googleusercontent.com`
**Client Secret:** `YOUR_GOOGLE_IOS_CLIENT_SECRET` *(not used in PKCE flow)*

**Redirect URI Scheme:** `com.googleusercontent.apps.YOUR_IOS_CLIENT_ID:/oauth2redirect/google`
**Scopes:**
- profile
- email  
- https://www.googleapis.com/auth/gmail.send
- https://www.googleapis.com/auth/gmail.readonly
- openid

---

## How They're Used

### Web Login Flow:
1. User clicks "Sign in with Google" on cvapplyr.com
2. Passport uses **Web OAuth Client**
3. Google redirects to `/auth/google/callback`
4. `used_pkce = false` stored in database
5. Email sending uses Web Client credentials for token refresh

### Mobile Login Flow:
1. User taps "Sign in with Google" in Expo app
2. PKCE flow with **iOS OAuth Client**
3. Custom scheme redirect to app
4. `used_pkce = true` stored in database
5. Email sending uses iOS Client credentials (no secret) for token refresh

---

## Environment Variables

```env
# Web OAuth Client
GOOGLE_WEB_CLIENT_ID=YOUR_GOOGLE_WEB_CLIENT_ID.apps.googleusercontent.com
GOOGLE_WEB_CLIENT_SECRET=YOUR_GOOGLE_WEB_CLIENT_SECRET

# iOS OAuth Client  
GOOGLE_CLIENT_ID=YOUR_GOOGLE_IOS_CLIENT_ID.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=YOUR_GOOGLE_IOS_CLIENT_SECRET
```

---

**Last Updated:** April 1, 2026
