import { test } from "node:test"
import assert from "node:assert/strict"
import { mcpDefinitionKey, planMcpReload } from "./mcp-reload-plan.ts"
import type { RemoteMcpServer } from "./project-mcp-servers.ts"

// A stand-in for the lazy host: every mount mints a fresh URL, as the real one does.
function mounter() {
  let slot = 0
  const calls: string[] = []
  const mount = (name: string): RemoteMcpServer => {
    calls.push(name)
    return { type: "http", url: `http://127.0.0.1:1/mcp/${++slot}`, headers: { Authorization: "Bearer t" } }
  }
  return { mount, calls }
}

test("an untouched server is sent exactly as the session holds it, so the CLI keeps it running", () => {
  const lazy = mounter()
  const held: RemoteMcpServer = { type: "http", url: "http://127.0.0.1:1/mcp/launch", headers: { Authorization: "Bearer t" } }
  const plan = planMcpReload(
    { definitions: { browser: { command: "npx", args: ["browser-mcp"] } }, mounts: { browser: held } },
    { browser: { args: ["browser-mcp"], command: "npx" } },
    lazy.mount,
  )
  assert.equal(plan.mounts.browser, held)
  assert.deepEqual(lazy.calls, [])
  assert.deepEqual({ added: plan.added, removed: plan.removed, changed: plan.changed, unchanged: plan.unchanged }, { added: [], removed: [], changed: [], unchanged: 1 })
  assert.deepEqual(plan.stale, [])
})

test("added, changed and removed servers: new stdio ones are mounted lazily, a remote one is sent as itself", () => {
  const lazy = mounter()
  const heldBrowser: RemoteMcpServer = { type: "http", url: "http://127.0.0.1:1/mcp/a", headers: {} }
  const heldOld: RemoteMcpServer = { type: "http", url: "http://127.0.0.1:1/mcp/b", headers: {} }
  const plan = planMcpReload(
    {
      definitions: { browser: { command: "npx", args: ["v1"] }, old: { command: "old" } },
      mounts: { browser: heldBrowser, old: heldOld },
    },
    { browser: { command: "npx", args: ["v2"] }, docs: { command: "docs" }, neon: { type: "http", url: "https://mcp.neon.tech/mcp" } },
    lazy.mount,
  )
  assert.deepEqual(plan.added, ["docs", "neon"])
  assert.deepEqual(plan.changed, ["browser"])
  assert.deepEqual(plan.removed, ["old"])
  assert.equal(plan.unchanged, 0)
  assert.deepEqual(lazy.calls, ["browser", "docs"])
  assert.deepEqual(plan.mounts.neon, { type: "http", url: "https://mcp.neon.tech/mcp" })
  assert.deepEqual(plan.minted, [plan.mounts.browser, plan.mounts.docs])
  // The replaced mount and the dropped one are what the daemon releases once the reload lands.
  assert.deepEqual(plan.stale, [heldBrowser, heldOld])
})

test("without a lazy host a stdio server is sent as its own command", () => {
  const plan = planMcpReload({ definitions: {}, mounts: {} }, { docs: { command: "docs" } })
  assert.deepEqual(plan.mounts, { docs: { command: "docs" } })
  assert.deepEqual(plan.minted, [])
})

test("a definition's identity ignores key order, and nothing else", () => {
  assert.equal(mcpDefinitionKey({ command: "a", env: { X: "1", Y: "2" } }), mcpDefinitionKey({ env: { Y: "2", X: "1" }, command: "a" }))
  assert.notEqual(mcpDefinitionKey({ command: "a", args: ["1", "2"] }), mcpDefinitionKey({ command: "a", args: ["2", "1"] }))
})
