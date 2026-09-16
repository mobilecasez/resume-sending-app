// The resume design gallery (app/(resume-builder)/templates.tsx) — behavioural tests.
// Transpiles the REAL screen and renders it in a tiny fake React runtime with a fake host renderer:
// a ScrollView whose ref attaches ONLY while the screen actually renders one, and whose scrollTo
// clamps to the content it has been laid out with — the two facts the bug below turned on.
//   node MobileApp/scripts/test-resume-gallery.js
//
// ⚠️ WHY A RENDERER AND NOT A REGEX. The defect this file exists for is a TIMING defect. Home opens
// the gallery on Bold Banner (family 10 of 15, server/utils/resumeTemplates.js); the one-shot landing
// scroll ran in the very commit that flipped `loading` to false, and pagerH is 0 in that commit
// because the view it measures is rendered only in the non-loading branch. The pager ScrollView is
// gated on `pagerH > 0`, so scrollRef.current was null, the rAF scrollTo went nowhere, `landOn` had
// already been cleared, and the deps never re-fired when pagerH arrived. The pager stayed on page 0:
// "Rendering Azure Sidebar…" forever, while the indicator said "Bold Banner · 10/15 layouts".
// ⚠️ EVERY source-text assertion in test-employer-home.js (lines 363-369) passed against that — they
// pin the CALL, not the guard. So this suite models the only thing that decides it: when the ref
// exists, and what the pager has been laid out with when a scrollTo reaches it.
//
// ⚠️ RUN IT AGAINST ANOTHER COPY of the screen to prove it still catches the bug — that is the
// mutation proof, and it needs no git state:
//   GALLERY_SRC=/tmp/pre-fix/templates.tsx node MobileApp/scripts/test-resume-gallery.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const APP = path.join(__dirname, '..');
const ts = require(path.join(APP, 'node_modules/typescript'));
// ⚠️ realpath: on macOS os.tmpdir() is a symlink, require.cache is keyed by the REAL path, and a
// fresh() that deleted the symlinked key would silently keep the first run's module (and its mocks).
const OUT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cva-resume-gallery-')));

// The catalogue the screen really renders — 15 families, Azure Sidebar first, Bold Banner tenth.
// Read from the server so a reshuffle of the catalogue shows up here as a failure, not a silent pass.
const CAT = require(path.join(APP, '../server/utils/resumeTemplates.js'));
const FAMILIES = CAT.FAMILIES;
const REGIONS = CAT.REGIONS;
const BANNER = FAMILIES.findIndex((f) => f.id === 'banner');   // 9 — the family the report named

function transpile(src, name) {
  const js = ts.transpileModule(fs.readFileSync(src, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      esModuleInterop: true, jsx: ts.JsxEmit.React,
    },
    fileName: name,
  }).outputText;
  const p = path.join(OUT, name.replace(/\.tsx?$/, '.js'));
  fs.writeFileSync(p, js);
  return p;
}
const GALLERY_SRC = process.env.GALLERY_SRC || path.join(APP, 'app/(resume-builder)/templates.tsx');
const SCREEN = transpile(GALLERY_SRC, 'templates.tsx');

/* ── fake clock (the 45s abort and the 20s slow timer must be drivable, and must not hold node open) ── */
let now = 1_700_000_000_000;
let tid = 0;
const timers = new Map();
const rafs = [];
global.setTimeout = (fn, ms) => { const id = ++tid; timers.set(id, { at: now + (Number(ms) || 0), fn }); return id; };
global.clearTimeout = (id) => { timers.delete(id); };
global.requestAnimationFrame = (fn) => { rafs.push(fn); return rafs.length; };
Date.now = () => now;
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setImmediate(r));
    while (rafs.length) for (const fn of rafs.splice(0)) fn(now);
  }
};
async function advance(ms) {
  const end = now + ms;
  for (let g = 0; g < 10000; g++) {
    await flush();
    let next = null;
    for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at || (t.at === next[1].at && id < next[0]))) next = [id, t];
    if (!next) break;
    timers.delete(next[0]);
    if (next[1].at > now) now = next[1].at;
    try { next[1].fn(); } catch (e) { console.log('timer threw', e); }
  }
  now = end;
  await flush();
}

/* ── fake React: hooks by call order, plus a createElement that keeps a walkable tree ── */
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

