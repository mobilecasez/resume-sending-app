// ─────────────────────────────────────────────────────────────────────────────
// NEW: Optimized job-extraction pipeline (trim → ONE LLM call → strict English JSON).
// Self-contained; does NOT touch the existing ATS / sitemap discovery (which already
// work and stay the cheap first choice). This handles the "custom site" case reliably
// and cheaply, replacing the slow/flaky multi-layer agent.
//
//   Stage 1: find the real jobs page (static-first), aggressively trim its HTML.
//   Stage 2: one lightweight-model call → strict JSON (English, N/A fallbacks).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { smartScrape } = require('../utils/playwrightScraper');
const { detectAndFetchAts, parseJobApiResponse } = require('../utils/atsDiscovery');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const JOB_WORDS = ['job', 'career', 'vacan', 'stelle', 'karriere', 'bewerb', 'position', 'opening', 'hiring', 'recruit', 'wir suchen', 'we are looking', 'we’re looking', 'open role', 'work with us', 'offene stelle', 'apply', 'developer', 'engineer', 'consultant', 'manager', 'mitarbeiter', 'm/w/d', 'vollzeit', 'teilzeit'];
const jobHits = (t) => { const s = (t || '').toLowerCase(); let n = 0; for (const w of JOB_WORDS) if (s.includes(w)) n++; return n; };

function rootDomain(host) {
  const c = String(host || '').replace(/^www\./i, '').toLowerCase().split('.');
  if (c.length <= 2) return c.join('.');
  const two = new Set(['co.uk', 'com.au', 'co.in', 'co.jp', 'com.br', 'co.nz', 'com.sg']);
  return two.has(c.slice(-2).join('.')) ? c.slice(-3).join('.') : c.slice(-2).join('.');
}

// Short-TTL cache so the SAME careers URLs aren't statically re-fetched within (and across
// near-simultaneous) searches — detectAtsOnCareers, fetchCareersPageData and findAndExtract
// all probe the same handful of candidates. (M23)
const _staticCache = new Map();   // url -> { t, html }
const _STATIC_TTL_MS = 60000;
async function fetchStatic(url) {
  const hit = _staticCache.get(url);
  if (hit && (Date.now() - hit.t) < _STATIC_TTL_MS) return hit.html;
  let html = '';
  try {
    const r = await axios.get(url, { timeout: 12000, maxContentLength: 4 * 1024 * 1024, headers: { 'User-Agent': UA, 'Accept-Language': 'en;q=0.9' }, maxRedirects: 5, validateStatus: (s) => s >= 200 && s < 400 });
    html = typeof r.data === 'string' ? r.data : '';
  } catch { html = ''; }
  if (_staticCache.size > 200) _staticCache.clear();   // crude bound — entries are short-lived per search
  _staticCache.set(url, { t: Date.now(), html });
  return html;
}

// ── Stage 1: aggressive HTML → lean text (80-90% token cut) ───────────────────
function cleanHtmlForLLM(html) {
  if (!html) return '';
  let $;
  try { $ = cheerio.load(html); } catch { return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40000); }
  $('script, style, noscript, svg, iframe, link, meta, picture, canvas, nav, header, footer, form').remove();
  $('[aria-hidden="true"], [hidden], [style*="display:none"], [style*="display: none"]').remove();
  // preserve mailto/tel/linkedin AND job/apply links as inline "text [href]" so the LLM can
  // return a real "Job URL". Without this, every apply link was stripped to bare text and the
  // extractor returned 0 usable URLs. The href may be relative — toInternalJobs absolutizes it.
  const jobHref = /jobs?|career|karriere|stelle|position|vacan|opening|apply|bewerb|gh_jid|gh_src|lever\.co|greenhouse|ashby|myworkday|smartrecruiters|recruitee|breezy|workable|join\.com|personio|teamtailor/i;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const t = $(el).text().trim();
    if (/^(mailto:|tel:)/i.test(href) || href.includes('linkedin.com/in/')) $(el).replaceWith(`${t} [${href}] `);
    else if (t && href && !/^(#|javascript:)/i.test(href) && jobHref.test(href)) $(el).replaceWith(`${t} [${href}] `);
    else if (t) $(el).replaceWith(`${t} `);
  });
  // strip all layout attributes
  $('*').each((_, el) => { if (el.attribs) for (const a of Object.keys(el.attribs)) delete el.attribs[a]; });
  $('br').replaceWith('\n');
  $('p, li, h1, h2, h3, h4, h5, h6, tr, td, div').each((_, el) => $(el).prepend('\n'));
  const text = ($('body').text() || $.root().text() || '');
  return text.replace(/[ \t ]+/g, ' ').replace(/\n[ \t]*\n+/g, '\n').trim();
}

