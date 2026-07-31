// Admin "Routines" — ADDITIVE. One place to SEE every background routine the server runs
// (the system_schedule table has always recorded them, but nothing ever displayed it) and to
// force-run any of them on demand. GET lists the registry merged with live last-run data;
// POST /run/:key fires a run in the background and returns immediately.
'use strict';
const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const dbConfig = require('../../db-config');

// The registry: every scheduled routine, its cadence, and how to force-run it. `run` returns a
// promise; long runs are fired in the background by the POST handler (never awaited there).
const ROUTINES = [
  {
    key: 'demand_research', name: 'Demand Research', icon: '🎯', intervalHours: 12,
    description: 'Walks every user’s saved job interests (place + skills), researches the live web for matching postings via grounded AI, stores them in global_jobs, and pushes “New matching jobs for you” to the users they fit.',
    run: () => require('../services/demandResearch').runDemandResearch(),
  },
  {
    key: 'global_job_firehose', name: 'Global Job Firehose', icon: '🌊', intervalHours: 24,
    description: 'Crawls 1,200+ verified career boards and national feeds worldwide and refreshes the global_jobs directory that powers Search and the Jobs tab.',
    run: () => require('../services/globalJobFirehose').runFirehose({}),
  },
  {
    key: 'reply_poll', name: 'Reply Poller', icon: '📬', intervalHours: 0.5,
    description: 'Checks connected Outlook inboxes for replies to sent applications and pushes “you got a reply” notifications.',
    run: () => require('../services/replyPoller').runReplyPoll({ force: true }),
  },
  {
    key: 'daily_reminders', name: 'Daily Reminders', icon: '⏰', intervalHours: 24,
    description: 'Follow-up nudges: applications waiting on a follow-up, expiring jobs, and low-credit warnings.',
    run: () => require('../services/engagementScheduler').runDailyReminders({ force: true }),
  },
  {
    key: 'weekly_digest', name: 'Weekly Digest', icon: '🗞️', intervalHours: 168,
    description: 'The weekly summary push: activity recap and fresh matching jobs.',
    run: () => require('../services/engagementScheduler').runWeeklyDigest({ force: true }),
  },
  {
    key: 'employer_fix_queue', name: 'Employer Fix Queue', icon: '🛠️', intervalHours: 24,
    description: 'Runs the automated diagnostic agent over user-submitted “this employer’s jobs look wrong” requests and applies verified per-domain fixes.',
    run: () => require('../services/fixQueueRunner').runFixQueue(),
  },
];

// In-flight tracker so the page can show "running…" and a double-tap can't start a second run.
const _runningSince = new Map();   // key -> ISO string

router.get('/admin/routines', authenticateAdmin, async (req, res) => {
  try {
    const rows = await dbConfig.query('SELECT job_key, last_run_at, last_summary FROM system_schedule').catch(() => []);
    const byKey = new Map((rows || []).map((r) => [r.job_key, r]));
    const items = ROUTINES.map((r) => {
      const row = byKey.get(r.key);
      const lastRunAt = row ? row.last_run_at : null;
      let nextRunAt = null;
      if (lastRunAt && r.intervalHours >= 1) {
        nextRunAt = new Date(new Date(lastRunAt).getTime() + r.intervalHours * 3600 * 1000).toISOString();
      }
      return {
        key: r.key, name: r.name, icon: r.icon, description: r.description,
        intervalHours: r.intervalHours,
        cadence: r.intervalHours >= 168 ? 'Weekly' : r.intervalHours >= 24 ? 'Daily' : r.intervalHours >= 1 ? `Every ${r.intervalHours} hours` : `Every ${Math.round(r.intervalHours * 60)} min`,
        lastRunAt,
        lastSummary: row ? row.last_summary : null,
        nextRunAt,
        running: _runningSince.has(r.key) ? _runningSince.get(r.key) : null,
      };
    });
    res.json({ success: true, routines: items });
  } catch (e) {
    console.error('[routines] list:', e.message);
    res.status(500).json({ error: 'Could not load routines' });
  }
});

