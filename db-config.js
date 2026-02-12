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
    
    // Reuse existing pool if available
    if (global.pgPool) {
        console.log('♻️  Reusing existing PostgreSQL connection pool');
        db = global.pgPool;
    } else {
        db = new Pool({
            connectionString: DATABASE_URL,
            ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : false,
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
 * Execute query (convert SQLite ? placeholders to PostgreSQL $1, $2, etc.)
 */
function query(sql, params = []) {
    return new Promise((resolve, reject) => {
        // Convert SQLite placeholders (?) to PostgreSQL ($1, $2, etc.)
        let pgSql = sql;
        let paramIndex = 1;
        pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
        
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
        let pgSql = sql;
        let paramIndex = 1;
        pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
        
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
        let pgSql = sql;
        let paramIndex = 1;
        pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
        
        // For INSERT queries, add RETURNING id to get lastID
        if (pgSql.trim().toUpperCase().startsWith('INSERT')) {
            pgSql = pgSql.replace(/;?\s*$/, ' RETURNING id');
        }
        
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
    rawDb,
    getDbType,
    close
};
