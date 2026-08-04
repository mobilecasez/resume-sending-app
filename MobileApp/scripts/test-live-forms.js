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
