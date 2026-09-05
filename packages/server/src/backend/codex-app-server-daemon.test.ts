// The daemon exists for ONE reason: a codex turn must survive the frizz runtime being recycled by
// Update & Restart. These drive the REAL daemon process over its REAL socket, standing in a scripted
// fake for `codex app-server` so the protocol edges (handshake caching, id rewriting, queue-while-
// detached) can be asserted deterministically. The end-to-end proof against the real app-server lives
// in _live_appserver_restart_repro.mts.
import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import {
  codexAppServerDaemonRecordPath,
  codexAppServerSocketPath,
  daemonCodexAppServerHost,
  killCodexAppServerDaemon,
  liveDaemonRecord,
  readDaemonRecord,
} from "./codex-app-server-host.ts"
import {
  CLIENT_CAPABILITIES,
  CLIENT_INFO,
  CODEX_APP_SERVER_SUPPORTED_VERSION,
  CodexAppServerBridge,
} from "./codex-app-server.ts"
import { codexAppServerArgv } from "./codex-mcp.ts"
import { captureLogRecords } from "../logging.ts"

// How a scripted fake gets to BE `codex` for these tests, on every platform.
//
// It used to be an extensionless `#!/usr/bin/env node` file handed over as `codexBin`. Windows has no
// shebang: `spawn()` there reaches CreateProcess, which can only start a real PE, so every one of
// these tests died on `spawn …\fake-codex ENOENT` (Windows suite, 2026-08-24) and the six that then
// tore down the failed fallback child died on `kill EINVAL` behind it. A `.cmd` shim is no escape —
// node has refused to spawn `.bat`/`.cmd` without `shell: true` since CVE-2024-27980, and the
// production spawn has no shell — so the fixture has to be started by an interpreter that is itself a
// real executable.
//
// So `codexBin` is node, and the script is written at the path production's FIRST argument already
// names: `codexAppServerArgv()` opens with codex's `app-server` subcommand, and every host here
// spawns with `cwd` = the harness dir, so `node app-server -c … --stdio` runs <dir>/app-server with
// the remaining argv untouched. The name is derived rather than typed, so if the subcommand ever
// moves the fixture moves with it. One shape on all three platforms — POSIX runs the very path
// Windows runs, instead of a `win32` branch nobody here can execute.
const FAKE_BIN = process.execPath
const FAKE_SCRIPT_NAME = codexAppServerArgv([])[0]

// A stand-in for `codex app-server --stdio`: answers `initialize`, echoes a marker for `ping`, and
// can be told to emit an unsolicited notification after a delay (the "a turn completed while nobody
// was attached" case).
const FAKE_APP_SERVER = `let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  for (;;) {
    const i = buf.indexOf("\\n")
    if (i < 0) break
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: m.id, result: { userAgent: "frizz/0.144.6 (test)" } }) + "\\n")
    } else if (m.method === "ping") {
      process.stdout.write(JSON.stringify({ id: m.id, result: { sawId: m.id, echo: m.params && m.params.echo } }) + "\\n")
    } else if (m.method === "flood") {
      // Emit far more than the daemon's detached queue can hold, so the overflow it reports in
      // \`hello\` is a real one rather than a number a test invented.
      setTimeout(() => {
        for (let i = 0; i < m.params.count; i++) {
          process.stdout.write(JSON.stringify({ method: "turn/delta", params: { i } }) + "\\n")
        }
      }, m.params.afterMs)
      process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + "\\n")
    } else if (m.method === "oversizedLater") {
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ method: "item/completed", params: { text: "x".repeat(9 * 1024 * 1024) } }) + "\\n")
        process.stdout.write(JSON.stringify({ method: "turn/completed", params: { marker: "after-oversized" } }) + "\\n")
      }, 100)
      process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + "\\n")
    } else if (m.method === "emitLater") {
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ method: "turn/completed", params: { marker: m.params.marker } }) + "\\n")
      }, m.params.afterMs)
      process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + "\\n")
    }
  }
})
process.stdin.resume()
`

/** Writes the scripted app-server where `node <cwd>/app-server` will find it, and answers with the
 *  `codexBin` production should then be pointed at — node itself. See FAKE_BIN above. */
