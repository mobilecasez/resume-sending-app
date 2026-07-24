// AI Hub — new feature. Safe to delete without affecting existing app.
//
// What the app hands the extractor when a user taps "Fetch job".
//
// A job page is never just the posting. It also carries top navigation, a cookie banner, a contact
// form, a footer — and the one that actually costs us: a "more open roles" strip of short cards,
// each holding another role's title plus a one-line marketing tagline. On growtheroses.co.uk the
// card for the very job being fetched sat in that strip, and the extractor preferred its tagline
// ("Code. Build. Deploy. Innovate end-to-end. Scale impact.") over the page's real About the Role /
// Responsibilities / Requirements body.
//
// So we send BOTH: the full body text exactly as before — so this can never take away content the
// server used to see — plus the main content region for pages that mark one up. The server uses the
// main region only when it looks like a real posting body, and falls back to the full text.
export const PAGE_TEXT_FN = `
function cvfMainText(){
  try{
    var sels = ['main','[role=main]','article','[itemprop="description"]','#content','#main-content',
                '#job-description','.job-description','.job-details','.job-post','.posting','.opening'];
    var best = '';
    for (var s = 0; s < sels.length; s++){
      var els; try { els = document.querySelectorAll(sels[s]); } catch(e){ continue; }
      for (var i = 0; i < els.length && i < 6; i++){
        var t = ''; try { t = els[i].innerText || ''; } catch(e){}
        if (t.length > best.length) best = t;
      }
    }
    return best;
  }catch(e){ return ''; }
}`;

// Did the user actually TYPE something into this page?
//
// ⚠️ You cannot answer this by comparing `value` to `defaultValue`. React sets the DOM's
// defaultValue to the controlled value on every update (react-dom updateInput/updateTextarea), so
// on a React-built form — Greenhouse, Ashby, Workday, i.e. most application forms — the two are
// identical the instant the user types and the page looks untouched. Verified live on both.
//
// So record user INTENT instead: a capturing input/change listener can't be undone by any framework.
// This runs in EVERY frame (injectedJavaScriptForMainFrameOnly={false}), and because only the main
// frame has the postMessage bridge, subframes report upward with window.parent.postMessage.
export const FORM_TOUCH_JS = `(function(){
  if (window.__cvfTouchInit) return; window.__cvfTouchInit = true;
  window.__cvfDirty = false;
  function isSearchBox(el){
    try{
      if (!el) return false;
      var n = String(el.name || el.id || '').toLowerCase();
      var t = String(el.getAttribute && el.getAttribute('type') || '').toLowerCase();
      // A search box is how you USE a site, not work you'd be upset to lose.
      return t === 'search' || /^(q|s|search|query|keywords?|kw)$/.test(n);
    }catch(e){ return false; }
  }
  function mark(e){
    try{
      var el = e && e.target;
      if (!el || isSearchBox(el)) return;
      var tag = String(el.tagName || '').toUpperCase();
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !el.isContentEditable) return;
      window.__cvfDirty = true;
      try { if (window.parent && window.parent !== window) window.parent.postMessage({ __cvfDirty: 1 }, '*'); } catch(e2){}
    }catch(e3){}
  }
  try{
    document.addEventListener('input', mark, true);
    document.addEventListener('change', mark, true);
    // A frame telling us its user typed — keep passing it up to the main frame.
    window.addEventListener('message', function(ev){
      try{
        if (ev && ev.data && ev.data.__cvfDirty) {
          window.__cvfDirty = true;
          if (window.parent && window.parent !== window) window.parent.postMessage({ __cvfDirty: 1 }, '*');
        }
      }catch(e4){}
    }, false);
  }catch(e5){}
})(); true;`;
