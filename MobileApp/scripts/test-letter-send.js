// AI Hub — new feature. Safe to delete without affecting existing app.
// (A plain node script like every suite in MobileApp/scripts — the harness runs `node`, not a TS toolchain.)
//
// The letter's Send page — client half (2026-09-19): services/letterSend.ts (the pure rules + the four calls) and the
// screen app/(cover-letter)/send.tsx, transpiled from the REAL sources and driven in the same tiny fake React runtime
// the gallery suites use (hooks by call order, a walkable element tree, a fake clock, a fake fetch).
//   node MobileApp/scripts/test-letter-send.js
//
// THE OWNER'S ASK: "a button Send … a well designed GUI page like our customisation page to send email … auto generated
// subject, auto generated body … attachments … use the connected gmail or microsoft account … add email id and send".
// What these scenarios hold the page to:
//   • opening it SENDS NOTHING and CHARGES NOTHING (a draft read and a free AI note, nothing else);
//   • the Send button is disabled until there is a mailbox and an address, and says why;
//   • a locked account gets the paywall BEFORE any request, and a server 403 opens it too;
//   • an older server (an HTML 404, no reason) is told apart from a deleted letter;
//   • a retry after a lost connection re-uses the SAME clientBuildId (one email, not two); after a definite failure a
//     NEW one (the server would hand back the failed job);
//   • the AI never overwrites what the user wrote.
// And the review's findings (2026-09-19, sections 11–21): Send waits for a file still uploading; Back mid-send asks, and a
// reopened page polls the pending job instead of sending; an edited message never re-uses the old Send id (and the page
// reports the addresses THAT Send went to); a late AI note never replaces what was sent; the message says only what
// is attached; a typed address counts; the paywall re-sends once and never loops; a failed state read is no padlock;
// 'unknown_outcome' never says nothing was sent; each failure's button is the fix it names.
// And (2026-09-20, section 22) a CLASSIC letter — the preview opened without a docId (Job Hub, Review, old Home): the page
// reads it from CLASSIC_SEND_KEY, every call carries it to the /classic/… routes, its DRAFT is keyed by its content and
// its PENDING SEND by the posting it is for (so a regenerated letter still finds an unresolved Send — review 2026-09-20);
// a classic page with no letter asks the server nothing.
// ⚠️ MUTATION PROOF — point it at another copy:  SEND_SRC=/tmp/x/send.tsx  LETTER_SEND_SRC=/tmp/x/letterSend.ts
// (each of those fixes, reverted alone in a copy, fails this suite — checked 2026-09-19).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const APP = path.join(__dirname, '..');
const ts = require(path.join(APP, 'node_modules/typescript'));
const OUT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cva-letter-send-')));

const SEND_SRC = process.env.SEND_SRC || path.join(APP, 'app/(cover-letter)/send.tsx');
const LETTER_SEND_SRC = process.env.LETTER_SEND_SRC || path.join(APP, 'services/letterSend.ts');
function transpile(src, name) {
  const js = ts.transpileModule(fs.readFileSync(src, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, jsx: ts.JsxEmit.React },
    fileName: name,
  }).outputText;
  const p = path.join(OUT, name.replace(/\.tsx?$/, '.js'));
  fs.writeFileSync(p, js);
  return p;
}
const SCREEN = transpile(SEND_SRC, 'send.tsx');
const LS = transpile(LETTER_SEND_SRC, 'letterSend.ts');

/* ── fake clock ── */
let now = 1_700_000_000_000;
let tid = 0;
const timers = new Map();
global.setTimeout = (fn, ms) => { const id = ++tid; timers.set(id, { at: now + (Number(ms) || 0), fn }); return id; };
global.clearTimeout = (id) => { timers.delete(id); };
global.requestAnimationFrame = (fn) => global.setTimeout(fn, 0);
const realDateNow = Date.now;
Date.now = () => now;
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
async function advance(ms) {
  const end = now + ms;
  for (let g = 0; g < 2000; g++) {
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
  createElement(type, props, ...children) {
    const kids = [];
    const push = (c) => { if (c == null || c === false || c === true) return; Array.isArray(c) ? c.forEach(push) : kids.push(c); };
    children.forEach(push);
    if (props && props.children !== undefined && !children.length) push(props.children);
    // Section's header buttons arrive as a prop (`actions`) — walk them like children so a test can press them.
    if (props && props.actions && props.actions.$el) kids.push(props.actions);
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
  return { get tree() { return inst.result; }, unmount() { inst.unmounted = true; for (const h of inst.hooks) if (h && h.effect && h.cleanup) h.cleanup(); } };
}
function walk(node, fn) { if (!node || !node.$el) return; fn(node); for (const c of node.children) walk(c, fn); }
const findAll = (root, pred) => { const out = []; walk(root, (n) => { if (pred(n)) out.push(n); }); return out; };
const findOne = (root, pred) => findAll(root, pred)[0] || null;
function textOf(node) {
  const out = [];
  const rec = (n) => {
    if (n == null) return;
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return; }
    if (!n.$el) return;
    n.children.forEach(rec);
  };
  rec(node);
  return out.join('');
}

/* ── mocks ── */
let params, alerts, calls, store, pushes, applied, mail, dlLocked, api;
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const SHUT = { metered: false, paid: false, unlimited: false, remaining: null, passes: 0, ownsEmployer: false, employer: null };
const OPEN = { ...SHUT, paid: true, unlimited: true };

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'react') return FakeReact;
  if (request === 'react-native') return {
    View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView', TextInput: 'TextInput',
    ActivityIndicator: 'ActivityIndicator', KeyboardAvoidingView: 'KeyboardAvoidingView',
    StyleSheet: { create: (o) => o },
    Alert: { alert: (title, msg, buttons) => alerts.push({ title, msg, buttons }) },
    Keyboard: { dismiss() {} },
    Platform: { OS: 'ios', select: (o) => ('ios' in o ? o.ios : o.default) },
  };
  if (request === 'react-native-safe-area-context') return { SafeAreaView: 'SafeAreaView' };
  if (request === 'expo-image') return { Image: 'Image' };
  if (request === 'expo-linear-gradient') return { LinearGradient: 'LinearGradient' };
  if (request === '@expo/vector-icons') return { Ionicons: 'Ionicons' };
  if (request === 'expo-router') return {
    useRouter: () => ({ back() { pushes.push('back'); }, push(a) { pushes.push(a); }, replace(a) { pushes.push(a); }, canGoBack: () => true }),
    useLocalSearchParams: () => params,
  };
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: {
    getItem: async (k) => (k in store ? store[k] : null),
    setItem: async (k, v) => { store[k] = v; },
    removeItem: async (k) => { delete store[k]; },
  } };
  if (request === 'expo-secure-store') return { getItemAsync: async () => JSON.stringify({ token: 'tok' }) };
  if (request === '../config' || request === '../../config') return { API_BASE: 'https://api.test/api' };
  if (request === './storeEnv') return { storeEnvHeader: async () => ({}) };
  if (request === '../../services/letterSend') return require(LS);
  if (request === '../../components/rich-text/RichText') return {
    T: { bg: '#E5EAF3', bgSoft: '#F0F4FA', surface: '#FFF', navy: '#0B1120', ink: '#0B0F22', inkSoft: '#1A2046', muted: '#5A6480', faint: '#8A93B2', border: 'x', blue: '#4F8DFF', blueDeep: '#2563EB', cyan: '#06B6D4', emerald: '#10B981', violet: '#A78BFA', rose: '#EF4444' },
    Section: 'Section', sec: { editBtn: {}, editText: {} },
  };
  if (request === '../../components/send/SmartAttachSheet') return { __esModule: true, default: 'SmartAttachSheet' };
  if (request === '../../components/downloads/DownloadPaywallSheet') return { __esModule: true, default: 'DownloadPaywallSheet' };
  // The page reads the state itself now (letterSend.readDownloadState → GET /downloads/state, below); the label rule is
  // the real one's (services/downloadPassService downloadButtonLabel), metered allowance included.
  if (request === '../../services/downloadPassService') return {
    downloadButtonLabel: (st) => ({ label: 'Download', locked: !(st.ownsEmployer || st.passes > 0 || st.unlimited || (st.paid && st.metered && (st.remaining || 0) > 0)) }),
  };
  if (request === '../../services/employerDocs') return { fetchDocCards: async (_k, _d, ids) => ({ cards: ids.map((id) => ({ id, image: 'data:image/jpeg;base64,' + id })) }) };
  if (request === '../../services/employerHomeService') return { LETTER_DESIGNS: [{ id: 'exec_leader', name: 'Executive Leadership', accent: '#b8995a' }] };
  if (request === '../../services/aiHubService') return { markAppliedByUrl: async (urls) => { applied.push(urls); return true; } };
  if (request === '../../services/mailAccount') return { useMailLink: () => mail };
  return origLoad.apply(this, arguments);
};

