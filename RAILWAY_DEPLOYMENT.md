# Railway Deployment Guide

## 🚀 Deploy CV Applyr to Railway

### Step 1: Set Environment Variables in Railway

Go to your Railway project settings and add these environment variables:

```bash
# Required Variables
JWT_SECRET=your-super-secret-jwt-key-min-32-chars-random-string
ENCRYPTION_KEY=your-encryption-key-min-32-chars-random-string
PORT=3000
NODE_ENV=production

# Google OAuth (Update with your credentials)
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_CALLBACK_URL=https://your-railway-domain.railway.app/auth/google/callback

# Admin User (Optional - will be auto-created on first run)
ADMIN_EMAIL=samrishi24@gmail.com
ADMIN_NAME=Rishi Samadhiya
ADMIN_PASSWORD=admin123
```

### Step 2: Generate Secure Keys

Use these commands to generate secure random keys:

```bash
# For JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# For ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 3: Deploy to Railway

```bash
# Make sure you're in the project directory
cd /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app

# Deploy to Railway
railway up
```

### Step 4: Database Initialization

The server will automatically:
1. Create all required tables on startup
2. Initialize an admin user (samrishi24@gmail.com) if it doesn't exist
3. Create default subscription plans

### Step 5: Update Google OAuth Redirect URI

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Navigate to: APIs & Services > Credentials
3. Edit your OAuth 2.0 Client
4. Add Authorized Redirect URI: `https://your-railway-domain.railway.app/auth/google/callback`
5. Save changes

### Step 6: Test Your Deployment

1. Visit your Railway URL: `https://your-project.railway.app`
2. Try logging in with:
   - Email: samrishi24@gmail.com
   - Password: admin123 (or whatever you set in ADMIN_PASSWORD)
3. Change the password immediately after first login!

---

## 🔄 Recommended: Migrate to PostgreSQL

SQLite uses file-based storage which is ephemeral on Railway. For production, migrate to PostgreSQL:

### Add PostgreSQL to Railway

```bash
# In Railway dashboard
1. Click "New" > "Database" > "Add PostgreSQL"
2. Railway will automatically add DATABASE_URL to your environment variables
```

### Migration Steps (Future)

1. Export your local SQLite data
2. Create migration script to PostgreSQL
3. Update server.js to use `pg` instead of `sqlite3`
4. Redeploy to Railway

---

## 📊 Monitoring

Check your deployment logs:

```bash
railway logs
```

Monitor your service:

```bash
railway status
```

---

## ⚠️ Important Security Notes

1. **Change default admin password** immediately after first login
2. **Never commit** `.env` file to git
3. **Use strong secrets** for JWT_SECRET and ENCRYPTION_KEY
4. **Enable 2FA** on your Railway account
5. **Regularly backup** your database

---

## 🐛 Troubleshooting

### Login Issues

If you can't login after deployment:

1. Check Railway logs: `railway logs`
2. Verify admin user was created (look for "✓ Admin user created successfully")
3. Ensure JWT_SECRET matches between deployments
4. Try registering a new account to test

### Database Issues

If database tables are missing:

1. Check logs for table creation messages
2. Redeploy: `railway up --detach`
3. Restart service in Railway dashboard

### OAuth Issues

If Google OAuth fails:

1. Verify GOOGLE_CALLBACK_URL matches Railway domain
2. Check Google Cloud Console redirect URIs
3. Ensure GOOGLE_CLIENT_ID and SECRET are correct

---

## 📞 Support

For issues specific to this deployment:
- Email: samrishi24@gmail.com
- Check Railway logs for detailed error messages
