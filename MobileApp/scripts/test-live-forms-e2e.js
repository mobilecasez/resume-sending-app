// END-TO-END AUTO FILL — all four legs, for real, in one run. The sibling of test-live-forms.js.
//
//   node MobileApp/scripts/test-live-forms-e2e.js [--user 1] [--variant fresh] [--json out.json]
//
// WHY THIS EXISTS, AND WHY IT LIVES HERE. test-live-forms.js asserted "the dial picker shows +91"
// and PASSED for weeks while the same action on a real phone left +44. It passed because it
// HAND-BUILDS the values object:  runFill({ [DIAL_KEY]: '+91', [NUM_KEY]: '9970020596' }).  That
// proves the ENGINE can set a field when handed a perfect value. It proves nothing about whether
// the value is ever PRODUCED — and the bug was entirely in the producing. A synthetic assertion
// must never again be the only thing standing between us and a user-visible failure, so the real
// path now has a test that lives beside the synthetic one and is run with it.
//
// The real path has three legs, and this runs all three plus a fourth that needs no network:
//   LEG 0  the SERVER'S OWN classifier, called directly on the fields the scan just produced
//   LEG 1  the real READ_FIELDS_JS on the real page
//   LEG 2  those exact scanned fields POSTed to the real production endpoint as a real user,
//          with the app's own __async + /job-status polling, not a plain sync POST
//   LEG 3  the server's unedited response fed into the real fillJs, then the DOM read back
//
// VARIANTS (--variant):
//   fresh          a page nobody has touched
//   touched        the app's own FOCUS_DETECT_JS installed and the person taps the dial picker once
//   nooptions      BUILD 144 ON A SLOW PHONE: the dial dropdown did not enumerate AND the build
//                  predates the isPhoneCode hint. This is the shape on the user's actual phone.
//   nooptions-flag the same lost option list, on a build that DOES send isPhoneCode
//
// ⚠️ TWO HARD RULES — these are strangers' live application forms.
//   1. NEVER SUBMIT. Submit is neutralised on five layers BEFORE anything is touched, and every
//      phase asserts zero submit attempts afterwards. Filling sends nothing; submitting applies
//      for a job in someone else's name.
//   2. The profile data is the REAL account's (that is the whole point — a synthetic +31 would not
//      reproduce a +91 bug), but it is only ever TYPED INTO the page, never sent anywhere.
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..', '..');
// ⚠️ THE USER IS NOT ON HEAD, AND "--variant nooptions" DOES NOT PUT THEM THERE. That variant
// reshapes the PAYLOAD to build 144's shape and then fills with the WORKING TREE's engine — so it
// answers "will the next build work", not "does the phone in their hand work today". The client
// half of the answer lives in whichever job-detail.tsx was compiled into the build they have:
//   node MobileApp/scripts/test-live-forms-e2e.js --client /tmp/job-detail-b144.tsx
// (extract it with: git show 35c859e:MobileApp/app/\(ai-hub\)/job-detail.tsx > /tmp/job-detail-b144.tsx)
// Both the SCAN and the FILL then come from that build, which is the only way a server-side fix can
// be shown to reach a user who cannot upgrade.
const CLIENT_SRC = (() => {
    const i = process.argv.indexOf('--client');
    return i >= 0 ? process.argv[i + 1] : path.join(REPO, 'MobileApp', 'app', '(ai-hub)', 'job-detail.tsx');
})();
const SRC = fs.readFileSync(CLIENT_SRC, 'utf8');
const raw = (n) => { const m = SRC.match(new RegExp('(?:export )?const ' + n + ' = `([\\s\\S]*?)`;\\n')); if (!m) throw new Error('no ' + n); return m[1]; };
const rawFn = (n) => { const m = SRC.match(new RegExp('function ' + n + '\\([^)]*\\)[^{]*\\{[\\s\\S]*?return `([\\s\\S]*?)`;\\s*\\}')); if (!m) throw new Error('no fn ' + n); return m[1]; };
const JS_HELPERS = new Function('JS_HELPERS', 'return `' + raw('JS_HELPERS') + '`;')('');
const READ_FIELDS_JS = new Function('JS_HELPERS', 'return `' + raw('READ_FIELDS_JS') + '`;')(JS_HELPERS);
const FILL_BODY = rawFn('fillJs');
const fillJsFor = (values) => new Function('JS_HELPERS', 'values', 'return `' + FILL_BODY + '`;')(JS_HELPERS, values);
// ⚠️ THE APP INSTALLS THIS ON EVERY PAGE LOAD (WebView injectedJavaScript, job-detail.tsx ~5970) and
// no harness ever did. It marks __cvfTouched on any control the PERSON operated — and cbAnswered()
// treats a touched country/dial control as already answered, which makes enumCombos SKIP it.
const FOCUS_DETECT_JS = new Function('JS_HELPERS', 'return `' + raw('FOCUS_DETECT_JS') + '`;')(JS_HELPERS);

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const API = process.env.AUTOFILL_TEST_API || 'https://cvapplyr-website-production.up.railway.app';
const USER = Number(arg('user', '1'));
const URL = arg('url', 'https://www.revolut.com/careers/apply/4ee78ed3-1222-4265-aca8-d6f147f7d15a/');
const OUT = arg('json', null);
const VARIANT = arg('variant', 'fresh');
const CPU = Number(arg('cpu', '1'));   // Chromium CPU throttling — a real iPhone is not a Mac
// The server's OWN exported classifier, called on the fields the scan produces. No network, no
// model, no mocks: this is the function that decides whether a dial value exists at all, and the
// only reason the dial bug survived four fixes is that nothing ever called it with a real field.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test@localhost:5432/test';
let SRVCLF = null;
try {
  const c = require(path.join(REPO, 'server', 'controllers', 'aiHubController.js'));
  if (typeof c.isPhoneCodeField === 'function') SRVCLF = c;
} catch (e) { console.log('  (server classifier not loadable here: ' + e.message + ')'); }

