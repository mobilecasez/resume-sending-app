const express = require('express');
const router = express.Router();
const { getFlag, upsertFlag, listFlags } = require('../controllers/featureFlagsController');

// Public — no auth (fail-open design: if backend is down, app shows the page normally)
router.get('/feature-flags',           listFlags);
router.get('/feature-flags/:pageKey',  getFlag);
router.put('/feature-flags/:pageKey',  upsertFlag);  // Protect with admin auth in production if needed

module.exports = router;
