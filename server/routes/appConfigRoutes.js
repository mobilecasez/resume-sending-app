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

// GET /api/app-version-gate?platform=ios&build=160 → { action: 'block' | 'nudge' | 'ok', … }
// Public and unauthenticated on purpose: a blocked build must be told so BEFORE the user signs in,
// and an expired token must never be the reason someone escapes a hard block.
// ⚠️ Any failure answers 'ok'. A version check that 500s must not brick the app.
router.get('/app-version-gate', async (req, res) => {
  try {
    const gate = require('../services/versionGate');
    const out = await gate.evaluate({ platform: req.query.platform, build: req.query.build });
    res.json({ success: true, ...out });
  } catch (e) {
    console.warn('[versionGate] evaluate failed:', e.message);
    res.json({ success: true, action: 'ok' });
  }
});

// POST /api/push/opened  { nid, kind?, coldStart?, platform?, appVersion? }
//
// Public and unauthenticated ON PURPOSE: a notification tap very often happens on a cold start
// before the session is restored, and requiring auth would drop exactly the opens we most want to
// count. The nid is an unguessable UUID that we minted and only ever put in one payload, so it is
// its own capability — there is nothing to gain by posting a random one, and nothing sensitive is
// returned. Always answers 200 so a reporting failure can never break the app's launch path.
router.post('/push/opened', async (req, res) => {
  try {
    const b = req.body || {};
    const nid = String(b.nid || '').trim();
    // Cheap shape check so a malformed id never reaches the database as a failed cast.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nid)) {
      return res.json({ success: true, recorded: false });
    }
    const ok = await require('../services/pushLog').recordOpen({
      nid,
      userId: (req.user && req.user.id) || (Number(b.userId) || null),
      kind: b.kind, coldStart: b.coldStart, platform: b.platform, appVersion: b.appVersion,
    });
    res.json({ success: true, recorded: !!ok });
  } catch (e) {
    console.warn('[push/opened]', e.message);
    res.json({ success: true, recorded: false });
  }
});

module.exports = router;
