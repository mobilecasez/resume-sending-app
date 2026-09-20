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
const plansSrc = R('../app/(subscription)/plans.tsx');
const gcsSrc   = R('../components/employer-home/GenerateConfirmSheet.tsx');
const hookSrc  = R('../components/employer-home/useHomeBuilds.ts');
const FILES = { 'DownloadPaywallSheet.tsx': sheetSrc, 'downloadPassService.ts': svcSrc, 'builderEmployer.ts': bempSrc };
const sheet = strip(sheetSrc), svc = strip(svcSrc), bill = strip(billSrc), gal = strip(galSrc), let_ = strip(letSrc);
const env = strip(envSrc), prev = strip(prevSrc), home = strip(homeSrc);
const plans = strip(plansSrc), gcs = strip(gcsSrc), hook = strip(hookSrc);
/** One function's body whatever its declaration shape (function f, const f = …, useCallback), brace-matched; '' when absent. */
const fnBodyOf = (src, name) => {
  const m = new RegExp('(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+function|function|const)\\s+' + name + '\\b').exec(src);
  if (!m) return '';
  const i = src.indexOf('{', m.index);
  if (i < 0) return '';
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  return '';
};

console.log('── the new files parse and follow the house rules ──');
for (const [name, src] of Object.entries(FILES)) {
  let good = true;
  try { parser.parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] }); } catch (e) { good = false; console.log('     ' + name + ': ' + String(e.message).split('\n')[0]); }
  ok(name + ' parses', good);
  ok(name + ' carries the mandatory header', /^\/\/ AI Hub — new feature\. Safe to delete/.test(src));
}
// ⚠️ RETARGETED 2026-09-14: the in-app Terms (App.js legal <Text>) now SAY that a download needs a paid plan or a
// one-time download pass — required disclosure, not feature code. What this pins is that no pass CODE lives in
// App.js: no import of the pass service or paywall, no pass identifier, no pass endpoint (storeBilling is
// imported there for SUBSCRIPTIONS, which is not this feature). Prose inside <Text>
// children is removed first so the disclosure cannot trip it, and nothing else is loosened.
{
  const appCode = strip(R('../App.js')).replace(/<Text\b[^>]*>[^<]*(?:<Text\b[^>]*>[^<]*<\/Text>[^<]*)*<\/Text>/g, '<Text/>');
  ok('App.js is not touched by this feature (no pass code; the Terms may name the pass)',
    !/download.?pass/i.test(appCode) && !/DownloadPaywall|downloadPassService|\/downloads\/state/.test(appCode),
    (appCode.match(/.{0,60}download.?pass.{0,60}/i) || [])[0]);
}

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
// ⚠️ RETARGETED 2026-09-15: the recovered branch grew a WHY comment and a "paid, not visible yet" answer, so
// the 200-char window no longer reached the product fetch. The rule is unchanged: recovery runs first, and
// the very next thing on the buy path is the price read — nothing else may sit between them.
ok('⚠️ …and it runs BEFORE a new purchase is attempted, because Play refuses a second one',
  /if \(await recoverStrandedPasses\(\)\) \{[\s\S]{0,900}?\n  \}\n\n  const priced = await fetchOneTimeProducts/.test(svc), svc.match(/if \(await recoverStrandedPasses[\s\S]{0,240}/)?.[0]);
// ⚠️ A RECOVERED PASS IS A PAID PASS. When the store's receipt verified and the server granted it but our own
// read has not caught up, the branch must answer "paid" and stop — falling through opened the store sheet for
// a SECOND pass. The branch may only return; purchaseOneTime is never reached from inside it.
{
  const branch = (svc.match(/if \(await recoverStrandedPasses\(\)\) \{([\s\S]*?)\n  \}\n/) || [])[1] || '';
  ok('⚠️ …a recovered pass that is not visible yet answers { ok:false, paid:true } and NEVER falls through to a second purchase',
    /return \{ ok: false, paid: true,/.test(branch) && /won’t be charged twice|won't be charged twice/.test(branch)
    && !/purchaseOneTime|fetchOneTimeProducts/.test(branch), branch.slice(0, 300));
}
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

console.log('── ⚠️ A DOWNLOAD OF AN EMPLOYER\'S OWN VERSION BILLS THAT EMPLOYER ──');
// The 2026-09-11 round: Home saves one resume and one letter per employer, and both galleries open THAT
// document by docId. The server then renders the saved document and bills the document's employer
// whatever the body says — so the docId must travel with the download, and a vanished document must
// read as "gone", never as a paid failure or a prompt to generate again.
ok('the resume gallery sends the docId with the download', /init\.body = JSON\.stringify\(\{ template: selectedId, mode, employer, docId \}\)/.test(gal));
ok('…and treats a 410 as "this version is gone"', /if \(docId && res\.status === 410\)/.test(gal));
// ⚠️ `mode` is the picker's own state again (2026-09-20): every design can print in either layout, so nothing
// overrides it here (test-letter-gallery.js pins the sheet). What THIS assertion guards is the money: whatever the
// size turns out to be, template/employer/docId must still travel with the download, or the server renders one
// employer's saved letter and bills another's.
ok('the letter gallery sends the docId in doc mode (and exactly the classic body otherwise)',
  /body: JSON\.stringify\(docId\s*\? \{ template: selected\.id, mode, [^}]*employer: passEmployer, docId \}\s*: \{ template: selected\.id, mode, [^}]*employer: passEmployer \}\)/.test(let_));
