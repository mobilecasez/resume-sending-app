# Soft Delete Quick Reference Guide

## 🚀 Quick Start

### Running Migrations (First Time Setup)

```bash
# Run all migrations
node run-migrations.js
```

This will:
1. Create `audit_log` table
2. Add `deleted_at` and `deleted_by` columns to all tables
3. Create indexes for performance

---

## 📝 Code Examples

### Soft Delete a Record

```javascript
const auditUtils = require('./server/utils/auditUtils');

// Delete a single record
await auditUtils.softDelete('recipients', recordId, userId, existingData);

// Bulk delete
await auditUtils.bulkSoftDelete('recipients', 'user_id = ?', [userId], userId);
```

### Query Active (Non-Deleted) Records

```javascript
// ALWAYS add: AND deleted_at IS NULL
const recipients = await dbConfig.query(
    'SELECT * FROM recipients WHERE user_id = ? AND deleted_at IS NULL',
    [userId]
);

// Or use utility
const recipients = await auditUtils.getActiveRecords(
    'recipients',
    'user_id = ?',
    [userId]
);
```

### Restore a Deleted Record (Admin)

```javascript
await auditUtils.restore('recipients', recordId, adminUserId);
```

---

## 🔍 Useful SQL Queries

### View Audit Trail for a Record

```sql
SELECT * FROM audit_log 
WHERE table_name = 'recipients' 
  AND record_id = 123 
ORDER BY created_at DESC;
```

### Find All Soft-Deleted Records

```sql
SELECT * FROM recipients 
WHERE deleted_at IS NOT NULL 
ORDER BY deleted_at DESC;
```

### See Who Deleted What Today

```sql
SELECT 
    al.table_name,
    al.record_id,
    al.user_id,
    u.email,
    al.created_at
FROM audit_log al
LEFT JOIN users u ON al.user_id = u.id
WHERE al.action = 'SOFT_DELETE'
  AND DATE(al.created_at) = CURRENT_DATE
ORDER BY al.created_at DESC;
```

### Count Soft-Deleted Records by Table

```sql
SELECT 
    'recipients' as table_name, 
    COUNT(*) as deleted_count 
FROM recipients WHERE deleted_at IS NOT NULL
UNION ALL
SELECT 
    'application_history', 
    COUNT(*) 
FROM application_history WHERE deleted_at IS NOT NULL
UNION ALL
SELECT 
    'review_cover_letters', 
    COUNT(*) 
FROM review_cover_letters WHERE deleted_at IS NOT NULL;
```

---

## 🧹 Maintenance

### Run Cleanup Job

```bash
# Delete records soft-deleted 90+ days ago
node cleanup-soft-deleted-records.js 90

# Custom retention period (180 days)
node cleanup-soft-deleted-records.js 180
```

### Schedule Cleanup (Cron)

```bash
# Run monthly on 1st at 2 AM
0 2 1 * * cd /path/to/app && node cleanup-soft-deleted-records.js 90
```

---

## ⚠️ Important Rules

1. **ALWAYS** filter `deleted_at IS NULL` in SELECT queries
2. **NEVER** use hard DELETE in application code
3. **ALWAYS** use `auditUtils.softDelete()` instead
4. **CREATE** audit logs for important actions
5. **TEST** restore functionality before deploying
6. **SCHEDULE** cleanup jobs for maintenance

---

## 📋 Checklist for New Features

When adding new tables or features:

- [ ] Add `deleted_at TIMESTAMP DEFAULT NULL` column
- [ ] Add `deleted_by INTEGER DEFAULT NULL` column
- [ ] Create index: `CREATE INDEX idx_{table}_deleted_at ON {table}(deleted_at) WHERE deleted_at IS NULL`
- [ ] Update all SELECT queries to filter `deleted_at IS NULL`
- [ ] Use `auditUtils.softDelete()` for deletions
- [ ] Add table to cleanup job if applicable
- [ ] Test restore functionality
- [ ] Document in audit system docs

---

## 🆘 Troubleshooting

### Issue: Seeing deleted records in queries
**Solution**: Add `AND deleted_at IS NULL` to WHERE clause

### Issue: Soft delete not working
**Solution**: Check that migrations have been run and columns exist

### Issue: Audit logs not being created
**Solution**: Check that `audit_log` table exists and `auditUtils` is imported

### Issue: Cannot restore deleted record
**Solution**: Verify record exists with `deleted_at IS NOT NULL`

---

## 📞 Support

For detailed documentation, see: `SOFT_DELETE_AUDIT_SYSTEM.md`

For questions or issues, contact the development team.
