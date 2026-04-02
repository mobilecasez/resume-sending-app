const dbConfig = require('./db-config');

async function checkActivity() {
  try {
    console.log('=== Application History (last 10) ===');
    const appHistory = await dbConfig.query(`
      SELECT id, user_id, company_name, position, sent_date, created_at
      FROM application_history 
      WHERE user_id = 1 
      ORDER BY created_at DESC 
      LIMIT 10
    `);
    console.log(JSON.stringify(appHistory, null, 2));
    
    console.log('\n=== Credit Transactions (last 10 - usage only) ===');
    const creditTrans = await dbConfig.query(`
      SELECT id, user_id, transaction_type, credits_change, description, created_at
      FROM credit_transactions 
      WHERE user_id = 1 AND transaction_type = 'usage'
      ORDER BY created_at DESC 
      LIMIT 10
    `);
    console.log(JSON.stringify(creditTrans, null, 2));
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkActivity();
