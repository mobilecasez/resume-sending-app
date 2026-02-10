require('dotenv').config();
const Imap = require('imap');

console.log('Testing IMAP connection...');
console.log('Host:', process.env.IMAP_HOST);
console.log('Port:', process.env.IMAP_PORT);
console.log('User:', process.env.IMAP_USER);
console.log('Pass length:', process.env.IMAP_PASS?.length);
console.log('Pass trimmed length:', process.env.IMAP_PASS?.trim().length);

const imap = new Imap({
    user: process.env.IMAP_USER?.trim(),
    password: process.env.IMAP_PASS?.trim(),
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT),
    tls: true,
    tlsOptions: { 
        rejectUnauthorized: false,
        servername: 'imap.zoho.com'
    },
    debug: console.log // Enable debug output
});

imap.once('ready', () => {
    console.log('\n✅ SUCCESS! IMAP connection established');
    imap.end();
    process.exit(0);
});

imap.once('error', (err) => {
    console.error('\n❌ IMAP ERROR:', err);
    process.exit(1);
});

imap.once('end', () => {
    console.log('\n📭 Connection ended');
});

console.log('\n🔌 Attempting connection...\n');
imap.connect();
