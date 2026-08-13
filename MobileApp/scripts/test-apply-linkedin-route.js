// Guards the fix for "the apply web view opened with NO robot / Auto Fill / cover-letter upload /
// translate" on a saved LinkedIn job (user_saved_jobs id=67).
//
// Two things are asserted, both against the REAL source of app/(ai-hub)/job-detail.tsx — never a
// copy — because the regression is invisible to tsc and only shows up on a device:
//   1. openApplyWebView() must REACH setApplyWebUrl() for a LinkedIn URL. Every apply control
//      (JobToolsDock / Auto Fill / résumé+cover attach / Translate) lives inside
//      <Modal visible={!!applyWebUrl}>, so an early return into WebBrowser.openBrowserAsync
//      hands the whole session to SFSafariViewController and deletes all of them at once.
//   2. The apply WebView's onShouldStartLoadWithRequest — extracted verbatim and executed here —
//      must cancel-and-replay LinkedIn navigations on iOS (so the OS cannot deep-link them into the
//      LinkedIn app) without looping, without slowing any other host, and without breaking mailto.
//
//   node MobileApp/scripts/test-apply-linkedin-route.js
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'app', '(ai-hub)', 'job-detail.tsx');
const SRC = fs.readFileSync(FILE, 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

// Balanced-brace slice starting at the first `{` at/after `from`.
function block(from) {
  const start = SRC.indexOf('{', from);
  let depth = 0;
  for (let i = start; i < SRC.length; i++) {
    const c = SRC[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced block at ' + from);
}

// ── 1. openApplyWebView still opens the IN-APP modal for LinkedIn ───────────────────────────────
console.log('\nopenApplyWebView');
const openIdx = SRC.indexOf('const openApplyWebView = (url?: string) =>');
ok('openApplyWebView exists', openIdx > 0);
const openBody = block(openIdx);
ok('no LinkedIn early return into the OS browser (this is THE regression)',
  !/isLinkedInJobUrl\(u\)\)[\s\S]{0,200}?openBrowserAsync/.test(openBody));
ok('it reaches setApplyWebUrl(u) — the one state that mounts the apply modal',
  /setApplyWebUrl\(u\)/.test(openBody));
ok('the only early return left is the empty-url guard',
  (openBody.replace(/\/\/.*$/gm, '').match(/\breturn\b/g) || []).length === 1);
ok('the escape hatch survives as a user CHOICE (dock → Open in browser)',
  /const openCurrentInBrowser[\s\S]{0,400}openBrowserAsync/.test(SRC));

// The chrome the owner reported missing is all gated on applyWebUrl — prove the gate is one boolean.
console.log('\napply-modal chrome');
ok('modal gate is visible={!!applyWebUrl}', /<Modal\s+visible=\{!!applyWebUrl\}/.test(SRC));
ok('JobToolsDock (robot / Auto Fill / Upload / My details) is inside it', /<JobToolsDock/.test(SRC));
ok('translate button is inside it', /onPress=\{toggleTranslate\}/.test(SRC));

// ── 2. Run the REAL navigation guard ────────────────────────────────────────────────────────────
console.log('\nonShouldStartLoadWithRequest (verbatim from the apply WebView)');
const handlerIdx = SRC.indexOf('onShouldStartLoadWithRequest={(req: any) => {');
ok('handler found', handlerIdx > 0);
const handlerBody = block(SRC.indexOf('=> {', handlerIdx) + 3);   // body of the arrow function
// The body is TSX; drop the only thing node cannot parse — inline param type annotations.
const js = (src) => src.replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$<>\[\]| ]*\s*\)/g, '($1)');

// The host-claim test, extracted verbatim rather than re-typed.
const reSrc = SRC.match(/const APP_CLAIMED_HOST_RE = (\/.*\/i);/);
ok('APP_CLAIMED_HOST_RE is defined', !!reSrc);
const APP_CLAIMED_HOST_RE = eval(reSrc[1]);
const isAppClaimedUrl = (u) => { try { return APP_CLAIMED_HOST_RE.test(new URL(u).hostname); } catch { return false; } };

const calls = [];
const env = {
  Platform: { OS: 'ios' },
  isAppClaimedUrl,
  selfNavRef: { current: '' },
  currentUrlRef: { current: '' },
  applyUriRef: { current: '' },
  setApplyLoading: () => {},
  setApplyWebUrl: (u) => calls.push(['setApplyWebUrl', u]),
  handleMailtoApply: (u) => calls.push(['mailto', u]),
  Linking: { openURL: (u) => { calls.push(['openURL', u]); return { catch: () => {} }; } },
};
const handler = new Function(...Object.keys(env), 'return function (req) ' + js(handlerBody) + ';')(...Object.values(env));

