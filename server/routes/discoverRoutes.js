// Value-first job feed routes — ADDITIVE. Logged-in users browse the global_jobs firehose feed.
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const ctrl = require('../controllers/discoverController');

router.get('/discover/jobs', authenticateToken, ctrl.discoverJobs);
router.get('/discover/facets', authenticateToken, ctrl.discoverFacets);

module.exports = router;
