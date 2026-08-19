// Résumé score — ADDITIVE, ISOLATED. Safe to delete without affecting existing app.
// Read/acknowledge endpoints for the Home popup, plus the one that makes "Enhance for FREE" true.
'use strict';

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const scorer = require('../services/resumeScorer');
const quotaGrants = require('../services/quotaGrants');

// GET /api/resume-score — latest verdict + whether Home should interrupt with it.
router.get('/resume-score', authenticateToken, async (req, res) => {
  try { res.json(await scorer.latestFor(req.user.id)); }
  catch (e) { console.warn('[resumeScore] GET failed:', e.message); res.json({ hasScore: false, shouldPrompt: false }); }
});

// POST /api/resume-score/mark { scoreId, what: 'shown'|'dismissed'|'acted' }
// Analytics AND suppression: 'dismissed' is what stops the popup coming back for THIS résumé.
router.post('/resume-score/mark', authenticateToken, async (req, res) => {
  const { scoreId, what } = req.body || {};
  if (!scoreId || !['shown', 'dismissed', 'acted'].includes(what)) return res.status(400).json({ error: 'bad_request' });
  res.json({ ok: await scorer.mark(req.user.id, scoreId, what) });
});

// POST /api/resume-score/enhance-pass { scoreId }
// The button says "Enhance Your Résumé For FREE", so this makes that literally true: it grants ONE
// bonus résumé generation before sending the user into the builder. Without it the CTA would march
// them into a 402 — a promise the product breaks thirty seconds after making it.
//
// Idempotent on the score row, so tapping twice grants once. ⚠️ ensureCountableWindow FIRST:
// entitlements only counts a bonus inside an OPEN window, so granting to a user with no trial row
// (or an expired one) hands out quota that can never be spent — see quotaGrants for the incident.
router.post('/resume-score/enhance-pass', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { scoreId } = req.body || {};
  if (!scoreId) return res.status(400).json({ error: 'bad_request' });
  try {
    const idem = `resume_score_pass:${scoreId}`;
    const win = await quotaGrants.ensureCountableWindow(userId, idem);
    // No countable window (device already used its trial) — the user can still improve their
    // résumé, they just spend their own quota. Say so honestly instead of promising free.
    if (!win.via) {
      await scorer.mark(userId, scoreId, 'acted');
      return res.json({ ok: true, free: false, reason: win.blocked || 'no_window' });
    }
    const g = await quotaGrants.grantQuota(userId, 'resume', 1, idem, {
      source: 'resume_score', note: 'free résumé rewrite offered with the résumé score',
    });
    await scorer.mark(userId, scoreId, 'acted');
    res.json({ ok: true, free: true, granted: !!g.granted, already: !!g.already, via: win.via });
  } catch (e) {
    console.warn('[resumeScore] enhance-pass failed:', e.message);
    // Never block the hand-off to the builder on a grant failure.
    res.json({ ok: true, free: false, reason: 'grant_failed' });
  }
});

// GET /api/resume-score/source-text — the user's current résumé as editable prose.
// This is what makes "pull the résumé" literal: the builder opens with their real résumé already
// in the box, so the only thing left to do is ADD to it.
router.get('/resume-score/source-text', authenticateToken, async (req, res) => {
  try {
    const n = await scorer.narrativeFor(req.user.id);
    if (!n) return res.json({ hasText: false });
    res.json({ hasText: true, text: n.text, source: n.source });
  } catch (e) { res.json({ hasText: false }); }
});

// POST /api/resume-score/refresh — user-initiated re-score. Still obeys the admin switch and caps.
router.post('/resume-score/refresh', authenticateToken, async (req, res) => {
  try {
    const r = await scorer.scoreOne(req.user.id, { force: true });
    if (!r.ok) return res.status(r.reason === 'no_resume' ? 400 : 503).json({ error: r.reason });
    res.json(await scorer.latestFor(req.user.id));
  } catch (e) { res.status(500).json({ error: 'refresh_failed' }); }
});

module.exports = router;
