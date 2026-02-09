// Migration: Create email_forwards table for tracking forwarded replies

const dbConfig = require('../../db-config');

async function up() {
    await dbConfig.run(`
        CREATE TABLE IF NOT EXISTS email_forwards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            from_email TEXT NOT NULL,
            subject TEXT,
            forwarded_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);
    
    console.log('✅ Created email_forwards table');
}

async function down() {
    await dbConfig.run('DROP TABLE IF EXISTS email_forwards');
    console.log('✅ Dropped email_forwards table');
}

module.exports = { up, down };
