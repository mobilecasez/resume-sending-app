// Automated employer diagnostic agent — given an employer URL we failed on, it
// investigates the way a human would: try the input + common careers URLs/subdomains,
// run ATS detection, parse JSON-LD JobPosting, probe for hidden JSON job APIs, and
// generically extract jobs from any JSON response. It then DOUBLE-VERIFIES (re-extracts
// and checks the jobs are real WITH details) before proposing an auto-applicable fix.
//
// Output fix_config kinds (executed by applyOverride, used both to verify here and to
// apply on future searches):
//   { kind:'careers_url', url }  — the real jobs URL (ATS/JSON-LD lives there)
//   { kind:'jsonld', url }       — page has JSON-LD JobPosting
//   { kind:'api', apiUrl }       — a hidden JSON jobs API
'use strict';

const ats = require('../utils/atsDiscovery');
const { fetchText, detectAndFetchAts, makeJob, strip, bulletsFrom } = ats;
const { smartScrape, stripHtmlToText } = require('../utils/playwrightScraper');
const { applyDetailRecipe } = require('../utils/atsSitemap');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Gemini JSON model — the agent's "brain" for reasoning about unknown sites.
function geminiJson(modelName = 'gemini-2.5-flash') {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    return new GoogleGenerativeAI(key).getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 8192 },
    });
  } catch { return null; }
}
const GEMINI_AVAILABLE = !!process.env.GEMINI_API_KEY;

// generateContent + JSON.parse with retry/backoff. Transient throttles (429 / quota /
// overload / timeout) and malformed-JSON responses are retried with exponential backoff
// instead of failing instantly — this is what makes flaky/slow employers reliable.
async function geminiJsonCall(model, prompt, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await model.generateContent(prompt);
      return JSON.parse(res.response.text());
    } catch (e) {
      const msg = String((e && e.message) || '');
      const transient = /\b429\b|rate|quota|overload|exhaust|unavailable|\b503\b|\b500\b|timeout|deadline|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
      if (i < tries - 1) { await new Promise((r) => setTimeout(r, transient ? 900 * Math.pow(2, i) : 400)); continue; }
      return null;
    }
  }
  return null;
}

const uniq = (a) => [...new Set(a.filter(Boolean))];
function rootDomain(host) {
  const c = String(host || '').replace(/^www\./i, '').toLowerCase().split('.');
  if (c.length <= 2) return c.join('.');
  const two = new Set(['co.uk', 'com.au', 'co.in', 'co.jp', 'com.br', 'co.nz', 'com.sg']);
  return two.has(c.slice(-2).join('.')) ? c.slice(-3).join('.') : c.slice(-2).join('.');
}
function isPlausibleTitle(t) {
  if (!t || typeof t !== 'string') return false;
  const s = t.trim();
  return s.length >= 3 && /[a-zA-ZÀ-ɏ]{2,}/.test(s) && !/^[\d\s.,%+\-€$£¥]+$/.test(s);
}

// Content signature for de-duplication. Careers pages frequently REPEAT the same job:
// sliders/carousels clone slides for infinite looping, and pagination can wrap back to
// page 1. Matching on normalized title + location collapses those repeats no matter how
// they arise (cloned DOM, looped pages, fragment URLs).
const _norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function contentSig(title, location) { return _norm(title) + '|' + _norm(location); }
function dedupeJobsByContent(jobs) {
  const seen = new Set(); const out = [];
  for (const j of jobs || []) {
    if (!j || !j.title) continue;
    const sig = contentSig(j.title, j.location);
    if (seen.has(sig)) continue;
    seen.add(sig); out.push(j);
  }
  return out;
}

// ── JSON-LD JobPosting ───────────────────────────────────────────────────────
function jobLocationText(x) {
  try {
    const loc = Array.isArray(x.jobLocation) ? x.jobLocation[0] : x.jobLocation;
    const a = (loc && (loc.address || loc)) || {};
    const country = a.addressCountry && (a.addressCountry.name || a.addressCountry);
    return [a.addressLocality, a.addressRegion, country].filter(Boolean).join(', ');
  } catch { return ''; }
}
function jobsFromJsonLd(html, baseUrl) {
  const out = [];
  for (const b of String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(b[1].trim()); } catch { continue; }
    const arr = Array.isArray(data) ? data : (Array.isArray(data['@graph']) ? data['@graph'] : [data]);
    for (const x of arr) {
      const types = [].concat((x && x['@type']) || []);
      if (!types.includes('JobPosting') || !x.title) continue;
      out.push(makeJob({
        title: strip(x.title), location: jobLocationText(x) || 'Not specified',
        job_url: x.url || baseUrl, descHtml: x.description,
        employer_name: (x.hiringOrganization && (x.hiringOrganization.name || x.hiringOrganization)) || '',
      }));
    }
  }
  return out;
}

