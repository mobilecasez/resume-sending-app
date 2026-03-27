require('dotenv').config();
const dbConfig = require('./db-config');

dbConfig.initializeConnection();

async function checkDashboardData() {
    try {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('\n=== CHECKING DASHBOARD DATA ===\n');
        
        // Check users
        const users = await dbConfig.query(
            'SELECT id, email, full_name, total_generated, total_sent FROM users ORDER BY id ASC LIMIT 5'
        );
        console.log('👥 USERS:');
        if (users.length === 0) {
            console.log('  ❌ No users found');
            process.exit(0);
        }
        users.forEach(u => {
            console.log(`  • ID: ${u.id} | ${u.email} | Generated: ${u.total_generated} | Sent: ${u.total_sent}`);
        });
        
        const userId = users[0].id;
        console.log(`\n🔍 Checking data for user ID: ${userId} (${users[0].email})\n`);
        
        // Check recipients
        const recipients = await dbConfig.query(
            'SELECT id, email, website, position FROM recipients WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
            [userId]
        );
        console.log(`📧 RECIPIENTS (${recipients.length}):`);
        if (recipients.length === 0) {
            console.log('  ❌ No recipients found');
        } else {
            recipients.forEach(r => {
                console.log(`  • ID: ${r.id} | ${r.email} | ${r.position}`);
            });
        }
        
        // Check applications
        const apps = await dbConfig.query(
            'SELECT id, company_name, position, recipient_email, sent_date FROM application_history WHERE user_id = ? AND deleted_at IS NULL ORDER BY sent_date DESC LIMIT 10',
            [userId]
        );
        console.log(`\n📋 APPLICATION HISTORY (${apps.length}):`);
        if (apps.length === 0) {
            console.log('  ❌ No applications found');
        } else {
            apps.forEach(a => {
                console.log(`  • ID: ${a.id} | ${a.company_name} | ${a.position} | ${a.sent_date}`);
            });
        }
        
        console.log('\n=== DATABASE CHECK COMPLETE ===\n');
        process.exit(0);
    } catch (err) {
        console.error('❌ Error:', err.message);
        console.error(err);
        process.exit(1);
    }
}

checkDashboardData();
