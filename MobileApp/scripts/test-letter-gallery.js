// The cover-letter design gallery (app/(cover-letter)/templates.tsx) — its footer and download sheet.
// Transpiles the REAL screen and renders it in the same tiny fake React runtime test-resume-gallery.js
// uses (hooks by call order, a walkable element tree, a fake clock), then drives it like a thumb would.
//   node MobileApp/scripts/test-letter-gallery.js
//
// THE REPORT (2026-09-18): "why the cover letter preview has so many fields it should be same one
// download button there to make more space for preview and then all those options should come as the
// bottom up popup… make it same like the resume one". The footer was four rows (One Page / A4, Download
// PDF, Download as Word, a note). It is now the resume gallery's: ONE Download button, and every option
// in a swipe-up sheet. This suite pins the shape AND that nothing a button does changed on the way —
// the gate, the paywall, the pending format it resumes, the docId and the employer on the body.
//
// ⚠️ AND ONE MODAL AT A TIME. A locked format tap opens DownloadPaywallSheet, which is another Modal;
// iOS cannot present one while the sheet is still sliding away, so a paywall asked for in the SAME
// commit as the sheet's close never appears — the tap reads as a dead button. The screen waits for the
// sheet's onDismiss (with a net under it); these scenarios hold it to that, and to running exactly once.
//
// ⚠️ RUN IT AGAINST ANOTHER COPY of the screen to prove it still catches the bug — the mutation proof:
//   LETTER_SRC=/tmp/pre-fix/templates.tsx node MobileApp/scripts/test-letter-gallery.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const APP = path.join(__dirname, '..');
const ts = require(path.join(APP, 'node_modules/typescript'));
const OUT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cva-letter-gallery-')));

const LETTER_SRC = process.env.LETTER_SRC || path.join(APP, 'app/(cover-letter)/templates.tsx');
function transpile(src, name) {
  const js = ts.transpileModule(fs.readFileSync(src, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, jsx: ts.JsxEmit.React },
    fileName: name,
  }).outputText;
  const p = path.join(OUT, name.replace(/\.tsx?$/, '.js'));
  fs.writeFileSync(p, js);
  return p;
}
const SCREEN = transpile(LETTER_SRC, 'templates.tsx');

