require('dotenv').config();
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const token = jwt.sign({ id: 1, email: 'samrishi24@gmail.com' }, JWT_SECRET);

fetch('http://localhost:3000/api/user/usage-stats', {
    headers: { 'Authorization': `Bearer ${token}` }
})
.then(res => res.json())
.then(data => {
    console.log('Usage Stats Response:');
    console.log(JSON.stringify(data, null, 2));
    if (data.success) {
        console.log('\n✅ SUCCESS!');
        console.log(`   Credits: ${data.credits?.remaining || 0}`);
        console.log(`   Generated: ${data.currentMonth?.lettersGenerated || 0}`);
        console.log(`   Sent: ${data.currentMonth?.lettersSent || 0}`);
        console.log(`   Activity entries: ${data.dateWiseActivity?.length || 0}`);
        console.log(`   Credit history: ${data.creditHistory?.length || 0}`);
    } else {
        console.log('\n❌ FAILED:', data.error);
    }
})
.catch(err => console.error('Error:', err.message));
