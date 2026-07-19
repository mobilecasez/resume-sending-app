// Runs the REAL injected WebView scripts (extracted verbatim from job-detail.tsx) inside Chromium
// and asserts their behaviour. This is the only way to test them short of a device build.
//   node MobileApp/scripts/test-webview-scripts.js
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', '(ai-hub)', 'job-detail.tsx'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'utils', 'webviewAuth.ts'), 'utf8');

// Pull a `const NAME = \`…\`;` template literal out of the TSX. The only interpolation these
// scripts use is ${JS_HELPERS}, which we resolve so the tested code is byte-identical to shipped.
function raw(name) {
  const m = SRC.match(new RegExp('(?:export )?const ' + name + ' = `([\\s\\S]*?)`;\\n'));
  if (!m) throw new Error('could not extract ' + name);
  return m[1];
}
// Evaluate the template literal the same way the app does, so escapes like \\. collapse to \.
// (reading the file text raw leaves them doubled and silently breaks every embedded regex).
const evalTpl = (body, helpers) => new Function('JS_HELPERS', 'return `' + body + '`;')(helpers);
const JS_HELPERS = evalTpl(raw('JS_HELPERS'), '');
const grab = (name) => evalTpl(raw(name), JS_HELPERS);
const FRAME_GUARD_JS = grab('FRAME_GUARD_JS');
const AUTH_FLOW_JS = grab('AUTH_FLOW_JS');
const INTERCEPT_FILES_JS = grab('INTERCEPT_FILES_JS');
const FOCUS_DETECT_JS = grab('FOCUS_DETECT_JS');

// The bridge our scripts post through, plus a sink we can read back.
const BRIDGE = `window.__msgs=[];window.ReactNativeWebView={postMessage:function(s){window.__msgs.push(JSON.parse(s));}};`;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
};

