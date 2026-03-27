// Test API endpoints with a valid token
require('dotenv').config();
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

// Create a test token for user 1
const token = jwt.sign({ id: 1, email: 'samrishi24@gmail.com' }, JWT_SECRET);

console.log('Generated test token for user 1\n');

async function testEndpoints() {
    // Test recipients
    console.log('🔍 Testing /api/users/recipients...');
    const recipientsRes = await fetch('http://localhost:3000/api/users/recipients', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const recipientsData = await recipientsRes.json();
    console.log('Recipients:', recipientsData);
    console.log(`✅ Found ${recipientsData.recipients?.length || 0} recipients\n`);
    
    // Test counters
    console.log('🔍 Testing /api/users/counters...');
    const countersRes = await fetch('http://localhost:3000/api/users/counters', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const countersData = await countersRes.json();
    console.log('Counters:', countersData);
    console.log(`✅ Generated: ${countersData.totalGenerated}, Sent: ${countersData.totalSent}\n`);
    
    // Test application history
    console.log('🔍 Testing /api/users/application-history...');
    const appsRes = await fetch('http://localhost:3000/api/users/application-history', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const appsData = await appsRes.json();
    console.log('Applications:', appsData);
    console.log(`✅ Found ${appsData.applicationHistory?.length || 0} applications\n`);
    
    // Test usage stats  
    console.log('🔍 Testing /api/user/usage-stats...');
    const usageRes = await fetch('http://localhost:3000/api/user/usage-stats', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const usageData = await usageRes.json();
    console.log('Usage Stats:', JSON.stringify(usageData, null, 2));
    console.log(`✅ Credits: ${usageData.credits?.remaining || 0}\n`);
}

testEndpoints().catch(console.error);
