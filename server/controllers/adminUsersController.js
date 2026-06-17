// Admin user-credit management — search a user by email, view + set their credits.
'use strict';

const dbConfig = require('../../db-config');

// GET /api/admin/users/search?q=<email substring> — typeahead for the admin UI.
async function searchUsers(req, res) {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json({ users: [] });
  try {
    const rows = await dbConfig.query(
      `SELECT u.id, u.email, u.full_name,
              COALESCE(uc.credits_remaining, 0) AS credits_remaining
       FROM users u
       LEFT JOIN user_credits uc ON uc.user_id = u.id
       WHERE LOWER(u.email) LIKE ? AND u.deleted_at IS NULL
       ORDER BY u.email ASC
       LIMIT 12`,
      [`%${q}%`]
    );
    res.json({ users: rows || [] });
  } catch (e) {
    console.error('searchUsers error:', e.message);
    res.status(500).json({ error: 'Search failed' });
  }
}

// GET /api/admin/users/:id/credits — fresh name + balance for a selected user.
async function getUserCredits(req, res) {
  const id = parseInt(req.params.id, 10);
  try {
    const u = await dbConfig.get(
      `SELECT u.id, u.email, u.full_name,
              COALESCE(uc.credits_remaining, 0) AS credits_remaining,
              COALESCE(uc.credits_total, 0) AS credits_total
       FROM users u LEFT JOIN user_credits uc ON uc.user_id = u.id
       WHERE u.id = ?`, [id]);
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json({ user: u });
  } catch (e) {
    console.error('getUserCredits error:', e.message);
    res.status(500).json({ error: 'Failed to load user' });
  }
}

// PUT /api/admin/users/:id/credits  { credits } — set the user's remaining credits.
async function setUserCredits(req, res) {
  const id = parseInt(req.params.id, 10);
  let { credits } = req.body;
  credits = parseInt(credits, 10);
  if (isNaN(credits) || credits < 0 || credits > 1000000) {
    return res.status(400).json({ error: 'Credits must be a whole number between 0 and 1,000,000.' });
  }
  try {
    const u = await dbConfig.get('SELECT id FROM users WHERE id = ?', [id]);
    if (!u) return res.status(404).json({ error: 'User not found' });

    const existing = await dbConfig.get('SELECT user_id FROM user_credits WHERE user_id = ?', [id]);
    if (existing) {
      // Keep credits_total ≥ remaining so usage bars never exceed 100%.
      await dbConfig.run(
        'UPDATE user_credits SET credits_remaining = ?, credits_total = GREATEST(credits_total, ?), updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
        [credits, credits, id]);
    } else {
      await dbConfig.run(
        'INSERT INTO user_credits (user_id, credits_remaining, credits_total) VALUES (?, ?, ?)',
        [id, credits, credits]);
    }
    // Audit trail (best-effort).
    try {
      await dbConfig.run(
        `INSERT INTO credit_transactions (user_id, credits_used, action_type, metadata, created_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [id, 0, 'admin_adjustment', JSON.stringify({ by: req.user?.id, setTo: credits })]);
    } catch (e) { /* best-effort */ }

    res.json({ success: true, credits_remaining: credits });
  } catch (e) {
    console.error('setUserCredits error:', e.message);
    res.status(500).json({ error: 'Failed to update credits' });
  }
}

module.exports = { searchUsers, getUserCredits, setUserCredits };
