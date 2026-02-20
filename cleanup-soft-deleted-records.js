#!/usr/bin/env node

/**
 * Soft Delete Cleanup Job
 * 
 * Permanently removes soft-deleted records that are older than the retention period.
 * This job should be run periodically (e.g., monthly) to maintain database size.
 * 
 * Default retention: 90 days
 * 
 * Usage:
 *   node cleanup-soft-deleted-records.js [retention_days]
 * 
 * Example:
 *   node cleanup-soft-deleted-records.js 90
 */

require('dotenv').config();
const dbConfig = require('./db-config');
const auditUtils = require('./server/utils/auditUtils');

// Configuration
const RETENTION_DAYS = parseInt(process.argv[2]) || 90;
const TABLES_TO_CLEAN = [
    'recipients',
    'application_history',
    'review_cover_letters',
    'notifications',
    'plans',
    'credit_transactions',
    'payment_orders'
];

async function runCleanup() {
    console.log('🧹 Starting Soft Delete Cleanup Job');
    console.log(`📅 Retention Period: ${RETENTION_DAYS} days`);
    console.log(`📋 Tables to clean: ${TABLES_TO_CLEAN.length}\n`);
    
    try {
        // Initialize database connection
        dbConfig.initializeConnection();
        
        // Wait for connection
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        let totalDeleted = 0;
        const results = [];
        
        // Clean each table
        for (const table of TABLES_TO_CLEAN) {
            try {
                console.log(`🔄 Cleaning ${table}...`);
                
                const deletedCount = await auditUtils.permanentlyDeleteOld(table, RETENTION_DAYS);
                totalDeleted += deletedCount;
                
                results.push({ table, deleted: deletedCount, status: 'success' });
                
                if (deletedCount > 0) {
                    console.log(`   ✅ Deleted ${deletedCount} old records from ${table}`);
                } else {
                    console.log(`   ℹ️  No old records to delete from ${table}`);
                }
                
            } catch (error) {
                console.error(`   ❌ Error cleaning ${table}:`, error.message);
                results.push({ table, deleted: 0, status: 'error', error: error.message });
            }
            
            console.log('');
        }
        
        // Summary
        console.log('═══════════════════════════════════════════════════════');
        console.log('📊 Cleanup Summary:');
        console.log(`   🗑️  Total Records Deleted: ${totalDeleted}`);
        console.log(`   📋 Tables Processed: ${TABLES_TO_CLEAN.length}`);
        console.log('═══════════════════════════════════════════════════════\n');
        
        // Detailed results
        console.log('📝 Detailed Results:');
        results.forEach(result => {
            const status = result.status === 'success' ? '✅' : '❌';
            const details = result.status === 'success' 
                ? `${result.deleted} records deleted`
                : `Error: ${result.error}`;
            console.log(`   ${status} ${result.table}: ${details}`);
        });
        console.log('');
        
        // Recommendations
        if (totalDeleted === 0) {
            console.log('💡 No records were deleted. This is normal if:');
            console.log('   - No data has been soft-deleted');
            console.log('   - Soft-deleted data is newer than retention period');
            console.log('   - Cleanup was run recently\n');
        } else {
            console.log(`✨ Successfully cleaned up ${totalDeleted} old records!`);
            console.log('💡 Recommendation: Run this job monthly to maintain optimal database size.\n');
        }
        
        // Log to audit table
        await auditUtils.createAuditLog({
            userId: null, // System operation
            tableName: 'system',
            recordId: null,
            action: 'CLEANUP_JOB_COMPLETED',
            metadata: {
                retention_days: RETENTION_DAYS,
                total_deleted: totalDeleted,
                tables_processed: TABLES_TO_CLEAN.length,
                results: results,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('💥 Fatal error during cleanup:', error);
        console.error('Stack:', error.stack);
        
        // Log failure to audit table
        try {
            await auditUtils.createAuditLog({
                userId: null,
                tableName: 'system',
                recordId: null,
                action: 'CLEANUP_JOB_FAILED',
                metadata: {
                    error: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                }
            });
        } catch (logError) {
            console.error('Failed to log cleanup failure:', logError);
        }
        
        process.exit(1);
    } finally {
        // Close database connection
        try {
            await dbConfig.close();
            console.log('🔌 Database connection closed');
        } catch (error) {
            console.error('Error closing database:', error);
        }
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n\n⚠️  Cleanup interrupted by user');
    try {
        await dbConfig.close();
    } catch (error) {
        console.error('Error closing database:', error);
    }
    process.exit(0);
});

// Run cleanup
console.log('╔══════════════════════════════════════════════════════╗');
console.log('║     Soft Delete Cleanup Job - Data Maintenance      ║');
console.log('╚══════════════════════════════════════════════════════╝\n');

runCleanup().catch(error => {
    console.error('💥 Unhandled error:', error);
    process.exit(1);
});