function fakeAppServerBin(dir: string): string {
  writeFileSync(join(dir, FAKE_SCRIPT_NAME), FAKE_APP_SERVER)
  return FAKE_BIN
}

interface Harness {
  stateDir: string
  codexBin: string
}

function harness(): Harness {
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-codex-daemon-test-"))
  return { stateDir, codexBin: fakeAppServerBin(stateDir) }
}

const PROJECT = "proj"

function options(h: Harness) {
  return {
    projectId: PROJECT,
    stateDir: h.stateDir,
    cwd: h.stateDir,
    codexBin: h.codexBin,
    env: process.env,
    clientInfo: CLIENT_INFO as unknown as Record<string, unknown>,
    capabilities: CLIENT_CAPABILITIES as unknown as Record<string, unknown>,
    timeoutMs: 15_000,
    authAccountId: "account-one",
  }
}

/** Minimal JSON-RPC client over a `CodexAppServerProcess`, mirroring what the bridge does. */
function client(process_: { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream }) {
  const pending = new Map<number, (value: Record<string, unknown>) => void>()
  const notifications: Record<string, unknown>[] = []
  let next = 1
  let buf = ""
  process_.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8")
    for (;;) {
      const i = buf.indexOf("\n")
      if (i < 0) break
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line) as Record<string, unknown>
      if (typeof message.id === "number" && pending.has(message.id)) {
        pending.get(message.id)!(message)
        pending.delete(message.id)
      } else notifications.push(message)
    }
  })
  return {
    notifications,
    request(method: string, params?: unknown): Promise<Record<string, unknown>> {
      const id = next++
      const done = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve))
      process_.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      return done
    },
    /** The id THIS client will use next — the thing that collides after a restart without rewriting. */
    peekNextId: () => next,
  }
}

test("codex daemon: the app-server survives a client detaching, and the next client rejoins the SAME process", async () => {
  const h = harness()
  try {
    const first = await daemonCodexAppServerHost(options(h))
    assert.equal(first.reattached, false, "the first attachment forks the daemon")
    const record = liveDaemonRecord(h.stateDir, PROJECT)
    assert.ok(record, "the daemon published a record")
    assert.equal(record!.authAccountId, "account-one", "the record pins the account loaded at process start")
    assert.equal(first.authAccountId, "account-one")
    const childPid = record!.childPid

    // Detach exactly the way the bridge does when the frizz runtime is recycled.
    first.process.kill()
    await delay(300)

    assert.equal(liveDaemonRecord(h.stateDir, PROJECT)?.daemonPid, record!.daemonPid, "the daemon outlived its client")

    const second = await daemonCodexAppServerHost(options(h))
    assert.equal(second.reattached, true, "the next frizz generation reattaches rather than forking")
    assert.equal(second.generation, first.generation, "same generation == the same app-server process")
    assert.equal(second.authAccountId, "account-one", "a reattach reports the process's original account")
    assert.equal(liveDaemonRecord(h.stateDir, PROJECT)?.childPid, childPid, "and it is literally the same child")
    second.process.kill()
  } finally {
    killCodexAppServerDaemon(h.stateDir, PROJECT)
  }
})

test("codex daemon: `initialize` from a reattaching client is served from cache, never re-sent", async () => {
  const h = harness()
  try {
    const first = await daemonCodexAppServerHost(options(h))
    const c1 = client(first.process)
    const init1 = await c1.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CLIENT_CAPABILITIES })
    assert.deepEqual(init1.result, { userAgent: "frizz/0.144.6 (test)" })
    first.process.kill()
    await delay(200)

    // The fake app-server answers `initialize` only once per process; a second real one would have to
    // come from the daemon's cache, and the version gate downstream depends on it being the REAL
    // userAgent rather than something invented.
    const second = await daemonCodexAppServerHost(options(h))
    const c2 = client(second.process)
    const init2 = await c2.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CLIENT_CAPABILITIES })
    assert.deepEqual(init2.result, { userAgent: "frizz/0.144.6 (test)" }, "reattach still gets the real handshake")
    second.process.kill()
  } finally {
    killCodexAppServerDaemon(h.stateDir, PROJECT)
  }
})

