// Manually load jobs into global_jobs — for employers whose boards have no usable public feed
// (JS-rendered SPAs, bot-walled portals), collected by hand in a browser instead of by an adapter.
//
// It deliberately reuses the FIREHOSE's own field derivation — classifyTitle for the taxonomy,
// resolveCountry for the country, the same clipping and the same ON CONFLICT upsert — so a
// hand-loaded job is indistinguishable from an ingested one downstream. Writing a second, simpler
// insert here is how the two paths would drift and how hand-loaded jobs would quietly miss the
// field/seniority tagging every feed query relies on.
//
//   node server/scripts/load-manual-jobs.js <file.json> [--env <path>] [--dry]
//
// <file.json>: [{ job_url, title, employer_name, location, job_type?, salary?, experience?,
//                 responsibilities?: [], skills?: [], source?, region? }]
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry');
const envIdx = args.indexOf('--env');
if (envIdx >= 0 && args[envIdx + 1]) {
  // Load DATABASE_URL from an explicit env file (the production one lives outside the repo).
  for (const line of fs.readFileSync(args[envIdx + 1], 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !process.env[line.slice(0, i)]) process.env[line.slice(0, i)] = line.slice(i + 1);
  }
} else {
  try { require('dotenv').config(); } catch (_) {}
}
if (!file) { console.error('usage: load-manual-jobs.js <file.json> [--env <path>] [--dry]'); process.exit(1); }

const dbConfig = require('../../db-config');
const { classifyTitle } = require('../utils/jobTaxonomy');
const { resolveCountry } = require('../utils/jobLocation');

const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
const workModeOf = (loc) => /\bremote\b/i.test(loc || '') ? 'Remote' : (/\bhybrid\b/i.test(loc || '') ? 'Hybrid' : null);
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

const UPSERT_TAIL = `ON CONFLICT (job_url) DO UPDATE SET
    title=EXCLUDED.title, employer_name=EXCLUDED.employer_name, employer_domain=EXCLUDED.employer_domain,
    location=EXCLUDED.location, work_mode=EXCLUDED.work_mode, job_type=EXCLUDED.job_type, salary=EXCLUDED.salary,
    experience=EXCLUDED.experience, responsibilities=EXCLUDED.responsibilities, skills=EXCLUDED.skills,
    source=EXCLUDED.source, field=EXCLUDED.field, role_category=EXCLUDED.role_category, seniority=EXCLUDED.seniority,
    country=EXCLUDED.country, is_active=TRUE, last_seen=NOW()`;
const INSERT_HEAD = `INSERT INTO global_jobs
  (job_url, title, employer_name, employer_domain, location, work_mode, job_type, salary, experience, responsibilities, skills, source, country, field, role_category, seniority, is_active, first_seen, last_seen) VALUES `;

function jobParams(j) {
  const tax = classifyTitle(j.title);
  return [clip(j.job_url, 1990), clip(j.title, 490), clip(j.employer_name, 290), domainOf(j.job_url),
    clip(j.location, 490), workModeOf(j.location), clip(j.job_type, 110), clip(j.salary, 250),
    clip(j.experience, 250), JSON.stringify(Array.isArray(j.responsibilities) ? j.responsibilities : []),
    JSON.stringify(Array.isArray(j.skills) ? j.skills : []), clip(j.source || 'manual', 55),
    clip(resolveCountry(j.location, j.region), 78), clip(tax.field, 58), clip(tax.roleCategory, 88), clip(tax.seniority, 28)];
}

(async () => {
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const rows = Array.isArray(raw) ? raw : (raw.jobs || []);

  // Reject before touching the database: a job with no URL has no identity, and one with no title
  // is unusable in the feed. Silently upserting either is worse than refusing loudly.
  const seen = new Set();
  const valid = [], rejected = [];
  for (const j of rows) {
    if (!j || !j.job_url || !j.title) { rejected.push({ j, why: 'missing job_url or title' }); continue; }
    if (!/^https?:\/\//i.test(j.job_url)) { rejected.push({ j, why: 'job_url is not absolute' }); continue; }
    if (seen.has(j.job_url)) { rejected.push({ j, why: 'duplicate job_url in this file' }); continue; }
    seen.add(j.job_url); valid.push(j);
  }

  console.log(`${file}: ${rows.length} rows → ${valid.length} valid, ${rejected.length} rejected`);
  for (const r of rejected.slice(0, 10)) console.log(`  ✗ ${r.why}: ${JSON.stringify(r.j).slice(0, 110)}`);
  if (rejected.length > 10) console.log(`  … and ${rejected.length - 10} more`);

  const byEmployer = {};
  for (const j of valid) byEmployer[j.employer_name || '?'] = (byEmployer[j.employer_name || '?'] || 0) + 1;
  console.log('  by employer:', JSON.stringify(byEmployer));
  const byCountry = {};
  for (const j of valid) { const c = resolveCountry(j.location, j.region); byCountry[c] = (byCountry[c] || 0) + 1; }
  console.log('  by country :', JSON.stringify(Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 12)));

  if (dry) { console.log('\n--dry: nothing written.'); return; }
  if (!valid.length) { console.log('nothing to write.'); return; }

  dbConfig.initializeConnection();
  let saved = 0;
  const CHUNK = 100;
  for (let i = 0; i < valid.length; i += CHUNK) {
    const chunk = valid.slice(i, i + CHUNK);
    const params = [], vals = [];
    for (const j of chunk) {
      const b = params.length;
      params.push(...jobParams(j));
      vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10}::jsonb,$${b+11}::jsonb,$${b+12},$${b+13},$${b+14},$${b+15},$${b+16},TRUE,NOW(),NOW())`);
    }
    try {
      await dbConfig.query(INSERT_HEAD + vals.join(',') + ' ' + UPSERT_TAIL, params);
      saved += chunk.length;
    } catch (e) {
      // Fall back to per-row so one bad job never costs the whole chunk (same policy as the firehose).
      console.warn(`  chunk ${i / CHUNK} failed (${e.message.slice(0, 80)}) — retrying per row`);
      for (const j of chunk) {
        try { await dbConfig.query(INSERT_HEAD + `($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,TRUE,NOW(),NOW()) ` + UPSERT_TAIL, jobParams(j)); saved++; }
        catch (e2) { console.warn(`    ✗ ${String(j.job_url).slice(0, 70)}: ${e2.message.slice(0, 70)}`); }
      }
    }
  }
  console.log(`\nsaved ${saved}/${valid.length} into global_jobs`);
  await dbConfig.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
