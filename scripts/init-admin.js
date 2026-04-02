const bcrypt = require('bcryptjs');
const dbConfig = require('../db-config');

/**
 * Initialize admin user if it doesn't exist
 * This runs on server startup to ensure there's always an admin account
 */
async function initializeAdminUser() {
    try {
        const adminEmail = 'samrishi24@gmail.com';
        const adminName = 'Rishi Samadhiya';
        const adminPassword = 'admin123'; // Change this to your desired password
        
        // Check if admin user already exists
        const existingUser = await dbConfig.get('SELECT id FROM users WHERE email = ?', [adminEmail]);
        
        if (existingUser) {
            console.log('✓ Admin user already exists');
            return;
        }
        
        // Create admin user
        const hashedPassword = await bcrypt.hash(adminPassword, 10);
        
        const result = await dbConfig.run(`
            INSERT INTO users (full_name, email, password, role, created_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [adminName, adminEmail, hashedPassword, 'admin']);
        
        console.log('✓ Admin user created successfully');
        console.log('  Email:', adminEmail);
        console.log('  Password:', adminPassword);
        console.log('  ⚠️  IMPORTANT: Change the password after first login!');
        
        // Initialize credits for admin
        const adminId = result.lastID;
        if (adminId) {
            await dbConfig.run(`
                INSERT INTO user_credits (user_id, credits_remaining, credits_total)
                VALUES (?, 0, 0)
            `, [adminId]);
        }
    } catch (error) {
        console.error('Error initializing admin user:', error);
        throw error;
    }
}

module.exports = { initializeAdminUser };
