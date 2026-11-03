// COMMAND WATCHES — a worker's wait on an outside condition, checked by the SERVER (2026-10-11).
//
// `frizzctl watch-command add --command "npm view frizz@0.13.12 version" --every 5m --for 6h` stores a
// row (storage.ts `command_watch`); scheduler SOURCE 13 re-runs the command on that cadence until it
// exits 0, then settles the row and wakes the thread once with the command and the tail of its output.
// This module is everything about RUNNING one: the process, the gates that decide whether Frizz may run
// it at all, and the server-wide bound on how many run at once.
//
// WHY THE SERVER RUNS IT. The alternative a worker had was a polling loop in a background shell, and a
// background shell pins the thread's whole daemon tree: hibernation refuses any thread holding one
// (thread-hibernation.ts, `background-shells`), because tearing the CLI down kills it. On 2026-10-11 three
// threads idle 1h47m to 21h were pinned ~750 MB that way, re-running a check. Moved here, the wait holds
// nothing in the thread's process tree, so a thread resting on it hibernates like any other rest and is
// cold-resumed by the wake.
//
// WHY IT IS GATED, and why the gate is the whole security story. A command the worker runs itself goes
// through Claude Code's permission system and, where it is on, its sandbox. A command watch does not:
// the SERVER runs it, unsandboxed, with no prompt. And `frizzctl` is pre-approved (`Bash(frizzctl:*)`),
// so even a default-permission thread can register one without a prompt — the registration is a way to
// run an arbitrary command outside every check the thread is under. So Frizz runs one only for a thread
// that is under no check anyway: a Claude thread in `bypassPermissions` mode with Claude Code's sandbox
// off. Everything else is REFUSED, and every refusal names the background shell the worker should use
// instead. It fails CLOSED: a settings file Frizz cannot read or parse refuses, exactly as an enabled
// sandbox does. The same gate is asked again before EVERY run, so a thread whose mode changes after it
// registered stops getting its commands run (the scheduler cancels the watch and tells it why).
//
// CODEX AND ACP ARE REFUSED, not gated. A codex thread's "permission" is a sandbox level on a shared
// app-server, and Frizz has no reading of whether a given command would have run inside it; an ACP agent
// has no such reading at all. Neither can hibernate either (hibernation is Claude-only), so the memory
// the watch exists to free is not there to free. Refusing is the sound answer until one of those changes.
import { execFileSync, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { COMMAND_WATCH_FALLBACK, COMMAND_WATCH_OUTPUT_MAX_BYTES, COMMAND_WATCH_RUN_TIMEOUT_MS, MONITOR_BATCH_MS, MONITOR_EVENT_MAX_LINES, MONITOR_LINE_MAX_CHARS, MONITOR_SERVER_MAX_RUNNING, type MonitorStatus } from "@frizz/shared"
import type { CommandWatchRow, SessionRow } from "./storage.ts"

/** How a check ended. `exit` is the only outcome with an exit status; exit 0 is the only pass. */
export interface CommandRunResult {
  outcome: "exit" | "timeout" | "signal" | "error"
  exitCode: number | null
  /** The TAIL of stdout and stderr, interleaved as they arrived, at most COMMAND_WATCH_OUTPUT_MAX_BYTES. */
  output: string
  /** Epoch ms the run started and finished. The next check is due `every` after `finishedAtMs`. */
  startedAtMs: number
  finishedAtMs: number
}

export interface CommandRunSpec {
  command: string
  cwd: string
  env: Record<string, string | undefined>
  timeoutMs?: number
  /** Aborting kills the run's whole process group — a watch dropped mid-run, or the server stopping. */
  signal?: AbortSignal
}

/** The seam the scheduler and the router run commands through; tests inject a fake. */
export type CommandRunner = (spec: CommandRunSpec) => Promise<CommandRunResult>

/** How long a run's process group gets between SIGTERM and SIGKILL once its time is up. */
const KILL_GRACE_MS = 2_000
/** After the shell itself exits, how long its stdio may stay open before it is cut. A background child
 *  the command left behind holds the pipes; the group is SIGKILLed first, so this only bounds a process
 *  that escaped the group (`setsid`) and still has the pipe. */
const DRAIN_AFTER_EXIT_MS = 1_000

/** Kill a whole process group. `-pid` addresses the group the run was made leader of (`detached`). */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch {
    // ESRCH: the group is already gone, which is the outcome wanted.
  }
}

