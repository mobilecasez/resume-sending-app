// AI Hub — new feature. Safe to delete without affecting existing app.

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dbConfig = require('../../db-config');
const jobService = require('../services/jobService');
const {
    optimizeHtmlForAI,
    extractCompanyInfoFromHtml,
} = require('../utils/domOptimizer');
const { smartScrape, stripHtmlToText } = require('../utils/playwrightScraper');
const { discoverSitemapJobUrls, parseAtsJobPage, fetchJobPage, assessDetailQuality } = require('../utils/atsSitemap');
const { detectAndFetchAts } = require('../utils/atsDiscovery');
const employerFix = require('../services/employerFix');
const detailRecipeStore = require('../services/detailRecipe');
const aiJobExtractor = require('../services/aiJobExtractor');
const { applyOverride, investigate: investigateEmployer, learnDetailRecipe, validateExtraction } = require('../services/employerDiagnosticAgent');
const { getEventCost, chargeCredits } = require('../services/eventCosts');

// ─── Batch tuning ─────────────────────────────────────────────────────────────
// How many job-detail pages to scrape + process per Gemini call
const DETAIL_BATCH_SIZE = 5;
// How many batches to run concurrently
const BATCH_CONCURRENCY = 2;
// Re-use employer data from DB if scraped within this many hours by any user
const CACHE_TTL_HOURS   = 24;
// Max job links to collect from a portal (pagination-aware)
const MAX_JOB_LINKS     = 80;
// Max jobs to pull from an ATS sitemap when normal discovery found nothing.
// ATS pages are server-rendered, so these are fetched+parsed directly (no
// Playwright/AI) — we can afford the full listing, not a small sample.
const ATS_FALLBACK_LIMIT = 200;
// Best-200 ranking: we DISPLAY at most STORE_LIMIT jobs per user, but when an employer
// has more, we CONSIDER up to CONSIDER_LIMIT (fetch + match-score them) so the kept set
// is the best-matching STORE_LIMIT — not just the first ones discovered.
const STORE_LIMIT       = 200;
const CONSIDER_LIMIT    = 700;
// Max pagination pages to follow per listing URL
const MAX_PAGES         = 12;

// ─── Colour helpers ───────────────────────────────────────────────────────────

const LOGO_COLORS = [
    ['#06B6D4', '#3B82F6'],
    ['#8B5CF6', '#6D28D9'],
    ['#10B981', '#059669'],
    ['#F59E0B', '#D97706'],
    ['#EF4444', '#DC2626'],
    ['#635BFF', '#4338CA'],
    ['#EC4899', '#DB2777'],
];

const AVATAR_COLORS = [
    ['#06B6D4', '#3B82F6'],
    ['#8B5CF6', '#6D28D9'],
    ['#10B981', '#059669'],
    ['#F59E0B', '#D97706'],
    ['#EF4444', '#DC2626'],
];

function logoColorFor(name) {
    return LOGO_COLORS[(name.charCodeAt(0) || 0) % LOGO_COLORS.length];
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────

function safeParseJSON(val, fallback) {
    if (!val) return fallback;
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch { return fallback; }
}

const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml',
};

function extractDomain(input) {
    try {
        if (input && (input.startsWith('http://') || input.startsWith('https://'))) {
            return new URL(input).hostname.replace(/^www\./, '');
        }
    } catch {}
    // Normalise company name → slug
    return (input || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}

// ─── Scraper ──────────────────────────────────────────────────────────────────

/**
 * Decode Cloudflare email obfuscation.
 * CF encodes emails as hex with a XOR key in data-cfemail attribute.
 */
function decodeCfEmail(encoded) {
    try {
        const bytes = encoded.match(/.{2}/g).map(h => parseInt(h, 16));
        const key = bytes[0];
        return bytes.slice(1).map(b => String.fromCharCode(b ^ key)).join('');
    } catch { return null; }
}

/**
 * Extract a compact HTML snippet containing recruiter/contact sections.
 * Used to give AI the raw HTML structure (including img src, LinkedIn hrefs)
 * without flooding the prompt with the full page.
 * Returns a string of up to 3000 chars of relevant raw HTML.
 */
function extractContactHtmlSnippet(html) {
    if (!html) return '';
    const $ = cheerio.load(html);
    const snippets = [];
    const seen = new Set();

    // Priority 1: elements with recruiter/contact-specific class names
    $('[class*="recruiter"], [class*="contact-person"], [class*="contactperson"], [class*="recruiterCard"], [class*="hiring-contact"], [class*="sidebar-contact"], [class*="job-contact"]').each((_, el) => {
        const outerHtml = $.html(el);
        const text = $(el).text().trim();
        if (text.length > 15 && !seen.has(text.slice(0, 40))) {
            seen.add(text.slice(0, 40));
            snippets.push(outerHtml.slice(0, 1200));
        }
    });

    // Priority 2: sections/divs that contain recruiter keywords + email/phone links
    if (snippets.length === 0) {
        const KEYWORDS = /recruiter|hiring manager|contact person|your contact|ansprechpartner|contactpersoon|responsable|encargado/i;
        $('section, div, aside').each((_, el) => {
            const text = $(el).text();
            if (!KEYWORDS.test(text) || text.length > 2000) return;
            const hasContactLink = $(el).find('a[href^="mailto:"], a[href^="tel:"], a[href*="linkedin.com"]').length > 0;
            if (!hasContactLink) return;
            const key = text.slice(0, 40);
            if (seen.has(key)) return;
            seen.add(key);
            snippets.push($.html(el).slice(0, 1000));
        });
    }

    // Priority 3: any mailto/tel/linkedin links with their parent context
    if (snippets.length === 0) {
        $('a[href^="mailto:"], a[href^="tel:"], a[href*="linkedin.com/in/"]').each((_, el) => {
            const parent = $(el).closest('div, section, li, p');
            const outerHtml = $.html(parent.length ? parent : el);
            const key = outerHtml.slice(0, 40);
            if (!seen.has(key)) {
                seen.add(key);
                snippets.push(outerHtml.slice(0, 600));
            }
        });
    }

    return snippets.slice(0, 4).join('\n\n').slice(0, 3000);
}

/**
 * @deprecated — kept for reference only. AI extraction via Gemini is now used instead.
 * Extract recruiter / hiring contacts directly from raw HTML using Cheerio.
 */
function extractContactsFromHtml(html, pageUrl) {
    if (!html) return [];
    const $ = cheerio.load(html);
    const contacts = [];
    const seen = new Set();

    // ── Pattern 1: Named contact-person blocks (Eneco, many ATS) ─────────────
    $('[class*="contact-person"], [class*="contactperson"], [class*="recruiter-card"], [class*="recruiterCard"], [class*="hiring-contact"]').each((_, el) => {
        const firstName = $(el).find('[class*="first-name"], [class*="firstName"]').text().trim();
        const lastName  = $(el).find('[class*="last-name"],  [class*="lastName"]').text().trim();
        const name = `${firstName} ${lastName}`.trim();
        if (!name || name.length < 3) return;

        const phone = (() => {
            const href = $(el).find('a[href^="tel:"]').attr('href') || '';
            return href.replace('tel:', '') || null;
        })();

        const email = (() => {
            // Direct mailto
            const m = $(el).find('a[href^="mailto:"]').attr('href');
            if (m) return m.replace('mailto:', '').split('?')[0];
            // Cloudflare obfuscation — data-cfemail attribute
            const cf = $(el).find('[data-cfemail]').attr('data-cfemail');
            if (cf) return decodeCfEmail(cf);
            // Cloudflare obfuscation — href="/cdn-cgi/l/email-protection#HEX"
            // Iterate all CF-protected links; skip share/non-email decoded values
            let cfEmail = null;
            $(el).find('a[href*="email-protection"]').each((_, cfEl) => {
                if (cfEmail) return;
                const cfHref = $(cfEl).attr('href') || '';
                const cfMatch = cfHref.match(/email-protection#([0-9a-f]+)/i);
                if (cfMatch) {
                    const decoded = decodeCfEmail(cfMatch[1]);
                    if (decoded && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(decoded)) cfEmail = decoded;
                }
            });
            if (cfEmail) return cfEmail.toLowerCase();
            // Email in visible text
            const text = $(el).text();
            const match = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
            return match ? match[0] : null;
        })();

        const role = (() => {
            const text = $(el).text().toLowerCase();
            if (text.includes('hiring manager')) return 'Hiring Manager';
            if (text.includes('recruiter'))      return 'Recruiter';
            if (text.includes('hr'))             return 'HR';
            return 'Recruiter';
        })();

        const key = name.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            contacts.push({ name, role, email: email || null, phone: phone || null });
        }
    });

    // ── Pattern 2: Greenhouse / Lever / Workday style ─────────────────────────
    // Look for sections with recruiter keywords near a name + email/phone
    if (contacts.length === 0) {
        const keywords = /recruiter|hiring manager|contact person|your contact|ansprechpartner|contactpersoon/i;
        $('section, div, aside, p').each((_, el) => {
            const text = $(el).text();
            if (!keywords.test(text)) return;
            if (text.length > 1200) return; // Too large — skip sections/divs containing the whole page

            // Phone
            const phone = (() => {
                const tel = $(el).find('a[href^="tel:"]').attr('href');
                if (tel) return tel.replace('tel:', '');
                const m = text.match(/\+?[\d\s().-]{9,20}/);
                return m ? m[0].trim() : null;
            })();

            // Email
            const email = (() => {
                const m = $(el).find('a[href^="mailto:"]').attr('href');
                if (m) return m.replace('mailto:', '').split('?')[0];
                const cf = $(el).find('[data-cfemail]').attr('data-cfemail');
                if (cf) return decodeCfEmail(cf);
                let cfEmail2 = null;
                $(el).find('a[href*="email-protection"]').each((_, cfEl) => {
                    if (cfEmail2) return;
                    const cfHref2 = $(cfEl).attr('href') || '';
                    const cfMatch2 = cfHref2.match(/email-protection#([0-9a-f]+)/i);
                    if (cfMatch2) {
                        const decoded2 = decodeCfEmail(cfMatch2[1]);
                        if (decoded2 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(decoded2)) cfEmail2 = decoded2;
                    }
                });
                if (cfEmail2) return cfEmail2.toLowerCase();
                const textMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
                return textMatch ? textMatch[0] : null;
            })();

            if (!email && !phone) return;

            // Guess name — look for a heading/strong near the contact section
            const name = $(el).find('h2, h3, h4, strong, b').first().text().trim()
                .replace(/questions?.*|contact.*|recruiter.*|hiring.*/i, '').trim();

            if (name && name.length > 2 && name.length < 60) {
                const key = name.toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    contacts.push({ name, role: 'Recruiter', email: email || null, phone: phone || null });
                }
            } else if (email || phone) {
                // No clean name — still add partial contact
                const fallback = email?.split('@')[0] || phone || 'Recruiter';
                if (!seen.has(fallback)) {
                    seen.add(fallback);
                    contacts.push({ name: fallback, role: 'Recruiter', email: email || null, phone: phone || null });
                }
            }
        });
    }

    // ── Pattern 3: All-page mailto + tel harvest ──────────────────────────────
    // If still nothing, grab any mailto/tel links on the page as last resort
    if (contacts.length === 0) {
        $('a[href^="mailto:"]').each((_, el) => {
            const email = $(el).attr('href').replace('mailto:', '').split('?')[0];
            if (!email || email.includes('{') || seen.has(email)) return;
            seen.add(email);
            contacts.push({ name: email.split('@')[0], role: 'Contact', email, phone: null });
        });
    }

    // Final dedup pass — if multiple contacts share the same email, keep only the first
    const seenEmails = new Set();
    return contacts.filter(c => {
        if (!c.email) return true; // keep email-less contacts (phone only)
        const key = c.email.toLowerCase().trim();
        if (seenEmails.has(key)) return false;
        seenEmails.add(key);
        return true;
    });
}

/** Normalise hostname for same-domain comparisons (strip www.) */
function sameDomain(urlA, urlB) {
    try {
        return new URL(urlA).hostname.replace(/^www\./, '') === new URL(urlB).hostname.replace(/^www\./, '');
    } catch { return false; }
}

async function scrapePage(url, origin, usePuppeteer = false) {
    try {
        let html = '';
        let finalUrl = url;

        if (usePuppeteer) {
            // Use Playwright instead of Puppeteer for listing pages too
            const { chromium } = require('playwright');
            const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
            const context = await browser.newContext({ userAgent: HTTP_HEADERS['User-Agent'] });
            const page    = await context.newPage();
            await page.goto(url, { waitUntil: 'networkidle', timeout: 28000 });
            await page.waitForTimeout(2000); // extra wait for React/Vue SPAs
            finalUrl = page.url();
            html = await page.content();
            await browser.close();
        } else {
            const resp = await axios.get(url, {
                timeout: 12000, maxContentLength: 2 * 1024 * 1024, headers: HTTP_HEADERS,
            });
            html = resp.data;
            // Capture post-redirect URL (handles www. redirect etc.)
            finalUrl = resp.request?.res?.responseUrl || resp.config?.url || url;
        }

        const $ = cheerio.load(html);
        const seen = new Set();
        const links = [];

        // Well-known ATS / job-board domains — portals often link to these
        const ATS_DOMAINS = new Set([
            'greenhouse.io', 'lever.co', 'workday.com', 'smartrecruiters.com',
            'icims.com', 'taleo.net', 'successfactors.com', 'brassring.com',
            'myworkdayjobs.com', 'ultipro.com', 'jobvite.com', 'bamboohr.com',
            'recruitee.com', 'personio.com', 'rexx-systems.com', 'prescreen.io',
            'erecruiter.net', 'softgarden.de', 'stepstone.de', 'totaljobs.com',
        ]);

        $('a[href]').each((_, el) => {
            try {
                const href = $(el).attr('href') || '';
                if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
                const full = href.startsWith('http') ? href : new URL(href, finalUrl).href;
                const fullHost = (() => { try { return new URL(full).hostname.replace(/^www\./, ''); } catch { return ''; } })();
                // Accept same-domain links OR known ATS external links
                const isSameDomain = sameDomain(full, origin);
                const isKnownAts   = ATS_DOMAINS.has(fullHost) || [...ATS_DOMAINS].some(d => fullHost.endsWith('.' + d));
                if ((!isSameDomain && !isKnownAts) || seen.has(full)) return;
                seen.add(full);
                const text = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 120);
                links.push({ url: full, text });
            } catch { /* malformed href */ }
        });

        const rawHtml = html; // Keep raw HTML for contact extraction

        // Optimized markdown — replaces raw text dump, 10–30× fewer tokens for Gemini
        const { markdown, dataScripts, structuredData } = optimizeHtmlForAI(html);

        // Also keep a plain text fallback (used for listing-page heuristics only)
        $('script, style, nav, footer, header, noscript, iframe').remove();
        const pageText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 4000);

        return { pageText, markdown, dataScripts, structuredData, links, rawHtml };
    } catch {
        return { pageText: '', markdown: '', dataScripts: '', structuredData: [], links: [], rawHtml: '' };
    }
}

/**
 * Extract pagination / "next page" URLs from a scraped page.
 * Handles: rel="next", ?page=N, ?start=N, ?offset=N, ?p=N, page/N paths.
 */
function extractPaginationUrls(links, currentUrl, origin) {
    const nextUrls = new Set();
    const curU = (() => { try { return new URL(currentUrl); } catch { return null; } })();
    if (!curU) return [];

    const curPage = parseInt(curU.searchParams.get('page') || curU.searchParams.get('p') || '1', 10) || 1;
    const curStart = parseInt(curU.searchParams.get('start') || curU.searchParams.get('offset') || '0', 10) || 0;

    // Follow rel="next" links or explicit "next page" / "page N" link text
    for (const l of links) {
        if (!sameDomain(l.url, origin)) continue;
        const text = (l.text || '').toLowerCase().trim();
        // rel-next style or explicit "next"/">" text or "Page N"
        if (/^(next|›|»|>|\d+)$/.test(text) || /next[\s\-_]?page|volgende|weiter|suivant/i.test(text)) {
            nextUrls.add(l.url);
        }
        // Detect ?page=N+1 style links (any page > curPage)
        try {
            const lu = new URL(l.url);
            const lPage = parseInt(lu.searchParams.get('page') || lu.searchParams.get('p') || '0', 10);
            if (lPage > curPage) nextUrls.add(l.url);
            const lStart = parseInt(lu.searchParams.get('start') || lu.searchParams.get('offset') || '-1', 10);
            if (lStart > curStart && lStart >= 0) nextUrls.add(l.url);
        } catch {}
    }

    // If nothing found from links, synthesize page=curPage+1 / start=curStart+25
    if (nextUrls.size === 0) {
        const synthU = new URL(currentUrl);
        if (synthU.searchParams.has('page'))   synthU.searchParams.set('page',   String(curPage + 1));
        else if (synthU.searchParams.has('p')) synthU.searchParams.set('p',      String(curPage + 1));
        else if (synthU.searchParams.has('start'))  synthU.searchParams.set('start',  String(curStart + 25));
        else if (synthU.searchParams.has('offset')) synthU.searchParams.set('offset', String(curStart + 25));
        else synthU.searchParams.set('page', '2'); // guess
        nextUrls.add(synthU.href);
    }

    return [...nextUrls].slice(0, 3); // Don't branch too wide
}

/**
 * Scrape a job listing URL and follow pagination until we have enough job links
 * or exhaust pagination (MAX_PAGES pages).
 * Returns all unique job links found across all pages.
 */
/** Strip pagination query params (page, p, start, offset) from a URL string for dedup purposes. */
function normalizeJobUrl(url) {
    try {
        const u = new URL(url);
        u.searchParams.delete('page');
        u.searchParams.delete('p');
        u.searchParams.delete('start');
        u.searchParams.delete('offset');
        return u.href;
    } catch { return url; }
}

async function scrapeWithPagination(listingUrl, origin, usePuppeteer = false) {
    const seenNormalized = new Set(); // keyed by URL with pagination params stripped
    const allJobLinks = [];
    const seenPages  = new Set([listingUrl]);
    let   currentUrl = listingUrl;

    for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
        if (allJobLinks.length >= MAX_JOB_LINKS) break;

        let page;
        try {
            page = await scrapePage(currentUrl, origin, usePuppeteer);
        } catch { break; }

        const newJobLinks = page.links.filter(l => {
            if (!looksLikeJobDetailUrl(l.url, listingUrl)) return false;
            const norm = normalizeJobUrl(l.url);
            if (seenNormalized.has(norm)) return false;
            seenNormalized.add(norm);
            return true;
        });
        // Store the canonical (normalized) URL, not the paginated variant
        newJobLinks.forEach(l => allJobLinks.push({ ...l, url: normalizeJobUrl(l.url) }));

        console.log(`[aiHub] Pagination page ${pageNum + 1} (${currentUrl}): +${newJobLinks.length} jobs (total ${allJobLinks.length})`);

        // Stop if this page had zero new job links (end of pagination)
        if (newJobLinks.length === 0) break;

        // Find next page URL — and refuse to follow a "next" that loops BACKWARD to the
        // same/earlier page (sliders & circular pagination wrap last→first; following that
        // re-fetches the same jobs forever).
        const curPageNum = (() => { try { const u = new URL(currentUrl); return parseInt(u.searchParams.get('page') || u.searchParams.get('p') || '1', 10) || 1; } catch { return 1; } })();
        const nextCandidates = extractPaginationUrls(page.links, currentUrl, origin)
            .filter(u => !seenPages.has(u))
            .filter(u => normalizeJobUrl(u) !== normalizeJobUrl(listingUrl))   // not back to page 1
            .filter(u => { try { const n = new URL(u); const np = parseInt(n.searchParams.get('page') || n.searchParams.get('p') || '0', 10); return !(np > 0 && np <= curPageNum); } catch { return true; } });
        if (nextCandidates.length === 0) break;

        // Pick the most likely next-page URL (prefer the one we synthetically built)
        currentUrl = nextCandidates[0];
        seenPages.add(currentUrl);
    }

    return allJobLinks;
}

/** Try to fetch job links from the site's sitemap.xml */
async function fetchJobLinksFromSitemap(baseUrl) {
    try {
        const origin = new URL(baseUrl).origin;
        const sitemapUrl = `${origin}/sitemap.xml`;
        const resp = await axios.get(sitemapUrl, { timeout: 10000, headers: HTTP_HEADERS });
        const $ = cheerio.load(resp.data, { xmlMode: true });
        const links = [];
        $('url loc').each((_, el) => {
            const loc = $(el).text().trim();
            if (loc && looksLikeJobDetailUrl(loc, baseUrl)) {
                links.push({ url: loc, text: '' });
            }
        });
        console.log(`[aiHub] Sitemap: found ${links.length} job URLs`);
        return links;
    } catch (e) {
        console.log(`[aiHub] No sitemap: ${e.message}`);
        return [];
    }
}

/**
 * Last-segment slugs that are clearly SECTION / INFO pages, not individual job postings.
 * These appear under /career/, /careers/, /jobs/ etc. on many employer sites.
 */
const SECTION_SLUG_RE = /^(culture|benefits|culture[\-_]benefits?|culture[\-_]and[\-_]benefits?|mission|principles?|mission[\-_]principles?|values?|academy|technician[\-_]academy|overview|how[\-_]to[\-_]join|before[\-_]you[\-_]join|team|about[\-_]us?|life[\-_]at|working[\-_]at|perks?|why[\-_]us|why[\-_]join|diversity|inclusion|dei|events?|gallery|faq|contact|apply|application|rewards|compensation|story|history|join[\-_]us|open[\-_]jobs?|open[\-_]positions?|all[\-_]jobs?|all[\-_]vacancies|all[\-_]openings?|vacancies|opportunities|explore|locations?|departments?|find[\-_]jobs?|search|results|filter|categories?|tags?|page|home|index|roles?|career|careers)$/i;

