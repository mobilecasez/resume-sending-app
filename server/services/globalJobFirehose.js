// Global job firehose — ADDITIVE, ISOLATED. Populates the `global_jobs` table (Migration 023) from
// PUBLIC company ATS boards (Greenhouse/Lever/Ashby/…) using the existing deterministic
// atsDiscovery.detectAndFetchAts(). No AI, no browser, no API keys, no ToS-bypass — each apply link
// goes to the employer's own board. Runs on a schedule; a later phase surfaces these as a browse feed.
// Everything here is best-effort and NEVER touches the per-user `jobs` table.
'use strict';
const ats = require('../utils/atsDiscovery');
const dbConfig = require('../../db-config');
const { classifyTitle } = require('../utils/jobTaxonomy');

let SOURCES = [];
try { SOURCES = require('../data/global_job_sources.json'); } catch (e) { console.warn('[firehose] no sources file:', e.message); }

const PER_BOARD_MS = parseInt(process.env.FIREHOSE_BOARD_MS || '25000', 10);   // hard cap per board — one slow board must NEVER stall the run (learned: databricks hung ~16min)
const CONCURRENCY  = parseInt(process.env.FIREHOSE_CONCURRENCY || '4', 10);
const INTERVAL_H   = parseFloat(process.env.GLOBAL_JOB_FIREHOSE_HOURS || '6');

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('board-timeout:' + label)), ms); });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(t)), timeout]);
}
const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
const workModeOf = (loc) => /\bremote\b/i.test(loc || '') ? 'Remote' : (/\bhybrid\b/i.test(loc || '') ? 'Hybrid' : null);
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

const UPSERT_TAIL = `ON CONFLICT (job_url) DO UPDATE SET
    title=EXCLUDED.title, employer_name=EXCLUDED.employer_name, employer_domain=EXCLUDED.employer_domain,
    location=EXCLUDED.location, work_mode=EXCLUDED.work_mode, job_type=EXCLUDED.job_type, salary=EXCLUDED.salary,
    experience=EXCLUDED.experience, responsibilities=EXCLUDED.responsibilities, skills=EXCLUDED.skills,
    source=EXCLUDED.source, field=EXCLUDED.field, role_category=EXCLUDED.role_category, seniority=EXCLUDED.seniority,
    is_active=TRUE, last_seen=NOW()`;
const INSERT_HEAD = `INSERT INTO global_jobs
  (job_url, title, employer_name, employer_domain, location, work_mode, job_type, salary, experience, responsibilities, skills, source, country, field, role_category, seniority, is_active, first_seen, last_seen) VALUES `;

function jobParams(j, source, region) {
  const tax = classifyTitle(j.title);   // deterministic field / role / seniority — no AI
  return [clip(j.job_url, 1990), clip(j.title, 490), clip(j.employer_name, 290), domainOf(j.job_url),
    clip(j.location, 490), workModeOf(j.location), clip(j.job_type, 110), clip(j.salary, 250),
    clip(j.experience, 250), JSON.stringify(Array.isArray(j.responsibilities) ? j.responsibilities : []),
    JSON.stringify(Array.isArray(j.skills) ? j.skills : []), clip(source, 55), clip(region, 78),
    clip(tax.field, 58), clip(tax.roleCategory, 88), clip(tax.seniority, 28)];
}

