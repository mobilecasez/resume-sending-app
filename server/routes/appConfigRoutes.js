// Public app config — ADDITIVE, no auth. Lets us flip runtime UI behaviour from a Railway env var
// without shipping a new build.
// - ALWAYS_SHOW_INTRO=1  → the first-run intro popup shows on EVERY launch (TestFlight testing).
// - ALWAYS_SHOW_GUIDE=1  → the helper's coach popups never go silent: even a fully-set-up account
//   is walked through find-a-job → cover letter → Auto Fill on the Jobs page (testing/demo).
// ⚠️ BOTH flags are GLOBAL (this endpoint has no auth) — they affect every user on a build that
//   understands them. Turn them OFF before promoting that build to production. Changing a flag
//   needs a `railway redeploy`; `variables --set` alone leaves the running process on the old env.
'use strict';
const express = require('express');
const router = express.Router();

const truthy = (v) => v === true || v === 1 || /^(1|true|yes|on)$/i.test(String(v || ''));

router.get('/app-config', (req, res) => {
  res.json({
    success: true,
    alwaysShowIntro: truthy(process.env.ALWAYS_SHOW_INTRO),
    alwaysShowGuide: truthy(process.env.ALWAYS_SHOW_GUIDE),
  });
});

module.exports = router;
