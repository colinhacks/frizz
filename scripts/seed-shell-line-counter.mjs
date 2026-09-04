#!/usr/bin/env node
// Seed the LIVE COUNTER case: a thread resting on three background shells whose output files differ in
// exactly the way the counter exists to expose.
//
//   1. a CHATTY watcher     — an output file with real lines in it, appended to between screenshots so
//                             the reading can be watched climbing;
//   2. a SILENT watcher     — an output file that exists and is EMPTY. This is the wedged case, and the
//                             row must read "0 lines" rather than showing nothing;
//   3. an UNREADABLE shell  — its launch ack names a path that does not exist (frizz's stand-in for a
//                             codex exec, whose output never reaches a file at all). No counter.
//
// A SECOND thread seeds the PRE-ACK window — the seconds between a shell's `tool_use` (its row
// appears) and its launch ack (which is the only record naming an output path). The counter cannot
// exist yet there, and the strip must keep polling anyway or it never arrives.
//
// Usage: node scripts/seed-shell-line-counter.mjs <home> <socket> <projectDir>
// Then:  node scripts/seed-shell-line-counter.mjs <home> --append <n>   (grow the chatty shell)
//        node scripts/seed-shell-line-counter.mjs <home> --ack          (land the pre-ack shell's ack)
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const [home, socket, projectDir] = process.argv.slice(2)
if (!home) throw new Error("usage: seed-shell-line-counter.mjs <home> <socket> <projectDir>")

const CHATTY = path.join(home, "tasks", "ci-watch.output")

// The growth mode: what proves the reading is LIVE rather than a number rendered once at mount.
if (socket === "--append") {
  const n = Number(projectDir ?? 40)
  fs.appendFileSync(CHATTY, Array.from({ length: n }, (_, i) => `[gate] check ${i + 1} — waiting on the release job`).join("\n") + "\n")
  console.log(`appended ${n} lines to ${CHATTY}`)
  process.exit(0)
}

const PREACK_SESSION = "35555555-5555-4555-8555-555555555555"
const PREACK_TOOL = "toolu_counter_preack_00001"
const PREACK_OUT = path.join(home, "tasks", "preack.output")

// Land the ack the pre-ack thread was deliberately seeded without: the shell's row has been on screen
// the whole time, and this is the record that finally gives it an output path.
if (socket === "--ack") {
  const dir = fs.readdirSync(path.join(home, ".claude", "projects"))[0]
  const jsonl = path.join(home, ".claude", "projects", dir, `${PREACK_SESSION}.jsonl`)
  fs.writeFileSync(PREACK_OUT, Array.from({ length: 22 }, (_, i) => `[boot] step ${i + 1}`).join("\n") + "\n")
  fs.appendFileSync(jsonl, JSON.stringify({
    type: "user",
    timestamp: new Date().toISOString(),
    sessionId: PREACK_SESSION,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: PREACK_TOOL, content: `Command running in background with ID: preack01. Output is being written to: ${PREACK_OUT}. You will be notified when it completes.` }] },
  }) + "\n")
  console.log(`landed the ack for ${PREACK_TOOL}`)
  process.exit(0)
}

if (!projectDir) throw new Error("usage: seed-shell-line-counter.mjs <home> <socket> <projectDir>")

const cwdSlug = projectDir.replace(/[/.]/g, "-")
const transcriptDir = path.join(home, ".claude", "projects", cwdSlug)
fs.mkdirSync(transcriptDir, { recursive: true })
fs.mkdirSync(path.join(home, "tasks"), { recursive: true })

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)

const base = Date.now() - 14 * 60_000
const T = (ms) => new Date(base + ms).toISOString()

const SILENT = path.join(home, "tasks", "dev-server.output")
const MISSING = path.join(home, "tasks", "deploy-queue.output")

fs.writeFileSync(CHATTY, Array.from({ length: 138 }, (_, i) => `[gate] check ${i + 1} — waiting on the release job`).join("\n") + "\n")
fs.writeFileSync(SILENT, "")
fs.rmSync(MISSING, { force: true })

function launch({ msgId, toolId, description, command, outputFile, at }) {
  return [
    { type: "assistant", timestamp: T(at), message: { id: msgId, model: "claude-opus-5", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command, description, run_in_background: true } }] } },
    { type: "user", timestamp: T(at + 900), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: `Command running in background with ID: ${toolId.slice(-8)}. Output is being written to: ${outputFile}. You will be notified when it completes.` }] } },
  ]
}

const sessionId = "34444444-4444-4444-8444-444444444444"
const records = [
  { type: "user", timestamp: T(0), message: { role: "user", content: "Watch the release gate and keep the dev server up." } },
  ...launch({ msgId: "m-ci", toolId: "toolu_counter_ci_watch_0001", description: "Watching CI for the release gate", command: "gh run watch 4821 --exit-status", outputFile: CHATTY, at: 2_000 }),
  ...launch({ msgId: "m-dev", toolId: "toolu_counter_dev_server_02", description: "Tailing the dev server", command: "nub run dev", outputFile: SILENT, at: 5_000 }),
  ...launch({ msgId: "m-dep", toolId: "toolu_counter_deploy_q_003", description: "Polling the deploy queue", command: "./scripts/poll-deploy.sh", outputFile: MISSING, at: 8_000 }),
  { type: "assistant", timestamp: T(11_000), message: { id: "m-rest", model: "claude-opus-5", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "All three watchers are up. I'll pick this back up when the release gate reports." }] } },
]

// The pre-ack thread: a tool_use with NO tool_result after it. The tailer tracks the shell (so the row
// renders) and has no output path for it (so there is nothing to count — yet).
fs.rmSync(PREACK_OUT, { force: true })
const preackRecords = [
  { type: "user", timestamp: T(0), message: { role: "user", content: "Bring the sandbox up." } },
  { type: "assistant", timestamp: T(2_000), message: { id: "m-pre", model: "claude-opus-5", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: PREACK_TOOL, name: "Bash", input: { command: "./scripts/boot-sandbox.sh", description: "Booting the sandbox", run_in_background: true } }] } },
]

function seed({ slug, sessionId, title, records }) {
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify({ ...r, sessionId })).join("\n") + "\n")
  execFileSync("sqlite3", [
    db,
    `INSERT INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived)
     VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${T(0)}', '${title}', 0, 'claude', 'opus', 'high', 'auto', 'open', 0, 0, 0)`,
  ])
  console.log(`seeded ${slug} (${sessionId})`)
}

seed({ slug: "shell-line-counter", sessionId, title: "Watch the release gate", records })
seed({ slug: "shell-counter-preack", sessionId: PREACK_SESSION, title: "Bring the sandbox up", records: preackRecords })
