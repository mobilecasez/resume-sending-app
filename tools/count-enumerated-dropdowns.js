// SCAN ONLY — measured 2026-08-05 over the 17 forms in the fresh sample that have custom
// dropdowns: 131 dropdowns, 52 (40%) arrive with an option list. enumCombos() in job-detail.tsx
// stops after 6 per form, so a 21-dropdown Greenhouse page hands the server 15 questions with no
// options at all — including every yes/no eligibility question. Ashby enumerates none.
// SCAN ONLY (nothing is typed, nothing is submitted): how many custom dropdowns per real form get
// their option list enumerated, and how many arrive at the server as optionsUnknown?
const fs = require('fs'); const path = require('path');
const REPO = '/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app';
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright'));
const SRC = fs.readFileSync(path.join(REPO, 'MobileApp', 'app', '(ai-hub)', 'job-detail.tsx'), 'utf8');
const raw = (n) => SRC.match(new RegExp('(?:export )?const ' + n + ' = `([\\s\\S]*?)`;\\n'))[1];
const JS_HELPERS = new Function('JS_HELPERS', 'return `' + raw('JS_HELPERS') + '`;')('');
const READ = new Function('JS_HELPERS', 'return `' + raw('READ_FIELDS_JS') + '`;')(JS_HELPERS);

(async () => {
  const urls = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const browser = await chromium.launch();
  let tot = 0, known = 0;
  const rows = [];
  const one = async (u) => {
    const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    try {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(6000);
      for (const t of ['Apply for this job', 'Apply now', 'Ansök', 'Apply']) {
        const b = page.locator(`a:has-text("${t}"), button:has-text("${t}")`).first();
        if (await b.count().catch(() => 0)) { await b.click({ timeout: 3000 }).catch(() => {}); break; }
      }
      await page.waitForTimeout(5000);
      await page.evaluate(`window.__m=[];window.ReactNativeWebView={postMessage:function(s){try{window.__m.push(JSON.parse(s))}catch(e){}}};`);
      await page.evaluate(READ);
      await page.waitForFunction(() => window.__m.some((m) => m.type === 'FIELDS'), null, { timeout: 60000 }).catch(() => {});
      const f = await page.evaluate(() => (window.__m.find((m) => m.type === 'FIELDS') || {}).fields || []);
      const c = f.filter((x) => x.widget === 'combobox');
      const k = c.filter((x) => (x.options || []).length > 0).length;
      tot += c.length; known += k;
      rows.push({ host: new URL(u).host, combos: c.length, enumerated: k });
      console.log(new URL(u).host, 'combos', c.length, 'enumerated', k);
    } catch (e) { console.log('ERR', String(e.message).slice(0, 60)); }
    await ctx.close().catch(() => {});
  };
  for (let i = 0; i < urls.length; i += 4) await Promise.all(urls.slice(i, i + 4).map(one));
  console.log('TOTAL custom dropdowns', tot, 'with an option list', known, '=', (known / (tot || 1) * 100).toFixed(0) + '%');
  await browser.close();
})();
