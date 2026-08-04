// VENDOR-NEUTRAL WIDGET TAXONOMY probe.
//
//   node tools/probe-widget-archetypes.js <urls.json|url> [--limit N] [--out file.jsonl]
//
// probe-apply-form.js answers "how many controls does this form have". This one answers a harder
// question: "what KINDS of widget must Auto Fill be able to drive, and can our engine even SEE
// them". Every test in here is STRUCTURAL — role/aria/shape/behaviour. Nothing matches a vendor
// name, a CSS framework or a button's wording, because the same widget ships under twenty names.
//
// It reports, per page:
//   ARCHETYPES  — every widget instance, classified, with the anchor element's tag so you can tell
//                 at a glance whether the shipped scan (which walks ONLY input/textarea/select)
//                 could ever have found it.
//   ENGINE      — the same page as seen by the REAL shipped READ_FIELDS_JS from job-detail.tsx.
//   GESTURES    — for a bounded sample, WHICH gesture actually opens/sets the widget, measured:
//                 .value assignment, .click(), pointer sequence, or a popup search box.
//
// ⚠️ SAFETY, because these are strangers' live application forms:
//   • Every submit path is neutralised BEFORE any gesture, and the run ASSERTS zero submits after.
//   • The only text ever entered is a meaningless two-letter stem ("am") typed into a suspected
//     typeahead to see whether it fetches suggestions, and it is REMOVED again straight after.
//     No answer is ever composed and no application is ever sent.
//   • No demographic value is ever derived — this probe fills no answers at all, so there is nothing
//     it could infer a person's ethnicity, disability, veteran status, gender or pronouns from.
//   • Clicking is limited to opening widgets and to repeater candidates that have cleared three
//     independent submit refusals. Nothing that could be a submit or a "next" is ever activated.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'MobileApp', 'app', '(ai-hub)', 'job-detail.tsx'), 'utf8');
function raw(name) {
  const m = SRC.match(new RegExp('(?:export )?const ' + name + ' = `([\\s\\S]*?)`;\\n'));
  if (!m) throw new Error('could not extract ' + name);
  return m[1];
}
const JS_HELPERS = new Function('JS_HELPERS', 'return `' + raw('JS_HELPERS') + '`;')('');
const READ_FIELDS_JS = new Function('JS_HELPERS', 'return `' + raw('READ_FIELDS_JS') + '`;')(JS_HELPERS);