function looksLikeJobDetailUrl(url, listingUrl) {
    try {
        const u = new URL(url);
        const l = new URL(listingUrl);
        const path = u.pathname;
        const segments = path.split('/').filter(Boolean);
        const lastSeg = segments[segments.length - 1] || '';

        // Must be a different page than the listing root
        if (path === l.pathname) return false;
        if (path === '/' || path === '') return false;

        // Exclude obvious non-job pages regardless of path structure
        if (/\/(blog|news|about|cookie|privacy|sitemap|login|register|search|results|favorites|alert|glossary|test-page)/i.test(path)) return false;

        // Exclude content/article/media paths — these are NOT job listings
        // Common on Dutch/German/French/global employer sites
        if (/\/(artikel|artikelen|article|articles|kennis|nieuws|nieuwsberichten|klant[\-_]?case|klantcase|cases|insights?|resources?|stories|story|referenties|referentie|expertise|media|press|presse|actualites?|actualit[eé]|blog|podcast|video|webinar|events?|evenement|veranstaltung)/i.test(path)) return false;

        // Exclude known section / info slugs as the final path segment
        // e.g. /en/career/culture-benefits  or  /en/career/open-jobs
        if (SECTION_SLUG_RE.test(lastSeg)) return false;

        // ── Strong positive signals ──────────────────────────────────────────────

        // Explicit ATS path prefixes — MUST come before the numeric-ID check so we
        // only accept numeric IDs when the URL also has a job-related prefix.
        if (/\/(vacancies|vacancy|vacatur[ae]|jobb?|position|opening|requisition|posting|job[\-_]detail|werken[\-_]bij|stellenangebote|offre|emploi|jobtitle|apply|advert|wk)s?\/[^/]+/i.test(path)) return true;

        // Numeric ID ONLY valid when the path also contains a job-related ancestor segment.
        // This prevents article/blog URLs like /nl/artikel/234671/titel from matching.
        const JOB_ANCESTOR_RE = /\/(jobs?|careers?|vacancies|vacatur[ae]|openings?|positions?|jobb?|roles?|werk|wörk|emploi|stellenangebote)/i;
        if (/\/\d{4,}(?:[/?#]|$)/.test(path) && JOB_ANCESTOR_RE.test(path)) return true;

        // Known ATS domains — any path under these is likely a job detail
        if (/greenhouse\.io|lever\.co|myworkdayjobs\.com|smartrecruiters\.com|icims\.com|taleo\.net|jobvite\.com|bamboohr\.com|recruitee\.com|personio\.com|softgarden\.de/i.test(u.hostname)) return true;

        // Slug that ends with a numeric ID: /senior-engineer-12345
        if (/\/[a-z][a-z0-9-]+-\d{3,}(?:[/?#]|$)/i.test(path)) return true;

        // Deep path under a jobs/careers/openings section where the final segment
        // looks like a job title slug (multiple words, not a known section slug)
        // e.g. /careers/engineering/senior-software-engineer-berlin
        if (/\/(careers?|jobs?|openings?|positions?|vacancies|vacatur[ae])\/[^/]+\/[^/]+/i.test(path)) return true;

        return false;
    } catch { return false; }
}

async function fetchCareersPageData(url, { light = false } = {}) {
    try {
        const origin = new URL(url).origin;
        const { pathname } = new URL(url);
        const parentPath = pathname.replace(/\/[^/]*$/, '');

        // ── Sitemap first (most reliable, Opt-4 needs rawHtml too) ──────────────
        const sitemapLinks = await fetchJobLinksFromSitemap(url);
        if (sitemapLinks.length >= 3) {
            const pg = await scrapePage(url, origin, false).catch(() => ({ pageText: '', rawHtml: '' }));
            // Sitemaps often only list the first N jobs. Try paginating the careers page too.
            let finalLinks = sitemapLinks;
            if (sitemapLinks.length < MAX_JOB_LINKS) {
                try {
                    const paginated = await scrapeWithPagination(url, origin, false);
                    if (paginated.length > sitemapLinks.length) {
                        console.log(`[aiHub] Sitemap had ${sitemapLinks.length}, pagination found ${paginated.length}`);
                        finalLinks = paginated;
                    }
                } catch {}
            }
            return { pageText: pg.pageText, rawHtml: pg.rawHtml || '', jobLinks: finalLinks };
        }

        let primary = await scrapePage(url, origin, false);
        let jobDetailLinks = primary.links.filter(l => looksLikeJobDetailUrl(l.url, url));
        let neededBrowser = false;
        console.log(`[aiHub] Primary scrape: ${primary.links.length} links, ${jobDetailLinks.length} job-detail-like`);

        if (jobDetailLinks.length < 3 && !light) {
            console.log(`[aiHub] Few links — trying Playwright…`);
            try {
                const pupPrimary = await scrapePage(url, origin, true);
                const pupJobDetailLinks = pupPrimary.links.filter(l => looksLikeJobDetailUrl(l.url, url));
                console.log(`[aiHub] Playwright: ${pupPrimary.links.length} links, ${pupJobDetailLinks.length} job-detail-like`);
                if (pupJobDetailLinks.length > jobDetailLinks.length) {
                    primary = pupPrimary;
                    jobDetailLinks = pupJobDetailLinks;
                    neededBrowser = true; // site is a SPA — must use Playwright for pagination too
                }
            } catch (err) { console.log(`[aiHub] Playwright failed:`, err.message); }
        }

        if (jobDetailLinks.length >= 3) {
            // Try pagination to collect more jobs beyond page 1
            // IMPORTANT: use browser=true if the listing page needed Playwright (SPAs)
            if (jobDetailLinks.length < MAX_JOB_LINKS) {
                try {
                    const paginated = await scrapeWithPagination(url, origin, neededBrowser);
                    if (paginated.length > jobDetailLinks.length) {
                        console.log(`[aiHub] Pagination expanded: ${jobDetailLinks.length} → ${paginated.length} jobs`);
                        return { pageText: primary.pageText, rawHtml: primary.rawHtml || '', jobLinks: paginated };
                    }
                } catch (e) { console.log(`[aiHub] Pagination error: ${e.message}`); }
            }
            return { pageText: primary.pageText, rawHtml: primary.rawHtml || '', jobLinks: jobDetailLinks };
        }

        // LIGHT mode: stop here — skip the expensive sub-section / fallback-URL / career-page
        // cascade (a dozen Playwright renders that, for SPA/custom sites, mostly find nothing
        // and cost minutes). The caller goes straight to sitemap + the AI extractor, which do
        // their own smarter, faster discovery. The heavy cascade is reserved as a last resort.
        if (light) {
            return { pageText: primary.pageText, rawHtml: primary.rawHtml || '', jobLinks: jobDetailLinks };
        }

        // ── Sub-section scraping ──────────────────────────────────────────────────
        // Some sites (e.g. hemmersbach.com) hide actual job listings inside a sub-page
        // like "Open Jobs" or "Vacancies" nested under their main /career/ section.
        // If the primary scrape found links that look like job-listing section pages
        // (not individual jobs), dig one level deeper before trying generic fallbacks.
        const SUBSECTION_RE = /open[\s\-_]?jobs?|all[\s\-_]?jobs?|vacancies|vacatures|openings?|stellenangebote|positions?|offres?/i;
        const subsectionLinks = primary.links
            .filter(l => {
                // Link text or URL path matches a listing-section pattern
                const lastPart = (() => { try { return new URL(l.url).pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; } })();
                return (SUBSECTION_RE.test(l.text) || SUBSECTION_RE.test(lastPart)) &&
                       // But the link must be on the same domain and not the page we just scraped
                       sameDomain(l.url, origin) && l.url !== url;
            })
            .slice(0, 4); // Don't fan out too wide

        if (subsectionLinks.length > 0) {
            console.log(`[aiHub] Sub-section scraping: ${subsectionLinks.length} section page(s) to check`);
            const subsectionAccum = [];

            for (const secLink of subsectionLinks) {
                try {
                    let secPage  = await scrapePage(secLink.url, origin, false);
                    let secJobs  = secPage.links.filter(l => looksLikeJobDetailUrl(l.url, secLink.url));
                    console.log(`[aiHub]   ${secLink.url}: static → ${secJobs.length} job links`);

                    let secNeededBrowser = false;
                    if (secJobs.length < 3) {
                        const pupSec    = await scrapePage(secLink.url, origin, true);
                        const pupSecJobs = pupSec.links.filter(l => looksLikeJobDetailUrl(l.url, secLink.url));
                        console.log(`[aiHub]   ${secLink.url}: playwright → ${pupSecJobs.length} job links`);
                        if (pupSecJobs.length > secJobs.length) { secPage = pupSec; secJobs = pupSecJobs; secNeededBrowser = true; }
                    }

                    if (secJobs.length >= 3) {
                        // Paginate this section to get all jobs, not just page 1
                        try {
                            const paginated = await scrapeWithPagination(secLink.url, origin, secNeededBrowser);
                            if (paginated.length > secJobs.length) {
                                console.log(`[aiHub] Sub-section pagination: ${secJobs.length} → ${paginated.length} jobs`);
                                return { pageText: secPage.pageText, rawHtml: secPage.rawHtml || primary.rawHtml || '', jobLinks: paginated };
                            }
                        } catch {}
                        return { pageText: secPage.pageText, rawHtml: secPage.rawHtml || primary.rawHtml || '', jobLinks: secJobs };
                    }
                    subsectionAccum.push(...secJobs);
                } catch (e) {
                    console.log(`[aiHub]   Sub-section error (${secLink.url}): ${e.message}`);
                }
            }

            // Combine deduplicated results from all sub-sections
            const seenUrls = new Set();
            const combined = subsectionAccum.filter(l => { if (seenUrls.has(l.url)) return false; seenUrls.add(l.url); return true; });
            if (combined.length >= 3) {
                return { pageText: primary.pageText, rawHtml: primary.rawHtml || '', jobLinks: combined };
            }
            // Otherwise fall through to the generic fallback paths below
            jobDetailLinks.push(...combined.filter(l => !jobDetailLinks.some(x => x.url === l.url)));
        }

        const fallbackPaths = [
            `${parentPath}/all-jobs`, `${parentPath}/alle-vacatures`, `${parentPath}/all-vacancies`,
            `${parentPath}/jobs`, '/all-jobs', '/jobs', '/vacatures', '/careers/jobs',
        ];
        primary.links
            .filter(l => /all.?jobs|alle.?vacatures|all.?vacancies|vacature.*overzicht/i.test(l.url + l.text))
            .slice(0, 3)
            .forEach(l => fallbackPaths.unshift(new URL(l.url).pathname));

        for (const fbUrl of [...new Set(fallbackPaths)].map(p => `${origin}${p}`).filter(u => u !== url)) {
            let fb = await scrapePage(fbUrl, origin, false);
            let fbJobLinks = fb.links.filter(l => looksLikeJobDetailUrl(l.url, fbUrl));
            if (fbJobLinks.length < 3) {
                try {
                    const pupFb = await scrapePage(fbUrl, origin, true);
                    const pupFbLinks = pupFb.links.filter(l => looksLikeJobDetailUrl(l.url, fbUrl));
                    if (pupFbLinks.length > fbJobLinks.length) { fb = pupFb; fbJobLinks = pupFbLinks; }
                } catch {}
            }
            if (fbJobLinks.length >= 3) return { pageText: fb.pageText || primary.pageText, rawHtml: fb.rawHtml || primary.rawHtml || '', jobLinks: fbJobLinks };
        }

        // ── Career page detection ─────────────────────────────────────────────
        // Before giving up and going to Google Search, check if the homepage links
        // to a dedicated careers/jobs page (e.g. career.html, careers.html, /careers).
        // These pages often have all job listings inline (no individual job URLs) but
        // contain rich text we can extract titles + details from.
        const CAREER_PAGE_RE = /^(career|careers|career\.html|careers\.html|jobs|vacancies|vacancies\.html|open-positions|join-us|join\.html|work-with-us)$/i;
        const careerPageLink = primary.links.find(l => {
            try {
                const pathParts = new URL(l.url).pathname.split('/').filter(Boolean);
                const last = pathParts[pathParts.length - 1] || '';
                return sameDomain(l.url, origin) && CAREER_PAGE_RE.test(last) && l.url !== url;
            } catch { return false; }
        });

        if (careerPageLink) {
            console.log(`[aiHub] Found career page link: ${careerPageLink.url} — scraping for inline job listings`);
            try {
                let careerPage = await scrapePage(careerPageLink.url, origin, false);
                // Try Playwright too in case the page is JS-rendered
                if ((careerPage.pageText || '').length < 500) {
                    const pupCareer = await scrapePage(careerPageLink.url, origin, true);
                    if ((pupCareer.pageText || '').length > (careerPage.pageText || '').length) {
                        careerPage = pupCareer;
                    }
                }
                const careerJobLinks = careerPage.links.filter(l => looksLikeJobDetailUrl(l.url, careerPageLink.url));
                console.log(`[aiHub] Career page: ${careerJobLinks.length} job links, ${(careerPage.pageText || '').length} chars of text`);
                if (careerJobLinks.length >= 3) {
                    return { pageText: careerPage.pageText, rawHtml: careerPage.rawHtml || '', jobLinks: careerJobLinks };
                }
                // No individual links but page has content → return with empty jobLinks so
                // Phase 1 Gemini reads the page text to extract job titles
                if ((careerPage.pageText || '').length >= 300) {
                    console.log(`[aiHub] Career page has inline listings (no deep links) — passing text to Phase 1`);
                    return { pageText: careerPage.pageText, rawHtml: careerPage.rawHtml || '', jobLinks: [] };
                }
            } catch (e) {
                console.log(`[aiHub] Career page scrape error (${careerPageLink.url}): ${e.message}`);
            }
        }

        console.log(`[aiHub] No individual job links found — Gemini will use Google Search`);
        return { pageText: primary.pageText, rawHtml: primary.rawHtml || '', jobLinks: [] };
    } catch (err) {
        console.log(`[aiHub] fetchCareersPageData error (${err.message})`);
        return { pageText: '', rawHtml: '', jobLinks: [] };
    }
}

// ─── Gemini helpers ───────────────────────────────────────────────────────────

/**
 * @param {boolean} withSearch   Enable Google Search grounding
 * @param {string}  modelName    Override model (default: gemini-2.5-flash)
 */
function geminiModel(withSearch = false, modelName = 'gemini-2.5-flash') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    const genAI = new GoogleGenerativeAI(apiKey);
    const cfg = withSearch
        ? { model: modelName, tools: [{ googleSearch: {} }] }
        : { model: modelName };
    return genAI.getGenerativeModel(cfg);
}

// Gemini occasionally returns a transient 503 "high demand" / 429 rate-limit, especially when a
// big board fires many Phase-2 detail calls at once. A single failure used to leave a whole batch
// of jobs un-enriched. Retry transient errors with exponential backoff so the result is reliable.
async function aiGenerateWithRetry(model, prompt, tries = 4) {
    for (let i = 0; i < tries; i++) {
        try {
            return await model.generateContent(prompt);
        } catch (e) {
            const msg = String((e && e.message) || '');
            const transient = /\b429\b|\b50[03]\b|rate|quota|overload|unavailable|high demand|temporarily|timeout|deadline|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
            if (i < tries - 1 && transient) { await new Promise((r) => setTimeout(r, 1200 * Math.pow(2, i))); continue; }
            throw e;
        }
    }
}

// Self-healing completeness gate. True when a result is so thin it almost certainly means we
// extracted a single job-DETAIL page instead of the employer's board (e.g. boldcompany returning
// 1 of ~200) — worth a deeper agent investigation. Deliberately PRECISE so legit small employers,
// whose few jobs were extracted from their actual LISTING page, never trigger the (slow, paid)
// agent: it requires both "≤2 jobs" AND "the source URL looks like one posting, not a board".
function _agentWorthyThin(sourceUrl, n) {
    if (n === 0 || n > 2) return false;
    const u = String(sourceUrl || '');
    const detailish = /\/(vacature|vacatur|stelle\w*|position\w*|job|offre|emploi|empleo|opening)\w*[-_/][\w%-]{5,}/i.test(u);
    const boardish  = /\/(vacatures?|vacancies|jobs?|careers?|stellen\w*|positions?|openings?|offres?|empleos?)\/?$/i.test(u);
    return detailish && !boardish;
}

function parseJsonObject(text) {
    const t = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = t.indexOf('{'); const end = t.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object found');
    return JSON.parse(t.slice(start, end + 1));
}

function parseJsonArray(text) {
    const t = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = t.indexOf('['); const end = t.lastIndexOf(']');
    if (start === -1 || end === -1) return [];
    return JSON.parse(t.slice(start, end + 1));
}

// ─── Opt-4: Phase-1 without Gemini when sitemap links are available ───────────

/**
 * Converts a URL path slug into a human-readable title.
 * "/vacancies/senior-product-manager-energy-trading-2827" → "Senior Product Manager Energy Trading"
 */
function slugToTitle(url) {
    try {
        const slug = new URL(url).pathname.split('/').pop() || '';
        // Strip trailing numeric ID (e.g. "-2827")
        return slug
            .replace(/-\d{3,}$/, '')
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .trim();
    } catch { return ''; }
}

/**
 * Builds Phase-1 listing data entirely from HTML meta tags + sitemap links.
 * Zero Gemini calls.  Used when we already have a solid list of job URLs.
 *
 * @param {Array}  jobLinks    [{url, text}] from sitemap / HTML scrape
 * @param {string} html        Raw careers-page HTML (for meta tags)
 * @param {string} pageUrl     Careers page URL
 * @returns {object}           Same shape as findJobListings() output
 */
function buildListingDataFromHtml(jobLinks, html, pageUrl) {
    const { name, sub_info } = extractCompanyInfoFromHtml(html || '', pageUrl);

    // Domain slug (e.g. "experis" from "experis.nl", "hemmersbach" from "hemmersbach.com")
    const domainSlug = (() => {
        try {
            const host = new URL(pageUrl).hostname.replace(/^www\./, '');
            return host.split('.')[0].toLowerCase();
        } catch { return ''; }
    })();

    // Only trust the extracted name if it actually contains the domain slug.
    // Sites like ManpowerGroup's platform return "Welcome to ManpowerGroup" as the
    // title even when the domain is "experis.nl" — in that case force the domain name.
    const nameContainsDomain = domainSlug.length > 2 &&
        (name || '').toLowerCase().replace(/\s/g, '').includes(domainSlug);

    const finalName = nameContainsDomain
        ? name
        : (domainSlug
            ? domainSlug.charAt(0).toUpperCase() + domainSlug.slice(1)
            : name || extractDomain(pageUrl));

    const jobs = jobLinks.slice(0, MAX_JOB_LINKS).map(l => ({
        title:   l.text && l.text.trim().length > 3 ? l.text.trim() : slugToTitle(l.url),
        job_url: l.url,
    }));

    return {
        company_name:     finalName,
        sub_info:         sub_info,
        careers_page_url: pageUrl,
        jobs,
    };
}

// ─── Resolve company name → careers page URL ─────────────────────────────────

async function resolveCareersUrl(companyName) {
    // Try common URL patterns first (fast, no API call)
    const slug = companyName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
    const candidates = [
        `https://www.${slug}.com/careers`,
        `https://careers.${slug}.com`,
        `https://jobs.${slug}.com`,
        `https://www.${slug}.com/jobs`,
        `https://www.${slug}.com/en/careers`,
        `https://www.${slug}.com/about/careers`,
    ];

    for (const url of candidates) {
        try {
            const resp = await axios.head(url, { timeout: 5000, headers: HTTP_HEADERS, maxRedirects: 5 });
            if (resp.status < 400) {
                console.log(`[aiHub] Resolved "${companyName}" → ${url}`);
                return url;
            }
        } catch {}
    }

    // Ask Gemini to find the URL
    try {
        const model = geminiModel(true);
        const result = await model.generateContent(
            `Find the official careers/jobs page URL for the company "${companyName}". Return ONLY the URL on a single line, nothing else.`
        );
        const text = result.response.text().trim();
        const match = text.match(/https?:\/\/[^\s"'<>\n]+/);
        if (match) {
            console.log(`[aiHub] Gemini resolved "${companyName}" → ${match[0]}`);
            return match[0];
        }
    } catch (e) {
        console.log(`[aiHub] Could not resolve careers URL for "${companyName}": ${e.message}`);
    }

    // Last resort — verify the ROOT domain actually exists before keying everything off it.
    // Returning a fabricated "/careers" path (the loop above already proved it 404s) would
    // persist a bogus employer and poison the 24h cache. Prefer a reachable root so the
    // normal candidate discovery (careersCandidates) can still find the real page. (M27)
    for (const root of [`https://www.${slug}.com`, `https://${slug}.com`]) {
        try { const r = await axios.head(root, { timeout: 5000, headers: HTTP_HEADERS, maxRedirects: 5 }); if (r.status < 400) return root; } catch {}
    }
    return `https://www.${slug}.com`;
}

// ─── Phase 1: Find all job listing URLs ──────────────────────────────────────

async function findJobListings(companyInput, pageData, candidateProfile) {
    const hasLinks = pageData.jobLinks.length > 0;
    // If the careers page has substantial inline text (e.g. all jobs listed on one page
    // without individual deep-links), read from the text — no need for Google Search.
    const hasPageContent = (pageData.pageText || '').length >= 400;
    const useSearch = !hasLinks && !hasPageContent;
    const model = geminiModel(useSearch);
    const { pageText, jobLinks } = pageData;
    if (!hasLinks && hasPageContent) {
        console.log(`[aiHub] Phase 1: using inline page text (${pageText.length} chars) — skipping Google Search`);
    }

    const linksSection = hasLinks
        ? `LINKS EXTRACTED DIRECTLY FROM THE PAGE HTML — these are the ONLY valid job_url values:\n${jobLinks.slice(0, MAX_JOB_LINKS * 2).map(l => `  ${l.url}  |  "${l.text}"`).join('\n')}`
        : '';

    const candidateSkills = (candidateProfile?.skills || []).join(', ') || 'Not specified';
    const candidateTitles = (candidateProfile?.job_titles || []).join(', ') || 'Not specified';

    const prompt = `You are a job listing identifier. Find the open positions at this company that best match the candidate profile below.

COMPANY / URL: ${companyInput}

CANDIDATE PROFILE (use this to filter relevant jobs — return up to 80 best matches):
- Skills: ${candidateSkills}
- Previous titles: ${candidateTitles}

${pageText ? `PAGE TEXT (pre-fetched from the careers page):\n"""\n${pageText}\n"""\n` : ''}
${linksSection}

${hasLinks ? `CRITICAL INSTRUCTIONS — YOU MUST FOLLOW THESE EXACTLY:
1. The "LINKS EXTRACTED" block above is the complete set of individual job pages scraped from the real HTML.
2. Select up to 30 links that are most relevant to the candidate profile above.
3. The job_url for each job MUST be copied EXACTLY as it appears in the links list above — character for character.
4. DO NOT use Google Search. DO NOT visit any URL. DO NOT construct or modify any URL.
5. Extract the job title from the link text next to each URL.` : hasPageContent ? `CRITICAL INSTRUCTIONS — PAGE TEXT MODE:
1. The PAGE TEXT above contains all job listings for this company on a single page (inline listings, no individual job URLs).
2. Extract EVERY distinct job title you can find in the text — look for job titles, role names, position headings.
3. Set job_url to null for all jobs (they are all on the same listing page).
4. DO NOT use Google Search. The page text is your only source.
5. Return ALL jobs found — do not filter by candidate profile at this stage.` : `CRITICAL INSTRUCTIONS:
1. Use Google Search to find ALL open positions at "${companyInput}" — check their own website AND any job boards (jobserve.com, indeed.com, linkedin.com, reed.co.uk, totaljobs.com, etc.).
2. PREFERRED: If individual job detail page URLs exist, use those as job_url.
3. FALLBACK (important): If the company only has a single employer listing page on a job board (e.g. jobserve.com/Listings/Employers/CompanyName/), use THAT listing page URL for ALL jobs found there — set it as both careers_page_url and job_url for each job. We will scrape that page to extract full details.
4. You MUST return job titles even if only one listing page URL is available — list every open role you find as a separate job object with the same listing-page URL.
5. DO NOT return empty jobs array just because individual deep-links don't exist.`}

Return ONLY valid JSON (no markdown, no explanation):
{
  "company_name": "Full official company name in English",
  "sub_info": "City, Country · Industry",
  "careers_page_url": "https://url-of-the-jobs-listing-page",
  "jobs": [
    { "title": "Job Title in English", "job_url": "${hasLinks ? 'https://exact-url-copied-from-links-list' : hasPageContent ? 'null' : 'https://best-available-url-for-this-job-or-listing-page'}" }
  ]
}

STRICT RULES:
- For scraped-links mode: job_url must be copied verbatim from the links list above
- For Google Search mode: use individual job URLs when available; use the employer listing page URL when individual URLs don't exist — NEVER leave jobs array empty just because deep-links are missing
- NEVER construct or guess a URL that was not found in search results
- ALL output in English — translate job titles, company names, and sub_info to English
- Job titles MUST be translated: "Systeembeheerder Cloud"→"Cloud Systems Administrator", "Entwickler"→"Developer", "Ingénieur"→"Engineer", "软件工程师"→"Software Engineer", etc.`;

    const result = await model.generateContent(prompt);
    return parseJsonObject(result.response.text().trim());
}

// ─── Phase 2: Fetch full details from each job's individual page ──────────────
//
// New unified strategy (replaces old Path A/B/C):
//   1. Playwright scrapes each page with:
//      a) API response interception (captures XHR/fetch job data JSON if available)
//      b) Reveal button clicks ("Toon nummer", "Show contact", etc.)
//      c) Full networkidle wait for JS-rendered SPAs
//   2. HTML is stripped to lean token-efficient text (no script/style/nav/svg/footer)
//      with inline mailto:/tel:/linkedin: hrefs preserved as text
//   3. Single unified Gemini 2.5 Flash Lite call per batch with the structured
//      extraction prompt — returns compressed JSON schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the unified extraction prompt (gemini-2.5-flash-lite).
 * Handles multilingual content → English output.
 * Uses the compressed JSON schema requested by user research.
 */
function buildExtractionPrompt(pages) {
    const jobBlocks = pages.map((s, i) => {
        // Prefer intercepted API JSON (cleanest signal), then stripped text
        const source = s.interceptedJson
            ? `INTERCEPTED API PAYLOAD (clean JSON — preferred):\n${s.interceptedJson.slice(0, 6000)}`
            : `CLEANED PAGE TEXT:\n${s.text.slice(0, 6000)}`;
        return `--- JOB ${i + 1} ---\nOriginal Title: "${s.job.title}"\nURL: ${s.job.job_url}\n${source}`;
    }).join('\n\n');

    return `You are a context-optimized, multi-lingual data extraction pipeline. Extract structured job data from the pre-cleaned source below.

${jobBlocks}

### EXTRACTION RULES:
1. **English only** — Translate ALL foreign text: "Systeembeheerder"→"System Administrator", "Salaris"→"Salary", "Thuiswerken"→"Remote/Hybrid", "Entwickler"→"Developer", "Ingénieur"→"Engineer", "软件工程师"→"Software Engineer", etc.
2. **Contact audit** — Look deep in the text for names, phone numbers, email patterns and LinkedIn URLs that were unmasked by our browser renderer. Inline mailto:/tel:/linkedin: links appear as "[mailto:email]" or "[tel:+31...]" or "[https://linkedin.com/in/...]" — extract these precisely.
3. **No inference** — If a field is missing from source text, use exactly: "N/A" for strings, [] for arrays.
4. **Contact name rule** — name MUST be a real person's name (e.g. "Lorenzo Schenk"). NEVER use labels ("recruiter", "location", "contact", "hr") as a name.
5. **Salary** — scan for ANY compensation mention in ANY language (salaris, Gehalt, salaire, salary, RAL, €, £, $, ¥, ₹). Include currency symbol.
6. **Skills** — extract ALL required skills and competencies from the job: technical skills (languages, frameworks, tools, cloud, DBs, certs), domain/industry skills (equipment, machinery, processes, methodologies), education/qualification requirements (e.g. "Diploma/Graduate", "3-5 years experience"), and any specific knowledge areas listed under Requirements, Skills, or Qualifications sections. Include soft skills only if explicitly listed as requirements (e.g. "Willingness to travel", "Team player"). Break compound skill names into individual English terms. Do NOT omit anything listed under Requirements.
7. **Responsibilities** — 4–6 concise English bullet points of actual day-to-day tasks.
8. **Employment Type** — the working-time contract, one of: "Full-time", "Part-time", "Contract", "Internship", "Freelance", "N/A" (Vollzeit→Full-time, Teilzeit→Part-time, Praktikum→Internship).
9. **Work Mode** — the work-LOCATION arrangement, one of: "Remote", "Hybrid", "Office", "N/A" (Thuiswerken→Remote, vor Ort→Office). Use "N/A" if not stated — do not guess.
10. **Dedup contacts** — if two contacts share the same email, keep only one.

Return ONLY a raw JSON array — no markdown fences, no explanation. Start with [ and end with ].

One object per job, same order as input:
[
  {
    "index": 0,
    "Employer Name": "Official company name (e.g. Experis, Hemmersbach) — NOT navigation labels like 'Back Button' or 'Filter Icon'",
    "Job Title": "English Translated Title",
    "Location": "City, Country (the office location)",
    "Employment Type": "Full-time | Part-time | Contract | Internship | Freelance | N/A",
    "Work Mode": "Remote | Hybrid | Office | N/A",
    "Salary": "e.g. €3500–€6500/month or N/A",
    "Experience": "e.g. 3–5 years or N/A",
    "Urgent": false,
    "Skills List": ["Skill1", "Skill2"],
    "Responsibilities": ["Brief task 1", "Brief task 2"],
    "Contact Details": [
      {
        "Contact Person Name": "Full Real Name or N/A",
        "Image Url": "https://... or N/A",
        "Email": "direct@email.com or Contact via portal",
        "Contact Number": "+31... or N/A",
        "Role/Designation": "Recruiter | Hiring Manager | Technical Recruiter | N/A",
        "LinkedIn Profile Link": "https://linkedin.com/in/... or N/A"
      }
    ]
  }
]`;
}

/**
 * Normalize the AI response (which uses the new compressed schema) into the
 * internal format used by buildJobFromRaw and the DB save loop.
 */
function normalizeAiJob(aiJob, originalJob) {
    const contacts = (Array.isArray(aiJob['Contact Details']) ? aiJob['Contact Details'] : [])
        .filter(c => {
            const name = (c['Contact Person Name'] || '').trim();
            if (!name || name === 'N/A') return false;
            // Drop contacts whose "name" is a known label
            return !/^(recruiter|hiring manager|contact|hr|location|contactperson|n\/a)$/i.test(name);
        })
        .map(c => ({
            name:      c['Contact Person Name'],
            role:      c['Role/Designation'] && c['Role/Designation'] !== 'N/A' ? c['Role/Designation'] : 'Recruiter',
            email:     c['Email'] && c['Email'] !== 'Contact via portal' && c['Email'] !== 'N/A' ? c['Email'] : null,
            phone:     c['Contact Number'] && c['Contact Number'] !== 'N/A' ? c['Contact Number'] : null,
            linkedin:  c['LinkedIn Profile Link'] && c['LinkedIn Profile Link'] !== 'N/A' ? c['LinkedIn Profile Link'] : null,
            image_url: c['Image Url'] && c['Image Url'] !== 'N/A' ? c['Image Url'] : null,
        }));

    // Dedup by email
    const seenEmails = new Set();
    const dedupedContacts = contacts.filter(c => {
        if (!c.email) return true;
        const key = c.email.toLowerCase();
        if (seenEmails.has(key)) return false;
        seenEmails.add(key);
        return true;
    });

    // When enriching an AI-extractor LISTING job from its detail page, the listing already
    // gave us good title/location/work_mode/salary — keep those as a FLOOR so a thin detail
    // extraction never wipes them out. Detail values win when present; listing fills gaps.
    const orig = originalJob || {};
    const naOk = (v) => v && v !== 'N/A' ? v : null;
    const salary = naOk(aiJob['Salary']) || orig.salary || null;
    const location = naOk(aiJob['Location']) || (orig.location && orig.location !== 'Not specified' ? orig.location : null) || 'Not specified';
    // Employment type vs work mode kept separate. Back-compat: an older payload's
    // "Type of Job" carried the work mode, so fall back to it for work_mode.
    const jobType  = naOk(aiJob['Employment Type']) || orig.job_type || 'Full-time';
    const workMode = naOk(aiJob['Work Mode']) || naOk(aiJob['Type of Job']) || orig.work_mode || null;
    const detailSkills = Array.isArray(aiJob['Skills List']) ? aiJob['Skills List'].filter(Boolean) : [];
    const detailResp   = Array.isArray(aiJob['Responsibilities']) ? aiJob['Responsibilities'].filter(Boolean) : [];
    const skills = detailSkills.length ? detailSkills : (Array.isArray(orig.skills) ? orig.skills : []);
    const responsibilities = detailResp.length ? detailResp : (Array.isArray(orig.responsibilities) ? orig.responsibilities : []);

    const employerName = (aiJob['Employer Name'] || '').trim();

    return {
        employer_name:   employerName || orig.employer_name || null,  // used by processJobSearch to fix Phase-1 name
        title:           aiJob['Job Title'] || orig.title,
        job_url:         orig.job_url,
        location,
        experience:      naOk(aiJob['Experience']) || orig.experience || 'Not specified',
        salary,
        job_type:        jobType,
        work_mode:       workMode,
        urgent:          !!aiJob['Urgent'],
        match_score:     0,
        skills,
        responsibilities,
        contacts:        (dedupedContacts && dedupedContacts.length) ? dedupedContacts : (Array.isArray(orig.contacts) ? orig.contacts : []),
    };
}

async function fetchJobDetailsBatch(jobBatch, careersUrl, candidateProfile, listingPageText = '', detailRecipe = null) {
    // ── ATS fast path ────────────────────────────────────────────────────────
    // Jobs discovered from a SuccessFactors/Workday-style sitemap are server-
    // rendered, so we fetch each with a plain HTTP GET and parse the structured
    // data directly — NO Playwright, NO AI. This is what lets us return the full
    // listing (e.g. all 184 RWE roles) fast and free. Streams per batch like usual.
    // A learned per-employer recipe (detailRecipe) fills fields the generic parser
    // misses (still no AI per job).
    if (jobBatch.length && jobBatch.every(j => j._ats)) {
        return Promise.all(jobBatch.map(async (j) => {
            try {
                const html = await fetchJobPage(j.job_url);
                return parseAtsJobPage(html, j.job_url, detailRecipe);
            } catch (e) {
                // Keep the job (title from URL) even if its page fetch failed.
                return { title: j.title, location: '', skills: [], responsibilities: [], job_url: j.job_url };
            }
        }));
    }

    // ── ATS API fast path ────────────────────────────────────────────────────
    // Jobs from an ATS public API (atsDiscovery) are already fully structured —
    // return them directly, NO fetch and NO AI. employer_name flows through so the
    // company name is correct (fixes the "N/A" cards).
    if (jobBatch.length && jobBatch.every(j => j._atsApi)) {
        return jobBatch.map((j) => ({
            title: j.title, location: j.location || '',
            experience: j.experience || null, salary: j.salary || null, job_type: j.job_type || 'Full-time',
            work_mode: j.work_mode || null,                          // pass through AI-extracted work mode (Remote/Hybrid/Office)
            skills: Array.isArray(j.skills) ? j.skills : [],
            responsibilities: Array.isArray(j.responsibilities) ? j.responsibilities : [],
            job_url: j.job_url, employer_name: j.employer_name || null,
            contacts: Array.isArray(j.contacts) ? j.contacts : [],   // pass through AI-extracted recruiter contacts (M9)
        }));
    }

    // ── Step 1: Scrape all pages concurrently with Playwright ────────────────
    // listing_page_only jobs: no individual URL exists — reuse already-scraped
    // careers listing page text instead of making a redundant Playwright fetch.
    // smartScrape: static fetch first → Playwright fallback if content thin
    // Playwright adds: API interception + reveal-button clicks + networkidle wait
    const normalJobs   = jobBatch.filter(j => !j.listing_page_only);
    const listingJobs  = jobBatch.filter(j =>  j.listing_page_only);

    if (listingJobs.length > 0) {
        console.log(`[aiHub] ${listingJobs.length} listing-page-only jobs — reusing careers page text (${listingPageText.length} chars)`);
    }
    if (normalJobs.length > 0) {
        console.log(`[aiHub] Scraping ${normalJobs.length} individual job pages with smart scraper…`);
    }

    // Pre-scrape any unique listing-page URLs once (shared across all jobs pointing to them)
    const listingUrlCache = {};
    const uniqueListingUrls = [...new Set(jobBatch.filter(j => j.listing_page_only).map(j => j.job_url))];
    await Promise.all(uniqueListingUrls.map(async (url) => {
        // If we already have good listing page text from Phase 1, use it
        if (url === jobBatch.find(j => j.listing_page_only)?.job_url && listingPageText.length >= 200) {
            listingUrlCache[url] = listingPageText;
            console.log(`[aiHub] Reusing Phase-1 listing page text for ${url} (${listingPageText.length} chars)`);
            return;
        }
        // Otherwise scrape the listing page (e.g. a jobserve employer page)
        try {
            const result = await smartScrape(url, { minChars: 400 });
            listingUrlCache[url] = result.text || '';
            console.log(`[aiHub] Scraped listing page ${url} — ${listingUrlCache[url].length} chars`);
        } catch (e) {
            console.error(`[aiHub] Failed to scrape listing page ${url}: ${e.message}`);
            listingUrlCache[url] = listingPageText; // fall back to Phase-1 text
        }
    }));

    const scrapedPages = await Promise.all(
        jobBatch.map(async (j) => {
            // Listing-page-only: use cached listing page text (no per-job scrape needed)
            if (j.listing_page_only) {
                const text = listingUrlCache[j.job_url] || listingPageText;
                const hasContent = text.length >= 200;
                return { job: j, text, interceptedJson: null, hasContent };
            }
            if (!j.job_url) {
                return { job: j, text: '', interceptedJson: null, hasContent: false };
            }
            try {
                const result = await smartScrape(j.job_url, { minChars: 600 });
                const hasContent = (result.text || '').length >= 300 || !!result.interceptedJson;
                console.log(`[aiHub] Scraped "${j.title}" — ${result.text.length} chars, intercepted=${!!result.interceptedJson}, browser=${result.usedBrowser}`);
                return { job: j, text: result.text || '', interceptedJson: result.interceptedJson, hasContent };
            } catch (e) {
                console.error(`[aiHub] Scrape failed for ${j.job_url}: ${e.message}`);
                return { job: j, text: '', interceptedJson: null, hasContent: false };
            }
        })
    );

    // Pages with no content at all → use Google Search grounding as last resort
    const noContentPages = scrapedPages.filter(s => !s.hasContent);
    const hasContent     = scrapedPages.filter(s => s.hasContent);

    // ── Step 2: Single unified Gemini call for all pages with content ─────────
    const resultsMap = {}; // original index → normalized job object

    if (hasContent.length > 0) {
        try {
            const prompt  = buildExtractionPrompt(hasContent);
            const model   = geminiModel(false, 'gemini-2.5-flash-lite');
            const result  = await aiGenerateWithRetry(model, prompt);
            const parsed  = parseJsonArray(result.response.text().trim());

            hasContent.forEach((s, i) => {
                const origIdx = scrapedPages.indexOf(s);
                const aiJob   = parsed[i] || {};
                resultsMap[origIdx] = normalizeAiJob(aiJob, s.job);
            });
            console.log(`[aiHub] Extraction complete: ${hasContent.length} jobs via gemini-2.5-flash-lite`);
        } catch (e) {
            console.error('[aiHub] Extraction call failed:', e.message);
        }
    }

    // ── Step 3: Grounding fallback for empty pages ────────────────────────────
    if (noContentPages.length > 0) {
        try {
            console.log(`[aiHub] ${noContentPages.length} pages had no content — trying Google Search grounding`);
            const prompt  = buildExtractionPrompt(noContentPages);
            const model   = geminiModel(true); // enable Google Search
            const result  = await aiGenerateWithRetry(model, prompt);
            const parsed  = parseJsonArray(result.response.text().trim());

            noContentPages.forEach((s, i) => {
                const origIdx = scrapedPages.indexOf(s);
                const aiJob   = parsed[i] || {};
                resultsMap[origIdx] = normalizeAiJob(aiJob, s.job);
            });
            console.log(`[aiHub] Grounding extraction: ${noContentPages.length} jobs`);
        } catch (e) {
            console.error('[aiHub] Grounding extraction failed:', e.message);
        }
    }

    // ── Step 3b: Per-job contact email from THIS job's own detail page ─────────
    // Generic recruitment inboxes (e.g. recruiting.at@primetals.com) have no person name, so
    // the AI contact extractor skips them. Harvest the employer-domain email straight from the
    // scraped detail text and attach it — so the RIGHT address shows instead of a listing-level
    // fallback that might be a stray third-party email.
    for (let i = 0; i < scrapedPages.length; i++) {
        const s = scrapedPages[i];
        const job = resultsMap[i];
        if (!job || !s || !s.text) continue;
        const hasEmail = Array.isArray(job.contacts) && job.contacts.some((c) => c && c.email);
        if (hasEmail) continue;
        const host = (() => { try { return new URL(s.job.job_url).hostname; } catch { return ''; } })();
        const email = pickEmployerContactEmail(s.text + ' ' + (s.interceptedJson || ''), host);
        if (email) {
            job.contacts = Array.isArray(job.contacts) ? job.contacts : [];
            job.contacts.push({ name: 'Recruitment Team', role: 'Recruiter', email });
        }
    }

    // ── Step 4: Return results in original order ──────────────────────────────
    return scrapedPages.map((s, i) => {
        return resultsMap[i] || {
            title:    s.job.title,
            job_url:  s.job.job_url,
            location: 'Not specified',
            experience: 'Not specified',
            salary:   null,
            job_type: 'Full-time',
            urgent:   false,
            match_score: 0,
            skills:   [],
            responsibilities: [],
            contacts: [],
        };
    });
}

// ─── Build the Employer object for streaming to the frontend ─────────────────

function buildEmployerObject(employerDbId, asyncJobId, listingData, logoColor, jobs, domain) {
    const name = listingData.company_name || 'Unknown Company';
    return {
        id: employerDbId,
        jobId: asyncJobId,
        name,
        subInfo: listingData.sub_info || '',
        logoColor,
        logoInitial: (name[0] || '?').toUpperCase(),
        status: 'active',
        domain: domain || null,   // full registrable domain WITH TLD (e.g. vertigis.com) for the company card
        jobs,
        // Best-200 surfacing: when an employer has more open roles than we keep, the UI
        // shows "more than N positions — matching the best 200 for you".
        totalOpen: listingData.total_open || null,
        moreAvailable: !!listingData.more_available,
    };
}

function buildJobFromRaw(raw, index, employerDbId, careersUrl, dbJobId = null) {
    const contacts = (Array.isArray(raw.contacts) ? raw.contacts : [])
        .filter(c => c && c.name)
        .map((c, ci) => ({
            id: `${employerDbId}-j${index + 1}-c${ci + 1}`,
            name: c.name,
            role: c.role || 'Recruiter',
            email: c.email || '',
            phone: c.phone || null,
            linkedin: c.linkedin || null,
            imageUrl: c.image_url || null,
            verified: false,
            avatarColor: AVATAR_COLORS[ci % AVATAR_COLORS.length],
        }));

    const applyUrl = raw.job_url && raw.job_url.startsWith('http') ? raw.job_url : careersUrl;
    return {
        // Use the REAL DB job id so contacts/cover-letter persist & reload (matches the cached path).
        id: dbJobId != null ? String(dbJobId) : `${employerDbId}-job-${index + 1}`,
        title: raw.title || 'Open Position',
        location: raw.location || 'Location TBD',
        experience: raw.experience || 'Not specified',
        salary: raw.salary || 'Not listed',
        jobType: raw.job_type || 'Full-time',
        workMode: raw.work_mode || null,
        urgent: !!raw.urgent,
        matchScore: null,   // unscored — the card shows "Evaluating…" until the background scorer fills it in
        applyUrl,
        skills: Array.isArray(raw.skills) ? raw.skills : [],
        responsibilities: Array.isArray(raw.responsibilities) ? raw.responsibilities : [],
        contacts,
    };
}

// Persist one extracted job: upsert job + skills + contacts (+ generic HR email fallback)
// and link it to the user (optionally with a computed match score). Returns the DB job id.
// Shared by Phase-2 streaming and the best-200 overflow ranking.
async function persistOneJob(raw, jobUrl, employerDbId, userId, hrEmails = [], matchScore = null) {
    let dbJobId = null;
    try {
        const locationId = await jobService.upsertLocation(raw.location || 'Not specified');
        const responsibilities = Array.isArray(raw.responsibilities) ? raw.responsibilities : [];
        dbJobId = await jobService.upsertJob(
            employerDbId, locationId,
            raw.title || 'Open Position', jobUrl,
            raw.experience || null, raw.salary || null,
            raw.job_type || 'Full-time', !!raw.urgent, responsibilities,
            raw.work_mode || null
        );
        for (const skill of (raw.skills || [])) {
            if (!skill || skill.length > 100) continue;
            try { const skillId = await jobService.upsertSkill(skill); await jobService.linkJobSkill(dbJobId, skillId); } catch {}
        }
        const contactEmailsSaved = new Set();
        for (const contact of (raw.contacts || [])) {
            if (!contact?.name) continue;
            const nameLower = contact.name.toLowerCase().trim();
            if (/^(recruiter|hiring manager|contact|hr|location|contactperson|ansprechpartner|contactpersoon)$/.test(nameLower)) continue;
            // Never save a third-party tracker/widget email (e.g. help@meltwater.com) as a contact.
            const emDom = (contact.email || '').toLowerCase().split('@')[1] || '';
            if (emDom && _TRACKER_DOM.test(emDom)) continue;
            const emailKey = (contact.email || '').toLowerCase().trim();
            if (emailKey && contactEmailsSaved.has(emailKey)) continue;
            if (emailKey) contactEmailsSaved.add(emailKey);
            try {
                await jobService.addJobContact(dbJobId, contact.name, contact.role, contact.email || null, contact.phone || null, null, contact.linkedin || null, contact.image_url || null);
            } catch {}
        }
        if (contactEmailsSaved.size === 0 && hrEmails.length > 0) {
            for (const hrEmail of hrEmails) {
                try { await jobService.addJobContact(dbJobId, 'Recruitment Team', 'Recruiter', hrEmail, null, null, null, null); break; } catch {}
            }
        }
        await jobService.saveUserJobMatch(userId, dbJobId, typeof matchScore === 'number' ? matchScore : null);
    } catch (e) {
        console.error(`[aiHub] DB save error for job "${raw && raw.title}":`, e.message);
    }
    return dbJobId;
}

// ─── Get user profile from resume_metadata ────────────────────────────────────

async function getUserProfile(userId) {
    try {
        const row = await dbConfig.get(
            `SELECT skills, technical_skills, soft_skills, job_titles, experience_years
             FROM resume_metadata WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
            [userId]
        );
        if (!row) return { skills: [], job_titles: [], experience_years: 0 };

        const skills = new Set();
        if (Array.isArray(row.skills)) row.skills.forEach(s => s && skills.add(s));
        const ts = safeParseJSON(row.technical_skills, {});
        Object.values(ts).forEach(arr => Array.isArray(arr) && arr.forEach(s => s && skills.add(s)));
        if (Array.isArray(row.soft_skills)) row.soft_skills.forEach(s => s && skills.add(s));

        return {
            skills: [...skills],
            job_titles: Array.isArray(row.job_titles) ? row.job_titles : [],
            experience_years: Number(row.experience_years) || 0,
        };
    } catch (e) {
        console.error('[aiHub] getUserProfile error:', e.message);
        return { skills: [], job_titles: [], experience_years: 0 };
    }
}

// ─── Background job-match scorer ──────────────────────────────────────────────
// Scores how well the user's resume skills fit each job's required skills +
// responsibilities. Runs OFF the job-fetch path (its own endpoint), batches all
// jobs into one cheap Gemini (flash-lite) call returning {id,score} only, and the
// result is cached per (user, job) so each job is scored exactly once.

// Deterministic fallback so cards never get stuck "Evaluating" if the AI call fails.
function localSkillScore(userSkills, jobSkills) {
    if (!Array.isArray(jobSkills) || !jobSkills.length) return null;
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+#.]/g, '');
    const u = (userSkills || []).map(norm).filter(Boolean);
    if (!u.length) return null;
    const uSet = new Set(u);
    let hit = 0;
    for (const js of jobSkills) {
        const n = norm(js);
        if (!n) continue;
        if (uSet.has(n) || u.some((x) => x.length > 2 && (x.includes(n) || n.includes(x)))) hit++;
    }
    return Math.max(0, Math.min(100, Math.round((hit / jobSkills.length) * 100)));
}

// jobs: [{ id, title, skills:[], responsibilities:[] }] → { [jobId]: 0..100 }
async function scoreJobsForUser(userProfile, jobs) {
    const out = {};
    if (!Array.isArray(jobs) || !jobs.length) return out;
    const skills = (userProfile?.skills || []).slice(0, 40);
    if (!skills.length) return out; // no resume skills → caller signals noProfile
    const titles = (userProfile?.job_titles || []).slice(0, 6);
    const years = Number(userProfile?.experience_years) || 0;

    const CHUNK = 25;
    let model = null;
    try { model = geminiModel(false, 'gemini-2.5-flash-lite'); } catch { model = null; }

    for (let i = 0; i < jobs.length; i += CHUNK) {
        const batch = jobs.slice(i, i + CHUNK).map((j) => ({
            id: String(j.id),
            title: j.title || '',
            skills: (Array.isArray(j.skills) ? j.skills : []).slice(0, 12),
            responsibilities: (Array.isArray(j.responsibilities) ? j.responsibilities : []).slice(0, 6),
        }));

        let scored = false;
        if (model) {
            const prompt = `You are a precise job-fit scorer. Score how well the CANDIDATE matches each JOB on a 0-100 scale (0 = no overlap, 100 = excellent fit). Judge SEMANTICALLY — treat synonyms and closely related technologies as matches (e.g. "React" ≈ "React.js", "Postgres" ≈ "PostgreSQL", "AWS" covers "EC2/S3/Lambda", "JS" ≈ "JavaScript", "k8s" ≈ "Kubernetes"). Weight required hard skills most, then responsibilities, then seniority/title fit. Be realistic and discriminating — do NOT give everything a high score.

CANDIDATE:
skills: ${JSON.stringify(skills)}
titles: ${JSON.stringify(titles)}
years_experience: ${years}

JOBS:
${JSON.stringify(batch)}

Return ONLY a JSON array, one object per job, reusing the SAME id values, no commentary:
[{"id":"<jobId>","score":<integer 0-100>}]`;
            const callOnce = async () => {
                const r = await model.generateContent({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 2048 },
                });
                return parseJsonArray(r.response.text());
            };
            let arr = null;
            for (let i = 0; i < 3; i++) {
                try { arr = await callOnce(); break; }
                catch (e) {
                    const transient = /\b429\b|\b50[03]\b|overload|unavailable|high demand|rate|quota|timeout|deadline/i.test(String((e && e.message) || ''));
                    if (i < 2 && transient) { await new Promise((r) => setTimeout(r, 1000 * (i + 1))); continue; }
                    arr = null; break;
                }
            }
            if (Array.isArray(arr)) {
                for (const it of arr) {
                    if (!it || it.id == null) continue;
                    const s = Math.round(Number(it.score));
                    if (!Number.isFinite(s)) continue;
                    out[String(it.id)] = Math.max(0, Math.min(100, s));
                }
                scored = true;
            }
        }
        if (!scored) {
            // AI unavailable/failed → deterministic local overlap so the UI still resolves.
            for (const j of batch) {
                const ls = localSkillScore(skills, j.skills);
                if (ls != null) out[String(j.id)] = ls;
            }
        }
    }
    return out;
}

// POST /ai-hub/match-scores  body { jobIds: string[] }
// Scores ONLY the caller's not-yet-scored jobs among jobIds, caches them, and returns
// { scores: { jobId: 0..100 } }. Meant to be called in the background after the job
// cards render — it never touches the job-fetch path.
async function getMatchScores(req, res) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const requested = Array.isArray(req.body?.jobIds) ? req.body.jobIds.map(String) : [];
        const jobIds = [...new Set(requested.filter((id) => UUID.test(id)))];
        if (!jobIds.length) return res.json({ scores: {} });

        // Current state of every requested match. CRUCIAL: return the CACHED score for jobs
        // that are ALREADY scored — not just freshly-computed ones. Otherwise a job that got
        // scored between the card rendering ("Evaluating") and this request (e.g. by the
        // best-200 pass or a prior batch) would be missing from the response, and the app would
        // treat it as unscorable (matchScore = -1) and hide the badge entirely.
        const rows = await dbConfig.query(
            `SELECT job_id, match_score, scored_at FROM user_job_matches
             WHERE user_id = $1 AND job_id = ANY($2::uuid[])`,
            [userId, jobIds]
        );
        const result = {};            // jobId -> score (cached + newly computed)
        const toScore = [];
        for (const r of (rows || [])) {
            const id = String(r.job_id);
            if (r.scored_at) result[id] = (r.match_score ?? 0);   // already scored → return cached %
            else toScore.push(id);
        }
        // Requested jobs with no match row yet (just-created) also need scoring.
        const seenIds = new Set(Object.keys(result).concat(toScore));
        for (const id of jobIds) if (!seenIds.has(id)) toScore.push(id);
        if (!toScore.length) return res.json({ scores: result });

        const userProfile = await getUserProfile(userId);
        if (!userProfile.skills || !userProfile.skills.length) {
            // No résumé → can't compute NEW scores, but still return any already-cached ones.
            return res.json({ scores: result, noProfile: true });
        }

        const jobRows = await dbConfig.query(
            `SELECT id, title, responsibilities FROM jobs WHERE id = ANY($1::uuid[])`,
            [toScore]
        );
        const skillRows = await dbConfig.query(
            `SELECT js.job_id, s.name FROM job_skills js JOIN skills s ON s.id = js.skill_id
             WHERE js.job_id = ANY($1::uuid[])`,
            [toScore]
        );
        const skillsByJob = {};
        for (const r of (skillRows || [])) {
            const k = String(r.job_id);
            (skillsByJob[k] || (skillsByJob[k] = [])).push(r.name);
        }
        const jobs = (jobRows || []).map((j) => {
            let resp = [];
            try {
                resp = j.responsibilities
                    ? (typeof j.responsibilities === 'string' ? JSON.parse(j.responsibilities) : j.responsibilities)
                    : [];
            } catch { resp = []; }
            return {
                id: String(j.id),
                title: j.title,
                skills: skillsByJob[String(j.id)] || [],
                responsibilities: Array.isArray(resp) ? resp : [],
            };
        });

        const scores = await scoreJobsForUser(userProfile, jobs);

        // Persist each score (also stamps scored_at so each job is computed once) and merge
        // it into the result alongside the already-cached scores.
        for (const jid of Object.keys(scores)) {
            try { await jobService.saveUserJobMatch(userId, jid, scores[jid]); } catch (e) { /* non-fatal */ }
            result[jid] = scores[jid];
        }
        return res.json({ scores: result });
    } catch (e) {
        console.error('[aiHub] getMatchScores error:', e.message);
        return res.status(500).json({ error: 'Failed to score jobs' });
    }
}

// ─── HR / contact email helpers ───────────────────────────────────────────────
// Third-party domains that embed their OWN email on customer sites (analytics, consent,
// chat, PR/monitoring widgets…). Their addresses are NEVER the employer's contact.
const _TRACKER_DOM = /(meltwater|cookiebot|onetrust|usercentrics|trustarc|sentry|hotjar|segment|intercom|drift|zendesk|freshdesk|hubspot|marketo|pardot|sendgrid|mailchimp|mailgun|postmark|doubleclick|googletagmanager|google-analytics|googleapis|gstatic|wordpress|wix|squarespace|typeform|calendly|jsdelivr|cloudflare|datadog|newrelic|fontawesome|w3\.org|schema\.org|sentry\.io|example\.(com|org)|wixpress|shopify|hubspotusercontent)/i;
// Mailbox local-parts that are never a usable recruiting contact.
const _NOREPLY_LOCAL = /^(no[\-_.]?reply|donotreply|do[\-_.]?not[\-_.]?reply|postmaster|webmaster|abuse|privacy|legal|dpo|gdpr|datenschutz|admin|root|mailer[\-_.]?daemon|bounce|unsubscribe|notifications?)\b/i;
// Local-parts that signal a generic recruitment inbox (multilingual).
const _HR_LOCAL = /^(careers?|jobs?|hr|recruit(ing|ment|er)?|talent|apply|application|work|hiring|resumes?|cvs?|people|staffing|employ|bewerb\w*|personal|stellen|karriere|emploi|rrhh)/i;
// Registrable core label of a host: jobs.primetals.com -> "primetals", acme.co.uk -> "acme".
function coreLabel(host) {
    const c = String(host || '').toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9.\-].*/i, '').split('.');
    if (c.length <= 1) return c[0] || '';
    const twoPart = new Set(['co.uk', 'com.au', 'co.in', 'co.jp', 'com.br', 'co.nz', 'com.sg', 'co.za', 'com.tr', 'co.id', 'com.mx']);
    return (c.length >= 3 && twoPart.has(c.slice(-2).join('.'))) ? c[c.length - 3] : c[c.length - 2];
}
function emailDomainCore(email) { const d = String(email || '').split('@')[1] || ''; return coreLabel(d); }

