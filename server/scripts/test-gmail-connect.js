// CONNECTING GMAIL / OUTLOOK, AND WHAT THAT CONNECTION MAY ACTUALLY DO (2026-09-20).
//   node server/scripts/test-gmail-connect.js
//
// THE OWNER'S ISSUE, build 210, user 618: "I logged in with gmail account successfully and then when i clicked send
// then it showed me an error.. that reconnect gmail which looks incorrect to me.... After reconnecting it worked...
// please make it work for the first time without any need of connecting account again."
//
// Two defects put him in that loop, and every scenario here is one of them, reverted:
//   A. THE REFRESH WENT TO THE WRONG CLIENT. createOAuth2Client hard-coded the WEB client and set no expiry_date, so
//      google-auth-library retried every Gmail 401/403 by refreshing an iOS-minted refresh token with the WEB client
//      (oauth2client.js:456-472). Google answered `unauthorized_client`, THAT replaced the real Gmail error, and the
//      user was told to sign in again. Prod, 10:53:48 UTC: "google refused (reconnect 401): unauthorized_client".
//   B. A CONNECTION WAS RECORDED AS SEND-READY WITHOUT CHECKING THE GRANT. Google's granular consent returns an access
//      token AND a refresh token with "Send email on your behalf" left unticked, and nothing read `tokenData.scope`.
//
// No database, no network, no mailbox: db-config, googleapis and global fetch are all swapped through require.cache /
// globalThis, and no real token or client secret exists anywhere in this file.
// ⚠️ NO TOKEN IS EVER PRINTED. The fixtures are obvious fakes and the assertions compare shapes, never values.
'use strict';
const path = require('path');
const fs = require('fs');
const CryptoJS = require('crypto-js');

const ROOT = path.join(__dirname, '..', '..');
const R = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 400) : '')); } };

/* ── the world ──────────────────────────────────────────────────────────────────────────────────── */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-0123456789';
process.env.GOOGLE_IOS_CLIENT_ID = 'ios-client.apps.googleusercontent.com';
process.env.GOOGLE_WEB_CLIENT_ID = 'web-client.apps.googleusercontent.com';
process.env.GOOGLE_WEB_CLIENT_SECRET = 'web-secret-not-real';
process.env.GOOGLE_CLIENT_ID = 'web-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'web-secret-not-real';
delete process.env.GOOGLE_ANDROID_CLIENT_ID;   // exactly as production is configured (2026-09-20)
process.env.MICROSOFT_CLIENT_ID = 'ms-client';

const enc = (t) => (t ? CryptoJS.AES.encrypt(t, process.env.ENCRYPTION_KEY).toString() : null);

const stub = (rel, exportsObj) => {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return exportsObj;
};
const stubModule = (name, exportsObj) => {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return exportsObj;
};

const db = { users: {}, audit: [], runs: [] };
stub('db-config.js', {
  get: async (sql, params = []) => {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/FROM users WHERE id/.test(q)) return db.users[params[0]] || null;
    if (/FROM users WHERE email/.test(q)) return Object.values(db.users).find((u) => u.email === params[0]) || null;
    return null;
  },
  query: async () => [],
  run: async (sql, params = []) => {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    db.runs.push({ sql: q, params });
    if (/^INSERT INTO security_audit_log/i.test(q)) { db.audit.push({ userId: params[0], event: params[1], details: JSON.parse(params[5] || '{}') }); return { changes: 1 }; }
    // A crude but faithful UPDATE users SET a = ?, b = NULL WHERE id = ?
    const m = /^UPDATE users SET (.+) WHERE id = \?$/i.exec(q);
    if (m) {
      const row = db.users[params[params.length - 1]];
      if (row) {
        let i = 0;
        for (const piece of m[1].split(',').map((s) => s.trim())) {
          const [col, val] = piece.split('=').map((s) => s.trim());
          row[col] = val === 'NULL' ? null : val === 'CURRENT_TIMESTAMP' ? new Date().toISOString() : params[i++];
        }
      }
      return { changes: 1 };
    }
    return { changes: 1 };
  },
});
stub('server/services/liveAnalytics.js', { track: async () => {}, trackAuth: async () => {} });

