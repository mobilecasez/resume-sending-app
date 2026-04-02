require('dotenv').config();
const dbConfig = require('./db-config');

dbConfig.initializeConnection();

async function checkData() {
    try {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('\n📊 Checking review_cover_letters table:\n');
        
        // Get all records
        const records = await dbConfig.query(
            `SELECT 
                id, user_id, letter_key, company_name, recipient_email, 
                CASE 
                    WHEN cover_letter_html IS NULL THEN 'NULL'
                    WHEN cover_letter_html = '' THEN 'EMPTY STRING'
                    ELSE 'HAS CONTENT (' || LENGTH(cover_letter_html) || ' chars)'
                END as html_status,
                subject, address, date, position, generated, sent
             FROM review_cover_letters 
             ORDER BY id DESC 
             LIMIT 10`
        );
        
        if (records.length === 0) {
            console.log('❌ No records found in review_cover_letters table');
        } else {
            console.log(`✅ Found ${records.length} record(s):\n`);
            records.forEach((record, idx) => {
                console.log(`Record ${idx + 1}:`);
                console.log(`  ID: ${record.id}`);
                console.log(`  User ID: ${record.user_id}`);
                console.log(`  Letter Key: ${record.letter_key}`);
                console.log(`  Company: ${record.company_name}`);
                console.log(`  Email: ${record.recipient_email}`);
                console.log(`  HTML Status: ${record.html_status}`);
                console.log(`  Subject: ${record.subject}`);
                console.log(`  Position: ${record.position}`);
                console.log(`  Generated: ${record.generated}`);
                console.log(`  Sent: ${record.sent}`);
                console.log('');
            });
        }
        
        // Also check what user_id we should be looking for
        console.log('\n👤 Checking users table:\n');
        const users = await dbConfig.query(
            `SELECT id, full_name, email FROM users ORDER BY id DESC LIMIT 5`
        );
        
        users.forEach(user => {
            console.log(`  User ID ${user.id}: ${user.full_name} (${user.email})`);
        });
        
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkData();
