const dbConfig = require('../../db-config');

/**
 * Migration: Create Audit Log Table
 * Purpose: Track all data modifications and deletions for compliance and recovery
 * 
 * This table captures:
 * - All soft deletes
 * - User account changes
 * - Credit transactions
 * - Important data modifications
 */

async function up() {
    try {
        console.log('🔄 Creating audit_log table...');
        
        await dbConfig.run(`
            CREATE TABLE IF NOT EXISTS audit_log (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                table_name VARCHAR(100) NOT NULL,
                record_id INTEGER,
                action VARCHAR(50) NOT NULL,
                old_data TEXT,
                new_data TEXT,
                ip_address VARCHAR(50),
                user_agent TEXT,
                metadata TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            )
        `);
        
        // Create index for faster lookups
        await dbConfig.run(`
            CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id)
        `);
        
        await dbConfig.run(`
            CREATE INDEX IF NOT EXISTS idx_audit_log_table_record ON audit_log(table_name, record_id)
        `);
        
        await dbConfig.run(`
            CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC)
        `);
        
        console.log('✅ Audit log table created successfully');
    } catch (error) {
        console.error('❌ Error creating audit log table:', error);
        throw error;
    }
}

async function down() {
    try {
        console.log('🔄 Dropping audit_log table...');
        
        await dbConfig.run('DROP INDEX IF EXISTS idx_audit_log_created_at');
        await dbConfig.run('DROP INDEX IF EXISTS idx_audit_log_table_record');
        await dbConfig.run('DROP INDEX IF EXISTS idx_audit_log_user_id');
        await dbConfig.run('DROP TABLE IF EXISTS audit_log');
        
        console.log('✅ Audit log table dropped successfully');
    } catch (error) {
        console.error('❌ Error dropping audit log table:', error);
        throw error;
    }
}

module.exports = { up, down };
