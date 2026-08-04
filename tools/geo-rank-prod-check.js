// READ-ONLY production check for the country-then-distance ranking:
//   node tools/geo-rank-prod-check.js "<postgres url>"        (or GEO_PROD_URL=… node tools/…)
//
// Three things a unit test cannot tell you, answered against the real corpus:
//   1. BEFORE / AFTER — the actual top 10 a real user gets, old ordering vs new.
//   2. SQL == JS — the tier Postgres computes for a row is the tier geoRank.tierOf() computes for
//      the same row. Two engines, one rule; this is what stops them drifting.
//   3. Coverage — how many live accounts have an anchor at all, and how many have a usable city.
//
// Every statement here is a SELECT. Nothing is written, nothing is deployed.
'use strict';
const path = require('path');
const { Pool } = require(path.join(__dirname, '..', 'node_modules', 'pg'));
const geoRank = require(path.join(__dirname, '..', 'server', 'utils', 'geoRank'));
const { deriveUserField } = require(path.join(__dirname, '..', 'server', 'utils', 'jobTaxonomy'));

const URL = process.argv[2] || process.env.GEO_PROD_URL;
if (!URL) { console.error('usage: node tools/geo-rank-prod-check.js "<postgres url>"'); process.exit(2); }
// The shared db-config pool times out over the Railway proxy — a direct pool is the documented way.
const pool = new Pool({ connectionString: URL, ssl: { rejectUnauthorized: false } });
const q = (sql, p = []) => pool.query(sql, p).then((r) => r.rows);

const USER_ID = parseInt(process.env.GEO_USER || '192', 10);
const BASE_CAP = 1500, MIN_MATCH = 10, LIMIT = 10;
const GJ = `job_url, title, employer_name, location, country, field, last_seen`;

// The live match expression, lifted from the controller so this check cannot score differently
// from the app. (Reading the source keeps the whole Express/Playwright dependency tree out of a
// read-only script.)
function matchExprSql(skillsParam) {
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'server', 'controllers', 'discoverController.js'), 'utf8');
  const m = src.match(/function matchExprSql\(skillsParam\) \{[\s\S]*?\n\}/);
  if (!m) throw new Error('could not lift matchExprSql from discoverController.js');
  return new Function(m[0] + '\nreturn matchExprSql;')()(skillsParam);
}

function skillsOf(meta) {
  let sk = meta && meta.skills;
  if (typeof sk === 'string') { try { sk = JSON.parse(sk); } catch { sk = []; } }
  if (!Array.isArray(sk)) return [];
  return sk.map((s) => String(s || '').toLowerCase().trim()).filter((s) => s.length >= 2).slice(0, 40);
}

// The ranked-jobs query, in its OLD and NEW ordering — everything else identical.
function rankedSql(skills, field, geo, mode) {
  const params = [];
  const P = (v) => { params.push(v); return '$' + params.length; };
  const match = matchExprSql(P(skills));
  const where = ['is_active'];
  if (field) where.push(`field = ${P(field)}`);
  const on = mode !== 'before' && geo && geo.active;
  const tier = on ? geoRank.tierSql(geo.anchor, P, { countryCol: 'country', locationCol: 'location' }) : null;
  const sel = on ? `, ${tier} AS geo_tier` : ', NULL::int AS geo_tier';
  const ord = on ? geoRank.orderSql(geo.mode, { tier: 'geo_tier', match: 'match' }) + ', ' : '';
  const baseOrder = (on && geo.mode === 'country-first') ? 'geo_tier ASC, last_seen DESC' : 'last_seen DESC';
  const sql = `
    WITH base AS (
      SELECT ${GJ}, ${match} AS match${sel}
      FROM global_jobs WHERE ${where.join(' AND ')}
      ORDER BY ${baseOrder} LIMIT ${BASE_CAP}
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY employer_name ORDER BY ${ord}match DESC NULLS LAST, last_seen DESC) AS rn FROM base
    ), filtered AS (SELECT * FROM ranked WHERE match >= ${MIN_MATCH})
    SELECT ${GJ}, match, geo_tier, COUNT(*) OVER ()::int AS total_filtered
    FROM filtered ORDER BY ${ord}match DESC NULLS LAST, rn ASC, last_seen DESC LIMIT ${P(LIMIT)}`;
  return { sql, params };
}

const pad = (s, n) => String(s == null ? '' : s).slice(0, n).padEnd(n);
function table(rows, anchor) {
  rows.forEach((r, i) => {
    const t = geoRank.tierOf(r, anchor);
    console.log(`   ${String(i + 1).padStart(2)}. ${pad(r.match + '%', 5)} ${pad(geoRank.TIER_LABEL[t], 20)} ${pad(r.country, 8)} ${pad(r.location, 26)} ${pad(r.title, 46)} ${pad(r.employer_name, 22)}`);
  });
}

