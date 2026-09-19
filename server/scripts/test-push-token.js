// One device, one account (2026-09-20): POST /api/user/push-token → expoPushService.saveDeviceToken.
//   node server/scripts/test-push-token.js
//
// WHY: users.expo_push_token was shared between accounts {1, 17, 616}, {88, 89} and {118, 498} in production (read-only
// check, 2026-09-20). The route only SET the token on the caller, never took it off the account that had it before, so
// a push chosen from one account's state reached a phone signed into another — the how_it_works push the owner tapped
// for issue 7 was picked from user 17's journey on a phone signed in as 616.
// What this holds the server to:
//   • the caller gets the token and EVERY other account loses it, in ONE statement (never a moment on nobody);
//   • two registrations of the same token for two accounts at once never leave it on both (advisory lock — under READ
//     COMMITTED one statement alone lost that race 47/200 on a scratch Postgres 17, 199/200 once inside a transaction);
//   • ⚠️ the ADMIN keeps getting admin alerts when the owner's phone opens as a test account (admin_alert_token) —
//     production's only admin (user 1) shares its token with 17 and 616, and moving expo_push_token alone paged nobody;
//   • the account that lost its token says WHY on the admin screen (push_token_moved_at), not "notifications off";
//   • a stale receipt clears only a token the account still holds; a deleted account keeps no push address;
//   • a caller with no users row moves nothing (a token is moved, never just taken away);
//   • a malformed token or user id never reaches the database; the token is never logged;
//   • server.js's route calls it, and the old set-only statement is gone.
// The fake database below applies the statements' own semantics to an in-memory table — including READ COMMITTED's
// "re-check only the rows you found" and a real per-key advisory lock — so the race test fails without the lock. The
// SQL itself was run against a scratch Postgres 17 cluster (production is 17.11) through the real db-config, with the
// same scenarios — the fake is shape-checked against the exact statements, so a changed statement fails here until the
// model (and that check) are redone.
// Source-level assertions run on COMMENT-STRIPPED text (matching your own explanation proves nothing).
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const R = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 400) : '')); } };

const svc = require(path.join(ROOT, 'server', 'services', 'expoPushService.js'));
// The service's own SQL constants, read from its comment-stripped source (so the fake is checked against them).
const SVC_SRC = strip(R('server/services/expoPushService.js'));
// (source text spells a backslash as two — `\\[` in the file is `\[` in the SQL that runs)
const constSql = (name) => norm((SVC_SRC.match(new RegExp('const ' + name + ' =\\s*`([^`]+)`')) || [])[1] || '').replace(/\\\\/g, '\\');
const STATEMENT_SQL = () => constSql('SAVE_TOKEN_SQL');