/* googleapis: a fake OAuth2 client that records what it was built with, and a gmail send we drive. */
const oauthBuilds = [];        // { clientId, clientSecret, credentials }
const gmailSends = [];         // one per users.messages.send call
const gmail = { plan: [] };    // what each send does, in order: 'ok' | an Error
stubModule('googleapis', {
  google: {
    auth: {
      OAuth2: class {
        constructor(clientId, clientSecret) {
          this.clientId = clientId; this.clientSecret = clientSecret; this.credentials = {};
          this._build = { clientId, clientSecret, credentials: null };
          oauthBuilds.push(this._build);
        }
        setCredentials(c) { this.credentials = c; this._build.credentials = c; }
        on() { /* the 'tokens' listener — nothing mints a token in these scenarios */ }
        async refreshAccessToken() {
          // This is the LIBRARY's refresh, reached only through refreshGoogleToken here.
          if (this.clientId === refreshWorks.clientId) return { credentials: { access_token: 'ya29.fresh-fake' } };
          const e = new Error(refreshWorks.error || 'unauthorized_client');
          e.status = 401;
          throw e;
        }
      },
    },
    gmail: (opts) => {
      const auth = opts && opts.auth;
      // ⚠️ THE LIBRARY REFRESHES BEFORE IT ISSUES THE REQUEST, modelled because that is the whole trap: a stated
      // expiry already inside its 5-minute eager window makes google-auth-library throw the access token away and
      // refresh with THIS client's id and secret first (oauth2client.js getRequestMetadataAsync → isTokenExpiring),
      // whatever client actually minted the refresh token.
      const beforeRequest = async () => {
        const c = (auth && auth.credentials) || {};
        if (c.expiry_date && c.expiry_date <= Date.now() + 5 * 60 * 1000) await auth.refreshAccessToken();
      };
      return {
        users: {
          messages: {
            send: async (args) => {
              await beforeRequest();
              gmailSends.push({ auth: args && args.userId });
              const step = gmail.plan.shift();
              if (step && step !== 'ok') throw step;
              return { data: { id: 'msg-1' } };
            },
            list: async () => { await beforeRequest(); return { data: { messages: [] } }; },
          },
        },
      };
    },
  },
});
/** Which client id the fake Google will accept a refresh from, and what it says otherwise. */
const refreshWorks = { clientId: 'ios-client.apps.googleusercontent.com', error: 'unauthorized_client' };

const mailScopes = require(path.join(ROOT, 'server/services/mailScopes.js'));
const em = require(path.join(ROOT, 'server/controllers/emailController.js'));
const auth = require(path.join(ROOT, 'server/controllers/authController.js'));

function mkRes() {
  const r = { statusCode: 200, body: undefined };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.set = () => r; r.setHeader = () => r; r.header = () => r; r.type = () => r;
  return r;
}

/** The two outbound calls every link flow makes: the token exchange, then the profile read. */
function fakeFetch(token, profile) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? String(init.body) : '' });
    if (/oauth2\.googleapis\.com\/token|login\.microsoftonline\.com/.test(String(url))) {
      return { ok: true, status: 200, json: async () => token };
    }
    return { ok: true, status: 200, json: async () => profile };
  };
  return calls;
}

function resetWorld() {
  db.users = {
    7: { id: 7, email: 'owner@gmail.com', full_name: 'Owner', oauth_provider: 'apple' },
  };
  db.audit.length = 0; db.runs.length = 0;
  oauthBuilds.length = 0; gmailSends.length = 0; gmail.plan.length = 0;
  refreshWorks.clientId = 'ios-client.apps.googleusercontent.com';
  refreshWorks.error = 'unauthorized_client';
}

const GOOGLE_SEND = 'https://www.googleapis.com/auth/gmail.send';
const SIGN_IN_ONLY = 'openid email profile';

