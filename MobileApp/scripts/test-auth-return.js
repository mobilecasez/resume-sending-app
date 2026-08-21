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
  grab(/export function isBlockedEmbeddedAuth[\s\S]*?\n}\n/, 'isBlockedEmbeddedAuth'),
  'module.exports = { isAuthUrl, isPostMessageOnlyAuth, isBlockedEmbeddedAuth };',
].join('\n').replace(/export function/g, 'function').replace(/: string\)/g, ')').replace(/: boolean/g, '');
const m = new module.constructor();
m._compile(harness, '/joburl-harness.js');
const { isAuthUrl, isPostMessageOnlyAuth, isBlockedEmbeddedAuth } = m.exports;

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

console.log('── Google OAuth is intercepted BEFORE it can render blank ──');
// Reported twice: a blank accounts.google.com after choosing an account. Google has blocked
// embedded web views since Feb 2023, and WKWebView has had a null window.opener since iOS 17.5 —
// both documented, both unfixed by the vendor. So these must never be allowed to load here.
ok('the OAuth authorize endpoint', isBlockedEmbeddedAuth('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'));
ok('the consent step', isBlockedEmbeddedAuth('https://accounts.google.com/signin/oauth/consent?a=1'));
ok('Google Identity Services', isBlockedEmbeddedAuth('https://accounts.google.com/gsi/select'));
ok('the classic ServiceLogin', isBlockedEmbeddedAuth('https://accounts.google.com/ServiceLogin?continue=x'));
// ⚠️ Scoped to the OAuth endpoints. Cancelling every google.com hop would break ordinary browsing.
ok('a Google SEARCH page is not intercepted', !isBlockedEmbeddedAuth('https://www.google.com/search?q=jobs'));
ok('a Google careers job page is not intercepted',
  !isBlockedEmbeddedAuth('https://www.google.com/about/careers/applications/jobs/results/123-engineer'));
ok('accounts.google.com root is not intercepted', !isBlockedEmbeddedAuth('https://accounts.google.com/'));
ok('a job site is never intercepted', !isBlockedEmbeddedAuth('https://www.glassdoor.com/job-listing/x.htm'));

const jd0 = fs.readFileSync(path.join(__dirname, '../app/(ai-hub)/job-detail.tsx'), 'utf8');
ok('the web view cancels it instead of loading it', /isBlockedEmbeddedAuth\(u\)\) \{ offerBrowserSignIn\(\); return false; \}/.test(jd0));
ok('the pop-up path refuses it too', /isPostMessageOnlyAuth\(target\) \|\| isBlockedEmbeddedAuth\(target\)/.test(jd0));
ok('the user is offered email OR their browser, not a dead end',
  /Use email instead/.test(jd0) && /Open in browser/.test(jd0));

console.log('── the two code paths ──');
const jd = fs.readFileSync(path.join(__dirname, '../app/(ai-hub)/job-detail.tsx'), 'utf8');
ok('redirect-style sign-in arms preAuthUrlRef',
  /!preAuthUrlRef\.current && isAuthUrl\(nav\.url\)[\s\S]{0,220}preAuthUrlRef\.current = lastNonAuthUrlRef\.current \|\| prevUrl;/.test(jd));
ok('it reads the PREVIOUS url, captured before currentUrlRef is overwritten',
  /const prevUrl = currentUrlRef\.current;[\s\S]{0,200}currentUrlRef\.current = nav\.url;/.test(jd));
// ⚠️ This assertion used to demand the OPPOSITE — "never remember an auth page" — and that rule is
// precisely what broke Glassdoor, whose sign-in STARTS on /member/profile/login. The rule now is:
// PREFER a real page, but never end up with nothing.
ok('a real page is preferred over a sign-in page',
  /fromUrl && !isAuthUrl\(fromUrl\) \? fromUrl : ''/.test(jd));
