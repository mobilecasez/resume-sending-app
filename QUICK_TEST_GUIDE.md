# Quick Deployment & Testing Guide

## 🚀 Deployment Steps

### 1. Commit and Push to Railway
```bash
git add .
git commit -m "Add security audit logging and token lifecycle management for CASA Tier 2"
git push origin main
```

### 2. Wait for Railway Deployment
- Check Railway dashboard: https://railway.app
- Watch build logs for: `✅ PostgreSQL migrations completed successfully`
- Server should start without errors

### 3. Verify Environment Variables (Railway Dashboard)
Ensure these are set:
- ✅ `ENCRYPTION_KEY` (48+ characters) - Already verified
- ✅ `GOOGLE_CLIENT_ID`
- ✅ `GOOGLE_CLIENT_SECRET` (or `GOOGLE_WEB_CLIENT_SECRET`)
- ✅ `DATABASE_URL`

---

## ✅ Testing Checklist (Do These 4 Tests Together)

### Test 1: OAuth Token Encryption ✅ (Already Working)
**Goal:** Verify new OAuth tokens are encrypted in database

1. **Perform OAuth login:**
   - Web: Visit https://cvapplyr.com/auth/google
   - Mobile: Login via app with Google

2. **Check database:**
   ```sql
   SELECT id, email, google_access_token FROM users WHERE email = 'your-test-email@gmail.com';
   ```

3. **Expected result:**
   - `google_access_token` should **NOT** start with `ya29.` (encrypted)
   - Should be long encrypted string (100+ chars)
   
4. **Pass criteria:** ✅ Token is encrypted

---

### Test 2: ENCRYPTION_KEY Enforcement ✅ (Already Working)
**Goal:** Verify app fails to start without ENCRYPTION_KEY

