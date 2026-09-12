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
ok('Customize opens the SECTION EDITOR (and the builder when it is only a sample)',
  /if \(sample\) armBuilderFor\(target\)/.test(homeC) && /nav\(\)\?\.push\?\.\('\/\(resume-builder\)\/preview'\)/.test(homeC));
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
ok('re-download goes through the server, which re-runs the same gate', /redownload\(it\.id\)/.test(homeC));
ok('⚠️ a locked row opens the SAME purchase sheet a first download offers',
  /r\.locked/.test(homeC) && /<DownloadPaywallSheet/.test(homeC));
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
ok('the resume picker is restricted to PDF, which is what the parser can read',
  /type: 'application\/pdf'/.test(wiz));
ok('⚠️ generating is behind an explicit tap, never on step entry',
  /onPress=\{onStart\}/.test(wiz) && !/useEffect\([\s\S]{0,120}build\(\)/.test(wiz));
ok('it resumes at the first unfinished step', /!s\.setup\.profile \? 0 :/.test(wiz));
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
  /step === 3 && \(\s*<BuildStep/.test(wiz) && /onPress=\{onStart\}/.test(wiz));

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
// The user's standing rule (the letters auto-regen incident): never charge silently. After the free build
// (1 per 30 days) or the plan quota is used, canConsumeMany falls through to LEGACY CREDITS (2) and
// consumeOnSuccess takes them with no prompt. So Home asks a dry-run gate first.
ok('there is a dry-run gate the build is checked against', /router\.post\('\/generation-gate'/.test(routes));
ok('⚠️ the gate knows the per-employer cache, so a resume already paid for is never paywalled',
  /via: 'cache'|via:'cache'/.test(ctl));
// ⚠️ The gate is a snapshot seconds before the build and canConsumeMany does not reserve, so the last plan
// unit can go in between. coveredOnly makes the SERVER refuse the credits lane rather than fall into it.
ok('⚠️ an auto-started build cannot fall through to credits', /const coveredOnly = !!\(req\.body && req\.body\.coveredOnly === true\)/.test(ctl));
ok('…re-asked at the moment of payment, because the AI minute sits in between', /lost its cover during the run/.test(ctl));
// ⚠️ RETARGETED to useHomeBuilds, where the gate is read now. coveredOnly:false is sent from exactly two
// places: the Build button of a dialog that named the charge, and a queued build whose consent covers the
// price the re-read gate asks (consentCovers).
ok('⚠️ credits are spent only after an explicit confirm',
  /text: 'Build',[\s\S]{0,200}runBuild\(latest\(\), 'credits', false,/.test(kHookC)
  && (kHookC.match(/runBuild\((?:[^()]|\([^()]*\))*?, false,/g) || []).length === 3
  && /if \(consentCovers\(q\.consent, gate\)\) \{[\s\S]{0,200}runBuild\(job, [^)]*, false,/.test(kHookC));
ok('⚠️ an unknown gate answer asks first, never auto-builds',
  /gate\.reason === 'unknown'/.test(kHookC) && /runBuild\(latest\(\), 'unknown', false,/.test(kHookC)
  && /if \(gate\.covered\) \{ runBuild\(final, gate\.via, true,/.test(kHookC));

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

console.log(`\nemployer home: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
