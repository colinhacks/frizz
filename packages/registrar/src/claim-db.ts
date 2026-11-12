import type { ClaimRecord, ClaimStore } from "./claim-handler.ts"
import type { KvNamespace } from "./worker.ts"

/**
 * The registry's one source of truth: a D1 database, with every claim serialized behind one lock row.
 *
 * WHY NOT KV ALONE (2026-11-12). KV has no compare-and-set, and a read may be served from an edge cache
 * for up to a minute after another location wrote. So every "one per" rule read KV, found nothing, and
 * wrote: ten claims sent at once from one GitHub account won ten names, two keys could both win one free
 * name, and a key could end up holding two custom names (plans/frizz-sh-claim-review-2026-11-07.md, M1).
 * D1 has one primary, so a read after a write sees it, and a conditional UPDATE is atomic, which is what
 * the lock below rests on.
 *
 * WHY NOT A DURABLE OBJECT, the more natural lock: a new Durable Object class needs a migration, which
 * `wrangler versions upload` refuses to apply, and the `wrangler deploy` that can apply it also publishes
 * the routes and custom domain, which the one-hour deploy token cannot touch on purpose.
 *
 * THE RELAY STILL READS KV. It looks up `claim:<name>` on every board's handshake and holds no D1 binding,
 * so each claim row written here is copied to KV straight after, and removed there with it. D1 is written
 * first: a KV row with no D1 row behind it would be a name the relay serves and the registrar forgets.
 * The other indexes (`owner:`, `gh:`, `retired:`) live only here; their old KV copies are read once, by
 * importFromKv, and never again.
 */

/** Structural, like KvNamespace: the methods of Cloudflare's D1 binding this file uses, and no more. */
export interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<{ meta: { changes: number } }>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS claims (name TEXT PRIMARY KEY, record TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS owners (pubkey TEXT PRIMARY KEY, name TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS accounts (github_id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS retired (name TEXT PRIMARY KEY, pubkey TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS budgets (key TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  "INSERT OR IGNORE INTO lock (id, holder, expires_at) VALUES (1, '', 0)",
]

/** Isolates that have already created the tables. Creating them is idempotent; this only saves the trip. */
const ready = new WeakSet<D1Database>()

export async function ensureSchema(db: D1Database): Promise<void> {
  if (ready.has(db)) return
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)))
  ready.add(db)
}

/**
 * How long the lock is held before another claim may take it anyway. A claim asks GitHub at most once,
 * with a ten-second limit (githubVerifier), so a holder still running at thirty seconds has died, and a
 * name must never be stuck behind a Worker that was killed mid-claim.
 */
export const LOCK_LEASE_MS = 30_000

/** How long a claim waits for the lock before it is answered "busy". */
export const LOCK_WAIT_MS = 10_000

export class RegistrarBusy extends Error {
  constructor() {
    super("the registrar is busy with other claims")
  }
}

export interface LockOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  holder?: string
  leaseMs?: number
  waitMs?: number
}

/**
 * Run `work` while holding the registry's one lock: every claim and every sweep, one at a time.
 *
 * Claims are rare (one per board, then a renewal per launch), so one at a time costs nothing a person
 * would notice, and it is what makes each "one per" rule true rather than true unless two arrive together.
 */
export async function withClaimLock<T>(db: D1Database, work: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const holder = options.holder ?? crypto.randomUUID()
  const leaseMs = options.leaseMs ?? LOCK_LEASE_MS
  const deadline = now() + (options.waitMs ?? LOCK_WAIT_MS)
  await ensureSchema(db)
  for (let attempt = 0; ; attempt++) {
    const at = now()
    const taken = await db
      .prepare("UPDATE lock SET holder = ?1, expires_at = ?2 WHERE id = 1 AND expires_at <= ?3")
      .bind(holder, at + leaseMs, at)
      .run()
    if (taken.meta.changes === 1) break
    if (at >= deadline) throw new RegistrarBusy()
    // Backs off from 25 ms to 400 ms: a renewal holds the lock for a few milliseconds, a first custom
    // claim for one GitHub round trip.
    await sleep(Math.min(400, 25 * 2 ** Math.min(attempt, 4)))
  }
  try {
    return await work()
  } finally {
    // Only our own hold: a holder past its lease may already have been replaced, and must not free the next one.
    await db.prepare("UPDATE lock SET holder = '', expires_at = 0 WHERE id = 1 AND holder = ?1").bind(holder).run()
  }
}