// Feed discovered posting URLs straight into global_jobs — the Claude-side demand-research
// routine finds URLs with its own web search and hands them here so extraction runs on the
// server (prod Gemini key, saveJobs upsert). Sequential + capped: this is a trickle, not a bulk.
router.post('/admin/routines/ingest-urls', authenticateAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const urls = (Array.isArray(b.urls) ? b.urls : [])
      .map((u) => String(u || '').trim())
      .filter((u) => /^https?:\/\/\S+$/i.test(u) && u.length <= 500)
      .filter((u) => !/linkedin\.com|indeed\.|glassdoor\.|google\.com\/search/i.test(u))
      .slice(0, 40);
    if (!urls.length) return res.status(400).json({ error: 'No usable URLs (http/https, no aggregators, max 40)' });
    const cluster = { country: String(b.country || '').trim().slice(0, 78) || null, city: String(b.city || '').trim().slice(0, 120) || null };
    const { ingestUrl } = require('../services/demandResearch');
    const results = [];
    let saved = 0;
    for (const url of urls) {
      const n = await ingestUrl(url, cluster, String(b.source || 'demand_research').slice(0, 55)).catch(() => 0);
      saved += n;
      results.push({ url, saved: n > 0 });
    }
    res.json({ success: true, requested: urls.length, saved, results });
  } catch (e) {
    console.error('[routines] ingest-urls:', e.message);
    res.status(500).json({ error: 'Ingest failed' });
  }
});

// Match-and-push sweep for freshly added jobs: interest matches + résumé matches. The Claude-side
// routine calls this after ingesting so users actually hear "6 new plumbing jobs in Canada".
router.post('/admin/routines/notify-matches', authenticateAdmin, async (req, res) => {
  try {
    const hours = Math.min(Math.max(parseFloat((req.body || {}).sinceHours) || 24, 0.5), 72);
    const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const dr = require('../services/demandResearch');
    const interestPushes = await dr.notifyMatchedUsers(sinceIso).catch(() => 0);
    const resumePushes = await dr.notifyResumeMatchedUsers(sinceIso).catch(() => 0);
    res.json({ success: true, sinceHours: hours, interestPushes, resumePushes });
  } catch (e) {
    console.error('[routines] notify-matches:', e.message);
    res.status(500).json({ error: 'Notify sweep failed' });
  }
});

// ── User-facing push switches: what automated pushes users receive, admin on/off ──
router.get('/admin/user-notification-switches', authenticateAdmin, async (req, res) => {
  try {
    const notifSwitch = require('../services/notifSwitch');
    const enabled = await notifSwitch.getAll();
    const items = [];
    for (const s of notifSwitch.SWITCHES) {
      const counts = await dbConfig.query(
        `SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS d1,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS d7
           FROM notifications WHERE type = ANY($1)`, [s.types]).catch(() => null);
      items.push({
        key: s.key, label: s.label, icon: s.icon, description: s.description,
        enabled: enabled[s.key] !== false,
        sent24h: counts && counts[0] ? counts[0].d1 : 0,
        sent7d: counts && counts[0] ? counts[0].d7 : 0,
      });
    }
    res.json({ success: true, switches: items });
  } catch (e) {
    console.error('[routines] switches:', e.message);
    res.status(500).json({ error: 'Could not load switches' });
  }
});

router.put('/admin/user-notification-switches/:key', authenticateAdmin, async (req, res) => {
  try {
    const notifSwitch = require('../services/notifSwitch');
    const on = await notifSwitch.set(req.params.key, !!(req.body || {}).enabled);
    res.json({ success: true, key: req.params.key, enabled: on });
  } catch (e) {
    res.status(400).json({ error: String(e.message) });
  }
});

router.post('/admin/routines/run/:key', authenticateAdmin, async (req, res) => {
  const r = ROUTINES.find((x) => x.key === req.params.key);
  if (!r) return res.status(400).json({ error: 'Unknown routine' });
  if (_runningSince.has(r.key)) return res.json({ success: true, started: false, alreadyRunning: true });
  _runningSince.set(r.key, new Date().toISOString());
  r.run()
    .then((out) => console.log(`[routines] ${r.key} finished:`, JSON.stringify(out || {}).slice(0, 300)))
    .catch((e) => console.error(`[routines] ${r.key} failed:`, e.message))
    .finally(() => _runningSince.delete(r.key));
  res.json({ success: true, started: true, key: r.key });
});

module.exports = router;
