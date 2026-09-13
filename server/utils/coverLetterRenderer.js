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
const FONT_SETTLE_MS = 2500;

// ── The letter page is static and offline, by construction ─────────────────────────────────────────
// ⚠️ THE LETTER HTML IS NOT OURS TO TRUST, AND THIS BROWSER RUNS INSIDE OUR NETWORK. The body reaches
// here from a client (preview-templates and the classic download send it) or from a stored document
// that PUT /api/employer-docs/:id lets its owner rewrite, and coverLetterTemplates' sanitizeBody is a
// blacklist. With scripts on and the network open, an <iframe src="http://127.0.0.1:…">, an <img> at
// a metadata address or a <link rel="prefetch"> made OUR server fetch internal pages — and a thumbnail
// showed the user what came back. Three fences, each measured against a local server (2026-09-11,
// Playwright 1.60 / chromium 1223):
//   1. javaScriptEnabled:false (newRoutedPage — the one place a page is made, for the PDF path and the
//      preview loop alike) — no page script runs, whatever survives sanitising.
//   2. page.route (newRoutedPage) refuses every request the page's own loader makes except inline data:
//      URIs (the profile photo) and the Google Fonts the templates link — https, those hosts only.
//      Blocked iframes, images, CSS backgrounds, <object>/<embed>, SVG images and posters: all stopped.
//   3. BLACKHOLE_PROXY (launchBrowser). page.route does NOT see what the browser fetches on the page's
//      behalf — a <link rel="prefetch"> went straight past it (and past context.route) and hit the
//      server. So the whole browser is pointed at a proxy that does not exist, and only the font hosts
//      may go around it: any request the network service makes for anything else fails to connect,
//      whoever initiated it. `<-loopback>` removes Chromium's implicit rule that sends localhost and
//      127.0.0.1 DIRECT past any proxy (Playwright also adds it; spelled out so no upgrade can drop it).
// ⚠️ A new external asset in coverLetterTemplates needs its host in ALLOWED_HOSTS — which feeds BOTH
// the route and the proxy bypass — or it silently will not load. Inline it as a data: URI instead.
const ALLOWED_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const BLACKHOLE_PROXY = { server: 'http://127.0.0.1:9', bypass: [...ALLOWED_HOSTS, '<-loopback>'].join(',') };

function isAllowedRequest(url) {
  const u = String(url || '');
  if (u.startsWith('data:')) return true;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' && ALLOWED_HOSTS.includes(parsed.hostname);
  } catch { return false; }
}

async function launchBrowser(extraArgs = []) {
  const { chromium } = require('playwright');
  const { launchChromium } = require('./browserLimit');
  // Capped + retried — see resumeRenderer / browserLimit: prevents the `spawn … EAGAIN` that broke
  // cover-letter previews when chromium instances piled up in the container.
  return launchChromium(chromium, { headless: true, args: [...LAUNCH_ARGS, ...extraArgs], proxy: BLACKHOLE_PROXY });
}
// Single-process for the screenshot PREVIEW path only (safe for static HTML, tiny footprint) — see
// resumeRenderer. Not used for the PDF path.
const PREVIEW_ARGS = ['--single-process', '--no-zygote', '--disable-gpu'];

async function newRoutedPage(browser) {
  const page = await browser.newPage({ viewport: { width: A4_W, height: A4_H }, javaScriptEnabled: false });
  // Installed BEFORE the content exists, so not even the first subresource escapes it. A route call on a
  // page that is already closing rejects — that is not a render failure.
  await page.route('**/*', (route) => (isAllowedRequest(route.request().url())
    ? route.continue()
    : route.abort('blockedbyclient')).catch(() => {}));
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
  // ⚠️ THE BOUND LIVES ON THE NODE SIDE. With javaScriptEnabled:false a setTimeout inside page.evaluate
  // never fires (measured: an in-page race against a font that never answered hung past 45 s), so the
  // old in-page Promise.race would now wait on document.fonts.ready for as long as a stuck font takes —
  // holding one of browserLimit's two chromium slots the whole time.
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
  // ⚠️ SINGLE-PROCESS CHROMIUM EXITS WHEN A PAGE CLOSES — and it cannot hold a second page either.
  // This loop used to open a page per template and close it, so the SECOND template always met "Target
  // page, context or browser has been closed", the whole call threw, and the pages already rendered were
  // thrown away with it. Home asks for letter pages three at a time, so every letter design that was not
  // already cached came back missing (prod, 2026-09-13: ids=technical,ats_pro,euro_motivation → 500,
  // each alone → 200; reproduced locally on chromium 1223 with and without the proxy).
  // So: ONE routed page for the whole batch, content swapped per template (measured: 7 in a row on one
  // page, no failure), and one clean retry on a fresh browser for a template that still fails.
  let browser = null;
  let page = null;
  const open = async () => {
    if (browser) await browser.close().catch(() => {});
    browser = await launchBrowser(PREVIEW_ARGS);   // single-process → survives scraper contention
    page = await newRoutedPage(browser);
  };
  const shoot = async (tpl) => {
    const html = renderCoverLetterHtml(tpl.id, data, { ...opts, mode: 'onepage' });
    await page.setViewportSize({ width: A4_W, height: A4_H });
    await loadHtml(page, html);
    const h = await sheetHeight(page);
    await page.setViewportSize({ width: A4_W, height: h });
    // The page is REUSED, so a capture right after the resize can come back with the previous letter's
    // texture. A throwaway 8×8 capture forces a compositor frame at the new size first (no page script
    // needed — JS is off, so an in-page requestAnimationFrame would never fire).
    await page.screenshot({ type: 'jpeg', quality: 1, clip: { x: 0, y: 0, width: 8, height: 8 } }).catch(() => {});
    const shot = await page.screenshot({ type: 'jpeg', quality: 82, clip: { x: 0, y: 0, width: A4_W, height: h } });
    return { id: tpl.id, name: tpl.name, accent: tpl.accent,
      image: `data:image/jpeg;base64,${shot.toString('base64')}`, width: A4_W, height: h };
  };
  try {
    await open();
    const results = [];
    for (const tpl of templates) {
      try {
        if (!browser.isConnected()) await open();
        results.push(await shoot(tpl));
      } catch (first) {
        try {
          await open();   // one clean retry, fresh browser, this template only
          results.push(await shoot(tpl));
        } catch (e) {
          console.warn(`[coverLetterRenderer] preview "${tpl.id}" failed twice:`, String((e && e.message) || e).split('\n')[0]);
        }
      }
    }
    return results;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { renderPdf, renderPreviews, isAllowedRequest };