test("codex daemon: a restarted client restarting its id counter at 1 never collides with the dead one", async () => {
  const h = harness()
  try {
    const first = await daemonCodexAppServerHost(options(h))
    const c1 = client(first.process)
    await c1.request("initialize", {})
    const a = await c1.request("ping", { echo: "first-client" })
    first.process.kill()
    await delay(200)

    const second = await daemonCodexAppServerHost(options(h))
    const c2 = client(second.process)
    await c2.request("initialize", {})
    assert.equal(c2.peekNextId(), 2, "the fresh client really did restart its counter")
    const b = await c2.request("ping", { echo: "second-client" })

    // Both clients used low ids; the daemon must have rewritten them into distinct server-side ids,
    // and must have mapped each response back to the id its own client asked with.
    assert.equal((b.result as { echo: string }).echo, "second-client", "the response reached the right client")
    assert.notEqual(
      (a.result as { sawId: number }).sawId,
      (b.result as { sawId: number }).sawId,
      "the app-server saw two DIFFERENT ids even though both clients used their own id 2",
    )
    second.process.kill()
  } finally {
    killCodexAppServerDaemon(h.stateDir, PROJECT)
  }
})

test("codex daemon: a notification emitted while nobody is attached is queued, not lost", async () => {
  const h = harness()
  try {
    const first = await daemonCodexAppServerHost(options(h))
    const c1 = client(first.process)
    await c1.request("initialize", {})
    // Schedule the notification for AFTER we detach — this is `turn/completed` arriving during the
    // restart window, the event whose loss would wedge `current_turn_id` forever.
    await c1.request("emitLater", { marker: "survived", afterMs: 600 })
    first.process.kill()
    await delay(1200)

    const second = await daemonCodexAppServerHost(options(h))
    const c2 = client(second.process)
    await delay(300)
    const replayed = c2.notifications.find((n) => n.method === "turn/completed")
    assert.ok(replayed, "the notification emitted while detached was replayed on reattach")
    assert.deepEqual(replayed!.params, { marker: "survived" })
    second.process.kill()
  } finally {
    killCodexAppServerDaemon(h.stateDir, PROJECT)
  }
})

test("codex daemon: an oversized provider record reports loss without killing the worker or losing the next line", async () => {
  const h = harness()
  try {
    const first = await daemonCodexAppServerHost(options(h))
    const c1 = client(first.process)
    await c1.request("initialize", {})
    const exited = new Promise<void>(resolve => first.process.on("exit", () => resolve()))
    await c1.request("oversizedLater")
    await Promise.race([exited, delay(5000).then(() => { throw new Error("oversized record did not detach") })])
    const second = await daemonCodexAppServerHost(options(h))
    const c2 = client(second.process)
    await delay(300)
    assert.equal(second.generation, first.generation, "worker survives the lost record")
    assert.equal(second.droppedWhileDetached, 1, "one oversized record is one reported loss")
    assert.ok(c2.notifications.some(n => n.method === "turn/completed"), "the following lifecycle record is preserved")
    const reply = await c2.request("ping", { echo: "still-running" })
    assert.equal((reply.result as { echo: string }).echo, "still-running")
    second.process.kill()
  } finally { killCodexAppServerDaemon(h.stateDir, PROJECT) }
})

test("codex daemon: killing the daemon tears down the app-server and prunes the record", async () => {
  const h = harness()
  const attachment = await daemonCodexAppServerHost(options(h))
  const record = liveDaemonRecord(h.stateDir, PROJECT)!
  attachment.process.kill()
  killCodexAppServerDaemon(h.stateDir, PROJECT)
  for (let i = 0; i < 40 && liveDaemonRecord(h.stateDir, PROJECT); i++) await delay(50)
  assert.equal(liveDaemonRecord(h.stateDir, PROJECT), null, "the record is gone once the daemon exits")
  await delay(200)
  assert.throws(() => process.kill(record.childPid, 0), "the app-server child went with it")
  if (process.platform !== "win32") {
    assert.equal(existsSync(codexAppServerSocketPath(h.stateDir, PROJECT)), false, "and the socket is unlinked")
  }
})