/** The registry in D1, with each claim row copied to KV for the relay. Call only inside withClaimLock. */
export function d1ClaimStore(db: D1Database, kv: KvNamespace): ClaimStore & { count(): Promise<number> } {
  const one = async (sql: string, ...values: unknown[]) => (await db.prepare(sql).bind(...values).first<{ value: string }>())?.value ?? null
  return {
    async read(name) {
      const raw = await one("SELECT record AS value FROM claims WHERE name = ?1", name)
      if (!raw) return null
      try {
        return JSON.parse(raw) as ClaimRecord
      } catch {
        return null
      }
    },
    async write(name, record) {
      const raw = JSON.stringify(record)
      await db.prepare("INSERT INTO claims (name, record) VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET record = excluded.record").bind(name, raw).run()
      await kv.put(`claim:${name}`, raw)
    },
    async remove(name) {
      await db.prepare("DELETE FROM claims WHERE name = ?1").bind(name).run()
      await kv.delete(`claim:${name}`)
    },
    async list() {
      const { results } = await db.prepare("SELECT name FROM claims").all<{ name: string }>()
      return results.map((row) => row.name)
    },
    async count() {
      return Number((await db.prepare("SELECT COUNT(*) AS value FROM claims").first<{ value: number }>())?.value ?? 0)
    },
    readOwner: (pubkey) => one("SELECT name AS value FROM owners WHERE pubkey = ?1", pubkey),
    async writeOwner(pubkey, name) {
      await db.prepare("INSERT INTO owners (pubkey, name) VALUES (?1, ?2) ON CONFLICT (pubkey) DO UPDATE SET name = excluded.name").bind(pubkey, name).run()
    },
    async removeOwner(pubkey) {
      await db.prepare("DELETE FROM owners WHERE pubkey = ?1").bind(pubkey).run()
    },
    readGithubOwner: (githubId) => one("SELECT name AS value FROM accounts WHERE github_id = ?1", githubId),
    async writeGithubOwner(githubId, name) {
      await db.prepare("INSERT INTO accounts (github_id, name) VALUES (?1, ?2) ON CONFLICT (github_id) DO UPDATE SET name = excluded.name").bind(githubId, name).run()
    },
    async removeGithubOwner(githubId) {
      await db.prepare("DELETE FROM accounts WHERE github_id = ?1").bind(githubId).run()
    },
    readRetired: (name) => one("SELECT pubkey AS value FROM retired WHERE name = ?1", name),
    async writeRetired(name, pubkey) {
      // No expiry: a random name is never handed to another key.
      await db.prepare("INSERT INTO retired (name, pubkey) VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET pubkey = excluded.pubkey").bind(name, pubkey).run()
    },
  }
}

/**
 * An hourly budget counted exactly, in D1. Inside the lock, so two claims cannot both read the same count,
 * which the KV counters this replaced allowed.
 */
export function d1HourlyBudget(db: D1Database, key: string, perHour: number, now: () => number = Date.now): () => Promise<boolean> {
  return async () => {
    const bucket = Math.floor(now() / 3_600_000)
    const row = `${key}:${bucket}`
    const used = Number((await db.prepare("SELECT used AS value FROM budgets WHERE key = ?1").bind(row).first<{ value: number }>())?.value ?? 0)
    if (used >= perHour) return false
    await db
      .prepare("INSERT INTO budgets (key, used, expires_at) VALUES (?1, 1, ?2) ON CONFLICT (key) DO UPDATE SET used = used + 1")
      .bind(row, (bucket + 2) * 3_600_000)
      .run()
    return true
  }
}

/** Drop budget rows whose hour has passed. The daily sweep calls it; nothing else depends on it. */
export async function dropSpentBudgets(db: D1Database, now: number): Promise<void> {
  await db.prepare("DELETE FROM budgets WHERE expires_at < ?1").bind(now).run()
}

/**
 * Copy the registry KV held before 2026-11-12 into D1, once. Inside the lock, so no claim can land between
 * the copy and the flag. A row already in D1 wins: by then D1 is the truth, and KV only a copy of it.
 */
export async function importFromKv(db: D1Database, kv: KvNamespace): Promise<number> {
  if (await db.prepare("SELECT value FROM meta WHERE key = 'imported-from-kv'").first()) return 0
  const tables: Array<[prefix: string, sql: string]> = [
    ["claim:", "INSERT OR IGNORE INTO claims (name, record) VALUES (?1, ?2)"],
    ["owner:", "INSERT OR IGNORE INTO owners (pubkey, name) VALUES (?1, ?2)"],
    ["gh:", "INSERT OR IGNORE INTO accounts (github_id, name) VALUES (?1, ?2)"],
    ["retired:", "INSERT OR IGNORE INTO retired (name, pubkey) VALUES (?1, ?2)"],
  ]
  let copied = 0
  for (const [prefix, sql] of tables) {
    let cursor: string | undefined
    for (;;) {
      const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) })
      for (const { name: key } of page.keys) {
        const value = await kv.get(key)
        if (value === null) continue
        const id = key.slice(prefix.length)
        await db.prepare(sql).bind(prefix === "gh:" ? Number(id) : id, value).run()
        copied++
      }
      if (page.list_complete || !page.cursor) break
      cursor = page.cursor
    }
  }
  await db.prepare("INSERT INTO meta (key, value) VALUES ('imported-from-kv', ?1)").bind(String(copied)).run()
  return copied
}
