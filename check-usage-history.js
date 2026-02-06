require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

async function checkUsageHistory() {
  try {
    console.log('📊 Checking credit_usage_history table...\n');
    
    const userId = 1;
    
    const result = await pool.query(
      `SELECT id, user_id, credits_used, action_type, company_name, position, recipient_email, created_at 
       FROM credit_usage_history 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 50`,
      [userId]
    );
    
    console.log(`Total records: ${result.rows.length}\n`);
    
    if (result.rows.length > 0) {
      console.log('Recent usage history (Last 50):');
      result.rows.forEach((record, index) => {
        const date = new Date(record.created_at);
        console.log(`${index + 1}. ID ${record.id}:`);
        console.log(`   Action: ${record.action_type}`);
        console.log(`   Credits Used: ${record.credits_used}`);
        console.log(`   Company: ${record.company_name || 'N/A'}`);
        console.log(`   Position: ${record.position || 'N/A'}`);
        console.log(`   Date: ${date.toISOString()} (${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })})`);
        console.log('');
      });
      
      // Group by date
      console.log('\n📊 Grouped by date (last 30 days):');
      const grouped = await pool.query(
        `SELECT DATE(created_at AT TIME ZONE 'UTC') as date, COUNT(*) as count, SUM(credits_used) as total_credits
         FROM credit_usage_history 
         WHERE user_id = $1 
           AND created_at >= NOW() - INTERVAL '30 days'
         GROUP BY DATE(created_at AT TIME ZONE 'UTC') 
         ORDER BY date DESC`,
        [userId]
      );
      
      grouped.rows.forEach(row => {
        const date = new Date(row.date);
        console.log(`   ${date.toISOString().split('T')[0]}: ${row.count} generations (${row.total_credits} credits)`);
      });
    } else {
      console.log('❌ NO USAGE HISTORY FOUND!');
    }
    
    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    await pool.end();
  }
}

checkUsageHistory();
