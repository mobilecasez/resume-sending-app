#!/usr/bin/env node
// Tests for looksLikeSingleJobUrl — the gate that decides "the user pasted ONE job, not a board".
//
// Both directions cost real money if wrong, in opposite ways:
//   a MISS  → we go hunting for a list on a job page and return junk (the Revolut bug);
//   a FALSE HIT → we treat a whole careers section as one job and hide every other opening,
//                 which is worse, because it looks like a successful search.
// So the false-positive cases below matter more than the true positives.
//
//   DATABASE_URL=... node tools/test-single-posting.js

const { looksLikeSingleJobUrl } = require('../server/controllers/aiHubController');

let pass = 0;
const fails = [];
const yes = (u) => { if (looksLikeSingleJobUrl(u)) pass++; else fails.push(`should be a POSTING: ${u}`); };
const no = (u) => { if (!looksLikeSingleJobUrl(u)) pass++; else fails.push(`should NOT be a posting: ${u}`); };

// ── real single postings ─────────────────────────────────────────────────────
yes('https://www.revolut.com/careers/position/phone-support-specialist-spanish-a0d040ce-45af-4065-9c8e-4a88ff7b2dc8/');
yes('https://www.revolut.com/careers/position/graphic-designer-brand-d40cf51d-7222-4064-9723-b1dc7eef849d/');
yes('https://boards.greenhouse.io/acme/jobs/4567890');
yes('https://jobs.lever.co/company/8d3f2a11-4b6c-4a2e-9f11-2c7d8e5a1b90');
yes('https://careers.example.com/job/senior-backend-engineer-12345');
yes('https://example.com/vacature/software-ontwikkelaar-java-7781');
yes('https://example.de/stelle/senior-projektleiter-bau-2024-114');
yes('https://example.fr/offre/developpeur-full-stack-paris-9912');
yes('https://example.com/jobs/staff-product-designer-remote');

// ── boards and index pages — must NOT be mistaken for one job ────────────────
no('https://www.revolut.com/careers/');
no('https://www.revolut.com/careers');
no('https://example.com/careers');
no('https://example.com/jobs');
no('https://example.com/jobs/');
no('https://example.com/');
no('https://example.com');
no('https://boards.greenhouse.io/acme');
no('https://jobs.lever.co/company');
no('https://example.com/about/team');
no('https://example.com/careers/engineering');          // a department index: 2 segs, short slug
no('https://example.com/careers/life-at-acme');         // marketing page, only 3 slug words… see below
no('https://example.com/blog/we-are-hiring-engineers'); // not under a job path at all

// ── junk in, no crash out ────────────────────────────────────────────────────
no('');
no('not a url at all');
no('ftp://example.com/jobs/thing-1234');
no(null);
no(undefined);
no('https://');

// The 'life-at-acme' case above is the honest edge: 3 hyphenated words under /careers/ does look
// like a slug. It is excluded because a *posting* slug carries an identifier — a uuid or a digit
// run — or is longer than three words. Assert that boundary explicitly so a future loosening of
// the rule has to break a test rather than silently start swallowing whole career sections.
no('https://example.com/careers/life-at-acme');
yes('https://example.com/careers/senior-machine-learning-engineer-platform');
yes('https://example.com/careers/life-at-acme-98213');

console.log(`\nlooksLikeSingleJobUrl: ${pass} assertions passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✅ all green');
