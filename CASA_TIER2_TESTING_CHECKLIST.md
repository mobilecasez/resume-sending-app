# CASA Tier 2 Security Testing Checklist
**Date:** Created for Google CASA Tier 2 compliance  
**Deadline:** July 10, 2026  
**Purpose:** Verify all 8 CASA Tier 2 security requirements are working correctly

---

## ✅ Pre-Testing Setup

- [ ] **Server Restart Required**: Kill old server and restart to load new security code
  ```bash
  pkill -f "node.*server.js" || pkill -f "node.*index.js"
  npm start
  ```

- [ ] **Environment Variables**: Verify ENCRYPTION_KEY is set (48+ characters)
  ```bash
  echo $ENCRYPTION_KEY
  # Should show a long random string (48+ chars)
  ```

- [ ] **Database Connection**: Confirm connection to Railway PostgreSQL
  ```bash
  node check-db-direct.js
  ```

---

## 1️⃣ OAuth Token Encryption (At Rest) ✅

### Web Testing
- [ ] **Fresh Google OAuth Login**
  - Navigate to `/login.html`
  - Click "Continue with Google"
  - Complete OAuth flow
  - Verify redirect to dashboard

- [ ] **Database Verification**
  ```sql
  -- Check token is encrypted (starts with "U2FsdGVkX1")
  SELECT 
    id, 
    email,
    CASE 
      WHEN google_access_token LIKE 'U2FsdGVkX1%' THEN 'ENCRYPTED ✅'
      WHEN google_access_token IS NOT NULL THEN 'PLAIN TEXT ❌'
      ELSE 'NO TOKEN'
    END as token_status,
    LENGTH(google_access_token) as token_length
  FROM users 
  WHERE email = 'YOUR_TEST_EMAIL@gmail.com';
  ```

- [ ] **Expected Result**: Token should start with "U2FsdGVkX1" and be 200-400 chars long

### Mobile Testing
- [ ] **Mobile OAuth Login**
  - Open mobile app
  - Click "Continue with Google"
  - Complete OAuth flow
  - Verify JWT token received
  - Check database for encrypted token

---

## 2️⃣ ENCRYPTION_KEY Enforcement ✅

- [ ] **Test Without Key**
  ```bash
  # Remove ENCRYPTION_KEY temporarily
  unset ENCRYPTION_KEY
  npm start
  ```
  - **Expected**: Server should exit immediately with error message
  - **Error Message**: "ENCRYPTION_KEY must be set and at least 32 characters"

- [ ] **Test With Short Key**
  ```bash
  ENCRYPTION_KEY="short" npm start
  ```
  - **Expected**: Server should exit with same error

- [ ] **Restore Key**
  ```bash
  # Set proper key again
  export ENCRYPTION_KEY="your-48-char-key-here"
  npm start
  ```
  - **Expected**: Server starts successfully

---

## 3️⃣ Security Audit Logging ✅

### Test User Registration
- [ ] **Register New User**
  - Email: `test-audit-{timestamp}@example.com`
  - Full Name: `Test User`
  - Password: `Test123!`
  
- [ ] **Verify Audit Log**
  ```sql
  SELECT 
    event_type, 
    event_category, 
    user_id, 
    success,
    ip_address,
    created_at
  FROM security_audit_log 
  WHERE event_type = 'USER_REGISTERED'
  ORDER BY created_at DESC 
  LIMIT 1;
  ```

### Test Login Events
- [ ] **Successful Login**
  ```sql
  SELECT * FROM security_audit_log 
  WHERE event_type = 'LOGIN_SUCCESS' 
  AND user_id = YOUR_USER_ID
  ORDER BY created_at DESC LIMIT 1;
  ```

- [ ] **Failed Login** (wrong password)
  ```sql
  SELECT * FROM security_audit_log 
  WHERE event_type = 'LOGIN_FAILED' 
  ORDER BY created_at DESC LIMIT 1;
  ```

