// IS THE PROCESS BEHIND THIS PID STILL THE DAEMON THAT WROTE THE RECORD?
//
// Every detached daemon Frizz forks (the Claude session broker, the Codex app-server daemon and its
// native listener, an ACP agent's daemon) publishes a record naming its pid, and until 2026-11-10 every
// teardown signalled that pid on the strength of `process.kill(pid, 0)` alone. A pid is not an identity.
// A broker ended by a signal left its record behind, the record lives under the state directory and
// survives a reboot, and after one the same number belongs to whatever the OS handed it to. Stop, Mark as
// done, a permission change, a project delete and the unattended hibernator all then sent SIGTERM (on
// Windows, a forced kill of the whole tree) to a process that was never Frizz's. Measured on the
// maintainer's machine when this was written: 31 broker records on disk against 927 live processes, so a
// reboot had roughly one chance in four of leaving a record that named somebody else's process.
//
// THE TEST IS WHEN THE PROCESS STARTED. A daemon writes its record after it has started, and a pid is
// reused only after its process has died, so whatever holds a recycled pid started AFTER the record was
// written. One `ps` (or, on Windows, one PowerShell read) answers that, and it needs nothing the record
// did not already carry: every record has had `createdAt` from the start, so a record written by an
// older daemon is judged as well as a new one.
//
// LINUX GETS AN EXACT STAMP TOO. There the start time `ps` prints is derived from the boot time, which
// moves when the wall clock is stepped (WSL2 does it after the host sleeps), so a real daemon could read
// as started after its own record. `/proc/<pid>/stat` holds the start in ticks since boot, which no
// clock change touches and which costs a file read, so a daemon on Linux writes that into its record and
// it is compared exactly. macOS and Windows keep the creation instant itself, which never moves.
//
// WHAT THE VERDICT DECIDES: whether Frizz may SIGNAL the pid, and nothing else. `not-ours` is the only
// answer that withholds a signal. `unknown` (the start time could not be read at all) signals as before:
// there the choice is between a rare wrong kill and a worker that can never be stopped, and every
// platform Frizz supports can read a start time. Whether a record is LIVE is still the pid probe plus the
// daemon's own socket, because a wrong `not-ours` on that path would fork a second daemon onto a session
// that still has one.
//
// No import here has a side effect, on purpose: the daemons load this file, and process-generation.ts
// spawns `ps` (PowerShell on Windows, a quarter of a second) the moment it is imported.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** What a daemon record claims about the process behind it. */
export interface DaemonClaim {
  pid: number
  /** When the record was written (ISO). Every record carries it. */
  createdAt?: string
  /** The daemon's own exact start marker, where the platform has one that costs nothing to read. */
  processStart?: string
}

export type DaemonPidVerdict =
  /** The pid is running and started when this daemon did. */
  | "ours"
  /** Nothing is running under the pid. */
  | "gone"
  /** The pid is running and it is some other process: it started after the record was written. */
  | "not-ours"
  /** The pid is running and its start time could not be read. */
  | "unknown"

export interface DaemonIdentityDeps {
  platform?: NodeJS.Platform
  alive?: (pid: number) => boolean
  /** The platform's exact start marker for a pid, in the form `selfProcessStart` writes. */
  exactStart?: (pid: number) => string | undefined
  /** When a pid's process started, in epoch milliseconds. */
  startedAtMs?: (pid: number) => number | undefined
}

/** A record is written once its daemon is ready, seconds after the process began, and `ps` reports a
 *  start to the second. Anything inside this much of the record is the daemon itself. */
const STARTED_AFTER_RECORD_SLACK_MS = 5_000

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

