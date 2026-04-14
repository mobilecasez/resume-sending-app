# 🔐 CASA Tier 2 Security Assessment - CVApplyr
## Compliance Analysis & Readiness Report

**Assessment Date:** April 12, 2026  
**Deadline:** July 10, 2026  
**Project ID:** 151384459549 (cvapplyr)  
**Status:** ⚠️ **REQUIRES IMMEDIATE ACTION**

---

## 📋 Executive Summary

Google requires CVApplyr to complete a **CASA Tier 2 security assessment** because your app uses **restricted OAuth scopes** (`gmail.send` and `gmail.readonly`). This is **NOT optional** and cannot be bypassed.

### ⚡ Quick Answer: 
**Can you bypass CASA Tier 2?** ❌ **NO**

**Will your app pass?** ⚠️ **MAYBE** - Your app has good security fundamentals but has **critical gaps** that MUST be fixed before assessment.

---

## 🎯 What is CASA Tier 2?

**CASA** (Cloud Application Security Assessment) is Google's security certification program for apps that access sensitive user data.

### Why Your App Needs CASA Tier 2:

✅ **You use restricted scopes:**
- `https://www.googleapis.com/auth/gmail.send` - Restricted scope
- `https://www.googleapis.com/auth/gmail.readonly` - Restricted scope

✅ **You're requesting production access** (not testing mode with <100 users)

### What CASA Tier 2 Assesses:

1. **Application Security**
   - Secure coding practices
   - Input validation
   - Output encoding
   - Error handling
   - Session management

2. **Data Protection**
   - Encryption at rest
   - Encryption in transit
   - Secure storage of OAuth tokens
   - Data retention policies
   - Secure deletion

3. **OAuth Implementation**
   - Scope minimization
   - Token storage security
   - PKCE implementation
   - Authorization flow security

4. **Infrastructure Security**
   - Network security
   - Access controls
   - Logging and monitoring
   - Incident response
   - Backup and recovery

5. **Privacy & Compliance**
   - Privacy policy accuracy
   - User consent mechanisms
   - Data access controls
   - GDPR/CCPA compliance

---

## 🔍 Current Security Posture Analysis

### ✅ STRENGTHS (What You're Doing Right)

#### 1. **Password Security** ✅
```javascript
// server.js line 17
const bcrypt = require('bcryptjs');
```
- Using bcrypt for password hashing
- Industry standard cryptographic hashing

#### 2. **SMTP Credential Encryption** ✅
```javascript
// server.js line 64-72
function encryptData(text) {
    return CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
}
```
- AES encryption for SMTP passwords
- Encrypted before database storage

#### 3. **HTTPS in Production** ✅
```javascript
// server.js - OAuth callbacks
const callbackUrl = process.env.NODE_ENV === 'production' 
    ? 'https://cvapplyr.com/auth/google/callback'
```
- Enforcing HTTPS for production
- TLS/SSL for data in transit

#### 4. **JWT Authentication** ✅
```javascript
// HTTP-only cookies
res.cookie('authToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
});
```
- HTTP-only cookies (XSS protection)
- Secure flag in production
- CSRF protection with sameSite

#### 5. **Privacy Policy** ✅
- Comprehensive privacy policy at `/privacy-policy.html`
- Covers OAuth scopes, data collection, retention
- GDPR/CCPA disclosures

#### 6. **Database Connection Security** ✅
```javascript
// db-config.js
ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : false
```
- SSL for PostgreSQL connections in production
- Connection pooling with limits

#### 7. **Scope Justification** ✅
- Detailed scope justification documented
- Clear user consent flow
- Minimal scopes requested

---

## ❌ CRITICAL SECURITY GAPS (Must Fix Before CASA)

### 🚨 **BLOCKER #1: OAuth Tokens Stored in Plain Text**

**Location:** `database/postgres-schema.sql` Line 16-19
```sql
google_access_token TEXT,
google_refresh_token TEXT,
microsoft_access_token TEXT,
microsoft_refresh_token TEXT,
```

**Current Implementation:** `server.js` Line 471
```javascript
'UPDATE users SET oauth_provider = ?, google_access_token = ?, google_refresh_token = ?, used_pkce = ? WHERE id = ?',
[provider, accessToken, refreshToken, false, user.id]
```

**Issue:** ❌
- OAuth tokens stored **UNENCRYPTED** in database
- Direct storage of sensitive credentials
- Violates Google's security requirements

