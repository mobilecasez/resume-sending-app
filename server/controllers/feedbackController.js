// In-app feedback — private feedback captured when a user gives a low rating (1–3★).
// Happy users (4–5★) are routed to the native store review instead (mobile side).
'use strict';

const dbConfig = require('../../db-config');

// POST /api/feedback — store a user's private feedback / rating.
async function submitFeedback(req, res) {
  try {
    const userId = req.user && req.user.id;
    const { rating, message, trigger, platform, appVersion } = req.body || {};
    const r = parseInt(rating, 10);
    await dbConfig.run(
      `INSERT INTO app_feedback (user_id, rating, message, trigger, platform, app_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [userId || null, isNaN(r) ? null : r, String(message || '').slice(0, 4000), trigger || null, platform || null, appVersion || null]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('submitFeedback error:', e.message);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
}

// GET /api/admin/feedback — admin: recent feedback (lowest ratings first).
async function listFeedback(req, res) {
  try {
    const rows = await dbConfig.query(
      `SELECT f.id, f.user_id, u.email, f.rating, f.message, f.trigger, f.platform, f.app_version, f.created_at
       FROM app_feedback f LEFT JOIN users u ON u.id = f.user_id
       ORDER BY f.created_at DESC LIMIT 300`
    );
    res.json({ feedback: rows || [] });
  } catch (e) {
    console.error('listFeedback error:', e.message);
    res.status(500).json({ error: 'Failed to load feedback' });
  }
}

module.exports = { submitFeedback, listFeedback };
