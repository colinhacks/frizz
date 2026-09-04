#!/usr/bin/env node
// Seed an adhoc stack with the threads that decide how a Bash `description` becomes the live shimmer:
//
//   • gerund-imperative — a PENDING Bash whose description is the IMPERATIVE the human actually saw
//     ("Find relative links and stale paths in the package README"). The shimmer must read
//     `Finding relative links and stale paths in the package README` — converted, and NOT prefixed
//     with `Running`.
//   • gerund-noun-phrase — a PENDING Bash whose description is a noun phrase no verb map can convert
//     ("Final workflow validation"). It must render AS WRITTEN, never `Running Final workflow …`.
//   • gerund-already — the control: a description that already arrives as a gerund passes through.
//
// Usage: node scripts/seed-gerund-descriptions.mjs <home> <unused> <projectDir>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const [home, _socket, projectDir] = process.argv.slice(2)
if (!home || !projectDir) throw new Error("usage: seed-gerund-descriptions.mjs <home> <unused> <projectDir>")

const cwdSlug = projectDir.replace(/[/.]/g, "-")
const transcriptDir = path.join(home, ".claude", "projects", cwdSlug)
fs.mkdirSync(transcriptDir, { recursive: true })

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)

const T = (n) => new Date(Date.UTC(2026, 6, 31, 4, n, 0)).toISOString()
const call = (id, name, input) => ({ type: "tool_use", id, name, input })

// A PENDING call is one with no tool_result for its id — that is what drives the bottom shimmer, so
// none of these seeds get a result.
function write(slug, sessionId, title, prompt, description, command) {
  const records = [
    { type: "user", timestamp: T(0), sessionId, message: { role: "user", content: prompt } },
    {
      type: "assistant",
      timestamp: T(1),
      sessionId,
      message: {
        id: "m-1",
        model: "claude-opus-5",
        role: "assistant",
        stop_reason: "tool_use",
        content: [call("toolu_live", "Bash", { command, description })],
      },
    },
  ]
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  execFileSync("sqlite3", [
    db,
    `INSERT INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived)
     VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${T(0)}', '${title}', 0, 'claude', 'opus', 'high', 'auto', 'open', 0, 0, 0)`,
  ])
  console.log(`seeded ${slug} (${sessionId})`)
}

write(
  "gerund-imperative",
  "66666666-6666-4666-8666-666666666666",
  "Gerund imperative",
  "Audit the package README.",
  "Find relative links and stale paths in the package README",
  "rg -n ']\\(' packages/web/README.md",
)

write(
  "gerund-noun-phrase",
  "77777777-7777-4777-8777-777777777777",
  "Gerund noun phrase",
  "Run the last workflow check.",
  "Final workflow validation",
  "cd /a/very/long/path/that/should/not/leak && actionlint",
)

write(
  "gerund-already",
  "88888888-8888-4888-8888-888888888888",
  "Gerund already",
  "Run the focused tests.",
  "Running the focused activity-label tests",
  "nub --test packages/web/src/lib/toolActivity.test.ts",
)
