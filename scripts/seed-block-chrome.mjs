#!/usr/bin/env node
// Seed an adhoc stack with ONE thread that carries every BLOCK-LEVEL element the transcript can
// render, in a single scroll, so the shared block chrome (corner radius, border, fill) can be judged
// as a family rather than one shape at a time.
//
// In frame, top to bottom: the human's bubble · prose with a blockquote, a table and a fenced code
// block · a Bash card · a Read card · an Edit diff card · a to-do card · a sub-agent card · a
// ```done signal card · a GitHub wake card · a ```question card.
//
// Usage: node scripts/seed-block-chrome.mjs <home> <unused> <projectDir>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { formatGithubWakeSteer, wakeDeliveryToken } from "../packages/shared/src/index.ts"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const [home, _socket, projectDir] = process.argv.slice(2)
if (!home || !projectDir) throw new Error("usage: seed-block-chrome.mjs <home> <unused> <projectDir>")

const cwdSlug = projectDir.replace(/[/.]/g, "-")
const transcriptDir = path.join(home, ".claude", "projects", cwdSlug)
fs.mkdirSync(transcriptDir, { recursive: true })
const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)

const SESSION = "b10cb10c-0000-4000-8000-00000000cafe"
const T = (n) => new Date(Date.UTC(2026, 6, 31, 4, n, 0)).toISOString()
const call = (id, name, input) => ({ type: "tool_use", id, name, input })
const result = (id, content) => ({ type: "tool_result", tool_use_id: id, content })
const user = (n, content) => ({ type: "user", timestamp: T(n), sessionId: SESSION, message: { role: "user", content } })
const asst = (n, content, stop = "tool_use") => ({
  type: "assistant",
  timestamp: T(n),
  sessionId: SESSION,
  message: { id: `m-${n}`, model: "claude-opus-5", role: "assistant", stop_reason: stop, content },
})
const text = (n, body, stop = "end_turn") => asst(n, [{ type: "text", text: body }], stop)

const PROSE = `Here is what the block chrome has to hold together.

> Every element the transcript sets off from the prose is one family.

| Block | Before | Now |
| --- | --- | --- |
| Signal card | 16px | 12px |
| Tool card | 6px | 12px |

\`\`\`ts
export const BLOCK_RADIUS = "rounded-xl"
\`\`\``

const WAKE = formatGithubWakeSteer({
  ref: "nubjs/nub#587",
  omitted: 0,
  items: [{ label: "review comment", actor: "pullfrog[bot]", bot: true, at: T(30), url: "https://github.com/nubjs/nub/pull/587#discussion_r2411100933" }],
})

const records = [
  user(0, "Make the rendering consistent across all of the block-level elements."),
  text(1, PROSE, "end_turn"),
  asst(2, [call("t_bash", "Bash", { command: "rg -n 'border-radius' packages/web/src/styles.css", description: "Finding the block radii" })]),
  user(3, [result("t_bash", "732:  border-radius: 6px;\n88:  border-radius: 6px;\n163:  rounded-2xl")]),
  asst(4, [call("t_read", "Read", { file_path: `${projectDir}/packages/web/src/components/TranscriptCard.tsx` })]),
  user(5, [result("t_read", "   163→    <div className={`min-w-0 rounded-2xl border ${border} bg-panel-2 p-3`}>\n   164→      <CardHead icon={icon} label={label} />\n   165→    </div>")]),
  asst(6, [call("t_edit", "Edit", {
    file_path: `${projectDir}/packages/web/src/lib/diff/diff.css`,
    old_string: "  border: 1px solid var(--color-border);\n  border-radius: 6px;",
    new_string: "  border: 1px solid var(--color-border);\n  border-radius: var(--block-radius);",
  })]),
  user(7, [result("t_edit", "The file has been updated.")]),
  asst(8, [call("t_todo", "TodoWrite", {
    todos: [
      { content: "Inventory every block-level element", status: "completed", activeForm: "Inventorying the block-level elements" },
      { content: "Unify the corner radius", status: "in_progress", activeForm: "Unifying the corner radius" },
      { content: "Screenshot desktop and narrow", status: "pending", activeForm: "Screenshotting desktop and narrow" },
    ],
  })]),
  user(9, [result("t_todo", "Todos have been modified successfully.")]),
  asst(10, [call("t_agent", "Task", { subagent_type: "frizz:opus-high", description: "Audit the block radii", prompt: "List every block-level container in the transcript and its corner radius." })]),
  user(11, [result("t_agent", "Nine containers, four distinct radii.")]),
  // A local image and a local non-image path render as their own block elements (BlockImage /
  // BlockFile), which nothing else in this thread exercises.
  text(11.5, `Here is the shot and the plan it came from.\n\n${projectDir}/attachments/block-radius-table.png\n\n${projectDir}/package.json`, "end_turn"),
  text(12, "Landed the shared block radius on `main`.\n\n```done\n- Unified every transcript block on the card's 12px corner in [`diff.css`](https://github.com/acme/app).\n- `nub run typecheck` green.\n```"),
  { ...user(13, `${WAKE}\n\n${wakeDeliveryToken("b".repeat(64))}`) },
  text(14, "One call is genuinely yours.\n\n```question\nShould the fenced code block keep its own tighter corner?\n\n- A. No — one radius everywhere (recommended: it is the whole point of the sweep)\n- B. Yes — a code fence is prose furniture, not a card\n```"),
]

// The QUEUE card hides everything between the human's ask and the agent's last word behind the
// "N tool calls · M steps" bar — the other half of the maintainer's screenshot, and a block-level
// element that only appears on that surface. It needs its own thread: on the gallery above, the wake
// is the last user turn, so nothing sits between it and the tail to collapse.
const BAR_SESSION = "ba12ba12-0000-4000-8000-00000000cafe"
const barRecords = [
  { ...user(0, "Unify the block chrome."), sessionId: BAR_SESSION },
  // Prose steps BETWEEN the tool calls: the bar counts hidden STEPS (whole middle messages) as well as
  // hidden tool calls, and only the two-part "N tool calls · M steps" form is the shape in frame.
  ...[1, 2, 3, 4].flatMap((n) => [
    { ...text(n * 3, `Checking the ${n}th block's corner.`, "end_turn"), sessionId: BAR_SESSION },
    { ...asst(n * 3 + 1, [call(`t_bar_${n}`, "Bash", { command: `rg -n 'radius' file-${n}.css`, description: `Checking file ${n}` })]), sessionId: BAR_SESSION },
    { ...user(n * 3 + 2, [result(`t_bar_${n}`, `${n}: border-radius: 6px;`)]), sessionId: BAR_SESSION },
  ]),
  { ...text(12, "Every block now wears the same corner.\n\n```question\nShould the queue bar match too?\n\n- A. Yes (recommended)\n- B. No\n```"), sessionId: BAR_SESSION },
]

function land(slug, sessionId, title, rows, restedAt) {
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
  try {
  } catch {
    /* already exists */
  }
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived, rested_at)
     VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${T(0)}', '${title}', 0, 'claude', 'opus', 'high', 'auto', 'open', 0, 0, 0, '${restedAt}')`,
  ])
  console.log(`seeded ${slug} (${sessionId})`)
}

land("block-chrome", SESSION, "Block chrome gallery", records, T(15))
land("collapse-bar", BAR_SESSION, "Collapse bar", barRecords, T(14))
