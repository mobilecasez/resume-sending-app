// Resume Builder — new feature. Safe to delete without affecting existing app.
'use strict';

/**
 * Renders resume HTML (from resumeTemplates.js) to PDF and to preview images,
 * using the same Playwright chromium the job scraper already uses in production.
 *
 * Two output modes:
 *   onepage (default) — one continuous page sized to the content; the sidebar band
 *                       is painted by CSS (fills the single page).
 *   a4                — real A4 pages with 14mm content margins. Chromium paints CSS
 *                       backgrounds only over the content height, so a multi-page
 *                       sidebar would stop early. We therefore render the sidebar
 *                       templates with a TRANSPARENT background and composite the
 *                       gradient band behind every page with pdf-lib (reliable).
 *
 * opts.brand = { accent, font } (an employer document's design.brand) flows through to
 * renderResumeHtml, which re-hues the design to the employer's colour and sets its font;
 * the A4 band composited here and the accent reported beside each preview come from
 * brandedTemplate so they match that recoloured HTML. No brand → exactly the old output.
 */

const { renderResumeHtml, TEMPLATES, brandedTemplate } = require('./resumeTemplates');

const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
const A4_W = 794;   // 210mm @ 96dpi
const A4_H = 1123;  // 297mm @ 96dpi

// Sidebar band geometry per template (only the sidebar designs need compositing).
// widthMm matches each template's sidebar width; top/bottom = gradient stops.
const BANDS = {
  azure:     { side: 'left',  widthMm: 75, top: '#0a7aa6', bottom: '#13567a' },
  executive: { side: 'left',  widthMm: 74, top: '#2c3742', bottom: '#222b34' },
};

// ── The resume page is static and offline, by construction ────────────────────────────────────────
// ⚠️ THE RESUME HTML IS NOT OURS TO TRUST, AND THIS BROWSER RUNS INSIDE OUR NETWORK. resumeTemplates
// escapes what it interpolates, but the data it interpolates is user-owned (résumé JSON the client
// PUTs, AI-rebuilt text) and one missed escape anywhere in ~1.5k lines of template is enough: with
// scripts on and the network open, an <iframe src="http://127.0.0.1:…">, an <img> at a metadata
// address or a <link rel="prefetch"> makes OUR server fetch internal pages — and the preview shows
// the user what came back. Same three fences the letter renderer uses (coverLetterRenderer.js), all
// measured here against a local server (2026-09-12, Playwright 1.60 / chromium 1223; before them all
// five of <script fetch>/<img>/<iframe>/<object>/<link rel=prefetch> reached it):
//   1. javaScriptEnabled:false (preparePage) — no page script runs, whatever survives escaping.
//   2. page.route (routeRequests) refuses every request the page's own loader makes except inline
//      data: URIs (the profile photo) and the Google Fonts the templates link — https, those hosts
//      only. It is the SAME handler that serves fontCache, so there is exactly one route on the page
//      and no dependence on Playwright's route-precedence order.
//   3. BLACKHOLE_PROXY (launchBrowser). page.route does NOT see what the browser fetches on the
//      page's behalf — <link rel="prefetch"> went straight past it and hit the server. So the whole
//      browser is pointed at a proxy that does not exist, and only the font hosts may go around it.
//      `<-loopback>` removes Chromium's implicit rule that sends localhost/127.0.0.1 DIRECT past any
//      proxy (Playwright also adds it; spelled out so no upgrade can drop it). route.fetch() for the
//      fonts rides the same bypass, so the cache still fills on a cold browser.
// ⚠️ A new external asset in resumeTemplates needs its host in ALLOWED_HOSTS — which feeds BOTH the
// route and the proxy bypass — or it silently will not load. Inline it as a data: URI instead.
const ALLOWED_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const BLACKHOLE_PROXY = { server: 'http://127.0.0.1:9', bypass: [...ALLOWED_HOSTS, '<-loopback>'].join(',') };
const FONT_SETTLE_MS = 2500;

function isFontRequest(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'https:' && ALLOWED_HOSTS.includes(parsed.hostname);
  } catch { return false; }
}
const isAllowedRequest = (url) => String(url || '').startsWith('data:') || isFontRequest(url);

