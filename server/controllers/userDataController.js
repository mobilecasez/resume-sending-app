const dbConfig = require('../../db-config');

// Save recipients for a user
const saveRecipients = async (req, res) => {
    try {
        const userId = req.user.id;
        const { recipients } = req.body;

        if (!recipients || !Array.isArray(recipients)) {
            return res.status(400).json({ error: 'Recipients must be an array' });
        }

        // Clear existing recipients for this user
        await dbConfig.run('DELETE FROM recipients WHERE user_id = ?', [userId]);

        // Insert new recipients
        const validRecipients = recipients.filter(r => r.email && r.website);
        
        if (validRecipients.length === 0) {
            return res.json({
                success: true,
                message: 'Recipients cleared successfully',
                recipientsCount: 0
            });
        }

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

        // Delete existing history for this user
        await dbConfig.run('DELETE FROM application_history WHERE user_id = ?', [userId]);

        // Insert new history
        let inserted = 0;
        for (const app of applicationHistory) {
            try {
                await dbConfig.run(
                    'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date, reply_received, reply_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [userId, app.companyName || '', app.position || '', app.recipientEmail || '', app.sentDate || new Date().toISOString(), app.replyReceived ? 1 : 0, app.replyDate || null]
                );
                inserted++;
            } catch (err) {
                console.error('Error inserting application history:', err);
            }
        }

        res.json({
            success: true,
            message: 'Application history saved',
            count: inserted
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

        const history = await dbConfig.query(
            'SELECT id, company_name as "companyName", position, recipient_email as "recipientEmail", sent_date as "sentDate", reply_received as "replyReceived", reply_date as "replyDate" FROM application_history WHERE user_id = ? ORDER BY sent_date DESC',
            [userId]
        );

        // Convert reply_received from 0/1 to boolean
        const formattedHistory = (history || []).map(app => ({
            ...app,
            replyReceived: app.replyReceived === 1
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

        // Delete existing cover letters for this user
        await dbConfig.run('DELETE FROM review_cover_letters WHERE user_id = ?', [userId]);

        // Insert new cover letters
        let inserted = 0;
        const entries = Object.entries(reviewCoverLetters);
        
        for (const [key, letter] of entries) {
            try {
                await dbConfig.run(
                    'INSERT INTO review_cover_letters (user_id, letter_key, company_name, recipient_email, cover_letter_html, subject, address, date, position, locations, generated, sent, sent_date, stored_recipient_email, stored_recipient_website) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
                console.error('Error inserting review cover letter:', err);
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

        const letters = await dbConfig.query(
            'SELECT letter_key, company_name as companyName, recipient_email as recipientEmail, cover_letter_html as coverLetterHtml, subject, address, date, position, locations, generated, sent, sent_date as sentDate, stored_recipient_email as storedRecipientEmail, stored_recipient_website as storedRecipientWebsite FROM review_cover_letters WHERE user_id = ?',
            [userId]
        );

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
        
        const row = await dbConfig.get(
            'SELECT total_generated, total_sent FROM users WHERE id = ?',
            [userId]
        );
        
        res.json({
            totalGenerated: row?.total_generated || 0,
            totalSent: row?.total_sent || 0
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
    incrementSent
};
