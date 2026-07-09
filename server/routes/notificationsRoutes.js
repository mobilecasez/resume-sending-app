const express = require('express');
const router = express.Router();
const notificationsController = require('../controllers/notificationsController');
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');

// Get all notifications for logged-in user
router.get('/notifications', authenticateToken, notificationsController.getUserNotifications);

// Per-category notification preferences (opt-out)
router.get('/notifications/preferences', authenticateToken, notificationsController.getPreferences);
router.put('/notifications/preferences', authenticateToken, notificationsController.updatePreferences);

// Admin: force-run the background notification jobs (for testing / on-demand).
router.post('/admin/notifications/run/:job', authenticateAdmin, async (req, res) => {
    try {
        const job = req.params.job;
        let result;
        if (job === 'reply-poll') result = await require('../services/replyPoller').runReplyPoll({ force: true });
        else if (job === 'daily-reminders') result = await require('../services/engagementScheduler').runDailyReminders({ force: true });
        else if (job === 'weekly-digest') result = await require('../services/engagementScheduler').runWeeklyDigest({ force: true });
        else return res.status(400).json({ error: 'unknown job (reply-poll | daily-reminders | weekly-digest)' });
        res.json({ success: true, job, result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Mark notification as read (support both POST and PATCH)
router.post('/notifications/:notificationId/read', authenticateToken, notificationsController.markAsRead);
router.patch('/notifications/:notificationId/read', authenticateToken, notificationsController.markAsRead);

// Mark all notifications as read (support both POST and PATCH)
router.post('/notifications/mark-all-read', authenticateToken, notificationsController.markAllAsRead);
router.patch('/notifications/mark-all-read', authenticateToken, notificationsController.markAllAsRead);

// Delete single notification
router.delete('/notifications/:notificationId', authenticateToken, notificationsController.deleteNotification);

// Delete all read notifications
router.delete('/notifications/read/all', authenticateToken, notificationsController.deleteAllRead);

module.exports = router;
