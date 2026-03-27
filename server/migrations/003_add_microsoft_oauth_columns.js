/**
 * Migration: Add Microsoft OAuth columns to users table
 * Created: 2026-03-24
 */

const dbConfig = require('../../db-config');

async function up() {
    console.log('🔄 Running migration: Add Microsoft OAuth columns...');
    
    const db = dbConfig.rawDb();
    
    try {
        // Add Microsoft OAuth token columns
        await db.query(`
            DO $$ 
            BEGIN
                -- Add microsoft_access_token column if it doesn't exist
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='users' AND column_name='microsoft_access_token'
                ) THEN
                    ALTER TABLE users ADD COLUMN microsoft_access_token TEXT;
                    RAISE NOTICE 'Added microsoft_access_token column to users table';
                END IF;
                
                -- Add microsoft_refresh_token column if it doesn't exist
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='users' AND column_name='microsoft_refresh_token'
                ) THEN
                    ALTER TABLE users ADD COLUMN microsoft_refresh_token TEXT;
                    RAISE NOTICE 'Added microsoft_refresh_token column to users table';
                END IF;
            END $$;
        `);
        
        console.log('✅ Migration completed: Microsoft OAuth columns added');
        return true;
    } catch (error) {
        console.error('❌ Migration failed:', error);
        throw error;
    }
}

async function down() {
    console.log('🔄 Rolling back migration: Remove Microsoft OAuth columns...');
    
    const db = dbConfig.rawDb();
    
    try {
        await db.query(`
            ALTER TABLE users 
            DROP COLUMN IF EXISTS microsoft_access_token,
            DROP COLUMN IF EXISTS microsoft_refresh_token;
        `);
        
        console.log('✅ Rollback completed: Microsoft OAuth columns removed');
        return true;
    } catch (error) {
        console.error('❌ Rollback failed:', error);
        throw error;
    }
}

module.exports = { up, down };
