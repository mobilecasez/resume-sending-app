// BILLDESK — one-time payments, JWS-HMAC ("HS256") integration.
//
// Written against BillDesk's own public reference (docs.billdesk.io, read 2026-09-21):
//   • Create Order   POST {base}/payments/ve1_2/orders/create        (reference/createorder)
//   • Retrieve Txn   POST {base}/payments/ve1_2/transactions/get     (reference/post-payments-v1_2-transactions-get)
//   • Hosted page    POST the create-order response's rel:"redirect" link with merchantid, bdorderid, rdata
//                    (docs/neo-full-redirect); BillDesk posts `transaction_response` (a JWS) back to `ru`
//   • base           UAT https://uat1.billdesk.com/u2 · production https://api.billdesk.com
//   • signing        JWS compact serialisation, header { alg: "HS256", clientid, [kid] }, HMAC with the secret
//                    BillDesk issues; BillDesk signs its answers the same way (reference/authentications-and-endpoints)
//   • headers        BD-Traceid (≤35 alphanumeric, unique per day — idempotency), BD-Timestamp (YYYYMMDDhhmmss)
//
// ⚠️ NOTHING HERE TRUSTS AN UNSIGNED ANSWER. A success that does not verify with OUR secret is not a success —
// the return URL is public, and "auth_status 0300" in an unsigned body is something anyone can POST.
// ⚠️ alg is pinned to HS256 on verify. Accepting the header's own alg is the textbook JWS bypass ("none").
// ⚠️ Two spec points differ between BillDesk's pages and must be confirmed in UAT, not assumed: BD-Timestamp
// is YYYYMMDDhhmmss on the API reference and "epoch" on the auth page (the reference is followed), and whether
// the account needs a `kid` in the header (set BILLDESK_KEY_ID when the integration kit names one).
'use strict';
const crypto = require('crypto');

const BASE = Object.freeze({ uat: 'https://uat1.billdesk.com/u2', prod: 'https://api.billdesk.com' });
const PATHS = Object.freeze({
    createOrder: '/payments/ve1_2/orders/create',
    retrieve: '/payments/ve1_2/transactions/get',
});
const INR = '356';                           // ISO 4217 numeric, as BillDesk wants it

function cfg() {
    return {
        mercid: process.env.BILLDESK_MERCHANT_ID || '',
        clientid: process.env.BILLDESK_CLIENT_ID || '',
        secret: process.env.BILLDESK_SECRET || '',
        kid: process.env.BILLDESK_KEY_ID || '',
        // UAT unless production is asked for BY NAME — a typo must never point test traffic at real money.
        env: String(process.env.BILLDESK_ENV || 'uat').toLowerCase() === 'prod' ? 'prod' : 'uat',
        itemcode: process.env.BILLDESK_ITEMCODE || 'DIRECT',
    };
}

function ready() {
    const c = cfg();
    return !!(c.mercid && c.clientid && c.secret);
}

// ── JWS (HS256), by hand: four lines of crypto are safer than a dependency whose defaults we would have to audit ──
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function jwsSign(payload, c = cfg()) {
    const header = { alg: 'HS256', clientid: c.clientid };
    if (c.kid) header.kid = c.kid;
    const h = b64u(JSON.stringify(header));
    const p = b64u(JSON.stringify(payload));
    const sig = b64u(crypto.createHmac('sha256', c.secret).update(`${h}.${p}`).digest());
    return `${h}.${p}.${sig}`;
}

function jwsVerify(token, c = cfg()) {
    const parts = String(token || '').trim().split('.');
    if (parts.length !== 3 || !parts[2]) return { ok: false, reason: 'malformed' };
    let header;
    try { header = JSON.parse(fromB64u(parts[0]).toString('utf8')); } catch { return { ok: false, reason: 'bad_header' }; }
    if (!header || header.alg !== 'HS256') return { ok: false, reason: 'bad_alg' };
    if (!c.secret) return { ok: false, reason: 'no_secret' };
    const expected = crypto.createHmac('sha256', c.secret).update(`${parts[0]}.${parts[1]}`).digest();
    const got = fromB64u(parts[2]);
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return { ok: false, reason: 'bad_signature' };
    try {
        return { ok: true, header, payload: JSON.parse(fromB64u(parts[1]).toString('utf8')) };
    } catch { return { ok: false, reason: 'bad_payload' }; }
}

