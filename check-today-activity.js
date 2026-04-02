const dbConfig = require('./db-config');

async function checkTodayActivity() {
  try {
    console.log('📊 ============ CHECKING TODAY\'S ACTIVITY ============\n');
    
    const userId = 1;
    const today = new Date().toISOString().split('T')[0]; // 2026-02-06
    
    // Check total_sent counter
    console.log('1️⃣ Checking user counter...');
    const user = await dbConfig.get('SELECT id, email, total_generated, total_sent FROM users WHERE id = ?', [userId]);
    console.log('   User:', user);
    console.log('   Total sent:', user?.total_sent || 0);
    console.log('');
    
    // Check all application_history records
    console.log('2️⃣ Checking application_history (all records)...');
    const allHistory = await dbConfig.all('SELECT id, user_id, company_name, position, sent_date, created_at FROM application_history WHERE user_id = ? ORDER BY created_at DESC', [userId]);
    console.log(`   Total records: ${allHistory.length}`);
    if (allHistory.length > 0) {
      console.log('   Most recent 5 records:');
      allHistory.slice(0, 5).forEach(record => {
        const sentDate = new Date(record.sent_date);
        const createdDate = new Date(record.created_at);
        console.log(`   - ID ${record.id}: sent_date=${sentDate.toISOString()} (${sentDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}), created_at=${createdDate.toISOString()}, company=${record.company_name}`);
      });
    }
    console.log('');
    
    // Check records for today
    console.log(`3️⃣ Checking records for TODAY (${today})...`);
    const todayRecords = await dbConfig.all(
      `SELECT id, user_id, company_name, position, sent_date, created_at 
       FROM application_history 
       WHERE user_id = ? AND DATE(sent_date) = ?
       ORDER BY created_at DESC`,
      [userId, today]
    );
    console.log(`   Records for ${today}: ${todayRecords.length}`);
    if (todayRecords.length > 0) {
      todayRecords.forEach(record => {
        console.log(`   - ID ${record.id}: ${record.company_name} - ${record.position}`);
        console.log(`     sent_date: ${record.sent_date}`);
        console.log(`     created_at: ${record.created_at}`);
      });
    } else {
      console.log('   ❌ NO RECORDS FOUND FOR TODAY!');
    }
    console.log('');
    
    // Check what the usage stats query returns
    console.log('4️⃣ Testing the usage stats query (30-day grouped)...');
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString();
    
    const appStats = await dbConfig.all(
      `SELECT DATE(sent_date) as date, COUNT(*) as sent 
       FROM application_history 
       WHERE user_id = ? AND sent_date >= ? 
       GROUP BY DATE(sent_date) 
       ORDER BY date DESC`,
      [userId, thirtyDaysAgoStr]
    );
    
    console.log(`   Query returned ${appStats.length} date groups:`);
    appStats.forEach(stat => {
      const date = new Date(stat.date);
      console.log(`   - ${date.toISOString().split('T')[0]}: ${stat.sent} sent`);
    });
    console.log('');
    
    console.log('📊 ============ DIAGNOSIS ============');
    if (todayRecords.length === 0) {
      console.log('❌ PROBLEM: No records were saved for today!');
      console.log('   This means the database insert is NOT working.');
      console.log('   Need to check the /api/send-applications endpoint logs.');
    } else {
      console.log('✅ Records exist for today:', todayRecords.length);
      if (appStats.length === 0 || !appStats.some(s => s.date.includes(today))) {
        console.log('❌ PROBLEM: Records exist but query doesn\'t return them!');
        console.log('   This means there\'s a query/date formatting issue.');
      } else {
        console.log('✅ Query correctly returns today\'s data!');
        console.log('   The mobile app should be showing this data.');
        console.log('   Try refreshing the Usage screen in the app.');
      }
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

checkTodayActivity();