// ── Generic JSON → jobs (works on unknown custom APIs) ───────────────────────
const TITLE_KEYS = ['title', 'name', 'jobtitle', 'position', 'role', 'positionname', 'vacancyname'];
const URL_KEYS = ['url', 'absolute_url', 'careers_url', 'applyurl', 'apply_url', 'hostedurl', 'joburl', 'link', 'permalink'];
const LOC_KEYS = ['location', 'city', 'locationname', 'office', 'place', 'workplace'];
const DESC_KEYS = ['description', 'content', 'jobdescription', 'body', 'summary'];
const pick = (o, keys) => { for (const k of Object.keys(o || {})) { if (keys.includes(k.toLowerCase())) { const v = o[k]; if (v && typeof v === 'object') return v.name || v.text || v.label || ''; if (v != null) return v; } } return ''; };
function findJobArrays(json, depth = 0, acc = []) {
  if (!json || typeof json !== 'object' || depth > 4) return acc;
  if (Array.isArray(json)) {
    const objs = json.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length >= 1 && objs.filter((o) => isPlausibleTitle(pick(o, TITLE_KEYS))).length >= Math.max(1, objs.length * 0.5)) acc.push(objs);
    objs.forEach((o) => findJobArrays(o, depth + 1, acc));
  } else {
    for (const k of Object.keys(json)) findJobArrays(json[k], depth + 1, acc);
  }
  return acc;
}
function jobsFromJson(json, baseOrigin) {
  const arrays = findJobArrays(json);
  if (!arrays.length) return [];
  const best = arrays.sort((a, b) => b.length - a.length)[0];
  const mapped = best.map((o) => {
    let url = pick(o, URL_KEYS); if (url && !/^https?:/i.test(url)) { try { url = new URL(url, baseOrigin).href; } catch {} }
    const desc = pick(o, DESC_KEYS);
    return makeJob({ title: strip(pick(o, TITLE_KEYS)), location: strip(pick(o, LOC_KEYS)) || 'Not specified', job_url: url || baseOrigin, descHtml: typeof desc === 'string' ? desc : '' });
  }).filter((j) => isPlausibleTitle(j.title));
  return dedupeJobsByContent(mapped);
}

// ── Double-verify: are these real jobs WITH details? ─────────────────────────
function assessJobs(jobs) {
  const plausible = (Array.isArray(jobs) ? jobs : []).filter((j) => j && isPlausibleTitle(j.title));
  if (plausible.length === 0) return { ok: false, jobCount: 0, withDetails: 0, reason: 'no plausible jobs' };
  const withDetails = plausible.filter((j) => ((j.responsibilities || []).length + (j.skills || []).length) > 0 || (j.location && j.location !== 'Not specified'));
  const ratio = withDetails.length / plausible.length;
  const ok = plausible.length >= 1 && ratio >= 0.5;     // ≥1 real job AND ≥50% carry details/location
  return { ok, jobCount: plausible.length, withDetails: withDetails.length, ratio: Math.round(ratio * 100) / 100, reason: ok ? 'verified' : 'too few jobs carry details' };
}

const COMMON_API_PATHS = ['/api/offers/', '/api/jobs', '/api/v1/jobs', '/api/v2/jobs', '/api/careers/jobs', '/api/positions', '/api/vacancies', '/api/job-postings', '/jobs.json', '/careers.json', '/api/content/jobs', '/wp-json/wp/v2/jobs?per_page=100', '/data/jobs.json'];

