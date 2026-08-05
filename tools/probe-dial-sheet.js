// READ-ONLY PROBE — the dial picker's IDENTITY, its render budget, and what actually closes it.
//
//   node tools/probe-dial-sheet.js [--cpu 4] [--url <apply url>] [--json out.json]
//
// The e2e reproduction proved the dial picker WORKS when the option list reaches the server, and
// fails when it does not — because the server can only recognise a dial control by its options.
// So the questions this probe answers are:
//
//   A. IDENTITY WITHOUT OPTIONS. Is there anything on the trigger itself — attributes, React props,
//      or its STRUCTURAL neighbours — that says "dial picker" without opening the sheet? If yes,
//      the scan can flag it and the server never has to infer it from a list it may not receive.
//   B. THE RENDER BUDGET. How long does the sheet take to (i) exist, (ii) have rows, (iii) have the
//      RIGHT row after filtering — at 1x, 4x and 6x CPU throttling? enumCombos gives it 2200ms.
//   C. CLOSURE. Which gesture actually dismisses this sheet, and does the SELECTION SURVIVE it?
//
// ⚠️ NEVER SUBMIT — same five-layer shield as the e2e harness, asserted at every phase.
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
const CPU = Number(arg('cpu', '1'));
const OUT = arg('json', null);
const head = (s) => console.log('\n' + '='.repeat(96) + '\n' + s + '\n' + '='.repeat(96));
const out = { cpu: CPU };

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
                   cbPopup:cbPopup, cbPreOpen:cbPreOpen, cbOptions:cbOptions, cbListPartial:cbListPartial,
                   isCombo:isCombo, isComboTrigger:isComboTrigger, cbSearchBox:cbSearchBox, setNative:setNative,
                   cbLooksLikeList:cbLooksLikeList, sig:sig, isDialCtrl:(typeof isDialCtrl==='function'?isDialCtrl:null) };
  window.__attrs = function(el){ var o={}; try{ var a=el.attributes; for(var i=0;i<a.length;i++) o[a[i].name]=String(a[i].value).slice(0,50); }catch(e){} return o; };
  window.__props = function(el){ var o={keys:null,vals:{}}; try{ for(var k in el){ if(k.indexOf('__reactProps$')===0){ var p=el[k]; o.keys=Object.keys(p); for(var i=0;i<o.keys.length;i++){ var v=p[o.keys[i]]; if(typeof v==='string'||typeof v==='number'||typeof v==='boolean') o.vals[o.keys[i]]=String(v).slice(0,40); } } } }catch(e){} return o; };
  window.__neighbours = function(el){
    // What sits AROUND the trigger. A dial picker is structurally "a combo trigger immediately
    // before a tel/phone input inside one group" on every design system that splits the number.
    var out={ groupTag:null, groupCls:null, siblings:[] };
    try{
      var g=el.parentElement, h=0;
      while(g && h<5){ if(g.querySelectorAll('input,select,textarea').length>1) break; g=g.parentElement; h++; }
      if(g){ out.groupTag=g.tagName; out.groupCls=String(g.className||'').slice(0,50);
        var cs=g.querySelectorAll('input,select,textarea');
        for(var i=0;i<cs.length&&i<8;i++){ var c=cs[i];
          out.siblings.push({ same:c===el, tag:c.tagName, type:(c.getAttribute('type')||''), inputmode:(c.getAttribute('inputmode')||''),
                              autocomplete:(c.getAttribute('autocomplete')||''), name:(c.name||''), testid:(c.getAttribute('data-testid')||''),
                              label:nlbl(c).slice(0,40), ph:String(c.placeholder||'').slice(0,25) }); }
      }
    }catch(e){}
    return out;
  };
  window.__popups = function(){
    var res=[], seen=[];
    try{
      var ns=deepQuery('[role=listbox],[role=menu],[role=grid],[role=dialog],[class*=Sheet],[class*=sheet],[class*=Drawer],[class*=drawer],[class*=Popover],[class*=popover],[class*=Picker],[class*=picker],[class*=Portal],[class*=portal],[class*=Overlay],[class*=overlay],[class*=Modal],[class*=Group]');
      for(var i=0;i<ns.length&&i<400;i++){ var n=ns[i]; if(!vis(n)||!cbLooksLikeList(n)) continue;
        var d=false; for(var j=0;j<seen.length;j++){ if(seen[j].contains(n)||n.contains(seen[j])){ d=true; break; } }
        if(d) continue; seen.push(n);
        res.push({ role:n.getAttribute('role')||'', cls:String(n.className||'').slice(0,40), rows:n.querySelectorAll('button,li,[role=option]').length, text:String(n.innerText||'').replace(/\\s+/g,' ').slice(0,50) }); }
    }catch(e){}
    return res;
  };
  window.__findDial = function(){
    var all=ctrls(), best=null;
    for(var i=0;i<all.length;i++){ var e=all[i]; if(!vis(e)) continue;
      if(isComboTrigger(e) && /country|dial|code/i.test(nlbl(e))){ best=e; break; } }
    window.__dial=best; return best?{ label:nlbl(best).slice(0,60), shows:cbShown(best), sig:sig(best) }:null;
  };
})(); true;`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  if (CPU > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU }); console.log('  CPU throttled ' + CPU + 'x'); }
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(9000);
  await page.evaluate(SHIELD);
  await page.evaluate(PROBE);
  const guard = async (w) => { const s = await page.evaluate(() => ({ s: window.__submits.slice(), p: window.__posts.slice() })); console.log('  [submit guard @ ' + w + '] submits=' + s.s.length + ' blockedWrites=' + s.p.length); if (s.s.length) process.exit(2); };
  await guard('start');

  head('PHASE A — the dial trigger, WITHOUT opening it');
  const found = await page.evaluate(() => window.__findDial());
  console.log('  dial trigger: ' + JSON.stringify(found));
  if (!found) { console.log('  not found — cannot continue'); await browser.close(); return; }
  out.trigger = found;
  out.attrs = await page.evaluate(() => window.__attrs(window.__dial));
  out.props = await page.evaluate(() => window.__props(window.__dial));
  out.neighbours = await page.evaluate(() => window.__neighbours(window.__dial));
  out.isDialCtrl = await page.evaluate(() => (window.__cvf.isDialCtrl ? window.__cvf.isDialCtrl(window.__dial) : null));
  console.log('  attributes : ' + JSON.stringify(out.attrs));
  console.log('  reactProps : ' + JSON.stringify(out.props));
  console.log('  isDialCtrl(client helper) = ' + out.isDialCtrl);
  console.log('  STRUCTURAL NEIGHBOURS (the group it lives in):');
  console.log('    group <' + out.neighbours.groupTag + ' class="' + out.neighbours.groupCls + '">');
  (out.neighbours.siblings || []).forEach((s) => console.log('      ' + (s.same ? '>> ' : '   ') + JSON.stringify(s)));

  head('PHASE B — render budget: when does the sheet exist / have rows / have the RIGHT row?');
  const timeline = await page.evaluate(async () => {
    const t0 = Date.now();
    const marks = { open: null, exists: null, rows: null, rowCountAtFirst: null, partialAtFirst: null };
    const pre = window.__cvf.cbPreOpen();
    window.__pre = pre;
    window.__dial.scrollIntoView({ block: 'center' });
    window.__dial.click();
    marks.open = 0;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 50));
      let p = null; try { p = window.__cvf.cbPopup(window.__dial, pre); } catch (e) {}
      if (p && marks.exists === null) marks.exists = Date.now() - t0;
      if (p) {
        const os = window.__cvf.cbOptions(window.__dial, p);
        if (os.length && marks.rows === null) {
          marks.rows = Date.now() - t0; marks.rowCountAtFirst = os.length;
          try { marks.partialAtFirst = window.__cvf.cbListPartial(window.__dial, p, os); } catch (e) {}
          window.__pop = p;
          break;
        }
      }
    }
    return marks;
  });
  out.timeline = timeline;
  console.log('  sheet EXISTS at   ' + timeline.exists + 'ms');
  console.log('  sheet HAS ROWS at ' + timeline.rows + 'ms  (rows=' + timeline.rowCountAtFirst + ', cbListPartial=' + timeline.partialAtFirst + ')');
  console.log('  enumCombos budget is 2200ms -> ' + (timeline.rows !== null && timeline.rows <= 2200 ? 'WITHIN budget' : 'MISSES the budget'));

  // filter and time the arrival of the target row
  const filt = await page.evaluate(async () => {
    const sb = window.__cvf.cbSearchBox(window.__dial, window.__pop);
    if (!sb) return { searchBox: false };
    const t0 = Date.now();
    sb.focus(); window.__cvf.setNative(sb, 'india');
    let at = null, rows = 0, sample = [];
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const p = window.__cvf.cbPopup(window.__dial, window.__pre) || window.__pop;
      const os = window.__cvf.cbOptions(window.__dial, p);
      rows = os.length;
      const hit = os.some((o) => /india/i.test(window.__cvf.cbText(o)));
      if (hit) { at = Date.now() - t0; sample = os.slice(0, 5).map((o) => window.__cvf.cbText(o).slice(0, 30)); break; }
    }
    return { searchBox: true, targetRowAt: at, rowsAfterFilter: rows, sample };
  });
  out.filter = filt;
  console.log('  filtered "india": target row at ' + filt.targetRowAt + 'ms, rows now ' + filt.rowsAfterFilter + ' ' + JSON.stringify(filt.sample));
  await guard('after open+filter');

  head('PHASE C — commit, then test what CLOSES the sheet and whether the pick survives');
  const picked = await page.evaluate(async () => {
    const p = window.__cvf.cbPopup(window.__dial, window.__pre) || window.__pop;
    const os = window.__cvf.cbOptions(window.__dial, p);
    const hit = os.find((o) => /india/i.test(window.__cvf.cbText(o)));
    if (!hit) return { picked: false };
    const txt = window.__cvf.cbText(hit);
    hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    hit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    hit.click();
    await new Promise((r) => setTimeout(r, 700));
    return { picked: true, rowText: txt.slice(0, 40), shows: window.__cvf.cbShown(window.__dial), value: String(window.__dial.value || ''), stillOpen: window.__popups().length };
  });
  out.pick = picked;
  console.log('  clicked row ' + JSON.stringify(picked.rowText) + ' -> trigger shows ' + JSON.stringify(picked.shows) + ', value=' + JSON.stringify(picked.value) + ', popups still open=' + picked.stillOpen);

  // does the selection SURVIVE a re-render? Touch another control and re-read.
  const survive = await page.evaluate(async () => {
    const all = window.__cvf.ctrls();
    const other = all.find((e) => e.tagName === 'INPUT' && (e.getAttribute('type') || 'text') === 'text' && !e.readOnly && window.__cvf.vis(e));
    if (other) { other.focus(); window.__cvf.setNative(other, 'x'); other.blur(); }
    await new Promise((r) => setTimeout(r, 800));
    return { shows: window.__cvf.cbShown(window.__dial), value: String(window.__dial.value || '') };
  });
  out.survive = survive;
  console.log('  after touching another field: shows ' + JSON.stringify(survive.shows) + ' value ' + JSON.stringify(survive.value));

  head('PHASE D — closure matrix on a freshly opened sheet');
  const matrix = [];
  const gestures = [
    ['blur trigger', () => page.evaluate(() => { window.__dial.blur(); })],
    ['Escape on search box (bubbles:false)', () => page.evaluate(() => { const sb = window.__cvf.cbSearchBox(window.__dial, window.__pop); if (sb) { sb.focus(); sb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: false })); } })],
    ['Escape on document (bubbles:true)', () => page.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); })],
    ['REAL Escape keypress', () => page.keyboard.press('Escape')],
    ['click trigger again (toggle)', () => page.evaluate(() => { window.__dial.click(); })],
    ['click the sheet\'s own Close/Cancel', () => page.evaluate(() => {
      const ns = window.__cvf.deepQuery('button,[role=button],[aria-label]');
      for (const n of ns) { if (!window.__cvf.vis(n)) continue; const t = window.__cvf.cbText(n).trim(); const a = n.getAttribute('aria-label') || ''; if (/^(close|cancel|back|done|×|✕)$/i.test(t) || /close|dismiss|back/i.test(a)) { if (window.__pop && window.__pop.el && (window.__pop.el.contains(n) || (n.compareDocumentPosition(window.__pop.el) & 8))) { n.click(); return String(t || a).slice(0, 20); } } }
      return null;
    })],
  ];
  for (const [name, fn] of gestures) {
    // reopen fresh
    await page.evaluate(async () => {
      // make sure nothing is open first
      for (let i = 0; i < 3; i++) { if (!window.__popups().length) break; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); await new Promise((r) => setTimeout(r, 300)); }
      window.__pre = window.__cvf.cbPreOpen();
      window.__dial.scrollIntoView({ block: 'center' });
      window.__dial.click();
      await new Promise((r) => setTimeout(r, 1200));
      window.__pop = window.__cvf.cbPopup(window.__dial, window.__pre);
    });
    const openNow = await page.evaluate(() => window.__popups().length);
    let detail = null;
    try { detail = await fn(); } catch (e) { detail = 'threw ' + e.message; }
    await page.waitForTimeout(900);
    const closedNow = await page.evaluate(() => window.__popups().length);
    matrix.push({ gesture: name, popupsBefore: openNow, popupsAfter: closedNow, closed: openNow > 0 && closedNow < openNow, detail });
    console.log('  ' + name.padEnd(40) + ' open ' + openNow + ' -> ' + closedNow + '  ' + (openNow > 0 && closedNow < openNow ? 'CLOSED' : 'no effect') + (detail ? '  (' + detail + ')' : ''));
  }
  out.closeMatrix = matrix;
  await guard('end');

  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log('\n  wrote ' + OUT); }
  await browser.close();
})().catch((e) => { console.error('PROBE FAILED: ' + e.message); process.exit(1); });
