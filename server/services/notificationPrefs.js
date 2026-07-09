// Per-user notification preferences (per category). Default: everything ON. Gates PUSH delivery
// (in-app rows are always created — they're a harmless feed). Categories:
//   replies             — a company replied to your application
//   application_updates — application sent, cover letter ready, job search finished, credits
//   reminders           — follow-up nudges, credit-expiry warnings
//   digest              — weekly activity summary
//   marketing           — feature announcements, offers
// ADDITIVE + fail-open: any error → treated as enabled (never silently swallow a real notification).
'use strict';
const dbConfig = require('../../db-config');

const CATEGORIES = ['replies', 'application_updates', 'reminders', 'digest', 'marketing'];

async function ensureTable() {
  try {
    await dbConfig.run(`CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id INTEGER PRIMARY KEY,
      replies BOOLEAN DEFAULT TRUE,
      application_updates BOOLEAN DEFAULT TRUE,
      reminders BOOLEAN DEFAULT TRUE,
      digest BOOLEAN DEFAULT TRUE,
      marketing BOOLEAN DEFAULT TRUE,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (e) { /* best-effort */ }
}

function truthy(v) { return v !== false && v !== 0 && v !== 'false' && v !== '0'; }

// Is a given category enabled for this user? Default TRUE (no row / missing table / error).
async function isEnabled(userId, category) {
  if (!CATEGORIES.includes(category)) return true;
  try {
    const r = await dbConfig.get(`SELECT ${category} AS v FROM notification_preferences WHERE user_id = ?`, [userId]);
    if (!r) return true;
    return truthy(r.v);
  } catch { return true; }
}

async function getPrefs(userId) {
  const base = { replies: true, application_updates: true, reminders: true, digest: true, marketing: true };
  try {
    const r = await dbConfig.get(`SELECT * FROM notification_preferences WHERE user_id = ?`, [userId]);
    if (!r) return base;
    for (const c of CATEGORIES) base[c] = truthy(r[c]);
    return base;
  } catch { return base; }
}

// Upsert: merges provided categories over the current values (unspecified keep their value).
async function setPrefs(userId, prefs = {}) {
  await ensureTable();
  const cur = await getPrefs(userId);
  const merged = {};
  for (const c of CATEGORIES) merged[c] = (prefs[c] === undefined) ? cur[c] : !!prefs[c];
  await dbConfig.run(
    `INSERT INTO notification_preferences (user_id, replies, application_updates, reminders, digest, marketing, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO UPDATE SET
       replies = EXCLUDED.replies, application_updates = EXCLUDED.application_updates,
       reminders = EXCLUDED.reminders, digest = EXCLUDED.digest, marketing = EXCLUDED.marketing,
       updated_at = CURRENT_TIMESTAMP`,
    [userId, merged.replies, merged.application_updates, merged.reminders, merged.digest, merged.marketing]
  );
  return merged;
}

module.exports = { CATEGORIES, ensureTable, isEnabled, getPrefs, setPrefs };
