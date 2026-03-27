const express = require('express');
const router = express.Router();
const emailController = require('../controllers/emailController');
const { authenticateToken } = require('../middleware/auth');

// Send applications (bulk)
router.post('/send-applications', authenticateToken, emailController.sendApplications);

// Send single application (from review page)
router.post('/send-single-application', authenticateToken, emailController.sendSingleApplication);

// Check for email replies
router.post('/check-replies', authenticateToken, emailController.checkEmailReplies);

module.exports = router;
