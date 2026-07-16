const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/rewardsController');
const { authenticateToken } = require('../middleware/auth');

router.get('/rewards', authenticateToken, ctrl.getRewards);
router.post('/rewards/evaluate', authenticateToken, ctrl.evaluate);
router.get('/referral', authenticateToken, ctrl.getReferral);
router.post('/referral/claim', authenticateToken, ctrl.claimReferral);

module.exports = router;
