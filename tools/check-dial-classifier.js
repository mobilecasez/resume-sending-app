// DOES THE WIDENED DIAL RULE CLAIM ANYTHING IT SHOULD NOT? — across many real employers.
//
//   node tools/check-dial-classifier.js <jobs.json> [limit]
//
// WHY THIS IS NOT COVERED BY ANYTHING ELSE. The dial fix (79d968a) widened canonicalQ's fold to
// "codes?" and added _dialByShape, a POSITIONAL rule: a nameless chooser within two positions of the
// phone box is treated as a dial picker. Positional rules are exactly the kind that work on the page
// they were written against and misfire elsewhere.
//   · tools/audit-autofill2.js cannot see this — it never calls the server; it maps values with its
//     own local `valueFor`, so a server misclassification is invisible to it.
//   · test-live-forms-e2e.js LEG 0 does call the real classifier, but on ONE page.
// So this is LEG 0, widened to a corpus: scan real forms, run the server's own exported
// isPhoneCodeField / isPhoneNumberField over the fields the scan actually produced, and report every
// field claimed as a dial control. A claim is only expected when the label really is a dial label;
// anything else is printed as SUSPECT and counted.
//
// ⚠️ Hard rules inherited from the other harnesses: every submit path is neutralised before the page
// is touched, nothing is ever typed or submitted (this READS ONLY — there is no fill leg at all),
// and no real person's data is involved.
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'MobileApp', 'app', '(ai-hub)', 'job-detail.tsx'), 'utf8');
const raw = (n) => { const m = SRC.match(new RegExp('(?:export )?const ' + n + ' = `([\\s\\S]*?)`;\\n')); if (!m) throw new Error('no ' + n); return m[1]; };
const JS_HELPERS = new Function('JS_HELPERS', 'return `' + raw('JS_HELPERS') + '`;')('');
const READ_FIELDS_JS = new Function('JS_HELPERS', 'return `' + raw('READ_FIELDS_JS') + '`;')(JS_HELPERS);

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test@localhost:5432/test';
const SRVCLF = require(path.join(REPO, 'server', 'controllers', 'aiHubController.js'));
if (typeof SRVCLF.isPhoneCodeField !== 'function') { console.error('server classifier not exported'); process.exit(1); }

// A label that genuinely names a dial control. Anything else claimed by the classifier is suspect.
const REALLY_DIAL = /(dial|calling\s*code|country\s*code|phone\s*code|code\s*country|vorwahl|prefix|indicatif|prefisso|\+\d)/i;
// A label that must NEVER be claimed: these are residence / nationality / plain-country questions,
// and writing "+91" into one is worse than leaving it blank.
const NEVER_DIAL = /^(current\s*country|country|country\s*of\s*residence|nationality|citizenship|location|state|province|region|city)\b/i;

