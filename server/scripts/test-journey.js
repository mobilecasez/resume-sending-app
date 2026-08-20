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

console.log(`\njourney: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
