// Daily employer fix-queue agent.
// Drains 'pending' employer_fix_requests (auto-queued whenever a search returns 0 jobs) through
// the diagnostic agent: investigate → learn a verified per-domain override → flip status to
// resolved / needs_review / failed. Bounded per run (cost) and guarded against churn. "Daily" is
// enforced by a PERSISTED last-run timestamp (system_schedule) so it survives frequent restarts /
// deploys instead of resetting a setInterval each boot. Fully backend; no app changes.
'use strict';

const dbConfig = require('../../db-config');
const { listFixRequests, recentDeadAttempt, getFixRequest } = require('./employerFix');
const { runInvestigation } = require('../controllers/employerFixController');

const JOB_KEY    = 'employer_fix_queue';
const INTERVAL_H = parseInt(process.env.FIX_QUEUE_INTERVAL_HOURS || '23', 10); // run at most ~once/day
const DAILY_CAP  = parseInt(process.env.FIX_QUEUE_DAILY_CAP || '20', 10);      // max requests / run (cost cap)

async function getLastRun() {
  try { const r = await dbConfig.get(`SELECT last_run_at FROM system_schedule WHERE job_key = ?`, [JOB_KEY]); return r ? r.last_run_at : null; }
  catch { return null; }
}
async function setLastRun(summary) {
  try {
    await dbConfig.run(
      `INSERT INTO system_schedule (job_key, last_run_at, last_summary)
       VALUES (?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT (job_key) DO UPDATE SET last_run_at = CURRENT_TIMESTAMP, last_summary = EXCLUDED.last_summary`,
      [JOB_KEY, summary || null]);
  } catch (e) { console.error('[fixQueue] setLastRun:', e.message); }
}

// Process up to DAILY_CAP pending fix-requests through the diagnostic agent.
async function runFixQueue({ force = false } = {}) {
  const last = await getLastRun();
  if (!force && last) {
    const hrs = (Date.now() - new Date(last).getTime()) / 3.6e6;
    if (hrs < INTERVAL_H) return { skipped: true, reason: `last run ${hrs.toFixed(1)}h ago (< ${INTERVAL_H}h)` };
  }
  const pending = await listFixRequests({ status: 'pending' }).catch(() => []);
  let processed = 0, resolved = 0, review = 0, failed = 0, deadSkipped = 0;
  for (const req of pending) {
    if (processed >= DAILY_CAP) break;
    const dead = await recentDeadAttempt(req.domain).catch(() => null);
    if (dead) { deadSkipped++; continue; }          // agent already gave up recently — don't churn
    processed++;
    try {
      await runInvestigation(req.id);               // updates DB status + auto-applies override on success
      const after = await getFixRequest(req.id).catch(() => null);
      const st = after && after.status;
      if (st === 'resolved') resolved++; else if (st === 'needs_review') review++; else failed++;
    } catch (e) { failed++; console.error('[fixQueue] investigate', req.domain, e.message); }
  }
  const summary = `processed ${processed}/${pending.length} pending — resolved ${resolved}, needs_review ${review}, failed ${failed}, skipped-dead ${deadSkipped}`;
  await setLastRun(summary);
  console.log(`[fixQueue] daily run: ${summary}`);
  return { processed, resolved, review, failed, deadSkipped, pending: pending.length, summary };
}

// Hourly tick that fires runFixQueue() once ~a day has elapsed (the persisted timestamp gates it,
// so a deploy/restart can't trigger an extra paid run). First tick a few minutes after boot.
function startFixQueueScheduler() {
  if (process.env.FIX_QUEUE_DISABLED === '1') { console.log('🛠️  Employer fix-queue agent: DISABLED (FIX_QUEUE_DISABLED=1)'); return; }
  const tick = () => runFixQueue().catch((e) => console.error('[fixQueue] tick:', e.message));
  setTimeout(tick, 5 * 60 * 1000);
  setInterval(tick, 60 * 60 * 1000);
  console.log('🛠️  Employer fix-queue agent: scheduled (daily, persisted last-run)');
}

module.exports = { runFixQueue, startFixQueueScheduler };
