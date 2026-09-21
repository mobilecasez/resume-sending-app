// Google Play user choice billing (India) — the money path.
//   node server/scripts/test-ucb-billing.js
//
// WHY THIS SUITE EXISTS. This is the one place in the app where WE take the money instead of a
// store, so three things have to be true at once and none of them is visible from a screenshot:
//   • it is OFF unless every prerequisite is real (switch, gateway keys, INR prices, Play service
//     account) and the caller is Android in India — Apple forbids this outright, and offering a
//     payment we cannot take is worse than offering none;
//   • a payment grants exactly one period, once — a replayed verify, a double tap or a resent
//     answer must converge on the same row rather than stack a second month on the same rupees;
//   • every payment we take is REPORTED to Google within 24 hours. A failed report must leave the
//     obligation behind (status 'paid') for flushUnreported, and must never block the plan the
//     user already paid for.
// The database and the gateway are faked in memory; entitlements and the Play API are recorded so
// the arguments themselves can be asserted — a grant with the wrong period or an auto-renew flag
// this feature does not have would pass any "it returned ok" test.
'use strict';
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) pass++;
    else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 300) : '')); }
};

// ── fakes, injected through the require cache before the service loads ────────────────────────
const db = { rows: [], sql: [] };
const dbFake = {
    query: async (sql, params = []) => {
        db.sql.push(String(sql).replace(/\s+/g, ' ').trim());
        const s = String(sql);
        if (/^\s*CREATE/i.test(s)) return [];
        if (/^\s*INSERT INTO ucb_transactions/i.test(s)) {
            const [id, user_id, plan_key, provider, external_token, provider_order_id,
                amount_minor, currency, tax_percent, region_code] = params;
            db.rows.push({
                id, user_id, plan_key, provider, external_token, provider_order_id,
                amount_minor, currency, tax_percent, region_code, status: 'created',
                provider_payment_id: null, granted_at: null, reported_at: null,
                report_attempts: 0, last_error: null, created_at: new Date('2026-09-20T10:00:00Z'),
            });
            return [];
        }
        if (/^\s*UPDATE ucb_transactions/i.test(s)) {
            const row = db.rows.find((r) => r.id === params[0]);
            if (!row) return [];
            if (/status='paid'/.test(s)) { row.status = 'paid'; row.provider_payment_id = params[1]; }
            if (/status='failed'/.test(s)) { row.status = 'failed'; row.last_error = params[1]; }
            if (/granted_at=NOW\(\)/.test(s)) row.granted_at = new Date();
            if (/status='reported'/.test(s)) { row.status = 'reported'; row.reported_at = new Date(); row.last_error = null; row.report_attempts += 1; }
            else if (/report_attempts = report_attempts \+ 1/.test(s)) { row.report_attempts += 1; row.last_error = params[1]; }
            else if (/last_error=\$2/.test(s) && !/status=/.test(s)) row.last_error = params[1];
            return [];
        }
        if (/SELECT \* FROM ucb_transactions\s+WHERE status = 'paid'/i.test(s)) {
            return db.rows.filter((r) => r.status === 'paid' && r.external_token).slice(0, params[0] || 50);
        }
        if (/SELECT \* FROM ucb_transactions WHERE id/i.test(s)) {
            return db.rows.filter((r) => r.id === params[0] && r.user_id === params[1]);
        }
        return [];
    },
    get: async (sql, params = []) => (await dbFake.query(sql, params))[0] || null,
};

const grants = [];
const entsFake = {
    PLANS: [{ key: 'plus', label: 'Plus', letters: 25, resumes: 15 }],
    planByKey: (k) => (k === 'plus' || k === 'pro' ? { key: k, label: k === 'plus' ? 'Plus' : 'Pro' } : null),
    storeSetSubscription: async (args) => { grants.push(args); if (entsFake._throw) throw new Error('db down'); return { ok: true }; },
    _throw: false,
};

