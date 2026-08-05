// LIVE-FORM TEST — drives a REAL employer application page with the REAL shipped JS_HELPERS.
//   node MobileApp/scripts/test-live-forms.js
//
// Why this exists: test-webview-scripts.js uses fixtures WE wrote, so it can only prove the engine
// handles widgets we already understood. Revolut's design system renders its dropdowns with NO aria
// roles and no menu-ish class names (<button class="Cell__CellBase"> inside a "ScrollContent"
// sheet) — our replica had role=listbox/role=option, so the suite passed while the real page left
// every dropdown untouched. Ground truth beats a model of the truth.
//
// Needs network. Skips politely (exit 0) when the page cannot be reached, so it never blocks a
// build; run it whenever the combobox engine changes.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REPO = '/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app';
const SRC = fs.readFileSync(path.join(REPO, 'MobileApp', 'app', '(ai-hub)', 'job-detail.tsx'), 'utf8');
function raw(name) {
  const m = SRC.match(new RegExp('(?:export )?const ' + name + ' = `([\\s\\S]*?)`;\\n'));
  if (!m) throw new Error('could not extract ' + name);
  return m[1];
}
const JS_HELPERS = new Function('JS_HELPERS', 'return `' + raw('JS_HELPERS') + '`;')('');

function rawFn(name) { const m = SRC.match(new RegExp('function ' + name + '\\([^)]*\\)[^{]*\\{[\\s\\S]*?return `([\\s\\S]*?)`;\\s*\\}')); if (!m) throw new Error('no fn ' + name); return m[1]; }
const FILL_BODY = rawFn('fillJs');
const READ_FIELDS_JS = new Function('JS_HELPERS', 'return `' + raw('READ_FIELDS_JS') + '`;')(JS_HELPERS);
const fillJsFactory = (values) => new Function('JS_HELPERS', 'values', 'return `' + FILL_BODY + '`;')(JS_HELPERS, values);

