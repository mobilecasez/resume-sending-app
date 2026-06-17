const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/feedbackController');
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');

router.post('/feedback', authenticateToken, ctrl.submitFeedback);
router.get('/admin/feedback', authenticateAdmin, ctrl.listFeedback);

module.exports = router;