const reports = [];
const playApiFake = {
    isConfigured: () => playApiFake._configured,
    _configured: true,
    androidPublisher: async () => ({
        externaltransactions: {
            createexternaltransaction: async (req) => {
                reports.push(req);
                if (playApiFake._fail) { const e = new Error(playApiFake._failText || 'boom'); e.code = playApiFake._failCode || 500; throw e; }
                return { data: { externalTransactionId: req.externalTransactionId } };
            },
        },
    }),
    _fail: false, _failCode: 500, _failText: 'boom',
};

const rp = { orders: [] };
const razorpayFake = function RazorpayFake(cfg) {
    this.orders = {
        create: async (o) => {
            if (razorpayFake._fail) throw new Error('gateway down');
            rp.orders.push({ ...o, key: cfg.key_id });
            return { id: 'order_' + (rp.orders.length) };
        },
    };
};
razorpayFake._fail = false;

const realResolve = Module._resolveFilename;
const FAKES = new Map([
    [path.join(ROOT, 'db-config.js'), dbFake],
    [path.join(ROOT, 'server', 'services', 'entitlements.js'), entsFake],
    [path.join(ROOT, 'server', 'services', 'playStoreApi.js'), playApiFake],
]);
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'razorpay') return razorpayFake;
    try {
        const resolved = realResolve.call(Module, request, parent, isMain);
        if (FAKES.has(resolved)) return FAKES.get(resolved);
    } catch { /* not resolvable here — let the real loader answer */ }
    return realLoad.apply(this, arguments);
};

const ucb = require(path.join(ROOT, 'server', 'services', 'userChoiceBilling.js'));
const playExternal = require(path.join(ROOT, 'server', 'services', 'playExternalTransactions.js'));

function envOn() {
    process.env.UCB_ENABLED = '1';
    process.env.UCB_PROVIDER = 'razorpay';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    process.env.UCB_PRICES_INR = JSON.stringify({ plus: 49900 });
    process.env.UCB_TAX_PERCENT = '18';
    playApiFake._configured = true;
}
function envReset() {
    delete process.env.UCB_ENABLED; delete process.env.UCB_PRICES_INR;
    delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.UCB_TAX_PERCENT; delete process.env.UCB_PROVIDER;
    db.rows = []; db.sql = []; grants.length = 0; reports.length = 0; rp.orders.length = 0;
    entsFake._throw = false; playApiFake._fail = false; playApiFake._configured = true; razorpayFake._fail = false;
}
const crypto = require('crypto');
const sign = (orderId, paymentId) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

