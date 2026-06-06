// Resume Builder — new feature. Safe to delete without affecting existing app.
const express    = require('express');
const router     = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { generateAI, saveResume, getResume, generatePDF, previewTemplates } = require('../controllers/resumeBuilderController');

router.get ('/',                  authenticateToken, getResume);
router.post('/generate-ai',       authenticateToken, generateAI);
router.post('/save',              authenticateToken, saveResume);
router.post('/generate-pdf',      authenticateToken, generatePDF);
router.post('/preview-templates', authenticateToken, previewTemplates);

module.exports = router;
