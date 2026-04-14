# 🚀 Railway Deployment - Complete Guide

> **Comprehensive guide for deploying any Node.js application to Railway**

---

## 📋 Table of Contents

1. [Railway Configuration File](#1-railway-configuration-file)
2. [Package.json Requirements](#2-packagejson-requirements)
3. [Initial Setup (One-Time)](#3-initial-setup-one-time)
4. [Setting Environment Variables](#4-setting-environment-variables)
5. [Deployment Process](#5-deployment-process)
6. [Useful Railway Commands](#6-useful-railway-commands)
7. [Database Management](#7-database-management)
8. [Pre-Deployment Checklist](#8-pre-deployment-checklist)
9. [Post-Deployment Verification](#9-post-deployment-verification)
10. [Domain Configuration](#10-domain-configuration)
11. [Important Notes](#11-important-notes)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Railway Configuration File

Create a `railway.toml` file in your project root:

```toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "node server.js"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
healthcheckPath = "/"
healthcheckTimeout = 300

[env]
NODE_ENV = "production"
PORT = "${{PORT}}"
```

**Configuration explained:**
- `builder = "NIXPACKS"` - Uses Nixpacks build system (auto-detects Node.js)
- `startCommand` - Command to start your application
- `restartPolicyType` - Automatically restarts on failure
- `healthcheckPath` - Endpoint Railway pings to check health
- `healthcheckTimeout` - Max time (seconds) to wait for app to start

---

## 2. Package.json Requirements

Ensure your `package.json` has these essential fields:

```json
{
  "name": "your-app-name",
  "version": "1.0.0",
  "description": "Your app description",
  "main": "server.js",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "start": "node server.js",
    "dev": "node server.js"
  },
  "dependencies": {
    "express": "^5.0.0",
    // ... your other dependencies
  }
}
```

**Key requirements:**
- `engines.node` - Specify Node.js version
- `scripts.start` - Railway uses this to start your app
- `main` - Entry point file

---

## 3. Initial Setup (One-Time)

### Install Railway CLI

**macOS:**
```bash
brew install railway
```

**Linux:**
```bash
npm i -g @railway/cli
```

**Windows:**
```bash
npm i -g @railway/cli
```

### Login to Railway

```bash
railway login
```

This opens your browser to authenticate. Login with your Railway account.

### Link to Existing Project or Create New

**Option A: Link to existing Railway project**
```bash
cd /path/to/your/project
railway link
```
Select your project from the list.

**Option B: Create a new Railway project**
```bash
cd /path/to/your/project
railway init
```

**Verify linkage:**
```bash
railway status
```

---

## 4. Setting Environment Variables

### Set Individual Variables

```bash
# Database
railway variables set DATABASE_URL="postgresql://user:pass@host:port/dbname"

# Basic Configuration
railway variables set NODE_ENV=production
railway variables set PORT=3000

# Authentication
railway variables set JWT_SECRET="your-super-secret-jwt-token"
railway variables set SESSION_SECRET="your-session-secret"

# API Keys
railway variables set GEMINI_API_KEY="your-gemini-key"
railway variables set OPENAI_API_KEY="your-openai-key"
railway variables set RAZORPAY_KEY_ID="your-razorpay-key"
railway variables set RAZORPAY_KEY_SECRET="your-razorpay-secret"

# Email Configuration (Gmail/SMTP)
railway variables set SMTP_HOST="smtp.gmail.com"
railway variables set SMTP_PORT=587
railway variables set SMTP_USER="your-email@gmail.com"
railway variables set SMTP_PASS="your-app-password"
railway variables set IMAP_HOST="imap.gmail.com"
railway variables set IMAP_PORT=993
railway variables set IMAP_USER="your-email@gmail.com"
railway variables set IMAP_PASS="your-app-password"

# OAuth (Google)
railway variables set GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
railway variables set GOOGLE_CLIENT_SECRET="your-google-client-secret"
railway variables set GOOGLE_REDIRECT_URI="https://your-domain.railway.app/auth/google/callback"

# OAuth (Microsoft)
railway variables set MICROSOFT_CLIENT_ID="your-microsoft-client-id"
railway variables set MICROSOFT_CLIENT_SECRET="your-microsoft-client-secret"
railway variables set MICROSOFT_REDIRECT_URI="https://your-domain.railway.app/auth/microsoft/callback"

# Encryption
railway variables set ENCRYPTION_KEY="your-32-character-encryption-key"

# Custom Domain
railway variables set DOMAIN="https://your-custom-domain.com"
```

### View All Variables

```bash
# Human-readable format
railway variables

# JSON format
railway variables --json

# Filter specific variable
railway variables --json | grep DATABASE_URL
```

### Load Variables from .env File

```bash
# Source your local .env
source .env

# Set variables from environment
railway variables set API_KEY="$API_KEY"
railway variables set DATABASE_URL="$DATABASE_URL"
```

---

## 5. Deployment Process

### Manual Deployment (Recommended)

**Every time you want to deploy:**

```bash
# 1. Navigate to your project
cd /path/to/your/project

# 2. Commit your changes
git add -A
git commit -m "deployment: your message here"

# 3. Push to GitHub (keeps repo in sync)
git push origin main

# 4. Deploy to Railway
railway up --detach
```

**Deployment flags:**
- `--detach` - Deploy in background, returns immediately
- Without `--detach` - Blocks until deployment completes

### Monitor Deployment

```bash
# View deployment logs
railway logs

# Follow logs in real-time
railway logs --follow

# View build logs
railway logs --build
```

### Auto-Deploy from GitHub

**To enable GitHub auto-deploy:**
1. Go to Railway dashboard
2. Click your service → Settings → Source
3. Connect your GitHub repository
4. Select branch (usually `main`)
5. Enable "Auto Deploy"

**Note:** Once enabled, every push to the selected branch triggers deployment.

---

## 6. Useful Railway Commands

### Project Management

```bash
# Check deployment status
railway status

# View all deployments
railway list

# Open Railway dashboard in browser
railway open

# Switch environment (production/staging)
railway environment

# Unlink current project
railway unlink

# Relink to different project
railway link
```

### Service Management

```bash
# Restart your service
railway restart

# Stop your service
railway down

# View service variables
railway variables

# Delete a variable
railway variables delete VARIABLE_NAME
```

### Remote Execution

```bash
# SSH into your deployment
railway shell

# Run a command in production
railway run <command>

# Examples:
railway run node migrate.js
railway run npm run seed
railway run node scripts/cleanup.js
```

### Database Commands

```bash
# Connect to PostgreSQL database
railway connect postgres

# Connect to MySQL database
railway connect mysql

# Connect to Redis
railway connect redis
```

### Logs and Debugging

```bash
# View recent logs
railway logs

# Tail logs (live)
railway logs --follow

# View logs for specific deployment
railway logs --deployment <deployment-id>

# View build logs
railway logs --build
```

### Domain Management

```bash
# List all domains
railway domain

# Add a custom domain (via dashboard)
# Railway will provide DNS configuration
```

---

## 7. Database Management

### Add PostgreSQL Database

**Option 1: Via Dashboard**
1. Go to Railway dashboard
2. Click "+ New" → "Database" → "PostgreSQL"
3. Wait for provisioning
4. Copy `DATABASE_URL` from variables

**Option 2: Via CLI**
```bash
railway add
# Select PostgreSQL
```

### Connect to Railway Database

```bash
# Interactive PostgreSQL connection
railway connect postgres

# Or manually with URL
RAILWAY_DB_URL=$(railway variables --json | python3 -c "import sys,json; print(json.load(sys.stdin)['DATABASE_URL'])")
psql "$RAILWAY_DB_URL"
```

### Backup Production Database

```bash
# Get DATABASE_URL
RAILWAY_DB_URL=$(railway variables --json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['DATABASE_URL'])")

# Create backup
timestamp=$(date +"%Y%m%d_%H%M%S")
pg_dump "${RAILWAY_DB_URL}?sslmode=require" > "backup_${timestamp}.sql"

echo "✅ Backup saved to backup_${timestamp}.sql"
```

### Restore Database from Backup

```bash
# Get DATABASE_URL
RAILWAY_DB_URL=$(railway variables --json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['DATABASE_URL'])")

# Restore from backup
psql "${RAILWAY_DB_URL}?sslmode=require" < backup_20240310_143022.sql
```

### Run SQL Migrations

```bash
# Method 1: Via psql
RAILWAY_DB_URL=$(railway variables --json | python3 -c "import sys,json; print(json.load(sys.stdin)['DATABASE_URL'])")
psql "${RAILWAY_DB_URL}?sslmode=require" -f migrations/001_add_columns.sql

# Method 2: Via railway run
railway run node migrate.js

# Method 3: Via railway shell
railway shell
node migrate.js
exit
```

### Check Production Database Schema

```bash
# View all tables and columns
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

### Compare Local vs Production Schema

```bash
# Get production schema
railway run node check-schema.js

# Or compare manually
# 1. Export production schema
RAILWAY_DB_URL=$(railway variables --json | python3 -c "import sys,json; print(json.load(sys.stdin)['DATABASE_URL'])")
pg_dump "${RAILWAY_DB_URL}?sslmode=require" --schema-only > production_schema.sql

# 2. Compare with local
diff local_schema.sql production_schema.sql
```

---

## 8. Pre-Deployment Checklist

### ✅ Files Configuration

- [ ] `railway.toml` exists in project root
- [ ] `package.json` has correct start script
- [ ] Server file (e.g., `server.js`) exists
- [ ] `.gitignore` includes sensitive files (.env, node_modules)
- [ ] Health check endpoint implemented (`/` or `/health`)

### ✅ Environment Variables

- [ ] `DATABASE_URL` set (if using database)
- [ ] `NODE_ENV=production` set
- [ ] `PORT` configured
- [ ] API keys set (Gemini, OpenAI, etc.)
- [ ] OAuth credentials configured
- [ ] Email (SMTP/IMAP) credentials set
- [ ] JWT/Session secrets set
- [ ] Payment gateway keys set (if applicable)

### ✅ Database

- [ ] PostgreSQL provisioned on Railway
- [ ] Schema migrations completed
- [ ] Local schema matches production
- [ ] Seed data loaded (if needed)
- [ ] Database backup taken

### ✅ OAuth Configuration (if applicable)

**Google OAuth:**
- [ ] Authorized JavaScript origins added
- [ ] Authorized redirect URIs added
- [ ] OAuth consent screen configured
- [ ] Credentials saved in Railway variables

**Microsoft OAuth:**
- [ ] Redirect URIs configured in Azure
- [ ] API permissions granted
- [ ] Credentials saved in Railway variables

### ✅ Git & Code

- [ ] All changes committed
- [ ] Pushed to GitHub
- [ ] No sensitive data in commits
- [ ] Dependencies up-to-date

### ✅ Testing

- [ ] App runs locally without errors
- [ ] Database connections work
- [ ] OAuth flow tested (if applicable)
- [ ] API endpoints respond correctly
- [ ] Email sending works (if applicable)

---

## 9. Post-Deployment Verification

### Check Deployment Status

```bash
# View current status
railway status

# View all recent deployments
railway list
```

### Monitor Logs

```bash
# View logs
railway logs

# Follow logs in real-time
railway logs --follow
```

### Test Your Application

```bash
# Get your Railway URL
railway status
# Or
railway domain

# Test health endpoint
curl -I https://your-app.railway.app/

# Test API endpoints
curl https://your-app.railway.app/api/health
curl https://your-app.railway.app/api/packages

# Test with verbose output
curl -v https://your-app.railway.app/
```

### Verify Database Connection

```bash
# Connect to database
railway connect postgres

# Or test via API
curl https://your-app.railway.app/api/test-db
```

### Check Environment Variables

```bash
# List all variables
railway variables

# Test specific variable in app
railway run node -e "console.log(process.env.NODE_ENV)"
```

### Common Issues After Deployment

**App won't start:**
```bash
# Check logs for errors
railway logs

# Verify start command
railway variables | grep PORT
railway logs --build
```

**Database connection fails:**
```bash
# Verify DATABASE_URL is set
railway variables | grep DATABASE_URL

# Test connection
railway connect postgres
```

**Environment variables not working:**
```bash
# Restart service after setting variables
railway restart

# Verify variable is set
railway variables
```

---

## 10. Domain Configuration

### Railway Default Domain

Every Railway deployment gets a free domain:
```
https://your-service-name-production.up.railway.app
```

### Add Custom Domain

**Via Railway Dashboard:**
1. Go to your service → Settings → Domains
2. Click "+ Custom Domain"
3. Enter your domain (e.g., `example.com` or `app.example.com`)
4. Railway provides DNS records to add

**DNS Configuration:**

Add these records to your DNS provider:

**For root domain (example.com):**
```
Type: A
Name: @
Value: [Railway IP address]
```

**For subdomain (app.example.com):**
```
Type: CNAME
Name: app
Value: [your-service].railway.app
```

**Wait for DNS propagation** (can take 5 minutes to 48 hours)

### Verify Domain

```bash
# Check domain status
railway domain

# Test domain
curl -I https://your-custom-domain.com
```

### Multiple Domains

You can add multiple domains:
- `example.com` (root)
- `www.example.com`
- `api.example.com`
- `app.example.com`

Each needs its own DNS configuration.

---

## 11. Important Notes

### 🔒 Security Best Practices

- **Never commit secrets** to Git
- Use Railway variables for all sensitive data
- Rotate API keys regularly
- Use strong, random secrets for JWT/sessions
- Enable HTTPS (automatic on Railway)

### 📊 Deployment Strategies

**Manual Deployment (recommended for production):**
- Full control over when deployments happen
- Test locally before deploying
- Use `railway up --detach`

**Auto-Deploy from GitHub:**
- Convenient for staging environments
- Every push triggers deployment
- Configure in Railway dashboard

### 💾 Database Considerations

- **Always backup before migrations**
- Test migrations locally first
- Use transactions for data changes
- Monitor database size (Railway has limits)
- Set up regular automated backups

### 🔄 Environment Management

Railway supports multiple environments:
- Production
- Staging
- Development

Switch between them:
```bash
railway environment
# Select environment from list
```

### 💰 Pricing & Limits

- Free tier available (limited resources)
- Pay-as-you-go for production apps
- Monitor usage in Railway dashboard
- Set up billing alerts

---

## 12. Troubleshooting

### Build Failures

**Problem:** Build fails with dependency errors

```bash
# Check build logs
railway logs --build

# Verify package.json is valid
cat package.json | python3 -m json.tool

# Ensure lock file is committed
git add package-lock.json
git commit -m "Add lock file"
railway up
```

### Application Crashes

**Problem:** App crashes immediately after starting

```bash
# View crash logs
railway logs

# Common causes:
# 1. Missing environment variables
railway variables

# 2. Database connection issues
railway variables | grep DATABASE_URL

# 3. Port binding - use process.env.PORT
# Check your server.js:
# const PORT = process.env.PORT || 3000;
```

### Database Connection Issues

**Problem:** Cannot connect to database

```bash
# 1. Verify DATABASE_URL exists
railway variables | grep DATABASE_URL

# 2. Test connection
railway connect postgres

# 3. Check if database is running
railway status

# 4. Verify SSL mode in connection string
# Should include: ?sslmode=require
```

### Environment Variables Not Working

**Problem:** Variables not accessible in app

```bash
# 1. Verify variable is set
railway variables

# 2. Restart service
railway restart

# 3. Wait 30 seconds for restart

# 4. Check logs
railway logs --follow
```

### Deployment Timeouts

**Problem:** Deployment times out

```bash
# 1. Increase healthcheck timeout in railway.toml
# healthcheckTimeout = 600

# 2. Verify health endpoint exists
curl https://your-app.railway.app/

# 3. Check if app is listening on correct port
# Must use: process.env.PORT
```

### Railway CLI Issues

**Problem:** CLI commands fail

```bash
# 1. Re-authenticate
railway logout
railway login

# 2. Relink project
railway unlink
railway link

# 3. Update CLI
brew upgrade railway  # macOS
npm update -g @railway/cli  # npm
```

### Domain Not Working

**Problem:** Custom domain not accessible

```bash
# 1. Check domain configuration
railway domain

# 2. Verify DNS records
dig your-domain.com
nslookup your-domain.com

# 3. Wait for DNS propagation
# Can take up to 48 hours

# 4. Test with Railway domain first
curl https://your-app.railway.app/
```

### OAuth Redirect Issues

**Problem:** OAuth redirects fail

1. **Update redirect URIs** in OAuth provider:
   - Google: https://console.cloud.google.com/apis/credentials
   - Microsoft: https://portal.azure.com

2. **Add all possible domains:**
   ```
   https://your-app.railway.app/auth/google/callback
   https://your-custom-domain.com/auth/google/callback
   ```

3. **Update environment variables:**
   ```bash
   railway variables set GOOGLE_REDIRECT_URI="https://your-domain.com/auth/google/callback"
   railway restart
   ```

### Memory/CPU Issues

**Problem:** App runs out of memory

```bash
# 1. Check service plan limits
# View in Railway dashboard

# 2. Monitor resource usage
railway logs | grep memory

# 3. Optimize your app:
# - Reduce memory leaks
# - Use pagination for large queries
# - Implement caching
# - Use worker processes for heavy tasks

# 4. Upgrade Railway plan if needed
```

### Database Schema Drift

**Problem:** Production schema differs from local

```bash
# 1. Export production schema
RAILWAY_DB_URL=$(railway variables --json | python3 -c "import sys,json; print(json.load(sys.stdin)['DATABASE_URL'])")
pg_dump "${RAILWAY_DB_URL}?sslmode=require" --schema-only > prod_schema.sql

# 2. Compare with local
diff local_schema.sql prod_schema.sql

# 3. Create migration to fix differences
# Write SQL migration file

# 4. Apply to production
psql "${RAILWAY_DB_URL}?sslmode=require" -f migration.sql
```

---

## 📚 Additional Resources

- **Railway Documentation:** https://docs.railway.app
- **Railway CLI Reference:** https://docs.railway.app/develop/cli
- **Railway Discord:** https://discord.gg/railway
- **Railway Status:** https://status.railway.app

---

## 🎯 Quick Reference

### Essential Commands

```bash
# Login & Setup
railway login
railway link

# Deploy
railway up --detach
railway logs --follow

# Variables
railway variables
railway variables set KEY="value"

# Database
railway connect postgres
railway add  # Add new database

# Monitoring
railway status
railway logs
railway open

# Troubleshooting
railway restart
railway logs --build
```

### Common Workflow

```bash
# Daily deployment routine
cd /path/to/project
git pull
# Make your changes
git add -A
git commit -m "your message"
git push origin main
railway up --detach
railway logs --follow
```

---

**Last Updated:** April 2026  
**Version:** 2.0  
**Author:** Railway Deployment Guide

---

This guide covers everything needed to deploy and manage Node.js applications on Railway. Adapt the configuration and commands to match your specific project requirements.
