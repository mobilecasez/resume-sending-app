require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

async function checkDatabase() {
  try {
    console.log('📊 ============ CHECKING TODAY\'S ACTIVITY ============\n');
    
    const userId = 1;
    const today = new Date().toISOString().split('T')[0]; // 2026-02-06
    
    // Check total_sent counter
    console.log('1️⃣ Checking user counter...');
    const userResult = await pool.query('SELECT id, email, total_generated, total_sent FROM users WHERE id = $1', [userId]);
    if (userResult.rows[0]) {
      console.log('   User:', userResult.rows[0].email);
      console.log('   Total sent:', userResult.rows[0].total_sent || 0);
    }
    console.log('');
    
    // Check all application_history records
    console.log('2️⃣ Checking application_history (all records)...');
    const allHistory = await pool.query(
      'SELECT id, user_id, company_name, position, sent_date, created_at FROM application_history WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    console.log(`   Total records: ${allHistory.rows.length}`);
    if (allHistory.rows.length > 0) {
      console.log('   Most recent 5 records:');
      allHistory.rows.slice(0, 5).forEach(record => {
        const sentDate = new Date(record.sent_date);
        const createdDate = new Date(record.created_at);
        console.log(`   - ID ${record.id}: sent_date=${sentDate.toISOString()} (${sentDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}), created_at=${createdDate.toISOString()}, company=${record.company_name}`);
      });
    }
    console.log('');
    
    // Check records for today (with timezone handling)
    console.log(`3️⃣ Checking records for TODAY (${today}) with timezone fix...`);
    const todayRecords = await pool.query(
      `SELECT id, user_id, company_name, position, sent_date, created_at 
       FROM application_history 
       WHERE user_id = $1 AND DATE(sent_date AT TIME ZONE 'UTC') = $2
       ORDER BY created_at DESC`,
      [userId, today]
    );
    console.log(`   Records for ${today}: ${todayRecords.rows.length}`);
    if (todayRecords.rows.length > 0) {
      todayRecords.rows.forEach(record => {
        console.log(`   - ID ${record.id}: ${record.company_name} - ${record.position}`);
        console.log(`     sent_date: ${record.sent_date}`);
        console.log(`     created_at: ${record.created_at}`);
      });
    } else {
      console.log('   ❌ NO RECORDS FOUND FOR TODAY!');
    }
    console.log('');
    
    // Check what the usage stats query returns
    console.log('4️⃣ Testing the usage stats query (30-day grouped with timezone fix)...');
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString();
    
    const appStats = await pool.query(
      `SELECT DATE(sent_date AT TIME ZONE 'UTC') as date, COUNT(*) as sent 
       FROM application_history 
       WHERE user_id = $1 AND sent_date >= $2
       GROUP BY DATE(sent_date AT TIME ZONE 'UTC') 
       ORDER BY date DESC`,
      [userId, thirtyDaysAgoStr]
    );
    
    console.log(`   Query returned ${appStats.rows.length} date groups:`);
    appStats.rows.forEach(stat => {
      const date = new Date(stat.date);
      console.log(`   - ${date.toISOString().split('T')[0]}: ${stat.sent} sent`);
    });
    console.log('');
    
    console.log('📊 ============ DIAGNOSIS ============');
    if (todayRecords.rows.length === 0) {
      console.log('❌ PROBLEM: No records were saved for today!');
      console.log('   This means the database insert is NOT working.');
      console.log('   Need to check if the send operation actually triggered the insert.');
      console.log('');
      console.log('💡 NEXT STEPS:');
      console.log('   1. Check if the backend server is running');
      console.log('   2. Look for logs with 📧 [SEND] or 💾 [DB INSERT]');
      console.log('   3. Try sending again and watch the terminal');
    } else {
      console.log('✅ Records exist for today:', todayRecords.rows.length);
      if (appStats.rows.length === 0 || !appStats.rows.some(s => {
        const statDate = new Date(s.date).toISOString().split('T')[0];
        return statDate === today;
      })) {
        console.log('❌ PROBLEM: Records exist but query doesn\'t return them!');
        console.log('   This means there\'s a query/date formatting issue.');
      } else {
        console.log('✅ Query correctly returns today\'s data!');
        console.log('   The mobile app should be showing this data.');
        console.log('   Try pulling down to refresh the Usage screen in the app.');
      }
    }
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    await pool.end();
    process.exit(1);
  }
}

checkDatabase();
