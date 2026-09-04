// Seed a disposable adhoc stack with SIMULATED workers spread across all three rail bands — Active,
// Snoozed and Done — so the sidebar's band chrome (the collapse carets, the labels, the counts) can be
// judged in the REAL app rather than in a fixture that draws its own headers. Written 2026-08-04 for
// the Snoozed-band collapse; reusable for anything that changes how the rail's sections render.
//
// Follows the seed-resting-thread.mjs recipe: a broker-runtime session row + a broker liveness record
// + a JSONL the REAL tailer reads. `claude_runtime='broker'` is what makes deriveRuntime read the
// tailer's turn state; without it the row reports "exited" and the bands come out wrong.
//
// Usage: node scripts/seed-rail-bands.mjs --home=/abs/temp-home [--cwd=/abs/project]
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = process.cwd() } = flags
if (!home) {
  console.error("usage: node seed-rail-bands.mjs --home=/abs/temp-home [--cwd=/abs/project]")
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
const daemon = spawn("sleep", ["7200"], { detached: true, stdio: "ignore" })
daemon.unref()
const brokerRecordPath = (sessionId) =>
  join(stateDir, "claude-broker", `${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.json`)

const T0 = Date.now() - 40 * 60_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()
// Far enough out that the timer fences stay unelapsed for the life of any verification run.
const FUTURE = new Date(Date.now() + 6 * 3_600_000).toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`

function seed({ slug, title, prompt, closing, archived = false }) {
  const sessionId = `${createHash("sha256").update(slug).digest("hex").slice(0, 8)}-0000-4000-9000-000000000000`
  const records = [
    {
      parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: at(0), session_id: sessionId, cwd,
      message: { role: "user", content: `TASK:\n${prompt}` },
    },
    {
      parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: at(2), session_id: sessionId, cwd,
      message: {
        model: "claude-opus-5", id: `msg_${slug}`, type: "message", role: "assistant",
        content: [{ type: "text", text: closing }], stop_reason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 60 },
      },
    },
  ]
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  writeFileSync(brokerRecordPath(sessionId), JSON.stringify({ sessionId, daemonPid: daemon.pid, socketPath: join(stateDir, "claude-broker", `${slug}.sock`) }))
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, claude_runtime, model, effort, permission_mode, rested_at, archived, state)
     VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${at(0)}', '${title}', 'claude', 'broker', 'opus', 'high', 'default', '${at(2)}', ${archived ? 1 : 0}, '${archived ? "archived" : "active"}')`,
  ])
  console.log(`seeded ${slug} → ${sessionId}`)
}

// ACTIVE — bare rest, no fence at all.
seed({ slug: "band-active-parser", title: "Refactor the pricing parser", prompt: "Refactor the pricing parser.", closing: "Parser is refactored and the tier-boundary tests are green." })
seed({ slug: "band-active-icons", title: "Align the composer icons", prompt: "Align the composer icons.", closing: "Icons measured and nudged; the residual is under a tenth of a pixel." })

// HELD — the two truthful park shapes: a human gate, and a future timer.
const human = (who) => "Handed the migration plan over.\n\n```awaiting\nhuman: " + who + "\nWaiting on their sign-off before I touch the schema.\n```"
const timer = "Deploy is out; re-checking the error rate later.\n\n```awaiting\ntimer: " + FUTURE + "\nI'll re-read the dashboard then.\n```"
seed({ slug: "band-held-schema", title: "Migrate the session schema", prompt: "Migrate the session schema.", closing: human("@dana — schema review") })
seed({ slug: "band-held-terms", title: "Rewrite the terms copy", prompt: "Rewrite the terms copy.", closing: human("@legal — terms wording sign-off") })
seed({ slug: "band-held-deploy", title: "Watch the deploy error rate", prompt: "Deploy and watch the error rate.", closing: timer })
seed({ slug: "band-held-quota", title: "Re-run the quota estimator", prompt: "Re-run the quota estimator once the window resets.", closing: timer })

// DONE — archived at rest.
seed({ slug: "band-done-cache", title: "Fix the cache collision", prompt: "Fix the cache collision.", closing: "Fixed — the lookup keys on the normalized id now.", archived: true })
seed({ slug: "band-done-flake", title: "Kill the tailer flake", prompt: "Kill the tailer flake.", closing: "Root-caused to a shared clock; the test pins it now.", archived: true })
