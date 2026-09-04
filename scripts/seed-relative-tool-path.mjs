#!/usr/bin/env node
// Seed an adhoc stack with the two threads that decide whether the live tool shimmer shortens paths:
//
//   • relative-tool-path — a settled Edit card on an ABSOLUTE in-project path (the unchanged surface,
//     kept in shot as the within-frame control) followed by a PENDING Edit on another absolute
//     in-project path. The bottom shimmer must read `Editing packages/web/src/components/ChatView.tsx`
//     while the card above it still shows the full absolute path.
//   • outside-tool-path — a PENDING Read on a path OUTSIDE the project. Nothing shortens it honestly,
//     so the shimmer must keep it absolute.
//
// Usage: node scripts/seed-relative-tool-path.mjs <home> <unused> <projectDir>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const [home, _socket, projectDir] = process.argv.slice(2)
if (!home || !projectDir) throw new Error("usage: seed-relative-tool-path.mjs <home> <unused> <projectDir>")

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

// A PENDING call is one with no tool_result for its id — that is what the projection reads, so the
// settled call below gets a result and the live one deliberately does not.
function write(slug, sessionId, title, records) {
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  execFileSync("sqlite3", [
    db,
    `INSERT INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived)
     VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${T(0)}', '${title}', 0, 'claude', 'opus', 'high', 'auto', 'open', 0, 0, 0)`,
  ])
  console.log(`seeded ${slug} (${sessionId})`)
}

write("relative-tool-path", "44444444-4444-4444-8444-444444444444", "Relative tool path", [
  { type: "user", timestamp: T(0), sessionId: "44444444-4444-4444-8444-444444444444", message: { role: "user", content: "Shorten the shimmer's file path." } },
  {
    type: "assistant",
    timestamp: T(1),
    sessionId: "44444444-4444-4444-8444-444444444444",
    message: {
      id: "m-1",
      model: "claude-opus-5",
      role: "assistant",
      stop_reason: "tool_use",
      content: [call("toolu_settled", "Edit", {
        file_path: `${projectDir}/packages/web/src/lib/toolActivity.ts`,
        old_string: "const detail = target(tool)",
        new_string: "const detail = relativeToolPaths(target(tool), projectDir)",
      })],
    },
  },
  {
    type: "user",
    timestamp: T(2),
    sessionId: "44444444-4444-4444-8444-444444444444",
    message: { role: "user", content: [result("toolu_settled", "The file has been updated.")] },
  },
  {
    type: "assistant",
    timestamp: T(3),
    sessionId: "44444444-4444-4444-8444-444444444444",
    message: {
      id: "m-2",
      model: "claude-opus-5",
      role: "assistant",
      stop_reason: "tool_use",
      content: [call("toolu_live", "Edit", {
        file_path: `${projectDir}/packages/web/src/components/ChatView.tsx`,
        old_string: "toolActivityLabel(liveToolActivity)",
        new_string: "toolActivityLabel(liveToolActivity, projectDir)",
      })],
    },
  },
])

write("outside-tool-path", "55555555-5555-4555-8555-555555555555", "Outside tool path", [
  { type: "user", timestamp: T(0), sessionId: "55555555-5555-4555-8555-555555555555", message: { role: "user", content: "Check the global Claude settings." } },
  {
    type: "assistant",
    timestamp: T(1),
    sessionId: "55555555-5555-4555-8555-555555555555",
    message: {
      id: "m-1",
      model: "claude-opus-5",
      role: "assistant",
      stop_reason: "tool_use",
      content: [call("toolu_outside", "Read", { file_path: "/Users/colinmcd94/.claude/CLAUDE.md" })],
    },
  },
])
