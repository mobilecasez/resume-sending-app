const dbConfig = require('./db-config');
dbConfig.initializeConnection();

// Wait for connection to be ready
setTimeout(async () => {
    try {
        await cleanup();
    } catch(e) {
        console.error(e);
        process.exit(1);
    }
}, 2000);

async function cleanup() {
    const replies = await dbConfig.query(
        'SELECT arh.id, arh.application_id, arh.reply_from_email, ah.recipient_email, ah.company_name ' +
        'FROM application_reply_history arh JOIN application_history ah ON arh.application_id = ah.id WHERE ah.user_id = 1'
    );
    console.log('Total reply history entries:', replies.length);
    
    const genericProviders = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'live.com', 'icloud.com'];
    let deleted = 0;
    
    for (const r of replies) {
        const recipientDomain = r.recipient_email ? r.recipient_email.split('@')[1] : '';
        const replyFromEmail = (r.reply_from_email || '').toLowerCase();
        const recipientEmail = (r.recipient_email || '').toLowerCase();
        
        if (genericProviders.includes(recipientDomain) && replyFromEmail !== recipientEmail) {
            console.log('Deleting mismatched:', r.company_name, '- reply from:', replyFromEmail, 'but sent to:', recipientEmail);
            await dbConfig.run('DELETE FROM application_reply_history WHERE id = ?', [r.id]);
            deleted++;
        }
    }
    
    // Reset reply_received for apps that no longer have valid replies
    const appsWithReplies = await dbConfig.query('SELECT DISTINCT application_id FROM application_reply_history');
    const validIds = new Set(appsWithReplies.map(a => a.application_id));
    
    const allRepliedApps = await dbConfig.query("SELECT id FROM application_history WHERE user_id = 1 AND reply_received = true");
    let reset = 0;
    for (const app of allRepliedApps) {
        if (validIds.has(app.id) === false) {
            await dbConfig.run(
                'UPDATE application_history SET reply_received = false, reply_date = NULL, reply_subject = NULL, reply_snippet = NULL, reply_from_email = NULL WHERE id = ?',
                [app.id]
            );
            reset++;
        }
    }
    
    console.log('Deleted', deleted, 'mismatched replies, reset', reset, 'applications');
    process.exit(0);
}

cleanup().catch(e => { console.error(e); process.exit(1); });
