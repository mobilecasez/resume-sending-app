// AI Hub — new feature. Safe to delete without affecting existing app.

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
    analyzeWishlist,
    getJobMatches,
    getJobStatus,
    getDashboard,
    removeDashboardItem,
    verifyEmail,
    addContactToJob,
    getCreditBalance,
    deductCredits,
    findRecruiters,
    getRecruiters,
    findRecruiterEmails,
    generateJobCoverLetter,
    saveJobCoverLetter,
    getJobCoverLetter,
    updateJobCoverLetterStatus,
    getJobStatuses,
    generateEmailBodyHandler,
} = require('../controllers/aiHubController');

router.get('/dashboard', authenticateToken, getDashboard);
router.delete('/dashboard/:jobId', authenticateToken, removeDashboardItem);
router.post('/analyze-wishlist', authenticateToken, analyzeWishlist);
router.get('/jobs', authenticateToken, getJobMatches);
router.get('/job-status/:jobId', authenticateToken, getJobStatus);
router.post('/verify-email', authenticateToken, verifyEmail);
router.post('/jobs/:jobId/contacts', authenticateToken, addContactToJob);
router.get('/credits', authenticateToken, getCreditBalance);
router.post('/deduct-credits', authenticateToken, deductCredits);

// ── Recruiter finder ──────────────────────────────────────────────────────────
router.get('/employers/:employerId/recruiters', authenticateToken, getRecruiters);
router.post('/employers/:employerId/find-recruiters', authenticateToken, findRecruiters);
router.post('/employers/:employerId/find-emails', authenticateToken, findRecruiterEmails);

// ── Email body generator ──────────────────────────────────────────────────────
router.post('/generate-email-body', authenticateToken, generateEmailBodyHandler);

// ── Cover letter for job ──────────────────────────────────────────────────────
router.post('/jobs/:jobId/generate-cover-letter',       authenticateToken, generateJobCoverLetter);
router.post('/jobs/:jobId/cover-letter',                authenticateToken, saveJobCoverLetter);
router.get( '/jobs/:jobId/cover-letter',                authenticateToken, getJobCoverLetter);
router.patch('/jobs/:jobId/cover-letter/status',        authenticateToken, updateJobCoverLetterStatus);
router.get( '/employers/:employerId/job-statuses',      authenticateToken, getJobStatuses);

module.exports = router;
