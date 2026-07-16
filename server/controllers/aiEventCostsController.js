// AI Event Credits — admin reads/edits per-event credit costs; app reads the public map.
'use strict';

const dbConfig = require('../../db-config');
const eventCosts = require('../services/eventCosts');

// GET /api/admin/ai-event-costs — full catalog for the admin page
async function getAllEvents(req, res) {
  try {
    const rows = await dbConfig.query(
      `SELECT id, event_key, label, description, category, direction, credits, is_active, sort_order, updated_at
       FROM ai_event_costs ORDER BY sort_order ASC, id ASC`
    );
    res.json({ events: rows || [] });
  } catch (e) {
    console.error('getAllEvents error:', e.message);
    res.status(500).json({ error: 'Failed to load AI event costs' });
  }
}

// PUT /api/admin/ai-event-costs/:eventKey — change the credits and/or active flag
async function updateEvent(req, res) {
  const { eventKey } = req.params;
  let { credits, is_active } = req.body;
  credits = parseInt(credits, 10);
  if (isNaN(credits) || credits < 0 || credits > 1000) {
    return res.status(400).json({ error: 'Credits must be a whole number between 0 and 1000.' });
  }
  const active = (is_active === undefined || is_active === null) ? null : (is_active ? 1 : 0);
  try {
    const row = await dbConfig.get('SELECT id FROM ai_event_costs WHERE event_key = ?', [eventKey]);
    if (!row) return res.status(404).json({ error: 'Unknown event' });
    if (active === null) {
      await dbConfig.run('UPDATE ai_event_costs SET credits = ?, updated_at = CURRENT_TIMESTAMP WHERE event_key = ?', [credits, eventKey]);
    } else {
      await dbConfig.run('UPDATE ai_event_costs SET credits = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE event_key = ?', [credits, active, eventKey]);
    }
    eventCosts.invalidate();
    res.json({ success: true, message: 'AI event cost updated' });
  } catch (e) {
    console.error('updateEvent error:', e.message);
    res.status(500).json({ error: 'Failed to update AI event cost' });
  }
}

// GET /api/ai-event-costs — public { event_key: credits } map for in-app cost labels
async function getPublicCosts(req, res) {
  try {
    const costs = await eventCosts.getPublicCosts();
    res.json({ costs });
  } catch (e) {
    res.json({ costs: {} });
  }
}

module.exports = { getAllEvents, updateEvent, getPublicCosts };
