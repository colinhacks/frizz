#!/usr/bin/env node
// Seed an adhoc stack with the two threads that decide what the settled tool-activity digest reads:
//
//   • digest-edits — one settled run of 27 calls that writes FOUR distinct files, via every shape the
//     projection produces: an ordinary Edit (twice, on one file), a Write (a creation), and an "Edit"
//     with no structured edit payload, which is what a codex apply_patch the server could not
//     reconstruct — a `Delete File`, a multi-file hunk — collapses to. All four read as "edited".
//     The digest must be `Ran 27 tool calls, edited 4 files`.
//   • digest-no-edits — the within-shot control: a run that only reads and searches, which must keep
//     the bare `Ran 9 tool calls` with no trailing clause.
//
// Usage: node scripts/seed-digest-edits.mjs <home> <unused> <projectDir>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const [home, _socket, projectDir] = process.argv.slice(2)
if (!home || !projectDir) throw new Error("usage: seed-digest-edits.mjs <home> <unused> <projectDir>")

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
const result = (id, content) => ({ type: "tool_result", tool_use_id: id, content })

function write(slug, sessionId, title, records) {
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  execFileSync("sqlite3", [
    db,
    `INSERT INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived)
     VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${T(0)}', '${title}', 0, 'claude', 'opus', 'high', 'auto', 'open', 0, 0, 0)`,
  ])
  console.log(`seeded ${slug} (${sessionId})`)
}

// One settled turn: every call gets a result, and closing prose ends the run so the digest renders
// instead of the live shimmer holding the tail.
function turn(sessionId, ask, calls, reply) {
  const records = [
    { type: "user", timestamp: T(0), sessionId, message: { role: "user", content: ask } },
  ]
  calls.forEach((c, i) => {
    records.push({
      type: "assistant",
      timestamp: T(1 + i),
      sessionId,
      message: { id: `m-${i}`, model: "claude-opus-5", role: "assistant", stop_reason: "tool_use", content: [c] },
    })
    records.push({ type: "user", timestamp: T(1 + i), sessionId, message: { role: "user", content: [result(c.id, "ok")] } })
  })
  records.push({
    type: "assistant",
    timestamp: T(2 + calls.length),
    sessionId,
    message: { id: "m-final", model: "claude-opus-5", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: reply }] },
  })
  return records
}

const file = (p) => `${projectDir}/${p}`
const edit = (id, p) => call(id, "Edit", { file_path: file(p), old_string: "const total = tools.length", new_string: "const total = tools.reduce((n, t) => n + t.count, 0)" })

// The edit calls are deliberately NOT adjacent: consecutive edits to one file merge into a single
// collapsed diff card, so spacing them keeps the call arithmetic below legible (21 + 6 = 27).
const editingCalls = [
  call("t1", "Read", { file_path: file("ui/packages/web/src/lib/toolActivity.ts") }),
  call("t2", "Grep", { pattern: "settledToolActivityLabel", path: file("ui/packages/web/src") }),
  edit("t3", "ui/packages/web/src/lib/toolActivity.ts"),
  call("t4", "Read", { file_path: file("ui/packages/web/src/components/ChatView.tsx") }),
  call("t5", "Bash", { command: "nub --test packages/web/src/lib/toolActivity.test.ts", description: "Run the digest unit tests" }),
  edit("t6", "ui/packages/web/src/components/ChatView.tsx"),
  call("t7", "Read", { file_path: file("ui/packages/shared/src/index.ts") }),
  // A Write is a creation, and reads as an edit like any other write.
  call("t8", "Write", { file_path: file("ui/scripts/seed-digest-edits.mjs"), content: "#!/usr/bin/env node\n" }),
  call("t9", "Grep", { pattern: "editedFileCount" }),
  edit("t10", "ui/packages/web/src/lib/toolActivity.ts"),
  call("t11", "Read", { file_path: file("ui/packages/server/src/transcript.ts") }),
  // The shape a codex apply_patch leaves when it could not be reconstructed — a deletion, collapsed
  // into the same "edited" reading as every other write.
  call("t12", "Edit", { file_path: file("ui/packages/web/src/lib/staleDigest.ts") }),
  call("t13", "Bash", { command: "nub run typecheck", description: "Typecheck the workspace" }),
  edit("t14", "ui/packages/web/src/components/ChatView.tsx"),
  ...Array.from({ length: 13 }, (_, i) =>
    i % 3 === 0
      ? call(`f${i}`, "Read", { file_path: file(`ui/packages/web/src/components/Panel${i}.tsx`) })
      : i % 3 === 1
        ? call(`f${i}`, "Grep", { pattern: `digest-${i}` })
        : call(`f${i}`, "Bash", { command: `git diff --stat HEAD~${i}`, description: `Inspect revision ${i}` })),
]

write("digest-edits", "66666666-6666-4666-8666-666666666666", "Digest counts edited files", turn(
  "66666666-6666-4666-8666-666666666666",
  "Improve the digest to special-case editing files.",
  editingCalls,
  "The digest now reports how many distinct files the run wrote.",
))

write("digest-no-edits", "77777777-7777-4777-8777-777777777777", "Digest with no edits", turn(
  "77777777-7777-4777-8777-777777777777",
  "Where does the settled digest get rendered?",
  [
    call("r1", "Read", { file_path: file("ui/packages/web/src/lib/toolActivity.ts") }),
    call("r2", "Grep", { pattern: "settledToolActivityLabel" }),
    call("r3", "Read", { file_path: file("ui/packages/web/src/components/ChatView.tsx") }),
    call("r4", "Grep", { pattern: "MinimalToolActivity" }),
    call("r5", "Bash", { command: "rg -n 'Ran ' ui/packages/web/src", description: "Search for the digest string" }),
    call("r6", "Read", { file_path: file("ui/packages/web/src/lib/transcriptMetaLabels.ts") }),
    call("r7", "Glob", { pattern: "ui/packages/web/src/**/*.test.ts" }),
    call("r8", "Read", { file_path: file("ui/packages/web/src/lib/toolActivity.test.ts") }),
    call("r9", "Bash", { command: "git log --oneline -5", description: "Check recent history" }),
  ],
  "It is `settledToolActivityLabel`, rendered by `MinimalToolActivity`.",
))
