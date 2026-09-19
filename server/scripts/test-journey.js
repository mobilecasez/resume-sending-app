// The activation coach points at ONE of five steps and opens ONE of five films. Three things can
// silently break that, and none of them would throw:
//   1. the server's step keys drifting from the app's film keys → the coach opens the wrong film
//   2. the ORDER drifting from the films' on-screen "01…05" numbering → "Step 3 of 5" plays film 04
//   3. "next step" logic picking the wrong step for a user who did things out of order
// All three are asserted here. No database and no network.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + extra : ''}`); } };

// STEPS is pulled out of the SOURCE rather than required: services/journey.js opens the database
// on require, and this suite must run anywhere, including CI with no DATABASE_URL.
const journeySrc = fs.readFileSync(path.join(__dirname, '../services/journey.js'), 'utf8');
const stepsLit = journeySrc.match(/const STEPS = \[([\s\S]*?)\n\];/);
const STEPS = [...stepsLit[1].matchAll(/key:\s*'([a-z_]+)'/g)].map((m) => ({ key: m[1] }));

// ── 1. server keys ↔ app film keys ────────────────────────────────────────────────────────────
const tut = fs.readFileSync(path.join(__dirname, '../../MobileApp/app/(tutorial)/index.tsx'), 'utf8');
const filmBlock = tut.match(/const FILMS = \[([\s\S]*?)\] as const;/);
ok('tutorial exposes a FILMS table', !!filmBlock);
const films = [...filmBlock[1].matchAll(/key:\s*'([a-z_]+)',\s*n:\s*(\d+),\s*file:\s*'([^']+)'/g)]
  .map((m) => ({ key: m[1], n: Number(m[2]), file: m[3] }));

ok('five films', films.length === 5, films.length);
ok('five server steps', STEPS.length === 5, STEPS.length);
ok('film keys EXACTLY match server step keys, in order',
  films.map((f) => f.key).join(',') === STEPS.map((s) => s.key).join(','),
  `${films.map((f) => f.key).join(',')}  vs  ${STEPS.map((s) => s.key).join(',')}`);
ok('film numbers are 1..5 in order', films.map((f) => f.n).join(',') === '1,2,3,4,5', films.map((f) => f.n).join(','));

// ── 2. every film file actually exists and is servable ────────────────────────────────────────
// A missing file is a spinner that never resolves; the app cannot tell you which one is absent.
for (const f of films) {
  const p = path.join(__dirname, '../../public/media', f.file);
  const st = (() => { try { return fs.statSync(p); } catch { return null; } })();
  ok(`${f.file} exists`, !!st);
  // ⚠️ Bundling these would be the one thing the user explicitly ruled out, and a 0-byte or
  // truncated file looks identical to a slow network on device.
  ok(`${f.file} is a plausible video`, !!st && st.size > 300_000, st ? `${Math.round(st.size / 1024)}KB` : 'missing');
  const head = fs.readFileSync(p).subarray(0, 200000);
  const moov = head.indexOf(Buffer.from('moov')), mdat = head.indexOf(Buffer.from('mdat'));
  // +faststart is what lets playback begin before the download finishes. Without it the film
  // buffers to the end first, which on mobile data reads as "broken".
  ok(`${f.file} is +faststart`, moov >= 0 && (mdat < 0 || moov < mdat), `moov@${moov} mdat@${mdat}`);
  ok(`${f.file} has a poster`, fs.existsSync(path.join(__dirname, '../../public/media', f.file.replace(/\.mp4$/, '-poster.jpg'))));
}

// ── 3. next-step selection ────────────────────────────────────────────────────────────────────
// Reimplements only the one line under test, against the real STEPS order.
const nextFor = (doneKeys) => {
  const done = new Set(doneKeys);
  const s = STEPS.find((x) => !done.has(x.key));
  return s ? s.key : null;
};
ok('a brand-new user is sent to step 1', nextFor([]) === 'profile', nextFor([]));
ok('after profile → résumé', nextFor(['profile']) === 'resume');
ok('after profile+résumé → save a job', nextFor(['profile', 'resume']) === 'save_job');
ok('all five done → nothing to point at', nextFor(STEPS.map((s) => s.key)) === null);
// ⚠️ The real case that breaks a naive "step after the last completed one": people DO apply before
// finishing their profile (production has users at [.xxxx]). They still need the profile step.
ok('someone who applied but skipped the profile is still sent to the profile',
  nextFor(['resume', 'save_job', 'cover_letter', 'apply']) === 'profile',
  nextFor(['resume', 'save_job', 'cover_letter', 'apply']));
