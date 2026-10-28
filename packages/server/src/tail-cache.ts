import { createHash } from "node:crypto"
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { join } from "node:path"
import type { ProjectScope } from "./project-scope.ts"
import type Database from "./sqlite.ts"

// ── The durable tail-state cache ───────────────────────────────────────────────────────────────────
// The tailer's FIRST tick primes every registry row by folding its ENTIRE JSONL from byte 0. On the
// maintainer's own board that is 379MB of JSON.parse across 165 threads — 10-16s of synchronous boot,
// every boot, for transcripts that finished weeks ago and will never change again. It is also the one
// part of boot that is O(all threads x transcript bytes), so it is what breaks at thousands of threads.
//
// This cache removes the RE-read. A thread's derived tail state is a pure left fold over the bytes of
// its transcript, so the state at byte offset N is fully determined by bytes [0, N). Persist that state
// alongside the exact file identity it was folded from, and the next boot can resume the fold at N
// instead of at 0 — reading only what was appended since (usually nothing).
//
// WHAT IT IS KEYED ON — deliberately never "the row says done":
//   * the transcript's INODE          — a replaced/rotated file is a different file, never a hit
//   * its SIZE >= the cached offset   — a shrunk file was truncated; the prefix is not ours
//   * its MTIME                       — recorded, and re-verified below when nothing appears to have moved
//   * a CONTENT digest of the first 1KiB and of the 1KiB ending at the cached offset, so an in-place
//     rewrite that happens to preserve inode+size+mtime still misses
//   * the FOLD SCHEMA digest — a content hash of the modules that DEFINE the derivation. Change how a
//     record folds and every cached state is invalidated automatically, with no version constant to
//     remember to bump. This is the difference between a cache and a silent correctness bug: a thread
//     that never changes again would otherwise keep its pre-upgrade derivation forever.
//
// A thread whose transcript GREW is still a hit: the state resumes at the cached offset and the tailer
// consumes only the delta — the same bytes it would have consumed had the server never restarted.
//
// COLD OR CORRUPT DEGRADES TO SLOW, NEVER TO WRONG. Every read path is wrapped: a missing table, an
// unparseable blob, a schema mismatch, a stat failure, a digest mismatch — all resolve to "no entry",
// which is exactly the pre-cache behaviour (fold from byte 0). Writes are best-effort for the same
// reason; a failed write only costs the next boot its speedup.

/** Bytes sampled at each end of the folded prefix for the content fence. */
const SAMPLE_BYTES = 1024

/**
 * Refuse to cache a state whose serialization is pathologically large. Nothing in a TailState is
 * unbounded (previews are capped, the retired rings are capped), but a future field could be — and a
 * multi-megabyte row per thread would trade the boot read for a boot read.
 */
const MAX_STATE_BYTES = 256 * 1024

export interface TailCacheFence {
  /** Byte cursor the cached state was folded to (state.offset). */
  offset: number
  size: number
  mtimeMs: number
  ino: string
  /** sha256 over the offset plus the first and last SAMPLE_BYTES of the folded prefix. */
  contentDigest: string
}

export interface TailCacheEntry extends TailCacheFence {
  slug: string
  sessionId: string
  nativeSessionId: string
  runtimeGeneration: number
  path: string
  /** Encoded TailState (see encodeTailState). */
  state: string
}

export interface TailStateCache {
  /** Every cached entry for this project, keyed by slug. Never throws. */
  load(): Map<string, TailCacheEntry>
  /** Upsert a batch in one transaction. Best-effort: a failure is swallowed. */
  put(entries: TailCacheEntry[]): void
  /** Drop entries for slugs that no longer exist in the registry. Best-effort. */
  prune(liveSlugs: Set<string>): void
}

// ── fold-schema identity ───────────────────────────────────────────────────────────────────────────
// The modules whose code decides what a folded state CONTAINS. If any of them changes, every cached
// state was produced by a different derivation and must be discarded. The shared module is in the
// list because the signal-fence parser (`splitAwaitingFrontmatter`, `lastFence`'s hints) has lived
// there since 2026-08-24 — a parser fix on 2026-09-10 would otherwise have left every cached
// `lastFence` carrying the old derivation until its transcript happened to grow.
//
// The question-fence parser and the code-fence scanner under it are listed since 2026-10-13: they decide
// which messages a cached `questionSightings` holds (tailer noteQuestionFences), and they are their own
// files, which `index.ts` only re-exports — a parser fix there changed no byte this digest read. The ACP
// fold is listed for the same reason the other two backends are.
const FOLD_SOURCES = [
  "transcript.ts", "tailer.ts", "backend/claude.ts", "backend/codex.ts", "backend/acp-transcript.ts",
  "../../shared/src/index.ts", "../../shared/src/question-fence.ts", "../../shared/src/code-fences.ts",
]