// ── the classifier, injected into the page ────────────────────────────────────
const CLASSIFY = function () {
  const out = { archetypes: [], notes: [] };
  const seen = new Set();

  function deep(sel, root) {
    const acc = []; let budget = 0;
    (function walk(r) {
      if (budget > 20000) return;
      try {
        r.querySelectorAll(sel).forEach((e) => acc.push(e));
        const all = r.querySelectorAll('*'); budget += all.length;
        all.forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
      } catch (e) {}
    })(root || document);
    return acc;
  }
  const vis = (el) => { try { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0; } catch (e) { return false; } };
  const txt = (el) => { try { return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e) { return ''; } };
  const attr = (el, a) => { try { return el.getAttribute(a) || ''; } catch (e) { return ''; } };
  const cls = (el) => { try { let c = el.className; if (c && typeof c !== 'string' && c.baseVal != null) c = c.baseVal; return String(c || ''); } catch (e) { return ''; } };
  const tag = (el) => String(el.tagName || '').toLowerCase();

  function labelOf(el) {
    const bits = [];
    try { if (el.labels && el.labels.length) bits.push(txt(el.labels[0])); } catch (e) {}
    if (attr(el, 'aria-label')) bits.push(attr(el, 'aria-label'));
    const lb = attr(el, 'aria-labelledby');
    if (lb) { const n = document.getElementById(lb.split(' ')[0]); if (n) bits.push(txt(n)); }
    if (el.id && !bits.length) { try { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) bits.push(txt(l)); } catch (e) {} }
    if (!bits.length) {
      let p = el.parentElement, h = 0;
      while (p && h < 4) { const t = txt(p); if (t && t.length <= 140) { bits.push(t); break; } p = p.parentElement; h++; }
    }
    if (!bits.length && attr(el, 'placeholder')) bits.push(attr(el, 'placeholder'));
    if (!bits.length && attr(el, 'name')) bits.push(attr(el, 'name'));
    return bits.filter(Boolean).join(' | ').replace(/\s+/g, ' ').slice(0, 140);
  }

  // A short structural fingerprint of the form controls inside a subtree. Two sibling nodes with
  // the SAME fingerprint and a non-trivial one are a repeated row — the signature of a repeater.
  function ctrlSig(node) {
    try {
      const cs = node.querySelectorAll('input,textarea,select,[role=combobox],[role=radio],[role=checkbox]');
      if (!cs.length) return '';
      return Array.from(cs).map((c) => tag(c) + ':' + ((c.type || attr(c, 'role') || '')).toLowerCase()).join(',');
    } catch (e) { return ''; }
  }

  function push(kind, el, extra) {
    if (seen.has(el)) return;
    seen.add(el);
    out.archetypes.push(Object.assign({
      kind,
      tag: tag(el),
      role: attr(el, 'role'),
      type: (el.type || '').toLowerCase(),
      label: labelOf(el),
      // The single most load-bearing fact: our scan's ctrls() returns ONLY these three tags.
      reachableByScan: ['input', 'textarea', 'select'].indexOf(tag(el)) >= 0,
    }, extra || {}));
  }

  // ── 1. native controls ──────────────────────────────────────────────────────
  const natives = deep('input,textarea,select');
  const radiosByName = {};
  const checkboxes = [];
  natives.forEach((el) => {
    const t = (el.type || '').toLowerCase();
    if (t === 'hidden' || t === 'submit' || t === 'reset' || t === 'image') return;
    if (t !== 'file' && !vis(el)) return;
    if (tag(el) === 'select') { push(el.multiple ? 'native-multiselect' : 'native-select', el, { options: el.options.length }); return; }
    if (tag(el) === 'textarea') { push('long-text', el); return; }
    if (t === 'file') { push('file', el, { hidden: !vis(el), accept: attr(el, 'accept') }); return; }
    if (t === 'radio') { const k = el.name || '(unnamed)'; (radiosByName[k] = radiosByName[k] || []).push(el); return; }
    if (t === 'checkbox') { checkboxes.push(el); return; }
    if (t === 'date' || t === 'month' || t === 'week' || t === 'datetime-local') { push('native-date', el, { inputType: t }); return; }
    // a text-shaped input can still be a TRIGGER or a TYPEAHEAD or a TAG input
    const isCombo = attr(el, 'role') === 'combobox' || attr(el, 'aria-haspopup') === 'listbox' || attr(el, 'aria-autocomplete') === 'list';
    const trigger = t === 'button' || el.readOnly === true;
    if (isCombo && trigger) { push('combo-trigger', el, { anchor: 'input' }); return; }
    if (isCombo) {
      // tag/chip input: the control's own wrapper already renders removable tokens
      const w = el.closest('[class*=control],[class*=container],[class*=root],[class*=wrapper]') || el.parentElement;
      const chips = w ? w.querySelectorAll('[class*=multi-value],[class*=multiValue],[class*=chip],[class*=tag],[class*=token],[class*=pill]') : [];
      push(chips && chips.length ? 'tag-chip-input' : 'combo-typeahead', el, { chips: chips ? chips.length : 0, multi: attr(el, 'aria-multiselectable') === 'true' });
      return;
    }
    if (t === 'button') { push('button-input', el); return; }
    if (el.readOnly) { push('readonly-input', el, { hint: 'readOnly text input — usually a picker trigger with no aria' }); return; }
    push('text', el, { inputType: t });
  });

  Object.keys(radiosByName).forEach((name) => {
    const g = radiosByName[name];
    push('native-radio-group', g[0], { members: g.length, groupName: name, options: g.map((r) => labelOf(r).slice(0, 40)).slice(0, 12) });
  });

  // Checkbox GROUP vs standalone: the nearest ancestor that contains >1 checkbox and no other
  // control type is the group. Structural, no wording.
  const cbGroups = new Map();
  checkboxes.forEach((el) => {
    let p = el.parentElement, h = 0, group = null;
    while (p && h < 6) {
      const cbs = p.querySelectorAll('input[type=checkbox]');
      const others = p.querySelectorAll('input:not([type=checkbox]):not([type=hidden]),textarea,select');
      if (cbs.length >= 2 && others.length === 0) { group = p; }
      if (cbs.length >= 2 && others.length > 0) break;
      p = p.parentElement; h++;
    }
    if (group) { if (!cbGroups.has(group)) cbGroups.set(group, []); cbGroups.get(group).push(el); }
    else {
      const L = labelOf(el).toLowerCase();
      push(/consent|agree|privacy|gdpr|terms|permission|policy|authoris|authoriz/.test(L) ? 'consent-checkbox' : 'boolean-checkbox', el);
    }
  });
  cbGroups.forEach((members, g) => {
    push('checkbox-group', members[0], {
      members: members.length,
      options: members.map((m) => labelOf(m).slice(0, 40)).slice(0, 12),
      // the group's QUESTION is the container text minus the option labels
      question: (() => { let t = txt(g); members.forEach((m) => { const l = labelOf(m); if (l) t = t.split(l).join(' '); }); return t.replace(/\s+/g, ' ').trim().slice(0, 120); })(),
    });
  });

  // ── 2. custom widgets that are NOT input/textarea/select ────────────────────
  deep('[role=combobox],[role=listbox],[aria-haspopup=listbox],[role=radiogroup],[role=switch],[role=checkbox],[role=radio],[role=spinbutton],[role=slider],[aria-multiselectable=true]').forEach((el) => {
    if (!vis(el)) return;
    if (['input', 'textarea', 'select'].indexOf(tag(el)) >= 0) return;   // counted above
    const r = attr(el, 'role');
    if (r === 'switch') { push('custom-switch', el, { checked: attr(el, 'aria-checked') }); return; }
    if (r === 'radiogroup') {
      const kids = el.querySelectorAll('[role=radio]');
      // a radiogroup whose members are native inputs is just a native group with an aria wrapper
      const nativeKids = el.querySelectorAll('input[type=radio]');
      if (nativeKids.length) return;
      push('custom-radio-group', el, { members: kids.length, options: Array.from(kids).map((k) => txt(k).slice(0, 30)).slice(0, 10) });
      return;
    }
    if (r === 'radio') { if (el.closest('[role=radiogroup]')) return; push('custom-radio-orphan', el); return; }
    if (r === 'checkbox') { push('custom-checkbox', el, { checked: attr(el, 'aria-checked') }); return; }
    if (r === 'listbox') {
      // an INLINE listbox (no trigger) vs a popup already open
      push('inline-listbox', el, { members: el.querySelectorAll('[role=option]').length });
      return;
    }
    if (r === 'combobox' || attr(el, 'aria-haspopup') === 'listbox') { push('combo-div', el, { hasInputInside: !!el.querySelector('input') }); return; }
    if (r === 'spinbutton') { push('custom-spinbutton', el); return; }
    if (r === 'slider') { push('custom-slider', el); return; }
  });

  // Segmented control: 2-5 sibling buttons in one row, mutually exclusive, no aria roles at all.
  // Structural test: a container whose children are ALL buttons with short text and where exactly
  // one carries a "selected/active/checked" state attribute or a distinct aria-pressed.
  deep('div,fieldset,ul,section').forEach((c) => {
    if (!vis(c)) return;
    const kids = Array.from(c.children || []);
    if (kids.length < 2 || kids.length > 6) return;
    const btns = kids.filter((k) => tag(k) === 'button' || attr(k, 'role') === 'button' || (tag(k) === 'label' && k.querySelector('input[type=radio]')));
    if (btns.length !== kids.length) return;
    if (btns.some((b) => tag(b) === 'label')) return;                      // native radios in disguise — already counted
    if (btns.some((b) => txt(b).length > 28 || !txt(b))) return;
    const pressed = btns.filter((b) => attr(b, 'aria-pressed') || attr(b, 'aria-selected') || /(^|[-_ ])(selected|active|checked|current)([-_ ]|$)/i.test(cls(b)));
    if (!pressed.length) return;
    push('segmented-control', c, { members: btns.length, options: btns.map((b) => txt(b).slice(0, 24)) });
  });

  // Tag/chip PICKERS with no input at all: a run of >=4 sibling clickable short-text nodes that
  // toggle. (Skill chips.) Distinguished from a segmented control by count and by nothing being
  // preselected.
  deep('div,ul,section').forEach((c) => {
    if (!vis(c)) return;
    const kids = Array.from(c.children || []);
    if (kids.length < 4) return;
    const chips = kids.filter((k) => (tag(k) === 'button' || attr(k, 'role') === 'button' || attr(k, 'role') === 'option' || /chip|tag|pill|token|badge/i.test(cls(k))) && txt(k) && txt(k).length <= 32);
    if (chips.length < 4 || chips.length !== kids.length) return;
    push('chip-picker', c, { members: chips.length, options: chips.map((k) => txt(k).slice(0, 24)).slice(0, 10) });
  });

  // File DROPZONE wrapping a hidden file input (the input is invisible, the target is the div).
  deep('input[type=file]').forEach((f) => {
    if (vis(f)) return;
    const dz = f.closest('[class*=drop],[class*=upload],[class*=dropzone]') || f.parentElement;
    if (dz && vis(dz)) out.notes.push('file input hidden behind a dropzone: ' + txt(dz).slice(0, 60));
  });

  // ── 3. repeaters — candidates only; confirmation needs a click (done in node) ─
  // STRUCTURAL, not textual. A repeater button is a non-submit activatable that sits INSIDE or
  // IMMEDIATELY AFTER a container holding form controls, and whose accessible name is short.
  // Vendors word it "+ Add", "Add file", "Add", "Ajouter", "Weitere hinzufügen" — so wording is
  // recorded but never used to decide.
  const repCands = [];
  deep('button,[role=button],a').forEach((el) => {
    if (!vis(el)) return;
    const t = txt(el);
    if (!t || t.length > 34) return;
    const at = String(attr(el, 'type') || '').toLowerCase();
    if (at === 'submit' || at === 'image' || at === 'reset') return;
    if (tag(el) === 'a' && attr(el, 'href') && attr(el, 'href') !== '#' && attr(el, 'href').indexOf('javascript:') !== 0) return;
    // must live next to fields
    let host = el.parentElement, h = 0, near = false;
    while (host && h < 4) { if (host.querySelector && host.querySelector('input,textarea,select')) { near = true; break; } host = host.parentElement; h++; }
    if (!near) return;
    // and its sibling subtree must look like a repeatable ROW (a group with its own controls)
    const prev = el.previousElementSibling;
    const rowSig = prev ? ctrlSig(prev) : '';
    const parentRows = host ? Array.from(host.children).map(ctrlSig).filter(Boolean) : [];
    const dupRows = parentRows.filter((s, i) => parentRows.indexOf(s) !== i).length;
    if (!rowSig && !dupRows) {
      // still a candidate if the text is add-ish; recorded so we can MEASURE whether text-matching
      // would have been necessary at all
      if (!/^\+?\s*(add|another|more|new)|^\+$/i.test(t)) return;
    }
    repCands.push(el);
    push('repeater-candidate', el, { text: t, rowSig, dupRows, addish: /^\+?\s*(add|another|more|new)|^\+$/i.test(t) });
  });
  window.__cvfRepCands = repCands;

  // ── 4. custom date pickers: a control whose popup is a calendar GRID ─────────
  deep('[role=grid],[class*=calendar],[class*=datepicker],[class*=date-picker]').forEach((el) => {
    if (!vis(el)) return;
    push('calendar-popup-open', el, { hint: 'a calendar was already on screen' });
  });

  out.counts = {};
  out.archetypes.forEach((a) => { out.counts[a.kind] = (out.counts[a.kind] || 0) + 1; });
  out.invisibleToScan = out.archetypes.filter((a) => !a.reachableByScan).length;
  return out;
};

