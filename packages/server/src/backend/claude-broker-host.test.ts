import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import { brokerLivenessSnapshot, claudeBrokerRecordPath, forkBroker, killBroker, liveBrokerRecord, resolveClaudeExecutableAbsolute } from "./claude-broker-host.ts"

// The npm `.cmd` stub, verbatim from a real `npm i -g @anthropic-ai/claude-code` on Windows Server
// 2022 (claude 2.1.220). Its whole job is to call the native exe that ships inside the package.
const REAL_CMD_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join("\r\n")

function binDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "frizz-claude-bin-"))
  // POSIX npm symlinks the bare name to the JS entry; WINDOWS npm cannot, so it writes a shell script
  // by that name instead. Either way the bare name exists — which is exactly why the old scan was
  // fooled into returning it.
  writeFileSync(join(dir, "claude"), "#!/bin/sh\nexec node cli.js \"$@\"\n", { mode: 0o755 })
  return dir
}

test("windows: the resolver follows the .cmd stub to the real exe, never the #!/bin/sh sibling", (t) => {
  if (process.platform !== "win32") return t.skip("windows-only resolution path")
  const dir = binDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const exeDir = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin")
  mkdirSync(exeDir, { recursive: true })
  writeFileSync(join(exeDir, "claude.exe"), "MZ")
  writeFileSync(join(dir, "claude.cmd"), REAL_CMD_SHIM)

  const resolved = resolveClaudeExecutableAbsolute(undefined, { PATH: dir })
  assert.equal(resolved, join(exeDir, "claude.exe"))
  assert.ok(!resolved.endsWith(`${delimiter}claude`), "must never hand the SDK the shell script")
})

test("windows: a real claude.exe on PATH wins outright, without reading any stub", (t) => {
  if (process.platform !== "win32") return t.skip("windows-only resolution path")
  const dir = binDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, "claude.exe"), "MZ")
  // A stub pointing somewhere that does NOT exist: if the .exe did not win, this would resolve to
  // undefined and the scan would fall through, so the assertion below is load-bearing.
  writeFileSync(join(dir, "claude.cmd"), '"%dp0%\\nope\\missing.exe"   %*')
  assert.equal(resolveClaudeExecutableAbsolute(undefined, { PATH: dir }), join(dir, "claude.exe"))
})

test("windows: a bin dir holding ONLY the shell script is not a resolution", (t) => {
  if (process.platform !== "win32") return t.skip("windows-only resolution path")
  const dir = binDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // This is the state that shipped broken: the bare name is present and nothing else is. Returning it
  // handed the SDK a file Windows cannot execute, so every dispatch died before the handshake.
  assert.throws(() => resolveClaudeExecutableAbsolute(undefined, { PATH: dir }), /could not resolve/)
})

test("posix: the bare name on PATH still resolves, and an absolute bin is passed through", (t) => {
  if (process.platform === "win32") return t.skip("posix resolution path")
  const dir = binDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(resolveClaudeExecutableAbsolute(undefined, { PATH: dir }), join(dir, "claude"))
  assert.equal(resolveClaudeExecutableAbsolute("/opt/claude/bin/claude", { PATH: dir }), "/opt/claude/bin/claude")
})

// This is the one that made the whole SERVER refuse to boot on Windows, not merely a dispatch.
// Windows environment names are case-insensitive and it spells this one `Path`; only `process.env`
// emulates that, so the plain object the bridge copies out of it has no `PATH` key at all and the
// resolver scanned an empty search path. Measured on Windows Server 2022 / node 26.7.0: with
// `process.env` it resolved claude 2.1.241; with `{...process.env}` it threw. The startup path raises
// that throw during context creation, so nothing on Windows started.
//
// Asserted on EVERY platform deliberately: the spelling is what is under test, not the OS, and a
// win32-only gate would leave the regression unpinned on the machines that actually run this suite.
test("the search path is found under any spelling of its name, not just PATH", (t) => {
  const dir = binDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const expected = process.platform === "win32" ? join(dir, "claude.exe") : join(dir, "claude")
  if (process.platform === "win32") writeFileSync(join(dir, "claude.exe"), "MZ")
  for (const spelling of ["PATH", "Path", "path"]) {
    assert.equal(
      resolveClaudeExecutableAbsolute(undefined, { [spelling]: dir }), expected,
      `a search path spelled ${spelling} must still resolve`,
    )
  }
})

