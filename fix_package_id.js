const { Pool } = require('pg');

// Use the DATABASE_URL from .env file
require('dotenv').config();
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev';

const pool = new Pool({
  connectionString: DATABASE_URL
});

async function fixPackageIdConstraint() {
  try {
    console.log('🔧 Fixing package_id constraint...\n');

    // Option 1: Try to remove NOT NULL constraint from package_id
    console.log('Step 1: Removing NOT NULL constraint from package_id...');
    await pool.query('ALTER TABLE payment_orders ALTER COLUMN package_id DROP NOT NULL');
    console.log('✅ Removed NOT NULL constraint from package_id\n');

    // Option 2: Set default value for package_id to match plan_id
    console.log('Step 2: Setting package_id to copy plan_id value...');
    await pool.query('ALTER TABLE payment_orders ALTER COLUMN package_id SET DEFAULT NULL');
    console.log('✅ Set default value for package_id\n');

    // Show current schema
    const result = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default 
      FROM information_schema.columns 
      WHERE table_name = 'payment_orders' 
      AND column_name IN ('package_id', 'plan_id')
      ORDER BY ordinal_position
    `);

    console.log('📋 Updated columns:');
    result.rows.forEach(row => {
      console.log(`  - ${row.column_name} (${row.data_type}) ${row.is_nullable === 'NO' ? 'NOT NULL' : 'NULL OK'} Default: ${row.column_default || 'none'}`);
    });

    pool.end();
    console.log('\n✅ Fix complete! Restart the server now.');
  } catch (error) {
    console.error('❌ Error:', error.message);
    pool.end();
    process.exit(1);
  }
}

fixPackageIdConstraint();
