#!/usr/bin/env node
// Seed an adhoc stack with ONE thread whose transcript carries every liveness reading a tool card can
// have, so the REAL app (real tailer → real transcript projection → real ChatView) renders the marks
// side by side and they can be compared by eye and by measurement:
//
//   • a DETACHED background Bash, still pending      → blue mark leading the row
//   • a Monitor (always detached), still pending     → blue mark leading the row
//   • a FOREGROUND Bash pending for a while          → the SAME blue mark (no spinner anywhere)
//   • a finished Bash, and a failed one              → no mark, no slot; the reading alone
//   • an Agent dispatch, still pending               → the accent mark, in the SAME slot
//
// The last one is the control the whole change is measured against: a shell card and a dispatch card
// must mark their liveness in the same place, differing only in hue.
//
// Usage: node scripts/seed-tool-liveness-marks.mjs <home> <unused> <projectDir>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const [home, _socket, projectDir] = process.argv.slice(2)
if (!home || !projectDir) throw new Error("usage: seed-tool-liveness-marks.mjs <home> <unused> <projectDir>")

const cwdSlug = projectDir.replace(/[/.]/g, "-")
const transcriptDir = path.join(home, ".claude", "projects", cwdSlug)
fs.mkdirSync(transcriptDir, { recursive: true })

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)

const slug = "tool-liveness-marks"
const sessionId = "33333333-3333-4333-8333-333333333333"
const T = (n) => new Date(Date.UTC(2026, 6, 30, 4, n, 0)).toISOString()

// A PENDING call is one with no `tool_result` for its id — that is what the projection reads, so the
// terminal calls below get results and the live ones deliberately do not.
const call = (id, name, input) => ({ type: "tool_use", id, name, input })
const result = (id, content, isError) => ({ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) })

const records = [
  { type: "user", timestamp: T(0), sessionId, message: { role: "user", content: "Watch CI, tail the build, and run the suite." } },
  {
    type: "assistant",
    timestamp: T(1),
    sessionId,
    message: {
      id: "m-1",
      model: "claude-opus-5",
      role: "assistant",
      stop_reason: "tool_use",
      content: [
        call("toolu_done", "Bash", { command: "npm test", description: "Run the unit suite" }),
        call("toolu_failed", "Bash", { command: "npm run typecheck", description: "Typecheck the workspace" }),
      ],
    },
  },
  {
    type: "user",
    timestamp: T(2),
    sessionId,
    message: { role: "user", content: [result("toolu_done", "ok 412 passing"), result("toolu_failed", "error TS2345: Argument of type …", true)] },
  },
  {
    type: "assistant",
    timestamp: T(3),
    sessionId,
    message: {
      id: "m-2",
      model: "claude-opus-5",
      role: "assistant",
      stop_reason: "tool_use",
      content: [
        // DETACHED: `run_in_background` is what the projection reads to call a call a background job.
        call("toolu_bg", "Bash", { command: "gh run watch 12345", description: "Watch CI", run_in_background: true }),
        // Monitor is always detached, so it needs no flag — and it renders as a header-only card,
        // which is the OTHER card shape that has to carry the mark.
        call("toolu_monitor", "Monitor", { command: "gh pr checks 391 --watch", description: "Monitor: PR checks" }),
        // FOREGROUND, still pending: marks itself on elapsed time once past the threshold. This record's
        // own timestamp is the clock, and it is minutes old, so it renders marked on first paint.
        call("toolu_fg", "Bash", { command: "npm run build", description: "Build the workspace" }),
        call("toolu_agent", "Agent", { prompt: "Sweep every call site of the renamed helper.", subagent_type: "frizz:opus-high", description: "Sweep the renamed helper" }),
      ],
    },
  },
]

fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
execFileSync("sqlite3", [
  db,
  `INSERT INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived)
   VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${T(0)}', 'Tool liveness marks', 0, 'claude', 'opus', 'high', 'auto', 'open', 0, 0, 0)`,
])
console.log(`seeded ${slug} (${sessionId})`)
