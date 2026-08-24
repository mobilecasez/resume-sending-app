// AI Hub — new feature. Safe to delete without affecting existing app.
// Shared by BOTH in-app browsers (the apply WebView and Browse & Fetch) so a sign-in behaves the
// same wherever the user happens to be. Verified by MobileApp/scripts/test-webview-scripts.js.

// ── Frame guard ───────────────────────────────────────────────────────────────
// Our scripts are injected into EVERY frame (injectedJavaScriptForMainFrameOnly={false}) so the
// autofill can reach ATS forms hosted in an iframe. That also dropped them inside hCaptcha /
// reCAPTCHA / bot-check frames, where injected globals and extra listeners make a security check
// more likely to fail or hang. Mark those sub-frames so every other script leaves them completely
// alone. (We are not defeating the check — we are getting out of its way so it can run normally.)
export const FRAME_GUARD_JS = `(function(){
  try {
    if (window.top === window.self) return;                       // main frame: never skip
    var h = String(location.hostname || '');
    if (/(^|\\.)(hcaptcha\\.com|recaptcha\\.net|gstatic\\.com|arkoselabs\\.com|funcaptcha\\.com|perimeterx\\.net|px-cdn\\.net|datadome\\.co|cloudflare\\.com|challenges\\.cloudflare\\.com)$/i.test(h)
        || /(^|\\.)google\\.com$/i.test(h) && /recaptcha/i.test(location.pathname)) {
      window.__cvfSkipFrame = true;
    }
  } catch(e){}
})(); true;`;

// ── Sign-in flow ──────────────────────────────────────────────────────────────
// iOS can never give a page a real popup: react-native-webview's createWebViewWithConfiguration
// always returns nil, so window.open() yields null and window.opener is permanently null. Sites
// that sign you in via a popup therefore broke twice over — their JS threw on the null window, and
// our old handler replaced the MAIN frame with the auth page, destroying the half-filled form with
// no way back.
//
// So: hand the page a working stub window, tell RN where the auth page is, and remember the page we
// came from. RN drives the auth in the same view and brings the user straight back to their form
// once the provider is done — by which time the session cookie is set, so the site sees them as
// signed in. Cookies live in the persistent store and are synced to NSHTTPCookieStorage, so that
// session is then shared by every WebView in the app and survives restarts.
export const AUTH_FLOW_JS = `(function(){
  if (window.__cvfSkipFrame || window.__cvfAuthHook) return; window.__cvfAuthHook = true;
  function post(o){ try{ o.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  var realOpen = window.open;
  window.open = function(url, name, features){
    try {
      var abs = url ? new URL(String(url), location.href).href : '';
      // Only take over real navigations to another page; leave about:blank/javascript: alone.
      if (abs && /^https?:/i.test(abs)) {
        post({ type:'AUTH_POPUP', url: abs, from: location.href });
        var stub = {
          closed:false, opener:window, name:String(name||''),
          close:function(){ this.closed=true; post({type:'AUTH_DONE', reason:'close'}); },
          focus:function(){}, blur:function(){}, postMessage:function(){},
          addEventListener:function(){}, removeEventListener:function(){},
          document:{ write:function(){}, close:function(){} },
          location:{ get href(){ return abs; }, set href(v){ post({type:'AUTH_POPUP', url:String(v), from:location.href}); },
                     replace:function(v){ post({type:'AUTH_POPUP', url:String(v), from:location.href}); }, assign:function(v){ post({type:'AUTH_POPUP', url:String(v), from:location.href}); } }
        };
        return stub;                              // never null → the site's JS keeps working
      }
    } catch(e){}
    try { return realOpen.apply(window, arguments); } catch(e){ return null; }
  };
  // A popup-style callback finishes with window.close(); in the main frame that is a no-op, so we
  // use it as the "auth finished" signal and send the user back to their application.
  // ⚠️ REPORT WHERE THE CLOSE HAPPENED. A bare "the page closed itself" is ambiguous and we got it
  // wrong twice: a provider that REFUSES to start also closes itself, and so does one that has just
  // FINISHED. Only the URL distinguishes them, so send it and let the app classify.
  var realClose = window.close;
  window.close = function(){ post({type:'AUTH_DONE', reason:'self-close', href: String(location.href)}); try{ realClose.call(window); }catch(e){} };
})(); true;`;

