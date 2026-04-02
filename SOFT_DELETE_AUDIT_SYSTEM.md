# Soft Delete & Audit System Implementation

## 🎯 Overview

This document describes the comprehensive **Soft Delete and Audit Trail system** implemented across the entire application to prevent permanent data loss and maintain complete audit trails.

## ⚠️ Critical Issue Fixed

**PROBLEM**: The application was using HARD DELETES throughout, which permanently removed user data from the database with no recovery option or audit trail.

**AFFECTED TABLES**:
- `recipients` - Job application recipient contacts
- `application_history` - User's job application tracking
- `review_cover_letters` - Generated cover letter drafts
- `plans` - Pricing packages (admin)
- `notifications` - User notifications
- `users` - User accounts
- `credit_transactions` - Credit purchase/usage records
- `user_credits` - User credit balances
- `payment_orders` - Payment transaction records

**SOLUTION**: Implemented soft delete system with comprehensive audit logging.

---

## 📋 Database Changes

### 1. Audit Log Table

**New Table**: `audit_log`

Tracks all data modifications and deletions for compliance and recovery.

```sql
CREATE TABLE audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    table_name VARCHAR(100) NOT NULL,
    record_id INTEGER,
    action VARCHAR(50) NOT NULL,
    old_data TEXT,
    new_data TEXT,
    ip_address VARCHAR(50),
    user_agent TEXT,
    metadata TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
```

**Actions Tracked**:
- `SOFT_DELETE` - Record soft deleted
- `BULK_SOFT_DELETE` - Multiple records soft deleted
- `RESTORE` - Soft deleted record restored
- `PERMANENT_DELETE_CLEANUP` - Old records permanently removed (90+ days)
- `CREATE` - New record created
- `UPDATE` - Existing record modified

### 2. Soft Delete Columns

**Added to ALL tables**:
```sql
ALTER TABLE {table_name} 
    ADD COLUMN deleted_at TIMESTAMP DEFAULT NULL,
    ADD COLUMN deleted_by INTEGER DEFAULT NULL;

CREATE INDEX idx_{table_name}_deleted_at 
    ON {table_name}(deleted_at) 
    WHERE deleted_at IS NULL;
```

**Columns**:
- `deleted_at` - Timestamp when record was soft deleted (NULL = active)
- `deleted_by` - User ID who performed the deletion

**Tables Updated**:
- recipients
- application_history
- review_cover_letters
- plans
- notifications
- users
- credit_transactions
- user_credits
- payment_orders

---

## 🔧 Implementation Details

### Utility Functions (`server/utils/auditUtils.js`)

#### `createAuditLog(params)`
Creates an audit log entry for any action.

```javascript
await auditUtils.createAuditLog({
    userId: 123,
    tableName: 'recipients',
    recordId: 456,
    action: 'SOFT_DELETE',
    oldData: { email: 'old@example.com' },
    metadata: { reason: 'User requested' }
});
```

#### `softDelete(tableName, recordId, deletedBy, recordData)`
Soft deletes a single record.

```javascript
await auditUtils.softDelete('recipients', 456, userId, existingData);
```

#### `bulkSoftDelete(tableName, whereClause, whereParams, deletedBy)`
Soft deletes multiple records at once.

```javascript
await auditUtils.bulkSoftDelete(
    'recipients', 
    'user_id = ?', 
    [userId], 
    userId
);
```

#### `restore(tableName, recordId, restoredBy)`
Restores a soft deleted record.

```javascript
await auditUtils.restore('recipients', 456, adminUserId);
```

#### `getActiveRecords(tableName, whereClause, whereParams)`
Retrieves only active (non-deleted) records.

```javascript
const active = await auditUtils.getActiveRecords(
    'recipients', 
    'user_id = ?', 
    [userId]
);
```

#### `permanentlyDeleteOld(tableName, daysOld)`
Cleanup job - permanently deletes soft-deleted records older than X days.

```javascript
// Delete records soft-deleted 90+ days ago
await auditUtils.permanentlyDeleteOld('recipients', 90);
```