/* ── the fake host: a pager that exists only while it is rendered, and only scrolls where it can ──
   ⚠️ BOTH halves are the bug. `ref.current` is null for any ScrollView the screen did not render this
   commit (that is the `pagerH > 0` gate), and scrollTo CLAMPS to the content the pager has actually
   been laid out with — a scrollTo that arrives before the pages have a width lands on 0 and stays
   there, silently, exactly as iOS does. */
function makeHost(win) {
  return {
    x: 0, contentW: 0, scrolls: [],
    scrollTo(o) {
      const want = Number(o && o.x) || 0;
      this.scrolls.push(want);
      this.x = Math.max(0, Math.min(want, Math.max(0, this.contentW - win)));
    },
  };
}

function mount(fn, host) {
  const inst = { hooks: [], idx: 0, pending: [], unmounted: false, result: null, renders: 0 };
  const attached = new Map();                       // ref object → the host node it owns
  let scheduled = false;
  inst.schedule = () => { if (scheduled || inst.unmounted) return; scheduled = true; queueMicrotask(() => { scheduled = false; if (!inst.unmounted) renderNow(); }); };
  function syncRefs(tree) {
    const seen = new Set();
    walk(tree, (n) => {
      const r = n.props && n.props.ref;
      if (r && typeof r === 'object' && 'current' in r) { seen.add(r); if (!attached.has(r)) attached.set(r, host); r.current = attached.get(r); }
    });
    for (const r of attached.keys()) if (!seen.has(r)) r.current = null;   // unmounted → detached
  }
  function renderNow() {
    current = inst; inst.idx = 0; inst.pending = [];
    inst.result = fn();
    current = null; inst.renders++;
    syncRefs(inst.result);                          // React attaches refs at commit, BEFORE effects
    const pend = inst.pending; inst.pending = [];
    for (const i of pend) { const slot = inst.hooks[i]; if (slot.cleanup) slot.cleanup(); const c = slot.fn(); slot.cleanup = typeof c === 'function' ? c : null; }
  }
  renderNow();
  return {
    get tree() { return inst.result; },
    unmount() { inst.unmounted = true; for (const h of inst.hooks) if (h && h.effect && h.cleanup) h.cleanup(); },
    inst,
  };
}

/* ── tree helpers ── */
function walk(node, fn) {
  if (!node || !node.$el) return;
  fn(node);
  for (const c of node.children) walk(c, fn);
}
function findOne(root, pred) { let hit = null; walk(root, (n) => { if (!hit && pred(n)) hit = n; }); return hit; }
function textsOf(node) {
  const out = [];
  const rec = (n) => {
    if (n == null) return;
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return; }
    if (n.$el) n.children.forEach(rec);
  };
  rec(node);
  return out;
}
const textOf = (n) => textsOf(n).join('');

