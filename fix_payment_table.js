const { Pool } = require('pg');

// Use the DATABASE_URL from .env file
require('dotenv').config();
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev';

const pool = new Pool({
  connectionString: DATABASE_URL
});

async function fixPaymentTable() {
  try {
    console.log('🔧 Fixing payment_orders table for plan_id compatibility...\n');

    // Step 1: Check if table exists
    const tableExists = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'payment_orders'
      );
    `);

    if (!tableExists.rows[0].exists) {
      console.log('📋 Table does not exist, creating new payment_orders table...');
      await pool.query(`
        CREATE TABLE payment_orders (
          id SERIAL PRIMARY KEY,
          order_id VARCHAR(255) UNIQUE NOT NULL,
          user_id INTEGER,
          plan_id INTEGER,
          amount DECIMAL(10,2),
          currency VARCHAR(10) DEFAULT 'USD',
          status VARCHAR(50) DEFAULT 'created',
          razorpay_order_id VARCHAR(255),
          payment_id VARCHAR(255),
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
      console.log('✅ Table created successfully\n');
    } else {
      console.log('✅ Table exists, checking columns...\n');

      // Step 2: Check if package_id exists (old column)
      const packageIdExists = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'payment_orders' AND column_name = 'package_id';
      `);

      if (packageIdExists.rows.length > 0) {
        console.log('🔄 Found old column "package_id", making it nullable...');
        
        // Make package_id nullable if it has NOT NULL constraint
        await pool.query(`
          ALTER TABLE payment_orders ALTER COLUMN package_id DROP NOT NULL;
        `).catch(err => {
          if (!err.message.includes('does not exist')) {
            console.log('   (Already nullable or constraint does not exist)');
          }
        });
        console.log('✅ package_id is now nullable\n');
      }

      // Step 3: Ensure plan_id column exists
      console.log('🔄 Ensuring plan_id column exists...');
      await pool.query(`
        ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS plan_id INTEGER;
      `);
      console.log('✅ plan_id column ready\n');

      // Step 4: Ensure razorpay_order_id exists
      console.log('🔄 Ensuring razorpay_order_id column exists...');
      await pool.query(`
        ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS razorpay_order_id VARCHAR(255);
      `);
      console.log('✅ razorpay_order_id column ready\n');

      // Step 5: Ensure currency column exists
      console.log('🔄 Ensuring currency column exists...');
      await pool.query(`
        ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'USD';
      `);
      console.log('✅ currency column ready\n');

      // Step 6: Ensure updated_at exists
      console.log('🔄 Ensuring updated_at column exists...');
      await pool.query(`
        ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
      `);
      console.log('✅ updated_at column ready\n');
    }

    // Step 7: Show final schema
    const finalSchema = await pool.query(`
      SELECT 
        column_name, 
        data_type, 
        is_nullable,
        column_default
      FROM information_schema.columns 
      WHERE table_name = 'payment_orders' 
      ORDER BY ordinal_position;
    `);

    console.log('📋 Final payment_orders schema:');
    console.log('┌─────────────────────────┬──────────────────┬──────────┬───────────────┐');
    console.log('│ Column                  │ Type             │ Nullable │ Default       │');
    console.log('├─────────────────────────┼──────────────────┼──────────┼───────────────┤');
    finalSchema.rows.forEach(row => {
      const col = row.column_name.padEnd(23);
      const type = row.data_type.substring(0, 16).padEnd(16);
      const nullable = row.is_nullable.padEnd(8);
      const def = (row.column_default || '').substring(0, 13).padEnd(13);
      console.log(`│ ${col} │ ${type} │ ${nullable} │ ${def} │`);
    });
    console.log('└─────────────────────────┴──────────────────┴──────────┴───────────────┘\n');

    // Step 8: Test insert capability
    console.log('🧪 Testing INSERT capability with new schema...');
    const testOrderId = `test_${Date.now()}`;
    
    try {
      await pool.query(`
        INSERT INTO payment_orders 
        (order_id, user_id, plan_id, amount, currency, status, razorpay_order_id, created_at) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      `, [testOrderId, 1, 1, 4.99, 'INR', 'test', testOrderId]);
      
      console.log('✅ Test INSERT successful');
      
      // Clean up test record
      await pool.query('DELETE FROM payment_orders WHERE order_id = $1', [testOrderId]);
      console.log('✅ Test record cleaned up\n');
      
    } catch (testError) {
      console.error('❌ Test INSERT failed:', testError.message);
      console.error('   This means there is still an issue with the schema.\n');
    }

    pool.end();
    console.log('✅ Database fix complete! Restart your server now.\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
    pool.end();
    process.exit(1);
  }
}

fixPaymentTable();
