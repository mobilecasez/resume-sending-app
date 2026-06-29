const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const ctrl = require('../controllers/adminStoreAnalyticsController');

// Admin-only: combined Apple App Store + Google Play + recorded-transactions analytics.
router.get('/admin/store-analytics', authenticateAdmin, ctrl.getStoreAnalytics);

// Admin-only: run an uninstall-detection sweep (silent push + receipts → DeviceNotRegistered).
router.post('/admin/uninstall-sweep', authenticateAdmin, ctrl.runUninstallSweep);

module.exports = router;
