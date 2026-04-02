# Microsoft OAuth Setup Guide for CVApplyr

This guide will help you set up Microsoft OAuth authentication so users can sign in with their Microsoft accounts (Outlook, Hotmail, Office 365, etc.).

## Overview

Microsoft OAuth integration allows:
- Users to sign in with Microsoft accounts (personal or work/school)
- Send job applications via Microsoft Outlook/Office 365 email
- Automatic account creation for new users
- Seamless integration with existing CVApplyr features

## Prerequisites

- Microsoft Azure account (free tier works)
- CVApplyr application running
- Access to environment variables (.env file)

---

## Part 1: Azure AD App Registration

### Step 1: Create Azure AD Application

1. **Go to Azure Portal:**
   - Visit: https://portal.azure.com
   - Sign in with your Microsoft account

2. **Navigate to Azure Active Directory:**
   - Search for "Azure Active Directory" in the top searchbar
   - Click on "Azure Active Directory"

3. **Register a New Application:**
   - Click on "App registrations" in the left sidebar
   - Click "New registration" button

4. **Fill in Application Details:**
   ```
   Name: CVApplyr
   
   Supported account types: 
   ✅ Accounts in any organizational directory (Any Azure AD directory - Multitenant) 
      and personal Microsoft accounts (e.g. Skype, Xbox)
   
   Redirect URI (Web): 
   - Development: http://localhost:3000/auth/microsoft/callback
   - Production: https://cvapplyr.com/auth/microsoft/callback
   ```

5. **Click "Register"**

### Step 2: Configure Redirect URIs

1. **After registration, go to "Authentication" in the left sidebar**

2. **Add Redirect URIs:**
   - Click "Add a platform" → "Web"
   - Add both URLs:
     ```
     http://localhost:3000/auth/microsoft/callback
     https://cvapplyr.com/auth/microsoft/callback
     ```

3. **Configure Implicit Grant and Hybrid Flows:**
   - ✅ Check "Access tokens (used for implicit flows)"
   - ✅ Check "ID tokens (used for implicit and hybrid flows)"

4. **Allow Public Client Flows:**
   - Scroll to bottom → "Allow public client flows" → Set to "Yes"
   - This enables mobile app authentication

5. **Click "Save"**

### Step 3: Create Client Secret

1. **Go to "Certificates & secrets" in the left sidebar**

2. **Create a New Client Secret:**
   - Click "New client secret"
   - Description: `CVApplyr Production`
   - Expires: Choose duration (recommend "24 months")
   - Click "Add"

3. **⚠️ IMPORTANT - Copy the Secret Value:**
   - **Copy the "Value" immediately** (not "Secret ID")
   - You won't be able to see it again!
   - Save it to a secure location

### Step 4: Get Your Client ID

1. **Go to "Overview" in the left sidebar**

2. **Copy Application (client) ID:**
   - You'll see "Application (client) ID" near the top
   - Example: `12345678-1234-1234-1234-123456789012`
   - Save this value

### Step 5: Configure API Permissions

1. **Go to "API permissions" in the left sidebar**

2. **Add Required Permissions:**
   - Click "Add a permission"
   - Choose "Microsoft Graph"
   - Choose "Delegated permissions"
   
3. **Select These Permissions:**
   ```
   ✅ User.Read (Read user profile)
   ✅ Mail.Send (Send mail as user)
   ✅ offline_access (Maintain access to data)
   ```

4. **Grant Admin Consent (Optional but Recommended):**
   - Click "Grant admin consent for [Your Directory]"
   - This pre-approves permissions for all users
   - If you don't do this, users will see consent screen first time

---

## Part 2: Configure CVApplyr Application

### Step 1: Update Environment Variables

Add these variables to your `.env` file:

```bash
# Microsoft OAuth Configuration
MICROSOFT_CLIENT_ID=your-application-client-id-here
MICROSOFT_CLIENT_SECRET=your-client-secret-value-here
```

**Example:**
```bash
MICROSOFT_CLIENT_ID=12345678-1234-1234-1234-123456789012
MICROSOFT_CLIENT_SECRET=xXx~8Q~AbCdEfGhIjKlMnOpQrStUvWxYz1234567890
```

