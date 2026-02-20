require('dotenv').config();
const dbConfig = require('./db-config');

/**
 * View PostgreSQL Database Data
 * Shows all tables and their contents in a readable format
 */

async function viewDatabase() {
    console.log('\n📊 PostgreSQL Database Viewer\n');
    console.log('=' .repeat(80));
    
    try {        // Initialize database connection
        dbConfig.initializeConnection();        const db = dbConfig.rawDb();
        
        // Get all tables
        const tablesResult = await db.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            ORDER BY table_name
        `);
        
        const tables = tablesResult.rows;
        
        if (tables.length === 0) {
            console.log('\n⚠️  No tables found in database\n');
            process.exit(0);
        }
        
        console.log(`\n📋 Found ${tables.length} tables:\n`);
        
        // View each table
        for (const table of tables) {
            const tableName = table.table_name;
            
            // Get row count
            const countResult = await db.query(`SELECT COUNT(*) FROM "${tableName}"`);
            const rowCount = countResult.rows[0].count;
            
            console.log(`\n${'─'.repeat(80)}`);
            console.log(`📦 TABLE: ${tableName.toUpperCase()}`);
            console.log(`   Rows: ${rowCount}`);
            console.log(`${'─'.repeat(80)}\n`);
            
            if (rowCount > 0) {
                // Get column info
                const columnsResult = await db.query(`
                    SELECT column_name, data_type 
                    FROM information_schema.columns 
                    WHERE table_name = $1 
                    ORDER BY ordinal_position
                `, [tableName]);
                
                const columns = columnsResult.rows.map(c => c.column_name);
                
                // Get data (limit to 10 rows for safety)
                // Try to order by id if exists, otherwise by first column
                let orderClause = 'ctid';
                if (columns.includes('id')) {
                    orderClause = 'id';
                } else if (columns.includes('created_at')) {
                    orderClause = 'created_at';
                }
                
                const dataResult = await db.query(`
                    SELECT * FROM "${tableName}" 
                    ORDER BY ${orderClause}
                    LIMIT 10
                `);
                
                if (dataResult.rows.length > 0) {
                    console.table(dataResult.rows);
                    
                    if (rowCount > 10) {
                        console.log(`\n   ... showing first 10 of ${rowCount} rows\n`);
                    }
                } else {
                    console.log('   (empty table)\n');
                }
            } else {
                console.log('   (empty table)\n');
            }
        }
        
        console.log('\n' + '='.repeat(80));
        console.log('✅ Database view complete\n');
        
        process.exit(0);
        
    } catch (error) {
        console.error('\n❌ Error viewing database:', error.message);
        console.error('\nFull error:', error);
        process.exit(1);
    }
}

// Run the viewer
viewDatabase();
