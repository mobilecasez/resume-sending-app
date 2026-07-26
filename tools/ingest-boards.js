// Ingest a specific list of board URLs into global_jobs, without waiting for a whole firehose pass.
// Used right after tools/verify-ats-boards.js --merge, so newly added boards show up in the feed
// immediately instead of at the next scheduled run.
//
// Usage: PGURL=<db> node tools/ingest-boards.js /tmp/verified_a.json /tmp/verified_b.json [--concurrency 4]
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
if (!process.env.PGURL) { console.error('set PGURL to the database connection string'); process.exit(1); }
process.env.DATABASE_URL = process.env.PGURL;

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const CONCURRENCY = parseInt(arg('--concurrency', '4'), 10);

const files = process.argv.slice(2).filter((a) => a.endsWith('.json'));
if (!files.length) { console.error('pass one or more verified-boards json files'); process.exit(1); }

(async () => {
  const db = require(path.join(ROOT, 'db-config'));
  await db.initializeConnection();
  const firehose = require(path.join(ROOT, 'server', 'services', 'globalJobFirehose'));
  const ats = require(path.join(ROOT, 'server', 'utils', 'atsDiscovery'));

  const boards = [];
  const seen = new Set();
  for (const f of files) {
    for (const b of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      if (seen.has(b.url)) continue;
      seen.add(b.url);
      boards.push({ url: b.url, region: b.region || 'Global' });
    }
  }
  console.log(`ingesting ${boards.length} boards, concurrency ${CONCURRENCY}`);

  const t0 = Date.now();
  let done = 0, jobs = 0, ok = 0;
  const results = await ats.mapLimit(boards, CONCURRENCY, async (b) => {
    const r = await firehose.ingestOne(b);
    done++;
    jobs += r.jobs || 0;
    if (r.jobs) ok++;
    if (done % 25 === 0) console.log(`  … ${done}/${boards.length}  ${jobs} jobs  ${Math.round((Date.now() - t0) / 1000)}s`);
    return r;
  });

  const empty = results.filter((r) => !r.jobs);
  console.log(`\nDONE: ${ok}/${boards.length} boards produced ${jobs} jobs in ${Math.round((Date.now() - t0) / 1000)}s`);
  // Never let a silent zero look like success — a board that verified but ingested nothing means the
  // firehose could not read a board we know has jobs, which is a bug worth seeing.
  if (empty.length) {
    console.log(`${empty.length} boards returned nothing:`);
    for (const e of empty.slice(0, 40)) console.log(`  - ${e.url}${e.error ? '  (' + e.error + ')' : ''}`);
    if (empty.length > 40) console.log(`  … and ${empty.length - 40} more`);
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
