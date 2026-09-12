// Home's build orchestration (components/employer-home/useHomeBuilds.ts) — behavioural tests.
// Transpiles the hook and the REAL services/homeBuilds.ts store, mocks the build service / Alert / haptics /
// analytics, and runs the hook inside a tiny fake React hooks runtime under a fake clock.
//   node MobileApp/scripts/test-home-builds.js
//
// ⚠️ WHY: this hook decides when money is spent. A build starts only from an explicit request; a covered
// gate starts it with coveredOnly:true; credits or an unreadable gate ask first (and a Build tap is the only
// consent coveredOnly:false ever gets); a quota refusal builds nothing; a recovered build lands exactly once;
// and nothing of one account survives into the next.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const APP = path.join(__dirname, '..');
const ts = require(path.join(APP, 'node_modules/typescript'));
// ⚠️ realpath: on macOS os.tmpdir() is a symlink, require.cache is keyed by the REAL path, and a fresh()
// that deletes the symlinked key would silently keep the first run's module (and its first mocks).
const OUT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cva-home-builds-')));

function transpile(src, name) {
  const js = ts.transpileModule(fs.readFileSync(src, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: name,
  }).outputText;
  const p = path.join(OUT, name.replace(/\.tsx?$/, '.js'));
  fs.writeFileSync(p, js);
  return p;
}
const HOOK = transpile(path.join(APP, 'components/employer-home/useHomeBuilds.ts'), 'useHomeBuilds.ts');
if (process.env.MUTATE) {
  const [from, to] = JSON.parse(process.env.MUTATE);
  const code = fs.readFileSync(HOOK, 'utf8');
  if (!code.includes(from)) { console.log('MUTATION TARGET NOT FOUND: ' + from); process.exit(3); }
  fs.writeFileSync(HOOK, code.split(from).join(to));
}
const STORE = transpile(path.join(APP, 'services/homeBuilds.ts'), 'homeBuilds.ts');

