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
const evalTpl = (body, helpers, wiz) => new Function('JS_HELPERS', 'WIZARD_HELPERS', 'return `' + body + '`;')(helpers, wiz || '');
const JS_HELPERS = evalTpl(raw('JS_HELPERS'), '');
const WIZARD_HELPERS = evalTpl(raw('WIZARD_HELPERS'), JS_HELPERS);
const grab = (name) => evalTpl(raw(name), JS_HELPERS, WIZARD_HELPERS);
const FRAME_GUARD_JS = grab('FRAME_GUARD_JS');
const AUTH_FLOW_JS = grab('AUTH_FLOW_JS');
const INTERCEPT_FILES_JS = grab('INTERCEPT_FILES_JS');
const FOCUS_DETECT_JS = grab('FOCUS_DETECT_JS');
const READ_FIELDS_JS = grab('READ_FIELDS_JS');
const WIZARD_PROBE_JS = grab('WIZARD_PROBE_JS');
// Pull the template literal returned by `function NAME(...){ … return `…`; }`, so the fill script
// under test is byte-identical to the one that ships.
function rawFn(name) {
  const m = SRC.match(new RegExp('function ' + name + '\\([^)]*\\)[^{]*\\{[\\s\\S]*?return `([\\s\\S]*?)`;\\s*\\}'));
  if (!m) throw new Error('could not extract fn ' + name);
  return m[1];
}
const FILL_BODY = rawFn('fillJs');
const fillJs = (values) => new Function('JS_HELPERS', 'values', 'return `' + FILL_BODY + '`;')(JS_HELPERS, values);

// The bridge our scripts post through, plus a sink we can read back.
const BRIDGE = `window.__msgs=[];window.ReactNativeWebView={postMessage:function(s){window.__msgs.push(JSON.parse(s));}};`;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
};