(async () => {
  console.log('── 1. the pure module (services/mailScopes) ──');
  {
    ok('parseScopes reads a space- or comma-separated grant', mailScopes.parseScopes(`openid email ${GOOGLE_SEND}`).length === 3
      && mailScopes.parseScopes('a,b').length === 2 && mailScopes.parseScopes(null).length === 0);
    ok('scopeString de-duplicates and is null when nothing was reported',
      mailScopes.scopeString('openid openid email') === 'openid email' && mailScopes.scopeString('') === null && mailScopes.scopeString(undefined) === null);
    ok('⚠️ a sign-in-only Google consent CANNOT send', mailScopes.canSendWith('google', SIGN_IN_ONLY) === false);
    ok('…a consent that includes gmail.send can', mailScopes.canSendWith('google', `${SIGN_IN_ONLY} ${GOOGLE_SEND}`) === true);
    ok('…and so does a wider Gmail grant we never ask for', mailScopes.canSendWith('google', 'https://mail.google.com/') === true);
    ok('⚠️ NO RECORDED GRANT MEANS UNKNOWN, NEVER "cannot send" — no existing account is disconnected by this change',
      mailScopes.canSendWith('google', null) === true && mailScopes.canSendWith('google', '') === true && mailScopes.canSendWith('microsoft', undefined) === true);
    ok('Microsoft spells the same grant two ways and both count', mailScopes.canSendWith('microsoft', 'User.Read Mail.Send offline_access') === true
      && mailScopes.canSendWith('microsoft', 'https://graph.microsoft.com/Mail.Send') === true
      && mailScopes.canSendWith('microsoft', 'User.Read offline_access') === false);
    ok('scopesKnown separates "we looked" from "we were told nothing"', mailScopes.scopesKnown(SIGN_IN_ONLY) === true && mailScopes.scopesKnown(null) === false);
  }

  console.log('── 2. which OAuth client owns a refresh token ──');
  {
    const ios = mailScopes.clientForRefresh({ google_token_client: 'ios-client.apps.googleusercontent.com' });
    ok('⚠️ an iOS-minted token refreshes with the iOS client AND NO SECRET (sending one is what Google answers `unauthorized_client` to)',
      ios.clientId === 'ios-client.apps.googleusercontent.com' && ios.clientSecret === undefined && ios.label === 'iOS', ios.label);
    const web = mailScopes.clientForRefresh({ google_token_client: 'web-client.apps.googleusercontent.com' });
    ok('a web-minted token refreshes with the web pair', web.clientId === 'web-client.apps.googleusercontent.com' && web.clientSecret === 'web-secret-not-real');
    const android = mailScopes.clientForRefresh({ google_token_client: 'android-client.apps.googleusercontent.com' });
    ok('⚠️ an ANDROID client with no environment variable of its own is still usable — the row carries the id (GOOGLE_ANDROID_CLIENT_ID is unset in production)',
      android.clientId === 'android-client.apps.googleusercontent.com' && android.clientSecret === undefined);
    const unknown = mailScopes.clientForRefresh({});
    ok('an account connected before this shipped falls back to the web pair, as it always did', unknown.clientId === 'web-client.apps.googleusercontent.com' && unknown.label === 'Web');
    const order = mailScopes.refreshOrder({ google_token_client: 'android-client.apps.googleusercontent.com' }).map((c) => c.clientId);
    ok('refreshOrder puts the recorded client first and still tries every configured one after it',
      order[0] === 'android-client.apps.googleusercontent.com' && order.includes('ios-client.apps.googleusercontent.com') && order.includes('web-client.apps.googleusercontent.com'), order);
    ok('…with no duplicates when the recorded client IS a configured one',
      mailScopes.refreshOrder({ google_token_client: 'ios-client.apps.googleusercontent.com' }).filter((c) => c.clientId === 'ios-client.apps.googleusercontent.com').length === 1);
  }

  console.log('── 3. connecting Gmail from the Send page (/auth/link-google) ──');
  {
    resetWorld();
    const calls = fakeFetch(
      { access_token: 'ya29.fake', refresh_token: '1//fake', scope: `${SIGN_IN_ONLY} ${GOOGLE_SEND}`, expires_in: 3599 },
      { email: 'owner@gmail.com', name: 'Owner' },
    );
    const res = mkRes();
    await auth.linkGoogle({ user: { id: 7 }, body: { code: 'c', codeVerifier: 'v', platform: 'ios', redirectUri: 'com.googleusercontent.apps.ios-client:/oauth2redirect/google' }, headers: {} }, res);
    ok('a consent that includes gmail.send → 200, canSend true', res.statusCode === 200 && res.body.success === true && res.body.canSend === true && !res.body.reason, res.body);
    ok('⚠️ the grant is RECORDED (users.google_granted_scopes), so the Send page can answer before a message is written',
      typeof db.users[7].google_granted_scopes === 'string' && /gmail\.send/.test(db.users[7].google_granted_scopes), db.users[7].google_granted_scopes);
    ok('⚠️ …and so is the exact client that minted the refresh token (users.google_token_client = the iOS client)',
      db.users[7].google_token_client === 'ios-client.apps.googleusercontent.com', db.users[7].google_token_client);
    ok('the exchange really used the iOS client (the code came from the iOS app)', /client_id=ios-client/.test(calls[0].body));
    ok('the audit row says whether this connection can send', db.audit.some((a) => a.event === 'OAUTH_ACCOUNT_LINKED' && a.details.can_send === true && a.details.scopes_known === true), db.audit);
  }
  {
    resetWorld();
    fakeFetch({ access_token: 'ya29.fake', refresh_token: '1//fake', scope: SIGN_IN_ONLY }, { email: 'owner@gmail.com', name: 'Owner' });
    const res = mkRes();
    await auth.linkGoogle({ user: { id: 7 }, body: { code: 'c', codeVerifier: 'v', platform: 'ios' }, headers: {} }, res);
    ok('⚠️ THE OWNER\'S CASE: Google returns BOTH tokens with "Send email on your behalf" unticked → still a 200 (the sign-in is real)…',
      res.statusCode === 200 && res.body.success === true, res.body);
    ok('…but canSend is false and the reason is \'scope\' — said at CONNECT time, not after a message is written',
      res.body.canSend === false && res.body.reason === 'scope', res.body);
    ok('…and the message names the checkbox the user has to tick, instead of telling them to sign in again',
      /Send email on your behalf/.test(res.body.message) && !/sign in again/i.test(res.body.message), res.body.message);
    ok('the tokens are stored anyway — nothing is thrown away, the account is simply not send-ready',
      !!db.users[7].google_access_token && !!db.users[7].google_refresh_token && db.users[7].google_granted_scopes === SIGN_IN_ONLY);
    const acct = em.mailAccountOf(db.users[7]);
    ok('⚠️ the mailbox card now reports ready:true, canSend:false — connected, not allowed', acct.ready === true && acct.canSend === false, acct);
  }
  {
    // The second consent — what "Reconnect" did for the owner at 10:54:54 UTC.
    fakeFetch({ access_token: 'ya29.fake2', refresh_token: '1//fake2', scope: `${SIGN_IN_ONLY} ${GOOGLE_SEND}` }, { email: 'owner@gmail.com', name: 'Owner' });
    const res = mkRes();
    await auth.linkGoogle({ user: { id: 7 }, body: { code: 'c2', codeVerifier: 'v2', platform: 'ios' }, headers: {} }, res);
    ok('re-consenting WITH the permission flips the same account to send-ready with no other step',
      res.body.canSend === true && em.mailAccountOf(db.users[7]).canSend === true);
  }

  console.log('── 4. signing in with Google (/auth/google) records the same thing ──');
  {
    resetWorld();
    db.users = {};
    const calls = fakeFetch(
      { access_token: 'ya29.fake', refresh_token: '1//fake', scope: SIGN_IN_ONLY, expires_in: 3599 },
      { email: 'new@gmail.com', name: 'New', id: 'g1' },
    );
    // The new-account lane needs an id back from the INSERT.
    const realRun = require(path.join(ROOT, 'db-config.js')).run;
    require(path.join(ROOT, 'db-config.js')).run = async (sql, params = []) => {
      if (/^INSERT INTO users/i.test(String(sql).trim())) { db.users[9] = { id: 9, email: 'new@gmail.com' }; return { rows: [{ id: 9 }], lastID: 9 }; }
      return realRun(sql, params);
    };
    const res = mkRes();
    await auth.googleAuth({ body: { code: 'c', codeVerifier: 'v', platform: 'ios', isMobile: true }, headers: {}, ip: '1.2.3.4' }, res);
    require(path.join(ROOT, 'db-config.js')).run = realRun;
    ok('a brand-new account still signs in normally', res.statusCode === 200 && res.body.success === true, res.body);
    ok('⚠️ …and the sign-in-only grant is recorded against it, so the Send page never shows a green tick over it',
      db.users[9].google_granted_scopes === SIGN_IN_ONLY && db.users[9].google_token_client === 'ios-client.apps.googleusercontent.com', db.users[9]);
    ok('the OAUTH_TOKEN_GRANTED audit row carries can_send:false — the fact missing from every row before this',
      db.audit.some((a) => a.event === 'OAUTH_TOKEN_GRANTED' && a.details.can_send === false), db.audit.map((a) => a.event));
    ok('⚠️ neither OAuth endpoint dumps req.body any more — the raw authorization code and PKCE verifier never reach the logs (lengths only, the 2026-09-19 rule)',
      !/Request Body|JSON\.stringify\(req\.body/.test(strip(R('server/controllers/authController.js'))));
    ok('⚠️ …and the FAILED-exchange branch no longer prints `tokenParams` either — that object holds the code, the PKCE verifier and the web client secret',
      !/console\.error\('Token params used:'/.test(strip(R('server/controllers/authController.js')))
      && /codeLength: tokenParams\.code \? String\(tokenParams\.code\)\.length : 0/.test(strip(R('server/controllers/authController.js'))));
    void calls;
  }

  console.log('── 5. Outlook: the mirror-image holes ──');
  {
    resetWorld();
    fakeFetch({ access_token: 'ms-fake', refresh_token: 'ms-refresh', scope: 'User.Read Mail.Read Mail.Send' }, { mail: 'owner@outlook.com' });
    const res = mkRes();
    await auth.linkMicrosoft({ user: { id: 7 }, body: { code: 'c', codeVerifier: 'v' }, headers: {} }, res);
    ok('a full Microsoft consent connects and can send', res.body.canSend === true && !res.body.reason, res.body);
    ok('…and its grant is recorded too', db.users[7].microsoft_granted_scopes === 'User.Read Mail.Read Mail.Send', db.users[7].microsoft_granted_scopes);
  }
  {
    resetWorld();
    db.users[7].microsoft_refresh_token = enc('an-older-mailboxs-refresh-token');
    fakeFetch({}, { mail: 'owner@outlook.com' });
    const res = mkRes();
    // The bare-accessToken branch: no `code`, so Microsoft never returns a refresh token.
    await auth.linkMicrosoft({ user: { id: 7 }, body: { accessToken: 'ms-fake' }, headers: {} }, res);
    ok('⚠️ an Outlook link that brings no refresh token is NOT claimed as send-ready — it would die within the hour',
      res.body.canSend === false && res.body.reason === 'no_refresh', res.body);
    ok('⚠️ …and the stale refresh token of the PREVIOUS mailbox is cleared, never silently kept',
      db.users[7].microsoft_refresh_token === null, db.users[7].microsoft_refresh_token === null ? undefined : 'kept');
  }

  console.log('── 6. ⚠️ the send path: one deliberate refresh, and the FIRST error is the one reported ──');
  {
    // The owner's exact prod sequence: Gmail answers 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT, and the recovery's refresh
    // fails with `unauthorized_client`. Before the fix the library did that refresh itself and its 401 became the
    // user's message ("sign in again"); now the recovery is ours and the FIRST error is what they hear about.
    resetWorld();
    const user = {
      id: 7, oauth_provider: 'google',
      google_access_token: enc('ya29.fake'), google_refresh_token: enc('1//fake'),
      google_token_client: 'ios-client.apps.googleusercontent.com',
      google_token_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    db.users[7] = user;
    refreshWorks.clientId = 'nobody';   // every client is refused, exactly as prod answered
    const scopeErr = Object.assign(new Error('Request had insufficient authentication scopes.'), {
      status: 403,
      response: { status: 403, data: { error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } },
    });
    gmail.plan.push(scopeErr);
    let thrown = null;
    try { await em.sendViaConnectedGmail(user, { to: ['a@b.com'], subject: 'S', text: 'T', attachments: [] }); } catch (e) { thrown = e; }
    ok('the send fails (nothing is pretended)', !!thrown);
    ok('⚠️ …and is classified from GMAIL\'s answer — \'scope\', the action that can fix it — not from the refresh\'s 401',
      em.classifyMailError(thrown) === 'scope', { reason: em.classifyMailError(thrown), original: thrown && thrown.originalMailReason });
    ok('⚠️ the OAuth2 client was built with the client that MINTED the token (iOS) and with no secret',
      oauthBuilds[0].clientId === 'ios-client.apps.googleusercontent.com' && oauthBuilds[0].clientSecret === undefined, oauthBuilds[0] && oauthBuilds[0].clientId);
    ok('⚠️ …and with an explicit expiry_date, which is what stops google-auth-library retrying blindly (oauth2client.js mayRequireRefresh)',
      typeof oauthBuilds[0].credentials.expiry_date === 'number' && oauthBuilds[0].credentials.expiry_date > 0, oauthBuilds[0] && oauthBuilds[0].credentials && Object.keys(oauthBuilds[0].credentials));
    ok('exactly one message was ever handed to Gmail — the failed attempt, never a duplicate', gmailSends.length === 1, gmailSends.length);
    ok('⚠️ no token column was cleared by a failed send (the Account screen must not be disconnected by a Send)',
      db.users[7].google_access_token && db.users[7].google_refresh_token);
  }
  {
    // An access token that expired earlier than our stored expiry said (clock skew, a rotated session): ONE silent
    // refresh with the right client, one retry, and the user sees nothing at all.
    resetWorld();
    const user = {
      id: 7, oauth_provider: 'google',
      google_access_token: enc('ya29.stale'), google_refresh_token: enc('1//fake'),
      google_token_client: 'ios-client.apps.googleusercontent.com',
      google_token_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    db.users[7] = user;
    refreshWorks.clientId = 'ios-client.apps.googleusercontent.com';
    gmail.plan.push(Object.assign(new Error('Invalid Credentials'), { status: 401, response: { status: 401, data: {} } }), 'ok');
    const r = await em.sendViaConnectedGmail(user, { to: ['a@b.com'], subject: 'S', text: 'T', attachments: [] });
    ok('⚠️ expired access token → silent refresh → the message goes out, first time, with nothing said to the user',
      r && r.provider === 'google' && r.id === 'msg-1' && gmailSends.length === 2, { r, sends: gmailSends.length });
    ok('…the refresh went to the iOS client, the one that minted the token',
      oauthBuilds.some((b) => b.clientId === 'ios-client.apps.googleusercontent.com'), oauthBuilds.map((b) => b.clientId));
    ok('…and the freshly minted access token was written back', db.runs.some((x) => /UPDATE users SET google_access_token/.test(x.sql)));
  }
  {
    // ⚠️ USER 618'S REAL ROW TODAY (read-only, 2026-09-20): a stored expiry an HOUR in the past and NO recorded client
    // — 364 of the 366 connected Google accounts in production look exactly like this. The refresh has to happen
    // before the client is built, and the client, the token and the expiry all have to come from the row it returns.
    resetWorld();
    const user = {
      id: 7, oauth_provider: 'google',
      google_access_token: enc('ya29.expired'), google_refresh_token: enc('1//fake'),
      google_token_client: null,
      google_token_expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    // ⚠️ THE ROW AND THE CALLER'S COPY ARE SEPARATE OBJECTS, exactly as in production: letterSendController reads the
    // user once and hands that SNAPSHOT down, while a refresh UPDATEs the database. Sharing one object here would
    // hide the whole defect — the caller's copy would appear to update itself.
    db.users[7] = { ...user };
    refreshWorks.clientId = 'ios-client.apps.googleusercontent.com';
    gmail.plan.push('ok');
    const r = await em.sendViaConnectedGmail(user, { to: ['a@b.com'], subject: 'S', text: 'T', attachments: [] });
    const sendClients = oauthBuilds.filter((b) => b.credentials && b.credentials.access_token);
    const refreshes = oauthBuilds.filter((b) => b.credentials && b.credentials.refresh_token && !b.credentials.access_token);
    ok('an expired stored token is refreshed first and the message goes out, first time',
      r && r.id === 'msg-1' && gmailSends.length === 1, { r, sends: gmailSends.length });
    ok('⚠️ the SEND client is the one the refresh just succeeded with (iOS, no secret) — never the web pair guessed from the pre-refresh row',
      sendClients.length === 1 && sendClients[0].clientId === 'ios-client.apps.googleusercontent.com' && sendClients[0].clientSecret === undefined,
      sendClients.map((b) => b.clientId));
    ok('⚠️ …and its expiry_date is in the FUTURE: a past one makes google-auth-library throw the fresh token away and refresh AGAIN, with that guessed client, before the request is issued',
      !!sendClients[0] && sendClients[0].credentials.expiry_date > Date.now(),
      sendClients[0] && sendClients[0].credentials.expiry_date - Date.now());
    ok('⚠️ …so the whole send cost exactly ONE refresh — no recovery round trip and no Google 401 of our own making',
      refreshes.length === 1, refreshes.length);
  }
  {
    // ⚠️ THE RETRY'S ANSWER WINS WHEN IT IS ABOUT THE MESSAGE. Attempt 1 fails on a stale access token (401 — a story
    // about the TOKEN, which says nothing about the message); the refreshed attempt 2 reaches Gmail and is told the
    // grant lacks gmail.send. Reporting the first reason here would send the user to re-consent with the same
    // checkbox unticked — the owner's loop, reached from the other side.
    resetWorld();
    const user = {
      id: 7, oauth_provider: 'google',
      google_access_token: enc('ya29.stale'), google_refresh_token: enc('1//fake'),
      google_token_client: 'ios-client.apps.googleusercontent.com',
      google_token_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    db.users[7] = user;
    refreshWorks.clientId = 'ios-client.apps.googleusercontent.com';
    gmail.plan.push(
      Object.assign(new Error('Invalid Credentials'), { status: 401, response: { status: 401, data: {} } }),
      Object.assign(new Error('Request had insufficient authentication scopes.'), {
        status: 403,
        response: { status: 403, data: { error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } },
      }),
    );
    let thrown = null;
    try { await em.sendViaConnectedGmail(user, { to: ['a@b.com'], subject: 'S', text: 'T', attachments: [] }); } catch (e) { thrown = e; }
    ok('⚠️ a first-attempt 401 no longer masks GMAIL\'s own answer on the retry — \'scope\', the one action that fixes it',
      em.classifyMailError(thrown) === 'scope', { reason: em.classifyMailError(thrown), original: thrown && thrown.originalMailReason });
  }
  {
    // ⚠️ AND IT MUST NOT MASK THE OUTCOME EITHER (2026-09-20, third pass). The same stale-token 401 on attempt 1, then
    // a refreshed attempt 2 that hands the message over and loses the connection mid-flight. Reporting 'reconnect'
    // here would tell the user "nothing was sent" about a message Gmail may have taken: they reconnect, send again,
    // the recruiter gets it twice — and the SECOND send is the one that charges a download unit.
    const outcome = async (second) => {
      resetWorld();
      const user = {
        id: 7, oauth_provider: 'google',
        google_access_token: enc('ya29.stale'), google_refresh_token: enc('1//fake'),
        google_token_client: 'ios-client.apps.googleusercontent.com',
        google_token_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
      db.users[7] = { ...user };
      refreshWorks.clientId = 'ios-client.apps.googleusercontent.com';
      gmail.plan.push(Object.assign(new Error('Invalid Credentials'), { status: 401, response: { status: 401, data: {} }, sendIssued: true }), second);
      try { await em.sendViaConnectedGmail(user, { to: ['a@b.com'], subject: 'S', text: 'T', attachments: [] }); } catch (e) { return em.classifyMailError(e); }
      return 'sent';
    };
    const dropped = await outcome(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET', sendIssued: true }));
    ok('⚠️ 401 then a connection dropped AFTER the message went over → \'unknown_outcome\' (check your Sent folder), never "reconnect — nothing was sent"',
      dropped === 'unknown_outcome', dropped);
    const busy = await outcome(Object.assign(new Error('Rate Limit Exceeded'), {
      status: 429, response: { status: 429, data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } },
    }));
    ok('⚠️ 401 then a rate limit → \'provider_busy\' (try again in a minute), not a re-consent the mailbox does not need',
      busy === 'provider_busy', busy);
  }
  {
    // ⚠️ THE OLDER APPLICATION-SEND LANE KEEPS A RECOVERY TOO. Stating an expiry_date turns OFF google-auth-library's
    // own "401/403 → refresh once and retry", which this lane relied on; without a replacement, a Gmail 401 on a token
    // our row still called valid drops the application email into the SMTP fallback — sent from cv@cvapplyr.com
    // instead of the user's own mailbox, with nothing in their Sent folder.
    resetWorld();
    const user = {
      id: 7, email: 'owner@gmail.com', full_name: 'Owner', oauth_provider: 'google',
      google_access_token: enc('ya29.stale'), google_refresh_token: enc('1//fake'),
      google_token_client: 'ios-client.apps.googleusercontent.com',
      google_token_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    db.users[7] = user;
    refreshWorks.clientId = 'ios-client.apps.googleusercontent.com';
    gmail.plan.push(Object.assign(new Error('Invalid Credentials'), { status: 401, response: { status: 401, data: {} } }), 'ok');
    let out = null, threw = null;
    try { out = await em.sendEmailViaGmail(user, 'a@b.com', 'Subject', 'Body', null, null); } catch (e) { threw = e; }
    ok('⚠️ one silent refresh, and the application email still leaves the user\'s OWN mailbox instead of the SMTP fallback',
      !!out && out.success === true && gmailSends.length === 2, { threw: threw && threw.message, sends: gmailSends.length });
    ok('…and the recovered 401 did not clear the account\'s tokens on the way past',
      !!db.users[7].google_refresh_token && !!db.users[7].google_access_token);
  }
  {
    // ⚠️ A 403 that is really a RATE LIMIT is not an auth problem: no refresh, no retry, and still 'provider_busy'.
    resetWorld();
    const user = {
      id: 7, oauth_provider: 'google', google_access_token: enc('ya29.fake'), google_refresh_token: enc('1//fake'),
      google_token_client: 'ios-client.apps.googleusercontent.com',
      google_token_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    db.users[7] = user;
    gmail.plan.push(Object.assign(new Error('User-rate limit exceeded'), {
      status: 403, response: { status: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } },
    }));
    let thrown = null;
    try { await em.sendViaConnectedGmail(user, { to: ['a@b.com'], subject: 'S', text: 'T', attachments: [] }); } catch (e) { thrown = e; }
    ok('⚠️ a rate-limited 403 stays \'provider_busy\' and costs no refresh and no second attempt',
      em.classifyMailError(thrown) === 'provider_busy' && gmailSends.length === 1 && oauthBuilds.length === 1,
      { reason: em.classifyMailError(thrown), sends: gmailSends.length, builds: oauthBuilds.length });
  }
  {
    // A refresh token that is really gone: the honest 'reconnect', and still nothing cleared.
    resetWorld();
    const user = {
      id: 7, oauth_provider: 'google',
      google_access_token: enc('ya29.dead'), google_refresh_token: enc('1//dead'),
      google_token_client: 'ios-client.apps.googleusercontent.com',
      google_token_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    db.users[7] = user;
    refreshWorks.clientId = 'nobody';
    refreshWorks.error = 'invalid_grant: Token has been expired or revoked.';
    gmail.plan.push(Object.assign(new Error('Invalid Credentials'), { status: 401, response: { status: 401, data: {} } }));
    let thrown = null;
    try { await em.sendViaConnectedGmail(user, { to: ['a@b.com'], subject: 'S', text: 'T', attachments: [] }); } catch (e) { thrown = e; }
    ok('⚠️ a refresh token that is genuinely gone → the honest \'reconnect\' (and only then)', em.classifyMailError(thrown) === 'reconnect', em.classifyMailError(thrown));
    ok('…nothing was cleared, so the account screen still shows what the user connected', !!db.users[7].google_refresh_token);
  }
  {
    // A grant we already know lacks send never reaches the provider at all.
    resetWorld();
    const user = { id: 7, oauth_provider: 'google', google_access_token: enc('ya29.x'), google_refresh_token: enc('1//x'), google_granted_scopes: SIGN_IN_ONLY };
    let thrown = null;
    try { await em.sendWithConnectedAccount(user, { to: ['a@b.com'], subject: 'S', text: 'T', attachments: [] }); } catch (e) { thrown = e; }
    ok('⚠️ a mailbox recorded as not allowed to send is refused BEFORE the provider is asked, with reason \'scope\'',
      em.classifyMailError(thrown) === 'scope' && gmailSends.length === 0, { reason: em.classifyMailError(thrown), sends: gmailSends.length });
  }

  console.log('── 7. the fix is in the source, not only in the scenarios ──');
  {
    const src = strip(R('server/controllers/emailController.js'));
    ok('⚠️ createOAuth2Client no longer hard-codes the web client', !/const clientId = process\.env\.GOOGLE_WEB_CLIENT_ID \|\| process\.env\.GOOGLE_CLIENT_ID;[\s\S]{0,400}?new google\.auth\.OAuth2\(/.test(src)
      && /mailScopes\.clientForRefresh\(fresh\)/.test(src));
    ok('⚠️ …and always states an expiry_date', /expiry_date: Number\.isFinite\(expiresAt\)/.test(src));
    ok('⚠️ …built from the row the REFRESH returns, never the caller\'s (refreshGoogleToken hands back a copy)',
      /const fresh = await freshGoogleUser\(user\);/.test(src) && !/getValidGoogleAccessToken\(user\);\s*\n/.test(src));
    ok('every Gmail lane in the file goes through the one explicit recovery, or keeps the library\'s own deliberately',
      (src.match(/withGmailClient\(user/g) || []).length >= 3 && /createOAuth2Client\(user, \{ forceRefreshOnFailure: true \}\)/.test(src),
      (src.match(/withGmailClient\(user/g) || []).length);
    ok('⚠️ classifyMailError honours the first error\'s reason', /if \(typeof err\.originalMailReason === 'string'\) return err\.originalMailReason;/.test(src));
    ok('both provider lanes now recover exactly once', /refreshGoogleToken\(user\); \} catch \(e\) \{ throw keepFirstReason/.test(src)
      && /const refreshed = await refreshMicrosoftToken\(user\)\.catch\(\(\) => null\);/.test(src));
    const ctrl = strip(R('server/controllers/letterSendController.js'));
    ok('the Send page\'s account block carries canSend', /canSend: a\.canSend !== false/.test(ctrl) && /acct\.canSend === false/.test(ctrl));
    const acc = strip(R('server/controllers/authController.js'));
    ok('every Google connect point records the grant', (acc.match(/recordGoogleGrant\(/g) || []).length >= 4, (acc.match(/recordGoogleGrant\(/g) || []).length);
    const srv = strip(R('server.js'));
    ok('⚠️ the Passport strategies take five arguments, which is the only way passport-oauth2 hands over `params.scope`',
      (srv.match(/\(accessToken, refreshToken, params, profile, done\)/g) || []).length === 3, (srv.match(/\(accessToken, refreshToken, params, profile, done\)/g) || []).length);
  }

  console.log(`\ngmail connect: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('SUITE THREW', e); process.exit(2); });
