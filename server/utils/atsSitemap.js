// ATS sitemap fallback — new, self-contained, additive.
//
// Enterprise career portals (SAP SuccessFactors, Workday, etc.) render their
// SEARCH page in JavaScript, so a normal HTML scrape finds 0 job links. BUT they
// expose every job in {host}/sitemap.xml as a server-rendered detail page (for
// Google indexing). This module discovers those job URLs from the sitemap so the
// existing Phase-2 pipeline can scrape + extract them. Deterministic, no AI.
//
// Only used as a fallback when the normal discovery finds nothing — see
// aiHubController.processJobSearch. Changes no prompts.
'use strict';

const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (compatible; CVApplyrBot/1.0; +https://cvapplyr.com)';
const FETCH_TIMEOUT = 12000;

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('too many redirects'));
    let lib, parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': UA, Accept: 'application/xml,text/html,*/*' }, timeout: FETCH_TIMEOUT }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        const next = r.headers.location.startsWith('http') ? r.headers.location : new URL(r.headers.location, url).href;
        return resolve(fetchText(next, redirects + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let d = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { d += c; if (d.length > 8_000_000) { req.destroy(); } });
      r.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

// Derive a readable placeholder title from a SuccessFactors-style job URL.
// (Phase-2 extraction overrides this with the clean title from the page.)
function titleFromUrl(url) {
  try {
    const m = url.match(/\/job\/([^/]+)\/\d+\/?$/i) || url.match(/\/job\/([^/?#]+)/i);
    if (!m) return 'Role';
    const slug = decodeURIComponent(m[1]).replace(/[+_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return slug.slice(0, 120) || 'Role';
  } catch { return 'Role'; }
}

// Best-effort registrable domain (handles a few common 2-part public suffixes).
function rootDomain(host) {
  const clean = String(host || '').replace(/^www\./i, '').toLowerCase();
  const parts = clean.split('.');
  if (parts.length <= 2) return clean;
  const twoPart = new Set(['co.uk', 'com.au', 'co.in', 'co.jp', 'com.br', 'co.nz', 'com.sg', 'com.mx']);
  const last2 = parts.slice(-2).join('.');
  return twoPart.has(last2) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}

// Candidate hosts to probe for a sitemap, in priority order.
function candidateHosts(scrapeUrl, domain) {
  const hosts = [];
  const add = (h) => { if (h && !hosts.includes(h)) hosts.push(h); };
  let entryHost = '';
  try { entryHost = new URL(scrapeUrl).host.toLowerCase(); } catch {}
  add(entryHost);
  const root = rootDomain(domain || entryHost);
  if (root) { add('jobs.' + root); add('careers.' + root); add('career.' + root); add('jobs.' + root.replace(/\.[^.]+$/, '') + '.com'); add(root); add('www.' + root); }
  return hosts.filter(Boolean);
}

const locRe = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi;
function extractLocs(xml) { return [...xml.matchAll(locRe)].map((m) => m[1]); }
const isJobUrl = (u) => /\/job\//i.test(u);

async function jobUrlsForHost(host, limit) {
  let xml;
  try { xml = await fetchText(`https://${host}/sitemap.xml`); } catch { return []; }
  if (!/<(urlset|sitemapindex)/i.test(xml)) return [];
  const locs = extractLocs(xml);
  let jobUrls = locs.filter(isJobUrl);
  // sitemap index → walk a few nested sitemaps to find job URLs
  if (jobUrls.length === 0 && /<sitemapindex/i.test(xml)) {
    const nested = locs.filter((u) => /\.xml(\.gz)?(\?|$)/i.test(u)).slice(0, 10);
    for (const sm of nested) {
      try {
        const nx = await fetchText(sm);
        jobUrls.push(...extractLocs(nx).filter(isJobUrl));
      } catch {}
      if (jobUrls.length >= limit) break;
    }
  }
  // de-dup, keep order
  const seen = new Set();
  return jobUrls.filter((u) => (seen.has(u) ? false : (seen.add(u), true))).slice(0, limit);
}

/**
 * Discover job listing URLs from a company's ATS sitemap.
 * @param {string} scrapeUrl  The URL we tried to scrape (entry point).
 * @param {string} domain     The registrable domain (from extractDomain()).
 * @param {number} limit      Max job URLs to return.
 * @returns {Promise<Array<{title:string, job_url:string}>>}  Empty if no sitemap/jobs.
 */
async function discoverSitemapJobUrls(scrapeUrl, domain, limit = 30) {
  for (const host of candidateHosts(scrapeUrl, domain)) {
    let urls = [];
    try { urls = await jobUrlsForHost(host, limit); } catch {}
    if (urls.length) {
      return urls.map((u) => ({ title: titleFromUrl(u), job_url: u }));
    }
  }
  return [];
}

module.exports = { discoverSitemapJobUrls };
