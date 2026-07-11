// Value-first job feed — ADDITIVE. Serves the isolated global_jobs firehose (Migration 023) as a
// browse-first feed so a freshly-registered user (no résumé yet) sees REAL jobs immediately, instead
// of a wall of setup. Read-only, no AI. Apply links go to the employer's own board.
'use strict';
const dbConfig = require('../../db-config');

async function discoverJobs(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
    const country = String(req.query.country || '').trim().slice(0, 40);
    const workMode = String(req.query.work_mode || '').trim().toLowerCase().slice(0, 20);
    const employer = String(req.query.employer || '').trim().slice(0, 120);

    const where = ['is_active'];
    const params = [];
    if (q) { where.push('(LOWER(title) LIKE ? OR LOWER(employer_name) LIKE ? OR LOWER(location) LIKE ?)'); params.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
    if (country) { where.push('country = ?'); params.push(country); }
    if (workMode) { where.push('LOWER(work_mode) = ?'); params.push(workMode); }
    if (employer) { where.push('employer_name = ?'); params.push(employer); }
    const whereSql = where.join(' AND ');

    const rows = await dbConfig.query(
      `SELECT job_url, title, employer_name, employer_domain, location, work_mode, job_type, salary, experience, responsibilities, skills, source, country, last_seen
         FROM global_jobs WHERE ${whereSql} ORDER BY last_seen DESC, id LIMIT ? OFFSET ?`,
      [...params, limit, offset]);
    const totalRow = await dbConfig.get(`SELECT COUNT(*)::int n FROM global_jobs WHERE ${whereSql}`, params).catch(() => null);
    const total = totalRow ? totalRow.n : (rows || []).length;

    const jobs = (rows || []).map((r) => ({
      id: r.job_url,                       // stable key for the client (also the apply URL)
      title: r.title,
      company: r.employer_name,
      employer_name: r.employer_name,
      employer_domain: r.employer_domain,
      location: r.location,
      work_mode: r.work_mode,
      job_type: r.job_type,
      salary: r.salary,
      experience: r.experience,
      responsibilities: Array.isArray(r.responsibilities) ? r.responsibilities : [],
      skills: Array.isArray(r.skills) ? r.skills : [],
      job_url: r.job_url,
      source: r.source,
      country: r.country,
    }));
    res.json({ success: true, jobs, total, offset, limit, hasMore: offset + jobs.length < total });
  } catch (e) {
    console.error('[discover] jobs error:', e.message);
    res.status(500).json({ error: 'Failed to load jobs' });
  }
}

// Filter chips for the feed UI: top employers, available countries + work modes, and the total.
async function discoverFacets(req, res) {
  try {
    const [total, employers, countries, workModes] = await Promise.all([
      dbConfig.get(`SELECT COUNT(*)::int n FROM global_jobs WHERE is_active`),
      dbConfig.query(`SELECT employer_name, COUNT(*)::int n FROM global_jobs WHERE is_active AND employer_name IS NOT NULL GROUP BY employer_name ORDER BY n DESC LIMIT 30`),
      dbConfig.query(`SELECT country, COUNT(*)::int n FROM global_jobs WHERE is_active AND country IS NOT NULL AND country <> '' GROUP BY country ORDER BY n DESC`),
      dbConfig.query(`SELECT work_mode, COUNT(*)::int n FROM global_jobs WHERE is_active AND work_mode IS NOT NULL GROUP BY work_mode ORDER BY n DESC`),
    ]);
    res.json({ success: true, total: total ? total.n : 0, employers: employers || [], countries: countries || [], workModes: workModes || [] });
  } catch (e) {
    console.error('[discover] facets error:', e.message);
    res.status(500).json({ error: 'Failed to load facets' });
  }
}

module.exports = { discoverJobs, discoverFacets };
