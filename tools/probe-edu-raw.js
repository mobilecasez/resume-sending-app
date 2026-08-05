// RAW DOM PROBE — what the Education row's University/Major/Degree control ACTUALLY is.
//
//   node tools/probe-edu-raw.js [--col University] [--url <apply url>]
//
// probe-edu-pickers.js reported "popup: yes, options: 0" for all three columns, using OUR helpers.
// That is either the truth (a remote list that never loads) or our helpers looking at the wrong
// node. This probe uses NO helpers: it snapshots the document, clicks the trigger, and diffs — so
// whatever appears is described exactly as the page built it.
//
// ⚠️ NEVER SUBMIT — same shield, asserted at the end.
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
const TYPE = arg('type', 'C-DAC');
const head = (s) => console.log('\n' + '='.repeat(96) + '\n' + s + '\n' + '='.repeat(96));

const SHIELD = `
  window.__submits = []; window.__posts = [];
  document.addEventListener('submit', function(e){ e.preventDefault(); e.stopImmediatePropagation(); window.__submits.push('event'); }, true);
  HTMLFormElement.prototype.submit = function(){ window.__submits.push('proto'); };
  HTMLFormElement.prototype.requestSubmit = function(){ window.__submits.push('requestSubmit'); };
  document.addEventListener('DOMContentLoaded', function(){ document.querySelectorAll('button[type=submit],input[type=submit]').forEach(function(b){ b.disabled=true; }); });
`;

