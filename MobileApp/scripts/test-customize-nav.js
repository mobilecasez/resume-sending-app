// AI Hub — new feature. Safe to delete without affecting existing app.
// Home → Customize → Back, and the Cover letter tab's own Customize — behavioural tests (the owner's report, 2026-09-19).
// Plain JS like every other suite here: `node` runs it as-is (it transpiles the .tsx it tests itself).
//   node MobileApp/scripts/test-customize-nav.js
//
// ⚠️ THE REPORT, ITEM 1: "Customize my resume from Home opens the right page, but Back takes me to the resume
// builder instead of Home." preview.tsx's Back was `docId && canGoBack ? back() : replace('/(resume-builder)')`,
// and Home opens the editor WITHOUT a docId whenever the chip on screen has no saved employer résumé — so Back
// replaced the editor with the builder index ("Tell us your story"). Every source-text assertion about that
// screen passed against it: they pin the CALL, not the stack it runs on. So PART 1 renders the REAL screen in a
// tiny fake React runtime, taps its Back pill, and reads what the router was asked to do on each stack a
// preview really sits on (Home, the gallery, the builder index, a cold open, a builder group reused under Home).
//
// ⚠️ ITEM 2: "On the Cover letter section it still shows Customize my resume — it should be Customize my Cover
// Letter, and open that cover letter's edit page." The mint button under the hero never read `mode`. PART 2 runs
// that block — lifted out of EmployerHome.tsx and transpiled, so it is the shipped code, not a copy — for each
// tab and state, reads its words and taps it. PART 3 runs the letter doors themselves (openLetterEditor,
// openLetterPicker, openPaper) in every state a letter can be in: none of them may be a silent no-op.
//
// ⚠️ MUTATION PROOF, no git state needed — run it against the pre-fix copies; it must FAIL:
//   PREVIEW_SRC=/path/pre/preview.tsx HOME_SRC=/path/pre/EmployerHome.tsx CARD_SRC=/path/pre/ResumeRebuildCard.tsx \
//     node MobileApp/scripts/test-customize-nav.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const APP = path.join(__dirname, '..');
const ts = require(path.join(APP, 'node_modules/typescript'));
// ⚠️ realpath: on macOS os.tmpdir() is a symlink, require.cache is keyed by the REAL path, and a fresh() that
// deleted the symlinked key would silently keep the first run's module (and its mocks).
const OUT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cva-customize-nav-')));

const PREVIEW_SRC = process.env.PREVIEW_SRC || path.join(APP, 'app/(resume-builder)/preview.tsx');
const HOME_SRC = process.env.HOME_SRC || path.join(APP, 'components/employer-home/EmployerHome.tsx');
const CARD_SRC = process.env.CARD_SRC || path.join(APP, 'components/ResumeRebuildCard.tsx');

const TS_OPTS = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, jsx: ts.JsxEmit.React };
function transpile(src, name) {
  const js = ts.transpileModule(fs.readFileSync(src, 'utf8'), { compilerOptions: TS_OPTS, fileName: name }).outputText;
  const p = path.join(OUT, name.replace(/\.tsx?$/, '.js'));
  fs.writeFileSync(p, js);
  return p;
}

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/* ── fake React: hooks by call order, plus a createElement that keeps a walkable tree ──
   (the same runtime as test-resume-gallery.js: only the screen's own hooks run; child components stay elements) */
