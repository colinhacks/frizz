// The parent side of the Claude session broker: derive its socket/record paths, fork it as a detached
// daemon, and — after a frizz restart — ADOPT an already-running one instead of cold-starting. Mirrors
// codex-app-server-host.ts (fork/record/adopt), keyed per Claude session id (one broker per thread).
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { delimiter, dirname, isAbsolute, join } from "node:path"
import { resolveDetachedDaemonEntry } from "../detached-daemons.ts"
import type { BrokerRecord, ClaudeBrokerConfig } from "./claude-agent-broker.ts"
import { claudeBrokerDiagnosticLogPath, describeClaudeBrokerExit, readClaudeBrokerExit } from "./claude-broker-diagnostics.ts"
import { daemonMayBeSignalled, daemonPidVerdict, type DaemonClaim, type DaemonIdentityDeps } from "./daemon-identity.ts"
import { endDaemonTree, type EndDaemonTreeDeps } from "./daemon-tree.ts"
import { frizzIpcPath } from "./ipc-path.ts"
import type { WorkerMcpServers } from "./project-mcp-servers.ts"
import { ensureRuntime } from "../runtime-deferral.ts"

// The Claude Agent SDK REQUIRES an absolute `pathToClaudeCodeExecutable` (validateExecutablePath rejects
// a bare name), unlike an execvp of the CLI, which resolves "claude" on PATH itself. When the dispatch layer
// hands us a bare "claude" (the default when no --claude-bin is configured — the promoted-artifact case),
// resolve it to an absolute path on PATH here, or the forked daemon dies on startup ("executablePath must
// be absolute") before it can publish its record and every dispatch times out with "did not become ready".
//
// WINDOWS is a different problem, and the naive scan below got it wrong. `npm i -g` writes THREE files
// into the bin dir — `claude` (a `#!/bin/sh` script), `claude.cmd`, and `claude.ps1` — because Windows
// cannot symlink the way POSIX npm does. The bare-name scan therefore found the SH SCRIPT and returned
// it: nothing on Windows can run that (spawning it is ENOENT, and `node` reads it as JavaScript and
// dies on line 2). Measured on Windows Server 2022 with claude 2.1.220:
//
//   spawn(<bin>\claude)      -> ENOENT          node <bin>\claude   -> SyntaxError at line 2
//   spawn(<bin>\claude.cmd)  -> EINVAL          (Node refuses .cmd/.bat without shell since CVE-2024-27980)
//   spawn(<real claude.exe>) -> exit 0 "2.1.220 (Claude Code)"
//
// So `.cmd` is not the answer either. The real executable is a NATIVE claude.exe that ships inside the
// package and is NOT itself on PATH — the `.cmd` shim is just a stub that calls it. Hence: prefer a
// real `.exe` on PATH, else find the `.cmd` shim and follow it to the target it invokes.
const WINDOWS_SHIM_TARGET = /^\s*"%dp0%\\(.+?)"/mu

/** Read a `.cmd` shim and return the absolute path of the executable it actually invokes. */
function windowsShimTarget(shimPath: string): string | undefined {
  let body: string
  try { body = readFileSync(shimPath, "utf8") } catch { return undefined }
  const target = WINDOWS_SHIM_TARGET.exec(body)?.[1]
  if (!target) return undefined
  const full = join(dirname(shimPath), target)
  try { accessSync(full, fsConstants.F_OK); return full } catch { return undefined }
}

/** The search path, under whatever name this environment spells it.
 *
 *  `env.PATH` is not enough and the difference is Windows-fatal. Windows environment names are
 *  case-insensitive and it spells this one `Path`; only `process.env` emulates that, so a plain object
 *  copied out of it — which is exactly what the bridge hands this resolver — has no `PATH` key at all.
 *  Measured on Windows Server 2022 / node 26.7.0: `Object.keys(process.env)` contains `Path`,
 *  `{...process.env}.PATH` is `undefined`, and this function resolved claude 2.1.241 from `process.env`
 *  while THROWING on a plain copy of the same environment. That throw is raised during context
 *  creation, so it did not merely break dispatch — the whole server refused to boot on Windows. */
function searchPath(env: NodeJS.ProcessEnv): string {
  const direct = env.PATH ?? env.Path ?? env.path
  if (direct !== undefined) return direct
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === "path") return value ?? ""
  return ""
}