async function scan(browser, job) {
    const out = { url: job.job_url, host: (() => { try { return new URL(job.job_url).host.replace(/^www\./, ''); } catch (e) { return '?'; } })() };
    const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        viewport: { width: 390, height: 844 },
    });
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    try {
        await page.goto(job.job_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(4000);
        for (const t of ['Accept all', 'Allow all', 'Accept cookies', 'Godkänn alla', 'Alle akzeptieren', 'Accept']) {
            const b = page.locator(`button:has-text("${t}")`).first();
            if (await b.count().catch(() => 0)) { await b.click({ timeout: 1500 }).catch(() => {}); break; }
        }
        for (const t of ['Apply for this job', 'Apply now', 'Ansök', 'Jetzt bewerben', 'Postuler', 'Apply']) {
            const b = page.locator(`a:has-text("${t}"), button:has-text("${t}")`).first();
            if (await b.count().catch(() => 0)) { await b.click({ timeout: 3000 }).catch(() => {}); break; }
        }
        await page.waitForTimeout(4500);
        // Nothing here types or submits, but the shield goes up anyway — a scan opens dropdowns.
        await page.evaluate(() => {
            window.__cvfSubmits = 0;
            document.addEventListener('submit', (e) => { e.preventDefault(); e.stopImmediatePropagation(); window.__cvfSubmits++; }, true);
            HTMLFormElement.prototype.submit = function () { window.__cvfSubmits++; };
            HTMLFormElement.prototype.requestSubmit = function () { window.__cvfSubmits++; };
            document.querySelectorAll('button[type=submit],input[type=submit]').forEach((b) => { b.disabled = true; });
        });
        const fields = await page.evaluate(async (js) => new Promise((resolve) => {
            const got = [];
            window.ReactNativeWebView = { postMessage: (s) => { try { const o = JSON.parse(s); if (o && o.type === 'FIELDS') got.push(o.fields || []); } catch (e) {} } };
            try { eval(js); } catch (e) { return resolve([]); }
            const t0 = Date.now();
            (function poll() {
                if (got.length) return resolve(got[got.length - 1]);
                if (Date.now() - t0 > 40000) return resolve([]);
                setTimeout(poll, 400);
            })();
        }), READ_FIELDS_JS);
        out.fields = (fields || []).length;
        const nonFile = (fields || []).filter((f) => f && f.key && String(f.type || '').toLowerCase() !== 'file');
        // Exactly the two calls the server makes, with the same positional context.
        out.code = nonFile.filter(SRVCLF.isPhoneCodeField).map((f) => ({ key: f.key, label: String(f.label || '').slice(0, 50) }));
        out.num = nonFile.filter(SRVCLF.isPhoneNumberField).map((f) => ({ key: f.key, label: String(f.label || '').slice(0, 50) }));
        out.both = out.code.filter((c) => out.num.some((n) => n.key === c.key));
        out.suspect = out.code.filter((c) => !REALLY_DIAL.test(c.label) || NEVER_DIAL.test(c.label.trim()));
        out.submits = await page.evaluate(() => window.__cvfSubmits || 0).catch(() => 0);
    } catch (e) { out.error = String(e && e.message).slice(0, 120); }
    await ctx.close().catch(() => {});
    return out;
}

(async () => {
    const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const limit = parseInt(process.argv[3], 10) || jobs.length;
    const browser = await chromium.launch();
    const res = [];
    for (let i = 0; i < Math.min(limit, jobs.length); i += 4) {
        const got = await Promise.all(jobs.slice(i, i + 4).map((j) => scan(browser, j).catch((e) => ({ url: j.job_url, error: String(e && e.message).slice(0, 80) }))));
        got.forEach((g) => {
            res.push(g);
            console.log('[' + res.length + '/' + Math.min(limit, jobs.length) + '] ' + (g.host || '?').padEnd(28)
                + ' fields=' + (g.fields != null ? String(g.fields).padStart(3) : '  -')
                + ' dial=' + (g.code || []).length + ' num=' + (g.num || []).length
                + ((g.suspect || []).length ? '  ⚠️ SUSPECT ' + JSON.stringify(g.suspect.map((s) => s.label)) : '')
                + ((g.both || []).length ? '  ⚠️ CLAIMED BY BOTH ' + JSON.stringify(g.both.map((s) => s.label)) : '')
                + (g.error ? '  ERR ' + g.error.slice(0, 40) : ''));
        });
    }
    await browser.close();
    const reached = res.filter((r) => r.fields > 0);
    const suspect = res.reduce((n, r) => n + ((r.suspect || []).length), 0);
    const both = res.reduce((n, r) => n + ((r.both || []).length), 0);
    const dial = res.reduce((n, r) => n + ((r.code || []).length), 0);
    console.log('\npages ' + res.length + '  forms reached ' + reached.length
        + '  dial fields claimed ' + dial + '  SUSPECT ' + suspect + '  claimed by BOTH filters ' + both);
    console.log('TOTAL SUBMITS (must be 0): ' + res.reduce((n, r) => n + (r.submits || 0), 0));
    res.forEach((r) => (r.code || []).forEach((c) => console.log('  dial claim  ' + (r.host + '                    ').slice(0, 24) + ' ' + JSON.stringify(c.label))));
    if (process.env.CVF_OUT) fs.writeFileSync(process.env.CVF_OUT, JSON.stringify(res, null, 1));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
