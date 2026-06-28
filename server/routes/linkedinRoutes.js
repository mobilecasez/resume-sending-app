// LinkedIn extraction routes — separate from the main pipeline. Mounted under /api.
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const ctrl = require('../controllers/linkedinController');

router.post('/ai-hub/linkedin/extract', authenticateToken, ctrl.extractLinkedInJob); // hidden-WebView text → AI JSON + store
router.post('/ai-hub/linkedin/add', authenticateToken, ctrl.addLinkedInJob);         // extract AND add to the user's Job Hub
router.get('/ai-hub/linkedin/job', authenticateToken, ctrl.getLinkedInJobByUrl);     // stored job + raw text (cover-letter reuse)

module.exports = router;
