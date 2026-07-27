// Unit test for the REAL admin environment switch (MobileApp/config.js).
// Plain node, no jest:   node MobileApp/scripts/test-environment-config.js
// Exits non-zero on any failure.
//
// config.js is shipped ES-module JS, so it is compiled with the local typescript package and the
// OUTPUT is required — testing a hand-written copy of the rules would prove nothing about what
// ships. `__DEV__` is read at module load, so each load sets global.__DEV__ first and pulls a
// FRESH module instance (unique temp filename ⇒ no require-cache reuse).
//
// The property under test: an admin can point their own device at a known environment, and
// NOTHING — unknown key, empty string, null, a number, an object, a raw attacker url — can point
// the app at an arbitrary host.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.js');
let loadCount = 0;

function loadConfig(dev) {
  const ts = require('typescript');
  const src = fs.readFileSync(CONFIG_PATH, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const out = path.join(os.tmpdir(), 'cvf-config-' + process.pid + '-' + ++loadCount + '.js');
  fs.writeFileSync(out, js);
  global.__DEV__ = dev;
  const mod = require(out);
  try { fs.unlinkSync(out); } catch (_) {}
  return mod;
}

// API_BASE is an exported `let` (live binding). It must be read off the module object every time —
// destructuring it once would snapshot the pre-switch value, which is exactly the bug config.js
// warns about.
const base = (M) => M.API_BASE;

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (got !== undefined ? '  → got ' + JSON.stringify(got) : '')); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), actual);

// ── 1. No override: the compile-time default is what every normal user gets ────────────────────
console.log('\nno override — release build (__DEV__ = false)');
const REL = loadConfig(false);
ok('API_BASE === DEFAULT_API_BASE', base(REL) === REL.DEFAULT_API_BASE, base(REL));
eq('DEFAULT_API_BASE is the production url', REL.DEFAULT_API_BASE, REL.PRODUCTION_API_URL);
eq('defaultEnvironmentKey() is production', REL.defaultEnvironmentKey(), 'production');
eq('currentEnvironmentKey() is production', REL.currentEnvironmentKey(), 'production');
eq('default export getter agrees', REL.default.API_BASE_URL, base(REL));

console.log('\nno override — dev build (__DEV__ = true)');
const DEV = loadConfig(true);
ok('API_BASE === DEFAULT_API_BASE', base(DEV) === DEV.DEFAULT_API_BASE, base(DEV));
eq('DEFAULT_API_BASE is the LAN url', DEV.DEFAULT_API_BASE, DEV.LOCAL_API_URL);
eq('defaultEnvironmentKey() is local', DEV.defaultEnvironmentKey(), 'local');
eq('currentEnvironmentKey() is local', DEV.currentEnvironmentKey(), 'local');
eq('default export getter agrees', DEV.default.API_BASE_URL, base(DEV));

// ── 2. urlForEnvironment: known keys only ──────────────────────────────────────────────────────
console.log('\nurlForEnvironment');
eq("'production' → the production url", REL.urlForEnvironment('production'), REL.PRODUCTION_API_URL);
eq("'local' → the LAN url", REL.urlForEnvironment('local'), REL.LOCAL_API_URL);

// ── 3. The switch itself ───────────────────────────────────────────────────────────────────────
console.log('\napplyEnvironmentOverride — the happy path');
const S = loadConfig(false);
const snapshotAtImport = S.default.API_BASE_URL; // what a naive `const X = API_BASE` would capture

eq("applyEnvironmentOverride('local') returns 'local'", S.applyEnvironmentOverride('local'), 'local');
eq('API_BASE is now LOCAL_API_URL', base(S), S.LOCAL_API_URL);
eq("currentEnvironmentKey() reports 'local'", S.currentEnvironmentKey(), 'local');
eq('DEFAULT_API_BASE is untouched by the switch', S.DEFAULT_API_BASE, S.PRODUCTION_API_URL);
eq("defaultEnvironmentKey() still reports the BUILD default, not the override", S.defaultEnvironmentKey(), 'production');

