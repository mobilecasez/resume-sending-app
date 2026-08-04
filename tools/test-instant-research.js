// The rules that decide whether we spend money researching jobs for one user, and where a job-match
// push lands. Pure functions, plain node, no database:
//   node tools/test-instant-research.js
//
// Why this file exists. Two of the three things that can go wrong here are invisible until they are
// expensive or embarrassing: an unbounded AI bill (578 thin country×field cells × every signup), and
// a notification that promises one job and drops the user on a feed of 900. The third — "the user
// whose occupation isn't in our taxonomy silently gets nothing, forever" — is invisible full stop,
// because nobody complains about a feature that never fires. All three are deterministic, so all
// three are asserted here.
'use strict';
const path = require('path');

// Every assertion below is on a pure function, so this test must never reach a database — and
// FORCING a throwaway connection string is how that is guaranteed rather than hoped for. Without it
// the modules pick up whatever DATABASE_URL is in .env, which on this machine points at PRODUCTION.
process.env.DATABASE_URL = 'postgresql://test@127.0.0.1:1/instant_research_unit_test';

const ir = require(path.join(__dirname, '..', 'server', 'services', 'instantResearch'));
const tax = require(path.join(__dirname, '..', 'server', 'utils', 'jobTaxonomy'));

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (got !== undefined ? '  → got ' + JSON.stringify(got) : '')); }
};

// ── the two real résumés this was built for ───────────────────────────────────────────────────
// A SYNTHETIC chemist résumé. It exercises exactly the taxonomy behaviour we care about — an
// occupation that classifies to 'Science & Research' — without putting a real person's name, CV
// contents or employer history in the repository. The original fixture was copied verbatim from a
// live production account; a test does not need someone's identity to prove a regex.
const CHEMIST = {
  job_titles: ['Trainee Chemist', 'Production Trainee', 'Lab Chemist'],
  industries: ['Water Treatment', 'Specialty Aroma Chemicals', 'Chemical Manufacturing'],
  skills: ['Batch Reactor Operations', 'Fractional Distillation', 'GMP Documentation',
    'Solvent Recovery Systems', 'PLC-Based Process Control', 'Communication Skills'],
  technical_skills: [],
};
// A résumé the 20-value taxonomy has no field for at all — the population arm 2 exists for.
const BARISTA = {
  job_titles: ['Waiter', 'Barista'],
  industries: ['Hospitality'],
  skills: ['Espresso Extraction', 'Milk Steaming', 'Order Taking'],
  technical_skills: [],
};

// A run context where nothing is blocking, so each test can flip exactly one thing.
const CLEAR = {
  envEnabled: true, switchOn: true, cellCount: 3, userRunCount: 0,
  demandRan: false, inFlight: 0, queued: 0, runsToday: 0, isTestAccount: false,
};

// ── 1. ARM 1 — the résumé maps to a field, and that cell is empty ─────────────────────────────
console.log('\narm 1: the thin cell');
{
  const d = ir.resolveDemand({ resumeMeta: CHEMIST, country: 'France', city: null });
  ok('a chemist résumé resolves to a taxonomy field', d.ok === true && d.arm === 'field', d);
  // ⚠️ The brief predicted he would resolve to NOTHING. He does not: jobTaxonomy really does have
  // a Science & Research field and its regex matches "chemist". Asserting the actual field here so
  // the next person reads the truth rather than the assumption.
  ok('…and the field is Science & Research, not nothing', d.field === 'Science & Research', d.field);
  ok('the demand key is stable across re-uploads', d.key === 'field:france:science & research', d.key);
  ok('the search terms lead with his role, not filler',
    d.terms.length > 0 && /chemist|scientist/i.test(d.terms[0]), d.terms);
  ok('"Communication Skills" is not a search term', !d.terms.some((t) => /^communication/i.test(t)), d.terms);

  const r = ir.decideRun(d, { ...CLEAR, cellCount: 3 });
  ok('France holds 3 Science & Research jobs → it fires', r.ok === true && r.reason === 'thin_cell', r);

  const nine = ir.decideRun(d, { ...CLEAR, cellCount: 9 });
  ok('9 is still thin', nine.ok === true, nine);
  const ten = ir.decideRun(d, { ...CLEAR, cellCount: 10 });
  ok('10 is the boundary — a cell with 10 jobs is left alone', ten.ok === false && ten.reason === 'cell_healthy', ten);
  const fat = ir.decideRun(d, { ...CLEAR, cellCount: 231 });
  ok('an IT-sized cell (231 in France) never triggers research', fat.ok === false && fat.reason === 'cell_healthy', fat);

  // Not knowing the count is not the same as knowing it is small.
  const blind = ir.decideRun(d, { ...CLEAR, cellCount: null });
  ok('an unreadable cell count does NOT spend money', blind.ok === false && blind.reason === 'cell_unknown', blind);
}

