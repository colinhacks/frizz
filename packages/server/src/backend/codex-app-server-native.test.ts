// Seam tests for the native-listener host. These do NOT need the codex binary: they stand a real
// WebSocket server on a real unix socket and drive `nativeListenCodexAppServerHost` at it, which is
// enough to pin the three things that silently break everything if regressed — the upgrade must not
// offer permessage-deflate, the newline-JSON <-> frame translation must be exact in both directions,
// and `kill()` must DETACH rather than terminate.
//
// End-to-end proof that the transport actually carries Codex lives in the artifact harnesses
// (`scripts/verify-artifact-daemon-closure.mjs` and `verify-artifact-restart-survival.mjs`, both run
// with FRIZZ_CODEX_NATIVE_LISTEN=1).
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { WebSocketServer, type WebSocket } from "ws"
import {
  nativeListenCodexAppServerHost,
  nativeRecordPath,
  liveNativeRecord,
} from "./codex-app-server-native.ts"
import { stopCodexAppServerDaemon } from "./codex-app-server-host.ts"
import { frizzIpcPath } from "./ipc-path.ts"

interface Fixture {
  stateDir: string
  projectId: string
  socketPath: string
  http: Server
  wss: WebSocketServer
  connections: WebSocket[]
  upgradeHeaders: Record<string, string | string[] | undefined>[]
  received: string[]
  closes: number
  cleanup: () => void
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "frizz-native-host-"))
  const stateDir = join(root, "state")
  const projectId = randomUUID()
  // Windows has no filesystem sockets — `listen()` on a `.sock` path there fails EACCES — so the
  // fixture's endpoint is a named pipe, exactly as nativeListenSocketPath() derives in production.
  // The POSIX spelling stays a file under `root` so cleanup() still takes it with the directory.
  const socketPath = process.platform === "win32"
    ? frizzIpcPath(`frizz-native-test-${randomUUID().replace(/-/gu, "").slice(0, 16)}`)
    : join(root, "listener.sock")
  mkdirSync(join(stateDir, "codex-app-server-native"), { recursive: true })

  const http = createServer()
  const wss = new WebSocketServer({ server: http, perMessageDeflate: false })
  const state: Pick<Fixture, "connections" | "upgradeHeaders" | "received" | "closes"> = {
    connections: [], upgradeHeaders: [], received: [], closes: 0,
  }
  wss.on("connection", (socket, request) => {
    state.connections.push(socket)
    state.upgradeHeaders.push(request.headers)
    socket.on("message", (data) => state.received.push(data.toString()))
    socket.on("close", () => { state.closes++ })
  })
  await new Promise<void>((resolve) => http.listen(socketPath, resolve))

  // Stand in for a listener this machine already started: a live pid (ours) plus a bound socket is
  // exactly what liveNativeRecord() treats as reattachable.
  writeFileSync(nativeRecordPath(stateDir, projectId), JSON.stringify({
    projectId, generation: "gen-fixture", listenerPid: process.pid, socketPath, createdAt: new Date().toISOString(),
    authAccountId: "account-one",
  }))

  return {
    stateDir, projectId, socketPath, http, wss,
    get connections() { return state.connections },
    get upgradeHeaders() { return state.upgradeHeaders },
    get received() { return state.received },
    get closes() { return state.closes },
    cleanup: () => {
      for (const socket of state.connections) { try { socket.terminate() } catch {} }
      try { wss.close() } catch {}
      try { http.close() } catch {}
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    },
  } as Fixture
}

