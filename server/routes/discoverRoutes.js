// Value-first job feed routes — ADDITIVE. Logged-in users browse the global_jobs firehose feed.
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const ctrl = require('../controllers/discoverController');

router.get('/discover/jobs', authenticateToken, ctrl.discoverJobs);
router.get('/discover/facets', authenticateToken, ctrl.discoverFacets);
router.post('/discover/ai-search', authenticateToken, ctrl.aiSearch);
router.post('/discover/hydrate-urls', authenticateToken, ctrl.hydrateUrls);
router.post('/discover/live-search', authenticateToken, ctrl.liveSearch);   // "Look for live jobs on Google" → app-style cards
router.post('/discover/fetch-detail', authenticateToken, ctrl.fetchDetail); // on-device page HTML → full job + store

module.exports = router;