// Execute a fix_config → normalized jobs[] (used to VERIFY and to APPLY on real searches).
async function applyOverride(fixConfig) {
  if (!fixConfig || !fixConfig.kind) return null;
  try {
    if (fixConfig.kind === 'careers_url') {
      const html = await fetchText(fixConfig.url).catch(() => '');
      const r = await detectAndFetchAts(fixConfig.url, html).catch(() => null);
      if (r && r.jobs && r.jobs.length) return { jobs: r.jobs, companyName: r.companyName, ats: r.ats };
      const ld = jobsFromJsonLd(html, fixConfig.url);
      if (ld.length) return { jobs: ld, companyName: '', ats: 'jsonld' };
      return null;
    }
    if (fixConfig.kind === 'jsonld') {
      const html = await fetchText(fixConfig.url).catch(() => '');
      const ld = jobsFromJsonLd(html, fixConfig.url);
      return ld.length ? { jobs: ld, companyName: '', ats: 'jsonld' } : null;
    }
    if (fixConfig.kind === 'api') {
      const body = await fetchText(fixConfig.apiUrl);
      let json; try { json = JSON.parse(body); } catch { return null; }
      const origin = (() => { try { return new URL(fixConfig.apiUrl).origin; } catch { return ''; } })();
      const jobs = jobsFromJson(json, origin);
      return jobs.length ? { jobs, companyName: '', ats: 'api' } : null;
    }
    if (fixConfig.kind === 'render_ai') {
      // Re-render the jobs page and AI-extract live (jobs change, so never cached).
      const jobs = await aiExtractJobs(fixConfig.url);
      return jobs.length ? { jobs, companyName: '', ats: 'render_ai' } : null;
    }
  } catch (e) { return null; }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
//  LLM INVESTIGATION LAYER — the agent's brain.
//  When the fast heuristics (ATS / JSON-LD / known APIs) find nothing, the agent
//  does what a human would: gather real evidence (render the candidate pages,
//  capture XHR, read snippets), ask Gemini to DIAGNOSE why jobs weren't found and
//  WHERE they actually are, execute the strategy it proposes, then DOUBLE-VERIFY
//  the jobs are real before saving. This is what makes it general — no per-site
//  code; the model reasons about each unknown site from first principles.
// ════════════════════════════════════════════════════════════════════════════

const JOB_WORDS = ['job', 'career', 'vacan', 'stelle', 'karriere', 'bewerb', 'position', 'opening', 'hiring', 'recruit', 'wir suchen', 'join us', 'join our', 'm/w/d', 'm/w', 'vollzeit', 'teilzeit', 'lehre', 'praktik', 'intern', 'employ', 'we are looking', 'open role', 'work with us', 'offene stelle', 'apply now'];
const jobKeywordHits = (t) => { const s = (t || '').toLowerCase(); return JOB_WORDS.filter((w) => s.includes(w)); };
const jobishUrl = (u) => /\/(jobs?|career|careers|karriere|stellen|stellenangebote|vacanc|join|work-with-us|offene-stellen|positions?)\b/i.test(u || '');
// Known ATS / job-board hosts — jobs often live on one of these, linked (e.g. "View
// openings") from a careers page with a non-job-ish path. Surface them to the LLM.
const ATS_HOSTS = /(greenhouse\.io|grnh\.se|lever\.co|ashbyhq\.com|recruitee\.com|myworkdayjobs\.com|smartrecruiters\.com|breezy\.hr|workable\.com|personio\.(de|com)|teamtailor\.com|jobvite\.com|icims\.com|bamboohr\.com|applytojob\.com|rippling\.com|join\.com|hrmdirect\.com|paylocity\.com)/i;
const atsLink = (u) => ATS_HOSTS.test(u || '');

function extractLinks(html, baseUrl) {
  const out = [];
  for (const m of String(html || '').matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href = m[1]; const text = strip(m[2]);
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
    try { href = new URL(href, baseUrl).href; } catch { continue; }
    out.push({ href, text: text.slice(0, 70) });
  }
  // de-dup + prefer ATS-board links, then job-ish links
  const seen = new Set(); const uniqd = [];
  for (const l of out) { if (seen.has(l.href)) continue; seen.add(l.href); uniqd.push(l); }
  const rank = (h) => (atsLink(h) ? 2 : 0) + (jobishUrl(h) ? 1 : 0);
  return uniqd.sort((a, b) => rank(b.href) - rank(a.href)).slice(0, 30);
}

// Anti-hallucination: a title is trusted only if most of its words appear in the source text.
function titleGrounded(title, sourceText) {
  const t = (sourceText || '').toLowerCase();
  const words = String(title || '').toLowerCase().split(/[^a-zà-ÿ0-9#+]+/).filter((w) => w.length >= 4);
  if (!words.length) return false;
  const present = words.filter((w) => t.includes(w)).length;
  return present / words.length >= 0.5;
}

// ── Minimum AI sanity check on extracted results ──────────────────────────────
// Cheap (titles only, flash-lite) gate that asks: are these REAL job postings that
// genuinely belong to THIS employer? Catches junk (nav labels / section headings /
// "read more") AND wrong-employer results (e.g. dental jobs for an IT firm, or a
// mis-detected ATS board for a different company). Fail-OPEN if the model is down so
// it can never block the existing pipeline. Used by both the main search and the agent.
async function validateExtraction({ employerName, domain, context, jobs }) {
  const list = (jobs || []).filter((j) => j && j.title);
  if (!list.length) return { ok: false, realCount: 0, reason: 'no jobs', junkIndexes: [] };
  if (!GEMINI_AVAILABLE) return { ok: true, realCount: list.length, reason: 'validator unavailable (fail-open)', junkIndexes: [] };
  const model = geminiJson('gemini-2.5-flash-lite');
  if (!model) return { ok: true, realCount: list.length, reason: 'validator unavailable (fail-open)', junkIndexes: [] };
  const titles = list.slice(0, 40).map((j, i) => `${i + 1}. ${strip(j.title)}${j.location ? ` — ${strip(j.location)}` : ''}`).join('\n');
  const prompt = `These were extracted as CURRENT JOB OPENINGS for one employer. Judge whether the TITLES are REAL, specific job roles that plausibly belong to THIS employer.
EMPLOYER: ${employerName || domain} (${domain})
PAGE CONTEXT (a SHORT, possibly TRUNCATED snippet from their site — often just a header/intro, NOT the full listing): ${String(context || '').replace(/\s+/g, ' ').slice(0, 1200)}
EXTRACTED TITLES:
${titles}
Return strict JSON: {"ok":true|false,"realCount":<int>,"reason":"<short>","junkIndexes":[<1-based indexes that are NOT real jobs or clearly belong to a different industry>]}
RULES:
- Judge PRIMARILY by the TITLES themselves. A concrete job role (e.g. "Senior .NET Engineer", "Java Developer", "Implementation Consultant") that fits this employer's likely industry → real.
- DO NOT mark a title as junk merely because it does not appear in the short context snippet — the snippet is truncated and usually does NOT contain the listing.
- Mark as junk ONLY: navigation/menu labels, cookie/consent text, section headings, "read more", category names, generic non-role words, form/template names, or roles that clearly belong to a DIFFERENT industry than this employer (e.g. dental jobs for a software/IT company).
- ok=true unless MOST titles are junk by the rule above.`;
  const v = await geminiJsonCall(model, prompt);
  if (!v) return { ok: true, realCount: list.length, reason: 'validator unavailable (fail-open)', junkIndexes: [] };
  return { ok: !!v.ok, realCount: Number(v.realCount) || 0, reason: String(v.reason || ''), junkIndexes: Array.isArray(v.junkIndexes) ? v.junkIndexes : [] };
}

// LEVEL 1 — Gemini reads the LISTING page and returns each opening + its detail link.
// Grounded so it can't invent jobs (every title must appear in the listing text).
async function geminiExtractJobList(text, sourceUrl, links) {
  const model = geminiJson('gemini-2.5-flash');
  if (!model || !text) return [];
  const clipped = text.replace(/\s+/g, ' ').slice(0, 16000);
  const linkList = (links || []).slice(0, 40).map((l) => `${l.text || '(no text)'} => ${l.href}`).join('\n');
  const prompt = `You extract REAL job openings from a company's careers/jobs LISTING page.
URL: ${sourceUrl}
Return strict JSON: {"jobs":[{"title":"","location":"","job_type":"","salary":"","experience":"","responsibilities":[],"skills":[],"url":""}]}
RULES:
- ONLY actual open job positions. If a role is described in prose (e.g. "We are looking for a Full Stack Developer who ..."), extract it as ONE job with that title.
- IGNORE services, products, marketing copy, company/about descriptions, blog posts, testimonials, navigation, cookie notices.
- "title" MUST be a real job role and MUST appear in the page text. NEVER invent a job. If there are NO real openings, return {"jobs":[]}.
- DEDUPLICATE: sliders/carousels often clone the same job, and pagination can loop back. If the SAME role appears more than once, return it ONLY ONCE.
- "url": the detail / "read more" / "apply" link for THIS specific job, chosen EXACTLY from the LINKS list below (copy the href). If none clearly matches, "".
- location/salary/experience/job_type/responsibilities/skills: only what's stated on the listing, else ""/[].
LINKS (text => href):
${linkList || '(none)'}
PAGE TEXT:
"""${clipped}"""`;
  try {
    const data = await geminiJsonCall(model, prompt);
    if (!data) return [];
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    const mapped = jobs
      .filter((j) => j && isPlausibleTitle(j.title) && titleGrounded(j.title, text))
      .map((j) => {
        let detailUrl = '';
        if (typeof j.url === 'string' && j.url.trim()) { try { detailUrl = new URL(j.url.trim(), sourceUrl).href; } catch {} }
        return {
          title: strip(j.title), location: strip(j.location), salary: strip(j.salary), experience: strip(j.experience),
          job_type: strip(j.job_type), hours: strip(j.hours),
          responsibilities: Array.isArray(j.responsibilities) ? j.responsibilities.map(strip).filter(Boolean) : [],
          skills: Array.isArray(j.skills) ? j.skills.map(strip).filter(Boolean) : [],
          detailUrl,
        };
      });
    // Collapse slider clones / looped repeats before the (costly) detail-page visits.
    return dedupeJobsByContent(mapped);
  } catch { return []; }
}

// LEVEL 2 — Gemini reads ONE job's DETAIL page and pulls the full specifics
// (salary band, weekly hours, experience, responsibilities, skills) that the
// listing rarely shows. This is the "iterate into each job" step.
async function geminiExtractJobDetail(text, title) {
  const model = geminiJson('gemini-2.5-flash-lite');
  if (!model || !text) return null;
  const prompt = `Extract the full details for the job "${title}" from its job detail page.
Return strict JSON: {"salary":"","hours":"","experience":"","job_type":"","location":"","responsibilities":[],"skills":[]}
- "salary": pay/compensation incl. period & currency exactly as stated (e.g. "€ 3.500 brutto/Monat", "$120k–150k"), else "".
- "hours": weekly working hours if stated (e.g. "38,5 Wochenstunden", "40 hrs/week"), else "".
- "experience": required years/seniority if stated, else "".
- "job_type": employment type (Full-time/Part-time/Vollzeit/Teilzeit/Contract/Internship), else "".
- responsibilities/skills: concise phrases from the page; [] if none.
Only use info actually on the page. Do not invent.
PAGE TEXT:
"""${text.replace(/\s+/g, ' ').slice(0, 13000)}"""`;
  const d = await geminiJsonCall(model, prompt);
  return d && typeof d === 'object' ? d : null;
}

// Merge a listing job + (optional) detail-page extraction into a normalized job.
// Weekly hours are folded into job_type (there's no dedicated hours field downstream).
function buildAiJob(listing, detail, sourceUrl, idx) {
  const d = detail || {};
  const pick = (a, b) => (a && String(a).trim()) ? String(a).trim() : ((b && String(b).trim()) ? String(b).trim() : '');
  const resp = (Array.isArray(d.responsibilities) && d.responsibilities.length ? d.responsibilities : listing.responsibilities) || [];
  const skills = (Array.isArray(d.skills) && d.skills.length ? d.skills : listing.skills) || [];
  let jobType = pick(d.job_type, listing.job_type) || 'Full-time';
  const hours = pick(d.hours, listing.hours);
  if (hours && !new RegExp(hours.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(jobType)) jobType = `${jobType} · ${hours}`;
  let job_url = listing.detailUrl || (sourceUrl + '#role-' + (idx + 1));
  return {
    title: strip(listing.title),
    location: pick(d.location, listing.location) || 'Not specified',
    job_url,
    job_type: jobType,
    salary: pick(d.salary, listing.salary) || null,
    experience: pick(d.experience, listing.experience) || null,
    responsibilities: resp.map(strip).filter(Boolean).slice(0, 12),
    skills: skills.map(strip).filter(Boolean).slice(0, 15),
    employer_name: null,
    _atsApi: true,
  };
}

// Fetch a page's content for extraction, STATIC-FIRST. Many careers pages are server-
// rendered (ebcont/lexon/PORR) — their plain HTML already has the jobs, and a static
// fetch is fast + deterministic. We only fall back to the (slow, sometimes hostile)
// headless browser when the static HTML lacks job content (a real JS app). This is what
// makes slow sites reliable instead of timing out.
async function fetchForExtraction(url, knownHtml) {
  let html = knownHtml || await fetchText(url).catch(() => '');
  let text = stripHtmlToText(html);
  if (text.length > 1200 && jobKeywordHits(text).length >= 2) {
    return { text, rawHtml: html, interceptedJson: null };   // static already has the jobs
  }
  try {
    const r = await smartScrape(url, { forceBrowser: true, minChars: 400 });
    if ((r.text || '').length > text.length || r.interceptedJson) {
      return { text: r.text || text, rawHtml: r.rawHtml || html, interceptedJson: r.interceptedJson || null };
    }
  } catch { /* render failed → fall back to static below */ }
  return { text, rawHtml: html, interceptedJson: null };
}

// Extract jobs from a page. ATS adapter first; else intercepted JSON; else two-level AI:
// read the listing, then VISIT each job's detail page for the full specifics.
async function aiExtractJobs(url, knownHtml) {
  let origin = '';
  try { origin = new URL(url).origin; } catch {}
  // If the chosen URL is actually an ATS board, the structured adapter beats AI.
  const html0 = knownHtml || await fetchText(url).catch(() => '');
  if (!knownHtml) knownHtml = html0;
  const r0 = await detectAndFetchAts(url, html0).catch(() => null);
  if (r0 && r0.jobs && r0.jobs.length) return r0.jobs;

  const fetched = await fetchForExtraction(url, knownHtml);
  let { text, rawHtml, interceptedJson } = fetched;
  if (interceptedJson) {
    const j = jobsFromJson(interceptedJson, origin);
    if (j.length) return j;
  }
  // Level 1: list of jobs + per-job detail links.
  const links = extractLinks(rawHtml || knownHtml || '', url);
  const listing = await geminiExtractJobList(text, url, links);
  if (!listing.length) return [];
  // Level 2: visit each job's detail page (bounded) and pull full details.
  const enriched = await ats.mapLimit(listing.slice(0, 25), 5, async (j, i) => {
    let detail = null;
    if (j.detailUrl && j.detailUrl !== url && j.detailUrl.split('#')[0] !== url.split('#')[0]) {
      let dtext = '';
      const dhtml = await fetchText(j.detailUrl).catch(() => '');
      dtext = stripHtmlToText(dhtml);
      if (dtext.length < 600) {
        try { const r = await smartScrape(j.detailUrl, { forceBrowser: true, minChars: 300 }); if ((r.text || '').length > dtext.length) dtext = r.text; } catch {}
      }
      if (dtext) detail = await geminiExtractJobDetail(dtext, j.title);
    }
    return buildAiJob(j, detail, url, i);
  });
  return enriched.filter(Boolean);
}

// Build compact evidence for the LLM: for the input + the most job-ish candidates,
// render the page and capture keywords, JSON-LD/ATS hints, links, XHR, and a snippet.
async function buildEvidence(input, fetched) {
  const origin = (() => { try { return new URL(input).origin; } catch { return input; } })();
  const signals = fetched.map(({ url, html }) => {
    const txt = html ? stripHtmlToText(html) : '';
    return {
      url, reachable: !!html, textLen: txt.length, keywords: jobKeywordHits(txt),
      hasJsonLdJob: /application\/ld\+json/i.test(html || '') && /JobPosting/i.test(html || ''),
      atsHint: (String(html || '').match(/greenhouse|lever\.co|ashby|recruitee|myworkdayjobs|smartrecruiters|breezy|workable|personio|teamtailor|jobvite|icims/i) || [])[0] || null,
      links: extractLinks(html, url),
    };
  });
  // Rank pages to read: reachable, job-ish URL or keyword-rich.
  const htmlByUrl = new Map(fetched.map((f) => [f.url, f.html]));
  const score = (s) => (s.reachable ? 1 : 0) + (jobishUrl(s.url) ? 3 : 0) + Math.min(s.keywords.length, 4) + (s.url === origin || s.url === input ? 1 : 0);
  const toRender = [...signals].filter((s) => s.reachable).sort((a, b) => score(b) - score(a)).slice(0, 4);
  // STATIC-FIRST: reuse the static HTML we already fetched; only render in a browser if
  // it lacks job content. Keeps slow/hostile sites (ebcont) fast and deterministic.
  const rendered = await ats.mapLimit(toRender, 4, async (s) => {
    try {
      const f = await fetchForExtraction(s.url, htmlByUrl.get(s.url));
      const rtxt = (f.text || '').replace(/\s+/g, ' ');
      return { url: s.url, renderedLen: rtxt.length, sawXhrJobJson: !!f.interceptedJson, keywords: jobKeywordHits(rtxt), snippet: rtxt.slice(0, 1400) };
    } catch (e) { return { url: s.url, error: e.message }; }
  });
  // Collect links the LLM could redirect us to (job-ish paths AND known ATS boards —
  // e.g. a "View openings" link to boards.greenhouse.io/acme).
  const allLinks = [];
  for (const s of signals) for (const l of s.links) if (jobishUrl(l.href) || atsLink(l.href)) allLinks.push(l.href);
  // ATS-board links first so the model sees them even after truncation.
  const jobLinks = [...new Set(allLinks)].sort((a, b) => (atsLink(b) ? 1 : 0) - (atsLink(a) ? 1 : 0)).slice(0, 24);
  return { signals: signals.map((s) => ({ url: s.url, reachable: s.reachable, keywords: s.keywords, hasJsonLdJob: s.hasJsonLdJob, atsHint: s.atsHint })), rendered, jobLinks };
}

// The LLM diagnosis: given evidence, reason about WHY jobs weren't found and WHERE
// they are, and pick a strategy to extract them.
async function llmDiagnose(input, evidence) {
  const model = geminiJson('gemini-2.5-flash');
  if (!model) return null;
  const prompt = `You are a job-extraction diagnostic agent. We tried to list job openings for an employer and FAILED (got nothing or garbage). Below is real evidence gathered from their site (pages were rendered with a headless browser). Figure out, like a human investigator would, WHERE the actual job openings live and HOW to extract them.

EMPLOYER INPUT: ${input}

EVIDENCE (JSON):
${JSON.stringify(evidence).slice(0, 18000)}

Decide and return strict JSON:
{
  "reason": "one or two sentences: why discovery failed and where the jobs actually are",
  "jobsUrl": "the single best URL that contains the real job openings (from the evidence pages or jobLinks), or null if there is genuinely no evidence of any jobs anywhere",
  "strategy": "render_ai | ats | jsonld | api",
  "apiUrl": "if strategy=api, the JSON endpoint URL, else null",
  "confidence": 0.0
}
GUIDANCE:
- If "jobLinks" contains a link to a known ATS / job board (e.g. greenhouse.io, lever.co, ashbyhq.com, recruitee.com, smartrecruiters.com, workable.com, teamtailor.com, personio, bamboohr.com, myworkdayjobs.com), the real openings are almost certainly there — use strategy "ats" and set jobsUrl to that board link.
- Else if a page's snippet contains job openings (even described in prose / multiple roles in text), use strategy "render_ai" and set jobsUrl to that page.
- If evidence shows an ATS (atsHint) embed, use "ats" with jobsUrl = the page hosting it.
- If a page has JSON-LD JobPosting, use "jsonld".
- If you can identify a JSON jobs API endpoint, use "api" with apiUrl.
- Prefer the most specific careers/jobs page. If a page explicitly says there are NO open positions, or NOTHING in the evidence indicates real jobs, set jobsUrl=null and confidence low (do not invent jobs).`;
  const plan = await geminiJsonCall(model, prompt);
  return plan && typeof plan === 'object' ? plan : null;
}

// Full AI investigation: evidence → diagnose → execute → double-verify.
async function aiInvestigate(input, fetched, steps) {
  if (!GEMINI_AVAILABLE) { steps.push('AI layer skipped: GEMINI_API_KEY not set.'); return null; }
  steps.push('Heuristics found nothing — engaging AI investigator (render + reason).');
  const evidence = await buildEvidence(input, fetched).catch((e) => { steps.push('evidence error: ' + e.message); return null; });
  if (!evidence) return null;
  const plan = await llmDiagnose(input, evidence);
  if (!plan) { steps.push('AI diagnosis returned nothing.'); return null; }
  steps.push(`AI diagnosis: ${plan.reason || '(no reason)'} → strategy=${plan.strategy} url=${plan.jobsUrl || 'none'} (conf ${plan.confidence})`);
  if (!plan.jobsUrl && !(plan.strategy === 'api' && plan.apiUrl)) return { plan, jobs: [] };

  let jobs = [];
  try {
    if (plan.strategy === 'ats') {
      const html = await fetchText(plan.jobsUrl).catch(() => '');
      const r = await detectAndFetchAts(plan.jobsUrl, html).catch(() => null);
      jobs = (r && r.jobs) || [];
    } else if (plan.strategy === 'jsonld') {
      const html = await fetchText(plan.jobsUrl).catch(() => '');
      jobs = jobsFromJsonLd(html, plan.jobsUrl);
    } else if (plan.strategy === 'api' && plan.apiUrl) {
      const applied = await applyOverride({ kind: 'api', apiUrl: plan.apiUrl });
      jobs = (applied && applied.jobs) || [];
    } else { // render_ai (default)
      jobs = await aiExtractJobs(plan.jobsUrl);
    }
  } catch (e) { steps.push('strategy execution error: ' + e.message); }
  return { plan, jobs };
}

// ── The agent ────────────────────────────────────────────────────────────────
async function investigate(input) {
  const steps = [];
  const inputUrl = /^https?:\/\//i.test(input) ? input : 'https://' + String(input).replace(/^\/+/, '');
  let origin, host;
  try { const u = new URL(inputUrl); origin = u.origin; host = u.hostname; } catch { return { status: 'failed', diagnosis: { steps: ['bad input url'] }, fixConfig: null, verified: false, jobs: [] }; }
  const root = rootDomain(host);

  const candidates = uniq([
    inputUrl,
    `${origin}/jobs`, `${origin}/careers`, `${origin}/career`, `${origin}/karriere`, `${origin}/karriere/jobs`,
    `${origin}/en/careers`, `${origin}/company/careers`, `${origin}/about/careers`, `${origin}/join-us`, `${origin}/work-with-us`, `${origin}/vacancies`,
    `https://careers.${root}`, `https://jobs.${root}`, `https://apply.${root}`, `https://career.${root}`,
  ]);

  // 1) Fetch all candidate URLs IN PARALLEL, then evaluate in priority order.
  const fetched = await ats.mapLimit(candidates, 10, async (url) => {
    try { return { url, html: await fetchText(url) }; } catch { return { url, html: '' }; }
  });
  for (const { url, html } of fetched) {
    if (!html) continue;
    let r = null; try { r = await detectAndFetchAts(url, html); } catch {}
    if (r && r.jobs && r.jobs.length) {
      const v = assessJobs(r.jobs);
      steps.push(`ATS '${r.ats}' at ${url} → ${r.jobs.length} jobs (verify: ${v.reason})`);
      if (v.ok) return finalize('fixed', { method: 'ats', ats: r.ats, url, steps }, { kind: 'careers_url', url, ats: r.ats }, true, r.jobs);
    }
    const ld = jobsFromJsonLd(html, url);
    if (ld.length) {
      const v = assessJobs(ld);
      steps.push(`JSON-LD at ${url} → ${ld.length} jobs (verify: ${v.reason})`);
      if (v.ok) return finalize('fixed', { method: 'jsonld', url, steps }, { kind: 'jsonld', url }, true, ld);
    }
  }

  // 2) Probe common hidden JSON job APIs (input origin + careers subdomains) IN PARALLEL.
  const apiTargets = [];
  for (const o of uniq([origin, `https://careers.${root}`, `https://jobs.${root}`])) for (const p of COMMON_API_PATHS) apiTargets.push(o + p);
  const apiResults = await ats.mapLimit(apiTargets, 10, async (apiUrl) => {
    try { const json = JSON.parse(await fetchText(apiUrl)); const jobs = jobsFromJson(json, new URL(apiUrl).origin); return jobs.length ? { apiUrl, jobs } : null; } catch { return null; }
  });
  for (const res of apiResults) {
    if (!res) continue;
    const v = assessJobs(res.jobs);
    steps.push(`hidden API ${res.apiUrl} → ${res.jobs.length} jobs (verify: ${v.reason})`);
    if (v.ok) return finalize('fixed', { method: 'api', apiUrl: res.apiUrl, steps }, { kind: 'api', apiUrl: res.apiUrl }, true, res.jobs);
  }

  // 3) AI INVESTIGATION — heuristics failed; let the model reason about this site.
  steps.push('No ATS, JSON-LD, or hidden JSON API found via heuristics.');
  const ai = await aiInvestigate(input, fetched, steps).catch((e) => { steps.push('AI investigate error: ' + e.message); return null; });
  if (ai && ai.jobs && ai.jobs.length) {
    const dom = rootDomain(host);
    const p = ai.plan || {};
    let jobs = ai.jobs;
    let v = assessJobs(jobs);
    if (v.ok) {
      // Relevance gate: do these jobs actually BELONG to this employer? (Stops a
      // transient/demo render returning, say, dental jobs for an IT company.)
      let ctx = ''; try { ctx = stripHtmlToText(await fetchText(p.jobsUrl || input).catch(() => '')).slice(0, 700); } catch {}
      let rel = await validateExtraction({ employerName: '', domain: dom, context: ctx, jobs }).catch(() => ({ ok: true }));
      if (!rel.ok && p.strategy === 'render_ai' && p.jobsUrl) {
        steps.push(`relevance check failed (${rel.reason}) — re-extracting once`);
        const retry = await aiExtractJobs(p.jobsUrl).catch(() => []);
        if (retry.length) {
          const rv = assessJobs(retry);
          const rr = rv.ok ? await validateExtraction({ employerName: '', domain: dom, context: ctx, jobs: retry }).catch(() => ({ ok: true })) : { ok: false };
          if (rv.ok && rr.ok) { jobs = retry; v = rv; rel = rr; }
        }
      }
      if (rel.ok) {
        const fix = p.strategy === 'ats' ? { kind: 'careers_url', url: p.jobsUrl }
          : p.strategy === 'jsonld' ? { kind: 'jsonld', url: p.jobsUrl }
          : p.strategy === 'api' ? { kind: 'api', apiUrl: p.apiUrl }
          : { kind: 'render_ai', url: p.jobsUrl };
        steps.push(`AI extraction → ${jobs.length} jobs (verified + relevant to ${dom})`);
        return finalize('fixed', { method: 'ai:' + (p.strategy || 'render_ai'), url: p.jobsUrl || p.apiUrl, aiReason: p.reason, steps }, fix, true, jobs);
      }
      steps.push(`AI result REJECTED — not relevant to ${dom}: ${rel.reason}`);
    } else {
      steps.push(`AI extraction → ${ai.jobs.length} jobs (verify: ${v.reason})`);
    }
  }

  const aiReason = ai && ai.plan && ai.plan.reason;
  return finalize('needs_review', {
    method: 'ai_unresolved', steps, aiReason,
    note: aiReason || 'The AI investigator could not locate verifiable job openings. May need a manual rethink or the site has no public listings.',
  }, null, false, []);
}

function finalize(status, diagnosis, fixConfig, verified, jobs) {
  const v = assessJobs(jobs);
  return {
    status, diagnosis: { ...diagnosis, verify: v }, fixConfig, verified: verified && v.ok, jobCount: v.jobCount,
    jobs: jobs || [], // full array — used by the inline (silent) discovery flow
    sample: (jobs || []).slice(0, 5).map((j) => ({ title: j.title, location: j.location, skills: (j.skills || []).slice(0, 5), responsibilities: (j.responsibilities || []).length })),
  };
}

// ── Learn a DETAIL-PAGE extraction recipe from 1-2 sample jobs ────────────────
// When the generic ATS parser can't pull required fields for an employer, look at a
// sample detail page and produce a reusable recipe (selectors/headings/labels) that
// a deterministic applier runs on EVERY job of that employer — 1-2 AI calls total,
// then no per-job AI. Verified by re-applying to the samples before it's trusted.
function trimHtmlForRecipe(html) {
  let h = String(html || '')
    .replace(/<head[\s\S]*?<\/head>/i, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const bodyM = h.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyM) h = bodyM[1];
  // Keep CLASS attributes (needed for CSS selectors) but drop other noisy attrs to save tokens.
  h = h.replace(/\s(?:style|data-[\w-]+|aria-[\w-]+|role|tabindex|target|rel)="[^"]*"/gi, '');
  return h.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').slice(0, 32000);
}

async function learnDetailRecipe(samples, missingFields) {
  const model = geminiJson('gemini-2.5-flash');
  if (!model || !samples || !samples.length || !missingFields || !missingFields.length) return null;
  const trimmed = trimHtmlForRecipe(samples[0].html);
  const prompt = `You are building a REUSABLE extraction recipe for a company's job DETAIL pages (every job uses the same template). Below is the HTML of ONE sample page. For each MISSING field, say how to deterministically extract it from pages like this.
MISSING FIELDS: ${missingFields.join(', ')}
Return strict JSON (include ONLY the missing fields; use null if a field is genuinely NOT on the page):
{
  "salary": {"method":"section","heading":"<heading of the section that states pay, e.g. Benefits/Vorteile>"} | {"method":"selector","selector":"<css>"} | {"method":"regex"} | null,
  "experience": {"method":"selector","selector":"<css>"} | {"method":"regex"} | null,
  "location": {"method":"label","label":"<exact label before the city, e.g. Einsatzort>"} | {"method":"selector","selector":"<css>"} | null,
  "responsibilities": {"method":"heading","heading":"<exact heading above the duties bullets>"} | {"method":"selector","selector":"<css matching EACH bullet>"} | null,
  "skills": {"method":"heading","heading":"<exact heading above the requirements bullets>"} | {"method":"selector","selector":"<css matching EACH bullet>"} | null
}
RULES:
- Prefer "selector" with a precise CSS selector when a field sits in its own element; for bullet lists the selector MUST match each bullet (e.g. "section.requirements li").
- Use "heading" with the EXACT visible heading text when duties/requirements are bullets under a heading (works in ANY language — copy it verbatim).
- Use "label" for "Label: value" pairs (copy the exact label text).
- Use "section" for pay stated in prose inside a named section (give that section's heading; we extract the amount ourselves).
- Copy heading/label/selector text EXACTLY. NEVER invent a field that isn't present — return null for it.
HTML:
"""${trimmed}"""`;
  try {
    const recipe = await geminiJsonCall(model, prompt);
    if (!recipe || typeof recipe !== 'object') return null;
    // Verify: apply on ALL samples; which previously-missing fields are now recovered?
    const recovered = new Set();
    for (const s of samples) {
      let got = {}; try { got = applyDetailRecipe(s.html, recipe) || {}; } catch {}
      for (const f of missingFields) {
        const v = got[f];
        if (Array.isArray(v) ? v.length : (v && String(v).trim())) recovered.add(f);
      }
    }
    return { recipe, verifiedFields: [...recovered] };
  } catch { return null; }
}

module.exports = { investigate, applyOverride, assessJobs, jobsFromJsonLd, jobsFromJson, dedupeJobsByContent, contentSig, learnDetailRecipe, validateExtraction };
