// THE MAKE YOURS WIZARD'S PROGRESS — server/services/onboardingProgress.js (Migration 047, 2026-09-19).
//
//   node server/scripts/test-onboarding-progress.js
//
// Why it exists: the owner's fresh account (user 616) walked the wizard, lost his signature and his CV on the way,
// was charged twice for two EMPTY résumés, and after an app restart "Pick up where you left off" was gone — Home
// derived it from the files on disk alone. This pins the server's answer to "where is this user in the wizard":
//   1. wizardStateOf — every combination of details / photo / signature / skips / CV read state / notes / build,
//      and the two ends (finished by a wizard build; closed by Account Settings completing the profile);
//   2. the hooks every profile write runs (a wizard write keeps the wizard open; any other write closes it only
//      when IT completed the profile by the WIZARD's own fields — skips honoured, date of birth optional; a save to
//      a profile that was already complete closes nothing);
//   3. against a REAL throwaway Postgres (skipped, loudly, when initdb/pg_ctl are not installed): the migration's
//      table, the backfill that brings 616's button back, leaves user 1 alone and runs ONCE ever, and every write's SQL.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 400) : '')); }
};

// ── a swappable database: the in-memory fake for parts 1-2, a real Postgres for part 3 ───────────────────────────
const dbImpl = { get: async () => null, run: async () => ({}), query: async () => [] };
const dbPath = require.resolve(path.join(ROOT, 'db-config.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  get: (...a) => dbImpl.get(...a), run: (...a) => dbImpl.run(...a), query: (...a) => dbImpl.query(...a),
} };
// closeIfCompletedElsewhere asks the profile controller for the profile's fields and files (wizardInputsForUser); that
// module pulls the whole parser in, so it is stood in for here.
const inputsFor = {};
const pcPath = require.resolve(path.join(ROOT, 'server', 'controllers', 'profileController.js'));
require.cache[pcPath] = { id: pcPath, filename: pcPath, loaded: true, exports: { wizardInputsForUser: async (u) => inputsFor[u] || null } };

const OB = require(path.join(ROOT, 'server', 'services', 'onboardingProgress.js'));
const S = OB.wizardStateOf;

