// Unit test for the REAL notification-tap route resolver (services/pushRouting.ts).
// Plain node, no jest:   node MobileApp/scripts/test-push-routing.js
// Exits non-zero on any failure.
//
// It compiles the actual TypeScript module and requires the output — testing a hand-written JS copy
// of the rules would prove nothing about what ships.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadModule() {
  const ts = require('typescript');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'pushRouting.ts'), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const out = path.join(os.tmpdir(), 'cvf-pushRouting-' + process.pid + '.js');
  fs.writeFileSync(out, js);
  const mod = require(out);
  try { fs.unlinkSync(out); } catch (_) {}
  return mod;
}

const M = loadModule();
const { resolveRoute, handleNotificationRoute, handleNotificationResponse, handleColdStartNotification,
        takePendingNav, FOCUS_TARGET_KEY, HELP_OPEN_KEY, PENDING_NAV_KEY, PENDING_NAV_TTL_MS,
        __resetHandledForTests, __setStorageForTests, __setNotificationsForTests } = M;

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (got !== undefined ? '  → got ' + JSON.stringify(got) : '')); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), actual);

// ── 1. Every route in the contract ────────────────────────────────────────────────────────────
console.log('\ncontract routes');
eq("'/(discover)' + jobId opens that job",
  resolveRoute({ route: '/(discover)', params: { jobId: 'gj_1a2b3c' } }),
  { kind: 'navigate', pathname: '/(discover)', params: { jobId: 'gj_1a2b3c' } });

eq("'/(discover)' + sort:match",
  resolveRoute({ route: '/(discover)', params: { sort: 'match' } }),
  { kind: 'navigate', pathname: '/(discover)', params: { sort: 'match' } });

eq("'/(discover)' + sort:recent",
  resolveRoute({ route: '/(discover)', params: { sort: 'recent' } }),
  { kind: 'navigate', pathname: '/(discover)', params: { sort: 'recent' } });

eq("'/(discover)' with no params still navigates",
  resolveRoute({ route: '/(discover)' }),
  { kind: 'navigate', pathname: '/(discover)', params: {} });

eq("'/(ai-hub)' opens the Job Hub",
  resolveRoute({ route: '/(ai-hub)' }),
  { kind: 'navigate', pathname: '/(ai-hub)', params: {} });

eq("'/(ai-hub)' + a known tab keeps the tab",
  resolveRoute({ route: '/(ai-hub)', params: { tab: 'saved' } }),
  { kind: 'navigate', pathname: '/(ai-hub)', params: { tab: 'saved' } });

eq("'profile' writes the App.js handoff key",
  resolveRoute({ route: 'profile' }),
  { kind: 'handoff', handoff: 'profile', target: 'profile', storage: { key: FOCUS_TARGET_KEY, value: 'profile' } });
ok("the handoff key is the one App.js already consumes", FOCUS_TARGET_KEY === 'onboarding_focus_target', FOCUS_TARGET_KEY);

eq("'profile' + section picks that section",
  resolveRoute({ route: 'profile', params: { section: 'resume' } }),
  { kind: 'handoff', handoff: 'profile', target: 'resume', storage: { key: FOCUS_TARGET_KEY, value: 'resume' } });

eq("'profile' + a bogus section falls back to 'profile'",
  resolveRoute({ route: 'profile', params: { section: 'hack../../etc' } }),
  { kind: 'handoff', handoff: 'profile', target: 'profile', storage: { key: FOCUS_TARGET_KEY, value: 'profile' } });

eq("'help' flags the in-app guide",
  resolveRoute({ route: 'help' }),
  { kind: 'handoff', handoff: 'help', target: 'help', storage: { key: HELP_OPEN_KEY, value: '1' } });

eq("'guide' is the same thing as 'help'",
  resolveRoute({ route: 'guide' }),
  { kind: 'handoff', handoff: 'help', target: 'help', storage: { key: HELP_OPEN_KEY, value: '1' } });