/* ── mocks ── */
const WIN = 390;
let server, params, doc, saves, alerts;
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function makeServer() {
  const s = {
    asked: [],                       // every id the screen ever requested a preview for, in order
    batches: [],                     // the id batches, as they left the client
    docIds: [],                      // the docId each batch carried (null = the base résumé)
    hold: new Set(),                 // ids the renderer never answers for (a queued chromium render)
    miss: new Set(),                 // ids answered with nothing (a partial response → failed)
    families: FAMILIES,
  };
  s.preview = (ids, signal) => {
    s.batches.push([...ids]);
    s.asked.push(...ids);
    // A held id is a render queued behind something on the serial chromium: nothing comes back, and
    // the only thing that ends the request is the client's own 45s abort — so honour the signal.
    if (ids.some((id) => s.hold.has(id))) return new Promise((_, reject) => {
      if (signal) signal.addEventListener('abort', () => { const e = new Error('Aborted'); e.name = 'AbortError'; reject(e); });
    });
    const previews = ids.filter((id) => !s.miss.has(id)).map((id) => ({ id, name: id, accent: '#111', image: 'data:image/jpeg;base64,' + id, width: 794, height: 1123 }));
    return jsonRes(200, { previews });
  };
  return s;
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'react') return FakeReact;
  if (request === 'react-native') return {
    View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator', Modal: 'Modal', Pressable: 'Pressable',
    StyleSheet: { create: (o) => o },
    Alert: { alert: (title, msg) => alerts.push({ title, msg }) },
    Dimensions: { get: () => ({ width: WIN, height: 844 }) },
    Platform: { OS: 'ios', select: (o) => ('ios' in o ? o.ios : o.default) },
    useWindowDimensions: () => ({ width: WIN, height: 844, fontScale: 1 }),
  };
  if (request === 'react-native-safe-area-context') return { SafeAreaView: 'SafeAreaView' };
  if (request === 'expo-image') return { Image: 'Image' };
  if (request === 'expo-linear-gradient') return { LinearGradient: 'LinearGradient' };
  if (request === '@expo/vector-icons') return { Ionicons: 'Ionicons' };
  if (request === 'expo-router') return {
    useRouter: () => ({ back() {}, push() {}, replace() {}, canGoBack: () => true }),
    useLocalSearchParams: () => params,
    useNavigation: () => ({ getState: () => ({ index: 0, routes: [{ name: 'templates' }] }) }),
    // The real thing runs its callback on focus — including the first one — and again whenever the
    // callback's identity changes. The screen wraps it in a useCallback([]), so that is once.
    useFocusEffect: (cb) => FakeReact.useEffect(() => { cb(); }, [cb]),
  };
  if (request === 'expo-secure-store') return { getItemAsync: async () => JSON.stringify({ token: 'tok' }) };
  if (request === 'expo-file-system/legacy') return { downloadAsync: async () => ({ status: 200, uri: 'file://r.pdf' }), cacheDirectory: 'file:///c/' };
  if (request === 'expo-sharing') return { isAvailableAsync: async () => false, shareAsync: async () => {} };
  if (request === '../../config') return { API_BASE: 'https://api.test' };
  if (request === '../../components/downloads/DownloadPaywallSheet') return { __esModule: true, default: 'DownloadPaywallSheet' };
  if (request === '../../services/downloadPassService') return {
    fetchDownloadState: async () => ({ metered: false, paid: true, unlimited: true, remaining: null, passes: 0, ownsEmployer: false, employer: null }),
    downloadButtonLabel: () => ({ locked: false, label: 'Download' }),
  };
  if (request === '../../services/subscriptionService') return { fetchSubscriptionStatus: async () => ({ subscription: { plan: 'pro' } }) };
  if (request === '../../services/employerDocs') return { fetchDoc: async () => doc };
  return origLoad.apply(this, arguments);
};

global.fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith('/resume-builder/templates')) return jsonRes(200, { families: server.families, regions: REGIONS });
  if (u.endsWith('/resume-builder/preview-templates')) {
    const body = JSON.parse(init.body);
    server.docIds.push(body.docId ?? null);
    return server.preview(body.ids, init.signal);
  }
  if (u.endsWith('/resume-builder/save')) { saves.push(JSON.parse(init.body)); return jsonRes(200, {}); }
  return jsonRes(200, {});
};

/* ── scenario plumbing ── */
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

/**
 * Open the gallery the way Home opens it, and hand back a driver for the host events the screen
 * depends on. ⚠️ Nothing here is automatic: `layout()` and `content()` are separate calls precisely
 * because their ORDER is what broke, and both orders must land on the same design.
 */
