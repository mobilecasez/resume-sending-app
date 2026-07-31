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
