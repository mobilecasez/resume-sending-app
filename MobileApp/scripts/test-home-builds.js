// Home's build orchestration (components/employer-home/useHomeBuilds.ts) — behavioural tests.
// Transpiles the hook and the REAL services/homeBuilds.ts store, mocks the build service / Alert / haptics /
// analytics, and runs the hook inside a tiny fake React hooks runtime under a fake clock.
//   node MobileApp/scripts/test-home-builds.js
//
// ⚠️ WHY: this hook decides when money is spent. A build starts only from an explicit request; ⚠️ SINCE 2026-09-14 a
// covered gate (plan / free / pass) no longer starts it: the confirm sheet (GenerateConfirmSheet) asks first, and only
// its Continue sends the build, coveredOnly:true — a cache hit (free) is the one answer that starts without a question;
// nothing left opens the EMPTY sheet, whose Generate once buys the one-time pass for THIS employer
// (buyDownloadPass(company)), reads the gate again and builds only on via 'pass' (or a free cache hit); an unreadable gate asks first (and its Build tap is the only consent
// coveredOnly:false ever gets); a gate that still says 'credits' asks in plan words and is built coveredOnly:true
// (no credits lane exists for generation since 2026-09-13); a quota refusal builds nothing; a recovered build lands exactly once;
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
// The one-time pass purchase (services/downloadPassService.buyDownloadPass): every call recorded with the employer it
// was bought for; buyImpl decides the store's answer. plans = how many times the sheet's See plans reached the screen.
let buys = []; let buyImpl = async () => ({ ok: true, employerUnlocked: true }); let plans = 0;
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
  if (request === '../../services/downloadPassService') return { buyDownloadPass: (employer) => { buys.push(employer); return buyImpl(employer); } };
  if (request === '../../services/analytics') return { track: async (e, p) => { tracked.push([e, p]); } };
  return origLoad.apply(this, arguments);
};

/* ── scenario plumbing ── */
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

async function fresh(o = {}) {
  delete require.cache[HOOK]; delete require.cache[STORE];
  for (const id of timers.keys()) timers.delete(id);
  svc = makeSvc(); alerts = []; tracked = []; haptics = 0; buys = []; plans = 0; buyImpl = async () => ({ ok: true, employerUnlocked: true });
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
    onSeePlans: () => { plans++; },
  };
  const c = mount(() => mod.useHomeBuilds(opts));
  await flush();
  return { mod, store, c, landed, notices, env };
}
const JOB = (over = {}) => ({ kind: 'resume', rk: 'emp_1', company: 'Amazon', website: 'https://amazon.jobs', employerId: '11111111-1111-1111-1111-111111111111', country: 'India', jobUrl: '', jobText: '', jobTitle: '', ...over });
const rec = (store, key) => store.getBuilds()[key] || null;

/**
 * ⚠️ THE MODAL GAP (useHomeBuilds MODAL_GAP_MS): the sheet and BuildingOverlay are two Modals, and whichever comes
 * second waits this long after the first went away (iOS refuses a second presentation silently). Pinned here: a
 * shorter gap is the invisible-question bug again.
 */
const GAP = 380;
/** Answer the confirm sheet with Continue once it is up. `label` also asserts it WAS up, in confirm mode. */
async function tapContinue(c, label) {
  await advance(GAP);
  const v = c.r.confirm;
  if (label) ok(label, v.visible && v.mode === 'confirm', { visible: v.visible, mode: v.mode, company: v.company });
  v.onContinue();
  await flush();
}
/** Three builds running, each started the only way a plan build now starts: its own sheet, its own Continue. */
async function startThree(c) {
  for (let n = 1; n <= 3; n++) {
    c.r.request(JOB({ rk: 'emp_' + n, company: 'Co' + n }), { explicit: true, showOverlay: false });
    await advance(0);
    await tapContinue(c);
  }
}

