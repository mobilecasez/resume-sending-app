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

// Fire a test push to every admin device (bypasses category gating so it always sends).
// ⚠️ Returns the push HEALTH alongside the result. "sent: 1" only means we handed the message to
// Expo — if the project has no APNs key, Expo rejects it and nothing reaches a phone. That gap is
// exactly how an eight-day outage went unnoticed, so the real delivery state is reported here.
router.post('/admin/notification-test', authenticateAdmin, async (req, res) => {
    try {
        const { getPushHealth } = require('../services/expoPushService');
        const result = await notifier.notifyAdmins(null, 'CVApplyr admin alert 🔔', 'Test notification — admin alerts are working.', { type: 'test' });
        await new Promise((r) => setTimeout(r, 400));      // let the ticket come back before reporting
        const health = getPushHealth();
        res.json({
            success: true,
            result,
            health,
            delivered: !health.lastError || (health.lastOkAt && health.lastOkAt > health.lastErrorAt),
            hint: health.lastError && /InvalidCredentials/i.test(health.lastError)
                ? 'No APNs key on the Expo project — run fix-ios-push.sh. Nothing can reach an iPhone until then.'
                : undefined,
        });
    } catch (e) { res.status(500).json({ error: 'Failed to send test notification' }); }
});

// Push health on its own — for the admin dashboard, no test push sent.
router.get('/admin/push-health', authenticateAdmin, (req, res) => {
    try { res.json({ success: true, health: require('../services/expoPushService').getPushHealth() }); }
    catch (e) { res.status(500).json({ error: 'Failed to read push health' }); }
});

module.exports = router;
