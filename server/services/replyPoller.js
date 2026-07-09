// Background reply poller — detects replies to sent applications for MICROSOFT/Outlook users even
// when the app is CLOSED, then fires an in-app notification + device push (the on-demand /check-replies
// endpoint only runs while the app is open). Mirrors the exact matching heuristic from
// emailController.checkEmailReplies, using the shared getValidMicrosoftAccessToken (encrypted token +
// auto-refresh). Gmail stays disabled server-side pending CASA (same as the endpoint). ADDITIVE.
'use strict';
const dbConfig = require('../../db-config');
const { getValidMicrosoftAccessToken } = require('../controllers/emailController');
const { notifyEmailReply } = require('../controllers/notificationsController');

const JOB_KEY = 'reply_poll';
const INTERVAL_MIN = parseInt(process.env.REPLY_POLL_INTERVAL_MIN || '20', 10);   // poll cadence
const APP_WINDOW_DAYS = parseInt(process.env.REPLY_POLL_WINDOW_DAYS || '45', 10); // only recent apps
const MAX_USERS = parseInt(process.env.REPLY_POLL_MAX_USERS || '400', 10);        // safety cap per run
const GENERIC_PROVIDERS = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'live.com', 'icloud.com', 'aol.com', 'protonmail.com', 'mail.com', 'zoho.com'];

function stripHtml(html) {
  let b = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#13;/gi, '\n')
    .replace(/<[^>]*>/g, '');
  b = b.replace(/[ \t]+/g, ' ').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  for (const p of [/[\r\n]+\s*On\s+.+wrote:/is, /-----Original Message-----/i, /From:.+?Sent:.+?To:/si, /_+\s*From:/i]) {
    const m = b.match(p); if (m) { b = b.substring(0, m.index).trim(); break; }
  }
  return b || '(Reply received)';
}

// Check one Microsoft user's inbox for replies to their recent applications. Returns #new replies.
async function checkUserMicrosoftReplies(user) {
  let token;
  try { token = await getValidMicrosoftAccessToken(user); } catch { return 0; }
  if (!token) return 0;

  const apps = await dbConfig.query(
    `SELECT * FROM application_history
      WHERE user_id = ? AND sent_date > NOW() - INTERVAL '${APP_WINDOW_DAYS} days'
      ORDER BY sent_date DESC LIMIT 50`, [user.id]).catch(() => []);
  if (!apps.length) return 0;

  const resp = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=50&$orderby=receivedDateTime desc', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!resp || !resp.ok) return 0;
  const emails = ((await resp.json().catch(() => ({}))).value) || [];
  if (!emails.length) return 0;

  const userEmail = (user.email || '').toLowerCase();
  let found = 0;
  for (const app of apps) {
    const companyEmail = (app.recipient_email || '').toLowerCase();
    if (!companyEmail) continue;
    const companyDomain = companyEmail.split('@')[1];
    const isGeneric = GENERIC_PROVIDERS.includes(companyDomain);
    const sentDate = new Date(app.sent_date);
    for (const email of emails) {
      const fromEmail = (email.from?.emailAddress?.address || '').toLowerCase();
      if (!fromEmail) continue;
      const fromDomain = fromEmail.split('@')[1];
      const isFromCompany = isGeneric ? (fromEmail === companyEmail) : (fromDomain === companyDomain);
      const isAfterSent = new Date(email.receivedDateTime) > sentDate;
      if (!(isFromCompany && fromEmail !== userEmail && isAfterSent)) continue;

      const subject = email.subject || '(No Subject)';
      const dup = await dbConfig.get(
        'SELECT id FROM application_reply_history WHERE application_id = ? AND reply_date = ? AND reply_subject = ?',
        [app.id, email.receivedDateTime, subject]).catch(() => null);
      if (dup) continue;

      const body = stripHtml(email.body?.content || email.bodyPreview || '');
      await dbConfig.run(
        'INSERT INTO application_reply_history (application_id, reply_date, reply_subject, reply_snippet, reply_from_email) VALUES (?, ?, ?, ?, ?)',
        [app.id, email.receivedDateTime, subject, body, fromEmail]).catch(() => {});
      await dbConfig.run(
        'UPDATE application_history SET reply_received = 1, reply_date = ?, reply_subject = ?, reply_snippet = ?, reply_from_email = ? WHERE id = ?',
        [email.receivedDateTime, subject, body, fromEmail, app.id]).catch(() => {});
      try { await notifyEmailReply(user.id, app.company_name, subject); } catch (_) {}   // in-app + push
      found++;
    }
  }
  return found;
}

async function getLastRun() {
  try { const r = await dbConfig.get(`SELECT last_run_at FROM system_schedule WHERE job_key = ?`, [JOB_KEY]); return r ? r.last_run_at : null; }
  catch { return null; }
}
async function setLastRun(summary) {
  try {
    await dbConfig.run(
      `INSERT INTO system_schedule (job_key, last_run_at, last_summary) VALUES (?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT (job_key) DO UPDATE SET last_run_at = CURRENT_TIMESTAMP, last_summary = EXCLUDED.last_summary`,
      [JOB_KEY, summary || null]);
  } catch (_) {}
}

// One poll cycle: every Microsoft user with a recent application + refresh token.
async function runReplyPoll({ force = false } = {}) {
  const last = await getLastRun();
  if (!force && last) {
    const mins = (Date.now() - new Date(last).getTime()) / 60000;
    if (mins < INTERVAL_MIN) return { skipped: true, reason: `last run ${mins.toFixed(0)}m ago` };
  }
  const users = await dbConfig.query(
    `SELECT DISTINCT u.id, u.email, u.microsoft_access_token, u.microsoft_refresh_token,
            u.microsoft_token_issued_at, u.microsoft_token_expires_at, u.oauth_provider
       FROM users u
       JOIN application_history ah ON ah.user_id = u.id
      WHERE u.oauth_provider = 'microsoft' AND u.microsoft_refresh_token IS NOT NULL
        AND ah.sent_date > NOW() - INTERVAL '${APP_WINDOW_DAYS} days'
      LIMIT ${MAX_USERS}`).catch(() => []);

  let usersChecked = 0, replies = 0, errored = 0;
  for (const u of users) {
    try { replies += await checkUserMicrosoftReplies(u); usersChecked++; }
    catch (e) { errored++; }
  }
  const summary = `checked ${usersChecked}/${users.length} MS users — ${replies} new repl${replies === 1 ? 'y' : 'ies'}, ${errored} errored`;
  await setLastRun(summary);
  if (replies || errored) console.log(`[replyPoll] ${summary}`);
  return { usersChecked, replies, errored, users: users.length, summary };
}

function startReplyPoller() {
  if (process.env.REPLY_POLL_DISABLED === '1') { console.log('📬 Reply poller: DISABLED (REPLY_POLL_DISABLED=1)'); return; }
  const tick = () => runReplyPoll().catch((e) => console.error('[replyPoll] tick:', e.message));
  setTimeout(tick, 3 * 60 * 1000);                       // first run a few min after boot
  setInterval(tick, INTERVAL_MIN * 60 * 1000);
  console.log(`📬 Reply poller: scheduled (every ${INTERVAL_MIN}m, Microsoft/Outlook)`);
}

module.exports = { runReplyPoll, checkUserMicrosoftReplies, startReplyPoller };