(async () => {
  // ⚠️ RETARGETED 2026-09-14: a covered gate used to start the build at once. Now the confirm sheet asks first, and
  // the build (and its overlay, after the Modal gap) starts only on Continue.
  console.log('── 1. covered + watched: the sheet asks first; Continue runs coveredOnly, lands docId, overlay done, record clears ──');
  {
    const { c, store, landed, notices } = await fresh();
    c.r.request(JOB(), { explicit: true });
    ok('checking record at once', rec(store, 'resume|emp_1')?.phase === 'checking');
    await advance(0);
    ok('gate asked once for the doc lane shape', svc.calls.gate.length === 1 && svc.calls.gate[0].kind === 'resume'
      && svc.calls.gate[0].extra.employerId === JOB().employerId && svc.calls.gate[0].job.website === 'https://amazon.jobs');
    ok('⚠️ a covered gate does NOT auto-start: nothing built, the confirm sheet asks', svc.calls.build.length === 0
      && c.r.confirm.visible && c.r.confirm.mode === 'confirm' && c.r.confirm.company === 'Amazon' && c.r.confirm.kind === 'resume', c.r.confirm);
    ok('…the record still says checking, and no overlay covers the sheet', rec(store, 'resume|emp_1')?.phase === 'checking' && !c.r.overlay.visible);
    await advance(5000);
    ok('⚠️ …and waiting builds nothing either', svc.calls.build.length === 0 && c.r.confirm.visible);
    c.r.confirm.onContinue();
    await flush();
    ok('Continue → build started coveredOnly:true', svc.calls.build.length === 1 && svc.calls.build[0].coveredOnly === true && svc.calls.build[0].country === 'India');
    ok('record is building, sheet closed', rec(store, 'resume|emp_1')?.phase === 'building' && !c.r.confirm.visible);
    ok('the overlay is held back for the Modal gap', !c.r.overlay.visible);
    await advance(GAP);
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

  // ⚠️ RETARGETED 2026-09-14. This used to pin "This uses 2 credits." and a Build that sent coveredOnly:false —
  // consent to a credit charge. Since 2026-09-13 generation has no credits lane at all, so that dialog was consent
  // to something that cannot happen. A gate that still answers 'credits' (an older or misconfigured server) now
  // gets the plan-words question, and its Build goes out coveredOnly:TRUE: the server may use plan, free
  // allowance, pass or cache, and otherwise refuses into the plans state. Nothing on Home can agree to credits.
  const noCreditWords = (a) => !!a && !/credit/i.test(String(a.title)) && !/credit/i.test(String(a.msg)) && (a.buttons || []).every((b) => !/credit/i.test(b.text));
  console.log('── 3. a gate that still says credits: plan-words Alert first; Not now clears; Build is COVERED-ONLY ──');
  {
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = async () => ({ covered: false, via: 'credits', credits: 2 }); } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    ok('an Alert, no build', alerts.length === 1 && svc.calls.build.length === 0);
    ok('⚠️ the Alert names the plan, never a credit price',
      alerts[0].title === 'Build your Amazon resume?' && /could not check your plan/.test(alerts[0].msg) && noCreditWords(alerts[0]), alerts[0] && { t: alerts[0].title, m: alerts[0].msg });
    ok('Not now / Try again / Build', alerts[0].buttons.map((b) => b.text).join(',') === 'Not now,Try again,Build');
    alerts[0].buttons.find((b) => b.text === 'Not now').onPress();
    await flush();
    ok('Not now clears the record, builds nothing', !rec(store, 'resume|emp_1') && svc.calls.build.length === 0);
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    ok('asked again', alerts.length === 2);
    alerts[1].buttons.find((b) => b.text === 'Build').onPress();
    await flush();
    ok('⚠️ Build → coveredOnly:TRUE (never consent to a credit charge)', svc.calls.build.length === 1 && svc.calls.build[0].coveredOnly === true, svc.calls.build.map((b) => b.coveredOnly));
    alerts[1].buttons.find((b) => b.text === 'Build').onPress();
    await flush();
    ok('a double tap builds once', svc.calls.build.length === 1);
    const gates = svc.calls.gate.length;
    c.r.request(JOB({ rk: 'emp_2', company: 'Bolt' }), { explicit: true });
    await advance(0);
    alerts[2].buttons.find((b) => b.text === 'Try again').onPress();
    await advance(0);
    ok('Try again reads the gate again (and asks again), building nothing', svc.calls.gate.length === gates + 2 && alerts.length === 4 && svc.calls.build.length === 1);
  }

  console.log('── 3b. letter copy: plan words too ──');
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => ({ covered: false, via: 'credits', credits: 1 }); } });
    c.r.request(JOB({ kind: 'cover_letter' }), { explicit: true });
    await advance(0);
    ok('letter Alert', alerts[0]?.title === 'Build your Amazon cover letter?' && /write this letter now from your plan/.test(alerts[0]?.msg) && noCreditWords(alerts[0]), alerts[0] && alerts[0].msg);
    alerts[0].buttons.find((b) => b.text === 'Build').onPress();
    await flush();
    ok('⚠️ …and its Build is covered-only as well', svc.calls.build.length === 1 && svc.calls.build[0].coveredOnly === true && svc.calls.build[0].kind === 'cover_letter');
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
    ok('asked, not built — in plan words', alerts.length === 1 && svc.calls.build.length === 0 && /could not check your plan/.test(alerts[0].msg) && noCreditWords(alerts[0]), alerts[0] && alerts[0].msg);
    ok('Not now / Try again / Build', alerts[0].buttons.map((b) => b.text).join(',') === 'Not now,Try again,Build');
    alerts[0].buttons.find((b) => b.text === 'Build').onPress();
    await flush();
    ok('Build → coveredOnly:false', svc.calls.build[0]?.coveredOnly === false);
    ok('record building', rec(store, 'resume|emp_1')?.phase === 'building');
  }

  // ⚠️ RETARGETED 2026-09-14: quota_exhausted used to be an overlay refusal. It is now the EMPTY confirm sheet (Generate
  // once / See plans — see C5..C10, C16); regen_limit (the builder's one free rebuild) is still the overlay refusal.
  console.log('── 5. quota: the EMPTY sheet, no build, nothing bought; regen_limit stays the overlay refusal ──');
  {
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = async () => ({ covered: false, via: null, reason: 'quota_exhausted' }); } });
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(0);
    ok('the empty sheet asks, even with showOverlay:false', c.r.confirm.visible && c.r.confirm.mode === 'empty' && c.r.confirm.company === 'Amazon', c.r.confirm);
    ok('no error record, no overlay: nothing refused yet, nothing started', rec(store, 'resume|emp_1')?.phase === 'checking' && !c.r.overlay.visible);
    ok('no build, nothing bought', svc.calls.build.length === 0 && buys.length === 0);
    c.r.confirm.onCancel();
    await flush();
    ok('Cancel clears the record and closes the sheet', !rec(store, 'resume|emp_1') && !c.r.confirm.visible && buys.length === 0);
  }
  {
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = async () => ({ covered: false, via: null, reason: 'regen_limit' }); } });
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(0);
    ok('regen_limit: error record', rec(store, 'resume|emp_1')?.phase === 'error' && rec(store, 'resume|emp_1')?.error?.reason === 'regen_limit');
    ok('…overlay error visible even with showOverlay:false, no sheet', c.r.overlay.visible && c.r.overlay.error?.reason === 'regen_limit' && !c.r.overlay.canRetry && !c.r.confirm.visible);
    ok('…no build', svc.calls.build.length === 0);
    c.r.dismissOverlay();
    await flush();
    ok('…refusal record clears on dismiss', !rec(store, 'resume|emp_1'));
  }

  console.log('── 6. capacity: a Continued 4th waits, re-gated when a slot frees, starts on the pool it was confirmed for ──');
  {
    const { c, store, notices } = await fresh();
    await startThree(c);
    ok('three running', svc.flights.size === 3);
    c.r.request(JOB({ rk: 'emp_4', company: 'Co4' }), { explicit: true, showOverlay: false });
    await advance(0);
    await tapContinue(c, 'the 4th is asked on the sheet even with three running');
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
    ok('…on its earlier Continue: no second question', !c.r.confirm.visible);
    ok('4th building', rec(store, 'resume|emp_4')?.phase === 'building');
  }

  // ⚠️ RETARGETED 2026-09-14: there is no credit price to consent to, so no "same number / bigger number" either.
  // What a queued build may carry is only the unread gate's "go ahead" — and it never covers a credits answer.
  console.log('── 7. capacity + consent: an unread gate\'s go-ahead carries to a still-unread gate; a credits answer never rides one ──');
  {
    const { c, store } = await fresh();
    await startThree(c);
    svc.gateImpl = () => new Promise(() => {});                      // unreadable
    c.r.request(JOB({ rk: 'emp_4', company: 'Co4' }), { explicit: true, showOverlay: false });
    await advance(9000);
    ok('the unread gate asks', alerts.length === 1 && /could not check your plan/.test(alerts[0].msg));
    alerts[0].buttons.find((b) => b.text === 'Build').onPress();
    await flush();
    ok('consented but full → queued', rec(store, 'resume|emp_4')?.phase === 'queued' && svc.calls.build.length === 3);
    svc.finish(svc.calls.build[0].key, { ok: true, cached: false, docId: 1 });
    await advance(9000);
    ok('still unread on drain → starts without a second dialog, coveredOnly:false', alerts.length === 1 && svc.calls.build.length === 4 && svc.calls.build[3].coveredOnly === false,
      { alerts: alerts.length, builds: svc.calls.build.map((b) => b.coveredOnly) });
    // the same kind of go-ahead, but the re-read gate now says credits
    c.r.request(JOB({ rk: 'emp_5', company: 'Co5' }), { explicit: true, showOverlay: false });
    await advance(9000);
    ok('dialog for Co5', alerts.length === 2);
    alerts[1].buttons.find((b) => b.text === 'Build').onPress();
    await flush();
    ok('Co5 queued', rec(store, 'resume|emp_5')?.phase === 'queued');
    svc.gateImpl = async () => ({ covered: false, via: 'credits', credits: 5 });
    svc.finish(svc.calls.build[1].key, { ok: true, cached: false, docId: 2 });
    await advance(0);
    ok('⚠️ a credits answer is asked again (plan words), never run on the older go-ahead', alerts.length === 3 && svc.calls.build.length === 4 && noCreditWords(alerts[2]), { alerts: alerts.length, builds: svc.calls.build.length });
    alerts[2].buttons.find((b) => b.text === 'Build').onPress();
    await flush();
    ok('⚠️ …and its Build starts covered-only', svc.calls.build.length === 5 && svc.calls.build[4].company === 'Co5' && svc.calls.build[4].coveredOnly === true, svc.calls.build.map((b) => b.coveredOnly));
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
    ok('the sheet names the stored name, nothing built before Continue', c.r.confirm.company === 'Amazon' && svc.calls.build.length === 0, c.r.confirm.company);
    await tapContinue(c);
    ok('built under the request kind + rk, stored name', svc.calls.build[0]?.kind === 'resume' && rec(store, 'resume|p2')?.company === 'Amazon' && !rec(store, 'cover_letter|WRONG'));
    ok('not before the hold', true);
  }

  console.log('── 8b. the hold: build does not start before holdMs ──');
  {
    const { c } = await fresh();
    c.r.request(JOB(), { explicit: true, holdMs: 950 });
    await advance(900);
    ok('nothing sent (and nothing asked) during the hold', svc.calls.build.length === 0 && !c.r.confirm.visible);
    await advance(100);
    ok('after the hold the sheet asks — still nothing sent', c.r.confirm.visible && svc.calls.build.length === 0);
    c.r.confirm.onContinue();
    await flush();
    ok('sent on Continue', svc.calls.build.length === 1);
  }

  console.log('── 9. retarget reaches a queued copy (refused website) ──');
  {
    const { c } = await fresh();
    await startThree(c);
    c.r.request(JOB({ rk: 'emp_4', company: 'Co4', website: 'https://boards.greenhouse.io/co4' }), { explicit: true, showOverlay: false });
    await advance(0);
    await tapContinue(c);
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
    ok('⚠️ the stale "cache" answer started nothing: the re-read says plan, so the sheet asks', svc.calls.build.length === 0 && c.r.confirm.visible);
    c.r.confirm.onContinue();
    await flush();
    ok('built with the retargeted job', svc.calls.build[0]?.website === '');
  }

  console.log('── 9c. retarget during a DRAIN gate read → read again (stableGate is the only guard there) ──');
  {
    const { c } = await fresh();
    await startThree(c);
    c.r.request(JOB({ rk: 'emp_4', company: 'Co4', website: 'https://boards.greenhouse.io/co4' }), { explicit: true, showOverlay: false });
    await advance(0);
    await tapContinue(c);
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
    await tapContinue(c);
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
    await tapContinue(f.c);
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
    await startThree(c);
    c.r.request(JOB({ rk: 'emp_4', company: 'Co4' }), { explicit: true, showOverlay: false });
    await advance(0);
    await tapContinue(c);
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
    await tapContinue(c);
    const key = svc.calls.build[0].key;
    svc.finish(key, { ok: false, reason: 'network', message: 'We could not reach the server. Please try again.' });
    await flush();
    ok('error record', rec(store, 'resume|emp_1')?.phase === 'error');
    ok('See why notice', notices.some((n) => n.text === 'Your Amazon resume didn’t finish — tap its card to see why' && n.action?.label === 'See why'));
    c.r.openOverlayFor('resume', 'emp_1');
    await advance(GAP);
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

  // ⚠️ RETARGETED 2026-09-14: Try again used to rebuild on the re-read covered gate at once. A new build is a new spend,
  // so it is asked on the sheet like any other — the failed one charged nothing (the lanes give back what they took).
  console.log('── 15b. retry with nothing held goes back through the gate, and the sheet, before a second build ──');
  {
    const { c, store } = await fresh();
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    await tapContinue(c);
    await advance(GAP);
    svc.finish(svc.calls.build[0].key, { ok: false, reason: 'failed', message: 'boom' });
    await flush();
    ok('watched error, retryable', c.r.overlay.visible && c.r.overlay.canRetry);
    c.r.retryOverlay();
    await advance(0);
    ok('re-gated, but no second build yet: the overlay steps aside for the question', svc.calls.gate.length === 2 && svc.calls.build.length === 1 && !c.r.overlay.visible);
    await tapContinue(c, '⚠️ …the sheet asks before the rebuild');
    ok('rebuilt on Continue', svc.calls.build.length === 2 && svc.calls.build[1].coveredOnly === true && rec(store, 'resume|emp_1')?.phase === 'building');
    await advance(GAP);
    ok('overlay back up on it', c.r.overlay.visible && !c.r.overlay.error);
  }

  console.log('── 15c. not retryable reasons ──');
  {
    const { c } = await fresh();
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    await tapContinue(c);
    await advance(GAP);
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
    await tapContinue(c);
    ok('queued, not error', rec(store, 'resume|emp_1')?.phase === 'queued');
  }

  console.log('── 17. same chip again while building: opens the overlay, no second build, no second question ──');
  {
    const { c } = await fresh();
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(0);
    await tapContinue(c);
    c.r.request(JOB(), { explicit: true });
    await advance(1000);
    ok('one build', svc.calls.build.length === 1 && svc.calls.gate.length === 1);
    ok('overlay opened on it', c.r.overlay.visible && c.r.overlay.key === 'resume|emp_1' && !c.r.confirm.visible);
  }

  console.log('── 18. forget mid-build: nothing of it lands afterwards ──');
  {
    const { c, mod, store, landed, notices } = await fresh();
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(0);
    await tapContinue(c);
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
    ok('the covered answer starts nothing on its own', svc.calls.build.length === 0 && c.r.overlay.visible === false);
    await tapContinue(c, 'the sheet asks, once the closed overlay\'s Modal gap has passed');
    ok('build started on Continue', svc.calls.build.length === 1 && rec(store, 'resume|emp_1')?.phase === 'building');
    await advance(GAP);
    ok('overlay NOT re-raised', c.r.overlay.visible === false);
  }

  console.log('── 20. queued shown to the overlay as "nothing has started" ──');
  {
    const { c } = await fresh();
    await startThree(c);
    c.r.request(JOB({ rk: 'emp_4', company: 'Co4' }), { explicit: true, showOverlay: false });
    await advance(0);
    await tapContinue(c);
    c.r.openOverlayFor('resume', 'emp_4');
    await advance(GAP);
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
    alerts[0].buttons.find((b) => b.text === 'Not now').onPress();
    await advance(0);
    ok('second asked after the first was answered', alerts.length === 2 && /Build your B resume/.test(alerts[1].title));
    ok('still nothing built', svc.calls.build.length === 0);
  }

  // ⚠️ RETARGETED 2026-09-14: the old title said a covered queued build may start with no Home. Since the sheet, one
  // nobody said Continue to never starts unseen (C22); this one HAD its Continue — for the plan — so a credits answer
  // on the re-read is still a question, and with nobody on Home it keeps its place.
  console.log('── 22. no Home mounted: a question is never asked, and a Continue for the plan never covers a credits answer ──');
  {
    const f = await fresh();
    await startThree(f.c);
    f.c.r.request(JOB({ rk: 'emp_4', company: 'Co4' }), { explicit: true, showOverlay: false });
    await advance(0);
    await tapContinue(f.c);
    f.c.unmount();
    svc.gateImpl = async () => ({ covered: false, via: 'credits', credits: 2 });
    svc.finish(svc.calls.build[0].key, { ok: true, cached: false, docId: 1 });
    await advance(0);
    ok('no dialog (and no sheet) with nobody on Home', alerts.length === 0 && svc.calls.build.length === 3);
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
    await tapContinue(c);
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
    await advance(GAP);
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
    await tapContinue(c);
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

  /* ── the confirm sheet (asks D and E) ── */
  const USAGE_PLAN = { kind: 'resume', pool: 'plan', planLabel: 'Plus', remaining: 12, allowance: 15, used: 3, oneTime: false };
  const USAGE_FREE = { kind: 'resume', pool: 'free', planLabel: null, remaining: 2, allowance: 3, used: 1, oneTime: true };
  const USAGE_FREE0 = { kind: 'resume', pool: 'free', planLabel: null, remaining: 0, allowance: 3, used: 3, oneTime: true };
  const PLAN = { covered: true, via: 'plan', usage: USAGE_PLAN, pass: { available: false, forThisEmployer: false } };
  const FREE = { covered: true, via: 'free', usage: USAGE_FREE, pass: { available: true, forThisEmployer: false } };
  const QUOTA = { covered: false, via: null, reason: 'quota_exhausted', usage: USAGE_FREE0, pass: { available: false, forThisEmployer: false } };
  const PASS = { covered: true, via: 'pass', usage: USAGE_FREE0, pass: { available: true, forThisEmployer: true } };
  const CACHE = { covered: true, via: 'cache' };

  console.log('── C1. covered plan: the sheet asks, nothing builds until Continue ──');
  {
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = async () => PLAN; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    ok('no build before Continue', svc.calls.build.length === 0);
    ok('sheet visible, confirm, plan usage', c.r.confirm.visible && c.r.confirm.mode === 'confirm' && c.r.confirm.usage?.remaining === 12 && c.r.confirm.pass === null && c.r.confirm.company === 'Amazon' && c.r.confirm.kind === 'resume', c.r.confirm);
    ok('record is still checking', rec(store, 'resume|emp_1')?.phase === 'checking');
    ok('no overlay while the sheet asks', c.r.overlay.visible === false);
    c.r.confirm.onContinue();
    await flush();
    ok('Continue → one build coveredOnly:true', svc.calls.build.length === 1 && svc.calls.build[0].coveredOnly === true);
    ok('sheet closed', c.r.confirm.visible === false);
    ok('overlay held back for the modal gap', c.r.overlay.visible === false && c.r.overlay.key === 'resume|emp_1');
    await advance(380);
    ok('overlay up after the gap', c.r.overlay.visible === true && c.r.overlay.key === 'resume|emp_1');
    c.r.confirm.onContinue();
    await flush();
    ok('double Continue builds once', svc.calls.build.length === 1);
  }

  console.log('── C2. Cancel: nothing starts, the record goes, the next Add asks again ──');
  {
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = async () => FREE; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    ok('free usage shown, server pass not shown for a free answer', c.r.confirm.usage?.pool === 'free' && c.r.confirm.pass === null, c.r.confirm);
    c.r.confirm.onCancel();
    await flush();
    ok('no build, record cleared, sheet closed', svc.calls.build.length === 0 && !rec(store, 'resume|emp_1') && !c.r.confirm.visible);
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    ok('asked again after the gap', !c.r.confirm.visible);
    await advance(380);
    ok('…visible once the gap has passed', c.r.confirm.visible && svc.calls.build.length === 0);
  }

  console.log('── C3. cache hit: no sheet, builds at once ──');
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => CACHE; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    ok('built at once, no sheet', svc.calls.build.length === 1 && !c.r.confirm.visible && c.r.overlay.visible);
  }

  console.log('── C4. pass answer: confirm with the pass, no count ──');
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => PASS; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    ok('pass shown', c.r.confirm.visible && c.r.confirm.pass?.available === true && c.r.confirm.pass?.forThisEmployer === true && c.r.confirm.usage === null, c.r.confirm);
    c.r.confirm.onContinue();
    await flush();
    ok('built coveredOnly', svc.calls.build.length === 1 && svc.calls.build[0].coveredOnly === true);
  }

  // ⚠️ THE BUY-ONCE PATH (ask E): buyDownloadPass(company) → re-read the gate → run ONLY on via 'pass' (or a free cache hit).
  // A gate that still refuses (C8), or now says plan/free (C9, C10), starts nothing: nobody said Continue to THAT.
  console.log('── C5. quota: the empty sheet; Generate once buys, reads the gate, builds with the pass ──');
  {
    let n = 0;
    const { c, store, notices } = await fresh({ svc: (s) => { s.gateImpl = async () => (n++ < 2 ? QUOTA : PASS); } });
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(0);
    ok('empty sheet, usage the one that ran out, no pass', c.r.confirm.visible && c.r.confirm.mode === 'empty' && c.r.confirm.usage?.remaining === 0 && c.r.confirm.pass === null, c.r.confirm);
    ok('no refusal record: still checking', rec(store, 'resume|emp_1')?.phase === 'checking');
    let release; buyImpl = () => new Promise((r) => { release = r; });
    c.r.confirm.onBuyOnce();
    await flush();
    ok('busy while buying', c.r.confirm.busy === true && buys.length === 1 && buys[0] === 'Amazon', { busy: c.r.confirm.busy, buys });
    c.r.confirm.onCancel();
    c.r.confirm.onBuyOnce();
    await flush();
    ok('cancel and a second buy are ignored while busy', c.r.confirm.visible && buys.length === 1);
    const gatesAtPurchase = svc.calls.gate.length;
    ok('⚠️ nothing built while the store sheet is out', svc.calls.build.length === 0);
    release({ ok: true, employerUnlocked: true });
    await advance(0);
    ok('⚠️ the gate is read AGAIN after the purchase (never "bought, so build")', svc.calls.gate.length > gatesAtPurchase, svc.calls.gate.length - gatesAtPurchase);
    ok('built with the pass, coveredOnly:true', svc.calls.build.length === 1 && svc.calls.build[0].coveredOnly === true, svc.calls.build.length);
    ok('…for THIS employer only: bought once, for Amazon', buys.length === 1 && buys[0] === 'Amazon', buys);
    ok('sheet closed', !c.r.confirm.visible);
    ok('no notice', notices.length === 0);
  }

  console.log('── C6. purchase cancelled: not an error, nothing built ──');
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => QUOTA; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    buyImpl = async () => ({ ok: false, cancelled: true });
    c.r.confirm.onBuyOnce();
    await advance(0);
    ok('still up, not busy, no error, nothing built', c.r.confirm.visible && !c.r.confirm.busy && c.r.confirm.error === null && svc.calls.build.length === 0, c.r.confirm);
  }

  console.log('── C7. purchase failed: the store words, one quiet read, nothing built; button stays Generate once ──');
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => QUOTA; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    buyImpl = async () => ({ ok: false, message: 'This is not on sale yet. Please try again shortly.' });
    const gates = svc.calls.gate.length;
    c.r.confirm.onBuyOnce();
    await advance(0);
    ok('error shown, not busy, no build', c.r.confirm.error === 'This is not on sale yet. Please try again shortly.' && !c.r.confirm.busy && svc.calls.build.length === 0, c.r.confirm);
    ok('pre-check + one quiet read', svc.calls.gate.length === gates + 2, svc.calls.gate.length - gates);
    ok('pass not claimed', c.r.confirm.pass === null && c.r.confirm.mode === 'empty');
  }

  console.log('── C8. bought but the gate still refuses: paidNotReady, and the next tap buys NOTHING ──');
  {
    let pay = false;
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => (pay ? PASS : QUOTA); } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    c.r.confirm.onBuyOnce();
    await advance(10000);
    ok('paidNotReady, pass.available', /payment went through/.test(String(c.r.confirm.error)) && c.r.confirm.pass?.available === true && !c.r.confirm.busy && svc.calls.build.length === 0, c.r.confirm);
    ok('bought once', buys.length === 1);
    pay = true;
    c.r.confirm.onBuyOnce();
    await advance(0);
    ok('second tap: no second purchase, builds with the pass', buys.length === 1 && svc.calls.build.length === 1 && svc.calls.build[0].coveredOnly === true, { buys: buys.length, builds: svc.calls.build.length });
  }

  // ⚠️ CONTRACT C1 (2026-09-15): the store said yes and the server has not shown the pass yet. buyDownloadPass answers
  // ok:false + paid:true (charged) or pending:true (Ask-to-Buy: charged when it clears). Both are BOUGHT to this sheet: the
  // button becomes "Use my one-time pass", a second tap re-reads the gate and buys NOTHING. It used to re-enable
  // "Generate once" on ok:false, which is how one need was paid for twice.
  console.log('── C8b. paid but not visible yet: bought, "applying" words, the next tap buys NOTHING and builds once the pass shows ──');
  {
    let pay = false;
    const { c, notices } = await fresh({ svc: (s) => { s.gateImpl = async () => (pay ? PASS : QUOTA); } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    buyImpl = async () => ({ ok: false, paid: true, message: 'Payment went through — we are still applying it. It will be ready in a moment.' });
    c.r.confirm.onBuyOnce();
    await advance(10000);
    ok('⚠️ the sheet is BOUGHT: pass.available (the button is "Use my one-time pass"), payment applying, not busy, nothing built',
      c.r.confirm.visible && c.r.confirm.pass?.available === true && c.r.confirm.pass?.forThisEmployer === false && c.r.confirm.payment === 'applying' && !c.r.confirm.busy && svc.calls.build.length === 0, c.r.confirm);
    ok('…its words say the money moved and the pass is being applied — never "that didn\'t go through"',
      /payment went through/i.test(String(c.r.confirm.error)) && /applying your one-time pass/.test(String(c.r.confirm.error)) && /won’t be charged twice/.test(String(c.r.confirm.error)), c.r.confirm.error);
    ok('bought once, for Amazon', buys.length === 1 && buys[0] === 'Amazon', buys);
    const gates = svc.calls.gate.length;
    c.r.confirm.onBuyOnce();
    await advance(10000);
    ok('⚠️ a second tap buys NOTHING: it only re-reads the gate, and the sheet still says applying',
      buys.length === 1 && svc.calls.gate.length > gates && svc.calls.build.length === 0 && c.r.confirm.visible && c.r.confirm.payment === 'applying', { buys: buys.length, gates: svc.calls.gate.length - gates });
    pay = true;
    c.r.confirm.onBuyOnce();
    await advance(0);
    ok('…and once the pass shows, the same button builds with it — coveredOnly, expectVia pass, still ONE purchase',
      buys.length === 1 && svc.calls.build.length === 1 && svc.calls.build[0].coveredOnly === true && svc.calls.build[0].expectVia === 'pass' && !c.r.confirm.visible, { buys: buys.length, build: svc.calls.build[0] });
    ok('no notice while the sheet held the question', notices.length === 0, notices);
    ok('analytics: the purchase was recorded as settling', tracked.some(([e, p]) => e === 'home_build_pass_bought' && p.settling === 'applying'), tracked.filter(([e]) => e === 'home_build_pass_bought'));
  }

  console.log('── C8c. pending (Ask-to-Buy): bought, "approval" words that never claim a charge; Cancel keeps it; no second Buy ──');
  {
    const { c, notices } = await fresh({ svc: (s) => { s.gateImpl = async () => QUOTA; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    buyImpl = async () => ({ ok: false, pending: true, message: 'Your payment is still being confirmed.' });
    c.r.confirm.onBuyOnce();
    await advance(10000);
    ok('⚠️ bought, payment approval, pass.available, nothing built', c.r.confirm.visible && c.r.confirm.pass?.available === true && c.r.confirm.payment === 'approval' && !c.r.confirm.busy && svc.calls.build.length === 0, c.r.confirm);
    ok('…its words: waiting to be approved, NOTHING charged yet — never "went through"',
      /waiting to be approved/.test(String(c.r.confirm.error)) && /nothing has been charged/.test(String(c.r.confirm.error)) && !/went through/.test(String(c.r.confirm.error)), c.r.confirm.error);
    c.r.confirm.onBuyOnce();
    await advance(10000);
    ok('⚠️ a second tap buys nothing', buys.length === 1 && svc.calls.build.length === 0, buys);
    c.r.confirm.onCancel();
    await flush();
    ok('Cancel: the question goes, the notice says the approval is pending and the pass covers the next employer, nothing built',
      !c.r.confirm.visible && notices.some((x) => /waiting to be approved/.test(x.text) && /covers the next employer/.test(x.text)) && svc.calls.build.length === 0, notices);
  }

  console.log('── C8d. the purchase THROWS: not bought — nothing built, no pass claimed, Generate once stays ──');
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => QUOTA; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    buyImpl = async () => { throw new Error('store exploded'); };
    c.r.confirm.onBuyOnce();
    await advance(10000);
    ok('not bought: an error, no pass, no build', c.r.confirm.visible && c.r.confirm.pass === null && c.r.confirm.payment === null && !!c.r.confirm.error && !c.r.confirm.busy && svc.calls.build.length === 0, c.r.confirm);
  }

  console.log('── C9. pre-check finds it covered by the plan: no purchase, the Continue question ──');
  {
    let n = 0;
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => (n++ === 0 ? QUOTA : PLAN); } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    c.r.confirm.onBuyOnce();
    await advance(0);
    ok('no purchase, confirm mode, covered note', buys.length === 0 && c.r.confirm.mode === 'confirm' && /already covered/.test(String(c.r.confirm.error)) && svc.calls.build.length === 0, c.r.confirm);
    c.r.confirm.onContinue();
    await flush();
    ok('Continue builds', svc.calls.build.length === 1);
  }

  console.log('── C10. bought, then the gate says plan: confirm with the saved note; Cancel tells the pass is kept ──');
  {
    let n = 0;
    const { c, notices } = await fresh({ svc: (s) => { s.gateImpl = async () => (n++ < 1 ? QUOTA : (n <= 2 ? QUOTA : PLAN)); } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    c.r.confirm.onBuyOnce();
    await advance(0);
    ok('confirm with saved note', buys.length === 1 && c.r.confirm.mode === 'confirm' && /pass is saved/.test(String(c.r.confirm.error)), { buys: buys.length, confirm: c.r.confirm });
    c.r.confirm.onCancel();
    await flush();
    ok('notice: pass saved, no build', notices.some((x) => /pass is saved/.test(x.text)) && svc.calls.build.length === 0);
  }

  console.log('── C10b. bought, then the gate says free: the Continue question, never an auto-spend of the free allowance ──');
  {
    let n = 0;
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => (n++ < 2 ? QUOTA : FREE); } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    c.r.confirm.onBuyOnce();
    await advance(0);
    ok('confirm mode on the free pool, nothing built', buys.length === 1 && c.r.confirm.mode === 'confirm' && c.r.confirm.usage?.pool === 'free' && svc.calls.build.length === 0, c.r.confirm);
    c.r.confirm.onContinue();
    await flush();
    ok('only Continue builds it, coveredOnly', svc.calls.build.length === 1 && svc.calls.build[0].coveredOnly === true);
  }

  console.log('── C10c. a covered answer with a count for ANOTHER pool, or none left, shows no number ──');
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => ({ covered: true, via: 'plan', usage: USAGE_FREE, pass: { available: false, forThisEmployer: false } }); } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    ok('a plan answer never shows the free count', c.r.confirm.visible && c.r.confirm.usage === null, c.r.confirm.usage);
  }

  console.log('── C11. capacity: Continue then a slot → starts on the same pool without asking; a changed pool asks again ──');
  {
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = async () => PLAN; } });
    for (let k = 1; k <= 3; k++) {
      c.r.request(JOB({ rk: 'emp_' + k, company: 'Co' + k }), { explicit: true, showOverlay: false });
      await advance(0);
      await advance(400);
      c.r.confirm.onContinue();
      await flush();
    }
    ok('three running', svc.flights.size === 3, svc.flights.size);
    c.r.request(JOB({ rk: 'emp_4', company: 'Co4' }), { explicit: true, showOverlay: false });
    await advance(400);
    ok('sheet asks for the 4th even with three running', c.r.confirm.visible && c.r.confirm.company === 'Co4');
    c.r.confirm.onContinue();
    await flush();
    ok('queued with its Continue', rec(store, 'resume|emp_4')?.phase === 'queued' && svc.calls.build.length === 3);
    svc.finish(svc.calls.build[0].key, { ok: true, cached: false, docId: 1 });
    await advance(0);
    ok('drained on the same pool, no second question', svc.calls.build.length === 4 && svc.calls.build[3].company === 'Co4' && !c.r.confirm.visible);
    // now a 5th with Continue while full, and the pool changes
    c.r.request(JOB({ rk: 'emp_5', company: 'Co5' }), { explicit: true, showOverlay: false });
    await advance(400);
    c.r.confirm.onContinue();
    await flush();
    ok('5th queued', rec(store, 'resume|emp_5')?.phase === 'queued');
    svc.gateImpl = async () => FREE;
    svc.finish(svc.calls.build[1].key, { ok: true, cached: false, docId: 2 });
    await advance(0);
    await advance(400);
    ok('pool changed → asked again, not started', svc.calls.build.length === 4 && c.r.confirm.visible && c.r.confirm.company === 'Co5' && c.r.confirm.usage?.pool === 'free', c.r.confirm);
  }

  console.log('── C12. one question at a time: a second request waits for the first sheet ──');
  {
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = async () => PLAN; } });
    c.r.request(JOB({ rk: 'a', company: 'A' }), { explicit: true, showOverlay: false });
    await advance(0);
    c.r.request(JOB({ rk: 'b', company: 'B' }), { explicit: true, showOverlay: false });
    await advance(0);
    ok('A asks, B parked', c.r.confirm.company === 'A' && rec(store, 'resume|b')?.phase === 'queued');
    c.r.confirm.onCancel();
    await advance(0);
    ok('B not visible during the gap', !c.r.confirm.visible || c.r.confirm.company !== 'B');
    await advance(400);
    ok('B asked after the gap', c.r.confirm.visible && c.r.confirm.company === 'B' && svc.calls.build.length === 0, c.r.confirm);
  }

  console.log('── C13. slow gate: checking overlay, then the sheet only after the gap ──');
  {
    let release;
    const { c } = await fresh({ svc: (s) => { s.gateImpl = () => new Promise((r) => { release = () => r(PLAN); }); } });
    c.r.request(JOB(), { explicit: true });
    await advance(301);
    ok('checking overlay', c.r.overlay.visible && c.r.overlay.stage?.stage === 'checking');
    release();
    await advance(0);
    ok('overlay hidden, sheet not yet', !c.r.overlay.visible && !c.r.confirm.visible);
    await advance(380);
    ok('sheet after the gap', c.r.confirm.visible);
    c.r.confirm.onContinue();
    await flush();
    await advance(0);
    ok('overlay held back', !c.r.overlay.visible);
    await advance(380);
    ok('overlay after the gap', c.r.overlay.visible && svc.calls.build.length === 1);
  }

  console.log('── C14. chip removed while the sheet asks: it closes, nothing built ──');
  {
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = async () => PLAN; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    const cont = c.r.confirm.onContinue;
    c.r.cancelQueued('resume', 'emp_1');
    await flush();
    ok('sheet closed, record gone', !c.r.confirm.visible && !rec(store, 'resume|emp_1'));
    cont();
    await flush();
    ok('a late Continue builds nothing', svc.calls.build.length === 0);
  }

  console.log('── C15. chip removed while buying: no build, pass saved notice ──');
  {
    let n = 0;
    const { c, notices } = await fresh({ svc: (s) => { s.gateImpl = async () => (n++ === 0 ? QUOTA : (n === 2 ? QUOTA : PASS)); } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    let release; buyImpl = () => new Promise((r) => { release = r; });
    c.r.confirm.onBuyOnce();
    await advance(0);
    c.r.cancelQueued('resume', 'emp_1');
    await flush();
    ok('sheet stays while the purchase is out', c.r.confirm.visible && c.r.confirm.busy);
    release({ ok: true, employerUnlocked: true });
    await advance(5000);
    ok('no build, sheet closed, saved notice', svc.calls.build.length === 0 && !c.r.confirm.visible && notices.some((x) => /pass is saved/.test(x.text)), { builds: svc.calls.build.length, v: c.r.confirm.visible, notices });
  }

  console.log('── C16. See plans: closes, clears, calls the screen once ──');
  {
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = async () => QUOTA; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    c.r.confirm.onSeePlans();
    c.r.confirm.onSeePlans();
    await flush();
    ok('plans once, record gone, nothing built', plans === 1 && !rec(store, 'resume|emp_1') && svc.calls.build.length === 0 && !c.r.confirm.visible);
  }

  console.log('── C17. forget while the sheet asks: gone ──');
  {
    const { c, mod } = await fresh({ svc: (s) => { s.gateImpl = async () => PLAN; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    const cont = c.r.confirm.onContinue;
    mod.forgetHomeBuilds();
    await flush();
    cont();
    await flush();
    ok('closed, nothing built', !c.r.confirm.visible && svc.calls.build.length === 0);
  }

  console.log('── C18. unmount while the sheet asks: withdrawn, slot free ──');
  {
    const f = await fresh({ svc: (s) => { s.gateImpl = async () => PLAN; } });
    f.c.r.request(JOB(), { explicit: true });
    await advance(0);
    ok('asking', f.c.r.confirm.visible);
    f.c.unmount();
    await flush();
    ok('record withdrawn', !rec(f.store, 'resume|emp_1'));
    const c2 = mount(() => f.mod.useHomeBuilds({ alive: () => true, rkFor: () => null, onLanded: () => {}, onNotice: () => {}, onSeePlans: () => {} }));
    await flush();
    ok('new Home sees no stale question', !c2.r.confirm.visible);
    c2.r.request(JOB({ rk: 'x', company: 'X' }), { explicit: true });
    await advance(400);
    ok('a new question can be asked', c2.r.confirm.visible && c2.r.confirm.company === 'X', c2.r.confirm);
    c2.unmount();
  }

  // ⚠️ CONTRACT C2 (2026-09-15): every build the sheet starts names the payer the user was shown (expectVia), so the server
  // can refuse — 409, nothing bound or charged — a build it would now pay for some OTHER way. The unread gate's Build
  // (coveredOnly:false) names nothing: it promised the server nothing to hold it to.
  console.log('── C2a. what each send tells the server to expect ──');
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => PLAN; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    await tapContinue(c);
    ok('Continue on the plan → expectVia plan, coveredOnly', svc.calls.build[0]?.expectVia === 'plan' && svc.calls.build[0]?.coveredOnly === true, svc.calls.build[0]);
  }
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => FREE; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    await tapContinue(c);
    ok('Continue on the free allowance → expectVia free', svc.calls.build[0]?.expectVia === 'free', svc.calls.build[0]);
  }
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => CACHE; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    ok('a cache hit (the one build that starts without a question) → expectVia cache', svc.calls.build.length === 1 && svc.calls.build[0].expectVia === 'cache' && svc.calls.build[0].coveredOnly === true, svc.calls.build[0]);
  }
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => ({ covered: false, via: null, reason: 'unknown' }); } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    alerts[0].buttons.find((b) => b.text === 'Build').onPress();
    await advance(0);
    ok('⚠️ the unread-gate dialog\'s Build → coveredOnly:false and NO expectVia (nothing was named, so nothing is promised)',
      svc.calls.build.length === 1 && svc.calls.build[0].coveredOnly === false && svc.calls.build[0].expectVia === undefined, svc.calls.build[0]);
  }

  console.log('── C2b. 409 payer_changed: not an ending — nothing was charged, so the gate is read again and the sheet asks again ──');
  {
    let n = 0;
    const { c, store, notices } = await fresh({ svc: (s) => { s.gateImpl = async () => (n++ === 0 ? PLAN : FREE); } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    await tapContinue(c);
    await advance(GAP);
    ok('building on the plan', rec(store, 'resume|emp_1')?.phase === 'building' && svc.calls.build[0].expectVia === 'plan');
    svc.finish(svc.calls.build[0].key, { ok: false, reason: 'payer_changed', message: 'What pays for this resume changed after you confirmed it. Check it and confirm again.' });
    await advance(GAP);
    ok('⚠️ no error record and no "didn’t finish" notice: the record is back to checking',
      rec(store, 'resume|emp_1')?.phase === 'checking' && !notices.some((x) => /didn’t finish/.test(x.text)), { rec: rec(store, 'resume|emp_1'), notices });
    ok('⚠️ the gate was read AGAIN, and nothing was re-sent on the old expectation', svc.calls.gate.length === 2 && svc.calls.build.length === 1, { gates: svc.calls.gate.length, builds: svc.calls.build.length });
    ok('…the sheet is back with the NEW payer and says why it is asking again',
      c.r.confirm.visible && c.r.confirm.mode === 'confirm' && c.r.confirm.usage?.pool === 'free' && /What pays for this changed, so nothing was charged/.test(String(c.r.confirm.error)), c.r.confirm);
    ok('…and the overlay stepped aside for the question', !c.r.overlay.visible);
    c.r.confirm.onContinue();
    await flush();
    ok('Continue builds again, now naming the free allowance', svc.calls.build.length === 2 && svc.calls.build[1].expectVia === 'free' && svc.calls.build[1].coveredOnly === true, svc.calls.build[1]);
    ok('analytics: a regate, never a failure', tracked.some(([e, p]) => e === 'home_build_regate' && p.reason === 'payer_changed') && !tracked.some(([e]) => e === 'home_build_fail'), tracked.map(([e]) => e));
  }

  console.log('── C2c. 409 cache_miss: the promised free copy is gone — the gate is re-read, and a second "cache" answer is no longer believed ──');
  {
    // The re-read says the plan would pay now: the sheet, with the cache-miss note.
    let n = 0;
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = async () => (n++ === 0 ? CACHE : PLAN); } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    ok('the cache hit started at once, expectVia cache', svc.calls.build.length === 1 && svc.calls.build[0].expectVia === 'cache');
    svc.finish(svc.calls.build[0].key, { ok: false, reason: 'cache_miss', message: 'Your saved resume for this employer has changed.' });
    await advance(GAP);
    ok('⚠️ the gate was re-read and the sheet asks about the plan — nothing was re-sent',
      svc.calls.gate.length === 2 && svc.calls.build.length === 1 && c.r.confirm.visible && c.r.confirm.mode === 'confirm' && c.r.confirm.usage?.pool === 'plan', { gates: svc.calls.gate.length, builds: svc.calls.build.length, confirm: c.r.confirm });
    ok('…with the cache-miss note', /saved copy wasn’t there any more, so nothing was charged/.test(String(c.r.confirm.error)), c.r.confirm.error);
    ok('no error record', rec(store, 'resume|emp_1')?.phase !== 'error', rec(store, 'resume|emp_1'));
  }
  {
    // ⚠️ BELIEVED TWICE IT IS A LOOP WITH NO TAP IN IT: a cache answer starts a build on its own, so the same wrong promise
    // would start, be refused, and start again. A second 'cache' for that chip is treated as an UNREAD gate: it asks
    // (the dialog), and only a Build tap sends anything — coveredOnly:false, naming no payer.
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => CACHE; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    svc.finish(svc.calls.build[0].key, { ok: false, reason: 'cache_miss', message: 'gone' });
    await advance(GAP);
    ok('⚠️ the re-read said "cache" AGAIN: no build started, no sheet — the unread-gate dialog asks instead',
      svc.calls.gate.length === 2 && svc.calls.build.length === 1 && !c.r.confirm.visible && alerts.length === 1, { gates: svc.calls.gate.length, builds: svc.calls.build.length, alerts: alerts.length });
    alerts[0].buttons.find((b) => b.text === 'Build').onPress();
    await advance(0);
    ok('…and only its Build sends — coveredOnly:false, no expectVia', svc.calls.build.length === 2 && svc.calls.build[1].coveredOnly === false && svc.calls.build[1].expectVia === undefined, svc.calls.build[1]);
  }

  console.log('── C2d. 409 with no Home to ask: the record says it was not started and nothing was charged; nothing is re-read or re-sent ──');
  {
    const { c, store, env } = await fresh();
    c.r.request(JOB(), { explicit: true, showOverlay: false });
    await advance(0);
    await tapContinue(c);
    await advance(GAP);
    env.alive = false;
    svc.finish(svc.calls.build[0].key, { ok: false, reason: 'payer_changed', message: 'changed' });
    await advance(GAP);
    const r = rec(store, 'resume|emp_1');
    ok('⚠️ an error record whose words say nothing was charged, reason failed (so Try again goes through the gate)',
      r?.phase === 'error' && r.error?.reason === 'failed' && /nothing was charged/.test(String(r.error?.message)) && /Start it again from its card/.test(String(r.error?.message)), r);
    ok('…no gate re-read (nobody to ask) and no second build', svc.calls.gate.length === 1 && svc.calls.build.length === 1, { gates: svc.calls.gate.length, builds: svc.calls.build.length });
  }

  console.log('── C19. unread gate still the Alert; credits still covered-only ──');
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => ({ covered: false, via: null, reason: 'unknown' }); } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    ok('Alert, no sheet', alerts.length === 1 && !c.r.confirm.visible);
  }

  console.log('── C20. retarget while the sheet asks: the sheet names, and Continue builds, the latest job ──');
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => PLAN; } });
    c.r.request(JOB({ website: 'https://boards.greenhouse.io/amazon' }), { explicit: true });
    await advance(0);
    c.r.retarget('resume', 'emp_1', { website: '', company: 'Amazon EU' });
    await flush();
    ok('sheet company follows', c.r.confirm.company === 'Amazon EU');
    c.r.confirm.onContinue();
    await flush();
    ok('built the retargeted job', svc.calls.build[0]?.website === '' && svc.calls.build[0]?.company === 'Amazon EU');
  }

  console.log('── C21. openOverlayFor is ignored while a question is up ──');
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => PLAN; } });
    c.r.request(JOB({ rk: 'a', company: 'A' }), { explicit: true, showOverlay: false });
    await advance(0);
    c.r.openOverlayFor('resume', 'a');
    await flush();
    ok('no overlay over the sheet', !c.r.overlay.visible && c.r.confirm.visible);
  }

  console.log('── C22. queued without a Continue and no Home: never starts unseen; with Home: asks ──');
  {
    const f = await fresh({ svc: (s) => { s.gateImpl = async () => CACHE; } });
    for (let k = 1; k <= 3; k++) f.c.r.request(JOB({ rk: 'emp_' + k, company: 'Co' + k }), { explicit: true, showOverlay: false });
    await advance(0);
    ok('three cache builds', svc.flights.size === 3);
    f.c.r.request(JOB({ rk: 'emp_4', company: 'Co4' }), { explicit: true, showOverlay: false });
    await advance(0);
    ok('4th queued (cache, capacity)', rec(f.store, 'resume|emp_4')?.phase === 'queued');
    f.c.unmount();
    svc.gateImpl = async () => PLAN;
    svc.finish(svc.calls.build[0].key, { ok: true, cached: true, docId: 1 });
    await advance(0);
    ok('no Home: not started', svc.calls.build.length === 3 && rec(f.store, 'resume|emp_4')?.phase === 'queued');
    const c2 = mount(() => f.mod.useHomeBuilds({ alive: () => true, rkFor: () => null, onLanded: () => {}, onNotice: () => {}, onSeePlans: () => {} }));
    await advance(0);
    ok('with Home: the sheet asks, still not started', c2.r.confirm.visible && c2.r.confirm.company === 'Co4' && svc.calls.build.length === 3, c2.r.confirm);
    c2.r.confirm.onContinue();
    await flush();
    ok('Continue starts it', svc.calls.build.length === 4 && svc.calls.build[3].coveredOnly === true);
    c2.unmount();
  }

  console.log('── C23. Try again on a failed build: the sheet, not a silent second build ──');
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => PLAN; } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    c.r.confirm.onContinue();
    await advance(400);
    svc.finish(svc.calls.build[0].key, { ok: false, reason: 'failed', message: 'boom' });
    await flush();
    ok('error overlay, retryable', c.r.overlay.visible && c.r.overlay.canRetry);
    c.r.retryOverlay();
    await advance(0);
    ok('no second build yet, overlay down', svc.calls.build.length === 1 && !c.r.overlay.visible);
    await advance(400);
    ok('the sheet asks', c.r.confirm.visible);
    c.r.confirm.onContinue();
    await flush();
    ok('rebuilt after Continue', svc.calls.build.length === 2);
  }

  console.log('── C24. letters: kind flows through ──');
  {
    const { c } = await fresh({ svc: (s) => { s.gateImpl = async () => ({ covered: true, via: 'free', usage: { ...USAGE_FREE, kind: 'cover_letter' } }); } });
    c.r.request(JOB({ kind: 'cover_letter' }), { explicit: true });
    await advance(0);
    ok('letter sheet', c.r.confirm.visible && c.r.confirm.kind === 'cover_letter');
    c.r.confirm.onContinue();
    await flush();
    ok('letter built', svc.calls.build[0]?.kind === 'cover_letter' && svc.calls.build[0]?.coveredOnly === true);
  }

  console.log('── C25. no runBuild(…, false,) came from the sheet paths ──');
  {
    const code = require('fs').readFileSync(APP + '/components/employer-home/useHomeBuilds.ts', 'utf8');
    const falses = code.match(/runBuild\((?:[^()]|\([^()]*\))*?, false,/g) || [];
    ok('exactly the two unread-gate sends', falses.length === 2, falses);
  }


  console.log('── C26. queued, nothing left, no Home: keeps its place; the new Home gets the EMPTY sheet ──');
  {
    const f = await fresh({ svc: (s) => { s.gateImpl = async () => CACHE; } });
    for (let k = 1; k <= 3; k++) f.c.r.request(JOB({ rk: 'emp_' + k, company: 'Co' + k }), { explicit: true, showOverlay: false });
    await advance(0);
    f.c.r.request(JOB({ rk: 'emp_4', company: 'Co4' }), { explicit: true, showOverlay: false });
    await advance(0);
    f.c.unmount();
    svc.gateImpl = async () => QUOTA;
    svc.finish(svc.calls.build[0].key, { ok: true, cached: true, docId: 1 });
    await advance(0);
    ok('no Home: still queued, not refused', f.store.getBuilds()['resume|emp_4']?.phase === 'queued');
    const c2 = mount(() => f.mod.useHomeBuilds({ alive: () => true, rkFor: () => null, onLanded: () => {}, onNotice: () => {}, onSeePlans: () => {} }));
    await advance(0);
    ok('the empty sheet asks on the new Home', c2.r.confirm.visible && c2.r.confirm.mode === 'empty' && c2.r.confirm.company === 'Co4', c2.r.confirm);
    c2.unmount();
  }

  console.log('── C27. regen_limit is still the plans refusal (no sheet) ──');
  {
    const { c, store } = await fresh({ svc: (s) => { s.gateImpl = async () => ({ covered: false, via: null, reason: 'regen_limit' }); } });
    c.r.request(JOB(), { explicit: true });
    await advance(0);
    ok('overlay refusal, no sheet', !c.r.confirm.visible && c.r.overlay.visible && c.r.overlay.error?.reason === 'regen_limit' && rec(store, 'resume|emp_1')?.phase === 'error');
  }

  console.log('── C28. the confirm view never names credits ──');
  {
    const code = require('fs').readFileSync(APP + '/components/employer-home/GenerateConfirmSheet.tsx', 'utf8');
    const lits = [...code.replace(/\/\/[^\n]*/g, '').matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0]);
    ok('no credit wording in the sheet', lits.length > 20 && !lits.some((l) => /credit/i.test(l)), lits.filter((l) => /credit/i.test(l)));
    ok('no useNativeDriver:false in the sheet', !/useNativeDriver:\s*false/.test(code));
    ok('header', /^\/\/ AI Hub — new feature\. Safe to delete/.test(code));
  }

  console.log('── G. checkBuildGate (services/homeAddEmployer.ts): usage + pass parsed STRICTLY, never able to change the answer ──');
  {
    // The REAL service, transpiled, against a stubbed fetch: what the sheet is told comes from here. A loose mapping
    // is how a silent charge gets back in (the answer), and how the sheet would quote numbers the server never sent.
    const GATE_SVC = transpile(path.join(APP, 'services/homeAddEmployer.ts'), 'homeAddEmployer.ts');
    const sent = [];
    let answer = { status: 200, json: {} };
    const realFetch = global.fetch;
    global.fetch = async (url, init) => { sent.push({ url, body: init && init.body ? JSON.parse(init.body) : null }); return { status: answer.status, ok: answer.status < 400, json: async () => answer.json }; };
    const prevLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'expo-secure-store') return { getItemAsync: async () => JSON.stringify({ token: 'T', id: 1 }), setItemAsync: async () => {}, deleteItemAsync: async () => {} };
      if (request === '@react-native-async-storage/async-storage') return { default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } };
      if (request === '../config') return { API_BASE: 'https://api.test' };
      if (request === './employerHomeService') return { gradFor: () => ['#000', '#111'], cleanJobUrl: (u) => u, deviceHeaders: async () => ({}) };
      return prevLoad.apply(this, arguments);
    };
    try {
      delete require.cache[GATE_SVC];
      const G = require(GATE_SVC);
      const ask = async (json, kind = 'resume', status = 200) => { answer = { status, json }; const p = G.checkBuildGate('Acme', { website: 'https://acme.com' }, kind, { employerId: 'e1' }); await flush(); return p; };
      const U = { kind: 'resume', pool: 'plan', planLabel: 'Plus', remaining: 12, allowance: 15, used: 3, oneTime: false };
      let g = await ask({ covered: true, via: 'plan', usage: U, pass: { available: false, forThisEmployer: false } });
      ok('a covered plan answer carries usage and pass as sent', g.covered === true && g.via === 'plan' && JSON.stringify(g.usage) === JSON.stringify(U)
        && JSON.stringify(g.pass) === JSON.stringify({ available: false, forThisEmployer: false }), g);
      ok('…asked on the resume DOC lane', /\/resume-builder\/generation-gate$/.test(sent[sent.length - 1].url) && sent[sent.length - 1].body.saveTo === 'employer_doc');
      g = await ask({ covered: true, via: 'cache', credits: null, reason: null, usage: null, pass: null });
      ok('a cache hit with null extras → no usage / pass keys at all (absent, never undefined-valued)', g.via === 'cache' && !('usage' in g) && !('pass' in g), g);
      g = await ask({ covered: false, via: null, reason: 'quota_exhausted', usage: { ...U, pool: 'free', planLabel: null, remaining: 0, allowance: 3, used: 3, oneTime: true }, pass: { available: false, forThisEmployer: true } });
      ok('quota_exhausted keeps its reason and carries both', g.reason === 'quota_exhausted' && g.usage.remaining === 0 && g.usage.oneTime === true && g.pass.forThisEmployer === true, g);
      g = await ask({ covered: true, via: 'free', usage: { ...U, remaining: '2' }, pass: { available: 'yes', forThisEmployer: false } });
      ok('⚠️ a count sent as a string, or a flag that is not a boolean, is DROPPED — the answer still stands', g.covered === true && g.via === 'free' && !('usage' in g) && !('pass' in g), g);
      g = await ask({ covered: true, via: 'plan', usage: { ...U, kind: 'cover_letter' } });
      ok('⚠️ a count for the OTHER kind of document is dropped', g.via === 'plan' && !('usage' in g), g);
      g = await ask({ covered: true, via: 'plan', usage: { ...U, remaining: -1 } });
      ok('…and so is a negative count', !('usage' in g), g);
      g = await ask({ covered: true, via: 'credits', usage: U });
      ok('⚠️ extras never rescue a malformed answer: covered + credits is still UNKNOWN (ask first)', g.covered === false && g.reason === 'unknown' && !('usage' in g), g);
      g = await ask({ covered: true, via: 'plan', usage: U }, 'resume', 500);
      ok('a 500 is unknown, whatever it carries', g.reason === 'unknown' && !('usage' in g), g);
      g = await ask({ covered: true, via: 'pass', usage: { ...U, kind: 'cover_letter', pool: 'free' }, pass: { available: true, forThisEmployer: true } }, 'cover_letter');
      ok('the letter gate: its own endpoint, its own kind', /\/cover-letter\/employer-gate$/.test(sent[sent.length - 1].url) && g.via === 'pass' && g.usage && g.usage.kind === 'cover_letter' && g.pass.available === true, g);
    } finally {
      Module._load = prevLoad;
      global.fetch = realFetch;
    }
  }

  console.log(`\nhome builds: ${pass} passed, ${fail} failed`);
  Date.now = realDateNow;
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {} process.exit(2); });