### Test OAuth Events
- [ ] **OAuth Login**
  ```sql
  SELECT * FROM security_audit_log 
  WHERE event_type = 'OAUTH_TOKEN_GRANTED' 
  AND user_id = YOUR_USER_ID
  ORDER BY created_at DESC LIMIT 1;
  ```

- [ ] **OAuth Token Refresh**
  - Wait for token to expire (or manually expire it)
  - Send an email to trigger refresh
  ```sql
  SELECT * FROM security_audit_log 
  WHERE event_type = 'OAUTH_TOKEN_REFRESHED' 
  AND user_id = YOUR_USER_ID
  ORDER BY created_at DESC LIMIT 1;
  ```

### All Event Types to Verify
- [ ] `USER_REGISTERED`
- [ ] `LOGIN_SUCCESS`
- [ ] `LOGIN_FAILED`
- [ ] `OAUTH_TOKEN_GRANTED`
- [ ] `OAUTH_TOKEN_REFRESHED`
- [ ] `OAUTH_TOKEN_REVOKED`
- [ ] `PASSWORD_CHANGED`
- [ ] `ACCOUNT_DELETED`
- [ ] `DATA_EXPORTED`
- [ ] `RATE_LIMIT_EXCEEDED`
- [ ] `VALIDATION_FAILED`

---

## 4️⃣ Token Lifecycle Management ✅

### Test Token Expiration Tracking
- [ ] **Fresh OAuth Login**
  ```sql
  SELECT 
    email,
    google_token_issued_at,
    google_token_expires_at,
    ROUND((EXTRACT(EPOCH FROM google_token_expires_at - NOW()) / 60)) as minutes_remaining
  FROM users 
  WHERE email = 'YOUR_TEST_EMAIL@gmail.com';
  ```
  
- [ ] **Expected**: `minutes_remaining` should be close to 60 (Google tokens expire in 1 hour)

### Test Auto-Refresh
- [ ] **Send Email Before Expiration**
  - Send test email when `minutes_remaining` < 5
  - Check server logs for: `🔄 [OAUTH] Token expiring soon, refreshing...`
  
- [ ] **Verify New Token**
  ```sql
  SELECT 
    google_token_issued_at,
    google_token_expires_at
  FROM users 
  WHERE email = 'YOUR_TEST_EMAIL@gmail.com';
  ```
  - **Expected**: `google_token_issued_at` should be updated to current time
  - **Expected**: `google_token_expires_at` should be ~60 minutes in future

### Test Manual Token Refresh
```bash
# Direct test of refresh function
node -e "
const axios = require('axios');
axios.post('http://localhost:3000/api/auth/refresh-token', {}, {
  headers: { 'Authorization': 'Bearer YOUR_JWT_TOKEN' }
}).then(r => console.log(r.data));
"
```

---

## 5️⃣ Rate Limiting ✅ NEW

### Test Auth Endpoint Rate Limiting (5 requests / 15 min)
- [ ] **Test Registration Rate Limit**
  ```bash
  # Attempt 6 registrations in quick succession
  for i in {1..6}; do
    curl -X POST http://localhost:3000/api/auth/register \
      -H "Content-Type: application/json" \
      -d '{"fullName":"Test '$i'","email":"test'$i'@example.com","password":"Test123!"}' \
      -w "\n%{http_code}\n"
  done
  ```
  - **Expected**: First 5 should succeed (201), 6th should fail with 429

- [ ] **Test Login Rate Limit**
  ```bash
  # Attempt 6 logins with wrong password
  for i in {1..6}; do
    curl -X POST http://localhost:3000/api/auth/login \
      -H "Content-Type: application/json" \
      -d '{"email":"test@example.com","password":"WrongPassword"}' \
      -w "\n%{http_code}\n"
  done
  ```
  - **Expected**: 6th attempt should return 429 (Too Many Requests)

### Test API Rate Limiting (100 requests / 15 min)
- [ ] **Rapid API Calls**
  ```bash
  # Test with authenticated endpoint
  for i in {1..105}; do
    curl http://localhost:3000/api/users/profile \
      -H "Authorization: Bearer YOUR_JWT_TOKEN" \
      -w "%{http_code} " 
    echo ""
  done | tail -10
  ```
  - **Expected**: Requests 101-105 should return 429

