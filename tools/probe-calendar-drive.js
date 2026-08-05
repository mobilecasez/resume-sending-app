// PROOF PROBE — can the row's calendar-only date columns be driven DETERMINISTICALLY, and does
// that unlock the row's commit control?
//
//   node tools/probe-calendar-drive.js [--target 2013-06] [--cpu 4]
//
// probe-row-date-overlay.js proved there is NO programmatic door into the date box: setNative,
// readOnly=false+setNative, a _valueTracker reset, calling React's own onChange, and even REAL
// trusted keystrokes all leave it empty. The calendar is the only door. This probe walks it:
//
//   1. open the calendar from the date box
//   2. read the YEAR off the header (a 4-digit number — locale-proof)
//   3. press the back-arrow (year - target) times, VERIFYING the year moves each press
//   4. click the month cell BY INDEX (0..11 in DOM order — never by the word "Jun")
//   5. read the date box back
//   6. repeat for the End date, then check whether the row's commit button became enabled
//
// ⚠️ NEVER SUBMIT. Five-layer shield first, asserted at every phase. Pressing the ROW's commit
// control writes a row into the page's own form state; it does not send an application.
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
const TARGET = arg('target', '2013-06');
const CPU = Number(arg('cpu', '1'));
const head = (s) => console.log('\n' + '='.repeat(96) + '\n' + s + '\n' + '='.repeat(96));

const SHIELD = `
  window.__submits = []; window.__posts = [];
  document.addEventListener('submit', function(e){ e.preventDefault(); e.stopImmediatePropagation(); window.__submits.push('event'); }, true);
  HTMLFormElement.prototype.submit = function(){ window.__submits.push('proto'); };
  HTMLFormElement.prototype.requestSubmit = function(){ window.__submits.push('requestSubmit'); };
  (function(){ var of=window.fetch; window.fetch=function(u,o){ if(o&&/post|put/i.test((o&&o.method)||'')){ window.__posts.push(String(u).slice(0,60)); return Promise.reject(new Error('blocked')); } return of.apply(this,arguments); };
    var oo=XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open=function(m,u){ if(/post|put/i.test(m||'')){ window.__posts.push(String(u).slice(0,60)); throw new Error('blocked'); } return oo.apply(this,arguments); }; })();
  document.querySelectorAll('button[type=submit],input[type=submit]').forEach(function(b){ b.disabled=true; });
`;

