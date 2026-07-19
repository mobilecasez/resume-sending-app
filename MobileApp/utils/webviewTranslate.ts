// AI Hub — new feature. Safe to delete without affecting existing app.
//
// In-page translation for the apply WebView, done entirely over the RN message bridge so a site's
// Content-Security-Policy can never block it. (Verified: arbeitsagentur.de sends
// `script-src 'self' https://web.arbeitsagentur.de …`, so Google's translate widget is hard-blocked
// there — every translation on that site must go through this path.)
//
// Design rules this replaces the old implementation with:
//  • REPEATABLE — a scan never short-circuits. The old collector returned an EMPTY item list when
//    `window.__cvfTx` already existed, and the RN side silently bailed on empty, so turning
//    translate back on after turning it off did nothing at all — no spinner, no text, no error.
//  • REVERSIBLE IN PLACE — we keep every original string, so "off" restores instantly instead of
//    doing location.reload(). No reload race, no lost scroll position, no lost form input.
//  • COMPLETE — text nodes AND the attributes users actually see (aria-label, title, placeholder,
//    alt) AND submit/button values, walking into shadow roots too. On the page above that is 173
//    strings instead of 125.
//  • LIVE — a MutationObserver reports newly rendered content so SPA views translate as they load.

export const XLATE_MARK = '__cvfX';

// Collect everything translatable, ALWAYS fresh. `gen` lets RN discard replies from a stale pass.
export const xlateScanJS = (gen: number): string => `(function(){
  function post(o){ try{ o.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  try{
    var SKIP={SCRIPT:1,STYLE:1,NOSCRIPT:1,TEXTAREA:1,CODE:1,PRE:1,IFRAME:1,SVG:1,svg:1};
    var ATTRS=['aria-label','title','placeholder','alt'];
    var st=window.${XLATE_MARK}||(window.${XLATE_MARK}={targets:[],seen:null});
    if(!st.seen||typeof WeakSet==='undefined'){ try{ st.seen=new WeakSet(); }catch(e){ st.seen=null; } }
    var fresh=[], items=[];
    function want(s){ return s.length>=2 && /[A-Za-z\\u00C0-\\u024F\\u0400-\\u04FF\\u0370-\\u03FF]/.test(s); }
    function push(rec,text){ rec.orig=text; fresh.push(rec); items.push({i:String(fresh.length-1), t:text}); }
    function seenAdd(k){ try{ if(st.seen) st.seen.add(k); }catch(e){} }
    function seenHas(k){ try{ return st.seen ? st.seen.has(k) : false; }catch(e){ return false; } }
    function walk(root){
      try{
        var w=document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), n;
        while((n=w.nextNode())){
          var p=n.parentNode; if(!p||SKIP[p.nodeName]) continue;
          try{ if(p.closest && p.closest('[translate="no"],.notranslate')) continue; }catch(e){}
          var s=(n.nodeValue||'').replace(/\\s+/g,' ').trim();
          if(!want(s)||seenHas(n)) continue;
          seenAdd(n); push({k:'t',n:n}, s);
        }
        var els=root.querySelectorAll('*');
        for(var i=0;i<els.length;i++){
          var el=els[i];
          for(var a=0;a<ATTRS.length;a++){
            var v=el.getAttribute?el.getAttribute(ATTRS[a]):null;
            if(!v) continue;
            var sv=String(v).replace(/\\s+/g,' ').trim();
            if(!want(sv)) continue;
            var key=el.tagName+'|'+ATTRS[a]+'|'+sv;
            if(el.__cvfA&&el.__cvfA[ATTRS[a]]) continue;
            if(!el.__cvfA) el.__cvfA={};
            el.__cvfA[ATTRS[a]]=1;
            push({k:'a',e:el,a:ATTRS[a]}, sv);
          }
          var ty=(el.type||'').toLowerCase();
          if(el.tagName==='INPUT'&&(ty==='submit'||ty==='button'||ty==='reset')&&el.value&&!seenHas(el)){
            var sb=String(el.value).replace(/\\s+/g,' ').trim();
            if(want(sb)){ seenAdd(el); push({k:'v',e:el}, sb); }
          }
          if(el.shadowRoot) walk(el.shadowRoot);
        }
      }catch(e){}
    }
    walk(document.body);
    st.gen=${gen};
    st.pending=fresh;
    post({type:'XLATE_ITEMS', gen:${gen}, items:items, n:items.length});
  }catch(e){ post({type:'XLATE_ITEMS', gen:${gen}, items:[], n:0, error:String(e&&e.message||e)}); }
})(); true;`;

