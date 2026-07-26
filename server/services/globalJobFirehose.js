// Global job firehose — ADDITIVE, ISOLATED. Populates the `global_jobs` table (Migration 023) from
// PUBLIC company ATS boards (Greenhouse/Lever/Ashby/…) using the existing deterministic
// atsDiscovery.detectAndFetchAts(). No AI, no browser, no API keys, no ToS-bypass — each apply link
// goes to the employer's own board. Runs on a schedule; a later phase surfaces these as a browse feed.
// Everything here is best-effort and NEVER touches the per-user `jobs` table.
'use strict';
const ats = require('../utils/atsDiscovery');
const dbConfig = require('../../db-config');
const { classifyTitle } = require('../utils/jobTaxonomy');
const { resolveCountry } = require('../utils/jobLocation');

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
  // A source that publishes its OWN field taxonomy (see SE_FIELD_MAP) knows better than an
  // English-title regex does; `field_hint` lets it say so.
  if (j.field_hint) tax.field = j.field_hint;
  return [clip(j.job_url, 1990), clip(j.title, 490), clip(j.employer_name, 290), domainOf(j.job_url),
    clip(j.location, 490), workModeOf(j.location), clip(j.job_type, 110), clip(j.salary, 250),
    clip(j.experience, 250), JSON.stringify(Array.isArray(j.responsibilities) ? j.responsibilities : []),
    // country comes from the JOB's location, not the board's label — a London-HQ company still posts
    // roles in Singapore, and several board labels are prose notes rather than country names.
    JSON.stringify(Array.isArray(j.skills) ? j.skills : []), clip(source, 55), clip(resolveCountry(j.location, region), 78),
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

  // National feeds ride along with every pass. Only the last few days are swept — the backfill is a
  // one-off — so this stays cheap. Isolated in a try/catch: a national feed being down must never
  // cost us the board results we already have.
  let nationalSaved = 0;
  if (String(process.env.FIREHOSE_NATIONAL_FEEDS || '1') !== '0') {
    try {
      const se = await ingestJobTechSE({ lookbackDays: parseInt(process.env.JOBTECH_SE_LOOKBACK_DAYS || '4', 10) });
      nationalSaved += se.saved || 0;
    } catch (e) { console.warn('[firehose] jobtech-se failed:', e.message); }
  }

  const summary = { sources: list.length, boardsOk, jobsSaved, nationalSaved, seconds: Math.round((Date.now() - t0) / 1000) };
  console.log(`[firehose] DONE: ${boardsOk}/${list.length} boards, ${jobsSaved} jobs + ${nationalSaved} from national feeds, ${summary.seconds}s`);
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

// ── Swiss Job-Room (official SECO / public-employment-service search API) ────────
// Keyless national search behind the job-room.ch site. One source unlocks the whole Swiss market
// (agencies + direct employers, incl. the .NET/enterprise roles Greenhouse/Lever/Ashby never had).
// Greenlist: public, keyless, official government feed. Paginates the search and upserts via saveJobs.
const JOBROOM_URL = 'https://www.job-room.ch/jobadservice/api/jobAdvertisements/_search';
function jrToJob(item) {
  const ad = (item && item.jobAdvertisement) || item || {};
  const jc = ad.jobContent || {};
  const desc = (Array.isArray(jc.jobDescriptions) && (jc.jobDescriptions.find((d) => d && d.title) || jc.jobDescriptions[0])) || {};
  const title = String(desc.title || '').replace(/<\/?em>/gi, '').trim();
  const company = (jc.company && jc.company.name) || '';
  const lo = jc.location || {};
  const location = [lo.city, lo.cantonCode, lo.countryIsoCode === 'CH' ? 'Switzerland' : lo.countryIsoCode].filter(Boolean).join(', ');
  const job_url = jc.externalUrl || (ad.id ? `https://www.job-room.ch/jobseeker/${ad.id}` : '');
  const emp = jc.employment || {};
  const wl = (emp.workloadPercentageMin && emp.workloadPercentageMax) ? `${emp.workloadPercentageMin}-${emp.workloadPercentageMax}%` : '';
  const jt = emp.permanent === false ? 'Temporary' : (emp.permanent ? 'Permanent' : '');
  const responsibilities = desc.description ? [String(desc.description).replace(/<\/?em>/gi, '').replace(/\s+/g, ' ').trim().slice(0, 700)] : [];
  return { job_url, title, employer_name: company, location, job_type: [jt, wl].filter(Boolean).join(' · '), responsibilities, skills: [] };
}
// Sweep the Swiss feed (onlineSince days) into global_jobs. keywords=[] pulls all professions.
async function ingestJobRoom({ keywords = [], maxPages = 25, size = 100, onlineSince = 30 } = {}) {
  const body = { permanent: null, workloadPercentageMin: 0, workloadPercentageMax: 100, companyName: null, onlineSince, displayRestricted: false, professionCodes: [], keywords: keywords || [], communalCodes: [], cantonCodes: [] };
  let saved = 0, pages = 0; const collected = [];
  for (let page = 0; page < maxPages; page++) {
    let arr = null;
    try {
      const r = await fetch(`${JOBROOM_URL}?page=${page}&size=${size}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) break;
      arr = await r.json();
    } catch (e) { console.warn('[jobroom] page', page, 'error:', e.message); break; }
    if (!Array.isArray(arr) || !arr.length) break;
    const jobs = arr.map(jrToJob).filter((j) => j.job_url && j.title);
    collected.push(...jobs);
    saved += await saveJobs(jobs, 'jobroom', 'Switzerland');
    pages++;
    if (arr.length < size) break;   // last page
  }
  console.log(`[jobroom] swept ${pages} pages → ${saved} Swiss jobs saved (keywords: ${(keywords || []).join(',') || 'all'})`);
  return { source: 'jobroom', pages, saved, jobs: collected };
}

// ── German Bundesagentur für Arbeit — Jobsuche (keyless national feed) ───────────
// Static well-known public client id header; national DE coverage incl. .NET/enterprise/Mittelstand
// that Greenhouse/Lever/Ashby miss. Greenlist: keyless public feed (throttled + attributed).
const DE_URL = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs';
function deToJob(s) {
  const ao = s.arbeitsort || {};
  const location = [ao.ort, ao.region, 'Germany'].filter(Boolean).join(', ');
  const title = String(s.titel || s.beruf || '').trim();
  const url = s.externeUrl || (s.refnr ? `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(s.refnr)}` : '');
  return { job_url: url, title, employer_name: String(s.arbeitgeber || '').trim(), location, job_type: '', responsibilities: [], skills: [] };
}
async function ingestArbeitsagentur({ keywords = [], location = '', maxPages = 3, size = 100 } = {}) {
  const was = (keywords || []).join(' ').trim();
  const isCountry = /^(germany|deutschland|de)$/i.test(String(location).trim());
  const wo = isCountry ? '' : String(location || '').trim();
  let saved = 0, pages = 0; const collected = [];
  for (let page = 1; page <= maxPages; page++) {
    let arr = null;
    try {
      const qs = new URLSearchParams({ size: String(size), page: String(page) });
      if (was) qs.set('was', was);
      if (wo) qs.set('wo', wo);
      const r = await fetch(`${DE_URL}?${qs.toString()}`, { headers: { 'X-API-Key': 'jobboerse-jobsuche', 'Accept': 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) break;
      const j = await r.json();
      arr = j.stellenangebote || [];
    } catch (e) { console.warn('[arbeitsagentur] page', page, 'error:', e.message); break; }
    if (!Array.isArray(arr) || !arr.length) break;
    const jobs = arr.map(deToJob).filter((x) => x.job_url && x.title);
    collected.push(...jobs);
    saved += await saveJobs(jobs, 'arbeitsagentur', 'Germany');
    pages++;
    if (arr.length < size) break;
  }
  console.log(`[arbeitsagentur] ${pages} pages → ${saved} DE jobs (was:${was || 'all'} wo:${wo || 'all'})`);
  return { source: 'arbeitsagentur', pages, saved, jobs: collected };
}

// ── Sweden: JobTech / Arbetsförmedlingen JobSearch (official open API, no key) ───
// The Swedish Public Employment Service publishes every ad in Platsbanken as open data. Same greenlist
// reasoning as job-room and arbeitsagentur: public, keyless, official, and each ad keeps its own apply
// URL. One source covers the whole Swedish market — ~40k live ads, including the non-tech roles that
// company ATS boards never carry.
//
// ⚠️ The API refuses offset >= ~2000 (400), so ONE query can only ever reach the first 2,000 ads —
// and there are ~40k live. Sweeping therefore has to be PARTITIONED, by publication-date window:
// `published-after` + `published-before` bound a slice, and a slice too big for the cap is split in
// half until it fits. Region looked like the natural axis but is not: Stockholm alone holds 9,828 ads,
// far past the cap. (Region also takes a taxonomy concept_id, not the county name — passing the label
// returns 0 hits, silently.)
const SE_URL = 'https://jobsearch.api.jobtechdev.se/search';
const SE_OFFSET_CAP = 1900;                 // last offset the API still answers
const SE_MIN_WINDOW_MS = 60 * 60 * 1000;    // stop splitting at 1 hour
// ⚠️ classifyTitle() is English regex, so every Swedish title ("Förskollärare", "Lageroperatör")
// lands in "Other" — which would bury ~26k ads in one useless bucket and break the field filter for
// them. The feed ships its own official 21-field occupation taxonomy, so use that instead of guessing:
// exact, deterministic, and free.
const SE_FIELD_MAP = {
  'Data/IT': 'IT & Software',
  'Försäljning, inköp, marknadsföring': 'Sales & Business Development',
  'Hälso- och sjukvård': 'Healthcare & Clinical',
  'Pedagogik': 'Education & Training',
  'Administration, ekonomi, juridik': 'Administrative & Office',
  'Transport, distribution, lager': 'Supply Chain & Logistics',
  'Industriell tillverkning': 'Manufacturing & Production',
  'Bygg och anläggning': 'Skilled Trades & Field Service',
  'Installation, drift, underhåll': 'Skilled Trades & Field Service',
  'Hantverk': 'Skilled Trades & Field Service',
  'Yrken med teknisk inriktning': 'Mechanical / Electrical / Civil Engineering',
  'Naturvetenskap': 'Science & Research',
  'Kultur, media, design': 'Design & UX',
  'Chefer och verksamhetsledare': 'Operations & Strategy',
  'Yrken med social inriktning': 'Healthcare & Clinical',
  // No good home in our field list — left to fall through to "Other" deliberately:
  // Militära yrken, Kropps- och skönhetsvård, Naturbruk, Säkerhet och bevakning,
  // Hotell/restaurang/storhushåll, Sanering och renhållning.
};

function seToJob(h) {
  const a = h.workplace_address || {};
  const location = [a.municipality || a.city, a.region, 'Sweden'].filter(Boolean).join(', ');
  // Prefer the employer's own application URL; fall back to the Platsbanken ad.
  const apply = (h.application_details && h.application_details.url) || h.webpage_url || '';
  const scope = h.scope_of_work || {};
  const part = (scope.min != null && scope.max != null && scope.max < 100) ? `${scope.min}-${scope.max}%` : '';
  const desc = (h.description && (h.description.text || h.description.text_formatted)) || '';
  return {
    job_url: apply,
    title: String(h.headline || '').trim(),
    employer_name: String((h.employer && (h.employer.name || h.employer.workplace)) || '').trim(),
    location,
    job_type: [(h.employment_type && h.employment_type.label) || '', part].filter(Boolean).join(' · '),
    salary: (h.salary_description || (h.salary_type && h.salary_type.label)) || null,
    responsibilities: desc ? [String(desc).replace(/\s+/g, ' ').trim().slice(0, 900)] : [],
    skills: [],
    field_hint: SE_FIELD_MAP[(h.occupation_field && h.occupation_field.label) || ''] || null,
  };
}
const seStamp = (d) => new Date(d).toISOString().slice(0, 19);
// Retried: over a long sweep a single transient network blip is near-certain, and without a retry it
// would abandon the rest of that window — losing a whole day of ads to one dropped packet.
async function seSearch(from, to, { limit = 100, offset = 0, tries = 3 } = {}) {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  qs.set('published-after', seStamp(from));
  qs.set('published-before', seStamp(to));
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 800 * attempt));
    try {
      const r = await fetch(`${SE_URL}?${qs.toString()}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) { last = new Error('HTTP ' + r.status); if (r.status >= 400 && r.status < 500) break; continue; }
      const j = await r.json();
      return { total: (j.total && j.total.value) || 0, hits: Array.isArray(j.hits) ? j.hits : [] };
    } catch (e) { last = e; }
  }
  throw last || new Error('se-search failed');
}

