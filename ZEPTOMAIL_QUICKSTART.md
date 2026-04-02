# ZeptoMail Quick Start (3 Minutes)

## What You Need
- Zoho account (you already have cv@cvapplyr.com)
- Access to your domain DNS (cvapplyr.com)

---

## Setup Steps

### 1️⃣ Go to ZeptoMail (1 min)
🔗 https://www.zoho.com/zeptomail/
- Click "Get Started"
- Login with your Zoho account
- Select/Create organization: "CVApplyr"

### 2️⃣ Add Domain (1 min)
- Go to **Mail Agents** → **Add Mail Agent**
- Type: **Transactional**
- Domain: `cvapplyr.com`
- Copy the 3 DNS records shown

### 3️⃣ Add DNS Records (5-30 min wait)
Add these to your domain DNS provider (GoDaddy/Namecheap/Cloudflare/etc):

| Type | Name | Value |
|------|------|-------|
| TXT | @ | `zoho-verification=zeptomail.<code>` |
| TXT | zeptomail._domainkey | `k=rsa; p=<key>...` |
| TXT | @ | `v=spf1 include:zeptomail.com ~all` |

**Note:** Exact values are shown in ZeptoMail dashboard.

### 4️⃣ Get API Token (30 sec)
- Go to **Account** → **SMTP & API Info**
- Click **+ New Token**
- Name: `CVApplyr Production`
- **COPY THE TOKEN** ⚠️ (starts with `Zoho-enczapitoken`)

### 5️⃣ Add to Railway (30 sec)
```bash
railway variables --set ZEPTOMAIL_TOKEN="<your-token-here>"
```

### 6️⃣ Deploy (1 min)
Code is already integrated! Just deploy:
```bash
railway up --detach
```

---

## Test It

1. **Check logs:**
```bash
railway logs --tail 20
```

2. **Look for:**
```
📧 Sending via ZeptoMail API...
✅ Email sent successfully via ZeptoMail
```

3. **Check ZeptoMail dashboard:**
   - Reports → Email Logs
   - See sent emails

---

## Pricing

✅ **FREE:** 10,000 emails/month  
💰 **Paid:** $2.50 for 25k emails/month

You'll likely stay in free tier! 🎉

---

## Fallback Order

Your app now tries email in this order:

1. **Gmail OAuth** (if user logged in)
2. **User's SMTP** (if configured)
3. **Railway SMTP** (fails - port blocked)
4. **ZeptoMail API** ✅ **← WORKS!**

---

## Need Help?

- 📖 Full guide: `ZEPTOMAIL_SETUP.md`
- 🔧 Code: `server/services/zeptomailService.js`
- 📧 Support: support@zeptomail.com
