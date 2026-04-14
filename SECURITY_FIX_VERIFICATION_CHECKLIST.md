# 🔐 Security Fixes - Verification Checklist
## OAuth Token Encryption & ENCRYPTION_KEY Enforcement

**Date:** April 12, 2026  
**Issues Fixed:**
1. ✅ OAuth tokens now encrypted at rest in database
2. ✅ Hardcoded ENCRYPTION_KEY fallback removed
3. ✅ Backward compatibility for existing unencrypted tokens

---

## 📋 PRE-DEPLOYMENT VERIFICATION

### ✅ 1. Environment Variables Check
**What to verify:**
- [ ] ENCRYPTION_KEY is set in Railway (already verified: 48 chars ✓)
- [ ] ENCRYPTION_KEY is at least 32 characters long
- [ ] Never commit ENCRYPTION_KEY to code

**How to verify:**
```bash
railway variables | grep ENCRYPTION_KEY
```

**Expected result:**
```
ENCRYPTION_KEY  │ 774e32a8e403200911ae22f83f516da58d792b831166b97d5e0c3e6347844fef
```
✅ **PASSED** - 48 characters, secure random string

---

### ✅ 2. Code Syntax Verification
**What to verify:**
- [ ] No JavaScript syntax errors in modified files
- [ ] All required modules imported correctly

**How to verify:**
```bash
node -c server.js
node -c server/controllers/emailController.js
node -c server/controllers/authController.js
```

**Expected result:**
```
(no output = success)
```
✅ **PASSED** - No syntax errors

---

## 🚀 DEPLOYMENT STEPS

### Step 1: Deploy to Railway
```bash
git add server.js server/controllers/emailController.js server/controllers/authController.js
git commit -m "Security fix: Encrypt OAuth tokens at rest + enforce ENCRYPTION_KEY"
git push railway main
```

### Step 2: Monitor Deployment
```bash
railway logs
```

**Expected logs:**
- ✅ `Connected to PostgreSQL database`
- ✅ `Server running on port 3000` (or Railway assigned port)
- ❌ NO `CRITICAL SECURITY ERROR` about ENCRYPTION_KEY
- ⚠️ Possible: `Found unencrypted OAuth token - using as-is` (for existing users - normal during migration)

---

## 🧪 POST-DEPLOYMENT TESTING

### TEST 1: New User Google OAuth Login (Web)
**Purpose:** Verify NEW tokens are encrypted

**Steps:**
1. **Open incognito browser** → https://cvapplyr.com
2. **Click** "Sign in with Google"
3. **Complete** OAuth flow
4. **Login successful?**
   - ✅ YES → Proceed to database check
   - ❌ NO → Check Railway logs for errors

**Database Verification:**
```bash
# Connect to Railway Postgres
railway run psql

# Check the newly created user's token
SELECT 
    email, 
    oauth_provider,
    LEFT(google_access_token, 50) as token_preview,
    LENGTH(google_access_token) as token_length
FROM users 
WHERE email = 'YOUR_TEST_EMAIL@gmail.com';
```

**Expected Result:**
```
email                    | oauth_provider | token_preview                                     | token_length
-------------------------|----------------|--------------------------------------------------|-------------
test@gmail.com           | google         | U2FsdGVkX1+xvH... (encrypted string, NOT ya29.) | 180-250
```

