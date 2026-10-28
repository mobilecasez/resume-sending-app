// The paywall, made visible and made possible (2026-10-28, from the October sales analysis).
//   node server/scripts/test-paywall-funnel.js
//
// What the analysis found, and what this suite holds the fix to:
//   • nobody could see the paywall: the free plan includes no downloads, so a refused download IS the paywall,
//     and nothing recorded it → the server now writes `download_blocked` on every refusal, and nothing else;
//   • the sheet's first option was dead (the pass was on sale in neither store) and said "Checking…" for ever →
//     "loading" and "not on sale" are separate answers, and an unavailable pass hands the stage to the plan;
//   • the plans screen recorded nothing → views, starts and outcomes are recorded, and a paid-but-unconfirmed
//     purchase is never counted as a failure (that would hide money we took);
//   • the rating pop-up could not be closed, so people tapped 1★ to escape → "Not now", a working back button,
//     a "Skip" on the feedback step, and the résumé/letter prompts wait for a real download.
// Server behaviour is exercised for real with faked dependencies; app wiring is checked on COMMENT-STRIPPED source.
'use strict';
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const R = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 300) : '')); } };

// ── server: canDownload with its dependencies faked ─────────────────────────────────────────────────────
const tracked = [];
const world = { sub: null, passesBound: [], unbound: 0, trackThrows: false };
const fakes = new Map([
    [path.join(ROOT, 'db-config.js'), {
        query: async (sql) => (/FROM download_passes/.test(String(sql)) ? world.passesBound : []),
        get: async (sql) => (/COUNT\(\*\)/.test(String(sql)) ? { n: world.unbound } : null),
        run: async () => ({}),
    }],
    [path.join(ROOT, 'server', 'services', 'entitlements.js'), {
        activeSubscription: async () => world.sub,
        canConsumeMany: async () => ({ allowed: false, message: 'used up' }),
    }],
    [path.join(ROOT, 'server', 'services', 'liveAnalytics.js'), {
        trackEvent: async (e) => { if (world.trackThrows) throw new Error('db down'); tracked.push(e); },
    }],
]);
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    let resolved = '';
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch { /* fall through */ }
    if (fakes.has(resolved)) return fakes.get(resolved);
    return realLoad.apply(this, arguments);
};
const downloads = require(path.join(ROOT, 'server', 'services', 'downloads.js'));
const req = { headers: { 'x-platform': 'ios', 'x-app-version': '4.8 (213)' } };
const settle = () => new Promise((r) => setTimeout(r, 10));

