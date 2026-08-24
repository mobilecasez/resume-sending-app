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
// ⚠️ CAPTURED LIVE FROM GLASSDOOR'S OWN BUTTON (2026-08-24), and the old rule MISSED it:
//   window.open('…/o/oauth2/v2/auth?gsiwebsdk=gis_attributes&redirect_uri=gis_transform
//                &response_type=token&display=popup&response_mode=form_post', 'g_auth_token_window_…')
// `gis_transform` is a GIS sentinel, not an address — the token goes into the pop-up and is relayed
// to window.opener, so nothing ever comes back to glassdoor.com. THIS is why Glassdoor's Google
// button fails here while Indeed's works: Indeed's redirect_uri is a real URL.
ok('Glassdoor’s real GIS pop-up URL is refused',
  isPostMessageOnlyAuth('https://accounts.google.com/o/oauth2/v2/auth?gsiwebsdk=gis_attributes&client_id=x&redirect_uri=gis_transform&response_type=token&display=popup&response_mode=form_post'));
ok('Indeed’s real redirect URL is ALLOWED — it is the one that works on a device',
  !isPostMessageOnlyAuth('https://accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fsecure.indeed.com%2Faccount%2Fgoogleauth'));
ok('a native-app custom scheme cannot land here either',
  isPostMessageOnlyAuth('https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=com.example.app%3A%2Foauth'));
ok('the rule is the PROPERTY, not a list of sentinels',
  /ru && !\/\^https\?:/.test(fs.readFileSync(path.join(__dirname, '../utils/jobUrl.ts'), 'utf8')));
ok('Glassdoor is told about the Indeed route instead of just "use your browser"',
  /hasIndeedGoogleRoute/.test(fs.readFileSync(path.join(__dirname, '../utils/jobUrl.ts'), 'utf8'))
  && /Continue with Apple or email/.test(fs.readFileSync(path.join(__dirname, '../app/(ai-hub)/job-detail.tsx'), 'utf8')));
ok('GIS /gsi/ is pop-up-only', isPostMessageOnlyAuth('https://accounts.google.com/gsi/select?client_id=x'));
ok('storagerelay redirect_uri is pop-up-only',
  isPostMessageOnlyAuth('https://accounts.google.com/o/oauth2/auth?redirect_uri=storagerelay%3A%2F%2Fhttps%2Fglassdoor.com'));
ok('a normal redirect flow is NOT pop-up-only — it can finish in the web view',
  !isPostMessageOnlyAuth('https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fwww.glassdoor.com%2Fcb'));

console.log('── Google OAuth is ALLOWED to run, and its refusal is detected, not predicted ──');
// ⚠️ THIS SECTION USED TO ASSERT THE EXACT OPPOSITE, and the assertions were the bug.
// isBlockedEmbeddedAuth cancelled every accounts.google.com OAuth navigation on the theory that
// Google's embedded-webview block makes it impossible here. Field evidence: the user signed in to
// Glassdoor via Indeed, chose "log in with Google", and it completed normally in this same view —
// it only got the chance because Indeed starts Google with a 302, and WKWebView does not consult
// onShouldStartLoadWithRequest on a server redirect. Every path the block DID reach, it broke.
const ju = fs.readFileSync(path.join(__dirname, '../utils/jobUrl.ts'), 'utf8');
ok('isBlockedEmbeddedAuth is gone from jobUrl.ts', !/export function isBlockedEmbeddedAuth/.test(ju));
ok('and the reason it is gone is written down where it lived',
  /USED TO LIVE HERE, AND DELETING IT IS THE FIX/.test(ju));

