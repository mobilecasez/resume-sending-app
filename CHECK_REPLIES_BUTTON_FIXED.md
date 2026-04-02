# Check for Replies Button - FIXED ✅

## Issue
The "Check for Replies" button was not showing on the web dashboard for OAuth users (Google or Microsoft).

## Root Cause
1. **Feature didn't exist on web** - Button only existed in mobile app
2. **Missing provider field** - OAuth callback wasn't including provider info in userData, so frontend couldn't detect OAuth users

---

## Changes Made

### 1. Added Button to Web Dashboard
**File:** [public/index.html](public/index.html)

Added "Check for Replies" button in the Recent Applications section:
- Button shows 📬 icon with "Check for Replies" text
- Hidden by default, only shown for OAuth users
- Displays status messages after checking (success/error)
- Reloads application history when replies are found

### 2. Added JavaScript Function
**File:** [public/index.html](public/index.html)

Added `checkForReplies()` function:
- Calls `/api/check-replies` endpoint
- Shows loading state while checking
- Displays success/error messages
- Updates application history if replies found
- Works for both Google and Microsoft OAuth users

### 3. Updated OAuth Callbacks
**File:** [server/controllers/authController.js](server/controllers/authController.js)

**Google OAuth:**
```javascript
const userData = {
    id: req.user.id,
    fullName: req.user.full_name,
    email: req.user.email,
    provider: 'google',          // ✅ ADDED
    oauth_provider: 'google'     // ✅ ADDED
};
```

**Microsoft OAuth:**
```javascript
const userData = {
    id: req.user.id,
    fullName: req.user.full_name,
    email: req.user.email,
    provider: 'microsoft',       // ✅ ADDED
    oauth_provider: 'microsoft'  // ✅ ADDED
};
```

### 4. Button Visibility Logic
**File:** [public/index.html](public/index.html) - `loadDashboardStatistics()` function

```javascript
// Show "Check for Replies" button for OAuth users (Google or Microsoft)
const provider = userData.provider || userData.oauth_provider;

if (provider === 'google' || provider === 'microsoft') {
    console.log('✅ OAuth user detected - showing Check for Replies button');
    document.getElementById('checkRepliesContainer').style.display = 'block';
} else {
    console.log('ℹ️ Non-OAuth user - hiding Check for Replies button');
    document.getElementById('checkRepliesContainer').style.display = 'none';
}
```

---

## How It Works

### For OAuth Users (Google or Microsoft)
1. User logs in via Google or Microsoft OAuth
2. Server stores `provider: 'google'` or `provider: 'microsoft'` in localStorage
3. Dashboard loads and detects OAuth provider
4. "Check for Replies" button becomes visible
5. User clicks button → calls `/api/check-replies` endpoint
6. Backend checks Gmail/Outlook for replies to sent applications
7. Results displayed with count of replies found

### For Non-OAuth Users (Email/Password)
1. User logs in with email/password
2. No provider field in userData
3. "Check for Replies" button stays hidden (not available for SMTP users)

---

## Testing Steps

### Test with Google OAuth ✅
1. **Logout** if currently logged in
2. Go to: http://localhost:3000/login.html
3. Click **"Sign in with Google"**
4. Complete OAuth consent
5. Should redirect to dashboard
6. **Verify:** "Check for Replies" button is visible in Recent Applications section
7. Click **"Check for Replies"**
8. Should see loading state, then success message

### Test with Microsoft OAuth ✅
1. **Logout** if currently logged in
2. Go to: http://localhost:3000/login.html
3. Click **"Sign in with Microsoft"**
4. Complete OAuth consent
5. Should redirect to dashboard
6. **Verify:** "Check for Replies" button is visible in Recent Applications section
7. Click **"Check for Replies"**
8. Should see loading state, then success message

### Test with Email/Password (Should NOT show button)
1. **Logout** if currently logged in
2. Go to: http://localhost:3000/login.html
3. Login with email/password
4. **Verify:** "Check for Replies" button is **NOT** visible
5. This is correct - SMTP users don't have reply checking capability

---

## Button States

### Initial State (OAuth users only)
```
📬 Check for Replies
```

### Loading State
```
⏳ Checking...
```

### Success State
```
✓ Check Complete
2 replies found
```

### Error State
```
✗ Error
Failed to check for replies
```

---

## API Endpoint Used

**Endpoint:** `POST /api/check-replies`  
**Headers:** `Authorization: Bearer <token>`  
**Response:**
```json
{
  "success": true,
  "replies": [
    {
      "company": "Example Corp",
      "subject": "Re: Job Application",
      "from": "hr@example.com",
      "receivedAt": "2026-04-01T10:30:00Z"
    }
  ]
}
```

---

## Browser Console Logs

When OAuth user logs in, you should see:
```
📊 Loading dashboard statistics...
👤 Setting welcome message for: John Doe
🔐 User OAuth provider: google
✅ OAuth user detected - showing Check for Replies button
```

When non-OAuth user logs in, you should see:
```
📊 Loading dashboard statistics...
👤 Setting welcome message for: Jane Smith
🔐 User OAuth provider: undefined
ℹ️ Non-OAuth user - hiding Check for Replies button
```

---

## Status
✅ **READY TO TEST**

**Next Steps:**
1. Logout from current session
2. Login with Google OAuth
3. Verify "Check for Replies" button is visible
4. Click button and verify it works
5. Repeat test with Microsoft OAuth

**Server Status:** 🟢 Running on http://localhost:3000  
**Last Updated:** April 1, 2026