// ── Stage 2: ONE LLM call → strict English JSON (the unified schema) ───────────
function geminiModel() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    return new GoogleGenerativeAI(key).getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
      generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 16384 },
    });
  } catch { return null; }
}

// Tolerant JSON parse for the LLM output: strip markdown fences, extract the JSON object,
// and — crucially — if the Jobs array was TRUNCATED mid-object (large listing hit the token
// cap), recover every COMPLETE job object instead of throwing and returning ZERO jobs.
function parseJobsJson(raw) {
  let t = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const start = t.indexOf('{'); if (start > 0) t = t.slice(start);
  try { return JSON.parse(t); } catch {}
  try {
    const jobsAt = t.search(/"Jobs"\s*:\s*\[/i); if (jobsAt < 0) return null;
    const arrStart = t.indexOf('[', jobsAt);
    let depth = 0, inStr = false, esc = false, lastComplete = -1;
    for (let k = arrStart + 1; k < t.length; k++) {
      const ch = t[k];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) lastComplete = k; }
    }
    if (lastComplete < 0) return null;
    const em = t.match(/"Employer"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    return JSON.parse(`{"Employer":${JSON.stringify(em ? em[1] : '')},"Jobs":[${t.slice(arrStart + 1, lastComplete + 1)}]}`);
  } catch { return null; }
}

// ONE LLM call over a single (already size-bounded) text slice → parsed {Employer, Jobs}.
async function llmExtractOne(clipped, sourceUrl, employerHint) {
  const model = geminiModel();
  if (!model || !clipped) return null;
  const prompt = `You are a context-optimized, multi-lingual job data extraction engine. Analyze the pre-cleaned page text below and map EVERY real job opening into the strict JSON schema.

EMPLOYER (target): ${employerHint || '(infer from the page)'}
SOURCE URL: ${sourceUrl}

CRITICAL PRINCIPLES:
1. ABSOLUTE ENGLISH: the entire output MUST be English. Translate all foreign-language titles, locations, skills, and responsibilities into professional English (e.g. "Systeembeheerder" → "System Administrator", "Thuiswerken" → Work Mode "Remote", "Vollzeit" → Employment Type "Full-time").
2. ONLY REAL OPENINGS for THIS employer. IGNORE navigation, menus, cookie/consent text, section headings, "read more", and anything that is not an actual job posting. If the text clearly belongs to a DIFFERENT company/industry, return an empty Jobs array.
3. NO FABRICATION. If a field is missing, use the fallback — never invent: missing strings/links → "N/A"; missing email → "Contact via portal".
4. DEDUPLICATE: if the SAME role appears more than once (cloned cards, repeated sections, a carousel), include it ONLY ONCE.
5. Keep skills & responsibilities as short bullet strings (not paragraphs). Keep "Contacts" as [] UNLESS a specific recruiter name/email/phone is shown for that job (saves space — most jobs have none).
6. TWO SEPARATE fields — do not confuse them:
   • "Employment Type" = the working-time contract: one of Full-time, Part-time, Contract, Internship, Temporary, N/A (Vollzeit→Full-time, Teilzeit→Part-time, Praktikum→Internship). Default to "Full-time" only if clearly a permanent role; else "N/A".
   • "Work Mode" = the work LOCATION arrangement: one of Remote, Hybrid, Office, N/A (Thuiswerken/Remote→Remote, vor Ort→Office). Use "N/A" if not stated — never guess.

OUTPUT: return ONLY valid JSON, starting with '{' and ending with '}', no markdown:
{
  "Employer": "Exact Company Name",
  "Jobs": [
    {
      "Job Title": "English title",
      "Location": "City, Region or Country",
      "Employment Type": "one of: Full-time, Part-time, Contract, Internship, Temporary, N/A",
      "Work Mode": "one of: Remote, Hybrid, Office, N/A",
      "Salary": "salary text or N/A",
      "Skills": ["Skill 1", "Skill 2"],
      "Responsibilities": ["Task 1", "Task 2"],
      "Job URL": "explicit job link if present else N/A",
      "Contacts": []
    }
  ]
}

PAGE TEXT:
"""${clipped}"""`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await model.generateContent(prompt);
      return parseJobsJson(res.response.text());   // tolerant: recovers partial output on truncation, null on real failure
    } catch (e) {
      // Retry ONLY on transient API errors — a deterministic parse problem won't change.
      const transient = /\b429\b|rate|quota|overload|unavailable|\b50[03]\b|timeout|deadline|fetch failed|ECONNRESET|ETIMEDOUT/i.test(String(e && e.message));
      if (i < 2 && transient) { await new Promise((r) => setTimeout(r, 900 * Math.pow(2, i))); continue; }
      return null;
    }
  }
  return null;
}