### Test Sensitive Operations Rate Limiting (3 requests / 1 hour)
- [ ] **Account Deletion Attempts**
  ```bash
  # Attempt 4 deletions
  for i in {1..4}; do
    curl -X DELETE http://localhost:3000/api/account/delete \
      -H "Authorization: Bearer YOUR_JWT_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"confirmText":"DELETE"}' \
      -w "\n%{http_code}\n"
  done
  ```
  - **Expected**: 4th attempt should return 429

- [ ] **Data Export Attempts**
  ```bash
  # Attempt 4 exports
  for i in {1..4}; do
    curl http://localhost:3000/api/account/export \
      -H "Authorization: Bearer YOUR_JWT_TOKEN" \
      -w "\n%{http_code}\n"
  done
  ```
  - **Expected**: 4th attempt should return 429

### Verify Rate Limit Headers
- [ ] **Check Response Headers**
  ```bash
  curl -v http://localhost:3000/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@example.com","password":"Test123!"}'
  ```
  - **Expected Headers**:
    - `X-RateLimit-Limit: 5`
    - `X-RateLimit-Remaining: 4` (decrements with each request)
    - `X-RateLimit-Reset: <timestamp>`
    - `Retry-After: <seconds>` (when rate limited)

---

## 6️⃣ Input Validation ✅ NEW

### Test Email Validation
- [ ] **Invalid Email Format**
  ```bash
  curl -X POST http://localhost:3000/api/auth/register \
    -H "Content-Type: application/json" \
    -d '{"fullName":"Test User","email":"invalid-email","password":"Test123!"}'
  ```
  - **Expected**: 400 error with "Invalid email format"

- [ ] **SQL Injection Attempt**
  ```bash
  curl -X POST http://localhost:3000/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"admin@example.com OR 1=1--","password":"test"}'
  ```
  - **Expected**: 400 error with "Invalid email format"

### Test Password Validation
- [ ] **Too Short Password**
  ```bash
  curl -X POST http://localhost:3000/api/auth/register \
    -H "Content-Type: application/json" \
    -d '{"fullName":"Test","email":"test@example.com","password":"12345"}'
  ```
  - **Expected**: 400 error with "Password must be at least 6 characters"

- [ ] **Weak Password (no numbers)**
  ```bash
  curl -X POST http://localhost:3000/api/auth/register \
    -H "Content-Type: application/json" \
    -d '{"fullName":"Test","email":"test@example.com","password":"password"}'
  ```
  - **Expected**: 400 error with "Password must contain both letters and numbers"

- [ ] **Too Long Password**
  ```bash
  curl -X POST http://localhost:3000/api/auth/register \
    -H "Content-Type: application/json" \
    -d '{"fullName":"Test","email":"test@example.com","password":"'$(python3 -c 'print("a"*130)')'"}'
  ```
  - **Expected**: 400 error with "Password must be less than 128 characters"

### Test Name Validation
- [ ] **Invalid Characters in Name**
  ```bash
  curl -X POST http://localhost:3000/api/auth/register \
    -H "Content-Type: application/json" \
    -d '{"fullName":"<script>alert(1)</script>","email":"test@example.com","password":"Test123!"}'
  ```
  - **Expected**: 400 error with "Full name contains invalid characters"

- [ ] **Name Too Short**
  ```bash
  curl -X POST http://localhost:3000/api/auth/register \
    -H "Content-Type: application/json" \
    -d '{"fullName":"X","email":"test@example.com","password":"Test123!"}'
  ```
  - **Expected**: 400 error with "Full name must be between 2 and 100 characters"

### Test XSS Prevention
- [ ] **XSS in Email**
  ```bash
  curl -X POST http://localhost:3000/api/auth/register \
    -H "Content-Type: application/json" \
    -d '{"fullName":"Test","email":"<script>alert(1)</script>@example.com","password":"Test123!"}'
  ```
  - **Expected**: 400 error (email validation failure)

---

## 7️⃣ Account Deletion with OAuth Revocation ✅ NEW

