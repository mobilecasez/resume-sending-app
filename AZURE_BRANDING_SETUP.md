# Azure AD Branding & Policy URLs Setup

## Issue: "Terms of Service URL not provided" Error

When users log in with Microsoft OAuth, they may see an error about missing Terms of Service or Privacy Policy URLs. This is because Azure AD requires these URLs to be configured in your app registration.

## Steps to Fix

### 1. Navigate to Azure Portal

1. Go to https://portal.azure.com
2. Sign in with your Microsoft account
3. Search for "Azure Active Directory"
4. Click "App registrations"
5. Select your **CVApplyr** app

### 2. Configure Branding URLs

1. In the left sidebar, click **"Branding & properties"**

2. Fill in the following URLs:

   ```
   Name: CVApplyr
   
   Publisher domain: cvapplyr.com
   
   Home page URL: https://cvapplyr.com
   
   Terms of service URL: https://cvapplyr.com/terms-of-service.html
   
   Privacy statement URL: https://cvapplyr.com/privacy-policy.html
   
   Support URL: https://cvapplyr.com/support
   
   Marketing URL: https://cvapplyr.com
   ```

3. **Click "Save"**

### 3. Verify the Changes

1. Log out of your CVApplyr account
2. Log back in with Microsoft OAuth
3. You should now see proper branding with links to Terms and Privacy Policy
4. The error should be gone!

## For Local Development

If testing locally, use localhost URLs:

```
Terms of service URL: http://localhost:3000/terms-of-service.html
Privacy statement URL: http://localhost:3000/privacy-policy.html
Support URL: http://localhost:3000
```

## Important Notes

- ✅ These URLs must be publicly accessible
- ✅ Use HTTPS in production
- ✅ Links will appear in Microsoft's consent screen
- ✅ Required for production apps
- ⚠️ Changes may take 5-10 minutes to propagate

## Verification

After configuring, when users sign in with Microsoft, they will see:
- Your app name and logo
- Links to Terms of Service
- Links to Privacy Policy
- Professional consent screen

This improves trust and compliance with Microsoft's OAuth requirements.
