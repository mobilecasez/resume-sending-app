# Email Deliverability - Final Configuration Steps

## 🎯 Quick Fix Summary

Your current mail-tester score issues:
- ❌ **SPF_SOFTFAIL** (-0.972): SPF record needs `-all` instead of `~all`
- ❌ **FREEMAIL_FORGED_REPLYTO** (-2.503): Fixed by using domain email for Reply-To
- ✅ **DKIM Valid**: Working perfectly

## 🔧 DNS Configuration (REQUIRED - Do This Now)

### Step 1: Update SPF Record in GoDaddy

1. Log in to **GoDaddy** → **My Products** → **DNS**
2. Find your existing TXT record with `v=spf1 include:zoho.com ~all`
3. **Edit it** to:

```
Type: TXT
Name: @ (or leave blank)
Value: v=spf1 include:zoho.com ip4:103.117.158.14 -all
TTL: 600 (or 3600)
```

**Key Changes:**
- Added `ip4:103.117.158.14` (your Zoho sending server)
- Changed `~all` to `-all` (strict policy)

### Step 2: Verify DKIM (Already Done ✅)

Your DKIM is working perfectly! No action needed.

### Step 3: Verify/Update DMARC Record

1. In GoDaddy DNS, check if you have a TXT record with host `_dmarc`
2. If yes, verify it says:
```
Type: TXT
Name: _dmarc
Value: v=DMARC1; p=quarantine; rua=mailto:cv@cvapplyr.com
TTL: 3600
```
3. If no, add it with the values above

## ✅ Code Fixes Applied

The following have been fixed in your code:
- ✅ Reply-To now uses domain email (cv@cvapplyr.com) instead of personal Gmail
- ✅ TLS 1.2+ security enabled
- ✅ Professional email headers added
- ✅ Plain text version included
- ✅ BCC to mail-tester for continuous monitoring

## 📊 Expected Results After DNS Update

**Current Score**: ~-3.5 (affected by SPF softfail)

**After fixing SPF** (wait 30 minutes for DNS):
- Expected Score: **7-9/10** ✅
- SPF: PASS ✅
- DKIM: PASS ✅
- DMARC: PASS ✅
- No freemail issues ✅

## 🚀 Testing Steps

1. **Update SPF in GoDaddy** (see Step 1 above)
2. **Wait 30 minutes** for DNS propagation
3. **Send test email** from your app to any recipient
4. **Check score** at https://www.mail-tester.com
5. **Verify**: Should now be 7-9/10

## 🔍 Verification Commands

Check your DNS records are correct:

**SPF:**
```bash
dig +short TXT cvapplyr.com
```
Should show: `"v=spf1 include:zoho.com ip4:103.117.158.14 -all"`

**DKIM:**
```bash
dig +short TXT zoho._domainkey.cvapplyr.com
```
Should show: Long key starting with `"v=DKIM1; k=rsa; p=..."`

**DMARC:**
```bash
dig +short TXT _dmarc.cvapplyr.com
```
Should show: `"v=DMARC1; p=quarantine; rua=mailto:cv@cvapplyr.com"`

## ⚠️ Important Notes

1. **DNS takes time**: Allow 30-60 minutes after changes
2. **Remove BCC later**: Once testing is complete, remove the mail-tester BCC from code
3. **Warm up**: Start with 10-20 emails/day, increase gradually
4. **Monitor**: Check mail-tester weekly for first month

## 📧 Final Email Configuration

Your emails will now send as:
- **From**: Your Name <cv@cvapplyr.com>
- **Reply-To**: cv@cvapplyr.com (no more Gmail!)
- **Authentication**: SPF + DKIM + DMARC all PASS
- **Expected delivery**: Inbox (not spam) ✅

## 🎯 Next Steps

1. ✅ Code fixes are applied and committed
2. 🔄 **Update SPF record in GoDaddy** (do this now!)
3. ⏱️ Wait 30 minutes
4. 📧 Send test email
5. 🎉 Enjoy inbox delivery!

---

**Need Help?** If score is still below 7/10 after DNS update, share the mail-tester report.

To prevent spam, you MUST configure these DNS records for your Zoho email domain:

### 1. SPF Record (Sender Policy Framework)
Add this TXT record to your domain DNS:

**Option 1 - Recommended (Zoho only):**
```
Type: TXT
Host: @ (or your domain)
Value: v=spf1 include:zoho.com -all
TTL: 3600
```

**Option 2 - If Option 1 gives errors (includes your server IP):**
```
Type: TXT
Host: @ (or your domain)
Value: v=spf1 include:zoho.com ip4:103.117.158.14 -all
TTL: 3600
```

**Important Changes:**
- Changed `~all` to `-all` (strict mode - rejects unauthorized senders)
- Option 2 adds your Zoho sending server IP explicitly