// Pick the best EMPLOYER contact email from page text: must be on the employer's own domain
// (so a stray third-party email like help@meltwater.com on a Primetals page is never chosen),
// not a no-reply/legal mailbox; recruitment-style inboxes preferred. Returns null if none.
function pickEmployerContactEmail(text, employerHost) {
    const empCore = coreLabel(employerHost);
    if (!text || !empCore) return null;
    const emails = [...String(text).matchAll(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi)].map((mm) => mm[0].toLowerCase());
    const cands = [...new Set(emails)].filter((e) => {
        const local = e.split('@')[0];
        return emailDomainCore(e) === empCore && !_NOREPLY_LOCAL.test(local) && !_TRACKER_DOM.test(e.split('@')[1]);
    });
    if (!cands.length) return null;
    cands.sort((a, b) => (_HR_LOCAL.test(a.split('@')[0]) ? 0 : 1) - (_HR_LOCAL.test(b.split('@')[0]) ? 0 : 1));
    return cands[0];
}

// Scans the careers page for generic recruitment inboxes to use as a FALLBACK contact when a
// job has none. Only keeps addresses that are (a) the employer's own domain, OR (b) a generic
// HR inbox (careers@/jobs@/recruiting@…) — and NEVER a third-party tracker or no-reply mailbox.
// (This is what stops a Meltwater/consent-widget email from being shown as the recruiter.)
function extractHrEmails(rawHtml = '', pageText = '', employerHost = '') {
    const empCore = coreLabel(employerHost);
    const found = new Set();
    const consider = (raw) => {
        const email = String(raw).toLowerCase().split('?')[0].trim();
        if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(email)) return;
        const [local, dom] = email.split('@');
        if (_TRACKER_DOM.test(dom) || _NOREPLY_LOCAL.test(local)) return;
        const sameEmployer = empCore && coreLabel(dom) === empCore;
        if (sameEmployer || _HR_LOCAL.test(local)) found.add(email);
    };
    let m;
    const mailtoRe = /mailto:([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})/gi;
    while ((m = mailtoRe.exec(rawHtml)) !== null) consider(m[1]);
    const emailRe = /\b([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})\b/g;
    const combined = (rawHtml + ' ' + pageText).toLowerCase();
    while ((m = emailRe.exec(combined)) !== null) consider(m[1]);
    // Employer-domain addresses first (most trustworthy), then generic HR inboxes.
    return [...found]
        .sort((a, b) => ((empCore && emailDomainCore(a) === empCore) ? 0 : 1) - ((empCore && emailDomainCore(b) === empCore) ? 0 : 1))
        .slice(0, 5);
}

