const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { asJob } = require('../middleware/asyncJob');   // opt-in minimize-resilient job wrapper
const {
    generateCoverLetters,
    generateCoverLetterDetails,
    generateCoverLetterPdf,
    previewCoverLetterTemplates,
    generateCoverLetterTemplatePdf,
    generateCoverLetterTemplateDocx
} = require('../controllers/coverLetterController');

// Generate cover letters (bulk)
router.post('/generate-cover-letter', authenticateToken, generateCoverLetters);

// Generate cover letter details (for review page)
router.post('/generate-cover-letter-details', authenticateToken, generateCoverLetterDetails);

// Generate cover letter PDF for download
router.post('/generate-cover-letter-pdf', authenticateToken, generateCoverLetterPdf);

// Country-format templates: free previews + credited template download
router.post('/cover-letter/preview-templates',    authenticateToken, asJob('cl_preview')(previewCoverLetterTemplates));
router.post('/cover-letter/generate-template-pdf', authenticateToken, generateCoverLetterTemplatePdf);
router.post('/cover-letter/generate-template-docx', authenticateToken, generateCoverLetterTemplateDocx);

module.exports = router;
