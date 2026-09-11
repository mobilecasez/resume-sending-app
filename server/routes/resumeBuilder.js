// Resume Builder — new feature. Safe to delete without affecting existing app.
const express    = require('express');
const router     = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { asJob } = require('../middleware/asyncJob');   // opt-in minimize-resilient job wrapper
const { generateAI, generationGate, saveResume, getResume, generatePDF, generateDocx, previewTemplates, listTemplates, homeThumb, homeCards } = require('../controllers/resumeBuilderController');

router.get ('/',                  authenticateToken, getResume);
router.get ('/templates',         authenticateToken, listTemplates);
router.get ('/home-thumb',        authenticateToken, homeThumb);
router.get ('/home-cards',        authenticateToken, homeCards);
router.post('/generate-ai',       authenticateToken, asJob('resume_generate_ai')(generateAI));
// A dry run of generate-ai's money decision — consumes, reserves and binds nothing (see generationGate).
// POST, not GET: it takes the job fields the cache fingerprint is computed over.
router.post('/generation-gate',   authenticateToken, generationGate);
router.post('/save',              authenticateToken, saveResume);
router.post('/generate-pdf',      authenticateToken, generatePDF);
router.post('/generate-docx',     authenticateToken, generateDocx);
router.post('/preview-templates', authenticateToken, asJob('resume_preview')(previewTemplates));

module.exports = router;
