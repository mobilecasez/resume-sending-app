const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/aiEventCostsController');
const { authenticateAdmin } = require('../middleware/auth');

// Public — active credit-cost map for in-app cost labels
router.get('/ai-event-costs', ctrl.getPublicCosts);

// Admin — list + edit per-event credit cost
router.get('/admin/ai-event-costs', authenticateAdmin, ctrl.getAllEvents);
router.put('/admin/ai-event-costs/:eventKey', authenticateAdmin, ctrl.updateEvent);

module.exports = router;
