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
  // NB: include "vacatur" — the Dutch/Belgian word is "vacature(s)", which does NOT contain
  // "vacan", so /en/vacature/<slug> links were being stripped and the LLM fabricated title-slug
  // URLs (collapsing distinct same-title roles on dedup, and 404ing Phase-2). Plus FR/ES/IT.
  const jobHref = /jobs?|career|karriere|stelle|position|vacan|vacatur|offre|emploi|empleo|emprego|lavor|opening|apply|bewerb|listing|joboffer|job-offer|praca|oferta|ofertas|ilan|is-ilanlari|puesto|trabajo|anuncio|gh_jid|gh_src|lever\.co|greenhouse|ashby|myworkday|smartrecruiters|recruitee|breezy|workable|join\.com|personio|teamtailor/i;
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
    // The Extraction_Audit object is emitted FIRST (before the Jobs array), so even when the
    // Jobs array truncates mid-object it is fully formed — recover it so the backend still gets
    // the self-audit signal (Requires_Deep_Recrawl / Diagnostic_Notes).
    let auditJson = 'null';
    const auditAt = t.search(/"Extraction_Audit"\s*:\s*\{/i);
    if (auditAt >= 0) {
      const ob = t.indexOf('{', t.indexOf(':', auditAt));
      let d = 0, end = -1;
      for (let k = ob; k < arrStart && k < t.length; k++) { const c = t[k]; if (c === '{') d++; else if (c === '}') { d--; if (d === 0) { end = k; break; } } }
      if (end > ob) auditJson = t.slice(ob, end + 1);
    }
    return JSON.parse(`{"Extraction_Audit":${auditJson},"Employer":${JSON.stringify(em ? em[1] : '')},"Jobs":[${t.slice(arrStart + 1, lastComplete + 1)}]}`);
  } catch { return null; }
}

// Normalize the model's self-audit block into a stable shape the backend can branch on.
// Defensive: a missing/garbled audit must never crash the pipeline — default to "no recrawl".
function normalizeAudit(raw, jobCount) {
  const a = (raw && typeof raw === 'object') ? raw : {};
  const density = String(a.Data_Density_Score || '').trim();
  const notes = String(a.Diagnostic_Notes || '').trim();
  return {
    totalFound: Number.isFinite(+a.Total_Jobs_Found) ? +a.Total_Jobs_Found : jobCount,
    density: /^(high|medium|low)/i.test(density) ? density : (jobCount ? 'Medium' : 'Low_or_Missing_Details'),
    requiresDeepRecrawl: a.Requires_Deep_Recrawl === true || a.Requires_Deep_Recrawl === 'true',
    notes: notes || (jobCount ? 'Passed' : 'No jobs parsed from text'),
  };
}
// Merge per-chunk audits for a chunked large board: recrawl if ANY chunk flags it, keep the
// LOWEST density, and concatenate distinct notes.
function mergeAudits(audits, jobCount) {
  const list = audits.filter(Boolean);
  if (!list.length) return normalizeAudit(null, jobCount);
  const rank = { high: 3, medium: 2, low: 1 };
  let lowest = list[0];
  for (const x of list) if ((rank[String(x.density).toLowerCase().slice(0, 6).replace(/_.*/, '')] || 2) < (rank[String(lowest.density).toLowerCase().slice(0, 6).replace(/_.*/, '')] || 2)) lowest = x;
  const notes = [...new Set(list.map((x) => x.notes).filter((n) => n && n !== 'Passed'))].slice(0, 3).join(' | ') || 'Passed';
  return { totalFound: jobCount, density: lowest.density, requiresDeepRecrawl: list.some((x) => x.requiresDeepRecrawl), notes };
}

