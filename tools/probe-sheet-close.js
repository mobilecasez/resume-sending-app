// READ-ONLY PROBE — does ANY gesture available to injected JS close a rui sheet?
//
//   node tools/probe-sheet-close.js [--cpu 4]
//
// probe-dial-sheet.js measured that on Revolut's phone-code sheet only a REAL (trusted) Escape
// keypress dismissed it — blur, synthetic Escape (bubbling and not), re-clicking the trigger and a
// naive close-button hunt all did nothing. Injected WebView JS can never send a trusted key event,
// so if that is the whole story the engine can only ever leave that sheet open. This probe runs the
// SHIPPING cbForceClose / cbEnsureNoneOpen against the live sheet, inventories every control in the
// sheet's ancestor chain, and tests the backdrop, so the claim is measured rather than assumed.
//
// ⚠️ NEVER SUBMIT — five-layer shield, asserted at every phase.
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

const PROBE = `(function(){
  ${JS_HELPERS}
  window.__cvf = { nlbl:nlbl, vis:vis, deepQuery:deepQuery, ctrls:ctrls, cbText:cbText, cbShown:cbShown,
                   cbPopup:cbPopup, cbPreOpen:cbPreOpen, cbOptions:cbOptions, isComboTrigger:isComboTrigger,
                   cbForceClose:cbForceClose, cbEnsureNoneOpen:cbEnsureNoneOpen, cbStillOpen:cbStillOpen,
                   cbSheetRoot:cbSheetRoot, cbFindCloseCtrl:cbFindCloseCtrl, cbPreCloseCtrls:cbPreCloseCtrls,
                   cbLooksLikeList:cbLooksLikeList, cbSearchBox:cbSearchBox, setNative:setNative };
  window.__open = function(){
    var res=[], seen=[];
    try{ var ns=deepQuery('[role=listbox],[role=menu],[role=grid],[role=dialog],[class*=Sheet],[class*=sheet],[class*=Drawer],[class*=drawer],[class*=Popover],[class*=popover],[class*=Picker],[class*=picker],[class*=Portal],[class*=portal],[class*=Overlay],[class*=overlay],[class*=Modal],[class*=Group]');
      for(var i=0;i<ns.length&&i<400;i++){ var n=ns[i]; if(!vis(n)||!cbLooksLikeList(n)) continue;
        var d=false; for(var j=0;j<seen.length;j++){ if(seen[j].contains(n)||n.contains(seen[j])){ d=true; break; } } if(d) continue; seen.push(n);
        res.push({ role:n.getAttribute('role')||'', cls:String(n.className||'').slice(0,35), text:String(n.innerText||'').replace(/\\s+/g,' ').slice(0,40) }); } }catch(e){}
    return res;
  };
  window.__findDial = function(){ var all=ctrls();
    for(var i=0;i<all.length;i++){ var e=all[i]; if(vis(e)&&isComboTrigger(e)&&/country|dial|code/i.test(nlbl(e))){ window.__dial=e; return nlbl(e); } } return null; };
  window.__openSheet = function(){ window.__pre=cbPreOpen(); window.__preC=cbPreCloseCtrls(); window.__dial.scrollIntoView({block:'center'}); window.__dial.click(); };
  window.__resolve = function(){ window.__pop=cbPopup(window.__dial, window.__pre); return !!window.__pop; };
  window.__inventory = function(){
    // every control in the sheet's ancestor chain, so we can see whether a dismiss control exists AT ALL
    var out=[], n=window.__pop?window.__pop.el:null, h=0;
    while(n && h<8){
      var bs=[]; try{ var q=n.querySelectorAll('button,[role=button],[aria-label],svg,path'); var c=0;
        for(var i=0;i<q.length && c<14;i++){ var e=q[i]; if(!vis(e)) continue; if(e.tagName==='PATH') continue;
          bs.push({ tag:e.tagName, txt:cbText(e).slice(0,22), aria:(e.getAttribute('aria-label')||'').slice(0,22), role:e.getAttribute('role')||'', cls:String((e.className&&e.className.baseVal)||e.className||'').slice(0,32) }); c++; } }catch(e){}
      var r={x:0,y:0,w:0,h:0}; try{ var b=n.getBoundingClientRect(); r={x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}; }catch(e){}
      out.push({ hop:h, tag:n.tagName, role:n.getAttribute('role')||'', cls:String(n.className||'').slice(0,35), rect:r, ctrls:bs });
      n=n.parentElement; h++;
    }
    return out;
  };
})(); true;`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  if (CPU > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU }); console.log('  CPU throttled ' + CPU + 'x'); }
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(9000);
  await page.evaluate(SHIELD); await page.evaluate(PROBE);
  const guard = async (w) => { const s = await page.evaluate(() => window.__submits.length); console.log('  [submit guard @ ' + w + '] submits=' + s); if (s) process.exit(2); };
  await guard('start');
  console.log('  dial trigger: ' + JSON.stringify(await page.evaluate(() => window.__findDial())));

  const reopen = async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
    await page.evaluate(() => window.__openSheet());
    await page.waitForTimeout(1400);
    const okp = await page.evaluate(() => window.__resolve());
    const n = await page.evaluate(() => window.__open().length);
    return { resolved: okp, open: n };
  };

  head('PHASE 1 — the sheet\'s ancestor chain: does a dismiss control exist at all?');
  console.log('  reopen: ' + JSON.stringify(await reopen()));
  const inv = await page.evaluate(() => window.__inventory());
  inv.forEach((L) => { console.log('  hop ' + L.hop + ' <' + L.tag + ' role=' + L.role + ' class="' + L.cls + '"> rect=' + JSON.stringify(L.rect)); L.ctrls.forEach((c) => console.log('       ' + JSON.stringify(c))); });
  const closeCtrl = await page.evaluate(() => {
    const root = window.__cvf.cbSheetRoot(window.__pop.el);
    const c = window.__cvf.cbFindCloseCtrl(root, window.__preC);
    return { sheetRootCls: String(root.className || '').slice(0, 40), found: !!c, txt: c ? window.__cvf.cbText(c).slice(0, 25) : null, aria: c ? (c.getAttribute('aria-label') || '') : null };
  });
  console.log('  cbSheetRoot -> ' + closeCtrl.sheetRootCls + ' ; cbFindCloseCtrl -> ' + JSON.stringify(closeCtrl));
  await guard('after inventory');

  head('PHASE 2 — the SHIPPING cbForceClose, on the real sheet');
  let r = await page.evaluate(() => {
    const before = window.__open().length;
    const ret = window.__cvf.cbForceClose(window.__dial, window.__pop.el, window.__preC);
    return { before, ret };
  });
  await page.waitForTimeout(1000);
  let after = await page.evaluate(() => window.__open().length);
  console.log('  cbForceClose returned ' + r.ret + ' ; popups ' + r.before + ' -> ' + after + '  ' + (after < r.before ? 'CLOSED' : 'STILL OPEN'));

  head('PHASE 3 — the SHIPPING cbEnsureNoneOpen, on the real sheet');
  console.log('  reopen: ' + JSON.stringify(await reopen()));
  r = await page.evaluate(() => { const before = window.__open().length; const closed = window.__cvf.cbEnsureNoneOpen(); return { before, closed }; });
  await page.waitForTimeout(1000);
  after = await page.evaluate(() => window.__open().length);
  console.log('  cbEnsureNoneOpen reported ' + r.closed + ' closed ; popups ' + r.before + ' -> ' + after + '  ' + (after < r.before ? 'CLOSED' : 'STILL OPEN'));

  head('PHASE 4 — pointer gestures a WebView CAN send');
  const gestures = [
    ['synthetic click on elementFromPoint(5,5)', async () => page.evaluate(() => { const pt = document.elementFromPoint(5, 5); if (!pt) return 'none'; pt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); pt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); pt.click(); return pt.tagName + '.' + String(pt.className || '').slice(0, 20); })],
    ['synthetic pointerdown+up on backdrop', async () => page.evaluate(() => { const pt = document.elementFromPoint(5, 5); if (!pt) return 'none'; ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'].forEach((t) => pt.dispatchEvent(new (t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent)(t, { bubbles: true, cancelable: true }))); return pt.tagName; })],
    ['synthetic touchstart/end on backdrop', async () => page.evaluate(() => { const pt = document.elementFromPoint(5, 5); if (!pt) return 'none'; try { const t = new Touch({ identifier: 1, target: pt, clientX: 5, clientY: 5 }); pt.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], changedTouches: [t] })); pt.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [t] })); return 'sent'; } catch (e) { return 'TouchEvent unsupported: ' + e.message; } })],
    ['REAL mouse click on backdrop (5,5)', async () => { await page.mouse.click(5, 5); return 'trusted'; }],
    ['REAL Escape', async () => { await page.keyboard.press('Escape'); return 'trusted'; }],
  ];
  for (const [name, fn] of gestures) {
    const st = await reopen();
    let d = null; try { d = await fn(); } catch (e) { d = 'threw ' + e.message; }
    await page.waitForTimeout(900);
    const now = await page.evaluate(() => window.__open().length);
    console.log('  ' + name.padEnd(42) + ' open ' + st.open + ' -> ' + now + '  ' + (st.open > 0 && now < st.open ? 'CLOSED' : 'no effect') + '  (' + d + ')');
  }
  await guard('end');
  await browser.close();
})().catch((e) => { console.error('PROBE FAILED: ' + e.message); process.exit(1); });
