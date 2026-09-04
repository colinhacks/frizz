// Verify that a worker's SUPERSEDED MCP server can still arm its recurring prompt against a CURRENT
// frizz server — the exact seam that broke, driven end to end with nothing stubbed.
//
// The bug: a worker's `frizz-mcp.mjs` is spawned once, out of the promoted build its session was
// dispatched with, and it lives as long as that session — across every server restart. The server
// meanwhile gets restarted from newer source. Merging the old `stop_hook` + `heartbeat` tools into one
// `recurring_prompt` renamed the RPC procedure, so every in-flight worker's tool started answering
// `HTTP 404` with nothing to diagnose it by.
//
// Testing the pieces would prove nothing here: the router's own tests already pass against the shapes I
// BELIEVE those builds send. What this script does instead is spawn the REAL old binaries out of
// `~/.frizz/builds/*/runtime/cc-worker/bin/frizz-mcp.mjs`, speak their REAL stdio JSON-RPC transport, and
// assert the row a REAL server's REAL sqlite ends up holding. Old client, new server, no mocks.
//
// Usage (against a booted adhoc stack — see scripts/adhoc-stack.mjs):
//   nub scripts/verify-legacy-mcp-rpc.mjs --home=/abs/temp-home
import { execFileSync, spawn } from "node:child_process"
import { globSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home } = flags
if (!home) {
  console.error("usage: nub scripts/verify-legacy-mcp-rpc.mjs --home=/abs/temp-home")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
// The MCP server locates the running frizz from `<state-dir>/server.lock`, so this must be the sandbox's
// project dir, not the maintainer's real one.
const stateDir = dirname(db)

// Pick the binaries by what they actually CALL rather than by a pinned hash — promoted builds get
// garbage-collected, and a hash that has aged out would turn this into a silent skip.
function findBuild(procedure) {
  for (const script of globSync(join(homedir(), ".frizz/builds/*/runtime/cc-worker/bin/frizz-mcp.mjs"))) {
    if (readFileSync(script, "utf8").includes(`callRpc("${procedure}"`)) return script
  }
  return null
}

// One stdio JSON-RPC conversation with a real MCP server binary.
function mcp(script, env) {
  const child = spawn(process.execPath, [script], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...env },
  })
  const pending = new Map()
  let buf = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      pending.get(msg.id)?.(msg)
      pending.delete(msg.id)
    }
  })
  let id = 0
  return {
    call: (method, params) => {
      const mine = ++id
      const done = new Promise((resolve) => pending.set(mine, resolve))
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mine, method, params }) + "\n")
      return done
    },
    kill: () => child.kill(),
  }
}

const sql = (q) => execFileSync("sqlite3", [db, q], { encoding: "utf8" }).trim()

const failures = []
function check(label, actual, expected) {
  const ok = String(actual) === String(expected)
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label} — got ${JSON.stringify(actual)}${ok ? "" : `, want ${JSON.stringify(expected)}`}`)
  if (!ok) failures.push(label)
}

// A registered thread for the old binaries to arm. `thread_name` is the legacy COLUMN name for the thread
// identity string, not a pane — nothing here needs a real worker process.
const slug = "legacy-mcp-thread"
const at = new Date().toISOString()
sql(
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES (${sessionVals}'${slug}', '33333333-3333-4333-8333-333333333333', 'frizz-${slug}', '${at}', 'Legacy MCP thread', 'claude', 'opus', 'high', 'default', '${at}')`,
)

async function callTool(script, name, args) {
  const rpc = mcp(script, { FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: slug })
  try {
    await rpc.call("initialize", { protocolVersion: "2025-06-18" })
    const res = await rpc.call("tools/call", { name, arguments: args })
    return res.result
  } finally {
    rpc.kill()
  }
}

// ---- The two-feature generation: `stop_hook` (on rest) + `heartbeat` (on a clock) ------------------
const twoFeature = findBuild("setOwnThreadHeartbeat")
if (!twoFeature) throw new Error("no promoted build calling setOwnThreadHeartbeat is left on this machine")
console.log(`\ntwo-feature build: ${twoFeature}`)

let out = await callTool(twoFeature, "stop_hook", { action: "start", prompt: "keep the migration moving" })
// THE REGRESSION: this came back `isError: true` with "returned HTTP 404" for every in-flight worker.
check("stop_hook start is not an error", out.isError, undefined)
check("  ↳ text does not report a 404", /404/.test(out.content[0].text), false)
check("row: text armed", sql(`SELECT recurring_prompt FROM session WHERE slug='${slug}'`), "keep the migration moving")
check("row: rest trigger on", sql(`SELECT recurring_on_rest FROM session WHERE slug='${slug}'`), "1")
check("row: schedule trigger off", sql(`SELECT recurring_on_schedule FROM session WHERE slug='${slug}'`), "0")

out = await callTool(twoFeature, "heartbeat", { action: "start", prompt: "check the deploy", interval_seconds: 600 })
check("heartbeat start is not an error", out.isError, undefined)
check("row: schedule trigger on", sql(`SELECT recurring_on_schedule FROM session WHERE slug='${slug}'`), "1")
check("row: cadence carried through", sql(`SELECT recurring_interval_ms FROM session WHERE slug='${slug}'`), "600000")
// The two old features were INDEPENDENT, and a worker driving them cannot see the merged row — so
// arming one must not silently disarm the other.
check("row: rest trigger survives the heartbeat", sql(`SELECT recurring_on_rest FROM session WHERE slug='${slug}'`), "1")

out = await callTool(twoFeature, "heartbeat", { action: "stop" })
check("heartbeat stop is not an error", out.isError, undefined)
check("row: schedule trigger off again", sql(`SELECT recurring_on_schedule FROM session WHERE slug='${slug}'`), "0")
check("row: rest trigger still armed", sql(`SELECT recurring_on_rest FROM session WHERE slug='${slug}'`), "1")

out = await callTool(twoFeature, "stop_hook", { action: "stop" })
check("stop_hook stop is not an error", out.isError, undefined)
check("row: cleared once the last trigger goes", sql(`SELECT COALESCE(recurring_prompt,'<null>') FROM session WHERE slug='${slug}'`), "<null>")

// ---- The OLDEST generation: one `heartbeat` tool posting `setThreadHeartbeat`, no `enabled` field ---
const oldest = findBuild("setThreadHeartbeat")
if (!oldest) console.log("\nno promoted build calling setThreadHeartbeat is left on this machine — skipped")
else {
  console.log(`\noldest build: ${oldest}`)
  out = await callTool(oldest, "heartbeat", { action: "start", prompt: "poll the corpus", interval_seconds: 900 })
  check("oldest heartbeat start is not an error", out.isError, undefined)
  check("row: armed on the schedule", sql(`SELECT recurring_on_schedule FROM session WHERE slug='${slug}'`), "1")
  check("row: cadence carried through", sql(`SELECT recurring_interval_ms FROM session WHERE slug='${slug}'`), "900000")

  out = await callTool(oldest, "heartbeat", { action: "stop" })
  check("oldest heartbeat stop is not an error", out.isError, undefined)
  check("row: cleared", sql(`SELECT COALESCE(recurring_prompt,'<null>') FROM session WHERE slug='${slug}'`), "<null>")
}

console.log(failures.length === 0 ? "\nPASS — every superseded MCP binary reaches the merged row" : `\nFAIL — ${failures.length}: ${failures.join(", ")}`)
process.exit(failures.length === 0 ? 0 : 1)
