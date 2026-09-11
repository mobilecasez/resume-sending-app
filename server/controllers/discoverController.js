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
const ats = require('../utils/atsDiscovery');
const firehose = require('../services/globalJobFirehose');
const aiHub = require('./aiHubController');   // grounded live-search fallback (groundedDiscover)
const aiJobExtractor = require('../services/aiJobExtractor');   // fetch-detail: on-device HTML → structured job
const jobCapture = require('./jobCaptureController');   // fetch-detail fallback: visible page TEXT → structured job (SPA/iframe-proof)
const { chargeCredits, getEventCost } = require('../services/eventCosts');   // credit metering for AI search + live fetch
const synonyms = require('../utils/searchSynonyms');   // .net⇄dotnet, node⇄node.js, sde⇄software engineer …
const { cleanSkills, seniorityFromTitle } = require('../utils/jobFields');   // a skill is a name, not a sentence
const geoRank = require('../utils/geoRank');            // ONE country-then-distance comparator, shared app-wide
const geoContext = require('../services/geoContext');   // …and the per-user anchor/mode behind it
// ⚠️ ONE normalisation of a company name, app-wide. The download PASS already answers "is this the
// same employer?" (legal suffixes stripped, a URL reduced to its label); the employer SEARCH has to
// give the same answer, or "Siemens AG" and "Siemens" are two rows in the picker and one scope in
// the paywall.
const { aliasKeysOf, employerKeyOf, sameEmployer } = require('../services/downloads');
const { lookupWebsites, normaliseDomain } = require('../services/companyLookup');   // free keyless name → website
const { ATS_HOSTS, AGGREGATOR_HOSTS } = require('../services/applyUrlResolver');   // job-board / ATS host lists

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

// JS mirror of matchExprSql — a résumé skill-overlap % for a job CARD (used for saved/live-search cards,
// which live outside global_jobs so the SQL match expr can't reach them). Returns null when the user has
// no parsed résumé skills. Same denominator floors as the SQL so scores are consistent across the app.
function computeCardMatch(card, userSkills) {
  if (!userSkills || !userSkills.length || !card) return null;
  const overlap = (u, j) => u === j || (u.length > 2 && j.includes(u)) || (j.length > 2 && u.includes(j));
  const jobSkills = (Array.isArray(card.skills) ? card.skills : []).map((s) => String(s || '').toLowerCase().trim()).filter((s) => s.length >= 2);
  if (jobSkills.length > 0) {
    let hit = 0;
    for (const js of jobSkills) if (userSkills.some((u) => overlap(u, js))) hit++;
    const denom = Math.max(3, Math.min(jobSkills.length, 8));
    return Math.min(100, Math.round(100 * hit / denom));
  }
  // No skills on the card → count how many résumé skills appear in the title / responsibilities text.
  const hay = (String(card.title || '') + ' ' + (Array.isArray(card.responsibilities) ? card.responsibilities.join(' ') : '')).toLowerCase();
  let hit = 0;
  for (const u of userSkills) if (u.length > 2 && hay.includes(u)) hit++;
  const denom = Math.max(4, Math.min(userSkills.length, 12));
  return Math.min(100, Math.round(100 * hit / denom));
}

// SQL skill-overlap match score: how many of the job's skills the user has (exact OR substring, either
// direction), over a denominator floored at 3 and capped at 8 — a thin 1-skill listing can't hit 100%.
function matchExprSql(skillsParam) {
  // With a skills[] array: score = overlap of user skills with job skills. When empty (government feeds /
  // grounded jobs store no skills), fall back to how many user skills appear in the TITLE or description
  // — so EVERY job gets a match %, not just ATS ones.
  return `(CASE
    WHEN jsonb_array_length(COALESCE(skills,'[]'::jsonb)) > 0 THEN LEAST(100, round(100.0 * (
      SELECT COUNT(*) FROM jsonb_array_elements_text(COALESCE(skills,'[]'::jsonb)) js
      WHERE EXISTS (SELECT 1 FROM unnest(${skillsParam}::text[]) u
        WHERE lower(js) = u OR (length(u) > 2 AND lower(js) LIKE '%'||u||'%') OR (length(js) > 2 AND u LIKE '%'||lower(js)||'%'))
    ) / GREATEST(3, LEAST(jsonb_array_length(COALESCE(skills,'[]'::jsonb)), 8))))
    ELSE LEAST(100, round(100.0 * (
      SELECT COUNT(*) FROM unnest(${skillsParam}::text[]) u
      WHERE length(u) > 2 AND (lower(title) LIKE '%'||u||'%'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(responsibilities,'[]'::jsonb)) rs WHERE lower(rs) LIKE '%'||u||'%'))
    ) / GREATEST(4, LEAST(COALESCE(array_length(${skillsParam}::text[], 1), 0), 12))))
  END)`;
}

// What the client is allowed to say about the ordering. `notice` is the one honest line for the UI
// ("No Science & Research roles in France yet — showing the closest matches elsewhere."); it is null
// whenever nothing needs explaining. `applied` is false when the geo term made no difference at all,
// so the app never claims a location ordering it did not get.
function geoSummary(geo, applied) {
  if (!geo || !geo.active) return { applied: false, mode: null, country: null, city: null, notice: null };
  return {
    applied: !!applied,
    mode: geo.mode,
    country: geo.anchor.country,
    city: geo.anchor.city || null,
    cityKnown: !!geo.anchor.city,
    notice: geo.notice || null,
  };
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
    // 'match' (default) = best match first, honestly. 'nearby' = the user ASKING for their own
    // country first. 'recent' = newest. Anything else falls back to 'match'.
    const sortKey = /^(recent|nearby)$/.test(String(req.query.sort || '')) ? String(req.query.sort) : 'match';
    const wantMatchSort = sortKey !== 'recent';
    // min match: default 10 only when the user is scoped to a field (their focused view); 0 when browsing all.
    const minMatchRaw = req.query.min_match;
    const minMatch = Math.max(0, Math.min(100, parseInt(minMatchRaw != null ? minMatchRaw : (field ? DEFAULT_MIN_MATCH : 0), 10) || 0));

    const resume = await getResume(req.user && req.user.id);
    const userSkills = skillsOf(resume);
    const noProfile = userSkills.length === 0;
    const userFieldObj = deriveUserField(resume);
    const useMatchSort = wantMatchSort && !noProfile;
    const applyMinMatch = minMatch > 0 && !noProfile;
    // Where this user lives, and whether their own field has enough jobs there for country-first to
    // help rather than bury them (see geoRank.js). Same context object the search, the admin match
    // view and the notifier use, so all four agree on the order.
    const geo = await geoContext.getGeoContext(req.user && req.user.id, { field: userFieldObj ? userFieldObj.field : null });

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
    // Geo term. With sort=recent there is no match to interleave with, so only the strong
    // (country-first) mode applies — the honest fallback must never turn "newest" into "nearest".
    // ⚠️ THE SORT THE USER PICKED IS THE SORT THEY GET.
    // geo.mode is decided from DATA (does this user's field have enough jobs at home?) and used to
    // be applied whatever the user had chosen — so "Best match" could silently return a
    // country-first list where a 40% local job outranked a 95% one, and "Newest first" could return
    // nearest-first, which this file's own comment said it must never do.
    // Ordering mode now follows the user's choice; geo.mode still drives the explanatory notice.
    const geoMode = sortKey === 'nearby' ? 'country-first' : 'match-first';
    const applyGeo = geo.active && sortKey !== 'recent';
    const geoSel = applyGeo ? `, ${geoRank.tierSql(geo.anchor, P, { countryCol: 'country', locationCol: 'location' })} AS geo_tier` : '';
    const geoOrd = !applyGeo ? '' : geoRank.orderSql(geoMode, { tier: 'geo_tier', match: 'match' }) + ', ';
    // The candidate window is the freshest BASE_CAP rows, so in country-first mode it has to be
    // drawn nearest-first as well — otherwise "France first" can only reorder whatever handful of
    // French jobs happened to land in a worldwide freshness window.
    const baseOrder = (applyGeo && geoMode === 'country-first') ? 'geo_tier ASC, last_seen DESC' : 'last_seen DESC';
    const rnOrder = geoOrd + (useMatchSort ? 'match DESC NULLS LAST, last_seen DESC' : 'last_seen DESC');
    const finalOrder = geoOrd + (useMatchSort ? 'match DESC NULLS LAST, rn ASC, last_seen DESC' : 'rn ASC, last_seen DESC');
    const minClause = applyMinMatch ? `WHERE match >= ${minMatch}` : '';

    const sql = `
      WITH base AS (
        SELECT ${FIELDS}, ${matchExpr} AS match${geoSel}
        FROM global_jobs WHERE ${whereSql}
        ORDER BY ${baseOrder} LIMIT ${BASE_CAP}
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
      noProfile, sort: useMatchSort ? sortKey : 'recent',
      userField: userFieldObj ? userFieldObj.field : null,
      userRoleCategory: userFieldObj ? userFieldObj.roleCategory : null,
      appliedField: field || null, minMatch: applyMinMatch ? minMatch : 0,
      geo: geoSummary(geo, applyGeo),
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

// ─── Employer search (FREE: two table reads + a keyless website lookup, no AI) ─
// ⚠️ THIS EXISTS BECAUSE "ADD EMPLOYER" WAS RUNNING A JOB SEARCH. The sheet called
// GET /discover/jobs?q=… and deduped company names out of the returned job rows — and that search
// matches title and location too, so on prod q=Siemens came back as 50 jobs whose companies were
// mostly STAFFING AGENCIES that merely mention Siemens in the ad (Randstad, Experis, Skill
// Kompetenspartner), while q=Nordex came back EMPTY because the firehose has never crawled Nordex.
// A 10,000-employee employer, invisible; three agencies, top of the list. An employer is an
// IDENTITY, not a job row: match employer NAMES only, and look in `employers` — the identity table
// the app already builds — before looking at the firehose at all.
//
// ⚠️ EVERY ROW HAS A WEBSITE, OR IT IS NOT A ROW. A résumé or letter is built from the employer's
// website; a bare name cannot be built for, and a job posting is not a substitute. So a company
// neither table knows (Nordex again) is looked up on the web by name (services/companyLookup), and
// a name that ends the merge with no website is left out rather than offered. `websiteLookup` tells
// the client whether an empty list means "no website was found" ('ok') or "the lookup failed right
// now" ('unavailable') — only the first may ask the user to add the website themselves.
//
// ⚠️ FREE, AND IT HAS TO STAY FREE: the sheet calls this on a 320ms keystroke debounce, so one
// typed word is several requests. No Gemini, no grounding, no chargeCredits. The ONE outbound call
// is companyLookup — keyless public autocomplete, cached in memory, only the typed name leaves the
// server. Anything added here that costs money charges the user for typing.

// ⚠️ pg_trgm MAY NOT EXIST. Migration 045 runs CREATE EXTENSION pg_trgm, but that needs a superuser
// role and db-init's col() swallows the refusal — the '✅ Migration 045' line prints either way, so
// the log is NOT proof the extension is there. Ask the catalog once and cache it; without trigrams
// the exact→prefix→contains ranking below is still correct, it just loses the fuzzy tail.
let trgmAvailable = null;   // null = not asked yet; true/false = the cached answer for this process
async function hasTrigram() {
  if (trgmAvailable !== null) return trgmAvailable;
  try {
    trgmAvailable = !!(await dbConfig.get(`SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_trgm'`));
    return trgmAvailable;
  } catch (e) {
    // ⚠️ A FAILED PROBE IS NOT AN ANSWER. This used to cache `false`, so one pool reset / one
    // statement_timeout during boot traffic left the worker permanently trigram-less — fuzzy
    // matching silently gone for the life of the process, on a database that has the extension.
    // Leave the flag UNSET so the next request re-asks; this request just takes the plain path.
    trgmAvailable = null;
    console.warn('[discover] employers: trigram probe failed, will re-ask —', e.message);
    return false;
  }
}

// Is this error actually "the trigram function/operator cannot be resolved"? Postgres raises 42883
// (undefined_function) for similarity(), 42704 (undefined_object) for the operator/opclass; the
// message carries the same news when a driver does not surface the code.
// ⚠️ EVERYTHING ELSE MUST RETHROW. A pool reset, a statement_timeout (57014) or a hot-standby
// recovery conflict is not evidence about the catalog, and treating it as such latched the whole
// worker into the no-trigram path while logging a line that asserted something false about the DB.
function isMissingTrigram(e) {
  if (!e) return false;
  if (e.code === '42883' || e.code === '42704') return true;
  return /similarity|operator does not exist/i.test(String(e.message || ''));
}

