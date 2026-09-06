import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs"
import { dirname, join } from "node:path"

// ---- Read-side transcript DISCOVERY (the fallback for a drifted/missing `<session_id>.jsonl`) ----
//
// The tailer and the transcript renderer bind a thread to `<session_id>.jsonl` — the pinned id. That
// binding is reliable in the normal case (proven: neither compaction nor resume re-ids a session), but
// when the file is ABSENT (a worker that failed to write it) or, hypothetically, MOVED (a `--fork-session`
// re-id, which frizz does not use today), the read side has no recovery and the row strands.
//
// Every frizz worker's transcript CONTENT carries a built-in discovery key: its scratchpad path
// `threads/<pinnedId>/scratch.md`, baked into the first user message (dispatch.ts composePrompt) AND re-injected
// in the per-turn system prompt (scratchpadOrientation), so it survives compaction and would survive a
// fork. The pinnedId there is the ORIGINAL session id regardless of any filename drift. So to find a
// session's real transcript we scan the project log dir for a *.jsonl whose HEAD contains that sentinel;
// newest match wins.
//
// TELEMETRY-GRADE: every fs op is guarded — a discovery miss / unreadable dir / malformed file degrades
// to `undefined` (no match), NEVER throws.

// Only the file HEAD is read: the scratchpad sentinel appears in the FIRST user message (the very top of
// the transcript) and again in the re-injected system prompt near each turn, so the opening chunk is
// sufficient and bounds the per-file cost — critical since a live transcript can be tens of MB.
const HEAD_BYTES = 128 * 1024
// Never consider a transcript older than this — discovery is for a LIVE thread whose file drifted, and
// scanning ancient logs only invites a false match. Generous vs. a real session's activity cadence.
const DISCOVER_FRESH_MS = 24 * 60 * 60_000
// Defensive cap on candidate files inspected per scan (newest-first), so a log dir holding thousands of
// historical sessions can't turn one discovery into thousands of head-reads.
const DISCOVER_MAX_SCAN = 40

// How long after dispatch we tolerate a MISSING/EMPTY `<session_id>.jsonl` before treating it as drift
// and engaging discovery. A healthy worker writes its transcript within ~1s of boot; a slow boot can
// lag. Aligns with the web spin-up window (groups.ts SPIN_UP_MS). Shared by BOTH read-side callers (the
// tailer's per-tick resolve AND the transcript renderer's per-view fallback) so neither pays a
// directory scan for an ordinary just-spawned thread whose file simply isn't written yet.
export const DISCOVERY_GRACE_MS = 60_000

// The content sentinel for a session: its scratch-directory path tail. Embeds the ORIGINAL pinned id, so
// it is stable across filename drift. `/` is not JSON-escaped, so this matches the raw JSONL bytes.
//
// It used to be `threads/<id>/scratch.md`, and the shortening to the directory is FREE rather than a
// migration: the old string CONTAINS this one, so a transcript written before 2026-08-06 still matches.
// Nothing had to be re-indexed and no live thread lost its recovery path.
export function sentinelFor(sessionId: string): string {
  return `threads/${sessionId}/`
}

// Read up to HEAD_BYTES from the top of a file as UTF-8. Any error → "" (caller treats as no-match).
function readHead(path: string): string {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const buf = Buffer.allocUnsafe(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.toString("utf8", 0, n)
  } catch {
    return ""
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // best-effort
      }
    }
  }
}

export interface DiscoverOptions {
  nowMs?: number // injectable clock (tests); defaults to Date.now()
  exclude?: Set<string> // ids to skip (other rows' session_id/transcript_id) so we never steal a claimed transcript
}

// Discover the transcript for `sessionId` by content: the newest *.jsonl in `logDir` (excluding
// `exclude`, and `sessionId` itself — its direct file is why we're here) whose HEAD carries the
// scratchpad sentinel. Returns the matching file's stem (its transcript id), or undefined if none.
// Pure fs + string work; degrades to undefined on any surprise.
export function discoverTranscriptId(logDir: string, sessionId: string, opts: DiscoverOptions = {}): string | undefined {
  const nowMs = opts.nowMs ?? Date.now()
  const exclude = opts.exclude
  const sentinel = sentinelFor(sessionId)
  let names: string[]
  try {
    names = readdirSync(logDir)
  } catch {
    return undefined
  }
  // Gather fresh candidates (id + mtime), newest-first, then head-scan at most DISCOVER_MAX_SCAN of them.
  const cands: { id: string; path: string; mtime: number }[] = []
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".jsonl")) continue
    const id = name.slice(0, -".jsonl".length)
    if (!id || id === sessionId || exclude?.has(id)) continue
    const path = join(logDir, name)
    let mtime: number
    try {
      mtime = statSync(path).mtimeMs
    } catch {
      continue
    }
    if (nowMs - mtime > DISCOVER_FRESH_MS) continue
    cands.push({ id, path, mtime })
  }
  cands.sort((a, b) => b.mtime - a.mtime)
  for (const c of cands.slice(0, DISCOVER_MAX_SCAN)) {
    if (readHead(c.path).includes(sentinel)) return c.id
  }
  return undefined
}