// The explainer film. 'tutorial' used to be an alias of 'help'; it now has a screen of its own.
// The wire value was kept BECAUSE of that history — a build shipped before this screen exists
// resolves 'tutorial' to the guide rather than to nothing, so the how_it_works push is safe to
// send while some of the fleet is still on an older build.
// `reuse: true` = navigate, not push: a tutorial push tapped while the tutorial is open retargets it.
eq("'tutorial' opens the explainer video",
  resolveRoute({ route: 'tutorial' }),
  { kind: 'navigate', pathname: '/(tutorial)', params: {}, reuse: true });

eq("'video' is an accepted alias for it",
  resolveRoute({ route: 'video' }),
  { kind: 'navigate', pathname: '/(tutorial)', params: {}, reuse: true });

ok("'tutorial' never lands on nothing (the how_it_works push depends on it)",
  resolveRoute({ route: 'tutorial' }).kind !== 'none');

// ── The tutorial opens ON the clip the push is about ──────────────────────────────────────────
// ⚠️ 2026-09-19: this case used to return params {} whatever the payload said, so the screen fell
// back to clip 01 "Set up your profile" — the owner tapped "Watch the app fill a job form for you"
// and had to hunt through the chapter strip for the form-filling part.
console.log('\ntutorial clip');
const NID = '3f2b9c1e-8a4d-4f6b-9c2e-1a2b3c4d5e6f';
const tut = (params) => ({ kind: 'navigate', pathname: '/(tutorial)', params, reuse: true });

eq('film + until pass through',
  resolveRoute({ route: 'tutorial', params: { film: 'cover_letter', until: 'apply' } }),
  tut({ film: 'cover_letter', until: 'apply' }));
eq('a film alone opens that clip',
  resolveRoute({ route: 'tutorial', params: { film: 'apply' } }), tut({ film: 'apply' }));
eq("a clip's on-screen number works ('5' → apply)",
  resolveRoute({ route: 'tutorial', params: { film: '5' } }), tut({ film: 'apply' }));
eq("…zero-padded too ('04' → cover_letter)",
  resolveRoute({ route: 'tutorial', params: { film: '04' } }), tut({ film: 'cover_letter' }));
eq('…and as a number (4 → cover_letter)',
  resolveRoute({ route: 'tutorial', params: { film: 4 } }), tut({ film: 'cover_letter' }));
eq('key case is forgiven',
  resolveRoute({ route: 'tutorial', params: { film: 'Cover_Letter' } }), tut({ film: 'cover_letter' }));
eq('an unknown film is dropped (opens 01, as before — never a guessed clip)',
  resolveRoute({ route: 'tutorial', params: { film: 'autofill' } }), tut({}));
eq('a hostile film is dropped',
  resolveRoute({ route: 'tutorial', params: { film: '../../(admin)/users' } }), tut({}));
eq('an out-of-range number is dropped (6)',
  resolveRoute({ route: 'tutorial', params: { film: '6' } }), tut({}));
eq('…and 0',
  resolveRoute({ route: 'tutorial', params: { film: '0' } }), tut({}));
eq('a non-scalar film is dropped',
  resolveRoute({ route: 'tutorial', params: { film: { key: 'apply' } } }), tut({}));
eq('an until BEFORE the film is dropped (it would chain nothing)',
  resolveRoute({ route: 'tutorial', params: { film: 'apply', until: 'profile' } }), tut({ film: 'apply' }));
eq('an until EQUAL to the film is dropped',
  resolveRoute({ route: 'tutorial', params: { film: 'apply', until: 'apply' } }), tut({ film: 'apply' }));
eq('an until with no film is dropped',
  resolveRoute({ route: 'tutorial', params: { until: 'apply' } }), tut({}));
eq('an unknown until is dropped, the film kept',
  resolveRoute({ route: 'tutorial', params: { film: 'resume', until: 'forever' } }), tut({ film: 'resume' }));
eq('params as a JSON string still carry the film',
  resolveRoute({ route: 'tutorial', params: '{"film":"cover_letter","until":"apply"}' }),
  tut({ film: 'cover_letter', until: 'apply' }));
eq("the 'video' alias carries the film too",
  resolveRoute({ route: 'video', params: { film: 'save_job' } }), tut({ film: 'save_job' }));
