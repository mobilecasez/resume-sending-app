// Across a corpus: how many real radios/checkboxes does the SHIPPED vis() reject, and why?
// A native control styled by CSS is routinely opacity:0 with a visible <label> proxy — operable by
// the applicant, invisible to us. READ-ONLY: nothing is clicked, typed or submitted.
'use strict';
const fs = require('fs');
const { chromium } = require('playwright');
const SRC = fs.readFileSync('/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app/MobileApp/app/(ai-hub)/job-detail.tsx', 'utf8');
const raw = (n) => SRC.match(new RegExp('(?:export )?const ' + n + ' = `([\\s\\S]*?)`;\\n'))[1];
const JS_HELPERS = new Function('JS_HELPERS', 'return `' + raw('JS_HELPERS') + '`;')('');

async function one(browser, job) {
  const out = { platform: job.platform, url: job.url };
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    for (const t of ['Accept all', 'Accept cookies', 'Godkänn', 'Accept']) { const b = page.locator(`button:has-text("${t}")`).first(); if (await b.count().catch(() => 0)) { await b.click({ timeout: 1500 }).catch(() => {}); break; } }
    for (const t of ['Apply for this job', 'Apply now', 'Ansök', 'Apply']) { const b = page.locator(`a:has-text("${t}"), button:has-text("${t}")`).first(); if (await b.count().catch(() => 0)) { await b.click({ timeout: 3000 }).catch(() => {}); break; } }
    await page.waitForTimeout(7000);
    Object.assign(out, await page.evaluate((helpers) => {
      eval(helpers);
      const r = { radios: 0, radiosHidden: 0, checkboxes: 0, checkboxesHidden: 0, reasons: {}, hiddenLabels: [], nonInputWidgets: 0 };
      document.querySelectorAll('input[type=radio],input[type=checkbox]').forEach((el) => {
        const isR = (el.type || '').toLowerCase() === 'radio';
        if (isR) r.radios++; else r.checkboxes++;
        if (vis(el)) return;
        if (isR) r.radiosHidden++; else r.checkboxesHidden++;
        const s = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        let why = 'other';
        if (s.display === 'none') why = 'display:none';
        else if (s.visibility === 'hidden') why = 'visibility:hidden';
        else if (parseFloat(s.opacity || '1') === 0) why = 'opacity:0';
        else if (el.offsetParent === null) why = 'offsetParent null';
        else if (!rect.width && !rect.height) why = 'zero size';
        r.reasons[why] = (r.reasons[why] || 0) + 1;
        // does the applicant still SEE this question? (a label with real text = yes)
        let lab = '';
        try { lab = String(nlbl(el) || '').replace(/\s+/g, ' ').slice(0, 40); } catch (e) {}
        if (r.hiddenLabels.length < 6) r.hiddenLabels.push(why + ' :: ' + lab);
      });
      document.querySelectorAll('[role=combobox],[role=listbox],[role=radiogroup],[role=switch],[role=checkbox],[role=radio],[role=slider]').forEach((el) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].indexOf(el.tagName) >= 0) return;
        if (el.querySelector('input,select,textarea')) return;   // a wrapper around a native control
        const rect = el.getBoundingClientRect();
        if (rect.width && rect.height) r.nonInputWidgets++;
      });
      return r;
    }, JS_HELPERS));
  } catch (e) { out.error = String(e && e.message).slice(0, 90); }
  await ctx.close().catch(() => {});
  return out;
}

(async () => {
  const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const browser = await chromium.launch();
  const res = [];
  for (let i = 0; i < jobs.length; i += 4) {
    const got = await Promise.all(jobs.slice(i, i + 4).map((j) => one(browser, j).catch((e) => ({ url: j.url, error: String(e && e.message).slice(0, 60) }))));
    got.forEach((g) => { res.push(g); console.error(`[${res.length}/${jobs.length}] ${g.platform} r=${g.radios}/${g.radiosHidden}hidden cb=${g.checkboxes}/${g.checkboxesHidden}hidden nonInput=${g.nonInputWidgets} ${g.error || ''}`); });
  }
  await browser.close();
  console.log(JSON.stringify(res, null, 1));
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
