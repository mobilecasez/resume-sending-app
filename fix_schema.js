const { Pool } = require('pg');

// Use the DATABASE_URL from .env file
require('dotenv').config();
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev';

const pool = new Pool({
  connectionString: DATABASE_URL
});

async function fixSchema() {
  try {
    console.log('🔧 Fixing payment_orders table schema...\n');

    // Create table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_orders (
        id SERIAL PRIMARY KEY,
        order_id VARCHAR(255) UNIQUE NOT NULL,
        user_id INTEGER REFERENCES users(id),
        plan_id INTEGER REFERENCES plans(id),
        amount DECIMAL(10,2),
        currency VARCHAR(10) DEFAULT 'USD',
        status VARCHAR(50) DEFAULT 'created',
        payment_id VARCHAR(255),
        razorpay_order_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Table created/verified');

    // Add missing columns
    await pool.query('ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS plan_id INTEGER');
    await pool.query('ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS razorpay_order_id VARCHAR(255)');
    await pool.query('ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()');
    console.log('✅ Missing columns added\n');

    // Show current schema
    const result = await pool.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'payment_orders' 
      ORDER BY ordinal_position
    `);

    console.log('📋 Current payment_orders schema:');
    result.rows.forEach(row => {
      console.log(`  - ${row.column_name} (${row.data_type}) ${row.is_nullable === 'NO' ? 'NOT NULL' : ''}`);
    });

    pool.end();
    console.log('\n✅ Schema fix complete!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    pool.end();
    process.exit(1);
  }
}

fixSchema();
