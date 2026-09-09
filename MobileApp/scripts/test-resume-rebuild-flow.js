// Resume rebuild overhaul — contract tests over server controller + app screens (source-level,
// same style as test-auth-return.js). Guards the product rules:
//   previews free for everyone · downloads paid-only · free plan = 1 regeneration ·
//   lazy batched previews (the 37-design gallery must never re-create the all-at-once break).
//   node MobileApp/scripts/test-resume-rebuild-flow.js
'use strict';
const fs = require('fs');
const path = require('path');
const R = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n); } };

const ctl = R('../../server/controllers/resumeBuilderController.js');
const routes = R('../../server/routes/resumeBuilder.js');
const renderer = R('../../server/utils/resumeRenderer.js');
const prev = R('../app/(resume-builder)/preview.tsx');
const tpl = R('../app/(resume-builder)/templates.tsx');
const idx = R('../app/(resume-builder)/index.tsx');
const home = R('../components/HomeScreen.js');
const card = R('../components/ResumeRebuildCard.tsx');

console.log('── server: downloads are paid, previews are not ──');
// The gate moved into services/downloads: a plan OR a single-employer pass now satisfies it, and
// the decision lives in ONE place instead of five copy-pasted subscription checks.
ok('generatePDF gates through the download service',
  /downloads\.canDownload\(userId, \{ employer \}, req\)[\s\S]{0,300}paid_required/.test(ctl));
ok('⚠️ …and charges only AFTER the file exists, never at the gate',
  ctl.indexOf('downloads.claimDownload') > ctl.indexOf('downloads.canDownload'));
