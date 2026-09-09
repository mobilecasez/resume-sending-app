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
    (ent.sub = { plan_key: 'pro' }, (await D.canDownload(1, { employer: 'Airbus' })).via) === 'plan_unlimited');
  ok('…and nothing is charged for one', (await D.claimDownload(1, { employer: 'Airbus' })).charged === false);

  console.log('── ⚠️ a free user is still refused, and told why ──');
  ent.sub = null;
  const denied = await D.canDownload(1, { employer: 'Airbus' });
  ok('no plan, no pass → refused', denied.allowed === false);
  ok('…with the reason the app already handles', denied.reason === 'paid_required');

  console.log('── ⚠️ a broken database must not hand out free downloads ──');
  db.mode = 'throw';
  const brokenSub = await D.canDownload(1, { employer: 'Airbus' });
  ok('the gate FAILS CLOSED when nothing can be read', brokenSub.allowed === false, brokenSub);
  ok('…and a pass count that cannot be read is zero, not "some"', (await D.unboundPassCount(1)) === 0);
  db.mode = 'ok';

  console.log('── ⚠️ one pass buys an EMPLOYER: every design, every format, and the letter ──');
  db.rows = [{ id: 7, employer_name: 'Airbus' }];
  const owned = await D.canDownload(1, { employer: 'Airbus' });
  ok('an employer already paid for is allowed again', owned.allowed === true && owned.via === 'pass_owned');
  db.rows = [{ id: 7 }];
  ok('…and a second design is NOT charged', (await D.claimDownload(1, { employer: 'Airbus' })).charged === false);
  db.rows = [{ id: 7 }];
  ok('…nor the Word version', (await D.claimDownload(1, { employer: 'Airbus' })).charged === false);
  db.rows = [{ id: 7 }];
  ok('…nor the COVER LETTER for that employer', (await D.claimDownload(1, { employer: 'Airbus' })).charged === false);

  console.log('── the employer key is stable, or a payment attaches to the wrong company ──');
  ok('case does not create a second employer', D.employerKeyOf('Airbus') === D.employerKeyOf('AIRBUS'));
  ok('stray whitespace does not either', D.employerKeyOf('  Airbus  ') === D.employerKeyOf('Airbus'));
  ok('inner spacing is collapsed', D.employerKeyOf('Airbus  Atlantic') === D.employerKeyOf('Airbus Atlantic'));
  ok('two different companies stay different', D.employerKeyOf('Airbus') !== D.employerKeyOf('Boeing'));
  ok('⚠️ no employer gets its OWN scope, it does not unlock everything', D.employerKeyOf('') === '(none)');

  console.log('── an unspent pass is bound atomically, to the employer ──');
  db.rows = [null, { n: 1 }];
  const withPass = await D.canDownload(1, { employer: 'Boeing' });
  ok('an unspent pass allows the download', withPass.allowed === true && withPass.via === 'pass');
  db.calls.length = 0;
  db.rows = [null, { id: 9 }];
  const spent = await D.claimDownload(1, { employer: 'Boeing' });
  ok('…and spending it binds it to that employer', spent.via === 'pass' && spent.charged === true);
  const upd = db.calls.map((c) => c.sql).join(' | ');
  ok('⚠️ the claim is ONE conditional UPDATE, not select-then-update',
    /UPDATE download_passes SET employer_key/.test(upd) && /RETURNING id/.test(upd));
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

  console.log('── ⚠️ a pass also buys ONE AI resume and ONE AI letter, tracked separately ──');
  db.rows = [{ id: 11 }];
  ok('an unused resume generation is covered', (await D.passCoversGeneration(1, 'resume', 'Airbus')) === true);
  db.rows = [{ id: 11 }];
  ok('…and the letter is its own entitlement', (await D.passCoversGeneration(1, 'cover_letter', 'Airbus')) === true);
  db.rows = [null];
  ok('a spent one is not covered again', (await D.passCoversGeneration(1, 'resume', 'Airbus')) === false);
  ok('an unknown kind is never covered', (await D.passCoversGeneration(1, 'nonsense', 'Airbus')) === false);
  db.mode = 'throw';
  ok('⚠️ …and an unreadable pass FAILS CLOSED', (await D.passCoversGeneration(1, 'resume', 'Airbus')) === false);
  db.mode = 'ok';

  db.calls.length = 0; db.rows = [{ id: 11 }];
  const genClaim = await D.claimGeneration(1, 'resume', 'Airbus');
  ok('spending it marks the resume used', genClaim.charged === true);
  const gsql = db.calls.map((c) => c.sql).join(' | ');
  ok('⚠️ separate COLUMNS, not a shared counter — or both could go on resumes',
    /SET resume_generated_at = NOW\(\)/.test(gsql) && !/generations_left/.test(gsql));
  ok('⚠️ …claimed atomically under a lock', /FOR UPDATE SKIP LOCKED/.test(gsql) && /RETURNING id/.test(gsql));

  db.calls.length = 0; db.rows = [null, { id: 12 }];
  const onFree = await D.claimGeneration(1, 'cover_letter', 'Boeing');
  ok('⚠️ generating with an UNSPENT pass binds it too (people generate before they download)',
    onFree.charged === true && onFree.bound === true);
  ok('…binding employer and timestamp in the SAME update',
    /SET letter_generated_at = NOW\(\), employer_key = \$3, employer_name = \$4, bound_at = NOW\(\)/
      .test(db.calls.map((c) => c.sql).join(' | ')));

  db.rows = [null, null];
  ok('no pass at all charges nothing', (await D.claimGeneration(1, 'resume', 'Nobody')).charged === false);

  console.log('── the environment can be handed over explicitly (the letter worker has no req) ──');
  ok('a plain environment string is accepted', D.envOf('Sandbox') === 'Sandbox' && D.envOf('Production') === 'Production');
  ok('…and anything else resolves from the request', typeof D.envOf({}) === 'string');

  console.log('── ⚠️ the environment spelling must match the constraint, or every insert fails ──');
  const se = require(path.join(__dirname, '..', 'services', 'storeEnvironment.js'));
  const schema = require('fs').readFileSync(path.join(__dirname, '..', '..', 'db-init.js'), 'utf8');
  const chk = (schema.match(/chk_download_passes_environment[\s\S]{0,200}?CHECK \(environment IN \(([^)]*)\)\)/) || [])[1] || '';
  ok('the CHECK lists exactly what storeEnvironment emits',
    chk.includes(`'${se.PRODUCTION}'`) && chk.includes(`'${se.SANDBOX}'`), { chk, is: [se.PRODUCTION, se.SANDBOX] });

  console.log(`\ndownload passes: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