let current = null;
const depsEq = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
const FakeReact = {
  createElement(type, props, ...children) {
    const kids = [];
    const push = (c) => { if (c == null || c === false || c === true) return; Array.isArray(c) ? c.forEach(push) : kids.push(c); };
    children.forEach(push);
    if (props && props.children !== undefined && !children.length) push(props.children);
    return { $el: true, type, props: props || {}, children: kids };
  },
  Fragment: 'Fragment',
  useState(init) {
    const inst = current; const i = inst.idx++;
    if (!inst.hooks[i]) {
      const slot = { v: typeof init === 'function' ? init() : init };
      slot.set = (nv) => { const next = typeof nv === 'function' ? nv(slot.v) : nv; if (!Object.is(next, slot.v)) { slot.v = next; inst.schedule(); } };
      inst.hooks[i] = slot;
    }
    return [inst.hooks[i].v, inst.hooks[i].set];
  },
  useRef(init) { const inst = current; const i = inst.idx++; if (!inst.hooks[i]) inst.hooks[i] = { ref: { current: init } }; return inst.hooks[i].ref; },
  useMemo(fn, deps) { const inst = current; const i = inst.idx++; const s = inst.hooks[i]; if (!s || !depsEq(s.deps, deps)) inst.hooks[i] = { v: fn(), deps }; return inst.hooks[i].v; },
  useCallback(fn, deps) { return FakeReact.useMemo(() => fn, deps); },
  useEffect(fn, deps) {
    const inst = current; const i = inst.idx++; const s = inst.hooks[i];
    if (!s) { inst.hooks[i] = { fn, deps, cleanup: null, effect: true }; inst.pending.push(i); }
    else if (!deps || !depsEq(s.deps, deps)) { s.fn = fn; s.deps = deps; inst.pending.push(i); }
  },
};
function mount(fn) {
  const inst = { hooks: [], idx: 0, pending: [], unmounted: false, result: null };
  let scheduled = false;
  inst.schedule = () => { if (scheduled || inst.unmounted) return; scheduled = true; queueMicrotask(() => { scheduled = false; if (!inst.unmounted) renderNow(); }); };
  function renderNow() {
    current = inst; inst.idx = 0; inst.pending = [];
    inst.result = fn();
    current = null;
    const pend = inst.pending; inst.pending = [];
    for (const i of pend) { const slot = inst.hooks[i]; if (slot.cleanup) slot.cleanup(); const c = slot.fn(); slot.cleanup = typeof c === 'function' ? c : null; }
  }
  renderNow();
  return { get tree() { return inst.result; }, unmount() { inst.unmounted = true; } };
}
function walk(node, fn) { if (!node || !node.$el) return; fn(node); for (const c of node.children) walk(c, fn); }
function findAll(root, pred) { const out = []; walk(root, (n) => { if (pred(n)) out.push(n); }); return out; }
function textsOf(node) {
  const out = [];
  const rec = (n) => { if (n == null) return; if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return; } if (n.$el) n.children.forEach(rec); };
  rec(node);
  return out;
}
const textOf = (n) => textsOf(n).join('');

/* ════════════════════ PART 1 — the résumé editor's Back, on every stack it really sits on ════════════════════ */

// What the screen is handed, per scenario.
let params, navState, canGoBack, groupCanGoBack, calls, rating, fetchedDoc;
const router = {
  back() { calls.push('back'); },
  replace(to) { calls.push('replace:' + (typeof to === 'string' ? to : JSON.stringify(to))); },
  push(to) { calls.push('push:' + (typeof to === 'string' ? to : JSON.stringify(to))); },
  canGoBack: () => canGoBack,
};
// The (resume-builder) Stack's navigation for this screen: its state, and its parent (the route the whole group
// is, in the root Stack) — popping THAT is leaving the builder entirely.
const navigation = {
  getState: () => navState,
  getParent: () => ({ canGoBack: () => groupCanGoBack, goBack: () => calls.push('group.goBack') }),
};
const RESUME = {
  personal_info: { full_name: 'Asha Rao', email: 'a@x.test', phone: '1', location: 'Pune', linkedin_url: '', portfolio_url: '' },
  summary: '<p>Builder of <strong>things</strong>.</p>',
  experience: [{ company: 'Acme', role: 'Engineer', location: 'Pune', start_date: '2020', end_date: 'Now', highlights: ['Shipped it'] }],
  education: [{ institution: 'IIT', degree: 'BTech', field_of_study: 'CS', end_date: '2019' }],
  projects: [], skills: { technical: ['TS'], soft: ['Calm'] },
};
const store = new Map();
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'react') return FakeReact;
  if (/\.(png|jpe?g)$/.test(request)) return 1;   // a bundled image is a number to React Native
  if (request === 'react-native') return {
    View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
    Image: 'Image', TextInput: 'TextInput', Modal: 'Modal', KeyboardAvoidingView: 'KeyboardAvoidingView',
    StatusBar: { currentHeight: 0 }, StyleSheet: { create: (o) => o },
    Alert: { alert: (t) => calls.push('alert:' + t) },
    Platform: { OS: 'ios', select: (o) => ('ios' in o ? o.ios : o.default) },
  };
  if (request === 'react-native-safe-area-context') return { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) };
  if (request === 'react-native-webview') return { WebView: 'WebView' };
  if (request === 'expo-linear-gradient') return { LinearGradient: 'LinearGradient' };
  if (request === '@expo/vector-icons') return { Ionicons: 'Ionicons' };
  if (request === 'expo-router') return {
    useRouter: () => router,
    useLocalSearchParams: () => params,
    useNavigation: () => navigation,
  };
  if (request === '@react-native-async-storage/async-storage') return {
    __esModule: true,
    default: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => { store.set(k, v); }, removeItem: async (k) => { store.delete(k); } },
  };
  if (request === 'expo-secure-store') return { getItemAsync: async () => JSON.stringify({ token: 'tok' }) };
  if (request === '../../config') return { API_BASE: 'https://api.test' };
  if (request === '../../components/RatingPromptModal') return { __esModule: true, default: 'RatingPromptModal', useRatingPrompt: () => rating };
  if (request === '../../services/builderEmployer') return { readBuilderEmployer: async () => null };
  if (request === '../../services/employerDocs') return { fetchDoc: async () => fetchedDoc, saveDocPayload: async () => ({ ok: true }) };
  // The shared rich-text pieces (extracted from the preview 2026-09-19 for the letter page): elements only — Back
  // never reaches them.
  if (request === '../../components/rich-text/RichText') return { RichTextModal: 'RichTextModal', ContentText: 'ContentText' };
  return origLoad.apply(this, arguments);
};
global.fetch = async (url) => {
  const u = String(url);
  const res = (body) => ({ ok: true, status: 200, json: async () => body });
  if (u.endsWith('/resume-builder')) return res({ resumeData: RESUME, regen: { used: 0, freeLimit: 1 }, isPaid: false });
  if (u.endsWith('/users/profile')) return res({});
  return res({});
};
const PREVIEW = transpile(PREVIEW_SRC, 'preview.tsx');

