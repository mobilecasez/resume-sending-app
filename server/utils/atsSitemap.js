// ATS sitemap fallback — new, self-contained, additive.
//
// Enterprise career portals (SAP SuccessFactors, Workday, etc.) render their
// SEARCH page in JavaScript, so a normal HTML scrape finds 0 job links. BUT they
// expose every job in {host}/sitemap.xml as a SERVER-RENDERED detail page (for
// Google indexing), with the data in `data-careersite-propertyid="..."` attrs +
// JSON-LD. So we can discover ALL jobs from the sitemap and parse each page with
// a plain HTTP GET — no Playwright, no AI, no per-job cap needed.
//
// Used only as a fallback when normal discovery finds nothing (see
// aiHubController.processJobSearch). Changes no prompts.
'use strict';

const https = require('https');
const http = require('http');
let cheerio = null; try { cheerio = require('cheerio'); } catch { /* selectors disabled if absent */ }

const UA = 'Mozilla/5.0 (compatible; CVApplyrBot/1.0; +https://cvapplyr.com)';
const FETCH_TIMEOUT = 12000;

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('too many redirects'));
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': UA, Accept: 'application/xml,text/html,*/*' }, timeout: FETCH_TIMEOUT }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        const next = r.headers.location.startsWith('http') ? r.headers.location : new URL(r.headers.location, url).href;
        return resolve(fetchText(next, redirects + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let d = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { d += c; if (d.length > 8_000_000) req.destroy(); });
      r.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function titleFromUrl(url) {
  try {
    // Breezy & similar: /p/<hex-hash>-<slug>  → drop the hash, keep the slug.
    let m = url.match(/\/p\/[a-z0-9]+?-([^/?#]+)/i);
    if (m) {
      const slug = decodeURIComponent(m[1]).replace(/[+_-]+/g, ' ').replace(/\s+/g, ' ').trim();
      return slug.slice(0, 120) || 'Role';
    }
    m = url.match(/\/job\/([^/]+)\/\d+\/?$/i) || url.match(/\/job\/([^/?#]+)/i)
      || url.match(/\/(?:jobs|careers|position|opening|vacancy|vacature|vacatures|offre|stelle|empleo)\/([^/?#]+)(?:\/([^/?#]+))?/i);
    if (!m) return 'Role';
    // Phenom/Happydance & co. use /jobs/<req-id>/<human-slug>/ — when the FIRST segment is a bare
    // id (r-116118, req-12345, 12345, a long hash), prefer the human slug that follows it.
    const idLike = (s) => /^(?:r|req|job|jr|pos|id|ref|vac)?[-_]?\d{2,}$/i.test(s) || /^[a-f0-9]{16,}$/i.test(s);
    const seg = (m[2] && idLike(m[1])) ? m[2] : m[1];
    const slug = decodeURIComponent(seg).replace(/[+_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return slug.slice(0, 120) || 'Role';
  } catch { return 'Role'; }
}

function rootDomain(host) {
  const clean = String(host || '').replace(/^www\./i, '').toLowerCase();
  const parts = clean.split('.');
  if (parts.length <= 2) return clean;
  const twoPart = new Set(['co.uk', 'com.au', 'co.in', 'co.jp', 'com.br', 'co.nz', 'com.sg', 'com.mx']);
  return twoPart.has(parts.slice(-2).join('.')) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}

function candidateHosts(scrapeUrl, domain) {
  const hosts = [];
  const add = (h) => { if (h && !hosts.includes(h)) hosts.push(h); };
  let entryHost = '';
  try { entryHost = new URL(scrapeUrl).host.toLowerCase(); } catch {}
  add(entryHost);
  const root = rootDomain(domain || entryHost);
  if (root) { add('jobs.' + root); add('careers.' + root); add('career.' + root); add(root); add('www.' + root); }
  return hosts.filter(Boolean);
}

const locRe = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi;
const extractLocs = (xml) => [...xml.matchAll(locRe)].map((m) => m[1]);
// Job-detail URL patterns across common ATS vendors (incl. Breezy /p/<hash>-<slug>).
const isJobUrl = (u) => /\/(job|jobs|career|careers|position|opening|vacancy|stelle)\/[^/]+\/\d|\/job\/|\/jobs\/[a-z0-9-]{6,}|\/p\/[a-z0-9]{8,}/i.test(u);

async function jobUrlsForHost(host, limit) {
  let xml;
  try { xml = await fetchText(`https://${host}/sitemap.xml`); } catch { return []; }
  if (!/<(urlset|sitemapindex)/i.test(xml)) return [];
  const locs = extractLocs(xml);
  let jobUrls = locs.filter(isJobUrl);
  if (jobUrls.length === 0 && /<sitemapindex/i.test(xml)) {
    const nested = locs.filter((u) => /\.xml(\.gz)?(\?|$)/i.test(u)).slice(0, 12);
    for (const sm of nested) {
      try { jobUrls.push(...extractLocs(await fetchText(sm)).filter(isJobUrl)); } catch {}
      if (jobUrls.length >= limit) break;
    }
  }
  const seen = new Set();
  return jobUrls.filter((u) => (seen.has(u) ? false : (seen.add(u), true))).slice(0, limit);
}

/**
 * Discover job listing URLs from a company's ATS sitemap.
 * Probes all candidate hosts IN PARALLEL (bounded by one host's timeout, not the
 * sum) and returns the RICHEST sitemap — so the canonical jobs portal (e.g.
 * jobs.rwe.com with 184) wins over a thin www. sitemap (which may list only a
 * few). Fast and accurate; safe to call on every search.
 * @returns {Promise<Array<{title:string, job_url:string}>>}
 */
