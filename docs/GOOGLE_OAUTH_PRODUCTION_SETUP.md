# Google OAuth Production Setup for cvapplyr.com

## 🎯 Overview
Configure Google OAuth for production deployment with custom domain **cvapplyr.com**

---

## 📋 Step-by-Step Configuration

### 1️⃣ Google Cloud Console Setup

**Access:** https://console.cloud.google.com/

#### A. Navigate to OAuth Configuration
1. Go to **APIs & Services** > **Credentials**
2. Click on your existing OAuth 2.0 Client ID (or create new one)
3. You should see your client ID: `832256639733-f3931pli3e13dijpkpehm799pkqll5sq.apps.googleusercontent.com`

---

### 2️⃣ Configure Authorized JavaScript Origins

Add the following origins (remove localhost entries for production):

```
https://cvapplyr.com
https://www.cvapplyr.com
https://cvapplyr-website-production.up.railway.app
```

**Why these domains:**
- `cvapplyr.com` - Your main production domain
- `www.cvapplyr.com` - WWW subdomain
- Railway URL - Backup direct access to Railway deployment

**⚠️ Important:** 
- Use `https://` only (no `http://`)
- No trailing slashes
- No port numbers

---

### 3️⃣ Configure Authorized Redirect URIs

Add these redirect URIs:

```
https://cvapplyr.com/auth/google/callback
https://www.cvapplyr.com/auth/google/callback
https://cvapplyr-website-production.up.railway.app/auth/google/callback
https://cvapplyr.com/auth-success.html
https://www.cvapplyr.com/auth-success.html
```

**Why these paths:**
- `/auth/google/callback` - Backend OAuth callback endpoint
- `/auth-success.html` - Frontend success page

---

### 4️⃣ OAuth Consent Screen Configuration

Navigate to **OAuth consent screen** tab:

#### Publishing Status
- **Status:** Set to **"In Production"** (not "Testing")
- **Why:** Testing mode limits to 100 test users

#### App Information
```
App name: CVApplyr
User support email: [your-support-email@cvapplyr.com]
App logo: [Upload your logo - 120x120px PNG/JPG]
Application home page: https://cvapplyr.com
```

#### App Domain Settings
```
Application home page: https://cvapplyr.com
Application privacy policy link: https://cvapplyr.com/privacy-policy.html
Application terms of service link: https://cvapplyr.com/terms.html
```

**⚠️ Required for Production:**
- Privacy Policy page must be publicly accessible
- Terms of Service page must be publicly accessible
- Domain verification may be required

#### Authorized Domains
Add your domains:
```
cvapplyr.com
railway.app
```

#### Scopes
Configure these scopes (minimal required):
```
.../auth/userinfo.email
.../auth/userinfo.profile
openid
```

#### Developer Contact Information
```
Email addresses: [your-email@cvapplyr.com]
```

---

### 5️⃣ Domain Verification (If Required)

Google may require domain verification for production apps.

#### Verify Domain Ownership:

1. **Go to:** https://search.google.com/search-console
2. **Add Property:** cvapplyr.com
3. **Verification Methods:**
   
   **Option A: DNS Verification (Recommended)**
   - Google provides a TXT record
   - Add to your GoDaddy DNS settings:
   ```
   Type: TXT
   Name: @
   Value: google-site-verification=XXXXXXXXXXXXX
   TTL: 1 Hour
   ```

   **Option B: HTML File Upload**
   - Download verification file from Google
   - Upload to your website root: `https://cvapplyr.com/google1234567890.html`

   **Option C: HTML Meta Tag**
   - Add meta tag to your homepage `<head>` section:
   ```html
   <meta name="google-site-verification" content="XXXXXXXXXXXXX" />
   ```

4. **Click Verify** in Search Console

---

### 6️⃣ Update Your Application Code

Your current code should work, but verify these settings:

**File:** `public/js/auth.js` (or wherever OAuth is initialized)

```javascript
const CLIENT_ID = '832256639733-f3931pli3e13dijpkpehm799pkqll5sq.apps.googleusercontent.com';

// Initialize Google OAuth
google.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: handleCredentialResponse,
    auto_select: false,
    cancel_on_tap_outside: true,
    ux_mode: 'popup', // or 'redirect'
    redirect_uri: 'https://cvapplyr.com/auth/google/callback'
});
```

**Backend:** `server.js`

Ensure your backend OAuth verification is correct:
```javascript
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

app.post('/api/auth/google', async (req, res) => {
    const { credential } = req.body;
    try {
        const ticket = await client.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        // ... rest of your code
    } catch (error) {
        console.error('Google OAuth Error:', error);
        res.status(401).json({ error: 'Invalid token' });
    }
});
```

---

### 7️⃣ Environment Variables for Railway

Set these in Railway:

