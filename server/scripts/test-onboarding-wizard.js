// THE MAKE YOURS WIZARD — THE PHONE'S HALF (2026-09-19): MobileApp/services/profileSetupService.ts run for real,
// plus the wizard's, the signature studio's and Home's rules read from their (comment-stripped) sources.
//
//   node server/scripts/test-onboarding-wizard.js
//
// The owner's report, on a brand-new account (user 616): drew a signature, added a photo and a CV, tapped Build —
// "then it started saying building resume then throw me on home page with option of continue from where you left
// and again took me to the signature page... not saved signature and then resume"; two résumé units were charged
// 34 s apart for two EMPTY résumés; and after a restart "it did not show me pick where you left option".
// The server half is pinned by test-onboarding-progress.js, test-resume-text.js and T24 of
// test-single-purchase-flow.js. This file pins what the app does with it:
//   1. every wizard write carries X-CV-Source: onboarding (how the server tells the wizard from Account Settings);
//   2. ONE tap = ONE clientBuildId; a POST with no answer is retried with the SAME id — after asking the server
//      whether that build already landed or is running; the deadline is "Keep waiting" on the SAME job;
//   3. refusals come back with their reason (thin_input, cv_not_ready, cv_unreadable, quota…), never as "try again";
//   4. Home's button: "Pick up where you left off" while the server says the wizard is open — even when every file
//      is on disk — until a wizard build is charged and saved, or Account Settings completes the profile;
//   5. the wizard: Next commits a drawn signature and waits; a skip is stored; the CV must be READ before Next;
//      notes are saved as typed; a running build is rejoined, never started again.
// ⚠️ It lives in server/scripts because every new file under MobileApp/ must be TypeScript (T23 set the precedent).
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'MobileApp');

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 400) : '')); }
};
const R = (p) => fs.readFileSync(path.join(APP, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
/** One function's body by name (brace-matched), whatever shape it is declared in. '' when absent. */
const fnBodyOf = (src, name) => {
  const m = new RegExp('(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+function|function|const)\\s+' + name + '\\b').exec(src);
  if (!m) return '';
  let i = src.indexOf('{', m.index);
  if (i < 0) return '';
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  return '';
};

(async () => {
  // ── the service, transpiled and run with a fake network, a fake clock and fake storage ─────────────────────────
  const tsc = require(path.join(APP, 'node_modules', 'typescript'));
  const js = tsc.transpileModule(R('services/profileSetupService.ts'), {
    compilerOptions: { module: tsc.ModuleKind.CommonJS, target: tsc.ScriptTarget.ES2020, esModuleInterop: true }, fileName: 'profileSetupService.ts',
  }).outputText;
  const clock = { now: 1_800_000_000_000 };
  const VDate = class extends Date { constructor(...a) { super(...(a.length ? a : [clock.now])); } static now() { return clock.now; } };
  const vTimeout = (fn, ms) => { clock.now += Number(ms) || 0; setImmediate(fn); return 0; };
  const store = new Map();
  const who = { account: 'u:616' };
  const net = { calls: [], route: null };
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fakeFetch = async (url, init = {}) => {
    const call = { method: init.method || 'GET', url, headers: init.headers || {}, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body };
    net.calls.push(call);
    const a = net.route ? net.route(call) : null;
    if (a instanceof Error) throw a;
    return a || resp(404, {});
  };
  class FakeForm { constructor() { this.parts = []; } append(k, v) { this.parts.push([k, v]); } }
  const MOCKS = {
    'expo-secure-store': { getItemAsync: async () => JSON.stringify({ token: 'tok', id: 616 }) },
    '@react-native-async-storage/async-storage': { __esModule: true, default: {
      getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => { store.set(k, v); }, removeItem: async (k) => { store.delete(k); },
    } },
    '../config': { API_BASE: 'https://api.test/api' },
    './homeAddEmployer': { signedInAccount: async () => who.account },
    './employerHomeService': { deviceHeaders: async () => ({ 'x-device-id': 'dev-616' }) },
  };
  const mod = { exports: {} };
  const req = (id) => { if (id in MOCKS) return MOCKS[id]; throw new Error('unmocked require: ' + id); };
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, setTimeout: vTimeout, clearTimeout() {}, Date: VDate, JSON, Math, Promise,
    String, Number, Array, Object, Error, encodeURIComponent, fetch: fakeFetch, FormData: FakeForm });
  vm.runInContext(`(function (module, exports, require) {\n${js}\n})`, ctx)(mod, mod.exports, req);
  const S = mod.exports;
  const posts = (re) => net.calls.filter((c) => c.method === 'POST' && re.test(c.url));
  const hdr = (c) => c && c.headers && c.headers['X-CV-Source'];

  console.log('\n── 1 · every wizard write says it is the wizard\'s (X-CV-Source: onboarding) ──');
  net.calls.length = 0;
  net.route = (c) => (c.method === 'POST' ? resp(200, { success: true, format: 'DOCX', wizard: { state: 'open' } }) : null);
  await S.saveDetails({ fullName: 'Rishi Samadhiya', phone: '+91 98765 43210', address: 'Pune, India' });
  await S.uploadPhoto('file:///p.jpg');
  await S.uploadSignature('file:///s.png');
  const upDocx = await S.uploadResumeFile('file:///cv.docx', 'My CV.docx', 'application/octet-stream');
  await S.saveOnboarding({ skipped: { photo: true } });
  const writes = net.calls.filter((c) => c.method === 'POST');
  ok('details, photo, signature, CV and progress all carry X-CV-Source: onboarding (Account Settings in App.js never does)',
    writes.length === 5 && writes.every((c) => hdr(c) === 'onboarding'), writes.map((c) => [c.url.split('/api')[1], hdr(c)]));
  const cvPart = writes[3].body && writes[3].body.parts && writes[3].body.parts[0];
  ok('⚠️ a .docx the picker called "octet-stream" (iOS does) is sent as a Word file, and the answer carries its format',
    cvPart && cvPart[0] === 'resume' && /wordprocessingml/.test(cvPart[1].type) && upDocx.ok && upDocx.format === 'DOCX', { cvPart, upDocx });
  ok('progress goes to POST /users/profile/onboarding with what was skipped', /\/users\/profile\/onboarding$/.test(writes[4].url) && writes[4].body.skipped.photo === true);
  net.route = () => resp(415, { error: 'We can read PDF, Word (.docx or .doc)… Please save yours as a PDF or .docx and upload it again.', reason: 'unsupported_format' });
  const refused = await S.uploadResumeFile('file:///cv.pages', 'cv.pages', '');
  ok('a refused CV (415) comes back with the SERVER\'s sentence — which formats work — and its reason', !refused.ok && /Word \(\.docx or \.doc\)/.test(refused.message) && refused.reason === 'unsupported_format', refused);

  console.log('\n── 2 · ⚠️ one tap, one build, one charge ──');
  const INPUT = { name: 'Rishi', email: 'r@e.st', phone: '1', location: 'Pune, India', rawText: 'Please build my resume from the CV I uploaded.', includeUploadedResume: true, fromUpload: true };
  let polls = 0;
  net.calls.length = 0;
  net.route = (c) => {
    if (/generate-ai$/.test(c.url)) return resp(202, { jobId: 'job-1', status: 'pending' });
    if (/job-status\/job-1$/.test(c.url)) return ++polls < 3 ? resp(200, { status: 'processing', data: { stage: 'writing', label: 'Writing your resume', pct: 38 } }) : resp(200, { status: 'completed', data: { resumeData: { v: 'built' } } });
    return null;
  };
  const stages = [];
  const b1 = await S.generateResume(INPUT, 'wz-tap-1', (st) => stages.push(st.stage), () => false);
  const p1 = posts(/generate-ai$/)[0];
  ok('⚠️ the build POST carries the tap\'s clientBuildId, source "onboarding", fromUpload, __async — and the wizard header',
    p1 && p1.body.clientBuildId === 'wz-tap-1' && p1.body.source === 'onboarding' && p1.body.fromUpload === true && p1.body.__async === true && hdr(p1) === 'onboarding', p1 && p1.body);
  ok('…followed to its résumé, with the server\'s stages on the way', b1.kind === 'done' && b1.resumeData.v === 'built' && stages.includes('writing'), { b1, stages });
  ok('⚠️ …and it carries x-device-id like every Home generation (the free 3 + 3 are one per DEVICE; a new account\'s first spend is here)',
    p1 && p1.headers['x-device-id'] === 'dev-616', p1 && p1.headers);

  // ⚠️ Review, 2026-09-19: an optional short note on the upload lane went ALONE as the text, and the server's
  // twenty-character minimum refused it ("Please provide more detail…") although the CV held everything.
  const tNote = S.wizardBuildText('PM roles', true, 'Rishi');
  ok('⚠️ from the CV, the "build it from my CV" sentence ALWAYS goes — a short note is put in front of it, never sent alone',
    tNote === 'PM roles\n\nPlease build my resume from the CV I uploaded for Rishi.' && tNote.trim().length >= 20, tNote);
  ok('…no note → the sentence alone; typed out → exactly the notes (trimmed)',
    S.wizardBuildText('  ', true, '') === 'Please build my resume from the CV I uploaded.' && S.wizardBuildText('  3 years at Acme  ', false, 'R') === '3 years at Acme');
  ok('the wizard builds its text with it', /const text = wizardBuildText\(rawText, fromCv, fullName\);/.test(strip(R('app/(onboarding)/index.tsx'))));

  net.route = (c) => (/generate-ai$/.test(c.url) ? new Error('Network request failed') : null);
  const b2 = await S.generateResume(INPUT, 'wz-tap-2', undefined, () => false);
  ok('⚠️ a POST that got NO answer → failed with retrySame (the build may be running: Try again repeats THIS id)', b2.kind === 'failed' && b2.retrySame === true, b2);
  net.route = (c) => (/\/users\/profile$/.test(c.url) ? resp(200, { setup: { wizard: { state: 'finished', build: { jobId: 'job-x', status: 'completed' } } } }) : null);
  const on1 = await S.buildOnServer();
  net.route = (c) => (/\/users\/profile$/.test(c.url) ? resp(200, { setup: { wizard: { state: 'open', build: { jobId: 'job-run', status: 'running' } } } }) : null);
  const on2 = await S.buildOnServer();
  net.route = (c) => (/\/users\/profile$/.test(c.url) ? resp(200, { setup: { wizard: { state: 'open', build: null } } }) : null);
  const on3 = await S.buildOnServer();
  ok('⚠️ …and BEFORE that retry re-POSTs, the server is asked: already landed → done; running → rejoin it; nothing → POST the same id',
    on1 && on1.done === true && on2 && on2.jobId === 'job-run' && on3 === null, { on1, on2, on3 });

  net.calls.length = 0;
  net.route = (c) => (/job-status\/job-slow$/.test(c.url) ? resp(200, { status: 'processing' }) : /generate-ai$/.test(c.url) ? resp(202, { jobId: 'job-slow' }) : null);
  const t0 = clock.now;
  const b3 = await S.generateResume(INPUT, 'wz-tap-3', undefined, () => false);
  ok('a build still running at the 6-minute deadline → "late" with ITS job (Keep waiting follows it)', b3.kind === 'late' && b3.jobId === 'job-slow' && clock.now - t0 >= 6 * 60 * 1000, b3);
  net.calls.length = 0;
  net.route = (c) => (/job-status\/job-slow$/.test(c.url) ? resp(200, { status: 'completed', data: { resumeData: { v: 'late-but-landed' } } }) : null);
  const k3 = await S.joinBuild('job-slow', undefined, () => false);
  ok('⚠️ Keep waiting / a reopened wizard FOLLOWS the job — not one POST, not a second job', k3.kind === 'done' && k3.resumeData.v === 'late-but-landed' && posts(/generate-ai$/).length === 0, { k3, calls: net.calls.map((c) => c.method + ' ' + c.url) });
  net.calls.length = 0;
  net.route = (c) => (/job-status/.test(c.url) ? resp(200, { status: 'processing' }) : null);
  const k4 = await S.joinBuild('job-left', undefined, () => true);
  ok('the screen was left → stops at once ("late": the server keeps going, reopening rejoins), no status read more', k4.kind === 'late' && net.calls.length === 0, net.calls);

  const refusal = async (route) => { net.route = route; return S.generateResume(INPUT, 'wz-r', undefined, () => false); };
  const jobFails = (reason, error) => (c) => (/generate-ai$/.test(c.url) ? resp(202, { jobId: 'job-r' }) : /job-status/.test(c.url) ? resp(200, { status: 'failed', reason, error }) : null);
  const r1 = await refusal(jobFails('thin_input', 'We could not find any work history… nothing was charged.'));
  const r2 = await refusal(jobFails('cv_unreadable', 'We could not read the CV you uploaded… Nothing was charged.'));
  const r3 = await refusal(jobFails('cv_not_ready', 'We are still reading your CV. Nothing was charged.'));
  const r4 = await refusal(jobFails('quota_exhausted', 'Your plan allowance was used up.'));
  const r5 = await refusal(() => resp(402, { error: 'You have used your included resume generations.', reason: 'quota_exhausted' }));
  const r6 = await refusal(jobFails(null, 'We could not finish generating your resume.'));
  ok('⚠️ every refusal comes back AS a refusal with its reason and the server\'s sentence (thin / unreadable / not ready / quota, job or POST)',
    r1.kind === 'refused' && r1.reason === 'thin_input' && /nothing was charged/.test(r1.message)
    && r2.kind === 'refused' && r2.reason === 'cv_unreadable' && r3.kind === 'refused' && r3.reason === 'cv_not_ready'
    && r4.kind === 'refused' && r4.reason === 'quota_exhausted' && r5.kind === 'refused' && r5.reason === 'quota_exhausted', { r1, r2, r3, r4, r5 });
  ok('…and a real failure is a failure whose Try again is a NEW build (not the same id)', r6.kind === 'failed' && r6.retrySame === false, r6);
  ok('a fresh id per tap', S.newWizardBuildId() !== S.newWizardBuildId() && /^wz-/.test(S.newWizardBuildId()));

  console.log('\n── 3 · the CV is followed until it is READ; the setup is cached per account ──');
  let reads = 0;
  net.route = (c) => (/\/users\/profile$/.test(c.url)
    ? resp(200, { setup: { resume: true, wizard: { state: 'open', cv: { ext: 'DOCX', status: ++reads < 3 ? 'pending' : 'done', error: null } } } }) : null);
  const ticks = [];
  const cvEnd = await S.waitForResumeParse((cv) => ticks.push(cv.status), () => false);
  ok('waitForResumeParse follows "pending" until "done", reporting each read', cvEnd && cvEnd.status === 'done' && ticks.join(',') === 'pending,pending,done', { cvEnd, ticks });
  // ⚠️ Review: a server with no wizard state (before Migration 047, a rollback, another environment) never says a CV
  // was read — following it for three minutes left the upload lane's Next disabled for good.
  let oldReads = 0;
  net.route = (c) => (/\/users\/profile$/.test(c.url) ? (oldReads++, resp(200, { setup: { resume: true, complete: false } })) : null);
  const tOld = clock.now;
  const cvOld = await S.waitForResumeParse(undefined, () => false);
  ok('⚠️ …against an OLDER server (no setup.wizard) it stops after ONE read, not three minutes of polling', cvOld === null && oldReads === 1 && clock.now - tOld < 5000, { cvOld, oldReads });
  net.route = (c) => (/\/users\/profile$/.test(c.url) ? resp(200, { setup: { profile: true, complete: true, wizard: { state: 'open', left: ['building your resume'] } } }) : null);
  who.account = 'u:616';
  await S.fetchProfileSnapshot();
  const mine = await S.cachedSetup();
  who.account = 'u:700';
  const theirs = await S.cachedSetup();
  who.account = 'u:616';
  ok('⚠️ the last setup is cached PER ACCOUNT — the next account to sign in never inherits a "Pick up" button',
    mine && mine.wizard && mine.wizard.state === 'open' && theirs === null, { mine, theirs });
  S.markProfileChanged();
  ok('markProfileChanged is consumed once (Home reloads its pages once after a build)', S.consumeProfileChanged() === true && S.consumeProfileChanged() === false);

  console.log('\n── 4 · ⚠️ Home\'s button: "Pick up where you left off" while the wizard is open ──');
  const base = { profile: true, resume: true, photo: true, signature: true, complete: true };
  const m616 = S.makeYoursOf({ ...base, wizard: { state: 'open', left: ['building your resume'] } });
  ok('⚠️ USER 616: every file on disk (setup.complete) but the wizard OPEN → NOT complete, "building your resume" left → "Pick up where you left off"',
    m616.complete === false && m616.started === true && JSON.stringify(m616.left) === '["building your resume"]' && m616.wizardOpen, m616);
  const fin = S.makeYoursOf({ ...base, photo: false, complete: false, wizard: { state: 'finished', left: [] } });
  ok('a wizard FINISHED by its build → complete (Customize), even with a skipped photo', fin.complete === true, fin);
  const closed = S.makeYoursOf({ ...base, wizard: { state: 'closed', left: [] } });
  const legacy = S.makeYoursOf({ profile: true, resume: false, photo: true, signature: false, complete: false });
  ok('closed by Account Settings → complete; no wizard state at all (an older server) → the old rule, naming the missing pieces',
    closed.complete === true && legacy.complete === false && JSON.stringify(legacy.left) === '["your signature","your experience"]', { closed, legacy });
  // ⚠️ Review: a real résumé, details, photo and signature but no date of birth (optional in the wizard) — the checklist
  // says incomplete, the wizard says nothing is left. "Pick up" would only open on "Your resume is ready".
  const none0 = S.makeYoursOf({ ...base, complete: false, profile: false, wizard: { state: 'none', left: [] } });
  const none1 = S.makeYoursOf({ ...base, complete: false, signature: false, wizard: { state: 'none', left: ['your signature'] } });
  const open0 = S.makeYoursOf({ ...base, wizard: { state: 'open', left: ['building your resume'] } });
  ok('⚠️ no progress row but NOTHING left by the wizard\'s rules → complete (Customize), not a "Pick up" that leads nowhere',
    none0.complete === true && none0.wizardOpen === false, none0);
  ok('…with something left it is the old rule (Pick up, naming it); an OPEN wizard is never complete',
    none1.complete === false && JSON.stringify(none1.left) === '["your signature"]' && open0.complete === false, { none1, open0 });

  // ⚠️ REVIEW ROUND 2, 2026-09-19: the 'closed' fixtures above had left: [] and setup.complete: true — a combination the
  // server never produces for a wizard closed before a build. These come from the SERVER's own wizardStateOf.
  const dbCfg = require.resolve(path.join(ROOT, 'db-config.js'));
  require.cache[dbCfg] = { id: dbCfg, filename: dbCfg, loaded: true, exports: { get: async () => null, run: async () => ({}), query: async () => [] } };
  const OB = require(path.join(ROOT, 'server', 'services', 'onboardingProgress.js'));
  const PRIYA = { fullName: 'Priya Sharma', phone: '+91 98765 43210', address: 'Pune, India' };
  const READ = { status: 'done', error: null };
  // Photo skipped and no date of birth (both optional in the wizard), a signature, a CV read, no build — then Account
  // Settings completed it: closed. The checklist's booleans for the same account: profile false (no DOB), photo false.
  const wzClosed = OB.wizardStateOf({ row: { skipped: { photo: true }, closed_at: new Date(), closed_by: 'account_settings' }, profile: PRIYA,
    files: { photo: false, signature: true, resume: true }, parse: READ });
  const mClosed = S.makeYoursOf({ profile: false, resume: true, photo: false, signature: true, complete: false, wizard: wzClosed });
  ok('⚠️ a REAL closed wizard (server: state "closed", "building your resume" left; checklist: complete FALSE) → complete, nothing left — no "Pick up"',
    wzClosed.state === 'closed' && JSON.stringify(wzClosed.left) === '["building your resume"]' && OB.profileCompleteOf(wzClosed)
    && mClosed.complete === true && mClosed.left.length === 0 && mClosed.wizardOpen === false, { wzClosed: { state: wzClosed.state, left: wzClosed.left }, mClosed });
  // The same account before Account Settings closed it: open, at Build.
  const wzOpen = OB.wizardStateOf({ row: { skipped: { photo: true } }, profile: PRIYA, files: { photo: false, signature: true, resume: true }, parse: READ });
  const mOpen = S.makeYoursOf({ profile: false, resume: true, photo: false, signature: true, complete: false, wizard: wzOpen });
  ok('…while it was still OPEN: "Pick up", naming exactly what the wizard opens on ("building your resume"), never "your details and a photo"',
    wzOpen.state === 'open' && wzOpen.stepKey === 'build' && mOpen.complete === false && mOpen.started === true
    && JSON.stringify(mOpen.left) === '["building your resume"]', { mOpen, step: wzOpen.stepKey });
  // No progress row (never wrote through the wizard), no date of birth, nothing built: the old rule decides "complete"
  // (false here), but the sentence names where the wizard will open — not the checklist's missing date of birth.
  const wzNone = OB.wizardStateOf({ row: null, profile: PRIYA, files: { photo: true, signature: true, resume: true }, parse: READ });
  const mNone = S.makeYoursOf({ profile: false, resume: true, photo: true, signature: true, complete: false, wizard: wzNone });
  ok('…and with no progress row: not complete (the old rule), and `left` is the wizard\'s own ("building your resume", where it opens)',
    wzNone.state === 'none' && wzNone.stepKey === 'build' && mNone.complete === false && JSON.stringify(mNone.left) === '["building your resume"]', mNone);
  const mNoneDone = S.makeYoursOf({ ...base, wizard: wzNone });
  ok('…a no-row account the checklist calls complete keeps "Customize", and nothing is named as left (the calm button)',
    mNoneDone.complete === true && mNoneDone.left.length === 0, mNoneDone);

  const home = strip(R('components/employer-home/EmployerHome.tsx'));
  ok('Home draws the button from makeYoursOf(setup) — the rule above, run, not re-derived', /const \{ complete, started, left \} = makeYoursOf\(setup\);/.test(home));
  ok('"Pick up where you left off" when something is left and it was started; the wizard is the destination', /left\.length && started \? 'Pick up where you left off' : 'Make your Resume'/.test(home) && /nav\(\)\?\.push\?\.\('\/\(onboarding\)'\)/.test(home));
  ok('⚠️ setup is re-read on EVERY focus, outside load()\'s 60 s throttle (coming back within a minute showed the old "things left")',
    /const refreshSetup = useStableFn\(/.test(home) && /load\(\)\.then\(\(r\) => \{ if \(r === undefined && focusCount\.current > 1\) refreshSetup\(\); \}\)/.test(home));
  ok('…back from a wizard that built the résumé, the pages are reloaded too (consumeProfileChanged → load(true, true))', /if \(!loaders && consumeProfileChanged\(\)\) load\(true, true\);/.test(home));
  ok('⚠️ a failed read never hides the button (only an answer replaces an answer), and the cached setup paints first',
    /loadSetup\(\)\.then\(\(st\) => \{ if \(st && alive\.current\) setSetup\(st\); \}\)/.test(home) && !/loadSetup\(\)\.then\(\(st\) => setSetup\(st\)\)/.test(home)
    && /cachedSetup\(\)\.then\(\(st\) => \{ if \(st && alive\.current\) setSetup\(\(cur\) => cur \|\| st\); \}\)/.test(home));

  console.log('\n── 5 · the wizard: nothing it was given is asked for twice ──');
  const wiz = strip(R('app/(onboarding)/index.tsx'));
  const leaveSign = fnBodyOf(wiz, 'leaveSign');
  ok('⚠️ Next off the photo & signature step COMMITS the unsaved signature (the hand on screen too, while none is saved) and stays put if that upload failed',
    /const c = await commitSign\(!\(signUri \|\| snap\?\.signature\)\);/.test(leaveSign) && /if \(c === null \|\| c === 'failed'\) return;/.test(leaveSign)
    && leaveSign.indexOf('commitSign(') < leaveSign.indexOf('onFromSign()'));
  ok('…and whatever is still missing is stored as SKIPPED on the server (kept until the server has it)', /noteSkips\(c === 'saved'\);/.test(leaveSign)
    && /pendingSkips\.current = \{ \.\.\.\(pendingSkips\.current \|\| \{\}\), \.\.\.sk \};\s*flushSkips\(\);/.test(fnBodyOf(wiz, 'noteSkips'))
    && /const r = await saveOnboarding\(\{ skipped: sk \}\);/.test(fnBodyOf(wiz, 'flushSkips')));
  ok('⚠️ "Next" goes through leaveSign, "Skip for now" through skipSign — Skip is NOT Next any more',
    /if \(step === 1\) \{ await leaveSign\(\); return; \}/.test(wiz) && /onPress=\{skipSign\}/.test(wiz) && !/onPress=\{leaveSign\}/.test(wiz));
  const leaveTo = fnBodyOf(wiz, 'leaveTo');
  ok('⚠️ …and the back arrow and the step dots are no side door: they commit the signature too (and save valid details)',
    /await commitSign\(false\)/.test(leaveTo) && /if \(c === null \|\| c === 'failed'\) return;/.test(leaveTo) && /await saveYou\(\)/.test(leaveTo)
    && /leaveTo\(step - 1\)/.test(wiz) && /leaveTo\(i\)/.test(wiz) && !/goTo\(step - 1\)/.test(wiz));

  // ⚠️ REVIEW ROUND 4, 2026-09-20: "Skip for now" WAS leaveSign, and its commit counted the hand the gallery opens with
  // ticked — Skip uploaded a cursive signature the user had just turned down (skipped stayed false, every letter was
  // signed with it); offline the upload failed and Skip did nothing. The back arrow, the dots and the leave guard
  // uploaded the same untapped hand. The four exits are RUN here against a pad driven by the real sigToCommit.
  const studioSrc = R('components/onboarding/SignatureStudio.tsx');
  const stc0 = fnBodyOf(studioSrc, 'sigToCommit');
  const realSigToCommit = stc0 ? vm.runInNewContext('(' + tsc.transpileModule('function sigToCommit(s: any, handOnScreen = false) ' + stc0,
    { compilerOptions: { target: tsc.ScriptTarget.ES2020 } }).outputText.trim().replace(/;$/, '') + ')') : null;
  const tsFn = (params, body, isAsync) => tsc.transpileModule(`(${isAsync ? 'async ' : ''}function (${params}) ${body})`,
    { compilerOptions: { target: tsc.ScriptTarget.ES2020 } }).outputText.trim().replace(/;$/, '');
  const solBody = fnBodyOf(wiz, 'skipsOnLeave');
  const skipsOnLeave = solBody ? vm.runInNewContext(tsFn('have, signedNow', solBody)) : null;
  ok('skipsOnLeave (what leaving the step stores as skipped) is a pure function in the wizard', typeof skipsOnLeave === 'function'
    && /function skipsOnLeave\(have: SignStepHas, signedNow: boolean\): Partial<SignStepHas> \| null \{/.test(R('app/(onboarding)/index.tsx')));
  if (typeof skipsOnLeave === 'function') {
    ok('…nothing saved → photo AND signature skipped; a signature committed on the way out is not a skip; everything there → nothing stored',
      JSON.stringify(skipsOnLeave({ photo: false, signature: false }, false)) === '{"photo":true,"signature":true}'
      && JSON.stringify(skipsOnLeave({ photo: false, signature: false }, true)) === '{"photo":true}'
      && JSON.stringify(skipsOnLeave({ photo: true, signature: false }, false)) === '{"signature":true}'
      && skipsOnLeave({ photo: true, signature: true }, false) === null && skipsOnLeave({ photo: true, signature: false }, true) === null);
  }
  /** A pad in the wizard: the real sigToCommit decides what a commit saves; the upload answers as told —
   *  true 'saved', false 'failed', or 'stuck' (the pad could not hand it over). `gate`: a promise the commit waits on. */
  const padStudio = (st, uploadOk, gate) => {
    const log = { commits: [], uploads: [] };
    const current = { commit: async (opts) => {
      log.commits.push(opts || null);
      if (gate) await gate;
      const which = realSigToCommit(st, !!(opts && opts.handOnScreen));
      if (!which) return 'clean';
      log.uploads.push(which);
      return uploadOk === 'stuck' ? 'stuck' : uploadOk ? 'saved' : 'failed';
    } };
    return { studio: { current }, log };
  };
  // The gallery as it opens: "Pick a hand", hand #1 ticked, nobody tapped anything, nothing saved yet.
  const GALLERY = { mode: 'type', drawnUnsaved: false, typeTapped: false, name: 'Priya Sharma', hands: 6, typeKey: 'Priya Sharma|0', savedTypeKey: null };
  // The step-1 exits, each cut out of the wizard and compiled into ONE sandbox (they call each other), the rest stood in.
  const EXITS = [['commitSign', 'handOnScreen', true], ['onFromSign', '', false], ['padStuck', 'goOn', false],
    ['skipSign', '', false], ['leaveSign', '', true], ['leaveTo', 'i', true]];
  const sandbox = (st, uploadOk, extra, gate) => {
    const { studio: stu, log } = padStudio(st, uploadOk, gate);
    const spy = { goTo: [], noteSkips: [], setDone: [], alerts: [], busy: [] };
    const ctx = vm.createContext({ studio: stu, step: 1, canAdvance: true, LAST: 3, builtResume: false, signUri: null,
      snap: { profileImage: null, signature: null }, committing: { current: false }, setSigBusy: (v) => spy.busy.push(v),
      goTo: (i) => spy.goTo.push(i), setDone: (v) => spy.setDone.push(v), noteSkips: (v) => spy.noteSkips.push(v),
      saveYou: async () => true, Alert: { alert: (title, msg, buttons) => spy.alerts.push({ title, msg, buttons }) }, ...(extra || {}) });
    for (const [n, params, isAsync] of EXITS) {
      const body = fnBodyOf(wiz, n);
      if (body) ctx[n] = vm.runInContext(tsFn(params, body, isAsync), ctx);
    }
    return { ctx, log, spy };
  };
  const runExit = async (name, params, st, uploadOk, args, extra) => {
    const { ctx, log, spy } = sandbox(st, uploadOk, extra);
    // A missing handler is a failed assertion below (empty logs, no goTo), not a harness crash.
    if (typeof ctx[name] !== 'function') return { log: { commits: [null], uploads: ['<no ' + name + ' in the wizard>'] }, spy };
    await ctx[name](...(args || []));
    return { log, spy };
  };
  if (typeof realSigToCommit === 'function') {
    const skipOff = await runExit('skipSign', '', GALLERY, false);
    ok('⚠️ THE ROUND-4 CASE: Skip on the gallery as it opens (hand #1 ticked, no tap) uploads NOTHING — not even a commit()',
      skipOff.log.commits.length === 0 && skipOff.log.uploads.length === 0, skipOff);
    ok('…stores what is missing as skipped (noteSkips with no signature saved) and ALWAYS advances — offline too (no upload to fail)',
      JSON.stringify(skipOff.spy.noteSkips) === '[false]' && JSON.stringify(skipOff.spy.goTo) === '[2]', skipOff.spy);
    const skipInk = await runExit('skipSign', '', { ...GALLERY, mode: 'draw', drawnUnsaved: true }, true);
    ok('…and Skip with ink on the pad is still a skip (nothing uploaded, advances)', skipInk.log.uploads.length === 0 && JSON.stringify(skipInk.spy.goTo) === '[2]', skipInk);
    const nextHand = await runExit('leaveSign', '', GALLERY, true);
    ok('Next on the same untapped hand SAVES it (Next is choosing it — the round-2 rule stands), then advances with no signature skip',
      JSON.stringify(nextHand.log.commits) === '[{"handOnScreen":true}]' && JSON.stringify(nextHand.log.uploads) === '["type"]'
      && JSON.stringify(nextHand.spy.noteSkips) === '[true]' && JSON.stringify(nextHand.spy.goTo) === '[2]', nextHand);
    const nextOff = await runExit('leaveSign', '', GALLERY, false);
    ok('…Next whose upload failed stays on the step (the signature it chose is not dropped as a skip)', nextOff.spy.goTo.length === 0 && nextOff.spy.noteSkips.length === 0, nextOff);
    const backHand = await runExit('leaveTo', 'i', GALLERY, true, [0]);
    ok('⚠️ the back arrow / a dot on the untapped hand uploads NOTHING (going back to fix a name is not choosing hand #1)',
      backHand.log.uploads.length === 0 && JSON.stringify(backHand.log.commits) === '[{"handOnScreen":false}]' && JSON.stringify(backHand.spy.goTo) === '[0]', backHand);
    const backTap = await runExit('leaveTo', 'i', { ...GALLERY, typeTapped: true, typeKey: 'Priya Sharma|2' }, true, [0]);
    const backInk = await runExit('leaveTo', 'i', { ...GALLERY, mode: 'draw', drawnUnsaved: true }, true, [0]);
    ok('…but a hand they TAPPED, or ink they DREW, is saved on the way back (no side door past the save)',
      JSON.stringify(backTap.log.uploads) === '["type"]' && JSON.stringify(backInk.log.uploads) === '["draw"]'
      && JSON.stringify(backTap.spy.goTo) === '[0]' && JSON.stringify(backInk.spy.goTo) === '[0]', { backTap, backInk });

    // ⚠️ REVIEW, 2026-09-20 — a SAVED signature, "Sign again", a look at "Pick a hand", Next: hand #1 was uploaded over
    // their own drawn signature. With one on file an empty commit skips nothing, so the untapped hand is not a choice.
    const SAVED = { snap: { profileImage: 'https://x.test/p.jpg', signature: 'https://x.test/sig.png' } };
    const keepMine = await runExit('leaveSign', '', GALLERY, true, [], SAVED);
    ok('⚠️ Next after "Sign again" on the untapped hand, with a signature SAVED → NOTHING uploaded (their own signature stays), and on',
      JSON.stringify(keepMine.log.commits) === '[{"handOnScreen":false}]' && keepMine.log.uploads.length === 0
      && JSON.stringify(keepMine.spy.noteSkips) === '[false]' && JSON.stringify(keepMine.spy.goTo) === '[2]', keepMine);
    const keepMine2 = await runExit('leaveSign', '', GALLERY, true, [], { signUri: 'file:///cache/signature_1.png' });
    const replaceInk = await runExit('leaveSign', '', { ...GALLERY, mode: 'draw', drawnUnsaved: true }, true, [], SAVED);
    const replaceTap = await runExit('leaveSign', '', { ...GALLERY, typeTapped: true, typeKey: 'Priya Sharma|2' }, true, [], SAVED);
    ok('…the same for one saved THIS session; while ink they DREW, or a hand they TAPPED, does replace it (that is what "Sign again" is for)',
      keepMine2.log.uploads.length === 0 && JSON.stringify(replaceInk.log.uploads) === '["draw"]' && JSON.stringify(replaceTap.log.uploads) === '["type"]',
      { keepMine2: keepMine2.log, replaceInk: replaceInk.log, replaceTap: replaceTap.log });

    // ⚠️ REVIEW, 2026-09-20 — a résumé with content already on file: the server counts experience AND build as done, so
    // leaving the sign step FINISHES the wizard there. The client walked on to "Your experience" and a paid "Rebuild".
    const PRIYA_S = { fullName: 'Priya Sharma', phone: '+91 98765 43210', address: 'Pune, India' };
    const serverAfterSkip = OB.wizardStateOf({ row: { skipped: { photo: true, signature: true } }, profile: PRIYA_S, files: { photo: false, signature: false }, builtResume: true });
    const serverBefore = OB.wizardStateOf({ row: { skipped: {} }, profile: PRIYA_S, files: { photo: false, signature: false }, builtResume: true });
    const skipBuilt = await runExit('skipSign', '', GALLERY, true, [], { builtResume: true });
    const nextBuilt = await runExit('leaveSign', '', GALLERY, true, [], { builtResume: true });
    ok('⚠️ THE SERVER: a built résumé, the wizard open on step 1 → after the skip it is FINISHED, nothing left',
      serverBefore.state === 'open' && serverBefore.stepKey === 'sign' && serverAfterSkip.state === 'finished' && serverAfterSkip.left.length === 0,
      { before: serverBefore.state, after: serverAfterSkip.state });
    ok('⚠️ …and so the CLIENT: Skip and Next both land on "Your resume is ready" (done, the last step) — never on Experience / Build',
      JSON.stringify(skipBuilt.spy.setDone) === '[true]' && JSON.stringify(skipBuilt.spy.goTo) === '[3]'
      && JSON.stringify(nextBuilt.spy.setDone) === '[true]' && JSON.stringify(nextBuilt.spy.goTo) === '[3]' && JSON.stringify(nextBuilt.log.uploads) === '["type"]',
      { skip: skipBuilt.spy, next: nextBuilt.spy });
    const serverNoBuilt = OB.wizardStateOf({ row: { skipped: { photo: true, signature: true } }, profile: PRIYA_S, files: { photo: false, signature: false } });
    ok('…without one, both the server and the client go on to the experience step (step 2), nothing marked done',
      serverNoBuilt.stepKey === 'experience' && serverNoBuilt.step === 2 && JSON.stringify(skipOff.spy.goTo) === '[2]' && skipOff.spy.setDone.length === 0
      && nextHand.spy.setDone.length === 0, serverNoBuilt.stepKey);

    // ⚠️ REVIEW, 2026-09-20 — a pad that could not hand the signature over ('stuck': the page stopped answering, its
    // process died) used to make Next and the back arrow just stop, with no word at all.
    const stuckNext = await runExit('leaveSign', '', { ...GALLERY, mode: 'draw', drawnUnsaved: true }, 'stuck');
    const a0 = stuckNext.spy.alerts[0];
    ok('⚠️ Next on a STUCK pad says so ("not saved"), stays put — and offers "Try again" / "Continue without it"',
      stuckNext.spy.alerts.length === 1 && /not saved/.test(a0.title) && stuckNext.spy.goTo.length === 0 && stuckNext.spy.noteSkips.length === 0
      && JSON.stringify(a0.buttons.map((b) => b.text)) === '["Try again","Continue without it"]', stuckNext.spy);
    if (a0 && a0.buttons[1] && a0.buttons[1].onPress) a0.buttons[1].onPress();
    ok('…"Continue without it" is a SKIP: nothing uploaded, what is missing stored as skipped, on to the next step',
      JSON.stringify(stuckNext.spy.noteSkips) === '[false]' && JSON.stringify(stuckNext.spy.goTo) === '[2]', stuckNext.spy);
    const stuckBack = await runExit('leaveTo', 'i', { ...GALLERY, mode: 'draw', drawnUnsaved: true }, 'stuck', [0]);
    const b0 = stuckBack.spy.alerts[0];
    const beforeGo = stuckBack.spy.goTo.length;
    if (b0 && b0.buttons[1] && b0.buttons[1].onPress) b0.buttons[1].onPress();
    ok('…the back arrow / a dot too: it says so, and "Continue without it" goes where they asked (no skip invented)',
      stuckBack.spy.alerts.length === 1 && beforeGo === 0 && JSON.stringify(stuckBack.spy.goTo) === '[0]' && stuckBack.spy.noteSkips.length === 0, stuckBack.spy);
    const upFail = await runExit('leaveSign', '', { ...GALLERY, mode: 'draw', drawnUnsaved: true }, false);
    ok('…while a failed UPLOAD adds no second alert (saveSignature already showed one)', upFail.spy.alerts.length === 0 && upFail.spy.goTo.length === 0, upFail.spy);

    // One commit at a time, and the footer is busy through it (Next looked dead through the export and upload).
    let open;
    const gate = new Promise((r) => { open = r; });
    const twice = sandbox({ ...GALLERY, mode: 'draw', drawnUnsaved: true }, true, {}, gate);
    const first = twice.ctx.leaveSign();
    const second = twice.ctx.leaveSign();
    // Raced, never awaited blindly: a second commit would wait on the same gate, and a hung test must fail, not vanish.
    const secondSaw = await Promise.race([second.then(() => 'returned'), new Promise((r) => setImmediate(() => r('still waiting')))]);
    const midBusy = JSON.stringify(twice.spy.busy);
    const midCommits = twice.log.commits.length;
    open();
    await first;
    await second;
    ok('⚠️ a second Next while the first is committing returns at once and does nothing (one commit, one upload, one step on); busy on, then off',
      secondSaw === 'returned' && midCommits === 1 && twice.log.commits.length === 1 && JSON.stringify(twice.log.uploads) === '["draw"]'
      && JSON.stringify(twice.spy.goTo) === '[2]' && midBusy === '[true]' && JSON.stringify(twice.spy.busy) === '[true,false]',
      { secondSaw, midCommits, log: twice.log, spy: twice.spy, midBusy });
  }
  ok('⚠️ only Next can count the untapped hand: every other commitSign call passes false',
    (wiz.match(/commitSign\((?!false\))/g) || []).length === 1 && /commitSign\(!\(signUri \|\| snap\?\.signature\)\)/.test(wiz)
    && /return await studio\.current\.commit\(\{ handOnScreen \}\);/.test(fnBodyOf(wiz, 'commitSign')));
  ok('the footer shows the commit: Next spins and is disabled, Skip / the back arrow / the dots wait for it',
    /disabled=\{!canAdvance \|\| saving \|\| sigBusy\}/.test(wiz) && /\{saving \|\| sigBusy\s*\?/.test(wiz) && /disabled=\{saving \|\| sigBusy\} onPress=\{skipSign\}/.test(wiz)
    && /if \(!saving && !sigBusy\) leaveTo\(step - 1\);/.test(wiz) && /!saving && !sigBusy\) leaveTo\(i\);/.test(wiz));
  ok('⚠️ "Sign again" can be taken back ("Keep my saved one"), and leaving the step closes the studio (the saved image shows next time)',
    /\{hasSign && redoSign && \(/.test(wiz) && /onPress=\{\(\) => \{ setRedoSign\(false\); setSigDirty\(false\); \}\}/.test(wiz) && /Keep my saved one/.test(wiz)
    && /useEffect\(\(\) => \{ if \(step !== 1\) \{ setSigDirty\(false\); setRedoSign\(false\); \} \}, \[step\]\);/.test(wiz));
  const nsBody = fnBodyOf(wiz, 'noteSkips');
  const retryMs = (/const SKIP_RETRY_MS = (\[[\d, ]+\]);/.exec(R('app/(onboarding)/index.tsx')) || [])[1];
  /** noteSkips + flushSkips + saveProgress, cut out of the wizard and run against a server that answers as told. */
  const skipBox = (answers, extra) => {
    const sent = [], delays = [];
    let skippedState = { photo: false, signature: false };
    const ctx = vm.createContext({
      skipsOnLeave, photoUri: null, signUri: null, snap: { profileImage: null, signature: null }, SKIP_RETRY_MS: JSON.parse(retryMs || '[]'),
      pendingSkips: { current: null }, flushingSkips: { current: false }, gone: { current: false },
      setSkipped: (f) => { skippedState = f(skippedState); },
      saveOnboarding: async (p) => { sent.push(JSON.parse(JSON.stringify(p))); const a = answers.length ? answers.shift() : true; return { ok: a, wizard: null }; },
      setTimeout: (fn, ms) => { delays.push(ms); setImmediate(fn); return 0; }, ...(extra || {}),
    });
    for (const [n, params, isAsync] of [['flushSkips', '', true], ['saveProgress', 'patch', false], ['noteSkips', 'signedNow', false]]) {
      const body = fnBodyOf(wiz, n);
      if (body) ctx[n] = vm.runInContext(tsFn(params, body, isAsync), ctx);
    }
    return { ctx, sent, delays, state: () => skippedState };
  };
  // Until the retry loop has ended (its backoff timers run at once here), not a guessed number of milliseconds.
  const drain = async (box) => { for (let i = 0; i < 2000 && box.ctx.flushingSkips.current; i++) await new Promise((r) => setImmediate(r)); };
  if (nsBody && typeof skipsOnLeave === 'function' && retryMs) {
    const b1 = skipBox([true]);
    b1.ctx.noteSkips(false);
    await drain(b1);
    ok('⚠️ Skip on a fresh account STORES signature:true (and photo:true) on the server — a skip the server knows is a skip after a restart',
      JSON.stringify(b1.sent) === '[{"skipped":{"photo":true,"signature":true}}]' && b1.state().signature === true && b1.state().photo === true
      && b1.ctx.pendingSkips.current === null, { sent: b1.sent, state: b1.state() });
    // ⚠️ REVIEW, 2026-09-20: that one POST was fire-and-forget — offline or on a 5xx the skip was simply lost, and the
    // next launch reopened the step they had skipped ("Pick up where you left off · a photo, your signature").
    const b2 = skipBox([false, false, true]);
    b2.ctx.noteSkips(false);
    await drain(b2);
    ok('⚠️ a skip whose POST FAILED is sent again, with backoff, until the server has it',
      b2.sent.length === 3 && b2.sent.every((p) => p.skipped.signature === true) && JSON.stringify(b2.delays) === JSON.stringify(JSON.parse(retryMs).slice(0, 2))
      && b2.ctx.pendingSkips.current === null, { sent: b2.sent, delays: b2.delays });
    const b3 = skipBox([false, false, false, false, true]);
    b3.ctx.noteSkips(false);
    await drain(b3);
    const heldAfterRetries = JSON.stringify(b3.ctx.pendingSkips.current);
    await b3.ctx.saveProgress({ notes: 'x'.repeat(45), lane: 'write' });
    ok('⚠️ …and when every retry failed it is KEPT, and rides on the next progress write (the notes), which clears it once it lands',
      b3.sent.length === 5 && heldAfterRetries === '{"photo":true,"signature":true}'
      && JSON.stringify(b3.sent[4]) === JSON.stringify({ notes: 'x'.repeat(45), lane: 'write', skipped: { photo: true, signature: true } })
      && b3.ctx.pendingSkips.current === null, { sent: b3.sent, heldAfterRetries });
    const b4 = skipBox([false, true]);
    b4.ctx.saveOnboarding = async (p) => { b4.sent.push(p); b4.ctx.gone.current = true; return { ok: false, wizard: null }; };
    b4.ctx.noteSkips(false);
    await drain(b4);
    ok('⚠️ …never after the screen is gone (the token is whoever is signed in THEN — one account\'s skip must not land on the next)',
      b4.sent.length === 1 && b4.delays.length === 0, { sent: b4.sent, delays: b4.delays });
    const b5 = skipBox([]);
    await b5.ctx.saveProgress({ notes: 'abc', lane: 'write' });
    ok('…a progress write with no skip pending is exactly what it was', JSON.stringify(b5.sent) === '[{"notes":"abc","lane":"write"}]', b5.sent);
    ok('the notes (debounced), the lane after an upload and step 2\'s Next all go through saveProgress',
      /setTimeout\(\(\) => \{ saveProgress\(\{ notes: rawText, lane \}\); \}, 900\)/.test(wiz) && /saveProgress\(\{ lane: 'upload' \}\);/.test(fnBodyOf(wiz, 'pickFile'))
      && /if \(step === 2\) saveProgress\(\{ notes: rawText, lane \}\);/.test(wiz) && !/saveOnboarding\(\{ notes/.test(wiz) && !/saveOnboarding\(\{ lane/.test(wiz));
  } else ok('noteSkips (and SKIP_RETRY_MS) are in the wizard', false);
  ok('a saved signature is SHOWN (its image), and the studio opens only to replace it',
    /hasSign && !redoSign \?/.test(wiz) && /source=\{\{ uri: signUri \|\| snap\?\.signature \|\| '' \}\}/.test(wiz) && /ref=\{studio\}/.test(wiz));
  ok('⚠️ the upload lane\'s Next waits for the CV to be READ, not merely uploaded', /if \(step === 2\) return lane === 'write' \? rawText\.trim\(\)\.length >= 40 : legacy \? legacyCv : cvRead;/.test(wiz)
    && /const cvRead = !!cv && cv\.status === 'done';/.test(wiz));
  ok('⚠️ …except against an OLDER server (no setup.wizard), where a CV uploaded now or already on file is enough — never a dead end',
    /const legacy = !!snap && !snap\.setup\.wizard;/.test(wiz) && /const legacyCv = legacy && \(!!file \|\| !!snap\?\.resume\);/.test(wiz)
    && /if \(legacy\) return;/.test(fnBodyOf(wiz, 'pickFile')) && fnBodyOf(wiz, 'pickFile').indexOf('if (legacy) return;') < fnBodyOf(wiz, 'pickFile').indexOf('followCv()'));
  ok('the CV on file is shown with its read state (Read ✓ / Reading… / the server\'s error), and an unread one is asked to be read',
    /'Read ✓ — tap to replace'/.test(wiz) && /'Reading your CV…'/.test(wiz) && /saveOnboarding\(\{ readCv: true \}\)/.test(wiz));
  ok('notes are saved as they are typed (debounced), with the lane', /setTimeout\(\(\) => \{ saveProgress\(\{ notes: rawText, lane \}\); \}, 900\)/.test(wiz));
  ok('the wizard opens on the server\'s first unfinished step, pre-filled from setup.wizard (skips, notes, CV, lane)',
    /setSkipped\(w\.skipped\);/.test(wiz) && /setRawText\(w\.notes \|\| ''\);/.test(wiz) && /setCv\(w\.cv\);/.test(wiz) && /first = running \|\| ready \? LAST : w\.step;/.test(wiz));
  ok('⚠️ finished — or nothing left by the wizard\'s rules — opens on "Your resume is ready" (done), never on a Build that spends',
    /const ready = w\.state === 'finished' \|\| \(Array\.isArray\(w\.left\) && !w\.left\.length\);/.test(wiz) && /if \(ready\) setDone\(true\);/.test(wiz));
  const build = fnBodyOf(wiz, 'build');
  ok('⚠️ one clientBuildId per tap; a retry after no answer ASKS the server (buildOnServer) before re-POSTing the same id',
    /if \(!retry\) buildId\.current = \{ id: newWizardBuildId\(\), reuse: false \};/.test(build) && /await buildOnServer\(\)/.test(build)
    && build.indexOf('buildOnServer') < build.indexOf('generateResume('));
  ok('⚠️ a running wizard build is REJOINED on the build step (joinBuild) — the effect never calls build() or generateResume',
    /if \(step === LAST && joinJob && !stage && !done && !outcome\) follow\(joinJob\);/.test(wiz) && /await joinBuild\(jobId,/.test(fnBodyOf(wiz, 'follow')));
  const settle = fnBodyOf(wiz, 'settle');
  ok('an unreadable CV sends them back to the upload with the server\'s sentence; "late" keeps the job for Keep waiting',
    /r\.reason === 'cv_unreadable'[\s\S]{0,200}goTo\(2\)/.test(settle) && /if \(r\.kind === 'late'\) \{ setJoinJob\(r\.jobId\);/.test(settle));
  const lateAt = settle.indexOf("if (r.kind === 'late')");
  ok('⚠️ a build that ENDED (refused / failed) is never followed again — joinJob is cleared, so "Add more" + back does not replay the old refusal',
    lateAt >= 0 && /setJoinJob\(null\);/.test(settle.slice(lateAt + 30)) && settle.slice(lateAt + 30).indexOf('setJoinJob(null);') < settle.slice(lateAt + 30).indexOf('setGenErr(r.message)'));
  ok('⚠️ a second résumé is asked before it is spent ("Rebuild — uses 1 resume")', /'Rebuild — uses 1 resume'/.test(fnBodyOf(wiz, 'start')) && /if \(builtResume && !done/.test(fnBodyOf(wiz, 'start')));
  ok('the build step keeps them there on every non-ready end: Try again / Keep waiting / See plans / Add more', /'Keep waiting'/.test(wiz) && /'See plans'/.test(wiz) && /Add more about your experience/.test(wiz));
  ok('⚠️ still ONE Animated driver: no JS-driven animation, and no Animated value beyond the slide and the bar',
    !/useNativeDriver: false/.test(wiz) && (wiz.match(/new Animated\.Value\(/g) || []).length === 2);

  // ⚠️ Review, 2026-09-19: a FIRST signature set signUri before its upload, so the studio was swapped for the image
  // mid-upload and a failed upload remounted a blank pad — the ink was gone.
  const saveSig = fnBodyOf(wiz, 'saveSignature');
  ok('⚠️ the saved-signature image replaces the pad only AFTER the upload landed (a failed upload keeps the ink on the pad)',
    saveSig.indexOf('await uploadSignature(uri)') >= 0 && saveSig.indexOf('setSignUri(uri)') > saveSig.indexOf('if (!up.ok)') && !/setSignUri\(null\)/.test(saveSig), saveSig.slice(0, 300));
  // ⚠️ Review: the close button, the iOS swipe and the Android back button left without saving.
  ok('⚠️ EVERY way off the screen goes through usePreventRemove: armed while a drawn signature or valid changed details are unsaved',
    /usePreventRemove\(!booting && !done && !exit && \(unsavedYou \|\| unsavedSign\),/.test(wiz)
    && /const unsavedSign = step === 1 && sigDirty;/.test(wiz) && /const unsavedYou = step === 0 && canAdvance && savedYou !== null && youKey !== savedYou;/.test(wiz)
    && /onDirty=\{setSigDirty\}/.test(wiz));
  const guardAt = wiz.indexOf('usePreventRemove(!booting');
  const guardSrc = guardAt >= 0 ? wiz.slice(guardAt, guardAt + 2000) : '';
  ok('…it commits the signature and WAITS; a failed upload asks "Stay" / "Leave without it"; it saves the details quietly; then the action goes',
    /await studio\.current\.commit\(\)/.test(guardSrc) && /'Leave without it'/.test(guardSrc) && /await saveYou\(true\)/.test(guardSrc)
    && guardSrc.indexOf('saveYou(true)') < guardSrc.indexOf('setExit({ action: data.action });\n')
    && /if \(exit\) navigation\.dispatch\(exit\.action\);/.test(wiz));
  ok('⚠️ …and it commits only what they drew or tapped: commit() with NO handOnScreen, anywhere but Next (round 4, 2026-09-20)',
    !/handOnScreen/.test(guardSrc) && !/handOnScreen/.test(fnBodyOf(wiz, 'leaveTo')) && !/commit/.test(fnBodyOf(wiz, 'skipSign'))
    && (wiz.match(/\.commit\(/g) || []).length === 2 && /await studio\.current\.commit\(\);/.test(guardSrc)
    && (wiz.match(/commitSign\((?!false\))/g) || []).length === 1);
  ok('…saving the details marks them saved (the guard drops), and what the server gave on open counts as saved',
    /setSavedYou\(JSON\.stringify\(youFields\)\);/.test(fnBodyOf(wiz, 'saveYou')) && /if \(!booting && savedYou === null\) setSavedYou\(youKey\);/.test(wiz));

  console.log('\n── 6 · the signature studio hands the wizard its unsaved ink ──');
  const studio = strip(R('components/onboarding/SignatureStudio.tsx'));
  ok('it is a forwardRef exposing isDirty() and commit()', /forwardRef<SignatureStudioHandle/.test(studio) && /useImperativeHandle\(ref, \(\) => \(\{\s*isDirty:/.test(studio) && /commit: async \(opts\?: \{ handOnScreen\?: boolean \}\) =>/.test(studio));
  ok('⚠️ commit() exports and uploads through the SAME path as "Use this", and resolves with the upload\'s answer',
    /onPress=\{\(\) => \{ saveNow\(\); \}\}/.test(studio) && /const r = await exportNow\(modeRef\.current\);/.test(fnBodyOf(studio, 'saveNow')) && /const up = await onCaptured\(uri\);/.test(studio) && /result = up === false \? 'failed' : 'saved';/.test(studio));
  ok('dirty is per tab — a stroke on the pad, or a hand TAPPED in the gallery (and which hand)', /setDirty\(!!msg\.drawn, 'draw'\)/.test(studio)
    && /pickRef\.current = Math\.max\(0, Number\(msg\.i\) \|\| 0\); setDirty\(true, 'type'\);/.test(studio));

  // ⚠️ REVIEW ROUND 2, 2026-09-19: the gallery opens with hand #1 TICKED and "Use this" lit, but only a TAP counted as
  // unsaved — Next on the hand the screen showed as chosen found nothing to save, and the wizard stored a SKIP.
  // sigToCommit is cut out of the component and run.
  const studioRaw = R('components/onboarding/SignatureStudio.tsx');
  const stcBody = fnBodyOf(studioRaw, 'sigToCommit');
  const sigToCommit = stcBody ? vm.runInNewContext('(' + tsc.transpileModule('function sigToCommit(s: any, handOnScreen = false) ' + stcBody,
    { compilerOptions: { target: tsc.ScriptTarget.ES2020 } }).outputText.trim().replace(/;$/, '') + ')') : null;
  ok('sigToCommit is exported from SignatureStudio', typeof sigToCommit === 'function' && /export function sigToCommit\(s: SigPad, handOnScreen = false\): SigMode \| null \{/.test(studioRaw));
  const pad = (o) => ({ mode: 'draw', drawnUnsaved: false, typeTapped: false, name: 'Priya Sharma', hands: 6, typeKey: 'Priya Sharma|0', savedTypeKey: null, ...o });
  if (typeof sigToCommit === 'function') {
    ok('⚠️ THE REVIEW\'S CASE: "Pick a hand", hand #1 ticked, NO tap, NEXT (handOnScreen) → the hand is SAVED ("type"), not skipped',
      sigToCommit(pad({ mode: 'type' }), true) === 'type');
    ok('⚠️ ROUND 4: the same untapped hand WITHOUT handOnScreen (Skip, back, dots, the leave guard, "dirty") → nothing to save',
      sigToCommit(pad({ mode: 'type' })) === null && sigToCommit(pad({ mode: 'type', typeKey: 'Priya S|0' })) === null);
    ok('…while a TAPPED hand, or ink drawn before opening the gallery, is saved without it',
      sigToCommit(pad({ mode: 'type', typeTapped: true, typeKey: 'Priya Sharma|2' })) === 'type'
      && sigToCommit(pad({ mode: 'type', drawnUnsaved: true })) === 'draw');
    ok('…a TAPPED hand too; and once exactly that name in that hand was saved, nothing is pending',
      sigToCommit(pad({ mode: 'type', typeTapped: true, typeKey: 'Priya Sharma|3' })) === 'type'
      && sigToCommit(pad({ mode: 'type', typeKey: 'Priya Sharma|3', savedTypeKey: 'Priya Sharma|3' }), true) === null);
    ok('…a different hand or an edited name after that save is unsaved again (for Next)',
      sigToCommit(pad({ mode: 'type', typeKey: 'Priya Sharma|1', savedTypeKey: 'Priya Sharma|3' }), true) === 'type'
      && sigToCommit(pad({ mode: 'type', typeKey: 'Priya S|3', savedTypeKey: 'Priya Sharma|3' }), true) === 'type');
    ok('no name, or no hands on the device: nothing to save on that tab', sigToCommit(pad({ mode: 'type', name: '  ', typeKey: '|0' })) === null
      && sigToCommit(pad({ mode: 'type', hands: 0 })) === null);
    ok('⚠️ ink drawn, then a switch to a gallery with nothing to offer (name cleared) → the DRAWING is saved, not lost',
      sigToCommit(pad({ mode: 'type', name: '', typeKey: '|0', drawnUnsaved: true })) === 'draw');
    ok('the pad on screen: ink → "draw"; empty → nothing, even though a hand was LOOKED at (a peek is not a choice)',
      sigToCommit(pad({ drawnUnsaved: true })) === 'draw' && sigToCommit(pad({})) === null);
    ok('…but a hand TAPPED before switching to an empty pad is saved, not thrown away', sigToCommit(pad({ typeTapped: true })) === 'type');
    ok('…and ink on the pad on screen wins over a hand tapped earlier', sigToCommit(pad({ drawnUnsaved: true, typeTapped: true })) === 'draw');
  }
  ok('⚠️ commit() saves the tab sigToCommit names (not "the tab on screen, if tapped") and dirty IS "sigToCommit has an answer"',
    /const which = ready \? toCommit\(!!\(opts && opts\.handOnScreen\)\) : null;\s*return which \? exportNow\(which\) : 'clean';/.test(studio) && /const v = toCommit\(\) !== null;/.test(studio)
    && /useEffect\(\(\) => \{ syncDirty\(\); \}, \[mode, signAs, styles\.length, syncDirty\]\);/.test(studio));
  ok('⚠️ …the hand on screen counts only when commit() is ASKED to (handOnScreen) — "dirty" (the leave guard) never counts it',
    /commit: async \(opts\?: \{ handOnScreen\?: boolean \}\) =>/.test(studio)
    && /const toCommit = useCallback\(\(handOnScreen = false\): SigMode \| null => sigToCommit\(\{[\s\S]*?\}, handOnScreen\), \[typeKeyOf\]\);/.test(studio));
  ok('…the page exports the tab it is asked for (a drawing left for an empty gallery), and says which it sent',
    /window\.__export=function\(m\)\{/.test(studio) && /var md=\(m==='type'\|\|m==='draw'\)\?m:mode;/.test(studio)
    && /post\(\{type:'sig',mode:'type',data:/.test(studio) && /post\(\{type:'sig',mode:'draw',data:/.test(studio)
    && /send\(`window\.__export\(\$\{JSON\.stringify\(which\)\}\)`\);/.test(studio));
  const savedAt = studio.indexOf("if (result === 'saved') {");
  const savedSrc = savedAt >= 0 ? studio.slice(savedAt, savedAt + 400) : '';
  ok('…and a save records the hand it saved and clears BOTH tabs (neither tab\'s older work is pending after it)',
    /savedTypeKey\.current = sent\.key;/.test(savedSrc) && /unsaved\.current\.draw = false;/.test(savedSrc) && /unsaved\.current\.type = false;/.test(savedSrc)
    && /syncDirty\(\);/.test(savedSrc) && /exporting\.current = \{ mode: which, key: typeKeyOf\(\) \};/.test(studio));
  ok('a WebView that never answers cannot hang the step (after 8 s the page is reloaded and the commit settles "stuck")',
    /setTimeout\(\(\) => \{ if \(pending\.current === resolve\) resetPage\(\); \}, 8000\)/.test(studio) && /settle\('stuck'\);/.test(fnBodyOf(studio, 'resetPage')));
  // ⚠️ REVIEW, 2026-09-20: iOS kills a WKWebView's content process under memory pressure and react-native-webview does not
  // reload it — the pad went blank while its ink still counted as unsaved, so Next and back waited 8 s and did nothing.
  const reset = fnBodyOf(studio, 'resetPage');
  ok('⚠️ a page whose process DIED is remounted clean (iOS onContentProcessDidTerminate, Android onRenderProcessGone)',
    /key=\{pageKey\}/.test(studio) && /onContentProcessDidTerminate=\{resetPage\}/.test(studio) && /onRenderProcessGone=\{resetPage\}/.test(studio)
    && /setPageKey\(\(k\) => k \+ 1\);/.test(reset) && /setReady\(false\);/.test(reset) && /setDrawn\(false\);/.test(reset)
    && /unsaved\.current = \{ draw: false, type: false \};/.test(reset) && /syncDirty\(\);/.test(reset) && /pickRef\.current = 0;/.test(reset));
  ok('⚠️ …an image that could not be written is "stuck" too (no upload was tried, so no upload alert said anything)',
    /\} catch \{\s*result = 'stuck';/.test(studio));
  const saveNowSrc = fnBodyOf(studio, 'saveNow');
  ok('…and "Use this" says what went wrong itself: nothing to save → onEmpty (HEAD\'s alert, lost when every export got a waiter); stuck → an alert',
    /if \(r === 'empty'\) onEmpty\?\.\(\);/.test(saveNowSrc) && /else if \(r === 'stuck'\) Alert\.alert\(/.test(saveNowSrc));
  ok('the leave guard treats a stuck pad like a failed upload ("Stay" / "Leave without it"), with its own sentence',
    /if \(c === 'failed' \|\| c === 'stuck'\) \{/.test(guardSrc) && /The signature pad stopped working/.test(guardSrc));
  // ⚠️ Review, 2026-09-19: the 8 s watchdog also covered the UPLOAD — on a slow connection Next "did nothing".
  const sigAt = studio.indexOf("if (msg.type !== 'sig' || !msg.data) return;");
  const sigSrc = sigAt >= 0 ? studio.slice(sigAt, sigAt + 900) : '';
  ok('⚠️ …but once the page has answered, the request leaves `pending` BEFORE the upload — the upload\'s own answer settles it',
    /const waiting = pending\.current;\s*pending\.current = null;/.test(sigSrc) && sigSrc.indexOf('pending.current = null;') < sigSrc.indexOf('await onCaptured(uri)')
    && /if \(waiting\) waiting\(result\);/.test(sigSrc), sigSrc.slice(0, 200));
  ok('…and a second commit while an export or its upload is going JOINS it (never two uploads of the same ink)',
    /if \(inflight\.current\) return inflight\.current;/.test(studio));

  console.log(`\nonboarding wizard (client): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