### Step 2: Restart Your Server

```bash
# Stop the server (Ctrl+C if running in foreground)
pkill -f "node server.js"

# Start the server
node server.js

# Or if using PM2
pm2 restart cvapplyr
```

### Step 3: Test Locally

1. **Open your browser:**
   - Go to: http://localhost:3000/login.html

2. **Click "Continue with Microsoft"**

3. **You should see Microsoft login page:**
   - Enter your Microsoft email
   - Enter your password
   - Approve permissions (first time only)

4. **You should be redirected to:**
   - Success page: `auth-success.html`
   - Then automatically to Dashboard

---

## Part 3: Deploy to Production

### Option 1: Railway Deployment

1. **Add Environment Variables to Railway:**
   ```bash
   railway variables set MICROSOFT_CLIENT_ID=your-client-id
   railway variables set MICROSOFT_CLIENT_SECRET=your-client-secret
   ```

2. **Or use Railway Dashboard:**
   - Go to: https://railway.app
   - Select your project
   - Go to "Variables" tab
   - Add:
     ```
     MICROSOFT_CLIENT_ID = your-client-id
     MICROSOFT_CLIENT_SECRET = your-client-secret
     ```

3. **Deploy:**
   ```bash
   git add .
   git commit -m "Add Microsoft OAuth authentication"
   git push origin main
   ```

### Option 2: Manual Deployment

1. **Update production .env file:**
   ```bash
   nano .env
   # Add Microsoft variables
   # Save and exit (Ctrl+X, Y, Enter)
   ```

2. **Restart production server:**
   ```bash
   pm2 restart cvapplyr
   ```

---

## Part 4: Testing

### Test Web OAuth Flow

1. **Go to production URL:**
   - https://cvapplyr.com/login.html

2. **Click "Continue with Microsoft"**

3. **Expected behavior:**
   - Redirects to Microsoft login
   - User logs in
   - Redirects back to CVApplyr
   - User is logged in

### Test Email Sending (Outlook Integration)

1. **After logging in with Microsoft:**
   - Upload your resume
   - Add a job recipient
   - Generate cover letter
   - Click "Send Application"

2. **Expected behavior:**
   - Email sent via Microsoft Graph API using user's Outlook account
   - Email appears in user's "Sent Items" folder in Outlook

---

## Part 5: Scope Justification for Microsoft Verification

If Microsoft requests verification for your OAuth scopes, use this justification:

```
CVApplyr is a job application management platform that helps job seekers send 
professional job applications through their personal email accounts.

SCOPE JUSTIFICATIONS:

1. User.Read (Required):
   - To identify the user and retrieve their profile information
   - Display user's name and email in the application
   - Create user account on first login

2. Mail.Send (Required):
   - Core functionality of CVApplyr
   - Users explicitly click "Send Application" after reviewing AI-generated cover letters
   - Sends job applications on behalf of the user through their Outlook/Microsoft account
   - Applications MUST come from user's personal email for credibility with hiring managers
   - Maintains email thread continuity when employers reply

3. offline_access (Required):
   - Required to obtain refresh tokens for persistent access
   - Allows users to stay logged in without frequent re-authentication
   - Essential for practical usability of the application

USER CONTROL:
- Users explicitly review each cover letter before sending
- No automated or bulk sending without direct user action
- Users can revoke access anytime via Microsoft Account settings

SECURITY:
- Minimal scope request (only what's necessary for core functionality)
- No access to read, modify, or delete existing emails
- Only permission to send emails that users explicitly approve
- Full compliance with Microsoft identity platform best practices

CANNOT FUNCTION WITHOUT THESE SCOPES:
The Mail.Send scope is the core value proposition of CVApplyr. Alternative methods 
(third-party email services) would harm user credibility with employers by showing 
non-personal sender addresses.
```

---

## Troubleshooting

### Error: "AADSTS50011: The reply URL specified in the request does not match the reply URLs configured"

**Solution:**
- Check Azure Portal → App Registration → Authentication
- Ensure BOTH URLs are added:
  - `http://localhost:3000/auth/microsoft/callback`
  - `https://cvapplyr.com/auth/microsoft/callback`
- Save changes and wait 5 minutes for propagation

