// Seed a disposable adhoc stack with a SIMULATED worker parked on TIMERS — the 2026-08-24 case: an
// ```awaiting fence naming armed `thread_timer` rows and nothing else. This is the shape that used to
// render the fence card's machinery footer ("a timer   for 2h"); it must now card as the resting
// table with a "Timers" group, one row per armed timer, named by the timer's own prompt and counting
// down to its fire instant (AwaitingBackgroundCard).
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads, and timers armed
// through the REAL RPC (`setOwnThreadTimer`) so the registry rows the board derives from are the
// production ones — not a hand-built props fixture. The fence is written AFTER arming, because the
// timer ids are server-minted and the fence must name them.
//
// Usage: nub scripts/seed-timer-park.mjs --home=/abs/temp-home --port=NNNN
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync, globSync } from "node:fs"
import { basename, join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, port, cwd = "/Users/colinmcd94/Documents/projects/frizz" } = flags
if (!home || !port) {
  console.error("usage: nub scripts/seed-timer-park.mjs --home=/abs/temp-home --port=NNNN")
  process.exit(1)
}

// One unified database per HOME since a995792e (`~/.frizz/ui.db`, rows keyed by project_id); the
// per-project `projects/<id>/ui.db` is the pre-cutover layout, kept so an older sandbox still seeds.
const unifiedDb = join(home, ".frizz/ui.db")
const db = existsSync(unifiedDb) ? unifiedDb : globSync(join(home, ".frizz/projects/*/ui.db"))[0]
if (!db) throw new Error(`no ui.db under ${home}/.frizz — is the stack booted?`)
// The broker record still lives under the PROJECT's state dir, whichever layout the database took.
const stateDir = existsSync(unifiedDb) ? globSync(join(home, ".frizz/projects/*"))[0] : join(db, "..")
if (!stateDir) throw new Error(`no project state dir under ${home}/.frizz/projects — is the stack booted?`)
// The project this row belongs to: the launcher's id, which is the name of its state directory.
const projectId = basename(stateDir)
const hasProjectId = execFileSync("sqlite3", [db, "PRAGMA table_info(session)"], { encoding: "utf8" }).includes("|project_id|")
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })
mkdirSync(join(stateDir, "claude-broker"), { recursive: true })

// A simulated worker is a BROKER row (`claude_runtime='broker'`), and the runtime probe needs a daemon
// record whose pid answers `kill -0` — without both, deriveRuntime reads "exited" and no resting card
// can render (see seed-resting-thread.mjs, which shipped that way once). Kill this exact pid at teardown.
const daemon = spawn("sleep", ["7200"], { detached: true, stdio: "ignore" })
daemon.unref()

const ago = (mins) => new Date(Date.now() - mins * 60_000).toISOString().replace(/\.\d+Z$/, "Z")
const ahead = (mins) => new Date(Date.now() + mins * 60_000).toISOString()

const slug = "timer-park"
const sessionId = `${slug}-0000-4000-8000-000000000000`.slice(0, 36)
const spawnedAt = ago(10)

// The row FIRST: setOwnThreadTimer refuses a slug that is not registered.
execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${hasProjectId ? "project_id, " : ""}slug, session_id, thread_name, spawned_at, title, backend, claude_runtime, model, effort, permission_mode, rested_at)
   VALUES (${hasProjectId ? `'${projectId}', ` : ""}'${slug}', '${sessionId}', 'frizz-${slug}', '${spawnedAt}', 'timer park · release hold', 'claude', 'broker', 'opus', 'high', 'default', '${spawnedAt}')`,
])
writeFileSync(
  join(stateDir, "claude-broker", `${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.json`),
  JSON.stringify({ sessionId, daemonPid: daemon.pid, socketPath: join(stateDir, "claude-broker", `${slug}.sock`) }),
)

// Two REAL timers through the production RPC — the ids come back server-minted (`tmr_…`).
const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
const t1 = await api.mutate("setOwnThreadTimer", { slug, prompt: "Re-check: tip quiet, frozen-lockfile install green, typecheck green", fireAt: ahead(34) })
const t2 = await api.mutate("setOwnThreadTimer", { slug, prompt: "Poke the release workflow if no new run appeared", fireAt: ahead(52) })

// THE REST COMES AFTER THE TIMERS, and that ordering is load-bearing rather than cosmetic. A real
// worker arms its timers during the turn and rests once they are armed, so `createdAt < restedAt` for
// every row it declared — and the card CUTS its rows at the rest instant whenever it is drawn at a rest
// the thread has been bumped past (AwaitingWaitOptions.notAfter). Backdated three minutes, as this was,
// every timer the script arms looks like work the REPLY started: the card showed two rows at rest and
// none the moment a follow-up landed, which is a defect in the FIXTURE that reads exactly like one in
// the product.
//
// AND IT KEEPS ITS MILLISECONDS. The other instants here floor to the second for readability; this one
// may not, because the cut is a STRICT `>` against a timer's own millisecond-precision `created_at` —
// flooring moves the rest up to 999ms into the past and drops the very rows it was ordered after.
const at = new Date().toISOString()
execFileSync("sqlite3", [db, `UPDATE session SET rested_at = '${at}' WHERE slug = '${slug}'`])

// The worker's rest, in the CURRENT fence grammar: YAML frontmatter naming the armed ids, then prose.
const fence = [
  "```awaiting",
  `timers: [${t1.id}, ${t2.id}]`,
  "for: 2h",
  "---",
  "Waiting for `main` to stabilize before cutting the 0.6.0 release that carries the #22 fix.",
  "",
  "- an hourly timer re-checks: tip quiet, frozen-lockfile install green, typecheck green",
  "- once the release publishes, the approved comment goes on #22 with the version number, then the issue is closed",
  "```",
].join("\n")
const records = [
  {
    parentUuid: null, isSidechain: false, type: "user",
    message: { role: "user", content: "TASK:\nHold for the 0.6.0 release window." },
    uuid: "00000000-0000-4000-8000-00000000t001".slice(-36), timestamp: ago(10), session_id: sessionId, cwd,
  },
  {
    parentUuid: null, isSidechain: false, type: "assistant",
    message: {
      model: "claude-opus-5", id: `msg_${slug}`, type: "message", role: "assistant",
      content: [{ type: "text", text: fence }],
      stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 60 },
    },
    uuid: "00000000-0000-4000-8000-00000000t002".slice(-36), timestamp: at, session_id: sessionId, cwd,
  },
]
writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
console.log(`seeded ${slug} with timers ${t1.id}, ${t2.id}`)
