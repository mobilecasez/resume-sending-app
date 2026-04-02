# API Endpoints Documentation

**Base URL (Development):** `http://192.168.1.14:3000`

All API routes are mounted under the `/api` prefix in `server.js`:
```javascript
app.use('/api', emailRoutes);       // Line 2880
app.use('/api', creditsRoutes);     // Line 2879
app.use('/auth', authRoutes);       // Line 2875
app.use('/users', userDataRoutes);  // Line 2877
```

## Authentication Endpoints
**Mount Point:** `/auth`

### Register
- **Path:** `/auth/register`
- **Method:** POST
- **Auth:** None required
- **Body:** `{ fullName, email, password }`

### Login
- **Path:** `/auth/login`
- **Method:** POST
- **Auth:** None required
- **Body:** `{ email, password }`
- **Returns:** `{ token, user: { id, fullName, email, provider } }`

### Google OAuth (Mobile)
- **Path:** `/auth/google`
- **Method:** POST
- **Auth:** None required
- **Body:** `{ idToken }`
- **Returns:** `{ token, user: { id, fullName, email, provider: 'google' } }`

### Microsoft OAuth (Mobile)
- **Path:** `/auth/microsoft`
- **Method:** POST
- **Auth:** None required
- **Body:** `{ accessToken }`
- **Returns:** `{ token, user: { id, fullName, email, provider: 'microsoft' } }`

### Change Password
- **Path:** `/auth/change-password`
- **Method:** POST
- **Auth:** Bearer token required
- **Body:** `{ oldPassword, newPassword }`

---

## Email Endpoints
**Mount Point:** `/api`

All email routes are defined in `server/routes/emailRoutes.js` without the `/email/` prefix.

### Send Applications (Bulk)
- **Path:** `/api/send-applications`
- **Method:** POST
- **Auth:** Bearer token required
- **Mobile App:** `${API_BASE}/send-applications`
- **Body:** 
  ```json
  {
    "recipients": [
      { "companyName", "companyEmail", "jobTitle", "location" }
    ],
    "email": { "subject", "message" },
    "resume": { filename, path, type },
    "coverLetter": { filename, path, type }
  }
  ```
- **Returns:** `{ success: true, results: [...] }`

### Send Single Application
- **Path:** `/api/send-single-application`
- **Method:** POST
- **Auth:** Bearer token required
- **Mobile App:** `${API_BASE}/send-single-application`
- **Body:** Same as bulk but single recipient
- **Returns:** `{ success: true, result: {...} }`

### Check Email Replies ⭐ NEW
- **Path:** `/api/check-replies`
- **Method:** POST
- **Auth:** Bearer token required
- **Mobile App:** `${API_BASE}/check-replies`
- **Requirements:** 
  - User must have OAuth account (Google or Microsoft)
  - Must have valid OAuth access token in database
- **Returns:** 
  ```json
  {
    "success": true,
    "repliesFound": 2,
    "updatedApplications": [
      { "id": 1, "companyName": "...", "replyDate": "..." }
    ]
  }
  ```
- **How It Works:**
  1. Fetches last 50 emails from user's inbox (Microsoft Graph or Gmail API)
  2. Matches sender email with application recipients
  3. Validates email received after application sent date
  4. Updates application_history table with reply status
  5. Returns count and list of applications with replies

---

## User Data Endpoints
**Mount Point:** `/users`

### Save Recipients
- **Path:** `/users/recipients`
- **Method:** POST
- **Auth:** Bearer token required

### Get Recipients
- **Path:** `/users/recipients`
- **Method:** GET
- **Auth:** Bearer token required

### Get Application History
- **Path:** `/users/application-history`
- **Method:** GET
- **Auth:** Bearer token required
- **Returns:** Array of sent applications with reply status

### Update Counters
- **Path:** `/users/counters`
- **Method:** POST
- **Auth:** Bearer token required
- **Body:** `{ generated, sent }`

---

## Mobile App Configuration

**API_BASE constant in `MobileApp/App.js`:**
```javascript
const API_BASE = 'http://192.168.1.14:3000/api';
```

