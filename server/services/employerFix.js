// Self-improving employer fix loop — store for fix REQUESTS (failed employers a user
// asked us to support) and the VERSIONED per-employer OVERRIDES the diagnostic agent
// produces. Discovery applies the active override (by domain) on the next search.
'use strict';

const dbConfig = require('../../db-config');

function normDomain(input) {
  try {
    let u = String(input || '');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return new URL(u).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return String(input || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

// ── Fix requests ─────────────────────────────────────────────────────────────
async function createFixRequest({ userId, email, employerInput, domain, detectedAts, jobCount }) {
  const dom = domain || normDomain(employerInput);
  // Reuse an open request for the same domain (don't pile up duplicates).
  const existing = await dbConfig.get(
    `SELECT id FROM employer_fix_requests WHERE domain = ? AND status IN ('pending','investigating') ORDER BY created_at DESC LIMIT 1`, [dom]);
  if (existing) {
    await dbConfig.run(`UPDATE employer_fix_requests SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [existing.id]);
    return existing.id;
  }
  const row = await dbConfig.get(
    `INSERT INTO employer_fix_requests (user_id, email, employer_input, domain, detected_ats, job_count, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending') RETURNING id`,
    [userId || null, email || null, employerInput, dom, detectedAts || null, jobCount || 0]);
  return row ? row.id : null;
}

async function listFixRequests({ status } = {}) {
  const rows = status
    ? await dbConfig.query(`SELECT * FROM employer_fix_requests WHERE status = ? ORDER BY created_at DESC LIMIT 300`, [status])
    : await dbConfig.query(`SELECT * FROM employer_fix_requests ORDER BY created_at DESC LIMIT 300`);
  return rows || [];
}

async function getFixRequest(id) { return dbConfig.get(`SELECT * FROM employer_fix_requests WHERE id = ?`, [id]); }

// Cost guard for the SILENT auto-flow: don't re-run the (slow, paid) AI agent on a
// domain the agent already tried and couldn't crack within the last `days`. Resolved
// domains never reach this — their override applies first. Returns the recent dead
// attempt's row, or null if it's fair game to investigate.
async function recentDeadAttempt(domain, days = 7) {
  return dbConfig.get(
    `SELECT id, status, updated_at FROM employer_fix_requests
     WHERE domain = ? AND status IN ('failed','needs_review')
       AND updated_at > NOW() - ($2 || ' days')::INTERVAL
     ORDER BY updated_at DESC LIMIT 1`,
    [normDomain(domain), String(days)]
  );
}

async function updateRequest(id, fields = {}) {
  const sets = []; const vals = [];
  if (fields.status !== undefined) { sets.push('status = ?'); vals.push(fields.status); }
  if (fields.diagnosis !== undefined) { sets.push('diagnosis = ?'); vals.push(JSON.stringify(fields.diagnosis)); }
  if (fields.jobCount !== undefined) { sets.push('job_count = ?'); vals.push(fields.jobCount); }
  if (fields.detectedAts !== undefined) { sets.push('detected_ats = ?'); vals.push(fields.detectedAts); }
  if (fields.bumpAttempts) sets.push('attempts = attempts + 1');
  if (fields.resolved) sets.push('resolved_at = CURRENT_TIMESTAMP');
  sets.push('updated_at = CURRENT_TIMESTAMP');
  vals.push(id);
  await dbConfig.run(`UPDATE employer_fix_requests SET ${sets.join(', ')} WHERE id = ?`, vals);
}

// ── Overrides (versioned; one active per domain) ─────────────────────────────
async function getActiveOverride(domain) {
  return dbConfig.get(`SELECT * FROM employer_overrides WHERE domain = ? AND active = TRUE ORDER BY version DESC LIMIT 1`, [normDomain(domain)]);
}

async function saveOverride({ domain, requestId, fixConfig, verified, verifyJobCount, verifySample, createdBy, notes }) {
  const dom = normDomain(domain);
  const v = await dbConfig.get(`SELECT COALESCE(MAX(version), 0) AS m FROM employer_overrides WHERE domain = ?`, [dom]);
  const version = (v && v.m ? parseInt(v.m, 10) : 0) + 1;
  await dbConfig.run(`UPDATE employer_overrides SET active = FALSE WHERE domain = ?`, [dom]);
  const row = await dbConfig.get(
    `INSERT INTO employer_overrides (domain, request_id, fix_config, verified, verify_job_count, verify_sample, active, version, created_by, notes)
     VALUES (?, ?, ?, ?, ?, ?, TRUE, ?, ?, ?) RETURNING id`,
    [dom, requestId || null, JSON.stringify(fixConfig || {}), !!verified, verifyJobCount || 0, JSON.stringify(verifySample || []), version, createdBy || 'agent', notes || null]);
  return row ? row.id : null;
}

async function listOverrides(domain) {
  return (await dbConfig.query(`SELECT * FROM employer_overrides WHERE domain = ? ORDER BY version DESC`, [normDomain(domain)])) || [];
}

// Rollback / re-apply: make a specific version the active one (deactivating the rest).
async function setActiveOverride(overrideId) {
  const ov = await dbConfig.get(`SELECT domain FROM employer_overrides WHERE id = ?`, [overrideId]);
  if (!ov) return false;
  await dbConfig.run(`UPDATE employer_overrides SET active = FALSE WHERE domain = ?`, [ov.domain]);
  await dbConfig.run(`UPDATE employer_overrides SET active = TRUE WHERE id = ?`, [overrideId]);
  return true;
}

async function deactivateOverrides(domain) {
  await dbConfig.run(`UPDATE employer_overrides SET active = FALSE WHERE domain = ?`, [normDomain(domain)]);
}

module.exports = {
  normDomain, createFixRequest, listFixRequests, getFixRequest, updateRequest, recentDeadAttempt,
  getActiveOverride, saveOverride, listOverrides, setActiveOverride, deactivateOverrides,
};
