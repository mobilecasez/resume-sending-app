# 🐘 PostgreSQL Migration Guide

## Complete guide to migrate from SQLite to PostgreSQL without data loss

---

## 📋 Prerequisites

- [x] Railway account with PostgreSQL plugin
- [x] Local SQLite database with your data
- [x] Node.js and npm installed
- [x] Railway CLI installed

---

## 🚀 Migration Steps

### Step 1: Add PostgreSQL to Railway

```bash
# Option A: Via Railway Dashboard
1. Go to: https://railway.app/project/f7e266ad-cd6e-4d4e-b1d5-9a5470afa014
2. Click "New" → "Database" → "Add PostgreSQL"
3. Railway will automatically create DATABASE_URL variable

# Option B: Via CLI (if available)
railway add postgresql
```

### Step 2: Get Your PostgreSQL Connection String

```bash
# List all environment variables
railway variables

# Look for DATABASE_URL, it should look like:
# postgresql://postgres:PASSWORD@HOST:5432/railway
```

**Copy this DATABASE_URL** - you'll need it for migration!

### Step 3: Backup Your SQLite Data

```bash
cd /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app

# Full backup (already done)
sqlite3 database.db ".dump" > sqlite-backup-$(date +%Y%m%d).sql

# Verify backup
ls -lh sqlite-backup-*.sql
```

### Step 4: Run Migration Script

```bash
# Set your PostgreSQL URL from Railway
export DATABASE_URL="postgresql://postgres:PASSWORD@HOST:5432/railway"

# Run migration
node migrate-to-postgres.js

# Or pass URL directly
node migrate-to-postgres.js "postgresql://postgres:PASSWORD@HOST:5432/railway"
```

**Expected Output:**
```
✅ Connected to SQLite database
✅ Connected to PostgreSQL database
📋 Step 1: Creating PostgreSQL schema...
✅ Schema created successfully

👥 Step 2: Migrating users...
   Found 5 users to migrate
✅ Migrated 5 users

📧 Step 3: Migrating recipients...
   Found 2 recipients to migrate
✅ Migrated 2 recipients

📝 Step 5: Migrating review cover letters...
   Found 2 cover letters to migrate
✅ Migrated 2 cover letters

💰 Step 7: Migrating credit transactions...
   Found 2 transactions to migrate
✅ Migrated 2 transactions

📊 Migration Summary:
═══════════════════════════════════════
Users:              5 migrated
Recipients:         2 migrated
Cover Letters:      2 migrated
Transactions:       2 migrated
═══════════════════════════════════════

✅ Migration completed successfully!
```

### Step 5: Verify Migration

```bash
# Connect to PostgreSQL and verify data
railway connect postgres

# In PostgreSQL shell, run:
SELECT COUNT(*) FROM users;
SELECT email, role FROM users;
\q
```

### Step 6: Update Railway Environment Variables

Your app is now ready to use PostgreSQL! The DATABASE_URL is already set by Railway.

Verify all environment variables are set:

```bash
railway variables
```

You should see:
```
DATABASE_URL=postgresql://postgres:...
JWT_SECRET=fc9955b1b09efc64bc840068f4953380ca333118e4ea3a01e8f1d2ac8266f487
ENCRYPTION_KEY=774e32a8e403200911ae22f83f516da58d792b831166b97d5e0c3e6347844fef
PORT=3000
NODE_ENV=production
```

### Step 7: Deploy to Railway

```bash
# Deploy your updated app
railway up

# Monitor deployment
railway logs --tail
```

### Step 8: Verify Production

1. **Get your Railway URL:**
   ```bash
   railway domain
   ```

2. **Test login with your admin account:**
   - URL: `https://YOUR-DOMAIN.railway.app/login.html`
   - Email: `samrishi24@gmail.com`
   - Password: Your current password

3. **Verify data:**
   - Check dashboard shows your stats
   - Check recipients are listed
   - Check cover letters are available
   - Check credit balance is correct

---

## 🔄 How It Works

### Automatic Database Detection

Your app now automatically detects which database to use:

- **Local Development:** Uses SQLite (`database.db`)
- **Production (Railway):** Uses PostgreSQL (when `DATABASE_URL` is set)

```javascript
// db-config.js automatically detects:
if (DATABASE_URL && DATABASE_URL.startsWith('postgres')) {
    // Use PostgreSQL
} else {
    // Use SQLite
}
```

### Zero Downtime Migration

1. ✅ Old data migrated to PostgreSQL
2. ✅ Admin user auto-created if missing
3. ✅ Default plans inserted
4. ✅ All indexes created for performance
5. ✅ Sequences updated for auto-increment IDs

---

