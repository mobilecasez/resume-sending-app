# Quick Testing Steps for CASA Tier 2 (Steps 5-8)

## 🎯 TEST 1: Data Export (5 minutes)

### Step 1: Login to get JWT token

**Option A: Use Web Browser (Easiest)**

1. Open browser and go to: http://localhost:3000/login.html

2. Click "Continue with Google" and login with **searchrks@gmail.com**

3. After successful login, open **Developer Tools**:
   - Press `F12` (or `Cmd+Option+I` on Mac)
   - Click **Application** tab (or **Storage** in Firefox)
   - In left sidebar, expand **Cookies**
   - Click on `http://localhost:3000`
   - Find **authToken** and copy its value
   
   ![Cookie example: authToken = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MTUsImVtYWlsIjoic2VhcmNocmtzQGdtYWlsLmNvbSIsImlhdCI6MTcxMzExNTU3MywiZXhwIjoxNzEzMjAxOTczfQ.xxx...]

**Option B: Use curl to login (Alternative)**

```bash
# Login via API
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"searchrks@gmail.com","password":"YOUR_PASSWORD"}' \
  | jq -r '.token'
```

### Step 2: Export your data

Copy your JWT token from Step 1, then run:

```bash
# Replace YOUR_JWT_TOKEN with the actual token you copied
curl http://localhost:3000/api/account/export \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -o my-account-data.json

# Example with fake token (yours will be different):
# curl http://localhost:3000/api/account/export \
#   -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MTUsImVtYWlsIjoic2VhcmNocmtzQGdtYWlsLmNvbSIsImlhdCI6MTcxMzExNTU3MywiZXhwIjoxNzEzMjAxOTczfQ.xxx" \
#   -o my-account-data.json
```

### Step 3: Verify the export

```bash
# Check if file was created
ls -lh my-account-data.json

# View the structure
cat my-account-data.json | jq 'keys'
# Should show: ["export_date", "user_data", "applications", "cover_letters", "payments", "notifications", "security_audit_logs"]

# View your user data (without OAuth tokens)
cat my-account-data.json | jq '.user_data'

# Count your applications
cat my-account-data.json | jq '.applications | length'

# Count your cover letters
cat my-account-data.json | jq '.cover_letters | length'

# Verify OAuth tokens are NOT included (only metadata)
cat my-account-data.json | jq '.user_data.oauth_providers'
# Should show "connected: true/false" but NOT the actual encrypted tokens
```

### ✅ Success Criteria:
- [ ] File `my-account-data.json` created
- [ ] Contains all 7 sections (export_date, user_data, applications, etc.)
- [ ] OAuth section shows metadata but NOT raw tokens
- [ ] All your data is visible in the export

---

## 🎯 TEST 2: Input Validation (Wait 15 minutes first!)

⚠️ **IMPORTANT:** Rate limiting is currently active. You need to wait ~15 minutes from the last test before testing validation.

### Check if rate limit has expired:

```bash
# Try a simple login - if you get 429, wait longer
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test"}' \
  -w "\nHTTP Status: %{http_code}\n"

# If you see: HTTP Status: 429 → Wait more
# If you see: HTTP Status: 400 or 401 → Rate limit expired, proceed!
```

### Once rate limit expires, run these tests:

### Test 2.1: Invalid Email Format

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"not-an-email","password":"test123"}' \
  -w "\nHTTP Status: %{http_code}\n"
```

**Expected:** 
```json
{"error":"Invalid email format"}
HTTP Status: 400
```

### Test 2.2: Weak Password (No Numbers)

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"fullName":"Test User","email":"test-weak@example.com","password":"onlyletters"}' \
  -w "\nHTTP Status: %{http_code}\n"
```

**Expected:**
```json
{"error":"Password must contain both letters and numbers"}
HTTP Status: 400
```

### Test 2.3: XSS Prevention in Name

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"fullName":"<script>alert(1)</script>","email":"test-xss@example.com","password":"Test123"}' \
  -w "\nHTTP Status: %{http_code}\n"
```

**Expected:**
```json
{"error":"Full name contains invalid characters"}
HTTP Status: 400
```

### Test 2.4: Password Too Short

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"fullName":"Test User","email":"test-short@example.com","password":"12345"}' \
  -w "\nHTTP Status: %{http_code}\n"
```

**Expected:**
```json
{"error":"Password must be at least 6 characters"}
HTTP Status: 400
```

### Test 2.5: SQL Injection Prevention

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com OR 1=1--","password":"test"}' \
  -w "\nHTTP Status: %{http_code}\n"
```

**Expected:**
```json
{"error":"Invalid email format"}
HTTP Status: 400
```

### ✅ Success Criteria:
- [ ] All 5 tests return 400 errors
- [ ] Error messages are clear and specific
- [ ] No validation bypasses work
- [ ] SQL injection attempt blocked

---

## 🎯 TEST 3: Account Deletion (OPTIONAL - Use Test Account Only!)

⚠️ **DO NOT use searchrks@gmail.com for this test!** Create a disposable test account.

### Step 1: Create a test account

```bash
# Create unique test email with timestamp
TEST_EMAIL="delete-test-$(date +%s)@example.com"

curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"fullName\":\"Delete Test\",\"email\":\"$TEST_EMAIL\",\"password\":\"Test123\"}" \
  | jq '.'

# Save the email for later
echo "Test account created: $TEST_EMAIL"
```

### Step 2: Login with test account and get JWT

```bash
# Login to get token
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"Test123\"}" \
  | jq -r '.token'

# Copy the token output
```

### Step 3: (Optional) Connect Google OAuth and send email

1. Open browser: http://localhost:3000/login.html
2. Login with the test account email
3. Click "Continue with Google" 
4. Complete OAuth flow
5. Send 1 test email (this creates data to delete)

### Step 4: Delete the account

```bash
# Replace YOUR_TEST_JWT_TOKEN with token from Step 2
curl -X DELETE http://localhost:3000/api/account/delete \
  -H "Authorization: Bearer YOUR_TEST_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirmText":"DELETE"}' \
  | jq '.'
```

**Expected Response:**
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

### Step 5: Verify deletion in database

```bash
# Check user is deleted
psql postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev << EOF
SELECT * FROM users WHERE email = '$TEST_EMAIL';
-- Should return: 0 rows
EOF
```

### ✅ Success Criteria:
- [ ] Account deleted successfully
- [ ] OAuth tokens revoked (google: "success")
- [ ] User record removed from database
- [ ] All related data deleted (applications, cover letters, etc.)
- [ ] User files removed from disk

---

## 📊 Quick Verification Summary

After completing all tests, verify in database:

```bash
psql postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev << 'EOF'
-- Check your main account status
SELECT 
    id,
    email,
    CASE WHEN google_access_token LIKE 'U2FsdGVkX1%' THEN 'Encrypted ✅' ELSE 'Plain' END as encryption,
    google_token_expires_at,
    ROUND(EXTRACT(EPOCH FROM (google_token_expires_at - NOW())) / 60) as mins_to_expire
FROM users 
WHERE email = 'searchrks@gmail.com';

-- Check security audit logs
SELECT 
    event_type,
    success,
    created_at
FROM security_audit_log 
WHERE user_id = (SELECT id FROM users WHERE email = 'searchrks@gmail.com')
ORDER BY created_at DESC 
LIMIT 5;

-- Check if data export was logged
SELECT 
    event_type,
    details
FROM security_audit_log 
WHERE event_type = 'DATA_EXPORTED'
AND user_id = (SELECT id FROM users WHERE email = 'searchrks@gmail.com')
ORDER BY created_at DESC 
LIMIT 1;
EOF
```

---

## 🎉 All Tests Complete?

Once you've completed all tests:

### 1. Update the validation checklist

```bash
# Mark all tests as complete
cat << 'EOF' > VALIDATION_COMPLETE.txt
✅ Step 5: Rate Limiting - VERIFIED (429 errors working)
✅ Step 6: Input Validation - VERIFIED (all 5 tests passed)
✅ Step 7: Account Deletion - VERIFIED (OAuth revocation working)
✅ Step 8: Data Export - VERIFIED (JSON export successful)

All 8 CASA Tier 2 requirements COMPLETE!
Ready for production deployment.
EOF

cat VALIDATION_COMPLETE.txt
```

### 2. Deploy to Railway

```bash
# Commit all changes
git add .
git commit -m "feat: CASA Tier 2 compliance complete - all 8 requirements verified"

# Push to Railway
git push railway main

# Monitor deployment
railway logs
```

### 3. Test in production

After deployment, test OAuth login in production:
```bash
# Open production URL
open https://your-app.railway.app/login.html
```

---

## 🆘 Troubleshooting

**Problem:** Can't find authToken cookie  
**Solution:** Make sure you're logged in and looking at the right domain (localhost:3000)

**Problem:** JWT token expired (401 error)  
**Solution:** Login again to get a fresh token (tokens expire after 24 hours)

**Problem:** Rate limit blocking tests (429)  
**Solution:** Wait 15 minutes or restart server with: `pkill -f "node.*server.js" && node server.js &`

**Problem:** jq command not found  
**Solution:** Install jq: `brew install jq` (macOS) or just view file without jq

**Problem:** Data export returns 404  
**Solution:** Ensure server is running with new code (check for "Rate limiting and input validation configured" in logs)

**Problem:** OAuth revocation fails  
**Solution:** Normal if token already invalid. Check that account is still deleted from database.

---

## 📝 Notes

- JWT tokens expire after 24 hours, get a fresh one if needed
- Rate limits reset after 15 minutes
- Always use TEST accounts for deletion testing
- OAuth revocation requires internet connection
- Keep your `my-account-data.json` export as backup

---

**Ready to test?** Start with TEST 1 (Data Export) - it only takes 5 minutes! 🚀