ok('a gap in the middle is picked up, not skipped',
  nextFor(['profile', 'resume', 'cover_letter', 'apply']) === 'save_job');

// ── 4. the coach must not appear once activation is complete ──────────────────────────────────
const coach = fs.readFileSync(path.join(__dirname, '../../MobileApp/components/JourneyCoach.tsx'), 'utf8');
ok('coach renders nothing when the journey is complete', /if \(!journey \|\| journey\.complete \|\| !next\) return null;/.test(coach));
// One driver everywhere — mixing them is what crashed builds 126-128.
ok('no useNativeDriver: true anywhere in the coach', !/useNativeDriver:\s*true/.test(coach));

// ── switching chapters must START the next film, not resume into it ───────────────────────────
// Reported: switching from 20s into film 1 started film 2 at 0:20. expo-av REUSES the player when
// only `source` changes, and it keeps the old playhead.
ok('the player is keyed on the film, forcing a fresh one', /key=\{film\.file\}/.test(tut));
ok('position is stated explicitly', /positionMillis=\{0\}/.test(tut));
ok('and rewound on load as a fallback', /setPositionAsync\(0\)/.test(tut));

// ── every door into the tutorial opens the RIGHT clip (2026-09-19) ────────────────────────────
// Reported: tapping "Watch the app fill a job form for you" opened clip 01 "Set up your profile".
// The push half is pinned in tools/test-notify-templates.js + MobileApp/scripts/test-push-routing.js;
// this is the screen half and the in-app doors, asserted on the source (no RN runtime here).
const stepKeys = STEPS.map((s) => s.key);
ok('the screen reads `until` (a run of clips, e.g. 04 → 05)', /until:\s*untilRaw/.test(tut) && /chainEndFor\(untilParam/.test(tut));
// ⚠️ A push tapped while the tutorial is open reaches THE SAME instance with new params. `at` is
// seeded by a useState initialiser, so without an effect on the params the new clip was ignored.
ok('the screen re-applies film/until/nid when they CHANGE while mounted',
  /useEffect\(\(\) => \{[\s\S]*?appliedParams[\s\S]*?\}, \[filmParam, untilParam, nid, replay\]\);/.test(tut));
ok('a finished clip rolls into the next one while a chain is running',
  /chainRef\.current > cur[\s\S]{0,60}selectFilmRef\.current\(cur \+ 1\)/.test(tut));
ok('a chip tap cancels the chain (the user took the wheel)', /onPress=\{\(\) => pickFilm\(i\)\}/.test(tut) && /setChainTo\(-1\); selectFilm\(i\)/.test(tut));
ok('the player pauses when something covers the screen', /useFocusEffect\(useCallback\(\(\) => \(\) => \{[\s\S]*?pauseAsync\(\)/.test(tut));

// ⚠️ …and that pause is why a retarget onto the SAME clip must play it. It used to be "leave it
// alone, it is still playing": blur (above), the user, or the app going to the background had
// paused it, and the push tap that said "watch" left a frozen frame. retargetFor is the pure rule;
// it is compiled from the real source (the TS annotations need the compiler) and run here.
const retargetSrc = tut.match(/const retargetFor = [\s\S]*?;\n/);
ok('the screen has a pure retarget rule (retargetFor)', !!retargetSrc);
const retargetFor = (() => {
  if (!retargetSrc) return null;
  let ts = null;
  for (const p of [path.join(__dirname, '../../MobileApp/node_modules/typescript'), 'typescript']) {
    try { ts = require(p); break; } catch (_) { /* try the next */ }
  }
  if (!ts) return null;
  const js = ts.transpileModule(retargetSrc[0] + '\nmodule.exports = retargetFor;',
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  const m = { exports: null };
  new Function('module', js)(m);
  return m.exports;
})();
ok('retargetFor compiles (typescript available under MobileApp/node_modules)', typeof retargetFor === 'function');
if (typeof retargetFor === 'function') {
  ok('another clip → switch to it', retargetFor(3, 0, false) === 'switch' && retargetFor(3, 0, true) === 'switch');
  ok('the same clip, finished → replay it', retargetFor(3, 3, true) === 'replay');
  ok('the same clip, paused mid-way (blur / background / the user) → resume, never "do nothing"',
    retargetFor(3, 3, false) === 'resume');
}
ok('"resume" actually plays the player (playAsync), after switch and replay are handled',
  /if \(act === 'switch'\) selectFilmRef\.current\(i\);[\s\S]{0,120}else if \(act === 'replay'\) replay\(\);[\s\S]{0,400}else videoRef\.current\?\.playAsync\(\)/.test(tut));

// ⚠️ Retargeting changes `nid` on a MOUNTED screen. Anything keyed on it re-ran mid-watch:
// tutorial_opened fired for the clip still on screen under the NEW push (then again for the real
// one), and the unmount flush's cleanup sent reason 'unmount' with nothing unmounted.
ok('tutorial_opened fires per film only — nid is read, not a trigger',
  /track\('tutorial_opened', \{[^\n]*nid: nidRef\.current[^\n]*\}, \[film\.file, film\.key\]\);/.test(tut));
ok('flush is stable (no deps), so its subscribers never re-run mid-watch',
  /const flush = useCallback\(\(reason: string\) => \{[\s\S]*?\n  \}, \[\]\);/.test(tut));
ok('the unmount flush depends on nothing that changes', /useEffect\(\(\) => \(\) => \{ flush\('unmount'\); \}, \[flush\]\);/.test(tut));
ok('each watch record carries the nid it was opened under', /nid: w\.nid \|\| undefined/.test(tut)
  && /key: FILMS\[i\]\.key, nid: nidRef\.current \}/.test(tut));
ok('no event reads the live `nid` (it would credit the outgoing clip to the new push)', !/nid: nid \|\|/.test(tut));
// One driver per view tree — mixing them is what crashed builds 126-128.
ok('no useNativeDriver: true in the tutorial', !/useNativeDriver:\s*true/.test(tut));

const help = fs.readFileSync(path.join(__dirname, '../../MobileApp/components/HelpAssistant.js'), 'utf8');
const kbBlock = help.match(/const KB = \[([\s\S]*?)\n\];/);
const kbTopics = kbBlock ? [...kbBlock[1].matchAll(/id:\s*'([a-z_]+)',[^\n]*?film:\s*'([a-z_]+)'/g)].map((m) => ({ id: m[1], film: m[2] })) : [];
const kbIds = kbBlock ? [...kbBlock[1].matchAll(/\n    id:\s*'([a-z_]+)'/g)].map((m) => m[1]) : [];
ok('every help topic names its clip', kbIds.length > 0 && kbTopics.length === kbIds.length, `${kbTopics.length} of ${kbIds.length}`);
for (const t of kbTopics) ok(`help topic '${t.id}' → a real clip ('${t.film}')`, stepKeys.includes(t.film), t.film);
ok("the topic's clip reaches the film button", /film: topic\.film/.test(help) && /film: t\.film/.test(help)
  && /tutorialHref\(answer && answer\.film \? \{ film: answer\.film \} : null\)/.test(help));
const ctxBlock = help.match(/const CONTEXT_FILM = \{([\s\S]*?)\n\};/);
const ctxFilms = ctxBlock ? [...ctxBlock[1].matchAll(/(?:film|until):\s*'([a-z_]+)'/g)].map((m) => m[1]) : [];
ok('the help sheet maps its screen to a clip', ctxFilms.length > 0 && /tutorialHref\(CONTEXT_FILM\[context\]\)/.test(help));
for (const f of ctxFilms) ok(`help sheet clip '${f}' is real`, stepKeys.includes(f), f);

const launcher = fs.readFileSync(path.join(__dirname, '../../MobileApp/components/JobSearchLauncher.tsx'), 'utf8');
const launch = launcher.match(/pathname: TUTORIAL_ROUTE, params: \{ film: '([a-z_]+)', until: '([a-z_]+)' \}/);
ok('the Jobs "watch how it works" row names its clips', !!launch);
ok('…and they are real, in order (03 → 05)', !!launch && stepKeys.indexOf(launch[1]) >= 0 && stepKeys.indexOf(launch[2]) > stepKeys.indexOf(launch[1]),
  launch ? `${launch[1]} → ${launch[2]}` : 'missing');

console.log(`\njourney: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