/* ── fake clock: the sheet's settle net must be drivable, and must not hold node open ── */
let now = 1_700_000_000_000;
let tid = 0;
const timers = new Map();
const rafs = [];
global.setTimeout = (fn, ms) => { const id = ++tid; timers.set(id, { at: now + (Number(ms) || 0), fn }); return id; };
global.clearTimeout = (id) => { timers.delete(id); };
global.requestAnimationFrame = (fn) => { rafs.push(fn); return rafs.length; };
const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setImmediate(r));
    while (rafs.length) for (const fn of rafs.splice(0)) fn(now);
  }
};
async function advance(ms) {
  const end = now + ms;
  for (let g = 0; g < 1000; g++) {
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

function mount(fn) {
  const inst = { hooks: [], idx: 0, pending: [], unmounted: false, result: null, renders: 0 };
  let scheduled = false;
  inst.schedule = () => { if (scheduled || inst.unmounted) return; scheduled = true; queueMicrotask(() => { scheduled = false; if (!inst.unmounted) renderNow(); }); };
  function renderNow() {
    current = inst; inst.idx = 0; inst.pending = [];
    inst.result = fn();
    current = null; inst.renders++;
    const pend = inst.pending; inst.pending = [];
    for (const i of pend) { const slot = inst.hooks[i]; if (slot.cleanup) slot.cleanup(); const c = slot.fn(); slot.cleanup = typeof c === 'function' ? c : null; }
  }
  renderNow();
  return {
    get tree() { return inst.result; },
    unmount() { inst.unmounted = true; for (const h of inst.hooks) if (h && h.effect && h.cleanup) h.cleanup(); },
  };
}

/* ── tree helpers ── */
function walk(node, fn, skip) {
  if (!node || !node.$el) return;
  if (skip && skip(node)) return;
  fn(node);
  for (const c of node.children) walk(c, fn, skip);
}
function findAll(root, pred, skip) { const out = []; walk(root, (n) => { if (pred(n)) out.push(n); }, skip); return out; }
function findOne(root, pred, skip) { return findAll(root, pred, skip)[0] || null; }
function textOf(node) {
  const out = [];
  const rec = (n) => {
    if (n == null) return;
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return; }
    if (!n.$el) return;
    // SegBtn is a function component the fake runtime does not expand — its label IS its text.
    if (typeof n.type === 'function' && typeof n.props.label === 'string') out.push(n.props.label);
    n.children.forEach(rec);
  };
  rec(node);
  return out.join('');
}
const isModal = (n) => n.type === 'Modal';

/* ── mocks ── */
const WIN = 390;
let OS = 'ios';
let ctxStash, doc, locked, calls, alerts;
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const OPEN = { metered: false, paid: true, unlimited: true, remaining: null, passes: 0, ownsEmployer: false, employer: null };
const SHUT = { metered: false, paid: false, unlimited: false, remaining: null, passes: 0, ownsEmployer: false, employer: null };
const LETTERS = [
  { id: 'standard', name: 'Original (Branded)', accent: '#3a6cb5' },
  { id: 'ats_pro', name: 'ATS Professional', accent: '#1f2937' },
  { id: 'exec_leader', name: 'Executive Leadership', accent: '#b8995a' },
];

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'react') return FakeReact;
  if (request === 'react-native') return {
    View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator', Modal: 'Modal', Pressable: 'Pressable',
    StyleSheet: { create: (o) => o },
    Alert: { alert: (title, msg) => alerts.push({ title, msg }) },
    Dimensions: { get: () => ({ width: WIN, height: 844 }) },
    get Platform() { return { OS, select: (o) => (OS in o ? o[OS] : o.default) }; },
    useWindowDimensions: () => ({ width: WIN, height: 844, fontScale: 1 }),
  };
  if (request === 'react-native-safe-area-context') return { SafeAreaView: 'SafeAreaView' };
  if (request === 'expo-image') return { Image: 'Image' };
  if (request === 'expo-linear-gradient') return { LinearGradient: 'LinearGradient' };
  if (request === '@expo/vector-icons') return { Ionicons: 'Ionicons' };
  if (request === 'expo-router') return {
    useRouter: () => ({ back() {}, push() {}, replace() {}, canGoBack: () => true }),
    useLocalSearchParams: () => params,
  };
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: { getItem: async () => (ctxStash ? JSON.stringify(ctxStash) : null) } };
  if (request === 'expo-secure-store') return { getItemAsync: async () => JSON.stringify({ token: 'tok' }) };
  if (request === 'expo-file-system/legacy') return { downloadAsync: async () => ({ status: 200, uri: 'file://c.pdf' }), cacheDirectory: 'file:///c/' };
  if (request === 'expo-sharing') return { isAvailableAsync: async () => false, shareAsync: async () => {} };
  if (request === '../../config') return { API_BASE: 'https://api.test' };
  if (request === '../../components/downloads/DownloadPaywallSheet') return { __esModule: true, default: 'DownloadPaywallSheet' };
  if (request === '../../components/RatingPromptModal') return { __esModule: true, default: 'RatingPromptModal', useRatingPrompt: () => ({ trigger: null, ask: async () => false, close() {} }) };
  if (request === '../../hooks/useEventCosts') return { useEventCosts: () => ({ costs: {} }) };
  if (request === '../../services/downloadPassService') return {
    fetchDownloadState: async () => (locked ? SHUT : OPEN),
    downloadButtonLabel: (st) => ({ label: 'Download', locked: !(st.ownsEmployer || st.passes > 0 || st.unlimited) }),
  };
  if (request === '../../services/subscriptionService') return { fetchSubscriptionStatus: async () => (locked ? {} : { subscription: { plan: 'pro' } }) };
  if (request === '../../services/employerDocs') return {
    fetchDoc: async () => doc,
    fetchDocCards: async (_kind, _did, ids) => ({ cards: ids.map((id) => ({ id, image: 'data:image/jpeg;base64,' + id, width: 794, height: 1123 })) }),
  };
  if (request === '../../services/employerHomeService') return { LETTER_DESIGNS: LETTERS };
  return origLoad.apply(this, arguments);
};
let params = {};

