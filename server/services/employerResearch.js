// Web research about an employer, cached per domain, for grounding the employer-tailored resume and
// cover letter (what the company does, its stack, its tone, its brand colour).
//
// WHY THIS EXISTS: "rewrite my resume for Amazon" is only better than a generic rewrite if the model
// knows what Amazon cares about. ai-employer-researcher.js already does that with one grounded
// Gemini call, but it is ~10-25 s and real money, and the answer is about the COMPANY, not the user:
// the same research serves every user who tailors for that domain. So it is cached globally by
// domain in employer_research_cache (Migration 046) for 30 days.
//
// ⚠️ RESEARCH IS OPTIONAL GROUNDING, NEVER A DEPENDENCY. getEmployerResearch NEVER throws and
// answers null on every failure (no website, DB down, table missing, AI error, timeout). The doc
// lane has already passed the billing gate when it calls this; a research failure that failed the
// build would be a paid build lost to a nice-to-have. Null = "write it from the resume alone".
//
// ⚠️ THE RESEARCH IS UNTRUSTED TEXT. It is a model's summary of arbitrary web pages. It is
// sanitised before it is cached or returned (key_contacts dropped — personal names of real people
// have no place in a resume prompt or a shared cache; every list and string capped; whitespace
// collapsed; "===" runs removed so a scraped string cannot fake a prompt section header), and
// researchPromptBlock labels it "may be incomplete or wrong" with hard rules that nothing in it may
// enter the candidate's resume as a claim.
//
// ⚠️ THE CACHE HOLDS ONLY WHAT THE RESEARCHER SAID. Nothing a requester typed (their company name)
// is ever written to employer_research_cache — the cache is shared by every user of that domain.
// The requester's name is applied per request, on a copy (withDisplayName).
//
// ⚠️ DO NOT MODIFY ai-employer-researcher.js FROM HERE. The cover letter lane shares it and its
// output shape is also written by that lane into its own tables.
'use strict';

const RESEARCH_REV = 'r1';

const TTL_DAYS = 30;
const FAIL_MEMORY_MS = 60 * 60 * 1000; // a failed domain is not retried for 1 hour (no retry storm)
const STR_MAX = 400;

// ── domainKeyOf ───────────────────────────────────────────────────────────────
/**
 * 'https://www.Amazon.jobs:443/en/' → 'amazon.jobs'. null when the input is not a host or URL
 * (empty, an email address, a bare word like "localhost", an IP address, spaces).
 */
