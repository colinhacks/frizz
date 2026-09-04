// Seed a disposable adhoc stack so the RECURRING-PROMPT marks can be judged in the REAL app: the
// footer trigger in both of its states (armed ⇒ amber, idle ⇒ muted) and both transcript wake dividers
// (a delivered stop hook, a delivered heartbeat) in one scroll.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads, with the delivered text
// composed by the SAME shared formatters the scheduler uses (`restPromptMessage`/`schedulePromptMessage`) plus
// the real wake-delivery token — so this exercises the production parse-and-render path rather than a
// hand-written string that merely looks like one.
//
// Usage: nub scripts/seed-recurring-prompt-glyphs.mjs --home=/abs/temp-home --port=NNNN
import { mkdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { restPromptMessage, schedulePromptMessage, wakeDeliveryToken } from "../packages/shared/src/index.ts"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, port, cwd = "/Users/colinmcd94/Documents/projects/frizz" } = flags
if (!home || !port) {
  console.error("usage: nub scripts/seed-recurring-prompt-glyphs.mjs --home=/abs/temp-home --port=NNNN")
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
const token = (n) => wakeDeliveryToken(String(n).repeat(64).slice(0, 64))

// Session ids must be REAL 36-char hex UUIDs. A readable-but-malformed id (`recur-armed-0000-…`) is
// normalized somewhere between the tailer and the board, and two such ids sharing a prefix render each
// other's turns in one thread view — a fixture bug that reads exactly like a projection bug.
const CASES = [
  {
    slug: "recur-armed",
    sessionId: "11111111-1111-4111-8111-111111111111",
    title: "Recurring prompts · both armed",
    // Both features on ⇒ the footer trigger is amber. The transcript carries one delivery of each, so
    // the two dividers and the footer mark are all visible in one shot.
    hook: "Keep going until the test suite is green.",
    beat: { prompt: "Check whether the deploy finished.", seconds: 1800 },
  },
  {
    slug: "recur-idle",
    sessionId: "22222222-2222-4222-8222-222222222222",
    title: "Recurring prompts · nothing armed",
    hook: null,
    beat: null,
  },
]

for (const [n, c] of CASES.entries()) {
  const sessionId = c.sessionId
  const at = ago(2)
  const uuid = (i) => `${String(n + 3).repeat(8)}-3333-4333-8333-33333333333${i}`
  const records = [
    {
      parentUuid: null, isSidechain: false, type: "user",
      message: { role: "user", content: `TASK:\n${c.title}` },
      uuid: uuid(1), timestamp: ago(40), session_id: sessionId, cwd,
    },
    {
      parentUuid: null, isSidechain: false, type: "assistant",
      message: {
        model: "claude-opus-5", id: `msg_${c.slug}_a`, type: "message", role: "assistant",
        content: [{ type: "text", text: "Ran the suite — two failures left in the resolver." }],
        stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 20 },
      },
      uuid: uuid(2), timestamp: ago(35), session_id: sessionId, cwd,
    },
  ]
  if (c.hook) {
    // A delivered STOP HOOK, recorded the way context.ts records one: the composed message plus the
    // machine-facing token the outbox acks on (the projection strips the token and marks the turn a wake).
    records.push({
      parentUuid: null, isSidechain: false, type: "user",
      message: { role: "user", content: `${restPromptMessage(c.hook)}\n\n${token(n + 1)}` },
      uuid: uuid(3), timestamp: ago(30), session_id: sessionId, cwd,
    })
    records.push({
      parentUuid: null, isSidechain: false, type: "assistant",
      message: {
        model: "claude-opus-5", id: `msg_${c.slug}_b`, type: "message", role: "assistant",
        content: [{ type: "text", text: "Fixed one; the other is a stale fixture." }],
        stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 18 },
      },
      uuid: uuid(4), timestamp: ago(25), session_id: sessionId, cwd,
    })
    records.push({
      parentUuid: null, isSidechain: false, type: "user",
      message: { role: "user", content: `${schedulePromptMessage(c.beat.prompt, c.beat.seconds)}\n\n${token(n + 5)}` },
      uuid: uuid(5), timestamp: ago(20), session_id: sessionId, cwd,
    })
    records.push({
      parentUuid: null, isSidechain: false, type: "assistant",
      message: {
        model: "claude-opus-5", id: `msg_${c.slug}_c`, type: "message", role: "assistant",
        content: [{ type: "text", text: "Deploy is still building; suite is green now." }],
        stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 22 },
      },
      uuid: uuid(6), timestamp: at, session_id: sessionId, cwd,
    })
  }
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

  // `thread_name` is the legacy COLUMN name for the thread identity string, not a pane — a simulated
  // worker needs no process at all.
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
     VALUES (${sessionVals}'${c.slug}', '${sessionId}', 'frizz-${c.slug}', '${at}', '${c.title}', 'claude', 'opus', 'high', 'default', '${at}')`,
  ])

  // Arm through the REAL RPC the panel itself calls, so the rows are shaped exactly as production makes them.
  if (c.hook) {
    const api = createRpcClient(`http://127.0.0.1:${port}/`)
    await api.waitForHealth()
    await api.mutate("setThreadRecurringPrompt", {
      slug: c.slug, sessionId, prompt: c.hook, stopHook: true, heartbeat: true, intervalSeconds: c.beat.seconds,
    })
  }
  console.log(`seeded ${c.slug}`)
}
