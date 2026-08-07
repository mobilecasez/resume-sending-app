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
  var realClose = window.close;
  window.close = function(){ post({type:'AUTH_DONE', reason:'self-close'}); try{ realClose.call(window); }catch(e){} };
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
  document.addEventListener('click', function(ev){
    try {
      if (ev.defaultPrevented) return;
      if (ev.button && ev.button !== 0) return;
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var a = anchorOf(ev); if (!a) return;
      var raw = a.getAttribute('href') || '';
      if (!raw || raw.charAt(0) === '#') return;
      if (/^javascript:/i.test(raw)) return;
      var u = abs(raw); if (!u) return;
      if (!/^https?:/i.test(u)) { ev.preventDefault(); ev.stopPropagation(); return; }
      var host = ''; try { host = new URL(u).hostname; } catch(e){ return; }
      if (!host || host === location.hostname) return;
      ev.preventDefault(); ev.stopPropagation();
      window.location.assign(u);
    } catch(e){}
  }, true);
})(); true;`;