let foldSchemaMemo: string | null = null

/**
 * A content digest of the fold implementation. Falls back to a fixed constant when the sources are not
 * readable (a packaging shape that does not ship them) — in which case invalidation reverts to the
 * ordinary "bump it by hand" discipline rather than silently accepting stale states.
 *
 * That shape is every PUBLISHED server: `frizz-server` ships an esbuild bundle and no .ts, so this is
 * the constant there and the bump below is the only thing that re-derives a cached tail after an
 * upgrade. v2 (2026-10-28): FoldState.handoffAt, without which a thread already parked on a handoff the
 * human never saw stays in Snoozed (board handoffStands).
 */
export function foldSchemaDigest(dir = import.meta.dirname): string {
  if (foldSchemaMemo) return foldSchemaMemo
  const hash = createHash("sha256").update("frizz-tail-state-v2\0")
  let read = 0
  for (const name of FOLD_SOURCES) {
    try {
      hash.update(name).update("\0").update(readFileSync(join(dir, name)))
      read++
    } catch {
      // Missing source: recorded as absent so a partial read is still a distinct identity.
      hash.update(name).update("\0missing\0")
    }
  }
  foldSchemaMemo = read === 0 ? "frizz-tail-state-v2-unreadable" : hash.digest("hex").slice(0, 32)
  return foldSchemaMemo
}

// ── state codec ────────────────────────────────────────────────────────────────────────────────────
// GENERIC on purpose. A hand-written field list is a standing bug: whoever adds the next TailState
// field will not remember to add it here, and the cache would then hand back a state missing it — a
// silent, thread-permanent wrongness. Everything in a TailState is JSON-shaped except its Maps, so one
// Map-aware replacer/reviver round-trips the WHOLE object, including fields that do not exist yet.

interface EncodedMap {
  __map: [string, unknown][]
}

interface EncodedSet {
  __set: unknown[]
}

const isEncodedMap = (value: unknown): value is EncodedMap =>
  Boolean(value) && typeof value === "object" && Array.isArray((value as EncodedMap).__map)
const isEncodedSet = (value: unknown): value is EncodedSet =>
  Boolean(value) && typeof value === "object" && Array.isArray((value as EncodedSet).__set)

export function encodeTailState(state: object): string {
  return JSON.stringify(state, (_key, value) =>
    value instanceof Map ? { __map: [...value.entries()] }
      : value instanceof Set ? { __set: [...value.values()] }
        : value,
  )
}

export function decodeTailState(json: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(json, (_key, raw) =>
      isEncodedMap(raw) ? new Map(raw.__map)
        : isEncodedSet(raw) ? new Set(raw.__set)
          : raw,
    )
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

// ── file fence ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Measure the fence for `path` at byte `offset`. Returns null when the file cannot be read, is shorter
 * than `offset` (truncated/rotated), or `offset` is not a positive byte count — every one of which
 * means the cached prefix is not this file's prefix.
 */
export function measureFence(path: string, offset: number): TailCacheFence | null {
  if (!Number.isSafeInteger(offset) || offset <= 0) return null
  let fd: number | undefined
  try {
    const stat = statSync(path)
    if (stat.size < offset) return null
    fd = openSync(path, "r")
    const window = Math.min(SAMPLE_BYTES, offset)
    const head = Buffer.allocUnsafe(window)
    const headRead = readSync(fd, head, 0, window, 0)
    const tail = Buffer.allocUnsafe(window)
    const tailRead = readSync(fd, tail, 0, window, offset - window)
    if (headRead !== window || tailRead !== window) return null
    const contentDigest = createHash("sha256")
      .update(String(offset))
      .update("\0")
      .update(head)
      .update("\0")
      .update(tail)
      .digest("hex")
      .slice(0, 32)
    return {
      offset,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      ino: String(stat.ino),
      contentDigest,
    }
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // the fd is going away with the process either way
      }
    }
  }
}

/**
 * Is `entry` still a faithful description of the file on disk right now? The inode must be the same
 * file, the file must not have shrunk below the folded prefix, and the folded prefix's content digest
 * must still match. A file that GREW passes — that is the append the tailer is about to consume.
 */
export function fenceMatches(entry: TailCacheFence, current: TailCacheFence): boolean {
  return entry.ino === current.ino &&
    entry.offset === current.offset &&
    current.size >= entry.offset &&
    entry.contentDigest === current.contentDigest
}

// ── the store ──────────────────────────────────────────────────────────────────────────────────────

interface CacheRow {
  slug: string
  session_id: string
  native_session_id: string
  runtime_generation: number
  path: string
  offset_bytes: number
  size_bytes: number
  mtime_ms: number
  ino: string
  content_digest: string
  fold_schema: string
  state: string
}

