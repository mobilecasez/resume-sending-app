const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const { getFlag, upsertFlag, listFlags } = require('../controllers/featureFlagsController');

// Reads are public — the mobile app fetches its page flag unauthenticated
// (fail-open design: if backend is down, app shows the page normally).
router.get('/feature-flags',           listFlags);
router.get('/feature-flags/:pageKey',  getFlag);

// Writes are admin-only: an open PUT let anyone disable app pages or inject
// title/message text that the app renders verbatim in its overlay.
router.put('/feature-flags/:pageKey',  authenticateAdmin, upsertFlag);

module.exports = router;
