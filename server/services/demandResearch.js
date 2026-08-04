// Demand-driven job research — ADDITIVE, ISOLATED. Twice a day (env-tunable) this walks the
// interests real users saved (skills + city/country) plus their résumé skills, asks a
// Google-grounded Gemini call to FIND live postings for that demand — prioritising the user's own
// city, then country, then remote/world — extracts each discovered posting with the existing
// deterministic-first extractor, and upserts the results into global_jobs (the production feed).
// After a run, users whose interests just gained fresh matching jobs get ONE push
// ("New matching jobs for you") — per-user daily dedupe, notification prefs respected.
//
// Cost rails: MAX_CLUSTERS_PER_RUN grounded calls (flash + search grounding) and
// MAX_URLS_PER_CLUSTER extraction calls (flash-lite) per cluster, per run. At the defaults that is
// ≤12 grounded + ≤96 lite calls twice a day — well inside the grounding free tier.
'use strict';

const crypto = require('crypto');
const dbConfig = require('../../db-config');
const { fetchHtml } = require('../utils/pageFetch');
const { richDetailFromHtml } = require('./aiJobExtractor');
const { saveJobs } = require('./globalJobFirehose');
const { sendPushNotification } = require('./expoPushService');
const notifPrefs = require('./notificationPrefs');

const INTERVAL_H = parseFloat(process.env.DEMAND_RESEARCH_HOURS || '12');
const ENABLED = (process.env.DEMAND_RESEARCH_ENABLED || '1') === '1';
const MAX_CLUSTERS_PER_RUN = parseInt(process.env.DEMAND_RESEARCH_CLUSTERS || '12', 10);
const MAX_URLS_PER_CLUSTER = parseInt(process.env.DEMAND_RESEARCH_URLS || '8', 10);
// Founder/test accounts never drive research or receive these pushes.
// User 1 (the founder) is deliberately NOT excluded here: their saved interests must be
// researched like anyone's, or the end-to-end loop (save interest → research → match push)
// can never be tested from the real app. The other ids are pure test accounts.
const TEST_USER_IDS = new Set([4, 5, 6, 7, 8, 9, 11, 14, 24, 26, 41, 43]);

function geminiGrounded() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    return new GoogleGenerativeAI(key).getGenerativeModel({
      model: process.env.GEMINI_FLASH_MODEL || 'gemini-2.5-flash',
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    });
  } catch { return null; }
}

// ── demand clusters: one per saved interest, freshest interests first ─────────────────────────
async function loadClusters() {
  const rows = await dbConfig.query(
    `SELECT i.id, i.user_id, i.country, i.city, i.skills
       FROM user_job_interests i
       JOIN users u ON u.id = i.user_id AND u.deleted_at IS NULL
      ORDER BY i.created_at DESC LIMIT 200`);
  const clusters = new Map();   // key country|city|skills → { country, city, skills, userIds }
  for (const r of rows || []) {
    if (TEST_USER_IDS.has(Number(r.user_id))) continue;
    let skills = [];
    try { skills = Array.isArray(r.skills) ? r.skills : JSON.parse(r.skills || '[]'); } catch {}
    skills = skills.map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
    if (!skills.length || !r.country) continue;
    const key = [String(r.country).toLowerCase(), String(r.city || '').toLowerCase(), skills.join(',').toLowerCase()].join('|');
    if (!clusters.has(key)) clusters.set(key, { country: r.country, city: r.city || null, skills, userIds: new Set() });
    clusters.get(key).userIds.add(Number(r.user_id));
  }
  return [...clusters.values()].slice(0, MAX_CLUSTERS_PER_RUN);
}