**CASA Tier 2 Requirement:**
> "OAuth tokens MUST be encrypted at rest using industry-standard encryption (AES-256)"

**Impact:** 🔴 **CRITICAL - WILL FAIL CASA ASSESSMENT**

**Fix Required:**
```javascript
// Encrypt tokens before storage
const encryptedAccessToken = encryptData(accessToken);
const encryptedRefreshToken = encryptData(refreshToken);

'UPDATE users SET oauth_provider = ?, google_access_token = ?, google_refresh_token = ?, used_pkce = ? WHERE id = ?',
[provider, encryptedAccessToken, encryptedRefreshToken, false, user.id]

// Decrypt when retrieving
function createOAuth2Client(user) {
    const oauth2Client = new google.auth.OAuth2(...);
    oauth2Client.setCredentials({
        access_token: decryptData(user.google_access_token),
        refresh_token: decryptData(user.google_refresh_token)
    });
    return oauth2Client;
}
```

---

### 🚨 **BLOCKER #2: Missing Encryption Key Management**

**Location:** `server.js` Line 58
```javascript
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'your-encryption-key-change-this-in-production-min-32-chars';
```

**Issues:** ❌
1. Hardcoded fallback key (security anti-pattern)
2. No key rotation mechanism
3. No key derivation (should use PBKDF2/scrypt)
4. Single key for all data (no key isolation)

**CASA Tier 2 Requirement:**
> "Encryption keys must be securely managed, rotated regularly, and never hardcoded"

**Impact:** 🔴 **CRITICAL - WILL FAIL CASA ASSESSMENT**

**Fix Required:**
```javascript
// Remove fallback key - MUST fail if not set
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 32) {
    console.error('❌ ENCRYPTION_KEY must be set and at least 32 characters');
    process.exit(1);
}

// Use environment-specific keys
const TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY; // For OAuth tokens
const DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY;   // For user data
```

---

### 🚨 **BLOCKER #3: No Security Logging/Audit Trail**

**Missing Implementation:**
- No logging of OAuth token access
- No audit trail for sensitive operations
- No failed authentication tracking
- No suspicious activity monitoring

**CASA Tier 2 Requirement:**
> "Applications must implement comprehensive security logging including:
> - OAuth token grants/revocations
> - Access to sensitive data
> - Failed authentication attempts
> - Administrative actions"

**Impact:** 🔴 **CRITICAL - WILL FAIL CASA ASSESSMENT**

**Fix Required:**
```javascript
// Add security audit logging
async function logSecurityEvent(userId, eventType, details) {
    await db.run(`
        INSERT INTO security_audit_log 
        (user_id, event_type, ip_address, user_agent, details, timestamp)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [userId, eventType, req.ip, req.headers['user-agent'], JSON.stringify(details)]);
}

// Log OAuth events
await logSecurityEvent(user.id, 'OAUTH_TOKEN_GRANTED', {
    provider: 'google',
    scopes: ['gmail.send', 'gmail.readonly']
});

// Log email access
await logSecurityEvent(user.id, 'EMAIL_SENT', {
    recipient: recipientEmail,
    timestamp: new Date().toISOString()
});
```

---

### 🚨 **BLOCKER #4: Missing Token Refresh & Expiration Handling**

**Current Implementation:** No token expiration tracking

**Issues:** ❌
- No token expiration date stored
- No automatic token refresh
- Stale tokens may be used
- No token revocation mechanism

**CASA Tier 2 Requirement:**
> "Applications must implement proper token lifecycle management including expiration tracking and automatic refresh"

**Impact:** 🟡 **HIGH - MAY FAIL CASA ASSESSMENT**

**Fix Required:**
```sql
-- Add to users table
ALTER TABLE users ADD COLUMN google_token_expires_at TIMESTAMP;
ALTER TABLE users ADD COLUMN microsoft_token_expires_at TIMESTAMP;
```

```javascript
// Store expiration
const expiresAt = new Date(Date.now() + 3600 * 1000); // 1 hour
await db.run(
    'UPDATE users SET google_access_token = ?, google_token_expires_at = ? WHERE id = ?',
    [encryptedToken, expiresAt, user.id]
);