export function resolveClaudeExecutableAbsolute(bin: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const candidate = bin && bin.length > 0 ? bin : "claude"
  if (isAbsolute(candidate)) return candidate
  const windows = process.platform === "win32"
  for (const dir of searchPath(env).split(delimiter)) {
    if (!dir) continue
    if (windows) {
      // A real executable wins outright (a standalone install, or a future npm layout that ships one).
      const exe = join(dir, `${candidate}.exe`)
      try { accessSync(exe, fsConstants.F_OK); return exe } catch { /* no .exe here */ }
      // Otherwise follow the npm `.cmd` stub to the binary it calls. Deliberately NEVER return the
      // extensionless sibling: on Windows that is a POSIX shell script and it is unusable.
      const viaShim = windowsShimTarget(join(dir, `${candidate}.cmd`))
      if (viaShim) return viaShim
      continue
    }
    const full = join(dir, candidate)
    try { accessSync(full, fsConstants.X_OK); return full } catch { /* try next PATH entry */ }
  }
  throw new Error(`Claude session broker: could not resolve '${candidate}' to an absolute executable path on PATH (the SDK requires one)`)
}

/** Short, collision-resistant endpoint name — a unix socket on POSIX, a named pipe on Windows.
 *  See ipc-path.ts for why the two spellings exist and what each one costs. */
export function claudeBrokerSocketPath(stateDir: string, sessionId: string): string {
  const key = createHash("sha256").update(stateDir).update("\0").update(sessionId).digest("hex").slice(0, 16)
  return frizzIpcPath(`frizz-claude-${key}`)
}

/** The discovery record lives under the project state dir (long paths are fine here). */
export function claudeBrokerRecordPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "claude-broker", claudeBrokerRecordName(sessionId))
}

// The record's FILE NAME for a session: a hash of its id, so it is the same for the life of the process
// and worth computing once. The board asks it for every Claude row on every build — 5,000 sha256s per
// refresh on a 5,000-thread board, 4% of the refresh on its own in a CPU profile.
const recordNames = new Map<string, string>()
function claudeBrokerRecordName(sessionId: string): string {
  let name = recordNames.get(sessionId)
  if (name === undefined) {
    name = `${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.json`
    recordNames.set(sessionId, name)
  }
  return name
}

// ---- which records EXIST, read once per board build -----------------------------------------------
// `isDaemonAlive` reads one record file per session, and on a board of history almost every one of
// those reads fails: a dead daemon's record is unlinked the first time anyone notices (liveBrokerRecord),
// so an archived thread's record is simply not there. A failed read is a THROWN ENOENT — measured on a
// 5,000-thread board as 22% of a ~260ms board refresh, one throwing syscall per archived thread, every
// refresh, to learn the same "absent" again.
//
// So the board takes the directory's listing once per build (brokerLivenessSnapshot) and reads a record
// only when its name is in it — which is exactly the set of reads that can return anything: an absent
// file is `null` from liveBrokerRecord with no side effect, so skipping it changes no answer.
//
// The listing itself is kept until the directory changes, which a creation or removal of an entry always
// records in the directory's own mtime. A daemon rewriting its record IN PLACE does not move it, and
// needs not to: that name is already listed, so its file is read. One trap, the classic racy-timestamp
// one: a filesystem stamps mtimes at its own granularity (1s on HFS+, 2s on FAT), so an entry created
// within the same tick as the listing could leave the mtime unchanged. A listing is therefore only
// trusted once the directory's mtime is at least RACY_LISTING_MS older than the moment it was taken;
// until then it is taken again on the next build.
const RACY_LISTING_MS = 2_000
const listings = new Map<string, { mtimeMs: number; ino: number; names: ReadonlySet<string>; trusted: boolean }>()
function recordListing(dir: string): ReadonlySet<string> {
  let stat
  try { stat = statSync(dir, { throwIfNoEntry: false }) } catch { stat = undefined }
  if (!stat) {
    listings.delete(dir)
    return new Set()
  }
  const cached = listings.get(dir)
  if (cached && cached.trusted && cached.mtimeMs === stat.mtimeMs && cached.ino === stat.ino) return cached.names
  const listedAt = Date.now()
  let names: ReadonlySet<string>
  try { names = new Set(readdirSync(dir)) } catch { names = new Set() }
  listings.set(dir, { mtimeMs: stat.mtimeMs, ino: stat.ino, names, trusted: stat.mtimeMs <= listedAt - RACY_LISTING_MS })
  return names
}

/**
 * Liveness of every broker daemon under this state dir, as one snapshot: the directory listing is
 * taken once, and a session's record is read (and pid-probed, and pruned when dead) only when it
 * exists. Answers exactly what `liveBrokerRecord(claudeBrokerRecordPath(…)) !== null` answers.
 */
