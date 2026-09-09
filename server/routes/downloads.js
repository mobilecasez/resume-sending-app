// What a download costs this user right now — read by the download button and by the
// purchase sheet after a pass is bought.
//
// Lives on its own path because BOTH the resume gallery and the cover-letter screen ask it; hanging
// it off /resume-builder would have made the letter screen call a resume endpoint.
const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');
const downloads = require('../services/downloads');

// GET /api/downloads/state?employer=Airbus
router.get('/state', authenticateToken, async (req, res) => {
  try {
    const employer = String(req.query.employer || '').trim() || null;
    const state = await downloads.downloadState(req.user.id, employer, req);
    return res.json({ success: true, ...state, productId: downloads.PASS_PRODUCT_ID });
  } catch (e) {
    console.error('[downloads] state failed:', e.message);
    // ⚠️ Fail CLOSED in the shape the button understands: an unreadable state must render the
    // locked button, never an unlocked one.
    return res.json({
      success: false, metered: downloads.METERED, paid: false, unlimited: false,
      remaining: 0, passes: 0, ownsEmployer: false, productId: downloads.PASS_PRODUCT_ID,
    });
  }
});

module.exports = router;