const LI = 'https://www.linkedin.com/jobs/view/4449419113/?trackingId=abc%3D';   // saved job 67
const ATS = 'https://boards.greenhouse.io/acme/jobs/123';

// a. The first load IS the LinkedIn URL (openApplyWebView primed currentUrlRef with it) → allow,
//    or the WebView would cancel its own opening navigation forever and show a blank page.
env.currentUrlRef.current = LI; env.selfNavRef.current = ''; env.applyUriRef.current = LI; calls.length = 0;
ok('initial LinkedIn load is allowed (no self-cancel loop)', handler({ url: LI }) === true, calls);

// b. Cross-host hop INTO LinkedIn is cancelled and re-issued natively.
env.currentUrlRef.current = ATS; env.selfNavRef.current = ''; env.applyUriRef.current = ATS; calls.length = 0;
const hop = handler({ url: LI });
ok('cross-host hop into LinkedIn is cancelled', hop === false);
ok('...and replayed as a native load of the same URL', calls.some(([k, v]) => k === 'setApplyWebUrl' && v === LI), calls);
ok('...and it is NOT handed to Linking.openURL (that would open the LinkedIn app)',
  !calls.some(([k]) => k === 'openURL'), calls);

// c. Our own replay must be let through, exactly once.
calls.length = 0;
ok('the replayed navigation is allowed', handler({ url: LI }) === true);
ok('...and the one-shot token is consumed', env.selfNavRef.current === '');

// d. Navigation WITHIN LinkedIn is not cancelled (iOS does not universal-link same-domain hops).
env.currentUrlRef.current = LI; env.selfNavRef.current = '';
ok('linkedin → linkedin is left alone', handler({ url: 'https://www.linkedin.com/jobs/view/999/' }) === true);

// e. LinkedIn's own shortener is covered; a lookalike host is not.
env.currentUrlRef.current = ATS; env.selfNavRef.current = ''; calls.length = 0;
ok('lnkd.in is claimed too', handler({ url: 'https://lnkd.in/abc123' }) === false);
ok('notlinkedin.com is NOT treated as LinkedIn', isAppClaimedUrl('https://notlinkedin.com/jobs/1') === false);

// f0. Returning to the URL the WebView was OPENED with: setting the same state value would load
//     nothing at all (a dead tap). The replay must still be a real, distinguishable request.
env.currentUrlRef.current = ATS; env.selfNavRef.current = ''; env.applyUriRef.current = LI; calls.length = 0;
ok('hop back to the session URL is cancelled', handler({ url: LI }) === false);
const replayed = (calls.find(([k]) => k === 'setApplyWebUrl') || [])[1];
ok('...and re-issued as a CHANGED source uri (so WKWebView actually loads it)',
  !!replayed && replayed !== LI && replayed.replace(/#.*$/, '') === LI, replayed);
ok('...and that replay is then allowed through, fragment or not', handler({ url: LI }) === true);

// f1. Back/forward is a history load, not a link activation — never cancel it (dead Back button).
env.currentUrlRef.current = ATS; env.selfNavRef.current = ''; env.applyUriRef.current = LI; calls.length = 0;
ok('Back to the LinkedIn page is left alone', handler({ url: LI, navigationType: 'backforward' }) === true, calls);

// f. Everything else stays fast — no cancelled navigation for ordinary sites.
env.selfNavRef.current = ''; calls.length = 0;
ok('an ordinary cross-host hop is untouched', handler({ url: 'https://jobs.lever.co/acme/1' }) === true, calls);

// g. Sub-frames and Android take the plain path.
ok('sub-frame LinkedIn request is not cancelled', handler({ url: LI, isTopFrame: false }) === true);
env.Platform.OS = 'android';
const androidHandler = new Function(...Object.keys(env), 'return function (req) ' + js(handlerBody) + ';')(...Object.values(env));
env.currentUrlRef.current = ATS; env.selfNavRef.current = '';
ok('Android is unaffected (no universal links)', androidHandler({ url: LI }) === true);
env.Platform.OS = 'ios';

// h. The pre-existing scheme handling must survive the edit.
calls.length = 0;
ok('mailto: still routes to the in-app compose flow',
  handler({ url: 'mailto:jobs@acme.com?subject=Application' }) === false && calls[0] && calls[0][0] === 'mailto', calls);
calls.length = 0;
ok('tel: still hands off to the OS', handler({ url: 'tel:+41791234567' }) === false && calls[0][0] === 'openURL', calls);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
