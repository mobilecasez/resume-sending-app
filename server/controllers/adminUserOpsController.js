// Admin user-ops HTTP layer — ADDITIVE. Thin: validation + status codes only. Every rule that
// protects a real user's phone (opt-outs, 72h dedupe, confirm-to-send, recipient caps, soft-delete
// exclusion) lives in server/services/adminUserOps.js so no route can accidentally bypass it.
'use strict';

const ops = require('../services/adminUserOps');

const idOf = (req) => {
  const n = parseInt(req.params.id, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// 1) GET /api/admin/users/:id/overview
async function getOverview(req, res) {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: 'Invalid user id' });
  try {
    const data = await ops.getUserOverview(id);
    if (data.notFound) return res.status(404).json({ error: 'User not found (or soft-deleted)' });
    res.json({ success: true, ...data });
  } catch (e) {
    console.error('[adminUserOps] overview:', e.message);
    res.status(500).json({ error: 'Failed to load user overview' });
  }
}

// 2) GET /api/admin/users/:id/files/:kind  (resume | photo | signature)
async function getFile(req, res) {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: 'Invalid user id' });
  try {
    const f = await ops.getUserFile(id, req.params.kind);
    if (f.error === 'bad_kind') return res.status(400).json({ error: 'kind must be resume, photo or signature' });
    if (f.error === 'user_not_found') return res.status(404).json({ error: 'User not found (or soft-deleted)' });
    if (f.error === 'not_set') return res.status(404).json({ error: `No ${req.params.kind} on file for this user` });
    if (f.error === 'outside_uploads') return res.status(404).json({ error: 'Stored path is outside the uploads directory — refusing to serve', stored: f.stored });
    if (f.error === 'missing_on_disk') return res.status(404).json({ error: 'File is recorded in the database but missing on disk', stored: f.stored });
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `inline; filename="${f.filename.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(f.path);
  } catch (e) {
    console.error('[adminUserOps] file:', e.message);
    res.status(500).json({ error: 'Failed to serve file' });
  }
}

// 3) GET /api/admin/users/:id/matched-jobs?limit=20
async function getMatchedJobs(req, res) {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: 'Invalid user id' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  try {
    const data = await ops.getMatchedJobs(id, limit);
    if (data.notFound) return res.status(404).json({ error: 'User not found (or soft-deleted)' });
    res.json({ success: true, ...data });
  } catch (e) {
    console.error('[adminUserOps] matched-jobs:', e.message);
    res.status(500).json({ error: 'Failed to load matched jobs' });
  }
}

// 4) GET /api/admin/notify/templates?userId=N&jobId=gj_x
async function getTemplates(req, res) {
  try {
    const userId = parseInt(req.query.userId, 10);
    const data = await ops.listTemplates(Number.isFinite(userId) && userId > 0 ? userId : null, req.query.jobId || null);
    res.json({ success: true, ...data });
  } catch (e) {
    console.error('[adminUserOps] templates:', e.message);
    res.status(500).json({ error: 'Failed to load templates' });
  }
}

// 5) POST /api/admin/users/:id/notify  { key, jobId?, overrides:{title?,body?} }
async function notifyUser(req, res) {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: 'Invalid user id' });
  const body = req.body || {};
  const key = String(body.key || body.templateKey || '').trim();
  if (!key) return res.status(400).json({ error: 'Missing template key' });
  const overrides = {};
  if (body.overrides && typeof body.overrides === 'object') {
    if (body.overrides.title) overrides.title = String(body.overrides.title).slice(0, 200);
    if (body.overrides.body) overrides.body = String(body.overrides.body).slice(0, 500);
  }
  try {
    const r = await ops.sendToUser({
      userId: id,
      templateKey: key,
      jobId: body.jobId ? String(body.jobId) : null,
      overrides,
      adminId: req.user && req.user.id,
    });
    if (r.skipped === 'unknown_template') return res.status(400).json({ error: r.error || 'Unknown template' });
    if (r.skipped === 'user_not_found') return res.status(404).json({ error: 'User not found (or soft-deleted)' });
    if (r.skipped === 'job_not_found') return res.status(400).json({ error: r.error });
    // opted_out / no_token / recently_sent are NOT errors — they are the rails doing their job.
    res.json({
      success: true,
      push: { ok: !!r.ok, error: r.error || r.skipped || undefined },
      skipped: r.skipped || null,
      logId: r.logId || null,
      sent: r.ok ? { title: r.title, body: r.body, route: r.route, params: r.params } : null,
    });
  } catch (e) {
    console.error('[adminUserOps] notify:', e.message);
    res.status(500).json({ error: 'Failed to send notification' });
  }
}

// 6) GET /api/admin/segments
async function getSegments(req, res) {
  try {
    const data = await ops.listSegments();
    res.json({ success: true, ...data });
  } catch (e) {
    console.error('[adminUserOps] segments:', e.message);
    res.status(500).json({ error: 'Failed to load segments' });
  }
}

// 7) GET /api/admin/segments/:key/users?limit=200&templateKey=...
async function getSegmentUsers(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
  try {
    const data = await ops.getSegmentUsers(req.params.key, limit, req.query.templateKey || null);
    if (data.notFound) return res.status(404).json({ error: 'Unknown segment' });
    res.json({ success: true, ...data });
  } catch (e) {
    console.error('[adminUserOps] segment users:', e.message);
    res.status(500).json({ error: 'Failed to load segment users' });
  }
}

// 8) POST /api/admin/segments/:key/notify  { templateKey, overrides?, confirm?, maxRecipients? }
async function notifySegmentUsers(req, res) {
  const body = req.body || {};
  const templateKey = String(body.templateKey || body.key || '').trim();
  if (!templateKey) return res.status(400).json({ error: 'Missing templateKey' });
  const overrides = {};
  if (body.overrides && typeof body.overrides === 'object') {
    if (body.overrides.title) overrides.title = String(body.overrides.title).slice(0, 200);
    if (body.overrides.body) overrides.body = String(body.overrides.body).slice(0, 500);
  }
  try {
    const r = await ops.notifySegment({
      key: req.params.key,
      templateKey,
      overrides,
      confirm: body.confirm === true || body.confirm === 'true',
      maxRecipients: body.maxRecipients,
      adminId: req.user && req.user.id,
    });
    if (r.error === 'unknown_segment') return res.status(404).json({ error: 'Unknown segment' });
    if (r.error === 'unknown_template') return res.status(400).json({ error: 'Unknown template' });
    if (r.error) return res.status(400).json({ error: r.message || r.error });
    res.json({ success: true, ...r });
  } catch (e) {
    console.error('[adminUserOps] segment notify:', e.message);
    res.status(500).json({ error: 'Failed to run segment notification' });
  }
}

module.exports = {
  getOverview, getFile, getMatchedJobs, getTemplates, notifyUser,
  getSegments, getSegmentUsers, notifySegmentUsers,
};
