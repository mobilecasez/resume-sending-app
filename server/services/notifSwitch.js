// Admin kill switches for USER-FACING scheduled push notifications — ADDITIVE.
// Every automated push category the server sends to users checks its switch first; a missing row
// means ON (nothing changes until an admin flips something). 60s cache keeps the hot paths cheap.
'use strict';
const dbConfig = require('../../db-config');

// The registry drives both the gating and the admin page. `types` = the notifications-table type
// strings this category writes, used for the "sent in last 24h / 7d" counts on the page.
//
// `nudgeKey` (lifecycle entries only) makes the counts EXACT. Counting by notifications.type
// over-reports for shared buckets — 'credits' is written by four different senders and 'reminder'
// by three — so a lifecycle nudge counted that way would show numbers it did not produce. Entries
// carrying a nudgeKey are counted from user_nudge_log instead, which records one row per send.
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
    // ⚠️ NOT a push category — this one gates SPENDING, not sending. It is in this registry because
    // this registry is what the admin page renders, and "may the server spend money researching
    // jobs for a user the moment their résumé parses?" needs exactly the same one-click off switch.
    // It sends nothing itself; the jobs it finds are announced by the two alerts above, under their
    // own switches and caps. Seeded OFF by Migration 034 and FAIL-CLOSED below.
    key: 'instant_research', label: 'Instant job research on résumé upload', icon: '🔎',
    description: 'When a résumé finishes parsing and that person’s (country + field) corner of the feed is nearly empty — or their occupation maps to no field at all — go and research live jobs for them right away instead of waiting for the 12-hourly routine. Costs one grounded AI search + up to 8 extractions. Max 1 run per user ever, 20/day across all users. Off by default.',
    types: [],
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

  // ── lifecycle nudges (services/lifecycleNudges.js) ────────────────────────────────────────
  // One switch per nudge, because "turn off the photo reminder but keep the résumé one" is the
  // control that is actually wanted. All of them additionally obey the global caps in nudgeGate:
  // max 1 automated push per 20h, 3 per 7 days, 3 attempts per nudge, then silence.
  //
  // …and ONE master switch above them, because 13 toggles is the wrong control for the only
  // question that matters on day one: "is this thing allowed to message my users at all?".
  // ⚠️ The master gates SENDING only. Bonus quota promised to someone who then did the thing is
  // still paid out and still confirmed while it is off — a promise we already made does not become
  // void because the campaign was paused.
  {
    key: 'lifecycle_nudges_master', label: 'Lifecycle nudges — MASTER', icon: '🎚️', group: 'lifecycle',
    description: 'The single on/off for every automatic lifecycle nudge below. Off = no automatic nudges are sent to anyone, whatever the individual switches say. Bonuses already promised are still honoured.',
    types: [],
  },
  {
    key: 'nudge_upload_resume', label: 'Nudge: upload your résumé', icon: '📄', group: 'lifecycle',
    description: 'Sent 1+ day after signup when no résumé has been uploaded. Offers 3 extra free cover letters, granted once they actually upload. Opens the profile résumé section.',
    types: ['profile'], nudgeKey: 'nudge_upload_resume',
  },
  {
    key: 'nudge_resume_parse_failed', label: 'Nudge: résumé could not be read', icon: '⚠️', group: 'lifecycle',
    description: 'Sent when a résumé upload failed to parse — without this the user silently gets no match scores forever.',
    types: ['error'], nudgeKey: 'nudge_resume_parse_failed',
  },
  {
    key: 'nudge_complete_profile', label: 'Nudge: complete your profile', icon: '🧩', group: 'lifecycle',
    description: 'Sent 2+ days after signup when the profile is under 70% complete. Offers 2 extra free cover letters on completion.',
    types: ['profile'], nudgeKey: 'nudge_complete_profile',
  },
  {
    key: 'nudge_add_photo', label: 'Nudge: add a profile photo', icon: '📸', group: 'lifecycle',
    description: 'Sent 3+ days after signup when the résumé is in place but there is no photo.',
    types: ['profile'], nudgeKey: 'nudge_add_photo',
  },
  {
    key: 'nudge_add_signature', label: 'Nudge: add your signature', icon: '✍️', group: 'lifecycle',
    description: 'Sent 3+ days after signup when the résumé is in place but there is no signature for cover letters.',
    types: ['profile'], nudgeKey: 'nudge_add_signature',
  },
  {
    key: 'nudge_how_it_works', label: 'Nudge: how CVApplyr works', icon: '▶️', group: 'lifecycle',
    description: 'For users who signed up and then stalled with no search and no application. Opens the in-app guide.',
    types: ['reminder'], nudgeKey: 'nudge_how_it_works',
  },
  {
    key: 'nudge_generate_cover_letter', label: 'Nudge: generate a cover letter', icon: '✉️', group: 'lifecycle',
    description: 'They saved jobs but never generated a letter. Opens Job Hub → Saved.',
    types: ['reminder'], nudgeKey: 'nudge_generate_cover_letter',
  },
  {
    key: 'nudge_saved_not_applied', label: 'Nudge: saved but never applied', icon: '🔖', group: 'lifecycle',
    description: 'The strongest intent signal in the app — they saved a job and stopped.',
    types: ['reminder'], nudgeKey: 'nudge_saved_not_applied',
  },
  {
    key: 'nudge_finish_application', label: 'Nudge: finish your application', icon: '🚀', group: 'lifecycle',
    description: 'A cover letter is written and was never sent. Opens Job Hub → My Jobs.',
    types: ['reminder'], nudgeKey: 'nudge_finish_application',
  },
  {
    key: 'nudge_trial_ending', label: 'Nudge: trial ending soon', icon: '⏳', group: 'lifecycle',
    description: 'Trial has 3 days or less left with quota unused. Immediately adds 5 days and 2 free cover letters, then says so. Opens Plans & Usage.',
    types: ['credits'], nudgeKey: 'nudge_trial_ending',
  },
  {
    key: 'nudge_best_matches', label: 'Nudge: your best matches', icon: '🎯', group: 'lifecycle',
    description: 'Résumé-ranked jobs are waiting and they have not opened the app for a couple of days.',
    types: ['jobs'], nudgeKey: 'nudge_best_matches',
  },
  {
    key: 'nudge_welcome_back', label: 'Nudge: welcome back (dormant)', icon: '👋', group: 'lifecycle',
    description: 'Re-engagement for users who have not opened the app in 7+ days.',
    types: ['jobs'], nudgeKey: 'nudge_welcome_back',
  },
  {
    key: 'nudge_support_checkin', label: 'Nudge: are you facing any issue?', icon: '🛟', group: 'lifecycle',
    description: 'Asked LAST, only after 2+ earlier nudges, and only of users who tried the app and stalled. Opens Help & support with the “what went wrong” picker focused; their reply becomes a support thread in the staff inbox.',
    types: ['reminder'], nudgeKey: 'nudge_support_checkin',
  },
];

