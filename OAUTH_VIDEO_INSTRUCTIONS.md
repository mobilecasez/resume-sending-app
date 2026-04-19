# OAuth Demo Video Creator - Instructions

## 🎯 Purpose
This script automatically creates a demonstration video for Google Cloud OAuth verification, showing how CVApplyr uses the `gmail.send` scope.

## 📋 Prerequisites

### 1. Create a Test Google Account
**IMPORTANT:** Do NOT use your personal Google account!

1. Go to https://accounts.google.com/signup
2. Create a new test account (e.g., `cvapplyr-demo@gmail.com`)
3. Complete the account setup
4. Enable 2FA if required

### 2. Prepare Test Data
You'll need:
- ✅ Test Google account email and password
- ✅ Your CVApplyr app running (production or local)
- ✅ A test resume uploaded to the test account
- ✅ Internet connection (for Google APIs)

## 🚀 Quick Start

### Step 1: Install Dependencies
```bash
chmod +x setup-video-creator.sh
./setup-video-creator.sh
```

Or manually:
```bash
npm install --save-dev puppeteer puppeteer-screen-recorder
```

### Step 2: Set Environment Variables
```bash
export TEST_GOOGLE_EMAIL='your-test-email@gmail.com'
export TEST_GOOGLE_PASSWORD='your-test-password'
```

Or create a `.env.demo` file:
```
TEST_GOOGLE_EMAIL=cvapplyr-demo@gmail.com
TEST_GOOGLE_PASSWORD=YourSecurePassword123
```

### Step 3: Run Video Creator
```bash
# For production (cvapplyr.com)
node create-oauth-demo-video.js

# For local testing (localhost:3000)
# Edit the script and uncomment the localhost baseUrl
```

### Step 4: Monitor Progress
The script will:
- ✅ Open a browser window (you can watch it work)
- ✅ Navigate through the OAuth flow
- ✅ Record everything as a video
- ✅ Save screenshots for each step
- ✅ Create `oauth-demo-video.mp4`

## 📹 What the Video Shows

1. **Introduction** - CVApplyr homepage
2. **Login Page** - Navigate to login
3. **Google OAuth** - Click "Sign in with Google"
4. **OAuth Consent** - Google permission screen showing scopes
5. **Dashboard** - Successful login
6. **Add Recipient** - Fill in job application details
7. **Generate Letter** - AI cover letter generation
8. **Send via Gmail** - Email sent using Gmail API
9. **Gmail Verification** - Show sent email in Gmail
10. **OAuth Client ID** - Google Cloud Console credentials
11. **Privacy/Security** - Privacy policy and terms pages

## 🎬 Output

After completion, you'll have:
- 📹 `oauth-demo-video.mp4` - Main video file (ready for YouTube)
- 📸 `demo-screenshots/` - Individual screenshots of each step

## 📤 Uploading to YouTube

### 1. Upload Video
1. Go to https://studio.youtube.com
2. Click "Create" → "Upload videos"
3. Select `oauth-demo-video.mp4`

### 2. Video Details
**Title:**
```
CVApplyr - Gmail API OAuth Verification Demo
```

**Description:**
```
CVApplyr OAuth Verification Video

This video demonstrates how CVApplyr (https://cvapplyr.com) uses the gmail.send scope to send job application emails on behalf of users who authorize access via Google OAuth 2.0.

OAuth Client IDs shown in this demo:
- [Your Client ID from Google Cloud Console]

Scopes used:
- userinfo.email
- userinfo.profile
- openid
- https://www.googleapis.com/auth/gmail.send

The application only sends emails when explicitly requested by the user through the "Send Application" button. Users maintain full control and can revoke access at any time through their Google Account settings.

Privacy Policy: https://cvapplyr.com/privacy
Terms of Service: https://cvapplyr.com/terms
Refund Policy: https://cvapplyr.com/refund

Contact: support@cvapplyr.com
Company: zSellr (OPC) Private Limited
```