// ── Stay in this window ───────────────────────────────────────────────────────
// ⚠️ THE BUG THIS FIXES IS NOT VISIBLE IN onShouldStartLoadWithRequest. Tapping a LinkedIn link
// opened the LinkedIn APP even though that handler returns true for every http(s) URL — because
// iOS UNIVERSAL LINKS are resolved BEFORE the navigation is offered to the web view at all. When a
// user activates a link that points at a domain some installed app has claimed, WKWebView hands it
// straight to that app; our handler is never consulted, so there was nothing there to say no.
//
// The one property universal links depend on is that the navigation was USER-ACTIVATED. A scripted
// navigation is exempt. So we take the tap ourselves and re-issue it as location.assign() — same
// destination, same window, and the OS no longer treats it as an app-openable link.
//
// Deliberately surgical, because a blunt version breaks real sites:
//   • non-http schemes (linkedin://, fb://, intent://) — blocked outright. That is a page trying to
//     bounce the user into a native app, which is exactly what this browser must never do.
//   • CROSS-ORIGIN links only get the rewrite. Universal links cannot fire same-origin, and taking
//     over same-origin clicks would break every single-page app's own router (LinkedIn, Google and
//     most job boards route in JS) by forcing a full reload on every internal navigation.
//   • composedPath(), not target.closest(), so a link inside a shadow root is still found.
export const STAY_IN_APP_JS = `(function(){
  if (window.__cvfSkipFrame || window.__cvfStayHook) return; window.__cvfStayHook = true;
  function abs(h){ try { return new URL(String(h), location.href).href; } catch(e){ return ''; } }
  function anchorOf(ev){
    try {
      var path = ev.composedPath ? ev.composedPath() : null;
      if (path) { for (var i=0;i<path.length;i++){ var n=path[i]; if (n && n.tagName && String(n.tagName).toLowerCase()==='a' && n.getAttribute && n.getAttribute('href')) return n; } }
    } catch(e){}
    try { return ev.target && ev.target.closest ? ev.target.closest('a[href]') : null; } catch(e){ return null; }
  }
  function post(o){ try{ o.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  // ⚠️ target="_blank" MUST DIE BEFORE THE CLICK REACHES NATIVE. This is the case the click handler
  // below cannot save us from: with setSupportMultipleWindows={false}, react-native-webview's iOS
  // shim has no window to open a _blank link into and hands the URL to the system — which is
  // precisely "the LinkedIn app opened". Neutralising the attribute on the way down means no
  // _blank link ever reaches that code path, whatever the shim decides to do with one.
  function deblank(a){
    try {
      var t = a.getAttribute('target');
      if (t && t !== '_self') { a.setAttribute('target', '_self'); return true; }
    } catch(e){}
    return false;
  }
  // pointerdown fires BEFORE click, so the attribute is already gone by the time anything else runs.
  ['pointerdown','mousedown','touchstart'].forEach(function(evt){
    document.addEventListener(evt, function(ev){
      try { var a = anchorOf(ev); if (a) deblank(a); } catch(e){}
    }, true);
  });
  function onClick(ev){
    try {
      if (ev.defaultPrevented) return;
      if (ev.button && ev.button !== 0) return;
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var a = anchorOf(ev); if (!a) return;
      deblank(a);
      var raw = a.getAttribute('href') || '';
      if (!raw || raw.charAt(0) === '#') return;
      if (/^javascript:/i.test(raw)) return;
      var u = abs(raw); if (!u) return;
      if (!/^https?:/i.test(u)) { ev.preventDefault(); ev.stopPropagation(); post({type:'STAY_BLOCKED_SCHEME', url:u.slice(0,120)}); return; }
      var host = ''; try { host = new URL(u).hostname; } catch(e){ return; }
      if (!host || host === location.hostname) return;   // same-origin: leave SPA routing alone
      ev.preventDefault(); ev.stopPropagation();
      // Tell the app we handled it. Without this, "it still opened LinkedIn" and "our handler never
      // ran" look identical from the outside, which is exactly how this bug survived two builds.
      post({type:'STAY_INTERCEPT', host:host});
      window.location.assign(u);
    } catch(e){}
  }
  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', onClick, true);
})(); true;`;

