require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

async function checkColumns() {
  try {
    console.log('Checking credit_transactions columns...\n');
    
    const txResult = await pool.query(
      `SELECT column_name, data_type 
       FROM information_schema.columns 
       WHERE table_name = 'credit_transactions'
       ORDER BY ordinal_position`
    );
    
    console.log('credit_transactions columns:');
    txResult.rows.forEach(col => {
      console.log(`  - ${col.column_name}: ${col.data_type}`);
    });
    
    console.log('\n\nChecking credit_usage_history columns...\n');
    
    const usageResult = await pool.query(
      `SELECT column_name, data_type 
       FROM information_schema.columns 
       WHERE table_name = 'credit_usage_history'
       ORDER BY ordinal_position`
    );
    
    console.log('credit_usage_history columns:');
    usageResult.rows.forEach(col => {
      console.log(`  - ${col.column_name}: ${col.data_type}`);
    });
    
    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

checkColumns();