// ─── Scrape audit logger ──────────────────────────────────────────────────────
// Writes one row to ai_hub_scrape_log for every completed search.
// Table is created lazily on first write (no migration required).
async function logScrapeAudit({ userId, employerDomain, companyName, inputUrl,
    phase1Found, phase2Saved, hadSitemap, hadJobLinks,
    usedGoogleSearch, hadListingPageFallback, commonEmails, failureReason, pageTextSnippet }) {
    try {
        // Ensure table exists (idempotent — safe to run every time)
        await dbConfig.run(`
            CREATE TABLE IF NOT EXISTS ai_hub_scrape_log (
                id                      SERIAL PRIMARY KEY,
                user_id                 INTEGER,
                employer_domain         VARCHAR(255),
                company_name            VARCHAR(255),
                input_url               TEXT,
                phase_1_found           INTEGER DEFAULT 0,
                phase_2_saved           INTEGER DEFAULT 0,
                had_sitemap             BOOLEAN DEFAULT false,
                had_job_links           BOOLEAN DEFAULT false,
                used_google_search      BOOLEAN DEFAULT false,
                had_listing_page_fallback BOOLEAN DEFAULT false,
                common_emails           TEXT,
                failure_reason          TEXT,
                page_text_snippet       TEXT,
                created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await dbConfig.run(`
            INSERT INTO ai_hub_scrape_log
                (user_id, employer_domain, company_name, input_url,
                 phase_1_found, phase_2_saved, had_sitemap, had_job_links,
                 used_google_search, had_listing_page_fallback,
                 common_emails, failure_reason, page_text_snippet)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `, [
            userId, employerDomain, companyName, inputUrl,
            phase1Found, phase2Saved, hadSitemap, hadJobLinks,
            usedGoogleSearch, hadListingPageFallback,
            JSON.stringify(commonEmails || []),
            failureReason || null,
            pageTextSnippet || null,
        ]);
        if (phase2Saved === 0) {
            console.warn(`[aiHub][audit] 0 jobs saved for "${companyName}" (${inputUrl}) — reason: ${failureReason || 'unknown'}`);
        }
    } catch (e) {
        // Non-fatal — never block the main flow
        console.error('[aiHub][audit] Failed to write scrape log:', e.message);
    }
}

// ─── Background processing ────────────────────────────────────────────────────

// A real job title has letters and isn't a bare number/price. Filters out the junk the
// scrape sometimes hallucinates on non-careers pages (e.g. "1000", "43", "€2,500").
function isPlausibleJobTitle(t) {
    if (!t || typeof t !== 'string') return false;
    const s = t.trim();
    if (s.length < 3) return false;
    if (!/[a-zA-ZÀ-ɏ]{2,}/.test(s)) return false;   // must contain ≥2 letters (incl. accented)
    if (/^[\d\s.,%+\-€$£¥]+$/.test(s)) return false;          // pure number / price
    return true;
}

async function processJobSearch(asyncJobId, userId, companyInput, userProfile) {
    console.log(`[aiHub] Starting job search for "${companyInput}" (jobId: ${asyncJobId})`);
    try {
        await jobService.startJob(asyncJobId);

        // Determine a URL to scrape
        const isUrl = companyInput.startsWith('http://') || companyInput.startsWith('https://');
        let scrapeUrl = isUrl ? companyInput : await resolveCareersUrl(companyInput);
        console.log(`[aiHub] Scraping: ${scrapeUrl}`);

        // ── Self-improving fix loop: apply a learned override for this employer ──
        // If the diagnostic agent previously found a working fix for this domain, use it.
        //  • careers_url → redirect the scrape to the real jobs URL (normal flow handles it)
        //  • api / jsonld → pull the jobs directly and skip discovery
        let overrideJobs = null;
        let pendingOverrideFc = null;   // expensive api/jsonld/render override — apply only on cache miss (M20)
        try {
            const ov = await employerFix.getActiveOverride(extractDomain(scrapeUrl));
            if (ov && ov.fix_config) {
                const fc = ov.fix_config;
                if (fc.kind === 'careers_url' && fc.url) {
                    // Cheap string redirect — must happen before the cache key is computed.
                    console.log(`[aiHub] Override (careers_url) for ${extractDomain(scrapeUrl)} → ${fc.url}`);
                    scrapeUrl = fc.url;
                } else if (fc.kind === 'api' || fc.kind === 'jsonld' || fc.kind === 'render_ai') {
                    // Defer the expensive fetch (Playwright/API) until we know the cache missed.
                    pendingOverrideFc = fc;
                }
            }
        } catch (e) { console.error('[aiHub] override lookup error:', e.message); }

        // ── Opt-5: Cache check — serve from DB if employer was scraped recently ──
        const domain = extractDomain(scrapeUrl);
        const cachedEmployer = await jobService.getRecentEmployerData(domain, CACHE_TTL_HOURS);
        if (cachedEmployer) {
            console.log(`[aiHub] Cache hit for "${domain}" (scraped within ${CACHE_TTL_HOURS}h) — skipping all AI calls`);
            await jobService.trackUserEmployer(userId, cachedEmployer.id);
            await dbConfig.run(
                `UPDATE user_tracked_employers SET async_job_id = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND employer_id = $3`,
                [asyncJobId, userId, cachedEmployer.id]
            );
            const cachedObj = await jobService.buildCachedEmployerObject(cachedEmployer, userId, asyncJobId);
            await jobService.completeJob(asyncJobId, cachedObj);
            console.log(`[aiHub] Cache served: ${cachedObj.jobs.length} jobs for "${cachedEmployer.name}"`);
            return;
        }

        // Cache missed — NOW run the deferred (expensive) override fetch. (M20)
        if (pendingOverrideFc) {
            const applied = await applyOverride(pendingOverrideFc).catch(() => null);
            if (applied && applied.jobs && applied.jobs.length) {
                overrideJobs = applied;
                console.log(`[aiHub] Override (${pendingOverrideFc.kind}) for ${domain} → ${applied.jobs.length} jobs`);
            }
        }

        // ── Early STATIC ATS detection (root + /careers) — BEFORE the heavy scrape ──
        // If the employer runs a known ATS (Ashby/Greenhouse/… on the root OR a /careers
        // subpage — e.g. Notion), pull the full structured listing in ~5s and skip the
        // slow Playwright scrape entirely. Provenance-guarded, so no wrong-employer jobs.
        const domainName = (domain.split('.')[0] || domain).replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        let atsApiResult = overrideJobs
            ? { ats: 'override', companyName: overrideJobs.companyName || domainName, jobs: overrideJobs.jobs }
            : null;
        if (!atsApiResult) {
            try {
                const careersAts = await aiJobExtractor.detectAtsOnCareers(scrapeUrl);
                if (careersAts && careersAts.jobs.length) {
                    atsApiResult = { ats: careersAts.ats, companyName: careersAts.employer || domainName, jobs: careersAts.jobs };
                    console.log(`[aiHub] ATS detected early (${careersAts.ats}): ${careersAts.jobs.length} jobs @ ${careersAts.sourceUrl} — skipping heavy scrape`);
                }
            } catch (e) { console.error('[aiHub] early ATS check error:', e.message); }
        }

        // ── LIGHT careers-page scrape — ONLY if we don't already have ATS jobs ──
        // Fast static-only pass (no fallback-URL cascade): just enough for the backup ATS
        // check + pageText context. The slow brute-force discovery is deferred — sitemap and
        // the AI extractor (their own smart discovery) run next, and the heavy cascade is a
        // last resort. This is what turns a 4-minute SPA search into well under a minute.
        let pageData = { pageText: '', rawHtml: '', jobLinks: [] };
        let heavyScrapeDone = false;
        if (!atsApiResult || !atsApiResult.jobs.length) {
            pageData = await fetchCareersPageData(scrapeUrl, { light: true }).catch(() => ({ pageText: '', rawHtml: '', jobLinks: [] }));
            console.log(`[aiHub] Light scrape: ${pageData.jobLinks.length} job links found`);
            // Root ATS detection on the scraped HTML (backup to the static check above).
            if (!atsApiResult) {
                try { atsApiResult = await detectAndFetchAts(scrapeUrl, pageData.rawHtml); }
                catch (e) { console.error('[aiHub] ATS API discovery error:', e.message); }
            }
        }

        let listingData;
        let rawJobs;
        // Whether the chosen source already passed a relevance/junk check, so the post-block
        // validateExtraction doesn't run a second time. Declared here (not inside the else)
        // so it's in scope at the post-block check below. (M13)
        let alreadyValidated = false;
        let validationContext = '';   // text of the page the jobs were actually found on (for the post-block validate)
        if (atsApiResult && atsApiResult.jobs.length > 0) {
            listingData = {
                company_name: atsApiResult.companyName,
                careers_page_url: scrapeUrl,
                sub_info: `${atsApiResult.jobs.length} open role${atsApiResult.jobs.length === 1 ? '' : 's'}`,
                jobs: atsApiResult.jobs,
            };
            rawJobs = atsApiResult.jobs;
            // ATS jobs are already provenance-guarded; the post-block validate would only run
            // with blank pageText context here (weak, pointless) — skip it. (L2)
            alreadyValidated = true;
            console.log(`[aiHub] ATS "${atsApiResult.ats}" API: ${rawJobs.length} jobs for "${atsApiResult.companyName}" — using API data (no scrape discovery)`);
        } else {
        // ── Non-ATS discovery: sitemap (validated) → NEW AI extractor → legacy ─
        let resolved = false;

        // 1) ATS sitemap (SAP SuccessFactors / Workday — e.g. PORR's 670). Cheap, full
        //    listing. BUT only trust it if the titles are REAL jobs — many sites expose a
        //    sitemap of generic pages that merely match the URL pattern (e.g. ebcont's 56).
        // Cap the sitemap probe — some sites (notion) have enormous sitemaps that would
        // otherwise stall the search for minutes before the AI extractor even runs.
        let sitemapJobs = [];
        try {
            sitemapJobs = await Promise.race([
                discoverSitemapJobUrls(scrapeUrl, domain, CONSIDER_LIMIT),
                new Promise((_, rej) => setTimeout(() => rej(new Error('sitemap probe timeout')), 12000)),
            ]);
        } catch (e) { console.error('[aiHub] ATS sitemap probe:', e.message); sitemapJobs = []; }
        if (sitemapJobs.length >= 10) {
            const sv = await validateExtraction({ employerName: domainName, domain, context: (pageData.pageText || '').slice(0, 700), jobs: sitemapJobs.slice(0, 40) }).catch(() => ({ ok: true }));
            if (sv.ok) {
                rawJobs = sitemapJobs.map(j => ({ ...j, _ats: true }));
                listingData = { company_name: domainName, careers_page_url: scrapeUrl, sub_info: `${rawJobs.length} open role${rawJobs.length === 1 ? '' : 's'}`, jobs: rawJobs };
                console.log(`[aiHub] Sitemap: ${rawJobs.length} jobs for "${domain}" (validated)`);
                resolved = true;
                alreadyValidated = true;   // sv.ok above already vouched for these titles (M13)
            } else {
                console.log(`[aiHub] Sitemap ${sitemapJobs.length} jobs REJECTED as junk (${sv.reason}) — using AI extractor`);
            }
        }

        // 2) NEW optimized extractor (trim → ONE LLM call → strict English JSON). The
        //    primary technique for custom sites: fast, reliable, multilingual.
        if (!resolved) {
            let exResult = null;
            // Hard cap the extractor — a pathological SPA can otherwise keep rendering candidate
            // pages for minutes. 140s covers legit hard-SPA cases (Adyen ~110s, celonis ~85s)
            // with margin for network variance, while still bounding the worst case. findAndExtract
            // self-budgets its facet→board exploration well under this. (M1/Limit 1)
            try {
                exResult = await Promise.race([
                    aiJobExtractor.findAndExtract(scrapeUrl, domain),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('extractor timeout')), 140000)),
                ]);
            } catch (e) { console.error('[aiHub] aiJobExtractor error:', e.message); }
            // Self-audit signal from the extractor's LLM (Extraction_Audit). Surfaced for
            // observability and to force deep per-job enrichment when the listing was teasers-only.
            const exAudit = exResult && exResult.audit;
            if (exAudit) console.log(`[aiHub] Extraction audit @ ${exResult.sourceUrl || scrapeUrl}: density=${exAudit.density} deepRecrawl=${exAudit.requiresDeepRecrawl} — "${exAudit.notes}"`);
            if (exResult && exResult.jobs && exResult.jobs.length) {
                rawJobs = exResult.jobs;
                listingData = { company_name: exResult.employer || domainName, careers_page_url: exResult.sourceUrl || scrapeUrl, sub_info: `${rawJobs.length} open role${rawJobs.length === 1 ? '' : 's'}`, jobs: rawJobs };
                console.log(`[aiHub] AI extractor: ${rawJobs.length} jobs for "${listingData.company_name}" @ ${exResult.sourceUrl}`);
                // When the AI flags the listing as Low-density / teasers-only, guarantee Phase-2
                // detail enrichment visits every job's own page (don't let any thin job pass through).
                if (exAudit && (exAudit.requiresDeepRecrawl || /^low/i.test(exAudit.density))) {
                    let forced = 0;
                    for (const j of rawJobs) {
                        const realUrl = j.job_url && !/#role-/.test(j.job_url);
                        if (realUrl && j._atsApi) { j._atsApi = false; forced++; }
                    }
                    if (forced) console.log(`[aiHub] Audit forced deep enrichment on ${forced} thin job(s)`);
                }
                resolved = true;
                // Validate against the page the jobs were ACTUALLY found on (e.g. /careers), not
                // the light homepage scrape — else real jobs get rejected as "no jobs on this page".
                validationContext = exResult.pageText || '';
                // NOTE: do NOT mark alreadyValidated here. The AI-extractor path has no prior
                // validation, and its prompt can be fooled by job-shaped non-jobs (e.g. Typeform's
                // "Job Application Form" TEMPLATES). The post-block validateExtraction is this
                // path's only relevance backstop — keep it. (regression caught in testing)
            }
        }

        // 3) Legacy scrape discovery — LAST RESORT (sitemap + AI extractor both came up empty).
        //    NOW run the heavy fetchCareersPageData cascade (sub-section / fallback-URL / career-
        //    page discovery) that we deferred — only here, only when nothing else worked.
        if (!resolved) {
            if (pageData.jobLinks.length < 3 && !heavyScrapeDone) {
                console.log(`[aiHub] Nothing found yet — running full discovery cascade as last resort…`);
                const heavy = await fetchCareersPageData(scrapeUrl).catch(() => null);
                if (heavy) pageData = heavy;
                heavyScrapeDone = true;
            }
            if (pageData.jobLinks.length >= 3) listingData = buildListingDataFromHtml(pageData.jobLinks, pageData.rawHtml, scrapeUrl);
            else listingData = await findJobListings(companyInput, pageData, userProfile);
            rawJobs = (listingData.jobs || []).filter(j => j.title);
            console.log(`[aiHub] Legacy scrape: ${rawJobs.length} jobs for "${listingData.company_name}"`);
        }
        }

        // Drop hallucinated junk titles (bare numbers/prices, too short) that the scrape
        // sometimes returns on non-careers pages (e.g. a marketing homepage).
        const beforeJunk = rawJobs.length;
        rawJobs = rawJobs.filter(j => isPlausibleJobTitle(j && j.title));
        if (rawJobs.length !== beforeJunk) console.log(`[aiHub] Dropped ${beforeJunk - rawJobs.length} junk-title job(s)`);

        // Resolve domain (domain was already declared above for cache check; re-use here)
        const careersUrl = listingData.careers_page_url || scrapeUrl || companyInput;
        const name = listingData.company_name || companyInput;
        const logoColor = logoColorFor(name);

        // Persist employer + link to user
        const employerDbId = await jobService.upsertEmployer(domain, name, listingData.sub_info, logoColor, (name[0] || '?').toUpperCase());
        await jobService.trackUserEmployer(userId, employerDbId);

        // Link this async_job to the user's tracking row
        await dbConfig.run(
            `UPDATE user_tracked_employers SET async_job_id = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND employer_id = $3`,
            [asyncJobId, userId, employerDbId]
        );

        // Emit initial partial update so the UI shows the employer card immediately
        const initialEmployer = buildEmployerObject(employerDbId, asyncJobId, listingData, logoColor, [], domain);
        await jobService.updateJobPartialResult(asyncJobId, initialEmployer);

        // ── Minimum AI sanity check ───────────────────────────────────────────
        // Before trusting whatever the scrape produced, ask a cheap model: are these
        // REAL job postings that belong to THIS employer? This catches the case where
        // the scrape returns a few junk/irrelevant "jobs" (nav labels, a mis-detected
        // board, wrong-industry results) that look title-shaped and would otherwise be
        // accepted. On failure we drop them and let the agent find the real source.
        if (rawJobs.length > 0 && !alreadyValidated) {
            // Use the page the jobs were actually found on (AI extractor's source page) as
            // context, falling back to the homepage scrape. Validating real /careers jobs
            // against the homepage text wrongly rejected them (e.g. novulo).
            const valCtx = (validationContext || pageData.pageText || '').slice(0, 700);
            const val = await validateExtraction({
                employerName: listingData.company_name, domain,
                context: valCtx, jobs: rawJobs,
            }).catch(() => ({ ok: true }));
            if (!val.ok) {
                console.log(`[aiHub] Result validation FAILED for "${domain}" (${rawJobs.length} jobs): ${val.reason} — discarding & invoking agent`);
                rawJobs = [];
            }
        }

        // ── Silent self-improving fix loop ────────────────────────────────────
        // None of our normal methods found jobs. Instead of bothering the user with a
        // "submit a request?" popup, we silently dispatch the AI agent INLINE: it
        // investigates the employer, and if it finds verifiable jobs we return them in
        // THIS same search — the user just sees an encouraging "learning" message and
        // then the jobs appear. Everything is logged for the admin dashboard. We skip
        // the (slow, paid) agent on domains it already failed to crack recently.
        if ((rawJobs.length === 0 || _agentWorthyThin(careersUrl, rawJobs.length)) && /\./.test(companyInput)) {
            if (rawJobs.length > 0) console.log(`[aiHub] Result for "${domain}" looks incomplete (${rawJobs.length} job(s) from a detail-looking page ${careersUrl}) — auto-escalating to the agent to find the full board.`);
            try {
                const dead = await employerFix.recentDeadAttempt(domain).catch(() => null);
                if (dead) {
                    console.log(`[aiHub] Silent agent skipped for "${domain}" — recent ${dead.status} attempt (#${dead.id}); graceful empty.`);
                } else {
                    // Show the "we're learning this employer" message while the agent works.
                    await jobService.updateJobPartialResult(asyncJobId, {
                        ...initialEmployer, learning: true,
                        learningMessage: "New employer — we're training our system to read it. Hang tight…",
                    });
                    const userRow = await dbConfig.get(`SELECT email FROM users WHERE id = ?`, [userId]).catch(() => null);
                    const reqId = await employerFix.createFixRequest({
                        userId, email: userRow && userRow.email, employerInput: companyInput, domain,
                    });
                    await employerFix.updateRequest(reqId, { status: 'investigating' });
                    console.log(`[aiHub] Silent agent investigating "${domain}" (request #${reqId})…`);
                    const t0 = Date.now();
                    const result = await investigateEmployer(scrapeUrl).catch(e => { console.error('[aiHub] silent agent error:', e.message); return null; });
                    const took = ((Date.now() - t0) / 1000).toFixed(0);
                    if (result && result.verified && result.fixConfig && result.jobs && result.jobs.length > rawJobs.length) {
                        await employerFix.saveOverride({
                            domain, requestId: reqId, fixConfig: result.fixConfig, verified: true,
                            verifyJobCount: result.jobCount, verifySample: result.sample, createdBy: 'agent',
                            notes: `auto (silent) via ${result.diagnosis && result.diagnosis.method}`,
                        });
                        await employerFix.updateRequest(reqId, {
                            status: 'resolved', diagnosis: result.diagnosis, jobCount: result.jobCount,
                            detectedAts: (result.diagnosis && (result.diagnosis.ats || result.diagnosis.method)) || null, resolved: true,
                        });
                        rawJobs = result.jobs.map(j => ({ ...j, _atsApi: true }));
                        console.log(`[aiHub] Silent agent FIXED "${domain}" in ${took}s → ${rawJobs.length} jobs (${result.fixConfig.kind}); returning inline.`);
                    } else {
                        await employerFix.updateRequest(reqId, {
                            status: (result && result.status === 'needs_review') ? 'needs_review' : 'failed',
                            diagnosis: result && result.diagnosis, jobCount: 0,
                        });
                        console.log(`[aiHub] Silent agent could not crack "${domain}" in ${took}s — graceful empty (logged #${reqId}).`);
                    }
                }
            } catch (e) { console.error('[aiHub] silent fix loop error:', e.message); }
        }

        // ── Extract common HR/careers emails from the page ────────────────────
        // Scan mailto links + plain-text patterns for generic recruitment addresses.
        // These will be attached as a fallback contact on jobs that have no contacts.
        const hrEmails = extractHrEmails(pageData.rawHtml, pageData.pageText, domain);
        if (hrEmails.length > 0) {
            console.log(`[aiHub] Found HR emails on careers page: ${hrEmails.join(', ')}`);
        }

        // Phase 2 — extract full details in batches of DETAIL_BATCH_SIZE, BATCH_CONCURRENCY at a time
        //
        // Jobs without an individual job_url (e.g. scraped from a listing-only page, or
        // returned by Google Search without deep links) are assigned the careers listing page
        // URL and flagged as listing_page_only=true so fetchJobDetailsBatch can use the
        // already-scraped page text instead of wasting a Playwright fetch.
        // Also normalize URLs (strip pagination params) and dedup to prevent the same job
        // appearing multiple times with ?page=2, ?page=3, etc. appended.
        // Dedup safety net. Two cases:
        //  • Real detail URL  → dedup by URL (keeps genuinely distinct same-title roles).
        //  • Listing-page-only or synthetic "#role-N" fragment (AI-extracted) → dedup by
        //    normalized title+location. This is what stops a looping slider/carousel (which
        //    clones the same jobs) from adding the same role over and over.
        const _normTL = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        const seenJobSig = new Set();
        const validJobs = rawJobs
            .map(j => {
                if (!j.job_url) return { ...j, job_url: careersUrl, listing_page_only: true };
                return { ...j, job_url: normalizeJobUrl(j.job_url) };
            })
            .filter(j => {
                const synthetic = j.listing_page_only || /#role-\d+$/.test(j.job_url || '');
                const sig = synthetic
                    ? `t:${_normTL(j.title)}|${_normTL(j.location)}`
                    : `u:${(j.job_url || '').split('#')[0]}`;
                if (seenJobSig.has(sig)) {
                    console.log(`[aiHub] Dedup: skipping repeated job "${j.title || j.job_url}" (${synthetic ? 'content' : 'url'})`);
                    return false;
                }
                seenJobSig.add(sig);
                return true;
            });
        const listingPageText = pageData.pageText || pageData.markdown || '';
        const streamedJobs = [];

        // ── Best-200 split ────────────────────────────────────────────────────
        // Display at most STORE_LIMIT jobs. If the employer has more, stream the first
        // STORE_LIMIT fast (Phase A), then upgrade them with better-matching overflow
        // jobs (Phase B, below). Flags drive the "more than N positions" UI label.
        const totalOpen = validJobs.length;
        const phaseAJobs = validJobs.slice(0, STORE_LIMIT);
        const overflowJobs = validJobs.slice(STORE_LIMIT);
        listingData.total_open = totalOpen;
        listingData.more_available = overflowJobs.length > 0;

        // ── Detail-recipe (learn-once-apply-to-all) ───────────────────────────
        // For the free sitemap (_ats) path: make sure we can pull the required detail
        // fields for THIS employer's page template. If a recipe already exists, use it.
        // Otherwise peek at 1-2 sample pages; if the generic parser is systematically
        // missing fields, let the agent learn a recipe from those samples (1 AI call)
        // and apply it to EVERY job below. Fully additive — never removes good data.
        let detailRecipe = null;
        if (validJobs.length >= 3 && validJobs.every(j => j._ats)) {
            try {
                const hasFields = (r) => r && Object.keys(r).some(k => r[k]);
                const existing = await detailRecipeStore.getRecipe(domain).catch(() => null);
                if (existing) {
                    detailRecipe = hasFields(existing.recipe) ? existing.recipe : null;   // {} = "checked, generic parser is fine"
                    if (detailRecipe) console.log(`[aiHub] Detail recipe in place for "${domain}" (recovers: ${existing.fields_recovered || 'n/a'})`);
                } else {
                    const picks = [phaseAJobs[0], phaseAJobs[Math.floor(phaseAJobs.length / 2)]].filter(Boolean);
                    const samples = (await Promise.all(picks.map(async p => {
                        try { return { url: p.job_url, html: await fetchJobPage(p.job_url) }; } catch { return null; }
                    }))).filter(Boolean);
                    if (samples.length) {
                        const parsedSamples = samples.map(s => parseAtsJobPage(s.html, s.url));
                        const quality = assessDetailQuality(parsedSamples);
                        if (!quality.missingFields.length) {
                            // Generic parser already covers this employer — mark checked so we don't peek again.
                            await detailRecipeStore.saveRecipe({ domain, recipe: {}, verified: true, fieldsRecovered: [], sampleUrl: samples[0].url }).catch(() => {});
                        } else {
                            console.log(`[aiHub] Detail extraction weak for "${domain}" (missing: ${quality.missingFields.join(',')}) — learning recipe from ${samples.length} sample(s)…`);
                            const learned = await learnDetailRecipe(samples, quality.missingFields).catch(e => { console.error('[aiHub] learnDetailRecipe error:', e.message); return null; });
                            if (learned && learned.recipe) {
                                detailRecipe = hasFields(learned.recipe) ? learned.recipe : null;
                                await detailRecipeStore.saveRecipe({ domain, recipe: learned.recipe, verified: learned.verifiedFields.length > 0, fieldsRecovered: learned.verifiedFields, sampleUrl: samples[0].url }).catch(() => {});
                                console.log(`[aiHub] Detail recipe learned for "${domain}" — now recovers: ${learned.verifiedFields.join(',') || 'none'}`);
                            }
                        }
                    }
                }
            } catch (e) { console.error('[aiHub] detail-recipe step error:', e.message); }
        }

        // Split Phase-A jobs into batches of DETAIL_BATCH_SIZE
        const allBatches = [];
        for (let i = 0; i < phaseAJobs.length; i += DETAIL_BATCH_SIZE) {
            allBatches.push(phaseAJobs.slice(i, i + DETAIL_BATCH_SIZE));
        }

        console.log(`[aiHub] Phase 2: ${phaseAJobs.length}/${totalOpen} jobs (${phaseAJobs.filter(j => j.listing_page_only).length} listing-page-only) → ${allBatches.length} batches (size=${DETAIL_BATCH_SIZE}, concurrency=${BATCH_CONCURRENCY})${overflowJobs.length ? ` — ${overflowJobs.length} overflow for best-200 ranking` : ''}`);

        // Process BATCH_CONCURRENCY batches in parallel, then save results in order
        for (let b = 0; b < allBatches.length; b += BATCH_CONCURRENCY) {
            const concurrentSlice = allBatches.slice(b, b + BATCH_CONCURRENCY);

            // Fire all batches in this slice concurrently
            const sliceResults = await Promise.allSettled(
                concurrentSlice.map((batch, sliceIdx) => {
                    const batchNum = b + sliceIdx + 1;
                    console.log(`[aiHub] Phase 2 batch ${batchNum}/${allBatches.length}: scraping ${batch.length} pages in parallel`);
                    return fetchJobDetailsBatch(batch, careersUrl, userProfile, listingPageText, detailRecipe)
                        .then(results => ({ batch, results }));
                })
            );

            // Persist each batch's results in order and stream to UI
            for (const settled of sliceResults) {
                const { batch, results: detailedJobs } = settled.status === 'fulfilled'
                    ? settled.value
                    : { batch: concurrentSlice[sliceResults.indexOf(settled)], results: [] };

                if (settled.status === 'rejected') {
                    console.error(`[aiHub] Batch failed:`, settled.reason?.message);
                }

                // ── Use employer name from first AI result to fix Phase-1 bad name ──
                // Phase-1 HTML extraction often picks up nav labels like "Back ButtonSearch Icon".
                // The AI reads the actual page content and returns the correct company name.
                if (streamedJobs.length === 0 && detailedJobs && detailedJobs.length > 0) {
                    const aiEmployerName = detailedJobs.find(j => j?.employer_name)?.employer_name;
                    if (aiEmployerName && aiEmployerName.length > 1 && aiEmployerName.length < 80) {
                        console.log(`[aiHub] Overriding company name: "${listingData.company_name}" → "${aiEmployerName}"`);
                        listingData.company_name = aiEmployerName;
                        // Update the DB row so cached loads also show the correct name
                        await dbConfig.run(
                            `UPDATE employers SET name = $1 WHERE id = $2`,
                            [aiEmployerName, employerDbId]
                        ).catch(() => {});
                    }
                }

                for (let j = 0; j < batch.length; j++) {
                    const raw = (detailedJobs && detailedJobs[j]) ? detailedJobs[j] : {};
                    const original = batch[j];

                    // Fallback to Phase 1 title/url if Gemini missed it
                    if (!raw.title)   raw.title   = original.title;
                    if (!raw.job_url) raw.job_url = original.job_url;

                    // Persist (job + skills + contacts + user match, UNSCORED — match % is lazy).
                    const dbJobId = await persistOneJob(raw, original.job_url, employerDbId, userId, hrEmails);
                    streamedJobs.push(buildJobFromRaw(raw, streamedJobs.length, employerDbId, careersUrl, dbJobId));
                }

                // Emit partial update after each batch so the UI shows new cards progressively
                const partialEmployer = buildEmployerObject(employerDbId, asyncJobId, listingData, logoColor, [...streamedJobs], domain);
                await jobService.updateJobPartialResult(asyncJobId, partialEmployer);
                console.log(`[aiHub] Streamed ${streamedJobs.length} jobs so far`);
            }
        }

        // ── Phase B — best-200 live upgrade ───────────────────────────────────
        // The first STORE_LIMIT jobs are shown. If there are more open roles AND the user
        // has a resume to rank against, fetch + match-score the overflow and swap any job
        // that beats the current weakest kept match — converging on the best STORE_LIMIT
        // for THIS user. Only the kept set stays in the DB (evicted jobs are deleted), so
        // the per-employer cache remains the displayed set. No profile → keep the first set.
        const userHasProfile = Array.isArray(userProfile?.skills) && userProfile.skills.length > 0;
        if (overflowJobs.length > 0 && userHasProfile && streamedJobs.length >= STORE_LIMIT) {
            try {
                console.log(`[aiHub] Best-200: ranking ${overflowJobs.length} overflow against the kept ${streamedJobs.length} for "${name}"`);
                // Score the kept set so we know each one's match strength.
                const keptScores = await scoreJobsForUser(userProfile, streamedJobs.map(j => ({ id: j.id, title: j.title, skills: j.skills, responsibilities: j.responsibilities }))).catch(() => ({}));
                for (const j of streamedJobs) {
                    j._score = keptScores[String(j.id)] ?? 0;
                    if (j.id) { j.matchScore = j._score; await jobService.saveUserJobMatch(userId, j.id, j._score).catch(() => {}); }
                }

                const OV_ROUND = DETAIL_BATCH_SIZE * BATCH_CONCURRENCY;
                let swaps = 0;
                for (let i = 0; i < overflowJobs.length; i += OV_ROUND) {
                    const round = overflowJobs.slice(i, i + OV_ROUND);
                    // Fetch details for this round (sub-batched, same as Phase A).
                    const detailed = [];
                    for (let s = 0; s < round.length; s += DETAIL_BATCH_SIZE) {
                        const sub = round.slice(s, s + DETAIL_BATCH_SIZE);
                        const res = await fetchJobDetailsBatch(sub, careersUrl, userProfile, listingPageText, detailRecipe).catch(() => []);
                        for (let k = 0; k < sub.length; k++) {
                            const raw = (res && res[k]) ? res[k] : {};
                            if (!raw.title) raw.title = sub[k].title;
                            if (!raw.job_url) raw.job_url = sub[k].job_url;
                            detailed.push({ raw, jobUrl: sub[k].job_url });
                        }
                    }
                    // Score this round and swap any that beat the current weakest kept job.
                    const ovScores = await scoreJobsForUser(userProfile, detailed.map((d, k) => ({ id: 'ov-' + (i + k), title: d.raw.title, skills: d.raw.skills, responsibilities: d.raw.responsibilities }))).catch(() => ({}));
                    let changed = false;
                    for (let k = 0; k < detailed.length; k++) {
                        const s = ovScores['ov-' + (i + k)] ?? 0;
                        let minIdx = 0;
                        for (let m = 1; m < streamedJobs.length; m++) if ((streamedJobs[m]._score ?? 0) < (streamedJobs[minIdx]._score ?? 0)) minIdx = m;
                        if (s > (streamedJobs[minIdx]._score ?? 0)) {
                            const evicted = streamedJobs[minIdx];
                            // Per-user eviction — only drops the shared job if no other user
                            // still tracks it (prevents cross-user data loss). (H4/M22)
                            if (evicted.id) await jobService.evictUserJob(evicted.id, userId).catch(() => {});
                            const newId = await persistOneJob(detailed[k].raw, detailed[k].jobUrl, employerDbId, userId, hrEmails, s);
                            const newJob = buildJobFromRaw(detailed[k].raw, minIdx, employerDbId, careersUrl, newId);
                            newJob._score = s; newJob.matchScore = s;
                            streamedJobs[minIdx] = newJob;
                            changed = true; swaps++;
                        }
                    }
                    if (changed) {
                        const sorted = [...streamedJobs].sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
                        await jobService.updateJobPartialResult(asyncJobId, buildEmployerObject(employerDbId, asyncJobId, listingData, logoColor, sorted, domain));
                    }
                }
                streamedJobs.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
                console.log(`[aiHub] Best-200: done — ${swaps} swap(s); kept set is now the best ${streamedJobs.length} of ${totalOpen} for the user`);
            } catch (e) {
                console.error('[aiHub] Best-200 ranking error:', e.message);
            }
        }

        // Mark the job complete. (Failed discoveries are handled silently inline above
        // by the AI agent; if we still have 0 jobs here, it's a graceful empty result —
        // no popups. The attempt is already logged for the admin dashboard.)
        const finalEmployer = buildEmployerObject(employerDbId, asyncJobId, listingData, logoColor, streamedJobs, domain);
        await jobService.completeJob(asyncJobId, finalEmployer);
        console.log(`[aiHub] Completed "${name}": ${streamedJobs.length} jobs saved`);

        // ── Audit log — always write, critical context when jobs = 0 ─────────
        await logScrapeAudit({
            userId,
            employerDomain: domain,
            companyName: name,
            inputUrl: companyInput,
            phase1Found: rawJobs.length,
            phase2Saved: streamedJobs.length,
            hadSitemap: !!(pageData.jobLinks && pageData.jobLinks.length > 0),
            hadJobLinks: (pageData.jobLinks || []).length > 0,
            usedGoogleSearch: rawJobs.some(j => j.listing_page_only),
            hadListingPageFallback: validJobs.some(j => j.listing_page_only),
            commonEmails: hrEmails,
            failureReason: streamedJobs.length === 0
                ? (rawJobs.length === 0 ? 'Phase 1 returned no jobs' : 'All jobs lacked individual URLs and listing-page extraction returned nothing')
                : null,
            pageTextSnippet: (pageData.pageText || '').slice(0, 500),
        });

    } catch (err) {
        console.error('[aiHub] processJobSearch FATAL:', err.message, err.stack?.split('\n').slice(0, 5).join('\n'));
        try { await jobService.failJob(asyncJobId, err.message); } catch {}
    }
}

