#!/usr/bin/env node
require('dotenv').config();
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const token = jwt.sign({ id: 1, email: 'samrishi24@gmail.com' }, JWT_SECRET);

(async () => {
    try {
        const res = await fetch('http://localhost:3000/api/user/usage-stats', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        
        console.log('✅ Usage Stats Response:\n');
        console.log('Credit History:');
        if (data.creditHistory && data.creditHistory.length > 0) {
            data.creditHistory.forEach(item => {
                console.log(`\n  Transaction Type: ${item.transactionType}`);
                console.log(`  Credits Change: ${item.creditsChange}`);
                console.log(`  Description: ${item.description}`);
                console.log(`  Date: ${item.transactionDate}`);
                console.log(`  Balance After: ${item.balanceAfter}`);
            });
        } else {
            console.log('  No credit history');
        }
        
        console.log('\n\nFull Response:');
        console.log(JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Error:', err.message);
    }
})();
