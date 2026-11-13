import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startLazyMcpHost, type LazyMcpHost } from "./lazy-mcp-host.ts"
import type { RemoteMcpServer } from "./project-mcp-servers.ts"

// A real stdio MCP server, small enough to read: it appends a line to `started.log` on every start, so
// a test can say exactly when the REAL process ran — the whole contract of the host is that it does not
// run until something needs it. Its tool list is read from `tools.json` at every `tools/list`, so a test
// can change what the server answers without changing its definition (and so its cache key).
const FAKE_SERVER = `
import { appendFileSync, readFileSync } from "node:fs"
const dir = process.argv[2]
appendFileSync(dir + "/started.log", "started\\n")
let buffered = ""
let nextId = 0
const waiting = new Map()
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffered += chunk
  let newline
  while ((newline = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
process.stdin.on("end", () => process.exit(0))
function handle(message) {
  if (message.method === undefined) { waiting.get(message.id)?.(message); return }
  if (message.id === undefined) return
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result })
  switch (message.method) {
    case "initialize": return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake", version: "1" }, instructions: "fake instructions" })
    case "tools/list": return reply({ tools: JSON.parse(readFileSync(dir + "/tools.json", "utf8")) })
    case "tools/call": {
      const name = message.params.name
      if (name === "echo") return reply({ content: [{ type: "text", text: "echo:" + message.params.arguments.text }] })
      if (name === "env") return reply({ content: [{ type: "text", text: process.env.FAKE_MARK + "|" + process.cwd() }] })
      if (name === "die") process.exit(3)
      if (name === "pid") return reply({ content: [{ type: "text", text: String(process.pid) }] })
      if (name === "roots") {
        const id = "server-" + (++nextId)
        waiting.set(id, (answer) => reply({ content: [{ type: "text", text: JSON.stringify(answer.result) }] }))
        return send({ jsonrpc: "2.0", id, method: "roots/list" })
      }
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no tool " + name } })
    }
    default: return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no method " + message.method } })
  }
}
`

interface Fixture { dir: string; cacheDir: string; script: string; starts: () => number; setTools: (names: string[]) => void }

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "lazy-mcp-"))
  const script = join(dir, "fake-server.mjs")
  writeFileSync(script, FAKE_SERVER)
  const setTools = (names: string[]) => writeFileSync(join(dir, "tools.json"), JSON.stringify(names.map((name) => ({ name, inputSchema: { type: "object" } }))))
  setTools(["echo", "env", "die", "roots"])
  const log = join(dir, "started.log")
  return { dir, cacheDir: join(dir, "cache"), script, setTools, starts: () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0 }
}

async function mount(fx: Fixture, extraEnv: Record<string, string> = {}): Promise<{ host: LazyMcpHost; remote: RemoteMcpServer }> {
  const host = await startLazyMcpHost({ cacheDir: fx.cacheDir })
  const mounted = host.mount({ fake: { command: process.execPath, args: [fx.script, fx.dir], env: { FAKE_MARK: "from-definition" } } }, { cwd: fx.dir, env: { PATH: process.env.PATH ?? "", ...extraEnv } })
  return { host, remote: mounted.fake! }
}

let nextId = 0
async function rpc(remote: RemoteMcpServer, method: string, params?: unknown): Promise<{ result?: any; error?: { code: number; message: string } }> {
  const response = await fetch(remote.url, {
    method: "POST",
    headers: { ...remote.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, ...(params === undefined ? {} : { params }) }),
  })
  assert.equal(response.status, 200)
  return await response.json() as { result?: any; error?: { code: number; message: string } }
}

async function notify(remote: RemoteMcpServer, message: object): Promise<number> {
  const response = await fetch(remote.url, { method: "POST", headers: { ...remote.headers, "content-type": "application/json" }, body: JSON.stringify(message) })
  await response.arrayBuffer()
  return response.status
}

