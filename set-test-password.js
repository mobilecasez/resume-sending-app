require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev';

const pool = new Pool({
    connectionString: connectionString,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function setTestPassword() {
    const client = await pool.connect();
    
    try {
        const email = 'cvapplyrtest@gmail.com';
        const password = 'test!123';
        
        // Check if user exists
        const userResult = await client.query('SELECT id, email, full_name FROM users WHERE email = $1', [email]);
        
        if (userResult.rows.length === 0) {
            console.log('User not found, creating test account...');
            const hashedPassword = await bcrypt.hash(password, 10);
            const insertResult = await client.query(
                `INSERT INTO users (full_name, email, password, role, created_at)
                 VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                 RETURNING id, email, full_name`,
                ['CVApplyr Test', email, hashedPassword, 'user']
            );
            const userId = insertResult.rows[0].id;
            await client.query(
                `INSERT INTO user_credits (user_id, credits_remaining, credits_total)
                 VALUES ($1, 5, 5) ON CONFLICT (user_id) DO NOTHING`,
                [userId]
            );
            console.log('✅ Test user created:', insertResult.rows[0]);
        } else {
            console.log('User found:', userResult.rows[0]);
            const hashedPassword = await bcrypt.hash(password, 10);
            await client.query('UPDATE users SET password = $1 WHERE email = $2', [hashedPassword, email]);
            console.log('✅ Password updated for:', email);
        }
        
        // Verify login works
        const verifyResult = await client.query('SELECT password FROM users WHERE email = $1', [email]);
        const isValid = await bcrypt.compare(password, verifyResult.rows[0].password);
        console.log('✅ Password verification:', isValid ? 'SUCCESS' : 'FAILED');
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        client.release();
        await pool.end();
    }
}

setTestPassword();
