// Where does the application form live? — pure-function tests, no network, no database.
//   node tools/test-apply-resolver.js
//
// The audit of 50 random jobs found Auto Fill could act on ~32% of them, and that the dominant
// reason was never reaching a form: 46% of our job_urls are aggregator listings. This module is the
// fix, so it needs to be right about two things — recognising a board, and finding the apply link
// on ANY employer's page without knowing that employer.
'use strict';
process.env.DATABASE_URL = 'postgresql://test@127.0.0.1:1/apply_resolver_unit_test';
const path = require('path');
const R = require(path.join(__dirname, '..', 'server', 'services', 'applyUrlResolver'));

let pass = 0, fail = 0;
const ok = (n, c, got) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (got !== undefined ? '  → ' + JSON.stringify(got) : '')); } };

console.log('\nrecognising a job board');
[
  'https://arbetsformedlingen.se/platsbanken/annonser/12345',
  'https://www.arbeitsagentur.de/jobsuche/jobdetail/abc',
  'https://www.jobs.ch/en/vacancies/detail/123/',
  'https://jobup.ch/en/jobs/detail/999/',
  'https://www.linkedin.com/jobs/view/123456',
  'https://uk.indeed.com/viewjob?jk=abc',
].forEach((u) => ok('aggregator: ' + R.hostOf(u), R.isAggregator(u) && R.classify(u) === 'aggregator', R.classify(u)));

console.log('\nrecognising an ATS (already the form — never "resolve" away from it)');
[
  'https://job-boards.greenhouse.io/acme/jobs/1',
  'https://jobs.lever.co/acme/abc',
  'https://jobs.ashbyhq.com/acme/abc',
  'https://acme.wd5.myworkdayjobs.com/careers/job/x',
  'https://apply.workable.com/j/ABC',
  'https://acme.teamtailor.com/jobs/1-role',
  'https://acme.bamboohr.com/careers/1',
  'https://ats.talentadore.com/apply/x',
].forEach((u) => ok('ATS: ' + R.hostOf(u), R.isAts(u) && R.classify(u) === 'form', R.classify(u)));

console.log('\nan employer listing is neither');
['https://careers.abb/en/job/123', 'https://www.example-gmbh.de/karriere/stelle-42']
  .forEach((u) => ok('listing: ' + R.hostOf(u), R.classify(u) === 'listing', R.classify(u)));

console.log('\nfinding the apply link on a page we have never seen');
const PAGE = 'https://careers.example-employer.com/jobs/senior-engineer';
{
  // An ATS link wins outright — that is unambiguously where a form lives.
  const html = `
    <a href="/about">About us</a>
    <a href="https://careers.example-employer.com/jobs/senior-engineer#top">Back to top</a>
    <a href="https://job-boards.greenhouse.io/exampleco/jobs/9911">Apply for this job</a>
    <a href="/login">Sign in</a>`;
  const hit = R.extractApplyUrl(html, PAGE);
  ok('picks the ATS link', hit && /greenhouse\.io/.test(hit.url), hit);
  ok('…and says why', hit && hit.why === 'links to an ATS', hit && hit.why);
}
{
  // No ATS: an off-site "apply" link beats a same-site one.
  const html = `
    <a href="/jobs/senior-engineer/apply">Apply here</a>
    <a href="https://apply.someportal.io/x/9">Apply now</a>`;
  const hit = R.extractApplyUrl(html, PAGE);
  ok('prefers the OFF-SITE apply link', hit && /someportal\.io/.test(hit.url), hit && hit.url);
}
{
  const html = `<a href="/jobs/senior-engineer/apply">Ansök nu</a>`;
  ok('understands a non-English apply link (sv)', !!R.extractApplyUrl(html, PAGE));
}
['Jetzt bewerben', 'Postuler', 'Solliciteer', 'Søk her', 'Candidatarsi'].forEach((t) => {
  const html = `<a href="/apply">${t}</a>`;
  ok('understands "' + t + '"', !!R.extractApplyUrl(html, PAGE));
});
{
  // ⚠️ The words must START the label. These are the false positives that would send a user to the
  // privacy page instead of the form.
  const html = `
    <a href="/filters">Applied filters</a>
    <a href="/privacy">How we apply your data</a>
    <a href="/misapply">misapply</a>`;
  ok('does NOT match "Applied filters" / "How we apply your data"', R.extractApplyUrl(html, PAGE) === null, R.extractApplyUrl(html, PAGE));
}
{
  const html = `<a href="#apply">Apply</a><a href="javascript:void(0)">Apply now</a><a href="mailto:x@y.z">Apply</a>`;
  ok('ignores anchors, javascript: and mailto:', R.extractApplyUrl(html, PAGE) === null, R.extractApplyUrl(html, PAGE));
}
{
  const html = `<a href="/login?next=/apply">Apply now</a><a href="/share">Apply</a>`;
  ok('ignores login and share URLs', R.extractApplyUrl(html, PAGE) === null, R.extractApplyUrl(html, PAGE));
}
{
  ok('empty html is null, not a crash', R.extractApplyUrl('', PAGE) === null);
  ok('junk html is null, not a crash', R.extractApplyUrl('<a href=>>>', PAGE) === null);
  ok('null html is null, not a crash', R.extractApplyUrl(null, PAGE) === null);
}
{
  // aria-label is the only label on icon-only buttons
  const html = `<a href="https://x.io/apply" aria-label="Apply for this position"><svg/></a>`;
  ok('reads aria-label when there is no text', !!R.extractApplyUrl(html, PAGE));
}

console.log('\nresolveApplyUrl end to end (injected fetch — no network)');
(async () => {
  const fetchText = async () => `<a href="https://jobs.lever.co/acme/xyz">Apply</a>`;
  const ats = await R.resolveApplyUrl('https://job-boards.greenhouse.io/acme/jobs/1', { fetchText });
  ok('an ATS url is returned untouched', ats.resolved === false && /greenhouse/.test(ats.url), ats);

  const listing = await R.resolveApplyUrl('https://careers.example.com/jobs/1', { fetchText });
  ok('a listing resolves to the ATS form', listing.resolved === true && /lever\.co/.test(listing.url), listing);
  ok('…and reports it is now a form', listing.kind === 'form', listing.kind);

  const board = await R.resolveApplyUrl('https://arbetsformedlingen.se/annons/1', { fetchText });
  ok('an aggregator also resolves outward', board.resolved === true && /lever\.co/.test(board.url), board);

  const dead = await R.resolveApplyUrl('https://careers.example.com/jobs/2', { fetchText: async () => '<p>no links</p>' });
  ok('no apply link → original url, honestly reported', dead.resolved === false && /example\.com/.test(dead.url), dead);
  ok('…with a reason', /no application link/.test(dead.why || ''), dead.why);

  const boom = await R.resolveApplyUrl('https://careers.example.com/jobs/3', { fetchText: async () => { throw new Error('ETIMEDOUT'); } });
  ok('a failed fetch never throws and keeps the original url', boom.resolved === false && /example\.com/.test(boom.url), boom);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