eq('extra params are not forwarded',
  resolveRoute({ route: 'tutorial', params: { film: 'apply', redirect: 'https://evil.example' } }), tut({ film: 'apply' }));
// The push's own id (top level of `data`, stamped by the server on every push) now reaches the
// screen, so a watch is credited to the campaign — 0 of the tutorial events in production had one.
eq('the push nid rides along to the screen',
  resolveRoute({ route: 'tutorial', params: { film: 'apply' }, nid: NID }), tut({ film: 'apply', nid: NID }));
eq('a junk nid is dropped',
  resolveRoute({ route: 'tutorial', params: { film: 'apply' }, nid: "x'; DROP TABLE push_sends" }), tut({ film: 'apply' }));
eq('a nid with no film still attributes (and opens 01)',
  resolveRoute({ route: 'tutorial', nid: NID }), tut({ nid: NID }));
ok('only the tutorial asks to reuse its screen — every other route still pushes',
  ['/(discover)', '/(ai-hub)', 'support', 'usage', 'plans', 'rewards', 'admin-support'].every((r) => resolveRoute({ route: r }).reuse === undefined));

// Lockstep: the router's clip list IS the screen's FILMS table, in order. A clip renamed on one side
// only would silently open 01 again — the very bug this fixes.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', '(tutorial)', 'index.tsx'), 'utf8');
  const block = src.match(/const FILMS = \[([\s\S]*?)\] as const;/);
  const keys = block ? [...block[1].matchAll(/key:\s*'([a-z_]+)'/g)].map((m) => m[1]) : [];
  eq("TUTORIAL_FILMS is the tutorial screen's FILMS keys, in order", M.TUTORIAL_FILMS, keys);
}

// End to end across the wire: render the REAL server template and feed what it sends into the REAL
// resolver. Pins the template → clip mapping, not just each half of it.
{
  const T = require(path.join(__dirname, '..', '..', 'server', 'services', 'notifyTemplates'));
  const tutorialTpls = T.TEMPLATES.filter((t) => t.route === 'tutorial');
  ok('the server has at least one tutorial template', tutorialTpls.length > 0);
  for (const tpl of tutorialTpls) {
    const r = T.render(tpl, { state: {} });
    const a = resolveRoute({ route: r.route, params: r.params, nid: NID });
    ok(`${tpl.key}: the app opens the clip the server named (never 01 by default)`,
      a.kind === 'navigate' && !!a.params.film && a.params.film === r.params.film
        && (r.params.until === undefined || a.params.until === r.params.until), { sent: r.params, opened: a.params });
  }
  const how = T.get('how_it_works');
  const r = T.render(how, { state: {} });
  eq("how_it_works ('Watch the app fill a job form') → clip 04, playing on into 05",
    resolveRoute({ route: r.route, params: r.params, nid: NID }).params,
    { film: 'cover_letter', until: 'apply', nid: NID });
}

// ── Lifecycle-nudge destinations (build 143) ──────────────────────────────────────────────────
// These exist because the automated nudges point at them. A nudge whose route the app silently
// ignores is worse than no nudge: we spent the one interruption we are allowed and delivered
// nothing. Every route string used in server/services/notifyTemplates.js must appear here.
eq("'support' + focus opens the issue picker",
  resolveRoute({ route: 'support', params: { focus: '1' } }),
  { kind: 'navigate', pathname: '/(support)', params: { focus: '1' } });

eq("'support' with no params still opens Help & support",
  resolveRoute({ route: 'support' }),
  { kind: 'navigate', pathname: '/(support)', params: {} });

eq("'support' + issue preselects that card",
  resolveRoute({ route: 'support', params: { focus: '1', issue: 'cover_letter' } }),
  { kind: 'navigate', pathname: '/(support)', params: { focus: '1', issue: 'cover_letter' } });

eq("a hostile issue key is dropped, not passed through",
  resolveRoute({ route: 'support', params: { issue: '../../admin' } }),
  { kind: 'navigate', pathname: '/(support)', params: {} });

ok("a thread id still wins over focus (a reply is more specific than a prompt)",
  resolveRoute({ route: 'support', params: { focus: '1', threadId: '42' } }).pathname === '/(support)/thread',
  resolveRoute({ route: 'support', params: { focus: '1', threadId: '42' } }));