// Public entry: extract from cleaned text. Small pages → one call. LARGE boards (a long
// careers listing) exceed both the 30k input clip AND the model's output token cap, which
// would silently drop every job past the cut — so chunk the text, extract each slice, and
// merge. Overlap duplicates collapse later in toInternalJobs' url-aware dedup. (M6/M7)
async function llmExtract(cleanedText, sourceUrl, employerHint) {
  if (!cleanedText) return null;
  const CLIP = 30000;
  if (cleanedText.length <= CLIP) return llmExtractOne(cleanedText, sourceUrl, employerHint);

  const CHUNK = 28000, OVERLAP = 800, MAX_CHUNKS = 4;
  const chunks = [];
  for (let i = 0; i < cleanedText.length && chunks.length < MAX_CHUNKS; i += (CHUNK - OVERLAP)) {
    let end = Math.min(i + CHUNK, cleanedText.length);
    if (end < cleanedText.length) { const nl = cleanedText.lastIndexOf('\n', end); if (nl > i + CHUNK * 0.6) end = nl; }   // cut on a newline so a job isn't split
    chunks.push(cleanedText.slice(i, end));
    if (end >= cleanedText.length) break;
  }
  if (cleanedText.length > MAX_CHUNKS * CHUNK) console.warn(`[aiJobExtractor] listing ${cleanedText.length} chars > ${MAX_CHUNKS}×${CHUNK} cap — extracting first ${MAX_CHUNKS} chunks only`);

  let employer = '';
  const merged = [];
  for (const c of chunks) {
    const d = await llmExtractOne(c, sourceUrl, employerHint);
    if (!d) continue;
    if (!employer && d.Employer) employer = d.Employer;
    if (Array.isArray(d.Jobs)) merged.push(...d.Jobs);
  }
  if (!merged.length) return null;
  return { Employer: employer, Jobs: merged };
}

