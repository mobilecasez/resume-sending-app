const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/rewardsController');
const { authenticateToken } = require('../middleware/auth');

router.get('/rewards', authenticateToken, ctrl.getRewards);
router.post('/rewards/evaluate', authenticateToken, ctrl.evaluate);

module.exports = router;
