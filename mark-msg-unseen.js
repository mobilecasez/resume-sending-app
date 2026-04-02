require('dotenv').config();
const Imap = require('imap');

const imap = new Imap({
    user: process.env.IMAP_USER?.trim(),
    password: process.env.IMAP_PASS?.trim(),
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT),
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
});

imap.once('ready', () => {
    console.log('✅ Connected');
    
    imap.openBox('INBOX', false, (err, box) => {
        if (err) throw err;
        
        // Mark message 6 as unseen
        imap.delFlags(6, ['\\Seen'], (err) => {
            if (err) {
                console.error('Error:', err);
            } else {
                console.log('✅ Marked message #6 as UNSEEN');
            }
            imap.end();
        });
    });
});

imap.once('error', (err) => {
    console.error('❌ Error:', err);
});

imap.connect();
