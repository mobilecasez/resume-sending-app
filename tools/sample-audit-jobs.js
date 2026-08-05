// Draw a FRESH random sample of live jobs from production global_jobs, for tools/audit-autofill2.js.
//
//   DATABASE_URL=<prod> node tools/sample-audit-jobs.js <out.json> [n] [seed]
//
// WHY A SCRIPT AND NOT A REMEMBERED LIST. The 2026-08-05 A/B was measured on one 50-job sample, and
// every fix since then was written while looking at it. Re-running the same 50 measures how well the
// engine fits the pages it was tuned on, which is not the question. This draws a new sample with a
// stated seed and EXCLUDES the URLs of any sample handed to --exclude, so the two runs are
// comparable in method but independent in content. The seed is printed and stored in the file, so
// the draw is reproducible without being memorised.
'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const OUT = process.argv[2] || '/tmp/audit-sample.json';
const N = parseInt(process.argv[3], 10) || 50;
// A seed nobody chose by hand. Printed and recorded so the exact draw can be repeated.
// ⚠️ Positional, so it must not swallow the first FLAG: `... out.json 50 --exclude f.json` put
// "--exclude" here, Number() made it NaN, and setseed rejected the whole run.
const SEED = (process.argv[4] !== undefined && !String(process.argv[4]).startsWith('--'))
    ? Number(process.argv[4])
    : Number(('0.' + String(Date.now()).slice(-9)));
const exIdx = process.argv.indexOf('--exclude');
const EXCLUDE = [];
if (exIdx > 0) {
    for (const f of process.argv.slice(exIdx + 1)) {
        if (String(f).startsWith('--')) break;
        try {
            for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) if (r && r.job_url) EXCLUDE.push(r.job_url);
        } catch (e) { console.error('  could not read exclusion file ' + f + ': ' + e.message); }
    }
}

(async () => {
    if (!process.env.DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const c = await pool.connect();
    try {
        // setseed makes random() deterministic for this session, so <seed> reproduces this exact draw.
        await c.query('SELECT setseed($1)', [SEED > 1 || SEED < -1 ? (SEED % 1) : SEED]);
        const { rows } = await c.query(
            `SELECT job_url, employer_name, title, country, source
               FROM global_jobs
              WHERE is_active
                AND job_url IS NOT NULL AND job_url <> ''
                AND job_url NOT LIKE '%#%'          -- synthetic #role-N anchors are not applications
                AND ($2::text[] IS NULL OR NOT (job_url = ANY($2::text[])))
              ORDER BY random()
              LIMIT $1`,
            [N, EXCLUDE.length ? EXCLUDE : null]);
        fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
        const total = (await c.query('SELECT COUNT(*)::int n FROM global_jobs WHERE is_active')).rows[0].n;
        console.log('seed        : ' + SEED);
        console.log('population  : ' + total + ' active jobs, ' + EXCLUDE.length + ' excluded as already-measured');
        console.log('drawn       : ' + rows.length + ' -> ' + OUT);
        const by = {};
        rows.forEach((r) => { by[r.source || '?'] = (by[r.source || '?'] || 0) + 1; });
        console.log('by source   : ' + JSON.stringify(by));
        const hosts = {};
        rows.forEach((r) => { try { const h = new URL(r.job_url).host.replace(/^www\./, ''); hosts[h] = (hosts[h] || 0) + 1; } catch (e) {} });
        console.log('distinct hosts: ' + Object.keys(hosts).length);
    } finally { c.release(); await pool.end(); }
})().catch((e) => { console.error(e); process.exit(1); });
