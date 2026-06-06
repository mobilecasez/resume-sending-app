const dbConfig = require('../../db-config');

/**
 * Migration: Add IP address tracking to users table
 * Purpose:
 *  - registration_ip: IP at account creation (for abuse detection / free-credit restriction)
 *  - last_login_ip:   IP at most recent login (for anomaly detection)
 *  - last_seen_at:    Timestamp of last activity
 */

async function up() {
    try {
        console.log('🔄 Adding IP tracking columns to users table...');

        await dbConfig.run(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS registration_ip TEXT DEFAULT NULL
        `);
        console.log('✅ Added registration_ip');

        await dbConfig.run(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS last_login_ip TEXT DEFAULT NULL
        `);
        console.log('✅ Added last_login_ip');

        await dbConfig.run(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP DEFAULT NULL
        `);
        console.log('✅ Added last_seen_at');

        // Index for quick IP lookups (abuse checks)
        await dbConfig.run(`
            CREATE INDEX IF NOT EXISTS idx_users_registration_ip
            ON users(registration_ip)
        `);
        console.log('✅ Created index on registration_ip');

        console.log('✅ IP tracking migration completed');
    } catch (error) {
        console.error('❌ Migration error:', error);
        throw error;
    }
}

async function down() {
    try {
        await dbConfig.run(`DROP INDEX IF EXISTS idx_users_registration_ip`);
        await dbConfig.run(`ALTER TABLE users DROP COLUMN IF EXISTS registration_ip`);
        await dbConfig.run(`ALTER TABLE users DROP COLUMN IF EXISTS last_login_ip`);
        await dbConfig.run(`ALTER TABLE users DROP COLUMN IF EXISTS last_seen_at`);
        console.log('✅ IP tracking rollback completed');
    } catch (error) {
        console.error('❌ Rollback error:', error);
        throw error;
    }
}

module.exports = { up, down };