1. **Test enforcement (optional - DON'T DO THIS IN PRODUCTION):**
   - In Railway, temporarily remove `ENCRYPTION_KEY` env var
   - Watch logs - app should crash with error
   - Re-add ENCRYPTION_KEY immediately

2. **Expected result:**
   ```
   ❌ CRITICAL: ENCRYPTION_KEY environment variable is required for security
   ❌ OAuth tokens cannot be secured without it
   Process exited with code 1
   ```

3. **Pass criteria:** ✅ App refuses to start without ENCRYPTION_KEY

---

### Test 3: Security Audit Logging 🆕
**Goal:** Verify security events are logged to database

#### 3a. Test Login Logging
1. **Perform email/password login:**
   - Visit https://cvapplyr.com/login
   - Login with valid credentials

2. **Check audit log:**
   ```sql
   SELECT * FROM security_audit_log 
   WHERE event_type = 'LOGIN_SUCCESS' 
   ORDER BY created_at DESC 
   LIMIT 5;
   ```

3. **Expected fields:**
   - `user_id`: Your user ID
   - `event_type`: LOGIN_SUCCESS
   - `event_category`: auth
   - `ip_address`: Your IP
   - `user_agent`: Your browser
   - `success`: true

4. **Pass criteria:** ✅ LOGIN_SUCCESS event logged with IP and user agent

#### 3b. Test Failed Login Logging
1. **Try login with wrong password**

2. **Check audit log:**
   ```sql
   SELECT * FROM security_audit_log 
   WHERE event_type = 'LOGIN_FAILED' 
   ORDER BY created_at DESC 
   LIMIT 5;
   ```

3. **Expected result:**
   - `event_type`: LOGIN_FAILED
   - `success`: false
   - `error_message`: "Invalid password"
   - `details`: `{"email": "...", "reason": "invalid_password"}`

4. **Pass criteria:** ✅ Failed login logged with reason

#### 3c. Test OAuth Logging
1. **Perform Google OAuth login** (new user or re-auth)

2. **Check audit log:**
   ```sql
   SELECT * FROM security_audit_log 
   WHERE event_category = 'oauth' 
   ORDER BY created_at DESC 
   LIMIT 10;
   ```

3. **Expected events:**
   - `OAUTH_TOKEN_GRANTED` - Token received from Google
   - `USER_REGISTERED` - If new user

4. **Expected details (JSONB):**
   ```json
   {
     "provider": "google",
     "flow": "passport" or "mobile_api",
     "has_refresh_token": true,
     "expires_at": "2026-03-15T14:30:00.000Z"
   }
   ```

5. **Pass criteria:** ✅ OAuth events logged with provider and expiration

---

### Test 4: Token Lifecycle Management 🆕
**Goal:** Verify token expiration tracking and auto-refresh

#### 4a. Test Token Expiration Tracking
1. **Perform OAuth login:**
   - Login via Google OAuth

2. **Check token timestamps:**
   ```sql
   SELECT 
       id, 
       email, 
       google_token_issued_at,
       google_token_expires_at,
       EXTRACT(EPOCH FROM (google_token_expires_at - google_token_issued_at)) / 60 as minutes_valid
   FROM users 
   WHERE email = 'your-test-email@gmail.com';
   ```

3. **Expected results:**
   - `google_token_issued_at`: Current timestamp
   - `google_token_expires_at`: ~60 minutes after issued_at
   - `minutes_valid`: ~60

4. **Pass criteria:** ✅ Token expiration set to 1 hour

#### 4b. Test Token Still Valid (Immediate Use)
1. **Immediately after OAuth login, send a test email:**
   - Go to app
   - Send email to any recipient
   - Check Railway logs

2. **Expected log output:**
   ```
   🔧 Creating OAuth2 client
   Token expires at: 2026-03-15T14:30:00.000Z
   (No "Token expired, refreshing..." message)
   Email sent via Gmail API
   ```

3. **Pass criteria:** ✅ Email sent without token refresh

#### 4c. Test Auto-Refresh (After Expiration)
**Option A: Wait 1+ hour (slow but realistic)**
1. Login via OAuth
2. Wait 1+ hours
3. Send email
4. Check logs for "Token expired, refreshing..."

**Option B: Force expiration (fast testing)**
1. Login via OAuth
2. Manually update expiration to the past:
   ```sql
   UPDATE users 
   SET google_token_expires_at = NOW() - INTERVAL '1 hour'
   WHERE email = 'your-test-email@gmail.com';
   ```
3. Send email via app
4. Check logs

3. **Expected log output:**
   ```
   ⏰ Token expired, refreshing...
   🔄 Refreshing Google OAuth token for user 123
   ✅ Token refreshed successfully, expires at: 2026-03-15T15:30:00.000Z
   Email sent via Gmail API
   ```

4. **Check database after refresh:**
   ```sql
   SELECT 
       google_token_issued_at,
       google_token_expires_at 
   FROM users 
   WHERE email = 'your-test-email@gmail.com';
   ```

5. **Expected results:**
   - `google_token_issued_at`: Updated to refresh time
   - `google_token_expires_at`: ~1 hour after new issued_at

6. **Check audit log:**
   ```sql
   SELECT * FROM security_audit_log 
   WHERE event_type = 'OAUTH_TOKEN_GRANTED' 
     AND details->>'provider' = 'google'
   ORDER BY created_at DESC 
   LIMIT 5;
   ```

7. **Pass criteria:** 
   - ✅ Token auto-refreshed
   - ✅ New expiration set
   - ✅ Refresh logged to audit log
   - ✅ Email sent successfully

---

## 📊 Quick Status Check Queries

### Check All Recent Security Events
```sql
SELECT 
    id, 
    user_id, 
    event_type, 
    event_category,
    ip_address,
    success,
    created_at
FROM security_audit_log 
ORDER BY created_at DESC 
LIMIT 20;
```

### Check Token Status for All Users
```sql
SELECT 
    id,
    email,
    oauth_provider,
    google_token_expires_at,
    CASE 
        WHEN google_token_expires_at IS NULL THEN 'NO DATA'
        WHEN google_token_expires_at < NOW() THEN 'EXPIRED'
        ELSE 'VALID'
    END as status,
    CASE 
        WHEN google_token_expires_at > NOW() 
        THEN ROUND(EXTRACT(EPOCH FROM (google_token_expires_at - NOW())) / 60)
        ELSE 0
    END as minutes_remaining
FROM users 
WHERE google_access_token IS NOT NULL;
```

### Count Events by Type (Last 24 Hours)
```sql
SELECT 
    event_type, 
    COUNT(*) as count,
    SUM(CASE WHEN success THEN 1 ELSE 0 END) as successful,
    SUM(CASE WHEN NOT success THEN 1 ELSE 0 END) as failed
FROM security_audit_log 
WHERE created_at >= NOW() - INTERVAL '24 hours'
GROUP BY event_type
ORDER BY count DESC;
```

---

## ✅ Success Criteria Summary

All 4 features should pass:

1. **OAuth Encryption:** ✅
   - New tokens encrypted (not starting with `ya29.`)
   - Old tokens still work (backward compatible)

2. **ENCRYPTION_KEY Enforcement:** ✅
   - App exits if ENCRYPTION_KEY not set
   - Clear error message in logs

3. **Security Audit Logging:** ✅
   - Login events logged (success and failure)
   - OAuth events logged (token grants, user registration)
   - IP addresses and user agents captured
   - JSONB details stored correctly

4. **Token Lifecycle Management:** ✅
   - Token expiration tracked in database
   - Expiration set correctly (~1 hour from issue)
   - Auto-refresh works when token expired
   - Refresh logged to audit table
   - Email sending succeeds with refreshed token

---

## 🐛 Common Issues & Solutions

### Issue: Migrations didn't run
**Symptom:** `security_audit_log` table doesn't exist  
**Solution:** Check Railway logs for migration errors, restart app

### Issue: Token refresh fails
**Symptom:** "Failed to refresh Google token" in logs  
**Solution:** 
- Check `google_refresh_token` exists in DB
- Verify GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are correct
- Re-authenticate via OAuth to get new refresh token

### Issue: Audit log empty
**Symptom:** No events in `security_audit_log`  
**Solution:** 
- Ensure table was created (check `\d security_audit_log`)
- Check Railway logs for "Security event logged" messages
- Try login/OAuth again

### Issue: Token never expires
**Symptom:** `google_token_expires_at` is NULL  
**Solution:** 
- This is old data - re-authenticate via OAuth
- New logins will have expiration tracking

---

## 📝 Next Steps After Testing

Once all 4 tests pass:
1. ✅ Mark this batch complete
2. 📊 Monitor for 24 hours
3. 🔄 Move to next CASA requirements:
   - Rate limiting
   - Input validation
   - Account deletion
   - Data export

---

**Ready to deploy?**
```bash
git add .
git commit -m "Add security audit logging and token lifecycle - CASA Tier 2 compliance"
git push origin main
```

Then start testing! 🚀
