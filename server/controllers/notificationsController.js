const dbConfig = require('../../db-config');
const auditUtils = require('../utils/auditUtils');

// Helper function to create notification
const createNotification = async (userId, type, title, message, details = null, metadata = null) => {
    console.log(`📢 createNotification called - User: ${userId}, Type: ${type}, Title: ${title}`);
    try {
        const metadataJson = metadata ? JSON.stringify(metadata) : null;
        const detailsText = details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null;
        
        console.log(`📝 Inserting notification into database...`);
        const result = await dbConfig.run(
            `INSERT INTO notifications (user_id, type, title, message, details, metadata, created_at) 
             VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [userId, type, title, message, detailsText, metadataJson]
        );
        
        console.log(`✅ Notification created for user ${userId}: ${type} (ID: ${result.lastID})`);
    } catch (error) {
        console.error(`❌ Error creating notification for user ${userId}:`, error);
        console.error('Error details:', error.message);
        console.error('Stack:', error.stack);
    }
};

// Get all notifications for a user
// Get all notifications for a user
const getUserNotifications = async (req, res) => {
    try {
        const userId = req.user.id;
        const { limit = 50, offset = 0, unreadOnly = false } = req.query;
        
        console.log(`📥 Fetching notifications for user ${userId}, limit: ${limit}`);
        
        let query = `
            SELECT * FROM notifications 
            WHERE user_id = ?
        `;
        
        const params = [userId];
        
        if (unreadOnly === 'true') {
            query += ' AND is_read = 0';
        }
        
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));
        
        const notifications = await dbConfig.query(query, params);

        console.log(`📊 Found ${notifications.length} notifications`);

        // Get unread count and total count (for accurate stats regardless of loaded batch size)
        const [unreadCount, totalCount] = await Promise.all([
            dbConfig.get('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0', [userId]),
            dbConfig.get('SELECT COUNT(*) as count FROM notifications WHERE user_id = ?', [userId]),
        ]);

        const totalUnread = parseInt(unreadCount?.count || 0);
        const totalAll    = parseInt(totalCount?.count  || 0);

        console.log(`🔔 Unread: ${totalUnread} / Total: ${totalAll}`);

        res.json({
            success: true,
            notifications,
            unreadCount:  totalUnread,
            totalCount:   totalAll,
            readCount:    totalAll - totalUnread,
            hasMore:      parseInt(offset) + notifications.length < totalAll,
            total: notifications.length   // kept for backwards compat
        });
    } catch (error) {
        console.error('❌ Error fetching notifications:', error);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
};

// Mark notification as read
const markAsRead = async (req, res) => {
    try {
        const userId = req.user.id;
        const { notificationId } = req.params;
        
        console.log(`📝 Marking notification ${notificationId} as read for user ${userId}`);
        
        const result = await dbConfig.run(
            'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
            [notificationId, userId]
        );
        
        console.log(`✅ Notification marked as read. Rows affected: ${result.changes}`);
        
        res.json({ success: true, message: 'Notification marked as read' });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ error: 'Failed to mark notification as read' });
    }
};

// Mark all notifications as read
const markAllAsRead = async (req, res) => {
    try {
        const userId = req.user.id;
        
        console.log(`📝 Marking ALL notifications as read for user ${userId}`);
        
        const result = await dbConfig.run(
            'UPDATE notifications SET is_read = 1 WHERE user_id = ?',
            [userId]
        );
        
        console.log(`✅ All notifications marked as read. Rows affected: ${result.changes}`);
        
        res.json({ success: true, message: 'All notifications marked as read' });
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ error: 'Failed to mark all notifications as read' });
    }
};

// Delete notification - SOFT DELETE
const deleteNotification = async (req, res) => {
    try {
        const userId = req.user.id;
        const { notificationId } = req.params;
        
        // Get the notification before soft-deleting for audit trail
        const notificationData = await dbConfig.get(
            'SELECT * FROM notifications WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
            [notificationId, userId]
        );
        
        if (!notificationData) {
            return res.status(404).json({ error: 'Notification not found or already deleted' });
        }
        
        // Perform soft delete
        await auditUtils.softDelete('notifications', notificationId, userId, notificationData);
        
        res.json({ success: true, message: 'Notification deleted' });
    } catch (error) {
        console.error('Error deleting notification:', error);
        res.status(500).json({ error: 'Failed to delete notification' });
    }
};

// Delete all read notifications - SOFT DELETE
const deleteAllRead = async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Soft delete all read notifications
        await auditUtils.bulkSoftDelete('notifications', 'user_id = ? AND is_read = 1', [userId], userId);
        
        res.json({ success: true, message: 'All read notifications deleted' });
    } catch (error) {
        console.error('Error deleting read notifications:', error);
        res.status(500).json({ error: 'Failed to delete read notifications' });
    }
};

// Specific notification creators for different actions

// Cover Letter Generated
const notifyCoverLetterGenerated = async (userId, employerName, position, companyWebsite) => {
    const title = 'Cover Letter Generated';
    const message = `Generated cover letter for ${position} at ${employerName}`;
    const details = `A personalized cover letter has been successfully generated for the ${position} position at ${employerName}.`;
    const metadata = {
        employerName,
        position,
        companyWebsite,
        action: 'cover_letter_generated'
    };
    
    await createNotification(userId, 'cover_letter', title, message, details, metadata);
};

// Email Sent
const notifyEmailSent = async (userId, employerName, employerEmail, position, subject) => {
    const title = 'Application Sent';
    const message = `Sent application to ${employerName} (${employerEmail})`;
    const details = `Your application for ${position} has been successfully sent to ${employerEmail}.`;
    const metadata = {
        employerName,
        employerEmail,
        position,
        subject,
        action: 'email_sent'
    };
    
    await createNotification(userId, 'email', title, message, details, metadata);
};

// Credits Added
const notifyCreditsAdded = async (userId, creditsAdded, previousBalance, newBalance, source = 'purchase') => {
    const title = 'Credits Added';
    const message = `${creditsAdded} credit${creditsAdded > 1 ? 's' : ''} added to your account`;
    const details = `Your credit balance has been updated from ${previousBalance} to ${newBalance} credits.`;
    const metadata = {
        creditsAdded,
        previousBalance,
        newBalance,
        source,
        action: 'credits_added'
    };
    
    await createNotification(userId, 'credits', title, message, details, metadata);
};

// Credits Used
const notifyCreditsUsed = async (userId, creditsUsed, previousBalance, newBalance, usedFor) => {
    const title = 'Credits Used';
    const message = `${creditsUsed} credit${creditsUsed > 1 ? 's' : ''} used for ${usedFor}`;
    const details = `Your credit balance has been updated from ${previousBalance} to ${newBalance} credits.`;
    const metadata = {
        creditsUsed,
        previousBalance,
        newBalance,
        usedFor,
        action: 'credits_used'
    };
    
    await createNotification(userId, 'credits', title, message, details, metadata);
};

// Profile Updated
const notifyProfileUpdated = async (userId, fieldsUpdated) => {
    const title = 'Profile Updated';
    const fieldsList = Array.isArray(fieldsUpdated) ? fieldsUpdated.join(', ') : fieldsUpdated;
    const message = `Profile updated: ${fieldsList}`;
    const details = `The following profile fields have been successfully updated: ${fieldsList}.`;
    const metadata = {
        fieldsUpdated: Array.isArray(fieldsUpdated) ? fieldsUpdated : [fieldsUpdated],
        action: 'profile_updated'
    };
    
    await createNotification(userId, 'profile', title, message, details, metadata);
};

// Error Notification
const notifyError = async (userId, errorTitle, errorMessage, action = null) => {
    const title = errorTitle || 'Error';
    const message = errorMessage;
    const details = action ? `Action required: ${action}` : null;
    const metadata = {
        action: action || 'error_occurred',
        timestamp: new Date().toISOString()
    };
    
    await createNotification(userId, 'error', title, message, details, metadata);
};

// Email Reply Received
const notifyEmailReply = async (userId, companyName, replySubject) => {
    const title = 'Reply Received!';
    const message = `${companyName} replied to your application`;
    const details = `Subject: ${replySubject}`;
    const metadata = {
        companyName,
        replySubject,
        action: 'email_reply_received'
    };

    await createNotification(userId, 'email', title, message, details, metadata);
};

module.exports = {
    getUserNotifications,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    deleteAllRead,
    // Notification creators
    notifyCoverLetterGenerated,
    notifyEmailSent,
    notifyCreditsAdded,
    notifyCreditsUsed,
    notifyProfileUpdated,
    notifyError,
    notifyEmailReply,
    createNotification
};