ok('but we never end up remembering nothing', /\|\| currentUrlRef\.current\s*\n?\s*\|\| '';/.test(jd) || /\|\| fromUrl\s*\n\s*\|\| currentUrlRef\.current/.test(jd));
ok('the auth banner is actually rendered now', /\{authBanner && \(/.test(jd));
ok('the banner offers a way back', /Back to form/.test(jd));

console.log('── a sign-in that STARTS on a login page still has somewhere to return to ──');
// Glassdoor's login page is /member/profile/login, and BOTH its buttons ("Continue with Google"
// and "Continue with Apple or email") call window.open — the Apple/email one to Indeed's OAuth,
// since Glassdoor is Indeed-owned. beginAuthFlow used to store the return point only when the page
// we came FROM was not itself a sign-in page, so on Glassdoor it stored NOTHING and every recovery
// path silently no-opped. That is the "nothing happens" the user reported.
ok('Glassdoor\'s own login page is classified as auth (why the old rule failed)',
  isAuthUrl('https://www.glassdoor.com/member/profile/login'));
ok('so is the Indeed OAuth popup target', isAuthUrl('https://www.glassdoor.com/auth/login/oauth2/code/indeed?authNonce=x'));
const jd2 = fs.readFileSync(path.join(__dirname, '../app/(ai-hub)/job-detail.tsx'), 'utf8');
ok('a last-non-auth-page ref exists', /lastNonAuthUrlRef/.test(jd2));
ok('it is kept fresh on navigation', /!isAuthUrl\(nav\.url\)\) lastNonAuthUrlRef\.current = nav\.url;/.test(jd2));
ok('beginAuthFlow now always records SOMETHING', /if \(back\) \{\s*\n\s*preAuthUrlRef\.current = back;/.test(jd2));
ok('it prefers a real (non-auth) page over the login page', /fromUrl && !isAuthUrl\(fromUrl\) \? fromUrl : ''\)\s*\n\s*\|\| lastNonAuthUrlRef\.current/.test(jd2));
ok('the auth origin is derived from what we actually stored', /new URL\(preAuthUrlRef\.current\)\.origin/.test(jd2));

console.log('── a site running its OWN redirect round trip must not be interrupted ──');
// Reported on 185: "Redirecting to Indeed for one login… then nothing, same page again."
// Glassdoor's pop-up target is SAME-ORIGIN (/auth/login/oauth2/code/indeed) and carries
// originationURL=<page to come back to> — the site returns the user itself. Our auto-return fired
// when the chain landed back on glassdoor.com and sent them to where the flow STARTED: the login
// page. We were fighting the site's own redirect. Auto-return is now cross-origin only.
const jd3 = fs.readFileSync(path.join(__dirname, '../app/(ai-hub)/job-detail.tsx'), 'utf8');
ok('an explicit auto-return flag exists', /autoReturnRef/.test(jd3));
ok('beginAuthFlow decides it by comparing ORIGINS', /crossOrigin = new URL\(target\)\.origin !== /.test(jd3));
ok('the auto-return trigger requires the flag', /nav\.url && autoReturnRef\.current && preAuthUrlRef\.current/.test(jd3));
ok('the redirect-arming path applies the same rule',
  /autoReturnRef\.current = new URL\(nav\.url\)\.origin !== new URL\(preAuthUrlRef\.current\)\.origin/.test(jd3));
ok('the banner only claims a takeover we are actually managing', /if \(autoReturnRef\.current\) setAuthBanner\(true\);/.test(jd3));
// ⚠️ The return point is still remembered either way, so the manual "Back to form" button works
// even on a same-origin flow we are deliberately not steering.
ok('the return point is still recorded for the manual button', /preAuthUrlRef\.current = back;/.test(jd3));

// The origin rule, stated as data so the intent is unambiguous.
const sameOrigin = (a2, b2) => { try { return new URL(a2).origin === new URL(b2).origin; } catch { return false; } };
ok('Glassdoor pop-up is same-origin → site drives it',
  sameOrigin('https://www.glassdoor.com/auth/login/oauth2/code/indeed?x=1', 'https://www.glassdoor.com/member/profile/login'));
ok('Google is cross-origin → we drive it',
  !sameOrigin('https://accounts.google.com/o/oauth2/v2/auth', 'https://www.glassdoor.com/member/profile/login'));
ok('Apple is cross-origin → we drive it',
  !sameOrigin('https://appleid.apple.com/auth/authorize', 'https://www.glassdoor.com/member/profile/login'));

console.log('── the search sheet must stop moving under the clock ──');
const sl = fs.readFileSync(path.join(__dirname, '../components/JobSearchLauncher.tsx'), 'utf8');
ok('the sheet is bounded by the real top inset', /useSafeAreaInsets/.test(sl) && /winH - insets\.top/.test(sl));
ok('the sheet has a maxHeight applied', /maxHeight: sheetMaxH/.test(sl));
ok('the suggestion list is capped to a row count', /SUG_MAX_ROWS/.test(sl) && /Math\.min\(items\.length, SUG_MAX_ROWS\)/.test(sl));
ok('the list sits in a FIXED slot so item count cannot resize the sheet', /height: SUG_MAX_H \+ 6/.test(sl));
ok('overflow past the cap scrolls instead of growing', /nestedScrollEnabled/.test(sl));

console.log(`\nauth return + search sheet: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
