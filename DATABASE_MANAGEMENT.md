# Database Management Guide

## Overview
This application uses **PostgreSQL only** (SQLite has been completely removed).

- **Local Development**: `postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev`
- **Production (Railway)**: Set in Railway environment variables

---

## 📥 Download Production Database from Railway

### Step 1: Get Railway Database URL

1. Go to Railway dashboard: https://railway.app
2. Open your `cvapplyr` project
3. Click on **PostgreSQL** database
4. Go to **Variables** tab
5. Copy the `DATABASE_URL` value (it looks like):
   ```
   postgresql://postgres:password@containers-us-west-xxxxx.railway.app:7654/railway
   ```

### Step 2: Download the Database

```bash
# Set the Railway database URL (replace with your actual URL)
export RAILWAY_DATABASE_URL='postgresql://postgres:password@containers-us-west-xxxxx.railway.app:7654/railway'

# Download the database
./download-railway-db.sh
```

This will:
- ✅ Download the entire production database
- ✅ Save it to `database/backups/railway_backup_TIMESTAMP.sql`
- ✅ Create a symlink `database/backups/railway_production.sql` (always points to latest)

---

## 🔄 Restore Railway Database to Local

After downloading, restore it to your local development database:

```bash
./restore-from-railway.sh
```

This will:
- ✅ Backup your current local database first (safety!)
- ✅ Drop and recreate the local database
- ✅ Restore all data from Railway
- ✅ Show verification counts (users, recipients, applications)

**⚠️ Warning**: This will REPLACE your local database with production data.

---

## 📊 View Database Contents

### Option 1: Using pgAdmin 4 (GUI)

1. Open pgAdmin 4
2. Right-click **Servers** → **Register** → **Server**
3. Enter connection details:
   - **Host**: `localhost`
   - **Port**: `5432`
   - **Database**: `cvapplyr_dev`
   - **Username**: `rishisamadhiya`
   - **Password**: (leave empty)
4. Navigate to **Databases** → **cvapplyr_dev** → **Schemas** → **public** → **Tables**
5. Right-click any table → **View/Edit Data** → **All Rows**

### Option 2: Using Command Line Script

```bash
node view-database.js
```

This will show:
- All tables and their row counts
- Sample data from each table (first 10 rows)
- Table structure

---

## 🗄️ Backup Management

### Automatic Backups

When you restore from Railway, a backup of your local database is automatically created:
```
database/backups/local_before_restore_TIMESTAMP.sql
```

### Manual Backup

```bash
# Backup local database
pg_dump postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev > database/backups/manual_backup_$(date +%Y%m%d_%H%M%S).sql

# Backup Railway database (after setting RAILWAY_DATABASE_URL)
./download-railway-db.sh
```

### List All Backups

```bash
ls -lh database/backups/
```

---

## 🚀 Database Schema Updates

If you modify the database schema:

1. **Update Local**:
   - Edit `database/postgres-schema.sql`
   - Restart server (it auto-applies schema)

2. **Update Production**:
   - Schema migrations are in `db-init.js` → `runPostgresMigrations()`
   - Deploy to Railway
   - Migrations run automatically on server start

3. **Sync After Changes**:
   ```bash
   # Download updated production schema
   ./download-railway-db.sh
   ```

---

## 📦 Database Tables

Current tables (11 total):

1. **users** - User accounts and profiles
2. **recipients** - Email recipients for each user
3. **application_history** - Sent applications tracking
4. **credit_transactions** - Payment and credit purchases
5. **credit_usage_history** - Credit usage logs
6. **monthly_usage_stats** - Monthly statistics
7. **notifications** - User notifications
8. **payment_orders** - Razorpay orders
9. **plans** - Subscription plans (4 default plans)
10. **reply_forwards_config** - Email forwarding settings
11. **user_sessions** - Active user sessions

---

## 🔧 Troubleshooting

### "pg_dump: command not found"

Install PostgreSQL client tools:
```bash
brew install postgresql@15
```

The download script will try to install this automatically if missing.

### "Connection refused to Railway"

1. Check Railway database is running (not sleeping)
2. Verify DATABASE_URL is correct
3. Check firewall/network settings

### "Local database restore failed"

Restore from backup:
```bash
# Find your backup
ls -lh database/backups/local_before_restore_*.sql

# Restore it
psql postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev < database/backups/local_before_restore_XXXXXX.sql
```

---

## 📝 Notes

- SQLite has been **completely removed** from the codebase
- All references to `database.db` are ignored (see `.gitignore`)
- Migration scripts in `scripts/migrate-*.js` are for historical reference only
- Always backup before restoring!
- Railway backups are kept for safety - don't delete them

---

## 🔗 Quick Reference

```bash
# Download from Railway
export RAILWAY_DATABASE_URL='your_url_here'
./download-railway-db.sh

# Restore to local
./restore-from-railway.sh

# View data
node view-database.js

# Manual backup
pg_dump postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev > backup.sql
```
