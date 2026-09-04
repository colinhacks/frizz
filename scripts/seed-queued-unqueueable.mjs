// Seed a disposable adhoc stack with a SIMULATED claude worker holding an outstanding follow-up, so the
// one retractable bubble in the transcript can be judged on the REAL app: real ledger projection, real
// board push, real browser hover.
//
// `unqueueable` in UserBubble needs four things at once, and this fixture supplies all four honestly:
//   · queued + deliveryId — projected by the server from the session row's `delivery_ledger` column
//     (readThreadTranscript → projectDeliveryLedger). An item with no matching JSONL record projects a
//     synthetic gray bubble, which is exactly the live "sent, not yet picked up" state.
//   · ThreadSlugContext — supplied by the drawer's own ChatView, so open the thread to exercise it.
//   · backend !== "codex" — the row is a claude row.
//
// Follows the frizz-stack recipe: a session row + a JSONL the tailer reads.
// Usage: node scripts/seed-queued-unqueueable.mjs --home=/abs/temp-home --port=NNNN
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, port, cwd = process.cwd() } = flags
if (!home || !port) {
  console.error("usage: node seed-queued-unqueueable.mjs --home=/abs/temp-home --port=NNNN")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const SLUG = "queued-followup"
const SESSION_ID = "9e0dbbbb-0000-4000-9000-00000000003a"
const DELIVERY_ID = "7c1f0aa2-0000-4000-9000-00000000004b"
// The retractable send. Long enough that the bubble occupies real width, so a hint line under it would
// be unmissable in the shot.
const QUEUED_TEXT = "Also fold the boundary case into the same test — the one where the tier changes mid-cycle."

const T0 = Date.now() - 6 * 60_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`

const records = [
  {
    parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: at(0), session_id: SESSION_ID, cwd,
    message: { role: "user", content: "TASK:\nFix the tier-boundary rounding in the pricing parser and land it." },
  },
  {
    parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: at(1), session_id: SESSION_ID, cwd,
    message: {
      model: "claude-opus-5", id: "msg_work", type: "message", role: "assistant", stop_reason: null,
      content: [{ type: "text", text: "Reading the pricing parser now — the rounding happens in `applyTier`, so that's where the fix goes." }],
      usage: { input_tokens: 22_000, output_tokens: 140 },
    },
  },
]
writeFileSync(join(jsonlDir, `${SESSION_ID}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

const threadName = `frizz-${SLUG}`

// `enqueued` rather than `pending`: it is the state a real follow-up settles into once Claude Code has
// written its enqueue record, and it deliberately never ages into the amber "check the terminal"
// warning — so the bubble under test is the plain retractable one, not the unconfirmed variant.
const ledger = JSON.stringify([
  { id: DELIVERY_ID, text: QUEUED_TEXT, state: "enqueued", at: at(4), updatedAt: at(4) },
])

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, delivery_ledger)
   VALUES (${sessionVals}'${SLUG}', '${SESSION_ID}', '${threadName}', '${at(0)}', 'Fix the tier-boundary rounding', 'claude', 'opus', 'high', 'default', '${ledger.replace(/'/g, "''")}')`,
])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
for (let i = 0; i < 40; i++) {
  const board = await api.query("board")
  if (board.threads.some((t) => t.id === SLUG)) break
  await new Promise((r) => setTimeout(r, 250))
}
const msgs = await api.query("threadTranscript", { slug: SLUG })
const queued = (msgs.messages ?? msgs).filter((m) => m.queued)
console.log(JSON.stringify({ slug: SLUG, deliveryId: DELIVERY_ID, queued: queued.map((m) => ({ text: m.text, deliveryId: m.deliveryId, state: m.deliveryState })) }))
