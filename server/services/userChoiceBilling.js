// USER CHOICE BILLING — our own checkout beside Google Play's, for users in India.
//
// WHAT THIS IS. After the Competition Commission of India's order, Google Play lets an app in India
// show Google's own chooser at the moment of purchase: Play billing, or the developer's payment
// method. Pick ours and Google hands the app an externalTransactionToken, we take the payment
// ourselves, and Google's service fee drops by 4 points (15% → 11%) in exchange for us REPORTING
// every such payment within 24 hours (services/playExternalTransactions.js).
//
// ⚠️ ANDROID AND INDIA ONLY, AND OFF UNTIL SWITCHED ON. Apple forbids this outright (guideline
// 3.1.1 — a digital purchase inside an iOS app is Apple's IAP or nothing), and the Play programme
// itself is India-only. The switch is UCB_ENABLED=1 plus real prices in UCB_PRICES_INR; with either
// missing this module answers "off" and the app never offers anything. Shipping it dark is
// deliberate: the Play Console enrolment and the gateway's own approval are the owner's to finish,
// and an app that offers a payment it cannot take is worse than one that offers none.
//
// ⚠️ WHAT THE USER BUYS HERE DOES NOT AUTO-RENEW. One payment, one fixed period, then it lapses —
// so there is no mandate to keep alive, nothing to cancel, and the Play report is a one-time
// transaction. Auto-renewal through a gateway is a different feature with its own mandate, dunning
// and grace rules; none of that is pretended here.
//
// ⚠️ THE PAYMENT AND THE PLAN ARE ONE DECISION, THE REPORT IS A DEBT. Verify → grant → report. If
// Google is unreachable the user still gets what they paid for and the row stays 'paid', which
// flushUnreported() retries. If the GRANT fails after a captured payment the row stays 'paid' with
// the error on it, because money taken and nothing given is the one outcome that must be loud.
const crypto = require('crypto');
const dbConfig = require('../../db-config');
const ents = require('./entitlements');
const playExternal = require('./playExternalTransactions');

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS ucb_transactions (
    id                  UUID PRIMARY KEY,
    user_id             INTEGER NOT NULL,
    plan_key            TEXT NOT NULL,
    provider            TEXT NOT NULL,
    external_token      TEXT NOT NULL,
    provider_order_id   TEXT,
    provider_payment_id TEXT,
    amount_minor        BIGINT NOT NULL,
    currency            TEXT NOT NULL,
    tax_percent         NUMERIC(5,2) NOT NULL DEFAULT 0,
    region_code         TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'created',
    granted_at          TIMESTAMPTZ,
    reported_at         TIMESTAMPTZ,
    report_attempts     INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;
// One payment can only ever pay for one thing: the gateway's own payment id is unique here, so a
// replayed verify (a retried request, a double tap, a resent webhook) converges on the same row
// instead of granting a second period.
const INDEX_SQL = [
    `CREATE UNIQUE INDEX IF NOT EXISTS ucb_transactions_payment_key
       ON ucb_transactions (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ucb_transactions_unreported
       ON ucb_transactions (status) WHERE status = 'paid'`,
];

const PERIOD_DAYS = 30;
const REGION = 'IN';
const CURRENCY = 'INR';

function taxPercent() {
    const n = Number(process.env.UCB_TAX_PERCENT);
    return Number.isFinite(n) && n >= 0 ? n : 18;      // India, digital services. Owner-overridable.
}

/** Prices are NEVER invented here. UCB_PRICES_INR is {"starter":49900,...} in PAISE, and a plan
 *  missing from it simply cannot be bought this way. */
function priceTable() {
    try {
        const raw = JSON.parse(process.env.UCB_PRICES_INR || '{}');
        const out = {};
        for (const [k, v] of Object.entries(raw)) {
            const minor = Math.round(Number(v));
            if (ents.planByKey(k) && Number.isFinite(minor) && minor > 0) out[k] = minor;
        }
        return out;
    } catch { return {}; }
}

function providerName() {
    return (process.env.UCB_PROVIDER || 'razorpay').toLowerCase();
}

/** The gateway, behind one small interface so the day BillDesk replaces Razorpay is a new case here
 *  and nothing else. Each provider owns exactly two things: making an order, and proving a payment
 *  against it. */
const PROVIDERS = {
    razorpay: {
        ready() { return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET); },
        publicKey() { return process.env.RAZORPAY_KEY_ID || null; },
        async createOrder({ amountMinor, currency, receipt, notes }) {
            const Razorpay = require('razorpay');
            const rp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
            const order = await rp.orders.create({ amount: amountMinor, currency, receipt, notes, payment_capture: 1 });
            return { orderId: order.id };
        },
        // Razorpay signs order_id|payment_id with the key secret. Compared in constant time, because
        // a timing-leaky compare on a payment signature is how a forged "I paid" gets through.
        verify({ orderId, paymentId, signature }) {
            const expected = crypto
                .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
                .update(`${orderId}|${paymentId}`)
                .digest('hex');
            const a = Buffer.from(String(signature || ''), 'utf8');
            const b = Buffer.from(expected, 'utf8');
            return a.length === b.length && crypto.timingSafeEqual(a, b);
        },
    },
};