async function launchBrowser(extraArgs = []) {
  const { chromium } = require('playwright');
  const { launchChromium } = require('./browserLimit');
  // Capped + retried: unbounded launches here were exhausting the container's process budget and
  // failing with `spawn chrome-headless-shell EAGAIN` — which killed previews (screenshots have no
  // PDFKit fallback the way downloads do).
  return launchChromium(chromium, { headless: true, args: [...LAUNCH_ARGS, ...extraArgs], proxy: BLACKHOLE_PROXY });
}
// Previews render STATIC template HTML to a screenshot, so single-process chromium is safe here and
// uses ~1 process / a few threads instead of ~5 processes / ~40 threads. That's what lets a preview
// still spawn while the job scraper is holding its own chromium instances (the EAGAIN cause). NOT
// used for the PDF path, where --single-process can upset page.pdf().
const PREVIEW_ARGS = ['--single-process', '--no-zygote', '--disable-gpu'];

// ── Warm preview browser ──────────────────────────────────────────────────────
// The gallery fires several small preview batches in a row (visible design first, neighbours
// next, a swatch tap after that). Launching chromium PER REQUEST made every one of them pay the
// spawn + semaphore + retry cost — the reported "Azure Sidebar takes forever", because azure is
// simply the first render and eats the whole cold start. One shared browser, closed after 90s of
// quiet, turns request 2..n into just newPage().
let warmBrowser = null;
let warmPage = null;
let warmTimer = null;
// ⚠️ SINGLE-PROCESS CHROMIUM EXITS WHEN A PAGE CLOSES — and cannot hold a second page either.
// This file used to open a page per template and close it: the next newPage() then met "Target
// page, context or browser has been closed". Prod logs, 2026-09-14: `previewTemplates error:
// browser.newPage: Target page, context or browser has been closed` — the user's first "View PDF"
// failed and a retry worked, because warmPreviews() (fired by the catalogue request) had already
// opened and CLOSED its font-priming page, killing the warm browser before the first real render.
// So the warm browser now owns ONE routed page for its whole life; every render swaps content into
// it, and a recycle closes page and browser together, never the page alone (the letter renderer
// was fixed the same way and verified in prod: 3 uncached designs in one call, 3 s).
// Renders share that page, so they are SERIALISED through warmLock — two requests may not interleave
// setContent/screenshot on one page.
let warmChain = Promise.resolve();
function withWarmLock(fn) {
  const run = warmChain.then(fn, fn);
  warmChain = run.catch(() => {});
  return run;
}
// ⚠️ --single-process chromium also degrades after ~4-5 consecutive setContent+screenshot cycles in
// one session (reproduced with a 6-template loop), so the warm browser still RECYCLES after every
// WARM_PAGE_LIMIT rendered pages — a relaunch costs a few hundred ms, a mid-batch crash the request.
let warmPages = 0;
const WARM_PAGE_LIMIT = 3;
async function resetWarm() {
  const b = warmBrowser;
  warmBrowser = null; warmPage = null; warmPages = 0;
  if (b) await b.close().catch(() => {});
}
function armWarmIdle() {
  if (warmTimer) clearTimeout(warmTimer);
  // Through the lock: an idle close can never land in the middle of a render.
  warmTimer = setTimeout(() => { withWarmLock(resetWarm); }, 90_000);
  if (warmTimer.unref) warmTimer.unref();
}
/** The warm page. ONLY call inside withWarmLock. */
async function getWarmPage() {
  if (warmBrowser && warmBrowser.isConnected() && warmPage && !warmPage.isClosed()
      && warmPages < WARM_PAGE_LIMIT) { armWarmIdle(); return warmPage; }
  await resetWarm();
  const browser = await launchBrowser(PREVIEW_ARGS);
  try {
    warmPage = await newRoutedPage(browser);
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
  warmBrowser = browser; warmPages = 0;
  armWarmIdle();
  return warmPage;
}

// ── In-memory Google-Fonts cache ──────────────────────────────────────────────
// Every template's <head> links Poppins/Lato from fonts.googleapis.com, and a fresh browser has
// an empty cache — so every render re-downloaded fonts over the network, and on Railway that
// fetch is the slowest, flakiest part of the render (the 12s setContent timeout exists for it).
// Intercept font requests and serve repeats from memory: the FIRST render pays once, everything
// after — previews and PDFs alike — gets fonts instantly, network down or not.
const fontCache = new Map();   // url → { body: Buffer, contentType }
// The page's ONE route: it is both the font cache and fence #2 above. Everything that is not an
// inline data: URI or one of ALLOWED_HOSTS is refused before it leaves the browser.
async function routeRequests(page) {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (!isFontRequest(url)) {
      // data: URIs (the profile photo) pass through untouched; everything else never loads.
      return (isAllowedRequest(url) ? route.continue() : route.abort('blockedbyclient')).catch(() => {});
    }
    const hit = fontCache.get(url);
    if (hit) return route.fulfill({ body: hit.body, contentType: hit.contentType }).catch(() => {});
    try {
      const resp = await route.fetch();
      const body = await resp.body();
      if (resp.ok()) fontCache.set(url, { body, contentType: resp.headers()['content-type'] || 'application/octet-stream' });
      return route.fulfill({ response: resp, body });
    } catch {
      // Network truly down and nothing cached — let the page fall back to system fonts, exactly
      // as the bounded font-settle race below already allows.
      return route.abort().catch(() => {});
    }
  });
}

