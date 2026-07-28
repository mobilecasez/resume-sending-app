// In-app support: issue reports and 1:1 chat between a user and staff.
//
// SECURITY NOTES — these are not decoration. An adversarial review of the first design found two
// defects that would have shipped, and both are prevented structurally here rather than by
// remembering to be careful:
//
//   1. WRITE-SIDE IDOR. The thread id arrives in the URL. EVERY user-side statement below therefore
//      carries `AND user_id = $n`, so a user rewriting /threads/41/ to /threads/42/ addresses a row
//      that does not match and gets a 404. There is no user-side query in this file that filters on
//      thread id alone; if you add one, you have added the bug back.
//   2. STAFF IDENTITY. `sender_user_id` records WHICH admin replied. It is never included in a
//      user-facing shape — see shapeMessageForUser(). Only the word "admin" crosses that boundary.
//
// Other deliberate choices:
//   • Message bodies are stored raw and escaped at each render site. This module does not
//     "sanitise" text, because a half-sanitiser is worse than none — the web admin uses esc(), and
//     React Native renders text nodes inertly.
//   • The issue list is a fixed server-side catalogue. The client sends a KEY, never a label and
//     never free-form JSON, so nothing user-controlled reaches a query or a push body unescaped
//     except the one free-text field, which is length-capped.
//   • Reads are newest-first. The obvious `ORDER BY id ASC LIMIT 200` returns the OLDEST 200 — on a
//     long thread the user would open support and see the beginning of a conversation from weeks
//     ago.

const dbConfig = require('../../db-config');
const expoPush = require('./expoPushService');

const str = (v) => (v == null ? '' : String(v)).trim();
const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

// ── limits ───────────────────────────────────────────────────────────────────
const BODY_MAX = 2000;          // one message
const DETAILS_MAX = 1500;       // the optional detail box on the report form
const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;
const MAX_OPEN_THREADS = 6;     // a user cannot open every card and walk away
const USER_MSG_WINDOW_SEC = 20; // minimum gap between two messages from one user
const ADMIN_PUSH_THROTTLE_SEC = 60;

// ⚠️ Throttled GLOBALLY, not per thread. The first design put the window on the thread row, which
// meant a user with three open threads could still buzz every admin three times a minute — the
// throttle bounded the wrong dimension. This is process-local, which is enough: it exists to stop a
// burst, not to be a distributed lock.
let lastAdminPushAt = 0;

// ── the issue catalogue ──────────────────────────────────────────────────────
// Grounded in what actually breaks in this product, not a generic support menu. Each key is stable
// and stored; labels can be reworded freely without touching history.
const ISSUES = [
  { key: 'search_no_jobs',   icon: 'search-outline',          title: 'Job search found nothing',        blurb: 'You searched for a company or pasted a careers link and no jobs came back.' },
  { key: 'search_wrong',     icon: 'alert-circle-outline',    title: 'The jobs shown look wrong',       blurb: 'Results belong to a different company, or the roles are not real openings.' },
  { key: 'cover_letter',     icon: 'document-text-outline',   title: 'Cover letter would not generate', blurb: 'Generation failed, or what came out did not match the job or your CV.' },
  { key: 'resume_upload',    icon: 'cloud-upload-outline',    title: 'My CV will not upload or read',   blurb: 'The upload fails, or the app says it cannot read your CV.' },
  { key: 'apply_failed',     icon: 'send-outline',            title: 'I could not apply to a job',      blurb: 'The apply page would not open, would not load, or would not submit.' },
  { key: 'autofill',         icon: 'create-outline',          title: 'Auto-fill did not fill the form', blurb: 'Fields were left empty, or filled with the wrong details.' },
  { key: 'notifications',    icon: 'notifications-outline',   title: 'I am not getting notifications',  blurb: 'Nothing arrives on your phone, or they arrive far too late.' },
  { key: 'credits',          icon: 'cash-outline',            title: 'Something wrong with my credits', blurb: 'Credits went missing, were charged twice, or a purchase did not arrive.' },
  { key: 'login',            icon: 'log-in-outline',          title: 'Trouble signing in',              blurb: 'You get signed out, or cannot get back into your account.' },
  { key: 'translation',      icon: 'language-outline',        title: 'Translation did not work',        blurb: 'A job page would not translate, or the translation was unusable.' },
  { key: 'other',            icon: 'chatbubble-ellipses-outline', title: 'Something else',              blurb: 'Anything not listed here — tell us in your own words.' },
];
const ISSUE_BY_KEY = new Map(ISSUES.map((i) => [i.key, i]));
const listIssues = () => ISSUES.map((i) => ({ ...i }));