// ── gesture measurement, injected ─────────────────────────────────────────────
// The question this answers: WHICH GESTURE actually opens a widget's list, and which one merely
// LOOKS like it worked. Measured, never assumed.
//
// ⚠️ It is STAGED — gesture, wait, measure — and it must stay staged. The first version applied the
// gesture and read the DOM in the same synchronous evaluate, so every React widget on every page
// came back "did not open": the popup mounts on the next tick. It reported four Revolut dropdowns
// as unopenable when in fact a plain .click() opens all four.
//
// The popup test is "a list-shaped node BECAME VISIBLE as a result of our gesture". Nothing else
// works: a page's nav menu, a footer link column and a sibling button row are all list-shaped and
// visible the whole time.
const G_HELPERS = `
  var __gvis = function(n){ try{ var r=n.getBoundingClientRect(); var s=getComputedStyle(n); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&parseFloat(s.opacity||'1')>0; }catch(e){ return false; } };
  var __gtxt = function(n){ try{ return String(n.innerText||n.textContent||'').replace(/\\s+/g,' ').trim(); }catch(e){ return ''; } };
  var __gsnap = function(){ var s=new Set(); document.querySelectorAll('*').forEach(function(n){ if(__gvis(n)) s.add(n); }); return s; };
  // A list = several SIBLING clickable leaves, each carrying one short label. Same structural rule
  // the shipped engine uses (cbLooksLikeList), so what this measures is what the engine could find.
  var __growcount = function(n){
    var c=0;
    try{
      n.querySelectorAll('[role=option],li,button,[role=button],[class*=item],[class*=Item],[class*=Cell],[class*=option],[class*=row]').forEach(function(k){
        if(c>400) return;
        if(!__gvis(k)) return;
        if(k.querySelector && k.querySelector('[role=option],button,[role=button]')) return;
        var t=__gtxt(k); if(!t||t.length>120) return;
        c++;
      });
    }catch(e){}
    return c;
  };
  var __gbest = function(before, trigger){
    var best=null, bestC=0;
    document.querySelectorAll('*').forEach(function(n){
      if(before.has(n) || !__gvis(n)) return;
      var c=__growcount(n);
      if(c>=2 && c>bestC){ bestC=c; best=n; }
    });
    if(!best) return null;
    var o={ rows:bestC, role:best.getAttribute('role')||'', cls:String((typeof best.className==='string'?best.className:'')||'').slice(0,70), tag:best.tagName.toLowerCase() };
    // ⚠️ The node holding the rows is usually the OVERLAY, whose scrollHeight equals its
    // clientHeight — the scrolling happens in a descendant. Measuring the overlay reported
    // "not virtualised" for a list that is famously virtualised, so find the real scroller.
    var scr=best, gap=0;
    try{
      var kids=best.querySelectorAll('*');
      for(var q=0;q<kids.length&&q<3000;q++){
        var g=(kids[q].scrollHeight||0)-(kids[q].clientHeight||0);
        if(g>gap && kids[q].clientHeight>60){ gap=g; scr=kids[q]; }
      }
      var selfGap=(best.scrollHeight||0)-(best.clientHeight||0);
      if(selfGap>gap){ gap=selfGap; scr=best; }
    }catch(e){}
    try{ o.clientHeight=scr.clientHeight; o.scrollHeight=scr.scrollHeight; o.scrollerCls=String((typeof scr.className==='string'?scr.className:'')||'').slice(0,50); }catch(e){}
    // VIRTUALISED: far more hidden height than the rows we can actually read could ever fill.
    o.virtualised = !!(o.clientHeight>0 && (o.scrollHeight-o.clientHeight) > bestC*40*1.4);
    // does the popup ship its own SEARCH box (inside it, or in a sticky header above it)?
    var p=best, h=0, sb=null;
    while(p && h<5 && !sb){
      try{ Array.prototype.slice.call(p.querySelectorAll('input')).forEach(function(i){
        if(!sb && i!==trigger && !i.readOnly && ['text','search',''].indexOf((i.type||'').toLowerCase())>=0 && __gvis(i) && !before.has(i)) sb=i;
      }); }catch(e){}
      p=p.parentElement; h++;
    }
    o.searchBox = sb ? (sb.getAttribute('aria-label')||sb.placeholder||sb.name||'unnamed').slice(0,50) : null;
    // is the popup in a PORTAL (mounted at body level, outside the trigger's own subtree)?
    try{ o.portal = !!(trigger && trigger.parentElement && !trigger.parentElement.contains(best)); }catch(e){ o.portal=null; }
    return o;
  };
`;

