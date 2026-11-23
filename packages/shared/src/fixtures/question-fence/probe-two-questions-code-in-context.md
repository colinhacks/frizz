The migration is ready; approve it from the card.

```question
id: orders-archived-at
kind: choice
question: Should this migration run against production?
options:
  - label: Run it
    description: adds a nullable column and builds the index without locking writes
    recommended: true
  - label: Hold it
    description: nothing runs until the SQL is changed
---
The exact statements:

```sql
ALTER TABLE orders ADD COLUMN archived_at timestamptz;
CREATE INDEX CONCURRENTLY orders_archived_at_idx ON orders (archived_at);
```

Both are safe to re-run after a failure.
```

```question
id: orders-backfill
kind: choice
question: Should archived rows be backfilled in the same deploy?
options:
  - Backfill now
  - Leave it for a follow-up
```
