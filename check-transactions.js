require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

async function checkTransactions() {
  try {
    console.log('📊 Checking credit_transactions table...\n');
    
    // Get sample transactions
    const result = await pool.query(
      `SELECT id, user_id, transaction_type, credits_change, description, created_at 
       FROM credit_transactions 
       WHERE user_id = 1 
       ORDER BY created_at DESC 
       LIMIT 10`
    );
    
    console.log(`Found ${result.rows.length} recent transactions:\n`);
    result.rows.forEach(tx => {
      const date = new Date(tx.created_at);
      console.log(`ID ${tx.id}:`);
      console.log(`  Type: ${tx.transaction_type}`);
      console.log(`  Change: ${tx.credits_change}`);
      console.log(`  Description: ${tx.description}`);
      console.log(`  Date: ${date.toISOString()} (${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`);
      console.log('');
    });
    
    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

checkTransactions();
