// The engine's vis() rejects a native control that is opacity:0 / offscreen. Some of those the
// applicant CAN see and click (a styled radio whose <label> is the visible pill); some they cannot
// (a conditional question not yet revealed, a cookie banner's toggles). Telling them apart is the
// difference between fixing three required YES/NO questions and ticking a stranger's cookie
// preferences. This measures, per hidden control, whether a VISIBLE proxy exists.
// READ-ONLY: nothing is clicked, typed or submitted.
'use strict';
const fs = require('fs');
const { chromium } = require('playwright');
const SRC = fs.readFileSync('/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app/MobileApp/app/(ai-hub)/job-detail.tsx', 'utf8');
const raw = (n) => SRC.match(new RegExp('(?:export )?const ' + n + ' = `([\\s\\S]*?)`;\\n'))[1];
const JS_HELPERS = new Function('JS_HELPERS', 'return `' + raw('JS_HELPERS') + '`;')('');

(async () => {
  const browser = await chromium.launch();
  const res = [];
  for (const url of process.argv.slice(2)) {
    const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);
      for (const t of ['Apply for this job', 'Apply now', 'Ansök', 'Apply']) { const b = page.locator(`a:has-text("${t}"), button:has-text("${t}")`).first(); if (await b.count().catch(() => 0)) { await b.click({ timeout: 3000 }).catch(() => {}); break; } }
      await page.waitForTimeout(7000);
      const r = await page.evaluate((helpers) => {
        eval(helpers);
        const boxOf = (n) => { try { const b = n.getBoundingClientRect(); const s = getComputedStyle(n); return (b.width > 1 && b.height > 1 && s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0.05); } catch (e) { return false; } };
        const out = [];
        document.querySelectorAll('input[type=radio],input[type=checkbox]').forEach((el) => {
          if (vis(el)) return;                       // the engine already sees it
          // PROXY: the control's own <label>, or the nearest ancestor that is visible and small
          // enough to be this one control's clickable skin.
          let proxy = null, why = '';
          try { if (el.labels && el.labels[0] && boxOf(el.labels[0])) { proxy = el.labels[0]; why = 'label'; } } catch (e) {}
          if (!proxy) {
            let p = el.parentElement, h = 0;
            while (p && h < 3) { if (boxOf(p) && p.getBoundingClientRect().height < 200) { proxy = p; why = 'ancestor'; break; } p = p.parentElement; h++; }
          }
          out.push({
            type: el.type, name: (el.name || '').slice(0, 30),
            label: String(nlbl(el) || '').replace(/\s+/g, ' ').slice(0, 45),
            visibleProxy: !!proxy, proxyKind: why,
            inCookieBanner: !!el.closest('[class*=cookie],[id*=cookie],[class*=consent-banner],[aria-label*=cookie i]'),
            inForm: !!el.closest('form'),
          });
        });
        return out;
      }, JS_HELPERS);
      res.push({ url, hidden: r.length, withVisibleProxy: r.filter((x) => x.visibleProxy).length, rows: r.slice(0, 10) });
      console.error(url.slice(8, 45), 'hidden=' + r.length, 'withVisibleProxy=' + r.filter((x) => x.visibleProxy).length);
    } catch (e) { res.push({ url, error: String(e && e.message).slice(0, 80) }); }
    await ctx.close().catch(() => {});
  }
  await browser.close();
  console.log(JSON.stringify(res, null, 1));
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
