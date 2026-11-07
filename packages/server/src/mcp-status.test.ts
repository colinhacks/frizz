import { test } from "node:test"
import assert from "node:assert/strict"
import { createMcpService, loopbackRedirectPort, type McpServiceDeps } from "./mcp-status.ts"
import { deferRuntime, ensureRuntime, resetDeferredRuntimes } from "./runtime-deferral.ts"
import type { ClaudeMcpProbe } from "./backend/claude-mcp-probe.ts"
import type { ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"
import type { CodexAppServerBridge, CodexMcpOAuthCompleted } from "./backend/codex-app-server.ts"

const AUTH_URL = "https://auth.example/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A61234%2Fcallback&state=s"

function fakeProbe(overrides: Partial<ClaudeMcpProbe> = {}): ClaudeMcpProbe & { released: string[] } {
  const released: string[] = []
  return {
    released,
    status: async () => [{ name: "notion", status: "needs-auth", remote: true }, { name: "chrome", status: "connected", remote: false, tools: 29 }],
    authenticate: async () => ({ authUrl: AUTH_URL, requiresUserAction: true, callbackPort: 61234 }),
    serverStatus: async () => ({ name: "notion", status: "needs-auth", remote: true }),
    release: (name) => { released.push(name) },
    close: async () => {},
    ...overrides,
  }
}

function deps(overrides: Partial<McpServiceDeps> = {}): McpServiceDeps {
  const probe = fakeProbe()
  return {
    getSession: (slug) => slug === "claude-thread"
      ? { backend: "claude", claude_runtime: "broker", session_id: "s1" }
      : slug === "acp-thread"
        ? { backend: "acp", session_id: "s2", model: "acp:gemini@default" }
        : undefined,
    claudeProbe: () => probe,
    claudeSignedIn: async () => true,
    acpAgentLabel: (id) => (id === "gemini" ? "Gemini CLI" : undefined),
    ...overrides,
  }
}

test("a reading comes from the thread's live session, and from the probe when there is none", async () => {
  const live = { mcpServerStatus: async () => [{ name: "frizz", status: "connected" as const }, { name: "notion", status: "connected" as const, tools: 12, remote: true }] }
  const mcp = createMcpService(deps({ claudeBroker: live as unknown as ClaudeAgentBrokerBridge }))
  const fromThread = await mcp.status({ slug: "claude-thread" })
  assert.deepEqual(fromThread.servers, [{ name: "notion", state: "connected", tools: 12, remote: true }], "the thread's own reading, minus Frizz's server")

  const gone = { mcpServerStatus: async () => { throw new Error("This thread's Claude session is not running") } }
  const fallback = createMcpService(deps({ claudeBroker: gone as unknown as ClaudeAgentBrokerBridge }))
  assert.deepEqual((await fallback.status({ slug: "claude-thread" })).servers.map((row) => `${row.name}:${row.state}`), ["notion:needs-auth", "chrome:connected"])
  assert.equal((await fallback.status({ backend: "claude" })).agent, "Claude Code")
})

test("with Claude Code signed out the probe never starts, and the menu is told why rather than sent an error", async () => {
  let started = 0
  const mcp = createMcpService(deps({ claudeSignedIn: async () => false, claudeProbe: () => { started += 1; return fakeProbe() } }))
  // Every prompt box asks on page load, so a machine without a Claude login (every sandbox stack) must get
  // an answer here, not a 500 on each page.
  const reading = await mcp.status({ backend: "claude" })
  assert.deepEqual({ ...reading, note: undefined }, { backend: "claude", agent: "Claude Code", supported: true, servers: [], note: undefined })
  assert.match(reading.note ?? "", /isn’t signed in/)
  const gone = { mcpServerStatus: async () => { throw new Error("This thread's Claude session is not running") } }
  const fromThread = createMcpService(deps({ claudeSignedIn: async () => false, claudeBroker: gone as unknown as ClaudeAgentBrokerBridge, claudeProbe: () => { started += 1; return fakeProbe() } }))
  assert.match((await fromThread.status({ slug: "claude-thread" })).note ?? "", /isn’t signed in/, "a thread with no live session falls back to the same answer")
  // A sign-in is a click, so it still says no.
  await assert.rejects(mcp.signIn({ backend: "claude" }, "notion"), /isn’t signed in/)
  assert.equal(started, 0)
  assert.match((await createMcpService(deps()).status({ backend: "codex" })).note ?? "", /Codex isn’t available/)
})

test("an ACP agent reads as unsupported, named", async () => {
  const mcp = createMcpService(deps())
  assert.deepEqual(await mcp.status({ slug: "acp-thread" }), { backend: "acp", agent: "Gemini CLI", supported: false, servers: [] })
  assert.equal((await mcp.status({ backend: "acp", model: "acp:unknown@x" })).agent, "This agent")
})

test("a Claude sign-in settles when the probe sees the server connect, then reaches the running threads", async () => {
  let connected = false
  const probe = fakeProbe({ serverStatus: async () => ({ name: "notion", status: connected ? "connected" : "needs-auth", remote: true }) })
  const reconnected: string[] = []
  const bridge = { reconnectMcpServerEverywhere: async (name: string) => { reconnected.push(name); return 1 } }
  const mcp = createMcpService(deps({ claudeProbe: () => probe, claudeBroker: bridge as unknown as ClaudeAgentBrokerBridge }))
  const started = await mcp.signIn({ backend: "claude" }, "notion")
  assert.equal(started.authUrl, AUTH_URL)
  assert.equal(mcp.poll(started.attemptId).state, "waiting")
  connected = true
  await new Promise((resolve) => setTimeout(resolve, 1_700))
  assert.equal(mcp.poll(started.attemptId).state, "done")
  assert.deepEqual(reconnected, ["notion"])
  assert.deepEqual(probe.released, ["notion"], "the probe is no longer held open for it")
  await mcp.close()
})

test("the paste box delivers only to this attempt's own loopback port", async () => {
  const delivered: string[] = []
  const fetchImpl = (async (url: URL) => { delivered.push(String(url)); return new Response("ok") }) as unknown as typeof fetch
  const mcp = createMcpService(deps({ fetch: fetchImpl }))
  const { attemptId } = await mcp.signIn({ backend: "claude" }, "notion")
  await assert.rejects(mcp.finish(attemptId, "not a url"), /isn't an address/)
  await assert.rejects(mcp.finish(attemptId, "https://localhost:61234/callback?code=c"), /starts with http:\/\/localhost/)
  await assert.rejects(mcp.finish(attemptId, "http://evil.example:61234/callback?code=c"), /starts with http:\/\/localhost/)
  await assert.rejects(mcp.finish(attemptId, "http://localhost:6379/callback?code=c"), /different sign-in/)
  assert.deepEqual(delivered, [], "nothing was fetched for a refused paste")
  assert.equal((await mcp.finish(attemptId, "http://localhost:61234/callback?code=c&state=s")).state, "waiting")
  assert.deepEqual(delivered, ["http://127.0.0.1:61234/callback?code=c&state=s"])
  await mcp.close()
})

test("a Codex sign-in settles on its completion notification, then reloads the app-server's servers", async () => {
  let listener: ((event: CodexMcpOAuthCompleted) => void) | undefined
  let reloads = 0
  const codex = {
    listMcpServers: async () => [{ name: "frizz", status: "connected" }, { name: "linear", status: "needs-auth", remote: true }],
    startMcpOAuthLogin: async () => ({ authUrl: AUTH_URL, loginId: "login-1" }),
    onMcpOAuthCompleted: (fn: (event: CodexMcpOAuthCompleted) => void) => { listener = fn; return () => { listener = undefined } },
    reloadMcpServers: async () => { reloads += 1 },
  }
  const mcp = createMcpService(deps({ codexAppServer: codex as unknown as CodexAppServerBridge }))
  assert.deepEqual((await mcp.status({ backend: "codex" })).servers, [{ name: "linear", state: "needs-auth", remote: true }])
  const { attemptId } = await mcp.signIn({ backend: "codex" }, "linear")
  listener?.({ name: "linear", loginId: "someone-else", success: true })
  assert.equal(mcp.poll(attemptId).state, "waiting", "another login's completion is not this one's")
  listener?.({ name: "linear", loginId: "login-1", success: true })
  assert.equal(mcp.poll(attemptId).state, "done")
  assert.equal(reloads, 1)
  assert.equal(listener, undefined, "unsubscribed once settled")
})

test("a redirect port is read only off a loopback http redirect", () => {
  assert.equal(loopbackRedirectPort(AUTH_URL), 61234)
  assert.equal(loopbackRedirectPort("https://a.example/authorize?redirect_uri=https%3A%2F%2Fapp.example%2Fcb"), undefined)
  assert.equal(loopbackRedirectPort(undefined), undefined)
})

test("a prompt box on Codex does not fetch a runtime still waiting for its first thread", async (t) => {
  t.after(resetDeferredRuntimes)
  let listed = 0
  const codex = { listMcpServers: async () => { listed++; return [] } }
  const mcp = createMcpService(deps({ codexAppServer: codex as unknown as CodexAppServerBridge }))
  deferRuntime("codex", async () => {})
  const waiting = await mcp.status({ backend: "codex" })
  assert.equal(listed, 0)
  assert.deepEqual(waiting.servers, [])
  assert.match(waiting.note ?? "", /first thread/u)
  await ensureRuntime("codex")
  assert.equal((await mcp.status({ backend: "codex" })).note, undefined)
  assert.equal(listed, 1)
})
