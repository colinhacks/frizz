// Seed an adhoc stack with the FOUR board states that the "rested parent keeps its Active-rail place"
// change distinguishes (maintainer 2026-07-30: "if an agent has children that are still running child
// subprocesses or subagents, but it itself has rested, it should still stay in the active agent's rail
// instead of shifting down to the queue … it should only show up in the queue when it's fully rested and
// it has no running sub-agents").
//
// Every row is built from the REAL record shapes a worker writes, so the assertion runs through the real
// tailer → board → push pipeline rather than a hand-made ThreadView:
//
//   A  at rest, ONE LIVE SUB-AGENT      → running band, NOT queued   (THE CHANGE; was rested+carded)
//   B  fully rested, no children        → rested band, QUEUED        (the only state that may queue)
//   C  at rest, live background SHELL   → rested band, QUEUED        (control: shells are never excused —
//                                                                     no staleness clock, so an eternal
//                                                                     dev server must not bury its thread)
//   D  own turn IN FLIGHT + live child  → running band, NOT queued   (control: unchanged)
//
// A and D together are the point of the change: the row must look the SAME in both, so nothing moves when
// the parent's own turn ends.
//
// Usage (from ui/, against a running scripts/adhoc-stack.mjs — pass ITS home):
//   nub scripts/seed-rested-child-bands.mjs --port=4930 --home=<stack home>
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const port = Number(opt("port", "4930"))
const home = opt("home")
if (!home) { console.error("--home is required (from the stack's json line)"); process.exit(1) }