// Save one chunk as a single multi-row upsert (big boards go from 2000 round-trips to ~1). On any
// error (e.g. a bad row), fall back to per-row so one bad job never loses the whole chunk.
async function saveChunk(chunk, source, region) {
  if (!chunk.length) return 0;
  const params = []; const rows = [];
  for (const j of chunk) {
    const b = params.length;
    params.push(...jobParams(j, source, region));
    rows.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10}::jsonb,$${b + 11}::jsonb,$${b + 12},$${b + 13},$${b + 14},$${b + 15},$${b + 16},TRUE,NOW(),NOW())`);
  }
  try {
    await dbConfig.query(INSERT_HEAD + rows.join(',') + ' ' + UPSERT_TAIL, params);
    return chunk.length;
  } catch (e) {
    let ok = 0;
    for (const j of chunk) {
      try { await dbConfig.query(INSERT_HEAD + `($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,TRUE,NOW(),NOW()) ` + UPSERT_TAIL, jobParams(j, source, region)); ok++; } catch { /* skip bad row */ }
    }
    return ok;
  }
}

// Save all of a board's jobs in de-duped chunks (a board can list the same URL twice → ON CONFLICT
// would error "cannot affect row a second time" inside one statement, so dedup per chunk).
async function saveJobs(jobs, source, region) {
  const valid = [];
  const seen = new Set();
  for (const j of jobs) {
    if (!j || !j.job_url || !j.title || seen.has(j.job_url)) continue;
    seen.add(j.job_url); valid.push(j);
  }
  const CHUNK = 100;
  let saved = 0;
  for (let i = 0; i < valid.length; i += CHUNK) saved += await saveChunk(valid.slice(i, i + CHUNK), source, region);
  return saved;
}

async function ingestOne(src) {
  const url = src.url || src;
  try {
    const res = await withTimeout(ats.detectAndFetchAts(url), PER_BOARD_MS, url).catch(() => null);
    if (!res || !Array.isArray(res.jobs) || !res.jobs.length) return { url, jobs: 0 };
    const saved = await saveJobs(res.jobs, res.ats || 'ats', src.region);
    console.log(`[firehose] ${res.companyName || url}: ${saved} jobs (${res.ats})`);
    return { url, company: res.companyName, ats: res.ats, jobs: saved };
  } catch (e) { return { url, jobs: 0, error: String(e.message).slice(0, 80) }; }
}

// Full pass over all (or `limit`) sources. Bounded concurrency; each board hard-timeout-capped.
async function runFirehose({ limit } = {}) {
  const list = limit ? SOURCES.slice(0, limit) : SOURCES;
  const t0 = Date.now();
  console.log(`[firehose] starting: ${list.length} boards, concurrency ${CONCURRENCY}, cap ${PER_BOARD_MS}ms/board`);
  const results = await ats.mapLimit(list, CONCURRENCY, ingestOne);
  const jobsSaved = results.reduce((s, r) => s + (r.jobs || 0), 0);
  const boardsOk = results.filter((r) => (r.jobs || 0) > 0).length;
  const summary = { sources: list.length, boardsOk, jobsSaved, seconds: Math.round((Date.now() - t0) / 1000) };
  console.log(`[firehose] DONE: ${boardsOk}/${list.length} boards, ${jobsSaved} jobs, ${summary.seconds}s`);
  try {
    await dbConfig.run(
      `INSERT INTO system_schedule (job_key, last_run_at, last_summary) VALUES ('global_job_firehose', NOW(), ?)
       ON CONFLICT (job_key) DO UPDATE SET last_run_at=NOW(), last_summary=EXCLUDED.last_summary`,
      [JSON.stringify(summary)]);
  } catch (e) { console.warn('[firehose] schedule write failed:', e.message); }
  return { ...summary, results };
}

// Hourly check gated by a persisted timestamp (survives restarts; matches fixQueueRunner pattern).
function startGlobalJobFirehose() {
  if (String(process.env.GLOBAL_JOB_FIREHOSE_ENABLED || '1') === '0') { console.log('[firehose] disabled via env'); return; }
  const intervalMs = Math.max(0.5, INTERVAL_H) * 3600 * 1000;
  const tick = async () => {
    try {
      const row = await dbConfig.get(`SELECT last_run_at FROM system_schedule WHERE job_key='global_job_firehose'`).catch(() => null);
      const last = row && row.last_run_at ? new Date(row.last_run_at).getTime() : 0;
      if (Date.now() - last < intervalMs - 60000) return;   // not due yet
      await runFirehose();
    } catch (e) { console.error('[firehose] tick error:', e.message); }
  };
  setTimeout(tick, 120 * 1000);              // first run ~2min after boot
  setInterval(tick, 60 * 60 * 1000);         // then re-check hourly (gated by persisted timestamp)
  console.log(`[firehose] scheduler started (every ~${INTERVAL_H}h, ${SOURCES.length} sources)`);
}

module.exports = { runFirehose, startGlobalJobFirehose, ingestOne, SOURCES };
