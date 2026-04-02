---
mode: agent
description: Full deploy checklist for CVApplyr on Railway — includes mandatory schema comparison before every deploy
---

# CVApplyr Deploy Checklist

## ⚠️ MANDATORY STEPS BEFORE EVERY DEPLOY

### 1. Run Full Database Schema Comparison

Before deploying ANY code changes, compare the local schema against production to catch ALL missing tables/columns at once. Never fix schema gaps one error at a time.

```bash
cd "/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app"

python3 - << 'EOF'
import subprocess, json

result = subprocess.run(['railway', 'variables', '--json'], capture_output=True, text=True)
db_url = json.loads(result.stdout)['DATABASE_URL']

pg = subprocess.run(
    ['psql', f'{db_url}?sslmode=require', '--no-psqlrc', '-t', '-A', '-F|',
     '-c', "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, column_name;"],
    capture_output=True, text=True
)

prod = {}
for line in pg.stdout.strip().split('\n'):
    if '|' not in line: continue
    parts = line.split('|')
    if len(parts) >= 2:
        tbl, col = parts[0].strip(), parts[1].strip()
        prod.setdefault(tbl, set()).add(col)

print("=== PRODUCTION SCHEMA ===")
for t in sorted(prod):
    print(f"  {t}: {sorted(prod[t])}")
EOF
```

Then compare against the local desired schema defined in:
- `database/postgres-schema.sql` — all CREATE TABLE statements
- `db-init.js` — all ALTER TABLE migrations

**Generate a complete SQL patch for ALL gaps and apply it in one shot** — never fix one error at a time:

```bash
PGURL=$(railway variables --json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['DATABASE_URL'])")
psql "${PGURL}?sslmode=require" --no-psqlrc -f /tmp/schema-patch.sql
```

---

### 2. Update Local Schema Files After Any DB Change

When you add a column or table directly in production (via psql), you MUST also update both:
1. `database/postgres-schema.sql` — add the column/table to the `CREATE TABLE IF NOT EXISTS` block
2. `db-init.js` — add an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration block so it auto-applies on next server start

If you skip either file, the schema will drift again on the next fresh deploy.

---

### 3. Commit & Deploy

```bash
# 1. Commit all changes
git add -A && git commit -m "your message"

# 2. Push to GitHub
git push origin main

# 3. Deploy to Railway (GitHub auto-deploy is NOT configured — always run this manually)
railway up --detach

# 4. Watch logs to confirm successful boot
railway logs --tail 50
```

---

### 4. Verify After Deploy

Check logs for any new DB errors immediately after deploy:

```bash
railway logs --tail 50 2>&1 | grep -iE "error|column.*does not exist|relation.*does not exist"
```

If you see any `column "x" does not exist` or `relation "y" does not exist` errors → run the schema comparison again (Step 1) and fix ALL gaps at once.

---

## Key Files

| File | Purpose |
|---|---|
| `database/postgres-schema.sql` | Source of truth for all table definitions |
| `db-init.js` | Runs migrations on every server startup |
| `server/migrations/002_add_soft_delete_columns.js` | Soft-delete migration (also wired into db-init.js) |

## Common Schema Columns That Must Exist

All user-facing tables need these soft-delete columns:
- `deleted_at TIMESTAMP DEFAULT NULL`
- `deleted_by INTEGER DEFAULT NULL`

Tables: `recipients`, `application_history`, `review_cover_letters`, `plans`, `notifications`, `users`, `credit_transactions`, `user_credits`, `payment_orders`