global.fetch = async (url, init) => {
  const u = String(url);
  const body = init && init.body ? JSON.parse(init.body) : null;
  calls.push({ url: u, body });
  if (u.endsWith('/cover-letter/preview-templates')) {
    return jsonRes(200, { previews: LETTERS.map((d) => ({ ...d, image: 'data:image/jpeg;base64,' + d.id, width: 794, height: 1123 })) });
  }
  if (/\/cover-letter\/generate-template-(pdf|docx)$/.test(u)) {
    if (locked) return jsonRes(403, { reason: 'paid_required', error: 'Downloads are part of the paid plans.' });
    return jsonRes(200, { downloadUrl: '/api/files/Cover_Letter.' + (u.endsWith('docx') ? 'docx' : 'pdf') });
  }
  return jsonRes(200, {});
};

/* ── scenario plumbing ── */
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

async function openLetters(o = {}) {
  delete require.cache[SCREEN];
  for (const id of timers.keys()) timers.delete(id);
  rafs.length = 0;
  OS = o.os || 'ios';
  locked = !!o.locked;
  calls = []; alerts = [];
  params = o.params || {};
  doc = o.doc === undefined ? null : o.doc;
  ctxStash = o.ctx === undefined
    ? { coverLetterHtml: '<p>Dear team</p>', companyName: 'Nordex SE', companyAddress: 'Hamburg', employer: 'Nordex' }
    : o.ctx;
  const Screen = require(SCREEN).default;
  const c = mount(() => Screen());
  await flush();
  const sheet = () => findOne(c.tree, isModal);
  const paywall = () => findOne(c.tree, (n) => n.type === 'DownloadPaywallSheet');
  const h = {
    c, sheet, paywall,
    /** Every touchable OUTSIDE the sheet that is a download / format / page-layout control. */
    footerControls: () => findAll(c.tree, (n) => (n.type === 'TouchableOpacity' || typeof n.type === 'function')
      && /^(Download|PDF|Word|One Page|A4)/.test(textOf(n)), isModal),
    /** The footer's Download button (outside the sheet). */
    dlButton: () => findOne(c.tree, (n) => n.type === 'TouchableOpacity' && /^Download/.test(textOf(n)), isModal),
    /** A row inside the sheet, by the start of its text. */
    row: (re) => { const m = sheet(); return m ? findOne(m, (n) => (n.type === 'TouchableOpacity' || typeof n.type === 'function') && re.test(textOf(n))) : null; },
    sheetOpen: () => !!(sheet() && sheet().props.visible),
    payOpen: () => !!(paywall() && paywall().props.visible),
    gens: () => calls.filter((x) => /generate-template-(pdf|docx)$/.test(x.url)),
    async press(node) { node.props.onPress(); await flush(); },
    /** iOS reports the sheet's slide-out as finished. */
    async dismissed() { const m = sheet(); if (m && typeof m.props.onDismiss === 'function') m.props.onDismiss(); await flush(); },
    text: () => textOf(c.tree),
  };
  return h;
}

