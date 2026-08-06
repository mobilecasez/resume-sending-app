const { Pool } = require('pg');

/**
 * Database Configuration
 * PostgreSQL only - Production-ready database with timezone support
 * Uses connection pooling with reuse for auth stability
 */

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL || !DATABASE_URL.startsWith('postgres')) {
    console.error('❌ ERROR: DATABASE_URL is required and must be a PostgreSQL connection string');
    console.error('   Please set DATABASE_URL in your .env file');
    console.error('   Example: DATABASE_URL=postgresql://user@localhost:5432/dbname');
    process.exit(1);
}

let db;

// Reuse pool across requests (critical for serverless/auth routes)
global.pgPool = global.pgPool || null;

// Initialize database connection
function initializeConnection() {
    console.log('🐘 Using PostgreSQL database');
    
    // Internal Railway connections (*.railway.internal) don't use SSL
    const isInternalRailway = DATABASE_URL.includes('.railway.internal');
    const sslConfig = IS_PRODUCTION && !isInternalRailway ? { rejectUnauthorized: false } : false;
    
    // Reuse existing pool if available
    if (global.pgPool) {
        console.log('♻️  Reusing existing PostgreSQL connection pool');
        db = global.pgPool;
    } else {
        db = new Pool({
            connectionString: DATABASE_URL,
            ssl: sslConfig,
            connectionTimeoutMillis: 10000, // 10 seconds
            idleTimeoutMillis: 30000,
            max: 10, // Maximum pool size
            min: 2, // Minimum pool size
            keepAlive: true,
            keepAliveInitialDelayMillis: 10000
        });
        
        // Store for reuse
        global.pgPool = db;
    }
    
    // Test connection
    db.query('SELECT NOW()', (err, res) => {
        if (err) {
            console.error('❌ PostgreSQL connection error:', err);
        } else {
            console.log('✅ Connected to PostgreSQL database');
        }
    });
    
    return db;
}

/**
 * Convert question mark placeholders (?) to PostgreSQL ($1, $2, ...).
 * Extracted verbatim from query/get/run so the transaction helper below speaks the same dialect.
 */
function toPg(sql) {
    let paramIndex = 1;
    return sql.replace(/\?/g, () => `$${paramIndex++}`);
}

/**
 * For INSERT queries, add RETURNING id to get lastID (if not already present).
 * Skip for upserts (ON CONFLICT) — those tables use non-id primary keys.
 */
function addReturningId(pgSql) {
    if (pgSql.trim().toUpperCase().startsWith('INSERT') && !/RETURNING/i.test(pgSql) && !/ON CONFLICT/i.test(pgSql)) {
        return pgSql.replace(/;?\s*$/, ' RETURNING id');
    }
    return pgSql;
}

/**
 * Execute query with automatic parameter conversion
 */
function query(sql, params = []) {
    return new Promise((resolve, reject) => {
        const pgSql = toPg(sql);

        db.query(pgSql, params, (err, result) => {
            if (err) {
                reject(err);
            } else {
                resolve(result.rows);
            }
        });
    });
}

/**
 * Execute single row query
 */
function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        const pgSql = toPg(sql);

        db.query(pgSql, params, (err, result) => {
            if (err) {
                reject(err);
            } else {
                resolve(result.rows[0] || null);
            }
        });
    });
}

/**
 * Execute insert/update/delete query
 */
function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        const pgSql = addReturningId(toPg(sql));

        db.query(pgSql, params, (err, result) => {
            if (err) {
                reject(err);
            } else {
                resolve({
                    lastID: result.rows && result.rows[0] ? result.rows[0].id : null,
                    changes: result.rowCount
                });
            }
        });
    });
}

/**
 * Run `fn` inside ONE database transaction on ONE pooled client.
 *
 * ⚠️ WHY THIS EXISTS — money. query/get/run each borrow a different connection from the pool, so a
 * sequence of them is a sequence of independently committed statements. On the purchase paths that
 * means a crash (or a pod restart, or a rejected statement) between "record the order" and "add the
 * credits" leaves the user charged with nothing granted — or recorded as granted twice. Everything
 * inside `fn` commits together or not at all.
 *
 * `fn` receives a tx object with the same query/get/run surface as the module, bound to the single
 * client that holds the transaction. Do NOT call the module-level dbConfig.query/get/run inside
 * `fn`: those go to other connections and are NOT part of the transaction.
 *
 * Any throw rolls back and re-throws — callers on the money path must treat a throw as "nothing
 * happened" and fail closed (503/retry), never as "probably fine, continue".
 */
async function withTransaction(fn) {
    const client = await db.connect();
    const exec = (sql, params = []) => client.query(toPg(sql), params);
    try {
        await client.query('BEGIN');
        const tx = {
            query: async (sql, params = []) => (await exec(sql, params)).rows,
            get: async (sql, params = []) => (await exec(sql, params)).rows[0] || null,
            run: async (sql, params = []) => {
                const result = await client.query(addReturningId(toPg(sql)), params);
                return {
                    lastID: result.rows && result.rows[0] ? result.rows[0].id : null,
                    // rowCount is 0 when ON CONFLICT DO NOTHING suppressed the insert — that is the
                    // signal callers use to detect "somebody already did this".
                    changes: result.rowCount,
                    rows: result.rows || []
                };
            },
            client
        };
        const out = await fn(tx);
        await client.query('COMMIT');
        return out;
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (rollbackErr) {
            console.error('❌ ROLLBACK failed:', rollbackErr.message);
        }
        throw err;
    } finally {
        client.release();
    }
}

/** PostgreSQL unique_violation. A caught 23505 means "someone else already inserted this row". */
const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (err) => Boolean(err && err.code === UNIQUE_VIOLATION);

/**
 * Execute raw query (use original db connection)
 */
function rawDb() {
    return db;
}

/**
 * Get database type (always postgres now)
 */
function getDbType() {
    return 'postgres';
}

/**
 * Close database connection
 */
function close() {
    return new Promise((resolve, reject) => {
        db.end((err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

module.exports = {
    initializeConnection,
    query,
    get,
    run,
    withTransaction,
    isUniqueViolation,
    UNIQUE_VIOLATION,
    rawDb,
    getDbType,
    close
};
