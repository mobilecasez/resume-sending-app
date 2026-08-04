// Targeted verification, not inference: WHY does the shipped scan report zero radio groups on a
// form that visibly has three YES/NO questions? Measures the real elements' computed style and runs
// the engine's OWN vis() against them. READ-ONLY: nothing is clicked, typed or submitted.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const REPO = path.join(__dirname, '..', 'Users', 'rishisamadhiya', 'Desktop', 'Files', 'Personal', 'Shopify Apps', 'resume-sending-app');
const SRCPATH = process.env.SRC || '/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app/MobileApp/app/(ai-hub)/job-detail.tsx';
const SRC = fs.readFileSync(SRCPATH, 'utf8');
const raw = (n) => SRC.match(new RegExp('(?:export )?const ' + n + ' = `([\\s\\S]*?)`;\\n'))[1];
const JS_HELPERS = new Function('JS_HELPERS', 'return `' + raw('JS_HELPERS') + '`;')('');

(async () => {
  const url = process.argv[2];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  for (const t of ['Accept all', 'Allow all', 'Accept cookies', 'Godkänn', 'Alle akzeptieren', 'Accept']) {
    const b = page.locator(`button:has-text("${t}")`).first();
    if (await b.count().catch(() => 0)) { await b.click({ timeout: 1500 }).catch(() => {}); break; }
  }
  for (const t of ['Apply for this job', 'Apply now', 'Apply for this position', 'Ansök', 'Apply']) {
    const b = page.locator(`a:has-text("${t}"), button:has-text("${t}")`).first();
    if (await b.count().catch(() => 0)) { await b.click({ timeout: 3000 }).catch(() => {}); break; }
  }
  await page.waitForTimeout(8000);
  const r = await page.evaluate((helpers) => {
    eval(helpers);   // brings the SHIPPED vis(), lbl(), radioQuestion(), isCombo() into scope
    const out = { radios: [], checkboxes: [], comboDivs: [], engineVisRadios: 0, engineVisCheckboxes: 0 };
    document.querySelectorAll('input[type=radio]').forEach((el, i) => {
      const s = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const v = vis(el);
      if (v) out.engineVisRadios++;
      if (out.radios.length < 8) out.radios.push({
        name: el.name, value: el.value,
        opacity: s.opacity, display: s.display, visibility: s.visibility,
        w: Math.round(rect.width), h: Math.round(rect.height),
        offsetParentNull: el.offsetParent === null,
        appearance: s.appearance || s.webkitAppearance,
        position: s.position, clip: s.clip, clipPath: s.clipPath,
        engineVis: v,
        engineLabel: String(lbl(el) || '').replace(/\s+/g, ' ').slice(0, 60),
      });
    });
    document.querySelectorAll('input[type=checkbox]').forEach((el) => { if (vis(el)) out.engineVisCheckboxes++; });
    document.querySelectorAll('input[type=checkbox]').forEach((el, i) => {
      if (out.checkboxes.length >= 5) return;
      const s = getComputedStyle(el);
      out.checkboxes.push({ opacity: s.opacity, w: Math.round(el.getBoundingClientRect().width), engineVis: vis(el), label: String(lbl(el) || '').replace(/\s+/g, ' ').slice(0, 50) });
    });
    // widgets our ctrls() can never reach because they are not input/textarea/select
    document.querySelectorAll('[role=combobox],[role=listbox],[role=radiogroup],[role=switch],[role=checkbox],[role=radio]').forEach((el) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].indexOf(el.tagName) >= 0) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const hasNativeInside = !!el.querySelector('input,select,textarea');
      out.comboDivs.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), hasNativeInside, text: String(el.innerText || '').replace(/\s+/g, ' ').slice(0, 50), label: (el.getAttribute('aria-label') || '').slice(0, 40) });
    });
    out.totalRadios = document.querySelectorAll('input[type=radio]').length;
    out.totalCheckboxes = document.querySelectorAll('input[type=checkbox]').length;
    return out;
  }, JS_HELPERS);
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