(async () => {
  const browser = await chromium.launch();

  // Serve any https URL so we can exercise real hostnames (hcaptcha, the portal, the IdP).
  const ctx = await browser.newContext();
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    let body = '<html><body><h1>page</h1></body></html>';
    if (url.includes('portal.example.com')) {
      body = `<html><body>
        <h1>Apply</h1>
        <iframe src="https://newassets.hcaptcha.com/captcha/v1/frame"></iframe>
        <input id="name"><input type="file" id="cv">
        <button id="google">Sign in with Google</button>
        <script>
          document.getElementById('google').addEventListener('click', function(){
            window.__popup = window.open('https://accounts.google.com/o/oauth2/auth?client_id=x','oauth','width=500');
            window.__popupWasNull = (window.__popup === null);
            try { window.__popup.focus(); window.__afterFocus = true; } catch(e) { window.__focusThrew = String(e); }
          });
        </script></body></html>`;
    }
    route.fulfill({ status: 200, contentType: 'text/html', body });
  });

  // ── 1. the sign-in shim ────────────────────────────────────────────────────
  console.log('\nsign-in flow (AUTH_FLOW_JS)');
  {
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE + FRAME_GUARD_JS + '\n' + AUTH_FLOW_JS);
    await page.goto('https://portal.example.com/jobs/1/apply');
    await page.click('#google');
    const r = await page.evaluate(() => ({
      msgs: window.__msgs, wasNull: window.__popupWasNull,
      afterFocus: window.__afterFocus === true, focusThrew: window.__focusThrew || null,
      typeofPopup: typeof window.__popup,
    }));
    const popupMsg = r.msgs.find((m) => m.type === 'AUTH_POPUP');
    ok('window.open returns a usable stub, never null', r.wasNull === false && r.typeofPopup === 'object', r);
    ok('calling .focus() on it does not throw', r.afterFocus && !r.focusThrew, r.focusThrew);
    ok('posts AUTH_POPUP with the auth URL', !!popupMsg && popupMsg.url.startsWith('https://accounts.google.com/'), popupMsg);
    ok('remembers the page we came from', !!popupMsg && popupMsg.from.includes('portal.example.com'), popupMsg && popupMsg.from);

    // the callback page finishing with window.close() is our "auth done" signal
    await page.evaluate(() => { window.__msgs.length = 0; window.close(); });
    const done = await page.evaluate(() => window.__msgs);
    ok('window.close() signals AUTH_DONE', done.some((m) => m.type === 'AUTH_DONE'), done);

    // a popup driven by assigning .location must be handled too
    await page.evaluate(() => { window.__msgs.length = 0; const w = window.open('https://idp.example.com/a'); w.location.href = 'https://idp.example.com/step2'; });
    const loc = await page.evaluate(() => window.__msgs.filter((m) => m.type === 'AUTH_POPUP').map((m) => m.url));
    ok('stub .location.href assignment routes through RN', loc.includes('https://idp.example.com/step2'), loc);
    await page.close();
  }

  // ── 2. the captcha frame guard ─────────────────────────────────────────────
  console.log('\ncaptcha / bot-check frames (FRAME_GUARD_JS)');
  {
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE + FRAME_GUARD_JS + '\n' + AUTH_FLOW_JS + '\n' + INTERCEPT_FILES_JS + '\n' + FOCUS_DETECT_JS);
    await page.goto('https://portal.example.com/jobs/1/apply');
    await page.waitForTimeout(400);
    const frames = page.frames();
    const main = frames.find((f) => f.url().includes('portal.example.com'));
    const cap = frames.find((f) => f.url().includes('hcaptcha.com'));
    ok('the hCaptcha iframe actually loaded (test is meaningful)', !!cap, frames.map((f) => f.url()));
    const mainState = await main.evaluate(() => ({ skip: !!window.__cvfSkipFrame, file: !!window.__cvfFileHook, focus: !!window.__cvfFocusHook, auth: !!window.__cvfAuthHook }));
    ok('main frame is NOT skipped — our tools still work', mainState.skip === false && mainState.file && mainState.focus && mainState.auth, mainState);
    if (cap) {
      const capState = await cap.evaluate(() => ({ skip: !!window.__cvfSkipFrame, file: !!window.__cvfFileHook, focus: !!window.__cvfFocusHook, auth: !!window.__cvfAuthHook }));
      ok('captcha frame IS marked skip', capState.skip === true, capState);
      ok('no file hook installed inside the captcha frame', capState.file === false, capState);
      ok('no focus hook installed inside the captcha frame', capState.focus === false, capState);
      ok('no window.open override inside the captcha frame', capState.auth === false, capState);
    }
    await page.close();
  }

  // ── 3. URL canonicalisation ────────────────────────────────────────────────
  console.log('\njob URL canonicalisation (jobUrl.ts)');
  {
    const ts = fs.readFileSync(path.join(__dirname, '..', 'utils', 'jobUrl.ts'), 'utf8');
    const js = ts.replace(/export\s+/g, '').replace(/:\s*(string|boolean)\b/g, '').replace(/\bconst\s+u:\s*URL;?/g, 'let u;').replace(/let u: URL;/, 'let u;');
    const mod = {};
    new Function('module', 'exports', js + '\nmodule.exports={canonicalJobUrl,isAuthUrl};')(mod, mod);
    const { canonicalJobUrl, isAuthUrl } = mod.exports;
    const schwabLogin = 'https://career-schwab.icims.com/jobs/123720/software-developer-ii-%28.net-c%23%29/login?mobile=true&width=402&height=684&bga=true&needsRedirect=false';
    ok('the reported Schwab login URL → the captcha-free /job page',
      canonicalJobUrl(schwabLogin) === 'https://career-schwab.icims.com/jobs/123720/software-developer-ii-%28.net-c%23%29/job', canonicalJobUrl(schwabLogin));
    ok('it is recognised as an auth URL', isAuthUrl(schwabLogin) === true);
    for (const u of ['https://boards.greenhouse.io/acme/jobs/4821',
                     'https://jobs.lever.co/acme/8f2c1a90-1234',
                     'https://jobs.smartrecruiters.com/AcmeInc/743999912345-project-manager',
                     'https://www.instahyre.com/job/1234567/senior-pm-at-acme']) {
      ok('normal ATS URL left untouched: ' + u.slice(8, 42), canonicalJobUrl(u) === u, canonicalJobUrl(u));
    }
    ok('a bare domain is never degraded', canonicalJobUrl('https://acme.com/login') === 'https://acme.com/login');
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