// ── PASSKEYS / WEBAUTHN ─────────────────────────────────────────────────────────────────────────
//
// ⚠️ A PASSKEY CEREMONY CANNOT WORK IN THIS WEBVIEW, AND NEVER WILL.
//
// A passkey binds to the site's Relying Party ID (its own domain). iOS only lets an app take part
// when BOTH sides opt in: the site publishes /.well-known/apple-app-site-association naming
// <TeamID>.com.cvapplyr.mobile, AND the app ships a compile-time
// `com.apple.developer.associated-domains: webcredentials:<domain>` list. A job browser has to work
// on arbitrary employer portals, so that list can never be complete — efinancialcareers, Workday and
// Google are not going to publish our Team ID.
//
// Left alone, `navigator.credentials.get({publicKey})` simply never settles: the button spins
// forever and reads as broken (reported as "Passkey also not works for webview"). Every real site
// has a password/email fallback branch keyed on a REJECTED promise, so rejecting with the exact
// error the spec defines makes the site show it — turning a dead end into a normal sign-in.
export const PASSKEY_GUARD_JS = `(function(){
  if (window.__cvfSkipFrame || window.__cvfPkHook) return; window.__cvfPkHook = true;
  function post(o){ try{ o.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  // ⚠️ REFUSING THE CEREMONY IS NOT ENOUGH — THE OPTION MUST NEVER BE OFFERED.
  //
  // The old guard only rejected navigator.credentials.get({publicKey}). Glassdoor therefore still
  // ASKED: it feature-detects passkeys the way every site does, saw them "available", rendered a
  // passkey button, and only discovered the truth when the user tapped it — by which point it had
  // committed to that path and showed "something went wrong" instead of falling back. Indeed never
  // offered one, which is the whole difference the user noticed.
  //
  // A site decides whether to SHOW the option from these three, all of which must now say no:
  //   window.PublicKeyCredential                                  (does the browser do WebAuthn?)
  //   PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()   (is there an authenticator?)
  //   PublicKeyCredential.isConditionalMediationAvailable()        (passkey autofill?)
  // Answering honestly is not a downgrade: the ceremony genuinely cannot complete here (a passkey
  // binds to the site's own domain and iOS only admits an app holding that associated-domains
  // entitlement — impossible for arbitrary employer portals), so every one of these is TRUE-but-
  // useless. Saying no is what makes the site show the password form it already has.
  try {
    var PKC = window.PublicKeyCredential;
    if (PKC) {
      // Patch the statics FIRST, so a page that captured a reference before we removed the global
      // still gets a truthful answer.
      try { PKC.isUserVerifyingPlatformAuthenticatorAvailable = function(){ return Promise.resolve(false); }; } catch(e){}
      try { PKC.isConditionalMediationAvailable = function(){ return Promise.resolve(false); }; } catch(e){}
      try { PKC.isPasskeyPlatformAuthenticatorAvailable = function(){ return Promise.resolve(false); }; } catch(e){}
      // Then take the feature flag itself away — this is the check most sites actually branch on.
      try { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true, writable: true }); }
      catch(e){ try { window.PublicKeyCredential = undefined; } catch(e2){} }
      post({type:'PASSKEY_HIDDEN', host:location.hostname});
    }
  } catch(e){}
  // Last line of defence: a site that tries the ceremony anyway gets the exact error its fallback
  // branch is written against, rather than a promise that never settles (the original "the button
  // just spins forever" report).
  try{
    var c = navigator.credentials; if(!c) return;
    ['get','create'].forEach(function(k){
      var real = c[k] && c[k].bind(c); if(!real) return;
      c[k] = function(opts){
        // ONLY WebAuthn. A password-manager credentials.get({password:true}) must still work, and so
        // must federated/identity requests — narrowing on opts.publicKey is what keeps this safe.
        if(opts && opts.publicKey){
          post({type:'PASSKEY_BLOCKED', host:location.hostname, op:k});
          var e = new Error('Passkeys are not available in this browser.');
          e.name = 'NotAllowedError';       // the exact error every fallback branch checks for
          return Promise.reject(e);
        }
        return real(opts);
      };
    });
  }catch(e){}
})(); true;`;

