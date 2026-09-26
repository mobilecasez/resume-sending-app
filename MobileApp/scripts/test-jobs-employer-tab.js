// The Jobs page's two new pieces (2026-09-26, both the owner's asks):
//   node MobileApp/scripts/test-jobs-employer-tab.js
//
// 1. "Find job" is TWO TABS: the Google search it always had, and a new one that starts from the
//    EMPLOYER — the same free lookup Home's Add-employer sheet uses — and then offers the pages where
//    that employer actually lists its jobs. Both tabs end the same way: a URL opened in the same
//    in-app browser, where "Fetch job" works exactly as before.
// 2. Saving a job now says WHERE it went: "View saved job" takes the user to the Saved tab, scrolled
//    to that job, lit for a moment.
//
// Checked on COMMENT-STRIPPED source (matching our own explanation proves nothing). The rules that
// matter here are the ones that would cost the user something if they broke:
//   • the employer tab must stay FREE — it may not track, research or build anything;
//   • the saved toast may only appear where the server actually stored the job;
//   • the highlight must not mix Animated drivers (that crash cost builds 126-128).
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const R = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 300) : '')); } };

const LAUNCHER = strip(R('MobileApp/components/JobSearchLauncher.tsx'));
const TAB = strip(R('MobileApp/components/jobs/EmployerJobsTab.tsx'));
const BROWSE = strip(R('MobileApp/components/BrowseFetch.tsx'));
const GJB = strip(R('MobileApp/components/GoogleJobBrowser.tsx'));
const DISCOVER = strip(R('MobileApp/app/(discover)/index.tsx'));
const SAVED = strip(R('MobileApp/components/SavedJobsList.tsx'));

