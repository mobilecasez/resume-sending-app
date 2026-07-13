// Public app config — ADDITIVE, no auth. Lets us flip runtime UI behaviour from a Railway env var
// without shipping a new build. Currently: force the first-run intro/guide to ALWAYS show (for
// TestFlight testing) via ALWAYS_SHOW_INTRO=1.
'use strict';
const express = require('express');
const router = express.Router();

const truthy = (v) => v === true || v === 1 || /^(1|true|yes|on)$/i.test(String(v || ''));

router.get('/app-config', (req, res) => {
  res.json({
    success: true,
    alwaysShowIntro: truthy(process.env.ALWAYS_SHOW_INTRO),
  });
});

module.exports = router;
