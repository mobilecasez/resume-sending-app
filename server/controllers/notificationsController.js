const dbConfig = require('../../db-config');
const auditUtils = require('../utils/auditUtils');
const expoPush = require('../services/expoPushService');
const notifPrefs = require('../services/notificationPrefs');

// Send a device push for a notification, gated by the user's per-category preference. Best-effort:
// never throws, never blocks the in-app notification. A stale Expo token → passive uninstall log.
const pushForNotification = async (userId, { pushTitle, pushBody, category, type, metadata }) => {
    try {
        if (category && !(await notifPrefs.isEnabled(userId, category))) return;   // user opted out of this category
        const u = await dbConfig.get('SELECT expo_push_token FROM users WHERE id = ?', [userId]);
        if (!u || !u.expo_push_token) return;
        const r = await expoPush.sendPushNotification(
            u.expo_push_token, pushTitle, pushBody, { type, ...(metadata || {}) }
        );
        if (r === 'stale') { try { await require('../services/uninstallDetection').handleStaleToken(userId); } catch (_) {} }
    } catch (e) { console.warn('[notif] push failed (non-blocking):', e.message); }
};

// Helper function to create notification.
// opts: { push: bool, category: string, pushTitle?, pushBody? } — when push is true, also fire an
// Expo push (gated by the user's notification_preferences category).
const createNotification = async (userId, type, title, message, details = null, metadata = null, opts = {}) => {
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

        if (opts && opts.push) {
            await pushForNotification(userId, {
                pushTitle: opts.pushTitle || title,
                pushBody: opts.pushBody || message,
                category: opts.category,
                type, metadata,
            });
        }
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
//
// ⚠️ EVERY PUSHED NOTIFICATION MUST CARRY `route` (and `params`) IN ITS METADATA.
// pushForNotification sends `data = { type, ...metadata }`, and the app's resolveRoute
// (MobileApp/services/pushRouting.ts) reads ONLY `data.route`. Until this comment was written not
// one of these helpers set it, so every follow-up reminder, credit warning and weekly digest we
// have ever sent opened the app and then just… sat there on whatever screen was last used. The
// valid values are listed in services/notifyTemplates.js's header; anything else is a no-op.

// Cover Letter Generated
const notifyCoverLetterGenerated = async (userId, employerName, position, companyWebsite) => {
    const title = 'Cover Letter Generated';
    const message = `Generated cover letter for ${position} at ${employerName}`;
    const details = `A personalized cover letter has been successfully generated for the ${position} position at ${employerName}.`;
    const metadata = {
        employerName,
        position,
        companyWebsite,
        action: 'cover_letter_generated',
        route: '/(ai-hub)', params: { tab: 'myjobs' },
    };

    await createNotification(userId, 'cover_letter', title, message, details, metadata, {
        push: true, category: 'application_updates',
        pushTitle: 'Cover letter ready 📝', pushBody: `Your ${position} letter for ${employerName} is ready.`,
    });
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
        action: 'email_sent',
        route: '/(ai-hub)', params: { tab: 'myjobs' },
    };

    await createNotification(userId, 'email', title, message, details, metadata, {
        push: true, category: 'application_updates',
        pushTitle: 'Application sent ✅', pushBody: `Your application to ${employerName} is on its way.`,
    });
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
        action: 'credits_added',
        route: '/(ai-hub)', params: {},
    };

    await createNotification(userId, 'credits', title, message, details, metadata, {
        push: true, category: 'application_updates',
        pushTitle: 'Credits added 💳', pushBody: `${creditsAdded} credit${creditsAdded > 1 ? 's' : ''} added — you now have ${newBalance}.`,
    });
};

// Low credits — nudge when the balance drops to a small number after spending.
const notifyLowCredits = async (userId, newBalance) => {
    const title = newBalance <= 0 ? 'Out of credits' : 'Low on credits';
    const message = newBalance <= 0
        ? 'You have no credits left. Top up to keep generating cover letters and applying.'
        : `You have ${newBalance} credit${newBalance === 1 ? '' : 's'} left. Top up so you never miss a match.`;
    await createNotification(userId, 'credits', title, message, null, { newBalance, action: 'low_credits', route: '/(ai-hub)', params: {} }, {
        push: true, category: 'application_updates',
        pushTitle: newBalance <= 0 ? 'Out of credits' : 'Running low on credits',
        pushBody: message,
    });
};