eq("'usage' opens Plans & Usage",
  resolveRoute({ route: 'usage' }),
  { kind: 'navigate', pathname: '/(subscription)/usage', params: {} });

eq("'plans' opens the plan list",
  resolveRoute({ route: 'plans' }),
  { kind: 'navigate', pathname: '/(subscription)/plans', params: {} });

eq("'rewards' opens Earn credits",
  resolveRoute({ route: 'rewards' }),
  { kind: 'navigate', pathname: '/(rewards)', params: {} });

// Every route the SERVER can emit must resolve. This is the assertion that would have caught a
// template pointing at a route the app never learned.
{
  const serverRoutes = ['/(discover)', '/(ai-hub)', 'profile', 'help', 'support', 'usage', 'rewards', 'tutorial'];
  const dead = serverRoutes.filter((r) => resolveRoute({ route: r }).kind === 'none');
  ok('every route in the server contract resolves to something', dead.length === 0, dead);
}

// ── 2. Malformed / hostile input → never navigate anywhere ────────────────────────────────────
console.log('\nmalformed input');
const isNone = (a) => a && a.kind === 'none' && !a.pathname && !a.storage;

ok('null data', isNone(resolveRoute(null)), resolveRoute(null));
ok('undefined data', isNone(resolveRoute(undefined)), resolveRoute(undefined));
ok('empty object', isNone(resolveRoute({})), resolveRoute({}));
ok('string data', isNone(resolveRoute('/(discover)')), resolveRoute('/(discover)'));
ok('number data', isNone(resolveRoute(42)), resolveRoute(42));
ok('array data', isNone(resolveRoute([{ route: '/(discover)' }])), resolveRoute([{ route: '/(discover)' }]));
ok('missing route', isNone(resolveRoute({ params: { jobId: 'gj_1' } })), resolveRoute({ params: { jobId: 'gj_1' } }));
ok('empty route', isNone(resolveRoute({ route: '' })), resolveRoute({ route: '' }));
ok('whitespace route', isNone(resolveRoute({ route: '   ' })), resolveRoute({ route: '   ' }));
ok('route is not a string', isNone(resolveRoute({ route: { pathname: '/(discover)' } })), resolveRoute({ route: {} }));
ok('unknown route', isNone(resolveRoute({ route: '/(admin)/store-analytics' })), resolveRoute({ route: '/(admin)/store-analytics' }));
ok('unknown route reason is explicit', resolveRoute({ route: 'nope' }).reason === 'unknown-route', resolveRoute({ route: 'nope' }));
ok('no-data reason is explicit', resolveRoute(null).reason === 'no-data');
ok('no-route reason is explicit', resolveRoute({}).reason === 'no-route');

console.log('\nmalformed params');
eq('params as a JSON string is parsed',
  resolveRoute({ route: '/(discover)', params: '{"jobId":"gj_zz9"}' }),
  { kind: 'navigate', pathname: '/(discover)', params: { jobId: 'gj_zz9' } });

eq('params as a NON-JSON string is ignored (still navigates)',
  resolveRoute({ route: '/(discover)', params: 'jobId=gj_1' }),
  { kind: 'navigate', pathname: '/(discover)', params: {} });

eq('params as an array is ignored',
  resolveRoute({ route: '/(discover)', params: ['gj_1'] }),
  { kind: 'navigate', pathname: '/(discover)', params: {} });

eq('params as a number is ignored',
  resolveRoute({ route: '/(discover)', params: 7 }),
  { kind: 'navigate', pathname: '/(discover)', params: {} });

eq('params null is ignored',
  resolveRoute({ route: '/(discover)', params: null }),
  { kind: 'navigate', pathname: '/(discover)', params: {} });

eq('a nested-object jobId is dropped',
  resolveRoute({ route: '/(discover)', params: { jobId: { evil: 1 } } }),
  { kind: 'navigate', pathname: '/(discover)', params: {} });

eq('a path-traversal jobId is dropped',
  resolveRoute({ route: '/(discover)', params: { jobId: '../../admin/users' } }),
  { kind: 'navigate', pathname: '/(discover)', params: {} });

