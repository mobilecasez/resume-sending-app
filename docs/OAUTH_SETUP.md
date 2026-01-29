# OAuth Setup Guide

This guide will walk you through setting up Google and LinkedIn OAuth authentication for the Resume Sending App.

## Overview

The application now supports three login methods:
1. **Email/Password** - Traditional local authentication
2. **Google OAuth** - Sign in with Google account
3. **LinkedIn OAuth** - Sign in with LinkedIn account

## Prerequisites

- Node.js and npm installed
- An account with Google and LinkedIn developer platforms
- A web server running (for production, use HTTPS)

---

## Google OAuth Setup

### Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown at the top and select "New Project"
3. Enter a project name (e.g., "Resume Sending App")
4. Click "Create"

### Step 2: Enable Google+ API

1. In the Google Cloud Console, go to **APIs & Services** > **Library**
2. Search for "Google+ API"
3. Click on it and then click "Enable"

### Step 3: Create OAuth 2.0 Credentials

1. Go to **APIs & Services** > **Credentials**
2. Click "Create Credentials" > "OAuth 2.0 Client ID"
3. If prompted, configure the OAuth consent screen first:
   - Select "External" user type
   - Fill in required app information
   - Add your email and any test users
   - Accept default scopes (or add email and profile)
4. After consent screen is configured, create OAuth 2.0 Web Application:
   - Application type: **Web application**
   - Name: "Resume App"
   - Add Authorized JavaScript origins:
     - `http://localhost:3000` (for local development)
     - Your production domain (e.g., `https://yourdomain.com`)
   - Add Authorized redirect URIs:
     - `http://localhost:3000/auth/google/callback`
     - `https://yourdomain.com/auth/google/callback` (for production)
5. Click "Create"
6. Copy the **Client ID** and **Client Secret**

### Step 4: Add Credentials to .env

Create a `.env` file in the project root (copy from `.env.example`):

```
GOOGLE_CLIENT_ID=your-client-id-here
GOOGLE_CLIENT_SECRET=your-client-secret-here
```

---

## LinkedIn OAuth Setup

### Step 1: Create a LinkedIn App

1. Go to [LinkedIn Developers](https://www.linkedin.com/developers/apps)
2. Click "Create app"
3. Fill in the form:
   - **App name**: Resume Sending App
   - **LinkedIn Page**: Select or create a page
   - **App logo**: Upload a logo
4. Accept the terms and create the app

### Step 2: Configure OAuth Redirect URIs

1. In your app's **Settings** tab, find "Authorized domains"
2. Add authorized redirect URLs:
   - `http://localhost:3000` (for local development)
   - Your production domain (e.g., `https://yourdomain.com`)

### Step 3: Request Access to Sign In with LinkedIn

1. Go to the **Products** tab
2. Find "Sign in with LinkedIn"
3. Click "Request access"
4. Complete the verification process

### Step 4: Get Your Credentials

1. Go to the **Auth** tab
2. Copy your **Client ID**
3. Copy your **Client Secret**
4. Verify your redirect URL is set to: `http://localhost:3000/auth/linkedin/callback`

### Step 5: Add Credentials to .env

```
LINKEDIN_CLIENT_ID=your-client-id-here
LINKEDIN_CLIENT_SECRET=your-client-secret-here
```

---

## Installation

After obtaining OAuth credentials, install required packages:

```bash
npm install
```

The application already includes `passport`, `passport-google-oauth20`, and `passport-linkedin-oauth2` in package.json.

---

## Running the Application

1. Create `.env` file with your OAuth credentials
2. Start the server:
   ```bash
   npm start
   ```
3. Open http://localhost:3000 in your browser
4. Click "Login" and you should see three options:
   - Sign in with Google
   - Sign in with LinkedIn
   - Email/Password login

---

## How It Works

### Login Flow

1. **User clicks OAuth button** → Redirected to OAuth provider
2. **User grants permissions** → OAuth provider redirects back to app
3. **App verifies credentials** → Creates/retrieves user account
4. **JWT token generated** → Stored in localStorage
5. **User logged in** → Redirected to dashboard

### Database

OAuth users are automatically created in the database with:
- **full_name**: From OAuth profile
- **email**: From OAuth provider (verified)
- **password**: JWT signature (OAuth users don't use passwords)

Existing email-based users can link OAuth accounts by logging in with the same email address.

---

## Security Considerations

1. **HTTPS Required**: Use HTTPS in production
2. **Environment Variables**: Never commit `.env` files with real credentials
3. **Session Timeout**: Sessions expire after 24 hours
4. **CSRF Protection**: Express-session provides CSRF protection
5. **Scope Minimization**: Only requesting necessary scopes (email and profile)

---

## Testing OAuth Locally

### For Google:
- Use `http://localhost:3000` as your authorized origin
- Google allows localhost for development

### For LinkedIn:
- LinkedIn is more restrictive but allows localhost for testing
- Make sure redirect URL matches exactly

### Test Accounts:
- **Google**: Use your Google account or add test users in OAuth consent screen
- **LinkedIn**: Use your LinkedIn account

---

## Troubleshooting

### "Invalid client_id or client_secret"
- Check that credentials in `.env` match those in Google/LinkedIn console
- Ensure you're using the correct app credentials

### "Redirect URI mismatch"
- Verify the redirect URL in your `.env` matches the authorized redirect URI
- Check spelling and protocol (http vs https)
- No trailing slashes

### "User not found / Account creation failed"
- Check database permissions
- Verify email is returned from OAuth provider
- Check server logs for errors

### OAuth buttons not showing
- Clear browser cache
- Hard refresh the page (Ctrl+Shift+R or Cmd+Shift+R)
- Check browser console for JavaScript errors

---

## Production Deployment

When deploying to production:

1. **Update OAuth credentials** to use production domain
2. **Use HTTPS** - OAuth requires secure connections in production
3. **Set secure environment variables** through your hosting provider
4. **Update redirect URIs** to your production domain
5. **Test thoroughly** before going live

Example production redirect URI:
```
https://yourdomain.com/auth/google/callback
https://yourdomain.com/auth/linkedin/callback
```

---

## Files Modified/Created

- `server.js` - Added Passport configuration and OAuth routes
- `public/login.html` - Added OAuth buttons and styling
- `public/auth-success.html` - New file for OAuth callback handling
- `package.json` - Added passport and strategy packages
- `.env.example` - Updated with OAuth configuration template

---

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review OAuth provider documentation
3. Check server logs for detailed error messages
4. Verify all credentials and URLs are correctly configured