// One window: page through it, splitting in half first if it cannot fit under the offset cap.
async function seSweepWindow(from, to, state) {
  let head;
  try { head = await seSearch(from, to, { limit: 1 }); state.calls++; }
  catch (e) { console.warn('[jobtech-se] window probe failed:', e.message); return; }
  if (!head.total) return;

  if (head.total > SE_OFFSET_CAP) {
    if (to - from > SE_MIN_WINDOW_MS) {
      const mid = new Date(from.getTime() + Math.floor((to - from) / 2));
      await seSweepWindow(from, mid, state);
      await seSweepWindow(mid, to, state);
      return;
    }
    // Cannot split further — say so rather than quietly dropping the remainder.
    state.truncated += head.total - SE_OFFSET_CAP;
    console.warn(`[jobtech-se] ${seStamp(from)}..${seStamp(to)} has ${head.total} ads in one hour; only ${SE_OFFSET_CAP} reachable`);
  }

  for (let offset = 0; offset <= SE_OFFSET_CAP; offset += 100) {
    let page;
    try { page = await seSearch(from, to, { limit: 100, offset }); state.calls++; }
    catch (e) { console.warn('[jobtech-se] page error:', e.message); break; }
    if (!page.hits.length) break;
    const jobs = page.hits.map(seToJob).filter((j) => j.job_url && j.title);
    state.collected.push(...jobs);
    state.saved += await saveJobs(jobs, 'jobtech-se', 'Sweden');
    if (page.hits.length < 100) break;
  }
}