console.log('\nthe default export is a live getter, not an import-time snapshot');
eq('default.API_BASE_URL reflects the CURRENT value', S.default.API_BASE_URL, S.LOCAL_API_URL);
ok('…and is NOT the value it had at import', S.default.API_BASE_URL !== snapshotAtImport, S.default.API_BASE_URL);
eq('the value captured at import was the production url', snapshotAtImport, S.PRODUCTION_API_URL);

console.log('\napplyEnvironmentOverride — switching back');
eq("applyEnvironmentOverride('production') returns 'production'", S.applyEnvironmentOverride('production'), 'production');
eq('API_BASE is back to PRODUCTION_API_URL', base(S), S.PRODUCTION_API_URL);
eq("currentEnvironmentKey() reports 'production'", S.currentEnvironmentKey(), 'production');
eq('default export getter followed it back', S.default.API_BASE_URL, S.PRODUCTION_API_URL);

// ── 4. Nothing can point the app at an arbitrary host ──────────────────────────────────────────
// Every one of these must: leave API_BASE exactly as it was, and return the BUILD default key.
const HOSTILE = [
  ['an unknown key', 'staging'],
  ['an empty string', ''],
  ['null', null],
  ['undefined', undefined],
  ['a number', 8080],
  ['zero', 0],
  ['an object', { key: 'local', url: 'https://evil.example.com/api' }],
  ['a raw url', 'https://evil.example.com/api'],
  ['a raw url that looks internal', 'http://192.168.1.16:3000/api'],
  ['an ENVIRONMENTS-shaped object', { key: 'production' }],
  ['an array', ['local']],
  ['a boolean', true],
  ['a function', function () { return 'local'; }],
  ['wrong case', 'LOCAL'],
  ['padded whitespace', ' local '],
  ['__proto__', '__proto__'],
  ['constructor', 'constructor'],
  ['toString', 'toString'],
  ['a key with a url appended', 'local https://evil.example.com'],
  ['NaN', NaN],
];

const describe = (v) => {
  try { return typeof v === 'function' ? '[function]' : JSON.stringify(v); } catch (_) { return String(v); }
};

console.log('\nhostile / unknown input — from the untouched default (production)');
const A = loadConfig(false);
const beforeA = base(A);
for (const [label, value] of HOSTILE) {
  const ret = A.applyEnvironmentOverride(value);
  ok(label + ' (' + describe(value) + ') leaves API_BASE unchanged', base(A) === beforeA, base(A));
  ok(label + ' returns the default key', ret === 'production', ret);
}
ok('after the whole hostile sweep API_BASE is still the production url', base(A) === A.PRODUCTION_API_URL, base(A));
eq('…and currentEnvironmentKey() never went custom', A.currentEnvironmentKey(), 'production');

console.log('\nhostile / unknown input — while legitimately overridden to local');
const B = loadConfig(false);
eq('precondition: switched to local', B.applyEnvironmentOverride('local'), 'local');
const beforeB = base(B);
for (const [label, value] of HOSTILE) {
  const ret = B.applyEnvironmentOverride(value);
  ok(label + ' does not move API_BASE off local', base(B) === beforeB, base(B));
  ok(label + ' still returns the BUILD default key (production)', ret === 'production', ret);
}
eq('the live getter never saw a foreign host', B.default.API_BASE_URL, B.LOCAL_API_URL);

console.log('\nhostile / unknown input — urlForEnvironment returns null');
for (const [label, value] of HOSTILE) {
  ok(label + ' → null', REL.urlForEnvironment(value) === null, REL.urlForEnvironment(value));
}

console.log('\nthe reachable set of hosts is closed');
const ALLOWED = [REL.PRODUCTION_API_URL, REL.LOCAL_API_URL];
const C = loadConfig(false);
let escaped = null;
for (const [, value] of HOSTILE.concat([['known', 'local'], ['known', 'production']])) {
  C.applyEnvironmentOverride(value);
  if (!ALLOWED.includes(base(C))) { escaped = base(C); break; }
}
ok('API_BASE is only ever one of the two declared urls', escaped === null, escaped);
eq('ENVIRONMENTS declares exactly the two known environments',
  C.ENVIRONMENTS.map((e) => e.key), ['production', 'local']);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