// ── 2. ARM 2 — the occupation maps to no field at all ─────────────────────────────────────────
// Without this arm a "count(country, field) < 10" trigger can never fire for these people, because
// there is no cell to count. They would get nothing, forever, and never complain about it.
console.log('\narm 2: the unrepresented occupation');
{
  ok('the taxonomy genuinely has no field for this résumé', tax.deriveUserField(BARISTA) === null,
    tax.deriveUserField(BARISTA));

  const d = ir.resolveDemand({ resumeMeta: BARISTA, country: 'France', city: 'Paris' });
  ok('it still produces a demand', d.ok === true, d);
  ok('…on the occupation arm', d.arm === 'occupation', d.arm);
  ok('…with the occupation as free text', d.occupation === 'Waiter', d.occupation);
  ok('…and no field', d.field === null, d.field);
  ok('the key is occupation-scoped', d.key === 'occ:france:waiter', d.key);

  const r = ir.decideRun(d, { ...CLEAR, cellCount: null });
  ok('arm 2 fires with no cell count at all — the missing cell IS the trigger',
    r.ok === true && r.reason === 'unrepresented_occupation', r);

  // A title made only of filler must not become a search query.
  const filler = ir.resolveDemand({
    resumeMeta: { job_titles: ['Trainee', 'Assistant'], skills: [], industries: [] },
    country: 'France',
  });
  ok('"Trainee" alone is not an occupation worth researching',
    filler.ok === false && filler.reason === 'no_occupation', filler);
}

// ── 3. Preconditions ──────────────────────────────────────────────────────────────────────────
console.log('\nwhen there is nothing to go on');
{
  const noCountry = ir.resolveDemand({ resumeMeta: CHEMIST, country: null });
  ok('no country → no research (we would research the wrong continent)',
    noCountry.ok === false && noCountry.reason === 'no_country', noCountry);
  const noResume = ir.resolveDemand({ resumeMeta: null, country: 'France' });
  ok('no résumé → no research', noResume.ok === false && noResume.reason === 'no_resume', noResume);

  // resume_metadata columns come back as arrays, JSON strings or objects depending on the column.
  const asJson = ir.resolveDemand({
    resumeMeta: { job_titles: JSON.stringify(['Lab Chemist']), skills: '[]', technical_skills: '{}' },
    country: 'France',
  });
  ok('JSON-string columns parse the same as arrays', asJson.ok === true && asJson.field === 'Science & Research', asJson);
}

// ── 4. It must never fire twice for the same user ─────────────────────────────────────────────
console.log('\nonce per user, once per demand');
{
  const d = ir.resolveDemand({ resumeMeta: CHEMIST, country: 'France' });

  const again = ir.decideRun(d, { ...CLEAR, demandRan: true });
  ok('re-uploading the same résumé costs nothing', again.ok === false && again.reason === 'already_researched', again);

  const used = ir.decideRun(d, { ...CLEAR, userRunCount: 1 });
  ok('one instant run per user, ever', used.ok === false && used.reason === 'user_cap', used);

  // …even for a DIFFERENT demand. Moving country or re-parsing into another field does not buy a
  // second run; the 12-hourly routine covers them from then on.
  const moved = ir.resolveDemand({ resumeMeta: BARISTA, country: 'Morocco' });
  ok('the second demand is genuinely different', moved.key !== d.key, [d.key, moved.key]);
  const movedRun = ir.decideRun(moved, { ...CLEAR, userRunCount: 1, cellCount: null });
  ok('…and it is still refused, because the user already had their run',
    movedRun.ok === false && movedRun.reason === 'user_cap', movedRun);

  ok('the shipped per-user cap is 1', ir.POLICY.MAX_PER_USER === 1, ir.POLICY.MAX_PER_USER);
}

