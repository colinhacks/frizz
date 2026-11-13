import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expandMcpEnvRefs, normalizeMcpServer, projectMcpServerPlan, projectMcpServers, workerMcpServers } from "./project-mcp-servers.ts"

// A fixture is a fake cwd plus a fake Claude config dir. `claudeConfigDir` is always passed explicitly,
// so no test ever reads the operator's REAL `~/.claude.json`. Under an override dir, `.claude.json` and
// `settings.json` both live inside it — the layout auth-status.ts follows for CLAUDE_CONFIG_DIR.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "frizz-project-mcp-"))
  const cwd = join(root, "repo")
  const configDir = join(root, "claude-config")
  mkdirSync(cwd, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  const write = (path: string, value: unknown | string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value))
  }
  const read = (env: NodeJS.ProcessEnv = {}) => projectMcpServers(cwd, { claudeConfigDir: configDir, env })
  return { root, cwd, configDir, write, read }
}

test("no .mcp.json and no config ⇒ nothing, and nothing throws", () => {
  const f = fixture()
  assert.deepEqual(f.read(), {})
})

test("a declared server mounts only once the project approved it, through any of the layers the CLI reads", () => {
  const f = fixture()
  f.write(join(f.cwd, ".mcp.json"), { mcpServers: { a: { command: "npx", args: ["a"] }, b: { command: "b" } } })
  // Declared but unapproved: a headless worker cannot answer the approval prompt, so it is skipped.
  assert.deepEqual(f.read(), {})
  f.write(join(f.cwd, ".claude", "settings.local.json"), { enabledMcpjsonServers: ["a"] })
  assert.deepEqual(f.read(), { a: { command: "npx", args: ["a"] } })
  // enable-all from a second layer, minus an explicit disable.
  f.write(join(f.cwd, ".claude", "settings.json"), { enableAllProjectMcpServers: true, disabledMcpjsonServers: ["b"] })
  assert.deepEqual(Object.keys(f.read()), ["a"])
  f.write(join(f.cwd, ".claude", "settings.json"), { enableAllProjectMcpServers: true })
  assert.deepEqual(Object.keys(f.read()).sort(), ["a", "b"])
})

test("the plan names the declared servers nothing approves, and not the ones a layer turned off", () => {
  const f = fixture()
  f.write(join(f.cwd, ".mcp.json"), { mcpServers: { a: { command: "a" }, b: { command: "b" }, c: { command: "c" } } })
  const plan = () => projectMcpServerPlan(f.cwd, { claudeConfigDir: f.configDir, env: {} })
  assert.deepEqual(plan(), { servers: {}, unapproved: ["a", "b", "c"], invalid: [] })
  // `c` is switched off on purpose, which is not the same as "nobody approved it".
  f.write(join(f.cwd, ".claude", "settings.local.json"), { enabledMcpjsonServers: ["a"], disabledMcpjsonServers: ["c"] })
  assert.deepEqual(plan(), { servers: { a: { command: "a" } }, unapproved: ["b"], invalid: [] })
  // A file caught half-written is NAMED, not read as empty: a reload must refuse rather than unmount `a`.
  f.write(join(f.cwd, ".mcp.json"), '{ "mcpServers": { "a": ')
  assert.deepEqual(plan(), { servers: {}, unapproved: [], invalid: [join(f.cwd, ".mcp.json")] })
})

test("the cwd's own record in .claude.json and the user settings file approve too", () => {
  const f = fixture()
  f.write(join(f.cwd, ".mcp.json"), { mcpServers: { a: { command: "a" }, b: { command: "b" } } })
  f.write(join(f.configDir, ".claude.json"), { projects: { [f.cwd]: { enabledMcpjsonServers: ["b"] } } })
  assert.deepEqual(Object.keys(f.read()), ["b"])
  f.write(join(f.configDir, "settings.json"), { enableAllProjectMcpServers: true })
  assert.deepEqual(Object.keys(f.read()).sort(), ["a", "b"])
})