export function brokerLivenessSnapshot(stateDir: string): BrokerLivenessSnapshot {
  const dir = join(stateDir, "claude-broker")
  const names = recordListing(dir)
  const alive = (sessionId: string) => {
    const name = claudeBrokerRecordName(sessionId)
    return names.has(name) && recordDaemonAlive(join(dir, name))
  }
  return Object.assign(alive, {
    listing: names,
    listed: (sessionId: string) => names.has(claudeBrokerRecordName(sessionId)),
  })
}

// THE PID A RECORD NAMES, read once per version of the file. A board build asks whether each open broker
// thread's daemon is alive, every build, and reading and parsing its record each time was most of what that
// cost (2026-11-10). A record is written whole when its daemon starts, so while the file's identity, size
// and modification instant are unchanged it names the same pid, and only the pid itself needs asking
// again. A pid found dead goes through liveBrokerRecord, which reads the file afresh and prunes it exactly
// as before. Answers what `liveBrokerRecord(path) !== null` answers.
const recordPids = new Map<string, { ino: number; size: number; mtimeMs: number; pid: number }>()
function recordDaemonAlive(recordPath: string): boolean {
  let file
  try { file = statSync(recordPath, { throwIfNoEntry: false }) } catch { file = undefined }
  if (!file) {
    recordPids.delete(recordPath)
    return false
  }
  const known = recordPids.get(recordPath)
  if (known && known.ino === file.ino && known.size === file.size && known.mtimeMs === file.mtimeMs && pidAlive(known.pid)) return true
  const record = liveBrokerRecord(recordPath)
  if (record && typeof record.daemonPid === "number") recordPids.set(recordPath, { ino: file.ino, size: file.size, mtimeMs: file.mtimeMs, pid: record.daemonPid })
  else recordPids.delete(recordPath)
  return record !== null
}

/** brokerLivenessSnapshot's reader, plus the listing it answers from. `listing` is the SAME object for as
 *  long as the directory has not changed, so a caller that saw a session absent from it can know it is
 *  still absent (and so still not alive) without asking again. */
export type BrokerLivenessSnapshot = ((sessionId: string) => boolean) & {
  readonly listing: ReadonlySet<string>
  /** Whether the session has a record file at all — false means not alive, with nothing to read. */
  listed(sessionId: string): boolean
}

/** Why frizz retired a daemon ON PURPOSE, while keeping the conversation. Every one of these ends a
 *  PROCESS, never a session: the transcript is on disk and the next input cold-resumes it.
 *   - `retire`        — a launch flag changed (permission mode / restart worker), so the next turn
 *                       has to start under a new process. See the bridge's retireDaemon.
 *   - `fresh-process` — a usage-limit resume; the latched `claude` would refuse the message.
 *   - `hibernate`     — the thread has rested past the idle threshold and its memory was reclaimed.
 *                       See thread-hibernation.ts.
 *   - `relocate`      — Frizz renamed the project's folder; the daemon was started in the old one and
 *                       is retired at rest so it resumes in the new one. See project-relocation.ts. */
export type BrokerRetirementReason = "retire" | "fresh-process" | "hibernate" | "relocate"

/** The breadcrumb one intentional teardown leaves for the cold resume that follows it. */
export interface BrokerRetirementMark {
  at: string
  /** The generation of the daemon that was retired. A LATER daemon's genuine death must never be
   *  masked by a mark left for its predecessor, so the consumer compares this against the exit
   *  record's own generation before it suppresses anything. */
  generation: string
  reason: BrokerRetirementReason
}

/** Sits beside the record and the diagnostics log so a session's whole broker footprint stays in one
 *  directory. Deliberately NOT a `.json` name: liveBrokerRecords() reads every `*.json` here as a
 *  BrokerRecord and unlinks whatever fails its pid probe, which would delete this the moment it was
 *  written. */
export function claudeBrokerRetirementPath(stateDir: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
  return join(stateDir, "claude-broker", `${key}.retired`)
}

/** Record that the daemon about to die is dying because frizz asked. Best-effort: a mark that cannot
 *  be written costs one spurious "the thread crashed" log line, never the teardown itself. */
export function markBrokerRetired(stateDir: string, sessionId: string, reason: BrokerRetirementReason, generation: string): void {
  const mark: BrokerRetirementMark = { at: new Date().toISOString(), generation, reason }
  try {
    const path = claudeBrokerRetirementPath(stateDir, sessionId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(mark))
  } catch { /* forensics degrade, never throw */ }
}