/**
 * Open the editor with these route params on this stack, wait for it to load, and tap its Back pill.
 * `ratingShows`: the rating prompt takes the first Back (then its close is what leaves).
 */
async function tapBack({ p = {}, routes = ['preview'], back = true, group = true, ratingShows = false } = {}) {
  delete require.cache[PREVIEW];
  params = p;
  navState = { index: routes.length - 1, routes: routes.map((name, i) => ({ key: name + '-' + i, name })) };
  canGoBack = back; groupCanGoBack = group; calls = [];
  store.clear();
  fetchedDoc = { docId: 42, kind: 'resume', employer: 'Acme', payload: RESUME };
  let closeRating = null;
  rating = { trigger: null, ask: async () => ratingShows, close: () => calls.push('rating.close') };
  const Screen = require(PREVIEW).default;
  const c = mount(() => Screen());
  await flush();
  const pill = findAll(c.tree, (n) => n.type === 'TouchableOpacity' && /^Back$/.test(textOf(n).trim()))[0];
  if (!pill) { c.unmount(); return { calls: ['NO BACK PILL: ' + textOf(c.tree).slice(0, 80)] }; }
  await pill.props.onPress();
  await flush();
  const modal = findAll(c.tree, (n) => n.type === 'RatingPromptModal')[0];
  if (modal) closeRating = modal.props.onClose;
  const out = { calls: [...calls], closeRating: async () => { calls = []; closeRating && closeRating(); await flush(); return [...calls]; } };
  c.unmount();
  return out;
}
const only = (got, want) => got.length === want.length && want.every((w, i) => got[i] === w);