/** The last `max` bytes of `chunks`, decoded without splitting a UTF-8 sequence, marked when cut. */
export function outputTail(chunks: readonly Buffer[], max = COMMAND_WATCH_OUTPUT_MAX_BYTES): string {
  const all = Buffer.concat(chunks)
  if (all.length <= max) return all.toString("utf8")
  let start = all.length - max
  // Skip continuation bytes (10xxxxxx) so the tail starts on a character boundary.
  while (start < all.length && (all[start]! & 0xc0) === 0x80) start++
  return `…${all.subarray(start).toString("utf8")}`
}

/**
 * Run one check: `/bin/sh -c <command>` in `cwd`, never a login shell, stdin closed.
 *
 * DETACHED, so the shell leads its own process group and has no controlling terminal: a timeout or an
 * abort kills the GROUP, which takes every process the command started with it — a `curl` the shell is
 * waiting on, a pipeline's other half. The group is killed again once the shell exits, which reaps a
 * background child the command left running (`sleep 999 &`); a check is a question, and nothing it
 * starts may outlive the answer.
 *
 * Never throws: a command that cannot even start is an `error` outcome with the reason as its output.
 */
export function runWatchCommand(spec: CommandRunSpec): Promise<CommandRunResult> {
  const startedAtMs = Date.now()
  const timeoutMs = spec.timeoutMs ?? COMMAND_WATCH_RUN_TIMEOUT_MS
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let held = 0
    const keep = (chunk: Buffer) => {
      chunks.push(chunk)
      held += chunk.length
      // Bounded: a command that prints a gigabyte costs this process a few KB.
      while (held - chunks[0]!.length >= COMMAND_WATCH_OUTPUT_MAX_BYTES && chunks.length > 1) held -= chunks.shift()!.length
    }
    let settled = false
    let timedOut = false
    let aborted = false
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
    const timers: NodeJS.Timeout[] = []
    const finish = (result: Omit<CommandRunResult, "startedAtMs" | "finishedAtMs" | "output">, extra?: string) => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      spec.signal?.removeEventListener("abort", onAbort)
      const output = outputTail(extra ? [...chunks, Buffer.from(extra)] : chunks)
      resolve({ ...result, output, startedAtMs, finishedAtMs: Date.now() })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn("/bin/sh", ["-c", spec.command], {
        cwd: spec.cwd,
        env: spec.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
      })
    } catch (err) {
      finish({ outcome: "error", exitCode: null }, `could not start /bin/sh: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    const onAbort = () => {
      aborted = true
      killGroup(child.pid, "SIGKILL")
    }
    if (spec.signal?.aborted) onAbort()
    else spec.signal?.addEventListener("abort", onAbort, { once: true })
    child.stdout?.on("data", keep)
    child.stderr?.on("data", keep)
    child.on("error", (err) => {
      finish({ outcome: "error", exitCode: null }, `could not start /bin/sh: ${err.message}`)
    })
    timers.push(setTimeout(() => {
      timedOut = true
      killGroup(child.pid, "SIGTERM")
      timers.push(setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS))
    }, timeoutMs))
    const conclude = () => {
      if (!exit) return
      if (timedOut) finish({ outcome: "timeout", exitCode: null })
      else if (aborted || exit.signal) finish({ outcome: "signal", exitCode: null })
      else finish({ outcome: "exit", exitCode: exit.code })
    }
    child.on("exit", (code, signal) => {
      exit = { code, signal }
      // Reap whatever the command left in its group, then let the pipes drain.
      killGroup(child.pid, "SIGKILL")
      timers.push(setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        conclude()
      }, DRAIN_AFTER_EXIT_MS))
    })
    child.on("close", conclude)
  })
}

/** A slot allocator, the scheduler's `concurrencyGate` again (kept here so this module has no import of
 *  the scheduler). A released slot is handed straight to the next waiter. */
export function createRunLimiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < limit) active++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await fn()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

/** How many command-watch checks the whole SERVER runs at once. One process serves every project, and
 *  every project's scheduler shares this one bound (module scope, not per context), so twelve projects
 *  with a watch each are still four processes at a time, not twelve. A check that has to wait for a slot
 *  is late by seconds, which no cadence of a minute or more can notice. */
export const COMMAND_WATCH_SERVER_CONCURRENCY = 4
const serverRunLimiter = createRunLimiter(COMMAND_WATCH_SERVER_CONCURRENCY)

/** The registration's first check gets a shorter leash than a scheduled one: it runs INSIDE the
 *  worker's `frizzctl` call, whose RPC gives up at 30s. A first check that has not answered by then is
 *  not refused — the watch is armed and the scheduler runs it with the full timeout. */
export const COMMAND_WATCH_PROBE_TIMEOUT_MS = 15_000
/** And registrations do not queue behind each other: two first checks at once, and a third registration
 *  arms without one rather than waiting. */
const PROBE_CONCURRENCY = 2

// ---- THE SANDBOX GATE ----------------------------------------------------------------------------

/** Where Claude Code reads a MANAGED settings file, highest precedence of all. Both are checked on every
 *  platform: a file that does not exist costs one ENOENT. */
export const CLAUDE_MANAGED_SETTINGS_PATHS = [
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/etc/claude-code/managed-settings.json",
]

export interface ClaudeSettingsLocations {
  /** The thread's working directory — the project root, whose `.claude/` holds the project and local
   *  settings. */
  cwd: string
  env?: NodeJS.ProcessEnv
  home?: string
  managedPaths?: readonly string[]
  /** The MDM-delivered preference files to read (claudeManagedPreferencePaths). Tests pass their own. */
  managedPreferencePaths?: readonly string[]
  /** A preference file as JSON — `plutil`, as Claude Code reads it. Tests inject one. */
  readPlistJson?: (path: string) => string
}

/** Where Claude Code reads settings a CONFIGURATION PROFILE delivers on macOS: the
 *  `com.anthropic.claudecode` managed preferences, per user and per device. Claude Code 2.1.296 converts
 *  each one with `plutil -convert json` and reads the result as a settings object (read from its own
 *  code, 2026-10-11), so a sandbox an organization turns on through MDM lives here and in no JSON file. */
export function claudeManagedPreferencePaths(): string[] {
  let user = ""
  try { user = userInfo().username } catch {}
  return [
    ...(user ? [`/Library/Managed Preferences/${user}/com.anthropic.claudecode.plist`] : []),
    "/Library/Managed Preferences/com.anthropic.claudecode.plist",
  ]
}

function plistAsJson(path: string): string {
  return execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", path], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] })
}

/** What one settings document says about the sandbox: the refusal when it turns it on, or when it cannot
 *  be read as JSON at all; undefined when it leaves it off. */
function sandboxInSettings(raw: string, file: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return `\`${file}\` is not valid JSON, so Frizz cannot tell whether it turns Claude Code's sandbox on for this thread`
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const sandbox = (parsed as Record<string, unknown>).sandbox
  if (sandbox === undefined || sandbox === null || sandbox === false) return undefined
  // `sandbox: { enabled: false }` and a sandbox block with no `enabled` are both off (Claude Code's
  // default). Anything else — `enabled: true`, a non-boolean, `sandbox: true` — is read as on.
  if (typeof sandbox === "object" && !Array.isArray(sandbox)) {
    const enabled = (sandbox as Record<string, unknown>).enabled
    if (enabled === undefined || enabled === false) return undefined
  }
  return `Claude Code's sandbox is on for this thread (\`sandbox\` in \`${file}\`), and a command watch would run your command outside it`
}

/** Every settings file that can turn Claude Code's sandbox on for a thread in `cwd`: managed, local,
 *  project, user — the four scopes a Frizz worker loads (`settingSources: ["user","project","local"]`,
 *  plus the managed file Claude Code always reads). */
export function claudeSettingsFiles(where: ClaudeSettingsLocations): string[] {
  const env = where.env ?? process.env
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() ? env.CLAUDE_CONFIG_DIR.trim() : join(where.home ?? homedir(), ".claude")
  return [
    ...(where.managedPaths ?? CLAUDE_MANAGED_SETTINGS_PATHS),
    join(where.cwd, ".claude", "settings.local.json"),
    join(where.cwd, ".claude", "settings.json"),
    join(configDir, "settings.json"),
  ]
}

/**
 * Why Claude Code's sandbox may be on for this thread, or undefined when no settings file turns it on.
 *
 * ANY SCOPE THAT ENABLES IT REFUSES, even where a higher scope turns it back off. The effective value is
 * Claude Code's to compute, from files that can change under a running session; the cost of reading it
 * wrong in the permissive direction is a command run outside a sandbox the operator asked for, and the
 * cost the other way is a worker using a background shell. A file Frizz cannot read or parse refuses too
 * — it might be the one that says `enabled: true`. The macOS managed preferences (an MDM profile) are
 * read the same way after the JSON files, through `plutil` as Claude Code reads them.
 */
export function claudeSandboxRefusal(where: ClaudeSettingsLocations): string | undefined {
  for (const file of claudeSettingsFiles(where)) {
    let raw: string
    try {
      raw = readFileSync(file, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT" || (err as NodeJS.ErrnoException)?.code === "ENOTDIR") continue
      return `Frizz could not read \`${file}\` to check whether Claude Code's sandbox is on for this thread`
    }
    const refusal = sandboxInSettings(raw, file)
    if (refusal) return refusal
  }
  // The managed preferences are read only where they exist, and only on macOS: elsewhere there are none.
  const preferences = where.managedPreferencePaths ?? (process.platform === "darwin" ? claudeManagedPreferencePaths() : [])
  for (const file of preferences) {
    if (!existsSync(file)) continue
    let raw: string
    try {
      raw = (where.readPlistJson ?? plistAsJson)(file)
    } catch {
      return `Frizz could not read \`${file}\` to check whether Claude Code's sandbox is on for this thread`
    }
    const refusal = sandboxInSettings(raw, file)
    if (refusal) return refusal
  }
  return undefined
}

// ---- THE GATE -----------------------------------------------------------------------------------

export interface CommandWatchGateOptions {
  /** The thread's working directory (the project root). */
  cwd: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  managedPaths?: readonly string[]
  managedPreferencePaths?: readonly string[]
  readPlistJson?: (path: string) => string
}

/**
 * Why Frizz may NOT run a command watch's command for this thread, or undefined when it may.
 * The text completes "Frizz will not run a command watch for this thread: …", and ends in the fallback.
 */
export function commandWatchRefusal(
  row: Pick<SessionRow, "backend" | "permission_mode" | "permission_pending">,
  opts: CommandWatchGateOptions,
): string | undefined {
  const refuse = (reason: string) => `${reason}. ${COMMAND_WATCH_FALLBACK}`
  if ((opts.platform ?? process.platform) === "win32") {
    return refuse("command watches run under `/bin/sh`, which this machine does not have")
  }
  const backend = row.backend ?? "claude"
  if (backend !== "claude") {
    return refuse(
      `command watches are for Claude threads only, and this one runs on ${backend === "codex" ? "Codex" : "an ACP agent"}: ` +
        "Frizz cannot tell whether your thread's own sandbox would have let the command run",
    )
  }
  if (row.permission_mode !== "bypassPermissions") {
    return refuse(
      `this thread runs in \`${row.permission_mode ?? "an unrecorded"}\` permission mode, and the server runs a ` +
        "watched command with no permission check at all — so Frizz runs one only for a thread in " +
        "`bypassPermissions` mode",
    )
  }
  if (row.permission_pending && row.permission_pending !== "bypassPermissions") {
    return refuse(`this thread's permission mode is being changed to \`${row.permission_pending}\``)
  }
  const sandbox = claudeSandboxRefusal({ cwd: opts.cwd, env: opts.env, home: opts.home, managedPaths: opts.managedPaths, managedPreferencePaths: opts.managedPreferencePaths, readPlistJson: opts.readPlistJson })
  if (sandbox) return refuse(sandbox)
  return undefined
}

// ---- MONITORS: ONE SCRIPT, MANY WAKES (2026-11-02) --------------------------------------------------
// `frizzctl monitor`. Where a check above is a question asked on a cadence, a monitor is a script the
// server STARTS ONCE and keeps running for as long as it is armed; every line it prints on stdout is an
// event the scheduler turns into a wake (SOURCE 13, scheduler.ts). Same shell, same gate, same group-kill
// discipline as a check — and the same reason to exist: run here, the script holds nothing of the
// thread's, so the thread can hibernate while it rests on it.

/** One event: the lines a monitor printed within MONITOR_BATCH_MS of each other, and how many more the
 *  same burst printed past MONITOR_EVENT_MAX_LINES. Blank lines are not events and are not counted. */
export interface MonitorEvent {
  lines: string[]
  more: number
}

export interface MonitorProcessSpec {
  command: string
  cwd: string
  env: Record<string, string | undefined>
  onEvent: (event: MonitorEvent) => void
  /** Tests only: a shorter batch window than MONITOR_BATCH_MS. */
  batchMs?: number
}

export interface MonitorProcess {
  /** The pid of `/bin/sh`, which LEADS the script's process group (`detached`). */
  pid: number | undefined
  /** Kill the whole group: SIGTERM, then SIGKILL after a grace. `done` still resolves, as `signal`. */
  stop(): void
  /** Resolves once the script has ended and every line it printed has been handed to `onEvent`: how it
   *  ended, and the tail of stdout and stderr together (stderr is never an event, but it is how a script
   *  says why it died). Never rejects. */
  done: Promise<CommandRunResult>
}

/**
 * Start one monitor: `/bin/sh -c <command>` in `cwd`, stdin closed, leading its own process group.
 *
 * LINES ARE BATCHED, NOT DEBOUNCED: the first line of a burst opens a MONITOR_BATCH_MS window and the
 * window's end flushes whatever arrived in it, so a steady stream still reaches `onEvent` every window
 * instead of never. A line longer than MONITOR_LINE_MAX_CHARS is cut, and the rest of it dropped up to its
 * newline, so a script that never prints a newline cannot grow this process without bound.
 */
export function startMonitorProcess(spec: MonitorProcessSpec): MonitorProcess {
  const startedAtMs = Date.now()
  const batchMs = spec.batchMs ?? MONITOR_BATCH_MS
  const tail: Buffer[] = []
  let tailHeld = 0
  const keepTail = (chunk: Buffer) => {
    tail.push(chunk)
    tailHeld += chunk.length
    while (tailHeld - tail[0]!.length >= COMMAND_WATCH_OUTPUT_MAX_BYTES && tail.length > 1) tailHeld -= tail.shift()!.length
  }

  let batch: string[] = []
  let more = 0
  let batchTimer: NodeJS.Timeout | null = null
  const flush = () => {
    if (batchTimer) clearTimeout(batchTimer)
    batchTimer = null
    if (batch.length === 0 && more === 0) return
    const event = { lines: batch, more }
    batch = []
    more = 0
    try {
      spec.onEvent(event)
    } catch {
      // The scheduler's handler records and enqueues; a fault there must not take the reader down with it.
    }
  }
  const pushLine = (raw: string) => {
    const line = raw.replace(/\r$/, "")
    if (!line.trim()) return
    if (batch.length < MONITOR_EVENT_MAX_LINES) {
      batch.push(line.length > MONITOR_LINE_MAX_CHARS ? `${line.slice(0, MONITOR_LINE_MAX_CHARS)}…` : line)
    } else {
      more++
    }
    if (!batchTimer) batchTimer = setTimeout(flush, batchMs)
  }
  const decoder = new StringDecoder("utf8")
  let partial = ""
  let overlong = false
  const readStdout = (text: string) => {
    let rest = text
    for (;;) {
      const nl = rest.indexOf("\n")
      if (nl === -1) break
      const piece = rest.slice(0, nl)
      rest = rest.slice(nl + 1)
      if (overlong) {
        overlong = false
        pushLine(partial)
      } else {
        pushLine(partial + piece)
      }
      partial = ""
    }
    if (overlong) return
    partial += rest
    if (partial.length > MONITOR_LINE_MAX_CHARS) {
      // Kept one character over the limit so pushLine cuts it and marks the cut; the rest of the line is
      // dropped up to its newline.
      partial = partial.slice(0, MONITOR_LINE_MAX_CHARS + 1)
      overlong = true
    }
  }

  let child: ReturnType<typeof spawn>
  let resolveDone!: (r: CommandRunResult) => void
  const done = new Promise<CommandRunResult>((resolve) => { resolveDone = resolve })
  let settled = false
  let stopping = false
  const timers: NodeJS.Timeout[] = []
  const finish = (outcome: CommandRunResult["outcome"], exitCode: number | null, extra?: string) => {
    if (settled) return
    settled = true
    for (const t of timers) clearTimeout(t)
    // The script's last words: a line it printed without a trailing newline is still a line.
    const last = partial + (overlong ? "" : decoder.end())
    partial = ""
    if (last) pushLine(last)
    flush()
    if (extra) keepTail(Buffer.from(extra))
    resolveDone({ outcome, exitCode, output: outputTail(tail), startedAtMs, finishedAtMs: Date.now() })
  }
  try {
    child = spawn("/bin/sh", ["-c", spec.command], {
      cwd: spec.cwd,
      env: spec.env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    })
  } catch (err) {
    finish("error", null, `could not start /bin/sh: ${err instanceof Error ? err.message : String(err)}`)
    return { pid: undefined, stop: () => {}, done }
  }
  child.stdout?.on("data", (chunk: Buffer) => {
    keepTail(chunk)
    readStdout(decoder.write(chunk))
  })
  child.stderr?.on("data", keepTail)
  child.on("error", (err) => finish("error", null, `could not start /bin/sh: ${err.message}`))
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  const conclude = () => {
    if (!exit) return
    if (stopping || exit.signal) finish("signal", null)
    else finish("exit", exit.code)
  }
  child.on("exit", (code, signal) => {
    exit = { code, signal }
    // Reap whatever the script left in its group, then let the pipes drain — runWatchCommand's rule.
    killGroup(child.pid, "SIGKILL")
    timers.push(setTimeout(() => {
      child.stdout?.destroy()
      child.stderr?.destroy()
      conclude()
    }, DRAIN_AFTER_EXIT_MS))
  })
  child.on("close", conclude)
  return {
    pid: child.pid,
    stop() {
      if (settled || stopping) return
      stopping = true
      killGroup(child.pid, "SIGTERM")
      timers.push(setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS))
    },
    done,
  }
}

/** Monitors running right now, server-wide (every project's scheduler shares this count, as checks share
 *  serverRunLimiter). */
let monitorsRunning = 0

/**
 * A monitor a previous server left running: the server died without killing it (SIGKILL, a crash, the
 * machine sleeping through a restart). Its row still records the group it led and when it started, and
 * the next server must kill it before starting a fresh copy, or the thread is woken twice per line —
 * once by nobody, since the orphan's stdout pipe is gone, but its side effects (a poll every 30s) run on.
 *
 * PID REUSE IS THE RISK, so the group is killed only when the pid STILL leads its own process group AND
 * started within MONITOR_START_TOLERANCE_MS of the instant the row recorded: a recycled pid started later,
 * and almost never leads a group. NOT THE COMMAND LINE, which was the first test and does not survive the
 * shell: `/bin/sh` (bash, on macOS) replaces itself with a script that is one simple command, so a monitor
 * of `node watch.mjs` reads `node watch.mjs` in `ps`, not `/bin/sh -c node watch.mjs` — caught by the
 * suite under load, where the exec won the race against the read. Returns whether it killed anything.
 */
export function reapStaleMonitor(pid: number, startedAtMs: number, readPs: (pid: number) => string | undefined = psLine, nowMs = Date.now()): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || !Number.isFinite(startedAtMs)) return false
  const line = readPs(pid)?.trim()
  if (!line) return false
  const match = /^(\d+)\s+(\S+)$/.exec(line)
  if (!match || Number(match[1]) !== pid) return false
  const elapsed = psElapsedMs(match[2])
  if (elapsed === undefined || Math.abs(nowMs - elapsed - startedAtMs) > MONITOR_START_TOLERANCE_MS) return false
  killGroup(pid, "SIGKILL")
  return true
}

