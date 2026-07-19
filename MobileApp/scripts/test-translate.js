// Runs the REAL translate scripts from utils/webviewTranslate.ts against a LIVE page and asserts the
// full toggle cycle — including translating a SECOND time after turning it off, which is the bug the
// old implementation had (its collector returned an empty list and the app silently did nothing).
//   node MobileApp/scripts/test-translate.js [url]
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const URL_UNDER_TEST = process.argv[2]
  || 'https://www.arbeitsagentur.de/jobsuche/jobdetail/17311-44302666-79-S';

const TS = fs.readFileSync(path.join(__dirname, '..', 'utils', 'webviewTranslate.ts'), 'utf8');
function body(name) {
  const i = TS.indexOf('export const ' + name);
  if (i < 0) throw new Error('missing ' + name);
  const s = TS.indexOf('`', i);
  let j = s + 1;
  while (j < TS.length) { if (TS[j] === '\\') { j += 2; continue; } if (TS[j] === '`') break; j++; }
  return TS.slice(s + 1, j);
}
const MARK = '__cvfX';
const fill = (b, gen, map) => b
  .split('${XLATE_MARK}').join(MARK)
  .split('${gen}').join(String(gen))
  .split('${JSON.stringify(map)}').join(JSON.stringify(map || {}));

const SCAN = (gen) => fill(body('xlateScanJS'), gen);
const APPLY = (gen, map) => fill(body('xlateApplyJS'), gen, map);
const RESTORE = fill(body('XLATE_RESTORE_JS'), 0);
const WATCH = fill(body('XLATE_WATCH_JS'), 0);

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' });
  console.log('page: ' + URL_UNDER_TEST);
  await page.goto(URL_UNDER_TEST, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);

  const bridge = () => page.evaluate(() => { window.__msgs = []; window.ReactNativeWebView = { postMessage: (s) => window.__msgs.push(JSON.parse(s)) }; });
  const msgs = () => page.evaluate(() => window.__msgs);
  const run = (js) => page.evaluate((code) => { eval(code); }, js);

  // ── pass 1: scan ──────────────────────────────────────────────────────────
  console.log('\nfirst translate');
  await bridge();
  await run(SCAN(1));
  const m1 = (await msgs()).find((m) => m.type === 'XLATE_ITEMS');
  ok('scan returns items', !!m1 && m1.n > 50, m1 && m1.n);
  const textCount = m1 ? m1.items.length : 0;
  console.log('    captured ' + textCount + ' strings');

  // fake the backend translation so the test needs no AI + no credits
  const map1 = {}; (m1 ? m1.items : []).forEach((it) => { map1[it.i] = 'EN[' + it.t.slice(0, 20) + ']'; });
  await run(APPLY(1, map1));
  const applied = (await msgs()).find((m) => m.type === 'XLATE_APPLIED');
  ok('apply reports a count', !!applied && applied.count > 50, applied && applied.count);

  const st1 = await page.evaluate(() => ({
    bodyHasEN: (document.body.innerText || '').indexOf('EN[') >= 0,
    attrDone: !!document.querySelector('[aria-label^="EN["]'),
    marked: document.documentElement.getAttribute('data-cvf-xlated') === '1',
  }));
  ok('visible text is translated', st1.bodyHasEN, st1);
  ok('ATTRIBUTES translated too (aria-label/title/alt)', st1.attrDone, st1);
  ok('page marked as translated', st1.marked, st1);

  // ── toggle OFF: restore in place, no reload ───────────────────────────────
  console.log('\nturn translate off');
  const beforeUrl = page.url();
  await run(RESTORE);
  const st2 = await page.evaluate(() => ({
    bodyHasEN: (document.body.innerText || '').indexOf('EN[') >= 0,
    attrStill: !!document.querySelector('[aria-label^="EN["]'),
    marked: document.documentElement.hasAttribute('data-cvf-xlated'),
  }));
  ok('original text restored', !st2.bodyHasEN, st2);
  ok('original attributes restored', !st2.attrStill, st2);
  ok('translated flag cleared', !st2.marked, st2);
  ok('restored WITHOUT reloading the page', page.url() === beforeUrl);

  // ── toggle ON again — the reported bug ────────────────────────────────────
  console.log('\ntranslate AGAIN (the reported bug)');
  await bridge();
  await run(SCAN(2));
  const m2 = (await msgs()).find((m) => m.type === 'XLATE_ITEMS');
  ok('second scan returns items (was 0 before)', !!m2 && m2.n > 50, m2 && m2.n);
  // A LIVE page keeps rendering between passes, so exact equality is not a meaningful assertion —
  // what matters is that the second pass captures a comparable amount rather than collapsing to ~0
  // (the old collector returned exactly 0 here, which is the bug).
  ok('second scan captures a comparable amount (not ~0)',
     !!m2 && m2.n >= Math.floor(textCount * 0.8), { first: textCount, second: m2 && m2.n });
  const map2 = {}; (m2 ? m2.items : []).forEach((it) => { map2[it.i] = 'RE[' + it.t.slice(0, 18) + ']'; });
  await run(APPLY(2, map2));
  const st3 = await page.evaluate(() => ({ hasRE: (document.body.innerText || '').indexOf('RE[') >= 0 }));
  ok('page is translated a second time', st3.hasRE, st3);

  // ── live content watcher ──────────────────────────────────────────────────
  console.log('\nlive (SPA) content');
  await bridge();
  await run(WATCH);
  await page.evaluate(() => { const d = document.createElement('div'); d.textContent = 'Neue Stellenangebote wurden geladen'; document.body.appendChild(d); });
  await page.waitForTimeout(1400);
  const dirty = (await msgs()).some((m) => m.type === 'XLATE_DIRTY');
  ok('new content triggers a re-translate signal', dirty, await msgs());

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
