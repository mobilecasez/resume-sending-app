const dbConfig = require('../../db-config');

/**
 * Migration: Add Soft Delete Columns
 * Purpose: Enable soft deletion across all tables to prevent permanent data loss
 * 
 * Adds to each table:
 * - deleted_at: Timestamp when record was soft deleted (NULL = active)
 * - deleted_by: User ID who performed the deletion (for audit trails)
 */

async function up() {
    try {
        console.log('🔄 Adding soft delete columns to tables...');
        
        const tables = [
            'recipients',
            'application_history',
            'review_cover_letters',
            'plans',
            'notifications',
            'users',
            'credit_transactions',
            'user_credits',
            'payment_orders'
        ];
        
        for (const table of tables) {
            try {
                // Add deleted_at column
                await dbConfig.run(`
                    ALTER TABLE ${table} 
                    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP DEFAULT NULL
                `);
                
                // Add deleted_by column (references users.id)
                await dbConfig.run(`
                    ALTER TABLE ${table} 
                    ADD COLUMN IF NOT EXISTS deleted_by INTEGER DEFAULT NULL
                `);
                
                // Create index for faster queries filtering out deleted records
                await dbConfig.run(`
                    CREATE INDEX IF NOT EXISTS idx_${table}_deleted_at 
                    ON ${table}(deleted_at) 
                    WHERE deleted_at IS NULL
                `);
                
                console.log(`✅ Added soft delete columns to ${table}`);
            } catch (error) {
                console.error(`⚠️  Error adding columns to ${table}:`, error.message);
                // Continue with other tables
            }
        }
        
        console.log('✅ Soft delete columns migration completed');
    } catch (error) {
        console.error('❌ Error in soft delete migration:', error);
        throw error;
    }
}

async function down() {
    try {
        console.log('🔄 Removing soft delete columns from tables...');
        
        const tables = [
            'recipients',
            'application_history',
            'review_cover_letters',
            'plans',
            'notifications',
            'users',
            'credit_transactions',
            'user_credits',
            'payment_orders'
        ];
        
        for (const table of tables) {
            try {
                await dbConfig.run(`DROP INDEX IF EXISTS idx_${table}_deleted_at`);
                await dbConfig.run(`ALTER TABLE ${table} DROP COLUMN IF EXISTS deleted_by`);
                await dbConfig.run(`ALTER TABLE ${table} DROP COLUMN IF EXISTS deleted_at`);
                
                console.log(`✅ Removed soft delete columns from ${table}`);
            } catch (error) {
                console.error(`⚠️  Error removing columns from ${table}:`, error.message);
            }
        }
        
        console.log('✅ Soft delete columns rollback completed');
    } catch (error) {
        console.error('❌ Error in soft delete rollback:', error);
        throw error;
    }
}

module.exports = { up, down };