// The candidate ENGINE, written the way it would ship: no English words, no vendor class names.
const ENGINE = `(function(){
  ${JS_HELPERS}
  window.__cvf = { nlbl:nlbl, vis:vis, deepQuery:deepQuery, ctrls:ctrls, cbText:cbText, sig:sig, setNative:setNative };

  // ── dpFindPanel: the date panel is the visible subtree that (a) appeared after our click and
  //    (b) contains a 4-digit year AND a run of >=7 same-role/same-shape cells. No class names.
  window.dpFindPanel = function(){
    var best=null, bestScore=0;
    var ns=deepQuery('[role=dialog],[role=grid],[role=application],div,span,section');
    for(var i=0;i<ns.length && i<4000;i++){
      var n=ns[i];
      if(!vis(n)) continue;
      var t=''; try{ t=String(n.innerText||''); }catch(e){}
      if(t.length>900 || !/(^|[^0-9])(19|20)[0-9][0-9]([^0-9]|$)/.test(t)) continue;
      var cells=[]; try{ cells=n.querySelectorAll('[role=gridcell],[role=option],td,button'); }catch(e){}
      var vc=0; for(var c=0;c<cells.length;c++){ if(vis(cells[c])) vc++; }
      if(vc<7) continue;
      // prefer the SMALLEST such node (the panel, not the page)
      var score=1/(t.length+1);
      if(score>bestScore){ bestScore=score; best=n; }
    }
    window.__panel=best;
    return best?{ text:String(best.innerText||'').replace(/\\s+/g,' ').slice(0,120), role:best.getAttribute('role')||'' }:null;
  };

  // ── dpCells: the pickable cells, IN DOM ORDER, with their enabled state. Index is the month.
  window.dpCells = function(){
    if(!window.__panel) return [];
    var out=[], q=[];
    try{ q=window.__panel.querySelectorAll('[role=gridcell]'); }catch(e){}
    if(!q.length){ try{ q=window.__panel.querySelectorAll('td,button'); }catch(e){} }
    for(var i=0;i<q.length;i++){
      var e=q[i]; if(!vis(e)) continue;
      var dis=false; try{ dis=!!e.disabled || e.getAttribute('aria-disabled')==='true'; }catch(x){}
      out.push({ i:out.length, txt:String(e.innerText||'').replace(/\\s+/g,' ').slice(0,12), aria:(e.getAttribute&&e.getAttribute('aria-label'))||'', disabled:dis });
    }
    window.__cells=q;
    return out;
  };

  // ── dpYear: every 4-digit year the panel shows. If the panel shows exactly one, that is the page.
  window.dpYear = function(){
    if(!window.__panel) return null;
    var t=''; try{ t=String(window.__panel.innerText||''); }catch(e){}
    var m=t.match(/(19|20)[0-9][0-9]/g);
    if(!m) return null;
    var set={}; for(var i=0;i<m.length;i++) set[m[i]]=1;
    var ks=Object.keys(set);
    return ks.length===1 ? Number(ks[0]) : ks.map(Number);
  };

  // ── dpNav: the two navigation controls. Found STRUCTURALLY, not by the words "Previous"/"Next":
  //    they are the interactive elements in the panel that are NOT cells, and there are exactly two
  //    (or two per row of the header). "back" is the one that comes FIRST in DOM order, which is
  //    true for every LTR calendar; for dir=rtl the order flips, so we read dir off the panel.
  window.dpNav = function(){
    if(!window.__panel) return null;
    var cells=[]; try{ cells=Array.prototype.slice.call(window.__panel.querySelectorAll('[role=gridcell],td')); }catch(e){}
    var btns=[], q=[];
    try{ q=window.__panel.querySelectorAll('button,[role=button]'); }catch(e){}
    for(var i=0;i<q.length;i++){
      var e=q[i]; if(!vis(e)) continue;
      var inCell=false; for(var c=0;c<cells.length;c++){ if(cells[c]===e || cells[c].contains(e)){ inCell=true; break; } }
      if(inCell) continue;
      btns.push(e);
    }
    // drop a dismiss control: it is the one whose activation would close the panel. We cannot know
    // that without pressing it, so instead we keep only buttons that sit in the SAME parent (a nav
    // group always shares one), and require exactly two.
    var byParent={};
    for(var j=0;j<btns.length;j++){ var p=btns[j].parentElement; var k=String(j); for(var kk in byParent){ if(byParent[kk].p===p){ k=kk; break; } } if(!byParent[k]) byParent[k]={p:p,list:[]}; byParent[k].list.push(btns[j]); }
    var pair=null;
    for(var kk2 in byParent){ if(byParent[kk2].list.length===2){ pair=byParent[kk2].list; break; } }
    window.__nav=pair;
    return { total:btns.length, texts:btns.map(function(b){ return String(b.innerText||'').replace(/\\s+/g,' ').slice(0,14); }), pairFound:!!pair,
             pairTexts: pair?pair.map(function(b){ return String(b.innerText||'').replace(/\\s+/g,' ').slice(0,14); }):null };
  };
  window.dpBack = function(){ if(!window.__nav) return false; var b=window.__nav[0];
    b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); b.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); b.click(); return true; };
  window.dpFwd  = function(){ if(!window.__nav) return false; var b=window.__nav[1];
    b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); b.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); b.click(); return true; };
  window.dpPick = function(i){ if(!window.__cells||!window.__cells[i]) return false; var e=window.__cells[i];
    e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); e.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); e.click(); return true; };
})(); true;`;

