const { Pool } = require('pg');

// Database connection - use the correct connection string from .env
const pool = new Pool({
    connectionString: 'postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev'
});

async function debugActivity() {
    try {
        console.log('\n🔍 ============ ACTIVITY DEBUG REPORT ============\n');
        
        // Get all users
        const users = await pool.query('SELECT id, email, full_name, total_generated, total_sent FROM users');
        console.log('👥 Users in database:', users.rows.length);
        users.rows.forEach(user => {
            console.log(`   - ID: ${user.id}, Email: ${user.email}, Name: ${user.full_name}`);
            console.log(`     Generated: ${user.total_generated}, Sent: ${user.total_sent}`);
        });
        
        console.log('\n');
        
        // Check application_history for each user
        for (const user of users.rows) {
            const history = await pool.query(
                'SELECT * FROM application_history WHERE user_id = $1 ORDER BY sent_date DESC',
                [user.id]
            );
            
            console.log(`📧 Application history for ${user.email} (User ID: ${user.id}):`);
            if (history.rows.length === 0) {
                console.log('   ⚠️ No records found');
            } else {
                console.log(`   ✅ Found ${history.rows.length} records:`);
                history.rows.slice(0, 5).forEach((record, idx) => {
                    console.log(`      ${idx + 1}. Company: ${record.company_name}, Email: ${record.recipient_email}`);
                    console.log(`         Sent Date: ${record.sent_date}`);
                });
            }
            console.log('\n');
        }
        
        // Check recent activity in last 30 days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        console.log('📊 Activity in last 30 days:');
        const recentActivity = await pool.query(
            `SELECT 
                user_id,
                DATE(sent_date) as date,
                COUNT(*) as sent_count
            FROM application_history
            WHERE sent_date >= $1
            GROUP BY user_id, DATE(sent_date)
            ORDER BY date DESC`,
            [thirtyDaysAgo.toISOString()]
        );
        
        if (recentActivity.rows.length === 0) {
            console.log('   ⚠️ No activity in last 30 days\n');
        } else {
            console.log(`   ✅ Found ${recentActivity.rows.length} days with activity:`);
            recentActivity.rows.forEach(row => {
                console.log(`      User ${row.user_id}: ${row.date} - ${row.sent_count} sent`);
            });
            console.log('\n');
        }
        
        // Check credit_usage_history
        console.log('💳 Credit usage history:');
        const creditUsage = await pool.query(
            'SELECT user_id, COUNT(*) as usage_count FROM credit_usage_history GROUP BY user_id'
        );
        
        if (creditUsage.rows.length === 0) {
            console.log('   ⚠️ No credit usage records\n');
        } else {
            creditUsage.rows.forEach(row => {
                console.log(`   User ${row.user_id}: ${row.usage_count} credit usage records`);
            });
            console.log('\n');
        }
        
        console.log('============ END DEBUG REPORT ============\n');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
    } finally {
        await pool.end();
    }
}

debugActivity();
