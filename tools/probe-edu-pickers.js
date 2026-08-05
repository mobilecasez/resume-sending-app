// READ-MOSTLY PROBE — why the EDUCATION row will not complete.
//
//   node tools/probe-edu-pickers.js [--url <apply url>] [--json out.json]
//
// The e2e run leaves the Education row open with University, Major and Degree empty and the row's
// own Add button disabled. Experience fills. The columns differ in ONE way: education's are
// type-to-search pickers, and the values we hand them are résumé prose —
//   "C-DAC ACTS (Advanced Computing Training School), Pune, Maharashtra"
//   "Post Graduate Diploma in Advanced Computing (PG-DAC)"
// — while the picker's own list holds short canonical entries. So the questions are:
//
//   A. Does each picker ENUMERATE on open, or is its list remote/typed-only?
//   B. What does the list actually contain — canonical degrees? a university index?
//   C. Does typing the FULL résumé value return anything, and does a shorter, more distinctive
//      token return the right row? (That is the difference between a fix and a guess.)
//   D. Does picking a row actually populate the column and flip the row's commit control?
//
// ⚠️ NEVER SUBMIT — the same five-layer shield as the other probes, asserted at the end.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'MobileApp', 'app', '(ai-hub)', 'job-detail.tsx'), 'utf8');
const raw = (n) => { const m = SRC.match(new RegExp('(?:export )?const ' + n + ' = `([\\s\\S]*?)`;\\n')); if (!m) throw new Error('no ' + n); return m[1]; };
const JS_HELPERS = new Function('JS_HELPERS', 'return `' + raw('JS_HELPERS') + '`;')('');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const URL = arg('url', 'https://www.revolut.com/careers/apply/4ee78ed3-1222-4265-aca8-d6f147f7d15a/');
const OUT = arg('json', null);
const head = (s) => console.log('\n' + '='.repeat(96) + '\n' + s + '\n' + '='.repeat(96));
const out = { url: URL, pickers: [] };

const SHIELD = `
  window.__submits = []; window.__posts = [];
  document.addEventListener('submit', function(e){ e.preventDefault(); e.stopImmediatePropagation(); window.__submits.push('event'); }, true);
  HTMLFormElement.prototype.submit = function(){ window.__submits.push('proto'); };
  HTMLFormElement.prototype.requestSubmit = function(){ window.__submits.push('requestSubmit'); };
  (function(){ var of=window.fetch; window.fetch=function(u,o){ if(o&&/post|put/i.test((o&&o.method)||'')){ window.__posts.push(String(u).slice(0,60)); return Promise.reject(new Error('blocked')); } return of.apply(this,arguments); };
    var oo=XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open=function(m,u){ if(/post|put/i.test(m||'')){ window.__posts.push(String(u).slice(0,60)); throw new Error('blocked'); } return oo.apply(this,arguments); }; })();
  document.querySelectorAll('button[type=submit],input[type=submit]').forEach(function(b){ b.disabled=true; });
`;