// stage A — describe the target and take the "before" picture
const G_BEGIN = new Function('idx', G_HELPERS + `
  var el=(window.__cvfProbeTargets||[])[idx];
  if(!el) return { idx:idx, error:'gone' };
  window.__gEl=el; window.__gBefore=__gsnap();
  var lab='';
  try{ lab=(el.getAttribute('aria-label')||(el.labels&&el.labels[0]&&el.labels[0].innerText)||el.placeholder||el.name||__gtxt(el).slice(0,40)||''); }catch(e){}
  return {
    idx: idx,
    tag: String(el.tagName||'').toLowerCase(),
    type: (el.type||'').toLowerCase(),
    readOnly: !!el.readOnly,
    role: el.getAttribute('role')||'',
    ariaPopup: el.getAttribute('aria-haspopup')||'',
    ariaExpanded: el.getAttribute('aria-expanded'),
    ariaControls: !!el.getAttribute('aria-controls'),
    label: String(lab).replace(/\\s+/g,' ').trim().slice(0,80)
  };
`);

// stage B — one gesture, applied and nothing else. Measurement is a separate call, after a wait.
const G_APPLY = new Function('kind', G_HELPERS + `
  var el=window.__gEl; if(!el) return { error:'gone' };
  window.__gBefore=__gsnap();
  try{
    if(kind==='setNative'){
      // The gesture a naive filler uses. On a widget it does nothing at all — but the value READS
      // BACK, which is why a read-back check reports success on a form that submits empty.
      var proto = el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
      var d=Object.getOwnPropertyDescriptor(proto,'value');
      window.__gPrev = el.value;
      if(d&&d.set) d.set.call(el,'AAprobe');
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return { applied:'setNative', valueReadsBack: el.value==='AAprobe' };
    }
    if(kind==='undoSetNative'){
      var proto2 = el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
      var d2=Object.getOwnPropertyDescriptor(proto2,'value');
      if(d2&&d2.set) d2.set.call(el, window.__gPrev==null?'':window.__gPrev);
      el.dispatchEvent(new Event('input',{bubbles:true}));
      return { applied:'undo' };
    }
    if(kind==='click'){ el.click(); return { applied:'el.click()' }; }
    if(kind==='mouse'){
      // EXACTLY what the shipped cbSafeClick does: mousedown, mouseup, then .click(). Kept as its
      // own rung so the report can say whether the engine's existing gesture is already enough or
      // whether a widget needs pointer events it never sends.
      el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
      el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      if(el.click) el.click(); else el.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      return { applied:'mousedown+mouseup+click (== engine cbSafeClick)' };
    }
    if(kind==='pointer'){
      ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){
        var E = /pointer/.test(t) ? (window.PointerEvent||MouseEvent) : MouseEvent;
        el.dispatchEvent(new E(t,{bubbles:true,cancelable:true,composed:true}));
      });
      return { applied:'pointer sequence' };
    }
    if(kind==='arrow'){
      el.focus();
      ['keydown','keyup'].forEach(function(t){ el.dispatchEvent(new KeyboardEvent(t,{key:'ArrowDown',code:'ArrowDown',keyCode:40,which:40,bubbles:true})); });
      return { applied:'ArrowDown' };
    }
    if(kind==='type'){
      // LAST rung, and the one that identifies an ASYNC/REMOTE typeahead: a box that shows nothing
      // when clicked and only fetches suggestions once there are characters to search on. The query
      // is a deliberately meaningless two-letter stem — the point is whether a list appears at all,
      // not what it contains.
      var proto3 = el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
      var d3=Object.getOwnPropertyDescriptor(proto3,'value');
      window.__gTyped=true; window.__gPrev2=el.value;
      el.focus();
      if(d3&&d3.set) d3.set.call(el,'am');
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new KeyboardEvent('keyup',{key:'m',bubbles:true}));
      return { applied:'type "am" (async typeahead test)' };
    }
    if(kind==='cleanup'){
      // never leave our probe text sitting in a stranger's form
      if(window.__gTyped){
        var proto4 = el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
        var d4=Object.getOwnPropertyDescriptor(proto4,'value');
        if(d4&&d4.set) d4.set.call(el, window.__gPrev2==null?'':window.__gPrev2);
        el.dispatchEvent(new Event('input',{bubbles:true}));
        window.__gTyped=false;
      }
      return { applied:'cleanup' };
    }
  }catch(e){ return { applied:kind, error:String(e&&e.message).slice(0,60) }; }
  return { applied:kind };
`);

