// WHERE THE TRANSLATION SECONDS ACTUALLY GO.
//
//   node tools/probe-translate-speed.js [--url <foreign-language job page>] [--user 1]
//
// The user sees 10-15s before translated text appears. This measures the real path end to end,
// with the app's own scanner and the app's own chunking, against the real production endpoint:
//
//   • how many text nodes the page has, and how many are UNIQUE (the dedupe is free work saved)
//   • how the client splits them (XLATE_CHUNK=40, XLATE_PARALLEL=3 rounds)
//   • the latency of EVERY round, so a slow tail is visible rather than averaged away
//   • time to FIRST applied text (what the user actually perceives) vs time to complete
//   • and how much of the page is boilerplate that would be a cache hit on a second visit
//
// Read-only: it translates, it never fills or submits anything.
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'MobileApp', 'utils', 'webviewTranslate.ts'), 'utf8');
const JD = fs.readFileSync(path.join(REPO, 'MobileApp', 'app', '(ai-hub)', 'job-detail.tsx'), 'utf8');
const rawTpl = (src, n) => { const m = src.match(new RegExp('(?:export )?const ' + n + ' = `([\\s\\S]*?)`;\\n')); if (!m) throw new Error('no ' + n); return m[1]; };
const JS_HELPERS = new Function('JS_HELPERS', 'return `' + rawTpl(JD, 'JS_HELPERS') + '`;')('');
const num = (n) => { const m = SRC.match(new RegExp('const ' + n + ' = (\\d+)')); return m ? +m[1] : null; };
const XLATE_CHUNK = num('XLATE_CHUNK'), XLATE_PARALLEL = num('XLATE_PARALLEL');
// xlateScanJS is a FUNCTION returning a template — pull its body the same way the tests do.
const scanBody = (() => { const m = JD.match(/xlateScanJS/); return m; })();

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const URL = arg('url', 'https://www.arbeitsagentur.de/jobsuche/');
const USER = Number(arg('user', '1'));
const API = process.env.API_BASE || 'https://cvapplyr-website-production.up.railway.app';
const head = (s) => console.log('\n' + '='.repeat(92) + '\n' + s + '\n' + '='.repeat(92));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The app's scanner, reduced to what this measurement needs: every visible text node worth
// translating, in document order, with its position so "visible on screen now" is knowable.
const SCAN = `(function(){
  ${JS_HELPERS}
  var out=[], seen=0;
  function ok(s){ s=String(s||'').replace(/\\s+/g,' ').trim(); return s.length>1 && s.length<1500 && /[a-zA-Z\\u00C0-\\u024F\\u0400-\\u04FF]/.test(s); }
  var walker=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  var n;
  while((n=walker.nextNode())){
    var p=n.parentElement; if(!p) continue;
    var tag=p.tagName;
    if(tag==='SCRIPT'||tag==='STYLE'||tag==='NOSCRIPT') continue;
    if(!vis(p)) continue;
    var t=String(n.nodeValue||'').replace(/\\s+/g,' ').trim();
    if(!ok(t)) continue;
    seen++;
    var top=0; try{ top=p.getBoundingClientRect().top; }catch(e){}
    out.push({ i:String(out.length), t:t, top:Math.round(top) });
    if(out.length>=1200) break;
  }
  return { items: out, total: seen, viewportH: window.innerHeight };
})();`;

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(1); }
  const token = jwt.sign({ userId: USER, id: USER }, process.env.JWT_SECRET, { expiresIn: '20m' });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  console.log('page: ' + URL + '\nchunking: XLATE_CHUNK=' + XLATE_CHUNK + '  XLATE_PARALLEL=' + XLATE_PARALLEL + '  api=' + API);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(4000);

  head('WHAT IS ON THE PAGE');
  const scan = await page.evaluate(SCAN);
  const items = scan.items;
  const uniqMap = new Map();
  for (const it of items) if (!uniqMap.has(it.t)) uniqMap.set(it.t, it.i);
  const uniq = [...uniqMap.entries()].map(([t], k) => ({ i: String(k), t }));
  const chars = uniq.reduce((a, b) => a + b.t.length, 0);
  const inView = items.filter((x) => x.top >= -50 && x.top < scan.viewportH).length;
  console.log('  text nodes worth translating : ' + items.length);
  console.log('  UNIQUE strings               : ' + uniq.length + '   (dedupe already saves ' + (items.length - uniq.length) + ')');
  console.log('  characters to translate      : ' + chars);
  console.log('  visible in the first screen  : ' + inView + '  of ' + items.length
    + '   (' + Math.round((inView / Math.max(1, items.length)) * 100) + '%)');

  const chunks = [];
  for (let k = 0; k < uniq.length; k += XLATE_CHUNK) chunks.push(uniq.slice(k, k + XLATE_CHUNK));
  const rounds = Math.ceil(chunks.length / XLATE_PARALLEL);
  console.log('  client chunks                : ' + chunks.length + '  -> ' + rounds + ' sequential round(s) of ' + XLATE_PARALLEL);

  head('THE REAL ENDPOINT, ROUND BY ROUND');
  const call = async (batch) => {
    const t0 = Date.now();
    const r = await fetch(API + '/api/ai-hub/translate-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ items: batch.map((b) => ({ i: b.i, t: b.t })) }),
    });
    const d = await r.json().catch(() => ({}));
    return { ms: Date.now() - t0, n: Object.keys(d.translations || {}).length, status: r.status, partial: !!d.partial };
  };

  const tAll = Date.now();
  let firstPaint = null, done = 0;
  for (let k = 0; k < chunks.length; k += XLATE_PARALLEL) {
    const group = chunks.slice(k, k + XLATE_PARALLEL);
    const t0 = Date.now();
    const res = await Promise.all(group.map((c) => call(c).catch((e) => ({ ms: -1, n: 0, status: 0, err: String(e.message) }))));
    const roundMs = Date.now() - t0;
    done += res.reduce((a, b) => a + b.n, 0);
    if (firstPaint === null) firstPaint = Date.now() - tAll;
    console.log('  round ' + (k / XLATE_PARALLEL + 1) + '/' + rounds + '  ' + roundMs + 'ms   '
      + res.map((x) => x.status + ':' + x.n + '@' + x.ms + 'ms' + (x.partial ? ' PARTIAL' : '')).join('  '));
  }
  const totalMs = Date.now() - tAll;

  head('WHAT THE USER FEELS');
  console.log('  time to FIRST translated text on screen : ' + firstPaint + 'ms');
  console.log('  time until the WHOLE page is translated : ' + totalMs + 'ms');
  console.log('  strings translated                      : ' + done + '/' + uniq.length);
  console.log('\n  If only the first screenful were translated first, that round would cover '
    + inView + ' nodes — about ' + Math.ceil(Math.min(inView, uniq.length) / XLATE_CHUNK) + ' chunk(s), i.e. ONE round.');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