test("an unresolvable name fails loudly rather than handing the SDK a bare name", () => {
  const empty = mkdtempSync(join(tmpdir(), "frizz-claude-empty-"))
  try {
    assert.throws(() => resolveClaudeExecutableAbsolute("definitely-not-installed", { PATH: empty }), /could not resolve/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

// --- forkBroker: a daemon that dies before its record is a NAMED failure, not a 30s timeout -----------
//
// 2026-09-10: the pinned Claude binary directory had been swept under the running server, so every new
// daemon died in under a second with "Claude executable is not executable" — written to its own
// diagnostics log — and the operator saw only "did not become ready" after the full deadline.

/** A scratch daemon entry. The script reads FRIZZ_CLAUDE_BROKER like the real one and does `body`. */
function scratchDaemon(dir: string, name: string, body: string): string {
  const entry = join(dir, `${name}.mjs`)
  writeFileSync(entry, [
    'import { appendFileSync, writeFileSync } from "node:fs"',
    "const config = JSON.parse(process.env.FRIZZ_CLAUDE_BROKER)",
    body,
    "",
  ].join("\n"))
  return entry
}

function forkOptions(dir: string, daemonEntry: string) {
  return { stateDir: dir, cwd: dir, sessionId: "11111111-2222-4333-8444-555555555555", executablePath: process.execPath, env: {}, daemonEntry, timeoutMs: 30_000 }
}

test("forkBroker: a daemon that dies with an exit record rejects at once and quotes the cause", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-broker-fork-"))
  try {
    const entry = scratchDaemon(dir, "dies", [
      'appendFileSync(config.diagnosticLogPath, JSON.stringify({ at: new Date().toISOString(), daemonPid: process.pid, generation: config.generation, exit: { reason: "uncaught-exception", detail: "Claude executable is not executable" } }) + "\\n")',
      "process.exit(1)",
    ].join("\n"))
    const started = Date.now()
    await assert.rejects(forkBroker(forkOptions(dir, entry)), (error: Error) => {
      assert.match(error.message, /exited before it became ready/u)
      assert.match(error.message, /exit code 1/u)
      assert.match(error.message, /Claude executable is not executable/u)
      return true
    })
    assert.ok(Date.now() - started < 5_000, "rejected on the exit event, not at the 30s deadline")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("forkBroker: a daemon that exits without writing anything still fails fast, and says the record is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-broker-fork-"))
  try {
    const entry = scratchDaemon(dir, "silent", "process.exit(0)")
    const started = Date.now()
    await assert.rejects(forkBroker(forkOptions(dir, entry)), (error: Error) => {
      assert.match(error.message, /exited before it became ready \(exit code 0\)/u)
      assert.match(error.message, /left no exit record/u)
      return true
    })
    assert.ok(Date.now() - started < 5_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("forkBroker: control — a daemon that publishes its record and stays up resolves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-broker-fork-"))
  let daemonPid: number | undefined
  try {
    const entry = scratchDaemon(dir, "lives", [
      "writeFileSync(config.recordPath, JSON.stringify({ daemonPid: process.pid, socketPath: config.socketPath, sessionId: config.sessionId, generation: config.generation, createdAt: new Date().toISOString() }))",
      "setInterval(() => {}, 1000)",
    ].join("\n"))
    const record = await forkBroker(forkOptions(dir, entry))
    daemonPid = record.daemonPid
    assert.equal(record.generation.length, 36)
    assert.ok(daemonPid > 0)
  } finally {
    if (daemonPid) { try { process.kill(daemonPid, "SIGKILL") } catch {} }
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- forkBroker: a live daemon's ChildProcess must not keep the fork's options alive -----------------------
//
// The `exit` listener lives on the ChildProcess, which lives as long as the detached daemon does. When
// its closure reached `options`, every live worker kept its whole system prompt (~160 KB) on the
// server's heap for the life of the thread: 5 MB across 32 daemons (heap snapshot, 2026-11-09).

test("forkBroker: once the daemon is up, nothing the fork left behind holds its options", async () => {
  const v8 = await import("node:v8")
  const vm = await import("node:vm")
  v8.setFlagsFromString("--expose-gc")
  const gc = vm.runInNewContext("gc") as () => void
  const dir = mkdtempSync(join(tmpdir(), "frizz-broker-fork-"))
  let daemonPid: number | undefined
  try {
    const entry = scratchDaemon(dir, "lives", [
      "writeFileSync(config.recordPath, JSON.stringify({ daemonPid: process.pid, socketPath: config.socketPath, sessionId: config.sessionId, generation: config.generation, createdAt: new Date().toISOString() }))",
      "setInterval(() => {}, 1000)",
    ].join("\n"))
    let options: ReturnType<typeof forkOptions> & { appendSystemPrompt?: string } | undefined = { ...forkOptions(dir, entry), appendSystemPrompt: "a worker contract ".repeat(64) }
    const held = new WeakRef(options)
    daemonPid = (await forkBroker(options)).daemonPid
    options = undefined
    // A WeakRef target survives until the job that created the ref ends, so collect on a later turn.
    for (let i = 0; i < 5 && held.deref(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      gc()
    }
    assert.equal(held.deref(), undefined, "the live daemon's ChildProcess still reaches the fork options")
  } finally {
    if (daemonPid) { try { process.kill(daemonPid, "SIGKILL") } catch {} }
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- killBroker: the daemon TREE ends on Windows, one signal on POSIX -----------------------------------

test("killBroker: win32 routes through taskkill /T /F and drops the record; posix signals the daemon", (t) => {
  // Windows audit 2026-09-11, finding 5: process.kill(pid, "SIGTERM") on win32 is TerminateProcess of
  // the daemon alone, and claude.exe under it kept running its turn.
  const dir = mkdtempSync(join(tmpdir(), "frizz-kill-broker-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sessionId = "11111111-2222-4333-8444-555555555555"
  const recordPath = claudeBrokerRecordPath(dir, sessionId)
  const publish = () => {
    mkdirSync(join(recordPath, ".."), { recursive: true })
    // This process stands in for the daemon: liveBrokerRecord only keeps a record whose pid is alive.
    writeFileSync(recordPath, JSON.stringify({ daemonPid: process.pid, socketPath: join(dir, "s"), sessionId, generation: "g1", createdAt: new Date().toISOString() }))
  }
  const kills: Array<[number, NodeJS.Signals]> = []
  const spawns: string[][] = []
  const deps = {
    kill: (pid: number, signal: NodeJS.Signals) => { kills.push([pid, signal]) },
    spawnSync: (file: string, args: string[]) => { spawns.push([file, ...args]); return { status: 0 } },
  }

  publish()
  assert.equal(killBroker(dir, sessionId, undefined, { ...deps, platform: "win32" }), true)
  assert.deepEqual(spawns, [["taskkill", "/PID", String(process.pid), "/T", "/F"]])
  assert.deepEqual(kills, [], "the tree kill replaced the signal; nothing else was sent")
  assert.equal(existsSync(recordPath), false, "the record is dropped")

  publish()
  assert.equal(killBroker(dir, sessionId, "retire", { ...deps, platform: "linux" }), true)
  assert.deepEqual(kills, [[process.pid, "SIGTERM"]])
  assert.equal(spawns.length, 1, "posix never runs taskkill")

  // Nothing to stop: no record, no kill, and the verdict says so.
  assert.equal(killBroker(dir, sessionId, undefined, { ...deps, platform: "win32" }), false)
  assert.equal(spawns.length, 1)
  assert.equal(kills.length, 1)
})

// --- brokerLivenessSnapshot: the board's per-build liveness, one listing instead of a read per row ------

test("brokerLivenessSnapshot answers exactly what liveBrokerRecord answers, row for row", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-liveness-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const record = (sessionId: string, daemonPid: number) => {
    const path = claudeBrokerRecordPath(dir, sessionId)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, JSON.stringify({ daemonPid, socketPath: join(dir, "s"), sessionId, generation: "g1", createdAt: new Date().toISOString() }))
    return path
  }
  const live = "aaaaaaaa-0000-4000-8000-000000000001"
  const dead = "aaaaaaaa-0000-4000-8000-000000000002"
  const absent = "aaaaaaaa-0000-4000-8000-000000000003"
  assert.equal(brokerLivenessSnapshot(dir)(live), false, "no record directory at all: nothing is alive")

  record(live, process.pid) // this process stands in for a running daemon
  const deadPath = record(dead, 2 ** 22 + 12345) // no such pid
  const alive = brokerLivenessSnapshot(dir)
  assert.equal(alive(live), true)
  assert.equal(alive(dead), false)
  assert.equal(existsSync(deadPath), false, "a dead daemon's record is pruned, exactly as liveBrokerRecord prunes it")
  assert.equal(alive(absent), false)
  for (const id of [live, dead, absent]) assert.equal(alive(id), liveBrokerRecord(claudeBrokerRecordPath(dir, id)) !== null, id)
})

test("brokerLivenessSnapshot sees a record created after its listing was cached", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-liveness-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const records = join(dir, "claude-broker")
  mkdirSync(records, { recursive: true })
  // An old directory: the listing taken now is TRUSTED and kept across builds.
  const old = new Date(Date.now() - 60_000)
  utimesSync(records, old, old)
  const sessionId = "bbbbbbbb-0000-4000-8000-000000000001"
  assert.equal(brokerLivenessSnapshot(dir)(sessionId), false)
  assert.equal(brokerLivenessSnapshot(dir)(sessionId), false, "served from the cached listing")

  // A daemon starts and writes its record: creating an entry moves the directory's mtime, which is what
  // retires the cached listing.
  writeFileSync(claudeBrokerRecordPath(dir, sessionId), JSON.stringify({ daemonPid: process.pid, socketPath: join(dir, "s"), sessionId, generation: "g1", createdAt: new Date().toISOString() }))
  assert.equal(brokerLivenessSnapshot(dir)(sessionId), true, "the new record is seen on the very next build")

  // NEGATIVE CONTROL: the same creation with the directory's mtime forced back to the cached value is
  // invisible — proof the listing really is cached, so the assertion above tested the invalidation.
  const other = "bbbbbbbb-0000-4000-8000-000000000002"
  utimesSync(records, old, old)
  assert.equal(brokerLivenessSnapshot(dir)(other), false) // re-list and trust at the old mtime
  writeFileSync(claudeBrokerRecordPath(dir, other), JSON.stringify({ daemonPid: process.pid, socketPath: join(dir, "s"), sessionId: other, generation: "g1", createdAt: new Date().toISOString() }))
  utimesSync(records, old, old)
  assert.equal(brokerLivenessSnapshot(dir)(other), false, "an unchanged mtime serves the cached listing")
})

// The board asks whether every open broker thread's daemon is alive on every build. The record names the
// same pid for as long as the file is the one that was read, so only the pid is asked again; a record
// rewritten for a new daemon, or one whose daemon died, is read and pruned exactly as before.
test("brokerLivenessSnapshot reads a record once per version of the file, and still sees it change", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-broker-pid-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, "claude-broker"), { recursive: true })
  const sessionId = "cccccccc-0000-4000-8000-000000000001"
  const path = claudeBrokerRecordPath(dir, sessionId)
  const record = (pid: number) => JSON.stringify({ daemonPid: pid, socketPath: join(dir, "s"), sessionId, generation: `g${pid}`, createdAt: new Date().toISOString() })
  writeFileSync(path, record(process.pid))
  assert.equal(brokerLivenessSnapshot(dir)(sessionId), true)

  // Unreadable now, unchanged otherwise: an answer that still comes back alive never opened the file.
  chmodSync(path, 0o000)
  try {
    assert.equal(brokerLivenessSnapshot(dir)(sessionId), true, "the same file: its pid, remembered")
  } finally { chmodSync(path, 0o600) }

  // The record rewritten in place for a daemon that is not running: read again, found dead, pruned.
  const dead = spawnSync(process.execPath, ["-e", ""]).pid
  writeFileSync(path, record(dead))
  assert.equal(brokerLivenessSnapshot(dir)(sessionId), false, "a rewritten record is read again")
  assert.equal(existsSync(path), false, "and a dead daemon's record is pruned, as liveBrokerRecord does")
})
