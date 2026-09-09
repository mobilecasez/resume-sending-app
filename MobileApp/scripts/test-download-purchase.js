// The download paywall on the client — contract tests over the two screens that can charge money
// and the service that talks to the store.
//   node MobileApp/scripts/test-download-purchase.js
//
// Assertions run against COMMENT-STRIPPED source wherever the thing being tested is also named in a
// comment: matching your own explanation proves nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const R = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 200) : '')); } };
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const sheetSrc = R('../components/downloads/DownloadPaywallSheet.tsx');
const svcSrc   = R('../services/downloadPassService.ts');
const billSrc  = R('../services/storeBilling.ts');
const galSrc   = R('../app/(resume-builder)/templates.tsx');
const letSrc   = R('../app/(cover-letter)/templates.tsx');
const envSrc   = R('../services/storeEnv.ts');
const prevSrc  = R('../app/(resume-builder)/preview.tsx');
const homeSrc  = R('../components/employer-home/EmployerHome.tsx');
const bempSrc  = R('../services/builderEmployer.ts');
const FILES = { 'DownloadPaywallSheet.tsx': sheetSrc, 'downloadPassService.ts': svcSrc, 'builderEmployer.ts': bempSrc };
const sheet = strip(sheetSrc), svc = strip(svcSrc), bill = strip(billSrc), gal = strip(galSrc), let_ = strip(letSrc);
const env = strip(envSrc), prev = strip(prevSrc), home = strip(homeSrc);

console.log('── the new files parse and follow the house rules ──');
for (const [name, src] of Object.entries(FILES)) {
  let good = true;
  try { parser.parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] }); } catch (e) { good = false; console.log('     ' + name + ': ' + String(e.message).split('\n')[0]); }
  ok(name + ' parses', good);
  ok(name + ' carries the mandatory header', /^\/\/ AI Hub — new feature\. Safe to delete/.test(src));
}
ok('App.js is not touched by this feature', !/download.?pass/i.test(R('../App.js')));

console.log('── ⚠️ the client never grants anything to itself ──');
ok('the state comes from the SERVER', /\/downloads\/state/.test(svc));
ok('…and an unreadable state is LOCKED, not open', /return LOCKED/.test(svc) && /const LOCKED[\s\S]{0,200}unlimited: false/.test(svc));
ok('a purchase is confirmed by re-reading the server, not by the store callback',
  /async function waitForPass/.test(svc) && /fetchDownloadState/.test(svc));

console.log('── ⚠️ prices are the STORE’s, so India sees ₹99 and not "$1" ──');
ok('the sheet renders displayPrice', /displayPrice/.test(bill) && /price \|\| /.test(sheet));
ok('…and never hardcodes a currency', !/\$0?\.?99/.test(sheet) && !/₹99/.test(sheet));
ok('a sku the store did not price is NOT purchasable', /if \(!item \|\| !item\.id \|\| !want\.has\(item\.id\) \|\| !item\.displayPrice\) continue;/.test(bill));

console.log('── ⚠️ consumables differ from subscriptions in ways that cost money ──');
ok('bought as in-app, not subs', /type: 'in-app'/.test(bill));
ok('⚠️ finished with isConsumable TRUE — on Android that is the CONSUME that allows a second purchase',
  /finishTransaction\(\{ purchase, isConsumable: true \}\)/.test(bill));
ok('⚠️ iOS does NOT register a second listener (App.js owns that transaction)',
  /if \(Platform\.OS === 'ios'\)[\s\S]{0,400}settledElsewhere: true/.test(bill));
