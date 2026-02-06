// Quick test to send a test application and verify database recording
const dbConfig = require('./db-config');

async function testApplicationSend() {
    try {
        const userId = 1; // Your user ID
        const companyName = "Test Company";
        const position = "Test Position";
        const recipientEmail = "test@example.com";
        const sentDate = new Date().toISOString();
        
        console.log('\n🧪 ============ TEST APPLICATION SEND ============');
        console.log('📝 Inserting test record...');
        console.log('   User ID:', userId);
        console.log('   Company:', companyName);
        console.log('   Position:', position);
        console.log('   Email:', recipientEmail);
        console.log('   Sent Date:', sentDate);
        console.log('   Sent Date (readable):', new Date(sentDate).toLocaleString());
        
        // Initialize DB
        dbConfig.initializeConnection();
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for connection
        
        // Insert test record
        const result = await dbConfig.run(
            'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date) VALUES (?, ?, ?, ?, ?)',
            [userId, companyName, position, recipientEmail, sentDate]
        );
        
        console.log('✅ Test record inserted!');
        console.log('   Result:', result);
        
        // Verify the insert
        const verify = await dbConfig.get(
            'SELECT id, user_id, company_name, sent_date FROM application_history WHERE user_id = ? ORDER BY sent_date DESC LIMIT 1',
            [userId]
        );
        
        console.log('\n✅ Verification - Latest record:');
        console.log('   ID:', verify.id);
        console.log('   Company:', verify.company_name);
        console.log('   Sent Date:', verify.sent_date);
        console.log('   Sent Date (readable):', new Date(verify.sent_date).toLocaleString());
        
        // Check how many records for today
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayRecords = await dbConfig.query(
            'SELECT COUNT(*) as count FROM application_history WHERE user_id = ? AND sent_date >= ?',
            [userId, today.toISOString()]
        );
        
        console.log('\n📊 Records for today:', todayRecords[0].count);
        
        // Also update the counter
        await dbConfig.run(
            'UPDATE users SET total_sent = total_sent + 1 WHERE id = ?',
            [userId]
        );
        console.log('📊 Updated total_sent counter');
        
        console.log('\n✅ Test completed successfully!');
        console.log('👉 Now refresh the Usage screen in your app to see the new data');
        
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Test failed:', error);
        console.error(error.stack);
        process.exit(1);
    }
}

testApplicationSend();