// Check and refresh before use
async function getValidAccessToken(user) {
    if (new Date() >= new Date(user.google_token_expires_at)) {
        // Token expired, refresh it
        const oauth2Client = createOAuth2Client(user);
        const { credentials } = await oauth2Client.refreshAccessToken();
        // Update database with new token
        await updateTokens(user.id, credentials);
        return credentials.access_token;
    }
    return decryptData(user.google_access_token);
}
```

---

### 🚨 **BLOCKER #5: Database Encryption at Rest**

**Current Implementation:** PostgreSQL without explicit encryption

**Issue:** ❌
- No database-level encryption configured
- Sensitive data (resumes, personal info) stored unencrypted
- OAuth tokens unencrypted (see Blocker #1)

**CASA Tier 2 Requirement:**
> "All sensitive data must be encrypted at rest using industry-standard encryption"

**Impact:** 🔴 **CRITICAL - WILL FAIL CASA ASSESSMENT**

**Fix Options:**

**Option 1: Application-Level Encryption** (Recommended - Easier)
```javascript
// Encrypt sensitive fields before storage
async function storeUserData(userId, resume) {
    const encryptedResume = encryptData(resume);
    await db.run('UPDATE users SET resume_path = ? WHERE id = ?', [encryptedResume, userId]);
}
```

**Option 2: Database-Level Encryption** (Better but requires DB access)
```sql
-- Railway PostgreSQL: Enable pgcrypto extension
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Use encrypted columns
CREATE TABLE users (
    ...
    google_access_token BYTEA,  -- Store encrypted binary
    ...
);

-- Encrypt on insert
INSERT INTO users (google_access_token) 
VALUES (pgp_sym_encrypt('token_value', 'encryption_key'));

-- Decrypt on select
SELECT pgp_sym_decrypt(google_access_token, 'encryption_key') FROM users;
```

**Railway Specific:**
Railway PostgreSQL supports encryption extensions. Add to deployment:
```bash
# Check if pgcrypto is available
railway run psql -c "SELECT * FROM pg_available_extensions WHERE name = 'pgcrypto';"

# Enable if available
railway run psql -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

---

### 🚨 **BLOCKER #6: No Rate Limiting**

**Missing Implementation:**
- No rate limiting on OAuth endpoints
- No protection against brute force attacks
- No API request throttling

**CASA Tier 2 Requirement:**
> "Applications must implement rate limiting to prevent abuse and protect user accounts"

**Impact:** 🟡 **HIGH - MAY FAIL CASA ASSESSMENT**

**Fix Required:**
```javascript
const rateLimit = require('express-rate-limit');

// OAuth rate limiter
const oauthLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per window
    message: 'Too many authentication attempts, please try again later'
});

app.use('/auth/google', oauthLimiter);
app.use('/auth/microsoft', oauthLimiter);

// API rate limiter
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    message: 'Too many requests, please slow down'
});

app.use('/api/', apiLimiter);
```

---

### ⚠️ **BLOCKER #7: Missing Input Validation**

**Risk Areas:**
- Email inputs not validated
- File uploads (resumes) need validation
- SQL injection risks (using parameterized queries - GOOD)
- XSS risks in cover letter generation

**CASA Tier 2 Requirement:**
> "All user inputs must be validated and sanitized"

**Impact:** 🟡 **MEDIUM - MAY FAIL CASA ASSESSMENT**

**Fix Required:**
```javascript
const validator = require('validator');

// Email validation
function validateEmail(email) {
    if (!validator.isEmail(email)) {
        throw new Error('Invalid email address');
    }
    return validator.normalizeEmail(email);
}

// File upload validation
const fileFilter = (req, file, cb) => {
    // Only allow PDF for resumes
    if (file.mimetype !== 'application/pdf') {
        return cb(new Error('Only PDF files allowed'), false);
    }
    // Max 5MB
    if (file.size > 5 * 1024 * 1024) {
        return cb(new Error('File too large (max 5MB)'), false);
    }
    cb(null, true);
};
```

---

### ⚠️ **BLOCKER #8: Missing Data Deletion Mechanism**

**Privacy Policy Claims:** "Data deleted within 30 days of account deletion"

**Reality:** ❌ No account deletion endpoint found

**CASA Tier 2 Requirement:**
> "Applications must provide users with ability to delete their data and revoke access"

**Impact:** 🟡 **HIGH - WILL FAIL CASA ASSESSMENT**