eq('an over-long jobId is dropped',
  resolveRoute({ route: '/(discover)', params: { jobId: 'g'.repeat(200) } }),
  { kind: 'navigate', pathname: '/(discover)', params: {} });

eq('an unknown sort is dropped',
  resolveRoute({ route: '/(discover)', params: { sort: 'DROP TABLE' } }),
  { kind: 'navigate', pathname: '/(discover)', params: {} });

eq('an unknown ai-hub tab is dropped',
  resolveRoute({ route: '/(ai-hub)', params: { tab: 'admin' } }),
  { kind: 'navigate', pathname: '/(ai-hub)', params: {} });

eq('extra unexpected params are not forwarded',
  resolveRoute({ route: '/(discover)', params: { jobId: 'gj_1', redirect: 'https://evil.example' } }),
  { kind: 'navigate', pathname: '/(discover)', params: { jobId: 'gj_1' } });

// ── 3. Route spelling tolerance (senders are not always exact) ────────────────────────────────
console.log('\nroute spelling');
const disc = { kind: 'navigate', pathname: '/(discover)', params: {} };
eq("'(discover)'", resolveRoute({ route: '(discover)' }), disc);
eq("'discover'", resolveRoute({ route: 'discover' }), disc);
eq("'  /(DISCOVER)/  '", resolveRoute({ route: '  /(DISCOVER)/  ' }), disc);
eq("'/(ai-hub)/' trailing slash", resolveRoute({ route: '/(ai-hub)/' }), { kind: 'navigate', pathname: '/(ai-hub)', params: {} });

