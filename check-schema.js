require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

async function checkSchema() {
  try {
    console.log('📊 Checking recipients table structure...\n');
    
    const recipients = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'recipients'
      ORDER BY ordinal_position
    `);
    
    console.log('Columns in recipients:');
    recipients.rows.forEach(row => {
      console.log(`  - ${row.column_name} (${row.data_type})`);
    });
    
    console.log('\n📊 Checking application_history table structure...\n');
    
    const apps = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'application_history'
      ORDER BY ordinal_position
    `);
    
    console.log('Columns in application_history:');
    apps.rows.forEach(row => {
      console.log(`  - ${row.column_name} (${row.data_type})`);
    });
    
    console.log('\n📧 Actual recipients data:');
    const recipientsData = await pool.query('SELECT id, user_id, email, position FROM recipients WHERE user_id = 1');
    console.log(`Found ${recipientsData.rows.length} recipients`);
    recipientsData.rows.forEach(r => {
      console.log(`  • ID: ${r.id} | ${r.email} | ${r.position || 'N/A'}`);
    });
    
    console.log('\n📋 Actual applications data:');
    const appsData = await pool.query('SELECT id, user_id, company_name, position FROM application_history WHERE user_id = 1 LIMIT 5');
    console.log(`Found ${appsData.rows.length} applications`);
    appsData.rows.forEach(a => {
      console.log(`  • ID: ${a.id} | ${a.company_name} | ${a.position}`);
    });
    
    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    await pool.end();
  }
}

checkSchema();
