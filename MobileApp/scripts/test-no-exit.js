// Runs the REAL NO_EXIT_JS and GOOGLE_AUTH_WATCH_JS (extracted verbatim from utils/webviewAuth.ts)
// inside Chromium and asserts what they actually do to a page.
//
// Both scripts exist because of the same mistake in opposite directions: we used to PREDICT that
// Google would refuse a sign-in and cancel it (breaking the flow that works), while doing nothing
// at all about the banners and long-press sheets that walk the user out of a half-filled
// application. So the two things under test here are "never cry wolf" and "never leave a door open".
//   node MobileApp/scripts/test-no-exit.js
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const WA = fs.readFileSync(path.join(__dirname, '..', 'utils', 'webviewAuth.ts'), 'utf8');
function grab(name) {
  const m = WA.match(new RegExp('export const ' + name + ' = `([\\s\\S]*?)`;\\n'));
  if (!m) throw new Error('could not extract ' + name);
  // Evaluate the template literal the way the app does, so \\. collapses to \. — read raw, every
  // embedded regex in these scripts is silently wrong.
  return new Function('return `' + m[1] + '`;')();
}
const NO_EXIT_JS = grab('NO_EXIT_JS');
const AUTH_FLOW_JS = grab('AUTH_FLOW_JS');
const GOOGLE_AUTH_WATCH_JS = grab('GOOGLE_AUTH_WATCH_JS');
const PASSKEY_GUARD_JS = grab('PASSKEY_GUARD_JS');
const GD_EMAIL_ROUTE_JS = grab('GD_EMAIL_ROUTE_JS');
const BRIDGE = `window.__msgs=[];window.ReactNativeWebView={postMessage:function(s){window.__msgs.push(JSON.parse(s));}};`;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

