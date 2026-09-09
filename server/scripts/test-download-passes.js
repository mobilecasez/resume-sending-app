// The download gate — the money decisions, tested against a stubbed database so no real
// connection, and no real purchase, is involved.
//   DATABASE_URL=postgresql://t@localhost:5432/t node server/scripts/test-download-passes.js
//
// What matters here is not that the happy path works — it is that the UNHAPPY paths cost nobody
// anything: the meter must ship off, a broken database must not hand out free downloads, a receipt
// must not be claimable twice, and every "yes" the gate gives must be followed by a claim that
// actually charges something.
//
// Source-level assertions run against COMMENT-STRIPPED text. Matching your own explanation of a
// rule proves nothing about the code that implements it.
'use strict';
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 240) : '')); } };
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const R = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

// ── stub the database BEFORE the service loads, so nothing ever opens a socket ───────────────────
const dbPath = require.resolve(path.join(__dirname, '..', '..', 'db-config.js'));
const db = { rows: [], qrows: [], calls: [], mode: 'ok' };
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: {
    get: async (sql, params) => {
      db.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (db.mode === 'throw') throw new Error('database is down');
      return db.rows.length ? db.rows.shift() : null;
    },
    query: async (sql, params) => {
      db.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (db.mode === 'throw') throw new Error('database is down');
      return db.qrows.length ? db.qrows.shift() : [];
    },
    run: async () => ({}),
  },
};
// entitlements pulls in a lot; stub it to the three functions downloads.js actually calls.
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
const sql = () => db.calls.map((c) => c.sql).join(' | ');