// Write the translations back. Originals stay on each record so "off" can restore them.
export const xlateApplyJS = (gen: number, map: Record<string, string>): string => `(function(){
  try{
    var st=window.${XLATE_MARK}; if(!st||st.gen!==${gen}||!st.pending) return;
    var M=${JSON.stringify(map)}, list=st.pending, done=0;
    for(var k in M){
      var r=list[+k]; if(!r||M[k]==null||M[k]==='') continue;
      try{
        if(r.k==='t'&&r.n&&r.n.nodeValue!=null){
          var o=r.n.nodeValue, L=(o.match(/^\\s*/)||[''])[0], T=(o.match(/\\s*$/)||[''])[0];
          r.n.nodeValue=L+M[k]+T; done++;
        } else if(r.k==='a'&&r.e){ r.e.setAttribute(r.a, M[k]); done++; }
        else if(r.k==='v'&&r.e){ r.e.value=M[k]; done++; }
      }catch(e){}
    }
    st.targets=(st.targets||[]).concat(list);
    st.pending=null; st.on=true;
    document.documentElement.setAttribute('data-cvf-xlated','1');
    try{ var o2={type:'XLATE_APPLIED', gen:${gen}, count:done}; o2.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o2)); }catch(e){}
  }catch(e){}
})(); true;`;

// Put the page back to its original language IN PLACE — no reload, so nothing the user typed is lost.
export const XLATE_RESTORE_JS = `(function(){
  try{
    var st=window.${XLATE_MARK}; if(!st) return;
    var list=(st.targets||[]);
    for(var i=0;i<list.length;i++){
      var r=list[i]; if(!r||r.orig==null) continue;
      try{
        if(r.k==='t'&&r.n&&r.n.nodeValue!=null){
          var o=r.n.nodeValue, L=(o.match(/^\\s*/)||[''])[0], T=(o.match(/\\s*$/)||[''])[0];
          r.n.nodeValue=L+r.orig+T;
        } else if(r.k==='a'&&r.e){ r.e.setAttribute(r.a, r.orig); if(r.e.__cvfA) r.e.__cvfA[r.a]=0; }
        else if(r.k==='v'&&r.e){ r.e.value=r.orig; }
      }catch(e){}
    }
    // Drop the de-dupe marks so a later re-translate picks everything up again. Clear them from the
    // RECORDED targets (above) rather than a document-wide query — querySelectorAll('*') never
    // reaches inside shadow roots, which silently skipped those attributes on the next pass.
    st.targets=[]; st.pending=null; st.on=false;
    try{ st.seen=new WeakSet(); }catch(e){ st.seen=null; }
    document.documentElement.removeAttribute('data-cvf-xlated');
  }catch(e){}
})(); true;`;

// Tell RN when the page renders new content, so an SPA view keeps getting translated while ON.
export const XLATE_WATCH_JS = `(function(){
  if (window.__cvfXWatch) return; window.__cvfXWatch = true;
  function post(o){ try{ o.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  var t=null;
  function ping(){ if(t) return; t=setTimeout(function(){ t=null;
    var st=window.${XLATE_MARK}; if(st&&st.on) post({type:'XLATE_DIRTY'});
  }, 900); }
  try{
    var mo=new MutationObserver(function(muts){
      for(var i=0;i<muts.length;i++){ if(muts[i].addedNodes&&muts[i].addedNodes.length){ ping(); return; } }
    });
    mo.observe(document.documentElement,{childList:true,subtree:true});
  }catch(e){}
})(); true;`;