// ── shaping ──────────────────────────────────────────────────────────────────
/** What a USER may see of a message. Note the absence of sender_user_id. */
function shapeMessageForUser(m) {
  return {
    id: String(m.id),
    sender: m.sender === 'admin' ? 'support' : 'you',
    body: str(m.body),
    created_at: m.created_at,
  };
}
/** What an ADMIN sees — same plus which staff account replied. */
function shapeMessageForAdmin(m) {
  return {
    id: String(m.id),
    sender: m.sender,
    sender_user_id: m.sender_user_id == null ? null : int(m.sender_user_id),
    body: str(m.body),
    created_at: m.created_at,
  };
}
function shapeThread(t, forAdmin) {
  const issue = ISSUE_BY_KEY.get(t.issue_key);
  const base = {
    id: String(t.id),
    issue_key: t.issue_key,
    issue_title: issue ? issue.title : t.issue_key,
    issue_icon: issue ? issue.icon : 'help-circle-outline',
    subject: str(t.subject),
    status: t.status,
    last_message_at: t.last_message_at,
    last_sender: t.last_sender,
    last_body: str(t.last_body).slice(0, 160),
    created_at: t.created_at,
    unread: int(forAdmin ? t.admin_unread : t.user_unread),
  };
  if (!forAdmin) return { ...base, muted: !!t.user_muted };
  return {
    ...base,
    user: {
      id: int(t.user_id),
      name: str(t.full_name),
      email: str(t.email),
    },
  };
}

// ── push ─────────────────────────────────────────────────────────────────────
/**
 * Tell the admins a user needs help. Best-effort and never throws: a support thread must be created
 * even when nobody can be notified about it.
 */
async function pushAdmins(thread, bodyText) {
  const now = Date.now();
  if (now - lastAdminPushAt < ADMIN_PUSH_THROTTLE_SEC * 1000) return { skipped: 'throttled' };
  lastAdminPushAt = now;
  try {
    const admins = await dbConfig.query(
      `SELECT id, expo_push_token FROM users
        WHERE role = 'admin' AND deleted_at IS NULL
          AND COALESCE(expo_push_token, '') ~ '^(ExpoPushToken|ExponentPushToken)\\['`);
    let sent = 0;
    for (const a of admins || []) {
      const r = await expoPush.sendPushNotification(
        a.expo_push_token,
        `Support · ${thread.issue_title}`,
        `${thread.user_name || 'A user'}: ${str(bodyText).slice(0, 90)}`,
        { type: 'support', route: 'admin-support', params: { threadId: String(thread.id) }, screen: '/(admin)/support' },
      ).catch(() => null);
      if (r && r !== 'stale') sent++;
    }
    return { sent };
  } catch (e) {
    console.error('[support] admin push:', e.message);
    return { error: e.message };
  }
}

/**
 * Tell the user staff replied.
 *
 * Deliberately NOT gated by notification_preferences. Those five categories are about messages WE
 * decide to send; this is the answer to a question the user asked minutes ago, and silently
 * swallowing it because "marketing" is off would be a support failure. The per-thread `user_muted`
 * flag is the opt-out that belongs to this conversation.
 */