async function openGallery(o = {}) {
  delete require.cache[SCREEN];
  for (const id of timers.keys()) timers.delete(id);
  rafs.length = 0;
  server = makeServer(); saves = []; alerts = [];
  params = o.params || {};
  doc = o.doc === undefined ? null : o.doc;
  if (o.server) o.server(server);
  const host = makeHost(WIN);
  const Screen = require(SCREEN).default;
  const c = mount(() => Screen(), host);
  await flush();

  const pager = () => findOne(c.tree, (n) => n.type === 'ScrollView' && n.props.pagingEnabled === true);
  const wrap = () => findOne(c.tree, (n) => n.props && typeof n.props.onLayout === 'function');
  const h = {
    c, host, pager, wrap,
    /** The pager's pages, in the order they are rendered (empty while the pager is unmounted). */
    pages: () => { const p = pager(); return p ? p.children : []; },
    /** The height measurement that mounts the pager — nothing exists before it. */
    async layout(px = 700) { const w = wrap(); if (w) w.props.onLayout({ nativeEvent: { layout: { height: px, width: WIN } } }); await flush(); },
    /** The pages get their width. Until this lands, a scrollTo has nowhere to go and clamps to 0. */
    async content(w) {
      const p = pager();
      const width = w == null ? h.pages().length * WIN : w;
      host.contentW = width;
      if (p && typeof p.props.onContentSizeChange === 'function') p.props.onContentSizeChange(width, 700);
      await flush();
    },
    /** A finger drag. `momentum:false` is a release exactly on a page boundary — iOS fires
     *  onScrollEndDrag and NO onMomentumScrollEnd, which is how `active` used to stop tracking. */
    async drag(toIdx, { momentum = true } = {}) {
      const p = pager();
      host.x = toIdx * WIN;
      const e = { nativeEvent: { contentOffset: { x: host.x }, layoutMeasurement: { width: WIN }, contentSize: { width: host.contentW } } };
      if (typeof p.props.onScroll === 'function') p.props.onScroll(e);
      if (typeof p.props.onScrollEndDrag === 'function') p.props.onScrollEndDrag(e);
      if (momentum && typeof p.props.onMomentumScrollEnd === 'function') p.props.onMomentumScrollEnd(e);
      await flush();
    },
    /** What the indicator under the pager claims: the design name and its place in the pager. */
    indicator() {
      const all = textsOf(c.tree);
      const i = all.findIndex((t) => /^\d+\/\d+ layouts$/.test(t));
      if (i < 0) return null;
      const [, pos, total] = all[i].match(/^(\d+)\/(\d+) layouts$/);
      return { name: all[i - 1], pos: Number(pos), total: Number(total) };
    },
    /** The page the pager is really showing, from the offset alone — never from what the screen thinks. */
    visibleIdx: () => Math.round(host.x / WIN),
    /** What that page is drawing: a design, a retry, the slow line, a spinner, or a dead end. */
    cardAt(i) {
      const page = h.pages()[i];
      if (!page) return 'none';
      const t = textOf(page);
      if (findOne(page, (n) => n.type === 'Image' && n.props.source && n.props.source.uri)) return 'image';
      if (/Still rendering/.test(t)) return 'slow';          // pending past 20s — a state, not a failure
      if (/tap to retry/i.test(t)) return 'failed';
      if (/Tap to load/.test(t)) return 'tap-to-load';
      if (/^Rendering /.test(t.trim())) return 'spinner';
      return 'other:' + t.slice(0, 40);
    },
    /** The design id the page at `i` is bound to — the id that must have been asked for. */
    idAt(i) {
      const page = h.pages()[i];
      if (!page) return null;
      const img = findOne(page, (n) => n.type === 'Image' && n.props.source && n.props.source.uri);
      if (img) return String(img.props.source.uri).replace('data:image/jpeg;base64,', '');
      return null;
    },
    /** Tap the region chip with this label. */
    async region(label) {
      const chip = findOne(c.tree, (n) => n.type === 'TouchableOpacity' && textOf(n).includes(label));
      chip.props.onPress();
      await flush();
    },
    /** Tap a colour swatch on the page on screen (by its 1-based place in the swatch row).
     *  ⚠️ The family DOTS are a row of blank TouchableOpacitys too, and they come first — the
     *  swatches are the last such row under the indicator. */
    async swatch(nth) {
      const rows = [];
      walk(c.tree, (n) => {
        if (n.children.length > 1 && n.children.every((k) => k && k.$el && k.type === 'TouchableOpacity' && !textOf(k))) rows.push(n);
      });
      rows[rows.length - 1].children[nth - 1].props.onPress();
      await flush();
    },
  };
  return h;
}

/** Every family id in catalogue order — page i of the base gallery is famId(i). */
const famId = (i) => FAMILIES[i].id;

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

