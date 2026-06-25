// AI Hub — new feature. Safe to delete without affecting existing app.

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { asJob } = require('../middleware/asyncJob');   // opt-in minimize-resilient job wrapper
const {
    analyzeWishlist,
    getJobMatches,
    getJobStatus,
    getDashboard,
    removeDashboardItem,
    verifyEmail,
    addContactToJob,
    getJobContacts,
    getJobUrlOverride,
    setJobUrlOverride,
    autofillMap,
    autofillFiles,
    recordAutofillMemory,
    smartFillData,
    getCreditBalance,
    deductCredits,
    findRecruiters,
    getRecruiters,
    findRecruiterEmails,
    generateJobCoverLetter,
    translateJob,
    translateBatch,
    saveJobCoverLetter,
    getJobCoverLetter,
    updateJobCoverLetterStatus,
    getJobStatuses,
    generateEmailBodyHandler,
    getMatchScores,
    getMotivation,
} = require('../controllers/aiHubController');

router.get('/dashboard', authenticateToken, getDashboard);
router.delete('/dashboard/:jobId', authenticateToken, removeDashboardItem);
router.post('/analyze-wishlist', authenticateToken, analyzeWishlist);
router.get('/jobs', authenticateToken, getJobMatches);
router.get('/job-status/:jobId', authenticateToken, getJobStatus);
router.post('/match-scores', authenticateToken, getMatchScores);
router.get('/motivation', authenticateToken, getMotivation);
router.post('/verify-email', authenticateToken, verifyEmail);
router.post('/jobs/:jobId/contacts', authenticateToken, addContactToJob);
router.get('/jobs/:jobId/contacts', authenticateToken, getJobContacts);
router.get('/jobs/:jobId/url-override', authenticateToken, getJobUrlOverride);
router.post('/jobs/:jobId/url-override', authenticateToken, setJobUrlOverride);
router.post('/autofill-map', authenticateToken, asJob('autofill_map')(autofillMap));
router.post('/autofill-files', authenticateToken, asJob('autofill_files')(autofillFiles));
router.post('/autofill-memory', authenticateToken, recordAutofillMemory);   // self-learning: remember manual answers
router.get('/smart-fill-data', authenticateToken, smartFillData);           // bundle for the in-WebView smart-copy popup
router.get('/credits', authenticateToken, getCreditBalance);
router.post('/deduct-credits', authenticateToken, deductCredits);

// ── Recruiter finder ──────────────────────────────────────────────────────────
router.get('/employers/:employerId/recruiters', authenticateToken, getRecruiters);
router.post('/employers/:employerId/find-recruiters', authenticateToken, asJob('find_recruiters')(findRecruiters));
router.post('/employers/:employerId/find-emails', authenticateToken, asJob('find_emails')(findRecruiterEmails));

// ── Email body generator ──────────────────────────────────────────────────────
router.post('/generate-email-body', authenticateToken, asJob('email_body')(generateEmailBodyHandler));

// ── Cover letter for job ──────────────────────────────────────────────────────
router.post('/jobs/:jobId/generate-cover-letter',       authenticateToken, generateJobCoverLetter);
router.post('/jobs/:jobId/translate',                   authenticateToken, translateJob);
router.post('/translate-batch',                         authenticateToken, translateBatch);   // in-page (WebView) bridge translator
router.post('/jobs/:jobId/cover-letter',                authenticateToken, saveJobCoverLetter);
router.get( '/jobs/:jobId/cover-letter',                authenticateToken, getJobCoverLetter);
router.patch('/jobs/:jobId/cover-letter/status',        authenticateToken, updateJobCoverLetterStatus);
router.get( '/employers/:employerId/job-statuses',      authenticateToken, getJobStatuses);

module.exports = router;