// `lookbackDays` is how far back to sweep. A routine pass wants a small number (only what is new since
// last time); a first-time backfill wants ~120, because an ad stays live until its deadline.
async function ingestJobTechSE({ lookbackDays = 3, windowHours = 24 } = {}) {
  const state = { saved: 0, calls: 0, truncated: 0, collected: [] };
  const now = Date.now();
  const start = now - lookbackDays * 86400000;
  const step = windowHours * 3600 * 1000;
  const t0 = Date.now();
  for (let w = now; w > start; w -= step) {
    await seSweepWindow(new Date(Math.max(start, w - step)), new Date(w), state);
  }
  console.log(`[jobtech-se] ${state.calls} calls over ${lookbackDays}d → ${state.saved} SE jobs saved in ${Math.round((Date.now() - t0) / 1000)}s${state.truncated ? ` (⚠ ${state.truncated} unreachable)` : ''}`);
  return { source: 'jobtech-se', calls: state.calls, saved: state.saved, truncated: state.truncated, jobs: state.collected };
}

// ── France Travail (Pôle Emploi) — free OAuth key (FRANCE_TRAVAIL_ID/SECRET) ─────
// Dormant until the (free) client id/secret are set in env; then unlocks the whole FR market.
let _ftToken = null, _ftExp = 0;
async function ftToken() {
  const id = process.env.FRANCE_TRAVAIL_ID, secret = process.env.FRANCE_TRAVAIL_SECRET;
  if (!id || !secret) return null;
  if (_ftToken && Date.now() < _ftExp) return _ftToken;
  try {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: 'api_offresdemploiv2 o2dsoffre' });
    const r = await fetch('https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    _ftToken = j.access_token; _ftExp = Date.now() + ((j.expires_in || 1000) - 60) * 1000;
    return _ftToken;
  } catch { return null; }
}
function frToJob(o) {
  const url = (o.origineOffre && o.origineOffre.urlOrigine) || (o.id ? `https://candidat.francetravail.fr/offres/recherche/detail/${o.id}` : '');
  return { job_url: url, title: String(o.intitule || '').trim(), employer_name: (o.entreprise && o.entreprise.nom) || '', location: [(o.lieuTravail && o.lieuTravail.libelle) || '', 'France'].filter(Boolean).join(', '), job_type: o.typeContrat || '', responsibilities: o.description ? [String(o.description).replace(/\s+/g, ' ').trim().slice(0, 700)] : [], skills: [] };
}
async function ingestFranceTravail({ keywords = [], maxRange = 149 } = {}) {
  const tok = await ftToken();
  if (!tok) return { source: 'francetravail', skipped: 'no FRANCE_TRAVAIL_ID/SECRET set', saved: 0 };
  const motsCles = (keywords || []).join(' ').trim();
  let saved = 0; let collected = [];
  try {
    const qs = new URLSearchParams({ range: `0-${maxRange}` });
    if (motsCles) qs.set('motsCles', motsCles);
    const r = await fetch(`https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search?${qs.toString()}`, { headers: { Authorization: 'Bearer ' + tok, 'Accept': 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (r.ok || r.status === 206) {
      const j = await r.json();
      const jobs = (j.resultats || []).map(frToJob).filter((x) => x.job_url && x.title);
      collected = jobs;
      saved = await saveJobs(jobs, 'francetravail', 'France');
    }
  } catch (e) { console.warn('[francetravail] error:', e.message); }
  console.log(`[francetravail] → ${saved} FR jobs (motsCles:${motsCles || 'all'})`);
  return { source: 'francetravail', saved, jobs: collected };
}

module.exports = { runFirehose, startGlobalJobFirehose, ingestOne, saveJobs, SOURCES, ingestJobRoom, ingestArbeitsagentur, ingestFranceTravail, ingestJobTechSE };
