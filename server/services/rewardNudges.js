'use strict';
// Reward push nudges — ADMIN-TRIGGERED (never auto-blasts). Targets users who have a push token, haven't
// earned the reward yet, and weren't nudged with this key recently. dryRun previews the audience size.
const dbConfig = require('../../db-config');
const { sendPushNotification } = require('./expoPushService');
const eventCosts = require('./eventCosts');

// {credits} is filled from the live (admin-configurable) reward amount.
const NUDGES = {
  reward_rate_app:         { title: 'Rate CVApplyr — get {credits} free credits ⭐', body: 'Tell us how we’re doing and earn {credits} free credits. Takes 10 seconds.' },
  reward_complete_profile: { title: 'Finish your profile → {credits} free credits', body: 'Upload your résumé to unlock AI job matches — and pocket {credits} free credits.' },
  reward_first_apply:      { title: 'Apply to your first job → {credits} credits', body: 'Send your first application with CVApplyr and we’ll add {credits} free credits.' },
};

let _ready = false;
async function ensure() {
  if (_ready) return;
  await dbConfig.run(`CREATE TABLE IF NOT EXISTS reward_nudges_sent (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, nudge_key TEXT NOT NULL, sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  try { await dbConfig.run(`CREATE INDEX IF NOT EXISTS idx_reward_nudges ON reward_nudges_sent(user_id, nudge_key, sent_at DESC)`); } catch (_) {}
  _ready = true;
}

// Users to nudge: valid push token + reward not yet earned + not nudged with this key in `cooldownDays`.
async function targets(nudgeKey, limit, cooldownDays) {
  await ensure();
  const rows = await dbConfig.query(
    `SELECT u.id, u.expo_push_token FROM users u
      WHERE u.expo_push_token IS NOT NULL AND u.expo_push_token <> ''
        AND NOT EXISTS (SELECT 1 FROM user_reward_grants g WHERE g.user_id = u.id AND g.event_key = ?)
        AND NOT EXISTS (SELECT 1 FROM reward_nudges_sent n WHERE n.user_id = u.id AND n.nudge_key = ? AND n.sent_at > NOW() - (? || ' days')::interval)
      LIMIT ?`,
    [nudgeKey, nudgeKey, String(cooldownDays), limit]
  ).catch(() => []);
  return (rows || []).filter((r) => /^Expo(nent)?PushToken\[/.test(r.expo_push_token || ''));
}

async function sendNudge(nudgeKey, opts = {}) {
  const cfg = NUDGES[nudgeKey];
  if (!cfg) return { error: 'unknown_nudge', available: Object.keys(NUDGES) };
  const credits = await eventCosts.getEventCost(nudgeKey);
  const title = cfg.title.replace(/\{credits\}/g, String(credits));
  const body = cfg.body.replace(/\{credits\}/g, String(credits));

  // TEST mode — send ONLY to this user's device (ignores the earned/cooldown filters so the admin can
  // preview the real notification on their own phone before any mass send).
  if (opts.testUserId) {
    const u = await dbConfig.get('SELECT id, expo_push_token FROM users WHERE id = ?', [opts.testUserId]).catch(() => null);
    if (!u || !/^Expo(nent)?PushToken\[/.test(u.expo_push_token || '')) return { test: true, sent: 0, reason: 'no_push_token' };
    const res = await sendPushNotification(u.expo_push_token, title, body, { type: 'reward', screen: 'rewards', nudge: nudgeKey, test: true },
      { userId: u.id, source: 'reward_nudge', templateKey: nudgeKey, audience: 'user' });
    return { test: true, sent: res === true ? 1 : 0, reason: res === true ? undefined : (res === 'stale' ? 'stale_token' : 'send_failed') };
  }

  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 500, 1), 10000);
  const cooldownDays = parseInt(opts.cooldownDays, 10) || 7;
  const tgt = await targets(nudgeKey, limit, cooldownDays);
  if (opts.dryRun) return { dryRun: true, nudgeKey, credits, wouldTarget: tgt.length };
  let sent = 0, stale = 0;
  for (const u of tgt) {
    const res = await sendPushNotification(u.expo_push_token, title, body, { type: 'reward', screen: 'rewards', nudge: nudgeKey },
      { userId: u.id, source: 'reward_nudge', templateKey: nudgeKey, audience: 'user' });
    if (res === 'stale') { stale++; try { await dbConfig.run('UPDATE users SET expo_push_token = NULL WHERE id = ?', [u.id]); } catch (_) {} }
    else if (res) { sent++; try { await dbConfig.run('INSERT INTO reward_nudges_sent (user_id, nudge_key) VALUES (?, ?)', [u.id, nudgeKey]); } catch (_) {} }
  }
  return { nudgeKey, credits, targeted: tgt.length, sent, stale };
}

module.exports = { NUDGES, sendNudge };
