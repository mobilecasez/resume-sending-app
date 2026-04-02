const express = require('express');
const router = express.Router();
const notificationsController = require('../controllers/notificationsController');
const { authenticateToken } = require('../middleware/auth');

// Get all notifications for logged-in user
router.get('/notifications', authenticateToken, notificationsController.getUserNotifications);

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