const HELPERS = `(function(){
  ${JS_HELPERS}
  window.__eng = { ctrls:ctrls, nlbl:nlbl, cbShown:cbShown, cbText:cbText, setNative:setNative };
  window.__all = function(){
    var out=[], seen=new Set();
    (function walk(root){
      var it; try{ it = root.querySelectorAll('*'); }catch(e){ return; }
      for(var i=0;i<it.length;i++){ var n=it[i]; if(seen.has(n)) continue; seen.add(n); out.push(n); if(n.shadowRoot) walk(n.shadowRoot); }
    })(document);
    return out;
  };
  window.__vis = function(el){ try{ var r=el.getBoundingClientRect(); if(r.width<1||r.height<1) return false; var s=getComputedStyle(el); return s.visibility!=='hidden' && s.display!=='none' && s.opacity!=='0'; }catch(e){ return false; } };
  window.__desc = function(n){
    var o = { tag:n.tagName.toLowerCase() };
    try{ if(n.getAttribute('role')) o.role=n.getAttribute('role'); }catch(e){}
    try{ if(n.getAttribute('type')) o.type=n.getAttribute('type'); }catch(e){}
    try{ if(n.id) o.id=String(n.id).slice(0,30); }catch(e){}
    try{ if(n.className && typeof n.className==='string') o.cls=n.className.slice(0,60); }catch(e){}
    try{ o.text=(n.textContent||'').replace(/\\s+/g,' ').trim().slice(0,70); }catch(e){}
    try{ if(n.value!==undefined && n.value!=='') o.value=String(n.value).slice(0,40); }catch(e){}
    try{ o.vis=window.__vis(n); }catch(e){}
    return o;
  };
  window.__snap = function(){ var s=new Set(); var a=window.__all(); for(var i=0;i<a.length;i++) s.add(a[i]); return s; };
  window.__diff = function(before){
    var a=window.__all(), out=[];
    for(var i=0;i<a.length;i++){ if(!before.has(a[i]) && window.__vis(a[i])) out.push(a[i]); }
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
  await sleep(4500);
  await page.evaluate(HELPERS);

  head('OPEN THE EDUCATION ROW');
  const opened = await page.evaluate(() => {
    // The button is just called "Add" — twice. Which repeater it belongs to is only knowable from
    // the REGION around it, so walk up until an ancestor's own wording names the section.
    const btns = window.__all().filter((b) => /^(button|a)$/i.test(b.tagName) && window.__vis(b));
    const region = (b) => {
      let n = b.parentElement;
      for (let h = 0; n && h < 6; h++) {
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length > 20) return t.slice(0, 120);
        n = n.parentElement;
      }
      return '';
    };
    let hit = null;
    for (const b of btns) {
      const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^add$/i.test(t) && !/add/i.test(t)) continue;
      if (/educat|universit|school/i.test(region(b))) { hit = b; break; }
    }
    if (!hit) return { clicked: false, seen: btns.filter((b) => /add/i.test(b.textContent || '')).map((b) => region(b).slice(0, 60)) };
    hit.scrollIntoView({ block: 'center' });
    hit.click();
    return { clicked: true, text: (hit.textContent || '').trim().slice(0, 30) };
  });
  console.log('  ' + JSON.stringify(opened).slice(0, 500));
  await sleep(2500);

  head('THE ' + COL + ' TRIGGER, AS THE PAGE BUILT IT');
  const trig = await page.evaluate((col) => {
    const re = new RegExp(col, 'i');
    const all = window.__eng.ctrls().filter((e) => (e.type || '').toLowerCase() !== 'search');
    let el = null;
    for (const n of all) if (re.test(window.__eng.nlbl(n))) { el = n; break; }
    if (!el) return { found: false, saw: all.map((n) => window.__eng.nlbl(n).slice(0, 24)) };
    window.__t = el;
    const attrs = {}; for (const a of el.attributes) attrs[a.name] = String(a.value).slice(0, 70);
    return {
      found: true, desc: window.__desc(el), attrs,
      label: window.__eng.nlbl(el).slice(0, 40),
      outer: el.outerHTML.slice(0, 400),
      parentHTML: el.parentElement ? el.parentElement.outerHTML.slice(0, 700) : null,
      reactProps: (() => { const o = {}; for (const k in el) { if (k.indexOf('__reactProps$') === 0) { const p = el[k]; for (const kk of Object.keys(p)) { const v = p[kk]; o[kk] = typeof v === 'function' ? 'fn' : String(v).slice(0, 40); } } } return o; })(),
    };
  }, COL);
  console.log(JSON.stringify(trig, null, 1).slice(0, 2000));

  head('WHAT APPEARS WHEN IT IS CLICKED');
  const appeared = await page.evaluate(() => {
    window.__before = window.__snap();
    window.__t.scrollIntoView({ block: 'center' });
    window.__t.click();
    return true;
  });
  await sleep(2000);
  const news = await page.evaluate(() => {
    const nodes = window.__diff(window.__before);
    // top-level roots only: a node whose parent is also new is just a child of the same popup
    const set = new Set(nodes);
    const roots = nodes.filter((n) => !set.has(n.parentElement));
    return {
      total: nodes.length,
      roots: roots.map((r) => ({ desc: window.__desc(r), html: r.outerHTML.slice(0, 1200) })),
      listish: nodes.filter((n) => /^(li|option)$/i.test(n.tagName) || ['option', 'listbox', 'menuitem', 'row'].includes(n.getAttribute('role') || ''))
        .slice(0, 12).map((n) => window.__desc(n)),
      inputs: nodes.filter((n) => /^(input|textarea)$/i.test(n.tagName)).map((n) => window.__desc(n)),
    };
  });
  console.log('  new visible nodes: ' + news.total);
  console.log('  ROOTS:'); for (const r of news.roots.slice(0, 4)) console.log('    ' + JSON.stringify(r.desc) + '\n      html: ' + r.html.replace(/\s+/g, ' ').slice(0, 700));
  console.log('  list-ish nodes: ' + JSON.stringify(news.listish).slice(0, 700));
  console.log('  inputs that appeared: ' + JSON.stringify(news.inputs).slice(0, 600));

  head('AND WHEN "' + TYPE + '" IS TYPED INTO WHATEVER APPEARED');
  const typed = await page.evaluate(async (q) => {
    const nodes = window.__diff(window.__before);
    const box = nodes.find((n) => /^(input|textarea)$/i.test(n.tagName) && !n.disabled) || window.__t;
    box.focus();
    const proto = box.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(box, q);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return { into: window.__desc(box) };
  }, TYPE);
  console.log('  typed into: ' + JSON.stringify(typed.into));
  await sleep(2200);
  const after = await page.evaluate(() => {
    const nodes = window.__diff(window.__before);
    return {
      total: nodes.length,
      listish: nodes.filter((n) => /^(li|option)$/i.test(n.tagName) || ['option', 'listbox', 'menuitem', 'row'].includes(n.getAttribute('role') || ''))
        .slice(0, 15).map((n) => window.__desc(n)),
      clickables: nodes.filter((n) => window.__vis(n) && (n.tagName === 'LI' || n.getAttribute('role') === 'option'
        || (n.tagName === 'DIV' && (n.textContent || '').trim().length > 1 && (n.textContent || '').trim().length < 60 && n.children.length === 0)))
        .slice(0, 15).map((n) => window.__desc(n)),
      submits: window.__submits.slice(),
    };
  });
  console.log('  new visible nodes now: ' + after.total);
  console.log('  list-ish: ' + JSON.stringify(after.listish).slice(0, 900));
  console.log('  leaf clickables: ' + JSON.stringify(after.clickables).slice(0, 1200));
  console.log('\n  SUBMITS: ' + JSON.stringify(after.submits));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
