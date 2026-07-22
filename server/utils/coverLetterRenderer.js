// Cover Letter Builder — new feature. Safe to delete without affecting existing app.
'use strict';

/**
 * Renders cover-letter HTML (coverLetterTemplates.js) to PDF and preview images via
 * the same Playwright chromium the resume renderer / scraper use. Letters are single
 * column, so no background compositing is needed.
 *   onepage — one continuous page sized to the content.
 *   a4      — real A4 pages (20mm top/bottom margins via @page).
 */

const { renderCoverLetterHtml, TEMPLATES } = require('./coverLetterTemplates');

const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
const A4_W = 794;   // 210mm @ 96dpi
const A4_H = 1123;  // 297mm @ 96dpi

async function launchBrowser() {
  const { chromium } = require('playwright');
  const { launchChromium } = require('./browserLimit');
  // Capped + retried — see resumeRenderer / browserLimit: prevents the `spawn … EAGAIN` that broke
  // cover-letter previews when chromium instances piled up in the container.
  return launchChromium(chromium, { headless: true, args: LAUNCH_ARGS });
}

async function preparePage(browser, html) {
  const page = await browser.newPage({ viewport: { width: A4_W, height: A4_H } });
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
  } catch {}
  return page;
}

async function sheetHeight(page) {
  return page.evaluate((minH) => {
    const el = document.querySelector('.sheet');
    return Math.max(minH, Math.ceil((el ? el.scrollHeight : document.body.scrollHeight) + 1));
  }, A4_H);
}

const normMode = (m) => (m === 'a4' ? 'a4' : 'onepage');

// ── Single template → PDF buffer ──────────────────────────────────────────────
async function renderPdf(templateId, data, opts = {}) {
  const mode = normMode(opts.mode);
  const html = renderCoverLetterHtml(templateId, data, { ...opts, mode });
  const browser = await launchBrowser();
  try {
    const page = await preparePage(browser, html);
    if (mode === 'a4') {
      return await page.pdf({ printBackground: true, preferCSSPageSize: true });
    }
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

// ── Region's templates → preview images (base64 JPEG) ─────────────────────────
async function renderPreviews(data, opts = {}, templates = TEMPLATES) {
  const browser = await launchBrowser();
  try {
    const results = [];
    for (const tpl of templates) {
      const html = renderCoverLetterHtml(tpl.id, data, { ...opts, mode: 'onepage' });
      const page = await preparePage(browser, html);
      const h = await sheetHeight(page);
      await page.setViewportSize({ width: A4_W, height: h });
      const shot = await page.screenshot({ type: 'jpeg', quality: 82, clip: { x: 0, y: 0, width: A4_W, height: h } });
      await page.close().catch(() => {});
      results.push({
        id: tpl.id, name: tpl.name, accent: tpl.accent,
        image: `data:image/jpeg;base64,${shot.toString('base64')}`,
        width: A4_W, height: h,
      });
    }
    return results;
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { renderPdf, renderPreviews };