// ── 5. The cost guard ─────────────────────────────────────────────────────────────────────────
// 578 thin cells × every signup is an unbounded AI bill. These are the walls.
console.log('\nthe cost guard');
{
  const d = ir.resolveDemand({ resumeMeta: CHEMIST, country: 'France' });

  ok('it ships DISARMED — the env flag defaults to off', ir.POLICY.ENABLED === false, ir.POLICY.ENABLED);
  const disarmed = ir.decideRun(d, { ...CLEAR, envEnabled: false });
  ok('disarmed beats everything else', disarmed.ok === false && disarmed.reason === 'disarmed', disarmed);

  const off = ir.decideRun(d, { ...CLEAR, switchOn: false });
  ok('the admin switch alone stops it', off.ok === false && off.reason === 'switch_off', off);

  const day = ir.decideRun(d, { ...CLEAR, runsToday: ir.POLICY.MAX_PER_DAY });
  ok('a global daily ceiling caps the spend across ALL users',
    day.ok === false && day.reason === 'daily_cap', day);
  const underDay = ir.decideRun(d, { ...CLEAR, runsToday: ir.POLICY.MAX_PER_DAY - 1 });
  ok('…and one below it still runs', underDay.ok === true, underDay);

  const full = ir.decideRun(d, { ...CLEAR, inFlight: 1, queued: ir.POLICY.QUEUE_MAX - 1 });
  ok('a signup burst queues, it does not fan out', full.ok === false && full.reason === 'queue_full', full);
  ok('the queue is short on purpose', ir.POLICY.QUEUE_MAX <= 5, ir.POLICY.QUEUE_MAX);

  const tester = ir.decideRun(d, { ...CLEAR, isTestAccount: true });
  ok('founder/QA accounts never spend research budget',
    tester.ok === false && tester.reason === 'test_account', tester);

  // The order matters: a switched-off system must not report "cell healthy" and hide the real reason.
  const both = ir.decideRun(d, { ...CLEAR, switchOn: false, cellCount: 900 });
  ok('the reason reported is the outermost one', both.reason === 'switch_off', both);
}

// ── 6. Nearest location first ─────────────────────────────────────────────────────────────────
// Every one of these strings is a real global_jobs.location value from the 895 French rows.
console.log('\nlocation ordering');
{
  ok('"Paris, France" parses', ir.parseLocation('Paris, France').city === 'Paris');
  ok('"Paris, Paris, France" keeps the city, not the region',
    ir.parseLocation('Paris, Paris, France').city === 'Paris', ir.parseLocation('Paris, Paris, France'));
  ok('"All France (remote)" is remote', ir.parseLocation('All France (remote)').remote === true);

  const u = { city: 'Paris', country: 'France' };
  ok('the user\'s own city ranks first', ir.locationRank('Paris, France', u) === 0);
  ok('"Paris 15" is the same city, not a different one', ir.locationRank('Paris 15, France', u) === 0,
    ir.locationRank('Paris 15, France', u));
  ok('a named district of the user\'s city ranks just behind it',
    ir.locationRank('Paris La Défense, France', u) === 1, ir.locationRank('Paris La Défense, France', u));
  ok('another French city is next', ir.locationRank('Montpellier, France', u) === 2);
  ok('country-wide/remote is after any named city', ir.locationRank('All France (remote)', u) === 3,
    ir.locationRank('All France (remote)', u));
  ok('an unparseable location is last', ir.locationRank('', u) === 4);

  const rows = [
    { location: 'All France (remote)', title: 'a' },
    { location: 'Montpellier, France', title: 'b' },
    { location: 'Paris, Paris, France', title: 'c' },
    { location: '', title: 'd' },
  ];
  const ordered = ir.orderByProximity(rows, u);
  ok('a mixed list sorts nearest-first',
    ordered.map((r) => r.title).join('') === 'cbad', ordered.map((r) => r.title));
  ok('ordering does not mutate the caller\'s array', rows[0].title === 'a', rows[0].title);

  // Without a city we cannot claim to know what is near — but country-wide still ranks behind a
  // named town, which is the part that actually matters.
  const noCity = ir.orderByProximity(rows, { country: 'France' });
  ok('with no user city the order is still sane, not random',
    noCity.map((r) => r.title).join('') === 'bcad', noCity.map((r) => r.title));
}

