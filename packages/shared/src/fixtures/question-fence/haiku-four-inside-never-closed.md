I can't write the migration file in this session because I have no filesystem access. The SQL is below, and it's in the approval card so you can read it on your phone.

```question
id: approve-archived-at-migration
kind: choice
question: Run the archived_at migration against prod: add a nullable timestamptz column to orders and build its index concurrently?
options:
  - label: Approve and run against prod
    description: adds the column and the index, with no table rewrite and no write lock held for the index build
    recommended: true
  - label: Decline
    description: nothing runs against prod
---
The migration, to run as one script outside a transaction block:

````sql
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
SET lock_timeout = '5s';

-- Nullable with no default: a catalog-only change, no table rewrite.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Builds without blocking writes. If a previous attempt left an INVALID index
-- with this name, drop it first: IF NOT EXISTS would skip it silently.
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_archived_at_idx
  ON orders (archived_at);
````

Notes:
- `ADD COLUMN` takes a brief ACCESS EXCLUSIVE lock. `lock_timeout` makes it fail fast rather than queue behind long reads.
- Rollback, if needed: `DROP INDEX CONCURRENTLY IF EXISTS orders_archived_at_idx;` then `ALTER TABLE orders DROP COLUMN IF EXISTS archived_at;`. The column drop discards any values written to it.
- Once approved, the file still needs to be written and committed in a session with filesystem access.
</br>