const DRAFT = () => ({
  success: true,
  letter: { docId: 12, employer: 'Nordex', companyName: 'Nordex SE', position: 'Quality Inspector', jobUrl: 'https://jobs.nordex.com/9', updatedAt: '2026-09-19T10:00:00.000Z' },
  subject: 'Application for Quality Inspector — Rishi Samadhiya',
  body: 'Dear Hiring Manager,\n\nI would like to apply. My cover letter and résumé are attached to this email.\n\nBest regards,\nRishi',
  bodies: {
    withResume: 'Dear Hiring Manager,\n\nI would like to apply. My cover letter and résumé are attached to this email.\n\nBest regards,\nRishi',
    letterOnly: 'Dear Hiring Manager,\n\nI would like to apply. My cover letter is attached to this email.\n\nBest regards,\nRishi',
  },
  sender: { name: 'Rishi Samadhiya', email: 'rishi@example.com' },
  recipients: { prefill: [{ email: 'tom@nordex.com', name: 'Tom', role: 'Recruiter' }], suggestions: [{ email: 'anna@nordex.com', name: 'Anna', role: 'Manager' }] },
  resume: { options: [{ id: 'tailored', docId: 30, label: 'Tailored for Nordex', detail: 'Azure · PDF', gated: true }, { id: 'builder', label: 'Your résumé', detail: 'Builder', gated: true }], default: 'tailored' },
  account: { provider: 'google', ready: true, reconnect: false, address: 'rishi.work@gmail.com' },
});

global.fetch = async (url, init = {}) => {
  const u = String(url).replace('https://api.test/api', '');
  const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
  calls.push({ url: u, method: init.method || 'GET', body });
  if (api.throwOn && api.throwOn.test(u)) throw new Error('Network request failed');
  if (/\/email-draft$/.test(u)) return api.draft ? api.draft() : jsonRes(200, DRAFT());
  if (/\/email-body$/.test(u)) return api.body ? api.body(body) : jsonRes(200, { success: true, body: body && body.resume === false ? 'Dear Tom,\n\nAI NOTE (letter only) from the letter.\n\nBest regards,\nRishi' : 'Dear Tom,\n\nAI NOTE from the letter.\n\nBest regards,\nRishi', source: 'ai' });
  if (/^\/downloads\/state/.test(u)) return api.state ? api.state() : jsonRes(200, dlLocked ? SHUT : OPEN);
  if (/\/send-files$/.test(u)) return api.upload ? api.upload() : jsonRes(200, { success: true, fileId: 'f-1', name: 'My CV.pdf', size: 2048, mime: 'application/pdf' });
  if (/\/send$/.test(u)) return api.send ? api.send(body) : jsonRes(202, { jobId: 'job-1', status: 'pending' });
  if (/\/job-status\//.test(u)) return api.status ? api.status() : jsonRes(200, { status: 'completed', data: { success: true, provider: 'google', from: 'rishi.work@gmail.com', to: body ? [] : ['tom@nordex.com'], charged: false, sentAt: '2026-09-19T10:00:00Z' } });
  return jsonRes(404, {});
};

let pass = 0, fail = 0;
/** Press an alert button by its text — a missing alert or button is a failed assertion above it, not a crash. */
const tapAlert = (a, text) => { const b = a && Array.isArray(a.buttons) ? a.buttons.find((x) => x.text === text) : null; if (b && b.onPress) b.onPress(); };
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); } };

async function openSend(o = {}) {
  delete require.cache[SCREEN];
  for (const id of timers.keys()) timers.delete(id);
  params = o.params || { docId: '12', template: 'exec_leader', mode: 'onepage' };
  alerts = []; calls = []; pushes = []; applied = [];
  store = o.store || {};
  dlLocked = !!o.locked;
  api = o.api || {};
  mail = { linkGoogle: async () => ({ ok: true, address: 'new@gmail.com', message: 'ok' }), linkMicrosoft: async () => ({ ok: false, cancelled: true, message: 'Cancelled.' }), googleReady: true };
  const Screen = require(SCREEN).default;
  const c = mount(() => Screen());
  await advance(10);
  const h = {
    c,
    text: () => textOf(c.tree),
    sendBtn: () => findOne(c.tree, (n) => n.type === 'TouchableOpacity' && typeof n.props.accessibilityLabel === 'string' && /^(Send|Sending|Done)/.test(n.props.accessibilityLabel)),
    section: (title) => findOne(c.tree, (n) => n.type === 'Section' && n.props.title === title),
    btn: (re) => findOne(c.tree, (n) => n.type === 'TouchableOpacity' && re.test(textOf(n))),
    input: () => findOne(c.tree, (n) => n.type === 'TextInput' && n.props.keyboardType === 'email-address'),
    paywall: () => findOne(c.tree, (n) => n.type === 'DownloadPaywallSheet'),
    sends: () => calls.filter((x) => /\/send$/.test(x.url)),
    // Not awaited: a Send polls on the FAKE clock, so its promise only settles while advance() runs timers.
    // A missing button is the failed assertion next to it, not a crash of the whole suite.
    async press(node) { if (node && node.props && node.props.onPress) node.props.onPress(); await advance(10); },
  };
  return h;
}

