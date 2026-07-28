// Support routes — ADDITIVE.
//
// Two families, two middlewares, and the split matters:
//   /api/support/*        authenticateToken  — the signed-in user, acting on THEIR OWN threads
//   /api/admin/support/*  authenticateAdmin  — staff, acting on any thread
//
// The `sender` of a message is decided HERE, from which middleware ran, and is never read from the
// request body. A user cannot post a message that claims to be from support by adding a field to
// their JSON, because nothing in this file looks at such a field.
//
//   GET    /api/support/issues                     the card catalogue
//   GET    /api/support/threads                    my threads + unread total
//   POST   /api/support/threads                    { issueKey, details? } → open/continue a thread
//   GET    /api/support/threads/:id/messages       oldest→newest page (?before= for history)
//   POST   /api/support/threads/:id/messages       { body }
//   POST   /api/support/threads/:id/read           clear my badge
//   POST   /api/support/threads/:id/mute           { muted }
//
//   GET    /api/admin/support/threads              inbox (?status=open|resolved|all)
//   GET    /api/admin/support/threads/:id/messages one thread, full detail
//   POST   /api/admin/support/threads/:id/messages { body } → reply + push the user
//   POST   /api/admin/support/threads/:id/read     clear the admin badge
//   POST   /api/admin/support/threads/:id/status   { status: open|resolved }
const express = require('express');
const router = express.Router();
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const svc = require('../services/supportService');

const uid = (req) => (req.user && parseInt(req.user.id, 10)) || 0;
const fail = (res, r) => {
  const map = {
    not_found: [404, 'Not found'],
    unknown_issue: [400, 'Unknown issue type'],
    bad_thread: [400, 'Invalid thread'],
    bad_user: [400, 'Invalid user'],
    bad_status: [400, 'Status must be open or resolved'],
    empty: [400, 'Message cannot be empty'],
    closed: [409, 'This conversation is closed — start a new report'],
    too_fast: [429, 'You are sending messages too quickly'],
    too_many_open: [429, 'You already have several open reports — please continue one of those'],
  };
  const [code, msg] = map[r.error] || [500, 'Something went wrong'];
  return res.status(code).json({ error: msg, code: r.error, ...(r.waitSeconds ? { waitSeconds: r.waitSeconds } : {}), ...(r.max ? { max: r.max } : {}) });
};

// ── user ─────────────────────────────────────────────────────────────────────
router.get('/support/issues', authenticateToken, (req, res) => {
  res.json({ success: true, issues: svc.listIssues(), detailsMax: svc.DETAILS_MAX, bodyMax: svc.BODY_MAX });
});

router.get('/support/threads', authenticateToken, async (req, res) => {
  try { res.json({ success: true, ...await svc.listUserThreads(uid(req)) }); }
  catch (e) { console.error('[support] list:', e.message); res.status(500).json({ error: 'Could not load your reports' }); }
});

router.post('/support/threads', authenticateToken, async (req, res) => {
  try {
    const r = await svc.createThread(uid(req), req.body && req.body.issueKey, req.body && req.body.details);
    if (r.error) return fail(res, r);
    res.json({ success: true, ...r });
  } catch (e) { console.error('[support] create:', e.message); res.status(500).json({ error: 'Could not start the report' }); }
});

router.get('/support/threads/:id/messages', authenticateToken, async (req, res) => {
  try {
    const r = await svc.threadMessages(req.params.id, { userId: uid(req), limit: req.query.limit, before: req.query.before });
    if (r.error) return fail(res, r);
    res.json({ success: true, ...r });
  } catch (e) { console.error('[support] messages:', e.message); res.status(500).json({ error: 'Could not load the conversation' }); }
});

router.post('/support/threads/:id/messages', authenticateToken, async (req, res) => {
  try {
    // 'user' is fixed here — not taken from the body.
    const r = await svc.postMessage(uid(req), req.params.id, req.body && req.body.body, 'user');
    if (r.error) return fail(res, r);
    // Staff notification happens inside postMessage, so it cannot be forgotten by a caller.
    res.json({ success: true, ...r });
  } catch (e) { console.error('[support] post:', e.message); res.status(500).json({ error: 'Could not send your message' }); }
});

router.post('/support/threads/:id/read', authenticateToken, async (req, res) => {
  try {
    const r = await svc.markRead(req.params.id, { userId: uid(req) });
    if (r.error) return fail(res, r);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Could not update' }); }
});

router.post('/support/threads/:id/mute', authenticateToken, async (req, res) => {
  try {
    const r = await svc.setMuted(req.params.id, uid(req), !!(req.body && req.body.muted));
    if (r.error) return fail(res, r);
    res.json({ success: true, muted: r.muted });
  } catch (e) { res.status(500).json({ error: 'Could not update' }); }
});

// ── admin ────────────────────────────────────────────────────────────────────
router.get('/admin/support/threads', authenticateAdmin, async (req, res) => {
  try { res.json({ success: true, ...await svc.listAdminThreads({ status: req.query.status || 'open', limit: req.query.limit, offset: req.query.offset }) }); }
  catch (e) { console.error('[support] inbox:', e.message); res.status(500).json({ error: 'Could not load the inbox' }); }
});

router.get('/admin/support/threads/:id/messages', authenticateAdmin, async (req, res) => {
  try {
    const r = await svc.threadMessages(req.params.id, { limit: req.query.limit, before: req.query.before });
    if (r.error) return fail(res, r);
    res.json({ success: true, ...r });
  } catch (e) { res.status(500).json({ error: 'Could not load the conversation' }); }
});

router.post('/admin/support/threads/:id/messages', authenticateAdmin, async (req, res) => {
  try {
    const r = await svc.adminReply(req.params.id, uid(req), req.body && req.body.body);
    if (r.error) return fail(res, r);
    res.json({ success: true, ...r });
  } catch (e) { console.error('[support] reply:', e.message); res.status(500).json({ error: 'Could not send the reply' }); }
});

router.post('/admin/support/threads/:id/read', authenticateAdmin, async (req, res) => {
  try { await svc.markRead(req.params.id, { admin: true }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: 'Could not update' }); }
});

router.post('/admin/support/threads/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const r = await svc.setStatus(req.params.id, req.body && req.body.status);
    if (r.error) return fail(res, r);
    res.json({ success: true, thread: r.thread });
  } catch (e) { res.status(500).json({ error: 'Could not update' }); }
});

module.exports = router;