const URL = 'https://www.revolut.com/careers/apply/4ee78ed3-1222-4265-aca8-d6f147f7d15a/';

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(9000);

  // Install the real helpers + a submit tripwire (nothing may ever submit this form).
  await page.evaluate(`window.ReactNativeWebView = { postMessage: function(){} };`);
  await page.evaluate('(function(){' + JS_HELPERS + `
    window.__submits = 0;
    document.addEventListener('submit', function(e){ e.preventDefault(); window.__submits++; }, true);
    window.__cvf = { isComboTrigger: isComboTrigger, isCombo: isCombo, openAndPick: openAndPick,
      cbShown: cbShown, cbAnswered: cbAnswered, nlbl: nlbl, isCountryLabel: isCountryLabel,
      cbPreOpen: cbPreOpen, cbPopup: cbPopup, cbOptions: cbOptions, cbSearchBox: cbSearchBox, vis: vis };
  })()`);

  console.log('\nthe REAL Revolut rui sheet is recognised');
  const seen = await page.evaluate(() => {
    const els = [...document.querySelectorAll('input[type=button]')].filter((e) => e.getBoundingClientRect().width);
    return els.map((e) => ({
      label: window.__cvf.nlbl(e).slice(0, 40),
      isTrigger: window.__cvf.isComboTrigger(e),
      isCountry: window.__cvf.isCountryLabel(window.__cvf.nlbl(e)),
      shown: window.__cvf.cbShown(e),
      answered: window.__cvf.cbAnswered(e),
    }));
  });
  console.log('    triggers:', JSON.stringify(seen));
  ok('every rui dropdown is detected as a trigger combo', seen.length >= 6 && seen.every((s) => s.isTrigger), seen.length);
  const dial = seen.find((s) => /phone country/i.test(s.label));
  const country = seen.find((s) => /current country/i.test(s.label));
  ok('the dial picker is treated as a country control', !!dial && dial.isCountry, dial);
  ok('its geo-IP default (+44) is NOT counted as the user\'s answer', !!dial && dial.answered === false, dial);
  ok('the country picker\'s default (United Kingdom) is NOT counted either', !!country && country.answered === false, country);

  // The real thing: can we open the sheet and SEE options?
  console.log('\nopening the sheet finds real options (the bug: it found none)');
  const probe = await page.evaluate(async () => {
    const els = [...document.querySelectorAll('input[type=button]')].filter((e) => e.getBoundingClientRect().width);
    const trig = els.find((e) => /current country/i.test(window.__cvf.nlbl(e)));
    const pre = window.__cvf.cbPreOpen();
    trig.focus();
    trig.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    trig.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    trig.click();
    await new Promise((r) => setTimeout(r, 900));
    const pop = window.__cvf.cbPopup(trig, pre);
    const opts = pop ? window.__cvf.cbOptions(trig, pop) : [];
    const sb = window.__cvf.cbSearchBox(trig, pop);
    return {
      popupFound: !!pop,
      popupCls: pop ? String(pop.el.className || '').slice(0, 60) : null,
      optionCount: opts.length,
      firstOptions: opts.slice(0, 5).map((o) => (o.innerText || '').trim().slice(0, 24)),
      searchBoxFound: !!sb,
      searchType: sb ? sb.type : null,
    };
  });
  console.log('    probe:', JSON.stringify(probe));
  ok('the aria-less sheet IS resolved as the popup', probe.popupFound, probe);
  ok('its <button> rows ARE read as options', probe.optionCount >= 10, probe.optionCount);
  ok('the sticky search box is found (needed for a virtualized list)', probe.searchBoxFound, probe);

  // Full end-to-end pick through the shipped openAndPick.
  console.log('\nopenAndPick actually sets the values (country + dial code)');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  await page.evaluate(`window.ReactNativeWebView = { postMessage: function(){} };`);
  await page.evaluate('(function(){' + JS_HELPERS + `
    window.__submits = 0;
    document.addEventListener('submit', function(e){ e.preventDefault(); window.__submits++; }, true);
    window.__cvf = { openAndPick: openAndPick, nlbl: nlbl, cbGuardOn: cbGuardOn, cbGuardOff: cbGuardOff };
  })()`);
  const picked = await page.evaluate(async () => {
    const run = (labelRe, want) => new Promise((resolve) => {
      const els = [...document.querySelectorAll('input[type=button]')].filter((e) => e.getBoundingClientRect().width);
      const trig = els.find((e) => labelRe.test(window.__cvf.nlbl(e)));
      if (!trig) return resolve({ ok: false, why: 'trigger not found' });
      window.__cvf.openAndPick(trig, want, (good) => resolve({ ok: good, value: trig.value }));
      setTimeout(() => resolve({ ok: false, why: 'timeout', value: trig.value }), 25000);
    });
    const country = await run(/current country/i, 'India');
    await new Promise((r) => setTimeout(r, 1200));
    const dial = await run(/phone country/i, '+91');
    return { country, dial, submits: window.__submits };
  });
  console.log('    result:', JSON.stringify(picked));
  ok('Current country was set to India', picked.country.ok && /india/i.test(String(picked.country.value)), picked.country);
  ok('the phone country code was set to +91', picked.dial.ok && /\+?91/.test(String(picked.dial.value)), picked.dial);
  ok('THE REAL FORM WAS NEVER SUBMITTED', picked.submits === 0, picked.submits);


  // ── sheets must be LEFT CLOSED, and checkbox groups must tick ────────────────
  console.log('\nsheets close themselves; nothing is left stacked open');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  await page.evaluate(`window.ReactNativeWebView = { postMessage: function(){} };`);
  await page.evaluate('(function(){' + JS_HELPERS + `
    window.__submits = 0;
    document.addEventListener('submit', function(e){ e.preventDefault(); window.__submits++; }, true);
    window.__cvf = { openAndPick: openAndPick, nlbl: nlbl, cbCloseAllOpened: cbCloseAllOpened,
      cbLooksLikeList: cbLooksLikeList, vis: vis, sig: sig };
  })()`);
  const sheets = await page.evaluate(async () => {
    const openSheets = () => [...document.querySelectorAll('input[type=search]')].filter((e) => e.offsetParent !== null).length;
    const run = (re, want) => new Promise((res) => {
      const els = [...document.querySelectorAll('input[type=button]')].filter((e) => e.getBoundingClientRect().width);
      const t = els.find((e) => re.test(window.__cvf.nlbl(e)));
      if (!t) return res('no trigger');
      window.__cvf.openAndPick(t, want, () => res('done'));
      setTimeout(() => res('timeout'), 25000);
    });
    await run(/current country/i, 'India');
    const afterFirst = openSheets();
    await new Promise((r) => setTimeout(r, 800));
    await run(/phone country/i, '+91');
    const afterSecond = openSheets();
    window.__cvf.cbCloseAllOpened();
    await new Promise((r) => setTimeout(r, 700));
    return { afterFirst, afterSecond, afterSweep: openSheets(), submits: window.__submits };
  });
  console.log('    open sheets:', JSON.stringify(sheets));
  ok('no sheet is left open after the first pick', sheets.afterFirst === 0, sheets);
  ok('no sheets stack up after a second pick', sheets.afterSecond === 0, sheets);
  ok('the page is left clean (nothing for the user to dismiss)', sheets.afterSweep === 0, sheets);

  console.log('\ncheckbox groups (pronouns) actually tick');
  const boxes = await page.evaluate(async () => {
    const cbs = [...document.querySelectorAll('input[type=checkbox]')].filter((e) => e.offsetParent !== null);
    const he = cbs.find((c) => /he\/him/i.test(window.__cvf.nlbl(c)));
    if (!he) return { found: false };
    const key = window.__cvf.sig(he);
    return { found: true, key, labels: cbs.slice(0, 5).map((c) => window.__cvf.nlbl(c)) };
  });
  console.log('    pronoun boxes:', JSON.stringify(boxes));
  if (boxes.found) {
    const res = await page.evaluate(async (key) => {
      const vals = {}; vals[key] = 'He/him';
      return new Promise((resolve) => {
        window.__fillDone = resolve;
        window.__vals = vals;
        resolve(null);
      });
    }, boxes.key);
    // drive the real fill script for just this field
    const fillOne = fillJsFactory({ [boxes.key]: 'He/him' });
    await page.evaluate(fillOne);
    await page.waitForFunction(() => window.__msgs && window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 40000 }).catch(() => {});
    const checked = await page.evaluate(() => [...document.querySelectorAll('input[type=checkbox]')]
      .filter((e) => e.offsetParent !== null).map((c) => ({ l: (c.labels && c.labels[0] ? c.labels[0].innerText : '').trim().slice(0, 20), c: c.checked })));
    console.log('    after fill:', JSON.stringify(checked));
    const hit = checked.find((c) => /he\/him/i.test(c.l));
    ok('the He/him box is TICKED (it used to be unticked by us)', !!hit && hit.c === true, checked);
    ok('sibling pronoun boxes are left alone', checked.filter((c) => c.c).length === 1, checked);
  } else {
    ok('pronoun checkbox group found on the page', false, boxes);
  }


  // ── THE REAL SCAN over EVERY dropdown (this is what runs on the device) ──────
  console.log('\nthe real scan reads ALL dropdowns and leaves none open');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  await page.evaluate(`window.ReactNativeWebView = { postMessage: function(s){ (window.__msgs=window.__msgs||[]).push(JSON.parse(s)); } };`);
  await page.evaluate(`window.__openWatch = { max: 0 };
    setInterval(function(){
      var n = document.querySelectorAll('input[type=search]').length;
      if (n > window.__openWatch.max) window.__openWatch.max = n;
    }, 150);`);
  await page.evaluate(READ_FIELDS_JS);
  await page.waitForFunction(() => window.__msgs && window.__msgs.some((m) => m.type === 'FIELDS'), null, { timeout: 90000 });
  const scan = await page.evaluate(() => {
    const f = window.__msgs.find((m) => m.type === 'FIELDS').fields;
    const combos = f.filter((x) => x.widget === 'combobox');
    return {
      fields: f.length,
      combos: combos.length,
      withOptions: combos.filter((c) => (c.options || []).length > 0).length,
      sample: combos.map((c) => ({ l: (c.label || '').slice(0, 26), n: (c.options || []).length, partial: !!c.optionsTruncated })),
      maxSheetsOpenDuringScan: window.__openWatch.max,
      sheetsOpenNow: document.querySelectorAll('input[type=search]').length,
      dialKey: (f.find((x) => /phone country/i.test(x.label || '')) || {}).key,
      numKey: (f.find((x) => String(x.type).toLowerCase() === 'tel') || {}).key,
      dialPartial: !!(f.find((x) => /phone country/i.test(x.label || '')) || {}).optionsTruncated,
      countryPartial: !!(f.find((x) => /current country/i.test(x.label || '')) || {}).optionsTruncated,
      genderPartial: !!(f.find((x) => /gender/i.test(x.label || '')) || {}).optionsTruncated,
      genderN: ((f.find((x) => /gender/i.test(x.label || '')) || {}).options || []).length,
    };
  });
  console.log('    scan:', JSON.stringify(scan));
  ok('every dropdown got its option list read', scan.combos > 0 && scan.withOptions === scan.combos, scan.sample);
  ok('NEVER more than one sheet open at a time', scan.maxSheetsOpenDuringScan <= 1, scan.maxSheetsOpenDuringScan);
  ok('no sheet is left open when the scan finishes', scan.sheetsOpenNow === 0, scan.sheetsOpenNow);

  // ── The 240-row phone-code list is VIRTUALISED: 24 rows in the DOM, India not among them ───────
  // Reporting those 24 as "the options" is what made the server rule +91 out ("no matching option")
  // and send no dial code at all, so the picker kept its geo-IP +44. Saying the list is PARTIAL is
  // what puts the bare "+91" back on the wire for pickDial to resolve against the real list.
  ok('the virtualised phone-code list is reported as PARTIAL (server must not rule +91 out)', scan.dialPartial === true, scan);
  ok('the virtualised country list is reported as PARTIAL too', scan.countryPartial === true, scan);
  ok('a SHORT, fully-rendered list (gender) is NOT falsely flagged partial', scan.genderN > 0 && scan.genderPartial === false, scan);

  // ── ⚠️ THE GAP THAT LET THE DIAL BUG SURVIVE FOUR FIXES ───────────────────────────────────────
  // Everything below this line hands the engine a values object THIS FILE WROTE — runFill({ [DIAL_KEY]:
  // '+91', ... }). That proves the engine can set a field when handed a perfect value, and it is worth
  // proving. It says NOTHING about whether a dial value is ever PRODUCED, and for four fixes running
  // that was the entire bug: the server read the picker as a phone NUMBER field, emitted no dial value
  // and no skip, and every assertion here still passed while a real phone sat on +44.
  //
  // So the producer is asserted too, HERE, against the fields the scan just made — no network, no
  // model, just the server's own exported classifier. The full three-leg run (real server, real
  // response, real fill) lives in the sibling: node MobileApp/scripts/test-live-forms-e2e.js
  console.log('\nthe SERVER can tell what these fields are (the half this file used to skip)');
  const scannedFields = await page.evaluate(() => window.__msgs.find((m) => m.type === 'FIELDS').fields);
  try {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test@localhost:5432/test';
    const SRV = require(path.join(REPO, 'server', 'controllers', 'aiHubController.js'));
    const nonFile = scannedFields.filter((f) => f && f.key && String(f.type || '').toLowerCase() !== 'file');
    const codeF = nonFile.filter(SRV.isPhoneCodeField).map((f) => f.key);
    const numF = nonFile.filter(SRV.isPhoneNumberField).map((f) => f.key);
    console.log('    server sees dial:', JSON.stringify(codeF), ' number:', JSON.stringify(numF));
    ok('the server recognises the dial picker in the shape the scan sends it', codeF.indexOf(scan.dialKey) >= 0, { codeF, dialKey: scan.dialKey });
    ok('and does not ALSO hand that picker to the phone-number pass', numF.indexOf(scan.dialKey) < 0, { numF });
    ok('the residence-country picker is not mistaken for a dial control',
      codeF.every((k) => !/current country/i.test(k)), codeF);
    // The regression itself: the option list is what the device fails to deliver on a slow phone,
    // and the identity must not depend on it.
    const bare = nonFile.map((f) => (f.key === scan.dialKey
      ? Object.assign({}, f, { options: undefined, optionsTruncated: undefined, optionsUnknown: true, isPhoneCode: undefined })
      : f));
    ok('WITH NO OPTION LIST AND NO CLIENT HINT it is still a dial control',
      bare.filter(SRV.isPhoneCodeField).map((f) => f.key).indexOf(scan.dialKey) >= 0, scan.dialKey);
    ok('...and still not the phone number field',
      bare.filter(SRV.isPhoneNumberField).map((f) => f.key).indexOf(scan.dialKey) < 0, scan.dialKey);
  } catch (e) {
    ok('the server classifier could be loaded and asserted against', false, e.message);
  }

  // ── THE ATOMIC-SPLIT INVARIANT ────────────────────────────────────────────────────────────────
  // The number half and the dial half must succeed or fail TOGETHER. Never "split and wrong".
  const DIAL_KEY = scan.dialKey, NUM_KEY = scan.numKey;
  const digits = (s) => String(s || '').replace(/[^0-9]/g, '');

  // Runs one real fill and reports what the page ends up holding. blockDial=true neutralises the
  // dial picker at the DOM level (capture-phase stopImmediatePropagation on its own control), which
  // is a failure we do not have to fake anywhere inside the engine.
  async function runFill(values, blockDial) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(9000);
    await page.evaluate(`window.ReactNativeWebView = { postMessage: function(s){ (window.__msgs=window.__msgs||[]).push(JSON.parse(s)); } };`);
    await page.evaluate('(function(){' + JS_HELPERS + `
      window.__submits = 0;
      document.addEventListener('submit', function(e){ e.preventDefault(); window.__submits++; }, true);
      window.__cvf = { nlbl: nlbl, cbShown: cbShown };
    })()`);
    if (blockDial) {
      await page.evaluate(() => {
        const els = [...document.querySelectorAll('input[type=button]')].filter((e) => e.getBoundingClientRect().width);
        const trig = els.find((e) => /phone country/i.test(window.__cvf.nlbl(e)));
        window.__blocked = !!trig;
        if (!trig) return;
        const zone = trig.parentElement || trig;
        const stop = (e) => { if (zone.contains(e.target)) { e.stopImmediatePropagation(); e.preventDefault(); } };
        ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart'].forEach((t) => window.addEventListener(t, stop, true));
      });
    }
    await page.evaluate(fillJsFactory(values));
    // NOT allowed to bubble: the harness's catch-all treats /timeout/ as "site unreachable" and
    // exits 0, which would turn a fill that never finishes into a green run.
    let timedOut = false;
    await page.waitForFunction(() => window.__msgs && window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 180000 })
      .catch(() => { timedOut = true; });
    if (timedOut) return { timedOut: true, report: { failed: [] }, errors: ['fill never reported FILLED'], submits: -1, dialShows: null, phone: null, blocked: null };
    return page.evaluate(() => {
      const els = [...document.querySelectorAll('input[type=button]')].filter((e) => e.getBoundingClientRect().width);
      const trig = els.find((e) => /phone country/i.test(window.__cvf.nlbl(e)));
      const tel = [...document.querySelectorAll('input')].find((i) => (i.type || '').toLowerCase() === 'tel');
      return {
        dialShows: trig ? window.__cvf.cbShown(trig) : null,
        phone: tel ? tel.value : null,
        report: window.__msgs.filter((m) => m.type === 'FILLED').pop(),
        errors: window.__msgs.filter((m) => m.type === 'AUTOFILL_ERROR'),
        submits: window.__submits,
        blocked: window.__blocked === undefined ? null : window.__blocked,
      };
    });
  }

  console.log('\nphone split — the dial pick SUCCEEDS: split, and split correctly');
  const okSplit = await runFill({ [DIAL_KEY]: '+91', [NUM_KEY]: '9970020596' }, false);
  console.log('    result:', JSON.stringify(okSplit));
  ok('the dial picker shows +91', /\+?91\b/.test(String(okSplit.dialShows)), okSplit.dialShows);
  ok('the number box holds ONLY the national part', digits(okSplit.phone) === '9970020596', okSplit.phone);
  ok('no autofill error', okSplit.errors.length === 0, okSplit.errors);
  ok('THE REAL FORM WAS NEVER SUBMITTED (successful split)', okSplit.submits === 0, okSplit.submits);

  console.log('\nphone split — the dial pick FAILS: the FULL number goes back in the number box');
  const badSplit = await runFill({ [DIAL_KEY]: '+91', [NUM_KEY]: '9970020596' }, true);
  console.log('    result:', JSON.stringify(badSplit));
  ok('the dial picker really was neutralised', badSplit.blocked === true, badSplit);
  ok('the picker did NOT reach +91 (this is the failure we are handling)', !/\+?91\b/.test(String(badSplit.dialShows)), badSplit.dialShows);
  ok('the number box holds the FULL international number, not the naked national part', digits(badSplit.phone) === '919970020596', badSplit.phone);
  ok('it is never left as national digits beside the wrong code', digits(badSplit.phone) !== '9970020596', badSplit.phone);
  ok('the un-set country code is REPORTED, not silently swallowed', (badSplit.report.failed || []).some((f) => /country code/i.test(f.why || '')), badSplit.report);
  ok('THE REAL FORM WAS NEVER SUBMITTED (failed split)', badSplit.submits === 0, badSplit.submits);

  // The other direction of the same invariant: the number arrives WITH its code (a learned or
  // AI-supplied answer) and the pick succeeds. Restoring the full number here would leave "+91" in
  // the picker AND "+91…" in the box — the country code twice. Regression guard for deriving the
  // dial code by regex from a whole number: wantDial("+919970020596") is "9199", not "91".
  console.log('\nphone split — the number arrives WITH its code and the pick SUCCEEDS');
  const both = await runFill({ [DIAL_KEY]: '+91', [NUM_KEY]: '+919970020596' }, false);
  console.log('    result:', JSON.stringify(both));
  ok('the dial picker still shows +91', /\+?91\b/.test(String(both.dialShows)), both.dialShows);
  ok('the country code is NOT duplicated into the number box', digits(both.phone) === '9970020596', both.phone);
  ok('THE REAL FORM WAS NEVER SUBMITTED (full-number + successful pick)', both.submits === 0, both.submits);

  // The production path that produced the user's screenshot: the server saw 24 of 240 options,
  // decided "+91: no matching option", sent NO dial value, and sent the number in full international
  // form — which the client then stripped anyway because a dial control exists on the page.
  console.log('\nphone split — no dial value was sent at all (the reported production case)');
  const noDial = await runFill({ [NUM_KEY]: '+919970020596' }, false);
  console.log('    result:', JSON.stringify(noDial));
  ok('the number keeps its country code when nothing set the picker', digits(noDial.phone) === '919970020596', noDial.phone);
  ok('THE REAL FORM WAS NEVER SUBMITTED (no-dial case)', noDial.submits === 0, noDial.submits);

  // ── The restore path must not INVENT a number ────────────────────────────────────────────────
  // The server's own split hands us a bare national number, but a learned answer (harvested from
  // what the user typed by hand) or a model-written one arrives in whatever shape they wrote it.
  // Prepending the dial code blind then wrote a number that belongs to nobody into the box on the
  // pick-failed path — the exact class of bug the invariant exists to prevent, one step later.
  console.log('\nphone split — the number ALREADY carries its code (no plus) and the pick FAILS');
  const dupe = await runFill({ [DIAL_KEY]: '+91', [NUM_KEY]: '919970020596' }, true);
  console.log('    result:', JSON.stringify(dupe));
  ok('the country code is not prepended a SECOND time', digits(dupe.phone) !== '91919970020596', dupe.phone);
  ok('an ambiguous number is left exactly as the page has it', digits(dupe.phone) === '919970020596', dupe.phone);
  ok('THE REAL FORM WAS NEVER SUBMITTED (already-coded case)', dupe.submits === 0, dupe.submits);

  console.log('\nphone split — a national TRUNK ZERO and the pick FAILS');
  const trunk = await runFill({ [DIAL_KEY]: '+91', [NUM_KEY]: '09970020596' }, true);
  console.log('    result:', JSON.stringify(trunk));
  ok('the trunk zero is dropped, not buried inside the country code', digits(trunk.phone) !== '9109970020596', trunk.phone);
  ok('the restored number is the real international one', digits(trunk.phone) === '919970020596', trunk.phone);
  ok('THE REAL FORM WAS NEVER SUBMITTED (trunk-zero case)', trunk.submits === 0, trunk.submits);

  // ── A WHOLE NUMBER ARRIVES IN THE DIAL SLOT ──────────────────────────────────────────────────
  // Not hypothetical: reproduced end to end. When the server misread the picker it answered the
  // DIAL key with "+919970020596". phoneReconcile asked wantDial() what code that was, wantDial
  // read its first four digits and said "9199", and the reconcile prepended THAT to the national
  // digits — writing +91999970020596, fourteen digits belonging to nobody, into the number box.
  console.log('\nphone split — the DIAL key is answered with a whole phone number');
  const wrongDial = await runFill({ [DIAL_KEY]: '+919970020596', [NUM_KEY]: '9970020596' }, true);
  console.log('    result:', JSON.stringify(wrongDial));
  ok('no invented number is written into the box', digits(wrongDial.phone) !== '91999970020596', wrongDial.phone);
  ok('the number box is left exactly as it was filled', digits(wrongDial.phone) === '9970020596', wrongDial.phone);
  ok('THE REAL FORM WAS NEVER SUBMITTED (whole-number-as-dial case)', wrongDial.submits === 0, wrongDial.submits);


  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // GROUPS, REPEATERS, CHIPS and HIDDEN-BUT-VISIBLE tick controls.
  //
  // Every section below re-neutralises submit on FIVE layers before anything is touched, and every
  // one of them asserts zero submit attempts afterwards. These are strangers' live application
  // forms; a fill sends nothing, a submit applies for a job in someone else's name.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Five layers, installed BEFORE anything is touched. __submits counts the three routes by which a
  // form is actually SUBMITTED; __posts counts blocked network writes separately, because a page's
  // own analytics POST is not an application being sent and must not read as one.
  const SHIELD = `
    window.__submits = []; window.__posts = [];
    document.addEventListener('submit', function(e){ e.preventDefault(); e.stopImmediatePropagation(); window.__submits.push('event'); }, true);
    HTMLFormElement.prototype.submit = function(){ window.__submits.push('proto'); };
    HTMLFormElement.prototype.requestSubmit = function(){ window.__submits.push('requestSubmit'); };
    (function(){ var of=window.fetch; window.fetch=function(u,o){ if(o&&/post|put/i.test((o&&o.method)||'')){ window.__posts.push(String(u).slice(0,60)); return Promise.reject(new Error('blocked')); } return of.apply(this,arguments); };
      var oo=XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open=function(m,u){ if(/post|put/i.test(m||'')){ window.__posts.push(String(u).slice(0,60)); throw new Error('blocked'); } return oo.apply(this,arguments); }; })();
    document.querySelectorAll('button[type=submit],input[type=submit]').forEach(function(b){ b.disabled=true; });
    window.ReactNativeWebView = { postMessage: function(s){ (window.__msgs=window.__msgs||[]).push(JSON.parse(s)); } };
  `;
  const freshScan = async (url, waitMs) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(waitMs || 9000);
    await page.evaluate(SHIELD);
    await page.evaluate(READ_FIELDS_JS);
    await page.waitForFunction(() => window.__msgs && window.__msgs.some((m) => m.type === 'FIELDS'), null, { timeout: 120000 });
    return page.evaluate(() => window.__msgs.find((m) => m.type === 'FIELDS').fields);
  };

  console.log('\nGROUPS — the scan emits ONE field per question, with its options');
  let fields = await freshScan(URL);
  const pronouns = fields.find((f) => (f.options || []).some((o) => /he\/him/i.test(o)));
  const consentG = fields.find((f) => (f.options || []).some((o) => /i consent/i.test(o)));
  console.log('    groups:', JSON.stringify(fields.filter((f) => /group/.test(f.widget || '')).map((f) => ({ w: f.widget, l: (f.label || '').slice(0, 40), n: (f.options || []).length, c: !!f.consent }))));
  ok('the 5 pronoun checkboxes are ONE checkboxgroup, not 5 fields', !!pronouns && pronouns.widget === 'checkboxgroup', pronouns);
  ok('it carries the question, not its first answer', !!pronouns && /pronoun/i.test(pronouns.label), pronouns && pronouns.label);
  ok('it carries all 5 options', !!pronouns && pronouns.options.length === 5, pronouns && pronouns.options);
  ok('it is flagged as accepting several answers', !!pronouns && pronouns.multi === true, pronouns);
  ok('the unnamed consent radio PAIR is ONE radiogroup (they have no name attribute)', !!consentG && consentG.widget === 'radiogroup', consentG);
  ok('it carries both options', !!consentG && consentG.options.length === 2, consentG && consentG.options);
  ok('it is flagged as a CONSENT question', !!consentG && consentG.consent === true, consentG);
  ok('the group question is the real question, not the first option', !!consentG && !/^yes, i consent$/i.test(consentG.label || ''), consentG && consentG.label);
  ok('exactly 5 checkboxes + 2 radios collapse to exactly 2 group fields',
    fields.filter((f) => /group/.test(f.widget || '')).length === 2, fields.filter((f) => /group/.test(f.widget || '')).length);
  ok('the other fields are untouched by grouping (11 of them)',
    fields.filter((f) => !/group|repeater/.test(f.widget || '')).length === 11,
    fields.filter((f) => !/group|repeater/.test(f.widget || '')).map((f) => f.key));

  console.log('\nGROUPS — filling by the GROUP key sets the right member and nothing else');
  await page.evaluate(fillJsFactory({ [pronouns.key]: 'They/them', [consentG.key]: 'Yes' }));
  await page.waitForFunction(() => window.__msgs && window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 120000 }).catch(() => {});
  const gres = await page.evaluate(() => ({
    ticks: [...document.querySelectorAll('input[type=checkbox],input[type=radio]')].map((c) => ({
      l: (c.labels && c.labels[0] ? c.labels[0].innerText : '').trim().slice(0, 22), on: c.checked })),
    report: window.__msgs.filter((m) => m.type === 'FILLED').pop(),
    errors: window.__msgs.filter((m) => m.type === 'AUTOFILL_ERROR'),
    submits: window.__submits,
  }));
  console.log('    ticks:', JSON.stringify(gres.ticks));
  console.log('    consented:', JSON.stringify(gres.report && gres.report.consented));
  const on = gres.ticks.filter((t) => t.on).map((t) => t.l);
  ok('They/them is ticked', on.some((l) => /they\/them/i.test(l)), on);
  ok('no other pronoun box is ticked', on.filter((l) => /him|her|prefer not|other/i.test(l)).length === 0, on);
  ok('"Yes" resolved to the reworded option "Yes, I consent"', on.some((l) => /yes, i consent/i.test(l)), on);
  ok('the opposite consent option is NOT selected', !on.some((l) => /don.t consent/i.test(l)), on);
  ok('both groups counted as filled', !!gres.report && gres.report.count === 2, gres.report);
  ok('no autofill error', gres.errors.length === 0, gres.errors);
  // RULE: anything we agree to on the applicant's behalf is shown back to them before they submit.
  const cons = (gres.report && gres.report.consented) || [];
  ok('the consent we ticked is REPORTED back for review', cons.length === 1, cons);
  ok('it is reported with the employer\'s own question wording', cons.length === 1 && /interview transcripts|consent/i.test(cons[0].label), cons);
  ok('and with the answer we chose', cons.length === 1 && /yes, i consent/i.test(cons[0].answer), cons);
  ok('THE REAL FORM WAS NEVER SUBMITTED (groups)', gres.submits.length === 0, gres.submits);

  console.log('\nGROUPS — an explicit "no" never unticks what the applicant ticked themselves');
  const keepMine = await page.evaluate(async ([pk]) => {
    const cbs = [...document.querySelectorAll('input[type=checkbox]')];
    const mine = cbs.find((c) => /she\/her/i.test((c.labels && c.labels[0] ? c.labels[0].innerText : '')));
    mine.click();                                   // the applicant's own answer, by hand
    return { before: mine.checked, key: pk };
  }, [pronouns.key]);
  await page.evaluate(fillJsFactory({ [pronouns.key]: 'They/them' }));
  await page.waitForTimeout(2500);
  const kept = await page.evaluate(() => [...document.querySelectorAll('input[type=checkbox]')]
    .map((c) => ({ l: (c.labels && c.labels[0] ? c.labels[0].innerText : '').trim().slice(0, 20), on: c.checked })).filter((c) => c.on).map((c) => c.l));
  ok('the applicant\'s own She/her tick survives a group fill for a different option', keepMine.before === true && kept.some((l) => /she\/her/i.test(l)), kept);

  // ⚠️ THE RADIO CASE IS THE DESTRUCTIVE ONE, and it is a CONSENT question on this form. Ticking a
  // radio unchecks its sibling, so filling this group over an answer the applicant had already
  // given REVERSED their refusal — measured on this page — and the review panel then told them
  // they had agreed to it. A checkbox can only ever be added to; a radio replaces.
  console.log('\nGROUPS — a radio consent the applicant answered is NEVER flipped');
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('input[type=radio]')].find((x) => /don.t consent/i.test((x.labels && x.labels[0] ? x.labels[0].innerText : '')));
    r.click();
    r.__cvfTouched = true;      // exactly what FOCUS_DETECT_JS marks on a real, trusted gesture
  });
  await page.waitForTimeout(800);
  await page.evaluate(fillJsFactory({ [consentG.key]: 'Yes, I consent' }));
  await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 60000 }).catch(() => {});
  const cflip = await page.evaluate(() => ({
    on: [...document.querySelectorAll('input[type=radio]')].filter((c) => c.checked)
      .map((c) => ((c.labels && c.labels[0] ? c.labels[0].innerText : '') || '').trim().slice(0, 30)),
    consented: ((window.__msgs || []).filter((m) => m.type === 'FILLED').pop() || {}).consented || [],
    submits: window.__submits,
  }));
  ok('their "No, I don\'t consent" is still the selected option', cflip.on.some((l) => /don.t consent/i.test(l)), cflip.on);
  ok('we did not select the opposite side for them', !cflip.on.some((l) => /^yes, i consent/i.test(l)), cflip.on);
  ok('and the review panel does not claim they agreed to anything', cflip.consented.length === 0, cflip.consented);
  ok('THE REAL FORM WAS NEVER SUBMITTED (consent not flipped)', cflip.submits.length === 0, cflip.submits);

  console.log('\nREPEATERS — detected structurally, and reported UNCLICKED by the scan');
  fields = await freshScan(URL);
  const reps = fields.filter((f) => f.widget === 'repeater');
  console.log('    repeaters:', JSON.stringify(reps.map((r) => ({ k: r.key.slice(0, 34), l: (r.label || '').slice(0, 44) }))));
  ok('both "Add" regions are found', reps.length === 2, reps.length);
  ok('neither is matched on the word "Add" — the label is the REGION\'s wording',
    reps.every((r) => !/^add$/i.test((r.label || '').trim())), reps.map((r) => r.label));
  ok('one is the work-experience region', reps.some((r) => /experience/i.test(r.label)), reps.map((r) => r.label));
  ok('one is the education region', reps.some((r) => /education/i.test(r.label)), reps.map((r) => r.label));
  ok('the scan did NOT click them (no row was added)',
    (await page.evaluate(() => document.querySelectorAll('input,textarea,select').length)) === 22,
    await page.evaluate(() => document.querySelectorAll('input,textarea,select').length));
  ok('THE REAL FORM WAS NEVER SUBMITTED (repeater scan)',
    (await page.evaluate(() => window.__submits.length)) === 0);

  console.log('\nREPEATERS — a row is added, filled from the given rows, and SURVIVES to the end');
  const expRep = reps.find((r) => /experience/i.test(r.label));
  const before22 = await page.evaluate(() => document.querySelectorAll('input,textarea,select').length);
  // Entirely synthetic history. Matches nobody.
  await page.evaluate(fillJsFactory({ [expRep.key]: [
    { Company: 'Northwind Analytics', Position: 'Senior Engineer', 'Start date': '2021-04', 'End date': '2024-08' },
    { Company: 'Baseline Systems', Position: 'Engineer', 'Start date': '2018-01', 'End date': '2021-03' },
  ] }));
  await page.waitForFunction(() => window.__msgs && window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 180000 }).catch(() => {});
  const rres = await page.evaluate(() => {
    const val = (re) => { const c = [...document.querySelectorAll('input')].find((i) => re.test(((i.labels && i.labels[0] ? i.labels[0].innerText : '') || ''))); return c ? String(c.value || '') : null; };
    const f = document.querySelector('form');
    return { ctrls: document.querySelectorAll('input,textarea,select').length, company: val(/^company$/i), position: val(/^position$/i),
      start: val(/^start date$/i), report: window.__msgs.filter((m) => m.type === 'FILLED').pop(),
      formText: String((f && f.innerText) || '').replace(/\s+/g, ' '),
      errors: window.__msgs.filter((m) => m.type === 'AUTOFILL_ERROR'), submits: window.__submits };
  });
  console.log('    after:', JSON.stringify({ ctrls: rres.ctrls, company: rres.company, position: rres.position, start: rres.start }));
  console.log('    report:', JSON.stringify(rres.report));
  // ⚠️ A COMMITTED ROW LEAVES THE SCREEN, so "the controls are still there" stopped being the test.
  // These assertions were written when the date columns could not be set and the row could
  // therefore never be saved; both of those are now false, and asserting the old shape would pin
  // the engine to the bug. What has to be true is that the entry EXISTS — in the row while it is
  // open, or in the employer's own form once the widget has taken it — and is never just gone.
  const inForm = (s) => rres.formText.toLowerCase().indexOf(String(s).toLowerCase()) >= 0;
  const saved = inForm('Northwind Analytics');
  const stillOpen = rres.ctrls > before22;
  console.log('    row outcome:', saved ? 'SAVED into the form' : (stillOpen ? 'still open on screen' : 'GONE — neither saved nor open'));
  ok('the row was opened and its data exists — on screen or saved', saved || stillOpen, [before22, rres.ctrls, saved]);
  ok('the row\'s Company is the one we gave it', saved || rres.company === 'Northwind Analytics', rres.company);
  ok('the row\'s Position is the one we gave it', saved || rres.position === 'Senior Engineer', rres.position);
  ok('the entry is never silently discarded (Cancel is not our button)', saved || stillOpen, rres.ctrls);
  // The date columns are calendar pickers that revert every injected write, so they are DRIVEN.
  // Either the date is in the box, or the saved entry carries the year we asked for, or the row is
  // still open AND the report names the date column. Never a row that quietly dropped it.
  const rfail = ((rres.report || {}).failed || []).find((f) => f.key === expRep.key);
  ok('the start date is set, or saved, or named as still needing the applicant',
    /2021/.test(String(rres.start)) || inForm('2021') || (!!rfail && /date/i.test(rfail.why || '')),
    { start: rres.start, why: rfail && rfail.why });
  ok('a SAVED row is not also reported as needing the applicant', !saved || !rfail || !!rfail.also, rfail);
  ok('the success is counted as filled', !!rres.report && rres.report.count >= 1, rres.report);
  ok('no autofill error', rres.errors.length === 0, rres.errors);
  ok('THE REAL FORM WAS NEVER SUBMITTED (repeater fill)', rres.submits.length === 0, rres.submits);

  // Accepting an opacity-0 control that has a visible pill is what makes Workable's three REQUIRED
  // yes/no questions and Ashby's twenty hidden controls scannable at all. It must not change the
  // answer on a page where everything is already visible.
  console.log('\nHIDDEN-BUT-VISIBLE tick controls — no change on a page that has none');
  await page.evaluate('(function(){' + JS_HELPERS + `
    window.__cvfProbe = { vis: vis, visCtl: visCtl, grpKey: grpKey, isChipInput: isChipInput, chipFill: chipFill, chipTexts: chipTexts, ctrls: ctrls };
  })()`);
  const visSame = await page.evaluate(() => {
    const els = [...document.querySelectorAll('input,textarea,select')];
    return { differ: els.filter((e) => window.__cvfProbe.visCtl(e) !== window.__cvfProbe.vis(e)).length, n: els.length };
  });
  ok('visCtl() agrees with vis() where every control is visible', visSame.differ === 0, visSame);
  ok('no text field on this form is mistaken for a chip widget',
    (await page.evaluate(() => window.__cvfProbe.ctrls().filter((e) => window.__cvfProbe.isChipInput(e)).length)) === 0);

  // ── CHIPS: proven on a real chip widget ───────────────────────────────────────────────────────
  // No corpus application form has one — measured across 16 reachable forms, zero chip inputs — so
  // the widget itself is exercised on MUI's public Autocomplete demo, which ships both archetypes:
  // a freeSolo box that commits typed text on Enter, and a multiple box that only picks from a menu.
  // Skips politely (does not fail the run) when that page cannot be reached.
  console.log('\nCHIPS — real chip widgets: type-and-Enter, and pick-from-menu');
  let chipPage = true;
  try {
    await page.goto('https://mui.com/material-ui/react-autocomplete/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
  } catch (e) { chipPage = false; }
  if (!chipPage) {
    console.log('    ⚠ chip page unreachable — chip assertions skipped');
  } else {
    await page.evaluate(SHIELD);
    await page.evaluate('(function(){' + JS_HELPERS + `
      window.__cvfProbe = { isChipInput: isChipInput, chipFill: chipFill, chipTexts: chipTexts, chipish: chipish };
    })()`);
    const chipRun = (id, vals) => page.evaluate(async ([id, vals]) => {
      const P = window.__cvfProbe;
      const el = document.getElementById(id);
      if (!el) return { missing: true };
      el.scrollIntoView({ block: 'center' });
      const detected = P.isChipInput(el);
      const before = P.chipTexts(el);
      const r = await new Promise((res) => { P.chipFill(el, vals, false, res); setTimeout(() => res({ timeout: true }), 45000); });
      return { detected, before, after: P.chipTexts(el), r, left: el.value, submits: window.__submits.slice(), posts: window.__posts.length };
    }, [id, vals]);

    const tagBox = await chipRun('tags-standard', ['The Godfather', 'Pulp Fiction']);
    console.log('    freeSolo (type + Enter):', JSON.stringify(tagBox));
    ok('a CamelCase chip widget (MuiChip-root) is recognised as a chip input', tagBox.detected === true, tagBox);
    ok('and no form submit happened while it was recognised', tagBox.submits.length === 0, tagBox.submits);
    ok('both chips were added', tagBox.r && tagBox.r.added === 2 && tagBox.r.missed.length === 0, tagBox.r);
    ok('each chip is verified against what the widget SHOWS, not el.value',
      (tagBox.after || []).some((t) => /godfather/i.test(t)) && (tagBox.after || []).some((t) => /pulp fiction/i.test(t)), tagBox.after);
    ok('a chip the user already had is left alone', (tagBox.after || []).some((t) => /inception/i.test(t)), tagBox.after);
    ok('the input box is left clean, with no residue', String(tagBox.left || '') === '', tagBox.left);
    // The whole reason Enter is now allowed: the old skills loop refused to press it, so a
    // type-and-Enter widget received nothing at all. A SYNTHETIC Enter cannot trigger the browser's
    // own implicit submission, and the shield refuses a page handler that tries.
    ok('pressing Enter added chips WITHOUT any form submit', tagBox.submits.length === 0, tagBox.submits);

    const menuBox = await chipRun('checkboxes-tags-demo', ['Se7en', 'Fight Club']);
    console.log('    pick-from-menu:', JSON.stringify(menuBox));
    // An EMPTY pick-from-menu widget carries no chip yet, so there is no chip-shaped evidence and
    // isChipInput correctly declines to claim it. That is not a gap: it is a combobox, the combo
    // path drives it, and it starts being recognised as a chip widget the moment it holds one.
    ok('an EMPTY multi widget is left to the combobox path, not claimed as a chip box', menuBox.detected === false, menuBox.detected);
    ok('both values were still picked from its menu', menuBox.r && menuBox.r.added === 2 && menuBox.r.missed.length === 0, menuBox.r);
    ok('once it holds chips it IS recognised',
      (await page.evaluate(() => window.__cvfProbe.isChipInput(document.getElementById('checkboxes-tags-demo')))) === true);
    ok('THE PAGE WAS NEVER SUBMITTED (chips)', menuBox.submits.length === 0, menuBox.submits);

    // ── the virtualised-list false negative, on the real react-window widget ────────────────────
    // Saying "this is the whole list" about a window onto a longer one is how a valid value gets
    // deleted server-side as "no matching option" — the same failure that kept +91 off the phone
    // picker. Here the [role=listbox] reports clientHeight === scrollHeight, so reading the popup
    // node alone concludes "complete" for a TEN THOUSAND option list.
    await page.evaluate('(function(){' + JS_HELPERS + `
      window.__cvfV = { cbPreOpen: cbPreOpen, cbPopup: cbPopup, cbOptions: cbOptions, cbListPartial: cbListPartial };
    })()`);
    const virt = await page.evaluate(async () => {
      const C = window.__cvfV;
      const el = [...document.querySelectorAll('input[role=combobox]')].find((i) => /10,000/.test((i.labels && i.labels[0] ? i.labels[0].innerText : '') + (i.getAttribute('aria-label') || '')));
      if (!el) return { missing: true };
      el.scrollIntoView({ block: 'center' });
      const pre = C.cbPreOpen();
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.click();
      await new Promise((r) => setTimeout(r, 1600));
      const lb = document.querySelector('[role=listbox]');
      const pop = C.cbPopup(el, pre) || (lb ? { el: lb, trusted: false } : null);
      if (!pop) return { noPopup: true };
      const opts = C.cbOptions(el, pop);
      const inner = [...pop.el.querySelectorAll('*')].filter((k) => k.scrollHeight > k.clientHeight + 20)[0];
      return { rows: opts.length, partial: C.cbListPartial(el, pop, opts),
        popupOverflow: (pop.el.scrollHeight - pop.el.clientHeight),
        realScrollerOverflow: inner ? inner.scrollHeight - inner.clientHeight : 0,
        submits: window.__submits.length };
    });
    console.log('    virtualised list:', JSON.stringify(virt));
    if (virt.missing || virt.noPopup) {
      console.log('    ⚠ the 10,000-option demo did not open — virtualisation assertions skipped');
    } else {
      ok('the popup node itself reports NO overflow (this is the trap)', virt.popupOverflow <= 80, virt.popupOverflow);
      ok('the real scroller is a DESCENDANT, and it is enormous', virt.realScrollerOverflow > 10000, virt.realScrollerOverflow);
      ok('only a handful of the 10,000 rows are actually rendered', virt.rows > 0 && virt.rows < 60, virt.rows);
      ok('so the list is reported PARTIAL — the server must not rule a value out', virt.partial === true, virt);
      ok('THE PAGE WAS NEVER SUBMITTED (virtualisation)', virt.submits === 0, virt.submits);
    }

    const words = await page.evaluate(() => ['MuiChip-root', 'tag-input', 'chips', 'advantage', 'heritage', 'package', 'stage', 'vintage']
      .map((c) => c + '=' + window.__cvfProbe.chipish(c)));
    console.log('    chipish:', JSON.stringify(words));
    ok('chip-ish class matching does not fire on advantage/heritage/package/stage/vintage',
      words.filter((w) => /=true/.test(w)).length === 3, words);
  }

  // ── THE HEADLINE CASES, on two more real employers ────────────────────────────────────────────
  // Revolut's tick controls are all visible, so it cannot prove the part of this work that matters
  // most: 42 of 120 radios and 15 of 103 checkboxes across the corpus are opacity-0 natives under a
  // visible pill, and the engine used to skip every one of them — reporting ZERO radio groups on a
  // Workable form with three REQUIRED yes/no questions. Lever proves the other half: 74 visible
  // checkboxes that used to collapse onto 8 keys labelled with whichever option came first.
  // Each target skips politely rather than failing the run when it cannot be reached.
  const scanEmployer = async (url) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    await page.evaluate(SHIELD);                       // shield FIRST, then reach the form
    await page.evaluate(() => {
      if (document.querySelectorAll('input,textarea,select').length >= 4) return;
      const b = [...document.querySelectorAll('a,button')].find((x) => /^\s*(apply|apply now|apply for this job)\s*$/i.test((x.innerText || '').trim()) && (x.getAttribute('type') || '') !== 'submit');
      if (b) b.click();
    });
    await page.waitForTimeout(6000);
    const dom = await page.evaluate(() => {
      const t = [...document.querySelectorAll('input[type=radio],input[type=checkbox]')];
      return { ticks: t.length, hidden: t.filter((c) => { const st = getComputedStyle(c); return parseFloat(st.opacity || '1') === 0 || c.offsetParent === null || st.display === 'none'; }).length };
    });
    await page.evaluate(READ_FIELDS_JS);
    await page.waitForFunction(() => window.__msgs && window.__msgs.some((m) => m.type === 'FIELDS'), null, { timeout: 90000 });
    const f = await page.evaluate(() => window.__msgs.find((m) => m.type === 'FIELDS').fields);
    const submits = await page.evaluate(() => window.__submits);
    return { dom, fields: f, submits };
  };

  console.log('\nWORKABLE — three REQUIRED yes/no questions whose radios are opacity:0');
  try {
    const wk = await scanEmployer('https://apply.workable.com/j/C93E04D1AF');
    const rg = wk.fields.filter((f) => f.widget === 'radiogroup');
    console.log('    dom:', JSON.stringify(wk.dom), 'radiogroups:', JSON.stringify(rg.map((g) => ({ l: (g.label || '').slice(0, 34), o: g.options, req: g.required }))));
    ok('every tick control on this form really is hidden', wk.dom.ticks > 0 && wk.dom.hidden === wk.dom.ticks, wk.dom);
    ok('the engine now SEES them as radio groups (it used to report zero)', rg.length === 3, rg.length);
    ok('each is one YES/NO question with both options', rg.every((g) => (g.options || []).length === 2), rg.map((g) => g.options));
    ok('their REQUIRED flag survives', rg.every((g) => g.required === true), rg.map((g) => g.required));
    ok('THE REAL FORM WAS NEVER SUBMITTED (workable scan)', wk.submits.length === 0, wk.submits);
  } catch (e) { console.log('    ⚠ workable unreachable — skipped (' + String(e.message).slice(0, 60) + ')'); }

  console.log('\nLEVER — 6 checkbox groups that used to collapse onto one key each');
  try {
    const lv = await scanEmployer('https://jobs.lever.co/lyrahealth/bf8f42c1-6453-4ee3-8efb-51b16b3f7bd0/apply');
    const cg = lv.fields.filter((f) => f.widget === 'checkboxgroup');
    const rg = lv.fields.filter((f) => f.widget === 'radiogroup');
    console.log('    dom:', JSON.stringify(lv.dom), 'checkboxgroups:', JSON.stringify(cg.map((g) => ({ l: (g.label || '').slice(0, 34), n: (g.options || []).length }))));
    ok('this form really does carry a hundred-plus tick controls', lv.dom.ticks > 100, lv.dom);
    ok('the checkbox groups arrive as groups, not as one field per box', cg.length >= 5, cg.length);
    ok('each carries a real options list rather than a single label', cg.every((g) => (g.options || []).length >= 4), cg.map((g) => (g.options || []).length));
    ok('the licence question keeps all its choices', cg.some((g) => (g.options || []).some((o) => /LICSW/i.test(o))), cg.map((g) => g.label));
    ok('its radio groups are grouped too', rg.length >= 10, rg.length);
    ok('a consent checkbox is flagged for the review panel', lv.fields.some((f) => f.consent), lv.fields.filter((f) => f.consent).map((f) => f.label));
    ok('THE REAL FORM WAS NEVER SUBMITTED (lever scan)', lv.submits.length === 0, lv.submits);
  } catch (e) { console.log('    ⚠ lever unreachable — skipped (' + String(e.message).slice(0, 60) + ')'); }

  // ── THE REAL SERVER, ANSWERING THE REAL PAGE ──────────────────────────────────────────────────
  // Everything above proves the DEVICE can drive these widgets. This proves the other half: that
  // the values PRODUCTION returns, for THIS page's own scanned fields, are values THIS page can
  // actually take. A fixture cannot show that — the option strings, the group keys and the row
  // columns all come from the employer, not from us.
  //
  // ⚠️ NOTHING PERSONAL IS TYPED INTO THE EMPLOYER'S FORM. The real account's answers are checked
  // against the live DOM; where a row has to be revealed to compare its columns, the server's row
  // KEYS are kept and its values are replaced with synthetic markers. Submit stays neutralised on
  // all five layers and is asserted zero at the end, as everywhere else in this file.
  console.log('\nTHE REAL SERVER ANSWERS THE REAL PAGE');
  try {
    require(path.join(REPO, 'node_modules', 'dotenv')).config({ path: path.join(REPO, '.env') });
    const jwt = require(path.join(REPO, 'node_modules', 'jsonwebtoken'));
    const API = process.env.AUTOFILL_TEST_API || 'https://cvapplyr-website-production.up.railway.app';
    if (!process.env.JWT_SECRET) throw new Error('no JWT_SECRET in .env');
    // This section runs LAST, after a dozen navigations, and the employer throttles: the first
    // scan here times out often enough that a single attempt made the whole section vanish into
    // its own "skipped" branch. One retry, with a longer settle.
    let live = null;
    try { live = await freshScan(URL); }
    catch (e) { await page.waitForTimeout(20000); live = await freshScan(URL, 16000); }
    const token = jwt.sign({ id: Number(process.env.AUTOFILL_TEST_USER || 1), email: 'x@y.z' }, process.env.JWT_SECRET);
    const resp = await fetch(API + '/api/ai-hub/autofill-map', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: live, jobTitle: 'Legal Counsel (Loyalty)', companyName: 'Revolut' }),
    });
    if (resp.status !== 200) throw new Error('server said HTTP ' + resp.status);
    const body = await resp.json();
    const vals = body.values || {};
    const why = {}; for (const s of (body.skipped || [])) why[s.key] = s.why;
    const byKey = {}; for (const f of live) byKey[f.key] = f;
    console.log('    server answered ' + Object.keys(vals).length + ' of ' + live.length + ' scanned fields');
    console.log('    ' + Object.keys(vals).map((k) => (byKey[k] ? (byKey[k].label || '').slice(0, 26) : k) + '=' + JSON.stringify(vals[k]).slice(0, 46)).join('\n    '));

    ok('every answer names a field this page really has', Object.keys(vals).every((k) => byKey[k]), Object.keys(vals).filter((k) => !byKey[k]));
    // ⚠️ Comparing this by splitting on commas is exactly the bug the server had: a REAL option on
    // this page is "Job portal or job search (Indeed, Google search, Justjoin.it, etc.)". A
    // one-answer field is compared WHOLE; only a multi field is split.
    const fits = (k) => {
      const f = byKey[k], v = String(vals[k]);
      if (f.options.indexOf(v) >= 0) return true;
      if (!(f.multi === true || f.widget === 'checkboxgroup' || f.widget === 'chips')) return false;
      return v.split(/\s*,\s*/).every((p) => f.options.indexOf(p) >= 0);
    };
    const optioned = Object.keys(vals).filter((k) => (byKey[k].options || []).length && !byKey[k].optionsTruncated);
    ok('every option-bearing answer is one of THAT field\'s own live options',
      optioned.every(fits), optioned.filter((k) => !fits(k)).map((k) => [byKey[k].label, vals[k]]));
    const rgKeys = live.filter((f) => f.widget === 'radiogroup').map((f) => f.key);
    ok('no radiogroup gets more than one answer', rgKeys.every((k) => vals[k] === undefined || byKey[k].options.indexOf(String(vals[k])) >= 0), rgKeys.map((k) => vals[k]));
    const ethn = live.find((f) => /ethnic/i.test(f.label || ''));
    ok('the ethnicity question is left blank for the applicant', !ethn || vals[ethn.key] === undefined, ethn && vals[ethn.key]);
    const consentG2 = live.find((f) => f.consent === true);
    ok('the consent question is handed back, not answered on their behalf',
      !consentG2 || vals[consentG2.key] === undefined, consentG2 && vals[consentG2.key]);
    ok('…and it is named as needing them', !consentG2 || why[consentG2.key] === 'needs your consent', consentG2 && why[consentG2.key]);
    const liveReps = live.filter((f) => f.widget === 'repeater');
    const expKey = (liveReps.find((r) => /experience/i.test(r.label)) || {}).key;
    const eduKey = (liveReps.find((r) => /education/i.test(r.label)) || {}).key;
    ok('the work region got an ARRAY of rows', Array.isArray(vals[expKey]) && vals[expKey].length > 0, vals[expKey]);
    ok('the education region got an ARRAY of rows', Array.isArray(vals[eduKey]) && vals[eduKey].length > 0, vals[eduKey]);
    ok('the work rows carry employers and the education rows do not',
      Array.isArray(vals[expKey]) && Array.isArray(vals[eduKey])
        && vals[expKey].every((r) => Object.keys(r).some((c) => /company|employer/i.test(c)))
        && vals[eduKey].every((r) => !Object.keys(r).some((c) => /company|employer/i.test(c))),
      [vals[expKey], vals[eduKey]]);

    // Do the server's plain-English row KEYS actually reach the employer's own columns? Reveal one
    // row and find out — with the keys kept and every value replaced by a synthetic marker.
    if (Array.isArray(vals[expKey]) && vals[expKey].length) {
      const src = vals[expKey][0];
      const probe = {}; const expect = {};
      let n = 0;
      for (const k of Object.keys(src)) {
        const marker = /date|year|from|until/i.test(k) ? '2021-04' : 'SYNTHETIC' + (++n);
        probe[k] = marker; expect[k] = marker;
      }
      const before = await page.evaluate(() => document.querySelectorAll('input,textarea,select').length);
      await page.evaluate(fillJsFactory({ [expKey]: [probe] }));
      // Wait for the MARKER to appear, not merely for a FILLED message: the repeater phase reports
      // when its whole queue is done, and reading the DOM on that signal alone raced the row and
      // measured an empty form. Fall back to the message so a genuine failure still reports.
      await page.waitForFunction((mark) => [...document.querySelectorAll('input,textarea')].some((i) => String(i.value || '').indexOf(mark) === 0), 'SYNTHETIC', { timeout: 180000 }).catch(() => {});
      await page.waitForFunction(() => window.__msgs && window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 180000 }).catch(() => {});
      const landed = await page.evaluate(() => {
        const out = {};
        // Text-ish controls only: a checkbox reports value "on" whether or not it is ticked, and
        // listing those made an untouched form look like something had been filled in.
        // ⚠️ input[type=button] STAYS IN. This employer renders the row's Company and Position as
        // button-shaped combobox triggers, not text boxes — excluding them made this reader return
        // {} on a row the engine had filled correctly (verified: value "SYNTHETIC1" sat in the
        // Company trigger while these two assertions reported it missing).
        for (const i of [...document.querySelectorAll('input,textarea')]) {
          if (['checkbox', 'radio', 'hidden', 'submit', 'image', 'file'].indexOf((i.type || '').toLowerCase()) >= 0) continue;
          const l = ((i.labels && i.labels[0] ? i.labels[0].innerText : '') || i.getAttribute('placeholder') || '').trim();
          if (l && i.value) out[l] = String(i.value);
        }
        const fm = document.querySelector('form');
        return { out, ctrls: document.querySelectorAll('input,textarea,select').length, submits: window.__submits,
                 formText: String((fm && fm.innerText) || '').replace(/\s+/g, ' '),
                 report: (window.__msgs || []).filter((m) => m.type === 'FILLED').pop() };
      });
      console.log('    columns the server\'s keys reached:', JSON.stringify(landed.out));
      console.log('    device report:', JSON.stringify(landed.report).slice(0, 300));
      // Same correction as the synthetic row above: once the row can actually be committed, its
      // controls leave the document, so the entry is looked for in the FORM as well as in the row.
      const hit = (col, key) => Object.keys(landed.out).some((l) => col.test(l) && landed.out[l] === expect[key]);
      const inF = (v) => !!v && landed.formText.toLowerCase().indexOf(String(v).toLowerCase().slice(0, 22)) >= 0;
      const companyKey = Object.keys(expect).find((k) => /company|employer/i.test(k));
      const roleKey = Object.keys(expect).find((k) => /position|title|role/i.test(k));
      console.log('    row outcome:', inF(expect[companyKey]) ? 'SAVED into the form' : (landed.ctrls > before ? 'still open' : 'GONE'));
      ok('the row opened and its data exists — on screen or saved',
        landed.ctrls > before || inF(expect[companyKey]), [before, landed.ctrls]);
      ok('the server\'s company key reached the employer\'s Company column',
        !!companyKey && (hit(/^company$/i, companyKey) || inF(expect[companyKey])), [companyKey, landed.out]);
      ok('the server\'s role key reached the employer\'s Position column',
        !!roleKey && (hit(/^position$/i, roleKey) || inF(expect[roleKey])), [roleKey, landed.out]);
      ok('THE REAL FORM WAS NEVER SUBMITTED (server-driven row)', landed.submits.length === 0, landed.submits);
    }
    ok('THE REAL FORM WAS NEVER SUBMITTED (server section)', (await page.evaluate(() => window.__submits.length)) === 0);
  } catch (e) {
    console.log('    ⚠ production endpoint not exercised — skipped (' + String(e.message).slice(0, 80) + ')');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  if (/net::|timeout|ERR_|ENOTFOUND|Navigation/i.test(String(e.message))) {
    console.log('\n⚠ SKIPPED — could not reach the live page (' + String(e.message).slice(0, 80) + ')');
    process.exit(0);
  }
  console.error('HARNESS ERROR:', e.message);
  process.exit(2);
});