### Prepare Test Account
- [ ] **Create Test User**
  - Register: `deletion-test@example.com`
  - Login with Google OAuth
  - Send at least 1 email
  - Make 1 application

### Test Deletion Process
- [ ] **Verify Initial Data**
  ```sql
  SELECT id, email, google_access_token, google_email 
  FROM users 
  WHERE email = 'deletion-test@example.com';
  
  SELECT COUNT(*) as app_count FROM applications WHERE user_id = <USER_ID>;
  SELECT COUNT(*) as letter_count FROM cover_letters WHERE user_id = <USER_ID>;
  ```

- [ ] **Delete Account**
  ```bash
  curl -X DELETE http://localhost:3000/api/account/delete \
    -H "Authorization: Bearer YOUR_JWT_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"confirmText":"DELETE"}'
  ```

- [ ] **Verify Response**
  ```json
  {
    "success": true,
    "message": "Your account and all associated data have been permanently deleted.",
    "oauth_revocation": {
      "google": "success",
      "microsoft": "skipped"
    }
  }
  ```

### Verify OAuth Token Revocation
- [ ] **Check Server Logs**
  - Look for: `🔒 [ACCOUNT DELETE] Revoked Google OAuth token for user <ID>`
  - If token was already invalid: `⚠️ [ACCOUNT DELETE] Failed to revoke Google token`

- [ ] **Test Revoked Token** (if you saved it)
  ```bash
  curl https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=YOUR_OLD_TOKEN
  ```
  - **Expected**: Error "Invalid Credentials"

### Verify Complete Data Deletion
- [ ] **Check User Record**
  ```sql
  SELECT * FROM users WHERE email = 'deletion-test@example.com';
  ```
  - **Expected**: No results

- [ ] **Check Related Data**
  ```sql
  SELECT COUNT(*) FROM applications WHERE user_id = <OLD_USER_ID>;
  SELECT COUNT(*) FROM cover_letters WHERE user_id = <OLD_USER_ID>;
  SELECT COUNT(*) FROM payments WHERE user_id = <OLD_USER_ID>;
  SELECT COUNT(*) FROM notifications WHERE user_id = <OLD_USER_ID>;
  SELECT COUNT(*) FROM security_audit_log WHERE user_id = <OLD_USER_ID>;
  ```
  - **Expected**: All should return 0

- [ ] **Check User Files**
  ```bash
  ls -la uploads/user_<OLD_USER_ID>/
  ```
  - **Expected**: Directory does not exist or is empty

### Test Invalid Deletion Attempts
- [ ] **Without Confirmation**
  ```bash
  curl -X DELETE http://localhost:3000/api/account/delete \
    -H "Authorization: Bearer YOUR_JWT_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"confirmText":"delete"}'  # lowercase
  ```
  - **Expected**: 400 error "Invalid confirmation"

- [ ] **Without Authentication**
  ```bash
  curl -X DELETE http://localhost:3000/api/account/delete \
    -H "Content-Type: application/json" \
    -d '{"confirmText":"DELETE"}'
  ```
  - **Expected**: 401 Unauthorized

---

## 8️⃣ GDPR Data Export ✅ NEW

### Test Data Export
- [ ] **Create Rich Test Account**
  - Register: `export-test@example.com`
  - Login with Google OAuth
  - Send 3 emails
  - Create 2 cover letters
  - Make 1 payment
  - Have some audit log entries

- [ ] **Export Account Data**
  ```bash
  curl http://localhost:3000/api/account/export \
    -H "Authorization: Bearer YOUR_JWT_TOKEN" \
    -o account-export.json
  ```

- [ ] **Verify Export File Structure**
  ```bash
  cat account-export.json | jq 'keys'
  ```
  - **Expected Keys**:
    - `export_date`
    - `user_data`
    - `applications`
    - `cover_letters`
    - `payments`
    - `notifications`
    - `security_audit_logs`

