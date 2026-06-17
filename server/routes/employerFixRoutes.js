const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/employerFixController');
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');

// User — submit a fix request for an employer we couldn't fetch, + poll its status
router.post('/ai-hub/fix-requests', authenticateToken, ctrl.submitFixRequest);
router.get('/ai-hub/fix-requests/:id', authenticateToken, ctrl.getRequestStatus);

// Admin — the diagnostic agent dashboard
router.get('/admin/employer-requests', authenticateAdmin, ctrl.adminListRequests);
router.post('/admin/employer-requests/:id/investigate', authenticateAdmin, ctrl.adminInvestigate);
router.get('/admin/employer-requests/:id/overrides', authenticateAdmin, ctrl.adminOverrideHistory);
router.post('/admin/employer-requests/:id/deactivate', authenticateAdmin, ctrl.adminDeactivate);
router.post('/admin/employer-overrides/:overrideId/activate', authenticateAdmin, ctrl.adminActivateOverride);

module.exports = router;
