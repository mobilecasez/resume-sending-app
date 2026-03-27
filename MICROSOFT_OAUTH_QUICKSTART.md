# Microsoft OAuth - Quick Setup Checklist

## ✅ What's Been Implemented

Your CVApplyr application now supports Microsoft OAuth login! Here's what was added:

### Code Changes:
1. ✅ **Database Schema Updated**
   - Added `microsoft_access_token` column to users table
   - Added `microsoft_refresh_token` column to users table
   - Migration runs automatically on server startup

2. ✅ **Server Configuration**
   - Installed `passport-microsoft` package
   - Added Microsoft OAuth strategy configuration
   - Created Microsoft callback routes
   - Updated user authentication flow

3. ✅ **Authentication Routes**
   - `/auth/microsoft` - Initiates Microsoft login
   - `/auth/microsoft/callback` - Handles OAuth return
   - Mobile API endpoints for React Native apps

4. ✅ **UI Updates**
   - Added "Continue with Microsoft" button on login page
   - Microsoft logo SVG included
   - Styled consistently with Google OAuth button

5. ✅ **Auth Controller**
   - `microsoftCallback()` - Web OAuth handler
   - `microsoftAuth()` - Mobile API handler
   - Automatic account creation for new users
   - Token storage and management

---

## 🚀 Next Steps: Azure AD Configuration

Follow these steps in order:

### [ ] Step 1: Create Azure AD Application (15 minutes)

1. **Go to Azure Portal**
   - Visit: https://portal.azure.com
   - Sign in with your Microsoft account

2. **Create App Registration**
   - Search "Azure Active Directory" → "App registrations" → "New registration"
   - Name: `CVApplyr`
   - Supported account types: **"Accounts in any organizational directory and personal Microsoft accounts"**
   - Redirect URI (Web): 
     ```
     http://localhost:3000/auth/microsoft/callback
     ```
   - Click "Register"

3. **Add Production Redirect URI**
   - After registration, go to "Authentication"
   - Click "Add a platform" → "Web"
   - Add URL: `https://cvapplyr.com/auth/microsoft/callback`
   - Enable implicit grant: ✅ Access tokens, ✅ ID tokens
   - Click "Save"

### [ ] Step 2: Get Client ID and Secret (5 minutes)

1. **Copy Application (client) ID**
   - Go to "Overview" tab
   - Copy the "Application (client) ID" (looks like: `12345678-abcd-...`)

2. **Create Client Secret**
   - Go to "Certificates & secrets"
   - Click "New client secret"
   - Description: `CVApplyr Production`
   - Expires: 24 months (recommended)
   - Click "Add"
   - **⚠️ IMPORTANT:** Copy the "Value" immediately (you won't see it again!)

### [ ] Step 3: Configure API Permissions (5 minutes)

1. **Add Microsoft Graph Permissions**
   - Go to "API permissions"
   - Click "Add a permission" → "Microsoft Graph" → "Delegated permissions"
   - Select:
     - ✅ `User.Read` (Read user profile)
     - ✅ `Mail.Send` (Send mail as user)
     - ✅ `offline_access` (Maintain access to data)
   - Click "Add permissions"

2. **Grant Admin Consent** (Recommended)
   - Click "Grant admin consent for [Your Directory]"
   - This pre-approves permissions for all users

### [ ] Step 4: Update Environment Variables (2 minutes)

Add these to your `.env` file:

```bash
# Microsoft OAuth Configuration
MICROSOFT_CLIENT_ID=paste-your-application-client-id-here
MICROSOFT_CLIENT_SECRET=paste-your-client-secret-value-here
```

**Example:**
```bash
MICROSOFT_CLIENT_ID=12345678-1234-1234-1234-123456789012
MICROSOFT_CLIENT_SECRET=xXx~8Q~AbCd1234567890EfGhIjKlMnOp
```

### [ ] Step 5: Restart Local Server (1 minute)

```bash
# Kill existing server
pkill -f "node server.js"

# Start server
node server.js
```

### [ ] Step 6: Test Locally (3 minutes)

1. **Open browser:**
   ```
   http://localhost:3000/login.html
   ```

2. **Click "Continue with Microsoft"**

3. **Expected flow:**
   - Redirects to Microsoft login page
   - Enter Microsoft email/password
   - Approve permissions (first time only)
   - Redirects back to CVApplyr
   - Shows auth-success.html
   - Automatically goes to dashboard

4. **Test email sending:**
   - Upload resume
   - Add job recipient
   - Generate cover letter
   - Click "Send" → Email sent via Outlook!

### [ ] Step 7: Deploy to Production (5 minutes)

**Option A: Railway**
```bash
railway variables set MICROSOFT_CLIENT_ID=your-client-id
railway variables set MICROSOFT_CLIENT_SECRET=your-secret

git add .
git commit -m "Add Microsoft OAuth authentication"
railway up
```

**Option B: Manual**
```bash
# Update production .env file
nano /path/to/production/.env
# Add Microsoft variables
# Save and restart server
pm2 restart cvapplyr
```

### [ ] Step 8: Test Production (3 minutes)

1. Go to: https://cvapplyr.com/login.html
2. Click "Continue with Microsoft"
3. Verify login works
4. Test sending email via Outlook

---

## 📖 Full Documentation

For detailed instructions, troubleshooting, and advanced configuration:

📄 **[MICROSOFT_OAUTH_SETUP.md](./MICROSOFT_OAUTH_SETUP.md)**
- Complete step-by-step guide with screenshots
- Troubleshooting common issues
- Security best practices
- Verification process for public apps

---

## 🎯 Summary

**Time to complete:** ~30 minutes total

**What you get:**
- Users can sign in with Microsoft accounts (@outlook.com, @hotmail.com, Office 365)
- Send job applications via user's Outlook/Microsoft email
- Automatic profile creation on first login
- Seamless integration with existing CVApplyr features

**Required:**
- Azure AD application
- Client ID & Secret
- Environment variables configured

**Optional:**
- Microsoft app verification (for public launch, no "unverified app" warning)

---

## ⚡ Quick Commands Reference

```bash
# Install dependencies (already done)
npm install passport-microsoft --save

# Test local server
node server.js

# Check if Microsoft OAuth is working
curl http://localhost:3000/auth/microsoft
# Should redirect to Microsoft login

# Check environment variables
cat .env | grep MICROSOFT

# View server logs
tail -f server.log

# Deploy to Railway
railway up

# Check production status
curl -I https://cvapplyr.com
```

---

## 🆘 Quick Troubleshooting

**Error: "Reply URL mismatch"**
- Add both callback URLs in Azure Portal → Authentication
- Wait 5 minutes for propagation

**Error: "invalid_client"**
- Check MICROSOFT_CLIENT_ID matches Azure Portal
- Verify MICROSOFT_CLIENT_SECRET is correct

**Button not showing**
- Clear browser cache
- Check public/login.html was updated
- Restart server

**Can't send emails**
- Verify Mail.Send permission in Azure Portal
- Grant admin consent for permissions
- Check user has microsoft_access_token in database

---

## 📞 Support

Need help? Check:
1. **[MICROSOFT_OAUTH_SETUP.md](./MICROSOFT_OAUTH_SETUP.md)** - Full guide
2. Server logs: `tail -f server.log`
3. Azure Portal → Sign-in logs
4. Test Graph API: `curl -H "Authorization: Bearer TOKEN" https://graph.microsoft.com/v1.0/me`

---

**Ready to get started? Follow Step 1 above! 🚀**
