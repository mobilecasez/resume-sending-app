const express = require('express');
const router = express.Router();
const usageController = require('../controllers/usageController');
const { authenticateToken } = require('../middleware/auth');

// Usage stats route
router.get('/usage-stats', authenticateToken, usageController.getUsageStats);

module.exports = router;