// ── time, in the form BillDesk writes it (IST) ───────────────────────────────────────────────────────
function ist(d = new Date()) {
    const t = new Date(d.getTime() + 330 * 60 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return {
        Y: String(t.getUTCFullYear()), M: p(t.getUTCMonth() + 1), D: p(t.getUTCDate()),
        h: p(t.getUTCHours()), m: p(t.getUTCMinutes()), s: p(t.getUTCSeconds()),
    };
}
const bdTimestamp = (d) => { const x = ist(d); return `${x.Y}${x.M}${x.D}${x.h}${x.m}${x.s}`; };
const orderDate = (d) => { const x = ist(d); return `${x.Y}-${x.M}-${x.D}T${x.h}:${x.m}:${x.s}+05:30`; };
// ≤35 characters, alphanumeric only, unique: 32 hex characters.
const traceId = () => crypto.randomBytes(16).toString('hex');

/** BillDesk's orderid for one of our transactions: the uuid without its dashes (32 alphanumerics). */
const orderIdFor = (txnId) => String(txnId).replace(/-/g, '');
/** …and back: rebuild the uuid so the row can be found. */
function txnIdFromOrderId(orderid) {
    const s = String(orderid || '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(s)) return null;
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// The network, swappable for the test suite. Never logs a body: it carries the customer's payment state.
let fetchImpl = (...a) => globalThis.fetch(...a);
function _setFetch(f) { fetchImpl = f; }

async function call(path, payload) {
    const c = cfg();
    const res = await fetchImpl(BASE[c.env] + path, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/jose',
            Accept: 'application/jose',
            'BD-Traceid': traceId(),
            'BD-Timestamp': bdTimestamp(),
        },
        body: jwsSign(payload, c),
    });
    const text = await res.text();
    const v = jwsVerify(text, c);
    if (res.ok && v.ok) return v.payload;
    // An error may come back signed or as plain JSON; either way it is reported, never acted on.
    let body = v.ok ? v.payload : null;
    if (!body) { try { body = JSON.parse(text); } catch { body = null; } }
    const why = (body && (body.message || body.error_code)) || (res.ok ? `unsigned answer (${v.reason})` : `HTTP ${res.status}`);
    const e = new Error(`BillDesk ${path} refused: ${String(why).slice(0, 200)}`);
    e.status = res.status;
    e.code = body && body.error_code;
    throw e;
}

/**
 * Create the order and return what the hosted page needs.
 * @returns {{ bdorderid: string, launch: { href: string, merchantid: string, bdorderid: string, rdata: string } }}
 */
async function createOrder({ orderid, amountMinor, ru, additionalInfo, device }) {
    const c = cfg();
    const body = {
        mercid: c.mercid,
        orderid,
        amount: (Math.round(Number(amountMinor)) / 100).toFixed(2),
        order_date: orderDate(),
        currency: INR,
        ru,
        itemcode: c.itemcode,
    };
    if (additionalInfo && Object.keys(additionalInfo).length) body.additional_info = additionalInfo;
    if (device) body.device = device;
    const r = await call(PATHS.createOrder, body);
    const redirect = (r.links || []).find((l) => l && l.rel === 'redirect');
    const params = redirect && redirect.parameters;
    if (!r.bdorderid || !redirect || !redirect.href || !params || !params.rdata) {
        throw new Error('BillDesk order came back without a redirect link');
    }
    return {
        bdorderid: r.bdorderid,
        launch: {
            href: redirect.href,
            merchantid: params.mercid || c.mercid,
            bdorderid: params.bdorderid || r.bdorderid,
            rdata: params.rdata,
        },
    };
}

/** Ask BillDesk what happened to an order — the answer for a user who closed the page before it returned. */
async function retrieveTransaction(orderid) {
    const c = cfg();
    return call(PATHS.retrieve, { mercid: c.mercid, orderid });
}

/** What a verified transaction payload means for us. Anything that is not an explicit success is not paid. */
function outcomeOf(payload) {
    const s = String((payload && payload.auth_status) || '');
    if (s === '0300') return 'paid';
    if (s === '0002') return 'pending';
    return 'failed';
}

/** The hosted page, launched by an auto-submitting form (the documented full-redirect flow). Every value is
 *  attribute-escaped: rdata is BillDesk's, but nothing reaches HTML unescaped on principle. */
function launchHtml(launch) {
    const esc = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Secure payment — BillDesk</title></head>
<body style="font-family:-apple-system,system-ui,sans-serif;text-align:center;padding:48px 24px;color:#0B0F22">
<p>Opening BillDesk's secure payment page…</p>
<form id="bd" method="POST" action="${esc(launch.href)}">
<input type="hidden" name="merchantid" value="${esc(launch.merchantid)}">
<input type="hidden" name="bdorderid" value="${esc(launch.bdorderid)}">
<input type="hidden" name="rdata" value="${esc(launch.rdata)}">
<noscript><button type="submit">Continue to payment</button></noscript>
</form>
<script>document.getElementById('bd').submit();</script>
</body></html>`;
}

module.exports = {
    cfg, ready, jwsSign, jwsVerify, createOrder, retrieveTransaction, outcomeOf, launchHtml,
    orderIdFor, txnIdFromOrderId, bdTimestamp, orderDate, traceId, BASE, PATHS, INR, _setFetch,
};