function provider() {
    return PROVIDERS[providerName()] || null;
}

/** Is this offer available at all — and if so, with what prices? One place, so the client, the order
 *  route and the tests cannot disagree about what is on. */
function config({ platform, country } = {}) {
    const prices = priceTable();
    const p = provider();
    const on = process.env.UCB_ENABLED === '1'
        && !!p && p.ready()
        && Object.keys(prices).length > 0
        && playExternal.isConfigured();
    const androidOk = !platform || String(platform).toLowerCase() === 'android';
    const indiaOk = !country || String(country).toUpperCase() === REGION;
    return {
        enabled: on && androidOk && indiaOk,
        // Why it is off, for the admin screen and the logs — never shown to a user as an excuse.
        reason: on ? (androidOk ? (indiaOk ? null : 'not_india') : 'not_android')
            : (process.env.UCB_ENABLED !== '1' ? 'switch_off'
                : !p || !p.ready() ? 'no_gateway'
                    : !Object.keys(prices).length ? 'no_prices' : 'no_play_credentials'),
        provider: providerName(),
        publicKey: on && p ? p.publicKey() : null,
        currency: CURRENCY,
        region: REGION,
        taxPercent: taxPercent(),
        periodDays: PERIOD_DAYS,
        prices: on ? prices : {},
    };
}

async function ensureTable() {
    await dbConfig.query(TABLE_SQL);
    for (const sql of INDEX_SQL) await dbConfig.query(sql);
}

/**
 * Step 1 — the user picked our payment method in Google's chooser and handed us its token.
 * Creates the gateway order and remembers the obligation BEFORE any money moves, so a payment can
 * never exist without a row that knows which user and plan it belongs to.
 */
async function createOrder({ userId, planKey, token, platform, country }) {
    const cfg = config({ platform, country });
    if (!cfg.enabled) return { ok: false, reason: cfg.reason || 'unavailable' };

    const plan = ents.planByKey(planKey);
    const amountMinor = cfg.prices[planKey];
    if (!plan || !amountMinor) return { ok: false, reason: 'unknown_plan' };
    if (!token || typeof token !== 'string') return { ok: false, reason: 'no_token' };

    const id = crypto.randomUUID();
    const p = provider();
    let orderId;
    try {
        const order = await p.createOrder({
            amountMinor,
            currency: CURRENCY,
            receipt: id,
            notes: { userId: String(userId), planKey, via: 'play_user_choice' },
        });
        orderId = order.orderId;
    } catch (e) {
        console.error('[ucb] gateway refused the order:', e && e.message);
        return { ok: false, reason: 'gateway_unavailable' };
    }

    await ensureTable();
    await dbConfig.query(
        `INSERT INTO ucb_transactions
           (id, user_id, plan_key, provider, external_token, provider_order_id,
            amount_minor, currency, tax_percent, region_code, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'created')`,
        [id, userId, planKey, cfg.provider, token, orderId, amountMinor, CURRENCY, cfg.taxPercent, REGION],
    );

    return {
        ok: true,
        transactionId: id,
        orderId,
        provider: cfg.provider,
        publicKey: cfg.publicKey,
        amountMinor,
        currency: CURRENCY,
        planKey,
        planLabel: plan.label,
    };
}

/**
 * Step 2 — the gateway says it took the money. Prove it, switch the plan on, then tell Google.
 * Replay-safe: the same payment id lands on the same row and grants nothing twice.
 */
