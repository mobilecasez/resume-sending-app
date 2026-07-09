const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const ctrl = require('../controllers/adminStoreAnalyticsController');

// Admin-only: combined Apple App Store + Google Play + recorded-transactions analytics.
router.get('/admin/store-analytics', authenticateAdmin, ctrl.getStoreAnalytics);

// Admin-only: run an uninstall-detection sweep (silent push + receipts → DeviceNotRegistered).
router.post('/admin/uninstall-sweep', authenticateAdmin, ctrl.runUninstallSweep);

// Admin-only: per-user behavior — recent users list + one user's full event timeline.
router.get('/admin/user-journeys', authenticateAdmin, ctrl.getUserJourneys);
router.get('/admin/user-timeline', authenticateAdmin, ctrl.getUserTimeline);

// Admin-only: analytics over a custom date range (?from=&to=).
router.get('/admin/range-analytics', authenticateAdmin, ctrl.getRangeAnalytics);

module.exports = router;