async function discoverSitemapJobUrls(scrapeUrl, domain, limit = 200) {
  const hosts = candidateHosts(scrapeUrl, domain);
  const perHost = await Promise.all(hosts.map(async (host) => {
    try { return await jobUrlsForHost(host, limit); } catch { return []; }
  }));
  let best = [];
  for (const urls of perHost) if (urls.length > best.length) best = urls;
  return best.map((u) => ({ title: titleFromUrl(u), job_url: u }));
}

// ── Parse a server-rendered ATS job page (no AI) ─────────────────────────────
const stripTags = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
// Single-line value (title, location): stop at the first closing tag.
function propValue(html, id) {
  const m = html.match(new RegExp('data-careersite-propertyid="' + id + '"[^>]*>([\\s\\S]*?)<\\/(?:div|span|p|h[1-6]|td)>', 'i'));
  return m ? stripTags(m[1]) : '';
}
// Full description block: from the description attr up to the NEXT careersite
// property / apply section (don't stop at nested <p>/<div>).
function descBlock(html) {
  const m = html.match(/data-careersite-propertyid="description"[^>]*>/i);
  if (!m) return '';
  const rest = html.slice(m.index + m[0].length);
  const endIdx = rest.search(/data-careersite-propertyid="|class="[^"]*(?:apply[-_]|jobApply|related[-_]?jobs|job[-_]?footer|social[-_]?share)/i);
  return rest.slice(0, endIdx > 200 ? endIdx : 15000);
}
const bullets = (h) => [...String(h).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripTags(m[1])).filter((s) => s.length > 2 && s.length < 300);
const REQ_HEADING = /(qualif|requirement|your profile|what you bring|we (?:expect|require|are looking)|education|experience required|skills|competenc|anforderung|profil|dein profil|das bringst du)/i;

// Many ATS (Breezy, Greenhouse, Lever, Workable…) embed a schema.org JobPosting in
// <script type="application/ld+json"> for SEO. Pull the first JobPosting out of it.
function extractJsonLdJobPosting(html) {
  const blocks = [...String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    try {
      const data = JSON.parse(b[1].trim());
      const arr = Array.isArray(data) ? data : (Array.isArray(data['@graph']) ? data['@graph'] : [data]);
      const jp = arr.find((x) => x && (x['@type'] === 'JobPosting' || (Array.isArray(x['@type']) && x['@type'].includes('JobPosting'))));
      if (jp) return jp;
    } catch { /* ignore malformed JSON-LD */ }
  }
  return null;
}
function jobLocationText(ld) {
  try {
    const loc = Array.isArray(ld.jobLocation) ? ld.jobLocation[0] : ld.jobLocation;
    const addr = (loc && (loc.address || loc)) || {};
    const country = addr.addressCountry && (addr.addressCountry.name || addr.addressCountry);
    return [addr.addressLocality, addr.addressRegion, country].filter(Boolean).join(', ');
  } catch { return ''; }
}

// ── Multilingual free-text field extraction (no AI) ───────────────────────────
// ATS detail pages often bury salary/experience/location in prose (and in the local
// language), where JSON-LD doesn't carry them. These pull them out structurally so the
// card is complete regardless of language.
const _CURR = '€|EUR|US\\$|USD|\\$|£|GBP|CHF|₹|INR|¥|JPY|kr|SEK|NOK|DKK|PLN|zł|Kč|Ft|lei|лв|₺|R\\$|A\\$|C\\$';
const _NUM = '\\d{1,3}(?:[.,\\u00A0\\s]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d+)?\\s?k\\b';
const _AMT = `(?:(?:${_CURR})\\s?(?:${_NUM})|(?:${_NUM})\\s?(?:${_CURR}))`;
const _RANGE_RE = new RegExp(`${_AMT}\\s?(?:–|—|-|\\bbis\\b|\\bto\\b|\\bau\\b)\\s?${_AMT}|${_AMT}`, 'i');
const _SAL_KW = /(salary|salaire|salario|stipendio|gehalt|verg[uü]tung|brutto|netto|jahresgehalt|monatsgehalt|\blohn\b|lön|palk|compensation|\bpay\b|\bwage\b|sueldo|zarobki|pensja|honorar|remunerat|retribuzione)/i;

function _tidyAmt(amt, ctx = '') {
    let out = amt.replace(/\s+/g, ' ').trim().replace(/[\s.,–—-]+$/, '');
    if (/monat|month|mensu|mese|maand|miesi/i.test(ctx) && !/month|monat/i.test(out)) out += '/month';
    else if (/jahr|annum|annual|\byear\b|p\.?a\.?|année|anno|rok/i.test(ctx) && !/year|jahr/i.test(out)) out += '/year';
    return out;
}
function salaryFromText(text) {
    if (!text) return '';
    const t = String(text);
    const kw = t.match(_SAL_KW);                       // 1) amount in a salary-keyword window (best)
    if (kw) {
        const win = t.slice(Math.max(0, kw.index - 40), kw.index + 170);
        const m = win.match(_RANGE_RE);
        if (m) return _tidyAmt(m[0], win);
    }
    const m = t.match(_RANGE_RE);                       // 2) any currency amount ≥ 1000 (NUM requires a thousands group)
    return m ? _tidyAmt(m[0], t.slice(Math.max(0, m.index - 30), m.index + 60)) : '';
}
function experienceFromText(text) {
    if (!text) return '';
    const around = String(text).match(/[^.\n]{0,70}(?:erfahrung|berufserfahrung|experience|expérience|esperienza|experiencia|doświadczenie)[^.\n]{0,70}/i);
    const scope = around ? around[0] : String(text);
    const m = scope.match(/(\d{1,2})\s*\+?\s*(?:Jahre?n?|years?|ans?|años?|anni|lat)\b/i);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
    if (/mehrj[äa]hrige|langj[äa]hrige|several years|extensive experience/i.test(text)) return 'Several years';
    return '';
}
const _TYPE_RE = /\b(Vollzeit|Teilzeit|Full[\s-]?time|Part[\s-]?time|Festanstellung|Praktikum|Internship|Werkstudent|Lehre|Apprentice(?:ship)?|Contract|Befristet|Unbefristet|Freelance|Temps plein|Temps partiel|Tiempo completo)\b/i;
function jobTypeFromText(text) {
    const m = String(text || '').match(_TYPE_RE); if (!m) return '';
    const v = m[1].toLowerCase();
    if (/vollzeit|full|temps plein|tiempo completo|festanstellung|unbefristet/.test(v)) return 'Full-time';
    if (/teilzeit|part|temps partiel/.test(v)) return 'Part-time';
    if (/praktikum|internship|werkstudent/.test(v)) return 'Internship';
    if (/lehre|apprentice/.test(v)) return 'Apprenticeship';
    if (/contract|befristet|freelance/.test(v)) return 'Contract';
    return m[1];
}
const _LOC_LABEL = /(?:Einsatzort|Standort|Dienstort|Arbeitsort|Job\s?Location|Location|Lieu|Ubicaci[oó]n|Sede|Lokalizacja|Werkort)\s*[:\-–]\s*([A-Za-zÀ-ɏ][^\n,;|]{1,50})/i;
// After stripping tags, the next field label often runs into the value — cut at it.
const _LOC_STOP = /\s+(?:Abteilung|Department|Bereich|Standort|Dienstort|Stelle|Position|Vollzeit|Teilzeit|Deine|Ihre|Your|Aufgaben|Profil|Tasks|Responsibilities|Requirements|Job|Req|Datum|Date|Start|Eintritt|Gesellschaft|Company)\b/i;
function locationFromText(text) {
    const m = String(text || '').match(_LOC_LABEL);
    if (!m) return '';
    let v = m[1].replace(/\s+/g, ' ').trim();
    v = v.split(_LOC_STOP)[0].trim();           // stop at the next field label
    if (v.length > 40) v = v.split(/\s{2,}|,| - /)[0].trim();
    return v.replace(/[\s:–-]+$/, '');
}

function parseAtsJobPage(html, url, recipe = null) {
  const ld = extractJsonLdJobPosting(html);
  const title = propValue(html, 'title') || (ld && ld.title ? stripTags(ld.title) : '') || titleFromUrl(url);
  let location = propValue(html, 'location') || (ld ? jobLocationText(ld) : '');
  // Prefer the SuccessFactors description block; fall back to the JSON-LD description
  // (which is itself HTML) so Breezy & co. yield real bullets/skills, not the listing text.
  const descHtml = descBlock(html) || (ld && ld.description ? String(ld.description) : '');
  const description = stripTags(descHtml).slice(0, 5000);

  // Split bullets into responsibilities (before a requirements heading) and
  // skills (after it). If no heading, treat all bullets as responsibilities.
  const reqIdx = descHtml.search(REQ_HEADING);
  let responsibilities, skills;
  if (reqIdx > 0) {
    responsibilities = bullets(descHtml.slice(0, reqIdx)).slice(0, 8);
    skills = bullets(descHtml.slice(reqIdx)).slice(0, 10);
  } else {
    responsibilities = bullets(descHtml).slice(0, 8);
    skills = [];
  }

  let job_type = '';
  const et = html.match(/"employmentType"\s*:\s*"([^"]+)"/i); if (et) job_type = et[1].replace(/_/g, ' ');
  let salary = '';
  const sal = html.match(/"baseSalary"[\s\S]{0,260}?"minValue"\s*:\s*"?([\d.]+)"?[\s\S]{0,120}?"maxValue"\s*:\s*"?([\d.]+)/i);
  if (sal) salary = `${sal[1]} - ${sal[2]}`;
  let employer_name = '';
  const site = html.match(/<meta[^>]+(?:property|name)="(?:og:site_name|application-name)"[^>]+content="([^"]+)"/i)
            || html.match(/"hiringOrganization"[\s\S]{0,200}?"name"\s*:\s*"([^"]+)"/i);
  if (site) employer_name = site[1].trim();

  // ── Multilingual free-text fallbacks for fields the structured data missed ──
  // (e.g. salary stated in prose like "Bruttojahresgehalt von mind. EUR 62.790").
  if (!salary)   salary   = salaryFromText(description);
  if (!job_type) job_type = jobTypeFromText(description);
  // The location label ("Einsatzort: …") often sits ABOVE the description block, so
  // scan the whole page text (top portion) when the structured fields came up empty.
  if (!location) location = locationFromText(description) || locationFromText(stripTags(html).slice(0, 6000));
  const experience = experienceFromText(description);

  const parsed = {
    title, location, description, skills, responsibilities, experience,
    job_type: job_type || 'Full-time', salary: salary || '', employer_name,
    job_url: url, urgent: false, _atsParsed: true,
  };
  // Apply a learned per-employer recipe (additive — only fills what's still empty).
  if (recipe) { try { return mergeDetail(parsed, applyDetailRecipe(html, recipe)); } catch { return parsed; } }
  return parsed;
}