async function settle({ userId, transactionId, paymentId, signature }) {
    await ensureTable();
    // ⚠️ dbConfig.query resolves to the ROWS themselves, not a pg result object.
    const row = await dbConfig.get(
        `SELECT * FROM ucb_transactions WHERE id = $1 AND user_id = $2`, [transactionId, userId],
    );
    if (!row) return { ok: false, reason: 'unknown_transaction' };
    if (row.status === 'reported' || row.granted_at) {
        return { ok: true, alreadyDone: true, planKey: row.plan_key };   // a retry of a settled payment
    }

    const p = PROVIDERS[row.provider];
    if (!p || !p.verify({ orderId: row.provider_order_id, paymentId, signature })) {
        await dbConfig.query(
            `UPDATE ucb_transactions SET status='failed', last_error=$2, updated_at=NOW() WHERE id=$1`,
            [row.id, 'signature did not verify'],
        );
        return { ok: false, reason: 'bad_signature' };
    }

    // Money is real from here on. Record it before anything that can fail.
    await dbConfig.query(
        `UPDATE ucb_transactions SET status='paid', provider_payment_id=$2, updated_at=NOW() WHERE id=$1`,
        [row.id, paymentId],
    );

    const now = new Date();
    const end = new Date(now.getTime() + PERIOD_DAYS * 24 * 60 * 60 * 1000);
    try {
        await ents.storeSetSubscription({
            userId,
            planKey: row.plan_key,
            source: 'play_user_choice',
            productId: `ucb.${row.plan_key}`,
            // The gateway's payment id is the transaction's identity, so a replay upserts the same
            // row instead of stacking a second period on the same money.
            originalTxnId: paymentId,
            latestTxnId: paymentId,
            environment: 'Production',
            periodStart: now,
            periodEnd: end,
            status: 'active',
            autoRenew: false,          // one payment, one period. Nothing renews itself.
            acknowledged: true,
        });
        await dbConfig.query(`UPDATE ucb_transactions SET granted_at=NOW(), updated_at=NOW() WHERE id=$1`, [row.id]);
    } catch (e) {
        await dbConfig.query(
            `UPDATE ucb_transactions SET last_error=$2, updated_at=NOW() WHERE id=$1`,
            [row.id, `grant failed: ${(e && e.message) || e}`.slice(0, 500)],
        );
        console.error(`❌ [ucb] PAID BUT NOT GRANTED — user ${userId}, payment ${paymentId}, txn ${row.id}: ${e && e.message}`);
        return { ok: false, reason: 'grant_failed', paid: true };
    }

    // The debt to Google. Never blocks the answer to the user.
    const report = await reportOne({ ...row, provider_payment_id: paymentId });

    return { ok: true, planKey: row.plan_key, periodEnd: end.toISOString(), reported: report.reported };
}

/** Report one row and record what happened. Never throws: the row is the memory. */
async function reportOne(row) {
    try {
        await playExternal.report({
            transactionId: row.id,
            token: row.external_token,
            grossMinor: Number(row.amount_minor),
            currency: row.currency,
            taxPercent: Number(row.tax_percent),
            regionCode: row.region_code,
            at: row.created_at || new Date(),
        });
        await dbConfig.query(
            `UPDATE ucb_transactions
                SET status='reported', reported_at=NOW(), last_error=NULL,
                    report_attempts = report_attempts + 1, updated_at=NOW()
              WHERE id=$1`, [row.id],
        );
        return { reported: true };
    } catch (e) {
        await dbConfig.query(
            `UPDATE ucb_transactions
                SET report_attempts = report_attempts + 1, last_error=$2, updated_at=NOW()
              WHERE id=$1`, [row.id, String((e && e.message) || e).slice(0, 500)],
        );
        // Loud, because the clock is 24 hours and nobody is watching this table.
        console.error(`⚠️ [ucb] payment ${row.id} is NOT reported to Google yet (${e && e.message}) — `
            + `attempt ${(Number(row.report_attempts) || 0) + 1}; retry with flushUnreported()`);
        return { reported: false, permanent: !!(e && e.permanent) };
    }
}

/** Retry everything paid-but-unreported. Called by an admin route; deliberately NOT on a timer —
 *  a scheduler that ships armed is how 25 unapproved pushes once went out. */
async function flushUnreported(limit = 50) {
    await ensureTable();
    const rows = await dbConfig.query(
        `SELECT * FROM ucb_transactions
          WHERE status = 'paid' AND external_token IS NOT NULL
          ORDER BY created_at LIMIT $1`, [limit],
    );
    const out = { tried: 0, reported: 0, failed: 0 };
    for (const row of rows || []) {
        out.tried += 1;
        const r = await reportOne(row);
        if (r.reported) out.reported += 1; else out.failed += 1;
    }
    return out;
}

module.exports = {
    config, createOrder, settle, flushUnreported, reportOne, ensureTable,
    TABLE_SQL, INDEX_SQL, PROVIDERS, priceTable, taxPercent, PERIOD_DAYS, REGION, CURRENCY,
};