// ── Admission ticket: a same-origin window.opener ─────────────────────────────
// ⚠️ THIS IS THE FIX FOR "Redirecting to Indeed for one login… and nothing happens".
//
// Glassdoor's /auth/login/oauth2/code/indeed page is a client-side bootstrap whose mount effect is,
// deminified from their own chunk:
//
//     if (window.opener?.origin === window.location.origin || (provider === "google" && refSameOrigin)) {
//       …write PKCE verifier to sessionStorage…
//       window.location.replace('/auth/oauth2/authorization/indeed?' + params);
//     } else throw Error("Origin mismatch error");
//     } catch (e) { window.close(); }
//
// An embedded WebView can NEVER have a real opener (WKWebView's createWebViewWithConfiguration
// returns nil unconditionally), so `window.opener?.origin` is undefined, the check throws, and
// window.close() in a TOP-LEVEL frame is a no-op — the page sits on its spinner forever and the
// browser never reaches indeed.com at all. Builds 185-187 all tried to fix our NAVIGATION; the flow
// was dying before any navigation happened.
//
// So we hand the page an opener. Nothing is ever delivered through it — it is an admission ticket,
// not a channel. Deliberately narrow: a non-null window.opener changes `noopener` and
// popup-detection semantics, so it is scoped to these hosts AND these paths only.
export const OPENER_SHIM_JS = `(function(){
  try {
    if (window.opener) { window.__cvfOpenerShim = 'skip:real-opener'; return; }   // real popup — leave alone
    if (!/(^|\\.)(glassdoor\\.[a-z.]+|indeed\\.com)$/i.test(location.hostname)) { window.__cvfOpenerShim = 'skip:host'; return; }
    if (!/\\/auth\\/(login\\/)?oauth2\\//i.test(location.pathname)) { window.__cvfOpenerShim = 'skip:path'; return; }
    var stub = {
      get origin(){ return window.location.origin; },
      closed:false, close:function(){}, focus:function(){}, blur:function(){},
      addEventListener:function(){}, removeEventListener:function(){},
      postMessage:function(d,o){ try{ window.ReactNativeWebView.postMessage(
        JSON.stringify({__cvf:true,type:'OPENER_MSG',origin:String(o||''),href:String(location.href)})); }catch(e){} },
      location:{ href: window.location.href }
    };
    Object.defineProperty(window,'opener',{value:stub,writable:true,configurable:true});
    window.__cvfOpenerShim = 'installed';
    // ⚠️ RESTORED. A previous pass deleted this on the claim that the redirect branch was
    // unreachable ("codeChallenge is undefined on the callback render"). That was a
    // mis-deminification: the variable tested is the RAW sessionStorage string, not codeChallenge —
    //     let t = sessionStorage.getItem("indeed-oauth-params");
    //     …then(n => t ? location.replace(originationURL || "/") : (chan.postMessage(n), close()));
    // So the presence of this ONE key is what selects the site's redirect mode over popup mode.
    // beginAuthFlow writes a better originationURL before we ever leave the previous page; this is
    // the fallback for a bootstrap page we did NOT drive (onOpenWindow, a redirect-style entry, or
    // the Android reload watchdog). Seed only when absent so the better value always wins.
    try {
      if (!sessionStorage.getItem('indeed-oauth-params')) {
        var o = new URLSearchParams(location.search).get('originationURL') || '';
        var seed = { auth_provider: 'google' };
        if (/^https?:/i.test(o)) seed.originationURL = o;
        sessionStorage.setItem('indeed-oauth-params', JSON.stringify(seed));
      }
    } catch(e){}
  } catch(e){}
})(); true;`;