ok('…a 410 in doc mode is "no longer saved"', /if \(docId && res\.status === 410\)/.test(let_) && /no longer saved/.test(letSrc));
ok('⚠️ a stashed picker context is trusted only when it is THIS document\'s', /if \(c && docIdOf\(c\.docId\) === did\) setCtx\(c\);/.test(let_));
ok('…and once the document loads, the billed employer IS the document\'s', /employer: d\.employer \|\| undefined, docId: did/.test(let_));
ok('the saved letter\'s pages come from its own cards endpoint — the FULL page, since the pager zooms', /fetchDocCards\('cover_letter', did, batch, \{ size: 'page' \}\)/.test(let_));
ok('Home hands the letter picker the saved letter with its docId, and stops if the write fails',
  /AsyncStorage\.setItem\('coverLetterPickerContext', JSON\.stringify\(\{[\s\S]{0,300}docId: full\.docId,/.test(home)
  && /params: \{ \.\.\.\(templateId \? \{ template: templateId \} : \{\}\), docId: String\(full\.docId\) \}/.test(home));

console.log('── ⚠️ CONTRACT C1 (2026-09-15): "NOT GRANTED YET" IS NOT "NOT PAID" — nobody is sold the same pass twice ──');
// buyDownloadPass answered ok:false with a note whenever the store had CHARGED but the server had not shown the pass
// yet; every caller re-enabled its Buy button on ok:false, and a second tap bought a second pass for the same need.
// Now every failure after the store said yes carries paid:true, a deferred one pending:true, and no screen offers a
// purchase on either — the sheet's button becomes "Use my one-time pass", Plans swaps its button for a settling card.
{
  ok('the result type carries paid and pending beside cancelled',
    /\{ ok: false; cancelled\?: boolean; pending\?: boolean; paid\?: boolean; message\?: string \}/.test(svc));
  const fn = fnBodyOf(svc, 'buyDownloadPass');
  const afterStore = fn.slice(fn.indexOf('try {', fn.indexOf("if (outcome.status === 'failed')")));
  const failsAfterStore = afterStore.match(/return \{ ok: false[^}]*\}/g) || [];
  ok('⚠️ EVERY failure after the store said yes carries paid: true — the catch included',
    afterStore.length > 100 && failsAfterStore.length >= 3 && failsAfterStore.every((r) => /paid: true/.test(r))
    && /catch \{[\s\S]{0,400}return \{ ok: false, paid: true/.test(afterStore), failsAfterStore);
  ok('⚠️ a deferred / Ask-to-Buy purchase is pending: true and never paid: true (nothing is charged until it clears)',
    /if \(outcome\.status === 'pending'\) \{\s*return \{ ok: false, pending: true, message/.test(fn) && !/pending: true, paid: true|paid: true, pending: true/.test(fn));
  ok('…a cancelled sheet is neither', /if \(outcome\.status === 'cancelled'\) return \{ ok: false, cancelled: true \};/.test(fn));
  {
    // The refusal block itself, up to its own closing brace: it must answer paid and must NOT finish the purchase.
    const vb = fn.slice(fn.indexOf('if (!verified.ok) {'));
    const blk = vb.slice(0, vb.indexOf('}') + 1);
    ok('…and "verified but could not confirm" (Android) is paid, with the purchase NOT finished (it can still be honoured)',
      blk.length > 20 && /return \{ ok: false, paid: true/.test(blk) && !/finishOneTime/.test(blk) && /\}\s*await finishOneTime\(outcome\.purchase\);/.test(vb), blk);
  }

  // Home's sheet: paid / pending set `bought` exactly like ok does, and the button becomes "Use my one-time pass".
  const buy = fnBodyOf(hook, 'sheetBuyOnce');
  ok('⚠️ the sheet treats paid and pending as BOUGHT (never a second Buy), and says which',
    /if \(r\.ok \|\| r\.paid \|\| r\.pending\) \{\s*bought = true;/.test(buy)
    && /payment = r\.ok \? null : r\.pending \? 'approval' : 'applying';/.test(buy)
    && /bought: true, payment, pass: \{ available: true, forThisEmployer: false \}/.test(buy), buy.slice(0, 200));
  ok('⚠️ …only a sheet that has NOT bought opens the store; a bought one only re-reads the gate',
    /if \(!bought\) \{[\s\S]*?buyDownloadPass\(a0\.job\.company\)/.test(buy) && (hook.match(/buyDownloadPass\(/g) || []).length === 1);
  ok('the empty sheet\'s button reads "Use my one-time pass" once a pass is available, "Generate once — price" only before',
    /const owned = empty && !!\(pass && pass\.available\);/.test(gcs)
    && /label=\{owned \? 'Use my one-time pass' : `Generate once — \$\{priceLabel\}`\}/.test(gcs)
    && /a11yHint=\{owned[\s\S]{0,300}Nothing new is bought/.test(gcs) && /\{!owned && \(/.test(gcs));
  ok('…and its copy never says "went through" for a purchase that is only waiting for approval',
    /approval: 'Your payment is waiting to be approved, so nothing has been charged yet\./.test(hook)
    && /applying: 'Your payment went through/.test(hook) && !/approval: '[^']*went through/.test(hook));

  // Plans: the same rule, one screen over.
  ok('⚠️ Plans reads paid off the result, and never treats cancelled as paid',
    /function passResultPaid\(/.test(plans) && /if \(r\.cancelled\) return false;\s*if \(r\.paid === true\) return true;/.test(plans));
  const buyPass = fnBodyOf(plans, 'buyPass');
  ok('⚠️ …paid or pending locks the Buy button behind a settling card, at MODULE scope (leaving and coming back must not resurrect it)',
    /if \(paid \|\| r\.pending\) \{\s*setPassSettling\(\{ kind: paid \? 'paid' : 'pending', baseline \}\);\s*return;/.test(buyPass)
    && /if \(passBusy \|\| busyKey \|\| restoring \|\| passSettlingMemo\) return;/.test(buyPass)
    && /^let passSettlingMemo: PassSettling \| null = null;/m.test(plans), buyPass.slice(0, 160));
  const recheck = fnBodyOf(plans, 'recheckPass');
  ok('…the settling card\'s Refresh only RE-READS the server — no purchase can start from it, and the card replaces the Buy button',
    /fetchDownloadState\(\)/.test(recheck) && !/buyDownloadPass|purchaseOneTime/.test(recheck)
    && /\{passSettling \? \([\s\S]*?onPress=\{recheckPass\}[\s\S]*?\) : passBuyable \? \(/.test(plans)
    && (plans.match(/buyDownloadPass\(/g) || []).length === 1);
  ok('…and it clears only once the unused-pass count rises ABOVE the pre-purchase baseline (an older unused pass proves nothing)',
    /if \(memo && fresh\.passes > memo\.baseline\) setPassSettling\(null\);/.test(recheck) && /const baseline = dl\?\.passes \|\| 0;/.test(buyPass));
}

console.log('── ⚠️ EVERY READ IS BOUNDED (2026-09-15): a stalled network never locks the sheet that is waiting for a pass ──');
{
  const readMs = Number((svc.match(/const STATE_READ_MS = (\d+);/) || [])[1]);
  const waitMs = Number((svc.match(/const WAIT_FOR_PASS_MS = (\d+);/) || [])[1]);
  ok('fetchDownloadState aborts its fetch at STATE_READ_MS, and clears the timer either way',
    readMs > 0 && /const ctl = new AbortController\(\);\s*const timer = setTimeout\(\(\) => ctl\.abort\(\), STATE_READ_MS\);/.test(svc)
    && /fetch\(`\$\{API_BASE\}\/downloads\/state\$\{q\}`, \{ headers, signal: ctl\.signal \}\)/.test(svc) && /finally \{ clearTimeout\(timer\); \}/.test(svc), { readMs });
  const wait = fnBodyOf(svc, 'waitForPass');
  ok('⚠️ waitForPass bounds the WHOLE poll (Date.now() < until), not only each read',
    /const until = Date\.now\(\) \+ WAIT_FOR_PASS_MS;/.test(wait) && /for \(let i = 0; i < 8 && Date\.now\(\) < until; i\+\+\)/.test(wait));
  // The poll's own sleeps (3 × 700 + 5 × 1500): a healthy network must always finish its reads inside the bound.
  const sleeps = 3 * 700 + 5 * 1500;
  ok('…that bound is longer than the poll\'s sleeps and under a minute, and one read is shorter than the poll (it bounds the WAIT, never the purchase)',
    waitMs > sleeps && waitMs <= 60000 && readMs < waitMs, { waitMs, sleeps, readMs });
  ok('…past it the answer is paid:true, which every caller already handles — never a second sale', /if \(!state\) \{\s*return \{ ok: false, paid: true/.test(svc));
  ok('the state read names the store environment on the request itself (x-store-env; the Sandbox probe always wins)',
    /\.\.\.\(await storeEnvHeader\(\)\)/.test(svc) && /if \(forceEnv\) headers\['x-store-env'\] = forceEnv;/.test(svc));
}

console.log(`\ndownload purchase: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
