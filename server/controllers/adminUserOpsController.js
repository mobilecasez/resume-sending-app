// Admin user-ops HTTP layer — ADDITIVE. Thin: validation + status codes only. Every rule that
// protects a real user's phone (opt-outs, 72h dedupe, confirm-to-send, recipient caps, soft-delete
// exclusion) lives in server/services/adminUserOps.js so no route can accidentally bypass it.
'use strict';

const ops = require('../services/adminUserOps');
const resumeView = require('../services/adminResumeView');
const searchView = require('../services/adminSearchView');

const idOf = (req) => {
  const n = parseInt(req.params.id, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// ── Résumé: the readable profile, and a PDF of it ────────────────────────────
// GET /api/admin/users/:id/resume-profile
async function getResumeProfile(req, res) {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: 'Invalid user id' });
  try {
    const data = await resumeView.getResumeProfile(id);
    if (data.reason === 'user_not_found') return res.status(404).json({ error: 'User not found (or soft-deleted)' });
    res.json({ success: true, ...data });
  } catch (e) {
    console.error('[adminUserOps] resume-profile:', e.message);
    res.status(500).json({ error: 'Failed to load résumé profile' });
  }
}

// GET /api/admin/users/:id/resume-pdf
// Renders the SAME templates users get, from whichever source we hold. This is the answer to
// "the résumé won't open": a PDF the admin can actually read, instead of a raw upload that
// Android's WebView cannot display and that the hardened viewer is right to refuse to run.
async function getResumePdf(req, res) {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: 'Invalid user id' });
  try {
    const profile = await resumeView.getResumeProfile(id);
    if (!profile.available) {
      return res.status(404).json({
        error: 'Nothing to render',
        reason: profile.reason,
        detail: profile.detail || null,
      });
    }
    const { renderPdf } = require('../utils/resumeRenderer');
    const resumeData = resumeView.toTemplateResume(profile);
    // 'ats' is the plainest, most legible template and needs no photo — the right default when the
    // point is to READ what we hold on this candidate rather than to style it. ?template= overrides
    // it, validated against the real list so a typo can't reach the renderer.
    const { TEMPLATE_IDS } = require('../utils/resumeTemplates');
    const want = String(req.query.template || '').trim();
    const tpl = TEMPLATE_IDS.includes(want) ? want : 'ats';
    const buf = await renderPdf(tpl, resumeData, { mode: 'a4' });
    const safe = String((profile.identity && profile.identity.full_name) || `user_${id}`)
      .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || `user_${id}`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safe}_resume.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  } catch (e) {
    console.error('[adminUserOps] resume-pdf:', e.message);
    res.status(500).json({ error: 'Failed to render the résumé PDF', detail: e.message });
  }
}

// ── Searches: what was typed, what came back, and whether it worked ──────────
// GET /api/admin/users/:id/searches
async function getSearches(req, res) {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: 'Invalid user id' });
  try {
    res.json({ success: true, ...await searchView.listSearches(id, req.query.limit, req.query.offset) });
  } catch (e) {
    console.error('[adminUserOps] searches:', e.message);
    res.status(500).json({ error: 'Failed to load searches' });
  }
}

// GET /api/admin/users/:id/searches/:employerId/jobs
async function getSearchJobs(req, res) {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: 'Invalid user id' });
  try {
    const data = await searchView.searchJobs(id, req.params.employerId, req.query.limit);
    if (data.error === 'bad_request') return res.status(400).json({ error: 'Invalid request' });
    // Scoping matters here: an admin browsing user A must not be able to page through employer
    // records that only user B ever searched, by swapping the id in the URL.
    if (data.error === 'not_this_users_search') return res.status(404).json({ error: 'This user did not search that employer' });
    res.json({ success: true, ...data });
  } catch (e) {
    console.error('[adminUserOps] search jobs:', e.message);
    res.status(500).json({ error: 'Failed to load the jobs for that search' });
  }
}