const hostOptions = (f: Fixture) => ({
  projectId: f.projectId,
  stateDir: f.stateDir,
  cwd: process.cwd(),
  codexBin: "codex-should-never-be-spawned",
  env: {},
  clientInfo: {},
  capabilities: {},
  timeoutMs: 10_000,
  authAccountId: "account-two",
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

test("reattaches to an existing listener without offering permessage-deflate", async () => {
  const f = await fixture()
  try {
    const attachment = await nativeListenCodexAppServerHost(hostOptions(f))
    await settle()
    assert.equal(attachment.reattached, true, "an existing live record must be joined, not replaced")
    assert.equal(attachment.generation, "gen-fixture", "the generation identifies the PROCESS and must survive a reattach")
    assert.equal(attachment.authAccountId, "account-one", "a reattach reports the account the listener originally loaded")
    // A rejoin over this transport is ALWAYS lossy: the app-server drops events while unattached, and
    // subscriptions are per-connection so this brand-new socket is subscribed to nothing yet. Claiming
    // 0 here would let the bridge take the warm path and wait forever on a `turn/completed` it was
    // never going to be sent. See PRESUMED_LOSSY_REJOIN.
    assert.ok(attachment.droppedWhileDetached > 0, "a reattach must never claim to be lossless")
    assert.equal(f.connections.length, 1)
    // The single most brittle detail in this transport: `ws` offers permessage-deflate by default and
    // codex's tungstenite rejects the ENTIRE upgrade over it ("Missing, duplicated or incorrect header
    // sec-websocket-extensions"), which is what made an earlier probe conclude the listener was broken.
    assert.equal(
      f.upgradeHeaders[0]?.["sec-websocket-extensions"],
      undefined,
      "the client must not advertise any websocket extension",
    )
    attachment.process.kill()
  } finally { f.cleanup() }
})

test("translates newline-delimited JSON to one frame per line, in both directions", async () => {
  const f = await fixture()
  try {
    const attachment = await nativeListenCodexAppServerHost(hostOptions(f))
    await settle()

    // Two messages arriving in ONE chunk must leave as TWO frames, and a partial line must be held
    // back until its newline arrives — the bridge writes whenever it likes.
    attachment.process.stdin.write('{"id":1,"method":"initialize"}\n{"method":"initialized"}\n{"id":2,')
    await settle()
    assert.deepEqual(f.received, ['{"id":1,"method":"initialize"}', '{"method":"initialized"}'])
    attachment.process.stdin.write('"method":"thread/start"}\n')
    await settle()
    assert.deepEqual(f.received[2], '{"id":2,"method":"thread/start"}')

    // Server -> client: one frame becomes one newline-terminated line on stdout.
    const lines: string[] = []
    attachment.process.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString()))
    f.connections[0]?.send('{"method":"turn/completed","params":{}}')
    await settle()
    assert.deepEqual(lines, ['{"method":"turn/completed","params":{}}\n'])

    attachment.process.kill()
  } finally { f.cleanup() }
})

test("kill() detaches the attachment and leaves the listener running", async () => {
  const f = await fixture()
  try {
    const attachment = await nativeListenCodexAppServerHost(hostOptions(f))
    await settle()
    let exited = false
    attachment.process.on("exit", () => { exited = true })

    attachment.process.kill()
    await settle()

    assert.equal(f.closes, 1, "the WebSocket must be closed")
    assert.equal(exited, true, "a lost attachment surfaces to the bridge as an exit")
    // The listener is untouched — still bound, still discoverable, still reattachable. This is the
// property the operator explicitly likes: quitting frizz does not stop Codex.
    assert.ok(liveNativeRecord(f.stateDir, f.projectId), "the record must survive a detach")
    const again = await nativeListenCodexAppServerHost(hostOptions(f))
    await settle()
    assert.equal(again.reattached, true)
    assert.equal(f.connections.length, 2, "a second attachment joins the SAME listener")
    again.process.kill()
  } finally { f.cleanup() }
})

// ---- lifecycle ownership ---------------------------------------------------------------------------
// The counterpart to the detach test above: frizz must be able to END a listener it can start, or an
// upgraded codex or a newly selected account can never displace the process holding this project's
// socket. Production teardown is `stopCodexAppServerDaemon` (the bridge's version/auth refork), which
// cannot tell the transports apart — so it is what this drives, not `killNativeListener` directly.

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

test("stopCodexAppServerDaemon ends a native listener and clears its record", async () => {
  const f = await fixture()
  // A REAL process to reap. The fixture's own record points at this test process, which we obviously
  // must not SIGTERM, so re-point it at a child whose only job is to be killable.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  try {
    await new Promise<void>((resolve) => child.once("spawn", resolve))
    const pid = child.pid as number
    writeFileSync(nativeRecordPath(f.stateDir, f.projectId), JSON.stringify({
      projectId: f.projectId, generation: "gen-fixture", listenerPid: pid,
      socketPath: f.socketPath, createdAt: new Date().toISOString(),
    }))
    assert.ok(liveNativeRecord(f.stateDir, f.projectId), "precondition: the listener reads as live")

    await stopCodexAppServerDaemon(f.stateDir, f.projectId, 5_000)

    // Gone for real, not merely signalled: the wait is what stops a replacement listener from being
    // started into the corpse's socket-unlink.
    assert.equal(alive(pid), false, "the listener process must actually be gone when the call returns")
    assert.equal(existsSync(nativeRecordPath(f.stateDir, f.projectId)), false, "the record must be removed")
    assert.equal(liveNativeRecord(f.stateDir, f.projectId), null, "nothing may still be discoverable")
  } finally {
    if (child.pid && alive(child.pid)) { try { process.kill(child.pid, "SIGKILL") } catch {} }
    f.cleanup()
  }
})

test("stopCodexAppServerDaemon is inert for a project with no listener and no daemon", async () => {
  const f = await fixture()
  try {
    rmSync(nativeRecordPath(f.stateDir, f.projectId), { force: true })
    // Must resolve, not throw: the refork path calls this before it knows which transport is in play,
    // and the direct-child / in-process fallbacks own no detached process at all.
    await stopCodexAppServerDaemon(f.stateDir, f.projectId, 1_000)
  } finally { f.cleanup() }
})
