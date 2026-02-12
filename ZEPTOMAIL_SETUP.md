# Zoho ZeptoMail Setup Guide

## Why ZeptoMail?

- ✅ **No SMTP Port Blocking** - Uses API instead of SMTP ports (465/587)
- ✅ **Free Tier** - 10,000 emails/month free
- ✅ **High Deliverability** - Better than SMTP
- ✅ **Already Using Zoho** - cv@cvapplyr.com is on Zoho
- ✅ **Easy Integration** - Simple REST API

---

## Step-by-Step Setup

### 1. Create ZeptoMail Account

1. **Go to:** https://www.zoho.com/zeptomail/
2. **Click:** "Get Started" or "Sign Up"
3. **Login with:** Your existing Zoho account (same as cv@cvapplyr.com)
4. **Select:** Organization (or create new one: "CVApplyr")

### 2. Verify Your Domain

#### 2.1. Add Mail Agent

1. In ZeptoMail dashboard, go to **"Mail Agents"**
2. Click **"Add Mail Agent"**
3. Choose **"Transactional"** type
4. Enter domain: `cvapplyr.com`

#### 2.2. Add DNS Records

You'll need to add these DNS records to your domain (wherever cvapplyr.com is registered):

**TXT Record (Verification):**
```
Type: TXT
Name: @
Value: zoho-verification=zeptomail.<your-verification-code>
TTL: 3600
```

**DKIM Record (Email Authentication):**
```
Type: TXT
Name: zeptomail._domainkey
Value: k=rsa; p=<your-public-key>
TTL: 3600
```

**SPF Record (Sender Authentication):**
```
Type: TXT
Name: @
Value: v=spf1 include:zeptomail.com ~all
TTL: 3600
```

**Note:** ZeptoMail dashboard will show you the exact values to add.

#### 2.3. Wait for Verification

- DNS propagation takes 5-30 minutes
- Check status in ZeptoMail dashboard
- Domain will show as "Verified" when ready

### 3. Get API Token

1. Go to **"Account"** → **"SMTP & API Info"**
2. Click **"Create Token"** or **"+ New Token"**
3. Enter token name: `CVApplyr Production`
4. **Copy the token** (starts with `Zoho-enczapitoken`)
   - ⚠️ **Save it now** - you can't see it again!

### 4. Configure Railway

Add the ZeptoMail token to your Railway environment:

```bash
# In your local terminal
railway variables --set ZEPTOMAIL_TOKEN="Zoho-enczapitoken<your-token-here>"
```

Or via Railway Dashboard:
1. Go to your Railway project
2. Click **"CVApplyr Website"** service
3. Click **"Variables"** tab
4. Add new variable:
   - **Name:** `ZEPTOMAIL_TOKEN`
   - **Value:** `Zoho-enczapitoken<your-token>`
5. Click **"Add"**

### 5. Install Dependencies

```bash
npm install zeptomail
```

### 6. Deploy

```bash
# Commit changes
git add .
git commit -m "Added ZeptoMail integration"

# Deploy to Railway
railway up --detach
```

---

## How It Works

### Email Sending Priority Order:

1. **Gmail API** (if user logged in with Google OAuth)
2. **User's SMTP** (if user configured their own email)
3. **Default SMTP** (tries but fails on Railway due to port blocking)
4. **ZeptoMail API** ✅ (new fallback - works on Railway!)

### Example Request Flow:

```
User clicks "Send Application"
    ↓
Try Gmail API → Failed (OAuth expired)
    ↓
Try User SMTP → Not configured
    ↓
Try Default SMTP → Timeout (Railway blocks port)
    ↓
Try ZeptoMail API → ✅ SUCCESS!
```

---

## Testing

### Test in Production:

1. Upload resume in app
2. Generate cover letter
3. Try sending to a test email
4. Check Railway logs:

```bash
railway logs --tail 50
```

Look for:
```
📧 Sending via ZeptoMail API...
   From: cv@cvapplyr.com
   To: recipient@example.com
   Subject: Application for ...
✅ Email sent successfully via ZeptoMail
   Message ID: <zeptomail-message-id>
```

### Check ZeptoMail Dashboard:

1. Go to **"Reports"** → **"Email Logs"**
2. You'll see:
   - Email sent
   - Delivery status
   - Open/click tracking (if enabled)

---

## Pricing

**Free Tier:**
- 10,000 emails/month
- Perfect for starting out
- No credit card required

**Paid Plans** (if you exceed):
- Lite: 25,000 emails/month - $2.50
- Pro: 100,000 emails/month - $8.50
- Premium: Custom pricing

---

## Troubleshooting

### Error: "ZEPTOMAIL_TOKEN not configured"

**Solution:** Make sure you added the token to Railway:
```bash
railway variables | grep ZEPTOMAIL
```

### Error: "Domain not verified"

**Solution:** 
1. Check DNS records are added correctly
2. Wait 10-30 minutes for DNS propagation
3. Use online DNS checker: https://dnschecker.org/

### Error: "Invalid token"

**Solution:**
1. Go to ZeptoMail → Account → SMTP & API Info
2. Delete old token
3. Create new token
4. Update Railway variable

### Error: "Sender address not verified"

**Solution:**
- Make sure `cv@cvapplyr.com` matches your verified domain
- Check that domain verification is complete

---

## API Limits

**Rate Limits:**
- 10 requests/second per account
- No daily sending limit (within your plan)

**File Attachments:**
- Max 10 MB per email (total attachments)
- Your cover letters are ~500KB each
- Resume ~1MB
- Well within limits ✅

---

## Security Notes

**Token Security:**
- Token has full send permissions
- Never commit to git
- Only store in Railway environment
- Rotate periodically (every 90 days)

**Email Authentication:**
- DKIM prevents spoofing
- SPF prevents spam filtering
- Both required for good deliverability

---

## Alternative: Zoho Mail API

If you want to use **Zoho Mail API** instead (more complex):

1. Enable API access in Zoho Mail
2. Create OAuth app in Zoho Developer Console
3. Get client ID/secret
4. Implement OAuth flow
5. Use Zoho Mail API endpoints

**Not recommended** - ZeptoMail is simpler and designed for transactional emails.

---

## Support

**ZeptoMail Support:**
- Email: support@zeptomail.com
- Docs: https://www.zoho.com/zeptomail/help/
- Status: https://status.zeptomail.com/

**Implementation Help:**
- Check `server/services/zeptomailService.js` for code
- Check `server/controllers/emailController.js` for integration
- Railway logs for debugging

---

## Next Steps

1. ✅ Complete domain verification
2. ✅ Get API token
3. ✅ Add to Railway variables
4. ✅ Install `npm install zeptomail`
5. ✅ Deploy
6. ✅ Test sending
7. 🎉 Done!