// POST /api/admin/users/:id/test-cover-letter   { jobId }
// Runs the REAL generator on the REAL user's résumé so the admin sees exactly what the user would.
// Two things it must not do, both enforced here rather than in the generator: bill the user, and
// leave a record behind. `adminTest` is set server-side; a client cannot ask for a free letter.
async function testCoverLetter(req, res) {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: 'Invalid user id' });
  const jobId = String((req.body && req.body.jobId) || '').trim();
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });
  try {
    const { generateJobCoverLetter } = require('./aiHubController');
    // A synthetic request carrying the TARGET user's identity — the letter must be written from
    // their résumé, not the admin's.
    const fakeReq = { user: { id }, params: { jobId }, body: {}, adminTest: true };
    await generateJobCoverLetter(fakeReq, res);
  } catch (e) {
    console.error('[adminUserOps] test cover letter:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate a test cover letter', detail: e.message });
  }
}

// POST /api/admin/resume-reparse            { userId? , limit? }
// Runs the résumé re-parse sweep NOW. Exists because a scheduler you can only observe by waiting
// 30 minutes is a scheduler you cannot debug — and because an admin looking at a user whose résumé
// failed should be able to retry it on the spot rather than tell them to re-upload.
async function reparseResumes(req, res) {
  try {
    const svc = require('../../services/resumeParserService');
    const userId = parseInt((req.body && req.body.userId) || 0, 10);
    if (userId > 0) {
      const u = await require('../../db-config')
        .get('SELECT resume_path FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
      if (!u) return res.status(404).json({ error: 'User not found (or soft-deleted)' });
      if (!String(u.resume_path || '').trim()) return res.status(400).json({ error: 'That user has no résumé on file' });
      await svc._parseResume(userId, u.resume_path);
      const m = await require('../../db-config')
        .get('SELECT parse_status, parse_error FROM resume_metadata WHERE user_id = $1', [userId]);
      return res.json({
        success: true, scope: 'user', userId,
        parseStatus: m ? m.parse_status : null,
        parseError: m ? m.parse_error : null,
      });
    }
    const limit = Math.min(25, Math.max(1, parseInt((req.body && req.body.limit) || 5, 10)));
    const r = await svc.retryStuckResumes({ limit });
    res.json({ success: true, scope: 'sweep', ...r });
  } catch (e) {
    console.error('[adminUserOps] resume reparse:', e.message);
    res.status(500).json({ error: 'Re-parse failed', detail: e.message });
  }
}

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

// 3b) GET /api/admin/users/:id/activity?kind=cover_letters&limit=25&offset=0
// The ITEMS behind the overview's counts. `kind` is validated in the service against one
// allow-list so the route and the service can never drift apart.
async function getActivity(req, res) {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: 'Invalid user id' });
  try {
    const data = await ops.getUserActivity(id, req.query.kind, {
      limit: req.query.limit,
      offset: req.query.offset,
    });
    if (data.notFound) return res.status(404).json({ error: 'User not found (or soft-deleted)' });
    if (data.badKind) {
      return res.status(400).json({
        error: `kind must be one of: ${data.kinds.join(', ')}`,
        kinds: data.kinds,
      });
    }
    // A query that ERRORED must not be drawn as a convincing empty list.
    if (data.dbError) {
      console.error('[adminUserOps] activity query failed:', data.dbError);
      return res.status(500).json({ error: 'Failed to load user activity', detail: data.dbError });
    }
    res.json({ success: true, ...data });
  } catch (e) {
    console.error('[adminUserOps] activity:', e.message);
    res.status(500).json({ error: 'Failed to load user activity' });
  }
}

// 3c) GET /api/admin/users/:id/cover-letters/:letterId — one full letter, scoped to its owner
async function getCoverLetter(req, res) {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: 'Invalid user id' });
  const letterId = parseInt(req.params.letterId, 10);
  if (!Number.isFinite(letterId) || letterId <= 0) {
    return res.status(400).json({ error: 'Invalid cover letter id' });
  }
  try {
    const data = await ops.getUserCoverLetter(id, letterId);
    // Same 404 for "no such letter", "letter belongs to someone else" and "user is soft-deleted" —
    // the response must not confirm that an id exists under another account.
    if (data.notFound) return res.status(404).json({ error: 'Cover letter not found for this user' });
    res.json({ success: true, letter: data.letter });
  } catch (e) {
    console.error('[adminUserOps] cover letter:', e.message);
    res.status(500).json({ error: 'Failed to load cover letter' });
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
  getOverview, getFile, getMatchedJobs, getActivity, getCoverLetter, getTemplates, notifyUser,
  getSegments, getSegmentUsers, notifySegmentUsers,
  getResumeProfile, getResumePdf, getSearches, getSearchJobs, testCoverLetter, reparseResumes,
};