(async () => {
  const L = require(LS);

  console.log('── 1. the pure rules (services/letterSend.ts) ──');
  {
    ok('isEmail accepts real addresses', ['a@b.co', 'first.last+tag@sub.example.org'].every(L.isEmail));
    ok('isEmail refuses junk', !['a@b', '@b.com', 'a..b@c.com', 'a b@c.com', '', null].some(L.isEmail));
    ok('a pasted list splits into addresses', JSON.stringify(L.splitAddresses('a@x.com, b@y.com; <c@z.com>')) === JSON.stringify(['a@x.com', 'b@y.com', 'c@z.com']));
    const r1 = L.addRecipients(['A@x.com'], 'a@x.com b@y.com');
    ok('addRecipients: a duplicate in any case is skipped, the new one added', JSON.stringify(r1.list) === JSON.stringify(['A@x.com', 'b@y.com']) && r1.error === null && r1.added === 1, r1);
    const r2 = L.addRecipients([], 'good@x.com nope');
    ok('addRecipients: the first invalid token is said out loud', r2.error && /“nope” is not a valid email address/.test(r2.error) && r2.list.length === 1, r2);
    const five = ['a@a.com', 'b@b.com', 'c@c.com', 'd@d.com', 'e@e.com'];
    const r3 = L.addRecipients(five, 'f@f.com');
    ok(`addRecipients: the ${L.MAX_RECIPIENTS}-address cap is said out loud`, r3.list.length === 5 && /at most 5/.test(r3.error), r3);
    ok('removeRecipient ignores case', L.removeRecipient(['A@x.com', 'b@y.com'], 'a@X.com').join() === 'b@y.com');
    const acct = { provider: 'google', ready: true, reconnect: false, address: null };
    ok('canSend: no mailbox → says connect', L.canSend({ to: ['a@b.co'], subject: 's', body: 'b', account: { ...acct, ready: false }, busy: false, hasLetter: true }).why === 'Connect Gmail or Outlook to send.');
    ok('canSend: no recipient → says add one', L.canSend({ to: [], subject: 's', body: 'b', account: acct, busy: false, hasLetter: true }).why === 'Add at least one email address.');
    ok('canSend: no subject → says so', /subject/i.test(L.canSend({ to: ['a@b.co'], subject: ' ', body: 'b', account: acct, busy: false, hasLetter: true }).why));
    ok('canSend: ready', L.canSend({ to: ['a@b.co'], subject: 's', body: 'b', account: acct, busy: false, hasLetter: true }).ok === true);
    for (const reason of L.SEND_REASONS) {
      const m = L.reasonMessage(reason, { provider: 'google' });
      if (!(m && m.title && m.message && m.message.length > 20)) ok(`reasonMessage has a sentence for ${reason}`, false, m);
    }
    ok('⚠️ reasonMessage covers EVERY reason the server can give', L.SEND_REASONS.every((r) => L.reasonMessage(r).message.length > 20));
    const serverReasons = ['gone', 'no_mail_account', 'reconnect', 'scope', 'bad_recipients', 'bad_recipient', 'bad_subject', 'bad_body', 'bad_request', 'too_many',
      'paid_required', 'quota_exhausted', 'resume_gone', 'file_gone', 'bad_file', 'render_failed', 'too_big', 'provider_busy', 'send_failed', 'failed'];
    ok('…every reason letterSendController answers with is a known one', serverReasons.every((r) => L.SEND_REASONS.includes(r)));
    const ctrl = fs.readFileSync(path.join(APP, '..', 'server/controllers/letterSendController.js'), 'utf8');
    const used = [...new Set([...ctrl.matchAll(/reason: '([a-z_]+)'/g)].map((m) => m[1]))];
    ok('⚠️ …checked against the controller\'s own source', used.length > 8 && used.every((r) => L.SEND_REASONS.includes(r)), used.filter((r) => !L.SEND_REASONS.includes(r)));
    ok('the refusals that happen before any send say nothing was sent or charged',
      ['reconnect', 'scope', 'render_failed', 'provider_busy', 'send_failed', 'paid_required', 'resume_gone', 'file_gone'].every((r) => /Nothing was sent and nothing was charged/.test(L.reasonMessage(r).message)));
    ok('⚠️ a lost connection does NOT claim nothing was sent — it points at the Sent folder',
      ['network', 'lost'].every((r) => !/Nothing was sent/.test(L.reasonMessage(r).message) && /Sent folder/.test(L.reasonMessage(r).message)));
    ok('⚠️ classify: an HTML 404 (no reason) is an OLDER SERVER, not a deleted letter', L.classify(404, {}) === 'server_outdated');
    ok('classify: 404 with reason gone → gone', L.classify(404, { reason: 'gone' }) === 'gone' && L.classify(404, { reason: 'payload_gone' }) === 'gone');
    ok('classify: the server\'s reasons pass through', L.classify(409, { reason: 'reconnect' }) === 'reconnect' && L.classify(403, { reason: 'quota_exhausted' }) === 'quota_exhausted');
    ok('classify: a 403 with no reason is the paywall, a 500 is failed, a 200 is no failure', L.classify(403, {}) === 'paid_required' && L.classify(500, {}) === 'failed' && L.classify(200, {}) === null);
    ok('defaultResumeChoice: the server\'s default', L.defaultResumeChoice(DRAFT().resume.options, 'tailored').source === 'tailored');
    ok('defaultResumeChoice: nothing → none', L.defaultResumeChoice([], null).source === 'none');
    ok('isGated: our renders yes, their files no', L.isGated({ source: 'doc' }) && L.isGated({ source: 'builder' }) && !L.isGated({ source: 'uploaded' }) && !L.isGated({ source: 'file', file: {} }) && !L.isGated({ source: 'none' }));
    ok('draftKey is per letter VERSION', L.draftKey(12, 'a') !== L.draftKey(12, 'b') && L.draftKey(12, 'a') !== L.draftKey(13, 'a'));
    ok('two Send ids are never the same', L.newClientBuildId() !== L.newClientBuildId());
  }

  console.log('── 2. opening the page sends nothing and charges nothing ──');
  {
    const h = await openSend();
    const urls = calls.map((x) => `${x.method} ${x.url}`);
    ok('⚠️ opening it reads the draft, asks for the free note and reads the padlock — and nothing else',
      JSON.stringify(urls) === JSON.stringify(['GET /employer-docs/12/email-draft', 'POST /employer-docs/12/email-body', 'GET /downloads/state?employer=Nordex']), urls);
    ok('…the note is asked for the attachments on the page (the tailored résumé is on → resume: true)', calls[1].body && calls[1].body.resume === true, calls[1].body);
    const t = h.text();
    ok('the mailbox card names the connected address', /SENDING FROM/.test(t) && /rishi\.work@gmail\.com/.test(t) && /Connected/.test(t));
    ok('the known contact is already in To', /Tom · tom@nordex\.com/.test(t));
    ok('…and the others are offered as chips', /Contacts we know at Nordex/.test(t) && /Anna · Manager/.test(t));
    ok('the subject is the letter\'s own', /Application for Quality Inspector — Rishi Samadhiya/.test(t));
    ok('the message is the note written from the letter', /AI NOTE from the letter/.test(t) && /Written from your letter — free/.test(t));
    ok('the attachments: the letter in the design on screen, and the tailored résumé', /Executive Leadership · One page · PDF/.test(t) && /Tailored for Nordex/.test(t));
    ok('a Send button that names the count', h.sendBtn() && h.sendBtn().props.accessibilityLabel === 'Send to 1 recipient' && !h.sendBtn().props.disabled);
    ok('the top bar says whose application this is', /SEND COVER LETTER/.test(t) && /Nordex application/.test(t));
    await advance(1000);
    ok('the draft is kept on the phone per letter version', typeof store['letterSendDraft:v1:12:2026-09-19T10:00:00.000Z'] === 'string');
    h.c.unmount();
  }

  console.log('── 3. no mailbox: connect first — the button says why ──');
  {
    const d = DRAFT(); d.account = { provider: null, ready: false, reconnect: false, address: null };
    const h = await openSend({ api: { draft: () => jsonRes(200, d) } });
    const t = h.text();
    ok('it explains that the mail goes from THEIR mailbox', /No mailbox connected yet/.test(t) && /from your own Gmail or Outlook/.test(t));
    ok('…with Connect Gmail and Connect Outlook', !!h.btn(/^Connect Gmail$/) && !!h.btn(/^Connect Outlook$/));
    ok('Send is disabled and says why', h.sendBtn().props.disabled === true && /Connect Gmail or Outlook to send\./.test(t));
    await h.press(h.btn(/^Connect Gmail$/));
    await advance(100);
    ok('Connect → the account is read back from the server (never assumed)', calls.filter((x) => /email-draft/.test(x.url)).length === 2);
    ok('⚠️ connecting sent nothing', h.sends().length === 0);
    h.c.unmount();
  }
  {
    const d = DRAFT(); d.account = { provider: 'google', ready: false, reconnect: true, address: null };
    const h = await openSend({ api: { draft: () => jsonRes(200, d) } });
    ok('an expired Gmail says Reconnect Gmail', !!h.btn(/^Reconnect Gmail$/) && /needs you to sign in again/.test(h.text()));
    h.c.unmount();
  }

  console.log('── 4. recipients: typed, validated, removable — and none means no Send ──');
  {
    const d = DRAFT(); d.recipients = { prefill: [], suggestions: [] };
    const h = await openSend({ api: { draft: () => jsonRes(200, d) } });
    ok('no address → Send disabled, and it says why', h.sendBtn().props.disabled === true && /Add at least one email address\./.test(h.text()));
    h.input().props.onChangeText('not-an-email');
    await advance(10);
    h.input().props.onSubmitEditing();
    await advance(10);
    ok('an invalid address is refused out loud', /“not-an-email” is not a valid email address\./.test(h.text()));
    h.input().props.onChangeText('hr@nordex.com,');
    await advance(10);
    ok('a separator commits the address as a chip', /hr@nordex\.com/.test(h.text()) && h.input().props.value === '');
    ok('…and Send is enabled', h.sendBtn().props.disabled === false);
    const remove = findOne(h.c.tree, (n) => n.type === 'TouchableOpacity' && n.props.accessibilityLabel === 'Remove hr@nordex.com');
    await h.press(remove);
    ok('the chip can be removed', !/hr@nordex\.com/.test(h.text()));
    ok('nothing was sent while editing recipients', h.sends().length === 0);
    h.c.unmount();
  }

  console.log('── 5. ⚠️ the Download rule on the phone: a locked account sees the paywall, not a request ──');
  {
    const h = await openSend({ locked: true });
    ok('the letter row carries the padlock', /Paid plans/.test(h.text()));
    await h.press(h.sendBtn());
    ok('⚠️ Send opens the paywall', h.paywall().props.visible === true);
    ok('⚠️ …and made NO send request', h.sends().length === 0);
    ok('…the paywall is for the letter\'s employer', h.paywall().props.employer === 'Nordex');
    h.c.unmount();
  }
  {
    // The phone read "unlocked" on opening; by the Send the account is locked (a lapsed plan): the server is the authority.
    let reads = 0;
    const h = await openSend({ api: {
      state: () => jsonRes(200, reads++ === 0 ? OPEN : SHUT),
      send: () => jsonRes(202, { jobId: 'job-1' }), status: () => jsonRes(200, { status: 'failed', reason: 'paid_required', error: 'no' }),
    } });
    await h.press(h.sendBtn());
    await advance(3000);
    ok('a server 403 (the authority) opens the paywall too', h.paywall().props.visible === true && h.sends().length === 1);
    h.c.unmount();
  }

  console.log('── 6. the happy path ──');
  {
    const h = await openSend({ api: { status: () => jsonRes(200, { status: 'completed', data: { success: true, provider: 'google', from: 'rishi.work@gmail.com', to: ['tom@nordex.com'], charged: false, sentAt: 'x' } }) } });
    await h.press(h.sendBtn());
    const s = h.sends()[0];
    ok('one POST /send', h.sends().length === 1);
    ok('…carrying the message, the design on screen and the page layout', s && s.body.to.join() === 'tom@nordex.com' && /Quality Inspector/.test(s.body.subject)
      && /AI NOTE/.test(s.body.body) && s.body.template === 'exec_leader' && s.body.mode === 'onepage', s && s.body);
    ok('…the attachments as the server reads them', s && JSON.stringify(s.body.letter) === '{"source":"doc"}' && JSON.stringify(s.body.resume) === '{"source":"tailored","docId":30}');
    ok('⚠️ …as a server job with an idempotency key', s && s.body.__async === true && /^ls-/.test(s.body.clientBuildId));
    ok('while it runs the button says Sending…', h.sendBtn().props.accessibilityLabel === 'Sending…');
    await advance(3000);
    ok('the job is polled until it says completed', calls.some((x) => x.url === '/job-status/job-1'));
    ok('then: Application sent, from which address, into the Sent folder', /Application sent/.test(h.text()) && /Sent from rishi\.work@gmail\.com to tom@nordex\.com/.test(h.text()) && /Gmail Sent folder/.test(h.text()));
    ok('the job is marked Applied in the Job Hub (the posting link)', applied.length === 1 && applied[0][0] === 'https://jobs.nordex.com/9');
    ok('the saved draft is cleared', !Object.keys(store).some((k) => /^letterSendDraft/.test(k)));
    ok('the button is Done now', h.sendBtn().props.accessibilityLabel === 'Done');
    await h.press(h.sendBtn());
    ok('…which leaves the page', pushes.includes('back'));
    h.c.unmount();
  }

  console.log('── 7. ⚠️ one email, never two: the Send id across retries ──');
  {
    const h = await openSend({ api: { throwOn: /\/send$/ } });
    await h.press(h.sendBtn());
    await advance(10);
    const first = h.sends()[0].body.clientBuildId;
    ok('a dropped connection says to check the Sent folder', /No connection/.test(h.text()) && /Sent folder/.test(h.text()));
    api.throwOn = null;
    await h.press(h.btn(/^Try again$/));
    await advance(3000);
    const second = h.sends()[1] && h.sends()[1].body.clientBuildId;
    ok('⚠️ the retry re-uses the SAME id (it joins the job that may already have mailed)', second === first, [first, second]);
    h.c.unmount();
  }
  {
    let n = 0;
    const h = await openSend({ api: { status: () => (n++ === 0
      ? jsonRes(200, { status: 'failed', reason: 'provider_busy', error: 'Gmail is busy right now. Try again in a minute. Nothing was sent and nothing was charged.' })
      : jsonRes(200, { status: 'completed', data: { success: true, provider: 'google', to: ['tom@nordex.com'] } })) } });
    await h.press(h.sendBtn());
    await advance(3000);
    ok('a definite failure is shown with the server\'s words', /Gmail is busy/.test(h.text()) && /Nothing was sent and nothing was charged/.test(h.text()));
    const first = h.sends()[0].body.clientBuildId;
    await h.press(h.btn(/^Try again$/));
    await advance(3000);
    ok('⚠️ …and its retry gets a NEW id (the old one would return the failed job)', h.sends()[1] && h.sends()[1].body.clientBuildId !== first);
    ok('…which then succeeds', /Application sent/.test(h.text()));
    h.c.unmount();
  }
  {
    const h = await openSend({ api: { status: () => jsonRes(200, { status: 'failed', reason: 'reconnect', error: 'Gmail needs you to sign in again. Tap Reconnect, then send. Nothing was sent and nothing was charged.' }) } });
    await h.press(h.sendBtn());
    await advance(3000);
    ok('a reconnect failure offers Reconnect Gmail right there', !!h.btn(/^Reconnect Gmail$/));
    ok('…and the mailbox card stops saying Connected', !/Connected/.test(textOf(findOne(h.c.tree, (n) => n.type === 'LinearGradient' && /SEND/.test(textOf(n))))));
    h.c.unmount();
  }

  console.log('── 8. an older server, and a letter that is gone ──');
  {
    const h = await openSend({ api: { draft: () => jsonRes(404, {}) } });
    ok('⚠️ an HTML 404 on the draft → "not available yet" with the Download way out, never "deleted"',
      /Sending is not available yet/.test(h.text()) && !!h.btn(/^Back to Download$/) && !/no longer saved/.test(h.text()));
    ok('…and no crash, no send', h.sends().length === 0);
    h.c.unmount();
  }
  {
    const h = await openSend({ api: { draft: () => jsonRes(404, { success: false, reason: 'gone' }) } });
    ok('a 404 that SAYS gone → the letter is gone', /This letter is gone/.test(h.text()) && /no longer saved/.test(h.text()));
    h.c.unmount();
  }
  {
    const h = await openSend({ api: { send: () => jsonRes(404, {}) } });
    await h.press(h.sendBtn());
    ok('⚠️ an older server on SEND → the same plain message, no crash', /Sending is not available yet/.test(h.text()) && !!h.btn(/^Back to Download$/));
    h.c.unmount();
  }

  console.log('── 9. ⚠️ the AI never overwrites the user ──');
  {
    let release;
    const late = new Promise((r) => { release = r; });
    const h = await openSend({ api: { body: () => late.then(() => jsonRes(200, { success: true, body: 'LATE AI NOTE that would overwrite', source: 'ai' })) } });
    ok('while the note is written, a placeholder says so', /Writing a short note from your letter…/.test(h.text()));
    ok('…and the message cannot be edited under it', (h.section('MESSAGE').props.actions && findAll(h.section('MESSAGE').props.actions, (n) => n.props && n.props.disabled === true).length === 2));
    release();
    await advance(10);
    // edit first, THEN a late answer: simulate by editing, then asking the AI again (Rewrite asks first).
    const sec = h.section('MESSAGE');
    const editBtn = findOne(sec.props.actions, (n) => n.type === 'TouchableOpacity' && /Edit/.test(textOf(n)));
    await h.press(editBtn);
    const box = findOne(h.c.tree, (n) => n.type === 'TextInput' && n.props.multiline);
    box.props.onChangeText('MY OWN WORDS, thank you.');
    await advance(10);
    h.section('MESSAGE').props.onDone();
    await advance(10);
    ok('the user\'s words are the message', /MY OWN WORDS/.test(h.text()) && /Your message\./.test(h.text()));
    const rw = findOne(h.section('MESSAGE').props.actions, (n) => n.props && n.props.accessibilityLabel === 'Rewrite the message');
    await h.press(rw);
    ok('⚠️ Rewrite asks before replacing their words', alerts.some((a) => a.title === 'Write a new message?'));
    ok('…and nothing replaced them yet', /MY OWN WORDS/.test(h.text()));
    await advance(1000);
    const saved = JSON.parse(store['letterSendDraft:v1:12:2026-09-19T10:00:00.000Z'] || '{}');
    ok('their words are kept on the phone', saved.body === 'MY OWN WORDS, thank you.' && saved.source === 'user');
    h.c.unmount();
    // Re-open: their words come back and the AI is NOT asked again.
    const h2 = await openSend({ store });
    ok('⚠️ reopening restores their words and does not call the AI again', /MY OWN WORDS/.test(h2.text()) && !calls.some((x) => /email-body/.test(x.url)));
    h2.c.unmount();
  }

  console.log('── 10. the attachment sheet ──');
  {
    const h = await openSend();
    await h.press(findAll(h.c.tree, (n) => n.type === 'TouchableOpacity' && /^Change/.test(textOf(n)))[1]);
    const sheet = findOne(h.c.tree, (n) => n.type === 'SmartAttachSheet');
    ok('Change on the résumé opens the smart upload sheet', !!sheet && sheet.props.visible === true && sheet.props.title === 'Attach a résumé');
    const keys = sheet.props.options.map((o) => o.key);
    ok('…offering the tailored one, the usual one, and none (+ the device row inside the sheet)', JSON.stringify(keys) === JSON.stringify(['tailored', 'builder', 'none']), keys);
    sheet.props.onPick('builder');
    await advance(10);
    ok('picking the usual résumé attaches it', /Your résumé/.test(h.text()) && !findOne(h.c.tree, (n) => n.type === 'SmartAttachSheet').props.visible);
    await h.press(h.sendBtn());
    ok('…and that is what is sent', h.sends()[0] && JSON.stringify(h.sends()[0].body.resume) === '{"source":"builder"}');
    h.c.unmount();
  }

  // ── The review's findings (2026-09-19), one scenario each ──────────────────────────────────────────────────────────
  console.log('── 11. the new pure rules ──');
  {
    const acct = { provider: 'google', ready: true, reconnect: false, address: null };
    const base = { to: [], subject: 's', body: 'b', account: acct, busy: false, hasLetter: true };
    ok('canSend: an address typed but not yet a chip counts (Send commits it)', L.canSend({ ...base, typed: 'hr@x.com' }).ok === true);
    ok('canSend: …a blank one does not', L.canSend({ ...base, typed: '   ' }).why === 'Add at least one email address.');
    ok('⚠️ canSend: a file still uploading blocks Send, and says so', L.canSend({ ...base, to: ['a@b.co'], uploading: true }).ok === false
      && /upload/i.test(L.canSend({ ...base, to: ['a@b.co'], uploading: true }).why));
    ok('saysResumeAttached: the template\'s and the usual phrasings', ['My cover letter and résumé are attached to this email.', 'Please find attached my CV and cover letter.',
      'I have enclosed my resume.', 'Attached are my cover letter and curriculum vitae.'].every(L.saysResumeAttached));
    ok('saysResumeAttached: a letter-only note, and "CVApplyr", are not', !['My cover letter is attached to this email.', 'Sent with CVApplyr — attached is my letter.', ''].some(L.saysResumeAttached));
    const req = { to: ['a@b.co'], subject: 'S', body: 'B', template: 't', mode: 'onepage', letter: { source: 'doc' }, resume: { source: 'builder', option: { id: 'builder' } } };
    const fp = L.sendFingerprint(req);
    ok('sendFingerprint: the same message → the same print (address case ignored)', fp === L.sendFingerprint({ ...req, to: ['A@B.co'] }));
    ok('⚠️ sendFingerprint: any change to what the recruiter gets → a different print',
      [{ to: ['c@d.co'] }, { subject: 'S2' }, { body: 'B2' }, { template: 'u' }, { mode: 'a4' }, { resume: { source: 'none' } }, { letter: { source: 'file', file: { fileId: 'x' } } }]
        .every((d) => L.sendFingerprint({ ...req, ...d }) !== fp));
    const t0 = 1_000_000_000_000;
    const p = L.parsePending(JSON.stringify({ id: 'ls-1', fp, to: ['a@b.co', 'junk'], jobId: 'job-9', at: t0 }), t0 + 1000);
    ok('parsePending: reads a stored Send (invalid addresses dropped)', p && p.id === 'ls-1' && p.jobId === 'job-9' && p.to.join() === 'a@b.co' && p.ambiguous === false, p);
    ok('parsePending: junk / too old → nothing', L.parsePending('{', t0) === null && L.parsePending(JSON.stringify({ id: 'x', fp, at: t0 }), t0 + L.PENDING_TTL_MS + 1) === null);
    ok('⚠️ parsePending: an id with no job, past the server\'s dedupe window, can no longer join → ambiguous',
      L.parsePending(JSON.stringify({ id: 'x', fp, at: t0 }), t0 + L.JOIN_WINDOW_MS + 1).ambiguous === true);
    ok('canJoin: only the SAME message, inside the window, not ambiguous', L.canJoin(p, fp, t0 + 1000) && !L.canJoin(p, 'other', t0 + 1000)
      && !L.canJoin(p, fp, t0 + L.JOIN_WINDOW_MS + 1) && !L.canJoin({ ...p, ambiguous: true }, fp, t0) && !L.canJoin(null, fp, t0));
    ok('⚠️ failureAction: a request that can only fail the same way is never offered "Try again"',
      ['too_big', 'bad_file', 'bad_recipient', 'bad_recipients', 'unknown_outcome', 'bad_request', 'too_many', 'no_mail_account'].every((r) => L.failureAction(r) !== 'retry'));
    ok('failureAction: the fixes', L.failureAction('too_big') === 'attachments' && L.failureAction('bad_recipient') === 'recipients' && L.failureAction('unknown_outcome') === 'send_again'
      && L.failureAction('provider_busy') === 'retry' && L.failureAction('network') === 'retry' && L.failureAction('quota_exhausted') === 'plans');
    ok('⚠️ unknown_outcome never claims nothing was sent — it points at the Sent folder, and says nothing was charged',
      !/Nothing was sent/.test(L.reasonMessage('unknown_outcome').message) && /Sent folder/.test(L.reasonMessage('unknown_outcome').message) && /Nothing was charged/.test(L.reasonMessage('unknown_outcome').message));
  }

  console.log('── 12. ⚠️ a file still uploading: Send waits for it ──');
  {
    let release;
    const held = new Promise((r) => { release = r; });
    const h = await openSend({ api: { upload: () => held.then(() => jsonRes(200, { success: true, fileId: 'f-9', name: 'Mine.pdf', size: 4096, mime: 'application/pdf' })) } });
    await h.press(findAll(h.c.tree, (n) => n.type === 'TouchableOpacity' && /^Change/.test(textOf(n)))[0]);   // the letter's Change
    findOne(h.c.tree, (n) => n.type === 'SmartAttachSheet').props.onDevice({ uri: 'file:///x/Mine.pdf', name: 'Mine.pdf', mimeType: 'application/pdf' });
    await advance(10);
    ok('while the file uploads, Send is disabled and says why', h.sendBtn().props.disabled === true && /Waiting for your file to finish uploading/.test(h.text()));
    h.sendBtn().props.onPress();
    await advance(10);
    ok('⚠️ …and even a tap that gets through sends NOTHING (it would carry the file the row held before)', h.sends().length === 0);
    release();
    await advance(10);
    await h.press(h.sendBtn());
    ok('once it has arrived, Send carries THAT file', h.sends().length === 1 && JSON.stringify(h.sends()[0].body.letter) === '{"source":"file","fileId":"f-9"}', h.sends()[0] && h.sends()[0].body.letter);
    h.c.unmount();
  }

  console.log('── 13. ⚠️ leaving mid-send: Back asks, and coming back asks the JOB — it sends nothing ──');
  {
    const shared = {};
    const h = await openSend({ store: shared, api: { status: () => jsonRes(200, { status: 'processing' }) } });
    await h.press(h.sendBtn());
    await advance(10);
    ok('the Send is under way', h.sendBtn().props.accessibilityLabel === 'Sending…' && h.sends().length === 1);
    const pend = JSON.parse(shared['letterSendPending:v1:12'] || 'null');
    ok('⚠️ the pending Send is kept on the phone WITH its job id', pend && pend.jobId === 'job-1' && pend.id === h.sends()[0].body.clientBuildId && pend.to.join() === 'tom@nordex.com', pend);
    const back = findOne(h.c.tree, (n) => n.type === 'TouchableOpacity' && /Back/.test(textOf(n)));
    await h.press(back);
    const a = alerts.find((x) => x.title === 'Still sending');
    ok('⚠️ Back mid-send asks first (it does not just walk away)', !!a && !pushes.includes('back'));
    tapAlert(a, 'Leave');
    ok('…and Leave leaves', pushes.includes('back'));
    h.c.unmount();
    const h2 = await openSend({ store: shared, api: { status: () => jsonRes(200, { status: 'completed', data: { success: true, provider: 'google', from: 'rishi.work@gmail.com', recipients: 1, charged: false, sentAt: 'x' } }) } });
    await advance(3000);
    ok('⚠️ reopening sends NOTHING — it polls the job', h2.sends().length === 0 && calls.some((x) => x.url === '/job-status/job-1'));
    ok('…and shows what really happened, to the address THAT Send went to', /Application sent/.test(h2.text()) && /to tom@nordex\.com/.test(h2.text()));
    ok('…and clears the pending Send and the draft', !shared['letterSendPending:v1:12'] && !Object.keys(shared).some((k) => /^letterSendDraft/.test(k)));
    ok('…and does not ask the AI for a note meanwhile', !calls.some((x) => /email-body/.test(x.url)));
    h2.c.unmount();
  }

  console.log('── 14. ⚠️ an edited message never rides on the old Send id ──');
  {
    const h = await openSend({ api: { throwOn: /\/send$/ } });
    await h.press(h.sendBtn());
    await advance(10);
    const first = h.sends()[0].body.clientBuildId;
    ok('a lost connection: the card says to check the Sent folder', /No connection/.test(h.text()));
    // The user spots a typo: removes the address, adds the right one.
    await h.press(findOne(h.c.tree, (n) => n.type === 'TouchableOpacity' && n.props.accessibilityLabel === 'Remove tom@nordex.com'));
    h.input().props.onChangeText('john@nordex.com,');
    await advance(10);
    api.throwOn = null;
    alerts = [];
    await h.press(h.sendBtn());
    const ask = alerts.find((x) => x.title === 'Your last Send may have gone out');
    ok('⚠️ a DIFFERENT message after an unknown outcome asks first — and sends nothing yet', !!ask && h.sends().length === 1);
    tapAlert(ask, 'Send this one');
    await advance(3000);
    const second = h.sends()[1] && h.sends()[1].body;
    ok('⚠️ …then goes out under a NEW id (the old one would hand back the job that mailed the old message)', !!second && second.clientBuildId !== first && second.to.join() === 'john@nordex.com', second);
    ok('…and the page reports the address it really went to', /to john@nordex\.com/.test(h.text()) && !/to tom@nordex\.com/.test(h.text()));
    h.c.unmount();
  }

  console.log('── 15. ⚠️ the AI note still being written: Send asks, and a late note never replaces what was sent ──');
  {
    let release;
    const late = new Promise((r) => { release = r; });
    const h = await openSend({ api: { body: () => late.then(() => jsonRes(200, { success: true, body: 'LATE AI NOTE that was never sent, long enough to pass.', source: 'ai' })) } });
    ok('while it is written, the bar says so', /Still writing your message from the letter/.test(h.text()));
    await h.press(h.sendBtn());
    const ask = alerts.find((x) => x.title === 'Your message is still being written');
    ok('⚠️ Send asks before sending the standard note the user has not seen — nothing sent yet', !!ask && h.sends().length === 0);
    tapAlert(ask, 'Send the standard note');
    await advance(10);
    ok('"Send the standard note" sends exactly that', h.sends().length === 1 && h.sends()[0].body.body === DRAFT().bodies.withResume, h.sends()[0] && h.sends()[0].body.body);
    release();
    await advance(3000);
    ok('⚠️ the late AI note is dropped — the page shows the message that went out', /Application sent/.test(h.text()) && !/LATE AI NOTE/.test(h.text()) && /My cover letter and résumé are attached/.test(h.text()));
    h.c.unmount();
  }

  console.log('── 16. ⚠️ the message says what is attached ──');
  {
    const h = await openSend();
    ok('the AI note for the letter + résumé', /AI NOTE from the letter/.test(h.text()));
    await h.press(findOne(h.c.tree, (n) => n.type === 'TouchableOpacity' && n.props.accessibilityLabel === 'Remove the résumé'));
    await advance(10);
    const asked = calls.filter((x) => /email-body/.test(x.url)).map((x) => x.body && x.body.resume);
    ok('⚠️ the résumé taken off → the note is written again for the letter only (free)', JSON.stringify(asked) === JSON.stringify([true, false]) && /AI NOTE \(letter only\)/.test(h.text()), asked);
    h.c.unmount();
  }
  {
    const d = DRAFT(); d.resume = { options: [], default: null };
    const h = await openSend({ api: { draft: () => jsonRes(200, d), body: () => jsonRes(500, { success: false }) } });
    ok('⚠️ no résumé to attach → the standard note does not promise one', /My cover letter is attached to this email/.test(h.text()) && !/résumé are attached/.test(h.text()));
    ok('…and the AI was asked for a letter-only note', calls.some((x) => /email-body/.test(x.url) && x.body && x.body.resume === false));
    h.c.unmount();
  }
  {
    const h = await openSend({ api: { body: () => jsonRes(500, { success: false }) } });
    ok('the standard note with the résumé on', /My cover letter and résumé are attached/.test(h.text()));
    await h.press(findOne(h.c.tree, (n) => n.type === 'TouchableOpacity' && n.props.accessibilityLabel === 'Remove the résumé'));
    ok('…swaps to the letter-only one when the résumé is taken off', /My cover letter is attached to this email/.test(h.text()));
    // Their OWN words that promise a résumé, with none attached → asked, never rewritten.
    const sec = h.section('MESSAGE');
    await h.press(findOne(sec.props.actions, (n) => n.type === 'TouchableOpacity' && /Edit/.test(textOf(n))));
    findOne(h.c.tree, (n) => n.type === 'TextInput' && n.props.multiline).props.onChangeText('Hello, please find attached my CV. Rishi');
    await advance(10);
    h.section('MESSAGE').props.onDone();
    await advance(10);
    alerts = [];
    await h.press(h.sendBtn());
    const ask = alerts.find((x) => x.title === 'No résumé attached');
    ok('⚠️ their own words saying a CV is attached, none attached → asked first, nothing sent', !!ask && h.sends().length === 0 && /please find attached my CV/.test(h.text()));
    tapAlert(ask, 'Send anyway');
    await advance(10);
    ok('…"Send anyway" sends their words unchanged', h.sends().length === 1 && h.sends()[0].body.body === 'Hello, please find attached my CV. Rishi');
    h.c.unmount();
  }

  console.log('── 17. an address typed but not yet a chip ──');
  {
    const d = DRAFT(); d.recipients = { prefill: [], suggestions: [] };
    const h = await openSend({ api: { draft: () => jsonRes(200, d) } });
    h.input().props.onChangeText('hr@nordex.com');
    await advance(10);
    ok('⚠️ Send is enabled for the address on screen, and counts it', h.sendBtn().props.disabled === false && h.sendBtn().props.accessibilityLabel === 'Send to 1 recipient');
    await h.press(h.sendBtn());
    ok('…and sends to it', h.sends().length === 1 && h.sends()[0].body.to.join() === 'hr@nordex.com');
    h.c.unmount();
  }

  console.log('── 18. ⚠️ the paywall never loops ──');
  {
    // Metered, ONE plan download left, a two-file message: the server says quota_exhausted; the phone's state says
    // "unlocked" — the sheet would unlock itself and re-send into the same refusal, forever.
    const ONE_LEFT = { ...SHUT, metered: true, paid: true, remaining: 1 };
    const h = await openSend({ api: { state: () => jsonRes(200, ONE_LEFT), status: () => jsonRes(200, { status: 'failed', reason: 'quota_exhausted', error: 'Your plan has fewer downloads left than this message attaches (2 files we make). Remove the résumé or attach a file of your own, or get a one-employer pass. Nothing was sent and nothing was charged.' }) } });
    await h.press(h.sendBtn());
    await advance(3000);
    ok('⚠️ short by a file: no sheet (it would unlock itself), the card says it', h.paywall().props.visible === false && /fewer downloads left/.test(h.text()) && h.sends().length === 1);
    ok('…offering to change the attachments, not "Try again"', !!h.btn(/^Change attachments$/) && !h.btn(/^Try again$/));
    await advance(5000);
    ok('⚠️ …and no further request on its own', h.sends().length === 1);
    h.c.unmount();
  }
  {
    const h = await openSend({ locked: true, api: { status: () => jsonRes(200, { status: 'failed', reason: 'paid_required', error: 'no' }) } });
    await h.press(h.sendBtn());
    const sheet = h.paywall();
    ok('a locked account → the sheet (no request)', sheet.props.visible === true && h.sends().length === 0);
    const f1 = sheet.props.onUnlocked;
    await advance(10);
    ok('⚠️ onUnlocked is the SAME function across renders (the sheet re-runs its focus check when it changes)', h.paywall().props.onUnlocked === f1);
    // The sheet can say "unlocked" more than once in one opening (its focus check, then a purchase finishing) — and
    // the second can land AFTER the first re-send was already refused.
    f1(); f1();
    await advance(3000);
    f1();
    await advance(3000);
    ok('⚠️ unlocked → exactly ONE re-send, however often (and however late) the sheet says so', h.sends().length === 1, h.sends().length);
    ok('…and a refusal after coming THROUGH the sheet is said on the card — the sheet does not reopen', h.paywall().props.visible === false && /Part of the paid plans|no/.test(h.text()));
    await advance(5000);
    ok('…no loop', h.sends().length === 1);
    h.c.unmount();
  }

  console.log('── 19. ⚠️ a padlock only from a real answer ──');
  {
    const h = await openSend({ api: { state: () => jsonRes(500, {}) } });
    ok('the state could not be read → no padlock', !/Paid plans/.test(h.text()));
    await h.press(h.sendBtn());
    ok('⚠️ …and Send asks the SERVER instead of opening the paywall', h.paywall().props.visible === false && h.sends().length === 1);
    h.c.unmount();
  }

  console.log('── 20. ⚠️ unknown_outcome: never "nothing was sent", never a blind retry ──');
  {
    const msg = 'We could not confirm that Gmail sent your message — the connection dropped after it was handed over. Look in your Gmail Sent folder before sending again. Nothing was charged.';
    let n = 0;
    const h = await openSend({ api: { status: () => (n++ === 0
      ? jsonRes(200, { status: 'failed', reason: 'unknown_outcome', error: msg })
      : jsonRes(200, { status: 'completed', data: { success: true, provider: 'google' } })) } });
    await h.press(h.sendBtn());
    await advance(3000);
    const first = h.sends()[0].body.clientBuildId;
    ok('the card sends the user to their Sent folder, and does NOT say nothing was sent', /Sent folder/.test(h.text()) && !/Nothing was sent/.test(h.text()));
    ok('…its button is "Send again", not "Try again"', !!h.btn(/^Send again$/) && !h.btn(/^Try again$/));
    alerts = [];
    await h.press(h.btn(/^Send again$/));
    const ask = alerts.find((x) => x.title === 'Your last Send may have gone out');
    ok('⚠️ "Send again" asks first — even for the same message', !!ask && h.sends().length === 1);
    tapAlert(ask, 'Send this one');
    await advance(3000);
    ok('…then a NEW id (the old job only ever answers "unknown")', h.sends()[1] && h.sends()[1].body.clientBuildId !== first && /Application sent/.test(h.text()));
    h.c.unmount();
  }
  {
    const shared = { 'letterSendPending:v1:12': JSON.stringify({ id: 'ls-old', fp: 'x', to: ['tom@nordex.com'], jobId: null, at: now - 20 * 60 * 1000 }) };
    const h = await openSend({ store: shared });
    ok('a Send from an earlier visit that can no longer be joined → the Sent-folder card on opening', /Could not confirm the send/.test(h.text()) && !!h.btn(/^Send again$/));
    ok('…and nothing was sent by opening', h.sends().length === 0);
    h.c.unmount();
  }

  console.log('── 21. the fixes each failure names ──');
  for (const [reason, label] of [['too_big', 'Change attachments'], ['bad_file', 'Change attachments'], ['bad_recipient', 'Check the addresses'], ['provider_busy', 'Try again']]) {
    const h = await openSend({ api: { status: () => jsonRes(200, { status: 'failed', reason, error: `The ${reason} words.` }) } });
    await h.press(h.sendBtn());
    await advance(3000);
    ok(`${reason} → "${label}"${label === 'Try again' ? '' : ', never "Try again"'}`, !!h.btn(new RegExp(`^${label}$`)) && (label === 'Try again' || !h.btn(/^Try again$/)));
    if (label === 'Change attachments') {
      await h.press(h.btn(/^Change attachments$/));
      ok(`…${reason}: it opens the attachment sheet`, findOne(h.c.tree, (n) => n.type === 'SmartAttachSheet').props.visible === true);
    }
    h.c.unmount();
  }
  {
    const src = fs.readFileSync(SEND_SRC, 'utf8');
    ok('StyleSheet only: no static inline style objects (the shimmer widths moved into StyleSheet.create)', !/style=\{\[[^\]]*\{\s*width:\s*'/.test(src));
  }

  console.log('── 22. ⚠️ a CLASSIC letter (Job Hub / Review / old Home): the same page, the letter carried by every call ──');
  // 2026-09-20 (the completeness review): the preview opened without a docId has the same Download, so it has this Send.
  {
    const C = { coverLetterHtml: '<p>Dear Nordex team,</p><p>I fix turbines.</p>', companyName: 'Nordex SE', companyAddress: 'Hamburg', employer: 'Nordex',
      jobUrl: 'https://jobs.nordex.com/9', position: 'Service Technician', designName: 'Modern Minimal' };
    ok('parseClassicLetter: a real letter, capped and whitelisted', (() => {
      const p = L.parseClassicLetter(JSON.stringify({ ...C, sender: { name: 'Mallory' }, jobUrl: 'javascript:alert(1)' }));
      return p && p.coverLetterHtml === C.coverLetterHtml && p.employer === 'Nordex' && p.jobUrl === undefined && !('sender' in p) && p.designName === 'Modern Minimal';
    })());
    ok('parseClassicLetter: nothing, junk, no text, or over the server\'s cap → null',
      [null, '', '{', '[]', JSON.stringify({ coverLetterHtml: '  ' }), JSON.stringify({ coverLetterHtml: 'x'.repeat(L.CLASSIC_HTML_MAX + 1) })].every((v) => L.parseClassicLetter(v) === null));
    const k1 = L.classicLetterKey(L.parseClassicLetter(JSON.stringify(C)));
    ok('classicLetterKey: the same letter → the same key; another letter → another', k1 === L.classicLetterKey(L.parseClassicLetter(JSON.stringify(C)))
      && k1 !== L.classicLetterKey(L.parseClassicLetter(JSON.stringify({ ...C, coverLetterHtml: '<p>Other</p>' }))) && /^c-/.test(k1));
    ok('…and the design name is not part of it (a label, not the letter)', k1 === L.classicLetterKey(L.parseClassicLetter(JSON.stringify({ ...C, designName: 'Other' }))));
    ok('letterKeyOf: a saved letter\'s id, or the classic key', L.letterKeyOf(12) === '12' && L.letterKeyOf({ classic: L.parseClassicLetter(JSON.stringify(C)) }) === k1);
    ok('the draft and pending keys take either', L.draftKey(k1, '') === `letterSendDraft:v1:${k1}:` && L.pendingKey(k1) === `letterSendPending:v1:${k1}`);
    // ⚠️ review 2026-09-20: a PENDING Send is kept per LETTER, and a classic letter's content is only its VERSION —
    // keyed by the content, regenerating the Job Hub's letter hid a Send whose outcome was unknown.
    const idOf = (c) => L.classicIdentityKey(L.parseClassicLetter(JSON.stringify(c)));
    const idA = idOf(C);
    ok('⚠️ classicIdentityKey: the same POSTING → the same key, whatever the letter now says',
      idA === idOf({ ...C, coverLetterHtml: '<p>A rewritten letter for the same job.</p>', companyName: 'Nordex' }) && /^cj-/.test(idA), idA);
    ok('…a different posting → a different key', idA !== idOf({ ...C, jobUrl: 'https://jobs.nordex.com/10' }));
    const noUrl = { ...C, jobUrl: undefined };
    ok('…no posting → the employer', /^ce-/.test(idOf(noUrl)) && idOf(noUrl) === idOf({ ...noUrl, coverLetterHtml: '<p>Another letter for Nordex.</p>' })
      && idOf(noUrl) !== idOf({ ...noUrl, employer: 'Siemens', companyName: 'Siemens AG' }), idOf(noUrl));
    const bare = { coverLetterHtml: C.coverLetterHtml };
    ok('…neither → the letter itself (never a key two letters share)', idOf(bare) === L.classicLetterKey(L.parseClassicLetter(JSON.stringify(bare))));
    ok('pendingLetterKeyOf: a saved letter by id, a classic one by its posting', L.pendingLetterKeyOf(12) === '12'
      && L.pendingLetterKeyOf({ classic: L.parseClassicLetter(JSON.stringify(C)) }) === idA);
    const fpReq = { to: ['tom@nordex.com'], subject: 's', body: 'b', template: 't', mode: 'a4', letter: { source: 'doc' }, resume: { source: 'none' } };
    ok('⚠️ …so the letter\'s own text is part of a Send\'s fingerprint: a regenerated letter never re-uses the kept id',
      L.sendFingerprint(fpReq, k1) !== L.sendFingerprint(fpReq, 'c-other') && L.sendFingerprint(fpReq, k1) === L.sendFingerprint(fpReq, k1));
    ok('no_letter: says nothing was sent or charged, and its button goes back', /Nothing was sent and nothing was charged/.test(L.reasonMessage('no_letter').message) && L.failureAction('no_letter') === 'back');
    ok('classify: the server\'s 400 no_letter passes through', L.classify(400, { reason: 'no_letter' }) === 'no_letter');

    const classicDraft = () => { const d = DRAFT(); d.letter = { docId: null, classic: true, employer: 'Nordex', companyName: 'Nordex SE', position: 'Service Technician', jobUrl: C.jobUrl, updatedAt: null }; return jsonRes(200, d); };
    const h = await openSend({ params: { classic: '1', template: 'ats_pro', mode: 'a4' }, store: { [L.CLASSIC_SEND_KEY]: JSON.stringify(C) }, api: { draft: classicDraft } });
    const urls = calls.map((x) => `${x.method} ${x.url}`);
    ok('⚠️ opening it: the classic draft (POST — the letter travels), the free note and the padlock — nothing else',
      JSON.stringify(urls) === JSON.stringify(['POST /employer-docs/classic/email-draft', 'POST /employer-docs/classic/email-body', 'GET /downloads/state?employer=Nordex']), urls);
    const wire = calls[0] && calls[0].body && calls[0].body.classic;
    const bodyWire = calls[1] && calls[1].body && calls[1].body.classic;
    ok('…each carrying the letter as the server reads it — never the design name', !!wire && wire.coverLetterHtml === C.coverLetterHtml && wire.employer === 'Nordex'
      && wire.jobUrl === C.jobUrl && wire.position === 'Service Technician' && !('designName' in wire) && !!bodyWire && bodyWire.coverLetterHtml === C.coverLetterHtml, calls[0] && calls[0].body);
    const t = h.text();
    ok('the letter row names the design the preview showed, and the layout picked there', /Modern Minimal · A4 pages · PDF/.test(t), t.slice(0, 400));
    ok('…with no saved-card thumbnail (a classic letter\'s pages were never stored)', !findOne(h.c.tree, (n) => n.type === 'Image'));
    await advance(1000);
    ok('the draft is kept on the phone under the letter\'s content key', typeof store[`letterSendDraft:v1:${k1}:`] === 'string', Object.keys(store));
    await h.press(h.sendBtn());
    const s = h.sends()[0];
    ok('⚠️ Send → POST /employer-docs/classic/send with the letter, the design and the layout', !!s && s.url === '/employer-docs/classic/send' && s.body.classic
      && s.body.classic.coverLetterHtml === C.coverLetterHtml && s.body.template === 'ats_pro' && s.body.mode === 'a4' && JSON.stringify(s.body.letter) === '{"source":"doc"}', s && s.body);
    ok('⚠️ …as a job with an idempotency key, kept on the phone under the letter\'s POSTING until the answer', s && s.body.__async === true && typeof store[`letterSendPending:v1:${idA}`] === 'string');
    await advance(3000);
    ok('then: Application sent', /Application sent/.test(h.text()));
    ok('the Job Hub posting is marked Applied', applied.length === 1 && applied[0][0] === C.jobUrl, applied);
    ok('the pending Send and the draft are cleared', !store[`letterSendPending:v1:${idA}`] && !Object.keys(store).some((k) => /^letterSendDraft/.test(k)), Object.keys(store));
    h.c.unmount();
  }
  {
    // ⚠️ THE REGENERATED LETTER (review, 2026-09-20). A Send for this posting never came back (no job id, past the join
    // window: 'ambiguous'). The user regenerates the letter and opens Send again — the unresolved Send must still be
    // there, or a second application goes to the recruiter with no warning.
    const C = { coverLetterHtml: '<p>Dear Nordex team,</p><p>I fix turbines.</p>', companyName: 'Nordex SE', companyAddress: 'Hamburg', employer: 'Nordex',
      jobUrl: 'https://jobs.nordex.com/9', position: 'Service Technician', designName: 'Modern Minimal' };
    const REGEN = { ...C, coverLetterHtml: '<p>Dear Nordex team,</p><p>I service and repair wind turbines.</p>' };
    const idA = L.classicIdentityKey(L.parseClassicLetter(JSON.stringify(C)));
    const lost = { id: 'ls-lost', fp: 'an-older-message', to: ['tom@nordex.com'], jobId: null, at: now - 60_000, ambiguous: true };
    const classicDraft = () => { const d = DRAFT(); d.letter = { docId: null, classic: true, employer: 'Nordex', companyName: 'Nordex SE', position: 'Service Technician', jobUrl: C.jobUrl, updatedAt: null }; return jsonRes(200, d); };
    const h = await openSend({
      params: { classic: '1', template: 'ats_pro', mode: 'a4' },
      store: { [L.CLASSIC_SEND_KEY]: JSON.stringify(REGEN), [`letterSendPending:v1:${idA}`]: JSON.stringify(lost) },
      api: { draft: classicDraft },
    });
    ok('⚠️ the unresolved Send is found for the REGENERATED letter (its posting is the key)', /Could not confirm the send/.test(h.text()), h.text().slice(0, 300));
    await h.press(h.sendBtn());
    const asked = alerts.find((a) => /Your last Send may have gone out/.test(a.title));
    ok('⚠️ …so Send asks before a second message goes out', !!asked && h.sends().length === 0, { alerts: alerts.map((a) => a.title), sends: h.sends().length });
    tapAlert(asked, 'Send this one');
    await advance(10);
    const s = h.sends()[0];
    ok('…and "Send this one" sends the NEW letter under a NEW id', !!s && s.body.classic.coverLetterHtml === REGEN.coverLetterHtml && s.body.clientBuildId !== lost.id, s && s.body.clientBuildId);
    h.c.unmount();
  }
  {
    const C = { coverLetterHtml: '<p>Dear team</p>', companyName: 'Nordex SE', employer: 'Nordex' };
    const classicDraft = () => { const d = DRAFT(); d.letter = { docId: null, classic: true, employer: 'Nordex', companyName: 'Nordex SE', position: '', jobUrl: '', updatedAt: null }; return jsonRes(200, d); };
    const h = await openSend({ params: { classic: '1', template: 'ats_pro', mode: 'onepage' }, store: { [L.CLASSIC_SEND_KEY]: JSON.stringify(C) }, api: { draft: classicDraft } });
    await h.press(h.btn(/^Change/));
    const sheet = findOne(h.c.tree, (n) => n.type === 'SmartAttachSheet');
    await sheet.props.onDevice({ uri: 'file:///cv.pdf', name: 'cv.pdf', mimeType: 'application/pdf' });
    await advance(10);
    ok('a file from the phone for a classic letter goes to /classic/send-files', calls.some((x) => x.method === 'POST' && x.url === '/employer-docs/classic/send-files'), calls.map((x) => x.url));
    h.c.unmount();
  }
  {
    const h = await openSend({ params: { classic: '1', template: 'ats_pro', mode: 'onepage' }, store: {} });
    ok('⚠️ a classic page that finds no letter says so — and asks the server NOTHING', /No letter to send/.test(h.text()) && calls.length === 0, calls);
    ok('…its only way is back (no retry into the same nothing)', !!h.btn(/^Go Back$/) && !h.btn(/^Try again$/));
    h.c.unmount();
  }
  {
    const h = await openSend({ params: { classic: '1' }, store: { [L.CLASSIC_SEND_KEY]: JSON.stringify({ coverLetterHtml: '<p>x</p>' }) }, api: { draft: () => jsonRes(404, {}) } });
    ok('⚠️ a server without the classic routes (an HTML 404) → "not available yet" with the Download way out', /Sending is not available yet/.test(h.text()) && !!h.btn(/^Back to Download$/));
    h.c.unmount();
  }

  Date.now = realDateNow;
  console.log(`\nletter send (app): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('SUITE THREW', e); process.exit(2); });