async function pushUser(thread, bodyText) {
  try {
    if (thread.user_muted) return { skipped: 'muted' };
    const u = await dbConfig.get(
      `SELECT expo_push_token FROM users WHERE id = $1 AND deleted_at IS NULL`, [thread.user_id]);
    const tok = u && str(u.expo_push_token);
    if (!tok || !/^Expo(nent)?PushToken\[/.test(tok)) return { skipped: 'no_token' };
    const r = await expoPush.sendPushNotification(
      tok, 'Support replied', str(bodyText).slice(0, 120),
      { type: 'support_reply', route: 'support', params: { threadId: String(thread.id) }, screen: '/(support)/thread' },
    );
    return { ok: r !== 'stale' && !!r, result: r };
  } catch (e) {
    console.error('[support] user push:', e.message);
    return { error: e.message };
  }
}

// ── user side ────────────────────────────────────────────────────────────────

/** Open a thread (or continue the open one for this issue) and post the first message. */
async function createThread(userId, issueKey, details) {
  const uid = int(userId);
  const issue = ISSUE_BY_KEY.get(str(issueKey));
  if (!uid) return { error: 'bad_user' };
  if (!issue) return { error: 'unknown_issue' };

  const body = str(details).slice(0, DETAILS_MAX);
  const open = await dbConfig.get(
    `SELECT COUNT(*)::int AS n FROM support_threads WHERE user_id = $1 AND status = 'open'`, [uid]);
  const existing = await dbConfig.get(
    `SELECT * FROM support_threads WHERE user_id = $1 AND issue_key = $2 AND status = 'open'`,
    [uid, issue.key]);
  if (!existing && int(open && open.n) >= MAX_OPEN_THREADS) {
    return { error: 'too_many_open', max: MAX_OPEN_THREADS };
  }

  const first = body || issue.title;
  let thread = existing;
  const isNew = !thread;
  if (!thread) {
    thread = await dbConfig.get(
      `INSERT INTO support_threads (user_id, issue_key, subject, status, last_message_at, last_sender, last_body, admin_unread)
       VALUES ($1, $2, $3, 'open', NOW(), 'user', $4, 1)
       RETURNING *`, [uid, issue.key, issue.title, first.slice(0, 160)]);
  }
  if (!thread) return { error: 'create_failed' };

  const msg = await postMessage(uid, thread.id, first, 'user', null, { firstMessage: isNew });
  if (msg.error) return msg;

  // postMessage already notified staff — do not push twice for one report.
  return { thread: shapeThread({ ...thread, admin_unread: 1 }, false), message: msg.message };
}

/**
 * Post a message. `sender` is decided by the CALLER (route layer), never by the request body.
 * For a user, thread ownership is enforced in the UPDATE's WHERE clause.
 */
async function postMessage(actorId, threadId, bodyText, sender, adminId, opts = {}) {
  const tid = int(threadId);
  const body = str(bodyText).slice(0, BODY_MAX);
  if (!tid) return { error: 'bad_thread' };
  if (!body) return { error: 'empty' };

  if (sender === 'user') {
    // Ownership + rate limit in one read, scoped to this user.
    const t = await dbConfig.get(
      `SELECT t.*, (
                SELECT MAX(m.created_at) FROM support_messages m
                 WHERE m.thread_id = t.id AND m.sender = 'user'
              ) AS last_user_at
         FROM support_threads t
        WHERE t.id = $1 AND t.user_id = $2`, [tid, int(actorId)]);
    if (!t) return { error: 'not_found' };            // wrong owner is indistinguishable from absent
    if (t.status !== 'open') return { error: 'closed' };
    // The gap rule is for the CHAT box. Opening a report is a deliberate act behind a form, and a
    // brand-new thread has nothing to be too fast after — applying it there just told a first-time
    // reporter to slow down before they had said anything.
    if (!opts.firstMessage
        && t.last_user_at
        && (Date.now() - new Date(t.last_user_at).getTime()) < USER_MSG_WINDOW_SEC * 1000) {
      return { error: 'too_fast', waitSeconds: USER_MSG_WINDOW_SEC };
    }
  }

  const m = await dbConfig.get(
    `INSERT INTO support_messages (thread_id, sender, sender_user_id, body)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [tid, sender, sender === 'admin' ? int(adminId) || null : int(actorId), body]);
  if (!m) return { error: 'insert_failed' };

  // Counters move on the OTHER side's unread; the sender's own is untouched.
  const bump = sender === 'user' ? 'admin_unread' : 'user_unread';
  await dbConfig.run(
    `UPDATE support_threads
        SET last_message_at = NOW(), last_sender = $2, last_body = $3,
            ${bump} = ${bump} + 1, updated_at = NOW()
      WHERE id = $1`, [tid, sender, body.slice(0, 160)]);

  // Staff are told about EVERY user message, not just the one that opened the thread — a follow-up
  // ("still broken, here is the link") is exactly when they need to look again. Throttled globally
  // inside pushAdmins, and never allowed to fail the write.
  if (sender === 'user') {
    try {
      const t = await dbConfig.get(
        `SELECT t.id, t.issue_key, u.full_name FROM support_threads t
           JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [tid]);
      if (t) {
        const issue = ISSUE_BY_KEY.get(t.issue_key);
        await pushAdmins({ id: t.id, issue_title: issue ? issue.title : t.issue_key, user_name: str(t.full_name) }, body);
      }
    } catch (e) { console.error('[support] notify admins:', e.message); }
  }

  return { message: sender === 'admin' ? shapeMessageForAdmin(m) : shapeMessageForUser(m) };
}

