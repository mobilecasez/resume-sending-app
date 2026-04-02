const dbConfig = require('../../db-config');

async function up() {
    try {
        console.log('Creating notifications table...');
        
        await dbConfig.run(`
            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                type VARCHAR(50) NOT NULL,
                title VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                details TEXT,
                metadata TEXT,
                is_read INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        await dbConfig.run(`
            CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id)
        `);
        
        await dbConfig.run(`
            CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC)
        `);
        
        console.log('✅ Notifications table created successfully');
    } catch (error) {
        console.error('❌ Error creating notifications table:', error);
        throw error;
    }
}

async function down() {
    try {
        console.log('Dropping notifications table...');
        await dbConfig.run('DROP TABLE IF EXISTS notifications');
        console.log('✅ Notifications table dropped successfully');
    } catch (error) {
        console.error('❌ Error dropping notifications table:', error);
        throw error;
    }
}

module.exports = { up, down };