// The daemon buys ONE property — an in-flight turn surviving Update & Restart. Codex itself predates
// it and does not need it. So a daemon that cannot start must degrade to the historical in-process
// app-server, never take Codex down: one packaging slip doing exactly that killed every dispatch,
// follow-up, steer and interrupt at once (2026-07-23). The fallback is the safety net for the class,
// so it gets its own proof rather than being trusted because it looks obvious.
test("codex daemon: a daemon that cannot start falls back to an in-process app-server", async () => {
  const h = harness()
  // The fallback announces itself through the run log rather than the console now; assert against
  // the channel that actually carries it.
  const captured = captureLogRecords()
  try {
    const attachment = await daemonCodexAppServerHost({
      ...options(h),
      // A daemon entry that is not there — precisely the promoted-artifact failure.
      daemonEntry: join(h.stateDir, "does-not-exist-daemon.js"),
    })
    try {
      assert.equal(liveDaemonRecord(h.stateDir, PROJECT), null, "no daemon record: this is the fallback, not a daemon")
      assert.equal(attachment.daemonPid, process.pid, "the app-server is a child of THIS runtime")
      assert.equal(attachment.reattached, false)
      // The whole point: it must be a WORKING app-server, not merely a returned object.
      const c = client(attachment.process)
      const initialized = await c.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CLIENT_CAPABILITIES })
      assert.ok((initialized.result as { userAgent?: string })?.userAgent, "the fallback app-server answers initialize")
      const echoed = await c.request("ping", { echo: "fallback" })
      assert.equal((echoed.result as { echo?: string })?.echo, "fallback", "and serves ordinary requests")
      // Degrading silently would be its own trap — the operator loses restart survival and must be told.
      assert.ok(
        captured.messages().some((line) => /falling back to an in-process app-server/.test(line)),
        `the degradation is announced, not silent — saw ${JSON.stringify(captured.messages())}`,
      )
    } finally {
      attachment.process.kill()
    }
  } finally {
    captured.restore()
    killCodexAppServerDaemon(h.stateDir, PROJECT)
  }
})

// ---- lifecycle ownership --------------------------------------------------------------------------
// frizz adopted a long-lived process without adopting the work that goes with one: for a while
// `killCodexAppServerDaemon` had ZERO production callers, so nothing in frizz ever ended a daemon's
// life. These drive the REAL daemon (and, for the version gate, the REAL bridge) through the two ways
// a daemon has to be able to die.

/** Like FAKE_APP_SERVER, but reports whatever version its sibling `codex-version` file held AT BOOT —
 *  which is exactly how a real `codex` binary behaves when it is upgraded on disk. */
const VERSIONED_FAKE_APP_SERVER = `// Read from a sibling file at BOOT, not from the environment: the bridge hands the app-server only
// its audited env allowlist, so an env-carried seam would silently vanish on the bridge's own path.
const path = require("node:path")
const version = require("node:fs").readFileSync(path.join(path.dirname(process.argv[1]), "codex-version"), "utf8").trim()
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  for (;;) {
    const i = buf.indexOf("\\n"); if (i < 0) break
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: m.id, result: {
        userAgent: "frizz/" + version + " (test)",
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      } }) + "\\n")
    } else if (m.method === "thread/start" || m.method === "thread/resume") {
      process.stdout.write(JSON.stringify({ id: m.id, result: { thread: { id: "codex-thread-1", sessionId: "codex-session-1", ephemeral: !!(m.params && m.params.ephemeral) } } }) + "\\n")
    } else if (m.id !== undefined) {
      process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + "\\n")
    }
  }
})
process.stdin.resume()
`

function versionedHarness(initialVersion: string) {
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-codex-skew-test-"))
  writeFileSync(join(stateDir, FAKE_SCRIPT_NAME), VERSIONED_FAKE_APP_SERVER)
  const codexBin = FAKE_BIN
  const versionFile = join(stateDir, "codex-version")
  writeFileSync(versionFile, initialVersion)
  return {
    stateDir,
    codexBin,
    versionFile,
    setInstalledVersion(version: string) { writeFileSync(versionFile, version) },
    hostOptions() {
      return options({ stateDir, codexBin })
    },
  }
}