### Verify Export Contents
- [ ] **User Data Section**
  ```bash
  cat account-export.json | jq '.user_data'
  ```
  - Should include: `id`, `email`, `full_name`, `phone`, `created_at`
  - Should include OAuth metadata (NOT raw tokens)
  - Should include credits info
  - Should include subscription info

- [ ] **OAuth Data (No Tokens)**
  ```bash
  cat account-export.json | jq '.user_data.oauth_providers'
  ```
  - **Expected**: Shows `connected: true/false`, email, expiration dates
  - **NOT EXPECTED**: Encrypted or raw access tokens

- [ ] **Applications Data**
  ```bash
  cat account-export.json | jq '.applications | length'
  ```
  - Should match actual count

- [ ] **Cover Letters Data**
  ```bash
  cat account-export.json | jq '.cover_letters | length'
  ```
  - Should include full content

- [ ] **Security Audit Logs**
  ```bash
  cat account-export.json | jq '.security_audit_logs'
  ```
  - Should include all user's audit events
  - Should include IP addresses, user agents, metadata

### Test Export Security
- [ ] **Without Authentication**
  ```bash
  curl http://localhost:3000/api/account/export
  ```
  - **Expected**: 401 Unauthorized

- [ ] **Different User Token**
  - Try to access with another user's JWT token
  - **Expected**: Only exports the authenticated user's data

- [ ] **Verify Audit Log**
  ```sql
  SELECT * FROM security_audit_log 
  WHERE event_type = 'DATA_EXPORTED' 
  AND user_id = YOUR_USER_ID
  ORDER BY created_at DESC LIMIT 1;
  ```
  - Should show successful export event with record counts

---

## ⚡ Integration Testing

### End-to-End User Flow
- [ ] **New User Complete Journey**
  1. Register account
  2. Login with Google OAuth
  3. Send 1 email (tests token refresh if needed)
  4. Generate 1 cover letter
  5. Export account data
  6. Delete account
  
- [ ] **Verify Each Step in Database**
  ```sql
  -- Check audit log has all events
  SELECT event_type, success, created_at 
  FROM security_audit_log 
  WHERE user_id = <USER_ID>
  ORDER BY created_at;
  ```
  - **Expected Events**:
    - USER_REGISTERED
    - LOGIN_SUCCESS
    - OAUTH_TOKEN_GRANTED
    - DATA_EXPORTED
    - ACCOUNT_DELETED

### Mobile App Testing
- [ ] **Mobile OAuth Flow**
  - Login via mobile app
  - Send email from mobile
  - Verify token encryption
  - Verify audit logging

---

## 🚀 Production Deployment Checklist

### Before Deploying to Railway
- [ ] **All Tests Pass**: Complete all checkboxes above ✅
- [ ] **Environment Variables Set**
  ```bash
  railway variables get ENCRYPTION_KEY
  railway variables get JWT_SECRET
  railway variables get GOOGLE_CLIENT_ID
  railway variables get GOOGLE_CLIENT_SECRET
  ```

- [ ] **Database Migrations Applied**
  ```bash
  railway run node db-init.js
  ```

- [ ] **Syntax Check**
  ```bash
  node -c server.js
  node -c server/controllers/authController.js
  ```

### Deploy
- [ ] **Deploy to Railway**
  ```bash
  git add .
  git commit -m "feat: CASA Tier 2 compliance - all 8 requirements complete"
  git push railway main
  ```

- [ ] **Monitor Deployment**
  ```bash
  railway logs
  ```
  - Look for: `✅ Security features enabled`
  - Look for: `🔒 ENCRYPTION_KEY verified`
  - Should NOT see: `⚠️ WARNING: ENCRYPTION_KEY not set`

### Post-Deployment Testing
- [ ] **Test Production OAuth**
  - Go to: `https://your-app.railway.app/login.html`
  - Login with Google
  - Verify successful login and redirect

- [ ] **Test Production Database**
  ```bash
  # Connect to production DB via Railway CLI
  railway connect
  
  # Run verification query
  SELECT 
    COUNT(*) as encrypted_tokens
  FROM users 
  WHERE google_access_token LIKE 'U2FsdGVkX1%';
  ```

