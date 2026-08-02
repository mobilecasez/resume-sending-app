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
  await page.waitForTimeout(6000);

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
  await page.waitForTimeout(6000);
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
  await page.waitForTimeout(6000);
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
