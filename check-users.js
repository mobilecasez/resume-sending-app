require('dotenv').config();
const dbConfig = require('./db-config');

dbConfig.initializeConnection();

async function checkUsers() {
    try {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('\n👤 All users in database:\n');
        
        const users = await dbConfig.query(
            `SELECT id, full_name, email, created_at FROM users ORDER BY id`
        );
        
        users.forEach(user => {
            console.log(`User ID ${user.id}: ${user.full_name} <${user.email}> (created: ${user.created_at})`);
        });
        
        console.log('\n📧 Checking which user has email "rishisamadhiya2000@gmail.com":\n');
        
        const rishi = await dbConfig.query(
            `SELECT id, full_name, email FROM users WHERE email LIKE '%rishi%'`
        );
        
        if (rishi.length > 0) {
            rishi.forEach(user => {
                console.log(`  Found: User ID ${user.id} - ${user.full_name} <${user.email}>`);
            });
        } else {
            console.log('  No user found with "rishi" in email');
        }
        
        console.log('\n📝 Cover letters by user:\n');
        
        const letterCounts = await dbConfig.query(
            `SELECT user_id, COUNT(*) as count FROM review_cover_letters GROUP BY user_id ORDER BY user_id`
        );
        
        letterCounts.forEach(row => {
            console.log(`  User ID ${row.user_id}: ${row.count} cover letter(s)`);
        });
        
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkUsers();
