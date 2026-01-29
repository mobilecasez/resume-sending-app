# 🚀 Railway Deployment Checklist

## Before Deployment

### ✅ Pre-Deployment Tasks

- [x] Database initialization script created (`init-admin.js`)
- [x] Server.js updated to auto-create admin user
- [x] Environment variables setup script created (`setup-railway-env.sh`)
- [x] Railway configuration file created (`railway.toml`)
- [x] .gitignore configured to exclude sensitive files
- [x] Role column added to users table

### 📋 Railway Setup Steps

#### 1. Set Environment Variables

Go to Railway Dashboard → Your Project → Variables tab and add:

```bash
JWT_SECRET=fc9955b1b09efc64bc840068f4953380ca333118e4ea3a01e8f1d2ac8266f487
ENCRYPTION_KEY=774e32a8e403200911ae22f83f516da58d792b831166b97d5e0c3e6347844fef
PORT=3000
NODE_ENV=production
```

#### 2. Update Google OAuth Settings

**In Google Cloud Console:**
1. Go to: https://console.cloud.google.com
2. Select your project
3. Navigate to: APIs & Services → Credentials
4. Click on your OAuth 2.0 Client ID
5. Under "Authorized redirect URIs", add your Railway domain
6. Save changes

**Get your Railway domain first:**
```bash
railway domain
```

Then update these variables in Railway:
```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALLBACK_URL=https://YOUR-RAILWAY-DOMAIN.railway.app/auth/google/callback
```

#### 3. Deploy to Railway

```bash
cd /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app
railway up
```

## After Deployment

### ✅ Post-Deployment Verification

#### 1. Check Deployment Logs

```bash
railway logs
```

Look for these success messages:
- ✅ "Connected to SQLite database"
- ✅ "Users table ready"
- ✅ "Admin user created successfully" (or "Admin user already exists")
- ✅ "Server running on port 3000"

#### 2. Test Website Access

1. Get your Railway URL:
   ```bash
   railway open
   ```

2. Visit your deployed site
3. Verify the homepage loads correctly

#### 3. Test Admin Login

**Login Credentials:**
- Email: `samrishi24@gmail.com`
- Password: `admin123`

**Steps:**
1. Go to: `https://YOUR-DOMAIN.railway.app/login.html`
2. Enter admin credentials
3. Should redirect to dashboard
4. Verify you can see admin features

#### 4. Change Admin Password IMMEDIATELY

1. Go to Profile page
2. Navigate to "Change Password" section
3. Update from `admin123` to a strong password
4. Save changes

#### 5. Test Core Features

- [ ] Registration works for new users
- [ ] Login/logout works
- [ ] Dashboard displays correctly
- [ ] Package selection page loads
- [ ] Profile page shows user info
- [ ] Usage stats display
- [ ] Legal pages (Terms, Privacy, Refund) accessible
- [ ] Footer links work

#### 6. Test Google OAuth (if configured)

- [ ] "Login with Google" button appears
- [ ] Google authentication flow works
- [ ] Redirects back to dashboard after auth
- [ ] Google user created in database

## Troubleshooting

### Issue: Can't login after deployment

**Possible causes:**
1. Database not initialized
2. Admin user not created
3. JWT_SECRET mismatch

**Solutions:**
```bash
# Check logs for initialization
railway logs | grep "Admin user"

# Redeploy if needed
railway up --detach

# Restart service
railway restart
```

### Issue: "Internal Server Error" on login

**Check:**
1. JWT_SECRET is set in Railway variables
2. Database tables created successfully
3. Server logs show connection

```bash
railway logs --tail
```

### Issue: Google OAuth not working

**Check:**
1. GOOGLE_CALLBACK_URL matches Railway domain
2. Redirect URI added in Google Console
3. CLIENT_ID and SECRET are correct

**Update OAuth callback:**
```bash
# Get your Railway domain
railway domain

# Update in Google Console and Railway variables
```

## Database Persistence

### ⚠️ Important: SQLite Limitations

Railway uses **ephemeral storage**. Your SQLite database will be recreated on:
- Every new deployment
- Service restarts
- Container migrations

**Current Setup:**
- Database schema auto-created on startup ✅
- Admin user auto-created if missing ✅
- Default plans auto-inserted ✅

**For Production:**
Consider migrating to PostgreSQL for persistent storage:

```bash
# Add PostgreSQL to Railway project
railway add --plugin postgresql

# Railway will provide DATABASE_URL
# Update server.js to use PostgreSQL
```

## Monitoring

### Check Service Status

```bash
railway status
```

### View Recent Logs

```bash
railway logs --tail 100
```

### Monitor Deployment

```bash
railway logs --deployment
```

## Security Checklist

- [ ] JWT_SECRET is secure random string (not default)
- [ ] ENCRYPTION_KEY is secure random string (not default)
- [ ] Admin password changed from default
- [ ] .env file not committed to git
- [ ] Google OAuth redirect URIs restricted
- [ ] HTTPS enabled (Railway does this automatically)
- [ ] Railway account has 2FA enabled

## Next Steps

### Recommended Actions

1. **Set up Custom Domain** (Optional)
   ```bash
   railway domain add your-custom-domain.com
   ```

2. **Enable Railway Cron Jobs** (For cleanup tasks)
   - Create cron jobs for database maintenance
   - Schedule backup tasks

3. **Add PostgreSQL** (Recommended for production)
   - More reliable than SQLite
   - Better performance
   - Persistent storage

4. **Set up Monitoring**
   - Railway built-in metrics
   - External monitoring service (UptimeRobot, etc.)

5. **Payment Gateway Integration**
   - Integrate Stripe/Razorpay
   - Update packages.html frontend
   - Test payment flow

## Support

**Railway Support:**
- Discord: https://discord.gg/railway
- Docs: https://docs.railway.app

**Project Issues:**
- Email: samrishi24@gmail.com

## Success! 🎉

If all checklist items are complete, your CV Applyr app is successfully deployed on Railway!

**Access your app:**
```bash
railway open
```

**Share the URL:**
- Your Railway URL: `https://YOUR-PROJECT.railway.app`
- Login: samrishi24@gmail.com
- (Remember to change password!)
