// AI Hub — new feature. Safe to delete without affecting existing app.

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
    analyzeWishlist,
    getJobMatches,
    verifyEmail,
    addContactToJob,
} = require('../controllers/aiHubController');

router.post('/analyze-wishlist', authenticateToken, analyzeWishlist);
router.get('/jobs', authenticateToken, getJobMatches);
router.post('/verify-email', authenticateToken, verifyEmail);
router.post('/jobs/:jobId/contacts', authenticateToken, addContactToJob);

module.exports = router;
