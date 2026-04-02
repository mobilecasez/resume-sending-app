# Gmail OAuth Send Email Setup Guide

## Overview
This application now supports sending emails directly from your Gmail account using OAuth2 authentication. When you log in with Google, the app can send job applications on your behalf using your actual Gmail account.

## ✅ Implementation Complete

### Backend Changes
1. **Database Schema**: Added OAuth token storage columns
   - `oauth_provider` - Stores which OAuth provider (google, etc.)
   - `google_access_token` - Stores Google OAuth access token
   - `google_refresh_token` - Stores refresh token for long-term access

2. **Gmail API Integration**: 
   - Installed `googleapis` package
   - Created `sendEmailViaGmail()` function
   - Created `generateEmailBody()` helper for professional email content
   - Integrated with Gmail API v1

3. **OAuth Token Storage**:
   - Web OAuth: Stores tokens when user logs in via `/auth/google`
   - Mobile OAuth: Stores tokens when mobile app calls `/api/auth/google`
   - Tokens are automatically updated on each login

4. **Send Endpoint Updated**: `/api/send-single-application` now:
   - **Priority 1**: Uses Gmail API if user logged in with Google OAuth
   - **Priority 2**: Falls back to SMTP if OAuth not available
   - Sends professional email body
   - Attaches resume PDF from user profile
   - Attaches cover letter PDF

## 🔧 Google Cloud Console Setup Required

### IMPORTANT: Enable Gmail API Scope

To use Gmail sending, you need to update your Google Cloud Console settings:

1. **Go to Google Cloud Console**:
   - Visit: https://console.cloud.google.com/
   - Select your project (the one with your OAuth Client ID)

2. **Enable Gmail API**:
   - Navigate to: APIs & Services → Library
   - Search for "Gmail API"
   - Click "Gmail API" and then "ENABLE"

3. **Update OAuth Consent Screen**:
   - Go to: APIs & Services → OAuth consent screen
   - Scroll to "Scopes" section
   - Click "ADD OR REMOVE SCOPES"
   - Search and add: `https://www.googleapis.com/auth/gmail.send`
   - This scope allows the app to send emails on behalf of the user
   - Click "UPDATE" at the bottom

4. **Update OAuth Client**:
   - Go to: APIs & Services → Credentials
   - Click on your OAuth 2.0 Client ID
   - No changes needed here, but verify redirect URIs include:
     - `http://localhost:3000/auth/google/callback`
     - `http://192.168.1.11:3000/auth/google/callback` (your IP)

5. **Test User (if app is in testing mode)**:
   - Go to: OAuth consent screen → Test users
   - Add your Gmail address as a test user
   - This is REQUIRED if your app is not published

## 📧 How Email Sending Works

### For OAuth Users (Priority):
1. User logs in with "Sign in with Google" button
2. Access and refresh tokens are stored in database
3. When sending email:
   - Creates OAuth2 client with stored tokens
   - Uses Gmail API to send email from user's Gmail
   - Email appears in user's Sent folder
   - Attachments: Resume + Cover Letter PDF

### Email Content:
- **From**: User's actual Gmail address
- **Subject**: "Application for {Position} - {User Name}"
- **Body**: Professional human-like email:
  ```
  Dear Hiring Manager,

  I hope this email finds you well. I am writing to express my 
  strong interest in the {Position} position at {Company}.

  I have attached my resume and cover letter for your review. 
  I believe my skills and experience make me a strong candidate 
  for this role, and I would welcome the opportunity to discuss 
  how I can contribute to your team.

  Thank you for considering my application. I look forward to 
  hearing from you.

  Best regards,
  {User Full Name}
  ```
- **Attachments**: 
  1. Resume PDF (from user profile)
  2. Cover Letter PDF (generated with company details)

### For Non-OAuth Users (Fallback):
- Uses SMTP settings from user profile
- Requires smtp_email and smtp_password configured
- Sends via traditional SMTP protocol

## 🚀 Testing the Feature

### Web Version Test:
1. Log out if currently logged in
2. Click "Sign in with Google" on login page
3. Grant permissions (including Gmail send scope)
4. Go to Review page
5. Generate a cover letter
6. Click "Send" button
7. Check:
   - Success message appears
   - Email sent from your Gmail
   - Email appears in Gmail Sent folder
   - Recipient receives email with both attachments

### Mobile Version Test:
1. Open MobileApp
2. Log out if logged in
3. Click "Sign in with Google"
4. Approve permissions
5. Generate cover letter
6. Navigate to Review screen
7. Click "Send" button
8. Verify email sent successfully

## 🔍 Troubleshooting

### Error: "OAuth token expired"
- **Solution**: Log out and log in again with Google
- This will refresh the access token

### Error: "SMTP settings required"
- User doesn't have OAuth tokens stored
- **Solution**: Either log in with Google OAuth OR configure SMTP settings

### Error: "Failed to send via Gmail API"
- Check Gmail API is enabled in Google Cloud Console
- Verify scope `https://www.googleapis.com/auth/gmail.send` is added
- Check user is added as test user (if app in testing mode)
- Server will automatically fall back to SMTP if Gmail fails

### Email not in Sent folder:
- Gmail API should automatically save to Sent folder
- If not appearing, check Gmail settings

## 🎯 Next Steps

1. **Enable Gmail API** in Google Cloud Console (see above)
2. **Add Gmail Send Scope** to OAuth consent screen
3. **Test with Web Version**: Log in with Google and send test email
4. **Test with Mobile Version**: Ensure mobile OAuth stores tokens correctly
5. **Verify Email Delivery**: Check recipient inbox and user's Sent folder

## 📝 Technical Details

### OAuth2 Flow:
```
User clicks "Sign in with Google"
    ↓
Google auth page (requests profile, email, gmail.send scopes)
    ↓
User approves
    ↓
Google returns access_token and refresh_token
    ↓
Backend stores tokens in database
    ↓
User clicks "Send"
    ↓
Backend creates OAuth2 client with stored tokens
    ↓
Gmail API sends email from user's Gmail account
```

### Security:
- Access tokens expire after ~1 hour
- Refresh tokens used to get new access tokens
- If refresh fails, user must re-authenticate
- Tokens stored securely in SQLite database

### API Endpoints:
- `GET /auth/google` - Web OAuth initiation
- `GET /auth/google/callback` - Web OAuth callback (stores tokens)
- `POST /api/auth/google` - Mobile OAuth (stores tokens)
- `POST /api/send-single-application` - Send email (uses Gmail API or SMTP)

## ✨ Benefits

1. **Professional**: Emails sent from user's actual Gmail address
2. **Trustworthy**: Recipients see legitimate sender
3. **Tracking**: Sent emails appear in user's Gmail Sent folder
4. **No SMTP Config**: Users don't need to configure SMTP settings
5. **Secure**: Uses Google's OAuth2 security
6. **Automatic Fallback**: Falls back to SMTP if OAuth unavailable

---

**Status**: ✅ Implementation Complete - Ready for Testing
**Last Updated**: January 1, 2026
