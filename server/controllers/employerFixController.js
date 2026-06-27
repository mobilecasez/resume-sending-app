// HTTP layer for the self-improving employer fix loop.
//  • Users: submit a fix request for an employer we couldn't fetch + poll its status.
//  • Admin: see all requests (green/red), run/re-run the diagnostic agent ("rethink"),
//    view version history, roll back / re-apply, and turn a fix off.
'use strict';

const fix = require('../services/employerFix');
const agent = require('../services/employerDiagnosticAgent');

// Shared: run the diagnostic agent for a request, double-verify, and (if good)
// save an ACTIVE override so the next search for this employer just works.
async function runInvestigation(reqId) {
  const req = await fix.getFixRequest(reqId);
  if (!req) return null;
  await fix.updateRequest(reqId, { status: 'investigating', bumpAttempts: true });

  let result;
  try {
    result = await agent.investigate(req.employer_input);
  } catch (e) {
    await fix.updateRequest(reqId, { status: 'failed', diagnosis: { error: e.message, steps: ['agent crashed'] } });
    return { status: 'failed', error: e.message };
  }

  const dom = req.domain || fix.normDomain(req.employer_input);
  if (result.verified && result.fixConfig) {
    // Double-verified by the agent → auto-apply as the active override.
    await fix.saveOverride({
      domain: dom, requestId: reqId, fixConfig: result.fixConfig, verified: true,
      verifyJobCount: result.jobCount, verifySample: result.sample, createdBy: 'agent',
      notes: `auto-fix via ${result.diagnosis && result.diagnosis.method}`,
    });
    await fix.updateRequest(reqId, {
      status: 'resolved', diagnosis: result.diagnosis, jobCount: result.jobCount,
      detectedAts: (result.diagnosis && (result.diagnosis.ats || result.diagnosis.method)) || null, resolved: true,
    });
  } else {
    await fix.updateRequest(reqId, {
      status: result.status === 'needs_review' ? 'needs_review' : 'failed',
      diagnosis: result.diagnosis, jobCount: result.jobCount || 0,
    });
  }
  return result;
}

// ── User: submit a fix request (fire-and-forget investigation) ───────────────
async function submitFixRequest(req, res) {
  try {
    const employerInput = (req.body && (req.body.employerInput || req.body.employer || req.body.url || '')).trim();
    if (!employerInput) return res.status(400).json({ error: 'employerInput is required' });
    const userId = req.user && req.user.id;
    const email = req.user && req.user.email;
    const reqId = await fix.createFixRequest({ userId, email, employerInput });
    res.json({ requestId: reqId, status: 'investigating', message: "Thanks! We're learning this employer — check back in a minute." });
    // Investigate in the background so the user isn't blocked.
    setImmediate(() => runInvestigation(reqId).catch((e) => console.error('[employerFix] background investigate error:', e.message)));
  } catch (e) {
    console.error('[employerFix] submitFixRequest:', e.message);
    res.status(500).json({ error: 'Failed to submit request' });
  }
}

