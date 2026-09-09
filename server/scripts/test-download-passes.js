// The download gate — the money decisions, tested against a stubbed database so no real
// connection, and no real purchase, is involved.
//   DATABASE_URL=postgresql://t@localhost:5432/t node server/scripts/test-download-passes.js
//
// What matters here is not that the happy path works — it is that the UNHAPPY paths cost nobody
// anything: the meter must ship off, a broken database must not hand out free downloads, and a
// receipt must not be claimable twice.
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 200) : '')); } };

// ── stub the database BEFORE the service loads, so nothing ever opens a socket ───────────────────
const dbPath = require.resolve(path.join(__dirname, '..', '..', 'db-config.js'));
const db = { rows: [], calls: [], mode: 'ok' };
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: {
    get: async (sql, params) => {
      db.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (db.mode === 'throw') throw new Error('database is down');
      return db.rows.length ? db.rows.shift() : null;
    },
    query: async () => [], run: async () => ({}),
  },
};
// entitlements pulls in a lot; stub it to the two functions downloads.js actually calls.
const entPath = require.resolve(path.join(__dirname, '..', 'services', 'entitlements.js'));
const ent = { sub: null, gate: { allowed: false, message: 'no' }, consumed: [] };
require.cache[entPath] = {
  id: entPath, filename: entPath, loaded: true, exports: {
    activeSubscription: async () => ent.sub,
    canConsumeMany: async () => ent.gate,
    consumeOnSuccess: async (u, kind, detail) => { ent.consumed.push({ u, kind, detail }); },
  },
};

const D = require(path.join(__dirname, '..', 'services', 'downloads.js'));

(async () => {
  console.log('── ⚠️ the plan meter ships OFF ──');
  ok('DOWNLOADS_METERED is not set in this environment', process.env.DOWNLOADS_METERED !== '1');
  ok('…so the service is unmetered', D.METERED === false);
  ok('an unmetered subscriber keeps UNLIMITED downloads, exactly as before',
    (ent.sub = { plan_key: 'pro' }, (await D.canDownload(1, { templateId: 'azure' })).via) === 'plan_unlimited');
  ok('…and nothing is charged for one', (await D.claimDownload(1, { templateId: 'azure' })).charged === false);

  console.log('── ⚠️ a free user is still refused, and told why ──');
  ent.sub = null;
  const denied = await D.canDownload(1, { templateId: 'azure' });
  ok('no plan, no pass → refused', denied.allowed === false);
  ok('…with the reason the app already handles', denied.reason === 'paid_required');

  console.log('── ⚠️ a broken database must not hand out free downloads ──');
  db.mode = 'throw';
  const brokenSub = await D.canDownload(1, { templateId: 'azure' });
  ok('the gate FAILS CLOSED when nothing can be read', brokenSub.allowed === false, brokenSub);
  ok('…and a pass count that cannot be read is zero, not "some"', (await D.unboundPassCount(1)) === 0);
  db.mode = 'ok';

  console.log('── one pass covers one DESIGN, in every format ──');
  db.rows = [{ id: 7 }];                                   // a pass already bound to this design
  const second = await D.canDownload(1, { templateId: 'azure' });
  ok('a design already paid for is allowed again', second.allowed === true && second.via === 'pass_bound');
  db.rows = [{ id: 7 }];
  ok('…and the second format is NOT charged', (await D.claimDownload(1, { templateId: 'azure' })).charged === false);

  console.log('── an unbound pass is spent atomically ──');
  db.rows = [null, { n: 1 }];                              // not bound yet; one pass available
  const withPass = await D.canDownload(1, { templateId: 'mono' });
  ok('an unspent pass allows the download', withPass.allowed === true && withPass.via === 'pass');
  db.calls.length = 0;
  db.rows = [null, { id: 9 }];                             // not bound; the UPDATE wins the row
  const spent = await D.claimDownload(1, { templateId: 'mono' });
  ok('…and spending it binds it to that design', spent.via === 'pass' && spent.charged === true);
  const upd = db.calls.map((c) => c.sql).join(' | ');
  ok('⚠️ the claim is ONE conditional UPDATE, not select-then-update',
    /UPDATE download_passes SET template_id/.test(upd) && /RETURNING id/.test(upd));
  ok('⚠️ …and it takes the row under a lock, so two taps cannot both win it',
    /FOR UPDATE SKIP LOCKED/.test(upd));

  console.log('── a purchased pass is idempotent on the STORE transaction ──');
  db.calls.length = 0; db.rows = [{ id: 1 }];
  ok('granting writes a pass', (await D.grantPass(1, { store: 'apple', environment: 'production', storeTxnId: 'T1', productId: D.PASS_PRODUCT_ID })) === true);
  const ins = db.calls[0].sql;
  ok('⚠️ the conflict target is the STORE TRANSACTION, with no user_id in it',
    /ON CONFLICT \(store, environment, store_txn_id\) DO NOTHING/.test(ins), ins);
  db.rows = [null];
  ok('…so the same receipt replayed grants nothing', (await D.grantPass(2, { store: 'apple', environment: 'production', storeTxnId: 'T1' })) === false);
  ok('⚠️ …and environment is part of the key (sandbox cannot land on a payer)', /environment/.test(ins));

  console.log('── incomplete purchases are refused outright ──');
  for (const bad of [
    { store: 'apple', environment: 'production' },
    { store: 'apple', storeTxnId: 'T2' },
    { environment: 'production', storeTxnId: 'T3' },
  ]) ok('a purchase missing its identity grants nothing', (await D.grantPass(1, bad)) === false);

  console.log(`\ndownload passes: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
