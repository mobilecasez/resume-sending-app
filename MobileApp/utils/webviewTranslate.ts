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
// Called ONCE PER ROUND, not once per page: a long page is translated in several rounds and each is
// written as it lands, so the text fills in visibly instead of the user staring at a spinner for a
// minute. Only the last round (`final`) closes the pass — until then `st.pending` must survive, and
// `st.on` stays false so our own DOM writes don't wake the MutationObserver and cancel the pass.
export const xlateApplyJS = (gen: number, map: Record<string, string>, final = true): string => {
  const FIN = final ? '1' : '0';
  return `(function(){
  try{
    var st=window.${XLATE_MARK}; if(!st||st.gen!==${gen}||!st.pending) return;
    var M=${JSON.stringify(map)}, list=st.pending, done=0, fresh=[];
    for(var k in M){
      var r=list[+k]; if(!r||M[k]==null||M[k]===''||r.__cvfDone) continue;
      try{
        var wrote=false;
        if(r.k==='t'&&r.n&&r.n.nodeValue!=null){
          var o=r.n.nodeValue, L=(o.match(/^\\s*/)||[''])[0], T=(o.match(/\\s*$/)||[''])[0];
          r.n.nodeValue=L+M[k]+T; wrote=true;
        } else if(r.k==='a'&&r.e){ r.e.setAttribute(r.a, M[k]); wrote=true; }
        else if(r.k==='v'&&r.e){ r.e.value=M[k]; wrote=true; }
        if(wrote){ r.__cvfDone=1; fresh.push(r); done++; }
      }catch(e){}
    }
    st.targets=(st.targets||[]).concat(fresh);
    if(${FIN}){ st.pending=null; st.on=true; }
    document.documentElement.setAttribute('data-cvf-xlated','1');
    try{ var o2={type:'XLATE_APPLIED', gen:${gen}, count:done, final:${FIN}}; o2.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o2)); }catch(e){}
  }catch(e){}
})(); true;`;
};

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

export type XlateItem = { i: string; t: string };

// Is this page ALREADY English? With translation on by default we'd otherwise pay a round trip on
// every page just to be handed the same words back — and on an English search that is every page.
// Deliberately conservative: it only says "already English" on a strong signal, so a Dutch or German
// page sprinkled with English job titles still gets translated.
const EN_WORDS = /\b(the|and|for|with|you|your|are|our|will|this|that|from|have|has|about|more|all|not|can|who|what|when|apply|jobs?|work|team|role|company|experience|skills|search|sign|home|contact|us|we|to|of|in|on|at|is|be|as|by|it|or|an|a)\b/gi;
// Counting English words alone is not enough: "in", "an", "at", "us" are common in German and Dutch
// too, and a government site peppered with English loanwords scored as English (bund.de did). So
// also look for function words English simply doesn't have — those are decisive.
const FOREIGN_WORDS = /\b(der|die|das|und|für|fur|mit|von|nicht|sich|auch|eine|einen|einem|bei|aus|dem|den|des|sind|wir|ihre|oder|über|uber|zum|zur|werden|kann|nach|wird|beim|unter|zwischen|het|een|voor|van|niet|onze|naar|bij|ook|maar|worden|deze|zijn|wordt|le|la|les|des|une|pour|avec|dans|vous|nous|est|sur|par|plus|aux|leur|cette|sont|el|los|las|para|con|una|por|que|como|más|mas|del|il|lo|gli|della|delle|nel|sono|anche|dei|se|di|da|em|não|nao|uma|dos)\b/gi;
// Anything outside Latin-1 basic + Latin Extended-A is a different script entirely — never English.
const NON_LATIN = /[Ѐ-ӿͰ-Ͽ֐-׿؀-ۿऀ-ॿ一-鿿぀-ヿ가-힯]/;
// Letters English simply does not use. A page carrying many of these is not an English page.
const FOREIGN_LETTERS = /[àâäãåçéèêëîïìíñóòôöõøùûüúýÿœæßđłşžčćšğı]/gi;

export function looksAlreadyEnglish(items: XlateItem[]): boolean {
  // Judge the PROSE, not the chrome — one-word nav labels look the same in most languages.
  const prose = items.map((i) => i.t).filter((t) => t.split(/\s+/).length >= 4);
  if (prose.length < 4) return false;                       // too little to be sure → translate
  const text = prose.join(' ');
  if (NON_LATIN.test(text)) return false;
  const words = text.split(/\s+/).length;
  if (words < 40) return false;
  const foreign = (text.match(FOREIGN_LETTERS) || []).length;
  if (foreign / Math.max(1, text.length) > 0.004) return false;   // accents well above English's stray loanwords
  const foreignWords = (text.match(FOREIGN_WORDS) || []).length;
  if (foreignWords / words >= 0.02) return false;             // function words English doesn't have
  const english = (text.match(EN_WORDS) || []).length;
  return english / words >= 0.18;                            // English prose sits far above this
}

// How a scan's strings get to the backend. Chunks match the server's own sub-batching, so each
// request comes back in a few seconds rather than one slow all-or-nothing call.
export const XLATE_CHUNK = 40;
export const XLATE_PARALLEL = 3;

// Run one full translation pass and write each round back as it arrives.
//
// DEDUPE is the big win: a page repeats the same strings constantly — nav items, "Apply", "Save",
// section labels, every job card's "Full time" — and on a LinkedIn job page that repetition is most
// of the payload. Translating each DISTINCT string once and fanning the answer back to every
// occurrence cuts both the wait and the number of calls, with identical output.
//
// Returns how many occurrences were written. 0 means the whole pass failed and the caller should say
// so; anything above 0 is a success, even if some chunks fell over — a partly translated page beats
// an error over a page that was mostly readable.
export async function runXlatePasses(
  items: XlateItem[],
  translate: (batch: XlateItem[]) => Promise<Record<string, string>>,
  onRound: (map: Record<string, string>, final: boolean) => void,
  stale: () => boolean,
): Promise<number> {
  const byText = new Map<string, string[]>();
  for (const it of items) {
    const seen = byText.get(it.t);
    if (seen) seen.push(it.i); else byText.set(it.t, [it.i]);
  }
  const uniq: XlateItem[] = [];
  const owners: string[][] = [];
  byText.forEach((idxs, t) => { uniq.push({ i: String(uniq.length), t }); owners.push(idxs); });

  const chunks: XlateItem[][] = [];
  for (let k = 0; k < uniq.length; k += XLATE_CHUNK) chunks.push(uniq.slice(k, k + XLATE_CHUNK));

  let applied = 0;
  for (let k = 0; k < chunks.length; k += XLATE_PARALLEL) {
    if (stale()) return applied;
    const parts = await Promise.all(chunks.slice(k, k + XLATE_PARALLEL).map((c) => translate(c).catch(() => ({}))));
    if (stale()) return applied;
    const fan: Record<string, string> = {};
    for (const part of parts) {
      for (const uk of Object.keys(part || {})) {
        const owner = owners[+uk];
        const v = (part as Record<string, string>)[uk];
        if (!owner || typeof v !== 'string' || !v) continue;
        for (const orig of owner) fan[orig] = v;
      }
    }
    const n = Object.keys(fan).length;
    const isLast = k + XLATE_PARALLEL >= chunks.length;
    applied += n;
    // Never mark the page translated on a pass that wrote nothing at all — the caller alerts instead.
    if (n || (isLast && applied > 0)) onRound(fan, isLast);
  }
  return applied;
}

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
