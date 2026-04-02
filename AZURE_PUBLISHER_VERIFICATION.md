# Azure Publisher Domain Verification Guide

## Issue Overview

**Current Status:** "The application's consent screen will show 'Unverified'"  
**Current Publisher Domain:** `cvapplyringmail.onmicrosoft.com`  
**Target Publisher Domain:** `cvapplyr.com`

When users log in with Microsoft OAuth, they see an "Unverified" label because your Azure AD app registration is using the default `.onmicrosoft.com` domain instead of your verified custom domain (`cvapplyr.com`).

---

## Why This Matters

### Impact on Users:
- **Trust Issues:** Users see "Unverified" label during Microsoft OAuth login
- **Professional Appearance:** Consent screen shows Microsoft's default domain instead of your brand
- **Security Perception:** Some users may be hesitant to grant permissions to an "Unverified" app

### Benefits of Verification:
- ✅ **Verified Badge:** Consent screen shows "Verified by cvapplyr.com"
- ✅ **Brand Trust:** Your domain name appears prominently
- ✅ **Enterprise Ready:** Required for Microsoft 365 enterprise users
- ✅ **Higher Conversion:** Users more likely to complete OAuth flow

---

## Current vs. Verified Consent Screen

### Before Verification (Current):
```
⚠️ CVApplyr
Unverified
Publisher: cvapplyringmail.onmicrosoft.com

This app would like to:
- Read your profile
- Send emails on your behalf
- Read your email messages
```

### After Verification:
```
✅ CVApplyr
Verified by cvapplyr.com

This app would like to:
- Read your profile
- Send emails on your behalf
- Read your email messages
```

---

## Prerequisites for Publisher Verification

### 1. Microsoft Partner Network (MPN) Account
You need a **free** Microsoft Partner Network (MPN) ID. This is required for publisher verification.

**To get an MPN ID:**
1. Go to: https://partner.microsoft.com/dashboard/account/v3/enrollment/introduction/partnership
2. Sign up for a free Microsoft Partner Network account
3. Complete your organization profile
4. You'll receive an MPN ID (7-digit number)
5. **Cost:** FREE

### 2. Domain Ownership Verification
You must prove you own `cvapplyr.com` by:
- Adding a DNS TXT record, OR
- Adding a verification file to your website

### 3. Azure AD App Registration
Your app must already be registered in Azure AD (✅ Already done - CVApplyr app exists)

---

## Step-by-Step Publisher Verification Process

### Step 1: Create Microsoft Partner Network Account

1. **Go to MPN Portal:**
   - Visit: https://partner.microsoft.com/dashboard/account/v3/enrollment/introduction/partnership
   - Sign in with your Microsoft account (same one you use for Azure Portal)

2. **Choose Account Type:**
   - Select: **"I am enrolling on behalf of my company"**
   - Company Name: `zSellr Enterprises LLP`
   - Country: India
   - Business Email: Your business email

3. **Complete Company Profile:**
   - Address: Gurgaon, Haryana, India
   - Phone number
   - Company website: `https://cvapplyr.com`

4. **Accept Agreement:**
   - Accept Microsoft Partner Network Agreement
   - Complete the free enrollment

5. **Get Your MPN ID:**
   - After enrollment, you'll see your MPN ID (7-digit number)
   - **Write this down** - you'll need it for verification

**Time Required:** 15-20 minutes  
**Cost:** FREE

---

### Step 2: Verify Domain Ownership

You need to prove you own `cvapplyr.com`. Choose ONE method:

#### Option A: DNS TXT Record (Recommended)

1. **Generate Verification Token:**
   - Go to Azure Portal → Azure AD → App registrations → CVApplyr
   - Click "Branding & properties"
   - Click "Update domain" next to publisher domain
   - Enter domain: `cvapplyr.com`
   - You'll see a verification token like: `MS=ms12345678`

2. **Add DNS TXT Record:**
   - Log in to your domain registrar (GoDaddy, Namecheap, etc.)
   - Go to DNS Management for `cvapplyr.com`
   - Add a new TXT record:
     ```
     Type: TXT
     Host: @ (or leave blank for root domain)
     Value: MS=ms12345678 (use your actual token)
     TTL: 3600 (or default)
     ```

3. **Wait for DNS Propagation:**
   - DNS changes take 5-60 minutes to propagate
   - Check status: https://dnschecker.org

4. **Verify in Azure:**
   - Return to Azure Portal
   - Click "Verify" button
   - Azure will check for the TXT record
   - If successful, domain is verified ✅

**Time Required:** 30-60 minutes (including DNS propagation)

#### Option B: HTML File Upload

1. **Generate Verification File:**
   - Azure will provide a file like: `microsoft-verification-ms12345678.html`
   - Download this file

2. **Upload to Your Website:**
   - Upload file to root of your website
   - URL should be: `https://cvapplyr.com/microsoft-verification-ms12345678.html`
   - Ensure file is publicly accessible

3. **Verify in Azure:**
   - Click "Verify" button in Azure Portal
   - Azure will check if file is accessible
   - If successful, domain is verified ✅

**Time Required:** 10-15 minutes

---

### Step 3: Complete Publisher Verification

1. **Navigate to App Registration:**
   - Azure Portal → Azure AD → App registrations → CVApplyr

2. **Go to Branding Section:**
   - Click "Branding & properties" in left sidebar