const PROJECT = opt("project", process.cwd())
const cwdSlug = PROJECT.replace(/\//g, "-")
const logDir = join(home, ".claude", "projects", cwdSlug)
mkdirSync(logDir, { recursive: true })
const at = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString()

const sandbox = resolveSandboxDb(home)
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const db = sandbox.db

// One fixture thread: write its transcript, give it a live dummy pane, register the row. `spawnedAt`
// is staggered so the rail order is stable and readable in the screenshot.
function seed({ slug, session, title, records, ageSec }) {
  const sessionDir = join(logDir, session)
  mkdirSync(join(sessionDir, "subagents"), { recursive: true })
  const rows = records(join(sessionDir, "subagents"))
  writeFileSync(join(logDir, `${session}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`)
  execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, state, backend, model, effort, permission_mode, title_auto, unread, exited, archived) VALUES (${sessionVals}'${slug}', '${session}', 'frizz-${slug}', '${at(ageSec)}', '${title}', 'open', 'claude', 'opus', 'high', 'bypassPermissions', 0, 0, 0, 0)`])
}

const assistant = (content, ts, stop = "end_turn") => ({ type: "assistant", timestamp: ts, message: { id: `m${Math.random().toString(36).slice(2)}`, role: "assistant", stop_reason: stop, content } })
const user = (content, ts) => ({ type: "user", timestamp: ts, message: { role: "user", content } })
// A live child transcript: written NOW, so its mtime keeps it clear of the staleness ceiling.
const liveChild = (dir, agentId) => writeFileSync(join(dir, `agent-${agentId}.jsonl`), `${JSON.stringify(assistant([{ type: "text", text: "still working" }], at(0)))}\n`)

// A — at rest with a LIVE sub-agent. The row under test.
seed({
  slug: "refactor-the-pricing-parser", session: "aaaaaaaa-0000-4000-8000-000000000001",
  title: "Refactor the pricing parser", ageSec: -900,
  records: (dir) => {
    liveChild(dir, "aLive")
    return [
      user([{ type: "text", text: "Refactor the pricing parser and cover the tier edges." }], at(-900)),
      assistant([{ type: "tool_use", id: "toolu_a", name: "Agent", input: { description: "Audit the parser for edge cases", subagent_type: "frizz:opus-high", run_in_background: true, prompt: "Audit the pricing parser for unhandled tier edges and report each one." } }], at(-870)),
      user([{ type: "tool_result", tool_use_id: "toolu_a", content: [{ type: "text", text: `Async agent launched successfully.\nagentId: aLive\noutput_file: ${join(dir, "agent-aLive.jsonl")}` }] }], at(-869)),
      // The parent's OWN turn then ends — it is at rest while the child keeps going.
      assistant([{ type: "text", text: "Audit lane is out. I'll fold its findings in when it returns." }], at(-860)),
    ]
  },
})

// B — fully rested, no children. The ONLY state that may queue.
seed({
  slug: "fix-queue-focus-after-archive", session: "aaaaaaaa-0000-4000-8000-000000000002",
  title: "Fix queue focus after an archive", ageSec: -1200,
  records: () => [
    user([{ type: "text", text: "Fix the queue focus jump after archiving a card." }], at(-1200)),
    assistant([{ type: "text", text: "Done — focus now lands on the next card. Ready for review." }], at(-1100)),
  ],
})

// C — at rest on a live background SHELL. Control: deliberately still queued.
seed({
  slug: "watch-the-nightly-build", session: "aaaaaaaa-0000-4000-8000-000000000003",
  title: "Watch the nightly build", ageSec: -600,
  records: () => [
    user([{ type: "text", text: "Keep an eye on the nightly build." }], at(-600)),
    assistant([{ type: "tool_use", id: "toolu_c", name: "Bash", input: { command: "npm run build -- --watch", description: "Watch the build", run_in_background: true } }], at(-560)),
    user([{ type: "tool_result", tool_use_id: "toolu_c", content: [{ type: "text", text: "Command running in background with ID: bash_1" }] }], at(-559)),
    assistant([{ type: "text", text: "Watcher is up; I'll report when it reports." }], at(-550)),
  ],
})

// D — the parent's OWN turn is in flight, with a live child. Control: must look identical to A.
seed({
  slug: "sweep-the-tailer-nudges", session: "aaaaaaaa-0000-4000-8000-000000000004",
  title: "Sweep the tailer nudge regressions", ageSec: -300,
  records: (dir) => {
    liveChild(dir, "dLive")
    return [
      user([{ type: "text", text: "Sweep the tailer nudge regressions." }], at(-300)),
      assistant([{ type: "tool_use", id: "toolu_d", name: "Agent", input: { description: "Reproduce the nudge on a live tail", subagent_type: "frizz:sonnet-medium", run_in_background: true, prompt: "Reproduce the tailer nudge on a live tail and report the exact record that triggers it." } }], at(-280)),
      user([{ type: "tool_result", tool_use_id: "toolu_d", content: [{ type: "text", text: `Async agent launched successfully.\nagentId: dLive\noutput_file: ${join(dir, "agent-dLive.jsonl")}` }] }], at(-279)),
      // No end_turn after this tool_use → the parent's own turn is still IN FLIGHT.
      assistant([{ type: "tool_use", id: "toolu_d2", name: "Read", input: { file_path: "/tmp/tailer.ts" } }], at(-270), null),
    ]
  },
})

// ── let the tailer fold it all, then report what the BOARD actually says ─────────────────────────
const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
const want = ["refactor-the-pricing-parser", "fix-queue-focus-after-archive", "watch-the-nightly-build", "sweep-the-tailer-nudges"]
let seen = []
for (let i = 0; i < 60; i++) {
  const board = await api.query("board")
  seen = (board.threads ?? []).filter((t) => want.includes(t.id))
  if (seen.length === want.length && seen.every((t) => t.runtime && t.runtime !== "none")) break
  await new Promise((r) => setTimeout(r, 500))
}
console.log(JSON.stringify(seen.map((t) => ({
  id: t.id, runtime: t.runtime, needsYou: t.needsYou === true, awaitingBackground: t.awaitingBackground === true,
  subAgents: (t.subAgents ?? []).map((a) => [a.label, a.state]), bgShells: (t.bgShells ?? []).map((s) => [s.label, s.state]),
})), null, 1))