// New jobs found for a company the user is tracking (on a re-search / refresh).
const notifyNewJobs = async (userId, employerName, count, employerId) => {
    const title = `${count} new job${count === 1 ? '' : 's'} at ${employerName}`;
    const message = `We found ${count} new opening${count === 1 ? '' : 's'} at ${employerName} that match your resume.`;
    await createNotification(userId, 'jobs', title, message, null,
        { employerName, employerId: String(employerId || ''), count, action: 'new_jobs', route: '/(discover)', params: { sort: 'match' } }, {
        push: true, category: 'application_updates',
        pushTitle: `${count} new job${count === 1 ? '' : 's'} at ${employerName} 🎯`, pushBody: 'Tap to view your new matches.',
    });
};

// Follow-up reminder — an application sent a while ago with no reply.
const notifyFollowUp = async (userId, companyName, daysAgo) => {
    const title = 'Time for a follow-up?';
    const message = `It's been ${daysAgo} days since you applied to ${companyName} with no reply. A short follow-up can help.`;
    await createNotification(userId, 'reminder', title, message, null,
        { companyName, daysAgo, action: 'follow_up_reminder', route: '/(ai-hub)', params: { tab: 'myjobs' } }, {
        push: true, category: 'reminders',
        pushTitle: 'Time for a follow-up?', pushBody: `No reply from ${companyName} yet — a quick nudge can help.`,
    });
};

// Weekly digest of activity.
const notifyWeeklyDigest = async (userId, { sent, replies, generated }) => {
    const parts = [];
    if (sent) parts.push(`${sent} application${sent === 1 ? '' : 's'} sent`);
    if (replies) parts.push(`${replies} repl${replies === 1 ? 'y' : 'ies'}`);
    if (generated) parts.push(`${generated} cover letter${generated === 1 ? '' : 's'}`);
    const summary = parts.length ? parts.join(' · ') : 'a quiet week';
    const title = 'Your week on CVApplyr';
    const message = `Last 7 days: ${summary}. Keep the momentum going!`;
    await createNotification(userId, 'digest', title, message, null,
        { sent, replies, generated, action: 'weekly_digest', route: '/(ai-hub)', params: { tab: 'myjobs' } }, {
        push: true, category: 'digest',
        pushTitle: 'Your week on CVApplyr 📊', pushBody: `Last 7 days: ${summary}.`,
    });
};

// Credit-expiry warning.
const notifyCreditExpiry = async (userId, credits, daysLeft) => {
    const title = 'Credits expiring soon';
    const message = `${credits} credit${credits === 1 ? '' : 's'} expire in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Use them before they're gone.`;
    await createNotification(userId, 'credits', title, message, null,
        { credits, daysLeft, action: 'credit_expiry', route: '/(ai-hub)', params: {} }, {
        push: true, category: 'reminders',
        pushTitle: 'Credits expiring soon ⏳', pushBody: message,
    });
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
        action: 'email_reply_received',
        route: '/(ai-hub)', params: { tab: 'myjobs' },
    };

    await createNotification(userId, 'email', title, message, details, metadata, {
        push: true, category: 'replies',
        pushTitle: `Reply from ${companyName} 📬`, pushBody: replySubject || 'Tap to read the reply.',
    });
};

// GET /api/notifications/preferences — the user's per-category toggles (default all ON).
const getPreferences = async (req, res) => {
    try {
        const prefs = await notifPrefs.getPrefs(req.user.id);
        res.json({ success: true, preferences: prefs });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load notification preferences' });
    }
};

// PUT /api/notifications/preferences — body: { replies?, application_updates?, reminders?, digest?, marketing? }
const updatePreferences = async (req, res) => {
    try {
        const prefs = await notifPrefs.setPrefs(req.user.id, req.body || {});
        res.json({ success: true, preferences: prefs });
    } catch (e) {
        res.status(500).json({ error: 'Failed to update notification preferences' });
    }
};

module.exports = {
    getUserNotifications,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    deleteAllRead,
    getPreferences,
    updatePreferences,
    // Notification creators
    notifyCoverLetterGenerated,
    notifyEmailSent,
    notifyCreditsAdded,
    notifyCreditsUsed,
    notifyProfileUpdated,
    notifyError,
    notifyEmailReply,
    notifyLowCredits,
    notifyNewJobs,
    notifyFollowUp,
    notifyWeeklyDigest,
    notifyCreditExpiry,
    createNotification
};