async function newRoutedPage(browser) {
  const page = await browser.newPage({ viewport: { width: A4_W, height: A4_H }, javaScriptEnabled: false });
  // Installed BEFORE the content exists, so not even the first subresource escapes it. A route call
  // on a page that is already closing rejects — that is not a render failure.
  await routeRequests(page).catch(() => {});
  return page;
}

async function preparePage(browser, html) {
  return loadHtml(await newRoutedPage(browser), html);
}

async function loadHtml(page, html) {
  // Render must NOT hang on slow/unreachable external web fonts (Google Fonts) —
  // a frequent failure on Railway, where 'networkidle' never settles within the
  // timeout and the whole preview throws "unable to load". Use 'load'; if even
  // that times out (external stylesheet slow), the DOM content is already set, so
  // swallow it and render with whatever loaded (system-font fallback).
  await page.setContent(html, { waitUntil: 'load', timeout: 12000 }).catch(() => {});
  // Give fonts a brief, bounded chance to settle — never block forever.
  // ⚠️ THE BOUND LIVES ON THE NODE SIDE. With javaScriptEnabled:false the page runs no timers, so a
  // setTimeout inside page.evaluate never fires (measured) and the old in-page Promise.race would
  // now wait on document.fonts.ready for as long as a stuck font takes — holding a chromium slot,
  // or the warm browser, the whole time. page.evaluate itself still works (Playwright injects it).
  let timer = null;
  const settled = page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true)).catch(() => false);
  await Promise.race([settled, new Promise((r) => { timer = setTimeout(r, FONT_SETTLE_MS); })]);
  clearTimeout(timer);
  return page;
}

async function sheetHeight(page) {
  return page.evaluate((minH) => {
    const el = document.querySelector('.sheet');
    return Math.max(minH, Math.ceil((el ? el.scrollHeight : document.body.scrollHeight) + 1));
  }, A4_H);
}

const normMode = (m) => (m === 'a4' ? 'a4' : 'onepage');

const hex = (h) => ({
  r: parseInt(h.slice(1, 3), 16) / 255,
  g: parseInt(h.slice(3, 5), 16) / 255,
  b: parseInt(h.slice(5, 7), 16) / 255,
});
const lerp = (a, b, t) => a + (b - a) * t;

// Paint a white page + the sidebar gradient band behind the (transparent) content
// of every page. Guarantees a full-height sidebar across all A4 pages.
async function compositeBand(pdfBuffer, band) {
  const { PDFDocument, rgb } = require('pdf-lib');
  const src = await PDFDocument.load(pdfBuffer);
  const out = await PDFDocument.create();
  const top = hex(band.top), bot = hex(band.bottom);
  const STRIPS = 90; // smooth vertical gradient

  const pages = src.getPageCount();
  for (let i = 0; i < pages; i++) {
    const embedded = await out.embedPage(src.getPage(i));
    const { width: W, height: H } = src.getPage(i).getSize();
    const bw = (band.widthMm / 210) * W;
    const x  = band.side === 'right' ? W - bw : 0;

    const pg = out.addPage([W, H]);
    pg.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 1, 1) }); // white page
    const sh = H / STRIPS;
    for (let s = 0; s < STRIPS; s++) {
      const t = s / (STRIPS - 1);
      const y = H - (s + 1) * sh;
      pg.drawRectangle({
        x, y, width: bw, height: sh + 1,
        color: rgb(lerp(top.r, bot.r, t), lerp(top.g, bot.g, t), lerp(top.b, bot.b, t)),
      });
    }
    pg.drawPage(embedded, { x: 0, y: 0, width: W, height: H }); // content on top
  }
  return Buffer.from(await out.save());
}

