// Job-aware generation — contract tests over the two prompts that decide the output quality.
//   node server/scripts/test-job-aware-generation.js
//
// These run the REAL prompt builders (both exported for this) rather than matching source text, so
// an assertion here fails when the prompt the model actually receives changes, not when a comment
// near it does.
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 220) : '')); } };

// ── the resume prompt ────────────────────────────────────────────────────────────────────────────
// The controller opens a DB connection at require time, so load only the builder via a stub.
const RB = path.join(__dirname, '..', 'controllers', 'resumeBuilderController.js');
let buildParsePrompt;
try {
  ({ buildParsePrompt } = require(RB));
} catch (e) {
  console.log('resume controller could not be loaded (needs DATABASE_URL):', e.message.split('\n')[0]);
}

const RESUME = ['Ada Lovelace', 'ada@example.com', '+1', 'Berlin', 'I built an analytical engine and led two engineers.', [], ''];
const JOB = {
  title: 'Team Lead',
  company: 'Airbus',
  url: 'https://careers.airbus.test/jobs/1',
  description: 'Lead a team of eight. C++, DO-178C, avionics certification.',
};

if (buildParsePrompt) {
  console.log('── the resume prompt is tailored only when there IS a posting ──');
  const generic = buildParsePrompt(...RESUME, null);
  const tailored = buildParsePrompt(...RESUME, JOB);
  ok('a generic build carries no job block', !/THE ROLE THIS RESUME IS BEING WRITTEN FOR/.test(generic));
  ok('a targeted build does', /THE ROLE THIS RESUME IS BEING WRITTEN FOR/.test(tailored));
  ok('…and carries the role, the company and the posting text',
    tailored.includes('Team Lead') && tailored.includes('Airbus') && tailored.includes('DO-178C'));
  ok('…and the link', tailored.includes(JOB.url));

  console.log('── ⚠️ tailoring may reorder and re-word; it may NOT invent ──');
  ok('it forbids adding anything the candidate did not state', /NEVER add a skill, tool, employer, qualification, certification or achievement the candidate did\s*\n?\s*not state/.test(tailored));
  ok('it forbids implying more experience than they have', /Never imply more years of experience than they wrote/.test(tailored));
  ok('a requirement they do not meet is left unsaid, not softened', /do not mention it — do not soften it, do not imply it/.test(tailored));
  ok('the zero-miss rule survives tailoring', /The ZERO-MISS rule above still applies in full/.test(tailored));
  ok('re-wording is scoped to the SAME thing', /this is a re-wording rule, not a licence to claim/.test(tailored));
  ok('ordering is what changes', /order the highlights so the ones this posting actually asks about/.test(tailored));

  console.log('── the posting cannot run the token bill away ──');
  const huge = buildParsePrompt(...RESUME, { ...JOB, description: 'x'.repeat(40000) });
  ok('the posting text is truncated at exactly 12000 chars',
    huge.includes('x'.repeat(12000)) && !huge.includes('x'.repeat(12001)));

  console.log('── a link with no text still identifies the role ──');
  const linkOnly = buildParsePrompt(...RESUME, { title: 'Team Lead', url: JOB.url });
  ok('the block renders from a link alone', /THE ROLE THIS RESUME/.test(linkOnly) && linkOnly.includes(JOB.url));
  ok('…and does not print an empty posting body', !/Posting text:\s*\n---\s*\n\s*---/.test(linkOnly));
}

// ── the cover letter prompt ──────────────────────────────────────────────────────────────────────
const { buildPrompt } = require(path.join(__dirname, '..', '..', 'ai-cover-letter-v2.js'));
const META = { full_name: 'Ada Lovelace', skills: ['C++'], experience: [] };
const LISTING = { url: 'https://careers.airbus.test/jobs/1', text: 'Lead a team of eight. DO-178C.', title: 'Team Lead' };

console.log('── the letter uses the real posting when there is one ──');
const plain = buildPrompt(META, 'Team Lead', 'https://airbus.test', null, null, null);
const withJob = buildPrompt(META, 'Team Lead', 'https://airbus.test', null, null, LISTING);
ok('no posting → no block', !/THE ACTUAL JOB POSTING/.test(plain));
ok('a posting → a block', /THE ACTUAL JOB POSTING/.test(withJob));
ok('…carrying its text and link', withJob.includes('DO-178C') && withJob.includes(LISTING.url));
ok('…and it outranks what the website implies', /Prefer it over anything you infer from the company website/.test(withJob));
ok('…without claiming what the candidate lacks', /Where it names one they do not meet, stay silent about it/.test(withJob));

console.log('── ⚠️ the OUTPUT LANGUAGE rule must stay LAST (highest salience) ──');
ok('the posting block sits before it',
  withJob.indexOf('THE ACTUAL JOB POSTING') < withJob.indexOf('OUTPUT LANGUAGE — ABSOLUTE REQUIREMENT'));
ok('…and nothing follows the language rule but its own fence',
  withJob.trim().endsWith('---'));

console.log('── ⚠️ a pasted description must never be used as the employer URL ──');
// ai-cover-letter-v2 turns a bare employerUrl into https://<value>; a description in that slot
// would become a nonsense host and the letter would be researched against it.
const textOnly = buildPrompt(META, 'Team Lead', 'https://airbus.test', null, null, { text: 'Lead a team of eight.' });
ok('the listing has its own slot', /THE ACTUAL JOB POSTING/.test(textOnly));
ok('…and the employer subject is untouched', textOnly.includes('https://airbus.test'));

const capped = buildPrompt(META, 'Team Lead', 'https://airbus.test', null, null, { text: 'y'.repeat(40000) });
ok('the posting text is truncated at exactly 12000 chars here too',
  capped.includes('y'.repeat(12000)) && !capped.includes('y'.repeat(12001)));

console.log(`\njob-aware generation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
