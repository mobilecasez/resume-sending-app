// Value-first job feed — ADDITIVE. Serves the isolated global_jobs firehose (Migration 023) as a
// browse-first feed so a freshly-registered user sees REAL jobs immediately. Read-only, no AI. Apply
// links go to the employer. Supports detailed filters (skill/technology, country, work-mode, employer,
// search) + a résumé MATCH SCORE (skill overlap) with match-based sorting.
'use strict';
const dbConfig = require('../../db-config');

// The user's résumé skills (lowercased). Empty → no match scores (noProfile).
async function getUserSkills(userId) {
  if (!userId) return [];
  try {
    const row = await dbConfig.get(
      "SELECT skills FROM resume_metadata WHERE user_id = ? AND parse_status = 'done' ORDER BY id DESC LIMIT 1",
      [userId]);
    let sk = row && row.skills;
    if (typeof sk === 'string') { try { sk = JSON.parse(sk); } catch { sk = []; } }
    if (!Array.isArray(sk)) return [];
    return sk.map((s) => String(s || '').toLowerCase().trim()).filter((s) => s.length >= 2).slice(0, 40);
  } catch { return []; }
}

// SQL skill-overlap match score: how many of the job's skills the user has (exact OR substring,
// either direction), scored against a denominator floored at 3 and capped at 8 — so a thin 1-skill
// listing can't hit 100% and a 20-skill listing isn't impossible. 0..100, NULL when no job skills.
function matchExprSql(skillsParam) {
  return `(CASE WHEN jsonb_array_length(COALESCE(skills,'[]'::jsonb)) = 0 THEN NULL ELSE LEAST(100, round(100.0 * (
      SELECT COUNT(*) FROM jsonb_array_elements_text(COALESCE(skills,'[]'::jsonb)) js
      WHERE EXISTS (SELECT 1 FROM unnest(${skillsParam}::text[]) u
        WHERE lower(js) = u OR (length(u) > 2 AND lower(js) LIKE '%'||u||'%') OR (length(js) > 2 AND u LIKE '%'||lower(js)||'%'))
    ) / GREATEST(3, LEAST(jsonb_array_length(COALESCE(skills,'[]'::jsonb)), 8)))) END)`;
}

const MATCH_CANDIDATE_CAP = 1200; // when sorting by match, rank the freshest N candidates (bounds cost)

async function discoverJobs(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
    const country = String(req.query.country || '').trim().slice(0, 40);
    const workMode = String(req.query.work_mode || '').trim().toLowerCase().slice(0, 20);
    const employer = String(req.query.employer || '').trim().slice(0, 120);
    const skill = String(req.query.skill || '').trim().toLowerCase().slice(0, 60);
    const wantMatchSort = String(req.query.sort || '') === 'match';

    const userSkills = await getUserSkills(req.user && req.user.id);
    const noProfile = userSkills.length === 0;
    const useMatchSort = wantMatchSort && !noProfile;

    // ── WHERE (shared by the list + count) ──
    const wParams = [];
    const WP = (v) => { wParams.push(v); return '$' + wParams.length; };
    const where = ['is_active'];
    if (q) where.push(`(LOWER(title) LIKE ${WP('%' + q + '%')} OR LOWER(employer_name) LIKE ${WP('%' + q + '%')} OR LOWER(location) LIKE ${WP('%' + q + '%')})`);
    if (country) where.push(`country = ${WP(country)}`);
    if (workMode) where.push(`LOWER(work_mode) = ${WP(workMode)}`);
    if (employer) where.push(`employer_name = ${WP(employer)}`);
    if (skill) where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(skills,'[]'::jsonb)) js WHERE lower(js) LIKE ${WP('%' + skill + '%')})`);
    const whereSql = where.join(' AND ');
    const FIELDS = `job_url, title, employer_name, employer_domain, location, work_mode, job_type, salary, experience, responsibilities, skills, source, country, last_seen`;

    // ── list query ──
    const params = [...wParams];
    const P = (v) => { params.push(v); return '$' + params.length; };
    const matchExpr = noProfile ? 'NULL::int' : matchExprSql(P(userSkills));
    let sql;
    if (useMatchSort) {
      sql = `SELECT * FROM (
          SELECT ${FIELDS}, ${matchExpr} AS match FROM global_jobs WHERE ${whereSql} ORDER BY last_seen DESC LIMIT ${MATCH_CANDIDATE_CAP}
        ) t ORDER BY match DESC NULLS LAST, last_seen DESC LIMIT ${P(limit)} OFFSET ${P(offset)}`;
    } else {
      sql = `SELECT ${FIELDS}, ${matchExpr} AS match FROM global_jobs WHERE ${whereSql} ORDER BY last_seen DESC LIMIT ${P(limit)} OFFSET ${P(offset)}`;
    }

    const rows = await dbConfig.query(sql, params);
    const totalRow = await dbConfig.get(`SELECT COUNT(*)::int n FROM global_jobs WHERE ${whereSql}`, wParams).catch(() => null);
    const total = totalRow ? totalRow.n : (rows || []).length;

    const jobs = (rows || []).map((r) => ({
      id: r.job_url, title: r.title, company: r.employer_name, employer_name: r.employer_name,
      employer_domain: r.employer_domain, location: r.location, work_mode: r.work_mode,
      job_type: r.job_type, salary: r.salary, experience: r.experience,
      responsibilities: Array.isArray(r.responsibilities) ? r.responsibilities : [],
      skills: Array.isArray(r.skills) ? r.skills : [], job_url: r.job_url, source: r.source,
      country: r.country, match: r.match == null ? null : Number(r.match),
    }));
    res.json({ success: true, jobs, total, offset, limit, hasMore: offset + jobs.length < total, noProfile, sort: useMatchSort ? 'match' : 'recent' });
  } catch (e) {
    console.error('[discover] jobs error:', e.message);
    res.status(500).json({ error: 'Failed to load jobs' });
  }
}

// Filter chips for the feed UI: top skills (technologies), countries, work modes, employers + total.
async function discoverFacets(req, res) {
  try {
    const [total, skills, countries, workModes, employers] = await Promise.all([
      dbConfig.get(`SELECT COUNT(*)::int n FROM global_jobs WHERE is_active`),
      dbConfig.query(`SELECT (array_agg(js ORDER BY length(js)))[1] AS skill, COUNT(*)::int n
                        FROM global_jobs, jsonb_array_elements_text(COALESCE(skills,'[]'::jsonb)) js
                       WHERE is_active AND length(js) BETWEEN 2 AND 40
                       GROUP BY lower(js) ORDER BY n DESC LIMIT 40`),
      dbConfig.query(`SELECT country, COUNT(*)::int n FROM global_jobs WHERE is_active AND country IS NOT NULL AND country <> '' GROUP BY country ORDER BY n DESC LIMIT 40`),
      dbConfig.query(`SELECT work_mode, COUNT(*)::int n FROM global_jobs WHERE is_active AND work_mode IS NOT NULL GROUP BY work_mode ORDER BY n DESC`),
      dbConfig.query(`SELECT employer_name, COUNT(*)::int n FROM global_jobs WHERE is_active AND employer_name IS NOT NULL GROUP BY employer_name ORDER BY n DESC LIMIT 40`),
    ]);
    res.json({
      success: true, total: total ? total.n : 0,
      skills: (skills || []).filter((s) => s.skill), countries: countries || [],
      workModes: workModes || [], employers: employers || [],
    });
  } catch (e) {
    console.error('[discover] facets error:', e.message);
    res.status(500).json({ error: 'Failed to load facets' });
  }
}

module.exports = { discoverJobs, discoverFacets };