3. **Start Verification Process:**
   - Scroll to "Publisher verification" section
   - Click "Add MPN ID and verify"

4. **Enter MPN ID:**
   - Enter your 7-digit MPN ID from Step 1
   - Verified domain should already be selected: `cvapplyr.com`

5. **Submit for Verification:**
   - Click "Verify"
   - Microsoft will review your submission

6. **Wait for Approval:**
   - **Automated Verification:** If you meet all criteria, approval is instant
   - **Manual Review:** Some applications require manual review (1-3 business days)
   - You'll receive an email when verification is complete

7. **Check Status:**
   - Return to "Branding & properties"
   - Look for green checkmark: ✅ Verified

---

## After Verification

### Update Publisher Domain

Once verified, update your app's publisher domain:

1. **Azure Portal → Azure AD → App registrations → CVApplyr**
2. **Branding & properties**
3. **Publisher domain:** Change from `cvapplyringmail.onmicrosoft.com` to `cvapplyr.com`
4. **Click "Save"**

### Verify Changes

1. **Test OAuth Login:**
   - Log out of CVApplyr
   - Log back in with Microsoft OAuth
   - Consent screen should now show:
     ```
     ✅ CVApplyr
     Verified by cvapplyr.com
     ```

2. **Check for "Unverified" Label:**
   - Should be gone ✅
   - Users will now see "Verified" badge

---

## Troubleshooting

### Issue: MPN Enrollment Fails
**Solution:**
- Ensure you're using a business email (not personal Gmail/Outlook)
- Complete all required company profile fields
- Use official company address and phone number

### Issue: Domain Verification Fails (DNS Method)
**Solution:**
- Wait longer for DNS propagation (can take up to 24 hours)
- Check TXT record: `nslookup -type=TXT cvapplyr.com`
- Ensure no typos in verification token
- Use `@` for host (not `cvapplyr.com`)

### Issue: Domain Verification Fails (HTML Method)
**Solution:**
- Ensure file is in website root: `https://cvapplyr.com/microsoft-verification-xxxxx.html`
- Check file is publicly accessible (open URL in browser)
- Ensure no authentication/login required to access file
- Check file permissions (should be readable)

### Issue: Publisher Verification Pending Review
**Solution:**
- Wait 1-3 business days for manual review
- Check email for requests for additional information
- Ensure MPN profile is complete and accurate

### Issue: Can't Find MPN ID
**Solution:**
- Log in to: https://partner.microsoft.com/dashboard
- Go to "Settings" → "Account Settings" → "Organization Profile"
- MPN ID will be displayed at the top

---

## Costs and Timeline

### Costs:
- **Microsoft Partner Network:** FREE ✅
- **Domain Verification:** FREE ✅
- **Publisher Verification:** FREE ✅

**Total Cost:** $0

### Timeline:
- MPN Enrollment: 15-20 minutes
- Domain Verification: 30-60 minutes (DNS propagation)
- Publisher Verification: Instant to 3 business days
- **Total Time:** 1 hour to 3 business days

---

## Alternative: Keep Current Domain (Not Recommended)

If you choose NOT to verify, you can keep using `cvapplyringmail.onmicrosoft.com`:

### Pros:
- No setup required
- App works immediately

### Cons:
- ❌ Shows "Unverified" label
- ❌ Less professional appearance
- ❌ Lower user trust
- ❌ Some enterprise users may block unverified apps
- ❌ Doesn't match your brand (cvapplyr.com)

**Recommendation:** Complete publisher verification for professional, trustworthy OAuth experience.

---

## Quick Reference

### Key URLs:
- **Azure Portal:** https://portal.azure.com
- **Partner Network:** https://partner.microsoft.com/dashboard
- **Domain Verification Check:** https://dnschecker.org
- **Google Account Permissions:** https://myaccount.google.com/permissions
- **Microsoft Account Permissions:** https://account.microsoft.com/privacy/app-access

### Current Configuration:
- **App Name:** CVApplyr
- **Client ID:** 9205782b-1a57-4c2f-bbfd-8136b5378e96
- **Current Publisher Domain:** cvapplyringmail.onmicrosoft.com
- **Target Publisher Domain:** cvapplyr.com
- **Status:** Unverified (needs MPN ID and domain verification)

### After Verification:
- **Publisher Domain:** cvapplyr.com
- **MPN ID:** [Your 7-digit number]
- **Status:** ✅ Verified
- **Consent Screen:** Shows "Verified by cvapplyr.com"

---

## Need Help?

If you encounter issues during verification:

1. **Azure Support:** https://azure.microsoft.com/support/
2. **Partner Network Support:** https://partner.microsoft.com/support
3. **Documentation:** https://docs.microsoft.com/azure/active-directory/develop/publisher-verification-overview

---

## Summary

To fix the "Unverified" issue:

1. ✅ **Sign up for Microsoft Partner Network** (FREE, 15 mins)
2. ✅ **Get your MPN ID** (7-digit number)
3. ✅ **Verify domain ownership** via DNS TXT record (30-60 mins)
4. ✅ **Submit for publisher verification** (instant to 3 days)
5. ✅ **Update publisher domain** to cvapplyr.com
6. ✅ **Test OAuth login** - "Verified" badge should appear

**Total Time:** 1 hour to 3 business days  
**Total Cost:** $0 (FREE)  
**Result:** Professional, verified OAuth consent screen that builds user trust

---

*Last Updated: March 25, 2026*
