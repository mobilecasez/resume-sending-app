// Preview sharpness — the page a user pinch-zooms in the gallery, for résumés AND letters (PREVIEW_REV).
//   DATABASE_URL=postgresql://t@localhost:5432/t node server/scripts/test-preview-sharpness.js
//
// Why this exists: "on the pdf viewer where the download option is there, the preview is not crystal clear and
// looks very blurry on zoom… specially for cover letter" (2026-09-18). Both renderers captured the page at its
// 794-px CSS width with deviceScaleFactor 1 as JPEG q82, while the app draws it CARD_W = window − 24 pt wide — 369 pt,
// 1107 physical px on a 393-pt 3x iPhone — and lets the user pinch to 3x: the page was upscaled from the first frame
// and dissolved under the pinch. These assertions render REAL pages through the REAL renderers (chromium, JS off, the
// warm page) and pin what the fix promises: 794 × PREVIEW_DPR pixels across, WebP, within the payload budget, a page
// taller than WebP can hold still a WebP (never the multi-MB raw capture), a Home card that is still a small JPEG cut
// from the sharp page — and PREVIEW_REV in every cache key, so a page rendered at the old 1x is never served again (it
// ages out through the cache's own LRU; nothing mass-deletes).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// Comments are commentary — the source pins read executable lines only. (Line-wise on purpose: a block-comment regex
// would take the route glob '**/*' in both renderers for the start of a comment and eat the code after it.)
const strip = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
const fnBody = (src, name) => {
  const start = src.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  if (start < 0) return '';
  const rest = src.slice(start + 1);
  const next = rest.search(/^(?:async )?function \w+\(|^module\.exports/m);
  return src.slice(start, next < 0 ? undefined : start + 1 + next);
};

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 240) : '')); } };

const sharp = require(path.join(ROOT, 'node_modules/sharp'));
const RR = require('../utils/resumeRenderer');
const CR = require('../utils/coverLetterRenderer');
const RT = require('../utils/resumeTemplates');
const CL = require('../utils/coverLetterTemplates');

const A4_W = 794, A4_H = 1123;
// The phone in the report: 393 pt at 3x. Both galleries draw the page CARD_W = window − 2 × 12 pt wide, and at 2x
// zoom that is 2 × 369 × 3 = 2214 physical px across the page — what the render has to cover without an upscale.
const PX_ACROSS_AT_2X = (393 - 24) * 3 * 2;
const DPR = RR.PREVIEW_DPR;
const BUDGET = RR.PREVIEW_BUDGET;
const USER = 999996;                                  // not a real account; nothing else touches it
const kb = (n) => Math.round(n / 1024);

const RESUME = {
  personal_info: { full_name: 'Ava Torres', title: 'Senior Product Engineer', email: 'ava.torres@example.com', phone: '+41 79 000 00 00', location: 'Zürich, Switzerland', linkedin_url: 'linkedin.com/in/avatorres' },
  summary: 'Product engineer with eight years shipping consumer software across web and mobile. Owns features from problem statement to production, with a record of measurable wins in performance, reliability and conversion.',
  experience: [
    { role: 'Senior Product Engineer', company: 'Acme Payments AG', location: 'Zürich', start_date: '2021-03', end_date: 'Present', highlights: ['Cut checkout latency 40% by moving rendering to the edge, lifting conversion 6%', 'Led the migration of 3 core services to Kubernetes with zero customer-facing downtime', 'Mentored 4 engineers; two promoted within 18 months', 'Designed the fraud-signal pipeline processing 2M events per day'] },
    { role: 'Software Engineer', company: 'Beta Labs GmbH', location: 'Berlin', start_date: '2018-01', end_date: '2021-02', highlights: ['Built the payments API used by 200 merchants and 1.4M end customers', 'Introduced CI/CD, cutting release time from days to under an hour', 'Rewrote the reporting service in TypeScript; p95 from 2.1s to 280ms'] },
  ],
  education: [{ degree: 'BSc Computer Science', institution: 'ETH Zürich', start_date: '2012', end_date: '2016' }],
  skills: { technical: ['TypeScript', 'React', 'Node.js', 'PostgreSQL', 'Kubernetes', 'GraphQL'], soft: ['Leadership', 'Mentoring'] },
  languages: [{ name: 'English', level: 'Native' }, { name: 'German', level: 'C1' }],
};
// A long one-page résumé (~2.3 A4): the page that has to give something up to stay inside the budget.
const LONG_RESUME = { ...RESUME, experience: Array.from({ length: 11 }, (_, i) => ({ ...RESUME.experience[i % 2], company: `${RESUME.experience[i % 2].company} ${i + 1}` })) };
const pick = (list, ids) => ids.map((id) => list.find((t) => t.id === id));
const LETTER = {
  sender: { name: 'Ava Torres', title: 'Senior Product Engineer', email: 'ava.torres@example.com', phone: '+41 79 000 00 00', location: 'Zürich, Switzerland' },
  company: { name: 'Nordex SE', address: 'Langenhorner Chaussee 600, 22419 Hamburg, Germany' },
  bodyHtml: '<p>Dear Hiring Manager,</p><p>I am writing to apply for the Senior Software Engineer role on the Nordex digital platforms team. Over eight years I have shipped <strong>twelve products</strong> to four million users.</p>'
    + '<p>At Acme Payments I cut checkout latency by 40%, led the migration of three core services to Kubernetes with zero customer-facing downtime, and designed the fraud-signal pipeline that now processes two million events a day for a Swiss retail bank.</p>'
    + '<p>What draws me to Nordex is the scale: telemetry from thousands of turbines, where a reliable data platform turns directly into energy delivered.</p><p>Thank you for your time and consideration.</p>',
};

