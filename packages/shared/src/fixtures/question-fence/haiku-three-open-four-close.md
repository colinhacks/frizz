I haven't written the migration file: this session has no file or shell access. The SQL is in the card below so you can read it before anything runs against prod.

```question
id: approve-orders-archived-at-migration
kind: choice
question: Run this migration against the prod orders table?
options:
  - label: Approve and run
    description: adds the nullable column and builds the index without blocking reads or writes
    recommended: true
  - label: Decline
    description: nothing runs against prod
````

**Run as one non-transactional migration.** `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block.

```sql
SET lock_timeout = '5s';

ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_archived_at_idx
  ON orders (archived_at);
```

- Adding a nullable column with no default only changes the catalog, but it takes a brief ACCESS EXCLUSIVE lock. `lock_timeout` makes the statement fail after 5 seconds instead of queuing behind live traffic.
- The index build can take a while on a large `orders` table, but it does not block reads or writes.
- If the index build fails, it leaves an INVALID index. Find it with `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;`, drop it with `DROP INDEX CONCURRENTLY orders_archived_at_idx;`, then retry.
- Rollback: `DROP INDEX CONCURRENTLY IF EXISTS orders_archived_at_idx;` then `ALTER TABLE orders DROP COLUMN IF EXISTS archived_at;`

I chose the index name `orders_archived_at_idx`. Tell me if your naming convention differs.