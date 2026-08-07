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
eq("'tutorial' opens the explainer video",
  resolveRoute({ route: 'tutorial' }),
  { kind: 'navigate', pathname: '/(tutorial)', params: {} });

eq("'video' is an accepted alias for it",
  resolveRoute({ route: 'video' }),
  { kind: 'navigate', pathname: '/(tutorial)', params: {} });

ok("'tutorial' never lands on nothing (the how_it_works push depends on it)",
  resolveRoute({ route: 'tutorial' }).kind !== 'none');

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

  __setStorageForTests(null);
  __setNotificationsForTests(null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