/** A data URI → { head, buf, b64 }. */
const partsOf = (uri) => { const [head, b64 = ''] = String(uri || '').split(','); return { head, b64, buf: Buffer.from(b64, 'base64') }; };

// Real density, not just a pixel count: of the pixels on an edge (a step of > 24 grey levels across 2 px), the share
// whose step is STEEP (> 128). A page rendered at 3x takes a glyph from ink to paper in a pixel or two; a 1x page that
// was merely UPSCALED to the same size (the cheap way to make the numbers pass) spreads every edge over three.
// Measured 2026-09-18: 0.54 (résumé) / 0.61 (letter) rendered at 3x against 0.03 / 0.06 for the 1x page upscaled.
async function steepEdgeShare(buf) {
  const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  let edges = 0, steep = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const g = Math.max(Math.abs(data[i + 1] - data[i - 1]), Math.abs(data[i + W] - data[i - W]));
      if (g > 24) { edges++; if (g > 128) steep++; }
    }
  }
  return edges ? steep / edges : 0;
}

/** Every promise a full gallery page makes, for one rendered page. */
async function checkPage(label, p) {
  const { head, b64, buf } = partsOf(p && p.image);
  let meta = {};
  try { meta = await sharp(buf).metadata(); } catch { /* reported below */ }
  ok(`${label}: a WebP data URI (${kb(buf.length)} KB)`, head === 'data:image/webp;base64' && meta.format === 'webp', { head, format: meta.format });
  ok(`${label}: ${meta.width} px across = 794 × ${DPR} (≥ the ${PX_ACROSS_AT_2X} px of 2x zoom on a 3x phone)`, meta.width === Math.round(A4_W * DPR) && meta.width >= PX_ACROSS_AT_2X, meta.width);
  ok(`${label}: at least an A4 tall at that density (${meta.height} px)`, meta.height >= Math.round(A4_H * DPR), meta.height);
  ok(`${label}: width/height are the image's own pixels (clients lay out by their ratio)`, p.width === meta.width && p.height === meta.height, { reported: [p.width, p.height], image: [meta.width, meta.height] });
  ok(`${label}: ${kb(b64.length)} KB of base64 ≤ the ${kb(BUDGET)} KB page budget`, b64.length <= BUDGET, b64.length);
  return { buf, meta };
}