ok('generateDocx gates the same way', /generateDocx[\s\S]{0,600}paid_required/.test(ctl));
ok('the PDF path no longer deducts credits', !/deductCredits\(userId, DOWNLOAD_CREDIT_COST/.test(ctl));
ok('previewTemplates has NO plan/credit gate', !/previewTemplates[\s\S]{0,900}(activeSubscription|checkUserCredits)/.test(ctl.slice(ctl.indexOf('async function previewTemplates'))));

console.log('── server: free plan = one regeneration, in its own lane ──');
ok('regenerate checks regen_count for free users', /isRegenerate && !sub[\s\S]{0,400}regen_count/.test(ctl));
ok('the used-up case is a 403 with reason regen_limit', /regen_limit/.test(ctl));
ok('the one free regen BYPASSES the quota gate',
  /const quota = freeRegen \? \{ allowed: true \} : await entitlements\.canConsumeMany/.test(ctl)
  && /const gate = \(freeRegen \|\| viaPass\) \? \{ allowed: true \} : quota;/.test(ctl));
ok('⚠️ …and so does a single-employer pass, which includes one AI resume',
  /passCoversGeneration\(userId, 'resume', passEmployer, req, \{ boundOnly: quota\.allowed \}\)/.test(ctl));
// ⚠️ ORDER, NOT JUST PRESENCE. Asking the pass first burned the one-off someone had bought while
// their plan or free allowance could have paid — destroying it and handing back nothing.
ok('⚠️ …but the PLAN is asked first, so an unspent one-off is not burned ahead of quota',
  ctl.indexOf('canConsumeMany(userId, \'resume\', 1, req)') < ctl.indexOf('passCoversGeneration(userId, \'resume\''));
ok('…and is not double-counted on success',
  /if \(!spentPass && !freeRegen\) await entitlements\.consumeOnSuccess/.test(ctl));
ok('⚠️ …and a pass is spent BEFORE the plan, never both',
  ctl.indexOf("claimGeneration(userId, 'resume'") < ctl.indexOf('if (!spentPass && !freeRegen)'));
ok('a fresh build resets the allowance', /regen_count = 0 WHERE user_id/.test(ctl));
ok('a regenerate spends it', /regen_count = regen_count \+ 1/.test(ctl));
ok('getResume reports regen state + plan', /regen: \{ used:[\s\S]{0,120}isPaid: !!sub/.test(ctl));
ok('the regen column is created idempotently', /ADD COLUMN IF NOT EXISTS regen_count/.test(ctl));

console.log('── server: the 37-design catalogue renders LAZILY ──');
ok('a /templates catalogue route exists', /router\.get ?\('\/templates'/.test(routes));
ok('listTemplates serves families + regions, no rendering', /listTemplates[\s\S]{0,300}families: FAMILIES, regions: REGIONS/.test(ctl));
ok('previewTemplates accepts an ids batch', /Array\.isArray\(ids\)/.test(ctl));
ok('the batch is capped (all-at-once is the OLD break)', /\.slice\(0, 6\)/.test(ctl));
ok('unknown ids are dropped, not 500s', /\.filter\(Boolean\)/.test(ctl.slice(ctl.indexOf('async function previewTemplates'))));
ok('legacy {region} mode still works for older app builds', /templatesForRegion\(region\);\s*\/\/ legacy/.test(ctl));
ok('the a4 band comes from the template entry (variants recolor it)', /tpl && tpl\.band/.test(renderer));

console.log('── app: the preview screen no longer breaks ──');
ok('a server miss falls back to the AsyncStorage copy', /if \(!gotServerCopy\) \{[\s\S]{0,200}resumeBuilderData/.test(prev));
ok('getInitials cannot crash on a missing name', /const safe = String\(name \|\| ''\)\.trim\(\);/.test(prev));
ok('ContentText only enters HTML mode on real rich-text tags', /<\\\/\?\(h\[1-6\]\|p\|div\|li\|ul\|ol\|br\|strong\|b\|em\|i\|u\|span\)/.test(prev));
ok('the old strip-everything tail is gone', !/\.replace\(\/<\[\^>\]\+>\/g, ''\);/.test(prev.slice(prev.indexOf('function ContentText'))));

console.log('── app: preview action bar ──');
// ⚠️ It now carries the EMPLOYER. Without it the download reached the server with employer:null,
// which a pass can only be charged into the "(none)" scope for — a payment attached to nothing.
ok('Download/Preview routes to the gallery, naming the company it is for',
  /pathname: '\/\(resume-builder\)\/templates',[\s\S]{0,140}employer: builderEmployer/.test(prev));
ok('Regenerate knows the free allowance before navigating', /regen\.used >= regen\.freeLimit/.test(prev));
ok('…and offers the plans screen', /Regeneration used[\s\S]{0,300}\/\(subscription\)\/plans/.test(prev));

console.log('── app: gallery ──');
ok('the catalogue is fetched from the server (no hardcoded template list)', /resume-builder\/templates`/.test(tpl));
ok('previews load lazily in batches of ≤3', /need\.slice\(i, i \+ 3\)/.test(tpl));
ok('in-flight requests are deduped', /inFlight\.current\.has\(id\)/.test(tpl));
ok('neighbours are prefetched on swipe', /prefetchAround\(idx/.test(tpl));
ok('swatch taps fetch just that variant', /pickVariant[\s\S]{0,200}ensurePreviews\(\[tplId\]\)/.test(tpl));
ok('free users are offered BOTH ways to pay, not just plans',
  /function upsellDownload\(\) \{ setPayOpen\(true\); \}/.test(tpl) && /DownloadPaywallSheet/.test(tpl));
ok('the server 403 wins over cached paid state', /paid_required[\s\S]{0,80}setIsPaid\(false\)/.test(tpl));
ok('previews are stated free in the UI', /every preview is free|previews of all designs free|Previews are free/.test(tpl));
ok('no credit badges remain in the gallery', !/DOWNLOAD_CREDITS/.test(tpl));

console.log('── app: one-tap auto flows ──');
ok('an autoBuild entry generates without the form', /e\.autoBuild[\s\S]{0,2000}autoGenerate\(/.test(idx));
ok('a missing uploaded resume walks the user to the upload', /onboarding_focus_target[\s\S]{0,40}'resume'/.test(idx) || /'onboarding_focus_target', 'resume'/.test(idx));
// (the one-tap auto-regenerate was reverted on user feedback — the form must show, prefilled)
ok('the regen flag rides on BOTH generate paths', (idx.match(/isRegenerate: (wasRegen|regenPendingRef\.current)/g) || []).length === 2);
ok('regen_limit is handled with a plans route', /regen_limit[\s\S]{0,300}\/\(subscription\)\/plans/.test(idx));

console.log('── home card ──');
ok('HomeScreen mounts the card (2-line diff only)', home.includes("import ResumeRebuildCard from './ResumeRebuildCard'") && home.includes('<ResumeRebuildCard />'));
ok('the card renders NOTHING without a score or built resume (no banner wall)', /if \(!hasScore && !hasBuilt\) return null;/.test(card));
ok('it keeps the score even when the popup would not prompt', /shouldPrompt gates interruptions, not information/.test(card));
ok('the CTA claims the free pass BEFORE navigating (the popup lesson)', /claimEnhancePass\(score\.id\)[\s\S]{0,400}resume_builder_entry/.test(card));
ok('it enters the builder auto lane', /autoBuild: true/.test(card));
ok('animations obey the b126 rule', !/useNativeDriver:\s*true/.test(card));
ok('low scores use amber, never red', /#F59E0B/.test(card) && !/#EF4444/.test(card));

console.log('── preview speed: the cold start is paid once, not per request ──');
// "Azure Sidebar takes forever" was the first render paying chromium launch + a live Google
// Fonts download on EVERY request (fresh browser = empty cache). These pins keep that fixed.
const rend = R('../../server/utils/resumeRenderer.js');
ok('a warm browser is shared across preview requests', /getWarmBrowser/.test(rend) && /armWarmIdle/.test(rend));
ok('…and renderPreviews no longer closes it', !/renderAll[\s\S]{0,2400}browser\.close/.test(rend.slice(rend.indexOf('async function renderPreviews'))));
ok('it self-heals with a per-template retry on a dead handle', /one clean retry, fresh browser, this template only/.test(rend));
// --single-process chromium crashes after ~4-5 consecutive renders in one session (reproduced
// with a 6-template loop) — the warm browser must recycle itself before that threshold.
ok('the warm browser recycles every few pages, below the crash threshold',
  /WARM_PAGE_LIMIT = 3/.test(rend) && /warmPages < WARM_PAGE_LIMIT/.test(rend));
ok('a composited frame is forced between resize and screenshot', /requestAnimationFrame\(\(\) => requestAnimationFrame/.test(rend));
ok('the idle timer never keeps the process alive', /warmTimer\.unref/.test(rend));
ok('Google Fonts are served from an in-memory cache', /fontCache/.test(rend) && /route\(/.test(rend));
ok('font interception applies to EVERY prepared page (previews and PDFs)', /await routeFonts\(page\)/.test(rend));
ok('a font-network failure degrades to system fonts, never hangs', /route\.abort/.test(rend));
ok('warmPreviews exists and never throws at the caller', /warmPreviews[\s\S]{0,1400}purely a head start/.test(rend));
ok('the catalogue request pre-warms the pipeline', /listTemplates[\s\S]{0,400}warmPreviews\(\)/.test(ctl));
ok('sharp photo crops are cached against the file mtime', /photoCache/.test(ctl) && /mtimeMs/.test(ctl));
ok('the gallery renders the VISIBLE design first, neighbours after',
  /ensurePreviews\(\[cur\]\)\.then\(/.test(tpl));

console.log('── a lost preview request must NEVER spin forever ──');
// Field report (b195): "Rendering Azure Sidebar and just spinning." Production rendered in
// 1.4s — the request had failed client-side and the only error UI was gated on the CATALOGUE
// failing, so a 404/timeout/dropped request left the pager in spinner-limbo with no way out.
ok('every batch has its own timeout', /setTimeout\(\(\) => controller\.abort\(\), 45_000\)/.test(tpl));
ok('a failed id gets a per-card retry, not a spinner', /failed\[tid\][\s\S]{0,400}Tap to retry/.test(tpl));
ok('retry re-requests just that design', /onPress=\{\(\) => ensurePreviews\(\[tid\]\)\}/.test(tpl));
ok('a 404 (no built resume) gets its own full state with a way forward',
  /res\.status === 404[\s\S]{0,60}setNoResume\(true\)/.test(tpl) && /Build my resume/.test(tpl));
ok('ids missing from a partial response are marked failed too', /missing\.length/.test(tpl));
ok('a retry clears the failure before refetching', /for \(const id of need\) delete next\[id\]/.test(tpl));

console.log('── region is LEVEL ONE of the gallery ──');
// Field report: "all regions' designs show under Generic and changing region does nothing" —
// the chips were a cosmetic Recommended badge while the pager always held every family.
ok('the pager renders the REGION-FILTERED family list', /\{visibleFams\.map\(\(f\) =>/.test(tpl));
ok('the dots follow the same list', /s\.dots[\s\S]{0,120}visibleFams\.map/.test(tpl));
ok('picking a region resets the pager and starts rendering its first family',
  /function pickRegion[\s\S]{0,900}prefetchAround\(0, fams, chosen\)/.test(tpl));
ok('an All-designs chip exists for the full catalogue', /All designs/.test(tpl));
ok('the cosmetic Recommended badge is gone', !/recommendedFams/.test(tpl) && !/Recommended</.test(tpl));

console.log('── the 2026-08-26 overnight round ──');
const card2 = R('../components/ResumeRebuildCard.tsx');
const clt = R('../app/(cover-letter)/templates.tsx');
const clc = R('../../server/controllers/coverLetterController.js');
const home2 = R('../components/HomeScreen.js');
// Regenerate: PUSH the builder (back() landed on Home when the stack had no builder index),
// and show the prefilled story form — never auto-run (explicit user feedback reverting b195).
// Comments are commentary — only executable lines count for the negative half.
const prevCode = prev.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
ok('regenerate PUSHES the builder, never router.back()',
  /resumeBuilderAction', 'regenerate'\)[\s\S]{0,900}router\.push\('\/\(resume-builder\)' as never\)/.test(prev)
  && !/resumeBuilderAction', 'regenerate'\)[\s\S]{0,600}router\.back\(\)/.test(prevCode));
ok('regenerate prefills the form and stops (no autoGenerate)',
  !/action === 'regenerate'[\s\S]{0,1600}autoGenerate\(/.test(idx));
ok('an empty saved story falls back to the uploaded resume text',
  /action === 'regenerate'[\s\S]{0,1800}fetchResumeSourceText/.test(idx));
// The story box is plain text: no markdown markers survive prefill.
ok('a plainStory sanitizer exists and strips ** markers', /function plainStory[\s\S]{0,300}replace\(\/\\\*/.test(idx));
ok('every prefill path routes through it', (idx.match(/plainStory\(/g) || []).length >= 4);
// Two buttons, one row, on the preview — View PDF merged into Download/Preview.
ok('the preview bar is two buttons in one row', /Download \/ Preview/.test(prev) && !/viewPdfBtn/.test(prev));
// Gallery: one Download button; options live in the swipe-up sheet.
ok('the gallery footer is a single Download button', /setSheetOpen\(true\)/.test(tpl));
ok('the sheet holds page layout + file format', /Page layout[\s\S]{0,900}File format/.test(tpl));
ok('the sheet slides up like the filter sheet', /animationType="slide"/.test(tpl));
// Subscription counts, not credits — across the app's action buttons.
ok('the Generate button shows the REMAINING count, not a credit price',
  /resumesLeft} left/.test(idx) && !/genCost/.test(idx));
ok('cover-letter downloads are paid-gated server-side', (clc.match(/requirePaidForDownload/g) || []).length >= 3);
ok('the cover-letter gallery shows a lock or a count, not credit numbers',
  /dlBadge/.test(clt) && /dlLabel\.locked/.test(clt) && !/credits per download/.test(clt));
ok('the company-card credit stamp is retired', !/CREDIT\$\{clGenCost/.test(home2) && /stamp is retired/.test(home2));
// The Home card shows the REAL rendered resume.
ok('a cached home-thumb endpoint exists', /home-thumb/.test(routes) && /resume_thumb_/.test(ctl));
ok('…rendered once per resume version (updated_at key)', /updated_at[\s\S]{0,300}resume_thumb_/.test(ctl));
ok('the card prefers the real preview and keeps the mock as fallback',
  /thumb \? \(/.test(card2) && /MiniResume name=\{name\}/.test(card2));

console.log('── the 2026-08-27 round: Save→100, chosen template travels, email is paid ──');
const emailc = R('../../server/controllers/emailController.js');
const jd2 = R('../app/(ai-hub)/job-detail.tsx');
// Save = "this is my resume now" → a perfect 100, acted-stamped so the popup never nags over it.
ok('the preview top-right button SAVES (Download lives in the bottom bar)',
  /<Text style=\{s\.exportText\}>Save<\/Text>/.test(prev) && !/<Text style=\{s\.exportText\}>Download<\/Text>/.test(prev));
ok('Save finalizes', /finalize: true/.test(prev));
ok('finalize marks the builder resume a perfect 100', /markBuilderPerfect/.test(ctl) && /VALUES \(\$1, 100,/.test(ctl));
ok('…acted-stamped so the popup never re-prompts over a 100', /'ready', NOW\(\)\)/.test(ctl) && /acted_at\)/.test(ctl));
// The chosen design travels: gallery pick → preferred_template → every rendered file.
ok('preferred_template column exists (idempotent)', /ADD COLUMN IF NOT EXISTS preferred_template/.test(ctl));
ok('the gallery persists the on-screen design (debounced)', /preferredTemplate: selForSave/.test(tpl));
ok('a template-only save needs no resumeData', /!resumeData && preferredTemplate/.test(ctl));
ok('the apply/email PDF renders the CHOSEN template', /pref \|\| \(tpls && tpls\[0\]/.test(ctl));
ok('the Home thumbnail renders the chosen template too', /preferred_template[\s\S]{0,200}'banner'/.test(ctl));
// Email applying is paid: the attachment IS a download.
ok('both email-send endpoints carry the paid gate', (emailc.match(/paid_required/g) || []).length >= 2);
ok('the compose modal explains and routes free users to plans',
  /Email applying is a paid feature/.test(jd2) && /View paid plans/.test(jd2));
ok('portal applying stays free (no gate on the apply WebView open)', !/openApplyWebView[\s\S]{0,400}paid_required/.test(jd2));
// The story box: a paragraph change reads as one.
ok('plainStory turns every newline into a blank line', /replace\(\/\\n\/g, '\\n\\n'\)/.test(idx));

console.log(`\nresume rebuild flow: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
