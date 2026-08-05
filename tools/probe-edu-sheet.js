// WHY THE ENGINE SEES ZERO OPTIONS IN A SHEET THAT PLAINLY HAS THEM.
//
//   node tools/probe-edu-sheet.js [--col University] [--q "Cambridge"]
//
// Raw DOM says the University column opens a bottom-sheet listbox holding a world university
// index and a type=search box. Our own cbPopup/cbOptions report "popup: yes, options: 0". One of
// those two is wrong about the same DOM, so this prints BOTH views side by side:
//
//   • which node cbPopup actually chose, and what cbOptions made of it
//   • the overlay the page really built, and how its rows are constructed
//   • what a series of search terms returns, so the matching strategy is chosen from evidence
//
// ⚠️ NEVER SUBMIT.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'MobileApp', 'app', '(ai-hub)', 'job-detail.tsx'), 'utf8');
const rawTpl = (n) => { const m = SRC.match(new RegExp('(?:export )?const ' + n + ' = `([\\s\\S]*?)`;\\n')); if (!m) throw new Error('no ' + n); return m[1]; };
const JS_HELPERS = new Function('JS_HELPERS', 'return `' + rawTpl('JS_HELPERS') + '`;')('');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const URL = arg('url', 'https://www.revolut.com/careers/apply/4ee78ed3-1222-4265-aca8-d6f147f7d15a/');
const COL = arg('col', 'University');
const QS = (arg('q', '') || '').split('|').filter(Boolean);
const head = (s) => console.log('\n' + '='.repeat(96) + '\n' + s + '\n' + '='.repeat(96));

const SHIELD = `
  window.__submits = [];
  document.addEventListener('submit', function(e){ e.preventDefault(); e.stopImmediatePropagation(); window.__submits.push('event'); }, true);
  HTMLFormElement.prototype.submit = function(){ window.__submits.push('proto'); };
  HTMLFormElement.prototype.requestSubmit = function(){ window.__submits.push('requestSubmit'); };
`;

