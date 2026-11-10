import {
  appendFileSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { frizzPaths } from "./frizz-paths.ts"

// ── Structured logging, shared by every Frizz process ───────────────────────────────────────────────
// Frizz's readout used to be whatever each subsystem happened to console.log, printed straight to a TTY
// that the launcher, the supervisor and the forked control-plane child all wrote to at once. Two
// consequences, both of which the operator saw every launch: the launcher had to abandon its animated
// progress line the moment the child started talking (it cannot clear another process' output), and a
// crash left nothing behind to read afterwards.
//
// So every record now goes through here. The DISK sink is unconditional and is the complete feed; the
// terminal is a deliberately thin view onto it. `--debug` widens the terminal view back to everything.
//
// Processes share one log FILE, not one writer: each opens it O_APPEND and writes whole lines. POSIX
// guarantees an O_APPEND write smaller than PIPE_BUF lands atomically at the end, so the child and its
// supervisor interleave records without a lock or an IPC hop, and a child that dies mid-write cannot
// truncate what the supervisor already wrote.

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LogRecord {
  at: number
  level: LogLevel
  /** The subsystem speaking: "launcher", "supervisor", "server", "tailer", … */
  scope: string
  message: string
}

/** Env carried into forked children so they append to the same file at the same verbosity. */
export const LOG_FILE_ENV = "FRIZZ_LOG_FILE"
export const LOG_LEVEL_ENV = "FRIZZ_LOG_LEVEL"
/** Operator override, accepting either a directory or an exact `.log` path (wrangler's convention). */
export const LOG_PATH_ENV = "FRIZZ_LOG_PATH"

/** Both bounds apply: 20 runs is nothing to someone who restarts constantly, 14 days nothing to someone who runs it twice. */
const RETAINED_RUNS = 20
const RETAINED_DAYS = 14
/** Frizz's debug feed is chatty; a wedged subsystem must not be able to fill the disk. */
const MAX_LOG_BYTES = 32 * 1024 * 1024

export function defaultLogRoot(stateDir?: string, home = homedir()): string {
  // Per PROJECT, because Frizz serves one board per repository and a merged machine-wide log would
  // interleave unrelated boards. Logs live beside the rest of a project's bookkeeping rather than
  // under a second convention imported for this one subsystem.
  //
  // The fallback root is the STATE root (`frizz-paths.ts`), which is `~/.frizz` on every install that
  // has one and the platform's own location on a new machine. This comment used to say frizz keeps one
  // dotdir on every platform and deliberately ignores XDG; that is no longer true, and the resolver
  // is now the single place that decides.
  return stateDir ? join(stateDir, "logs") : join(frizzPaths({ home }).state, "logs")
}

function runStamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  )
}

/**
 * The path for THIS run. One file per launch, so "the server just died, here is its log" is an exact
 * path rather than a directory to go rummaging in.
 *
 * `FRIZZ_LOG_PATH` overrides the location and takes either a directory (a run file is named inside it)
 * or an exact `.log` path, which is what makes CI capture and `--debug > file` painless.
 */
export function runLogPath(
  stateDir?: string,
  at = new Date(),
  pid = process.pid,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name = `frizz-${runStamp(at)}-${pid}.log`
  const override = env[LOG_PATH_ENV]?.trim()
  if (override) return override.endsWith(".log") ? override : join(override, name)
  return join(defaultLogRoot(stateDir, home), name)
}

/** The stable path a crash message can name without knowing which run produced it. */
export function latestLogPath(dir: string): string {
  return join(dir, "latest.log")
}

/**
 * Point `latest.log` at this run. A symlink where the platform allows one; otherwise a plain file
 * holding the real path, which still gives a reader one place to look.
 */
function linkLatest(dir: string, target: string): void {
  const link = latestLogPath(dir)
  try {
    rmSync(link, { force: true })
    symlinkSync(target, link)
  } catch {
    try {
      writeFileSync(link, `${target}\n`, { mode: 0o600 })
    } catch {
      // Purely a convenience pointer; the run path is reported directly regardless.
    }
  }
}

/**
 * Drop run logs beyond `keep`, and any older than `days` regardless of count.
 * Best-effort throughout: retention must never fail a launch.
 */
export function pruneRunLogs(dir: string, keep = RETAINED_RUNS, days = RETAINED_DAYS, now = Date.now()): void {
  let entries: string[]
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".log") && name !== "latest.log")
  } catch {
    return
  }
  const dated = entries
    .map((name) => {
      try {
        return { name, at: statSync(join(dir, name)).mtimeMs }
      } catch {
        return { name, at: 0 }
      }
    })
    .sort((a, b) => b.at - a.at)
  const cutoff = now - days * 24 * 60 * 60 * 1_000
  const stale = dated.filter((entry, index) => index >= keep || entry.at < cutoff)
  for (const entry of stale) {
    try {
      rmSync(join(dir, entry.name), { force: true })
    } catch {
      // A log we cannot delete is inert; it simply ages out on a later launch.
    }
  }
}

