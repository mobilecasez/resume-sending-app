// Admin-only push-alert settings — ADDITIVE. Toggle the new-install / new-registration / new-purchase
// admin alerts, and send a test push. All routes require an admin token (authenticateAdmin).
const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const notifier = require('../services/adminNotifier');

// Current toggles
router.get('/admin/notification-settings', authenticateAdmin, async (req, res) => {
    try { res.json({ success: true, settings: await notifier.getSettings(), categories: notifier.CATEGORIES }); }
    catch (e) { res.status(500).json({ error: 'Failed to load notification settings' }); }
});

// Update toggles (any subset of installs / registrations / purchases)
router.put('/admin/notification-settings', authenticateAdmin, async (req, res) => {
    try { res.json({ success: true, settings: await notifier.setSettings(req.body || {}) }); }
    catch (e) { res.status(500).json({ error: 'Failed to save notification settings' }); }
});

// Fire a test push to every admin device (bypasses category gating so it always sends)
router.post('/admin/notification-test', authenticateAdmin, async (req, res) => {
    try {
        const result = await notifier.notifyAdmins(null, 'CVApplyr admin alert 🔔', 'Test notification — admin alerts are working.', { type: 'test' });
        res.json({ success: true, result });
    } catch (e) { res.status(500).json({ error: 'Failed to send test notification' }); }
});

module.exports = router;
