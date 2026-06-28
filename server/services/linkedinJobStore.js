// LinkedIn job store — completely SEPARATE from the normal scrape pipeline.
// Holds the raw (innerText-trimmed) text + the AI-extracted JSON for each LinkedIn job, keyed by
// clean URL, so we can (a) reuse it for cover-letter generation without re-extracting, and (b) cache
// repeat opens cheaply. Additive: own table, nothing else touched.
'use strict';
const db = require('../../db-config');

async function ensureTable() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS linkedin_jobs (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER,
      url         VARCHAR(600) NOT NULL UNIQUE,
      raw_text    TEXT,
      data        JSONB,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_linkedin_jobs_url ON linkedin_jobs(url)`);
}

async function saveLinkedInJob({ userId, url, rawText, data }) {
  const row = await db.get(
    `INSERT INTO linkedin_jobs (user_id, url, raw_text, data)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (url) DO UPDATE SET
        raw_text = EXCLUDED.raw_text,
        data = EXCLUDED.data,
        user_id = COALESCE(linkedin_jobs.user_id, EXCLUDED.user_id),
        updated_at = NOW()
     RETURNING id`,
    [userId || null, url, rawText || '', JSON.stringify(data || {})]
  );
  return row ? row.id : null;
}

async function getLinkedInJob(url) {
  return db.get(`SELECT * FROM linkedin_jobs WHERE url = ?`, [url]);
}

module.exports = { ensureTable, saveLinkedInJob, getLinkedInJob };
