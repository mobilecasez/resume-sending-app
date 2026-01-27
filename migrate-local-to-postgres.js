const sqlite3 = require('sqlite3').verbose();
const { Client } = require('pg');
const fs = require('fs');
require('dotenv').config();

// SQLite database path
const sqliteDb = new sqlite3.Database('./database.db');

// PostgreSQL client
const pgClient = new Client({
    connectionString: process.env.DATABASE_URL
});

async function migrate() {
    try {
        console.log('🔄 Starting migration from SQLite to local PostgreSQL...\n');
        
        // Connect to PostgreSQL
        await pgClient.connect();
        console.log('✅ Connected to PostgreSQL database\n');
        
        // Create schema
        console.log('📋 Step 1: Creating PostgreSQL schema...');
        const schema = fs.readFileSync('./postgres-schema.sql', 'utf8');
        await pgClient.query(schema);
        console.log('✅ Schema created\n');
        
        // Migrate users
        console.log('👥 Step 2: Migrating users...');
        const users = await new Promise((resolve, reject) => {
            sqliteDb.all('SELECT * FROM users', (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        
        console.log(`   Found ${users.length} users`);
        for (const user of users) {
            await pgClient.query(
                `INSERT INTO users (id, full_name, email, password, smtp_email, smtp_password, sender_name, 
                 resume_path, photo_path, signature_path, date_of_birth, phone_number, address,
                 oauth_provider, google_access_token, google_refresh_token, total_generated, total_sent, 
                 role, created_at) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
                [user.id, user.full_name, user.email, user.password, user.smtp_email, user.smtp_password,
                 user.sender_name, user.resume_path, user.photo_path, user.signature_path, user.date_of_birth,
                 user.phone_number, user.address, user.oauth_provider, user.google_access_token,
                 user.google_refresh_token, user.total_generated || 0, user.total_sent || 0, 
                 user.role || 'user', user.created_at || new Date().toISOString()]
            );
        }
        console.log(`✅ Migrated ${users.length} users\n`);
        
        // Migrate recipients
        console.log('📧 Step 3: Migrating recipients...');
        const recipients = await new Promise((resolve, reject) => {
            sqliteDb.all('SELECT * FROM recipients', (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        
        console.log(`   Found ${recipients.length} recipients`);
        for (const recipient of recipients) {
            await pgClient.query(
                `INSERT INTO recipients (id, user_id, email, website, position, created_at) 
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [recipient.id, recipient.user_id, recipient.email, 
                 recipient.website || recipient.company || '', recipient.position, 
                 recipient.created_at || new Date().toISOString()]
            );
        }
        console.log(`✅ Migrated ${recipients.length} recipients\n`);
        
        // Migrate application history
        console.log('📜 Step 4: Migrating application history...');
        const applications = await new Promise((resolve, reject) => {
            sqliteDb.all('SELECT * FROM application_history', (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        
        console.log(`   Found ${applications.length} applications`);
        for (const app of applications) {
            await pgClient.query(
                `INSERT INTO application_history (id, user_id, company_name, position, recipient_email, 
                 sent_date, created_at) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [app.id, app.user_id, app.company_name, app.position, app.recipient_email,
                 app.sent_date, app.created_at || new Date().toISOString()]
            );
        }
        console.log(`✅ Migrated ${applications.length} applications\n`);
        
        // Migrate review cover letters
        console.log('📝 Step 5: Migrating review cover letters...');
        const letters = await new Promise((resolve, reject) => {
            sqliteDb.all('SELECT * FROM review_cover_letters', (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        
        console.log(`   Found ${letters.length} letters`);
        for (const letter of letters) {
            await pgClient.query(
                `INSERT INTO review_cover_letters (id, user_id, letter_key, company_name, position, 
                 cover_letter_html, created_at) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [letter.id, letter.user_id, letter.letter_key || `letter_${letter.id}`, 
                 letter.company_name, letter.position,
                 letter.cover_letter_content || letter.cover_letter_html, 
                 letter.created_at || new Date().toISOString()]
            );
        }
        console.log(`✅ Migrated ${letters.length} letters\n`);
        
        // Migrate user credits
        console.log('💳 Step 6: Migrating user credits...');
        const credits = await new Promise((resolve, reject) => {
            sqliteDb.all('SELECT * FROM user_credits', (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        
        console.log(`   Found ${credits.length} credit records`);
        for (const credit of credits) {
            await pgClient.query(
                `INSERT INTO user_credits (user_id, credits_remaining, created_at, updated_at) 
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id) DO UPDATE SET 
                 credits_remaining = $2, updated_at = $3`,
                [credit.user_id, credit.credits_remaining || 0, 
                 credit.created_at || new Date().toISOString(),
                 credit.last_updated || new Date().toISOString()]
            );
        }
        console.log(`✅ Migrated ${credits.length} credit records\n`);
        
        // Migrate credit transactions
        console.log('💰 Step 7: Migrating credit transactions...');
        const transactions = await new Promise((resolve, reject) => {
            sqliteDb.all('SELECT * FROM credit_transactions', (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        
        console.log(`   Found ${transactions.length} transactions`);
        for (const txn of transactions) {
            await pgClient.query(
                `INSERT INTO credit_transactions (id, user_id, credits_change, balance_after, transaction_type, 
                 description, created_at) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [txn.id, txn.user_id, txn.amount || txn.credits_change || 0, 
                 txn.balance_after || 0, txn.transaction_type,
                 txn.description, txn.created_at || new Date().toISOString()]
            );
        }
        console.log(`✅ Migrated ${transactions.length} transactions\n`);
        
        // Migrate plans
        console.log('📦 Step 8: Migrating plans...');
        const plans = await new Promise((resolve, reject) => {
            sqliteDb.all('SELECT * FROM plans', (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        
        console.log(`   Found ${plans.length} plans`);
        for (const plan of plans) {
            await pgClient.query(
                `INSERT INTO plans (id, name, credits, price, validity_days, description, features, is_active, created_at) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (id) DO UPDATE SET
                 name = $2, credits = $3, price = $4, validity_days = $5, description = $6, features = $7, is_active = $8`,
                [plan.id, plan.name, plan.credits, plan.price, plan.validity_days || 30,
                 plan.description, plan.features, plan.is_active ? 1 : 0, 
                 plan.created_at || new Date().toISOString()]
            );
        }
        console.log(`✅ Migrated ${plans.length} plans\n`);
        
        // Update sequences
        console.log('🔢 Step 9: Updating PostgreSQL sequences...');
        await pgClient.query(`SELECT setval('users_id_seq', (SELECT MAX(id) FROM users))`);
        await pgClient.query(`SELECT setval('recipients_id_seq', (SELECT MAX(id) FROM recipients))`);
        await pgClient.query(`SELECT setval('application_history_id_seq', (SELECT MAX(id) FROM application_history))`);
        await pgClient.query(`SELECT setval('review_cover_letters_id_seq', (SELECT MAX(id) FROM review_cover_letters))`);
        await pgClient.query(`SELECT setval('credit_transactions_id_seq', (SELECT MAX(id) FROM credit_transactions))`);
        console.log('✅ Sequences updated\n');
        
        console.log('📊 Migration Summary:');
        console.log(`   👥 Users: ${users.length}`);
        console.log(`   📧 Recipients: ${recipients.length}`);
        console.log(`   📜 Applications: ${applications.length}`);
        console.log(`   📝 Cover Letters: ${letters.length}`);
        console.log(`   💳 Credit Records: ${credits.length}`);
        console.log(`   💰 Transactions: ${transactions.length}`);
        console.log(`   📦 Plans: ${plans.length}`);
        console.log('\n✅ Migration completed successfully!\n');
        
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    } finally {
        sqliteDb.close();
        await pgClient.end();
    }
}

migrate();
