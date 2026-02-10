require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function createTable() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS email_forwards (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                from_email TEXT NOT NULL,
                subject TEXT,
                forwarded_at TIMESTAMP NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `);
        console.log('✅ Created email_forwards table successfully');
        await pool.end();
        process.exit(0);
    } catch (error) {
        console.error('❌ Error creating table:', error);
        await pool.end();
        process.exit(1);
    }
}

createTable();
