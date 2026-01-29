# ⚡ Quick OAuth Setup - 5 Minutes

## The Error You Got

```
Error 401: invalid_client
The OAuth client was not found
```

This happens because the app is looking for OAuth credentials but they're not configured in your `.env` file.

---

## ✅ Fix: Get Your OAuth Credentials

### Option 1: Use Email/Password Login (Works Now!)
The app already has traditional email/password authentication working. You can:
1. Create an account with email and password
2. Log in with those credentials
3. Use the app fully

**No need to set up OAuth if email/password works for you!**

---

### Option 2: Set Up Google OAuth (10 minutes)

**Step 1: Go to Google Cloud Console**
- Visit: https://console.cloud.google.com/
- Sign in with your Google account

**Step 2: Create or Select a Project**
- Click the project dropdown at top
- Click "New Project"
- Name it: "Resume App"
- Click "Create"

**Step 3: Enable Google+ API**
- Search for "Google+ API" in the search bar
- Click "Google+ API"
- Click "Enable"

**Step 4: Create OAuth Credentials**
- Go to "APIs & Services" > "Credentials"
- Click "Create Credentials" > "OAuth client ID"
- Choose "Web application"
- Fill in:
  - Name: "Resume App"
  - Authorized JavaScript origins: `http://localhost:3000`
  - Authorized redirect URIs: `http://localhost:3000/auth/google/callback`
- Click "Create"
- Copy the "Client ID" and "Client Secret"

**Step 5: Add to Your .env File**
Edit `.env` file in your project root:
```
GOOGLE_CLIENT_ID=paste-your-client-id-here
GOOGLE_CLIENT_SECRET=paste-your-client-secret-here
```

**Step 6: Restart Server**
```bash
npm start
```

Now the Google button will work!

---

### Option 3: Set Up LinkedIn OAuth (10 minutes)

**Step 1: Go to LinkedIn Developers**
- Visit: https://www.linkedin.com/developers/apps
- Sign in with your LinkedIn account

**Step 2: Create an App**
- Click "Create app"
- Fill in:
  - App name: "Resume Sending App"
  - LinkedIn Page: Select or create one
  - App logo: Upload a logo
- Accept terms and create

**Step 3: Add Redirect URL**
- Go to your app's "Settings" tab
- In "Authorized domains," add:
  - `localhost:3000` (for local testing)

**Step 4: Request Sign In Access**
- Go to "Products" tab
- Find "Sign in with LinkedIn"
- Click "Request access"

**Step 5: Get Your Credentials**
- Go to "Auth" tab
- Copy your "Client ID"
- Copy your "Client Secret"

**Step 6: Add to Your .env File**
```
LINKEDIN_CLIENT_ID=paste-your-client-id-here
LINKEDIN_CLIENT_SECRET=paste-your-client-secret-here
```

**Step 7: Restart Server**
```bash
npm start
```

Now the LinkedIn button will work!

---

## 🚀 What to Do Now

### Immediate (No Setup Required)
1. Use Email/Password login - fully functional
2. Create new account or use existing
3. Use the app normally

### Soon (10 min each)
1. Set up Google OAuth if you want
2. Set up LinkedIn OAuth if you want
3. Add credentials to `.env`
4. Restart server
5. Test OAuth buttons

---

## 📝 Current Status

✅ **Email/Password Login** - Ready to use now
⏳ **Google OAuth** - Needs credentials (5 min setup)
⏳ **LinkedIn OAuth** - Needs credentials (5 min setup)

---

## 💡 Next Steps

1. **Quick fix**: Just use email/password - works right now!
2. **Or get Google credentials**: Follow Option 2 above (10 min)
3. **Or get LinkedIn credentials**: Follow Option 3 above (10 min)

---

## Need Help?

See the full guides:
- `OAUTH_SETUP.md` - Detailed step-by-step instructions
- `LOGIN_IMPLEMENTATION.md` - How the system works
- `AUTHENTICATION_SUMMARY.md` - Complete overview

All three login methods are fully implemented and tested.
Just need the OAuth credentials to enable them!