(async () => {
    console.log('── 1. OFF is the default, and it says why ──');
    envReset();
    ok('no switch → disabled, reason switch_off', ucb.config().enabled === false && ucb.config().reason === 'switch_off', ucb.config());
    process.env.UCB_ENABLED = '1';
    ok('switch alone is not enough (no gateway keys)', !ucb.config().enabled && ucb.config().reason === 'no_gateway', ucb.config());
    process.env.RAZORPAY_KEY_ID = 'k'; process.env.RAZORPAY_KEY_SECRET = 's';
    ok('…nor without prices', !ucb.config().enabled && ucb.config().reason === 'no_prices', ucb.config());
    process.env.UCB_PRICES_INR = JSON.stringify({ plus: 49900 });
    playApiFake._configured = false;
    ok('…nor without Play credentials to report with', !ucb.config().enabled && ucb.config().reason === 'no_play_credentials', ucb.config());
    playApiFake._configured = true;
    ok('everything present → enabled', ucb.config().enabled === true, ucb.config());
    ok('⚠️ iOS can never have it', ucb.config({ platform: 'ios' }).enabled === false && ucb.config({ platform: 'ios' }).reason === 'not_android');
    ok('⚠️ outside India it is off', ucb.config({ platform: 'android', country: 'US' }).enabled === false
        && ucb.config({ platform: 'android', country: 'US' }).reason === 'not_india');
    ok('India + Android → on', ucb.config({ platform: 'android', country: 'IN' }).enabled === true);
    ok('a price for a plan that does not exist is ignored', (() => {
        process.env.UCB_PRICES_INR = JSON.stringify({ plus: 49900, nonsense: 100 });
        const p = ucb.priceTable(); return p.plus === 49900 && p.nonsense === undefined;
    })());
    ok('a zero or negative price is ignored', (() => {
        process.env.UCB_PRICES_INR = JSON.stringify({ plus: 0, pro: -1 });
        return Object.keys(ucb.priceTable()).length === 0;
    })());
    ok('malformed price JSON disables rather than throws', (() => {
        process.env.UCB_PRICES_INR = '{not json';
        return Object.keys(ucb.priceTable()).length === 0 && ucb.config().enabled === false;
    })());

    console.log('── 2. An order is only ever made for something real ──');
    envReset(); envOn();
    ok('no token → refused (Google mints it; we cannot)',
        (await ucb.createOrder({ userId: 1, planKey: 'plus', token: '', platform: 'android', country: 'IN' })).reason === 'no_token');
    ok('a plan with no INR price cannot be bought this way',
        (await ucb.createOrder({ userId: 1, planKey: 'pro', token: 'tok', platform: 'android', country: 'IN' })).reason === 'unknown_plan');
    ok('iOS is refused at the order too, not just in the config',
        (await ucb.createOrder({ userId: 1, planKey: 'plus', token: 'tok', platform: 'ios', country: 'IN' })).reason === 'not_android');
    razorpayFake._fail = true;
    ok('a gateway that will not make an order leaves NO row behind',
        (await ucb.createOrder({ userId: 1, planKey: 'plus', token: 'tok', platform: 'android', country: 'IN' })).reason === 'gateway_unavailable'
        && db.rows.length === 0);
    razorpayFake._fail = false;

    const made = await ucb.createOrder({ userId: 7, planKey: 'plus', token: 'GOOGLE_TOKEN', platform: 'android', country: 'IN' });
    ok('a good order returns what the checkout needs', made.ok && made.orderId && made.transactionId && made.amountMinor === 49900 && made.currency === 'INR', made);
    ok('…and the row remembers the token, the user and the plan BEFORE any money moves',
        db.rows.length === 1 && db.rows[0].external_token === 'GOOGLE_TOKEN' && db.rows[0].user_id === 7
        && db.rows[0].plan_key === 'plus' && db.rows[0].status === 'created');
    ok('the gateway was asked for the exact price in paise', rp.orders[0] && rp.orders[0].amount === 49900 && rp.orders[0].currency === 'INR', rp.orders[0]);
    ok('the transaction id is one Google will accept as an external id', playExternal.ID_RE.test(made.transactionId), made.transactionId);
    ok('⚠️ the secret key never leaves the server', !JSON.stringify(made).includes(process.env.RAZORPAY_KEY_SECRET));

    console.log('── 3. A forged payment grants nothing ──');
    const bad = await ucb.settle({ userId: 7, transactionId: made.transactionId, paymentId: 'pay_x', signature: 'not-a-signature' });
    ok('a wrong signature is refused', bad.ok === false && bad.reason === 'bad_signature', bad);
    ok('…nothing was granted', grants.length === 0);
    ok('…and the row says failed', db.rows[0].status === 'failed');
    ok('another user cannot settle this transaction',
        (await ucb.settle({ userId: 8, transactionId: made.transactionId, paymentId: 'p', signature: 'x' })).reason === 'unknown_transaction');

    console.log('── 4. A real payment grants exactly one period, once ──');
    envReset(); envOn();
    const m2 = await ucb.createOrder({ userId: 7, planKey: 'plus', token: 'TOK2', platform: 'android', country: 'IN' });
    const good = await ucb.settle({ userId: 7, transactionId: m2.transactionId, paymentId: 'pay_1', signature: sign(m2.orderId, 'pay_1') });
    ok('it succeeds', good.ok === true && good.planKey === 'plus', good);
    ok('exactly one grant', grants.length === 1, grants.length);
    const g = grants[0] || {};
    ok('…for this user and plan', g.userId === 7 && g.planKey === 'plus');
    ok('⚠️ …keyed on the GATEWAY payment id, so a replay cannot stack a second period', g.originalTxnId === 'pay_1');
    ok('⚠️ …and it does NOT auto-renew (there is no mandate behind it)', g.autoRenew === false, g.autoRenew);
    ok('…for the advertised period, to the day', (() => {
        const days = (new Date(g.periodEnd) - new Date(g.periodStart)) / 86400000;
        return Math.round(days) === ucb.PERIOD_DAYS;
    })(), { start: g.periodStart, end: g.periodEnd });
    ok('…named as its own source, never as a store purchase', g.source === 'play_user_choice' && g.environment === 'Production');
    const again = await ucb.settle({ userId: 7, transactionId: m2.transactionId, paymentId: 'pay_1', signature: sign(m2.orderId, 'pay_1') });
    ok('⚠️ a replayed verify grants NOTHING more', again.ok === true && again.alreadyDone === true && grants.length === 1, { again, grants: grants.length });

    console.log('── 5. Google is told, correctly ──');
    ok('one report', reports.length === 1, reports.length);
    const r = reports[0] || {};
    const body = r.requestBody || {};
    ok('…against our own transaction id', r.externalTransactionId === m2.transactionId);
    ok('…for this app', String(r.parent).endsWith(playExternal.PACKAGE));
    ok('…carrying GOOGLE\'S token, not one of ours', body.oneTimeTransaction && body.oneTimeTransaction.externalTransactionToken === 'TOK2');
    ok('…as a one-time transaction (nothing recurring is claimed)', !!body.oneTimeTransaction && !body.recurringTransaction);
    ok('…with the tax split out of the gross', (() => {
        const pre = Number(body.originalPreTaxAmount.priceMicros), tax = Number(body.originalTaxAmount.priceMicros);
        return pre + tax === 49900 * 10000 && Math.round(pre / 10000) === Math.round(49900 / 1.18);
    })(), { pre: body.originalPreTaxAmount, tax: body.originalTaxAmount });
    ok('…in the right currency and tax region', body.originalPreTaxAmount.currency === 'INR' && body.userTaxAddress.regionCode === 'IN');
    ok('…and the row is marked reported', db.rows[0].status === 'reported' && db.rows[0].reported_at);
    ok('the split always adds back up to the gross, at any rate', (() => {
        for (const [gross, pct] of [[49900, 18], [1, 18], [99999, 5], [12345, 0], [7, 28]]) {
            const s = playExternal.splitTax(gross, pct);
            if (s.preTaxMinor + s.taxMinor !== gross) return false;
        }
        return true;
    })());

    console.log('── 6. A report that fails is a debt, not a lost payment ──');
    envReset(); envOn();
    playApiFake._fail = true;
    const m3 = await ucb.createOrder({ userId: 9, planKey: 'plus', token: 'TOK3', platform: 'android', country: 'IN' });
    const s3 = await ucb.settle({ userId: 9, transactionId: m3.transactionId, paymentId: 'pay_3', signature: sign(m3.orderId, 'pay_3') });
    ok('⚠️ the user still gets the plan they paid for', s3.ok === true && grants.length === 1, s3);
    ok('…and is not told a lie about the report', s3.reported === false);
    ok('the obligation stays on the row', db.rows[0].status === 'paid' && db.rows[0].report_attempts === 1 && !!db.rows[0].last_error);
    playApiFake._fail = false;
    const flushed = await ucb.flushUnreported();
    ok('a flush reports it', flushed.reported === 1 && flushed.failed === 0, flushed);
    ok('…and the row is settled', db.rows[0].status === 'reported');
    const flushedAgain = await ucb.flushUnreported();
    ok('…and a second flush has nothing left to do', flushedAgain.tried === 0, flushedAgain);

    console.log('── 7. Google already knowing is success, not failure ──');
    envReset(); envOn();
    playApiFake._fail = true; playApiFake._failCode = 409; playApiFake._failText = 'externalTransactionId already exists';
    const m4 = await ucb.createOrder({ userId: 11, planKey: 'plus', token: 'TOK4', platform: 'android', country: 'IN' });
    const s4 = await ucb.settle({ userId: 11, transactionId: m4.transactionId, paymentId: 'pay_4', signature: sign(m4.orderId, 'pay_4') });
    ok('a duplicate id reads as reported (our own earlier attempt landed)', s4.ok === true && s4.reported === true && db.rows[0].status === 'reported', s4);
    playApiFake._failCode = 500; playApiFake._failText = 'boom';

    console.log('── 8. Money taken and nothing given is loud ──');
    envReset(); envOn();
    entsFake._throw = true;
    const m5 = await ucb.createOrder({ userId: 12, planKey: 'plus', token: 'TOK5', platform: 'android', country: 'IN' });
    const s5 = await ucb.settle({ userId: 12, transactionId: m5.transactionId, paymentId: 'pay_5', signature: sign(m5.orderId, 'pay_5') });
    ok('the failure is reported as such, and says the money moved', s5.ok === false && s5.reason === 'grant_failed' && s5.paid === true, s5);
    ok('the row keeps the payment and the error', db.rows[0].status === 'paid' && db.rows[0].provider_payment_id === 'pay_5' && /grant failed/.test(db.rows[0].last_error || ''));

    console.log('── 9. The report refuses what Google would refuse ──');
    envReset(); envOn();
    let threw = null;
    try { await playExternal.report({ transactionId: 'has spaces and !', token: 't', grossMinor: 100, currency: 'INR', taxPercent: 18, regionCode: 'IN', at: new Date() }); }
    catch (e) { threw = e.message; }
    ok('a malformed external id never reaches Google', /1-63 chars/.test(threw || ''), threw);
    threw = null;
    try { await playExternal.report({ transactionId: 'abc', token: '', grossMinor: 100, currency: 'INR', taxPercent: 18, regionCode: 'IN', at: new Date() }); }
    catch (e) { threw = e.message; }
    ok('…and neither does a payment with no Google token', /externalTransactionToken/.test(threw || ''), threw);
    playApiFake._configured = false;
    threw = null;
    try { await playExternal.report({ transactionId: 'abc', token: 't', grossMinor: 100, currency: 'INR', taxPercent: 18, regionCode: 'IN', at: new Date() }); }
    catch (e) { threw = e.message; }
    ok('no service account is a clear error, not a silent skip', /service account/.test(threw || ''), threw);
    playApiFake._configured = true;

    console.log('── 10. The app can never be broken by the optional mode, and iOS never sees it ──');
    // Source-level, on comment-stripped text: matching our own explanation would prove nothing.
    const fs = require('fs');
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const SB = strip(fs.readFileSync(path.join(ROOT, 'MobileApp', 'services', 'storeBilling.ts'), 'utf8'));
    const UC = strip(fs.readFileSync(path.join(ROOT, 'MobileApp', 'services', 'userChoiceBilling.ts'), 'utf8'));
    const PL = strip(fs.readFileSync(path.join(ROOT, 'MobileApp', 'app', '(subscription)', 'plans.tsx'), 'utf8'));
    const init = (SB.match(/export function initStoreBilling\(\)[\s\S]*?\n}\n/) || [''])[0];
    ok('⚠️ the connection tries user-choice first…', /initConnection\(\{ alternativeBillingModeAndroid: 'user-choice' \}\)/.test(init));
    // The user-choice branch is everything from `if (wantsUserChoice) {` up to the plain connect. Inside it the ONLY
    // way out may be the success `return true`; a `return false` or a `throw` in the catch is exactly the regression
    // that would leave every Android subscription unbuyable while Play enrolment is pending.
    const ucBranch = (init.match(/if \(wantsUserChoice\) \{([\s\S]*?)await m\.initConnection\(\);\s*return true;\s*\} catch/) || [])[1] || '';
    ok('⚠️ …and if Google refuses it, falls through to PLAIN Play billing instead of failing every purchase',
        ucBranch.length > 0
        && (ucBranch.match(/return true;/g) || []).length === 1
        && !/return false|throw /.test(ucBranch)
        && /catch \(e: any\)/.test(ucBranch), ucBranch.slice(0, 200));
    ok('…the mode is only ever asked for on Android', /Platform\.OS === 'android' && await userChoiceModeWanted\(\)/.test(init));
    ok('the client module answers "off" on anything but Android',
        /export async function userChoiceModeWanted[\s\S]*?if \(Platform\.OS !== 'android'\) return false;/.test(UC)
        && /export async function fetchUcbConfig[\s\S]*?if \(Platform\.OS !== 'android'\) return \{ \.\.\.OFF/.test(UC));
    ok('…and the gateway checkout refuses to open off Android', /export async function openGatewayCheckout[\s\S]*?if \(Platform\.OS !== 'android'\) return \{ ok: false, reason: 'not_android' \};/.test(UC));
    ok('the plans screen listens for Google\'s chooser only on Android, and only when the server says on',
        /if \(Platform\.OS !== 'android'\) return;[\s\S]*?fetchUcbConfig\(\)\.then\(\(cfg\) => \{\s*if \(!on \|\| !cfg\.enabled\) return;[\s\S]*?userChoiceBillingListenerAndroid/.test(PL));
    ok('…and never claims a plan started unless the server said so',
        /r\.status === 'done'/.test(PL) && /Payment received — activating/.test(PL) && /Nothing was charged/.test(PL));

    console.log('── 11. The Play credentials are found where production actually keeps them ──');
    // A child process per case, because playStoreApi reads its env ONCE at require time. The account below is fake:
    // the point is WHICH variable is read, never whose key it is.
    const { spawnSync } = require('child_process');
    const fakeSa = Buffer.from(JSON.stringify({ type: 'service_account', client_email: 'fake@example.iam.gserviceaccount.com' })).toString('base64');
    const probe = (env) => {
        const r = spawnSync(process.execPath, ['-e',
            `process.stdout.write(String(require(${JSON.stringify(path.join(ROOT, 'server', 'services', 'playStoreApi.js'))}).isConfigured()))`],
            { env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', GOOGLE_PLAY_SA_KEYFILE: '/nonexistent/key.json', ...env }, encoding: 'utf8' });
        return (r.stdout || '').trim();
    };
    ok('⚠️ GOOGLE_PLAY_SA_B64 alone configures it (what Railway actually has)', probe({ GOOGLE_PLAY_SA_B64: fakeSa }) === 'true', probe({ GOOGLE_PLAY_SA_B64: fakeSa }));
    ok('GOOGLE_PLAY_SA_JSON still works', probe({ GOOGLE_PLAY_SA_JSON: JSON.stringify({ type: 'service_account' }) }) === 'true');
    ok('nothing set and no key file → not configured', probe({}) === 'false');
    ok('a malformed base64 value is "not configured", never a crash', probe({ GOOGLE_PLAY_SA_B64: 'not-base64-json' }) === 'false');

    // ⚠️ THE FAKE ABOVE HID A REAL HOLE (2026-09-21): playExternalTransactions called playApi.androidPublisher(),
    // which the real module did not export, so every report would have thrown in production while this suite passed.
    // Check the REAL module's exports against every playApi.<name> the reporter actually calls.
    const realExports = (() => {
        const r = spawnSync(process.execPath, ['-e',
            `process.stdout.write(JSON.stringify(Object.keys(require(${JSON.stringify(path.join(ROOT, 'server', 'services', 'playStoreApi.js'))}))))`],
            { env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '' }, encoding: 'utf8' });
        try { return JSON.parse(r.stdout || '[]'); } catch { return []; }
    })();
    const PX = strip(fs.readFileSync(path.join(ROOT, 'server', 'services', 'playExternalTransactions.js'), 'utf8'));
    const used = Array.from(new Set((PX.match(/playApi\.(\w+)/g) || []).map((m) => m.split('.')[1])));
    ok('every playApi.<fn> the reporter calls is really exported', used.length > 0 && used.every((u) => realExports.includes(u)),
        { used, realExports });
    ok('…androidPublisher in particular', realExports.includes('androidPublisher'));

    console.log(`\nucb billing: ${pass} passed, ${fail} failed`);
    Module._load = realLoad;
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