// ── The deterministic half of the Glassdoor fix ───────────────────────────────
// The opener shim above depends on winning an injection race (document-start). This does not: it
// runs on the page we are ALREADY on, before we navigate anywhere, and sessionStorage is per-origin
// so the value is waiting when the bootstrap page loads.
//
// From Glassdoor's shipped chunk, the outbound gate is:
//     const provider = JSON.parse(sessionStorage['indeed-oauth-params']).auth_provider;
//     const refSame  = new URL(document.referrer).origin === location.origin;
//     if (window.opener?.origin === location.origin || "google" === provider && refSame) { …go… }
//     else throw Error("Origin mismatch error");        // catch → window.close() → frozen spinner
//
// So auth_provider:"google" plus a same-origin referrer is a SECOND, opener-free way through — and
// navigating with location.href from a glassdoor page gives us exactly that referrer.
//
// ⚠️ It does NOT turn this into a Google sign-in. auth_provider is read ONLY by that gate; every
// parameter forwarded to /auth/oauth2/authorization/indeed is built from the request query, never
// from sessionStorage. Indeed still renders its own Google / Apple / email page.
//
// ⚠️ And the same key switches the RETURN leg from "postMessage into a dead opener and close" to
// location.replace(originationURL) — the site brings the user back itself.
//
// ⚠️ sessionStorage is per-ORIGIN: only ever inject this while the WebView is on the same glassdoor
// origin as the bootstrap URL (glassdoor.com and glassdoor.co.in are different origins).
export const GD_SEED_JS = (back: string) => `(function(){
  try {
    if (!/(^|\\.)glassdoor\\.[a-z.]+$/i.test(String(location.hostname||''))) return;
    var cur = null;
    try { cur = JSON.parse(sessionStorage.getItem('indeed-oauth-params') || 'null'); } catch(e){}
    if (!cur || typeof cur !== 'object') cur = {};
    if (!cur.auth_provider) cur.auth_provider = 'google';
    var back = ${JSON.stringify(back || '')};
    if (/^https?:/i.test(back)) cur.originationURL = back;
    sessionStorage.setItem('indeed-oauth-params', JSON.stringify(cur));
    window.__cvfGdSeed = 'ok';
  } catch(e){ try { window.__cvfGdSeed = 'err'; } catch(e2){} }
})(); true;`;