// ── 4. handleNotificationRoute actually performs the decision ─────────────────────────────────
console.log('\nhandleNotificationRoute');
(async () => {
  const mkRouter = () => {
    const calls = [];
    return {
      calls,
      push: (href) => calls.push(['push', href]),
      canDismiss: () => true,
      dismissAll: () => calls.push(['dismissAll']),
    };
  };

  let r = mkRouter();
  await handleNotificationRoute({ route: '/(discover)', params: { jobId: 'gj_abc' } }, r);
  eq('navigate → router.push with pathname + params', r.calls,
    [['push', { pathname: '/(discover)', params: { jobId: 'gj_abc' } }]]);

  r = mkRouter();
  await handleNotificationRoute({ route: 'profile' }, r);
  eq('handoff → pops to App.js, never pushes', r.calls, [['dismissAll']]);

  r = mkRouter();
  await handleNotificationRoute({ route: 'who-knows' }, r);
  eq('unknown route → no navigation at all', r.calls, []);

  r = mkRouter();
  await handleNotificationRoute(null, r);
  eq('null data → no navigation at all', r.calls, []);

  // A router that throws must not blow up the tap handler.
  const boom = { push: () => { throw new Error('router exploded'); }, canDismiss: () => { throw new Error('nope'); }, dismissAll: () => {} };
  let threw = false;
  try { await handleNotificationRoute({ route: '/(discover)', params: { jobId: 'gj_1' } }, boom); } catch (_) { threw = true; }
  ok('a throwing router is swallowed', threw === false);
  threw = false;
  try { await handleNotificationRoute({ route: 'profile' }, null); } catch (_) { threw = true; }
  ok('a null router is survivable', threw === false);

  // The tutorial goes through router.navigate: in expo-router 6 a NAVIGATE to the screen already on
  // top REPLACES its params (same key), where PUSH stacked a second player over a first one that
  // kept talking. From anywhere else navigate appends, exactly like push.
  const mkNavRouter = () => {
    const calls = [];
    return {
      calls,
      push: (href) => calls.push(['push', href]),
      navigate: (href) => calls.push(['navigate', href]),
      canDismiss: () => true,
      dismissAll: () => calls.push(['dismissAll']),
    };
  };
  r = mkNavRouter();
  await handleNotificationRoute({ route: 'tutorial', params: { film: 'cover_letter', until: 'apply' }, nid: NID }, r);
  eq('tutorial → router.navigate with film + until + nid', r.calls,
    [['navigate', { pathname: '/(tutorial)', params: { film: 'cover_letter', until: 'apply', nid: NID } }]]);
  r = mkRouter();
  await handleNotificationRoute({ route: 'tutorial', params: { film: 'apply' } }, r);
  eq('…falling back to push on a router without navigate', r.calls,
    [['push', { pathname: '/(tutorial)', params: { film: 'apply' } }]]);
  r = mkNavRouter();
  await handleNotificationRoute({ route: '/(discover)', params: { jobId: 'gj_abc' } }, r);
  eq('every other route still pushes, even when navigate exists', r.calls,
    [['push', { pathname: '/(discover)', params: { jobId: 'gj_abc' } }]]);
  const boomNav = { navigate: () => { throw new Error('navigate exploded'); }, push: () => {} };
  threw = false;
  try { await handleNotificationRoute({ route: 'tutorial', params: { film: 'apply' } }, boomNav); } catch (_) { threw = true; }
  ok('a throwing navigate is swallowed', threw === false);

  // ── 4. The hand-off must actually COMPLETE ──────────────────────────────────────────────────
  // Writing the focus key is only half a profile deep link; App.js never reads it unless something
  // puts the app on the profile screen. takePendingNav is the request HomeScreen picks up, and it
  // was the missing half — six templates pointed at a route that silently did nothing.
  console.log('\nhand-off completion');
  const mkStore = (seed) => {
    const m = Object.assign({}, seed || {});
    return {
      dump: m,
      getItem: async (k) => (k in m ? m[k] : null),
      setItem: async (k, v) => { m[k] = String(v); },
      removeItem: async (k) => { delete m[k]; },
    };
  };

  let store = mkStore();
  __setStorageForTests(store);
  await handleNotificationRoute({ route: 'profile', params: { section: 'photo' } }, mkRouter());
  ok('profile tap leaves a pending request for HomeScreen', !!store.dump[PENDING_NAV_KEY], store.dump[PENDING_NAV_KEY]);
  eq('…and the section App.js will read', store.dump[FOCUS_TARGET_KEY], 'photo');
  let taken = await takePendingNav();
  eq('HomeScreen takes it', taken && { handoff: taken.handoff, target: taken.target }, { handoff: 'profile', target: 'photo' });
  ok('taking it consumes it (no replay on the next focus)', !(PENDING_NAV_KEY in store.dump));
  ok('a second take returns nothing', (await takePendingNav()) === null);

  store = mkStore();
  __setStorageForTests(store);
  await handleNotificationRoute({ route: 'help' }, mkRouter());
  taken = await takePendingNav();
  eq('help tap asks HomeScreen for the guide', taken && taken.handoff, 'help');

  // The stale-request case: a tap that never landed must NOT hijack a later visit.
  store = mkStore({
    [PENDING_NAV_KEY]: JSON.stringify({ handoff: 'profile', target: 'resume', at: Date.now() - (PENDING_NAV_TTL_MS + 60000) }),
    [FOCUS_TARGET_KEY]: 'resume',
  });
  __setStorageForTests(store);
  ok('an expired request is ignored', (await takePendingNav()) === null);
  ok('…and its orphaned focus key is cleared, so Account Settings is not hijacked later',
    !(FOCUS_TARGET_KEY in store.dump), store.dump);

  store = mkStore({ [PENDING_NAV_KEY]: 'not json at all' });
  __setStorageForTests(store);
  ok('a corrupt request is ignored and dropped', (await takePendingNav()) === null && !(PENDING_NAV_KEY in store.dump));

  // ── 5. One tap = one navigation (warm listener + cold start must not both fire) ──────────────
  console.log('\ntap de-duplication');
  const mkResponse = (id, data) => ({ notification: { date: 1, request: { identifier: id, content: { data } } } });

  store = mkStore(); __setStorageForTests(store); __resetHandledForTests();
  let r2 = mkRouter();
  await handleNotificationResponse(mkResponse('tap-1', { route: '/(discover)', params: { jobId: 'gj_x' } }), r2);
  await handleNotificationResponse(mkResponse('tap-1', { route: '/(discover)', params: { jobId: 'gj_x' } }), r2);
  eq('the same tap delivered twice navigates once', r2.calls.length, 1);

  r2 = mkRouter();
  await handleNotificationResponse(mkResponse('tap-2', { route: '/(ai-hub)' }), r2);
  eq('a different tap still navigates', r2.calls.length, 1);

  // Cold start: the OS hands back the launch response, which must be acted on exactly once and then
  // never replayed on a later launch.
  store = mkStore(); __setStorageForTests(store); __resetHandledForTests();
  let cleared = 0;
  const lastResponse = mkResponse('cold-1', { route: '/(discover)', params: { sort: 'match' } });
  __setNotificationsForTests({
    getLastNotificationResponseAsync: async () => lastResponse,
    clearLastNotificationResponseAsync: async () => { cleared++; },
  });
  r2 = mkRouter();
  await handleColdStartNotification(r2);
  eq('cold start navigates', r2.calls, [['push', { pathname: '/(discover)', params: { sort: 'match' } }]]);
  ok('cold start clears the OS response so it cannot replay', cleared === 1, cleared);

  // Simulate the next launch: same stale response still returned by the OS, fresh JS memory.
  __resetHandledForTests();
  r2 = mkRouter();
  await handleColdStartNotification(r2);
  eq('the SAME response on a later launch does not navigate again', r2.calls, []);

  // And the warm listener must not re-handle what cold start already did.
  __resetHandledForTests();
  r2 = mkRouter();
  await handleNotificationResponse(lastResponse, r2);
  eq('the warm listener does not re-handle the cold-start tap', r2.calls, []);

  // ── 6. The tutorial push, through BOTH tap paths, lands on its clip ─────────────────────────
  // The owner's tap was a COLD start (push_opens cold_start=true, build 209) and landed on 01.
  console.log('\ntutorial push → its clip (warm + cold)');
  const tutData = (nid) => ({ type: 'reminder', route: 'tutorial', params: { film: 'cover_letter', until: 'apply' }, templateKey: 'how_it_works', nid });
  const NID2 = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

  store = mkStore(); __setStorageForTests(store); __resetHandledForTests();
  r2 = mkNavRouter();
  await handleNotificationResponse(mkResponse('warm-tut-1', tutData(NID)), r2);
  eq('WARM tap opens clip 04 and plays on to 05', r2.calls,
    [['navigate', { pathname: '/(tutorial)', params: { film: 'cover_letter', until: 'apply', nid: NID } }]]);
  // A second push of the same kind, tapped while the first is still on screen: a new nid, so the
  // screen sees a new request (and navigate retargets it instead of stacking a second player).
  await handleNotificationResponse(mkResponse('warm-tut-2', tutData(NID2)), r2);
  eq('a second tutorial tap is a new request (new nid), again via navigate', r2.calls[1],
    ['navigate', { pathname: '/(tutorial)', params: { film: 'cover_letter', until: 'apply', nid: NID2 } }]);

  store = mkStore(); __setStorageForTests(store); __resetHandledForTests();
  let clearedTut = 0;
  __setNotificationsForTests({
    getLastNotificationResponseAsync: async () => mkResponse('cold-tut-1', tutData(NID)),
    clearLastNotificationResponseAsync: async () => { clearedTut++; },
  });
  r2 = mkNavRouter();
  await handleColdStartNotification(r2);
  eq('COLD START opens clip 04 and plays on to 05', r2.calls,
    [['navigate', { pathname: '/(tutorial)', params: { film: 'cover_letter', until: 'apply', nid: NID } }]]);
  ok('…and the launch response is cleared so it cannot replay', clearedTut === 1, clearedTut);

  // Older payload (no film — what every tutorial push sent before 2026-09-19): still opens the
  // tutorial, at 01, exactly as before. Nothing about an old push got worse.
  store = mkStore(); __setStorageForTests(store); __resetHandledForTests();
  r2 = mkNavRouter();
  await handleNotificationResponse(mkResponse('old-tut', { route: 'tutorial', params: {} }), r2);
  eq('an old film-less tutorial push still opens the tutorial at 01', r2.calls,
    [['navigate', { pathname: '/(tutorial)', params: {} }]]);

  __setStorageForTests(null);
  __setNotificationsForTests(null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