(async () => {
  console.log('── 1. ⚠️ THE REPORT: one Download button under the page, every option in the sheet ──');
  {
    const h = await openLetters();
    const ctl = h.footerControls().map(textOf);
    ok('⚠️ outside the sheet there is exactly ONE download control, and it says Download',
      ctl.length === 1 && /^Download$/.test(ctl[0]), ctl);
    ok('…no page-layout toggle and no PDF / Word rows left under the page',
      !ctl.some((t) => /One Page|A4|PDF|Word/.test(t)), ctl);
    ok('the sheet exists and starts closed', !!h.sheet() && h.sheet().props.visible === false);
    ok('…it slides up from the bottom, like the resume sheet', h.sheet().props.animationType === 'slide' && h.sheet().props.transparent === true);
    ok('the region chips stay at the top, as on the resume gallery', /USA \/ Canada/.test(textOf(findOne(h.c.tree, (n) => n.type === 'ScrollView' && n.props.horizontal && !n.props.pagingEnabled))));
    ok('…without the caption row that ate a line above them', !/Target country \/ region/i.test(h.text()));
    ok('the classic lead line still tells them how to use the pager', /Swipe to compare/.test(h.text()));

    await h.press(h.dlButton());
    ok('the Download button opens the sheet', h.sheetOpen());
    const inSheet = textOf(h.sheet());
    ok('…which holds the page layout, both formats and the note', /Page layout/.test(inSheet) && /One Page/.test(inSheet)
      && /A4 Pages/.test(inSheet) && /File format/.test(inSheet) && !!h.row(/^PDF/) && !!h.row(/^Word/) && /Included · one continuous page/.test(inSheet), inSheet);
    ok('…and names the design on screen', /Download “Original \(Branded\)”/.test(inSheet), inSheet);
    ok('nothing was downloaded just by opening it', h.gens().length === 0);

    await h.press(h.row(/^A4 Pages/));
    ok('the page layout still toggles, from inside the sheet', /Included · A4, splits into pages/.test(textOf(h.sheet())));

    await h.press(h.row(/^PDF/));
    ok('a format tap closes the sheet', !h.sheetOpen());
    ok('⚠️ …and waits for it to finish leaving before it downloads (iOS)', h.gens().length === 0);
    await h.dismissed();
    const g = h.gens();
    ok('once the sheet is gone, the PDF is generated — once', g.length === 1 && /generate-template-pdf$/.test(g[0].url), g.map((x) => x.url));
    ok('⚠️ …with exactly the body it always sent: the design, the layout picked IN the sheet, both spellings of the company',
      g[0] && g[0].body.template === 'standard' && g[0].body.mode === 'a4' && g[0].body.employer === 'Nordex'
      && g[0].body.companyName === 'Nordex SE' && g[0].body.companyAddress === 'Hamburg' && !('docId' in g[0].body), g[0] && g[0].body);
    await advance(2000);
    await h.dismissed();
    ok('⚠️ a late onDismiss and the net together still run it exactly once', h.gens().length === 1, h.gens().length);
    ok('the download finished the way it always did', alerts.some((a) => a.title === 'Downloaded'), alerts);
    h.c.unmount();
  }

  console.log('── 2. ⚠️ ONE MODAL AT A TIME: a locked tap opens the paywall only after the sheet has gone ──');
  {
    const h = await openLetters({ locked: true });
    ok('a locked Download button carries the padlock badge', /Paid plans/.test(textOf(h.dlButton())));
    await h.press(h.dlButton());
    ok('…and the rows in the sheet say Locked', /Locked/.test(textOf(h.row(/^Word/))));
    await h.press(h.row(/^Word/));
    ok('⚠️ the sheet closes and the paywall is NOT asked for in the same commit (iOS drops that present)',
      !h.sheetOpen() && !h.payOpen());
    await h.dismissed();
    ok('…the paywall opens once the sheet is gone', h.payOpen());
    ok('⚠️ and the gate held: no file was generated for a locked account', h.gens().length === 0);
    // What the paywall hands back after a purchase is the format they had picked — the hand-off the
    // move must not have touched. ⚠️ NOT asserted as a finished download: onUnlocked calls the
    // handleDownload of the render it was created in, whose dlState is still the locked one, so today
    // (here AND in the resume gallery, unchanged by this move) the gate re-opens the paywall instead of
    // downloading. That is reported, not silently fixed in one of the two twins.
    ok('the paywall is handed the pending format to resume', /pendingFmt/.test(fs.readFileSync(LETTER_SRC, 'utf8'))
      && /const fmt = pendingFmt; setPendingFmt\(null\);\s*if \(fmt\) handleDownload\(fmt\);/.test(fs.readFileSync(LETTER_SRC, 'utf8')));
    h.c.unmount();
  }

  console.log('── 3. the net under onDismiss, Android, and a screen that is left mid-slide ──');
  {
    const h = await openLetters({ locked: true });
    await h.press(h.dlButton());
    await h.press(h.row(/^PDF/));
    await advance(600);
    ok('with no onDismiss yet, nothing has run while the sheet could still be sliding', !h.payOpen());
    await advance(100);
    ok('⚠️ the net runs it when onDismiss never comes', h.payOpen());
    h.c.unmount();
  }
  {
    const h = await openLetters({ os: 'android' });
    await h.press(h.dlButton());
    await h.press(h.row(/^PDF/));
    ok('Android stacks dialogs, so the tap runs at once there', h.gens().length === 1);
    await h.dismissed();
    await advance(2000);
    ok('…and an Android onDismiss does not run it a second time', h.gens().length === 1);
    h.c.unmount();
  }
  {
    const h = await openLetters();
    await h.press(h.dlButton());
    await h.press(h.row(/^PDF/));
    h.c.unmount();
    await advance(2000);
    ok('⚠️ leaving the screen mid-slide starts no download', calls.filter((x) => /generate-template/.test(x.url)).length === 0);
  }
  {
    const h = await openLetters({ ctx: { coverLetterHtml: '<p>Hi</p>', companyName: 'Siemens', employer: 'Siemens', format: 'docx' } });
    await h.press(h.dlButton());
    const rows = findAll(h.sheet(), (n) => n.type === 'TouchableOpacity' && /^(PDF|Word)/.test(textOf(n))).map(textOf);
    ok('the format chosen on the Review screen is still the first row', /^Word/.test(rows[0]) && /^PDF/.test(rows[1]), rows);
    h.c.unmount();
  }

  console.log('── 4. doc mode: the employer\'s own letter, ranked — the lead line carries the ranking now ──');
  {
    const ranked = [
      { id: 'exec_leader', score: 92, reason: 'A leadership voice for a leadership role' },
      { id: 'standard', score: 80, reason: '' },
      { id: 'ats_pro', score: 71, reason: 'Parses cleanly through their ATS' },
    ];
    const h = await openLetters({
      params: { docId: '42' },
      ctx: null,
      doc: { id: 42, employer: 'Nordex', payload: { coverLetterHtml: '<p>Dear Nordex</p>', companyName: 'Nordex SE' }, design: { ranked, mode: 'onepage' } },
    });
    const t = h.text();
    ok('the ranking is the lead line, like the resume gallery', /Best fit for Nordex first · every preview is free/.test(t), t.slice(0, 200));
    ok('…and the old separate "Ranked for" row is gone', !/Ranked for/.test(t));
    ok('doc mode has no region chips', !/USA \/ Canada/.test(t));
    ok('still exactly one download control outside the sheet', h.footerControls().length === 1);
    const reason = findOne(h.c.tree, (n) => n.type === 'Text' && n.props.numberOfLines === 2 && n.props.maxFontSizeMultiplier);
    ok('the fit reason is a fixed two-line slot (the pager cannot jump between designs)',
      !!reason && Array.isArray(reason.props.style) && reason.props.style.some((x) => x && x.minHeight > 0), reason && reason.props);
    await h.press(h.dlButton());
    ok('the sheet names the ranked design on screen', /Download “Executive Leadership”/.test(textOf(h.sheet())));
    await h.press(h.row(/^PDF/));
    await h.dismissed();
    const g = h.gens();
    ok('⚠️ the download still carries the docId, so the server bills THAT document', g.length === 1 && g[0].body.docId === 42 && g[0].body.template === 'exec_leader', g[0] && g[0].body);
    h.c.unmount();
  }

  console.log(`\nletter gallery: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('SUITE THREW', e); process.exit(2); });