## 📊 Migration Verification Checklist

After migration, verify:

### Data Integrity
- [ ] All users migrated (check count matches)
- [ ] All recipients migrated
- [ ] All cover letters migrated
- [ ] All transactions migrated
- [ ] User credits preserved
- [ ] Admin user exists with correct role

### Functionality
- [ ] Login works
- [ ] Registration works
- [ ] Dashboard displays correct data
- [ ] Cover letter generation works
- [ ] Email sending works (if configured)
- [ ] Credit system works
- [ ] Package selection works

### Performance
- [ ] Pages load quickly
- [ ] Queries are fast
- [ ] No timeout errors

---

## 🔧 Troubleshooting

### Issue: "Connection refused" during migration

**Solution:**
```bash
# Check DATABASE_URL is correct
echo $DATABASE_URL

# Test PostgreSQL connection
railway connect postgres
```

### Issue: "Duplicate key violation" during migration

**Solution:**
```bash
# Clear PostgreSQL tables and re-run
railway connect postgres

# In postgres shell:
DROP TABLE IF EXISTS credit_usage_history CASCADE;
DROP TABLE IF EXISTS monthly_usage_stats CASCADE;
DROP TABLE IF EXISTS credit_transactions CASCADE;
DROP TABLE IF EXISTS user_credits CASCADE;
DROP TABLE IF EXISTS review_cover_letters CASCADE;
DROP TABLE IF EXISTS application_history CASCADE;
DROP TABLE IF EXISTS recipients CASCADE;
DROP TABLE IF EXISTS plans CASCADE;
DROP TABLE IF EXISTS users CASCADE;
\q

# Re-run migration
node migrate-to-postgres.js
```

### Issue: "Cannot find module 'pg'"

**Solution:**
```bash
# Install PostgreSQL driver
npm install pg --save
```

### Issue: Login fails after migration

**Possible causes:**
1. JWT_SECRET doesn't match
2. Passwords not migrated correctly
3. Admin user not created

**Solution:**
```bash
# Check if admin exists
railway connect postgres
SELECT email, role FROM users WHERE role = 'admin';
\q

# If admin missing, create manually:
railway connect postgres
INSERT INTO users (full_name, email, password, role, created_at)
VALUES ('Rishi Samadhiya', 'samrishi24@gmail.com', 'hashed_password', 'admin', NOW());
\q
```

---

## 🎯 Best Practices

### Keep SQLite for Local Development

```bash
# Local: Uses SQLite automatically
npm start

# Production: Uses PostgreSQL automatically
# (when DATABASE_URL is set in Railway)
```

### Regular Backups

```bash
# Backup PostgreSQL on Railway
railway run pg_dump > backup-$(date +%Y%m%d).sql

# Or use Railway's built-in backups (paid feature)
```

### Monitor Database Size

```bash
# Check database size
railway connect postgres
SELECT pg_size_pretty(pg_database_size('railway'));
\q
```

---

## 📈 Performance Improvements

PostgreSQL provides several advantages over SQLite:

✅ **Concurrent Access** - Multiple users can write simultaneously
✅ **Better Performance** - Optimized for web applications
✅ **Data Persistence** - Data survives deployments
✅ **ACID Compliance** - Better data integrity
✅ **Advanced Features** - Full-text search, JSON support, etc.

---

## 🔐 Security Notes

1. **Never commit DATABASE_URL** - It's already in .gitignore
2. **Use SSL** - Railway PostgreSQL uses SSL by default
3. **Backup regularly** - Use Railway's backup feature
4. **Monitor access** - Check Railway logs for suspicious activity
5. **Rotate credentials** - If DATABASE_URL is compromised, regenerate in Railway

---

## 📞 Support

**Migration Issues:**
- Check Railway logs: `railway logs`
- Check PostgreSQL logs: `railway logs --service postgres`
- Email: samrishi24@gmail.com

**Railway PostgreSQL Docs:**
- https://docs.railway.app/databases/postgresql

---

## ✅ Success Criteria

Your migration is successful when:

1. ✅ All data visible in PostgreSQL
2. ✅ App deployed and running on Railway
3. ✅ Login works with existing credentials
4. ✅ All features work correctly
5. ✅ No data loss (counts match SQLite)
6. ✅ Performance is good (fast page loads)

---

## 🎉 You're Done!

Your CV Applyr app now uses PostgreSQL in production!

**Next Steps:**
- Test all functionality thoroughly
- Keep SQLite backup for safety
- Monitor Railway logs for any issues
- Consider enabling Railway's automatic backups

**Access your app:**
```bash
railway open
```

Congratulations! Your data is now safely migrated to PostgreSQL. 🚀