// ─── Job portal blocklist ─────────────────────────────────────────────────────
// These are generic job boards / aggregators, NOT employer career pages.
// We reject them up-front with a friendly message to protect the AI pipeline.

const JOB_PORTAL_DOMAINS = new Set([
    // India
    'naukri.com', 'shine.com', 'timesjobs.com', 'monsterindia.com', 'freshersworld.com',
    'hirist.com', 'iimjobs.com', 'foundit.in', 'placementindia.com',
    // Global boards
    'indeed.com', 'linkedin.com', 'glassdoor.com', 'monster.com', 'careerbuilder.com',
    'ziprecruiter.com', 'dice.com', 'simplyhired.com', 'snagajob.com', 'jobs.com',
    'jobrapido.com', 'jooble.org', 'adzuna.com', 'reed.co.uk', 'totaljobs.com',
    'cv-library.co.uk', 'jobsite.co.uk', 'cwjobs.co.uk', 'fish4.co.uk',
    // EU boards
    'stepstone.de', 'xing.com', 'arbeitsagentur.de', 'jobware.de', 'stellenanzeigen.de',
    'meinestelle.at', 'karriere.at', 'jobs.ch', 'jobup.ch', 'jobscout24.ch',
    'werkzoeken.nl', 'nationale-vacaturebank.nl', 'intermediair.nl', 'uitzendbureau.nl',
    'emploi.fr', 'apec.fr', 'poleemploi.fr', 'cadremploi.fr', 'keljob.com',
    'infojobs.net', 'tecnoempleo.com', 'infoempleo.com',
    // Asia-Pacific
    'jobstreet.com', 'jobsdb.com', 'seek.com.au', 'seek.co.nz', 'trademe.co.nz',
    'mycareersfuture.gov.sg', 'jobscentral.com.sg',
    // Freelance / gig
    'upwork.com', 'freelancer.com', 'fiverr.com', 'toptal.com', 'guru.com',
    // Tech-specific boards
    'stackoverflow.com', 'angel.co', 'wellfound.com', 'remoteok.com', 'weworkremotely.com',
    'remotive.com', 'hired.com', 'ladders.com',
    // Agency aggregators
    'michaelpage.com', 'hays.com', 'randstad.com', 'adecco.com', 'manpower.com',
    'roberthalf.com', 'kellyservices.com',
    // Gov / public
    'usajobs.gov', 'publicjobs.ie', 'civilservicejobs.service.gov.uk',
]);

