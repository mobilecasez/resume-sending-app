# Email Deliverability Guide - Prevent Spam Classification

## ✅ Code Improvements Applied

The following improvements have been added to the email sending code:

1. **TLS Security**: Enforced TLS 1.2+ encryption
2. **Connection Pooling**: Better sender reputation
3. **Plain Text Version**: All emails now include both HTML and plain text
4. **Professional Headers**:
   - `X-Mailer`: Identifies the application
   - `X-Priority`: Set to normal (not urgent spam trigger)
   - `List-Unsubscribe`: Required for bulk emails
5. **Proper Subject Line**: Includes position and applicant name
6. **Reply-To**: Set to applicant's personal email

## 🔧 Required DNS Configuration (CRITICAL)

To prevent spam, you MUST configure these DNS records for your Zoho email domain:

### 1. SPF Record (Sender Policy Framework)
Add this TXT record to your domain DNS:

```
Type: TXT
Host: @ (or your domain)
Value: v=spf1 include:zoho.com ~all
TTL: 3600
```

**What it does**: Tells email servers that Zoho is authorized to send emails from your domain.

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
