// What SHAPE do "date" questions take on real application forms? READ-ONLY.
'use strict';
const { chromium } = require('playwright');
(async () => {
  const url = process.argv[2];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  for (const t of ['Accept all', 'Accept cookies', 'Accept']) { const b = page.locator(`button:has-text("${t}")`).first(); if (await b.count().catch(() => 0)) { await b.click({ timeout: 1500 }).catch(() => {}); break; } }
  for (const t of ['Apply for this job', 'Apply now', 'Apply']) { const b = page.locator(`a:has-text("${t}"), button:has-text("${t}")`).first(); if (await b.count().catch(() => 0)) { await b.click({ timeout: 3000 }).catch(() => {}); break; } }
  await page.waitForTimeout(8000);

  // Neutralise every submit path BEFORE clicking anything, and mark submit-shaped controls first.
  await page.evaluate(() => {
    window.__cvfSubmits = 0;
    const bump = (e) => { e.preventDefault(); e.stopPropagation(); window.__cvfSubmits++; };
    document.querySelectorAll('button[type=submit],input[type=submit],form button:not([type])').forEach((b) => b.setAttribute('data-cvf-submitish','1'));
    document.querySelectorAll('form').forEach((f) => { f.addEventListener('submit', bump, true); f.onsubmit = (e) => { e.preventDefault(); return false; }; });
    document.querySelectorAll('button[type=submit],input[type=submit]').forEach((b) => { b.setAttribute('type','button'); b.addEventListener('click', bump, true); });
    document.addEventListener('submit', bump, true);
  });
  // Open one repeater row so the fields it creates can be inspected. Never a submit-shaped control.
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button,[role=button]'));
    for (const b of btns) {
      if (b.getAttribute('data-cvf-submitish')) continue;
      const t = ((b.innerText||'') + ' ' + (b.getAttribute('aria-label')||'')).trim();
      if (/\b(submit|apply|send|continue|next)\b/i.test(t)) continue;
      if (/add/i.test(t)) { b.click(); break; }
    }
  });
  await page.waitForTimeout(2500);
  console.log('submits after repeater click:', await page.evaluate(() => window.__cvfSubmits));
  console.log(JSON.stringify(await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('input,select').forEach((el) => {
      const lab = (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.placeholder || el.name || '').replace(/\s+/g, ' ').trim();
      if (!/date|year|month|day|from|until|start|end|birth/i.test(lab)) return;
      out.push({ label: lab.slice(0, 50), tag: el.tagName.toLowerCase(), type: (el.type || ''), placeholder: el.placeholder || '', pattern: el.getAttribute('pattern') || '', inputmode: el.getAttribute('inputmode') || '', maxlength: el.getAttribute('maxlength') || '', role: el.getAttribute('role') || '', readOnly: !!el.readOnly, options: el.tagName === 'SELECT' ? el.options.length : undefined });
    });
    return out;
  }), null, 1));
  await browser.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