/**
 * Normalise user input to a proper URL:
 *  - "experis.com"          → "https://www.experis.com"
 *  - "careers.company.com"  → "https://careers.company.com"
 *  - "https://..."          → unchanged
 */
function normaliseCompanyInput(raw) {
    const trimmed = raw.trim();
    // If it looks like a plain domain or domain/path (no protocol), add https://
    if (!/^https?:\/\//i.test(trimmed)) {
        // Company name (no dots) → return as-is, will be resolved later
        if (!/\./.test(trimmed)) return trimmed;
        return `https://${trimmed.replace(/^\/\//, '')}`;
    }
    return trimmed;
}

/**
 * Returns a user-friendly portal error message, or null if not a portal.
 */
function detectJobPortal(input) {
    let hostname = '';
    try {
        const url = new URL(input.startsWith('http') ? input : `https://${input}`);
        hostname = url.hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return null;
    }
    if (JOB_PORTAL_DOMAINS.has(hostname)) return hostname;
    // Check subdomains: "in.indeed.com" → "indeed.com"
    const parts = hostname.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
        if (JOB_PORTAL_DOMAINS.has(parts.slice(i).join('.'))) return parts.slice(i).join('.');
    }
    return null;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function analyzeWishlist(req, res) {
    return res.json({ matches: 0, sources: 0 });
}

/**
 * GET /api/ai-hub/jobs?company=...
 * Kicks off an async job search and immediately returns { jobId }.
 * The client polls /api/job-status/:jobId for progress + partial results.
 */
async function getJobMatches(req, res) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    let companyInput = (req.query.company || '').trim();
    if (!companyInput) return res.status(400).json({ error: 'company query parameter is required' });

    // ── Normalise URL (add https:// if missing) ───────────────────────────────
    companyInput = normaliseCompanyInput(companyInput);

    // ── Block job portals ─────────────────────────────────────────────────────
    const portalDomain = detectJobPortal(companyInput);
    if (portalDomain) {
        return res.status(422).json({
            error: 'job_portal',
            portal: portalDomain,
            message: `"${portalDomain}" is a job portal, not a company. CVApplyr searches directly on employer career pages to find jobs and hiring contacts. Please enter a specific company name or their career page URL instead.`,
        });
    }

    try {
        const userProfile = await getUserProfile(userId);
        const asyncJobId = await jobService.createJob(userId, 'ai_hub_job_search', { company: companyInput });

        // Non-blocking background processing
        setImmediate(() => processJobSearch(asyncJobId, userId, companyInput, userProfile));

        return res.json({ jobId: asyncJobId });
    } catch (err) {
        console.error('[aiHub] getJobMatches error:', err);
        return res.status(500).json({ error: 'Failed to start job search' });
    }
}

/**
 * GET /api/job-status/:jobId
 * Returns the current status + data (partial or final) of an async job.
 */
async function getJobStatus(req, res) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { jobId } = req.params;
    try {
        const job = await jobService.getJob(jobId, userId);
        if (!job) return res.status(404).json({ error: 'Job not found' });

        return res.json({
            status: job.status,
            progress: job.progress || 0,
            data: job.result || null,
            error: job.error || null,
        });
    } catch (err) {
        console.error('[aiHub] getJobStatus error:', err);
        return res.status(500).json({ error: 'Failed to get job status' });
    }
}

/**
 * GET /api/ai-hub/dashboard
 * Returns the user's saved employers + their job listings from the DB.
 */
async function getDashboard(req, res) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const dashboard = await jobService.getUserDashboard(userId);
        return res.json({ dashboard });
    } catch (err) {
        console.error('[aiHub] getDashboard error:', err);
        return res.status(500).json({ error: 'Failed to load dashboard' });
    }
}

/**
 * DELETE /api/ai-hub/dashboard/:jobId
 * Removes an employer from the user's dashboard (archives the tracking row).
 */
async function removeDashboardItem(req, res) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { jobId } = req.params; // async_job_id (mobile) OR employer_id (web) from the client

    try {
        // Find the employer via the async_job_id link on user_tracked_employers
        let row = await dbConfig.get(
            `SELECT employer_id FROM user_tracked_employers WHERE user_id = $1 AND async_job_id = $2`,
            [userId, jobId]
        );
        // Fallback: the param may be the employer_id directly (web dashboard keys off
        // employer.id because async_job_id is null once a search completes).
        if (!row?.employer_id) {
            row = await dbConfig.get(
                `SELECT employer_id FROM user_tracked_employers WHERE user_id = $1 AND employer_id = $2`,
                [userId, jobId]
            );
        }
        if (row?.employer_id) {
            await jobService.archiveUserEmployer(userId, row.employer_id);
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('[aiHub] removeDashboardItem error:', err);
        return res.status(500).json({ error: 'Failed to remove dashboard item' });
    }
}

async function verifyEmail(req, res) {
    try {
        const { email } = req.body;
        if (!email || typeof email !== 'string') return res.status(400).json({ error: 'email is required' });
        return res.json({ verified: true, confidence: 0.94 });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to verify email' });
    }
}

/**
 * GET /api/ai-hub/credits
 * Returns the authenticated user's current credit balance.
 */
async function getCreditBalance(req, res) {
    try {
        const userId = req.user.id;
        const row = await dbConfig.get(
            'SELECT credits_remaining FROM user_credits WHERE user_id = ?',
            [userId]
        );
        const balance = row ? (row.credits_remaining || 0) : 0;
        return res.json({ success: true, balance });
    } catch (err) {
        console.error('[aiHub] getCreditBalance error:', err);
        return res.status(500).json({ error: 'Failed to fetch credit balance' });
    }
}

/**
 * POST /api/ai-hub/deduct-credits
 * Body: { amount: number }
 * Deducts the specified credit amount from the user's balance.
 * Returns 402 if the user has insufficient credits.
 */
async function deductCredits(req, res) {
    try {
        const userId = req.user.id;
        // Prefer a server-resolved cost when the client names a known event (so the
        // client can't pick its own price); fall back to a raw amount for compatibility.
        const eventKey = typeof req.body.eventKey === 'string' ? req.body.eventKey : null;
        const amount = eventKey ? await getEventCost(eventKey) : (Number(req.body.amount) || 0);

        const row = await dbConfig.get(
            'SELECT credits_remaining FROM user_credits WHERE user_id = ?',
            [userId]
        );
        const current = row ? (row.credits_remaining || 0) : 0;

        if (amount <= 0) {
            return res.json({ success: true, balance: current, charged: 0 }); // free / no-cost event
        }
        if (current < amount) {
            return res.status(402).json({
                error: 'insufficient_credits',
                balance: current,
                required: amount,
            });
        }

        await dbConfig.run(
            'UPDATE user_credits SET credits_remaining = credits_remaining - ? WHERE user_id = ?',
            [amount, userId]
        );
        try {
            await dbConfig.run(
                'INSERT INTO credit_usage_history (user_id, credits_used, action_type, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
                [userId, amount, eventKey || 'deduct']);
        } catch (e) { /* history best-effort */ }

        const updated = await dbConfig.get(
            'SELECT credits_remaining FROM user_credits WHERE user_id = ?',
            [userId]
        );
        return res.json({ success: true, balance: updated ? updated.credits_remaining : current - amount, charged: amount });
    } catch (err) {
        console.error('[aiHub] deductCredits error:', err);
        return res.status(500).json({ error: 'Failed to deduct credits' });
    }
}

async function addContactToJob(req, res) {
    try {
        const { jobId } = req.params;
        const { name, role, email } = req.body;
        if (!name || !role || !email) return res.status(400).json({ error: 'name, role, and email are required' });
        // Persist to job_contacts so it survives navigation / reload (upsert on job_id+email).
        await jobService.addJobContact(jobId, name, role, email, null, null, null, null);
        const contact = {
            id: `contact-${Date.now()}`,
            name, role, email,
            verified: false,
            avatarColor: ['#64748B', '#475569'],
        };
        return res.status(201).json(contact);
    } catch (error) {
        console.error('[aiHub] addContactToJob error:', error.message);
        return res.status(500).json({ error: 'Failed to add contact' });
    }
}

// GET /jobs/:jobId/contacts — reload persisted contacts (so a newly-added one shows on return).
async function getJobContacts(req, res) {
    try {
        const { jobId } = req.params;
        const rows = await dbConfig.query('SELECT * FROM job_contacts WHERE job_id = $1 ORDER BY id', [jobId]);
        const contacts = (rows || []).map((c, ci) => ({
            id: String(c.id),
            name: c.name,
            role: c.role || 'Recruiter',
            email: c.email || '',
            phone: c.phone || null,
            linkedin: c.linkedin_url || null,
            imageUrl: c.image_url || null,
            verified: false,
            avatarColor: AVATAR_COLORS[ci % AVATAR_COLORS.length],
        }));
        return res.json({ contacts });
    } catch (error) {
        console.error('[aiHub] getJobContacts error:', error.message);
        return res.status(500).json({ error: 'Failed to load contacts', contacts: [] });
    }
}

// ─── Recruiter Finder ─────────────────────────────────────────────────────────

/**
 * Ensure the recruiter tables exist (created lazily — no migration file needed).
 */
async function ensureRecruiterTables() {
    await dbConfig.run(`
        CREATE TABLE IF NOT EXISTS employer_recruiters (
            id              SERIAL PRIMARY KEY,
            employer_id     UUID NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
            user_id         INTEGER NOT NULL,
            name            VARCHAR(255) NOT NULL,
            role            VARCHAR(255),
            linkedin_url    TEXT,
            email           VARCHAR(255),
            email_verified  BOOLEAN DEFAULT false,
            created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (employer_id, user_id, linkedin_url)
        )
    `);
    await dbConfig.run(`
        CREATE TABLE IF NOT EXISTS domain_email_patterns (
            id              SERIAL PRIMARY KEY,
            domain          VARCHAR(255) UNIQUE NOT NULL,
            winning_pattern VARCHAR(100),
            success_count   INTEGER DEFAULT 0,
            total_attempts  INTEGER DEFAULT 0,
            last_verified   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

/**
 * Generate all email combinations for a recruiter name + domain.
 * Returns an ordered array: winning pattern (if known) first, then all others.
 */
function generateEmailCombinations(firstName, lastName, domain, winningPattern = null) {
    const f  = firstName.toLowerCase().trim();
    const l  = lastName.toLowerCase().trim();
    const fi = f[0] || '';
    const li = l[0] || '';

    // All patterns keyed by pattern-id
    const patterns = {
        'f.l':    `${f}.${l}@${domain}`,
        'fl':     `${f}${l}@${domain}`,
        'f_l':    `${f}_${l}@${domain}`,
        'f-l':    `${f}-${l}@${domain}`,
        'fi.l':   `${fi}.${l}@${domain}`,
        'fil':    `${fi}${l}@${domain}`,
        'fi_l':   `${fi}_${l}@${domain}`,
        'fi-l':   `${fi}-${l}@${domain}`,
        'f.li':   `${f}.${li}@${domain}`,
        'fli':    `${f}${li}@${domain}`,
        'f_li':   `${f}_${li}@${domain}`,
        'l.f':    `${l}.${f}@${domain}`,
        'lf':     `${l}${f}@${domain}`,
        'l_f':    `${l}_${f}@${domain}`,
        'l.fi':   `${l}.${fi}@${domain}`,
        'lfi':    `${l}${fi}@${domain}`,
        'f':      `${f}@${domain}`,
        'l':      `${l}@${domain}`,
        'fi.li':  `${fi}.${li}@${domain}`,
        'fili':   `${fi}${li}@${domain}`,
    };

    // Generic HR inboxes (always appended regardless of name)
    const generics = [
        `hr@${domain}`, `recruitment@${domain}`, `careers@${domain}`,
        `jobs@${domain}`, `talent@${domain}`, `hiring@${domain}`,
        `people@${domain}`, `apply@${domain}`,
    ];

    // Build ordered list — winning pattern first
    const ordered = [];
    if (winningPattern && patterns[winningPattern]) {
        ordered.push({ email: patterns[winningPattern], pattern: winningPattern });
    }
    for (const [pattern, email] of Object.entries(patterns)) {
        if (pattern !== winningPattern) ordered.push({ email, pattern });
    }
    generics.forEach(email => ordered.push({ email, pattern: 'generic' }));

    // Deduplicate
    const seen = new Set();
    return ordered.filter(e => { if (seen.has(e.email)) return false; seen.add(e.email); return true; });
}

/**
 * Call the Oracle email verifier micro-service.
 * Falls back gracefully if the service is unavailable.
 */
async function callEmailVerifier(emails) {
    const url = process.env.EMAIL_VERIFIER_URL || 'http://80.225.221.216:3001';
    const key = process.env.EMAIL_VERIFIER_KEY || 'cvapplyr-email-verify-2024';
    try {
        const resp = await axios.post(`${url}/verify-emails`, { emails }, {
            headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
            timeout: 60000,
        });
        return resp.data;
    } catch (e) {
        console.error('[recruiter] Email verifier unavailable:', e.message);
        return { catchAll: false, mxFound: false, results: emails.map(email => ({ email, valid: null, reason: 'verifier_unavailable' })) };
    }
}

/**
 * POST /api/ai-hub/employers/:employerId/find-recruiters
 * Step 1: Use Gemini Google Search to find recruiters on LinkedIn. Costs 1 credit.
 */
async function findRecruiters(req, res) {
    const userId = req.user.id;
    const { employerId } = req.params;

    try {
        await ensureRecruiterTables();

        // Validate employer belongs to user
        const employer = await dbConfig.get(
            `SELECT e.* FROM employers e
             JOIN user_tracked_employers ute ON ute.employer_id = e.id
             WHERE e.id = $1 AND ute.user_id = $2`,
            [employerId, userId]
        );
        if (!employer) return res.status(404).json({ error: 'Employer not found' });

        // Check credit balance (admin-configurable cost)
        const findCost = await getEventCost('find_recruiters');
        const credits = await dbConfig.get(`SELECT credits_remaining FROM user_credits WHERE user_id = $1`, [userId]);
        if (findCost > 0 && (!credits || credits.credits_remaining < findCost)) {
            return res.status(402).json({ error: `Insufficient credits. ${findCost} credit(s) required.` });
        }

        // Deduct upfront
        if (findCost > 0) {
            await dbConfig.run(
                `UPDATE user_credits SET credits_remaining = credits_remaining - $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
                [findCost, userId]
            );
        }

        // Gemini Google Search for LinkedIn recruiters
        // Uses the company domain + name as anchors to avoid hallucinated/wrong-company results
        const model = geminiModel(true);
        const companyDomain = employer.domain || '';
        const companyName   = employer.name || '';
        const subInfo       = employer.sub_info || '';

        const prompt = `You have Google Search access. Use it now to find real LinkedIn profiles of HR and recruiting staff at this specific company.

COMPANY: "${companyName}"
DOMAIN: ${companyDomain ? `${companyDomain} (emails at this company end with @${companyDomain})` : 'unknown'}
LOCATION/INDUSTRY: ${subInfo || 'unknown'}

SEARCH STRATEGY — run these Google searches in order until you find results:
1. site:linkedin.com/in "${companyName}" recruiter OR "talent acquisition" OR "HR"
2. site:linkedin.com/in "${companyName}" "human resources" OR hiring OR recruitment
3. "${companyName}" recruiter site:linkedin.com/in
${companyDomain ? `4. "@${companyDomain}" site:linkedin.com recruiter OR HR` : ''}

STRICT RULES:
- ONLY return people whose LinkedIn profile CLEARLY states they currently work at "${companyName}" — not a different company with a similar name
- Each person's current employer on their LinkedIn profile must match "${companyName}" exactly or very closely
- DO NOT invent, guess, or hallucinate any profiles — only return people you actually found via search
- If you cannot find any verified profiles for this exact company, return []
- LinkedIn URLs MUST be in format: https://www.linkedin.com/in/username — reject any other format

Return ONLY a valid JSON array, no markdown, no explanation:
[
  { "name": "Full Name", "role": "Current Job Title at ${companyName}", "linkedin_url": "https://www.linkedin.com/in/..." },
  ...
]

Maximum 6 results. Quality over quantity — only include people you are certain work at "${companyName}".`;

        console.log(`[recruiter] Searching LinkedIn recruiters for "${companyName}" (domain: ${companyDomain})`);
        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        console.log(`[recruiter] Raw Gemini response (first 300 chars): ${text.slice(0, 300)}`);

        let recruiters = [];
        try {
            const match = text.match(/\[[\s\S]*\]/);
            if (match) recruiters = JSON.parse(match[0]);
        } catch { recruiters = []; }

        // Filter valid results and sanitize LinkedIn URLs
        recruiters = recruiters
            .filter(r => r.name && r.name.length > 1 && r.name !== 'N/A' && r.name !== 'null')
            .map(r => {
                let url = (r.linkedin_url || '').trim();
                // Ensure proper https://www.linkedin.com/in/ format
                if (url && !url.startsWith('http')) url = 'https://' + url;
                if (url) url = url.replace('://linkedin.com', '://www.linkedin.com');
                // Only keep if it's actually a LinkedIn /in/ profile URL
                if (url && !url.includes('linkedin.com/in/')) url = null;
                console.log(`[recruiter]   ${r.name} (${r.role}) → ${url || 'no URL'}`);
                return { ...r, linkedin_url: url || null };
            });

        // Save to DB
        const saved = [];
        for (const r of recruiters) {
            try {
                const row = await dbConfig.get(
                    `INSERT INTO employer_recruiters (employer_id, user_id, name, role, linkedin_url)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (employer_id, user_id, linkedin_url) DO UPDATE
                     SET name = EXCLUDED.name, role = EXCLUDED.role, updated_at = CURRENT_TIMESTAMP
                     RETURNING *`,
                    [employerId, userId, r.name, r.role || 'Recruiter', r.linkedin_url || null]
                );
                if (row) saved.push(row);
            } catch {}
        }

        console.log(`[recruiter] Found ${saved.length} recruiters for "${employer.name}"`);
        return res.json({ success: true, recruiters: saved, creditsUsed: 1 });

    } catch (error) {
        console.error('[recruiter] findRecruiters error:', error.message);
        return res.status(500).json({ error: 'Failed to find recruiters' });
    }
}

