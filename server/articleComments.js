// First-party article comments for the /articles blog.
// Public: list approved + submit (auto-publish with anti-spam). Admin: moderate/delete.
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db-config');
const { authenticateAdmin } = require('./middleware/auth');

const router = express.Router();

// Create the table on boot (idempotent) — safest for prod where migrations may not auto-run.
async function ensureTable() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS article_comments (
      id          BIGSERIAL PRIMARY KEY,
      slug        VARCHAR(160) NOT NULL,
      name        VARCHAR(80)  NOT NULL,
      email       VARCHAR(160) NOT NULL,
      body        TEXT         NOT NULL,
      status      VARCHAR(16)  NOT NULL DEFAULT 'approved',
      parent_id   BIGINT,
      ip          VARCHAR(64),
      user_agent  TEXT,
      created_at  TIMESTAMP    NOT NULL DEFAULT NOW()
    )
  `);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_article_comments_lookup ON article_comments(slug, status, created_at)`);
}

const clean = (s) => String(s == null ? '' : s).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const cleanSlug = (s) => String(s == null ? '' : s).replace(/[^a-z0-9-]/gi, '').slice(0, 160);

// auto-publish unless it looks like spam → then hold as 'pending'
function classify(name, body) {
  const links = (body.match(/https?:\/\//gi) || []).length;
  const spammy = /(viagra|cialis|casino|porn|payday|backlink|seo service|crypto giveaway|btc doubl|telegram\.me|join my)/i.test(body + ' ' + name);
  if (links >= 2 || spammy || body.length < 2) return 'pending';
  return 'approved';
}

const clientIp = (req) => ((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '').slice(0, 64);

const postLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 6, // max 6 comments / 10 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => clientIp(req) || 'unknown',
  message: { error: 'You are commenting too fast — please try again in a few minutes.' },
});

// GET /api/article-comments?slug=...  → approved comments for an article (public)
router.get('/', async (req, res) => {
  try {
    const slug = cleanSlug(req.query.slug);
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const rows = await db.query(
      `SELECT id, name, body, parent_id, created_at FROM article_comments
       WHERE slug = ? AND status = 'approved' ORDER BY created_at ASC LIMIT 500`,
      [slug]
    );
    res.set('Cache-Control', 'no-store');
    res.json({ comments: rows, count: rows.length });
  } catch (e) {
    console.error('[comments] list error:', e.message);
    res.status(500).json({ error: 'Could not load comments.' });
  }
});

// POST /api/article-comments  → submit a comment (public, rate-limited, anti-spam)
router.post('/', postLimiter, async (req, res) => {
  try {
    const { slug, name, email, body, parent_id, website } = req.body || {};
    if (website) return res.json({ ok: true, held: true }); // honeypot tripped → silently drop

    const s = cleanSlug(slug);
    const nm = clean(name).slice(0, 80);
    const em = String(email || '').trim().slice(0, 160);
    const bd = clean(body).slice(0, 2000);
    if (!s) return res.status(400).json({ error: 'Missing article.' });
    if (!nm) return res.status(400).json({ error: 'Please add your name.' });
    if (!isEmail(em)) return res.status(400).json({ error: 'Please enter a valid email.' });
    if (bd.length < 2) return res.status(400).json({ error: 'Please write a comment.' });

    let pid = parseInt(parent_id, 10);
    if (!Number.isInteger(pid) || pid <= 0) pid = null;

    const status = classify(nm, bd);
    const r = await db.run(
      `INSERT INTO article_comments (slug, name, email, body, status, parent_id, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [s, nm, em, bd, status, pid, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300)]
    );

    res.json({
      ok: true,
      held: status !== 'approved',
      comment: status === 'approved'
        ? { id: r.lastID, name: nm, body: bd, parent_id: pid, created_at: new Date().toISOString() }
        : null,
    });
  } catch (e) {
    console.error('[comments] post error:', e.message);
    res.status(500).json({ error: 'Could not post your comment.' });
  }
});

// ---- Admin moderation ----
router.get('/admin/all', authenticateAdmin, async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT id, slug, name, email, body, status, parent_id, created_at
       FROM article_comments ORDER BY created_at DESC LIMIT 1000`
    );
    res.json({ comments: rows });
  } catch (e) {
    res.status(500).json({ error: 'Could not load comments.' });
  }
});

router.post('/admin/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const status = String((req.body || {}).status || '');
    if (!['approved', 'pending', 'spam', 'deleted'].includes(status)) return res.status(400).json({ error: 'bad status' });
    await db.run(`UPDATE article_comments SET status = ? WHERE id = ?`, [status, id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Update failed.' });
  }
});

router.delete('/admin/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await db.run(`UPDATE article_comments SET status = 'deleted' WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed.' });
  }
});

module.exports = { router, ensureTable };
