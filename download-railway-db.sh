#!/bin/bash

# Download PostgreSQL Database from Railway
# This script downloads the production database and saves it locally

echo "📥 Downloading PostgreSQL database from Railway..."
echo "=================================================="

# Check if Railway database URL is set
if [ -z "$RAILWAY_DATABASE_URL" ]; then
    echo "❌ Error: RAILWAY_DATABASE_URL environment variable is not set"
    echo ""
    echo "Please set it first:"
    echo "  export RAILWAY_DATABASE_URL='postgresql://user:password@host:port/database'"
    echo ""
    echo "Or run with:"
    echo "  RAILWAY_DATABASE_URL='your_url_here' ./download-railway-db.sh"
    exit 1
fi

# Create backups directory if it doesn't exist
mkdir -p database/backups

# Generate timestamp for backup file
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="database/backups/railway_backup_${TIMESTAMP}.sql"

echo "🔗 Connecting to Railway database..."
echo "📁 Backup file: $BACKUP_FILE"
echo ""

# Use pg_dump to download the database
# Install pg_dump if needed: brew install postgresql@17
PG_DUMP_CMD=""

# Check for pg_dump in common locations (prefer v17)
if [ -f "/opt/homebrew/opt/postgresql@17/bin/pg_dump" ]; then
    PG_DUMP_CMD="/opt/homebrew/opt/postgresql@17/bin/pg_dump"
elif [ -f "/usr/local/opt/postgresql@17/bin/pg_dump" ]; then
    PG_DUMP_CMD="/usr/local/opt/postgresql@17/bin/pg_dump"
elif [ -f "/opt/homebrew/opt/postgresql@15/bin/pg_dump" ]; then
    PG_DUMP_CMD="/opt/homebrew/opt/postgresql@15/bin/pg_dump"
elif [ -f "/usr/local/opt/postgresql@15/bin/pg_dump" ]; then
    PG_DUMP_CMD="/usr/local/opt/postgresql@15/bin/pg_dump"
elif command -v pg_dump &> /dev/null; then
    PG_DUMP_CMD="pg_dump"
fi

if [ -z "$PG_DUMP_CMD" ]; then
    echo "❌ pg_dump not found!"
    echo "📦 Installing PostgreSQL client tools..."
    brew install postgresql@17
    
    if [ $? -ne 0 ]; then
        echo "❌ Failed to install PostgreSQL client tools"
        echo "Please install manually: brew install postgresql@17"
        exit 1
    fi
    
    # Set path after installation
    PG_DUMP_CMD="/opt/homebrew/opt/postgresql@17/bin/pg_dump"
fi

# Download database
echo "⏳ Downloading database..."
echo "Using: $PG_DUMP_CMD"
"$PG_DUMP_CMD" "$RAILWAY_DATABASE_URL" > "$BACKUP_FILE"

if [ $? -eq 0 ]; then
    # Get file size
    FILE_SIZE=$(ls -lh "$BACKUP_FILE" | awk '{print $5}')
    
    echo ""
    echo "✅ Database downloaded successfully!"
    echo "📁 File: $BACKUP_FILE"
    echo "📊 Size: $FILE_SIZE"
    echo ""
    echo "Latest backup is saved as: database/backups/railway_production.sql"
    
    # Create a symlink to latest backup
    ln -sf "railway_backup_${TIMESTAMP}.sql" database/backups/railway_production.sql
    
    echo ""
    echo "🔄 To restore this backup to your local database:"
    echo "   psql postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev < $BACKUP_FILE"
    echo ""
    echo "Or use the restore script:"
    echo "   ./restore-from-railway.sh"
    
else
    echo ""
    echo "❌ Failed to download database"
    echo "Please check your RAILWAY_DATABASE_URL and network connection"
    exit 1
fi

echo ""
echo "=================================================="
echo "✅ Download complete!"