let _cache = null, _cacheAt = 0;
const TTL = 60 * 1000;

/**
 * ⚠️ A FAILED READ MUST NOT BE CACHED, AND MUST NOT MEAN "ON".
 *
 * The original swallowed any query error, kept the all-defaults map, and cached it for 60s. So a
 * transient database blip turned every switch back ON for a minute — including the master kill
 * switch an operator had deliberately turned OFF to stop notifications going out. The one moment
 * you most need a kill switch to hold is the moment things are going wrong.
 *
 * Now: a failed read is not cached (so the next call retries immediately) and is reported, so
 * `isOn` can fail CLOSED for the switches where "off" is the safe answer.
 */
async function getAll() {
  if (_cache && Date.now() - _cacheAt < TTL) return _cache;
  const map = {};
  for (const s of SWITCHES) map[s.key] = true;   // default ON when the row is simply absent
  let ok = true;
  try {
    const rows = await dbConfig.query('SELECT key, enabled FROM user_notification_switches');
    if (!rows) ok = false;
    for (const r of rows || []) if (r.key in map) map[r.key] = !!r.enabled;
  } catch (e) {
    ok = false;
    console.warn('[notifSwitch] read failed — switches unknown:', e.message);
  }
  if (ok) { _cache = map; _cacheAt = Date.now(); }
  map.__read_ok = ok;
  return map;
}

/**
 * Keys whose safe answer when we cannot read the table is OFF. Everything here either sends to a
 * user or arms something that does; "we could not check, so we sent it anyway" is the wrong call.
 */
const FAIL_CLOSED = new Set(['lifecycle_nudges_master', 'instant_research']);

async function isOn(key) {
  const all = await getAll();
  if (all.__read_ok === false) return !FAIL_CLOSED.has(key);
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