// ── discovery: grounded search for live posting URLs ──────────────────────────────────────────
async function discoverUrls(model, cluster) {
  const place = cluster.city ? `${cluster.city}, ${cluster.country}` : cluster.country;
  const prompt =
    `Find CURRENT job openings for these skills: ${cluster.skills.join(', ')}.\n` +
    `Location priority: 1) ${place}, 2) anywhere in ${cluster.country}, 3) remote roles open to ${cluster.country}.\n` +
    `Return ONLY a JSON array of direct job-POSTING page URLs on employer career sites or their ATS ` +
    `(greenhouse.io, lever.co, ashbyhq.com, recruitee.com, workable.com, smartrecruiters.com or the ` +
    `employer's own domain). NO aggregator/search-result pages (no linkedin/indeed/naukri/glassdoor lists), ` +
    `no login-walled pages. Up to ${MAX_URLS_PER_CLUSTER + 4} URLs. JSON array of strings only.`;
  try {
    const res = await model.generateContent(prompt);
    const text = res.response.text() || '';
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return (Array.isArray(arr) ? arr : [])
      .map((u) => String(u).trim())
      .filter((u) => /^https?:\/\//i.test(u))
      .filter((u) => !/linkedin\.com|indeed\.|glassdoor\.|naukri\.com\/(?!.*job-listings)|google\.com\/search/i.test(u))
      .slice(0, MAX_URLS_PER_CLUSTER);
  } catch (e) {
    console.warn('[demandResearch] discovery failed:', String(e.message).slice(0, 120));
    return [];
  }
}

// ── extraction: each discovered URL → one job row in global_jobs ──────────────────────────────
async function ingestUrl(url, cluster, source = 'demand_research') {
  try {
    const exists = await dbConfig.query('SELECT 1 FROM global_jobs WHERE job_url = $1', [url]);
    if (exists && exists.length) return 0;   // already known — the upsert would only bump last_seen
    const page = await fetchHtml(url, { tries: 2, timeout: 15000 });
    if (!page.ok || page.blocked || !page.html) return 0;
    const detail = await richDetailFromHtml(page.html, url);
    if (!detail || !detail.title) return 0;
    const job = {
      job_url: url,
      title: detail.title,
      employer_name: detail.employer_name || detail.company || null,
      location: detail.location || (cluster.city ? `${cluster.city}, ${cluster.country}` : cluster.country),
      job_type: detail.job_type || null, salary: detail.salary || null, experience: detail.experience || null,
      responsibilities: Array.isArray(detail.responsibilities) ? detail.responsibilities : [],
      skills: Array.isArray(detail.skills) ? detail.skills : [],
    };
    return await saveJobs([job], source, cluster.country);
  } catch (e) {
    return 0;
  }
}

// ── match push: fresh jobs that fit an interest → one notification per user per day ───────────
async function notifyMatchedUsers(sinceIso) {
  if (!(await require('./notifSwitch').isOn('demand_jobs'))) return 0;
  const ir = require('./instantResearch');
  // Jobs an INSTANT run went and found for this user are older than this run's start, so the
  // `first_seen >= sinceIso` filter below would hide the very jobs we researched on their behalf.
  // An unconsumed handoff widens the window back to that run. See instantResearch.sinceForUser.
  const handoffs = await ir.pendingHandoffs().catch(() => new Map());
  const interests = await dbConfig.query(
    `SELECT i.user_id, i.country, i.city, i.skills, u.expo_push_token
       FROM user_job_interests i
       JOIN users u ON u.id = i.user_id AND u.deleted_at IS NULL
      WHERE u.expo_push_token IS NOT NULL AND u.expo_push_token <> ''`);
  const perUser = new Map();
  for (const r of interests || []) {
    if (TEST_USER_IDS.has(Number(r.user_id))) continue;
    let skills = [];
    try { skills = Array.isArray(r.skills) ? r.skills : JSON.parse(r.skills || '[]'); } catch {}
    skills = skills.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    if (!skills.length || !r.country) continue;
    // fresh jobs in this interest's country matching any skill by skills-array or title
    const since = ir.sinceForUser(sinceIso, handoffs.get(Number(r.user_id)));
    const likeAny = skills.map((_, i) => `(LOWER(skills::text) LIKE $${i + 3} OR LOWER(title) LIKE $${i + 3})`).join(' OR ');
    const params = [r.country, since, ...skills.map((s) => `%${s.toLowerCase()}%`)];
    const rows = await dbConfig.query(
      `SELECT COUNT(*)::int AS n FROM global_jobs
        WHERE is_active AND country = $1 AND first_seen >= $2 AND (${likeAny})`, params).catch(() => null);
    const n = rows && rows[0] ? rows[0].n : 0;
    if (n > 0) {
      const cur = perUser.get(r.user_id)
        || { n: 0, token: r.expo_push_token, place: r.city || r.country, skill: skills[0],
             city: r.city, country: r.country, cands: [], terms: [], seen: new Set() };
      cur.n += n;
      // ⚠️ Score against EVERY skill this user asked for, not just the first one. A single term can
      // only ever score 0 or 1, and pickStandoutJob needs minScore 2 + a lead of 2 — so scoring on
      // `skills[0]` alone made a standout arithmetically impossible for any user with more than one
      // candidate, and the deep-link silently degraded to the feed in exactly the cases it was for.
      for (const s of skills) if (!cur.terms.includes(s)) cur.terms.push(s);
      // The candidates behind the number, nearest first — so a push about ONE job can open THAT
      // job instead of dropping the user on the feed to hunt for it. Deduped by job_url: two saved
      // interests that match the same posting are one job, and counting it twice turned "the one
      // job for you" into a two-candidate tie with no standout.
      const cand = await dbConfig.query(
        `SELECT job_url, title, location, skills FROM global_jobs
          WHERE is_active AND country = $1 AND first_seen >= $2 AND (${likeAny})
          ORDER BY first_seen DESC LIMIT 20`, params).catch(() => []);
      for (const j of cand || []) {
        if (!j || !j.job_url || cur.seen.has(j.job_url)) continue;
        cur.seen.add(j.job_url);
        cur.cands.push(j);
      }
      perUser.set(r.user_id, cur);
    }
  }

  let sent = 0;
  for (const [userId, m] of perUser) {
    try {
      // prefs: these are marketing-ish job alerts → the 'digest' category governs them
      const ok = await notifPrefs.isEnabled(userId, 'digest').catch(() => true);
      if (!ok) continue;
      // daily dedupe via notifications log (shared with the résumé-match push — one job alert/day)
      const dup = await dbConfig.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND type IN ('demand_jobs','resume_match_jobs') AND created_at > NOW() - INTERVAL '20 hours' LIMIT 1`, [userId]);
      if (dup && dup.length) continue;
      const title = 'New matching jobs for you 🎯';
      const body = `${m.n} new ${m.skill} ${m.n === 1 ? 'job' : 'jobs'} near ${m.place} just landed — take a look.`;
      // One standout job → open THAT job ('/(discover)' + { jobId }); a genuine set → the feed.
      const ordered = ir.orderByProximity(m.cands, { city: m.city, country: m.country });
      const scoreTerms = (m.terms && m.terms.length) ? m.terms : [m.skill];
      const standout = ir.pickStandoutJob(ordered.map((j) => ({ ...j, score: ir.overlapScore(j, scoreTerms) })));
      const params = ir.pushParamsForMatch(standout);
      const pushed = await sendPushNotification(m.token, title, body, { route: '/(discover)', params, action: 'demand_jobs' });
      await dbConfig.query(
        `INSERT INTO notifications (user_id, type, title, message, created_at) VALUES ($1,'demand_jobs',$2,$3,NOW())`,
        [userId, title, body]).catch(() => {});
      // Shared ledger — see services/nudgeGate.js. Without this row the lifecycle nudges cannot
      // see that this user already heard from us today, and would push again within the hour.
      await require('./nudgeGate').record(userId, 'demand_jobs', { pushOk: pushed === true });
      // The hand-back is complete ONLY if the push actually went out. Marking it done on a failed
      // send would consume the widened window and the user would never hear about the jobs we spent
      // a grounded call finding for them. pendingHandoffs stops retrying after 7 days.
      if (pushed === true) await ir.markHandoffDone(userId).catch(() => {});
      sent++;
    } catch (e) { console.warn('[demandResearch] push failed for', userId, e.message); }
  }
  return sent;
}

// ── résumé match push: fresh jobs that fit a user's RESUME skills (no saved interest needed) ──
// "6 new plumbing jobs in Canada" — the copy names the dominant skill and country of the matched
// jobs. One job alert per user per day (dedupe shared with the interest push above).
function flatSkills(v) {
  try {
    const a = typeof v === 'string' ? JSON.parse(v) : v;
    if (Array.isArray(a)) return a.map(String);
    if (a && typeof a === 'object') return Object.values(a).flat().map(String);
  } catch {}
  return [];
}

// Generic résumé filler must never drive a push — "6 new communication skills jobs" and
// "60 new manager jobs" are spam. Includes bare seniority/role fillers and language names.
const GENERIC_TERMS = new Set([
  'skill', 'skills', 'communication', 'communications', 'teamwork', 'leadership', 'management',
  'microsoft', 'office', 'excel', 'word', 'powerpoint', 'computer', 'computers', 'training',
  'service', 'services', 'customer', 'professional', 'experience', 'organization', 'organizational',
  'problem', 'solving', 'analysis', 'analytical', 'detail', 'oriented', 'ability', 'strong',
  'basic', 'advanced', 'general', 'suite', 'internet', 'email', 'entry', 'reporting', 'tools',
  'knowledge', 'good', 'quick', 'learner', 'listener', 'verbal', 'written', 'interpersonal',
  'time', 'work', 'team', 'planning', 'support', 'operations', 'systems', 'system', 'standards',
  'application', 'applications', 'course', 'courses', 'hygiene', 'health', 'safety', 'sales',
  'manager', 'managers', 'executive', 'executives', 'assistant', 'assistants', 'specialist',
  'specialists', 'commercial', 'associate', 'associates', 'officer', 'coordinator', 'coordination',
  'director', 'supervisor', 'senior', 'junior', 'intern', 'degree', 'bachelor', 'master',
  'university', 'college', 'school', 'english', 'french', 'spanish', 'arabic', 'hindi', 'fluent',
  'driving', 'license', 'licence', 'certificate', 'certified', 'proficient', 'proficiency',
  'leader', 'leaders', 'business', 'project', 'projects', 'process', 'processes', 'quality',
  'development', 'strategy', 'strategic', 'generation', 'tracking', 'monitoring', 'records',
  'table', 'tables', 'pivot', 'charts', 'presentation', 'presentations', 'documentation',
  'posting', 'postings', 'workflow', 'workflows', 'deputy', 'assistant', 'trainee', 'staff',
]);

// City/region → country, for résumés whose address line names a place but not the country
// ("Port Coquitlam, BC" / "Noida, Uttar Pradesh"). Country values MUST match global_jobs.country.
const REGION_COUNTRY = [
  [['british columbia', 'coquitlam', 'vancouver', 'ontario', 'toronto', 'alberta', 'calgary', 'quebec', 'montreal'], 'Canada'],
  [['texas', 'houston', 'california', 'new york', 'florida', 'chicago', 'seattle', 'hawaii'], 'US'],
  [['noida', 'uttar pradesh', 'delhi', 'mumbai', 'bengaluru', 'bangalore', 'hyderabad', 'chennai', 'pune', 'kolkata', 'visakhapatnam', 'indore', 'gurgaon', 'gurugram'], 'India'],
  [['gauteng', 'centurion', 'johannesburg', 'cape town', 'pretoria', 'durban'], 'South Africa'],
  [['lisboa', 'lisbon', 'sintra', 'cacém', 'cacem', 'porto', 'cascais'], 'Portugal'],
  [['casablanca', 'marrakech', 'marrakesh', 'rabat', 'tangier', 'tanger', 'agadir', 'belksiri', 'kenitra'], 'Morocco'],
  [['grasse', 'paris', 'lyon', 'marseille', 'toulouse', 'boulevard fragonard'], 'France'],
  [['london', 'manchester', 'birmingham', 'glasgow', 'edinburgh'], 'UK'],
  [['dubai', 'abu dhabi', 'sharjah'], 'UAE'],
  [['taxila', 'islamabad', 'karachi', 'lahore', 'rawalpindi'], 'Pakistan'],
  [['colombo', 'kandy'], 'Sri Lanka'],
];
const COUNTRY_ALIASES = [
  ['canada', 'Canada'], ['united states', 'US'], ['u.s.a', 'US'], [' usa', 'US'],
  ['india', 'India'], ['south africa', 'South Africa'], ['portugal', 'Portugal'],
  ['morocco', 'Morocco'], ['maroc', 'Morocco'], ['france', 'France'],
  ['united kingdom', 'UK'], ['united arab emirates', 'UAE'], ['pakistan', 'Pakistan'],
  ['sri lanka', 'Sri Lanka'], ['germany', 'Germany'], ['netherlands', 'Netherlands'],
  ['sweden', 'Sweden'], ['switzerland', 'Switzerland'], ['spain', 'Spain'], ['italy', 'Italy'],
  ['australia', 'Australia'], ['nigeria', 'Nigeria'], ['kenya', 'Kenya'], ['egypt', 'Egypt'],
  ['philippines', 'Philippines'], ['indonesia', 'Indonesia'], ['brazil', 'Brazil'],
];

// The user's own country from their résumé text — or null, in which case we DON'T push
// (better silent than telling a Morocco waiter about jobs in India). EARLIEST mention wins:
// the address line sits at the top of a résumé, while stray country words ("… clients in India")
// can appear anywhere below it.
function countryFromResume(rawLower) {
  if (!rawLower) return null;
  let best = null, bestIdx = Infinity;
  const consider = (needle, country) => {
    const i = rawLower.indexOf(needle);
    if (i >= 0 && i < bestIdx) { best = country; bestIdx = i; }
  };
  for (const [alias, country] of COUNTRY_ALIASES) consider(alias, country);
  for (const [places, country] of REGION_COUNTRY) for (const p of places) consider(p, country);
  return best;
}

// "plumbing" must match "Plumber": crude suffix stem, used for the SQL LIKE; the ORIGINAL word
// stays as the human label in the push copy.
const stemOf = (w) => (w.length >= 6 ? w.replace(/(ings?|ers?|s)$/, '') : w);

// Build match terms from a résumé: job TITLES first (strongest signal — "sql developer",
// "waiter"), then tokens of technical skills. Each term = { stem (SQL), label (copy) }.
function resumeTerms(row) {
  const terms = [];
  const seen = new Set();
  const push = (stem, label) => {
    if (stem.length < 4 || GENERIC_TERMS.has(stem) || seen.has(stem)) return;
    seen.add(stem); terms.push({ stem, label });
  };
  for (const t of flatSkills(row.job_titles)) {
    const phrase = String(t).trim().toLowerCase();
    if (phrase.length >= 5 && phrase.length <= 40 && phrase.split(/\s+/).length <= 3) push(phrase, phrase);
    for (const w of phrase.split(/[^a-zà-ÿ]+/i)) if (w.length >= 5 && !GENERIC_TERMS.has(w)) push(stemOf(w), w);
  }
  for (const t of [...flatSkills(row.technical_skills), ...flatSkills(row.skills)]) {
    for (const w of String(t).toLowerCase().split(/[^a-zà-ÿ]+/i)) {
      if (w.length >= 5 && !GENERIC_TERMS.has(w)) push(stemOf(w), w);
    }
  }
  return terms.slice(0, 8);
}

async function notifyResumeMatchedUsers(sinceIso, { dryRun = false } = {}) {
  if (!(await require('./notifSwitch').isOn('resume_match_jobs'))) return dryRun ? [] : 0;
  const ir = require('./instantResearch');
  const handoffs = await ir.pendingHandoffs().catch(() => new Map());
  const users = await dbConfig.query(
    `SELECT u.id, u.city, u.expo_push_token, rm.technical_skills, rm.skills, rm.job_titles,
            LOWER(rm.raw_text) AS resume_lower
       FROM users u
       JOIN LATERAL (SELECT technical_skills, skills, job_titles, raw_text FROM resume_metadata
                      WHERE user_id = u.id AND parse_status = 'done' ORDER BY id DESC LIMIT 1) rm ON true
      WHERE u.deleted_at IS NULL AND u.expo_push_token IS NOT NULL AND u.expo_push_token <> ''
        AND u.email NOT LIKE 'ats%@example.com'`).catch(() => []);
  let sent = 0;
  const preview = [];
  for (const u of users || []) {
    if (TEST_USER_IDS.has(Number(u.id))) continue;
    try {
      // HARD country requirement: no detected country → no push. Wrong-country job alerts
      // destroy trust faster than silence does.
      const country = countryFromResume(u.resume_lower);
      if (!country) continue;
      const terms = resumeTerms(u);
      if (!terms.length) continue;
      const likeAny = terms.map((_, i) => `(LOWER(title) LIKE $${i + 3} OR LOWER(skills::text) LIKE $${i + 3})`).join(' OR ');
      const since = ir.sinceForUser(sinceIso, handoffs.get(Number(u.id)));
      const rows = await dbConfig.query(
        `SELECT job_url, title, location, skills FROM global_jobs
          WHERE is_active AND country = $1 AND first_seen >= $2 AND (${likeAny}) LIMIT 200`,
        [country, since, ...terms.map((t) => `%${t.stem}%`)]).catch(() => []);
      // 1 stray match is noise, not news
      if (!rows || rows.length < 2) continue;
      // the term that matched the most jobs → honest, specific copy
      const byTerm = {};
      for (const r of rows) {
        const hay = (String(r.title) + ' ' + JSON.stringify(r.skills || [])).toLowerCase();
        for (const t of terms) if (hay.includes(t.stem)) byTerm[t.label] = (byTerm[t.label] || 0) + 1;
      }
      const topTerm = (Object.entries(byTerm).sort((a, b) => b[1] - a[1])[0] || [null])[0];
      const n = Math.min(rows.length, 99);
      const what = topTerm ? `${topTerm} job${n === 1 ? '' : 's'}` : `job${n === 1 ? '' : 's'} for you`;
      const title = `${n}${rows.length > 99 ? '+' : ''} new ${what} in ${country} 🎯`;
      const body = 'Fresh openings matched to your résumé just landed — take a look.';
      if (dryRun) { preview.push({ userId: u.id, country, title, matches: rows.length }); continue; }
      // prefs + shared daily dedupe
      const ok = await notifPrefs.isEnabled(u.id, 'digest').catch(() => true);
      if (!ok) continue;
      const dup = await dbConfig.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND type IN ('demand_jobs','resume_match_jobs') AND created_at > NOW() - INTERVAL '20 hours' LIMIT 1`, [u.id]);
      if (dup && dup.length) continue;
      // Same rule as the interest push: one clearly-best job earns a direct deep-link, a real set
      // opens the feed. `score` = how many of THIS user's résumé terms the job answers.
      const ordered = ir.orderByProximity(rows, { city: u.city, country });
      const standout = ir.pickStandoutJob(ordered.map((j) => ({ ...j, score: ir.overlapScore(j, terms) })));
      const params = ir.pushParamsForMatch(standout);
      const pushed = await sendPushNotification(u.expo_push_token, title, body, { route: '/(discover)', params, action: 'resume_match_jobs' });
      await dbConfig.query(
        `INSERT INTO notifications (user_id, type, title, message, created_at) VALUES ($1,'resume_match_jobs',$2,$3,NOW())`,
        [u.id, title, body]).catch(() => {});
      await require('./nudgeGate').record(u.id, 'resume_match_jobs', { pushOk: pushed === true });
      // Same rule as above: a failed send must not consume the hand-back window.
      if (pushed === true) await ir.markHandoffDone(u.id).catch(() => {});
      sent++;
    } catch (e) { console.warn('[demandResearch] resume push failed for', u.id, e.message); }
  }
  return dryRun ? preview : sent;
}

