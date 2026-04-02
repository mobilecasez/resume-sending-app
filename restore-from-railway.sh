#!/bin/bash

# Restore Railway Database to Local PostgreSQL
# This script restores the downloaded Railway backup to your local database
# Usage: ./restore-from-railway.sh [--yes]

# Check for --yes flag
AUTO_CONFIRM=false
if [ "$1" == "--yes" ] || [ "$1" == "-y" ]; then
    AUTO_CONFIRM=true
fi

echo "🔄 Restoring Railway database to local PostgreSQL..."
echo "=================================================="

# Check if backup file exists
BACKUP_FILE="database/backups/railway_production.sql"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "❌ Error: Backup file not found: $BACKUP_FILE"
    echo ""
    echo "Please download the Railway database first:"
    echo "  ./download-railway-db.sh"
    exit 1
fi

# Local database URL
LOCAL_DB_URL="postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev"

echo "📁 Backup file: $BACKUP_FILE"
echo "🎯 Target database: cvapplyr_dev (local)"
echo ""

# Backup current local database first
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOCAL_BACKUP="database/backups/local_before_restore_${TIMESTAMP}.sql"

echo "💾 Creating backup of current local database..."
pg_dump "$LOCAL_DB_URL" > "$LOCAL_BACKUP" 2>/dev/null

if [ $? -eq 0 ]; then
    echo "✅ Local database backed up to: $LOCAL_BACKUP"
else
    echo "⚠️  Warning: Could not backup local database (may be empty)"
fi

echo ""

# Ask for confirmation unless --yes flag is set
if [ "$AUTO_CONFIRM" = false ]; then
    read -p "⚠️  This will REPLACE your local database. Continue? (yes/no): " -r
    echo ""
    
    if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
        echo "❌ Restore cancelled"
        exit 1
    fi
else
    echo "⚠️  Auto-confirmed: Replacing local database..."
    echo ""
fi

echo "🗑️  Dropping existing tables..."
psql "$LOCAL_DB_URL" << EOF
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO rishisamadhiya;
GRANT ALL ON SCHEMA public TO public;
EOF

if [ $? -ne 0 ]; then
    echo "❌ Failed to reset database"
    exit 1
fi

echo "📥 Restoring database from Railway backup..."
psql "$LOCAL_DB_URL" < "$BACKUP_FILE"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Database restored successfully!"
    echo ""
    echo "📊 Verification:"
    
    # Count users
    USER_COUNT=$(psql "$LOCAL_DB_URL" -t -c "SELECT COUNT(*) FROM users;" 2>/dev/null | tr -d ' ')
    RECIPIENT_COUNT=$(psql "$LOCAL_DB_URL" -t -c "SELECT COUNT(*) FROM recipients;" 2>/dev/null | tr -d ' ')
    APP_COUNT=$(psql "$LOCAL_DB_URL" -t -c "SELECT COUNT(*) FROM application_history;" 2>/dev/null | tr -d ' ')
    
    echo "   👥 Users: $USER_COUNT"
    echo "   📧 Recipients: $RECIPIENT_COUNT"
    echo "   📨 Applications: $APP_COUNT"
    echo ""
    echo "🎉 Your local database now has all the Railway production data!"
    
else
    echo ""
    echo "❌ Failed to restore database"
    echo ""
    echo "🔄 To restore your previous local database:"
    echo "   psql $LOCAL_DB_URL < $LOCAL_BACKUP"
    exit 1
fi

echo ""
echo "=================================================="
echo "✅ Restore complete!"
