import { execFileSync } from "node:child_process"
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, rmdirSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"
import { SECRET_TTL_MS } from "@frizz/shared"

/**
 * Where a SECRET answer goes instead of the database — the value the human pasted into a masked card
 * (a `kind: secret` question fence; `frizzctl secret` until 2026-10-13): a one-time code, a token, a password.
 *
 * NOT A FILE. The path the worker is given is a NAMED PIPE (a FIFO, 0600 in a 0700 dir under the
 * project's state dir), and the value lives only in this process's memory. When a reader opens the pipe
 * the value is written into it once — through the kernel, never onto disk — and the pipe is removed. So:
 *
 *   - nothing persists: no plaintext for a backup, a sync client or a later `grep` to find;
 *   - it is SINGLE USE: the first `cat` gets it, and the path is gone after;
 *   - it EXPIRES: an unread value is dropped after SECRET_TTL_MS, and a server start clears every pipe
 *     a previous process left (no writer can stand behind one, so a reader would block forever).
 *
 * The worker's command is unchanged from the plaintext-file version this replaced (2026-10-08): it reads
 * the value inside the command that uses it, `--otp "$(cat '<path>')"`, and the transcript carries only
 * the path.
 *
 * HOW THE WRITE FINDS ITS READER. Node has no blocking-free way to wait for a FIFO's reader, and a
 * blocking open would hold a libuv thread until one came. So a timer tries a NON-BLOCKING write-open
 * every POLL_MS: with no reader it fails with ENXIO and nothing happens; with one it succeeds, the value
 * (far below a pipe's buffer) goes in whole, and the close gives the reader its EOF. So OPENING the path
 * spends the value, read or not — a reader blocks in its open until this writer arrives, and is present
 * for the write — while looking at it (`ls`, `test -p`) does not. A reader gone between the open and the
 * write raises EPIPE, and the value is kept for the next one.
 *
 * WINDOWS HAS NO FIFOs. There the value is a 0600 file, removed at the same TTL and at the next start —
 * the weaker shape, kept so the tool works rather than refusing.
 */

const POLL_MS = 100

interface Served {
  timer: NodeJS.Timeout
  /** When an unread value is dropped. Moved by rearmSecretsIn when the message naming it reaches the worker. */
  expiresAt: number
  now: () => number
  ttlMs: number
}

/** Every pipe this process is serving, by path. The value lives only in the timer's closure. */
const served = new Map<string, Served>()

function secretsRoot(stateDir: string): string {
  return join(stateDir, "secrets")
}

/** The path a secret question's value is served at. Deterministic, so `ask` can name it at registration.
 *  Both segments are frizz-minted (a validated thread slug and a `qst_` id), never worker text. */
export function secretFilePath(stateDir: string, slug: string, questionId: string): string {
  return join(secretsRoot(stateDir), slug, questionId)
}

function stop(path: string): void {
  const entry = served.get(path)
  if (entry) clearInterval(entry.timer)
  served.delete(path)
  rmSync(path, { force: true })
  // The thread's directory goes with its last pipe, so a finished secret leaves no trace at all.
  try {
    rmdirSync(dirname(path))
  } catch {}
}

/** Serve the value at its path — once, from memory — until it is read, the worker removes the path, or
 *  the TTL passes. Returns the path. */
export function serveSecret(
  stateDir: string,
  slug: string,
  questionId: string,
  value: string,
  opts: { now?: () => number; ttlMs?: number; platform?: NodeJS.Platform } = {},
): string {
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? SECRET_TTL_MS
  const root = secretsRoot(stateDir)
  const dir = join(root, slug)
  const path = secretFilePath(stateDir, slug, questionId)
  // Replacing a value this process is still serving: stop the old one BEFORE making the directory, since
  // stopping removes a directory its last pipe leaves empty.
  stop(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdir's mode only applies to directories it CREATES, and the umask narrows it further; a root left
  // by an older build or a hand-made one is tightened here rather than trusted.
  chmodSync(root, 0o700)
  chmodSync(dir, 0o700)

  if ((opts.platform ?? process.platform) === "win32") {
    writeFileSync(path, value, { mode: 0o600 })
    const timer = setInterval(() => {
      if (now() >= entry.expiresAt || !existsSync(path)) stop(path)
    }, 1_000)
    timer.unref()
    const entry: Served = { timer, expiresAt: now() + ttlMs, now, ttlMs }
    served.set(path, entry)
    return path
  }

  execFileSync("mkfifo", ["-m", "600", path])
  const bytes = Buffer.from(value, "utf8")
  const timer = setInterval(() => {
    // The worker removing the path is how it says it is finished with an unread value.
    if (now() >= entry.expiresAt || !existsSync(path)) return stop(path)
    let fd: number
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK)
    } catch {
      return // ENXIO: nobody is reading yet.
    }
    let delivered = false
    try {
      delivered = writeSync(fd, bytes) === bytes.length
    } catch {
      // EPIPE: the reader left before the write. Keep the value for the next one.
    } finally {
      closeSync(fd)
    }
    if (delivered) stop(path)
  }, POLL_MS)
  timer.unref()
  const entry: Served = { timer, expiresAt: now() + ttlMs, now, ttlMs }
  served.set(path, entry)
  return path
}

/** THE CLOCK STARTS WHEN THE WORKER IS HANDED THE PATH. A value is served the moment the human answers,
 *  and the message naming its path can wait before it reaches the worker: a send held by "Send to queue"
 *  until the turn ends, every mid-turn send to a backend with no steer, an answer wake the scheduler holds
 *  in its quiet window. Its 15 minutes ran meanwhile — 6m46s of one on 2026-11-08 — and the worker, told
 *  it had 15, could be handed a path already gone (2026-11-11). Every delivery restarts the clock of each
 *  pipe this process still serves whose path the message carries. Returns how many it restarted. */
export function rearmSecretsIn(text: string): number {
  let rearmed = 0
  for (const [path, entry] of served) {
    if (!text.includes(path)) continue
    entry.expiresAt = entry.now() + entry.ttlMs
    rearmed++
  }
  return rearmed
}

/** Remove everything under the secrets dir — at a server start, where no pipe can have a writer behind
 *  it any more, and where a plaintext file from before the pipes (2026-10-08) must not linger. Pipes
 *  THIS process is serving are left alone, so a second context on the same state dir cannot cut one off. */
export function clearSecrets(stateDir: string): number {
  const root = secretsRoot(stateDir)
  let removed = 0
  let threads: string[]
  try {
    threads = readdirSync(root)
  } catch {
    return 0
  }
  for (const thread of threads) {
    const dir = join(root, thread)
    let entries: string[]
    try {
      if (!lstatSync(dir).isDirectory()) {
        rmSync(dir, { force: true })
        continue
      }
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      if (served.has(path)) continue
      rmSync(path, { force: true })
      removed++
    }
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  return removed
}