// stage C — measure what became visible since stage B
const G_MEASURE = new Function(G_HELPERS + `
  var el=window.__gEl;
  var r=__gbest(window.__gBefore||new Set(), el);
  var out={ opened: !!r, list: r };
  try{ out.ariaExpanded = el && el.getAttribute('aria-expanded'); }catch(e){}
  return out;
`);


const NEUTRALISE = function () {
  window.__cvfSubmits = 0;
  const bump = (e) => { e.preventDefault(); e.stopPropagation(); window.__cvfSubmits = (window.__cvfSubmits || 0) + 1; };
  // ⚠️ MARK submit-shaped controls BEFORE rewriting their type. Neutralising by setting
  // type="button" makes them indistinguishable afterwards — the first version of this probe then
  // happily clicked "Submit application" during the repeater phase. The click was blocked (that is
  // what the counter is for) but a probe must never RELY on the neutraliser as its only guard.
  // <button> with NO type attribute defaults to submit, which is how most real submit buttons ship.
  document.querySelectorAll('button[type=submit],input[type=submit],form button:not([type]),form [role=button]:not([type])').forEach((b) => b.setAttribute('data-cvf-submitish', '1'));
  document.querySelectorAll('form').forEach((f) => { f.addEventListener('submit', bump, true); f.onsubmit = (e) => { e.preventDefault(); return false; }; });
  document.querySelectorAll('button[type=submit],input[type=submit]').forEach((b) => { b.setAttribute('type', 'button'); b.addEventListener('click', bump, true); });
  document.addEventListener('submit', bump, true);
  window.__cvfNeutralised = true;
};

