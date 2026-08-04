// Why does the shipped scan report 8 checkbox fields on a form that has 74 checkboxes?
// Runs the ENGINE'S OWN sig() over every checkbox on a real page and counts the collisions.
// READ-ONLY: nothing is clicked, typed or submitted.
'use strict';
const fs = require('fs');
const { chromium } = require('playwright');
const SRC = fs.readFileSync('/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app/MobileApp/app/(ai-hub)/job-detail.tsx', 'utf8');
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
  for (const t of ['Accept all', 'Allow all', 'Accept cookies', 'Accept']) {
    const b = page.locator(`button:has-text("${t}")`).first();
    if (await b.count().catch(() => 0)) { await b.click({ timeout: 1500 }).catch(() => {}); break; }
  }
  for (const t of ['Apply for this job', 'Apply now', 'Apply for this position', 'Apply']) {
    const b = page.locator(`a:has-text("${t}"), button:has-text("${t}")`).first();
    if (await b.count().catch(() => 0)) { await b.click({ timeout: 3000 }).catch(() => {}); break; }
  }
  await page.waitForTimeout(8000);
  const r = await page.evaluate((helpers) => {
    eval(helpers);
    const bySig = {};
    const all = Array.from(document.querySelectorAll('input[type=checkbox]'));
    all.forEach((el) => {
      if (!vis(el)) return;
      const s = sig(el);
      (bySig[s] = bySig[s] || []).push({ name: el.name || '', value: String(el.value || '').slice(0, 30), label: String(nlbl(el) || '').slice(0, 40) });
    });
    const groups = Object.entries(bySig).map(([s, m]) => ({ sig: s.slice(0, 60), members: m.length, firstLabel: m[0].label, sharedName: m[0].name, allLabels: m.map((x) => x.label).slice(0, 6) }));
    return {
      totalCheckboxes: all.length,
      visibleCheckboxes: all.filter((el) => vis(el)).length,
      distinctSigs: groups.length,
      collapsed: groups.filter((g) => g.members > 1),
      // what the scan would emit: one field per distinct sig, labelled by whichever member it met first
      groups,
    };
  }, JS_HELPERS);
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