// ── Learned detail-extraction RECIPE (applied deterministically, no AI) ────────
// A recipe maps each weak field to a strategy + params the agent discovered from a
// sample page. We apply it to EVERY job of that employer to fill fields the generic
// parser missed. Always additive: only fills empty fields, never overwrites good data.
const _LIST_FIELDS = new Set(['responsibilities', 'skills']);
const _SCALAR_EXTRACT = { salary: salaryFromText, experience: experienceFromText, job_type: jobTypeFromText, location: locationFromText };
const _escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function _bulletsUnderHeading(html, heading) {
  const idx = String(html).search(new RegExp(_escRe(heading), 'i'));
  if (idx < 0) return [];
  const after = html.slice(idx + heading.length);
  const nextH = after.search(/<h[1-6][^>]*>|data-careersite-propertyid="/i);
  return bullets(after.slice(0, nextH > 50 ? nextH : 4000)).slice(0, 12);
}
function _labelValue(text, label) {
  const lab = String(label).replace(/[\s:\-–]+$/, '');   // tolerate an AI-supplied trailing colon
  const m = String(text).match(new RegExp(_escRe(lab) + '\\s*[:\\-–]\\s*([A-Za-zÀ-ɏ0-9][^\\n,;|]{1,60})', 'i'));
  if (!m) return '';
  let v = m[1].replace(/\s+/g, ' ').trim().split(_LOC_STOP)[0].trim();   // cut at the next run-on field label
  if (v.length > 40) v = v.split(/\s{2,}|,| - /)[0].trim();
  return v.replace(/[\s:–-]+$/, '');
}
function _sectionText(html, heading) {
  const idx = String(html).search(new RegExp(_escRe(heading), 'i'));
  if (idx < 0) return '';
  const after = html.slice(idx);
  const nextH = after.slice(heading.length).search(/<h[1-6][^>]*>/i);
  return stripTags(after.slice(0, nextH > 50 ? nextH + heading.length : 4000));
}

function applyDetailRecipe(html, recipe) {
  if (!html || !recipe || typeof recipe !== 'object') return {};
  const out = {};
  let $ = null; if (cheerio) { try { $ = cheerio.load(html); } catch {} }
  const fullText = stripTags(html);
  for (const field of ['salary', 'experience', 'location', 'job_type', 'responsibilities', 'skills']) {
    const r = recipe[field];
    if (!r || !r.method) continue;
    try {
      if (r.method === 'selector' && r.selector && $) {
        if (_LIST_FIELDS.has(field)) {
          const items = $(r.selector).map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter((s) => s.length > 2 && s.length < 400);
          if (items.length) out[field] = items.slice(0, 12);
        } else {
          const v = $(r.selector).first().text().replace(/\s+/g, ' ').trim();
          if (v) out[field] = _SCALAR_EXTRACT[field] && /salary|experience|job_type/.test(field) ? (_SCALAR_EXTRACT[field](v) || v) : v;
        }
      } else if (r.method === 'heading' && r.heading) {
        const items = _bulletsUnderHeading(html, r.heading);
        if (items.length) out[field] = items;
      } else if (r.method === 'label' && r.label) {
        const v = _labelValue(fullText, r.label);
        if (v) out[field] = v;
      } else if (r.method === 'section' && r.heading) {
        const fn = _SCALAR_EXTRACT[field]; if (fn) { const v = fn(_sectionText(html, r.heading) || fullText); if (v) out[field] = v; }
      } else if (r.method === 'regex') {
        const fn = _SCALAR_EXTRACT[field]; if (fn) { const v = fn(fullText); if (v) out[field] = v; }
      }
    } catch { /* a bad strategy never breaks extraction */ }
  }
  return out;
}

// Merge recipe-extracted fields into a parsed job — ADDITIVE (only fill what's empty).
function mergeDetail(parsed, extra) {
  if (!extra) return parsed;
  for (const f of ['salary', 'experience', 'location', 'job_type']) {
    if (!parsed[f] && extra[f]) parsed[f] = extra[f];
  }
  for (const f of ['responsibilities', 'skills']) {
    if ((!parsed[f] || !parsed[f].length) && Array.isArray(extra[f]) && extra[f].length) parsed[f] = extra[f];
  }
  return parsed;
}

// Which required fields are SYSTEMATICALLY missing across a set of parsed jobs.
// (Used on 1-2 samples to decide whether to learn a recipe.)
function assessDetailQuality(jobs) {
  const list = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  const n = list.length || 1;
  const checks = {
    salary: (j) => !j.salary,
    responsibilities: (j) => !(j.responsibilities || []).length,
    skills: (j) => !(j.skills || []).length,
    location: (j) => !j.location,
  };
  const missingFields = [];
  const coverage = {};
  for (const [field, isEmpty] of Object.entries(checks)) {
    const missRatio = list.filter(isEmpty).length / n;
    coverage[field] = Math.round((1 - missRatio) * 100);
    if (missRatio >= 0.6) missingFields.push(field);
  }
  return { missingFields, coverage };
}

async function fetchJobPage(url) { return fetchText(url); }

module.exports = {
  discoverSitemapJobUrls, parseAtsJobPage, fetchJobPage,
  salaryFromText, experienceFromText, jobTypeFromText, locationFromText,
  applyDetailRecipe, mergeDetail, assessDetailQuality,
};