// ---- Read-side transcript discovery ACROSS log dirs (the renamed/moved project directory) ----
//
// Everything above assumes the transcript is SOMEWHERE IN `logDir`. That assumption breaks the moment
// the operator renames or moves the checkout, because Claude Code shards its store by the cwd a session
// was BORN in — `~/.claude/projects/<cwd with every non-alphanumeric character replaced by ->/` — and a resumed session KEEPS
// WRITING TO ITS BIRTH BUCKET FOREVER. Frizz derives that bucket from the project's CURRENT path
// (project.ts cwdSlug), so after a rename every pre-existing thread points at a file that will never
// exist, the crash-net reads it as "no transcript after 60s — likely a boot failure", and the board
// strands the whole history behind a yellow [!] whose Retry can only ever start more work frizz cannot
// see. Measured on this machine 2026-08-11: `.../projects/fray` → `.../projects/frizz` stranded 417
// transcripts and froze five live threads.
//
// Measured, on the real `claude` CLI with throwaway projects (2026-08-11), because the fix depends on
// which of these is true:
//   • create a session in `<p>/alpha`, rename to `<p>/beta`, `--resume` from `beta` → it appends to the
//     `-alpha` bucket; `-beta` never receives a jsonl. Only the per-line `cwd` field follows the move.
//   • `mv` the jsonl into the `-beta` bucket first, THEN `--resume` → it follows the file and appends there.
//   • but `mv` it out from under a LIVE session and that session RE-CREATES the file at the old path,
//     splitting the transcript in two.
// The third reading is why frizz must never migrate Claude Code's files to repair this: the threads that
// need repair most are exactly the ones with a live daemon holding the transcript. So the fix is on the
// READ side — find the bucket that actually holds the file and bind it — and `~/.claude` is never written.
//
// Cost: one `readdirSync` plus one `statSync` per sibling bucket. Measured 0.75ms across 300 buckets on
// the maintainer's machine, and a hit is memoized (see `strandedLogDirs`) so the sweep runs about once.

// Buckets already caught holding a stranded transcript. A rename strands EVERY session of a project at
// once, so the first hit answers the other few hundred without re-sweeping. Shared across projects
// deliberately: a bucket is a cwd, the probe is an exact session-id filename, and session ids are
// unique — so a cross-project entry can only ever be a cheap miss, never a wrong bind.
const strandedLogDirs = new Set<string>()

/** The mtime of `path` if it is a non-empty file, else undefined — the sweep's one and only probe.
 *
 * `throwIfNoEntry: false` rather than a try/catch, because on this path the MISS is the common case and
 * the throw is not free: the sweep below probes one exact filename in every sibling bucket, so all but at
 * most one probe is an ENOENT. On the maintainer's machine (301 buckets) constructing those 300 exceptions
 * was HALF the sweep — 2.49ms per miss against 1.19ms without them, over a 0.33ms readdir. Every unbound
 * row pays a full sweep each retry interval, so it is the multiplier that matters, not the single call.
 * The catch stays for everything else a stat can raise (EACCES, ELOOP), which must still degrade to a miss.
 *
 * Size and mtime come from ONE stat deliberately. The size test is the same emptiness rule the tailer's
 * crash-net uses (a worker that dies before writing a record leaves a permanent 0-byte husk, which must
 * not count as a hit); the mtime is what breaks a two-bucket tie in favour of the file still being
 * appended to. Asking for them separately would double the syscall count of the whole sweep. */
export function mtimeOfNonEmpty(path: string): number | undefined {
  try {
    const st = statSync(path, { throwIfNoEntry: false })
    return st && st.size > 0 ? st.mtimeMs : undefined
  } catch {
    return undefined
  }
}

/**
 * The SIBLING of `logDir` that actually holds a non-empty `<sessionId>.jsonl`, or undefined.
 *
 * Siblings, because Claude Code's buckets all live side by side under `~/.claude/projects/` — one per
 * cwd — so "the same store, a different cwd" is exactly `dirname(logDir)`'s other children. Taking the
 * root from `logDir` rather than from `homedir()` also keeps the whole search injectable through the
 * one seam the tailer and the renderer already have.
 *
 * Deliberately NOT freshness-filtered, unlike `discoverTranscriptId`: a thread stranded by a rename can
 * have been idle for weeks and is exactly what we are here to recover. The probe is an exact filename
 * match on the pinned session id, so — unlike the content-sentinel scan — there is no false-match risk
 * to bound. Telemetry-grade: any fs surprise degrades to undefined, never throws.
 */
export function discoverTranscriptDir(
  logDir: string,
  sessionId: string,
  memo: Set<string> = strandedLogDirs,
): string | undefined {
  const name = `${sessionId}.jsonl`
  // NEWEST WINS, rather than whichever candidate turns up first. One session id CAN legitimately name a
  // file in two buckets: measured against the real CLI (2026-08-11), moving a transcript out from under a
  // LIVE session makes that session RE-CREATE it at the old path, so the same id then exists twice — a
  // small live file and a large stale one. First-hit-wins made the choice `readdirSync` order, i.e.
  // arbitrary, and losing that coin flip renders a truncated conversation. The live file is by definition
  // the one still being appended to, so mtime is the right tiebreak. It also removes the memo's ability to
  // shadow a correct bucket with a stale one, which is how this surfaced: a suite reusing the session id
  // "sid" across cases passed alone and failed in-file, because an earlier case's bucket was memoized.
  // A pure fold rather than a closure mutating an outer `let`: TypeScript does not track writes made
  // inside a callback, so the narrowing after the memo's early return would leave `best` as `never`.
  type Candidate = { dir: string; mtimeMs: number } | undefined
  const better = (best: Candidate, dir: string): Candidate => {
    if (dir === logDir) return best // our own dir already missed; that is why we are here
    const at = mtimeOfNonEmpty(join(dir, name))
    if (at === undefined) return best
    return !best || at > best.mtimeMs ? { dir, mtimeMs: at } : best
  }
  let best: Candidate
  for (const dir of memo) best = better(best, dir)
  if (best) return best.dir // a memo hit answers without paying for the sweep, which is its whole job
  let entries: string[]
  try {
    entries = readdirSync(dirname(logDir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return undefined
  }
  for (const entry of entries) best = better(best, join(dirname(logDir), entry))
  if (!best) return undefined
  memo.add(best.dir)
  return best.dir
}
