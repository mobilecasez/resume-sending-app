// REPORTING A PAYMENT WE TOOK OURSELVES TO GOOGLE PLAY.
//
// User choice billing (India, after the CCI order) lets a Play-distributed app offer its own
// payment method beside Google Play's. The price of that permission is this file: EVERY transaction
// taken outside Play must be reported to Google within 24 HOURS through androidpublisher's
// externalTransactions API, and Google bills its (reduced) service fee off these reports. A payment
// we take and never report is a policy breach, not a missing analytics row — so the caller stores
// the obligation first and this module is allowed to fail.
//
// ⚠️ THE REPORT IS NOT WHAT ENTITLES THE USER. They paid; their plan switches on regardless of
// whether Google is reachable. Reporting is our debt to Google, retried until it lands
// (userChoiceBilling.flushUnreported), never a gate in front of the thing the user bought.
//
// Field names are the CREATE shape, which is not the read shape: originalPreTaxAmount /
// originalTaxAmount (a read answers currentPreTaxAmount too), the id rides as a QUERY parameter,
// and the token comes from Google's own chooser — we never mint it.
// https://developers.google.com/android-publisher/api-ref/rest/v3/externaltransactions/createexternaltransaction
const playApi = require('./playStoreApi');

const PACKAGE = process.env.ANDROID_PACKAGE || 'com.cvapplyr.mobile';

// Google's own constraint on the id, asserted here rather than discovered in a 400: 1-63 characters
// of [a-zA-Z0-9_-]. Our ids are uuids with the dashes kept, which fits.
const ID_RE = /^[a-zA-Z0-9_-]{1,63}$/;

/** Split a gross, tax-inclusive amount into the pre-tax and tax halves Google asks for.
 *  Minor units in, micros out — and the two halves always add back up to the gross, because a
 *  rounding gap here is a rupee that exists on the invoice and not in the report. */
function splitTax(grossMinor, taxPercent) {
    const gross = Math.round(Number(grossMinor) || 0);
    const pct = Number(taxPercent);
    const rate = Number.isFinite(pct) && pct > 0 ? pct : 0;
    const preTax = Math.round(gross / (1 + rate / 100));
    return { preTaxMinor: preTax, taxMinor: gross - preTax };
}

const micros = (minor) => String(Math.round(Number(minor) || 0) * 10000); // 1 minor unit = 10,000 micros

function isConfigured() {
    return playApi.isConfigured();
}

/**
 * Report one payment. Resolves { reported: true } when Google has it — INCLUDING when Google says it
 * already has it, because a duplicate id means an earlier attempt landed and a retry must converge
 * rather than pile up. Throws otherwise, so the caller can keep the obligation and try again later.
 *
 * @param {object} p
 * @param {string} p.transactionId   our id, also the externalTransactionId (unique per app, forever)
 * @param {string} p.token           externalTransactionToken from Google's chooser
 * @param {number} p.grossMinor      what we actually charged, in minor units (paise), tax included
 * @param {string} p.currency        ISO-4217, e.g. 'INR'
 * @param {number} p.taxPercent      the tax already inside grossMinor
 * @param {string} p.regionCode      the user's tax region, e.g. 'IN'
 * @param {string|Date} p.at         when the payment happened
 */
async function report({ transactionId, token, grossMinor, currency, taxPercent, regionCode, at }) {
    if (!ID_RE.test(String(transactionId || ''))) {
        throw new Error(`external transaction id "${transactionId}" is not 1-63 chars of [a-zA-Z0-9_-]`);
    }
    if (!token) throw new Error('no externalTransactionToken — Google mints it in the chooser, we cannot');
    if (!isConfigured()) throw new Error('no Google Play service account configured (GOOGLE_PLAY_SA_JSON / GOOGLE_PLAY_SA_B64)');

    const { preTaxMinor, taxMinor } = splitTax(grossMinor, taxPercent);
    const when = (at instanceof Date ? at : new Date(at || Date.now())).toISOString();

    const ap = await playApi.androidPublisher();
    try {
        const res = await ap.externaltransactions.createexternaltransaction({
            parent: `applications/${PACKAGE}`,
            externalTransactionId: String(transactionId),
            requestBody: {
                originalPreTaxAmount: { currency, priceMicros: micros(preTaxMinor) },
                originalTaxAmount: { currency, priceMicros: micros(taxMinor) },
                transactionTime: when,
                userTaxAddress: { regionCode },
                // One-time, deliberately: a user choice purchase here buys a fixed period and does
                // NOT auto-renew, so there is no recurring mandate to describe. The day that
                // changes this becomes recurringTransaction + externalSubscription.
                oneTimeTransaction: { externalTransactionToken: token },
            },
        });
        return { reported: true, id: (res && res.data && res.data.externalTransactionId) || String(transactionId) };
    } catch (e) {
        const status = e && (e.code || e.status || (e.response && e.response.status));
        const text = String((e && e.message) || '');
        // Already reported: the id is unique per app, so this is our own earlier attempt coming back.
        if (status === 409 || /already exists|duplicate/i.test(text)) {
            return { reported: true, id: String(transactionId), alreadyKnown: true };
        }
        const err = new Error(`Play externalTransactions refused (${status || 'no status'}): ${text.slice(0, 300)}`);
        err.status = status;
        // A 400 will not fix itself on a retry — the caller should stop and page a human instead of
        // burning the 24-hour window on the same malformed body.
        err.permanent = status === 400 || status === 403 || status === 404;
        throw err;
    }
}

module.exports = { report, splitTax, isConfigured, ID_RE, PACKAGE };
