// Admin-only controls for the global job firehose — ADDITIVE. Trigger a run + inspect what's stored.
const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const firehose = require('../services/globalJobFirehose');
const dbConfig = require('../../db-config');

// Kick off a firehose pass in the BACKGROUND (a full run takes minutes) and return immediately.
// ?limit=N to only crawl the first N sources (handy for a quick test).
router.post('/admin/global-jobs/run', authenticateAdmin, async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || undefined;
  firehose.runFirehose({ limit }).catch((e) => console.error('[firehose] run error:', e.message));
  res.json({ success: true, started: true, sources: limit || firehose.SOURCES.length });
});

// Sweep the Swiss Job-Room (official SECO public-employment-service) national feed into global_jobs.
// ?pages=N (default 25, max 60) · ?since=D days (default 30) · ?keywords=a,b (default all professions).
router.post('/admin/global-jobs/run-jobroom', authenticateAdmin, async (req, res) => {
  try {
    const maxPages = Math.min(parseInt(req.query.pages, 10) || 25, 60);
    const onlineSince = Math.min(parseInt(req.query.since, 10) || 30, 90);
    const keywords = req.query.keywords ? String(req.query.keywords).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const result = await firehose.ingestJobRoom({ keywords, maxPages, onlineSince });
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: 'jobroom ingest failed', detail: String(e.message).slice(0, 200) }); }
});

// What's in the global feed right now.
router.get('/admin/global-jobs/stats', authenticateAdmin, async (req, res) => {
  try {
    const [total, active, recent, sched, byEmployer, bySource] = await Promise.all([
      dbConfig.get(`SELECT COUNT(*)::int n FROM global_jobs`),
      dbConfig.get(`SELECT COUNT(*)::int n FROM global_jobs WHERE is_active`),
      dbConfig.get(`SELECT MAX(last_seen) AS last FROM global_jobs`),
      dbConfig.get(`SELECT last_run_at, last_summary FROM system_schedule WHERE job_key='global_job_firehose'`),
      dbConfig.query(`SELECT employer_name, COUNT(*)::int n FROM global_jobs GROUP BY employer_name ORDER BY n DESC LIMIT 25`),
      dbConfig.query(`SELECT source, COUNT(*)::int n FROM global_jobs GROUP BY source ORDER BY n DESC`),
    ]);
    let lastSummary = null; try { lastSummary = sched && sched.last_summary ? JSON.parse(sched.last_summary) : null; } catch {}
    res.json({
      success: true,
      total: total ? total.n : 0,
      active: active ? active.n : 0,
      lastSeen: recent ? recent.last : null,
      lastRunAt: sched ? sched.last_run_at : null,
      lastSummary,
      byEmployer: byEmployer || [],
      bySource: bySource || [],
    });
  } catch (e) { res.status(500).json({ error: 'Failed to load global-jobs stats' }); }
});

// A peek at the newest stored jobs (to eyeball quality — "looks as good as cvapplyr").
router.get('/admin/global-jobs/sample', authenticateAdmin, async (req, res) => {
  try {
    const rows = await dbConfig.query(
      `SELECT title, employer_name, location, work_mode, job_type, salary, job_url, responsibilities, skills
         FROM global_jobs ORDER BY last_seen DESC LIMIT 20`);
    res.json({ success: true, jobs: rows || [] });
  } catch (e) { res.status(500).json({ error: 'Failed to load sample' }); }
});

module.exports = router;
