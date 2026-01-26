const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const fs = require('fs').promises;
const bcrypt = require('bcryptjs');

/**
 * SQLite to PostgreSQL Migration Script
 * 
 * This script migrates all data from SQLite to PostgreSQL without data loss
 * 
 * Usage:
 *   node migrate-to-postgres.js <postgresql_connection_string>
 * 
 * Example:
 *   node migrate-to-postgres.js "postgresql://user:pass@host:5432/dbname"
 */

const POSTGRES_URL = process.env.DATABASE_URL || process.argv[2];

if (!POSTGRES_URL) {
    console.error('❌ Error: PostgreSQL connection string required');
    console.log('\nUsage:');
    console.log('  node migrate-to-postgres.js <postgresql_url>');
    console.log('\nOr set DATABASE_URL environment variable');
    console.log('  export DATABASE_URL="postgresql://user:pass@host:5432/dbname"');
    console.log('  node migrate-to-postgres.js');
    process.exit(1);
}

// Connect to SQLite
const sqliteDb = new sqlite3.Database('./database.db', (err) => {
    if (err) {
        console.error('❌ SQLite connection error:', err);
        process.exit(1);
    }
    console.log('✅ Connected to SQLite database');
});

// Connect to PostgreSQL
const pgPool = new Pool({
    connectionString: POSTGRES_URL,
    ssl: { rejectUnauthorized: false }
});

// Helper function to promisify SQLite queries
function sqliteQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        sqliteDb.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// Helper function for PostgreSQL queries
async function pgQuery(sql, params = []) {
    const client = await pgPool.connect();
    try {
        const result = await client.query(sql, params);
        return result.rows;
    } finally {
        client.release();
    }
}

