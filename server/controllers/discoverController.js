// Value-first job feed — ADDITIVE. Serves the isolated global_jobs firehose (Migration 023/024) as a
// browse feed so a freshly-registered user sees REAL, RELEVANT jobs immediately. Read-only, no AI.
// Apply links go to the employer.
//
// Features:
//  • Résumé MATCH SCORE (deterministic skill overlap) + match-based sorting (best first).
//  • FIELD scoping — every job is classified (jobTaxonomy) into a field (IT/Sales/Finance/Mechanical…)
//    and a role category (Developer/QA/PM…). A user's own field is derived from their résumé so the feed
//    can default to "your field, best matches first, ≥ min match".
//  • FEED DIVERSITY — the feed round-robins employers (ROW_NUMBER per employer) so one company's board
//    can never wall the feed (the "everything is Zip" bug).
//  • Detailed filters: field, role category, technology/skill, country, work mode, employer, search.
'use strict';
const dbConfig = require('../../db-config');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { deriveUserField, ALL_FIELDS } = require('../utils/jobTaxonomy');

const BASE_CAP = 1500;         // diversify + match-rank the freshest N candidates (bounds correlated-subquery cost)
const DEFAULT_MIN_MATCH = 10;  // in the résumé-scoped default view, hide sub-10% noise

// Fetch the user's parsed résumé (skills + titles + industries). Returns null if none.
async function getResume(userId) {
  if (!userId) return null;
  try {
    return await dbConfig.get(
      "SELECT skills, job_titles, industries FROM resume_metadata WHERE user_id = ? AND parse_status = 'done' ORDER BY id DESC LIMIT 1",
      [userId]);
  } catch { return null; }
}
function skillsOf(resume) {
  let sk = resume && resume.skills;
  if (typeof sk === 'string') { try { sk = JSON.parse(sk); } catch { sk = []; } }
  if (!Array.isArray(sk)) return [];
  return sk.map((s) => String(s || '').toLowerCase().trim()).filter((s) => s.length >= 2).slice(0, 40);
}

// SQL skill-overlap match score: how many of the job's skills the user has (exact OR substring, either
// direction), over a denominator floored at 3 and capped at 8 — a thin 1-skill listing can't hit 100%.
function matchExprSql(skillsParam) {
  return `(CASE WHEN jsonb_array_length(COALESCE(skills,'[]'::jsonb)) = 0 THEN NULL ELSE LEAST(100, round(100.0 * (
      SELECT COUNT(*) FROM jsonb_array_elements_text(COALESCE(skills,'[]'::jsonb)) js
      WHERE EXISTS (SELECT 1 FROM unnest(${skillsParam}::text[]) u
        WHERE lower(js) = u OR (length(u) > 2 AND lower(js) LIKE '%'||u||'%') OR (length(js) > 2 AND u LIKE '%'||lower(js)||'%'))
    ) / GREATEST(3, LEAST(jsonb_array_length(COALESCE(skills,'[]'::jsonb)), 8)))) END)`;
}