---

## 🔄 Controller Changes

### Before (HARD DELETE ❌)
```javascript
// DESTRUCTIVE - No recovery possible!
await dbConfig.run('DELETE FROM recipients WHERE user_id = ?', [userId]);
```

### After (SOFT DELETE ✅)
```javascript
// SAFE - Preserves data with audit trail
await auditUtils.bulkSoftDelete('recipients', 'user_id = ?', [userId], userId);
```

### Query Updates

**Before (shows deleted records ❌)**:
```javascript
const recipients = await dbConfig.query(
    'SELECT * FROM recipients WHERE user_id = ?', 
    [userId]
);
```

**After (filters deleted records ✅)**:
```javascript
const recipients = await dbConfig.query(
    'SELECT * FROM recipients WHERE user_id = ? AND deleted_at IS NULL', 
    [userId]
);
```

---

## 📁 Updated Files

### Migrations
1. `server/migrations/001_create_audit_log_table.js` - Creates audit_log table
2. `server/migrations/002_add_soft_delete_columns.js` - Adds soft delete columns

### Utilities
- `server/utils/auditUtils.js` - Soft delete & audit utilities

### Controllers Updated
1. **userDataController.js**
   - `saveRecipients()` - Soft delete existing recipients
   - `getRecipients()` - Filter deleted recipients
   - `saveApplicationHistory()` - Soft delete existing history
   - `getApplicationHistory()` - Filter deleted history
   - `saveReviewCoverLetters()` - Soft delete existing letters
   - `getReviewCoverLetters()` - Filter deleted letters

2. **adminPackagesController.js**
   - `getActivePackages()` - Filter deleted plans
   - `getAllPackages()` - Filter deleted plans (admin)
   - `getPackageById()` - Filter deleted plan
   - `deletePackage()` - Soft delete instead of hard delete

3. **notificationsController.js**
   - `getUserNotifications()` - Filter deleted notifications
   - `deleteNotification()` - Soft delete notification
   - `deleteAllRead()` - Bulk soft delete read notifications

4. **creditsController.js**
   - `getPlans()` - Filter deleted plans
   - Updated `application_history` queries to filter deleted

5. **paymentController.js**
   - Updated plan validation to filter deleted plans

---

## 🚀 Running Migrations

### Option 1: Direct Execution
```bash
node server/migrations/001_create_audit_log_table.js
node server/migrations/002_add_soft_delete_columns.js
```

### Option 2: Migration Runner (Recommended)
```bash
node run-migrations.js
```

---

## 🔍 Usage Examples

### Example 1: Soft Delete User's Recipients
```javascript
// Old way (DESTRUCTIVE)
await dbConfig.run('DELETE FROM recipients WHERE user_id = ?', [userId]);

// New way (SAFE)
await auditUtils.bulkSoftDelete('recipients', 'user_id = ?', [userId], userId);

// Result: Records marked with deleted_at timestamp, preserved in database
// Audit log entry created with details of all deleted records
```

### Example 2: Get Active Recipients Only
```javascript
// Old way (includes deleted)
const recipients = await dbConfig.query(
    'SELECT * FROM recipients WHERE user_id = ?', 
    [userId]
);

// New way (excludes deleted)
const recipients = await dbConfig.query(
    'SELECT * FROM recipients WHERE user_id = ? AND deleted_at IS NULL', 
    [userId]
);
```

### Example 3: Restore Deleted Record (Admin)
```javascript
// Restore a soft-deleted package
await auditUtils.restore('plans', packageId, adminUserId);

// Audit log entry created documenting the restoration
```

### Example 4: Review Audit Trail
```sql
-- See all deletions by a specific user
SELECT * FROM audit_log 
WHERE user_id = 123 
  AND action LIKE '%DELETE%' 
ORDER BY created_at DESC;

-- See all modifications to a specific record
SELECT * FROM audit_log 
WHERE table_name = 'recipients' 
  AND record_id = 456 
ORDER BY created_at ASC;

-- See all actions in the last 24 hours
SELECT * FROM audit_log 
WHERE created_at > NOW() - INTERVAL '24 hours' 
ORDER BY created_at DESC;
```

