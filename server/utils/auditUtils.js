const dbConfig = require('../../db-config');

/**
 * Audit Log and Soft Delete Utilities
 * 
 * Provides reusable functions for:
 * - Creating audit log entries
 * - Soft deleting records
 * - Restoring soft deleted records
 * - Querying active (non-deleted) records
 */

/**
 * Create an audit log entry
 * @param {Object} params - Audit log parameters
 * @param {number} params.userId - User who performed the action
 * @param {string} params.tableName - Table being modified
 * @param {number} params.recordId - ID of the record being modified
 * @param {string} params.action - Action performed (CREATE, UPDATE, DELETE, RESTORE)
 * @param {Object} params.oldData - Previous data state (optional)
 * @param {Object} params.newData - New data state (optional)
 * @param {string} params.ipAddress - User's IP address (optional)
 * @param {string} params.userAgent - User's browser/client info (optional)
 * @param {Object} params.metadata - Additional metadata (optional)
 */
async function createAuditLog({
    userId,
    tableName,
    recordId,
    action,
    oldData = null,
    newData = null,
    ipAddress = null,
    userAgent = null,
    metadata = null
}) {
    try {
        await dbConfig.run(
            `INSERT INTO audit_log 
            (user_id, table_name, record_id, action, old_data, new_data, ip_address, user_agent, metadata) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                userId,
                tableName,
                recordId,
                action,
                oldData ? JSON.stringify(oldData) : null,
                newData ? JSON.stringify(newData) : null,
                ipAddress,
                userAgent,
                metadata ? JSON.stringify(metadata) : null
            ]
        );
        
        console.log(`📝 Audit log created: ${action} on ${tableName} record ${recordId}`);
    } catch (error) {
        console.error('❌ Error creating audit log:', error);
        // Don't throw error - audit logging should not break the main operation
    }
}

/**
 * Soft delete a record
 * @param {string} tableName - Table name
 * @param {number} recordId - Record ID to delete
 * @param {number} deletedBy - User ID performing the deletion
 * @param {Object} recordData - Current record data (for audit trail)
 * @returns {Promise<boolean>} - Success status
 */
async function softDelete(tableName, recordId, deletedBy, recordData = null) {
    try {
        // Update record with deleted_at timestamp
        await dbConfig.run(
            `UPDATE ${tableName} 
            SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? 
            WHERE id = ? AND deleted_at IS NULL`,
            [deletedBy, recordId]
        );
        
        // Create audit log
        await createAuditLog({
            userId: deletedBy,
            tableName,
            recordId,
            action: 'SOFT_DELETE',
            oldData: recordData,
            metadata: { timestamp: new Date().toISOString() }
        });
        
        console.log(`🗑️  Soft deleted ${tableName} record ${recordId} by user ${deletedBy}`);
        return true;
    } catch (error) {
        console.error(`❌ Error soft deleting ${tableName} record ${recordId}:`, error);
        throw error;
    }
}

/**
 * Bulk soft delete records
 * @param {string} tableName - Table name
 * @param {string} whereClause - WHERE clause (without WHERE keyword)
 * @param {Array} whereParams - Parameters for WHERE clause
 * @param {number} deletedBy - User ID performing the deletion
 * @returns {Promise<number>} - Number of records deleted
 */
async function bulkSoftDelete(tableName, whereClause, whereParams, deletedBy) {
    try {
        // First, get the records that will be deleted for audit trail
        const records = await dbConfig.query(
            `SELECT * FROM ${tableName} WHERE ${whereClause} AND deleted_at IS NULL`,
            whereParams
        );
        
        // Soft delete the records
        const result = await dbConfig.run(
            `UPDATE ${tableName} 
            SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? 
            WHERE ${whereClause} AND deleted_at IS NULL`,
            [deletedBy, ...whereParams]
        );
        
        // Create audit log for bulk operation
        await createAuditLog({
            userId: deletedBy,
            tableName,
            recordId: null,
            action: 'BULK_SOFT_DELETE',
            metadata: {
                whereClause,
                recordsDeleted: records.length,
                deletedRecordIds: records.map(r => r.id),
                timestamp: new Date().toISOString()
            }
        });
        
        console.log(`🗑️  Bulk soft deleted ${records.length} ${tableName} records by user ${deletedBy}`);
        return records.length;
    } catch (error) {
        console.error(`❌ Error bulk soft deleting ${tableName} records:`, error);
        throw error;
    }
}

/**
 * Restore a soft deleted record
 * @param {string} tableName - Table name
 * @param {number} recordId - Record ID to restore
 * @param {number} restoredBy - User ID performing the restoration
 * @returns {Promise<boolean>} - Success status
 */
async function restore(tableName, recordId, restoredBy) {
    try {
        // Get the deleted record for audit trail
        const record = await dbConfig.get(
            `SELECT * FROM ${tableName} WHERE id = ? AND deleted_at IS NOT NULL`,
            [recordId]
        );
        
        if (!record) {
            throw new Error(`Record ${recordId} not found or not deleted`);
        }
        
        // Restore the record
        await dbConfig.run(
            `UPDATE ${tableName} 
            SET deleted_at = NULL, deleted_by = NULL 
            WHERE id = ?`,
            [recordId]
        );
        
        // Create audit log
        await createAuditLog({
            userId: restoredBy,
            tableName,
            recordId,
            action: 'RESTORE',
            oldData: record,
            metadata: { timestamp: new Date().toISOString() }
        });
        
        console.log(`♻️  Restored ${tableName} record ${recordId} by user ${restoredBy}`);
        return true;
    } catch (error) {
        console.error(`❌ Error restoring ${tableName} record ${recordId}:`, error);
        throw error;
    }
}

/**
 * Get active (non-deleted) records
 * @param {string} tableName - Table name
 * @param {string} whereClause - Additional WHERE conditions (optional)
 * @param {Array} whereParams - Parameters for WHERE clause
 * @returns {Promise<Array>} - Array of active records
 */
async function getActiveRecords(tableName, whereClause = '', whereParams = []) {
    try {
        const deletedFilter = 'deleted_at IS NULL';
        const fullWhere = whereClause 
            ? `${whereClause} AND ${deletedFilter}` 
            : deletedFilter;
        
        const records = await dbConfig.query(
            `SELECT * FROM ${tableName} WHERE ${fullWhere}`,
            whereParams
        );
        
        return records || [];
    } catch (error) {
        console.error(`❌ Error getting active records from ${tableName}:`, error);
        throw error;
    }
}

/**
 * Get all records including soft deleted (for admin/audit purposes)
 * @param {string} tableName - Table name
 * @param {string} whereClause - Additional WHERE conditions (optional)
 * @param {Array} whereParams - Parameters for WHERE clause
 * @returns {Promise<Array>} - Array of all records
 */
async function getAllRecords(tableName, whereClause = '', whereParams = []) {
    try {
        const sql = whereClause 
            ? `SELECT * FROM ${tableName} WHERE ${whereClause}`
            : `SELECT * FROM ${tableName}`;
        
        const records = await dbConfig.query(sql, whereParams);
        return records || [];
    } catch (error) {
        console.error(`❌ Error getting all records from ${tableName}:`, error);
        throw error;
    }
}

/**
 * Permanently delete old soft-deleted records (cleanup task)
 * @param {string} tableName - Table name
 * @param {number} daysOld - Delete records soft-deleted more than this many days ago
 * @returns {Promise<number>} - Number of records permanently deleted
 */
async function permanentlyDeleteOld(tableName, daysOld = 90) {
    try {
        // Get records that will be permanently deleted
        const records = await dbConfig.query(
            `SELECT * FROM ${tableName} 
            WHERE deleted_at IS NOT NULL 
            AND deleted_at < CURRENT_TIMESTAMP - INTERVAL '${daysOld} days'`
        );
        
        // Permanently delete
        const result = await dbConfig.run(
            `DELETE FROM ${tableName} 
            WHERE deleted_at IS NOT NULL 
            AND deleted_at < CURRENT_TIMESTAMP - INTERVAL '${daysOld} days'`
        );
        
        // Create audit log for permanent deletion
        await createAuditLog({
            userId: null, // System operation
            tableName,
            recordId: null,
            action: 'PERMANENT_DELETE_CLEANUP',
            metadata: {
                recordsDeleted: records.length,
                daysOld,
                deletedRecordIds: records.map(r => r.id),
                timestamp: new Date().toISOString()
            }
        });
        
        console.log(`🧹 Permanently deleted ${records.length} old ${tableName} records (${daysOld}+ days old)`);
        return records.length;
    } catch (error) {
        console.error(`❌ Error permanently deleting old ${tableName} records:`, error);
        throw error;
    }
}

module.exports = {
    createAuditLog,
    softDelete,
    bulkSoftDelete,
    restore,
    getActiveRecords,
    getAllRecords,
    permanentlyDeleteOld
};