// ── Single template → PDF buffer ──────────────────────────────────────────────
async function renderPdf(templateId, resumeData, opts = {}) {
  const mode = normMode(opts.mode);
  const html = renderResumeHtml(templateId, resumeData, { ...opts, mode });
  const browser = await launchBrowser();
  try {
    const page = await preparePage(browser, html);
    if (mode === 'a4') {
      const pdfBuf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
      // The registry entry carries the band (variants carry a RECOLORED one); the local BANDS
      // table stays only as a fallback for the two base ids. A branded document carries the band
      // re-hued to the employer's colour from the FAMILY's palette — the same shift the HTML got —
      // and brandedTemplate hands back the template's own band when the brand has no colour.
      const tpl = TEMPLATES.find((t) => t.id === templateId);
      const band = (tpl && (opts.brand ? brandedTemplate(tpl, opts.brand).band : tpl.band)) || BANDS[templateId];
      return band ? await compositeBand(pdfBuf, band) : pdfBuf;
    }
    // One continuous page sized exactly to the content.
    const h = await sheetHeight(page);
    return await page.pdf({
      printBackground: true,
      width: '210mm',
      height: `${h}px`,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
      pageRanges: '1',
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── All templates → preview images (base64 JPEG data URIs) ────────────────────
// One-page render; a full-page screenshot captures the CSS sidebar band. Returns
// { id, name, accent, image, width, height } so the app can size to the real aspect.
async function renderPreviews(resumeData, opts = {}, templates = TEMPLATES) {
  // Per-TEMPLATE render with per-template recovery, each one on the warm page under the lock (see
  // above). A failed render resets the warm browser and retries just that template; a template that
  // fails twice is left OUT of the result (callers already treat a missing id as "could not render")
  // instead of throwing away the designs this batch already finished.
  const renderOne = (tpl) => withWarmLock(async () => {
    const page = await getWarmPage();
    const html = renderResumeHtml(tpl.id, resumeData, { ...opts, mode: 'onepage' });
    await page.setViewportSize({ width: A4_W, height: A4_H });
    await loadHtml(page, html);
    const h = await sheetHeight(page);
    await page.setViewportSize({ width: A4_W, height: h });
    // ⚠️ The page is REUSED, so a capture right after the resize can come back with the previous
    // design's texture. A throwaway 8×8 capture forces the compositor to produce a frame at the NEW
    // size first — no page script needed (JS is off, so an in-page animation-frame callback never fires).
    await page.screenshot({ type: 'jpeg', quality: 1, clip: { x: 0, y: 0, width: 8, height: 8 } }).catch(() => {});
    const shot = await page.screenshot({
      type: 'jpeg',
      quality: 82,
      clip: { x: 0, y: 0, width: A4_W, height: h },
    });
    warmPages += 1;
    return {
      id: tpl.id,
      name: tpl.name,
      // The accent the image actually shows: the employer's re-hue of it for a branded document.
      accent: opts.brand ? brandedTemplate(tpl, opts.brand).accent : tpl.accent,
      ats: tpl.ats || null,
      image: `data:image/jpeg;base64,${shot.toString('base64')}`,
      width: A4_W,
      height: h,
    };
  });
  const results = [];
  for (const tpl of templates) {
    try {
      results.push(await renderOne(tpl));
    } catch (first) {
      await withWarmLock(resetWarm);
      try {
        results.push(await renderOne(tpl));   // one clean retry, fresh browser, this template only
      } catch (e) {
        console.warn(`[resumeRenderer] preview "${tpl.id}" failed twice:`, String((e && e.message) || e).split('\n')[0]);
      }
    }
  }
  if (!results.length && templates.length) throw new Error('No preview could be rendered');
  return results;
}

// Fire-and-forget pipeline warm-up, called when the user OPENS the gallery (the catalogue
// request). The browser launches and the fonts download while the app is still doing its own
// round trip + first paint — so the first real preview request finds both already hot. Never
// throws, never blocks the caller; the idle timer tears it down like any other use.
let warmingUp = false;
async function warmPreviews() {
  if (warmingUp) return;
  warmingUp = true;
  try {
    await withWarmLock(async () => {
      const page = await getWarmPage();
      if (fontCache.size) return;
      // Prime the font cache with the same <head> every template ships — on the WARM page, which
      // stays open (closing any page is what used to kill the warm browser before the first render).
      await page.setContent(
        `<html><head><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&family=Lato:wght@300;400;700&display=swap" rel="stylesheet"></head>` +
        `<body style="font-family:'Poppins','Lato',sans-serif">warm</body></html>`,
        { waitUntil: 'load', timeout: 10000 }).catch(() => {});
      let timer = null;
      const settled = page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true)).catch(() => false);
      await Promise.race([settled, new Promise((r) => { timer = setTimeout(r, 3000); })]);
      clearTimeout(timer);
    });
  } catch { /* cold path still works; this is purely a head start */ }
  finally { warmingUp = false; }
}

module.exports = { renderPdf, renderPreviews, warmPreviews, isAllowedRequest };