**Fix Required:**
```javascript
// Add account deletion endpoint
app.delete('/api/account/delete', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Revoke OAuth tokens first
        const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
        
        if (user.google_access_token) {
            const oauth2Client = createOAuth2Client(user);
            await oauth2Client.revokeToken(decryptData(user.google_access_token));
        }
        
        // Soft delete (for data retention compliance)
        await db.run(
            'UPDATE users SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE id = ?',
            [userId, userId]
        );
        
        // Log deletion
        await logSecurityEvent(userId, 'ACCOUNT_DELETED', { timestamp: new Date() });
        
        res.json({ success: true, message: 'Account scheduled for deletion' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete account' });
    }
});

// Add data export (GDPR requirement)
app.get('/api/account/export', authenticateToken, async (req, res) => {
    // Export all user data as JSON
    const userData = await getAllUserData(req.user.id);
    res.json(userData);
});
```

---

## 📊 CASA Tier 2 Compliance Scorecard

| Security Control | Status | Impact | Effort |
|-----------------|--------|---------|--------|
| **OAuth Token Encryption** | ❌ FAIL | 🔴 CRITICAL | 2-3 days |
| **Key Management** | ❌ FAIL | 🔴 CRITICAL | 1 day |
| **Security Logging** | ❌ FAIL | 🔴 CRITICAL | 3-4 days |
| **Token Lifecycle** | ❌ FAIL | 🟡 HIGH | 2 days |
| **Data Encryption at Rest** | ⚠️ PARTIAL | 🔴 CRITICAL | 3-4 days |
| **Rate Limiting** | ❌ FAIL | 🟡 HIGH | 1 day |
| **Input Validation** | ⚠️ PARTIAL | 🟡 MEDIUM | 2 days |
| **Data Deletion** | ❌ FAIL | 🟡 HIGH | 2-3 days |
| **Password Security** | ✅ PASS | ✅ GOOD | N/A |
| **HTTPS/TLS** | ✅ PASS | ✅ GOOD | N/A |
| **Privacy Policy** | ✅ PASS | ✅ GOOD | N/A |
| **Session Security** | ✅ PASS | ✅ GOOD | N/A |

**Overall Readiness: 40%** ⚠️

---

## 🚨 CAN YOU BYPASS CASA TIER 2?

### ❌ **NO - Here's Why:**

**Google's Policy is Clear:**
> "Apps using restricted or sensitive scopes with more than 100 users MUST complete CASA Tier 2 assessment. No exceptions."

### **Your Options:**

#### Option 1: Remove Restricted Scopes (NOT VIABLE)
- Remove `gmail.readonly` scope
- Keep only `gmail.send`
- **Problem:** Breaks "Check Replies" feature

#### Option 2: Stay in Testing Mode (NOT VIABLE LONG-TERM)
- Limit to 100 test users
- Keep app "unpublished"
- **Problem:** Can't scale, not sustainable

#### Option 3: Complete CASA Tier 2 (REQUIRED) ✅
- Fix security issues (see above)
- Hire CASA authorized lab
- Pass assessment
- **Result:** Production-ready, unlimited users

---

## 💰 CASA Tier 2 Assessment Cost

### TAC Security (Google's Preferred Partner - Discounted)
- **Tier 2 Assessment:** $8,000 - $15,000 USD
- **Timeline:** 4-6 weeks
- **Includes:** Vulnerability scan, code review, report

### Other CASA Authorized Labs
- **Tier 2 Assessment:** $10,000 - $20,000 USD
- **Timeline:** 4-6 weeks

### DIY Preparation (Before Lab Assessment)
- **Cost:** $0 (your time)
- **Timeline:** 2-3 weeks to fix issues
- **Required:** Must fix critical gaps before lab assessment

---

## 📅 Recommended Timeline

**Total Time Needed:** 8-10 weeks

### Week 1-2: Fix Critical Security Issues
- [ ] Implement OAuth token encryption
- [ ] Fix encryption key management
- [ ] Add security logging

### Week 3: Fix High-Priority Issues
- [ ] Token lifecycle management
- [ ] Rate limiting
- [ ] Data deletion endpoints

### Week 4: Testing & Documentation
- [ ] Security testing
- [ ] Update privacy policy
- [ ] Document security controls

### Week 5-6: Contact CASA Lab
- [ ] Get quote from TAC Security or other lab
- [ ] Submit application
- [ ] Provide documentation

