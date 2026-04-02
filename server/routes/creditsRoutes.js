const express = require('express');
const router = express.Router();
const creditsController = require('../controllers/creditsController');
const { authenticateToken } = require('../middleware/auth');

// Plans route (public)
router.get('/plans', creditsController.getPlans);

// User credits routes
router.get('/user/credits', authenticateToken, creditsController.getUserCredits);
router.post('/purchase-credits', authenticateToken, creditsController.purchaseCredits);

// Usage stats routes
router.get('/user/usage-stats', authenticateToken, creditsController.getUsageStats);
router.get('/user/credit-history', authenticateToken, creditsController.getCreditHistory);
router.get('/user/purchase-history', authenticateToken, creditsController.getPurchaseHistory);

module.exports = router;