(async () => {
  // ⚠️ THE BEHAVIOURAL TESTS BELOW ARE DELIBERATELY BELT AND BRACES: the landing survives a missing
  // pagerH guard because onContentSizeChange re-applies it, and survives a missing re-apply because
  // the guard makes the effect fire late enough. That is the point — but it also means neither half
  // can be pinned by behaviour alone. These few source assertions pin each half on its own, so a
  // later edit cannot quietly remove one and still be green with only the other standing.
  console.log('── 0. both halves of the landing, and the safety net, are pinned individually ──');
  const gal = stripComments(fs.readFileSync(GALLERY_SRC, 'utf8'));
  ok('⚠️ the landing effect is gated on the pager EXISTING (pagerH > 0), not just on loading',
    /if \(loading \|\| landOn\.current == null \|\| !visibleFams\.length \|\| pagerH <= 0\) return;/.test(gal));
  ok('⚠️ …and pagerH is in its DEPS, or the guard just makes it never fire at all',
    /\}, \[loading, visibleFams\.length, pagerH\]\);/.test(gal));
  ok('⚠️ …and the restore is kept until the content can hold it, then re-applied from the content',
    /onContentSizeChange=\{onPagerContent\}/.test(gal)
    && /if \(w < \(i \+ 1\) \* WIN\) return;/.test(gal)
    && /landOn\.current = null;\s*scrollRef\.current\?\.scrollTo\(\{ x: i \* WIN, animated: false \}\);/.test(gal));
  ok('⚠️ the VIEW is still gated on pagerH > 0 — the pages are sized `height: pagerH`, so an ungated '
    + 'pager draws zero-height cards. Gate the EFFECT, never the view.',
    /\{pagerH > 0 && \(/.test(gal) && /style=\{\[s\.page, \{ height: pagerH \}\]\}/.test(gal));
  ok('the safety net re-asks for the page on screen on every way `active` can change',
    /useEffect\(\(\) => \{\s*if \(loading \|\| docGone \|\| noResume \|\| !visibleFams\.length\) return;\s*prefetchAround\(active, visibleFams, chosen\);\s*\}, \[active, visibleFams, chosen, loading, docGone, noResume\]\);/.test(gal));
  ok('a drag released on a page boundary is heard (iOS fires no momentum end for it)',
    /onScrollEndDrag=\{onScrollEnd\}/.test(gal));
  ok('…and the scroll-end handler no longer skips the request when the index looks unchanged',
    !/if \(idx !== active\) \{ setActive\(idx\); prefetchAround/.test(gal));
  ok('⚠️ the bare spinner is reachable ONLY for an id with a request actually in flight',
    /\) : inFlight\.current\.has\(tid\) \? \(/.test(gal) && /Tap to load this design/.test(gal));
  // ⚠️ MONEY: previews are free, but a download is not, and doc mode must never repaint the base
  // résumé's design. Nothing in this slice may have loosened either.
  ok('⚠️ doc mode still never records a preferred template', /if \(!selForSave \|\| docId\) return;/.test(gal));
  ok('⚠️ and nothing added here starts a download or a build', !/generate-pdf[\s\S]{0,40}useEffect/.test(gal));

  console.log('── 1. ⚠️ THE REPORT: Home opens the gallery on Bold Banner and the layout pass is LATE ──');
  // Home → tap a design that is not the first family → openResumeGallery pushes
  // /(resume-builder)/templates?template=banner. loadCatalogue finds it at family 10 of 15, arms
  // landOn, and setLoading(false) commits — in a commit where pagerH is still 0, so there is no
  // ScrollView and no ref. Everything below is that commit and what has to happen after it.
  {
    const h = await openGallery({ params: { template: 'banner', employer: 'Nordex' } });
    ok('the catalogue really puts Bold Banner tenth, and Azure Sidebar first', BANNER === 9 && famId(0) === 'azure', { BANNER, first: famId(0) });
    ok('⚠️ the pager does not exist yet: it is gated on a height nobody has measured', h.pages().length === 0 && h.host.scrolls.length === 0);
    ok('…and the design that was asked for is the one that was tapped, not page 0',
      server.asked.includes('banner') && !server.asked.includes('azure'), server.asked);

    await h.layout(700);
    ok('the height lands → the pager mounts with all 15 families', h.pages().length === 15);
    // ⚠️ A scrollTo in THIS commit still cannot land: the pages have no width yet, so iOS clamps it
    // to 0. The restore has to survive that and be re-applied when the content is finally laid out.
    await h.content();
    ok('⚠️ THE LANDING: the pager is on Bold Banner, not on page 0', h.visibleIdx() === BANNER, { offset: h.host.x, want: BANNER * WIN, scrolls: h.host.scrolls });
    ok('…the indicator agrees with the pager (it is the SAME design, not two truths)',
      h.indicator().pos === BANNER + 1 && h.indicator().total === 15 && /Banner/i.test(h.indicator().name), h.indicator());
    ok('…and the page on screen is showing the design, never "Rendering Azure Sidebar…" forever',
      h.cardAt(h.visibleIdx()) === 'image' && h.idAt(h.visibleIdx()) === 'banner', { card: h.cardAt(h.visibleIdx()), id: h.idAt(h.visibleIdx()) });
    ok('the whole trip asked for at most the visible design and its two neighbours', server.asked.length <= 3, server.asked);
    h.c.unmount();
  }

  console.log('── 1b. the same landing when the content width arrives WITH the mount (the other order) ──');
  {
    // Nothing may depend on which of the two host events comes first — a fix that only works when
    // onContentSizeChange rescues it is half a fix, and so is one that only works the other way.
    const h = await openGallery({ params: { template: 'banner' } });
    h.host.contentW = 15 * WIN;                   // laid out in the same pass as the height
    await h.layout(700);
    ok('lands on Bold Banner without waiting for a second content pass', h.visibleIdx() === BANNER, { offset: h.host.x });
    await h.content();
    ok('…and the later content pass does not throw it back to page 0', h.visibleIdx() === BANNER, { offset: h.host.x });
    ok('…nor does it re-scroll once the user is where they asked to be', h.cardAt(BANNER) === 'image');
    h.c.unmount();
  }

  console.log('── 1c. no template param → page 0, and a param for the LAST family still lands ──');
  {
    const h = await openGallery({ params: {} });
    await h.layout(700); await h.content();
    ok('the plain gallery still opens on the first family, unscrolled', h.visibleIdx() === 0 && h.indicator().pos === 1);
    ok('…and page 0 is the design, not a spinner', h.cardAt(0) === 'image' && h.idAt(0) === famId(0));
    h.c.unmount();
  }
  {
    const last = FAMILIES.length - 1;
    const h = await openGallery({ params: { template: famId(last) } });
    await h.layout(700); await h.content();
    ok('the last family lands too (the clamp is to length-1, and it is reachable)', h.visibleIdx() === last && h.indicator().pos === last + 1, { offset: h.host.x });
    h.c.unmount();
  }

  console.log('── 1d. landing on a VARIANT opens that family on that colour ──');
  {
    // Home's zoom carries the exact design id, recolours included: banner_teal is a swatch of Bold
    // Banner, so the pager lands on the family and the page opens on the colour that was tapped.
    const h = await openGallery({ params: { template: 'banner_teal' } });
    await h.layout(700); await h.content();
    ok('the variant lands on its family', h.visibleIdx() === BANNER, { offset: h.host.x });
    ok('…and it is the tapped COLOUR that renders, not the family default',
      h.idAt(BANNER) === 'banner_teal' && server.asked.includes('banner_teal') && !server.asked.includes('banner'), server.asked);
    h.c.unmount();
  }

  console.log('── 2. ⚠️ THE SAFETY NET: whatever page is on screen always has a request behind it ──');
  // The second half of the diagnosis: nothing guaranteed the page ACTUALLY on screen had been
  // requested, because `active` is what the screen thinks is visible, not an observation of it.
  // A paging drag released exactly on a page boundary with no velocity fires onScrollEndDrag and NO
  // onMomentumScrollEnd on iOS — so `active` stopped tracking, and with it every preview request.
  {
    const h = await openGallery({ params: {} });
    await h.layout(700); await h.content();
    await h.drag(1, { momentum: true });
    ok('a normal swipe is followed (this always worked)', h.indicator().pos === 2 && h.cardAt(1) === 'image');
    await h.drag(2, { momentum: false });
    ok('⚠️ a drag released ON the boundary is followed too', h.indicator().pos === 3, h.indicator());
    await h.drag(3, { momentum: false });
    ok('⚠️ …and the SECOND one, which no neighbour prefetch can cover, is requested',
      server.asked.includes(famId(3)), { asked: server.asked, want: famId(3) });
    ok('…so the page on screen shows its design instead of a spinner nothing is behind',
      h.cardAt(3) === 'image' && h.visibleIdx() === 3, { card: h.cardAt(3) });
    ok('…and the name row names what is on screen', h.indicator().pos === 4, h.indicator());
    h.c.unmount();
  }

  console.log('── 2b. a region chip: the new list\'s page 0 is requested, and the pager is really on it ──');
  {
    // Sit deep in "All designs" and switch to Germany / DACH (3 families). The content shrinks to
    // 3 pages in the same tick; iOS clamps a stale offset to the new content end rather than
    // honouring it, and a programmatic clamp fires no momentum-end event.
    const h = await openGallery({ params: {} });
    await h.layout(700); await h.content();
    await h.drag(9, { momentum: true });
    await h.region('Germany / DACH');
    await h.content();                                  // the content shrinks to 3 * WIN
    const dach = REGIONS.find((r) => r.id === 'dach').templates;
    ok('the pager holds only that region\'s families', h.pages().length === dach.length, h.pages().length);
    ok('the pager is back at the start, with the indicator', h.visibleIdx() === 0 && h.indicator().pos === 1 && h.indicator().total === dach.length, { x: h.host.x, ind: h.indicator() });
    ok('…and every page the user can reach has been asked for or is reachable in one swipe',
      server.asked.includes(dach[0]), { asked: server.asked, want: dach[0] });
    ok('…page 0 draws the design', h.cardAt(0) === 'image');
    await h.drag(2, { momentum: false });
    ok('⚠️ the region\'s LAST family is requested when it is reached, boundary release and all',
      server.asked.includes(dach[2]) && h.cardAt(2) === 'image', { asked: server.asked, want: dach[2] });
    await h.region('All designs');
    await h.content();
    ok('back to the whole catalogue, at the start', h.pages().length === 15 && h.visibleIdx() === 0 && h.cardAt(0) === 'image');
    h.c.unmount();
  }

  console.log('── 2c. a swatch tap: the recolour on screen is the one that is fetched ──');
  {
    const h = await openGallery({ params: { template: 'banner' } });
    await h.layout(700); await h.content();
    await h.swatch(3);                                   // the third colour of Bold Banner
    const want = FAMILIES[BANNER].variants[2].id;
    ok('the tapped colour is requested and drawn', server.asked.includes(want) && h.idAt(BANNER) === want, { asked: server.asked, want, drawn: h.idAt(BANNER) });
    ok('…and the pager has not moved off the design', h.visibleIdx() === BANNER && h.indicator().pos === BANNER + 1);
    h.c.unmount();
  }

  console.log('── 3. the retry / ownership model is untouched (nothing here may loop or re-charge) ──');
  {
    // ⚠️ A SAFETY NET THAT RE-ASKS ON EVERY RENDER WOULD BE A RENDER STAMPEDE on the serial chromium.
    // A failed design must sit on its tap-to-retry until the USER taps it — never re-request itself.
    const h = await openGallery({ params: {}, server: (s) => { s.miss.add(famId(0)); } });
    await h.layout(700); await h.content();
    ok('a design the server answered nothing for shows a retry, not a spinner', h.cardAt(0) === 'failed', h.cardAt(0));
    const asked = server.asked.filter((id) => id === famId(0)).length;
    await advance(60_000);
    ok('⚠️ …and it is NOT re-requested on its own, ever', server.asked.filter((id) => id === famId(0)).length === asked, server.asked);
    const card = h.pages()[0];
    findOne(card, (n) => n.type === 'TouchableOpacity').props.onPress();
    server.miss.clear();
    await flush();
    ok('the user\'s tap re-requests just that design, and it lands', server.asked.filter((id) => id === famId(0)).length === asked + 1 && h.cardAt(0) === 'image');
    h.c.unmount();
  }
  {
    // The 20s slow flag: still a state, not a failure — the request is alive and its answer is welcome.
    const h = await openGallery({ params: {}, server: (s) => { s.hold.add(famId(0)); } });
    await h.layout(700); await h.content();
    ok('a pending design spins', h.cardAt(0) === 'spinner', h.cardAt(0));
    await advance(20_001);
    ok('after 20s it offers "Still rendering — tap to retry"', h.cardAt(0) === 'slow', h.cardAt(0));
    const before = server.asked.filter((id) => id === famId(0)).length;
    server.hold.clear();
    findOne(h.pages()[0], (n) => n.type === 'TouchableOpacity').props.onPress();
    await flush();
    ok('the tap re-homes the id and a fresh request lands the image',
      server.asked.filter((id) => id === famId(0)).length === before + 1 && h.cardAt(0) === 'image');
    h.c.unmount();
  }
  {
    // ⚠️ THE 45s ABORT still ends in a retry card, never back to a bare spinner.
    const h = await openGallery({ params: {}, server: (s) => { s.hold.add(famId(0)); } });
    await h.layout(700); await h.content();
    await advance(45_001);
    ok('an aborted request becomes "This took too long." with a retry', h.cardAt(0) === 'failed', h.cardAt(0));
    h.c.unmount();
  }

  console.log('── 4. doc mode: the ranked order lands, and NOTHING writes preferred_template ──');
  {
    // An employer's own résumé: the "All designs" order is the doc's ranked list (family-first), so
    // the design Home showed is not at its catalogue index any more — the landing has to follow the
    // RANKED position. ⚠️ And doc mode must never record a preferred template: that column is the
    // BASE résumé's design (Auto Fill attach, email attachment).
    const ranked = [
      { id: 'elegant', score: 91, reason: 'Serif suits a legal employer' },
      { id: 'banner_crimson', score: 88, reason: 'Their brand red' },
      { id: 'azure', score: 71, reason: 'Safe default' },
    ];
    const h = await openGallery({
      params: { template: 'banner_crimson', docId: '42' },
      doc: { id: 42, employer: 'Nordex', design: { ranked, mode: 'a4' } },
    });
    await h.layout(700); await h.content();
    ok('the ranked order puts Elegant Serif first and Bold Banner second', h.pages().length === 15 && h.indicator().total === 15);
    ok('⚠️ the landing follows the RANKED position, not the catalogue one', h.visibleIdx() === 1, { offset: h.host.x, ind: h.indicator() });
    ok('…on the ranked COLOUR, and that is what was fetched',
      h.idAt(1) === 'banner_crimson' && server.asked.includes('banner_crimson'), { drawn: h.idAt(1), asked: server.asked });
    ok('…and every preview was requested for THAT document, never the base résumé',
      server.docIds.length > 0 && server.docIds.every((d) => d === 42), server.docIds);
    await h.drag(2, { momentum: false });
    await advance(2000);
    ok('⚠️ doc mode never writes preferred_template — not on landing, not on a swipe', saves.length === 0, saves);
    h.c.unmount();
  }
  {
    // The base gallery still records the choice (debounced) — the one thing this screen exists for.
    const h = await openGallery({ params: { template: 'banner' } });
    await h.layout(700); await h.content();
    await advance(2000);
    ok('the base gallery saves the design the pager actually landed on',
      saves.length === 1 && saves[0].preferredTemplate === 'banner', saves);
    h.c.unmount();
  }

  console.log('── 5. a doc that is gone, and an account with no résumé, still have their own way out ──');
  {
    const h = await openGallery({ params: { docId: '42' }, doc: 'gone' });
    await h.layout(700);
    ok('a deleted version says so instead of spinning, and renders no pager', /no longer saved/.test(textOf(h.c.tree)) && h.pages().length === 0);
    ok('…and it asked the renderer for nothing', server.asked.length === 0, server.asked);
    h.c.unmount();
  }

  /* ── The cover-letter gallery: the same landing, the same dead end, hardened the same way ──
     Its doc-mode landing effect was already gated on pagerH (that asymmetry was the tell), but it
     cleared `landOn` before an unverified scrollTo, and its cards had the same nothing-behind-the-
     spinner end. Source-contract assertions, the style test-resume-rebuild-flow.js uses for it. */
  console.log('── 6. the cover-letter gallery carries the same guarantees ──');
  const clt = fs.readFileSync(process.env.LETTER_SRC || path.join(APP, 'app/(cover-letter)/templates.tsx'), 'utf8');
  const code = clt.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok('its landing effect is still gated on the pager existing, and re-runs when it does',
    /if \(loading \|\| landOn\.current == null \|\| !docSlots\.length \|\| pagerH <= 0\) return;/.test(code)
    && /\}, \[loading, docSlots\.length, pagerH\]\);/.test(code));
  ok('⚠️ …and the restore is only given up once the content is wide enough to hold it',
    /onContentSizeChange=\{/.test(code) && /landOn\.current = null;/.test(code)
    && /w < \(i \+ 1\) \* WIN/.test(code));
  ok('a drag released on a page boundary moves it too (no momentum event on iOS)',
    /onScrollEndDrag=\{onScrollEnd\}/.test(code));
  // ⚠️ docGone rides in the guard AND the deps on both screens: the states that render no pager have
  // no visible card to protect, and a vanished document must not be re-rendered page by page.
  ok('⚠️ the card on screen always has a request: the window follows `active`, it is not assumed',
    /useEffect\(\(\) => \{[\s\S]{0,300}ensureDocAround\(active, docSlots, docId\);[\s\S]{0,80}\}, \[active, docSlots, docId, loading, docGone\]\);/.test(code)
    && /if \(loading \|\| docGone \|\| !docId \|\| !docSlots\.length\) return;/.test(code));
  ok('…and the scroll-end handler no longer skips the request when the index looks unchanged',
    !/if \(docId && idx !== active\) ensureDocAround/.test(code));
  ok('⚠️ its last card branch is not a dead end either: a spinner only for a live request',
    /docInFlight\.current\.has\(slot\.id\)/.test(code) && /Tap to load this design/.test(code));

  console.log(`\nresume gallery: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('SUITE THREW', e); process.exit(2); });