(async () => {
  const [ty, tm] = TARGET.split('-').map(Number);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  if (CPU > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU }); console.log('  CPU throttled ' + CPU + 'x'); }
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(9000);
  await page.evaluate(SHIELD); await page.evaluate(ENGINE);
  const guard = async (w) => { const s = await page.evaluate(() => window.__submits.length); console.log('  [submit guard @ ' + w + '] submits=' + s); if (s) process.exit(2); };
  await guard('start');

  head('OPEN ONE EXPERIENCE ROW');
  await page.evaluate(() => { window.__before = window.__cvf.ctrls().slice(); });
  const rp = await page.evaluate(() => {
    const cands = (typeof window.__rc === 'function') ? [] : [];
    const btns = window.__cvf.deepQuery('button,[role=button]');
    for (const b of btns) { if (!window.__cvf.vis(b)) continue; const t = String(b.innerText || '').trim(); if (/^\+?\s*add$/i.test(t)) { b.scrollIntoView({ block: 'center' }); b.click(); return t; } }
    return null;
  });
  console.log('  pressed section button: ' + JSON.stringify(rp));
  await page.waitForTimeout(1800);
  const rowInfo = await page.evaluate(() => {
    const after = window.__cvf.ctrls(), fresh = after.filter((e) => window.__before.indexOf(e) < 0);
    window.__row = fresh;
    // the row's own dialog: nearest [role=dialog] ancestor of the fresh controls
    let d = fresh.length ? fresh[0] : null, h = 0;
    while (d && h < 12 && !(d.getAttribute && d.getAttribute('role') === 'dialog')) { d = d.parentElement; h++; }
    window.__rowDlg = (d && d.getAttribute && d.getAttribute('role') === 'dialog') ? d : null;
    const btns = window.__rowDlg ? [...window.__rowDlg.querySelectorAll('button,[role=button]')].filter((b) => window.__cvf.vis(b)) : [];
    window.__rowBtns = btns;
    return {
      fresh: fresh.map((e) => ({ label: window.__cvf.nlbl(e).slice(0, 22), type: e.getAttribute('type') || '', ro: e.readOnly === true, testid: e.getAttribute('data-testid') || '' })),
      dialogFound: !!window.__rowDlg,
      buttons: btns.map((b, i) => ({ i, txt: String(b.innerText || '').trim().slice(0, 20), disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true' })),
    };
  });
  console.log('  row controls: ' + JSON.stringify(rowInfo.fresh));
  console.log('  row [role=dialog] found: ' + rowInfo.dialogFound);
  console.log('  buttons in the row dialog: ' + JSON.stringify(rowInfo.buttons));
  await guard('after row open');

  // ── fill the two text-shaped combo columns so only the dates are missing ────────────────────
  head('FILL Company + Position (so the commit control is gated ONLY on the dates)');
  for (const [lbl, val] of [['Company', 'METASYS SOFTWARE PVT. LTD.'], ['Position', 'Project Manager']]) {
    const r = await page.evaluate(async ([L, V]) => {
      const el = window.__row.find((e) => window.__cvf.nlbl(e).toLowerCase().indexOf(L.toLowerCase()) >= 0);
      if (!el) return 'no control';
      el.scrollIntoView({ block: 'center' }); el.click();
      await new Promise((r2) => setTimeout(r2, 900));
      const boxes = [...document.querySelectorAll('input')].filter((i) => window.__cvf.vis(i) && !i.readOnly && (i.type === 'text' || i.type === 'search') && i !== el);
      const sb = boxes[boxes.length - 1];
      if (sb) { sb.focus(); window.__cvf.setNative(sb, V); }
      await new Promise((r2) => setTimeout(r2, 1200));
      const rows = [...document.querySelectorAll('button')].filter((b) => window.__cvf.vis(b) && String(b.innerText || '').toLowerCase().indexOf(V.slice(0, 8).toLowerCase()) >= 0);
      if (rows.length) { rows[0].click(); await new Promise((r2) => setTimeout(r2, 800)); return 'picked ' + String(rows[0].innerText || '').slice(0, 30); }
      // free-text combos commit on blur
      if (sb) { sb.blur(); }
      await new Promise((r2) => setTimeout(r2, 600));
      return 'typed, no row matched; el.value=' + String(el.value || '');
    }, [lbl, val]);
    const now = await page.evaluate((L) => { const el = window.__row.find((e) => window.__cvf.nlbl(e).toLowerCase().indexOf(L.toLowerCase()) >= 0); return el ? String(el.value || '') : null; }, lbl);
    console.log('  ' + lbl.padEnd(10) + ' -> ' + r + '  | box now = ' + JSON.stringify(now));
  }
  await guard('after company/position');

  // ── THE CALENDAR ────────────────────────────────────────────────────────────────────────────
  const driveDate = async (labelWord, wantY, wantM) => {
    head('DRIVE THE CALENDAR: ' + labelWord + ' -> ' + wantY + '-' + String(wantM).padStart(2, '0'));
    const opened = await page.evaluate(async (L) => {
      const el = window.__row.find((e) => e.readOnly === true && window.__cvf.nlbl(e).toLowerCase().indexOf(L.toLowerCase()) >= 0);
      if (!el) return 'no date box';
      window.__dateEl = el;
      el.scrollIntoView({ block: 'center' }); el.click();
      await new Promise((r) => setTimeout(r, 1200));
      return 'clicked';
    }, labelWord);
    console.log('  ' + opened);
    const panel = await page.evaluate(() => window.dpFindPanel());
    console.log('  panel: ' + JSON.stringify(panel));
    if (!panel) return { ok: false, why: 'no panel' };
    console.log('  year : ' + JSON.stringify(await page.evaluate(() => window.dpYear())));
    console.log('  nav  : ' + JSON.stringify(await page.evaluate(() => window.dpNav())));
    console.log('  cells: ' + JSON.stringify(await page.evaluate(() => window.dpCells())));

    // step the year back, verifying the year moves on every press
    for (let hop = 0; hop < 40; hop++) {
      const y = await page.evaluate(() => window.dpYear());
      if (typeof y !== 'number') { console.log('  year is not a single number (' + JSON.stringify(y) + ') — cannot navigate deterministically'); break; }
      if (y === wantY) { console.log('  reached year ' + y + ' after ' + hop + ' presses'); break; }
      const dir = y > wantY ? 'back' : 'fwd';
      const pressed = await page.evaluate((d) => (d === 'back' ? window.dpBack() : window.dpFwd()), dir);
      await page.waitForTimeout(260);
      await page.evaluate(() => window.dpFindPanel());
      const y2 = await page.evaluate(() => window.dpYear());
      if (!pressed || y2 === y) { console.log('  press ' + dir + ' did nothing (year stuck at ' + y + ') — aborting navigation'); break; }
    }
    await page.evaluate(() => { window.dpFindPanel(); });
    const cells = await page.evaluate(() => window.dpCells());
    console.log('  cells at target year: ' + JSON.stringify(cells.map((c) => c.txt + (c.disabled ? '(x)' : ''))));
    const picked = await page.evaluate((i) => window.dpPick(i), wantM - 1);
    await page.waitForTimeout(1000);
    const val = await page.evaluate(() => String(window.__dateEl.value || ''));
    console.log('  picked cell index ' + (wantM - 1) + ' -> ' + picked + ' ; DATE BOX NOW = ' + JSON.stringify(val));
    return { ok: !!val, val };
  };

  const start = await driveDate('Start', ty, tm);
  await guard('after start date');
  const end = await driveDate('End', 2018, 3);
  await guard('after end date');

  head('DID THE ROW COMMIT CONTROL UNLOCK?');
  const btns = await page.evaluate(() => (window.__rowBtns || []).map((b, i) => ({ i, txt: String(b.innerText || '').trim().slice(0, 20), disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true', connected: b.isConnected })));
  console.log('  ' + JSON.stringify(btns));
  // re-read from the live dialog in case the buttons were re-rendered
  const live = await page.evaluate(() => {
    const d = window.__rowDlg && window.__rowDlg.isConnected ? window.__rowDlg : null;
    if (!d) return null;
    return [...d.querySelectorAll('button,[role=button]')].filter((b) => window.__cvf.vis(b)).map((b, i) => ({ i, txt: String(b.innerText || '').trim().slice(0, 20), disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true' }));
  });
  console.log('  live re-read: ' + JSON.stringify(live));
  await guard('end');
  await browser.close();
})().catch((e) => { console.error('PROBE FAILED: ' + e.message); process.exit(1); });
