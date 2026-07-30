// Location-based job interests — ADDITIVE. The redesigned Jobs tab: a card = place + skills.
// CRUD plus a per-interest jobs listing straight from the global_jobs directory.
'use strict';
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const dbConfig = require('../../db-config');

const parseSkills = (v) => {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))].slice(0, 8);
};

// List the caller's interests with a live job count for each card.
router.get('/interests', authenticateToken, async (req, res) => {
  try {
    const rows = await dbConfig.query(
      'SELECT id, label, country, city, skills, created_at FROM user_job_interests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [req.user.id]);
    const items = [];
    for (const r of rows || []) {
      let skills = [];
      try { skills = Array.isArray(r.skills) ? r.skills : JSON.parse(r.skills || '[]'); } catch {}
      const lowered = skills.map((s) => String(s).toLowerCase());
      let count = 0;
      if (lowered.length) {
        const likeAny = lowered.map((_, i) => `(LOWER(skills::text) LIKE $${i + 2} OR LOWER(title) LIKE $${i + 2})`).join(' OR ');
        const q = await dbConfig.query(
          `SELECT COUNT(*)::int AS n FROM global_jobs WHERE is_active AND country = $1 AND (${likeAny})`,
          [r.country, ...lowered.map((s) => `%${s}%`)]).catch(() => null);
        count = q && q[0] ? q[0].n : 0;
      }
      items.push({ id: r.id, label: r.label, country: r.country, city: r.city, skills, jobCount: count, createdAt: r.created_at });
    }
    res.json({ success: true, items });
  } catch (e) {
    console.error('[interests] list:', e.message);
    res.status(500).json({ error: 'Could not load interests' });
  }
});

router.post('/interests', authenticateToken, async (req, res) => {
  try {
    const b = req.body || {};
    const country = String(b.country || '').trim().slice(0, 78);
    const city = String(b.city || '').trim().slice(0, 120) || null;
    const skills = parseSkills(b.skills);
    if (!country) return res.status(400).json({ error: 'Country is required' });
    if (!skills.length) return res.status(400).json({ error: 'Add at least one skill or role' });
    const label = String(b.label || '').trim().slice(0, 140) || `${skills[0]} · ${city ? city + ', ' : ''}${country}`;
    const rows = await dbConfig.query(
      `INSERT INTO user_job_interests (user_id, label, country, city, skills)
       VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
      [req.user.id, label, country, city, JSON.stringify(skills)]);
    res.json({ success: true, id: rows && rows[0] ? rows[0].id : null });
  } catch (e) {
    console.error('[interests] create:', e.message);
    res.status(500).json({ error: 'Could not save the interest' });
  }
});

router.delete('/interests/:id', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    await dbConfig.query('DELETE FROM user_job_interests WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not remove the interest' });
  }
});

// Jobs for one interest card, straight from the directory. City matches float to the top.
router.get('/interests/:id/jobs', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const rows = await dbConfig.query(
      'SELECT country, city, skills FROM user_job_interests WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!rows || !rows.length) return res.status(404).json({ error: 'Interest not found' });
    const it = rows[0];
    let skills = [];
    try { skills = Array.isArray(it.skills) ? it.skills : JSON.parse(it.skills || '[]'); } catch {}
    const lowered = skills.map((s) => String(s).toLowerCase());
    if (!lowered.length) return res.json({ success: true, jobs: [], total: 0 });
    const likeAny = lowered.map((_, i) => `(LOWER(skills::text) LIKE $${i + 2} OR LOWER(title) LIKE $${i + 2})`).join(' OR ');
    const params = [it.country, ...lowered.map((s) => `%${s}%`)];
    const cityRank = it.city
      ? `CASE WHEN LOWER(location) LIKE $${params.length + 1} THEN 0 ELSE 1 END`
      : '1';
    if (it.city) params.push(`%${String(it.city).toLowerCase()}%`);
    const total = await dbConfig.query(
      `SELECT COUNT(*)::int AS n FROM global_jobs WHERE is_active AND country = $1 AND (${likeAny})`,
      params.slice(0, 1 + lowered.length));
    const jobs = await dbConfig.query(
      `SELECT id, job_url, title, employer_name, employer_domain, location, work_mode, job_type,
              salary, experience, responsibilities, skills, country, first_seen
         FROM global_jobs
        WHERE is_active AND country = $1 AND (${likeAny})
        ORDER BY ${cityRank}, first_seen DESC
        LIMIT ${limit} OFFSET ${offset}`, params);
    res.json({ success: true, total: total && total[0] ? total[0].n : 0, jobs: jobs || [] });
  } catch (e) {
    console.error('[interests] jobs:', e.message);
    res.status(500).json({ error: 'Could not load jobs for this interest' });
  }
});

module.exports = router;