**Visibility:**
- ⚠️ Set to **"Unlisted"** (NOT Private, NOT Public)

### 3. Submit to Google
1. Copy the YouTube video URL
2. Go to Google Cloud Console → OAuth consent screen
3. Paste the URL in the verification form
4. Submit for review

## 🔧 Troubleshooting

### Video is too fast/slow
Edit `create-oauth-demo-video.js` and adjust `wait()` durations:
```javascript
await wait(3000); // Change duration (milliseconds)
```

### Browser closes too quickly
Increase the final wait time:
```javascript
console.log('📍 Final: Return to Dashboard');
await wait(5000); // Increase this
```

### Google login fails
- Ensure 2FA is configured on test account
- Check if "Less secure app access" needs to be enabled
- Try manually logging in first to verify credentials

### Recording quality issues
Adjust recorder settings in the script:
```javascript
const recorder = {
    width: 1920,  // Increase for higher quality
    height: 1080,
    fps: 60,      // Increase for smoother video
};
```

### OAuth consent not showing
- Revoke previous OAuth permissions for the test account
- Go to: https://myaccount.google.com/permissions
- Remove CVApplyr and re-run the script

## ⏱️ Video Length

Target: **3-5 minutes**
- Too short (<2 min): May not show enough detail
- Too long (>10 min): Google reviewers may not watch fully

## ✅ Checklist Before Submission

- [ ] Video shows actual OAuth client ID from Google Cloud Console
- [ ] Video demonstrates real email sending (not mocked)
- [ ] Sent email is visible in Gmail's Sent folder
- [ ] All scopes are clearly shown in OAuth consent screen
- [ ] Video is set to "Unlisted" on YouTube
- [ ] Video description includes all required information
- [ ] Privacy policy and terms of service are accessible
- [ ] Audio/narration is clear (optional but recommended)

## 🎤 Optional: Add Voice Narration

If you want to add voice-over:

1. Use the video as-is (visual only)
2. Record narration separately using:
   - macOS: QuickTime Player → File → New Audio Recording
   - Windows: Voice Recorder app
   - Online: https://voicerecorder.online

3. Combine using ffmpeg:
```bash
ffmpeg -i oauth-demo-video.mp4 -i narration.mp3 \
  -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 \
  oauth-demo-final.mp4
```

### Sample Narration Script:
```
"Hello, this is a demonstration of CVApplyr's Google OAuth integration.

CVApplyr is a job application platform that helps users send personalized cover letters and resumes to potential employers.

I'll now sign in using Google OAuth... [pause]

As you can see, the OAuth consent screen requests permission to send emails on the user's behalf. This is the gmail.send scope shown here.

After granting permission, I'm logged into the CVApplyr dashboard... [pause]

Now I'll add a job recipient and generate a cover letter using our AI... [pause]

And finally, I'll send the application. This email is sent through the Gmail API using the OAuth token we just authorized... [pause]

Let me verify in Gmail that the email was sent... [pause]

As you can see in the Sent folder, the email was successfully delivered.

Here's the OAuth Client ID from Google Cloud Console that matches our application... [pause]

Thank you for watching. CVApplyr only uses the gmail.send scope to send job applications when explicitly requested by the user."
```

## 📞 Support

If you encounter issues:
1. Check the console output for error messages
2. Review the screenshots in `demo-screenshots/` to see where it failed
3. Adjust wait times or selectors in the script
4. Test manually first to ensure everything works

## 🔒 Security Notes

- Never commit credentials to git
- Delete the test account after verification
- Don't share the video publicly (keep it Unlisted)
- Remove sensitive data from screenshots before sharing

## ⏭️ After Approval

Once Google approves your OAuth scopes:
1. Delete the demo video from YouTube
2. Remove the test account
3. Delete `oauth-demo-video.mp4` and screenshots
4. Remove dev dependencies if not needed:
   ```bash
   npm uninstall puppeteer puppeteer-screen-recorder
   ```

---

**Need help?** Contact: support@cvapplyr.com
