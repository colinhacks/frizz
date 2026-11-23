No migration file is written and nothing has run against prod. This session has no filesystem or shell, so the SQL lives only in the question below. Two things to check before approving:

- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. If your migration tool wraps each migration in one, this file needs to opt out of that.
- A failed concurrent build leaves an `INVALID` index behind. The rollback in the card drops it.

```question
id: orders-archived-at-migration
kind: choice
question: Run the migration adding nullable archived_at timestamptz and its concurrent index to prod orders?
options:
  - label: Run it against prod as written
    description: adds the column (metadata-only) and builds the index without blocking writes
    recommended: true
  - label: Hold it
    description: nothing changes in prod; the migration file is still to be written
---
The SQL, to run outside a transaction:

````sql
-- up
ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_archived_at_idx ON orders (archived_at);

-- down (rollback)
DROP INDEX CONCURRENTLY IF EXISTS orders_archived_at_idx;
ALTER TABLE orders DROP COLUMN IF EXISTS archived_at;
````

Notes:
- Adding a nullable column with no default does not rewrite the table.
- The concurrent index build scans the whole table. It is slower than a plain build but does not block reads or writes.
- Not verified: the migration tool and its transaction behavior, the current `orders` size, and whether `archived_at` already exists. `IF NOT EXISTS` covers the last case.
- Scope: the `orders` table migration only. There is no PR yet.
- Once you approve, I will write the migration file in the matching format for your tool and report the result.
```