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
const { chargeCredits, getEventCost } = require('../services/eventCosts');   // credit metering for AI search + live fetch
const synonyms = require('../utils/searchSynonyms');   // .net⇄dotnet, node⇄node.js, sde⇄software engineer …

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
    const rnOrder = 'rel DESC, ' + (useMatchSort ? 'match DESC NULLS LAST, last_seen DESC' : 'last_seen DESC');
    const finalOrder = 'rel DESC, ' + (useMatchSort ? 'match DESC NULLS LAST, rn ASC, last_seen DESC' : 'rn ASC, last_seen DESC');

    const sql = `
      WITH base AS (
        SELECT ${FIELDS}, ${matchExpr} AS match, ${relExpr} AS rel, ${locMatchExpr} AS loc_match
        FROM global_jobs WHERE ${whereSql}
        ORDER BY last_seen DESC LIMIT ${BASE_CAP}
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
    const employerHint = String((req.body && req.body.company) || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Missing/invalid url' });
    // Live fetch costs credits — block up front if the user can't afford it; charge once on SUCCESS
    // (a failed extraction is not charged, so the mobile's auto-retry can't double-bill).
    const fetchUserId = req.user && req.user.id;
    const fetchCost = await getEventCost('live_fetch');
    if (fetchUserId && fetchCost > 0) {
      const bal = await dbConfig.get('SELECT credits_remaining FROM user_credits WHERE user_id = $1', [fetchUserId]);
      if (!bal || (bal.credits_remaining || 0) < fetchCost) return res.status(402).json({ error: `Insufficient credits — fetching a job needs ${fetchCost}.`, creditsRequired: fetchCost, creditsRemaining: bal ? bal.credits_remaining : 0 });
    }
    // CACHE: a job's details rarely change — reuse a prior good extraction (any user) and skip the LLM
    // entirely. Saves the ~$0.0015 extraction on every repeat fetch of the same posting.
    const cacheKey = 'fetchdetail:v2:' + normUrl(url);
    try {
      const hit = await aiHub.groundingCacheGet(cacheKey);
      if (hit && hit.title && Array.isArray(hit.responsibilities) && hit.responsibilities.length >= 3) {
        if (fetchUserId && fetchCost > 0) await chargeCredits(fetchUserId, 'live_fetch');
        saveUserJob(fetchUserId, hit).catch(() => {});
        return res.json({ success: true, job: hit, cached: true });
      }
    } catch (_) {}
    let job = null;
    if (html && html.length > 200) {
      // Rich single-detail extraction: authoritative JSON-LD fields + the full JSON-LD description
      // (was being discarded) fed to a comprehensive translate-to-English prompt → full resp/skills.
      try { job = await aiJobExtractor.richDetailFromHtml(html, url, employerHint); }
      catch (e) { console.error('[discover] fetch-detail rich:', e.message); }
      if (!job) {   // fallback to the listing extractor
        try {
          const cleaned = aiJobExtractor.cleanHtmlForLLM(html);
          const data = await aiJobExtractor.llmExtract(cleaned, url, employerHint);
          let origin = ''; try { origin = new URL(url).origin; } catch {}
          const jobs = aiJobExtractor.toInternalJobs(data, url, origin, html) || [];
          job = jobs.find((j) => j && j.title) || null;
        } catch (e) { console.error('[discover] fetch-detail extract:', e.message); }
      }
    }
    if (!job) {   // fallback for non-bot sites (no on-device HTML)
      try { const r = await ats.detectAndFetchAts(url); if (r && Array.isArray(r.jobs) && r.jobs.length) job = r.jobs[0]; } catch (_) {}
      if (!job) { try { const r = await aiJobExtractor.findAndExtract(url, employerHint); if (r && Array.isArray(r.jobs) && r.jobs.length) job = r.jobs[0]; } catch (_) {} }
    }
    if (!job || !job.title) return res.json({ success: false, error: 'Could not extract job details from this page' });
    if (!job.job_url) job.job_url = url;
    const region = detectCountry(job.location) || 'Global';
    firehose.saveJobs([job], 'fetched', region).catch(() => {});
    const card = jobCard(job);
    if (fetchUserId && fetchCost > 0) await chargeCredits(fetchUserId, 'live_fetch');   // charge 1 on success
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
    const jobs = (rows || []).map((r) => { const c = typeof r.card === 'string' ? JSON.parse(r.card) : r.card; return { ...c, match: computeCardMatch(c, userSkills), saved_at: r.saved_at }; });
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

module.exports = { discoverJobs, discoverFacets, aiSearch, hydrateUrls, liveSearch, fetchDetail, savedJobs, unsaveJob, saveCard };