const HELPERS = `(function(){
  ${JS_HELPERS}
  window.__e = { ctrls:ctrls, nlbl:nlbl, cbShown:cbShown, cbText:cbText, setNative:setNative, vis:vis,
                 deepQuery:deepQuery, cbPopup:cbPopup, cbPreOpen:cbPreOpen, cbOptions:cbOptions,
                 cbSearchBox:cbSearchBox, cbLooksLikeList:cbLooksLikeList, isCombo:isCombo,
                 isComboTrigger:isComboTrigger, cbSafeClick:cbSafeClick, pickOpt:(typeof pickOpt==='function'?pickOpt:null) };
  window.__desc = function(n){
    if(!n) return null;
    var o={ tag:n.tagName ? n.tagName.toLowerCase() : String(n) };
    try{ if(n.getAttribute && n.getAttribute('role')) o.role=n.getAttribute('role'); }catch(e){}
    try{ if(n.className && typeof n.className==='string') o.cls=n.className.slice(0,45); }catch(e){}
    try{ o.text=(n.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60); }catch(e){}
    try{ o.kids=n.children ? n.children.length : 0; }catch(e){}
    return o;
  };
  return true;
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await page.evaluate(HELPERS);

  await page.evaluate(() => {
    const btns = window.__e.deepQuery('button,[role=button]').filter((b) => window.__e.vis(b));
    const region = (b) => { let n = b.parentElement; for (let h = 0; n && h < 6; h++) { const t = (n.textContent || '').replace(/\s+/g, ' ').trim(); if (t.length > 20) return t; n = n.parentElement; } return ''; };
    for (const b of btns) { if (/add/i.test(b.textContent || '') && /educat|universit|school/i.test(region(b))) { b.scrollIntoView({ block: 'center' }); b.click(); return true; } }
    return false;
  });
  await sleep(2500);

  head('OPEN THE ' + COL + ' PICKER — TWO VIEWS OF THE SAME DOM');
  const view = await page.evaluate((col) => {
    const re = new RegExp(col, 'i');
    const all = window.__e.ctrls().filter((e) => (e.type || '').toLowerCase() !== 'search');
    let el = null; for (const n of all) if (re.test(window.__e.nlbl(n))) { el = n; break; }
    if (!el) return { found: false };
    window.__t = el;
    window.__pre = window.__e.cbPreOpen();
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { found: true, label: window.__e.nlbl(el).slice(0, 30), preCount: (window.__pre && window.__pre.length) || 0 };
  }, COL);
  console.log('  trigger: ' + JSON.stringify(view));
  await sleep(1800);

  const both = await page.evaluate(() => {
    // ⚠️ SIGNATURES: cbOptions(el, popObj) and cbSearchBox(el, popObj) — element FIRST. Calling
    // them the other way round returns [] and null on a perfectly good sheet, which is exactly the
    // false "the engine sees zero options" this probe existed to check.
    const pop = window.__e.cbPopup(window.__t, window.__pre);
    const opts = window.__e.cbOptions(window.__t, pop);
    const sb = window.__e.cbSearchBox(window.__t, pop);
    // The overlay the PAGE built: the dialog that is aria-modal and holds a search box.
    const dialogs = window.__e.deepQuery('[role=dialog],[aria-modal="true"]').filter((d) => window.__e.vis(d));
    const real = dialogs.find((d) => d.querySelector('input[type=search]')) || dialogs[dialogs.length - 1] || null;
    const rows = [];
    if (real) {
      // whatever the page uses for a row: leaf-ish nodes with short text inside the scroll area
      for (const n of real.querySelectorAll('*')) {
        if (!window.__e.vis(n)) continue;
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 70) continue;
        if (n.querySelector('input,button')) continue;
        rows.push({ tag: n.tagName.toLowerCase(), role: n.getAttribute('role') || '', cls: String(n.className || '').slice(0, 34), kids: n.children.length, text: t.slice(0, 46) });
      }
    }
    return {
      cbPopupChose: window.__desc(pop && pop.el),
      cbPopupTrusted: pop ? !!pop.trusted : null,
      optSample: opts.slice(0, 8).map((o) => window.__e.cbText(o).slice(0, 40)),
      cbOptionsCount: opts.length,
      cbSearchBox: window.__desc(sb),
      cbLooksLikeList_onPop: pop ? !!window.__e.cbLooksLikeList(pop.el) : null,
      realOverlay: window.__desc(real),
      realHasSearch: real ? !!real.querySelector('input[type=search]') : false,
      cbLooksLikeList_onReal: real ? !!window.__e.cbLooksLikeList(real) : null,
      cbOptions_onReal: real ? window.__e.cbOptions(window.__t, { el: real, trusted: false }).length : null,
      rowSample: rows.slice(0, 14),
      rowTotal: rows.length,
    };
  });
  console.log('  cbPopup chose        : ' + JSON.stringify(both.cbPopupChose));
  console.log('    cbOptions on it    : ' + both.cbOptionsCount + '   cbLooksLikeList: ' + both.cbLooksLikeList_onPop);
  console.log('    cbSearchBox        : ' + JSON.stringify(both.cbSearchBox));
  console.log('    option sample      : ' + JSON.stringify(both.optSample));
  console.log('  the PAGE\'S overlay   : ' + JSON.stringify(both.realOverlay));
  console.log('    has type=search    : ' + both.realHasSearch + '   cbLooksLikeList: ' + both.cbLooksLikeList_onReal + '   cbOptions: ' + both.cbOptions_onReal);
  console.log('  row-ish nodes: ' + both.rowTotal);
  for (const r of both.rowSample) console.log('      ' + (r.tag + (r.role ? '[' + r.role + ']' : '')).padEnd(14) + 'kids=' + String(r.kids).padEnd(3) + r.cls.padEnd(36) + JSON.stringify(r.text));

  for (const q of QS) {
    head('SEARCH: "' + q + '"');
    await page.evaluate((query) => {
      const dialogs = window.__e.deepQuery('[role=dialog],[aria-modal="true"]').filter((d) => window.__e.vis(d));
      const real = dialogs.find((d) => d.querySelector('input[type=search]'));
      const box = real && real.querySelector('input[type=search]');
      if (!box) return false;
      box.focus();
      window.__e.setNative(box, '');
      window.__e.setNative(box, query);
      return true;
    }, q);
    await sleep(1700);
    const res = await page.evaluate(() => {
      const pop = window.__e.cbPopup(window.__t, window.__pre);
      window.__opts = window.__e.cbOptions(window.__t, pop);
      const dialogs = window.__e.deepQuery('[role=dialog],[aria-modal="true"]').filter((d) => window.__e.vis(d));
      const real = dialogs.find((d) => d.querySelector('input[type=search]'));
      const rows = [];
      if (real) for (const n of real.querySelectorAll('*')) {
        if (!window.__e.vis(n)) continue;
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 70 || n.querySelector('input,button')) continue;
        if (n.children.length === 0) rows.push(t.slice(0, 56));
      }
      return { rows: rows.slice(0, 12), n: rows.length,
               engineOpts: window.__opts.length,
               engineSample: window.__opts.slice(0, 6).map((o) => window.__e.cbText(o).slice(0, 46)) };
    });
    console.log('  leaf rows: ' + res.n + '  ' + JSON.stringify(res.rows));
    console.log('  ENGINE sees ' + res.engineOpts + ' options: ' + JSON.stringify(res.engineSample));
  }

  const sub = await page.evaluate(() => window.__submits.slice());
  console.log('\n  SUBMITS: ' + JSON.stringify(sub));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