// ── 7. The push must open the job it is about ─────────────────────────────────────────────────
// The two job-match pushes used to send { sort: 'recent' } unconditionally, which dropped the user
// on the Explore feed to go and find the job the notification had just told them about.
console.log('\nwhere the push lands');
{
  const URL = 'https://boards.greenhouse.io/acme/jobs/12345';

  const one = ir.pickStandoutJob([{ job_url: URL, title: 'Lab Chemist', score: 1 }]);
  ok('a single new job is always the standout', one && one.job_url === URL, one);

  const params = ir.pushParamsForMatch(one);
  ok('the push carries a jobId', typeof params.jobId === 'string' && params.jobId.startsWith('gj_'), params);
  ok('…and it is the id the app resolves', params.jobId === ir.hashJobUrlId(URL), params);
  ok('…with no competing sort key', params.sort === undefined, params);

  const clear = ir.pickStandoutJob([
    { job_url: 'u1', title: 'Lab Chemist — Distillation', score: 4 },
    { job_url: 'u2', title: 'Warehouse Operative', score: 1 },
    { job_url: 'u3', title: 'Office Assistant', score: 0 },
  ]);
  ok('one job that clearly beats the rest is a standout', clear && clear.job_url === 'u1', clear);

  const flat = ir.pickStandoutJob([
    { job_url: 'u1', title: 'Chemist A', score: 3 },
    { job_url: 'u2', title: 'Chemist B', score: 3 },
    { job_url: 'u3', title: 'Chemist C', score: 2 },
  ]);
  ok('a genuine SET of similar jobs has no standout', flat === null, flat);
  ok('…so that push still opens the feed',
    ir.pushParamsForMatch(flat).sort === 'recent' && ir.pushParamsForMatch(flat).jobId === undefined,
    ir.pushParamsForMatch(flat));

  const weak = ir.pickStandoutJob([
    { job_url: 'u1', title: 'x', score: 1 },
    { job_url: 'u2', title: 'y', score: 0 },
  ]);
  ok('a barely-matching leader is not promoted to "the one job for you"', weak === null, weak);

  const noUrl = ir.pickStandoutJob([{ title: 'no url', score: 9 }]);
  ok('a job with no URL can never be deep-linked to', noUrl === null, noUrl);
  ok('…and that degrades to the feed, not to a broken link',
    ir.pushParamsForMatch(noUrl).sort === 'recent', ir.pushParamsForMatch(noUrl));

  // scoring is what separates "one job" from "a pile"
  const terms = [{ stem: 'chemist' }, { stem: 'distillation' }, { stem: 'reactor' }];
  ok('overlap counts DISTINCT résumé terms a job answers',
    ir.overlapScore({ title: 'Chemist — Distillation', skills: ['Batch Reactor'] }, terms) === 3,
    ir.overlapScore({ title: 'Chemist — Distillation', skills: ['Batch Reactor'] }, terms));
  ok('plain strings work as terms too', ir.overlapScore({ title: 'Lab Chemist', skills: [] }, ['chemist']) === 1);
  ok('an unrelated job scores zero', ir.overlapScore({ title: 'Truck Driver', skills: [] }, terms) === 0);
}

// ── 7a. The standout bar vs. what the CALL SITES actually feed it ─────────────────────────────
// A review found the interest-match push scoring every candidate against ONE skill (`[m.skill]`).
// overlapScore over a single term can only return 0 or 1, and pickStandoutJob needs minScore 2 AND
// a lead of 2 — so a standout was arithmetically IMPOSSIBLE for any user with more than one
// candidate, and every "1 new chemist job near Paris" push quietly fell back to the feed. These
// assertions pin the arithmetic and the two things the call site now has to do about it.
console.log('\nthe standout bar is reachable from the call site');
{
  const JOBS = [
    { job_url: 'u1', title: 'Lab Chemist — Distillation', skills: ['Batch Reactor', 'GMP'] },
    { job_url: 'u2', title: 'Warehouse Operative', skills: [] },
    { job_url: 'u3', title: 'Office Assistant', skills: [] },
  ];
  const oneTerm = JOBS.map((j) => ({ ...j, score: ir.overlapScore(j, ['chemist']) }));
  ok('a single search term can never score above 1', Math.max(...oneTerm.map((j) => j.score)) === 1,
    oneTerm.map((j) => j.score));
  ok('…so scoring on one term alone can never produce a standout', ir.pickStandoutJob(oneTerm) === null,
    ir.pickStandoutJob(oneTerm));

  const allTerms = JOBS.map((j) => ({ ...j, score: ir.overlapScore(j, ['chemist', 'gmp', 'reactor']) }));
  ok('scoring on ALL of the user\'s skills finds the obvious job',
    (ir.pickStandoutJob(allTerms) || {}).job_url === 'u1', ir.pickStandoutJob(allTerms));

  // Two saved interests matching the SAME posting must not look like a two-job tie.
  const dup = [
    { job_url: 'u1', title: 'Lab Chemist', skills: ['GMP'] },
    { job_url: 'u1', title: 'Lab Chemist', skills: ['GMP'] },
  ].map((j) => ({ ...j, score: ir.overlapScore(j, ['chemist', 'gmp']) }));
  ok('one job counted twice ties with itself and loses its deep-link', ir.pickStandoutJob(dup) === null,
    ir.pickStandoutJob(dup));

  // The call sites themselves, so this cannot regress back to the single-term form.
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'server', 'services', 'demandResearch.js'), 'utf8');
  ok('the interest push no longer scores on one skill', !/overlapScore\(j, \[m\.skill\]\)/.test(src));
  ok('it scores on every skill the user saved', /scoreTerms/.test(src) && /cur\.terms\.includes/.test(src));
  ok('it dedupes candidates by job_url', /cur\.seen\.has\(j\.job_url\)/.test(src));
  ok('a failed send does not consume the hand-back window',
    (src.match(/if \(pushed === true\) await ir\.markHandoffDone/g) || []).length === 2,
    (src.match(/markHandoffDone/g) || []).length);
}

