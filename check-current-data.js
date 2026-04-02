require('dotenv').config();
const dbConfig = require('./db-config');

async function checkCurrentData() {
    console.log('\n🔍 Checking Current PostgreSQL Database Data\n');
    console.log('='.repeat(80));
    console.log('Database URL:', process.env.DATABASE_URL);
    console.log('='.repeat(80) + '\n');
    
    try {
        dbConfig.initializeConnection();
        const db = dbConfig.rawDb();
        
        // Check users
        const users = await db.query('SELECT id, email, full_name, total_generated, total_sent, created_at FROM users ORDER BY created_at');
        console.log('\n👥 USERS TABLE:');
        console.log(`Total users: ${users.rows.length}`);
        if (users.rows.length > 0) {
            console.table(users.rows);
        } else {
            console.log('   (no users found)\n');
        }
        
        // Check recipients
        const recipients = await db.query('SELECT id, user_id, email, position, created_at FROM recipients ORDER BY created_at LIMIT 10');
        console.log('\n📧 RECIPIENTS TABLE:');
        console.log(`Total recipients: ${recipients.rows.length}`);
        if (recipients.rows.length > 0) {
            console.table(recipients.rows);
        } else {
            console.log('   (no recipients found)\n');
        }
        
        // Check application history
        const applications = await db.query('SELECT id, user_id, company_name, position, sent_date, reply_received FROM application_history ORDER BY sent_date DESC LIMIT 10');
        console.log('\n📨 APPLICATION HISTORY:');
        console.log(`Total applications: ${applications.rows.length}`);
        if (applications.rows.length > 0) {
            console.table(applications.rows);
        } else {
            console.log('   (no applications found)\n');
        }
        
        // Check plans
        const plans = await db.query('SELECT id, name, price, credits FROM plans ORDER BY display_order');
        console.log('\n💰 PLANS TABLE:');
        console.log(`Total plans: ${plans.rows.length}`);
        if (plans.rows.length > 0) {
            console.table(plans.rows);
        } else {
            console.log('   (no plans found)\n');
        }
        
        console.log('\n' + '='.repeat(80));
        console.log('✅ Data check complete\n');
        
        process.exit(0);
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error('\nFull error:', error);
        process.exit(1);
    }
}

checkCurrentData();
