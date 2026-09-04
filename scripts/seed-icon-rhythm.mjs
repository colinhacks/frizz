// Seed a disposable adhoc stack so the FOOTER'S ICON RHYTHM can be judged in the REAL app rather than
// only in `icon-rhythm-fixture.html` — the strip's spacing is CSS, but the set of marks that actually
// co-occur on one card is a projection question, and that is what a fixture cannot answer.
//
// ONE broker-backed Claude row, because that is the only shape that renders the whole right cluster:
// `ReloadPluginsButton` requires `claudeRuntime === "broker"` and `RestartWorkerButton` requires a
// Claude row that has not exited. The `claude_runtime` column is projected straight through
// (board.ts), so a simulated worker can carry it; liveness is what a seed cannot fake, so if the row
// cards as exited both verbs hide and the check falls back to the fixture.
//
// The snooze and the recurring prompt are armed through the REAL RPCs the controls themselves call, so
// the hourglass and the heartbeat are in the state production puts them in. The context donut is
// deliberately absent: a Claude row's context WINDOW arrives only on the live broker event stream
// (tailer.ts, applyRuntimeContextWindow), so no seed can produce one — use `seed-context-meter.mjs`,
// which seeds codex rows, when the donut is what you are judging.
//
// Usage: nub scripts/seed-icon-rhythm.mjs --home=/abs/temp-home --port=NNNN
import { mkdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, port, cwd = process.cwd() } = flags
if (!home || !port) {
  console.error("usage: nub scripts/seed-icon-rhythm.mjs --home=/abs/temp-home --port=NNNN")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const ago = (mins) => new Date(Date.now() - mins * 60_000).toISOString().replace(/\.\d+Z$/, "Z")
const SLUG = "icon-rhythm"
// A REAL 36-char UUID: a readable-but-malformed session id is normalized somewhere between the tailer
// and the board and renders another thread's turns into this one.
const SESSION = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
const at = ago(2)

const records = [
  {
    parentUuid: null, isSidechain: false, type: "user",
    message: { role: "user", content: "TASK:\nJudge the footer's icon rhythm in the real app." },
    uuid: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbb1", timestamp: ago(30), session_id: SESSION, cwd,
  },
  {
    parentUuid: null, isSidechain: false, type: "assistant",
    message: {
      model: "claude-opus-5", id: "msg_icon_rhythm_a", type: "message", role: "assistant",
      content: [{ type: "text", text: "Every mark on the strip is up: readouts left, verbs right." }],
      stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 14 },
    },
    uuid: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbb2", timestamp: at, session_id: SESSION, cwd,
  },
]
writeFileSync(join(jsonlDir, `${SESSION}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

// `thread_name` is the legacy COLUMN name for the thread identity string, not a pane — a simulated
// worker needs no process at all.
execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at, claude_runtime)
   VALUES (${sessionVals}'${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${at}', 'Icon rhythm', 'claude', 'opus', 'high', 'default', '${at}', 'broker')`,
])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
await api.mutate("setThreadRecurringPrompt", {
  slug: SLUG, sessionId: SESSION, prompt: "Re-check the strip.", stopHook: true, heartbeat: false, intervalSeconds: 1800,
})
await api.mutate("setThreadSnooze", { slug: SLUG, sessionId: SESSION, until: new Date(Date.now() + 7 * 864e5).toISOString(), prompt: null })
console.log(`seeded ${SLUG}`)