/** Read and CONSUME the mark — one intentional teardown explains exactly one cold resume. Consuming
 *  it here (rather than leaving it for a later reader) is what stops a stale mark from ever swallowing
 *  a second, genuine death. */
export function takeBrokerRetirement(stateDir: string, sessionId: string): BrokerRetirementMark | null {
  const path = claudeBrokerRetirementPath(stateDir, sessionId)
  let mark: BrokerRetirementMark | null = null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BrokerRetirementMark>
    if (typeof parsed?.at === "string" && typeof parsed.generation === "string" && typeof parsed.reason === "string") {
      mark = { at: parsed.at, generation: parsed.generation, reason: parsed.reason as BrokerRetirementReason }
    }
  } catch { /* no mark, or a torn write — either way there is nothing to explain a death with */ }
  try { unlinkSync(path) } catch {}
  return mark
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

export function readBrokerRecord(recordPath: string): BrokerRecord | null {
  try { return JSON.parse(readFileSync(recordPath, "utf8")) as BrokerRecord } catch { return null }
}

/** Where a session's LAST daemon identity survives after its record is gone.
 *
 *  A record is deleted the moment anyone notices the daemon is dead, and by then nobody can say WHICH
 *  daemon that was — which is the one thing the death report needs, because a session's diagnostic log
 *  accumulates every generation and "the newest entry" is only the right answer when the daemon that
 *  just died managed to write one. Preserving the identity on the way out is what lets the report tell a
 *  cause this daemon recorded from a predecessor's, instead of quoting the predecessor's in the
 *  confident voice of the current one (measured 2026-08-19: a 21:57:54 SIGKILL reported as
 *  "exited (signal-SIGTERM) at 21:55:46"). Both deletion sites below write it, so no path loses it. */
export function brokerLastKnownPath(recordPath: string): string { return `${recordPath}.last` }

/** The identity of the last daemon frizz knew for this session, alive or dead. Outlives the record. */
export function lastKnownBrokerDaemon(stateDir: string, sessionId: string): BrokerRecord | null {
  return readBrokerRecord(brokerLastKnownPath(claudeBrokerRecordPath(stateDir, sessionId)))
}

/** Remember who this record named, then let it be deleted. Best-effort: forensics never block a teardown. */
function rememberBrokerIdentity(recordPath: string, record: BrokerRecord): void {
  try { writeFileSync(brokerLastKnownPath(recordPath), JSON.stringify(record)) } catch {}
}

/** What a record claims about its daemon's process, for daemon-identity.ts. */
function brokerClaim(record: BrokerRecord): DaemonClaim {
  return { pid: record.daemonPid, createdAt: record.createdAt, processStart: record.processStart }
}

/** A record whose daemon is still alive; prunes a stale record as a side effect.
 *
 *  "Alive" here is the pid answering, which a recycled pid also does. That is deliberate for a READ:
 *  the two places that ACT on a record ask daemon-identity.ts whose process it is first
 *  (adoptOrForkBroker before it reattaches, killBroker before it signals). */
export function liveBrokerRecord(recordPath: string): BrokerRecord | null {
  const record = readBrokerRecord(recordPath)
  if (record && pidAlive(record.daemonPid)) return record
  if (record) { rememberBrokerIdentity(recordPath, record); try { unlinkSync(recordPath) } catch {} }
  return null
}

/** Every broker daemon under this state dir that is still running — the set a booting frizz can adopt.
 *
 *  Enumerates the record DIRECTORY rather than probing one path per registry row: the record filename
 *  is a hash of the session id and cannot be inverted, and at boot the live set (a handful of daemons)
 *  is tiny next to a project's session history (hundreds of rows). Stale records are pruned on the way
 *  through, exactly as a single liveBrokerRecord read does. Never throws — a project that has never run
 *  a broker has no such directory, and that is simply "none". */
export function liveBrokerRecords(stateDir: string): BrokerRecord[] {
  const dir = join(stateDir, "claude-broker")
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const out: BrokerRecord[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue // the .diagnostics.log files live here too
    const record = liveBrokerRecord(join(dir, name))
    if (record) out.push(record)
  }
  return out
}