// ⚠️ The catalog check can still be wrong (extension installed into a schema outside search_path),
// and `similarity()` / `%` are resolved when the statement is PLANNED — i.e. it throws here, not at
// the check. So a trigram query that fails FOR THAT REASON gets exactly one retry without trigrams,
// and the process stops asking. A missing index must never 500 an employer lookup — but neither may
// a transient failure be mistaken for a missing index.
async function withTrigramFallback(build, trgm) {
  try { return await build(trgm); }
  catch (e) {
    if (!trgm || !isMissingTrigram(e)) throw e;
    trgmAvailable = false;
    console.warn('[discover] employers: trigram unavailable, retrying plain —', e.message);
    return build(false);
  }
}

// exact → prefix → contains → (trigram tail). Written over an already-lowered column.
function nameTierSql(col, pExact, pPrefix, pContains) {
  return `CASE WHEN ${col} = ${pExact} THEN 0
               WHEN ${col} LIKE ${pPrefix} THEN 1
               WHEN ${col} LIKE ${pContains} THEN 2
               ELSE 3 END`;
}

// The name PREDICATE — what actually decides which rows are read (the CASE above only ranks what
// this let through). `prefix` used to appear ONLY inside that CASE, so the single term either query
// emitted was a leading-wildcard `LIKE '%q%'` and Migration 045's btree could never be picked.
//
// What each arm is, and what can serve it — honestly, so nobody reads an index into this that
// is not there:
//  • ANCHORED `${col} LIKE 'nordex%'` is the ONLY shape a btree can serve. Migration 045 built
//    idx_employers_name_lower ON employers (lower(name) text_pattern_ops) — same expression, same
//    opclass as emitted here, and text_pattern_ops is the one that matters: it compares byte-wise,
//    so a prefix stays a range scan whatever the database collation is.
//  • INFIX `LIKE '%nordex%'` and `%` need gin_trgm_ops, i.e. they need pg_trgm to have actually
//    been created. Kept unconditionally on purpose: dropping it when the extension is missing would
//    change WHICH EMPLOYERS ARE FOUND depending on a database extension, and "Energy" has to keep
//    finding "Nordex Energy SE" on both kinds of server.
// ⚠️ TWO LIMITS THIS DOES NOT FIX, said plainly:
//  1. An OR is index-servable only when EVERY arm is — the planner can BitmapOr, it cannot
//     half-scan — and the anchored arm is a strict SUBSET of the infix arm, so it adds no rows.
//     With pg_trgm present the GIN serves the whole disjunction; with pg_trgm absent `employers` is
//     still scanned, and the btree only becomes reachable for a caller that drops the infix arm.
//  2. global_jobs has NO btree this can use at all: idx_global_jobs_employer is on the RAW column
//     with the default opclass, which cannot serve `lower(employer_name) LIKE …`. Its only relevant
//     index is idx_global_jobs_employer_trgm. Making the ~120k-row firehose side index-servable
//     WITHOUT pg_trgm needs a `(lower(employer_name) text_pattern_ops)` btree in db-init — this file
//     cannot add one, and until it exists the no-trigram path there is a sequential scan per
//     keystroke.
function nameWhereSql(col, pExact, pPrefix, pContains, trgm) {
  return `(${col} LIKE ${pPrefix} OR ${col} LIKE ${pContains}${trgm ? ` OR ${col} % ${pExact}` : ''})`;
}

// Source 1: the employers the app has already identified. Nothing in this codebase has ever queried
// employers.name — it is only ever read by domain — so this is a new access path on an existing table.
// ⚠️ employers.sub_info is NOT a location: aiHubController overwrites it with "N open roles" on every
// research path, so showing it as one would put "12 open roles" in a location chip. A tracked
// employer's location can only come from the firehose rows it merges with, or stay null.
async function trackedEmployerHits(q, prefix, contains, cand, trgm) {
  const params = [];
  const P = (v) => { params.push(v); return '$' + params.length; };
  const pExact = P(q), pPrefix = P(prefix), pContains = P(contains);
  const sim = trgm ? `similarity(lower(name), ${pExact})` : '0';
  const rows = await dbConfig.query(
    `SELECT name, domain, ${nameTierSql('lower(name)', pExact, pPrefix, pContains)} AS tier, ${sim} AS sim
       FROM employers
      WHERE name IS NOT NULL AND name <> ''
        AND ${nameWhereSql('lower(name)', pExact, pPrefix, pContains, trgm)}
      ORDER BY tier, (domain IS NOT NULL AND domain <> '') DESC, sim DESC, length(name)
      LIMIT ${P(cand)}`, params);
  return (rows || []).map((r) => ({
    name: r.name, domain: r.domain || null, location: null,
    jobs: 0,   // filled in by the merge when the firehose knows this employer; 0 is honest, not missing
    source: 'tracked', tier: Number(r.tier), sim: Number(r.sim) || 0,
  }));
}

// Source 2: employers the firehose has seen.
// ⚠️ employer_name ONLY. Widening this to title or location is the exact bug this endpoint replaces:
// that is what put Randstad and Experis at the top of a search for Siemens, on the strength of ad copy.
// ⚠️ EVERY DISTINCT POSTING HOST, NOT ONE. This read MIN(employer_domain) — the alphabetically
// smallest host — and boards.greenhouse.io < careers.acme.com, so once websiteOf nulled the board the
// employer was DROPPED even though another of its postings carried the real site. The candidates
// come back as a capped array; discoverEmployers picks the one that is a website (postingWebsite).
// ⚠️ THE CAP KEEPS THE BUSIEST HOSTS, NOT THE FIRST ONES. array_agg(DISTINCT …)[1:10] sorted the hosts
// alphabetically before cutting, so an employer posting from 11+ hosts lost its real site to ten
// earlier-sorting board hosts — the MIN bug again at a larger cap. So the subquery counts postings per
// (employer_name, employer_domain) and the aggregate is ordered by that count before the cut. A
// window, not a GROUP BY, in the subquery: the outer COUNT(*) and mode(country) must still see one
// row per posting, and it stays one statement.
const DOMAINS_PER_EMPLOYER = 10;
async function jobEmployerHits(q, prefix, contains, cand, country, trgm) {
  const params = [];
  const P = (v) => { params.push(v); return '$' + params.length; };
  const pExact = P(q), pPrefix = P(prefix), pContains = P(contains);
  const sim = trgm ? `similarity(lower(employer_name), ${pExact})` : '0';
  const tierSql = nameTierSql('lower(employer_name)', pExact, pPrefix, pContains);
  const where = [`is_active`, `employer_name IS NOT NULL`, `employer_name <> ''`,
    nameWhereSql('lower(employer_name)', pExact, pPrefix, pContains, trgm)];
  if (country) where.push(`country = ${P(country)}`);
  // Trigram-only rows (tier 3) are ordered by SIMILARITY before job count: they are filtered by the
  // typo floor AFTER this LIMIT, so ordering them by jobs let a 253-job near-miss (Airbnb for
  // "airbus") take the slot of the few-job typo the user actually meant.
  const rows = await dbConfig.query(
    `SELECT employer_name AS name,
            (array_agg(employer_domain ORDER BY host_jobs DESC, employer_domain)
               FILTER (WHERE host_first AND employer_domain IS NOT NULL AND employer_domain <> ''))[1:${DOMAINS_PER_EMPLOYER}] AS domains,
            mode() WITHIN GROUP (ORDER BY country) FILTER (WHERE country IS NOT NULL AND country <> '') AS location,
            COUNT(*)::int AS jobs,
            ${tierSql} AS tier,
            ${sim} AS sim
       FROM (SELECT employer_name, employer_domain, country,
                    count(*) OVER host AS host_jobs,
                    (row_number() OVER host) = 1 AS host_first
               FROM global_jobs
              WHERE ${where.join(' AND ')}
             WINDOW host AS (PARTITION BY employer_name, employer_domain)) j
      GROUP BY employer_name
      ORDER BY tier, ${trgm ? `CASE WHEN ${tierSql} = 3 THEN ${sim} END DESC, ` : ''}jobs DESC, sim DESC
      LIMIT ${P(cand)}`, params);
  return (rows || []).map((r) => ({
    name: r.name, domain: null, location: r.location || null,
    domains: Array.isArray(r.domains) ? r.domains
      : typeof r.domains === 'string' ? r.domains.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : [],
    jobs: Number(r.jobs) || 0, source: 'jobs', tier: Number(r.tier), sim: Number(r.sim) || 0,
  }));
}

// ⚠️ A HOST THAT 3+ DIFFERENT EMPLOYER NAMES POST FROM IS A JOB BOARD OR AN ATS, NOT A COMPANY SITE.
// Measured on prod 2026-09-11: of the 9,053 employers in global_jobs with any employer_domain, 6,604
// (73%) sit on a host shared by 3+ distinct names — arbetsformedlingen.se alone carries 4,014,
// amazon.jobs 764, job-boards.greenhouse.io 339, recruit.visma.com 232, easyapply.jobs 109,
// recruto.se 68, staffrec.se 11 … Half of those are on no host list, and the lists will always lag
// the data, so the data itself is asked. A group careers portal (jobs.zalando.com, 19 names) goes
// too, by design: it is a portal, and the web lookup supplies the group's own site.
// ⚠️ NEVER ON THE REQUEST PATH. One GROUP BY over active global_jobs, cached in module memory and
// refreshed at most every 6h, in the background: a request serves the set it has — the previous
// one while a refresh runs, an EMPTY one on first boot (the lists and namedAfter still apply) —
// and never awaits the query. A failed refresh keeps the old set and is retried after 5 min, not
// on every keystroke.
const SHARED_HOST_MIN_NAMES = 3;
const SHARED_HOST_TTL_MS = 6 * 60 * 60 * 1000;
const SHARED_HOST_RETRY_MS = 5 * 60 * 1000;
let sharedHosts = new Set();
let sharedHostsNextAt = 0;
let sharedHostsLoading = false;
function sharedPostingHosts() {
  if (!sharedHostsLoading && Date.now() >= sharedHostsNextAt) {
    sharedHostsLoading = true;
    sharedHostsNextAt = Date.now() + SHARED_HOST_RETRY_MS;
    Promise.resolve()
      .then(() => dbConfig.query(
        `SELECT regexp_replace(lower(employer_domain), '^www\\.', '') AS host
           FROM global_jobs
          WHERE is_active AND employer_domain IS NOT NULL AND employer_domain <> ''
            AND employer_name IS NOT NULL AND employer_name <> ''
          GROUP BY 1
         HAVING count(DISTINCT lower(employer_name)) >= $1`, [SHARED_HOST_MIN_NAMES]))
      .then((rows) => {
        const next = new Set();
        for (const r of rows || []) { const h = normaliseDomain(r.host); if (h) next.add(h); }
        sharedHosts = next;
        sharedHostsNextAt = Date.now() + SHARED_HOST_TTL_MS;
      })
      .catch((e) => console.warn('[discover] employers: shared-host refresh failed, keeping the previous set —', e.message))
      .finally(() => { sharedHostsLoading = false; });
  }
  return sharedHosts;
}

// ⚠️ ONE EMPLOYER, ONE ROW. "Siemens AG" in `employers` and "Siemens" in `global_jobs` are the same
// company, and a user shown both has to guess. Alias-key overlap is how the download PASS already
// decides that question (services/downloads.js) — a second normaliser here would be a second answer
// to it, and the two would drift. Tracked hits are merged FIRST so the identity table's spelling and
// domain win; the firehose contributes what only it knows, the job count and the country.
function mergeEmployerHits(hits) {
  const out = [];
  const byKey = new Map();
  for (const hit of hits) {
    const keys = aliasKeysOf(hit.name);
    if (!keys.size) keys.add(employerKeyOf(hit.name));
    let idx = -1;
    for (const k of keys) { if (byKey.has(k)) { idx = byKey.get(k); break; } }
    if (idx < 0) { idx = out.push({ ...hit }) - 1; }
    else {
      const t = out[idx];
      t.tier = Math.min(t.tier, hit.tier);
      t.sim = Math.max(t.sim, hit.sim);
      // Counts ADD: the firehose groups by employer_name, so "Zalando" and "Zalando SE" are disjoint
      // sets of rows (measured on dev data: 2 + 64), and a tracked hit always contributes 0. Taking the
      // max here would quietly under-report the company the user is actually looking at.
      t.jobs += hit.jobs;
      t.domain = t.domain || hit.domain;
      t.location = t.location || hit.location;
    }
    for (const k of keys) if (!byKey.has(k)) byKey.set(k, idx);
  }
  return out;
}

