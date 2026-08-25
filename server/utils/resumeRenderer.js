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
 */

const { renderResumeHtml, TEMPLATES } = require('./resumeTemplates');

const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
const A4_W = 794;   // 210mm @ 96dpi
const A4_H = 1123;  // 297mm @ 96dpi

// Sidebar band geometry per template (only the sidebar designs need compositing).
// widthMm matches each template's sidebar width; top/bottom = gradient stops.
const BANDS = {
  azure:     { side: 'left',  widthMm: 75, top: '#0a7aa6', bottom: '#13567a' },
  executive: { side: 'left',  widthMm: 74, top: '#2c3742', bottom: '#222b34' },
};

async function launchBrowser(extraArgs = []) {
  const { chromium } = require('playwright');
  const { launchChromium } = require('./browserLimit');
  // Capped + retried: unbounded launches here were exhausting the container's process budget and
  // failing with `spawn chrome-headless-shell EAGAIN` — which killed previews (screenshots have no
  // PDFKit fallback the way downloads do).
  return launchChromium(chromium, { headless: true, args: [...LAUNCH_ARGS, ...extraArgs] });
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
let warmTimer = null;
let warmLaunching = null;
function armWarmIdle() {
  if (warmTimer) clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    const b = warmBrowser; warmBrowser = null;
    if (b) b.close().catch(() => {});
  }, 90_000);
  if (warmTimer.unref) warmTimer.unref();
}
async function getWarmBrowser() {
  if (warmBrowser && warmBrowser.isConnected()) { armWarmIdle(); return warmBrowser; }
  warmBrowser = null;
  if (!warmLaunching) {
    warmLaunching = launchBrowser(PREVIEW_ARGS)
      .then((b) => { warmBrowser = b; warmLaunching = null; armWarmIdle(); return b; })
      .catch((e) => { warmLaunching = null; throw e; });
  }
  return warmLaunching;
}

// ── In-memory Google-Fonts cache ──────────────────────────────────────────────
// Every template's <head> links Poppins/Lato from fonts.googleapis.com, and a fresh browser has
// an empty cache — so every render re-downloaded fonts over the network, and on Railway that
// fetch is the slowest, flakiest part of the render (the 12s setContent timeout exists for it).
// Intercept font requests and serve repeats from memory: the FIRST render pays once, everything
// after — previews and PDFs alike — gets fonts instantly, network down or not.
const fontCache = new Map();   // url → { body: Buffer, contentType }
async function routeFonts(page) {
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (route) => {
    const url = route.request().url();
    const hit = fontCache.get(url);
    if (hit) return route.fulfill({ body: hit.body, contentType: hit.contentType });
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

async function preparePage(browser, html) {
  const page = await browser.newPage({ viewport: { width: A4_W, height: A4_H } });
  await routeFonts(page).catch(() => {});
  // Render must NOT hang on slow/unreachable external web fonts (Google Fonts) —
  // a frequent failure on Railway, where 'networkidle' never settles within the
  // timeout and the whole preview throws "unable to load". Use 'load'; if even
  // that times out (external stylesheet slow), the DOM content is already set, so
  // swallow it and render with whatever loaded (system-font fallback).
  await page.setContent(html, { waitUntil: 'load', timeout: 12000 }).catch(() => {});
  // Give fonts a brief, bounded chance to settle — never block forever.
  try {
    await page.evaluate(() => Promise.race([
      (document.fonts ? document.fonts.ready : Promise.resolve()),
      new Promise((r) => setTimeout(r, 2500)),
    ]));
  } catch { /* fonts API missing — ignore */ }
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
      // table stays only as a fallback for the two base ids.
      const tpl = TEMPLATES.find((t) => t.id === templateId);
      const band = (tpl && tpl.band) || BANDS[templateId];
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
  // One attempt on the warm browser; if it died between requests (container pressure, crash),
  // reset and pay one fresh launch — never fail the request on a stale handle.
  const renderAll = async (browser) => {
    const results = [];
    for (const tpl of templates) {
      const html = renderResumeHtml(tpl.id, resumeData, { ...opts, mode: 'onepage' });
      const page = await preparePage(browser, html);
      try {
        const h = await sheetHeight(page);
        await page.setViewportSize({ width: A4_W, height: h });
        const shot = await page.screenshot({
          type: 'jpeg',
          quality: 82,
          clip: { x: 0, y: 0, width: A4_W, height: h },
        });
        results.push({
          id: tpl.id,
          name: tpl.name,
          accent: tpl.accent,
          ats: tpl.ats || null,
          image: `data:image/jpeg;base64,${shot.toString('base64')}`,
          width: A4_W,
          height: h,
        });
      } finally {
        await page.close().catch(() => {});
      }
    }
    return results;
  };
  try {
    return await renderAll(await getWarmBrowser());
  } catch (e) {
    const b = warmBrowser; warmBrowser = null;
    if (b) await b.close().catch(() => {});
    return renderAll(await getWarmBrowser());   // one clean retry on a fresh browser
  }
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
    const browser = await getWarmBrowser();
    if (!fontCache.size) {
      // Prime the font cache with the same <head> every template ships.
      const page = await browser.newPage({ viewport: { width: 200, height: 100 } });
      try {
        await routeFonts(page);
        await page.setContent(
          `<html><head><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&family=Lato:wght@300;400;700&display=swap" rel="stylesheet"></head>` +
          `<body style="font-family:'Poppins','Lato',sans-serif">warm</body></html>`,
          { waitUntil: 'load', timeout: 10000 }).catch(() => {});
        await page.evaluate(() => Promise.race([
          (document.fonts ? document.fonts.ready : Promise.resolve()),
          new Promise((r) => setTimeout(r, 3000)),
        ])).catch(() => {});
      } finally { await page.close().catch(() => {}); }
    }
  } catch { /* cold path still works; this is purely a head start */ }
  finally { warmingUp = false; }
}

module.exports = { renderPdf, renderPreviews, warmPreviews };