const jd0 = fs.readFileSync(path.join(__dirname, '../app/(ai-hub)/job-detail.tsx'), 'utf8');
const bf0 = fs.readFileSync(path.join(__dirname, '../components/BrowseFetch.tsx'), 'utf8');
const code = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
ok('no call site cancels a Google navigation any more', !/isBlockedEmbeddedAuth\(/.test(code(jd0)));
ok('the pop-up path refuses ONLY what cannot be delivered',
  /if \(isPostMessageOnlyAuth\(target\)\) \{/.test(jd0)
  && !/isPostMessageOnlyAuth\(target\) \|\| /.test(jd0));

// The safety net that replaced the prediction: read Google's own refusal, then offer the browser.
const wsrc = fs.readFileSync(path.join(__dirname, '../utils/webviewAuth.ts'), 'utf8');
ok('a watcher exists for Google sign-in pages', /export const GOOGLE_AUTH_WATCH_JS/.test(wsrc));
ok('it is scoped to accounts.google.com', /accounts\\\\\.google\\\\\.com\$\/i\.test\(String\(location\.hostname/.test(wsrc));
ok('it matches the words Google actually uses',
  /disallowed_useragent\|browser or app may not be secure/.test(wsrc));
// ⚠️ REVERSED FROM b190, WHICH ASSERTED THE OPPOSITE AND SHIPPED THE BUG. "The page looks empty"
// raised a modal, and it fired from a hidden Google One Tap IFRAME during ordinary browsing —
// telling the user their sign-in was refused when none had been attempted.
ok('an empty page no longer counts as a refusal', !/reason:'blank'/.test(wsrc));
ok('the watcher never runs outside the top frame', /window\.top !== window\.self\) return;/.test(wsrc));
ok('"Couldn\'t sign you in" is gone — Google shows it for a wrong password too',
  !/couldn\.t sign you in/i.test(wsrc));
ok('the empty-page signal survives as telemetry only',
  /GOOGLE_AUTH_SEEN/.test(wsrc) && /TELEMETRY ONLY/.test(wsrc));
ok('the watcher is injected into the apply web view', /GOOGLE_AUTH_WATCH_JS/.test(jd0));
ok('the browser is offered only when Google has actually said no',
  /msg\.type === 'GOOGLE_AUTH_BLOCKED'[\s\S]{0,420}offerBrowserSignIn\(said\)/.test(jd0));
ok('and the alert quotes Google, so a false positive is recognisable on sight',
  /Google says: /.test(jd0) && /Google says: /.test(bf0));
ok('telemetry records what the sign-in page looked like', /google_auth_seen/.test(jd0));
ok('and only once per apply session', /gAuthAlertedRef\.current = false;/.test(jd0)
  && /!gAuthAlertedRef\.current/.test(jd0));
ok('the user is offered email OR their browser, not a dead end',
  /Use email instead/.test(jd0) && /Open in browser/.test(jd0));

console.log('── nothing offers the user a way OUT of a half-filled application ──');
// "Open in Google?", "Continue in Safari", the long-press sheet — every one of them abandons the
// form, the attached resume and the cover letter, none of which exist outside this WebView.
ok('the stay-in-app interceptor finally ships in the apply view (it never did)',
  /STAY_IN_APP_JS/.test(jd0));
ok('and at document-START, where it can beat the page own handlers',
  /injectedJavaScriptBeforeContentLoaded=\{[^}]*STAY_IN_APP_JS/.test(jd0));
// The passkey guard has to come even earlier: a site feature-detects passkeys in its own first
// scripts, and a guard that lands after that has already let the button onto the screen.
ok('the passkey guard runs before the stay-in-app hook',
  /injectedJavaScriptBeforeContentLoaded=\{FRAME_GUARD_JS \+ '\\n' \+ PASSKEY_GUARD_JS/.test(jd0));
ok('exit-ramp banners are stripped', /export const NO_EXIT_JS/.test(wsrc) && /NO_EXIT_JS/.test(jd0));
ok('the iOS smart app banner meta tag is removed', /apple-itunes-app/.test(wsrc));
ok('app-store and app-scheme links are defused', /itms-apps\|itms\|market\|intent/.test(wsrc));
ok('a banner is hidden only when it BOTH reads and links like an exit ramp',
  /if \(host && EXIT_TX\.test\(tx\)\)/.test(wsrc));
ok('the sweep is bounded so a hostile page cannot loop us', /if \(runs\+\+ > 40\) return;/.test(wsrc));
ok('long-press link preview is off in the apply view', /allowsLinkPreview=\{false\}/.test(jd0));
ok('data detectors are off', /dataDetectorTypes="none"/.test(jd0));
ok('Look Up / Share / Translate are suppressed in the selection menu',
  /suppressMenuItems=\{\['lookup', 'share', 'translate'\]\}/.test(jd0));
ok('Browse & Fetch gets the same treatment', /NO_EXIT_JS/.test(bf0) && /allowsLinkPreview=\{false\}/.test(bf0)
  && /suppressMenuItems=\{\['lookup', 'share', 'translate'\]\}/.test(bf0));

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
// b187: the flag moved INSIDE the settled block, so the same check can also END a site-driven
// flow quietly. The requirement is unchanged: no navigation without the flag.
ok('the auto-return trigger requires the flag',
  /if \(autoReturnRef\.current && !backHere\) returnFromAuth\(1200\);/.test(jd3));
ok('the redirect-arming path applies the same rule',
  /autoReturnRef\.current = new URL\(nav\.url\)\.origin !== new URL\(preAuthUrlRef\.current\)\.origin/.test(jd3));
// b187: the banner became an ESCAPE HATCH — it shows in both modes, because a site-driven flow
// that stalls (Indeed self-closing over a missing opener) leaves the user parked with no other
// way back to their form.
// (b189 inserted the Glassdoor seed between the banner and the navigation.)
ok('the banner shows during every flow as the escape hatch',
  /setAuthBanner\(true\);[\s\S]{0,1400}injectJavaScript\(seed \+ `window\.location\.href/.test(jd3));

console.log('── a stray window.close() must not end a login the user is still doing ──');
// Reported on 186: "Indeed shows for a few seconds, then it comes back, still logged out."
// Our close hook is injected into EVERY page; Indeed's popup-only login, finding no opener,
// bails by closing — a real browser ignores that, we treated it as "sign-in finished".
// b188 supersedes 187's blanket rule: the URL is consulted FIRST (a refusal and a success both
// close the page), and the ownership rule remains only as the fallback for everything else.
ok('outside a callback, AUTH_DONE still respects flow ownership',
  /if \(autoReturnRef\.current\) returnFromAuth\(600\);\s*\n\s*return;\s*\n\s*\}/.test(jd3));
ok('the unloadable-scheme guard cancels but only navigates when managed',
  /preAuthUrlRef\.current && autoReturnRef\.current\) returnFromAuth\(0\);/.test(jd3));
ok('the managed/site-driven decision is made ONCE per flow',
  /const flowActive = !!preAuthUrlRef\.current && \(Date\.now\(\) - authAtRef\.current < 5 \* 60_000\);/.test(jd3));
ok('mid-flow window.open hops cannot re-arm the auto-return', /if \(!flowActive\) \{/.test(jd3));
// b189 folded the quiet end into a shared clear(), which the 5-minute ceiling also uses.
ok('a site-driven flow ENDS quietly when the site lands the user back',
  /const clear = \(\) => \{[\s\S]{0,220}?setAuthBanner\(false\);/.test(jd3) && /else clear\(\);/.test(jd3));
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

console.log('── the opener gate: the actual cause of the Glassdoor stall ──');
// Deminified from Glassdoor's own chunk, the bootstrap page's mount effect is:
//   if (window.opener?.origin === window.location.origin || …) { …replace(/auth/oauth2/authorization/indeed…) }
//   else throw Error("Origin mismatch error"); } catch (e) { window.close(); }
// An embedded WebView can never have a real opener, so it throws and closes — a no-op in a top
// frame — and the page stalls on "Redirecting to Indeed for one login" WITHOUT EVER REACHING
// indeed.com. Builds 185-187 all fixed our navigation; the flow died before any navigation.
const wa = fs.readFileSync(path.join(__dirname, '../utils/webviewAuth.ts'), 'utf8');
const shimRaw = wa.match(/export const OPENER_SHIM_JS = (`[\s\S]*?`);/)[1];
const shim = eval(shimRaw);                     // the REAL injected script, escapes interpreted
ok('the shim parses as JavaScript', (() => { try { new Function(shim.replace(/true;\s*$/, '')); return true; } catch { return false; } })());
ok('it presents origin === location.origin', /get origin\(\)\{ return window\.location\.origin; \}/.test(shim));
ok('it defines window.opener', /Object\.defineProperty\(window,'opener'/.test(shim));
ok('it defers to a REAL opener when one exists', /if \(window\.opener\) \{ window\.__cvfOpenerShim = 'skip:real-opener'; return; \}/.test(shim));

// ⚠️ Scope. A non-null window.opener changes noopener/popup semantics, so this must never fire on
// an ordinary employer portal. Both guards are pulled out of the interpreted script and exercised.
const hostRe = new RegExp(shim.match(/if \(!(\/.*?\/i)\.test\(location\.hostname\)\)/)[1].slice(1, -2), 'i');
const pathRe = new RegExp(shim.match(/if \(!(\/.*?\/i)\.test\(location\.pathname\)\)/)[1].slice(1, -2), 'i');
[['www.glassdoor.com', true], ['glassdoor.co.in', true], ['secure.indeed.com', true],
 ['www.google.com', false], ['boards.greenhouse.io', false], ['jobs.lever.co', false],
 ['myworkdayjobs.com', false]].forEach(([h, want]) =>
  ok(`host scope: ${h}`, hostRe.test(h) === want, String(hostRe.test(h))));
[['/auth/login/oauth2/code/indeed', true], ['/auth/oauth2/authorization/indeed', true],
 ['/member/profile/login', false], ['/partner/jobListing.htm', false]].forEach(([pa, want]) =>
  ok(`path scope: ${pa}`, pathRe.test(pa) === want, String(pathRe.test(pa))));

const jd4 = fs.readFileSync(path.join(__dirname, '../app/(ai-hub)/job-detail.tsx'), 'utf8');
// ⚠️ Document-END is too late: the gate runs in the page's mount effect.
ok('injected at document START', /injectedJavaScriptBeforeContentLoaded=\{[^}]*OPENER_SHIM_JS\}/.test(jd4));
// ⚠️ MAIN FRAME ONLY. The gate runs in the main frame; injecting a forged opener into every
// sub-frame is blast radius for no benefit.
ok('NOT injected into sub-frames', !/injectedJavaScriptBeforeContentLoadedForMainFrameOnly/.test(jd4));
// ⚠️ THIS ASSERTION USED TO DEMAND THE OPPOSITE, and it was wrong. A reviewer mis-deminified the
// return branch as `if (codeChallenge) …` and concluded the redirect path was unreachable, so we
// deleted the seed. The variable tested is actually the RAW sessionStorage string:
//     let t = sessionStorage.getItem("indeed-oauth-params");
//     …then(n => t ? location.replace(originationURL || "/") : (chan.postMessage(n), close()));
// The presence of that key is exactly what selects redirect mode over popup mode.
ok('the shim seeds indeed-oauth-params (selects redirect mode)',
  /sessionStorage\.setItem\('indeed-oauth-params'/.test(shim));
ok('it seeds auth_provider google (the opener-free route through the gate)',
  /auth_provider: 'google'/.test(shim));
ok('it only seeds when absent, so a better value wins',
  /if \(!sessionStorage\.getItem\('indeed-oauth-params'\)\)/.test(shim));
ok('the shim reports whether it installed or why it skipped',
  /__cvfOpenerShim = 'installed'/.test(shim) && (shim.match(/__cvfOpenerShim = 'skip:/g) || []).length === 3);

console.log('── the deterministic route: seed BEFORE navigating ──');
// The shim has to win a document-start race; this does not — it runs on the page we are already
// on. sessionStorage is per-origin, so the value is waiting when the bootstrap page loads.
const seedFn = eval('(' + wa.match(/export const GD_SEED_JS = (\(back: string\) => `[\s\S]*?`);/)[1].replace(': string', '') + ')');
const seeded = seedFn('https://www.glassdoor.com/job-listing/abc.htm');
ok('GD_SEED_JS parses', (() => { try { new Function(seeded.replace(/true;\s*$/, '')); return true; } catch { return false; } })());
ok('it writes auth_provider google', /auth_provider = 'google'/.test(seeded));
ok('it carries the return URL', seeded.includes('job-listing/abc.htm'));
ok('it MERGES rather than clobbers an existing entry', /if \(!cur\.auth_provider\)/.test(seeded));
ok('it is scoped to glassdoor origins', /glassdoor/.test(seeded) && !/indeed\.com/.test(seeded));
ok('an empty return URL is not written', seedFn('').includes("var back = \"\""));
ok('beginAuthFlow seeds before it navigates',
  /seed = GD_SEED_JS\([\s\S]{0,120}\n[\s\S]{0,200}injectJavaScript\(seed \+ `window\.location\.href/.test(jd4));
ok('and never seeds across a different TLD', /t\.origin === c\.origin/.test(jd4));

console.log('── stop shipping blind ──');
const probe = eval(wa.match(/export const GD_PROBE_JS = (`[\s\S]*?`);/)[1]);
ok('GD_PROBE_JS parses', (() => { try { new Function(probe.replace(/true;\s*$/, '')); return true; } catch { return false; } })());
ok('it reports Glassdoor\'s OWN error notice', /indeed-oauth-error-notice/.test(probe));
ok('it reports whether the shim installed and the seed landed', /__cvfOpenerShim/.test(probe) && /__cvfGdSeed/.test(probe));
ok('it reports whether an email/password form is on screen', /input\[name="__email"\]/.test(probe));
ok('it snapshots more than once', /\[1500, 5000, 11000\]/.test(probe));
ok('the probe is NEVER treated as completion', !/GD_PROBE'\) \{[\s\S]{0,400}returnFromAuth/.test(jd4));
ok('a frozen spinner now surfaces an alert instead of nothing', /bootStuck/.test(jd4));
ok('at most one alert per apply session', /gdAlertedRef/.test(jd4));

console.log('── landing where we asked to be returned IS success ──');
// Glassdoor's originationURL for a flow starting on /member/profile/login IS that login page, and
// isAuthUrl() calls it auth — so a "!isAuthUrl" test alone could never see this flow finish.
ok('finishing on the remembered URL counts even if it looks like auth', /const backHere = bare\(nav\.url\) === bare\(preAuthUrlRef\.current\)/.test(jd4));
ok('success is (backHere || !isAuthUrl)', /if \(sameSite && settled && \(backHere \|\| !isAuthUrl\(nav\.url\)\)\)/.test(jd4));
ok('a never-resolving flow cannot pin the banner forever', /Date\.now\(\) - authAtRef\.current > 5 \* 60_000/.test(jd4));
ok('OPENER_MSG only counts with ?code=', /OPENER_MSG'\) \{[\s\S]{0,200}\[\?&\]code=/.test(jd4));

const bf = fs.readFileSync(path.join(__dirname, '../components/BrowseFetch.tsx'), 'utf8');
ok('Browse & Fetch gets the shim too (it can land on Glassdoor)', /STAY_IN_APP_JS \+ '\\n' \+ NO_EXIT_JS \+ '\\n' \+ OPENER_SHIM_JS/.test(bf));
ok('Android gets a stall watchdog (its pre-script hook is best-effort)', /openerRetryRef/.test(jd4) && /location\.reload\(\); true;/.test(jd4));
ok('the watchdog retries a given stuck URL only once', /openerRetryRef\.current !== nav\.url/.test(jd4));

console.log('── a self-close means two opposite things; only the URL separates them ──');
ok('the close hook now reports its URL', /reason:'self-close', href: String\(location\.href\)/.test(wa));
ok('close on a callback WITHOUT ?code= is a refusal — do not navigate',
  /if \(onCallback && !hasCode\) \{[\s\S]{0,140}return;/.test(jd4));
ok('close on a callback WITH ?code= is success — return (187 broke exactly this)',
  /if \(onCallback && hasCode\) \{ returnFromAuth\(600\); return; \}/.test(jd4));
ok('a write to the forged opener counts as completion', /OPENER_MSG/.test(jd4));

console.log('── the search sheet must stop moving under the clock ──');
const sl = fs.readFileSync(path.join(__dirname, '../components/JobSearchLauncher.tsx'), 'utf8');
ok('the sheet is bounded by the real top inset', /useSafeAreaInsets/.test(sl) && /winH - insets\.top/.test(sl));
ok('the sheet has a maxHeight applied', /maxHeight: sheetMaxH/.test(sl));
ok('the suggestion list is capped to a row count', /SUG_MAX_ROWS/.test(sl) && /Math\.min\(items\.length, SUG_MAX_ROWS\)/.test(sl));
ok('the list sits in a FIXED slot so item count cannot resize the sheet', /height: SUG_MAX_H \+ 6/.test(sl));
ok('overflow past the cap scrolls instead of growing', /nestedScrollEnabled/.test(sl));

console.log(`\nauth return + search sheet: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
