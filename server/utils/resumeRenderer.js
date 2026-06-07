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

async function launchBrowser() {
  const { chromium } = require('playwright');
  return chromium.launch({ headless: true, args: LAUNCH_ARGS });
}

async function preparePage(browser, html) {
  const page = await browser.newPage({ viewport: { width: A4_W, height: A4_H } });
  await page.setContent(html, { waitUntil: 'networkidle', timeout: 20000 });
  try {
    await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
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
      const band = BANDS[templateId];
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
  const browser = await launchBrowser();
  try {
    const results = [];
    for (const tpl of templates) {
      const html = renderResumeHtml(tpl.id, resumeData, { ...opts, mode: 'onepage' });
      const page = await preparePage(browser, html);
      const h = await sheetHeight(page);
      await page.setViewportSize({ width: A4_W, height: h });
      const shot = await page.screenshot({
        type: 'jpeg',
        quality: 82,
        clip: { x: 0, y: 0, width: A4_W, height: h },
      });
      await page.close().catch(() => {});
      results.push({
        id: tpl.id,
        name: tpl.name,
        accent: tpl.accent,
        ats: tpl.ats || null,
        image: `data:image/jpeg;base64,${shot.toString('base64')}`,
        width: A4_W,
        height: h,
      });
    }
    return results;
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { renderPdf, renderPreviews };