function skewBridge(h: ReturnType<typeof versionedHarness>, diagnostics: unknown[]) {
  const db = new Database(join(h.stateDir, "ui.db"))
  db.pragma("journal_mode = WAL")
  const interactions = createInteractionStore(db)
  const bridge = new CodexAppServerBridge({
    projectId: PROJECT,
    projectDir: h.stateDir,
    stateDir: h.stateDir,
    db,
    interactions,
    codexBin: h.codexBin,
    requestTimeoutMs: 10_000,
    // These tests are specifically the DAEMON's cached-handshake wedge; native is now the default
    // transport, so pin the daemon host explicitly rather than inheriting the flip.
    host: daemonCodexAppServerHost,
    diagnostic: (event) => diagnostics.push(event),
  })
  return { bridge, dispose() { bridge.close(); interactions.dispose(); db.close() } }
}

// THE version-skew wedge, end to end against a real daemon and a real bridge.
//
// The daemon performs `initialize` ONCE and caches the result for its whole life. So the ordinary
// upgrade path — bump CODEX_APP_SERVER_SUPPORTED_VERSION, Update & Restart — leaves a surviving
// daemon serving the OLD userAgent to every new frizz generation. The bridge's version gate then
// rejects every single connect, forever: the daemon re-arms its 6h idle timer on each client drop, so
// a frizz that keeps retrying keeps the wedged daemon alive indefinitely, and the symptom is
// indistinguishable from Codex being completely down.
//
// Modelled by holding the SUPPORTED constant fixed (it is a constant) and moving the installed
// binary: a daemon booted against an OLD codex, then codex upgraded on disk to the supported version.
test("codex daemon: a daemon caching a stale handshake is reforked, not left to wedge every connect", async () => {
  const h = versionedHarness("0.140.0")
  const diagnostics: unknown[] = []
  let bridge: ReturnType<typeof skewBridge> | undefined
  try {
    // A daemon from BEFORE the upgrade, with 0.140.0 cached in its handshake forever.
    const stale = await daemonCodexAppServerHost(h.hostOptions())
    const staleGeneration = stale.generation
    stale.process.kill()
    await delay(200)
    assert.equal(liveDaemonRecord(h.stateDir, PROJECT)?.generation, staleGeneration, "the stale daemon outlived its client")

    // codex is upgraded on disk to the version this frizz supports. The daemon does not notice: it
    // will answer `initialize` from its cache with 0.140.0 until something ends its life.
    h.setInstalledVersion(CODEX_APP_SERVER_SUPPORTED_VERSION)

    bridge = skewBridge(h, diagnostics)
    const binding = await bridge.bridge.startDisposableSession({
      threadSlug: "post-upgrade", sessionId: "post-upgrade-session", cwd: h.stateDir,
    })
    assert.ok(binding, "the bridge recovered and actually opened a thread")

    assert.ok(
      diagnostics.some((event) => (event as { event?: string }).event === "version-rejected"),
      "the stale cached handshake really was rejected first",
    )
    assert.ok(
      diagnostics.some((event) => (event as { event?: string }).event === "daemon-reforked"),
      `the recovery is the refork, and it is announced — saw ${JSON.stringify(diagnostics)}`,
    )
    assert.ok(
      diagnostics.some((event) => (event as { event?: string; version?: string }).event === "connected"
        && (event as { version?: string }).version === CODEX_APP_SERVER_SUPPORTED_VERSION),
      "and the fresh daemon reports the version actually installed",
    )
    const after = liveDaemonRecord(h.stateDir, PROJECT)
    assert.ok(after, "a replacement daemon is running")
    assert.notEqual(after!.generation, staleGeneration, "it is a NEW app-server process, not the wedged one")
  } finally {
    bridge?.dispose()
    killCodexAppServerDaemon(h.stateDir, PROJECT)
  }
})