// Multilingual submit/next wording, mirroring the engine's own CB_SUBMIT. Second belt: a control
// may be submit-shaped without any attribute saying so.
const SUBMIT_WORDS = 'submit|apply|application|send|finish|finalise|finalize|next|continue|proceed|confirm|pay|delete|remove|absenden|bewerben|einreichen|weiter|envoyer|soumettre|postuler|suivant|enviar|postular|finalizar|siguiente|invia|candidati|avanti|verzenden|solliciteer|indienen|volgende|submeter|concluir|wyslij|aplikuj|dalej|skicka|ansok|nasta';

async function probeOne(browser, job) {
  const url = job.url || job;
  const out = { platform: job.platform || null, url };
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  let navs = 0;
  page.on('framenavigated', (fr) => { if (fr === page.mainFrame()) navs++; });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    for (const t of ['Accept all', 'Allow all', 'Accept cookies', 'Godkänn', 'Alle akzeptieren', 'Accept']) {
      const b = page.locator(`button:has-text("${t}")`).first();
      if (await b.count().catch(() => 0)) { await b.click({ timeout: 1500 }).catch(() => {}); break; }
    }
    await page.waitForTimeout(1200);
    out.reachedVia = 'direct';
    for (const t of ['Apply for this job', 'Apply now', 'Apply for this position', 'Ansök', 'Jetzt bewerben', 'Apply']) {
      const b = page.locator(`a:has-text("${t}"), button:has-text("${t}")`).first();
      if (await b.count().catch(() => 0)) { await b.click({ timeout: 3000 }).catch(() => {}); out.reachedVia = 'apply-button'; break; }
    }
    await page.waitForTimeout(6000);

    await page.evaluate(NEUTRALISE);                      // ⚠️ before ANY gesture

    out.truth = await page.evaluate(CLASSIFY);

    // ── GESTURE PROBES FIRST ────────────────────────────────────────────────
    // ⚠️ Order matters. READ_FIELDS_JS runs enumCombos, which OPENS every dropdown on the page to
    // read its options. Measuring gestures after that measured a page whose sheets were already
    // open — the first run "found" a phone-code list without clicking anything, because the scan
    // had left one up. Gestures are measured on the pristine form; the engine scan runs after.
    out.gestures = [];
    const nTargets = await page.evaluate(() => {
      const vis = (el) => { try { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; } catch (e) { return false; } };
      const t = [];
      // Anything that might be an opener, by SHAPE: aria combobox/haspopup, a readOnly text box, a
      // button-shaped input, and non-input custom widgets. No vendor selectors.
      document.querySelectorAll('[role=combobox],[aria-haspopup=listbox],[aria-autocomplete=list],[role=listbox],input[readonly],input[type=button],[role=switch],[role=radiogroup]').forEach((e) => {
        if (!vis(e) || t.length >= 5) return;
        if (e.getAttribute('data-cvf-submitish')) return;
        t.push(e);
      });
      window.__cvfProbeTargets = t;
      return t.length;
    });
    for (let i = 0; i < nTargets; i++) {
      const g = await page.evaluate(G_BEGIN, i).catch((e) => ({ idx: i, error: String(e && e.message).slice(0, 80) }));
      g.steps = [];
      if (!g.error) {
        // Escalate. Stop at the FIRST gesture that opens a list — that is the cheapest thing the
        // engine would have to do. Every gesture is applied, then WAITED on, then measured.
        const seq = (g.tag === 'input' || g.tag === 'textarea')
          ? ['setNative', 'undoSetNative', 'click', 'mouse', 'pointer', 'arrow', 'type']
          : ['click', 'mouse', 'pointer', 'arrow'];
        for (const kind of seq) {
          const ap = await page.evaluate(G_APPLY, kind).catch(() => ({ applied: kind, error: 'eval' }));
          if (kind === 'undoSetNative') continue;
          // an async typeahead has to make a network round trip before it can render anything
          await page.waitForTimeout(kind === 'type' ? 3000 : 900);
          const me = await page.evaluate(G_MEASURE).catch(() => ({ opened: false }));
          g.steps.push(Object.assign({ gesture: ap.applied || kind }, ap.valueReadsBack != null ? { valueReadsBack: ap.valueReadsBack } : {}, { opened: !!me.opened }, me.opened ? { list: me.list } : {}, me.ariaExpanded != null ? { ariaExpanded: me.ariaExpanded } : {}));
          if (me.opened) { g.opener = ap.applied || kind; g.list = me.list; break; }
        }
        await page.evaluate(G_APPLY, 'cleanup').catch(() => {});
      }
      out.gestures.push(g);
      // put the page back: dismiss whatever we opened, without pressing Enter anywhere
      await page.keyboard.press('Escape').catch(() => {});
      await page.evaluate(() => { try { document.activeElement && document.activeElement.blur(); document.body.click(); } catch (e) {} }).catch(() => {});
      await page.waitForTimeout(700);
    }

    // ── REPEATER PROBE: does activating the candidate ADD controls? ──────────
    // This is the only honest test of "is that a repeater", and it is why the tool clicks at all.
    // Wording is recorded but never trusted: vendors say "+ Add", "Add file", "Add another",
    // "Ajouter", "Weitere hinzufügen".
    out.repeaters = [];
    const nRep = await page.evaluate(() => (window.__cvfRepCands || []).length);
    for (let i = 0; i < Math.min(nRep, 4); i++) {
      const r = await page.evaluate(({ idx, words }) => {
        const el = (window.__cvfRepCands || [])[idx];
        if (!el) return { idx, error: 'gone' };
        const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
        const aria = (el.getAttribute('aria-label') || el.getAttribute('title') || '');
        // THREE independent refusals, because clicking the wrong button here submits somebody's
        // application: the pre-neutralisation mark, the live type attribute, and the wording.
        if (el.getAttribute('data-cvf-submitish')) return { idx, text, skipped: 'marked submit-shaped before neutralisation' };
        const at = String(el.getAttribute('type') || '').toLowerCase();
        if (at === 'submit' || at === 'image' || at === 'reset') return { idx, text, skipped: 'submit-shaped' };
        const re = new RegExp('\\b(' + words + ')\\b', 'i');
        if (re.test(text) || (aria && re.test(aria))) return { idx, text, skipped: 'submit/next wording' };
        if (el.closest('button[type=submit],input[type=submit],[data-cvf-submitish]')) return { idx, text, skipped: 'inside a submit control' };
        const before = document.querySelectorAll('input,textarea,select').length;
        try { el.click(); } catch (e) {}
        return { idx, text, aria: aria.slice(0, 40), before };
      }, { idx: i, words: SUBMIT_WORDS }).catch(() => ({ idx: i, error: 'eval' }));
      await page.waitForTimeout(1200);
      if (r.before != null) {
        const after = await page.evaluate(() => document.querySelectorAll('input,textarea,select').length).catch(() => -1);
        r.after = after;
        r.added = after >= 0 ? after - r.before : null;
      }
      out.repeaters.push(r);
    }

    // what the SHIPPED scan sees (async bridge → capture shim)
    out.engine = await page.evaluate(async (scanJs) => {
      return await new Promise((resolve) => {
        let got = null;
        window.ReactNativeWebView = { postMessage: (s) => { try { const o = JSON.parse(s); if (o && o.type === 'FIELDS') got = o.fields || []; } catch (e) {} } };
        try { eval(scanJs); } catch (e) { return resolve({ error: String(e && e.message).slice(0, 120) }); }
        const t0 = Date.now();
        (function poll() {
          if (got) { const by = {}; got.forEach((f) => { const k = f.widget === 'combobox' ? 'combobox' : (f.type || f.tag || '?'); by[k] = (by[k] || 0) + 1; }); return resolve({ count: got.length, byType: by, labels: got.map((f) => String(f.label || f.name || '').slice(0, 50)), truncated: got.filter((f) => f.optionsTruncated).length, unknownOpts: got.filter((f) => f.optionsUnknown).length }); }
          if (Date.now() - t0 > 40000) return resolve({ count: 0, timeout: true });
          setTimeout(poll, 400);
        })();
      });
    }, READ_FIELDS_JS).catch((e) => ({ error: String(e && e.message).slice(0, 120) }));

    // Did the engine's own scan leave a dropdown open? (enumCombos promises it closes them.)
    out.leftOpen = await page.evaluate(() => {
      const vis = (n) => { try { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; } catch (e) { return false; } };
      let n = 0;
      document.querySelectorAll('[role=listbox],[role=menu],[class*=Sheet],[class*=sheet],[class*=Drawer],[class*=Popover],[class*=popover]').forEach((e) => { if (vis(e)) n++; });
      return n;
    }).catch(() => -1);

    out.submits = await page.evaluate(() => window.__cvfSubmits || 0).catch(() => -1);
    out.navigations = navs;
    out.ok = true;
  } catch (e) {
    out.error = String(e && e.message).slice(0, 200);
  }
  await ctx.close().catch(() => {});
  return out;
}

