I can't write the migration file or run anything in this session, so the SQL below is untested against the real `orders` table and I haven't checked the Postgres version. The migration is ready for approval in the card. Once approved, it still needs to run outside a transaction, since `CREATE INDEX CONCURRENTLY` fails inside one.

```question
id: orders-archived-at-prod
kind: choice
question: Run the orders.archived_at migration against prod exactly as written in the context?
options:
  - label: Approve and run
    description: adds a nullable column (no table rewrite) and a concurrent index
    recommended: true
  - label: Do not run
    description: leave the migration unapplied
---
```sql
-- Migration: add nullable archived_at to orders.
-- Run outside a transaction; CREATE INDEX CONCURRENTLY cannot run inside one.

SET lock_timeout = '5s';

ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_archived_at_idx
  ON orders (archived_at);
```

- The `ALTER` takes a brief ACCESS EXCLUSIVE lock. `lock_timeout = '5s'` makes it fail rather than queue behind long transactions and block other queries.
- The concurrent index build does not block reads or writes, but it takes longer on a large table.
- If the index build fails, it can leave an INVALID index behind. Check `pg_index.indisvalid` for `orders_archived_at_idx` and drop it before retrying.

Rollback, if needed:

```sql
DROP INDEX CONCURRENTLY IF EXISTS orders_archived_at_idx;
ALTER TABLE orders DROP COLUMN IF EXISTS archived_at;
```
```