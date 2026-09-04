// Seed a disposable adhoc stack with ONE simulated worker whose transcript puts the "Agent rested"
// hairline in all three positions it can land in, in reading order:
//
//   1. above a frizz WAKE DELIVERY (the sign-off nudge) — the back-to-back pair the maintainer called
//      out on 2026-08-13 ("we're just getting these back-to-back hairlines");
//   2. above the HUMAN'S own next message — the one position where the rule discriminates, since
//      without it a reply to a finished agent reads exactly like a steer typed mid-turn;
//   3. at the TAIL, where the runtime-status slot beneath it already says the agent is not spinning.
//
// The point of one thread rather than three is that the surviving hairline and the two dropped ones are
// judged against each other, at the same type size, in the same scroll — including the message rhythm
// either side of a rule that is no longer there.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads. No pane, no process:
// liveness comes from the row.
// Usage: nub scripts/seed-rest-divider-positions.mjs --home=/abs/temp-home --port=NNNN
import { mkdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { SIGNOFF_NUDGE_MARKER } from "../packages/shared/src/index.ts"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, port, cwd = process.cwd() } = flags
if (!home || !port) {
  console.error("usage: nub scripts/seed-rest-divider-positions.mjs --home=/abs/temp-home --port=NNNN")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const T0 = Date.now() - 50 * 60_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`
const slug = "rest-divider-positions"
const sessionId = "e5700000-0000-4000-9000-0000000000aa"

const user = (min, content) => ({
  parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: at(min), session_id: sessionId, cwd,
  message: { role: "user", content },
})
// `stop_reason: "end_turn"` is the authoritative signal the rest divider is projected from — see
// transcript.ts § the agent came to rest.
const assistant = (min, text) => ({
  parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: at(min), session_id: sessionId, cwd,
  message: {
    model: "claude-opus-5", id: `msg_${n}`, type: "message", role: "assistant", stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 41_000, output_tokens: 320 },
  },
})

const SIGNOFF = `${SIGNOFF_NUDGE_MARKER} Nothing about your task has changed, and this is not a request to do more work.\n\nYou came to rest without a signal fence, so nobody can triage this thread. Re-read your last message and close it with the fence that matches where the work actually stands.\n\n<!-- frizz-wake:sgnf0001 -->`

const records = [
  user(0, "TASK:\nThe rested hairline reads as noise when a wake divider follows it. Work out whether it earns its place."),
  assistant(4, "Measured it across this repo's own thirty Claude sessions: 83 rest dividers, 13% of them stacked directly above another hairline and 35% sitting at the tail with nothing under them."),
  user(5, SIGNOFF),
  assistant(6, "**Fixed** — the redundant hairlines are gone and the discriminating one stays.\n\n```done\n- Dropped the rest hairline where it only restates its neighbours, in `packages/web/src/lib/restDividers.ts`.\n```"),
  user(30, "And what happens on a thread that a Goal is driving — does the same rule hold there?"),
  assistant(33, "It does. A Goal delivery is a wake record too, so the hairline above it collapses for exactly the same reason the sign-off one does."),
]

writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${at(0)}', 'Rest divider positions', 'claude', 'opus', 'high', 'default', '${at(33)}')`,
])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
for (let i = 0; i < 40; i++) {
  const board = await api.query("board")
  if (board.threads.some((t) => t.id === slug)) break
  await new Promise((r) => setTimeout(r, 250))
}
const page = await api.query("threadTranscript", { slug })
console.log(JSON.stringify(page.messages.map((m) => ({ role: m.role, kind: m.kind, boundary: m.boundary, wake: m.wake, text: (m.displayText ?? m.text).slice(0, 44) })), null, 1))