let pass = 0, fail = 0;
const record = [];
const ok = (n, c, extra) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 300) : '')); } record.push({ ok: !!c, name: n, extra }); };
const head = (s) => console.log('\n' + '='.repeat(96) + '\n' + s + '\n' + '='.repeat(96));

// ── Leg 2, byte-for-byte what the app does (job-detail.tsx postAndPoll + pollJobResult) ──────────
async function postAndPoll(pathname, body, token) {
  const t0 = Date.now();
  const r = await fetch(API + '/api' + pathname, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(body || {}), __async: true }),
  });
  const data = await r.json().catch(() => ({}));
  if (data && data.jobId) {
    for (let i = 0; i < 150; i++) {
      await new Promise((s) => setTimeout(s, 2000));
      const p = await fetch(API + '/api/ai-hub/job-status/' + data.jobId, { headers: { Authorization: 'Bearer ' + token } });
      const d = await p.json().catch(() => ({}));
      if (d.status === 'completed') { console.log('    (async job completed in ' + (Date.now() - t0) + 'ms)'); return d.data; }
      if (d.status === 'failed') throw new Error(d.error || 'Job failed');
      if (!p.ok) throw new Error(d.error || 'Request failed (' + p.status + ')');
    }
    throw new Error('poll timed out');
  }
  if (!r.ok) throw new Error((data && data.error) || 'Request failed (' + r.status + ')');
  console.log('    (sync response in ' + (Date.now() - t0) + 'ms)');
  return data;
}

// ── The five-layer submit shield + the ReactNativeWebView capture shim the scan posts through ────
const SHIELD = `
  window.__submits = []; window.__posts = [];
  document.addEventListener('submit', function(e){ e.preventDefault(); e.stopImmediatePropagation(); window.__submits.push('event'); }, true);
  HTMLFormElement.prototype.submit = function(){ window.__submits.push('proto'); };
  HTMLFormElement.prototype.requestSubmit = function(){ window.__submits.push('requestSubmit'); };
  (function(){ var of=window.fetch; window.fetch=function(u,o){ if(o&&/post|put/i.test((o&&o.method)||'')){ window.__posts.push(String(u).slice(0,60)); return Promise.reject(new Error('blocked')); } return of.apply(this,arguments); };
    var oo=XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open=function(m,u){ if(/post|put/i.test(m||'')){ window.__posts.push(String(u).slice(0,60)); throw new Error('blocked'); } return oo.apply(this,arguments); }; })();
  document.querySelectorAll('button[type=submit],input[type=submit]').forEach(function(b){ b.disabled=true; });
  window.__msgs = [];
  window.ReactNativeWebView = { postMessage: function(s){ try{ window.__msgs.push(JSON.parse(s)); }catch(e){} } };
`;

