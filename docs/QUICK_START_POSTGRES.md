# 🚀 PostgreSQL Migration - Quick Start

## What Changed

Your app now supports **both SQLite (local) and PostgreSQL (production)**:

✅ **Local Development**: Automatically uses SQLite  
✅ **Railway Production**: Automatically uses PostgreSQL when DATABASE_URL is set  
✅ **Zero Data Loss**: Complete migration script included  
✅ **Same Code**: Works with both databases without changes  

---

## 📁 New Files Created

1. **db-config.js** - Database abstraction layer (auto-detects SQLite vs PostgreSQL)
2. **db-init.js** - Schema initialization for both databases
3. **postgres-schema.sql** - PostgreSQL-compatible schema
4. **migrate-to-postgres.js** - Migration script (SQLite → PostgreSQL)
5. **POSTGRES_MIGRATION_GUIDE.md** - Complete step-by-step guide
6. **sqlite-backup.sql** - Full backup of your current data

---

## 🎯 Migration in 3 Steps

### Step 1: Add PostgreSQL to Railway

```bash
# Go to Railway dashboard
https://railway.app/project/f7e266ad-cd6e-4d4e-b1d5-9a5470afa014

# Click: New → Database → Add PostgreSQL
# Railway auto-creates DATABASE_URL variable
```

### Step 2: Migrate Your Data

```bash
# Get DATABASE_URL from Railway dashboard (Variables tab)
# It looks like: postgresql://postgres:PASSWORD@HOST:5432/railway

# Run migration
export DATABASE_URL="your-postgresql-url-here"
node migrate-to-postgres.js
```

**Expected output:**
```
✅ Connected to SQLite database
✅ Connected to PostgreSQL database
📋 Creating PostgreSQL schema...
👥 Migrating users... (5 users)
📧 Migrating recipients... (2 recipients)
📝 Migrating cover letters... (2 letters)
💰 Migrating transactions... (2 transactions)

📊 Migration Summary:
═══════════════════════════════════════
Users:              5 migrated
Recipients:         2 migrated
Cover Letters:      2 migrated
Transactions:       2 migrated
═══════════════════════════════════════

✅ Migration completed successfully!
```

### Step 3: Set Environment Variables & Deploy

```bash
# Set required variables in Railway dashboard:
JWT_SECRET=fc9955b1b09efc64bc840068f4953380ca333118e4ea3a01e8f1d2ac8266f487
ENCRYPTION_KEY=774e32a8e403200911ae22f83f516da58d792b831166b97d5e0c3e6347844fef
PORT=3000
NODE_ENV=production

# DATABASE_URL is already set by Railway automatically

# Deploy
railway up
```

---

## ✅ Verification

After deployment, test:

1. **Login**: `https://your-domain.railway.app/login.html`
   - Email: samrishi24@gmail.com
   - Password: (your current password)

2. **Check Data**:
   - Dashboard shows correct stats
   - Recipients list appears
   - Cover letters accessible
   - Credits balance correct

---

## 🔄 How It Works

Your app automatically detects the environment:

**Local (no DATABASE_URL):**
```
🔧 Using SQLite database
✅ Connected to SQLite database
```

**Production (DATABASE_URL set):**
```
🔧 Using PostgreSQL database  
✅ Connected to PostgreSQL database
```

**No code changes needed!** The same `server.js` works for both.

---

## 📊 Current Data

Your SQLite database contains:
- **5 users** (including admin: samrishi24@gmail.com)
- **2 recipients**
- **2 cover letters**
- **2 credit transactions**

All will be migrated to PostgreSQL with zero data loss.

---

## 🆘 Troubleshooting

### Migration fails?
```bash
# Check DATABASE_URL is correct
echo $DATABASE_URL

# Re-export and try again
export DATABASE_URL="postgresql://..."
node migrate-to-postgres.js
```

### Can't login after deployment?
```bash
# Check Railway logs
railway logs

# Look for "Admin user created successfully"
# If missing, admin will be auto-created on startup
```

### Need to re-migrate?
```bash
# Clear PostgreSQL tables
railway connect postgres
# Then DROP all tables and re-run migration
```

---

## 📞 Support

- **Full Guide**: [POSTGRES_MIGRATION_GUIDE.md](POSTGRES_MIGRATION_GUIDE.md)
- **Railway Docs**: https://docs.railway.app/databases/postgresql
- **Email**: samrishi24@gmail.com

---

## 🎉 Benefits

✅ **Persistent Storage** - Data survives deployments  
✅ **Better Performance** - Optimized for web apps  
✅ **Concurrent Access** - Multiple users simultaneously  
✅ **Production Ready** - ACID compliance  
✅ **Scalable** - Grow with your user base  

---

**Ready to migrate? Follow Step 1 above!** 🚀
