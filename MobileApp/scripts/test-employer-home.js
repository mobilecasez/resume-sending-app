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
const studioSrc = R('../components/onboarding/SignatureStudio.tsx');
const countrySheetSrc = R('../components/onboarding/CountrySheet.tsx');
const countrySheetC = strip(countrySheetSrc);
const countriesSrc = R('../constants/countries.ts');
const studioC = strip(studioSrc);
const FILES = {
  'EmployerHome.tsx': home, 'MeshStage.tsx': mesh, 'PaperCarousel.tsx': carousel,
  'theme.ts': theme, 'HomeBoundary.tsx': boundary, 'employerHomeService.ts': svc, 'HomeScreen.js': hs,
  'PaperZoom.tsx': zoomSrc, 'AddEmployerSheet.tsx': sheetSrc, 'DownloadHistory.tsx': histSrc,
  'SignatureStudio.tsx': studioSrc, 'CountrySheet.tsx': countrySheetSrc, 'countries.ts': countriesSrc,
  'onboarding/index.tsx': R('../app/(onboarding)/index.tsx'),
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
ok('dark stage #070A18, full-bleed — the rounded bottom is GONE so it can melt into the grey',
  /stage: '#070A18'/.test(theme) && !/borderBottomLeftRadius/.test(mesh) && /fadeFrom/.test(mesh));
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
ok('there is NO download button on Home — the actions live in the opened page',
  !/function Shimmer/.test(home) && !/ctaTx:/.test(home) && !/Download for /.test(home));
ok('a chip identifies a POSTING: company over role, plus the match',
  /chipTileTx/.test(home) && /chipPctTx/.test(home) && /chipRole/.test(home)
  && /\{!!t\.role && <Text style=\{\[s\.chipRole/.test(homeC));
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
ok('the user’s chosen design leads the carousel', /const fallback = \['banner'/.test(ctl) && /\[pref, \.\.\.asked/.test(ctl));
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
ok('bottom padding clears the floating tab bar', /paddingBottom: 108/.test(home));

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
ok('the reflection is a sliver, not a grey bar', /height: 6, marginTop: 7/.test(carousel));
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
  /chipText: \{ flexShrink: 1 \}/.test(homeC) && /ghostTx: \{[^}]*flexShrink: 1/.test(strip(zoomSrc))
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
ok('the stage keeps its top band flat for the header to sit on', /rgba\(7,10,24,0\.92\)', 'transparent'/.test(strip(mesh)));

console.log('── the first screenful is all gradient; grey is met on the way down ──');
// ⚠️ RETARGETED. The rule stands — screen one must be unbroken gradient — but it is no longer
// bought with `rootH * 1.18`, which paid for it with 150pt of empty gradient nobody asked for.
// The floor below is what now guarantees it; see THE SEAM further down for the rest.
ok('the stage still fills the first screenful', /Math\.round\(rootH \* 0\.98\)/.test(homeC));
ok('…and the melt is the LAST part of it, wherever the content ended',
  /const fadeFrom = Math\.max\(0\.3, \(stageH - MELT\) \/ stageH\)/.test(homeC));

console.log('── compact mode icons, glass employer chips ──');
ok('the full-width tab pair is gone', !/toggleBtnOn/.test(home) && /function ModeSwitch/.test(homeC));
ok('the switch rides the headline row', /<ModeSwitch mode=\{mode\} onChange=\{switchMode\} \/>/.test(homeC) && /headRow: \{/.test(homeC));
ok('selection is glass, never a white pill', /chipOn: \{\s*backgroundColor: 'rgba\(79,141,255,0\.22\)'/.test(homeC) && !/chipOn: \{ backgroundColor: '#fff'/.test(homeC));

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
ok('the sheet only SEARCHES — it never adds, because adding costs credits',
  !/deductSearchCredits/.test(sheetC) && !/fetchJobMatches/.test(sheetC) && /fetchDiscoverJobs/.test(sheetC));
ok('…and hands the choice to the one audited add flow', /tab: 'search', addCompany: value/.test(homeC));
ok('the hub consumes it exactly once', /handedOver\.current = true;/.test(hubC) && /typeof explicit === 'string' \? explicit : inputValue/.test(hubC));
ok('it can take a pasted careers URL as well as a name', /looksLikeUrl/.test(sheetC) && /Use this careers page/.test(sheetC));
ok('region filters the search and suggests a design', /country: ctry \|\| ''/.test(sheetC) && /bestDesignForCountry/.test(strip(svc)));

console.log('── cover letters ──');
ok('letter mode does NOT borrow the resume carousel', /mode === 'letter' \? \(\s*<LetterPanel/.test(homeC));
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
ok('the field says what it takes', /placeholder=\{urlMode \? "https:\/\/careers\.company\.com" : "Employer name or URL"\}/.test(sheetC));
ok('a result is identifiable: name, website, location', /h\.domain/.test(sheetC) && /h\.location/.test(sheetC) && /globe-outline/.test(sheetC) && /location-outline/.test(sheetC));
ok('…and results are cards, not bare rows', /hit: \{[\s\S]{0,180}borderRadius: 14/.test(sheetC));
ok('not in the list → add their URL instead', /setUrlMode\(true\)/.test(sheetC) && /Add their careers URL instead/.test(sheetC));
ok('…offered whether or not there were hits', /hits\.length \? 'Not the right one\?' :/.test(sheetC));

// ── Round 6: the posting the user is applying to, end to end ────────────────────────────────────
const builder = strip(R('../app/(resume-builder)/index.tsx'));

console.log('── the sheet asks for the listing, and asking stays free ──');
ok('there is an optional listing disclosure', /Applying to a specific role\? Add the listing/.test(sheetC) && /optional/.test(sheetC));
ok('…taking a link OR pasted text', /placeholder="Link to the job posting"/.test(sheetC) && /paste the job description here/.test(sheetC));
ok('…and it still never searches or charges', !/deductSearchCredits/.test(sheetC) && !/fetchJobMatches/.test(sheetC));

console.log('── ⚠️ a pasted description never travels as a route param ──');
ok('it goes through storage', /AsyncStorage\.setItem\('pending_job_listing'/.test(homeC));
ok('…and the param only says there is one', /withListing: '1'/.test(homeC));
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
ok('…BELOW the hero, where the light card vocabulary belongs',
  homeC.indexOf('<DownloadHistory\n') > homeC.indexOf('</MeshStage>'));
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

console.log('── ⚠️ THE SEAM: the hero ends where its content does ──');
// "There is a lot of empty gap" was `rootH * 1.18`: on a normal phone that left ~150pt of empty
// gradient after the last thing in the hero, and then melted across another 170 before the list
// began. The stage is measured now, and the melt is what joins the two halves rather than what
// separates them.
ok('the stage is as tall as what is on it, plus the melt',
  /const stageH = heroH/.test(homeC) && !/rootH \* 1\.18/.test(homeC));
ok('…measured from ONE block, so nothing can be laid out beyond the melt',
  /onLayout=\{\(e\) => setHeroH\(/.test(homeC));
ok('…with a viewport floor, so a short hero still fills screen one', /Math\.round\(rootH \* 0\.98\)/.test(homeC));
// ⚠️ `transparent` is transparent BLACK. Interpolating from it to a light colour passes through
// dark, and that muddy grey-blue band is what made this seam read as a third surface.
ok('⚠️ the melt never passes through the `transparent` keyword',
  /colors=\{\[BG0, BG0, bg\(/.test(meshC) && !/'transparent', 'rgba\(160,178,206/.test(mesh));
ok('…it is one colour fading up from zero alpha', /const BG0 = bg\(0\)/.test(meshC));
ok('…in six eased stops, because three band visibly across 100pt', /const RAMP = \[/.test(meshC));
ok('the library overlaps the melt instead of starting under it', /library: \{ marginTop: -24 \}/.test(homeC));
ok('…and the section stops adding its own gap on top of it', /paddingTop: 14 \},/.test(histC));

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
ok('the ribbon is tapered by how fast the finger was moving',
  /function speeds\(pts\)/.test(studioC) && /3\.5-2\.1\*f/.test(studioC));
ok('⚠️ every preview is trimmed to its ink before it is fitted, or tall faces clip',
  /function bitmap\(st, text\)/.test(studioC) && /BM\[key\]=trim\(o\)/.test(studioC));
ok('the export goes through that same trim, at print scale', /var X=3;/.test(studioC));
ok('the bridge is still the proven one: base64 → a file → multipart',
  /image\/png/.test(studioC) && /EncodingType\.Base64/.test(studioC));
ok('⚠️ the old pad is deleted, not left behind to drift out of date',
  !fs.existsSync(path.join(__dirname, '../components/onboarding/SignaturePad.tsx')));

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

console.log(`\nemployer home: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
