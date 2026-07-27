// What the user searched for, what came back, and whether it worked.
//
// The old Searches tab read app_events alone and could only say "a search happened at 13:40". It
// could not say what was typed (the value lives under props.company, not props.query, so every row
// rendered as the word "Search"), how many jobs it produced, or whether the result was any good.
// That is exactly the question an admin has — "the user pasted revolut.com/careers and got one job,
// why" — and the page could not answer it.
//
// WHERE THE TRUTH LIVES. `async_jobs` holds the input AND the result, but it is pruned: 4 rows
// survive against 60+ search events. The durable record is `user_tracked_employers` → `employers` →
// `jobs`, which persists as long as the employer does. So searches are read from the durable join
// and enriched with async_jobs.input when that row still exists; search events with no employer
// behind them are surfaced separately, because "this search produced nothing" is the single most
// useful row on the page and the old view dropped it entirely.

const dbConfig = require('../../db-config');

const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const str = (v) => (v == null ? '' : String(v)).trim();

/** app_events.props for a job_search is {company: "<whatever the user typed>"} — not {query}. */
function queryFromProps(props) {
  let p = props;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = {}; } }
  if (!p || typeof p !== 'object') return '';
  for (const k of ['company', 'query', 'q', 'url', 'input', 'keyword', 'search', 'term']) {
    const v = str(p[k]);
    if (v) return v;
  }
  return '';
}

/**
 * Health of one search, in the admin's terms. This is the column that would have made the Revolut
 * case obvious at a glance instead of after an hour in the database.
 */
function verdictFor({ jobCount, withUrl, withDetail }) {
  if (jobCount === 0) return { code: 'no_jobs', label: 'Nothing came back', tone: 'bad' };
  if (jobCount === 1) return { code: 'single', label: 'Only 1 job — usually means the listing was unreadable', tone: 'warn' };
  if (withUrl === 0) return { code: 'no_urls', label: 'No job has a real apply link', tone: 'bad' };
  if (withDetail === 0) return { code: 'no_detail', label: 'Titles only — no descriptions were captured', tone: 'warn' };
  if (withDetail < Math.ceil(jobCount / 2)) return { code: 'thin', label: `Only ${withDetail} of ${jobCount} have descriptions`, tone: 'warn' };
  return { code: 'ok', label: `${jobCount} jobs with details`, tone: 'good' };
}

/**
 * Every search this user ran, newest first.
 * Two kinds of row:
 *   kind 'employer' — produced an employer (durable; carries counts and a drill-down id)
 *   kind 'event'    — a search event with no employer behind it, i.e. it produced NOTHING
 */
async function listSearches(userId, limit = 25, offset = 0) {
  const id = int(userId);
  if (!id) return { total: 0, items: [] };
  const lim = Math.min(100, Math.max(1, int(limit, 25)));
  const off = Math.max(0, int(offset, 0));

  // Durable searches, with the shape of what came back measured in SQL so the admin sees the same
  // numbers the app does. `responsibilities` is the detail column on `jobs`.
  const employerRows = await dbConfig.query(
    `SELECT e.id                AS employer_id,
            e.name              AS employer,
            e.domain            AS domain,
            e.sub_info          AS sub_info,
            e.last_scraped_at   AS last_scraped_at,
            ute.created_at      AS created_at,
            ute.async_job_id    AS async_job_id,
            aj.input            AS aj_input,
            aj.status           AS aj_status,
            (SELECT COUNT(*)::int FROM jobs j WHERE j.employer_id = e.id) AS job_count,
            (SELECT COUNT(*)::int FROM jobs j WHERE j.employer_id = e.id
               AND COALESCE(j.job_url,'') <> '' AND j.job_url NOT LIKE '%#role-%') AS with_url,
            (SELECT COUNT(*)::int FROM jobs j WHERE j.employer_id = e.id
               AND COALESCE(j.responsibilities::text,'') NOT IN ('', '[]', 'null')) AS with_detail
       FROM user_tracked_employers ute
       JOIN employers e ON e.id = ute.employer_id
       LEFT JOIN async_jobs aj ON aj.id = ute.async_job_id
      WHERE ute.user_id = $1
      ORDER BY ute.created_at DESC NULLS LAST`, [id]).catch(() => []);

  const items = (employerRows || []).map((r) => {
    const jobCount = int(r.job_count);
    const withUrl = int(r.with_url);
    const withDetail = int(r.with_detail);
    let input = r.aj_input;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = null; } }
    return {
      kind: 'employer',
      id: String(r.employer_id),
      employer_id: String(r.employer_id),
      async_job_id: r.async_job_id ? String(r.async_job_id) : null,
      // What the user typed, when we still have it; otherwise the domain we resolved it to.
      query: (input && str(input.company)) || str(r.domain),
      query_is_exact: !!(input && str(input.company)),
      employer: str(r.employer) || str(r.domain),
      domain: str(r.domain),
      sub_info: str(r.sub_info),
      job_count: jobCount,
      with_url: withUrl,
      with_detail: withDetail,
      status: str(r.aj_status) || 'completed',
      created_at: r.created_at,
      last_scraped_at: r.last_scraped_at,
      verdict: verdictFor({ jobCount, withUrl, withDetail }),
    };
  });

  // Searches that produced no employer at all. Matched by time: an event within 10 minutes of a
  // durable row is that row's telemetry, so only the leftovers are genuine dead ends.
  let deadEnds = [];
  try {
    const evs = await dbConfig.query(
      `SELECT id, props, created_at, platform, app_version
         FROM app_events
        WHERE user_id = $1 AND event = 'job_search'
        ORDER BY created_at DESC LIMIT 200`, [id]);
    const stamps = items.map((i) => new Date(i.created_at).getTime()).filter((n) => Number.isFinite(n));
    deadEnds = (evs || []).filter((ev) => {
      const t = new Date(ev.created_at).getTime();
      return !stamps.some((s) => Math.abs(s - t) < 10 * 60 * 1000);
    }).map((ev) => ({
      kind: 'event',
      id: `ev:${ev.id}`,
      employer_id: null,
      async_job_id: null,
      query: queryFromProps(ev.props),
      query_is_exact: true,
      employer: null,
      domain: null,
      job_count: 0,
      with_url: 0,
      with_detail: 0,
      status: 'no_result',
      created_at: ev.created_at,
      platform: ev.platform || null,
      app_version: ev.app_version || null,
      verdict: { code: 'no_jobs', label: 'Nothing came back — no employer was ever created', tone: 'bad' },
    }));
  } catch { deadEnds = []; }

  const all = [...items, ...deadEnds].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return {
    total: all.length,
    counts: {
      searches: all.length,
      produced_nothing: all.filter((r) => r.job_count === 0).length,
      single_job: all.filter((r) => r.job_count === 1).length,
      healthy: all.filter((r) => r.verdict.code === 'ok').length,
    },
    items: all.slice(off, off + lim),
  };
}

