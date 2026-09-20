// WHAT A CONNECTED MAILBOX IS ACTUALLY ALLOWED TO DO, AND WHICH OAUTH CLIENT OWNS ITS REFRESH TOKEN (2026-09-20).
//
// THE OWNER'S ISSUE (build 210, user 618): "I logged in with gmail account successfully and then when i clicked send
// then it showed me an error.. that reconnect gmail which looks incorrect to me.... After reconnecting it worked...
// please make it work for the first time without any need of connecting account again..."
//
// Two separate defects put him in that loop, and this module is the shared, pure half of both fixes:
//
//   A. THE REFRESH WENT TO THE WRONG CLIENT. emailController.createOAuth2Client always built the OAuth2 client with the
//      WEB client id + secret and called setCredentials WITHOUT an expiry_date. google-auth-library 9.15.1 treats
//      "access_token + refresh_token + no expiry_date" as `mayRequireRefresh`
//      (node_modules/google-auth-library/build/src/auth/oauth2client.js:456-472), so ANY 401/403 answer from Gmail was
//      silently retried through refreshAccessTokenAsync() — POSTing an iOS-minted refresh token with the WEB client.
//      Google answers 401 `unauthorized_client`, that replaced the real Gmail error, and classifyMailError read 401 →
//      'reconnect'. Prod log 2026-09-20 10:53:48 UTC: "google refused (reconnect 401): unauthorized_client", twice,
//      for a token that had not expired. So the page could only ever offer the one action that cannot help.
//
//   B. A CONNECTION WAS RECORDED AS SEND-READY WITHOUT EVER CHECKING THE GRANT. Google's granular-consent screen shows
//      "Send email on your behalf" as a checkbox that is UNCHECKED by default, and Google still returns an access token
//      AND a refresh token when the user leaves it unticked. Nothing read `tokenData.scope` and no column stored it, so
//      an account that could only sign in was stored as a mailbox — and the refusal could only surface after the user
//      had written a whole message and tapped Send.
//
// ⚠️ NULL / EMPTY SCOPES MEAN "UNKNOWN", NOT "CANNOT SEND". Every Google account connected before this shipped (366 of
// them in production on 2026-09-20) has no recorded scope string. canSendWith() answers true for those, so the change
// cannot disconnect anyone; they self-correct on their next connect, and an actual refusal is still reported honestly
// by the send path.
// ⚠️ NOTHING HERE TOUCHES A TOKEN. Client IDs are public identifiers (they ship inside the app bundle); refresh tokens,
// access tokens and client secrets never enter this module's arguments, returns or logs.
'use strict';

/** The grant Gmail's users.messages.send needs. */
const GOOGLE_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
/** The grant Microsoft Graph's /me/sendMail needs. */
const MS_SEND_SCOPE = 'mail.send';

/**
 * Grants that ALSO allow sending, so a user who gave us more than we asked for is never told they gave us less.
 * (mail.google.com is Gmail's full-access scope; gmail.compose and gmail.modify both include send.)
 */
const GOOGLE_SEND_OK = Object.freeze([
    GOOGLE_SEND_SCOPE,
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify',
]);
const MS_SEND_OK = Object.freeze([MS_SEND_SCOPE, 'https://graph.microsoft.com/mail.send']);

/** The stored scope string is bounded — it is a record, not a payload. */
const SCOPES_MAX = 600;