/**
 * GET /api/ai-hub/employers/:employerId/recruiters
 * Get saved recruiters for an employer.
 */
async function getRecruiters(req, res) {
    const userId = req.user.id;
    const { employerId } = req.params;
    try {
        await ensureRecruiterTables();
        const recruiters = await dbConfig.query(
            `SELECT * FROM employer_recruiters WHERE employer_id = $1 AND user_id = $2 ORDER BY created_at ASC`,
            [employerId, userId]
        );
        return res.json({ recruiters });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch recruiters' });
    }
}

/**
 * POST /api/ai-hub/employers/:employerId/find-emails
 * Step 2: Generate email combinations + verify via SMTP. Costs 1 credit.
 */
async function findRecruiterEmails(req, res) {
    const userId = req.user.id;
    const { employerId } = req.params;

    try {
        await ensureRecruiterTables();

        const employer = await dbConfig.get(
            `SELECT e.* FROM employers e
             JOIN user_tracked_employers ute ON ute.employer_id = e.id
             WHERE e.id = $1 AND ute.user_id = $2`,
            [employerId, userId]
        );
        if (!employer) return res.status(404).json({ error: 'Employer not found' });

        const recruiters = await dbConfig.query(
            `SELECT * FROM employer_recruiters WHERE employer_id = $1 AND user_id = $2`,
            [employerId, userId]
        );
        if (recruiters.length === 0) return res.status(400).json({ error: 'No recruiters found. Run Step 1 first.' });

        // Check credits (admin-configurable cost)
        const emailCost = await getEventCost('find_recruiter_emails');
        const credits = await dbConfig.get(`SELECT credits_remaining FROM user_credits WHERE user_id = $1`, [userId]);
        if (emailCost > 0 && (!credits || credits.credits_remaining < emailCost)) {
            return res.status(402).json({ error: `Insufficient credits. ${emailCost} credit(s) required.` });
        }
        if (emailCost > 0) {
            await dbConfig.run(
                `UPDATE user_credits SET credits_remaining = credits_remaining - $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
                [emailCost, userId]
            );
        }

        // Get company domain from employer domain field
        const domain = employer.domain;
        if (!domain) return res.status(400).json({ error: 'No domain found for employer' });

        // Check for known winning pattern for this domain
        const patternRow = await dbConfig.get(
            `SELECT winning_pattern FROM domain_email_patterns WHERE domain = $1`,
            [domain]
        ).catch(() => null);
        const winningPattern = patternRow?.winning_pattern || null;
        if (winningPattern) console.log(`[recruiter] Known winning pattern for ${domain}: ${winningPattern}`);

        const results = [];

        for (const recruiter of recruiters) {
            // Parse first/last name
            const nameParts = recruiter.name.trim().split(/\s+/);
            const firstName = nameParts[0] || '';
            const lastName  = nameParts[nameParts.length - 1] || nameParts[0] || '';
            if (!firstName || !lastName || firstName === lastName) {
                results.push({ ...recruiter, email: null, email_verified: false });
                continue;
            }

            // Generate combinations — winning pattern first
            const combos = generateEmailCombinations(firstName, lastName, domain, winningPattern);
            const emailsToCheck = combos.map(c => c.email);

            console.log(`[recruiter] Checking ${emailsToCheck.length} combinations for ${recruiter.name} @${domain}`);

            // Send to Oracle verifier in batches of 10
            let verifiedEmail = null;
            let foundPattern  = null;

            for (let i = 0; i < emailsToCheck.length; i += 10) {
                const batch = emailsToCheck.slice(i, i + 10);
                const verifyResult = await callEmailVerifier(batch);

                if (verifyResult.catchAll) {
                    console.log(`[recruiter] ${domain} is catch-all — skipping SMTP verification`);
                    break;
                }

                const hit = verifyResult.results?.find(r => r.valid === true);
                if (hit) {
                    verifiedEmail = hit.email;
                    // Find which pattern this email corresponds to
                    const matchedCombo = combos.find(c => c.email === hit.email);
                    foundPattern = matchedCombo?.pattern || null;
                    console.log(`[recruiter] ✅ Verified: ${verifiedEmail} (pattern: ${foundPattern})`);
                    break;
                }
                // Small delay between batches
                await new Promise(r => setTimeout(r, 500));
            }

            // Update winning pattern in DB if found
            if (foundPattern && foundPattern !== 'generic') {
                await dbConfig.run(
                    `INSERT INTO domain_email_patterns (domain, winning_pattern, success_count, total_attempts, last_verified)
                     VALUES ($1, $2, 1, $3, CURRENT_TIMESTAMP)
                     ON CONFLICT (domain) DO UPDATE
                     SET winning_pattern = EXCLUDED.winning_pattern,
                         success_count = domain_email_patterns.success_count + 1,
                         total_attempts = domain_email_patterns.total_attempts + EXCLUDED.total_attempts,
                         last_verified = CURRENT_TIMESTAMP`,
                    [domain, foundPattern, emailsToCheck.length]
                ).catch(() => {});
            }

            // Save verified email to recruiter record
            if (verifiedEmail) {
                await dbConfig.run(
                    `UPDATE employer_recruiters SET email = $1, email_verified = true, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                    [verifiedEmail, recruiter.id]
                );

                // Propagate to all jobs of this employer that have 0 contacts
                const jobsWithNoContacts = await dbConfig.query(
                    `SELECT j.id FROM jobs j
                     LEFT JOIN job_contacts jc ON jc.job_id = j.id
                     WHERE j.employer_id = $1 AND j.is_active = TRUE
                     GROUP BY j.id HAVING COUNT(jc.id) = 0`,
                    [employerId]
                );
                for (const job of jobsWithNoContacts) {
                    await jobService.addJobContact(
                        job.id, recruiter.name, recruiter.role || 'Recruiter',
                        verifiedEmail, null, null, recruiter.linkedin_url || null, null
                    ).catch(() => {});
                }
                console.log(`[recruiter] Propagated ${verifiedEmail} to ${jobsWithNoContacts.length} jobs`);
            }

            results.push({ ...recruiter, email: verifiedEmail, email_verified: !!verifiedEmail });
        }

        return res.json({ success: true, results, creditsUsed: 1 });

    } catch (error) {
        console.error('[recruiter] findRecruiterEmails error:', error.message);
        return res.status(500).json({ error: 'Failed to find emails' });
    }
}

// ─── Cover Letter for Job ─────────────────────────────────────────────────────

/**
 * POST /api/ai-hub/jobs/:jobId/generate-cover-letter
 * Generates a tailored cover letter for a specific job using the user's resume.
 * Costs 1 credit.
 */
async function generateJobCoverLetter(req, res) {
    const userId     = req.user.id;
    const { jobId }  = req.params;

    try {
        // Load user + resume
        const user = await dbConfig.get(`SELECT * FROM users WHERE id = $1`, [userId]);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (!user.resume_path) {
            return res.status(400).json({
                error: 'Resume required',
                message: 'Please upload your resume in Profile before generating a cover letter.',
                action: 'upload_resume',
            });
        }

        const resumeMeta = await dbConfig.get(
            `SELECT * FROM resume_metadata WHERE user_id = $1 AND parse_status = 'done' ORDER BY created_at DESC LIMIT 1`,
            [userId]
        );
        if (!resumeMeta) {
            return res.status(400).json({ error: 'Resume not processed yet. Please wait and try again.' });
        }

        // Load job + employer details
        const job = await dbConfig.get(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
        if (!job) return res.status(404).json({ error: 'Job not found' });

        const employer = await dbConfig.get(`SELECT * FROM employers WHERE id = $1`, [job.employer_id]);

        // Load skills + responsibilities
        const skills = await dbConfig.query(
            `SELECT s.name FROM skills s JOIN job_skills js ON js.skill_id = s.id WHERE js.job_id = $1`,
            [jobId]
        );
        const skillsList = skills.map(s => s.name).join(', ') || 'Not specified';

        // Check credits (admin-configurable cost)
        const jclCost = await getEventCost('job_cover_letter');
        const credits = await dbConfig.get(`SELECT credits_remaining FROM user_credits WHERE user_id = $1`, [userId]);
        if (jclCost > 0 && (!credits || credits.credits_remaining < jclCost)) {
            return res.status(402).json({ error: `Insufficient credits. ${jclCost} credit(s) required.` });
        }
        if (jclCost > 0) {
            await dbConfig.run(
                `UPDATE user_credits SET credits_remaining = credits_remaining - $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
                [jclCost, userId]
            );
        }

        // Build Gemini prompt
        const resumeText = resumeMeta.parsed_text || resumeMeta.raw_text || '';
        const model = geminiModel(false, 'gemini-2.5-flash');

        const prompt = `You are an expert cover letter writer. Write a tailored, professional cover letter for this job application.

JOB DETAILS:
- Title: ${job.title}
- Company: ${employer?.name || 'the company'}
- Location: ${job.location || 'Not specified'}
- Job Type: ${job.job_type || 'Full-time'}
- Required Skills: ${skillsList}
- Responsibilities: ${job.responsibilities || 'Not specified'}

CANDIDATE RESUME (key sections):
${resumeText.slice(0, 3000)}

INSTRUCTIONS:
1. Write a compelling, personalised cover letter (3-4 paragraphs)
2. Opening paragraph: express enthusiasm for the specific role and company
3. Middle paragraphs: match candidate's experience to the job requirements and skills listed
4. Closing paragraph: call to action, professional sign-off
5. Keep it concise — 300-400 words maximum
6. Do NOT use generic filler phrases like "I am writing to express my interest"
7. Use the candidate's actual experience from the resume — be specific
8. Address to "Hiring Manager" unless a contact name is known
9. Sign off with the candidate's full name from the resume
10. LANGUAGE: Write the ENTIRE cover letter in English. Even if the job title, responsibilities, or any provided details are in another language (e.g. German, French, Dutch), the cover letter MUST be written wholly in professional English. Translate any non-English job details into English as needed. Do NOT output any non-English text.

Return ONLY the cover letter text in English — no explanation, no markdown, no formatting tags.`;

        console.log(`[aiHub] Generating cover letter for job "${job.title}" at "${employer?.name}"`);
        const result = await model.generateContent(prompt);
        const coverLetterText = result.response.text().trim();

        return res.json({
            success: true,
            coverLetter: coverLetterText,
            jobTitle: job.title,
            companyName: employer?.name || '',
            creditsUsed: 1,
        });

    } catch (error) {
        console.error('[aiHub] generateJobCoverLetter error:', error.message);
        return res.status(500).json({ error: 'Failed to generate cover letter. Please try again.' });
    }
}

// ─── Translate a job card to English ─────────────────────────────────────────
// ATS-sourced jobs are parsed straight from HTML (no AI) so they keep their
// original language. This endpoint translates the visible job fields to English
// with Gemini, caching the result per job (shared across users) so each job is
// translated once. Free (no credit cost) — it's a convenience toggle.

async function ensureJobTranslationsTable() {
    await dbConfig.run(`
        CREATE TABLE IF NOT EXISTS job_translations (
            job_id UUID NOT NULL,
            target_lang VARCHAR(8) NOT NULL DEFAULT 'en',
            source_lang VARCHAR(16),
            payload JSONB NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (job_id, target_lang)
        )
    `);
}

async function translateJob(req, res) {
    const { jobId } = req.params;
    try {
        await ensureJobTranslationsTable();

        // 1. Cache hit → return immediately (translate once per job, ever).
        const cached = await dbConfig.get(
            `SELECT payload, source_lang FROM job_translations WHERE job_id = $1 AND target_lang = 'en'`,
            [jobId]
        );
        if (cached && cached.payload) {
            const p = typeof cached.payload === 'string' ? JSON.parse(cached.payload) : cached.payload;
            return res.json({ jobId, sourceLang: cached.source_lang || null, cached: true, translated: p });
        }

        // 2. Load the job (+ location text via join, + skills).
        const job = await dbConfig.get(
            `SELECT j.*, l.raw_text AS location_text
             FROM jobs j LEFT JOIN locations l ON l.id = j.location_id
             WHERE j.id = $1`,
            [jobId]
        );
        if (!job) return res.status(404).json({ error: 'Job not found' });

        // Charge only on a real (cache-miss) translation. Free today (cost 0) unless an admin sets a price.
        const userId = req.user && req.user.id;
        if (userId) {
            const charge = await chargeCredits(userId, 'translate_job');
            if (charge.insufficient) {
                return res.status(402).json({ error: `Insufficient credits. ${charge.cost} credit(s) required.`, creditsRequired: charge.cost, creditsRemaining: charge.remaining });
            }
        }

        const skillRows = await dbConfig.query(
            `SELECT s.name FROM skills s JOIN job_skills js ON js.skill_id = s.id WHERE js.job_id = $1`,
            [jobId]
        );
        const skills = skillRows.map(s => s.name);
        const responsibilities = (() => {
            try {
                if (!job.responsibilities) return [];
                return typeof job.responsibilities === 'string' ? JSON.parse(job.responsibilities) : job.responsibilities;
            } catch { return []; }
        })();

        const fields = {
            title: job.title || '',
            location: job.location_text || '',
            experience: job.experience || '',
            salary: job.salary || '',
            jobType: job.job_type || '',
            workMode: job.work_mode || null,
            skills,
            responsibilities,
        };

        // 3. Translate with Gemini (flash-lite, JSON out). One retry on bad JSON.
        const model = geminiModel(false, 'gemini-2.5-flash-lite');
        const prompt = `Translate the following job-posting fields into natural, professional English.

Return ONLY a JSON object with EXACTLY these keys:
"sourceLang" (ISO 639-1 code of the original language, or "en" if it is already English),
"title" (string), "location" (string), "experience" (string), "salary" (string),
"jobType" (string), "skills" (array of strings), "responsibilities" (array of strings).

Rules:
- Translate every value into English. If a value is already English, return it unchanged.
- Keep proper nouns as-is: company names, city/country names, product and technology names (e.g. "Python", "Berlin", "SAP").
- Preserve array lengths: translate each skill and each responsibility item individually; do not merge, drop, or add items.
- Keep it faithful — do not summarise, embellish, or invent.
- No commentary, no markdown — JSON only.

FIELDS:
${JSON.stringify(fields, null, 2)}`;

        async function callOnce() {
            const result = await model.generateContent({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 8192 },
            });
            return parseJsonObject(result.response.text());
        }

        let out = null;
        try { out = await callOnce(); } catch (e1) {
            try { out = await callOnce(); } catch (e2) {
                console.error('[aiHub] translateJob AI error:', e2.message);
                return res.status(502).json({ error: 'Translation failed. Please try again.' });
            }
        }
        if (!out || typeof out !== 'object') {
            return res.status(502).json({ error: 'Translation failed. Please try again.' });
        }

        // Normalise + fall back to originals for any missing field.
        const translated = {
            title: typeof out.title === 'string' && out.title.trim() ? out.title.trim() : fields.title,
            location: typeof out.location === 'string' && out.location.trim() ? out.location.trim() : fields.location,
            experience: typeof out.experience === 'string' && out.experience.trim() ? out.experience.trim() : fields.experience,
            salary: typeof out.salary === 'string' && out.salary.trim() ? out.salary.trim() : fields.salary,
            jobType: typeof out.jobType === 'string' && out.jobType.trim() ? out.jobType.trim() : fields.jobType,
            workMode: fields.workMode,   // already English (Remote/Hybrid/Office) — pass through unchanged
            skills: Array.isArray(out.skills) && out.skills.length ? out.skills.map(String) : fields.skills,
            responsibilities: Array.isArray(out.responsibilities) && out.responsibilities.length ? out.responsibilities.map(String) : fields.responsibilities,
        };
        const sourceLang = typeof out.sourceLang === 'string' ? out.sourceLang.slice(0, 16) : null;

        // 4. Cache it (best-effort; ON CONFLICT keeps the first translation).
        try {
            await dbConfig.run(
                `INSERT INTO job_translations (job_id, target_lang, source_lang, payload)
                 VALUES ($1, 'en', $2, $3)
                 ON CONFLICT (job_id, target_lang) DO NOTHING`,
                [jobId, sourceLang, JSON.stringify(translated)]
            );
        } catch (e) { console.warn('[aiHub] translateJob cache write failed:', e.message); }

        return res.json({ jobId, sourceLang, cached: false, translated });
    } catch (error) {
        console.error('[aiHub] translateJob error:', error.message);
        return res.status(500).json({ error: 'Failed to translate job. Please try again.' });
    }
}

// ─── Job Cover Letter Persistence ────────────────────────────────────────────

async function ensureCoverLetterTable() {
    await dbConfig.run(`
        CREATE TABLE IF NOT EXISTS job_cover_letters (
            id                SERIAL PRIMARY KEY,
            user_id           INTEGER NOT NULL,
            job_id            UUID NOT NULL,
            cover_letter_html TEXT,
            company_name      VARCHAR(255),
            website_url       TEXT,
            position          VARCHAR(255),
            company_address   TEXT DEFAULT '',
            status            VARCHAR(20) DEFAULT 'generated',
            created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, job_id)
        )
    `);
    // Add missing columns (migrations for existing tables)
    await dbConfig.run(`ALTER TABLE job_cover_letters ADD COLUMN IF NOT EXISTS company_address   TEXT DEFAULT ''`);
    await dbConfig.run(`ALTER TABLE job_cover_letters ADD COLUMN IF NOT EXISTS company_locations TEXT DEFAULT '[]'`);
}

/** POST /api/ai-hub/jobs/:jobId/cover-letter — save generated cover letter */
async function saveJobCoverLetter(req, res) {
    const userId = req.user.id;
    const { jobId } = req.params;
    const { coverLetterHtml, companyName, websiteUrl, position, companyAddress, companyLocations } = req.body;
    try {
        await ensureCoverLetterTable();
        const locsJson = companyLocations ? JSON.stringify(companyLocations) : '[]';
        await dbConfig.run(`
            INSERT INTO job_cover_letters (user_id, job_id, cover_letter_html, company_name, website_url, position, company_address, company_locations, status, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'generated', CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, job_id) DO UPDATE
            SET cover_letter_html  = EXCLUDED.cover_letter_html,
                company_name       = EXCLUDED.company_name,
                website_url        = EXCLUDED.website_url,
                position           = EXCLUDED.position,
                company_address    = EXCLUDED.company_address,
                company_locations  = EXCLUDED.company_locations,
                status             = 'generated',
                updated_at         = CURRENT_TIMESTAMP
        `, [userId, jobId, coverLetterHtml, companyName, websiteUrl, position, companyAddress || '', locsJson]);
        return res.json({ success: true });
    } catch (e) {
        console.error('[aiHub] saveJobCoverLetter:', e.message);
        return res.status(500).json({ error: 'Failed to save cover letter' });
    }
}

/** GET /api/ai-hub/jobs/:jobId/cover-letter — load saved cover letter */
async function getJobCoverLetter(req, res) {
    const userId = req.user.id;
    const { jobId } = req.params;
    try {
        await ensureCoverLetterTable();
        const row = await dbConfig.get(
            `SELECT * FROM job_cover_letters WHERE user_id=$1 AND job_id=$2`, [userId, jobId]
        );
        return res.json({ coverLetter: row || null });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to load cover letter' });
    }
}

/** PATCH /api/ai-hub/jobs/:jobId/cover-letter/status — update status (generated/applied) */
async function updateJobCoverLetterStatus(req, res) {
    const userId = req.user.id;
    const { jobId } = req.params;
    const { status } = req.body;
    if (!['generated', 'downloaded', 'applied'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }
    try {
        await ensureCoverLetterTable();
        // Detect the first transition INTO 'applied' so we record the application only once.
        let alreadyApplied = false;
        if (status === 'applied') {
            const cur = await dbConfig.get(
                `SELECT status FROM job_cover_letters WHERE user_id=$1 AND job_id=$2`, [userId, jobId]);
            alreadyApplied = !!cur && cur.status === 'applied';
        }
        await dbConfig.run(
            `UPDATE job_cover_letters SET status=$1, updated_at=CURRENT_TIMESTAMP WHERE user_id=$2 AND job_id=$3`,
            [status, userId, jobId]
        );
        // Portal / auto-fill applies never send an email, so they don't hit the email
        // controller's application_history insert. Record it here so the job shows up
        // under "Recent applications" on the home dashboard. Runs once per job.
        if (status === 'applied' && !alreadyApplied) {
            recordJobHubApplication(userId, jobId).catch(
                (err) => console.error('[aiHub] application_history record failed:', err.message));
        }
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to update status' });
    }
}

/** Insert an application_history row for a Job Hub job marked "applied" (no email sent). */
async function recordJobHubApplication(userId, jobId) {
    const row = await dbConfig.get(
        `SELECT j.title AS position, e.name AS company_name
         FROM jobs j JOIN employers e ON e.id = j.employer_id
         WHERE j.id = $1`, [jobId]);
    if (!row) return;
    const company = row.company_name || '';
    const position = row.position || '';
    // Dedup: if this application was already recorded recently (e.g. an email send via
    // sendSingleApplication already inserted it), don't add a duplicate card. ISO-8601
    // strings compare chronologically, so this works for text or timestamp columns.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const dup = await dbConfig.get(
        `SELECT id FROM application_history
         WHERE user_id=$1 AND company_name=$2 AND position=$3 AND sent_date >= $4 AND deleted_at IS NULL
         LIMIT 1`,
        [userId, company, position, since]);
    if (dup) return;
    await dbConfig.run(
        `INSERT INTO application_history
           (user_id, company_name, position, recipient_email, sent_date, reply_received, reply_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, company, position, '', new Date().toISOString(), 0, null]
    );
}

/** GET /api/ai-hub/employers/:employerId/job-statuses — bulk status for all jobs of an employer */
async function getJobStatuses(req, res) {
    const userId = req.user.id;
    const { employerId } = req.params;
    try {
        await ensureCoverLetterTable();
        const rows = await dbConfig.query(
            `SELECT jcl.job_id, jcl.status
             FROM job_cover_letters jcl
             JOIN jobs j ON j.id = jcl.job_id
             WHERE jcl.user_id=$1 AND j.employer_id=$2`,
            [userId, employerId]
        );
        const map = {};
        (rows?.rows || rows || []).forEach(r => { map[r.job_id] = r.status; });
        return res.json({ statuses: map });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to load statuses' });
    }
}

/** POST /api/ai-hub/generate-email-body — AI-written email body for compose modal */
async function generateEmailBodyHandler(req, res) {
    const { position, companyName } = req.body;
    const userId = req.user.id;
    try {
        // Free today (cost 0) unless an admin sets a price for 'ai_email_body'.
        const charge = await chargeCredits(userId, 'ai_email_body');
        if (charge.insufficient) {
            return res.status(402).json({ error: `Insufficient credits. ${charge.cost} credit(s) required.`, creditsRequired: charge.cost, creditsRemaining: charge.remaining });
        }
        const user = await dbConfig.get(`SELECT full_name FROM users WHERE id=$1`, [userId]);
        const fullName = user?.full_name || 'Applicant';

        const geminiKey = process.env.GEMINI_API_KEY;
        if (geminiKey) {
            try {
                const { GoogleGenerativeAI } = require('@google/generative-ai');
                const genAI = new GoogleGenerativeAI(geminiKey);
                const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
                const prompt = `Write a short, professional email body for a job application. The applicant's name is "${fullName}", applying for the "${position}" position at "${companyName}".

Rules:
- Write ONLY the email body text, no subject line
- Start with a greeting like "Dear Hiring Manager," or "Dear Hiring Team," followed by a BLANK LINE
- Keep the body to 3-5 sentences maximum
- Sound natural and human-written, not robotic or templated
- Mention that resume and cover letter are attached
- Be unique — vary sentence structure, tone, and phrasing each time
- Do NOT use phrases like "I hope this email finds you well" or "I am writing to express my interest"
- Use a professional but warm, conversational tone
- End with "Best regards," followed by a new line with the applicant's name
- Do NOT include any markdown formatting, asterisks, bold, or special characters
- Use proper paragraph spacing — separate greeting, body, and sign-off with blank lines
- Output plain text only, no HTML`;
                const result = await model.generateContent(prompt);
                let text = result.response.text().trim();
                if (text && text.length > 30) {
                    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                    text = text.split(/\n\n+/).map(para => {
                        const lines = para.split('\n');
                        if (lines.length === 1) return para;
                        if (lines.length <= 2 && lines[0].length < 30) return para;
                        return lines.join(' ');
                    }).join('\n\n');
                    text = text.replace(/^(Dear[^\n]*,)\n(?!\n)/m, '$1\n\n');
                    return res.json({ body: text });
                }
            } catch (aiErr) {
                console.error('⚠️ AI email body generation failed:', aiErr.message);
            }
        }
        // Fallback
        const body = `Dear Hiring Manager,\n\nI am excited to submit my application for the ${position} role at ${companyName}. Please find my resume and cover letter attached for your consideration.\n\nI would love the opportunity to discuss how my background and skills align with your team's needs. Please feel free to reach out at your convenience.\n\nBest regards,\n${fullName}`;
        return res.json({ body });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to generate email body' });
    }
}

// ─── In-app Apply: AI auto-fill ───────────────────────────────────────────────

// POST /ai-hub/autofill-map — given the form's fields, return a value for each from the
// candidate's profile (and classify file inputs as resume vs cover letter). AI-driven.
async function autofillMap(req, res) {
    try {
        const userId = req.user.id;
        const { fields, coverLetterHtml, jobTitle, companyName } = req.body || {};
        if (!Array.isArray(fields) || fields.length === 0) {
            return res.status(400).json({ error: 'No form fields provided' });
        }

        // Free today (cost 0) unless an admin sets a price for 'ai_autofill'.
        const charge = await chargeCredits(userId, 'ai_autofill');
        if (charge.insufficient) {
            return res.status(402).json({ error: `Insufficient credits. ${charge.cost} credit(s) required.`, creditsRequired: charge.cost, creditsRemaining: charge.remaining });
        }

        const user = await dbConfig.get(
            'SELECT full_name, email, phone_number, city, country, address, date_of_birth, nationality, gender FROM users WHERE id = ?',
            [userId]
        ).catch(() => null);
        let meta = null;
        try { meta = await dbConfig.get("SELECT * FROM resume_metadata WHERE user_id = ? AND parse_status = 'done' ORDER BY id DESC LIMIT 1", [userId]); } catch {}
        let builder = null;
        try { const r = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = ?', [userId]); builder = r && r.resume_data; if (typeof builder === 'string') builder = JSON.parse(builder); } catch {}
        // The user's LEARNED answers to past portal questions (the self-learning Q&A store) —
        // loaded alongside the profile so the AI can reuse them and the overlay can exact-match.
        let portalQA = [];
        try { portalQA = await dbConfig.query('SELECT q_key, question, answer FROM user_job_portal_details WHERE user_id = ? ORDER BY use_count DESC LIMIT 300', [userId]); } catch {}

        // Strip noisy/internal columns from resume_metadata
        if (meta) { delete meta.id; delete meta.user_id; delete meta.parse_status; delete meta.created_at; delete meta.updated_at; }

        const profile = { ...(user || {}), resume_metadata: meta || undefined, builder_resume: builder || undefined };
        const clText = String(coverLetterHtml || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

        const prompt = `You are auto-filling a job application form for a candidate. Map each form field to the best value from the candidate's profile. Return ONLY JSON.

CANDIDATE PROFILE (JSON — the source of truth; never invent anything not present here):
${JSON.stringify(profile)}

SAVED ANSWERS — the candidate's OWN answers to questions they filled on past application forms
(authoritative; reuse for any field asking the same thing, even if worded differently):
${JSON.stringify(portalQA.map((q) => ({ question: q.question, answer: q.answer })))}

COVER LETTER (plain text):
"""${clText.slice(0, 3500)}"""

JOB: ${jobTitle || ''} at ${companyName || ''}

FORM FIELDS (JSON array; each has key,tag,type,name,placeholder,label,required,options). Map EVERY field you confidently can:
${JSON.stringify(fields.slice(0, 150))}

Return ONLY this JSON object:
{
  "values": { "<field key>": "<value to enter>" },
  "resumeFileKeys": ["<key of any file input that wants a RESUME/CV>"],
  "coverLetterFileKeys": ["<key of any file input that wants a COVER LETTER>"]
}

RULES:
- Use ONLY real values from the profile for personal facts. NEVER invent names, emails, phones, dates, or employers.
- For a "select" or "radio" field, the value MUST be EXACTLY one of its provided options (e.g. "Yes"/"No", or an exact option label).
- For long-answer / "why this company" / motivation / cover-letter TEXT fields, use the cover letter text (trim to ~1200 chars).
- For date fields use the format the placeholder suggests, else YYYY-MM-DD.
- ANSWER benign application questions with a sensible value even without explicit profile data:
    • "How did you hear about / learn of this role / us?" → "Company website"
    • "A cover letter is required — have you included one?" / "Will you attach a resume?" → "Yes"
    • "Are you willing to work on-site / relocate / commute to <the job location>?" → "Yes"
    • Pronouns / gender questions → ONLY if the profile includes an explicit "gender" value. Map it to an option that is LITERALLY present in the field: gender "male" → a He/Him or Male option; "female" → a She/Her or Female option; "prefer not to say" → a "Prefer not to say" / neutral / decline option. If the profile has NO gender value, OMIT the field entirely (leave it blank for the user). NEVER infer gender or pronouns from the candidate's name or anything else.
- DO NOT answer — leave BLANK (omit) — any question that needs the candidate's own judgement or legal/personal attestation:
    • work authorization / right to work / visa / sponsorship / immigration status
    • salary / compensation / notice period / availability date
    • demographic & diversity — race, ethnicity, disability, veteran status, age (and gender/pronouns UNLESS the profile has an explicit "gender" value, handled by the rule above)
    • criminal history, references, or anything requiring a signature/consent
- For file inputs (type "file"): classify by label — resume/CV → resumeFileKeys, cover letter → coverLetterFileKeys. If generic ("Upload"/"Attachment"), put it in resumeFileKeys.
- OMIT any other field you cannot confidently fill. Do not guess personal facts.`;

        // Clean-JSON output + a generous token cap so large forms don't truncate mid-object.
        let parsed = null;
        try {
            const model = geminiModel(false);
            const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('AI_TIMEOUT')), 60000));
            const result = await Promise.race([
                model.generateContent({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 8192 },
                }),
                timeout,
            ]);
            parsed = parseJsonObject(result.response.text() || '');
        } catch (aiErr) {
            // Graceful: let the user fill manually instead of a hard error.
            console.warn('[aiHub] autofillMap AI failed:', aiErr.message);
            return res.json({ success: true, values: {}, resumeFileKeys: [], coverLetterFileKeys: [], warning: 'ai_unavailable' });
        }
        const values = (parsed && parsed.values && typeof parsed.values === 'object') ? parsed.values : {};

        // ── Self-learning overlay ────────────────────────────────────────────
        // Belt-and-suspenders to the AI prompt above: for any field STILL empty, exact-match it
        // against the user's saved Q&A by normalized question — so every learned answer fills.
        try {
            if (portalQA && portalQA.length) {
                const memMap = {};
                for (const m of portalQA) memMap[m.q_key] = m.answer;
                let learned = 0;
                for (const f of fields) {
                    if (!f || !f.key || values[f.key] != null) continue;   // skip ones the AI already filled
                    const ans = memMap[normalizeQ(fieldQuestion(f))];
                    if (ans != null && ans !== '') { values[f.key] = ans; learned++; }
                }
                if (learned) console.log(`[aiHub] saved-answers filled ${learned} field(s) the AI left blank for user ${userId}`);
            }
        } catch (e) { console.warn('[aiHub] saved-answers overlay skipped:', e.message); }

        return res.json({
            success: true,
            values,
            resumeFileKeys: parsed && Array.isArray(parsed.resumeFileKeys) ? parsed.resumeFileKeys : [],
            coverLetterFileKeys: parsed && Array.isArray(parsed.coverLetterFileKeys) ? parsed.coverLetterFileKeys : [],
        });
    } catch (error) {
        console.error('[aiHub] autofillMap error:', error.message);
        return res.status(500).json({ error: 'Auto-fill mapping failed', details: error.message });
    }
}