// Map the unified schema → our internal job shape (used by processJobSearch).
const naClean = (v) => { const s = String(v == null ? '' : v).trim(); return (!s || /^n\/?a$/i.test(s)) ? '' : s; };
const arrClean = (a) => (Array.isArray(a) ? a.map((x) => naClean(x)).filter(Boolean) : []);
const _sig = (t, l) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '') + '|' + String(l || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function toInternalJobs(data, sourceUrl, origin) {
  if (!data || !Array.isArray(data.Jobs)) return { employer: naClean(data && data.Employer), jobs: [] };
  // Resolve each role's URL first so dedup can use it as a discriminator.
  const resolved = data.Jobs.filter((j) => j && naClean(j['Job Title'])).map((j) => {
    let url = naClean(j['Job URL']);
    if (url && !/^https?:/i.test(url)) { try { url = new URL(url, origin || sourceUrl).href; } catch { url = ''; } }
    return { j, url };
  });
  // Dedup CLONES (a card/carousel rendered twice): same title+location AND the same — or a
  // missing — URL. Genuinely distinct same-title roles that carry distinct real URLs survive
  // (big employers post many "Software Engineer" roles). (M8 / M12)
  const seenSig = new Set();
  const jobs = resolved
    .filter(({ j, url }) => { const s = _sig(naClean(j['Job Title']), naClean(j.Location)) + '|' + (url ? url.split('#')[0] : ''); if (seenSig.has(s)) return false; seenSig.add(s); return true; })
    .map(({ j, url }, i) => {
    const contacts = (Array.isArray(j.Contacts) ? j.Contacts : []).map((c) => ({
      name: naClean(c && c.Name), role: naClean(c && c.Role), phone: naClean(c && c.Phone),
      linkedin: naClean(c && c.LinkedIn), image_url: naClean(c && c.ImageUrl),
      email: (() => { const e = String((c && c.Email) || '').trim(); return (!e || /^(n\/?a|contact via portal)$/i.test(e)) ? null : e; })(),
    })).filter((c) => c.name || c.email);
    // Employment type (Full-time/…) and work mode (Remote/Hybrid/Office) are now distinct.
    // Back-compat: an older "Type of Job" value held the work mode, so fall back to it.
    const workMode = naClean(j['Work Mode']) || naClean(j['Type of Job']) || null;
    const empType = naClean(j['Employment Type']) || 'Full-time';
    const skills = arrClean(j.Skills).slice(0, 15);
    const responsibilities = arrClean(j.Responsibilities).slice(0, 12);
    // Most career LISTINGS only show a title + location per role; the salary, skills and
    // responsibilities live on each job's DETAIL page. Mark a job for Phase-2 detail
    // enrichment (visit its job_url) UNLESS it already came back detail-complete OR has no
    // real detail page to visit. Detail-complete / synthetic-URL jobs pass straight through.
    const detailComplete = responsibilities.length >= 2 || skills.length >= 4;
    const realUrl = !!url;
    const passThrough = detailComplete || !realUrl;
    return {
      title: naClean(j['Job Title']),
      location: naClean(j.Location) || 'Not specified',
      job_type: empType,
      work_mode: workMode,
      salary: naClean(j.Salary) || null,
      experience: null,
      skills,
      responsibilities,
      job_url: url || `${sourceUrl}#role-${i + 1}`,
      contacts,
      employer_name: naClean(data.Employer) || null,
      // true → Phase 2 passes it through (already complete / no detail page); false → Phase 2
      // visits the detail page to fill salary/skills/responsibilities/contacts.
      _atsApi: passThrough,
    };
  });
  return { employer: naClean(data.Employer), jobs };
}

// ── Find the real jobs page (static-first), then extract ──────────────────────
function careersCandidates(inputUrl) {
  let origin, root;
  try { const u = new URL(inputUrl); origin = u.origin; root = rootDomain(u.hostname); } catch { return [inputUrl]; }
  // High-value paths + careers SUBDOMAINS first, so the consumer's slice(0,18) never drops
  // the subdomains (M2). Long-tail paths after.
  const high = ['/careers', '/jobs', '/career', '/career/jobs', '/careers/jobs', '/karriere', '/open-positions'];
  const subs = [`https://careers.${root}`, `https://jobs.${root}`, `https://career.${root}`];
  const rest = ['/karriere/jobs', '/en/careers', '/en/jobs', '/stellenangebote', '/stellen', '/join-us', '/work-with-us', '/about/careers', '/company/careers', '/vacancies'];
  return [inputUrl, ...high.map((p) => origin + p), ...subs, ...rest.map((p) => origin + p)].filter((v, i, a) => a.indexOf(v) === i);
}

// Marketing / content paths that match a job keyword by accident but are NOT job listings
// (e.g. Typeform's /templates-sub-category/job-application, a blog post about careers).
const NON_LISTING_PATH = /\/(templates?|template-|sub-category|blog|help|support|docs?|guides?|pricing|webinars?|press|newsroom|use-cases?|case-studies?|customers?|resources?|ebooks?|glossary|academy|community|integrations?)\b/i;

// From a page's HTML, pull links that look like a careers/jobs page (to follow).
function careersLinks(html, baseUrl) {
  const out = [];
  for (const m of String(html || '').matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = m[2].replace(/<[^>]+>/g, ' ').trim().toLowerCase();
    let href = m[1];
    if (!/jobs?|career|karriere|stellen|vacan|join|offene|positions?|openings?|jobangebot/i.test(href + ' ' + text)) continue;
    if (NON_LISTING_PATH.test(href)) continue;   // skip marketing/template pages that merely contain a job word
    try { href = new URL(href, baseUrl).href; } catch { continue; }
    out.push(href);
  }
  return [...new Set(out)];
}

// Given job-DETAIL links (…/open-positions/job-detail?jobId=123), derive the parent
// LISTING url (…/open-positions). This is how we reach subdomain SPA listings (celonis).
function deriveListings(links) {
  const out = new Set();
  for (const l of links) {
    try {
      const u = new URL(l); u.search = ''; u.hash = '';
      const path = u.pathname.replace(/\/(job[-_]?detail|job|jobs|stelle\w*|position\w*|vacan\w*|offene-stelle\w*|opening\w*|ad)\/?[\w%-]*\/?$/i, '');
      if (path && path !== u.pathname && path.length > 1) out.add(u.origin + path);
    } catch {}
  }
  return [...out];
}
const strongJobUrl = (u) => /\/(jobs?|careers?|karriere|stellen\w*|vacan\w*|open-positions?|positions?|openings?|offene-stellen|join-us)\b/i.test(u || '');

const detailUrlRe = (u) => /\/(jobs?|stelle\w*|position\w*|vacan\w*|job[-_]?detail)([\/?].*)?[\w%=-]{3,}/i.test(u || '') && /(\?|\/[\w%-]{6,})/.test(u || '');
// A FACET / filtered sub-listing (e.g. /career-types/student, /departments/engineering,
// /locations/berlin) shows only a SLICE of the board. We must not mistake it for the full
// listing — Adyen's /career-types/student exposes 5 of ~hundreds of roles. (M3)
const facetUrlRe = (u) => /\/(career[-_]?types?|categories|category|teams?|departments?|disciplines?|functions?|job[-_]families|locations?|cities|regions?|countries|students?|graduates?|internships?|interns?|early[-_]careers?|experience[-_]levels?|seniority|filter)s?\b/i.test(u || '');
// From a facet URL, derive the likely FULL-board URLs so the broad listing can compete with
// the narrow slice (the careers root + common board paths + the parent path). (Limit 1)
function facetParents(url) {
  try {
    const u = new URL(url);
    const out = [u.origin, u.origin + '/jobs', u.origin + '/careers', u.origin + '/en/jobs'];
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length >= 2) out.push(u.origin + '/' + segs.slice(0, -1).join('/'));
    const bare = url.split('#')[0].replace(/\/$/, '');
    return [...new Set(out)].map((x) => x.replace(/\/$/, '')).filter((x) => x && x !== bare);
  } catch { return []; }
}
const scorePage = (text, url, jobLinkCount) => jobLinkCount * 6 + Math.min(jobHits(text), 8)
  + (/\/(jobs?|careers?|karriere|stellen(angebote)?|vacan\w*|offene-stellen|open-positions?|positions?|openings?)\/?$/i.test(url) ? 4 : 0)
  - (detailUrlRe(url) ? 6 : 0)
  - (facetUrlRe(url) ? 5 : 0);