(async () => {
  console.log('── both renderers name the same render: PREVIEW_REV ──');
  ok('resumeRenderer and coverLetterRenderer export PREVIEW_REV, and it is one render', typeof RR.PREVIEW_REV === 'string' && RR.PREVIEW_REV.length > 0 && RR.PREVIEW_REV === CR.PREVIEW_REV, [RR.PREVIEW_REV, CR.PREVIEW_REV]);
  ok('…with one density, format and budget', RR.PREVIEW_DPR === CR.PREVIEW_DPR && RR.PREVIEW_FORMAT === CR.PREVIEW_FORMAT && RR.PREVIEW_BUDGET === CR.PREVIEW_BUDGET && Number.isFinite(BUDGET),
    { rr: [RR.PREVIEW_DPR, RR.PREVIEW_FORMAT, RR.PREVIEW_BUDGET], cl: [CR.PREVIEW_DPR, CR.PREVIEW_FORMAT, CR.PREVIEW_BUDGET] });
  ok(`the density covers 2x zoom on a 3x phone: 794 × ${DPR} = ${Math.round(A4_W * DPR)} ≥ ${PX_ACROSS_AT_2X}`, A4_W * DPR >= PX_ACROSS_AT_2X, DPR);
  ok('the format is WebP — the only one measured to fit the budget at that density', RR.PREVIEW_FORMAT === 'webp');
  ok('the budget is ≈450 KB of base64 per page (the gallery fetches three to a request)', BUDGET > 0 && BUDGET <= 450 * 1024, BUDGET);

  console.log('── the density is a deviceScaleFactor on the PREVIEW page — never a wider viewport, never the PDF ──');
  for (const [file, previewCall] of [
    ['server/utils/resumeRenderer.js', /warmPage = await newRoutedPage\(browser, PREVIEW_DPR\)/],
    ['server/utils/coverLetterRenderer.js', /page = await newRoutedPage\(browser, PREVIEW_DPR\)/],
  ]) {
    const src = strip(R(file));
    const name = path.basename(file, '.js');
    ok(`${name}: the one page factory takes a deviceScaleFactor, keeps the 794-px viewport and JS off`,
      /const A4_W = 794;/.test(src) && /async function newRoutedPage\(browser, dpr = 1\)/.test(src)
      && /newPage\(\{ viewport: \{ width: A4_W, height: A4_H \}, deviceScaleFactor: dpr, javaScriptEnabled: false \}\)/.test(src)
      && (src.match(/\.newPage\(/g) || []).length === 1);
    ok(`${name}: the preview page is made at PREVIEW_DPR`, previewCall.test(src));
    ok(`${name}: the PDF path keeps 1x (page.pdf is vector — measured byte-identical at 3x)`, /await newRoutedPage\(browser\)/.test(fnBody(src, 'preparePage')));
    ok(`${name}: the capture is clipped in CSS pixels (the density comes from the page, not the clip)`, /clip: \{ x: 0, y: 0, width: A4_W, height: h \}/.test(src));
    ok(`${name}: the encode runs off the page (the next design renders meanwhile)`, /if \(cap\) pending\.push\(encodePreview\(cap\.shot, A4_W, cap\.h\)/.test(src));
  }
  {
    const rr = strip(R('server/utils/resumeRenderer.js'));
    const cl = strip(R('server/utils/coverLetterRenderer.js'));
    ok('resumeRenderer keeps the ONE warm page under the lock — no browser per render',
      /withWarmLock\(async \(\) => \{\s*const page = await getWarmPage\(\)/.test(rr) && !/launchBrowser\(/.test(fnBody(rr, 'renderPreviews')));
    // Each renderer is self-contained (the house pattern: fences and loaders are mirrored, not shared), so the encoder
    // and its ladder exist twice — and must stay ONE encoder, or a letter and a résumé page would differ under one rev.
    const code = (s) => s.replace(/\s+\/\/.*$/gm, '').replace(/\s+/g, ' ').trim();
    const ladderOf = (s) => code((s.match(/const PREVIEW_LADDER = \[[\s\S]*?\];/) || [''])[0]);
    ok('…and both renderers carry the SAME encoder and the SAME ladder',
      code(fnBody(rr, 'encodePreview')).length > 200 && code(fnBody(rr, 'encodePreview')) === code(fnBody(cl, 'encodePreview'))
      && ladderOf(rr).length > 50 && ladderOf(rr) === ladderOf(cl));
  }

  console.log('── a real résumé page and a real letter page, rendered ──');
  const t0 = Date.now();
  const resumePages = await RR.renderPreviews(RESUME, { photo: null }, pick(RT.TEMPLATES, ['banner', 'azure']));
  const t1 = Date.now();
  const letterPages = await CR.renderPreviews(LETTER, { photo: null }, pick(CL.TEMPLATES, ['exec_leader', 'standard']));
  const t2 = Date.now();
  console.log(`  (rendered 2 résumé pages in ${t1 - t0} ms, 2 letter pages in ${t2 - t1} ms)`);
  ok('both résumé designs came back, in order', resumePages.map((p) => p.id).join() === 'banner,azure', resumePages.map((p) => p.id));
  ok('both letter designs came back, in order', letterPages.map((p) => p.id).join() === 'exec_leader,standard', letterPages.map((p) => p.id));
  const byId = new Map();
  for (const p of resumePages) byId.set(p.id, { ...p, ...(await checkPage(`résumé ${p.id}`, p)) });
  for (const p of letterPages) byId.set('cl:' + p.id, { ...p, ...(await checkPage(`letter ${p.id}`, p)) });

  // Real density: the sharp page against the same page served the OLD way — a 794-px JPEG q82, upscaled to 3x.
  for (const key of ['banner', 'cl:exec_leader']) {
    const pg = byId.get(key);
    if (!pg || !pg.buf.length) { ok(`${key}: rendered`, false); continue; }
    const old1x = await sharp(pg.buf).resize({ width: A4_W, kernel: 'lanczos3' }).jpeg({ quality: 82 }).toBuffer();
    const upscaled = await sharp(old1x).resize({ width: pg.meta.width, kernel: 'lanczos3' }).webp({ quality: 80 }).toBuffer();
    const [real, fake] = [await steepEdgeShare(pg.buf), await steepEdgeShare(upscaled)];
    ok(`${key}: real 3x detail — ${(real * 100).toFixed(0)}% of its edges are steep, ${(fake * 100).toFixed(0)}% on the 1x page upscaled`, real > 0.3 && real > 5 * fake, { real, fake });
  }

  console.log('── a long page stays inside the budget: quality first, density only after, never below 2x ──');
  {
    const [p] = await RR.renderPreviews(LONG_RESUME, { photo: null }, pick(RT.TEMPLATES, ['banner']));
    const { head, b64, buf } = partsOf(p && p.image);
    const meta = await sharp(buf).metadata().catch(() => ({}));
    console.log(`  (a ${meta.height && meta.width ? (meta.height / meta.width * 210 / 297).toFixed(2) : '?'}-A4 page: ${meta.width}×${meta.height}, ${kb(b64.length)} KB of base64)`);
    ok('the long page is a WebP within the budget', head === 'data:image/webp;base64' && meta.format === 'webp' && b64.length <= BUDGET, { format: meta.format, b64: b64.length });
    ok(`…and never below 2x (${meta.width} px ≥ ${A4_W * 2})`, meta.width >= A4_W * 2 && meta.width <= Math.round(A4_W * DPR), meta.width);
    ok('…its reported size is still the image\'s own', p.width === meta.width && p.height === meta.height, [p.width, p.height, meta.width, meta.height]);
  }

  // ⚠️ Review 2026-09-18: the WebP clamp resized a too-tall page to Math.round(width × 16383 / height) px ACROSS. That
  // rounds up about half the time, the height sharp derives back lands on 16384–16386, the encode threw — and the ONE
  // try/catch around the whole ladder served the raw 3x JPEG capture: 42 roles on 'banner' came back 2382×19416 at
  // ~4.7 MB (60 roles: ~6.6 MB), with no budget, and the caches kept it for every later gallery open.
  console.log('── ⚠️ a page taller than WebP can hold (16383 px a side) is still a WebP — bounded by its HEIGHT ──');
  {
    const TALL_RESUME = { ...RESUME, experience: Array.from({ length: 42 }, (_, i) => ({ ...RESUME.experience[i % 2], company: `${RESUME.experience[i % 2].company} ${i + 1}` })) };
    const [p] = await RR.renderPreviews(TALL_RESUME, { photo: null }, pick(RT.TEMPLATES, ['banner']));
    const { head, b64, buf } = partsOf(p && p.image);
    const meta = await sharp(buf).metadata().catch(() => ({}));
    const a4s = meta.height && meta.width ? meta.height / meta.width * 210 / 297 : 0;
    console.log(`  (a ${a4s.toFixed(2)}-A4 page: ${meta.width}×${meta.height}, ${kb(b64.length)} KB of base64)`);
    ok(`the page is past 5.5 A4 — ${Math.round(a4s * A4_H * DPR)} px tall at ${DPR}x, more than WebP can hold`, a4s > 5.5 && a4s * A4_H * DPR > 16383, a4s);
    ok('…and it is served as a WebP, not the raw capture', head === 'data:image/webp;base64' && meta.format === 'webp', { head, format: meta.format });
    ok(`…no side past 16383 px (${meta.width}×${meta.height})`, meta.height <= 16383 && meta.width <= Math.round(A4_W * DPR), [meta.width, meta.height]);
    ok('…its reported size is the image\'s own', p.width === meta.width && p.height === meta.height, [p.width, p.height, meta.width, meta.height]);
    ok(`…${kb(b64.length)} KB — under half the ~4.7 MB capture the old clamp served for this very page`, b64.length > 0 && b64.length <= 2 * 1024 * 1024, b64.length);
  }
  // The same bound straight through BOTH encoders, at the three heights the review measured failing — a synthetic page
  // of 3x "text lines" (the bug is geometry, not content; the encoders are one encoder, pinned above, so the letter
  // one runs the tallest case only). Each is exactly a height the width-bound resize overshot: 17796 → 2193 px across
  // → 16384 tall, 19416 → 2010 → 16384, 26697 → 1462 → 16386.
  const pageCapture = async (h, w = Math.round(A4_W * DPR)) => {
    const ink = Buffer.alloc(w, 255);
    for (let x = 180; x < w - 180; x++) if (x % 40 < 30) ink[x] = 40;
    const paper = Buffer.alloc(w, 255);
    const px = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++) (y % 60 > 3 && y % 60 < 27 ? ink : paper).copy(px, y * w);
    return sharp(px, { raw: { width: w, height: h, channels: 1 } }).jpeg({ quality: 82 }).toBuffer();   // what chromium hands encodePreview
  };
  for (const [name, R, heights] of [['résumé', RR, [17796, 19416, 26697]], ['letter', CR, [26697]]]) {
    for (const h of heights) {
      const e = await R.encodePreview(await pageCapture(h), A4_W, h / DPR);
      const { head, b64, buf } = partsOf(e && e.image);
      const meta = await sharp(buf).metadata().catch(() => ({}));
      ok(`${name} encoder, a ${h}-px capture → a WebP of ${meta.width}×${meta.height} (${kb(b64.length)} KB), no side past 16383, as reported`,
        head === 'data:image/webp;base64' && meta.format === 'webp' && meta.height <= 16383 && meta.width <= Math.round(A4_W * DPR)
        && e.width === meta.width && e.height === meta.height, { head, meta: [meta.format, meta.width, meta.height], reported: e && [e.width, e.height] });
      ok(`…the page's proportions kept (${meta.width} px across ≈ ${(Math.round(A4_W * DPR) * meta.height / h).toFixed(1)})`,
        Math.abs(meta.width - Math.round(A4_W * DPR) * meta.height / h) <= 1, [meta.width, meta.height]);
    }
  }

  console.log('── ⚠️ a rung that cannot encode falls to the NEXT rung — the raw capture is the last resort, not the first ──');
  {
    // encodePreview require()s sharp per call, so swapping the module's export injects an encode failure into it alone.
    const sharpPath = require.resolve('sharp', { paths: [path.join(ROOT, 'server', 'utils')] });
    const realSharp = require.cache[sharpPath].exports;
    const failing = async (failIf, fn) => {
      require.cache[sharpPath].exports = (...args) => {
        const s = realSharp(...args);
        const webp = s.webp.bind(s);
        s.webp = (o) => (failIf(o) ? { toBuffer: async () => { throw new Error('injected encode failure'); } } : webp(o));
        return s;
      };
      try { return await fn(); } finally { require.cache[sharpPath].exports = realSharp; }
    };
    const onePage = await pageCapture(Math.round(A4_H * DPR));
    for (const [name, R] of [['résumé', RR], ['letter', CR]]) {
      const e = await failing((o) => o.quality === 80, () => R.encodePreview(onePage, A4_W, A4_H));
      const { head, buf } = partsOf(e && e.image);
      const meta = await sharp(buf).metadata().catch(() => ({}));
      ok(`${name} encoder: the q80 rung throws → the q50 rung's WebP at full density (${meta.width} px), not the capture`,
        head === 'data:image/webp;base64' && meta.format === 'webp' && meta.width === Math.round(A4_W * DPR) && e.width === meta.width, { head, meta: [meta.format, meta.width] });
      const all = await failing(() => true, () => R.encodePreview(onePage, A4_W, A4_H));
      ok(`${name} encoder: every rung throws → the capture itself, never an exception (the documented last resort)`,
        !!all && partsOf(all.image).buf.equals(onePage) && partsOf(all.image).head === 'data:image/jpeg;base64'
        && all.width === Math.round(A4_W * DPR) && all.height === Math.round(A4_H * DPR), all && [partsOf(all.image).head, all.width, all.height]);
    }
    ok('…and the real sharp is back in place', require.cache[sharpPath].exports === realSharp);
  }

  // ── The controller, over the REAL pages above: a stubbed renderer hands them back, so no second chromium run. ──
  const dbPath = require.resolve(path.join(ROOT, 'db-config.js'));
  const world = { resumeRow: null };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
    get: async (sql) => (/FROM user_resumes/.test(String(sql)) ? world.resumeRow : null),
    query: async () => [], run: async () => ({}), withTransaction: async (fn) => fn({ get: async () => null, run: async () => ({}) }),
    isUniqueViolation: () => false, getDbType: () => 'postgres',
  } };
  const rrPath = require.resolve('../utils/resumeRenderer');
  const ctlPath = require.resolve('../controllers/resumeBuilderController');
  const renders = [];
  const realBanner = byId.get('banner');
  const fakeRenderer = (rev) => ({
    ...RR, PREVIEW_REV: rev,
    renderPreviews: async (data, opts, tpls) => {
      renders.push(tpls.map((t) => t.id));
      return tpls.map((t) => ({ id: t.id, name: t.name, accent: t.accent, ats: t.ats || null, image: realBanner.image, width: realBanner.width, height: realBanner.height }));
    },
  });
  const loadCtl = (rev) => {
    delete require.cache[ctlPath];
    require.cache[rrPath].exports = fakeRenderer(rev);
    return require('../controllers/resumeBuilderController');
  };
  const quiet = console.warn; console.warn = () => {};
  const ctl = loadCtl(RR.PREVIEW_REV);
  const ctlOther = loadCtl('zz9');                     // the same controller under another render, for the key pins
  const C = loadCtl(RR.PREVIEW_REV);                    // …and back
  console.warn = quiet;

  const thumbDir = path.join(ROOT, 'uploads', '.thumb_cache', String(USER));
  const tmpDir = path.join(ROOT, 'temp');
  const cleanUp = () => {
    try { fs.rmSync(thumbDir, { recursive: true, force: true }); } catch {}
    try { for (const n of fs.readdirSync(tmpDir)) if (n.startsWith(`resume_prev_${USER}_`) || n.startsWith(`resume_thumb_${USER}_`)) fs.unlinkSync(path.join(tmpDir, n)); } catch {}
  };
  cleanUp();
  fs.mkdirSync(thumbDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log('── ⚠️ PREVIEW_REV is IN every key that stores a page or a card ──');
  const ROW = { updated_at: new Date('2026-01-01T00:00:00Z'), resume_data: RESUME };
  const DOC = { id: 4242, updated_at: new Date('2026-02-02T00:00:00Z'), payload: RESUME };
  const ms = (d) => new Date(d).getTime();
  // The keys as they were written before PREVIEW_REV — byte for byte the old formulas.
  const oldPreviewName = `resume_prev_${USER}_${String(ms(ROW.updated_at) + ':none:banner').replace(/[^a-zA-Z0-9_]/g, '-')}.json`;
  const oldThumbName = `resume_thumb_${USER}_${String(ms(ROW.updated_at) + ':none::banner').replace(/[^a-zA-Z0-9_]/g, '-')}.jpg`;
  const oldPageName = crypto.createHash('sha256').update(['resume-doc-page:v3', USER, DOC.id, ms(DOC.updated_at), 'none', 'banner', C.brandKeyOf(null)].join('|')).digest('hex') + '.jpg';
  const newPreview = path.basename(C.previewFile(USER, ROW, 'banner', 'none'));
  const newPage = C.docPageNameOf(USER, DOC, 'none', 'banner', null);
  ok(`the gallery JSON (temp/): ${newPreview}`, newPreview !== oldPreviewName && newPreview.includes(RR.PREVIEW_REV) && newPreview.startsWith(`resume_prev_${USER}_`), { newPreview, oldPreviewName });
  ok('…and it moves with the rev (another render → another file)', path.basename(ctlOther.previewFile(USER, ROW, 'banner', 'none')) !== newPreview);
  ok('the employer-doc page (uploads/.thumb_cache): a different hash from the pre-rev page', newPage !== oldPageName && /^[0-9a-f]{64}\.jpg$/.test(newPage), { newPage, oldPageName });
  ok('…and it moves with the rev', ctlOther.docPageNameOf(USER, DOC, 'none', 'banner', null) !== newPage);
  ok('…and the card is named from the page, so it moves too', C.docCardNameOf(newPage) === newPage.replace(/\.jpg$/, '.w480.jpg') && C.docCardNameOf(newPage) !== C.docCardNameOf(oldPageName));
  const ctlSrc = strip(R('server/controllers/resumeBuilderController.js'));
  ok('the Home card (cachedThumb) keys on it too', /tplId \+ ':' \+ PREVIEW_REV;/.test(fnBody(ctlSrc, 'cachedThumb')));
  ok('the controller takes PREVIEW_REV from the renderer, never a copy of its own', /const \{[^}]*\bPREVIEW_REV\b[^}]*\} = require\('\.\.\/utils\/resumeRenderer'\)/.test(ctlSrc) && !/const PREVIEW_REV\s*=/.test(ctlSrc));

  console.log('── ⚠️ a page cached under the OLD key is never served ──');
  const oneX = await sharp(realBanner.buf).resize({ width: A4_W }).jpeg({ quality: 82 }).toBuffer();   // what the old code stored
  const oldCard = await sharp({ create: { width: 480, height: 679, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();
  fs.writeFileSync(path.join(tmpDir, oldPreviewName), JSON.stringify({ id: 'banner', name: 'Banner', image: `data:image/jpeg;base64,${oneX.toString('base64')}`, width: 794, height: 1591 }));
  ok('the gallery JSON written under the old key reads as a miss', (await C.readPreviewCache(USER, ROW, 'banner', 'none')) === null);
  fs.writeFileSync(path.join(thumbDir, oldPageName), oneX);
  fs.writeFileSync(path.join(thumbDir, C.docCardNameOf(oldPageName)), oldCard);
  let r0 = renders.length;
  const first = (await C.docPages(USER, DOC, ['banner'], 'none', null)).get('banner');
  ok('a doc page with only an OLD file on disk is rendered, not read', renders.length === r0 + 1 && first && first.cached === false, { renders: renders.length - r0, cached: first && first.cached });
  ok('…and the answer is the sharp page (WebP, 794 × 3 across), not the 1x file', first && first.image === realBanner.image && first.width === realBanner.meta.width, first && [first.width, first.height]);
  ok('…stored under the new name', fs.existsSync(path.join(thumbDir, newPage)) && fs.readFileSync(path.join(thumbDir, newPage)).equals(realBanner.buf));
  ok('the old files are left to the LRU, not mass-deleted…', fs.existsSync(path.join(thumbDir, oldPageName)) && fs.existsSync(path.join(thumbDir, C.docCardNameOf(oldPageName))));
  const LRU_NAME = /^[0-9a-f]{64}(?:\.w480)?\.jpg$/;
  ok('…which still counts them as its own, so they age out like any unused file',
    LRU_NAME.test(oldPageName) && LRU_NAME.test(C.docCardNameOf(oldPageName)) && LRU_NAME.test(newPage)
    && /const DOC_THUMB_NAME = new RegExp\(`\^\[0-9a-f\]\{64\}\(\?:\\\\\$\{DOC_CARD_SUFFIX\}\)\?\\\\\.jpg\$`\);/.test(ctlSrc));

  console.log('── a cache hit reads the sharp page back: type and size from the bytes ──');
  r0 = renders.length;
  const hit = (await C.docPages(USER, DOC, ['banner'], 'none', null)).get('banner');
  ok('the second ask is a hit — no render', renders.length === r0 && hit && hit.cached === true);
  ok('…served as image/webp although the cache names it .jpg', hit && partsOf(hit.image).head === 'data:image/webp;base64' && partsOf(hit.image).buf.equals(realBanner.buf));
  ok(`…its size read from the WebP header: ${hit && hit.width} × ${hit && hit.height}, the same as the fresh render`, hit && hit.width === first.width && hit.height === first.height, hit && [hit.width, hit.height]);

  console.log('── the Home cards are still small cards, cut from the sharp page ──');
  r0 = renders.length;
  const card = await C.docThumb(USER, DOC, 'banner', 'none', null);
  const cardParts = partsOf(card && card.image);
  const cardMeta = await sharp(cardParts.buf).metadata().catch(() => ({}));
  ok(`an employer-doc card is a ${cardMeta.width}-px JPEG of ${kb(cardParts.buf.length)} KB, cut from the stored page (no render)`,
    cardParts.head === 'data:image/jpeg;base64' && cardMeta.format === 'jpeg' && cardMeta.width === 480 && renders.length === r0, { head: cardParts.head, cardMeta: [cardMeta.format, cardMeta.width] });
  ok('…a fraction of the page it came from (never the big page where a card is enough)', cardParts.buf.length <= 120 * 1024 && cardParts.buf.length * 4 < realBanner.buf.length, [cardParts.buf.length, realBanner.buf.length]);
  ok('…and never the red card planted under the old name', !cardParts.buf.equals(oldCard) && card.name === C.docCardNameOf(newPage), card && card.name);

  fs.writeFileSync(path.join(tmpDir, oldThumbName), oldCard);
  world.resumeRow = { resume_data: RESUME, updated_at: ROW.updated_at, preferred_template: 'banner' };
  r0 = renders.length;
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await C.homeThumb({ user: { id: USER }, query: {} }, res);
  const home = partsOf(res.body && res.body.image);
  const homeMeta = await sharp(home.buf).metadata().catch(() => ({}));
  const homeFiles = fs.readdirSync(tmpDir).filter((n) => n.startsWith(`resume_thumb_${USER}_`) && n !== oldThumbName);
  ok(`the base résumé's Home card: rendered (the old-key card is not served), a ${homeMeta.width}-px JPEG of ${kb(home.buf.length)} KB`,
    res.code === 200 && renders.length === r0 + 1 && !home.buf.equals(oldCard) && homeMeta.format === 'jpeg' && homeMeta.width === 480, { code: res.code, renders: renders.length - r0, meta: [homeMeta.format, homeMeta.width] });
  ok('…stored under a key that carries the rev', homeFiles.length === 1 && homeFiles[0].includes(RR.PREVIEW_REV), homeFiles);

  console.log('── the header reader knows both formats the cache can hold ──');
  const px = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } });
  const alpha = sharp({ create: { width: 33, height: 21, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } });
  const sizes = {
    jpeg: C.imageSizeOf(await px(794, 1123).jpeg().toBuffer()),
    webpLossy: C.imageSizeOf(await px(2382, 3369).webp({ quality: 80 }).toBuffer()),
    webpLossless: C.imageSizeOf(await px(1985, 2808).webp({ lossless: true }).toBuffer()),
    webpExtended: C.imageSizeOf(await alpha.webp({ quality: 80 }).toBuffer()),
    junk: C.imageSizeOf(Buffer.from('not an image at all, not even close')),
  };
  const is = (s, w, h) => !!s && s.width === w && s.height === h;
  ok('JPEG, lossy / lossless / extended WebP read their true size; anything else is null',
    is(sizes.jpeg, 794, 1123) && is(sizes.webpLossy, 2382, 3369) && is(sizes.webpLossless, 1985, 2808) && is(sizes.webpExtended, 33, 21) && sizes.junk === null, sizes);

  cleanUp();
  console.log(`\npreview sharpness: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
