const express = require('express');
const router = express.Router();
const userDataController = require('../controllers/userDataController');
const { authenticateToken } = require('../middleware/auth');

// Recipients routes
router.post('/recipients', authenticateToken, userDataController.saveRecipients);
router.get('/recipients', authenticateToken, userDataController.getRecipients);

// Application history routes
router.post('/application-history', authenticateToken, userDataController.saveApplicationHistory);
router.get('/application-history', authenticateToken, userDataController.getApplicationHistory);
router.patch('/application-history/:id', authenticateToken, userDataController.updateApplicationStatus);
router.get('/application-history/:id/replies', authenticateToken, userDataController.getApplicationReplies);

// Review cover letters routes
router.post('/review-cover-letters', authenticateToken, userDataController.saveReviewCoverLetters);
router.get('/review-cover-letters', authenticateToken, userDataController.getReviewCoverLetters);

// Counters routes
router.get('/counters', authenticateToken, userDataController.getCounters);
router.post('/counters', authenticateToken, userDataController.updateCounters);
router.post('/counters/increment-generated', authenticateToken, userDataController.incrementGenerated);
router.post('/counters/increment-sent', authenticateToken, userDataController.incrementSent);

module.exports = router;