/** Open the standalone SSE stream and collect every message the host pushes onto it. */
function openStream(remote: RemoteMcpServer): { messages: any[]; next: (predicate: (m: any) => boolean) => Promise<any>; close: () => void } {
  const controller = new AbortController()
  const messages: any[] = []
  const listeners: Array<() => void> = []
  void (async () => {
    const response = await fetch(remote.url, { headers: { ...remote.headers, accept: "text/event-stream" }, signal: controller.signal })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffered += decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffered.indexOf("\n\n")) >= 0) {
        const event = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2)
        const data = event.split("\n").find((line) => line.startsWith("data: "))
        if (data) { messages.push(JSON.parse(data.slice(6))); for (const listener of listeners.splice(0)) listener() }
      }
    }
  })().catch(() => {})
  const next = (predicate: (m: any) => boolean) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no matching stream message; saw ${JSON.stringify(messages)}`)), 5000)
    const check = () => {
      const found = messages.find(predicate)
      if (found) { clearTimeout(timer); resolve(found) } else listeners.push(check)
    }
    check()
  })
  return { messages, next, close: () => controller.abort() }
}

const INIT = { protocolVersion: "2025-06-18", capabilities: { roots: {} }, clientInfo: { name: "test", version: "1" } }

test("with nothing cached, the handshake starts the real server once, and its answers fill the cache", async () => {
  const fx = fixture()
  const { host, remote } = await mount(fx)
  try {
    const init = await rpc(remote, "initialize", INIT)
    assert.equal(init.result.serverInfo.name, "fake")
    assert.equal(init.result.instructions, "fake instructions")
    assert.equal(fx.starts(), 1, "a configuration never seen before pays the old cost: started at the handshake")
    assert.equal(await notify(remote, { jsonrpc: "2.0", method: "notifications/initialized" }), 202)
    const tools = await rpc(remote, "tools/list")
    assert.deepEqual(tools.result.tools.map((t: { name: string }) => t.name), ["echo", "env", "die", "roots"])
    assert.equal(fx.starts(), 1)
  } finally {
    await host.close()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test("with a cache, the handshake and tools/list start NOTHING; the first tool call starts the real server", async () => {
  const fx = fixture()
  // Claude Code 2.1.289 opens a remote server with a `server/discover` version probe, BEFORE initialize.
  const first = await mount(fx)
  assert.equal((await rpc(first.remote, "server/discover")).error?.code, -32601)
  await rpc(first.remote, "initialize", INIT)
  await rpc(first.remote, "tools/list")
  await first.host.close()
  assert.equal(fx.starts(), 1)

  // A new worker (a new host) on the same definition in the same cwd.
  const { host, remote } = await mount(fx)
  try {
    assert.equal((await rpc(remote, "server/discover")).error?.code, -32601, "the probe's refusal is replayed, so the CLI falls back to initialize")
    const init = await rpc(remote, "initialize", INIT)
    assert.equal(init.result.instructions, "fake instructions", "the cached handshake carries the server's instructions")
    await notify(remote, { jsonrpc: "2.0", method: "notifications/initialized" })
    const tools = await rpc(remote, "tools/list")
    assert.equal(tools.result.tools.length, 4)
    assert.equal((await rpc(remote, "ping")).result !== undefined, true)
    assert.equal(fx.starts(), 1, "nothing about the boot handshake may start the real server")
    assert.deepEqual(host.running(), [])

    const echo = await rpc(remote, "tools/call", { name: "echo", arguments: { text: "hi" } })
    assert.equal(echo.result.content[0].text, "echo:hi")
    assert.equal(fx.starts(), 2, "the first tool call is what starts it")
    assert.deepEqual(host.running(), ["fake"])
    await rpc(remote, "tools/call", { name: "echo", arguments: { text: "again" } })
    assert.equal(fx.starts(), 2, "and it stays up for the next one")
  } finally {
    await host.close()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test("the real server runs with the worker's cwd and env, the definition's env layered on top", async () => {
  const fx = fixture()
  const { host, remote } = await mount(fx, { FAKE_MARK: "from-worker" })
  try {
    await rpc(remote, "initialize", INIT)
    const env = await rpc(remote, "tools/call", { name: "env", arguments: {} })
    const [mark, cwd] = (env.result.content[0].text as string).split("|")
    assert.equal(mark, "from-definition")
    assert.equal(cwd, realpathSync(fx.dir))
  } finally {
    await host.close()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test("a lazily started server whose tools changed corrects the cache and tells the client", async () => {
  const fx = fixture()
  const first = await mount(fx)
  await rpc(first.remote, "initialize", INIT)
  await rpc(first.remote, "tools/list")
  await first.host.close()

  fx.setTools(["echo", "env", "die", "roots", "brand-new"])
  const { host, remote } = await mount(fx)
  const stream = openStream(remote)
  try {
    await rpc(remote, "initialize", INIT)
    assert.equal((await rpc(remote, "tools/list")).result.tools.length, 4, "the stale cache answers until the server runs")
    await rpc(remote, "tools/call", { name: "echo", arguments: { text: "x" } })
    await stream.next((m) => m.method === "notifications/tools/list_changed")
    assert.equal((await rpc(remote, "tools/list")).result.tools.length, 5)
    const third = await mount(fx)
    try {
      await rpc(third.remote, "initialize", INIT)
      assert.equal((await rpc(third.remote, "tools/list")).result.tools.length, 5, "the next worker reads the corrected cache")
      assert.deepEqual(third.host.running(), [])
    } finally {
      await third.host.close()
    }
  } finally {
    stream.close()
    await host.close()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test("a request the SERVER makes reaches the client on the stream, and the client's answer reaches the server", async () => {
  const fx = fixture()
  const { host, remote } = await mount(fx)
  const stream = openStream(remote)
  try {
    await rpc(remote, "initialize", INIT)
    const call = rpc(remote, "tools/call", { name: "roots", arguments: {} })
    const ask = await stream.next((m) => m.method === "roots/list")
    assert.equal(await notify(remote, { jsonrpc: "2.0", id: ask.id, result: { roots: [{ uri: "file:///work" }] } }), 202)
    const answer = await call
    assert.deepEqual(JSON.parse(answer.result.content[0].text), { roots: [{ uri: "file:///work" }] })
  } finally {
    stream.close()
    await host.close()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test("a server that dies fails its call with the reason, and the next call starts a fresh one", async () => {
  const fx = fixture()
  const { host, remote } = await mount(fx)
  try {
    await rpc(remote, "initialize", INIT)
    const died = await rpc(remote, "tools/call", { name: "die", arguments: {} })
    assert.match(died.error!.message, /exited \(code 3\)/)
    assert.deepEqual(host.running(), [])
    const echo = await rpc(remote, "tools/call", { name: "echo", arguments: { text: "back" } })
    assert.equal(echo.result.content[0].text, "echo:back")
    assert.equal(fx.starts(), 2)
  } finally {
    await host.close()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test("a request without this host's token is refused with 403 (never 401, which starts OAuth), and an unknown slot is 404", async () => {
  const fx = fixture()
  const { host, remote } = await mount(fx)
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
    assert.equal((await fetch(remote.url, { method: "POST", body, headers: { "content-type": "application/json" } })).status, 403)
    assert.equal((await fetch(remote.url, { method: "POST", body, headers: { "content-type": "application/json", authorization: "Bearer wrong" } })).status, 403)
    assert.equal((await fetch(remote.url.replace(/\/mcp\/\d+$/, "/mcp/999"), { method: "POST", body, headers: remote.headers })).status, 404)
    assert.match(remote.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/\d+$/)
  } finally {
    await host.close()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test("closing the host stops every real server it started", async () => {
  const fx = fixture()
  const { host, remote } = await mount(fx)
  await rpc(remote, "initialize", INIT)
  const pid = Number((await rpc(remote, "tools/call", { name: "pid", arguments: {} })).result.content[0].text)
  assert.ok(pid > 0)
  process.kill(pid, 0) // alive
  await host.close()
  assert.deepEqual(host.running(), [])
  assert.throws(() => process.kill(pid, 0), "the real server process is gone")
  rmSync(fx.dir, { recursive: true, force: true })
})

test("releasing a mount stops its real server and retires its slot; a URL the host did not mint is ignored", async () => {
  const fx = fixture()
  const { host, remote } = await mount(fx)
  try {
    await rpc(remote, "initialize", INIT)
    const pid = Number((await rpc(remote, "tools/call", { name: "pid", arguments: {} })).result.content[0].text)
    process.kill(pid, 0) // alive
    await host.release([{ type: "http", url: "https://mcp.example.com/mcp" }, remote])
    assert.deepEqual(host.running(), [])
    assert.throws(() => process.kill(pid, 0), "the real server process is gone")
    const after = await fetch(remote.url, { method: "POST", headers: { ...remote.headers, "content-type": "application/json" }, body: "{}" })
    await after.arrayBuffer()
    assert.equal(after.status, 404, "a released slot answers nothing")
  } finally {
    await host.close()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})
