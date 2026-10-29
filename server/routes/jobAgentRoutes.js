// The Job Agent — find, score, prepare and (by email) send applications for the user (services/jobAgent.js).
// ADDITIVE. Every route is the user's own agent; the admin pair sets the per-plan monthly limits.
'use strict';
const express = require('express');
const router = express.Router();
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const { asJob } = require('../middleware/asyncJob');
const agent = require('../services/jobAgent');
const { requestEnvironment } = require('../services/storeEnvironment');

const ERR_STATUS = { not_found: 404, roles_required: 400, bad_limit: 400, not_preparable: 409, not_ready: 409,
  not_email_channel: 409, not_prepared: 409, monthly_limit: 402, quota_exhausted: 402, paid_required: 402, already_running: 409,
  run_failed: 503, unknown_outcome: 409, downloads_used: 402, payer_changed: 409 };
// `reason` as well as `error`: an async job (asJob) records a refusal's reason only from body.reason.
const fail = (res, error, extra = {}) => res.status(ERR_STATUS[error] || 400).json({ success: false, error, reason: error, ...extra });
const deviceOf = (req) => { const d = String(req.headers['x-device-id'] || '').trim(); return /^[A-Za-z0-9_-]{8,80}$/.test(d) ? d : null; };

// GET /api/job-agent — settings, this month's allowance, queue counts.
router.get('/job-agent', authenticateToken, async (req, res) => {
  try { res.json({ success: true, ...(await agent.overview(req.user.id, requestEnvironment(req))) }); }
  catch (e) { console.warn('[jobAgent] overview:', e.message); res.status(500).json({ success: false, error: 'unavailable' }); }
});

// PUT /api/job-agent/settings { enabled?, criteria?, sendMode?, dailyCap? }
router.put('/job-agent/settings', authenticateToken, async (req, res) => {
  try {
    const r = await agent.saveSettings(req.user.id, req.body || {}, { env: requestEnvironment(req), deviceId: deviceOf(req) });
    if (r.error) return fail(res, r.error);
    res.json({ success: true, settings: r.settings });
  } catch (e) { console.warn('[jobAgent] settings:', e.message); res.status(500).json({ success: false, error: 'unavailable' }); }
});

// GET /api/job-agent/queue?status=
router.get('/job-agent/queue', authenticateToken, async (req, res) => {
  try { res.json({ success: true, items: await agent.listQueue(req.user.id, { status: req.query.status }) }); }
  catch (e) { console.warn('[jobAgent] queue:', e.message); res.status(500).json({ success: false, error: 'unavailable' }); }
});

// POST /api/job-agent/run — "Find jobs now". Minutes long (documents), so the app sends __async and polls the job.
// At most one manual run per user per hour: a run spends AI, and the queue does not change faster than that.
const lastManual = new Map();
router.post('/job-agent/run', authenticateToken, asJob('job_agent_run')(async (req, res) => {
  const uid = req.user.id;
  const last = lastManual.get(uid) || 0;
  if (Date.now() - last < 60 * 60 * 1000) return res.status(429).json({ success: false, error: 'too_soon', reason: 'too_soon', retryAfterMs: 60 * 60 * 1000 - (Date.now() - last) });
  lastManual.set(uid, Date.now());
  const summary = await agent.runForUser(uid, { manual: true });
  if (summary.error === 'already_running') { lastManual.delete(uid); return fail(res, 'already_running'); }
  // A run that FAILED (the AI unavailable) did nothing — the user may try again at once, not in an hour.
  if (summary.error) { lastManual.delete(uid); return fail(res, 'run_failed', { summary }); }
  res.json({ success: true, summary });
}));

// POST /api/job-agent/queue/:id/prepare — write this one's documents now (inside the monthly allowance).
router.post('/job-agent/queue/:id/prepare', authenticateToken, asJob('job_agent_prepare')(async (req, res) => {
  const r = await agent.prepareNow(req.user.id, req.params.id);
  if (r.error) return fail(res, r.error, r.allowance ? { allowance: r.allowance } : {});
  res.json({ success: true, item: r.item });
}));

// POST /api/job-agent/queue/:id/send — email this application from the user's own mailbox.
router.post('/job-agent/queue/:id/send', authenticateToken, asJob('job_agent_send')(async (req, res) => {
  const r = await agent.sendNow(req.user.id, req.params.id);
  if (r.error) return fail(res, r.error);
  res.json({ success: true, item: r.item });
}));

// POST /api/job-agent/queue/:id/applied — the user submitted it themselves (company form, Auto Fill).
router.post('/job-agent/queue/:id/applied', authenticateToken, async (req, res) => {
  const r = await agent.markApplied(req.user.id, req.params.id);
  if (r.error) return fail(res, r.error);
  res.json({ success: true });
});

// POST /api/job-agent/queue/:id/skip
router.post('/job-agent/queue/:id/skip', authenticateToken, async (req, res) => {
  const r = await agent.skip(req.user.id, req.params.id);
  if (r.error) return fail(res, r.error);
  res.json({ success: true });
});

// Admin: per-plan monthly limits (prepared applications). GET lists defaults + overrides; PUT { planKey, monthly }.
router.get('/admin/job-agent/limits', authenticateToken, authenticateAdmin, async (_req, res) => {
  res.json({ success: true, limits: await agent.getLimits() });
});
router.put('/admin/job-agent/limits', authenticateToken, authenticateAdmin, async (req, res) => {
  const r = await agent.setLimit(String((req.body || {}).planKey || ''), (req.body || {}).monthly);
  if (r.error) return fail(res, r.error);
  res.json({ success: true, limits: r.limits });
});

module.exports = router;