(async () => {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: node tools/probe-widget-archetypes.js <urls.json|url> [--limit N] [--out f.jsonl]'); process.exit(2); }
  let jobs;
  if (/^https?:/.test(arg)) jobs = [{ url: arg }];
  else jobs = JSON.parse(fs.readFileSync(arg, 'utf8'));
  const li = process.argv.indexOf('--limit');
  if (li > 0) jobs = jobs.slice(0, parseInt(process.argv[li + 1], 10));
  const oi = process.argv.indexOf('--out');
  const outFile = oi > 0 ? process.argv[oi + 1] : null;

  const browser = await chromium.launch();
  const results = [];
  const CONC = 3;
  for (let i = 0; i < jobs.length; i += CONC) {
    const batch = jobs.slice(i, i + CONC);
    const got = await Promise.all(batch.map((j) => probeOne(browser, j).catch((e) => ({ url: j.url || j, error: String(e && e.message).slice(0, 120) }))));
    got.forEach((g) => {
      results.push(g);
      const c = (g.truth && g.truth.counts) || {};
      console.error(`[${results.length}/${jobs.length}] ${(g.platform || '?')} ${String(g.url).slice(8, 48)} submits=${g.submits} kinds=${Object.keys(c).length} engine=${g.engine && g.engine.count}${g.error ? ' ERR:' + g.error.slice(0, 60) : ''}`);
    });
    if (outFile) fs.writeFileSync(outFile, results.map((r) => JSON.stringify(r)).join('\n'));
  }
  await browser.close();
  const bad = results.filter((r) => r.submits > 0);
  if (bad.length) console.error('!!! SUBMITS DETECTED on ' + bad.length + ' pages — investigate before trusting this run');
  else console.error('OK: 0 submits across ' + results.length + ' pages');
  if (!outFile) console.log(JSON.stringify(results, null, 1));
})().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