### Error: "invalid_client" or "unauthorized_client"

**Solution:**
- Verify `MICROSOFT_CLIENT_ID` matches Azure Portal "Application (client) ID"
- Verify `MICROSOFT_CLIENT_SECRET` is correct (regenerate if unsure)
- Check .env file has no extra spaces or quotes around values

### Error: "consent_required" or "interaction_required"

**Solution:**
- API permissions not granted
- Go to Azure Portal → API permissions → Click "Grant admin consent"
- Or user needs to accept consent screen on first login

### Users Can't Send Emails

**Solution:**
1. **Check scopes in Azure Portal:**
   - Go to API permissions
   - Ensure `Mail.Send` is listed
   - Grant admin consent if not already done

2. **Check token in database:**
   ```sql
   SELECT id, email, oauth_provider, microsoft_access_token 
   FROM users 
   WHERE oauth_provider = 'microsoft';
   ```
   - Should have `microsoft_access_token` value

3. **Test Graph API manually:**
   ```bash
   curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
        https://graph.microsoft.com/v1.0/me
   ```

### Login Button Not Showing

**Solution:**
- Clear browser cache
- Check `public/login.html` has Microsoft button:
  ```html
  <a href="/auth/microsoft" class="oauth-btn">
      Continue with Microsoft
  </a>
  ```
- Restart server after adding button

---

## Security Best Practices

1. **Keep Client Secret Secure:**
   - Never commit to Git
   - Use environment variables
   - Rotate regularly (every 6 months)

2. **Use HTTPS in Production:**
   - Microsoft requires HTTPS for production redirects
   - Use Railway, Vercel, or similar with automatic HTTPS

3. **Monitor API Usage:**
   - Check Azure Portal → App Registration → Usage & insights
   - Set up alerts for unusual activity

4. **Implement Rate Limiting:**
   - Already implemented in CVApplyr
   - Prevents abuse of sending endpoints

---

## Verification Status

CVApplyr supports both **unverified** and **verified** apps:

### Unverified App (Default)
- Users see "This app isn't verified" warning
- Users must click "Advanced" → "Go to CVApplyr (unsafe)"
- Fully functional, just requires extra click

### Verified App (Optional)
- No warning message
- Better user experience
- Required for public deployment

### To Get Verified (Optional):

1. **Submit for Publisher Verification:**
   - Go to Azure Portal → App Registration → Branding
   - Click "Add to publish verification"
   - Provide business documentation

2. **Microsoft Review Process:**
   - Takes 2-4 weeks
   - May require business email domain verification
   - May request additional documentation

**Note:** Verification is optional. Unverified apps work perfectly fine for most use cases.

---

## Next Steps

After completing Microsoft OAuth setup:

1. ✅ Test login with personal Microsoft account (@outlook.com, @hotmail.com)
2. ✅ Test login with work/school account (@yourcompany.com)
3. ✅ Test sending job applications via Outlook
4. ✅ Verify emails appear in Sent Items
5. ✅ Update login page branding (optional)
6. ✅ Submit for verification (optional, when ready for public launch)

---

## Support

If you encounter issues:

1. **Check server logs:**
   ```bash
   tail -f server.log
   # Or
   railway logs --tail 100
   ```

2. **Check Azure Portal logs:**
   - App Registration → Sign-in logs
   - Shows authentication attempts and errors

3. **Test endpoints manually:**
   ```bash
   # Test OAuth initiation
   curl http://localhost:3000/auth/microsoft
   
   # Test Graph API (with token)
   curl -H "Authorization: Bearer TOKEN" \
        https://graph.microsoft.com/v1.0/me
   ```

---

## Summary

You've successfully set up Microsoft OAuth! Users can now:

✅ Sign in with Microsoft accounts (Outlook, Hotmail, Office 365)
✅ Send job applications via their Microsoft email
✅ Access all CVApplyr features seamlessly

**Environment Variables Added:**
- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`

**Azure Resources Created:**
- App Registration
- Client Secret
- API Permissions (User.Read, Mail.Send, offline_access)

**CVApplyr Changes:**
- Microsoft login button on login page
- Microsoft OAuth routes
- Database columns for Microsoft tokens
- Integration with Microsoft Graph API for email sending