// The other half, and the one that decides whether the recovery is safe to ship: a codex that is
// GENUINELY unsupported must still fail LOUDLY. Once a freshly forked daemon has reported a version
// we reject, there is no stale cache left to blame, so reforking again would only be a machine for
// killing daemons — reject, refork, reject, forever, one dead app-server per attempt.
test("codex daemon: a genuinely unsupported codex fails loudly and is never reforked in a loop", async () => {
  const h = versionedHarness("0.1.0")
  const diagnostics: unknown[] = []
  let bridge: ReturnType<typeof skewBridge> | undefined
  try {
    const stale = await daemonCodexAppServerHost(h.hostOptions())
    stale.process.kill()
    await delay(200)

    bridge = skewBridge(h, diagnostics)
    for (const attempt of [1, 2, 3]) {
      await assert.rejects(
        bridge.bridge.startDisposableSession({
          threadSlug: `bad-${attempt}`, sessionId: `bad-${attempt}-session`, cwd: h.stateDir,
        }),
        // 0.1.0 is BELOW the audited protocol, so it is still refused — only the wording changed when
        // the gate became a floor+ceiling instead of exact equality (a NEWER codex now runs with a
        // warning rather than taking Codex out entirely).
        /older than the audited protocol/,
        `attempt ${attempt} fails loudly`,
      )
    }
    const reforks = diagnostics.filter((event) => (event as { event?: string }).event === "daemon-reforked")
    assert.equal(reforks.length, 1, `exactly one refork is spent proving the cache was not the problem — saw ${reforks.length}`)
    assert.ok(
      diagnostics.filter((event) => (event as { event?: string }).event === "version-rejected").length >= 3,
      "and every attempt still reports the rejection",
    )
  } finally {
    bridge?.dispose()
    killCodexAppServerDaemon(h.stateDir, PROJECT)
  }
})

