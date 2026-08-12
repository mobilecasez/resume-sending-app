// Admin-only push-alert settings — ADDITIVE. Toggle the new-install / new-registration / new-purchase
// admin alerts, and send a test push. All routes require an admin token (authenticateAdmin).
const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const notifier = require('../services/adminNotifier');

// ── Forced-upgrade gate ───────────────────────────────────────────────────────────────────────
// ⚠️ ios_min_build is the only switch here that can make the app unusable for everyone at once.
// It is stored inert (0 = nobody blocked) and must be raised deliberately. Prefer the nudge floor.
router.get('/admin/version-gate', authenticateAdmin, async (req, res) => {
    try { res.json({ success: true, gate: await require('../services/versionGate').getGate() }); }
    catch (e) { res.status(500).json({ error: 'Failed to load the version gate' }); }
});
router.post('/admin/version-gate', authenticateAdmin, async (req, res) => {
    try { res.json({ success: true, gate: await require('../services/versionGate').setGate(req.body || {}) }); }
    catch (e) { res.status(500).json({ error: 'Failed to save the version gate' }); }
});

// ── Push analytics ────────────────────────────────────────────────────────────────────────────
// GET /admin/push-analytics?days=30      → campaign list + per-source rollup + video stats
// GET /admin/push-analytics/:id?hours=24 → one campaign's funnel, activity proxy, recipient rows
router.get('/admin/push-analytics', authenticateAdmin, async (req, res) => {
    try {
        const log = require('../services/pushLog');
        const days = parseInt(req.query.days, 10) || 30;
        const [campaigns, sources, video] = await Promise.all([
            log.campaignList(days), log.sourceRollup(days), log.videoStats(days),
        ]);
        res.json({
            success: true, days, campaigns, sources, video,
            // Rendered verbatim by the app so the numbers can never be read as more than they are.
            notes: {
                delivered: 'Apple and Google never confirm delivery. “Handed to Apple/Google” is as far as it goes — it is not proof the notification appeared, and never proof it was seen.',
                opens: 'Taps are only reported by app builds that carry the tap ping. Anything older reports nothing, so opens read as 0 for those users no matter how many really tapped.',
                activity: 'Active after is a correlation, not an attribution: it counts people who used the app within the window, including those who would have opened it anyway.',
            },
        });
    } catch (e) {
        console.error('[adminNotify] push-analytics:', e.message);
        res.status(500).json({ error: 'Failed to load push analytics', detail: e.message });
    }
});

// GET /admin/push-analytics/video?days=30 → the watch summary plus one row per watcher
router.get('/admin/push-analytics/video', authenticateAdmin, async (req, res) => {
    try {
        const log = require('../services/pushLog');
        const days = parseInt(req.query.days, 10) || 30;
        const [summary, watchers] = await Promise.all([
            log.videoStats(days),
            log.videoWatchers({ days, limit: parseInt(req.query.limit, 10) || 200 }),
        ]);
        res.json({
            success: true, days, ...summary, watchers,
            notes: {
                coverage: 'Watched % is how much of the film they actually saw, measured by which parts of the timeline played. Scrubbing to the end does not count as watching it.',
                seconds: 'Seconds is time genuinely spent playing, so it can exceed the running time when someone rewatches.',
                availability: 'Only builds carrying the watch measurement report this. Watches on older builds are counted as plays but have no duration.',
            },
        });
    } catch (e) {
        console.error('[adminNotify] video analytics:', e.message);
        res.status(500).json({ error: 'Failed to load video analytics', detail: e.message });
    }
});

router.get('/admin/push-analytics/:id', authenticateAdmin, async (req, res) => {
    try {
        const log = require('../services/pushLog');
        const id = String(req.params.id || '');
        const hours = parseInt(req.query.hours, 10) || 24;
        const [funnel, activeAfter, rows] = await Promise.all([
            log.campaignFunnel(id), log.activityAfter(id, hours), log.sendRows({ campaignId: id, limit: 200 }),
        ]);
        res.json({ success: true, id, hours, ...funnel, active_after: activeAfter, rows });
    } catch (e) {
        console.error('[adminNotify] push-analytics detail:', e.message);
        res.status(500).json({ error: 'Failed to load campaign', detail: e.message });
    }
});

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
