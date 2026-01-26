const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

/**
 * Database Configuration
 * Supports both SQLite (local development) and PostgreSQL (production)
 */

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DATABASE_URL = process.env.DATABASE_URL;

let db;
let dbType = 'sqlite'; // Default to SQLite

// Initialize database connection
function initializeConnection() {
    if (DATABASE_URL && DATABASE_URL.startsWith('postgres')) {
        // PostgreSQL connection
        dbType = 'postgres';
        console.log('🐘 Using PostgreSQL database');
        
        db = new Pool({
            connectionString: DATABASE_URL,
            ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : false
        });
        
        // Test connection
        db.query('SELECT NOW()', (err, res) => {
            if (err) {
                console.error('❌ PostgreSQL connection error:', err);
            } else {
                console.log('✅ Connected to PostgreSQL database');
            }
        });
    } else {
        // SQLite connection
        dbType = 'sqlite';
        console.log('📁 Using SQLite database');
        
        db = new sqlite3.Database('./database.db', (err) => {
            if (err) {
                console.error('❌ Error opening SQLite database:', err);
            } else {
                console.log('✅ Connected to SQLite database');
            }
        });
    }
    
    return db;
}

/**
 * Execute query with automatic adapter based on database type
 */
function query(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (dbType === 'postgres') {
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
        } else {
            // SQLite
            db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        }
    });
}

/**
 * Execute single row query
 */
function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (dbType === 'postgres') {
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
        } else {
            db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        }
    });
}

/**
 * Execute insert/update/delete query
 */
function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (dbType === 'postgres') {
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
        } else {
            db.run(sql, params, function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({
                        lastID: this.lastID,
                        changes: this.changes
                    });
                }
            });
        }
    });
}

/**
 * Execute raw query (use original db connection)
 */
function rawDb() {
    return db;
}

/**
 * Get database type
 */
function getDbType() {
    return dbType;
}

/**
 * Close database connection
 */
function close() {
    return new Promise((resolve, reject) => {
        if (dbType === 'postgres') {
            db.end((err) => {
                if (err) reject(err);
                else resolve();
            });
        } else {
            db.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        }
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