/** The cache table, idempotent; frizz-db.ts creates it ahead of a legacy import. */
export const TAIL_STATE_TABLES = ["tail_state"] as const
export function ensureTailStateSchema(db: Database): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS tail_state (
        project_id        TEXT NOT NULL,
        slug              TEXT NOT NULL,
        session_id        TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        runtime_generation INTEGER NOT NULL,
        path              TEXT NOT NULL,
        offset_bytes      INTEGER NOT NULL,
        size_bytes        INTEGER NOT NULL,
        mtime_ms          INTEGER NOT NULL,
        ino               TEXT NOT NULL,
        content_digest    TEXT NOT NULL,
        fold_schema       TEXT NOT NULL,
        state             TEXT NOT NULL,
        PRIMARY KEY (project_id, slug)
      );
    `)
}

export function createTailStateCache(scope: ProjectScope, schema = foldSchemaDigest()): TailStateCache {
  const db = scope.db
  let usable = true
  try {
    ensureTailStateSchema(db)
  } catch {
    usable = false
  }

  const selectAll = (): CacheRow[] => scope.prepare<[string], CacheRow>(
    "SELECT * FROM tail_state WHERE project_id = @project_id AND fold_schema = ?",
  ).all(schema)

  const upsert = usable
    ? (() => {
        try {
          return scope.prepare(`
            INSERT INTO tail_state (project_id, slug, session_id, native_session_id, runtime_generation, path,
                                    offset_bytes, size_bytes, mtime_ms, ino, content_digest, fold_schema, state)
            VALUES (@project_id, @slug, @session_id, @native_session_id, @runtime_generation, @path,
                    @offset_bytes, @size_bytes, @mtime_ms, @ino, @content_digest, @fold_schema, @state)
            ON CONFLICT(project_id, slug) DO UPDATE SET
              session_id = excluded.session_id,
              native_session_id = excluded.native_session_id,
              runtime_generation = excluded.runtime_generation,
              path = excluded.path,
              offset_bytes = excluded.offset_bytes,
              size_bytes = excluded.size_bytes,
              mtime_ms = excluded.mtime_ms,
              ino = excluded.ino,
              content_digest = excluded.content_digest,
              fold_schema = excluded.fold_schema,
              state = excluded.state
          `)
        } catch {
          usable = false
          return null
        }
      })()
    : null

  return {
    load() {
      const map = new Map<string, TailCacheEntry>()
      if (!usable) return map
      try {
        for (const row of selectAll()) {
          map.set(row.slug, {
            slug: row.slug,
            sessionId: row.session_id,
            nativeSessionId: row.native_session_id,
            runtimeGeneration: row.runtime_generation,
            path: row.path,
            offset: row.offset_bytes,
            size: row.size_bytes,
            mtimeMs: row.mtime_ms,
            ino: row.ino,
            contentDigest: row.content_digest,
            state: row.state,
          })
        }
      } catch {
        // A corrupt/absent table reads as an empty cache: correct, just slow.
        return new Map()
      }
      return map
    },
    put(entries) {
      if (!usable || !upsert || entries.length === 0) return
      try {
        const write = db.transaction((batch: TailCacheEntry[]) => {
          for (const entry of batch) {
            if (entry.state.length > MAX_STATE_BYTES) continue
            upsert.run({
              slug: entry.slug,
              session_id: entry.sessionId,
              native_session_id: entry.nativeSessionId,
              runtime_generation: entry.runtimeGeneration,
              path: entry.path,
              offset_bytes: entry.offset,
              size_bytes: entry.size,
              mtime_ms: entry.mtimeMs,
              ino: entry.ino,
              content_digest: entry.contentDigest,
              fold_schema: schema,
              state: entry.state,
            })
          }
        })
        write(entries)
      } catch {
        // Best-effort: the next boot just pays the full read again.
      }
    },
    prune(liveSlugs) {
      if (!usable) return
      try {
        const stale: string[] = []
        for (const row of scope.prepare<[], { slug: string; fold_schema: string }>(
          "SELECT slug, fold_schema FROM tail_state WHERE project_id = @project_id",
        ).all()) {
          if (row.fold_schema !== schema || !liveSlugs.has(row.slug)) stale.push(row.slug)
        }
        if (stale.length === 0) return
        const del = scope.prepare("DELETE FROM tail_state WHERE project_id = @project_id AND slug = ?")
        const drop = db.transaction((slugs: string[]) => {
          for (const slug of slugs) del.run(slug)
        })
        drop(stale)
      } catch {
        // A stale row is inert — it can only ever fail its fence.
      }
    },
  }
}