// The engine's OWN popup detector, exposed so a census counts what the engine counts — plus a
// continuous watcher, because "open popups" is a question about the WHOLE run, not its last frame.
const PROBE = `(function(){
  ${JS_HELPERS}
  window.__cvf = { nlbl:nlbl, cbShown:cbShown, cbAnswered:cbAnswered, vis:vis, deepQuery:deepQuery,
                   cbLooksLikeList:cbLooksLikeList, cbPopupOk:cbPopupOk, isCombo:isCombo };
  window.__census = function(){
    var out = [], seen = [];
    try {
      var ns = deepQuery('[role=listbox],[role=menu],[role=grid],[class*=menu],[class*=dropdown],[class*=listbox],[class*=ScrollContent],[class*=Sheet],[class*=sheet],[class*=Drawer],[class*=drawer],[class*=Popover],[class*=popover],[class*=Picker],[class*=picker],[class*=Portal],[class*=portal],[class*=Overlay],[class*=overlay],[class*=Modal]');
      for (var i=0;i<ns.length && i<400;i++){
        var n = ns[i];
        if (!vis(n) || !cbLooksLikeList(n)) continue;
        var dupe = false;
        for (var j=0;j<seen.length;j++){ if (seen[j].contains(n) || n.contains(seen[j])) { dupe = true; break; } }
        if (dupe) continue;
        seen.push(n);
        // A repeater ROW is portal-rendered and therefore popup-SHAPED, but it is not a stray
        // dropdown: it is the applicant's own half-finished entry, deliberately kept and named
        // back to them. Counting FIELDS is what tells the two apart — an option sheet has at most
        // its own search box.
        out.push({ cls: String((n.className && n.className.baseVal) || n.className || '').slice(0,50),
                   rows: n.querySelectorAll('button,li,[role=option]').length,
                   inputs: n.querySelectorAll('input:not([type=search]),select,textarea').length,
                   text: String(n.innerText||'').replace(/\\s+/g,' ').slice(0,60) });
      }
    } catch(e){}
    var sb = 0; try { sb = document.querySelectorAll('input[type=search]').length; } catch(e){}
    return { popups: out, searchBoxes: sb };
  };
  window.__watch = { peak: 0, peakSearch: 0, samples: 0 };
  setInterval(function(){
    try {
      var c = window.__census();
      window.__watch.samples++;
      if (c.popups.length > window.__watch.peak) window.__watch.peak = c.popups.length;
      if (c.searchBoxes > window.__watch.peakSearch) window.__watch.peakSearch = c.searchBoxes;
    } catch(e){}
  }, 200);
})(); true;`;

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing — cannot act as a real user'); process.exit(1); }
  const token = jwt.sign({ id: USER, email: 'harness@local' }, process.env.JWT_SECRET);
  console.log('E2E AUTO FILL — user ' + USER + '  ·  ' + API + '\n  page: ' + URL
    + '\n  client: ' + CLIENT_SRC + (CLIENT_SRC.indexOf(REPO) === 0 ? '  (working tree)' : '  ⚠️ NOT THE WORKING TREE'));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  if (CPU > 1) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    console.log('  CPU throttled ' + CPU + 'x (a real phone is not a Mac)');
  }
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(9000);
  await page.evaluate(SHIELD);
  await page.evaluate(PROBE);

  const submits = () => page.evaluate(() => ({ s: window.__submits.slice(), p: window.__posts.slice() }));
  const censusNow = () => page.evaluate(() => ({ now: window.__census(), watch: window.__watch }));
  const resetWatch = () => page.evaluate(() => { window.__watch.peak = 0; window.__watch.peakSearch = 0; window.__watch.samples = 0; });

  const phase0 = await censusNow();
  console.log('  popups open BEFORE anything: ' + phase0.now.popups.length + ' (search boxes ' + phase0.now.searchBoxes + ')');

  // ══ VARIANT "touched" — the app's page-load script + one REAL human tap ═══════════════════
  if (VARIANT === 'touched') {
    head('SETUP — the app\'s own FOCUS_DETECT_JS is installed, and the person taps the dial picker once');
    await page.evaluate(FOCUS_DETECT_JS + '\ntrue;');
    // The form hydrates late; wait for the control rather than assuming it is there.
    await page.waitForFunction(() => [...document.querySelectorAll('input[type=button]')]
      .some((e) => e.getBoundingClientRect().width && /phone country|country code|dial/i.test(window.__cvf.nlbl(e))), null, { timeout: 60000 })
      .catch(() => {});
    console.log('  visible input[type=button] labels: ' + JSON.stringify(await page.evaluate(() =>
      [...document.querySelectorAll('input[type=button]')].filter((e) => e.getBoundingClientRect().width).map((e) => window.__cvf.nlbl(e).slice(0, 30)))));
    const box = await page.evaluate(() => {
      const b = [...document.querySelectorAll('input[type=button]')].filter((e) => e.getBoundingClientRect().width);
      const t = b.find((e) => /phone country|country code|dial/i.test(window.__cvf.nlbl(e)));
      if (!t) return null;
      t.scrollIntoView({ block: 'center' });
      const r = t.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!box) { console.log('  no dial trigger found — cannot run this variant'); process.exit(1); }
    // A REAL mouse click through the browser: isTrusted === true, which is the only thing
    // FOCUS_DETECT_JS marks on. A page.evaluate() click would be isTrusted:false and mark nothing.
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(1500);
    // ...and the person closes the sheet again, by hand, the way anyone would.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    const closeBtn = await page.$('button[aria-label*="lose" i], button[aria-label*="ismiss" i], [role=button][aria-label*="lose" i]');
    if (closeBtn) await closeBtn.click().catch(() => {});
    await page.waitForTimeout(1200);
    const t = await page.evaluate(() => {
      const b = [...document.querySelectorAll('input[type=button]')].filter((e) => e.getBoundingClientRect().width);
      const d = b.find((e) => /phone country|country code|dial/i.test(window.__cvf.nlbl(e)));
      return { touched: !!(d && d.__cvfTouched), shows: d ? window.__cvf.cbShown(d) : null, answered: d ? window.__cvf.cbAnswered(d) : null };
    });
    const afterTap = await censusNow();
    console.log('  after ONE human tap:  __cvfTouched=' + t.touched + '  cbShown=' + JSON.stringify(t.shows) + '  cbAnswered=' + t.answered);
    console.log('  POPUPS after the tap+dismiss: ' + afterTap.now.popups.length);
    // ⚠️ THE PREMISE OF THIS VARIANT CANNOT ALWAYS BE ESTABLISHED. FOCUS_DETECT_JS marks the
    // element the event REACHED, and this employer's design system puts an overlay in front of its
    // trigger — so a real trusted click lands on the overlay and the input is never marked. That is
    // a fact about the harness's reach on this page, not a result: asserting it would leave two
    // permanently red lines that mean nothing. It is said out loud and the run continues, because
    // the rest of the variant (a page a person has already interacted with) is still exercised.
    if (t.touched === true) {
      ok('the human tap is recorded as __cvfTouched (this is what the app does on device)', t.touched === true, t);
      ok('a TOUCHED dial picker now reads as ALREADY ANSWERED (+44 becomes "their answer")', t.answered === true, t);
    } else {
      console.log('  NOT ESTABLISHED: the trusted click did not reach the input (overlay), so the');
      console.log('                   "already touched" premise is untested here — not passed, not failed.');
    }
  }

  // ══ LEG 1 — the REAL scan ══════════════════════════════════════════════════════════════════
  head('LEG 1 — SCAN (the real READ_FIELDS_JS on the real page)');
  await resetWatch();
  const tScan = Date.now();
  await page.evaluate(READ_FIELDS_JS);
  await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FIELDS'), null, { timeout: 180000 });
  const fields = await page.evaluate(() => window.__msgs.find((m) => m.type === 'FIELDS').fields);
  console.log('  scan finished in ' + (Date.now() - tScan) + 'ms, ' + fields.length + ' fields');
  for (const f of fields) {
    console.log('    ' + String(f.key).slice(0, 72).padEnd(74) + (f.widget || f.type || '').padEnd(14)
      + (f.options ? '[' + f.options.length + (f.optionsTruncated ? ' PARTIAL' : '') + (f.optionsUnknown ? ' UNKNOWN' : '') + '] ' : '')
      + String(f.label || '').replace(/\s+/g, ' ').slice(0, 46));
  }
  const afterScan = await censusNow();
  const scanSubmits = await submits();
  console.log('  POPUPS after scan: ' + afterScan.now.popups.length + '  (peak DURING scan: ' + afterScan.watch.peak + ', peak search boxes: ' + afterScan.watch.peakSearch + ')');
  if (afterScan.now.popups.length) console.log('    left open: ' + JSON.stringify(afterScan.now.popups));
  ok('THE FORM WAS NEVER SUBMITTED (scan)', scanSubmits.s.length === 0, scanSubmits);
  ok('the scan leaves no popup open', afterScan.now.popups.length === 0, afterScan.now.popups);
  ok('the scan never has two popups open at once', afterScan.watch.peak <= 1, afterScan.watch.peak);

  // Model the ONE thing a slow phone loses: enumCombos gives a widget 2200ms to render its sheet
  // and skips any control cbAnswered() calls already answered. Either way the field reaches the
  // server exactly as the scan first built it — combobox, optionsUnknown, no options.
  if (VARIANT === 'nooptions' || VARIANT === 'nooptions-flag') {
    head('MUTATION — the dial dropdown did not enumerate (2.2s sheet timeout, or cbAnswered skipped it)'
      + (VARIANT === 'nooptions' ? '\nAND the build is 144, which does not send the isPhoneCode hint' : ''));
    const d = fields.find((f) => /phone country|country code|dial/i.test(f.label || ''));
    if (!d) { console.log('  no dial field'); process.exit(1); }
    console.log('  before: options=' + (d.options || []).length + ' truncated=' + !!d.optionsTruncated
      + ' unknown=' + !!d.optionsUnknown + ' isPhoneCode=' + !!d.isPhoneCode);
    delete d.options; delete d.optionsTruncated; d.optionsUnknown = true;
    // ⚠️ BUILD 144 IS WHAT THE USER IS HOLDING. It predates the isPhoneCode hint, so leaving the
    // hint in would prove the NEXT build works and say nothing about the phone in their hand.
    if (VARIANT === 'nooptions') delete d.isPhoneCode;
    console.log('  after : ' + JSON.stringify(d));
  }

  // ══ LEG 0 — the server's own classifier, on the fields the scan just made ══════════════════
  // No network. This is the function whose answer decides whether a dial value can exist, and it
  // is asserted on the REAL field shape rather than on anything written by hand.
  if (SRVCLF) {
    head('LEG 0 — CLASSIFY (the server\'s exported isPhoneCodeField / isPhoneNumberField, no network)');
    const nonFile = fields.filter((f) => f && f.key && String(f.type || '').toLowerCase() !== 'file');
    const codeF = nonFile.filter(SRVCLF.isPhoneCodeField).map((f) => f.key);
    const numF = nonFile.filter(SRVCLF.isPhoneNumberField).map((f) => f.key);
    console.log('  dial fields   : ' + JSON.stringify(codeF));
    console.log('  number fields : ' + JSON.stringify(numF));
    const dk = (fields.find((f) => /phone country|country code|dial/i.test(f.label || '')) || {}).key;
    ok('the server RECOGNISES the dial picker in the shape the scan actually sends it',
      !!dk && codeF.indexOf(dk) >= 0, { dialKey: dk, codeF });
    ok('and does NOT also hand the same picker to the phone-NUMBER pass', !dk || numF.indexOf(dk) < 0, { dialKey: dk, numF });
    ok('the two filters never claim the same field', codeF.every((k) => numF.indexOf(k) < 0), { codeF, numF });
    // The residence question sits one position from the phone box on this page. Claiming it would
    // write "+91" into "Current country" — a worse bug than the one being fixed.
    const ck = (fields.find((f) => /^current country$/i.test((f.label || '').trim())) || {}).key;
    if (ck) ok('"Current country" is NOT claimed as a dial control', codeF.indexOf(ck) < 0, { countryKey: ck, codeF });
    // And the same field with its options stripped must still classify — this is the regression
    // that four separate fixes missed, so it is asserted on every run, in every variant.
    if (dk) {
      const bare = fields.map((f) => (f.key === dk ? Object.assign({}, f, { options: undefined, optionsTruncated: undefined, optionsUnknown: true, isPhoneCode: undefined }) : f))
        .filter((f) => String(f.type || '').toLowerCase() !== 'file');
      const bareCode = bare.filter(SRVCLF.isPhoneCodeField).map((f) => f.key);
      const bareNum = bare.filter(SRVCLF.isPhoneNumberField).map((f) => f.key);
      ok('WITH NO OPTION LIST AND NO CLIENT HINT the dial picker is still a dial picker', bareCode.indexOf(dk) >= 0, { bareCode });
      ok('...and is still not mistaken for the phone number field', bareNum.indexOf(dk) < 0, { bareNum });
    }
  }

  // ══ LEG 2 — the REAL server, on the REAL scanned payload ═══════════════════════════════════
  head('LEG 2 — MAP (the real production endpoint, the real scanned fields, as user ' + USER + ')');
  const data = await postAndPoll('/ai-hub/autofill-map', {
    fields, coverLetterHtml: '', jobTitle: 'Legal Counsel (Loyalty)', companyName: 'Revolut',
  }, token).catch((e) => { console.log('  MAP FAILED: ' + e.message); return null; });
  const values = (data && data.values) || {};
  const skipMap = {};
  for (const s of (Array.isArray(data && data.skipped) ? data.skipped : [])) skipMap[s.key] = s.why;
  console.log('  server answered ' + Object.keys(values).length + '/' + fields.length + ' fields'
    + (data && data.warning ? '  (warning: ' + data.warning + ')' : ''));
  for (const f of fields) {
    const got = values[f.key];
    console.log('    ' + (got !== undefined ? 'FILLED' : (skipMap[f.key] ? 'skip  ' : '  --  ')) + '  '
      + String(f.label || '').replace(/\s+/g, ' ').slice(0, 46).padEnd(48)
      + (got !== undefined ? JSON.stringify(got).slice(0, 130) : (skipMap[f.key] || '')));
  }

  // KEY MATCHING — the thing the old harness could never get wrong, because it typed the keys itself.
  const answered = Object.keys(values);
  const scanKeys = fields.map((f) => f.key);
  const orphans = answered.filter((k) => scanKeys.indexOf(k) < 0);
  console.log('\n  KEY MATCH: ' + (answered.length - orphans.length) + '/' + answered.length + ' answered keys exist in the scan');
  if (orphans.length) console.log('    ORPHAN KEYS (server answered a key the page does not have): ' + JSON.stringify(orphans));
  ok('every key the server answers is a key the scan emitted', orphans.length === 0, orphans);

  const dialF = fields.find((f) => /phone country|country code|dial/i.test(f.label || ''));
  const telF = fields.find((f) => String(f.type).toLowerCase() === 'tel');
  console.log('\n  DIAL FIELD');
  console.log('    scan emits key : ' + (dialF ? dialF.key : '(no dial field found in scan!)'));
  console.log('    scan label     : ' + (dialF ? dialF.label : '-'));
  console.log('    scan options   : ' + (dialF && dialF.options ? dialF.options.length + (dialF.optionsTruncated ? ' (PARTIAL)' : ' (complete)') : 'none') + '  ' + JSON.stringify((dialF && dialF.options || []).slice(0, 6)));
  console.log('    server answers : ' + (dialF ? JSON.stringify(values[dialF.key]) : '-') + (dialF && skipMap[dialF.key] ? '   skipped: ' + skipMap[dialF.key] : ''));
  console.log('    number field   : key=' + (telF ? telF.key : '-') + '  server answers ' + (telF ? JSON.stringify(values[telF.key]) : '-'));
  ok('the scan produced a dial-code field at all', !!dialF, fields.map((f) => f.label));
  ok('the server returns a dial value for the dial field', !!dialF && values[dialF.key] !== undefined, { skipped: dialF && skipMap[dialF.key] });
  ok('the number field gets a value', !!telF && values[telF.key] !== undefined, { skipped: telF && skipMap[telF.key] });

  const reps = fields.filter((f) => f.widget === 'repeater');
  console.log('\n  REPEATERS');
  for (const r of reps) console.log('    ' + r.key.slice(0, 60).padEnd(62) + ' -> ' + JSON.stringify(values[r.key] || skipMap[r.key] || '(nothing)').slice(0, 260));

  // ══ LEG 3 — the REAL response into the REAL fill ═══════════════════════════════════════════
  head('LEG 3 — FILL (the server\'s own response, unedited, into fillJs)');
  await resetWatch();
  const tFill = Date.now();
  await page.evaluate(fillJsFor(values));
  let filledTimeout = false;
  await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 300000 })
    .catch(() => { filledTimeout = true; });
  console.log('  fill ' + (filledTimeout ? 'NEVER REPORTED (timed out)' : 'reported in ' + (Date.now() - tFill) + 'ms'));

  const dom = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('input[type=button]')].filter((e) => e.getBoundingClientRect().width);
    const trig = btns.find((e) => /phone country|country code|dial/i.test(window.__cvf.nlbl(e)));
    const tel = [...document.querySelectorAll('input')].find((i) => (i.type || '').toLowerCase() === 'tel');
    return {
      dialShows: trig ? window.__cvf.cbShown(trig) : null,
      dialRaw: trig ? trig.value : null,
      phone: tel ? tel.value : null,
      report: window.__msgs.filter((m) => m.type === 'FILLED').pop(),
      errors: window.__msgs.filter((m) => m.type === 'AUTOFILL_ERROR'),
      submits: window.__submits.slice(),
      posts: window.__posts.slice(),
    };
  });
  const afterFill = await censusNow();

  console.log('\n  WHAT THE PAGE NOW HOLDS');
  console.log('    dial picker shows : ' + JSON.stringify(dom.dialShows));
  console.log('    phone number box  : ' + JSON.stringify(dom.phone));
  console.log('    fill report       : ' + JSON.stringify(dom.report).slice(0, 700));
  if (dom.errors.length) console.log('    ERRORS            : ' + JSON.stringify(dom.errors).slice(0, 400));
  console.log('    POPUPS after fill : ' + afterFill.now.popups.length + '  (peak DURING fill: ' + afterFill.watch.peak + ')');
  if (afterFill.now.popups.length) console.log('      left open: ' + JSON.stringify(afterFill.now.popups));

  ok('THE FORM WAS NEVER SUBMITTED (fill)', dom.submits.length === 0, dom.submits);
  ok('the fill actually reported back', !filledTimeout);
  ok('THE DIAL PICKER ENDS UP ON THE USER\'S OWN CODE', /\+?91\b/.test(String(dom.dialShows)), { shows: dom.dialShows, sent: dialF && values[dialF.key] });
  ok('the number box is not left as national digits under a foreign code',
    /\+?91\b/.test(String(dom.dialShows)) || String(dom.phone || '').replace(/[^\d]/g, '').indexOf('91') === 0,
    { dial: dom.dialShows, phone: dom.phone });
  const sheetsOf = (c) => c.popups.filter((p) => (p.inputs || 0) < 2);   // an option sheet, not a row
  ok('the fill leaves no dropdown or sheet open', sheetsOf(afterFill.now).length === 0, sheetsOf(afterFill.now));

  // ── The repeater, measured: what is actually IN the ROW the fill opened? ─────────────────────
  // Read the ROW ITSELF (the portal the repeater renders into), not the host form — the row is
  // exactly the thing left on screen at the end, and the thing the user says "will not save".
  head('REPEATER — what the ROW really contains after the fill');
  const rowDom = await page.evaluate(() => {
    const roots = [];
    const seen = [];
    for (const n of window.__cvf.deepQuery('[class*=Box],[class*=Flex],[role=dialog],[class*=Portal],[class*=Modal]')) {
      if (!window.__cvf.vis(n)) continue;
      const tx = String(n.innerText || '').replace(/\s+/g, ' ');
      if (!/^Add (experience|education)/i.test(tx)) continue;
      if (seen.some((s) => s.contains(n))) continue;    // keep the OUTERMOST match only
      seen.push(n); roots.push(n);
    }
    return roots.map((r) => ({
      heading: String(r.innerText || '').replace(/\s+/g, ' ').slice(0, 90),
      controls: [...r.querySelectorAll('input,select,textarea,button,[role=button]')]
        .filter((c) => { const b = c.getBoundingClientRect(); return b.width || b.height; })
        .map((c) => ({
          tag: c.tagName.toLowerCase(), type: (c.type || '').toLowerCase(),
          label: String(window.__cvf.nlbl(c) || '').replace(/\s+/g, ' ').slice(0, 40),
          placeholder: (c.placeholder || '').slice(0, 24),
          // A checkbox/radio .value is the markup's "on" whether it is ticked or not — printing it
          // as the value made every tick box look ticked. Report the STATE for those.
          // ⚠️ READ IT THE WAY THE ENGINE DOES. A trigger-style picker CLEARS its own .value after
          // a real pick and shows the choice in a separate node, so reading .value reported every
          // successful pick as empty — the harness would have called a working row broken.
          value: /^(checkbox|radio)$/.test((c.type || '').toLowerCase())
            ? (c.checked ? 'CHECKED' : 'unchecked')
            : String((() => { try { return window.__cvf.cbShown(c) || c.value || ''; } catch (e) { return c.value || ''; } })()).slice(0, 34),
          combo: (() => { try { return !!window.__cvf.isCombo(c); } catch (e) { return null; } })(),
          readOnly: !!c.readOnly, disabled: !!c.disabled,
          text: /^(button)$/.test(c.tagName.toLowerCase()) ? String(c.innerText || '').replace(/\s+/g, ' ').slice(0, 26) : '',
        })),
    }));
  });
  const repFailures = ((dom.report && dom.report.failed) || []).filter((f) => String(f.key || '').indexOf('rp:') === 0);
  console.log('  rows still on screen after the fill: ' + rowDom.length);
  console.log('  what the engine said about the repeaters: ' + JSON.stringify(repFailures));
  for (const r of rowDom) {
    console.log('\n  ROW: ' + r.heading);
    for (const c of r.controls) {
      console.log('    ' + (c.tag + '/' + c.type).padEnd(16) + (c.combo ? 'PICKER ' : '       ')
        + (c.readOnly ? 'RO ' : '   ') + (c.disabled ? 'DISABLED ' : '         ')
        + String(c.label || c.text).padEnd(34) + ' = ' + JSON.stringify(c.value));
    }
    const dates = r.controls.filter((c) => /date|from|to|start|end|month|year/i.test(c.label + ' ' + c.placeholder));
    console.log('    -> date columns: ' + dates.length + '  '
      + JSON.stringify(dates.map((d) => ({ label: d.label, tag: d.tag + '/' + d.type, isPicker: d.combo, value: d.value }))));
    // The commit control is read the way the ENGINE reads it — a disabled button in the row that is
    // not one of the row's own fields — so the harness cannot pass by finding a different button.
    const saveish = r.controls.filter((c) => /^(button)$/.test(c.tag) && !/^(cancel|close|back)$/i.test((c.text || '').trim()) && (c.text || '').trim());
    console.log('    -> commit control INSIDE the row: ' + JSON.stringify(saveish.map((s) => ({ text: s.text, disabled: s.disabled }))));
    // A row still on screen is a row the applicant has to finish, so these are the two things that
    // decide whether they can: the dates, and whether the widget will accept the row at all.
    const stillWork = r.controls.some((c) => c.value === 'CHECKED' && /still|current|present/i.test(c.label));
    const stuck = saveish.length > 0 && saveish.every((s) => s.disabled);
    // A row can be genuinely unfinishable — the profile may hold no start date for a course. The
    // guarantee is not "always saved"; it is NEVER SILENT. So a stuck row must be NAMED, and named
    // with every column that is still empty, or the applicant fixes what we listed and is still
    // stuck on what we did not.
    const empties = r.controls
      .filter((c) => c.tag !== 'button' && c.value === '' && c.label && !/optional/i.test(c.label))
      .map((c) => c.label);
    const named = repFailures.map((f) => String(f.why || '')).join(' | ');
    console.log('    -> still empty: ' + JSON.stringify(empties) + (stuck ? '   (COMMIT DISABLED)' : ''));
    ok('every date column in the row got a value (or the row says the role is current, or the row is reported)',
      dates.length === 0 || stillWork || dates.every((d) => d.value !== '') || stuck, dates);
    ok('a row whose commit control is still disabled is REPORTED, not left silently stuck',
      !stuck || repFailures.length > 0, { stuck, repFailures });
    ok('...and every still-empty column in that row is named to the applicant',
      !stuck || empties.every((L) => named.toLowerCase().indexOf(String(L).toLowerCase().slice(0, 18)) >= 0),
      { empties, named });
  }
  // A committed row LEAVES THE SCREEN. If the server sent rows and none is on screen, either the
  // widget absorbed them (good) or nothing was ever opened (bad) — the engine's own report is what
  // tells those apart, so it is asserted rather than inferred from an empty screen.
  const sentRows = reps.filter((r) => Array.isArray(values[r.key]) && values[r.key].length);
  for (const r of sentRows) {
    const failed = repFailures.find((f) => f.key === r.key);
    const filledIt = !!(dom.report && dom.report.count > 0) && (!failed || failed.also);
    console.log('  ' + r.key.slice(0, 46).padEnd(48) + (failed ? 'engine says: ' + failed.why : 'engine reports it filled'));
    ok('the repeater "' + String(r.label || r.key).slice(0, 32) + '" was not abandoned', filledIt, failed);
  }

  // ── DIRECT EVIDENCE THAT THE ROW WAS SAVED ─────────────────────────────────────────────────
  // "The row left the screen" is necessary and NOT sufficient — Cancel removes a row too. The
  // employer's own form has to be showing the entry afterwards, in the applicant's own words.
  const formText = await page.evaluate(() => {
    const f = document.querySelector('form');
    return String((f && f.innerText) || '').replace(/\s+/g, ' ');
  });
  for (const r of sentRows) {
    const failed = repFailures.find((f) => f.key === r.key);
    const first = values[r.key][0] || {};
    const marks = Object.keys(first).map((k) => String(first[k] == null ? '' : first[k])).filter((v) => v.length > 6);
    const present = marks.filter((v) => formText.toLowerCase().indexOf(v.toLowerCase().slice(0, 22)) >= 0);
    console.log('  ' + String(r.key).slice(0, 44).padEnd(46) + 'row values now visible in the FORM: '
      + present.length + '/' + marks.length + '  ' + JSON.stringify(present.slice(0, 2)).slice(0, 120));
    // Only claimed for a repeater the engine reported as complete. One that was reported as needing
    // the applicant is allowed to be unsaved — that is the honest outcome, and it is asserted above.
    if (!failed) ok('the entry is actually IN the form, not just off the screen', present.length > 0, { marks, sample: formText.slice(0, 200) });
  }

  // ── Nothing left on screen for the user to dismiss ──────────────────────────────────────────
  // Measured again after a settle: a widget that closes on an animation frame would otherwise be
  // counted as "left open", and one that resists closing would be counted as closed.
  head('POPUPS — is the page actually left clean?');
  await page.waitForTimeout(1500);
  const settled = await censusNow();
  const strays = sheetsOf(settled.now);
  const rowsLeft = settled.now.popups.filter((p) => (p.inputs || 0) >= 2);
  console.log('  still open 1.5s after the fill reported: ' + strays.length + ' dropdown/sheet, ' + rowsLeft.length + ' repeater row');
  if (strays.length) console.log('    RESISTED: ' + JSON.stringify(strays));
  if (rowsLeft.length) console.log('    ROW KEPT (deliberate): ' + JSON.stringify(rowsLeft.map((p) => p.text)));
  ok('the run leaves NO dropdown or sheet open for the user to dismiss', strays.length === 0, strays);
  ok('and no orphan search box from a sheet that never closed', settled.now.searchBoxes === 0, settled.now.searchBoxes);
  // A row IS allowed to stay — it holds the applicant's entry and cancelling it would throw that
  // away. It is not allowed to stay SILENTLY.
  ok('any row still on screen was named in the report', rowsLeft.length === 0 || repFailures.length > 0,
    { rowsLeft: rowsLeft.map((p) => p.text), repFailures });
  // The engine's own marker must not outlive the run: left behind, the NEXT Auto Fill on this page
  // treats every node containing it as protected and stops closing pickers at all.
  const leftovers = await page.evaluate(() => document.querySelectorAll('[data-cvf-row]').length);
  ok('no data-cvf-row marker is left on the employer\'s DOM', leftovers === 0, leftovers);

  const finalSub = await submits();
  ok('THE FORM WAS NEVER SUBMITTED (whole run)', finalSub.s.length === 0, finalSub);
  console.log('\n  blocked network writes (page analytics etc, NOT an application): ' + finalSub.p.length);

  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify({
      user: USER, url: URL, fields, values, skipped: data && data.skipped, dom, rowDom,
      census: { beforeAll: phase0, afterScan, afterFill }, assertions: record,
    }, null, 2));
    console.log('  wrote ' + OUT);
  }

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS FAILED:', e.stack || e.message); process.exit(1); });
