#!/usr/bin/env node
// Does the PUBLIC WEBSITE still describe the plans the app actually sells?
//
// WHY THIS EXISTS: the app moved from one-time credit packs to monthly subscriptions, and
// cvapplyr.com went on advertising "Credit-based, never a subscription" with five credit-pack
// prices — for weeks, on the page the Pricing menu links to and the page Google indexes. Nothing
// anywhere could notice, because the marketing copy and server/services/entitlements.js share no
// code. This closes that gap the only way static HTML allows: by reading both and comparing.
//
//   node scripts/check-pricing-parity.js        → exit 0 in sync, exit 1 with a diff when not
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// Second arg overrides the page, so the check itself can be tested against a deliberately-drifted
// copy. A guard nobody has watched fail is only a guess that it works.
const PAGE = process.argv[2] || path.join(ROOT, 'public', 'index.html');

// Read the catalog out of entitlements.js AS SOURCE rather than require()ing it: that module pulls
// in db-config, which refuses to load without DATABASE_URL, and a copy-paste of the numbers here
// would defeat the entire point of the check. Both literals are plain data, so evaluating just
// those two expressions is enough — and it still fails loudly if either is ever restructured.
const ENTITLEMENTS = path.join(ROOT, 'server', 'services', 'entitlements.js');
const src = fs.readFileSync(ENTITLEMENTS, 'utf8');
function literal(name, open, close) {
  const start = src.indexOf(`const ${name} = ${open}`);
  if (start === -1) throw new Error(`could not find "const ${name} = ${open}" in ${ENTITLEMENTS}`);
  const from = src.indexOf(open, start);
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) {
      // eslint-disable-next-line no-new-func
      return new Function(`return ${src.slice(from, i + 1)};`)();
    }
  }
  throw new Error(`unterminated ${name} literal in ${ENTITLEMENTS}`);
}
const PLANS = literal('PLANS', '[', ']');
// `TRIAL` is now an alias (`const TRIAL = FREE;`) with no object literal to parse, so read the
// real one. If the Free plan is ever renamed again this throws by name rather than silently
// checking nothing.
const TRIAL = literal('FREE', '{', '}');

const html = fs.readFileSync(PAGE, 'utf8');
const problems = [];

// ── every plan must appear as a card with its price AND both allowances ────────────────────────
// Matched loosely on purpose: the check is about the NUMBERS being right, not about the wording
// or markup, which designers should stay free to change.
for (const p of PLANS) {
  const money = p.priceUsd.toFixed(2);
  const nameRe = new RegExp(`class="price-name">\\s*${p.label}\\s*<`, 'i');
  if (!nameRe.test(html)) { problems.push(`plan "${p.label}" has no card on the pricing page`); continue; }
  if (!html.includes(`>${money}<`) && !html.includes(`>${money}<span`)) {
    problems.push(`plan "${p.label}": $${money} does not appear on the page`);
  }
  // Allowances, with or without a thousands separator (1000 renders as "1,000").
  const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  for (const [what, n] of [['cover letters', p.letters], ['resumes', p.resumes]]) {
    if (!html.includes(`<strong>${n}</strong>`) && !html.includes(`<strong>${grouped(n)}</strong>`)) {
      problems.push(`plan "${p.label}": ${what} allowance ${n} not shown`);
    }
  }
}

// ── the Free plan ─────────────────────────────────────────────────────────────────────────────
// It replaced the 7-day trial. The site must not still promise a trial that no longer exists, and
// must state the monthly allowance a visitor actually gets for nothing.
if (/free trial/i.test(html)) {
  problems.push('the site still advertises a "free trial" — the Free plan replaced it');
}
if (!/free plan/i.test(html)) {
  problems.push('the Free plan is not mentioned');
}
for (const [n, what] of [[TRIAL.letters, 'cover letter'], [TRIAL.resumes, 'resume']]) {
  if (!new RegExp(`<strong>${n}</strong>`).test(html)) {
    problems.push(`Free plan: ${what} allowance ${n} not shown`);
  }
}

// ── claims that directly contradict a subscription business ───────────────────────────────────
// Each of these was live on the site while the app sold auto-renewing plans. A visitor who read
// them and then hit the paywall was told two different things, and the second one charged money.
const CONTRADICTIONS = [
  [/never a subscription/i,        '"never a subscription"'],
  [/no monthly subscription/i,     '"no monthly subscription"'],
  [/no auto-renewals?/i,           '"no auto-renewals"'],
  [/credits never expire/i,        '"credits never expire"'],
  [/no subscriptions, no renewal/i,'"no subscriptions, no renewal traps"'],
];
for (const [re, label] of CONTRADICTIONS) {
  if (re.test(html)) problems.push(`page still claims ${label} — the app sells auto-renewing plans`);
}

if (problems.length) {
  console.error('✗ pricing parity FAILED — public/index.html disagrees with entitlements.js:\n');
  problems.forEach((p) => console.error('   • ' + p));
  console.error('\nUpdate the pricing section (and the FAQ JSON-LD) to match the catalog.');
  process.exit(1);
}
console.log(`✓ pricing parity: ${PLANS.length} plans + the Free plan (${TRIAL.letters} letters / ${TRIAL.resumes} resume per ${TRIAL.days} days) all match entitlements.js`);
