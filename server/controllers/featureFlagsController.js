'use strict';

const dbConfig = require('../../db-config');

// Ensure table exists on first use (no separate migration run needed)
async function ensureTable() {
    await dbConfig.run(`
        CREATE TABLE IF NOT EXISTS feature_flags (
            page_key    VARCHAR(100) PRIMARY KEY,
            status      VARCHAR(50)  NOT NULL DEFAULT 'active',
            title       VARCHAR(255),
            message     TEXT,
            updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

/**
 * GET /api/feature-flags/:pageKey
 * Public — no auth required.
 * Returns { pageKey, status, title, message }
 * status values: 'active' | 'under_construction' | 'disabled'
 */
async function getFlag(req, res) {
    try {
        await ensureTable();

        const { pageKey } = req.params;
        const row = await dbConfig.get(
            'SELECT page_key, status, title, message FROM feature_flags WHERE page_key = ?',
            [pageKey]
        );

        if (!row) {
            // Unknown page key — treat as active so unknown screens are never accidentally blocked
            return res.json({ pageKey, status: 'active', title: null, message: null });
        }

        res.json({
            pageKey:  row.page_key,
            status:   row.status,
            title:    row.title   || null,
            message:  row.message || null,
        });
    } catch (err) {
        console.error('[feature-flags] getFlag error:', err);
        // Fail open — return 'active' so the app is never blocked by a backend error
        res.json({ pageKey: req.params.pageKey, status: 'active', title: null, message: null });
    }
}

/**
 * PUT /api/feature-flags/:pageKey  (admin use — no auth middleware here, add if needed)
 * Body: { status, title?, message? }
 */
async function upsertFlag(req, res) {
    try {
        await ensureTable();

        const { pageKey } = req.params;
        const { status, title, message } = req.body;

        if (!status) return res.status(400).json({ error: 'status is required' });

        await dbConfig.run(
            `INSERT INTO feature_flags (page_key, status, title, message, updated_at)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
             ON CONFLICT (page_key) DO UPDATE SET
               status     = EXCLUDED.status,
               title      = EXCLUDED.title,
               message    = EXCLUDED.message,
               updated_at = CURRENT_TIMESTAMP`,
            [pageKey, status, title || null, message || null]
        );

        res.json({ ok: true, pageKey, status });
    } catch (err) {
        console.error('[feature-flags] upsertFlag error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

/**
 * GET /api/feature-flags  (list all — admin use)
 */
async function listFlags(req, res) {
    try {
        await ensureTable();
        const rows = await dbConfig.query('SELECT * FROM feature_flags ORDER BY page_key');
        res.json(rows);
    } catch (err) {
        console.error('[feature-flags] listFlags error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = { getFlag, upsertFlag, listFlags };
