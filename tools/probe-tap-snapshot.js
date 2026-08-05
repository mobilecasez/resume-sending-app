// WHAT A REAL TAP ON THE DIAL PICKER ACTUALLY RECORDS.
//
//   node tools/probe-tap-snapshot.js
//
// Build 147 stopped OPENING the country-code picker at all. The only thing that can do that is
// cbUserAnswered() returning true — cbAnswered() then reports the field as already answered and
// both dialFirst and fillVisible skip it without a click.
//
// cbUserAnswered says "a tap, FOLLOWED BY the shown value changing". So this measures, on the live
// form, with a REAL trusted mouse click:
//   • does the click reach the input at all (is __cvfTapped set)?
//   • what did cbShown() return AT TAP TIME — the snapshot the rule compares against?
//   • what does it return afterwards?
//   • and therefore: does cbUserAnswered wrongly claim the applicant answered it?
//
// ⚠️ NEVER SUBMIT.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'MobileApp', 'app', '(ai-hub)', 'job-detail.tsx'), 'utf8');
const rawTpl = (n) => { const m = SRC.match(new RegExp('(?:export )?const ' + n + ' = `([\\s\\S]*?)`;\\n')); if (!m) throw new Error('no ' + n); return m[1]; };
const evalTpl = (b, h) => new Function('JS_HELPERS', 'return `' + b + '`;')(h);
const JS_HELPERS = evalTpl(rawTpl('JS_HELPERS'), '');
const FOCUS_DETECT_JS = evalTpl(rawTpl('FOCUS_DETECT_JS'), JS_HELPERS);

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const URL = arg('url', 'https://www.revolut.com/careers/apply/4ee78ed3-1222-4265-aca8-d6f147f7d15a/');
const head = (s) => console.log('\n' + '='.repeat(92) + '\n' + s + '\n' + '='.repeat(92));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHIELD = `
  window.__submits = [];
  document.addEventListener('submit', function(e){ e.preventDefault(); e.stopImmediatePropagation(); window.__submits.push('event'); }, true);
  HTMLFormElement.prototype.submit = function(){ window.__submits.push('proto'); };
  HTMLFormElement.prototype.requestSubmit = function(){ window.__submits.push('requestSubmit'); };
`;
const EXPOSE = `(function(){
  ${JS_HELPERS}
  window.__e = { ctrls:ctrls, nlbl:nlbl, cbShown:cbShown, vis:vis, visCtl:visCtl, isDialCtrl:isDialCtrl,
                 isCountryLabel:isCountryLabel, cbAnswered:cbAnswered, cbUserAnswered:cbUserAnswered,
                 keepUser:keepUser, sig:sig };
  window.__dial = function(){
    var els=window.__e.ctrls();
    for(var i=0;i<els.length;i++){ if(window.__e.isDialCtrl(els[i]) && window.__e.visCtl(els[i])) return els[i]; }
    return null;
  };
  window.__state = function(){
    var d=window.__dial(); if(!d) return { found:false };
    return {
      found:true,
      label: window.__e.nlbl(d).slice(0,40),
      shown: window.__e.cbShown(d),
      rawValue: String(d.value||''),
      tapped: !!d.__cvfTapped,
      tapShown: d.__cvfTapShown === undefined ? '(never set)' : JSON.stringify(d.__cvfTapShown),
      touched: !!d.__cvfTouched,
      userAnswered: window.__e.cbUserAnswered(d),
      answered: window.__e.cbAnswered(d),
      keepUser: window.__e.keepUser(d, 'button', '+91')
    };
  };
  return true;
})();`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.addInitScript(SHIELD);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(4500);
  await page.evaluate(EXPOSE);
  await page.evaluate(FOCUS_DETECT_JS);

  head('BEFORE THE PERSON TOUCHES ANYTHING');
  console.log(JSON.stringify(await page.evaluate(() => window.__state()), null, 1));

  head('AFTER ONE REAL TRUSTED TAP ON THE PICKER (opened, then dismissed by hand)');
  const box = await page.evaluate(() => {
    const d = window.__dial(); if (!d) return null;
    d.scrollIntoView({ block: 'center' });
    const r = d.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) { console.log('  no dial control found'); await browser.close(); return; }
  await page.mouse.click(box.x, box.y);          // isTrusted:true — the only thing FOCUS_DETECT marks on
  await sleep(1600);
  console.log('  WHILE THE SHEET IS OPEN: ' + JSON.stringify(await page.evaluate(() => window.__state())));
  // dismiss it the way a person would, without choosing anything
  await page.keyboard.press('Escape').catch(() => {});
  const closeBtn = await page.$('button[aria-label*="lose" i], [role=button][aria-label*="lose" i]');
  if (closeBtn) await closeBtn.click().catch(() => {});
  await sleep(1500);
  const after = await page.evaluate(() => window.__state());
  console.log('\n  AFTER DISMISSING WITHOUT CHOOSING:');
  console.log(JSON.stringify(after, null, 1));

  head('VERDICT');
  if (after.userAnswered) {
    console.log('  ❌ cbUserAnswered() === true after a tap that chose NOTHING.');
    console.log('     cbAnswered=' + after.answered + '  -> the engine will skip this field and never open it.');
    console.log('     snapshot at tap: ' + after.tapShown + '   shown now: ' + JSON.stringify(after.shown));
  } else {
    console.log('  ✓ a tap that chose nothing leaves the field fillable (userAnswered=false, answered=' + after.answered + ')');
  }
  console.log('\n  SUBMITS: ' + JSON.stringify(await page.evaluate(() => window.__submits)));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
