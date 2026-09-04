#!/usr/bin/env node
// Seed the DUPLICATE-BACKGROUND-SHELL shape the maintainer caught on 2026-07-31: the ops strip under the
// composer drew the same live shell twice, once clickable and once not.
//
// The shape is exact, copied off real bytes (nub session ccc520d9). ONE assistant turn, THREE records
// sharing one message id — thinking, then prose, then the background Bash call, each with its own
// timestamp seconds apart:
//
//   19:11:27.256  thinking   (renders nothing)
//   19:11:28.190  text       ← the projected MESSAGE takes THIS instant
//   19:11:32.200  tool_use   ← the tailer's tracked shell takes THIS one
//
// The strip lists the shell from the board's telemetry (which has the tool_use id) AND from the
// transcript projection. It used to reconcile them on label+startedAt, so a four-second gap between the
// two instants drew two rows. It now reconciles on the launch tool_use id (`shellId`).
//
// Also seeds a NEGATIVE CONTROL: two genuinely distinct shells the model described identically, which
// must keep BOTH rows — the fix must not collapse real concurrent work onto one line.
//
// Usage: node scripts/seed-dup-bg-shell.mjs <home> <unused> <projectDir>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const [home, _socket, projectDir] = process.argv.slice(2)
if (!home || !projectDir) throw new Error("usage: seed-dup-bg-shell.mjs <home> <unused> <projectDir>")

const cwdSlug = projectDir.replace(/[/.]/g, "-")
const transcriptDir = path.join(home, ".claude", "projects", cwdSlug)
fs.mkdirSync(transcriptDir, { recursive: true })

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)

// Recent, so the rows read as live work rather than an ancient thread.
const base = Date.now() - 8 * 60_000
const T = (ms) => new Date(base + ms).toISOString()

const LABEL = "Building release candidate and launcher"
const COMMAND = "cd /tmp/rc && cargo build --release > /tmp/r-cli.log 2>&1; echo CLI=$?"

// One background launch: the thinking/text/tool_use split that separates the two sources' instants.
function launch({ msgId, toolId, description, atThinking, atText, atCall, atAck }) {
  return [
    { type: "assistant", timestamp: T(atThinking), message: { id: msgId, model: "claude-opus-5", role: "assistant", content: [{ type: "thinking", thinking: "The release chain takes a while — background it.", signature: "sig" }] } },
    { type: "assistant", timestamp: T(atText), message: { id: msgId, model: "claude-opus-5", role: "assistant", content: [{ type: "text", text: "Kicking off the release build chain in the background." }] } },
    { type: "assistant", timestamp: T(atCall), message: { id: msgId, model: "claude-opus-5", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: COMMAND, description, run_in_background: true } }] } },
    { type: "user", timestamp: T(atAck), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: `Command running in background with ID: ${toolId.slice(-8)}. Output is being written to: ${path.join(home, "tasks", `${toolId.slice(-8)}.output`)}. You will be notified when it completes.` }] } },
  ]
}

const threads = [
  {
    slug: "dup-bg-shell",
    sessionId: "31111111-1111-4111-8111-111111111111",
    title: "One shell, two reporters",
    records: [
      { type: "user", timestamp: T(0), message: { role: "user", content: "Cut the release candidate." } },
      ...launch({ msgId: "m-dup", toolId: "toolu_01VoyZtuuXmpX7XCH5dtu5x2", description: LABEL, atThinking: 1_000, atText: 1_934, atCall: 5_944, atAck: 8_368 }),
      { type: "assistant", timestamp: T(9_000), message: { id: "m-rest", model: "claude-opus-5", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Waiting for the release build chain." }] } },
    ],
  },
  {
    slug: "twin-bg-shells",
    sessionId: "32222222-2222-4222-8222-222222222222",
    title: "Two real shells, same description",
    records: [
      { type: "user", timestamp: T(0), message: { role: "user", content: "Build both targets." } },
      ...launch({ msgId: "m-a", toolId: "toolu_twin_aaaaaaaaaaaaaaaaaa", description: LABEL, atThinking: 1_000, atText: 1_900, atCall: 5_900, atAck: 8_300 }),
      ...launch({ msgId: "m-b", toolId: "toolu_twin_bbbbbbbbbbbbbbbbbb", description: LABEL, atThinking: 10_000, atText: 10_900, atCall: 14_900, atAck: 17_300 }),
      { type: "assistant", timestamp: T(18_000), message: { id: "m-rest-b", model: "claude-opus-5", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Both builds are running." }] } },
    ],
  },
]

fs.mkdirSync(path.join(home, "tasks"), { recursive: true })
for (const t of threads) {
  fs.writeFileSync(path.join(transcriptDir, `${t.sessionId}.jsonl`), t.records.map((r) => JSON.stringify({ ...r, sessionId: t.sessionId })).join("\n") + "\n")
  execFileSync("sqlite3", [
    db,
    `INSERT INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived)
     VALUES (${sessionVals}'${t.slug}', '${t.sessionId}', 'frizz-${t.slug}', '${T(0)}', '${t.title}', 0, 'claude', 'opus', 'high', 'auto', 'open', 0, 0, 0)`,
  ])
  console.log(`seeded ${t.slug} (${t.sessionId})`)
}