test("user scope: REMOTE servers ride along, stdio ones are exactly what a worker stops inheriting", () => {
  const f = fixture()
  f.write(join(f.configDir, ".claude.json"), {
    mcpServers: {
      Neon: { type: "http", url: "https://mcp.neon.tech/mcp" },
      "chrome-real": { type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp@latest", "--autoConnect"] },
      legacy: { command: "some-local-binary" },
    },
    projects: { [f.cwd]: { mcpServers: { local: { type: "sse", url: "https://local.example/sse" } } } },
  })
  assert.deepEqual(f.read(), {
    Neon: { type: "http", url: "https://mcp.neon.tech/mcp" },
    local: { type: "sse", url: "https://local.example/sse" },
  })
})

test("precedence: the project shadows a user-scope remote of the same name, and frizz shadows everything", () => {
  const f = fixture()
  f.write(join(f.configDir, ".claude.json"), { mcpServers: { Neon: { type: "http", url: "https://user/mcp" } } })
  f.write(join(f.cwd, ".mcp.json"), { mcpServers: { Neon: { type: "http", url: "https://project/mcp" }, frizz: { command: "/not/frizz" } } })
  f.write(join(f.cwd, ".claude", "settings.json"), { enableAllProjectMcpServers: true })
  const project = f.read()
  assert.equal((project.Neon as { url: string }).url, "https://project/mcp")
  const frizz = { frizz: { command: process.execPath, args: ["/abs/frizz-mcp.mjs"] } }
  assert.deepEqual(workerMcpServers(project, frizz).frizz, frizz.frizz)
  assert.deepEqual(workerMcpServers(undefined, frizz), frizz)
  assert.deepEqual(workerMcpServers(project, undefined), project)
})

test("a remote server keeps its `oauth` client and `headersHelper`, which its sign-in needs", () => {
  const f = fixture()
  f.write(join(f.cwd, ".mcp.json"), {
    mcpServers: {
      fixed: { type: "http", url: "https://fixed.example/mcp", oauth: { clientId: "abc", callbackPort: 8765, scopes: ["read"], junk: { nested: 1 } } },
      helper: { type: "sse", url: "https://helper.example/sse", headersHelper: "${HELPER_DIR:-/opt}/print-headers.sh" },
    },
  })
  f.write(join(f.cwd, ".claude", "settings.json"), { enableAllProjectMcpServers: true })
  assert.deepEqual(f.read({}), {
    fixed: { type: "http", url: "https://fixed.example/mcp", oauth: { clientId: "abc", callbackPort: 8765, scopes: ["read"] } },
    helper: { type: "sse", url: "https://helper.example/sse", headersHelper: "/opt/print-headers.sh" },
  })
})

test("${VAR} and ${VAR:-default} expand against the WORKER's env; an unresolved reference drops that server", () => {
  const f = fixture()
  f.write(join(f.cwd, ".mcp.json"), {
    mcpServers: {
      tok: { type: "http", url: "https://x.example/${TOKEN}", headers: { Authorization: "Bearer ${TOKEN}" } },
      port: { command: "srv", args: ["--port", "${PORT:-8080}"], env: { STATE: "${STATE_DIR:-/tmp/state}" } },
      missing: { command: "${NOPE}" },
    },
  })
  f.write(join(f.cwd, ".claude", "settings.json"), { enableAllProjectMcpServers: true })
  assert.deepEqual(f.read({ TOKEN: "t0k" }), {
    tok: { type: "http", url: "https://x.example/t0k", headers: { Authorization: "Bearer t0k" } },
    port: { command: "srv", args: ["--port", "8080"], env: { STATE: "/tmp/state" } },
  })
  assert.equal(expandMcpEnvRefs("a${X}b", { X: "1" }), "a1b")
  assert.equal(expandMcpEnvRefs("${Y:-}", {}), "")
  assert.equal(expandMcpEnvRefs("${Y}", {}), undefined)
})

test("malformed input fails OPEN to 'not mounted', never to an exception", () => {
  const f = fixture()
  f.write(join(f.cwd, ".mcp.json"), "{ not json")
  f.write(join(f.configDir, ".claude.json"), "[]")
  assert.deepEqual(f.read(), {})
  f.write(join(f.cwd, ".mcp.json"), { mcpServers: { ok: { command: "ok" }, sdk: { type: "sdk", name: "x" }, ws: { type: "ws", url: "ws://x" }, bad: { command: 1 } } })
  f.write(join(f.cwd, ".claude", "settings.local.json"), { enableAllProjectMcpServers: true })
  assert.deepEqual(f.read(), { ok: { command: "ok" } })
  assert.equal(normalizeMcpServer(null, {}), undefined)
  assert.equal(normalizeMcpServer({ type: "http" }, {}), undefined)
  assert.equal(normalizeMcpServer({ command: "c", args: ["a", 2] }, {}), undefined)
})

test("CLAUDE_CONFIG_DIR in the worker's env locates the config when no dir is injected", () => {
  const f = fixture()
  f.write(join(f.configDir, ".claude.json"), { mcpServers: { Neon: { type: "http", url: "https://n/mcp" } } })
  const home = join(f.root, "no-such-home")
  assert.deepEqual(projectMcpServers(f.cwd, { env: { CLAUDE_CONFIG_DIR: f.configDir }, home }), { Neon: { type: "http", url: "https://n/mcp" } })
  assert.deepEqual(projectMcpServers(f.cwd, { env: {}, home }), {})
})
