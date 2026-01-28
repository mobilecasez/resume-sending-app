require('dotenv').config();
const { Pool } = require('pg');

// Use Railway DATABASE_URL if available, otherwise local
const connectionString = process.env.DATABASE_URL || 'postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev';

const pool = new Pool({
    connectionString: connectionString,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function createTestPaymentUser() {
    const client = await pool.connect();
    
    try {
        console.log('🔧 Creating test payment user...');
        
        // Password hash for: TestPayment@123
        const passwordHash = '$2b$10$nrDXIYfa2OK7OeVqivMTRuBaXPqfNMTDxGcxgRGgoRiqgMt5r0HXa';
        
        // Insert user
        const userResult = await client.query(`
            INSERT INTO users (full_name, email, password, role, created_at)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            ON CONFLICT (email) DO UPDATE 
            SET password = EXCLUDED.password
            RETURNING id, email, full_name
        `, ['Test Payment User', 'payment.test@cvapplyr.com', passwordHash, 'user']);
        
        const userId = userResult.rows[0].id;
        console.log('✅ User created/updated:', userResult.rows[0]);
        
        // Initialize credits
        await client.query(`
            INSERT INTO user_credits (user_id, credits_remaining, credits_total)
            VALUES ($1, 0, 0)
            ON CONFLICT (user_id) DO NOTHING
        `, [userId]);
        
        console.log('✅ Credits initialized');
        console.log('\n📧 Test Account Credentials:');
        console.log('   Email: payment.test@cvapplyr.com');
        console.log('   Password: TestPayment@123');
        console.log('\n✅ Test payment user ready for Razorpay integration testing!');
        
    } catch (error) {
        console.error('❌ Error creating test user:', error);
    } finally {
        client.release();
        await pool.end();
    }
}

createTestPaymentUser();