// A LINE CARRIES A CLOCK AND NO DATE, AND ONE FILE COVERS A LAUNCHER'S WHOLE RUN, which is days: a log
// on the maintainer's machine ran 11,878 lines over nine days and wrapped midnight nine times with
// nothing to say so, and "what day was this" is the first thing anyone reading someone else's log asks.
// So each process writes the local date on a line of its own before its first record, and again before
// the first record of every later day. A line of its own rather than a date in every record: the
// terminal feed prints these same lines (formatFeedLine), where a date on each would be noise, and the
// launcher and the server it runs are released apart, so a new column would misalign the file for as
// long as one of them is the older build. Each process marks its own days, so a file carries one line
// per process per day, and a server's first line after a restart or an update always has its date.
const DAY_LINE = /^--- \d{4}-\d\d-\d\d ---$/u

/** Whether a line of a run log is one of its date lines rather than a record. */
export function isLogDayLine(line: string): boolean {
  return DAY_LINE.test(line)
}

function localDay(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatDiskLine(record: LogRecord): string {
  const at = new Date(record.at)
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  const clock =
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`
  // Fixed-width level and scope so the message column lines up when you open the file. This is read by
  // a human after a crash far more often than it is parsed, so favour the eye.
  return `${clock}  ${record.level.toUpperCase().padEnd(5)}  ${record.scope.padEnd(12)}  ${record.message}\n`
}

export interface Logger {
  debug(scope: string, message: string): void
  info(scope: string, message: string): void
  warn(scope: string, message: string): void
  error(scope: string, message: string): void
  /** Where the complete feed is being written, or null when disk logging is unavailable. */
  file: string | null
  /** Terminal records are handed here instead of being printed, so a readout can own the TTY. */
  onRecord(listener: (record: LogRecord) => void): () => void
  close(): void
}

export interface LoggerOptions {
  /**
   * Absolute path of the run log. Omit to derive one from `stateDir`; pass `null` for a logger that
   * keeps nothing on disk and only feeds its listeners.
   */
  file?: string | null
  stateDir?: string
  /** Records below this level are dropped everywhere, including on disk. */
  level?: LogLevel
  /** Stop writing past this many bytes rather than filling the disk. */
  maxBytes?: number
  /**
   * Whether this process owns the log directory. The owner sweeps retention and repoints
   * `latest.log`; a forked child that adopted its parent's path must do neither. Defaults to true.
   */
  owner?: boolean
  /** Test seam. */
  now?: () => number
}

function openLogFile(path: string): number | null {
  try {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 })
    // O_APPEND: every write is positioned at the current end of file by the kernel, so concurrent
    // processes cannot overwrite each other even without any coordination between them.
    return openSync(path, "a", 0o600)
  } catch {
    // A launch must never fail because logging could not be set up. Degrade to terminal-only.
    return null
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const path = options.file === null ? null : options.file ?? runLogPath(options.stateDir)
  const level = options.level ?? "debug"
  const now = options.now ?? Date.now
  const threshold = LEVEL_ORDER[level]
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES
  let fd = path === null ? null : openLogFile(path)
  // Only the process that OWNS this run's directory sweeps retention and repoints `latest`. A forked
  // child adopts its parent's path from the environment and must not prune its parent's history.
  if (fd !== null && path !== null && options.owner !== false) {
    const dir = join(path, "..")
    pruneRunLogs(dir)
    linkLatest(dir, path)
  }
  let written = 0
  /** The local day this process last dated the file with. See A LINE CARRIES A CLOCK AND NO DATE. */
  let day: string | undefined
  const listeners = new Set<(record: LogRecord) => void>()

  const emit = (recordLevel: LogLevel, scope: string, message: string) => {
    if (LEVEL_ORDER[recordLevel] < threshold) return
    const record: LogRecord = { at: now(), level: recordLevel, scope, message }
    if (fd !== null) {
      try {
        const today = localDay(record.at)
        // One write, so another process's record cannot land between the date and the record it dates.
        const line = `${today === day ? "" : `--- ${today} ---\n`}${formatDiskLine(record)}`
        if (written + line.length > maxBytes) {
          // Stop rather than grow without bound; a wedged subsystem can emit forever.
          writeSync(fd, `--- log truncated at ${maxBytes} bytes ---\n`)
          fd = null
        } else {
          writeSync(fd, line)
          written += line.length
          day = today
        }
      } catch {
        // The descriptor went away (disk full, directory removed). Stop trying; keep the process alive.
        fd = null
      }
    }
    for (const listener of listeners) {
      try {
        listener(record)
      } catch {
        // A broken presenter must not take down the subsystem that logged.
      }
    }
  }

  return {
    debug: (scope, message) => emit("debug", scope, message),
    info: (scope, message) => emit("info", scope, message),
    warn: (scope, message) => emit("warn", scope, message),
    error: (scope, message) => emit("error", scope, message),
    get file() {
      return fd === null ? null : path
    },
    onRecord(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      listeners.clear()
      fd = null
    },
  }
}

// ── The process-wide logger ────────────────────────────────────────────────────────────────────────
// Subsystems (the tailer, the scheduler, the codex backend) are deep in the call graph and have no
// route to a logger handed down from the launcher. They call `log.*` and it resolves the ambient one.
//
// A forked child has no launcher to configure it, so it adopts the file its parent named in the
// environment. That is the whole mechanism by which the control-plane child's records reach the same
// file as the supervisor's, with no IPC and no pipe.

let ambient: Logger | null = null

export function setAmbientLogger(logger: Logger): Logger {
  ambient = logger
  return logger
}

/**
 * Format one record for a terminal that is showing the full feed.
 *
 * LOCAL time, matching the disk format exactly. It used to be `toISOString()` (UTC), so the terminal
 * and the log file it mirrors disagreed by the operator's whole offset — the two things you compare
 * first when something goes wrong.
 */
export function formatFeedLine(record: LogRecord): string {
  return formatDiskLine(record).trimEnd()
}

/**
 * Mirror this logger's records to stderr — the `--debug` view.
 *
 * `enabled` defaults to the FRIZZ_DEBUG the launcher puts in every child's environment, so a forked
 * process opts in without being passed `--debug` on a command line it never sees. The launchers
 * install this explicitly; without it their own `setAmbientLogger` call bypassed the environment
 * check and `--debug` showed the parent's records but silently dropped the control plane's.
 */
export function attachTerminalMirror(
  logger: Logger,
  enabled = process.env.FRIZZ_DEBUG === "1",
): () => void {
  if (!enabled) return () => {}
  return logger.onRecord((record) => process.stderr.write(`${formatFeedLine(record)}\n`))
}

export function ambientLogger(): Logger {
  if (ambient) return ambient
  const inherited = process.env[LOG_FILE_ENV] ?? process.env[LOG_PATH_ENV]
  const level = process.env[LOG_LEVEL_ENV] as LogLevel | undefined
  // A process that was never TOLD where to log does not invent a file. Both launchers call
  // `setAmbientLogger` with an explicit path, and they pass it to every child through the
  // environment — so a run is always captured, while merely importing this module (a unit test, a
  // script) writes nothing. Without this, `pnpm test` scattered a file per test process into
  // ~/.frizz/logs and pruned the operator's real history along the way.
  const logger = createLogger({
    ...(inherited ? { file: inherited, owner: false } : { file: null }),
    ...(level && level in LEVEL_ORDER ? { level } : {}),
  })
  // The whole reason the launcher can repaint is that this process says NOTHING to the shared
  // terminal by default — its records reach the operator through the run log. `--debug` sets
  // FRIZZ_DEBUG in the child environment and opens the tap back up.
  attachTerminalMirror(logger)
  ambient = logger
  return ambient
}

/** Environment additions that make a forked child log into this run's file. */
export function logEnvironment(logger: Logger, level: LogLevel = "debug"): NodeJS.ProcessEnv {
  return logger.file ? { [LOG_FILE_ENV]: logger.file, [LOG_LEVEL_ENV]: level } : {}
}

export const log = {
  debug: (scope: string, message: string) => ambientLogger().debug(scope, message),
  info: (scope: string, message: string) => ambientLogger().info(scope, message),
  warn: (scope: string, message: string) => ambientLogger().warn(scope, message),
  error: (scope: string, message: string) => ambientLogger().error(scope, message),
}

/**
 * An error as one log line: its message and the frame that threw. For a fault met while reading someone's
 * data (a transcript record), where the line must name the fault and carry nothing of what was read.
 */
export function faultSummary(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, 200)
  const frame = error.stack?.split("\n")[1]?.trim()
  return `${error.message.slice(0, 200)}${frame ? ` (${frame.slice(0, 160)})` : ""}`
}

/**
 * Collect everything logged while `body` runs, writing nothing to disk.
 *
 * These diagnostics used to be `console.error` calls, and the tests that guard them captured the
 * console. They travel through the logger now, so this is how a test asserts "the degradation is
 * announced, not silent" against the channel that actually carries it.
 */
export function captureLogRecords(): { records: LogRecord[]; messages: () => string[]; restore: () => void } {
  const previous = ambient
  const records: LogRecord[] = []
  const capture = createLogger({ file: null })
  capture.onRecord((record) => records.push(record))
  ambient = capture
  return {
    records,
    messages: () => records.map((record) => record.message),
    restore: () => {
      capture.close()
      ambient = previous
    },
  }
}

/**
 * Append one already-formatted line to a run log without owning a logger.
 *
 * The crash path uses this: by the time an uncaught exception reaches the top level the logger may be
 * closed, so the handler reopens, writes and closes rather than trusting shared state.
 */
export function appendCrashRecord(path: string, message: string): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 })
    // Dated every time: nothing here knows what the file's last date line says, and a crash is the
    // record somebody goes looking for a day later.
    const at = Date.now()
    appendFileSync(path, `--- ${localDay(at)} ---\n${formatDiskLine({ at, level: "error", scope: "crash", message })}`, {
      mode: 0o600,
    })
  } catch {
    // Nothing useful remains to be done if even the crash record cannot be written.
  }
}
