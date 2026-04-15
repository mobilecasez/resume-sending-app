const dbConfig = require('../../db-config');
const auditUtils = require('../utils/auditUtils');

// Save recipients for a user
const saveRecipients = async (req, res) => {
    try {
        const userId = req.user.id;
        const { recipients } = req.body;

        if (!recipients || !Array.isArray(recipients)) {
            return res.status(400).json({ error: 'Recipients must be an array' });
        }

        // Filter valid recipients first
        const validRecipients = recipients.filter(r => r.email && r.website);
        
        // Don't delete existing data if no valid recipients to replace with
        if (validRecipients.length === 0) {
            // Return current recipients count instead of deleting
            const existing = await dbConfig.query(
                'SELECT COUNT(*) as count FROM recipients WHERE user_id = ?',
                [userId]
            );
            return res.json({
                success: true,
                message: 'No valid recipients to save, existing data preserved',
                recipientsCount: existing[0]?.count || 0
            });
        }

        // DELETE existing recipients only if we have valid replacements
        await dbConfig.run('DELETE FROM recipients WHERE user_id = ?', [userId]);

        let insertedCount = 0;

        for (const recipient of validRecipients) {
            try {
                await dbConfig.run(
                    'INSERT INTO recipients (user_id, email, website, position) VALUES (?, ?, ?, ?)',
                    [userId, recipient.email, recipient.website, recipient.position || '']
                );
                insertedCount++;
            } catch (err) {
                console.error('Error inserting recipient:', err);
            }
        }

        if (insertedCount === 0) {
            return res.status(500).json({ error: 'Failed to save recipients' });
        }
        
        res.json({
            success: true,
            message: `Successfully saved ${insertedCount} recipients`,
            recipientsCount: insertedCount
        });
    } catch (error) {
        console.error('Save recipients error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get recipients for a user
const getRecipients = async (req, res) => {
    try {
        const userId = req.user.id;

        // Get all recipients for the user
        const recipients = await dbConfig.query(
            'SELECT id, email, website, position FROM recipients WHERE user_id = ? ORDER BY created_at ASC',
            [userId]
        );

        res.json({
            success: true,
            recipients: recipients || [],
            count: (recipients || []).length
        });
    } catch (error) {
        console.error('Get recipients error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Save application history for a user
const saveApplicationHistory = async (req, res) => {
    try {
        const userId = req.user.id;
        const { applicationHistory } = req.body;

        if (!Array.isArray(applicationHistory)) {
            return res.status(400).json({ error: 'Application history must be an array' });
        }

        // DON'T soft delete existing records - merge instead
        // This allows both mobile sync and backend INSERTs to coexist
        
        // Get existing records to avoid duplicates
        const existing = await dbConfig.query(
            'SELECT id, recipient_email, sent_date FROM application_history WHERE user_id = ? AND deleted_at IS NULL',
            [userId]
        );
        
        const existingSet = new Set();
        if (existing) {
            existing.forEach(record => {
                // Create unique key: email + date (without time)
                const dateOnly = record.sent_date ? new Date(record.sent_date).toISOString().split('T')[0] : '';
                const key = `${record.recipient_email}|${dateOnly}`;
                existingSet.add(key);
            });
        }

        // Insert new history (skip duplicates)
        let inserted = 0;
        let skipped = 0;
        for (const app of applicationHistory) {
            try {
                const sentDate = app.sentDate || new Date().toISOString();
                const dateOnly = new Date(sentDate).toISOString().split('T')[0];
                const key = `${app.recipientEmail || ''}|${dateOnly}`;
                
                // Skip if already exists (same email + same date)
                if (existingSet.has(key)) {
                    skipped++;
                    continue;
                }
                
                await dbConfig.run(
                    'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date, reply_received, reply_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [userId, app.companyName || '', app.position || '', app.recipientEmail || '', sentDate, app.replyReceived ? 1 : 0, app.replyDate || null]
                );
                inserted++;
                existingSet.add(key); // Add to set to avoid duplicates within same sync
            } catch (err) {
                console.error('Error inserting application history:', err);
            }
        }

        console.log(`📊 Application history sync: ${inserted} inserted, ${skipped} skipped (duplicates)`);

        res.json({
            success: true,
            message: 'Application history saved',
            inserted: inserted,
            skipped: skipped
        });
    } catch (error) {
        console.error('Save application history error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get application history for a user
const getApplicationHistory = async (req, res) => {
    try {
        const userId = req.user.id;

        // Get last 10 application history entries for the user (for display purposes)
        // Include reply count and LATEST reply date from reply_history table
        const history = await dbConfig.query(
            `SELECT 
                ah.id, 
                ah.company_name as "companyName", 
                ah.position, 
                ah.recipient_email as "recipientEmail", 
                ah.sent_date as "sentDate", 
                ah.reply_received as "replyReceived", 
                (SELECT MAX(reply_date) FROM application_reply_history WHERE application_id = ah.id) as "replyDate",
                ah.reply_date as "manualReplyDate",
                ah.reply_subject as "replySubject", 
                ah.reply_snippet as "replySnippet", 
                ah.reply_from_email as "replyFromEmail",
                (SELECT COUNT(*) FROM application_reply_history WHERE application_id = ah.id) as "replyCount"
            FROM application_history ah 
            WHERE ah.user_id = ? 
            ORDER BY ah.sent_date DESC 
            LIMIT 10`,
            [userId]
        );

        // Convert reply_received from 0/1 to boolean
        const formattedHistory = (history || []).map(app => ({
            ...app,
            replyReceived: app.replyReceived === 1,
            replyDate: app.replyDate || app.manualReplyDate || null,
            replyCount: parseInt(app.replyCount) || 0
        }));

        res.json({
            success: true,
            applicationHistory: formattedHistory,
            count: formattedHistory.length
        });
    } catch (error) {
        console.error('Get application history error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Save review cover letters for a user
const saveReviewCoverLetters = async (req, res) => {
    try {
        const userId = req.user.id;
        const { reviewCoverLetters } = req.body;

        if (!reviewCoverLetters || typeof reviewCoverLetters !== 'object') {
            return res.status(400).json({ error: 'Review cover letters must be an object' });
        }

        // UPSERT each letter individually — never delete-all to avoid data loss on partial saves
        let inserted = 0;
        const entries = Object.entries(reviewCoverLetters);
        
        for (const [key, letter] of entries) {
            try {
                await dbConfig.run(
                    `INSERT INTO review_cover_letters
                        (user_id, letter_key, company_name, recipient_email, cover_letter_html, subject, address, date, position, locations, generated, sent, sent_date, stored_recipient_email, stored_recipient_website, deleted_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                     ON CONFLICT (user_id, letter_key) DO UPDATE SET
                        company_name = EXCLUDED.company_name,
                        recipient_email = EXCLUDED.recipient_email,
                        cover_letter_html = EXCLUDED.cover_letter_html,
                        subject = EXCLUDED.subject,
                        address = EXCLUDED.address,
                        date = EXCLUDED.date,
                        position = EXCLUDED.position,
                        locations = EXCLUDED.locations,
                        generated = EXCLUDED.generated,
                        sent = EXCLUDED.sent,
                        sent_date = EXCLUDED.sent_date,
                        stored_recipient_email = EXCLUDED.stored_recipient_email,
                        stored_recipient_website = EXCLUDED.stored_recipient_website,
                        deleted_at = NULL,
                        updated_at = CURRENT_TIMESTAMP`,
                    [
                        userId,
                        key,
                        letter.companyName || '',
                        letter.recipientEmail || '',
                        letter.coverLetterHtml || '',
                        letter.subject || '',
                        letter.address || '',
                        letter.date || '',
                        letter.position || '',
                        letter.locations ? JSON.stringify(letter.locations) : null,
                        letter.generated ? 1 : 0,
                        letter.sent ? 1 : 0,
                        letter.sentDate || null,
                        letter.storedRecipientEmail || '',
                        letter.storedRecipientWebsite || ''
                    ]
                );
                inserted++;
            } catch (err) {
                console.error('Error upserting review cover letter:', err);
            }
        }

        res.json({
            success: true,
            message: 'Review cover letters saved',
            count: inserted
        });
    } catch (error) {
        console.error('Save review cover letters error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get review cover letters for a user
const getReviewCoverLetters = async (req, res) => {
    try {
        const userId = req.user.id;
        
        console.log(`📥 Getting review cover letters for user ${userId}`);

        // Get all cover letters for the user (excluding soft-deleted ones)
        const letters = await dbConfig.query(
            'SELECT letter_key, company_name as "companyName", recipient_email as "recipientEmail", cover_letter_html as "coverLetterHtml", subject, address, date, position, locations, generated, sent, sent_date as "sentDate", stored_recipient_email as "storedRecipientEmail", stored_recipient_website as "storedRecipientWebsite" FROM review_cover_letters WHERE user_id = ? AND deleted_at IS NULL',
            [userId]
        );
        
        console.log(`📊 Found ${letters.length} cover letters in database`);
        letters.forEach((letter, idx) => {
            console.log(`  Letter ${idx}: key=${letter.letter_key}, company=${letter.companyName}, hasHtml=${!!letter.coverLetterHtml}, htmlLength=${letter.coverLetterHtml?.length || 0}`);
        });

        // Convert to object with letter_key as keys
        const reviewCoverLetters = {};
        (letters || []).forEach(letter => {
            reviewCoverLetters[letter.letter_key] = {
                companyName: letter.companyName,
                recipientEmail: letter.recipientEmail,
                coverLetterHtml: letter.coverLetterHtml,
                subject: letter.subject,
                address: letter.address,
                date: letter.date,
                position: letter.position,
                locations: letter.locations ? JSON.parse(letter.locations) : null,
                generated: letter.generated === 1,
                sent: letter.sent === 1,
                sentDate: letter.sentDate,
                storedRecipientEmail: letter.storedRecipientEmail,
                storedRecipientWebsite: letter.storedRecipientWebsite
            };
        });
        
        console.log(`✅ Returning ${Object.keys(reviewCoverLetters).length} cover letters`);

        res.json({
            success: true,
            reviewCoverLetters: reviewCoverLetters,
            count: Object.keys(reviewCoverLetters).length
        });
    } catch (error) {
        console.error('Get review cover letters error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get user counters
const getCounters = async (req, res) => {
    try {
        const userId = req.user.id;

        // Derive all counts directly from actual data — never trust stale users.total_sent/total_generated
        const sentRow = await dbConfig.get(
            'SELECT COUNT(*) as total FROM application_history WHERE user_id = ? AND deleted_at IS NULL',
            [userId]
        );

        const repliedRow = await dbConfig.get(
            'SELECT COUNT(*) as total FROM application_history WHERE user_id = ? AND deleted_at IS NULL AND reply_received = 1',
            [userId]
        );

        // cover_letter_generation entries = letters generated (no deleted_at on this table)
        const usageRow = await dbConfig.get(
            "SELECT COUNT(*) as total FROM credit_usage_history WHERE user_id = ? AND action_type = 'cover_letter_generation'",
            [userId]
        );

        const totalSent = parseInt(sentRow?.total) || 0;
        const totalReplied = parseInt(repliedRow?.total) || 0;
        // Generated is whichever is higher: letters generated from usage history, or apps sent
        const totalGenerated = Math.max(totalSent, parseInt(usageRow?.total) || 0);

        console.log('📊 [COUNTERS] Derived - Generated:', totalGenerated, 'Sent:', totalSent, 'Replied:', totalReplied);

        res.json({
            totalGenerated,
            totalSent,
            totalReplied
        });
    } catch (error) {
        console.error('Error fetching counters:', error);
        res.status(500).json({ error: 'Failed to fetch counters' });
    }
};

// Update user counters
const updateCounters = async (req, res) => {
    try {
        const userId = req.user.id;
        const { totalGenerated, totalSent } = req.body;
        
        await dbConfig.run(
            'UPDATE users SET total_generated = ?, total_sent = ? WHERE id = ?',
            [totalGenerated || 0, totalSent || 0, userId]
        );
        
        res.json({
            success: true,
            totalGenerated: totalGenerated || 0,
            totalSent: totalSent || 0
        });
    } catch (error) {
        console.error('Error updating counters:', error);
        res.status(500).json({ error: 'Failed to update counters' });
    }
};

// Increment generated counter
const incrementGenerated = async (req, res) => {
    try {
        const userId = req.user.id;
        
        await dbConfig.run(
            'UPDATE users SET total_generated = total_generated + 1 WHERE id = ?',
            [userId]
        );
        
        // Fetch updated counter
        const row = await dbConfig.get('SELECT total_generated FROM users WHERE id = ?', [userId]);
        res.json({ success: true, totalGenerated: row.total_generated });
    } catch (error) {
        console.error('Error incrementing generated counter:', error);
        res.status(500).json({ error: 'Failed to increment counter' });
    }
};

// Increment sent counter
const incrementSent = async (req, res) => {
    try {
        const userId = req.user.id;
        
        await dbConfig.run(
            'UPDATE users SET total_sent = total_sent + 1 WHERE id = ?',
            [userId]
        );
        
        // Fetch updated counter
        const row = await dbConfig.get('SELECT total_sent FROM users WHERE id = ?', [userId]);
        res.json({ success: true, totalSent: row.total_sent });
    } catch (error) {
        console.error('Error incrementing sent counter:', error);
        res.status(500).json({ error: 'Failed to increment counter' });
    }
};

// Update application status (mark as replied)
const updateApplicationStatus = async (req, res) => {
    try {
        const userId = req.user.id;
        const id = req.params.id; // Get ID from URL parameter
        const { replyReceived, replyDate } = req.body;

        console.log('🔄 [UPDATE STATUS] Request received:', { userId, id, replyReceived, replyDate });

        if (!id) {
            console.error('❌ [UPDATE STATUS] No ID provided');
            return res.status(400).json({ error: 'Application ID is required' });
        }

        // Properly handle null values for PostgreSQL
        const replyReceivedValue = replyReceived ? 1 : 0;
        const replyDateValue = replyDate && replyDate !== 'null' && replyDate !== '' ? replyDate : null;

        console.log('🔄 [UPDATE STATUS] Values to update:', { replyReceivedValue, replyDateValue });

        // Update only the specific application that belongs to this user
        const result = await dbConfig.run(
            'UPDATE application_history SET reply_received = ?, reply_date = ? WHERE id = ? AND user_id = ?',
            [replyReceivedValue, replyDateValue, id, userId]
        );

        console.log('✅ [UPDATE STATUS] Database updated successfully', result);

        res.json({
            success: true,
            message: 'Application status updated'
        });
    } catch (error) {
        console.error('❌ [UPDATE STATUS] Error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get all replies for a specific application
const getApplicationReplies = async (req, res) => {
    try {
        const userId = req.user.id;
        const applicationId = req.params.id;

        // Verify that this application belongs to the user
        const application = await dbConfig.get(
            'SELECT id, company_name FROM application_history WHERE id = ? AND user_id = ?',
            [applicationId, userId]
        );

        if (!application) {
            return res.status(404).json({ error: 'Application not found' });
        }

        // Get all replies for this application, ordered by date (newest first)
        const replies = await dbConfig.query(
            `SELECT 
                id, 
                reply_date as "replyDate", 
                reply_subject as "replySubject", 
                reply_snippet as "replySnippet", 
                reply_from_email as "replyFromEmail", 
                created_at as "createdAt"
            FROM application_reply_history 
            WHERE application_id = ? 
            ORDER BY reply_date DESC`,
            [applicationId]
        );

        res.json({
            success: true,
            companyName: application.company_name,
            replies: replies || [],
            count: (replies || []).length
        });
    } catch (error) {
        console.error('Get application replies error:', error);
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    saveRecipients,
    getRecipients,
    saveApplicationHistory,
    getApplicationHistory,
    saveReviewCoverLetters,
    getReviewCoverLetters,
    getCounters,
    updateCounters,
    incrementGenerated,
    incrementSent,
    updateApplicationStatus,
    getApplicationReplies
};
