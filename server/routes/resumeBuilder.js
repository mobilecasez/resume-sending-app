// Resume Builder — new feature. Safe to delete without affecting existing app.
const express    = require('express');
const router     = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { asJob } = require('../middleware/asyncJob');   // opt-in minimize-resilient job wrapper
const { generateAI, saveResume, getResume, generatePDF, generateDocx, previewTemplates } = require('../controllers/resumeBuilderController');

router.get ('/',                  authenticateToken, getResume);
router.post('/generate-ai',       authenticateToken, asJob('resume_generate_ai')(generateAI));
router.post('/save',              authenticateToken, saveResume);
router.post('/generate-pdf',      authenticateToken, generatePDF);
router.post('/generate-docx',     authenticateToken, generateDocx);
router.post('/preview-templates', authenticateToken, asJob('resume_preview')(previewTemplates));

module.exports = router;