(async () => {
  console.log('── ⚠️ the plan meter ships OFF ──');
  ok('DOWNLOADS_METERED is not set in this environment', process.env.DOWNLOADS_METERED !== '1');
  ok('…so the service is unmetered', D.METERED === false);
  ok('an unmetered subscriber keeps UNLIMITED downloads, exactly as before',
    (ent.sub = { plan_key: 'pro' }, (await D.canDownload(1, { employer: 'Airbus' })).via) === 'plan_unlimited');
  ok('…and nothing is charged for one', (await D.claimDownload(1, { employer: 'Airbus' })).charged === false);

  console.log('── ⚠️ a PLAN THAT COVERS THE DOWNLOAD MUST NOT EAT AN UNSPENT ONE-OFF ──');
  // The pass was asked before the subscription, so a subscriber's free download bound — and
  // destroyed — the single employer choice they had paid $0.99 for and got nothing back.
  ent.sub = { plan_key: 'pro' };
  db.rows = [null, { n: 1 }];                       // no bound pass; one unspent pass exists
  ok('a subscriber with an unspent pass still downloads on the PLAN',
    (await D.canDownload(1, { employer: 'Airbus' })).via === 'plan_unlimited');
  db.calls.length = 0; db.rows = [null];
  const subClaim = await D.claimDownload(1, { employer: 'Airbus' });
  ok('…and the claim charges the plan, not the pass', subClaim.via === 'plan_unlimited' && subClaim.charged === false);
  ok('⚠️ …so no pass is bound anywhere in that claim', !/UPDATE download_passes SET employer_key/.test(sql()), sql());
  ent.sub = null;

  console.log('── ⚠️ a free user is still refused, and told why ──');
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

  console.log('── ⚠️ THE SCREENS SPELL COMPANIES DIFFERENTLY, AND THE USER MUST NOT PAY FOR THAT ──');
  // The letter side stores the AI's reading ("Acme Corporation GmbH") or the recipient's website;
  // the resume side sends the dashboard's own name ("Acme Corp"). Exact matching charged twice.
  ok('a legal suffix is not a second company', D.sameEmployer('Acme Corp', 'Acme Corporation GmbH') === true);
  ok('a website is a spelling of the company', D.sameEmployer('Acme Corp', 'https://www.acme.com/careers') === true);
  ok('…including a bare host', D.sameEmployer('Zalando SE', 'zalando.de') === true);
  ok('case and punctuation are not companies either', D.sameEmployer('Siemens AG', 'SIEMENS') === true);
  ok('⚠️ but two genuinely different companies stay different', D.sameEmployer('Bank of America', 'Bank of England') === false);
  ok('⚠️ …even sharing a first word', D.sameEmployer('General Motors', 'General Electric') === false);
  ok('⚠️ and the nameless scope is never reached by matching', D.sameEmployer('(none)', 'Acme') === false);

  db.rows = [null];                                  // exact miss…
  db.qrows = [[{ id: 21, employer_name: 'Acme Corporation GmbH', employer_key: 'acme corporation gmbh' }]];
  const bridged = await D.canDownload(1, { employer: 'Acme Corp' });
  ok('⚠️ a pass bound by the LETTER covers the RESUME download of the same company',
    bridged.allowed === true && bridged.via === 'pass_owned', bridged);

  db.rows = [null];
  db.qrows = [[{ id: 21, employer_name: 'Acme Corporation GmbH', employer_key: 'acme corporation gmbh' }]];
  ok('…and resolveEmployer answers with the spelling the PASS already uses',
    (await D.resolveEmployer(1, ['Acme Corp', 'acme.com'], {})) === 'Acme Corporation GmbH');
  db.rows = []; db.qrows = [];
  ok('a company nobody owns falls back to the first candidate the caller gave',
    (await D.resolveEmployer(1, [null, '  Beta Ltd ', 'beta.com'], {})) === 'Beta Ltd');

  console.log('── an unspent pass is bound atomically, to the employer ──');
  db.rows = [null, { n: 1 }];
  const withPass = await D.canDownload(1, { employer: 'Boeing' });
  ok('an unspent pass allows the download', withPass.allowed === true && withPass.via === 'pass');
  db.calls.length = 0;
  db.rows = [null, { id: 9 }];
  const spent = await D.claimDownload(1, { employer: 'Boeing' });
  ok('…and spending it binds it to that employer', spent.via === 'pass' && spent.charged === true);
  ok('⚠️ the claim is ONE conditional UPDATE, not select-then-update',
    /UPDATE download_passes SET employer_key/.test(sql()) && /RETURNING id/.test(sql()));
  ok('⚠️ …and it takes the row under a lock, so two taps cannot both win it',
    /FOR UPDATE SKIP LOCKED/.test(sql()));

  console.log('── ⚠️ A NAMELESS DOWNLOAD IS CHARGED, NOT WAIVED ──');
  // Waiving it meant the gate said yes to something the claim would not bill — and because the
  // same employer-less entry point (the editor's "Download / Preview") can be used forever, one
  // $0.99 pass bought every design in every format for every company for the life of the account.
  db.calls.length = 0;
  db.rows = [null, { id: 31 }];                      // no '(none)' pass yet; one unspent to take
  const nameless = await D.claimDownload(1, { employer: null });
  ok('a download with no company SPENDS the pass', nameless.charged === true && nameless.via === 'pass');
  ok('…binding it into the (none) scope, not to a real company',
    db.calls.some((c) => Array.isArray(c.params) && c.params.includes('(none)')), db.calls.slice(-1));
  db.rows = [null, { n: 1 }];
  ok('⚠️ …and it still counts as UNSPENT, so a real employer can take it over',
    (await D.canDownload(1, { employer: 'Airbus' })).via === 'pass');
  ok('⚠️ …the SQL that selects it says so', /bound_at IS NULL OR employer_key = \$/.test(sql()), sql());
  db.rows = [{ id: 31, employer_key: '(none)' }];
  ok('a SECOND nameless download is free — it is that pass’s own scope, not a rebinding loop',
    (await D.claimDownload(1, { employer: null })).charged === false);

  console.log('── a purchased pass is idempotent on the STORE transaction ──');
  db.calls.length = 0; db.rows = [{ id: 1 }];
  ok('granting writes a pass', (await D.grantPass(1, { store: 'apple', environment: 'Production', storeTxnId: 'T1', productId: D.PASS_PRODUCT_ID })) === true);
  const ins = db.calls[0].sql;
  ok('⚠️ the conflict target is the STORE TRANSACTION, with no user_id in it',
    /ON CONFLICT \(store, environment, store_txn_id\) DO NOTHING/.test(ins), ins);
  db.rows = [null];
  ok('…so the same receipt replayed grants nothing', (await D.grantPass(2, { store: 'apple', environment: 'Production', storeTxnId: 'T1' })) === false);
  ok('⚠️ …and environment is part of the key (sandbox cannot land on a payer)', /environment/.test(ins));

  console.log('── ⚠️ A WRITE FAILURE IS NOT "ALREADY EXISTS" ──');
  // Both were reported as `false`, so the verify endpoints answered success:true and the client
  // then FINISHED the store transaction — on Apple it left StoreKit's queue and the retry record
  // was deleted, on Google finishOneTime consumed it so not even the 3-day auto-refund fired.
  db.mode = 'throw';
  let threw = false;
  try { await D.grantPass(1, { store: 'apple', environment: 'Production', storeTxnId: 'T9' }); } catch { threw = true; }
  ok('⚠️ a failed INSERT THROWS instead of reporting a quiet false', threw === true);
  db.mode = 'ok';
  ok('⚠️ …and the source carries no catch that could swallow it again',
    !/catch[\s\S]{0,120}grantPass failed/.test(strip(R('server', 'services', 'downloads.js'))));
  for (const [file, ctl] of [['paymentController.js', 'apple'], ['subscriptionPurchaseController.js', 'google']]) {
    const src = strip(R('server', 'controllers', file));
    ok(`${ctl} verify answers 503 + retryable when the pass could not be written`,
      /grantPass\([\s\S]{0,400}?\} catch \([\s\S]{0,300}?status\(503\)[\s\S]{0,200}retryable: true/.test(src), file);
    ok(`${ctl} verify reports the environment so a TestFlight build can adopt it`,
      /kind: 'download_pass'[\s\S]{0,120}environment/.test(src), file);
  }

  console.log('── incomplete purchases are refused outright ──');
  for (const bad of [
    { store: 'apple', environment: 'Production' },
    { store: 'apple', storeTxnId: 'T2' },
    { environment: 'Production', storeTxnId: 'T3' },
  ]) ok('a purchase missing its identity grants nothing', (await D.grantPass(1, bad)) === false);

  console.log('── ⚠️ a pass also buys ONE AI resume and ONE AI letter, tracked separately ──');
  db.rows = [{ id: 11, employer_name: 'Airbus' }, { id: 11 }];
  ok('an unused resume generation is covered', (await D.passCoversGeneration(1, 'resume', 'Airbus')) === true);
  db.rows = [{ id: 11, employer_name: 'Airbus' }, { id: 11 }];
  ok('…and the letter is its own entitlement', (await D.passCoversGeneration(1, 'cover_letter', 'Airbus')) === true);
  db.rows = [{ id: 11, employer_name: 'Airbus' }, null, null];   // owned, column already stamped, nothing to reserve
  db.qrows = [];
  ok('a spent one is not covered again', (await D.passCoversGeneration(1, 'resume', 'Airbus')) === false);
  ok('an unknown kind is never covered', (await D.passCoversGeneration(1, 'nonsense', 'Airbus')) === false);
  ok('⚠️ an AI call is NEVER spent on a nameless employer (a stamp cannot be taken back)',
    (await D.passCoversGeneration(1, 'resume', null)) === false);
  db.mode = 'throw';
  ok('⚠️ …and an unreadable pass FAILS CLOSED', (await D.passCoversGeneration(1, 'resume', 'Airbus')) === false);
  db.mode = 'ok';

  console.log('── ⚠️ THE GENERATION GATE RESERVES, OR ONE PASS PAYS FOR TWO COMPANIES ──');
  // A pure read let two generations for two DIFFERENT employers both be admitted inside the AI's
  // minute: the first worker to finish claimed the pass, the second fell through to
  // consumeOnSuccess, which does not enforce. Two paid-for letters, one payment.
  db.calls.length = 0; db.rows = [null, { id: 41 }]; db.qrows = [[]];
  ok('an unspent pass admits a generation for a NEW employer',
    (await D.passCoversGeneration(1, 'cover_letter', 'Beta Ltd')) === true);
  ok('⚠️ …by BINDING it at the gate, under a lock',
    /UPDATE download_passes SET employer_key = \$3, employer_name = \$4, bound_at = NOW\(\)/.test(sql())
    && /FOR UPDATE SKIP LOCKED/.test(sql()), sql());
  ok('⚠️ …and it does NOT stamp the generation column — a failed AI call must cost nothing',
    !/letter_generated_at = NOW\(\)/.test(sql()), sql());
  db.rows = [null, null]; db.qrows = [[]];
  ok('⚠️ the racing generation for a DIFFERENT employer finds nothing left',
    (await D.passCoversGeneration(1, 'cover_letter', 'Gamma Inc')) === false);

  console.log('── ⚠️ THE PLAN IS SPENT BEFORE THE ONE-OFF ──');
  // Burning someone's pass while their plan or free allowance could have paid destroys what they
  // bought and hands back nothing. boundOnly is the caller saying "quota can cover this".
  db.calls.length = 0; db.rows = [null]; db.qrows = [[]];
  ok('with quota available, an UNSPENT pass is left alone',
    (await D.passCoversGeneration(1, 'resume', 'Delta', {}, { boundOnly: true })) === false);
  ok('⚠️ …and nothing was bound in the attempt', !/UPDATE download_passes/.test(sql()), sql());
  db.rows = [{ id: 51, employer_name: 'Delta' }, { id: 51 }];
  ok('…but a pass ALREADY bought for this employer still pays for it',
    (await D.passCoversGeneration(1, 'resume', 'Delta', {}, { boundOnly: true })) === true);

  console.log('── spending the AI call, after it succeeded ──');
  db.calls.length = 0; db.rows = [{ id: 11, employer_name: 'Airbus' }, { id: 11 }];
  const genClaim = await D.claimGeneration(1, 'resume', 'Airbus');
  ok('spending it marks the resume used', genClaim.charged === true);
  ok('⚠️ separate COLUMNS, not a shared counter — or both could go on resumes',
    /SET resume_generated_at = NOW\(\)/.test(sql()) && !/generations_left/.test(sql()));
  ok('⚠️ …claimed atomically under a lock', /FOR UPDATE SKIP LOCKED/.test(sql()) && /RETURNING id/.test(sql()));

  db.calls.length = 0; db.rows = [null, { id: 12 }]; db.qrows = [[]];
  const onFree = await D.claimGeneration(1, 'cover_letter', 'Boeing');
  ok('⚠️ generating with an UNSPENT pass binds it too (people generate before they download)',
    onFree.charged === true && onFree.bound === true);
  ok('…binding employer and timestamp in the SAME update',
    /SET letter_generated_at = NOW\(\), employer_key = \$3, employer_name = \$4, bound_at = NOW\(\)/.test(sql()));

  db.rows = [null, null, null]; db.qrows = [[]];
  ok('no pass at all charges nothing', (await D.claimGeneration(1, 'resume', 'Nobody')).charged === false);
  ok('⚠️ and a nameless claim never stamps anything', (await D.claimGeneration(1, 'resume', null)).charged === false);

  console.log('── the environment can be handed over explicitly (the letter worker has no req) ──');
  ok('a plain environment string is accepted', D.envOf('Sandbox') === 'Sandbox' && D.envOf('Production') === 'Production');
  ok('…and anything else resolves from the request', typeof D.envOf({}) === 'string');
  ok('⚠️ resolveEmployer takes one too, so the worker can call it', /resolveEmployer\(userId, candidates, reqOrEnv\)/.test(strip(R('server', 'services', 'downloads.js'))));

  console.log('── ⚠️ the environment spelling must match the constraint, or every insert fails ──');
  const se = require(path.join(__dirname, '..', 'services', 'storeEnvironment.js'));
  const schema = R('db-init.js');
  const chk = (schema.match(/chk_download_passes_environment[\s\S]{0,200}?CHECK \(environment IN \(([^)]*)\)\)/) || [])[1] || '';
  ok('the CHECK lists exactly what storeEnvironment emits',
    chk.includes(`'${se.PRODUCTION}'`) && chk.includes(`'${se.SANDBOX}'`), { chk, is: [se.PRODUCTION, se.SANDBOX] });
  const subRoutes = strip(R('server', 'routes', 'subscriptionRoutes.js'));
  ok('⚠️ the admin grant writes through the canonical normaliser, not a hand-rolled ternary',
    /normalizeEnvironment\(body\.environment\) \|\| PRODUCTION/.test(subRoutes), subRoutes.match(/const environment = .*/));
  ok('…so no lowercase spelling can reach the CHECK constraint',
    !/'production' \? 'production' : 'sandbox'/.test(subRoutes));

  console.log('── ⚠️ every AI path that can be reached from the app is gated ──');
  const batch = strip(R('server', 'routes', 'batchRoutes.js'));
  ok('⚠️ batch "Generate All" asks the same allowance the single-letter button does',
    /mode === 'generate'[\s\S]{0,200}canConsumeMany\(userId, 'cover_letter', validRecipients\.length, req\)/.test(batch), 'batchRoutes');
  ok('…refusing the whole batch up front rather than delivering the overflow unpaid',
    /status\(402\)[\s\S]{0,120}quota_exhausted/.test(batch));
  ok('…and a send-only batch stays free, because sending is free',
    !/mode === 'send'[\s\S]{0,80}canConsumeMany/.test(batch));

  const cl = strip(R('server', 'controllers', 'coverLetterController.js'));
  ok('⚠️ the LEGACY cover-letter PDF is gated too — it renders the same paid file',
    /const generateCoverLetterPdf[\s\S]{0,900}?requirePaidForDownload\(userId, res, passEmployer, req\)/.test(cl));
  ok('…and charges only once the bytes exist',
    /generateRichPDF\(\);[\s\S]{0,200}claimDownload\(userId, \{ employer: passEmployer \}, req\)/.test(cl));
  ok('⚠️ the generation gate resolves the employer instead of trusting one raw string',
    /resolveEmployer\(\s*userId, \[\(req\.body \|\| \{\}\)\.employer, companyNameHint, passHost\]/.test(cl));
  ok('⚠️ …and the pass is consulted even when the client sent no company at all',
    /passViaPass = await downloads\s*\.passCoversGeneration\(userId, 'cover_letter', passEmployer, passEnv, \{ boundOnly: quota\.allowed \}\)/.test(cl));
  ok('⚠️ the worker’s fallback charge carries the environment the GATE resolved',
    /screen: 'job_cover_letter'\s*\}, \{ storeEnv: passEnv \|\| undefined \}\)/.test(cl));
  ok('⚠️ …and sync mode carries the pass decision, or a pass holder is charged twice',
    /executeGenerationWork\(userId, user, \{[\s\S]{0,220}passEmployer, passViaPass, passEnv,/.test(cl));
  ok('the claim binds on the name the AI actually resolved',
    /claimGeneration\(userId, 'cover_letter', passEmployer \|\| companyName, passEnv\)/.test(cl));

  const rb = strip(R('server', 'controllers', 'resumeBuilderController.js'));
  ok('⚠️ the resume gate asks the plan FIRST and the pass second',
    /const quota = freeRegen \? \{ allowed: true \} : await entitlements\.canConsumeMany\(userId, 'resume', 1, req\);[\s\S]{0,260}boundOnly: quota\.allowed/.test(rb));
  ok('⚠️ a client that gave up is never charged for the answer it cannot receive',
    /req\.on\('close'[\s\S]{0,80}clientGone = true/.test(rb) && /if \(clientGone\) \{[\s\S]{0,200}\} else \{/.test(rb));

  console.log(`\ndownload passes: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