// Memoize the expensive clean+link parse on the page object. rankPages runs 3-4× per
// findAndExtract over the same HTML; recompute only when p.html actually changes (i.e. after
// a render replaces it). (M5/M24)
function pageParsed(p) {
  if (p._parsedFor !== p.html) { p._parsedFor = p.html; p._clean = cleanHtmlForLLM(p.html); p._links = careersLinks(p.html, p.url); }
  return p;
}
function rankPages(pages) {
  return pages
    .filter((p) => p.html)
    .map((p) => {
      pageParsed(p);
      const jobLinkCount = p._links.filter((l) => l.split('#')[0] !== p.url.split('#')[0]).length;
      return { url: p.url, text: p._clean, jobLinkCount, score: p._clean.length > 400 ? scorePage(p._clean, p.url, jobLinkCount) : 0 };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);
}
// A static page is "good enough" (server-rendered with real listings) → no need to render.
const looksLikeListing = (p) => p && (p.jobLinkCount >= 3 || (jobHits(p.text) >= 4 && p.text.length > 1800));

// Returns { employer, jobs, sourceUrl } or { jobs: [] } if nothing found.
async function findAndExtract(inputUrl, employerHint) {
  const t0 = Date.now();   // self-budget so facet→board exploration never blows the 120s cap (Limit 1)
  let origin = ''; try { origin = new URL(inputUrl).origin; } catch {}
  const seen = new Set();
  const pages = [];
  const add = async (url) => { if (!url || seen.has(url)) return; seen.add(url); pages.push({ url, html: await fetchStatic(url) }); };
  // Ensure a URL is present in `pages` (static-fetch once); returns the page object.
  const ensurePage = async (url) => {
    let pg = pages.find((p) => p.url === url);
    if (!pg) { pg = { url, html: await fetchStatic(url) }; pages.push(pg); seen.add(url); }
    return pg;
  };
  // Build a rankPages-style candidate from a page object (bypasses the score>0 filter so an
  // empty-shell SPA board can still be extracted directly).
  const candFor = (pg) => { pageParsed(pg); return { url: pg.url, text: pg._clean, jobLinkCount: pg._links.filter((l) => l.split('#')[0] !== pg.url.split('#')[0]).length }; };

  // Extract from a candidate (render once if its text is thin) → normalized jobs. Skip the
  // render when the candidate already looksLikeListing — it's server-rendered & good enough,
  // so re-rendering just wastes a browser. (M4)
  const extractFrom = async (cand) => {
    let text = cand.text;
    if ((text.length < 1200 || jobHits(text) < 2) && !looksLikeListing(cand)) {
      try {
        const r = await smartScrape(cand.url, { forceBrowser: true, minChars: 400 });
        // Hard SPA (e.g. Adyen): the full board paints from an intercepted XHR/GraphQL call
        // while the HTML stays an empty shell. If that JSON is a real board, use it directly —
        // free, complete, no LLM. Provenance-guarded inside parseJobApiResponse. (Limit 1)
        if (r.interceptedJson) {
          const api = parseJobApiResponse(r.interceptedJson, cand.url, origin);
          if (api && api.jobs && api.jobs.length >= 10) {
            console.log(`[aiJobExtractor] SPA API: ${api.jobs.length} jobs from intercepted payload @ ${cand.url}`);
            return { employer: api.employer || null, jobs: api.jobs, sourceUrl: cand.url };
          }
        }
        const t = cleanHtmlForLLM(r.rawHtml || ''); if (t.length > text.length) text = t;
      } catch {}
    }
    const data = await llmExtract(text, cand.url, employerHint || origin);
    const out = toInternalJobs(data, cand.url, origin);
    return { ...out, sourceUrl: cand.url };
  };

  // 1) Static-fetch the standard candidates + careers/derived links found on them.
  await Promise.all(careersCandidates(inputUrl).slice(0, 18).map((u) => add(u)));
  const links1 = new Set();
  for (const p of pages) if (p.html) { const ls = pageParsed(p)._links; for (const l of ls) links1.add(l); for (const l of deriveListings(ls)) links1.add(l); }
  await Promise.all([...links1].filter((l) => !seen.has(l)).slice(0, 10).map((u) => add(u)));

  // 1b) ATS check — if a careers candidate runs a known ATS (Ashby/Greenhouse/Lever/… on
  //     a /careers subpage, which the pipeline's root check missed), use its structured API:
  //     fast, free, complete, and provenance-guarded. Beats AI-rendering an ATS SPA.
  for (const p of pages.filter((p) => p.html && strongJobUrl(p.url)).slice(0, 6)) {
    const r = await detectAndFetchAts(p.url, p.html).catch(() => null);
    if (r && r.jobs && r.jobs.length) return { employer: r.companyName, jobs: r.jobs, sourceUrl: p.url };
  }

  // 2) FAST PATH — server-rendered listing already in static HTML (ebcont/lexon/sipgate).
  //    Verify by EXTRACTION; only trust it if it actually yields jobs. Skip short-circuiting
  //    on a FACET URL (a filtered slice) — fall through so the SPA path can render & compare
  //    the full board against it. (M3)
  const fast = rankPages(pages).find(looksLikeListing);
  if (fast && !facetUrlRe(fast.url)) { const r = await extractFrom(fast); if (r.jobs.length) return r; }

  // 3) SPA PATH — render the job-ish candidates, re-derive subdomain listing URLs (celonis),
  //    render those, re-rank, and try the top few until one yields jobs.
  for (const p of pages.filter((p) => p.html && strongJobUrl(p.url) && pageParsed(p)._clean.length < 1500).slice(0, 3)) {
    try { const r = await smartScrape(p.url, { forceBrowser: true, minChars: 400 }); if ((r.rawHtml || '').length) p.html = r.rawHtml; } catch {}
  }
  const links2 = new Set();
  for (const p of pages) if (p.html) { const ls = pageParsed(p)._links; for (const l of ls) links2.add(l); for (const l of deriveListings(ls)) links2.add(l); }
  const discovered = [...links2].filter((l) => !seen.has(l) && strongJobUrl(l)).sort((a, b) => (detailUrlRe(a) ? 1 : 0) - (detailUrlRe(b) ? 1 : 0));
  for (const u of discovered.slice(0, 6)) {
    if (seen.has(u)) continue; seen.add(u);
    let html = await fetchStatic(u);
    if (cleanHtmlForLLM(html).length < 1500) { try { const r = await smartScrape(u, { forceBrowser: true, minChars: 400 }); if ((r.rawHtml || '').length) html = r.rawHtml; } catch {} }
    pages.push({ url: u, html });
  }
  // Extract from the best candidates and keep the one with the MOST jobs. A single
  // employer often exposes several sub-listings (a narrow "students" facet alongside the
  // full board); returning the first-with-jobs can land on the narrow one, so compare the
  // top few and keep the broadest. Bounded to cap LLM cost. (M3)
  let best = { jobs: [] };
  let fruitful = 0;
  for (const cand of rankPages(pages).slice(0, 3)) {
    const r = await extractFrom(cand);
    if (r.jobs.length > best.jobs.length) best = r;
    if (r.jobs.length && ++fruitful >= 2) break;
  }
  // If the winner is only a FACET (a filtered slice) AND we have comfortable time budget, try
  // ONE full-board candidate to BEAT it — but never starve the facet result we already hold.
  // The facet's jobs are the floor; a parent only replaces them if it yields MORE. Gated tight
  // (≤45s elapsed) and to a single parent: a heavy SPA board render is ~40s and CANNOT be
  // interrupted mid-flight, so 45+40 ≈ 85s keeps us safely under the 120s extractor cap. A
  // board whose job API is intercepted resolves far faster (no LLM), so this mainly helps the
  // SPAs we CAN win while never risking a timeout on the ones we can't (e.g. Adyen). (Limit 1)
  if (best.jobs.length && best.sourceUrl && facetUrlRe(best.sourceUrl) && (Date.now() - t0) < 45000) {
    const pu = facetParents(best.sourceUrl)[0];
    if (pu) {
      const pg = await ensurePage(pu);
      if (pg.html) {
        const r = await extractFrom(candFor(pg));
        if (r.jobs.length > best.jobs.length) { console.log(`[aiJobExtractor] board ${pu} beat facet: ${r.jobs.length} > ${best.jobs.length}`); best = r; }
      }
    }
  }
  if (best.jobs.length) return best;
  return { jobs: [] };
}

// Quick, cheap check: does this employer run a known ATS on a /careers subpage? (The
// pipeline's root check misses Ashby/Greenhouse that live on /careers, e.g. Notion.)
// Static-fetch a few careers candidates, and only run the (networked) ATS adapter on
// pages that actually carry an ATS fingerprint — so it's fast and never hangs. The
// provenance guard inside detectAndFetchAts ensures a wrong-employer board is rejected.
const _ATS_FP = /greenhouse|grnh\.se|lever\.co|ashby|_ashby_org|recruitee|myworkdayjobs|smartrecruiters|breezy\.hr|workable|teamtailor|personio|jobvite|icims|bamboohr/i;
async function detectAtsOnCareers(inputUrl) {
  let origin = '', root = ''; try { const u = new URL(inputUrl); origin = u.origin; root = rootDomain(u.hostname); } catch { return null; }
  const cands = [inputUrl, origin + '/careers', origin + '/jobs', origin + '/career', origin + '/career/jobs',
    `https://careers.${root}`, `https://jobs.${root}`].filter((v, i, a) => a.indexOf(v) === i);
  const fetched = await Promise.all(cands.map(async (u) => ({ url: u, html: await fetchStatic(u) })));
  for (const f of fetched) {
    if (!f.html || !_ATS_FP.test(f.html)) continue;          // only probe pages with an ATS fingerprint
    const r = await detectAndFetchAts(f.url, f.html).catch(() => null);
    if (r && r.jobs && r.jobs.length) return { employer: r.companyName, jobs: r.jobs, sourceUrl: f.url, ats: r.ats };
  }
  return null;
}

module.exports = { findAndExtract, detectAtsOnCareers, cleanHtmlForLLM, llmExtract, toInternalJobs };