// ⚠️ A `domain` COLUMN IN OUR TABLES IS NOT THE EMPLOYER'S WEBSITE UNTIL PROVEN OTHERWISE.
//  • global_jobs.employer_domain is domainOf(job_url) — the host of the POSTING. 1,231 of the 1,237
//    boards in data/global_job_sources.json are ATS-hosted (Greenhouse, Ashby, Lever, …), and the
//    national feeds post through job-room.ch, arbeitsagentur.de, francetravail.fr.
//  • employers.domain holds synthetic identity keys ("web-acme", "linkedin-acme", "search:…") and
//    name slugs (extractDomain("Nordex SE") = "nordex-se"), and jobCapture stores the capture URL's
//    host, which can be the job board the user was on.
// Offering any of those as "the website" is the job-board-as-employer bug, so a stored domain counts
// only when it is a real hostname and not a known ATS or job board (applyUrlResolver's lists — the
// same ones Auto Fill trusts; extend them there, not here. Oracle HCM's Fusion pod hosts,
// fa.<datacentre>.oraclecloud.com, are listed there now — ⚠️ one entry per datacentre label, so a
// datacentre that first appears in the data needs its own line in applyUrlResolver.js).
// ⚠️ A SUBDOMAIN OF A LISTED HOST IS REFUSED; THE APEX IS NOT, BY ITSELF. de.indeed.com and
// acme.softgarden.io are postings, but linkedin.com and indeed.com are also the websites of LinkedIn
// and Indeed — refusing the apex dropped the row for someone applying TO LinkedIn whenever the web
// lookup was unavailable (the client already accepts the apex). What keeps an apex from being handed
// to the employers that merely POST there instead:
//  • it counts only for an employer whose name IS its registrable label (ownsHost) — linkedin.com for
//    "LinkedIn Corporation", never for "Acme". Tracked rows need this most: jobCapture stores the host
//    of the page the user captured from, which for a LinkedIn posting is linkedin.com;
//  • firehose rows also face sharedPostingHosts: an apex 3+ employer names post from
//    (arbetsformedlingen.se, 4,014 names) is refused there unless, again, the name owns it.
const LISTED_HOSTS = [...ATS_HOSTS, ...AGGREGATOR_HOSTS];
function websiteOf(raw, name) {
  const host = normaliseDomain(raw);
  if (!host) return null;
  if (LISTED_HOSTS.some((h) => host !== h && host.endsWith('.' + h))) return null;
  if (LISTED_HOSTS.includes(host)) return ownsHost(name, host) ? host : null;
  return host;
}

// Is this host's registrable label EXACTLY one of the employer's alias keys (zalando ↔
// jobs.zalando.com, amazon ↔ amazon.jobs, linkedin ↔ linkedin.com)? Stricter than namedAfter, which
// also accepts the name as a PREFIX of the label (easy ↔ easyapply.jobs) — that looser test is fine
// for a host nobody else posts from, and wrong for a board or portal.
function ownsHost(name, host) {
  const label = registrableLabel(host);
  if (!label) return false;
  const l = label.replace(/-/g, '');
  return spellingsOf(name).some((s) => aliasKeysOf(s).has(l));
}

// ⚠️ A POSTING HOST IS THE EMPLOYER'S WEBSITE ONLY WHEN IT IS NAMED AFTER THE EMPLOYER. The lists
// above cannot name every group careers portal or regional board a feed links out to. Measured on
// dev data: jobs.zalando.com carries 19 employer names, among them "Tradebyte Software GmbH" — so
// without this, searching Tradebyte offered jobs.zalando.com as Tradebyte's website, and every
// Zalando subsidiary got the group portal too. So a FIREHOSE domain counts only when one of its
// labels is the employer's name (an alias key: "SAP" ↔ jobs.sap.com, "Zalando SE" ↔
// jobs.zalando.com), or that name plus more ("Air Arabia" ↔ airarabiagroupcareers.com). The reverse
// — a longer name on a shorter label, "Zalando Payments GmbH" ↔ zalando — is how a subsidiary looks
// on its parent's portal, and is rejected; the web lookup can still give it a site of its own.
// ⚠️ Firehose rows only. A tracked domain can come from a URL the user pasted (tcs.com for "Tata
// Consultancy Services"), which no name test would pass.
// ⚠️ ONLY THE REGISTRABLE LABEL COUNTS, NOT ANY LABEL. An ATS tenant subdomain IS the employer's
// name — acme.softgarden.io, acme.wd3.myworkdaysite.com, nordan.varbi.com — so "any label" handed
// the board to the employer as its website. The label the company actually registered is the one
// directly before the public suffix: jobs.sap.com → sap, careers.acme.co.uk → acme,
// acme.softgarden.io → softgarden.
function namedAfter(name, host) {
  const label = registrableLabel(host);
  if (!label) return false;
  const l = label.replace(/-/g, '');
  const keys = new Set();
  for (const s of spellingsOf(name)) for (const k of aliasKeysOf(s)) if (!k.includes(' ')) keys.add(k);
  return [...keys].some((k) => l === k || (k.length >= 3 && l.startsWith(k)));
}

// The public suffix, where it has two parts. Not the full Public Suffix List (no dependency for it):
// a 2-letter country TLD under co/com/net/org/gov/ac/edu is the shape that matters for employer sites
// — co.uk, com.au, co.jp, com.br, co.in, com.tr, co.nz, co.za, com.mx, com.sg …
const SECOND_LEVEL = /^(?:co|com|net|org|gov|ac|edu)$/;
function registrableLabel(host) {
  const labels = String(host || '').split('.').filter(Boolean);
  const n = labels.length;
  const twoPart = n >= 2 && labels[n - 1].length === 2 && SECOND_LEVEL.test(labels[n - 2]);
  const i = twoPart ? n - 3 : n - 2;
  return i >= 0 ? labels[i] : null;   // "co.uk" alone has no registrable label
}

// ⚠️ aliasKeysOf keeps only [a-z0-9], so an accent DELETES the letter: "Société Générale" keys to
// "socitgnrale" and never matches careers.societegenerale.com; "Würth" never matches wuerth.com. So
// a name is also compared deaccented (NFD, combining marks stripped, plus the letters NFD does not
// decompose: ß ø æ œ ł đ) and with the German transliteration (ä→ae ö→oe ü→ue) that German
// companies register their domains under. The letters are \u escapes on purpose: a tool round-trip
// has turned escapes into raw bytes in this repo before (a NUL made git call a file binary).
const FOLD = { '\u00df': 'ss', '\u00f8': 'o', '\u00e6': 'ae', '\u0153': 'oe', '\u0142': 'l', '\u0111': 'd' };
const UMLAUT = { '\u00e4': 'ae', '\u00f6': 'oe', '\u00fc': 'ue' };
const foldAccents = (s) => s.replace(/[\u00df\u00f8\u00e6\u0153\u0142\u0111]/g, (c) => FOLD[c])
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// [as typed, deaccented, transliterated] — positional, so sameName can pair like with like; an
// all-ASCII name is only itself.
function spellingsOf(name) {
  const lower = String(name || '').normalize('NFC').toLowerCase();
  if (!/[^\x00-\x7f]/.test(lower)) return [lower];
  return [lower, foldAccents(lower), foldAccents(lower.replace(/[\u00e4\u00f6\u00fc]/g, (c) => UMLAUT[c]))];
}

// sameEmployer — the download pass's identity rule, unchanged — asked of each spelling in turn, so
// "Societe Generale" and "Société Générale" are one company.
function sameName(a, b) {
  if (sameEmployer(a, b)) return true;
  const A = spellingsOf(a), B = spellingsOf(b);
  if (A.length === 1 && B.length === 1) return false;
  const at = (S, i) => S[Math.min(i, S.length - 1)];
  return sameEmployer(at(A, 1), at(B, 1)) || sameEmployer(at(A, 2), at(B, 2));
}

// ⚠️ sameName IS LOOSE ON PURPOSE, TOO LOOSE TO ACCUSE A ROW WITH. It matches on the core key, with
// group/international/global/holdings stripped, which is right for folding "Siemens AG" into "Siemens"
// and wrong for saying a stored site is contradicted: q=atlas marked tracked Atlas (atlascopco.com)
// unverified because the lookup had found Atlas Group (atlasgroup.cz), a different company. So the
// strict test compares the FULL key — every word kept, only case and punctuation normalised — per
// spelling, paired the way sameName pairs them. aliasKeysOf inserts that full key first.
function strictName(a, b) {
  const A = spellingsOf(a), B = spellingsOf(b);
  const full = (s) => [...aliasKeysOf(s)][0] || null;
  const at = (S, i) => S[Math.min(i, S.length - 1)];
  return [0, 1, 2].some((i) => { const k = full(at(A, i)); return !!k && k === full(at(B, i)); });
}

// Does anything of this name survive once its legal/generic words are dropped? "Company", "Group",
// "Global Holdings" do not: their only alias key is the generic word itself, which any near-miss query
// hits. ⚠️ downloads.js owns LEGAL_WORDS and does not export it, and a copy here would drift — so
// aliasKeysOf is asked directly: put a word in front that is on no legal list; if the core key it
// returns is that word ALONE, the name contributed no core word. (The name is reduced to its full key
// first, so a URL-shaped name is judged by its label, as aliasKeysOf judges it.)
const CORE_PROBE = 'zq0probe';
function hasCoreName(name) {
  // ⚠️ A NAME WITH NO LATIN LETTERS IS NOT A GENERIC NAME — IT IS OUTSIDE WHAT THIS TEST CAN READ.
  // aliasKeysOf keeps only [a-z0-9], so an Arabic, Greek, Korean or Chinese name has no alias key at all,
  // and the first version read that emptiness as "made only of legal words" and dropped the row. Found on
  // production: employers {'وزارة العمل', 'mol.gov.om'} — the Oman Ministry of Labour's real site —
  // vanished from its own search. The generic-word filter exists to stop 'Company' matching nonsense; it
  // has nothing to say about a script it cannot tokenise, so such a name passes.
  if (spellingsOf(name).every((s) => aliasKeysOf(s).size === 0)) return true;
  return spellingsOf(name).some((s) => {
    const full = [...aliasKeysOf(s)][0];
    return !!full && !aliasKeysOf(CORE_PROBE + ' ' + full).has(CORE_PROBE);
  });
}

// ⚠️ THE TRIGRAM ARM IS NOT A NAME MATCH, IT IS A CANDIDATE. pg_trgm's `%` means similarity ≥ 0.3,
// and that is how q=xqzvnotacompany returned the tracked employer "Company" (swisslinx.com):
// similarity('company', 'xqzvnotacompany') = 0.333 — six shared trigrams (com omp mpa pan any "ny ")
// out of eighteen. And q=airbus returned Airbnb (0.40). A raw similarity floor cannot separate them
// from a real typo: 'nordx'→'nordex' is 0.44, but 'nordex'→'Nordeus' is 0.50 and 'nordx'→'Nordex SE'
// only 0.33. So a row that matched ONLY by trigram (tier 3) must be a TYPO of the query: at most one
// edit per six letters (Damerau: a transposition is one edit) between the query and the employer's
// name — the whole name, or a run of its words, legal suffixes dropped. nordx→nordex: 1 edit in 6,
// kept. airbus→airbnb: 2 in 6, dropped. nordex→nordeus: 2 in 7, dropped. bosch→busch: 1 in 5, dropped
// (a five-letter substitution is a different company as often as it is a typo).
const TYPO_EDITS_PER = 6;
function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev2 = null, prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
    }
    prev2 = prev; prev = cur;
  }
  return prev[n];
}
function isTypoOf(q, name) {
  const compact = (s) => [...new Set(spellingsOf(s).flatMap((v) => [...aliasKeysOf(v)]))];
  const qs = compact(q).filter((k) => !k.includes(' '));
  const runs = new Set();
  for (const key of compact(name)) {
    const w = key.split(' ').slice(0, 6);
    for (let i = 0; i < w.length; i++) for (let j = i + 1; j <= w.length; j++) runs.add(w.slice(i, j).join(''));
  }
  return qs.some((k) => [...runs].some((r) => {
    const max = Math.max(k.length, r.length);
    if (Math.abs(k.length - r.length) * TYPO_EDITS_PER > max) return false;   // cannot pass; skip the DP
    return editDistance(k, r) * TYPO_EDITS_PER <= max;
  }));
}