// ── Stop shipping blind ───────────────────────────────────────────────────────
// ⚠️ THE REASON 185/186/187/188 EACH COST A WHOLE BUILD is that "still not working" carried no
// information — four rounds of inferring a mechanism from one sentence. This reports the page's
// actual state, including Glassdoor's OWN on-screen error notice, so the next report is a readable
// symptom instead of a guess. Scoped hard to the two hosts and their /auth paths.
export const GD_PROBE_JS = `(function(){
  try {
    if (window.__cvfSkipFrame || window.__cvfGdProbe) return;
    if (!/(^|\\.)(glassdoor\\.[a-z.]+|indeed\\.com)$/i.test(String(location.hostname||''))) return;
    if (!/\\/auth/i.test(String(location.pathname||''))) return;
    window.__cvfGdProbe = true;
    function snap(tag){
      var d = { __cvf:true, type:'GD_PROBE', tag:tag, href:String(location.href) };
      try { d.shim = String(window.__cvfOpenerShim || 'absent'); } catch(e){}
      try { d.seed = String(window.__cvfGdSeed || 'absent'); } catch(e){}
      try { d.opener = window.opener ? String(window.opener.origin || '?') : 'null'; } catch(e){ d.opener = 'throw'; }
      try { d.ref = String(document.referrer || ''); } catch(e){}
      try { d.ss = { params: !!sessionStorage.getItem('indeed-oauth-params'),
                     verifier: !!sessionStorage.getItem('indeed-oauth-code-verifier'),
                     nonce:    !!sessionStorage.getItem('indeed-oauth-nonce') }; } catch(e){}
      try { var n = document.getElementById('indeed-oauth-error-notice');
            d.notice = n ? String(n.innerText||'').trim().slice(0,300) : ''; } catch(e){}
      try { d.head = String((document.querySelector('h1,h2,h3')||{}).innerText||'').trim().slice(0,120); } catch(e){}
      try { d.form = !!document.querySelector('input[type=password], input[name="__email"]'); } catch(e){}
      try { d.captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], #px-captcha'); } catch(e){}
      try { window.ReactNativeWebView.postMessage(JSON.stringify(d)); } catch(e){}
    }
    [1500, 5000, 11000].forEach(function(ms){ setTimeout(function(){ snap('t'+ms); }, ms); });
  } catch(e){}
})(); true;`;