/** Wait for a pid to be gone, or fail. Never a bare sleep: the point of these tests is the BOUND. */
async function waitForExit(pid: number, withinMs: number, what: string): Promise<void> {
  const deadline = Date.now() + withinMs
  for (;;) {
    try { process.kill(pid, 0) } catch { return }
    if (Date.now() > deadline) assert.fail(`${what} (pid ${pid}) was still alive after ${withinMs}ms`)
    await delay(25)
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

// A daemon is discoverable ONLY through its record file — daemonCodexAppServerHost reads exactly that
// one path — so a daemon whose record has vanished is unreachable forever and its `codex app-server`
// (~150 MB, and still able to edit the filesystem) is pure waste for the remaining six hours of
// IDLE_EXIT_MS. Nothing else collects these: the orphan reaper keys on FRIZZ_THREAD, which this
// per-PROJECT daemon does not carry, and it explicitly PROTECTS any process named `codex` as a
// session root. Daemons forked from agent worktrees that were later deleted leaked exactly this way,
// in pairs, and had to be reclaimed by hand.
test("codex daemon: a daemon whose record has vanished collects itself, app-server and all", async () => {
  const h = harness()
  const attachment = await daemonCodexAppServerHost({ ...options(h), reachabilityCheckMs: 150 })
  const record = liveDaemonRecord(h.stateDir, PROJECT)!
  try {
    attachment.process.kill() // detach the way a recycled frizz runtime does
    await delay(200)
    assert.ok(alive(record.daemonPid), "still alive while its record stands: this is the restart window")

    // The state dir went away — an agent worktree deleted, a project removed. Nobody can ever find
    // this daemon again.
    unlinkSync(codexAppServerDaemonRecordPath(h.stateDir, PROJECT))

    await waitForExit(record.daemonPid, 5_000, "the unreachable daemon")
    await waitForExit(record.childPid, 5_000, "its app-server child")
    if (process.platform !== "win32") {
      assert.equal(existsSync(codexAppServerSocketPath(h.stateDir, PROJECT)), false, "and it took its socket with it")
    }
  } finally {
    killCodexAppServerDaemon(h.stateDir, PROJECT)
  }
})

// The exact property the daemon exists for, stated as the thing self-collection must NEVER break. An
// Update & Restart leaves the daemon unattached for as long as the new runtime takes to boot, and the
// record sits untouched the whole time — so "nobody is attached" can never on its own be read as
// "abandoned". This runs for many multiples of the check interval to make that specific.
test("codex daemon: merely being unattached is NOT abandonment — the restart window never collects it", async () => {
  const h = harness()
  const first = await daemonCodexAppServerHost({ ...options(h), reachabilityCheckMs: 100 })
  const record = liveDaemonRecord(h.stateDir, PROJECT)!
  try {
    first.process.kill()
    await delay(2_000) // ~20 reachability checks with nobody attached at all

    assert.ok(alive(record.daemonPid), "the daemon survived a long restart window")
    assert.ok(alive(record.childPid), "and so did the app-server holding the in-flight turn")
    const second = await daemonCodexAppServerHost({ ...options(h), reachabilityCheckMs: 100 })
    assert.equal(second.reattached, true, "and the next frizz generation still rejoins it")
    assert.equal(second.generation, record.generation, "the SAME app-server process")
    second.process.kill()
  } finally {
    killCodexAppServerDaemon(h.stateDir, PROJECT)
  }
})

// Record and socket paths are DERIVED from (stateDir, projectId), so a successor daemon owns exactly
// the same two names. A collecting corpse that unlinked them unconditionally would delete the LIVE
// daemon's record and socket on its way out — turning a tidy-up into the very unreachability it
// exists to prevent.
test("codex daemon: a superseded daemon exits without taking its successor's record with it", async () => {
  const h = harness()
  const attachment = await daemonCodexAppServerHost({ ...options(h), reachabilityCheckMs: 150 })
  const record = liveDaemonRecord(h.stateDir, PROJECT)!
  try {
    attachment.process.kill()
    await delay(200)

    // Stand in for a successor that forked and published its own record at the same derived path.
    const successor = { ...record, daemonPid: process.pid, childPid: process.pid, generation: "successor-generation" }
    writeFileSync(codexAppServerDaemonRecordPath(h.stateDir, PROJECT), JSON.stringify(successor))

    await waitForExit(record.daemonPid, 5_000, "the superseded daemon")
    const survivor = readDaemonRecord(h.stateDir, PROJECT)
    assert.equal(survivor?.generation, "successor-generation", "the successor's record is untouched")
    assert.equal(survivor?.daemonPid, process.pid)
  } finally {
    try { unlinkSync(codexAppServerDaemonRecordPath(h.stateDir, PROJECT)) } catch {}
  }
})

// The daemon caps its detached queue and reports the overflow in `hello` — its own words: "mark the
// overflow so the client learns it must not trust the stream". The client used to discard that
// control line without parsing it, so the number was written by every daemon and read by nobody. The
// bridge-side consequence (a lossy rejoin is not a `sameProcess` rejoin) is pinned in
// codex-app-server.test.ts; this is the end of the wire that has to actually produce a number.
test("codex daemon: an overflowing detached queue reports its losses on the next hello", async () => {
  const h = harness()
  try {
    const first = await daemonCodexAppServerHost(options(h))
    const c1 = client(first.process)
    await c1.request("initialize", {})
    // MAX_QUEUED_LINES is 20_000; this comfortably exceeds it once nobody is attached.
    await c1.request("flood", { count: 25_000, afterMs: 400 })
    first.process.kill()
    await delay(2_000)

    const second = await daemonCodexAppServerHost(options(h))
    assert.equal(second.reattached, true)
    assert.ok(
      second.droppedWhileDetached > 0,
      `the daemon told us the stream has holes in it — got ${second.droppedWhileDetached}`,
    )
    second.process.kill()

    // …and a rejoin that lost NOTHING must still report zero, or the bridge would take the cold path
    // on every ordinary restart and resume threads whose turns are alive and well.
    await delay(300)
    const third = await daemonCodexAppServerHost(options(h))
    assert.equal(third.reattached, true)
    assert.equal(third.droppedWhileDetached, 0, "a clean restart window loses nothing and says so")
    third.process.kill()
  } finally {
    killCodexAppServerDaemon(h.stateDir, PROJECT)
  }
})