function domainKeyOf(website) {
  if (typeof website !== 'string') return null;
  let s = website.trim();
  if (!s || s.length > 2048 || /\s/.test(s)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (!hasScheme && s.includes('@')) return null; // an email, not a website
  if (!hasScheme) s = 'https://' + s.replace(/^\/+/, '');
  let host;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    host = u.hostname;
  } catch {
    return null;
  }
  host = String(host || '').toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
  if (!host || host.length > 253 || !host.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null; // URL() punycodes IDNs, so this admits them too
  if (/^\d+(\.\d+){3}$/.test(host)) return null; // IPv4 — nothing to research
  const tld = host.split('.').pop();
  if (!/^(xn--[a-z0-9-]+|[a-z]{2,63})$/.test(tld)) return null;
  if (host.split('.').some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return null;
  return host;
}

// ── Sanitising ────────────────────────────────────────────────────────────────
function cleanStr(v, max = STR_MAX) {
  if (v == null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/={3,}/g, '—')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** Names from [{name}] / [{client_name}] / ['x'], de-duplicated case-insensitively, capped. */
function namesOf(list, keys, maxItems, maxLen = STR_MAX) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    let v = '';
    if (typeof item === 'string') v = item;
    else if (item && typeof item === 'object') { for (const k of keys) { if (typeof item[k] === 'string' && item[k].trim()) { v = item[k]; break; } } }
    const s = cleanStr(v, maxLen);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * ⚠️ THE RESEARCHER INVENTS DEFAULTS. ai-employer-researcher.js writes brand_color '#262633' and
 * font_name 'Lato' when it could not find the real ones. Cached as facts, '#262633' would pull every
 * unknown employer's resume towards the charcoal colour variants and make the letter lane think a
 * brand colour is known. Those exact fallback values mean "unknown" and are stored as null.
 */
const RESEARCHER_DEFAULT_COLOR = '#262633';
const RESEARCHER_DEFAULT_FONT = 'lato';

/**
 * Any researcher output (fresh camel/snake-case object or a cached row) → Research | null.
 * null when it carries no usable fact at all (so an empty answer is remembered as a failure, not
 * cached for 30 days as "we know nothing about Amazon").
 *
 * ⚠️ fallbackName IS NEVER PASSED ON A PATH THAT WRITES THE SHARED CACHE. The cache is keyed by
 * domain and read by EVERY user; a requester's typed company name ("my old boss's shop", a typo,
 * anything) stored as employerName would be served into other users' prompts as the "Official name"
 * for 30 days. The cache stores only a name the researcher itself returned; the requester's name is
 * laid over a per-request COPY in getEmployerResearch (withDisplayName) and never written back.
 */
function sanitiseResearch(raw, domain, fallbackName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pick = (...keys) => { for (const k of keys) if (raw[k] != null && raw[k] !== '') return raw[k]; return null; };

  const colorRaw = cleanStr(pick('brandColor', 'brand_color'), 7).toLowerCase();
  const brandColor = /^#[0-9a-f]{6}$/i.test(colorRaw) && colorRaw !== RESEARCHER_DEFAULT_COLOR ? colorRaw : null;
  const fontRaw = cleanStr(pick('fontName', 'font_name'), 80);
  const fontName = fontRaw && fontRaw.toLowerCase() !== RESEARCHER_DEFAULT_FONT ? fontRaw : null;

  const research = {
    domain: cleanStr(domain || raw.domain, 253).toLowerCase(),
    employerName: cleanStr(pick('employerName', 'employer_name')) || cleanStr(fallbackName),
    industry: cleanStr(pick('industry')),
    companySize: cleanStr(pick('companySize', 'company_size')),
    mission: cleanStr(pick('mission')),
    technologies: namesOf(pick('technologies'), ['name', 'technology', 'title'], 20),
    clients: namesOf(pick('clients'), ['client_name', 'name', 'client'], 10),
    recentActivity: namesOf(pick('recentActivity', 'recent_activity'), ['description', 'title', 'activity'], 5, 200),
    brandColor,
    fontName,
    fetchedAt: (() => {
      const t = pick('fetchedAt', 'fetched_at');
      const d = t ? new Date(t) : null;
      return d && Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
    })(),
  };
  // key_contacts is deliberately never copied (see header).

  const hasFact = research.industry || research.mission || research.companySize || research.technologies.length
    || research.clients.length || research.recentActivity.length || research.brandColor
    || cleanStr(pick('employerName', 'employer_name'));
  return hasFact ? research : null;
}

// ── DB (lazy, degrade-to-miss) ────────────────────────────────────────────────
/**
 * ⚠️ db-config.js calls process.exit(1) AT REQUIRE TIME when DATABASE_URL is missing — no try/catch
 * can stop that. The pure helpers here (domainKeyOf, researchPromptBlock) are used from unit tests
 * and scripts with no database, so the DB module is required lazily, and only when a database is
 * configured or a test has already stubbed db-config into require.cache.
 */
function db() {
  try {
    const p = require.resolve('../../db-config');
    if (!require.cache[p] && !/^postgres/i.test(process.env.DATABASE_URL || '')) return null;
    return require('../../db-config');
  } catch {
    return null;
  }
}

let lastDbWarnAt = 0;
function warnDb(where, err) {
  const now = Date.now();
  if (now - lastDbWarnAt < 60 * 1000) return; // a missing table would otherwise log on every build
  lastDbWarnAt = now;
  console.warn(`[employerResearch] ${where} failed — treating as a cache miss: ${err && err.message}`);
}

async function readCache(domain) {
  const d = db();
  if (!d) return null;
  try {
    const row = await d.get(
      `SELECT research, fetched_at FROM employer_research_cache
        WHERE domain = ? AND fetched_at > NOW() - INTERVAL '${TTL_DAYS} days'`,
      [domain],
    );
    if (!row) return null;
    let r = row.research;
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return null; } }
    // No fallback name: a cached row's employerName is whatever the researcher returned, or ''.
    return sanitiseResearch({ ...(r || {}), fetchedAt: row.fetched_at }, domain);
  } catch (err) {
    warnDb('cache read', err);
    return null;
  }
}

async function writeCache(domain, research) {
  const d = db();
  if (!d) return;
  try {
    await d.query(
      `INSERT INTO employer_research_cache (domain, research, fetched_at) VALUES (?, ?::jsonb, NOW())
       ON CONFLICT (domain) DO UPDATE SET research = EXCLUDED.research, fetched_at = NOW()`,
      [domain, JSON.stringify(research)],
    );
  } catch (err) {
    warnDb('cache write', err);
  }
}

// ── getEmployerResearch ───────────────────────────────────────────────────────
const inflight = new Map(); // domain → Promise<Research|null>   (single-flight per process)
const failedAt = new Map(); // domain → ms of the last failure

function recentlyFailed(domain) {
  const t = failedAt.get(domain);
  if (!t) return false;
  if (Date.now() - t < FAIL_MEMORY_MS) return true;
  failedAt.delete(domain);
  return false;
}

function rememberFailure(domain) {
  failedAt.set(domain, Date.now());
  if (failedAt.size > 5000) { // bounded: drop the oldest entries
    const cut = [...failedAt.entries()].sort((a, b) => a[1] - b[1]).slice(0, failedAt.size - 4000);
    for (const [k] of cut) failedAt.delete(k);
  }
}

/**
 * The whole lookup-or-research for one domain, shared by every concurrent caller. Checks the cache
 * INSIDE the flight so two builds for the same new employer make one AI call, not two.
 *
 * ⚠️ NO REQUESTER INPUT ENTERS THE FLIGHT. Its result is written to the shared cache AND handed to
 * every concurrent caller (possibly different users), so it takes only the domain. It used to take the
 * first caller's company name as the employerName fallback, which put that user's typed name into the
 * cache and into the other callers' results.
 */
function flightFor(domain) {
  const existing = inflight.get(domain);
  if (existing) return existing;
  const p = (async () => {
    const cached = await readCache(domain);
    if (cached) return cached;
    if (recentlyFailed(domain)) return null;
    let raw = null;
    try {
      raw = await require('../../ai-employer-researcher').researchEmployer('https://' + domain);
    } catch (err) {
      console.warn(`[employerResearch] researcher threw for ${domain}: ${err && err.message}`);
      raw = null;
    }
    const research = sanitiseResearch(raw, domain); // no fallback name — this object is cached for everyone
    if (!research) { rememberFailure(domain); return null; }
    await writeCache(domain, research);
    return research;
  })()
    .catch((err) => {
      console.warn(`[employerResearch] research failed for ${domain}: ${err && err.message}`);
      rememberFailure(domain);
      return null;
    })
    .finally(() => { inflight.delete(domain); });
  inflight.set(domain, p);
  return p;
}

/**
 * The requester's company name as the employerName of THIS caller's copy, when the researcher found
 * none. A new object every time: the flight's result is shared by concurrent callers and is the very
 * object written to the cache, so it is never mutated. The name the caller gets back is exactly what
 * it passed in (as before this fix), so its prompt block and its own stored doc read the same.
 */
function withDisplayName(research, displayName) {
  if (!research || typeof research !== 'object') return research || null;
  if (research.employerName || !displayName) return { ...research };
  return { ...research, employerName: displayName };
}

/**
 * Research for an employer's website, or null. NEVER throws.
 *
 * `name` is the requester's company name. It is a DISPLAY fallback for this caller only (see
 * withDisplayName) and never reaches the shared employer_research_cache.
 *
 * ⚠️ ON TIMEOUT WE STOP WAITING, NOT WORKING. The caller gets null after timeoutMs and writes the
 * document without research, but the pending researcher call keeps running and still populates
 * the cache — so the NEXT build for that employer (any user) gets it instantly. Aborting it would
 * waste the money already spent on the call.
 */
async function getEmployerResearch({ website, name } = {}, { timeoutMs = 25000 } = {}) {
  try {
    const domain = domainKeyOf(website);
    if (!domain) return null;
    const displayName = cleanStr(name, 200);
    // The flight reads the cache before consulting the failure memory, so a remembered failure
    // never hides a good cached row — it only stops a second AI call within the hour.
    const flight = flightFor(domain);
    const ms = Number(timeoutMs);
    if (!Number.isFinite(ms) || ms <= 0) return withDisplayName(await flight, displayName);
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    try {
      return withDisplayName(await Promise.race([flight, timeout]), displayName);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    console.warn(`[employerResearch] getEmployerResearch swallowed: ${err && err.message}`);
    return null;
  }
}

// ── researchPromptBlock ───────────────────────────────────────────────────────
/**
 * The research as a prompt section, '' when there is nothing to say. The rules travel WITH the
 * facts so no caller can include the research without the guard rails.
 */
function researchPromptBlock(research, company, { forLetter = false } = {}) {
  if (!research || typeof research !== 'object') return '';
  const r = sanitiseResearch(research, research.domain, research.employerName);
  if (!r) return '';
  const who = cleanStr(company, 120) || r.employerName || 'THIS EMPLOYER';

  const facts = [];
  if (r.employerName && r.employerName.toLowerCase() !== who.toLowerCase()) facts.push(`Official name: ${r.employerName}`);
  if (r.industry) facts.push(`Industry: ${r.industry}`);
  if (r.companySize) facts.push(`Size: ${r.companySize}`);
  if (r.mission) facts.push(`Mission / tagline: ${r.mission}`);
  if (r.technologies.length) facts.push(`Technologies and products they use or build: ${r.technologies.join(', ')}`);
  if (r.clients.length) facts.push(`Named clients: ${r.clients.join(', ')}`);
  if (r.recentActivity.length) facts.push(`Recent activity:\n${r.recentActivity.map((a) => `- ${a}`).join('\n')}`);
  if (r.brandColor) facts.push(`Brand colour: ${r.brandColor}`);
  // A block that would only say the name and website teaches the model nothing — skip it.
  if (!facts.length) return '';
  if (r.domain) facts.unshift(`Website: ${r.domain}`);

  const rules = [
    `- Use this ONLY to decide emphasis, ordering, wording and design: which of the candidate's real experience, skills and projects matter most to ${who}, and which vocabulary ${who} uses.`,
    '- NEVER add a skill, tool, technology, employer, job title, date, degree, certification, client or number that the candidate\'s own material does not already contain. A technology listed above that the candidate never used stays out.',
  ];
  if (forLetter) {
    rules.push(`- You may reference clearly public facts from this block (industry, mission, products) to explain why the candidate fits ${who}, but NEVER invent anything beyond it — no made-up initiatives, figures, people, values or news.`);
    rules.push('- If a fact above looks doubtful or unrelated to this employer, leave it out.');
  } else {
    rules.push(`- This is a RESUME: never state facts about ${who} anywhere in it (no company name, mission, clients, products or news) — the resume is about the candidate only.`);
  }

  return [
    `=== WHAT WE KNOW ABOUT ${who} (web research — may be incomplete or wrong) ===`,
    ...facts,
    'HOW TO USE THIS RESEARCH:',
    ...rules,
    '=== END OF EMPLOYER RESEARCH ===',
  ].join('\n');
}

module.exports = {
  RESEARCH_REV,
  domainKeyOf,
  getEmployerResearch,
  researchPromptBlock,
  // exposed for tests / diagnostics only
  sanitiseResearch,
  _reset() { inflight.clear(); failedAt.clear(); lastDbWarnAt = 0; },
};
