// Cover Letter Builder — new feature. Safe to delete without affecting existing app.
'use strict';

/**
 * Renders cover-letter HTML (coverLetterTemplates.js) to PDF and preview images via
 * the same Playwright chromium the resume renderer / scraper use. Letters are single
 * column, so no background compositing is needed.
 *   onepage — one continuous page sized to the content.
 *   a4      — real A4 pages (20mm top/bottom margins via @page).
 * opts.brandColor / opts.brandFont (an employer letter's brand) flow through to the templates,
 * which re-hue every design's accent and set the font; the accent reported beside each card
 * image is that re-hued one (brandedLetterAccent). No brand → exactly the old output.
 */

const { renderCoverLetterHtml, TEMPLATES, brandedLetterAccent } = require('./coverLetterTemplates');

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

// ── Preview density + format: PREVIEW_REV (mirrors resumeRenderer — the reasoning and the measurements are there) ──
// ⚠️ LETTERS WERE THE BLURRIEST PAGE IN THE APP. A 1x JPEG (794 px) drawn 1107 physical px wide on a 3x phone and
// pinched to 3x: small serif body text is exactly what an upscale smears first (field report 2026-09-18). Measured
// on two letter designs (SSIM at the 2x-zoom display density): 1x 0.72–0.78 · 3x 0.96, and 3x as WebP q80 is
// 300–390 KB of base64 per page against 600–740 KB as chromium's JPEG. Same constants as resumeRenderer, held
// together by test-preview-sharpness.js; the letter controllers put PREVIEW_REV into every key that stores a page
// or a card derived from one. Change any of them → bump PREVIEW_REV (here AND in resumeRenderer).
const PREVIEW_REV = 'hd1';
const PREVIEW_DPR = 3;
const PREVIEW_FORMAT = 'webp';
const PREVIEW_BUDGET = 450 * 1024;       // one page's base64 payload
const WEBP_MAX_PX = 16383;               // libwebp's hard limit on either side
// Best first; `bytes` = the rung's measured size against the first rung's, so a rung that cannot fit is skipped
// unencoded. The last rung (2x) is the floor, served whatever it weighs. A one-page letter never leaves rung one.
const PREVIEW_LADDER = [
  { scale: 1,       quality: 80, bytes: 1 },
  { scale: 1,       quality: 50, bytes: 0.72 },
  { scale: 2.5 / 3, quality: 50, bytes: 0.56 },
  { scale: 2 / 3,   quality: 50, bytes: 0.43 },
];
const b64Len = (n) => Math.ceil(n / 3) * 4;

/**
 * One captured page (chromium's JPEG q82 at PREVIEW_DPR) → { image: data URI, width, height } in the IMAGE's pixels:
 * WebP, down PREVIEW_LADDER until the payload fits PREVIEW_BUDGET. Never throws: without sharp — or on bytes it cannot
 * read, or when not one rung can encode — the capture itself is served (a JPEG at the same density: heavier, just as
 * sharp). It needs no page, so the preview loop runs it while the next design renders.
 */
async function encodePreview(capture, cssW, cssH) {
  try {
    const sharp = require('sharp');
    const { data, info } = await sharp(capture).raw().toBuffer({ resolveWithObject: true });   // decoded once, for every rung
    // ⚠️ A page past ~4.9 A4 at 3x is taller than WebP can hold (16383 px a side), so every rung is also bounded by
    // HEIGHT — never by a width derived from it: Math.round(width × 16383 / height) rounds UP about half the time,
    // the height sharp derives back from that width lands on 16384–16386, and the encode throws (measured: a 26697-px
    // page at 1462 px across → 16386). `fit: 'inside'` makes the binding side exact and the other one smaller.
    const tall = info.height > WEBP_MAX_PX;
    let out = null;
    let first = 0;
    for (let i = 0; i < PREVIEW_LADDER.length; i++) {
      const rung = PREVIEW_LADDER[i];
      const floor = i === PREVIEW_LADDER.length - 1;
      if (out && !floor && first * rung.bytes > PREVIEW_BUDGET * 1.1) continue;               // predicted to miss: skip the encode
      let pipe = sharp(data, { raw: info });
      if (rung.scale < 1 || tall) {
        pipe = pipe.resize({ width: Math.min(Math.round(info.width * rung.scale), WEBP_MAX_PX), height: WEBP_MAX_PX, fit: 'inside', kernel: 'lanczos3' });
      }
      // One rung that cannot encode falls through to the next — never straight to the raw capture (a 3x JPEG of
      // several MB, outside any budget, that the caches would then keep and serve on every gallery open).
      let enc;
      try { enc = await pipe.webp({ quality: rung.quality, effort: 4 }).toBuffer({ resolveWithObject: true }); } catch { continue; }
      out = enc;
      if (!first) first = b64Len(out.data.length);
      if (b64Len(out.data.length) <= PREVIEW_BUDGET) break;
    }
    if (!out) throw new Error('no rung encoded');                                             // → the capture, below
    return { image: `data:image/webp;base64,${out.data.toString('base64')}`, width: out.info.width, height: out.info.height };
  } catch {
    return { image: `data:image/jpeg;base64,${capture.toString('base64')}`, width: Math.round(cssW * PREVIEW_DPR), height: Math.round(cssH * PREVIEW_DPR) };
  }
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

// `dpr` is the page's deviceScaleFactor: PREVIEW_DPR for the preview loop; the PDF path keeps 1 — page.pdf() is
// vector and came out byte-identical at 1x and 3x (measured, 2026-09-18), so a denser raster there buys nothing.
async function newRoutedPage(browser, dpr = 1) {
  const page = await browser.newPage({ viewport: { width: A4_W, height: A4_H }, deviceScaleFactor: dpr, javaScriptEnabled: false });
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

// ── Region's templates → preview images (base64 WebP at PREVIEW_DPR — see PREVIEW_REV) ──────────────
// { id, name, accent, image, width, height }: width/height are the IMAGE's pixels (2382 across at 3x); clients size
// by their ratio, so the denser page changes nothing about layout.
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
    page = await newRoutedPage(browser, PREVIEW_DPR);
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
    // The clip is in CSS pixels; the capture comes back at PREVIEW_DPR (the page's deviceScaleFactor).
    const shot = await page.screenshot({ type: 'jpeg', quality: 82, clip: { x: 0, y: 0, width: A4_W, height: h } });
    return { shot, h, meta: { id: tpl.id, name: tpl.name, accent: brandedLetterAccent(tpl, opts.brandColor) } };
  };
  try {
    await open();
    const pending = [];
    for (const tpl of templates) {
      let cap = null;
      try {
        if (!browser.isConnected()) await open();
        cap = await shoot(tpl);
      } catch (first) {
        try {
          await open();   // one clean retry, fresh browser, this template only
          cap = await shoot(tpl);
        } catch (e) {
          console.warn(`[coverLetterRenderer] preview "${tpl.id}" failed twice:`, String((e && e.message) || e).split('\n')[0]);
        }
      }
      // The encode needs no page, so it runs while the next letter renders; the answer keeps the order.
      if (cap) pending.push(encodePreview(cap.shot, A4_W, cap.h).then((img) => ({ ...cap.meta, ...img })));
    }
    return await Promise.all(pending);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  renderPdf, renderPreviews, isAllowedRequest,
  // PREVIEW_REV goes into every letter page/card cache key (the letter controllers); the rest are read by test-preview-sharpness.js.
  PREVIEW_REV, PREVIEW_DPR, PREVIEW_FORMAT, PREVIEW_BUDGET, encodePreview,
};
