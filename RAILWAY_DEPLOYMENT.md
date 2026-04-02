# Railway Deployment Instructions

> ⚠️ **GitHub auto-deploy is NOT configured.** Always deploy manually using the Railway CLI steps below.

---

## 🚀 Manual Deploy to Railway (CLI)

### Prerequisites
- Railway CLI installed: `brew install railway` (macOS)
- Logged in: `railway login`
- Project linked (one-time setup): `railway link` → select **CVApplyr Website**

---

### Every Time You Want to Deploy

```bash
cd "/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app"

# 1. Make sure all changes are committed
git add -A && git commit -m "your message"

# 2. Push to GitHub (keeps repo in sync)
git push origin main

# 3. Deploy to Railway
railway up --detach
```

`--detach` returns immediately and builds in the background. Track progress:
```bash
railway logs
```

---

### First-Time Setup (One-Time Only)

```bash
# Install CLI
brew install railway

# Login (opens browser)
railway login

# Link to existing project
cd "/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app"
railway link
# → Select: CVApplyr Website → production
```

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

## �️ MANDATORY: Schema Comparison Before Every Deploy

> ⚠️ **Never deploy without first running a schema diff.** Schema drift (missing columns/tables in production) causes silent runtime errors. Fix ALL gaps in one shot — never chase errors one by one.

### Run the comparison

```bash
cd "/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app"

python3 - << 'EOF'
import subprocess, json

result = subprocess.run(['railway', 'variables', '--json'], capture_output=True, text=True)
db_url = json.loads(result.stdout)['DATABASE_URL']

pg = subprocess.run(
    ['psql', f'{db_url}?sslmode=require', '--no-psqlrc', '-t', '-A', '-F|',
     '-c', "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, column_name;"],
    capture_output=True, text=True
)

prod = {}
for line in pg.stdout.strip().split('\n'):
    if '|' not in line: continue
    parts = line.split('|')
    if len(parts) >= 2:
        tbl, col = parts[0].strip(), parts[1].strip()
        prod.setdefault(tbl, set()).add(col)

print("=== PRODUCTION SCHEMA ===")
for t in sorted(prod):
    print(f"  {t}: {sorted(prod[t])}")
EOF
```

Compare the output against `database/postgres-schema.sql`. For any missing columns, write a single `.sql` patch file and apply it all at once:

```bash
PGURL=$(railway variables --json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['DATABASE_URL'])")
psql "${PGURL}?sslmode=require" --no-psqlrc -f /tmp/schema-patch.sql
```

### After any direct psql change, update BOTH:
1. `database/postgres-schema.sql` — add column to the `CREATE TABLE IF NOT EXISTS` block
2. `db-init.js` — add an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration block

---

## �📋 Pre-Deployment Checklist

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

## 🔧 Deployment Methods

### ✅ Method 1: Railway CLI (Use This — GitHub auto-deploy is disabled)
```bash
# From project root:
railway up --detach
```

### ❌ Method 2: GitHub Auto-Deploy (Not configured)
Railway is NOT set to auto-deploy on push. Do not rely on GitHub pushes to trigger deployment — always use `railway up` manually.

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
