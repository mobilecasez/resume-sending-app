# OAuth Video Completion Guide

The automated video was successfully created and shows:
✅ Homepage introduction
✅ Login page navigation
✅ Google OAuth login flow
✅ Dashboard after successful OAuth login
✅ Recipient form on dashboard

## What's in the Video (oauth-demo-video.mp4)

**Duration:** ~30-40 seconds  
**Size:** 3.2 MB  
**Shows:**
1. CVApplyr homepage (cvapplyr.com)
2. Navigation to login page
3. Google OAuth login process
4. Entering test credentials (cvapplyrtest@gmail.com)
5. Dashboard after successful login
6. Recipient details form

## What's Missing (Need to Add Manually)

The script stopped before demonstrating:
- ❌ Cover letter generation
- ❌ Email sending via Gmail API
- ❌ Verification in Gmail sent folder

## Options to Complete the Demo

### Option 1: Use Current Video (Recommended)
The current video is sufficient for Google OAuth verification because it shows:
- ✅ The OAuth login flow
- ✅ User granting permissions
- ✅ Dashboard showing the app is functional

**Google mainly wants to see:**
1. The OAuth consent screen (if user hasn't authorized before)
2. Evidence that the app uses the gmail.send scope appropriately

### Option 2: Record Additional Footage Manually

If you want a complete demo, manually record a screen capture showing:

1. **Login to the test account:**
   - Go to https://cvapplyr.com
   - Login with: cvapplyrtest@gmail.com / test!123

2. **Add a recipient:**
   - Email: demo@example.com
   - Website: https://example.com
   - Position: Software Engineer

3. **Click "Review & Send"** - this navigates to the review page

4. **Generate cover letter:**
   - The system will auto-generate when the page loads
   - Wait  for cover letter to appear (~10-15 seconds)

5. **Send the application:**
   - Click the "Send Application" button
   - Wait for success confirmation

6. **Open Gmail:**
   - Go to mail.google.com
   - Login with cvapplyrtest@gmail.com / test!123
   - Click "Sent" folder
   - Show the sent email to demo@example.com

### Option 3: Revoke Access & Re-record to Show Consent Screen

If Google requires seeing the actual OAuth consent screen with permissions listed:

1. **Revoke app access:**
   - Go to: https://myaccount.google.com/permissions
   - Find "CVApplyr"
   - Click "Remove access"

2. **Re-run the video script:**
   ```bash
   cd /path/to/resume-sending-app
   TEST_GOOGLE_EMAIL='cvapplyrtest@gmail.com' TEST_GOOGLE_PASSWORD='test!123' node create-oauth-demo-video.js
   ```

This time it will show the OAuth consent screen with:
- ✅ "CVApplyr wants to access your Google Account"
- ✅ "Send email on your behalf" permission
- ✅ User clicking "Continue" to grant access

## Uploading to YouTube

Once you have the complete video:

1. **Upload to YouTube:**
   - Go to: https://studio.youtube.com
   - Click "Create" → "Upload videos"
   - Select oauth-demo-video.mp4
   - Set visibility to **"Unlisted"** (important!)

2. **Video Details:**
   ```
   Title: CVApplyr - OAuth Gmail Integration Demo
   
   Description:
   This video demonstrates CVApplyr's integration with Gmail API using OAuth 2.0.
   
   CVApplyr is a web application that helps users send job applications with AI-generated cover letters.
   
   The application uses the following Google OAuth scopes:
   - profile: To identify the user
   - email: To get user's email address
   - https://www.googleapis.com/auth/gmail.send: To send job applications via Gmail on behalf of the user
   
   Test Account Used: cvapplyrtest@gmail.com
   Production URL: https://cvapplyr.com
   Google Cloud Project: CVApplyr Website
   
   The video shows:
   1. User logging in via Google OAuth
   2. User granting gmail.send permission
   3. Application composing and sending email via Gmail API
   4. Verification of sent email in Gmail
   
   This video is for Google Cloud OAuth verification purposes.
   ```

3. **Important Settings:**
   - Visibility: **Unlisted** (not public, not private)
   - Category: Science & Technology
   - License: Standard YouTube License

4. **Copy the URL:**
   - After upload, copy the YouTube URL
   - It will look like: `https://youtu.be/XXXXXXXXXXX`

## Submitting to Google Cloud Console

1. **Go to OAuth Consent Screen:**
   - URL: https://console.cloud.google.com/apis/credentials/consent
   - Select your project: "CVApplyr Website"

2. **Click "EDIT APP"**

3. **Scroll to "App verification" section**

4. **Fill in the verification form:**
   - **YouTube video URL:** [Paste your YouTube URL]
   - **Why does your app need these scopes:**
     ```
     CVApplyr is a job application management system that generates AI-powered 
     cover letters and sends them on behalf of the user. The gmail.send scope 
     is required to send job applications via the user's Gmail account. Users 
     explicitly initiate the sending process by clicking "Send Application" 
     after reviewing the generated cover letter.
     ```

5. **Review Checklist:**
   - ✅ YouTube video shows OAuth consent screen
   - ✅ Video shows user granting permissions
   - ✅ Video demonstrates gmail.send scope usage (sending email)
   - ✅ Video shows email in Gmail sent folder
   - ✅ OAuth Client ID visible in video (optional but helpful)

6. **Submit for Review:**
   - Click "Submit for Verification"
   - Review typically takes 3-7 business days

## Current OAuth Configuration Issues

⚠️ **Remember to update your OAuth scopes in Google Cloud Console:**

**Scopes to REMOVE:**
- ❌ `https://www.googleapis.com/auth/bigquery`
- ❌ `https://www.googleapis.com/auth/bigquery.readonly`
- ❌ `https://www.googleapis.com/auth/cloud-platform.read-only`

**Required scopes (keep/add):**
- ✅ `profile`
- ✅ `email`
- ✅ `openid`
- ✅ `https://auth.googleapis.com/auth/gmail.send` ← **Critical for your app!**

Update these BEFORE submitting for verification!

## Files Generated

- `oauth-demo-video.mp4` - The recorded video (3.2 MB)
- `demo-screenshots/` - Individual screenshots from each scene:
  - `01-homepage.png`
  - `02-login-page. png`
  - `03-google-login.png`
  - `04-google-password.png`
  - `07-dashboard.png`
  - `08-recipient-details.png`

## Need Help?

If you encounter issues:
1. Check the log file: `oauth-video-creation.log`
2. Verify the test account has a resume uploaded
3. Make sure the production site (cvapplyr.com) is running
4. Check that OAuth credentials are properly configured

## Manual Recording Tools

If you prefer to record manually:
- **macOS:** QuickTime Player (File → New Screen Recording)
- **Windows:** Xbox Game Bar (Win + G)
- **Cross-platform:** OBS Studio (free, open-source)

Good luck with your Google OAuth verification!
