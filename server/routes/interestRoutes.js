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

// Dropdown data for the add-interest form: countries that actually have jobs (count-ordered),
// and per-country cities extracted from job locations — so users only pick places with supply.
router.get('/interests/meta', authenticateToken, async (req, res) => {
  try {
    const rows = await dbConfig.query(
      `SELECT country, COUNT(*)::int AS n FROM global_jobs
        WHERE is_active AND country IS NOT NULL AND country <> '' AND country <> 'Global'
        GROUP BY country ORDER BY n DESC LIMIT 120`);
    res.json({ success: true, countries: (rows || []).map((r) => ({ name: r.country, jobs: r.n })) });
  } catch (e) {
    res.status(500).json({ error: 'Could not load countries' });
  }
});

router.get('/interests/cities', authenticateToken, async (req, res) => {
  try {
    const country = String(req.query.country || '').trim();
    if (!country) return res.status(400).json({ error: 'country required' });
    // First comma-segment of the location is the city in the overwhelming majority of rows.
    // ⚠️ The segment filter must live in the inner WHERE — a HAVING on the ungrouped expression
    // made Postgres reject the whole query (this endpoint 500'd in build 132).
    const rows = await dbConfig.query(
      `SELECT city, COUNT(*)::int AS n FROM (
         SELECT INITCAP(TRIM(SPLIT_PART(location, ',', 1))) AS city
           FROM global_jobs
          WHERE is_active AND country = $1 AND location IS NOT NULL
            AND TRIM(SPLIT_PART(location, ',', 1)) <> ''
       ) t GROUP BY city ORDER BY n DESC LIMIT 40`, [country]);
    const cities = (rows || [])
      .map((r) => ({ name: r.city, jobs: r.n }))
      // drop junk segments that are clearly not cities (remote flags, country echoes)
      .filter((c) => c.name.length >= 2 && c.name.length <= 40 && !/remote|hybrid|anywhere|work from/i.test(c.name) && c.name.toLowerCase() !== country.toLowerCase());
    res.json({ success: true, cities });
  } catch (e) {
    res.status(500).json({ error: 'Could not load cities' });
  }
});

// Nothing saved yet → best-matched jobs from the directory, GROUPED BY COUNTRY, driven by the
// user's parsed résumé skills. Gives the Jobs tab a living first screen before any interest exists.
router.get('/interests/suggested', authenticateToken, async (req, res) => {
  try {
    const rm = await dbConfig.query(
      `SELECT skills, technical_skills, job_titles FROM resume_metadata
        WHERE user_id = $1 AND parse_status = 'done' ORDER BY id DESC LIMIT 1`, [req.user.id]);
    const row = rm && rm[0];
    if (!row) return res.json({ success: true, groups: [], noResume: true });
    const pick = (v) => { try { const a = Array.isArray(v) ? v : JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
    const skills = [...new Set([...pick(row.technical_skills), ...pick(row.skills), ...pick(row.job_titles)]
      .map((s) => String(s).trim().toLowerCase()).filter((s) => s.length >= 3))].slice(0, 6);
    if (!skills.length) return res.json({ success: true, groups: [], noResume: false });

    const likeAny = skills.map((_, i) => `(LOWER(skills::text) LIKE $${i + 1} OR LOWER(title) LIKE $${i + 1})`).join(' OR ');
    const params = skills.map((s) => `%${s}%`);
    // top countries for these skills, then a handful of freshest jobs per country
    const rows = await dbConfig.query(
      `WITH matched AS (
         SELECT id, job_url, title, employer_name, employer_domain, location, work_mode, job_type,
                salary, experience, responsibilities, skills, country, first_seen,
                ROW_NUMBER() OVER (PARTITION BY country ORDER BY first_seen DESC) AS rn,
                COUNT(*) OVER (PARTITION BY country) AS country_total
           FROM global_jobs
          WHERE is_active AND country IS NOT NULL AND country <> '' AND country <> 'Global' AND (${likeAny})
       )
       SELECT * FROM matched WHERE rn <= 4
       ORDER BY country_total DESC, country, rn
       LIMIT 40`, params);
    const groups = [];
    const byCountry = new Map();
    for (const r of rows || []) {
      if (!byCountry.has(r.country)) { byCountry.set(r.country, { country: r.country, total: r.country_total, jobs: [] }); groups.push(byCountry.get(r.country)); }
      const g = byCountry.get(r.country);
      const { rn, country_total, ...job } = r;
      g.jobs.push(job);
    }
    res.json({ success: true, skills, groups: groups.slice(0, 6) });
  } catch (e) {
    console.error('[interests] suggested:', e.message);
    res.status(500).json({ error: 'Could not load suggestions' });
  }
});

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