(async () => {
  console.log('── 1. ⚠️ THE REPORT: Home → Customize (no saved résumé for the chip) → Back → HOME, not "Tell us your story" ──');
  {
    // Home pushes '/(resume-builder)/preview' from the root Stack: the group's own Stack holds ONLY the preview.
    const r = await tapBack({ p: { from: 'home' }, routes: ['preview'] });
    ok('Home base editor, Back → router.back() (pops the builder group, lands on Home)', only(r.calls, ['back']), r.calls);
    ok('⚠️ …and NEVER a replace with the builder index', !r.calls.some((x) => /replace:\/\(resume-builder\)/.test(x)), r.calls);
    // An older caller that pushes the bare path (no `from`) lands on the same stack and must come back the same way.
    const r2 = await tapBack({ p: {}, routes: ['preview'] });
    ok('…the same with no `from` at all: nothing under the preview in its Stack means it was PUSHED from outside', only(r2.calls, ['back']), r2.calls);
    // The old Dashboard card (ResumeRebuildCard) opens it exactly like this too.
  }

  console.log('── 2. every other way into the editor keeps going back where it came from ──');
  {
    const doc = await tapBack({ p: { docId: '42', from: 'home' }, routes: ['preview'] });
    ok('Home, a saved employer version (docId) → back() → Home (unchanged)', only(doc.calls, ['back']), doc.calls);
    // Home → View PDF → the gallery's Edit pushes the preview over the gallery.
    const gal = await tapBack({ p: {}, routes: ['templates', 'preview'] });
    ok('Home → View PDF → Edit → Back → the GALLERY (back())', only(gal.calls, ['back']), gal.calls);
    const galDoc = await tapBack({ p: { docId: '42' }, routes: ['templates', 'preview'] });
    ok('…and in doc mode too', only(galDoc.calls, ['back']), galDoc.calls);
    // The builder's OWN flow — AI generate, the sample seed, the View card, the manual form (which replaces
    // itself with the preview, leaving 'index' under it) — keeps the fresh-builder landing it was written for.
    const idx = await tapBack({ p: {}, routes: ['index', 'preview'] });
    ok('builder index → preview → Back → replace with the builder index (unchanged)', only(idx.calls, ['replace:/(resume-builder)']), idx.calls);
    const man = await tapBack({ p: {}, routes: ['index', 'manual', 'preview'] });
    ok('…and a preview on the manual form, the same', only(man.calls, ['replace:/(resume-builder)']), man.calls);
    const nested = await tapBack({ p: {}, routes: ['(resume-builder)/index', 'preview'] });
    ok('…a fuller route name ("(resume-builder)/index") reads as the index too', only(nested.calls, ['replace:/(resume-builder)']), nested.calls);
    const cold = await tapBack({ p: {}, routes: ['preview'], back: false });
    ok('a cold open with no history (deep link) → replace with the builder (unchanged)', only(cold.calls, ['replace:/(resume-builder)']), cold.calls);
    const coldDoc = await tapBack({ p: { docId: '42' }, routes: ['preview'], back: false });
    ok('…doc mode with no history, the same', only(coldDoc.calls, ['replace:/(resume-builder)']), coldDoc.calls);
  }

  console.log('── 3. ⚠️ a builder group REUSED under Home: its index is below, and back() would walk into it ──');
  {
    const r = await tapBack({ p: { from: 'home' }, routes: ['index', 'preview'] });
    ok('from: home + the index below → the WHOLE group is popped (its parent route goes back) → Home',
      only(r.calls, ['group.goBack']), r.calls);
    const rd = await tapBack({ p: { docId: '42', from: 'home' }, routes: ['index', 'preview'] });
    ok('…a saved version the same (never into the builder index)', only(rd.calls, ['group.goBack']), rd.calls);
    const nogroup = await tapBack({ p: { from: 'home' }, routes: ['index', 'preview'], group: false });
    ok('…and with no parent to go back to, it still never strands the user: the builder, as before',
      only(nogroup.calls, ['replace:/(resume-builder)']), nogroup.calls);
    const notHome = await tapBack({ p: { from: 'gallery' }, routes: ['index', 'preview'] });
    ok('only `from: home` does this — any other value is the builder flow', only(notHome.calls, ['replace:/(resume-builder)']), notHome.calls);
  }

  console.log('── 4. the rating prompt takes the first Back; its close is what leaves — to the same place ──');
  {
    const r = await tapBack({ p: { from: 'home' }, routes: ['preview'], ratingShows: true });
    ok('Back with the prompt showing navigates NOWHERE yet', r.calls.length === 0, r.calls);
    const after = await r.closeRating();
    ok('⚠️ closing the prompt → back() to Home (it used to replace with the builder too)', only(after, ['rating.close', 'back']), after);
    const ri = await tapBack({ p: {}, routes: ['index', 'preview'], ratingShows: true });
    const afterIdx = await ri.closeRating();
    ok('…and from the builder index it still lands on the builder', only(afterIdx, ['rating.close', 'replace:/(resume-builder)']), afterIdx);
  }

  /* ════════════════════ PART 2 — the mint button under the hero, per tab ════════════════════ */
  const homeSrc = fs.readFileSync(HOME_SRC, 'utf8');
  // Brace-matched from `from` — the '{' that opens a JSX container or a function body — to its partner.
  const braceSpan = (src, from) => {
    let depth = 0;
    for (let j = from; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(from, j + 1);
    }
    return '';
  };
  const toJs = (tsx) => ts.transpileModule(tsx, { compilerOptions: TS_OPTS, fileName: 'snippet.tsx' }).outputText.replace(/^"use strict";\s*/m, '');
  // `const name = (…) => {…}` (or `= useStableFn((…) => {…})`), whole, from the shipped file. '' when absent.
  const constFn = (src, name) => {
    const m = new RegExp('\\n\\s*const ' + name + ' = ').exec(src);
    if (!m) return '';
    const open = src.indexOf('=> {', m.index) + 3;
    const body = braceSpan(src, open);
    if (!body) return '';
    const end = open + body.length;
    const tail = src.slice(end).match(/^\s*\)?\s*;/);
    return src.slice(m.index, end) + (tail ? tail[0] : ';');
  };
  // Runs shipped code against a scope of stand-ins. `with` so the code reads its free names exactly as it does in
  // the component; a name the scope does not carry throws, loudly, rather than passing by accident.
  const runIn = (js, scope) => new Function('__scope', 'with (__scope) { ' + js + ' }')(scope);

  const mintAt = homeSrc.indexOf('{!!setup && (() => {');
  const mintSrc = mintAt >= 0 ? braceSpan(homeSrc, mintAt) : '';
  // The tag itself — a line of its own — not the comment above the block that names it.
  const stageEnd = homeSrc.search(/\n\s*<\/MeshStage>/);
  ok('the mint button block is where it was (inside the hero)', !!mintSrc && stageEnd > mintAt, { mintAt, stageEnd });
  const mintJs = toJs('const __mint = () => (' + mintSrc.slice(1, -1) + ');');

  const LETTER = { docId: 7, kind: 'cover_letter', employer: 'Acme', stale: false };
  const RESUME_DOC = { docId: 9, kind: 'resume', employer: 'Beta', stale: false };
  const DONE = { profile: true, photo: true, signature: true, resume: true, complete: true };
  async function mint(o) {
    const log = [];
    const scope = {
      React: FakeReact, s: new Proxy({}, { get: () => ({}) }), MAKE_MINT: ['#0f0', '#0ff'], MAKE_INK: '#04211C',
      TouchableOpacity: 'TouchableOpacity', LinearGradient: 'LinearGradient', Ionicons: 'Ionicons', Text: 'Text',
      Haptics: { selectionAsync() {} }, track: (n, p) => log.push('track:' + n + ':' + (p && p.mode)),
      setup: o.setup || DONE, mode: o.mode, doc: o.doc || null, docPending: !!o.docPending, selBuilding: !!o.selBuilding,
      target: { company: o.company || 'Acme', role: '' },
      cachedCurrentDoc: () => o.cachedResume || null, docLookupOf: (t) => t,
      rememberBuilderEmployer: async () => {},
      nav: () => ({ push: (to) => log.push('push:' + (typeof to === 'string' ? to : JSON.stringify(to))) }),
      openLetterEditor: (...a) => log.push('openLetterEditor' + (a.length ? ':' + JSON.stringify(a) : '')),
    };
    const el = runIn(mintJs + '; return __mint();', scope);
    const btn = el ? findAll(el, (n) => n.type === 'TouchableOpacity')[0] : null;
    const texts = el ? textsOf(el) : [];
    const res = { rendered: !!btn, label: texts[0] || null, sub: texts[1] || null, log };
    if (btn) { btn.props.onPress(); await flush(); }
    return res;
  }

  console.log('── 5. ⚠️ THE REPORT: the Cover letter tab says "Customize my Cover Letter" and opens THAT letter ──');
  {
    const m = await mint({ mode: 'letter', doc: LETTER });
    ok('letter tab + a saved letter → "Customize my Cover Letter"', m.label === 'Customize my Cover Letter', m.label);
    ok('⚠️ …never "Customize your resume" under a cover letter', !/resume/i.test(String(m.label)), m.label);
    ok('…its line names the employer\'s letter', /Acme letter/.test(String(m.sub)), m.sub);
    ok('⚠️ the tap opens the LETTER editor (openLetterEditor — /(cover-letter)/edit on its docId)',
      m.log.includes('openLetterEditor'), m.log);
    ok('⚠️ …and never pushes the résumé editor (or anything else) from the letter tab',
      !m.log.some((x) => /^push:/.test(x)), m.log);
    const p = await mint({ mode: 'letter', docPending: true });
    ok('a letter on its way: the button is there, saying so', p.rendered && /Loading your saved letter/.test(String(p.sub)), p);
    ok('…and its tap goes through the same door (which says "Loading your saved version…")', p.log.includes('openLetterEditor'), p.log);
    const none = await mint({ mode: 'letter' });
    ok('⚠️ no letter and none on its way → NO Customize (the letter panel\'s Write is the door)', !none.rendered, none);
    const building = await mint({ mode: 'letter', selBuilding: true });
    ok('a letter being written → no Customize', !building.rendered, building);
    const refreshing = await mint({ mode: 'letter', doc: LETTER, selBuilding: true });
    ok('…nor while a Refresh rewrites the one on screen', !refreshing.rendered, refreshing);
    const wizard = await mint({ mode: 'letter', setup: { profile: true, photo: false, signature: false, resume: false, complete: false } });
    ok('an unfinished profile on the letter tab is still the wizard (the profile is one profile)',
      wizard.label === 'Pick up where you left off' && wizard.log.includes('push:/(onboarding)'), wizard);
  }

  console.log('── 6. the Résumé tab keeps its button — and its editor now comes back to Home ──');
  {
    const base = await mint({ mode: 'resume' });
    ok('resume tab → "Customize your resume"', base.label === 'Customize your resume', base.label);
    ok('⚠️ no saved version → the editor with from: home (Back returns here)',
      base.log.includes('push:' + JSON.stringify({ pathname: '/(resume-builder)/preview', params: { from: 'home' } })), base.log);
    const d = await mint({ mode: 'resume', doc: RESUME_DOC });
    ok('a saved version → that version by docId, from: home',
      d.log.includes('push:' + JSON.stringify({ pathname: '/(resume-builder)/preview', params: { docId: '9', from: 'home' } })), d.log);
    ok('…and the resume tab never opens a letter', !base.log.includes('openLetterEditor') && !d.log.includes('openLetterEditor'));
    const wiz = await mint({ mode: 'resume', setup: { profile: false, photo: false, signature: false, resume: false, complete: false } });
    ok('an untouched profile → "Make your Resume" → the wizard (unchanged)', wiz.label === 'Make your Resume' && wiz.log.includes('push:/(onboarding)'), wiz);
  }

  /* ════════════════════ PART 3 — the letter doors: none may be a silent no-op ════════════════════ */
  console.log('── 7. ⚠️ openLetterEditor / openLetterPicker / openPaper, in every state a letter can be in ──');
  {
    const line = (re) => (homeSrc.match(re) || [''])[0];
    const pieces = [
      line(/const sayLoadingDoc = [^\n]*;/), line(/const docOnItsWay = [^\n]*;/),
      constFn(homeSrc, 'sayNoLetterYet'), constFn(homeSrc, 'openLetterPicker'), constFn(homeSrc, 'openLetterEditor'),
      constFn(homeSrc, 'openPaper'),
    ];
    ok('the doors are all where they were', !!pieces[0] && !!pieces[1] && !!pieces[3] && !!pieces[4] && !!pieces[5]);
    const doorsJs = toJs(pieces.filter(Boolean).join('\n')) + '; return { openLetterEditor, openLetterPicker, openPaper };';
    function doors(o) {
      const log = [];
      const scope = {
        docRef: { current: o.doc || null }, docPendingRef: { current: !!o.docPending },
        selBuildingRef: { current: !!o.selBuilding }, selBuilding: !!o.selBuilding,
        kindRef: { current: o.kind || 'cover_letter' }, selRkRef: { current: 'acme' },
        showNotice: (t) => log.push('notice:' + t), track: () => {}, loaders: null,
        Alert: { alert: (t) => log.push('alert:' + t) },
        nav: () => ({ push: (to) => log.push('push:' + JSON.stringify(to)) }),
        useStableFn: (f) => f, buildFor: () => null, KRef: { current: { openOverlayFor: () => log.push('overlay') } },
        setCardIdx: () => {}, zoomSeq: { current: 0 }, libOpen: { current: 0 }, setZoom: () => log.push('zoom'),
        fetchDoc: async () => null, AsyncStorage: { setItem: async () => {} }, reloadDoc: () => {}, setListToken: () => {},
      };
      return { d: runIn(doorsJs, scope), log };
    }
    const silent = (log) => log.length === 0;

    const writing = doors({ selBuilding: true });
    writing.d.openLetterEditor();
    ok('⚠️ Customize while the letter is being written SAYS so (it used to do nothing)',
      writing.log.some((x) => /^notice:.*still being written/.test(x)), writing.log);
    ok('…and opens nothing', !writing.log.some((x) => /^push:|^zoom/.test(x)), writing.log);
    const writingPdf = doors({ selBuilding: true });
    await writingPdf.d.openLetterPicker('clean');
    ok('⚠️ View PDF while it is being written, the same', writingPdf.log.some((x) => /still being written/.test(x)), writingPdf.log);
    const nothing = doors({});
    nothing.d.openLetterEditor();
    ok('⚠️ no letter at all → still a word, never silence', !silent(nothing.log) && !nothing.log.some((x) => /^push:/.test(x)), nothing.log);
    const onWay = doors({ docPending: true });
    onWay.d.openLetterEditor();
    ok('a letter on its way → "Loading your saved version…" (unchanged)', onWay.log.some((x) => /Loading your saved version/.test(x)), onWay.log);
    const saved = doors({ doc: LETTER });
    saved.d.openLetterEditor();
    ok('⚠️ a saved letter → /(cover-letter)/edit on THAT letter\'s docId',
      only(saved.log, ['push:' + JSON.stringify({ pathname: '/(cover-letter)/edit', params: { docId: '7' } })]), saved.log);

    // The hero page itself: a letter page with no letter behind it is a drawing (LETTER_SLOTS).
    const page = doors({ selBuilding: true });
    page.d.openPaper(0, { x: 0, y: 0, w: 10, h: 10 });
    ok('⚠️ tapping a letter page with no letter behind it opens NO zoom (whose Customize would do nothing)',
      !page.log.includes('zoom'), page.log);
    ok('…it says the letter is still being written', page.log.some((x) => /still being written/.test(x)), page.log);
    const pagePending = doors({ docPending: true });
    pagePending.d.openPaper(0, { x: 0, y: 0, w: 10, h: 10 });
    ok('…on its way: "Loading your saved version…", no zoom (unchanged)',
      !pagePending.log.includes('zoom') && pagePending.log.some((x) => /Loading your saved version/.test(x)), pagePending.log);
    const pageSaved = doors({ doc: LETTER });
    pageSaved.d.openPaper(0, { x: 0, y: 0, w: 10, h: 10 });
    ok('a saved letter\'s page opens its zoom', pageSaved.log.includes('zoom'), pageSaved.log);
    const pageResume = doors({ kind: 'resume' });
    pageResume.d.openPaper(0, { x: 0, y: 0, w: 10, h: 10 });
    ok('a résumé page with no saved version still opens (the base résumé is a real page)', pageResume.log.includes('zoom'), pageResume.log);
  }

  console.log('── 8. the zoom and the old Dashboard card ──');
  {
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const homeC = strip(homeSrc);
    ok('the hero zoom\'s Customize still routes a letter to openLetterEditor',
      /if \(kind === 'cover_letter'\) \{ openLetterEditor\(\); return; \}/.test(homeC));
    ok('a letter page is never offered "Build my resume" (sample only on the résumé side)',
      /sample=\{libZoom \? libZoom\.sample : sample && !doc && kind === 'resume'\}/.test(homeC));
    const card = strip(fs.readFileSync(CARD_SRC, 'utf8'));
    ok('the old Dashboard card opens the editor with from: home (so Back returns to it)',
      /router\?\.push\?\.\(\{ pathname: '\/\(resume-builder\)\/preview', params: \{ from: 'home' \} \}\)/.test(card));
    ok('…and no bare push of the editor is left anywhere on Home',
      !/push\?\.\('\/\(resume-builder\)\/preview'\)/.test(homeC) && !/push\?\.\('\/\(resume-builder\)\/preview'\)/.test(card));
  }

  console.log(`\ncustomize nav: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASHED', e && e.stack || e); process.exit(2); });
