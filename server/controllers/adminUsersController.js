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

// GET /api/admin/users-list?q=&limit=&offset= — registered users with auth type, signup date, and
// usage (profile completion, cover letters, job searches, applications, replies). Paginated + search.
async function getUsersList(req, res) {
  const search = String(req.query.q || req.query.search || '').trim().toLowerCase().slice(0, 80);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const AUTH = `CASE WHEN u.oauth_provider='google' THEN 'Gmail' WHEN u.oauth_provider='microsoft' THEN 'Microsoft' WHEN u.oauth_provider='apple' THEN 'Apple' ELSE 'Email' END`;
  const has = (c) => `(u.${c} IS NOT NULL AND u.${c} <> '')`;
  try {
    const rows = await dbConfig.query(
      `SELECT u.id, u.email, u.full_name, u.oauth_provider,
              ${AUTH} AS auth_type,
              u.created_at AS registered_at,
              (${has('resume_path')}::int + ${has('photo_path')}::int + ${has('signature_path')}::int
               + ${has('phone_number')}::int + ${has('address')}::int + (u.date_of_birth IS NOT NULL)::int) AS profile_complete,
              ${has('resume_path')} AS has_resume, ${has('photo_path')} AS has_photo, ${has('signature_path')} AS has_signature,
              ((SELECT COUNT(*) FROM credit_usage_history c WHERE c.user_id=u.id AND c.action_type='cover_letter_generation')
               + (SELECT COUNT(*) FROM job_cover_letters j WHERE j.user_id=u.id))::int AS cover_letters,
              (SELECT COUNT(*) FROM async_jobs aj WHERE aj.user_id=u.id AND aj.type='ai_hub_job_search')::int AS job_searches,
              (SELECT COUNT(*) FROM application_history ah WHERE ah.user_id=u.id AND ah.deleted_at IS NULL)::int AS applications,
              (SELECT COUNT(*) FROM application_history ah WHERE ah.user_id=u.id AND ah.deleted_at IS NULL AND ah.reply_received=1)::int AS replies,
              COALESCE(uc.credits_remaining,0)::int AS credits
         FROM users u
         LEFT JOIN user_credits uc ON uc.user_id=u.id
        WHERE u.deleted_at IS NULL
          AND (? = '' OR LOWER(u.email) LIKE '%'||?||'%' OR LOWER(u.full_name) LIKE '%'||?||'%')
        ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      [search, search, search, limit, offset]).catch((e) => { throw e; });

    const totalRow = await dbConfig.get(
      `SELECT COUNT(*)::int n FROM users u WHERE u.deleted_at IS NULL
         AND (? = '' OR LOWER(u.email) LIKE '%'||?||'%' OR LOWER(u.full_name) LIKE '%'||?||'%')`,
      [search, search, search]).catch(() => ({ n: (rows || []).length }));

    const byProvider = await dbConfig.query(
      `SELECT ${AUTH} AS auth_type, COUNT(*)::int n
         FROM users u WHERE u.deleted_at IS NULL GROUP BY 1 ORDER BY n DESC`).catch(() => []);

    res.json({ success: true, users: rows || [], total: totalRow ? totalRow.n : (rows || []).length, offset, limit, byProvider });
  } catch (e) {
    console.error('getUsersList error:', e.message);
    res.status(500).json({ error: 'Failed to load users' });
  }
}

module.exports = { searchUsers, getUserCredits, setUserCredits, getUsersList };
