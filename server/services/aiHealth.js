// One place that knows what a Gemini failure actually MEANS, and makes sure an outage is loud.
//
// ⚠️ WHY THIS EXISTS — 2026-08-14. The production Gemini key ran out of prepaid credits. Every AI
// call started returning:
//
//     429 RESOURCE_EXHAUSTED — "Your prepayment credits are depleted."
//
// and NOTHING in the product said so. `extractFromText` swallowed the error and returned null, so
// /jobs/capture answered **HTTP 200** with its fallback shape — title "Job application", company =
// the domain, no skills, no responsibilities. Fetch job therefore appeared to succeed and quietly
// saved a junk job. Translation came back as a bare 502. The founder reported it as
// "translate and fetch job stopped working", and it took a live probe of Google's API to find that
// the cause was billing, not code.
//
// Two rules follow, and they are what this module enforces:
//   1. A provider outage must NEVER be dressed up as a successful result. Callers get a typed
//      reason and can fail honestly.
//   2. An outage must page the operator on its own, not wait for a user to notice.
'use strict';

// Message shapes Google actually returns. Matched on the message text because the SDK wraps the
// HTTP status inconsistently across versions — the text has been stable.
const QUOTA_RE = /RESOURCE_EXHAUSTED|prepayment credits are depleted|exceeded your current quota|billing|quota/i;
const AUTH_RE = /API[_ ]KEY[_ ]INVALID|API key not valid|PERMISSION_DENIED|UNAUTHENTICATED|401|403/i;
const GONE_RE = /is no longer available|not found for API version|models\/[a-z0-9.-]+ is not found/i;
const TRANSIENT_RE = /\b50[0234]\b|overload|unavailable|high demand|temporarily|timeout|deadline|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i;

/**
 * 'quota'     — out of credit / over the rate limit. The operator must act; retrying will not help.
 * 'auth'      — the key is wrong, revoked or lacks permission. Also operator-only.
 * 'gone'      — the model id we asked for no longer exists. A code/env fix.
 * 'transient' — overloaded or a network blip. Retrying is reasonable.
 * 'other'     — anything else (a bad prompt, malformed JSON, …).
 */
function classifyAiError(err) {
    const msg = String((err && (err.message || err.toString())) || '');
    if (!msg) return 'other';
    if (QUOTA_RE.test(msg)) return 'quota';
    if (GONE_RE.test(msg)) return 'gone';
    if (AUTH_RE.test(msg)) return 'auth';
    if (TRANSIENT_RE.test(msg)) return 'transient';
    return 'other';
}

/** Is this a failure the operator has to fix (as opposed to one worth retrying)? */
const isOutage = (kind) => kind === 'quota' || kind === 'auth' || kind === 'gone';

// ── Alerting ────────────────────────────────────────────────────────────────────────────────────
// Throttled hard: an outage means EVERY call fails, so an unthrottled alert would be a push storm
// on top of a broken product. One alert per kind per window, process-local — good enough, because
// the point is "tell me once", and a restart re-alerting is the correct behaviour anyway.
const ALERT_WINDOW_MS = 6 * 60 * 60 * 1000;
const _lastAlert = new Map();

const HUMAN = {
    quota: 'AI credits are exhausted — top up at https://ai.studio/projects. Fetch job, translate, cover letters and AI search are all down until then.',
    auth: 'The AI API key is being rejected. Check GEMINI_API_KEY on the server.',
    gone: 'The AI model we call no longer exists. Update the model id.',
};

/**
 * Record an AI failure. Best-effort and NEVER throws — an alert must not be able to break the
 * request that was already failing.
 */
function noteAiFailure(err, where) {
    const kind = classifyAiError(err);
    try {
        const msg = String((err && err.message) || err || '').slice(0, 300);
        if (isOutage(kind)) console.error(`[aiHealth] ${kind.toUpperCase()} at ${where}: ${msg}`);
        else console.warn(`[aiHealth] ${kind} at ${where}: ${msg}`);
        if (!isOutage(kind)) return kind;

        const now = Date.now();
        if ((now - (_lastAlert.get(kind) || 0)) < ALERT_WINDOW_MS) return kind;
        _lastAlert.set(kind, now);

        // Required lazily: adminNotifier pulls in the push service and the DB, and this module is
        // imported by request handlers that must stay cheap.
        // eslint-disable-next-line global-require
        const admin = require('./adminNotifier');
        if (admin && typeof admin.notifyAdmins === 'function') {
            // category=null deliberately: this is an operational alarm, not one of the toggleable
            // growth notifications, and it must not be silenceable by an unrelated switch.
            Promise.resolve(admin.notifyAdmins(
                null,
                'AI service is down',
                HUMAN[kind] || `AI failure (${kind}) at ${where}`,
                { type: 'ai_outage', kind, where },
            )).catch(() => {});
        }
    } catch { /* never throw */ }
    return kind;
}

/** The response a route should send when the provider is unavailable. */
function outageResponse(res, kind, what) {
    return res.status(503).json({
        error: 'ai_unavailable',
        kind,
        // Shown to the user, so it says what happened and what they can do — never a raw provider string.
        message: kind === 'quota'
            ? `${what} is temporarily unavailable — our AI service has hit its limit. Please try again later.`
            : `${what} is temporarily unavailable. Please try again in a few minutes.`,
        retryable: kind === 'transient',
    });
}

module.exports = { classifyAiError, isOutage, noteAiFailure, outageResponse };