// ── system_schedule bookkeeping — the admin "routines" view reads this table, and the persisted
//    last-run timestamp stops frequent deploys from re-running the research every boot. ─────────
const JOB_KEY = 'demand_research';
async function recordRun(summary) {
  try {
    await dbConfig.query(
      `INSERT INTO system_schedule (job_key, last_run_at, last_summary) VALUES ($1, NOW(), $2)
       ON CONFLICT (job_key) DO UPDATE SET last_run_at = NOW(), last_summary = EXCLUDED.last_summary`,
      [JOB_KEY, String(summary).slice(0, 480)]);
  } catch (e) { console.warn('[demandResearch] recordRun:', e.message); }
}
async function lastRunAt() {
  try {
    const r = await dbConfig.query('SELECT last_run_at FROM system_schedule WHERE job_key = $1', [JOB_KEY]);
    return r && r[0] ? new Date(r[0].last_run_at) : null;
  } catch { return null; }
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────
let _running = false;
async function runDemandResearch() {
  if (_running) { console.log('[demandResearch] already running — skipped'); return { skipped: true }; }
  _running = true;
  const startedAt = new Date().toISOString();
  try {
    const clusters = await loadClusters();
    if (!clusters.length) {
      console.log('[demandResearch] no user interests yet — nothing to research');
      await recordRun('ran — no user interests saved yet, nothing to research');
      return { clusters: 0 };
    }
    const model = geminiGrounded();
    if (!model) {
      console.warn('[demandResearch] no GEMINI_API_KEY — skipped');
      await recordRun('SKIPPED — no GEMINI_API_KEY');
      return { error: 'no_key' };
    }
    console.log(`[demandResearch] ${clusters.length} demand clusters`);
    let jobsAdded = 0;
    for (const cluster of clusters) {
      const urls = await discoverUrls(model, cluster);
      for (const url of urls) jobsAdded += await ingestUrl(url, cluster);
      console.log(`[demandResearch] ${cluster.skills[0]} @ ${cluster.city || cluster.country}: ${urls.length} urls`);
    }
    const pushed = await notifyMatchedUsers(startedAt);
    const resumePushed = await notifyResumeMatchedUsers(startedAt).catch(() => 0);
    console.log(`[demandResearch] done — ${jobsAdded} jobs added, ${pushed}+${resumePushed} users notified`);
    await recordRun(`ran — ${clusters.length} clusters, ${jobsAdded} jobs added, ${pushed} interest + ${resumePushed} résumé pushes`);
    return { clusters: clusters.length, jobsAdded, pushed, resumePushed };
  } catch (e) {
    console.error('[demandResearch] run failed:', e.message);
    await recordRun(`FAILED — ${String(e.message).slice(0, 200)}`);
    return { error: e.message };
  } finally { _running = false; }
}

function startDemandResearch() {
  if (!ENABLED) { console.log('[demandResearch] disabled via env'); return; }
  const tick = async () => {
    // persisted gate: only run when the LAST recorded run is older than the interval, so restarts
    // and frequent deploys never double-research (same pattern as the firehose).
    const last = await lastRunAt();
    if (last && Date.now() - last.getTime() < INTERVAL_H * 3600 * 1000 * 0.9) return;
    await runDemandResearch().catch(() => {});
  };
  // register in the routines table immediately so the schedule is VISIBLE before the first run
  (async () => {
    if (!(await lastRunAt())) await recordRun(`scheduled every ${INTERVAL_H}h — waiting for the first run`);
  })().catch(() => {});
  setTimeout(() => { tick(); }, 10 * 60 * 1000);
  setInterval(() => { tick(); }, 30 * 60 * 1000);   // check twice hourly; the gate enforces the real cadence
  console.log(`[demandResearch] scheduled every ${INTERVAL_H}h (persisted gate)`);
}

// ingestUrl is reused by interestRoutes to fetch the exact posting a user pins on an interest;
// the notify* pair is reused by the admin notify-matches endpoint (the Claude-side routine).
// geminiGrounded + discoverUrls + GENERIC_TERMS are exported for services/instantResearch.js, which
// runs the SAME discovery and the SAME ingestion on demand for one user — reusing them rather than
// forking a second prompt is what stops the instant path and the 12-hourly path drifting apart.
module.exports = {
  runDemandResearch, startDemandResearch, ingestUrl,
  notifyMatchedUsers, notifyResumeMatchedUsers, countryFromResume,
  geminiGrounded, discoverUrls, GENERIC_TERMS,
};