/** `linux:<boot id>:<start ticks>`, the same marker process-generation.ts writes. Linux only. */
function linuxExactStart(pid: number | "self"): string | undefined {
  if (process.platform !== "linux") return undefined
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase()
    if (!/^[0-9a-f-]{36}$/u.test(bootId)) return undefined
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim()
    // proc(5): comm is parenthesized and may hold spaces or ')'. The fields after its last `) ` begin
    // at field 3, and starttime is field 22: index 19 of that suffix.
    const suffixAt = stat.lastIndexOf(") ")
    if (suffixAt < 0) return undefined
    const ticks = stat.slice(suffixAt + 2).trim().split(/\s+/u)[19]
    return ticks && /^\d+$/u.test(ticks) ? `linux:${bootId}:${ticks}` : undefined
  } catch {
    return undefined
  }
}

/** What a daemon writes into its own record as `processStart`. Undefined where no exact marker is free
 *  to read, and the record's `createdAt` then carries the check. */
export function selfProcessStart(): string | undefined {
  return linuxExactStart("self")
}

/** The same marker for a process this one spawned, for a record its SPAWNER writes (the Codex native
 *  listener is codex's own process and writes none). */
export function exactProcessStart(pid: number): string | undefined {
  return linuxExactStart(pid)
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** `ps -o lstart=` in the C locale: `Mon Nov 10 08:36:12 2026`, read as UTC because the caller set TZ. */
export function parsePsStart(value: string): number | undefined {
  const match = /^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u.exec(value.trim().replace(/\s+/gu, " "))
  if (!match) return undefined
  const month = MONTHS.indexOf(match[1]!)
  if (month < 0) return undefined
  return Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]))
}

/** A Windows FILETIME (100ns units since 1601-01-01 UTC) as epoch milliseconds. */
export function filetimeToMs(value: string): number | undefined {
  if (!/^\d{1,20}$/u.test(value)) return undefined
  return Number(BigInt(value) / 10_000n - 11_644_473_600_000n)
}

function startedAtMs(pid: number): number | undefined {
  try {
    if (process.platform === "win32") {
      // Anchored to %SystemRoot% rather than found on PATH: Windows searches the current directory
      // first, and that is a project checkout. `Get-Process` over `Get-CimInstance` and `wmic` for the
      // reasons process-generation.ts measured.
      const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      const value = execFileSync(shell, [
        "-NoProfile", "-NonInteractive", "-NoLogo", "-Command",
        `try{[Console]::Out.Write((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc())}catch{exit 1}`,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, windowsHide: true }).trim()
      return filetimeToMs(value)
    }
    const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC0" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    })
    return parsePsStart(value)
  } catch {
    return undefined
  }
}

/** Whose process is behind this record's pid. See the header for what each answer is used for. */
export function daemonPidVerdict(claim: DaemonClaim, deps: DaemonIdentityDeps = {}): DaemonPidVerdict {
  if (!(deps.alive ?? pidAlive)(claim.pid)) return "gone"
  if (claim.processStart) {
    const now = (deps.exactStart ?? linuxExactStart)(claim.pid)
    if (now) return now === claim.processStart ? "ours" : "not-ours"
  }
  // A Linux record with no stamp was written by a daemon from before the stamp. The start time `ps`
  // derives there moves with the wall clock, so it cannot be held against `createdAt`: unknown, and
  // judged as it always was until that daemon is replaced.
  if ((deps.platform ?? process.platform) === "linux") return "unknown"
  const created = Date.parse(claim.createdAt ?? "")
  if (!Number.isFinite(created)) return "unknown"
  const started = (deps.startedAtMs ?? startedAtMs)(claim.pid)
  if (started === undefined) return "unknown"
  return started > created + STARTED_AFTER_RECORD_SLACK_MS ? "not-ours" : "ours"
}

/** May Frizz signal this record's pid? Everything but a process it can show is somebody else's. */
export function daemonMayBeSignalled(claim: DaemonClaim, deps: DaemonIdentityDeps = {}): boolean {
  const verdict = daemonPidVerdict(claim, deps)
  return verdict === "ours" || verdict === "unknown"
}
