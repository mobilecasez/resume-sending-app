// Sign-in inside the apply WebView, and the two ways it stranded users.
//
// REPORTED: "logged in with Google on Glassdoor — got the Continue screen, then all blank, nothing
// happened." The cause was not the sign-in itself. preAuthUrlRef (where we remember the half-filled
// form) was ONLY ever set by beginAuthFlow, which runs from the window.open hook — so a site that
// sends the MAIN FRAME to the provider instead of opening a pop-up never armed it. returnFromAuth,
// the storagerelay guard and the sign-in-finished check all read that ref first and silently do
// nothing when it is empty. Nothing to click, nothing to explain it: a blank page.
//
// These assertions cover the URL classification the fix depends on, and pin the two code paths.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; } else { fail++; console.log(`  ✗ ${n}${x !== undefined ? ' → ' + x : ''}`); } };

// ── isAuthUrl / isPostMessageOnlyAuth, lifted from source (the utils are TS) ───────────────────
const src = fs.readFileSync(path.join(__dirname, '../utils/jobUrl.ts'), 'utf8');
const grab = (re, what) => { const m = src.match(re); if (!m) throw new Error('missing ' + what); return m[0]; };
const harness = [
  grab(/const AUTH_SEG = [^\n]*\n/, 'AUTH_SEG'),
  grab(/const AUTH_FILE = [^\n]*\n/, 'AUTH_FILE'),
  grab(/export function isPostMessageOnlyAuth[\s\S]*?\n}\n/, 'isPostMessageOnlyAuth'),
  grab(/export function isAuthUrl[\s\S]*?\n}\n/, 'isAuthUrl'),
  'module.exports = { isAuthUrl, isPostMessageOnlyAuth };',
].join('\n').replace(/export function/g, 'function').replace(/: string\)/g, ')').replace(/: boolean/g, '');
const m = new module.constructor();
m._compile(harness, '/joburl-harness.js');
const { isAuthUrl, isPostMessageOnlyAuth } = m.exports;

console.log('── the provider pages we must recognise as "signing in" ──');
// If this is false, the fix never arms and the user is stranded exactly as reported.
ok('accounts.google.com is an auth URL', isAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https%3A%2F%2Fwww.glassdoor.com%2Fcb'));
ok('the Google consent step too', isAuthUrl('https://accounts.google.com/signin/oauth/consent?authuser=0'));
ok('a site login path', isAuthUrl('https://www.glassdoor.com/profile/login_input.htm'));
ok('a /signin path', isAuthUrl('https://careers.example.com/signin'));
ok('an auth FILE with an extension', isAuthUrl('https://www.example.com/account/signin.aspx'));
ok('login.microsoftonline.com', isAuthUrl('https://login.microsoftonline.com/common/oauth2/authorize'));

console.log('── and the pages that must NOT be mistaken for sign-in ──');
// A false positive here is worse than the bug: it would hijack an ordinary job page.
ok('a Glassdoor job page is not auth', !isAuthUrl('https://www.glassdoor.com/job-listing/senior-engineer-JV_IC123.htm'));
ok('a Greenhouse application form is not auth', !isAuthUrl('https://boards.greenhouse.io/acme/jobs/12345'));
ok('an OAuth CALLBACK on the site is not auth (that is the return leg)',
  !isAuthUrl('https://www.glassdoor.com/callback?code=abc123'));
ok('a careers page is not auth', !isAuthUrl('https://jobs.example.com/careers/search'));
// ⚠️ The reason AUTH_FILE demands an extension. A bare-slug rule would swallow this job.
ok('a job slug that merely CONTAINS sign-in is not auth',
  !isAuthUrl('https://boards.greenhouse.io/acme/jobs/sign-in-systems-engineer'));
ok('a "login" job slug is not auth', !isAuthUrl('https://jobs.example.com/roles/login-platform-engineer'));

console.log('── pop-up-only flows still refuse up front ──');
ok('GIS /gsi/ is pop-up-only', isPostMessageOnlyAuth('https://accounts.google.com/gsi/select?client_id=x'));
ok('storagerelay redirect_uri is pop-up-only',
  isPostMessageOnlyAuth('https://accounts.google.com/o/oauth2/auth?redirect_uri=storagerelay%3A%2F%2Fhttps%2Fglassdoor.com'));
ok('a normal redirect flow is NOT pop-up-only — it can finish in the web view',
  !isPostMessageOnlyAuth('https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fwww.glassdoor.com%2Fcb'));

console.log('── the two code paths ──');
const jd = fs.readFileSync(path.join(__dirname, '../app/(ai-hub)/job-detail.tsx'), 'utf8');
ok('redirect-style sign-in now arms preAuthUrlRef',
  /!preAuthUrlRef\.current && isAuthUrl\(nav\.url\)[\s\S]{0,180}preAuthUrlRef\.current = prevUrl;/.test(jd));
ok('it reads the PREVIOUS url, captured before currentUrlRef is overwritten',
  /const prevUrl = currentUrlRef\.current;[\s\S]{0,200}currentUrlRef\.current = nav\.url;/.test(jd));
ok('it will not remember an auth page as the form to return to', /&& !isAuthUrl\(prevUrl\)/.test(jd));
ok('the auth banner is actually rendered now', /\{authBanner && \(/.test(jd));
ok('the banner offers a way back', /Back to form/.test(jd));

console.log('── the search sheet must stop moving under the clock ──');
const sl = fs.readFileSync(path.join(__dirname, '../components/JobSearchLauncher.tsx'), 'utf8');
ok('the sheet is bounded by the real top inset', /useSafeAreaInsets/.test(sl) && /winH - insets\.top/.test(sl));
ok('the sheet has a maxHeight applied', /maxHeight: sheetMaxH/.test(sl));
ok('the suggestion list is capped to a row count', /SUG_MAX_ROWS/.test(sl) && /Math\.min\(items\.length, SUG_MAX_ROWS\)/.test(sl));
ok('the list sits in a FIXED slot so item count cannot resize the sheet', /height: SUG_MAX_H \+ 6/.test(sl));
ok('overflow past the cap scrolls instead of growing', /nestedScrollEnabled/.test(sl));

console.log(`\nauth return + search sheet: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