console.log('── 1. One sheet, two ways in ──');
ok('the sheet has a tab for each', /\[\['search', 'Search jobs', 'search'\], \['employer', 'By employer', 'business-outline'\]\]/.test(LAUNCHER));
ok('it opens on the search tab (nothing moves for someone who always searched)', /useState<'search' \| 'employer'>\('search'\)/.test(LAUNCHER));
ok('the employer tab is the new component', /\{tab === 'employer' \? \(\s*<EmployerJobsTab/.test(LAUNCHER));
ok('⚠️ picking a page leaves through the SAME exit as a typed search', /onLaunch\(\{ query: '', role: '', location: '', url: u, mode: 'url' \}\)/.test(LAUNCHER));
ok('…and the sheet closes first', /setOpen\(false\);\s*onLaunch\(\{ query: '', role: '', location: '', url: u, mode: 'url' \}\)/.test(LAUNCHER));
ok('switching tabs puts the keyboard away', /onPress=\{\(\) => \{ Keyboard\.dismiss\(\); setFocus\(null\); setTab\(k\); \}\}/.test(LAUNCHER));
ok('the search tab still renders its own body', /\{prefilled && \(/.test(LAUNCHER) && /Role you're looking for/.test(LAUNCHER));

console.log('── 2. The employer tab is free, and honest about what it knows ──');
ok('it asks the employer lookup', /\/discover\/employers\?q=/.test(TAB));
ok('…and the pages endpoint', /\/discover\/employer-pages\?site=/.test(TAB));
ok('⚠️ it tracks, researches and builds NOTHING', !/(employers\/track|employer-build|generate-ai|deductSearch|fetchJobMatches|company_search)/.test(TAB), TAB.match(/\/(ai-hub|cover-letter|resume-builder)\/[a-z-]+/g));
ok('⚠️ it opens only real http(s) links (a page list is server data, not a command)', /\/\^https\?:\\\/\\\/\/i\.test\(p\.url\)/.test(TAB));
ok('one letter does not search (that matches half the world)', /if \(term\.length < 2\)/.test(TAB));
ok('typing is debounced', /setTimeout\(async \(\) => \{[\s\S]*?\}, 350\)/.test(TAB));
ok('an in-flight lookup is abandoned when the text changes', /searchCtl\.current\?\.abort\(\)/.test(TAB) && /new AbortController\(\)/.test(TAB));
ok('nothing is set after the component is gone', /alive\.current = false/.test(TAB) && /if \(!alive\.current \|\| ctl\.signal\.aborted\) return;/.test(TAB));
ok('⚠️ an empty result says "we did not find it", never "they have no website"',
    /No employer found by that name/.test(TAB) && !/no website/i.test(TAB));
ok('a lookup that could not run says THAT', /The employer lookup is unavailable right now/.test(TAB));
ok('a site we could not read is not reported as "no jobs"', /We could not read their website just now/.test(TAB));
ok('when no page is found the employer\'s own website is still offered', /Open \{hostOf\(picked\.website\)\}/.test(TAB));
ok('a typed website works without the lookup', /q\.trim\(\)\.includes\('\.'\) && !q\.trim\(\)\.includes\(' '\)/.test(TAB));
ok('the openings page is the one that stands out', /openings: \{ name: 'list-outline'/.test(TAB) && /Current openings/.test(TAB));
ok('it is a new file under MobileApp and says so on line 1',
    R('MobileApp/components/jobs/EmployerJobsTab.tsx').startsWith('// AI Hub — new feature. Safe to delete without affecting existing app.'));
ok('styles are StyleSheet.create and icons are Ionicons only',
    /StyleSheet\.create\(/.test(TAB) && /@expo\/vector-icons/.test(TAB) && !/react-native-vector-icons|MaterialIcons|FontAwesome/.test(TAB));

console.log('── 3. Saved, and the way to it ──');
const success = (BROWSE.match(/if \(job\) \{[\s\S]*?\} else \{/) || [''])[0];
ok('⚠️ the toast is set ONLY where the server stored the job', /setSavedToast\(\{ url: srcUrl/.test(success), success.slice(0, 200));
ok('…and nowhere else in the file', (BROWSE.match(/setSavedToast\(\{/g) || []).length === 1);
ok('it names the job, not just "saved"', /savedToast\.title/.test(BROWSE) && /Job saved/.test(BROWSE));
ok('"View saved job" is there when the screen can show it', /onViewSaved\(u\)/.test(BROWSE) && /View saved job/.test(BROWSE));
ok('…and absent when it cannot (no dead button)', /\{!!onViewSaved && \(/.test(BROWSE));
ok('the toast can be dismissed and clears its own timer', /if \(savedToastTimer\.current\) clearTimeout\(savedToastTimer\.current\); setSavedToast\(null\);/.test(BROWSE));
ok('⚠️ the browser closes BEFORE the page underneath is asked to move',
    /onViewSaved=\{onViewSaved \? \(savedUrl\) => \{ onClose\(\); setTimeout\(\(\) => onViewSaved\(savedUrl\), 320\); \} : undefined\}/.test(GJB));
ok('the Jobs page switches to Saved and passes the job', /setTab\('saved'\); setFocusSaved\(savedUrl\)/.test(DISCOVER));
ok('…and the saved count is refreshed on the way', /onSavedChange\?\.\(\); setTab\('saved'\)/.test(DISCOVER));
ok('the list is told which job, and clears it afterwards',
    /focusUrl=\{focusSaved\} onFocused=\{\(\) => setFocusSaved\(null\)\}/.test(DISCOVER));

console.log('── 4. The list finds it, shows it, and lets go ──');
ok('it scrolls to the job', /listRef\.current\?\.scrollToIndex\(\{ index: idx, viewPosition: 0\.15, animated: true \}\)/.test(SAVED));
ok('…after the frame that rendered the rows', /requestAnimationFrame\(\(\) => \{/.test(SAVED));
ok('…and retries when the row was not measured yet', /onScrollToIndexFailed=\{\(info\) => \{/.test(SAVED));
ok('⚠️ a job not in the list yet reloads ONCE, then gives up quietly',
    /if \(run\.reloaded\) \{ run\.done = true; onFocused\?\.\(\); return; \}\s*run\.reloaded = true;\s*load\(\);/.test(SAVED));
ok('the highlight ends by itself and tells the page', /setTimeout\(\(\) => \{ setHighlight\(null\); onFocused\?\.\(\); \}, 2600\)/.test(SAVED));
ok('only the job that was saved is lit', /highlight=\{!!highlight && item\.job_url === highlight\}/.test(SAVED));
ok('⚠️ the ring never eats the tap it points at', /pointerEvents="none"/.test(SAVED) && /focusRing/.test(SAVED));
const card = (SAVED.match(/function SavedCard[\s\S]*?\n}\n/) || [''])[0];
ok('⚠️ every animation in the card is on ONE driver (the 126-128 crash rule)',
    /useNativeDriver: false/.test(card) && !/useNativeDriver: true/.test(card),
    (card.match(/useNativeDriver: \w+/g) || []));
ok('the pulse is bounded and stops if the card goes away', /return \(\) => seq\.stop\(\);/.test(card));
ok('a re-render while lit does not restart it forever', /\[highlight, glow\]/.test(card));

console.log(`\njobs employer tab: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
