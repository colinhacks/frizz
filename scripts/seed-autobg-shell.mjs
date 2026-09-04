#!/usr/bin/env node
// Seed an adhoc stack with two fixture threads that differ in ONE thing: whether the foreground Bash
// was AUTO-BACKGROUNDED by the harness on its timeout, or simply finished.
//
//   autobg-shell — foreground Bash → "…was moved to the background (ID: …)" → worker rests
//                  EXPECT: a live background-op row, and the thread held as awaiting-background.
//   plain-shell  — foreground Bash → ordinary output          → worker rests   (NEGATIVE CONTROL)
//                  EXPECT: nothing live; an ordinary bare-rest handoff.
//
// Usage: node scripts/seed-autobg-shell.mjs <home> <unused> <projectDir>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const [home, _socket, projectDir] = process.argv.slice(2)
if (!home || !projectDir) throw new Error("usage: seed-autobg-shell.mjs <home> <unused> <projectDir>")

const cwdSlug = projectDir.replace(/[/.]/g, "-")
const transcriptDir = path.join(home, ".claude", "projects", cwdSlug)
fs.mkdirSync(transcriptDir, { recursive: true })

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)

const T = (n) => new Date(Date.UTC(2026, 6, 30, 4, n, 0)).toISOString()

function records({ sessionId, description, command, result, ack }) {
  const out = [
    { type: "user", timestamp: T(0), sessionId, message: { role: "user", content: "Run the production backfill and report the totals." } },
    {
      type: "assistant",
      timestamp: T(1),
      sessionId,
      message: { id: "m-1", model: "claude-opus-5", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_fixture_bash", name: "Bash", input: { command, description, timeout: 590000 } }] },
    },
    { type: "user", timestamp: T(11), sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fixture_bash", content: result }] } },
    {
      type: "assistant",
      timestamp: T(12),
      sessionId,
      message: { id: "m-2", model: "claude-opus-5", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: ack }] },
    },
  ]
  return out.map((r) => JSON.stringify(r)).join("\n") + "\n"
}

const AUTO_BG_ACK =
  "Command did not complete within its 590s timeout and was moved to the background (ID: bhlfxzwg1). " +
  `Output is being written to: ${path.join(home, "tasks", "bhlfxzwg1.output")}. ` +
  "You will be notified when it completes. To check interim output, use Read on that file path."

const threads = [
  {
    slug: "autobg-shell",
    sessionId: "11111111-1111-4111-8111-111111111111",
    title: "Auto-backgrounded shell",
    description: "Wait for the backfill to finish",
    command: "until grep -q '^TOTALS' /tmp/reap-backfill-live.log; do sleep 25; done\necho done",
    result: AUTO_BG_ACK,
    ack: "The backfill is still running — I moved the wait into the background and will pick it up when it lands.",
  },
  {
    slug: "plain-shell",
    sessionId: "22222222-2222-4222-8222-222222222222",
    title: "Ordinary foreground shell",
    description: "Count the stuck rows",
    command: "wc -l < /tmp/reap-backfill-live.log",
    result: "1939",
    ack: "1939 rows scanned. Nothing is running in the background.",
  },
]

for (const t of threads) {
  fs.writeFileSync(path.join(transcriptDir, `${t.sessionId}.jsonl`), records(t))
  fs.mkdirSync(path.join(home, "tasks"), { recursive: true })
  fs.writeFileSync(path.join(home, "tasks", "bhlfxzwg1.output"), "scanning…\n")
  execFileSync("sqlite3", [
    db,
    `INSERT INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived)
     VALUES (${sessionVals}'${t.slug}', '${t.sessionId}', 'frizz-${t.slug}', '${T(0)}', '${t.title}', 0, 'claude', 'opus', 'high', 'auto', 'open', 0, 0, 0)`,
  ])
  console.log(`seeded ${t.slug} (${t.sessionId})`)
}
