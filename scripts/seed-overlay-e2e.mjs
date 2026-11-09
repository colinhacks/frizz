// Seed a disposable adhoc stack with the one thread overlayAccessibility.e2e.test.ts's keyboard test
// opens by its cold `?thread=overlay-e2e` route: a rested Claude session titled "Overlay E2E", with a
// real transcript the tailer folds, so the drawer carries a live composer and its "Thread model and
// effort" picker.
//
// The thread is SNOOZED for a day, and that is load-bearing: a desktop deep link to a thread that
// needs you lands on its QUEUE CARD rather than opening a drawer (store.resolveRoutedThread), so a
// plain rested thread — which reads as a handoff, and so as needs-you — would never produce the modal
// sheet the test pins. A snoozed thread sits in the Snoozed band, and its route opens the drawer at
// every width.
//
// No broker record and no stand-in daemon: nothing here needs the runtime to read as live, so this
// script spawns no process and leaves nothing to kill.
//
// Usage: nub scripts/seed-overlay-e2e.mjs --home=/abs/temp-home [--cwd=/abs/project]
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = process.cwd() } = flags
if (!home) {
  console.error("usage: nub scripts/seed-overlay-e2e.mjs --home=/abs/temp-home [--cwd=/abs/project]")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const SLUG = "overlay-e2e"
const SESSION = "0ae7e2e0-0000-4000-8000-000000000001"
const T0 = Date.now() - 10 * 60_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()
const snoozedUntil = new Date(Date.now() + 24 * 60 * 60_000).toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-a000-${String(++n).padStart(12, "0")}`

const records = [
  {
    parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: at(0), session_id: SESSION, cwd,
    message: { role: "user", content: "TASK:\nAudit the overlay layers' keyboard handling." },
  },
  {
    parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: at(1), session_id: SESSION, cwd,
    message: {
      model: "claude-opus-5", id: "msg_overlay_rest", type: "message", role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text: "Every overlay layer unwinds one Escape at a time. Nothing else to report." }],
      usage: { input_tokens: 2, output_tokens: 30 },
    },
  },
]
writeFileSync(join(jsonlDir, `${SESSION}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at, snoozed_until)
   VALUES (${sessionVals}'${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${at(0)}', 'Overlay E2E', 'claude', 'opus', 'high', 'default', '${at(1)}', '${snoozedUntil}')`,
])
console.log(`seeded ${SLUG} → ${SESSION} (snoozed until ${snoozedUntil})`)