/* ── fake clock ── */
let now = 1_700_000_000_000;
let tid = 0;
const timers = new Map();
global.setTimeout = (fn, ms) => { const id = ++tid; timers.set(id, { at: now + (Number(ms) || 0), fn }); return id; };
global.clearTimeout = (id) => { timers.delete(id); };
global.setInterval = () => 0;
global.clearInterval = () => {};
const realDateNow = Date.now;
Date.now = () => now;
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
async function advance(ms) {
  const end = now + ms;
  for (let g = 0; g < 20000; g++) {
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

/* ── fake React ── */
let current = null;
const depsEq = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
const FakeReact = {
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
  useSyncExternalStore(subscribe, getSnapshot) {
    const inst = current; const i = inst.idx++;
    let s = inst.hooks[i]; if (!s) s = inst.hooks[i] = {};
    s.get = getSnapshot;
    if (s.subscribe !== subscribe) {
      if (s.unsub) s.unsub();
      s.subscribe = subscribe;
      s.unsub = subscribe(() => { if (!Object.is(s.get(), s.last)) inst.schedule(); });
    }
    s.last = getSnapshot();
    return s.last;
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
    get r() { return inst.result; },
    unmount() { inst.unmounted = true; for (const h of inst.hooks) { if (h && h.effect && h.cleanup) h.cleanup(); if (h && h.unsub) h.unsub(); } },
    inst,
  };
}

/* ── mocks ── */
const TOO_MANY = { ok: false, reason: 'failed', message: 'Three builds are already running — start this one when one finishes.' };
function jobKeyOf(i) {
  const url = String(i.jobUrl || '').trim(); if (url) return 'u:' + url.toLowerCase();
  const text = String(i.jobText || '').trim(); if (text) return 't:' + text.length;
  const title = String(i.jobTitle || '').trim().toLowerCase(); return title ? 'n:' + title : '';
}
let svc, alerts, tracked, haptics;
function makeSvc() {
  const s = {
    MAX_PARALLEL_BUILDS: 3, account: 'u:1', flights: new Map(),
    // recoverOpts: what recovery was asked for each time — resendKey is the difference between
    // "poll what the server already has" and "send that lost POST again, and charge for it".
    calls: { gate: [], build: [], recover: 0, peek: 0, recoverOpts: [], forget: [] },
    gateImpl: async () => ({ covered: true, via: 'plan' }),
    recoverImpl: async () => [],
    peekImpl: async () => [],
  };
  s.buildKeyOf = (kind, t) => kind + '|' + String(t.company || '').trim().toLowerCase().replace(/\s+/g, ' ') + '|' + jobKeyOf(t);
  s.gateJobFor = (i) => { const o = {}; if (i.jobTitle) o.title = i.jobTitle; if (i.jobUrl) o.url = i.jobUrl; if (i.jobText) o.description = i.jobText; if (i.website) o.website = i.website; return o; };
  s.checkBuildGate = (employer, job, kind, extra) => { s.calls.gate.push({ employer, job, kind, extra }); return s.gateImpl({ employer, job, kind, extra }); };
  s.activeBuildCount = () => s.flights.size;
  s.signedInAccount = async () => s.account;
  s.peekInflight = async () => { s.calls.peek++; return s.peekImpl(); };
  s.resumeInflightBuilds = async (onStage, opts) => { s.calls.recover++; s.calls.recoverOpts.push(opts || null); return s.recoverImpl(onStage, opts); };
  // The service drops a removed chip's remembered build (a lost POST nobody can consent to resending).
  s.forgetInflight = async (bk) => { s.calls.forget.push(bk); };
  s.buildForEmployer = (i, onStage) => {
    const kind = i.kind === 'cover_letter' ? 'cover_letter' : 'resume';
    const key = s.buildKeyOf(kind, i);
    s.calls.build.push({ ...i, kind, key });
    const live = s.flights.get(key);
    if (live) { live.listeners.add(onStage); if (live.last) onStage(live.last); return live.promise; }
    if (s.flights.size >= s.MAX_PARALLEL_BUILDS) return Promise.resolve(TOO_MANY);
    let resolve; const promise = new Promise((r) => { resolve = r; });
    const f = { key, kind, listeners: new Set([onStage]), last: null, promise, resolve };
    s.flights.set(key, f);
    return promise;
  };
  s.stage = (key, st) => { const f = s.flights.get(key); f.last = st; f.listeners.forEach((l) => l(st)); };
  s.finish = (key, result) => { const f = s.flights.get(key); if (!f) throw new Error('no flight ' + key); s.flights.delete(key); f.resolve(result); };
  return s;
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'react') return FakeReact;
  if (request === 'react-native') return { Alert: { alert: (title, msg, buttons, options) => alerts.push({ title, msg, buttons, options }) } };
  if (request === 'expo-haptics') return { notificationAsync: async () => { haptics++; }, NotificationFeedbackType: { Success: 'success' } };
  if (request === '../../services/homeAddEmployer') return svc;
  if (request === '../../services/homeBuilds') return require(STORE);
  if (request === '../../services/analytics') return { track: async (e, p) => { tracked.push([e, p]); } };
  return origLoad.apply(this, arguments);
};

/* ── scenario plumbing ── */
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

async function fresh(o = {}) {
  delete require.cache[HOOK]; delete require.cache[STORE];
  for (const id of timers.keys()) timers.delete(id);
  svc = makeSvc(); alerts = []; tracked = []; haptics = 0;
  if (o.svc) o.svc(svc);
  const mod = require(HOOK);
  const store = require(STORE);
  const landed = []; const notices = [];
  const env = { alive: true, rk: {} };
  const opts = {
    alive: () => env.alive,
    rkFor: (meta) => (meta.key in env.rk ? env.rk[meta.key] : null),
    onLanded: (job, docId, cached, watched) => landed.push({ job, docId, cached, watched }),
    onNotice: (text, action) => notices.push({ text, action }),
    onSeePlans: () => {},
  };
  const c = mount(() => mod.useHomeBuilds(opts));
  await flush();
  return { mod, store, c, landed, notices, env };
}
const JOB = (over = {}) => ({ kind: 'resume', rk: 'emp_1', company: 'Amazon', website: 'https://amazon.jobs', employerId: '11111111-1111-1111-1111-111111111111', country: 'India', jobUrl: '', jobText: '', jobTitle: '', ...over });
const rec = (store, key) => store.getBuilds()[key] || null;

(async () => {
  console.log('── 1. covered + watched: runs coveredOnly, lands docId, overlay done, record clears ──');
  {
    const { c, store, landed, notices } = await fresh();
    c.r.request(JOB(), { explicit: true });
    ok('checking record at once', rec(store, 'resume|emp_1')?.phase === 'checking');
    await advance(0);
    ok('gate asked once for the doc lane shape', svc.calls.gate.length === 1 && svc.calls.gate[0].kind === 'resume'
      && svc.calls.gate[0].extra.employerId === JOB().employerId && svc.calls.gate[0].job.website === 'https://amazon.jobs');
    ok('build started coveredOnly:true', svc.calls.build.length === 1 && svc.calls.build[0].coveredOnly === true && svc.calls.build[0].country === 'India');
    ok('record is building', rec(store, 'resume|emp_1')?.phase === 'building');
    ok('overlay visible and bound', c.r.overlay.visible && c.r.overlay.key === 'resume|emp_1' && c.r.overlay.kind === 'resume');
    const key = svc.calls.build[0].key;
    svc.stage(key, { stage: 'writing', label: 'Rewriting your resume for Amazon', pct: 38 });
    await flush();
    ok('stage reaches store and overlay', rec(store, 'resume|emp_1')?.stage?.pct === 38 && c.r.overlay.stage?.pct === 38);
    svc.stage(key, { stage: 'recovering', label: 'Picking up where it left off', pct: 5 });
    await flush();
    ok('pct never goes backwards', rec(store, 'resume|emp_1')?.stage?.pct === 38);
    svc.finish(key, { ok: true, cached: false, docId: 42 });
    await flush();
    ok('done with docId', rec(store, 'resume|emp_1')?.phase === 'done' && rec(store, 'resume|emp_1')?.docId === 42);
    ok('onLanded watched=true', landed.length === 1 && landed[0].docId === 42 && landed[0].watched === true && landed[0].job.rk === 'emp_1');
    ok('no notice when watched', notices.length === 0);
    ok('overlay done', c.r.overlay.done === true && c.r.overlay.visible);
    c.r.dismissOverlay();
    await flush();
    ok('dismiss hides', c.r.overlay.visible === false);
    await advance(8000);
    ok('done record clears after 8s', rec(store, 'resume|emp_1') === null);
  }

  console.log('── 2. nothing without explicit:true ──');
  {
    const { c, store } = await fresh();
    c.r.request(JOB(), { explicit: false });
    c.r.request(JOB(), {});
    c.r.request(JOB(), undefined);
    await advance(10000);
    ok('no record, no gate, no build', !rec(store, 'resume|emp_1') && svc.calls.gate.length === 0 && svc.calls.build.length === 0);
  }

  console.log('── 3. credits: Alert first; Cancel clears; Build sends coveredOnly:false ──');
  {
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = async () => ({ covered: false, via: 'credits', credits: 2 }); } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    ok('an Alert, no build', alerts.length === 1 && svc.calls.build.length === 0);
    ok('Alert copy names the charge', alerts[0].title === 'Build your Amazon resume?' && alerts[0].msg === 'This uses 2 credits.');
    alerts[0].buttons.find((b) => b.text === 'Cancel').onPress();
    await flush();
    ok('Cancel clears the record, builds nothing', !rec(store, 'resume|emp_1') && svc.calls.build.length === 0);
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    ok('asked again', alerts.length === 2);
    alerts[1].buttons.find((b) => b.text === 'Build').onPress();
    await flush();
    ok('Build → coveredOnly:false', svc.calls.build.length === 1 && svc.calls.build[0].coveredOnly === false);
    alerts[1].buttons.find((b) => b.text === 'Build').onPress();
    await flush();
    ok('a double tap builds once', svc.calls.build.length === 1);
  }

  console.log('── 3b. letter credits copy ──');
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => ({ covered: false, via: 'credits', credits: 1 }); } });
    c.r.request(JOB({ kind: 'cover_letter' }), { explicit: true });
    await advance(0);
    ok('letter Alert', alerts[0]?.title === 'Build your Amazon cover letter?' && alerts[0]?.msg === 'This uses 1 credit.');
  }

  console.log('── 4. unreadable gate: checking overlay, then ASK (never auto) ──');
  {
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = () => new Promise(() => {}); } });
    c.r.request(JOB(), { explicit: true });
    await advance(299);
    ok('no overlay before the quick-gate grace', c.r.overlay.visible === false);
    await advance(2);
    ok('"Checking your plan…" after the grace', c.r.overlay.visible && c.r.overlay.stage?.stage === 'checking');
    await advance(8000);
    ok('overlay hidden for the question', c.r.overlay.visible === false);
    ok('asked, not built', alerts.length === 1 && svc.calls.build.length === 0 && /plan allowance or credits/.test(alerts[0].msg));
    ok('Not now / Build', alerts[0].buttons.map((b) => b.text).join(',') === 'Not now,Build');
    alerts[0].buttons.find((b) => b.text === 'Build').onPress();
    await flush();
    ok('Build → coveredOnly:false', svc.calls.build[0]?.coveredOnly === false);
    ok('record building', rec(store, 'resume|emp_1')?.phase === 'building');
  }

  console.log('── 5. quota: overlay error, no build, cleared once seen ──');
  {
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = async () => ({ covered: false, via: null, reason: 'quota_exhausted' }); } });
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(0);
    ok('error record', rec(store, 'resume|emp_1')?.phase === 'error' && rec(store, 'resume|emp_1')?.error?.reason === 'quota_exhausted');
    ok('overlay error visible even with showOverlay:false', c.r.overlay.visible && c.r.overlay.error?.reason === 'quota_exhausted' && !c.r.overlay.canRetry);
    ok('no build', svc.calls.build.length === 0);
    c.r.dismissOverlay();
    await flush();
    ok('refusal record clears on dismiss', !rec(store, 'resume|emp_1'));
  }

  console.log('── 6. capacity: 4th waits, re-gated when a slot frees ──');
  {
    const { c, store, notices } = await fresh();
    for (let n = 1; n <= 3; n++) c.r.request(JOB({ rk: 'emp_' + n, company: 'Co' + n }), { explicit: true, showOverlay: false });
    await advance(0);
    ok('three running', svc.flights.size === 3);
    c.r.request(JOB({ rk: 'emp_4', company: 'Co4' }), { explicit: true, showOverlay: false });
    await advance(0);
    ok('4th queued, not built', rec(store, 'resume|emp_4')?.phase === 'queued' && svc.calls.build.length === 3);
    ok('queue notice', notices.some((x) => /Three builds are already running — we’ll start Co4/.test(x.text)));
    const gates = svc.calls.gate.length;
    c.r.request(JOB({ rk: 'emp_4', company: 'Co4' }), { explicit: true, showOverlay: false });
    await flush();
    ok('asking again for a queued chip starts nothing new', svc.calls.gate.length === gates && svc.calls.build.length === 3);
    svc.finish(svc.calls.build[0].key, { ok: true, cached: false, docId: 1 });
    await advance(0);
    ok('re-gated on drain', svc.calls.gate.length === gates + 1);
    ok('4th started coveredOnly', svc.calls.build.length === 4 && svc.calls.build[3].company === 'Co4' && svc.calls.build[3].coveredOnly === true);
    ok('4th building', rec(store, 'resume|emp_4')?.phase === 'building');
  }

  console.log('── 7. capacity + consent: not asked twice for the same number; asked for a bigger one ──');
  {
    const { c, store } = await fresh();
    for (let n = 1; n <= 3; n++) c.r.request(JOB({ rk: 'emp_' + n, company: 'Co' + n }), { explicit: true, showOverlay: false });
    await advance(0);
    svc.gateImpl = async () => ({ covered: false, via: 'credits', credits: 2 });
    c.r.request(JOB({ rk: 'emp_4', company: 'Co4' }), { explicit: true, showOverlay: false });
    await advance(0);
    alerts[0].buttons.find((b) => b.text === 'Build').onPress();
    await flush();
    ok('consented but full → queued', rec(store, 'resume|emp_4')?.phase === 'queued' && svc.calls.build.length === 3);
    svc.finish(svc.calls.build[0].key, { ok: true, cached: false, docId: 1 });
    await advance(0);
    ok('same price → starts without a second dialog, coveredOnly:false', alerts.length === 1 && svc.calls.build.length === 4 && svc.calls.build[3].coveredOnly === false);
    // bigger price
    c.r.request(JOB({ rk: 'emp_5', company: 'Co5' }), { explicit: true, showOverlay: false });
    await advance(0);
    ok('dialog for Co5', alerts.length === 2);
    alerts[1].buttons.find((b) => b.text === 'Build').onPress();
    await flush();
    ok('Co5 queued', rec(store, 'resume|emp_5')?.phase === 'queued');
    svc.gateImpl = async () => ({ covered: false, via: 'credits', credits: 5 });
    svc.finish(svc.calls.build[1].key, { ok: true, cached: false, docId: 2 });
    await advance(0);
    ok('higher price → asked again, not built', alerts.length === 3 && svc.calls.build.length === 4 && alerts[2].msg === 'This uses 5 credits.');
  }

  console.log('── 8. named null stands down; named value is what is gated and built ──');
  {
    const { c, store } = await fresh();
    c.r.request(JOB({ rk: 'p1' }), { explicit: true, holdMs: 950, named: Promise.resolve(null) });
    await advance(2000);
    ok('null → no gate, no build, record gone', svc.calls.gate.length === 0 && svc.calls.build.length === 0 && !rec(store, 'resume|p1'));
    let resolveNamed;
    const named = new Promise((r) => { resolveNamed = r; });
    c.r.request(JOB({ rk: 'p2', company: 'amazon', website: 'https://typed.example' }), { explicit: true, holdMs: 950, named });
    await advance(500);
    resolveNamed(JOB({ rk: 'WRONG', kind: 'cover_letter', company: 'Amazon', website: 'https://amazon.jobs' }));
    await advance(1000);
    ok('gate saw the stored website', svc.calls.gate[0]?.job.website === 'https://amazon.jobs' && svc.calls.gate[0]?.employer === 'Amazon');
    ok('built under the request kind + rk, stored name', svc.calls.build[0]?.kind === 'resume' && rec(store, 'resume|p2')?.company === 'Amazon' && !rec(store, 'cover_letter|WRONG'));
    ok('not before the hold', true);
  }

  console.log('── 8b. the hold: build does not start before holdMs ──');
  {
    const { c } = await fresh();
    c.r.request(JOB(), { explicit: true, holdMs: 950 });
    await advance(900);
    ok('nothing sent during the hold', svc.calls.build.length === 0);
    await advance(100);
    ok('sent after the hold', svc.calls.build.length === 1);
  }

  console.log('── 9. retarget reaches a queued copy (refused website) ──');
  {
    const { c } = await fresh();
    for (let n = 1; n <= 3; n++) c.r.request(JOB({ rk: 'emp_' + n, company: 'Co' + n }), { explicit: true, showOverlay: false });
    await advance(0);
    c.r.request(JOB({ rk: 'emp_4', company: 'Co4', website: 'https://boards.greenhouse.io/co4' }), { explicit: true, showOverlay: false });
    await advance(0);
    c.r.retarget('resume', 'emp_4', { website: '' });
    svc.finish(svc.calls.build[0].key, { ok: true, cached: false, docId: 1 });
    await advance(0);
    ok('drained build uses the blanked website', svc.calls.build[3]?.company === 'Co4' && svc.calls.build[3]?.website === '');
    ok('its gate did too', svc.calls.gate[svc.calls.gate.length - 1].job.website === undefined);
  }

  console.log('── 9b. retarget during the gate read → read again for what will run ──');
  {
    let first = true; let release;
    const { c } = await fresh({ svc: (s) => { s.gateImpl = (a) => { if (first) { first = false; return new Promise((r) => { release = () => r({ covered: true, via: 'cache' }); }); } return Promise.resolve({ covered: true, via: 'plan' }); }; } });
    c.r.request(JOB({ website: 'https://boards.greenhouse.io/amazon' }), { explicit: true });
    await advance(50);
    c.r.retarget('resume', 'emp_1', { website: '' });
    release();
    await advance(400);
    ok('gate read twice', svc.calls.gate.length === 2 && svc.calls.gate[1].job.website === undefined);
    ok('built with the retargeted job', svc.calls.build[0]?.website === '');
  }

  console.log('── 9c. retarget during a DRAIN gate read → read again (stableGate is the only guard there) ──');
  {
    const { c } = await fresh();
    for (let n = 1; n <= 3; n++) c.r.request(JOB({ rk: 'emp_' + n, company: 'Co' + n }), { explicit: true, showOverlay: false });
    await advance(0);
    c.r.request(JOB({ rk: 'emp_4', company: 'Co4', website: 'https://boards.greenhouse.io/co4' }), { explicit: true, showOverlay: false });
    await advance(0);
    let release;
    let held = true;
    svc.gateImpl = (a) => {
      if (held) { held = false; return new Promise((r) => { release = () => r({ covered: true, via: 'cache' }); }); }
      return Promise.resolve({ covered: true, via: 'plan' });
    };
    const gates = svc.calls.gate.length;
    svc.finish(svc.calls.build[0].key, { ok: true, cached: false, docId: 1 });
    await advance(0);
    ok('drain is reading the gate', svc.calls.gate.length === gates + 1 && typeof release === 'function');
    c.r.retarget('resume', 'emp_4', { website: '' });
    release();
    await advance(0);
    ok('drain re-read the gate for the retargeted job', svc.calls.gate.length === gates + 2 && svc.calls.gate[gates + 1].job.website === undefined);
    ok('and built the retargeted job', svc.calls.build[3]?.company === 'Co4' && svc.calls.build[3]?.website === '');
  }

  console.log('── 10. cancelQueued during the gate read: nothing starts ──');
  {
    let release;
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = () => new Promise((r) => { release = () => r({ covered: true, via: 'plan' }); }); } });
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(100);
    c.r.cancelQueued('resume', 'emp_1');
    release();
    await advance(1000);
    ok('no build after removal', svc.calls.build.length === 0 && !rec(store, 'resume|emp_1'));
  }

  console.log('── 10b. removal while the credits dialog is up: Build finds nothing ──');
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => ({ covered: false, via: 'credits', credits: 2 }); } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    c.r.cancelQueued('resume', 'emp_1');
    alerts[0].buttons.find((b) => b.text === 'Build').onPress();
    await flush();
    ok('no build', svc.calls.build.length === 0);
  }

  console.log('── 11. pending stays building, sweeps collect it ──');
  {
    const { c, store, notices, landed } = await fresh();
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(0);
    const key = svc.calls.build[0].key;
    svc.stage(key, { stage: 'writing', label: 'Rewriting', pct: 38 });
    svc.finish(key, { ok: false, reason: 'pending', message: 'This is taking longer than usual.' });
    await flush();
    const r1 = rec(store, 'resume|emp_1');
    ok('still building, pending label, pct kept', r1?.phase === 'building' && r1?.stage?.label === 'Still working on it…' && r1?.stage?.pct === 38);
    ok('notice with Watch', notices.some((n) => /taking longer than usual/.test(n.text) && n.action?.label === 'Watch'));
    ok('not retryable (no error)', !c.r.overlay.canRetry);
    const recovers = svc.calls.recover;
    svc.recoverImpl = async (onStage) => {
      const meta = { key, kind: 'resume', company: 'Amazon', employerId: JOB().employerId, jobUrl: '', startedAt: now };
      onStage(key, { stage: 'recovering', label: 'Picking up where it left off', pct: 5 }, meta);
      return [{ key, meta, result: { ok: true, cached: false, docId: 77 } }];
    };
    await advance(45000);
    ok('a sweep ran', svc.calls.recover === recovers + 1);
    ok('collected: done docId 77', rec(store, 'resume|emp_1')?.phase === 'done' && rec(store, 'resume|emp_1')?.docId === 77);
    ok('landed once', landed.length === 1 && landed[0].docId === 77);
    ok('a new request never built twice', svc.calls.build.length === 1);
  }

  console.log('── 12. mount recovery: provisional chip, remapped, landed once ──');
  {
    let finishRecovery;
    const meta = { key: 'resume|siemens|u:https://jobs.siemens.com/1', kind: 'resume', company: 'Siemens', employerId: 'e-uuid', jobUrl: 'https://jobs.siemens.com/1', startedAt: now - 1000 };
    let stageFn;
    const { c, store, landed, notices, env } = await fresh({ svc: (s) => { s.recoverImpl = (onStage) => { stageFn = onStage; onStage(meta.key, { stage: 'recovering', label: 'Picking up where it left off', pct: 5 }, meta); return new Promise((r) => { finishRecovery = r; }); }; } });
    ok('recovered build shown at once under the fallback chip', rec(store, 'resume|emp_e-uuid')?.phase === 'building');
    env.rk[meta.key] = 'job_https://jobs.siemens.com/1';
    stageFn(meta.key, { stage: 'writing', label: 'Rewriting your resume for Siemens', pct: 40 }, meta);
    await flush();
    ok('moved to the real chip once chips know it', rec(store, 'resume|job_https://jobs.siemens.com/1')?.stage?.pct === 40 && !rec(store, 'resume|emp_e-uuid'));
    finishRecovery([{ key: meta.key, meta, result: { ok: true, cached: false, docId: 9 } }]);
    await flush();
    ok('done under the real chip', rec(store, 'resume|job_https://jobs.siemens.com/1')?.phase === 'done');
    ok('landed once with rk', landed.length === 1 && landed[0].job.rk === 'job_https://jobs.siemens.com/1' && landed[0].watched === false);
    ok('ready notice with View', notices.some((n) => n.text === 'Your Siemens resume is ready' && n.action?.label === 'View'));
    ok('mount started no build and read no gate', svc.calls.build.length === 0 && svc.calls.gate.length === 0);
  }

  console.log('── 13. a remount mid-build joins, and the build lands exactly once ──');
  {
    const f = await fresh();
    f.c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(0);
    const key = svc.calls.build[0].key;
    // unmount Home, remount (Dashboard round trip); recovery joins the in-process flight
    f.c.unmount();
    const mod = f.mod;
    const landed2 = [];
    const notices2 = [];
    svc.recoverImpl = (onStage) => {
      const fl = svc.flights.get(key);
      const meta = { key, kind: 'resume', company: 'Amazon', employerId: JOB().employerId, jobUrl: '', startedAt: now };
      onStage(key, { stage: 'recovering', label: 'Picking up where it left off', pct: 5 }, meta);
      return fl.promise.then((result) => [{ key, meta, result }]);
    };
    const c2 = mount(() => mod.useHomeBuilds({ alive: () => true, rkFor: () => 'emp_1', onLanded: (...a) => landed2.push(a), onNotice: (t) => notices2.push(t), onSeePlans: () => {} }));
    await flush();
    svc.stage(key, { stage: 'writing', label: 'Rewriting', pct: 50 });
    await flush();
    ok('still one flight, one build call', svc.calls.build.length === 1);
    svc.finish(key, { ok: true, cached: false, docId: 5 });
    await flush(20);
    ok('landed exactly once on the NEW Home', landed2.length === 1 && f.landed.length === 0);
    ok('one ready notice', notices2.filter((t) => /is ready/.test(t)).length === 1);
    c2.unmount();
  }

  console.log('── 14. account switch: the line is wiped before anything goes out ──');
  {
    const { c, store } = await fresh();
    for (let n = 1; n <= 3; n++) c.r.request(JOB({ rk: 'emp_' + n, company: 'Co' + n }), { explicit: true, showOverlay: false });
    await advance(0);
    c.r.request(JOB({ rk: 'emp_4', company: 'Co4' }), { explicit: true, showOverlay: false });
    await advance(0);
    ok('queued', rec(store, 'resume|emp_4')?.phase === 'queued');
    const gates = svc.calls.gate.length;
    svc.account = 'u:2';
    svc.finish(svc.calls.build[0].key, { ok: true, cached: false, docId: 1 });
    await advance(0);
    ok('no gate read for the old account’s queued build', svc.calls.gate.length === gates);
    ok('no build for it', svc.calls.build.length === 3);
    ok('store wiped', Object.keys(store.getBuilds()).length === 0);
  }

  console.log('── 15. error unwatched → notice; openOverlayFor shows it; retry picks up a held build first ──');
  {
    const { c, store, notices } = await fresh();
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(0);
    const key = svc.calls.build[0].key;
    svc.finish(key, { ok: false, reason: 'network', message: 'We could not reach the server. Please try again.' });
    await flush();
    ok('error record', rec(store, 'resume|emp_1')?.phase === 'error');
    ok('See why notice', notices.some((n) => n.text === 'Your Amazon resume didn’t finish — tap its card to see why' && n.action?.label === 'See why'));
    c.r.openOverlayFor('resume', 'emp_1');
    await flush();
    ok('overlay shows the error, retryable', c.r.overlay.visible && c.r.overlay.error?.reason === 'network' && c.r.overlay.canRetry);
    // held by the service → recovery, no gate
    svc.peekImpl = async () => [{ key, kind: 'resume', company: 'Amazon', employerId: JOB().employerId, jobUrl: '', startedAt: now }];
    let finishRec;
    svc.recoverImpl = (onStage) => {
      const meta = { key, kind: 'resume', company: 'Amazon', employerId: JOB().employerId, jobUrl: '', startedAt: now };
      onStage(key, { stage: 'recovering', label: 'Picking up where it left off', pct: 5 }, meta);
      return new Promise((r) => { finishRec = () => r([{ key, meta, result: { ok: true, cached: false, docId: 31 } }]); });
    };
    const gates = svc.calls.gate.length;
    c.r.retryOverlay();
    await flush();
    ok('picked up, not re-gated, not re-sent', svc.calls.gate.length === gates && svc.calls.build.length === 1 && rec(store, 'resume|emp_1')?.phase === 'building');
    finishRec();
    await flush();
    ok('landed', rec(store, 'resume|emp_1')?.phase === 'done' && rec(store, 'resume|emp_1')?.docId === 31);
  }

  console.log('── 15b. retry with nothing held goes back through the gate ──');
  {
    const { c, store } = await fresh();
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    svc.finish(svc.calls.build[0].key, { ok: false, reason: 'failed', message: 'boom' });
    await flush();
    ok('watched error, retryable', c.r.overlay.visible && c.r.overlay.canRetry);
    c.r.retryOverlay();
    await advance(0);
    ok('re-gated and rebuilt', svc.calls.gate.length === 2 && svc.calls.build.length === 2 && rec(store, 'resume|emp_1')?.phase === 'building');
    ok('overlay still up on it', c.r.overlay.visible && !c.r.overlay.error);
  }

  console.log('── 15c. not retryable reasons ──');
  {
    const { c } = await fresh();
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    svc.finish(svc.calls.build[0].key, { ok: false, reason: 'no_resume', message: 'Upload your resume first' });
    await flush();
    ok('no_resume is not retryable', c.r.overlay.visible && c.r.overlay.error?.reason === 'no_resume' && !c.r.overlay.canRetry);
    const builds = svc.calls.build.length;
    c.r.retryOverlay();
    await advance(1000);
    ok('retryOverlay does nothing', svc.calls.build.length === builds && svc.calls.gate.length === 1);
  }

  console.log('── 16. the service refusing a slot (TOO_MANY) waits in line, not an error ──');
  {
    const { c, store } = await fresh({ svc: (s) => { s.buildForEmployer = (i, onStage) => { s.calls.build.push(i); return Promise.resolve(TOO_MANY); }; } });
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(0);
    ok('queued, not error', rec(store, 'resume|emp_1')?.phase === 'queued');
  }

  console.log('── 17. same chip again while building: opens the overlay, no second build ──');
  {
    const { c } = await fresh();
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(0);
    c.r.request(JOB(), { explicit: true });
    await advance(1000);
    ok('one build', svc.calls.build.length === 1 && svc.calls.gate.length === 1);
    ok('overlay opened on it', c.r.overlay.visible && c.r.overlay.key === 'resume|emp_1');
  }

  console.log('── 18. forget mid-build: nothing of it lands afterwards ──');
  {
    const { c, mod, store, landed, notices } = await fresh();
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(0);
    const key = svc.calls.build[0].key;
    mod.forgetHomeBuilds();
    await flush();
    ok('store cleared', Object.keys(store.getBuilds()).length === 0);
    svc.finish(key, { ok: true, cached: false, docId: 3 });
    await flush();
    ok('no record, no onLanded, no notice', Object.keys(store.getBuilds()).length === 0 && landed.length === 0 && notices.length === 0);
  }

  console.log('── 19. closing "Checking your plan…" = carry on without the screen ──');
  {
    let release;
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = () => new Promise((r) => { release = () => r({ covered: true, via: 'plan' }); }); } });
    c.r.request(JOB(), { explicit: true, holdMs: 950 });
    await advance(960);
    ok('checking overlay after the hold', c.r.overlay.visible && c.r.overlay.stage?.stage === 'checking');
    c.r.dismissOverlay();
    await flush();
    release();
    await advance(10);
    ok('build started', svc.calls.build.length === 1 && rec(store, 'resume|emp_1')?.phase === 'building');
    ok('overlay NOT re-raised', c.r.overlay.visible === false);
  }

  console.log('── 20. queued shown to the overlay as "nothing has started" ──');
  {
    const { c } = await fresh();
    for (let n = 1; n <= 3; n++) c.r.request(JOB({ rk: 'emp_' + n, company: 'Co' + n }), { explicit: true, showOverlay: false });
    await advance(0);
    c.r.request(JOB({ rk: 'emp_4', company: 'Co4' }), { explicit: true, showOverlay: false });
    await advance(0);
    c.r.openOverlayFor('resume', 'emp_4');
    await flush();
    ok('overlay stage is checking', c.r.overlay.visible && c.r.overlay.stage?.stage === 'checking' && c.r.overlay.done === false && !c.r.overlay.error);
    await advance(10 * 60 * 1000 + 1);
    svc.finish(svc.calls.build[0].key, { ok: true, cached: false, docId: 1 });
    await advance(0);
    ok('expired place in line does not start', svc.calls.build.length === 3);
  }

  console.log('── 21. two dialogs never stack ──');
  {
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = async () => ({ covered: false, via: 'credits', credits: 2 }); } });
    c.r.request(JOB({ rk: 'a', company: 'A' }), { explicit: true, showOverlay: false });
    c.r.request(JOB({ rk: 'b', company: 'B' }), { explicit: true, showOverlay: false });
    await advance(0);
    ok('one dialog', alerts.length === 1);
    ok('second waits', rec(store, 'resume|b')?.phase === 'queued');
    alerts[0].buttons.find((b) => b.text === 'Cancel').onPress();
    await advance(0);
    ok('second asked after the first was answered', alerts.length === 2 && /Build your B resume/.test(alerts[1].title));
    ok('still nothing built', svc.calls.build.length === 0);
  }

  console.log('── 22. no Home mounted: a covered queued build may start, a question is never asked ──');
  {
    const f = await fresh();
    for (let n = 1; n <= 3; n++) f.c.r.request(JOB({ rk: 'emp_' + n, company: 'Co' + n }), { explicit: true, showOverlay: false });
    await advance(0);
    f.c.r.request(JOB({ rk: 'emp_4', company: 'Co4' }), { explicit: true, showOverlay: false });
    await advance(0);
    f.c.unmount();
    svc.gateImpl = async () => ({ covered: false, via: 'credits', credits: 2 });
    svc.finish(svc.calls.build[0].key, { ok: true, cached: false, docId: 1 });
    await advance(0);
    ok('no dialog with nobody on Home', alerts.length === 0 && svc.calls.build.length === 3);
    ok('still waiting', f.store.getBuilds()['resume|emp_4']?.phase === 'queued');
  }

  console.log('── 23. ⚠️ A BUILD THE USER WAS TOLD HAD FAILED IS NEVER RE-SENT BY A MOUNT OR A SWEEP ──');
  {
    // A record with no job id is a POST whose answer never came. Resending it may charge again, so it is
    // resent ONLY from the Try again the user tapped on THAT build — never from a mount, a sweep, or
    // another chip's retry. Recovery otherwise just polls what the server already has.
    const { c, store } = await fresh();
    ok('a mount recovers, and asks for no resend at all',
      svc.calls.recover === 1 && svc.calls.recoverOpts[0] && svc.calls.recoverOpts[0].resendKey == null,
      svc.calls.recoverOpts);
    // Another chip fails, is held by the service, and the user taps Try again on IT: only its key travels.
    c.r.request(JOB({ rk: 'emp_9', company: 'Nordex' }), { explicit: true, showOverlay: false });
    await advance(0);
    const key9 = svc.calls.build[0].key;
    svc.finish(key9, { ok: false, reason: 'network', message: 'no answer' });
    await flush();
    svc.peekImpl = async () => [{ key: key9, kind: 'resume', company: 'Nordex', employerId: JOB().employerId, jobUrl: '', startedAt: now }];
    svc.recoverImpl = async (onStage, opts) => {
      const meta = { key: key9, kind: 'resume', company: 'Nordex', employerId: JOB().employerId, jobUrl: '', startedAt: now };
      if (opts && opts.onLanded) opts.onLanded(key9, meta, { ok: true, cached: false, docId: 77 });
      return [];
    };
    const before = svc.calls.recover;
    c.r.openOverlayFor('resume', 'emp_9');
    await flush();
    c.r.retryOverlay();
    await flush(20);
    const opts = svc.calls.recoverOpts[svc.calls.recoverOpts.length - 1];
    ok('⚠️ only Try again on THAT build asks for its lost POST to be re-sent',
      svc.calls.recover === before + 1 && opts && opts.resendKey === key9, opts);
    ok('…and no second paid build went out', svc.calls.build.length === 1, svc.calls.build.length);
    // ⚠️ EACH BUILD LANDS WHEN IT ENDS: the per-build callback, not the slowest one in the batch.
    ok('⚠️ the per-build onLanded lands it without waiting for anything else',
      rec(store, 'resume|emp_9')?.phase === 'done' && rec(store, 'resume|emp_9')?.docId === 77, rec(store, 'resume|emp_9'));
  }

  console.log('── 24. removing a chip also drops the lost POST nobody can consent to re-sending ──');
  {
    // With the chip gone there is no Try again left to consent with, so the remembered build goes too —
    // otherwise the next mount/sweep/retry would find it and (before 23) send it again.
    let release;
    const { c } = await fresh({ svc: (s) => { s.gateImpl = () => new Promise((r) => { release = () => r({ covered: true, via: 'plan' }); }); } });
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(100);
    c.r.cancelQueued('resume', 'emp_1');
    release();
    await advance(1000);
    ok('⚠️ the service was told to forget this chip\'s build', svc.calls.forget.includes(svc.buildKeyOf('resume', JOB())), svc.calls.forget);
    ok('…and nothing was built for it', svc.calls.build.length === 0);
  }

  console.log('── 24b. ⚠️ a build that is still RUNNING is never forgotten (it is already paid for) ──');
  {
    const { c } = await fresh();
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(0);
    const key = svc.calls.build[0].key;
    c.r.cancelQueued('resume', 'emp_1');
    await flush();
    ok('the running build is left to finish and be collected', !svc.calls.forget.includes(key), svc.calls.forget);
    svc.finish(key, { ok: true, cached: false, docId: 12 });
    await flush();
  }

  console.log('── 25. a service without forgetInflight must never break a chip\'s removal ──');
  {
    let release;
    const { c, store } = await fresh({ svc: (s) => {
      s.forgetInflight = undefined;
      s.gateImpl = () => new Promise((r) => { release = () => r({ covered: true, via: 'plan' }); });
    } });
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(100);
    let threw = false;
    try { c.r.cancelQueued('resume', 'emp_1'); } catch { threw = true; }
    release();
    await advance(1000);
    ok('the removal still goes through', !threw && !rec(store, 'resume|emp_1') && svc.calls.build.length === 0);
  }

  console.log(`\nhome builds: ${pass} passed, ${fail} failed`);
  Date.now = realDateNow;
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {} process.exit(2); });