- [ ] **Test Rate Limiting in Production**
  ```bash
  for i in {1..6}; do
    curl -X POST https://your-app.railway.app/api/auth/login \
      -H "Content-Type: application/json" \
      -d '{"email":"test@example.com","password":"wrong"}' \
      -w "\n%{http_code}\n"
  done
  ```

---

## 📊 Final Validation Report

### Create Validation Report
```bash
# Run comprehensive check
node -e "
const dbConfig = require('./db-config');

async function validate() {
  console.log('=== CASA Tier 2 Validation Report ===\\n');
  
  // 1. Encryption
  const encrypted = await dbConfig.get(\`
    SELECT COUNT(*) as count 
    FROM users 
    WHERE google_access_token LIKE 'U2FsdGVkX1%'
  \`);
  console.log('✅ Encrypted Tokens:', encrypted.count);
  
  // 2. Token Lifecycle
  const tracked = await dbConfig.get(\`
    SELECT COUNT(*) as count 
    FROM users 
    WHERE google_token_expires_at IS NOT NULL
  \`);
  console.log('✅ Tokens with Expiration:', tracked.count);
  
  // 3. Audit Logs
  const logs = await dbConfig.get('SELECT COUNT(*) as count FROM security_audit_log');
  console.log('✅ Security Audit Events:', logs.count);
  
  // 4. Recent Events
  const recent = await dbConfig.all(\`
    SELECT event_type, COUNT(*) as count 
    FROM security_audit_log 
    WHERE created_at > datetime('now', '-24 hours')
    GROUP BY event_type
  \`);
  console.log('\\n📊 Last 24 Hours Events:');
  recent.forEach(r => console.log(\`  - \${r.event_type}: \${r.count}\`));
  
  process.exit(0);
}

validate().catch(console.error);
"
```

### Generate Final Report
- [ ] **Document Test Results**
  - Create file: `CASA_TIER2_VALIDATION_REPORT.md`
  - Include: Date, Tester, Pass/Fail for each section
  - Include: Database query results
  - Include: Screenshots of working features

### Submit to Google
- [ ] **Prepare Security Documentation**
  - Encryption implementation details
  - Audit logging specification
  - Rate limiting configuration
  - Data retention policy
  - OAuth token lifecycle management

---

## 🎯 Success Criteria

All features must pass for CASA Tier 2 compliance:

1. ✅ **OAuth Encryption**: All tokens encrypted with AES-256
2. ✅ **Key Enforcement**: App won't start without proper key
3. ✅ **Audit Logging**: All security events logged with metadata
4. ✅ **Token Lifecycle**: Expiration tracked, auto-refresh working
5. ✅ **Rate Limiting**: All limits enforced (auth: 5/15min, API: 100/15min, sensitive: 3/1hr)
6. ✅ **Input Validation**: Email, password, name validation with sanitization
7. ✅ **Account Deletion**: Complete data removal + OAuth revocation
8. ✅ **Data Export**: GDPR-compliant full account export

---

## 📞 Issue Troubleshooting

### Common Issues

**Issue**: Server won't start  
**Fix**: Check ENCRYPTION_KEY is set and long enough (48+ chars)

**Issue**: Tokens not encrypted  
**Fix**: Restart server, do fresh OAuth login

**Issue**: Rate limiting not working  
**Fix**: Check express-rate-limit package installed, restart server

**Issue**: Validation errors  
**Fix**: Check validator package installed, verify input format

**Issue**: OAuth revocation fails  
**Fix**: Check token is still valid, check network access to Google/Microsoft

**Issue**: Data export empty  
**Fix**: Ensure user has actual data (applications, emails sent, etc.)

---

## ✅ Final Checklist Before Going Live

- [ ] All 8 CASA requirements tested and passing
- [ ] Production environment variables set
- [ ] Database migrations applied
- [ ] No syntax errors
- [ ] Deployed to Railway
- [ ] Production OAuth tested
- [ ] Rate limiting verified in production
- [ ] Final validation report generated
- [ ] Documentation updated
- [ ] **Ready for Google CASA Tier 2 assessment!** 🎉