/* ── a users table, and the statements' semantics ─────────────────────────────────────────────────── */
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const STATEMENT = /^UPDATE users SET expo_push_token = CASE WHEN id = \? THEN \? ELSE NULL END, admin_alert_token = CASE WHEN role = 'admin' THEN \? ELSE admin_alert_token END, push_token_moved_at = CASE WHEN id = \? THEN NULL ELSE NOW\(\) END WHERE \(id = \? OR expo_push_token = \?\) AND EXISTS \(SELECT 1 FROM users me WHERE me\.id = \? AND me\.deleted_at IS NULL\) RETURNING id$/;
// The pre-049 statement, used only when the two columns cannot be ensured: sets, never clears (see 1c).
const LEGACY_SAVE = /^UPDATE users SET expo_push_token = \? WHERE id = \? AND deleted_at IS NULL RETURNING id$/;
const LOCK = /^SELECT pg_advisory_xact_lock\(hashtext\('push_token'\), hashtext\(\?::text\)\)$/;
const COLUMNS_CHECK = /^SELECT column_name FROM information_schema\.columns WHERE table_schema = current_schema\(\) AND table_name = 'users' AND column_name IN \(\?, \?\)$/;
const TARGETS = /^SELECT id, COALESCE\(NULLIF\(admin_alert_token, ''\), expo_push_token\) AS expo_push_token FROM users WHERE role = 'admin' AND deleted_at IS NULL AND COALESCE\(NULLIF\(admin_alert_token, ''\), expo_push_token, ''\) ~ '\^\(ExpoPushToken\|ExponentPushToken\)\\\['$/;
const LEGACY_TARGETS = /^SELECT id, expo_push_token FROM users WHERE role = 'admin' AND deleted_at IS NULL AND COALESCE\(expo_push_token, ''\) ~ '\^\(ExpoPushToken\|ExponentPushToken\)\\\['$/;
const STALE = /^UPDATE users SET expo_push_token = CASE WHEN expo_push_token = \? THEN NULL ELSE expo_push_token END, admin_alert_token = CASE WHEN admin_alert_token = \? THEN NULL ELSE admin_alert_token END WHERE id = \? AND \(expo_push_token = \? OR admin_alert_token = \?\)$/;
const VALID = /^(ExpoPushToken|ExponentPushToken)\[/;
const tick = () => new Promise((r) => setImmediate(r));

// opts.columns: do the two Migration 049 columns exist yet? opts.failAlter: the lazy ALTER fails (a busy table).
function fakeDb(rows, opts = {}) {
  const log = [];
  const state = { columns: opts.columns !== false, alters: 0 };
  const locks = new Map();   // key → promise chain: a REAL per-key mutex, held until the transaction ends
  const update = async (params) => {
    const [setId, tok, alertTok, movedId, whereId, whereTok, meId] = params;
    if (!state.columns) throw new Error('column "admin_alert_token" does not exist');
    if (!rows.some((r) => r.id === meId && !r.deleted_at)) return [];
    const match = (r) => r.id === whereId || r.expo_push_token === whereTok;
    // READ COMMITTED: the scan sees the rows that matched when the statement STARTED…
    const found = rows.filter(match);
    await tick(); await tick();          // …another statement may commit in between…
    // …and each found row is re-checked on its latest version (a row that newly matches is never seen).
    const hit = found.filter(match);
    for (const r of hit) {
      if (r.role === 'admin') r.admin_alert_token = alertTok;
      r.expo_push_token = r.id === setId ? tok : null;
      r.push_token_moved_at = r.id === movedId ? null : 'NOW';
    }
    return hit.map((r) => ({ id: r.id }));
  };
  const targets = (legacy) => rows
    .filter((r) => r.role === 'admin' && !r.deleted_at)
    .map((r) => ({ id: r.id, expo_push_token: legacy ? r.expo_push_token : (r.admin_alert_token || r.expo_push_token) }))
    .filter((r) => VALID.test(r.expo_push_token || ''));
  const query = async (sql, params, where) => {
    const q = norm(sql);
    log.push({ sql: q, params, where });
    if (COLUMNS_CHECK.test(q)) return state.columns ? params.map((c) => ({ column_name: c })) : [];
    if (STATEMENT.test(q)) {
      if (where !== 'tx') throw new Error('the move must run inside the transaction that holds the lock');
      return update(params);
    }
    if (LEGACY_SAVE.test(q)) {
      const [tok, id] = params;
      const r = rows.find((x) => x.id === id && !x.deleted_at);
      if (!r) return [];
      r.expo_push_token = tok;
      return [{ id: r.id }];
    }
    if (TARGETS.test(q)) { if (!state.columns) throw new Error('column "admin_alert_token" does not exist'); return targets(false); }
    if (LEGACY_TARGETS.test(q)) return targets(true);
    if (STALE.test(q)) {
      const [t1, t2, id] = params;
      const r = rows.find((x) => x.id === id && (x.expo_push_token === t1 || x.admin_alert_token === t2));
      if (r) { if (r.expo_push_token === t1) r.expo_push_token = null; if (r.admin_alert_token === t2) r.admin_alert_token = null; }
      return [];
    }
    throw new Error(`unexpected SQL: ${q}`);
  };
  const db = {
    log, rows, state,
    query: (sql, params) => query(sql, params, 'pool'),
    get: async (sql, params) => (await query(sql, params, 'pool'))[0] || null,
    run: async (sql, params) => { await query(sql, params, 'pool'); return { changes: 0 }; },
    withTransaction: async (fn) => {
      const held = [];
      const tx = {
        query: (sql, params) => query(sql, params, 'tx'),
        run: async (sql, params) => {
          const q = norm(sql);
          log.push({ sql: q, params, where: 'tx' });
          if (/^SET LOCAL lock_timeout = '1s'$/.test(q)) return { changes: 0 };
          const add = q.match(/^ALTER TABLE users ADD COLUMN IF NOT EXISTS (admin_alert_token TEXT|push_token_moved_at TIMESTAMPTZ)$/);
          if (add) { if (opts.failAlter) throw new Error('canceling statement due to lock timeout'); state.alters++; if (state.alters >= 2) state.columns = true; return { changes: 0 }; }
          throw new Error(`unexpected tx SQL: ${q}`);
        },
        get: async (sql, params) => {
          const q = norm(sql);
          log.push({ sql: q, params, where: 'tx' });
          if (!LOCK.test(q)) throw new Error(`unexpected tx SQL: ${q}`);
          const key = params[0];
          const prev = locks.get(key) || Promise.resolve();
          let release;
          const mine = new Promise((r) => { release = r; });
          locks.set(key, prev.then(() => mine));
          held.push(release);
          await prev;                    // wait for whoever holds this token's lock to COMMIT
          return {};
        },
      };
      try { return await fn(tx); } finally { held.forEach((r) => r()); }   // xact-scoped: released at commit/rollback
    },
  };
  return db;
}
const holders = (rows, tok) => rows.filter((r) => r.expo_push_token === tok).map((r) => r.id).sort((a, b) => a - b);
const byId = (rows, id) => rows.find((r) => r.id === id);

(async () => {
  const A = 'ExponentPushToken[owner-iphone]';
  const B = 'ExponentPushToken[shared-android]';
  const world = () => [
    { id: 1, role: 'admin', expo_push_token: A }, { id: 17, role: 'user', expo_push_token: A }, { id: 616, role: 'user', expo_push_token: A },
    { id: 88, role: 'user', expo_push_token: B }, { id: 89, role: 'user', expo_push_token: B },
    { id: 5, role: 'user', expo_push_token: null },
  ];

  console.log('── 1. the production shape: {1, 17, 616} share one phone ──');
  {
    const db = fakeDb(world());
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    let r;
    try { r = await svc.saveDeviceToken(616, A, db); } finally { console.log = orig; }
    ok('⚠️ 616 opens the app → ONLY 616 holds the token', JSON.stringify(holders(db.rows, A)) === '[616]', holders(db.rows, A));
    ok('…reported as saved, taken off 2 other accounts', r.saved === true && r.cleared === 2, r);
    const writes = db.log.filter((e) => e.where === 'tx');
    ok('⚠️ ONE move statement (no clear-then-set window), after the token\'s lock, in ONE transaction',
      writes.length === 2 && LOCK.test(writes[0].sql) && STATEMENT.test(writes[1].sql)
      && db.log.filter((e) => STATEMENT.test(e.sql)).length === 1, db.log.map((e) => e.sql.slice(0, 60)));
    const lockW = writes.find((e) => LOCK.test(e.sql)) || {}, moveW = writes.find((e) => STATEMENT.test(e.sql)) || {};
    ok('…the lock is keyed on the token itself', JSON.stringify(lockW.params) === JSON.stringify([A]), lockW.params);
    ok('…with the caller\'s id, the token, and the existence check bound as parameters',
      JSON.stringify(moveW.params) === JSON.stringify([616, A, A, 616, 616, A, 616]), moveW.params);
    ok('the other phone\'s shared token is untouched', JSON.stringify(holders(db.rows, B)) === '[88,89]');
    ok('⚠️ the log line carries counts, never the token', logs.length === 1 && !logs[0].includes('PushToken') && /taken off 2 other account/.test(logs[0]), logs);

    // ⚠️ THE ADMIN'S ALERTS (review finding, 2026-09-20): user 1 is production's ONLY admin and just lost its token.
    ok('⚠️ admin 1 keeps this device as its ALERT device', byId(db.rows, 1).admin_alert_token === A && byId(db.rows, 1).expo_push_token === null, byId(db.rows, 1));
    const t1 = await svc.adminAlertTargets(db);
    ok('⚠️ admin alerts still reach the owner\'s phone while it is signed in as 616 (not nobody)',
      t1.length === 1 && t1[0].id === 1 && t1[0].expo_push_token === A, t1);
    ok('…while a user-journey sender reading expo_push_token finds no token on user 1 (the original bug stays fixed)',
      byId(db.rows, 1).expo_push_token === null);
    ok('17 is not an admin → no alert address appears on it', !byId(db.rows, 17).admin_alert_token);
    ok('the accounts that lost the token are stamped moved, the caller is not',
      byId(db.rows, 1).push_token_moved_at === 'NOW' && byId(db.rows, 17).push_token_moved_at === 'NOW' && !byId(db.rows, 616).push_token_moved_at);

    const again = await svc.saveDeviceToken(616, A, db);
    ok('opening again: still 616, nothing else to clear', again.saved && again.cleared === 0 && JSON.stringify(holders(db.rows, A)) === '[616]', again);
    ok('…and the columns were checked once for this database, not per call', db.log.filter((e) => COLUMNS_CHECK.test(e.sql)).length === 1);
    const back = await svc.saveDeviceToken(1, A, db);
    ok('the owner signs back in as 1 → 1 holds it and 616 does not', back.saved && back.cleared === 1 && JSON.stringify(holders(db.rows, A)) === '[1]', holders(db.rows, A));
    ok('…1\'s moved stamp is cleared, 616 is now the one stamped', !byId(db.rows, 1).push_token_moved_at && byId(db.rows, 616).push_token_moved_at === 'NOW');
    const fresh = await svc.saveDeviceToken(5, 'ExpoPushToken[new-phone]', db);
    ok('a fresh token on a new phone moves nobody else\'s', fresh.saved && fresh.cleared === 0 && JSON.stringify(holders(db.rows, A)) === '[1]', fresh);
    await svc.saveDeviceToken(1, 'ExpoPushToken[owner-new-phone]', db);
    ok('the admin on a NEW phone → the alert device follows (the old phone stops getting admin alerts)',
      byId(db.rows, 1).admin_alert_token === 'ExpoPushToken[owner-new-phone]');
  }

  console.log('── 1b. ⚠️ two accounts register the same token AT ONCE ──');
  {
    // 7 holds R; 5 and 6 register it concurrently. READ COMMITTED alone left it on both (scratch Postgres 17).
    const R_ = 'ExponentPushToken[race]';
    const db = fakeDb([{ id: 5, role: 'user', expo_push_token: null }, { id: 6, role: 'user', expo_push_token: null }, { id: 7, role: 'user', expo_push_token: R_ }]);
    const orig = console.log; console.log = () => {};
    try { await Promise.all([svc.saveDeviceToken(5, R_, db), svc.saveDeviceToken(6, R_, db)]); } finally { console.log = orig; }
    ok('⚠️ exactly ONE account holds the token afterwards', holders(db.rows, R_).length === 1, holders(db.rows, R_));
    // Control: the same interleaving without the lock DOES lose — so the model above can tell the difference.
    const ctl = fakeDb([{ id: 5, role: 'user', expo_push_token: null }, { id: 6, role: 'user', expo_push_token: null }, { id: 7, role: 'user', expo_push_token: R_ }]);
    const raw = (id) => ctl.withTransaction((tx) => tx.query(STATEMENT_SQL(), [id, R_, R_, id, id, R_, id]));
    await Promise.all([raw(5), raw(6)]);
    ok('(control) the bare statement, unlocked, leaves it on two accounts in this model', holders(ctl.rows, R_).length === 2, holders(ctl.rows, R_));
  }

  console.log('── 1c. the columns (Migration 049) are added lazily, and a failure never pages nobody ──');
  {
    const db = fakeDb(world(), { columns: false });
    const orig = console.log; console.log = () => {};
    try { await svc.saveDeviceToken(616, A, db); } finally { console.log = orig; }
    ok('missing columns → added (under a lock_timeout) before the move', db.state.alters === 2
      && db.log.some((e) => /^SET LOCAL lock_timeout = '1s'$/.test(e.sql)) && JSON.stringify(holders(db.rows, A)) === '[616]');
    ok('⚠️ the lazy ALTER waits 1s, not 5s — a QUEUED ALTER blocks every other users query for the whole wait',
      !db.log.some((e) => /^SET LOCAL lock_timeout = '(?!1s)/.test(e.sql)));

    // ⚠️ REGRESSION (2026-09-20 review): the lazy ALTER used to throw straight out of saveDeviceToken, so a busy users
    // table answered the route with a 500 and the device stayed unreachable until the next cold start (the app
    // swallows the error — pushNotificationService.ts — and only re-registers when `user.token` changes). Measured on
    // a scratch Postgres 17.8 with one ordinary reader holding ACCESS SHARE: 55P03 after 5.26s, and a concurrent login
    // query blocked 4.53s. The registration must now still land, the pre-049 way.
    const busy = fakeDb(world(), { columns: false, failAlter: true });
    const origErr0 = console.error; console.error = () => {};
    let threw = null, r0 = null;
    try { r0 = await svc.saveDeviceToken(616, A, busy); } catch (e) { threw = e; } finally { console.error = origErr0; }
    ok('⚠️ a busy table → the registration is NOT lost: saved the pre-049 way', !threw && r0 && r0.saved === true && r0.degraded === true, threw || r0);
    ok('…616 holds the token (so a push to 616 reaches this phone)', byId(busy.rows, 616).expo_push_token === A);
    ok('⚠️ …and the degraded statement SETS ONLY — it never clears the other accounts (a wholesale clear is the one '
      + 'thing a half-migrated database must not do, and admin 1 would otherwise page nobody with no admin_alert_token)',
      JSON.stringify(holders(busy.rows, A)) === '[1,17,616]', holders(busy.rows, A));
    const legacyWrites = busy.log.filter((e) => LEGACY_SAVE.test(e.sql));
    ok('…through the pre-049 statement, bound to the caller and the token', legacyWrites.length === 1
      && JSON.stringify(legacyWrites[0].params) === JSON.stringify([A, 616]), legacyWrites);
    const origErr = console.error; console.error = () => {};
    let t;
    try { t = await svc.adminAlertTargets(busy); } finally { console.error = origErr; }
    ok('⚠️ …and admin alerts FALL BACK to the plain token instead of paging nobody', t.length === 1 && t[0].id === 1 && t[0].expo_push_token === A, t);

    // ⚠️ REGRESSION: the failure used to be forgotten immediately, so EVERY later registration and EVERY admin alert
    // re-queued another ACCESS EXCLUSIVE lock on users — a self-amplifying stall, each attempt also pinning one of the
    // ten pooled connections for the whole wait. It is now remembered for a cooloff.
    const origErr2 = console.error; console.error = () => {};
    try { await svc.saveDeviceToken(89, B, busy); await svc.adminAlertTargets(busy); } finally { console.error = origErr2; }
    ok('⚠️ the failure is REMEMBERED: no second column probe within the cooloff',
      busy.log.filter((e) => COLUMNS_CHECK.test(e.sql)).length === 1, busy.log.filter((e) => COLUMNS_CHECK.test(e.sql)).length);
    ok('⚠️ …and no second ALTER is queued behind the busy table',
      busy.log.filter((e) => /^ALTER TABLE users ADD COLUMN/.test(e.sql)).length === 1);
    ok('…while the registrations still land', byId(busy.rows, 89).expo_push_token === B);
    ok('the cooloff is a timestamp, not a timer (this module still schedules nothing)',
      /COLUMNS_RETRY_MS/.test(SVC_SRC) && !/setInterval|setTimeout/.test(SVC_SRC));
  }

  console.log('── 1c-bis. ⚠️ a soft-deleted account neither takes a token nor strips one from a live account ──');
  {
    // The account-deletion path now writes expo_push_token = NULL (server.js). But authenticateToken only verifies the
    // 30-day JWT — it never reads the database — and getProfile has no deleted_at filter, so a deleted account restores
    // its session on the next cold start and re-registers. rewardNudges and uninstallDetection then push to it.
    const db = fakeDb([
      { id: 300, role: 'user', expo_push_token: null, deleted_at: 'yesterday' },
      { id: 301, role: 'user', expo_push_token: 'ExponentPushToken[dev301]' },
    ]);
    const orig = console.log; console.log = () => {};
    let r;
    try { r = await svc.saveDeviceToken(300, 'ExponentPushToken[dev301]', db); } finally { console.log = orig; }
    ok('⚠️ the deleted account gets no push address back', r.saved === false && !byId(db.rows, 300).expo_push_token, r);
    ok('⚠️ …and the live account that now has that phone keeps its token',
      byId(db.rows, 301).expo_push_token === 'ExponentPushToken[dev301]' && !byId(db.rows, 301).push_token_moved_at);
    const live = await svc.saveDeviceToken(301, 'ExponentPushToken[dev301]', db);
    ok('a live account registering is unaffected by the new filter', live.saved === true);
  }

  console.log('── 1d. stale receipts and deleted admins ──');
  {
    const db = fakeDb(world());
    const orig = console.log; console.log = () => {};
    try { await svc.saveDeviceToken(616, A, db); } finally { console.log = orig; }
    await svc.clearStaleToken(1, A, db);
    ok('DeviceNotRegistered on the admin alert → the alert address is cleared, 616 is left to its own senders',
      !byId(db.rows, 1).admin_alert_token && JSON.stringify(holders(db.rows, A)) === '[616]');
    const fresh = 'ExponentPushToken[fresh]';
    try { console.log = () => {}; await svc.saveDeviceToken(1, fresh, db); } finally { console.log = orig; }
    await svc.clearStaleToken(1, A, db);
    ok('a stale receipt for an OLD token never wipes a fresh registration', byId(db.rows, 1).expo_push_token === fresh && byId(db.rows, 1).admin_alert_token === fresh);
    byId(db.rows, 1).deleted_at = 'yesterday';
    ok('a deleted admin is paged nowhere', (await svc.adminAlertTargets(db)).length === 0);
  }

  console.log('── 1e. ⚠️ the REAL adminNotifier pages the owner\'s phone while it is signed in as 616 ──');
  {
    const db = fakeDb(world());
    const orig = console.log; console.log = () => {};
    try { await svc.saveDeviceToken(616, A, db); } finally { console.log = orig; }
    const sent = [];
    let answer = true;
    const realSend = svc.sendPushNotification, realFetch = global.fetch;
    global.fetch = async () => { throw new Error('no network in this suite'); };   // belt and braces: never reach Expo
    svc.sendPushNotification = async (tok, title, body, data, log) => { sent.push({ tok, title, userId: log && log.userId, admin: !!(data && data.adminAlert) }); return answer; };
    const dbPath = require.resolve(path.join(ROOT, 'db-config.js'));
    const ncPath = require.resolve(path.join(ROOT, 'server/controllers/notificationsController.js'));
    const anPath = require.resolve(path.join(ROOT, 'server/services/adminNotifier.js'));
    const before = { db: require.cache[dbPath], nc: require.cache[ncPath], an: require.cache[anPath] };
    const bells = [];
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
    require.cache[ncPath] = { id: ncPath, filename: ncPath, loaded: true, exports: { createNotification: (uid) => { bells.push(uid); } } };
    delete require.cache[anPath];
    try {
      const an = require(anPath);
      const res = await an.notifyAdmins('purchases', 'New purchase', 'someone bought a plan', { type: 'purchase' });
      ok('⚠️ a purchase alert reaches admin 1 on the owner\'s phone (it went to NOBODY before this fix)',
        res && res.sent === 1 && res.admins === 1 && sent.length === 1 && sent[0].tok === A && sent[0].userId === 1 && sent[0].admin, { res, sent });
      ok('…and the bell history is written for the admin', JSON.stringify(bells) === '[1]', bells);
      answer = 'stale';
      await an.notifyAdmins(null, 'AI service is down', 'x', { type: 'ai_outage' });
      ok('a DeviceNotRegistered answer clears the admin\'s alert address (and only that)',
        !byId(db.rows, 1).admin_alert_token && JSON.stringify(holders(db.rows, A)) === '[616]');
    } finally {
      svc.sendPushNotification = realSend; global.fetch = realFetch;
      for (const [p, v] of [[dbPath, before.db], [ncPath, before.nc], [anPath, before.an]]) { if (v) require.cache[p] = v; else delete require.cache[p]; }
    }
  }

  console.log('── 2. what never reaches the database ──');
  {
    const db = fakeDb(world());
    const bad = [
      [616, 'not-a-token'], [616, ''], [616, null], [616, 'ExponentPushToken'],
      [0, A], [-3, A], ['abc', A], [1.5, A], [null, A],
    ];
    for (const [u, t] of bad) {
      const r = await svc.saveDeviceToken(u, t, db);
      ok(`(${JSON.stringify(u)}, ${JSON.stringify(t)}) → not saved, no query`, r.saved === false && r.cleared === 0);
    }
    ok('…and not one statement ran', db.log.length === 0, db.log);
    ok('a numeric-string id (req.user.id from some tokens) is accepted as that user', (await svc.saveDeviceToken('89', B, db)).saved === true
      && JSON.stringify(holders(db.rows, B)) === '[89]');
    const long = 'ExponentPushToken[' + 'x'.repeat(400) + ']';
    await svc.saveDeviceToken(5, long, db);
    ok('the token is cut at 300 characters, exactly as the route always stored it', db.rows.find((r) => r.id === 5).expo_push_token === long.slice(0, 300));
  }

  console.log('── 3. ⚠️ a caller with no users row moves nothing ──');
  {
    const db = fakeDb(world());
    const r = await svc.saveDeviceToken(999, A, db);
    ok('not saved, nothing cleared', r.saved === false && r.cleared === 0, r);
    ok('⚠️ the real owners keep it (a token is MOVED, never just taken away)', JSON.stringify(holders(db.rows, A)) === '[1,17,616]', holders(db.rows, A));
  }

  console.log('── 4. the route uses it, and the set-only statement is gone ──');
  {
    const server = strip(R('server.js'));
    const at = server.indexOf("app.post('/api/user/push-token'");
    const route = at >= 0 ? server.slice(at, server.indexOf('\n});', at)) : '';
    ok('POST /api/user/push-token is still behind authenticateToken', /app\.post\('\/api\/user\/push-token', authenticateToken,/.test(server));
    ok('⚠️ it calls expoPushService.saveDeviceToken with the signed-in user', /require\('\.\/server\/services\/expoPushService'\)\.saveDeviceToken\(req\.user\.id, token\)/.test(route), route.slice(0, 400));
    ok('⚠️ no statement anywhere in server.js only SETS a token on one account', !/UPDATE users SET expo_push_token = \? WHERE id = \?/.test(server));
    ok('…and the token check still refuses a malformed token with a 400 first', /\^Expo\(nent\)\?PushToken\\\[/.test(route) && /status\(400\)/.test(route));
    ok('the service builds the statements the fake models (shapes pinned)',
      STATEMENT.test(STATEMENT_SQL()) && LOCK.test(constSql('TOKEN_LOCK_SQL'))
      && TARGETS.test(constSql('ADMIN_TARGETS_SQL')) && LEGACY_TARGETS.test(constSql('LEGACY_ADMIN_TARGETS_SQL')),
      [STATEMENT_SQL(), constSql('TOKEN_LOCK_SQL'), constSql('ADMIN_TARGETS_SQL')]);
    ok('⚠️ the move only ever lands on a LIVE caller (a soft-deleted account takes no token, and strips none)',
      /EXISTS \(SELECT 1 FROM users me WHERE me\.id = \? AND me\.deleted_at IS NULL\)/.test(STATEMENT_SQL()), STATEMENT_SQL());
    ok('…and the degraded statement is the pre-049 one, live-only and set-only',
      LEGACY_SAVE.test(constSql('LEGACY_SAVE_TOKEN_SQL')), constSql('LEGACY_SAVE_TOKEN_SQL'));
    const staleFn = SVC_SRC.split('async function clearStaleToken')[1] || '';
    ok('…and the stale-clear statement', STALE.test(norm((staleFn.match(/`([^`]+)`/) || [])[1] || '')));
    const saveFn = (SVC_SRC.split('async function saveDeviceToken')[1] || '').split('\n}')[0];
    ok('⚠️ the lock and the move run in the SAME transaction (withTransaction → tx.get lock → tx.query move)',
      /db\.withTransaction\(async \(tx\) => \{\s*await tx\.get\(TOKEN_LOCK_SQL, \[tok\]\);\s*return tx\.query\(SAVE_TOKEN_SQL,/.test(saveFn), saveFn.slice(0, 500));
    ok('saveDeviceToken / adminAlertTargets / clearStaleToken are exported beside the sender',
      ['saveDeviceToken', 'adminAlertTargets', 'clearStaleToken', 'sendPushNotification'].every((k) => typeof svc[k] === 'function')
      && Array.isArray(svc.PUSH_COLUMNS_SQL) && svc.PUSH_COLUMNS_SQL.length === 2);
  }

  console.log('── 5. every admin pager reads the one target list; the admin screen and account deletion follow ──');
  {
    const an = strip(R('server/services/adminNotifier.js'));
    const getT = (an.split('async function getAdminTargets')[1] || '').split('\n}')[0];
    ok('⚠️ adminNotifier.getAdminTargets reads expoPushService.adminAlertTargets (not expo_push_token alone)',
      /require\('\.\/expoPushService'\)\.adminAlertTargets\(dbConfig\)/.test(getT) && !/expo_push_token/.test(getT), getT);
    ok('…and clears a stale admin device with clearStaleToken (never a blind "SET expo_push_token = NULL WHERE id")',
      /clearStaleToken\(a\.id, a\.expo_push_token, dbConfig\)/.test(an) && !/UPDATE users SET expo_push_token = NULL WHERE id = \?/.test(an));
    const sup = strip(R('server/services/supportService.js'));
    const pa = (sup.split('async function pushAdmins')[1] || '').split('\n}')[0];
    ok('⚠️ supportService.pushAdmins pages the same list', /await expoPush\.adminAlertTargets\(dbConfig\)/.test(pa) && !/role = 'admin'/.test(pa), pa.slice(0, 400));

    const ops = strip(R('server/services/adminUserOps.js'));
    ok('the admin user screen passes push_token_moved_at into pushBlockReason',
      /block: pushBlockReason\(\{ \.\.\.state, pushTokenMovedAt: u\.push_token_moved_at \|\| null \}\)/.test(ops));
    // adminUserOps requires db-config, which exits without a DATABASE_URL: load it over an inert stub (nothing here
    // touches a database — pushBlockReason is pure).
    const dbPath = require.resolve(path.join(ROOT, 'db-config.js'));
    const prevDb = require.cache[dbPath];
    const inert = async () => { throw new Error('no database in this suite'); };
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: inert, get: inert, run: inert, withTransaction: inert } };
    let pushBlockReason;
    try { ({ pushBlockReason } = require(path.join(ROOT, 'server', 'services', 'adminUserOps.js'))); }
    finally { if (prevDb) require.cache[dbPath] = prevDb; else delete require.cache[dbPath]; }
    const moved = pushBlockReason({ hasPushToken: false, platform: 'ios', appVersion: '4.6.0', lastEvent: '2026-09-19', firstEvent: '2026-01-01', pushTokenMovedAt: '2026-09-20T10:00:00Z' });
    ok('⚠️ a token moved to another account reads "phone on another account", not "notifications off"',
      moved && moved.code === 'device_signed_into_other_account' && moved.fixable === false, moved);
    const html = R('public/admin-user-detail.html');
    const tsx = R('MobileApp/app/(admin)/user-360.tsx');
    const svcTs = R('MobileApp/services/aiHubService.ts');
    ok('…and both admin screens name it (web tag, app tag, app type)',
      /b\.code==='device_signed_into_other_account'/.test(html) && /block\.code === 'device_signed_into_other_account'/.test(tsx)
      && /'device_signed_into_other_account'/.test(svcTs));

    const server = strip(R('server.js'));
    const del = server.slice(server.indexOf("app.delete('/api/account/delete'"));
    const soft = (del.match(/UPDATE users SET\s+deleted_at = \?[\s\S]*?WHERE id = \?/) || [''])[0];
    ok('⚠️ deleting an account also clears its push address', /expo_push_token = NULL/.test(soft), soft);

    const init = strip(R('db-init.js'));
    ok('Migration 049 adds the two columns from the service\'s ONE definition',
      /const \{ PUSH_COLUMNS_SQL \} = require\('\.\/server\/services\/expoPushService'\);\s*for \(const sql of PUSH_COLUMNS_SQL\) await col\(sql\);/.test(init));
    ok('nothing here schedules anything (no timer in the service)', !/setInterval|setTimeout|cron/i.test(SVC_SRC));
  }

  console.log(`\npush token: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('SUITE THREW', e); process.exit(2); });