**What it does**: Tells email servers that Zoho is authorized to send emails from your domain. The `-all` means "reject all other servers".

### 2. DKIM Record (DomainKeys Identified Mail)
1. Log in to **Zoho Mail Admin Console**
2. Go to **Email Configuration** → **DKIM**
3. Generate DKIM key
4. Add the provided TXT record to your DNS

Example:
```
Type: TXT
Host: zoho._domainkey
Value: v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3... (long key from Zoho)
TTL: 3600
```

**What it does**: Adds a cryptographic signature to verify emails are from you.

### 3. DMARC Record
Add this TXT record:

```
Type: TXT
Host: _dmarc
Value: v=DMARC1; p=quarantine; rua=mailto:cv@cvapplyr.com
TTL: 3600
```

**What it does**: Tells email servers what to do if SPF/DKIM checks fail. Reports will be sent to cv@cvapplyr.com.

### How to Add DNS Records

**If using GoDaddy:**
1. Go to your domain management
2. Click **DNS** → **Manage Zones**
3. Click **Add** → Select **TXT**
4. Enter the host and value from above

**If using Namecheap:**
1. Domain List → **Manage** → **Advanced DNS**
2. Add new **TXT Record**
3. Enter host and value

**If using Cloudflare:**
1. Dashboard → Your domain → **DNS**
2. Add **TXT record**
3. Enter name and content

### 4. Verify Configuration

After adding DNS records (wait 24-48 hours for propagation):

1. **Check SPF**: https://mxtoolbox.com/spf.aspx
2. **Check DKIM**: https://mxtoolbox.com/dkim.aspx
3. **Check DMARC**: https://mxtoolbox.com/dmarc.aspx
4. **Full Email Test**: https://www.mail-tester.com/

Send a test email to the address provided by mail-tester.com and check your score (aim for 10/10).

## 📧 Email Best Practices

### Content Guidelines
- ✅ Use professional language
- ✅ Include full name and contact info
- ✅ Personalize each email
- ✅ Keep attachments under 10MB
- ❌ Avoid ALL CAPS
- ❌ Avoid excessive exclamation marks!!!
- ❌ Avoid spam trigger words: "FREE", "URGENT", "ACT NOW"

### Sending Patterns
- **Don't send too fast**: Wait 2-5 seconds between emails
- **Daily limit**: Keep under 50-100 emails/day initially
- **Warm up period**: Start with 10-20 emails/day for first week
- **Monitor bounces**: Stop sending if bounce rate > 5%

### Zoho Sending Limits
- **Free Plan**: 5 emails/day
- **Mail Lite**: 250 emails/day
- **Mail Premium**: 500 emails/day
- **Workplace**: Up to 5000 emails/day

## 🔍 Troubleshooting

### Email still going to spam?

1. **Check DNS propagation**: Use https://dnschecker.org
2. **Verify Zoho authentication**: Admin Console → Email Configuration → Authentication Status
3. **Test sender score**: https://www.senderscore.org
4. **Check blacklists**: https://mxtoolbox.com/blacklists.aspx

### Common Issues

**Issue**: "SPF check failed"
- **Fix**: Verify SPF record syntax, ensure it includes `include:zoho.com`

**Issue**: "DKIM signature missing"
- **Fix**: Generate DKIM key in Zoho Admin, add to DNS, wait 24 hours

**Issue**: "Domain not verified"
- **Fix**: Complete Zoho domain verification process

## 📊 Monitoring

### Track Email Deliverability
- Check bounce rates in Zoho logs
- Monitor complaint rates
- Track open rates (if using tracking)
- Review spam scores regularly

### Tools
- **Mail-tester**: https://www.mail-tester.com (test spam score)
- **GlockApps**: https://glockapps.com (deliverability testing)
- **Postmark**: https://postmarkapp.com/spam-check (spam word checker)

## 🎯 Expected Results

After implementing all steps:
- ✅ Emails deliver to inbox (not spam)
- ✅ Spam score < 2/10
- ✅ SPF/DKIM/DMARC all pass
- ✅ Improved sender reputation
- ✅ Better response rates

## ⚠️ Important Notes

1. **DNS changes take time**: Allow 24-48 hours for propagation
2. **Sender reputation builds slowly**: Start small, scale gradually
3. **Monitor regularly**: Check spam scores weekly
4. **Keep records updated**: Update DNS if you change email providers
5. **Comply with laws**: Include unsubscribe option for bulk emails

## 🆘 Need Help?

- **Zoho Support**: https://help.zoho.com/portal/en/home
- **DNS Help**: Contact your domain registrar support
- **Email Deliverability**: Check Zoho's email authentication guide

---

**Last Updated**: February 9, 2026
**Status**: Code improvements applied, DNS configuration required
