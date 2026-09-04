import { test } from "node:test"
import assert from "node:assert/strict"
import { codexMcpConfigArgs, codexThreadMcpConfig } from "./codex-mcp.ts"
import { FRIZZ_MCP } from "./types.ts"

// These pin the SHAPE of the `-c` overrides. The shape is otherwise only observable by running a real
// codex app-server (see _live_codex_mcp_inject.mts), so a refactor could silently stop mounting the
// servers and every unit test would still pass while codex workers quietly lost their tools — which
// is exactly the state this module was written to fix.

/** `-c` is variadic-free here: the args are strictly alternating flag/value pairs. */
function values(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 2) {
    assert.equal(args[i], "-c", `expected a -c flag at index ${i}, got ${args[i]}`)
    out.push(args[i + 1]!)
  }
  return out
}

test("codexMcpConfigArgs: with no frizz descriptor, frizz mounts NOTHING", () => {
  const vals = values(codexMcpConfigArgs(undefined, "/abs/node"))
  // A `chrome-devtools` override rode every app-server until 2026-08-26 — a browser nobody had asked
  // for, whose tool schemas cost ~6,400 prefix tokens per worker. Frizz now injects the `frizz` server
  // and nothing else, on BOTH backends; a project or operator that wants a browser configures it in
  // `~/.codex/config.toml` themselves, and these overrides layer on top of that rather than replacing it.
  assert.ok(!vals.some((v) => v.startsWith("mcp_servers.")), `frizz must mount no server: ${vals.join(" ")}`)
  assert.ok(!vals.some((v) => v.includes("chrome-devtools")), "frizz must inject no browser")
  // The approval override still rides along: it governs whatever MCP servers the OPERATOR configured,
  // and a headless worker has nobody to click a prompt for those either.
  assert.deepEqual(vals, ['default_tools_approval_mode="approve"'])
})


test("codexMcpConfigArgs: the frizz server carries an ABSOLUTE node path and its FRIZZ_STATE_DIR", () => {
  const vals = values(codexMcpConfigArgs({ scriptPath: "/abs/plugin/bin/frizz-mcp.mjs", stateDir: "/abs/state" }, "/abs/node"))
  const frizz = vals.find((v) => v.startsWith(`mcp_servers.${FRIZZ_MCP.name}=`))
  assert.ok(frizz, "frizz override missing")
  assert.match(frizz, /command="\/abs\/node"/)
  assert.match(frizz, /args=\["\/abs\/plugin\/bin\/frizz-mcp\.mjs"\]/)
  assert.match(frizz, /env=\{FRIZZ_STATE_DIR="\/abs\/state"\}/)
})

// Both backends mount the same script through the same env builder. Pinned on the CODEX side too
// because this is the half that gets forgotten: the claude path is the one anyone tests by hand, and a
// codex worker whose tools quietly address the launching project's board looks identical until its
// spawned thread turns up on the wrong card.
test("codexMcpConfigArgs: the frizz server is told where the lock is and which project it serves", () => {
  const vals = values(codexMcpConfigArgs({
    scriptPath: "/abs/plugin/bin/frizz-mcp.mjs",
    stateDir: "/abs/state",
    serverLock: "/abs/launcher/server.lock",
    projectId: "b47f4055-4262-432a-af18-ded4cbfb3071",
  }, "/abs/node"))
  const frizz = vals.find((v) => v.startsWith(`mcp_servers.${FRIZZ_MCP.name}=`))
  assert.ok(frizz, "frizz override missing")
  assert.match(frizz, /FRIZZ_SERVER_LOCK="\/abs\/launcher\/server\.lock"/)
  assert.match(frizz, /FRIZZ_PROJECT_ID="b47f4055-4262-432a-af18-ded4cbfb3071"/)
})

test("codexMcpConfigArgs: approvals are pre-answered — a headless worker cannot click a prompt", () => {
  // Without this a mounted call is CANCELLED at the moment of use ("user cancelled MCP tool call"),
  // which is strictly worse than not mounting the server at all.
  assert.ok(values(codexMcpConfigArgs(undefined)).includes('default_tools_approval_mode="approve"'))
})

test("codexMcpConfigArgs: values are TOML-quoted so a path with a space or quote cannot break parsing", () => {
  const vals = values(codexMcpConfigArgs({ scriptPath: '/has space/and"quote/frizz-mcp.mjs', stateDir: "/s" }, "/node"))
  const frizz = vals.find((v) => v.startsWith(`mcp_servers.${FRIZZ_MCP.name}=`))!
  // An unquoted/naively-quoted path would terminate the TOML string early and the whole override would
  // fail to parse — codex then starts with NO frizz server and nothing says so.
  assert.ok(frizz.includes('"/has space/and\\"quote/frizz-mcp.mjs"'), `not escaped: ${frizz}`)
})

test("codexMcpConfigArgs: every emitted value is a well-formed `key=value` override", () => {
  for (const v of values(codexMcpConfigArgs({ scriptPath: "/p/s.mjs", stateDir: "/d" }, "/node"))) {
    assert.match(v, /^[a-z_]+(\.[a-z-]+)*=/, `malformed override: ${v}`)
  }
})

// ---- the PER-THREAD mount: the only channel that can name the caller ----

test("codexThreadMcpConfig: mounts the frizz server with THIS thread's slug in its env", () => {
  const config = codexThreadMcpConfig(
    { scriptPath: "/plugin/bin/frizz-mcp.mjs", stateDir: "/state", serverLock: "/lock/server.lock", projectId: "proj-1" },
    "compiled-hono",
    "/abs/node",
  )
  const entry = (config.mcp_servers as Record<string, any>)[FRIZZ_MCP.name]
  assert.ok(entry, "the frizz server is mounted for the thread")
  assert.equal(entry.command, "/abs/node") // absolute, never bare "node" — the app-server's PATH varies
  assert.deepEqual(entry.args, ["/plugin/bin/frizz-mcp.mjs"])
  // THE POINT OF THE WHOLE MOUNT. Without this, `title`/`ask`/`done`/`watch`/`timer`/`goal`/`activity`
  // all fail with "this frizz MCP server was not told which thread it belongs to".
  assert.equal(entry.env.FRIZZ_THREAD_SLUG, "compiled-hono")
  // …and the project half still rides along, so a tenant's worker reaches the right lock and board.
  assert.equal(entry.env.FRIZZ_SERVER_LOCK, "/lock/server.lock")
  assert.equal(entry.env.FRIZZ_PROJECT_ID, "proj-1")
  // Per-SERVER, not inherited from the top-level argv key: an entry without it was refused on 0.153.2
  // with "MCP tool call requires approval, but approval policy is never".
  assert.equal(entry.default_tools_approval_mode, "approve")
})

test("codexThreadMcpConfig: no descriptor ⇒ an EMPTY bag, so no `config` key is sent at all", () => {
  // Degrades to exactly the pre-2026-09-04 behaviour rather than sending a half-built mount.
  assert.deepEqual(codexThreadMcpConfig(undefined, "compiled-hono", "/abs/node"), {})
})
