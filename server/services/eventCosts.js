// AI event credit costs — single source of truth, DB-driven with a safe fallback.
// Admins edit per-event credits in `ai_event_costs`; controllers read the live value
// via getEventCost() instead of hardcoding numbers. Changing a cost in the DB takes
// effect within a few seconds (short in-memory cache), no redeploy needed.
'use strict';

const dbConfig = require('../../db-config');

// The canonical catalog. `credits` here are the DEFAULTS — used to seed the table
// (db-init) and as a fallback if the table/row is unavailable. category: paid|free.
const CATALOG = [
  { key: 'company_search',        label: 'Company job search',        credits: 3, category: 'paid', sort: 1,  description: "Search a company's careers page for matching jobs." },
  { key: 'cover_letter_generate', label: 'Cover letter (AI)',         credits: 1, category: 'paid', sort: 2,  description: 'Generate a tailored cover letter (Letters page).' },
  { key: 'job_cover_letter',      label: 'Job Hub cover letter (AI)', credits: 1, category: 'paid', sort: 3,  description: 'Generate a cover letter for a Job Hub job.' },
  { key: 'cover_letter_download', label: 'Cover letter download',     credits: 2, category: 'paid', sort: 4,  description: 'Download a cover letter as PDF or Word.' },
  { key: 'resume_ai_generate',    label: 'AI resume generation',      credits: 2, category: 'paid', sort: 5,  description: 'Generate or enhance a resume with AI.' },
  { key: 'resume_download',       label: 'Resume download',           credits: 2, category: 'paid', sort: 6,  description: 'Download a resume as PDF or Word.' },
  { key: 'find_recruiters',       label: 'Find recruiters',           credits: 1, category: 'paid', sort: 7,  description: 'Find recruiters / HR contacts for a company.' },
  { key: 'find_recruiter_emails', label: 'Find recruiter emails',     credits: 1, category: 'paid', sort: 8,  description: 'Find & verify recruiter work emails.' },
  { key: 'ai_autofill',           label: 'AI auto-fill',              credits: 0, category: 'free', sort: 9,  description: 'Auto-fill an application form with AI. Free today.' },
  { key: 'translate_job',         label: 'Translate to English',      credits: 0, category: 'free', sort: 10, description: 'Translate a job posting to English. Free today.' },
  { key: 'ai_email_body',         label: 'AI email body',             credits: 0, category: 'free', sort: 11, description: 'Write the outreach email body with AI. Free today.' },
  { key: 'ai_search',             label: 'AI job search',             credits: 5, category: 'paid', sort: 12, description: 'Natural-language AI search across the network + live web.' },
  { key: 'live_fetch',            label: 'Fetch live job',            credits: 1, category: 'paid', sort: 13, description: 'Fetch one live job posting from the web into your feed.' },

  // ── REWARDS (credits IN — grants, not charges). direction:'credit' so the admin screen shows them
  // in the "Rewards" tab. Amounts are admin-configurable exactly like the costs above; set is_active=0
  // (via the admin screen) to switch a reward off. Granted ONCE per user (except referral, once/friend).
  { key: 'reward_complete_profile', label: 'Complete your profile', credits: 5,  category: 'reward', direction: 'credit', sort: 101, description: 'One-time: user uploads a résumé / completes their profile.' },
  { key: 'reward_first_apply',      label: 'Apply to your first job', credits: 10, category: 'reward', direction: 'credit', sort: 102, description: 'One-time: user applies to their first job.' },
  { key: 'reward_rate_app',         label: 'Rate the app',          credits: 20, category: 'reward', direction: 'credit', sort: 103, description: 'One-time: user shares in-app feedback (store-policy safe — reward is for feedback, not the store review).' },
  { key: 'reward_referral',         label: 'Refer a friend',        credits: 20, category: 'reward', direction: 'credit', sort: 104, description: 'Per friend: an invited user signs up, completes their profile, and applies to a job.' },
];

const DEFAULT = {};
CATALOG.forEach((c) => { DEFAULT[c.key] = c.credits; });
// direction map (credit = a reward grant, debit = a cost); defaults to 'debit' for anything unspecified.
const DIRECTION = {};
CATALOG.forEach((c) => { DIRECTION[c.key] = c.direction || 'debit'; });

let _cache = null;
let _at = 0;
const TTL_MS = 20000;

async function _load() {
  const now = Date.now();
  if (_cache && now - _at < TTL_MS) return _cache;
  try {
    const rows = await dbConfig.query('SELECT event_key, credits, is_active FROM ai_event_costs');
    const map = {};
    (rows || []).forEach((r) => {
      map[r.event_key] = {
        credits: parseInt(r.credits, 10) || 0,
        active: r.is_active === 1 || r.is_active === true,
      };
    });
    _cache = map;
    _at = now;
    return map;
  } catch (e) {
    return null; // table not migrated yet → callers fall back to DEFAULT
  }
}

// Live credit cost for an event. Inactive events charge 0. Unknown → default/0.
async function getEventCost(eventKey) {
  const map = await _load();
  if (map && map[eventKey]) return map[eventKey].active ? map[eventKey].credits : 0;
  return DEFAULT[eventKey] != null ? DEFAULT[eventKey] : 0;
}

// Public map { event_key: credits } for ACTIVE events — drives the cost labels in the app.
async function getPublicCosts() {
  const map = await _load();
  const out = {};
  for (const c of CATALOG) {
    if (map && map[c.key]) { if (map[c.key].active) out[c.key] = map[c.key].credits; }
    else out[c.key] = c.credits;
  }
  return out;
}

function invalidate() { _cache = null; _at = 0; }

// Charge a user for an event whose deduction isn't already handled by a controller
// (used to wire the currently-free events). With cost 0 it's a no-op (stays free).
// Returns { charged, cost, remaining, insufficient }.
async function chargeCredits(userId, eventKey, metadata = {}) {
  const cost = await getEventCost(eventKey);
  if (!cost || cost <= 0) return { charged: false, cost: 0 };
  const acct = await dbConfig.get('SELECT credits_remaining FROM user_credits WHERE user_id = ?', [userId]);
  const remaining = acct ? (acct.credits_remaining || 0) : 0;
  if (!acct || remaining < cost) return { charged: false, cost, insufficient: true, remaining };
  await dbConfig.run('UPDATE user_credits SET credits_remaining = credits_remaining - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [cost, userId]);
  try {
    await dbConfig.run(
      'INSERT INTO credit_usage_history (user_id, credits_used, action_type, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
      [userId, cost, eventKey]);
  } catch (e) { /* history is best-effort */ }
  return { charged: true, cost, remaining: remaining - cost };
}

// Give back a charge when the work it paid for could not be delivered (e.g. the AI was unavailable).
// No-op when nothing was charged, so callers can call it unconditionally on their failure path.
async function refundCredits(userId, eventKey, charge) {
  if (!charge || !charge.charged || !charge.cost || charge.cost <= 0) return;
  try {
    await dbConfig.run('UPDATE user_credits SET credits_remaining = credits_remaining + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [charge.cost, userId]);
    await dbConfig.run(
      'INSERT INTO credit_usage_history (user_id, credits_used, action_type, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
      [userId, -charge.cost, eventKey + '_refund']);
  } catch (e) { console.error('[credits] refund failed:', e.message); }
}

module.exports = { CATALOG, DEFAULT, DIRECTION, getEventCost, getPublicCosts, invalidate, chargeCredits, refundCredits };
