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
  {
    key: 'lifecycle_nudges', name: 'Lifecycle Nudges', icon: '🌱', intervalHours: 6,
    description: 'Works out where each user is stuck (no résumé, no photo, saved but never applied, trial about to close…) and sends ONE fitting nudge — never two, never inside 20 hours of the last push, and never more than three times for the same nudge. Pays out promised bonus cover letters once the user actually completes the step, and asks “are you facing any issue?” last of all.',
    run: () => require('../services/lifecycleNudges').runLifecycleNudges({ force: true }),
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
    const b = req.body || {};
    const hours = Math.min(Math.max(parseFloat(b.sinceHours) || 24, 0.5), 72);
    const dryRun = !!b.dryRun;   // preview what WOULD be pushed, sending nothing
    const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const dr = require('../services/demandResearch');
    if (dryRun) {
      const preview = await dr.notifyResumeMatchedUsers(sinceIso, { dryRun: true }).catch(() => []);
      return res.json({ success: true, sinceHours: hours, dryRun: true, wouldPush: preview });
    }
    const interestPushes = await dr.notifyMatchedUsers(sinceIso).catch(() => 0);
    const resumePushes = await dr.notifyResumeMatchedUsers(sinceIso).catch(() => 0);
    res.json({ success: true, sinceHours: hours, interestPushes, resumePushes });
  } catch (e) {
    console.error('[routines] notify-matches:', e.message);
    res.status(500).json({ error: 'Notify sweep failed' });
  }
});

// Lifecycle-nudge PREVIEW. Runs the whole pipeline — candidate selection, per-user state, the
// priority ladder, and every gate — and returns exactly what would be sent to whom, without
// sending anything. `dryRun` defaults to TRUE: a request that forgets the flag must preview, not
// blast. Pass { dryRun: false } explicitly to actually send.
router.post('/admin/routines/lifecycle-nudges', authenticateAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const dryRun = b.dryRun !== false;
    const out = await require('../services/lifecycleNudges').runLifecycleNudges({
      force: true,
      dryRun,
      scanLimit: Math.min(Math.max(parseInt(b.scanLimit, 10) || 2000, 1), 5000),
      sendLimit: Math.min(Math.max(parseInt(b.sendLimit, 10) || (dryRun ? 200 : 300), 1), 1000),
    });
    res.json({ success: true, ...out });
  } catch (e) {
    console.error('[routines] lifecycle-nudges:', e.message);
    res.status(500).json({ error: 'Lifecycle sweep failed: ' + e.message });
  }
});

// ── User-facing push switches: what automated pushes users receive, admin on/off ──
router.get('/admin/user-notification-switches', authenticateAdmin, async (req, res) => {
  try {
    const notifSwitch = require('../services/notifSwitch');
    const enabled = await notifSwitch.getAll();

    // TWO grouped queries instead of one COUNT per switch. With 19 switches the old N+1 was 19
    // sequential scans of `notifications` on every page load.
    const [byType, byNudge] = await Promise.all([
      dbConfig.query(
        `SELECT type,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS d1,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int  AS d7
           FROM notifications WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY type`).catch(() => []),
      dbConfig.query(
        `SELECT nudge_key,
                COUNT(*) FILTER (WHERE sent_at > NOW() - INTERVAL '24 hours')::int AS d1,
                COUNT(*) FILTER (WHERE sent_at > NOW() - INTERVAL '7 days')::int  AS d7
           FROM user_nudge_log
          WHERE push_ok IS TRUE AND sent_at > NOW() - INTERVAL '7 days' GROUP BY nudge_key`).catch(() => []),
    ]);
    const typeMap = new Map((byType || []).map((r) => [r.type, r]));
    const nudgeMap = new Map((byNudge || []).map((r) => [r.nudge_key, r]));

    const items = notifSwitch.SWITCHES.map((s) => {
      let d1 = 0, d7 = 0;
      if (s.nudgeKey) {
        // Exact: one user_nudge_log row per send of THIS nudge. Counting by notifications.type
        // would lump it in with every other sender writing the same bucket.
        const r = nudgeMap.get(s.nudgeKey);
        if (r) { d1 = r.d1; d7 = r.d7; }
      } else {
        for (const t of s.types || []) {
          const r = typeMap.get(t);
          if (r) { d1 += r.d1; d7 += r.d7; }
        }
      }
      return {
        key: s.key, label: s.label, icon: s.icon, description: s.description,
        group: s.group || 'core',
        enabled: enabled[s.key] !== false,
        sent24h: d1, sent7d: d7,
        // Shared `notifications.type` buckets (e.g. 'credits' is written by four senders) make a
        // type-based count an upper bound, not a measurement. Say so rather than let the number
        // be read as precise.
        exactCount: !!s.nudgeKey,
      };
    });
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
