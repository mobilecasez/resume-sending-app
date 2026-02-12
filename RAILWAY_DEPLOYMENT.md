# Railway Deployment Instructions

## 🚀 Quick Deploy to Railway

### Step 1: Login to Railway
```bash
cd "/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app"
railway login
```
This will open your browser. Login with your Railway account.

### Step 2: Link to Existing Project
```bash
railway link
```
Select your existing project: **CVApplyr Website**

### Step 3: Set Environment Variables
```bash
# Set DATABASE_URL (PostgreSQL from Railway)
railway variables set DATABASE_URL="<your-railway-postgres-url>"

# Set other required variables
railway variables set NODE_ENV=production
railway variables set PORT=3000
railway variables set GEMINI_API_KEY="<your-key>"
railway variables set IMAP_HOST="imap.gmail.com"
railway variables set IMAP_PORT=993
railway variables set IMAP_USER="cv@cvapplyr.com"
railway variables set IMAP_PASS="<your-app-password>"
railway variables set SMTP_HOST="smtp.gmail.com"
railway variables set SMTP_PORT=587
railway variables set SMTP_USER="cv@cvapplyr.com"
railway variables set SMTP_PASS="<your-app-password>"
railway variables set JWT_SECRET="<generate-random-secret>"
railway variables set RAZORPAY_KEY_ID="<your-key>"
railway variables set RAZORPAY_KEY_SECRET="<your-secret>"
```

### Step 4: Deploy
```bash
railway up
```

### Step 5: Get Deployment URL
```bash
railway status
```

### Step 6: Update Mobile App Config
Once deployed, get your Railway URL (e.g., `https://cvapplyr-production.up.railway.app`)

Update `MobileApp/config.js`:
```javascript
const PRODUCTION_API_URL = 'https://your-railway-domain.up.railway.app/api';
```

---

## 📋 Pre-Deployment Checklist

### ✅ Required Files (Already Present)
- [x] railway.toml - Railway configuration
- [x] package.json - Dependencies and start script
- [x] server.js - Main application file

### ✅ Environment Variables to Set
- [ ] DATABASE_URL (PostgreSQL connection string)
- [ ] GEMINI_API_KEY (Google AI API key)
- [ ] IMAP credentials (Email forwarding)
- [ ] SMTP credentials (Email sending)
- [ ] JWT_SECRET (Authentication)
- [ ] RAZORPAY keys (Payment processing)

### ✅ Database Setup
Railway will automatically provision PostgreSQL, or you can use existing database.

---

## 🔧 Alternative: Deploy via Railway Dashboard

### Method 1: GitHub Integration (Recommended)
1. Push your code to GitHub
2. Go to Railway Dashboard: https://railway.app
3. Select "CVApplyr Website" project
4. Click "Deploy from GitHub repo"
5. Select your repository
6. Railway will auto-detect settings from railway.toml
7. Set environment variables in Railway dashboard
8. Deploy!

### Method 2: Deploy from Local
1. Login: `railway login`
2. Link: `railway link`
3. Deploy: `railway up`

---

## 📊 Verify Deployment

### Check Deployment Status
```bash
railway status
```

### View Logs
```bash
railway logs
```

### Open in Browser
```bash
railway open
```

### Check Environment Variables
```bash
railway variables
```

---

## 🛠 Troubleshooting

### Build Fails
- Check logs: `railway logs`
- Verify package.json has correct start script
- Ensure Node version is specified in package.json

### Database Connection Issues
- Verify DATABASE_URL is set correctly
- Check if PostgreSQL service is running
- Test connection from Railway shell

### Environment Variables Missing
```bash
railway variables
```
Add missing variables via dashboard or CLI

### Port Issues
Railway automatically sets PORT variable. Your server.js should use:
```javascript
const PORT = process.env.PORT || 3000;
```

---

## 🔗 Useful Commands

```bash
# View all services in project
railway status

# Open Railway dashboard
railway open

# View environment variables
railway variables

# Set environment variable
railway variables set KEY=value

# Delete environment variable
railway variables delete KEY

# View logs
railway logs

# Connect to PostgreSQL shell
railway connect

# Run command in Railway environment
railway run node server.js
```

---

## 📱 After Deployment

1. **Test API endpoints**
   - Visit: `https://your-domain.up.railway.app`
   - Test: `https://your-domain.up.railway.app/api/health`

2. **Update Mobile App**
   - Update `MobileApp/config.js` with production URL
   - Rebuild mobile app

3. **Set up Custom Domain (Optional)**
   - Railway Dashboard → Settings → Domains
   - Add your custom domain (e.g., api.cvapplyr.com)
   - Update DNS records

4. **Monitor Application**
   - Check logs regularly
   - Monitor resource usage
   - Set up alerts

---

## 💰 Railway Pricing

- **Free Tier**: $5/month usage credit
- **Pro Plan**: $20/month + usage
- **Database**: ~$5-10/month for PostgreSQL

**Estimated monthly cost**: $15-30 depending on traffic

---

## 🚨 Important Notes

1. **Database Persistence**: Make sure to use Railway's PostgreSQL service (persistent)
2. **File Uploads**: Railway has ephemeral filesystem, use external storage for uploads (S3, Cloudinary, etc.)
3. **Environment Variables**: Never commit sensitive data to git
4. **Logs**: Railway keeps logs for 7 days on free tier
5. **Backups**: Set up database backups in Railway dashboard

---

## 📞 Need Help?

- Railway Docs: https://docs.railway.app
- Railway Discord: https://discord.gg/railway
- Railway Status: https://status.railway.app