(async () => {
  // ── the user ────────────────────────────────────────────────────────────────────────────────
  const [user] = await q('SELECT id, full_name, city, country, address FROM users WHERE id = $1', [USER_ID]);
  const [meta] = await q(`SELECT raw_text, skills, job_titles, industries FROM resume_metadata
                           WHERE user_id = $1 AND parse_status = 'done' ORDER BY id DESC LIMIT 1`, [USER_ID]);
  const anchor = geoRank.buildAnchor({ user, resumeMeta: meta });
  const f = deriveUserField(meta);
  const field = f ? f.field : null;
  const skills = skillsOf(meta);

  const cParams = [field];
  const cP = (v) => { cParams.push(v); return '$' + cParams.length; };
  const same = geoRank.sameCountrySql(anchor, cP, { countryCol: 'country', locationCol: 'location' });
  const [cnt] = field && anchor.country
    ? await q(`SELECT COUNT(*)::int n FROM global_jobs WHERE is_active AND field = $1 AND ${same}`, cParams)
    : [{ n: null }];
  const decided = geoRank.decideMode({ anchor, field, fieldJobsInCountry: cnt.n });
  const geo = { active: !!anchor.country, anchor, field, fieldJobsInCountry: cnt.n, ...decided };

  console.log(`\nUSER ${user.id} — ${user.full_name}`);
  console.log(`  profile: country=${JSON.stringify(user.country)} city=${JSON.stringify(user.city)} address=${JSON.stringify(user.address)}`);
  console.log(`  résumé field: ${field}   skills parsed: ${skills.length}`);
  console.log(`  anchor: ${JSON.stringify(anchor)}`);
  console.log(`  ${field} jobs in ${anchor.country}: ${cnt.n}   (floor ${geoRank.MIN_FIELD_JOBS})`);
  console.log(`  DECISION: ${geoRank.describe(geo)}`);
  console.log(`  NOTICE TO SHOW: ${geo.notice || '(none needed)'}`);
  if (field && anchor.country) {
    const rows = await q(`SELECT title, employer_name, location, country FROM global_jobs
                           WHERE is_active AND field = $1 AND ${same} ORDER BY last_seen DESC LIMIT 8`, cParams);
    console.log(`  every ${field} job in ${anchor.country} (the whole reason for the guard):`);
    rows.forEach((r) => console.log(`     • ${pad(r.title, 52)} ${pad(r.employer_name, 22)} ${pad(r.location, 24)} [${r.country}]`));
  }

  for (const mode of ['before', 'after']) {
    const { sql, params } = rankedSql(skills, field, geo, mode);
    const rows = await q(sql, params);
    console.log(`\n  ${mode.toUpperCase()} — top ${LIMIT} of ${rows.length ? rows[0].total_filtered : 0} (${mode === 'before' ? 'match only' : geo.mode})`);
    table(rows, anchor);
  }

  // The same user, if he had told us he lived in an IT city — proves country-first DOES engage when
  // the corpus can support it (the guard is what is holding it back, not the plumbing).
  const itGeo = { active: true, anchor: { country: 'France', city: 'Paris', region: null, countrySource: 'demo', citySource: 'demo' }, mode: 'country-first' };
  const itSkills = ['javascript', 'react', 'node.js', 'python', 'sql', 'aws'];
  console.log(`\n  CONTROL — a France/Paris user in "IT & Software" (231 jobs there → country-first ON)`);
  for (const mode of ['before', 'after']) {
    const { sql, params } = rankedSql(itSkills, 'IT & Software', itGeo, mode);
    const rows = await q(sql, params);
    console.log(`  ${mode.toUpperCase()}:`);
    table(rows, itGeo.anchor);
  }

  // ── SQL == JS on real rows ──────────────────────────────────────────────────────────────────
  const checkAnchor = { country: 'France', city: 'Paris', region: null, countrySource: 't', citySource: 't' };
  const p2 = [];
  const P2 = (v) => { p2.push(v); return '$' + p2.length; };
  const tierExpr = geoRank.tierSql(checkAnchor, P2, { countryCol: 'country', locationCol: 'location' });
  const sample = await q(
    `SELECT location, country, ${tierExpr} AS sql_tier FROM global_jobs
      WHERE is_active ORDER BY last_seen DESC LIMIT 20000`, p2);
  let bad = 0; const examples = [];
  for (const r of sample) {
    const js = geoRank.tierOf(r, checkAnchor);
    if (js !== r.sql_tier) { bad++; if (examples.length < 5) examples.push({ ...r, js }); }
  }
  const dist = {};
  for (const r of sample) dist[geoRank.TIER_LABEL[r.sql_tier]] = (dist[geoRank.TIER_LABEL[r.sql_tier]] || 0) + 1;
  console.log(`\nSQL vs JS on ${sample.length} real rows (France/Paris anchor): ${sample.length - bad} agree, ${bad} disagree`);
  if (bad) console.log('  disagreements:', JSON.stringify(examples, null, 1));
  console.log('  tier distribution:', JSON.stringify(dist));

  // ── coverage: how much of this feature can actually fire today ──────────────────────────────
  const users = await q(`SELECT id, city, country, address FROM users WHERE deleted_at IS NULL`);
  const heads = await q(`SELECT DISTINCT ON (user_id) user_id, LEFT(raw_text, 600) AS raw_text
                           FROM resume_metadata WHERE parse_status = 'done' ORDER BY user_id, id DESC`);
  const headBy = new Map(heads.map((h) => [h.user_id, h]));
  let withCountry = 0, withCity = 0, cityRejected = 0; const bySource = {};
  for (const u of users) {
    const a = geoRank.buildAnchor({ user: u, resumeMeta: headBy.get(u.id) || null });
    if (a.country) { withCountry++; bySource[a.countrySource] = (bySource[a.countrySource] || 0) + 1; }
    if (a.city) withCity++;
    if (a.cityRejected) cityRejected++;
  }
  console.log(`\nCOVERAGE over ${users.length} live accounts`);
  console.log(`  anchor country resolved : ${withCountry}  ${JSON.stringify(bySource)}`);
  console.log(`  usable city             : ${withCity}   (users.city set: ${users.filter((u) => String(u.city || '').trim()).length})`);
  console.log(`  city rejected as inconsistent with the country: ${cityRejected}`);
  console.log(`  → for ${users.length - withCountry} accounts every query is byte-identical to today.`);

  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