(async () => {
    console.log('── 1. Every refused download is recorded, and nothing else is ──');
    world.sub = null; world.unbound = 0; tracked.length = 0;
    const no = await downloads.canDownload(42, { employer: 'Nordex' }, req);
    await settle();
    ok('a free user is refused', no.allowed === false && no.reason === 'paid_required', no);
    ok('⚠️ …and the refusal is recorded once', tracked.length === 1 && tracked[0].event === 'download_blocked', tracked);
    ok('…for that user, with the reason and the platform', tracked[0] && tracked[0].userId === 42 && tracked[0].props.reason === 'paid_required'
        && tracked[0].platform === 'ios' && tracked[0].props.forEmployer === true, tracked[0]);

    tracked.length = 0; world.sub = { plan_key: 'plus' };
    const yes = await downloads.canDownload(42, { employer: 'Nordex' }, req);
    await settle();
    ok('a subscriber is allowed', yes.allowed === true, yes);
    ok('…and an allowed download records nothing', tracked.length === 0, tracked);

    tracked.length = 0; world.sub = null; world.unbound = 1;
    const viaPass = await downloads.canDownload(42, {}, req);
    await settle();
    ok('a user holding a pass is allowed, and nothing is recorded', viaPass.allowed === true && tracked.length === 0, { viaPass, tracked });

    world.unbound = 0; world.trackThrows = true;
    let threw = false;
    try { await downloads.canDownload(42, {}, {}); } catch { threw = true; }
    await settle();
    ok('⚠️ analytics failing can never break a download answer', !threw);
    world.trackThrows = false;
    Module._load = realLoad;

    console.log('── 2. The paywall sheet: honest, and recorded ──');
    const SHEET = strip(R('MobileApp/components/downloads/DownloadPaywallSheet.tsx'));
    ok('"loading" and "not on sale" are separate states', /useState<'loading' \| 'available' \| 'unavailable'>\('loading'\)/.test(SHEET));
    ok('⚠️ the one-off cannot be tapped unless the store is selling it', /disabled=\{busy \|\| passState !== 'available'\}/.test(SHEET)
        && /if \(busy \|\| passState !== 'available'\) return;/.test(SHEET));
    ok('an unavailable pass says so instead of "Checking…" for ever',
        /One-off downloads are not available in your store yet\./.test(SHEET) && /\{passState === 'loading' && \(/.test(SHEET));
    ok('…and the plan becomes the primary way to download', /\[s\.planRow, passOff && s\.planRowPrimary\]/.test(SHEET));
    ok('the sheet records being shown', /track\('paywall_shown'/.test(SHEET));
    ok('…whether the pass was on sale', /track\('paywall_pass', \{ available: !!p \}\)/.test(SHEET));
    ok('…a tap on the pass, a tap on plans, and a dismissal', /track\('paywall_pass_tap'/.test(SHEET) && /track\('paywall_plans_tap'/.test(SHEET) && /track\('paywall_dismissed'/.test(SHEET));
    ok('⚠️ every purchase ending is recorded, and paid/pending are NOT failures',
        /result = r\.ok \? 'ok' : r\.cancelled \? 'cancelled' : r\.pending \? 'pending' : r\.paid \? 'paid_unconfirmed' : 'failed';/.test(SHEET)
        && /finally \{\s*track\('pass_purchase_result', \{ result \}\)/.test(SHEET));
    ok('every way out of the sheet goes through the recorded dismissal',
        /onRequestClose=\{dismiss\}/.test(SHEET) && /onPress=\{busy \? undefined : dismiss\}/.test(SHEET) && /onPress=\{dismiss\} style=\{s\.x\}/.test(SHEET));

    console.log('── 3. The plans screen ──');
    const PLANS = strip(R('MobileApp/app/(subscription)/plans.tsx'));
    ok('opening it is recorded', /track\('plans_view'/.test(PLANS));
    ok('a plan the store will not sell is recorded', /track\('plan_unavailable', \{ plan: p\.key \}\)/.test(PLANS));
    ok('a purchase start is recorded', /track\('plan_purchase_start', \{ plan: p\.key \}\)/.test(PLANS));
    ok('⚠️ the outcome is recorded exactly once, whatever happened', /finally \{\s*track\('plan_purchase_result', \{ plan: p\.key, result: planResult \}\)/.test(PLANS));
    ok('…cancelled, unavailable and pending each say so', /planResult = 'cancelled'/.test(PLANS) && /planResult = 'unavailable'/.test(PLANS) && /planResult = 'pending'/.test(PLANS));
    ok('…and the server\'s own verdict (confirmed / retry / rejected) is the result', /planResult = result;/.test(PLANS));

    console.log('── 4. The rating pop-up can be closed, and waits for a success ──');
    const MODAL = strip(R('MobileApp/components/RatingPromptModal.tsx'));
    ok('⚠️ "Not now" exists on the stars step', /<Text style=\{s\.notNowTx\}>Not now<\/Text>/.test(MODAL));
    ok('…and the feedback step can be skipped', /<Text style=\{s\.notNowTx\}>Skip<\/Text>/.test(MODAL));
    ok('⚠️ the back button closes it (it used to do nothing)', !/onRequestClose=\{\(\) => \{\}\}>/.test(MODAL) && /onRequestClose=\{busy \|\| step === 'thanks' \? \(\) => \{\} : notNow\}/.test(MODAL));
    ok('skipping sends no rating', !/notNow[\s\S]{0,120}submitFeedback/.test((MODAL.match(/const notNow = [^\n]+/) || [''])[0]));
    ok('shown, stars and dismissals are recorded', /track\('rating_prompt_shown'/.test(MODAL) && /track\('rating_stars'/.test(MODAL) && /track\('rating_prompt_dismissed'/.test(MODAL));
    ok('the trigger is passed to the rules', /shouldAskForReview\(t\)/.test(MODAL));
    const RS = strip(R('MobileApp/services/ratingService.ts'));
    ok('⚠️ résumé and letter prompts need a real success first', /const NEEDS_SUCCESS = new Set\(\['resume', 'cover_letter'\]\);/.test(RS)
        && /if \(trigger && NEEDS_SUCCESS\.has\(trigger\) && !s\.valueAt\) return false;/.test(RS));
    ok('…an application is a success in itself (apply prompts unchanged)', !/apply_portal|apply_email/.test((RS.match(/NEEDS_SUCCESS = new Set\([^)]*\)/) || [''])[0]));
    for (const [file, kind] of [['MobileApp/app/(resume-builder)/templates.tsx', 'resume'], ['MobileApp/app/(cover-letter)/templates.tsx', 'cover_letter']]) {
        const src = strip(R(file));
        const success = src.slice(src.indexOf("await Sharing.shareAsync(dl.uri"), src.indexOf("Alert.alert('Download failed'"));
        ok(`${kind}: a saved download marks the success`, /noteValueMoment\(\)/.test(success), success.slice(0, 120));
        ok(`${kind}: …and records the completed download`, new RegExp(`track\\('download_complete', \\{ kind: '${kind}', format: fmt \\}\\)`).test(success));
        ok(`${kind}: …only after the file was really fetched`, src.indexOf("if (dl.status !== 200) throw new Error('Download failed');") < src.indexOf('noteValueMoment()'));
    }

    console.log(`\npaywall funnel: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
