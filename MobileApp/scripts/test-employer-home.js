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
const svc = R('../services/employerHomeService.ts');
const hs = R('../components/HomeScreen.js');
const ctl = R('../../server/controllers/resumeBuilderController.js');
const routes = R('../../server/routes/resumeBuilder.js');
const FILES = {
  'EmployerHome.tsx': home, 'MeshStage.tsx': mesh, 'PaperCarousel.tsx': carousel,
  'theme.ts': theme, 'HomeBoundary.tsx': boundary, 'employerHomeService.ts': svc, 'HomeScreen.js': hs,
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
ok('dark stage #070A18 with a 34pt rounded bottom', /stage: '#070A18'/.test(theme) && /borderBottomLeftRadius: 34/.test(mesh));
// ⚠️ b202 drew these as circular Views holding LinearGradients — with no overflow:hidden, each
// painted a hard-edged SQUARE across the hero. They are full-bleed washes now: every layer
// covers the whole stage, so there is no edge anywhere to see.
ok('three drifting colour washes (blue, violet, teal)', (mesh.match(/<Wash/g) || []).length === 3);
ok('every wash is oversized so its own bounds never enter frame', /left: '-25%', right: '-25%'/.test(mesh));
ok('the stage clips to its radius', /overflow: 'hidden',\s+\/\/ ⚠️ load-bearing/.test(mesh));
ok('the rectangle bug is written down where it happened', /painted as a hard-edged SQUARE/.test(mesh));
ok('the faint grid is there', /i \* 30/.test(mesh));
ok('the live pill + pulsing dot', /TAILORED PER EMPLOYER · LIVE/.test(home) && /function LiveDot/.test(home));
ok('the headline splits into sans + serif-italic accent', /h1Accent/.test(home) && /fontStyle: 'italic'/.test(home));
ok('the CTA shimmer sweep exists', /function Shimmer/.test(home) && /shimmer:/.test(home));
ok('employer chips carry initial, company, role and match', /chipTileTx/.test(home) && /chipRole/.test(home) && /chipPctTx/.test(home));
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
ok('companies are deduped across the two stores', /seen\.has\(company\.toLowerCase\(\)\)/.test(svc));
ok('best match leads', /out\.sort\(\(a, b\) => \(b\.match \?\? -1\) - \(a\.match \?\? -1\)\)/.test(svc));
ok('the carousel shows the user’s REAL rendered resume', /resume-builder\/home-cards/.test(svc));

console.log('── server: the carousel previews are cached, never re-rendered per open ──');
ok('a home-cards route exists', /router\.get \('\/home-cards'/.test(routes));
ok('every card is disk-cached per resume version', /async function cachedThumb/.test(ctl) && /resume_thumb_\$\{userId\}/.test(ctl));
ok('the batch is capped below the chromium crash threshold', /\.slice\(0, 5\)/.test(ctl) && /recycles its browser every 3/.test(ctl));
ok('the user’s chosen design leads the carousel', /const fallback = \['banner'/.test(ctl) && /\[pref, \.\.\.asked/.test(ctl));
ok('stale versions are pruned', /async function pruneThumbs/.test(ctl));
ok('no resume yet is a clean 404, not a 500', /reason: 'no_resume'/.test(ctl));

console.log('── the pricing model is NOT changed by a mockup ──');
// The mockup sells one PDF for €1.99 ("no subscription"). This app shipped subscriptions to both
// stores; the CTA keeps the design and routes to the real gate.
// Comments are commentary — only executable lines can ship a price.
const homeCode = home.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
ok('no €1.99 / one-time-purchase checkout was copied in', !/1\.99|one-time purchase|Pay by card/.test(homeCode));
ok('the conflict is documented where the CTA lives', /SUBSCRIPTION model/.test(home) && /pricing bug/.test(home));
ok('the reassurance line is true for OUR model', /downloads are on paid plans/.test(home) && /downloads are on your plan/.test(home));
ok('paid state is read from the server, not guessed', /fetchSubscriptionStatus/.test(home));

console.log('── it degrades gracefully ──');
ok('no resume → a build-my-resume state, not an empty carousel', /function NoResume/.test(home) && /Build with AI/.test(home));
ok('no targets → a find-a-job prompt', /Find a job to design your resume around/.test(home));
ok('loading shows chip skeletons', /chipSkeleton/.test(home));
ok('pull-to-refresh is wired', /RefreshControl/.test(home));
ok('bottom padding clears the floating tab bar', /paddingBottom: 108/.test(home));

console.log('── the bugs the first on-screen look caught (b202) ──');
// Every one of these was invisible to a type-check and obvious in a screenshot.
ok('the dashboard top bar does NOT render on the new Home (two headers stacked)',
  /\{showDashboard && \(\n      <View style=\{styles\.topBar\}>/.test(hs));
ok('the mesh has no circular blobs left to paint as squares', !/<Blob/.test(mesh));
ok('each glow stops before the far edge, so they stay three glows and not one flat field',
  (mesh.match(/locations=\{\[/g) || []).length === 3);
ok('the carousel centres from a MEASURED width, not module-load Dimensions',
  /onLayout=\{\(e\) => setWidth/.test(carousel) && !/Dimensions/.test(carousel));
ok('the reflection is a sliver, not a grey bar', /height: 6, marginTop: 7/.test(carousel));
ok('the glare is a gradient, not a hard white block', /transparent', 'rgba\(255,255,255,0\.42\)', 'transparent/.test(carousel));
ok('target cards cannot stretch when the count is odd', !/flexGrow: 1, backgroundColor: E\.surface/.test(home));
ok('target thumbnails use expo-image (RN Image did not paint the data URI)', /ExpoImage source=\{\{ uri: image \}\}/.test(home));
ok('a signed-out preview route exists for looking at this before shipping',
  fs.existsSync(path.join(__dirname, '../app/(dev)/home-preview.tsx')));
ok('…and nothing in the app links to it', !new RegExp('home-preview').test(home + hs));

// ── Round 3: what a 72-agent preflight review found in the build that was about to ship ──
// Every assertion below is a defect that survived adversarial verification. They are checked
// against COMMENT-STRIPPED source: the fixes are documented in prose that repeats the very
// tokens being tested, and an assertion that matches its own explanation proves nothing.
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const homeC = strip(home), svcC = strip(svc), hsC = strip(hs), carC = strip(carousel), ctlC = strip(ctl);

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
ok('the hero pads itself by the real inset', /paddingTop: insets\.top \+ Platform\.select/.test(homeC) && /useSafeAreaInsets/.test(homeC));
ok('status-bar glyphs switch to light on the near-black hero', /barStyle=\{showDashboard \? 'dark-content' : 'light-content'\}/.test(hsC));

console.log('── iOS clips a shadow drawn on the same view as overflow:hidden ──');
ok('the paper shadow lives on a wrapper', /paperShadow: \{/.test(carC) && !/overflow: 'hidden'[^}]*shadowColor/.test(carC));
ok('the clipped paper view carries no shadow of its own', !/paper: \{[^}]*shadowColor/s.test(carC));
ok('the CTA glow lives on the touchable', /ctaShadow: \{/.test(homeC) && /onPress=\{onDownload\} style=\{s\.ctaShadow\}/.test(homeC));
ok('the clipped CTA gradient carries no shadow of its own', !/  cta: \{[^}]*shadowColor/s.test(homeC));

console.log('── the CTA label must give way, not push its icon out of the button ──');
ok('ctaTx can shrink', /ctaTx: \{[^}]*flexShrink: 1/.test(homeC));

console.log('── selection and screen state survive a refresh ──');
ok('the picked employer is pinned by key, not by list position', /pickedKey = useRef<string \| null>\(null\)/.test(homeC));
ok('…and is re-resolved after every load', /t\.findIndex\(\(x\) => x\.key === pickedKey\.current\)/.test(homeC));
ok('…and only after the user actually picks', /pickedKey\.current = targets\[i\]\?\.key/.test(homeC));
ok('the Dashboard survives a HomeScreen remount', /let _showDashboardCache = false/.test(hsC) && /useState\(_showDashboardCache\)/.test(hsC));
ok('…and every setter writes the cache', /_showDashboardCache = !!v/.test(hsC));

console.log('── the thumbnail cache ──');
ok('the key includes the photo version', /':' \+ pver \+ ':' \+ tplId/.test(ctlC));
ok('cachedThumb reports the filename it used', (ctlC.match(/file: path\.basename\(file\)/g) || []).length === 2);
ok('…and homeCards never recomputes that key (pruneThumbs would delete every fresh thumb)',
  /files\.push\(c\.file\)/.test(ctlC) && !/files\.push\(`resume_thumb_/.test(ctlC));

console.log(`\nemployer home: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