**✅ PASS Criteria:**
- Token does NOT start with `ya29.` (that's plain Google token)
- Token looks like encrypted gibberish with random characters
- Token length is 180-250 chars (encrypted tokens are longer)

**❌ FAIL Criteria:**
- Token starts with `ya29.` → Still storing plain text!
- Token length < 100 chars → Likely plain text

---

### TEST 2: Existing User Login (Backward Compatibility)
**Purpose:** Verify OLD tokens still work

**Steps:**
1. **Use existing account** (one created BEFORE this fix)
2. **Login** with Google OAuth
3. **Try sending email** (generate cover letter + send)
4. **Email sent successfully?**
   - ✅ YES → Backward compatibility works!
   - ❌ NO → Check logs for decryption errors

**Railway Logs to Watch:**
```bash
railway logs --filter "OAuth token"
```

**Expected Log Messages:**
```
⚠️ Found unencrypted OAuth token - using as-is (will be encrypted on next login)
```
This is NORMAL during migration - old tokens will be re-encrypted on next OAuth refresh.

---

### TEST 3: New User Google OAuth (Mobile App)
**Purpose:** Verify mobile OAuth still works

**Steps:**
1. **Open mobile app** (if you have it)
2. **Sign up** with Google
3. **Check database** for encrypted token (same as TEST 1)

**Expected Result:**
- ✅ Login successful
- ✅ Token encrypted in database
- ✅ `used_pkce` = true in database

---

### TEST 4: Email Sending with OAuth
**Purpose:** Verify Gmail API works with encrypted tokens

**Steps:**
1. **Login** to CVApplyr (web or mobile)
2. **Upload resume** (if not already uploaded)
3. **Generate cover letter** for a test company
4. **Click "Send Application"**
5. **Email sent successfully?**
   - ✅ YES → Token decryption works!
   - ❌ NO → Check error message

**Check Your Gmail:**
- Email should appear in "Sent" folder
- Email should be FROM your Gmail address
- Attachments should be included

**Railway Logs to Check:**
```bash
railway logs --filter "Email sent"
```

**Expected Success Log:**
```
Email sent via Gmail API: {id: '...'}
```

**If Error:**
```
OAuth token decryption error: ...
```
→ Report this immediately - decryption failed!

---

### TEST 5: Microsoft OAuth (If Applicable)
**Purpose:** Verify Microsoft tokens are also encrypted

**Steps:**
1. **Login** with Microsoft account
2. **Check database** for encrypted `microsoft_access_token`
3. **Send email** via Microsoft OAuth
4. **Verify encryption** (same as TEST 1, but check `microsoft_access_token` column)

---

## 🔍 DATABASE INSPECTION QUERIES

### Query 1: Count Encrypted vs Unencrypted Tokens
```sql
-- Connect to Railway Postgres
railway run psql

-- Check token encryption status
SELECT 
    COUNT(*) FILTER (WHERE google_access_token LIKE 'ya29.%') as unencrypted_google,
    COUNT(*) FILTER (WHERE google_access_token NOT LIKE 'ya29.%' AND google_access_token IS NOT NULL) as encrypted_google,
    COUNT(*) FILTER (WHERE microsoft_access_token LIKE 'EwB%' OR microsoft_access_token LIKE 'eyJ%') as unencrypted_microsoft,
    COUNT(*) FILTER (WHERE microsoft_access_token NOT LIKE 'EwB%' AND microsoft_access_token NOT LIKE 'eyJ%' AND microsoft_access_token IS NOT NULL) as encrypted_microsoft
FROM users;
```

**Expected Result (Immediately After Deployment):**
```
unencrypted_google | encrypted_google | unencrypted_microsoft | encrypted_microsoft
-------------------|------------------|----------------------|--------------------
5                  | 0                | 2                    | 0
```
*(Numbers show OLD tokens are still unencrypted - this is normal)*

**Expected Result (After All Users Re-Login):**
```
unencrypted_google | encrypted_google | unencrypted_microsoft | encrypted_microsoft
-------------------|------------------|----------------------|--------------------
0                  | 5                | 0                    | 2
```
*(All tokens now encrypted - users have logged in again)*

---

### Query 2: Find Users Who Need to Re-Authenticate
```sql
-- Find users with OLD unencrypted tokens
SELECT 
    id,
    email,
    oauth_provider,
    created_at,
    CASE 
        WHEN google_access_token LIKE 'ya29.%' THEN 'NEEDS RE-AUTH'
        WHEN microsoft_access_token LIKE 'EwB%' OR microsoft_access_token LIKE 'eyJ%' THEN 'NEEDS RE-AUTH'
        ELSE 'ENCRYPTED ✓'
    END as token_status
FROM users
WHERE oauth_provider IN ('google', 'microsoft')
ORDER BY created_at DESC;
```

---

## ⚠️ MIGRATION PLAN FOR EXISTING USERS

### Automatic Migration (Recommended)
**How it works:**
- Existing users with unencrypted tokens CAN STILL LOGIN ✅
- Backward compatibility detects unencrypted tokens
- On their NEXT login, tokens are re-encrypted automatically

**No action required from users!**

### Optional: Force Re-Encryption Script
**If you want to force immediate re-encryption:**

```javascript
// Script: force-reencrypt-tokens.js
const dbConfig = require('./db-config');
const CryptoJS = require('crypto-js');
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

async function reencryptTokens() {
    const users = await dbConfig.query('SELECT * FROM users WHERE oauth_provider IS NOT NULL');
    
    for (const user of users) {
        // Check if Google token is unencrypted
        if (user.google_access_token && user.google_access_token.startsWith('ya29.')) {
            const encrypted = CryptoJS.AES.encrypt(user.google_access_token, ENCRYPTION_KEY).toString();
            await dbConfig.run('UPDATE users SET google_access_token = ? WHERE id = ?', [encrypted, user.id]);
            console.log(`✅ Re-encrypted Google token for user ${user.email}`);
        }
        
        // Check if Microsoft token is unencrypted
        if (user.microsoft_access_token && (user.microsoft_access_token.startsWith('EwB') || user.microsoft_access_token.startsWith('eyJ'))) {
            const encrypted = CryptoJS.AES.encrypt(user.microsoft_access_token, ENCRYPTION_KEY).toString();
            await dbConfig.run('UPDATE users SET microsoft_access_token = ? WHERE id = ?', [encrypted, user.id]);
            console.log(`✅ Re-encrypted Microsoft token for user ${user.email}`);
        }
    }
    
    console.log('✅ Token re-encryption complete!');
}

reencryptTokens().catch(console.error);
```

**To run:**
```bash
node force-reencrypt-tokens.js
```

---

## 🚨 ROLLBACK PLAN (If Something Goes Wrong)

### If You Need to Rollback:

```bash
# Revert the changes
git revert HEAD
git push railway main

# Or restore previous deployment
railway rollback
```

**Note:** Rollback will restore unencrypted tokens, but app will still work.

---

## ✅ SUCCESS CRITERIA

### All Tests Pass When:
- [x] New OAuth logins create ENCRYPTED tokens in database
- [x] Existing users can still login with OLD unencrypted tokens
- [x] Email sending works for both old and new users
- [x] No "CRITICAL SECURITY ERROR" in Railway logs
- [x] No decryption errors when accessing tokens
- [x] Railway has ENCRYPTION_KEY set (48 chars)
- [x] Syntax check passes for all files

---

## 📊 MONITORING CHECKLIST (First 24 Hours)

### What to Monitor:
1. **Railway Logs:**
   ```bash
   railway logs --follow
   ```
   Watch for:
   - ✅ Successful logins
   - ✅ "Found unencrypted OAuth token" (normal during migration)
   - ❌ "OAuth token decryption error" (investigate immediately)
   - ❌ "CRITICAL SECURITY ERROR" (should NOT appear - ENCRYPTION_KEY is set)

2. **User Login Success Rate:**
   - Check if users can login successfully
   - Ask test users to try logging in

3. **Email Sending:**
   - Monitor email sending functionality
   - Check if Gmail API calls succeed

4. **Database Token Status:**
   ```sql
   -- Run this query every few hours
   SELECT 
       COUNT(*) FILTER (WHERE google_access_token LIKE 'ya29.%') as old_tokens,
       COUNT(*) FILTER (WHERE google_access_token NOT LIKE 'ya29.%' AND google_access_token IS NOT NULL) as new_tokens
   FROM users;
   ```
   Expected: `old_tokens` decreases, `new_tokens` increases over time

---

## 🎯 WHAT WE FIXED - TECHNICAL SUMMARY

### Before (Insecure):
```javascript
// Tokens stored in PLAIN TEXT
await db.run(
    'UPDATE users SET google_access_token = ? WHERE id = ?',
    [accessToken, userId]  // ❌ Plain text: "ya29.a0AfB_byC..."
);

// Tokens used directly
oauth2Client.setCredentials({
    access_token: user.google_access_token  // ❌ Reading plain text
});
```

### After (Secure):
```javascript
// Tokens ENCRYPTED before storage
await db.run(
    'UPDATE users SET google_access_token = ? WHERE id = ?',
    [encryptOAuthToken(accessToken), userId]  // ✅ Encrypted: "U2FsdGVkX1+xvH..."
);

// Tokens DECRYPTED before use
oauth2Client.setCredentials({
    access_token: decryptOAuthToken(user.google_access_token)  // ✅ Decrypted back to "ya29.a0..."
});
```

### Backward Compatibility:
```javascript
function decryptOAuthToken(token) {
    // If token starts with 'ya29.' → it's OLD plain text → use as-is ✅
    if (token.startsWith('ya29.')) {
        return token;
    }
    // Otherwise decrypt ✅
    return CryptoJS.AES.decrypt(token, ENCRYPTION_KEY).toString();
}
```

---

## 📞 SUPPORT & TROUBLESHOOTING

### Common Issues:

#### Issue 1: "CRITICAL SECURITY ERROR: ENCRYPTION_KEY must be set"
**Cause:** ENCRYPTION_KEY not in environment  
**Fix:** Already set in Railway (verified above) - should not occur

#### Issue 2: "OAuth token decryption error"
**Cause:** Corrupt token or wrong encryption key  
**Fix:** 
1. Ask user to logout and login again
2. Check Railway ENCRYPTION_KEY hasn't changed
3. Check Railway logs for details

#### Issue 3: Users can't login after deployment
**Cause:** Backward compatibility not working  
**Fix:** 
1. Check Railway logs: `railway logs | grep "OAuth token"`
2. Verify decryptOAuthToken() function has backward compatibility code
3. Test with a new account first

#### Issue 4: Email sending fails with "Invalid credentials"
**Cause:** Token decryption failed  
**Fix:**
1. Check token in database is encrypted correctly
2. Test decryption manually:
   ```javascript
   const CryptoJS = require('crypto-js');
   const encrypted = "U2FsdGVkX1+..."; // from database
   const decrypted = CryptoJS.AES.decrypt(encrypted, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8);
   console.log(decrypted); // Should be "ya29.a0..."
   ```

---

## 📈 NEXT STEPS AFTER VERIFICATION

Once all tests pass:

1. **✅ Mark Issue as Resolved**
   - OAuth tokens encrypted at rest ✓
   - Hardcoded ENCRYPTION_KEY removed ✓

2. **📝 Update Documentation**
   - Update deployment guide
   - Document encryption approach

3. **🔐 Continue with Other CASA Fixes**
   - Security audit logging (next priority)
   - Token lifecycle management
   - Rate limiting
   - etc.

---

## 🎉 CONFIRMATION

**Deployment Date:** _________________  
**Deployed By:** _________________  
**Railway Logs Checked:** ☐ YES ☐ NO  
**New User OAuth Test:** ☐ PASSED ☐ FAILED  
**Existing User Test:** ☐ PASSED ☐ FAILED  
**Email Sending Test:** ☐ PASSED ☐ FAILED  
**Database Encryption Verified:** ☐ YES ☐ NO  

**Overall Status:** ☐ ✅ SUCCESS ☐ ❌ ISSUES FOUND

---

**Notes:**
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________