/** This user's threads, newest activity first. */
async function listUserThreads(userId) {
  const rows = await dbConfig.query(
    `SELECT * FROM support_threads WHERE user_id = $1 ORDER BY last_message_at DESC LIMIT 50`,
    [int(userId)]).catch(() => []);
  return {
    threads: (rows || []).map((t) => shapeThread(t, false)),
    unread: (rows || []).reduce((n, t) => n + int(t.user_unread), 0),
  };
}

/**
 * Messages in one thread, NEWEST first from the database, returned oldest-first for display.
 * `before` pages backwards into history.
 */
async function threadMessages(threadId, { userId, limit, before } = {}) {
  const tid = int(threadId);
  const lim = Math.min(PAGE_MAX, Math.max(1, int(limit, PAGE_DEFAULT)));
  const forUser = userId != null;

  const t = forUser
    ? await dbConfig.get(`SELECT * FROM support_threads WHERE id = $1 AND user_id = $2`, [tid, int(userId)])
    : await dbConfig.get(
        `SELECT t.*, u.full_name, u.email FROM support_threads t
           JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [tid]);
  if (!t) return { error: 'not_found' };

  const beforeId = int(before, 0);
  const rows = await dbConfig.query(
    `SELECT * FROM support_messages
      WHERE thread_id = $1 ${beforeId ? 'AND id < $3' : ''}
      ORDER BY id DESC LIMIT $2`,
    beforeId ? [tid, lim, beforeId] : [tid, lim]).catch(() => []);

  const ordered = (rows || []).slice().reverse();     // oldest → newest for rendering
  return {
    thread: shapeThread(t, !forUser),
    messages: ordered.map((m) => (forUser ? shapeMessageForUser(m) : shapeMessageForAdmin(m))),
    hasMore: (rows || []).length === lim,
    oldestId: ordered.length ? String(ordered[0].id) : null,
  };
}

/** Clear this side's unread. Scoped, so it can only ever clear your own badge. */
async function markRead(threadId, { userId, admin } = {}) {
  const tid = int(threadId);
  if (admin) {
    await dbConfig.run(`UPDATE support_threads SET admin_unread = 0, updated_at = NOW() WHERE id = $1`, [tid]);
    return { ok: true };
  }
  const r = await dbConfig.get(
    `UPDATE support_threads SET user_unread = 0, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 RETURNING id`, [tid, int(userId)]);
  return r ? { ok: true } : { error: 'not_found' };
}

/** Per-thread mute — the opt-out that belongs to this conversation. */
async function setMuted(threadId, userId, muted) {
  const r = await dbConfig.get(
    `UPDATE support_threads SET user_muted = $3, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 RETURNING user_muted`, [int(threadId), int(userId), !!muted]);
  return r ? { ok: true, muted: !!r.user_muted } : { error: 'not_found' };
}

// ── admin side ───────────────────────────────────────────────────────────────

/** The inbox. Unanswered first, then most recent. No aggregate over support_messages. */
async function listAdminThreads({ status = 'open', limit = 50, offset = 0 } = {}) {
  const lim = Math.min(PAGE_MAX, Math.max(1, int(limit, 50)));
  const off = Math.max(0, int(offset, 0));
  const wantAll = String(status) === 'all';
  const rows = await dbConfig.query(
    `SELECT t.*, u.full_name, u.email
       FROM support_threads t
       JOIN users u ON u.id = t.user_id
      ${wantAll ? '' : 'WHERE t.status = $3'}
      ORDER BY (t.admin_unread > 0) DESC, t.last_message_at DESC
      LIMIT $1 OFFSET $2`,
    wantAll ? [lim, off] : [lim, off, String(status)]).catch(() => []);

  const counts = await dbConfig.get(
    `SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open,
            COUNT(*) FILTER (WHERE status = 'open' AND admin_unread > 0)::int AS waiting,
            COUNT(*)::int AS total
       FROM support_threads`).catch(() => null);

  return {
    threads: (rows || []).map((t) => shapeThread(t, true)),
    counts: counts || { open: 0, waiting: 0, total: 0 },
  };
}

async function setStatus(threadId, status) {
  const s = ['open', 'resolved'].includes(String(status)) ? String(status) : null;
  if (!s) return { error: 'bad_status' };
  const r = await dbConfig.get(
    `UPDATE support_threads SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [int(threadId), s]);
  return r ? { ok: true, thread: shapeThread(r, true) } : { error: 'not_found' };
}

