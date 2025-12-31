# 400 Error Troubleshooting Guide

## What the 400 Error Means

**HTTP 400 = Bad Request** from the server. In your case, it means:
```
The backend received a POST request to /api/auth/google
but the request body is missing or malformed
(specifically: no accessToken or malformed JSON)
```

## Root Cause Analysis

The 400 error is returned by this line in server.js:
```javascript
if (!accessToken) {
    return res.status(400).json({ error: 'Access token is required' });
}
```

This means `req.body.accessToken` is **undefined** or **null**.

## Why This Happens

### Possible Causes:

1. **OAuth token not captured properly**
   - expo-auth-session isn't returning a valid token
   - Google account picker is being cancelled
   - Token is undefined when passed to function

2. **Request body not being sent**
   - JSON serialization issue
   - Network request not actually being sent

3. **Endpoint mismatch**
   - Wrong URL being called
   - Protocol/host/port mismatch

## How to Debug (Step by Step)

### Step 1: Check Expo Logs

When you get the 400 error:
1. Look at the Expo terminal output
2. Find these log lines I added:
   ```
   Google Auth Response - Token length: XXX
   API Base: http://192.168.1.14:3000/api
   Backend Response Status: 400
   Backend Response Data: {"error":"Access token is required"}
   ```

### Step 2: Verify Token is Being Captured

Check if the token length is greater than 0:
```
✅ Good: Token length: 1500
❌ Bad:  Token length: 0
❌ Bad:  Token length: undefined
```

If token length is 0 or undefined, the problem is with expo-auth-session.

### Step 3: Verify API Base URL

Check the "API Base" log matches your IP:
```
✅ Good: http://192.168.1.14:3000/api
❌ Bad:  http://localhost:3000/api (won't work for mobile)
❌ Bad:  undefined or malformed
```

### Step 4: Test the Endpoint Manually

Run this command in terminal:
```bash
curl -X POST http://192.168.1.14:3000/api/auth/google \
  -H "Content-Type: application/json" \
  -d '{"accessToken": "test_token_12345"}'
```

Expected responses:
```
✅ 401: {"error":"Failed to get user info from Google"...}
   (Good - endpoint works, token format correct)

❌ 400: {"error":"Access token is required"}
   (Bad - request format wrong)
```

## Common Solutions

### Solution 1: Check Your Client ID

Open MobileApp/App.js line 7:
```javascript
// ❌ Wrong (placeholder)
const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';

// ✅ Correct (actual ID)
const GOOGLE_CLIENT_ID = '123456789.apps.googleusercontent.com';
```

If you're still using the placeholder, the account picker won't work and no token will be generated.

### Solution 2: Verify Google Console Setup

In Google Cloud Console, check:
1. OAuth 2.0 Client ID is created ✅
2. Redirect URIs include:
   - `http://192.168.1.14:3000/auth/google/callback`
   - `http://localhost:3000/auth/google/callback`
3. Your Client ID is correct and matches your app code

### Solution 3: Test with Real Token

If expo-auth-session isn't giving you a token, try this temporary test:

Open MobileApp/App.js and modify handleGoogleLogin:
```javascript
const handleGoogleLogin = async () => {
  try {
    // For testing: use a hardcoded test token
    const testToken = 'test_token_for_debugging';
    console.log('Using TEST token:', testToken);
    await handleGoogleAuthResponse(testToken);
  } catch (err) {
    setError('Google login failed: ' + err.message);
  }
};
```

This will tell you if the issue is:
- **Issue with OAuth token capture** (test token fails same way)
- **Issue with token verification** (test token gets 401, which is expected)
- **Endpoint working correctly** (test token goes through)

### Solution 4: Force Reload the App

```bash
# Kill the current Expo process
pkill -f "npm start"

# Clear Watchman cache
watchman watch-del '/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app'

# Restart Expo with fresh cache
cd MobileApp && npm start -- --reset-cache
```

Then reload the app (press 'r' in Expo terminal).

## Step-by-Step Debugging

### When You Click "Sign in with Google":

1. **Check Expo Logs** for:
   ```
   Google Auth Response - Token length: [should be > 100]
   API Base: http://192.168.1.14:3000/api
   Backend Response Status: [should be 400, 401, or 200]
   ```

2. **If token length is 0**:
   - Problem is with Google OAuth setup
   - Check Client ID is correct
   - Check Google Console has your redirect URI
   - Make sure you're not being redirected to wrong place

3. **If token length is > 100 but status is 400**:
   - Problem is with how token is being sent to backend
   - Token might be getting lost in transit
   - Check API_BASE is correct

4. **If status is 401**:
   - Token is being sent correctly! ✅
   - Google API is rejecting the token
   - Check token is really from Google
   - Make sure token isn't expired

## Backend Debug Logs

When you make a request, the backend logs:
```
Google OAuth Request Body: { accessToken: '...' }
```

- If you see `{}`: Body is empty (JSON parsing issue)
- If you see `{ accessToken: '...' }`: Body is correct! ✅
- If nothing prints: Request isn't reaching endpoint

## Quick Checklist

- [ ] GOOGLE_CLIENT_ID is set (not placeholder) in MobileApp/App.js
- [ ] Google Console has your 3 redirect URIs
- [ ] Backend is running: `lsof -i :3000`
- [ ] API_BASE is `http://192.168.1.14:3000/api` (not localhost)
- [ ] Expo dev server is running
- [ ] You're clicking "Sign in with Google" button (not "Sign In" button)
- [ ] Account picker appears (proves OAuth request reaching Google)
- [ ] You select your Google account
- [ ] Check Expo terminal logs for token info

## If You're Still Stuck

1. **Send me the Expo logs** when you see the 400 error
2. **Tell me**:
   - What do the logs show for "Token length"?
   - What is your actual API_BASE URL?
   - What Client ID are you using (first 10 characters)?
   - Can you see the account picker?

## Testing Endpoint Without OAuth

Run this to verify endpoint works:
```bash
# This should return 401 (invalid token, but endpoint works)
curl -X POST http://192.168.1.14:3000/api/auth/google \
  -H "Content-Type: application/json" \
  -d '{"accessToken":"fake_token"}'

# Expected: {"error":"Failed to get user info from Google",...}
# If you get 400 instead: endpoint not receiving body correctly
```

## Common Error Messages Explained

| Error | Cause | Fix |
|-------|-------|-----|
| 400: "Access token is required" | Token is undefined/null | Check token capture, Client ID |
| 401: "Failed to get user info from Google" | Token format wrong/invalid | Token might be fake, check if real |
| 500: "Database error" | User creation failed | Check database, try different email |
| Network error, no response | Backend not running/unreachable | Start backend, check IP |

---

**Need help?** Check the Expo terminal logs first - they'll show exactly what's being sent!