// ── 7b. The id must be the SAME id the app and the admin tools mint ───────────────────────────
console.log('\nthe gj_ id contract');
{
  const ops = require(path.join(__dirname, '..', 'server', 'services', 'adminUserOps'));
  const samples = [
    'https://boards.greenhouse.io/acme/jobs/12345',
    'https://careers.example.fr/offre/chimiste-de-production?src=feed',
    'https://jobs.lever.co/x/abc-def',
  ];
  const same = samples.every((u) => ir.hashJobUrlId(u) === ops.hashJobUrlId(u));
  ok('hashJobUrlId is byte-identical to adminUserOps\' copy — a drifted hash is a dead deep-link', same,
    samples.map((u) => [ir.hashJobUrlId(u), ops.hashJobUrlId(u)]));
  ok('the id passes the app\'s own JOB_ID_RE', /^[A-Za-z0-9_.:-]{1,120}$/.test(ir.hashJobUrlId(samples[0])),
    ir.hashJobUrlId(samples[0]));
}

// ── 8. Handing back to the 12-hourly routine ──────────────────────────────────────────────────
// The 12-hourly push only looks at jobs first seen since ITS OWN run started. Jobs an instant run
// found three hours earlier are older than that, so without this the user would never be told about
// the very jobs we went and researched for them.
console.log('\nthe hand-back window');
{
  const runStart = '2026-08-04T12:00:00.000Z';
  const handoff = '2026-08-04T09:00:00.000Z';
  ok('no handoff → the routine\'s own window is untouched',
    ir.sinceForUser(runStart, null) === runStart, ir.sinceForUser(runStart, null));
  ok('a pending handoff widens the window back to the instant run',
    ir.sinceForUser(runStart, handoff) === new Date(handoff).toISOString(), ir.sinceForUser(runStart, handoff));
  ok('a handoff AFTER the run start never narrows the window',
    ir.sinceForUser(runStart, '2026-08-04T18:00:00.000Z') === runStart,
    ir.sinceForUser(runStart, '2026-08-04T18:00:00.000Z'));
  ok('a junk timestamp is ignored rather than blanking the window',
    ir.sinceForUser(runStart, 'not-a-date') === runStart, ir.sinceForUser(runStart, 'not-a-date'));
}

// ── 9. Registry + wiring sanity ───────────────────────────────────────────────────────────────
console.log('\nwiring');
{
  const switches = require(path.join(__dirname, '..', 'server', 'services', 'notifSwitch'));
  const entry = switches.SWITCHES.find((s) => s.key === 'instant_research');
  ok('the admin page has an off switch for it', !!entry, switches.SWITCHES.map((s) => s.key));
  ok('…whose copy says what it costs', !!entry && /grounded|cost/i.test(entry.description), entry && entry.description);

  const dr = require(path.join(__dirname, '..', 'server', 'services', 'demandResearch'));
  ok('the grounded discovery is REUSED, not reimplemented', typeof dr.discoverUrls === 'function');
  ok('so is the model factory', typeof dr.geminiGrounded === 'function');
  ok('so is the ingestion', typeof dr.ingestUrl === 'function');
  ok('and the filler-word list is shared, so the two paths cannot drift',
    dr.GENERIC_TERMS instanceof Set && dr.GENERIC_TERMS.has('communication'));

  const parser = require(path.join(__dirname, '..', 'services', 'resumeParserService'));
  ok('the parser module still loads with the new hook in it', typeof parser.triggerResumeParsingBackground === 'function');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
