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
  // Tolerates an Object.freeze( wrapper, and nothing else: anything cleverer than a plain literal
  // between the `=` and the bracket should fail here by name, not be half-evaluated.
  const esc = open === '[' ? '\\[' : '\\{';
  const m = new RegExp(`const ${name} = (?:Object\\.freeze\\(\\s*)?${esc}`).exec(src);
  if (!m) throw new Error(`could not find "const ${name} = ${open}" in ${ENTITLEMENTS}`);
  const from = m.index + m[0].length - 1;
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
  // Phrase-matched ("<strong>10</strong> cover letters") so a swapped pair — letters shown as
  // resumes — fails instead of passing on the bare numbers.
  const shown = (n, noun) => [String(n), grouped(n)].some((v) => new RegExp(`<strong>${v}</strong>\\s+${noun}`, 'i').test(html));
  for (const [what, n] of [['cover letters', p.letters], ['resumes', p.resumes]]) {
    if (!shown(n, what)) {
      problems.push(`plan "${p.label}": ${what} allowance ${n} not shown`);
    }
  }
}

// ── the Free plan ─────────────────────────────────────────────────────────────────────────────
// It replaced the 7-day trial, then (2026-09-13) stopped refilling: 3 resumes + 3 letters ONCE for
// the life of the account. The site must not still promise a trial or a refill that no longer
// exists, and must state the allowance a visitor actually gets for nothing.
if (/free trial|\d+-day trial/i.test(html)) {
  problems.push('the site still advertises a "free trial" — the Free plan replaced it');
}
if (!/free plan/i.test(html)) {
  problems.push('the Free plan is not mentioned');
}
// The allowance is checked as a PHRASE ("<strong>3</strong> resumes"), not a bare <strong>3</strong>:
// with 3 + 3 a bare number is satisfied by either half, and the plan cards contain other numbers.
for (const [n, re, what] of [
  [TRIAL.letters, 'cover letters?', 'cover letter'],
  [TRIAL.resumes, '(?:AI )?resumes?(?: generations?)?', 'resume'],
]) {
  if (!new RegExp(`<strong>${n}</strong>\\s+(?:AI\\s+)?${re}`, 'i').test(html)) {
    problems.push(`Free plan: ${what} allowance ${n} not shown`);
  }
}
if (TRIAL.oneTime) {
  // A one-time allowance described as recurring is the exact promise a user would hold us to.
  if (!/one[- ]time/i.test(html)) problems.push('Free plan is one-time, but the page never says "one time"');
  for (const [re, label] of [
    [/every\s+30\s+days/i, '"every 30 days"'],
    [/rolling\s+30/i,       '"rolling 30 days"'],
  ]) {
    if (re.test(html)) problems.push(`page still says the Free plan refills (${label}) — it is one-time`);
  }
} else if (TRIAL.days && !new RegExp(`every\\s+${TRIAL.days}\\s+days`, 'i').test(html)) {
  problems.push(`Free plan refills every ${TRIAL.days} days, but the page does not say so`);
}

// ── downloads ─────────────────────────────────────────────────────────────────────────────────
// They have always been paid (a plan, or a one-time pass) and FREE.downloads is 0 — yet the page
// said "Always free: … downloading your documents" and "$0 to search, fill & download".
if (!TRIAL.downloads) {
  for (const [re, label] of [
    [/downloads?\s+(?:are|is)\s+free/i,              '"downloads are free"'],
    [/always free:(?:<\/strong>)?[^.]*download/i,     '"Always free: … downloading"'],
    [/(?:search|fill)[^<]{0,20}(?:&amp;|&|and)\s*download/i, '"$0 to search, fill & download"'],
  ]) {
    if (re.test(html)) problems.push(`page claims ${label} — downloads need a plan or a download pass`);
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
const freeCadence = TRIAL.oneTime ? 'one time' : `per ${TRIAL.days} days`;
console.log(`✓ pricing parity: ${PLANS.length} plans + the Free plan (${TRIAL.resumes} resumes / ${TRIAL.letters} letters, ${freeCadence}) all match entitlements.js`);