async function discoverJobs(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
    const country = String(req.query.country || '').trim().slice(0, 40);
    const workMode = String(req.query.work_mode || '').trim().toLowerCase().slice(0, 20);
    const employer = String(req.query.employer || '').trim().slice(0, 120);
    const skill = String(req.query.skill || '').trim().toLowerCase().slice(0, 60);
    let field = String(req.query.field || '').trim().slice(0, 60);
    const roleCat = String(req.query.role_category || '').trim().slice(0, 90);
    if (/^all$/i.test(field)) field = '';
    const wantMatchSort = String(req.query.sort || '') !== 'recent';   // default = best match
    // min match: default 10 only when the user is scoped to a field (their focused view); 0 when browsing all.
    const minMatchRaw = req.query.min_match;
    const minMatch = Math.max(0, Math.min(100, parseInt(minMatchRaw != null ? minMatchRaw : (field ? DEFAULT_MIN_MATCH : 0), 10) || 0));

    const resume = await getResume(req.user && req.user.id);
    const userSkills = skillsOf(resume);
    const noProfile = userSkills.length === 0;
    const userFieldObj = deriveUserField(resume);
    const useMatchSort = wantMatchSort && !noProfile;
    const applyMinMatch = minMatch > 0 && !noProfile;

    // ── WHERE (shared by list + count) ──
    const wParams = [];
    const WP = (v) => { wParams.push(v); return '$' + wParams.length; };
    const where = ['is_active'];
    if (q) where.push(`(LOWER(title) LIKE ${WP('%' + q + '%')} OR LOWER(employer_name) LIKE ${WP('%' + q + '%')} OR LOWER(location) LIKE ${WP('%' + q + '%')})`);
    if (country) where.push(`country = ${WP(country)}`);
    if (workMode) where.push(`LOWER(work_mode) = ${WP(workMode)}`);
    if (employer) where.push(`employer_name = ${WP(employer)}`);
    if (field) where.push(`field = ${WP(field)}`);
    if (roleCat) where.push(`role_category = ${WP(roleCat)}`);
    if (skill) where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(skills,'[]'::jsonb)) js WHERE lower(js) LIKE ${WP('%' + skill + '%')})`);
    const whereSql = where.join(' AND ');
    const FIELDS = `job_url, title, employer_name, employer_domain, location, work_mode, job_type, salary, experience, responsibilities, skills, source, country, field, role_category, seniority, last_seen`;

    // ── list query: base (cap) → per-employer rank → optional min-match → diversified order ──
    const params = [...wParams];
    const P = (v) => { params.push(v); return '$' + params.length; };
    const matchExpr = noProfile ? 'NULL::int' : matchExprSql(P(userSkills));
    const rnOrder = useMatchSort ? 'match DESC NULLS LAST, last_seen DESC' : 'last_seen DESC';
    const finalOrder = useMatchSort ? 'match DESC NULLS LAST, rn ASC, last_seen DESC' : 'rn ASC, last_seen DESC';
    const minClause = applyMinMatch ? `WHERE match >= ${minMatch}` : '';

    const sql = `
      WITH base AS (
        SELECT ${FIELDS}, ${matchExpr} AS match
        FROM global_jobs WHERE ${whereSql}
        ORDER BY last_seen DESC LIMIT ${BASE_CAP}
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY employer_name ORDER BY ${rnOrder}) AS rn FROM base
      ), filtered AS (
        SELECT * FROM ranked ${minClause}
      )
      SELECT ${FIELDS}, match, COUNT(*) OVER ()::int AS total_filtered
      FROM filtered
      ORDER BY ${finalOrder}
      LIMIT ${P(limit)} OFFSET ${P(offset)}`;

    const rows = await dbConfig.query(sql, params);

    // total: exact + uncapped when not min-match filtering; otherwise the (capped) filtered count.
    let total;
    if (applyMinMatch) {
      total = rows && rows.length ? rows[0].total_filtered : 0;
    } else {
      const totalRow = await dbConfig.get(`SELECT COUNT(*)::int n FROM global_jobs WHERE ${whereSql}`, wParams).catch(() => null);
      total = totalRow ? totalRow.n : (rows || []).length;
    }

    const jobs = (rows || []).map((r) => ({
      id: r.job_url, title: r.title, company: r.employer_name, employer_name: r.employer_name,
      employer_domain: r.employer_domain, location: r.location, work_mode: r.work_mode,
      job_type: r.job_type, salary: r.salary, experience: r.experience,
      responsibilities: Array.isArray(r.responsibilities) ? r.responsibilities : [],
      skills: Array.isArray(r.skills) ? r.skills : [], job_url: r.job_url, source: r.source,
      country: r.country, field: r.field, role_category: r.role_category, seniority: r.seniority,
      match: r.match == null ? null : Number(r.match),
    }));

    const hasMore = jobs.length === limit && (offset + limit) < BASE_CAP && (offset + jobs.length) < total;
    res.json({
      success: true, jobs, total, offset, limit, hasMore,
      noProfile, sort: useMatchSort ? 'match' : 'recent',
      userField: userFieldObj ? userFieldObj.field : null,
      userRoleCategory: userFieldObj ? userFieldObj.roleCategory : null,
      appliedField: field || null, minMatch: applyMinMatch ? minMatch : 0,
    });
  } catch (e) {
    console.error('[discover] jobs error:', e.message);
    res.status(500).json({ error: 'Failed to load jobs' });
  }
}

// Filter chips for the feed UI: fields (departments), role categories (scoped to a field if given),
// top skills (technologies), countries, work modes, employers + total + the user's own field.
async function discoverFacets(req, res) {
  try {
    const field = String(req.query.field || '').trim().slice(0, 60);
    const resume = await getResume(req.user && req.user.id);
    const userFieldObj = deriveUserField(resume);

    const roleCatSql = field
      ? dbConfig.query(`SELECT role_category, COUNT(*)::int n FROM global_jobs WHERE is_active AND field = $1 AND role_category IS NOT NULL GROUP BY role_category ORDER BY n DESC LIMIT 30`, [field])
      : Promise.resolve([]);

    const [total, fields, roleCategories, skills, countries, workModes, employers] = await Promise.all([
      dbConfig.get(`SELECT COUNT(*)::int n FROM global_jobs WHERE is_active`),
      dbConfig.query(`SELECT field, COUNT(*)::int n FROM global_jobs WHERE is_active AND field IS NOT NULL AND field <> 'Other' GROUP BY field ORDER BY n DESC`),
      roleCatSql,
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
      fields: fields || [], roleCategories: roleCategories || [],
      skills: (skills || []).filter((s) => s.skill), countries: countries || [],
      workModes: workModes || [], employers: employers || [],
      userField: userFieldObj ? userFieldObj.field : null,
      userRoleCategory: userFieldObj ? userFieldObj.roleCategory : null,
    });
  } catch (e) {
    console.error('[discover] facets error:', e.message);
    res.status(500).json({ error: 'Failed to load facets' });
  }
}

// ─── AI natural-language search ────────────────────────────────────────────────
// The user types a plain sentence ("senior react developer, remote, in Europe"); we break it into
// structured criteria (role/tech keywords, field, location, work-mode, seniority), then search the
// saved global_jobs network — ranked by their résumé match. If they paste an employer URL instead,
// we flag it so the app can hand it to the existing "research this employer" (add-URL) flow.
const LITE_MODEL = process.env.GEMINI_LITE_MODEL || 'gemini-2.5-flash-lite';
const PARSE_MODEL = process.env.GEMINI_FLASH_MODEL || 'gemini-2.5-flash';  // stronger model for query parsing (low volume, quality-critical)
const STOP = new Set(('a an the and or for in on at of to with as is are i im looking look want need '
  + 'job jobs role roles position positions work working me my his her their any some good best').split(' '));

// If the query contains an explicit link, treat it as "research this employer", not a text search.
function extractUrl(query) {
  const m = String(query || '').match(/(https?:\/\/[^\s]+|www\.[^\s]+\.[a-z]{2,}[^\s]*)/i);
  return m ? m[1].replace(/[.,)]+$/, '') : null;
}

// Deterministic fallback when the AI parser is unavailable (e.g. local key depleted) — keeps search working.
function naiveParse(query) {
  const ql = String(query || '').toLowerCase();
  let workMode = null;
  if (/\bremote\b/.test(ql)) workMode = 'remote';
  else if (/\bhybrid\b/.test(ql)) workMode = 'hybrid';
  else if (/\b(on[-\s]?site|onsite|in[-\s]?office)\b/.test(ql)) workMode = 'onsite';
  const keywords = ql.replace(/[^a-z0-9+#.\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w)).slice(0, 8);
  return { keywords, field: null, location: null, workMode, seniority: null };
}

// The user's own saved location (for "near me" / "my area" searches).
async function getUserProfileLoc(userId) {
  if (!userId) return null;
  try { return await dbConfig.get('SELECT city, country, address FROM users WHERE id = ?', [userId]); }
  catch { return null; }
}
const NEAR_ME_RE = /\b(near me|my area|nearby|near by|my location|around me|close to me|my city|my region|my place|around here)\b/i;

async function parseSearchQuery(query, locHint) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return { keywords: [], field: null, location: null, workMode: null, seniority: null };
  if (!process.env.GEMINI_API_KEY) return naiveParse(q);
  try {
    const model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: PARSE_MODEL });
    const locLine = locHint
      ? `\nThe user's OWN saved location is city="${locHint.city || ''}", country="${locHint.country || ''}", address="${locHint.address || ''}". If the text refers to their own area ("near me", "my area", "nearby", "my city", "my location"), set "location" to their city — INFER the city from the address/zip when the city field is blank (e.g. an address ending "…Gurgaon, Haryana" → "Gurgaon").`
      : '';
    const prompt = `You extract structured job-search filters. Output STRICT JSON only (no markdown/commentary), keys EXACTLY:
{"keywords": string[], "field": string|null, "location": string|null, "workMode": "remote"|"hybrid"|"onsite"|null, "seniority": string|null}
Rules:
- keywords: ONLY the role/title/technology terms (1-4). Keep tech tokens exactly (".net","c#","c++","node.js","react"). NEVER include filler ("show","me","find","jobs","role","for","in","near","area","my"), the location, the seniority, or the field name.
- field: EXACTLY one of ${JSON.stringify(ALL_FIELDS)}, or null if unclear.
- location: the city/country/region the user wants (resolve "near me/my area" per the note below), else null.
- workMode: remote/hybrid/onsite only if stated, else null.
- seniority: senior/junior/lead/manager/intern only if stated, else null.
Examples:
"show me .net jobs for switzerland location" -> {"keywords":[".net"],"field":"IT & Software","location":"Switzerland","workMode":null,"seniority":null}
"senior react developer, remote" -> {"keywords":["react"],"field":"IT & Software","location":null,"workMode":"remote","seniority":"senior"}
"registered nurse jobs in the US" -> {"keywords":["registered nurse"],"field":"Healthcare & Clinical","location":"United States","workMode":null,"seniority":null}
"sales jobs near my area" (address "…Gurgaon, Haryana") -> {"keywords":["sales"],"field":"Sales & Business Development","location":"Gurgaon","workMode":null,"seniority":null}${locLine}
User text: ${JSON.stringify(q)}`;
    const r = await model.generateContent(prompt);
    const txt = String((r && r.response && r.response.text && r.response.text()) || '').trim().replace(/^```(json)?\s*/i, '').replace(/\s*```$/,'');
    const j = JSON.parse(txt);
    let workMode = j.workMode ? String(j.workMode).toLowerCase() : null;
    if (!['remote', 'hybrid', 'onsite'].includes(workMode)) workMode = null;
    const keywords = Array.isArray(j.keywords)
      ? j.keywords.map((k) => String(k || '').toLowerCase().trim()).filter((k) => k.length >= 2).slice(0, 6) : [];
    return {
      keywords: keywords.length ? keywords : naiveParse(q).keywords,
      field: j.field && ALL_FIELDS.includes(j.field) ? j.field : null,
      location: j.location ? String(j.location).trim().slice(0, 60) : null,
      workMode,
      seniority: j.seniority ? String(j.seniority).trim().slice(0, 30) : null,
    };
  } catch (e) {
    console.error('[discover] parse error:', e.message);
    return naiveParse(q);
  }
}