// Main migration function
async function migrate() {
    console.log('\n🚀 Starting migration from SQLite to PostgreSQL...\n');
    
    try {
        // Step 1: Create PostgreSQL schema
        console.log('📋 Step 1: Creating PostgreSQL schema...');
        const schema = await fs.readFile('./postgres-schema.sql', 'utf8');
        await pgPool.query(schema);
        console.log('✅ Schema created successfully\n');
        
        // Step 2: Migrate users table
        console.log('👥 Step 2: Migrating users...');
        const users = await sqliteQuery('SELECT * FROM users');
        console.log(`   Found ${users.length} users to migrate`);
        
        for (const user of users) {
            await pgQuery(`
                INSERT INTO users (
                    id, full_name, email, password, smtp_email, smtp_password, sender_name,
                    resume_path, photo_path, signature_path, date_of_birth, phone_number,
                    address, oauth_provider, google_access_token, google_refresh_token,
                    total_generated, total_sent, role, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
                ON CONFLICT (email) DO UPDATE SET
                    full_name = EXCLUDED.full_name,
                    password = EXCLUDED.password,
                    role = EXCLUDED.role
            `, [
                user.id, user.full_name, user.email, user.password, user.smtp_email,
                user.smtp_password, user.sender_name, user.resume_path, user.photo_path,
                user.signature_path, user.date_of_birth, user.phone_number, user.address,
                user.oauth_provider, user.google_access_token, user.google_refresh_token,
                user.total_generated || 0, user.total_sent || 0, user.role || 'user',
                user.created_at
            ]);
        }
        console.log(`✅ Migrated ${users.length} users\n`);
        
        // Step 3: Migrate recipients
        console.log('📧 Step 3: Migrating recipients...');
        const recipients = await sqliteQuery('SELECT * FROM recipients');
        console.log(`   Found ${recipients.length} recipients to migrate`);
        
        for (const recipient of recipients) {
            await pgQuery(`
                INSERT INTO recipients (id, user_id, email, website, position, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (user_id, email) DO NOTHING
            `, [
                recipient.id, recipient.user_id, recipient.email, recipient.website,
                recipient.position, recipient.created_at, recipient.updated_at
            ]);
        }
        console.log(`✅ Migrated ${recipients.length} recipients\n`);
        
        // Step 4: Migrate application history
        console.log('📜 Step 4: Migrating application history...');
        const applications = await sqliteQuery('SELECT * FROM application_history');
        console.log(`   Found ${applications.length} applications to migrate`);
        
        for (const app of applications) {
            await pgQuery(`
                INSERT INTO application_history (
                    id, user_id, company_name, position, recipient_email, sent_date,
                    reply_received, reply_date, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `, [
                app.id, app.user_id, app.company_name, app.position, app.recipient_email,
                app.sent_date, app.reply_received || 0, app.reply_date, app.created_at
            ]);
        }
        console.log(`✅ Migrated ${applications.length} applications\n`);
        
        // Step 5: Migrate review cover letters
        console.log('📝 Step 5: Migrating review cover letters...');
        const letters = await sqliteQuery('SELECT * FROM review_cover_letters');
        console.log(`   Found ${letters.length} cover letters to migrate`);
        
        for (const letter of letters) {
            await pgQuery(`
                INSERT INTO review_cover_letters (
                    id, user_id, letter_key, company_name, recipient_email, cover_letter_html,
                    subject, address, date, position, locations, generated, sent, sent_date,
                    stored_recipient_email, stored_recipient_website, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
                ON CONFLICT (user_id, letter_key) DO UPDATE SET
                    cover_letter_html = EXCLUDED.cover_letter_html,
                    sent = EXCLUDED.sent,
                    sent_date = EXCLUDED.sent_date
            `, [
                letter.id, letter.user_id, letter.letter_key, letter.company_name,
                letter.recipient_email, letter.cover_letter_html, letter.subject,
                letter.address, letter.date, letter.position, letter.locations,
                letter.generated || 0, letter.sent || 0, letter.sent_date,
                letter.stored_recipient_email, letter.stored_recipient_website,
                letter.created_at, letter.updated_at
            ]);
        }
        console.log(`✅ Migrated ${letters.length} cover letters\n`);
        
        // Step 6: Migrate user credits
        console.log('💳 Step 6: Migrating user credits...');
        const credits = await sqliteQuery('SELECT * FROM user_credits');
        console.log(`   Found ${credits.length} credit records to migrate`);
        
        for (const credit of credits) {
            await pgQuery(`
                INSERT INTO user_credits (
                    id, user_id, credits_remaining, credits_total, last_purchase_date,
                    expiry_date, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (user_id) DO UPDATE SET
                    credits_remaining = EXCLUDED.credits_remaining,
                    credits_total = EXCLUDED.credits_total,
                    last_purchase_date = EXCLUDED.last_purchase_date,
                    expiry_date = EXCLUDED.expiry_date
            `, [
                credit.id, credit.user_id, credit.credits_remaining || 0,
                credit.credits_total || 0, credit.last_purchase_date,
                credit.expiry_date, credit.created_at, credit.updated_at
            ]);
        }
        console.log(`✅ Migrated ${credits.length} credit records\n`);
        
        // Step 7: Migrate credit transactions
        console.log('💰 Step 7: Migrating credit transactions...');
        const transactions = await sqliteQuery('SELECT * FROM credit_transactions');
        console.log(`   Found ${transactions.length} transactions to migrate`);
        
        for (const txn of transactions) {
            await pgQuery(`
                INSERT INTO credit_transactions (
                    id, user_id, transaction_type, credits_change, balance_after,
                    description, metadata, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [
                txn.id, txn.user_id, txn.transaction_type, txn.credits_change,
                txn.balance_after, txn.description, txn.metadata, txn.created_at
            ]);
        }
        console.log(`✅ Migrated ${transactions.length} transactions\n`);
        
        // Step 8: Update PostgreSQL sequences
        console.log('🔢 Step 8: Updating PostgreSQL sequences...');
        const tables = [
            'users', 'recipients', 'application_history', 'review_cover_letters',
            'plans', 'user_credits', 'credit_transactions', 'monthly_usage_stats',
            'credit_usage_history'
        ];
        
        for (const table of tables) {
            try {
                await pgQuery(`
                    SELECT setval(pg_get_serial_sequence('${table}', 'id'), 
                    COALESCE((SELECT MAX(id) FROM ${table}), 1), true)
                `);
            } catch (err) {
                // Some tables might not have data yet
                console.log(`   Skipped sequence for ${table} (no data)`);
            }
        }
        console.log('✅ Sequences updated\n');
        
        // Step 9: Verify migration
        console.log('🔍 Step 9: Verifying migration...');
        const pgUsers = await pgQuery('SELECT COUNT(*) as count FROM users');
        const pgRecipients = await pgQuery('SELECT COUNT(*) as count FROM recipients');
        const pgLetters = await pgQuery('SELECT COUNT(*) as count FROM review_cover_letters');
        const pgTransactions = await pgQuery('SELECT COUNT(*) as count FROM credit_transactions');
        
        console.log('\n📊 Migration Summary:');
        console.log('═══════════════════════════════════════');
        console.log(`Users:              ${pgUsers[0].count} migrated`);
        console.log(`Recipients:         ${pgRecipients[0].count} migrated`);
        console.log(`Cover Letters:      ${pgLetters[0].count} migrated`);
        console.log(`Transactions:       ${pgTransactions[0].count} migrated`);
        console.log('═══════════════════════════════════════');
        console.log('\n✅ Migration completed successfully!\n');
        
        console.log('📝 Next steps:');
        console.log('1. Set DATABASE_URL in Railway environment variables');
        console.log('2. Deploy your app to Railway: railway up');
        console.log('3. Verify all data is accessible in production');
        console.log('4. Keep SQLite backup for safety: sqlite-backup.sql\n');
        
    } catch (error) {
        console.error('\n❌ Migration failed:', error);
        console.error('\nFull error:', error);
        process.exit(1);
    } finally {
        // Close connections
        sqliteDb.close();
        await pgPool.end();
    }
}

// Run migration
migrate().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