// POST /ai-hub/autofill-files — resume + cover-letter PDFs as base64, for in-page upload.
async function autofillFiles(req, res) {
    try {
        const userId = req.user.id;
        const { coverLetterHtml, companyName, companyAddress, resumeRegion, clRegion, which } = req.body || {};
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        const path = require('path');
        const fs = require('fs').promises;
        const out = { success: true };

        const safe = (s) => String(s || 'CVApplyr').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').slice(0, 40);

        // Resume: ALWAYS prefer the Builder one-pager PDF for the chosen region, so the file that
        // gets attached is exactly what the Preview shows. Fall back to the uploaded resume only
        // when the user has no Builder resume at all.
        if (which !== 'cover') {
        try {
            const rb = require('./resumeBuilderController');
            const r = await rb.buildResumePdfForRegion(userId, resumeRegion || 'generic', 'onepage');
            if (r && r.filePath) {
                const buf = await fs.readFile(r.filePath);
                out.resume = { base64: buf.toString('base64'), name: r.fileName || `${safe(user && user.full_name)}_Resume.pdf`, mime: 'application/pdf' };
            }
        } catch (e) { console.warn('[autofillFiles] builder resume render failed:', e.message); }
        if (!out.resume && user && user.resume_path) {
            try {
                const p = path.join(__dirname, '../../', user.resume_path);
                const buf = await fs.readFile(p);
                const ext = (path.extname(user.resume_path) || '.pdf').toLowerCase();
                const mime = ext === '.pdf' ? 'application/pdf' : ext === '.doc' ? 'application/msword' : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/octet-stream';
                out.resume = { base64: buf.toString('base64'), name: `${safe(user.full_name)}_Resume${ext}`, mime };
            } catch (e) { console.warn('[autofillFiles] uploaded resume read failed:', e.message); }
        }
        } // end which !== 'cover'

        // Cover letter: render to a one-page PDF — region template if a region is chosen, else generic.
        if (which !== 'resume' && coverLetterHtml && String(coverLetterHtml).trim()) {
            try {
                if (clRegion && clRegion !== 'generic') {
                    const clc = require('./coverLetterController');
                    // Pass companyAddress so the attached letter's recipient block matches the preview exactly.
                    const r = await clc.buildCoverLetterPdfForRegion(userId, { region: clRegion, coverLetterHtml, companyName: companyName || '', companyAddress: companyAddress || '', mode: 'onepage' });
                    if (r && r.filePath) { const buf = await fs.readFile(r.filePath); out.coverLetter = { base64: buf.toString('base64'), name: `${safe(user && user.full_name)}_Cover_Letter.pdf`, mime: 'application/pdf' }; }
                }
                if (!out.coverLetter) {
                    const { generateCoverLetterPDF } = require('./emailController');
                    const r = await generateCoverLetterPDF(user, coverLetterHtml, companyName || '', companyAddress || '');
                    if (r && r.filePath) { const buf = await fs.readFile(r.filePath); out.coverLetter = { base64: buf.toString('base64'), name: `${safe(user && user.full_name)}_Cover_Letter.pdf`, mime: 'application/pdf' }; }
                }
            } catch (e) { console.warn('[autofillFiles] cover letter render failed:', e.message); }
        }

        return res.json(out);
    } catch (error) {
        console.error('[aiHub] autofillFiles error:', error.message);
        return res.status(500).json({ error: 'Auto-fill files failed' });
    }
}

// ── Self-learning autofill memory ────────────────────────────────────────────
// Normalize a form field's question into a stable match key so the SAME question on a
// DIFFERENT portal resolves to the same memory row. Lowercase, drop punctuation/“*”/
// “(required)”, collapse whitespace → spaceless token.
function normalizeQ(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/\(required\)|\*|：|:/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\b(please|your|the|a|an|do|does|are|is|you|to|of|for|we|this|that|will|would|have|has|enter|select|choose)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s/g, '');
}
// The best human label for a field (label → name → placeholder).
function fieldQuestion(f) {
    return String((f && (f.label || f.name || f.placeholder)) || '').trim();
}
// Don't remember secrets or per-job essays — only short, reusable factual answers.
const _SENSITIVE_Q = /password|passwort|wachtwoord|ssn|social.?security|credit.?card|card.?number|\bcvv\b|\biban\b|routing|sort.?code|pin\b/i;
function _isMemorable(label, value, type) {
    const v = String(value == null ? '' : value).trim();
    if (!v || v.length > 120) return false;                 // empty or essay-length → skip
    if ((type || '').toLowerCase() === 'file' || (type || '').toLowerCase() === 'password') return false;
    if (_SENSITIVE_Q.test(label) || _SENSITIVE_Q.test(v)) return false;
    if (!normalizeQ(label)) return false;                   // unlabeled field → can't key it
    return true;
}

// POST /ai-hub/autofill-memory — remember the answers the user just filled in manually so
// the next form with the same questions auto-fills. Body: { answers: [{label, value, type}] }.
async function recordAutofillMemory(req, res) {
    try {
        const userId = req.user.id;
        const answers = Array.isArray(req.body && req.body.answers) ? req.body.answers : [];
        let saved = 0;
        for (const a of answers.slice(0, 100)) {
            const question = fieldQuestion(a);
            const value = a && a.value;
            const type = (a && a.type) || null;
            if (!_isMemorable(question, value, type)) continue;
            const qKey = normalizeQ(question);
            try {
                await dbConfig.run(
                    `INSERT INTO user_job_portal_details (user_id, q_key, question, answer, field_type)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (user_id, q_key) DO UPDATE SET
                        answer = EXCLUDED.answer, question = EXCLUDED.question, field_type = EXCLUDED.field_type,
                        use_count = user_job_portal_details.use_count + 1, updated_at = CURRENT_TIMESTAMP`,
                    [userId, qKey, question.slice(0, 300), String(value).trim().slice(0, 300), type]
                );
                saved++;
            } catch (e) { /* skip one bad row */ }
        }
        return res.json({ success: true, saved });
    } catch (error) {
        console.error('[aiHub] recordAutofillMemory error:', error.message);
        return res.status(500).json({ error: 'Failed to save autofill memory' });
    }
}

// GET /ai-hub/smart-fill-data — the bundle the in-WebView "smart copy" popup shows: the
// candidate's reusable facts + a resume summary, so they can copy-paste any field the
// autofill couldn't reach.
async function smartFillData(req, res) {
    try {
        const userId = req.user.id;
        const user = await dbConfig.get(
            'SELECT full_name, email, phone_number, city, country, address, nationality, date_of_birth FROM users WHERE id = ?',
            [userId]
        ).catch(() => null);
        let meta = null;
        try { meta = await dbConfig.get("SELECT summary, experience_summary, experience_years, skills, job_titles, languages FROM resume_metadata WHERE user_id = ? AND parse_status = 'done' ORDER BY id DESC LIMIT 1", [userId]); } catch {}
        // Resume-builder data is a strong fallback for contact facts the users row may not have.
        let b = null;
        try { const r = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = ?', [userId]); b = r && r.resume_data; if (typeof b === 'string') b = JSON.parse(b); } catch {}
        b = b || {};
        const u = user || {};
        const pick = (...xs) => { for (const x of xs) { const v = String(x == null ? '' : x).trim(); if (v) return v; } return ''; };
        const location = pick(b.location, [u.city, u.country].filter(Boolean).join(', '));
        const resumeSummary = pick(meta && meta.summary, meta && meta.experience_summary, b.summary);
        const fields = [
            { id: 'fullName', label: 'Full name', value: pick(u.full_name, b.name, b.fullName) },
            { id: 'email', label: 'Email', value: pick(u.email, b.email) },
            { id: 'phone', label: 'Phone', value: pick(u.phone_number, b.phone) },
            { id: 'location', label: 'Location', value: location },
            { id: 'address', label: 'Address', value: pick(u.address, b.address) },
            { id: 'nationality', label: 'Nationality', value: pick(u.nationality, b.nationality) },
        ].filter((f) => f.value);
        return res.json({
            success: true,
            fields,
            resumeSummary,
            skills: (meta && Array.isArray(meta.skills) ? meta.skills : []).slice(0, 20),
            jobTitles: (meta && Array.isArray(meta.job_titles) ? meta.job_titles : []).slice(0, 8),
        });
    } catch (error) {
        console.error('[aiHub] smartFillData error:', error.message);
        return res.status(500).json({ error: 'Failed to load smart-fill data' });
    }
}

// ── Personalized motivation lines (résumé-aware) ──────────────────────────────
// Shown while a search is processing, mixed with the bundled 500-line generic tip library on the
// app side. Generated ONCE per user from their résumé (skills/titles/experience), cached in
// user_motivation_lines, then reused forever — NO per-search AI. A templated fallback covers AI
// outages / empty résumés (and is NOT cached, so AI is retried next time).
function _motivationFallback(first, prof) {
    const name = first || 'there';
    const skills = (prof.skills || []).filter(Boolean);
    const titles = (prof.job_titles || []).filter(Boolean);
    const yrs = prof.experience_years || 0;
    const s = (i) => skills[i % skills.length];
    const out = [
        `${name}, your skills are exactly what great teams are hunting for.`,
        `Hang tight ${name} — we're lining up roles worthy of you.`,
        `Your experience speaks for itself, ${name}. Employers will notice.`,
        `Great matches take a moment — we're finding your best fits now.`,
        `Every role we open up is a fresh chance, ${name}.`,
    ];
    if (skills.length) {
        out.push(`${name}, your ${s(0)} skills are in serious demand right now.`);
        if (skills.length > 1) out.push(`${s(0)} and ${s(1)}? That's a combination employers love.`);
        if (skills.length > 2) out.push(`Few people pair ${s(2)} with ${s(0)} like you do, ${name}.`);
        out.push(`We're matching roles that value your ${s(3)} expertise.`);
    }
    if (titles.length) out.push(`A ${titles[0]} with your range — companies would be lucky to find you.`);
    if (yrs >= 2) out.push(`${yrs}+ years of real experience — that's hard-earned credibility, ${name}.`);
    return out;
}

async function genPersonalizedMotivation(first, prof) {
    const model = geminiModel(false, 'gemini-2.5-flash-lite');
    if (!model) return null;
    const skills = (prof.skills || []).slice(0, 18).join(', ') || 'a strong skill set';
    const titles = (prof.job_titles || []).slice(0, 5).join(', ') || 'their field';
    const yrs = prof.experience_years || 0;
    const name = first || '';
    const prompt = `Write 28 SHORT, warm, genuine one-liners to cheer up a job seeker while our app searches for jobs for them.
${name ? `Their first name is ${name} — address them by name in roughly half the lines (natural, not every line).` : ''}
Their background: titles = ${titles}; ${yrs} years of experience; skills = ${skills}.
Several lines should praise SPECIFIC skills or their experience naturally (e.g. "Your React skills are exactly what teams want right now"). Mix in light encouragement and one or two playful lines.
Rules: max 14 words each; warm and sincere; no emojis; no numbering; no surrounding quotes; plain English; each stands alone.
Return ONLY JSON: {"lines":["...","..."]}`;
    try {
        const r = await model.generateContent(prompt);
        const j = safeParseJSON(r.response.text(), null);
        const lines = (j && Array.isArray(j.lines) ? j.lines : [])
            .map((x) => String(x || '').trim().replace(/^["'\-•\s]+/, '').replace(/["']+$/, ''))
            .filter((x) => x.length >= 6 && x.length <= 160);
        return lines.length >= 8 ? [...new Set(lines)] : null;
    } catch { return null; }
}

async function getMotivation(req, res) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const cached = await dbConfig.get(`SELECT lines FROM user_motivation_lines WHERE user_id = $1`, [userId]);
        if (cached && cached.lines) {
            const lines = Array.isArray(cached.lines) ? cached.lines : safeParseJSON(cached.lines, []);
            if (lines.length) return res.json({ lines });
        }
        const prof = await getUserProfile(userId).catch(() => ({ skills: [], job_titles: [], experience_years: 0 }));
        const u = await dbConfig.get(`SELECT full_name FROM users WHERE id = $1`, [userId]).catch(() => null);
        const first = String((u && u.full_name) || '').trim().split(/\s+/)[0] || '';

        let lines = await genPersonalizedMotivation(first, prof);
        let source = 'ai';
        if (!lines || !lines.length) { lines = _motivationFallback(first, prof); source = 'fallback'; }

        // Cache ONLY genuine AI output — a fallback should retry AI on the next call.
        if (source === 'ai') {
            await dbConfig.run(
                `INSERT INTO user_motivation_lines (user_id, lines, source, generated_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (user_id) DO UPDATE SET lines = EXCLUDED.lines, source = EXCLUDED.source, generated_at = NOW()`,
                [userId, JSON.stringify(lines), source]
            );
        }
        return res.json({ lines });
    } catch (e) {
        console.error('[aiHub] getMotivation error:', e.message);
        return res.json({ lines: [] });   // app falls back to the bundled generic tip library
    }
}

module.exports = {
    analyzeWishlist,
    getJobMatches,
    getJobStatus,
    getDashboard,
    removeDashboardItem,
    verifyEmail,
    addContactToJob,
    getJobContacts,
    autofillMap,
    autofillFiles,
    recordAutofillMemory,
    smartFillData,
    getCreditBalance,
    deductCredits,
    findRecruiters,
    getRecruiters,
    findRecruiterEmails,
    generateJobCoverLetter,
    translateJob,
    saveJobCoverLetter,
    getJobCoverLetter,
    updateJobCoverLetterStatus,
    getJobStatuses,
    generateEmailBodyHandler,
    getMatchScores,
    getMotivation,
};