const PAGE = `<!doctype html><html><head>
  <meta name="apple-itunes-app" content="app-id=302584613">
  <title>Senior Engineer — Acme</title></head><body>
  <div id="appbanner" style="position:fixed;top:0;left:0;right:0;height:60px;z-index:9999">
    Open in the app for a better experience
    <a id="storelink" href="https://apps.apple.com/app/id302584613">Open</a>
  </div>
  <div id="cookies" style="position:fixed;bottom:0;left:0;right:0;height:80px;z-index:9999">
    We use cookies to improve this site. <button id="acceptck">Accept</button>
  </div>
  <div id="interstitial" style="position:fixed;inset:0;z-index:10000">
    Continue in Safari to finish
    <a id="schemelink" href="googlechrome://navigate?url=acme.com">Continue in Safari</a>
  </div>
  <form id="applyform"><input id="email" name="email"><button id="apply">Apply now</button></form>
  <footer id="foot">
    Also on mobile: <a id="footstore" href="https://play.google.com/store/apps/details?id=com.acme">our Android app</a>
    <a id="normal" href="https://acme.com/jobs/2">Another role</a>
  </footer>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  // ── NO_EXIT_JS ──────────────────────────────────────────────────────────────────────────────
  console.log('\nno exit ramps out of a half-filled application');
  await page.route('https://jobs.acme.com/**', (r) => r.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto('https://jobs.acme.com/role/1');
  await page.evaluate(BRIDGE);
  await page.evaluate((js) => { eval(js); }, NO_EXIT_JS);
  await page.waitForTimeout(200);

  const st = await page.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); return e ? getComputedStyle(e).display !== 'none' : null; };
    const href = (id) => { const e = document.getElementById(id); return e ? e.getAttribute('href') : null; };
    return {
      banner: vis('appbanner'), interstitial: vis('interstitial'), cookies: vis('cookies'),
      form: vis('applyform'), foot: vis('foot'),
      storelink: href('storelink'), schemelink: href('schemelink'),
      footstore: href('footstore'), normal: href('normal'),
      meta: !!document.querySelector('meta[name="apple-itunes-app"]'),
      callout: (document.getElementById('__cvf_noexit_css') || {}).textContent || '',
    };
  });

  ok('the "Open in the app" banner is gone', st.banner === false, st.banner);
  ok('the "Continue in Safari" interstitial is gone', st.interstitial === false, st.interstitial);
  ok('its app-scheme link is defused too', st.schemelink === null, st.schemelink);
  ok('the store link inside the banner is defused', st.storelink === null, st.storelink);
  ok('the iOS Smart App Banner meta tag is removed', st.meta === false, st.meta);
  ok('long-press callouts are suppressed on links and images',
    /a,img\{-webkit-touch-callout:none/.test(st.callout), st.callout);

  // ⚠️ THE FALSE-POSITIVE HALF. Hiding a real banner is worth nothing if the same rule can hide the
  // Apply button — that would be a far worse bug than the one being fixed.
  console.log('\n…and nothing else on the page is touched');
  ok('the application form is untouched', st.form === true, st.form);
  ok('a cookie notice is NOT mistaken for an exit ramp', st.cookies === true, st.cookies);
  ok('the footer survives', st.foot === true, st.foot);
  ok('a store link in ordinary page content loses only its href', st.footstore === null, st.footstore);
  ok('…and does not take the footer down with it', st.foot === true, st.foot);
  ok('an ordinary job link is left completely alone',
    st.normal === 'https://acme.com/jobs/2', st.normal);

  // ⚠️ THE RULE THAT REPLACED THE HEIGHT CAP, TESTED DIRECTLY. A full-screen fixed overlay is
  // removable — unless it holds a form field, which is the shape of a login wall the user is
  // supposed to fill in, not an exit ramp. Hiding one of those would lock them out of the job.
  const wall = await page.evaluate((js) => {
    const d = document.createElement('div');
    d.id = 'loginwall';
    d.setAttribute('style', 'position:fixed;inset:0;z-index:10000');
    d.innerHTML = 'Sign in to continue, or open in the app'
      + '<a href="https://apps.apple.com/app/id1">Get the app</a>'
      + '<input type="password" name="pw"><button>Sign in</button>';
    document.body.appendChild(d);
    // Re-running the script is a no-op (the __cvfNoExit latch), so this waits for the
    // MutationObserver the FIRST run installed — which is how it works on a real page too.
    return new Promise((res) => setTimeout(() => {
      const e = document.getElementById('loginwall');
      res({ shown: getComputedStyle(e).display !== 'none',
            field: !!e.querySelector('input[name=pw]'),
            store: !!e.querySelector('a[href^="https://apps.apple.com"]') });
    }, 1400));
  }, NO_EXIT_JS);
  ok('a full-screen overlay holding a form field is NEVER hidden', wall.shown === true, wall);
  ok('…its input survives', wall.field === true, wall);
  ok('…and its store link is still defused', wall.store === false, wall);

  // A page that keeps mutating must not keep us working forever.
  const runs = await page.evaluate(async () => {
    for (let i = 0; i < 60; i++) {
      const d = document.createElement('div');
      d.innerHTML = '<a href="itms-apps://x">Get the app</a>';
      document.body.appendChild(d);
    }
    await new Promise((r) => setTimeout(r, 1200));
    return document.querySelectorAll('a[href^="itms-apps"]').length;
  });
  ok('late-injected app-scheme links are defused as they appear', runs === 0, runs);

  // ── GOOGLE_AUTH_WATCH_JS ────────────────────────────────────────────────────────────────────
  // ⚠️ THE POINT OF THIS SCRIPT IS RESTRAINT. It replaced a rule that cancelled Google outright, so
  // the test that matters most is the one where it says NOTHING.
  console.log('\nGoogle sign-in: report a refusal, never predict one');
  const google = async (body, waitMs) => {
    const p = await ctx.newPage();
    await p.route('https://accounts.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body }));
    await p.goto('https://accounts.google.com/o/oauth2/v2/auth?client_id=x');
    await p.evaluate(BRIDGE);
    await p.evaluate((js) => { eval(js); }, GOOGLE_AUTH_WATCH_JS);
    await p.waitForTimeout(waitMs);
    const m = await p.evaluate(() => window.__msgs.filter((x) => x.type === 'GOOGLE_AUTH_BLOCKED'));
    await p.close();
    return m;
  };

  const working = await google('<html><body><h1>Sign in</h1><form><input type="email" name="identifier"><button>Next</button></form></body></html>', 4600);
  ok('a WORKING Google sign-in page raises nothing (this is the whole fix)',
    working.length === 0, working);

  const refused = await google('<html><body><h2>This browser or app may not be secure</h2><p>Try using a different browser.</p></body></html>', 2000);
  ok('Google’s own refusal page is reported', refused.length === 1 && refused[0].reason === 'refused', refused);

  // ⚠️ THE b190 REGRESSION, PINNED DOWN. An empty page used to raise "Google turned down the
  // sign-in". It must not: a blank page is already visible to the user, and the same branch fired
  // from a background iframe during ordinary browsing. It is telemetry now, and telemetry only.
  const blank = await google('<html><body></body></html>', 9600);
  ok('an empty page NEVER claims Google refused', blank.length === 0, blank);

  // ⚠️ THE EXACT SHAPE THAT REACHED THE USER. Every site with a Google button embeds a hidden
  // accounts.google.com iframe, and our scripts run in every frame
  // (injectedJavaScriptForMainFrameOnly={false}). The watcher must be inert in all of them.
  const framed = await ctx.newPage();
  await framed.route('https://www.glassdoor.com/**', (r) => r.fulfill({ contentType: 'text/html', body:
    '<html><body><h1>Senior Engineer</h1>'
    + '<iframe src="https://accounts.google.com/gsi/iframe/select?client_id=x" style="width:1px;height:1px;border:0"></iframe>'
    + '</body></html>' }));
  await framed.route('https://accounts.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
  await framed.goto('https://www.glassdoor.com/job-listing/x.htm');
  for (const f of framed.frames()) {
    try { await f.evaluate(BRIDGE); } catch (e) {}
    try { await f.evaluate((js) => { eval(js); }, GOOGLE_AUTH_WATCH_JS); } catch (e) {}
  }
  await framed.waitForTimeout(10000);
  let framedMsgs = [];
  for (const f of framed.frames()) {
    try { framedMsgs = framedMsgs.concat(await f.evaluate(() => window.__msgs || [])); } catch (e) {}
  }
  await framed.close();
  ok('a hidden Google One Tap iframe raises NOTHING (this is what the user actually hit)',
    framedMsgs.length === 0, framedMsgs);

  // Not every accounts.google.com URL is a sign-in page either.
  const nonAuth = await ctx.newPage();
  await nonAuth.route('https://accounts.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
  await nonAuth.goto('https://accounts.google.com/');
  await nonAuth.evaluate(BRIDGE);
  await nonAuth.evaluate((js) => { eval(js); }, GOOGLE_AUTH_WATCH_JS);
  await nonAuth.waitForTimeout(7000);
  const naMsgs = await nonAuth.evaluate(() => window.__msgs.length);
  await nonAuth.close();
  ok('accounts.google.com root is not watched at all', naMsgs === 0, naMsgs);

  // "Couldn't sign you in" is a WRONG-PASSWORD message too — it must not read as a webview refusal.
  const wrongPw = await google('<html><body><h1>Couldn’t sign you in</h1><form><input type="password"><button>Try again</button></form></body></html>', 4600);
  ok('a wrong-password page is not mistaken for a refusal', wrongPw.length === 0, wrongPw);

  // The telemetry half: a real sign-in page still reports what it looked like, silently.
  const seen = await ctx.newPage();
  await seen.route('https://accounts.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html><body><h1>Sign in</h1><form><input type="email"><button>Next</button></form></body></html>' }));
  await seen.goto('https://accounts.google.com/o/oauth2/v2/auth?client_id=x');
  await seen.evaluate(BRIDGE);
  await seen.evaluate((js) => { eval(js); }, GOOGLE_AUTH_WATCH_JS);
  await seen.waitForTimeout(7000);
  const seenMsgs = await seen.evaluate(() => window.__msgs);
  await seen.close();
  ok('a real sign-in page is recorded for diagnosis, without alerting',
    seenMsgs.length === 1 && seenMsgs[0].type === 'GOOGLE_AUTH_SEEN' && seenMsgs[0].refused === false, seenMsgs);

  const other = await ctx.newPage();
  await other.route('https://www.glassdoor.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html><body>This browser or app may not be secure</body></html>' }));
  await other.goto('https://www.glassdoor.com/job-listing/x.htm');
  await other.evaluate(BRIDGE);
  await other.evaluate((js) => { eval(js); }, GOOGLE_AUTH_WATCH_JS);
  await other.waitForTimeout(2000);
  const off = await other.evaluate(() => window.__msgs.length);
  ok('the watcher is inert anywhere but accounts.google.com', off === 0, off);

  // ── PASSKEY: the option must never be OFFERED ───────────────────────────────────────────────
  // ⚠️ Glassdoor showed a passkey button and then "something went wrong". Rejecting the ceremony
  // was not enough — by the time get() fails the site has already committed to that path. What
  // decides whether the button appears at all is the feature detection below, run exactly the way
  // a real site runs it. Indeed never offered one; this makes every site behave like Indeed.
  console.log('\npasskeys: the option is never offered, not merely refused');
  const pk = await ctx.newPage();
  await pk.route('https://www.glassdoor.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html><body><form><input name=u></form></body></html>' }));
  await pk.goto('https://www.glassdoor.com/member/profile/login');
  await pk.evaluate(BRIDGE);
  const det = await pk.evaluate(async (js) => {
    // A page that captured the reference BEFORE our guard ran — the hardest case.
    const captured = window.PublicKeyCredential;
    eval(js);
    const out = { hasGlobal: typeof window.PublicKeyCredential !== 'undefined' };
    try { out.iuvpaa = await captured.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (e) { out.iuvpaa = 'threw'; }
    try { out.conditional = await captured.isConditionalMediationAvailable(); } catch (e) { out.conditional = 'threw'; }
    try { await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(8) } }); out.get = 'resolved'; }
    catch (e) { out.get = e.name; }
    // the password manager path must survive
    try { await navigator.credentials.get({ password: true }); out.pw = 'ok'; } catch (e) { out.pw = 'ok:' + e.name; }
    out.msgs = window.__msgs.map((m) => m.type);
    return out;
  }, PASSKEY_GUARD_JS);
  await pk.close();

  ok('window.PublicKeyCredential is gone — the check sites branch on', det.hasGlobal === false, det);
  ok('isUserVerifyingPlatformAuthenticatorAvailable() answers false, even on a captured reference',
    det.iuvpaa === false, det);
  ok('isConditionalMediationAvailable() answers false too (passkey autofill)', det.conditional === false, det);
  ok('a ceremony attempted anyway still gets NotAllowedError, never a hanging promise',
    det.get === 'NotAllowedError', det);
  ok('password-manager credentials.get({password}) is untouched', String(det.pw).startsWith('ok'), det);
  ok('and it reports both what it hid and what it blocked',
    det.msgs.includes('PASSKEY_HIDDEN') && det.msgs.includes('PASSKEY_BLOCKED'), det.msgs);

  const jdSrc = require('fs').readFileSync(require('path').join(__dirname, '../app/(ai-hub)/job-detail.tsx'), 'utf8');
  ok('the guard runs at document-START, before the page can feature-detect',
    /injectedJavaScriptBeforeContentLoaded=\{FRAME_GUARD_JS \+ '\\n' \+ PASSKEY_GUARD_JS/.test(jdSrc));

  // ── PASSKEY: the SERVER-RENDERED button — the case b193 missed ─────────────────────────────
  // Indeed's login is SSR: for an account with a passkey registered, the server draws the button
  // before any client JS asks anything. Feature-detection lies cannot remove it; the DOM sweep must.
  console.log('\npasskeys: a server-drawn button is hidden too');
  const ssr = await ctx.newPage();
  await ssr.route('https://secure.indeed.com/**', (r) => r.fulfill({ contentType: 'text/html', body:
    '<html><body>'
    + '<button id="pkbtn">Continue with a passkey</button>'
    + '<button id="pwbtn">Sign in with password</button>'
    + '<p id="pktext">Passkeys are a safer alternative to passwords, and this paragraph about them must never be hidden.</p>'
    + '</body></html>' }));
  await ssr.goto('https://secure.indeed.com/auth');
  await ssr.evaluate(BRIDGE);
  await ssr.evaluate((js) => { eval(js); }, PASSKEY_GUARD_JS);
  await ssr.waitForTimeout(300);
  const ssrSt = await ssr.evaluate(async () => {
    const vis = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
    const before = { pk: vis('pkbtn'), pw: vis('pwbtn'), text: vis('pktext') };
    // and an SPA that renders the option a beat later
    const d = document.createElement('button'); d.id = 'pklate'; d.textContent = 'Use passkey'; document.body.appendChild(d);
    await new Promise((r) => setTimeout(r, 900));
    return { ...before, late: vis('pklate'), msgs: window.__msgs.map((m) => m.type) };
  });
  await ssr.close();
  ok('the server-drawn passkey button is hidden', ssrSt.pk === false, ssrSt);
  ok('the password button is untouched', ssrSt.pw === true, ssrSt);
  ok('a paragraph ABOUT passkeys is content, not a control — it stays', ssrSt.text === true, ssrSt);
  ok('a passkey button rendered later by an SPA is hidden as it appears', ssrSt.late === false, ssrSt);
  ok('and the hide is reported', ssrSt.msgs.includes('PASSKEY_UI_HIDDEN'), ssrSt.msgs);

  // ── The Glassdoor→Indeed reroute clicker ───────────────────────────────────────────────────
  console.log('\nGlassdoor Google tap: we press the working door ourselves');
  const gd = await ctx.newPage();
  await gd.route('https://www.glassdoor.com/**', (r) => r.fulfill({ contentType: 'text/html', body:
    '<html><body>'
    + '<button id="g">Continue with Google</button>'
    + '<button id="e" onclick="window.__pressed=true">Continue with Apple or email</button>'
    + '</body></html>' }));
  await gd.goto('https://www.glassdoor.com/member/profile/login');
  await gd.evaluate(BRIDGE);
  const gdSt = await gd.evaluate((js) => { eval(js); return { pressed: !!window.__pressed, msgs: window.__msgs }; }, GD_EMAIL_ROUTE_JS);
  ok('it finds and clicks "Continue with Apple or email"', gdSt.pressed === true, gdSt);
  ok('…and reports found:true', gdSt.msgs.some((m) => m.type === 'GD_ROUTE' && m.found === true), gdSt.msgs);
  const gdNone = await gd.evaluate((js) => {
    document.body.innerHTML = '<button>Continue with Google</button>';
    window.__msgs = [];
    eval(js);
    return window.__msgs;
  }, GD_EMAIL_ROUTE_JS);
  await gd.close();
  ok('a page without that button reports found:false so the app can explain instead',
    gdNone.some((m) => m.type === 'GD_ROUTE' && m.found === false), gdNone);

  // ── A scripted app-scheme window.open must never reach the system ──────────────────────────
  // Field report (v4.5 prod): "Open in Google popup on Search Results". Google's results page
  // calls window.open('googleapp://…') from SCRIPT — no click for the interceptor to catch — and
  // the old hook only claimed http(s), so the scheme fell through to the native shim, which hands
  // what it cannot open to the OS: the "Open in Google?" sheet.
  console.log('\napp-scheme window.open dies in the page, never at the OS');
  const sw = await ctx.newPage();
  await sw.route('https://www.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html><body><h1>Results</h1></body></html>' }));
  await sw.goto('https://www.google.com/search?q=jobs');
  await sw.evaluate(BRIDGE);
  const wo = await sw.evaluate((js) => {
    let reachedReal = 0;
    const orig = window.open;
    window.open = function () { reachedReal++; return null; };   // stands in for the native shim
    eval(js);                                                    // AUTH_FLOW_JS wraps the spy
    const r1 = window.open('googleapp://open?url=x');
    const r2 = window.open('intent://jobs#Intent;scheme=https;package=com.google.android.googlequicksearchbox;end');
    const r3 = window.open('https://employer.example/jobs/1');
    window.open('about:blank');
    return { reachedReal, r1closed: r1 && r1.closed === true, r2closed: r2 && r2.closed === true,
             r3stub: !!(r3 && r3.opener), msgs: window.__msgs.map((m) => m.type) };
  }, AUTH_FLOW_JS);
  await sw.close();
  ok('googleapp:// and intent:// never reach the real window.open (only about:blank may)',
    wo.reachedReal === 1, wo);
  ok('the page gets a dead stub back, so its JS keeps working', wo.r1closed && wo.r2closed, wo);
  ok('http(s) popups still enter the auth flow', wo.r3stub && wo.msgs.includes('AUTH_POPUP'), wo);
  ok('the block is reported, not silent', wo.msgs.filter((t) => t === 'STAY_BLOCKED_SCHEME').length === 2, wo.msgs);

  const bf2 = fs.readFileSync(path.join(__dirname, '../components/BrowseFetch.tsx'), 'utf8');
  const jd3 = fs.readFileSync(path.join(__dirname, '../app/(ai-hub)/job-detail.tsx'), 'utf8');
  ok('BrowseFetch onOpenWindow forwards http(s) only',
    /onOpenWindow[\s\S]{0,400}\/\^https\?:\/i\.test\(target\)\) beginAuthFlow/.test(bf2));
  ok('the apply view onOpenWindow forwards http(s) only (mailto keeps its compose)',
    /onOpenWindow[\s\S]{0,600}\/\^https\?:\/i\.test\(target\)\) beginAuthFlow/.test(jd3));

  await browser.close();
  console.log(`\nno-exit + google-auth: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
