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
    const m = url.match(/\/job\/([^/]+)\/\d+\/?$/i) || url.match(/\/job\/([^/?#]+)/i);
    if (!m) return 'Role';
    const slug = decodeURIComponent(m[1]).replace(/[+_-]+/g, ' ').replace(/\s+/g, ' ').trim();
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
// Job-detail URL patterns across common ATS vendors.
const isJobUrl = (u) => /\/(job|jobs|career|careers|position|opening|vacancy|stelle)\/[^/]+\/\d|\/job\/|\/jobs\/[a-z0-9-]{6,}/i.test(u);

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
 * @returns {Promise<Array<{title:string, job_url:string}>>}
 */
async function discoverSitemapJobUrls(scrapeUrl, domain, limit = 200) {
  for (const host of candidateHosts(scrapeUrl, domain)) {
    let urls = [];
    try { urls = await jobUrlsForHost(host, limit); } catch {}
    if (urls.length) return urls.map((u) => ({ title: titleFromUrl(u), job_url: u }));
  }
  return [];
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

function parseAtsJobPage(html, url) {
  const title = propValue(html, 'title') || titleFromUrl(url);
  const location = propValue(html, 'location');
  const descHtml = descBlock(html);
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

  return {
    title, location, description, skills, responsibilities,
    job_type: job_type || 'Full-time', salary: salary || '', employer_name,
    job_url: url, urgent: false, _atsParsed: true,
  };
}

async function fetchJobPage(url) { return fetchText(url); }

module.exports = { discoverSitemapJobUrls, parseAtsJobPage, fetchJobPage };
