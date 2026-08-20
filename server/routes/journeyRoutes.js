// Activation journey — ADDITIVE. Safe to delete without affecting existing app.
'use strict';
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { journeyFor } = require('../services/journey');

// GET /api/journey — the five activation steps and which one to do next.
// Always 200: this drives a home-screen nudge, so "nothing to show" is the correct failure.
router.get('/journey', authenticateToken, async (req, res) => {
  try {
    const j = await journeyFor(req.user.id);
    res.json(j || { steps: [], nextKey: null, completed: 0, total: 5, pct: 0, complete: false });
  } catch (e) {
    console.warn('[journey] GET failed:', e.message);
    res.json({ steps: [], nextKey: null, completed: 0, total: 5, pct: 0, complete: false });
  }
});

module.exports = router;