// The one posting host that is this employer's website: not a listed board/ATS, not a host 3+
// employer names share, and named after the employer. When several pass (jobs.zalando.com and
// zalando.com), the one closest to the root is the company's site rather than a section of it.
// ⚠️ A SHARED HOST THE EMPLOYER OWNS IS STILL ITS OWN. The firehose groups by employer_name, so
// "Zalando", "Zalando SE" and "Zalando Finland Oy" are three names on jobs.zalando.com — a group's
// subsidiaries alone put its portal over the 3-name line, and q=zalando answered "no website found"
// for a 64-job employer whenever the lookup came back empty. So the shared rule is skipped when the
// host's registrable label IS the name (ownsHost). It still applies to a prefix-only match
// (easyapply.jobs for "Easy") and to every host no name test passes (jobs.zalando.com for Tradebyte).
function postingWebsite(name, domains, shared) {
  const ok = [];
  for (const raw of domains || []) {
    const d = websiteOf(raw, name);
    if (d && (!shared.has(d) || ownsHost(name, d)) && namedAfter(name, d) && !ok.includes(d)) ok.push(d);
  }
  ok.sort((a, b) => a.split('.').length - b.split('.').length || a.localeCompare(b));
  return ok[0] || null;
}

// Fold web lookup hits into the DB rows — ONE EMPLOYER, ONE ROW, ONE WEBSITE PER ROW.
// Pass 1, hits that belong to a row we already have:
//  • a row already carrying the hit's domain IS that company — the DB row keeps its name, jobs and
//    location (it knows more than an autocomplete does), and the lookup has now VERIFIED its site;
//  • a DB row that is the same employer (sameEmployer — the download pass's identity rule, not a
//    second one) takes the hit's domain when it has no website, or when its website is only a
//    SUBDOMAIN of the hit's (jobs.zalando.com → zalando.com: the company's site, which is what the
//    user asked for).
// Pass 2, the rest: autocomplete lists one company's country sites as separate hits (Zalando:
// .de .fr .it .com .pl — measured), so a hit folds into any row that has a website — stored or
// looked up — when the names match AND the two sites share a registrable label (zalando.de ↔ zalando.com);
// anything else becomes its own row, source 'web', jobs 0.
// ⚠️ THE NAME ALONE IS NOT ENOUGH TO FOLD. sameEmployer strips group/international/global/holdings,
// so "atlas group" folded atlasgroup.cz, atlasgroupua.com and atlasgroupinc.com — a Czech, a
// Ukrainian and a US company — into one row and hid two of them.
// ⚠️ A ROW THAT ALREADY HAD THE HIT'S EXACT DOMAIN MUST JOIN fromWeb TOO. It did not, so a tracked
// {Zalando SE, zalando.com} could not absorb .de/.fr/.it/.pl, and one company came back as two rows.
// ⚠️ A DB row whose own website DISAGREES with the lookup is NOT overwritten and does NOT absorb the
// hit: employers.domain can be resolveCareersUrl's fabricated www.{slug}.com (nordex.com for Nordex
// SE). Both rows are shown — never silently delete what we stored — but the web-verified row ranks
// FIRST and the DB row is marked domainUnverified: tier then source used to put the fabricated
// nordex.com above the real nordex-online.com.
// Web tier mirrors nameTierSql, except that "same employer" counts as exact: "Nordex SE" is an
// exact match for "nordex", not a prefix one. A folded hit lends its tier to the row it joins.
/**
 * The company name inside a query: slash legal forms (Danish A/S, Brazilian S/A, K/S, I/S, P/S, A/B, c/o)
 * removed, then trailing legal words peeled off while the name still means the same employer — the same
 * trimming companyLookup applies before it asks Clearbit, so the ranking and the search agree on who was
 * asked for. Never returns empty: a query that is ALL legal form keeps its original text.
 */
const SLASH_FORM = /(?:^|\s)(?:a\/s|s\/a|k\/s|i\/s|p\/s|a\/b|c\/o)\.?(?=\s|$)/gi;
function coreOf(q) {
  const s = String(q || '').replace(SLASH_FORM, ' ').replace(/\s+/g, ' ').trim();
  let words = s.split(' ');
  while (words.length > 1 && sameEmployer(s, words.slice(0, -1).join(' '))) words = words.slice(0, -1);
  return words.join(' ').replace(/[\s,.;:&+-]+$/, '') || String(q || '').trim();
}

function mergeWebHits(rows, hits, q) {
  const out = rows.slice();
  const byDomain = new Map();
  for (const r of out) if (r.domain) byDomain.set(r.domain, r);
  const fromWeb = new Set();              // rows whose website the lookup supplied or confirmed
  const typedHost = normaliseDomain(q);   // someone who types "nordex-online.com" means that site
  // ⚠️ RANK AGAINST THE NAME THE LOOKUP ACTUALLY SEARCHED FOR, NOT THE RAW QUERY. companyLookup strips a
  // legal form before asking Clearbit ("Novo Nordisk A/S" → "novo nordisk"), but this tier compared
  // every hit against the raw "novo nordisk a/s" — so the real "Novo Nordisk" matched as nothing, fell
  // to tier 3 beside the junk, and Clearbit's own order put "Namn — novonordisk-utbildningar.se" (a
  // training sub-portal under a placeholder name) FIRST. Measured on production, 2026-09-11.
  const core = coreOf(q);
  const qs = [...new Set([...spellingsOf(q), ...spellingsOf(core)])];
  const tierOf = (h) => {
    if (h.domain === typedHost || sameName(h.name, q) || sameName(h.name, core)) return 0;
    const names = spellingsOf(h.name);
    return names.some((n) => qs.some((x) => n.startsWith(x))) ? 1 : names.some((n) => qs.some((x) => n.includes(x))) ? 2 : 3;
  };
  const rest = [];
  for (const h of hits) {
    const tier = tierOf(h);
    const same = byDomain.get(h.domain);
    if (same) { same.tier = Math.min(same.tier, tier); fromWeb.add(same); continue; }
    const owner = rows.find((r) => (!r.domain || r.domain.endsWith('.' + h.domain)) && sameName(r.name, h.name));
    if (!owner) { rest.push({ h, tier }); continue; }
    if (owner.domain) byDomain.delete(owner.domain);
    owner.domain = h.domain;
    owner.tier = Math.min(owner.tier, tier);
    byDomain.set(h.domain, owner);
    fromWeb.add(owner);
  }
  for (const { h, tier } of rest) {
    const label = registrableLabel(h.domain);
    // ⚠️ ANY ROW WITH A SITE, NOT ONLY ONE ALREADY IN fromWeb. A DB row reaches fromWeb in pass 1 only
    // on the EXACT domain, so tracked {Zalando SE, zalando.com} with hits zalando.de + zalando.fr was
    // never a target: zalando.de became a web row, and the loop below marked the row WITH the jobs
    // unverified and sorted it underneath. A shared registrable label under the same name is the
    // lookup agreeing with the stored site, so the row joins fromWeb. `out` keeps DB rows first.
    const twin = label && out.find((r) => r.domain && registrableLabel(r.domain) === label && sameName(r.name, h.name));
    if (twin) { twin.tier = Math.min(twin.tier, tier); fromWeb.add(twin); continue; }
    const row = { name: h.name, domain: h.domain, location: null, jobs: 0, source: 'web', tier, sim: 0 };
    out.push(row);
    byDomain.set(h.domain, row);
    fromWeb.add(row);
  }
  for (const r of out) {
    if (!r.domain || fromWeb.has(r)) continue;
    // ⚠️ STRICT NAME, and never against a verified site on the same registrable label: see strictName
    // (Atlas vs Atlas Group) and pass 2 above (zalando.com vs zalando.de agree, they do not contradict).
    const label = registrableLabel(r.domain);
    const twins = out.filter((w) => fromWeb.has(w) && w.domain !== r.domain && strictName(w.name, r.name));
    if (!twins.length || twins.some((w) => label && registrableLabel(w.domain) === label)) continue;
    r.domainUnverified = true;
    r.tier = Math.max(r.tier, twins[0].tier);
  }
  return out;
}

