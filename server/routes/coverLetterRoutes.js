const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
    generateCoverLetters,
    generateCoverLetterDetails,
    generateCoverLetterPdf
} = require('../controllers/coverLetterController');

// Generate cover letters (bulk)
router.post('/generate-cover-letter', authenticateToken, generateCoverLetters);

// Generate cover letter details (for review page)
router.post('/generate-cover-letter-details', authenticateToken, generateCoverLetterDetails);

// Generate cover letter PDF for download
router.post('/generate-cover-letter-pdf', authenticateToken, generateCoverLetterPdf);

module.exports = router;
