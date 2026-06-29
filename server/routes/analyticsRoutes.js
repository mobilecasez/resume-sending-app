const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/analyticsController');

// First-party app telemetry (open — records user_id only if a valid bearer token is sent).
router.post('/analytics/track', ctrl.track);

// Store server-to-server purchase/refund notifications (real-time). No app auth — the providers POST
// a self-signed payload; we decode + record for the live dashboard (crediting stays in /payment/verify-*).
router.post('/webhooks/apple-notifications', ctrl.appleNotifications);
router.post('/webhooks/google-rtdn', ctrl.googleRtdn);

module.exports = router;
