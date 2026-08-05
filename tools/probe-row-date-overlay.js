// READ-MOSTLY PROBE — the three mechanisms the e2e reproduction left unsolved.
//
//   node tools/probe-row-date-overlay.js [--url <apply url>] [--json out.json]
//
// This does NOT fill a form and does NOT talk to our server. It opens the live page, adds ONE
// repeater row, and then interrogates the widgets the reproduction could not drive:
//
//   A. the readOnly date box in the row  — is there ANY programmatic path, or is the calendar the
//      only door? (React fibre props, readOnly-off + setNative, valueTracker reset, real typing)
//   B. the calendar portal              — what is its structure, and can it be driven
//      DETERMINISTICALLY to a target year+month without matching English words?
//   C. the row's commit control         — can it be found STRUCTURALLY (not by the word "Add"),
//      and does its disabled state flip once the dates are set?
//   D. the overlay families on this page — which gesture actually dismisses each, verified.
//
// ⚠️ HARD RULE — NEVER SUBMIT. The same five-layer shield the e2e harness uses is installed before
// anything is touched, and every phase asserts zero submit attempts and zero blocked POST/PUTs.
// Pressing the ROW's own commit control is a local form-state operation, not an application.
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
const out = {};

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
  window.__cvf = { nlbl:nlbl, cbShown:cbShown, vis:vis, visCtl:visCtl, deepQuery:deepQuery, ctrls:ctrls,
                   cbLooksLikeList:cbLooksLikeList, isCombo:isCombo, cbText:cbText, setNative:setNative,
                   repeaterCands:(typeof repeaterCands==='function'?repeaterCands:null), sig:sig };
  window.__desc = function(el){
    if(!el) return null;
    var r={}; try{ r.tag=el.tagName; }catch(e){}
    try{ r.type=(el.getAttribute&&el.getAttribute('type'))||''; }catch(e){}
    try{ r.text=cbText(el).slice(0,40); }catch(e){}
    try{ r.label=nlbl(el).slice(0,40); }catch(e){}
    try{ r.disabled=!!el.disabled || el.getAttribute('aria-disabled')==='true'; }catch(e){}
    try{ r.readOnly=el.readOnly===true; }catch(e){}
    try{ r.value=String(el.value==null?'':el.value).slice(0,40); }catch(e){}
    try{ r.ph=String(el.placeholder||'').slice(0,30); }catch(e){}
    try{ r.testid=(el.getAttribute&&el.getAttribute('data-testid'))||''; }catch(e){}
    try{ r.role=el.getAttribute('role')||''; }catch(e){}
    try{ r.aria=el.getAttribute('aria-label')||''; }catch(e){}
    try{ r.cls=String((el.className&&el.className.baseVal)||el.className||'').slice(0,60); }catch(e){}
    return r;
  };
  // React internals: the ONLY way to answer "is there a programmatic door" definitively.
  window.__fiber = function(el){
    var o={ propKeys:null, hasOnChange:false, hasOnClick:false, fiberFound:false, stateNode:null, ownerNames:[] };
    try{
      for(var k in el){
        if(k.indexOf('__reactProps$')===0){ var p=el[k]; o.propKeys=Object.keys(p).slice(0,25); o.hasOnChange=typeof p.onChange==='function'; o.hasOnClick=typeof p.onClick==='function'; }
        if(k.indexOf('__reactFiber$')===0){
          o.fiberFound=true;
          var f=el[k], h=0;
          while(f && h<12){ var t=f.type; var nm=(typeof t==='function'?(t.displayName||t.name):(typeof t==='string'?t:null)); if(nm) o.ownerNames.push(nm); f=f.return; h++; }
        }
      }
    }catch(e){ o.err=String(e&&e.message); }
    return o;
  };
  window.__popups = function(){
    var res=[], seen=[];
    try{
      var ns=deepQuery('[role=listbox],[role=menu],[role=grid],[role=dialog],[class*=Sheet],[class*=sheet],[class*=Drawer],[class*=drawer],[class*=Popover],[class*=popover],[class*=Picker],[class*=picker],[class*=Portal],[class*=portal],[class*=Overlay],[class*=overlay],[class*=Modal],[class*=Group]');
      for(var i=0;i<ns.length&&i<400;i++){
        var n=ns[i]; if(!vis(n)||!cbLooksLikeList(n)) continue;
        var dupe=false; for(var j=0;j<seen.length;j++){ if(seen[j].contains(n)||n.contains(seen[j])){ dupe=true; break; } }
        if(dupe) continue; seen.push(n);
        res.push({ cls:String((n.className&&n.className.baseVal)||n.className||'').slice(0,45),
                   role:n.getAttribute('role')||'',
                   rows:n.querySelectorAll('button,li,[role=option],[role=gridcell]').length,
                   text:String(n.innerText||'').replace(/\\s+/g,' ').slice(0,70) });
      }
    }catch(e){}
    return res;
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
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(9000);
  await page.evaluate(SHIELD);
  await page.evaluate(PROBE);
  const guard = async (where) => {
    const s = await page.evaluate(() => ({ s: window.__submits.slice(), p: window.__posts.slice() }));
    console.log('  [submit guard @ ' + where + '] submits=' + s.s.length + ' blockedWrites=' + s.p.length);
    if (s.s.length) { console.error('  !! A SUBMIT WAS ATTEMPTED — aborting'); process.exit(2); }
    return s;
  };
  await guard('start');
  out.popupsBefore = await page.evaluate(() => window.__popups());
  console.log('  popups open before anything: ' + out.popupsBefore.length);

  // ── Add ONE experience row ────────────────────────────────────────────────────────────────
  head('PHASE 1 — open one repeater row and dump it');
  const before = await page.evaluate(() => { window.__before = window.__cvf.ctrls().slice(); return window.__before.length; });
  const clicked = await page.evaluate(() => {
    var cands = window.__cvf.repeaterCands ? window.__cvf.repeaterCands() : [];
    var target = null;
    for (var i = 0; i < cands.length; i++) { if (/experience|employment|work|role/i.test(cands[i].label)) { target = cands[i]; break; } }
    if (!target && cands.length) target = cands[0];
    if (!target) return null;
    target.el.scrollIntoView({ block: 'center' });
    target.el.click();
    return { label: target.label.slice(0, 70), key: String(target.key).slice(0, 60) };
  });
  console.log('  repeater pressed: ' + JSON.stringify(clicked));
  out.repeater = clicked;
  await page.waitForTimeout(1600);
  await guard('after row open');

  const row = await page.evaluate(() => {
    var after = window.__cvf.ctrls(), fresh = [];
    for (var i = 0; i < after.length; i++) if (window.__before.indexOf(after[i]) < 0) fresh.push(after[i]);
    window.__row = fresh;
    // the smallest node containing every fresh control = the row portal
    var host = fresh.length ? fresh[0].parentElement : null, h = 0;
    while (host && h < 12) { var all = true; for (var j = 0; j < fresh.length; j++) if (!host.contains(fresh[j])) { all = false; break; } if (all) break; host = host.parentElement; h++; }
    window.__rowHost = host;
    // THE SMALLEST containing node is not the row: it is the InputGroup, and the row's own
    // Cancel/commit footer sits ABOVE it. Walk up and report each ancestor's buttons, so we can see
    // at which height the footer appears and what separates it from the page's own chrome.
    var ladder = [], n = host, hh = 0;
    while (n && hh < 8) {
      var bs = [];
      try { var q = n.querySelectorAll('button,[role=button]'); for (var b = 0; b < q.length && b < 12; b++) bs.push(window.__desc(q[b])); } catch (e) {}
      ladder.push({ hop: hh, tag: n.tagName, role: n.getAttribute('role') || '', cls: String(n.className || '').slice(0, 45), buttons: bs, inputs: n.querySelectorAll('input,select,textarea').length });
      if (bs.length) { window.__rowFooterHost = window.__rowFooterHost || n; }
      n = n.parentElement; hh++;
    }
    return { controls: fresh.map((e) => window.__desc(e)), hostTag: host ? host.tagName : null, hostCls: host ? String(host.className || '').slice(0, 60) : null, hostRole: host ? (host.getAttribute('role') || '') : '', ladder: ladder };
  });
  out.row = row;
  console.log('  row controls:');
  (row.controls || []).forEach((c) => console.log('    ' + JSON.stringify(c)));
  console.log('  row host: <' + row.hostTag + ' role=' + row.hostRole + ' class="' + row.hostCls + '">');
  console.log('  ANCESTOR LADDER (where does the commit footer live?):');
  (row.ladder || []).forEach((L) => { console.log('    hop ' + L.hop + '  <' + L.tag + ' role=' + L.role + ' class="' + L.cls + '"> inputs=' + L.inputs + ' buttons=' + L.buttons.length); L.buttons.forEach((b) => console.log('        ' + JSON.stringify(b))); });

  // ── A. the readOnly date box: is there ANY programmatic door? ─────────────────────────────
  head('PHASE 2 — the readOnly date box: React fibre + four write strategies');
  const dateInfo = await page.evaluate(() => {
    var d = null;
    for (var i = 0; i < window.__row.length; i++) {
      var e = window.__row[i];
      if (e.tagName === 'INPUT' && e.readOnly === true && /date|from|to|start|end/i.test(window.__cvf.nlbl(e))) { d = e; break; }
    }
    if (!d) for (var j = 0; j < window.__row.length; j++) { var e2 = window.__row[j]; if (e2.tagName === 'INPUT' && e2.readOnly === true) { d = e2; break; } }
    window.__date = d;
    return d ? { desc: window.__desc(d), fiber: window.__fiber(d) } : null;
  });
  out.dateInfo = dateInfo;
  console.log('  date control: ' + JSON.stringify(dateInfo && dateInfo.desc));
  console.log('  react props : ' + JSON.stringify(dateInfo && dateInfo.fiber));

  const writes = [];
  const tryWrite = async (name, fn) => {
    const r = await page.evaluate(fn);
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => (window.__date ? String(window.__date.value || '') : null));
    writes.push({ name, immediate: r, after });
    console.log('  ' + name.padEnd(34) + ' immediate=' + JSON.stringify(r) + '  after 500ms=' + JSON.stringify(after));
  };
  if (dateInfo) {
    await tryWrite('setNative only', () => { window.__cvf.setNative(window.__date, '06/2013'); return String(window.__date.value || ''); });
    await tryWrite('readOnly=false + setNative', () => { var d = window.__date; d.readOnly = false; window.__cvf.setNative(d, '06/2013'); d.dispatchEvent(new Event('change', { bubbles: true })); return String(d.value || ''); });
    await tryWrite('valueTracker reset + setNative', () => {
      var d = window.__date; try { if (d._valueTracker) d._valueTracker.setValue(''); } catch (e) {}
      var proto = window.HTMLInputElement.prototype, s = Object.getOwnPropertyDescriptor(proto, 'value').set;
      s.call(d, '06/2013'); d.dispatchEvent(new Event('input', { bubbles: true })); d.dispatchEvent(new Event('change', { bubbles: true }));
      return String(d.value || '');
    });
    // Does the component's OWN onChange accept anything at all? Call it directly with a synthetic
    // event object — this bypasses readOnly and the DOM entirely and asks the component itself.
    await tryWrite('call React onChange directly', () => {
      var d = window.__date, res = 'no props';
      for (var k in d) {
        if (k.indexOf('__reactProps$') === 0 && typeof d[k].onChange === 'function') {
          try { d[k].onChange({ target: { value: '06/2013' }, currentTarget: { value: '06/2013' }, preventDefault: function () {}, stopPropagation: function () {}, nativeEvent: {} }); res = 'called'; } catch (e) { res = 'threw: ' + String(e && e.message).slice(0, 60); }
        }
      }
      return res;
    });
    // real trusted typing — the one thing an injected script can never do, but Playwright can,
    // so we learn whether the control is even typeable in principle. Run it twice: as shipped
    // (readOnly) and with readOnly forced off, which IS something injected JS can do.
    for (const ro of [true, false]) {
      try {
        await page.evaluate((keep) => { window.__date.readOnly = keep; window.__date.scrollIntoView({ block: 'center' }); window.__date.focus(); }, ro);
        await page.keyboard.type('062013', { delay: 60 });
        await page.waitForTimeout(600);
        const after = await page.evaluate(() => String(window.__date.value || ''));
        writes.push({ name: 'REAL keystrokes readOnly=' + ro, after });
        console.log('  ' + ('REAL keystrokes readOnly=' + ro).padEnd(34) + ' after=' + JSON.stringify(after));
      } catch (e) { console.log('  real typing failed: ' + e.message); }
    }
    await page.evaluate(() => { try { window.__date.readOnly = true; } catch (e) {} });
  }
  out.writes = writes;
  await guard('after date writes');

  // ── B. the calendar portal ────────────────────────────────────────────────────────────────
  head('PHASE 3 — open the calendar and map it structurally');
  const cal = await page.evaluate(() => {
    if (!window.__date) return null;
    window.__snapNodes = [];
    try { var all = document.querySelectorAll('body *'); for (var i = 0; i < all.length; i++) window.__snapNodes.push(all[i]); } catch (e) {}
    window.__date.scrollIntoView({ block: 'center' });
    return { before: window.__popups().length };
  });
  // a REAL trusted click — a synthetic .click() may not open a design-system portal
  try {
    const b = await page.evaluate(() => { const r = window.__date.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.click(b.x, b.y);
  } catch (e) { await page.evaluate(() => window.__date.click()); }
  await page.waitForTimeout(1600);
  // Everything that APPEARED, regardless of what it is called — no popup heuristic in the way.
  const appeared = await page.evaluate(() => {
    var res = [];
    try {
      var all = document.querySelectorAll('body *');
      for (var i = 0; i < all.length && res.length < 40; i++) {
        var n = all[i];
        if (window.__snapNodes.indexOf(n) >= 0) continue;
        if (!window.__cvf.vis(n)) continue;
        var pr = n.parentElement;
        var parentNew = pr && window.__snapNodes.indexOf(pr) < 0;
        if (parentNew) continue;                     // report only the ROOT of each new subtree
        res.push({ tag: n.tagName, role: n.getAttribute('role') || '', cls: String(n.className || '').slice(0, 55), text: String(n.innerText || '').replace(/\s+/g, ' ').slice(0, 90) });
      }
    } catch (e) {}
    return res;
  });
  out.appearedOnDateClick = appeared;
  console.log('  NEW subtrees that appeared on the date click:');
  appeared.forEach((a) => console.log('    ' + JSON.stringify(a)));
  const calMap = await page.evaluate(() => {
    var pops = window.__popups();
    // the calendar = the popup that appeared and is NOT the row host
    var node = null;
    try {
      var ns = window.__cvf.deepQuery('[role=dialog],[role=grid],[class*=Calendar],[class*=calendar],[class*=Picker],[class*=picker],[class*=Popover],[class*=Modal]');
      for (var i = 0; i < ns.length; i++) {
        var n = ns[i];
        if (!window.__cvf.vis(n)) continue;
        if (window.__rowHost && (n.contains(window.__rowHost) || n === window.__rowHost)) continue;
        var t = String(n.innerText || '');
        if (/\b(19|20)\d\d\b/.test(t) && t.length < 900) { node = n; break; }
      }
    } catch (e) {}
    window.__cal = node;
    if (!node) return { popups: pops, node: null };
    var items = [];
    try {
      var cs = node.querySelectorAll('button,[role=button],[role=gridcell],[role=option],select,input');
      for (var k = 0; k < cs.length && items.length < 80; k++) items.push(window.__desc(cs[k]));
    } catch (e) {}
    return {
      popups: pops,
      node: { tag: node.tagName, role: node.getAttribute('role') || '', cls: String(node.className || '').slice(0, 60), text: String(node.innerText || '').replace(/\\s+/g, ' ').slice(0, 260) },
      items: items,
      dataAttrs: (function () {
        var seen = {}; try { var all = node.querySelectorAll('*'); for (var i = 0; i < all.length && i < 400; i++) { var a = all[i].attributes; for (var j = 0; j < a.length; j++) if (a[j].name.indexOf('data-') === 0) seen[a[j].name] = String(a[j].value).slice(0, 24); } } catch (e) {}
        return seen;
      })(),
    };
  });
  out.calendar = calMap;
  console.log('  calendar node: ' + JSON.stringify(calMap && calMap.node));
  console.log('  data-* attributes seen inside: ' + JSON.stringify(calMap && calMap.dataAttrs));
  console.log('  controls inside the calendar:');
  ((calMap && calMap.items) || []).slice(0, 60).forEach((c) => console.log('    ' + JSON.stringify(c)));
  await guard('after calendar open');

  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log('\n  wrote ' + OUT); }
  await browser.close();
})().catch((e) => { console.error('PROBE FAILED: ' + e.message); process.exit(1); });
