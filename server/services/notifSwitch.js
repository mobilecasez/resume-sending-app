// Admin kill switches for USER-FACING scheduled push notifications — ADDITIVE.
// Every automated push category the server sends to users checks its switch first; a missing row
// means ON (nothing changes until an admin flips something). 60s cache keeps the hot paths cheap.
'use strict';
const dbConfig = require('../../db-config');

// The registry drives both the gating and the admin page. `types` = the notifications-table type
// strings this category writes, used for the "sent in last 24h / 7d" counts on the page.
const SWITCHES = [
  {
    key: 'demand_jobs', label: 'Interest match alerts', icon: '🎯',
    description: '“New matching jobs for you” — sent when the demand researcher finds fresh jobs for a user’s saved interest card (place + skills). Max 1/user/day.',
    types: ['demand_jobs'],
  },
  {
    key: 'resume_match_jobs', label: 'Résumé match alerts', icon: '🧲',
    description: '“6 new plumbing jobs in Canada” — sent when newly added jobs match a user’s résumé skills, even without a saved interest. Max 1/user/day (shared with interest alerts).',
    types: ['resume_match_jobs'],
  },
  {
    key: 'daily_reminders', label: 'Follow-up reminders', icon: '⏰',
    description: 'Daily nudge when an application got no reply after a few days — “time to follow up with X”.',
    types: ['reminder'],
  },
  {
    key: 'credit_expiry', label: 'Credit expiry warnings', icon: '⌛',
    description: 'Warns users whose remaining credits expire within 3 days.',
    types: ['credits'],
  },
  {
    key: 'weekly_digest', label: 'Weekly digest', icon: '🗞️',
    description: 'The weekly activity summary push (applications sent, replies, letters generated).',
    types: ['digest'],
  },
  {
    key: 'reply_alerts', label: 'Reply alerts', icon: '📬',
    description: '“You got a reply!” — sent when the Outlook poller detects an employer replied to an application.',
    types: ['email'],
  },
];

let _cache = null, _cacheAt = 0;
const TTL = 60 * 1000;

async function getAll() {
  if (_cache && Date.now() - _cacheAt < TTL) return _cache;
  const map = {};
  for (const s of SWITCHES) map[s.key] = true;   // default ON
  try {
    const rows = await dbConfig.query('SELECT key, enabled FROM user_notification_switches');
    for (const r of rows || []) if (r.key in map) map[r.key] = !!r.enabled;
  } catch { /* table may not exist yet — defaults hold */ }
  _cache = map; _cacheAt = Date.now();
  return map;
}

async function isOn(key) {
  const all = await getAll();
  return all[key] !== false;
}

async function set(key, enabled) {
  if (!SWITCHES.some((s) => s.key === key)) throw new Error('unknown switch: ' + key);
  await dbConfig.run(
    `INSERT INTO user_notification_switches (key, enabled, updated_at) VALUES (?, ?, NOW())
     ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
    [key, !!enabled]);
  _cache = null;   // next read refreshes
  return isOn(key);
}

module.exports = { SWITCHES, isOn, set, getAll };
