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
    console.log('✅ Connected to IMAP');
    
    imap.openBox('INBOX', false, (err, box) => {
        if (err) throw err;
        
        console.log(`📥 Inbox has ${box.messages.total} messages`);
        
        // Search for ALL messages (to see what's there)
        imap.search(['ALL'], (err, results) => {
            if (err) throw err;
            
            console.log(`Found ${results.length} total messages`);
            
            // Get the last 3 messages
            const lastThree = results.slice(-3);
            console.log(`\nFetching last 3 messages: ${lastThree.join(', ')}`);
            
            const fetch = imap.fetch(lastThree, { 
                bodies: 'HEADER.FIELDS (FROM TO DELIVERED-TO X-ORIGINAL-TO SUBJECT)',
                struct: true 
            });
            
            fetch.on('message', (msg, seqno) => {
                console.log(`\n=== Message #${seqno} ===`);
                
                msg.on('body', (stream, info) => {
                    let buffer = '';
                    stream.on('data', (chunk) => {
                        buffer += chunk.toString('utf8');
                    });
                    stream.once('end', () => {
                        console.log(buffer);
                    });
                });
                
                msg.once('attributes', (attrs) => {
                    console.log('Flags:', attrs.flags);
                });
            });
            
            fetch.once('end', () => {
                console.log('\n✅ Done fetching');
                imap.end();
            });
        });
    });
});

imap.once('error', (err) => {
    console.error('❌ Error:', err);
});

imap.connect();
