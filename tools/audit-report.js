// Summarise an audit-autofill2.js result file:
//   node tools/audit-report.js tools/corpus/audit-50-jobs-2026-08-05-HEAD.json
// Prints the key-anchored score, the old loose score beside it, the per-archetype breakdown, and
// every miss with the reason the verifier gave — because an aggregate percentage is exactly the
// shape of number that hides which widget is broken.
const fs = require('fs');
const f = process.argv[2];
const r = JSON.parse(fs.readFileSync(f, 'utf8'));
const reached = r.filter((x) => x.fields > 0);
const scored = r.filter((x) => x.targeted > 0);
let kh = 0, km = 0, lh = 0, lm = 0;
const arch = {};
r.forEach((x) => {
  if (x.keyed) { kh += x.keyed.hit; km += x.keyed.miss; }
  if (x.loose) { lh += x.loose.hit; lm += x.loose.miss; }
  Object.entries(x.archScore || {}).forEach(([a, s]) => { arch[a] = arch[a] || { hit: 0, miss: 0 }; arch[a].hit += s.hit; arch[a].miss += s.miss; });
});
const scanned = {};
r.forEach((x) => Object.entries(x.byArch || {}).forEach(([a, n]) => scanned[a] = (scanned[a] || 0) + n));
const pct = (h, m) => (h + m) ? (h / (h + m) * 100).toFixed(0) + '%' : '-';
console.log('FILE', f);
console.log('pages:', r.length, ' errors:', r.filter((x) => x.error).length, ' form reached (fields>0):', reached.length, ' scored (targeted>0):', scored.length);
console.log('submits:', r.reduce((n, x) => n + (x.submits || 0), 0));
console.log('KEY-ANCHORED: ' + kh + '/' + (kh + km) + ' = ' + pct(kh, km));
console.log('LOOSE (old verifier): ' + lh + '/' + (lh + lm) + ' = ' + pct(lh, lm));
const noRep = { hit: kh - ((arch['repeater'] || {}).hit || 0), miss: km - ((arch['repeater'] || {}).miss || 0) };
console.log('KEY-ANCHORED excl. repeaters: ' + noRep.hit + '/' + (noRep.hit + noRep.miss) + ' = ' + pct(noRep.hit, noRep.miss));
console.log('\nBY ARCHETYPE  (scanned = controls of that kind seen across all pages)');
const all = new Set([...Object.keys(arch), ...Object.keys(scanned)]);
[...all].sort().forEach((a) => {
  const s = arch[a] || { hit: 0, miss: 0 };
  console.log('  ' + a.padEnd(16) + ' scanned ' + String(scanned[a] || 0).padStart(4) + '   targeted ' + String(s.hit + s.miss).padStart(3) + '   landed ' + String(s.hit).padStart(3) + '  ' + pct(s.hit, s.miss));
});
console.log('\nPER PAGE');
scored.forEach((x) => console.log('  ' + (x.host + '                         ').slice(0, 26) + ' keyed ' + x.keyed.hit + '/' + (x.keyed.hit + x.keyed.miss) + '  loose ' + x.loose.hit + '/' + (x.loose.hit + x.loose.miss)));
console.log('\nMISSES');
r.forEach((x) => (x.perField || []).filter((p) => !p.hit).forEach((p) => console.log('  ' + (x.host + '                    ').slice(0, 22) + ' [' + p.arch + '] ' + (p.label || '').slice(0, 40) + ' want=' + p.wanted + ' :: ' + p.why)));
