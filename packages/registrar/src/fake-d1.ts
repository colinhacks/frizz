import { DatabaseSync } from "node:sqlite"
import type { D1Database, D1PreparedStatement } from "./claim-db.ts"

/**
 * Cloudflare's D1 for tests, on Node's own SQLite: the same SQL, the same numbered parameters, and the
 * same atomic conditional UPDATE the registry's lock rests on. `latencyMs` puts a real wait before every
 * call, so concurrent claims interleave the way they would across the network, which is what a race
 * test needs and what an instant fake would hide.
 */
export function fakeD1({ latencyMs = 0 }: { latencyMs?: number } = {}): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:")
  const tick = () => (latencyMs ? new Promise<void>((resolve) => setTimeout(resolve, latencyMs)) : Promise.resolve())
  type Statement = D1PreparedStatement & { sql: string; values: unknown[] }
  const statement = (sql: string, values: unknown[] = []): Statement => ({
    sql,
    values,
    bind: (...next: unknown[]) => statement(sql, next),
    async first<T>() {
      await tick()
      return (sqlite.prepare(sql).get(...(values as never[])) as T | undefined) ?? null
    },
    async run() {
      await tick()
      const result = sqlite.prepare(sql).run(...(values as never[]))
      return { meta: { changes: Number(result.changes) } }
    },
    async all<T>() {
      await tick()
      return { results: sqlite.prepare(sql).all(...(values as never[])) as T[] }
    },
  })
  return {
    sqlite,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      await tick()
      // D1 runs a batch as one transaction: all of it or none.
      sqlite.exec("BEGIN")
      try {
        const results = (statements as Statement[]).map((s) => sqlite.prepare(s.sql).run(...(s.values as never[])))
        sqlite.exec("COMMIT")
        return results
      } catch (error) {
        sqlite.exec("ROLLBACK")
        throw error
      }
    },
  }
}
