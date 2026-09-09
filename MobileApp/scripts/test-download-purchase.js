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
const FILES = { 'DownloadPaywallSheet.tsx': sheetSrc, 'downloadPassService.ts': svcSrc };
const sheet = strip(sheetSrc), svc = strip(svcSrc), bill = strip(billSrc), gal = strip(galSrc), let_ = strip(letSrc);

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
ok('the sheet is a Modal in the calling screen, so plans mounts OVER it', /<Modal visible=\{visible\}/.test(sheet));
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
ok('⚠️ the letter download already sent companyName, and the sheet uses the SAME value',
  /companyName: ctx\.companyName/.test(let_) && /employer=\{ctx\?\.companyName \|\| null\}/.test(let_));

console.log('── a server NO always wins over the cached state ──');
for (const [what, src] of [['resume gallery', gal], ['cover letter', let_]]) {
  ok(`${what}: a 403 re-reads and re-offers, never silently fails`,
    /res\.status === 403 && \(json\.reason === 'paid_required' \|\| json\.reason === 'quota_exhausted'\)/.test(src));
}

console.log(`\ndownload purchase: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