async function discoverEmployers(req, res) {
  try {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
    const country = String(req.query.country || '').trim().slice(0, 40);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 25);
    // One letter matches half of both tables and means nothing. Answer without touching the DB or
    // the web — on a keystroke debounce this is the most-hit branch there is. ('ok': nothing failed;
    // the client must not read a 1-letter empty list as "no website exists".)
    if (q.length < 2) return res.json({ success: true, employers: [], websiteLookup: 'ok' });

    // Started BEFORE the first DB await so the network never queues behind the database. It never
    // rejects (companyLookup resolves every failure to status 'unavailable'), so a DB error below
    // cannot leave an unhandled rejection behind.
    const webLookup = lookupWebsites(q);

    // The user's own '%' is a character they typed, not a wildcard that matches the whole table.
    const esc = q.replace(/[\\%_]/g, (c) => '\\' + c);
    const prefix = esc + '%';
    const contains = '%' + esc + '%';
    const cand = Math.min(limit * 4, 100);   // over-fetch both sources, merge, then cut to `limit`
    const trgm = await hasTrigram();

    const [tracked, fromJobs, web] = await Promise.all([
      withTrigramFallback((t) => trackedEmployerHits(q, prefix, contains, cand, t), trgm),
      withTrigramFallback((t) => jobEmployerHits(q, prefix, contains, cand, country, t), trgm),
      webLookup,
    ]);
    // ⚠️ `country` narrows the firehose only — `employers` has no country column, and dropping
    // tracked hits for want of one would hide exactly the employers this endpoint exists to surface.
    // The web lookup has no country either.
    // ⚠️ A TRIGRAM-ONLY ROW (tier 3) IS A CANDIDATE UNTIL IT IS A TYPO OF THE QUERY (isTypoOf):
    // this is the clause that answered "xqzvnotacompany" with "Company" and "airbus" with Airbnb.
    // A nonsense query must come back EMPTY, so the sheet asks for the website instead.
    // ⚠️ …AND A NAME MADE ONLY OF LEGAL/GENERIC WORDS IS NOT SEARCHABLE AT ALL. "Company" keys to
    // 'company', so every one-edit query (acompany, xcompany) was a "typo" of it and got swisslinx.com.
    const plausible = (h) => hasCoreName(h.name) && (h.tier < 3 || isTypoOf(q, h.name));
    const shared = sharedPostingHosts();
    // ⚠️ GATE BEFORE MERGING: mergeEmployerHits keeps the first domain it sees, so a synthetic
    // "web-acme" on the tracked row would otherwise shadow a real website on the firehose row.
    const trackedRows = tracked.filter(plausible);
    const jobRows = fromJobs.filter(plausible);
    for (const h of trackedRows) h.domain = websiteOf(h.domain, h.name);
    for (const h of jobRows) h.domain = postingWebsite(h.name, h.domains, shared);
    const identities = mergeEmployerHits([...trackedRows, ...jobRows]);
    const merged = mergeWebHits(identities, web.hits, q).filter((e) => e.domain);   // no website, no row
    merged.sort((a, b) =>
      // Tier first, for every row alike: this is where a web row is placed by name match quality,
      // so an exact web match ("Nordex SE" for "nordex") sits above weak DB contains-matches.
      // (So a trigram-only DB row, tier 3, can never sit above an exact web match, tier 0.)
      a.tier - b.tier
      // A stored website the lookup contradicted goes below the one it verified (mergeWebHits).
      || (a.domainUnverified ? 1 : 0) - (b.domainUnverified ? 1 : 0)
      // ⚠️ SOURCE BEFORE JOB COUNT — this is where the header's promise ("look in `employers` …
      // before looking at the firehose at all") is actually kept. A tracked employer the firehose
      // has never crawled merges in with jobs: 0 and no location, so a domain-then-jobs tiebreak
      // sorted it BELOW any firehose subsidiary sharing its tier: search Nordex, and the one row
      // this endpoint exists to surface lands under "Nordex Energy Spain". A merged row keeps
      // source 'tracked' (tracked hits are merged first), so a company BOTH sources know about
      // rides this term too rather than being penalised for also being in the firehose.
      // Within a tier, then, what we already know (tracked, then crawled with jobs) stays above
      // what we only looked up: a web row has jobs 0 and sim 0.
      || (b.source === 'tracked' ? 1 : 0) - (a.source === 'tracked' ? 1 : 0)
      || b.jobs - a.jobs
      || b.sim - a.sim
      || a.name.length - b.name.length
      || String(a.name).localeCompare(String(b.name)));
    // ONE WEBSITE, ONE ROW. mergeWebHits never hands a domain to a second row, but two DB rows can
    // still arrive carrying the same one (a tracked and a firehose spelling the alias keys do not
    // join); the higher-ranked row keeps it.
    const seen = new Set();
    const rows = merged.filter((e) => !seen.has(e.domain) && seen.add(e.domain));

    res.json({
      success: true,
      websiteLookup: web.status,
      employers: rows.slice(0, limit).map((e) => ({
        name: e.name, domain: e.domain, location: e.location || null,
        jobs: e.jobs || 0, source: e.source,
        domainUnverified: !!e.domainUnverified,   // the web lookup named a different site for this employer
      })),
    });
  } catch (e) {
    console.error('[discover] employers error:', e.message);
    res.status(500).json({ error: 'Failed to search employers' });
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
  const raw = String(query || '').trim();
  const ql = raw.toLowerCase();
  let workMode = null;
  if (/\bremote\b/.test(ql)) workMode = 'remote';
  else if (/\bhybrid\b/.test(ql)) workMode = 'hybrid';
  else if (/\b(on[-\s]?site|onsite|in[-\s]?office)\b/.test(ql)) workMode = 'onsite';
  let seniority = null;
  const sm = ql.match(/\b(senior|junior|lead|principal|manager|intern|fresher)\b/);
  if (sm) seniority = sm[1];
  // location: "<role> in/near/around <place>" → the tail is the place (strip filler words).
  let location = null; let kwSource = ql;
  const lm = ql.match(/\b(?:in|near|around|based in)\b\s+(.+)$/);
  if (lm && typeof lm.index === 'number') {
    const cand = lm[1]
      .replace(/\b(jobs?|openings?|vacan\w*|positions?|roles?|near\s+me|my\s+area|me|area|region|location)\b/g, ' ')
      .replace(/[^a-z0-9\s,.-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cand && cand.length >= 2 && cand.length <= 40) { location = cand; kwSource = ql.slice(0, lm.index); }
  }
  const DROP = new Set(['near', 'around', 'based', 'nearby']);
  const keywords = kwSource.replace(/[^a-z0-9+#.\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w) && !DROP.has(w)).slice(0, 8);
  return { keywords, field: null, location, workMode, seniority };
}

// The user's own saved location (for "near me" / "my area" searches).
async function getUserProfileLoc(userId) {
  if (!userId) return null;
  try { return await dbConfig.get('SELECT city, country, address FROM users WHERE id = ?', [userId]); }
  catch { return null; }
}
// Country → its major cities/aliases, so "jobs in switzerland" also matches jobs whose location text
// is only a city ("Geneva", "Zürich"). Inclusive but accurate (still matches the job's real location).
const LOCATION_EXPANSIONS = {
  switzerland: { match: ['switzerland', 'schweiz', 'suisse', 'svizzera'], cities: ['geneva', 'genève', 'geneve', 'zurich', 'zürich', 'basel', 'bern', 'lausanne', 'zug', 'lugano', 'winterthur', 'st. gallen', 'st gallen', 'sankt gallen'] },
  germany: { match: ['germany', 'deutschland'], cities: ['berlin', 'munich', 'münchen', 'muenchen', 'hamburg', 'frankfurt', 'cologne', 'köln', 'koeln', 'stuttgart', 'düsseldorf', 'dusseldorf', 'bochum', 'leipzig'] },
  'united kingdom': { match: ['united kingdom', 'uk', 'britain', 'england', 'scotland'], cities: ['london', 'manchester', 'edinburgh', 'birmingham', 'glasgow', 'bristol', 'cambridge', 'leeds', 'oxford'] },
  netherlands: { match: ['netherlands', 'holland', 'nederland'], cities: ['amsterdam', 'rotterdam', 'utrecht', 'eindhoven', 'the hague', 'den haag'] },
  france: { match: ['france'], cities: ['paris', 'lyon', 'toulouse', 'marseille', 'lille', 'bordeaux', 'nantes', 'sophia antipolis'] },
  spain: { match: ['spain', 'españa', 'espana'], cities: ['madrid', 'barcelona', 'valencia', 'malaga', 'málaga', 'seville', 'sevilla'] },
  italy: { match: ['italy', 'italia'], cities: ['milan', 'milano', 'rome', 'roma', 'turin', 'torino', 'bologna'] },
  ireland: { match: ['ireland'], cities: ['dublin', 'cork', 'galway', 'limerick'] },
  india: { match: ['india'], cities: ['bangalore', 'bengaluru', 'mumbai', 'delhi', 'new delhi', 'gurgaon', 'gurugram', 'hyderabad', 'pune', 'chennai', 'noida', 'kolkata', 'ahmedabad'] },
  'united states': { match: ['united states', 'usa', 'u.s.', 'america'], cities: ['new york', 'san francisco', 'seattle', 'austin', 'boston', 'chicago', 'los angeles', 'denver', 'atlanta'] },
  sweden: { match: ['sweden', 'sverige'], cities: ['stockholm', 'gothenburg', 'göteborg', 'malmö', 'malmo'] },
  poland: { match: ['poland', 'polska'], cities: ['warsaw', 'warszawa', 'krakow', 'kraków', 'wroclaw', 'wrocław', 'gdansk'] },
  austria: { match: ['austria', 'österreich', 'osterreich'], cities: ['vienna', 'wien', 'graz', 'linz'] },
  portugal: { match: ['portugal'], cities: ['lisbon', 'lisboa', 'porto', 'braga'] },
  belgium: { match: ['belgium', 'belgique'], cities: ['brussels', 'bruxelles', 'antwerp', 'ghent'] },
  denmark: { match: ['denmark', 'danmark'], cities: ['copenhagen', 'københavn', 'aarhus'] },
  finland: { match: ['finland', 'suomi'], cities: ['helsinki', 'espoo', 'tampere'] },
  norway: { match: ['norway', 'norge'], cities: ['oslo', 'bergen', 'trondheim'] },
  uae: { match: ['uae', 'united arab emirates', 'emirates'], cities: ['dubai', 'abu dhabi'] },
};
function locationTerms(loc) {
  const l = String(loc || '').toLowerCase().trim();
  if (!l) return [];
  for (const [country, obj] of Object.entries(LOCATION_EXPANSIONS)) {
    if (l === country || obj.match.some((a) => l === a || l.includes(a))) return [country, ...obj.cities];
  }
  const dk = deaccent(l);
  if (CITY_ALIAS_LOOKUP.has(dk)) return CITY_ALIAS_LOOKUP.get(dk);   // multilingual city → all spellings
  return [l];
}

// Every known location term (countries + aliases + cities). Deterministic fix for parseSearchQuery
// non-determinism: the LLM sometimes drops a country/city into `keywords` with location=null, which
// disables the hard location filter and bleeds worldwide results (e.g. ".net developer austria" →
// {kw:[".net","developer","austria"],loc:null} → 972 jobs worldwide). Hoisting any location word out of
// keywords into `location` makes "…in <place>" ALWAYS a place, never a keyword — stable across parses.
const LOC_TERMS = (() => {
  const s = new Set();
  for (const obj of Object.values(LOCATION_EXPANSIONS)) { obj.match.forEach((a) => s.add(a)); obj.cities.forEach((c) => s.add(c)); }
  for (const country of Object.keys(LOCATION_EXPANSIONS)) s.add(country);
  return s;
})();
function normalizeParsedLocation(parsed) {
  if (!parsed) return parsed;
  const kws = Array.isArray(parsed.keywords) ? parsed.keywords : [];
  const kept = []; let hoisted = null;
  for (const k of kws) {
    if (LOC_TERMS.has(String(k || '').toLowerCase().trim())) { if (!hoisted) hoisted = k; continue; }
    kept.push(k);
  }
  parsed.keywords = kept;
  if (!parsed.location && hoisted) parsed.location = hoisted;
  return parsed;
}

// Diacritic-insensitive matching so a bare "zurich" query matches the stored "Zürich" (and Genève,
// Zürich, etc.). Applied to BOTH the query term (JS) and the stored column (SQL translate()).
const DEACC_FROM = 'üäöéèêàâçñ', DEACC_TO = 'uaoeeeaacn';
function deaccent(s) { return String(s || '').replace(/[üäöéèêàâçñ]/g, (m) => DEACC_TO[DEACC_FROM.indexOf(m)] || m); }
const SWISS_SET = new Set(['switzerland', ...LOCATION_EXPANSIONS.switzerland.match, ...LOCATION_EXPANSIONS.switzerland.cities].map((t) => deaccent(String(t).toLowerCase())));
function isSwissLocation(loc) {
  if (!loc) return false;
  const l = deaccent(String(loc).toLowerCase());
  if (l.includes('switzerland') || l.includes('schweiz') || l.includes('suisse')) return true;
  return locationTerms(loc).some((t) => SWISS_SET.has(deaccent(String(t).toLowerCase())));
}

// Multilingual city groups (EN/DE/FR/IT spellings) → so "geneva" matches the stored "Genève", "munich"
// matches "München", etc. Also gives us city→country so a bare-city query routes to the right feed.
const CITY_ALIASES = [
  { c: 'switzerland', a: ['geneva', 'genève', 'geneve', 'genf'] },
  { c: 'switzerland', a: ['zurich', 'zürich', 'zuerich'] },
  { c: 'switzerland', a: ['basel', 'bâle', 'bale'] },
  { c: 'switzerland', a: ['bern', 'berne'] },
  { c: 'switzerland', a: ['lucerne', 'luzern'] },
  { c: 'switzerland', a: ['st. gallen', 'st gallen', 'sankt gallen'] },
  { c: 'germany', a: ['munich', 'münchen', 'muenchen'] },
  { c: 'germany', a: ['cologne', 'köln', 'koeln'] },
  { c: 'germany', a: ['nuremberg', 'nürnberg', 'nuernberg'] },
  { c: 'germany', a: ['frankfurt'] }, { c: 'germany', a: ['hamburg'] }, { c: 'germany', a: ['berlin'] },
  { c: 'germany', a: ['stuttgart'] }, { c: 'germany', a: ['düsseldorf', 'dusseldorf', 'duesseldorf'] },
  { c: 'austria', a: ['vienna', 'wien'] }, { c: 'austria', a: ['graz'] }, { c: 'austria', a: ['salzburg'] },
  { c: 'france', a: ['paris'] }, { c: 'france', a: ['lyon'] }, { c: 'france', a: ['marseille'] },
];
const CITY_TO_COUNTRY = new Map();    // deaccented alias/city → country key
const CITY_ALIAS_LOOKUP = new Map();  // deaccented alias → full spelling group (for the SQL filter)
for (const g of CITY_ALIASES) for (const name of g.a) { const k = deaccent(name.toLowerCase()); CITY_TO_COUNTRY.set(k, g.c); CITY_ALIAS_LOOKUP.set(k, g.a); }
for (const [country, obj] of Object.entries(LOCATION_EXPANSIONS)) for (const city of obj.cities) { const k = deaccent(String(city).toLowerCase()); if (!CITY_TO_COUNTRY.has(k)) CITY_TO_COUNTRY.set(k, country); }

// Which country a location string belongs to (country name OR a known city) — drives the feed dispatch.
function detectCountry(loc) {
  if (!loc) return null;
  const l = deaccent(String(loc).toLowerCase().trim());
  for (const [country, obj] of Object.entries(LOCATION_EXPANSIONS)) {
    if (l === country || obj.match.some((a) => { const d = deaccent(a); return l === d || l.includes(d); })) return country;
  }
  if (CITY_TO_COUNTRY.has(l)) return CITY_TO_COUNTRY.get(l);
  for (const [k, c] of CITY_TO_COUNTRY) if (l.includes(k)) return c;
  return null;
}

const NEAR_ME_RE = /\b(near me|my area|nearby|near by|my location|around me|close to me|my city|my region|my place|around here)\b/i;

// Best-effort city from a free-text address ("…, Sector 15, Gurgaon, Haryana" → "Gurgaon"): the city
// is usually the comma-segment just before the state/country.
function cityFromAddress(addr) {
  const parts = String(addr || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[0] || '';
}

// NOTE: the in-app "Search" (formerly "Ask AI") over our OWN corpus is now a FREE, deterministic
// ATS-style search — no Gemini call, no credit charge. `parseSearchQuery` just runs the local
// keyword/location parser. (The old AI parser is kept below for any explicit AI callers.)
async function parseSearchQuery(query) {
  return naiveParse(String(query || '').trim().slice(0, 300));
}
async function parseSearchQueryAI(query, locHint) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return { keywords: [], field: null, location: null, workMode: null, seniority: null };
  if (!process.env.GEMINI_API_KEY) return naiveParse(q);
  try {
    const model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({
      model: PARSE_MODEL,
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },  // force clean JSON
    });
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
    const txt = String((r && r.response && r.response.text && r.response.text()) || '').trim();
    const m = txt.match(/\{[\s\S]*\}/);   // robust: pull the first {…} block even if the model adds prose/fences
    const j = JSON.parse(m ? m[0] : txt);
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

    // FREE search over our own corpus — no credit charge (deterministic ATS-style, no AI). Was `ai_search`.
    const resume = await getResume(req.user && req.user.id);
    const userSkills = skillsOf(resume);
    const noProfile = userSkills.length === 0;
    const userFieldObj = deriveUserField(resume);
    const loc = await getUserProfileLoc(req.user && req.user.id);
    const geo = await geoContext.getGeoContext(req.user && req.user.id, { field: userFieldObj ? userFieldObj.field : null });
    const parsed = await parseSearchQuery(rawQuery, loc);
    // "near me / my area" → resolve to the user's saved city (deterministic; wins over the AI).
    if (NEAR_ME_RE.test(rawQuery) && loc) {
      const city = (loc.city && String(loc.city).trim()) ? String(loc.city).trim() : cityFromAddress(loc.address);
      if (city) parsed.location = city;
    }
    normalizeParsedLocation(parsed);   // hoist any country/city out of keywords into location (deterministic)

    // ── WHERE ──
    const wParams = [];
    const WP = (v) => { wParams.push(v); return '$' + wParams.length; };
    const where = ['is_active'];
    const hasKw = !!(parsed.keywords && parsed.keywords.length);
    const kwWords = [];   // ORIGINAL search words (used for title-relevance ranking, so exact terms rank first)
    if (hasKw) {
      // Match a term in title/employer/skills/description.
      const orClause = (v) => { const p = WP('%' + v + '%'); return `(LOWER(title) LIKE ${p} OR LOWER(employer_name) LIKE ${p} OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(skills,'[]'::jsonb)) js WHERE lower(js) LIKE ${p}) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(responsibilities,'[]'::jsonb)) rs WHERE lower(rs) LIKE ${p}))`; };
      // Each keyword is required (AND across keywords), but SYNONYM VARIANTS are OR'd within it — so ".net"
      // also matches "dotnet", "node" matches "node.js"/"nodejs", "sde" matches "software engineer", etc.
      // (expandForSql drops noisy <3-char variants since matching is substring LIKE). Multi-word keywords
      // with no whole-phrase synonym keep the old word-AND behavior ("java developer" → java AND developer).
      for (const k of parsed.keywords) {
        const kl = String(k).toLowerCase().trim();
        if (!kl) continue;
        const whole = synonyms.expandTerm(kl);
        if (whole.length > 1) {
          const safe = [kl, ...whole.filter((v) => v !== kl && (v.length >= 3 || /[.#+]/.test(v)))];
          where.push('(' + [...new Set(safe)].map(orClause).join(' OR ') + ')');
          for (const w of kl.split(/\s+/)) { const ww = w.trim(); if (ww && !kwWords.includes(ww)) kwWords.push(ww); }
        } else {
          for (const w of kl.split(/\s+/)) {
            const ww = w.trim(); if (!ww) continue;
            where.push('(' + synonyms.expandForSql(ww).map(orClause).join(' OR ') + ')');
            if (!kwWords.includes(ww)) kwWords.push(ww);
          }
        }
      }
    }
    if (parsed.field) where.push(`field = ${WP(parsed.field)}`);
    // Location is a HARD filter: "…in switzerland" means jobs IN Switzerland (incl. its cities via
    // country→cities expansion), never a soft "rank first then bleed into the rest of Europe". Matches
    // the JOB's own location text (+ country→cities), never the board-HQ tag. (Coverage for a given
    // country grows via the silent-browser hydration, so thin locations fill in over time rather than
    // being padded with out-of-country roles.)
    let locMatchExpr = '0';
    if (parsed.location) {
      const locOr = '(' + locationTerms(parsed.location).map((t) => `translate(LOWER(location), '${DEACC_FROM}', '${DEACC_TO}') LIKE ${WP('%' + deaccent(String(t).toLowerCase()) + '%')}`).join(' OR ') + ')';
      where.push(locOr);
    }
    if (parsed.workMode) where.push(`LOWER(work_mode) = ${WP(parsed.workMode)}`);
    const whereSql = where.join(' AND ');

    const FIELDS = `job_url, title, employer_name, employer_domain, location, work_mode, job_type, salary, experience, responsibilities, skills, source, country, field, role_category, seniority, last_seen`;
    const params = [...wParams];
    const P = (v) => { params.push(v); return '$' + params.length; };
    const matchExpr = noProfile ? 'NULL::int' : matchExprSql(P(userSkills));
    // Query-relevance: how many of the searched words appear in the TITLE (a title hit beats a
    // description-only hit) — ranks the most on-point jobs to the top, even without a résumé.
    const relExpr = kwWords.length ? '(' + kwWords.map((w) => `(CASE WHEN LOWER(title) LIKE ${P('%' + w + '%')} THEN 1 ELSE 0 END)`).join(' + ') + ')' : '0';
    const useMatchSort = !noProfile;
    // Home-country ordering — but NOT when the searcher named a place themselves. "…in Sweden" is
    // already a hard filter; re-sorting that by where they live would be answering a question they
    // did not ask.
    const applyGeo = geo.active && !parsed.location;
    const geoSel = applyGeo ? `, ${geoRank.tierSql(geo.anchor, P, { countryCol: 'country', locationCol: 'location' })} AS geo_tier` : '';
    const geoOrd = applyGeo ? geoRank.orderSql(geo.mode, { tier: 'geo_tier', match: 'match' }) + ', ' : '';
    const baseOrder = (applyGeo && geo.mode === 'country-first') ? 'geo_tier ASC, last_seen DESC' : 'last_seen DESC';
    const rnOrder = 'rel DESC, ' + geoOrd + (useMatchSort ? 'match DESC NULLS LAST, last_seen DESC' : 'last_seen DESC');
    const finalOrder = 'rel DESC, ' + geoOrd + (useMatchSort ? 'match DESC NULLS LAST, rn ASC, last_seen DESC' : 'rn ASC, last_seen DESC');

    const sql = `
      WITH base AS (
        SELECT ${FIELDS}, ${matchExpr} AS match, ${relExpr} AS rel, ${locMatchExpr} AS loc_match${geoSel}
        FROM global_jobs WHERE ${whereSql}
        ORDER BY ${baseOrder} LIMIT ${BASE_CAP}
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY employer_name ORDER BY ${rnOrder}) AS rn FROM base
      )
      SELECT ${FIELDS}, match, rel, loc_match, COUNT(*) OVER ()::int AS total_filtered
      FROM ranked
      ORDER BY ${finalOrder}
      LIMIT ${P(limit)} OFFSET ${P(offset)}`;

    const mapRow = (r) => ({
      id: r.job_url, title: r.title, company: r.employer_name, employer_name: r.employer_name,
      employer_domain: r.employer_domain, location: r.location, work_mode: r.work_mode,
      job_type: r.job_type, salary: r.salary, experience: r.experience,
      responsibilities: Array.isArray(r.responsibilities) ? r.responsibilities : [],
      skills: Array.isArray(r.skills) ? r.skills : [], job_url: r.job_url, source: r.source,
      country: r.country, field: r.field, role_category: r.role_category, seniority: r.seniority,
      match: r.match == null ? null : Number(r.match),
    });
    const rows = await dbConfig.query(sql, params);
    let total = rows && rows.length ? rows[0].total_filtered : 0;
    let jobs = (rows || []).map(mapRow);

    // ── Grounded live enrichment (ASYNC, background) ────────────────────────────
    // When the structured corpus is thin for this query (first page only), kick off a Google-Search-
    // grounded discovery worldwide — the same mechanism the user ran manually in Gemini. It is SLOW
    // (~30-40s: grounding runs many web searches), so we DO NOT block the response. It runs in the
    // background, persists into global_jobs (+ caches on the normalized query), and the location/keyword
    // subset then surfaces instantly on the app's re-query (after the on-device silent browser) and on
    // any repeat search — proven: a query re-served from the grown corpus returns in ~2s. Every thin
    // search makes itself and the next one richer. Bounded + cached → only thin queries ever pay; repeats
    // are free. Kill-switch DISCOVER_GROUNDED=0, threshold DISCOVER_GROUNDED_MIN.
    const GROUNDED_MIN = parseInt(process.env.DISCOVER_GROUNDED_MIN || '8', 10);
    const COUNTRY_MIN = parseInt(process.env.DISCOVER_COUNTRY_MIN || '30', 10);
    const GROUNDED_ON = process.env.DISCOVER_GROUNDED !== '0';

    // FAST country-official fallback: dispatch to the right keyless government feed by the query's country
    // (CH Job-Room / DE Arbeitsagentur / FR France Travail), pull matching REAL jobs SYNCHRONOUSLY (~2s),
    // and re-run the SQL so they appear now — no slow grounded wait. Fires up to COUNTRY_MIN (the feeds
    // are cheap + precise); once ingested, repeats are served straight from the corpus.
    const feedCountry = (offset === 0 && total < COUNTRY_MIN) ? detectCountry(parsed.location) : null;
    if (feedCountry) {
      try {
        const kw = parsed.keywords || [];
        let ran = false;
        if (feedCountry === 'switzerland') { await firehose.ingestJobRoom({ keywords: kw, maxPages: 3, onlineSince: 60 }); ran = true; }
        else if (feedCountry === 'germany') { await firehose.ingestArbeitsagentur({ keywords: kw, location: parsed.location, maxPages: 3 }); ran = true; }
        else if (feedCountry === 'france') { const r = await firehose.ingestFranceTravail({ keywords: kw }); ran = !r.skipped; }
        if (ran) { const rows2 = await dbConfig.query(sql, params); if (rows2 && rows2.length) { total = rows2[0].total_filtered; jobs = rows2.map(mapRow); } }
      } catch (e) { console.error('[discover] country feed on-demand:', e.message); }
    }

    // SLOW global grounded fallback (async, background) — only if STILL thin after the fast path.
    const enriching = GROUNDED_ON && offset === 0 && total < GROUNDED_MIN && (hasKw || !!parsed.location);
    if (enriching) {
      aiHub.groundedDiscover(parsed, parsed.location || 'Global')
        .then((found) => (found && found.length) ? firehose.saveJobs(found, 'grounded', parsed.location || 'Global') : 0)
        .then((n) => n && console.log(`[discover] grounded bg saved ${n} jobs for "${(parsed.keywords || []).join(' ')}|${parsed.location || ''}"`))
        .catch((e) => console.error('[discover] grounded bg:', e.message));
    }

    res.json({
      success: true, urlDetected: false, parsed, jobs, total, offset, limit,
      hasMore: jobs.length === limit && (offset + jobs.length) < total, noProfile, enriching,
      userField: userFieldObj ? userFieldObj.field : null,
      geo: geoSummary(geo, applyGeo),
      xray: buildXray(parsed),   // the app runs this dork in a hidden on-device WebView → POST /discover/hydrate-urls
    });
  } catch (e) {
    console.error('[discover] ai-search error:', e.message);
    res.status(500).json({ error: 'Search failed' });
  }
}

// ─── Silent-browser X-Ray hydration ─────────────────────────────────────────────
// The app runs an X-Ray dork in a hidden on-device WebView (the USER's IP — no server-IP ban),
// scrapes the ATS board links, and posts them here. We hydrate each board through the 24-ATS engine
// (proven: 1 link → the employer's whole board) and ingest into global_jobs, so the network grows
// with every search and the very next /discover/ai-search picks the new jobs up.

// The ATS domains we can both DISCOVER via X-Ray and HYDRATE keylessly (high-yield first).
const XRAY_SITES = ['site:boards.greenhouse.io', 'site:job-boards.greenhouse.io', 'site:jobs.lever.co', 'site:jobs.ashbyhq.com'];

function buildXray(parsed) {
  const terms = [];
  (parsed && Array.isArray(parsed.keywords) ? parsed.keywords : []).slice(0, 2).forEach((k) => terms.push(k));
  if (parsed && parsed.location) terms.push(parsed.location);
  if (parsed && parsed.workMode === 'remote') terms.push('remote');
  const query = `(${XRAY_SITES.join(' OR ')}) ` + terms.map((t) => `"${t}"`).join(' ');
  // Per-site variants are more reliable than the OR-group on some engines — the app can fall back to these.
  const perSite = XRAY_SITES.map((s) => `${s} ` + terms.map((t) => `"${t}"`).join(' '));
  return { sites: XRAY_SITES, terms, query: query.trim(), perSite };
}

// Normalise a discovered ATS URL down to its board root (so many job links collapse to one board fetch).
function canonicalBoard(u) {
  let raw = String(u || '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  try {
    const url = new URL(raw);
    const h = url.hostname.toLowerCase();
    const seg = url.pathname.split('/').filter(Boolean)[0];
    if (!seg) return null;
    if (/(^|\.)(boards|job-boards)\.greenhouse\.io$/.test(h)) return `https://boards.greenhouse.io/${seg}`;
    if (/(^|\.)jobs\.lever\.co$/.test(h)) return `https://jobs.lever.co/${seg}`;
    if (/(^|\.)jobs\.ashbyhq\.com$/.test(h)) return `https://jobs.ashbyhq.com/${seg}`;
    return null;
  } catch { return null; }
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function hydrateUrls(req, res) {
  try {
    const urls = Array.isArray(req.body && req.body.urls) ? req.body.urls : [];
    const boards = [...new Set(urls.map(canonicalBoard).filter(Boolean))].slice(0, 12);
    if (!boards.length) return res.json({ success: true, boards: 0, hydrated: 0, ingested: 0 });
    let jobs = [];
    await ats.mapLimit(boards, 4, async (u) => {
      const r = await withTimeout(ats.detectAndFetchAts(u), 15000).catch(() => null);
      if (r && Array.isArray(r.jobs)) jobs = jobs.concat(r.jobs);
    });
    let ingested = 0;
    try { ingested = await firehose.saveJobs(jobs, 'xray', 'Global'); } catch (e) { console.error('[discover] hydrate ingest:', e.message); }
    res.json({ success: true, boards: boards.length, hydrated: jobs.length, ingested });
  } catch (e) {
    console.error('[discover] hydrate error:', e.message);
    res.status(500).json({ error: 'Hydrate failed' });
  }
}

// ─── "Look for live jobs on Google" — explicit, user-triggered live search ──────
// Returns app-style job CARDS from a grounded web search (title/company/location/highlights/link) — the
// UI renders these as our own cards + multiselect; the raw web page is NEVER shown. Cached + persisted.
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function jobCard(j) {
  return {
    id: j.job_url, job_url: j.job_url, title: j.title, company: j.employer_name, employer_name: j.employer_name,
    location: j.location || null, work_mode: j.work_mode || null, job_type: j.job_type || null,
    salary: j.salary || null, experience: j.experience || null, summary: j.summary || null,
    responsibilities: Array.isArray(j.responsibilities) ? j.responsibilities : [],
    skills: Array.isArray(j.skills) ? j.skills : [], source: hostOf(j.job_url),
    highlights: Array.isArray(j.responsibilities) ? j.responsibilities.slice(0, 3) : [],
  };
}

const GROUNDED_MIN = parseInt(process.env.DISCOVER_GROUNDED_MIN || '8', 10);
// Aggregator hosts — shown to the user in live-search cards, but NOT persisted into the shared global_jobs
// corpus (which stays employer-direct). Mirrors DISCOVER_AGG in aiHubController.
const AGG_URL = /indeed|glassdoor|linkedin|stepstone|monster\.|ziprecruiter|simplyhired|xing\.|naukri|foundit|talent\.com|jooble|careerjet|adzuna/i;
// Normalize a job URL for equality (strip tracking params + hash + trailing slash), so a live-search
// card and its already-saved copy match even when one carries utm/affiliate params and the other doesn't.
function normUrl(u) {
  try {
    const url = new URL(String(u || ''));
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|gclid|fbclid|msclkid|mc_|_hs)/i.test(k)) url.searchParams.delete(k);
    const q = url.searchParams.toString();
    return (url.origin + url.pathname + (q ? '?' + q : '')).replace(/\/+$/, '');
  } catch { return String(u || '').split('#')[0].replace(/\/+$/, ''); }
}

async function liveSearch(req, res) {
  try {
    const rawQuery = String((req.body && req.body.query) || req.query.q || '').trim().slice(0, 300);
    if (!rawQuery) return res.status(400).json({ error: 'Empty query' });
    const loc = await getUserProfileLoc(req.user && req.user.id);
    const parsed = await parseSearchQuery(rawQuery, loc);
    if (NEAR_ME_RE.test(rawQuery) && loc) {
      const city = (loc.city && String(loc.city).trim()) ? String(loc.city).trim() : cityFromAddress(loc.address);
      if (city) parsed.location = city;
    }
    normalizeParsedLocation(parsed);
    const region = parsed.location || 'Global';
    const kw = Array.isArray(parsed.keywords) ? parsed.keywords : [];
    const country = detectCountry(parsed.location);

    // Resolve `p` but never wait longer than `ms` (the losing promise keeps running; we stop waiting).
    const within = (p, ms, fb) => Promise.race([Promise.resolve(p).catch(() => fb), new Promise((r) => setTimeout(() => r(fb), ms))]);
    const dedupe = (list) => {
      const seen = new Set(); const out = [];
      for (const j of list) {
        if (!j || !j.job_url || !j.title) continue;
        const k = String(j.job_url).split('#')[0];
        if (seen.has(k)) continue; seen.add(k); out.push(j);
      }
      return out;
    };

    // FAST national feed (keyless government APIs, real jobs in ~1-2s) — the reliable path where covered.
    const feedP = (async () => {
      try {
        if (country === 'germany') { const r = await firehose.ingestArbeitsagentur({ keywords: kw, location: parsed.location, maxPages: 1 }); return r.jobs || []; }
        if (country === 'switzerland') { const r = await firehose.ingestJobRoom({ keywords: kw, maxPages: 1, onlineSince: 60 }); return r.jobs || []; }
        if (country === 'france') { const r = await firehose.ingestFranceTravail({ keywords: kw }); return r.jobs || []; }
      } catch (_) {}
      return [];
    })();
    const feedJobs = await within(feedP, 14000, []);
    let merged = dedupe(feedJobs);
    // COST: only pay for grounded web discovery ($0.035 Google-Search fee/call) when the free national
    // feed is THIN. A fat feed (100 gov jobs) already covers the query — no need to also ground.
    // The grounded path is the REAL worldwide Google search (works for ANY city/country, not just the
    // DE/CH/FR government feeds). Two things were making it return nothing for no-feed markets like India:
    //  (1) the cap was too short (grounding needs ~40-55s; groundedDiscover's own budget is ~52s enum +
    //      board hydration), and (2) aggregator results (Naukri/Indeed/LinkedIn) were being filtered out —
    //      but in India nearly every .NET posting is on an aggregator, so the strict filter left ZERO.
    //  → allowAggregators keeps them (the user opens/fetches on their own IP), and we give it ~66s.
    if (merged.length < GROUNDED_MIN) {
      const groundJobs = await within(aiHub.groundedDiscover(parsed, region, { allowAggregators: true }).catch(() => []), 66000, []);
      // Show the user ALL grounded jobs (incl. aggregators); only persist employer-DIRECT ones to the
      // shared corpus so global_jobs stays clean (the feed keeps preferring real employer career pages).
      if (groundJobs && groundJobs.length) firehose.saveJobs(groundJobs.filter((j) => j && j.job_url && !AGG_URL.test(String(j.job_url))), 'grounded', region).catch(() => {});
      merged = dedupe([...merged, ...groundJobs]);
    }

    // Mark jobs the user already saved, and float them to the BOTTOM (they render disabled + "Saved").
    let savedSet = new Set();
    try {
      await ensureSavedJobsTable();
      const rows = await dbConfig.query('SELECT job_url FROM user_saved_jobs WHERE user_id = $1', [req.user && req.user.id]);
      savedSet = new Set((rows || []).map((r) => normUrl(r.job_url)));
    } catch (_) {}
    const liveUserSkills = skillsOf(await getResume(req.user && req.user.id));
    const cards = merged.map(jobCard).map((c) => ({ ...c, saved: savedSet.has(normUrl(c.job_url)), match: computeCardMatch(c, liveUserSkills) }));
    cards.sort((a, b) => (a.saved ? 1 : 0) - (b.saved ? 1 : 0));   // unsaved first, saved last
    res.json({ success: true, parsed, cards, count: cards.length });
  } catch (e) { console.error('[discover] live-search:', e.message); res.status(500).json({ error: 'Live search failed' }); }
}

// Fetch ONE job's full details. The app opens the posting in the on-device WebView (the user's own IP →
// no bot wall), scrapes the page HTML, and posts it here; we AI-extract the structured job, STORE it, and
// return a full card. Falls back to a server-side fetch for non-bot-protected sites when no HTML is given.
async function fetchDetail(req, res) {
  try {
    const url = String((req.body && req.body.url) || '').trim();
    const html = (req.body && req.body.html) || '';
    // The page's VISIBLE text (SPA/iframe-proof). mainText is the same page narrowed to its
    // main/article region when it has one, so the extractor isn't weighing the nav, the footer and
    // the "more open roles" cards against the posting; pickPostingText falls back when it isn't one.
    const pageText = jobCapture.pickPostingText(
      String((req.body && req.body.pageText) || ''),
      String((req.body && req.body.mainText) || ''),
    );
    const employerHint = String((req.body && req.body.company) || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Missing/invalid url' });
    const haveHtml = !!(html && html.length > 200);
    const haveText = pageText.length > 120;
    // Live fetch costs credits — block up front if the user can't afford it; charge once on SUCCESS.
    const fetchUserId = req.user && req.user.id;
    const fetchCost = await getEventCost('live_fetch');
    if (fetchUserId && fetchCost > 0) {
      const bal = await dbConfig.get('SELECT credits_remaining FROM user_credits WHERE user_id = $1', [fetchUserId]);
      if (!bal || (bal.credits_remaining || 0) < fetchCost) return res.status(402).json({ error: `Insufficient credits — fetching a job needs ${fetchCost}.`, creditsRequired: fetchCost, creditsRemaining: bal ? bal.credits_remaining : 0 });
    }
    // NEVER bill a user who isn't there to receive the result. The app gives up at 45s; if it hung up
    // we still finish + save + cache the job (so their retry is instant and free) but skip the charge.
    // Node does not abort the handler on socket close, so without this the timeout silently billed.
    let clientGone = false;
    res.on('close', () => { if (!res.writableEnded) clientGone = true; });
    const chargeOnce = async () => {
      if (!fetchUserId || fetchCost <= 0 || clientGone) return;
      try { await chargeCredits(fetchUserId, 'live_fetch'); }
      catch (e) { console.error('[discover] fetch-detail charge:', e.message); }   // never 500 a good extraction
    };
    // CACHE: a job's details rarely change — reuse a prior good extraction (any user) and skip the LLM
    // entirely. Saves the ~$0.0015 extraction on every repeat fetch of the same posting.
    const cacheKey = 'fetchdetail:v2:' + normUrl(url);
    try {
      const hit = await aiHub.groundingCacheGet(cacheKey);
      if (hit && hit.title && Array.isArray(hit.responsibilities) && hit.responsibilities.length >= 3) {
        // Don't bill twice for the SAME posting: if it's already in this user's Saved Jobs (e.g. an
        // earlier attempt timed out on the phone but succeeded here), serve it back free.
        let already = false;
        try {
          await ensureSavedJobsTable();
          already = !!(await dbConfig.get('SELECT 1 AS x FROM user_saved_jobs WHERE user_id = $1 AND job_url = $2', [fetchUserId, hit.job_url || url]));
        } catch (_) {}
        if (!already) await chargeOnce();
        saveUserJob(fetchUserId, hit).catch(() => {});
        return res.json({ success: true, job: hit, cached: true });
      }
    } catch (_) {}
    // HARD DEADLINE. Every stage below is individually unbounded (the Gemini SDK gets no timeout), so
    // without this a slow extraction runs for minutes while the app times out at 45s and shows the
    // opaque "Could not fetch". Answering within 35s turns that into an honest, un-billed result.
    const within = (p, ms, fb) => Promise.race([Promise.resolve(p).catch(() => fb), new Promise((r) => setTimeout(() => r(fb), ms))]);
    const deadline = Date.now() + 35000;
    const left = () => Math.max(1000, deadline - Date.now());
    let job = null;
    if (haveHtml) {
      // Rich single-detail extraction: authoritative JSON-LD fields + the full JSON-LD description
      // (was being discarded) fed to a comprehensive translate-to-English prompt → full resp/skills.
      job = await within(aiJobExtractor.richDetailFromHtml(html, url, employerHint), left(), null);
      if (!job) {   // fallback to the listing extractor — CLIP so it can't take the 4-chunk serial branch
        job = await within((async () => {
          const cleaned = aiJobExtractor.cleanHtmlForLLM(html);
          const data = await aiJobExtractor.llmExtract(String(cleaned).slice(0, 30000), url, employerHint);
          let origin = ''; try { origin = new URL(url).origin; } catch {}
          const jobs = aiJobExtractor.toInternalJobs(data, url, origin, html) || [];
          return jobs.find((j) => j && j.title) || null;
        })(), left(), null);
      }
    }
    // TEXT fallback — the fix for "the page was clearly visible but we found nothing". SPA and
    // iframe-hosted boards (Greenhouse/SmartRecruiters/Workday) render the job where outerHTML can't
    // see it, but it IS in the page's visible text, which the app now also sends.
    if (!job && haveText) {
      job = await within((async () => {
        const out = await jobCapture.extractFromText(pageText, employerHint ? ('company=' + employerHint) : '');
        if (!out || !String(out.title || '').trim()) return null;
        return {
          title: String(out.title).trim(), employer_name: String(out.company || employerHint || '').trim() || null,
          location: String(out.location || '').trim() || null, work_mode: String(out.work_mode || '').trim() || null,
          job_type: String(out.employment_type || '').trim() || null, salary: String(out.salary || '').trim() || null,
          experience: String(out.seniority || '').trim() || null, summary: String(out.description || '').trim() || null,
          responsibilities: Array.isArray(out.responsibilities) ? out.responsibilities : [],
          skills: Array.isArray(out.skills) ? out.skills : [], job_url: url,
        };
      })(), left(), null);
    }
    // Server-side crawl ONLY when the app sent us nothing to work with (the comment here always said
    // "no on-device HTML" but the condition never checked it). When the app DID supply the page, this
    // 95-120s careers-site walk is both pointless — the server's IP is exactly what these sites block —
    // and the reason the request blew past the app's timeout.
    if (!job && !haveHtml && !haveText) {
      job = await within((async () => {
        try { const r = await ats.detectAndFetchAts(url); if (r && Array.isArray(r.jobs) && r.jobs.length) return r.jobs[0]; } catch (_) {}
        try { const r = await aiJobExtractor.findAndExtract(url, employerHint); if (r && Array.isArray(r.jobs) && r.jobs.length) return r.jobs[0]; } catch (_) {}
        return null;
      })(), left(), null);
    }
    if (!job || !job.title) return res.json({ success: false, error: 'Could not extract job details from this page' });
    if (!job.job_url) job.job_url = url;
    const region = detectCountry(job.location) || 'Global';
    firehose.saveJobs([job], 'fetched', region).catch(() => {});
    const card = jobCard(job);
    await chargeOnce();   // charge 1 on success — skipped if the app already gave up waiting
    // cache a GOOD extraction for reuse (7d); skip caching thin ones so a later fetch can do better.
    if (Array.isArray(card.responsibilities) && card.responsibilities.length >= 3) aiHub.groundingCacheSet(cacheKey, 'fetchdetail', card, 7 * 24 * 3600).catch(() => {});
    saveUserJob(fetchUserId, card).catch(() => {});   // add to the user's Saved Jobs
    res.json({ success: true, job: card });
  } catch (e) { console.error('[discover] fetch-detail:', e.message); res.status(500).json({ error: 'Fetch failed' }); }
}

// ─── Saved Jobs: per-user list of jobs fetched via live search ──────────────────
let _savedJobsReady = false;
async function ensureSavedJobsTable() {
  if (_savedJobsReady) return;
  await dbConfig.run(`
    CREATE TABLE IF NOT EXISTS user_saved_jobs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      job_url TEXT NOT NULL,
      card JSONB NOT NULL,
      saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, job_url)
    )
  `);
  try { await dbConfig.run(`CREATE INDEX IF NOT EXISTS idx_user_saved_jobs_user ON user_saved_jobs(user_id, saved_at DESC)`); } catch (_) {}
  _savedJobsReady = true;
}
async function saveUserJob(userId, card) {
  if (!userId || !card || !card.job_url) return;
  await ensureSavedJobsTable();
  await dbConfig.run(
    `INSERT INTO user_saved_jobs (user_id, job_url, card) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, job_url) DO UPDATE SET card = EXCLUDED.card, saved_at = CURRENT_TIMESTAMP`,
    [userId, card.job_url, JSON.stringify(card)]
  );
}
// GET /discover/saved-jobs — the user's fetched jobs, newest first.
async function savedJobs(req, res) {
  try {
    await ensureSavedJobsTable();
    const rows = await dbConfig.query(
      `SELECT card, saved_at FROM user_saved_jobs WHERE user_id = $1 ORDER BY saved_at DESC LIMIT 500`,
      [req.user.id]
    );
    // Attach a live résumé match % to every saved card (computed at read time so it tracks the current
    // résumé). Null when the user has no parsed skills — the card then simply shows no match badge.
    const userSkills = skillsOf(await getResume(req.user && req.user.id));
    const cards = (rows || []).map((r) => ({
      c: typeof r.card === 'string' ? JSON.parse(r.card) : r.card,
      saved_at: r.saved_at,
    }));

    // ── Borrow the real skills from the captured job ────────────────────────────────────────────
    // Shaping alone leaves a card with NO chips when every stored "skill" was a requirement
    // sentence (measured: all 14 on the Quickline card). The capture pipeline already extracted
    // proper ones for the same posting — ".NET · Kubernetes · Docker · Microservices" — so read
    // them from there instead of rendering an empty card. Two queries for the whole list, and
    // purely additive: a card that already has good skills is untouched.
    const cleanUrl = (u) => {
      try { const x = new URL(String(u)); return (x.origin + x.pathname).replace(/\/+$/, ''); }
      catch { return String(u || '').split('?')[0].split('#')[0].replace(/\/+$/, ''); }
    };
    const bySkills = new Map();     // cleaned job_url → [skill names]
    const byLevel = new Map();      // cleaned job_url → experience
    try {
      const urls = [...new Set(cards.map((x) => cleanUrl(x.c && x.c.job_url)).filter(Boolean))];
      if (urls.length) {
        const found = await dbConfig.query(
          `SELECT j.job_url, j.experience, s.name AS skill
             FROM jobs j
             LEFT JOIN job_skills js ON js.job_id = j.id
             LEFT JOIN skills s ON s.id = js.skill_id
            WHERE j.job_url = ANY($1)`, [urls]);
        (found?.rows || found || []).forEach((row) => {
          if (row.experience && !byLevel.has(row.job_url)) byLevel.set(row.job_url, row.experience);
          if (!row.skill) return;
          if (!bySkills.has(row.job_url)) bySkills.set(row.job_url, []);
          bySkills.get(row.job_url).push(row.skill);
        });
      }
    } catch (_) { /* best-effort: an empty chip row is not worth failing the list for */ }

    const jobs = cards.map(({ c, saved_at: savedAt }) => {
      // ⚠️ SHAPE THE CARD ON READ, not just on write. Cards saved before the extractors were fixed
      // hold requirement SENTENCES in `skills` ("Several years of experience in the software
      // development of modern solutions…"), which the Saved list renders as chips, and no seniority
      // at all — so the card looked wrong until the job was opened and a richer pipeline replaced
      // it. Doing it here repairs every card already saved, for every user, with no migration and
      // without needing an app update. The stored row is left untouched.
      const key = cleanUrl(c && c.job_url);
      let skills = cleanSkills(c && c.skills);
      if (!skills.length) skills = cleanSkills(bySkills.get(key));
      const experience = (c && c.experience) || byLevel.get(key) || seniorityFromTitle(c && c.title);
      return { ...c, skills, experience, match: computeCardMatch({ ...c, skills }, userSkills), saved_at: savedAt };
    });
    res.json({ success: true, jobs, count: jobs.length });
  } catch (e) { console.error('[discover] saved-jobs:', e.message); res.status(500).json({ error: 'Could not load saved jobs' }); }
}
// POST /discover/save-card {card} — save a job card directly (no fetch/extraction). Used as the graceful
// fallback so EVERY selected live-search job lands in Saved Jobs even when its detail page can't be scraped.
async function saveCard(req, res) {
  try {
    const c = req.body && req.body.card;
    if (!c || !c.job_url || !c.title) return res.status(400).json({ error: 'Invalid card' });
    const norm = jobCard({
      job_url: c.job_url, title: c.title, employer_name: c.employer_name || c.company,
      location: c.location, work_mode: c.work_mode, job_type: c.job_type, salary: c.salary,
      experience: c.experience, responsibilities: c.responsibilities, skills: c.skills,
    });
    await saveUserJob(req.user && req.user.id, norm);
    const region = detectCountry(norm.location) || 'Global';
    firehose.saveJobs([{ job_url: norm.job_url, title: norm.title, employer_name: norm.employer_name, location: norm.location }], 'fetched', region).catch(() => {});
    res.json({ success: true, job: norm });
  } catch (e) { console.error('[discover] save-card:', e.message); res.status(500).json({ error: 'Could not save' }); }
}
// POST /discover/saved-jobs/remove {url} — unsave one.
async function unsaveJob(req, res) {
  try {
    const url = String((req.body && req.body.url) || '').trim();
    if (!url) return res.status(400).json({ error: 'Missing url' });
    await ensureSavedJobsTable();
    await dbConfig.run(`DELETE FROM user_saved_jobs WHERE user_id = $1 AND job_url = $2`, [req.user.id, url]);
    res.json({ success: true });
  } catch (e) { console.error('[discover] unsave:', e.message); res.status(500).json({ error: 'Could not remove' }); }
}

// ─── GET /discover/job/:id — ONE feed job, by its synthetic 'gj_…' id or its raw job_url ────────
// Why this exists: a tapped push notification carries an id, not a whole job card (Expo caps the
// payload at ~4 KiB), so the app needs a way to turn that id back into the full job. `global_jobs`
// has no gj_ column and cannot index one — the hash is minted client-side from job_url — so the
// resolution lives in adminUserOps.resolveGlobalJobHash (log lookup first, then a cached hash scan).
// Required lazily: adminUserOps requires this controller back for matchExprSql.
async function getGlobalJobById(req, res) {
  try {
    const raw = String(req.params.id || '').trim();
    if (!raw) return res.status(400).json({ error: 'Missing job id' });

    const ops = require('../services/adminUserOps');
    let url = null;
    let truncated = false;
    if (/^gj_/i.test(raw)) {
      const r = await ops.resolveGlobalJobHash(raw);
      url = r.job_url;
      truncated = r.truncated;
    } else {
      url = raw;   // a raw job_url (URL-encoded in the path) also works
    }
    if (!url) {
      return res.status(404).json({
        error: 'Job not found',
        ...(truncated ? { truncated: true, note: 'The id scan hit its 60,000-row ceiling without a match — the job may be older than the scanned window.' } : {}),
      });
    }

    const resume = await getResume(req.user && req.user.id);
    const userSkills = skillsOf(resume);
    const noProfile = userSkills.length === 0;
    const params = [];
    const P = (v) => { params.push(v); return '$' + params.length; };
    const matchExpr = noProfile ? 'NULL::int' : matchExprSql(P(userSkills));
    const FIELDS = `job_url, title, employer_name, employer_domain, location, work_mode, job_type, salary, experience, responsibilities, skills, source, country, field, role_category, seniority, is_active, last_seen`;
    const r = await dbConfig.get(
      `SELECT ${FIELDS}, ${matchExpr} AS match FROM global_jobs WHERE job_url = ${P(url)} LIMIT 1`, params);
    if (!r) return res.status(404).json({ error: 'Job not found' });

    res.json({
      success: true, noProfile,
      job: {
        id: r.job_url, gj_id: ops.hashJobUrlId(r.job_url),
        title: r.title, company: r.employer_name, employer_name: r.employer_name,
        employer_domain: r.employer_domain, location: r.location, work_mode: r.work_mode,
        job_type: r.job_type, salary: r.salary, experience: r.experience,
        responsibilities: Array.isArray(r.responsibilities) ? r.responsibilities : [],
        skills: Array.isArray(r.skills) ? r.skills : [], job_url: r.job_url, source: r.source,
        country: r.country, field: r.field, role_category: r.role_category, seniority: r.seniority,
        is_active: r.is_active !== false, last_seen: r.last_seen,
        match: r.match == null ? null : Number(r.match),
      },
    });
  } catch (e) {
    console.error('[discover] job-by-id:', e.message);
    res.status(500).json({ error: 'Failed to load job' });
  }
}

module.exports = { discoverJobs, discoverFacets, discoverEmployers, aiSearch, hydrateUrls, liveSearch, fetchDetail, savedJobs, unsaveJob, saveCard, getGlobalJobById,
  // Exported for reuse ONLY (behaviour unchanged): the admin "matched jobs" view scores jobs with the
  // EXACT same expression + résumé-skill normalisation as the user's own feed, so the two never drift.
  matchExprSql, getResume, skillsOf };
