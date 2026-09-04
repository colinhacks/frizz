// Seed a disposable adhoc stack with SIMULATED workers that are AT REST while their own dispatched
// work is still live — the exact state board.deriveAwaitingBackground selects — so the resting card can
// be judged on all three surfaces in the REAL app: real tailer, real board derivation, real push, real
// browser. A fixture page proves the component; only this proves the SERVER actually sets
// `awaitingBackground` and that the drawer / full-screen page read it.
//
// Two threads, because the card's sentence has to be true in more than one shape:
//   resting-both   — a live sub-agent AND a live background shell (the "and" case)
//   resting-shell  — a background shell only (must NOT claim a sub-agent)
//
// A simulated worker is a BROKER row now, not a tmux pane, and both halves of that matter:
//   • `claude_runtime='broker'` is what makes board.deriveRuntime read the tailer's turn state at all.
//     Without it the row falls to the pre-cutover branch and reports "exited" — the thread cards as a
//     stall and no resting card can ever render (this seeder shipped that way until 2026-08-04).
//   • the tailer drops a thread's background shells the moment their OWNER looks gone
//     (tailer.bgShellViews → paneDead → defaultBrokerDaemonAlive), and for a broker row "gone" means
//     an ABSENT broker record. So the seed writes one, pointing at a real live `sleep` it spawns —
//     a fake pid would be indistinguishable from a dead daemon and the shells would vanish.
// Usage: node scripts/seed-resting-thread.mjs --home=/abs/temp-home [--cwd=/abs/project]
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = process.cwd() } = flags
if (!home) {
  console.error("usage: node seed-resting-thread.mjs --home=/abs/temp-home [--cwd=/abs/project]")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const stateDir = join(db, "..")
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })
mkdirSync(join(stateDir, "claude-broker"), { recursive: true })

// ONE stand-in daemon for every seeded thread — its only job is to own a pid that answers `kill -0`.
// Detached + unref'd so this script can exit; the adhoc stack's temp HOME outlives it either way, so
// kill it by this exact pid when you tear the stack down.
const daemon = spawn("sleep", ["7200"], { detached: true, stdio: "ignore" })
daemon.unref()
const brokerRecordPath = (sessionId) =>
  join(stateDir, "claude-broker", `${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.json`)

const T0 = Date.now() - 25 * 60_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`

function seed({ slug, sessionId, title, prompt, dispatches, closing }) {
  const threadName = `frizz-${slug}`
  const assistant = (id, ts, content, stop) => ({
    parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: ts, session_id: sessionId, cwd,
    message: { model: "claude-opus-5", id, type: "message", role: "assistant", stop_reason: stop, content, usage: { input_tokens: 2, output_tokens: 60 } },
  })
  const toolResult = (toolUseId, text, ts) => ({
    parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: ts, session_id: sessionId, cwd,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] },
  })
  const records = [
    {
      parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: at(0), session_id: sessionId, cwd,
      message: { role: "user", content: `TASK:\n${prompt}` },
    },
    assistant("msg_dispatch", at(1), dispatches.map((d) => ({ type: "tool_use", name: d.tool, id: d.id, input: d.input })), "tool_use"),
    // The launch ACKs. Deliberately the path-LESS and agentId-LESS ack wordings: launchOutputFile()
    // synthesizes a `subagents/agent-<agentId>.jsonl` path from an agentId, and entryStale() then stats
    // that nonexistent file and reports the child "stale". With neither token there is no outputFile,
    // so these children stay "running" for as long as the stack lives.
    ...dispatches.map((d) => toolResult(d.id, d.ack, at(1))),
    // …and then the parent comes to REST with those children still running. `end_turn` is what makes
    // deriveRuntime say turn-idle, which is the whole precondition for the card.
    assistant("msg_rest", at(2), [{ type: "text", text: closing }], "end_turn"),
  ]
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  // The stand-in daemon record. `daemonPid` is the only field the liveness probe reads.
  writeFileSync(brokerRecordPath(sessionId), JSON.stringify({ sessionId, daemonPid: daemon.pid, socketPath: join(stateDir, "claude-broker", `${slug}.sock`) }))
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, claude_runtime, model, effort, permission_mode, rested_at)
     VALUES (${sessionVals}'${slug}', '${sessionId}', '${threadName}', '${at(0)}', '${title}', 'claude', 'broker', 'opus', 'high', 'default', '${at(2)}')`,
  ])
  console.log(`seeded ${slug} → ${sessionId}`)
}

seed({
  slug: "resting-both",
  sessionId: "8e577e57-0000-4000-9000-00000000001a",
  title: "Refactor the pricing parser",
  prompt: "Refactor the pricing parser and verify it end-to-end.",
  closing: "Audit dispatched and the dev server is up. I'll fold the findings in when the sub-agent reports back.",
  dispatches: [
    {
      tool: "Agent", id: "toolu_rest_agent", ack: "Async agent launched successfully",
      input: { description: "Audit the pricing parser for tier-boundary rounding", prompt: "Audit it.", run_in_background: true, subagent_type: "frizz:opus-high" },
    },
    {
      tool: "Bash", id: "toolu_rest_shell", ack: "Command running in background",
      input: { command: "pnpm --filter web dev --host", description: "Start vite from the web package dir", run_in_background: true },
    },
  ],
})

seed({
  slug: "resting-shell",
  sessionId: "8e577e57-0000-4000-9000-00000000001b",
  title: "Watch the release build",
  prompt: "Kick off the release build and keep an eye on it.",
  closing: "Build is running in the background. Nothing to decide yet.",
  dispatches: [
    {
      tool: "Bash", id: "toolu_rest_shell_only", ack: "Command running in background",
      input: { command: "pnpm build --watch", description: "Build the release artifact", run_in_background: true },
    },
  ],
})
