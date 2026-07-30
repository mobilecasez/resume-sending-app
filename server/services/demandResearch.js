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
const TEST_USER_IDS = new Set([1, 4, 5, 6, 7, 8, 9, 11, 14, 24, 26, 41, 43]);

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
async function ingestUrl(url, cluster) {
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
    return await saveJobs([job], 'demand_research', cluster.country);
  } catch (e) {
    return 0;
  }
}

// ── match push: fresh jobs that fit an interest → one notification per user per day ───────────
async function notifyMatchedUsers(sinceIso) {
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
    const likeAny = skills.map((_, i) => `(LOWER(skills::text) LIKE $${i + 3} OR LOWER(title) LIKE $${i + 3})`).join(' OR ');
    const params = [r.country, sinceIso, ...skills.map((s) => `%${s.toLowerCase()}%`)];
    const rows = await dbConfig.query(
      `SELECT COUNT(*)::int AS n FROM global_jobs
        WHERE is_active AND country = $1 AND first_seen >= $2 AND (${likeAny})`, params).catch(() => null);
    const n = rows && rows[0] ? rows[0].n : 0;
    if (n > 0) {
      const cur = perUser.get(r.user_id) || { n: 0, token: r.expo_push_token, place: r.city || r.country, skill: skills[0] };
      cur.n += n;
      perUser.set(r.user_id, cur);
    }
  }

  let sent = 0;
  for (const [userId, m] of perUser) {
    try {
      // prefs: these are marketing-ish job alerts → the 'digest' category governs them
      const ok = await notifPrefs.isEnabled(userId, 'digest').catch(() => true);
      if (!ok) continue;
      // daily dedupe via notifications log
      const dup = await dbConfig.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'demand_jobs' AND created_at > NOW() - INTERVAL '20 hours' LIMIT 1`, [userId]);
      if (dup && dup.length) continue;
      const title = 'New matching jobs for you 🎯';
      const body = `${m.n} new ${m.skill} ${m.n === 1 ? 'job' : 'jobs'} near ${m.place} just landed — take a look.`;
      await sendPushNotification(m.token, title, body, { route: '/(discover)', params: { sort: 'recent' }, action: 'demand_jobs' });
      await dbConfig.query(
        `INSERT INTO notifications (user_id, type, title, message, created_at) VALUES ($1,'demand_jobs',$2,$3,NOW())`,
        [userId, title, body]).catch(() => {});
      sent++;
    } catch (e) { console.warn('[demandResearch] push failed for', userId, e.message); }
  }
  return sent;
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────
let _running = false;
async function runDemandResearch() {
  if (_running) { console.log('[demandResearch] already running — skipped'); return { skipped: true }; }
  _running = true;
  const startedAt = new Date().toISOString();
  try {
    const clusters = await loadClusters();
    if (!clusters.length) { console.log('[demandResearch] no user interests yet — nothing to research'); return { clusters: 0 }; }
    const model = geminiGrounded();
    if (!model) { console.warn('[demandResearch] no GEMINI_API_KEY — skipped'); return { error: 'no_key' }; }
    console.log(`[demandResearch] ${clusters.length} demand clusters`);
    let jobsAdded = 0;
    for (const cluster of clusters) {
      const urls = await discoverUrls(model, cluster);
      for (const url of urls) jobsAdded += await ingestUrl(url, cluster);
      console.log(`[demandResearch] ${cluster.skills[0]} @ ${cluster.city || cluster.country}: ${urls.length} urls`);
    }
    const pushed = await notifyMatchedUsers(startedAt);
    console.log(`[demandResearch] done — ${jobsAdded} jobs added, ${pushed} users notified`);
    return { clusters: clusters.length, jobsAdded, pushed };
  } catch (e) {
    console.error('[demandResearch] run failed:', e.message);
    return { error: e.message };
  } finally { _running = false; }
}

function startDemandResearch() {
  if (!ENABLED) { console.log('[demandResearch] disabled via env'); return; }
  // first run 10 min after boot (let migrations + caches settle), then every INTERVAL_H hours
  setTimeout(() => { runDemandResearch().catch(() => {}); }, 10 * 60 * 1000);
  setInterval(() => { runDemandResearch().catch(() => {}); }, INTERVAL_H * 3600 * 1000);
  console.log(`[demandResearch] scheduled every ${INTERVAL_H}h`);
}

module.exports = { runDemandResearch, startDemandResearch };