// ── Google sign-in: let it TRY, then catch the real failure ───────────────────
//
// ⚠️ THE OLD DOCTRINE HERE WAS WRONG, AND IT WAS THE BUG.
//
// We used to cancel every navigation to Google's OAuth endpoints on the theory that Google's
// embedded-webview block (disallowed_useragent) makes them impossible in principle. Field evidence
// says otherwise: signing in to Glassdoor via Indeed, the user picked "log in with Google" and it
// completed normally in this same WebView. The reason it survived is that Indeed starts Google with
// a SERVER redirect, and WKWebView does not consult decidePolicyForNavigationAction on a 302 — so
// the block never fired, the page loaded, and Google's redirect flow worked exactly as designed.
//
// In other words the only thing our pre-emptive block reliably stopped was the flow that works. A
// clean browser UA (BROWSER_UA) already gets us served the redirect-based mobile flow, and that
// flow needs no popup and no window.opener, so nothing about this web view is disqualifying.
//
// What remains true is that Google CAN refuse — and when it does it says so on a page we can read.
// So we stop predicting the refusal and start detecting it: watch Google's own sign-in pages, and
// speak up only when Google has actually said no. A wrong prediction costs the user a working
// sign-in; a late detection costs them a few seconds.
export const GOOGLE_AUTH_WATCH_JS = `(function(){
  try {
    // ⚠️⚠️ TOP FRAME ONLY. THIS LINE IS THE WHOLE BUG FROM b190.
    // These scripts are injected with injectedJavaScriptForMainFrameOnly={false}, so without this
    // the watcher ran inside every accounts.google.com IFRAME — and a hidden 1x1 Google One Tap
    // frame (present on Google Search and on any site with a Google button) has no text and no
    // controls, so the "blank page" branch fired ~9s into ordinary browsing and told the user
    // "Google turned down the sign-in" when nothing had been refused and nothing even attempted.
    // A subframe is NEVER the page the user is signing in on. Reproduced in test-no-exit.js.
    if (window.top !== window.self) return;
    if (window.__cvfSkipFrame || window.__cvfGWatch) return;
    if (!/(^|\\.)accounts\\.google\\.com$/i.test(String(location.hostname||''))) return;
    // …and only on a real sign-in page, not every accounts.google.com URL.
    if (!/^\\/(o\\/oauth2|oauth2|signin|v3\\/signin|gsi\\/|ServiceLogin|AccountChooser|InteractiveLogin)/i
          .test(String(location.pathname||''))) return;
    window.__cvfGWatch = true;
    function post(o){ try{ o.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
    function text(){ try { return String((document.body && document.body.innerText) || ''); } catch(e){ return ''; } }

    // ⚠️ ONLY GOOGLE'S OWN WORDS COUNT, AND ONLY THE UNAMBIGUOUS ONES.
    // "Couldn't sign you in" was in this list and has been REMOVED: Google shows it for a wrong
    // password and for account-recovery too, neither of which is an embedded-webview refusal.
    // 7532311 is the help article Google links from the real interstitial, so it is the most
    // precise signal available.
    var REFUSED = /disallowed_useragent|browser or app may not be secure|try using a different browser|answer[\\/=]7532311/i;
    var reported = false;
    function facts(){
      var t = text();
      var d = { href: String(location.href||'').slice(0,300), path: String(location.pathname||'') };
      try { d.ready = String(document.readyState||''); } catch(e){}
      try { d.len = t.replace(/\\s+/g,'').length; } catch(e){}
      try { d.inputs = document.querySelectorAll('input,button,form').length; } catch(e){}
      try { d.head = String((document.querySelector('h1,h2')||{}).innerText||'').trim().slice(0,120); } catch(e){}
      d.note = t.slice(0,240);
      d.refused = REFUSED.test(String(location.href||'')) || REFUSED.test(t.slice(0,4000));
      return d;
    }
    function check(tag){
      if (reported) return;
      var d = facts();
      if (d.refused) {
        reported = true;
        // Carry what Google ACTUALLY said. A refusal the user can read back to us is a symptom;
        // a bare "sign-in failed" is the guesswork that cost builds 185-190.
        post({ type:'GOOGLE_AUTH_BLOCKED', reason:'refused', href:d.href, note:d.note, head:d.head, tag:tag });
      }
    }
    [1200, 4000, 9000].forEach(function(ms){ setTimeout(function(){ check('t'+ms); }, ms); });
    // ⚠️ TELEMETRY ONLY — NEVER AN ALERT. The old "the page looks empty" heuristic raised a modal
    // and was wrong; a blank page is already visible to the user, and a confident wrong explanation
    // is worse than none. This just records what the page looked like so the NEXT report is data.
    setTimeout(function(){ var d = facts(); d.type = 'GOOGLE_AUTH_SEEN'; post(d); }, 6000);
  } catch(e){}
})(); true;`;