```bash
cd /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app

# Set Google OAuth credentials
railway variables --set "GOOGLE_CLIENT_ID=832256639733-f3931pli3e13dijpkpehm799pkqll5sq.apps.googleusercontent.com"
railway variables --set "GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET_HERE"
```

**⚠️ Get Client Secret from:**
1. Google Cloud Console
2. APIs & Services > Credentials
3. Click on your OAuth 2.0 Client ID
4. Copy the "Client Secret" value

---

### 8️⃣ DNS Configuration Checklist

Ensure your GoDaddy DNS is configured:

**For cvapplyr.com:**
```
Type: A or CNAME (depending on Railway requirements)
Name: @
Value: [Railway proxy domain]
TTL: 1 Hour
```

**For www.cvapplyr.com:**
```
Type: CNAME
Name: www
Value: 4gce51gj.up.railway.app
TTL: 1 Hour
```

**For Google Verification (if required):**
```
Type: TXT
Name: @
Value: google-site-verification=XXXXXXXXXXXXX
TTL: 1 Hour
```

---

### 9️⃣ Testing Checklist

After configuration, test these scenarios:

#### Test 1: Direct Domain Access
```bash
curl -I https://cvapplyr.com/
# Should return: HTTP/2 200
```

#### Test 2: WWW Subdomain
```bash
curl -I https://www.cvapplyr.com/
# Should return: HTTP/2 200
```

#### Test 3: Google OAuth Button
1. Open https://cvapplyr.com/login.html
2. Click "Sign in with Google"
3. Should show Google account picker
4. After selection, should redirect to dashboard

#### Test 4: Backend Verification
```bash
# Login and get token
curl -X POST https://cvapplyr.com/api/auth/google \
  -H "Content-Type: application/json" \
  -d '{"credential":"GOOGLE_ID_TOKEN_HERE"}'

# Should return: {"token":"JWT_TOKEN","user":{...}}
```

---

### 🔟 Common Issues & Solutions

#### Issue 1: "Unauthorized JavaScript Origin"
**Error:** `origin_mismatch` or `redirect_uri_mismatch`

**Solution:**
- Verify exact URL match in Google Console (no typos)
- Check for trailing slashes (shouldn't have them)
- Ensure protocol is `https://` not `http://`
- Wait 5-10 minutes for Google to propagate changes

#### Issue 2: "App Not Verified"
**Error:** Google shows warning "This app isn't verified"

**Solution:**
- Complete OAuth consent screen with all required fields
- Add Privacy Policy and Terms of Service URLs
- Submit app for verification (may take 1-4 weeks)
- For now, click "Advanced" → "Go to CVApplyr (unsafe)" during testing

#### Issue 3: "Access Blocked: Authorization Error"
**Error:** `access_blocked: This app's request is invalid`

**Solution:**
- Ensure app is published (not in "Testing" mode)
- Or add test users in OAuth consent screen
- Verify all required scopes are enabled

#### Issue 4: Domain Not Verified
**Solution:**
- Complete domain verification in Google Search Console
- Add verification TXT record to DNS
- Wait 24-48 hours for verification

---

## 📝 Quick Copy-Paste Values

### For Google Cloud Console:

**Authorized JavaScript Origins:**
```
https://cvapplyr.com
https://www.cvapplyr.com
https://cvapplyr-website-production.up.railway.app
```

**Authorized Redirect URIs:**
```
https://cvapplyr.com/auth/google/callback
https://www.cvapplyr.com/auth/google/callback
https://cvapplyr-website-production.up.railway.app/auth/google/callback
https://cvapplyr.com/auth-success.html
https://www.cvapplyr.com/auth-success.html
```

**Authorized Domains:**
```
cvapplyr.com
railway.app
```

---

## 🚀 Deployment Steps

1. **Update Google Cloud Console** (Steps 1-4 above)
2. **Verify domain** (if required)
3. **Set Railway environment variables**
4. **Deploy latest code:** `railway up`
5. **Test OAuth flow** on production domain
6. **Monitor Railway logs:** `railway logs`

---

## 📞 Support

If you encounter issues:
- Check Railway logs: `railway logs`
- Check browser console for JavaScript errors
- Verify DNS propagation: `nslookup cvapplyr.com`
- Test OAuth token: Use JWT debugger at https://jwt.io

---

## ✅ Final Checklist

- [ ] Added all production domains to Google Console
- [ ] Added all redirect URIs to Google Console
- [ ] Configured OAuth consent screen
- [ ] Set app to "In Production" mode
- [ ] Verified domain ownership (if required)
- [ ] Added Privacy Policy and Terms pages
- [ ] Set GOOGLE_CLIENT_ID in Railway
- [ ] Set GOOGLE_CLIENT_SECRET in Railway
- [ ] Deployed latest code to Railway
- [ ] Tested OAuth login on production domain
- [ ] DNS records pointing to Railway
- [ ] SSL certificates active (https working)

---

**🎉 Once all steps are complete, your Google OAuth will work on cvapplyr.com!**
