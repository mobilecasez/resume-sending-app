// Engagement notifications — periodic, PERSISTED-gated (survives restarts/deploys) like fixQueueRunner.
//  • Daily reminders: follow-up nudges (applied N days ago, no reply) + credit-expiry warnings.
//  • Weekly digest: last-7-days activity summary for active users.
// All are preference-gated on PUSH (notification_preferences: reminders / digest). Fully backend;
// benefits already-installed apps via push. ADDITIVE.
'use strict';
const dbConfig = require('../../db-config');
const {
  notifyFollowUp, notifyCreditExpiry, notifyWeeklyDigest,
} = require('../controllers/notificationsController');

const FOLLOWUP_AFTER_DAYS = parseInt(process.env.FOLLOWUP_AFTER_DAYS || '4', 10);
const FOLLOWUP_MAX_AGE_DAYS = parseInt(process.env.FOLLOWUP_MAX_AGE_DAYS || '30', 10);
const DAILY_CAP = parseInt(process.env.ENGAGEMENT_DAILY_CAP || '500', 10);

async function getLastRun(key) {
  try { const r = await dbConfig.get(`SELECT last_run_at FROM system_schedule WHERE job_key = ?`, [key]); return r ? r.last_run_at : null; }
  catch { return null; }
}
async function setLastRun(key, summary) {
  try {
    await dbConfig.run(
      `INSERT INTO system_schedule (job_key, last_run_at, last_summary) VALUES (?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT (job_key) DO UPDATE SET last_run_at = CURRENT_TIMESTAMP, last_summary = EXCLUDED.last_summary`,
      [key, summary || null]);
  } catch (_) {}
}
function hoursSince(ts) { return ts ? (Date.now() - new Date(ts).getTime()) / 3.6e6 : Infinity; }

// ── Daily: follow-up reminders + credit-expiry warnings ──────────────────────────────────────
async function runDailyReminders({ force = false } = {}) {
  if (!force && hoursSince(await getLastRun('daily_reminders')) < 20) return { skipped: true };
  const notifSwitch = require('./notifSwitch');
  const followUpsOn = await notifSwitch.isOn('daily_reminders');
  const expiryOn = await notifSwitch.isOn('credit_expiry');
  let followUps = 0, expiries = 0;

  // Follow-ups: applied >= N days ago, no reply, not yet reminded.
  const stale = followUpsOn ? await dbConfig.query(
    `SELECT id, user_id, company_name, EXTRACT(DAY FROM (NOW() - sent_date))::int AS days_ago
       FROM application_history
      WHERE reply_received = 0 AND follow_up_reminded_at IS NULL
        AND sent_date <= NOW() - INTERVAL '${FOLLOWUP_AFTER_DAYS} days'
        AND sent_date >  NOW() - INTERVAL '${FOLLOWUP_MAX_AGE_DAYS} days'
      ORDER BY sent_date ASC LIMIT ${DAILY_CAP}`).catch(() => []) : [];
  // ⚠️ Every automated push both ASKS and TELLS the shared gate (services/nudgeGate.js). Recording
  // alone is not enough — that was the first version of this, and it meant follow-ups still fanned
  // out to everyone at whatever hour the tick landed while merely informing the other jobs after
  // the fact. Asking first is what makes "one automated push per 20h" true rather than aspirational.
  const gate = require('./nudgeGate');
  const staleState = await gate.loadState(stale.map((a) => a.user_id));
  for (const a of stale) {
    try {
      const d = gate.check(a.user_id, 'daily_reminders', staleState.get(a.user_id), Date.now());
      if (!d.ok) continue;                      // the reminder waits for a better moment
      const r = await notifyFollowUp(a.user_id, a.company_name || 'the company', a.days_ago);
      await dbConfig.run('UPDATE application_history SET follow_up_reminded_at = NOW() WHERE id = ?', [a.id]);
      // Record what ACTUALLY happened. Hard-coding pushOk:true spends the user's weekly budget on
      // a push that an opt-out or a dead token silently swallowed.
      await gate.record(a.user_id, 'daily_reminders', { attempt: d.attempt, pushOk: !!(r && r.pushed) });
      if (r && r.pushed) followUps++;
    } catch (_) {}
  }

  // Credit expiry: expires within 3 days, still has a balance, not warned in the last few days.
  const expiring = expiryOn ? await dbConfig.query(
    `SELECT user_id, credits_remaining, EXTRACT(DAY FROM (expiry_date - NOW()))::int AS days_left
       FROM user_credits
      WHERE expiry_date IS NOT NULL AND credits_remaining > 0
        AND expiry_date > NOW() AND expiry_date <= NOW() + INTERVAL '3 days'
        AND (expiry_warned_at IS NULL OR expiry_warned_at < NOW() - INTERVAL '4 days')
      LIMIT ${DAILY_CAP}`).catch(() => []) : [];
  const expState = await gate.loadState(expiring.map((c) => c.user_id));
  for (const c of expiring) {
    try {
      const d = gate.check(c.user_id, 'credit_expiry', expState.get(c.user_id), Date.now());
      if (!d.ok) continue;
      const r = await notifyCreditExpiry(c.user_id, c.credits_remaining, Math.max(0, c.days_left) + 1);
      await dbConfig.run('UPDATE user_credits SET expiry_warned_at = NOW() WHERE user_id = ?', [c.user_id]);
      await gate.record(c.user_id, 'credit_expiry', { attempt: d.attempt, pushOk: !!(r && r.pushed) });
      if (r && r.pushed) expiries++;
    } catch (_) {}
  }

  const summary = `follow-ups ${followUps}, expiry-warnings ${expiries}`;
  await setLastRun('daily_reminders', summary);
  if (followUps || expiries) console.log(`[engagement] daily: ${summary}`);
  return { followUps, expiries, summary };
}

