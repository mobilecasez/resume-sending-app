'use strict';

/**
 * Playwright-based scraper for job detail pages.
 *
 * Three-layer strategy (fastest → most powerful):
 *   Layer 1 — API Interception: If the site fires XHR/fetch calls with job data, capture
 *             the raw JSON response and return it directly. Zero HTML parsing needed.
 *   Layer 2 — Reveal + Scrape: Click JS "show phone/email" buttons, wait for networkidle,
 *             then grab the fully rendered HTML and strip it to lean text.
 *   Layer 3 — Static fallback: For simple sites, plain axios is faster and cheaper.
 */

const axios  = require('axios');
const cheerio = require('cheerio');

const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/json,*/*',
};

// ─── Reveal-button selectors ──────────────────────────────────────────────────
// Buttons that hide contact info behind a JS click — click them before capturing HTML
const REVEAL_SELECTORS = [
    // Dutch
    'button:has-text("Toon nummer")', 'button:has-text("toon nummer")',
    'button:has-text("Toon telefoonnummer")', 'button:has-text("Toon e-mail")',
    'a:has-text("Toon nummer")', 'a:has-text("Bekijk contactgegevens")',
    // English
    'button:has-text("Show number")', 'button:has-text("Show phone")',
    'button:has-text("Show contact")', 'button:has-text("Reveal contact")',
    'button:has-text("View phone")', 'button:has-text("View email")',
    'button:has-text("Show email")', 'a:has-text("Show contact")',
    // Generic apply / contact reveal
    '[class*="reveal-contact"]', '[class*="show-contact"]',
    '[class*="toon-contact"]', '[data-action*="reveal"]',
    '[class*="contact-reveal"]', '[class*="show-phone"]',
];

// ─── API interception patterns ─────────────────────────────────────────────────
// URLs that typically carry job data payloads — intercept these for clean JSON
const JOB_API_PATTERNS = [
    /\/api\/.*job/i, /\/jobs\/.*\.json/i, /\/vacancies\/.*\.json/i,
    /graphql/i, /\/vacancy\/\d+/i, /\/job\/\d+/i,
    /\/api\/v\d+\/jobs/i, /\/api\/v\d+\/vacancies/i,
    /\/rest\/.*job/i, /werkenbij.*\/api/i,
];

/**
 * Strip HTML down to lean LLM-ready text.
 * Removes: script, style, nav, svg, header, footer, noscript, iframe, picture
 * Also strips: class/id/data-* attrs, tracking pixels, hidden elements
 * Compresses: whitespace to single spaces
 * Result is 10–30× smaller than raw HTML.
 */
function stripHtmlToText(html) {
    if (!html) return '';
    const $ = cheerio.load(html);

    // Remove noise elements
    $('script, style, noscript, iframe, picture, svg, canvas').remove();
    $('nav, header, footer').remove();
    $('[aria-hidden="true"]').remove();
    $('[style*="display:none"], [style*="display: none"], [hidden]').remove();

    // Strip all attributes except the ones we want to preserve for contact extraction
    $('*').each((_, el) => {
        const keep = ['href', 'src', 'alt', 'data-cfemail', 'action'];
        const attribs = el.attribs || {};
        for (const attr of Object.keys(attribs)) {
            if (!keep.includes(attr)) {
                delete attribs[attr];
            }
        }
    });

    // Convert link hrefs to inline text so we don't lose mailto/tel/linkedin
    $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim();
        if (href.startsWith('mailto:') || href.startsWith('tel:') || href.includes('linkedin.com/in/')) {
            $(el).replaceWith(`${text} [${href}] `);
        }
    });

    // Get text content — preserve newlines from block elements
    $('br').replaceWith('\n');
    $('p, li, div, h1, h2, h3, h4, h5, h6, tr, td').each((_, el) => {
        $(el).prepend('\n');
    });

    const text = $('body').text()
        .replace(/\t/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')        // collapse horizontal whitespace
        .replace(/\n{3,}/g, '\n\n')         // max 2 consecutive newlines
        .trim();

    return text;
}

/**
 * Check if an intercepted response URL looks like a job data API.
 */
function looksLikeJobApi(url) {
    return JOB_API_PATTERNS.some(p => p.test(url));
}

/**
 * Scrape a single URL using Playwright.
 * Returns { text, interceptedJson, rawHtml }
 *  - interceptedJson: raw JSON string if an API call was intercepted, else null
 *  - text: stripped lean text for LLM
 *  - rawHtml: full rendered HTML (for fallback processing)
 */
async function scrapeWithPlaywright(url) {
    const { chromium } = require('playwright');

    let browser;
    const interceptedPayloads = [];

    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });

        const context = await browser.newContext({
            userAgent: HTTP_HEADERS['User-Agent'],
            extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9,nl;q=0.8' },
        });

        const page = await context.newPage();

        // ── Layer 1: Intercept API responses ──────────────────────────────────
        page.on('response', async (response) => {
            try {
                const respUrl = response.url();
                const contentType = response.headers()['content-type'] || '';
                if (
                    looksLikeJobApi(respUrl) &&
                    contentType.includes('json') &&
                    response.status() === 200
                ) {
                    const body = await response.text().catch(() => '');
                    if (body && body.length > 100 && body.length < 200_000) {
                        interceptedPayloads.push({ url: respUrl, body });
                    }
                }
            } catch {}
        });

        // Navigate and wait for full render
        await page.goto(url, { waitUntil: 'networkidle', timeout: 28000 });

        // ── Layer 2: Click reveal buttons ─────────────────────────────────────
        for (const selector of REVEAL_SELECTORS) {
            try {
                const btn = page.locator(selector).first();
                if (await btn.isVisible({ timeout: 1000 })) {
                    await btn.click({ timeout: 2000 });
                    await page.waitForTimeout(800); // wait for JS to reveal content
                    console.log(`[playwright] Clicked reveal button: ${selector}`);
                }
            } catch { /* selector not found — normal */ }
        }

        // Extra wait for any post-click rendering
        await page.waitForTimeout(1000);

        const rawHtml = await page.content();
        const text    = stripHtmlToText(rawHtml);

        return {
            text,
            rawHtml,
            interceptedJson: interceptedPayloads.length > 0
                ? interceptedPayloads.map(p => p.body).join('\n\n---PAYLOAD---\n\n')
                : null,
        };
    } catch (err) {
        console.log(`[playwright] Error scraping ${url}: ${err.message}`);
        return { text: '', rawHtml: '', interceptedJson: null };
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

/**
 * Scrape a URL — static first, Playwright fallback if content is thin.
 * Returns { text, rawHtml, interceptedJson, usedBrowser }
 */
async function smartScrape(url, { forceBrowser = false, minChars = 800 } = {}) {
    // Static scrape first (fast, cheap)
    if (!forceBrowser) {
        try {
            const resp = await axios.get(url, {
                timeout: 12000,
                maxContentLength: 3 * 1024 * 1024,
                headers: HTTP_HEADERS,
            });
            const rawHtml = resp.data || '';
            const text    = stripHtmlToText(rawHtml);

            if (text.length >= minChars) {
                return { text, rawHtml, interceptedJson: null, usedBrowser: false };
            }
            console.log(`[scraper] Static too thin (${text.length} chars) for ${url} — using Playwright`);
        } catch (e) {
            console.log(`[scraper] Static fetch failed for ${url}: ${e.message} — using Playwright`);
        }
    }

    // Playwright fallback / forced
    const result = await scrapeWithPlaywright(url);
    return { ...result, usedBrowser: true };
}

module.exports = { smartScrape, stripHtmlToText };