export interface ForkBrokerOptions {
  stateDir: string
  cwd: string
  sessionId: string
  executablePath: string
  permissionMode?: ClaudeBrokerConfig["permissionMode"]
  env: Record<string, string>
  appendSystemPrompt?: string
  model?: string
  effort?: string
  /** Resume the on-disk session instead of starting fresh (dead-daemon follow-up cold start). */
  resume?: boolean
  /** The frizz worker environment (plugin + MCP + per-thread frizz vars) — see ClaudeBrokerConfig. */
  pluginDir?: string
  mcpServers?: WorkerMcpServers
  allowedTools?: string[]
  workerEnv?: Record<string, string>
  /** The launch prefix's words, resolved only when this call FORKS — adopting a live daemon never asks,
   *  so a prefix that no longer parses fails a new worker and never a reattach. May throw. */
  launchPrefix?: () => string[]
  /** Override the daemon entry (tests). Defaults to the bundled/sibling claude-agent-broker. */
  daemonEntry?: string
  timeoutMs?: number
}

/** Spawn the broker as a detached daemon; resolve once it has published its record (socket listening). */
export function forkBroker(options: ForkBrokerOptions): Promise<BrokerRecord> {
  const socketPath = claudeBrokerSocketPath(options.stateDir, options.sessionId)
  const recordPath = claudeBrokerRecordPath(options.stateDir, options.sessionId)
  mkdirSync(dirname(recordPath), { recursive: true })
  const generation = randomUUID()
  const launchPrefix = options.launchPrefix?.() ?? []
  const config: ClaudeBrokerConfig = {
    socketPath, cwd: options.cwd, sessionId: options.sessionId, executablePath: options.executablePath,
    permissionMode: options.permissionMode, env: options.env, recordPath, generation,
    // The daemon writes its own death forensics here. Same dir as the record, so a session's socket,
    // record and diagnostics stay together and a project teardown removes all three.
    diagnosticLogPath: claudeBrokerDiagnosticLogPath(options.stateDir, options.sessionId),
    appendSystemPrompt: options.appendSystemPrompt, model: options.model, effort: options.effort,
    resume: options.resume,
    pluginDir: options.pluginDir, mcpServers: options.mcpServers, allowedTools: options.allowedTools,
    workerEnv: options.workerEnv,
    ...(launchPrefix.length > 0 ? { launchPrefix } : {}),
  }
  const entry = options.daemonEntry ?? resolveDetachedDaemonEntry(import.meta.url, "claude-agent-broker")
  const child = spawn(process.execPath, [entry], {
    cwd: options.cwd,
    env: { ...process.env, FRIZZ_CLAUDE_BROKER: JSON.stringify(config) },
    detached: true,
    stdio: "ignore",
    // A detached process owns no console on Windows; keep the daemon from ever being handed a
    // visible one (Windows audit 2026-09-11, finding 4 — the Codex daemon's spawn tells the story).
    windowsHide: true,
  })
  child.unref()

  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  // NOTHING BELOW MAY CLOSE OVER `options` OR `config`. The `exit` listener lives on the ChildProcess,
  // and a detached daemon's ChildProcess lives as long as the daemon does, so whatever the closures here
  // capture is held for the life of the thread: `options` carries the worker's whole system prompt
  // (~160 KB each), and 32 live daemons held 5 MB of them (heap snapshot, 2026-11-09). Read the two
  // strings the closures need into locals, and drop the listeners once the fork has settled.
  const { stateDir, sessionId } = options
  // The cause a dead daemon recorded for itself (claude-broker-diagnostics.ts), keyed to THIS fork's
  // generation so a predecessor's death is never quoted as this one's.
  const recordedCause = () => readClaudeBrokerExit(stateDir, sessionId, generation)
  return new Promise<BrokerRecord>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const settle = (outcome: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      child.removeAllListeners("exit")
      outcome()
    }
    const poll = () => {
      const record = readBrokerRecord(recordPath)
      if (record && pidAlive(record.daemonPid)) return settle(() => resolve(record))
      if (Date.now() > deadline) {
        // A daemon that died AND wrote its exit record is named here too: the deadline path is what
        // an operator sees when the exit event was missed (a frizz restart between fork and death).
        const exit = recordedCause()
        return settle(() => reject(new Error(
          `Claude broker for session ${sessionId} did not become ready${exit ? `: ${describeClaudeBrokerExit(exit)}` : ""}`,
        )))
      }
      timer = setTimeout(poll, 50)
    }
    child.once("error", (error) => settle(() => reject(error)))
    // A daemon that dies before publishing its record used to be indistinguishable from a slow one:
    // the poll ran the full 30s and rejected with nothing but "did not become ready", while the cause
    // sat in the diagnostics log the daemon had written on its way out (2026-09-10: the pinned
    // binary directory had been swept, the daemon died in under a second with "Claude executable is
    // not executable", and the operator got the opaque timeout for every new thread). `exit` still
    // fires for a detached, unref'd child while this process lives, so reject on the spot and quote
    // the record. The daemon's synchronous exit write can trail the OS exit notification by a few
    // ms, so the read is retried briefly before "left no exit record" is accepted as the answer.
    child.once("exit", (code, signal) => {
      if (settled) return
      const how = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`
      const until = Date.now() + 500
      const read = () => {
        if (settled) return
        const exit = recordedCause()
        if (!exit && Date.now() < until) { setTimeout(read, 25); return }
        settle(() => reject(new Error(
          `Claude broker for session ${sessionId} exited before it became ready (${how}): ${describeClaudeBrokerExit(exit)}`,
        )))
      }
      read()
    })
    poll()
  })
}

/** Reattach to a live broker if one exists (frizz restart), else fork a fresh one.
 *
 *  A record whose pid now belongs to ANOTHER process is not a broker to reattach to. Until 2026-11-10
 *  it was taken for one: the bridge was handed a socket nobody served, every send to the thread failed
 *  with "could not reach this thread's Claude session … Resend it", and nothing on that path dropped the
 *  record, so the thread stayed unreachable for as long as the other process lived. Such a record is
 *  dropped here and the session cold-starts, as it does when its daemon is simply gone. */
export async function adoptOrForkBroker(options: ForkBrokerOptions, deps: { identity?: DaemonIdentityDeps } = {}): Promise<{ record: BrokerRecord; reattached: boolean }> {
  const recordPath = claudeBrokerRecordPath(options.stateDir, options.sessionId)
  const existing = liveBrokerRecord(recordPath)
  if (existing && daemonPidVerdict(brokerClaim(existing), deps.identity) !== "not-ours") return { record: existing, reattached: true }
  if (existing) { rememberBrokerIdentity(recordPath, existing); try { unlinkSync(recordPath) } catch {} }
  await ensureRuntime("claude")
  return { record: await forkBroker(options), reattached: false }
}

/** Best-effort terminate: SIGTERM the daemon and drop its record. Detach (client.close) is NOT this.
 *  Returns whether a live daemon record was present (i.e. there was something to stop).
 *
 *  `retireReason` says this teardown is one frizz CHOSE while keeping the conversation, and leaves the
 *  mark that stops the cold resume behind it being reported to the operator as a crash. Omit it for a
 *  teardown that ends the session itself (a stop, a completion, a replaced session): there is no later
 *  resume to explain, and no death to suppress — and any mark an EARLIER retirement left is void, so
 *  this clears it rather than leaving a promise of a resume that is never coming. The mark is written
 *  BEFORE the signal so a frizz that dies mid-teardown still leaves the truth on disk.
 *
 *  The signal goes through endDaemonTree (daemon-tree.ts): SIGTERM on POSIX, where the daemon's own
 *  handler and the SDK's exit cleanup end `claude` under it, and `taskkill /T /F` on Windows, where a
 *  signal is TerminateProcess of the daemon ALONE and `claude.exe` kept running its turn — tools
 *  executing, files changing — behind a card that read stopped (Windows audit 2026-09-11, finding 5).
 *  `deps` is the seam a test routes through.
 *
 *  THE SIGNAL GOES ONLY TO A PROCESS THAT CAN STILL BE THE DAEMON (daemon-identity.ts). A record that
 *  outlived its daemon names a pid the OS has since given to something else, and this runs unattended
 *  from the hibernator as well as from Stop: the record is dropped either way, and a process that
 *  started after the record was written is left alone. */
export function killBroker(stateDir: string, sessionId: string, retireReason?: BrokerRetirementReason, deps: EndDaemonTreeDeps & { identity?: DaemonIdentityDeps } = {}): boolean {
  const recordPath = claudeBrokerRecordPath(stateDir, sessionId)
  const record = liveBrokerRecord(recordPath)
  if (retireReason) { if (record) markBrokerRetired(stateDir, sessionId, retireReason, record.generation) }
  else takeBrokerRetirement(stateDir, sessionId)
  if (record) {
    rememberBrokerIdentity(recordPath, record)
    if (daemonMayBeSignalled(brokerClaim(record), deps.identity)) endDaemonTree(record.daemonPid, "SIGTERM", deps)
  }
  try { unlinkSync(recordPath) } catch {}
  return record !== null
}
