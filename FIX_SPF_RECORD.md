# Fix SPF Record - Step by Step Guide

## Issue
Your SPF record doesn't include the Zoho server IP (103.117.158.14), causing emails to fail SPF checks.

## Current SPF Record
```
v=spf1 include:zoho.com ~all
```

## Required SPF Record
```
v=spf1 include:zoho.com ip4:103.117.158.14 ~all
```

---

## Step-by-Step Instructions

### Step 1: Access GoDaddy DNS Settings

1. Go to https://dcc.godaddy.com/
2. Log in to your account
3. Click **Domain Portfolio** or **My Domains**
4. Find **cvapplyr.com** and click **DNS** or **Manage**

### Step 2: Find Your Current SPF Record

1. Scroll down to **DNS Records** section
2. Look for a **TXT** record with:
   - **Type**: TXT
   - **Name**: @ (or cvapplyr.com)
   - **Value**: `v=spf1 include:zoho.com ~all`

### Step 3: Edit the SPF Record

**Option A: Edit Existing Record (Recommended)**

1. Click the **pencil icon** (Edit) next to the SPF TXT record
2. Change the **Value** from:
   ```
   v=spf1 include:zoho.com ~all
   ```
   to:
   ```
   v=spf1 include:zoho.com ip4:103.117.158.14 ~all
   ```
3. Keep TTL as **1 Hour** or **3600**
4. Click **Save**

**Option B: Delete and Recreate**

If editing doesn't work:
1. **Delete** the old SPF TXT record
2. Click **Add** → Select **TXT**
3. Enter:
   - **Type**: TXT
   - **Host**: @ (or leave blank)
   - **TXT Value**: `v=spf1 include:zoho.com ip4:103.117.158.14 ~all`
   - **TTL**: 1 Hour
4. Click **Save**

### Step 4: Verify the Change

Wait 15-30 minutes, then verify:

**Method 1: Command Line**
```bash
dig +short TXT cvapplyr.com
```
Should show: `"v=spf1 include:zoho.com ip4:103.117.158.14 ~all"`

**Method 2: Online Tool**
- Visit: https://mxtoolbox.com/spf.aspx
- Enter: `cvapplyr.com`
- Click **SPF Record Lookup**
- Verify it shows the new IP

**Method 3: Mail-Tester**
- Send another test email to mail-tester.com
- SPF should now show **PASS** ✓

---

## What Changed?

**Before**: 
```
v=spf1 include:zoho.com ~all
```
This only trusts Zoho's default servers.

**After**:
```
v=spf1 include:zoho.com ip4:103.117.158.14 ~all
```
This trusts:
- All Zoho servers (`include:zoho.com`)
- The specific Zoho server sending your emails (`ip4:103.117.158.14`)

---

## Understanding SPF Components

| Component | Meaning |
|-----------|---------|
| `v=spf1` | SPF version 1 |
| `include:zoho.com` | Trust all Zoho mail servers |
| `ip4:103.117.158.14` | Trust this specific IP address |
| `~all` | Soft fail - mark as suspicious if doesn't match (safer than `-all`) |

---

## Troubleshooting

### "I don't see any SPF record"
- Add a new TXT record with the values above
- Make sure Host is **@** (represents root domain)

### "Changes not showing up"
- DNS changes take time (up to 48 hours, usually 15-30 minutes)
- Clear your DNS cache: `sudo dscacheutil -flushcache` (macOS)
- Check with different DNS checker: https://dnschecker.org

### "Multiple TXT records exist"
- You can only have ONE SPF record per domain
- Delete duplicates, keep only the one with the correct value

### "Still showing softfail"
- Verify exact syntax (no extra spaces)
- Ensure IP is correct: `103.117.158.14`
- Check that `~all` is at the end

---

## Expected Result

After fixing SPF:
- ✅ SPF Status: **PASS**
- ✅ Mail-tester score: +3 points (from -3 to 0)
- ✅ Emails less likely marked as spam
- ✅ Better sender reputation

---

## Additional Notes

### When to Update SPF Again

Update your SPF record if:
- You change email providers
- Zoho assigns you a different server IP
- You add another email service (e.g., Mailchimp, SendGrid)

### Alternative Format (if server IP changes frequently)

If Zoho changes your server IP often, use only:
```
v=spf1 include:zoho.com -all
```
This trusts ALL Zoho servers (more flexible but slightly less secure).

---

**Need Help?**
- GoDaddy Support: https://www.godaddy.com/help
- SPF Syntax Checker: https://www.kitterman.com/spf/validate.html
- Zoho SPF Guide: https://www.zoho.com/mail/help/adminconsole/spf-configuration.html

**Last Updated**: February 9, 2026
