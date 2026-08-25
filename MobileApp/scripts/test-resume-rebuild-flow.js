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
ok('generatePDF gates on an active subscription', /activeSubscription\(userId\)[\s\S]{0,400}paid_required/.test(ctl));
ok('generateDocx gates the same way', /generateDocx[\s\S]{0,600}paid_required/.test(ctl));
ok('the PDF path no longer deducts credits', !/deductCredits\(userId, DOWNLOAD_CREDIT_COST/.test(ctl));
ok('previewTemplates has NO plan/credit gate', !/previewTemplates[\s\S]{0,900}(activeSubscription|checkUserCredits)/.test(ctl.slice(ctl.indexOf('async function previewTemplates'))));

console.log('── server: free plan = one regeneration, in its own lane ──');
ok('regenerate checks regen_count for free users', /isRegenerate && !sub[\s\S]{0,400}regen_count/.test(ctl));
ok('the used-up case is a 403 with reason regen_limit', /regen_limit/.test(ctl));
ok('the one free regen BYPASSES the quota gate', /freeRegen \? \{ allowed: true \} : await entitlements\.canConsumeMany/.test(ctl));
ok('…and is not double-counted on success', /if \(!freeRegen\) await entitlements\.consumeOnSuccess/.test(ctl));
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
ok('Download + View PDF both route to the gallery', (prev.match(/router\.push\('\/\(resume-builder\)\/templates'\)/g) || []).length >= 2);
ok('Regenerate knows the free allowance before navigating', /regen\.used >= regen\.freeLimit/.test(prev));
ok('…and offers the plans screen', /Regeneration used[\s\S]{0,300}\/\(subscription\)\/plans/.test(prev));

console.log('── app: gallery ──');
ok('the catalogue is fetched from the server (no hardcoded template list)', /resume-builder\/templates`/.test(tpl));
ok('previews load lazily in batches of ≤3', /need\.slice\(i, i \+ 3\)/.test(tpl));
ok('in-flight requests are deduped', /inFlight\.current\.has\(id\)/.test(tpl));
ok('neighbours are prefetched on swipe', /prefetchAround\(idx/.test(tpl));
ok('swatch taps fetch just that variant', /pickVariant[\s\S]{0,200}ensurePreviews\(\[tplId\]\)/.test(tpl));
ok('free users see the download as a PAID feature, with plans routing', /upsellDownload[\s\S]{0,400}View paid plans/.test(tpl));
ok('the server 403 wins over cached paid state', /paid_required[\s\S]{0,80}setIsPaid\(false\)/.test(tpl));
ok('previews are stated free in the UI', /every preview is free|previews of all designs free|Previews are free/.test(tpl));
ok('no credit badges remain in the gallery', !/DOWNLOAD_CREDITS/.test(tpl));

console.log('── app: one-tap auto flows ──');
ok('an autoBuild entry generates without the form', /e\.autoBuild[\s\S]{0,2000}autoGenerate\(/.test(idx));
ok('a missing uploaded resume walks the user to the upload', /onboarding_focus_target[\s\S]{0,40}'resume'/.test(idx) || /'onboarding_focus_target', 'resume'/.test(idx));
ok('regenerate is one tap when the story is saved', /action === 'regenerate'[\s\S]{0,1400}autoGenerate\(/.test(idx));
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

console.log(`\nresume rebuild flow: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