/** How far a process's start, as `ps` reads it (whole seconds), may sit from the instant the row recorded
 *  just after spawning it. */
export const MONITOR_START_TOLERANCE_MS = 5_000

/** `ps`'s `etime` — `[[dd-]hh:]mm:ss` — in milliseconds, or undefined when it is not one. */
export function psElapsedMs(etime: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim())
  if (!match) return undefined
  const [, d = "0", h = "0", m, s] = match
  return (((Number(d) * 24 + Number(h)) * 60 + Number(m)) * 60 + Number(s)) * 1000
}

/** `<pgid> <etime>` for one pid, or undefined when it is gone. */
function psLine(pid: number): string | undefined {
  try {
    return execFileSync("/bin/ps", ["-o", "pgid=,etime=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return undefined
  }
}

/** A monitor row's reading, as its read-back and its board row carry it. */
export function monitorStatusOf(w: Pick<CommandWatchRow, "description" | "events" | "last_event_at" | "last_event">): MonitorStatus {
  return {
    ...(w.description ? { description: w.description } : {}),
    events: w.events,
    ...(w.last_event_at !== null && w.last_event !== null ? { lastEvent: { at: new Date(w.last_event_at).toISOString(), text: w.last_event } } : {}),
  }
}

// ---- THE SERVICE --------------------------------------------------------------------------------

/** What the scheduler and the router need from this module, bound to one project. */
export interface CommandWatchService {
  /** Why Frizz may not run commands for this thread right now (see commandWatchRefusal), or undefined. */
  refusal(row: SessionRow): string | undefined
  /** One scheduled check, through the server-wide bound. */
  run(slug: string, command: string, opts?: { signal?: AbortSignal }): Promise<CommandRunResult>
  /** The registration's first check: short timeout, its own small bound, and `undefined` when no slot is
   *  free right now (the caller arms without one rather than holding the worker's RPC open). */
  probe(slug: string, command: string): Promise<CommandRunResult | undefined>
  /** Start a MONITOR's script for `slug`, or undefined when the server already runs
   *  MONITOR_SERVER_MAX_RUNNING of them. The slot is held until the script's `done` resolves. The three
   *  monitor members are optional so a test fake about checks alone need not stub them: absent, no
   *  monitor is ever started and registration refuses one. */
  startMonitor?(slug: string, command: string, onEvent: (event: MonitorEvent) => void): MonitorProcess | undefined
  /** How many monitors the server runs right now, across every project. */
  monitorsRunning?(): number
  /** Kill a monitor a previous server left running (reapStaleMonitor). */
  reapStaleMonitor?(pid: number, startedAtMs: number): boolean
}

export interface CommandWatchServiceOptions {
  /** The project root: every check runs here, and its `.claude/` is read for the sandbox gate. */
  cwd: string
  /** The environment one check runs with — the server's own (scrubbed of what the server's toolchain
   *  injects), plus the thread's identity so a command can call `frizzctl` itself. */
  env: (slug: string) => Record<string, string | undefined>
  runner?: CommandRunner
  gate?: Omit<CommandWatchGateOptions, "cwd">
  /** Tests only: a private bound instead of the server-wide one. */
  limiter?: <T>(fn: () => Promise<T>) => Promise<T>
  /** Tests only: how a monitor's script is started, and its batch window. */
  startMonitorProcess?: (spec: MonitorProcessSpec) => MonitorProcess
  monitorBatchMs?: number
  /** Tests only: the stale-group check (reapStaleMonitor's `ps` read). */
  readPs?: (pid: number) => string | undefined
}

export function createCommandWatchService(opts: CommandWatchServiceOptions): CommandWatchService {
  const runner = opts.runner ?? runWatchCommand
  const limiter = opts.limiter ?? serverRunLimiter
  let probesActive = 0
  return {
    refusal: (row) => commandWatchRefusal(row, { cwd: opts.cwd, ...opts.gate }),
    run: (slug, command, runOpts) =>
      limiter(() => runner({ command, cwd: opts.cwd, env: opts.env(slug), timeoutMs: COMMAND_WATCH_RUN_TIMEOUT_MS, signal: runOpts?.signal })),
    async probe(slug, command) {
      if (probesActive >= PROBE_CONCURRENCY) return undefined
      probesActive++
      try {
        return await runner({ command, cwd: opts.cwd, env: opts.env(slug), timeoutMs: COMMAND_WATCH_PROBE_TIMEOUT_MS })
      } finally {
        probesActive--
      }
    },
    startMonitor(slug, command, onEvent) {
      if (monitorsRunning >= MONITOR_SERVER_MAX_RUNNING) return undefined
      monitorsRunning++
      const proc = (opts.startMonitorProcess ?? startMonitorProcess)({ command, cwd: opts.cwd, env: opts.env(slug), onEvent, batchMs: opts.monitorBatchMs })
      void proc.done.finally(() => { monitorsRunning-- })
      return proc
    },
    monitorsRunning: () => monitorsRunning,
    reapStaleMonitor: (pid, startedAtMs) => reapStaleMonitor(pid, startedAtMs, opts.readPs),
  }
}

/** The environment a check runs with, given the server's own and the thread's Frizz variables. Git and
 *  `gh` are told never to prompt: there is nobody at a terminal, and stdin is closed.
 *
 *  FRIZZ_THREAD is dropped rather than inherited: it is the orphan reaper's ownership tag
 *  (orphan-reaper.ts), and a check carrying a thread's tag with no live session root behind it would be
 *  reaped as an orphan. The thread's identity rides FRIZZ_THREAD_SLUG, which `frizzctl` reads first. */
export function commandWatchEnvironment(
  base: Record<string, string | undefined>,
  frizz: Record<string, string>,
): Record<string, string | undefined> {
  const { FRIZZ_THREAD: _tag, ...rest } = base
  return { ...rest, ...frizz, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }
}