// ── No exit ramps ─────────────────────────────────────────────────────────────
// The user is mid-application. Every "Open in the app", "Continue in Safari", "Open in browser"
// banner is an invitation to leave — and leaving means the half-filled form, the attached resume
// and the cover letter are gone, because none of that exists outside this WebView.
//
// Three separate sources of that invitation, all handled here:
//   1. iOS Smart App Banner (<meta name="apple-itunes-app">) — the OS renders it, so the meta tag
//      has to go before the page settles.
//   2. The site's own interstitial/banner. Matched on BOTH an exit phrase AND an app-store or app
//      scheme link, so an ordinary cookie notice or job-alert bar is never touched.
//   3. Long-press on a link, which raises iOS's own "Open / Open in New Tab / Share" sheet.
//      -webkit-touch-callout kills that sheet while leaving text selection alone.
//
// Deliberately conservative: nothing is REMOVED unless it both talks like an exit ramp and links
// like one. Anything ambiguous is left on screen — a stray banner is a far smaller failure than a
// hidden Apply button.
export const NO_EXIT_JS = `(function(){
  if (window.__cvfSkipFrame || window.__cvfNoExit) return; window.__cvfNoExit = true;
  var EXIT_TX = /open (this )?(page |link )?(in|with) (the )?(app|browser|safari|chrome|google)|continue (in|with) (safari|chrome|the browser|browser|app)|view (this )?in (the )?app|get the app|use the app|switch to the app|open in app/i;
  var EXIT_HREF = /^(itms-apps|itms|market|intent|googlechrome|googleapp|x-safari-https?|x-web-search|fb|twitter|instagram|snssdk|vnd\\.youtube):|^https?:\\/\\/(apps\\.apple\\.com|itunes\\.apple\\.com|play\\.google\\.com\\/store)/i;
  function css(){
    try {
      if (document.getElementById('__cvf_noexit_css')) return;
      var st = document.createElement('style');
      st.id = '__cvf_noexit_css';
      // Links only — the page's own text stays selectable and copyable.
      st.textContent = 'a,img{-webkit-touch-callout:none !important;}';
      (document.head || document.documentElement).appendChild(st);
    } catch(e){}
  }
  function killMeta(){
    try {
      var m = document.querySelectorAll('meta[name="apple-itunes-app"], meta[name="google-play-app"]');
      for (var i=0;i<m.length;i++) m[i].parentNode && m[i].parentNode.removeChild(m[i]);
    } catch(e){}
  }
  function deadLink(a){
    try {
      a.removeAttribute('href'); a.removeAttribute('target');
      a.setAttribute('data-cvf-exit','1');
      a.addEventListener('click', function(ev){ ev.preventDefault(); ev.stopPropagation(); }, true);
    } catch(e){}
  }
  // Walk up from an exit link looking for the overlay that CONTAINS it. Bounded to 6 levels and
  // never as far as <body>, so we can never blank the page.
  //
  // ⚠️ THE SAFETY RULE IS "NO FORM FIELDS", NOT "NOT TOO TALL". A height cap was the first attempt
  // and it let the worst case straight through: a "Continue in Safari" interstitial is normally
  // position:fixed;inset:0, i.e. exactly full height, which is precisely when the user is stuck.
  // What actually must never be hidden is the application itself — so the test is for the thing
  // that makes it an application: an input, a textarea or a select. An exit ramp has none.
  function bannerFor(a){
    try {
      var n = a;
      for (var i=0;i<6 && n && n !== document.body && n !== document.documentElement;i++){
        var st = window.getComputedStyle(n);
        var r = n.getBoundingClientRect();
        var overlay = st && (st.position === 'fixed' || st.position === 'sticky' || Number(st.zIndex) > 100);
        if (overlay && r.height > 0 && !n.querySelector('input,textarea,select')) return n;
        n = n.parentElement;
      }
    } catch(e){}
    return null;
  }
  var runs = 0;
  function sweep(){
    if (runs++ > 40) return;                    // bounded: a page cannot make us loop forever
    css(); killMeta();
    try {
      var as = document.querySelectorAll('a[href]:not([data-cvf-exit])');
      for (var i=0;i<as.length;i++){
        var a = as[i], h = '';
        try { h = a.getAttribute('href') || ''; } catch(e){}
        if (!h || !EXIT_HREF.test(h)) continue;
        var host = bannerFor(a);
        var tx = '';
        try { tx = String((host || a).innerText || ''); } catch(e){}
        deadLink(a);
        // Hide the surrounding banner ONLY when it also reads like one. An app-store link inside a
        // normal page (a job at Apple, a "our app" footer link) loses its href and nothing else.
        if (host && EXIT_TX.test(tx)) {
          try { host.setAttribute('data-cvf-exit','1'); host.style.setProperty('display','none','important'); } catch(e){}
        }
      }
    } catch(e){}
  }
  sweep();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sweep);
  // Interstitials are usually injected a beat after load; watch briefly, throttled, then stop.
  try {
    var t = null;
    var mo = new MutationObserver(function(){ if (t) return; t = setTimeout(function(){ t = null; sweep(); }, 700); });
    mo.observe(document.documentElement, { childList:true, subtree:true });
    setTimeout(function(){ try { mo.disconnect(); } catch(e){} }, 30000);
  } catch(e){}
})(); true;`;