const PROBE = `(function(){
  ${JS_HELPERS}
  window.__cvf = { nlbl:nlbl, cbShown:cbShown, vis:vis, deepQuery:deepQuery, ctrls:ctrls, cbText:cbText,
                   cbPopup:cbPopup, cbPreOpen:cbPreOpen, cbOptions:cbOptions, isCombo:isCombo,
                   isComboTrigger:isComboTrigger, cbSearchBox:cbSearchBox, setNative:setNative,
                   cbLooksLikeList:cbLooksLikeList, sig:sig, cbSafeClick:cbSafeClick,
                   repeaterCands:(typeof repeaterCands==='function'?repeaterCands:null) };
  window.__rowCtrls = function(){
    var all=ctrls(), out=[];
    for(var i=0;i<all.length;i++){
      var el=all[i];
      if((el.type||'').toLowerCase()==='search') continue;
      out.push({ label:nlbl(el).slice(0,60), tag:el.tagName.toLowerCase()+'/'+((el.getAttribute&&el.getAttribute('type'))||''),
                 combo:isCombo(el), value:String(el.value||''), shown:cbShown(el).slice(0,60) });
    }
    return out;
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
  await sleep(4000);
  await page.evaluate(PROBE);

  head('OPEN THE EDUCATION ROW');
  const opened = await page.evaluate(() => {
    const cands = window.__cvf.repeaterCands ? window.__cvf.repeaterCands() : [];
    const list = cands.map((c) => ({ label: String(c.label || '').slice(0, 70) }));
    let hit = null;
    for (const c of cands) if (/educat|universit|school/i.test(String(c.label || ''))) { hit = c; break; }
    if (!hit) return { list, clicked: false };
    hit.el.scrollIntoView({ block: 'center' });
    hit.el.click();
    return { list, clicked: true, label: String(hit.label || '').slice(0, 70) };
  });
  console.log('  repeaters seen: ' + JSON.stringify(opened.list));
  console.log('  clicked education Add: ' + opened.clicked);
  await sleep(2500);

  const rowCtrls = await page.evaluate(() => window.__rowCtrls());
  console.log('\n  ROW CONTROLS');
  for (const c of rowCtrls) console.log('    ' + c.tag.padEnd(16) + (c.combo ? 'COMBO  ' : '       ') + c.label.padEnd(24) + ' shown=' + JSON.stringify(c.shown));
  out.rowCtrls = rowCtrls;

  // The queries we care about: the résumé prose we actually send, and progressively shorter,
  // more distinctive slices of it. If a short token finds the row and the full string does not,
  // the fix is in HOW we search, not in what the picker can do.
  const CASES = [
    { col: /universit|school|institut/i, name: 'University',
      queries: ['C-DAC ACTS (Advanced Computing Training School), Pune, Maharashtra', 'C-DAC ACTS', 'C-DAC', 'Pune', 'Advanced Computing'] },
    { col: /major|field/i, name: 'Major',
      queries: ['Advanced Computing', 'Computing', 'Computer', 'Chemistry'] },
    { col: /degree|qualification/i, name: 'Degree',
      queries: ['Post Graduate Diploma in Advanced Computing (PG-DAC)', 'Post Graduate Diploma', 'Diploma', 'Master', 'Bachelor'] },
  ];

  for (const c of CASES) {
    head('PICKER: ' + c.name);
    const res = { name: c.name, queries: [] };
    const openInfo = await page.evaluate((colRe) => {
      const re = new RegExp(colRe, 'i');
      const all = window.__cvf.ctrls();
      let el = null;
      for (const e of all) { if ((e.type || '').toLowerCase() === 'search') continue; if (re.test(window.__cvf.nlbl(e))) { el = e; break; } }
      if (!el) return { found: false };
      window.__target = el;
      window.__pre = window.__cvf.cbPreOpen();
      el.scrollIntoView({ block: 'center' });
      try { el.focus(); } catch (e) {}
      el.click();
      return { found: true, label: window.__cvf.nlbl(el).slice(0, 50), tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', readOnly: !!el.readOnly };
    }, c.col.source);
    if (!openInfo.found) { console.log('  column not present'); out.pickers.push({ name: c.name, found: false }); continue; }
    console.log('  trigger: ' + JSON.stringify(openInfo));
    await sleep(1400);

    const onOpen = await page.evaluate(() => {
      const pop = window.__cvf.cbPopup(window.__target, window.__pre);
      const sb = pop ? window.__cvf.cbSearchBox(pop, window.__target) : null;
      const opts = pop ? window.__cvf.cbOptions(pop) : [];
      return {
        popup: !!pop, popCls: pop ? String(pop.className || '').slice(0, 50) : null,
        searchBox: !!sb, sbLabel: sb ? window.__cvf.nlbl(sb).slice(0, 40) : null,
        count: opts.length, sample: opts.slice(0, 10).map((o) => window.__cvf.cbText(o).slice(0, 50)),
      };
    });
    console.log('  on open: popup=' + onOpen.popup + '  searchBox=' + onOpen.searchBox + ' (' + JSON.stringify(onOpen.sbLabel) + ')  options=' + onOpen.count);
    console.log('    sample: ' + JSON.stringify(onOpen.sample));
    res.onOpen = onOpen;

    for (const q of c.queries) {
      const r = await page.evaluate(async (query) => {
        const pop = window.__cvf.cbPopup(window.__target, window.__pre);
        const sb = pop ? window.__cvf.cbSearchBox(pop, window.__target) : null;
        const box = sb || window.__target;
        try { box.focus(); } catch (e) {}
        window.__cvf.setNative(box, '');
        window.__cvf.setNative(box, query);
        return { typedInto: box === sb ? 'searchBox' : 'trigger' };
      }, q);
      await sleep(1600);
      const after = await page.evaluate(() => {
        const pop = window.__cvf.cbPopup(window.__target, window.__pre);
        const opts = pop ? window.__cvf.cbOptions(pop) : [];
        return { count: opts.length, sample: opts.slice(0, 6).map((o) => window.__cvf.cbText(o).slice(0, 60)) };
      });
      console.log('    "' + q.slice(0, 46) + '" -> ' + after.count + ' rows  ' + JSON.stringify(after.sample));
      res.queries.push({ q, into: r.typedInto, count: after.count, sample: after.sample });
    }

    // Does committing the BEST row actually populate the column?
    const picked = await page.evaluate(() => {
      const pop = window.__cvf.cbPopup(window.__target, window.__pre);
      const opts = pop ? window.__cvf.cbOptions(pop) : [];
      if (!opts.length) return { picked: false };
      const text = window.__cvf.cbText(opts[0]).slice(0, 60);
      window.__cvf.cbSafeClick(opts[0]);
      return { picked: true, text };
    });
    await sleep(1200);
    const shown = await page.evaluate(() => ({
      shown: window.__cvf.cbShown(window.__target).slice(0, 60),
      value: String(window.__target.value || '').slice(0, 60),
    }));
    console.log('  picked first row: ' + JSON.stringify(picked) + '  -> column now reads ' + JSON.stringify(shown));
    res.picked = picked; res.shown = shown;
    out.pickers.push(res);
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(600);
  }

  head('ROW STATE AFTER THE PICKS');
  const rowNow = await page.evaluate(() => {
    const all = window.__cvf.ctrls().filter((e) => (e.type || '').toLowerCase() !== 'search');
    const btns = window.__cvf.deepQuery('button,[role=button]').filter((b) => window.__cvf.vis(b))
      .map((b) => ({ text: window.__cvf.cbText(b).slice(0, 24), disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true' }))
      .filter((b) => /add|save|confirm/i.test(b.text));
    return {
      ctrls: all.map((e) => ({ label: window.__cvf.nlbl(e).slice(0, 30), shown: window.__cvf.cbShown(e).slice(0, 40) })),
      commit: btns,
      submits: window.__submits.slice(), posts: window.__posts.slice(),
    };
  });
  for (const c of rowNow.ctrls) console.log('    ' + c.label.padEnd(28) + ' = ' + JSON.stringify(c.shown));
  console.log('  commit controls: ' + JSON.stringify(rowNow.commit));
  console.log('\n  SUBMITS: ' + JSON.stringify(rowNow.submits) + '   blocked POSTs: ' + JSON.stringify(rowNow.posts));
  out.rowNow = rowNow;

  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log('  wrote ' + OUT); }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