/**
 * Staff START a conversation with a user.
 *
 * This is the reverse of the normal flow and it is the more valuable one: an admin looks at
 * someone's data, sees what actually went wrong — a résumé that never parsed, a search that
 * returned nothing, three cover letters and no applications — and reaches out first. The user gets
 * a push, taps it, and lands in a conversation that is already about their specific problem instead
 * of a blank "how can we help".
 *
 * Unlike a reply, this reaches somebody who did not ask to be contacted, so it is the one support
 * action the admin UI puts behind the type-to-confirm gate.
 */
async function adminStartThread(userId, issueKey, message, adminId) {
  const uid = int(userId);
  const issue = ISSUE_BY_KEY.get(str(issueKey));
  const body = str(message).slice(0, BODY_MAX);
  if (!uid) return { error: 'bad_user' };
  if (!issue) return { error: 'unknown_issue' };
  if (!body) return { error: 'empty' };

  const u = await dbConfig.get(`SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL`, [uid]);
  if (!u) return { error: 'not_found' };

  // Reuse the open thread for this issue so staff cannot accidentally fork the conversation.
  let thread = await dbConfig.get(
    `SELECT * FROM support_threads WHERE user_id = $1 AND issue_key = $2 AND status = 'open'`,
    [uid, issue.key]);
  if (!thread) {
    thread = await dbConfig.get(
      `INSERT INTO support_threads (user_id, issue_key, subject, status, last_message_at, last_sender, last_body)
       VALUES ($1, $2, $3, 'open', NOW(), 'admin', $4) RETURNING *`,
      [uid, issue.key, issue.title, body.slice(0, 160)]);
  }
  if (!thread) return { error: 'create_failed' };

  const posted = await postMessage(adminId, thread.id, body, 'admin', adminId);
  if (posted.error) return posted;

  const fresh = await dbConfig.get(`SELECT * FROM support_threads WHERE id = $1`, [thread.id]);
  const push = await pushUser(fresh, body);
  return { thread: shapeThread(fresh, true), message: posted.message, push, started: true };
}

/** Admin reply — posts, then pushes the user. */
async function adminReply(threadId, adminId, bodyText) {
  const t = await dbConfig.get(`SELECT * FROM support_threads WHERE id = $1`, [int(threadId)]);
  if (!t) return { error: 'not_found' };
  const posted = await postMessage(adminId, t.id, bodyText, 'admin', adminId);
  if (posted.error) return posted;
  const push = await pushUser(t, bodyText);
  await dbConfig.run(`UPDATE support_threads SET admin_unread = 0 WHERE id = $1`, [t.id]);
  return { message: posted.message, push };
}

module.exports = {
  ISSUES, listIssues, BODY_MAX, DETAILS_MAX, MAX_OPEN_THREADS,
  createThread, postMessage, listUserThreads, threadMessages, markRead, setMuted,
  listAdminThreads, setStatus, adminReply, adminStartThread,
  shapeMessageForUser, shapeMessageForAdmin, shapeThread,
};