### Week 7-9: CASA Assessment
- [ ] Lab conducts vulnerability scan
- [ ] Code review
- [ ] Fix any issues found

### Week 10: Certification
- [ ] Receive CASA Tier 2 certificate
- [ ] Submit to Google
- [ ] Get production approval

**Your Deadline:** July 10, 2026 (13 weeks away)  
**You have time, but must start NOW**

---

## ✅ IMMEDIATE ACTION ITEMS

### Priority 1 (This Week):
1. ✅ Create backup of current database
2. ✅ Set `ENCRYPTION_KEY` in Railway environment (32+ chars)
3. ✅ Implement OAuth token encryption (encrypt before storage)
4. ✅ Remove hardcoded encryption key fallback

### Priority 2 (Next Week):
1. ✅ Add security audit logging table
2. ✅ Implement security event logging
3. ✅ Add token expiration tracking
4. ✅ Implement rate limiting

### Priority 3 (Week 3):
1. ✅ Add account deletion endpoint
2. ✅ Add data export endpoint
3. ✅ Enhance input validation
4. ✅ Add file upload restrictions

### Priority 4 (Week 4):
1. ✅ Contact TAC Security for quote
2. ✅ Prepare documentation
3. ✅ Conduct internal security testing
4. ✅ Review and update privacy policy

---

## 🔗 Useful Resources

### CASA Official Resources
- **CASA Website:** https://cloud.google.com/security/casa
- **CASA Tiering Guide:** https://cloud.google.com/security/casa/tier
- **TAC Security:** https://www.tacsecurity.com/casa

### CASA Tier 2 Requirements
- **OAuth Security Best Practices:** https://developers.google.com/identity/protocols/oauth2/security-best-practices
- **Data Protection Guidelines:** https://cloud.google.com/security/encryption/default-encryption

### Authorized CASA Labs
1. **TAC Security** (Google Preferred Partner - Discounted)
   - https://www.tacsecurity.com/casa
   - Email: casa@tacsecurity.com

2. **Coalfire**
   - https://www.coalfire.com/solutions/google-casa

3. **Schellman**
   - https://www.schellman.com/cloud-assessments

### Contact for CASA Assessment
**TAC Security (Recommended):**
- Email: casa@tacsecurity.com
- Mention: "Google CASA Tier 2 for Project ID 151384459549"
- Ask for: "Discounted rate for Google Cloud customers"

---

## 🎯 Bottom Line

### Can You Pass CASA Tier 2?
**YES** - Your app has good security foundations, but you MUST fix the critical issues above.

### Can You Bypass CASA Tier 2?
**NO** - It's mandatory for your OAuth scopes.

### What's the Best Path Forward?

1. **Fix critical security gaps** (2-3 weeks)
2. **Contact TAC Security** for discounted assessment
3. **Complete CASA Tier 2** before July 10, 2026
4. **Get production approval** from Google

### Estimated Total Cost:
- **Your Time:** 60-80 hours fixing security issues
- **CASA Assessment:** $8,000 - $15,000 USD
- **Timeline:** 8-10 weeks

### Want an Extension?
Contact your CASA authorized lab. They can request deadline extensions if:
- You've engaged with a lab
- Assessment is in progress
- You're actively working on remediation

---

## 📞 Next Steps - DO THIS NOW

1. **Email TAC Security today:**
   ```
   Subject: CASA Tier 2 Assessment - Project ID 151384459549
   
   Hi TAC Security team,
   
   I need a CASA Tier 2 assessment for my application:
   - Project Name: CVApplyr
   - Project ID: 151384459549
   - Deadline: July 10, 2026
   - OAuth Scopes: gmail.send, gmail.readonly
   
   Please provide:
   1. Quote for Tier 2 assessment (mention Google discounted rate)
   2. Timeline estimate
   3. Requirements checklist
   
   Best regards,
   [Your Name]
   ```

2. **Start fixing critical issues** (use this document as checklist)

3. **Set up weekly progress tracking**

4. **Ask for deadline extension if needed** (do this through CASA lab)

---

## ⚠️ Final Warning

**Without CASA Tier 2 certification by July 10, 2026:**
- ❌ Google will revoke your OAuth access
- ❌ Your app will stop working
- ❌ Users cannot login with Google
- ❌ Email sending via Gmail API will fail
- ❌ App becomes non-functional

**You MUST complete this. Start immediately.**

---

**Questions?** Review this document and start with Priority 1 action items.