---

## 🧹 Cleanup & Maintenance

### Scheduled Cleanup Job (Recommended)

Create a cron job or scheduled task to permanently delete old soft-deleted records:

```javascript
// cleanup-job.js
const auditUtils = require('./server/utils/auditUtils');

async function runCleanup() {
    const tables = [
        'recipients',
        'application_history',
        'review_cover_letters',
        'notifications'
    ];
    
    for (const table of tables) {
        const deleted = await auditUtils.permanentlyDeleteOld(table, 90);
        console.log(`Cleaned up ${deleted} old records from ${table}`);
    }
}

runCleanup();
```

**Schedule**: Run monthly or quarterly
**Retention**: 90 days recommended (configurable)

---

## ✅ Benefits

1. **Data Recovery**: Accidentally deleted data can be restored
2. **Audit Compliance**: Complete trail of all data modifications
3. **User Protection**: Users won't lose their work permanently
4. **Analytics**: Can analyze deletion patterns and user behavior
5. **Legal Protection**: Maintain records for compliance requirements
6. **Debugging**: Can track down data issues by reviewing audit logs

---

## 🔒 Security Considerations

1. **Access Control**: Only admins should access audit logs
2. **PII Protection**: Consider encrypting sensitive data in audit logs
3. **Retention Policy**: Delete audit logs after legal retention period
4. **Permissions**: Restrict who can restore deleted records
5. **Monitoring**: Alert on unusual deletion patterns

---

## 📊 Monitoring

### Key Metrics to Track

```sql
-- Deletions per day
SELECT DATE(created_at) as date, COUNT(*) as deletions
FROM audit_log
WHERE action = 'SOFT_DELETE'
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- Most deleted tables
SELECT table_name, COUNT(*) as count
FROM audit_log
WHERE action = 'SOFT_DELETE'
  AND created_at > NOW() - INTERVAL '30 days'
GROUP BY table_name
ORDER BY count DESC;

-- Users making most deletions
SELECT user_id, COUNT(*) as deletion_count
FROM audit_log
WHERE action = 'SOFT_DELETE'
  AND created_at > NOW() - INTERVAL '30 days'
GROUP BY user_id
ORDER BY deletion_count DESC
LIMIT 10;
```

---

## 🎓 Best Practices

1. **Always use soft delete for user data**
2. **Create audit log entries for important actions**
3. **Filter deleted records in all SELECT queries** (`WHERE deleted_at IS NULL`)
4. **Review audit logs regularly** for suspicious activity
5. **Set up retention policies** for permanent deletion
6. **Test restore functionality** periodically
7. **Document recovery procedures** for emergencies

---

## 🚨 Important Notes

- **Breaking Change**: Existing code that doesn't filter `deleted_at IS NULL` will show deleted records
- **Performance**: Indexes created on `deleted_at` column for optimal query performance
- **Backward Compatibility**: Old data has `deleted_at = NULL` (active)
- **Audit Log Size**: Monitor growth, implement archival strategy if needed
- **Foreign Keys**: ON DELETE CASCADE behavior preserved for actual deletions

---

## 📞 Support

For questions or issues with the soft delete system, contact the development team or check the audit logs for historical context.

---

## 🔄 Version History

- **v1.0** - Initial implementation (2026-02-20)
  - Added audit_log table
  - Added soft delete columns to all tables
  - Updated all controllers to use soft deletes
  - Created utility functions
  - Updated all queries to filter deleted records

---

## 📝 TODO: Future Enhancements

- [ ] Admin UI for reviewing audit logs
- [ ] Admin UI for restoring deleted records
- [ ] Automated cleanup job scheduler
- [ ] Email notifications for bulk deletions
- [ ] Export audit logs for compliance reporting
- [ ] Encrypted audit log storage for sensitive data
- [ ] Real-time deletion monitoring dashboard
- [ ] Batch restore functionality for admins
