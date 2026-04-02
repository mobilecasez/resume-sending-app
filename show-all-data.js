require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

async function showAllData() {
  try {
    console.log('📊 ============ COMPLETE DATABASE OVERVIEW ============\n');
    
    const userId = 1;
    
    // 1. User info
    console.log('1️⃣ USER INFO');
    const user = await pool.query('SELECT id, email, total_generated, total_sent, created_at FROM users WHERE id = $1', [userId]);
    console.log('   Email:', user.rows[0].email);
    console.log('   Total Generated:', user.rows[0].total_generated);
    console.log('   Total Sent:', user.rows[0].total_sent);
    console.log('   Account Created:', user.rows[0].created_at);
    console.log('');
    
    // 2. Application History (ALL records)
    console.log('2️⃣ APPLICATION_HISTORY TABLE (All records for user)');
    const history = await pool.query(
      'SELECT id, company_name, position, recipient_email, sent_date, created_at FROM application_history WHERE user_id = $1 ORDER BY sent_date DESC',
      [userId]
    );
    console.log(`   Total records: ${history.rows.length}`);
    console.log('');
    
    if (history.rows.length > 0) {
      console.log('   📋 ALL RECORDS:');
      history.rows.forEach((record, index) => {
        const sentDate = new Date(record.sent_date);
        const createdDate = new Date(record.created_at);
        console.log(`   ${index + 1}. ID ${record.id}:`);
        console.log(`      Company: ${record.company_name}`);
        console.log(`      Position: ${record.position}`);
        console.log(`      Email: ${record.recipient_email}`);
        console.log(`      Sent Date: ${sentDate.toISOString()} (${sentDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})`);
        console.log(`      Created At: ${createdDate.toISOString()} (${createdDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})`);
        console.log('');
      });
    } else {
      console.log('   ❌ NO RECORDS FOUND!');
    }
    
    // 3. Credit Transactions (ALL records)
    console.log('3️⃣ CREDIT_TRANSACTIONS TABLE (Last 30 days)');
    const transactions = await pool.query(
      `SELECT id, user_id, transaction_type, credits_change, description, created_at 
       FROM credit_transactions 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 50`,
      [userId]
    );
    console.log(`   Total recent transactions: ${transactions.rows.length}`);
    console.log('');
    
    if (transactions.rows.length > 0) {
      console.log('   📋 RECENT TRANSACTIONS (Last 50):');
      transactions.rows.forEach((tx, index) => {
        const date = new Date(tx.created_at);
        console.log(`   ${index + 1}. ID ${tx.id}:`);
        console.log(`      Type: ${tx.transaction_type}`);
        console.log(`      Credits Change: ${tx.credits_change}`);
        console.log(`      Description: ${tx.description}`);
        console.log(`      Date: ${date.toISOString()} (${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })})`);
        console.log('');
      });
    }
    
    // 4. Grouped by date
    console.log('4️⃣ ACTIVITY GROUPED BY DATE');
    console.log('');
    console.log('   📊 GENERATIONS (from credit_transactions):');
    const gensByDate = await pool.query(
      `SELECT DATE(created_at AT TIME ZONE 'UTC') as date, COUNT(*) as count
       FROM credit_transactions 
       WHERE user_id = $1 
         AND transaction_type = 'debit' 
         AND description LIKE '%Cover letter generation%'
         AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at AT TIME ZONE 'UTC') 
       ORDER BY date DESC`,
      [userId]
    );
    
    if (gensByDate.rows.length > 0) {
      gensByDate.rows.forEach(row => {
        const date = new Date(row.date);
        console.log(`      ${date.toISOString().split('T')[0]}: ${row.count} generations`);
      });
    } else {
      console.log('      No generations in last 30 days');
    }
    console.log('');
    
    console.log('   📧 SENDS (from application_history):');
    const sendsByDate = await pool.query(
      `SELECT DATE(sent_date AT TIME ZONE 'UTC') as date, COUNT(*) as count
       FROM application_history 
       WHERE user_id = $1 
         AND sent_date >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(sent_date AT TIME ZONE 'UTC') 
       ORDER BY date DESC`,
      [userId]
    );
    
    if (sendsByDate.rows.length > 0) {
      sendsByDate.rows.forEach(row => {
        const date = new Date(row.date);
        console.log(`      ${date.toISOString().split('T')[0]}: ${row.count} sent`);
      });
    } else {
      console.log('      No sends in last 30 days');
    }
    console.log('');
    
    // 5. User Credits
    console.log('5️⃣ CURRENT CREDITS');
    const credits = await pool.query('SELECT credits FROM user_credits WHERE user_id = $1', [userId]);
    if (credits.rows[0]) {
      console.log(`   Balance: ${credits.rows[0].credits} credits`);
    }
    console.log('');
    
    console.log('📊 ============ END OF REPORT ============');
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    await pool.end();
    process.exit(1);
  }
}

showAllData();