// ── Weekly: activity digest for active users ─────────────────────────────────────────────────
async function runWeeklyDigest({ force = false } = {}) {
  if (!force && hoursSince(await getLastRun('weekly_digest')) < 156) return { skipped: true }; // ~6.5 days
  if (!(await require('./notifSwitch').isOn('weekly_digest'))) { await setLastRun('weekly_digest', 'switched off by admin'); return { skipped: 'switched_off' }; }
  const byUser = {};
  const bump = (uid, k, n) => { (byUser[uid] = byUser[uid] || { sent: 0, replies: 0, generated: 0 })[k] += n; };

  const sent = await dbConfig.query(
    `SELECT user_id, COUNT(*)::int n FROM application_history WHERE sent_date > NOW() - INTERVAL '7 days' GROUP BY user_id`).catch(() => []);
  sent.forEach(r => bump(r.user_id, 'sent', r.n));
  const replies = await dbConfig.query(
    `SELECT user_id, COUNT(*)::int n FROM application_history WHERE reply_received = 1 AND reply_date > NOW() - INTERVAL '7 days' GROUP BY user_id`).catch(() => []);
  replies.forEach(r => bump(r.user_id, 'replies', r.n));
  const gen = await dbConfig.query(
    `SELECT user_id, COUNT(*)::int n FROM credit_usage_history WHERE action_type = 'cover_letter_generation' AND created_at > NOW() - INTERVAL '7 days' GROUP BY user_id`).catch(() => []);
  gen.forEach(r => bump(r.user_id, 'generated', r.n));

  let digests = 0;
  const gate = require('./nudgeGate');
  for (const [uid, d] of Object.entries(byUser)) {
    if (!(d.sent || d.generated)) continue;               // only genuinely active users
    const id = parseInt(uid, 10);
    // The digest had NO per-user dedupe at all — its only guard was the job-level 156h timestamp,
    // which the admin "Run now" button bypasses with force:true. Two taps meant two digests to
    // everyone. The shared ledger closes that: a digest sent in the last 6 days is a repeat.
    let st = new Map();
    try {
      st = await gate.loadState([id]);
      const gs = st.get(id);
      const last = gs && gs.byKey ? gs.byKey.get('weekly_digest') : null;
      if (last && (Date.now() - last.at) < 6 * 24 * 3600 * 1000) continue;
    } catch (_) { /* gate unavailable — send rather than silently drop the digest */ }
    try {
      const dec = gate.check(id, 'weekly_digest', st.get(id), Date.now());
      if (!dec.ok) continue;
      const r = await notifyWeeklyDigest(id, d);
      await gate.record(id, 'weekly_digest', { attempt: dec.attempt, pushOk: !!(r && r.pushed) });
      if (r && r.pushed) digests++;
    } catch (_) {}
  }
  const summary = `digests ${digests}`;
  await setLastRun('weekly_digest', summary);
  if (digests) console.log(`[engagement] weekly: ${summary}`);
  return { digests, summary };
}

function startEngagementScheduler() {
  if (process.env.ENGAGEMENT_DISABLED === '1') { console.log('🔔 Engagement scheduler: DISABLED'); return; }
  const tick = () => {
    runDailyReminders().catch((e) => console.error('[engagement] daily tick:', e.message));
    runWeeklyDigest().catch((e) => console.error('[engagement] weekly tick:', e.message));
  };
  setTimeout(tick, 6 * 60 * 1000);              // first run ~6 min after boot
  setInterval(tick, 60 * 60 * 1000);            // hourly tick; each job self-gates by persisted timestamp
  console.log('🔔 Engagement scheduler: scheduled (daily reminders + weekly digest, persisted)');
}

module.exports = { runDailyReminders, runWeeklyDigest, startEngagementScheduler };