**Important URL Construction Rules:**
1. ✅ **Correct:** `${API_BASE}/check-replies`
   - Resolves to: `http://192.168.1.14:3000/api/check-replies`
   
2. ❌ **Wrong:** `${API_BASE}/email/check-replies`
   - Resolves to: `http://192.168.1.14:3000/api/email/check-replies`
   - Results in 404 error

3. **Pattern:** Always use `${API_BASE}/{route-name}` where route-name matches the router definition in the routes file

---

## Email Reply Detection Implementation

### Backend Flow
1. User taps "Check Replies" button in mobile app
2. App calls `/api/check-replies` with Bearer token
3. Backend validates user has OAuth account
4. Backend fetches user's OAuth access token from database
5. **For Microsoft:**
   - Calls `https://graph.microsoft.com/v1.0/me/messages`
   - Filters: top 50, ordered by receivedDateTime desc
6. **For Gmail:**
   - Calls Gmail API `users.me.messages.list`
   - Query: `is:unread newer_than:30d`
7. Backend matches emails with pending applications:
   - Sender email = company email
   - Email received after application sent
   - Within 30-day window
8. Updates database: `UPDATE application_history SET reply_received = 1, reply_date = ?`
9. Returns summary to mobile app

### Frontend Integration
**Location:** `MobileApp/App.js` lines 2905-2951

**Button Visibility:**
- Only shown for OAuth users (Google or Microsoft)
- Only shown when user has application history
- Shows "Checking..." state during API call

**Error Handling:**
- Logs response status and headers
- Extracts response text before JSON parsing
- Shows specific error message if parsing fails
- Displays user-friendly alert with error details

---

## Troubleshooting

### 404 Error on `/check-replies`
**Symptoms:** 
- Error: "Server returned invalid response. Status: 404"
- Response contains HTML instead of JSON

**Root Cause:** Wrong API path in mobile app

**Fix:** Ensure mobile app calls `${API_BASE}/check-replies`, not `${API_BASE}/email/check-replies`

### JSON Parse Error
**Symptoms:**
- "SyntaxError: JSON Parse error: Unexpected character: <"

**Root Cause:** Server returning HTML error page (usually 404 or 500)

**Debugging:**
1. Check response status code
2. Log response.text() before parsing
3. Verify API endpoint exists in routes file
4. Check server logs for errors

### OAuth Token Expired
**Symptoms:**
- 401 Unauthorized error from Microsoft/Gmail API
- Error: "Access token expired"

**Fix:** Implement token refresh flow (future enhancement)

---

## Testing Checklist

### Email Reply Detection
- [ ] Backend running on port 3000
- [ ] Expo running on port 8081
- [ ] User logged in with Google or Microsoft OAuth
- [ ] User has sent applications in history
- [ ] Check Replies button visible in Recent Applications
- [ ] Tapping button shows "Checking..." state
- [ ] No 404 error in console
- [ ] Alert shows reply count or "No new replies"
- [ ] Application status updates if reply found
- [ ] Reply date populated correctly

### End-to-End Test
1. Send test application to known email
2. Reply to application from recipient's email
3. Wait 1 minute for email to arrive
4. Tap Check Replies button
5. Verify reply detected and status updated

---

## Security Notes

1. **OAuth Tokens:** Stored encrypted in database
2. **API Authentication:** All endpoints require valid JWT Bearer token
3. **Email Access:** Limited to user's own inbox and sent items
4. **Rate Limiting:** Consider implementing for email API calls
5. **Token Refresh:** Implement automatic refresh for expired OAuth tokens

---

## Future Enhancements

1. **Automatic Reply Checking:** Background job to check periodically
2. **Reply Content Parsing:** Extract reply content and sentiment
3. **Push Notifications:** Notify users when replies received
4. **Reply Threading:** Match multi-message conversations
5. **OAuth Token Refresh:** Auto-refresh expired tokens
6. **Webhook Integration:** Real-time reply detection via webhooks
