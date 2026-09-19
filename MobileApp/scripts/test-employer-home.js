// The employer-focused Home — contract tests over the screen, its wiring and its server side.
// Source-level (same style as test-auth-return.js) plus a real render of the gradient sampler.
//   node MobileApp/scripts/test-employer-home.js
'use strict';
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const R = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

const home = R('../components/employer-home/EmployerHome.tsx');
const mesh = R('../components/employer-home/MeshStage.tsx');
const carousel = R('../components/employer-home/PaperCarousel.tsx');
const theme = R('../components/employer-home/theme.ts');
const boundary = R('../components/employer-home/HomeBoundary.tsx');
const zoomSrc = R('../components/employer-home/PaperZoom.tsx');
const sheetSrc = R('../components/employer-home/AddEmployerSheet.tsx');
const histSrc  = R('../components/employer-home/DownloadHistory.tsx');
const svc = R('../services/employerHomeService.ts');
const hs = R('../components/HomeScreen.js');
const ctl = R('../../server/controllers/resumeBuilderController.js');
const routes = R('../../server/routes/resumeBuilder.js');

// Assertions run against COMMENT-STRIPPED source wherever the thing being tested is also NAMED in
// a comment. Matching your own explanation proves nothing — that mistake has been made here more
// than once (Dimensions, router.back(), and the 1.99 the design deliberately does NOT copy).
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const homeC = strip(home), svcC = strip(svc), hsC = strip(hs), carC = strip(carousel), ctlC = strip(ctl);
const histC = strip(histSrc);
const meshC = strip(mesh);
// The per-employer tailoring work: the free employer-name search, the document cache that stops a
// switch-back from costing a second AI call, and the drawn page that replaces a blank card.
const discSrc = R('../../server/controllers/discoverController.js');
const discRoutes = R('../../server/routes/discoverRoutes.js');
const docsSrc = R('../../server/services/employerDocs.js');
const dbInit = R('../../db-init.js');
const skelSrc = R('../components/employer-home/PaperSkeleton.tsx');
const aiHubCtl = R('../../server/controllers/aiHubController.js');
const discC = strip(discSrc), docsC = strip(docsSrc), skelC = strip(skelSrc), aiHubC = strip(aiHubCtl);
const lookupSrc = R('../../server/services/companyLookup.js');
const resolverSrc = R('../../server/services/applyUrlResolver.js');
const lookupC = strip(lookupSrc);
// The Home add-and-build flow: free tracking, a gated build, the overlay, and the money rules around it.
const addSvcSrc = R('../services/homeAddEmployer.ts');
const overlaySrc = R('../components/employer-home/BuildingOverlay.tsx');
const jobSvcSrc = R('../../server/services/jobService.js');
const costsSrc = R('../../server/services/eventCosts.js');
const asyncJobSrc = R('../../server/middleware/asyncJob.js');
const addSvcC = strip(addSvcSrc), overlayC = strip(overlaySrc), jobSvcC = strip(jobSvcSrc), costsC = strip(costsSrc);
const fnBody = (src, name) => (src.match(new RegExp('async function ' + name + '\\([\\s\\S]*?\\n\\}')) || [''])[0];
/**
 * One function's body, whatever shape it is declared in — `function f(`, `const f = (…) => {`,
 * `const f = useCallback((…) => {`, `const f = async (…) => {`. Brace-matched from the body's own '{',
 * so a helper that gains a wrapper (useCallback, useStableFn) does not quietly empty its assertions.
 * Returns '' when the name is not there — an assertion against '' fails, which is the point.
 */
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
// Pull a JS array literal of strings out of a source file, so two copies of a list can be compared.
// ⚠️ Comments are stripped FIRST: both lists carry explanatory comments with apostrophes in them
// ("the employer's site"), and a naive '…' scan reads those as hosts.
const listOf = (src, name) => {
  const m = src.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\n\\];'));
  if (!m) return null;
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1].toLowerCase());
};
const studioSrc = R('../components/onboarding/SignatureStudio.tsx');
const countrySheetSrc = R('../components/onboarding/CountrySheet.tsx');
const countrySheetC = strip(countrySheetSrc);
const countriesSrc = R('../constants/countries.ts');
const studioC = strip(studioSrc);
// The per-employer documents round (2026-09-11): the chip moved into its own file, the build
// orchestration into a hook, and each chip's saved document is read from the server.
const chipSrc = R('../components/employer-home/EmployerChip.tsx');
const kHookSrc = R('../components/employer-home/useHomeBuilds.ts');
const docHookSrc = R('../components/employer-home/useTargetDoc.ts');
const docSvcSrc = R('../services/employerDocs.ts');
const buildsSrc = R('../services/homeBuilds.ts');
const chipC = strip(chipSrc), kHookC = strip(kHookSrc), docHookC = strip(docHookSrc), docSvcC = strip(docSvcSrc), buildsC = strip(buildsSrc);
const FILES = {
  'EmployerHome.tsx': home, 'MeshStage.tsx': mesh, 'PaperCarousel.tsx': carousel,
  'theme.ts': theme, 'HomeBoundary.tsx': boundary, 'employerHomeService.ts': svc, 'HomeScreen.js': hs,
  'PaperZoom.tsx': zoomSrc, 'AddEmployerSheet.tsx': sheetSrc, 'DownloadHistory.tsx': histSrc,
  'SignatureStudio.tsx': studioSrc, 'CountrySheet.tsx': countrySheetSrc, 'countries.ts': countriesSrc,
  'onboarding/index.tsx': R('../app/(onboarding)/index.tsx'),
  'EmployerChip.tsx': chipSrc, 'useHomeBuilds.ts': kHookSrc, 'useTargetDoc.ts': docHookSrc,
  'employerDocs.ts': docSvcSrc, 'homeBuilds.ts': buildsSrc, 'BuildingOverlay.tsx': overlaySrc,
  // The letter editor a letter page's Customize opens (2026-09-13).
  '(cover-letter)/edit.tsx': R('../app/(cover-letter)/edit.tsx'),
  // The question before any spend, and the hint that points at the Tailor button (2026-09-14).
  'GenerateConfirmSheet.tsx': R('../components/employer-home/GenerateConfirmSheet.tsx'),
  'TailorHint.tsx': R('../components/employer-home/TailorHint.tsx'),
  // The saved "Designing for" row (2026-09-19): the row never refills or resets itself.
  'homeRoster.ts': R('../services/homeRoster.ts'),
};

console.log('── every file parses (a JSX slip here white-screens the app) ──');
for (const [name, src] of Object.entries(FILES)) {
  let good = true;
  try { parser.parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] }); } catch (e) { good = false; console.log('     ' + name + ': ' + String(e.message).split('\n')[0]); }
  ok(name + ' parses', good);
}

console.log('── the CLAUDE.md rules this feature must obey ──');
ok('App.js is NOT modified by this feature', !fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8').includes('EmployerHome'));
for (const [name, src] of Object.entries(FILES)) {
  if (name === 'HomeScreen.js') continue;   // pre-existing file, has its own header
  ok(name + ' carries the mandatory header', /^\/\/ AI Hub — new feature\. Safe to delete/.test(src));
  ok(name + ' uses StyleSheet.create (no inline style objects as the rule)', !/style=\{\{\s*flex: 1,\s*backgroundColor/.test(src));
}
ok('no new dependency is imported', !/from '(react-native-svg|@react-native-masked-view|styled-components|nativewind)/.test(home + mesh + carousel + boundary));
ok('icons come from Ionicons only', !/MaterialIcons|FontAwesome|Feather/.test(home + mesh + carousel + boundary));

console.log('── the animation driver rule (b126-128 was a fatal crash) ──');
// One driver per tree. These three files are a self-contained NATIVE tree: transform/opacity
// only, no JS-driven Animated.Value anywhere in them.
for (const [name, src] of [['EmployerHome', home], ['MeshStage', mesh], ['PaperCarousel', carousel]]) {
  ok(name + ' never mixes drivers (no useNativeDriver:false)', !/useNativeDriver:\s*false/.test(src));
}
ok('the driver choice is explained, not silent', /ANIMATION DRIVER RULE/.test(home) && /ANIMATION DRIVER RULE/.test(mesh) && /ANIMATION DRIVER RULE/.test(carousel));
ok('the carousel drives itself from scroll position', /Animated\.event\(\[\{ nativeEvent: \{ contentOffset: \{ x: scrollX \}/.test(carousel));
ok('…and RN has no translateZ, which is written down', /NO translateZ/.test(carousel));

console.log('── Home is replaced; the dashboard is one tap away; App.js untouched ──');
ok('HomeScreen renders EmployerHome by default', /\{!showDashboard \? \(/.test(hs));
ok('the dashboard body is gated, not deleted', /\) : \(\n      <ScrollView\n        ref=\{mainScrollRef\}/.test(hs));
ok('the toggle is LOCAL state, never a new App.js screen key',
  /const \[showDashboard, _setShowDashboard\] = useState\(_showDashboardCache\);/.test(hs)
  && /let _showDashboardCache/.test(hs)          // module-scoped IN THIS FILE, so it survives a remount
  && !/setScreen\('employerHome'\)/.test(hs)     // …but still never an App.js screen key
  && !/'employerHome'/.test(fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')));
ok('…and the reason is recorded', /unconditional `return <ReviewScreen\/>`/.test(hs));
ok('a Dashboard menu item exists with a unique title', /title: 'Dashboard',/.test(hs) && (hs.match(/title: 'Dashboard',/g) || []).length === 1);
ok('the Home tab pill is now pressable — the way BACK from the dashboard',
  /onPress=\{\(\) => setShowDashboard\(false\)\}[\s\S]{0,300}activeTab/.test(hs));
ok('the new Home is wrapped in an error boundary', /<HomeBoundary onFallback=\{\(\) => setShowDashboard\(true\)\}>/.test(hs));
ok('the boundary falls back to the dashboard, not a dead screen', /getDerivedStateFromError/.test(boundary) && /Open Dashboard/.test(boundary));
ok('…and reports the crash', /home_employer_crash/.test(boundary));

console.log('── the design, as drawn in the mockup ──');
ok('dark stage #070A18, full-bleed — no radius and no bottom edge, because it IS the page',
  /stage: '#070A18'/.test(theme) && !/borderBottomLeftRadius/.test(mesh) && /focus\?: number/.test(meshC));
// ⚠️ b202 drew these as circular Views holding LinearGradients — with no overflow:hidden, each
// painted a hard-edged SQUARE across the hero. They are full-bleed washes now: every layer
// covers the whole stage, so there is no edge anywhere to see.
ok('three drifting colour washes (blue, violet, teal)', (mesh.match(/<Wash/g) || []).length === 3);
// ⚠️ IN POINTS, NOT PER CENT. -25% on a page-tall stage is a 500pt overhang, and every `y`
// fraction in a wash would then mean something other than the page fraction it is named after.
ok('every wash is oversized so its own bounds never enter frame, by a fixed 40pt',
  /left: -40, right: -40, top: -40, bottom: -40/.test(meshC));
ok('the stage clips to its radius', /overflow: 'hidden',\s+\/\/ ⚠️ load-bearing/.test(mesh));
ok('the rectangle bug is written down where it happened', /painted as a hard-edged SQUARE/.test(mesh));
ok('the faint grid is there', /i \* 30/.test(mesh));
ok('the live pill + pulsing dot', /TAILORED PER EMPLOYER · LIVE/.test(home) && /function LiveDot/.test(home));
ok('the headline splits into sans + serif-italic accent', /h1Accent/.test(home) && /fontStyle: 'italic'/.test(home));
ok('there is NO download button on Home — the actions live in the opened page',
  !/function Shimmer/.test(home) && !/ctaTx:/.test(home) && !/Download for /.test(home));
// ⚠️ RETARGETED: the chip moved into EmployerChip.tsx. The role line now sits in a ternary (a live
// build reports in its place, because the row clips at 48pt), so the leading brace is gone.
ok('a chip identifies a POSTING: company over role, plus the match',
  /chipTileTx/.test(chipSrc) && /chipPctTx/.test(chipSrc) && /chipRole/.test(chipSrc)
  && /!!t\.role && <Text style=\{\[s\.chipRole/.test(chipC));
ok('the carousel shows a "For <employer>" ribbon', /ribbon/.test(carousel) && /For \{ribbon\.short\}/.test(carousel));
ok('dots widen for the active card', /dotOn: \{ width: 20/.test(carousel));
ok('cards keep the A4 ratio the renderer uses', /424 \/ 300/.test(carousel));

console.log('── gradient text without SVG or masked-view (neither is installed) ──');
delete require.cache[require.resolve('@babel/core')];
// Run the real sampler: transpile the TS and execute it.
const ts = require('typescript');
const js = ts.transpileModule(theme.replace(/import \{ Platform \}[^\n]*\n/, 'const Platform = { select: (o) => o.default };\n'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const mod = new module.constructor();
mod._compile(js, '/theme.js');
const { gradientAt, sweepWords } = mod.exports;
ok('the sampler hits the mockup start colour', gradientAt(0).toLowerCase() === '#9dbeff', gradientAt(0));
ok('…the midpoint', gradientAt(0.5).toLowerCase() === '#c4bbff', gradientAt(0.5));
ok('…and the end colour', gradientAt(1).toLowerCase() === '#7af0de', gradientAt(1));
ok('it interpolates between stops', gradientAt(0.25) !== gradientAt(0) && gradientAt(0.25) !== gradientAt(0.5));
ok('out-of-range is clamped, never NaN', /^#[0-9a-f]{6}$/i.test(gradientAt(-5)) && /^#[0-9a-f]{6}$/i.test(gradientAt(9)));
const sw = sweepWords('exclusively for the employer.');
ok('every word gets its own colour along the sweep', sw.length === 4 && new Set(sw.map((w) => w.c)).size === 4, sw);
ok('a one-word phrase does not divide by zero', /^#[0-9a-f]{6}$/i.test(sweepWords('now')[0].c));

console.log('── real data, not a demo list ──');
ok('employer chips come from the user’s OWN jobs', /ai-hub\/dashboard/.test(svc) && /discover\/saved-jobs/.test(svc));
ok('the two stores’ different match fields are both handled', /matchScore/.test(svc) && /c\.match/.test(svc));
ok('…and the disagreement is written down', /disagree on field names/.test(svc));
ok('POSTINGS are deduped across the two stores, on the URL the server calls identity',
  /const seen = new Set\(out\.map\(\(t\) => cleanJobUrl\(t\.applyUrl\)\)/.test(strip(svc)));
ok('…and a chip is keyed on that URL, never on a search-time id',
  /key: 'job_' \+ \(cleanJobUrl\(j\.applyUrl \|\| j\.url\)/.test(strip(svc)));
ok('best match leads', /out\.sort\(\(a, b\) => \(b\.match \?\? -1\) - \(a\.match \?\? -1\)\)/.test(svc));
ok('the carousel shows the user’s REAL rendered resume', /resume-builder\/home-cards/.test(svc));

console.log('── server: the carousel previews are cached, never re-rendered per open ──');
ok('a home-cards route exists', /router\.get \('\/home-cards'/.test(routes));
ok('every card is disk-cached per resume version', /async function cachedThumb/.test(ctl) && /resume_thumb_\$\{userId\}/.test(ctl));
ok('the batch is capped below the chromium crash threshold', /\.slice\(0, 5\)/.test(ctl) && /recycles its browser every 3/.test(ctl));
// ⚠️ RETARGETED, AND THE OLD ORDER WAS THE BUG THIS ASSERTION PINNED IN PLACE. `[pref, ...asked]`
// put the stored pick in front BEFORE the cap, so a five-id hydration wave silently lost its fifth
// id — and the client marks any requested id missing from a response permanently dead, with no
// retry. That card then stayed blank forever, which is exactly what the user reported as "after
// scrolling few resumes it shows blank resume". What is ON SCREEN wins now; `pref` still leads on
// the first load, where `asked` is empty.
ok('the ids the client asked for lead the carousel',
  /const fallback = \['banner'/.test(ctl) && /\[\.\.\.asked, pref/.test(ctl));
ok('…and the response never names a preferred card it did not return',
  /cards\.some\(\(c\) => c\.id === pref\)/.test(ctl));
ok('stale versions are pruned', /async function pruneThumbs/.test(ctl));
ok('the single-thumb endpoint still 404s cleanly when there is no resume',
  /No resume yet\.'/.test(ctl));
ok('…and the client still treats a 404 as the authoritative "none", defensively',
  /meta\.status === 404/.test(strip(svc)) && /return 'none'/.test(strip(svc)));

console.log('── the pricing model is NOT changed by a mockup ──');
// The mockup sells one PDF for €1.99 ("no subscription"). This app shipped subscriptions to both
// stores; the CTA keeps the design and routes to the real gate.
// Comments are commentary — only executable lines can ship a price.
const homeCode = home.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
ok('no €1.99 / one-time-purchase checkout was copied in', !/1\.99|one-time purchase|Pay by card/.test(homeCode));
ok('the conflict is documented where the CTA lives', /SUBSCRIPTION model/.test(home) && /pricing bug/.test(home));
ok('the mockup\u2019s one-off price is still nowhere near this screen', !/1\.99/.test(strip(home)));
ok('paid state is read from the server, not guessed', /fetchSubscriptionStatus/.test(home));

console.log('── it degrades gracefully ──');
ok('no resume → a build-my-resume state, not an empty carousel', /function NoResume/.test(home) && /Build with AI/.test(home));
ok('no targets \u2192 an ADD EMPLOYER prompt', /Add an employer to design your resume around/.test(home));
ok('loading shows chip skeletons', /chipSkeleton/.test(home));
ok('pull-to-refresh is wired', /RefreshControl/.test(home));
// ⚠️ ON the gradient, not under it: as scroll-view padding this was outside the backdrop, and the
// root colour is the near-black the gradient STARTS from — so the foot of the page stepped back to
// dark below the last card.
ok('the tab bar\'s worth of room is a spacer INSIDE the backdrop', /tail: \{ height: 108 \}/.test(homeC));

console.log('── the bugs the first on-screen look caught (b202) ──');
// Every one of these was invisible to a type-check and obvious in a screenshot.
ok('the dashboard top bar does NOT render on the new Home (two headers stacked)',
  /\{showDashboard && \(\n      <View style=\{styles\.topBar\}>/.test(hs));
ok('the mesh has no circular blobs left to paint as squares', !/<Blob/.test(mesh));
ok('each glow stops before the far edge, so they stay three glows and not one flat field',
  (mesh.match(/<Wash /g) || []).length === 3);
ok('the carousel centres AND sizes from a MEASURED width, not module-load Dimensions',
  /onLayout=\{\(e\) => setWidth/.test(carousel) && /cardWidthFor\(width\)/.test(carousel)
  && !/Dimensions/.test(strip(carousel)));   // strip(): the rule is explained in a comment that names it
// ⚠️ RETARGETED, AND THE OLD VERSION WAS THE BUG WRITTEN DOWN. "A sliver, not a grey bar" still
// described a SOLID 6pt block of flat blue spanning the card width, directly above the page
// counter — which on a screen whose whole point is that it has no seams was the most visible line
// left on it ("a clear separation line is visible right above those dots"). A reflection has no
// ends: this one starts and finishes at zero alpha and is inset well inside the paper.
ok('the reflection has no ends and no fill, so it cannot read as a rule',
  /reflect: \{ height: 4, marginTop: 9, marginHorizontal: 76/.test(carousel)
  && !/reflect[\s\S]{0,120}backgroundColor/.test(carousel)
  && /rgba\(79,141,255,0\)', 'rgba\(140,180,255,0\.30\)', 'rgba\(79,141,255,0\)/.test(carousel));
ok('the glare is a gradient, not a hard white block', /transparent', 'rgba\(255,255,255,0\.42\)', 'transparent/.test(carousel));
// ⚠️ RETARGETED, NOT DELETED. The grid these two guarded is gone — it re-showed the carousel's own
// resume pages under a company badge, which is the duplication the user reported. The rules they
// encode (no stretching card, expo-image for data URIs) now belong to the library that replaced it.
ok('library cards cannot stretch', !/flexGrow: 1, backgroundColor: E\.surface/.test(home + histSrc));
ok('library thumbnails use expo-image (RN Image did not paint the data URI)',
  /<ExpoImage\s+source=\{\{ uri: image \}\}/.test(histSrc));
ok('⚠️ the duplicate targets grid is GONE', !/function TargetCard/.test(home) && !/cards\[i % Math\.max/.test(home));
ok('a signed-out preview route exists for looking at this before shipping',
  fs.existsSync(path.join(__dirname, '../app/(dev)/home-preview.tsx')));
ok('…and nothing in the app links to it', !new RegExp('home-preview').test(home + hs));

// ── Round 3: what a 72-agent preflight review found in the build that was about to ship ──
// Every assertion below is a defect that survived adversarial verification. They are checked
// against COMMENT-STRIPPED source: the fixes are documented in prose that repeats the very
// tokens being tested, and an assertion that matches its own explanation proves nothing.

console.log('── a failed request must NEVER read as "you have no resume" (it armed a paid rebuild) ──');
ok('the service can tell a 404 from a failure', /meta\.status === 404/.test(svcC) && /return 'none'/.test(svcC));
ok('getJson reports the status back to its caller', /meta\?: \{ status\?: number \}/.test(svcC) && /if \(meta\) meta\.status = r\.status/.test(svcC));
ok('fetchHomeCards still returns null when it could not find out', /\| 'none' \| null/.test(svcC));
ok('ONLY the server-stated none arms the no-resume lane', /c === 'none'.*setNoResume\(true\)/s.test(homeC));
ok('no other branch may set noResume true', (homeC.match(/setNoResume\(true\)/g) || []).length === 1);
ok('a transient failure keeps whatever was already on screen', /else \{ setLoadFailed\(true\); \}/.test(homeC));
ok('…and offers a retry instead of spinning forever', /loadFailed \? \(/.test(homeC) && /onPress=\{\(\) => load\(true\)\}/.test(homeC));

console.log('── the dark hero must own the status bar (a light band sat above it on every notch) ──');
ok('HomeScreen drops its top safe-area edge for the employer Home', /edges=\{showDashboard \? \['top', 'left', 'right', 'bottom'\] : \['left', 'right', 'bottom'\]\}/.test(hsC));
ok('the PINNED header owns the inset, and never scrolls under the clock',
  /headerWrap: \{ position: 'absolute', top: 0/.test(homeC)
  && /height: headerH, paddingTop: insets\.top/.test(homeC) && /useSafeAreaInsets/.test(homeC));
ok('status-bar glyphs switch to light on the near-black hero', /barStyle=\{showDashboard \? 'dark-content' : 'light-content'\}/.test(hsC));

console.log('── iOS clips a shadow drawn on the same view as overflow:hidden ──');
ok('the paper shadow lives on a wrapper', /paperShadow: \{/.test(carC) && !/overflow: 'hidden'[^}]*shadowColor/.test(carC));
ok('the clipped paper view carries no shadow of its own', !/paper: \{[^}]*shadowColor/s.test(carC));
ok('the opened page keeps the shadow OFF the clipped view (the iOS trap)',
  /page: \{[^}]*shadowColor/s.test(strip(zoomSrc)) && /pageClip: \{[^}]*overflow: 'hidden'/.test(zoomSrc));
ok('the clipped CTA gradient carries no shadow of its own', !/  cta: \{[^}]*shadowColor/s.test(homeC));

console.log('── the CTA label must give way, not push its icon out of the button ──');
ok('every label that can meet a long company name can shrink',
  /chipText: \{ flexShrink: 1 \}/.test(chipC) && /ghostTx: \{[^}]*flexShrink: 1/.test(strip(zoomSrc))
  && /letterBtnTx: \{[^}]*flexShrink: 1/.test(homeC));

console.log('── selection and screen state survive a refresh ──');
ok('the picked employer is pinned by key, not by list position', /pickedKey = useRef<string \| null>\(null\)/.test(homeC));
ok('…and is re-resolved after every load', /t\.findIndex\(\(x\) => x\.key === pickedKey\.current\)/.test(homeC));
ok('…and only after the user actually picks', /pickedKey\.current = targets\[i\]\?\.key/.test(homeC));
ok('the Dashboard survives a HomeScreen remount', /let _showDashboardCache = false/.test(hsC) && /useState\(_showDashboardCache\)/.test(hsC));
ok('…and every setter writes the cache', /_showDashboardCache = !!v/.test(hsC));

console.log('── the thumbnail cache ──');
ok('the key includes the photo version', /':' \+ pver \+ ':' \+ tag \+ ':' \+ tplId/.test(ctlC));
ok('cachedThumb reports the filename it used', (ctlC.match(/file: path\.basename\(file\)/g) || []).length === 2);
ok('…and homeCards never recomputes that key (pruneThumbs would delete every fresh thumb)',
  /files\.push\(c\.file\)/.test(ctlC) && !/files\.push\(`resume_thumb_/.test(ctlC));

// ── Round 4: the reworked Home (pinned header, bigger paper, zoom, add-employer, letters) ──
const gal = R('../app/(resume-builder)/templates.tsx');
const hub = R('../app/(ai-hub)/index.tsx');
const zoomC = strip(zoomSrc), sheetC = strip(sheetSrc), galC = strip(gal), hubC = strip(hub);

console.log('── the header is pinned, and it is OUR mark ──');
ok('the real logo asset is used, tinted to read on the hero',
  /require\('\.\.\/\.\.\/assets\/images\/logo_img\.png'\)/.test(homeC) && /brandLogo: \{[^}]*tintColor: '#fff'/.test(homeC));
ok('the header sits OUTSIDE the scroll view', /<\/Animated\.ScrollView>[\s\S]{0,400}headerWrap/.test(homeC));
ok('its backdrop is transparent at rest, so it cannot read as a second background',
  /scrollY\.interpolate\(\{ inputRange: \[0, 64\], outputRange: \[0, 1\]/.test(homeC));
// ⚠️ Every wash axis runs the whole page now, so each is at full strength from the first pixel —
// the screen went pale blue under the status bar, which is the opposite of the dark head this
// design has always had. This holds the first fifth back to the base colour.
ok('the stage keeps its top band dark and flat for the header to sit on',
  /rgba\(7,10,24,0\.96\)', 'rgba\(7,10,24,0\.55\)', 'rgba\(7,10,24,0\)'/.test(meshC));

console.log('── the whole page is one gradient ──');
// ⚠️ RETARGETED TWICE, AND THE RULE GOT SIMPLER EACH TIME. First the stage outran the viewport by
// 18% (150pt of empty gradient). Then it was sized to its content and melted into a light section
// (a shorter gap, but still a place where one surface stopped and another began, and it read as a
// line). Now there is no second surface at all: one gradient covers the page and the library sits
// on it. There is nothing left to align, because there is only one thing.
ok('the stage is the page, not a hero with something under it', /const stageH = Math\.max\(rootH \|\| 700, headerH \+ pageH\)/.test(homeC));
ok('⚠️ no melt, no light section, no second background anywhere on this screen',
  !/fadeFrom/.test(homeC) && !/MELT/.test(homeC) && !/E\.bg/.test(homeC) && !/E\.bg/.test(histC));

console.log('── compact mode icons, glass employer chips ──');
ok('the full-width tab pair is gone', !/toggleBtnOn/.test(home) && /function ModeSwitch/.test(homeC));
ok('the switch rides the headline row', /<ModeSwitch mode=\{mode\} onChange=\{switchMode\} \/>/.test(homeC) && /headRow: \{/.test(homeC));
ok('selection is glass, never a white pill', /chipOn: \{\s*backgroundColor: 'rgba\(79,141,255,0\.22\)'/.test(chipC) && !/chipOn: \{ backgroundColor: '#fff'/.test(chipC + homeC));

console.log('── tapping a page opens it, and the two actions are the REAL screens ──');
ok('the zoom grows from the tapped rectangle, measured', /measureInWindow/.test(strip(carousel)) && /onOpen\(i, w \? \{ x, y, w, h \}/.test(strip(carousel)));
ok('the transition is transform-only (native driver, one tree)',
  /translateX: lerp\(tx0, 0\)/.test(zoomC) && /scale: lerp\(scale0, 1\)/.test(zoomC) && !/useNativeDriver: false/.test(zoomC));
// ⚠️ RETARGETED 2026-09-19: the push carries `from: 'home'` so the editor's Back returns to Home
// (test-customize-nav.js runs that for real).
ok('Customize opens the SECTION EDITOR (and the builder when it is only a sample)',
  /if \(sample\) armBuilderFor\(target\)/.test(homeC)
  && /nav\(\)\?\.push\?\.\(\{ pathname: '\/\(resume-builder\)\/preview', params: \{ from: 'home' \} \}\)/.test(homeC));
ok('⚠️ Customize NEVER arms the paid auto-build lane',
  !/autoBuild[\s\S]{0,80}home_customize/.test(homeC) && (homeC.match(/autoBuild: true/g) || []).length === 1);
ok('View PDF opens the gallery ON the tapped design',
  /pathname: '\/\(resume-builder\)\/templates'/.test(homeC) && /\.\.\.\(id \? \{ template: id \} : \{\}\)/.test(homeC));
ok('⚠️ …and carries the EMPLOYER, or a download pass has nothing to attach to',
  /\.\.\.\(target\?\.company \? \{ employer: target\.company \} : \{\}\)/.test(homeC));
ok('…and the gallery actually honours both params',
  /useLocalSearchParams<\{ template\?: string; employer\?: string \}>/.test(galC) && /landOn\.current = fi/.test(galC));
ok('…including scrolling its pager there', /scrollRef\.current\?\.scrollTo\(\{ x: idx \* WIN/.test(galC));

console.log('── the whole catalogue, without a render stampede ──');
ok('slots come from the metadata endpoint', /fetchTemplateCatalogue/.test(strip(svc)) && /'\/resume-builder\/templates'/.test(strip(svc)));
ok('images are fetched only for cards near the one on screen', /const WINDOW = 6;/.test(homeC) && /want\.length < 5/.test(homeC));
ok('two hydration waves can never run at once', /if \(hydrating\.current\) return;/.test(homeC));
ok('a failing design is not retried forever', /dead\.current\[id\] = true/.test(homeC));
ok('the server cache no longer evicts the previous wave', /THUMB_KEEP/.test(strip(ctl)) && /stamped\.sort\(\(a, b\) => b\.at - a\.at\)/.test(strip(ctl)));

ok('the carousel NEVER renders a blank hole while it waits to be measured',
  /PROVISIONAL_W/.test(strip(carousel)) && !/\{w > 0 && \(/.test(carousel) && !/height: 300 \}/.test(strip(carousel)));

console.log('── add employer ──');
ok('the button says what it does', /Add employer/.test(homeC) && !/Find a job/.test(homeC));
// ⚠️ The job-feed fallback (fetchDiscoverJobs) is GONE, deliberately: it derived "websites" from
// global_jobs.employer_domain, which on production is a job board or ATS for 73% of employers that
// have a domain at all (arbetsformedlingen.se alone stands in for 4,014 of them).
ok('the sheet only SEARCHES — it never adds, because adding costs credits',
  !/deductSearchCredits/.test(sheetC) && !/fetchJobMatches/.test(sheetC)
  && /\/discover\/employers/.test(sheetC) && !/fetchDiscoverJobs/.test(sheetC));
// ⚠️ RETARGETED — THE USER OVERRULED THIS. It pinned "hand the choice to the Job Hub's audited add flow".
// The user: "when adding it took me to the jobs page... it should not ... from resume page it should stay
// there and the card should be addedd to start". And the hub it handed to rendered NOTHING for the add —
// its add-company list is dead code. The add now happens here: free safe tracking + a gated build.
ok('⚠️ adding an employer never leaves Home for the Job Hub', !/addCompany: value/.test(homeC) && !/tab: 'search', addCompany/.test(homeC));
// ⚠️ RETARGETED: the build moved into useHomeBuilds. Home tracks, then asks the hook — the ONE door.
ok('…it tracks the employer and builds from here',
  /trackEmployer\(/.test(homeC) && /useHomeBuilds\(/.test(homeC) && /\.request\(/.test(homeC)
  && /buildForEmployer\(/.test(kHookC) && !/buildForEmployer\(/.test(homeC));
ok('the hub consumes it exactly once', /handedOver\.current = true;/.test(hubC) && /typeof explicit === 'string' \? explicit : inputValue/.test(hubC));
ok('it can take a pasted website as well as a name', /Use this website/.test(sheetC) && /take\(fieldWebsite\)/.test(sheetC));
ok('region filters the search and suggests a design',
  /country=\$\{encodeURIComponent\(ctry \|\| ''\)\}/.test(sheetC) && /bestDesignForCountry/.test(strip(svc)));

console.log('── cover letters ──');
// ⚠️ RETARGETED: a SAVED letter now has a carousel of its own — the letter designs, ranked for that
// employer. What must never happen is still the same: letter mode drawing the resume pages.
ok('letter mode does NOT borrow the resume carousel',
  /mode === 'letter' && !shown \? \(\s*<LetterPanel/.test(homeC)
  && /kind === 'cover_letter' \? LETTER_DESIGNS : slots/.test(homeC) && /LETTER_SLOTS/.test(homeC));
ok('⚠️ and NEVER generates on entry — generation spends the letter quota',
  !/generate-cover-letter/.test(homeC) && /onWrite=\{\(\) => \{/.test(homeC));
ok('the letter designs are listed from one place', /LETTER_DESIGNS/.test(homeC) && /LETTER_DESIGNS: Array/.test(strip(svc)));

// ── Round 5: an empty account sees the product work; the catalogue is real; letters and the
//    add-employer sheet are legible ──────────────────────────────────────────────────────────────
const prev = R('../app/(dev)/home-preview.tsx');
const prevC = strip(prev);

console.log('── a brand-new account gets a SAMPLE, not an empty screen ──');
ok('the server builds one from what registration already knows', /async function sampleResumeFor/.test(ctlC) && /SELECT full_name, email FROM users/.test(ctlC));
ok('…and home-cards no longer dead-ends on "no resume"', !/reason: 'no_resume'/.test(ctlC.split('async function homeCards')[1] || ''));
ok('…and says plainly that it IS a sample', /cards, sample \}\)/.test(ctlC));
ok('⚠️ the sample is never written to the user’s resume', !/sampleResumeFor[\s\S]{0,400}INSERT INTO user_resumes/.test(ctlC));
ok('…and cannot collide with real thumbnails in the cache', /cachedThumb\(userId, row, id, tag\)/.test(ctlC) && /':' \+ tag \+ ':'/.test(ctlC));
ok('Home labels it', /sample && mode === 'resume'/.test(homeC) && /This is a sample so you can see the designs/.test(homeC));
ok('⚠️ and a sample offers ONE honest action, not a dead-end Customize',
  /sample \? \(/.test(strip(zoomSrc)) && /Build my resume/.test(strip(zoomSrc))
  && /if \(sample\) armBuilderFor\(target\)/.test(homeC));

console.log('── the catalogue is the WHOLE catalogue ──');
ok('the preview exercises all 15 families, not a handful', (prevC.match(/\{ id: '[a-z_]+', +name:/g) || []).length === 15);
ok('…drawn as different LAYOUTS, not one design recoloured', (prevC.match(/shape: '/g) || []).length >= 15 && /type Shape =/.test(prevC));
ok('a supplied catalogue loader is honoured', /\(loaders\?\.catalogue \|\| fetchTemplateCatalogue\)\(\)/.test(homeC));

console.log('── the letter panel fits inside its own card ──');
ok('the formats WRAP instead of scrolling out of the panel',
  /letterRow: \{ alignSelf: 'stretch', flexDirection: 'row', flexWrap: 'wrap'/.test(homeC)
  && !/<ScrollView horizontal[^>]*contentContainerStyle=\{s\.letterRow\}/.test(homeC));
ok('…and a long format name shrinks rather than overflowing', /letterChipTx: \{ flexShrink: 1/.test(homeC));

console.log('── add employer: recognisable results, and a way out when they are not listed ──');
ok('the field says what it takes', /placeholder="Employer name or website"/.test(sheetC));
ok('a result is identifiable: name, website, location', /h\.domain/.test(sheetC) && /h\.location/.test(sheetC) && /globe-outline/.test(sheetC) && /location-outline/.test(sheetC));
ok('…and results are cards, not bare rows', /hit: \{[\s\S]{0,180}borderRadius: 14/.test(sheetC));
ok('not in the list → add their website', /Not listed\? Add their website/.test(sheetC));
// ⚠️ NO SEPARATE MODE ANY MORE. The add-website box sits INLINE in the results. The old urlMode had to
// clear the field and remember the name, because `selectTextOnFocus` only fires on a focus EVENT and a
// pasted URL landed at the caret ("NordexNordexhttps://…"). A field that never switches meaning has no
// such trap, so the mode and everything that existed to patch it are gone.
ok('…inline, with no mode switch to patch around', !/urlMode/.test(sheetC) && !/keptName/.test(sheetC) && /s\.siteField/.test(sheetC));
ok('…offered whether or not there were hits', /hits\.length\s*\?\s*'Add their website'/.test(sheetC));

// ── Round 6: the posting the user is applying to, end to end ────────────────────────────────────
const builder = strip(R('../app/(resume-builder)/index.tsx'));

console.log('── the sheet asks for the listing, and asking stays free ──');
// The user's rule (3): "there will be an option always that will say to build for specific job".
ok('building for a specific job is always offered',
  /Building for a specific job\? Add the job link or paste the description/.test(sheetC));
ok('…taking a link OR pasted text', /placeholder="Link to the job posting"/.test(sheetC) && /paste the job description here/.test(sheetC));
ok('…and it still never searches or charges', !/deductSearchCredits/.test(sheetC) && !/fetchJobMatches/.test(sheetC));

console.log('── ⚠️ a pasted description never travels as a route param ──');
// There is no route any more, so there is no param to leak into; the listing still goes through storage
// (savePendingListing) for the section editor, and straight into the build as jobUrl/jobText.
ok('it goes through storage', /savePendingListing\(/.test(homeC));
ok('…and no description ever rides a route param', !/withListing/.test(homeC) && !/params:[\s\S]{0,80}jobText/.test(homeC));
ok('the hub reads it exactly once and clears it', /removeItem\('pending_job_listing'\)/.test(hubC) && /savePendingListing\(v, listing\)/.test(hubC));

console.log('── the listing survives to generation ──');
ok('it is stored per target, on the device', /export async function savePendingListing/.test(svcC) && /export async function loadJobListing/.test(svcC));
ok('⚠️ …on the DEVICE, because the jobs row is shared between users',
  /jobs\.job_url is globally unique/.test(svc) || /the row is\s*\n?\s*\* SHARED/.test(svc));
ok('the store is capped', /LISTINGS_MAX/.test(svcC));
ok('Home tells the builder which posting', /armBuilderFor/.test(homeC) && /target: t \? \{ company: t\.company, role: t\.role/.test(homeC));
ok('⚠️ …without arming the paid auto-build lane', !/armBuilderFor[\s\S]{0,300}autoBuild/.test(homeC));
ok('the builder sends it with BOTH generate calls', (builder.match(/job: jobForRequest\(\)/g) || []).length === 2);
ok('…and a generic build sends nothing', /if \(!t && !l\) return undefined;/.test(builder));

ok('cover letters pick the listing up too, without every caller threading it',
  /loadJobListing\(\{ applyUrl: websiteUrl, company: companyName \}\)/.test(strip(R('../services/aiHubService.ts')))
  && /body\.jobText = l\.jobText/.test(strip(R('../services/aiHubService.ts'))));

console.log('── ⚠️ THE LOWER HALF SHOWS WHAT YOU OWN, NOT THE DESIGNS AGAIN ──');
// The grid that used to be here fed TargetCard `cards[i % cards.length].image` — the SAME
// server-rendered resume pages the carousel above was already showing, cycled under a company
// badge. Scrolling revealed the same designs twice and told the user nothing new.
// ⚠️ NOT /<DownloadHistory/ — that also matches the `useState<DownloadHistoryItem[]>` type
// annotation, so it would pass with no section rendered at all. Match the JSX element itself.
ok('the library section is rendered by Home', /<DownloadHistory\n/.test(homeC));
// ⚠️ RETARGETED. It used to have to come AFTER </MeshStage>, because the light section lived
// there. There is no light section now — the library is glass on the same gradient — so the rule
// inverts: it must be INSIDE, or it sits on the root colour with an edge above it.
ok('…below the hero and INSIDE the one backdrop',
  homeC.indexOf('<DownloadHistory\n') > homeC.indexOf('setHeroH')
  && homeC.indexOf('<DownloadHistory\n') < homeC.indexOf('</MeshStage>'));
ok('…driven by the SAME mode switch the hero uses', /mode=\{mode\}/.test(homeC));
ok('…and it keeps the one affordance the old grid had', /onMoreJobs=/.test(homeC) && /tab: 'myjobs'/.test(homeC));

ok('⚠️ free-ness is the SERVER\'s answer, never computed here',
  /const free = item\.unlocked;/.test(histC) && !/ownsEmployer/.test(histC));
ok('…so a lapsed plan draws a padlock the download will agree with', /lock-closed/.test(histC));

ok('⚠️ the library NEVER requests its own renders', !/fetch\(/.test(histC) && !/home-cards/.test(histC));
ok('…it borrows an image Home already hydrated, or draws one',
  /cards\.find\(\(c\) => c\.id === templateId\)/.test(homeC) && /function Letterpress/.test(histC));
ok('…and the drawn page knows a letter from a resume', /LETTER_RULES/.test(histC) && /pAddr/.test(histC));

ok('the section paints from cache BEFORE the network', /cachedDownloadHistory/.test(homeC));
ok('…and a failed refresh leaves what is on screen alone', /if \(fresh\) setHistory/.test(homeC));
// ⚠️ 2026-09-15: a PDF downloaded from the gallery did not show on Home — the server had recorded download_history row 11,
// but the library was only re-read inside load(), throttled to once per 60 s. The library is now its OWN cached-then-
// fresh read, asked for on every focus after the first and when a build lands, never through load().
const refreshSrc = (homeC.match(/const refreshHistory = useStableFn\(async \(kind: Mode\) => \{[\s\S]*?\n  \}\);/) || [''])[0];
ok('refreshHistory is a stable fn (useStableFn) that never reads load()\'s throttle', refreshSrc.length > 100 && !/lastLoad/.test(refreshSrc) && !/60_000/.test(refreshSrc));
ok('…guarded by a sequence (histSeq): only the newest read touches the list, the cached paint included',
  /const histSeq = useRef\(0\);/.test(homeC) && /const seq = \+\+histSeq\.current;/.test(refreshSrc) && /if \(!current\(\)\) return;/.test(refreshSrc) && /if \(cached && current\(\)\)/.test(refreshSrc));
ok('…cached first, then the network', refreshSrc.indexOf('cachedDownloadHistory') > 0 && refreshSrc.indexOf('cachedDownloadHistory') < refreshSrc.indexOf('loadHistory('));
ok('…and it does not collapse an open library (setHistOpen(false) belongs to the kind switch alone)',
  !/setHistOpen\(false\)/.test(refreshSrc) && /useEffect\(\(\) => \{ setHistLoading\(true\); setHistOpen\(false\); refreshHistory\(mode\); \}, \[mode, refreshHistory\]\);/.test(homeC));
// ⚠️ RETARGETED (2026-09-19): the focus effect now also re-reads the profile's setup outside the throttle, and forces
// a full reload once after the Make Yours wizard built a résumé (consumeProfileChanged) — test-onboarding-wizard.js.
ok('⚠️ every focus after the first re-reads the library for the kind on screen, beside the still-throttled load()',
  /useFocusEffect\(useCallback\(\(\) => \{[\s\S]{0,260}?else load\(\)[\s\S]{0,160}?if \(focusCount\.current\+\+ > 0\) \{[\s\S]{0,200}refreshHistory\(modeOfKind\(kindRef\.current\)\);/.test(homeC));
ok('⚠️ a landed build re-reads the shelf for its kind when that kind is on screen (the other kind\'s shelf is read by the mode switch)',
  /if \(job\.kind === kindRef\.current\) refreshHistory\(modeOfKind\(job\.kind\)\);/.test(homeC) && homeC.indexOf('if (job.kind === kindRef.current) refreshHistory(') > homeC.indexOf('const onLanded = useStableFn('));
ok('load() still throttles ITSELF to 60 s (the documents) — the library read is the one outside it', /if \(!force && Date\.now\(\) - lastLoad\.current < 60_000\) return undefined;/.test(homeC));
// ⚠️ RETARGETED (2026-09-13): a library TAP no longer downloads — it opens the page (openHistoryItem, pinned
// in the LIBRARY CARD OPENS ITS PAGE section). These two now cover only the one fallback that still gets the
// file: a cover letter with no saved letter behind it, where there is no page to preview.
ok('the no-saved-letter fallback re-downloads through the server, which re-runs the same gate',
  /redownload\(it\.id\)/.test(homeC) && /if \(item\.unlocked\) doAgain\(item\);/.test(fnBodyOf(homeC, 'openHistoryItem')));
ok('⚠️ …and a locked row there opens the SAME purchase sheet a first download offers',
  /r\.locked/.test(homeC) && /<DownloadPaywallSheet/.test(homeC)
  && /else \{ againItem\.current = null; setPayFor\(item\.employer \|\| null\); \}/.test(fnBodyOf(homeC, 'openHistoryItem')));
ok('the resume asymmetry is stated rather than hidden', /latest resume in that design/.test(histSrc));
// ⚠️ THIS ONE COST A BLANK SECTION ON THE APP'S FRONT DOOR, CAUGHT IN THE PREVIEW HARNESS.
// The rows used to be swapped inside the completion callback of a fade-OUT. Flipping the mode also
// refetches, so `items` changed a moment after `mode` did, the effect ran twice, the second
// Animated.timing cancelled the first — and a cancelled animation STILL calls its callback, so the
// fade-in fired while the newer fade-out drove the value back to zero. The list rendered at
// opacity 0 with its locked strip and title still visible underneath it.
ok('⚠️ the rows are rendered straight from props, never held behind an animation callback',
  /\{shown\.map\(\(it, i\) => \(/.test(histC));
ok('…so no animation completion handler can decide whether the list exists',
  !/\.start\(\(\) => \{[\s\S]{0,200}setView/.test(histC) && !/const \[view, setView\]/.test(histC));

console.log('── ⚠️ MAKE YOURS: above the fold, or it does not exist ──');
// stageH = rootH * 1.18, so the hero is TALLER than the viewport — anything placed after
// </MeshStage> is below the first screenful, which is where the old download CTA died.
const heroBlock = homeC.slice(0, homeC.indexOf('</MeshStage>'));
ok('the CTA is INSIDE the hero, not below it', /makeWrap/.test(heroBlock));
// ⚠️ THIS ASSERTION USED TO SAY "only while the profile is unfinished", AND THAT WAS THE BUG THE
// user reported: the moment they completed a profile the only door to the wizard vanished, and
// rebuilding a resume from fresh notes is something people do repeatedly, not once. It is always
// reachable now; what changes is the WEIGHT — gradient when there is something left to do, glass
// when there is not, so it sits beside the carousel instead of shouting over it.
ok('the wizard is always reachable from Home', /\{!!setup && \(\(\) => \{/.test(homeC));
// ⚠️ RETARGETED. This used to require a GLASS pill once the profile was complete, and glass on a
// blue-violet hero is the one thing on that screen you cannot see — which is what "the button
// should be contrasting, eye engaging" was about. It is mint in both states now; only the glow
// changes, so a finished profile gets a quieter version of the same button rather than a hidden one.
ok('the CTA is the one warm accent on a blue screen, not glass on glass',
  /MAKE_MINT/.test(homeC) && /shadowColor: '#2DE0C0'/.test(homeC) && !/makeGhost/.test(homeC));
ok('…with dark ink on it, because white on mint is unreadable at this size',
  /const MAKE_INK = '#04211C'/.test(homeC) && /color: MAKE_INK/.test(homeC));
ok('…and the weight still varies with what is left to do', /!left\.length && s\.makeCalm/.test(homeC));
ok('…and it says what the user asked it to say', /'Make your Resume'/.test(homeC));
ok('…reading completeness from the SERVER, not a third local rule', /loaders\?\.setup \|\| /.test(homeC) && /fetchProfileSnapshot/.test(homeC));
ok('…and it routes rather than generating', /nav\(\)\?\.push\?\.\('\/\(onboarding\)'\)/.test(homeC));
ok('⚠️ no autoBuild anywhere near it', !/makeWrap[\s\S]{0,400}autoBuild/.test(homeC));

console.log('── ⚠️ the wizard collects only what an endpoint can actually store ──');
const wiz = strip(R('../app/(onboarding)/index.tsx'));
const psvc = strip(R('../services/profileSetupService.ts'));
ok('it writes through the PARTIAL update endpoint', /\/users\/profile\/update/.test(psvc));
ok('⚠️ …never /update-user-details, which NULLs every field it was not given',
  !/update-user-details/.test(psvc) && !/update-user-details/.test(wiz));
// ⚠️ RETARGETED, NOT DELETED. The rule this encodes is "never collect what no endpoint stores",
// and it is intact: city and country ARE asked for now — separately, because that is how a person
// knows what to type — and they are JOINED into `address`, which is the column that is really
// written. Nothing reaches a users.city or users.nationality that no code writes.
ok('city and country are joined into the one field that is actually stored',
  /const address = useMemo\(/.test(wiz) && /\[city\.trim\(\), country\?\.name\]\.filter\(Boolean\)\.join\(', '\)/.test(wiz));
ok('…and re-opening splits them back apart rather than losing one', /function splitAddress/.test(wiz));
ok('⚠️ nothing is sent to a column no endpoint writes',
  !/nationality/.test(wiz) && !/\bcity:/.test(psvc)
  && /for \(const k of \['fullName', 'phone', 'address', 'dateOfBirth', 'gender'\] as const\)/.test(psvc));
ok('the dial code rides the phone string, because phone_number is one free-text column',
  /\[dial, phone\.trim\(\)\]\.filter\(Boolean\)\.join\(' '\)/.test(wiz));
ok('⚠️ …and picking a country never overwrites a code the user chose themselves',
  /dialPinned\.current = true/.test(wiz) && /if \(!dialPinned\.current\) setDial\(c\.dial\)/.test(wiz));
ok('a saved number is split on the LONGEST matching code, so +91 beats +9',
  /d\.length > best\.length/.test(wiz));
ok('gender is the server\'s exact enum', /'Male', 'Female', 'Prefer Not to Say'/.test(wiz));
ok('the three uploads use the field names the server expects',
  /'profileImage'/.test(psvc) && /'signature'/.test(psvc) && /'resume'/.test(psvc));
ok('⚠️ Content-Type is never set by hand on a multipart post', !/'Content-Type': 'multipart/.test(psvc));
// ⚠️ RETARGETED (2026-09-19): "it says upload pdf only... it should say both pdf or any type of document too". The
// rule this encoded — offer only what the parser can read — is intact: the server now reads Word, OpenDocument,
// RTF and plain text (services/resumeText.js), so the picker offers exactly those, from ONE list in the service.
ok('the resume picker offers every format the server can READ — PDF and Word among them — from the service\'s one list',
  /type: RESUME_PICKER_TYPES/.test(wiz) && /'application\/pdf'/.test(psvc) && /wordprocessingml\.document/.test(psvc) && /'application\/msword'/.test(psvc));
ok('⚠️ …and "Choose a PDF" is gone: the copy names the formats that work', !/Choose a PDF/.test(wiz) && /RESUME_FORMATS_LINE/.test(wiz));
ok('⚠️ generating is behind an explicit tap, never on step entry',
  /onPress=\{plans \? onPlans : onStart\}/.test(wiz) && /onStart=\{start\}/.test(wiz) && !/useEffect\([\s\S]{0,120}build\(\)/.test(wiz));
// ⚠️ RETARGETED (2026-09-19): the first unfinished step is the SERVER's (setup.wizard.step); the four-boolean rule
// survives only for an older server that sends no `wizard`.
ok('it resumes at the first unfinished step — the server\'s', /first = running \|\| ready \? LAST : w\.step;/.test(wiz)
  && /!s\.setup\.profile \? 0 :/.test(wiz));
ok('⚠️ the step override is __DEV__ ONLY, so it cannot skip a step for a real user',
  /__DEV__ && params\.step != null/.test(wiz));
ok('…and it is clamped, so a hand-typed url cannot land off the end', /Math\.min\(3,/.test(wiz));
ok('the header spacer paints nothing — an empty glass button is a button nobody can press',
  /iconSpacer: \{ width: 38, height: 38 \}/.test(wiz));

console.log('── ⚠️ the progress bar reports the SERVER\'s stages ──');
ok('generation runs as a background job', /__async: true/.test(psvc));
ok('…polled until it finishes', /job-status\//.test(psvc));
ok('⚠️ a progress tick is told from the final payload by resumeData', /data\.stage && !j\.data\.resumeData/.test(psvc));
ok('⚠️ the UI is driven by STATUS, not by progress (failJob leaves progress where it was)',
  /j\.status === 'completed'/.test(psvc) && /j\.status === 'failed'/.test(psvc));
ok('the bar never overtakes the stage it was told about', /Math\.min\(target/.test(wiz));
ok('⚠️ and it is scaleX, not an animated width — width forces the JS driver',
  /scaleX: bar/.test(wiz) && !/useNativeDriver: false/.test(wiz));

console.log('── ⚠️ ONE SURFACE: nothing on this page has an edge ──');
ok('everything is inside the backdrop — library, dashboard link and the tab bar\'s tail',
  homeC.indexOf('<DownloadHistory') < homeC.indexOf('</MeshStage>')
  && homeC.indexOf('s.dashLink') < homeC.indexOf('</MeshStage>')
  && homeC.indexOf('style={s.tail}') < homeC.indexOf('</MeshStage>'));
// ⚠️ Anything rendered after </MeshStage> sits on the ROOT colour, which is the near-black the
// gradient starts from — so a sibling at the foot would be a hard step back to dark.
ok('…and the root is that same starting colour, for the bounce at the top',
  /root: \{ flex: 1, backgroundColor: E\.stage \}/.test(homeC));

// ⚠️ THE HOME-INDICATOR STRIP (2026-09-18): "why there is a bottom white small area on the home page".
// HomeScreen keeps its BOTTOM safe-area edge for Home (pinned above), so the last insets.bottom points of
// the screen were that wrapper's light padding under the menu — and the page stopped dead on top of it,
// slicing the Tailor button so its blue and violet ends peeked out either side of the pill. The page now
// hangs into that strip instead; these pin the pairing and that nothing measured from the top moved.
console.log('── ⚠️ THE PAGE RUNS TO THE BOTTOM EDGE: no light band under the menu (2026-09-18) ──');
ok('the bleed is exactly the bottom inset the wrapper pads with', /const footBleed = insets\.bottom;/.test(homeC));
ok('⚠️ …and it is PAIRED with that padding: HomeScreen still pads the bottom for Home, and the scroll view hangs into it',
  /: \['left', 'right', 'bottom'\]\}/.test(hsC) && /style=\{\[s\.scroll, \{ marginBottom: -footBleed \}\]\}/.test(homeC));
ok('…the ROOT does not move, so the fold, the Tailor hint and the pinned header keep their geometry',
  /root: \{ flex: 1, backgroundColor: E\.stage \}/.test(homeC) && /const foldY = \(rootH \|\| 0\) - FOLD_ALLOW;/.test(homeC)
  && /<View style=\{s\.root\} onLayout=/.test(homeC));
ok('the scroll view paints the stage itself, so a bounce at the foot never shows the wrapper\'s grey in the strip',
  /scroll: \{ flex: 1, backgroundColor: E\.stage \}/.test(homeC));
ok('a short page still fills the strip: the stage is at least the viewport plus the bleed',
  /const stageMinH = Math\.max\(stageH, \(rootH \|\| 700\) \+ footBleed\);/.test(homeC)
  && /<MeshStage style=\{\{ minHeight: stageMinH, paddingTop: headerH \}\}/.test(homeC));
ok('⚠️ the page still ENDS where it did: a bleed-high spacer under the tail, inside the backdrop — counted once',
  homeC.indexOf('style={s.tail}') > 0
  && homeC.indexOf('style={s.tail}') < homeC.indexOf('style={{ height: footBleed }}')
  && homeC.indexOf('style={{ height: footBleed }}') < homeC.indexOf('</MeshStage>')
  && !/minHeight: stageH \+ footBleed/.test(homeC));

console.log('── ⚠️ THE MENU IS A LITTLE TRANSLUCENT, AND ITS LABELS GOT DARKER TO PAY FOR IT (2026-09-18) ──');
{
  const tabBar = R('../components/FloatingTabBar.js');
  const tabC = strip(tabBar);
  const fill = (tabC.match(/export const TAB_BAR_FILL = 'rgba\(255,255,255,(0?\.\d+)\)'/) || [])[1];
  const ink = (tabC.match(/export const TAB_BAR_INK = '#([0-9A-Fa-f]{6})'/) || [])[1];
  const a = Number(fill);
  // 2026-09-18, on the simulator: at 86% the page's own TEXT read clearly through the pill, behind the labels. A little
  // transparent means a faint tint — so the band is 91-95%: see-through, not a slab, and never text-through.
  ok('the pill is white at 91-95%: a faint tint, not a slab, and not so thin the page\'s text reads through', a >= 0.91 && a <= 0.95, fill);
  ok('…drawn with that fill', /surface:\s+TAB_BAR_FILL/.test(tabC) && /backgroundColor: T\.surface/.test(tabC));
  ok('…and not with a BlurView (it samples badly over a scrolling page on Android)', !/expo-blur|BlurView/.test(tabC));
  // WCAG contrast of the inactive label on the fill, composited over the darkest page it floats on and over white.
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (x, y) => { const p = L(x), q = L(y); return (Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05); };
  const over = (bg) => bg.map((c) => Math.round(a * 255 + (1 - a) * c));
  const inkRgb = ink ? [0, 2, 4].map((i) => parseInt(ink.slice(i, i + 2), 16)) : [255, 255, 255];
  const onDark = ratio(inkRgb, over([7, 10, 24]));        // E.stage, the near-black Home
  const onLight = ratio(inkRgb, over([248, 250, 252]));   // the light screens
  const before = ratio([136, 150, 176], [255, 255, 255]); // the old #8896B0 on the old OPAQUE white
  ok('⚠️ every inactive label is MORE legible than before, even on the fill over the near-black Home',
    onDark >= 3.5 && onDark > before && onLight > before, { onDark: onDark.toFixed(2), onLight: onLight.toFixed(2), before: before.toFixed(2) });
  ok('the active tab is still the opaque blue gradient with white on it',
    /colors=\{\[T\.blue, T\.blueDeep\]\}/.test(tabC) && /activeLabel: \{[^}]*color: '#fff'/.test(tabC));
}

// ⚠️ A SHARP PAGE THAT STILL ZOOMED SOFT (2026-09-18). The server now ships 3x pages (2382 px, PREVIEW_REV hd1),
// but expo-image cuts every bitmap to its FRAME × screen scale unless told not to (allowDownscaling, default
// true) — CARD_W on a 3x phone is 1107 px — and the pinch is a ScrollView transform on that frame, so the
// zoom enlarged the cut copy exactly as it had enlarged the old 1x page. Read from the AST, not a regex: EVERY
// Image inside a zoomable ScrollView must carry the prop, and the prop is evaluated for the page on screen,
// its neighbour and Android — an Image added to a zoomed pager later without it fails here by construction.
console.log('── ⚠️ THE LETTER PAGE BEING ZOOMED IS DECODED AT FULL SIZE, ITS NEIGHBOURS ARE NOT (2026-09-18) ──');
{
  const letterGal = R('../app/(cover-letter)/templates.tsx');
  const ast = parser.parse(letterGal, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  const tag = (el) => el.openingElement.name && el.openingElement.name.name;
  const attrOf = (el, n) => el.openingElement.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === n);
  const zoomed = [];                   // { el, index } — every Image under a ScrollView with maximumZoomScale
  const walk = (node, inZoom, index) => {
    if (Array.isArray(node)) { node.forEach((n) => walk(n, inZoom, index)); return; }
    if (!node || typeof node.type !== 'string') return;
    // The pager's `.map((slot, i) => …)` names the page index the prop must compare with `active`.
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'map'
      && node.arguments[0] && /Function/.test(node.arguments[0].type)) {
      const p = node.arguments[0].params[1];
      index = p && p.type === 'Identifier' ? p.name : null;
    }
    if (node.type === 'JSXElement') {
      if (tag(node) === 'ScrollView' && attrOf(node, 'maximumZoomScale')) inZoom = true;
      if (tag(node) === 'Image' && inZoom) zoomed.push({ el: node, index });
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
      const v = node[k];
      if (v && typeof v === 'object') walk(v, inZoom, index);
    }
  };
  walk(ast.program, false, null);
  ok('both pagers are found: the doc pager and the classic one each zoom exactly one Image', zoomed.length === 2, zoomed.length);
  const exprs = zoomed.map(({ el, index }) => {
    const a = attrOf(el, 'allowDownscaling');
    const e = a && a.value && a.value.type === 'JSXExpressionContainer' ? a.value.expression : null;
    return { index, src: e ? letterGal.slice(e.start, e.end) : null };
  });
  ok('⚠️ every zoomable Image says allowDownscaling (the default cut the 3x page to the frame)',
    exprs.length === 2 && exprs.every((x) => !!x.src), exprs);
  // The prop as a function of the page index, `active` and the platform switch — run, not pattern-matched.
  const run = (x, idx, active, ios) => {
    try { return new Function(x.index || 'i', 'active', 'FULL_RES_ZOOM', 'return (' + x.src + ');')(idx, active, ios); }
    catch (e) { return 'threw: ' + e.message; }
  };
  ok('⚠️ iOS: the page on screen keeps every pixel (allowDownscaling false)',
    exprs.length === 2 && exprs.every((x) => x.src && x.index && run(x, 3, 3, true) === false), exprs.map((x) => x.src && run(x, 3, 3, true)));
  ok('…and its neighbours are still cut to the frame, so a gallery of pages is not a gallery of 32 MB bitmaps',
    exprs.length === 2 && exprs.every((x) => x.src && run(x, 2, 3, true) === true && run(x, 4, 3, true) === true && run(x, 0, 3, true) === true));
  ok('Android (no pinch there — maximumZoomScale is iOS-only) keeps the default on every page',
    exprs.length === 2 && exprs.every((x) => x.src && run(x, 3, 3, false) === true && run(x, 2, 3, false) === true));
  ok('the switch is the platform, read once at module scope', /\nconst FULL_RES_ZOOM = Platform\.OS === 'ios';/.test(strip(letterGal)));
  ok('the reason is written where the constant lives', /THE PAGE BEING LOOKED AT DECODES AT FULL SIZE/.test(letterGal));
}
ok('the page opens toward a lighter navy instead of ending on white', /const LIFT = /.test(meshC) && /lift\(0\)/.test(meshC));
// ⚠️ `transparent` is transparent BLACK. Interpolating to it drags the midpoint toward dark and
// leaves a muddy band — the artefact that made the old seam visible in the first place.
ok('⚠️ not one gradient in the backdrop passes through the `transparent` keyword',
  !/'transparent'/.test(meshC));
ok('every wash tail is a ZERO-ALPHA version of its own colour, so it cannot flood the page below',
  /rgba\(79,141,255,0\)/.test(meshC) && /rgba\(124,107,255,0\)/.test(meshC) && /rgba\(20,184,166,0\)/.test(meshC));
// ⚠️ react-native-web turns start/end into a CSS ANGLE and throws the LENGTH away. An axis
// shortened to `0.64 * focus` therefore paints one thing on a phone and another in the preview
// harness — the one tool that exists to show what the phone will do.
ok('⚠️ `focus` moves the STOPS; it never shortens an axis',
  !/end=\{\{ x: [^}]*\* f \}\}/.test(meshC) && /locations=\{\[0\.10, 0\.40 \* f, 0\.92 \* f\]\}/.test(meshC));
ok('…and every axis runs corner to corner or straight down, where CSS and native agree',
  /start=\{\{ x: 0, y: 0 \}\} end=\{\{ x: 1, y: 1 \}\}/.test(meshC)
  && /start=\{\{ x: 1, y: 0 \}\} end=\{\{ x: 0, y: 1 \}\}/.test(meshC));
// ⚠️ The grid is a fixed COUNT of absolutely-placed lines: on a page taller than rows * 30 it
// simply stops, and the row where it stops is a visible horizontal edge.
ok('the grid is told how tall the page is', /rows\?: number/.test(meshC) && /Math\.ceil\(stageH \/ 30\)/.test(homeC));

console.log('── the library is glass ON that page, not a white tile dropped on it ──');
// ⚠️ DARKER THAN THE PAGE, NOT LIGHTER. A white tint over a blue gradient is a milky grey-blue:
// card and ground meet in the middle, white text loses its contrast, and the list reads as fog.
// Glass on a dark ground is a pane DEEPER than what is behind it, described by a lit rim.
ok('the card fill is translucent AND deeper than the page it sits on',
  /backgroundColor: 'rgba\(6,11,30,0\.46\)'/.test(histC)
  && /borderColor: 'rgba\(255,255,255,0\.10\)'/.test(histC));
ok('…and the wizard\'s panels learned the same thing', /backgroundColor: 'rgba\(6,11,30,0\.42\)'/.test(wiz));
ok('the format moved off the 50pt thumbnail and into the line that describes the file',
  /fmt: \{ fontSize: 9\.5/.test(histC) && !/stampPdf/.test(histC));
ok('a row\'s one control wears the accent, so it is findable',
  /rgba\(45,224,192,0\.16\)/.test(histC) && /color=\{E\.mint\}/.test(histC));
ok('⚠️ and no light-theme ink survived the move',
  !/E\.ink/.test(histC) && !/E\.textMuted/.test(histC) && !/E\.textFaint/.test(histC) && !/E\.surface/.test(histC));
ok('…including the dashboard link, which was the last white thing on the screen',
  !/backgroundColor: E\.surface/.test(homeC) && /dashLink[\s\S]{0,160}backgroundColor: E\.glass/.test(homeC));
// ⚠️ These same white faces read as light over a white card and as a grey patch over a dark one,
// and the grey takes the text's contrast with it.
ok('the glass faces were re-weighted for a dark ground, not carried over',
  /rgba\(255,255,255,0\.17\)/.test(histC) && !/rgba\(255,255,255,0\.50\)', 'rgba\(255,255,255,0\.06\)/.test(histC));

console.log('── ⚠️ FOUR STEPS, EACH ONE SCREEN ──');
const stepList = (wiz.match(/const STEPS[\s\S]*?\n\];/) || [''])[0];
ok('the wizard is four steps, not five', (stepList.match(/key: '/g) || []).length === 4);
ok('photo and signature share one — each was a single control with a screen to itself',
  /key: 'sign', title: 'Photo & signature'/.test(wiz));
ok('…so resuming requires BOTH before it moves past that step',
  /\(!s\.setup\.photo \|\| !s\.setup\.signature\) \? 1/.test(wiz));
ok('⚠️ saving a signature no longer jumps ahead, which would walk away from an unchosen photo',
  !/uploadSignature\(uri\)[\s\S]{0,400}goTo\(/.test(wiz));
ok('the details are ONE card of fixed rows, not five boxed fields',
  /function Row\(\{/.test(wiz) && /row: \{ height: 54,/.test(wiz));
// ⚠️ The footer used to be a near-opaque panel with a hairline on top: a second background across
// the foot of a screen that is one continuous gradient — the same complaint as the home seam.
ok('⚠️ the footer paints NO bar behind its button',
  /backgroundColor: 'transparent', gap: 10,/.test(wiz) && !/borderTopColor/.test(wiz));
ok('…the button carries itself on colour instead, the same mint that brought them here',
  /const MINT: \[string, string, string\]/.test(wiz) && /colors=\{MINT\}/.test(wiz)
  && /color: MINT_INK/.test(wiz));
ok('…and the scroll padding still keeps content from running under it',
  /paddingBottom: 126 \+ insets\.bottom/.test(wiz));
ok('…and the last step is still the only one that spends a generation',
  /step === 3 && \(\s*<BuildStep/.test(wiz) && /onPress=\{plans \? onPlans : onStart\}/.test(wiz)
  && (wiz.match(/generateResume\(/g) || []).length === 1);

console.log('── ⚠️ the date of birth is picked, not typed ──');
ok('it uses the picker the app already ships', /import DateTimePicker from '@react-native-community\/datetimepicker'/.test(wiz));
ok('⚠️ Android gets the bare dialog — mounting it inside a Modal shows two pickers',
  /\{dobOpen && Platform\.OS === 'android' && \(/.test(wiz));
ok('…and iOS gets the sheet, which is App.js\'s own pattern for this component',
  /Platform\.OS === 'ios' && \(\s*<Modal transparent visible=\{dobOpen\}/.test(wiz));
ok('⚠️ it still writes a plain YYYY-MM-DD — an ISO instant re-introduces the timezone off-by-one',
  /setDob\(iso\(dobDraft\)\)/.test(wiz) && /const ISO_RE = \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//.test(wiz));

console.log('── the country list is data, and the flag is computed ──');
ok('⚠️ the flag comes from the ISO pair, so it cannot disagree with the code',
  /0x1f1e6 \+ c\.charCodeAt\(0\) - 65/.test(countriesSrc));
ok('⚠️ nothing turns a dial code back into a country — +1 is twenty-two of them',
  !/countryByDial/.test(countriesSrc));
ok('search covers the name, the ISO and the code', /export function searchCountries/.test(countriesSrc));
ok('⚠️ the picker owns no Animated value, so it cannot mix drivers with the wizard behind it',
  !/Animated/.test(countrySheetC));
ok('…and it opens on the current answer rather than at Afghanistan', /initialScrollIndex=\{initialIndex\}/.test(countrySheetC));

console.log('── ⚠️ THE SIGNATURE STUDIO: drawn, typed, or drawn and then enhanced ──');
ok('⚠️ it loads NOTHING over the network — the old generator pulled cursive faces from a CDN',
  !/https?:\/\//.test(studioC) && !/googleapis/.test(studioC));
ok('the hands are whichever ones the DEVICE has, found by measuring',
  /function resolve\(\)/.test(studioC) && /measureText\('Signature Mg'\)/.test(studioC));
ok('…two styles that resolved to the same face are folded together',
  /if\(seen\[w\]\) continue;/.test(studioC));
ok('⚠️ …and there is always at least one, even on a device with none of them',
  /if\(!out\.length\) out\.push/.test(studioC));
ok('⚠️ enhance RE-RENDERS the stored points; it does not filter the bitmap',
  /window\.__smooth=function\(on\)\{ smooth=!!on; render\(\); \}/.test(studioC));
ok('…which is why it can be turned back off', /const v = !smooth/.test(studioC));
// ⚠️ THE FIRST VERSION DID ALMOST NOTHING. Catmull-Rom is an INTERPOLATING spline: it passes
// through every point it is given, so every tremor survived and "enhance" only added in-between
// points. Smoothing has to move points OFF the path they were captured on.
ok('⚠️ the smoothing MOVES points off the captured path',
  /function soften\(pts, passes, w\)/.test(studioC) && /function resample\(pts, step\)/.test(studioC));
ok('…then re-draws through a handful of controls, which is what makes it flow',
  /function refit\(pts, every\)/.test(studioC) && /refit\(soften\(resample\(src, 1\.8\), 3, 2\), 6\)/.test(studioC));
ok('⚠️ the ends are pinned on every pass, or the stroke shrinks a little each time',
  /o\[0\]=pts\[0\]; o\[o\.length-1\]=pts\[pts\.length-1\];/.test(studioC));
ok('the ribbon is tapered by how fast the finger was moving',
  /function speeds\(pts\)/.test(studioC) && /4\.4-3\.1\*f/.test(studioC));
// It goes onto a letterhead, so the page must never paint a ground into the bitmap: the white is
// CSS on the body, and the canvas itself only ever has ink on it.
ok('⚠️ the exported PNG has no background — nothing ever fills the canvas',
  !/fillRect/.test(studioC) && /clearRect\(0,0,c\.width,c\.height\)/.test(studioC));
ok('⚠️ every preview is trimmed to its ink before it is fitted, or tall faces clip',
  /function bitmap\(st, text\)/.test(studioC) && /BM\[key\]=trim\(o\)/.test(studioC));
ok('the export goes through that same trim, at print scale', /var X=3;/.test(studioC));
ok('the bridge is still the proven one: base64 → a file → multipart',
  /image\/png/.test(studioC) && /EncodingType\.Base64/.test(studioC));
ok('⚠️ the old pad is deleted, not left behind to drift out of date',
  !fs.existsSync(path.join(__dirname, '../components/onboarding/SignaturePad.tsx')));

console.log('── ⚠️ EMPLOYER SEARCH IS EMPLOYER SEARCH, NOT A JOB SEARCH ──');
// Measured against production before this was built: q=Siemens returned 50 jobs whose companies
// were mostly STAFFING AGENCIES (Randstad, Experis, Skill Kompetenspartner) that merely mention
// Siemens in the posting text, and q=Nordex returned 0 — a real 10,000-person employer with a live
// careers site, invisible because the firehose has never crawled them. An employer only "existed"
// if we happened to hold one of their postings.
ok('there is a real employer endpoint now', /router\.get\('\/discover\/employers'/.test(discRoutes));
ok('…behind the same auth as its siblings', /'\/discover\/employers', authenticateToken/.test(discRoutes));
// Bound the slice to THIS handler: the file's other handlers (ai-search, live-search) do spend.
const empHandler = (discC.match(/async function discoverEmployers[\s\S]*?\n\}/) || [''])[0];
ok('⚠️ it is FREE — the sheet calls it on a keystroke debounce',
  empHandler.length > 200 && !/deductCredits|getEventCost|credits/i.test(empHandler));
// ⚠️ THE IDENTITY TABLE NOTHING EVER QUERIED BY NAME. `employers` is keyed UNIQUE on domain and is
// read by domain everywhere in this codebase; it is the one place that knows an employer we have
// no postings for.
ok('it reads the employers identity table', /FROM employers/.test(discC));
ok('…and DISTINCT employer names from the firehose', /global_jobs/.test(discC) && /employer_name/.test(discC));
// ⚠️ NEVER the job text. Matching title/description is what surfaced the agencies.
ok('⚠️ it never matches job titles or descriptions', !/lower\(title\)/.test(discC.slice(discC.indexOf('async function discoverEmployers'))));
ok('a query under two characters never touches the database', /\.length < 2/.test(discC));

console.log('── ⚠️ pg_trgm may be REFUSED, and the endpoint must not care ──');
ok('availability is probed, not assumed', /FROM pg_extension WHERE extname = 'pg_trgm'/.test(discC));
// ⚠️ The first version latched "no trigrams" on ANY error — one pool reset or statement timeout and
// fuzzy matching was dead for the life of the worker, while logging a claim about the database that
// was not true. Only the error that actually means "this function does not exist" may latch it.
ok('⚠️ only a real 42883/42704 latches the flag off', /e\.code === '42883' \|\| e\.code === '42704'/.test(discC));
ok('…and a transient probe failure leaves it unset, so the next request re-asks', /trgmAvailable = null/.test(discC));
ok('there is an anchored prefix term the btree can actually serve', /prefix/.test(discC) && /LIKE/.test(discC));

console.log('── ⚠️ A WEBSITE IS REQUIRED — A BARE NAME NEVER PROCEEDS ──');
// ⚠️ THIS SECTION USED TO SAY THE OPPOSITE, AND THAT WAS A DECISION THE USER OVERRULED. It pinned "the typed
// name is always usable": an employer, for writing a resume, is a name. The user's reply, verbatim: "if you
// are not able to find out a website then mention to add employer website instead of job posting... because
// for resume building or cover letter building we need the website". A name gives the builder nothing to
// research. So a pick ALWAYS carries a website, and when none is found the sheet says so and asks for one.
ok('⚠️ there is no bare-name path out of the sheet', !/canUseTyped/.test(sheetC));
ok('…every pick carries a website', /const take = \(website: string, name\?: string\)/.test(sheetC) && /website: string;/.test(sheetC));
// ⚠️ "We couldn't find a website" is a FACTUAL claim, so it is made only on a real 'ok' answer. A failed
// lookup, or a 'degraded' one from the fallback provider, proves nothing about whether a website exists.
ok('⚠️ "no website found" is only ever said on a real answer',
  /lookup === 'ok'\s*\?\s*`We couldn't find a website for/.test(sheetC) && /We couldn't look up websites right now/.test(sheetC));
ok('…and a job posting is never offered INSTEAD of the website',
  !/add (a|the) job (link|posting) instead/i.test(sheetC));
ok('the sheet still spends nothing', !/deductCredits|generate-ai|ai-search/.test(sheetC));
ok('a miss is reported without the raw query', /home_add_employer_miss/.test(sheetC) && !/q: q\b/.test(sheetC));

console.log('── ⚠️ THE PER-EMPLOYER CACHE IS A MONEY COMPONENT ──');
ok('migration 045 creates the table', /Migration 045/.test(dbInit) && /CREATE TABLE IF NOT EXISTS user_employer_documents/.test(dbInit));
// ⚠️ Postgres treats NULLs as DISTINCT, so one nullable member silently defeats the dedupe: every
// lookup misses, the user is re-charged, and the table grows without bound. Migration 044 learned it.
const uedBlock = (dbInit.match(/CREATE TABLE IF NOT EXISTS user_employer_documents[\s\S]*?\)`\);/) || [''])[0];
// NOT NULL is the part that defeats NULL-distinctness; the DEFAULT is what stops an omitted
// column becoming one. `kind` needs no default — no writer may leave it unsaid, and the CHECK
// below refuses anything but the two real values.
for (const colName of ['kind', 'employer_key', 'employer_name', 'input_fingerprint', 'environment']) {
  ok(`⚠️ ${colName} is NOT NULL (it is in the unique key)`,
    new RegExp(colName + '\\s+\\S+[^,]*NOT NULL').test(uedBlock));
}
for (const colName of ['employer_key', 'employer_name', 'input_fingerprint', 'environment']) {
  ok(`…and ${colName} defaults, so an omitted value cannot become NULL`,
    new RegExp(colName + '\\s+\\S+[^,]*NOT NULL[^,]*DEFAULT').test(uedBlock));
}
ok('the unique key is the cache key', /uq_user_employer_docs[\s\S]{0,200}user_id, kind, employer_key, input_fingerprint, environment/.test(dbInit));
ok('kind and environment are CHECK-constrained like migration 044', /chk_user_employer_documents_kind/.test(dbInit) && /chk_user_employer_documents_environment/.test(dbInit));
ok('⚠️ environment is capitalised, matching download_passes', /'Sandbox','Production'|'Sandbox', 'Production'/.test(dbInit));

ok('the cache keys on the SAME employer string the money path charges under', /downloads\.employerKeyOf/.test(docsC));
// ⚠️ The first version capped `model` at 80 into a VARCHAR(48). Postgres REJECTS an over-length
// varchar (22001) rather than truncating, and the insert sits in a swallow-everything catch — so
// the cache would have silently stopped writing rows and re-charged the user forever.
ok('⚠️ the model cap is tied to the column width', /MODEL_MAX = 48/.test(docsC));
ok('⚠️ the employer name is truncated ONCE, before it is keyed', /EMPLOYER_NAME_MAX/.test(docsC) && /employerNameOf/.test(docsC));
// ⚠️ An unknown kind must not become 'resume': a cover letter served as a resume would be handed
// over free, because a hit skips the billing claim as well as the AI call.
ok('⚠️ an unrecognised kind refuses instead of guessing',
  /function kindOf\(k\) \{[\s\S]{0,220}return null;/.test(docsC) && /refusing to guess/.test(docsSrc));
ok('…and never widens a DELETE', /if \(!want\) return;/.test(docsC));
ok('a listing ships no payloads', /function list\(/.test(docsC) && !/SELECT \*[\s\S]{0,200}function list/.test(docsC));
ok('it prunes itself, like download_history', /KEEP_PER_KIND/.test(docsC) && /function prune\(/.test(docsC));
ok('a fingerprint exists, or an edited base resume serves a stale tailored one', /function fingerprint\(/.test(docsC) && /FP_VERSION/.test(docsC));

console.log('── ⚠️ ONE SHARED BALANCE, FOUR WRITERS ──');
// A check-then-decrement lets two concurrent taps both pass and drive the balance negative. Fixing
// one of four writers does not fix the column.
const debits = (aiHubC.match(/credits_remaining = credits_remaining - /g) || []).length;
const guarded = (aiHubC.match(/AND credits_remaining >= /g) || []).length;
ok(`⚠️ every debit of credits_remaining is guarded (${guarded}/${debits})`, debits > 0 && guarded >= debits);
ok('…and the guard decides, so a zero-row result is insufficient funds', /RETURNING credits_remaining/.test(aiHubC));

console.log('── ⚠️ A BLANK CARD IS A DRAWN CARD NOW ──');
ok('there is a page-sized skeleton', /export default function PaperSkeleton/.test(skelC));
ok('it draws the RIGHT design — it already knows the accent and the name', /accent/.test(skelC) && /name/.test(skelC));
// ⚠️ Only five of 73 slots are ever in flight (a chromium crash constraint), and any id the renderer
// fails to return is marked permanently dead with no retry. Saying "loading" on all 73 is a lie.
ok('⚠️ the loading word is given by the caller, never inferred from a missing image',
  /state = 'idle'/.test(skelC) && /export type PaperState/.test(skelC));
ok('⚠️ every animation here is native-driver, transform/opacity only',
  !/useNativeDriver: false/.test(skelC) && !/Animated\.(timing|spring|loop)[\s\S]{0,200}(width|height|backgroundColor):/.test(skelC));
ok('the carousel passes what it actually knows', /PaperSkeleton/.test(carC) && /state=/.test(carC));

console.log('── the gallery gets an Edit button, and it does not build a stack ──');
ok('the count pill became a real button', /goEdit/.test(galC) && /editPill/.test(galC));
// ⚠️ preview pushes templates for its Download action; if templates pushes preview back, the two
// screens push each other forever and hardware-back lands on a stale pre-edit instance.
ok('⚠️ it goes BACK to a preview already below rather than pushing a second one',
  /router\.canGoBack\(\)/.test(galC) && /router\.back\(\)/.test(galC));
// ⚠️ `previews` is mounted state and ensurePreviews early-returns on a cached id, so without this
// the gallery shows pre-edit renders after the one thing a button called Edit invites you to do.
ok('⚠️ returning from the editor invalidates the preview cache', /useFocusEffect/.test(galC) && /setPreviews\(\{\}\)/.test(galC));

console.log('── ⚠️ THE WEBSITE COMES FROM A LOOKUP, NEVER FROM A GUESS ──');
// Measured before this was built: Clearbit's keyless autocomplete answered "nordex" with Nordex SE —
// nordex-online.com. The old add flow's last resort FABRICATED https://www.{slug}.com, which for Nordex
// is the wrong website entirely, and that fabricated host then keyed the employer row and its cache.
ok('there is a company website lookup', /function lookupWebsites/.test(lookupC) && /autocomplete\.clearbit\.com/.test(lookupSrc));
ok('⚠️ it never fabricates a www.{slug}.com', !/`https:\/\/www\.\$\{/.test(lookupC) && !/'https:\/\/www\.' \+/.test(lookupC));
ok('the endpoint runs the lookup and the database IN PARALLEL', /Promise\.all/.test(empHandler) && /lookupWebsites/.test(discC));
ok('every response says whether the lookup ran', /websiteLookup: web\.status/.test(discC));
// ⚠️ Only the company name may leave the server. The first version forwarded anything up to 80 chars —
// an email, a pasted posting URL with candidate tokens, a pasted job description.
ok('⚠️ the privacy gate lives IN the lookup, not in its caller', /'refused'/.test(lookupC) && /@/.test(lookupC));
// ⚠️ ...and the first gate refused every '/', so "Novo Nordisk A/S" and "Petrobras S/A" came back as
// "no website found". The Danish and Brazilian legal forms are common in this app's user base.
ok('⚠️ a legal form with a slash (A/S, S/A) is not refused', /a\/s|A\/S/.test(lookupSrc));
// ⚠️ A breaker that reacts only to failures still lets a long Clearbit outage become sustained
// per-keystroke Wikimedia traffic, which its UA policy warns can get the IP blocked.
ok('the fallback provider is rate-capped, not just breaker-guarded', /bucket|Bucket/.test(lookupC) && /tripped\(\)/.test(lookupC));
ok('⚠️ a timeout WE imposed never trips the upstream\'s breaker', /budget: true|budget = true/.test(lookupC));

console.log('── ⚠️ 73% OF JOB-DERIVED "WEBSITES" WERE JOB BOARDS ──');
// Production, 2026-09-11: of 9,053 employers in global_jobs with any employer_domain, 6,604 sit on a host
// shared by 3+ different employers — a board or an ATS. employer_domain is the host of the POSTING.
ok('a host shared by many employers is recognised from the data, not only from a list',
  /function sharedPostingHosts/.test(discC) && /count\(DISTINCT lower\(employer_name\)\) >= \$1/.test(discC)
  && /SHARED_HOST_MIN_NAMES = 3\b/.test(discC));
ok('…refreshed in the background, never awaited by a request', /sharedPostingHosts\(\)/.test(discC));
// ⚠️ But a company's OWN careers portal is shared by its own subsidiaries (Zalando, Zalando SE, Zalando
// Finland Oy). Without this, q=zalando answered "no website found" for a 64-job employer.
ok('⚠️ a host named after the employer is theirs even when their subsidiaries share it', /function ownsHost/.test(discC));
// ⚠️ An ATS tenant subdomain carries the employer's name (acme.softgarden.io, nordan.varbi.com), so a
// name test on the whole host lets it through. Only the REGISTRABLE label counts.
ok('⚠️ only the registrable label counts, so an ATS tenant subdomain is not a website', /function registrableLabel/.test(discC));
ok('the job-derived domains are ranked by postings, not alphabetically', /ORDER BY host_jobs DESC/.test(discC));
// ⚠️ The apex of a job board IS that company's own site — someone applying TO LinkedIn has one.
ok('⚠️ only a SUBDOMAIN of a job host is refused, never its apex', /host !== h && host\.endsWith\('\.' \+ h\)/.test(discC));
// ⚠️ q=xqzvnotacompany matched a tracked employer literally named "Company": pg_trgm's default 0.3
// threshold, similarity('company','xqzvnotacompany') = 0.333. A similarity floor cannot fix it —
// 'nordex'→'Nordeus' scores HIGHER (0.50) than the real typo 'nordx'→'Nordex' (0.44).
ok('⚠️ a trigram-only match must be a genuine typo, measured as edit distance', /function isTypoOf/.test(discC));
ok('⚠️ a name made only of generic words is not searchable', /function hasCoreName/.test(discC));
// ⚠️ ...and the first version of that read an Arabic name as "only generic words" and dropped the Oman
// Ministry of Labour (mol.gov.om) from its own search.
ok('⚠️ a name in a script the tokeniser cannot read still passes', /aliasKeysOf\(s\)\.size === 0\)\) return true/.test(discC));
ok('⚠️ a different company that shares a word is not marked unverified', /function strictName/.test(discC));

// ⚠️ The lookup strips a legal form before asking Clearbit, but the ranking compared hits against the RAW
// query — so for "Novo Nordisk A/S" the real Novo Nordisk matched as nothing, sat in the bottom tier beside
// the junk, and "Namn — novonordisk-utbildningar.se" came back FIRST. Measured on production.
ok('⚠️ web results are ranked against the name the lookup searched for, not the raw query',
  /const core = coreOf\(q\);/.test(discC) && /sameName\(h\.name, core\)/.test(discC) && /function coreOf/.test(discC));

console.log('── ⚠️ ONE LIST OF JOB HOSTS, IN TWO PLACES, THAT MUST NOT DRIFT ──');
// The app keeps verbatim copies because it cannot import server code. The first copy was missing ~25 hosts
// and accepted a pasted web103.reachmee.com link as an employer's website that the server rejected.
for (const name of ['AGGREGATOR_HOSTS', 'ATS_HOSTS']) {
  const server = listOf(resolverSrc, name);
  const client = listOf(sheetSrc, name);
  const missing = server && client ? server.filter((h) => !client.includes(h)) : ['(list not found)'];
  const extra = server && client ? client.filter((h) => !server.includes(h)) : [];
  ok(`⚠️ the app's ${name} matches the server's exactly`, !missing.length && !extra.length, { missing, extra });
}
// ⚠️ A denylist of posting URL shapes is always one job board behind: the first one passed
// glassdoor.com/job-listing/… and jobs.ch/en/vacancies/detail/123/ as "the employer's website".
ok('⚠️ on a job board, only the board\'s own pages are allowed — an allowlist, not a denylist',
  /BOARD_SELF_PATH/.test(sheetC) && !/POSTING_PATH/.test(sheetC));
{
  const selfPath = new RegExp((sheetSrc.match(/const BOARD_SELF_PATH = \/(.*)\/;/) || [])[1] || '^$');
  const jobQuery = new RegExp((sheetSrc.match(/const JOB_QUERY = \/(.*)\/i;/) || [])[1] || '^$', 'i');
  ok('…the bare board and /about are its own site', selfPath.test('') && selfPath.test('/about') && selfPath.test('/en/'));
  // ⚠️ linkedin.com/company/nordex is NORDEX's page; taking it as LinkedIn's website is the same mistake.
  ok('…a posting OR another company\'s page on the board is not',
    !selfPath.test('/job-listing/senior-engineer-JV_IC123.htm') && !selfPath.test('/en/vacancies/detail/123/')
    && !selfPath.test('/company/nordex'));
  ok('…and a job key anywhere in the query is caught, prefixed or not', jobQuery.test('?vjk=0123') && jobQuery.test('?jk=1'));
}

console.log('── ⚠️ ADDING AN EMPLOYER ON HOME: FREE, AND IT CANNOT RENAME ANYONE ELSE\'S ──');
const trackFn = fnBody(aiHubC, 'trackEmployer');
ok('there is a free tracking endpoint', /router\.post\('\/employers\/track'/.test(R('../../server/routes/aiHub.js')) && trackFn.length > 200);
ok('⚠️ tracking never starts the paid scrape pipeline', !/processJobSearch|createJob/.test(trackFn));
// ⚠️ jobService.upsertEmployer does ON CONFLICT (domain) DO UPDATE SET name = EXCLUDED.name: reused for a
// user-typed name, ANY signed-in user could rename a real employer for EVERY user — and it stamps
// last_scraped_at, so the 24h cache would serve that employer's stale jobs to the next searcher.
ok('⚠️ …and never calls the upsert that renames a shared employer', !/upsertEmployer/.test(trackFn));
ok('⚠️ the write is insert-if-absent', /ON CONFLICT \(domain\) DO NOTHING/.test(jobSvcC));
ok('⚠️ a user-added row never looks freshly scraped', /last_scraped_at/.test(jobSvcC));
ok('⚠️ a job board or ATS host is not an employer identity', /websiteOf\(/.test(trackFn));
// ⚠️ PRIVACY: a user-created row is exactly one whose last_scraped_at IS NULL. It used to appear in EVERY
// user's name search — anyone could publish "Siemens → evil-example.com" to everybody.
ok('⚠️ a user-added employer is visible in search only to users who track it',
  /last_scraped_at IS NOT NULL\s*OR EXISTS \(SELECT 1 FROM user_tracked_employers/.test(discC));
ok('⚠️ the watching cap is enforced under a lock, not read-then-write', /pg_advisory_xact_lock/.test(jobSvcC));
ok('⚠️ shared-table growth is bounded per day, not only per watching slot', /TRACK_MAX_INSERTS_PER_DAY = \d+/.test(aiHubC));
// Production, 2026-09-11: median watching = 1, p90 = 2, largest non-founder = 6; the only account over 60 is the
// founder's test account (258, via the Jobs tab, which has no cap). Admins skip the WATCHING cap only.
ok('⚠️ admins skip the watching cap — and ONLY that cap',
  /maxWatching: admin \? Infinity : TRACK_MAX_WATCHING, maxInsertsPerDay: TRACK_MAX_INSERTS_PER_DAY/.test(aiHubC));

console.log('── ⚠️ A BUILD STARTS ON ITS OWN ONLY WHEN SOMETHING THAT IS NOT CREDITS PAYS ──');
// The user's standing rule (the letters auto-regen incident): never charge silently. Home asks a dry-run gate
// first. ⚠️ Since 2026-09-13 the server has no credits lane for a resume or a letter at all (canConsumeMany
// answers quota_exhausted — pinned in server/scripts/test-free-plan-entitlements.js); these client checks stay
// as the second fence, so an older or misconfigured server that still says 'credits' is asked about, never
// auto-built.
ok('there is a dry-run gate the build is checked against', /router\.post\('\/generation-gate'/.test(routes));
ok('⚠️ the gate knows the per-employer cache, so a resume already paid for is never paywalled',
  /via: 'cache'|via:'cache'/.test(ctl));
// ⚠️ The gate is a snapshot seconds before the build and canConsumeMany does not reserve, so the last plan
// unit can go in between. coveredOnly makes the SERVER refuse the credits lane rather than fall into it.
ok('⚠️ an auto-started build cannot fall through to credits', /const coveredOnly = !!\(req\.body && req\.body\.coveredOnly === true\)/.test(ctl));
ok('…re-asked at the moment of payment, because the AI minute sits in between', /lost its cover during the run/.test(ctl));
// ⚠️ RETARGETED 2026-09-14. There is no credits lane for a resume or a letter any more, so nothing on Home may
// consent to a credit charge: a gate that still says 'credits' gets the plan-words dialog and its Build goes out
// coveredOnly:TRUE (plan, free allowance, pass or cache — or a refusal into the plans state). coveredOnly:false is
// sent from exactly two places, both for the UNREAD gate: that dialog's Build, and a queued build carrying that
// same "go ahead without a gate answer" (consentCovers), which never covers a credits answer.
{
  const falses = kHookC.match(/runBuild\((?:[^()]|\([^()]*\))*?, false,/g) || [];
  ok('⚠️ a credits answer is never consented to — its Build is covered-only; only an unread gate\'s Build sends false',
    /text: 'Build',[\s\S]{0,400}if \(credits\) runBuild\(latest\(\), 'credits', true,/.test(kHookC)
    && /else runBuild\(latest\(\), 'unknown', false,/.test(kHookC)
    && falses.length === 2 && falses.every((c) => /'unknown', false,$/.test(c))
    && !/runBuild\([^;]*'credits', false/.test(kHookC)
    && /if \(consentCovers\(q\.consent, gate\)\) \{[\s\S]{0,200}runBuild\(job, 'unknown', false,/.test(kHookC)
    && /if \(gate\.via === 'credits'\) return false;/.test(fnBodyOf(kHookC, 'consentCovers')), falses);
  // ⚠️ AND NO USER SEES THE WORD. Every string literal the hook can show (Alert titles, messages, buttons, notices,
  // GATE_COPY) is checked; the bare 'credits' tag is a gate value compared in code, never shown.
  const lits = [...kHookC.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0]);
  const worded = lits.filter((l) => /credit/i.test(l) && l !== "'credits'");
  ok('⚠️ no credits wording in anything useHomeBuilds can show (the \'credits\' gate value only)', lits.length > 30 && worded.length === 0, worded);
}
// ⚠️ RETARGETED 2026-09-14: the request path used to read `if (gate.covered) { runBuild(final, gate.via, true, …` —
// every covered answer started at once. Now ONLY a cache hit (free) starts without a question; plan / free / pass go
// to the confirm sheet, whose Continue is the one runBuild for them (behaviour: test-home-builds.js 1, C1-C28).
ok('⚠️ an unknown gate answer asks first, never auto-builds',
  /gate\.reason === 'unknown'/.test(kHookC) && /runBuild\(latest\(\), 'unknown', false,/.test(kHookC)
  && /if \(gate\.covered && gate\.via === 'cache'\) \{ runBuild\(final, gate\.via, true,/.test(kHookC)
  && !/if \(gate\.covered\) \{ runBuild\(/.test(kHookC));
{
  // ⚠️ THE ONLY runBuild CALLS: a cache hit (request + drain), a Continue already tapped for the SAME pool (drain),
  // the unread-gate dialog's two sends, the sheet's Continue, and Generate once's landing on 'cache' | 'pass'.
  const calls = (kHookC.match(/runBuild\((?:[^()]|\([^()]*\))*?,/g) || []).filter((c) => !/^runBuild\(\s*final: HomeBuildJob/.test(c));
  const body = (n) => fnBodyOf(kHookC, n);
  ok('⚠️ covered answers never auto-start: every runBuild site is a cache hit, an answered question, or the pass just bought',
    calls.length === 8
    && /if \(gate\.covered && confirmedCovers\(q\.consent, gate\.via\)\)/.test(body('drain'))
    && /runBuild\(job, pool, true, \{ show: a\.show, consent: \{ via: 'confirmed', pool \}/.test(body('sheetContinue'))
    && /if \(gate\.covered && \(gate\.via === 'cache' \|\| gate\.via === 'pass'\)\) \{\s*closeSheet\(id\);[\s\S]{0,160}runBuild\(job, gate\.via, true,/.test(kHookC)
    && /c\.pool === via/.test(body('confirmedCovers')) && /via !== 'cache'/.test(body('confirmedCovers')), calls);
  ok('⚠️ Generate once buys the pass for THIS employer, and only on a gate that still says nothing is left',
    /buyDownloadPass\(a0\.job\.company\)/.test(body('sheetBuyOnce'))
    && /pre\.gate\.covered === false && pre\.gate\.via === null && pre\.gate\.reason === 'quota_exhausted'/.test(body('sheetBuyOnce'))
    && (kHookC.match(/buyDownloadPass\(/g) || []).length === 1);
  ok('the hook exposes the sheet (contract 5)', /confirm: ConfirmSheetView;/.test(kHookC)
    && /onContinue: \(\) => sheetContinue\(id\)/.test(kHookC) && /onBuyOnce: \(\) => \{ sheetBuyOnce\(id\)/.test(kHookC));
}

console.log('── ⚠️ ONE BUILD, ONE CHARGE — ACROSS A LOST RESPONSE AND A RETRY ──');
// A dropped connection just after the server created the job left it running and charging while the app
// said 'network'; Try again then charged a second time.
ok('⚠️ the app sends an idempotency key, persisted BEFORE the request', /clientBuildId/.test(addSvcC) && /writeInflight\(/.test(addSvcC));
ok('⚠️ the server dedupes on it, surviving a restart', /clientBuildId/.test(asyncJobSrc) && /input->>'clientBuildId'/.test(asyncJobSrc));
ok('⚠️ a polling deadline is "pending", which never offers a rebuild', /'pending'/.test(addSvcC) && /case 'pending':/.test(overlaySrc));
// ⚠️ 'charged' used to be read off consumeOnSuccess's { via: 'credits' }, which is what was ATTEMPTED:
// chargeCredits returns { charged:false, insufficient:true } on a short balance WITHOUT throwing. A cache
// write for a build nobody paid for is a permanent free resume.
ok('⚠️ a build counts as charged only by what was actually deducted', /creditsDeductedSince\(/.test(ctl));
ok('⚠️ the cache is written only for a build someone paid for', /if \(passEmployer && cacheFp && charged\)/.test(ctl));
// ⚠️ AND THE DOC LANE ASKS ITS OWN CHARGE, NOT A HISTORY WINDOW. "Did credits move since I started?" sees
// ANOTHER build's deduction (or misses this one), so a resume the user really paid for was thrown away
// with no refund. consumeOnSuccess hands back the chargeCredits result and the ledger row it wrote.
{
  const docLane = ctl.slice(ctl.indexOf('async function generateEmployerDoc'), ctl.indexOf('async function generationGate'));
  ok('⚠️ the employer-doc lane decides from THIS request\'s own charge, never from a credits window',
    /used\.charge/.test(docLane) && !/await creditsDeductedSince\(/.test(docLane));
  ok('⚠️ …and every charge it took goes back when it cannot deliver the document',
    /giveBackDocCharges\(userId, paid, 'the paid document could not be stored'\)/.test(docLane)
    && /docId = \(await employerDocs\.put\(doc\)\) \|\| \(await employerDocs\.put\(doc\)\);/.test(docLane));
}
// ⚠️ A BUILD THE USER WAS TOLD HAD FAILED MUST NOT BE RE-SENT BEHIND THEIR BACK. A record with no jobId is
// a POST whose answer was lost; resending it can start and charge a build they walked away from.
ok('⚠️ recovery resends a lost POST only for the build an explicit Try again named',
  /if \(r\.key !== resendKey \|\| late\) \{/.test(addSvcC) && /resendKey\?: string \| null;/.test(addSvcC)
  && /const resendKey = typeof opts\.resendKey === 'string' && opts\.resendKey \? opts\.resendKey : null;/.test(addSvcC));
ok('⚠️ …and removing the chip drops it for good, without touching the running job on the server',
  /export async function forgetInflight\(key: string\): Promise<void>/.test(addSvcC)
  && /const next = list\.filter\(\(r\) => r\.key !== k\);/.test(addSvcC)
  && !/forgetInflight[\s\S]{0,600}?call\(`\/job/.test(addSvcC));
// ⚠️ EACH BUILD LANDS WHEN IT ENDS, not when the slowest one in the batch does.
ok('⚠️ recovery announces each build as it settles (onLanded), not only at the end',
  /onLanded\?: \(key: string, meta: InflightMeta, result: BuildResult\) => void;/.test(addSvcC)
  && /opts\.onLanded\(x\.key, x\.meta, asResult\(x\.outcome\)\)/.test(addSvcC));
// ⚠️ THE PREVIOUS ACCOUNT'S BUILDS MUST NOT HOLD THE NEW ACCOUNT'S THREE SLOTS.
ok('⚠️ the parallel-build cap counts only the signed-in account\'s flights',
  /flights\.forEach\(\(f\) => \{ if \(ownedNow\(f\)\) n\+\+; \}\)/.test(addSvcC)
  && /flights\.forEach\(\(g\) => \{ if \(ownedBy\(g, ctx\.account\)\) mine\+\+; \}\)/.test(addSvcC));
// ⚠️ TWO URLS, TWO JOBS. jobUrl is the document's IDENTITY ('' = the employer's own doc); the pasted
// posting link is build INPUT. Sent as one, the build stored a posting document no chip ever asks for
// and the chip went on offering a paid build for a resume the user had already bought.
ok('⚠️ the build sends the identity (docJobUrl) and the posting (job.url) as two different fields',
  /const docJobUrl = i\.jobUrl \|\| '';/.test(addSvcC)
  && (addSvcC.match(/\bdocJobUrl,/g) || []).length >= 2
  && /jobFields\(\{ title: i\.jobTitle, url: i\.postingUrl \|\| i\.jobUrl,/.test(addSvcC));
ok('…and the GATE is read for the same job the build will send', /export const gateJobFor = [\s\S]{0,300}?i\.postingUrl \|\| i\.jobUrl/.test(addSvcC));
ok('⚠️ the resume is saved only AFTER payment is settled',
  ctl.indexOf('lost its cover during the run') > 0 && ctl.indexOf('lost its cover during the run') < ctl.indexOf('await saveResumeRow(userId, resumeData'));
// ⚠️ The same read-then-subtract bug fixed at four aiHubController sites lived on in chargeCredits.
ok('⚠️ chargeCredits is one guarded statement', /WHERE user_id = \? AND credits_remaining >= \? RETURNING credits_remaining/.test(costsC)
  && !/SELECT credits_remaining FROM user_credits WHERE user_id = \?', \[userId\]\);\s*const remaining/.test(costsC));

console.log('── ⚠️ TAILORING STARTS FROM YOUR RESUME, NOT FROM THE LAST EMPLOYER\'S ──');
// user_resumes is ONE row per user and every build overwrites it; a rebuild's source text was read from that
// row — so Siemens' resume was written from the Nordex-tailored one, and tailoring compounded.
ok('⚠️ the base is snapshotted before a tailored build overwrites it', /await snapshotBaseBeforeTailoring\(userId, env\)/.test(ctl));
ok('…and the build asks for the BASE text', /source-text\?base=1/.test(addSvcSrc));
ok('⚠️ a company website is context, never scraped in as a "posting"', !/url: [a-z.]*website/i.test(addSvcC));

console.log('── ⚠️ NOTHING OF ONE ACCOUNT SURVIVES INTO THE NEXT ──');
// App.js logout resets React state but never reloads the bundle, so module state AND AsyncStorage outlive a
// sign-out: the next account saw the previous account's employers leading its row.
ok('⚠️ one account identity, defined once', /export async function signedInAccount/.test(addSvcC) && !/async function signedInAccount/.test(homeC));
ok('⚠️ the in-flight build record belongs to an account', /j\.account !== me/.test(addSvcC) && /\{ \.\.\.v, account \}/.test(addSvcC));
// ⚠️ A BUILD IN FLIGHT ACROSS A SIGN-OUT SENT ACCOUNT A'S RÉSUMÉ UNDER ACCOUNT B'S SESSION, and stamped
// the record as B's. The flight captures its account (and its token) once, at the start, and every send,
// poll and write checks it is still the signed-in one — otherwise it fails, leaving the record with A.
ok('⚠️ a flight captures its account once and is bound to it for every call',
  /f\.account = f\.ctx\.then\(\(s\) => \{ f\.owner = s\.account; return s\.account; \}\);/.test(addSvcC)
  && /const t = ctx \? ctx\.tok : await token\(\);/.test(addSvcC)
  && /async function stillSignedIn\(ctx: Session\): Promise<boolean> \{\s*return \(await readSession\(\)\)\.account === ctx\.account;/.test(addSvcC));
ok('…so a send or a write after a switch is refused, not re-stamped',
  (addSvcC.match(/if \(!\(await stillSignedIn\(ctx\)\)\) return SWITCHED\(kind\);/g) || []).length >= 2
  && /if \(!\(await writeInflight\(entry, ctx\.account\)\)\) return SWITCHED\(kind\);/.test(addSvcC));

console.log('── the overlay never claims a paid build failed ──');
ok('"refresh" is a built resume whose pages did not reload', /case 'refresh':/.test(overlaySrc));
// "That build didn't finish" is allowed for the KNOWN 'failed' reason only: once the polling deadline moved to
// 'pending' (A5), 'failed' means the server reported a real failure. What must be neutral is the fallback.
{
  const dflt = (overlaySrc.match(/default:\s*[\s\S]{0,260}?title:\s*("[^"]*"|'[^']*')/) || [])[1] || '';
  ok('⚠️ a reason it does not recognise gets a neutral title', /couldn.t confirm/i.test(dflt) && !/didn.t finish|failed/i.test(dflt), dflt);
  ok('…and "didn\'t finish" is never said for a build that may still be running',
    !/case 'pending':[\s\S]{0,300}didn.t finish/.test(overlaySrc));
}
// ⚠️ RETARGETED. There is no page signature to compare any more: a build lands by the docId the server
// reports for the document it stored (or found), so a recovered build needs no "before" at all.
ok('⚠️ a build lands by the document it reports, never by comparing page pixels',
  /typeof r\.docId === 'number'/.test(kHookC) && /function landRecovered/.test(kHookC)
  && !/cardsSig/.test(homeC) && !/sigBefore/.test(homeC));
// ⚠️ RETARGETED. A refused website comes off the chip AND the job the build is sent (both spelled from
// docLookupOf), and a copy already waiting in the queue is rewritten by retarget.
ok('⚠️ a queued build does not keep a website the server refused',
  /const refused: Target = \{ \.\.\.pending, website: '' \}/.test(homeC)
  && /const next: HomeBuildJob = \{ \.\.\.q\.job, \.\.\.fields \}/.test(kHookC));
ok('⚠️ every overlay animation is native-driver', !/useNativeDriver: false/.test(overlaySrc));
ok('the chip row does not re-attach animations on every progress tick',
  /export const EmployerChip = React\.memo\(/.test(chipC) && /import EmployerChip from '\.\/EmployerChip'/.test(homeC)
  && !/function EmployerChip/.test(homeC));

console.log('── the preview harness can still see the whole screen ──');
const previewSrc = R('../app/(dev)/home-preview.tsx');
ok('the library has a fixture, or it renders empty in the only way to look at this',
  /history: async \(kind\)/.test(previewSrc));
ok('…including a LOCKED row, which is the state worth looking at', /unlocked: false/.test(previewSrc));
ok('…and the profile-setup fixture that arms the CTA', /setup: async \(\)/.test(previewSrc));
ok('⚠️ the fixture is time-STABLE, or a visual diff of this screen is worthless',
  /const T0 = Date\.parse/.test(previewSrc) && !/downloadedAt: new Date\(\)\.toISOString/.test(previewSrc));

console.log('── ⚠️ a page is read from the top, so the crop comes off the BOTTOM ──');
ok('the carousel page is top-anchored', /contentFit="cover" contentPosition="top"/.test(carC));
ok('the opened page is too', /contentFit="cover" contentPosition="top"/.test(strip(zoomSrc)));
ok('…and the library thumbnails', /contentFit="cover"\s+contentPosition="top"/.test(histC));
ok('no cover-fitted resume image is left centred',
  !/contentFit="cover"(?!\s+contentPosition="top")/.test(carC + strip(zoomSrc) + homeC + histC));
ok('the preview contains pages TALLER than the card, or this could never be seen',
  /function paper\(accent: string, shape: Shape, tall = false\)/.test(prevC) && /tall \? 760 : 424/.test(prevC));

// ── Round 7 (2026-09-11): each employer gets its OWN resume and letter, saved and shown from the DB ─────
// The user's asks: the Add pill on the label row; a chip named by the name they PICKED (not the shared
// row's "Souq.com for E-Commerce LLC"); an X that removes a chip softly; switching chips shows THAT
// employer's document at once; background builds visible on the cards; ranked designs with a fit %.
// The behaviour of the build hook itself is exercised in test-home-builds.js; the server lanes in
// server/scripts/test-employer-doc-lane.js, test-employer-letter.js and test-employer-docs.js.

// The balanced `useEffect(` / `useFocusEffect(` calls of a source, so a rule can be checked per effect.
const effectsOf = (src) => {
  const out = [];
  const re = /\buse(?:Focus)?Effect\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
};

console.log('── the Add employer pill rides the label row, not the end of the chips ──');
{
  const rowStart = homeC.indexOf('<ScrollView ref={chipRowRef} horizontal');
  const rowEnd = homeC.indexOf('</ScrollView>', rowStart);
  const chipRow = rowStart > 0 ? homeC.slice(rowStart, rowEnd) : '';
  // The label and the pill both carry accessibility props now (numberOfLines / maxFontSizeMultiplier),
  // so pin WHERE they are, not the exact attribute list — the attributes get their own assertion below.
  const pillAt = homeC.search(/<Text style=\{s\.addPillTx\}[^>]*>Add employer<\/Text>/);
  ok('⚠️ the pill is OUTSIDE the chips ScrollView, after the "Designing for" label',
    rowStart > 0 && pillAt > 0 && pillAt < rowStart && homeC.indexOf('>Designing for<') < pillAt
    && !/Add employer/.test(chipRow) && !/chipAdd/.test(homeC), { rowStart, pillAt });
  ok('…label and pill share one row, pushed to the two ends', /forRow: \{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'/.test(homeC)
    && /<View style=\{s\.forRow\}>\s*<Text style=\{s\.eyebrowDark\}[^>]*>Designing for<\/Text>/.test(homeC));
  // ⚠️ AT FULL ACCESSIBILITY SCALE THE PILL WENT OFF A 320pt SCREEN — the thing the user came to do.
  // The quiet half (the label) gives way, the pill grows in HEIGHT not width, and its label is capped.
  ok('⚠️ …and at the largest text size the label gives way so the pill stays on screen',
    /eyebrowDark: \{ flexShrink: 1,/.test(homeC)
    && /<Text style=\{s\.eyebrowDark\} numberOfLines=\{1\}>Designing for<\/Text>/.test(homeC)
    && /addPill: \{\s*minHeight: 28,/.test(homeC) && !/addPill: \{[^}]*\bheight: 28\b/.test(homeC)
    && /<Text style=\{s\.addPillTx\} numberOfLines=\{1\} maxFontSizeMultiplier=\{1\.3\}>/.test(homeC));
  ok('…and the empty state keeps its own add prompt', /Add an employer to design your resume around/.test(homeC));
  ok('the chips are EmployerChip, told their kind, render key, saved-doc dot and exit',
    /<EmployerChip\s[\s\S]{0,500}kind=\{kind\}[\s\S]{0,200}rk=\{rk\}[\s\S]{0,200}hasDoc=\{[\s\S]{0,200}exiting=\{!!exiting\[rk\]\}/.test(chipRow)
    && /onRemove=\{onRemoveChip\}/.test(chipRow) && /onPick=\{onPickChip\}/.test(chipRow));
}

console.log('── the chip X: inside the chip, never a pick, and soft ──');
{
  ok('the X is a button labelled "Remove <company>"', /accessibilityLabel=\{`Remove \$\{t\.company\}`\}/.test(chipC) && /accessibilityRole="button"[\s\S]{0,80}accessibilityLabel=\{`Remove/.test(chipC));
  ok('…with a hit slop and the house icon', /hitSlop=\{REMOVE_SLOP\}/.test(chipC) && /<Ionicons name="close" size=\{12\} color="rgba\(255,255,255,0\.85\)" \/>/.test(chipC));
  // ⚠️ A UNIFORM hitSlop={10} REACHED INTO THE CONTENT AND REMOVED THE EMPLOYER ON A PICK.
  // The X's left edge is 5pt from the match pill / name (paddingRight 30 − right 5 − width 20), so the
  // slop must not reach left: left ≤ 3 keeps it off the content while top/bottom/right stay generous.
  {
    const slop = chipC.match(/const REMOVE_SLOP = \{ top: (\d+), right: (\d+), bottom: (\d+), left: (\d+) \}/);
    const gap = +((chipC.match(/paddingRight: (\d+)/) || [])[1] || 0) - +((chipC.match(/remove: \{\s*position: 'absolute', top: \d+, right: (\d+)/) || [])[1] || 0)
      - +((chipC.match(/remove: \{\s*position: 'absolute', top: \d+, right: \d+, width: (\d+)/) || [])[1] || 0);
    ok('⚠️ the slop is ASYMMETRIC: it never reaches left into the pill, so a pick is never a removal',
      !!slop && +slop[4] <= gap && +slop[4] <= 3 && +slop[1] >= 10 && +slop[3] >= 10 && +slop[2] >= 10 && !/hitSlop=\{10\}/.test(chipC),
      { slop: slop && slop.slice(1), gap });
  }
  // ⚠️ ANDROID Z-ORDER IS ELEVATION FIRST, SIBLING ORDER SECOND — for touch as well as for drawing.
  // The selected chip's own elevation 4 lifted it above its later-sibling X, so the X drew under the
  // chip and a tap on it went to onPick. The two overlays sit one step higher, shadowless.
  ok('⚠️ Android: the X and the glow outrank the selected chip\'s own elevation',
    /const ABOVE_CHIP_ANDROID = Platform\.select\(\{ android: \{ elevation: 5, shadowColor: 'transparent' \}/.test(chipC)
    && /remove: \{[\s\S]{0,320}?\.\.\.ABOVE_CHIP_ANDROID/.test(chipC)
    && /chipGlow: \{[\s\S]{0,320}?\.\.\.ABOVE_CHIP_ANDROID/.test(chipC)
    && +((chipC.match(/default: \{ elevation: (\d+) \}/) || [])[1] || 99) < 5);
  // ⚠️ A SIBLING of the chip's touchable, not a child: a press on the X must never reach onPick.
  const pickEnd = chipC.indexOf('</TouchableOpacity>');
  ok('⚠️ the X is a sibling of the chip\'s touchable, so pressing it can never pick the chip',
    pickEnd > 0 && chipC.indexOf('onPress={onPressRemove}') > pickEnd && chipC.indexOf('onPress={onPress}') < pickEnd);
  const rm = chipC.match(/remove: \{\s*position: 'absolute', top: (-?\d+), right: (-?\d+), width: (\d+), height: (\d+)/);
  const chipH = +((chipC.match(/chip: \{[\s\S]{0,300}?height: (\d+)/) || [])[1] || 0);
  ok('⚠️ no overhang: the 48pt row clips, so the X sits wholly inside the chip',
    !!rm && +rm[1] >= 0 && +rm[2] >= 0 && +rm[1] + +rm[4] <= chipH && chipH === 48 && +rm[3] >= 20 && +rm[3] <= 22, { rm: rm && rm.slice(1), chipH });
  ok('…in the glass the contract asks for', /backgroundColor: 'rgba\(255,255,255,0\.10\)', borderWidth: 1, borderColor: 'rgba\(255,255,255,0\.18\)'/.test(chipC));
  ok('…the name keeps its width because the chip makes room on the right', /paddingRight: 30/.test(chipC) && /maxWidth: 238/.test(chipC));
  ok('the glow is an inset, not a halo', /chipGlow: \{\s*position: 'absolute', top: 0, left: 0, right: 0, bottom: 0/.test(chipC));
  ok('the chip reads ITS build only, and the ticking % is an isolated memo child',
    /useTargetBuild\(kind, rk\)/.test(chipC) && /const ChipBuildLine = React\.memo\(/.test(chipC)
    && (chipC.match(/useCreepPct\(/g) || []).length === 1 && chipC.indexOf('useCreepPct(') > chipC.indexOf('const ChipBuildLine'));
  ok('queued, failed and a fresh landing each read differently', /'Queued'|>Queued</.test(chipC) && /Didn’t finish/.test(chipC) && /checkmark-circle/.test(chipC) && /DONE_FRESH_MS = 6000/.test(chipC));
  ok('the exit is its own native value on an outer view', /toValue: exiting \? 0 : 1, duration: 180/.test(chipC) && /pointerEvents=\{exiting \? 'none' : 'auto'\}/.test(chipC));

  ok('⚠️ removing is optimistic with an Undo, never a blocking dialog',
    /showNotice\(`Removed \$\{t\.company\}`, \{ label: 'Undo', run: \(\) => undoRemoval\(r\) \}, UNDO_MS\)/.test(homeC)
    && !/Alert\.alert\([^)]*Remove/.test(homeC));
  const removeFn = (homeC.match(/const removeChip = \(i: number\) => \{[\s\S]*?\n  \};/) || [''])[0];
  ok('⚠️ an employer chip is UNTRACKED (archived), a posting chip only HIDDEN — nothing is deleted',
    /untrackEmployer\(String\(t\.employerId\)\)/.test(removeFn) && /hideTarget\(t\.key\)/.test(removeFn) && !/DELETE|deleteDoc|fetch\(/.test(removeFn));
  ok('…a queued build for it is withdrawn for BOTH kinds, a running one is left to finish',
    /cancelQueued\('resume', rk\)/.test(removeFn) && /cancelQueued\('cover_letter', rk\)/.test(removeFn) && !/forgetHomeBuilds|clearBuild/.test(removeFn));
  ok('Undo tracks the employer again (or un-hides the posting), after the removal has settled',
    /r\.server\.then\(async \(removedThere\) =>/.test(homeC) && /unhideTarget\(back\.key\)/.test(homeC) && /trackEmployer\(\{ name: back\.company/.test(homeC));
  ok('removed chips stay gone across a stale load', /removedKeys/.test(homeC) && /REMOVED_HOLD_MS/.test(homeC));
}

console.log('── hidden chips and the name the user picked ──');
ok('fetchTargets asks for the hidden list in parallel and a failed read filters nothing',
  /getJson\('\/ai-hub\/home\/hidden-targets', 15000\)/.test(svcC)
  && /const hidden: Set<string> \| null = hiddenJ && Array\.isArray\(hiddenJ\.keys\)/.test(svcC) && /hiddenNow\(t\.key, hidden\)/.test(svcC));
ok('hide / unhide / untrack are the contract endpoints',
  /export async function hideTarget\(key: string\): Promise<boolean>/.test(svcC) && /sendJson\('POST', '\/ai-hub\/home\/hidden-targets'/.test(svcC)
  && /export async function unhideTarget\(key: string\): Promise<boolean>/.test(svcC) && /sendJson\('DELETE', '\/ai-hub\/home\/hidden-targets'/.test(svcC)
  && /export async function untrackEmployer\(employerId: string\): Promise<boolean>/.test(svcC) && /\/untrack/.test(svcC));
ok('a Target carries its country (it steers the design region)', /country\?: string \| null/.test(svcC));
ok('⚠️ the server\'s display name is what the added chip shows', /company: e\.name \|\| name/.test(homeC));
ok('⚠️ trackEmployer answers with the picked name; the dashboard shows it first',
  /const shownName = out\.displayName \|\| row\.name \|\| name;/.test(aiHubC) && /displayName: name/.test(aiHubC)
  && /ute\.display_name/.test(jobSvcC) && /\(emp\.display_name && String\(emp\.display_name\)\.trim\(\)\) \|\| emp\.name/.test(jobSvcC));
ok('⚠️ untrack archives, it never deletes', /status = 'archived'/.test(jobSvcC) && !/DELETE FROM user_tracked_employers/.test(aiHubC + jobSvcC)
  && /router\.post\('\/employers\/:employerId\/untrack', authenticateToken, untrackEmployer\)/.test(R('../../server/routes/aiHub.js')));

console.log('── ⚠️ ONE LOOKUP SPELLING: the build finds the document the chip looks up ──');
ok('docLookupOf is the one Target → lookup conversion', /export function docLookupOf\(t: Target\): DocLookup/.test(docSvcC));
ok('…posting chips by their URL, employer chips by an empty job_url', /const posting = String\(t\.key \|\| ''\)\.startsWith\('job_'\);/.test(docSvcC)
  && /const jobUrl = posting \? String\(t\.applyUrl \|\| t\.jobUrl \|\| ''\)\.trim\(\) : '';/.test(docSvcC));
ok('⚠️ useTargetDoc looks a chip up through it', /const q: DocLookup \| null = target \? docLookupOf\(target\) : null;/.test(docHookC));
ok('⚠️ …and the job Home sends to a build is spelled from it and nothing else',
  /function jobFor\(t: Target, kind: DocKind\): HomeBuildJob \{\s*const q = docLookupOf\(t\);/.test(homeC)
  && (homeC.match(/K(?:Ref\.current)?\.request\(/g) || []).length >= 1
  && [...homeC.matchAll(/\.request\(([^,]+),/g)].every((m) => /jobFor\(|^job$/.test(m[1].trim())));
ok('…the matcher for the saved-doc dots uses the same URL rule', /String\(docLookupOf\(t\)\.jobUrl \|\| ''\)/.test(docSvcC));
ok('the saved-document cache is wiped with the account', /forgetDocs\(\);\s*forgetHomeBuilds\(\);/.test(homeC));
ok('the doc list and the chip document come from the contract endpoints',
  /'\/employer-docs\/current', \{ method: 'POST'/.test(docSvcC) && /`\/employer-docs\?kind=\$\{encodeURIComponent\(kind\)\}`/.test(docSvcC)
  && /kind === 'cover_letter' \? `\/cover-letter\/employer-cards\?\$\{q\}` : `\/resume-builder\/home-cards\?\$\{q\}`/.test(docSvcC)
  && /`\/employer-docs\/\$\{id\}`, \{ method: 'PUT', body: \{ payload \}/.test(docSvcC));
ok('⚠️ a lookup that could not answer is an error, never "nothing saved" (no Tailor offered on a blip)',
  /const wantsAction = !!target && !doc && docState === 'none'/.test(homeC));

console.log('── ⚠️ NO BUILD STARTS FROM A FOCUS, A SWITCH OR A MOUNT ──');
{
  const homeEffects = effectsOf(homeC);
  ok('Home has effects to check', homeEffects.length >= 8, homeEffects.length);
  const starting = homeEffects.filter((e) => /\.request\(|buildForEmployer\(|generate-ai|employer-build|requestBuild\(|runBuild\(/.test(e));
  ok('⚠️ no Home effect (focus, mount, chip switch) requests or runs a build', starting.length === 0, starting.map((e) => e.slice(0, 120)));
  ok('⚠️ Home never generates a cover letter itself', !/generate-cover-letter/.test(homeC) && !/employer-build/.test(homeC));
  ok('the gate hint is a debounced DRY RUN, never a build', /checkBuildGate\(job\.company, gateJobFor\(job\), job\.kind/.test(homeC)
    && homeEffects.some((e) => /checkBuildGate\(/.test(e) && /, 400\)/.test(e) && !/\.request\(/.test(e)));
  ok('every build request from Home is an explicit one', [...homeC.matchAll(/\.request\([^;]*?\{ explicit: true/g)].length === (homeC.match(/\.request\(/g) || []).length);
  const kEffects = effectsOf(kHookC);
  const mount = kEffects.find((e) => /recoverAll\(\)/.test(e)) || '';
  ok('⚠️ the hook\'s mount only RECOVERS builds already paid for (and re-gates explicit queued ones)',
    !!mount && /recoverAll\(\)/.test(mount) && !/requestBuild\(|beginRequest\(|runBuild\(/.test(mount)
    && kEffects.every((e) => e === mount || !/requestBuild\(|beginRequest\(|runBuild\(|buildForEmployer\(/.test(e)));
  ok('…recovery goes through resumeInflightBuilds', /await resumeInflightBuilds\(/.test(kHookC));
  ok('⚠️ requestBuild refuses anything not explicit', /if \(!job \|\| !how \|\| how\.explicit !== true\) return;/.test(kHookC));
  ok('the doc hooks never build or charge', !/buildForEmployer|checkBuildGate|request\(|generate/.test(docHookC));
}

console.log('── background builds on the cards, and a fit % on the ranked deck ──');
ok('the carousel\'s building state is a memo BuildingPct over an isolated PctNumber',
  /const BuildingPct = React\.memo\(/.test(carC) && /const PctNumber = React\.memo\(/.test(carC)
  && (carC.match(/useCreepPct\(/g) || []).length === 1 && carC.indexOf('useCreepPct(') > carC.indexOf('const PctNumber')
  && /useTargetBuild\(kind, rk\)/.test(carC));
ok('…every card draws the writing loop while building, and says "Tap to watch"',
  /state=\{bld \? 'writing' :/.test(carC) && /Tap to watch/.test(carC) && /export type PaperState = 'loading' \| 'queued' \| 'idle' \| 'writing'/.test(skelC));
ok('⚠️ a building card opens the build, never the zoom', /if \(building\) \{ onOpenBuilding\?\.\(\); return; \}/.test(carC));
ok('the card is memoised', /const Card = React\.memo\(function Card/.test(carC));
ok('fit pills: mint ≥ 85, blue 70-84, muted below; "Best match" on the first',
  /if \(fit >= 85\) return E\.mint;/.test(carC) && /if \(fit >= 70\) return/.test(carC) && /\{fit\}% fit/.test(carC) && /Best match/.test(carC)
  && /const best = !!showFit && !building && i === 0 && card\.fit != null;/.test(carC));
// ⚠️ "BEST MATCH" IS A CLAIM, AND NOTHING HAD MEASURED IT ON AN UNRANKED DECK. A saved doc with no
// fit still has a first card; the pill said it was the best of a deck that was never ranked, and with
// no fit pill beside it the lone best pill sat over the ribbon. It rides `card.fit != null` now, which
// keeps the ribbon's FIT_CLEAR cap honest (the cap only applies when something really is up there).
ok('⚠️ "Best match" never appears on a deck that was never ranked',
  /const best = [^;]*card\.fit != null;/.test(carC)
  && /const fit = showFit && !building && card\.fit != null \?/.test(carC)
  && /\(fit != null \|\| best\) && \{ maxWidth: m\.w - 16 - FIT_CLEAR \}/.test(carC));
ok('Home passes the building identity and the fit switch', /building=\{buildingProp\}/.test(homeC) && /onOpenBuilding=\{openBuilding\}/.test(homeC) && /showFit=\{shown\.fit\}/.test(homeC));
ok('⚠️ no ticking percentage lives in EmployerHome', !/useCreepPct\(/.test(homeC) && !/useTargetBuild\(/.test(homeC));
ok('the persistent build notice says how to watch', /Building your \{company\} \{nounOf\(kind\)\} · tap its card to watch/.test(homeC));
ok('with a doc the caption says the design, its fit and the employer', /`\$\{card\.fit\}% fit for \$\{target\?\.company \|\| doc\.employer\}`/.test(homeC) && /doc\.design\.headline/.test(homeC));
ok('a chip with nothing saved offers ONE explicit action per mode',
  /label=\{`Tailor my resume for \$\{target\.company\}`\}/.test(homeC) && /`Write my cover letter for \$\{target\.company\}`/.test(homeC));
ok('a stale document offers Refresh, and only as a tap', /changed since this version · <Text style=\{s\.docPillAct\}>Refresh<\/Text>/.test(homeC) && /onPress=\{\(\) => requestBuild\('refresh'\)\}/.test(homeC));
ok('the overlay is driven by the hook, with its kind', /<BuildingOverlay[\s\S]{0,400}kind=\{K\.overlay\.kind\}/.test(homeC));
ok('the overlay speaks letters too, and "checking" has not started anything',
  /AI COVER LETTER WRITER/.test(overlaySrc) && /Nothing has started yet\./.test(overlaySrc) && /Watch it any time — tap its card on Home\./.test(overlaySrc) && /useCreepPct\(/.test(overlayC));
ok('the zoom routes a saved resume to the editor and the gallery WITH its docId',
  /pathname: '\/\(resume-builder\)\/preview', params: \{ docId:/.test(homeC) && /pathname: '\/\(cover-letter\)\/templates'/.test(homeC));

console.log('── ⚠️ one driver per tree, in EVERY employer-home file ──');
{
  const dir = path.join(__dirname, '../components/employer-home');
  const files = fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f));
  ok('the directory has the new files', ['EmployerChip.tsx', 'useHomeBuilds.ts', 'useTargetDoc.ts'].every((f) => files.includes(f)), files);
  for (const f of files) ok(`${f}: no useNativeDriver: false`, !/useNativeDriver:\s*false/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  ok('the hooks own no Animated values at all', !/Animated/.test(kHookC) && !/Animated/.test(docHookC) && !/Animated/.test(buildsC));
  ok('the build store re-renders a component only for ITS record', /useSyncExternalStore\(subscribeBuilds, snapshot, snapshot\)/.test(buildsC));
}

console.log('── ⚠️ RE-ADDING AN EMPLOYER YOU REMOVED IS A RESTORE, NOT A SECOND PURCHASE ──');
{
  // Removing a POSTING chip hid it and its saved document with it. Re-adding the employer looked only for
  // the employer-level document (job_url ''), found nothing, and started a paid build — for a resume the
  // user had already bought, which then reappeared as a duplicate chip.
  const restore = fnBodyOf(homeC, 'restorePostings');
  ok('a re-add reads the SAVED LIST and un-hides the postings that have documents',
    !!restore && /docLoadersRef\.current\?\.list \|\| fetchDocList/.test(restore)
    && /!!String\(d\.jobUrl \|\| ''\)\.trim\(\)/.test(restore)
    && /unhideTarget\(key\)/.test(restore), restore && restore.slice(0, 80));
  ok('⚠️ …only chips this user actually hid (a server that will not say is not "none")',
    /const server = loaders \? null : await fetchHiddenKeys\(\)\.catch\(\(\) => null\);/.test(restore)
    && /const hidden = new Set\(server \|\| \[\.\.\.removedKeys\.keys\(\)\]\.filter\(removedNow\)\);/.test(restore));
  ok('⚠️ …named with jobKeyForUrl, the one spelling fetchTargets gives a posting chip',
    /const key = jobKeyForUrl\(d\.jobUrl\);/.test(restore)
    && /export const jobKeyForUrl = \(url: string\): string =>/.test(svcC)
    && /return 'job_' \+ \(cleanJobUrl\(raw\) \|\| raw\);/.test(svcC));
  ok('⚠️ …and NOTHING on that path spends anything: a list read, an un-hide, a reload',
    !/request\(|checkBuildGate|buildForEmployer|generate/.test(restore));
  // The add chain: employer-level lookup first (that one belongs to the chip already on screen), then the
  // restore, and only a restore that found NOTHING falls through to a build.
  const add = fnBodyOf(homeC, 'addEmployerHere') || homeC;
  ok('⚠️ the restore runs BEFORE any build, and standing it down means no gate is even read',
    /restored = await restorePostings\(real, k\);/.test(add)
    && add.indexOf('restorePostings(real, k)') < add.indexOf('return jobFor(real, k);')
    && /if \(restored \|\| !alive\.current/.test(add)
    && /if \(!final \|\| !gate\) \{[\s\S]{0,120}standDown\(\)/.test(kHookC));
}

console.log('── ⚠️ THE UNDO IS THE ONLY WAY BACK, SO NOTHING MAY TAKE IT OFF THE SCREEN ──');
{
  // A background build notice ("Your Amazon resume is ready") replaced the "Removed X · Undo" line inside
  // its 5s window, and the only way back was gone.
  const show = fnBodyOf(homeC, 'showNotice');
  ok('a non-Undo notice QUEUES behind a live Undo instead of replacing it',
    !!show && /if \(cur && isUndo\(cur\) && !isUndo\(n\) && Date\.now\(\) - cur\.shownAt < cur\.ms\)/.test(show)
    && /noticeQueue\.current = \[\.\.\.noticeQueue\.current\.filter\(\(q\) => q\.text !== text\), n\]\.slice\(-4\)/.test(show));
  ok('⚠️ …a newer Undo still wins (the latest removal is the one you can take back)',
    !!show && /!isUndo\(n\)/.test(show) && /putNotice\(n\);\s*return n\.id;/.test(show));
  ok('…and a queued notice that waited too long is dropped, never shown stale',
    /if \(now - q\.at <= q\.maxWait\) \{ next = q; break; \}/.test(homeC) && /const NOTICE_WAIT_MS = \d+;/.test(homeC));
  ok('⚠️ answering a removal drains the queue rather than wiping the line',
    /dismissNotice\(r\.noticeId\)/.test(homeC) && !/setNotice\(null\)/.test(homeC));
  ok('⚠️ a refused session leaves no tappable Undo for the account that just went',
    /clearNotices\(\)/.test(fnBodyOf(homeC, 'dropAccountOnAuth') || ''));
}

console.log('── ⚠️ A CHIP WHOSE BUILD JUST LANDED IS NOT AN EMPTY CHIP ──');
{
  // Between onLanded and the lookup answering, the chip offered "Tailor my resume" / "Write my cover
  // letter" again — a second paid build for the document that had just been paid for and stored.
  ok('the landing is held until the document arrives, or for a bounded wait',
    /markLanded\(storeKeyOf\(job\.kind, job\.rk\), docId\)/.test(homeC)
    && /landedTimers\.current\[key\] = setTimeout\(\(\) => forgetLanded\(key\), LANDED_WAIT_MS\)/.test(homeC)
    && /if \(doc\.docId === landedDocId && !doc\.stale\) forgetLanded\(/.test(homeC));
  ok('⚠️ …and while it is held the chip offers no build and no gate hint',
    /const docPending = !doc && \(\(docState === 'loading' && !!listDoc\) \|\| landedWait\);/.test(homeC)
    && /const wantsAction = [^;]*&& !docPending;/.test(homeC)
    && /hint=\{target && wantsAction && hint \? hint\.text : null\}/.test(homeC));
  // Tapping a page that stands in for a document still loading opened the BASE resume's editor/gallery,
  // and a zoomed letter's Download did nothing at all.
  ok('⚠️ a tap while the saved document is on its way says so, and opens nothing',
    /const docOnItsWay = \(\) => !docRef\.current && docPendingRef\.current;/.test(homeC)
    && /if \(docOnItsWay\(\)\) \{ sayLoadingDoc\(\); return; \}/.test(fnBodyOf(homeC, 'openPaper') || '')
    && /if \(docOnItsWay\(\)\) sayLoadingDoc\(\);/.test(fnBodyOf(homeC, 'openLetterPicker') || '')
    && /showNotice\('Loading your saved version…'/.test(homeC));
}

console.log('── ⚠️ ONE BUILD, ONE PERCENTAGE, WHEREVER IT IS SHOWN ──');
{
  // The chip and the carousel card showed different numbers for the same build: a display that mounted
  // late seeded from the stage ceiling while the other was still creeping below it.
  ok('the creep is keyed per build and shared between every display of it',
    /export function useCreepPct\(stage: BuildStage \| null, phase: BuildPhase \| null, key\?: string\): number/.test(buildsC)
    && /const c = k \? creepShown\.get\(k\) : undefined;/.test(buildsC) && /writeCreep\(k,/.test(buildsC));
  ok('…and BOTH displays of one build pass it — the chip line and the carousel number',
    /useCreepPct\(stage, phase, buildKey\)/.test(chipC) && /buildKey=\{storeKeyOf\(kind, rk\)\}/.test(chipC)
    && /useCreepPct\(stage, phase, buildKey\)/.test(carC) && /buildKey=\{storeKeyOf\(kind, rk\)\}/.test(carC));
  ok('⚠️ a component that switches to ANOTHER build takes that build\'s number, not its own',
    /if \(seededFor\.current !== k\) \{/.test(buildsC) && /v\.current = seedOf\(\);/.test(buildsC));
}

console.log('── ⚠️ THE CHIP LOOKUP CARRIES THE POSTING, AND THE SERVER ANSWERS WITH IT ──');
{
  ok('DocLookup carries postingUrl beside the identity jobUrl',
    /postingUrl\?: string \| null;/.test(docSvcC)
    && /postingUrl: posting \? \(jobUrl \|\| null\) : \(pastedLink \|\| null\)/.test(docSvcC));
  ok('⚠️ …but the chip\'s doc cache is keyed on the IDENTITY only (which document a chip has does not '
    + 'change with the link it would be written against)',
    /const urlPart = \(q: DocLookup\) => String\(q\.jobUrl \|\| ''\)\.trim\(\);/.test(docSvcC)
    && !/(nameKeyOf|idKeyOf)[\s\S]{0,200}?postingUrl/.test(docSvcC)
    && /if \(posting\) body\.postingUrl = posting;/.test(docSvcC));
  ok('DocMeta hands back the job the document was built for', /jobInput\?: DocJobInput \| null;/.test(docSvcC) && /jobInput: shapeJobInput\(d\.jobInput\)/.test(docSvcC));
  // ⚠️ sample ONLY MEANS "no builder row": an upload-only account has a résumé we can build from.
  ok('⚠️ Home asks the server whether there is a résumé at all, not whether there is a builder row',
    /hasResume\?: boolean;/.test(svcC) && /typeof j\.hasResume === 'boolean' \? \{ hasResume: j\.hasResume \}/.test(svcC)
    && /const noResumeYet = [^;]*hasResume \?\? !sample/.test(homeC));
}

console.log('── ⚠️ A LETTER PAGE HAS THE SAME TWO ACTIONS AS A RESUME PAGE (2026-09-13) ──');
{
  // The zoomed letter used to offer one "Download" — the only door to a letter, and no way to edit its words.
  ok('PaperZoom has no Download button any more', !/>\s*Download\s*</.test(zoomC) && !/onDownload/.test(zoomC));
  ok('…Customize (ghost) and View PDF (primary) are rendered ONCE, for a resume and a letter alike',
    (zoomC.match(/>Customize</g) || []).length === 1 && (zoomC.match(/>View PDF</g) || []).length === 1
    && /style=\{s\.ghost\}[\s\S]{0,160}setTimeout\(onCustomize, 200\)[\s\S]{0,200}>Customize</.test(zoomC)
    && /style=\{s\.primaryWrap\}[\s\S]{0,160}setTimeout\(onViewPdf, 200\)[\s\S]{0,400}>View PDF</.test(zoomC));
  ok('…the button branch is sample-or-not, never letter-or-resume',
    /\{sample \? \(/.test(zoomC) && !/\{letter \? \(/.test(zoomC) && !/letter && \(/.test(zoomC));
  ok('…and a letter is never a sample (a sample card keeps its single "Build my resume")',
    /const sample = !!sampleProp && !letter;/.test(zoomC) && (zoomC.match(/>Build my resume</g) || []).length === 1);
  ok('the hero letter zoom: Customize → the letter EDITOR, View PDF → the letter picker',
    /if \(kind === 'cover_letter'\) \{ openLetterEditor\(\); return; \}/.test(homeC)
    && /if \(kind === 'cover_letter'\) \{ openLetterPicker\(id\); return; \}/.test(homeC));
  const edBody = fnBodyOf(homeC, 'openLetterEditor');
  ok('⚠️ openLetterEditor pushes /(cover-letter)/edit with the saved letter\'s docId — and nothing else',
    /nav\(\)\?\.push\?\.\(\{ pathname: '\/\(cover-letter\)\/edit', params: \{ docId: String\(d\.docId\) \} \}\)/.test(edBody)
    && /d\.kind !== 'cover_letter'/.test(edBody)
    && !/AsyncStorage|autoBuild|generate|checkBuildGate|buildFor\(/.test(edBody), edBody.slice(0, 300));
  ok('⚠️ …and while the letter is still on its way it says so instead of doing nothing',
    /if \(docOnItsWay\(\)\) sayLoadingDoc\(\);/.test(edBody));
}

console.log('── ⚠️ A LIBRARY CARD OPENS ITS PAGE — IT NEVER DOWNLOADS ON THE TAP (2026-09-13) ──');
{
  const tapBody = fnBodyOf(histC, 'tap');
  ok('the row\'s press is the open handler', /onPress=\{tap\}/.test(histC));
  ok('⚠️ tap calls onOpen with the PAPER\'s measured rectangle, or null when it cannot measure',
    /node\.measureInWindow\(\(x: number, y: number, w: number, h: number\) => onOpen\(item, w \? \{ x, y, w, h \} : null\)\)/.test(tapBody)
    && /typeof node\.measureInWindow !== 'function'\) \{ onOpen\(item, null\); return; \}/.test(tapBody)
    && /const node: any = paper\.current;/.test(tapBody), tapBody.slice(0, 300));
  ok('…measured on a view Android will not flatten away', /<View ref=\{paper\} collapsable=\{false\}/.test(histC));
  ok('⚠️ NOTHING in DownloadHistory calls onAgain, onPay or redownload any more',
    !/onAgain\s*\(|onPay\s*\(|onAgain\?\.\(|onPay\?\.\(|redownload/.test(histC));
  ok('…the old props survive only as optional, for any other caller',
    /onAgain\?: \(it: DownloadHistoryItem\) => void;/.test(histC) && /onPay\?: \(employer: string \| null\) => void;/.test(histC)
    && /onOpen: \(item: DownloadHistoryItem, origin: OriginRect \| null\) => void;/.test(histC));
  ok('Home wires the library to openHistoryItem, and passes it no download handler',
    /<DownloadHistory\n[\s\S]{0,400}onOpen=\{openHistoryItem\}/.test(homeC)
    && !/<DownloadHistory\n[^/]*?(onAgain|onPay)=/.test(homeC));

  const oh = fnBodyOf(homeC, 'openHistoryItem');
  ok('openHistoryItem: the kind comes from the row', /const k: DocKind = item\.kind === 'cover_letter' \? 'cover_letter' : 'resume';/.test(oh));
  ok('…the saved list in hand for that kind, else ONE read of it',
    /k === kindRef\.current \? docListRef\.current : null/.test(oh) && /docLoadersRef\.current\?\.list \|\| fetchDocList/.test(oh)
    && /list = await read\(k\)/.test(oh));
  ok('⚠️ …a list that could not be read is NOT "nothing saved": a notice, and nothing opens',
    /if \(!list\) \{\s*showNotice\([\s\S]{0,160}\);\s*return;\s*\}/.test(oh));
  ok('…a doc, matched by sameEmployerName via savedDocFor', /const saved = who \? savedDocFor\(list, who\) : null;/.test(oh));
  ok('⚠️ no doc + letter → the old file fallback with a notice (nothing to preview), never a zoom',
    /if \(k === 'cover_letter'\) \{[\s\S]{0,700}showNotice\([\s\S]{0,300}if \(item\.unlocked\) doAgain\(item\);[\s\S]{0,120}return;\s*\}/.test(oh));
  ok('no doc + resume → the zoom on the BASE page in that design (thumbFor), doc null',
    /setZoom\(\{\s*src: 'library', n, rect: origin, kind: k, doc: null,[\s\S]{0,200}image: thumbFor\(item\.templateId\) \|\| null/.test(oh));
  ok('with a doc → the zoom opens AT ONCE for { id: templateId, name: templateName, image, fit } with that doc',
    /setZoom\(\{\s*src: 'library', n, rect: origin, kind: k, doc: zd,[\s\S]{0,200}id: item\.templateId, name: item\.templateName, accent, image, fit/.test(oh)
    && /const zd: ZoomDoc = \{ docId: saved\.docId, kind: k, employer: saved\.employer \|\| who \};/.test(oh));
  ok('…then fills the image from fetchDocCards(kind, docId, [templateId]) — never with an empty id list',
    /if \(!image && item\.templateId\) fillDocPage\(n, k, saved, item\.templateId\);/.test(oh)
    && /await readCards\(k, saved\.docId, \[templateId\]\)/.test(fnBodyOf(homeC, 'fillDocPage'))
    && /docLoadersRef\.current\?\.cards \|\| fetchDocCards/.test(fnBodyOf(homeC, 'fillDocPage')));
  ok('⚠️ …and a page that lands after the sheet closed (or another card opened) is dropped',
    /if \(libOpen\.current !== n \|\| !alive\.current\) return;/.test(fnBodyOf(homeC, 'fillDocPage'))
    && /z && z\.src === 'library' && z\.n === n/.test(fnBodyOf(homeC, 'fillDocPage')));
  ok('⚠️ openHistoryItem itself never downloads, bills or generates a saved document',
    !/redownload|checkBuildGate|buildFor\(|autoBuild|coverLetterPickerContext/.test(oh));

  // Customize / View PDF from a LIBRARY zoom go through the hero's own doors.
  ok('library Customize: letter → openLetterEditor(that doc); resume → customizeResume(that doc, its employer)',
    /if \(libZoom\.kind === 'cover_letter'\) openLetterEditor\(libZoom\.doc\);\s*else customizeResume\(libZoom\.doc, \{ company: libZoom\.employer, role: '' \}, libZoom\.sample\);/.test(homeC));
  ok('library View PDF: letter → openLetterPicker(design, that doc); resume → openResumeGallery(design, that doc, its employer)',
    /if \(libZoom\.kind === 'cover_letter'\) \{ openLetterPicker\(id, libZoom\.doc\); return; \}/.test(homeC)
    && /openResumeGallery\(id, libZoom\.doc, \{ company: libZoom\.employer, role: '' \}\);/.test(homeC));
  const cz = fnBodyOf(homeC, 'customizeResume');
  ok('customizeResume: a saved doc → /(resume-builder)/preview { docId, from: home }; none → { from: home }',
    /pathname: '\/\(resume-builder\)\/preview', params: \{ docId: String\(d\.docId\), from: 'home' \}/.test(cz)
    && /nav\(\)\?\.push\?\.\(\{ pathname: '\/\(resume-builder\)\/preview', params: \{ from: 'home' \} \}\)/.test(cz)
    && /if \(sample\) armBuilderFor\(target\)/.test(cz));
  const gz = fnBodyOf(homeC, 'openResumeGallery');
  ok('openResumeGallery: /(resume-builder)/templates { template, employer, docId }',
    /pathname: '\/\(resume-builder\)\/templates'/.test(gz) && /\.\.\.\(id \? \{ template: id \} : \{\}\)/.test(gz)
    && /\.\.\.\(target\?\.company \? \{ employer: target\.company \} : \{\}\)/.test(gz)
    && /\.\.\.\(d \? \{ docId: String\(d\.docId\)/.test(gz));
  const lp = fnBodyOf(homeC, 'openLetterPicker');
  ok('openLetterPicker takes the library\'s doc, stores the picker context with its docId, and opens the gallery on the design',
    /const d: ZoomDoc \| null = forDoc !== undefined \? forDoc : docRef\.current;/.test(lp)
    && /AsyncStorage\.setItem\('coverLetterPickerContext'/.test(lp) && /docId: full\.docId/.test(lp)
    && /pathname: '\/\(cover-letter\)\/templates',\s*params: \{ \.\.\.\(templateId \? \{ template: templateId \} : \{\}\), docId: String\(full\.docId\) \}/.test(lp));

  // savedDocFor, run for real: same employer by name, the employer-level document (jobUrl '') first, else newest.
  const fnSrc = (home.match(/function savedDocFor\([\s\S]*?\n\}/) || [''])[0];
  const docsJs = ts.transpileModule(docSvcSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  let sameEmployerName = null;
  try {
    const m = { exports: {} };
    // './employerHomeService' now also supplies deviceHeaders to call(); savedDocFor/sameEmployerName never reach it.
    const fakeReq = (id) => (/async-storage/.test(id) ? { default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }
      : /employerHomeService/.test(id) ? { deviceHeaders: async () => ({}) } : {});
    new Function('module', 'exports', 'require', docsJs)(m, m.exports, fakeReq);
    sameEmployerName = m.exports.sameEmployerName;
  } catch (e) { console.log('     (employerDocs.ts did not load: ' + String(e.message).split('\n')[0] + ')'); }
  let savedDocFor = null;
  if (fnSrc && sameEmployerName) {
    const js = ts.transpileModule(fnSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
    savedDocFor = new Function('sameEmployerName', js + '\nreturn savedDocFor;')(sameEmployerName);
  }
  ok('savedDocFor + sameEmployerName load and run', typeof savedDocFor === 'function');
  if (savedDocFor) {
    const L = [
      { docId: 1, employer: 'Airbus', jobUrl: 'https://ag.wd3.myworkdayjobs.com/x/job/1', updatedAt: '2026-09-12T10:00:00Z' },
      { docId: 2, employer: 'AIRBUS', jobUrl: '', updatedAt: '2026-09-01T10:00:00Z' },
      { docId: 3, employer: 'Airbus', jobUrl: 'https://ag.wd3.myworkdayjobs.com/x/job/2', updatedAt: '2026-09-13T10:00:00Z' },
      { docId: 4, employer: 'Eneco', jobUrl: 'https://werkenbij.eneco.nl/v/1', updatedAt: '2026-09-02T10:00:00Z' },
      { docId: 5, employer: 'Eneco', jobUrl: 'https://werkenbij.eneco.nl/v/2', updatedAt: '2026-09-10T10:00:00Z' },
    ];
    ok('⚠️ the employer-level document wins over a NEWER posting document', (savedDocFor(L, 'airbus') || {}).docId === 2);
    ok('…with none, the newest posting document', (savedDocFor(L, 'Eneco') || {}).docId === 5);
    ok('…another employer\'s documents are never picked', savedDocFor(L, 'Siemens') === null && savedDocFor([], 'Airbus') === null && savedDocFor(null, 'Airbus') === null);
  }
}

console.log('── ⚠️ A USED-UP ALLOWANCE NAMES WHICH ONE, AND NEVER A CREDIT PRICE (2026-09-13) ──');
{
  const aoSrc = (overlaySrc.match(/function allowanceOf\([\s\S]*?\n\}/) || [''])[0];
  let allowanceOf = null;
  try {
    const js = ts.transpileModule(aoSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
    allowanceOf = new Function(js + '\nreturn allowanceOf;')();
  } catch {}
  ok('allowanceOf loads', typeof allowanceOf === 'function');
  if (allowanceOf) {
    // The server's own sentences (entitlements.canConsumeMany), word for word.
    const FREE_R = "You've used your 3 free resume generations. Start a plan in Plans & Usage to keep going.";
    const PLAN_L = "You've used all the cover letters in your plan this month. Upgrade in Plans & Usage to continue.";
    const DEVICE = 'The free plan on this device was already used by another account. Start a plan in Plans & Usage to keep going.';
    ok('the server\'s free sentence → free, even for a subscriber the app thinks is paid', allowanceOf('quota_exhausted', FREE_R, true) === 'free');
    ok('the server\'s plan sentence → plan, even before isPaid is known', allowanceOf('quota_exhausted', PLAN_L, false) === 'plan');
    ok('the device-blocked sentence → free', allowanceOf('quota_exhausted', DEVICE, false) === 'free');
    ok('a sentence naming neither falls back to isPaid; regen_limit is always free',
      allowanceOf('quota_exhausted', '', true) === 'plan' && allowanceOf('quota_exhausted', '', false) === 'free' && allowanceOf('regen_limit', PLAN_L, true) === 'free');
  }
  ok('the overlay\'s titles are the contract\'s, free and plan, resume and letter',
    /title: "You've used your free cover letters"/.test(overlaySrc) && /title: "You've used your free resume generations"/.test(overlaySrc)
    && /title: "You've used this month's cover letters"/.test(overlaySrc) && /title: "You've used this month's resume generations"/.test(overlaySrc));
  ok('⚠️ the overlay\'s refusal copy never promises a refill or names credits',
    !/credit/i.test(overlayC) && !/refills? (on|in|every)|every 30 days/i.test(overlayC));
  ok('Home tells the overlay whether the user is on a plan', /isPaid=\{isPaid\}/.test(homeC));
  ok('⚠️ Home\'s gate hint never says "Uses N credits"', !/credit/i.test(homeC) && !/Uses \$\{/.test(homeC));
}

console.log('── ⚠️ THE LETTER EDITOR: the user\'s words in, only p/br/strong out (2026-09-13) ──');
{
  const edSrc = R('../app/(cover-letter)/edit.tsx');
  const edC = strip(edSrc);
  const layoutSrc = R('../app/(cover-letter)/_layout.tsx');
  ok('the route is registered in the (cover-letter) stack', /<Stack\.Screen name="edit" \/>/.test(layoutSrc));
  // ⚠️ RETARGETED 2026-09-19: the one-textbox editor (letterHtmlToText / letterTextToHtml, bold as **asterisks**) is
  // gone — the owner asked for the résumé page's twin: one card per paragraph, bold SHOWN bold and edited in the same
  // Quill box. The conversions moved to services/letterHtml.ts and scripts/test-letter-editor.js drives them (and the
  // page) for real; what stays here is the contract Home relies on, read from the source.
  const lhSrc = R('../services/letterHtml.ts');
  ok('the old **markdown** converters are gone from the page', !/letterHtmlToText|letterTextToHtml/.test(edSrc));
  ok('⚠️ the letter becomes paragraph CARDS through services/letterHtml (split / join / the Quill box\'s answer)',
    /import \{[^}]*\bsplitLetterParagraphs\b[^}]*\bjoinLetterParagraphs\b[^}]*\bquillToBlocks\b[^}]*\} from '\.\.\/\.\.\/services\/letterHtml';/.test(edSrc)
    && /export function cleanInline\(/.test(lhSrc) && /export function splitLetterParagraphs\(/.test(lhSrc));
  ok('⚠️ …and a card is edited in the résumé\'s own Quill box, narrowed to bold (the Original PDF prints no italic)',
    /from '\.\.\/\.\.\/components\/rich-text\/RichText';/.test(edSrc) && /const LETTER_FORMATS: RichFormat\[\] = \['bold'\];/.test(edC)
    && /<RichTextModal[\s\S]{0,200}formats=\{LETTER_FORMATS\}/.test(edC));
  // ⚠️ RETARGETED 2026-09-14: goneOut no longer calls router.back() itself. It sets `exit`, and the back runs in the
  // exit effect — a render later, once the usePreventRemove guard (dirty && !exit) is down, or the guard would
  // swallow the very navigation that takes the user off a deleted letter.
  const goneBody = fnBodyOf(edC, 'goneOut');
  ok('it loads the letter by docId, and "gone" is an Alert and back (through the exit effect)',
    /const d = await fetchDoc\(docId\)/.test(edC) && /if \(d === 'gone'\) \{ setLoading\(false\); goneOut\(\); return; \}/.test(edC)
    && /Alert\.alert\('This letter is gone'/.test(goneBody) && /setExit\(\{\}\)/.test(goneBody) && !/router\.back\(\)/.test(goneBody)
    && /if \(!exit\) return;\s*if \(exit\.action\) navigation\.dispatch\(exit\.action\);\s*else if \(router\.canGoBack\(\)\) router\.back\(\);/.test(edC), goneBody);
  // ⚠️ THE iOS SWIPE. A beforeRemove listener cannot cancel a native dismiss, and gestureEnabled on this inner screen
  // changed the wrong navigator (Home pushes the (cover-letter) GROUP). usePreventRemove reports up to the root stack.
  ok('⚠️ unsaved edits are guarded by usePreventRemove (reaches the native swipe), with the guard dropped by STATE',
    /import \{ usePreventRemove[^}]*\} from '@react-navigation\/native';/.test(edSrc)
    && /usePreventRemove\(dirty && !exit, \(\{ data \}\) => \{/.test(edC)
    && /text: 'Discard'[\s\S]{0,120}setExit\(\{ action: data\.action \}\)/.test(edC)
    && !/addListener\('beforeRemove'/.test(edC) && !/gestureEnabled/.test(edC)
    && /const \[exit, setExit\] = useState/.test(edC));
  ok('⚠️ a resume docId is refused, so it can never be saved back as a letter', /if \(d\.kind !== 'cover_letter'\)/.test(edC));
  // ⚠️ RETARGETED 2026-09-19: one write path for every card (persist), and only what changed rides in it.
  ok('every save is saveDocPayload(docId, …) — a field card writes only what changed, the letter HTML as stored',
    (edC.match(/saveDocPayload\(/g) || []).length === 1 && /await saveDocPayload\(docId, next\)/.test(edC)
    && /const next = withLetterFields\(doc\.payload, opened, draft, profileSender\);/.test(edC));
  ok('⚠️ any failure is "not saved", out loud — never a pretend success',
    /\.catch\(\(\) => \(\{ ok: false as const, reason: 'network'/.test(edC) && /Alert\.alert\('Could not save', r\.message/.test(edC)
    && /if \(r\.ok\) \{/.test(edC) && /setBodyError\('Your last paragraph change is not saved yet\.'\)/.test(edC));
  const og = fnBodyOf(edC, 'openGallery');
  ok('View PDF writes coverLetterPickerContext { coverLetterHtml, companyName, companyAddress, employer, docId } and opens the gallery by docId',
    /AsyncStorage\.setItem\('coverLetterPickerContext', JSON\.stringify\(\{\s*coverLetterHtml: html,\s*companyName: p\.companyName,\s*companyAddress: p\.companyAddress,\s*employer: doc\.employer,\s*docId,\s*\}\)\)/.test(og)
    && /router\.push\(\{ pathname: '\/\(cover-letter\)\/templates', params: \{ docId: String\(docId\) \} \}/.test(og), og.slice(0, 400));
  ok('⚠️ …with unsaved edits it saves FIRST (the gallery renders the server\'s copy)',
    /if \(bodyDraft === null\) \{ openGallery\(storedHtml\); return; \}[\s\S]{0,80}if \(await retryBody\(\{ quiet: true \}\)\) \{ openGallery\(pending\); return; \}/.test(edC));
  ok('⚠️ the editor never generates or charges', !/generate|consumeOnSuccess|checkBuildGate|buildFor\(|autoBuild|\/cover-letter\/employer-build/.test(edC));
  ok('Ionicons only, and expo-file-system (if ever) from /legacy', !/MaterialIcons|FontAwesome|Feather/.test(edSrc) && !/from 'expo-file-system'/.test(edSrc));
}

console.log('── ⚠️ THE DEVICE RIDES WITH EVERY HOME REQUEST, AND IS REPORTED FOR A LATER SIGN-IN (2026-09-14) ──');
{
  // The free 3 + 3 is ONE PER DEVICE, and the server can only hold that line for a device it can see. Home's
  // gate and both build lanes sent Authorization only, and reportDeviceOnce ran once, 4 s after launch — so an
  // account created later in that launch had no device at all: sign out, sign up, a second free allowance.
  const transpileTs = (src) => ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const load = (src, fakeReq) => { const m = { exports: {} }; new Function('module', 'exports', 'require', transpileTs(src))(m, m.exports, fakeReq); return m.exports; };
  const asyncStore = { __esModule: true, default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, multiRemove: async () => {} } };
  const secure = { getItemAsync: async (k) => (k === 'userSession' ? JSON.stringify({ token: 'TKN', id: 7 }) : null), setItemAsync: async () => {} };

  // Source: every Authorization header these three services build carries the device beside it.
  for (const [name, src] of [['employerHomeService.ts', svcC], ['homeAddEmployer.ts', addSvcC], ['employerDocs.ts', docSvcC]]) {
    const auths = src.match(/\{ Authorization: `Bearer \$\{t\}`[^}]*\}/g) || [];
    ok(`⚠️ ${name}: every Authorization header object also spreads deviceHeaders()`,
      auths.length >= 1 && auths.every((h) => /\.\.\.\(await deviceHeaders\(\)\)/.test(h)), auths);
  }
  ok('homeAddEmployer and employerDocs take THE helper from employerHomeService (one id, one header name)',
    /import \{[^}]*\bdeviceHeaders\b[^}]*\} from '\.\/employerHomeService';/.test(addSvcSrc)
    && /import \{[^}]*\bdeviceHeaders\b[^}]*\} from '\.\/employerDocs'|import \{[^}]*\bdeviceHeaders\b[^}]*\} from '\.\/employerHomeService';/.test(docSvcSrc)
    && /export async function deviceHeaders\(\)/.test(svcC) && /'x-device-id': deviceIdMemo/.test(svcC) && /from '\.\/deviceId'/.test(svc));

  // ⚠️ CONTRACT C3 (2026-09-15): x-store-env rides with every Home request too. TestFlight StoreKit is always Sandbox, so a
  // pass bought from Home's sheet is written in Sandbox — and a gate or a build that names no environment is read as
  // Production, where that pass does not exist: the user pays and the sheet goes on saying nothing is left.
  ok('⚠️ C3: every Authorization header object in homeAddEmployer also spreads storeEnvHeaders(), which awaits storeEnv\'s header and never throws',
    (addSvcC.match(/\{ Authorization: `Bearer \$\{t\}`[^}]*\}/g) || []).length >= 2
    && (addSvcC.match(/\{ Authorization: `Bearer \$\{t\}`[^}]*\}/g) || []).every((h) => /\.\.\.\(await storeEnvHeaders\(\)\)/.test(h))
    && /async function storeEnvHeaders\(\)[\s\S]{0,220}\.storeEnvHeader\(\); \}\s*catch \{ return \{\}; \}/.test(addSvcC), addSvcC.match(/async function storeEnvHeaders[\s\S]{0,260}/)?.[0]);

  // Behaviour: the real helper, the real request code, a fake fetch that records the headers.
  const sent = [];
  const realFetch = global.fetch;
  let devId = null, devCalls = 0;
  const fakeDevice = { getDeviceId: async () => { devCalls++; if (devId === 'THROW') throw new Error('keychain'); return devId; } };
  let ehs = null, docs = null, add = null;
  try {
    ehs = load(svc, (id) => (id === './deviceId' ? fakeDevice : /secure-store/.test(id) ? secure : /async-storage/.test(id) ? asyncStore : /config/.test(id) ? { API_BASE: 'https://api.test' } : {}));
    // storeEnv answers Sandbox for the whole phase (C3): the header must reach the wire beside the device and the token.
    const fakeStoreEnv = { storeEnvHeader: async () => ({ 'x-store-env': 'Sandbox' }) };
    const shared = (id) => (/employerHomeService/.test(id) ? ehs : /storeEnv/.test(id) ? fakeStoreEnv : /secure-store/.test(id) ? secure : /async-storage/.test(id) ? asyncStore : /config/.test(id) ? { API_BASE: 'https://api.test' } : null);
    add = load(addSvcSrc, (id) => shared(id) || {});
    docs = load(docSvcSrc, (id) => shared(id) || (/homeAddEmployer/.test(id) ? { signedInAccount: async () => 'u:7' } : {}));
  } catch (e) { console.log('     (device harness did not load: ' + String(e.message).split('\n')[0] + ')'); }
  ok('the three services load against a fake device + fetch', !!(ehs && typeof ehs.deviceHeaders === 'function' && add && typeof add.checkBuildGate === 'function' && docs && typeof docs.fetchDoc === 'function'));
  if (ehs && add && docs) {
    (async () => {
      global.fetch = async (url, init) => { sent.push({ url: String(url), headers: (init && init.headers) || {} }); return { ok: true, status: 200, json: async () => ({}) }; };
      try {
        devId = null;
        const h0 = await ehs.deviceHeaders();
        devId = 'dev-abc-12345';
        const h1 = await ehs.deviceHeaders();
        const callsAfter = devCalls;
        devId = 'THROW';
        const h2 = await ehs.deviceHeaders();
        ok('a missing id sends NO header and is not remembered; the next request reads it again',
          JSON.stringify(h0) === '{}' && h1['x-device-id'] === 'dev-abc-12345');
        ok('…once read it is kept (a later keychain throw does not blind the session)', h2['x-device-id'] === 'dev-abc-12345' && devCalls === callsAfter);

        await add.checkBuildGate('Airbus', { website: 'https://airbus.com' }, 'resume', {});
        await add.checkBuildGate('Airbus', { website: 'https://airbus.com' }, 'cover_letter', {});
        await docs.fetchDoc(42);
        const by = (re) => sent.filter((x) => re.test(x.url));
        const gateR = by(/\/resume-builder\/generation-gate$/), gateL = by(/\/cover-letter\/employer-gate$/), doc = by(/\/employer-docs\/42$/);
        ok('⚠️ the resume gate, the letter gate and the doc read all go out WITH x-device-id beside Authorization',
          gateR.length === 1 && gateL.length === 1 && doc.length === 1
          && [gateR[0], gateL[0], doc[0]].every((x) => x.headers['x-device-id'] === 'dev-abc-12345' && x.headers.Authorization === 'Bearer TKN'),
          sent.map((x) => [x.url, x.headers]));
        ok('⚠️ C3: the resume gate and the letter gate go out WITH x-store-env beside the device and the token (the environment the pass was bought in)',
          gateR.length === 1 && gateL.length === 1 && [gateR[0], gateL[0]].every((x) => x.headers['x-store-env'] === 'Sandbox'), [gateR[0], gateL[0]].map((x) => x && x.headers));
      } finally { global.fetch = realFetch; }
    })().then(() => devicePhaseDone(), (e) => { ok('device harness ran without throwing', false, String(e && e.message)); devicePhaseDone(); });
  } else devicePhaseDone();
}

console.log('── ⚠️ reportDeviceOnce: ONCE PER ACCOUNT, NOT ONCE PER LAUNCH (2026-09-14) ──');
function reportPhase() {
  const subSrc = R('../services/subscriptionService.ts');
  const layoutSrc = strip(R('../app/_layout.tsx'));
  let session = null, posts = [], postFails = 0, devOk = true;
  // A CommonJS module (no __esModule), exactly what esModuleInterop's __importDefault wraps as `default`.
  const fakeAxios = {
    post: async (url, body, cfg) => { if (postFails > 0) { postFails--; throw new Error('network'); } posts.push({ url, body, auth: cfg && cfg.headers && cfg.headers.Authorization }); return { data: {} }; },
    get: async () => ({ data: {} }),
  };
  let S = null;
  try {
    const js = ts.transpileModule(subSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
    const m = { exports: {} };
    new Function('module', 'exports', 'require', js)(m, m.exports, (id) => {
      if (id === 'axios') return fakeAxios;
      if (/secure-store/.test(id)) return { getItemAsync: async (k) => (k === 'userSession' && session ? JSON.stringify(session) : null), setItemAsync: async () => {}, deleteItemAsync: async () => {} };
      if (id === 'react-native') return { Platform: { OS: 'ios' } };
      if (/config/.test(id)) return { API_BASE: 'https://api.test' };
      if (/deviceId/.test(id)) return { getDeviceId: async () => (devOk ? 'dev-abc-12345' : null), deviceHeader: async () => ({}) };
      if (/storeEnv/.test(id)) return { rememberStoreEnv: () => {}, storeEnvHeader: async () => ({}) };
      return {};
    });
    S = m.exports;
  } catch (e) { console.log('     (subscriptionService.ts did not load: ' + String(e.message).split('\n')[0] + ')'); }
  ok('reportDeviceOnce loads', !!(S && typeof S.reportDeviceOnce === 'function'));
  if (!S) return Promise.resolve();
  return (async () => {
    const r1 = await S.reportDeviceOnce();                                   // launch, signed out
    session = { token: 'T-A', id: 101 };                                     // …the user signs up later in that launch
    const r2 = await S.reportDeviceOnce();
    const r3 = await S.reportDeviceOnce();                                   // the next poll
    ok('⚠️ signed out at launch → nothing; a LATER sign-in in the same launch IS reported, once',
      r1 === 'signed_out' && r2 === 'reported' && r3 === 'unchanged' && posts.length === 1
      && /\/subscription\/device$/.test(posts[0].url) && posts[0].body.deviceId === 'dev-abc-12345' && posts[0].auth === 'Bearer T-A', { r1, r2, r3, posts });
    session = { token: 'T-B', id: 202 };                                     // sign out, sign up as someone else
    postFails = 1;
    const r4 = await S.reportDeviceOnce();
    const r5 = await S.reportDeviceOnce();
    ok('⚠️ a different account is reported too — and a FAILED post is retried, not remembered',
      r4 === 'failed' && r5 === 'reported' && posts.length === 2 && posts[1].auth === 'Bearer T-B', { r4, r5, n: posts.length });
    session = null; await S.reportDeviceOnce();
    session = { token: 'T-B2', id: 202 };
    const r6 = await S.reportDeviceOnce();
    ok('signing out forgets the account, so signing back in reports again', r6 === 'reported' && posts.length === 3, { r6 });
    session = { token: 'T-C', id: 303 }; devOk = false;
    const r7 = await S.reportDeviceOnce(); devOk = true;
    const r8 = await S.reportDeviceOnce();
    ok('no device id yet → failed (nothing posted) and retried on the next call', r7 === 'failed' && r8 === 'reported' && posts.length === 4, { r7, r8 });
    session = { token: 'T-D', id: 404 };
    const [p1, p2] = await Promise.all([S.reportDeviceOnce(), S.reportDeviceOnce()]);
    ok('overlapping calls share ONE request', p1 === 'reported' && p2 === 'reported' && posts.length === 5, { p1, p2, n: posts.length });
    ok('_layout re-checks after launch: a 4 s first check, a poll inside a window, and every return to the foreground',
      /setTimeout\(check, 4000\)/.test(layoutSrc) && /setInterval\(\(\) => \{[\s\S]{0,200}check\(\);[\s\S]{0,40}\}, DEVICE_REPORT_POLL_MS\)/.test(layoutSrc)
      && /AppState\.addEventListener\('change'[\s\S]{0,200}next === 'active'[\s\S]{0,120}check\(\)/.test(layoutSrc)
      && /clearTimeout\(first\); clearInterval\(poll\); sub\.remove\(\);/.test(layoutSrc) && /reportDeviceOnce\(\)/.test(layoutSrc));
  })().catch((e) => ok('reportDeviceOnce harness ran without throwing', false, String(e && e.message)));
}

console.log('── ⚠️ THE REVIEW SCREEN HAS NO CREDIT GATE: A 0-CREDIT SUBSCRIBER IS NOT REFUSED ON THE PHONE (2026-09-14) ──');
{
  const rv = R('../components/ReviewScreen.js');
  const rvC = strip(rv).replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  ok('⚠️ no creditBalance gate, no "Insufficient Credits", no credit-pack screen', !/creditBalance\s*<=?\s*0/.test(rvC) && !/Insufficient Credits|Recharge Now|setScreen\('packages'\)/.test(rvC));
  ok('…creditBalance is not even read (App.js still passes it; ignored on purpose)', !/\bcreditBalance\b/.test(rvC));
  ok('…and no credit price is shown on a button ("1 CR", a diamond count, "N cr")', !/\b1 CR\b|\{creditBalance\} cr|name="diamond"/.test(rvC));
}

console.log('── ⚠️ ASKS A, B, D (2026-09-14): the empty library card, the Tailor hint, the confirm sheet on Home ──');
{
  // A. The empty library card was clipped on a real iPhone: `height: 150` with the body inside the absolute clip.
  const emptyShell = (histC.match(/emptyShell: \{([^}]*)\}/) || [])[1] || '';
  const emptyFn = histC.slice(histC.indexOf('function EmptyState('), histC.indexOf('function EmptyState(') + 2400);
  ok('⚠️ A: the empty card has NO fixed height — it grows with its copy (minHeight only)',
    !!emptyShell && !/(^|[\s,{])height:/.test(emptyShell) && /minHeight:/.test(emptyShell) && !/height: 150\b/.test(histC), emptyShell);
  ok('…the glass material sits in the absolute clip BEHIND a body in normal flow',
    /<View style=\{s\.emptyShell\}>[\s\S]{0,200}<View style=\{s\.clip\} pointerEvents="none">/.test(emptyFn));
  ok('…and the button grows too (minHeight, not a fixed 34pt)', !/height: 34\b/.test(histC) && /minHeight: 38/.test(histC));

  // B. The Tailor hint: native driver only, and a tap is a SCROLL, never a build.
  const hintSrc = R('../components/employer-home/TailorHint.tsx');
  const hintC = strip(hintSrc);
  const drivers = hintC.match(/useNativeDriver:\s*\w+/g) || [];
  ok('⚠️ B: TailorHint animates with the native driver ONLY', drivers.length >= 5 && drivers.every((d) => /true$/.test(d)), drivers);
  ok('…on transform and opacity only (no width, height, colour, top or margin is animated)',
    !/Animated\.(timing|spring)\([^)]*\b(width|height|backgroundColor|top|left|margin\w*|padding\w*)\b/.test(hintC)
    && !/\b(width|height|top|backgroundColor|marginTop):\s*\w+\.interpolate/.test(hintC));
  ok('…it is a memo component with no build or purchase import', /export default React\.memo\(TailorHint\)/.test(hintC)
    && !/useHomeBuilds|requestBuild|buyDownloadPass|homeAddEmployer/.test(hintC));
  const hintPress = fnBodyOf(homeC, 'onHintPress');
  ok('⚠️ …a tap on it only scrolls to the button (never requestBuild / K.request)',
    /scrollTo\?\.\(\{ y, animated: true \}\)/.test(hintPress) && !/requestBuild|K\.request|runBuild/.test(hintPress), hintPress.slice(0, 200));
  ok('…Home renders it with that handler, keyed by chip + kind, faded by the NATIVE scroll value',
    /<TailorHint\s+key=\{hintSig\}[\s\S]{0,160}onPress=\{onHintPress\}[\s\S]{0,60}fade=\{hintFade\}/.test(homeC)
    && /scrollY\.interpolate\(\{ inputRange: \[0, HINT_FADE_PX\]/.test(homeC));
  ok('⚠️ …the scroll position is read only where the page RESTS, never a JS listener per frame',
    /onScroll=\{Animated\.event\(\[\{ nativeEvent: \{ contentOffset: \{ y: scrollY \} \} \}\], \{ useNativeDriver: true \}\)\}/.test(homeC)
    && /onScrollEndDrag=\{onScrollRest\}/.test(homeC) && /onMomentumScrollEnd=\{onScrollRest\}/.test(homeC)
    && (homeC.match(/onScroll=/g) || []).length === 1);
  ok('…the copy names the company in both modes', /Scroll down to tailor this resume for/.test(hintSrc) && /Scroll down to write your cover letter for/.test(hintSrc));
  // ⚠️ THE 2026-09-15 REVIEW: the pill's height is MEASURED (placed from a 64pt guess, the real 70-100pt pill hung onto the
  // page's zoom button and took its taps), and the company is never the part the ellipsis eats (one sentence under
  // numberOfLines={2} lost exactly the name — "Rheinmetall Electronics GmbH" was the truncated words).
  ok('⚠️ B: the pill reports its laid-out height (onLayout → onHeight on the Pressable), and Home places it from that, never from the guess',
    /onLayout=\{onHeight \? \(e\) => onHeight\(e\.nativeEvent\.layout\.height\) : undefined\}/.test(hintC)
    && /const \[hintH, setHintH\] = useState\(TAILOR_HINT_H\);/.test(homeC) && /onHeight=\{onHintHeight\}/.test(homeC)
    && /const onHintHeight = useStableFn\(\(h: number\) => \{\s*const r = Math\.ceil\(h\);\s*if \(r > 0\) setHintH\(\(o\) => \(o === r \? o : r\)\);/.test(homeC)
    && !/slotH - 36 - 64 - 22/.test(homeC));
  ok('…its top keeps the MEASURED bottom, plus the pill\'s reach past its box, above the page\'s zoom button in both modes',
    /zoomBtnTop - HINT_ZOOM_GAP - TAILOR_HINT_REACH - hintH/.test(homeC) && /slotH - 18 - 50 - 18 - TAILOR_HINT_REACH - hintH/.test(homeC)
    && /foldY - slotTop - hintH - 24/.test(homeC) && /export const TAILOR_HINT_REACH = 10;/.test(hintC));
  ok('⚠️ …the company sits on its OWN single line with a MIDDLE ellipsis; the fixed phrase may wrap to two, and never carries the name',
    /<Text style=\{s\.company\} numberOfLines=\{1\} ellipsizeMode="middle"[^>]*>\s*\{company\}/.test(hintC)
    && /<Text style=\{s\.title\} numberOfLines=\{2\}[^>]*>\{lead\}<\/Text>/.test(hintC) && !/numberOfLines=\{2\}[^>]*>\{title\}/.test(hintC)
    && /const lead = kind === 'cover_letter' \? 'Scroll down to write your cover letter' : 'Scroll down to tailor this resume';/.test(hintC));
  ok('…while a screen reader still hears the whole sentence, company included',
    /accessibilityLabel=\{`\$\{title\}\. \$\{sub\}\.`\}/.test(hintC) && /const title = kind === 'cover_letter'[\s\S]{0,200}for \$\{company\}`/.test(hintC));

  // D / contract 6: the sheet is rendered next to the overlay, from the hook's own state.
  const sheetSrc2 = R('../components/employer-home/GenerateConfirmSheet.tsx');
  const sheetC2 = strip(sheetSrc2);
  ok('⚠️ D: Home renders <GenerateConfirmSheet> next to BuildingOverlay, fed by K.confirm',
    /import GenerateConfirmSheet from '\.\/GenerateConfirmSheet';/.test(homeC)
    && /<GenerateConfirmSheet\s+\{\.\.\.\(previewAsk \? \{[\s\S]*?\} : K\.confirm\)\}\s*\/>/.test(homeC)
    && homeC.indexOf('<GenerateConfirmSheet') > homeC.indexOf('<BuildingOverlay'));
  ok('…the harness copy can only close, alert or go to plans — it never builds or buys',
    !/K\.request|buyDownloadPass|runBuild/.test((homeC.match(/previewAsk \? \{[\s\S]*?\} : K\.confirm/) || [''])[0]));
  ok('the sheet takes exactly ConfirmSheetView and starts nothing itself',
    /export default function GenerateConfirmSheet\(\{[\s\S]{0,300}\}: ConfirmSheetView\)/.test(sheetC2)
    && !/buyDownloadPass|checkBuildGate|buildForEmployer|useHomeBuilds\(/.test(sheetC2));
  ok('…its price is the store\'s (fetchPassPrice), "$0.99" only a fallback label',
    /fetchPassPrice\(\)/.test(sheetC2) && /const PRICE_LABEL_FALLBACK = '\$0\.99';/.test(sheetC2)
    && (sheetC2.match(/\$0\.99/g) || []).length === 1);
  ok('…one native driver, no credit wording', !/useNativeDriver:\s*false/.test(sheetC2)
    && ![...sheetC2.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].some((m) => /credit/i.test(m[0])));
}

console.log('── ⚠️ THE LIBRARY IS A SHELF OF PAPER CARDS, TINTED LIKE THE EMPLOYER (2026-09-15) ──');
{
  // The product owner's ask: the download cards "look very bad". The library is now a 2-column grid of paper cards —
  // the document's own rendered page (A4 crop, cover/top), the employer ribbon on it, a padlock when the server says
  // locked, one strip of facts under it. Its pictures come from what Home already holds (imageFor), the front of the
  // shelf is filled by a READ (warmDocImages), and the skeletons/placeholders tint with design.brand.accent — the
  // colour the server actually rendered the pages in. Nothing here fetches, builds or spends.
  // — DownloadHistory: the prop, the grid, the card —
  ok('⚠️ imageFor(item) replaces thumbFor for pictures; accentFor stays for the tint',
    /imageFor: \(item: DownloadHistoryItem\) => string \| null \| undefined;/.test(histC) && /accentFor: \(templateId: string\) => string;/.test(histC)
    && !/thumbFor/.test(histC) && /image=\{imageFor\(it\)\}/.test(histC) && /accent=\{accentFor\(it\.templateId\)\}/.test(histC));
  ok('two cards to a line, without an onLayout: 50% cells carrying half the 12pt gutter, lines rowGap apart',
    /const GUTTER = 12;/.test(histC) && /grid: \{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -GUTTER \/ 2, rowGap: GUTTER \}/.test(histC)
    && /cell: \{ width: '50%', paddingHorizontal: GUTTER \/ 2 \}/.test(histC));
  ok('the card is the same dark glass as Home (radius 16, deeper than the page, a lit rim)',
    /const GLASS_SHELL = \{\s*borderRadius: 16, backgroundColor: 'rgba\(6,11,30,0\.46\)'/.test(histC) && /shell: \{ \.\.\.GLASS_SHELL \}/.test(histC) && /returnLight:/.test(histC));
  ok('the paper is an A4 page cropped from the foot: aspectRatio, contentFit cover, contentPosition top',
    /aspectRatio: PAPER_RATIO/.test(histC) && /contentFit="cover"/.test(histC) && /contentPosition="top"/.test(histC));
  ok('⚠️ no fixed row or card height anywhere: the strip grows with the text (minHeight), the paper with its ratio',
    !/\b(rowH|ROW_H)\b/.test(histC) && !/\bheight: (50|76|150)\b/.test(histC)
    && /strip: \{[^}]*minHeight: 48/.test(histC) && !/strip: \{[^}]*[^n]height:/.test(histC)
    && !/shell: \{[^}]*height:/.test(histC) && !/cell: \{[^}]*height:/.test(histC));
  ok('the employer ribbon top-left, as the hero page wears it: the initial tile in the gradFor gradient, the name on one line',
    /<View style=\{s\.ribbon\}>/.test(histC) && /const pair = gradFor\(item\.employer \|\| item\.templateName\);/.test(histC)
    && /<LinearGradient colors=\{pair\}[^>]*style=\{s\.ribbonTile\}>/.test(histC) && /<Text style=\{s\.ribbonTx\} numberOfLines=\{1\}/.test(histC));
  ok('⚠️ the padlock is a pill top-right, drawn only when the SERVER says locked (item.unlocked), never dimming the name',
    /const free = item\.unlocked;/.test(histC) && /\{!free && \([\s\S]{0,300}?<Ionicons name="lock-closed"/.test(histC) && !/ownsEmployer/.test(histC));
  // ⚠️ RETARGETED (2026-09-15): the meta line WRAPS. On one line with "  ·  " and a letter-spaced format,
  // "WORD · 12 Aug 2025 · ×12" ran past the ~116pt a 150pt cell leaves at 1.25× text and ellipsised the count,
  // then the date — the two facts the row exists for. Two lines, ' · ', no letterSpacing on the format, and a
  // lineHeight so a wrapped tail sits as one block the strip's minHeight grows for.
  ok('the strip: the design name bold on one line + "PDF · 5 days ago · ×2" (WORD for a docx) on up to TWO lines, sentence-case stamps',
    /<Text style=\{s\.design\} numberOfLines=\{1\}/.test(histC) && /<Text style=\{s\.meta\} numberOfLines=\{2\}/.test(histC) && !/<Text style=\{s\.meta\} numberOfLines=\{1\}/.test(histC)
    && /fmt: \{ fontSize: 9\.5/.test(histC) && /days ago/.test(histC) && /×/.test(histSrc) && /WORD/.test(histC));
  ok('⚠️ the meta line is no longer single-line-with-letterSpacing: \' · \' separators (never "  ·  "), a lineHeight on s.meta, no letterSpacing on s.fmt',
    (histC.match(/<Text style=\{s\.metaDot\}>\{' · '\}<\/Text>/g) || []).length >= 2 && !/'  ·  '/.test(histC)
    && /meta: \{[^}]*lineHeight: 14[^}]*\}/.test(histC) && !/meta: \{[^}]*letterSpacing/.test(histC) && !/fmt: \{[^}]*letterSpacing/.test(histC), (histC.match(/(meta|fmt): \{[^}]*\}/g) || []));
  ok('⚠️ no static inline style object anywhere in DownloadHistory: every style={{ is an Animated interpolation, the literals live in the StyleSheet',
    !/style=\{\{\s*[a-zA-Z]+:\s*(?:-?[\d.]+|'[^']*')\s*(?:,\s*[a-zA-Z]+:\s*(?:-?[\d.]+|'[^']*')\s*)*,?\s*\}\}/.test(histC)
    && [...histC.matchAll(/style=\{\{/g)].every((m) => /interpolate\(/.test(histC.slice(m.index, m.index + 300)))
    && /skBarDesign: \{ width: '72%'/.test(histC) && /skBarMeta: \{ width: '48%'/.test(histC) && /headTx: \{ flex: 1 \}/.test(histC) && /lockedIcon: \{ marginTop: 1 \}/.test(histC)
    && /<View style=\{\[s\.skBar, s\.skBarDesign\]\} \/>/.test(histC) && /<View style=\{s\.headTx\}>/.test(histC) && /style=\{s\.lockedIcon\}/.test(histC),
    [...histC.matchAll(/style=\{\{[^]{0,80}/g)].map((m) => m[0].replace(/\s+/g, ' ')));
  // — the brand tint on the shelf, and the page a library tap opens on —
  ok('⚠️ Home\'s brandAccentFor(item): the row\'s OWN kind, the employer\'s saved doc, and only when it IS the document on screen → design.brand.accent, else null (catalogue accent)',
    /const brandAccentFor = useCallback\(\(it: DownloadHistoryItem\): string \| null => \{/.test(homeC) && /if \(!saved \|\| saved\.docId !== doc\.docId\) return null;\s*return doc\.design\?\.brand\?\.accent \|\| null;\s*\}, \[doc, kind, docList\]\);/.test(homeC)
    && /brandAccentFor=\{brandAccentFor\}/.test(homeC));
  ok('DownloadHistory takes it as an OPTIONAL prop and the drawn page tints brandAccent || accent — accentFor(templateId) itself untouched',
    /brandAccentFor\?: \(item: DownloadHistoryItem\) => string \| null;/.test(histC) && /brandAccent=\{brandAccentFor \? brandAccentFor\(it\) : null\}/.test(histC)
    && /<Letterpress accent=\{brandAccent \|\| accent\} letter=\{letter\} \/>/.test(histC) && /accent=\{accentFor\(it\.templateId\)\}/.test(histC));
  {
    const oh = fnBodyOf(homeC, 'openHistoryItem');
    const at = (re) => { const m = re.exec(oh); return m ? m.index : -1; };
    const readAt = at(/const image = \(onDeck && onDeck\.image\)\s*\|\| cachedDocImage\(k, saved\.docId, saved\.updatedAt, item\.templateId\)\s*\|\| \(kept && kept\.image\) \|\| null;/);
    ok('⚠️ openHistoryItem reads the page in the order the card was painted from: the deck on screen → cachedDocImage(kind, docId, updatedAt, templateId) → a kept page — BEFORE the zoom opens and before any render is asked for',
      readAt >= 0 && readAt < at(/setZoom\(\{\s*src: 'library', n, rect: origin, kind: k, doc: zd/) && readAt < at(/fillDocPage\(n, k, saved, item\.templateId\)/)
      && /if \(!image && item\.templateId\) fillDocPage\(n, k, saved, item\.templateId\);/.test(oh), { readAt });
    ok('…the zoomed card of the document on screen wears its brand accent (never a colour change on the way open); any other document keeps accentFor(templateId)',
      /let accent = accentFor\(item\.templateId\);/.test(oh) && /const brand = onScreen \? onScreen\.design\?\.brand\?\.accent : null;\s*if \(brand\) accent = brand;/.test(oh)
      && /id: item\.templateId, name: item\.templateName, accent, image, fit/.test(oh));
  }
  ok('⚠️ collapsed = the first 4 cards + "See all N"; expanded = everything the server sent (no client cap)',
    /const PREVIEW_CARDS = 4;/.test(histC) && /const shown = expanded \? items : items\.slice\(0, PREVIEW_CARDS\);/.test(histC)
    && /items\.length > PREVIEW_CARDS && !expanded/.test(histC) && /See all \{items\.length\}/.test(histC) && !/MAX_ROWS/.test(histC));
  ok('a skeleton grid of 4 glass cards while loading; the fixed empty card stays',
    /function SkeletonCard/.test(histC) && /\[0, 1, 2, 3\]\.map\(\(i\) => <SkeletonCard key=\{i\} index=\{i\} \/>\)/.test(histC) && /function EmptyState/.test(histC));
  ok('the drawn page (no image) is the accent-tinted Letterpress, and it knows a letter from a resume',
    /function Letterpress\(\{ accent, letter \}/.test(histC) && /LETTER_RULES/.test(histC));
  ok('every card is accessible and pressable on the native driver (scale + specular, transform/opacity only)',
    /accessibilityLabel=\{label\}/.test(histC) && /accessibilityRole="button"/.test(histC)
    && (histC.match(/useNativeDriver: true/g) || []).length >= 4 && !/useNativeDriver: false/.test(histC)
    && !/Animated\.(timing|spring|loop)[\s\S]{0,200}(width|height|backgroundColor):/.test(histC));
  ok('Ionicons only, no new icon set', /import \{ Ionicons \} from '@expo\/vector-icons';/.test(histSrc) && !/from '@expo\/vector-icons\/[A-Z]/.test(histSrc) && !/react-native-vector-icons|lucide/.test(histSrc));
  ok('⚠️ the library still NEVER requests its own renders', !/fetch\(/.test(histC) && !/home-cards/.test(histC) && !/employer-cards/.test(histC) && !/warmDocImages|fetchDocCards/.test(histC));

  // — EmployerHome: imageFor resolves from what is in hand; the warm fills the front of the shelf —
  ok('Home wires imageFor (not thumbFor) into the shelf', /<DownloadHistory\n[\s\S]{0,600}?imageFor=\{imageFor\}/.test(homeC) && !/<DownloadHistory\n[\s\S]{0,600}?thumbFor=/.test(homeC));
  ok('Home imports the doc image cache readers from useTargetDoc', /import \{[^}]*\bcachedDocImage\b[^}]*\bwarmDocImages\b[^}]*\} from '\.\/useTargetDoc';/.test(home));
  const imgFor = (homeC.match(/const imageFor = useCallback\(\(it: DownloadHistoryItem\)[\s\S]*?\n  \}, \[kind, docList, thumbFor, libImgVer\]\);/) || [''])[0];
  ok('⚠️ imageFor: per the card\'s OWN kind → that employer\'s saved doc → cachedDocImage(kind, docId, updatedAt, templateId) → a kept page → else the base page for a resume, NOTHING for a letter',
    /const k: DocKind = it\.kind === 'cover_letter' \? 'cover_letter' : 'resume';/.test(imgFor) && /savedDocFor\(docList, who\)/.test(imgFor)
    && /const own = cachedDocImage\(k, saved\.docId, saved\.updatedAt, it\.templateId\)\s*\|\| libPages\.get\(libPageKey\(k, saved, it\.templateId\)\)\?\.image \|\| null;/.test(imgFor)
    && /return k === 'resume' \? thumbFor\(it\.templateId\) : null;/.test(imgFor), imgFor.slice(0, 200));
  ok('⚠️ the warm: the first 8 cards with a saved doc and no cached page, grouped per document, one document at a time, through the injected cards reader',
    /const LIB_WARM = 8;/.test(homeC) && /for \(const it of history\.slice\(0, LIB_WARM\)\)/.test(homeC)
    && /if \(!saved \|\| cachedDocImage\(k, saved\.docId, saved\.updatedAt, it\.templateId\)\) continue;/.test(homeC)
    && /try \{ await warmDocImages\(k, e\.docId, e\.updatedAt, e\.ids, \{ cards \}\); \} catch \{/.test(homeC)
    && /const cards = docLoadersRef\.current\?\.cards;/.test(homeC) && /setLibImgVer\(\(v\) => v \+ 1\)/.test(homeC));
  ok('accentFor also knows the letter formats, so a letter card tints with its own accent', /\|\| LETTER_DESIGNS\.find\(\(d\) => d\.id === templateId\);/.test(homeC));

  // — the client brand (contract 6): the type, the shaping, the deck's accent, the two cache readers —
  ok('employerDocs.ts: Design gains brand?: DesignBrand | null, shaped from the server\'s design.brand',
    /export type DesignBrand = \{/.test(docSvcSrc) && /brand\?: DesignBrand \| null;/.test(docSvcSrc) && /brand: shapeBrand\(raw\.brand\),/.test(docSvcC)
    && /function shapeBrand\(raw: any\): DesignBrand \| null/.test(docSvcC));
  ok('…the accent is a 6-digit hex LOWER-CASED (a brand hashes by its spelling), the family ≤80 chars, google a strict boolean, and no half → null',
    /\.trim\(\)\.toLowerCase\(\) : null\)/.test(docSvcC) && /optStr\(f\.family, 80\)/.test(docSvcC) && /google: f\.google === true/.test(docSvcC)
    && /return accent \|\| font \? \{ accent, font \} : null;/.test(docSvcC));
  ok('⚠️ …and NO fallback from the legacy brandColor: an old document\'s pages were never rendered in it', !/brand: shapeBrand\(raw\.brand\) \|\|/.test(docSvcC) && /NOT "fall back to brandColor"/.test(docSvcSrc));
  ok('useDocDeck: a card wears design.brand.accent when set, else the catalogue accent',
    /const brandAccent = doc\.design\?\.brand\?\.accent \|\| undefined;/.test(docHookC) && /accent: brandAccent \|\| meta\.accent/.test(docHookC));
  ok('useTargetDoc exports cachedDocImage(kind, docId, updatedAt, templateId) and warmDocImages(kind, docId, updatedAt, ids, opts?) over ONE key spelling',
    /export function cachedDocImage\(kind: DocKind, docId: number, updatedAt: string, templateId: string\): string \| null/.test(docHookC)
    && /export function warmDocImages\(\s*kind: DocKind,\s*docId: number,\s*updatedAt: string,\s*ids: string\[\],\s*opts\?: \{ cards\?: DocLoaders\['cards'\] \},\s*\): Promise<void>/.test(docHookC)
    && /const versionKeyOf = \(kind: DocKind, docId: number, updatedAt: string\) =>/.test(docHookC));
  ok('⚠️ the warm is single-flight twice over: the same call in flight is returned, and every wave takes the deck\'s flying lock',
    /const warmFlights = new Map<string, Promise<void>>\(\);/.test(docHookC) && /const inflight = warmFlights\.get\(key\);\s*if \(inflight\) return inflight;/.test(docHookC)
    && /while \(flying\) await landed\(\);/.test(docHookC) && /const WARM_MAX = 10;/.test(docHookC) && !/Animated/.test(docHookC));
  ok('PaperSkeleton draws the employer\'s colour: the band, a faint sidebar rail (0.12) and the title line (0.42)',
    /<View style=\{\[s\.rail,/.test(skelC) && /tint\(accent \|\| '', 0\.12\)/.test(skelC) && /tint\(accent \|\| '', 0\.42\)/.test(skelC));

  // — the preview harness: 5 mixed cards, a locked one and a letter among them; branded fixtures —
  const libFixture = (previewSrc.match(/const RESUME_HISTORY: DownloadHistoryItem\[\] = \[[\s\S]*?\n\];/) || [''])[0];
  ok('home-preview: the resume library is 5 mixed cards — one locked, one a cover letter, one behind "See all"',
    (libFixture.match(/\{ id: \d+, kind:/g) || []).length === 5 && /kind: 'cover_letter'/.test(libFixture) && /unlocked: false/.test(libFixture)
    && /format: 'docx'/.test(libFixture), (libFixture.match(/\{ id: \d+, kind:/g) || []).length);
  ok('…and its documents carry design.brand in the client shape (a colour + web font, and a colour with no font)',
    /brand: \{ accent: '#00205b', font: \{ family: 'Inter', google: true \} \}/.test(previewSrc) && /brand: \{ accent: '#e4003a', font: null \}/.test(previewSrc));
}

// ⚠️ THE RÉSUMÉ GALLERY ZOOMED SOFT FOR THE SAME REASON THE LETTER GALLERY DID (2026-09-18). Its pager pinch-zooms
// a 3x page too, and expo-image cut that page to the frame (allowDownscaling defaults to true) before the zoom ever
// saw it. The fix is the letter gallery's rule, so it is pinned the same way — read from the AST, the prop RUN over
// the page on screen, its neighbours and Android — and then held against both letter pagers, cell for cell: two
// galleries that zoom the same kind of page must not disagree about which page is decoded at full size.
console.log('── ⚠️ THE RÉSUMÉ PAGE BEING ZOOMED IS DECODED AT FULL SIZE, ITS NEIGHBOURS ARE NOT — THE LETTER RULE (2026-09-18) ──');
{
  const SKIP = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments']);
  // Every Image under a ScrollView that pinch-zooms, with the list and the index of the nearest `.map` that draws it.
  const zoomables = (src) => {
    const out = [];
    let ast = null;
    try { ast = parser.parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] }); } catch { return out; }
    const walk = (node, inZoom, loop) => {
      if (Array.isArray(node)) { node.forEach((n) => walk(n, inZoom, loop)); return; }
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed
        && node.callee.property.name === 'map' && node.arguments[0] && /Function/.test(node.arguments[0].type)) {
        const p = node.arguments[0].params[1];
        loop = { list: src.slice(node.callee.object.start, node.callee.object.end), index: p && p.type === 'Identifier' ? p.name : null };
      }
      if (node.type === 'JSXElement') {
        const name = node.openingElement.name.name;
        const attrs = node.openingElement.attributes.filter((a) => a.type === 'JSXAttribute');
        if (name === 'ScrollView' && attrs.some((a) => a.name.name === 'maximumZoomScale')) inZoom = true;
        if (name === 'Image' && inZoom) {
          const a = attrs.find((x) => x.name.name === 'allowDownscaling');
          const e = a && a.value && a.value.type === 'JSXExpressionContainer' ? a.value.expression : null;
          out.push({ list: loop ? loop.list : null, index: loop ? loop.index : null, expr: e ? src.slice(e.start, e.end) : null });
        }
      }
      for (const k of Object.keys(node)) if (!SKIP.has(k) && node[k] && typeof node[k] === 'object') walk(node[k], inZoom, loop);
    };
    walk(ast.program, false, null);
    return out;
  };
  // The prop as a function of (page index, active page, the platform switch), over one fixed table of cases:
  // [the page on screen · iOS, the page before it, the page after it, the first page while page 3 is on screen,
  //  the page on screen · Android, a neighbour · Android]. Run, never pattern-matched.
  const CASES = [[3, 3, true], [2, 3, true], [4, 3, true], [0, 3, true], [3, 3, false], [2, 3, false]];
  const tableOf = (z) => CASES.map(([idx, act, ios]) => {
    if (!z || !z.expr) return 'no prop';
    try { return new Function(z.index || '__noIndex', 'active', 'FULL_RES_ZOOM', 'return (' + z.expr + ');')(idx, act, ios); }
    catch (e) { return 'threw: ' + e.message; }
  });
  const resumeGal = R('../app/(resume-builder)/templates.tsx');
  const resumeGalC = strip(resumeGal);
  const zr = zoomables(resumeGal);
  const z = zr[0];
  const t = tableOf(z);
  ok('the résumé gallery zooms exactly one Image: the page inside its pager', zr.length === 1, zr);
  ok('⚠️ …and that Image says allowDownscaling (the default cut the 3x page to the frame before the pinch saw it)', !!(z && z.expr), z);
  const scrollEnd = fnBodyOf(resumeGalC, 'onScrollEnd');
  ok('…compared against the page\'s OWN index: the (f, i) of visibleFams.map — the very list `active` is clamped to on every swipe',
    !!z && z.list === 'visibleFams' && !!z.index
    && /Math\.min\(raw, visibleFams\.length - 1\)/.test(scrollEnd) && /setActive\(idx\);/.test(scrollEnd), { list: z && z.list, index: z && z.index });
  ok('⚠️ iOS: the résumé page on screen keeps every pixel (allowDownscaling false)', t[0] === false, t);
  ok('…the pages either side of it, and one far away, are still cut to the frame (a 32 MB bitmap per page is not free)',
    t[1] === true && t[2] === true && t[3] === true, t);
  ok('Android (maximumZoomScale is iOS-only — nothing to zoom into) keeps the default on the page on screen and its neighbours',
    t[4] === true && t[5] === true, t);
  ok('the switch is the platform, read once at module scope, exactly as the letter gallery reads it',
    /\nconst FULL_RES_ZOOM = Platform\.OS === 'ios';/.test(resumeGalC)
    && /\nconst FULL_RES_ZOOM = Platform\.OS === 'ios';/.test(strip(R('../app/(cover-letter)/templates.tsx'))));
  const zl = zoomables(R('../app/(cover-letter)/templates.tsx'));
  ok('⚠️ …and it is the SAME rule as both letter pagers, case for case (one gallery sharp where the other is soft is the bug again)',
    zl.length === 2 && zl.every((x) => JSON.stringify(tableOf(x)) === JSON.stringify(t)) && t[0] === false,
    { resume: t, letters: zl.map(tableOf) });
}

// ⚠️ EVERY BOTTOM MENU IS THE SAME SEE-THROUGH PILL (2026-09-18). The menu is drawn in FOUR places: FloatingTabBar,
// and three inline copies of it — Home's own, the Letters screen's (ReviewScreen) and the Jobs tab's JobHubTabBar.
// Making only FloatingTabBar translucent left three tabs with the old opaque white slab and the old pale ink: the
// menu visibly changed as you moved between tabs. So every colour is RESOLVED, not grepped: followed from the
// element through its style sheet, its token object (T.surface, T.textFaint) and its import to the value it
// paints with — and it must arrive THROUGH FloatingTabBar's exported TAB_BAR_FILL / TAB_BAR_INK. A copied hex, a
// file's own T.surface, or an opaque white all fail, whatever a comment beside them says.
console.log('── ⚠️ ALL FOUR BOTTOM MENUS WEAR THE SAME SEE-THROUGH PILL AND THE SAME DARKER INK (2026-09-18) ──');
{
  const SKIP = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments']);
  const loaded = new Map();
  // A file's top-level bindings (plain, exported, functions) and its named imports.
  const load = (abs) => {
    if (loaded.has(abs)) return loaded.get(abs);
    let f = null;
    try {
      const src = fs.readFileSync(abs, 'utf8');
      const ast = parser.parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
      const top = new Map(), imports = new Map(), exported = new Set();
      for (let st of ast.program.body) {
        if (st.type === 'ImportDeclaration') {
          for (const sp of st.specifiers) if (sp.type === 'ImportSpecifier') imports.set(sp.local.name, { from: st.source.value, name: sp.imported.name });
          continue;
        }
        const isExport = st.type === 'ExportNamedDeclaration' && !!st.declaration;
        if (isExport) st = st.declaration;
        if (st.type === 'VariableDeclaration') {
          for (const d of st.declarations) if (d.id.type === 'Identifier' && d.init) { top.set(d.id.name, d.init); if (isExport) exported.add(d.id.name); }
        }
        if (st.type === 'FunctionDeclaration' && st.id) top.set(st.id.name, st);
      }
      f = { abs, src, ast, top, imports, exported };
    } catch { f = null; }
    loaded.set(abs, f);
    return f;
  };
  // A name → the node bound to it, in this file or across a relative import; every binding crossed goes on the trail.
  const bind = (f, name, trail) => {
    if (f.top.has(name)) { trail.push(f.abs + '#' + name); return { f, node: f.top.get(name) }; }
    const im = f.imports.get(name);
    if (!im || !im.from.startsWith('.')) return null;
    const base = path.resolve(path.dirname(f.abs), im.from);
    const file = ['', '.js', '.ts', '.tsx'].map((x) => base + x).find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    const g = file && load(file);
    if (!g || !g.exported.has(im.name)) return null;       // an import of something that file does not export binds to nothing
    trail.push(g.abs + '#' + im.name);
    return { f: g, node: g.top.get(im.name) };
  };
  const unwrap = (n) => { while (n && /^(TSAsExpression|TSSatisfiesExpression|TSNonNullExpression|ParenthesizedExpression)$/.test(n.type)) n = n.expression; return n; };
  // The LAST property of a name wins, as it does at runtime.
  const propOf = (obj, key) => {
    let v = null;
    for (const p of obj.properties) {
      if (p.type === 'ObjectProperty' && !p.computed && ((p.key.type === 'Identifier' && p.key.name === key) || (p.key.type === 'StringLiteral' && p.key.value === key))) v = p.value;
    }
    return v;
  };
  // The object literal an expression names: a token object, StyleSheet.create({…}), or one entry of either.
  const objOf = (f, n, trail) => {
    n = unwrap(n);
    if (!n) return null;
    if (n.type === 'ObjectExpression') return { f, node: n };
    if (n.type === 'Identifier') { const b = bind(f, n.name, trail); return b ? objOf(b.f, b.node, trail) : null; }
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.name === 'StyleSheet' && n.callee.property.name === 'create') return objOf(f, n.arguments[0], trail);
    if (n.type === 'MemberExpression' && !n.computed) { const o = objOf(f, n.object, trail); const p = o && propOf(o.node, n.property.name); return p ? objOf(o.f, p, trail) : null; }
    return null;
  };
  // An expression → the colour string it paints with, and the trail of bindings it came through.
  const valueOf = (f, n, trail) => {
    n = unwrap(n);
    if (n && n.type === 'StringLiteral') return { value: n.value, trail };
    if (n && n.type === 'TemplateLiteral' && !n.expressions.length) return { value: n.quasis[0].value.cooked, trail };
    if (n && n.type === 'Identifier') { const b = bind(f, n.name, trail); return b ? valueOf(b.f, b.node, trail) : { value: undefined, trail }; }
    if (n && n.type === 'MemberExpression' && !n.computed) { const o = objOf(f, n.object, trail); const p = o && propOf(o.node, n.property.name); return p ? valueOf(o.f, p, trail) : { value: undefined, trail }; }
    return { value: undefined, trail };
  };
  // One key of a `style={…}`: a sheet entry, an inline object, or an array of them — the last one that sets it wins.
  const styleOf = (f, expr, key) => {
    expr = unwrap(expr);
    let out = { value: undefined, trail: [], node: null, f: null };
    for (const part of (expr && expr.type === 'ArrayExpression' ? expr.elements : [expr])) {
      const trail = [];
      const o = objOf(f, part, trail);
      const p = o && propOf(o.node, key);
      if (p) out = { ...valueOf(o.f, p, trail), node: p, f: o.f };
    }
    return out;
  };
  const attrOf = (el, n) => {
    const a = el.openingElement.attributes.find((x) => x.type === 'JSXAttribute' && x.name.name === n);
    return !a || !a.value ? null : a.value.type === 'JSXExpressionContainer' ? a.value.expression : a.value;
  };
  const tagOf = (el) => (el.openingElement.name.type === 'JSXIdentifier' ? el.openingElement.name.name : null);
  const walk = (node, visit, ctx) => {
    if (Array.isArray(node)) { for (const x of node) walk(x, visit, ctx); return; }
    if (!node || typeof node.type !== 'string') return;
    const next = visit(node, ctx);
    for (const k of Object.keys(node)) if (!SKIP.has(k) && node[k] && typeof node[k] === 'object') walk(node[k], visit, next);
  };
  // How much of the page a colour lets through: 1 = opaque. Anything this cannot read counts as OPAQUE.
  const alphaOf = (c) => {
    const s = String(c || '').trim().toLowerCase();
    let m;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) return 1;
    if ((m = s.match(/^#[0-9a-f]{6}([0-9a-f]{2})$/))) return parseInt(m[1], 16) / 255;
    if ((m = s.match(/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(\d*\.?\d+)\s*\)$/))) return Number(m[1]);
    if (s === 'transparent') return 0;
    return 1;
  };

  const TAB = path.join(__dirname, '../components/FloatingTabBar.js');
  const tabF = load(TAB);
  const FILL = tabF ? valueOf(tabF, tabF.top.get('TAB_BAR_FILL'), []).value : undefined;
  const INK = tabF ? valueOf(tabF, tabF.top.get('TAB_BAR_INK'), []).value : undefined;
  ok('FloatingTabBar EXPORTS the two values every other menu takes (TAB_BAR_FILL, TAB_BAR_INK)',
    !!tabF && tabF.exported.has('TAB_BAR_FILL') && tabF.exported.has('TAB_BAR_INK') && !!FILL && !!INK, { FILL, INK });
  const through = (r, name) => r.trail.includes(TAB + '#' + name);

  const MENUS = [
    { name: 'FloatingTabBar', file: '../components/FloatingTabBar.js', pill: 'styles.bar', inactive: 1 },
    { name: 'HomeScreen (Home\'s own menu)', file: '../components/HomeScreen.js', pill: 'tabStyles.bar', inactive: 3 },
    { name: 'ReviewScreen (the Letters menu)', file: '../components/ReviewScreen.js', pill: 'rStyles.tabBar', inactive: 3 },
    { name: 'JobHubTabBar (the Jobs menu)', file: '../app/(ai-hub)/index.tsx', pill: 'tabStyles.bar', inactive: 1, inFn: 'JobHubTabBar' },
  ];
  const opaque = [];
  for (const M of MENUS) {
    const f = load(path.join(__dirname, M.file));
    const scope = f && (M.inFn ? f.top.get(M.inFn) : f.ast.program);
    if (!scope) { ok(M.name + ': the file parses and the menu is where it was', false, M.file); opaque.push(M.name); continue; }
    // The pill: the one View whose style is that sheet entry.
    const pills = [];
    walk(scope, (n) => {
      if (n.type === 'JSXElement' && tagOf(n) === 'View') {
        const e = unwrap(attrOf(n, 'style'));
        const parts = e && e.type === 'ArrayExpression' ? e.elements : [e];
        if (parts.some((p) => p && f.src.slice(p.start, p.end) === M.pill)) pills.push(n);
      }
      return null;
    }, null);
    const pill = pills.length === 1 ? pills[0] : null;
    const fill = pill ? styleOf(f, attrOf(pill, 'style'), 'backgroundColor') : { value: undefined, trail: [] };
    ok(`${M.name}: its pill (${M.pill}) is painted with FloatingTabBar's TAB_BAR_FILL`,
      !!pill && through(fill, 'TAB_BAR_FILL') && fill.value === FILL, { pills: pills.length, value: fill.value });
    if (!pill || !(alphaOf(fill.value) < 1)) opaque.push(`${M.name} → ${fill.value}`);
    // The hairline white rim that keeps the see-through pill's edge crisp over the dark Home.
    const rimW = pill ? styleOf(f, attrOf(pill, 'style'), 'borderWidth') : {};
    const rimC = pill ? styleOf(f, attrOf(pill, 'style'), 'borderColor') : {};
    ok(`${M.name}: …with the hairline white rim that keeps its edge on a dark page`,
      !!rimW.node && rimW.f.src.slice(rimW.node.start, rimW.node.end) === 'StyleSheet.hairlineWidth'
      && /^rgba\(255,\s*255,\s*255,\s*0?\.\d+\)$/.test(String(rimC.value)), { width: rimW.node && rimW.f.src.slice(rimW.node.start, rimW.node.end), color: rimC.value });
    // Inactive tabs: every icon and label in the pill that is NOT inside the active tab's gradient.
    const icons = [], labels = [];
    if (pill) {
      walk(pill, (n, inActive) => {
        if (n.type !== 'JSXElement') return inActive;
        if (tagOf(n) === 'LinearGradient') return true;
        if (!inActive && tagOf(n) === 'Ionicons') icons.push(n);
        if (!inActive && tagOf(n) === 'Text') labels.push(n);
        return inActive;
      }, false);
    }
    const iconInk = icons.map((el) => valueOf(f, attrOf(el, 'color'), []));
    const labelInk = labels.map((el) => styleOf(f, attrOf(el, 'style'), 'color'));
    ok(`${M.name}: every inactive icon (${M.inactive}) is TAB_BAR_INK`,
      icons.length === M.inactive && iconInk.every((r) => through(r, 'TAB_BAR_INK') && r.value === INK), iconInk.map((r) => r.value));
    ok(`${M.name}: …and so is every inactive label (${M.inactive})`,
      labels.length === M.inactive && labelInk.every((r) => through(r, 'TAB_BAR_INK') && r.value === INK), labelInk.map((r) => r.value));
  }
  ok('⚠️ none of the four still paints its pill with an opaque surface colour (every pill lets the page through)',
    opaque.length === 0 && alphaOf(FILL) < 1, opaque);
}

/**
 * The image cache readers run for real: useTargetDoc.ts transpiled with a fake require — react's hooks as plain
 * functions (a deck built once, no re-render), the account fixed, fetchDocCards a spy. Proves the contract the
 * shelf leans on: waves of ≤5 / ≤3, single-flight, the same key as the deck, dead ids never re-asked, a failed
 * wave ends the warm, a gone version is never asked again, the cap, and the deck's brand accent.
 */
async function libraryPhase() {
  console.log('── ⚠️ warmDocImages / cachedDocImage / useDocDeck, run for real (2026-09-15) ──');
  const calls = [];
  const GOOD = (kind, docId, ids) => ({ cards: ids.filter((id) => id !== 'g').map((id) => ({ id, name: id.toUpperCase(), accent: '#123456', image: 'img-' + id })) });
  let answer = GOOD;
  const react = { useCallback: (f) => f, useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }), useState: (v) => [typeof v === 'function' ? v() : v, () => {}] };
  const fakeReq = (id) => {
    if (id === 'react') return react;
    if (/homeAddEmployer/.test(id)) return { signedInAccount: async () => 'acct-1' };
    if (/services\/employerDocs/.test(id)) return { fetchDocCards: async (kind, docId, ids) => { calls.push({ kind, docId, ids: ids.slice() }); return answer(kind, docId, ids); }, cachedCurrentDoc: () => undefined, docLookupOf: () => null, fetchCurrentDoc: async () => null, fetchDocList: async () => null, rememberDoc: () => {} };
    return {};
  };
  let U = null;
  try {
    const js = ts.transpileModule(docHookSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
    const m = { exports: {} };
    new Function('module', 'exports', 'require', js)(m, m.exports, fakeReq);
    U = m.exports;
  } catch (e) { ok('useTargetDoc.ts loads under a fake require', false, String(e.message).split('\n')[0]); return; }
  ok('nothing is cached before a warm; a missing id/version is never a key', U.cachedDocImage('resume', 5, 'u1', 'a') === null && U.cachedDocImage('resume', 0, 'u1', 'a') === null && U.cachedDocImage('resume', 5, '', 'a') === null);
  const p1 = U.warmDocImages('resume', 5, 'u1', ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  const p2 = U.warmDocImages('resume', 5, 'u1', ['g', 'f', 'e', 'd', 'c', 'b', 'a']);
  ok('⚠️ single-flight: the same warm (version + ids, any order) in flight IS the same promise', p1 === p2 && p1 instanceof Promise);
  await p1;
  ok('resume waves of ≤5, in order, for that document', calls.length === 2 && calls[0].ids.join() === 'a,b,c,d,e' && calls[1].ids.join() === 'f,g' && calls.every((c) => c.kind === 'resume' && c.docId === 5), calls);
  ok('the pages are readable back through cachedDocImage', U.cachedDocImage('resume', 5, 'u1', 'a') === 'img-a' && U.cachedDocImage('resume', 5, 'u1', 'f') === 'img-f' && U.cachedDocImage('resume', 5, 'u2', 'a') === null);
  await U.warmDocImages('resume', 5, 'u1', ['g', 'a']);
  ok('⚠️ an id the reply left out is dead for that version: null, and never asked again; a cached id is not re-asked', U.cachedDocImage('resume', 5, 'u1', 'g') === null && calls.length === 2, calls.length);
  calls.length = 0;
  await U.warmDocImages('cover_letter', 9, 'u2', ['ats_pro', 'german', 'technical', 'graduate']);
  ok('letter waves of ≤3', calls.length === 2 && calls[0].ids.length === 3 && calls[1].ids.join() === 'graduate' && calls.every((c) => c.kind === 'cover_letter'), calls);
  calls.length = 0;
  await U.warmDocImages('resume', 6, 'u1', Array.from({ length: 14 }, (_, i) => 't' + i));
  ok('a warm is capped at 10 ids (two resume waves), whatever it was handed', calls.length === 2 && calls.reduce((n, c) => n + c.ids.length, 0) === 10, calls.map((c) => c.ids.length));
  calls.length = 0; answer = () => { throw new Error('renderer down'); };
  let rejected = false;
  await U.warmDocImages('resume', 7, 'u1', ['a', 'b', 'c', 'd', 'e', 'f']).catch(() => { rejected = true; });
  ok('⚠️ a loader that throws: the warm resolves (never rejects) after ONE wave — the rest is not chained into a failing renderer', !rejected && calls.length === 1, { rejected, calls: calls.length });
  answer = GOOD;
  await U.warmDocImages('resume', 7, 'u1', ['a', 'b']);
  ok('…and those ids are backed off, not re-asked at once', calls.length === 1, calls.length);
  calls.length = 0; answer = () => 'gone';
  await U.warmDocImages('resume', 8, 'u1', ['a']);
  answer = GOOD;
  await U.warmDocImages('resume', 8, 'u1', ['b', 'c']);
  ok('⚠️ a version the server says is GONE is never asked for again (a re-lookup, never a rebuild)', calls.length === 1 && U.cachedDocImage('resume', 8, 'u1', 'a') === null, calls.length);
  calls.length = 0;
  await U.warmDocImages('resume', 5, 'u1', []); await U.warmDocImages('resume', 0, 'u1', ['a']); await U.warmDocImages('resume', 5, '', ['a']); await U.warmDocImages('resume', 5, 'u1', null);
  ok('no ids / no doc / no version → resolves without a request', calls.length === 0, calls.length);
  const catalogue = [{ id: 'a', name: 'A', accent: '#0a7aa6' }, { id: 'zz', name: 'ZZ', accent: '#111111' }];
  const doc = { docId: 5, kind: 'resume', updatedAt: 'u1', design: { ranked: [{ id: 'a', score: 90, reason: 'fits' }], brand: { accent: '#e30613', font: null } } };
  let deck = null, err = null;
  try { deck = U.useDocDeck('resume', doc, catalogue, 0, { enabled: false }).deck; } catch (e) { err = e; }
  ok('⚠️ useDocDeck: every card wears design.brand.accent, and reads the SAME image store the warm filled (one key for deck and shelf)',
    !err && deck && deck[0].id === 'a' && deck[0].accent === '#e30613' && deck[0].image === 'img-a' && deck[0].fit === 90 && deck[1].id === 'zz' && deck[1].accent === '#e30613', err ? String(err.message) : deck);
  let plain = null;
  try { plain = U.useDocDeck('resume', { ...doc, design: { ranked: [{ id: 'a', score: 90 }] } }, catalogue, 0, { enabled: false }).deck; } catch (e) { err = e; }
  ok('…and the catalogue accent when the document has no brand', plain && plain[0].accent === '#0a7aa6' && plain[1].accent === '#111111', plain);
}

/**
 * fetchDocCards, run for real (2026-09-18): employerDocs.ts transpiled with a fake require and a fetch SPY — the
 * URL it builds is the whole contract. The letter gallery pinch-zooms to 3x, so it must get the full rendered page
 * (size=page); a 480-px card zoomed 3x was the "very much blurry" report. Every other caller must still get the
 * card — the page is several times the bytes, and Home's shelf and deck never zoom. And the gallery's OWN call is
 * replayed through the real function, so "the gallery asks for it" is proven by the request, not by a regex.
 */
async function pageSizePhase() {
  console.log('── ⚠️ THE LETTER GALLERY GETS THE FULL PAGE (size=page); EVERY OTHER CALLER STILL GETS THE CARD (2026-09-18) ──');
  const urls = [];
  const spyFetch = async (url) => {
    urls.push(String(url));
    return { status: 200, ok: true, json: async () => ({ cards: [{ id: 'ats_pro', name: 'ATS Pro', image: 'https://img.test/ats_pro.webp' }] }) };
  };
  const fakeReq = (id) => {
    if (id === 'expo-secure-store') return { getItemAsync: async () => JSON.stringify({ token: 'tok-1' }) };
    if (/(^|\/)config$/.test(id)) return { API_BASE: 'https://api.test' };
    if (/homeAddEmployer/.test(id)) return { signedInAccount: async () => 'acct-1' };
    if (/employerHomeService/.test(id)) return { deviceHeaders: async () => ({}), cachedJobListing: () => null, cleanJobUrl: (u) => u, keepJobListings: () => {} };
    return {};
  };
  let D = null;
  try {
    const js = ts.transpileModule(docSvcSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
    const m = { exports: {} };
    // `fetch` is a parameter, so the module's global fetch is the spy — nothing here can reach a real network.
    new Function('module', 'exports', 'require', 'fetch', js)(m, m.exports, fakeReq, spyFetch);
    D = m.exports;
  } catch (e) { ok('employerDocs.ts loads under a fake require and a fetch spy', false, String(e.message).split('\n')[0]); return; }
  ok('employerDocs.ts loads under a fake require and a fetch spy', typeof D.fetchDocCards === 'function');
  if (typeof D.fetchDocCards !== 'function') return;
  // One call → the single request it made (path + query), and what it answered.
  const ask = async (...args) => {
    urls.length = 0;
    let r = null;
    try { r = await D.fetchDocCards(...args); } catch (e) { r = 'threw: ' + e.message; }
    const u = urls.length === 1 ? new URL(urls[0]) : null;
    return { n: urls.length, path: u && u.pathname, q: u ? u.searchParams : new URLSearchParams(), r };
  };
  const brief = (x) => ({ n: x.n, path: x.path, query: String(x.q) });

  const page = await ask('cover_letter', 42, ['ats_pro', 'german'], { size: 'page' });
  ok('⚠️ a letter asked for the page: ONE request to /cover-letter/employer-cards carrying size=page, once',
    page.n === 1 && page.path === '/cover-letter/employer-cards' && page.q.getAll('size').join() === 'page', brief(page));
  ok('…the document and the ids ride with it unchanged, and the page comes back as cards',
    page.q.get('doc') === '42' && page.q.get('ids') === 'ats_pro,german'
    && page.r && Array.isArray(page.r.cards) && page.r.cards[0].id === 'ats_pro' && page.r.cards[0].image === 'https://img.test/ats_pro.webp',
    { query: String(page.q), r: page.r });
  const plain = await ask('cover_letter', 42, ['ats_pro']);
  const empty = await ask('cover_letter', 42, ['ats_pro'], {});
  const card = await ask('cover_letter', 42, ['ats_pro'], { size: 'card' });
  ok('⚠️ a letter NOT asking (no options, empty options, size: \'card\') gets the 480-px card: no size in the query at all',
    [plain, empty, card].every((x) => x.n === 1 && x.path === '/cover-letter/employer-cards' && !x.q.has('size') && x.q.get('doc') === '42'),
    [plain, empty, card].map(brief));
  const resume = await ask('resume', 42, ['classic'], { size: 'page' });
  ok('⚠️ a RÉSUMÉ asking for the page gets no size=page (only letters have a page/card split on the server)',
    resume.n === 1 && resume.path === '/resume-builder/home-cards' && !resume.q.has('size') && resume.q.get('ids') === 'classic', brief(resume));

  // The letter gallery's own call, replayed: its kind and its options object, exactly as written, into the real function.
  const galSrc = R('../app/(cover-letter)/templates.tsx');
  const calls = [];
  try {
    const ast = parser.parse(galSrc, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    const SKIP = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments']);
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'fetchDocCards') calls.push(node);
      for (const k of Object.keys(node)) if (!SKIP.has(k) && node[k] && typeof node[k] === 'object') walk(node[k]);
    };
    walk(ast.program);
  } catch {}
  const replays = [];
  for (const c of calls) {
    const kind = c.arguments[0] && c.arguments[0].type === 'StringLiteral' ? c.arguments[0].value : null;
    let opts;
    try { opts = c.arguments[3] ? new Function('return (' + galSrc.slice(c.arguments[3].start, c.arguments[3].end) + ');')() : undefined; }
    catch (e) { opts = 'unreadable: ' + e.message; }
    const x = await ask(kind, 42, ['ats_pro'], opts);
    replays.push({ kind, opts, ...brief(x), size: x.q.get('size') });
  }
  ok('⚠️ the letter gallery\'s every fetchDocCards call, replayed through the real function, reaches the server with size=page',
    calls.length >= 1 && replays.every((x) => x.kind === 'cover_letter' && x.n === 1 && x.path === '/cover-letter/employer-cards' && x.size === 'page'),
    { calls: calls.length, replays });

  // …and nobody else: the app's own sources, comments stripped. `size: 'page'` only in the letter gallery, and the
  // literal `size=page` only where fetchDocCards builds it.
  const ROOTS = ['app', 'components', 'services', 'hooks', 'utils', 'constants'];
  const sources = [];
  const collect = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') collect(p); }
      else if (/\.(js|jsx|ts|tsx)$/.test(e.name)) sources.push(p);
    }
  };
  for (const r of ROOTS) collect(path.join(__dirname, '..', r));
  const rel = (p) => path.relative(path.join(__dirname, '..'), p);
  const asksPage = sources.filter((p) => /\bsize\s*:\s*['"]page['"]/.test(strip(fs.readFileSync(p, 'utf8')))).map(rel);
  const buildsPage = sources.filter((p) => /size=page/.test(strip(fs.readFileSync(p, 'utf8')))).map(rel);
  ok('⚠️ only the letter gallery asks for the page — Home\'s deck, shelf and warm (which never zoom) still get the card',
    sources.length > 20 && asksPage.length === 1 && asksPage[0] === path.join('app', '(cover-letter)', 'templates.tsx'), asksPage);
  ok('…and size=page is built in exactly one place: fetchDocCards', buildsPage.length === 1 && buildsPage[0] === path.join('services', 'employerDocs.ts'), buildsPage);
}

/**
 * ⚠️ THE "DESIGNING FOR" ROW IS A SAVED ROSTER (2026-09-19). The owner (user 1, TestFlight b209) removed the four
 * lead employers and hid eight postings at 16:11 IST; the reload twenty seconds later refilled the row with four
 * government agencies (Moroccan Ministry of Employment, Department of Employment SA, Ministry of Labour, Iskur) and
 * three strangers (MOM Ranch, Linum, N/A) — and at 22:02, on the letter tab, with Konnekt ×3 and three other Airbus
 * roles. No server row had changed: fetchTargets simply ranked a fresh top 12 on every load. These run the REAL
 * fetchTargetAnswer (against a fake server shaped like the production rows) and the REAL homeRoster merge, and
 * replay that session.
 */
async function rosterPhase() {
  console.log('── ⚠️ THE "DESIGNING FOR" ROW IS A SAVED ROSTER: NO REFILL, NO RESET, THE SELECTION KEPT BY KEY (2026-09-19) ──');
  const rosterSrc = R('../services/homeRoster.ts');
  const envSrcR = R('../app/(admin)/environment.tsx');
  const rosterC = strip(rosterSrc);
  const transpileR = (src) => ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const loadR = (src, req) => { const m = { exports: {} }; new Function('module', 'exports', 'require', transpileR(src))(m, m.exports, req); return m.exports; };

  // ── source: the screen commits the MERGED row, never the raw ranking ──
  ok('homeRoster.ts is a new AI Hub file with the required first line',
    rosterSrc.split('\n')[0] === '// AI Hub — new feature. Safe to delete without affecting existing app.');
  ok('⚠️ load() merges the answer into the saved row and commits THAT (never the raw fetch) — through planRow',
    /const plan = planRow\(savedRow, answer, \{ removed: removedNow, added: addedHere, shown: before\.length, refused \}\);\s*const m = plan\.merged;/.test(homeC)
    && /const t = plan\.keep \? before : mergeAdded\(refused \? \[\] : m\.row, pickedKey\);/.test(homeC)
    && !/\bmergeRoster\(/.test(homeC)
    && !/fetched\.filter\(\(x\) => !removedNow\(x\.key\)\)/.test(homeC) && !/\bfetchTargets\b/.test(homeC));
  ok('⚠️ …and a chip that left never sends the selection back to the first chip (no `setEmpIdx(j >= 0 ? j : 0)` + pin reset)',
    !/setEmpIdx\(j >= 0 \? j : 0\)/.test(homeC) && !/if \(j < 0\) pickedKey\.current = null/.test(homeC)
    && /j = oldAt >= 0 \? Math\.min\(oldAt, t\.length - 1\) : saved;/.test(homeC));
  ok('⚠️ the row is taken from memory and saved in the SAME tick (an edit between two awaits cannot be written away)',
    /const picked = !loaders && owner \? savedRowOf\(owner, rosterCopy\(owner\) \|\| stored, acct \? remote : undefined\) : null;\s*const savedRow: Roster \| null \| undefined = loaders \? previewRoster\.current : picked \? picked\.row : undefined;/.test(homeC)
    && /else if \(acct && plan\.save\) keepRoster\(acct, kept\);/.test(homeC));
  ok('⚠️ the saved row paints before the network answers — but only once the ACCOUNT has been read (or the one it still is)',
    /claiming\.then\(async \(\{ who \}\) => \{\s*const \{ acct, owner \} = rowAccounts\(who, cacheOwner\);\s*if \(!owner\) return;\s*const saved = await readRoster\(owner\);/.test(homeC)
    && /await \(warm = warmJobListings\(\)\);\s*if \(committed \|\|[^\n]*cacheOwner !== owner\) return;/.test(homeC) && /\{loading && !targets\.length \? \(/.test(home));
  // ⚠️ REVIEW 2026-09-19 (round 1): an unreadable session merged against NOTHING (the raw ranking for one load), and a
  // load that finished after its screen had gone saved its own stale selection over the remounted screen's.
  const loadBody = (homeC.match(/const load = useCallback\([\s\S]*?\n  \}, \[\]\);/) || [''])[0];
  const aliveAt = loadBody.indexOf('if (seq !== loadSeq.current || !alive.current) return undefined;');
  ok('⚠️ load() picks its accounts through rowAccounts (an unreadable session merges against cacheOwner\'s row) and SAVES only under the account it read',
    /const \{ acct, owner \} = !loaders && !refused \? rowAccounts\(claim\.who, cacheOwner\) : \{ acct: null, owner: null \};\s*const stored = owner \? await readRoster\(owner\) : undefined;/.test(loadBody)
    && /else if \(acct && plan\.save\) keepRoster\(acct, kept\);/.test(loadBody) && !/keepRoster\(owner/.test(loadBody));
  ok('⚠️ a load whose screen has GONE writes nothing: the alive check follows its LAST await and precedes the merge and the save',
    aliveAt > loadBody.indexOf('await readRoster(owner)') && loadBody.indexOf('await readRoster(owner)') > 0
    && aliveAt < loadBody.indexOf('committed = true;') && aliveAt < loadBody.indexOf('planRow(') && aliveAt < loadBody.indexOf('keepRoster(acct, kept)')
    && !/\bawait\b/.test(loadBody.slice(aliveAt, loadBody.indexOf('keepRoster(acct, kept)'))), aliveAt);
  ok('the preview harness keeps its roster with the mount, in memory (its fixture list is a complete answer)',
    /\.then\(listAnswer\)/.test(homeC) && /if \(loaders\) previewRoster\.current = kept;/.test(homeC));
  const rmBody = (homeC.match(/const removeChip = \(i: number\) => \{[\s\S]*?\n  \};/) || [''])[0];
  const dropBody = fnBodyOf(homeC, 'dropChip');
  const restoreBody = fnBodyOf(homeC, 'restoreChip');
  const restorePostBody = fnBodyOf(homeC, 'restorePostings');
  const addBody = fnBodyOf(homeC, 'addEmployerHere');
  ok('⚠️ every user flow edits the saved row: the X at once, the exit, an Undo (held), an add (held, provisional), a restore (before its read)',
    /editRow\(\(ro\) => rosterRemove\(ro, t\.key\)\);/.test(rmBody)
    && dropBody.indexOf('rosterRemove(ro, leaving.key)') > 0 && dropBody.indexOf('rosterRemove(ro, leaving.key)') < dropBody.indexOf('if (!alive.current) return;')
    && /rosterPlace\(ro, t, \{ after: front, replaces: r\.t\.key, hold: true, provisional: !!as \}\)/.test(restoreBody)
    && restoreBody.indexOf('rosterPlace(') < restoreBody.indexOf('if (!alive.current) return;')
    && /rosterPlace\(ro, real, \{ after: keysBefore\(shownNow, at\), replaces: pending\.key, hold: true, provisional: true \}\)/.test(addBody)
    && restorePostBody.indexOf('rosterPlace(ro, chip, { after, hold: true, provisional: true })') > 0
    && restorePostBody.indexOf('rosterPlace(ro, chip') < restorePostBody.indexOf('await load(true)'));
  ok('⚠️ every selection (a tap, a landing, a neighbour, an add) is saved with the row',
    /const selKey = targets\[empIdx\]\?\.key \?\? null;\s*useEffect\(\(\) => \{\s*if \(selKey\) editRow\(\(r\) => rosterSelect\(r, selKey\)\);/.test(homeC));
  ok('⚠️ an unreadable session is NOT another account: only a different, readable one wipes',
    /if \(who === null \|\| who === cacheOwner\) return \{ wiped: false, who \};/.test(homeC) && /const wipe = cacheOwner !== null;/.test(homeC)
    && !/cacheOwner !== null \|\| who === null/.test(homeC) && /forgetRosterCopy\(\);/.test(fnBodyOf(homeC, 'forgetAccountCache')));
  ok('the saved rows are cleared with the environment (they hold one backend\'s UUIDs and URLs)',
    // (raw source: the file's comments hold a '/*' glob that the block-comment strip would eat the list with)
    /^\s*'home_roster_v1:',/m.test(envSrcR.match(/export const PREFIXES_TO_CLEAR: string\[\] = \[[\s\S]*?\n\];/)?.[0] || '')
    && /export const ROSTER_PREFIX = 'home_roster_v1:';/.test(rosterC));
  ok('fetchTargets is still the ranking, now read off fetchTargetAnswer',
    /export async function fetchTargets\(\): Promise<Target\[\]> \{\s*return \(await fetchTargetAnswer\(\)\)\.ranked;\s*\}/.test(svcC)
    && /export async function fetchTargetAnswer\(\): Promise<TargetAnswer>/.test(svcC));
  // The evidence rules stand on what the server actually sends — assert those facts, not our reading of them.
  ok('⚠️ evidence the rules rest on: the dashboard lists EVERY watching employer (no LIMIT) and each posting\'s created_at; saved cards carry saved_at, 500 at most',
    /WHERE ute\.user_id = \$1 AND ute\.status = 'watching'\s*ORDER BY ute\.updated_at DESC`/.test(jobSvcC)
    && /createdAt: jRow\.created_at,/.test(jobSvcC)
    && /ORDER BY saved_at DESC LIMIT 500/.test(discC) && /saved_at: savedAt/.test(discC)
    && /const SAVED_READ_LIMIT = 500;/.test(svcC) && /savedKeys: savedOk && saved\.jobs\.length < SAVED_READ_LIMIT \? savedKeys : null,/.test(svcC));

  // ── behaviour: the real service + the real roster, against a fake server ──
  const store = new Map();
  let storeThrows = false;
  let storeReads = 0;
  const asyncStore = { __esModule: true, default: {
    getItem: async (k) => { storeReads++; if (storeThrows) throw new Error('storage'); return store.has(k) ? store.get(k) : null; },
    setItem: async (k, v) => { if (storeThrows) throw new Error('storage'); store.set(k, v); },
    removeItem: async (k) => { store.delete(k); },
    multiRemove: async (ks) => { for (const k of ks) store.delete(k); },
  } };
  // The signed-in user the session names (the server-copy cases switch it to 616 mid-flight).
  let sessionUser = 1;
  const secure = { getItemAsync: async (k) => (k === 'userSession' ? JSON.stringify({ token: 'TKN', id: sessionUser }) : null), setItemAsync: async () => {} };
  let ehs = null, RO = null, docs = null;
  try {
    const base = (id) => (id === './deviceId' ? { getDeviceId: async () => 'dev-1' } : /secure-store/.test(id) ? secure
      : /async-storage/.test(id) ? asyncStore : /config/.test(id) ? { API_BASE: 'https://api.test' } : null);
    ehs = loadR(svc, (id) => base(id) || {});
    RO = loadR(rosterSrc, (id) => (/employerHomeService/.test(id) ? ehs : base(id) || {}));
    docs = loadR(docSvcSrc, (id) => (/employerHomeService/.test(id) ? ehs : /homeAddEmployer/.test(id) ? { signedInAccount: async () => 'u:1' } : base(id) || {}));
  } catch (e) { console.log('     (roster harness did not load: ' + String(e.message).split('\n')[0] + ')'); }
  ok('homeRoster, employerHomeService and employerDocs load for real', !!(RO && typeof RO.mergeRoster === 'function' && ehs && typeof ehs.fetchTargetAnswer === 'function' && docs && typeof docs.docLookupOf === 'function'));
  if (!RO || !ehs || !docs) return;

  // The server, shaped like user 1's production rows (dashboard in ute.updated_at DESC order, jobs by match).
  const T0 = Date.parse('2026-09-10T10:00:00Z');
  const DAY = 86400000;
  const iso = (t) => new Date(t).toISOString();
  let jn = 0;
  const job = (url, title, score, at = T0) => ({ id: 'jid-' + (++jn), title, applyUrl: url, matchScore: score, createdAt: iso(at), skills: ['Project Management'], location: 'Toulouse' });
  const WD = 'https://ag.wd3.myworkdayjobs.com/Airbus/job/';
  const J = {
    amazon: job('https://www.amazon.jobs/en/jobs/10489696/software-development-engineer-ii-adbl183', 'Software Development Engineer II (ADBL183)', 100),
    insp: job(WD + 'Maulte-Area/Airbus-Atlantic---Inspecteur-Qualit-A350--All-Gender-_JR10437331', 'Airbus Atlantic - Inspecteur Qualité A350 (All Gender)', 100),
    arch: job(WD + 'Paris-Area/Architecte-cyberscurit--f-h-_JR10420133', 'Architecte cybersécurité (f/h)', 100),
    spc: job(WD + 'Belfast/Senior-Programme-Coordinator_JR10438301', 'Senior Programme Coordinator', 100),
    cyber: job(WD + 'Toulouse-Area/Cyber-Security-Manager_JR10438717', 'Cyber Security Manager', 100),
    risk: job(WD + 'Toulouse-Area/RISK---PERFORMANCE-PROJECT-MANAGER--D-M-F-_JR10431111', 'RISK & PERFORMANCE PROJECT MANAGER (D/M/F)', 100),
    pl: job(WD + 'Hamburg-Area/Project-Leader_JR10432222', 'Project Leader', 90),
    iwell: job('https://www.wearedevelopers.com/jobs/ext/7195904/senior-net-entwickler-4-tage-woche-und-homeoffice-moglich', 'Senior .NET Developer', 100),
    werken: job('https://jobs.werkenvoornederland.nl/job/Amersfoort-Software-Engineer-3818-LN/1354948357', 'Software Engineer', 95),
    cvb: job('https://www.cvbankas.lt/project-manager-1', 'Project Manager', 90),
    mom: job('https://www.jobberman.com/listings/project-manager-rrreg5', 'Project Manager', 90),
    linum: job('https://www.gulftalent.com/saudi-arabia/jobs/project-manager-603427', 'Project Manager', 90),
    na: job('https://www.gob.mx/inm/acciones-y-programas/trabaja-en-el-inm', 'N/A', 90),
    sky1: job('https://skybluewaves.example/jobs/it-project-manager-1', 'IT Project Manager', 90),
    sky2: job('https://skybluewaves.example/jobs/it-project-manager-2', 'IT Project Manager', 90),
    k1: job('https://konnekt.example/jobs/project-management-1', 'project management', 90),
    k2: job('https://konnekt.example/jobs/project-management-2', 'project management', 90),
    k3: job('https://konnekt.example/jobs/software-development-3', 'software development', 90),
  };
  const ROCHE = 'https://roche.wd3.myworkdayjobs.com/roche-ext/job/Sant-Cugat-del-Valls/Senior-Software-Developer-Scrum-Master-C-_202605-112793-2/apply';
  const LEADS_REMOVED = [['e-metasys', 'Metasys'], ['e-jig', 'jobsinghana'], ['e-emploi', 'Emploi.ma'], ['e-napes', 'NAPES']];
  const LEADS_QUEUED = [['e-taechir', 'Moroccan Ministry of Employment (TAECHIR)'], ['e-dol', 'Department of Employment and Labour, South Africa'],
    ['e-mol', 'Ministry of Labour'], ['e-iskur', 'Iskur'], ['e-ag9', 'Agency Nine'], ['e-ag10', 'Agency Ten']];
  const row = (id, name, jobs, status = 'completed') => ({ status, employer: { id, name, logoColor: ['#123456', '#654321'], logoInitial: name.charAt(0), domain: null, jobs } });
  const world = (o = {}) => {
    const out = [];
    for (const [id, name] of [...LEADS_REMOVED, ...LEADS_QUEUED]) if (!(o.untracked || []).includes(id)) out.push(row(id, name, []));
    const emps = [
      ['e-amazon', 'Amazon', [J.amazon]],
      ['e-airbus', o.airbusName || 'Airbus', o.airbusJobs || [J.insp, J.arch, J.spc, J.cyber, J.risk, J.pl], o.airbusStatus],
      ['e-iwell', 'iwell B.V.', [J.iwell]], ['e-werken', 'Werkenvoornederland', [J.werken]], ['e-cvb', 'cvbankas.lt', [J.cvb]],
      ['e-mom', 'MOM Ranch', [J.mom]], ['e-linum', 'Linum Consult', [J.linum]], ['e-na', 'N/A', [J.na]],
      ['e-sky', 'Sky Blue Waves Ltd', [J.sky1, J.sky2]], ['e-konnekt', 'Konnekt', [J.k1, J.k2, J.k3]],
      ...(o.extra || []),
    ];
    for (const [id, name, jobs, status] of emps) if (!(o.untracked || []).includes(id)) out.push(row(id, name, jobs, status));
    return o.reverse ? out.reverse() : out;
  };
  const savedCards = (extra = []) => [
    { id: 's1', job_url: ROCHE, title: 'Senior Software Developer/Scrum Master C#', company: 'Roche', match: 100, skills: ['C#'], location: 'Sant Cugat', saved_at: iso(T0 - 5 * DAY) },
    ...extra,
  ];
  const srv = { dash: world(), saved: savedCards(), hidden: [], roster: 'ok', rosterReqs: [] };
  // ⚠️ THE SERVER'S COPY OF THE ROW, FOR REAL (2026-09-20): server/services/homeRoster.js's own handlers, over a fake
  // db-config that runs its statements the way Postgres does — the compare-and-set INSERT (a seed) and UPDATE (a write
  // made from a revision), jsonb's own key order (shorter keys first), so a row that comes back re-ordered must not read
  // as a changed one, and ⚠️ jsonb's REFUSALS: a NUL escape and half a surrogate pair are not JSON it will store (both
  // verified against a real Postgres 14 — "unsupported Unicode escape sequence" / "invalid input syntax for type json").
  const dbPath = path.join(__dirname, '../../db-config.js');
  const rosterRows = new Map();
  const jsonbOrder = (v) => (Array.isArray(v) ? v.map(jsonbOrder) : v && typeof v === 'object'
    ? Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).reduce((o, k) => { o[k] = jsonbOrder(v[k]); return o; }, {}) : v);
  const JSONB_REFUSES = /\\u0000|\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;
  const asJsonb = (text) => { if (JSONB_REFUSES.test(text)) throw new Error('invalid input syntax for type json'); return text; };
  const fakeDb = {
    run: async (sql) => { if (!/^CREATE TABLE IF NOT EXISTS user_home_roster/.test(sql.trim())) throw new Error('unexpected run: ' + sql); return { changes: 0 }; },
    get: async (sql, params) => {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (q === 'SELECT roster, rev, updated_at FROM user_home_roster WHERE user_id = $1') {
        const r = rosterRows.get(params[0]);
        return r ? { roster: jsonbOrder(JSON.parse(r.text)), rev: r.rev, updated_at: new Date(0) } : null;
      }
      // A seed: inserted only when there is no row (ON CONFLICT DO NOTHING).
      if (/^INSERT INTO user_home_roster \(user_id, roster, rev, updated_at\) VALUES \(\$1, \$2::jsonb, 1, NOW\(\)\) ON CONFLICT \(user_id\) DO NOTHING RETURNING rev$/.test(q)) {
        const [uid, text] = params;
        if (rosterRows.has(uid)) return null;
        rosterRows.set(uid, { text: asJsonb(text), rev: 1 });
        return { rev: 1 };
      }
      // A write made from a revision: an UPDATE, so a row that is GONE (a deleted account) is never re-inserted.
      if (/^UPDATE user_home_roster SET roster = \$2::jsonb, rev = rev \+ 1, updated_at = NOW\(\) WHERE user_id = \$1 AND rev = \$3 RETURNING rev$/.test(q)) {
        const [uid, text, base] = params;
        const cur = rosterRows.get(uid);
        if (!cur || cur.rev !== base) return null;
        rosterRows.set(uid, { text: asJsonb(text), rev: cur.rev + 1 });
        return { rev: cur.rev + 1 };
      }
      throw new Error('unexpected get: ' + q);
    },
  };
  const Module = require('module');
  const dbMod = new Module(dbPath);
  dbMod.filename = dbPath; dbMod.loaded = true; dbMod.exports = fakeDb;
  const realDbEntry = require.cache[dbPath];
  require.cache[dbPath] = dbMod;
  const hrPath = path.join(__dirname, '../../server/services/homeRoster.js');
  delete require.cache[hrPath];
  const HR = require(hrPath);
  if (realDbEntry) require.cache[dbPath] = realDbEntry; else delete require.cache[dbPath];
  const mkRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    const reply = (body) => ({ ok: true, status: 200, json: async () => body });
    const fail = { ok: false, status: 500, json: async () => ({ error: 'x' }) };
    if (/\/ai-hub\/home\/roster$/.test(u)) {
      const entry = { method, body: init && init.body ? JSON.parse(init.body) : null, status: 0 };
      srv.rosterReqs.push(entry);
      if (srv.roster === 'fail') { entry.status = 500; return fail; }
      if (srv.roster === 'gone') { entry.status = 404; return { ok: false, status: 404, json: async () => { throw new Error('Cannot GET'); } }; }
      const res = mkRes();
      const req = { user: { id: sessionUser }, headers: {}, body: entry.body || {} };
      await (method === 'PUT' ? HR.putHomeRoster : HR.getHomeRoster)(req, res);
      entry.status = res.statusCode;
      const out = JSON.parse(JSON.stringify(res.body));
      return { ok: res.statusCode < 300, status: res.statusCode, json: async () => out };
    }
    if (method !== 'GET' && /\/ai-hub\/home\/hidden-targets$/.test(u)) return reply({ success: true });
    if (/\/ai-hub\/dashboard$/.test(u)) return srv.dash === 'fail' ? fail : reply({ dashboard: srv.dash });
    if (/\/discover\/saved-jobs$/.test(u)) return srv.saved === 'fail' ? fail : reply({ success: true, jobs: srv.saved, count: srv.saved.length });
    if (/\/ai-hub\/home\/hidden-targets$/.test(u)) return srv.hidden === 'fail' ? fail : reply({ keys: srv.hidden });
    return fail;
  };
  const K = (j) => ehs.jobKeyForUrl(j.applyUrl);
  const names = (list) => list.map((t) => t.company + (t.role ? ' · ' + t.role : ''));
  const keysOf = (list) => list.map((t) => t.key);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ask = async () => ehs.fetchTargetAnswer();
  const identity = (t) => t && JSON.stringify({ key: t.key, company: t.company, employerId: t.employerId, website: t.website ?? null, applyUrl: t.applyUrl ?? null, jobUrl: t.jobUrl ?? null, role: t.role, country: t.country ?? null, colors: t.colors, initial: t.initial });
  try {
    // ── the ranking is unchanged, and it still IS the row a first load shows ──
    const a0 = await ask();
    const fetched = await ehs.fetchTargets();
    ok('fetchTargets() is exactly fetchTargetAnswer().ranked (the harness loader and older callers see the same row)', same(keysOf(fetched), keysOf(a0.ranked)));
    ok('the fixture ranks like production did before the clean-up: four lead employers, then postings by match',
      same(names(a0.ranked).slice(0, 5), ['Metasys', 'jobsinghana', 'Emploi.ma', 'NAPES', 'Amazon · Software Development Engineer II (ADBL183)']) && a0.ranked.length === 12,
      names(a0.ranked));
    ok('every read is reported as answered, and the posting / saved watermarks are the server\'s own times',
      a0.dashOk && a0.savedOk && a0.hiddenOk && a0.postMax === T0 && a0.savedMax === T0 - 5 * DAY
      && a0.trackedEmployerIds.includes('e-airbus') && a0.settledEmployerIds.includes('e-airbus') && a0.savedKeys.includes(ehs.jobKeyForUrl(ROCHE))
      && a0.pool.some((t) => t.key === K(J.cyber)) && !a0.candidates.some((t) => t.key === K(J.cyber)));
    // ⚠️ SEED (review 2026-09-19): an account that tracks MORE employers than a row holds (this fixture: 20, like user
    // 1's 255) does not get the ranking's four LEAD employers (no posting) — those were the refill itself.
    const seeded = RO.mergeRoster(null, a0);
    ok('⚠️ SEED, an account tracking more than a row (20 > 12): the four lead employers are left out, and NOTHING refills their places',
      seeded.persist && same(keysOf(seeded.row), keysOf(a0.ranked).slice(4)) && seeded.row.length === 8
      && !seeded.row.some((t) => t.key.startsWith('emp_')) && seeded.roster.selected === K(J.amazon), names(seeded.row));
    ok('…and they count as known: a freed place never brings them (or the queued agencies) back later',
      LEADS_REMOVED.every(([id]) => seeded.roster.knownEmployers.includes(id))
      && RO.mergeRoster(RO.rosterRemove(seeded.roster, K(J.amazon)), a0).roster.keys.every((k) => !k.startsWith('emp_')));
    ok('…but an employer the user added on Home stays in the seed, where the ranking had it',
      same(RO.mergeRoster(null, a0, { added: (k) => k === 'emp_e-jig' }).roster.keys.slice(0, 2), ['emp_e-jig', K(J.amazon)]));
    // The row as a build before the roster had it on screen: the ranking's own 12 (a tracked list the seed cannot count).
    const asShown = (a) => RO.mergeRoster(null, { ...a, trackedEmployerIds: null }).roster;
    ok('(the row build 209 showed: the ranking\'s own 12, the four lead employers first)', same(asShown(a0).keys, keysOf(a0.ranked)));

    // ── REPLAY 16:11 IST: the four lead employers removed (untracked), then eight postings hidden ──
    let r = asShown(a0);
    for (const [id] of LEADS_REMOVED) r = RO.rosterRemove(r, 'emp_' + id);
    srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]) });
    const a1 = await ask();
    ok('(the ranking alone refills those four places with the queued agencies — the incident reproduced)',
      same(names(a1.ranked).slice(0, 4), LEADS_QUEUED.slice(0, 4).map((x) => x[1])), names(a1.ranked).slice(0, 4));
    const m1 = RO.mergeRoster(r, a1);
    ok('⚠️ after removing the four lead employers the row SHRINKS to the eight postings — no Moroccan Ministry, no Department of Employment, no Ministry of Labour, no Iskur',
      m1.row.length === 8 && !m1.row.some((t) => LEADS_QUEUED.some(([id]) => t.employerId === id)) && same(keysOf(m1.row), keysOf(a0.ranked).slice(4)),
      names(m1.row));
    ok('…and the selection moved to the chip that slid into the first place, not to a stranger', m1.roster.selected === K(J.amazon));
    const firstEight = [J.amazon, J.insp, J.arch, J.spc, J.iwell, { applyUrl: ROCHE }, J.werken, J.cvb].map(K);
    r = m1.roster;
    for (const k of firstEight) r = RO.rosterRemove(r, k);
    srv.hidden = firstEight.slice();
    const a2 = await ask();
    ok('(the ranking alone now offers Airbus Cyber / RISK / Project Leader and MOM Ranch, Linum, N/A in their places)',
      ['MOM Ranch', 'Linum Consult', 'N/A'].every((n) => a2.ranked.some((t) => t.company === n)) && a2.ranked.some((t) => t.key === K(J.cyber)), names(a2.ranked));
    const m2 = RO.mergeRoster(r, a2);
    ok('⚠️ the owner emptied his row, and it STAYS empty: nothing refills it from further down the ranking', m2.row.length === 0, names(m2.row));
    // After 16:11:45 he hid those three too; at 22:02 the ranking offered Konnekt ×3 — the saved row still offers nothing.
    srv.hidden = [...firstEight, K(J.mom), K(J.linum), K(J.na)];
    const a3 = await ask();
    ok('(22:02 replay: the ranking alone offers Konnekt ×3 and three other Airbus roles)',
      a3.ranked.filter((t) => t.company === 'Konnekt').length === 3 && [J.cyber, J.risk, J.pl].every((j) => a3.ranked.some((t) => t.key === K(j))), names(a3.ranked));
    const m3 = RO.mergeRoster(m2.roster, a3);
    const m3b = RO.mergeRoster(m3.roster, a3);
    // (No `removed` is passed to these merges: it is the hidden list and the untrack that hold, not the 5-minute overlay.)
    ok('⚠️ …and the saved row takes none of them — on any load, however many times', m3.row.length === 0 && m3b.row.length === 0);

    // ⚠️ THE FIXED BUILD'S FIRST LAUNCH FOR USER 1: its seed is the 22:02 row WITHOUT the four agencies he never picked.
    const firstLaunch = RO.mergeRoster(null, a3);
    ok('⚠️ first launch after the fix (the 22:02 answer): TAECHIR, Department of Employment SA, Ministry of Labour and Iskur are NOT seeded; the eight postings he saw keep their order',
      firstLaunch.persist && same(keysOf(firstLaunch.row), keysOf(a3.ranked).slice(4)) && firstLaunch.row.length === 8
      && !firstLaunch.row.some((t) => LEADS_QUEUED.some(([id]) => t.employerId === id)) && firstLaunch.roster.selected === K(J.cyber), names(firstLaunch.row));

    // ── THE 22:02 ROW AS A SAVED ROW: Airbus Cyber picked (i = 4), then everything that used to move it ──
    // (Saved as the screen had it — the four agencies in front — so each rule below runs on the owner's real 12.)
    const s0 = { row: RO.rosterRow(asShown(a3)) };
    let base = RO.rosterSelect(asShown(a3), K(J.cyber));
    ok('the 22:02 row as the screen had it, and the owner\'s pick (Airbus · Cyber Security Manager, i = 4) is saved by key',
      base.keys.indexOf(K(J.cyber)) === 4 && base.selected === K(J.cyber) && base.keys.length === 12, names(s0.row));
    const cyberBefore = base.snap[K(J.cyber)];
    const lookupBefore = JSON.stringify(docs.docLookupOf(cyberBefore));
    const stable = (m, label) => ok(label, same(m.roster.keys, base.keys) && m.roster.selected === K(J.cyber), { keys: names(m.row), sel: m.roster.selected });

    // Match scores reshuffled, the dashboard in another order (a re-search bumps ute.updated_at), geography reordering Airbus.
    const shuffled = (j, s) => ({ ...j, matchScore: s });
    srv.dash = world({
      untracked: LEADS_REMOVED.map((x) => x[0]), reverse: true,
      airbusJobs: [shuffled(J.pl, 100), shuffled(J.risk, 60), shuffled(J.cyber, 70), J.insp, J.arch, J.spc],
      extra: [],
    });
    srv.dash.forEach((x) => { if (x.employer.id === 'e-konnekt') x.employer.jobs = [shuffled(J.k1, 40), shuffled(J.k2, 100), shuffled(J.k3, 55)]; });
    const aShuffle = await ask();
    ok('(the ranking alone reorders under a reshuffle)', !same(keysOf(aShuffle.ranked), base.keys));
    const mShuffle = RO.mergeRoster(base, aShuffle);
    stable(mShuffle, '⚠️ reshuffled match scores, a reordered dashboard, geography reordering an employer: the same chips, the same order, Airbus Cyber still selected');
    ok('…and the chips carry the fresh match % (only match, skills, location and job id refresh)',
      mShuffle.roster.snap[K(J.cyber)].match === 70 && mShuffle.roster.snap[K(J.k2)].match === 100);

    // The failed reads (root cause 2).
    srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]) });
    srv.hidden = 'fail';
    const aNoHidden = await ask();
    const changed = aNoHidden.ranked.filter((t, i) => t.key !== base.keys[i]).length;
    ok('(a failed hidden read makes the ranking alone change most of the row and bring hidden postings back — today\'s failure)',
      !aNoHidden.hiddenOk && changed >= 6 && aNoHidden.ranked.some((t) => t.key === K(J.amazon)) && !aNoHidden.ranked.some((t) => t.key === K(J.cyber)), { changed });
    stable(RO.mergeRoster(base, aNoHidden), '⚠️ a FAILED hidden read changes nothing: no hidden posting comes back, Airbus Cyber stays selected');
    srv.hidden = [...firstEight, K(J.mom), K(J.linum), K(J.na)];
    srv.dash = 'fail';
    stable(RO.mergeRoster(base, await ask()), '⚠️ a FAILED dashboard read changes nothing (it used to turn the row into saved cards)');
    srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]) });
    srv.saved = 'fail';
    stable(RO.mergeRoster(base, await ask()), 'a FAILED saved read changes nothing');
    srv.dash = 'fail'; srv.hidden = 'fail';
    stable(RO.mergeRoster(base, await ask()), 'every read failed (offline): the row stays exactly as it was');
    srv.saved = savedCards(); srv.hidden = [...firstEight, K(J.mom), K(J.linum), K(J.na)];

    // Background research changing the data under a chip.
    srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]), airbusStatus: 'processing', airbusJobs: [J.risk, J.pl] });
    const aResearch = await ask();
    const mResearch = RO.mergeRoster(base, aResearch);
    stable(mResearch, '⚠️ Airbus being re-searched (its postings replaced by partial results without Cyber): the chip keeps its place and stays selected');
    ok('…and its identity — and so the saved letter\'s lookup (docLookupOf) — is unchanged',
      identity(mResearch.roster.snap[K(J.cyber)]) === identity(cyberBefore) && JSON.stringify(docs.docLookupOf(mResearch.roster.snap[K(J.cyber)])) === lookupBefore);
    srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]), airbusJobs: [J.risk, J.pl, J.insp] });
    stable(RO.mergeRoster(base, await ask()), 'Cyber evicted / deactivated on the server (missing from a dashboard that ANSWERED): still kept — only the user removes a chip');
    srv.dash = world({
      untracked: LEADS_REMOVED.map((x) => x[0]), airbusName: 'Airbus SE',
      airbusJobs: [{ ...J.cyber, title: 'Cyber Security Manager (m/f/d)', matchScore: 88, country: 'France' }, J.risk, J.pl],
    });
    const mRenamed = RO.mergeRoster(base, await ask());
    stable(mRenamed, 'the employer renamed in the background ("Airbus" → "Airbus SE") and the posting retitled: same chip');
    ok('⚠️ …its company, title, country, site, URL and colours are FROZEN (the letter\'s identity), only its match moved',
      identity(mRenamed.roster.snap[K(J.cyber)]) === identity(cyberBefore) && mRenamed.roster.snap[K(J.cyber)].company === 'Airbus'
      && mRenamed.roster.snap[K(J.cyber)].match === 88 && JSON.stringify(docs.docLookupOf(mRenamed.roster.snap[K(J.cyber)])) === lookupBefore);

    // What DOES take a chip away: the user, somewhere.
    srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]) });
    srv.hidden = [...firstEight, K(J.mom), K(J.linum), K(J.na), K(J.cyber)];
    const mHid = RO.mergeRoster(base, await ask());
    ok('⚠️ Cyber hidden (from the other phone): it leaves, and the chip that slid into index 4 is selected — never the first chip',
      !mHid.roster.keys.includes(K(J.cyber)) && mHid.roster.selected === K(J.risk) && mHid.roster.keys.indexOf(K(J.risk)) === 4 && mHid.roster.keys.length === 11,
      { sel: mHid.roster.selected });
    srv.hidden = [...firstEight, K(J.mom), K(J.linum), K(J.na)];
    ok('the X on this device: gone at once, before the server has heard (removedNow)',
      !RO.mergeRoster(base, await ask(), { removed: (k) => k === K(J.k1) }).roster.keys.includes(K(J.k1)));
    srv.dash = world({ untracked: [...LEADS_REMOVED.map((x) => x[0]), 'e-airbus'] });
    const mUntracked = RO.mergeRoster(base, await ask());
    ok('⚠️ Airbus untracked (missing from a dashboard read that ANSWERED): its three chips leave, the neighbour is selected',
      ![J.cyber, J.risk, J.pl].some((j) => mUntracked.roster.keys.includes(K(j))) && mUntracked.roster.keys.length === 9 && mUntracked.roster.selected === K(J.sky1));
    const heldBase = RO.rosterPlace(RO.rosterRemove(base, K(J.cyber)), cyberBefore, { after: base.keys.slice(0, 4), hold: true, now: T0 });
    const mHeld = RO.mergeRoster(heldBase, await ask(), { now: T0 + 60000 });
    ok('…but a chip the user just put back (an Undo, a re-add) is HELD against that read',
      mHeld.roster.keys.includes(K(J.cyber)) && !mHeld.roster.keys.includes(K(J.risk)) && mHeld.roster.keys.indexOf(K(J.cyber)) === 4);
    ok('…until the hold runs out (5 min): then the read is believed',
      !RO.mergeRoster(heldBase, await ask(), { now: T0 + RO.ROSTER_HOLD_MS + 1 }).roster.keys.includes(K(J.cyber)));
    ok('the Undo went back to its OLD place (index 4), not the end', heldBase.keys.indexOf(K(J.cyber)) === 4 && same(heldBase.keys, base.keys));
    srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]) });
    const aNow = await ask();
    const undoHide = RO.mergeRoster(heldBase, { ...aNow, hidden: [...aNow.hidden, K(J.cyber)], localHidden: { [K(J.cyber)]: true } }, { now: T0 + 60000 });
    ok('⚠️ an Undo whose un-hide is not sent yet (this device still says hidden) survives the merge', undoHide.roster.keys.indexOf(K(J.cyber)) === 4);

    // What may JOIN: only the new — at the end, never in a freed place.
    const newJob = job(WD + 'Toulouse-Area/Brand-New-Role_JR10499999', 'Brand New Role', 100, T0 + DAY);
    srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]), airbusJobs: [J.insp, J.arch, J.spc, J.cyber, J.risk, J.pl, newJob] });
    const aNew = await ask();
    ok('a full row (12) takes no new posting', !RO.mergeRoster(base, aNew).roster.keys.includes(K(newJob)) && RO.mergeRoster(base, aNew).roster.keys.length === 12);
    const eleven = RO.rosterRemove(base, K(J.k3));
    const mNew = RO.mergeRoster(eleven, aNew);
    ok('⚠️ with room, a posting NEWER than any the row has seen joins at the END — the old ones ranked above it never do',
      mNew.roster.keys.length === 12 && mNew.roster.keys[11] === K(newJob) && same(mNew.roster.keys.slice(0, 11), eleven.keys), names(mNew.row));
    const mAgain = RO.mergeRoster(RO.rosterRemove(mNew.roster, K(J.k2)), aNew);
    ok('…and once offered it is old: removing another chip refills nothing', mAgain.roster.keys.length === 11);
    // ⚠️ REVIEW 2026-09-20 (the server copy): THE HIGH-WATER MARKS SURVIVE ANOTHER PHONE'S ROW. This phone passed the new
    // posting over (its row was full) and moved its watermark; the other phone's row still carried the older one, and
    // taking that row whole put the posting back among the NEW — into the first place the user freed, which is the very
    // refill this file exists to stop.
    const passedOver = { ...RO.mergeRoster(base, aNew).roster, rev: 4 };
    const elsewhere = { ...base, rev: 5 };
    const met = RO.pickSaved(passedOver, { roster: elsewhere, rev: 5 });
    ok('⚠️ another phone\'s row is taken with THIS phone\'s watermarks: a posting already passed over never walks into a freed place',
      met.adopted && met.row.postWatermark === passedOver.postWatermark && met.row.postWatermark > base.postWatermark
      && !RO.mergeRoster(RO.rosterRemove(met.row, K(J.k3)), aNew).roster.keys.includes(K(newJob)),
      { met: met.row.postWatermark, passedOver: passedOver.postWatermark, base: base.postWatermark });
    const marksHere = { ...passedOver, savedWatermark: T0 + DAY, savedArmed: true, knownEmployers: ['e-here'] };
    const marksThere = { ...base, rev: 6, savedWatermark: null, savedArmed: false, postArmed: false, knownEmployers: ['e-there'] };
    const met2 = RO.pickSaved(marksHere, { roster: marksThere, rev: 6 }).row;
    ok('…each mark the LATER of the two, "was it read" either of the two, and the employers already seen are the union',
      met2.savedWatermark === T0 + DAY && met2.savedArmed === true && met2.postArmed === true
      && met2.knownEmployers.includes('e-here') && met2.knownEmployers.includes('e-there'),
      { saved: met2.savedWatermark, known: met2.knownEmployers.length });
    const lateHidden = job('https://konnekt.example/jobs/new-but-hidden', 'hidden newcomer', 100, T0 + 2 * DAY);
    srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]), extra: [['e-kk', 'KK', [lateHidden]]] });
    srv.hidden = 'fail';
    const withLast = { ...(await ask()) };
    const lastHiddenRoster = { ...eleven, hidden: [...eleven.hidden, K(lateHidden)], knownEmployers: [...eleven.knownEmployers, 'e-kk'] };
    ok('a posting the last good hidden list names never joins as "new" while the hidden read is failing',
      !RO.mergeRoster(lastHiddenRoster, withLast).roster.keys.includes(K(lateHidden)));
    srv.hidden = [...firstEight, K(J.mom), K(J.linum), K(J.na)];
    const oldJobOfNewEmployer = job('https://newco.example/jobs/1', 'Engineer', 80, T0 - 30 * DAY);
    srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]), extra: [['e-newco', 'NewCo', [oldJobOfNewEmployer]]] });
    const aTracked = await ask();
    const mTracked = RO.mergeRoster(base, aTracked);
    ok('⚠️ an employer the user started tracking elsewhere joins even a FULL row (up to ROSTER_HARD_MAX), at the end',
      mTracked.roster.keys.length === 13 && mTracked.roster.keys[12] === K(oldJobOfNewEmployer) && RO.ROSTER_HARD_MAX === 20);
    ok('…once: the next load does not add it again', RO.mergeRoster(mTracked.roster, aTracked).roster.keys.length === 13);
    srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]), extra: [['e-newco', 'NewCo', [oldJobOfNewEmployer], 'processing']] });
    ok('…but not while its search is still running (a pending/processing row is not settled)', RO.mergeRoster(base, await ask()).roster.keys.length === 12);
    srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]) });
    srv.saved = savedCards([{ id: 's2', job_url: 'https://jobs.example/saved-today', title: 'Saved Today', company: 'Saved Co', match: 50, saved_at: iso(T0 + DAY) }]);
    const aSaved = await ask();
    ok('a card saved since joins at the end while there is room, not when the row is full',
      RO.mergeRoster(eleven, aSaved).roster.keys[11] === 'job_https://jobs.example/saved-today' && RO.mergeRoster(base, aSaved).roster.keys.length === 12);

    // Saved-only chips: only an unsave takes them away — and only a COMPLETE saved read says so.
    srv.hidden = []; srv.saved = savedCards();
    srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]) });
    const withRoche = RO.mergeRoster(null, await ask()).roster;
    ok('(the Roche saved card is on a fresh row)', withRoche.keys.includes(ehs.jobKeyForUrl(ROCHE)));
    srv.saved = [];
    ok('⚠️ a saved card missing from a saved read that answered in full was unsaved: it leaves',
      !RO.mergeRoster(withRoche, await ask()).roster.keys.includes(ehs.jobKeyForUrl(ROCHE)));
    srv.saved = Array.from({ length: 500 }, (_, i) => ({ id: 'x' + i, job_url: 'https://jobs.example/other-' + i, title: 'Other', company: 'Other Co', match: 1, saved_at: iso(T0 - 100 * DAY) }));
    ok('…but a saved read of 500 (the server\'s page — it may have cut the card off) is no evidence: it stays',
      RO.mergeRoster(withRoche, await ask()).roster.keys.includes(ehs.jobKeyForUrl(ROCHE)));
    srv.saved = savedCards();

    // Adds, renames and the server's copy of a chip this device stood in for.
    const pend = { key: 'emp_pending_newemployer.example', jobId: null, employerId: null, company: 'New Employer', role: '', initial: 'N', colors: ['#000000', '#111111'], match: null, skills: [], website: 'https://newemployer.example' };
    ok('a pending add, and a posting with no URL, are never kept', !RO.persistable(pend) && !RO.persistable({ key: 'job_jid-9', jobId: 'jid-9', company: 'X', role: 'Y', initial: 'X', colors: ['#1', '#2'], match: 1, skills: [] })
      && same(RO.rosterPlace(base, pend, { after: [] }), base));
    const real = { ...pend, key: 'emp_e-newemp', employerId: 'e-newemp', company: 'New Employer' };
    const added = RO.rosterPlace(base, real, { after: [], replaces: pend.key, hold: true, provisional: true, now: T0 });
    ok('the tracked employer lands at the FRONT, held, and the selection stays where it was',
      added.keys[0] === real.key && added.keys.length === 13 && added.selected === K(J.cyber) && added.hold[real.key] === T0 + RO.ROSTER_HOLD_MS);
    const notYet = RO.mergeRoster(added, aNow, { now: T0 + 1000 });
    ok('…a dashboard read that does not list it yet cannot drop it (the hold)', notYet.roster.keys[0] === real.key);
    srv.dash = [row('e-newemp', 'New Employer Inc', []), ...world({ untracked: LEADS_REMOVED.map((x) => x[0]) })];
    srv.dash[0].employer.domain = 'newemployer.example';
    const mProv = RO.mergeRoster(notYet.roster, await ask(), { now: T0 + 2000 });
    ok('…the dashboard\'s own copy replaces this device\'s stand-in ONCE (provisional), in the same place',
      mProv.roster.keys[0] === real.key && mProv.roster.snap[real.key].company === 'New Employer Inc' && !mProv.roster.prov[real.key]);
    srv.dash[0].employer.name = 'Renamed Again';
    ok('…and from then on it is frozen like every other chip', RO.mergeRoster(mProv.roster, await ask(), { now: T0 + 3000 }).roster.snap[real.key].company === 'New Employer Inc');
    const swapped = RO.rosterPlace(base, { ...cyberBefore, key: 'job_https://elsewhere.example/cyber' }, { after: base.keys.slice(0, 4), replaces: K(J.cyber), hold: true });
    ok('a chip coming back under a NEW identity takes the old one\'s place and its selection (the pending → tracked swap)',
      swapped.keys[4] === 'job_https://elsewhere.example/cyber' && !swapped.keys.includes(K(J.cyber)) && swapped.selected === 'job_https://elsewhere.example/cyber' && swapped.keys.length === 12);
    // ⚠️ REVIEW 2026-09-20: ONE CAP ON BOTH SIDES. Nothing here capped the row — every add, Undo and restored posting
    // goes in — while the server refuses a row over ROSTER_MAX_KEYS outright: a row that reached 65 chips was refused on
    // every write from then on, for ever, and the other phone kept adopting the frozen copy.
    let fat = base;
    for (let i = 0; i < 60; i++) fat = RO.rosterPlace(fat, { ...cyberBefore, key: 'emp_fat-' + i, employerId: 'fat-' + i, applyUrl: null }, { after: [] });
    ok('⚠️ 60 adds on a full row stay inside the server\'s own cap — the newest add and the selection are never the ones dropped',
      fat.keys.length === RO.ROSTER_MAX_KEYS && RO.ROSTER_MAX_KEYS === HR.ROSTER_MAX_KEYS
      && fat.keys[0] === 'emp_fat-59' && fat.selected === K(J.cyber) && fat.keys.includes(fat.selected)
      && Object.keys(fat.snap).length === fat.keys.length && !!HR.acceptableRoster(fat),
      { keys: fat.keys.length, sel: fat.selected });
    ok('…and a key no server row could hold (over ROSTER_KEY_MAX_LEN) is never put on the row',
      !RO.persistable({ ...cyberBefore, key: 'emp_' + 'x'.repeat(RO.ROSTER_KEY_MAX_LEN) })
      && RO.ROSTER_KEY_MAX_LEN === HR.ROSTER_KEY_MAX_LEN);

    // Seeding refuses an answer that would freeze a wrong row.
    srv.dash = 'fail';
    ok('no saved row + a failed dashboard read: shown, NOT kept (a seed would freeze a row of saved cards)', RO.mergeRoster(null, await ask()).persist === false);
    srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]) }); srv.hidden = 'fail';
    ok('no saved row + a failed hidden read: shown, NOT kept (a seed would freeze the hidden postings in)', RO.mergeRoster(null, await ask()).persist === false);
    srv.hidden = [...firstEight, K(J.mom), K(J.linum), K(J.na)];

    // ⚠️ REVIEW 2026-09-19 (round 1): A WATERMARK NEVER READ IS NOT "EVERYTHING IS NEW".
    srv.hidden = []; srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]) });
    srv.saved = 'fail';
    const sNoSaved = RO.mergeRoster(null, await ask());
    ok('(a row saved while the saved-jobs read FAILED: its saved watermark was never read)',
      sNoSaved.persist && sNoSaved.roster.savedArmed === false && sNoSaved.roster.savedWatermark === null && sNoSaved.roster.postArmed === true);
    let freed = sNoSaved.roster;
    for (const k of freed.keys.slice(0, 2)) freed = RO.rosterRemove(freed, k);
    const augustCards = [
      { id: 'aug1', job_url: 'https://jobs.example/august-1', title: 'Saved in August', company: 'August Co', match: 99, saved_at: '2026-08-01T09:00:00Z' },
      { id: 'aug2', job_url: 'https://jobs.example/august-2', title: 'Saved in August too', company: 'August Two', match: 98, saved_at: '2026-08-02T09:00:00Z' },
    ];
    srv.saved = savedCards(augustCards);
    const mArm = RO.mergeRoster(freed, await ask());
    ok('⚠️ …the first saved read that answers ARMS it and adds NOTHING: no August card (nor Roche) walks into the two places the user just emptied',
      same(mArm.roster.keys, freed.keys) && mArm.roster.savedArmed === true && mArm.roster.savedWatermark === T0 - 5 * DAY, names(mArm.row));
    srv.saved = savedCards([...augustCards, { id: 'since', job_url: 'https://jobs.example/saved-since', title: 'Saved since', company: 'Since Co', match: 10, saved_at: iso(T0 + DAY) }]);
    const mSince = RO.mergeRoster(mArm.roster, await ask());
    ok('…and from then on a card saved SINCE joins, at the end',
      mSince.roster.keys.length === freed.keys.length + 1 && mSince.roster.keys[freed.keys.length] === 'job_https://jobs.example/saved-since', names(mSince.row));
    // The posting watermark: a row saved while its only postings were a search's partial results (no created_at).
    const undated = (j) => ({ ...j, createdAt: null });
    srv.saved = []; srv.dash = [row('e-solo', 'Solo', [undated(J.k1), undated(J.k2)], 'processing')];
    const sPartial = RO.mergeRoster(null, await ask());
    ok('(a row saved from partial results only — no created_at anywhere: the posting watermark was never read)',
      sPartial.persist && sPartial.roster.postArmed === false && same(sPartial.roster.keys, [K(J.k1), K(J.k2)]));
    srv.dash = [row('e-solo', 'Solo', [J.k1, J.k2, J.k3])];
    const mDated = RO.mergeRoster(sPartial.roster, await ask());
    ok('⚠️ …the first read that dates them ARMS it and adds nothing (the finished search\'s third posting does not walk in)',
      same(mDated.roster.keys, sPartial.roster.keys) && mDated.roster.postArmed === true && mDated.roster.postWatermark === T0, names(mDated.row));
    const storedSince = job('https://konnekt.example/jobs/stored-since', 'stored since', 100, T0 + DAY);
    srv.dash = [row('e-solo', 'Solo', [J.k1, J.k2, J.k3, storedSince])];
    ok('…then a posting stored since joins, at the end', RO.mergeRoster(mDated.roster, await ask()).roster.keys.slice(-1)[0] === K(storedSince));
    // An EMPTY store is a read watermark: null there means "nothing was there", so a new user's first finds still join.
    srv.dash = [row('e-solo', 'Solo', [])];
    const sEmpty = RO.mergeRoster(null, await ask());
    ok('an EMPTY store arms both watermarks (null = nothing was there)', sEmpty.roster.postArmed && sEmpty.roster.savedArmed && same(sEmpty.roster.keys, ['emp_e-solo']));
    srv.dash = [row('e-solo', 'Solo', [J.k1])];
    srv.saved = [{ id: 'first', job_url: 'https://jobs.example/first-save', title: 'First', company: 'First Co', match: 5, saved_at: iso(T0) }];
    const mFirst = RO.mergeRoster(sEmpty.roster, await ask());
    ok('…so a new user\'s first posting and first saved card still join',
      mFirst.roster.keys.includes(K(J.k1)) && mFirst.roster.keys.includes('job_https://jobs.example/first-save') && mFirst.roster.keys[0] === 'emp_e-solo', names(mFirst.row));
    ok('a row stored before the flags existed reads a null watermark as NEVER read (the safe side), a dated one as read',
      await (async () => {
        const legacy = JSON.parse(JSON.stringify(sEmpty.roster));
        delete legacy.postArmed; delete legacy.savedArmed;
        legacy.postWatermark = T0; legacy.savedWatermark = null;
        store.set('home_roster_v1:u:legacy', JSON.stringify(legacy));
        RO.forgetRosterCopy();
        const back = await RO.readRoster('u:legacy');
        RO.forgetRosterCopy(); store.delete('home_roster_v1:u:legacy');
        return !!back && back.postArmed === true && back.savedArmed === false;
      })());
    srv.dash = world({ untracked: LEADS_REMOVED.map((x) => x[0]) }); srv.saved = savedCards();
    srv.hidden = [...firstEight, K(J.mom), K(J.linum), K(J.na)];

    // ⚠️ REVIEW 2026-09-19 (round 1): WHAT ONE LOAD DOES WITH THE ROW WHEN THE SESSION OR STORAGE CANNOT BE READ.
    // load()'s own steps, with the real functions in its order: rowAccounts → readRoster → rosterCopy || stored → planRow.
    const aLoad = await ask();
    ok('rowAccounts: a readable session that owns the cache merges into AND saves under it', same(RO.rowAccounts('u:1', 'u:1'), { acct: 'u:1', owner: 'u:1' }));
    ok('⚠️ rowAccounts: an UNREADABLE session (signedInAccount → null) merges against cacheOwner\'s row, and saves under nobody',
      same(RO.rowAccounts(null, 'u:1'), { acct: null, owner: 'u:1' }));
    ok('rowAccounts: no account ever read, or another account read mid-load: neither',
      same(RO.rowAccounts(null, null), { acct: null, owner: null }) && same(RO.rowAccounts('u:616', 'u:1'), { acct: null, owner: null }));
    store.clear(); RO.forgetRosterCopy();
    RO.keepRoster('u:1', eleven); await RO.rosterWrites(); RO.forgetRosterCopy();
    const stepLoad = async (who, last, shown, remote = null) => {
      const { acct, owner } = RO.rowAccounts(who, last);
      const stored = owner ? await RO.readRoster(owner) : undefined;
      const savedRow = owner ? RO.savedRowOf(owner, RO.rosterCopy(owner) || stored, acct ? remote : undefined).row : undefined;
      const plan = RO.planRow(savedRow, aLoad, { shown });
      const row = plan.keep ? 'kept' : keysOf(plan.merged.row);
      return { acct, stored, plan, row, saves: !!(acct && plan.save) };
    };
    ok('(what a load with no saved row to merge into put on screen: the raw ranking\'s seed — Konnekt software development back in the place the user emptied)',
      RO.mergeRoster(null, aLoad).roster.keys.includes(K(J.k3)) && !eleven.keys.includes(K(J.k3)));
    const unread = await stepLoad(null, 'u:1', eleven.keys.length);
    ok('⚠️ LOAD, session unreadable: the answer merges into the SAVED row — the same 11 chips, same order, Airbus Cyber still selected',
      Array.isArray(unread.row) && same(unread.row, eleven.keys) && unread.plan.merged.roster.selected === K(J.cyber), unread.row);
    ok('…and nothing is saved (load() saves only under the account it READ)', unread.acct === null && unread.saves === false);
    RO.forgetRosterCopy();
    storeThrows = true;
    const blind = await stepLoad('u:1', 'u:1', eleven.keys.length);
    storeThrows = false;
    ok('⚠️ LOAD, storage unreadable (AsyncStorage.getItem throws): the row on screen STAYS, and nothing is saved over the stored one',
      blind.stored === undefined && blind.row === 'kept' && blind.saves === false && same(JSON.parse(store.get('home_roster_v1:u:1')).keys, eleven.keys));
    const noAccount = await stepLoad(null, null, eleven.keys.length);
    ok('LOAD, no account could ever be read, with a row on screen: it stays', noAccount.row === 'kept' && !noAccount.saves);
    ok('…a cold start with nothing on screen shows the answer (there is nothing else), unsaved',
      !RO.planRow(undefined, aLoad, { shown: 0 }).keep && !RO.planRow(undefined, aLoad, { shown: 0 }).save);
    ok('an answer with nothing in it (both stores failed) and no saved row keeps the row on screen too',
      RO.planRow(null, { ...aLoad, dashOk: false, savedOk: false }, { shown: 5 }).keep && !RO.planRow(null, { ...aLoad, dashOk: false, savedOk: false }, { shown: 5 }).save);
    ok('the first complete load with no saved row yet (null) seeds and saves it',
      (() => { const p = RO.planRow(null, aLoad, { shown: 3 }); return !p.keep && p.save && p.merged.persist; })());
    ok('a refused session neither keeps the row nor saves', (() => { const p = RO.planRow(eleven, aLoad, { shown: 11, refused: true }); return !p.keep && !p.save; })());
    store.clear(); RO.forgetRosterCopy();

    // The device's own hides reach the merge (localHide), and outrank the server's list.
    await ehs.unhideTarget(K(J.amazon));
    const aLocal = await ask();
    ok('an un-hide this device just made is reported to the merge (localHidden) until its grace ends', aLocal.localHidden[K(J.amazon)] === false);

    // ── storage: per account, per device, never under nobody ──
    store.clear(); storeReads = 0;
    RO.forgetRosterCopy();
    ok('no account: nothing is read, nothing is written', (await RO.readRoster(null)) === undefined && storeReads === 0
      && (RO.keepRoster(null, base), await RO.rosterWrites(), store.size === 0) && RO.rosterCopy(null) === null);
    RO.keepRoster('u:1', base);
    await RO.rosterWrites();
    const other = RO.mergeRoster(null, aNow).roster;
    RO.keepRoster('u:616', other);
    await RO.rosterWrites();
    ok('each account has its own saved row (u:1 and the test account u:616 never share one)',
      store.has('home_roster_v1:u:1') && store.has('home_roster_v1:u:616') && JSON.parse(store.get('home_roster_v1:u:1')).selected === K(J.cyber)
      && RO.rosterCopy('u:1') === null && RO.rosterCopy('u:616') === other);
    RO.forgetRosterCopy();
    const back = await RO.readRoster('u:1');
    const backRow = RO.rosterRow(back);
    ok('⚠️ RELAUNCH / REMOUNT: the saved row reads back as it was — same chips, same order, Airbus Cyber selected at index 4',
      same(keysOf(backRow), base.keys) && back.selected === K(J.cyber) && keysOf(backRow).indexOf(back.selected) === 4
      && identity(back.snap[K(J.cyber)]) === identity(cyberBefore) && RO.rosterCopy('u:1') === back);
    await RO.editRoster('u:1', (x) => RO.rosterSelect(x, K(J.risk)));
    await RO.rosterWrites();
    ok('a pick is written straight through (editRoster)', JSON.parse(store.get('home_roster_v1:u:1')).selected === K(J.risk));
    await RO.editRoster('u:1', (x) => RO.rosterSelect(x, 'emp_pending_nobody'));
    ok('…a key the row does not keep leaves the saved selection alone', RO.rosterCopy('u:1').selected === K(J.risk));
    RO.forgetRosterCopy();
    store.set('home_roster_v1:u:1', '{not json');
    ok('bad JSON is "no saved row" — never a throw', (await RO.readRoster('u:1')) === null);
    RO.forgetRosterCopy();
    store.set('home_roster_v1:u:1', JSON.stringify({ v: 1, keys: ['emp_x', 'emp_y'], snap: { emp_x: { key: 'emp_x', company: 'X' }, emp_y: { key: 'nope' } }, selected: 'emp_y' }));
    const patched = await RO.readRoster('u:1');
    ok('a stored row is checked chip by chip: a bad chip is dropped, a thin one gets its colours / initial back',
      same(patched.keys, ['emp_x']) && patched.selected === 'emp_x' && Array.isArray(patched.snap.emp_x.colors) && patched.snap.emp_x.initial === 'X');
    RO.forgetRosterCopy();
    storeThrows = true;
    ok('⚠️ storage that will not read is `undefined` — the screen must not seed over it', (await RO.readRoster('u:1')) === undefined);
    storeThrows = false;

    // ════════════════════════════════════════════════════════════════════════════════════════════════════
    // ⚠️ THE ROW IS THE ACCOUNT'S ON EVERY PHONE (2026-09-20). Production app_events: user 1 on install a_kz5txdx3…
    // (4.6 b203) until 16:29:52 UTC on 2026-09-19, then on a_ehuc9bgx… (b209, where test account 616 had been signed
    // in) from 16:32:53 — two phones, minutes apart. A row kept only in one phone's AsyncStorage made the other phone
    // seed its own from the ranking: another row, another chip selected. These run REAL homeRoster instances — one
    // per phone, each with its own storage and memory — against the REAL server handlers (server/services/homeRoster.js).
    // ════════════════════════════════════════════════════════════════════════════════════════════════════
    console.log('── ⚠️ THE ROW IS THE ACCOUNT\'S ON EVERY PHONE: kept on the server, compare-and-set (2026-09-20) ──');
    await RO.rosterSync(); RO.forgetRosterCopy(); store.clear(); rosterRows.clear();
    srv.rosterReqs = []; srv.roster = 'ok'; sessionUser = 1;
    // (Amazon's un-hide above is in its 30 s grace on this "device"; keep it visible either way so no load flips it.)
    srv.hidden = srv.hidden.filter((k) => k !== K(J.amazon));
    const phone = () => {
      const st = new Map();
      const as = { __esModule: true, default: {
        getItem: async (k) => (st.has(k) ? st.get(k) : null),
        setItem: async (k, v) => { st.set(k, v); },
        removeItem: async (k) => { st.delete(k); },
        multiRemove: async (ks) => { for (const k of ks) st.delete(k); },
      } };
      const P = loadR(rosterSrc, (id) => (/employerHomeService/.test(id) ? ehs : /async-storage/.test(id) ? as
        : /secure-store/.test(id) ? secure : /config/.test(id) ? { API_BASE: 'https://api.test' } : {}));
      return { P, store: st };
    };
    const PA = RO;            // phone A: the harness's own instance and storage
    const PB = phone().P;     // phone B: a second phone, nothing saved on it
    // load()'s own steps, in its order: the answer and the server copy together → rowAccounts → readRoster →
    // savedRowOf → planRow → keepRoster (then the debounced write, flushed here).
    const loadOn = async (P, shown = 0) => {
      const [a, remote] = await Promise.all([ask(), P.fetchRemoteRoster('u:1')]);
      const { acct, owner } = P.rowAccounts('u:1', 'u:1');
      const stored = await P.readRoster(owner);
      const picked = P.savedRowOf(owner, P.rosterCopy(owner) || stored, acct ? remote : undefined);
      const plan = P.planRow(picked.row, a, { shown });
      if (plan.save) P.keepRoster(acct, plan.merged.roster);
      await P.rosterSync();
      await P.rosterWrites();
      return { remote, picked, plan, keys: plan.merged.roster.keys, sel: plan.merged.roster.selected };
    };
    const serverRow = () => { const r = rosterRows.get(1); return r ? { rev: r.rev, ...JSON.parse(r.text) } : null; };
    const puts = () => srv.rosterReqs.filter((x) => x.method === 'PUT').length;
    const NOW = Date.now();

    const pa1 = await loadOn(PA);
    ok('phone A, first launch: the server has no row (rev 0) — it seeds from the ranking as before, and WRITES that row (rev 1)',
      !!pa1.remote && pa1.remote.rev === 0 && pa1.remote.roster === null && !pa1.picked.adopted && pa1.plan.save
      && !!serverRow() && serverRow().rev === 1 && same(serverRow().keys, pa1.keys) && PA.rosterCopy('u:1').rev === 1 && pa1.keys.length >= 8,
      { server: serverRow() && serverRow().keys, a: pa1.keys });
    ok('…the stored body carries no `rev` (the column is the revision)', !('rev' in JSON.parse(rosterRows.get(1).text)));
    const A0 = PA.rosterCopy('u:1');
    const [gone1, gone2, pickA] = [A0.keys[0], A0.keys[1], A0.keys[5]];
    await PA.editRoster('u:1', (r) => PA.rosterRemove(r, gone1));
    await PA.editRoster('u:1', (r) => PA.rosterRemove(r, gone2));
    await PA.editRoster('u:1', (r) => PA.rosterSelect(r, pickA, NOW + 1000));
    const putsA = puts();
    await PA.rosterSync();
    ok('phone A: two X\'s and a pick reach the server as ONE write, compare-and-set on rev 1 → rev 2',
      puts() === putsA + 1 && serverRow().rev === 2 && !serverRow().keys.includes(gone1) && !serverRow().keys.includes(gone2)
      && serverRow().selected === pickA && PA.rosterCopy('u:1').rev === 2, serverRow());

    const putsB = puts();
    const b1 = await loadOn(PB);
    ok('⚠️ phone B, FIRST launch (nothing saved on it): it takes the SERVER\'s row — the same chips, in the same order, the same chip selected as on phone A',
      b1.picked.adopted && same(b1.keys, PA.rosterCopy('u:1').keys) && b1.sel === pickA && PB.rosterCopy('u:1').rev === 2,
      { b: b1.keys, a: PA.rosterCopy('u:1').keys, sel: b1.sel });
    ok('…not a seed of its own: the two chips removed on phone A stay removed although the ranking still offers them',
      !b1.keys.includes(gone1) && !b1.keys.includes(gone2) && PB.mergeRoster(null, await ask()).roster.keys.includes(gone1));
    ok('…and it writes nothing back: the row it took IS the server\'s (jsonb re-ordered every key — that is no change)',
      puts() === putsB, srv.rosterReqs.slice(putsB));

    const [pickB, gone3] = [b1.keys[2], b1.keys[3]];
    await PB.editRoster('u:1', (r) => PB.rosterRemove(r, gone3));
    await PB.editRoster('u:1', (r) => PB.rosterSelect(r, pickB, NOW + 2000));
    await PB.rosterSync();
    ok('phone B: its X and its pick are written on rev 2 → rev 3', serverRow().rev === 3 && !serverRow().keys.includes(gone3) && serverRow().selected === pickB);
    const pa2 = await loadOn(PA, PA.rosterCopy('u:1').keys.length);
    ok('⚠️ phone A (its own row still rev 2) takes rev 3 at its next load: phone B\'s X is gone here too, and phone B\'s LATER pick is selected',
      pa2.picked.adopted && same(pa2.keys, serverRow().keys) && pa2.sel === pickB && PA.rosterCopy('u:1').rev === 3, { a: pa2.keys, sel: pa2.sel });

    // Both at rev 3. Phone A removes a chip while phone B picks another — and phone B's write lands first.
    const s3 = serverRow();
    const [gone4, pickB2] = [s3.keys[4], s3.keys[0]];
    await PA.editRoster('u:1', (r) => PA.rosterRemove(r, gone4));
    await PB.editRoster('u:1', (r) => PB.rosterSelect(r, pickB2, NOW + 3000));
    await PB.rosterSync();
    const putsC = puts();
    await PA.rosterSync();
    const s5 = serverRow();
    ok('⚠️ CONFLICT: phone A\'s write made from rev 3 is REFUSED (409) — never stored over phone B\'s rev 4 — then phone A lays its X over rev 4 and writes that (rev 5): both edits survive',
      puts() === putsC + 2 && srv.rosterReqs.slice(-2).map((x) => x.status).join() === '409,200'
      && s5.rev === 5 && !s5.keys.includes(gone4) && s5.selected === pickB2 && PA.rosterCopy('u:1').rev === 5 && same(PA.rosterCopy('u:1').keys, s5.keys),
      { reqs: srv.rosterReqs.slice(-2).map((x) => x.status), s5 });
    const b2 = await loadOn(PB, PB.rosterCopy('u:1').keys.length);
    ok('…and phone B takes rev 5 at its next load: one row, both phones', b2.picked.adopted && same(b2.keys, s5.keys) && b2.sel === pickB2);

    // A phone that was away: its own row is the old rev-1 seed, and its load cannot read the server.
    store.set('home_roster_v1:u:1', JSON.stringify({ ...pa1.plan.merged.roster, rev: 1 }));
    PA.forgetRosterCopy();
    srv.roster = 'fail';
    const c1 = await loadOn(PA, pa1.keys.length);
    srv.roster = 'ok';
    ok('(a phone that was away, whose server read fails: it merges into its OWN old row — it has one)',
      !!c1.picked.row && c1.picked.row.rev === 1 && !c1.picked.adopted && c1.keys.includes(gone1));
    await PA.editRoster('u:1', (r) => PA.rosterSelect(r, gone2, NOW - DAY));
    await PA.rosterSync();
    ok('⚠️ …and its next write — made from rev 1 — is REFUSED, not stored over rev 5: the server keeps phone B\'s chips and pick, and that phone now holds them too',
      same(serverRow().keys, s5.keys) && serverRow().selected === pickB2 && serverRow().rev === 5
      && same(PA.rosterCopy('u:1').keys, s5.keys) && PA.rosterCopy('u:1').selected === pickB2 && PA.rosterCopy('u:1').rev === 5,
      { server: serverRow(), a: PA.rosterCopy('u:1') && PA.rosterCopy('u:1').keys });

    // A NEW phone whose server read fails: nothing seeded, nothing written.
    const PC = phone();
    srv.roster = 'fail';
    const putsF = puts();
    const f1 = await loadOn(PC.P, 0);
    ok('⚠️ a NEW phone whose server read FAILS keeps nothing: the ranking is shown for this one load, unsaved, and nothing is written',
      f1.remote === undefined && f1.picked.row === undefined && !f1.plan.save && PC.P.rosterCopy('u:1') === null && PC.store.size === 0
      && puts() === putsF && serverRow().rev === 5);
    ok('…a second failed read, with that row on screen: planRow KEEPS the screen as it is', (await loadOn(PC.P, 12)).plan.keep);
    srv.roster = 'ok';
    const f3 = await loadOn(PC.P, 12);
    ok('…and the first read that answers brings the account\'s row', f3.picked.adopted && same(f3.keys, s5.keys) && f3.sel === pickB2);

    // An OLDER server (no route) — the row simply stays per phone, as before this change.
    const PD = phone();
    srv.roster = 'gone';
    const g1 = await loadOn(PD.P, 0);
    srv.roster = 'ok';
    ok('an OLDER server (404, no route) is "no server copy": the phone seeds and keeps its own row, exactly as before',
      g1.remote === null && g1.plan.save && !!PD.P.rosterCopy('u:1') && PD.store.has('home_roster_v1:u:1'));

    // ⚠️ The account: a write queued for user 1 never goes out under another account's token, and the server checks too.
    sessionUser = 616;
    const reqsH = srv.rosterReqs.length;
    const fetchedAs616 = await PA.fetchRemoteRoster('u:1');
    PA.keepRoster('u:1', PA.rosterSelect(PA.rosterCopy('u:1'), s5.keys[1], NOW + 9000));
    await PA.rosterSync();
    sessionUser = 1;
    ok('⚠️ the session now names ANOTHER account (616): u:1\'s server row is neither read nor written from this phone',
      fetchedAs616 === undefined && srv.rosterReqs.length === reqsH && serverRow().rev === 5);
    const resAcct = mkRes();
    await HR.putHomeRoster({ user: { id: 616 }, body: { account: 'u:1', base: 0, roster: s5 } }, resAcct);
    ok('…and the server refuses a body that names another account (409 account), storing nothing', resAcct.statusCode === 409 && resAcct.body.reason === 'account' && !rosterRows.has(616));
    PA.forgetRosterCopy();

    // ════════════════════════════════════════════════════════════════════════════════════════════════════
    // ⚠️ REVIEW 2026-09-20 (round 2): THE SCREEN FOLLOWS THE ROW IT WAS HANDED, AND A LOAD NEVER PICKS.
    // The owner's two-phone pattern — glance at one, pick on the other, come back. A 409 handed this phone the other
    // phone's row while its SCREEN stayed on the chip it was showing; the next load then saved that chip as a brand-new
    // pick, stamped "now", which beat the pick the user had really made on the other phone — and that phone jumped to a
    // chip nobody had picked. This runs load()'s own steps WITH the screen it draws.
    // ════════════════════════════════════════════════════════════════════════════════════════════════════
    await PA.rosterSync(); PA.forgetRosterCopy(); PB.forgetRosterCopy();
    store.clear(); rosterRows.clear(); srv.rosterReqs = []; sessionUser = 1;
    const ph1 = phone(), ph2 = phone();
    const P1 = ph1.P, P2 = ph2.P;
    const sc1 = { row: [], idx: 0, picked: null }, sc2 = { row: [], idx: 0, picked: null };
    const short = (k) => String(k || '').split('/').slice(-1)[0].slice(0, 24);
    /** load(), including what it puts on screen. `hands` = the user touched Home while it ran (acts / a build / an add). */
    const screenLoad = async (P, sc, opts = {}) => {
      const [a, remote] = await Promise.all([ask(), P.fetchRemoteRoster('u:1')]);
      const { acct, owner } = P.rowAccounts('u:1', 'u:1');
      const stored = await P.readRoster(owner);
      const picked = P.savedRowOf(owner, P.rosterCopy(owner) || stored, acct ? remote : undefined);
      const before = sc.row;
      const plan = P.planRow(picked.row, a, { shown: before.length });
      const m = plan.merged;
      if ((picked.adopted || picked.replaced) && !opts.hands && m.roster.selected
        && m.row.some((x) => x.key === m.roster.selected)) sc.picked = m.roster.selected;
      if (!sc.picked) sc.picked = (before[sc.idx] || {}).key || m.roster.selected || null;
      const oldAt = sc.picked ? before.findIndex((x) => x.key === sc.picked) : -1;
      const t = plan.keep ? before : m.row;
      let j = sc.picked ? t.findIndex((x) => x.key === sc.picked) : -1;
      if (j < 0) {
        const sel = m.roster.selected ? t.findIndex((x) => x.key === m.roster.selected) : -1;
        j = oldAt >= 0 ? Math.min(oldAt, t.length - 1) : sel;
        if (j < 0) j = 0;
      }
      const was = sc.picked;
      sc.picked = t[j] ? t[j].key : null;
      const kept = P.rosterSelect(m.roster, sc.picked, m.roster.selectedAt);
      if (plan.save) P.keepRoster(acct, kept);
      sc.row = t; sc.idx = j;
      // The selKey effect: only a CHANGE of the chip on screen is a pick, and only a pick is stamped.
      if (sc.picked && sc.picked !== was) await P.editRoster('u:1', (r) => P.rosterSelect(r, sc.picked));
      await P.rosterSync();
      await P.rosterWrites();
      return { picked, plan, sel: m.roster.selected };
    };
    await screenLoad(P1, sc1);
    await screenLoad(P2, sc2);
    const row0 = P1.rosterCopy('u:1');
    const [pickOnA, laterOnA, otherChip] = [row0.keys[3], row0.keys[1], row0.keys[5]];
    ok('(both phones open on the same row and the same chip)',
      same(P1.rosterCopy('u:1').keys, P2.rosterCopy('u:1').keys) && sc1.picked === sc2.picked && !!sc1.picked);
    // Phone A: the user picks another chip. Phone B's screen has not seen it (its load is throttled), and the user
    // removes a DIFFERENT chip there — a write made from the older revision.
    await P1.editRoster('u:1', (r) => P1.rosterSelect(r, pickOnA, NOW + 100000));
    sc1.picked = pickOnA; sc1.idx = sc1.row.findIndex((x) => x.key === pickOnA);
    await P1.rosterSync();
    await P2.editRoster('u:1', (r) => P2.rosterRemove(r, otherChip));
    await P2.rosterSync();
    ok('⚠️ a 409 hands this phone the other phone\'s row, its pick and all — while its screen still shows the old chip',
      P2.rosterCopy('u:1').selected === pickOnA && sc2.picked !== pickOnA && serverRow().selected === pickOnA
      && !serverRow().keys.includes(otherChip),
      { memory: short(P2.rosterCopy('u:1').selected), screen: short(sc2.picked) });
    const bFollow = await screenLoad(P2, sc2);
    ok('⚠️ …so its next load GOES to that chip (replaced) instead of saving the stale one over it',
      bFollow.picked.replaced && sc2.picked === pickOnA && serverRow().selected === pickOnA,
      { screen: short(sc2.picked), server: short(serverRow().selected) });
    await screenLoad(P1, sc1);
    ok('⚠️ …and phone A stays on the chip ITS user picked — it used to jump to phone B\'s stale chip, which nobody picked',
      sc1.picked === pickOnA && serverRow().selected === pickOnA, { a: short(sc1.picked), server: short(serverRow().selected) });
    // The user's hands on this screen: a load may not move the chip under them, and it stamps no pick of its own.
    await P1.editRoster('u:1', (r) => P1.rosterSelect(r, laterOnA, NOW + 200000));
    sc1.picked = laterOnA; sc1.idx = sc1.row.findIndex((x) => x.key === laterOnA);
    await P1.rosterSync();
    const busy = await screenLoad(P2, sc2, { hands: true });
    ok('⚠️ hands on the screen: the chip stays, and the row records it under the row\'s OWN pick time — never a fresh stamp',
      busy.picked.adopted && sc2.picked === pickOnA && P2.rosterCopy('u:1').selectedAt === NOW + 200000,
      { screen: short(sc2.picked), at: P2.rosterCopy('u:1').selectedAt - NOW });
    await screenLoad(P1, sc1);
    ok('…and with the same pick time on both, each phone keeps the chip it shows (nobody chose between them)',
      sc1.picked === laterOnA && sc2.picked === pickOnA, { a: short(sc1.picked), b: short(sc2.picked) });

    // ⚠️ A ROW THE SERVER REFUSES (400) IS NOT SENT AGAIN UNTIL IT CHANGES — it used to go out whole on every save.
    const putsRef = puts();
    const over = (() => {
      const r = P1.rosterCopy('u:1');
      const keys = [...r.keys]; const snap = { ...r.snap };
      for (let i = 0; i <= HR.ROSTER_MAX_KEYS; i++) { const k = 'emp_over-' + i; keys.push(k); snap[k] = { key: k, company: 'Over ' + i, colors: ['#000', '#111'], initial: 'O' }; }
      return { ...r, keys, snap };
    })();
    P1.keepRoster('u:1', over);
    await P1.rosterSync();
    const refusedAt = puts();
    P1.keepRoster('u:1', { ...over });
    await P1.rosterSync();
    const putReqs = () => srv.rosterReqs.filter((x) => x.method === 'PUT');
    ok('⚠️ a row the server refuses is sent ONCE (400), then not again until it changes — and a changed row still lands',
      refusedAt === putsRef + 1 && putReqs()[refusedAt - 1].status === 400 && puts() === refusedAt
      && await (async () => {
        P1.keepRoster('u:1', { ...over, keys: over.keys.slice(0, 20), snap: over.snap });
        await P1.rosterSync();
        return puts() === refusedAt + 1 && putReqs()[refusedAt].status === 200;
      })(), putReqs().slice(putsRef).map((x) => x.method + ' ' + x.status));

    // ⚠️ THE ACCOUNT WAS DELETED (server.js clears user_home_roster): a phone still holding a copy must not bring it back.
    rosterRows.delete(1);
    srv.rosterReqs = [];
    await P2.editRoster('u:1', (r) => P2.rosterRemove(r, r.keys[2]));
    await P2.rosterSync();
    await P2.rosterWrites();
    ok('⚠️ a write made from a revision the server has NO row for answers 409 { rev 0 }: the copy goes, nothing is uploaded',
      srv.rosterReqs.length === 1 && srv.rosterReqs[0].status === 409 && !rosterRows.has(1)
      && P2.rosterCopy('u:1') === null && !ph2.store.has('home_roster_v1:u:1'),
      srv.rosterReqs.map((x) => x.method + ' ' + x.status));
    const reseed = await screenLoad(P2, sc2);
    ok('…and the next complete load seeds afresh (rev 1), instead of putting the deleted account\'s row back',
      reseed.plan.save && !!rosterRows.get(1) && rosterRows.get(1).rev === 1 && P2.rosterCopy('u:1').rev === 1);
    store.clear(); rosterRows.clear(); srv.rosterReqs = [];
    P1.forgetRosterCopy(); P2.forgetRosterCopy();

    // The pure rule, on its own.
    const L = { ...s5, rev: 5, selected: s5.keys[2], selectedAt: NOW + 5000 };
    const older = { ...s5, rev: 6, selectedAt: NOW + 4000 };
    ok('pickSaved: the server unreadable → this phone\'s row; none of its own → undefined, never null (planRow then seeds nothing)',
      PA.pickSaved(L, undefined).row === L && PA.pickSaved(null, undefined).row === undefined && PA.pickSaved(undefined, undefined).row === undefined);
    ok('pickSaved: no server copy (an older server, or no row yet) → this phone\'s — a null stays null, so the first load seeds',
      PA.pickSaved(L, null).row === L && PA.pickSaved(null, { roster: null, rev: 0 }).row === null);
    ok('⚠️ pickSaved: the server has NO row although this phone\'s came FROM one (the account was deleted) → seed afresh, never upload it again',
      PA.pickSaved(L, { roster: null, rev: 0 }).gone === true && PA.pickSaved(L, { roster: null, rev: 0 }).row === null
      && PA.pickSaved({ ...L, rev: 0 }, { roster: null, rev: 0 }).row !== null && !PA.pickSaved({ ...L, rev: 0 }, { roster: null, rev: 0 }).gone);
    ok('pickSaved: the server\'s row only when it is NEWER than this phone\'s', PA.pickSaved(L, { roster: { ...L, keys: [] }, rev: 5 }).row === L
      && PA.pickSaved(L, { roster: older, rev: 6 }).adopted && same(PA.pickSaved(L, { roster: older, rev: 6 }).row.keys, s5.keys));
    ok('⚠️ …and the LATER pick wins, by when it was MADE: this phone\'s newer pick survives a newer row; a replayed old pick does not beat the other phone\'s',
      PA.pickSaved(L, { roster: older, rev: 6 }).row.selected === s5.keys[2]
      && PA.pickSaved({ ...L, selectedAt: NOW }, { roster: older, rev: 6 }, [(r) => PA.rosterSelect(r, s5.keys[2])]).row.selected === s5.selected
      && PA.pickSaved(L, { roster: older, rev: 6 }, [(r) => PA.rosterRemove(r, s5.keys[3])]).row.keys.indexOf(s5.keys[3]) === -1);

    // The server's bounds.
    const putAs = async (uid, body) => { const r = mkRes(); await HR.putHomeRoster({ user: { id: uid }, body }, r); return r; };
    const good = { v: 1, keys: ['emp_x'], snap: { emp_x: { key: 'emp_x', company: 'X' } }, selected: 'emp_x', rev: 99 };
    const bad = await Promise.all([
      putAs(7, { account: 'u:7', base: -1, roster: good }),
      putAs(7, { account: 'u:7', base: 0, roster: { v: 2, keys: [], snap: {} } }),
      putAs(7, { account: 'u:7', base: 0, roster: { ...good, keys: Array.from({ length: 65 }, (_, i) => 'emp_' + i) } }),
      putAs(7, { account: 'u:7', base: 0, roster: { ...good, pad: 'x'.repeat(HR.ROSTER_MAX_BYTES) } }),
    ]);
    ok('the server bounds the body: a bad base, not a row, 65 chips, over 512 KB → 400, nothing stored',
      bad.every((r) => r.statusCode === 400) && !rosterRows.has(7), bad.map((r) => r.statusCode));
    // ⚠️ REVIEW 2026-09-20: WHAT JSONB REFUSES IS CLEANED, NOT REFUSED. An employer named "🚀 Rocket Lab" takes its chip
    // letter from name[0] — half of an emoji (a lone surrogate) — and jsonb refuses that as it refuses a NUL, so the
    // upsert THREW: a 500 on this and every later write for that account, for as long as the chip stayed on the row.
    const HALF = String.fromCharCode(0xd83d);
    const emojiRow = { ...good, snap: { emp_x: { key: 'emp_x', company: HALF + ' Rocket Lab', initial: HALF, note: 'A' + String.fromCharCode(0) + 'B' } } };
    const wEmoji = await putAs(9, { account: 'u:9', base: 0, roster: emojiRow });
    const g9 = mkRes(); await HR.getHomeRoster({ user: { id: 9 } }, g9);
    const w9b = await putAs(9, { account: 'u:9', base: 1, roster: { ...emojiRow, selected: null } });
    ok('⚠️ half an emoji (and a NUL) are CLEANED out of the body: the write lands, and the account is not frozen at 500 for ever',
      wEmoji.statusCode === 200 && g9.body.roster.snap.emp_x.company === String.fromCharCode(0xfffd) + ' Rocket Lab'
      && g9.body.roster.snap.emp_x.note === 'AB' && w9b.statusCode === 200 && w9b.body.rev === 2,
      { put: wEmoji.statusCode, stored: g9.body.roster && g9.body.roster.snap.emp_x, again: w9b.statusCode });
    ok('⚠️ the server file is TEXT: one raw NUL byte in it made git read the WHOLE file as binary — no diff, no blame, no grep',
      !fs.readFileSync(path.join(__dirname, '../../server/services/homeRoster.js')).includes(0) && !fs.readFileSync(__filename).includes(0));
    const w1 = await putAs(7, { account: 'u:7', base: 0, roster: good });
    const w2 = await putAs(7, { account: 'u:7', base: 0, roster: { ...good, selected: null } });
    ok('⚠️ a seed (base 0) never overwrites a row that exists: 409 with the stored row; a `rev` in the body is ignored',
      w1.statusCode === 200 && w1.body.rev === 1 && w2.statusCode === 409 && w2.body.reason === 'conflict' && w2.body.rev === 1
      && w2.body.roster.selected === 'emp_x' && !('rev' in w2.body.roster), [w1.body, w2.body]);
    const g7 = mkRes(); await HR.getHomeRoster({ user: { id: 7 } }, g7);
    const g8 = mkRes(); await HR.getHomeRoster({ user: { id: 8 } }, g8);
    ok('GET answers the account, the revision and the row — and for a user with none, rev 0 and roster null',
      g7.body.account === 'u:7' && g7.body.rev === 1 && g7.body.roster.keys[0] === 'emp_x' && g8.body.account === 'u:8' && g8.body.rev === 0 && g8.body.roster === null);

    // The wiring.
    const hrSrc = R('../../server/services/homeRoster.js');
    const hubRoutesSrc = R('../../server/routes/aiHub.js');
    const serverSrc = R('../../server.js');
    ok('⚠️ load() reads the server copy WITH its answer (the claim\'s session, no extra round trip) and merges into savedRowOf\'s pick',
      /const \[answer, c, cat, claim, remote\] = await Promise\.all\(\[[\s\S]{0,300}?\n      remoteP,\n    \]\);/.test(loadBody)
      && /const remoteP: Promise<RemoteRoster \| null \| undefined> = loaders\s*\? Promise\.resolve\(undefined\)\s*: claiming\.then\(\(\{ who \}\) => fetchRemoteRoster\(who\)\)\.catch\(\(\) => undefined\);/.test(loadBody));
    // ⚠️ REVIEW 2026-09-20 (the server copy): a 409 handed this phone the other phone's row and the SCREEN stayed behind;
    // the next load then saved the chip it still showed as a brand-new pick, stamped now, and the other phone jumped to it.
    ok('⚠️ …and when another phone\'s row was taken — adopted here, or put in place by a 409 (replaced) — the screen goes to its pick',
      /const handsOn = acts\.current !== actsAt \|\| selBuildingRef\.current \|\| String\(pickedKey\.current \|\| ''\)\.startsWith\(PENDING\);\s*if \(picked && \(picked\.adopted \|\| picked\.replaced\) && !handsOn\s*&& m\.roster\.selected && m\.row\.some\(\(x\) => x\.key === m\.roster\.selected\)\) pickedKey\.current = m\.roster\.selected;/.test(loadBody)
      && loadBody.indexOf('picked.replaced') < loadBody.indexOf('if (!pickedKey.current) pickedKey.current = before['));
    ok('⚠️ …never under the user\'s hands: a touch on Home during the load, a build for the chip on screen, or a chip being added',
      /const acts = useRef\(0\);/.test(homeC) && /const noteTouch = useCallback\(\(\) => \{ acts\.current\+\+; \}, \[\]\);/.test(homeC)
      && /<View style=\{s\.root\}[\s\S]{0,120}?onTouchStart=\{noteTouch\}>/.test(homeC)
      && /const actsAt = acts\.current;/.test(loadBody)
      && /const pickEmployer = \(i: number\) => \{\s*acts\.current\+\+;/.test(homeC)
      && /return \(\) => \{ focused\.current = false; acts\.current\+\+; \};/.test(homeC));
    ok('⚠️ a load never STAMPS a pick: it records the chip on screen under the row\'s own pick time (only the user\'s tap stamps)',
      /const kept = rosterSelect\(m\.roster, pickedKey\.current, m\.roster\.selectedAt\);/.test(loadBody)
      && !/rosterSelect\(m\.roster, pickedKey\.current\)/.test(loadBody));
    ok('⚠️ the server\'s row comes on screen as soon as it answers, before the dashboard behind it — never over a touched screen',
      /const other = savedRowOf\(owner, rosterCopy\(owner\) \|\| saved, remote, \{ peek: true \}\);/.test(loadBody)
      && /const untouched = \(\) => !committed && alive\.current && seq === loadSeq\.current && cacheOwner === owner\s*&& acts\.current === actsAt && !selBuildingRef\.current && !String\(pickedKey\.current \|\| ''\)\.startsWith\(PENDING\);/.test(loadBody)
      && /keepRoster\(acct, other\.row\);\s*paintSaved\(other\.row, true\);/.test(loadBody)
      && loadBody.indexOf('const other = savedRowOf(') < loadBody.indexOf('const [answer, c, cat, claim, remote]'));
    ok('⚠️ a phone picked up again reads the server\'s row on AppState "active" (one row, never the dashboard) and follows it',
      /const resumeRow = useStableFn\(async \(\) => \{/.test(homeC)
      && /if \(next === 'active' && was === 'background'\) resumeRow\(\)\.catch\(\(\) => \{\}\);/.test(homeC)
      && /const other = savedRowOf\(acct, local, remote, \{ peek: true \}\);\s*if \(!other\.adopted \|\| !other\.row \|\| !other\.row\.keys\.length\) return;\s*keepRoster\(acct, other\.row\);\s*paintSaved\(other\.row, true\);/.test(homeC)
      && /acts\.current !== at \|\| selBuildingRef\.current/.test(fnBodyOf(homeC, 'resumeRow')));
    ok('every save goes to the server too (keepRoster → schedulePush), and every user edit is kept until it has arrived (editRoster → unsent)',
      fnBodyOf(rosterC, 'keepRoster').includes('schedulePush(account);') && /unsent\.push\(\{ account, seq: \+\+editSeq, fn \}\);/.test(fnBodyOf(rosterC, 'editRoster'))
      && /unsent = \[\];/.test(fnBodyOf(rosterC, 'forgetRosterCopy')) && /syncGen\+\+;/.test(fnBodyOf(rosterC, 'forgetRosterCopy')));
    ok('the server: GET/PUT /home/roster behind auth; Migration 048 creates the table from the ONE definition; account deletion clears it',
      /router\.get\('\/home\/roster', authenticateToken, homeRoster\.getHomeRoster\);/.test(hubRoutesSrc)
      && /router\.put\('\/home\/roster', authenticateToken, homeRoster\.putHomeRoster\);/.test(hubRoutesSrc)
      && /const \{ TABLE_SQL: HOME_ROSTER_SQL \} = require\('\.\/server\/services\/homeRoster'\);\s*await col\(HOME_ROSTER_SQL\);/.test(dbInit)
      && /await dbConfig\.run\('DELETE FROM user_home_roster WHERE user_id = \?', \[userId\]\);/.test(serverSrc));
    ok('⚠️ one row per USER — not per store environment (the owner\'s TestFlight and store phones share it) — and no \'?\' in its SQL (dbConfig rewrites it)',
      /user_id\s+INTEGER PRIMARY KEY REFERENCES users\(id\) ON DELETE CASCADE,/.test(hrSrc) && !/environment/i.test(strip(hrSrc).replace(/'[^'\n]*'/g, ''))
      && !/\?/.test((strip(hrSrc).match(/`[^`]*`/g) || []).join('')));
    for (const P of [PA, PB, PC.P, PD.P]) P.forgetRosterCopy();
  } catch (e) {
    ok('roster phase ran without throwing', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
  } finally {
    global.fetch = realFetch;
  }
}

let deviceDone = false;
function devicePhaseDone() { deviceDone = true; }
(async () => {
  for (let i = 0; i < 400 && !deviceDone; i++) await new Promise((r) => setTimeout(r, 5));
  if (!deviceDone) ok('the device harness finished', false);
  await reportPhase();
  await libraryPhase();
  await pageSizePhase();
  await rosterPhase();
  console.log(`\nemployer home: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