async function aiSearch(req, res) {
  try {
    const rawQuery = String((req.body && req.body.query) || req.query.q || '').trim().slice(0, 300);
    const limit = Math.min(Math.max(parseInt((req.body && req.body.limit) || req.query.limit, 10) || 20, 1), 50);
    const offset = Math.max(parseInt((req.body && req.body.offset) || req.query.offset, 10) || 0, 0);
    if (!rawQuery) return res.status(400).json({ error: 'Empty query' });

    // Employer URL → hand off to the existing "research this employer" flow (app opens add-URL).
    const url = extractUrl(rawQuery);
    if (url) return res.json({ success: true, urlDetected: true, url, parsed: null, jobs: [], total: 0, offset, limit, hasMore: false });

    const resume = await getResume(req.user && req.user.id);
    const userSkills = skillsOf(resume);
    const noProfile = userSkills.length === 0;
    const userFieldObj = deriveUserField(resume);
    const loc = await getUserProfileLoc(req.user && req.user.id);
    const parsed = await parseSearchQuery(rawQuery, loc);
    // "near me / my area" → resolve to the user's saved city (fallback if the AI didn't).
    if (NEAR_ME_RE.test(rawQuery) && loc && loc.city && String(loc.city).trim()) parsed.location = String(loc.city).trim();

    // ── WHERE ──
    const wParams = [];
    const WP = (v) => { wParams.push(v); return '$' + wParams.length; };
    const where = ['is_active'];
    const kws = parsed.keywords && parsed.keywords.length ? parsed.keywords : [rawQuery.toLowerCase().slice(0, 60)];
    if (kws.length) {
      const ors = kws.map((k) => {
        const p = WP('%' + k + '%');
        return `(LOWER(title) LIKE ${p} OR LOWER(employer_name) LIKE ${p} OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(skills,'[]'::jsonb)) js WHERE lower(js) LIKE ${p}))`;
      });
      where.push('(' + ors.join(' OR ') + ')');
    }
    if (parsed.field) where.push(`field = ${WP(parsed.field)}`);
    if (parsed.location) { const lp = WP('%' + parsed.location.toLowerCase() + '%'); where.push(`(LOWER(location) LIKE ${lp} OR LOWER(country) LIKE ${lp})`); }
    if (parsed.workMode) where.push(`LOWER(work_mode) = ${WP(parsed.workMode)}`);
    const whereSql = where.join(' AND ');

    const FIELDS = `job_url, title, employer_name, employer_domain, location, work_mode, job_type, salary, experience, responsibilities, skills, source, country, field, role_category, seniority, last_seen`;
    const params = [...wParams];
    const P = (v) => { params.push(v); return '$' + params.length; };
    const matchExpr = noProfile ? 'NULL::int' : matchExprSql(P(userSkills));
    const useMatchSort = !noProfile;
    const rnOrder = useMatchSort ? 'match DESC NULLS LAST, last_seen DESC' : 'last_seen DESC';
    const finalOrder = useMatchSort ? 'match DESC NULLS LAST, rn ASC, last_seen DESC' : 'rn ASC, last_seen DESC';

    const sql = `
      WITH base AS (
        SELECT ${FIELDS}, ${matchExpr} AS match
        FROM global_jobs WHERE ${whereSql}
        ORDER BY last_seen DESC LIMIT ${BASE_CAP}
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY employer_name ORDER BY ${rnOrder}) AS rn FROM base
      )
      SELECT ${FIELDS}, match, COUNT(*) OVER ()::int AS total_filtered
      FROM ranked
      ORDER BY ${finalOrder}
      LIMIT ${P(limit)} OFFSET ${P(offset)}`;

    const rows = await dbConfig.query(sql, params);
    const total = rows && rows.length ? rows[0].total_filtered : 0;
    const jobs = (rows || []).map((r) => ({
      id: r.job_url, title: r.title, company: r.employer_name, employer_name: r.employer_name,
      employer_domain: r.employer_domain, location: r.location, work_mode: r.work_mode,
      job_type: r.job_type, salary: r.salary, experience: r.experience,
      responsibilities: Array.isArray(r.responsibilities) ? r.responsibilities : [],
      skills: Array.isArray(r.skills) ? r.skills : [], job_url: r.job_url, source: r.source,
      country: r.country, field: r.field, role_category: r.role_category, seniority: r.seniority,
      match: r.match == null ? null : Number(r.match),
    }));

    res.json({
      success: true, urlDetected: false, parsed, jobs, total, offset, limit,
      hasMore: jobs.length === limit && (offset + jobs.length) < total, noProfile,
      userField: userFieldObj ? userFieldObj.field : null,
    });
  } catch (e) {
    console.error('[discover] ai-search error:', e.message);
    res.status(500).json({ error: 'Search failed' });
  }
}

module.exports = { discoverJobs, discoverFacets, aiSearch };