// ── User: poll a request's status (app re-runs the search when 'resolved') ───
async function getRequestStatus(req, res) {
  try {
    const r = await fix.getFixRequest(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json({ id: r.id, status: r.status, jobCount: r.job_count, domain: r.domain, resolved: !!r.resolved_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ── Admin: list every request with its active fix summary ────────────────────
async function adminListRequests(req, res) {
  try {
    const rows = await fix.listFixRequests({ status: req.query.status });
    const out = [];
    for (const r of rows) {
      const ov = await fix.getActiveOverride(r.domain);
      out.push({
        id: r.id, userId: r.user_id, email: r.email, employerInput: r.employer_input, domain: r.domain,
        detectedAts: r.detected_ats, jobCount: r.job_count, status: r.status,
        diagnosis: r.diagnosis, attempts: r.attempts,
        createdAt: r.created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at,
        activeOverride: ov ? {
          id: ov.id, version: ov.version, fixConfig: ov.fix_config, verified: ov.verified,
          verifyJobCount: ov.verify_job_count, verifySample: ov.verify_sample, createdBy: ov.created_by, notes: ov.notes,
        } : null,
      });
    }
    res.json({ requests: out });
  } catch (e) {
    console.error('[employerFix] adminListRequests:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Admin: run / re-run the agent on a request ("rethink / revisit deeper") ──
async function adminInvestigate(req, res) {
  try {
    const result = await runInvestigation(req.params.id);
    if (!result) return res.status(404).json({ error: 'request not found' });
    const { jobs, ...trimmed } = result; // drop the heavy full-jobs array from the admin response
    res.json({ ok: true, result: trimmed });
  } catch (e) {
    console.error('[employerFix] adminInvestigate:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Admin: full version history for a request's domain ───────────────────────
async function adminOverrideHistory(req, res) {
  try {
    const r = await fix.getFixRequest(req.params.id);
    if (!r) return res.status(404).json({ error: 'request not found' });
    const history = await fix.listOverrides(r.domain);
    res.json({
      domain: r.domain,
      overrides: history.map((o) => ({
        id: o.id, version: o.version, active: o.active, verified: o.verified,
        fixConfig: o.fix_config, verifyJobCount: o.verify_job_count, verifySample: o.verify_sample,
        createdBy: o.created_by, notes: o.notes, createdAt: o.created_at,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ── Admin: roll back / re-apply a specific version ───────────────────────────
async function adminActivateOverride(req, res) {
  try {
    const ok = await fix.setActiveOverride(req.params.overrideId);
    if (!ok) return res.status(404).json({ error: 'override not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ── Admin: turn the fix OFF for a domain (no active override) ─────────────────
async function adminDeactivate(req, res) {
  try {
    const r = await fix.getFixRequest(req.params.id);
    if (!r) return res.status(404).json({ error: 'request not found' });
    await fix.deactivateOverrides(r.domain);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ── Admin: run the daily fix-queue agent NOW (on-demand) ─────────────────────
async function adminRunFixQueue(req, res) {
  try {
    const { runFixQueue } = require('../services/fixQueueRunner'); // lazy-require avoids a cycle
    const result = await runFixQueue({ force: true });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[employerFix] adminRunFixQueue:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Admin: apply a fix_config reasoned by the hourly self-heal routine. VERIFY it yields real
// jobs (with details) BEFORE persisting — never store an unverified override. Additive: reuses
// applyOverride + saveOverride + updateRequest, exactly like the automated agent path.
async function adminApplyFix(req, res) {
  try {
    const reqRow = await fix.getFixRequest(req.params.id);
    if (!reqRow) return res.status(404).json({ error: 'request not found' });
    const fixConfig = req.body && req.body.fixConfig;
    if (!fixConfig || !fixConfig.kind) return res.status(400).json({ error: 'fixConfig with a kind is required' });

    // Verify before save: the proposed fix must actually produce real jobs WITH details.
    const out = await agent.applyOverride(fixConfig);
    const jobs = (out && Array.isArray(out.jobs)) ? out.jobs : [];
    const withDetails = jobs.filter(j => j && j.title && (j.job_url || j.url || (Array.isArray(j.responsibilities) && j.responsibilities.length))).length;
    if (jobs.length < 1 || withDetails < 1) {
      return res.json({ verified: false, jobCount: jobs.length, withDetails, message: 'Proposed fix did not yield verifiable jobs — NOT saved.' });
    }

    const dom = reqRow.domain || fix.normDomain(reqRow.employer_input);
    const overrideId = await fix.saveOverride({
      domain: dom, requestId: reqRow.id, fixConfig, verified: true,
      verifyJobCount: jobs.length, verifySample: jobs.slice(0, 3).map(j => j.title),
      createdBy: 'self-heal-routine', notes: (req.body && req.body.notes) || 'hourly Claude self-heal routine',
    });
    await fix.updateRequest(reqRow.id, {
      status: 'resolved', jobCount: jobs.length,
      detectedAts: (out && out.ats) || fixConfig.kind, resolved: true,
      diagnosis: { method: 'self_heal_routine', fixConfig, verifyJobCount: jobs.length },
    });
    return res.json({ verified: true, jobCount: jobs.length, withDetails, ats: out.ats, domain: dom, overrideId, userId: reqRow.user_id, employerInput: reqRow.employer_input });
  } catch (e) {
    console.error('[employerFix] adminApplyFix:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

module.exports = {
  runInvestigation, submitFixRequest, getRequestStatus,
  adminListRequests, adminInvestigate, adminOverrideHistory, adminActivateOverride, adminDeactivate,
  adminRunFixQueue, adminApplyFix,
};
