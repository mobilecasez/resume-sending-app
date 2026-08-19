// The résumé score lands UNPROMPTED on a user's home screen, so whatever the model returns has to
// survive contact with the UI. These assertions cover the two places that can break in production:
// normalise() (garbage in from the model) and bandFor() (the label under the number).
//
// No database and no network: normalise/bandFor are pulled out of the source and run standalone.
const fs = require('fs');
const path = '/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app/server/services/resumeScorer.js';
const src = fs.readFileSync(path, 'utf8');

const grab = (re, what) => { const m = src.match(re); if (!m) throw new Error('could not extract ' + what); return m[0]; };
const harness = [
  grab(/const clampInt = [^\n]*\n/, 'clampInt'),
  grab(/const str = [^\n]*\n/, 'str'),
  grab(/function bandFor\(score\)[\s\S]*?\n}\n/, 'bandFor'),
  grab(/function normalise\(raw\)[\s\S]*?\n}\n/, 'normalise'),
  'module.exports = { normalise, bandFor };',
].join('\n');
const m = new module.constructor();
m._compile(harness, '/resume-score-harness.js');
const { normalise, bandFor } = m.exports;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };
const threw = (name, fn) => { try { fn(); fail++; console.log('  ✗ ' + name + ' → expected a throw, got none'); } catch { pass++; } };

const GOOD = JSON.stringify({
  score: 61, subscores: { impact: 48, clarity: 70, keywords: 55, completeness: 72 },
  headline: 'Your achievements read as duties, not results',
  summary: 'Solid experience, but almost nothing is quantified. Add numbers and this jumps.',
  improvements: [
    { title: 'Quantify your top 5 bullets', detail: 'Add a number to each — team size, %, revenue, time saved.' },
    { title: 'Lead with the outcome', detail: 'Start each bullet with what changed, not what you were assigned.' },
    { title: 'Add a skills section', detail: 'List the tools and platforms a recruiter would search for.' },
  ],
});

// ── happy path ────────────────────────────────────────────────────────────────────────────────
const g = normalise(GOOD);
ok('score survives', g.score === 61, g.score);
ok('band derived', g.band === 'Decent', g.band);
ok('3 improvements', g.improvements.length === 3, g.improvements.length);
ok('subscores intact', g.subscores.impact === 48 && g.subscores.completeness === 72);

// ── the model ignores the format ──────────────────────────────────────────────────────────────
ok('code fences tolerated', normalise('```json\n' + GOOD + '\n```').score === 61);
ok('more than 3 improvements is TRIMMED, not rejected',
  normalise(JSON.stringify({ ...JSON.parse(GOOD), improvements: [...JSON.parse(GOOD).improvements, { title: 'x', detail: 'y' }] })).improvements.length === 3);
ok('improvement missing a detail is dropped',
  normalise(JSON.stringify({ ...JSON.parse(GOOD), improvements: [{ title: 'only a title' }, ...JSON.parse(GOOD).improvements.slice(0, 2)] })).improvements.length === 2);

// ── the model returns something unusable ──────────────────────────────────────────────────────
// These MUST throw. A silent default would show the user a confident score we never computed.
threw('no score at all', () => normalise(JSON.stringify({ ...JSON.parse(GOOD), score: undefined })));
threw('non-numeric score', () => normalise(JSON.stringify({ ...JSON.parse(GOOD), score: 'good' })));
threw('empty improvements', () => normalise(JSON.stringify({ ...JSON.parse(GOOD), improvements: [] })));
threw('not JSON at all', () => normalise('I think this résumé is quite good!'));

// ── out-of-range values are clamped, never rendered raw ───────────────────────────────────────
ok('score 0-10 scale is clamped not scaled', normalise(JSON.stringify({ ...JSON.parse(GOOD), score: 7 })).score === 7);
ok('score >100 clamps to 100', normalise(JSON.stringify({ ...JSON.parse(GOOD), score: 140 })).score === 100);
ok('score <0 clamps to 0', normalise(JSON.stringify({ ...JSON.parse(GOOD), score: -5 })).score === 0);
ok('missing subscore falls back to overall',
  normalise(JSON.stringify({ ...JSON.parse(GOOD), subscores: {} })).subscores.impact === 61);

// ── copy limits — the popup has fixed room ────────────────────────────────────────────────────
const longs = normalise(JSON.stringify({
  ...JSON.parse(GOOD), headline: 'H'.repeat(200), summary: 'S'.repeat(900),
  improvements: [{ title: 'T'.repeat(200), detail: 'D'.repeat(400) }],
}));
ok('headline capped at 60', longs.headline.length <= 60, longs.headline.length);
ok('summary capped at 240', longs.summary.length <= 240, longs.summary.length);
ok('improvement title capped at 42', longs.improvements[0].title.length <= 42, longs.improvements[0].title.length);
ok('improvement detail capped at 110', longs.improvements[0].detail.length <= 110, longs.improvements[0].detail.length);
ok('newlines collapsed in copy', !/\n/.test(normalise(JSON.stringify({ ...JSON.parse(GOOD), summary: 'a\n\nb' })).summary));

// ── bands ─────────────────────────────────────────────────────────────────────────────────────
// Boundaries asserted explicitly: an off-by-one here calls a 70 "Decent" on someone's home screen.
ok('0 → Weak', bandFor(0) === 'Weak');
ok('39 → Weak', bandFor(39) === 'Weak');
ok('40 → Needs work', bandFor(40) === 'Needs work');
ok('54 → Needs work', bandFor(54) === 'Needs work');
ok('55 → Decent', bandFor(55) === 'Decent');
ok('69 → Decent', bandFor(69) === 'Decent');
ok('70 → Strong', bandFor(70) === 'Strong');
ok('84 → Strong', bandFor(84) === 'Strong');
ok('85 → Excellent', bandFor(85) === 'Excellent');
ok('100 → Excellent', bandFor(100) === 'Excellent');

console.log(`\nresume score: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
