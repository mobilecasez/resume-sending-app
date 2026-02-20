#!/usr/bin/env node

/**
 * Database Migration Runner
 * 
 * Runs all pending migrations in the correct order.
 * Migrations are executed sequentially to ensure dependencies are met.
 */

require('dotenv').config();
const dbConfig = require('./db-config');
const fs = require('fs');
const path = require('path');

async function runMigrations() {
    console.log('🚀 Starting database migrations...\n');
    
    try {
        // Initialize database connection
        dbConfig.initializeConnection();
        
        // Get all migration files
        const migrationsDir = path.join(__dirname, 'server', 'migrations');
        const migrationFiles = fs.readdirSync(migrationsDir)
            .filter(file => file.endsWith('.js'))
            .sort(); // Sort to run in order (001_, 002_, etc.)
        
        console.log(`📋 Found ${migrationFiles.length} migration files:\n`);
        migrationFiles.forEach((file, idx) => {
            console.log(`   ${idx + 1}. ${file}`);
        });
        console.log('');
        
        // Run each migration
        let successCount = 0;
        let failureCount = 0;
        
        for (const file of migrationFiles) {
            const migrationPath = path.join(migrationsDir, file);
            
            try {
                console.log(`🔄 Running migration: ${file}`);
                
                // Skip if not a migration file
                if (file === 'create_notifications_table.js' || file === 'add_email_forwards_table.js') {
                    console.log(`   ⏭️  Skipping (legacy migration)\n`);
                    continue;
                }
                
                // Load and run migration
                const migration = require(migrationPath);
                
                if (typeof migration.up !== 'function') {
                    console.log(`   ⚠️  Migration has no 'up' function, skipping\n`);
                    continue;
                }
                
                await migration.up();
                successCount++;
                console.log(`   ✅ Migration completed successfully\n`);
                
            } catch (error) {
                failureCount++;
                console.error(`   ❌ Migration failed:`, error.message);
                console.error(`   Stack:`, error.stack);
                console.log('');
                
                // Ask if should continue
                console.log('⚠️  Migration failed. Continue with remaining migrations? (Press Ctrl+C to abort)');
                await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay
            }
        }
        
        // Summary
        console.log('═══════════════════════════════════════════════════════');
        console.log('📊 Migration Summary:');
        console.log(`   ✅ Successful: ${successCount}`);
        console.log(`   ❌ Failed: ${failureCount}`);
        console.log(`   📝 Total: ${migrationFiles.length}`);
        console.log('═══════════════════════════════════════════════════════\n');
        
        if (failureCount === 0) {
            console.log('🎉 All migrations completed successfully!\n');
        } else {
            console.log('⚠️  Some migrations failed. Please review the errors above.\n');
        }
        
    } catch (error) {
        console.error('💥 Fatal error running migrations:', error);
        process.exit(1);
    } finally {
        // Close database connection
        await dbConfig.close();
        console.log('🔌 Database connection closed');
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n\n⚠️  Migration interrupted by user');
    await dbConfig.close();
    process.exit(0);
});

// Run migrations
runMigrations().catch(error => {
    console.error('💥 Unhandled error:', error);
    process.exit(1);
});