// ── SOURCE HYGIENE for the JS_HELPERS template literal ────────────────────────────────────────
// Two footguns have each shipped a broken build from this one string, so they are now asserted:
//   * a BACKTICK anywhere inside it (even in a comment) terminates the literal — TS1005, far from
//     the actual line;
//   * a SINGLE backslash is eaten by the template literal, so a regex written as \s in the source
//     reaches the page as s. That is silent: /(^|\s)chip/ became /(^|s)chip/ and matched nothing,
//     and the only symptom was a widget quietly not being recognised.
function helpersSourceProblems() {
  const m = SRC.match(new RegExp('const JS_HELPERS = `([\\s\\S]*?)`;\\n'));
  const body = m ? m[1] : '';
  const ticks = (body.match(/`/g) || []).length;
  const ctrl = [...body].filter((c) => c.charCodeAt(0) < 32 && !'\n\r\t'.includes(c)).length;
  const singles = [];
  body.split('\n').forEach((l, i) => {
    const re = /(?<!\\)\\(?!\\)(.)/g;
    let x;
    while ((x = re.exec(l))) singles.push({ line: i + 1, esc: x[0], text: l.trim().slice(0, 80) });
  });
  return { ticks, ctrl, singles };
}

(async () => {
  const browser = await chromium.launch();

  console.log('\nJS_HELPERS source hygiene');
  const hyg = helpersSourceProblems();
  ok('no backtick inside the JS_HELPERS template literal', hyg.ticks === 0, hyg.ticks);
  ok('no literal control character inside it', hyg.ctrl === 0, hyg.ctrl);
  ok('no single-backslash escape (the template literal eats it)', hyg.singles.length === 0, hyg.singles.slice(0, 4));

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
    // A faithful react-select: the menu renders only after mousedown on .select__control, picking a
    // row CLEARS the input and writes .select__single-value. Setting input.value does nothing at all.
    if (url.includes('combo.example.com')) {
      body = `<html><body><form id="f">
        <label id="country-label">Country code</label>
        <div class="select__control"><div class="select__value-container">
          <div class="select__input-container">
            <input class="select__input" id="country" type="text" role="combobox"
                   aria-expanded="false" aria-controls="menu" aria-labelledby="country-label">
          </div></div></div>
        <div id="menu" role="listbox"></div>
        <label for="plain">Full name</label><input id="plain" name="plain">
        <button type="submit" id="go">Submit application</button>
        <script>
          window.__submits=0;
          document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();window.__submits++;});
          var OPTS=['India +91','United Kingdom +44','Canada +1'];
          var ctrl=document.querySelector('.select__control'), inp=document.getElementById('country'),
              menu=document.getElementById('menu'), open=false;
          function render(){
            menu.innerHTML='';
            if(!open){ inp.setAttribute('aria-expanded','false'); return; }
            inp.setAttribute('aria-expanded','true');
            OPTS.filter(function(o){return !inp.value||o.toLowerCase().indexOf(inp.value.toLowerCase())===0;})
              .forEach(function(o){
                var d=document.createElement('div'); d.setAttribute('role','option'); d.textContent=o;
                d.addEventListener('mousedown',function(){
                  var sv=document.createElement('div'); sv.className='select__single-value'; sv.textContent=o;
                  ctrl.querySelector('.select__value-container').appendChild(sv);
                  inp.value=''; open=false; render();
                });
                menu.appendChild(d);
              });
          }
          ctrl.addEventListener('mousedown',function(){ open=true; setTimeout(render,50); });
          inp.addEventListener('input', function(){ setTimeout(render,10); });
          // react-select closes its menu on Escape and on blur — model both, or the "leaves the
          // popup closed" assertion is testing a widget less capable than the real one.
          inp.addEventListener('keydown', function(e){ if(e.key==='Escape'){ open=false; render(); } });
          inp.addEventListener('blur', function(){ open=false; setTimeout(render,0); });
        </script></form></body></html>`;
    }
    // Revolut's rui kit, faithfully: every dropdown is an <input type=button aria-haspopup=listbox>.
    // Typing into the trigger does NOTHING — clicking it opens a popup with its own SEARCH input and
    // option rows; picking writes the trigger's .value and closes. Includes the phone pair (dial
    // trigger + tel input), which is the "+91 pasted next to +91" case.
    if (url.includes('rui.example.com')) {
      body = `<html><body><form id="f">
        <label id="cc-label">Phone country code</label>
        <input id="cc" type="button" aria-haspopup="listbox" aria-label="Search phone country codes" placeholder=" ">
        <label for="phone">Phone number</label><input id="phone" name="phoneNumber" type="tel" placeholder="Phone number">
        <label id="cty-label">Current country</label>
        <input id="cty" type="button" aria-haspopup="listbox" placeholder=" ">
        <div id="pop" style="display:none"></div>
        <button type="submit" id="go">Submit application</button>
        <script>
          window.__submits=0;
          document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();window.__submits++;});
          var CC=['United Kingdom +44','India +91','United States +1'];
          var CTY=['United Kingdom','India','Portugal','United States'];
          function wire(trigId, opts){
            var trig=document.getElementById(trigId), pop=document.getElementById('pop');
            function close(){ pop.style.display='none'; pop.innerHTML=''; }
            trig.addEventListener('blur', function(){ setTimeout(function(){ if(!pop.contains(document.activeElement)) close(); }, 0); });
            trig.addEventListener('keydown', function(e){ if(e.key==='Escape') close(); });
            trig.addEventListener('click', function(){
              pop.setAttribute('role','listbox');
              pop.innerHTML='<input id="popsearch" type="text" placeholder="Search">';
              pop.style.display='block';
              var search=pop.querySelector('#popsearch');
              function render(){
                Array.prototype.slice.call(pop.querySelectorAll('[role=option]')).forEach(function(n){n.remove();});
                opts.filter(function(o){ var q=(search.value||'').toLowerCase(); return !q||o.toLowerCase().indexOf(q)>=0; })
                  .forEach(function(o){
                    var d=document.createElement('div'); d.setAttribute('role','option'); d.textContent=o;
                    d.addEventListener('click', function(){ trig.value=o; close(); });
                    pop.appendChild(d);
                  });
              }
              search.addEventListener('input', render);
              render();
            });
          }
          wire('cc', CC); wire('cty', CTY);
        </script></form></body></html>`;
    }
    // Power-up fixture: multi-select, native date, reworded radio options, and a control far
    // below the fold (the classes of field the engine used to leave empty).
    if (url.includes('power.example.com')) {
      body = `<html><body><form id="f">
        <label for="locs">Preferred work locations</label>
        <select id="locs" name="locs" multiple>
          <option value="ldn">London</option><option value="rem">UK - Remote</option>
          <option value="ber">Berlin</option><option value="nyc">New York</option>
        </select>
        <label for="start">Earliest start date</label><input id="start" name="start" type="date">
        <fieldset><legend>Do you consent to interview transcripts?</legend>
          <label><input type="radio" name="consent" value="y"> Yes, I consent</label>
          <label><input type="radio" name="consent" value="n"> No, I don't consent</label>
        </fieldset>
        <label for="edu">Highest education</label>
        <select id="edu" name="edu">
          <option value="">Select…</option>
          <option value="bsc">Bachelor of Science</option>
          <option value="msc">Master of Science</option>
        </select>
        <div style="height:2400px"></div>
        <label for="deep">Notice period</label><input id="deep" name="deep">
        <button type="submit" id="go">Submit application</button>
        <script>
          window.__submits=0;
          document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();window.__submits++;});
        </script></form></body></html>`;
    }
    // GROUPS fixture — the shapes measured on real forms, as an offline regression net:
    //   * a NAMED checkbox group (Lever): every member shares one name, which used to collapse the
    //     whole group onto one key and keep only the first box;
    //   * an UNNAMED radio pair (Revolut's design system emits no name at all);
    //   * an opacity-0 radio pair under visible pills (Workable's required questions);
    //   * a hidden checkbox inside a COOKIE BANNER, which must stay excluded — it is not a question
    //     the employer is asking (measured on Cambio, whose 3 hidden boxes are banner categories);
    //   * a lone consent checkbox, which must be flagged so the review panel can name it.
    if (url.includes('groups.example.com')) {
      body = `<html><body>
        <div id="cookie-banner" class="cookiebanner">
          <label style="opacity:0"><input type="checkbox" name="ck_analytics"> Analytics cookies</label>
          <label style="opacity:0"><input type="checkbox" name="ck_ads"> Advertising cookies</label>
        </div>
        <form id="f">
          <div class="q"><p>Which active license do you have?</p>
            <label><input type="checkbox" name="lic" value="licsw"> LICSW</label>
            <label><input type="checkbox" name="lic" value="lisw"> LISW</label>
            <label><input type="checkbox" name="lic" value="lcpc"> LCPC</label>
          </div>
          <div class="q"><p>Do you consent to interview transcripts?</p>
            <span><label><input type="radio"> Yes, I consent</label>
                  <label><input type="radio"> No, I don't consent</label></span>
          </div>
          <div class="q"><p>Are you based in UAE ?</p>
            <span><label class="pill"><input type="radio" name="uae" required style="opacity:0;width:13px;height:13px"> YES</label>
                  <label class="pill"><input type="radio" name="uae" required style="opacity:0;width:13px;height:13px"> NO</label></span>
          </div>
          <label><input type="checkbox" name="gdpr"> I agree to the processing of my personal data</label>
          <button type="submit" id="go">Submit application</button>
        </form>
        <script>
          window.__submits=0;
          document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();window.__submits++;});
        </script></body></html>`;
    }
    // A react-select INSIDE a modal that closes on a document-level (bubble-phase) Escape — exactly
    // the YC "Apply for this role" popup. Autofill's combobox-close Escape must NOT dismiss it.
    if (url.includes('modal.example.com')) {
      body = `<html><body>
        <div id="dlg" role="dialog" aria-modal="true"><form id="f">
          <label id="country-label">Country code</label>
          <div class="select__control"><div class="select__value-container">
            <div class="select__input-container">
              <input class="select__input" id="country" type="text" role="combobox"
                     aria-expanded="false" aria-controls="menu" aria-labelledby="country-label">
            </div></div></div>
          <div id="menu" role="listbox"></div>
          <label for="plain">Full name</label><input id="plain" name="plain">
          <button type="submit" id="go">Submit application</button>
        </form></div>
        <script>
          window.__modalOpen = true; window.__submits = 0;
          document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();window.__submits++;});
          document.addEventListener('keydown', function(e){
            if(e.key==='Escape'){ window.__modalOpen = false; document.getElementById('dlg').style.display='none'; }
          });
          var ctrl=document.querySelector('.select__control'), inp=document.getElementById('country'),
              menu=document.getElementById('menu'), open=false, OPTS=['India +91','United Kingdom +44','Canada +1'];
          function render(){ menu.innerHTML=''; if(!open){ inp.setAttribute('aria-expanded','false'); return; }
            inp.setAttribute('aria-expanded','true');
            OPTS.forEach(function(o){ var d=document.createElement('div'); d.setAttribute('role','option'); d.textContent=o; menu.appendChild(d); }); }
          ctrl.addEventListener('mousedown',function(){ open=true; setTimeout(render,50); });
          // react-select closes its OWN menu on blur (no keydown handler → proves it closes w/o Escape).
          inp.addEventListener('blur', function(){ open=false; setTimeout(render,0); });
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

  // ── country / dial codes ───────────────────────────────────────────────────
  console.log('\ncountry + dial-code matching (JS_HELPERS)');
  {
    const H = new Function('return (function(){' + JS_HELPERS +
      ';return {pickDial:pickDial,dialOf:dialOf,isPhoneCodeOpts:isPhoneCodeOpts,sameAnswer:sameAnswer};})();')();
    const L = [['United States', 'US', '1'], ['Guam', 'GU', '1'], ['Canada', 'CA', '1'], ['Puerto Rico', 'PR', '1'],
               ['United Kingdom', 'GB', '44'], ['Jersey', 'JE', '441534'], ['Guernsey', 'GG', '441481'],
               ['Russia', 'RU', '7'], ['Kazakhstan', 'KZ', '7'], ['India', 'IN', '91'], ['Indonesia', 'ID', '62'],
               ['United Arab Emirates', 'AE', '971'], ['Italy', 'IT', '39'], ['Vatican City', 'VA', '39'],
               ['Bangladesh', 'BD', '880'], ['Norway', 'NO', '47'], ['Svalbard', 'SJ', '47']]
      .map(([n, v, d]) => ({ text: n + '+' + d, value: v }));
    const t = (v, exp) => ok(`pickDial(${JSON.stringify(v)}) → ${exp}`,
      (H.pickDial(L, v) || {}).text === exp, (H.pickDial(L, v) || {}).text);
    t('+91', 'India+91'); t('91', 'India+91'); t('India', 'India+91'); t('IN', 'India+91');
    t('+1', 'United States+1');        // the old substring matcher returned NULL here
    t('+44', 'United Kingdom+44');     // not Jersey / Guernsey
    t('+7', 'Russia+7');               // not Kazakhstan
    t('+39', 'Italy+39'); t('+62', 'Indonesia+62'); t('+971', 'United Arab Emirates+971');
    ok('NBSP + bidi padding is ignored', (H.pickDial(L, '‎+91 ') || {}).text === 'India+91');
    // the regression this replaced: \d[\d\s-]{0,5} swallowed the national number
    ok('dialOf stops at the country code', H.dialOf('+91 98765 43210') === '91', H.dialOf('+91 98765 43210'));
    ok('a plain country list is not a dial list',
       H.isPhoneCodeOpts([{ text: 'Afghanistan' }, { text: 'Albania' }, { text: 'India' }]) === false);
    ok('a reformatted date reads back as filled', H.sameAnswer('09/01/2026', '2026-09-01') === true);
    ok('a transposed phone number does NOT read back as filled',
       H.sameAnswer('+1 415 555 0123', '+1 415 555 0132') === false);
  }

  console.log('\nplaceholder / page-default <select> vs the user\'s own answer');
  {
    const page = await ctx.newPage();
    await page.goto('https://portal.example.com/x');
    const r = await page.evaluate(`(function(){ ${JS_HELPERS}
      document.body.innerHTML='<label for="a">Country code</label>'
        +'<select id="a"><option value="">Select country</option><option value="US">United States (+1)</option><option value="IN">India (+91)</option></select>'
        +'<label for="b">Country code</label>'
        +'<select id="b"><option value="US" selected>United States (+1)</option><option value="IN">India (+91)</option></select>'
        +'<label for="c">Country code</label>'
        +'<select id="c"><option value="">Select</option><option value="US">United States (+1)</option><option value="IN">India (+91)</option></select>'
        +'<label for="d">Do you consent to a background check?</label>'
        +'<select id="d"><option value="Yes">Yes</option><option value="No">No</option></select>'
        +'<label for="e">Preferred contract type</label>'
        +'<select id="e"><option value="">Select…</option><option value="ft">Full time</option><option value="pt">Part time</option></select>';
      function set(id, want){ var el=document.getElementById(id);
        if(keepUser(el,'select-one',want)) return 'SKIPPED';
        var oarr=Array.prototype.slice.call(el.options);
        var m=isCountrySelect(el)?pickDial(oarr,want):null; if(!m) m=pickOpt(el.options,want);
        if(!m) return 'NO-MATCH';
        setNative(el,m.value); var so=el.options[el.selectedIndex];
        return (so&&(so===m||cleanTxt(so.text)===cleanTxt(m.text))) ? so.text : 'REJECTED'; }
      // 'c' was set by SCRIPT (a geo-IP default) — indistinguishable in the DOM from a real choice,
      // so it is only respected when the touch flag says a person did it.
      var c=document.getElementById('c'); c.selectedIndex=2;
      var cScript=keepUser(c,'select-one','+91');
      c.__cvfTouched=true;                                       // now: the user picked it by hand
      var cTouched=keepUser(c,'select-one','+91');
      var d=document.getElementById('d');                        // their answer sits at INDEX 0
      return { a:set('a','+91'), b:set('b','+91'), cScript:cScript, cTouched:cTouched,
               d:keepUser(d,'select-one','No'), dDef:d.options[0].defaultSelected, e:set('e','Full time') };
    })()`);
    ok('a "Select country" placeholder no longer blocks the fill', r.a === 'India (+91)', r.a);
    ok('a select defaulted to United States (+1) is changed to +91', r.b === 'India (+91)', r.b);
    ok('a country set by the PAGE (geo-IP) is overridable', r.cScript === false, r.cScript);
    ok('a country the USER actually chose is respected', r.cTouched === true, r.cTouched);
    ok('an index-0 Yes/No consent answer is NOT overwritten', r.d === true, { d: r.d, def: r.dDef });
    ok('an empty-value placeholder on a NON-country select fills too', r.e === 'Full time', r.e);
    await page.close();
  }

  // ── custom dropdowns (the react-select contract) ───────────────────────────
  console.log('\ncustom dropdowns: clicked, verified, never falsely counted');
  {
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE);
    await page.goto('https://combo.example.com/apply');

    await page.evaluate(READ_FIELDS_JS);
    await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FIELDS'), null, { timeout: 30000 });
    const fields = (await page.evaluate(() => window.__msgs.find((m) => m.type === 'FIELDS'))).fields;
    const combo = fields.find((f) => f.label && f.label.indexOf('Country') >= 0);
    ok('the react-select field is scanned at all', !!combo, fields);
    ok('it is tagged widget:combobox', combo && combo.widget === 'combobox', combo);
    ok('its options are enumerated for the AI', combo && (combo.options || []).length === 3, combo && combo.options);
    ok('enumeration leaves the popup CLOSED',
       await page.evaluate(() => document.getElementById('country').getAttribute('aria-expanded')) === 'false');
    ok('enumeration selects nothing',
       await page.evaluate(() => document.querySelectorAll('.select__single-value').length) === 0);

    await page.evaluate(() => { window.__msgs.length = 0; });
    await page.evaluate(fillJs({ [combo.key]: 'India', 'n:plain|text': 'hello' }));
    await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 45000 });
    const st = await page.evaluate(() => ({
      msg: window.__msgs.find((m) => m.type === 'FILLED'),
      sv: (document.querySelector('.select__single-value') || {}).textContent || null,
      plain: document.getElementById('plain').value,
      submits: window.__submits,
    }));
    ok('the option is actually CLICKED, not value-set', st.sv === 'India +91', st);
    ok('a plain input still fills (no regression)', st.plain === 'hello', st.plain);
    ok('the combobox counts as filled', st.msg.count === 2, st.msg);
    ok('nothing is falsely reported as failed', (st.msg.failed || []).length === 0, st.msg.failed);
    ok('THE FORM WAS NEVER SUBMITTED', st.submits === 0, st.submits);
    await page.close();
  }

  console.log('\na dropdown answer the user picked by hand survives');
  {
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE);
    await page.goto('https://combo.example.com/apply');
    // react-select leaves input.value === '' after a pick, so el.value cannot detect their answer.
    // A REAL pick arrives through a trusted tap, which FOCUS_DETECT marks on the control — model
    // that flag too, or this test exercises a gesture no real user can produce.
    await page.evaluate(() => {
      const sv = document.createElement('div'); sv.className = 'select__single-value'; sv.textContent = 'Canada +1';
      document.querySelector('.select__value-container').appendChild(sv);
      document.getElementById('country').__cvfTouched = true;
    });
    await page.evaluate(fillJs({ 'i:country|text': 'India' }));
    await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 45000 });
    const svs = await page.evaluate(() => Array.from(document.querySelectorAll('.select__single-value')).map((n) => n.textContent));
    ok("the user's own dropdown choice is not wiped and re-picked", svs.length === 1 && svs[0] === 'Canada +1', svs);
    await page.close();
  }

  console.log('\nan UNTOUCHED dial-code default (geo-IP preselect) IS corrected');
  {
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE);
    await page.goto('https://combo.example.com/apply');
    // Same shown-value, but NO touch flag: this is the page's own preselection, nobody's answer —
    // the exact "+91 never applies because the box already reads United Kingdom (+44)" complaint.
    await page.evaluate(() => {
      const sv = document.createElement('div'); sv.className = 'select__single-value'; sv.textContent = 'United Kingdom +44';
      document.querySelector('.select__value-container').appendChild(sv);
    });
    await page.evaluate(fillJs({ 'i:country|text': '+91' }));
    await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 45000 });
    const svs = await page.evaluate(() => Array.from(document.querySelectorAll('.select__single-value')).map((n) => n.textContent));
    ok('the untouched default is re-picked to the profile dial code', svs.indexOf('India +91') >= 0, svs);
    await page.close();
  }

  console.log('\ntrigger-style dropdowns (Revolut rui): scanned, searched, picked, phone split');
  {
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE);
    await page.goto('https://rui.example.com/apply');
    // 1) the SCAN must now see button-shaped dropdowns and enumerate their options
    await page.evaluate(READ_FIELDS_JS);
    await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FIELDS'), null, { timeout: 45000 });
    const fields = await page.evaluate(() => window.__msgs.find((m) => m.type === 'FIELDS').fields);
    const cc = fields.find((f) => f.key === 'i:cc|button');
    const cty = fields.find((f) => f.key === 'i:cty|button');
    ok('the dial-code trigger is scanned as a combobox', !!cc && cc.widget === 'combobox', cc);
    ok('the country trigger is scanned as a combobox', !!cty && cty.widget === 'combobox', cty);
    ok('dial options were enumerated through the popup', !!cc && (cc.options || []).indexOf('India +91') >= 0, cc && cc.options);
    ok('country options were enumerated through the popup', !!cty && (cty.options || []).indexOf('Portugal') >= 0, cty && cty.options);
    // 2) the FILL must open each trigger, type into the POPUP's search box, and click the match —
    //    and the tel input must receive the LOCAL number because a dial control exists.
    await page.evaluate(fillJs({ 'i:cc|button': '+91', 'i:cty|button': 'India', 'n:phoneNumber|tel': '+91 79005 91039' }));
    await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 45000 });
    const st = await page.evaluate(() => ({
      cc: document.getElementById('cc').value,
      cty: document.getElementById('cty').value,
      phone: document.getElementById('phone').value,
      submits: window.__submits,
      msg: window.__msgs.find((m) => m.type === 'FILLED'),
    }));
    ok('the dial-code trigger picked +91', st.cc === 'India +91', st);
    ok('the country trigger picked India', st.cty === 'India', st);
    ok('the phone box got the LOCAL number (code stripped)', st.phone === '79005 91039', st.phone);
    ok('nothing reported failed', (st.msg.failed || []).length === 0, st.msg.failed);
    ok('THE FORM WAS NEVER SUBMITTED', st.submits === 0, st.submits);
    await page.close();
  }

  console.log('\npower-ups: multi-select, dates, reworded options, below-the-fold fields');
  {
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE);
    await page.goto('https://power.example.com/apply');
    await page.evaluate(fillJs({
      'n:locs|select-multiple': 'London, UK - Remote',       // comma list → several picks
      'n:start|date': '01/09/2026',                          // dd/mm/yyyy → yyyy-mm-dd
      'n:consent|radio': 'yes',                              // → "Yes, I consent"
      'n:edu|select-one': "Bachelor's degree",               // → "Bachelor of Science" (fuzzy)
      'n:deep|text': '30 days',                              // 2400px below the fold
    }));
    await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 45000 });
    const st = await page.evaluate(() => ({
      locs: Array.from(document.getElementById('locs').selectedOptions).map((o) => o.value),
      start: document.getElementById('start').value,
      consent: (document.querySelector('input[name=consent]:checked') || {}).value || null,
      edu: document.getElementById('edu').value,
      deep: document.getElementById('deep').value,
      submits: window.__submits,
      msg: window.__msgs.find((m) => m.type === 'FILLED'),
    }));
    ok('multi-select got BOTH locations', st.locs.length === 2 && st.locs.includes('ldn') && st.locs.includes('rem'), st.locs);
    ok('dd/mm/yyyy normalised for the native date input', st.start === '2026-09-01', st.start);
    ok('"yes" matched the reworded radio "Yes, I consent"', st.consent === 'y', st.consent);
    ok('"Bachelor\'s degree" matched "Bachelor of Science"', st.edu === 'bsc', st.edu);
    ok('a field 2400px below the fold still filled', st.deep === '30 days', st.deep);
    ok('THE FORM WAS NEVER SUBMITTED', st.submits === 0, st.submits);
    await page.close();
  }

  // ── GROUPS as one field, and hidden tick controls the applicant CAN see ───────────────────────
  console.log('\ngroups are scanned as ONE question with options');
  {
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE);
    await page.goto('https://groups.example.com/apply');
    await page.evaluate(READ_FIELDS_JS);
    await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FIELDS'), null, { timeout: 45000 });
    const f = await page.evaluate(() => window.__msgs.find((m) => m.type === 'FIELDS').fields);
    const lic = f.find((x) => (x.options || []).includes('LICSW'));
    const cons = f.find((x) => (x.options || []).some((o) => /I consent/.test(o)));
    const uae = f.find((x) => (x.options || []).includes('YES'));
    const gdpr = f.find((x) => /processing of my personal data/i.test(x.label || ''));
    ok('a NAMED checkbox group is one field with every member as an option',
       !!lic && lic.widget === 'checkboxgroup' && lic.options.length === 3, lic);
    ok('its key is still the name key, so old mappings and learned answers still land',
       !!lic && lic.key === 'n:lic|checkbox', lic && lic.key);
    ok('it carries the question, not its first box\'s label', !!lic && /active license/i.test(lic.label), lic && lic.label);
    ok('an UNNAMED radio pair is one radiogroup', !!cons && cons.widget === 'radiogroup' && cons.options.length === 2, cons);
    ok('and it is flagged as a consent question', !!cons && cons.consent === true, cons);
    ok('opacity-0 radios with a visible pill ARE scanned (Workable\'s required questions)',
       !!uae && uae.widget === 'radiogroup' && uae.options.length === 2, uae);
    ok('their required flag survives', !!uae && uae.required === true, uae);
    ok('a lone agreement checkbox is flagged for the review panel', !!gdpr && gdpr.consent === true, gdpr);
    // The discriminator: hidden AND no question being asked. Cambio's three hidden checkboxes are a
    // cookie banner's categories, and accepting them would put a banner in the applicant's form.
    console.log('    fields:', JSON.stringify(f.map((x) => ({ w: x.widget || x.type, k: x.key.slice(0, 26), o: x.options, l: (x.label || '').slice(0, 60) }))));
    ok('a hidden checkbox inside a COOKIE BANNER stays excluded',
       !f.some((x) => /analytics cookies|advertising cookies/i.test(JSON.stringify(x.options || []))),
       f.map((x) => x.options));
    ok('nothing was submitted by the scan', (await page.evaluate(() => window.__submits)) === 0);
    await page.close();
  }

  console.log('\ngroups are FILLED as one question, and never untick the applicant');
  {
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE);
    await page.goto('https://groups.example.com/apply');
    // the applicant answers one box themselves, by hand, before autofill runs
    await page.evaluate(() => { document.querySelector('input[name=lic][value=lcpc]').click(); });
    const uaeKey = await page.evaluate(`(function(){ ${JS_HELPERS}
      return grpKey(document.querySelector('input[name=uae]')); })()`);
    await page.evaluate(fillJs({
      'n:lic|checkbox': 'LICSW, LISW',       // a MULTI answer, by option label — not a boolean
      [uaeKey]: 'yes',                       // an opacity-0 group, answered by rewording
    }));
    await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 45000 });
    const st = await page.evaluate(() => ({
      lic: [...document.querySelectorAll('input[name=lic]')].filter((c) => c.checked).map((c) => c.value),
      uae: [...document.querySelectorAll('input[name=uae]')].map((c) => c.checked),
      submits: window.__submits,
      msg: window.__msgs.find((m) => m.type === 'FILLED'),
    }));
    ok('both wanted licences are ticked', st.lic.includes('licsw') && st.lic.includes('lisw'), st.lic);
    ok('the box the applicant ticked by hand is NOT untouched away', st.lic.includes('lcpc'), st.lic);
    ok('an opacity-0 group is actually set, through its visible pill', st.uae[0] === true, st.uae);
    ok('only the matching member of it is set', st.uae[1] === false, st.uae);
    ok('THE FORM WAS NEVER SUBMITTED (groups fill)', st.submits === 0, st.submits);
    await page.close();
  }

  console.log('\nthe fuzzy matcher refuses unrelated options');
  {
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE);
    await page.goto('https://power.example.com/apply');
    await page.evaluate(fillJs({ 'n:edu|select-one': 'Certified Welding Inspector' }));
    await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 45000 });
    const st = await page.evaluate(() => ({
      edu: document.getElementById('edu').value,
      msg: window.__msgs.find((m) => m.type === 'FILLED'),
    }));
    ok('an unrelated value picks NOTHING (no fabricated answer)', st.edu === '', st.edu);
    ok('and it is reported as a failure the user can see', (st.msg.failed || []).length === 1, st.msg.failed);
    await page.close();
  }

  console.log('\nunfillable questions are NAMED, not silently dropped');
  {
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE);
    await page.goto('https://combo.example.com/apply');
    await page.evaluate(fillJs({ 'i:country|text': 'Atlantis', 'n:plain|text': 'ok' }));
    await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 45000 });
    const m = await page.evaluate(() => window.__msgs.find((x) => x.type === 'FILLED'));
    ok('an unmatchable dropdown is reported, never counted as filled',
       (m.failed || []).length === 1 && m.failed[0].label.indexOf('Country') >= 0, m);
    await page.close();
  }

  // ── signature stability (the right-value-wrong-box bug) ────────────────────
  console.log('\nfield signatures survive the DOM changing elsewhere');
  {
    const page = await ctx.newPage();
    await page.goto('https://portal.example.com/x');
    const r = await page.evaluate(`(function(){ ${JS_HELPERS}
      document.body.innerHTML='<form><div><input id=a><input id=b></div><div><input><input></div></form>';
      var b=document.getElementById('b'), before=sig(b);
      // a reCAPTCHA-style late injection BEFORE the field we care about
      document.querySelector('div').insertBefore(document.createElement('input'), document.getElementById('a'));
      var twins=document.querySelectorAll('form>div:last-child input');
      return { before:before, after:sig(b), twinsDistinct: sig(twins[0])!==sig(twins[1]) };
    })()`);
    ok('a field keeps its key when a control is injected before it', r.before === r.after, r);
    ok('two structurally identical unlabeled fields get DIFFERENT keys', r.twinsDistinct === true, r);
    await page.close();
  }

  // ── shadow DOM ─────────────────────────────────────────────────────────────
  console.log('\ncontrols inside a web component are reachable');
  {
    const page = await ctx.newPage();
    await page.goto('https://portal.example.com/x');
    const n = await page.evaluate(`(function(){ ${JS_HELPERS}
      document.body.innerHTML='<div id=host></div><input id=plain>';
      var sr=document.getElementById('host').attachShadow({mode:'open'});
      sr.innerHTML='<label>Inner</label><input id=deep><select id=deepsel><option>a</option></select>';
      return ctrls().length;
    })()`);
    ok('ctrls() reaches into an open shadow root', n === 3, n);
    await page.close();
  }

  // ── the dropdown engine must never click anything but a real option ────────
  // Every page below has a combobox with NO aria-controls, so the engine has to fall back to
  // identifying the popup itself. Each shape was demonstrated to make an earlier version click a
  // Submit button, follow a nav link, or advance a wizard — while reporting "Filled 1 field".
  console.log('\ndropdown engine: hostile page shapes');
  {
    const shapes = [
      { name: 'a Submit button sitting in div.form-options',
        html: '<div class="form-options"><button type="submit" class="btn-item">Submit application</button></div>' },
      { name: 'a formless Submit button in div.answer-options',
        html: '<div class="answer-options"><button class="btn-item">Submit application</button></div>' },
      { name: 'site navigation in nav.navbar-menu',
        html: '<nav class="navbar-menu"><a class="menu-item" href="/openings">All openings</a></nav>' },
      { name: 'a wizard advance in div.step-options',
        html: '<div class="step-options"><button class="wizard-item">Save and continue</button></div>' },
    ];
    for (const sh of shapes) {
      const page = await ctx.newPage();
      await page.addInitScript(BRIDGE);
      await page.route('**/*', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body:
        `<html><body>
           <label for="c">Country code</label><input id="c" role="combobox">
           ${sh.html}
           <script>
             window.__fired=0; window.__navigated=false;
             document.querySelectorAll('button').forEach(function(b){ b.addEventListener('click',function(){ window.__fired++; }); });
             document.querySelectorAll('a').forEach(function(a){ a.addEventListener('click',function(e){ e.preventDefault(); window.__navigated=true; }); });
           </script></body></html>` }));
      await page.goto('https://hostile.example.com/apply');
      await page.evaluate(fillJs({ 'i:c|text': '+91' }));
      await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 45000 });
      const st = await page.evaluate(() => ({
        fired: window.__fired, navigated: window.__navigated,
        msg: window.__msgs.find((m) => m.type === 'FILLED'),
      }));
      ok(`nothing is clicked in: ${sh.name}`, st.fired === 0 && st.navigated === false, st);
      ok(`…and the field is REPORTED, not counted as filled: ${sh.name}`,
         st.msg.count === 0 && (st.msg.failed || []).length === 1, st.msg);
      await page.close();
    }
  }

  console.log('\nautofill scan must NOT dismiss a modal that closes on a document Escape (YC popup)');
  {
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE);
    await page.goto('https://modal.example.com/apply');
    await page.evaluate(READ_FIELDS_JS);                       // scan → enumCombos → cbClose
    await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FIELDS'), null, { timeout: 30000 });
    const st = await page.evaluate(() => {
      const f = (window.__msgs.find((m) => m.type === 'FIELDS') || {}).fields || [];
      return { open: window.__modalOpen, combo: f.find((x) => (x.label || '').indexOf('Country') >= 0),
        expanded: document.getElementById('country').getAttribute('aria-expanded'), submits: window.__submits };
    });
    ok('the application modal is STILL OPEN after autofill scanned it', st.open === true, st);
    ok('the combobox was still enumerated (fix did not neuter enumCombos)', !!st.combo && (st.combo.options || []).length === 3, st.combo);
    ok('enumeration still leaves the widget popup closed (via blur)', st.expanded === 'false', st);
    ok('nothing was submitted', st.submits === 0, st.submits);
    await page.close();
  }

  console.log('\ndropdown engine: no match means no pick');
  {
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE);
    await page.goto('https://combo.example.com/apply');
    // "Atlantis" matches none of India/United Kingdom/Canada. The old first-row fallback committed
    // "India +91" here — a fabricated answer, reported as a success.
    await page.evaluate(fillJs({ 'i:country|text': 'Atlantis' }));
    await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'FILLED'), null, { timeout: 45000 });
    const st = await page.evaluate(() => ({
      sv: document.querySelectorAll('.select__single-value').length,
      msg: window.__msgs.find((m) => m.type === 'FILLED'),
    }));
    ok('an unmatched value picks NOTHING', st.sv === 0, st);
    ok('and is reported rather than counted', st.msg.count === 0 && (st.msg.failed || []).length === 1, st.msg);
    await page.close();
  }

  console.log('\nan EMPTY dropdown is never mistaken for an answered one');
  {
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE);
    await page.route('**/*', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body:
      `<html><body>
         <div class="select__control"><div class="select__value-container">
           <span class="select__placeholder">Select a country</span>
           <input id="q" role="combobox" placeholder="Select a country">
         </div></div>
         <span class="hint">e.g. +91</span></body></html>` }));
    await page.goto('https://empty.example.com/apply');
    const shown = await page.evaluate(`(function(){ ${JS_HELPERS}
      return cbShown(document.getElementById('q')); })()`);
    ok('cbShown ignores placeholder + sibling hint text on an empty widget', shown === '', shown);
    await page.close();
  }

  // ── multi-step detection (read-only: it must never offer a Submit) ─────────
  console.log('\nwizard detection (WIZARD_PROBE_JS)');
  {
    const probe = async (html) => {
      const p = await ctx.newPage();
      await p.route('**/*', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
      await p.goto('https://wizard.example.com/apply');
      await p.evaluate(BRIDGE); await p.evaluate(WIZARD_PROBE_JS);
      const m = (await p.evaluate(() => window.__msgs)).find((x) => x.type === 'WIZARD');
      await p.close(); return m;
    };
    const icims = (cur) => `<html><body><div class="iCIMS_Steps"><ul>
      ${[1, 2, 3, 4].map((i) => `<li class="iCIMS_Steps_${i === cur ? 'Current' : (i < cur ? 'Completed' : 'NotCurrent')}"><span>Step ${i} of 4. Section ${i}(${i === cur ? 'Current Step' : 'Incomplete Step'})</span></li>`).join('')}
      </ul></div><form method="post"><input name="fn" required value="A"><input name="em" required value="b@c.d">
      <input type="submit" value="Submit Profile"></form></body></html>`;
    const s1 = await probe(icims(1)), s3 = await probe(icims(3)), s4 = await probe(icims(4));
    ok('iCIMS step 1 → 1 of 4', s1.hasOrdinal && s1.i === 1 && s1.n === 4, s1);
    ok('iCIMS step 3 → 3 of 4 (NOT 1 of 4 — the concatenated-stepper trap)', s3.i === 3 && s3.n === 4, s3);
    ok('iCIMS step 4 → i === n, the last step', s4.i === 4 && s4.n === 4, s4);
    ok('iCIMS "Submit Profile" is refused on every step', s1.canNext === false && s3.canNext === false, [s1.rejected, s3.rejected]);

    const ashby = await probe('<html><body><input name=a><button>Upload file</button><button>Submit Application</button></body></html>');
    ok('a formless "Submit Application" is never offered as Next', ashby.canNext === false, ashby);

    const wd = await probe('<html><body><div data-automation-id="progressBar"><div aria-current="step">My Information</div><div>My Experience</div><div>Voluntary Disclosures</div><div>Review</div></div><input name=f required value=x><button data-automation-id="nextbtn">Save and Continue</button></body></html>');
    ok('a Workday-shaped stepper reads 1 of 4', wd.hasOrdinal && wd.i === 1 && wd.n === 4, wd);
    ok('its untyped, formless "Save and Continue" is recognised', wd.canNext === true, wd);

    const navtrap = await probe('<html><body><nav><ul class="stepper"><li class="nav-item active">Careers</li><li class="nav-item">About</li></ul></nav><input name=a><button>Continue</button></body></html>');
    ok('site nav with an .active item is NOT a stepper', navtrap.hasOrdinal === false, navtrap);

    const prose = await probe('<html><body><h1>Apply</h1><p>Our hiring runs in 3 stages. Step 1 of 3 is a screen, step 2 of 3 an interview.</p><input name=a></body></html>');
    ok('two conflicting ordinals in prose → no ordinal', prose.hasOrdinal === false, prose);

    const last = await probe('<html><body><h2>Step 4 of 4</h2><input name=x><p>Please review your application before you submit.</p></body></html>');
    ok('a review page is flagged as the end', last.i === 4 && last.n === 4 && last.review === true, last);

    for (const [w, want] of [['Weiter', true], ['Suivant', true], ['Siguiente', true], ['Volgende', true],
                             ['Save and Continue', true], ['Next ›', true],
                             ['Bewerbung absenden', false], ['Envoyer ma candidature', false],
                             ['Finish', false], ['Next steps in our process', false],
                             ['Submit', false], ['Continue to submit', false]]) {
      const r = await probe(`<html><body><h2>Step 2 of 5</h2><input name=x><button>${w}</button></body></html>`);
      ok(`label "${w}" → ${want ? 'NEXT' : 'refused'}`, r.canNext === want, { canNext: r.canNext, rejected: r.rejected });
    }
    const amb = await probe('<html><body><h2>Step 2 of 5</h2><input name=x><button>Continue</button><button>Next</button></body></html>');
    ok('two next-ish controls → refuse (ambiguous)', amb.canNext === false && amb.why === 'ambiguous', amb);
  }

  // ── the final sweep, WHILE A REPEATER ROW IS HELD ─────────────────────────
  // "Some dropdowns are opened and then not closed" was traced to cbCloseAllOpened returning early
  // on the row-protected path, and the fix was to call cbEnsureNoneOpen() inside that branch. But
  // that branch CLEARS __cvfOpened first, and while a row is held cbEnsureNoneOpen skips every node
  // cbWeOpened() does not recognise — and cbWeOpened reads __cvfOpened. Cleared list, nothing
  // recognised, nothing swept: the call was there and could not close anything.
  //
  // This asserts the OUTCOME (a stray sheet is gone, the row survives) rather than the call, so it
  // cannot be satisfied by putting the call back in the wrong order again.
  console.log('\nthe final sweep while a repeater row is held');
  {
    const p = await ctx.newPage();
    await p.route('**/*', (r) => r.fulfill({
      status: 200, contentType: 'text/html; charset=utf-8',
      body: `<html><body>
        <form id="f">
          <input id="trig" type="button" aria-haspopup="listbox" aria-label="Search phone country codes" placeholder=" ">
          <div id="row" class="Portal-rui"><span>Add experience</span>
            <input id="c1" type="button" aria-haspopup="listbox" aria-label="Company" placeholder=" ">
            <input id="c2" type="button" aria-haspopup="listbox" aria-label="Position" placeholder=" ">
            <button id="addrow" disabled>Add</button><button id="cancelrow">Cancel</button>
          </div>
          <div id="sheet" class="Sheet-rui" role="listbox">
            <input id="sb" type="search" placeholder="Search">
            <div role="option">India</div><div role="option">Ireland</div><div role="option">Israel</div>
          </div>
        </form>
        <script>
          // A Revolut-shaped sheet: Escape ON ITS OWN SEARCH BOX closes it. Nothing else does.
          document.getElementById('sb').addEventListener('keydown', function(e){
            if(e.key==='Escape'){ document.getElementById('sheet').style.display='none'; }
          });
        </script></body></html>`,
    }));
    await p.goto('https://sweep.example.com/apply');
    const r = await p.evaluate(new Function('return (function(){' + JS_HELPERS + `
      var row=document.getElementById('row'), sheet=document.getElementById('sheet');
      // Exactly what the repeater phase does: hold the row's own controls, and register the sheet
      // we opened so the sweep is allowed to touch it.
      cbKeepCtrls([document.getElementById('c1'), document.getElementById('c2'), document.getElementById('addrow')]);
      cbNoteOpened(document.getElementById('trig'), sheet);
      var before = { holding: cbHoldingRow(), weOpened: cbWeOpened(sheet), sheetVisible: vis(sheet), rowProtected: cbProtected(row) };
      cbCloseAllOpened();
      return { before: before, sheetStillOpen: vis(sheet), rowStillThere: vis(row),
               rowCtrlsAlive: !!(document.getElementById('c1') && document.getElementById('c2')) };
    })();`));
    ok('the fixture is set up the way the engine sets it up (row held, sheet ours, sheet open)',
      r.before.holding === true && r.before.weOpened === true && r.before.sheetVisible === true && r.before.rowProtected === true, r.before);
    ok('A STRAY SHEET IS ACTUALLY CLOSED while a repeater row is held', r.sheetStillOpen === false, r);
    ok('...and the held row is NOT torn down doing it', r.rowStillThere === true && r.rowCtrlsAlive === true, r);
    await p.close();
  }


  // ── A TAP IS NOT AN ANSWER ───────────────────────────────────────────────────────────────────
  // The bug this locks down: an applicant looking at a code picker that reads "+44" taps it to fix
  // it by hand, scrolls, gives up, closes. Nothing changed — but the tap used to be recorded as
  // proof the value was theirs, so cbAnswered() returned true and Auto Fill skipped the field on
  // every later run. The server had been answering "+91" correctly the whole time.
  {
    const p = await browser.newPage();
    await p.route('**/*', (r) => r.fulfill({
      status: 200, contentType: 'text/html; charset=utf-8',
      body: `<html><body><form>
        <span><input id="dial" type="button" aria-haspopup="listbox" aria-labelledby="dl" placeholder=" " value="+44"><div id="dl">Search phone country codes</div></span>
        <span><input id="dial2" type="button" aria-haspopup="listbox" aria-labelledby="dl2" placeholder=" " value="+44"><div id="dl2">Search phone country codes</div></span>
      </form></body></html>`,
    }));
    await p.goto('https://tap.example.com/apply');
    await p.evaluate(FOCUS_DETECT_JS);
    // A REAL tap (isTrusted) on the first picker, and nothing else.
    await p.click('#dial');
    // A real tap on the second picker, and then the widget actually changes what it shows.
    await p.click('#dial2');
    await p.evaluate(() => { document.getElementById('dial2').value = '+91'; });
    const r = await p.evaluate(new Function('return (function(){' + JS_HELPERS + `
      var a=document.getElementById('dial'), b=document.getElementById('dial2');
      return {
        tappedA: !!a.__cvfTapped, tappedB: !!b.__cvfTapped,
        touchedA: !!a.__cvfTouched,
        shownA: cbShown(a), shownB: cbShown(b),
        userAnsweredA: cbUserAnswered(a), userAnsweredB: cbUserAnswered(b),
        answeredA: cbAnswered(a), answeredB: cbAnswered(b),
        keepA: keepUser(a, 'button', '+91')
      };
    })();`));
    ok('a real tap IS recorded (the signal still exists)', r.tappedA === true && r.tappedB === true, r);
    ok('...but a tap alone is NOT a change event', r.touchedA === false, r);
    ok('A PICKER THE PERSON ONLY OPENED IS NOT "ANSWERED" — so +91 still gets written',
      r.userAnsweredA === false && r.answeredA === false, r);
    ok('...and keepUser does not protect it either', r.keepA === false, r);
    ok('a tap FOLLOWED BY the shown value changing IS their answer', r.userAnsweredB === true && r.answeredB === true, r);
  }

  // ── MATCHING RÉSUMÉ PROSE TO A CONTROLLED LIST, WITHOUT INVENTING A QUALIFICATION ────────────
  // Revolut's Degree column is a nine-item list. "Diploma" is the one word from the applicant's
  // "Post Graduate Diploma in Advanced Computing (PG-DAC)" that returns a row — and the row it
  // returns is "High school diploma/GED or equivalent". Committing that would state a
  // school-leaving certificate for someone holding a postgraduate qualification.
  {
    const p = await browser.newPage();
    await p.route('**/*', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body></body></html>' }));
    await p.goto('https://match.example.com/apply');
    const r = await p.evaluate(new Function('return (function(){' + JS_HELPERS + `
      var PGD='Post Graduate Diploma in Advanced Computing (PG-DAC)';
      var SCHOOL='Govt Arts & Science College, Kumbakonam (Bharathidasan University)';
      return {
        falseDegree: cbCovers(PGD, 'High school diploma/GED or equivalent'),
        trueDegree:  cbCovers("Master's degree", "Master's degree or equivalent"),
        trueSchool:  cbCovers(SCHOOL, 'Bharathidasan University'),
        wrongSchool: cbCovers('C-DAC ACTS (Advanced Computing Training School), Pune, Maharashtra', 'Chonbuk Sanup University of Technology'),
        ladder:      cbLadder(SCHOOL, ['Bharathidasan University']).map(function(x){ return x.q + '|' + (x.strict?'strict':'open'); }),
        degLadder:   cbLadder(PGD, ["Master's degree"]).map(function(x){ return x.q; })
      };
    })();`));
    ok('THE WRONG QUALIFICATION IS REFUSED: a postgraduate diploma is not a high-school diploma',
      r.falseDegree === false, r);
    ok('...while the equivalent phrasing the server sent IS accepted', r.trueDegree === true, r);
    ok('a university named in an aside IS matched', r.trueSchool === true, r);
    ok('...and an unrelated university with one shared word is not', r.wrongSchool === false, r);
    ok('the ladder tries the value, then the server\'s alternates, then our own tokens',
      r.ladder[0].indexOf('Govt Arts') === 0 && r.ladder[1] === 'Bharathidasan University|open'
      && r.ladder.some((x) => x.indexOf('|strict') > 0) && r.ladder[r.ladder.length - 1] === '|open', r.ladder);
    ok('...and the degree alternate is tried before any word we picked out ourselves',
      r.degLadder[1] === "Master's degree", r.degLadder);
    await p.close();
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