/** "a b,c" | ['a','b'] | anything else → ['a','b','c'] | []. */
function parseScopes(raw) {
    const text = Array.isArray(raw) ? raw.join(' ') : raw;
    if (typeof text !== 'string') return [];
    return text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/** What goes in the column: de-duplicated, space-joined, bounded — or null when the provider told us nothing. */
function scopeString(raw) {
    const seen = new Set();
    const out = [];
    for (const s of parseScopes(raw)) {
        const k = s.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(s);
    }
    if (!out.length) return null;
    const joined = out.join(' ');
    return joined.length > SCOPES_MAX ? joined.slice(0, SCOPES_MAX) : joined;
}

/**
 * Is `wanted` among `scopes`? Compared case-insensitively and by LAST PATH SEGMENT as well as in full, because the two
 * providers spell the same grant differently: Google returns the full URL, Microsoft returns either "Mail.Send" or
 * "https://graph.microsoft.com/Mail.Send" depending on the account type.
 */
function hasScope(scopes, wanted) {
    const w = String(wanted || '').toLowerCase().replace(/\/+$/, '');
    if (!w) return false;
    const wShort = w.split('/').filter(Boolean).pop();
    return parseScopes(scopes).some((s) => {
        const v = s.toLowerCase().replace(/\/+$/, '');
        return v === w || (!!wShort && v.split('/').filter(Boolean).pop() === wShort);
    });
}

/**
 * May this provider send mail with the grant we recorded?
 * ⚠️ NO RECORDED GRANT → true. See the header: unknown is not a refusal, and every account connected before this
 * shipped is unknown. A recorded grant that lacks send is the only thing that answers false.
 */
function canSendWith(provider, scopes) {
    const list = parseScopes(scopes);
    if (!list.length) return true;
    const wanted = provider === 'microsoft' ? MS_SEND_OK : GOOGLE_SEND_OK;
    return wanted.some((w) => hasScope(list, w));
}

/** Did we actually LEARN the grant for this connection (as opposed to inheriting an older row)? */
function scopesKnown(scopes) {
    return parseScopes(scopes).length > 0;
}

/* ── WHICH OAUTH CLIENT OWNS A REFRESH TOKEN ─────────────────────────────────────────────────────── */

const webIdOf = (env) => env.GOOGLE_WEB_CLIENT_ID || env.GOOGLE_CLIENT_ID || null;
const webSecretOf = (env) => env.GOOGLE_WEB_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || null;

/** A client id → which of our clients it is, for logs and diagnostics only. */
function labelOfClient(clientId, env = process.env) {
    if (!clientId) return null;
    if (clientId === env.GOOGLE_IOS_CLIENT_ID) return 'iOS';
    if (clientId === env.GOOGLE_ANDROID_CLIENT_ID) return 'Android';
    if (clientId === webIdOf(env)) return 'Web';
    return 'recorded';
}

/**
 * The client that MINTED this user's refresh token, as { clientId, clientSecret, label } — or null when we have no
 * client at all. `users.google_token_client` holds the exact client id the token exchange used (written at connect
 * time), which is why this works even for a client that has no environment variable of its own: an Android build's
 * client id is a public string, and a native client needs no secret to refresh.
 * ⚠️ THE SECRET RIDES ALONG ONLY FOR THE WEB CLIENT. Sending one with a native client id is what Google answers
 * `unauthorized_client` to — the very error the owner saw reported as "sign in again".
 */
function clientForRefresh(user, env = process.env) {
    const stored = user && typeof user.google_token_client === 'string' ? user.google_token_client.trim() : '';
    if (stored) {
        const isWeb = stored === webIdOf(env);
        return { clientId: stored, clientSecret: isWeb ? webSecretOf(env) || undefined : undefined, label: labelOfClient(stored, env) };
    }
    const webId = webIdOf(env);
    if (!webId) return null;
    // Unknown (connected before this shipped) → today's behaviour, the web pair. It is only a FIRST guess now:
    // refreshOrder still walks every configured client after it, and the send path no longer lets the library retry
    // blindly, so a wrong guess costs one failed POST instead of a wrong message to the user.
    return { clientId: webId, clientSecret: webSecretOf(env) || undefined, label: 'Web' };
}

/**
 * Every client worth trying for this user's refresh token, best first: the one recorded on the row, then iOS, Web and
 * Android exactly as emailController.refreshGoogleToken has always tried them. De-duplicated by client id.
 */
function refreshOrder(user, env = process.env) {
    const out = [];
    const seen = new Set();
    const add = (c) => { if (c && c.clientId && !seen.has(c.clientId)) { seen.add(c.clientId); out.push(c); } };
    const stored = user && typeof user.google_token_client === 'string' ? user.google_token_client.trim() : '';
    if (stored) add(clientForRefresh(user, env));
    if (env.GOOGLE_IOS_CLIENT_ID) add({ clientId: env.GOOGLE_IOS_CLIENT_ID, clientSecret: undefined, label: 'iOS' });
    const webId = webIdOf(env);
    const webSecret = webSecretOf(env);
    if (webId && webSecret) add({ clientId: webId, clientSecret: webSecret, label: 'Web' });
    if (env.GOOGLE_ANDROID_CLIENT_ID) add({ clientId: env.GOOGLE_ANDROID_CLIENT_ID, clientSecret: undefined, label: 'Android' });
    return out;
}

/* ── WHAT THE USER IS TOLD ───────────────────────────────────────────────────────────────────────── */

const PROVIDER_NAME = Object.freeze({ google: 'Gmail', microsoft: 'Outlook' });

/**
 * The one honest line for a connection that signed in but may not send, with the one action that fixes it. Said at
 * CONNECT time (authController link flows) and shown on the Send page's mailbox card — never after a message has been
 * written and the recruiter's address typed.
 */
function sendPermissionMessage(provider, reason, address) {
    const who = PROVIDER_NAME[provider] || 'Your mail account';
    const at = address ? ` (${address})` : '';
    if (reason === 'no_refresh') {
        return `${who}${at} is connected, but it did not give us a lasting permission — sending would stop working within the hour. Connect again and stay signed in.`;
    }
    return provider === 'microsoft'
        ? `${who}${at} is connected, but it did not allow CVApplyr to send mail. Connect again and accept the "Send mail as you" permission.`
        : `${who}${at} is connected, but you did not allow CVApplyr to send mail. Connect again and tick “Send email on your behalf”.`;
}

/* ── WHERE THE GRANT IS RECORDED ─────────────────────────────────────────────────────────────────── */

/**
 * Migration 050's columns, defined HERE so db-init and the lazy ensure below can never disagree (the pattern of
 * Migrations 048/049, whose tables live in the service that uses them).
 *   google_granted_scopes    what Google's token response said we were actually given (NULL = connected before this)
 *   google_token_client      the exact OAuth client id that minted the refresh token — a public identifier
 *   microsoft_granted_scopes the same for Microsoft
 */
const COLUMNS_SQL = Object.freeze([
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_granted_scopes TEXT DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_token_client TEXT DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_granted_scopes TEXT DEFAULT NULL`,
]);

let ensured = null;
/** Add the columns if a deploy is serving before the migration ran (db-init races app.listen). Once per process. */
async function ensureColumns(db) {
    if (!ensured) {
        ensured = (async () => {
            for (const sql of COLUMNS_SQL) {
                try { await db.run(sql); } catch (e) { if (!/already exists/i.test(e && e.message)) console.warn('mailScopes column:', e && e.message); }
            }
        })().catch(() => { /* the next write just fails best-effort below */ });
    }
    return ensured;
}

/**
 * Record what a connection was actually granted — ⚠️ ALWAYS AS ITS OWN BEST-EFFORT UPDATE, never folded into the
 * statement that writes the tokens. A column this deploy has not created yet would otherwise take sign-in down with
 * it; a grant we failed to record only means canSendWith() reads "unknown", which is exactly how every older row
 * already behaves. Returns true when the row was written.
 */
async function recordGrant(db, userId, patch) {
    const sets = [];
    const params = [];
    if ('googleScopes' in patch) { sets.push('google_granted_scopes = ?'); params.push(scopeString(patch.googleScopes)); }
    if ('googleClient' in patch) { sets.push('google_token_client = ?'); params.push(patch.googleClient || null); }
    if ('microsoftScopes' in patch) { sets.push('microsoft_granted_scopes = ?'); params.push(scopeString(patch.microsoftScopes)); }
    if (!sets.length || !userId) return false;
    try {
        await ensureColumns(db);
        await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, userId]);
        return true;
    } catch (e) {
        console.warn('mailScopes.recordGrant skipped:', e && e.message);
        return false;
    }
}

module.exports = {
    GOOGLE_SEND_SCOPE,
    MS_SEND_SCOPE,
    GOOGLE_SEND_OK,
    MS_SEND_OK,
    SCOPES_MAX,
    parseScopes,
    scopeString,
    hasScope,
    canSendWith,
    scopesKnown,
    labelOfClient,
    clientForRefresh,
    refreshOrder,
    sendPermissionMessage,
    COLUMNS_SQL,
    ensureColumns,
    recordGrant,
};