ok('⚠️ Android verifies BEFORE finishing', /verifyGooglePass\(purchaseToken\)[\s\S]{0,400}finishOneTime/.test(svc));
ok('⚠️ …and does NOT finish when verification fails, so the purchase can still be honoured',
  /if \(!verified\.ok\) \{[\s\S]{0,300}return \{ ok: false/.test(svc));
ok('a PENDING payment grants nothing', /status === 'pending'/.test(svc) && /pending: true/.test(svc));

console.log('── the one-off stays reachable from the plans screen ──');
// ⚠️ THIS ASSERTION USED TO SAY THE OPPOSITE, AND IT WAS WRONG. A react-native Modal is a
// separate NATIVE WINDOW above the whole navigator, not a view inside the screen — so pushing
// the plans route does not cover it, and the sheet sat on top of the plans page the user had
// just asked to see. Staying MOUNTED (state kept) and staying VISIBLE are different things.
ok('⚠️ the sheet HIDES itself while another screen is up', /<Modal visible=\{visible && screenFocused\}/.test(sheet));
ok('…driven by real navigation focus, not a guess', /useIsFocused\(\)/.test(sheet));
ok('…while KEEPING its own visible state, so backing out returns to it', /visible: boolean;/.test(sheet) && !/setPayOpen/.test(sheet));
ok('…and it re-checks on focus, which is how coming BACK is noticed', /useFocusEffect/.test(sheet));
ok('…closing only when the user actually can download now', /onUnlocked\(\)/.test(sheet));
ok('the plan option opens the real plans screen', /onSeePlans/.test(sheet) && /\(subscription\)\/plans/.test(gal) && /\(subscription\)\/plans/.test(let_));

console.log('── both screens use it, and both name the employer ──');
for (const [what, src] of [['resume gallery', gal], ['cover letter', let_]]) {
  ok(`${what}: the alert dead end is gone`, !/View paid plans', onPress/.test(src));
  ok(`${what}: opens the sheet instead`, /setPayOpen\(true\)/.test(src));
  ok(`${what}: the button shows a count or a lock`, /dlLabel\.locked/.test(src) && /dlBadge/.test(src));
  ok(`${what}: resumes the download the user was already trying`, /pendingFmt/.test(src));
  ok(`${what}: re-reads state after a download, so the count is not stale`, /refreshDownloadState\(\)/.test(src));
}
ok('⚠️ the resume download sends the EMPLOYER, or the pass binds to nothing',
  /body: JSON\.stringify\(\{ template: selectedId, mode, employer \}\)/.test(gal));
ok('⚠️ the letter screen prefers the SHARED employer identity over the AI\u2019s reading',
  /const passEmployer = ctx\?\.employer \|\| ctx\?\.companyName \|\| null;/.test(let_)
  && /employer=\{passEmployer\}/.test(let_));
ok('…and sends both spellings so the server can pick the one already paid for',
  /companyName: ctx\.companyName, companyAddress: ctx\.companyAddress, employer: passEmployer/.test(let_));

console.log('── ⚠️ MONEY WE TOOK AND NEVER HONOURED MUST HEAL ITSELF ──');
// iOS replays unfinished transactions every launch (App.js's drainUnfinishedApplePurchases).
// Android had NO such path: a 503 during verification left the purchase unconsumed and unhonoured,
// and because Play then reports the sku as owned, the next Buy came back ITEM_ALREADY_OWNED — the
// user could not even pay again until Google auto-refunded on day three.
ok('there IS an Android recovery path', /export async function recoverStrandedPasses/.test(svc));
ok('…that only runs where the gap was', /Platform\.OS !== 'android'/.test(svc));
ok('⚠️ …and it runs BEFORE a new purchase is attempted, because Play refuses a second one',
  /if \(await recoverStrandedPasses\(\)\)[\s\S]{0,200}\n  const priced = await fetchOneTimeProducts/.test(svc), svc.match(/if \(await recoverStrandedPasses[\s\S]{0,240}/)?.[0]);
ok('…verifying with the server before consuming, never the other way round',
  /verifyGooglePass\(tok\)\)\.ok\) \{[\s\S]{0,120}finishOneTime\(p\)/.test(svc));
ok('…and the sheet heals on open too, so a stranded purchase needs no second Buy tap',
  /recoverStrandedPasses\(\)\.catch/.test(sheet));

console.log('── ⚠️ A SANDBOX PASS MUST NOT BE INVISIBLE TO THE BUILD THAT BOUGHT IT ──');
// x-store-env was an axios DEFAULT only, and every pass endpoint is written with fetch — so on
// TestFlight the pass was written in Sandbox and every read, defaulting to Production, saw nothing.
ok('the header reaches fetch, not only axios', /__cvaFetchStoreEnvPatched/.test(env));
ok('⚠️ …for our own API origin only', /url\.startsWith\(API_BASE\)/.test(env));
ok('⚠️ …and Production still sends nothing at all', /if \(cached === 'Sandbox'\)/.test(env));
ok('Android adopts the environment the server reported', /rememberStoreEnv\(j\.environment\)/.test(svc));
ok('⚠️ iOS adopts it only when a pass demonstrably exists there',
  /fetchDownloadState\(employer, 'Sandbox'\)[\s\S]{0,160}rememberStoreEnv\('Sandbox'\)/.test(svc));

console.log('── ⚠️ THE PADLOCK FOLLOWS WHAT THEY PAID FOR ──');
// isPaid comes from the subscription status alone, so a pass buyer who had just downloaded a file
// was still shown 🔒 "Paid plans" on the button they had already paid for.
ok('the resume gallery badges on the pass, not the subscription',
  /\{dlLabel\.locked && <View style=\{s\.credBadge\}/.test(gal) && !/\{!isPaid && <View style=\{s\.credBadge\}/.test(gal));
ok('…and the letter footer says "Included" for a pass owner too', /!dlLabel\.locked/.test(let_));

console.log('── ⚠️ A DOWNLOAD WITH NO COMPANY IS A PAYMENT WITH NOTHING TO ATTACH TO ──');
ok('the editor carries the employer into the gallery, as Home already does',
  /pathname: '\/\(resume-builder\)\/templates',[\s\S]{0,120}builderEmployer \? \{ employer: builderEmployer \} : \{\}/.test(prev));
ok('…taking it from where Home stored it', /readBuilderEmployer\(\)/.test(prev) && /rememberBuilderEmployer/.test(home));

console.log('── a server NO always wins over the cached state ──');
for (const [what, src] of [['resume gallery', gal], ['cover letter', let_]]) {
  ok(`${what}: a 403 re-reads and re-offers, never silently fails`,
    /res\.status === 403 && \(json\.reason === 'paid_required' \|\| json\.reason === 'quota_exhausted'\)/.test(src));
}

console.log(`\ndownload purchase: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