(async () => {
  console.log('\n── 1 · wizardStateOf: the FIRST unfinished step, by the wizard\'s own rules ──');
  const ME = { fullName: 'Rishi Samadhiya', phone: '+91 98765 43210', address: 'Pune, India' };
  const ROW = { started_at: new Date(), skipped: {} };
  const ALL = { photo: true, signature: true, resume: true };
  const DONE = { status: 'done', error: null };

  let w = S({});
  ok('no row, nothing done → state "none", step 0 (About you)', w.state === 'none' && w.step === 0 && w.stepKey === 'you', w);
  ok('…and every piece is "left", in wizard order',
    JSON.stringify(w.left) === JSON.stringify(['your details', 'a photo', 'your signature', 'your experience', 'building your resume']), w.left);
  w = S({ row: ROW, profile: ME });
  ok('⚠️ name + phone + address is "About you" done — date of birth and gender are OPTIONAL on that screen', w.done.you && w.step === 1 && w.state === 'open', w);
  ok('…a one-letter name, or no phone, or no address is not', !S({ profile: { ...ME, fullName: 'R' } }).done.you
    && !S({ profile: { ...ME, phone: ' ' } }).done.you && !S({ profile: { ...ME, address: '' } }).done.you);
  w = S({ row: ROW, profile: ME, files: { photo: true } });
  ok('a photo without a signature stays on step 1', w.step === 1 && !w.done.sign && w.left.includes('your signature') && !w.left.includes('a photo'), w);
  w = S({ row: { ...ROW, skipped: { signature: true } }, profile: ME, files: { photo: true } });
  ok('⚠️ a SKIPPED signature is remembered: step 1 is done, and it is not named as "left"', w.done.sign && w.step === 2 && !w.left.includes('your signature'), w);
  w = S({ row: { ...ROW, skipped: '{"photo":true,"signature":true}' }, profile: ME });
  ok('…both skipped (the column can arrive as JSON text) → step 2', w.done.sign && w.step === 2 && w.skipped.photo && w.skipped.signature, w);
  w = S({ row: ROW, profile: ME, files: ALL, cv: { ext: 'DOCX', uploadedAt: 'x' }, parse: { status: 'pending', error: null } });
  ok('⚠️ a CV on disk that is still being READ is not the experience step done (the build would write from nothing)',
    w.step === 2 && !w.done.experience && w.cv.status === 'pending' && w.cv.ext === 'DOCX', w);
  w = S({ row: ROW, profile: ME, files: ALL, parse: { status: 'error', error: 'This file is password-protected…' } });
  ok('…a CV whose read FAILED keeps step 2 open, carrying the sentence to show', w.step === 2 && w.cv.status === 'error' && /password/.test(w.cv.error), w.cv);
  w = S({ row: ROW, profile: ME, files: ALL, parse: DONE });
  ok('a CV that has been read → step 3 (Build), only "building your resume" left',
    w.step === 3 && w.done.experience && JSON.stringify(w.left) === '["building your resume"]', w);
  ok('⚠️ notes of 39 characters are not enough, 40 are (the wizard\'s own Next rule)',
    !S({ row: { ...ROW, notes: 'x'.repeat(39) }, profile: ME }).done.experience && S({ row: { ...ROW, notes: 'x'.repeat(40) }, profile: ME }).done.experience);
  ok('…and a CV on file that was never read is "unread", not done', S({ row: ROW, files: { resume: true } }).cv.status === 'unread');

  w = S({ row: ROW, profile: ME, files: ALL, parse: DONE, job: { id: 'j1', status: 'processing', fresh: true } });
  ok('a wizard build still running → build.status "running" (the wizard rejoins it; the Build button is not offered)', w.build.status === 'running' && w.state === 'open', w.build);
  ok('…past the 15-minute window it is "stale"', S({ row: ROW, job: { id: 'j', status: 'pending', fresh: false } }).build.status === 'stale');
  ok('…a failed (or cancelled) one is "failed"', S({ row: ROW, job: { id: 'j', status: 'cancelled', fresh: true } }).build.status === 'failed');
  w = S({ row: { ...ROW, finished_at: new Date() }, profile: ME, files: ALL, parse: DONE });
  ok('⚠️ finished_at → state "finished", nothing left', w.state === 'finished' && w.done.build && w.left.length === 0 && w.step === 3, w);
  w = S({ row: ROW, profile: ME, files: ALL, parse: DONE, job: { id: 'j1', status: 'completed', fresh: true } });
  ok('…a COMPLETED wizard job counts as finished even if the finish write was lost (2xx = charged and saved)', w.state === 'finished', w);
  w = S({ row: { ...ROW, closed_at: new Date(), closed_by: 'account_settings' }, profile: ME, files: ALL, parse: DONE });
  ok('closed_at → state "closed" by account_settings', w.state === 'closed' && w.closedBy === 'account_settings', w);

  // The two real accounts, as production held them on 2026-09-19 (after the backfill).
  w = S({ row: { started_at: new Date('2026-09-19T10:45:48Z'), skipped: {} }, profile: ME, files: ALL, cv: { ext: 'PDF' }, parse: DONE, builtResume: false });
  ok('⚠️ USER 616: every file on disk and the CV read, but no successful build → "open" at Build, "building your resume" left',
    w.state === 'open' && w.stepKey === 'build' && JSON.stringify(w.left) === '["building your resume"]' && w.builtResume === false, w);
  w = S({ row: null, profile: ME, files: ALL, parse: DONE, builtResume: true });
  ok('USER 1 (no progress row): state "none" — Home keeps its old logic for accounts that never started the wizard', w.state === 'none' && w.builtResume === true);

  // ⚠️ Review, 2026-09-19: a résumé with content that already exists IS the experience and the build done. Counting only
  // a wizard build kept someone who built in the Builder / on Home on an open wizard the moment they saved one missing
  // piece through it — Home's Customize doors became "Pick up where you left off — building your resume", and the only
  // way out was a paid Rebuild (27 of production's 40 users with a real résumé have setup.complete = false).
  w = S({ row: ROW, profile: ME, files: { photo: true, signature: true }, builtResume: true });
  ok('⚠️ a real résumé built elsewhere + details + photo + a signature saved through the wizard (a row now exists) → "finished", nothing left',
    w.state === 'finished' && w.done.experience && w.done.build && w.left.length === 0, w);
  w = S({ row: ROW, profile: ME, files: { photo: true }, builtResume: true });
  ok('…with the signature still missing → "open" on the SIGNATURE, not on Build: only "your signature" is left',
    w.state === 'open' && w.stepKey === 'sign' && JSON.stringify(w.left) === '["your signature"]', w);
  w = S({ row: null, profile: ME, files: { photo: true, signature: true }, builtResume: true });
  ok('…with no progress row the state stays "none", but nothing is left (the wizard opens on "ready", never on a paid Build)',
    w.state === 'none' && w.left.length === 0 && w.stepKey === 'build', w);
  w = S({ row: { ...ROW, closed_at: new Date() }, profile: ME, files: ALL, parse: DONE, builtResume: true });
  ok('…and every step done reads "finished" even on a row Account Settings closed', w.state === 'finished', w);
  ok('…while the EMPTY résumé 616 was charged for leaves the build to do (resumeHasSubstance says no)',
    S({ row: ROW, profile: ME, files: ALL, parse: DONE, builtResume: OB.resumeHasSubstance({ experience: [], education: [], projects: [] }) }).stepKey === 'build');

  // ⚠️ 616, REPLAYED as production shows it (async_jobs 868edb78: created 10:47:54.68, completed 10:47:56.28 UTC). Nothing
  // was running when the second build was tapped: build #1 had completed, "Ready" sent him Home, Home offered "Pick up"
  // because the signature was never uploaded, and the reopened wizard offered Build again. Today a wizard build that is
  // charged AND saved calls finish(): the reopened wizard is FINISHED even with the signature still missing — it opens
  // on "Your resume is ready", and Build is not offered.
  w = S({ row: { ...ROW, finished_at: new Date('2026-09-19T10:47:56Z'), build_job_id: '868edb78' }, profile: ME,
    files: { photo: true, resume: true }, parse: { status: 'done' }, job: { id: '868edb78', status: 'completed', fresh: true } });
  ok('⚠️ 616 REPLAYED: charged-and-saved wizard build → Home → reopen with no signature on file → "finished" (no second Build)',
    w.state === 'finished' && w.done.build && !w.left.includes('building your resume'), w);

  console.log('\n── 1b · "complete the profile in Account Settings" — by the WIZARD\'s fields, not the checklist\'s ──');
  const C = (o) => OB.profileCompleteOf(S({ row: ROW, profile: ME, ...o }));
  ok('⚠️ photo SKIPPED in the wizard, no date of birth (optional there), a signature and a CV on file → complete',
    C({ row: { ...ROW, skipped: { photo: true } }, files: { signature: true, resume: true }, parse: DONE }));
  ok('…a CV still being READ counts (the check runs at the end of the upload itself; no later write re-checks it)',
    C({ files: { photo: true, signature: true, resume: true }, parse: { status: 'pending', error: null } })
    && C({ files: { photo: true, signature: true, resume: true }, parse: { status: 'unread', error: null } }));
  ok('…a CV whose read FAILED does not; notes of 40 characters do', !C({ files: { photo: true, signature: true, resume: true }, parse: { status: 'error', error: 'x' } })
    && C({ row: { ...ROW, notes: 'x'.repeat(40) }, files: { photo: true, signature: true } }));
  ok('…no phone, or a photo neither there nor skipped, is not complete; the build is not part of it',
    !C({ profile: { ...ME, phone: '' }, files: ALL, parse: DONE }) && !C({ files: { signature: true, resume: true }, parse: DONE })
    && C({ files: ALL, parse: DONE }) && !S({ row: ROW, profile: ME, files: ALL, parse: DONE }).done.build);
  ok('…and no state at all is never complete', OB.profileCompleteOf(null) === false);

  console.log('\n── 2 · what a CV\'s parse state reads as, and what counts as a résumé ──');
  ok('no row → unread; pending → pending; pending with an error → slow (the sweeper retries it)',
    OB.cvParseOf(null).status === 'unread' && OB.cvParseOf({ parse_status: 'pending' }).status === 'pending'
    && OB.cvParseOf({ parse_status: 'pending', parse_error: '503 high demand' }).status === 'slow');
  ok('⚠️ a refused format shows the refusal\'s own sentence (not "unsupported document: …")',
    OB.cvParseOf({ parse_status: 'error', parse_error: 'unsupported document: This file is password-protected, so we cannot read it.' }).error === 'This file is password-protected, so we cannot read it.');
  ok('…and any other failure a sentence that says what to do', /PDF or \.docx/.test(OB.cvParseOf({ parse_status: 'error', parse_error: 'boom' }).error));
  ok('the empty résumé 616 was charged for has no substance', !OB.resumeHasSubstance({ summary: 'Professional', experience: [], education: [], projects: [], achievements: ['Achieved [X%]'] }));
  ok('…nor does one whose only role is blank strings', !OB.resumeHasSubstance({ experience: [{ company: ' ', role: '', highlights: [''] }] }));
  ok('one role, or only an education, or only a project is a résumé (also as JSON text)',
    OB.resumeHasSubstance({ experience: [{ company: 'TCS' }] }) && OB.resumeHasSubstance({ education: [{ institution: 'Pune' }] })
    && OB.resumeHasSubstance('{"projects":[{"title":"Atlas"}]}'));

  console.log('\n── 3 · who is the wizard, and what every profile write does afterwards ──');
  ok('X-CV-Source: onboarding is the wizard (any case, via headers or req.get)',
    OB.isWizardRequest({ headers: { 'x-cv-source': 'onboarding' } }) && OB.isWizardRequest({ headers: {}, get: () => 'Onboarding' })
    && !OB.isWizardRequest({ headers: {} }) && !OB.isWizardRequest({ headers: { 'x-cv-source': 'settings' } }) && !OB.isWizardRequest(null));
  const runs = [];
  let rows = {};
  const parseOf = {};
  dbImpl.run = async (sql, p) => { runs.push({ sql: sql.replace(/\s+/g, ' ').trim(), p }); return {}; };
  dbImpl.get = async (sql, p) => (/FROM user_onboarding/.test(sql) ? rows[p[0]] || null
    : /FROM resume_metadata/.test(sql) ? parseOf[p[0]] || null : null);
  const wizardReq = { headers: { 'x-cv-source': 'onboarding' } }, settingsReq = { headers: {} };
  const upserts = () => runs.filter((r) => /^INSERT INTO user_onboarding/.test(r.sql)).length;
  const closes = () => runs.filter((r) => /^UPDATE user_onboarding SET closed_at = NOW\(\), closed_by = 'account_settings'/.test(r.sql)).length;
  const EVERYTHING = { profile: ME, files: ALL, cv: { ext: 'PDF', uploadedAt: null } };

  // A write as the routes run it: noteProfileBefore (before multer / the UPDATE) reads the profile, the write lands, and
  // afterProfileWrite closes — or not. `before` / `after` are what the profile holds on either side of the write.
  const write = async (req, uid, before, after, parse = {}) => {
    const r = { ...req, user: { id: uid } };
    inputsFor[uid] = before;
    if ('before' in parse) parseOf[uid] = parse.before;
    let nexted = 0;
    await OB.noteProfileBefore(r, {}, () => { nexted++; });
    inputsFor[uid] = after;
    if ('after' in parse) parseOf[uid] = parse.after;
    await OB.afterProfileWrite(r, uid);
    return { before: r.__onboardingBefore, nexted };
  };

  await OB.afterProfileWrite(wizardReq, 616);
  ok('a wizard write creates / touches the progress row', upserts() === 1 && closes() === 0);
  rows = { 616: { user_id: 616, skipped: {} } };
  const wz1 = await write(wizardReq, 616, { ...EVERYTHING, profile: { ...ME, phone: '' } }, EVERYTHING);
  ok('⚠️ a WIZARD write that completes the profile does NOT end the wizard (that is the state the button vanished in) — and its "before" is not even read',
    closes() === 0 && wz1.before === undefined && wz1.nexted === 1, wz1);
  await write(settingsReq, 616, { ...EVERYTHING, profile: { ...ME, phone: '' } }, { ...EVERYTHING, profile: { ...ME, phone: '' } });
  ok('an Account Settings write that leaves the profile incomplete (no phone) closes nothing', closes() === 0);
  const noSig = { profile: ME, files: { photo: true, signature: false, resume: true }, cv: { ext: 'PDF', uploadedAt: null } };
  await write(settingsReq, 616, { ...noSig, profile: { ...ME, phone: '' } }, noSig);
  ok('…nor one with the signature neither on file nor skipped', closes() === 0);
  // ⚠️ The review's case: the wizard's own "optional" honoured by the Account Settings door.
  rows = { 616: { user_id: 616, skipped: { photo: true } } };
  const cvAndSig = { profile: ME, files: { photo: false, signature: true, resume: true }, cv: { ext: 'DOCX', uploadedAt: null } };
  const st1 = await write(settingsReq, 616, { profile: ME, files: { photo: false, signature: false, resume: false }, cv: null }, cvAndSig,
    { before: null, after: { parse_status: 'pending', parse_error: null } });
  ok('⚠️ photo SKIPPED in the wizard, NO date of birth, then a signature and a CV (still being read) in Account Settings → the wizard is closed ("account_settings")',
    closes() === 1 && st1.before === false && st1.nexted === 1, st1);
  await write(settingsReq, 616, { profile: ME, files: { photo: false, signature: true, resume: false }, cv: null }, cvAndSig,
    { before: null, after: { parse_status: 'error', parse_error: 'unsupported document: This file is password-protected, so we cannot read it.' } });
  ok('…but not on a CV whose read FAILED (there is nothing to build from yet)', closes() === 1);

  // ⚠️ REVIEW ROUND 2, 2026-09-19: the state AFTER the write alone closed the wizard of anyone whose profile was ALREADY
  // complete — on any save at all. User 616 after the deploy: every field and file saved through the wizard, only the
  // build missing, "Pick up where you left off · building your resume" on Home. He re-saves his phone in Account
  // Settings (App.js sends no X-CV-Source; neither does any build-209 wizard write).
  rows = { 616: { user_id: 616, skipped: {} } };
  const done616 = { before: { parse_status: 'done', parse_error: null }, after: { parse_status: 'done', parse_error: null } };
  const re = await write(settingsReq, 616, EVERYTHING, EVERYTHING, done616);
  ok('⚠️ 616: an Account Settings write to a profile that was ALREADY complete completes nothing → the wizard stays OPEN',
    closes() === 1 && re.before === true && re.nexted === 1, re);
  await write(settingsReq, 616, { ...EVERYTHING, files: { photo: false, signature: true, resume: true } }, EVERYTHING, done616);
  ok('…the same profile with the photo still missing before this write (the write that COMPLETED it) → closed', closes() === 2);
  parseOf[616] = { parse_status: 'done', parse_error: null };
  inputsFor[616] = EVERYTHING;
  await OB.afterProfileWrite(settingsReq, 616);
  ok('…and a write whose "before" was never read (no noteProfileBefore on its route) closes nothing: a wizard left open is a button that still works',
    closes() === 2);
  ok('closeIfCompletedElsewhere: only `before === false` can close (true, null and undefined never do)',
    await OB.closeIfCompletedElsewhere(616, true) === false && await OB.closeIfCompletedElsewhere(616, null) === false
    && await OB.closeIfCompletedElsewhere(616) === false && closes() === 2);
  parseOf[616] = null;

  rows = { 616: { user_id: 616, skipped: {}, finished_at: new Date() } };
  const fin = await write(settingsReq, 616, { ...EVERYTHING, profile: { ...ME, phone: '' } }, EVERYTHING);
  rows = {};
  const none = await write(settingsReq, 999, { ...EVERYTHING, profile: { ...ME, phone: '' } }, EVERYTHING);
  ok('…never a finished wizard, and never a user who has no wizard at all (no row is created for them; "before" reads null)',
    closes() === 2 && upserts() === 2 && fin.before === null && none.before === null, { fin, none, upserts: upserts() });
  const realGet = dbImpl.get;
  dbImpl.get = async () => { throw new Error('connection reset'); };
  const qw = console.warn; console.warn = () => {};
  const broken = { headers: {}, user: { id: 616 } };
  let brokeNext = 0;
  await OB.noteProfileBefore(broken, {}, () => { brokeNext++; });
  console.warn = qw;
  dbImpl.get = realGet;
  ok('⚠️ noteProfileBefore never fails the write: an unreadable profile → next() once, and nothing to close on',
    brokeNext === 1 && broken.__onboardingBefore == null, broken);
  const routes = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'profileRoutes.js'), 'utf8');
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok('⚠️ every write that can close the wizard reads "before" FIRST — the four profile routes (ahead of multer) and server.js\'s two',
    /router\.post\('\/profile\/image', noteProfileBefore, upload\.single/.test(routes) && /router\.post\('\/profile\/resume', noteProfileBefore, resumeUpload/.test(routes)
    && /router\.post\('\/profile\/signature', noteProfileBefore, upload\.single/.test(routes) && /router\.post\('\/profile\/update', noteProfileBefore, updateProfile\)/.test(routes)
    && /app\.post\('\/api\/upload-profile', authenticateToken, require\('\.\/server\/services\/onboardingProgress'\)\.noteProfileBefore, upload\.fields/.test(srv)
    && /app\.post\('\/api\/update-user-details', authenticateToken, require\('\.\/server\/services\/onboardingProgress'\)\.noteProfileBefore, async/.test(srv));
  const hooks = (srv.match(/afterProfileWrite\(req, userId\)/g) || []).length;
  ok('…and server.js has exactly the two writes that call afterProfileWrite', hooks === 2, hooks);
  // ⚠️ Review, 2026-09-20: the users row is SOFT-deleted and a re-registration revives the same id — so a progress row
  // left behind handed the new account the old one's skips (never asked for a signature) and "finished", and kept the
  // typed notes (work history) the user had asked to be deleted.
  const delAt = srv.indexOf("app.delete('/api/account/delete'");
  const delSrc = delAt >= 0 ? srv.slice(delAt, srv.indexOf('// GDPR Data Export endpoint', delAt)) : '';
  ok('⚠️ account deletion DELETES the wizard progress row (swallowed like the others), before the users row is soft-deleted',
    /try \{\s*await dbConfig\.run\('DELETE FROM user_onboarding WHERE user_id = \?', \[userId\]\);[\s\S]{0,200}\} catch \(err\) \{/.test(delSrc)
    && delSrc.indexOf('DELETE FROM user_onboarding') < delSrc.indexOf('UPDATE users SET') && delSrc.indexOf('DELETE FROM user_onboarding') > 0,
    delSrc.slice(0, 80));
  dbImpl.run = async () => { throw new Error('connection reset'); };
  const warned = []; const realWarn = console.warn; console.warn = (...a) => warned.push(a.join(' '));
  let threw = false;
  try { await OB.afterProfileWrite(wizardReq, 616); } catch { threw = true; } finally { console.warn = realWarn; }
  ok('⚠️ a failing progress write NEVER fails the profile write it follows (swallowed, logged)', !threw && warned.some((m) => /the write itself stands/.test(m)), warned);

  console.log('\n── 4 · the migration, the backfill and every write — against a REAL Postgres ──');
  const hasPg = (() => { try { execFileSync('initdb', ['--version'], { stdio: 'ignore' }); execFileSync('pg_ctl', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  if (!hasPg) {
    console.log('  · SKIPPED — initdb / pg_ctl are not on PATH (brew install postgresql). Parts 1-3 still ran.');
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onb-'));
    const data = path.join(tmp, 'd');
    const port = 20000 + Math.floor(Math.random() * 20000);
    let started = false;
    let client = null;
    try {
      execFileSync('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-sync', '-E', 'UTF8'], { stdio: 'ignore' });
      execFileSync('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${tmp} -c listen_addresses= -c fsync=off -c TimeZone=UTC`, '-w', '-l', path.join(tmp, 'log'), 'start'], { stdio: 'ignore' });
      started = true;
      const { Client } = require('pg');
      client = new Client({ host: tmp, port, user: 'postgres', database: 'postgres' });
      await client.connect();
      const q = async (sql, p = []) => (await client.query(sql, p)).rows;
      dbImpl.run = async (sql, p) => { await q(sql, p); return {}; };
      dbImpl.get = async (sql, p) => (await q(sql, p))[0] || null;
      dbImpl.query = q;

      // The slice of production's schema these statements touch.
      await q(`CREATE TABLE users (id INTEGER PRIMARY KEY, deleted_at TIMESTAMP)`);
      await q(`CREATE TABLE app_events (id BIGSERIAL PRIMARY KEY, user_id INTEGER, event TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
      await q(`CREATE TABLE user_resumes (id SERIAL PRIMARY KEY, user_id INTEGER UNIQUE, resume_data JSONB NOT NULL DEFAULT '{}')`);
      await q(`CREATE TABLE resume_metadata (user_id INTEGER PRIMARY KEY, parse_status TEXT, parse_error TEXT)`);
      await q(`CREATE TABLE async_jobs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id INTEGER NOT NULL, type TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
      // Migration 016's table, exactly — the backfill's run-once marker lives in it.
      await q(`CREATE TABLE system_schedule (job_key TEXT PRIMARY KEY, last_run_at TIMESTAMP, last_summary TEXT)`);
      await q(`INSERT INTO users (id, deleted_at) VALUES (1, NULL), (616, NULL), (700, NULL), (701, NOW()), (702, NULL), (703, NULL), (620, NULL), (621, NULL), (999, NULL)`);
      // 616: opened the wizard 3×, holds only the empty résumé. 1: opened it 6×, holds a real one. 700: opened, no résumé row.
      // 701: opened, account deleted. 702: never opened.
      await q(`INSERT INTO app_events (user_id, event, created_at) VALUES
        (616, 'onboarding_open', '2026-09-19 10:45:48.976274'), (616, 'onboarding_open', '2026-09-19 10:48:10'), (616, 'app_open', '2026-09-19 09:00:00'),
        (1, 'onboarding_open', '2026-09-10 11:56:38'), (700, 'onboarding_open', '2026-09-18 08:00:00'), (701, 'onboarding_open', '2026-09-18 08:00:00'),
        (702, 'app_open', '2026-09-18 08:00:00')`);
      await q(`INSERT INTO user_resumes (user_id, resume_data) VALUES
        (616, '{"summary":"Professional","experience":[],"education":[],"projects":[]}'),
        (1, '{"experience":[{"company":"A"},{"company":"B"}],"education":[{"x":1},{"x":2}],"projects":[1,2,3,4,5,6,7]}')`);

      await q(OB.TABLE_SQL);
      await q(OB.TABLE_SQL);
      ok('the table the migration creates exists, and creating it again is harmless', (await q(`SELECT to_regclass('user_onboarding') AS t`))[0].t === 'user_onboarding');
      const marker = async () => (await q(`SELECT job_key FROM system_schedule WHERE job_key = $1`, [OB.BACKFILL_MARKER])).length;
      // A backfill that FAILS must not leave its marker behind (one statement: the marker goes with it).
      await q(`ALTER TABLE app_events RENAME TO app_events_away`);
      let failedLoud = false;
      try { await q(OB.BACKFILL_SQL); } catch { failedLoud = true; }
      await q(`ALTER TABLE app_events_away RENAME TO app_events`);
      ok('a backfill that fails leaves NO marker (it runs again on the next boot)', failedLoud && await marker() === 0);
      await q(OB.BACKFILL_SQL);
      await q(OB.BACKFILL_SQL);
      const back = await q(`SELECT user_id, started_at FROM user_onboarding ORDER BY user_id`);
      ok('⚠️ the backfill brings back 616 (and a never-built 700) — NOT user 1 (a real résumé), a deleted account or a non-opener; twice = once',
        JSON.stringify(back.map((r) => r.user_id)) === '[616,700]', back);
      ok('…with started_at = 616\'s FIRST wizard open, read as UTC', back[0] && new Date(back[0].started_at).toISOString() === '2026-09-19T10:45:48.976Z', back[0]);
      // ⚠️ Review, 2026-09-19: db-init runs it on EVERY boot. Someone who, after the first boot, only OPENED the wizard
      // (onboarding_open) — and then perhaps completed the profile in Account Settings, which leaves no row to close —
      // must not be re-opened by the next deploy.
      await q(`INSERT INTO app_events (user_id, event, created_at) VALUES (703, 'onboarding_open', '2026-09-21 09:00:00')`);
      await q(OB.BACKFILL_SQL);
      const back2 = await q(`SELECT user_id FROM user_onboarding ORDER BY user_id`);
      ok('⚠️ ONCE, EVER: the next boot\'s backfill (a new opener, 703, with no résumé) inserts nothing — the marker is claimed',
        JSON.stringify(back2.map((r) => r.user_id)) === '[616,700]' && await marker() === 1, back2);

      // touch / merge / markBuild / finish / close — the real statements.
      await OB.touch(620, { notes: 'x'.repeat(50), lane: 'write' });
      await OB.touch(620, { skipped: { photo: true } });
      await OB.touch(620, { skipped: { signature: true }, lane: 'bogus' });
      let r = await OB.get(620);
      ok('touch creates the row, keeps notes and lane it was not given, and MERGES skips',
        r && r.notes.length === 50 && r.lane === 'write' && r.skipped.photo === true && r.skipped.signature === true, r);
      await OB.touch(620, { notes: '' });
      ok('…an explicit empty notes string is written (they cleared the box)', (await OB.get(620)).notes === '');
      const job = (await q(`INSERT INTO async_jobs (user_id, type, status) VALUES (620, 'resume_generate_ai', 'processing') RETURNING id`))[0].id;
      const oldJob = (await q(`INSERT INTO async_jobs (user_id, type, status, created_at) VALUES (620, 'resume_generate_ai', 'processing', CURRENT_TIMESTAMP - INTERVAL '20 minutes') RETURNING id`))[0].id;
      await OB.markBuild(620, job);
      r = await OB.get(620);
      ok('markBuild records the job and when it started', r.build_job_id === job && !!r.build_started_at, r);
      const j1 = await OB.jobOf(job, 620), j2 = await OB.jobOf(oldJob, 620), j3 = await OB.jobOf(job, 999);
      const quiet = console.warn; console.warn = () => {};
      const j4 = await OB.jobOf('not-a-uuid', 620);
      console.warn = quiet;
      ok('jobOf: a fresh job is fresh, a 20-minute-old one is not, another user\'s is invisible, a malformed id is null (not a throw)',
        j1 && j1.fresh === true && j1.status === 'processing' && j2 && j2.fresh === false && j3 === null && j4 === null, { j1, j2, j3, j4 });
      let nexted = 0; const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      await OB.joinRunningWizardBuild({ user: { id: 620 }, body: { source: 'onboarding', __async: true } }, res, () => { nexted++; });
      ok('⚠️ the route middleware, on real rows: the running wizard job is JOINED (202, same id), nothing new starts',
        res.code === 202 && res.body.jobId === job && nexted === 0, res.body);

      // 620 skipped both the photo and the signature and typed 50 characters of notes: by the WIZARD's fields, the
      // details are all that was missing — no date of birth, no files.
      await OB.touch(620, { notes: 'x'.repeat(50) });
      // The address is the one thing missing until Account Settings saves it.
      const req620 = { headers: {}, user: { id: 620 } };
      inputsFor[620] = { profile: { ...ME, address: '' }, files: { photo: false, signature: false, resume: false }, cv: null };
      await OB.noteProfileBefore(req620, {}, () => {});
      inputsFor[620] = { profile: ME, files: { photo: false, signature: false, resume: false }, cv: null };
      await OB.afterProfileWrite(req620, 620);
      r = await OB.get(620);
      ok('the Account Settings write that COMPLETED the profile by the wizard\'s fields (skips + notes, no DOB, no files) closes the open wizard',
        req620.__onboardingBefore === false && !!r.closed_at && r.closed_by === 'account_settings', { before: req620.__onboardingBefore, r });
      ok('…and a second close is a no-op', await OB.closeIfCompletedElsewhere(620, false) === false);

      await OB.finish(621);
      const f1 = (await OB.get(621)).finished_at;
      await new Promise((res2) => setTimeout(res2, 20));
      await OB.finish(621);
      ok('finish() creates the row if it must, and keeps the FIRST finished_at', !!f1 && new Date((await OB.get(621)).finished_at).getTime() === new Date(f1).getTime());
      inputsFor[621] = { profile: ME, files: ALL, cv: { ext: 'PDF', uploadedAt: null } };
      ok('…and a finished wizard is never "closed" afterwards', await OB.closeIfCompletedElsewhere(621, false) === false);

      // stateFor, end to end, for 616 as backfilled.
      await q(`INSERT INTO resume_metadata (user_id, parse_status) VALUES (616, 'done')`);
      const st = await OB.stateFor(616, { profile: ME, files: ALL, cv: { ext: 'PDF', uploadedAt: null } });
      ok('⚠️ stateFor(616) on real rows: "open" at Build — the Pick-up button\'s answer after every restart, on every device',
        st && st.state === 'open' && st.stepKey === 'build' && st.builtResume === false && st.cv.status === 'done', st);
      // ⚠️ Review round 2: 616 re-saves his phone in Account Settings after the deploy. His profile was already complete.
      const req616 = { headers: {}, user: { id: 616 } };
      inputsFor[616] = { profile: ME, files: ALL, cv: { ext: 'PDF', uploadedAt: null } };
      await OB.noteProfileBefore(req616, {}, () => {});
      await OB.afterProfileWrite(req616, 616);
      const r616 = await OB.get(616);
      ok('⚠️ …then an Account Settings save that completes NOTHING (his profile was already complete) leaves it OPEN — "Pick up" stays',
        req616.__onboardingBefore === true && r616 && !r616.closed_at && !r616.finished_at, { before: req616.__onboardingBefore, r616 });
      const st1 = await OB.stateFor(1, { profile: ME, files: ALL, cv: null });
      ok('…and user 1: "none", with a built résumé that has content', st1 && st1.state === 'none' && st1.builtResume === true, st1);
      await OB.touch(1, { skipped: { photo: true } });
      const st1w = await OB.stateFor(1, { profile: ME, files: { photo: false, signature: true, resume: false }, cv: null });
      ok('⚠️ …then user 1 saves ONE thing through the wizard (a skip): "finished", nothing left — never "Pick up … building your resume"',
        st1w && st1w.state === 'finished' && st1w.left.length === 0, st1w);

      // ⚠️ Account deletion (review, 2026-09-20): 620 skipped the photo and the signature, typed notes, and was closed.
      // The deletion handler's OWN statement (read out of server.js) runs here; the revived account starts from nothing.
      const delStmt = (/await dbConfig\.run\('(DELETE FROM user_onboarding WHERE user_id = \?)', \[userId\]\);/.exec(delSrc) || [])[1];
      if (delStmt) await dbImpl.run(delStmt.replace('?', '$1'), [620]);
      const st620 = await OB.stateFor(620, { profile: ME, files: { photo: false, signature: false, resume: false }, cv: null });
      ok('⚠️ after the account-deletion statement, a re-registered 620 has NO progress: state "none", no skips, no notes — asked for a signature again',
        !!delStmt && (await OB.get(620)) === null && st620 && st620.state === 'none' && st620.skipped.signature === false && st620.notes === ''
        && st620.left.includes('your signature'), { delStmt, st620 });
    } catch (e) {
      ok('the real-Postgres part ran without an error', false, e.message);
    } finally {
      try { if (client) await client.end(); } catch {}
      if (started) { try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' }); } catch {} }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

  console.log(`\nonboarding progress: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