// ONE LLM call over a single (already size-bounded) text slice → parsed {Employer, Jobs}.
async function llmExtractOne(clipped, sourceUrl, employerHint) {
  const model = geminiModel();
  if (!model || !clipped) return null;
  const prompt = `You are a deterministic, zero-dropout, multi-lingual job data extraction and structural-translation engine. Your sole mandate is to exhaustively audit the pre-cleaned page text below, run a mandatory self-verification pass, and transcribe EVERY unique real job vacancy into the strict target JSON schema. Do not truncate, summarize, or stop until the entire text block is parsed.

INPUT CONTEXT
• Target Employer (hint): ${employerHint || '(infer from the text)'}
• Source URL: ${sourceUrl}

MANDATORY PROCESSING PROTOCOLS
1. ABSOLUTE ENGLISH OUTPUT: the entire output MUST be English. Translate every foreign-language title, location, skill, and responsibility into professional English (e.g. "Systeembeheerder" → "System Administrator", "Thuiswerken" → Work Mode "Remote", "Vollzeit" → Employment Type "Full-time", "Praktikum" → Internship).
2. ONLY REAL OPENINGS FOR THIS EMPLOYER: ignore navigation, menus, filters, cookie/consent text, section headings, "read more", and anything that is not an actual job posting. If the text clearly belongs to a DIFFERENT company or industry than the target employer, return an empty Jobs array (and flag it in the audit).
3. NO FABRICATION & DEDUPLICATION: never invent a field. If the SAME role appears more than once (cloned cards, carousels, repeated sections, pagination loops), include it ONLY ONCE.
4. LISTING vs DETAIL DISCRIMINATION: if the text is a high-level LIST page, capture each role's title/location/type and its deep-link URL (skills/responsibilities/salary are often absent here — that is expected, flag it in the audit). If the text is a single DETAIL page, extract all operational metrics (Skills, Responsibilities, Salary) comprehensively.
5. DEEP-LINK URL INTEGRITY: never guess, invent, or truncate a URL. Extract the exact absolute link that maps to that specific vacancy. Links are provided inline as "text [href]". If a link is a relative path (e.g. /careers/apply/102), combine it cleanly with the base domain of the Source URL. If no unique link exists for a role, use "N/A".
6. TOKEN CONSERVATION: keep Skills and Responsibilities as short, impact-driven bullet strings — never wordy paragraphs.
7. LOGICAL FIELD ISOLATION (two independent variables — do not confuse):
   • "Employment Type" ∈ [Full-time, Part-time, Contract, Internship, Temporary, N/A] (Vollzeit→Full-time, Teilzeit→Part-time). Default "Full-time" ONLY if clearly a permanent role; else "N/A".
   • "Work Mode" ∈ [Remote, Hybrid, Office, N/A] (Thuiswerken/Remote→Remote, "vor Ort"→Office). If not stated, "N/A" — never guess.
8. FALLBACKS: missing strings/paths → "N/A"; missing/hidden recruiter email → "Contact via portal"; no contacts → [].

SELF-AUDIT LAYER (run BEFORE emitting Jobs)
Inspect the payload and populate "Extraction_Audit". Set "Requires_Deep_Recrawl": true if ANY of: (a) you found ZERO jobs; (b) the text looks blocked/empty/JS-shell (a Cloudflare/consent challenge, a cookie wall, or an SPA skeleton with no real postings); or (c) you found jobs but they are LISTING-only and lack Skills/Responsibilities/Salary. Set "Data_Density_Score" to "High" (rich detail on every job), "Medium" (some detail), or "Low_or_Missing_Details" (teasers only / blocked). In "Diagnostic_Notes" state concisely WHAT is missing or WHY (e.g. "Listing teasers only — no skills/responsibilities; detail pages must be crawled", "Page appears blocked by a consent/Cloudflare wall", "Only abstract section headers, no job links present"). Use "Passed" only when density is High and no recrawl is needed.

STRICT OUTPUT: return ONLY one valid JSON object — no markdown, no \`\`\`json fences, no prose. Start with '{' and end with '}'.
{
  "Extraction_Audit": {
    "Total_Jobs_Found": 0,
    "Data_Density_Score": "High" | "Medium" | "Low_or_Missing_Details",
    "Requires_Deep_Recrawl": true | false,
    "Diagnostic_Notes": "Passed, or a concise reason"
  },
  "Employer": "Exact Company Name",
  "Jobs": [
    {
      "Job Title": "English title",
      "Location": "City, Region or Country",
      "Employment Type": "Full-time" | "Part-time" | "Contract" | "Internship" | "Temporary" | "N/A",
      "Work Mode": "Remote" | "Hybrid" | "Office" | "N/A",
      "Salary": "salary text or N/A",
      "Skills": ["Skill 1", "Skill 2"],
      "Responsibilities": ["Task 1", "Task 2"],
      "Job URL": "exact absolute job link or N/A",
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
  const audits = [];
  for (const c of chunks) {
    const d = await llmExtractOne(c, sourceUrl, employerHint);
    if (!d) continue;
    if (!employer && d.Employer) employer = d.Employer;
    if (Array.isArray(d.Jobs)) merged.push(...d.Jobs);
    audits.push(normalizeAudit(d.Extraction_Audit, (d.Jobs || []).length));
  }
  if (!merged.length) return null;
  // Pre-merged, already-normalized audit for the chunked board (extractFrom prefers it).
  return { Employer: employer, Jobs: merged, _mergedAudit: mergeAudits(audits, merged.length) };
}

// Map the unified schema → our internal job shape (used by processJobSearch).
const naClean = (v) => { const s = String(v == null ? '' : v).trim(); return (!s || /^n\/?a$/i.test(s)) ? '' : s; };
const arrClean = (a) => (Array.isArray(a) ? a.map((x) => naClean(x)).filter(Boolean) : []);
const _sig = (t, l) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '') + '|' + String(l || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// ── Deterministic per-job URL recovery ────────────────────────────────────────
// The LLM sometimes drops a job's link (the site's href doesn't match the job-word allowlist,
// so cleanHtmlForLLM strips it → the job got a synthetic "#role-N"). We recover the REAL link
// straight from the DOM: index every <a href> by its anchor text, then match each job to the
// anchor whose text ≈ the job title. Language-agnostic (works for cvbankas numeric ids,
// brightermonday /listings/, pracuj /praca/, vietnamworks slugs, computrabajo, …). No LLM.
const _dia = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const _toks = (s) => _dia(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length >= 2);
const _STOP = new Set(['and', 'the', 'for', 'with', 'job', 'jobs', 'career', 'careers', 'full', 'time', 'part', 'de', 'la', 'el', 'en', 'di', 'et', 'un', 'une', 'im', 'zur', 'zum']);
function buildAnchorIndex(rawHtml, base) {
  const idx = [];
  if (!rawHtml) return idx;
  let $; try { $ = cheerio.load(rawHtml); } catch { return idx; }
  let listingKey = ''; try { listingKey = new URL(base).href.split('#')[0].replace(/\/$/, ''); } catch {}
  const seen = new Set();
  $('a[href]').each((_, el) => {
    let href = ($(el).attr('href') || '').trim();
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!href || text.length < 4 || /^(#|javascript:|mailto:|tel:)/i.test(href)) return;
    try { href = new URL(href, base).href; } catch { return; }
    let path = ''; try { path = new URL(href).pathname; } catch { return; }
    if (path === '' || path === '/') return;                                  // homepage / bare root
    if (href.split('#')[0].replace(/\/$/, '') === listingKey) return;          // the listing page itself
    if (seen.has(href + '|' + text)) return; seen.add(href + '|' + text);
    const toks = _toks(text).filter((w) => !_STOP.has(w));
    if (toks.length) idx.push({ href, toks: new Set(toks) });
  });
  return idx;
}
// Best anchor whose text covers ~all of the job-title tokens. High threshold → no mismaps.
function recoverJobUrl(title, index) {
  const tt = _toks(title).filter((w) => !_STOP.has(w));
  if (tt.length < 2 || !index.length) return '';
  let best = '', bestCov = 0;
  for (const a of index) {
    let hit = 0; for (const w of tt) if (a.toks.has(w)) hit++;
    const cov = hit / tt.length;
    if (cov > bestCov) { bestCov = cov; best = a.href; }
  }
  return bestCov >= 0.8 ? best : '';
}

function toInternalJobs(data, sourceUrl, origin, rawHtml) {
  if (!data || !Array.isArray(data.Jobs)) return { employer: naClean(data && data.Employer), jobs: [] };
  // Resolve each role's URL first so dedup can use it as a discriminator. When the LLM returned
  // no link, recover the real one from the DOM by matching the job title to an <a href>.
  const anchorIndex = buildAnchorIndex(rawHtml, origin || sourceUrl);
  const resolved = data.Jobs.filter((j) => j && naClean(j['Job Title'])).map((j) => {
    let url = naClean(j['Job URL']);
    if (url && !/^https?:/i.test(url)) { try { url = new URL(url, origin || sourceUrl).href; } catch { url = ''; } }
    if (!url) url = recoverJobUrl(naClean(j['Job Title']), anchorIndex);   // DOM fallback (no LLM)
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
    // A career LISTING only shows teasers (a title, a location, maybe a couple of bullets); the
    // REAL salary/skills/responsibilities live on each job's own DETAIL page. So ALWAYS send a
    // job through Phase-2 detail enrichment (open its job_url → trim the HTML → AI-extract the
    // full details). Only pass a job straight through when there's NO real detail page to open
    // (a synthetic "#role-N" url). The extracted details are cached, so it's done once per job
    // and every later searcher reads it straight from the DB.
    const realUrl = !!url;
    const passThrough = !realUrl;
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

// ── Tier 2: schema.org JobPosting JSON-LD — FREE structured extraction, ZERO LLM tokens ───────
// Most career sites that want Google-for-Jobs indexing emit <script type="application/ld+json">
// with @type "JobPosting" (on detail pages, and many on the listing too). We map the structured
// fields EXACTLY — salary / employment type / location / url are AUTHORITATIVE here (the employer's
// own data, more reliable than AI-parsing). Skills/responsibilities are left for Phase-2 detail
// enrichment, so the FINAL output is identical-or-better while we skip the listing/pagination LLM.
const _EMP_TYPE = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACTOR: 'Contract', CONTRACT: 'Contract', TEMPORARY: 'Temporary', INTERN: 'Internship', INTERNSHIP: 'Internship', PER_DIEM: 'Contract', VOLUNTEER: 'N/A', OTHER: 'N/A' };
function _mapEmpType(v) {
  if (!v) return 'Full-time';
  for (const x of (Array.isArray(v) ? v : [v])) { const k = String(x).toUpperCase().replace(/[\s-]+/g, '_'); if (_EMP_TYPE[k]) return _EMP_TYPE[k]; }
  return 'Full-time';
}
function _ldSalary(bs) {
  if (!bs || typeof bs !== 'object') return '';
  const cur = bs.currency || (bs.value && bs.value.currency) || '';
  const v = bs.value || {};
  const u = String(v.unitText || '').toLowerCase();
  const per = u ? `/${u === 'year' ? 'yr' : u === 'month' ? 'mo' : u === 'hour' ? 'hr' : u === 'day' ? 'day' : u === 'week' ? 'wk' : u}` : '';
  const sym = ({ EUR: '€', USD: '$', GBP: '£', INR: '₹' })[cur] || (cur ? cur + ' ' : '');
  const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (v.minValue != null && v.maxValue != null) return `${sym}${num(v.minValue)} – ${sym}${num(v.maxValue)}${per}`;
  if (v.value != null) return `${sym}${num(v.value)}${per}`;
  if (v.minValue != null) return `from ${sym}${num(v.minValue)}${per}`;
  return '';
}
function jsonLdJobPostings(html) {
  const out = [];
  const collect = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { for (const n of node) collect(n, depth + 1); return; }
    const t = node['@type']; const types = (Array.isArray(t) ? t : [t]).map((x) => String(x));
    if (types.includes('JobPosting')) out.push(node);
    for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity']) if (node[key]) collect(node[key], depth + 1);
  };
  for (const m of String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let raw = m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { try { parsed = JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')); } catch {} }
    if (parsed) collect(parsed);
  }
  return out;
}
// Returns mapped jobs (internal schema) from a page's JobPosting JSON-LD. Empty if none/invalid.
function extractJsonLdJobs(html, baseUrl) {
  const posts = jsonLdJobPostings(html);
  const asName = (x) => (x && typeof x === 'object') ? (x.name || x['@id'] || '') : x;
  const jobs = [];
  for (const jp of posts) {
    const title = naClean(jp.title || jp.name);
    if (!title || title.length < 2 || /^\d+$/.test(title)) continue;
    let loc = jp.jobLocation; if (Array.isArray(loc)) loc = loc[0];
    const addr = (loc && loc.address) || {};
    const location = [asName(addr.addressLocality), asName(addr.addressRegion), asName(addr.addressCountry)].filter(Boolean).join(', ') || 'Not specified';
    const remote = /TELECOMMUTE/i.test(String(jp.jobLocationType || '')) || jp.applicantLocationRequirements != null && /remote/i.test(JSON.stringify(jp.jobLocationType || ''));
    let url = jp.url || (jp.mainEntityOfPage && (jp.mainEntityOfPage['@id'] || jp.mainEntityOfPage)) || jp.sameAs || '';
    if (Array.isArray(url)) url = url[0];
    try { url = url ? new URL(url, baseUrl).href : ''; } catch { url = ''; }
    jobs.push({
      title,
      location,
      job_type: _mapEmpType(jp.employmentType),
      work_mode: remote ? 'Remote' : null,
      salary: _ldSalary(jp.baseSalary) || null,
      experience: null,
      skills: [],
      responsibilities: [],
      job_url: url || `${baseUrl}#role-${jobs.length + 1}`,
      contacts: [],
      employer_name: naClean(asName(jp.hiringOrganization)) || null,
      // false → Phase-2 visits the detail page and AI-fills skills/responsibilities, so the final
      // record is exactly as rich as the all-AI path (no compromise). JSON-LD just got us here free.
      _atsApi: false,
    });
  }
  const seen = new Set(); const dedup = [];
  for (const j of jobs) { const k = (j.job_url && !/#role-/.test(j.job_url)) ? j.job_url.split('#')[0].replace(/\/$/, '') : _sig(j.title, j.location); if (seen.has(k)) continue; seen.add(k); dedup.push(j); }
  return dedup;
}

// ── Find the real jobs page (static-first), then extract ──────────────────────
function careersCandidates(inputUrl) {
  let origin, root;
  try { const u = new URL(inputUrl); origin = u.origin; root = rootDomain(u.hostname); } catch { return [inputUrl]; }
  // High-value paths + careers SUBDOMAINS first, so the consumer's slice never drops the
  // subdomains (M2). "vacancies"/"vacatures" are as common as "careers"/"jobs" across EU sites
  // (esp. NL/BE), so they belong in the high tier — otherwise a sparse jobs.<root> subdomain can
  // win the candidate race over the real /vacatures board (guidewell: 3 vs ~100). Long-tail after.
  const high = ['/careers', '/jobs', '/career', '/vacancies', '/vacatures', '/open-positions', '/career/jobs', '/careers/jobs', '/en/vacancies', '/karriere'];
  const subs = [`https://careers.${root}`, `https://jobs.${root}`, `https://career.${root}`];
  const rest = ['/karriere/jobs', '/en/careers', '/en/jobs', '/en/vacatures', '/stellenangebote', '/stellen', '/join-us', '/work-with-us', '/about/careers', '/company/careers'];
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
    if (!/jobs?|career|karriere|stellen|vacan|vacatur|offre|emploi|empleo|lavor|join|offene|positions?|openings?|jobangebot/i.test(href + ' ' + text)) continue;
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
// NB: include vacatur (NL/BE "vacature(s)") + FR/ES/IT — these are as common as "vacancies" and
// do NOT contain "vacan", so without them a Dutch board's links are invisible and we land on a
// single detail page (boldcompany: 1 of ~20). Kept consistent with cleanHtmlForLLM's jobHref.
const strongJobUrl = (u) => /\/(jobs?|careers?|karriere|stellen\w*|vacan\w*|vacatur\w*|offre\w*|emploi|empleo\w*|lavor\w*|open-positions?|positions?|openings?|offene-stellen|join-us)\b/i.test(u || '');

const detailUrlRe = (u) => /\/(jobs?|stelle\w*|position\w*|vacan\w*|vacatur\w*|offre\w*|emploi|empleo\w*|job[-_]?detail)([\/?].*)?[\w%=-]{3,}/i.test(u || '') && /(\?|\/[\w%-]{6,})/.test(u || '');
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
// From a job-DETAIL url (…/vacatures/vacature_x.html, …/jobs/123/title), derive its parent
// LISTING url(s) by dropping the trailing detail segment(s). Self-heal hook for when extraction
// lands on a single posting instead of the board (boldcompany: a detail page → the /vacatures board).
function detailParents(url) {
  try {
    const u = new URL(url); u.search = ''; u.hash = '';
    const segs = u.pathname.split('/').filter(Boolean);
    const out = [];
    if (segs.length >= 1) out.push(u.origin + '/' + segs.slice(0, -1).join('/'));
    if (segs.length >= 2) out.push(u.origin + '/' + segs.slice(0, -2).join('/'));
    return [...new Set(out)].map((x) => x.replace(/\/$/, '')).filter((x) => x && x !== u.origin);
  } catch { return []; }
}
// Derive a rough English-ish title from a job-detail URL slug (Phase-2 replaces it with the real
// title from the detail page). "csirt-analyst-8084" → "Csirt Analyst".
function titleFromSlug(url) {
  try {
    const s = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    const t = s.replace(/[-_]\d+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
    return t.length >= 2 ? t : 'Job';
  } catch { return 'Job'; }
}
// Virtualized job widgets render only ~20 cards as visible TEXT but still emit EVERY job's <a href>.
// The AI sees the 20; we recover the rest straight from the hrefs. Harvest direct-child links that
// share the URL pattern of the jobs already extracted (same parent dir; and if the samples end in a
// numeric id like "-8084", require that too) so we never pull in nav/facet links. (cegeka 21→~60)
function harvestDetailLinks(html, sampleUrls) {
  const samples = (sampleUrls || []).filter((u) => u && !/#role-/.test(u));
  if (!samples.length) return [];
  let origin = '', parentPath = '';
  try { const u = new URL(samples[0]); origin = u.origin; parentPath = u.pathname.replace(/\/[^/]*$/, '/'); } catch { return []; }
  if (!parentPath || parentPath.length < 4) return [];
  // ONLY harvest when the job URLs carry a numeric id suffix (…-8084) — an unambiguous job-posting
  // signal (ATS/widget job ids). Without it, scanning the DOM for "/careers/<slug>" would sweep up
  // nav/facet links (about/contact/team) as fake jobs. Precision over coverage: safe for every site.
  const idSuffix = samples.filter((u) => /[-_]\d{2,}\/?$/.test(u)).length >= Math.ceil(samples.length * 0.6);
  if (!idSuffix) return [];
  const esc = parentPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Virtualized widgets keep every job URL in a JS data blob, not as <a href> — so scan the whole
  // rendered HTML for "<parentPath><slug>" occurrences (href, JSON, data-attrs alike).
  const re = new RegExp(esc + '([A-Za-z0-9._-]{3,})', 'g');
  const out = new Set();
  for (const m of String(html || '').matchAll(re)) {
    const tail = m[1].replace(/\/$/, '');
    if (!tail || tail.length < 3) continue;
    if (idSuffix && !/[-_]\d{2,}$/.test(tail)) continue;
    out.add(`${origin}${parentPath}${tail}`);
  }
  return [...out];
}
const scorePage = (text, url, jobLinkCount) => jobLinkCount * 6 + Math.min(jobHits(text), 8)
  + (/\/(jobs?|careers?|karriere|stellen(angebote)?|vacan\w*|vacatur\w*|offre\w*|empleo\w*|offene-stellen|open-positions?|positions?|openings?)\/?$/i.test(url) ? 4 : 0)
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

// Detect URL-BASED pagination on a listing page (WordPress …/page/N/, or ?page=N / ?paged=N /
// ?pg=N) and synthesize the page-2..N URLs. Many boards render each page at its own URL, so a
// single fetch only sees page 1 (guidewell: 11 pages × 10 jobs → we'd return 10 of ~110). We
// read the REAL base from the pagination links themselves (the listing URL may be an alias of
// the paginated path). Button/infinite-scroll pagination is handled separately in the browser
// by smartScrape's load-more loop. (Limit 2 — URL-pagination companion)
// Parse the employer-reported total ("Displaying 1 to 20 of 536 matching jobs", "536 results",
// "1-20 of 536") + the page size, so pagination can crawl to the REAL last page even when the
// page-number links don't expose it (a "Next ›"-only pager would otherwise undershoot to page 2).
function detectTotal(text) {
  const s = String(text || '');
  const m = s.match(/\bof\s+([\d,]{1,7})\s+(?:matching\s+)?(?:jobs|results|positions|openings|roles|vacanc\w*|vacatur\w*|offre\w*|stell\w*|empleos?)\b/i)
        || s.match(/\b1\s*[-–]\s*\d+\s+of\s+([\d,]{1,7})\b/i)
        || s.match(/\b([\d,]{2,7})\s+(?:jobs|results|positions|openings|roles|vacanc\w*|vacatur\w*)\b/i);
  const total = m ? parseInt(m[1].replace(/[,\s]/g, ''), 10) : 0;
  const pm = s.match(/\b1\s*(?:to|[-–])\s*(\d{1,3})\s+of\b/i);
  const pageSize = pm ? parseInt(pm[1], 10) : 0;
  return { total: Number.isFinite(total) ? total : 0, pageSize: Number.isFinite(pageSize) ? pageSize : 0 };
}

function buildPageUrls(listingUrl, html, cap = 25, pageHint = null) {
  const h = String(html || '');
  try { new URL(listingUrl); } catch { return []; }
  // How many pages the reported total implies (extends the visible page-link max so a
  // "Next ›"-only or truncated pager still reaches the real last page).
  const needPages = (pageHint && pageHint.total && pageHint.pageSize) ? Math.ceil(pageHint.total / pageHint.pageSize) : 0;
  // Path style: href="…/<path>/page/N/" — keep the link's own base path. The page number may be
  // followed by a quote, a trailing slash, or a #fragment / ?query (…/page/2/#results).
  const pathHits = [...h.matchAll(/href=["']([^"']*?\/)page\/(\d{1,3})\/?(?=["'#?]|$)/gi)];
  if (pathHits.length) {
    let basePath; try { basePath = new URL(pathHits[0][1], listingUrl).href.replace(/\/$/, ''); } catch { return []; }
    const max = Math.min(Math.max(Math.max(...pathHits.map((m) => +m[2])), needPages), cap + 1);
    const out = []; for (let n = 2; n <= max; n++) out.push(`${basePath}/page/${n}/`);
    return [...new Set(out)].slice(0, cap);
  }
  // Query style: href="…?page=N" (also paged/pg). The number may be followed by a quote, a
  // #fragment (…?page=2#results — the Happydance/Phenom pager), or another &param.
  const qHits = [...h.matchAll(/href=["']([^"']*?[?&](?:page|paged|pg)=)(\d{1,3})(?=["'#&]|$)/gi)];
  if (qHits.length) {
    let prefix; try { prefix = new URL(qHits[0][1].replace(/&amp;/g, '&'), listingUrl).href; } catch { return []; }
    const max = Math.min(Math.max(Math.max(...qHits.map((m) => +m[2])), needPages), cap + 1);
    const out = []; for (let n = 2; n <= max; n++) out.push(`${prefix}${n}`);
    return [...new Set(out)].slice(0, cap);
  }
  return [];
}

// Fetch + extract the detected pagination pages, returning the EXTRA jobs. The page URLs are all
// known upfront (synthesized from the pagination links), so process them in BOUNDED-CONCURRENCY
// batches — sequential crawling of an 11-page board blows the time budget (~21s/page → only ~4
// pages fit; parallel batches do all 11 in ~20s). Stops when a whole batch comes back empty (we
// ran past the real last page) or the wall-clock deadline hits. (Limit 2 — URL pagination)
async function crawlPaginated(listingUrl, firstHtml, employerHint, origin, deadlineAt, pageHint = null) {
  const urls = buildPageUrls(listingUrl, firstHtml, 25, pageHint);
  if (!urls.length) return [];
  // CONC kept modest: too many concurrent flash-lite calls hit the rate limit and whole pages
  // fail. The page URLs are already bounded to the real last page by buildPageUrls, so we do NOT
  // early-stop on an empty batch (a transient 429 would otherwise drop every later page) — we run
  // every detected page, bounded only by the wall-clock deadline.
  const CONC = 4;
  const extra = [];
  for (let i = 0; i < urls.length; i += CONC) {
    if (Date.now() > deadlineAt) break;
    const batch = urls.slice(i, i + CONC);
    const results = await Promise.all(batch.map(async (pu) => {
      try {
        let html = await fetchStatic(pu).catch(() => '');
        // Blocked (Cloudflare 403) or JS-shell page → render it so SPA / protected boards
        // (Phenom/Happydance, Workday-style) still paginate. Bounded by the wall-clock deadline.
        if (cleanHtmlForLLM(html).length < 600) {
          try { const r = await smartScrape(pu, { forceBrowser: true, minChars: 400 }); if (r && r.rawHtml) html = r.rawHtml; } catch {}
        }
        // JSON-LD first — if this page carries JobPosting blocks, it's free (no LLM).
        const ld = extractJsonLdJobs(html, pu);
        if (ld.length >= 3) return ld;
        const text = cleanHtmlForLLM(html);
        if (text.length < 600) return [];
        return toInternalJobs(await llmExtract(text, pu, employerHint || origin), pu, origin, html).jobs || [];
      } catch { return []; }
    }));
    extra.push(...results.flat());
  }
  return extra;
}

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
  const extractFrom = async (cand, opts = {}) => {
    let text = cand.text;
    let rendered = false, renderApi = null, renderedHtml = null;
    // Browser-render the candidate ONCE (idempotent). Captures an intercepted job API if the
    // board paints from XHR/GraphQL, else upgrades `text` with the rendered DOM.
    const renderOnce = async () => {
      if (rendered) return; rendered = true;
      try {
        const r = await smartScrape(cand.url, { forceBrowser: true, minChars: 400 });
        // Hard SPA (e.g. Adyen): the full board paints from an intercepted XHR/GraphQL call
        // while the HTML stays an empty shell. If that JSON is a real board, use it directly —
        // free, complete, no LLM. Provenance-guarded inside parseJobApiResponse. (Limit 1)
        if (r.interceptedJson) {
          const api = parseJobApiResponse(r.interceptedJson, cand.url, origin);
          if (api && api.jobs && api.jobs.length >= 10) {
            console.log(`[aiJobExtractor] SPA API: ${api.jobs.length} jobs from intercepted payload @ ${cand.url}`);
            renderApi = { employer: api.employer || null, jobs: api.jobs, sourceUrl: cand.url, audit: normalizeAudit({ Data_Density_Score: 'High', Requires_Deep_Recrawl: false }, api.jobs.length) };
            return;
          }
        }
        if (r.rawHtml) renderedHtml = r.rawHtml;   // keep the rendered DOM for href harvesting
        const t = cleanHtmlForLLM(r.rawHtml || ''); if (t.length > text.length) text = t;
      } catch {}
    };
    const runLLM = async () => {
      const data = await llmExtract(text, cand.url, employerHint || origin);
      // Prefer the rendered DOM (all hrefs present) else the static page HTML for URL recovery.
      const rawForAnchors = renderedHtml || (pages.find((p) => p.url === cand.url) || {}).html || '';
      const out = toInternalJobs(data, cand.url, origin, rawForAnchors);
      const audit = (data && (data._mergedAudit || normalizeAudit(data.Extraction_Audit, out.jobs.length))) || normalizeAudit(null, out.jobs.length);
      return { out, audit };
    };
    // Render upfront when the static text is too thin to extract from. (M4)
    if (opts.forceRender || ((text.length < 1200 || jobHits(text) < 2) && !looksLikeListing(cand))) {
      await renderOnce();
      if (renderApi) return renderApi;
    }
    let { out, audit } = await runLLM();
    // SELF-CORRECTION via Extraction_Audit: the AI parsed the text but reports it was BLOCKED or
    // a JS-shell and yielded ZERO jobs, yet our length heuristic didn't trip a render (e.g. a
    // cookie/Cloudflare wall or an SPA skeleton padded with boilerplate). Escalate to one real
    // browser render and re-extract. Only on the zero-jobs case — a thin-DETAIL listing (jobs>0,
    // Low density) is filled downstream by Phase-2 detail enrichment, so re-rendering it is moot.
    if (out.jobs.length === 0 && audit.requiresDeepRecrawl && !rendered) {
      console.log(`[aiJobExtractor] Audit deep-recrawl @ ${cand.url}: "${audit.notes}" — forcing browser render`);
      await renderOnce();
      if (renderApi) return renderApi;
      ({ out, audit } = await runLLM());
    }
    // pageText = the actual text the jobs were extracted from, so the caller validates against
    // the RIGHT page (the careers page), not the homepage it was searched from. _renderedHtml lets
    // finalize harvest href-only (virtualized) job cards the AI couldn't read.
    return { ...out, sourceUrl: cand.url, pageText: text, audit, _renderedHtml: renderedHtml };
  };

  // Expand a successful listing result across URL-based pagination (…/page/2/, ?page=2). No-op
  // when the board isn't paginated. Bounded so it never risks the controller's extractor cap.
  const withPagination = async (result) => {
    if (!result || !result.sourceUrl || !(result.jobs || []).length) return result;
    const deadlineAt = t0 + 95000;
    if (Date.now() > deadlineAt - 8000) return result;   // not enough budget for even one page
    const pg = pages.find((p) => p.url === result.sourceUrl);
    // Prefer the RENDERED DOM: SPA boards (Phenom/Happydance, etc.) inject their ?page=N
    // pagination links via JS, so the static shell exposes none — that's the 20-of-536 bug.
    const firstHtml = result._renderedHtml || (pg && pg.html) || (result.sourceUrl && await fetchStatic(result.sourceUrl));
    if (!firstHtml) return result;
    // The AI/page reports the real total ("…of 536 jobs"); use it to crawl to the last page.
    const pageHint = detectTotal(result.pageText || firstHtml);
    const extra = await crawlPaginated(result.sourceUrl, firstHtml, employerHint || origin, origin, deadlineAt, pageHint);
    if (!extra.length) return result;
    // Merge + dedup by real job_url, else title|location signature.
    const keyOf = (j) => (j.job_url && !/#role-/.test(j.job_url)) ? j.job_url.split('#')[0].replace(/\/$/, '') : _sig(j.title, j.location);
    const seenK = new Set(); const all = [];
    for (const j of [...result.jobs, ...extra]) { const k = keyOf(j); if (seenK.has(k)) continue; seenK.add(k); all.push(j); }
    if (all.length > result.jobs.length) console.log(`[aiJobExtractor] Pagination @ ${result.sourceUrl}: ${result.jobs.length}→${all.length} jobs${pageHint.total ? ` (reported ${pageHint.total})` : ''}`);
    return { ...result, jobs: all, audit: result.audit ? { ...result.audit, totalFound: all.length } : result.audit };
  };

  // Run before every successful return: SELF-HEAL a result that landed on a single job DETAIL
  // page (few jobs) by extracting its parent LISTING and keeping the larger — then expand
  // pagination. This is the automatic "that's only 1 job, the board has more, try harder" step,
  // so a future blind spot still delivers the full board without anyone hand-fixing a regex.
  const finalize = async (result) => {
    let best = result;
    if (best.jobs.length && best.jobs.length <= 4 && best.sourceUrl && detailUrlRe(best.sourceUrl) && (Date.now() - t0) < 75000) {
      for (const pu of detailParents(best.sourceUrl).slice(0, 2)) {
        if ((Date.now() - t0) > 80000) break;
        const pg = await ensurePage(pu).catch(() => null);
        if (pg && pg.html) {
          const r = await extractFrom(candFor(pg));
          if (r.jobs.length > best.jobs.length) { console.log(`[aiJobExtractor] self-heal: parent listing ${pu} beat detail page (${r.jobs.length} > ${best.jobs.length})`); best = r; }
        }
      }
    }
    // THIN result → the page we extracted may be a LANDING/teaser ("About careers", a few featured
    // roles) that links to the real board via "View all jobs" / /all-jobs / /search / /openings.
    // Follow the strongest such link and RENDER it (these boards are usually JS job-widgets that
    // only show the full set after rendering), keeping the larger. (cegeka: about page 3 → 60.)
    if (best.jobs.length && best.jobs.length < 12 && best.sourceUrl && (Date.now() - t0) < 60000) {
      const bare = (u) => String(u).split('#')[0].replace(/\/$/, '');
      const boardRe = /\/(all[-_]?jobs|all[-_]?vacatures|all[-_]?vacancies|all[-_]?positions|all[-_]?roles|open[-_]?positions|openings|job[-_]?search|search[-_]?jobs|browse[-_]?jobs|view[-_]?all)(\/|$|\?)/i;
      const pg0 = pages.find((p) => p.url === best.sourceUrl);
      const links = (pg0 && pg0.html) ? pageParsed(pg0)._links : [];
      const cands = [...new Set(links.filter((l) => boardRe.test(l) && bare(l) !== bare(best.sourceUrl)))];
      for (const u of cands.slice(0, 2)) {
        if ((Date.now() - t0) > 65000) break;
        const pg = await ensurePage(u).catch(() => null);
        if (pg && pg.html) {
          const r = await extractFrom(candFor(pg), { forceRender: true });
          if (r.jobs.length > best.jobs.length) { console.log(`[aiJobExtractor] self-heal: broader board ${u} beat thin landing (${r.jobs.length} > ${best.jobs.length})`); best = r; }
        }
      }
    }
    // VIRTUALIZED-WIDGET recovery: a rendered board may emit every job's <a href> while only ~20
    // cards have visible text the AI could read. Harvest the same-pattern detail links the AI
    // missed and add them as stubs — Phase-2 fills their real title/salary/skills. (cegeka 21→~60.)
    if (best.jobs.length && best.sourceUrl) {
      const pg = pages.find((p) => p.url === best.sourceUrl);
      const html = best._renderedHtml || (pg && pg.html);   // prefer the rendered DOM (has all hrefs)
      if (html) {
        const have = new Set(best.jobs.map((j) => String(j.job_url || '').split('#')[0].replace(/\/$/, '')));
        const extra = harvestDetailLinks(html, best.jobs.map((j) => j.job_url)).filter((u) => !have.has(u));
        if (extra.length) {
          console.log(`[aiJobExtractor] harvested ${extra.length} extra job link(s) from ${best.sourceUrl} (virtualized cards)`);
          const stubs = extra.map((u) => ({ title: titleFromSlug(u), location: 'Not specified', job_type: 'Full-time', work_mode: null, salary: null, experience: null, skills: [], responsibilities: [], job_url: u, contacts: [], employer_name: best.employer || null, _atsApi: false }));
          best = { ...best, jobs: [...best.jobs, ...stubs] };
        }
      }
    }
    return await withPagination(best);
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

  // 1c) Tier 2 — schema.org JobPosting JSON-LD (FREE, no LLM). If a careers page embeds its board
  //     as JobPosting blocks (common for Google-for-Jobs SEO), build the listing from them directly
  //     and skip the listing/pagination LLM entirely. Phase-2 still AI-fills skills/responsibilities
  //     downstream, so the final output is unchanged — we just got the job list for zero tokens.
  //     Prefer a candidate that is itself a listing (strongJobUrl) so we don't lock onto a lone
  //     detail page's single JobPosting; finalize()'s pagination is JSON-LD-aware so it stays free.
  {
    let ldBest = null;
    for (const p of pages.filter((p) => p.html)) {
      const ld = extractJsonLdJobs(p.html, p.url);
      if (ld.length < 3) continue;
      // COMPLETENESS GUARD (no-compromise): only trust JSON-LD as the FULL board if it covers the
      // job-detail links visible on that page. If JSON-LD is a partial subset, fall through to AI —
      // we fail toward "correct but costlier", never toward "cheap but incomplete". (Math.max(3,…)
      // lets a JS-rendered page, where no plain links are detectable, still use a solid JSON-LD set.)
      const detailLinks = pageParsed(p)._links.filter((l) => detailUrlRe(l)).length;
      if (ld.length < Math.max(3, detailLinks)) continue;
      if (!ldBest || ld.length > ldBest.jobs.length) ldBest = { jobs: ld, sourceUrl: p.url, employer: ld[0].employer_name || null };
    }
    if (ldBest) {
      console.log(`[aiJobExtractor] JSON-LD: ${ldBest.jobs.length} JobPosting(s) @ ${ldBest.sourceUrl} (free, no LLM)`);
      return await finalize({ ...ldBest, audit: normalizeAudit({ Data_Density_Score: 'Medium', Requires_Deep_Recrawl: true, Diagnostic_Notes: 'JSON-LD listing — detail pages enrich skills/responsibilities' }, ldBest.jobs.length) });
    }
  }

  // 2) FAST PATH — server-rendered listing already in static HTML (ebcont/lexon/sipgate).
  //    Verify by EXTRACTION; only trust it if it actually yields jobs. Skip short-circuiting
  //    on a FACET URL (a filtered slice) — fall through so the SPA path can render & compare
  //    the full board against it. (M3)
  const fast = rankPages(pages).find(looksLikeListing);
  if (fast && !facetUrlRe(fast.url)) { const r = await extractFrom(fast); if (r.jobs.length) return await finalize(r); }

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
  let lastAudit = null;   // most-recent diagnostic — surfaced to the controller even on empty
  for (const cand of rankPages(pages).slice(0, 3)) {
    const r = await extractFrom(cand);
    if (r.audit) lastAudit = r.audit;
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
  if (best.jobs.length) return await finalize(best);
  return { jobs: [], audit: lastAudit || normalizeAudit(null, 0) };
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

module.exports = { findAndExtract, detectAtsOnCareers, cleanHtmlForLLM, llmExtract, toInternalJobs, extractJsonLdJobs };
