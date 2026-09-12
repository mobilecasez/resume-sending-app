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
// Home's per-employer letters. The controller resolves its newer dependencies lazily, so this require
// cannot take the legacy letter routes above down with it.
const {
    employerLetterGate,
    buildEmployerLetter,
    employerLetterCards
} = require('../controllers/employerLetterController');

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

// Home employer letters (stored per employer in user_employer_documents).
// ⚠️ The gate is a DRY RUN (reserves, binds and charges nothing); only employer-build spends, and only
// after an explicit tap. employer-build runs through asJob so a minimised app keeps its paid build, and a
// repeated clientBuildId joins the SAME job instead of charging twice.
router.post('/cover-letter/employer-gate',  authenticateToken, employerLetterGate);
router.post('/cover-letter/employer-build', authenticateToken, asJob('cover_letter_employer')(buildEmployerLetter));
router.get('/cover-letter/employer-cards',  authenticateToken, employerLetterCards);

module.exports = router;
