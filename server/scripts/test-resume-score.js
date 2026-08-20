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

// ── the output contract ───────────────────────────────────────────────────────────────────────
// The schema is handed to Gemini as `responseSchema`, which constrains generation — so it, not the
// prompt, is what guarantees "exactly 3 improvements". The popup renders improvements[0..2]
// unconditionally, so that count is load-bearing.
const schemaSrc = grab(/const SCORE_SCHEMA = \{[\s\S]*?\n\};/, 'SCORE_SCHEMA');
const sm = new module.constructor();
sm._compile(schemaSrc + '\nmodule.exports = { SCORE_SCHEMA };', '/schema-harness.js');
const S = sm.exports.SCORE_SCHEMA;

ok('all five fields required', S.required.length === 5, S.required.length);
ok('exactly 3 improvements is ENFORCED, not requested',
  S.properties.improvements.minItems === 3 && S.properties.improvements.maxItems === 3);
ok('all four subscores required', S.properties.subscores.required.length === 4);
ok('improvement items require both title and detail',
  S.properties.improvements.items.required.join() === 'title,detail');
ok('score is an integer', S.properties.score.type === 'integer');

// ⚠️ Gemini's responseSchema IGNORES these keywords. Putting them here would look like enforcement
// while enforcing nothing — the numeric ranges and character budgets are normalise()'s job, and
// this asserts nobody has quietly added them back expecting them to bite.
const json = JSON.stringify(S);
ok('no additionalProperties (unsupported by Gemini)', !json.includes('additionalProperties'));
ok('no maxLength (unsupported by Gemini)', !json.includes('maxLength'));
ok('no minimum/maximum (unsupported by Gemini)', !json.includes('"minimum"') && !json.includes('"maximum"'));

// The budgets therefore live in `description` (which Gemini DOES read) and must match the caps
// normalise() truncates to — otherwise the model writes to one length and we cut at another.
ok('headline description states the 60 cap', /60/.test(S.properties.headline.description));
ok('summary description states its cap', /2[024]0/.test(S.properties.summary.description));
ok('title description states the 42 cap', /42/.test(S.properties.improvements.items.properties.title.description));
ok('detail description states the 110 cap', /110/.test(S.properties.improvements.items.properties.detail.description));
ok('normalise still truncates headline at 60', /str\(o\.headline, 60\)/.test(src));
ok('normalise still truncates summary at 240', /str\(o\.summary, 240\)/.test(src));
ok('normalise still truncates title at 42', /str\(i && i\.title, 42\)/.test(src));
ok('normalise still truncates detail at 110', /str\(i && i\.detail, 110\)/.test(src));

// ── the call we make ──────────────────────────────────────────────────────────────────────────
ok('stays on Gemini', /RESUME_SCORE_MODEL \|\| 'gemini-2\.5-flash'/.test(src));
ok('schema is actually attached to the request', /responseSchema: SCORE_SCHEMA/.test(src));
ok('JSON mime type still set', /responseMimeType: 'application\/json'/.test(src));
// 2.5-flash spends thinking tokens from the SAME budget; a tight cap truncates JSON mid-object.
ok('maxOutputTokens leaves room for thinking', /maxOutputTokens: (8192|1[0-9]{4}|[2-9][0-9]{4})/.test(src));
ok('a truncated response is named, not left to JSON.parse', /finishReason/.test(src));
ok('no Claude/Anthropic left in the service', !/claude|anthropic/i.test(src));

console.log(`\nresume score: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