/** The jobs one search produced, as full cards — the same fields the app's job detail shows. */
async function searchJobs(userId, employerId, limit = 50) {
  const id = int(userId);
  if (!id || !employerId) return { error: 'bad_request' };

  // Scope check: only an employer THIS user actually searched.
  const owns = await dbConfig.get(
    `SELECT 1 AS ok FROM user_tracked_employers WHERE user_id = $1 AND employer_id = $2`,
    [id, employerId]).catch(() => null);
  if (!owns) return { error: 'not_this_users_search' };

  const employer = await dbConfig.get(
    `SELECT id, name, domain, sub_info, last_scraped_at FROM employers WHERE id = $1`, [employerId]).catch(() => null);

  // `locations`, not `employer_locations` — the latter is the company's own address book and has no
  // city/country at all. jobService joins `locations` everywhere; matching it keeps the admin's
  // cards showing the same place string the user sees in the app.
  const rows = await dbConfig.query(
    `SELECT j.id, j.title, j.job_url, j.experience, j.salary, j.job_type, j.work_mode,
            j.urgent, j.is_active, j.responsibilities, j.created_at,
            l.city AS city, l.state AS state, l.country AS country, l.raw_text AS raw_location
       FROM jobs j
       LEFT JOIN locations l ON l.id = j.location_id
      WHERE j.employer_id = $1
      ORDER BY j.created_at DESC
      LIMIT ${Math.min(200, Math.max(1, int(limit, 50)))}`, [employerId]).catch(() => []);

  const jobIds = (rows || []).map((r) => r.id);
  const skillsByJob = new Map();
  if (jobIds.length) {
    try {
      const sk = await dbConfig.query(
        `SELECT js.job_id, s.name FROM job_skills js JOIN skills s ON s.id = js.skill_id
          WHERE js.job_id = ANY($1::uuid[])`, [jobIds]);
      for (const r of sk || []) {
        if (!skillsByJob.has(r.job_id)) skillsByJob.set(r.job_id, []);
        skillsByJob.get(r.job_id).push(r.name);
      }
    } catch { /* skills are a nice-to-have; a missing join must not blank the cards */ }
  }

  const parseResp = (v) => {
    if (v == null) return [];
    if (Array.isArray(v)) return v.map(str).filter(Boolean);
    if (typeof v === 'object') return Object.values(v).map(str).filter(Boolean);
    try { const p = JSON.parse(String(v)); return Array.isArray(p) ? p.map(str).filter(Boolean) : [str(p)].filter(Boolean); }
    catch { return String(v).split(/\n+/).map(str).filter(Boolean); }
  };

  const jobs = (rows || []).map((r) => {
    const responsibilities = parseResp(r.responsibilities);
    const url = str(r.job_url);
    return {
      id: String(r.id),
      title: str(r.title),
      location: [str(r.city), str(r.state), str(r.country)].filter(Boolean).join(', ') || str(r.raw_location),
      experience: str(r.experience),
      salary: str(r.salary),
      job_type: str(r.job_type),
      work_mode: str(r.work_mode),
      urgent: !!r.urgent,
      is_active: r.is_active !== false,
      skills: skillsByJob.get(r.id) || [],
      responsibilities,
      job_url: url || null,
      // The two failure shapes worth naming on the card itself, since they are what "the search
      // didn't really work" looks like in practice.
      url_is_synthetic: !url || /#role-/.test(url),
      has_detail: responsibilities.length > 0,
      created_at: r.created_at,
    };
  });

  return {
    employer: employer ? {
      id: String(employer.id), name: str(employer.name), domain: str(employer.domain),
      sub_info: str(employer.sub_info), last_scraped_at: employer.last_scraped_at,
    } : null,
    total: jobs.length,
    summary: {
      with_real_url: jobs.filter((j) => !j.url_is_synthetic).length,
      with_detail: jobs.filter((j) => j.has_detail).length,
      with_skills: jobs.filter((j) => j.skills.length > 0).length,
    },
    jobs,
  };
}

module.exports = { listSearches, searchJobs, queryFromProps, verdictFor };
